import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { withRepoLock } from "../src/server/gitMutex.js";
import {
  VAULT_MIRROR_COMMIT_MESSAGE,
  VAULT_ON_HOLD_PUSH,
  commitAndPush,
  commitAndPushLocked,
  commitIdentityFor,
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  vaultHoldPushStop,
} from "../src/server/knowledgeRepo.js";
import { MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { isPersonalVaultPath, memoryVaultFor } from "../src/server/personalVault.js";
import {
  CloneVaultFiles,
  VAULT_MIRROR_ERROR,
  VAULT_MIRROR_NOTICE,
  discardVaultCopyChanges,
  finishVaultMirror,
  startVaultMirrorLoop,
  syncVaultMirror,
  vaultMirrorCommitError,
  type VaultMirrorOutcome,
} from "../src/server/vaultMirror.js";
import { createFakeMemoryClient, fakeMemoryHash } from "./helpers/fakeMemory.js";
import { gitInit, makeBareRemote, withTempDir } from "./helpers.js";

// The push-only git mirror of a personal vault that lives in the memory service
// (vaultMirror.ts): the in-process fake service on one side, a local bare
// remote (outside the test's dataDir) on the other, the real clone/commit/push
// plumbing in between.

const getTempDir = withTempDir("vault-mirror");
const loops: { stop(): void }[] = [];
afterEach(() => {
  for (const loop of loops.splice(0)) loop.stop();
});

const MIRROR_SUBJECT = VAULT_MIRROR_COMMIT_MESSAGE.split("\n")[0];
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Owner {
  id: string;
  remote: string;
  clone: string;
}

function addOwner(
  base: { root: string; store: ReturnType<typeof createServices>["store"]; config: ReturnType<typeof createServices>["config"] },
  name: string,
  seedFiles: Record<string, string> = {},
  seedLinks: Record<string, string> = {},
): Owner {
  const user = base.store.createUser({ username: name, displayName: `The ${name}`, password: "password123" });
  const remote = makeBareRemote(path.join(base.root, `${name}-remote.git`));
  const seed = path.join(base.root, `${name}-seed`);
  gitInit(seed); // README.md = "hello"
  for (const [rel, content] of Object.entries(seedFiles)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), content);
  }
  for (const [rel, target] of Object.entries(seedLinks)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.symlinkSync(target, path.join(seed, rel));
  }
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "--allow-empty", "-m", "seed");
  sh(seed, "branch", "-M", "main");
  sh(seed, "remote", "add", "origin", remote);
  sh(seed, "push", "-q", "origin", "main");
  base.store.setKnowledgeRepo(user.id, remote, "main");
  base.store.setGitToken(user.id, "tok"); // the gate; a local remote ignores it
  base.store.setPersonalVaultMemory(user.id, { sourceRepo: remote, sourceCommit: null });
  return { id: user.id, remote, clone: knowledgeClonePath(user.id, base.config) };
}

const SEED = {
  "skills/demo/SKILL.md": "# Demo skill\n",
  "wiki/pic.png": "not really a picture",
  "wiki/.obsidian/app.md": "obsidian keeps this\n",
  "wiki/sources/.gitkeep": "",
};

function setup(seedFiles: Record<string, string> = SEED, seedLinks: Record<string, string> = {}) {
  const root = getTempDir();
  const { store, config } = createServices({ dataDir: path.join(root, "data"), agentRuntime: "local", sessionSecret: "t" });
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(store, fake);
  const base = { root, store, config, fake };
  const owner = addOwner(base, "owner", seedFiles, seedLinks);
  const vault = memoryVaultFor(store, config, owner.id)!;
  return { ...base, owner, vault };
}

type Setup = ReturnType<typeof setup>;

