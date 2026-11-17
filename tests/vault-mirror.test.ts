import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { withRepoLock } from "../src/server/gitMutex.js";
import {
  VAULT_MIRROR_COMMIT_MESSAGE,
  commitAndPush,
  commitAndPushLocked,
  commitIdentityFor,
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
} from "../src/server/knowledgeRepo.js";
import { MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { isPersonalVaultPath, memoryVaultFor } from "../src/server/personalVault.js";
import {
  VAULT_MIRROR_ERROR,
  VAULT_MIRROR_NOTICE,
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
    expect(outcome.pending).toEqual({ seq: row(s).mirrorSeq, notice: null, settledDeletes: [], replacedAll: false });
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

  it("the owner's one-shot replace-all makes the repository equal to the service, once", async () => {
    const s = setup({ ...SEED, "wiki/only-in-git.md": "written on the git host\n", "raw/old.md": "old capture\n" });
    await s.vault.write("wiki/a.md", "A\n");
    expect(synced(await mirror(s)).notice).toBe(repoOnly(2));

    s.store.setVaultMirrorReplaceAll(s.owner.id, true);
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 2, notice: null });
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBeNull();
    expect(remoteFile(s.owner, "raw/old.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/a.md")).toBe("A\n");
    // Still only vault paths.
    expect(remoteFile(s.owner, "wiki/pic.png")).toBe("not really a picture");
    expect(remoteFile(s.owner, "wiki/.obsidian/app.md")).toBe("obsidian keeps this\n");
    expect(row(s)).toMatchObject({ mirrorReplaceAll: false, mirrorNotice: null, mirrorDirty: false });

    // The flag was for that one pass: a later git-only note is left alone again.
    pushFromOutside(s, s.owner, { "wiki/later.md": "made on the git host\n" }, "direct add");
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: repoOnly(1) });
    expect(remoteFile(s.owner, "wiki/later.md")).toBe("made on the git host\n");
  });

  it("with `push: false` the ledger, the notice and the replace-all are settled only after the caller's push", async () => {
    const s = setup({ ...SEED, "wiki/only-in-git.md": "written on the git host\n" });
    await s.vault.write("wiki/a.md", "A\n");
    await s.vault.write("wiki/gone.md", "G\n");
    synced(await mirror(s));
    await s.vault.remove("wiki/gone.md");
    s.store.setVaultMirrorReplaceAll(s.owner.id, true);
    const before = row(s);

    const outcome = synced(await mirror(s, { push: false }));
    expect(outcome).toMatchObject({ changed: 2, notice: null });
    expect(outcome.pending).toEqual({ seq: before.mirrorSeq, notice: null, settledDeletes: ["wiki/gone.md"], replacedAll: true });
    expect(cloneHas(s.owner, "wiki/gone.md")).toBe(false);
    expect(cloneHas(s.owner, "wiki/only-in-git.md")).toBe(false);
    // Nothing is settled yet.
    expect(ledger(s)).toEqual(["wiki/gone.md"]);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorReplaceAll: true, mirrorNotice: before.mirrorNotice });

    // The push failed: still nothing settled.
    finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: false, error: new Error("boom") });
    expect(ledger(s)).toEqual(["wiki/gone.md"]);
    expect(row(s)).toMatchObject({ mirrorDirty: true, mirrorReplaceAll: true });
    expect(row(s).mirrorError).toMatch(/^commit failed: /);

    await withRepoLock(s.owner.clone, () => commitAndPushLocked(ctxOf(s), "carry the copy", identityOf(s)));
    finishVaultMirror(s.store, s.config, s.owner.id, outcome, { ok: true });
    expect(ledger(s)).toEqual([]);
    expect(row(s)).toMatchObject({ mirrorDirty: false, mirrorReplaceAll: false, mirrorNotice: null, mirrorError: null });
    expect(remoteFile(s.owner, "wiki/gone.md")).toBeNull();
    expect(remoteFile(s.owner, "wiki/only-in-git.md")).toBeNull();
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

  it("deletes nothing through a linked folder — not a ledgered note, not one that vanished mid-pass, not under replace-all", async () => {
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

    // Ledgered and absent from the start, and under replace-all: the same.
    s.fake.seed(s.owner.id, "wiki/index.md", "# Index\n");
    s.store.recordVaultDelete(s.owner.id, "wiki/link/top.md");
    s.store.setVaultMirrorReplaceAll(s.owner.id, true);
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(synced(await mirror(s))).toMatchObject({ changed: 0, notice: null });
    intact();
    expect(ledger(s)).toEqual([]);
    expect(fs.lstatSync(path.join(s.owner.clone, "wiki/link")).isSymbolicLink()).toBe(true);
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
