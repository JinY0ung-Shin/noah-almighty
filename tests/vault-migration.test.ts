import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { buildRepoTools } from "../src/server/agent/repoTools.js";
import { closeRun, openRun } from "../src/server/agent/runRegistry.js";
import { withRepoLock } from "../src/server/gitMutex.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { MemoryRefusedError, MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { VAULT_HOME_CHANGED, VAULT_NOTE_MAX_BYTES, memoryVaultFor, withVaultWrite } from "../src/server/personalVault.js";
import { claimRoutineSlot, releaseRoutineSlot } from "../src/server/routineRunRegistry.js";
import {
  VAULT_BLOCKER,
  VAULT_CONFIRM_REFUSAL,
  VAULT_LEFTOVER_BLOCKERS,
  VAULT_LEFTOVER_DIR,
  VAULT_ROLLBACK_REFUSAL,
  VAULT_SKIP,
  confirmVaultMirrorHold,
  cutoverVault,
  isVaultMigrationRunning,
  lastVaultMigrationReport,
  onKnowledgeRepoChanged,
  ownerRunInProgress,
  planVaultMigration,
  recheckVaultMirrorHold,
  resumeVaultMirrorChecks,
  rollbackVault,
  runVaultMigrationPass,
  setVaultCutoverRetryForTests,
  startVaultMigrationPass,
  whenVaultMigrationIdle,
} from "../src/server/vaultMigration.js";
import { syncVaultMirror } from "../src/server/vaultMirror.js";
import { createFakeMemoryClient, fakeMemoryHash, type FakeMemoryClient } from "./helpers/fakeMemory.js";
import { callTool, makeBareRemote, withTempDir } from "./helpers.js";

// vaultMigration.ts: the dry run, the cutover repo → memory, the rollback, the
// pass and the "repository changed" rules — over real clones of LOCAL bare
// remotes (offline; a local path needs no token) and the in-process fake of
// the memory service. The git mirror (vaultMirror.ts, another module) is
// stubbed: these tests pin how the migration CALLS it and what it does with
// each outcome.

vi.mock("../src/server/vaultMirror.js", async (importOriginal) => ({
  // Everything else of the module is the real thing (the owner's confirmation lists the clone with its helper).
  ...(await importOriginal<typeof import("../src/server/vaultMirror.js")>()),
  syncVaultMirror: vi.fn(),
  startVaultMirrorLoop: vi.fn(() => ({ stop() {} })),
}));

// The real clone sync, except that a test can make the NEXT one a no-op that reports success: the checks the
// migration makes AFTER the sync are its last line of defence when git did not do what it was asked.
const cloneSync = vi.hoisted(() => ({ skipNext: false, afterNext: null as (() => void) | null }));
vi.mock("../src/server/knowledgeRepo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/knowledgeRepo.js")>();
  const ensureCloneLocked: typeof actual.ensureCloneLocked = (ctx, repoRoot) => {
    if (cloneSync.skipNext) {
      cloneSync.skipNext = false;
      return Promise.resolve(repoRoot ?? actual.knowledgeClonePath(ctx.userId, ctx.config));
    }
    // … or run something right after the next sync (the owner doing something while a job has the clone).
    const after = cloneSync.afterNext;
    cloneSync.afterNext = null;
    return actual.ensureCloneLocked(ctx, repoRoot).then((root) => {
      after?.();
      return root;
    });
  };
  return { ...actual, ensureCloneLocked };
});

const mirror = vi.mocked(syncVaultMirror);
type Services = ReturnType<typeof createServices>;

// Every test here clones and fetches real git repositories: room for a loaded machine (the whole suite in parallel).
vi.setConfig({ testTimeout: 30_000 });

const getTempDir = withTempDir("vault-migration");

beforeEach(() => {
  cloneSync.skipNext = false;
  cloneSync.afterNext = null;
  setVaultCutoverRetryForTests();
  mirror.mockReset();
  // A mirror that works: the clone equals the service, and the row says so.
  mirror.mockImplementation(async (store, _config, userId) => {
    store.recordVaultMirror(userId, { ok: true });
    return { kind: "synced", changed: 0, seq: 0 };
  });
});

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();

type Files = Record<string, string | Buffer>;

function writeFiles(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** A bare remote on `main` holding `files`, outside the data root; returns its path. Its seed tree stays for later pushes. */
function seedRemote(name: string, files: Files): string {
  const remotes = path.join(getTempDir(), "remotes");
  fs.mkdirSync(remotes, { recursive: true });
  const remote = makeBareRemote(path.join(remotes, `${name}.git`));
  const seed = path.join(remotes, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q");
  git(seed, "config", "user.email", "seed@example.com");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "commit.gpgsign", "false");
  writeFiles(seed, { "README.md": "# brain\n", ...files });
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "branch", "-M", "main");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  return remote;
}

/** Push one more commit to a seeded remote (the owner working from elsewhere). */
function pushMore(name: string, files: Files, remove: string[] = []): void {
  const seed = path.join(getTempDir(), "remotes", `${name}-seed`);
  writeFiles(seed, files);
  for (const rel of remove) fs.rmSync(path.join(seed, rel), { force: true });
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "more");
  git(seed, "push", "-q", "origin", "main");
}

/** Every app instance a test made: its pending retries are cancelled when the test ends. */
const booted: Services[] = [];

// A hold left at `checking` is looked at again for as long as it lasts, and a cutover that waits for a run a
// bounded number of times: a test that ends in such a state would keep that going — against a temp folder
// that is gone. Disconnecting the repository cancels the owner's pending retry (the hook's first line).
afterEach(async () => {
  setVaultCutoverRetryForTests();
  for (const { store, config } of booted.splice(0)) {
    for (const user of store.listUsers()) {
      store.setKnowledgeRepo(user.id, null, null);
      onKnowledgeRepoChanged(store, config, user.id, null);
    }
    await whenVaultMigrationIdle(store);
  }
});

/** Push `branch` (cut from the seed tree's main, `files` on top) to a seeded remote. */
function pushBranch(name: string, branch: string, files: Files): void {
  const seed = path.join(getTempDir(), "remotes", `${name}-seed`);
  git(seed, "checkout", "-q", "-b", branch);
  writeFiles(seed, files);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", branch);
  git(seed, "push", "-q", "origin", branch);
  git(seed, "checkout", "-q", "main");
}

function setup(options: { fake?: FakeMemoryClient | null } = {}) {
  const services = createServices({ dataDir: path.join(getTempDir(), "data"), agentRuntime: "local", sessionSecret: "t" });
  booted.push(services);
  const { store, config } = services;
  const fake = options.fake === undefined ? createFakeMemoryClient() : options.fake;
  if (fake) setMemoryClientForTests(store, fake);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  store.setGitToken(owner.id, "test-token");
  return { services, store, config, fake: fake as FakeMemoryClient, ownerId: owner.id };
}

/** One more teammate, with a git token like the owner. */
function addUser(s: { store: Services["store"] }, username: string): string {
  const user = s.store.createUser({ username, displayName: username, password: "password123" });
  s.store.setGitToken(user.id, "test-token");
  return user.id;
}

/** Connect `files` as the owner's knowledge repository (a seeded local remote on `main`). */
function connect(s: { store: Services["store"] }, userId: string, name: string, files: Files): string {
  const remote = seedRemote(name, files);
  s.store.setKnowledgeRepo(userId, remote, "main");
  return remote;
}

const VAULT: Files = {
  "CLAUDE.md": "# standing memory\n",
  "wiki/index.md": "# Index\n",
  "wiki/concepts/deploy.md": "---\ntitle: Deploy\n---\nHow we deploy.\n",
  "raw/2026-11-01.md": "captured\n",
};