const remoteGit = (owner: Owner, ...args: string[]) =>
  execFileSync("git", ["--git-dir", owner.remote, ...args], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString();
const remoteFile = (owner: Owner, rel: string): string | null => {
  try {
    return remoteGit(owner, "show", `main:${rel}`);
  } catch {
    return null;
  }
};
const remoteFiles = (owner: Owner) => remoteGit(owner, "ls-tree", "-r", "--name-only", "-z", "main").split("\0").filter(Boolean).sort();
const remoteCommits = (owner: Owner) => Number(remoteGit(owner, "rev-list", "--count", "main").trim());
const remoteSubjects = (owner: Owner) => remoteGit(owner, "log", "--format=%s", "main").trim().split("\n");
const remoteHead = (owner: Owner) => remoteGit(owner, "rev-parse", "main").trim();

/** One commit pushed to the remote from outside Noah (`null` deletes the file). */
function pushFromOutside(s: Setup, owner: Owner, files: Record<string, string | null>, message: string): void {
  const dir = fs.mkdtempSync(path.join(s.root, "outside-"));
  execFileSync("git", ["clone", "-q", owner.remote, dir], { stdio: "pipe" });
  sh(dir, "config", "user.name", "Outside");
  sh(dir, "config", "user.email", "outside@example.com");
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) {
      fs.rmSync(path.join(dir, rel));
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", message);
  sh(dir, "push", "-q", "origin", "main");
}

const mirror = (s: Setup, options: { push: boolean; locked?: boolean } = { push: true }, owner: Owner = s.owner) =>
  syncVaultMirror(s.store, s.config, owner.id, options);
const row = (s: Setup, owner: Owner = s.owner) => s.store.getPersonalVault(owner.id)!;
const ledger = (s: Setup) => s.store.listVaultDeletes(s.owner.id);
const synced = (outcome: VaultMirrorOutcome | null | undefined) => {
  if (outcome?.kind !== "synced") throw new Error(`expected synced, got ${JSON.stringify(outcome)}`);
  return outcome;
};
const cloneFile = (owner: Owner, rel: string) => fs.readFileSync(path.join(owner.clone, rel), "utf8");
const cloneHas = (owner: Owner, rel: string) => fs.existsSync(path.join(owner.clone, rel));
const cloneStatus = (owner: Owner) => sh(owner.clone, "status", "--porcelain").trim();
const repoOnly = (count: number) => `${VAULT_MIRROR_NOTICE.repoOnly}: ${count}`;
const ctxOf = (s: Setup) => knowledgeRepoContextFor(s.store, s.owner.id, s.config)!;
const identityOf = (s: Setup) => commitIdentityFor(s.store, s.store.getUserById(s.owner.id)!);

/**
 * The `commit` tool's shape for an owner whose vault lives in the service: the
 * mirror runs as the commit's hook (before staging, and again after a rebase),
 * conflicts confined to vault paths are settled for the service's side, and
 * the LAST pass is finalized once the push is over.
 */
async function avatarCommit(s: Setup, message: string) {
  const passes: VaultMirrorOutcome[] = [];
  try {
    const committed = await commitAndPush(ctxOf(s), message, identityOf(s), {
      beforeCommit: async () => {
        passes.push(await mirror(s, { push: false, locked: true }));
      },
      vaultPaths: isPersonalVaultPath,
    });
    finishVaultMirror(s.store, s.config, s.owner.id, passes.at(-1), { ok: true });
    return { committed, passes, error: null as unknown };
  } catch (error) {
    finishVaultMirror(s.store, s.config, s.owner.id, passes.at(-1), { ok: false, error });
    return { committed: false, passes, error };
  }
}

describe("vault mirror: one pass", () => {
  it("adds and replaces vault files on the remote, as the owner, and touches nothing else", async () => {
    const s = setup({ ...SEED, "CLAUDE.md": "old standing memory\n", "raw/2026/keep.md": "same on both sides\n" });
    await s.vault.write("CLAUDE.md", "standing memory\n");
    await s.vault.write("wiki/concepts/deploy.md", "# Deploy\n");
    await s.vault.write("wiki/한글 노트.md", "한글 본문\n");
    await s.vault.write("raw/2026/keep.md", "same on both sides\n");
    expect(row(s).mirrorDirty).toBe(true);

    const first = synced(await mirror(s));
    // Written: CLAUDE.md (replace), two new notes. Skipped as identical: raw/2026/keep.md.
    expect(first).toMatchObject({ changed: 3, notice: null });
    expect(first.pending).toBeUndefined(); // a pushed pass finalized itself
    expect(remoteFile(s.owner, "CLAUDE.md")).toBe("standing memory\n");
    expect(remoteFile(s.owner, "wiki/concepts/deploy.md")).toBe("# Deploy\n");
    expect(remoteFile(s.owner, "wiki/한글 노트.md")).toBe("한글 본문\n");
    // Never touched: a repo path, a non-markdown file under wiki/, and a .md the service cannot hold.
    expect(remoteFiles(s.owner)).toEqual(
      [
        "CLAUDE.md",
        "README.md",
        "raw/2026/keep.md",
        "skills/demo/SKILL.md",
        "wiki/.obsidian/app.md",
        "wiki/concepts/deploy.md",
        "wiki/pic.png",
        "wiki/sources/.gitkeep",
        "wiki/한글 노트.md",
      ].sort(),
    );
    expect(remoteFile(s.owner, "wiki/.obsidian/app.md")).toBe("obsidian keeps this\n");
    expect(remoteFile(s.owner, "wiki/pic.png")).toBe("not really a picture");
    expect(remoteGit(s.owner, "log", "-1", "--format=%an <%ae>|%s", "main").trim()).toBe(
      `The owner <owner@noah-almighty.local>|${MIRROR_SUBJECT}`,
    );
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorNotice: null });
    expect(row(s).mirrorSyncedAt).not.toBeNull();
    expect(cloneStatus(s.owner)).toBe("");

    // Nothing changed: no new commit, still clean.
    const commits = remoteCommits(s.owner);
    expect(synced(await mirror(s)).changed).toBe(0);
    expect(remoteCommits(s.owner)).toBe(commits);
  });

  it("an owner whose home is `repo` is left alone", async () => {
    const s = setup();
    s.store.clearPersonalVault(s.owner.id);
    expect(await mirror(s)).toEqual({ kind: "synced", changed: 0, seq: 0 });
    expect(s.fake.calls).toEqual([]);
    expect(cloneHas(s.owner, ".")).toBe(false);
  });

  it("skips while the mirror is on hold (either state), and without a repository", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    for (const hold of ["checking", "confirm"] as const) {
      s.store.setVaultMirrorHold(s.owner.id, hold);
      expect(await mirror(s)).toEqual({ kind: "skipped", reason: "hold" });
      expect(await mirror(s, { push: false })).toEqual({ kind: "skipped", reason: "hold" });
    }
    expect(s.fake.calls.filter((call) => call.op === "list")).toEqual([]);
    expect(cloneHas(s.owner, ".")).toBe(false);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: null });

    s.store.setVaultMirrorHold(s.owner.id, null);
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");

    s.store.setKnowledgeRepo(s.owner.id, null, null);
    await s.vault.write("wiki/b.md", "B\n");
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "no_repo" });
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: null });
  });

  it("looks at the row again once it holds the repo lock: a hold or a rollback that came while it waited", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    await s.vault.write("wiki/a.md", "A\n");
    const head = sh(s.owner.clone, "rev-parse", "HEAD").trim();
    const calls = s.fake.calls.length;

    for (const arrive of [
      () => s.store.setVaultMirrorHold(s.owner.id, "checking"),
      () => s.store.clearPersonalVault(s.owner.id),
    ]) {
      s.store.setVaultMirrorHold(s.owner.id, null);
      // Something holds the clone; the pass has read the row (no hold yet) and waits for the lock.
      let release!: () => void;
      const held = withRepoLock(s.owner.clone, () => new Promise<void>((resolve) => (release = resolve)));
      const waiting = mirror(s);
      await sleep(20);
      arrive();
      release();
      await held;
      const outcome = await waiting;
      expect(outcome).toEqual(row(s) ? { kind: "skipped", reason: "hold" } : { kind: "synced", changed: 0, seq: 0 });
      // Nothing was read from the service, nothing written or committed.
      expect(s.fake.calls.length).toBe(calls);
      expect(cloneHas(s.owner, "wiki/a.md")).toBe(false);
      expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(head);
      expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    }
  });

  it("`push: false` only writes the working tree and records nothing; finishVaultMirror settles it after the push", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    await s.vault.write("wiki/a.md", "A\n");
    const before = remoteCommits(s.owner);

    const outcome = synced(await mirror(s, { push: false }));
    expect(outcome).toMatchObject({ changed: 1, seq: row(s).mirrorSeq, notice: null });
    expect(outcome.pending).toEqual({ seq: row(s).mirrorSeq, notice: null, settledDeletes: [] });
    expect(cloneFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteCommits(s.owner)).toBe(before);
    expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorSyncedAt: null });

    // The caller's push failed: recorded as the failure, the row stays dirty.
    finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: false, error: new Error("REBASE_CONFLICT:skills/demo/SKILL.md") });
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "rebase conflict: skills/demo/SKILL.md", mirrorSyncedAt: null });
    // An outcome that is not `synced` settles nothing.
    finishVaultMirror(s.store, s.config, s.owner.id, { kind: "failed", error: "x" }, { ok: true });
    finishVaultMirror(s.store, s.config, s.owner.id, null, { ok: true });
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorSyncedAt: null });

    // The background pass finds only vault paths changed and pushes them.
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
  });

  it("`locked: true` uses the caller's lock and clone: no deadlock, no clone of its own", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    // No clone yet: the pass does not make one.
    const missing = await withRepoLock(s.owner.clone, () => mirror(s, { push: false, locked: true }));
    expect(missing).toEqual({ kind: "failed", error: VAULT_MIRROR_ERROR.notCloned });
    expect(row(s).mirrorError).toBe("not cloned");

    await ensureClone(ctxOf(s));
    // The remote moves; a locked pass does not fetch it.
    pushFromOutside(s, s.owner, { "docs/new.md": "new\n" }, "outside docs");
    const outcome = await withRepoLock(s.owner.clone, () => mirror(s, { push: true, locked: true }));
    synced(outcome);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "docs/new.md")).toBe("new\n"); // absorbed by the push's own rebase
  });

  it("leaves a clone with unfinished work alone (repo_dirty), and the avatar's commit carries the mirror", async () => {
    const s = setup({ ...SEED, ".mcp.json": '{"hex-ssh":{"command":"x"},"other":{"command":"y"}}\n' });
    await ensureClone(ctxOf(s));
    await s.vault.write("wiki/a.md", "A\n");

    // The load-time strip of a tracked .mcp.json is not "unfinished work": the pass runs, and never pushes the strip.
    fs.writeFileSync(path.join(s.owner.clone, ".mcp.json"), '{"other":{"command":"y"}}\n');
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, ".mcp.json")).toContain("hex-ssh");

    // An avatar's uncommitted skill edit: the background pass touches nothing.
    await s.vault.write("wiki/a.md", "A2\n");
    await s.vault.write("wiki/b.md", "B\n");
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, half edited\n");
    const commits = remoteCommits(s.owner);
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "repo_dirty" });
    expect(cloneFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(cloneHas(s.owner, "wiki/b.md")).toBe(false);
    expect(remoteCommits(s.owner)).toBe(commits);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "repo has uncommitted changes" });
    // The same for an untracked file outside the vault.
    sh(s.owner.clone, "checkout", "--", "skills/demo/SKILL.md");
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "repo_dirty" });
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, finished\n");

    // The `commit` tool's shape: the mirror runs inside the commit's own lock, before anything is staged.
    const dirtySeq = row(s).mirrorSeq;
    const done = await avatarCommit(s, "Finish the demo skill");
    expect(done).toMatchObject({ committed: true, error: null });
    expect(done.passes).toHaveLength(1); // nothing to rebase onto: the hook ran once
    expect(synced(done.passes[0]).pending).toMatchObject({ seq: dirtySeq });
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A2\n");
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");
    expect(remoteFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, finished\n");
    expect(remoteFile(s.owner, "notes.txt")).toBe("scratch\n");
    expect(remoteSubjects(s.owner)[0]).toBe("Finish the demo skill");
  });

  it("work that lands in the clone while the pass runs is never swept into the mirror commit", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A2\n");
    const commits = remoteCommits(s.owner);
    const head = sh(s.owner.clone, "rev-parse", "HEAD").trim();
    // After the pass looked at the clone, before it stages: the avatar writes a file (the repo tools do not hold the lock).
    s.fake.beforeNext("read", () => fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n"));

    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "repo_dirty" });
    expect(remoteCommits(s.owner)).toBe(commits);
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(head);
    expect(cloneFile(s.owner, "notes.txt")).toBe("scratch\n");
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "repo has uncommitted changes" });
  });

  it("commitAndPush's beforeCommit: a missing clone and a throwing hook stop before anything is committed", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    const identity = { name: "Owner", email: "owner@example.com" };
    let called = false;
    await expect(
      commitAndPush(ctx, "m", identity, {
        beforeCommit: async () => {
          called = true;
        },
      }),
    ).rejects.toThrow("NOT_CLONED");
    expect(called).toBe(false);

    await ensureClone(ctx);
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    const commits = remoteCommits(s.owner);
    await expect(
      commitAndPush(ctx, "m", identity, {
        beforeCommit: async () => {
          throw new Error("HOOK_FAILED");
        },
      }),
    ).rejects.toThrow("HOOK_FAILED");
    expect(remoteCommits(s.owner)).toBe(commits);
    expect(cloneStatus(s.owner)).toBe("?? notes.txt");
    // The lock was released: an ordinary commit still works.
    expect(await commitAndPush(ctx, "m", identity)).toBe(true);
  });

  // `beforePush(changed)`: one look per call — after `git add -A`, `checkStaged` and the fetch, BEFORE the
  // commit — at the paths the staged changes and the unpushed commits change against the remote branch. A throw
  // there leaves the clone as it was before the call: no new commit, the change still in the tree (staged).
  const lookAt = (owner: Owner) => ({
    head: sh(owner.clone, "rev-parse", "HEAD").trim(),
    status: cloneStatus(owner),
    log: sh(owner.clone, "log", "--format=%s").trim().split("\n"),
  });

  it("commitAndPush's beforePush: what the push would carry, looked at before the commit — a plain change, a rename, a clone behind the remote", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    const identity = { name: "Owner", email: "owner@example.com" };
    await ensureClone(ctx);
    const seen: (string[] | null)[] = [];
    const looks: ReturnType<typeof lookAt>[] = [];
    const beforePush = async (changed: string[] | null) => {
      looks.push(lookAt(s.owner));
      seen.push(changed);
    };

    // A plain change: exactly its paths. At the look nothing is committed: HEAD is where it was, the change is staged.
    let head = sh(s.owner.clone, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, edited\n");
    expect(await commitAndPush(ctx, "plain", identity, { beforePush })).toBe(true);
    expect(seen).toEqual([["notes.txt", "skills/demo/SKILL.md"]]);
    expect(looks.at(-1)).toMatchObject({ head, status: "A  notes.txt\nM  skills/demo/SKILL.md" });
    expect(looks.at(-1)!.log).not.toContain("plain");
    // Without a throw: committed and pushed.
    expect(remoteFile(s.owner, "notes.txt")).toBe("scratch\n");
    expect(remoteSubjects(s.owner)[0]).toBe("plain");

    // A rename is both of its paths (the one that disappears from the remote, and the one that appears).
    fs.renameSync(path.join(s.owner.clone, "skills/demo"), path.join(s.owner.clone, "skills/renamed"));
    expect(await commitAndPush(ctx, "rename", identity, { beforePush })).toBe(true);
    expect(seen.at(-1)).toEqual(["skills/demo/SKILL.md", "skills/renamed/SKILL.md"]);

    // The clone is BEHIND the remote: only what the local side changes — the remote's own changes are not in
    // the list — and at the look nothing is committed or rebased (the remote's commit is not in the clone's log).
    pushFromOutside(s, s.owner, { "docs/new.md": "new\n", "wiki/pic.png": "a new picture" }, "outside docs");
    head = sh(s.owner.clone, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch, again\n");
    expect(await commitAndPush(ctx, "behind the remote", identity, { beforePush })).toBe(true);
    expect(seen.at(-1)).toEqual(["notes.txt"]);
    expect(looks.at(-1)).toMatchObject({ head, status: "M  notes.txt" });
    expect(looks.at(-1)!.log[0]).toBe("rename");
    expect(looks.at(-1)!.log).not.toContain("outside docs");
    // Without a throw the change is committed, rebased onto the remote and pushed, as before.
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual(["behind the remote", "outside docs"]);
    expect(remoteFile(s.owner, "docs/new.md")).toBe("new\n");
    expect(remoteFile(s.owner, "notes.txt")).toBe("scratch, again\n");
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(remoteHead(s.owner));

    // Nothing to commit and nothing unpushed: no push, so no look.
    expect(await commitAndPush(ctx, "nothing", identity, { beforePush })).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it("commitAndPush's beforePush: unpushed commits and newly staged changes are listed together; unpushed commits alone too", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    const identity = { name: "Owner", email: "owner@example.com" };
    await ensureClone(ctx);
    // Two commits the remote never got, and a remote that moved meanwhile.
    for (const [file, subject] of [["earlier.txt", "an earlier commit"], ["skills/demo/SKILL.md", "another one"]]) {
      fs.writeFileSync(path.join(s.owner.clone, file), `${subject}\n`);
      sh(s.owner.clone, "add", "-A");
      sh(s.owner.clone, "-c", "user.name=Owner", "-c", "user.email=owner@example.com", "commit", "-q", "-m", subject);
    }
    pushFromOutside(s, s.owner, { "docs/new.md": "new\n" }, "outside docs");
    const head = sh(s.owner.clone, "rev-parse", "HEAD").trim();
    const seen: (string[] | null)[] = [];
    const refuse = (changed: string[] | null) => {
      seen.push(changed);
      throw new Error("PUSH_REFUSED");
    };

    // Unpushed commits alone (a clean tree): they are what the push carries.
    await expect(commitAndPush(ctx, "nothing new", identity, { beforePush: refuse })).rejects.toThrow("PUSH_REFUSED");
    expect(seen.at(-1)).toEqual(["earlier.txt", "skills/demo/SKILL.md"]);
    // With a new change on top: both, and nothing of the remote's.
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    await expect(commitAndPush(ctx, "on top", identity, { beforePush: refuse })).rejects.toThrow("PUSH_REFUSED");
    expect(seen.at(-1)).toEqual(["earlier.txt", "notes.txt", "skills/demo/SKILL.md"]);
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(head);

    expect(await commitAndPush(ctx, "on top", identity, { beforePush: (changed) => void seen.push(changed) })).toBe(true);
    expect(seen.at(-1)).toEqual(["earlier.txt", "notes.txt", "skills/demo/SKILL.md"]);
    expect(remoteSubjects(s.owner).slice(0, 4)).toEqual(["on top", "another one", "an earlier commit", "outside docs"]);
  });

  it("commitAndPush's beforePush: one look per call — what the hook writes after a rebase is not looked at again", async () => {
    const s = setup({ ...SEED, "wiki/a.md": "A\n", "wiki/b.md": "B\n" });
    s.fake.seed(s.owner.id, "wiki/a.md", "A\n");
    s.fake.seed(s.owner.id, "wiki/b.md", "B\n");
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "A, edited on the git host\n" }, "direct edit");
    await s.vault.write("wiki/b.md", "B2\n");

    const seen: (string[] | null)[] = [];
    const committed = await commitAndPush(ctxOf(s), "Update note B", identityOf(s), {
      beforeCommit: async () => void (await mirror(s, { push: false, locked: true })),
      vaultPaths: isPersonalVaultPath,
      beforePush: (changed) => void seen.push(changed),
    });
    expect(committed).toBe(true);
    // The local side changes b.md. Putting a.md back happens after the rebase, in the follow-up commit.
    expect(seen).toEqual([["wiki/b.md"]]);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B2\n");
    expect(remoteSubjects(s.owner).slice(0, 3)).toEqual([MIRROR_SUBJECT, "Update note B", "direct edit"]);
  });

  it("commitAndPush's beforePush: null for a branch the remote does not have; its paths once the fetch has seen the branch", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    const identity = { name: "Owner", email: "owner@example.com" };
    const seen: (string[] | null)[] = [];
    const beforePush = (changed: string[] | null) => void seen.push(changed);

    // A branch nobody has: null, and the push creates it.
    const fresh = { ...ctxOf(s), branch: "fresh" };
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    expect(await commitAndPush(fresh, "first on a new branch", identity, { beforePush })).toBe(true);
    expect(seen).toEqual([null]);
    expect(remoteGit(s.owner, "show", "fresh:notes.txt")).toBe("scratch\n");
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch, again\n");
    expect(await commitAndPush(fresh, "second", identity, { beforePush })).toBe(true);
    expect(seen).toEqual([null, ["notes.txt"]]);

    // A branch the remote has but this clone has never fetched: the look comes AFTER the fetch, so it is a list.
    const dir = fs.mkdtempSync(path.join(s.root, "outside-"));
    execFileSync("git", ["clone", "-q", s.owner.remote, dir], { stdio: "pipe" });
    sh(dir, "config", "user.name", "Outside");
    sh(dir, "config", "user.email", "outside@example.com");
    sh(dir, "checkout", "-q", "-b", "elsewhere", "origin/fresh");
    fs.writeFileSync(path.join(dir, "elsewhere.md"), "made elsewhere\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "made elsewhere");
    sh(dir, "push", "-q", "origin", "elsewhere");
    expect(() => sh(s.owner.clone, "rev-parse", "--verify", "--quiet", "origin/elsewhere")).toThrow();
    fs.writeFileSync(path.join(s.owner.clone, "more.txt"), "more\n");
    expect(await commitAndPush({ ...ctxOf(s), branch: "elsewhere" }, "onto elsewhere", identity, { beforePush })).toBe(true);
    expect(seen.at(-1)).toEqual(["more.txt"]);
    expect(remoteGit(s.owner, "show", "elsewhere:more.txt")).toBe("more\n");
    expect(remoteGit(s.owner, "show", "elsewhere:elsewhere.md")).toBe("made elsewhere\n");
  });

  it("commitAndPush's beforePush: histories without a common commit are compared against the remote branch's tree", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    await ensureClone(ctx);
    // The remote branch is replaced by an unrelated history.
    const dir = fs.mkdtempSync(path.join(s.root, "outside-"));
    execFileSync("git", ["clone", "-q", s.owner.remote, dir], { stdio: "pipe" });
    sh(dir, "config", "user.name", "Outside");
    sh(dir, "config", "user.email", "outside@example.com");
    sh(dir, "checkout", "-q", "--orphan", "unrelated");
    sh(dir, "rm", "-rf", "-q", ".");
    fs.writeFileSync(path.join(dir, "README.md"), "another repository\n");
    fs.writeFileSync(path.join(dir, "theirs.md"), "theirs\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "unrelated root");
    sh(dir, "push", "-q", "-f", "origin", "unrelated:main");
    const head = remoteHead(s.owner);
    const before = sh(s.owner.clone, "rev-parse", "HEAD").trim();

    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    const seen: (string[] | null)[] = [];
    await expect(
      commitAndPush(ctx, "local", { name: "Owner", email: "owner@example.com" }, {
        beforePush: (changed) => {
          seen.push(changed);
          throw new Error("PUSH_REFUSED");
        },
      }),
    ).rejects.toThrow("PUSH_REFUSED");
    // Every path that differs between the two trees, whichever side has it.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.arrayContaining(["README.md", "notes.txt", "skills/demo/SKILL.md", "theirs.md"]));
    expect(remoteHead(s.owner)).toBe(head);
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("commitAndPush's beforePush: a throw leaves the clone as it was before the call — no commit, the change still staged, nothing merged or pushed", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    const identity = { name: "Owner", email: "owner@example.com" };
    await ensureClone(ctx);
    // The clone is behind the remote: a push would have to rebase first.
    pushFromOutside(s, s.owner, { "docs/new.md": "new\n" }, "outside docs");
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    const head = remoteHead(s.owner);
    const before = lookAt(s.owner);
    expect(before.status).toBe("?? notes.txt");

    for (const refuse of [
      () => {
        throw new Error("PUSH_REFUSED");
      },
      async () => {
        await sleep(5);
        throw new Error("PUSH_REFUSED");
      },
    ]) {
      const beforePush = (changed: string[] | null) => {
        // Both refusals look at the same thing: the same list, on the same HEAD.
        expect(changed).toEqual(["notes.txt"]);
        expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(before.head);
        return refuse();
      };
      await expect(commitAndPush(ctx, "never made", identity, { beforePush })).rejects.toThrow("PUSH_REFUSED");
      // The remote is untouched…
      expect(remoteHead(s.owner)).toBe(head);
      expect(remoteFile(s.owner, "notes.txt")).toBeNull();
      // …and so is the clone: no commit was made (HEAD and the log are what they were), the change is still
      // in the working tree (staged), and the remote's commit was neither merged nor rebased onto.
      const after = lookAt(s.owner);
      expect(after.head).toBe(before.head);
      expect(after.log).toEqual(before.log);
      expect(after.status).toBe("A  notes.txt");
      expect(cloneFile(s.owner, "notes.txt")).toBe("scratch\n");
      expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
      expect(cloneHas(s.owner, ".git/rebase-apply")).toBe(false);
      expect(cloneHas(s.owner, "docs/new.md")).toBe(false);
    }
    // The lock was released and nothing was lost: a later call commits it, rebases onto the remote and pushes.
    expect(await commitAndPush(ctx, "retry", identity)).toBe(true);
    expect(remoteFile(s.owner, "notes.txt")).toBe("scratch\n");
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual(["retry", "outside docs"]);
  });

  it("commitAndPushLocked: checkStaged runs before the look, and its throw wins", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    const identity = { name: "Owner", email: "owner@example.com" };
    await ensureClone(ctx);
    fs.writeFileSync(path.join(s.owner.clone, "notes.txt"), "scratch\n");
    const head = remoteHead(s.owner);
    const order: string[] = [];
    const run = (checkStaged: (staged: string[]) => void) =>
      withRepoLock(s.owner.clone, () =>
        commitAndPushLocked(ctx, "m", identity, {
          checkStaged,
          beforePush: (changed) => {
            order.push(`beforePush ${JSON.stringify(changed)}`);
            throw new Error("PUSH_REFUSED");
          },
        }),
      );

    await expect(
      run((staged) => {
        order.push(`checkStaged ${JSON.stringify(staged)}`);
        throw new Error("STAGED_REFUSED");
      }),
    ).rejects.toThrow("STAGED_REFUSED");
    expect(order).toEqual(['checkStaged ["notes.txt"]']);
    await expect(run((staged) => void order.push(`checkStaged ${JSON.stringify(staged)}`))).rejects.toThrow("PUSH_REFUSED");
    expect(order).toEqual(['checkStaged ["notes.txt"]', 'checkStaged ["notes.txt"]', 'beforePush ["notes.txt"]']);
    expect(remoteHead(s.owner)).toBe(head);
    expect(cloneStatus(s.owner)).toBe("A  notes.txt");
  });

  it("without a git token nothing is written and the row stays dirty until one is stored", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    s.store.setGitToken(s.owner.id, null);
    expect(await mirror(s)).toEqual({ kind: "failed", error: "no git token" });
    expect(cloneHas(s.owner, ".")).toBe(false);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "no git token", mirrorSyncedAt: null });

    s.store.setGitToken(s.owner.id, "tok");
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
  });

  it("a rejected push keeps the commit, the dirty row and the ledger; the next pass pushes it", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A2\n");
    await s.vault.remove("wiki/gone.md");
    // The remote refuses to move its branch.
    const lock = path.join(s.owner.remote, "refs/heads/main.lock");
    fs.writeFileSync(lock, "");
    const failed = await mirror(s);
    expect(failed.kind).toBe("failed");
    const error = (failed as { error: string }).error;
    expect(error.startsWith(`${VAULT_MIRROR_ERROR.push}: `)).toBe(true);
    expect(error).not.toContain(s.config.dataDir);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: error });
    expect(ledger(s)).toEqual(["wiki/gone.md"]); // not settled: nothing was pushed
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBe("G\n");
    expect(sh(s.owner.clone, "log", "-1", "--format=%s").trim()).toBe(MIRROR_SUBJECT);

    fs.rmSync(lock);
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A2\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(ledger(s)).toEqual([]);
  });

  it("a write that arrives during the pass leaves the row dirty for the next one", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    s.fake.beforeNext("read", () => s.vault.write("wiki/late.md", "late\n").then(() => undefined));
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/late.md")).toBeNull();
    expect(row(s).mirrorDirty).toBe(true);
    expect(row(s).mirrorSyncedAt).not.toBeNull();

    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/late.md")).toBe("late\n");
    expect(row(s).mirrorDirty).toBe(false);
  });

  it("an unavailable service is a failure, never an empty vault", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/b.md", "B\n");
    synced(await mirror(s));
    const commits = remoteCommits(s.owner);
    s.store.markVaultMirrorDirty(s.owner.id);

    // The listing fails: no git command runs, nothing is deleted.
    s.fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });
    expect(await mirror(s)).toEqual({ kind: "failed", error: "memory service unavailable (network)" });
    // A read fails half-way.
    s.fake.failNext(new MemoryUnavailableError("memory service unavailable (read): no answer", "timeout"), { op: "read" });
    expect(await mirror(s)).toEqual({ kind: "failed", error: "memory service unavailable (timeout)" });
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "memory service unavailable (timeout)" });
    expect(remoteCommits(s.owner)).toBe(commits);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");

    // No service configured on this server at all.
    setMemoryClientForTests(s.store, null);
    expect(await mirror(s)).toEqual({ kind: "failed", error: "memory service unavailable (not_configured)" });
    setMemoryClientForTests(s.store, s.fake);

    synced(await mirror(s));
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
  });

  it("a first mirror of a large vault goes through: more than 1 MiB of paths in one commit", async () => {
    const s = setup();
    // Long paths, so git's own listings of this one commit (status, the commit summary) pass Node's default 1 MiB.
    const folder = `wiki/${"f".repeat(100)}`;
    const count = 5500;
    const notePath = (i: number) => `${folder}/${"n".repeat(100)}-${i}.md`;
    // One content for all of them: one blob, so git's background `gc --auto` never starts under the test's cleanup.
    for (let i = 0; i < count; i += 1) s.fake.seed(s.owner.id, notePath(i), "the same note\n");
    expect(count * (notePath(0).length + 4)).toBeGreaterThan(1024 * 1024);
    s.store.markVaultMirrorDirty(s.owner.id);

    expect(synced(await mirror(s)).changed).toBe(count);
    expect(remoteFiles(s.owner).filter((file) => file.startsWith(`${folder}/`))).toHaveLength(count);
    expect(remoteFile(s.owner, notePath(count - 1))).toBe("the same note\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(cloneStatus(s.owner)).toBe("");
  }, 120_000);
});

