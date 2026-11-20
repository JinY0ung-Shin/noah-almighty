import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { ensureClone, knowledgeClonePath, knowledgeRepoContextFor } from "../src/server/knowledgeRepo.js";
import { MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { VAULT_NOTE_MAX_BYTES } from "../src/server/personalVault.js";
import { PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY } from "../src/server/store/internal.js";
import { onKnowledgeRepoChanged, resumeVaultImports, runVaultImport, whenVaultImportsIdle } from "../src/server/vaultImport.js";
import { createFakeMemoryClient, type FakeMemoryClient } from "./helpers/fakeMemory.js";
import { makeBareRemote, withTempDir } from "./helpers.js";

// vaultImport.ts: the one-time import of a repository's own vault notes into an EMPTY vault — over real clones
// of LOCAL bare remotes (offline; a local path needs no token) and the in-process fake of the memory service.

type Services = ReturnType<typeof createServices>;

// Every test here clones a real git repository: room for a loaded machine (the whole suite in parallel).
vi.setConfig({ testTimeout: 30_000 });

const getTempDir = withTempDir("vault-import");

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();

type Files = Record<string, string | Buffer>;

function writeFiles(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

/** A bare remote on `main` holding `files` (and whatever `prepare` adds to the seed tree), outside the data root. */
function seedRemote(name: string, files: Files, prepare?: (seed: string) => void): string {
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
  prepare?.(seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "branch", "-M", "main");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  return remote;
}

const booted: Services[] = [];
afterEach(async () => {
  for (const { store } of booted.splice(0)) await whenVaultImportsIdle(store);
});

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

function addUser(s: { store: Services["store"] }, username: string): string {
  const user = s.store.createUser({ username, displayName: username, password: "password123" });
  s.store.setGitToken(user.id, "test-token");
  return user.id;
}

/** Connect `files` as the user's knowledge repository (a seeded local remote on `main`) — the store only, no hook. */
function connect(s: { store: Services["store"] }, userId: string, name: string, files: Files, prepare?: (seed: string) => void): string {
  const remote = seedRemote(name, files, prepare);
  s.store.setKnowledgeRepo(userId, remote, "main");
  return remote;
}

const VAULT: Files = {
  "CLAUDE.md": "# standing memory\n",
  "wiki/index.md": "# Index\n",
  "wiki/concepts/deploy.md": "---\ntitle: Deploy\n---\nHow we deploy.\n",
  "raw/2026-11-01.md": "captured\n",
};

describe("a newly connected repository", () => {
  it("brings its own notes into an empty vault, and leaves the repository as it is", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", { ...VAULT, "skills/x/SKILL.md": "a skill\n", "wiki/diagram.png": Buffer.from([1, 2, 3]) });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId);
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "check" });
    await whenVaultImportsIdle(s.store);

    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(s.store.listVaultImports()).toEqual({});
    // Nothing of the repository was changed or removed: the files are still in the clone, tracked and clean.
    const clone = knowledgeClonePath(s.ownerId, s.config);
    expect(fs.readFileSync(path.join(clone, "wiki/concepts/deploy.md"), "utf8")).toBe(VAULT["wiki/concepts/deploy.md"]);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("imports NOTHING into a vault that already holds a note — an old copy in the repository never comes back", async () => {
    const s = setup();
    s.fake.seed(s.ownerId, "wiki/kept.md", "the vault's own note");
    connect(s, s.ownerId, "brain", VAULT);
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId);
    await whenVaultImportsIdle(s.store);

    expect(s.fake.dump(s.ownerId)).toEqual({ "wiki/kept.md": "the vault's own note" });
    expect(s.store.listVaultImports()).toEqual({});
    expect(s.fake.calls.some((call) => call.op === "put")).toBe(false);
  });

  it("has nothing to do for a repository without vault notes", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", { "skills/x/SKILL.md": "a skill\n", "wiki/.obsidian/app.md": "not a note the service holds\n" });
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId);
    await whenVaultImportsIdle(s.store);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.store.listVaultImports()).toEqual({});
  });

  it("skips what the service cannot hold and never follows a link; the rest is imported", async () => {
    const s = setup();
    connect(
      s,
      s.ownerId,
      "brain",
      {
        "wiki/ok.md": "fine\n",
        "wiki/big.md": "x".repeat(VAULT_NOTE_MAX_BYTES + 1),
        "wiki/binary.md": Buffer.from([0xff, 0xfe, 0x00, 0x41]),
        "wiki/nul.md": "a\0b",
        "outside.md": "reached only through the link\n",
      },
      (seed) => {
        fs.symlinkSync("../outside.md", path.join(seed, "wiki", "link.md"));
        fs.mkdirSync(path.join(seed, "elsewhere"));
        fs.writeFileSync(path.join(seed, "elsewhere", "hidden.md"), "reached only through the linked folder\n");
        fs.symlinkSync("../elsewhere", path.join(seed, "raw"));
      },
    );
    s.store.setVaultImport(s.ownerId, "check");
    const outcome = await runVaultImport(s.store, s.config, s.ownerId);

    expect(s.fake.dump(s.ownerId)).toEqual({ "wiki/ok.md": "fine\n" });
    expect(outcome.kind).toBe("imported");
    if (outcome.kind !== "imported") return;
    expect(outcome.created).toBe(1);
    expect(outcome.skipped.sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual([
      { path: "wiki/big.md", reason: "too_large" },
      { path: "wiki/binary.md", reason: "not_utf8" },
      { path: "wiki/nul.md", reason: "nul" },
    ]);
  });

  it("a repository that was disconnected ends whatever was pending", () => {
    const s = setup();
    s.store.setVaultImport(s.ownerId, "import");
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId);
    expect(s.store.listVaultImports()).toEqual({});
  });

  it("a deleted user's pending import drops itself", async () => {
    const s = setup();
    const gone = addUser(s, "gone");
    connect(s, gone, "gone", VAULT);
    s.store.setVaultImport(gone, "check");
    s.store.deleteUser(gone);
    expect(await runVaultImport(s.store, s.config, gone)).toEqual({ kind: "nothing", reason: "no_user" });
    expect(s.store.listVaultImports()).toEqual({});
    expect(s.fake.calls).toEqual([]);
  });
});