/** Every file under this boot's quarantine of leftover notes, `<user>/<time>/<note path>` → content. */
function quarantinedLeftovers(s: { config: Services["config"] }): Record<string, string> {
  const retired = path.join(s.config.dataDir, "retired");
  const out: Record<string, string> = {};
  if (!fs.existsSync(retired) || !fs.statSync(retired).isDirectory()) return out;
  for (const stamp of fs.readdirSync(retired)) {
    const root = path.join(retired, stamp, VAULT_LEFTOVER_DIR);
    if (!fs.existsSync(root)) continue;
    const walk = (dir: string, rel: string) => {
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = rel ? `${rel}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) walk(path.join(dir, dirent.name), child);
        else out[child] = fs.readFileSync(path.join(dir, dirent.name), "utf8");
      }
    };
    walk(root, "");
  }
  return out;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Hold the owner's clone lock — a commit or a sync of some run — until released. */
function holdCloneLock(s: { ownerId: string; config: Services["config"] }): { release(): Promise<void> } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const held = withRepoLock(knowledgeClonePath(s.ownerId, s.config), () => gate);
  return {
    release: async () => {
      open();
      await held;
    },
  };
}

const writes = (fake: FakeMemoryClient) => fake.calls.filter((call) => call.op === "put" || call.op === "remove" || call.op === "deleteWiki");
const codes = (blockers: string[]) => blockers.map((text) => text.split(":")[0]);

/** Every file of a directory tree (no `.git`), `path → sha256`, to prove a clone was not changed. */
function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dirent.name === ".git") continue;
      const child = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(path.join(dir, dirent.name), child);
      else if (dirent.isFile()) out[child] = fakeMemoryHash(fs.readFileSync(path.join(dir, dirent.name), "utf8"));
      else out[child] = "link";
    }
  };
  walk(root, "");
  return out;
}

// ---- The state table of the issue ("Every existing state has a defined outcome") ----

describe("cutover — every existing state has a defined outcome", () => {
  it("a repository with wiki/ and raw/: notes and CLAUDE.md are imported, verified, and the home flips", async () => {
    const s = setup();
    const remote = connect(s, s.ownerId, "brain", VAULT);

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(report).toMatchObject({ userId: s.ownerId, repo: remote, state: "memory", notes: 4, blockers: [], skipped: [] });
    expect(report.bytes).toBe(Object.values(VAULT).reduce((sum, text) => sum + Buffer.byteLength(text), 0));
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    const row = s.store.getPersonalVault(s.ownerId);
    expect(row).toMatchObject({ sourceRepo: remote, sourceCommit: git(clone, "rev-parse", "HEAD"), mirrorHold: null, mirrorDirty: false });
    expect(report.sourceCommit).toBe(row!.sourceCommit);
    // Every note was read back after the import.
    const putAt = s.fake.calls.map((call) => call.op).lastIndexOf("put");
    const readBack = s.fake.calls.slice(putAt + 1).filter((call) => call.op === "read").map((call) => call.path);
    expect(readBack.sort()).toEqual(Object.keys(VAULT).sort());
    // The first mirror record, under the locks the cutover already holds.
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(mirror).toHaveBeenCalledWith(s.store, s.config, s.ownerId, { push: true, locked: true });
    expect(row!.mirrorSyncedAt).not.toBeNull();
    // Source files are never deleted or rewritten: the clone is still exactly its commit.
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(clone, "wiki/concepts/deploy.md"), "utf8")).toBe(VAULT["wiki/concepts/deploy.md"]);
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(report);
  });

  it("a repository that predates the vault layout: CLAUDE.md is imported if present, then the home flips", async () => {
    const s = setup();
    connect(s, s.ownerId, "old", { "CLAUDE.md": "old rules\n", "skills/x/SKILL.md": "---\nname: x\n---\n" });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 1, blockers: [], skipped: [] });
    expect(s.fake.dump(s.ownerId)).toEqual({ "CLAUDE.md": "old rules\n" });

    const other = { id: addUser(s, "bare") };
    connect(s, other.id, "bare", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    const empty = await cutoverVault(s.store, s.config, other.id);
    expect(empty).toMatchObject({ state: "memory", notes: 0, bytes: 0, blockers: [] });
    expect(s.fake.dump(other.id)).toEqual({});
    expect(s.store.getPersonalVault(other.id)).not.toBeNull();
  });

  it("no repository connected: nothing to import, nothing changes", async () => {
    const s = setup();
    for (const run of [planVaultMigration, cutoverVault]) {
      const report = await run(s.store, s.config, s.ownerId);
      expect(report).toEqual({ userId: s.ownerId, repo: null, sourceCommit: null, notes: 0, bytes: 0, skipped: [], blockers: [], state: "no_repo" });
    }
    expect(s.fake.calls).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(mirror).not.toHaveBeenCalled();
  });

  it("a dirty clone is refused and reported; the owner stays on `repo` and the next pass moves them", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setPersonalVaultMode("memory");
    await planVaultMigration(s.store, s.config, s.ownerId); // clones
    const clone = knowledgeClonePath(s.ownerId, s.config);
    fs.writeFileSync(path.join(clone, "wiki/draft.md"), "not committed\n");

    const [refused] = await runVaultMigrationPass(s.store, s.config);
    expect(refused.state).toBe("repo");
    expect(codes(refused.blockers)).toEqual([VAULT_BLOCKER.uncommitted]);
    expect(refused.blockers[0]).toContain("wiki/draft.md");
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(writes(s.fake)).toEqual([]);
    expect(fs.readFileSync(path.join(clone, "wiki/draft.md"), "utf8")).toBe("not committed\n");

    fs.rmSync(path.join(clone, "wiki/draft.md"));
    const [moved] = await runVaultMigrationPass(s.store, s.config);
    expect(moved).toMatchObject({ state: "memory", blockers: [] });
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });

  it("uncommitted vault files of an owner on `repo` ARE their vault: a dry run and a cutover leave every one of them as it is", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    await planVaultMigration(s.store, s.config, s.ownerId);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    // What the avatar wrote and has not committed yet: an edit, a new note, a deletion.
    fs.writeFileSync(path.join(clone, "wiki/index.md"), "# Index, edited and not committed\n");
    fs.writeFileSync(path.join(clone, "wiki/new-note.md"), "written, not committed\n");
    fs.rmSync(path.join(clone, "raw/2026-11-01.md"));
    const status = git(clone, "status", "--porcelain");
    expect(status).not.toBe("");

    for (const run of [planVaultMigration, cutoverVault]) {
      const report = await run(s.store, s.config, s.ownerId);
      expect(report.state).toBe("repo");
      expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.uncommitted]);
      expect(git(clone, "status", "--porcelain")).toBe(status);
      expect(fs.readFileSync(path.join(clone, "wiki/index.md"), "utf8")).toBe("# Index, edited and not committed\n");
      expect(fs.readFileSync(path.join(clone, "wiki/new-note.md"), "utf8")).toBe("written, not committed\n");
      expect(fs.existsSync(path.join(clone, "raw/2026-11-01.md"))).toBe(false);
    }
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("a clone with unpushed commits is refused", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    await planVaultMigration(s.store, s.config, s.ownerId);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    fs.writeFileSync(path.join(clone, "wiki/local.md"), "local only\n");
    git(clone, "add", "-A");
    git(clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "local");

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.unpushed]);
    expect(report.blockers[0]).toContain("1 commit on main is not pushed");
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(writes(s.fake)).toEqual([]);
  });

  it("an unreachable repository is refused", async () => {
    const s = setup();
    s.store.setKnowledgeRepo(s.ownerId, path.join(getTempDir(), "remotes", "missing.git"), "main");
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.syncFailed]);
    expect(report.blockers[0]).toMatch(/^sync_failed: could not fetch the repository \(/);
    expect(s.fake.calls).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("a note over the size cap is reported and the owner is not flipped until it is resolved", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", { ...VAULT, "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES + 1) });

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(report.blockers).toEqual([`note_too_large: wiki/big.md is ${VAULT_NOTE_MAX_BYTES + 1} bytes (a note is at most ${VAULT_NOTE_MAX_BYTES})`]);
    expect(report.notes).toBe(4);
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();

    // Exactly at the cap is a note like any other.
    pushMore("brain", { "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES) });
    const resolved = await cutoverVault(s.store, s.config, s.ownerId);
    expect(resolved).toMatchObject({ state: "memory", notes: 5, blockers: [] });
    expect(s.fake.dump(s.ownerId)["wiki/big.md"]).toHaveLength(VAULT_NOTE_MAX_BYTES);
  });

  it("non-markdown files under wiki/ and raw/ are not memory: listed as skipped, left in the repository", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", {
      ...VAULT,
      "wiki/diagram.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
      "raw/export.csv": "a,b\n",
      "raw/.gitkeep": "",
      "wiki/sources/.gitkeep": "",
    });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    expect(report.skipped).toEqual([
      { path: "raw/export.csv", reason: "not_markdown: not a markdown note; it stays in the repository" },
      { path: "wiki/diagram.png", reason: "not_markdown: not a markdown note; it stays in the repository" },
    ]);
    expect(Object.keys(s.fake.dump(s.ownerId)).sort()).toEqual(Object.keys(VAULT).sort());
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(fs.existsSync(path.join(clone, "wiki/diagram.png"))).toBe(true);
    expect(fs.existsSync(path.join(clone, "raw/export.csv"))).toBe(true);
  });
});

// ---- What is and is not a note --------------------------------------------------

describe("what is imported", () => {
  it("a .md the service cannot store, a link and a duplicate are skipped — never blockers, never followed", async () => {
    const s = setup();
    const outside = path.join(getTempDir(), "outside.md");
    fs.writeFileSync(outside, "SECRET outside the repository\n");
    const remote = seedRemote("brain", {
      ...VAULT,
      "wiki/.obsidian/workspace.md": "hidden\n",
      [`wiki/${Array.from({ length: 16 }, (_, i) => `d${i}`).join("/")}/deep.md`]: "too deep\n",
      "notes/elsewhere.md": "not a vault path at all\n",
    });
    const seed = path.join(getTempDir(), "remotes", "brain-seed");
    fs.symlinkSync(outside, path.join(seed, "wiki/link.md"));
    fs.symlinkSync(path.dirname(outside), path.join(seed, "raw/linked-dir"));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "links");
    git(seed, "push", "-q", "origin", "main");
    s.store.setKnowledgeRepo(s.ownerId, remote, "main");

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    const reasons = Object.fromEntries(report.skipped.map((entry) => [entry.path, entry.reason.split(":")[0]]));
    expect(reasons).toEqual({
      "raw/linked-dir": VAULT_SKIP.symlink,
      "wiki/.obsidian/workspace.md": VAULT_SKIP.dotName,
      [`wiki/${Array.from({ length: 16 }, (_, i) => `d${i}`).join("/")}/deep.md`]: VAULT_SKIP.tooDeep,
      "wiki/link.md": VAULT_SKIP.symlink,
    });
    expect(JSON.stringify(s.fake.dump(s.ownerId))).not.toContain("SECRET");
    expect(Object.keys(s.fake.dump(s.ownerId)).sort()).toEqual(Object.keys(VAULT).sort());
  });

  it("wiki/ or raw/ being a link (or a file) blocks the owner: the mirror could never write under it", async () => {
    const s = setup();
    const outside = path.join(getTempDir(), "outside-wiki");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.md"), "SECRET outside the repository\n");
    const remote = seedRemote("brain", { "CLAUDE.md": "memory\n", raw: "a file named raw\n" });
    const seed = path.join(getTempDir(), "remotes", "brain-seed");
    fs.symlinkSync(outside, path.join(seed, "wiki"));
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "link");
    git(seed, "push", "-q", "origin", "main");
    s.store.setKnowledgeRepo(s.ownerId, remote, "main");

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(report.blockers).toEqual([
      "vault_folder_link: raw is a file in the repository, not a plain folder: the mirror could never write notes under it",
      "vault_folder_link: wiki is a link in the repository, not a plain folder: the mirror could never write notes under it",
    ]);
    expect(report.notes).toBe(1);
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("a note path is stored NFC; a BOM and CRLF come back byte for byte", async () => {
    const s = setup();
    const nfd = "wiki/한글 노트.md".normalize("NFD");
    const text = "﻿첫 줄\r\n둘째 줄\r\n";
    connect(s, s.ownerId, "brain", { [nfd]: text });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 1, blockers: [] });
    expect(s.fake.dump(s.ownerId)).toEqual({ ["wiki/한글 노트.md".normalize("NFC")]: text });
  });

  it("two files of the clone that are ONE note path once normalized: the same text is one note, different text blocks (note_conflict)", async () => {
    const s = setup();
    const nfc = "wiki/한글.md".normalize("NFC");
    const nfd = "wiki/한글.md".normalize("NFD");
    connect(s, s.ownerId, "same", { [nfc]: "같은 내용\n", [nfd]: "같은 내용\n" });
    const same = await cutoverVault(s.store, s.config, s.ownerId);
    expect(same).toMatchObject({ state: "memory", notes: 1, blockers: [] });
    expect(same.skipped.map((entry) => entry.reason.split(":")[0])).toEqual([VAULT_SKIP.duplicate]);
    expect(s.fake.dump(s.ownerId)).toEqual({ [nfc]: "같은 내용\n" });

    const other = addUser(s, "twins");
    connect(s, other, "twins", { [nfc]: "하나\n", [nfd]: "둘\n" });
    const report = await cutoverVault(s.store, s.config, other);
    expect(report.state).toBe("repo");
    // The clone's own problem — not a leftover copy in the service.
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.conflict]);
    expect(VAULT_LEFTOVER_BLOCKERS).not.toContain(VAULT_BLOCKER.conflict);
    expect(s.fake.dump(other)).toEqual({});
  });

  it("a note that is not UTF-8, or holds a NUL, blocks the owner", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", {
      ...VAULT,
      "wiki/latin1.md": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
      "raw/nul.md": "a\u0000b\n",
    });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(report.blockers).toEqual(["invalid_content: raw/nul.md contains a NUL character", "not_utf8: wiki/latin1.md is not UTF-8 text"]);
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });
});

// ---- Dry run --------------------------------------------------------------------

describe("dry run", () => {
  it("reports what a cutover would do and changes nothing", async () => {
    const s = setup();
    const remote = connect(s, s.ownerId, "brain", { ...VAULT, "wiki/pic.png": Buffer.from([1, 2, 3]) });
    await planVaultMigration(s.store, s.config, s.ownerId); // the first one clones
    const clone = knowledgeClonePath(s.ownerId, s.config);
    const before = { head: git(clone, "rev-parse", "HEAD"), tree: treeHashes(clone), users: s.store.listUsers(), mode: s.store.getPersonalVaultMode() };
    s.fake.calls.length = 0;

    const report = await planVaultMigration(s.store, s.config, s.ownerId);

    expect(report).toEqual({
      userId: s.ownerId,
      repo: remote,
      sourceCommit: before.head,
      notes: 4,
      bytes: Object.values(VAULT).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      skipped: [{ path: "wiki/pic.png", reason: "not_markdown: not a markdown note; it stays in the repository" }],
      blockers: [],
      state: "repo",
    });
    // The service was only read; the store and the clone are as they were.
    expect(s.fake.calls.map((call) => call.op)).toEqual(["list"]);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.store.listPersonalVaults()).toEqual([]);
    expect(s.store.getPersonalVaultMode()).toBe(before.mode);
    expect(s.store.listUsers()).toEqual(before.users);
    expect({ head: git(clone, "rev-parse", "HEAD"), tree: treeHashes(clone) }).toEqual({ head: before.head, tree: before.tree });
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(mirror).not.toHaveBeenCalled();
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(report);
  });

  it("names every blocker at once, also without a memory service on this server", async () => {
    const s = setup({ fake: null });
    connect(s, s.ownerId, "brain", { ...VAULT, "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES + 1) });
    await planVaultMigration(s.store, s.config, s.ownerId);
    fs.writeFileSync(path.join(knowledgeClonePath(s.ownerId, s.config), "untracked.txt"), "x");
    s.store.touchConversation(s.ownerId, "c-run", s.ownerId, "hi");
    openRun("run-plan", s.ownerId, { conversationId: "c-run", avatarId: s.ownerId });
    try {
      const report = await planVaultMigration(s.store, s.config, s.ownerId);
      expect(codes(report.blockers)).toEqual([
        VAULT_BLOCKER.notConfigured,
        VAULT_BLOCKER.runInProgress,
        VAULT_BLOCKER.uncommitted,
        VAULT_BLOCKER.tooLarge,
      ]);
      expect(report).toMatchObject({ state: "repo", notes: 4 });
    } finally {
      closeRun("run-plan");
    }
  });

  it("an owner already in the memory service is reported from the service", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    s.fake.calls.length = 0;
    const report = await planVaultMigration(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 4, blockers: [], sourceCommit: s.store.getPersonalVault(s.ownerId)!.sourceCommit });
    expect(s.fake.calls.map((call) => call.op)).toEqual(["list"]);

    s.fake.failNext(new MemoryUnavailableError("down", "network"));
    const down = await planVaultMigration(s.store, s.config, s.ownerId);
    expect(down).toMatchObject({ state: "memory", blockers: ["memory_unavailable: the memory service could not be used (network)"] });
  });

  it("an unknown user is a report, not an exception", async () => {
    const s = setup();
    const report = await planVaultMigration(s.store, s.config, "nobody");
    expect(report).toMatchObject({ state: "no_repo", blockers: ["no_user: no such user"] });
  });
});

// ---- Idempotent and resumable ---------------------------------------------------

describe("cutover is idempotent and resumable", () => {
  it("a second cutover sends nothing", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    const migratedAt = s.store.getPersonalVault(s.ownerId)!.migratedAt;
    s.fake.calls.length = 0;
    mirror.mockClear();

    const again = await cutoverVault(s.store, s.config, s.ownerId);
    expect(again).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    expect(writes(s.fake)).toEqual([]);
    expect(mirror).not.toHaveBeenCalled();
    expect(s.store.getPersonalVault(s.ownerId)!.migratedAt).toBe(migratedAt);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });

  it("notes an interrupted import already stored (same path, same hash) are not sent again", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.seed(s.ownerId, "CLAUDE.md", VAULT["CLAUDE.md"] as string);
    s.fake.seed(s.ownerId, "wiki/index.md", VAULT["wiki/index.md"] as string);

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    expect(s.fake.calls.filter((call) => call.op === "put").map((call) => call.path)).toEqual(["raw/2026-11-01.md", "wiki/concepts/deploy.md"]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });
});

// ---- Blockers -------------------------------------------------------------------

describe("blockers leave the owner on `repo` and the service as it was", () => {
  const expectUntouched = (s: ReturnType<typeof setup>, dump: Record<string, string> = {}) => {
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual(dump);
    expect(mirror).not.toHaveBeenCalled();
  };

  it("no git token — nothing is fetched (no token at all, or none for an https repository's host)", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setGitToken(s.ownerId, null);
    const none = await cutoverVault(s.store, s.config, s.ownerId);
    expect(none.blockers).toEqual(["no_git_token: no git token is set, so the repository cannot be synced or mirrored"]);
    expect(none.state).toBe("repo");

    // Only the token of github.com is set; the repository is on the internal host.
    s.store.setUserSecret(s.ownerId, "GITHUB_TOKEN", "external-only");
    s.store.setKnowledgeRepo(s.ownerId, "owner/brain", "main");
    const wrongHost = await cutoverVault(s.store, { ...s.config, githubHost: "git.internal.example" }, s.ownerId);
    expect(wrongHost.blockers).toEqual(["no_git_token: no git token is set for this repository's host, so the repository cannot be synced or mirrored"]);

    expect(fs.existsSync(knowledgeClonePath(s.ownerId, s.config))).toBe(false);
    expect(s.fake.calls).toEqual([]);
    expectUntouched(s);
  });

  it("the service already holds a DIFFERENT note at a path, or a note the repository does not have", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.seed(s.ownerId, "wiki/index.md", "# Another index\n");
    s.fake.seed(s.ownerId, "wiki/only-here.md", "stray\n");
    // Same size, different text: the size alone must not pass for "the same note".
    s.fake.seed(s.ownerId, "raw/2026-11-01.md", "CAPTURED\n");
    const seeded = s.fake.dump(s.ownerId);

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(report.blockers).toEqual([
      "service_note_conflict: the memory service already holds a different note at raw/2026-11-01.md",
      "service_note_conflict: the memory service already holds a different note at wiki/index.md",
      "service_only_note: the memory service already holds wiki/only-here.md, which the repository does not have",
    ]);
    // The codes a client keys "discard the leftover copy" on — and nothing else in this report.
    expect(codes(report.blockers).every((code) => VAULT_LEFTOVER_BLOCKERS.includes(code))).toBe(true);
    expect([...VAULT_LEFTOVER_BLOCKERS].sort()).toEqual([VAULT_BLOCKER.serviceConflict, VAULT_BLOCKER.serviceOnly].sort());
    expect(writes(s.fake)).toEqual([]);
    expectUntouched(s, seeded);
  });

  it("wiki_full: the import stops, what it stored is taken back", async () => {
    const s = setup({ fake: createFakeMemoryClient({ maxNotes: 2 }) });
    connect(s, s.ownerId, "brain", VAULT);
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.wikiFull]);
    expect(s.fake.calls.filter((call) => call.op === "put")).toHaveLength(3);
    expectUntouched(s);
  });

  it("a run of the owner in progress — a chat turn on their own avatar, or a routine", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    expect(ownerRunInProgress(s.store, s.ownerId)).toBe(false);

    s.store.touchConversation(s.ownerId, "c-own", s.ownerId, "hi");
    openRun("run-own", s.ownerId, { conversationId: "c-own", avatarId: s.ownerId });
    try {
      expect(ownerRunInProgress(s.store, s.ownerId)).toBe(true);
      const report = await cutoverVault(s.store, s.config, s.ownerId);
      expect(report.blockers).toEqual(["run_in_progress: a run is in progress for this owner"]);
      expect(s.fake.calls).toEqual([]);
      expectUntouched(s);
    } finally {
      closeRun("run-own");
    }

    const job = { id: "job-1", avatarUserId: s.ownerId };
    claimRoutineSlot(job);
    try {
      const report = await cutoverVault(s.store, s.config, s.ownerId);
      expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.runInProgress]);
      expectUntouched(s);
    } finally {
      releaseRoutineSlot(job);
    }

    // Retried once the run is over.
    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", blockers: [] });
  });

  it("the backup gate refusing holds the cutover before anything is touched", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    const gate = vi.spyOn(s.store, "retirementGate").mockReturnValue({ allowed: false, stamp: "x", backupPath: null });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.backupFailed]);
    // It says what the server is doing (holding), and promises no backup.
    expect(report.blockers[0]).toContain("has been holding data-changing maintenance steps since its last start because a database backup failed");
    expect(gate).toHaveBeenCalled();
    expect(fs.existsSync(knowledgeClonePath(s.ownerId, s.config))).toBe(false);
    expect(s.fake.calls).toEqual([]);
    expectUntouched(s);

    // A dry run never asks for the backup.
    gate.mockClear();
    expect((await planVaultMigration(s.store, s.config, s.ownerId)).blockers).toEqual([]);
    expect(gate).not.toHaveBeenCalled();
  });

  it("no memory service on this server", async () => {
    const s = setup({ fake: null });
    connect(s, s.ownerId, "brain", VAULT);
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.blockers).toEqual(["memory_not_configured: this server has no memory service configured"]);
    expect(report.state).toBe("repo");
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("the service going away is an outage, said as one — before and during the import", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.failNext(new MemoryUnavailableError("down", "timeout"), { op: "list" });
    const before = await cutoverVault(s.store, s.config, s.ownerId);
    expect(before.blockers).toEqual(["memory_unavailable: the memory service could not be used (timeout)"]);
    expectUntouched(s);

    // The second put's answer is lost on the way back (the note WAS stored): still taken back.
    s.fake.beforeNext("put", () => s.fake.failNext(new MemoryUnavailableError("lost", "network"), { op: "put", applied: true }));
    const during = await cutoverVault(s.store, s.config, s.ownerId);
    expect(codes(during.blockers)).toEqual([VAULT_BLOCKER.unavailable]);
    expect(during.state).toBe("repo");
    expectUntouched(s);

    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", blockers: [] });
  });

  it("a refusal of one note names the note", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.failNext(new MemoryRefusedError("invalid_path", 400, "no"), { op: "put" });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.blockers).toEqual(["refused: the service refused CLAUDE.md (code: invalid_path)"]);
    expectUntouched(s);
  });
});

describe("verification", () => {
  it("a note that reads back different does not flip the home", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    // With an empty wiki the first read is the read-back of the first note.
    s.fake.beforeNext("read", () => s.fake.seed(s.ownerId, "CLAUDE.md", "tampered\n"));

    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(report.blockers).toEqual(["verify_failed: CLAUDE.md read back from the service differs from the repository's file"]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(mirror).not.toHaveBeenCalled();
    // What this attempt stored is taken back; the note that is no longer its own stays.
    expect(s.fake.dump(s.ownerId)).toEqual({ "CLAUDE.md": "tampered\n" });
  });

  it("a note that appeared in the service during the import does not flip the home", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    let lists = 0;
    const list = s.fake.list.bind(s.fake);
    s.fake.list = (owner, prefix) => {
      lists += 1;
      if (lists === 2) s.fake.seed(owner, "wiki/stray.md", "appeared\n");
      return list(owner, prefix);
    };
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.serviceOnly]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({ "wiki/stray.md": "appeared\n" });
  });

  it("a first mirror record that fails does not undo the move: the row is marked for the mirror loop", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    mirror.mockImplementation(async (store, _config, userId) => {
      store.recordVaultMirror(userId, { ok: false, error: "push rejected" });
      return { kind: "failed", error: "push rejected" };
    });
    const report = await cutoverVault(s.store, s.config, s.ownerId);
    expect(report).toMatchObject({ state: "memory", blockers: [] });
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorDirty: true, mirrorError: "push rejected" });

    const other = { id: addUser(s, "thrown") };
    connect(s, other.id, "thrown", VAULT);
    mirror.mockRejectedValue(new Error("boom"));
    expect(await cutoverVault(s.store, s.config, other.id)).toMatchObject({ state: "memory", blockers: [] });
    expect(s.store.getPersonalVault(other.id)).toMatchObject({ mirrorDirty: true });
  });
});

// ---- Rollback -------------------------------------------------------------------

describe("rollback", () => {
  async function migrated() {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    mirror.mockClear();
    return s;
  }

  it("pushes the mirror one last time, flips the home back and deletes the service's copy", async () => {
    const s = await migrated();
    const vault = memoryVaultFor(s.store, s.config, s.ownerId)!;
    await vault.write("wiki/after.md", "written after the cutover\n");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(true);
    const order: string[] = [];
    mirror.mockImplementation(async (store, _config, userId) => {
      // The row still says `memory` and the wiki is whole while the mirror runs.
      order.push(`mirror home=${store.getPersonalVault(userId) ? "memory" : "repo"} notes=${Object.keys(s.fake.dump(userId)).length}`);
      store.recordVaultMirror(userId, { ok: true });
      return { kind: "synced", changed: 1, seq: 0 };
    });

    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true });

    expect(order).toEqual(["mirror home=memory notes=5"]);
    expect(mirror).toHaveBeenCalledWith(s.store, s.config, s.ownerId, { push: true });
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(memoryVaultFor(s.store, s.config, s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: s.ownerId });
  });

  it.each([
    [{ kind: "failed", error: "push rejected (non-fast-forward)" } as const, "mirror_failed: push rejected (non-fast-forward)"],
    [{ kind: "skipped", reason: "hold" } as const, VAULT_ROLLBACK_REFUSAL.mirrorHold],
    [{ kind: "skipped", reason: "no_repo" } as const, VAULT_ROLLBACK_REFUSAL.mirrorNoRepo],
    [{ kind: "skipped", reason: "repo_dirty" } as const, VAULT_ROLLBACK_REFUSAL.mirrorRepoDirty],
  ])("a mirror that cannot be brought up to date (%j) blocks it and says why", async (outcome, reason) => {
    const s = await migrated();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("wiki/after.md", "kept\n");
    mirror.mockResolvedValue(outcome);

    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason });

    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({ ...VAULT, "wiki/after.md": "kept\n" });
    expect(s.fake.calls.some((call) => call.op === "deleteWiki")).toBe(false);
  });

  it("a mirror that says synced but left the row behind, or throws, blocks it too", async () => {
    const s = await migrated();
    s.store.markVaultMirrorDirty(s.ownerId);
    mirror.mockResolvedValue({ kind: "synced", changed: 0, seq: 0 }); // records nothing: the row stays dirty
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.mirrorBehind });
    mirror.mockRejectedValue(new Error("boom"));
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: "mirror_failed: the mirror could not run" });
    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });

  it("the backup gate refusing, and a server without a memory service, block it", async () => {
    const s = await migrated();
    const gate = vi.spyOn(s.store, "retirementGate").mockReturnValue({ allowed: false, stamp: "x", backupPath: null });
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.backupFailed });
    gate.mockRestore();
    setMemoryClientForTests(s.store, null);
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.notConfigured });
    expect(mirror).not.toHaveBeenCalled();
    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
  });

  it("a write queued during the rollback ends in VAULT_HOME_CHANGED and leaves nothing in the service", async () => {
    const s = await migrated();
    const vault = memoryVaultFor(s.store, s.config, s.ownerId)!;
    let queued: Promise<unknown> | undefined;
    mirror.mockImplementation(async (store, _config, userId) => {
      // While the rollback holds the owner's write lock, the avatar writes a note.
      queued = vault.write("wiki/late.md", "too late\n").then(
        () => "written",
        (error: unknown) => (error as Error).message,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      store.recordVaultMirror(userId, { ok: true });
      return { kind: "synced", changed: 0, seq: 0 };
    });

    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true });
    expect(await queued).toBe(VAULT_HOME_CHANGED);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.fake.calls.filter((call) => call.op === "put" && call.path === "wiki/late.md")).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("a wiki that could not be deleted does not undo the flip; rolling back again discards it", async () => {
    const s = await migrated();
    s.fake.failNext(new MemoryUnavailableError("down", "network"), { op: "deleteWiki" });
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true });
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);

    // The clone holds every one of those notes as it is: nothing to put aside.
    mirror.mockClear();
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true, leftover: { notes: 4, quarantined: 0 } });
    expect(mirror).not.toHaveBeenCalled();
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(quarantinedLeftovers(s)).toEqual({});

    s.fake.seed(s.ownerId, "wiki/left.md", "left\n");
    s.fake.failNext(new MemoryUnavailableError("down", "network"), { op: "deleteWiki" });
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.unavailable });
    // The note was put aside before the delete that failed.
    expect(Object.values(quarantinedLeftovers(s))).toEqual(["left\n"]);
  });

  describe("an owner whose home already is `repo`: the leftover copy in the service", () => {
    async function leftover(notes: Record<string, string>) {
      const s = setup();
      connect(s, s.ownerId, "brain", VAULT);
      await planVaultMigration(s.store, s.config, s.ownerId); // the clone is on disk
      for (const [notePath, content] of Object.entries(notes)) s.fake.seed(s.ownerId, notePath, content);
      s.fake.calls.length = 0;
      return s;
    }

    it("a successful discard also drops the cached report that named the leftover", async () => {
      const s = await leftover({ "wiki/only-here.md": "only in the service\n" });
      const report = await planVaultMigration(s.store, s.config, s.ownerId);
      expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.serviceOnly]);
      expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(report);

      // Refused: the report (and the button it carries) stays.
      s.fake.failNext(new MemoryUnavailableError("down", "timeout"), { op: "read" });
      expect((await rollbackVault(s.store, s.config, s.ownerId, { expect: "repo" })).ok).toBe(false);
      expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(report);

      expect((await rollbackVault(s.store, s.config, s.ownerId, { expect: "repo" })).ok).toBe(true);
      expect(lastVaultMigrationReport(s.store, s.ownerId)).toBeNull();
    });

    it("identical to the clone: deleted, nothing quarantined", async () => {
      const s = await leftover(VAULT as Record<string, string>);
      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true, leftover: { notes: 4, quarantined: 0 } });
      expect(s.fake.dump(s.ownerId)).toEqual({});
      expect(quarantinedLeftovers(s)).toEqual({});
      expect(fs.existsSync(path.join(s.config.dataDir, VAULT_LEFTOVER_DIR))).toBe(false);
      expect(mirror).not.toHaveBeenCalled();
      expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    });

    it("a note only the service holds and a note that differs are quarantined with their content, then the copy is deleted", async () => {
      const s = await leftover({
        ...(VAULT as Record<string, string>),
        "wiki/index.md": "# An index the repository does not have\n",
        "wiki/only-here.md": "only in the service\n",
        "notes/outside-the-vault.md": "not a vault path, deleted with the wiki all the same\n",
      });

      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true, leftover: { notes: 6, quarantined: 3 } });

      const saved = quarantinedLeftovers(s);
      const byNote = Object.fromEntries(Object.entries(saved).map(([file, content]) => [file.split("/").slice(2).join("/"), content]));
      expect(byNote).toEqual({
        "wiki/index.md": "# An index the repository does not have\n",
        "wiki/only-here.md": "only in the service\n",
        "notes/outside-the-vault.md": "not a vault path, deleted with the wiki all the same\n",
      });
      // One folder per owner and discard, under this boot's quarantine stamp.
      expect(new Set(Object.keys(saved).map((file) => file.split("/")[0]))).toEqual(new Set([s.ownerId]));
      expect(s.fake.dump(s.ownerId)).toEqual({});
      expect(s.fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: s.ownerId });
      // Nothing is left outside the quarantine, and the clone was not touched.
      expect(fs.existsSync(path.join(s.config.dataDir, VAULT_LEFTOVER_DIR))).toBe(false);
      const clone = knowledgeClonePath(s.ownerId, s.config);
      expect(git(clone, "status", "--porcelain")).toBe("");
      expect(fs.readFileSync(path.join(clone, "wiki/index.md"), "utf8")).toBe(VAULT["wiki/index.md"]);
    });

    it("a note that cannot be read: refused, nothing deleted", async () => {
      const s = await leftover({ ...(VAULT as Record<string, string>), "wiki/only-here.md": "only in the service\n" });
      const before = s.fake.dump(s.ownerId);
      s.fake.failNext(new MemoryUnavailableError("down", "timeout"), { op: "read" });

      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved });

      expect(s.fake.dump(s.ownerId)).toEqual(before);
      expect(s.fake.calls.some((call) => call.op === "deleteWiki" || call.op === "remove")).toBe(false);
      expect(quarantinedLeftovers(s)).toEqual({});

      // The listing failing is the same refusal.
      s.fake.failNext(new MemoryUnavailableError("down", "timeout"), { op: "list" });
      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved });
      expect(s.fake.dump(s.ownerId)).toEqual(before);
    });

    it("a note that cannot be put aside (the quarantine is not writable): refused, nothing deleted", async () => {
      const s = await leftover({ "wiki/only-here.md": "only in the service\n" });
      // A FILE where the quarantine root must be a folder.
      fs.writeFileSync(path.join(s.config.dataDir, "retired"), "in the way");
      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved });
      expect(s.fake.dump(s.ownerId)).toEqual({ "wiki/only-here.md": "only in the service\n" });
      expect(s.fake.calls.some((call) => call.op === "deleteWiki")).toBe(false);
    });

    it("an owner without a clone: every note is quarantined; a link in the clone is never read through", async () => {
      const s = setup();
      s.fake.seed(s.ownerId, "CLAUDE.md", "no clone to compare with\n");
      expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true, leftover: { notes: 1, quarantined: 1 } });
      expect(Object.values(quarantinedLeftovers(s))).toEqual(["no clone to compare with\n"]);

      // `wiki` in the clone is a link to a folder that holds the very same text: still not "in the repository".
      const other = addUser(s, "linked");
      const outside = path.join(getTempDir(), "outside");
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "a.md"), "same text\n");
      const clone = knowledgeClonePath(other, s.config);
      fs.mkdirSync(clone, { recursive: true });
      fs.symlinkSync(outside, path.join(clone, "wiki"));
      s.fake.seed(other, "wiki/a.md", "same text\n");
      expect(await rollbackVault(s.store, s.config, other)).toEqual({ ok: true, leftover: { notes: 1, quarantined: 1 } });
    });
  });

  it("a mirror that ends in sync WITH A NOTICE does not block it (the repository holds all the service has, and more)", async () => {
    const s = await migrated();
    mirror.mockImplementation(async (store, _config, userId) => {
      store.recordVaultMirror(userId, { ok: true, notice: "3 repository notes are not in the memory service" });
      return { kind: "synced", changed: 0, seq: 0 };
    });
    expect(await rollbackVault(s.store, s.config, s.ownerId, { expect: "memory" })).toEqual({ ok: true });
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
  });

  it("wiki notes OUTSIDE the vault paths (never mirrored) are quarantined before the wiki is deleted; vault notes are not", async () => {
    const s = await migrated();
    // A vault note the (stubbed) mirror never wrote into the clone: the verified mirror is what covers it.
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("wiki/after.md", "a vault note\n");
    s.fake.seed(s.ownerId, "notes/elsewhere.md", "not a vault path\n");
    s.fake.seed(s.ownerId, "top.md", "nor is this\n");

    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true, quarantined: 2 });

    const saved = quarantinedLeftovers(s);
    expect(Object.fromEntries(Object.entries(saved).map(([file, content]) => [file.split("/").slice(2).join("/"), content]))).toEqual({
      "notes/elsewhere.md": "not a vault path\n",
      "top.md": "nor is this\n",
    });
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
  });

  it("such a note that cannot be read blocks the rollback before anything changes", async () => {
    const s = await migrated();
    s.fake.seed(s.ownerId, "notes/elsewhere.md", "not a vault path\n");
    mirror.mockImplementation(async (store, _config, userId) => {
      store.recordVaultMirror(userId, { ok: true });
      s.fake.failNext(new MemoryUnavailableError("down", "timeout"), { op: "read" }); // the next read is the quarantine's
      return { kind: "synced", changed: 0, seq: 0 };
    });
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved });
    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({ ...VAULT, "notes/elsewhere.md": "not a vault path\n" });
    expect(s.fake.calls.some((call) => call.op === "deleteWiki")).toBe(false);
  });

  it("`expect`: nothing is done when the owner's home is not the one the caller acted on", async () => {
    const s = await migrated();
    // A stale screen offering "discard the leftover copy" for an owner who is in `memory` by now.
    expect(await rollbackVault(s.store, s.config, s.ownerId, { expect: "repo" })).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.homeMismatch });
    expect(mirror).not.toHaveBeenCalled();
    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);

    expect(await rollbackVault(s.store, s.config, s.ownerId, { expect: "memory" })).toEqual({ ok: true });
    // … and the reverse: a stale "roll back" for an owner who is on the repository, with a leftover copy.
    s.fake.seed(s.ownerId, "wiki/left.md", "left\n");
    s.fake.calls.length = 0;
    expect(await rollbackVault(s.store, s.config, s.ownerId, { expect: "memory" })).toEqual({ ok: false, reason: VAULT_ROLLBACK_REFUSAL.homeMismatch });
    expect(s.fake.calls).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual({ "wiki/left.md": "left\n" });
    expect(await rollbackVault(s.store, s.config, s.ownerId, { expect: "repo" })).toEqual({ ok: true, leftover: { notes: 1, quarantined: 1 } });
  });

  it("after a rollback the owner can be cut over again", async () => {
    const s = await migrated();
    await rollbackVault(s.store, s.config, s.ownerId);
    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });
});

// ---- The pass -------------------------------------------------------------------

describe("the migration pass", () => {
  it("cuts over every owner with a repository still on `repo`, only while the mode is `memory`", async () => {
    const s = setup();
    const second = { id: addUser(s, "second") };
    const none = { id: addUser(s, "none") };
    const done = { id: addUser(s, "done") };
    connect(s, s.ownerId, "one", VAULT);
    connect(s, second.id, "two", { "CLAUDE.md": "two\n" });
    connect(s, done.id, "three", { "CLAUDE.md": "three\n" });
    await cutoverVault(s.store, s.config, done.id);
    s.fake.calls.length = 0;

    expect(await runVaultMigrationPass(s.store, s.config)).toEqual([]);
    expect(s.fake.calls).toEqual([]);

    s.store.setPersonalVaultMode("memory");
    const reports = await runVaultMigrationPass(s.store, s.config);
    expect(reports.map((report) => [report.userId, report.state])).toEqual([
      [s.ownerId, "memory"],
      [second.id, "memory"],
    ]);
    expect(s.store.listPersonalVaults().map((row) => row.userId).sort()).toEqual([s.ownerId, second.id, done.id].sort());
    expect(s.store.getPersonalVault(none.id)).toBeNull();
    expect(s.fake.calls.some((call) => call.owner === none.id || (call.owner === done.id && call.op === "put"))).toBe(false);
  });

  it("setting the mode back to `repo` in the middle stops NEW cutovers and rolls nobody back", async () => {
    const s = setup();
    const second = { id: addUser(s, "second") };
    connect(s, s.ownerId, "one", VAULT);
    connect(s, second.id, "two", VAULT);
    s.store.setPersonalVaultMode("memory");
    mirror.mockImplementation(async (store, _config, userId) => {
      store.setPersonalVaultMode("repo"); // an admin, while the first owner is being moved
      store.recordVaultMirror(userId, { ok: true });
      return { kind: "synced", changed: 0, seq: 0 };
    });
    const reports = await runVaultMigrationPass(s.store, s.config);
    expect(reports.map((report) => report.userId)).toEqual([s.ownerId]);
    expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull();
    expect(s.store.getPersonalVault(second.id)).toBeNull();
  });

  it("one pass at a time: a second start while one runs is refused and joins it", async () => {
    const s = setup();
    connect(s, s.ownerId, "one", VAULT);
    s.store.setPersonalVaultMode("memory");
    expect(isVaultMigrationRunning(s.store)).toBe(false);

    expect(startVaultMigrationPass(s.store, s.config)).toBe(true);
    expect(isVaultMigrationRunning(s.store)).toBe(true);
    expect(startVaultMigrationPass(s.store, s.config)).toBe(false);
    const joined = await runVaultMigrationPass(s.store, s.config);
    expect(joined.map((report) => report.state)).toEqual(["memory"]);

    await whenVaultMigrationIdle(s.store);
    expect(isVaultMigrationRunning(s.store)).toBe(false);
    expect(s.fake.calls.filter((call) => call.op === "put")).toHaveLength(4);
    expect(startVaultMigrationPass(s.store, s.config)).toBe(true);
    await whenVaultMigrationIdle(s.store);
  });
});

// ---- A repository connected or changed -------------------------------------------

describe("onKnowledgeRepoChanged", () => {
  it("home `repo`: cuts the owner over in `memory` mode, does nothing in `repo` mode", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.calls).toEqual([]);

    s.store.setPersonalVaultMode("memory");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    expect(isVaultMigrationRunning(s.store)).toBe(true);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toMatchObject({ state: "memory", notes: 4 });
  });

  it("a repository connected in the middle of a run (create_repo): the cutover is retried once the run is over", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setPersonalVaultMode("memory");
    setVaultCutoverRetryForTests({ delayMs: 25 });
    s.store.touchConversation(s.ownerId, "c-create", s.ownerId, "hi");
    openRun("run-create", s.ownerId, { conversationId: "c-create", avatarId: s.ownerId });
    try {
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
      await whenVaultMigrationIdle(s.store);
      expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
      expect(codes(lastVaultMigrationReport(s.store, s.ownerId)!.blockers)).toEqual([VAULT_BLOCKER.runInProgress]);
      // Still refused on the retries made while the run goes on.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await whenVaultMigrationIdle(s.store);
      expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
      expect(writes(s.fake)).toEqual([]);
    } finally {
      closeRun("run-create");
    }
    await vi.waitFor(() => expect(s.store.getPersonalVault(s.ownerId)).not.toBeNull(), { timeout: 20_000, interval: 25 });
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);

    // Any other blocker is left to the next pass: no retry is scheduled.
    const other = addUser(s, "dirty");
    connect(s, other, "dirty", { ...VAULT, "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES + 1) });
    s.fake.calls.length = 0;
    onKnowledgeRepoChanged(s.store, s.config, other, null);
    await whenVaultMigrationIdle(s.store);
    const lists = s.fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await whenVaultMigrationIdle(s.store);
    expect(s.fake.calls.length).toBe(lists);
    expect(s.store.getPersonalVault(other)).toBeNull();
  });

  it("a repository disconnected, or a server without the service, starts nothing", async () => {
    const s = setup({ fake: null });
    s.store.setPersonalVaultMode("memory");
    connect(s, s.ownerId, "brain", VAULT);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    expect(isVaultMigrationRunning(s.store)).toBe(false);
    s.store.setKnowledgeRepo(s.ownerId, null, null);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, "x/y");
    expect(isVaultMigrationRunning(s.store)).toBe(false);
  });

  async function migrated() {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    s.store.setPersonalVaultMode("memory");
    await cutoverVault(s.store, s.config, s.ownerId);
    mirror.mockClear();
    s.fake.calls.length = 0;
    return { ...s, first };
  }

  it("CONFIRM: the new repository holds vault notes and the wiki is not empty — nothing is imported, the mirror waits for the owner's press", async () => {
    const s = await migrated();
    const second = connect(s, s.ownerId, "second", { "CLAUDE.md": "another memory\n", "wiki/theirs.md": "theirs\n" });

    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    // On hold at once (`checking`: nobody has looked yet), before anything could mirror into the new repository.
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
    await whenVaultMigrationIdle(s.store);

    // Looked at: the repository has vault notes of its own → the owner is asked.
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm", sourceRepo: s.first });
    expect(writes(s.fake)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(mirror).not.toHaveBeenCalled();
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(git(clone, "remote", "get-url", "origin")).toBe(second);
    expect(fs.readFileSync(path.join(clone, "wiki/theirs.md"), "utf8")).toBe("theirs\n");
  });

  it("IMPORT: the wiki is empty — the new repository's vault is imported as in a cutover", async () => {
    const s = await migrated();
    for (const notePath of Object.keys(s.fake.dump(s.ownerId))) await memoryVaultFor(s.store, s.config, s.ownerId)!.remove(notePath);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    const second = connect(s, s.ownerId, "second", { "CLAUDE.md": "another memory\n", "wiki/theirs.md": "theirs\n", "wiki/pic.png": Buffer.from([1]) });

    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);

    expect(s.fake.dump(s.ownerId)).toEqual({ "CLAUDE.md": "another memory\n", "wiki/theirs.md": "theirs\n" });
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, sourceRepo: second, sourceCommit: git(clone, "rev-parse", "HEAD") });
    expect(mirror).toHaveBeenCalledWith(s.store, s.config, s.ownerId, { push: true, locked: true });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toMatchObject({ state: "memory", repo: second, notes: 2, blockers: [] });
  });

  it("IMPORT blocked (a note the service cannot store): it stays `checking`, nothing is imported, the pass retries it", async () => {
    const s = await migrated();
    for (const notePath of Object.keys(s.fake.dump(s.ownerId))) await memoryVaultFor(s.store, s.config, s.ownerId)!.remove(notePath);
    connect(s, s.ownerId, "second", { "CLAUDE.md": "another memory\n", "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES + 1) });

    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking", sourceRepo: s.first });
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(codes(lastVaultMigrationReport(s.store, s.ownerId)!.blockers)).toEqual([VAULT_BLOCKER.tooLarge]);

    pushMore("second", {}, ["wiki/big.md"]);
    expect(await runVaultMigrationPass(s.store, s.config)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    expect(s.fake.dump(s.ownerId)).toEqual({ "CLAUDE.md": "another memory\n" });
  });

  it("CONTINUE: the new repository holds no vault note — the mirror simply continues into it", async () => {
    const s = await migrated();
    connect(s, s.ownerId, "second", { "skills/x/SKILL.md": "---\nname: x\n---\n", "wiki/.gitkeep": "", "wiki/pic.png": Buffer.from([1]) });

    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
    await whenVaultMigrationIdle(s.store);

    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    expect(writes(s.fake)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });

  it("CONTINUE: a repository whose vault notes are all in the service already (reconnected) needs no press", async () => {
    const s = await migrated();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("wiki/newer.md", "only in the service\n");
    s.store.recordVaultMirror(s.ownerId, { ok: true });
    connect(s, s.ownerId, "copy", VAULT);

    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });

    // One note of the repository differs from the service: the mirror would replace it → the owner is asked.
    connect(s, s.ownerId, "differs", { ...VAULT, "wiki/index.md": "# Edited in git\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(s.fake.dump(s.ownerId)["wiki/index.md"]).toBe(VAULT["wiki/index.md"]);

    // The owner confirms, then connects yet another repository before the mirror ran: that confirmation
    // was about the repository it was pressed for — the new one is looked at, and asked about, on its own.
    const differs = s.store.getKnowledgeRepo(s.ownerId).repo!;
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: differs, branch: "main" })).toEqual({ ok: true, removes: 0 });
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    connect(s, s.ownerId, "third", { "wiki/theirs.md": "theirs\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
  });

  it("a new repository that cannot be looked at stays `checking` (never `confirm`), and is looked at again", async () => {
    const s = await migrated();
    s.store.setGitToken(s.ownerId, null);
    s.store.setKnowledgeRepo(s.ownerId, "owner/unreachable", "main"); // no token: nothing is fetched
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(writes(s.fake)).toEqual([]);

    s.store.setGitToken(s.ownerId, "test-token");
    s.fake.failNext(new MemoryUnavailableError("down", "network"));
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    setVaultCutoverRetryForTests({ delayMs: 25 });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, "owner/unreachable");
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    // The service is back: the retry settles it without anyone pressing anything.
    await vi.waitFor(() => expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" }), { timeout: 20_000, interval: 25 });
  });
});

// ---- What was decided before a wait is asked again -------------------------------

describe("cutover: what it decided before it waited is asked again inside the locks", () => {
  const B: Files = { "CLAUDE.md": "# B's standing memory\n", "wiki/b-only.md": "only in B\n" };

  it("a run that starts while the cutover waits for the clone is seen", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    const lock = holdCloneLock(s);
    const cut = cutoverVault(s.store, s.config, s.ownerId);
    await tick(); // past its first checks, waiting for the clone
    s.store.touchConversation(s.ownerId, "c-late", s.ownerId, "hi");
    openRun("run-late", s.ownerId, { conversationId: "c-late", avatarId: s.ownerId });
    try {
      await lock.release();
      const report = await cut;
      expect(report.blockers).toEqual(["run_in_progress: a run is in progress for this owner"]);
      expect(report.state).toBe("repo");
      expect(s.fake.calls).toEqual([]);
      expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    } finally {
      closeRun("run-late");
    }
  });

  it("the owner connects another repository while the cutover waits: nothing is imported from the old one, and the new one is moved on its own", async () => {
    const s = setup();
    s.store.setPersonalVaultMode("memory");
    const remoteA = connect(s, s.ownerId, "a", VAULT);
    const remoteB = seedRemote("b", B);
    const lock = holdCloneLock(s);
    const cut = cutoverVault(s.store, s.config, s.ownerId); // the admin's pass, reading repository A
    await tick();
    // PUT /api/me/knowledge-repo: the owner connects B.
    s.store.setKnowledgeRepo(s.ownerId, remoteB, "main");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, remoteA);
    await lock.release();

    const report = await cut;
    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.repoChanged]);

    await whenVaultMigrationIdle(s.store);
    // The change's own follow-up moved the owner — from B. Nothing of A ever reached the service.
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ sourceRepo: remoteB, mirrorHold: null });
    expect(s.fake.dump(s.ownerId)).toEqual(B);
    expect(s.fake.calls.filter((call) => call.op === "put").map((call) => call.path).sort()).toEqual(Object.keys(B).sort());
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(git(clone, "remote", "get-url", "origin")).toBe(remoteB);
    expect(fs.readFileSync(path.join(clone, "wiki/b-only.md"), "utf8")).toBe("only in B\n");
  });

  it.each([
    ["another repository", (s: ReturnType<typeof setup>, other: string) => s.store.setKnowledgeRepo(s.ownerId, other, "main")],
    ["another branch of the same repository", (s: ReturnType<typeof setup>) => s.store.setKnowledgeRepo(s.ownerId, s.store.getKnowledgeRepo(s.ownerId).repo, "other")],
  ])("%s connected DURING the import: no flip, and what was imported is taken back", async (_what, change) => {
    const s = setup();
    connect(s, s.ownerId, "a", VAULT);
    const remoteB = seedRemote("b", B);
    s.fake.beforeNext("put", () => {
      change(s, remoteB);
    });

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(report.state).toBe("repo");
    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.repoChanged]);
    expect(s.fake.calls.filter((call) => call.op === "put")).toHaveLength(4); // the import itself went through
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(mirror).not.toHaveBeenCalled();
  });

  it("the user is deleted during the import: no row comes back, and the wiki is left empty", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.beforeNext("put", () => {
      s.store.deleteUser(s.ownerId);
    });

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(codes(report.blockers)).toEqual([VAULT_BLOCKER.noUser]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.store.listPersonalVaults()).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(mirror).not.toHaveBeenCalled();
  });

  it("a source file that changed between the scan and its import is not imported (source_changed)", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    // The service is listed after the clone was scanned and before the first note is sent.
    s.fake.beforeNext("list", () => fs.writeFileSync(path.join(clone, "wiki/index.md"), "# changed under the import\n"));

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(report.blockers).toEqual(["source_changed: wiki/index.md changed while it was being imported"]);
    expect(report.state).toBe("repo");
    expect(s.fake.calls.filter((call) => call.op === "put").map((call) => call.path)).not.toContain("wiki/index.md");
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
  });

  it("a clone that still belongs to another repository after the sync is refused", async () => {
    const s = setup();
    connect(s, s.ownerId, "a", VAULT);
    await planVaultMigration(s.store, s.config, s.ownerId); // the clone of A is on disk
    s.store.setKnowledgeRepo(s.ownerId, seedRemote("b", B), "main");
    cloneSync.skipNext = true; // the sync "worked" without re-pointing the clone

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(report.blockers).toContain("sync_failed: the clone belongs to another repository (the connected repository just changed)");
    expect(report.state).toBe("repo");
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("a clone the sync could not bring up to its remote (behind) is refused", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", { ...VAULT, ".mcp.json": '{"mcpServers":{}}\n' });
    await planVaultMigration(s.store, s.config, s.ownerId);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    // Noah's own load-time edit of a tracked .mcp.json (not the owner's work, so not "dirty") …
    fs.writeFileSync(path.join(clone, ".mcp.json"), '{"mcpServers":{"runtime":{}}}\n');
    // … and a push from elsewhere that touches the same file: git refuses to move the clone forward over it.
    pushMore("brain", { ".mcp.json": '{"mcpServers":{"remote":{}}}\n', "wiki/pushed.md": "pushed from elsewhere\n" });

    const report = await cutoverVault(s.store, s.config, s.ownerId);

    expect(report.blockers).toEqual(["sync_failed: the clone is behind its remote and could not be fast-forwarded"]);
    expect(report.state).toBe("repo");
    expect(writes(s.fake)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });
});

describe("cutover holds the owner's vault write queue", () => {
  it("a tool write that arrives during the cutover waits, then lands in the new home — it is not lost in the clone", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    const clone = knowledgeClonePath(s.ownerId, s.config);
    const lock = holdCloneLock(s);
    const cut = cutoverVault(s.store, s.config, s.ownerId);
    await tick();
    // What every vault-changing tool call does (repoTools: withVaultWrite) — here from a teammate's run on a
    // shared account, which is not "a run of the owner" and was never what made this safe.
    const write = withVaultWrite(s.store, s.config, s.ownerId, async (target) => {
      if (target.home === "memory") await target.vault.write("wiki/during.md", "written during the cutover\n");
      else fs.writeFileSync(path.join(clone, "wiki/during.md"), "written during the cutover\n");
      return target.home;
    });
    await tick();
    await lock.release();

    expect(await cut).toMatchObject({ state: "memory", notes: 4, blockers: [] });
    expect(await write).toBe("memory");
    expect(s.fake.dump(s.ownerId)).toEqual({ ...VAULT, "wiki/during.md": "written during the cutover\n" });
    expect(fs.existsSync(path.join(clone, "wiki/during.md"))).toBe(false);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorDirty: true });
  });

  it("a run in progress: on a shared account a teammate's chat with the avatar counts, otherwise it does not", () => {
    const s = setup();
    const mate = addUser(s, "mate");
    s.store.touchConversation(mate, "c-mate", s.ownerId, "hi");
    openRun("run-mate", mate, { conversationId: "c-mate", avatarId: s.ownerId });
    try {
      expect(ownerRunInProgress(s.store, s.ownerId)).toBe(false);
      s.store.updateProfile(s.ownerId, { sharedAccount: true });
      expect(ownerRunInProgress(s.store, s.ownerId)).toBe(true);
      expect(ownerRunInProgress(s.store, mate)).toBe(false);
    } finally {
      closeRun("run-mate");
    }
    expect(ownerRunInProgress(s.store, s.ownerId)).toBe(false);
  });
});

describe("a repository change for an owner in `memory`: the import into an empty wiki has the cutover's blockers", () => {
  /** A migrated owner whose wiki was emptied; the clone of their repository is on disk. */
  async function emptied() {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    s.store.setPersonalVaultMode("memory");
    await cutoverVault(s.store, s.config, s.ownerId);
    for (const notePath of Object.keys(s.fake.dump(s.ownerId))) await memoryVaultFor(s.store, s.config, s.ownerId)!.remove(notePath);
    mirror.mockClear();
    s.fake.calls.length = 0;
    return { ...s, first, clone: knowledgeClonePath(s.ownerId, s.config) };
  }

  /** The same repository connected again (its clone is kept): the check runs, and must not import. */
  async function expectNotImported(s: Awaited<ReturnType<typeof emptied>>, code: string) {
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(codes(lastVaultMigrationReport(s.store, s.ownerId)!.blockers)).toEqual([code]);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(writes(s.fake)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(mirror).not.toHaveBeenCalled();
  }

  it("a dirty clone", async () => {
    const s = await emptied();
    fs.writeFileSync(path.join(s.clone, "unfinished.txt"), "someone's work\n");
    await expectNotImported(s, VAULT_BLOCKER.uncommitted);
  });

  it("a clone with unpushed commits", async () => {
    const s = await emptied();
    fs.writeFileSync(path.join(s.clone, "local.txt"), "local only\n");
    git(s.clone, "add", "-A");
    git(s.clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "local");
    await expectNotImported(s, VAULT_BLOCKER.unpushed);
  });

  it("a run of the owner in progress", async () => {
    const s = await emptied();
    s.store.touchConversation(s.ownerId, "c-own", s.ownerId, "hi");
    openRun("run-own", s.ownerId, { conversationId: "c-own", avatarId: s.ownerId });
    try {
      await expectNotImported(s, VAULT_BLOCKER.runInProgress);
    } finally {
      closeRun("run-own");
    }
  });

  it("the backup gate refusing", async () => {
    const s = await emptied();
    vi.spyOn(s.store, "retirementGate").mockReturnValue({ allowed: false, stamp: "x", backupPath: null });
    await expectNotImported(s, VAULT_BLOCKER.backupFailed);
  });

  it("without any of them it imports — the control for the four above", async () => {
    const s = await emptied();
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
  });

  it("yet another repository connected during that import: nothing stays imported, the provenance is not touched", async () => {
    const s = await emptied();
    const third = seedRemote("third", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    s.fake.beforeNext("put", () => {
      s.store.setKnowledgeRepo(s.ownerId, third, "main");
    });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(codes(lastVaultMigrationReport(s.store, s.ownerId)!.blockers)).toEqual([VAULT_BLOCKER.repoChanged]);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking", sourceRepo: s.first });
    expect(mirror).not.toHaveBeenCalled();
  });

  it("a check that waited while the owner connected yet another repository settles nothing about the old one", async () => {
    const s = await emptied();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("CLAUDE.md", "memory in the service\n");
    const withVault = connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    const lock = holdCloneLock(s);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first); // would end in `confirm` for `second`
    await tick();
    const plain = seedRemote("plain", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    s.store.setKnowledgeRepo(s.ownerId, plain, "main");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, withVault); // nothing to replace there → lifted
    s.fake.calls.length = 0;
    await lock.release();
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    expect(git(s.clone, "remote", "get-url", "origin")).toBe(plain);
    // The outdated check stopped at once: it never cloned `second` again or asked the service about it.
    expect(s.fake.calls).toEqual([]);
  });

  it("a look that would LIFT the hold does not, when the owner connected a repository with vault notes meanwhile", async () => {
    const s = await emptied();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("CLAUDE.md", "memory in the service\n");
    connect(s, s.ownerId, "plain", { "skills/x/SKILL.md": "---\nname: x\n---\n" }); // nothing to replace → would lift
    const theirs = seedRemote("theirs", { "wiki/theirs.md": "theirs\n" });
    cloneSync.afterNext = () => {
      // Right after the look synced `plain`: the owner connects a repository that has vault notes of its own.
      s.store.setKnowledgeRepo(s.ownerId, theirs, "main");
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    };
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    // Lifting for `plain` would have let the mirror write into `theirs` unasked — and skipped its own look.
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(git(s.clone, "remote", "get-url", "origin")).toBe(theirs);
  });

  it("a look that would ask the owner (`confirm`) does not, when they connected a repository without vault notes meanwhile", async () => {
    const s = await emptied();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("CLAUDE.md", "memory in the service\n");
    connect(s, s.ownerId, "theirs", { "wiki/theirs.md": "theirs\n" }); // would end in `confirm`
    const plain = seedRemote("plain", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    s.fake.beforeNext("list", () => {
      // While the look compares `theirs` with the service: the owner connects `plain`.
      s.store.setKnowledgeRepo(s.ownerId, plain, "main");
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    // A `confirm` left over from `theirs` would ask about a repository that has nothing to replace.
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
  });

  it("a second look queued for the same change does not put back a hold the owner has confirmed", async () => {
    const s = await emptied();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("CLAUDE.md", "memory in the service\n");
    connect(s, s.ownerId, "theirs", { "wiki/theirs.md": "theirs\n" });
    // The owner presses 확인 the moment the first look asks them (how `confirmVaultMirrorHold` leaves the row).
    const setHold = s.store.setVaultMirrorHold.bind(s.store);
    const spy = vi.spyOn(s.store, "setVaultMirrorHold");
    spy.mockImplementation((userId, state) => {
      setHold(userId, state);
      if (state !== "confirm") return;
      spy.mockRestore();
      s.store.setVaultMirrorHold(userId, null);
      s.store.markVaultMirrorDirty(userId);
    });
    // Two looks are queued for one change (the route and a 다시 확인 press, say).
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    expect(recheckVaultMirrorHold(s.store, s.config, s.ownerId)).toBe(true);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
  });
});

// ---- The look after a repository change: what it judges, what it leaves behind, how long it tries ----

describe("the look judges the tree of the connected branch — never the one the clone is stuck on", () => {
  /** An owner in `memory` (moved from `main`); the remote also has `dev`, where a vault note and a skill differ. */
  async function onMain() {
    const s = setup();
    const repo = connect(s, s.ownerId, "brain", { ...VAULT, "skills/x/SKILL.md": "main version\n" });
    await cutoverVault(s.store, s.config, s.ownerId);
    pushBranch("brain", "dev", { "wiki/index.md": "# Dev index\n", "skills/x/SKILL.md": "dev version\n" });
    mirror.mockClear();
    s.fake.calls.length = 0;
    return { ...s, repo, clone: knowledgeClonePath(s.ownerId, s.config) };
  }
  const branchOf = (clone: string) => git(clone, "rev-parse", "--abbrev-ref", "HEAD");

  it("only the BRANCH changes and an uncommitted edit keeps git from switching: the hold stays `checking` (main's vault is not dev's)", async () => {
    const s = await onMain();
    // The avatar's unfinished edit of a file that differs between the two branches: `git checkout` is refused.
    fs.writeFileSync(path.join(s.clone, "skills/x/SKILL.md"), "edited, not committed\n");
    s.store.setKnowledgeRepo(s.ownerId, s.repo, "dev");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    await whenVaultMigrationIdle(s.store);

    // The clone still shows main — whose vault equals the service. Judging THAT would lift the hold, and the
    // mirror would then replace dev's own `wiki/index.md` without anyone having been asked.
    expect(branchOf(s.clone)).toBe("main");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    const report = lastVaultMigrationReport(s.store, s.ownerId);
    expect(report).toMatchObject({ userId: s.ownerId, repo: s.repo, state: "memory", notes: 0, sourceCommit: null });
    expect(report!.blockers).toHaveLength(1);
    expect(report!.blockers[0]).toMatch(/^sync_failed: the server's copy of the repository does not hold the newest commits of dev\b/);
    expect(writes(s.fake)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(mirror).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(s.clone, "skills/x/SKILL.md"), "utf8")).toBe("edited, not committed\n");

    // The edit is out of the way: the next look sees dev, finds its differing note and asks the owner.
    git(s.clone, "checkout", "--", "skills/x/SKILL.md");
    expect(recheckVaultMirrorHold(s.store, s.config, s.ownerId)).toBe(true);
    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("dev");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toBeNull();
  });

  it("the control — without the uncommitted edit the clone switches, and dev's differing vault note ends in `confirm`", async () => {
    const s = await onMain();
    const before = lastVaultMigrationReport(s.store, s.ownerId);
    expect(before).toMatchObject({ state: "memory", blockers: [] }); // the cutover's report
    s.store.setKnowledgeRepo(s.ownerId, s.repo, "dev");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("dev");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    // The look happened. Only a report that said a look could NOT happen is dropped: a clean one stays.
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(before);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
  });

  it("uncommitted changes that are not in the way, and a branch the remote does not have yet, do not keep the hold", async () => {
    const s = await onMain();
    pushBranch("brain", "same", { "README.md": "# another readme\n" }); // main's vault, untouched
    fs.writeFileSync(path.join(s.clone, "unfinished.txt"), "someone's work\n"); // dirty, but git can still switch
    s.store.setKnowledgeRepo(s.ownerId, s.repo, "same");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("same");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });

    // A branch that exists nowhere yet: there is nothing on it a copy could replace.
    s.store.setKnowledgeRepo(s.ownerId, s.repo, "not-yet");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    expect(lastVaultMigrationReport(s.store, s.ownerId)?.blockers ?? []).toEqual([]);
  });

  it("a repository without any commit yet passes — also with uncommitted files in its clone", async () => {
    const s = await onMain();
    const empty = makeBareRemote(path.join(getTempDir(), "remotes", "empty.git"));
    s.store.setKnowledgeRepo(s.ownerId, empty, null);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });

    // The clone has no HEAD, and now something uncommitted in it: still nothing a copy could replace.
    fs.writeFileSync(path.join(s.clone, "unfinished.txt"), "someone's work\n");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, empty);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    expect(lastVaultMigrationReport(s.store, s.ownerId)?.blockers ?? []).toEqual([]);
  });

  it("a clone that is still another repository's after the sync is not judged either", async () => {
    const s = await onMain();
    // The service's vault equals the clone on disk (repository `brain`); the owner connects one whose vault differs.
    const other = seedRemote("other", { "CLAUDE.md": "another memory\n", "wiki/theirs.md": "theirs\n" });
    s.store.setKnowledgeRepo(s.ownerId, other, "main");
    cloneSync.skipNext = true; // the sync "worked" without re-pointing the clone
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)!.blockers).toEqual([
      "sync_failed: the clone belongs to another repository (the connected repository just changed)",
    ]);
    expect(writes(s.fake)).toEqual([]);
  });
});

describe("a look that could not happen is remembered as the owner's report, until one can", () => {
  async function migrated() {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    mirror.mockClear();
    s.fake.calls.length = 0;
    return { ...s, first };
  }

  it.each([
    ["ends in `confirm`", { "wiki/theirs.md": "theirs\n" } as Files, "confirm" as const],
    ["lifts the hold", { "skills/x/SKILL.md": "---\nname: x\n---\n" } as Files, null],
  ])("no git token: `checking`, and the report names it; the look that then %s drops that report", async (_what, files, hold) => {
    const s = await migrated();
    s.store.setGitToken(s.ownerId, null);
    const second = connect(s, s.ownerId, "second", files);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);

    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual({
      userId: s.ownerId,
      repo: second,
      sourceCommit: null,
      notes: 0,
      bytes: 0,
      skipped: [],
      blockers: ["no_git_token: no git token is set, so the repository cannot be synced or mirrored"],
      state: "memory",
    });
    expect(s.fake.calls).toEqual([]);

    // The owner stores a token; the look runs.
    s.store.setGitToken(s.ownerId, "test-token");
    expect(recheckVaultMirrorHold(s.store, s.config, s.ownerId)).toBe(true);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: hold });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toBeNull();
  });

  it("a repository that cannot be reached is named the same way", async () => {
    const s = await migrated();
    const gone = path.join(getTempDir(), "remotes", "gone.git");
    s.store.setKnowledgeRepo(s.ownerId, gone, "main");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    const report = lastVaultMigrationReport(s.store, s.ownerId)!;
    expect(report).toMatchObject({ repo: gone, state: "memory" });
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatch(/^sync_failed: could not fetch the repository \(/);
  });

  it.each([
    ["does not answer", () => new MemoryUnavailableError("down", "timeout"), "memory_unavailable: the memory service could not be used (timeout)"],
    ["refuses", () => new MemoryRefusedError("invalid_owner", 400, "no"), "refused: the service refused the request (code: invalid_owner)"],
  ])("the memory service %s in the middle of the look: `checking`, the report names it; once it answers the look settles and the report is gone", async (_what, failure, named) => {
    const s = await migrated();
    const second = connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    s.fake.failNext(failure(), { op: "list" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);

    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual({
      userId: s.ownerId,
      repo: second,
      sourceCommit: null,
      notes: 0,
      bytes: 0,
      skipped: [],
      blockers: [named],
      state: "memory",
    });

    // It answers again (the next look comes by itself; here it is asked for).
    expect(recheckVaultMirrorHold(s.store, s.config, s.ownerId)).toBe(true);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toBeNull();
  });

  it("a look that fails for any other reason is in the log only — and is still retried", async () => {
    const s = await migrated();
    const before = lastVaultMigrationReport(s.store, s.ownerId);
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    let looks = 0;
    const list = s.fake.list.bind(s.fake);
    s.fake.list = (owner, prefix) => {
      looks += 1;
      return looks <= 2 ? Promise.reject(new Error("something unexpected")) : list(owner, prefix);
    };
    setVaultCutoverRetryForTests({ delayMs: 20, attempts: 5, slowDelayMs: 20 });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(looks).toBe(1);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(before);
    // The failure did not end the retries: the third look gets through.
    await vi.waitFor(() => expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" }), { timeout: 20_000, interval: 20 });
    expect(looks).toBeGreaterThanOrEqual(3);
  });

  it("a service failure of a look whose repository is gone, or whose hold was settled meanwhile, is not remembered", async () => {
    const s = await migrated();
    const before = lastVaultMigrationReport(s.store, s.ownerId);
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    const list = s.fake.list.bind(s.fake);
    // The owner disconnects the repository while the look asks the service, which then does not answer.
    s.fake.list = () => {
      s.store.setKnowledgeRepo(s.ownerId, null, null);
      return Promise.reject(new MemoryUnavailableError("down", "network"));
    };
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(before);

    // The hold is no longer `checking` when the failing look ends (settled some other way meanwhile).
    connect(s, s.ownerId, "third", { "wiki/theirs.md": "theirs\n" });
    s.fake.list = () => {
      s.store.setVaultMirrorHold(s.ownerId, null);
      return Promise.reject(new MemoryUnavailableError("down", "network"));
    };
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(before);
    s.fake.list = list;
  });

  it("a look that is merely OUTDATED (the owner disconnected the repository meanwhile) is not remembered", async () => {
    const s = await migrated();
    const before = lastVaultMigrationReport(s.store, s.ownerId);
    expect(before).toMatchObject({ state: "memory", blockers: [] }); // the cutover's report
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    s.fake.beforeNext("list", () => {
      // While the look compares the repository with the service: the owner disconnects it. No new look follows.
      s.store.setKnowledgeRepo(s.ownerId, null, null);
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
    });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(before);
  });
});

describe("the look is retried for as long as the hold is `checking`", () => {
  /** An owner in `memory` whose newly connected repository holds a vault note of its own; the service can be taken down. */
  async function held() {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    const service = { down: true, looks: 0 };
    const list = s.fake.list.bind(s.fake);
    s.fake.list = (owner, prefix) => {
      if (!service.down) return list(owner, prefix);
      service.looks += 1; // every look asks the service once
      return Promise.reject(new MemoryUnavailableError("down", "network"));
    };
    return { ...s, first, service };
  }

  it("past `attempts` it goes on, and ends the hold once the obstacle is gone — no recheck, no pass", async () => {
    const s = await held();
    setVaultCutoverRetryForTests({ delayMs: 20, attempts: 2, slowDelayMs: 20 });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    // The first look and the one retry `attempts` allows … and then it still goes on.
    await vi.waitFor(() => expect(s.service.looks).toBeGreaterThanOrEqual(4), { timeout: 20_000, interval: 20 });
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });

    s.service.down = false;
    await vi.waitFor(() => expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" }), { timeout: 20_000, interval: 20 });
    // Settled: nothing is retried any more.
    await whenVaultMigrationIdle(s.store);
    const settled = s.fake.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await whenVaultMigrationIdle(s.store);
    expect(s.fake.calls.length).toBe(settled);
  });

  it("the first `attempts` looks come every `delayMs`, the later ones every `slowDelayMs`", async () => {
    const s = await held();
    // Only the FIRST look is "fast"; were the later ones also waiting `delayMs`, none would come within this test.
    setVaultCutoverRetryForTests({ delayMs: 600_000, attempts: 1, slowDelayMs: 20 });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.first);
    await vi.waitFor(() => expect(s.service.looks).toBeGreaterThanOrEqual(3), { timeout: 20_000, interval: 20 });

    // … and the other way round: with attempts left, a look waits `delayMs`, not `slowDelayMs`.
    const t = await held2();
    setVaultCutoverRetryForTests({ delayMs: 600_000, attempts: 5, slowDelayMs: 20 });
    onKnowledgeRepoChanged(t.store, t.config, t.ownerId, t.first);
    await whenVaultMigrationIdle(t.store);
    expect(t.service.looks).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await whenVaultMigrationIdle(t.store);
    expect(t.service.looks).toBe(1);

    async function held2() {
      // A second app instance, in its own data folder.
      const services = createServices({ dataDir: path.join(getTempDir(), "data-2"), agentRuntime: "local", sessionSecret: "t" });
      booted.push(services);
      const fake = createFakeMemoryClient();
      setMemoryClientForTests(services.store, fake);
      const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      services.store.setGitToken(owner.id, "test-token");
      const u = { store: services.store, config: services.config, fake, ownerId: owner.id };
      const first = connect(u, u.ownerId, "first-2", VAULT);
      await cutoverVault(u.store, u.config, u.ownerId);
      connect(u, u.ownerId, "second-2", { "wiki/theirs.md": "theirs\n" });
      const service = { looks: 0 };
      u.fake.list = () => {
        service.looks += 1;
        return Promise.reject(new MemoryUnavailableError("down", "network"));
      };
      return { ...u, first, service };
    }
  });

  it("a cutover that waits for a run is still tried a bounded number of times", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setPersonalVaultMode("memory");
    setVaultCutoverRetryForTests({ delayMs: 15, attempts: 2, slowDelayMs: 15 });
    const gate = vi.spyOn(s.store, "retirementGate"); // asked once per cutover attempt, before the run check
    s.store.touchConversation(s.ownerId, "c-long", s.ownerId, "hi");
    openRun("run-long", s.ownerId, { conversationId: "c-long", avatarId: s.ownerId });
    try {
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, null);
      await vi.waitFor(() => expect(gate).toHaveBeenCalledTimes(2), { timeout: 20_000, interval: 15 });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await whenVaultMigrationIdle(s.store);
      expect(gate).toHaveBeenCalledTimes(2);
    } finally {
      closeRun("run-long");
    }
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });
});

describe("resumeVaultMirrorChecks: holds left at `checking` by an earlier process are looked at again", () => {
  it("every `checking` row gets its look and the hold ends; a row in another state is not touched", async () => {
    const s = setup();
    const plain = addUser(s, "plain"); // repository without vault notes → the hold is lifted
    const asked = addUser(s, "asked"); // repository with vault notes of its own → `confirm`
    const waiting = addUser(s, "waiting"); // already `confirm`: the owner's turn, not a look's
    const settled = addUser(s, "settled"); // no hold
    const repos: Record<string, Files> = {
      [s.ownerId]: { "skills/x/SKILL.md": "---\nname: x\n---\n" },
      [plain]: { "skills/x/SKILL.md": "---\nname: x\n---\n" },
      [asked]: { "wiki/theirs.md": "theirs\n" },
      [waiting]: { "wiki/theirs.md": "theirs\n" },
      [settled]: { "wiki/theirs.md": "theirs\n" },
    };
    // What a restart finds: rows in the database, no timer and no queue in this process.
    for (const [userId, files] of Object.entries(repos)) {
      const remote = connect(s, userId, `repo-${userId}`, files);
      s.store.setPersonalVaultMemory(userId, { sourceRepo: remote, sourceCommit: null });
      s.fake.seed(userId, "CLAUDE.md", "memory in the service\n");
    }
    for (const userId of [s.ownerId, plain, asked]) s.store.setVaultMirrorHold(userId, "checking");
    s.store.setVaultMirrorHold(waiting, "confirm");
    expect(isVaultMigrationRunning(s.store)).toBe(false);

    expect(resumeVaultMirrorChecks(s.store, s.config)).toBe(3);
    await whenVaultMigrationIdle(s.store);

    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    expect(s.store.getPersonalVault(plain)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    expect(s.store.getPersonalVault(asked)).toMatchObject({ mirrorHold: "confirm" });
    // Not `checking`: not looked at — not even cloned.
    expect(s.store.getPersonalVault(waiting)).toMatchObject({ mirrorHold: "confirm", mirrorDirty: false });
    expect(s.store.getPersonalVault(settled)).toMatchObject({ mirrorHold: null, mirrorDirty: false });
    expect(fs.existsSync(knowledgeClonePath(waiting, s.config))).toBe(false);
    expect(fs.existsSync(knowledgeClonePath(settled, s.config))).toBe(false);
    expect(s.fake.calls.some((call) => call.owner === waiting || call.owner === settled)).toBe(false);

    // Nothing is left to resume.
    expect(resumeVaultMirrorChecks(s.store, s.config)).toBe(0);
  });

  it("a hold that already has its retry pending in this process is not started twice", async () => {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    s.store.setGitToken(s.ownerId, null); // the look cannot happen; its retry is pending (a minute from now)
    connect(s, s.ownerId, "second", { "wiki/theirs.md": "theirs\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });

    expect(resumeVaultMirrorChecks(s.store, s.config)).toBe(0);
    expect(isVaultMigrationRunning(s.store)).toBe(false);
  });
});

// ---- The owner's confirmation ---------------------------------------------------------

describe("confirmVaultMirrorHold: the press covers the repository as it is at the press", () => {
  // Repository B: two vault notes of its own, two at paths the service also holds (with other text), and files
  // that are not vault notes at all.
  const B: Files = {
    "CLAUDE.md": "# B's own standing memory\n",
    "wiki/index.md": "# B's index\n",
    "wiki/b-only.md": "only in B\n",
    "raw/b-capture.md": "captured in B\n",
    "wiki/pic.png": Buffer.from([1, 2, 3]),
    "skills/x/SKILL.md": "---\nname: x\n---\n",
  };
  const B_ONLY = ["raw/b-capture.md", "wiki/b-only.md"];

  /** An owner in `memory` (service = VAULT) who connected B; the look ended in `confirm`. */
  async function asked() {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    const repo = connect(s, s.ownerId, "b", B);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm", mirrorDirty: false });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    mirror.mockClear();
    s.fake.calls.length = 0;
    return { ...s, first, repo, clone: knowledgeClonePath(s.ownerId, s.config) };
  }
  const press = (s: Awaited<ReturnType<typeof asked>>, shown: { repo: string; branch: string | null } = { repo: s.repo, branch: "main" }) =>
    confirmVaultMirrorHold(s.store, s.config, s.ownerId, shown);
  /** Nothing of a press took effect: the hold, the ledger, the dirty mark and the service are as they were. */
  const untouched = (s: Awaited<ReturnType<typeof asked>>, hold: "checking" | "confirm" | null = "confirm") => {
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: hold, mirrorDirty: false });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    expect(writes(s.fake)).toEqual([]);
    expect(mirror).not.toHaveBeenCalled();
  };

  it("writes exactly the repository-only vault notes into the deletion ledger, lifts the hold and marks the mirror behind", async () => {
    const s = await asked();
    expect(await press(s)).toEqual({ ok: true, removes: 2 });
    // Not the notes both hold (the mirror overwrites those anyway), not a file that is no vault note.
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(B_ONLY);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    // The press itself changes neither the service nor the repository: the mirror does, later.
    expect(writes(s.fake)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(git(s.clone, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(s.clone, "wiki/b-only.md"))).toBe(true);
    expect(mirror).not.toHaveBeenCalled();

    // Pressed again: there is nothing left to confirm, and nothing is added.
    expect(await press(s)).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.noHold });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(B_ONLY);
  });

  it("a repository connected without a branch is confirmed with a null branch — on the branch its clone is on", async () => {
    const s = await asked();
    s.store.setKnowledgeRepo(s.ownerId, s.repo, null);
    expect(await press(s, { repo: s.repo, branch: "main" })).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.repoChanged });
    untouched(s);
    expect(await press(s, { repo: s.repo, branch: null })).toEqual({ ok: true, removes: 2 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(B_ONLY);
  });

  it("drops a report that said a look could not happen — and keeps a clean one", async () => {
    const s = await asked();
    const clean = lastVaultMigrationReport(s.store, s.ownerId);
    expect(clean).toMatchObject({ blockers: [] }); // the cutover's
    s.store.setKnowledgeRepo(s.ownerId, s.repo, null);
    expect((await press(s, { repo: s.repo, branch: null })).ok).toBe(true);
    expect(lastVaultMigrationReport(s.store, s.ownerId)).toEqual(clean);

    const t = await asked2();
    t.fake.failNext(new MemoryUnavailableError("down", "network"), { op: "list" });
    const stale = await planVaultMigration(t.store, t.config, t.ownerId);
    expect(codes(stale.blockers)).toEqual([VAULT_BLOCKER.unavailable]);
    expect((await confirmVaultMirrorHold(t.store, t.config, t.ownerId, { repo: t.repo, branch: "main" })).ok).toBe(true);
    expect(lastVaultMigrationReport(t.store, t.ownerId)).toBeNull();

    /** The same state in a second app instance (its own data folder and remotes). */
    async function asked2() {
      const services = createServices({ dataDir: path.join(getTempDir(), "data-2"), agentRuntime: "local", sessionSecret: "t" });
      booted.push(services);
      const fake = createFakeMemoryClient();
      setMemoryClientForTests(services.store, fake);
      const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      services.store.setGitToken(owner.id, "test-token");
      const u = { store: services.store, config: services.config, fake, ownerId: owner.id };
      const first = connect(u, u.ownerId, "first-2", VAULT);
      await cutoverVault(u.store, u.config, u.ownerId);
      const repo = connect(u, u.ownerId, "b-2", B);
      onKnowledgeRepoChanged(u.store, u.config, u.ownerId, first);
      await whenVaultMigrationIdle(u.store);
      return { ...u, repo };
    }
  });

  describe("every refusal leaves the hold, the ledger and the dirty mark as they were", () => {
    it("not_memory: the vault lives in the repository", async () => {
      const s = setup();
      const repo = connect(s, s.ownerId, "brain", VAULT);
      expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo, branch: "main" })).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.notMemory });
      expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
      expect(s.fake.calls).toEqual([]);
    });

    it("checking: nobody has looked at the repository yet; no_hold: nothing is waiting", async () => {
      const s = await asked();
      s.store.setVaultMirrorHold(s.ownerId, "checking");
      expect(await press(s)).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.checking });
      untouched(s, "checking");
      s.store.setVaultMirrorHold(s.ownerId, null);
      expect(await press(s)).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.noHold });
      untouched(s, null);
      // Refused before anything was read: no sync, no question to the service.
      expect(s.fake.calls).toEqual([]);
    });

    it("repo_changed: the screen showed another repository, or another branch", async () => {
      const s = await asked();
      for (const shown of [
        { repo: s.first, branch: "main" },
        { repo: `${s.repo}-other`, branch: "main" },
        { repo: s.repo, branch: "dev" },
        { repo: s.repo, branch: null },
        { repo: "", branch: null },
      ]) {
        expect(await press(s, shown)).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.repoChanged });
        untouched(s);
      }
      expect(s.fake.calls).toEqual([]);
    });

    it("the repository is changed while the press waits for the clone: nothing of the old one is recorded, the new one is not released", async () => {
      const s = await asked();
      const other = seedRemote("other", { "wiki/others.md": "another repository's note\n" });
      const lock = holdCloneLock(s);
      const pressed = press(s); // past its first look at the row, waiting for the clone
      await tick();
      // PUT /api/me/knowledge-repo, as the route does it: the store, then the hook (→ `checking`).
      s.store.setKnowledgeRepo(s.ownerId, other, "main");
      onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
      await lock.release();

      expect(await pressed).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.checking });
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
      await whenVaultMigrationIdle(s.store);
      // The new repository got its own look and its own question; the press for B answered nothing about it.
      expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm", mirrorDirty: false });
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
      expect(git(s.clone, "remote", "get-url", "origin")).toBe(other);
    });

    it("the same, when only the stored repository changed (no look queued): repo_changed", async () => {
      const s = await asked();
      const other = seedRemote("other", { "wiki/others.md": "another repository's note\n" });
      const lock = holdCloneLock(s);
      const pressed = press(s);
      await tick();
      s.store.setKnowledgeRepo(s.ownerId, other, "main");
      await lock.release();
      expect(await pressed).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.repoChanged });
      untouched(s);
    });

    it("unreadable: no git token", async () => {
      const s = await asked();
      s.store.setGitToken(s.ownerId, null);
      expect(await press(s)).toEqual({
        ok: false,
        reason: VAULT_CONFIRM_REFUSAL.unreadable,
        detail: "no_git_token: no git token is set, so the repository cannot be synced or mirrored",
      });
      untouched(s);
      expect(s.fake.calls).toEqual([]);
      // Readable again: the same press applies.
      s.store.setGitToken(s.ownerId, "test-token");
      expect(await press(s)).toEqual({ ok: true, removes: 2 });
    });

    it("unreadable: the repository cannot be synced", async () => {
      const s = await asked();
      fs.renameSync(s.repo, `${s.repo}.gone`);
      const refused = await press(s);
      expect(refused).toMatchObject({ ok: false, reason: VAULT_CONFIRM_REFUSAL.unreadable });
      expect((refused as { detail: string }).detail).toMatch(/^sync_failed: could not fetch the repository \(/);
      untouched(s);
      fs.renameSync(`${s.repo}.gone`, s.repo);
      expect(await press(s)).toEqual({ ok: true, removes: 2 });
    });

    it("unreadable: the clone is not at the connected branch's tip (an uncommitted edit keeps git from moving it)", async () => {
      const s = await asked();
      // Pushed by git since the look: one more note of B's own, and a new version of a skill …
      pushMore("b", { "wiki/b-later.md": "added to B after the look\n", "skills/x/SKILL.md": "---\nname: x\n---\nnewer\n" });
      // … which the avatar has an unfinished edit of: the clone cannot be fast-forwarded.
      fs.writeFileSync(path.join(s.clone, "skills/x/SKILL.md"), "edited, not committed\n");
      const refused = await press(s);
      expect(refused).toMatchObject({ ok: false, reason: VAULT_CONFIRM_REFUSAL.unreadable });
      expect((refused as { detail: string }).detail).toMatch(/^sync_failed: the server's copy of the repository does not hold the newest commits of main\b/);
      // Recording what the stale clone shows would have missed `wiki/b-later.md` — or confirmed a tree nobody saw.
      untouched(s);
      expect(s.fake.calls).toEqual([]);

      git(s.clone, "checkout", "--", "skills/x/SKILL.md");
      expect(await press(s)).toEqual({ ok: true, removes: 3 });
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/b-capture.md", "wiki/b-later.md", "wiki/b-only.md"]);
    });

    it.each([
      ["does not answer", () => new MemoryUnavailableError("down", "timeout"), "memory_unavailable: the memory service could not be used (timeout)"],
      ["refuses", () => new MemoryRefusedError("invalid_owner", 400, "no"), "refused: the service refused the request (code: invalid_owner)"],
    ])("unreadable: the memory service %s", async (_what, failure, detail) => {
      const s = await asked();
      s.fake.failNext(failure(), { op: "list" });
      expect(await press(s)).toEqual({ ok: false, reason: VAULT_CONFIRM_REFUSAL.unreadable, detail });
      untouched(s);
      expect(await press(s)).toEqual({ ok: true, removes: 2 });
    });

    it("unreadable: this server has no memory service", async () => {
      const s = await asked();
      setMemoryClientForTests(s.store, null);
      expect(await press(s)).toMatchObject({ ok: false, reason: VAULT_CONFIRM_REFUSAL.unreadable });
      expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm", mirrorDirty: false });
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    });
  });

  it("a confirmation is about the repository it was pressed for: connecting another one empties the ledger at once", async () => {
    const s = await asked();
    // A deletion made through Noah that the mirror has not carried into B yet, and the press for B.
    await memoryVaultFor(s.store, s.config, s.ownerId)!.remove("raw/2026-11-01.md");
    expect(await press(s)).toEqual({ ok: true, removes: 2 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/2026-11-01.md", ...B_ONLY]);

    // The owner connects C, which happens to hold notes at those very paths.
    connect(s, s.ownerId, "c", { "wiki/b-only.md": "C's own note at that path\n", "raw/2026-11-01.md": "C's capture of that day\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    // Emptied in the same tick as the hold: no pass can remove C's notes because an old entry names their paths.
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    await whenVaultMigrationIdle(s.store);
    // C's notes are the owner's to confirm, afresh.
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
  });

  it("a BRANCH change of the same repository empties the ledger too (the other branch holds its own files)", async () => {
    const s = await asked();
    await memoryVaultFor(s.store, s.config, s.ownerId)!.remove("raw/2026-11-01.md");
    expect(await press(s)).toEqual({ ok: true, removes: 2 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/2026-11-01.md", ...B_ONLY]);
    // `dev` has B's notes and one more; nothing there was confirmed, and nothing there was deleted through Noah.
    pushBranch("b", "dev", { "wiki/dev-only.md": "only on dev\n" });

    s.store.setKnowledgeRepo(s.ownerId, s.repo, "dev");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    // The press for `dev` is its own: it names what `dev` holds now.
    expect(await press(s, { repo: s.repo, branch: "dev" })).toEqual({ ok: true, removes: 3 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/b-capture.md", "wiki/b-only.md", "wiki/dev-only.md"]);
  });

  it("reads the REPOSITORY's files, not what a stopped mirror left uncommitted in the clone", async () => {
    const s = await asked();
    // Leftovers of a pass that was stopped before its commit: a copy of a note the service no longer holds,
    // and the deletion of a note the repository still has.
    fs.writeFileSync(path.join(s.clone, "wiki/ghost.md"), "a copy of a note that is gone from the service\n");
    fs.rmSync(path.join(s.clone, "wiki/b-only.md"));
    git(s.clone, "add", "-A");
    expect(git(s.clone, "status", "--porcelain")).not.toBe("");

    expect(await press(s)).toEqual({ ok: true, removes: 2 });
    // `wiki/ghost.md` was never a note of the repository: not something the press could cover. `wiki/b-only.md`
    // IS one, whatever the leftover deletion made the clone look like.
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(B_ONLY);
    expect(git(s.clone, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(s.clone, "wiki/ghost.md"))).toBe(false);
    expect(fs.readFileSync(path.join(s.clone, "wiki/b-only.md"), "utf8")).toBe("only in B\n");
  });

  it("is one of the owner's vault writes: it waits for the write queue, and a note written first is not recorded as repository-only", async () => {
    const s = await asked();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    // A tool call of a run is in the queue: it writes a note at a path B also has, and takes its time.
    const write = withVaultWrite(s.store, s.config, s.ownerId, async (target) => {
      if (target.home !== "memory") throw new Error("expected the memory home");
      await target.vault.write("wiki/b-only.md", "the owner's own note at that path\n");
      await gate;
    });
    let settled = false;
    const pressed = press(s).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });

    open();
    await write;
    // The service holds `wiki/b-only.md` by the time the press reads it: one repository-only note is left.
    expect(await pressed).toEqual({ ok: true, removes: 1 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/b-capture.md"]);
  });

  it("holds the clone's lock while it reads: a press that arrives while the clone is in use waits for it", async () => {
    const s = await asked();
    const lock = holdCloneLock(s);
    let settled = false;
    const pressed = press(s).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    await lock.release();
    expect(await pressed).toEqual({ ok: true, removes: 2 });
  });
});

// ---- With the real mirror (vaultMirror.ts) ---------------------------------------

describe("with the real git mirror", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../src/server/vaultMirror.js")>("../src/server/vaultMirror.js");
    mirror.mockImplementation(actual.syncVaultMirror);
  });

  const remoteFile = (remote: string, rel: string) => {
    try {
      return execFileSync("git", ["-C", remote, "show", `main:${rel}`], { stdio: "pipe" }).toString();
    } catch {
      return null;
    }
  };

  it("cutover leaves the repository as it is; a rollback after a vault write carries that write into it", async () => {
    const s = setup();
    const remote = connect(s, s.ownerId, "brain", VAULT);
    const before = git(remote, "rev-parse", "main");

    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", blockers: [] });
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorDirty: false, mirrorError: null });
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorSyncedAt).not.toBeNull();
    expect(git(remote, "rev-parse", "main")).toBe(before);

    const vault = memoryVaultFor(s.store, s.config, s.ownerId)!;
    await vault.write("wiki/after.md", "written after the cutover\n");
    await vault.remove("raw/2026-11-01.md");

    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true });
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(remoteFile(remote, "wiki/after.md")).toBe("written after the cutover\n");
    expect(remoteFile(remote, "raw/2026-11-01.md")).toBeNull();
    expect(remoteFile(remote, "wiki/index.md")).toBe(VAULT["wiki/index.md"]);
    // The clone is the vault again, and holds every note written after the cutover.
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(fs.readFileSync(path.join(clone, "wiki/after.md"), "utf8")).toBe("written after the cutover\n");
    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", notes: 4, blockers: [] });
  });

  it("a rollback is blocked while the repository cannot take the mirror, and keeps the post-cutover write", async () => {
    const s = setup();
    const remote = connect(s, s.ownerId, "brain", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    await memoryVaultFor(s.store, s.config, s.ownerId)!.write("wiki/after.md", "kept in the service\n");
    fs.renameSync(remote, `${remote}.gone`);

    const result = await rollbackVault(s.store, s.config, s.ownerId);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^mirror_failed: /);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorDirty: true });
    expect(s.fake.dump(s.ownerId)["wiki/after.md"]).toBe("kept in the service\n");

    fs.renameSync(`${remote}.gone`, remote);
    expect(await rollbackVault(s.store, s.config, s.ownerId)).toEqual({ ok: true });
    expect(remoteFile(remote, "wiki/after.md")).toBe("kept in the service\n");
  });
  it("the owner's confirmation removes what the repository held AT THE PRESS — a note that reaches it by git afterwards is kept", async () => {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", blockers: [] });

    // The owner connects repository B, which has vault notes of its own.
    const remoteB = connect(s, s.ownerId, "b", {
      "CLAUDE.md": "# B's own standing memory\n",
      "wiki/index.md": "# B's index\n",
      "wiki/b-only.md": "only in B\n",
      "raw/b-capture.md": "captured in B\n",
      "skills/x/SKILL.md": "---\nname: x\n---\n",
    });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, first);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    // On hold, the mirror writes nothing.
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "hold" });
    const beforePress = git(remoteB, "rev-parse", "main");

    // The press.
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: remoteB, branch: "main" })).toEqual({ ok: true, removes: 2 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/b-capture.md", "wiki/b-only.md"]);

    // The first mirror pass after it fails (no git token) …
    s.store.setGitToken(s.ownerId, null);
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "failed", error: "no git token" });
    expect(git(remoteB, "rev-parse", "main")).toBe(beforePress);
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/b-capture.md", "wiki/b-only.md"]);
    // … and before one succeeds, a note is pushed to B by git — not through Noah, and after the press.
    pushMore("b", { "wiki/after-press.md": "pushed by git after the press\n" });

    s.store.setGitToken(s.ownerId, "test-token");
    const outcome = await syncVaultMirror(s.store, s.config, s.ownerId, { push: true });
    expect(outcome).toMatchObject({ kind: "synced", notice: "repository notes not in the memory service: 1" });

    // What the owner confirmed is gone from the repository …
    expect(remoteFile(remoteB, "wiki/b-only.md")).toBeNull();
    expect(remoteFile(remoteB, "raw/b-capture.md")).toBeNull();
    // … the notes both held are the service's …
    expect(remoteFile(remoteB, "CLAUDE.md")).toBe(VAULT["CLAUDE.md"]);
    expect(remoteFile(remoteB, "wiki/index.md")).toBe(VAULT["wiki/index.md"]);
    expect(remoteFile(remoteB, "wiki/concepts/deploy.md")).toBe(VAULT["wiki/concepts/deploy.md"]);
    expect(remoteFile(remoteB, "raw/2026-11-01.md")).toBe(VAULT["raw/2026-11-01.md"]);
    // … and the note that arrived after the press is KEPT, and counted in the notice.
    expect(remoteFile(remoteB, "wiki/after-press.md")).toBe("pushed by git after the press\n");
    expect(remoteFile(remoteB, "skills/x/SKILL.md")).toBe("---\nname: x\n---\n");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({
      mirrorHold: null,
      mirrorDirty: false,
      mirrorError: null,
      mirrorNotice: "repository notes not in the memory service: 1",
    });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);

    // Later passes leave it alone too.
    s.store.markVaultMirrorDirty(s.ownerId);
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "synced", changed: 0 });
    expect(remoteFile(remoteB, "wiki/after-press.md")).toBe("pushed by git after the press\n");
  });

  it("the same with a first pass that is skipped because the clone has someone's unfinished work", async () => {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    const remoteB = connect(s, s.ownerId, "b", { "wiki/b-only.md": "only in B\n", "skills/x/SKILL.md": "---\nname: x\n---\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, first);
    await whenVaultMigrationIdle(s.store);
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: remoteB, branch: "main" })).toEqual({ ok: true, removes: 1 });

    const clone = knowledgeClonePath(s.ownerId, s.config);
    fs.writeFileSync(path.join(clone, "unfinished.txt"), "the avatar's work\n");
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "repo_dirty" });
    pushMore("b", { "wiki/after-press.md": "pushed by git after the press\n" });
    fs.rmSync(path.join(clone, "unfinished.txt"));

    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "synced" });
    expect(remoteFile(remoteB, "wiki/b-only.md")).toBeNull();
    expect(remoteFile(remoteB, "wiki/after-press.md")).toBe("pushed by git after the press\n");
    expect(remoteFile(remoteB, "CLAUDE.md")).toBe(VAULT["CLAUDE.md"]);
  });
  it("a confirmation of repository B never reaches repository C: a note pushed to C at a path B's press named is kept", async () => {
    const s = setup();
    const first = connect(s, s.ownerId, "first", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    const remoteB = connect(s, s.ownerId, "b", { "wiki/theirs.md": "B's note\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, first);
    await whenVaultMigrationIdle(s.store);
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: remoteB, branch: "main" })).toEqual({ ok: true, removes: 1 });
    // No pass into B succeeds before the owner moves on …
    s.store.setGitToken(s.ownerId, null);
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "failed" });
    s.store.setGitToken(s.ownerId, "test-token");
    // … to C, which holds no vault note: nothing to ask, the hold is lifted.
    const remoteC = connect(s, s.ownerId, "c", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, remoteB);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    // Before the first pass into C, a note reaches it by git — at the very path B's press recorded.
    pushMore("c", { "wiki/theirs.md": "C's own note, never confirmed\n" });

    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({
      kind: "synced",
      notice: "repository notes not in the memory service: 1",
    });
    expect(remoteFile(remoteC, "wiki/theirs.md")).toBe("C's own note, never confirmed\n");
    expect(remoteFile(remoteC, "CLAUDE.md")).toBe(VAULT["CLAUDE.md"]);
    // B was never written: its note is where it was.
    expect(remoteFile(remoteB, "wiki/theirs.md")).toBe("B's note\n");
  });
  it("a deletion made through Noah that never reached repository A does not delete the same path in repository B", async () => {
    const s = setup();
    const remoteA = connect(s, s.ownerId, "a", VAULT);
    await cutoverVault(s.store, s.config, s.ownerId);
    const vault = memoryVaultFor(s.store, s.config, s.ownerId)!;
    /** Delete a note through Noah while no pass into the connected repository can succeed. */
    const deleteUnmirrored = async (notePath: string) => {
      await vault.remove(notePath);
      expect(s.store.listVaultDeletes(s.ownerId)).toEqual([notePath]);
      s.store.setGitToken(s.ownerId, null);
      expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "failed" });
      s.store.setGitToken(s.ownerId, "test-token");
    };

    // B holds no vault note when it is connected (the hold is lifted); the note arrives by git afterwards.
    await deleteUnmirrored("raw/2026-11-01.md");
    const remoteB = connect(s, s.ownerId, "b", { "skills/x/SKILL.md": "---\nname: x\n---\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, remoteA);
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null });
    pushMore("b", { "raw/2026-11-01.md": "B's own capture of that day\n" });
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({
      kind: "synced",
      notice: "repository notes not in the memory service: 1",
    });
    expect(remoteFile(remoteB, "raw/2026-11-01.md")).toBe("B's own capture of that day\n");
    // A never got the deletion (no pass into it succeeded), and nothing else of it was touched.
    expect(remoteFile(remoteA, "raw/2026-11-01.md")).toBe(VAULT["raw/2026-11-01.md"]);

    // C holds a note at the deleted path when it is connected: the owner is asked, and until they press it stays.
    await deleteUnmirrored("wiki/index.md");
    const remoteC = connect(s, s.ownerId, "c", { "wiki/index.md": "# C's own index\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, remoteB);
    await whenVaultMigrationIdle(s.store);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual([]);
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "hold" });
    expect(remoteFile(remoteC, "wiki/index.md")).toBe("# C's own index\n");
    // Their press is what removes it.
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: remoteC, branch: "main" })).toEqual({ ok: true, removes: 1 });
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "synced" });
    expect(remoteFile(remoteC, "wiki/index.md")).toBeNull();
  });
});

// ---- A mirror stopped by a branch change leaves copies in the clone ------------------

describe("a pass or a commit that the hold stopped leaves copies in the clone: the look drops them before it syncs", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("../src/server/vaultMirror.js")>("../src/server/vaultMirror.js");
    mirror.mockImplementation(actual.syncVaultMirror);
  });

  const onBranch = (remote: string, branch: string, rel: string) => {
    try {
      return execFileSync("git", ["-C", remote, "show", `${branch}:${rel}`], { stdio: "pipe" }).toString();
    } catch {
      return null;
    }
  };
  const branchOf = (clone: string) => git(clone, "rev-parse", "--abbrev-ref", "HEAD");
  const SKILL = "---\nname: x\n---\nthe skill\n";

  /**
   * An owner in `memory` on `main` (service = repository). The remote also has `other`, with `files` on top
   * of main. The owner then changes a note through Noah, so the next pass has a copy to write.
   */
  async function onMain(other: Files) {
    const s = setup();
    const repo = connect(s, s.ownerId, "brain", { ...VAULT, "wiki/a.md": "a, as main has it\n", "skills/x/SKILL.md": SKILL });
    expect(await cutoverVault(s.store, s.config, s.ownerId)).toMatchObject({ state: "memory", blockers: [] });
    pushBranch("brain", "other", other);
    const vault = memoryVaultFor(s.store, s.config, s.ownerId)!;
    const clone = knowledgeClonePath(s.ownerId, s.config);
    const tips = () => ({ main: git(repo, "rev-parse", "main"), other: git(repo, "rev-parse", "other") });
    return { ...s, repo, clone, vault, tips };
  }
  /** The owner switches the connected branch to `other` — the store, then the hook, as the route does. */
  const switchToOther = (s: Awaited<ReturnType<typeof onMain>>) => {
    s.store.setKnowledgeRepo(s.ownerId, s.repo, "other");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId, s.repo);
  };

  it("the deadlock: a pass running when the branch changed is stopped before its commit; the look still reaches the new branch", async () => {
    const s = await onMain({ "wiki/a.md": "a, as the other branch has it\n" });
    await s.vault.write("wiki/a.md", "a, edited through Noah\n");
    const before = s.tips();
    // The pass is reading the service when the owner switches the branch.
    s.fake.beforeNext("read", () => switchToOther(s));

    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "hold" });
    // What it had written stays, uncommitted — and differs from the other branch's file, so git cannot switch over it.
    expect(git(s.clone, "status", "--porcelain")).toMatch(/wiki\/a\.md/);
    expect(fs.readFileSync(path.join(s.clone, "wiki/a.md"), "utf8")).toBe("a, edited through Noah\n");

    await whenVaultMigrationIdle(s.store);
    // The look dropped the leftover, followed the branch, and judged ITS files: `wiki/a.md` differs → the owner is asked.
    expect(branchOf(s.clone)).toBe("other");
    expect(git(s.clone, "status", "--porcelain")).toBe("");
    expect(fs.readFileSync(path.join(s.clone, "wiki/a.md"), "utf8")).toBe("a, as the other branch has it\n");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(lastVaultMigrationReport(s.store, s.ownerId)?.blockers ?? []).toEqual([]);
    // Nothing was pushed, to either branch.
    expect(s.tips()).toEqual(before);
    expect(s.fake.dump(s.ownerId)["wiki/a.md"]).toBe("a, edited through Noah\n");

    // The press, then the mirror: `other` becomes the service's vault, as after any confirmation.
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: s.repo, branch: "other" })).toEqual({ ok: true, removes: 0 });
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toMatchObject({ kind: "synced" });
    expect(onBranch(s.repo, "other", "wiki/a.md")).toBe("a, edited through Noah\n");
    expect(onBranch(s.repo, "other", "CLAUDE.md")).toBe(VAULT["CLAUDE.md"]);
    expect(onBranch(s.repo, "main", "wiki/a.md")).toBe("a, as main has it\n");
    expect(s.tips().main).toBe(before.main);
  });

  /** The owner's avatar: the real repo tools of an own-avatar run. */
  const avatar = (s: Awaited<ReturnType<typeof onMain>>) => {
    const tools = buildRepoTools(s.store, {
      avatarUserId: s.ownerId,
      owner: { id: s.ownerId, username: "owner", displayName: "Owner" },
      viewerIsOwner: true,
      config: s.config,
    });
    return (name: string, args: unknown) => callTool(tools, name, args);
  };

  it("the same from a stopped `commit`: the copy it wrote is dropped, the avatar's own change travels to the new branch", async () => {
    const s = await onMain({ "wiki/a.md": "a, as the other branch has it\n" });
    const call = avatar(s);
    expect((await call("write_file", { path: "wiki/a.md", content: "a, edited through Noah\n" })).isError).toBeFalsy();
    // The avatar's own work in the repository (not a vault note), not committed yet.
    expect((await call("write_file", { path: "skills/y/SKILL.md", content: "---\nname: y\n---\na new skill\n" })).isError).toBeFalsy();
    const before = s.tips();
    // The commit's mirror pass is reading the service when the owner switches the branch.
    s.fake.beforeNext("read", () => switchToOther(s));

    const committed = await call("commit", { message: "add skill y" });
    expect(committed.isError).toBe(true);
    expect(s.tips()).toEqual(before);
    const leftover = git(s.clone, "status", "--porcelain");
    expect(leftover).toMatch(/wiki\/a\.md/);
    expect(leftover).toMatch(/skills\/y\//);

    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("other");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    // Only the mirror's copy was dropped. The avatar's skill is still there, uncommitted, now on `other`.
    expect(fs.readFileSync(path.join(s.clone, "wiki/a.md"), "utf8")).toBe("a, as the other branch has it\n");
    expect(fs.readFileSync(path.join(s.clone, "skills/y/SKILL.md"), "utf8")).toBe("---\nname: y\n---\na new skill\n");
    const after = git(s.clone, "status", "--porcelain");
    expect(after).toMatch(/skills\/y\//);
    expect(after).not.toMatch(/wiki\//);
    expect(s.tips()).toEqual(before);
  });

  it("… and when the avatar's own change conflicts with the new branch, it is kept and the hold stays `checking`, with the report naming why", async () => {
    const s = await onMain({ "wiki/a.md": "a, as the other branch has it\n", "skills/x/SKILL.md": "---\nname: x\n---\nthe other branch's skill\n" });
    const call = avatar(s);
    await call("write_file", { path: "wiki/a.md", content: "a, edited through Noah\n" });
    // An edit of a file that differs between the branches: git will not switch over it.
    await call("write_file", { path: "skills/x/SKILL.md", content: "---\nname: x\n---\nthe avatar's unfinished edit\n" });
    s.fake.beforeNext("read", () => switchToOther(s));
    expect((await call("commit", { message: "edit skill x" })).isError).toBe(true);

    await whenVaultMigrationIdle(s.store);
    // The mirror's copy is gone (it would be written again); the avatar's edit is NOT.
    expect(branchOf(s.clone)).toBe("main");
    expect(fs.readFileSync(path.join(s.clone, "skills/x/SKILL.md"), "utf8")).toBe("---\nname: x\n---\nthe avatar's unfinished edit\n");
    expect(fs.readFileSync(path.join(s.clone, "wiki/a.md"), "utf8")).toBe("a, as main has it\n");
    const status = git(s.clone, "status", "--porcelain");
    expect(status).toMatch(/skills\/x\/SKILL\.md/);
    expect(status).not.toMatch(/wiki\//);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "checking" });
    const report = lastVaultMigrationReport(s.store, s.ownerId)!;
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatch(/^sync_failed: the server's copy of the repository does not hold the newest commits of other\b/);
    expect(report.blockers[0]).toContain("uncommitted changes");
  });

  it("a leftover copy that EQUALS the new branch's file: the look still decides by what the branch holds — nothing differs, the hold is lifted", async () => {
    // `other` already has the text the owner is about to write through Noah.
    const s = await onMain({ "wiki/a.md": "a, edited through Noah\n" });
    await s.vault.write("wiki/a.md", "a, edited through Noah\n");
    const before = s.tips();
    s.fake.beforeNext("read", () => switchToOther(s));
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "hold" });
    expect(git(s.clone, "status", "--porcelain")).toMatch(/wiki\/a\.md/);

    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("other");
    expect(git(s.clone, "status", "--porcelain")).toBe("");
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
    expect(s.tips()).toEqual(before);
  });

  it("a leftover DELETION does not hide a note the new branch holds: the owner is asked about it", async () => {
    // `other` is main plus a skill: its vault is main's, `raw/2026-11-01.md` included.
    const s = await onMain({ "skills/z/SKILL.md": "---\nname: z\n---\n" });
    // The owner deletes that note through Noah; the pass that would carry the deletion to main is stopped.
    await s.vault.remove("raw/2026-11-01.md");
    const before = s.tips();
    s.fake.beforeNext("read", () => switchToOther(s));
    expect(await syncVaultMirror(s.store, s.config, s.ownerId, { push: true })).toEqual({ kind: "skipped", reason: "hold" });
    expect(fs.existsSync(path.join(s.clone, "raw/2026-11-01.md"))).toBe(false);
    expect(git(s.clone, "status", "--porcelain")).toMatch(/raw\/2026-11-01\.md/);

    await whenVaultMigrationIdle(s.store);
    expect(branchOf(s.clone)).toBe("other");
    // `other` still has the note, the service does not: that is for the owner to confirm — not a hold to lift
    // because a leftover made the clone look as if the note were gone.
    expect(fs.readFileSync(path.join(s.clone, "raw/2026-11-01.md"), "utf8")).toBe(VAULT["raw/2026-11-01.md"]);
    expect(s.store.getPersonalVault(s.ownerId)).toMatchObject({ mirrorHold: "confirm" });
    expect(s.tips()).toEqual(before);
    expect(await confirmVaultMirrorHold(s.store, s.config, s.ownerId, { repo: s.repo, branch: "other" })).toEqual({ ok: true, removes: 1 });
    expect(s.store.listVaultDeletes(s.ownerId)).toEqual(["raw/2026-11-01.md"]);
  });
});