describe("vault mirror: what it deletes (the ledger)", () => {
  it("deletes from the repository only what Noah deleted, and clears the ledger once that is pushed", async () => {
    const s = setup({ ...SEED, "wiki/only-in-git.md": "written on the git host\n" });
    await s.vault.write("wiki/concepts/deploy.md", "# Deploy\n");
    await s.vault.write("wiki/keep.md", "K\n");
    expect(synced(await mirror(s))).toMatchObject({ changed: 2, notice: repoOnly(1) });
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorNotice: "repository notes not in the memory service: 1" });

    await s.vault.remove("wiki/concepts/deploy.md");
    expect(ledger(s)).toEqual(["wiki/concepts/deploy.md"]);
    expect(synced(await mirror(s))).toMatchObject({ changed: 1, notice: repoOnly(1) });
    // Deleted: the ledgered note (and the folder it emptied in the clone). Kept: the note only git knows.
    expect(remoteFile(s.owner, "wiki/concepts/deploy.md")).toBeNull();
    expect(cloneHas(s.owner, "wiki/concepts")).toBe(false);
    expect(cloneHas(s.owner, "wiki/sources/.gitkeep")).toBe(true);
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBe("written on the git host\n");
    expect(remoteFile(s.owner, "wiki/keep.md")).toBe("K\n");
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorNotice: repoOnly(1) });

    // The notice goes when its cause does (here: the note is taken into the vault).
    await s.vault.write("wiki/only-in-git.md", "now a vault note\n");
    expect(synced(await mirror(s)).notice).toBeNull();
    expect(row(s).mirrorNotice).toBeNull();
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBe("now a vault note\n");
  });

  it("deleting the last note reaches the repository; a service that lost everything deletes nothing", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("CLAUDE.md", "memory\n");
    synced(await mirror(s));

    // Noah deletes every note: the copy follows, down to the last one.
    await s.vault.remove("wiki/a.md");
    await s.vault.remove("CLAUDE.md");
    expect(s.fake.dump(s.owner.id)).toEqual({});
    expect(synced(await mirror(s))).toMatchObject({ changed: 2, notice: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    expect(remoteFile(s.owner, "CLAUDE.md")).toBeNull();
    expect(ledger(s)).toEqual([]);

    // A vault again, then the service comes back empty (a lost volume) — nobody deleted these notes.
    await s.vault.write("wiki/b.md", "B\n");
    await s.vault.write("wiki/c.md", "C\n");
    synced(await mirror(s));
    const commits = remoteCommits(s.owner);
    await s.fake.deleteWiki(s.owner.id);
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(2) });
    expect(remoteCommits(s.owner)).toBe(commits);
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");
    expect(cloneFile(s.owner, "wiki/c.md")).toBe("C\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorNotice: repoOnly(2) });
  });

  it("a ledger entry acts only when the service no longer holds the note, and stays until it does", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    synced(await mirror(s));
    // An entry for a note that is still there (the delete was refused, or the note was written again).
    s.store.recordVaultDelete(s.owner.id, "wiki/a.md");
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s)).changed).toBe(0);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(ledger(s)).toEqual(["wiki/a.md"]);
    // An entry for a path the repository never held is simply settled.
    s.store.recordVaultDelete(s.owner.id, "wiki/never-mirrored.md");
    s.store.markVaultMirrorDirty(s.owner.id);
    synced(await mirror(s));
    expect(ledger(s)).toEqual(["wiki/a.md"]);
  });

  it("a note deleted again while the pass runs keeps its ledger entry: the next pass deletes its file", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/b.md", "B\n");
    synced(await mirror(s));
    // a.md has an entry from an earlier delete that did not go through; the note is still in the service.
    s.store.recordVaultDelete(s.owner.id, "wiki/a.md");
    s.store.markVaultMirrorDirty(s.owner.id);

    // The pass lists a.md, reads it — and right after that read Noah deletes it (the entry is already there).
    const read = s.fake.read.bind(s.fake);
    let deleted = false;
    s.fake.read = async (owner, notePath) => {
      const note = await read(owner, notePath);
      if (notePath === "wiki/a.md" && !deleted) {
        deleted = true;
        await s.vault.remove("wiki/a.md");
      }
      return note;
    };
    synced(await mirror(s));
    expect(deleted).toBe(true);
    // This pass still saw the note: its file is there, and its entry must NOT have been cleared with the record.
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(ledger(s)).toEqual(["wiki/a.md"]);
    expect(row(s).mirrorDirty).toBe(true);

    expect(synced(await mirror(s))).toMatchObject({ changed: 1, notice: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorNotice: null });
  });

  // The owner's confirmation (`confirmVaultMirrorHold`, vaultMigration.ts) writes the repository-only vault
  // paths INTO the ledger, as they were at the press (`store.recordVaultDeletes`). The mirror has no other mode.
  it("after the owner's confirmation the next pass removes exactly the confirmed notes, and nothing added later", async () => {
    const s = setup({
      ...SEED,
      "wiki/only-in-git.md": "written on the git host\n",
      "raw/old.md": "old capture\n",
      "wiki/not-confirmed.md": "not part of the press\n",
    });
    await s.vault.write("wiki/a.md", "A\n");
    expect(synced(await mirror(s)).notice).toBe(repoOnly(3));

    s.store.recordVaultDeletes(s.owner.id, ["wiki/only-in-git.md", "raw/old.md"]);
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(ledger(s)).toEqual(["raw/old.md", "wiki/only-in-git.md"]);
    expect(synced(await mirror(s))).toMatchObject({ changed: 2, notice: repoOnly(1) });
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBeNull();
    expect(remoteFile(s.owner, "raw/old.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    // A repository-only note the press did not name stays, and is counted.
    expect(remoteFile(s.owner, "wiki/not-confirmed.md")).toBe("not part of the press\n");
    // Still only vault paths.
    expect(remoteFile(s.owner, "wiki/pic.png")).toBe("not really a picture");
    expect(remoteFile(s.owner, "wiki/.obsidian/app.md")).toBe("obsidian keeps this\n");
    // Settled and cleared with the pushed pass.
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorNotice: repoOnly(1), mirrorDirty: false, mirrorError: null });

    // The confirmation covered what was there at the press: a later git-only note is left alone.
    pushFromOutside(s, s.owner, { "wiki/later.md": "made on the git host\n" }, "direct add");
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(2) });
    expect(remoteFile(s.owner, "wiki/later.md")).toBe("made on the git host\n");
  });

  it("a note added on the git host between the confirmation and the first pass that gets through survives", async () => {
    const s = setup({ ...SEED, "wiki/only-in-git.md": "written on the git host\n", "raw/old.md": "old capture\n" });
    await s.vault.write("wiki/a.md", "A\n");
    expect(synced(await mirror(s)).notice).toBe(repoOnly(2));
    s.store.recordVaultDeletes(s.owner.id, ["wiki/only-in-git.md", "raw/old.md"]);
    s.store.markVaultMirrorDirty(s.owner.id);

    // The first passes cannot push (the remote refuses to move its branch): nothing is settled.
    const lock = path.join(s.owner.remote, "refs/heads/main.lock");
    fs.writeFileSync(lock, "");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await mirror(s);
      expect(failed.kind).toBe("failed");
      expect((failed as { error: string }).error.startsWith(`${VAULT_MIRROR_ERROR.push}: `)).toBe(true);
      expect(ledger(s)).toEqual(["raw/old.md", "wiki/only-in-git.md"]);
      expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorNotice: repoOnly(2) });
      expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBe("written on the git host\n");
    }
    fs.rmSync(lock);
    // Meanwhile somebody adds a note on the git host. Nobody confirmed removing THIS one.
    pushFromOutside(s, s.owner, { "wiki/added-meanwhile.md": "added after the press\n" }, "direct add");

    const done = synced(await mirror(s));
    expect(done.notice).toBe(repoOnly(1));
    expect(remoteFile(s.owner, "wiki/added-meanwhile.md")).toBe("added after the press\n");
    expect(cloneFile(s.owner, "wiki/added-meanwhile.md")).toBe("added after the press\n");
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBeNull();
    expect(remoteFile(s.owner, "raw/old.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorNotice: repoOnly(1) });
    expect(cloneStatus(s.owner)).toBe("");
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(remoteHead(s.owner));

    // And it keeps surviving: the settled entries are gone, so no later pass acts on them.
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(1) });
    expect(remoteFile(s.owner, "wiki/added-meanwhile.md")).toBe("added after the press\n");
  });

  it("with `push: false` the ledger (Noah's deletions and the owner's confirmation) and the notice are settled only after the caller's push", async () => {
    const s = setup({ ...SEED, "wiki/only-in-git.md": "written on the git host\n", "wiki/not-confirmed.md": "not part of the press\n" });
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.remove("wiki/gone.md");
    s.store.recordVaultDeletes(s.owner.id, ["wiki/only-in-git.md"]);
    const before = row(s);
    expect(before.mirrorNotice).toBe(repoOnly(2));

    const outcome = synced(await mirror(s, { push: false }));
    expect(outcome).toMatchObject({ changed: 2, notice: repoOnly(1) });
    expect(outcome.pending).toEqual({
      seq: before.mirrorSeq,
      notice: repoOnly(1),
      settledDeletes: ["wiki/gone.md", "wiki/only-in-git.md"],
    });
    expect(cloneHas(s.owner, "wiki/gone.md")).toBe(false);
    expect(cloneHas(s.owner, "wiki/only-in-git.md")).toBe(false);
    expect(cloneHas(s.owner, "wiki/not-confirmed.md")).toBe(true);
    // Nothing is settled yet.
    expect(ledger(s)).toEqual(["wiki/gone.md", "wiki/only-in-git.md"]);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorNotice: before.mirrorNotice });

    // The push failed: still nothing settled.
    finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: false, error: new Error("boom") });
    expect(ledger(s)).toEqual(["wiki/gone.md", "wiki/only-in-git.md"]);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorNotice: before.mirrorNotice });
    expect(row(s).mirrorError).toMatch(/^commit failed: /);

    await withRepoLock(s.owner.clone, () => commitAndPushLocked(ctxOf(s), "carry the copy", identityOf(s)));
    finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: true });
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorNotice: repoOnly(1), mirrorError: null });
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/not-confirmed.md")).toBe("not part of the press\n");
  });

  it("a note that vanishes between the listing and its read is deleted only if Noah deleted it", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/b.md", "B\n");
    await s.vault.write("wiki/c.md", "C\n");
    synced(await mirror(s));

    // Noah deletes a.md while the pass runs (the ledger names it): its file goes with this pass.
    s.store.markVaultMirrorDirty(s.owner.id);
    s.fake.beforeNext("read", () => s.vault.remove("wiki/a.md"));
    expect(synced(await mirror(s))).toMatchObject({ changed: 1, notice: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    // The entry stays (the pass's listing still held the note) and is settled by the next pass.
    expect(ledger(s)).toEqual(["wiki/a.md"]);
    expect(row(s).mirrorDirty).toBe(true);
    synced(await mirror(s));
    expect(ledger(s)).toEqual([]);
    expect(row(s).mirrorDirty).toBe(false);

    // b.md vanishes from the service without Noah deleting it: its file stays, and is counted.
    s.store.markVaultMirrorDirty(s.owner.id);
    s.fake.beforeNext("read", () => s.fake.remove(s.owner.id, "wiki/b.md", fakeMemoryHash("B\n")));
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(1) });
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");
    expect(remoteFile(s.owner, "wiki/c.md")).toBe("C\n");
  });
});