describe("an import that could not be finished", () => {
  it("stays a pending look when the service is down, and the next boot does it", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.fake.failNext(new MemoryUnavailableError());
    onKnowledgeRepoChanged(s.store, s.config, s.ownerId);
    await whenVaultImportsIdle(s.store);
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "check" });

    expect(resumeVaultImports(s.store, s.config)).toBe(1);
    await whenVaultImportsIdle(s.store);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(s.store.listVaultImports()).toEqual({});
  });

  it("an import interrupted half-way is continued: it creates what is missing and overwrites nothing", async () => {
    const s = setup();
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setVaultImport(s.ownerId, "check");
    // The service goes away after the first note arrived.
    s.fake.beforeNext("put", () => s.fake.beforeNext("put", () => s.fake.failNext(new MemoryUnavailableError())));
    expect(await runVaultImport(s.store, s.config, s.ownerId)).toEqual({ kind: "retry", reason: "memory_unavailable" });
    const partial = s.fake.dump(s.ownerId);
    const arrivedCount = Object.keys(partial).length;
    expect(arrivedCount).toBeGreaterThan(0);
    expect(arrivedCount).toBeLessThan(Object.keys(VAULT).length);
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "import" });

    // Meanwhile the owner's avatar rewrote the one note that had arrived.
    const [arrived] = Object.keys(partial);
    s.fake.seed(s.ownerId, arrived!, "rewritten by the owner");

    // The vault is no longer empty, but an import that BEGAN is continued — without touching what is there.
    const outcome = await runVaultImport(s.store, s.config, s.ownerId);
    expect(outcome).toMatchObject({ kind: "imported", created: Object.keys(VAULT).length - arrivedCount, skipped: [] });
    expect(s.fake.dump(s.ownerId)).toEqual({ ...VAULT, [arrived!]: "rewritten by the owner" });
    expect(s.store.listVaultImports()).toEqual({});
  });

  it("stays pending when the repository cannot be read", async () => {
    const s = setup();
    s.store.setKnowledgeRepo(s.ownerId, path.join(getTempDir(), "remotes", "missing.git"), "main");
    s.store.setVaultImport(s.ownerId, "check");
    expect(await runVaultImport(s.store, s.config, s.ownerId)).toEqual({ kind: "retry", reason: "sync_failed" });
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "check" });
  });

  it("does not import from a clone that is still on the branch connected before", async () => {
    const s = setup();
    const remote = connect(s, s.ownerId, "brain", { "wiki/main-only.md": "a note of main\n", "skills/x.md": "main\n" });
    const seed = path.join(getTempDir(), "remotes", "brain-seed");
    git(seed, "checkout", "-q", "-b", "other");
    writeFiles(seed, { "wiki/other-only.md": "a note of other\n", "skills/x.md": "other\n" });
    git(seed, "rm", "-q", "wiki/main-only.md");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "other");
    git(seed, "push", "-q", "origin", "other");
    // The clone exists on main, with an uncommitted repository file that git will not carry over to `other`.
    const clone = await ensureClone(knowledgeRepoContextFor(s.store, s.ownerId, s.config)!);
    fs.writeFileSync(path.join(clone, "skills", "x.md"), "edited, not committed\n");

    s.store.setKnowledgeRepo(s.ownerId, remote, "other");
    s.store.setVaultImport(s.ownerId, "check");
    expect(await runVaultImport(s.store, s.config, s.ownerId)).toEqual({ kind: "retry", reason: "sync_failed" });
    // main's note was not taken for the connected branch's.
    expect(s.fake.dump(s.ownerId)).toEqual({});
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "check" });
  });

  it("stays pending on a server without a memory service", async () => {
    const s = setup({ fake: null });
    connect(s, s.ownerId, "brain", VAULT);
    s.store.setVaultImport(s.ownerId, "check");
    expect(await runVaultImport(s.store, s.config, s.ownerId)).toEqual({ kind: "retry", reason: "not_configured" });
    expect(s.store.listVaultImports()).toEqual({ [s.ownerId]: "check" });
  });
});

describe("the boot that retired the vault tables", () => {
  it("looks once at every owner who had a repository but was never moved: an empty vault gets the notes, another is left alone", async () => {
    const s = setup();
    const kept = addUser(s, "kept");
    connect(s, s.ownerId, "unmoved", VAULT);
    connect(s, kept, "kept", VAULT);
    s.fake.seed(kept, "wiki/own.md", "already in the service");
    // What migrate() leaves when it drops the tables.
    s.store.setAppSecret(PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY, JSON.stringify([kept, s.ownerId]));

    expect(resumeVaultImports(s.store, s.config)).toBe(2);
    await whenVaultImportsIdle(s.store);
    expect(s.fake.dump(s.ownerId)).toEqual(VAULT);
    expect(s.fake.dump(kept)).toEqual({ "wiki/own.md": "already in the service" });
    expect(s.store.listVaultImports()).toEqual({});
    // Handed over once: a later boot has nobody to look at.
    expect(s.store.getAppSecret(PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY)).toBeNull();
    expect(resumeVaultImports(s.store, s.config)).toBe(0);
  });
});