describe("vault mirror: links in the clone", () => {
  it("never follows a link in the clone", async () => {
    const root = getTempDir();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.md"), "outside the repository\n");
    const s = setup(SEED, { "wiki/link.md": "../README.md", "wiki/other-link.md": "../README.md", raw: outside });
    await s.vault.write("wiki/link.md", "a real note now\n");

    synced(await mirror(s));
    // A link where a note goes is replaced by a plain file; what it pointed at is untouched.
    expect(fs.lstatSync(path.join(s.owner.clone, "wiki/link.md")).isFile()).toBe(true);
    expect(remoteFile(s.owner, "wiki/link.md")).toBe("a real note now\n");
    expect(remoteFile(s.owner, "README.md")).toBe("hello");
    // A link the service holds no note for is not the mirror's to remove; a linked folder is not entered.
    expect(remoteGit(s.owner, "ls-tree", "main", "wiki/other-link.md", "raw")).toMatch(/^120000 .*\traw\n120000 .*\twiki\/other-link\.md\n$/);
    expect(fs.readdirSync(outside)).toEqual(["keep.md"]);

    // A note under the linked folder cannot be mirrored — and is not written through the link.
    await s.vault.write("raw/2026/capture.md", "captured\n");
    const failed = await mirror(s);
    expect(failed).toEqual({
      kind: "failed",
      error: "path blocked: raw is a link or a file in the repository, not a plain folder",
    });
    expect(fs.readdirSync(outside)).toEqual(["keep.md"]);
    expect(row(s).mirrorDirty).toBe(true);
  });

  it("deletes nothing through a linked folder — not a ledgered note, not one that vanished mid-pass, not one the owner confirmed", async () => {
    const root = getTempDir();
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(outside, "sub"), { recursive: true });
    fs.writeFileSync(path.join(outside, "sub", "x.md"), "a file outside the clone\n");
    fs.writeFileSync(path.join(outside, "top.md"), "another file outside the clone\n");
    const intact = () => {
      expect(fs.readFileSync(path.join(outside, "sub", "x.md"), "utf8")).toBe("a file outside the clone\n");
      expect(fs.readFileSync(path.join(outside, "top.md"), "utf8")).toBe("another file outside the clone\n");
    };
    const s = setup({ ...SEED, "wiki/index.md": "# Index\n" }, { "wiki/link": outside });

    // The service lists ONE note, under the linked folder, and Noah deletes it before the pass reads it:
    // the ledger names it, the service no longer holds it — and the "file" is reachable only through the link.
    s.fake.seed(s.owner.id, "wiki/link/sub/x.md", "a note\n");
    s.store.markVaultMirrorDirty(s.owner.id);
    s.fake.beforeNext("read", () => s.vault.remove("wiki/link/sub/x.md"));
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(1) }); // wiki/index.md, only in git
    expect(ledger(s)).toEqual(["wiki/link/sub/x.md"]);
    intact();

    // Ledgered and absent from the start — Noah's own deletion, and an owner's confirmation that names paths
    // under the link (a press made from a listing that was wrong, or made before the folder became a link): the same.
    s.fake.seed(s.owner.id, "wiki/index.md", "# Index\n");
    s.store.recordVaultDelete(s.owner.id, "wiki/link/top.md");
    s.store.recordVaultDeletes(s.owner.id, ["wiki/link/top.md", "wiki/link/sub/x.md", "wiki/link/sub/never.md"]);
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: null });
    intact();
    expect(ledger(s)).toEqual([]);
    expect(fs.lstatSync(path.join(s.owner.clone, "wiki/link")).isSymbolicLink()).toBe(true);
  });
});

describe("vault mirror: the clone's vault files, as the owner's confirmation lists them", () => {
  it("CloneVaultFiles.list names plain vault files only — no link, nothing under a linked folder, no repo path", async () => {
    const root = getTempDir();
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "x.md"), "outside the repository\n");
    const s = setup(
      { ...SEED, "CLAUDE.md": "memory\n", "wiki/a.md": "A\n", "wiki/deep/한글.md": "한글\n", "raw/2026/c.md": "C\n", "raw/notes.txt": "not a note\n" },
      { "wiki/link.md": "../README.md", "wiki/linked": outside },
    );
    await ensureClone(ctxOf(s));
    expect((await new CloneVaultFiles(s.owner.clone).list()).sort()).toEqual(
      ["CLAUDE.md", "raw/2026/c.md", "wiki/a.md", "wiki/deep/한글.md"].sort(),
    );
    // No clone at all: nothing to list (and nothing thrown).
    expect(await new CloneVaultFiles(path.join(root, "no-such-clone")).list()).toEqual([]);
  });
});

describe("vault mirror: a direct git edit never blocks the copy", () => {
  it("a direct git edit of a vault note is overwritten by the next mirror commit and stays in history", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    synced(await mirror(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "edited on the git host\n", "wiki/stray.md": "made on the git host\n" }, "direct edit");

    s.store.markVaultMirrorDirty(s.owner.id);
    // a.md is put back; the note only git knows is left alone and counted.
    expect(synced(await mirror(s))).toMatchObject({ changed: 1, notice: repoOnly(1) });
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/stray.md")).toBe("made on the git host\n");
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual([MIRROR_SUBJECT, "direct edit"]);
    expect(remoteGit(s.owner, "show", "main~1:wiki/a.md")).toBe("edited on the git host\n");
    // The service was never told about the edit.
    expect(s.fake.dump(s.owner.id)).toEqual({ "wiki/a.md": "A\n" });
  });

  it("a remote that moved during the pass is absorbed by the push's rebase, and the copy is written again after it", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/b.md", "B\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A2\n");
    // After the pass fetched, before it pushes: an unrelated file AND a direct edit of ANOTHER note (no conflict).
    s.fake.beforeNext("read", () =>
      pushFromOutside(s, s.owner, { "docs/new.md": "new\n", "wiki/b.md": "edited on the git host\n" }, "outside push"),
    );
    expect(synced(await mirror(s))).toMatchObject({ changed: 2 }); // a.md, then b.md again after the rebase
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A2\n");
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n");
    expect(remoteFile(s.owner, "docs/new.md")).toBe("new\n");
    expect(remoteSubjects(s.owner).slice(0, 3)).toEqual([MIRROR_SUBJECT, MIRROR_SUBJECT, "outside push"]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(cloneStatus(s.owner)).toBe("");
  });

  it("a conflicting edit pushed during the pass: the service's side wins and the edit stays in history", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A, second version\n");
    await s.vault.remove("wiki/gone.md");
    // Both notes are edited on the git host: one the mirror replaces, one it deletes.
    s.fake.beforeNext("read", () =>
      pushFromOutside(s, s.owner, { "wiki/a.md": "edited on the git host\n", "wiki/gone.md": "edited on the git host too\n" }, "direct edit"),
    );

    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A, second version\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual([MIRROR_SUBJECT, "direct edit"]);
    expect(remoteGit(s.owner, "show", "main~1:wiki/gone.md")).toBe("edited on the git host too\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(ledger(s)).toEqual([]);
    expect(cloneStatus(s.owner)).toBe("");
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(remoteHead(s.owner));
  });

  it("a note renamed on the git host while Noah moves it elsewhere: Noah's move wins, the git-only name is not deleted", async () => {
    const body = `${"a line of the note\n".repeat(20)}`;
    const s = setup();
    await s.vault.write("wiki/a.md", body);
    synced(await mirror(s));
    // Noah moves a.md → c.md; the git host renames a.md → b.md at the same time (a rename/rename conflict in git).
    await s.vault.write("wiki/c.md", body);
    await s.vault.remove("wiki/a.md");
    s.fake.beforeNext("read", () => {
      const dir = fs.mkdtempSync(path.join(s.root, "outside-"));
      execFileSync("git", ["clone", "-q", s.owner.remote, dir], { stdio: "pipe" });
      sh(dir, "config", "user.name", "Outside");
      sh(dir, "config", "user.email", "outside@example.com");
      sh(dir, "mv", "wiki/a.md", "wiki/b.md");
      sh(dir, "commit", "-q", "-m", "rename on the git host");
      sh(dir, "push", "-q", "origin", "main");
    });

    expect(synced(await mirror(s)).notice).toBe(repoOnly(1));
    expect(remoteFile(s.owner, "wiki/c.md")).toBe(body);
    expect(remoteFile(s.owner, "wiki/a.md")).toBeNull();
    // b.md exists only in git and Noah never deleted it: it stays, and is counted.
    expect(remoteFile(s.owner, "wiki/b.md")).toBe(body);
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual([MIRROR_SUBJECT, "rename on the git host"]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorNotice: repoOnly(1) });
    expect(cloneStatus(s.owner)).toBe("");
    expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
  });

  it("a conflict outside the vault still fails, loses nothing, and is retried", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    synced(await mirror(s));
    // An avatar commit that never reached the remote, and a different edit of the same file on the remote.
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, local\n");
    sh(s.owner.clone, "add", "-A");
    sh(s.owner.clone, "commit", "-q", "-m", "local skill edit");
    pushFromOutside(s, s.owner, { "skills/demo/SKILL.md": "# Demo skill, remote\n" }, "remote skill edit");
    await s.vault.write("wiki/a.md", "A2\n");
    const head = remoteHead(s.owner);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await mirror(s)).toEqual({ kind: "failed", error: "rebase conflict: skills/demo/SKILL.md" });
      expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "rebase conflict: skills/demo/SKILL.md" });
      expect(remoteHead(s.owner)).toBe(head);
      expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
      expect(cloneHas(s.owner, ".git/rebase-apply")).toBe(false);
      expect(cloneFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, local\n");
      expect(cloneFile(s.owner, "wiki/a.md")).toBe("A2\n");
      const subjects = sh(s.owner.clone, "log", "--format=%s").trim().split("\n");
      expect(subjects.slice(0, 2)).toEqual([MIRROR_SUBJECT, "local skill edit"]);
      expect(subjects.filter((subject) => subject === MIRROR_SUBJECT)).toHaveLength(2);
    }
    expect(vaultMirrorCommitError(new Error("REBASE_CONFLICT:a.md, b.md"), s.owner.clone)).toBe("rebase conflict: a.md, b.md");
  });

  // The three commit-tool scenarios of review 1 (`race.repro.test.ts`): the avatar's commit after a direct git edit.
  it("commit: a git edit of a vault note + the avatar's edit of the same line + an unrelated skill file", async () => {
    const s = setup({ ...SEED, "wiki/a.md": "line one\n" });
    s.fake.seed(s.owner.id, "wiki/a.md", "line one\n");
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "line one, edited on the git host\n" }, "direct edit");
    await s.vault.edit("wiki/a.md", "line one", "line one, edited by the avatar");
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, finished\n");

    // It used to end in REBASE_CONFLICT forever: the conflict is in a vault path, the commit also holds a skill.
    for (const message of ["Finish the demo skill", "again"]) {
      const done = await avatarCommit(s, message);
      expect(done.error).toBeNull();
      expect(done.committed).toBe(message === "Finish the demo skill");
    }
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("line one, edited by the avatar\n");
    expect(remoteFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, finished\n");
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual(["Finish the demo skill", "direct edit"]);
    expect(remoteGit(s.owner, "show", "main~1:wiki/a.md")).toBe("line one, edited on the git host\n");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(cloneStatus(s.owner)).toBe("");
    expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
  });

  it("commit: the same with vault paths only", async () => {
    const s = setup({ ...SEED, "wiki/a.md": "line one\n" });
    s.fake.seed(s.owner.id, "wiki/a.md", "line one\n");
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "line one, edited on the git host\n" }, "direct edit");
    await s.vault.edit("wiki/a.md", "line one", "line one, edited by the avatar");

    const done = await avatarCommit(s, "Save the note");
    expect(done).toMatchObject({ committed: true, error: null });
    expect(done.passes).toHaveLength(2); // before the commit, and again after the rebase
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("line one, edited by the avatar\n");
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual(["Save the note", "direct edit"]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
  });

  it("commit: a git edit of note A while the commit touches note B — A is put back before the copy is called up to date", async () => {
    const s = setup({ ...SEED, "wiki/a.md": "A\n", "wiki/b.md": "B\n" });
    s.fake.seed(s.owner.id, "wiki/a.md", "A\n");
    s.fake.seed(s.owner.id, "wiki/b.md", "B\n");
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "A, edited on the git host\n" }, "direct edit");
    await s.vault.write("wiki/b.md", "B2\n");

    const done = await avatarCommit(s, "Update note B");
    expect(done).toMatchObject({ committed: true, error: null });
    expect(done.passes.map((pass) => synced(pass).changed)).toEqual([1, 1]); // b.md; then a.md after the rebase
    expect(remoteFile(s.owner, "wiki/b.md")).toBe("B2\n");
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteSubjects(s.owner).slice(0, 3)).toEqual([MIRROR_SUBJECT, "Update note B", "direct edit"]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(cloneStatus(s.owner)).toBe("");
  });

  it("commit: a conflict outside the vault fails as before, and the copy is not called up to date", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "skills/demo/SKILL.md": "# Demo skill, remote\n" }, "remote skill edit");
    await s.vault.write("wiki/a.md", "A\n");
    fs.writeFileSync(path.join(s.owner.clone, "skills/demo/SKILL.md"), "# Demo skill, local\n");

    const done = await avatarCommit(s, "Local skill edit");
    expect((done.error as Error).message).toBe("REBASE_CONFLICT:skills/demo/SKILL.md");
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorError: "rebase conflict: skills/demo/SKILL.md", mirrorSyncedAt: null });
    expect(cloneFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, local\n");
    expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
  });

  it("commit: without the vault predicate a vault conflict fails as it always did (an owner whose vault is the repository)", async () => {
    const s = setup({ ...SEED, "wiki/a.md": "line one\n" });
    s.store.clearPersonalVault(s.owner.id);
    await ensureClone(ctxOf(s));
    pushFromOutside(s, s.owner, { "wiki/a.md": "line one, edited on the git host\n" }, "direct edit");
    fs.writeFileSync(path.join(s.owner.clone, "wiki/a.md"), "line one, edited locally\n");
    const head = remoteHead(s.owner);
    await expect(commitAndPush(ctxOf(s), "local edit", identityOf(s))).rejects.toThrow("REBASE_CONFLICT:wiki/a.md");
    expect(remoteHead(s.owner)).toBe(head);
    expect(cloneFile(s.owner, "wiki/a.md")).toBe("line one, edited locally\n");
    expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
  });
});

// While the copy of an owner's vault notes is on hold, NO push of their knowledge clone may change a vault path
// of the repository. The guard sits in one place — `commitAndPushLocked`, through the context's `vaultHold` —
// so the commit tool, skill learning and the mirror's own commit are all behind it.
describe("vault mirror: no push changes a vault path while the copy is on hold", () => {
  const identity = { name: "Owner", email: "owner@example.com" };
  const writeClone = (owner: Owner, files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(owner.clone, rel)), { recursive: true });
      fs.writeFileSync(path.join(owner.clone, rel), content);
    }
  };
  const message = (promise: Promise<unknown>) =>
    promise.then(
      (value) => `resolved: ${String(value)}`,
      (error: unknown) => (error as Error).message,
    );

  it("stops a push that would change a vault path — the exact sentinel, nothing committed, rebased or pushed", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    await ensureClone(ctx);
    // The clone is behind the remote (a push would rebase first) and holds seven changed vault notes and a skill.
    pushFromOutside(s, s.owner, { "docs/new.md": "new\n" }, "outside docs");
    writeClone(s.owner, {
      "CLAUDE.md": "memory\n",
      "raw/2026/r.md": "R\n",
      "skills/demo/SKILL.md": "# Demo skill, edited\n",
      ...Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`wiki/h${i}.md`, `H${i}\n`])),
    });
    const head = remoteHead(s.owner);
    const before = { head: sh(s.owner.clone, "rev-parse", "HEAD").trim(), log: sh(s.owner.clone, "log", "--format=%s") };
    // After a stop the clone is what it was before the call: no new commit, the changes still there (staged),
    // nothing of the remote merged or rebased onto.
    const untouched = () => {
      expect(remoteHead(s.owner)).toBe(head);
      expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(before.head);
      expect(sh(s.owner.clone, "log", "--format=%s")).toBe(before.log);
      expect(cloneHas(s.owner, ".git/rebase-merge")).toBe(false);
      expect(cloneHas(s.owner, "docs/new.md")).toBe(false);
      expect(cloneStatus(s.owner).split("\n")).toEqual([
        "A  CLAUDE.md",
        "A  raw/2026/r.md",
        "M  skills/demo/SKILL.md",
        ...[1, 2, 3, 4, 5].map((i) => `A  wiki/h${i}.md`),
      ]);
      expect(cloneFile(s.owner, "wiki/h5.md")).toBe("H5\n");
    };

    // Five paths are named (in git's order), the rest counted; the skill is not a vault path.
    s.store.setVaultMirrorHold(s.owner.id, "confirm");
    expect(await message(commitAndPush(ctx, "held", identity))).toBe(
      "VAULT_ON_HOLD_PUSH:confirm:CLAUDE.md, raw/2026/r.md, wiki/h1.md, wiki/h2.md, wiki/h3.md, and 2 more",
    );
    untouched();
    // The other hold state stops the same (still uncommitted) changes.
    s.store.setVaultMirrorHold(s.owner.id, "checking");
    expect(await message(commitAndPush(ctx, "again", identity))).toBe(
      "VAULT_ON_HOLD_PUSH:checking:CLAUDE.md, raw/2026/r.md, wiki/h1.md, wiki/h2.md, wiki/h3.md, and 2 more",
    );
    untouched();

    // The hold is lifted: the same call commits (once), rebases onto the remote and pushes, as always.
    s.store.setVaultMirrorHold(s.owner.id, null);
    expect(await commitAndPush(ctx, "after the hold", identity)).toBe(true);
    expect(remoteFile(s.owner, "wiki/h5.md")).toBe("H5\n");
    expect(remoteFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, edited\n");
    expect(remoteSubjects(s.owner).slice(0, 2)).toEqual(["after the hold", "outside docs"]);
    expect(remoteSubjects(s.owner)).not.toContain("held");
    expect(cloneStatus(s.owner)).toBe("");
  });

  it("names up to five paths without a count, and lets through what changes no vault path, a new branch, no hold, no `vaultHold`", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    await ensureClone(ctx);
    s.store.setVaultMirrorHold(s.owner.id, "confirm");

    // No vault path among the changes: not the hold's business (a skill, a picture under wiki/, a .md the vault cannot hold).
    writeClone(s.owner, { "skills/demo/SKILL.md": "# Demo skill, edited\n", "wiki/pic.png": "a new picture", "wiki/.obsidian/app.md": "changed\n" });
    expect(await commitAndPush(ctx, "no vault path", identity)).toBe(true);
    expect(remoteFile(s.owner, "wiki/pic.png")).toBe("a new picture");

    // Exactly five: all named, nothing counted. One: just that one.
    writeClone(s.owner, { "wiki/k1.md": "K1\n" });
    expect(await message(commitAndPush(ctx, "one", identity))).toBe("VAULT_ON_HOLD_PUSH:confirm:wiki/k1.md");
    writeClone(s.owner, Object.fromEntries([2, 3, 4, 5].map((i) => [`wiki/k${i}.md`, `K${i}\n`])));
    expect(await message(commitAndPush(ctx, "five", identity))).toBe(
      "VAULT_ON_HOLD_PUSH:confirm:wiki/k1.md, wiki/k2.md, wiki/k3.md, wiki/k4.md, wiki/k5.md",
    );
    expect(remoteFile(s.owner, "wiki/k1.md")).toBeNull();

    // A branch the remote does not have: there are no notes of its own on it to protect.
    writeClone(s.owner, { "wiki/on-fresh.md": "F\n" });
    expect(await commitAndPush({ ...ctx, branch: "fresh" }, "new branch", identity)).toBe(true);
    expect(remoteGit(s.owner, "show", "fresh:wiki/on-fresh.md")).toBe("F\n");
    expect(remoteGit(s.owner, "show", "fresh:wiki/k1.md")).toBe("K1\n");
    expect(remoteFile(s.owner, "wiki/k1.md")).toBeNull(); // main is still held

    // A context whose `vaultHold` answers null, and one without `vaultHold` at all, are not stopped —
    // whatever the row says (the guard asks the context, nothing else).
    expect(row(s).mirrorHold).toBe("confirm");
    const { vaultHold: _dropped, ...bare } = ctx;
    void _dropped;
    writeClone(s.owner, { "wiki/k6.md": "K6\n" });
    expect(await message(commitAndPush(ctx, "still held", identity))).toMatch(/^VAULT_ON_HOLD_PUSH:confirm:wiki\/k1\.md, /);
    expect(await commitAndPush({ ...ctx, vaultHold: () => null }, "answers null", identity)).toBe(true);
    expect(remoteFile(s.owner, "wiki/k6.md")).toBe("K6\n");
    writeClone(s.owner, { "wiki/k7.md": "K7\n" });
    expect(await commitAndPush(bare, "no vaultHold", identity)).toBe(true);
    expect(remoteFile(s.owner, "wiki/k7.md")).toBe("K7\n");
  });

  it("the caller's own beforePush runs after the guard, and its throw still stops the push", async () => {
    const s = setup();
    const ctx = ctxOf(s);
    await ensureClone(ctx);
    const seen: (string[] | null)[] = [];
    const refuse = (changed: string[] | null) => {
      seen.push(changed);
      throw new Error("CALLER_REFUSED");
    };
    const head = remoteHead(s.owner);

    // On hold with a vault path: the guard stops it first — the caller's hook is never asked.
    s.store.setVaultMirrorHold(s.owner.id, "confirm");
    writeClone(s.owner, { "wiki/a.md": "A\n" });
    expect(await message(commitAndPush(ctx, "held", identity, { beforePush: refuse }))).toBe("VAULT_ON_HOLD_PUSH:confirm:wiki/a.md");
    expect(seen).toEqual([]);

    // Not on hold: the caller's hook is asked, and its refusal stands.
    s.store.setVaultMirrorHold(s.owner.id, null);
    expect(await message(commitAndPush(ctx, "refused by the caller", identity, { beforePush: refuse }))).toBe("CALLER_REFUSED");
    expect(seen).toEqual([["wiki/a.md"]]);
    expect(remoteHead(s.owner)).toBe(head);

    // And a caller that lets it pass: pushed.
    expect(await commitAndPush(ctx, "let through", identity, { beforePush: (changed) => void seen.push(changed) })).toBe(true);
    expect(seen).toEqual([["wiki/a.md"], ["wiki/a.md"]]);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
  });

  it("knowledgeRepoContextFor: `vaultHold` follows the row — read when the push asks, not when the context was made", async () => {
    const s = setup();
    const ctx = ctxOf(s); // made while there is no hold
    expect(ctx.vaultHold?.()).toBeNull();
    await ensureClone(ctx);
    for (const hold of ["checking", "confirm"] as const) {
      s.store.setVaultMirrorHold(s.owner.id, hold);
      expect(ctx.vaultHold?.()).toBe(hold);
    }
    // The hold came after the context: the push still sees it.
    writeClone(s.owner, { "wiki/a.md": "A\n" });
    expect(await message(commitAndPush(ctx, "held", identity))).toBe("VAULT_ON_HOLD_PUSH:confirm:wiki/a.md");
    s.store.setVaultMirrorHold(s.owner.id, null);
    expect(ctx.vaultHold?.()).toBeNull();
    // An owner whose vault is the repository (no row): never a hold.
    s.store.clearPersonalVault(s.owner.id);
    expect(ctx.vaultHold?.()).toBeNull();
    expect(ctxOf(s).vaultHold?.()).toBeNull();
    expect(await commitAndPush(ctx, "the vault is the repository", identity)).toBe(true);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
  });

  it("vaultHoldPushStop reads the sentinel, and nothing else", async () => {
    expect(VAULT_ON_HOLD_PUSH).toBe("VAULT_ON_HOLD_PUSH:");
    expect(vaultHoldPushStop(new Error("VAULT_ON_HOLD_PUSH:confirm:wiki/a.md, wiki/b.md, and 3 more"))).toEqual({
      hold: "confirm",
      files: "wiki/a.md, wiki/b.md, and 3 more",
    });
    expect(vaultHoldPushStop(new Error("VAULT_ON_HOLD_PUSH:checking:CLAUDE.md"))).toEqual({ hold: "checking", files: "CLAUDE.md" });
    expect(vaultHoldPushStop("VAULT_ON_HOLD_PUSH:checking:CLAUDE.md")).toEqual({ hold: "checking", files: "CLAUDE.md" });
    // A path may hold a colon or a newline; everything after the hold is the list.
    expect(vaultHoldPushStop(new Error("VAULT_ON_HOLD_PUSH:confirm:wiki/a:b.md,\n wiki/c.md"))).toEqual({
      hold: "confirm",
      files: "wiki/a:b.md,\n wiki/c.md",
    });
    for (const other of [
      new Error("REBASE_CONFLICT:wiki/a.md"),
      new Error("Command failed: git push\nVAULT_ON_HOLD_PUSH:confirm:wiki/a.md"), // not at the start
      new Error("VAULT_ON_HOLD_PUSH:held:wiki/a.md"), // not a hold state
      new Error("VAULT_ON_HOLD_PUSH"),
      new Error(""),
      "some text",
      { message: "VAULT_ON_HOLD_PUSH:confirm:wiki/a.md" }, // not an Error
      ["VAULT_ON_HOLD_PUSH:confirm:wiki/a.md"],
      42,
      null,
      undefined,
    ]) {
      expect(vaultHoldPushStop(other)).toBeNull();
    }
    // What a stopped push really throws.
    const s = setup();
    await ensureClone(ctxOf(s));
    s.store.setVaultMirrorHold(s.owner.id, "checking");
    writeClone(s.owner, { "wiki/a.md": "A\n", "raw/b.md": "B\n" });
    const thrown = await commitAndPush(ctxOf(s), "held", identity).then(
      () => null,
      (error: unknown) => error,
    );
    expect(vaultHoldPushStop(thrown)).toEqual({ hold: "checking", files: "raw/b.md, wiki/a.md" });
  });

  // A hold that arrives while a pass runs (a repository change is stored outside the repo lock) is the same
  // as one the pass finds at its start: `skipped: hold`, nothing recorded, nothing settled.
  it.each([
    ["no error on the row before", null],
    ["an older error on the row before", "push failed: ! [remote rejected] HEAD -> main (earlier)"],
  ])("the mirror's own commit: a hold that arrives while a pass runs stops its push and records nothing (%s)", async (_label, earlier) => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A2\n");
    await s.vault.remove("wiki/gone.md");
    if (earlier) s.store.recordVaultMirror(s.owner.id, { ok: false, error: earlier });
    const before = row(s);
    expect(before).toMatchObject({ mirrorDirty: true, mirrorError: earlier });
    const head = remoteHead(s.owner);
    const cloneHead = sh(s.owner.clone, "rev-parse", "HEAD").trim();

    // The pass has looked at the row (no hold) and is reading the service when the hold is set
    // (the owner connects another branch).
    s.fake.beforeNext("read", () => s.store.setVaultMirrorHold(s.owner.id, "confirm"));
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "hold" });
    // Nothing reached the repository…
    expect(remoteHead(s.owner)).toBe(head);
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBe("G\n");
    // …and the row and the ledger are exactly what they were, but for the hold itself: no failure recorded,
    // an older error neither replaced nor cleared, nothing settled.
    expect(row(s)).toEqual({ ...before, mirrorHold: "confirm" });
    expect(ledger(s)).toEqual(["wiki/gone.md"]);
    // No commit was made: what the pass wrote is in the working tree, uncommitted (staged).
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(cloneHead);
    expect(sh(s.owner.clone, "log", "--format=%s", "origin/main..HEAD").trim()).toBe("");
    expect(cloneStatus(s.owner)).toBe("M  wiki/a.md\nD  wiki/gone.md");
    expect(cloneFile(s.owner, "wiki/a.md")).toBe("A2\n");

    // While the hold lasts, every pass is skipped at its start — the row still untouched.
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "hold" });
    expect(row(s)).toEqual({ ...before, mirrorHold: "confirm" });
    expect(remoteHead(s.owner)).toBe(head);

    // The hold is lifted: the leftover vault changes are not "unfinished work" (no repo_dirty) — the next pass
    // commits and pushes them, and settles row and ledger.
    s.store.setVaultMirrorHold(s.owner.id, null);
    synced(await mirror(s));
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A2\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(remoteSubjects(s.owner)[0]).toBe(MIRROR_SUBJECT);
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorHold: null });
    expect(sh(s.owner.clone, "rev-parse", "HEAD").trim()).toBe(remoteHead(s.owner));
    expect(cloneStatus(s.owner)).toBe("");
  });

  it("`push: false`: finishVaultMirror records nothing for a push the hold stopped — and still records every other failure", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.remove("wiki/gone.md");
    const outcome = synced(await mirror(s, { push: false }));
    expect(outcome.pending?.settledDeletes).toEqual(["wiki/gone.md"]);
    const before = row(s);
    expect(before).toMatchObject({ mirrorDirty: true, mirrorError: null });
    const stop = new Error("VAULT_ON_HOLD_PUSH:confirm:wiki/gone.md");
    const finish = (error: unknown) => finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: false, error });

    // The caller's push was stopped by the hold: not a failure of the mirror — the row is left as it was.
    finish(stop);
    expect(row(s)).toEqual(before);
    expect(ledger(s)).toEqual(["wiki/gone.md"]);

    // Every other failure is recorded as before…
    finish(new Error("boom"));
    expect(row(s).mirrorError).toBe("commit failed: boom");
    finish(Object.assign(new Error(`Command failed: git -C ${s.owner.clone} push origin HEAD:main`), { stderr: " ! [remote rejected] HEAD -> main (declined)\n" }));
    expect(row(s).mirrorError).toBe("push failed: ! [remote rejected] HEAD -> main (declined)");
    finish(new Error("REBASE_CONFLICT:skills/demo/SKILL.md"));
    expect(row(s).mirrorError).toBe("rebase conflict: skills/demo/SKILL.md");
    // …and a hold stop after one of those leaves THAT error where it is (neither replaced nor cleared).
    finish(stop);
    finish(new Error("VAULT_ON_HOLD_PUSH:checking:wiki/gone.md, and 3 more"));
    expect(row(s)).toEqual({ ...before, mirrorError: "rebase conflict: skills/demo/SKILL.md" });
    expect(ledger(s)).toEqual(["wiki/gone.md"]);
  });

  it("commit: a hold that arrives between the commit's mirror pass and its push — stopped, nothing recorded, pushed after the hold", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    await s.vault.write("wiki/a.md", "A\n");
    writeClone(s.owner, { "skills/demo/SKILL.md": "# Demo skill, edited\n" });
    const before = row(s);
    const head = remoteHead(s.owner);

    // The commit's own pass ran without a hold (it wrote the copy); the hold is there when the push is looked at.
    s.fake.beforeNext("read", () => s.store.setVaultMirrorHold(s.owner.id, "checking"));
    const stopped = await avatarCommit(s, "Finish the demo skill");
    expect(stopped.committed).toBe(false);
    expect(vaultHoldPushStop(stopped.error)).toEqual({ hold: "checking", files: "wiki/a.md" });
    expect(stopped.passes.map((pass) => pass.kind)).toEqual(["synced"]);
    expect(remoteHead(s.owner)).toBe(head);
    expect(row(s)).toEqual({ ...before, mirrorHold: "checking" });
    // No commit: the skill edit and the copy the pass wrote are still in the tree, as before a commit.
    expect(sh(s.owner.clone, "log", "--format=%s", "origin/main..HEAD").trim()).toBe("");
    expect(cloneStatus(s.owner)).toBe("M  skills/demo/SKILL.md\nA  wiki/a.md");

    s.store.setVaultMirrorHold(s.owner.id, null);
    const done = await avatarCommit(s, "again");
    expect(done).toMatchObject({ committed: true, error: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(remoteFile(s.owner, "skills/demo/SKILL.md")).toBe("# Demo skill, edited\n");
    expect(remoteSubjects(s.owner)[0]).toBe("again");
    expect(remoteSubjects(s.owner)).not.toContain("Finish the demo skill");
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorHold: null });
  });
});

// `discardVaultCopyChanges(repoRoot)`: every uncommitted change at a vault path goes back to HEAD. For an owner
// whose vault lives in the service such a change is only the mirror's own writing, left by a pass or a commit
// that the hold stopped before its commit — and it must not keep the clone from following a branch change.
describe("vault mirror: discardVaultCopyChanges", () => {
  type Files = Record<string, string>;
  const write = (dir: string, files: Files) => {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
  };
  /** A repository (not a clone of anything: the function only looks at HEAD and the working tree) holding `files`. */
  const repoWith = (files: Files): string => {
    const dir = path.join(getTempDir(), "repo");
    gitInit(dir); // README.md = "hello"
    write(dir, files);
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "files");
    return dir;
  };
  /** `git status`, one `XY path` per changed path, names exactly as on disk. */
  const status = (dir: string) =>
    sh(dir, "status", "--porcelain", "-z", "--untracked-files=all", "--no-renames").split("\0").filter(Boolean).sort();
  const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  const has = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

  it("puts modified, deleted and staged vault files back as HEAD has them, removes new ones, and leaves every other change alone", async () => {
    const HEAD: Files = {
      "CLAUDE.md": "memory\n",
      "wiki/a.md": "A\n",
      "wiki/b.md": "B\n",
      "wiki/c.md": "C\n",
      "wiki/d.md": "D\n",
      "wiki/moved.md": "moved\n",
      "raw/2026/r.md": "R\n",
      "wiki/keep/other.txt": "not a note\n",
      "skills/demo/SKILL.md": "# Demo skill\n",
      "wiki/pic.png": "a picture",
      "wiki/.obsidian/x.md": "obsidian\n",
    };
    const dir = repoWith(HEAD);
    // Vault paths, in every state a stopped pass or commit can leave them in.
    write(dir, { "wiki/a.md": "A changed\n", "CLAUDE.md": "memory changed\n" }); //  M
    write(dir, { "wiki/b.md": "B changed\n" });
    sh(dir, "add", "wiki/b.md"); // M
    write(dir, { "wiki/c.md": "C staged\n" });
    sh(dir, "add", "wiki/c.md");
    write(dir, { "wiki/c.md": "C changed again\n" }); // MM
    fs.rmSync(path.join(dir, "wiki/d.md")); //  D
    sh(dir, "rm", "-q", "raw/2026/r.md"); // D  (and raw/2026 is gone from the tree)
    sh(dir, "mv", "wiki/moved.md", "wiki/moved-to.md"); // D + A
    write(dir, { "wiki/new/deep/n.md": "new\n", "wiki/keep/k.md": "new, next to another file\n" }); // ??
    write(dir, { "wiki/new2/s.md": "new, staged\n", "raw/fresh.md": "new, staged\n" });
    sh(dir, "add", "wiki/new2/s.md", "raw/fresh.md"); // A
    write(dir, { "raw/fresh.md": "new, staged, changed\n" }); // AM
    // Everything else — an avatar's unfinished work, staged or not.
    write(dir, { "skills/demo/SKILL.md": "# Demo skill, half edited\n", "notes.txt": "scratch\n" });
    sh(dir, "add", "skills/demo/SKILL.md", "notes.txt"); // M , A
    write(dir, { "wiki/pic.png": "another picture", "wiki/.obsidian/x.md": "obsidian changed\n", "wiki/.obsidian/new.md": "new\n", "wiki/keep/more.txt": "more\n" });
    fs.rmSync(path.join(dir, "README.md")); //  D
    const others = [
      " D README.md",
      " M wiki/.obsidian/x.md",
      " M wiki/pic.png",
      "?? wiki/.obsidian/new.md",
      "?? wiki/keep/more.txt",
      "A  notes.txt",
      "M  skills/demo/SKILL.md",
    ];
    expect(status(dir).filter((line) => !isPersonalVaultPath(line.slice(3)))).toEqual(others);
    const head = sh(dir, "rev-parse", "HEAD").trim();

    // Twelve vault paths: a, b, c, d, CLAUDE.md, r, moved, moved-to, n, k, s, fresh.
    expect(await discardVaultCopyChanges(dir)).toBe(12);
    // No vault path is changed any more — and nothing else moved, staged or not.
    expect(status(dir)).toEqual(others);
    expect(sh(dir, "rev-parse", "HEAD").trim()).toBe(head);
    for (const rel of ["CLAUDE.md", "wiki/a.md", "wiki/b.md", "wiki/c.md", "wiki/d.md", "wiki/moved.md", "raw/2026/r.md"]) {
      expect(read(dir, rel)).toBe(HEAD[rel]);
    }
    // New vault files are gone, with the folders they emptied — not a folder that holds something else.
    for (const rel of ["wiki/moved-to.md", "wiki/new", "wiki/new2", "raw/fresh.md", "wiki/keep/k.md"]) expect(has(dir, rel)).toBe(false);
    expect(read(dir, "wiki/keep/other.txt")).toBe("not a note\n");
    expect(read(dir, "wiki/keep/more.txt")).toBe("more\n");
    expect(read(dir, "skills/demo/SKILL.md")).toBe("# Demo skill, half edited\n");
    expect(read(dir, "wiki/pic.png")).toBe("another picture");
    expect(read(dir, "wiki/.obsidian/x.md")).toBe("obsidian changed\n");
    expect(read(dir, "wiki/.obsidian/new.md")).toBe("new\n");
    expect(read(dir, "notes.txt")).toBe("scratch\n");

    // Nothing left to drop.
    expect(await discardVaultCopyChanges(dir)).toBe(0);
    expect(status(dir)).toEqual(others);
  });

  it("takes names literally: `*`, `[…]`, a leading `:`, Korean, spaces — a name that is a pattern never reaches another file", async () => {
    const HEAD: Files = {
      "wiki/*.md": "a note literally named star\n",
      "wiki/[ab].md": "brackets\n",
      "wiki/:colon.md": "colon\n",
      "wiki/한글 노트.md": "한글\n",
      "raw/sp ace/x y.md": "spaces\n",
      "wiki/a.md": "A\n",
      "raw/kept/r.md": "R\n",
      "wiki/.obsidian/app.md": "obsidian\n",
    };
    const dir = repoWith(HEAD);
    for (const rel of ["wiki/*.md", "wiki/[ab].md", "wiki/:colon.md", "wiki/한글 노트.md", "raw/sp ace/x y.md"]) write(dir, { [rel]: "changed\n" });
    // New files whose names, read as patterns, match files that are NOT theirs to touch:
    // `raw/*.md` matches every tracked note under raw/; `wiki/[ab].md` matched wiki/a.md above.
    write(dir, { "raw/*.md": "new\n", "wiki/새 노트 [1].md": "new\n", "wiki/?.md": "new\n" });
    sh(dir, "add", "wiki/?.md");
    // A change outside the vault that `wiki/*.md`, read as a pattern, would also match.
    write(dir, { "wiki/.obsidian/app.md": "obsidian changed\n" });

    expect(await discardVaultCopyChanges(dir)).toBe(8);
    expect(status(dir)).toEqual([" M wiki/.obsidian/app.md"]);
    expect(read(dir, "wiki/.obsidian/app.md")).toBe("obsidian changed\n");
    for (const [rel, content] of Object.entries(HEAD)) {
      if (rel !== "wiki/.obsidian/app.md") expect(read(dir, rel)).toBe(content);
    }
    for (const rel of ["raw/*.md", "wiki/새 노트 [1].md", "wiki/?.md"]) expect(has(dir, rel)).toBe(false);
    // Every tracked file is still tracked (a pattern handed to `git rm --cached` would have dropped some).
    expect(sh(dir, "ls-files", "-z").split("\0").filter(Boolean).sort()).toEqual(["README.md", ...Object.keys(HEAD)].sort());
  });

  it("removes nothing through a linked folder", async () => {
    const outside = path.join(getTempDir(), "outside");
    write(outside, { "new.md": "a file outside the clone\n", "deep/also.md": "another one\n" });
    const dir = repoWith({ "wiki/a.md": "A\n" });
    // A new vault note was staged under wiki/x/ — and then the folder became a link out of the clone.
    write(dir, { "wiki/x/new.md": "staged\n", "wiki/x/deep/also.md": "staged\n" });
    sh(dir, "add", "-A");
    fs.rmSync(path.join(dir, "wiki/x"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "wiki/x"));
    write(dir, { "wiki/a.md": "A changed\n" });

    expect(await discardVaultCopyChanges(dir)).toBe(3);
    // The staged notes are unstaged, the plain change is restored — and what the link points at is untouched.
    expect(read(outside, "new.md")).toBe("a file outside the clone\n");
    expect(read(outside, "deep/also.md")).toBe("another one\n");
    expect(read(dir, "wiki/a.md")).toBe("A\n");
    expect(fs.lstatSync(path.join(dir, "wiki/x")).isSymbolicLink()).toBe(true);
    expect(status(dir)).toEqual(["?? wiki/x"]); // the link itself: not a vault path, not this function's to remove

    // The other way round: a folder HEAD holds a note under became a link. The note comes back as a plain file
    // in a plain folder (git puts the folder back in place of the link) — never written through the link.
    fs.rmSync(path.join(dir, "wiki/x"));
    write(dir, { "wiki/sub/t.md": "tracked\n" });
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "a note in a folder");
    write(outside, { "t.md": "outside, same name\n" });
    fs.rmSync(path.join(dir, "wiki/sub"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, "wiki/sub"));
    expect(status(dir)).toEqual([" D wiki/sub/t.md", "?? wiki/sub"]);
    expect(await discardVaultCopyChanges(dir)).toBe(1);
    expect(read(outside, "t.md")).toBe("outside, same name\n");
    expect(fs.readdirSync(outside).sort()).toEqual(["deep", "new.md", "t.md"]);
    expect(fs.lstatSync(path.join(dir, "wiki/sub")).isDirectory()).toBe(true);
    expect(read(dir, "wiki/sub/t.md")).toBe("tracked\n");
    expect(status(dir)).toEqual([]);
  });

  it("a folder that is no clone, and a clone without a commit, are left alone", async () => {
    const plain = path.join(getTempDir(), "plain");
    write(plain, { "wiki/a.md": "A\n" });
    expect(await discardVaultCopyChanges(plain)).toBe(0);
    expect(await discardVaultCopyChanges(path.join(getTempDir(), "nothing-here"))).toBe(0);
    expect(read(plain, "wiki/a.md")).toBe("A\n");

    // A folder that is no clone but sits INSIDE another repository (a data folder under a checkout): git would
    // find that repository from there — its changed vault-looking paths are not this function's to restore.
    const outer = repoWith({ "CLAUDE.md": "the outer repository's own\n", "wiki/a.md": "A\n" });
    write(outer, { "CLAUDE.md": "being edited\n", "wiki/a.md": "being edited\n", "data/knowledge/u1/wiki/a.md": "not a clone\n" });
    const outerStatus = status(outer);
    expect(await discardVaultCopyChanges(path.join(outer, "data/knowledge/u1"))).toBe(0);
    expect(status(outer)).toEqual(outerStatus);
    expect(read(outer, "CLAUDE.md")).toBe("being edited\n");
    expect(read(outer, "wiki/a.md")).toBe("being edited\n");
    expect(read(outer, "data/knowledge/u1/wiki/a.md")).toBe("not a clone\n");

    const unborn = path.join(getTempDir(), "unborn");
    fs.mkdirSync(unborn);
    sh(unborn, "init", "-q");
    write(unborn, { "wiki/a.md": "A\n", "wiki/b.md": "B\n" });
    sh(unborn, "add", "wiki/b.md");
    const before = status(unborn);
    expect(before).toEqual(["?? wiki/a.md", "A  wiki/b.md"]);
    expect(await discardVaultCopyChanges(unborn)).toBe(0);
    expect(status(unborn)).toEqual(before);
    expect(read(unborn, "wiki/a.md")).toBe("A\n");
  });

  it("handles more paths than one git command names", async () => {
    const tracked = Array.from({ length: 450 }, (_, i) => `wiki/bulk/n${i}.md`);
    const dir = repoWith(Object.fromEntries(tracked.map((rel) => [rel, "as committed\n"])));
    write(dir, Object.fromEntries(tracked.map((rel) => [rel, "changed\n"])));
    for (const rel of tracked.slice(0, 30)) fs.rmSync(path.join(dir, rel));
    const added = Array.from({ length: 250 }, (_, i) => `raw/bulk/x${i}.md`);
    write(dir, Object.fromEntries(added.map((rel) => [rel, "new\n"])));
    sh(dir, "add", "raw/bulk");
    write(dir, { "skills/demo/SKILL.md": "# a skill\n" });

    expect(await discardVaultCopyChanges(dir)).toBe(700);
    expect(status(dir)).toEqual(["?? skills/demo/SKILL.md"]);
    for (const rel of [tracked[0], tracked[199], tracked[200], tracked[449]]) expect(read(dir, rel)).toBe("as committed\n");
    expect(has(dir, "raw/bulk")).toBe(false);
  });

  it("after a pass the hold stopped: the leftover copy is dropped, and the pass after the hold writes it again and pushes", async () => {
    const s = setup();
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.write("wiki/a.md", "A2\n");
    await s.vault.write("wiki/new/n.md", "N\n");
    await s.vault.remove("wiki/gone.md");
    s.fake.beforeNext("read", () => s.store.setVaultMirrorHold(s.owner.id, "checking"));
    expect(await mirror(s)).toEqual({ kind: "skipped", reason: "hold" });
    expect(cloneStatus(s.owner)).toBe("M  wiki/a.md\nD  wiki/gone.md\nA  wiki/new/n.md");
    const before = row(s);

    // What the repository-change check does before it lets the clone follow a branch change.
    expect(await withRepoLock(s.owner.clone, () => discardVaultCopyChanges(s.owner.clone))).toBe(3);
    expect(cloneStatus(s.owner)).toBe("");
    expect(cloneFile(s.owner, "wiki/a.md")).toBe("A\n");
    expect(cloneFile(s.owner, "wiki/gone.md")).toBe("G\n");
    expect(cloneHas(s.owner, "wiki/new")).toBe(false);
    // Only files moved: the row and the ledger are what they were.
    expect(row(s)).toEqual(before);
    expect(ledger(s)).toEqual(["wiki/gone.md"]);

    // The hold ends: the next pass writes the copy again (three files), commits and pushes it.
    s.store.setVaultMirrorHold(s.owner.id, null);
    expect(synced(await mirror(s))).toMatchObject({ changed: 3, notice: null });
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A2\n");
    expect(remoteFile(s.owner, "wiki/new/n.md")).toBe("N\n");
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null, mirrorHold: null });
    expect(cloneStatus(s.owner)).toBe("");
  });
});

describe("vault mirror: the background loop", () => {
  it("mirrors every vault at start (dirty or not), then the dirty ones, and stops when told", async () => {
    const s = setup();
    // In the service, but the row was never marked (a crash between the write and the mark).
    s.fake.seed(s.owner.id, "wiki/a.md", "A\n");
    expect(row(s).mirrorDirty).toBe(false);

    const loop = startVaultMirrorLoop(s.store, s.config, { intervalMs: 10 });
    loops.push(loop);
    await vi.waitFor(() => expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n"), { timeout: 10_000 });
    await vi.waitFor(() => expect(row(s).mirrorDirty).toBe(false), { timeout: 10_000 });

    await s.vault.write("wiki/b.md", "B\n");
    await vi.waitFor(() => expect(remoteFile(s.owner, "wiki/b.md")).toBe("B\n"), { timeout: 10_000 });
    await vi.waitFor(() => expect(row(s).mirrorDirty).toBe(false), { timeout: 10_000 });

    // A clean row costs nothing: no service call while nothing changed.
    const calls = s.fake.calls.length;
    await sleep(80);
    expect(s.fake.calls.length).toBe(calls);

    loop.stop();
    await s.vault.write("wiki/c.md", "C\n");
    await sleep(120);
    expect(remoteFile(s.owner, "wiki/c.md")).toBeNull();
    expect(row(s).mirrorDirty).toBe(true);
  });

  it("works one owner at a time, never overlaps itself, and ends a pass when the service is down", async () => {
    const s = setup();
    const second = addOwner(s, "second");
    s.fake.seed(s.owner.id, "wiki/a.md", "A\n");
    s.fake.seed(second.id, "wiki/b.md", "B\n");

    // Every listing (one per owner per pass) takes far longer than the interval.
    let active = 0;
    let most = 0;
    const listed: string[] = [];
    const list = s.fake.list.bind(s.fake);
    s.fake.list = async (owner, prefix) => {
      listed.push(owner);
      active += 1;
      most = Math.max(most, active);
      try {
        await sleep(120);
        return await list(owner, prefix);
      } finally {
        active -= 1;
      }
    };
    // The first pass finds the service down at its first owner.
    s.fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });

    const loop = startVaultMirrorLoop(s.store, s.config, { intervalMs: 5 });
    loops.push(loop);
    await sleep(60);
    expect(listed).toHaveLength(1); // many intervals have passed; the pass in progress is the only one
    await vi.waitFor(
      () => {
        expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
        expect(remoteFile(second, "wiki/b.md")).toBe("B\n");
      },
      { timeout: 15_000 },
    );
    expect(most).toBe(1);
    // (The push is visible on the remote a moment before the pass records it.)
    await vi.waitFor(
      () => {
        expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorError: null });
        expect(row(s, second)).toMatchObject({ mirrorDirty: false, mirrorError: null });
      },
      { timeout: 10_000 },
    );
    // The service is down for everyone: the failed pass did not go on to the other owner. The next pass starts
    // over with the SAME owner — had the first pass gone on, the other owner would be listed second.
    expect(listed).toHaveLength(3);
    expect(listed[1]).toBe(listed[0]);
    expect(listed[2]).not.toBe(listed[0]);
  });

  it("a locked commit while the loop runs: both go through the same repo lock", async () => {
    const s = setup();
    await ensureClone(ctxOf(s));
    const loop = startVaultMirrorLoop(s.store, s.config, { intervalMs: 5 });
    loops.push(loop);
    for (let i = 0; i < 4; i += 1) {
      await s.vault.write(`wiki/n${i}.md`, `note ${i}\n`);
      expect((await avatarCommit(s, `commit ${i}`)).error).toBeNull();
    }
    await vi.waitFor(() => expect(row(s).mirrorDirty).toBe(false), { timeout: 10_000 });
    loop.stop();
    for (let i = 0; i < 4; i += 1) expect(remoteFile(s.owner, `wiki/n${i}.md`)).toBe(`note ${i}\n`);
    expect(row(s).mirrorError).toBeNull();
    expect(cloneStatus(s.owner)).toBe("");
  });
});
