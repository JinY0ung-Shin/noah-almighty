import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import {
  MemoryRefusedError,
  MemoryUnavailableError,
  setMemoryClientForTests,
} from "../src/server/memory/memoryClient.js";
import {
  VAULT_NOTE_MAX_BYTES,
  VAULT_WRITER_CLOSED,
  isPersonalVaultPath,
  memoryVaultFor,
  normalizeVaultPath,
  withVaultWrite,
  withVaultWriteLock,
  type MemoryVault,
  type MemoryVaultWriter,
} from "../src/server/personalVault.js";
import { createFakeMemoryClient, fakeMemoryHash, type FakeMemoryClient } from "./helpers/fakeMemory.js";
import { withTempDir } from "./helpers.js";

// The personal vault (personalVault.ts): the path predicate, the store's
// pending repository imports and the retirement of the old vault tables, and
// MemoryVault — the owner's vault over the memory service, here the in-process fake.

const getTempDir = withTempDir("personal-vault");

function setup() {
  const { store, config } = createServices({ dataDir: path.join(getTempDir(), "data"), agentRuntime: "local", sessionSecret: "t" });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
  return { store, config, ownerId: owner.id, otherId: other.id };
}

/** An owner's vault over a fresh fake service. */
function setupVault(): ReturnType<typeof setup> & { fake: FakeMemoryClient; vault: MemoryVault } {
  const base = setup();
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(base.store, fake);
  const vault = memoryVaultFor(base.store, base.config, base.ownerId);
  return { ...base, fake, vault };
}

const message = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error as Error).message,
  );

/** Half a surrogate pair: a high one not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );

describe("personal vault paths", () => {
  it("normalizes: leading ./ and /, posix normalization, NFC", () => {
    expect(normalizeVaultPath("wiki/a.md")).toBe("wiki/a.md");
    expect(normalizeVaultPath("./wiki/a.md")).toBe("wiki/a.md");
    expect(normalizeVaultPath("/wiki/a.md")).toBe("wiki/a.md");
    expect(normalizeVaultPath("//./wiki//b/../a.md")).toBe("wiki/a.md");
    expect(normalizeVaultPath("wiki/../CLAUDE.md")).toBe("CLAUDE.md");
    expect(normalizeVaultPath("../wiki/a.md")).toBe("../wiki/a.md");
    expect(normalizeVaultPath("")).toBe(".");
    const nfd = "wiki/한글.md".normalize("NFD");
    expect(nfd).not.toBe("wiki/한글.md");
    expect(normalizeVaultPath(nfd)).toBe("wiki/한글.md");
  });

  it.each([
    "CLAUDE.md",
    "./CLAUDE.md",
    "/CLAUDE.md",
    "wiki/../CLAUDE.md",
    "wiki/index.md",
    "wiki/log.md",
    "wiki/_template.md",
    "wiki/concepts/deploy.md",
    "wiki/한글 노트.md",
    "wiki/한글.md".normalize("NFD"),
    "raw/2026/11/source.md",
    "./raw/a.md",
    "/wiki/a.md",
    "wiki//a.md",
    "wiki/a.b.md",
  ])("%j is a vault note", (rel) => {
    expect(isPersonalVaultPath(rel)).toBe(true);
  });

  it.each([
    "",
    ".",
    "wiki",
    "wiki/",
    "raw",
    "README.md",
    "claude.md",
    "docs/CLAUDE.md",
    "wiki/CLAUDE.txt",
    "wiki/.gitkeep",
    "wiki/a.MD",
    "wiki/a.md/",
    "wiki/.md",
    "wiki/image.png",
    "wiki/a.md.bak",
    "raw/source.pdf",
    "WIKI/a.md",
    "wikis/a.md",
    "rawdata/a.md",
    "skills/x/SKILL.md",
    ".claude-plugin/plugin.json",
    "../wiki/a.md",
    "wiki/../../wiki/a.md",
    "wiki/../README.md",
    "notes/wiki/a.md",
    // What the memory service's path rules refuse stays a repo path (it can never be a note there).
    "wiki/.obsidian/workspace.md",
    "wiki/.hidden.md",
    "raw/.trash/old.md",
    "wiki/a\\b.md",
    "wiki/a\tb.md",
    "wiki/a\nb.md",
    `wiki/${Array.from({ length: 16 }, () => "d").join("/")}.md`,
    `wiki/${"x".repeat(256)}.md`,
    `wiki/${Array.from({ length: 3 }, () => "y".repeat(200)).join("/")}.md`,
  ])("%j is a repo path", (rel) => {
    expect(isPersonalVaultPath(rel)).toBe(false);
  });

  it("accepts exactly what the service's limits allow", () => {
    // 16 parts in all (wiki + 14 folders + the note) and a 255-byte name are the service's maximum.
    expect(isPersonalVaultPath(`wiki/${Array.from({ length: 14 }, () => "d").join("/")}/n.md`)).toBe(true);
    expect(isPersonalVaultPath(`wiki/${"x".repeat(252)}.md`)).toBe(true);
    expect(isPersonalVaultPath(`wiki/${"x".repeat(253)}.md`)).toBe(false);
  });

  it("every vault path is one the service's own rules accept, and no repo path under wiki/ is", async () => {
    const fake = createFakeMemoryClient();
    for (const rel of ["CLAUDE.md", "wiki/a.md", "raw/x/y.md", "wiki/한글.md".normalize("NFD"), `wiki/${"x".repeat(252)}.md`]) {
      expect(isPersonalVaultPath(rel)).toBe(true);
      await expect(fake.put("u1", normalizeVaultPath(rel), "x")).resolves.toMatchObject({ created: true });
    }
    for (const rel of ["wiki/.obsidian/workspace.md", "wiki/a\\b.md", `wiki/${"x".repeat(253)}.md`, "wiki/image.png"]) {
      expect(isPersonalVaultPath(rel)).toBe(false);
      await expect(fake.put("u1", rel, "x")).rejects.toMatchObject({ code: "invalid_path" });
    }
  });
});

describe("personal vault store: pending repository imports", () => {
  it("records, advances and clears an owner's pending import", () => {
    const { store, ownerId, otherId } = setup();
    expect(store.listVaultImports()).toEqual({});
    store.setVaultImport(ownerId, "check");
    store.setVaultImport(otherId, "check");
    store.setVaultImport(ownerId, "import");
    expect(store.listVaultImports()).toEqual({ [ownerId]: "import", [otherId]: "check" });
    store.clearVaultImport(ownerId);
    store.clearVaultImport(ownerId);
    expect(store.listVaultImports()).toEqual({ [otherId]: "check" });
    store.clearVaultImport(otherId);
    expect(store.listVaultImports()).toEqual({});
  });

  it("retires the vault tables of an older build, and hands over the owners who were never moved — once", () => {
    const dataDir = path.join(getTempDir(), "old-build");
    const boot = () => createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const tables = (db: Database.Database) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'personal_vault%'").all() as { name: string }[]).map((t) => t.name);

    // A database of this build has neither table.
    const first = boot();
    const dbPath = first.config.dbPath;
    const moved = first.store.createUser({ username: "moved", displayName: "Moved", password: "password123" }).id;
    const unmoved = first.store.createUser({ username: "unmoved", displayName: "Unmoved", password: "password123" }).id;
    const noRepo = first.store.createUser({ username: "norepo", displayName: "No repo", password: "password123" }).id;
    first.store.setKnowledgeRepo(moved, "moved/brain", "main");
    first.store.setKnowledgeRepo(unmoved, "unmoved/brain", "main");
    first.store.close();
    const db = new Database(dbPath);
    expect(tables(db)).toEqual([]);

    // The tables as the build before the retirement left them: one owner moved, one with a repository but no row.
    db.exec(`
      CREATE TABLE personal_vaults (
        user_id TEXT PRIMARY KEY, migrated_at TEXT NOT NULL, source_repo TEXT NOT NULL, source_commit TEXT,
        mirror_dirty INTEGER NOT NULL DEFAULT 0, mirror_seq INTEGER NOT NULL DEFAULT 0, mirror_synced_at TEXT,
        mirror_error TEXT, mirror_notice TEXT, mirror_hold_state TEXT
      );
      CREATE TABLE personal_vault_deletes (user_id TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, path));
    `);
    db.prepare("INSERT INTO personal_vaults (user_id, migrated_at, source_repo, mirror_dirty) VALUES (?, ?, ?, 1)").run(moved, "2026-11-18T00:00:00.000Z", "moved/brain");
    db.prepare("INSERT INTO personal_vault_deletes (user_id, path, created_at) VALUES (?, ?, ?)").run(moved, "wiki/gone.md", "2026-11-18T00:00:00.000Z");
    db.close();

    // The boot backs the database up first, then drops both tables.
    const second = boot();
    const backups = fs.readdirSync(path.join(dataDir, "backups")).filter((name) => name.startsWith("pre-retire-"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(dataDir, "backups", backups[0]!), { readonly: true });
    expect(tables(backup).sort()).toEqual(["personal_vault_deletes", "personal_vaults"]);
    backup.close();
    // The owner with a repository and no row is handed to the import as a pending look — the moved one and
    // the one without a repository are not.
    expect(second.store.takeVaultImportStragglers()).toEqual([unmoved]);
    expect(second.store.listVaultImports()).toEqual({ [unmoved]: "check" });
    expect(second.store.takeVaultImportStragglers()).toEqual([]);
    void noRepo;
    second.store.close();
    const after = new Database(dbPath);
    expect(tables(after)).toEqual([]);
    after.close();

    // Nothing to retire on the next boot: no second backup, nobody handed over again.
    const third = boot();
    expect(fs.readdirSync(path.join(dataDir, "backups")).filter((name) => name.startsWith("pre-retire-"))).toHaveLength(1);
    expect(third.store.takeVaultImportStragglers()).toEqual([]);
    expect(third.store.listVaultImports()).toEqual({ [unmoved]: "check" });
    third.store.close();
  });
});

describe("memoryVaultFor", () => {
  it("is every owner's vault — nobody is on another home", async () => {
    const { store, config, ownerId, otherId } = setup();
    const fake = createFakeMemoryClient();
    setMemoryClientForTests(store, fake);
    await memoryVaultFor(store, config, ownerId).write("wiki/a.md", "mine");
    await memoryVaultFor(store, config, otherId).write("wiki/a.md", "theirs");
    expect(fake.dump(ownerId)).toEqual({ "wiki/a.md": "mine" });
    expect(fake.dump(otherId)).toEqual({ "wiki/a.md": "theirs" });
  });

  it("on a server without a memory service the vault is unavailable on every method, never empty", async () => {
    const { store, config, ownerId } = setup();
    const vault = memoryVaultFor(store, config, ownerId);
    for (const call of [
      () => vault.list(),
      () => vault.read("wiki/a.md"),
      () => vault.exists("wiki/a.md"),
      () => vault.write("wiki/a.md", "x"),
      () => vault.edit("wiki/a.md", "a", "b"),
      () => vault.remove("wiki/a.md"),
      () => vault.search("x"),
    ]) {
      const error = await failure(call());
      expect(error).toBeInstanceOf(MemoryUnavailableError);
      expect((error as MemoryUnavailableError).reason).toBe("not_configured");
    }
  });
});

describe("MemoryVault: notes", () => {
  it("writes a new note, replaces it, reads it back", async () => {
    const { vault, fake, ownerId } = setupVault();
    expect(vault.userId).toBe(ownerId);
    expect(await vault.write("wiki/a.md", "one")).toEqual({ created: true });
    expect(await vault.read("wiki/a.md")).toBe("one");
    expect(await vault.write("wiki/a.md", "two")).toEqual({ created: false });
    expect(await vault.read("wiki/a.md")).toBe("two");
    expect(await vault.write("CLAUDE.md", "# me")).toEqual({ created: true });
    expect(fake.dump(ownerId)).toEqual({ "CLAUDE.md": "# me", "wiki/a.md": "two" });
  });

  it("stores under the normalized path, whatever the spelling", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("./wiki//한글.md".normalize("NFD"), "x");
    await vault.write("/raw/b/../a.md", "y");
    expect(Object.keys(fake.dump(ownerId))).toEqual(["raw/a.md", "wiki/한글.md"]);
    expect(await vault.read("wiki/한글.md")).toBe("x");
    expect(await vault.exists("/raw/a.md")).toBe(true);
  });

  it("a missing note: read throws NOT_FOUND, exists is false", async () => {
    const { vault } = setupVault();
    expect(await message(vault.read("wiki/missing.md"))).toBe("NOT_FOUND");
    expect(await vault.exists("wiki/missing.md")).toBe(false);
    await vault.write("wiki/a.md", "x");
    expect(await vault.exists("wiki/a.md")).toBe(true);
  });

  it("lists vault notes only, in path order", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/b.md", "bb");
    await vault.write("raw/z.md", "z");
    await vault.write("CLAUDE.md", "한글");
    await vault.write("wiki/a/deep.md", "d");
    // Notes something else left in the same wiki are not this vault's.
    fake.seed(ownerId, "projects/deploy.md", "other");
    fake.seed(ownerId, "notes.md", "other");
    expect(await vault.list()).toEqual([
      { path: "CLAUDE.md", bytes: 6 },
      { path: "raw/z.md", bytes: 1 },
      { path: "wiki/a/deep.md", bytes: 1 },
      { path: "wiki/b.md", bytes: 2 },
    ]);
  });

  it("refuses a path that is not a vault note with INVALID_PATH, on every method, without calling the service", async () => {
    const { vault, fake, store, ownerId } = setupVault();
    for (const rel of ["README.md", "skills/x/SKILL.md", "wiki/image.png", "wiki/.obsidian/x.md", "../wiki/a.md", "wiki", ""]) {
      expect(await message(vault.read(rel)), rel).toBe("INVALID_PATH");
      expect(await message(vault.exists(rel)), rel).toBe("INVALID_PATH");
      expect(await message(vault.write(rel, "x")), rel).toBe("INVALID_PATH");
      expect(await message(vault.edit(rel, "a", "b")), rel).toBe("INVALID_PATH");
      expect(await message(vault.remove(rel)), rel).toBe("INVALID_PATH");
    }
    expect(fake.calls).toEqual([]);
  });

  it("a note over 512 KiB is FILE_TOO_LARGE, by Noah's own check and by the service's refusal", async () => {
    const { vault, fake, ownerId } = setupVault();
    const atLimit = "x".repeat(VAULT_NOTE_MAX_BYTES);
    expect(await vault.write("wiki/big.md", atLimit)).toEqual({ created: true });
    expect(await message(vault.write("wiki/big.md", `${atLimit}y`))).toBe("FILE_TOO_LARGE");
    // 한 글자 = 3 bytes: the limit is bytes, not characters.
    expect(await message(vault.write("wiki/k.md", "가".repeat(VAULT_NOTE_MAX_BYTES / 3 + 1)))).toBe("FILE_TOO_LARGE");
    expect(fake.dump(ownerId)["wiki/big.md"]).toHaveLength(VAULT_NOTE_MAX_BYTES);

    for (const code of ["too_large", "body_too_large"]) {
      fake.failNext(new MemoryRefusedError(code, 413), { op: "put" });
      const error = (await failure(vault.write("wiki/a.md", "x"))) as Error;
      expect(error.message).toBe("FILE_TOO_LARGE");
      expect(error.cause).toBeInstanceOf(MemoryRefusedError);
    }
  });

  it("maps the service's invalid_path to INVALID_PATH and passes other refusals on as they are", async () => {
    const { vault, fake } = setupVault();
    fake.failNext(new MemoryRefusedError("invalid_path", 400), { op: "read" });
    expect(await message(vault.read("wiki/a.md"))).toBe("INVALID_PATH");

    fake.failNext(new MemoryRefusedError("wiki_full", 507, "this wiki already holds 10000 notes"), { op: "put" });
    const full = await failure(vault.write("wiki/a.md", "x"));
    expect(full).toBeInstanceOf(MemoryRefusedError);
    expect(full).toMatchObject({ code: "wiki_full", status: 507 });

    // NUL is refused by the service itself (the fake keeps that rule).
    const nul = await failure(vault.write("wiki/a.md", "a\0b"));
    expect(nul).toMatchObject({ name: "MemoryRefusedError", code: "invalid_content" });
  });

  it("removes a note; a missing note is a no-op", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/a.md", "x");
    await vault.write("wiki/b.md", "y");
    await expect(vault.remove("wiki/a.md")).resolves.toBeUndefined();
    expect(fake.dump(ownerId)).toEqual({ "wiki/b.md": "y" });
    await expect(vault.remove("wiki/a.md")).resolves.toBeUndefined();
    await expect(vault.remove("wiki/never.md")).resolves.toBeUndefined();
    expect(fake.dump(ownerId)).toEqual({ "wiki/b.md": "y" });
    // Nothing was sent for the missing ones.
    expect(fake.calls.filter((call) => call.op === "remove")).toHaveLength(1);
  });

  it("keeps owners apart", async () => {
    const { vault, fake, store, config, ownerId, otherId } = setupVault();
    const theirs = memoryVaultFor(store, config, otherId);
    await vault.write("wiki/a.md", "mine");
    await theirs.write("wiki/a.md", "theirs");
    expect(await vault.read("wiki/a.md")).toBe("mine");
    expect(await theirs.read("wiki/a.md")).toBe("theirs");
    expect(fake.dump(ownerId)).toEqual({ "wiki/a.md": "mine" });
    expect(fake.dump(otherId)).toEqual({ "wiki/a.md": "theirs" });
  });
});

describe("MemoryVault: edit (knowledgeRepo.editFile's contract)", () => {
  it("replaces the one occurrence and returns 1", async () => {
    const { vault } = setupVault();
    await vault.write("wiki/a.md", "alpha beta gamma");
    expect(await vault.edit("wiki/a.md", "beta", "BETA")).toBe(1);
    expect(await vault.read("wiki/a.md")).toBe("alpha BETA gamma");
  });

  it("throws the sentinels: NO_CHANGE, NOT_FOUND, STRING_NOT_FOUND, STRING_NOT_UNIQUE, FILE_TOO_LARGE", async () => {
    const { vault, fake } = setupVault();
    await vault.write("wiki/a.md", "one two two");
    const puts = () => fake.calls.filter((call) => call.op === "put").length;
    const before = puts();

    expect(await message(vault.edit("wiki/a.md", "", "x"))).toBe("NO_CHANGE");
    expect(await message(vault.edit("wiki/a.md", "one", "one"))).toBe("NO_CHANGE");
    // NO_CHANGE is judged before the path, as in editFile.
    expect(await message(vault.edit("README.md", "same", "same"))).toBe("NO_CHANGE");
    expect(await message(vault.edit("wiki/missing.md", "a", "b"))).toBe("NOT_FOUND");
    expect(await message(vault.edit("wiki/a.md", "three", "x"))).toBe("STRING_NOT_FOUND");
    expect(await message(vault.edit("wiki/a.md", "two", "x"))).toBe("STRING_NOT_UNIQUE");
    expect(await message(vault.edit("wiki/a.md", "one", "x".repeat(VAULT_NOTE_MAX_BYTES)))).toBe("FILE_TOO_LARGE");

    expect(await vault.read("wiki/a.md")).toBe("one two two");
    expect(puts()).toBe(before);
  });

  it("replaceAll replaces every occurrence and returns the count", async () => {
    const { vault } = setupVault();
    await vault.write("wiki/a.md", "a-b-a-b-a");
    expect(await vault.edit("wiki/a.md", "a", "X", true)).toBe(3);
    expect(await vault.read("wiki/a.md")).toBe("X-b-X-b-X");
    // One occurrence with replaceAll is still 1.
    expect(await vault.edit("wiki/a.md", "X-b-X-b-X", "done", true)).toBe(1);
  });

  it("inserts the new text literally ($& and $1 are not match references)", async () => {
    const { vault } = setupVault();
    await vault.write("wiki/a.md", "price: PLACEHOLDER");
    await vault.edit("wiki/a.md", "PLACEHOLDER", "$& and $1 and $$");
    expect(await vault.read("wiki/a.md")).toBe("price: $& and $1 and $$");
  });
});


describe("MemoryVault: the service cannot be used", () => {
  it("passes MemoryUnavailableError through untouched from every method — never NOT_FOUND, never an empty result", async () => {
    const { vault, fake } = setupVault();
    await vault.write("wiki/a.md", "alpha");
    const calls: [string, () => Promise<unknown>][] = [
      ["list", () => vault.list()],
      ["read", () => vault.read("wiki/a.md")],
      ["exists", () => vault.exists("wiki/a.md")],
      ["write", () => vault.write("wiki/a.md", "x")],
      ["edit", () => vault.edit("wiki/a.md", "alpha", "beta")],
      ["remove", () => vault.remove("wiki/a.md")],
      ["search", () => vault.search("alpha")],
    ];
    for (const [name, call] of calls) {
      const outage = new MemoryUnavailableError("memory service unavailable (x): HTTP 500", "server_error");
      fake.failNext(outage);
      expect(await failure(call()), name).toBe(outage);
    }
    expect(await vault.read("wiki/a.md")).toBe("alpha");
  });

  it("an outage on the second step (the write itself) passes through as well", async () => {
    const { vault, fake } = setupVault();
    await vault.write("wiki/a.md", "alpha");
    for (const [op, call] of [
      ["put", () => vault.write("wiki/a.md", "x")],
      ["put", () => vault.edit("wiki/a.md", "alpha", "beta")],
      ["remove", () => vault.remove("wiki/a.md")],
    ] as const) {
      const outage = new MemoryUnavailableError();
      fake.failNext(outage, { op });
      expect(await failure(call())).toBe(outage);
    }
    expect(await vault.read("wiki/a.md")).toBe("alpha");
  });

  it("a search that could not check for a vault fails, it does not say no_vault", async () => {
    const { vault, fake } = setupVault();
    const outage = new MemoryUnavailableError();
    fake.failNext(outage, { op: "list" });
    expect(await failure(vault.search("nothing matches this"))).toBe(outage);
  });
});

describe("MemoryVault: writes of one owner are serialized", () => {
  it("two concurrent writes both land", async () => {
    const { vault, fake, ownerId, store } = setupVault();
    const results = await Promise.all([vault.write("wiki/a.md", "A"), vault.write("wiki/b.md", "B")]);
    expect(results).toEqual([{ created: true }, { created: true }]);
    expect(fake.dump(ownerId)).toEqual({ "wiki/a.md": "A", "wiki/b.md": "B" });
  });

  it("concurrent writes of the SAME note run one after the other: the last one wins, none is refused", async () => {
    const { vault, fake, ownerId } = setupVault();
    const results = await Promise.all([
      vault.write("wiki/a.md", "first"),
      vault.write("wiki/a.md", "second"),
      vault.write("wiki/a.md", "third"),
    ]);
    expect(results).toEqual([{ created: true }, { created: false }, { created: false }]);
    expect(fake.dump(ownerId)).toEqual({ "wiki/a.md": "third" });
    // read → put, read → put, read → put: never two reads in a row.
    expect(fake.calls.map((call) => call.op)).toEqual(["read", "put", "read", "put", "read", "put"]);
  });

  it("concurrent edits of one note all land (no edit is lost to another's stale read)", async () => {
    const { vault, ownerId, fake } = setupVault();
    await vault.write("wiki/log.md", "start\nEND");
    const counts = await Promise.all(Array.from({ length: 6 }, (_, i) => vault.edit("wiki/log.md", "END", `line ${i}\nEND`)));
    expect(counts).toEqual([1, 1, 1, 1, 1, 1]);
    expect(fake.dump(ownerId)["wiki/log.md"]).toBe("start\nline 0\nline 1\nline 2\nline 3\nline 4\nline 5\nEND");
  });

  it("a failed write does not block the next one", async () => {
    const { vault, fake, ownerId } = setupVault();
    fake.failNext(new MemoryUnavailableError(), { op: "put" });
    const [first, second] = await Promise.all([failure(vault.write("wiki/a.md", "A")), vault.write("wiki/b.md", "B")]);
    expect(first).toBeInstanceOf(MemoryUnavailableError);
    expect(second).toEqual({ created: true });
    expect(fake.dump(ownerId)).toEqual({ "wiki/b.md": "B" });
  });

  it("different owners do not wait for each other", async () => {
    const { vault, store, config, otherId, fake } = setupVault();
    const theirs = memoryVaultFor(store, config, otherId);
    let release!: () => void;
    const held = withVaultWriteLock(store, otherId, () => new Promise<void>((resolve) => (release = resolve)));
    await vault.write("wiki/a.md", "mine");
    const pending = theirs.write("wiki/a.md", "theirs");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.dump(otherId)).toEqual({});
    release();
    await held;
    await pending;
    expect(fake.dump(otherId)).toEqual({ "wiki/a.md": "theirs" });
  });

  it("retries once when the note changed between its read and its write (a writer outside Noah)", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/a.md", "v1");
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/a.md", "changed elsewhere"));
    expect(await vault.write("wiki/a.md", "v2")).toEqual({ created: false });
    expect(fake.dump(ownerId)["wiki/a.md"]).toBe("v2");

    // The same for a note created in between (`exists`)…
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/new.md", "created elsewhere"));
    expect(await vault.write("wiki/new.md", "mine")).toEqual({ created: false });
    expect(fake.dump(ownerId)["wiki/new.md"]).toBe("mine");

    // …an edit, which is redone on the text that is there now…
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/a.md", "v2 plus more"));
    expect(await vault.edit("wiki/a.md", "v2", "v3")).toBe(1);
    expect(fake.dump(ownerId)["wiki/a.md"]).toBe("v3 plus more");

    // …and a delete.
    fake.beforeNext("remove", () => fake.seed(ownerId, "wiki/a.md", "changed again"));
    await vault.remove("wiki/a.md");
    expect(fake.dump(ownerId)["wiki/a.md"]).toBeUndefined();
  });

  it("gives up after that one retry and passes the refusal on", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/a.md", "v1");
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/a.md", "x1"));
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/a.md", "x2"));
    const error = await failure(vault.write("wiki/a.md", "v2"));
    expect(error).toMatchObject({ name: "MemoryRefusedError", code: "stale" });
    expect(fake.dump(ownerId)["wiki/a.md"]).toBe("x2");
  });

  it("an edit whose text vanished in between reports STRING_NOT_FOUND on the retry", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/a.md", "keep this");
    fake.beforeNext("put", () => fake.seed(ownerId, "wiki/a.md", "rewritten"));
    expect(await message(vault.edit("wiki/a.md", "keep", "kept"))).toBe("STRING_NOT_FOUND");
    expect(fake.dump(ownerId)["wiki/a.md"]).toBe("rewritten");
  });
});

describe("withVaultWrite: one writer at a time per owner", () => {
  it("hands the owner a vault that writes without queueing again", async () => {
    const { store, config, fake, ownerId } = setupVault();
    const result = await withVaultWrite(store, config, ownerId, async (vault: MemoryVaultWriter) => {
      expect(vault.inQueue).toBe(true);
      expect(vault.userId).toBe(ownerId);
      // Several changes in ONE turn of the queue — a move is a write and a remove with nothing in between.
      expect(await vault.write("wiki/old.md", "alpha beta")).toEqual({ created: true });
      expect(await vault.edit("wiki/old.md", "beta", "gamma")).toBe(1);
      await vault.write("wiki/new.md", await vault.read("wiki/old.md"));
      await vault.remove("wiki/old.md");
      return { listed: (await vault.list()).map((entry) => entry.path), exists: await vault.exists("wiki/old.md") };
    });
    expect(result).toEqual({ listed: ["wiki/new.md"], exists: false });
    expect(fake.dump(ownerId)).toEqual({ "wiki/new.md": "alpha gamma" });
  });

  it("the handed-out vault keeps the public vault's errors", async () => {
    const { store, config, fake, ownerId } = setupVault();
    await withVaultWrite(store, config, ownerId, async (vault) => {
      expect(await message(vault.write("README.md", "x"))).toBe("INVALID_PATH");
      expect(await message(vault.edit("wiki/missing.md", "a", "b"))).toBe("NOT_FOUND");
      expect(await message(vault.write("wiki/big.md", "x".repeat(VAULT_NOTE_MAX_BYTES + 1)))).toBe("FILE_TOO_LARGE");
      const outage = new MemoryUnavailableError();
      fake.failNext(outage);
      expect(await failure(vault.write("wiki/a.md", "x"))).toBe(outage);
    });
    expect(fake.dump(ownerId)).toEqual({});
  });


  it("is the same queue as the public vault's writes and withVaultWriteLock", async () => {
    const { store, config, vault, fake, ownerId } = setupVault();
    const order: string[] = [];
    // Noted while the public write is being carried out (its put), not when its caller hears of it.
    fake.beforeNext("put", () => void order.push("public write"));
    let release!: () => void;
    const first = withVaultWrite(store, config, ownerId, async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first:end");
    });
    const second = vault.write("wiki/a.md", "x");
    const third = withVaultWriteLock(store, ownerId, async () => {
      order.push("lock");
    });
    const fourth = withVaultWrite(store, config, ownerId, async () => {
      order.push("fourth");
    });
    await tick();
    await tick();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second, third, fourth]);
    expect(order).toEqual(["first:start", "first:end", "public write", "lock", "fourth"]);
  });

  it("two owners do not block each other", async () => {
    const { store, config, fake, ownerId, otherId } = setupVault();
    let release!: () => void;
    const held = withVaultWrite(store, config, ownerId, () => new Promise<void>((resolve) => (release = resolve)));
    await tick();
    // The other owner's write runs to its end while the first owner's queue is still held.
    const theirs = await withVaultWrite(store, config, otherId, (vault) => vault.write("wiki/a.md", "theirs"));
    expect(theirs).toEqual({ created: true });
    expect(fake.dump(otherId)).toEqual({ "wiki/a.md": "theirs" });
    // …and the first owner's own next write is still waiting.
    let done = false;
    const waiting = withVaultWrite(store, config, ownerId, async () => {
      done = true;
    });
    await tick();
    await tick();
    expect(done).toBe(false);
    release();
    await held;
    await waiting;
    expect(done).toBe(true);
  });

  it("a callback that fails passes its error on and does not block the next write", async () => {
    const { store, config, fake, ownerId } = setupVault();
    const boom = new Error("clone write failed");
    const [first, second] = await Promise.all([
      failure(
        withVaultWrite(store, config, ownerId, async () => {
          throw boom;
        }),
      ),
      withVaultWrite(store, config, ownerId, (vault) => vault.write("wiki/a.md", "x")),
    ]);
    expect(first).toBe(boom);
    expect(second).toEqual({ created: true });
    expect(fake.dump(ownerId)).toEqual({ "wiki/a.md": "x" });
  });

  it("the handed-out vault stops writing once the callback is over", async () => {
    const { store, config, fake, ownerId } = setupVault();
    let kept: MemoryVaultWriter | null = null;
    await withVaultWrite(store, config, ownerId, async (handed) => {
      kept = handed;
    });
    const vault = kept as MemoryVaultWriter | null;
    expect(vault).not.toBeNull();
    expect(await message(vault!.write("wiki/a.md", "x"))).toBe(VAULT_WRITER_CLOSED);
    expect(await message(vault!.edit("wiki/a.md", "a", "b"))).toBe(VAULT_WRITER_CLOSED);
    expect(await message(vault!.remove("wiki/a.md"))).toBe(VAULT_WRITER_CLOSED);
    expect(fake.calls).toEqual([]);
    // Reads were never the queue's business.
    expect(await vault!.exists("wiki/a.md")).toBe(false);
  });

  it("on a server without a memory service the handed-out vault's writes are unavailable", async () => {
    const { store, config, ownerId } = setup();
    const error = await failure(withVaultWrite(store, config, ownerId, (vault) => vault.write("wiki/a.md", "x")));
    expect(error).toBeInstanceOf(MemoryUnavailableError);
    expect((error as MemoryUnavailableError).reason).toBe("not_configured");
  });
});

describe("MemoryVault: search (the personal brain)", () => {
  const note = (title: string, body: string, tags: string[] = []) =>
    `---\ntitle: ${title}\ntags: [${tags.join(", ")}]\n---\n${body}\n`;

  it("says no_vault when the service holds no note under wiki/ or raw/", async () => {
    const { vault, fake, ownerId } = setupVault();
    expect(await vault.search("anything")).toEqual({ kind: "no_vault" });
    await vault.write("CLAUDE.md", "anything at all");
    fake.seed(ownerId, "projects/anything.md", "anything");
    expect(await vault.search("anything")).toEqual({ kind: "no_vault" });
  });

  it("a vault with nothing that matches is ok with no hits — raw/ alone counts as a vault", async () => {
    const { vault } = setupVault();
    await vault.write("raw/source.md", "captured text about deploys");
    // raw/ is not searched, but it is a vault.
    expect(await vault.search("deploys")).toEqual({ kind: "ok", hits: [] });
    await vault.write("wiki/a.md", note("Alpha", "body"));
    expect(await vault.search("zebra")).toEqual({ kind: "ok", hits: [] });
  });

  it("ranks wiki notes: title 5, tags 3, body 1; ties by path", async () => {
    const { vault } = setupVault();
    await vault.write("wiki/c.md", note("Other", "mentions deploy once"));
    await vault.write("wiki/b.md", note("Deploy guide", "how to deploy", ["deploy"]));
    await vault.write("wiki/a.md", note("Other", "deploy here too"));
    await vault.write("wiki/d.md", note("Unrelated", "nothing"));
    const result = await vault.search("deploy");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.hits.map((hit) => [hit.path, hit.score])).toEqual([
      ["wiki/b.md", 9],
      ["wiki/a.md", 1],
      ["wiki/c.md", 1],
    ]);
    expect(result.hits[0]).toEqual({ path: "wiki/b.md", title: "Deploy guide", tags: ["deploy"], snippet: "how to deploy", score: 9 });
    expect(result).not.toHaveProperty("unscanned");
  });

  it("searches wiki/ only and drops wiki/index.md, wiki/log.md and every *_template.md", async () => {
    const { vault, fake, ownerId } = setupVault();
    await vault.write("wiki/index.md", note("needle index", "needle"));
    await vault.write("wiki/log.md", note("needle log", "needle"));
    await vault.write("wiki/_template.md", note("needle template", "needle"));
    await vault.write("wiki/projects/page_template.md", note("needle page template", "needle"));
    await vault.write("raw/needle.md", note("needle raw", "needle"));
    await vault.write("CLAUDE.md", "needle");
    fake.seed(ownerId, "projects/needle.md", "needle");
    await vault.write("wiki/real.md", note("needle real", "needle"));
    // Named like the structural pages, but elsewhere: ordinary notes.
    await vault.write("wiki/projects/index.md", note("needle sub index", "needle"));
    await vault.write("wiki/projects/log.md", note("needle sub log", "needle"));
    const result = await vault.search("needle");
    expect(result).toMatchObject({ kind: "ok" });
    if (result.kind !== "ok") return;
    expect(result.hits.map((hit) => hit.path)).toEqual(["wiki/projects/index.md", "wiki/projects/log.md", "wiki/real.md"]);
    expect(fake.calls.filter((call) => call.op === "search").every((call) => call.prefix === "wiki")).toBe(true);
  });

  it("asks the service for more than the limit, so dropped structural pages do not cost real hits", async () => {
    const { vault, fake } = setupVault();
    // The structural pages outrank every real note.
    await vault.write("wiki/index.md", note("needle needle", "needle", ["needle"]));
    await vault.write("wiki/log.md", note("needle", "needle", ["needle"]));
    await vault.write("wiki/_template.md", note("needle", "needle", ["needle"]));
    for (const name of ["a", "b", "c", "d"]) await vault.write(`wiki/${name}.md`, note("plain", "needle"));

    const two = await vault.search("needle", 2);
    expect(two.kind === "ok" && two.hits.map((hit) => hit.path)).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(fake.calls.filter((call) => call.op === "search").map((call) => call.limit)).toEqual([5]);

    const dflt = await vault.search("needle");
    expect(dflt.kind === "ok" && dflt.hits.map((hit) => hit.path)).toEqual(["wiki/a.md", "wiki/b.md", "wiki/c.md", "wiki/d.md"]);
    expect(fake.calls.filter((call) => call.op === "search").map((call) => call.limit)).toEqual([5, 11]);
  });

  it("asks again for the service's maximum when more templates than expected were in the way", async () => {
    const { vault, fake } = setupVault();
    await vault.write("wiki/index.md", note("needle", "needle", ["needle"]));
    await vault.write("wiki/log.md", note("needle", "needle", ["needle"]));
    for (const name of ["x", "y", "z"]) await vault.write(`wiki/t/${name}_template.md`, note("needle", "needle", ["needle"]));
    for (const name of ["a", "b", "c"]) await vault.write(`wiki/${name}.md`, note("plain", "needle"));
    const result = await vault.search("needle", 2);
    expect(result.kind === "ok" && result.hits.map((hit) => hit.path)).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(fake.calls.filter((call) => call.op === "search").map((call) => call.limit)).toEqual([5, 20]);
  });

  it("clamps the limit to 1..20 like rankBrainNotes", async () => {
    const { vault, fake } = setupVault();
    for (let i = 0; i < 25; i += 1) await vault.write(`wiki/n${String(i).padStart(2, "0")}.md`, "needle");
    const sizes = async (limit: number) => {
      const result = await vault.search("needle", limit);
      return result.kind === "ok" ? result.hits.length : -1;
    };
    expect(await sizes(0)).toBe(1);
    expect(await sizes(-5)).toBe(1);
    expect(await sizes(3)).toBe(3);
    expect(await sizes(2.9)).toBe(2);
    expect(await sizes(20)).toBe(20);
    expect(await sizes(500)).toBe(20);
    expect(await sizes(Number.NaN)).toBe(8);
    // Never a limit the service refuses.
    expect(fake.calls.filter((call) => call.op === "search").every((call) => Number.isInteger(call.limit) && call.limit! >= 1 && call.limit! <= 20)).toBe(true);
  });

  it("a query without a word is no hit (not the service's refusal), and still tells a vault from none", async () => {
    const { vault, fake, ownerId } = setupVault();
    expect(await vault.search("   ")).toEqual({ kind: "no_vault" });
    await vault.write("wiki/a.md", "text?! --- …");
    expect(await vault.search("")).toEqual({ kind: "ok", hits: [] });
    // Symbols only: the service has no word to look for either (pi 1d4a1fe refuses it with invalid_query).
    for (const symbols of ["?!", "---", " … ", "@#$%", "😀"]) {
      expect(await vault.search(symbols), symbols).toEqual({ kind: "ok", hits: [] });
    }
    expect(fake.calls.some((call) => call.op === "search")).toBe(false);
    // The double refuses what the service refuses — the reason none of the above may be sent.
    await expect(fake.search(ownerId, "?!")).rejects.toMatchObject({ code: "invalid_query", status: 400 });
    // One letter or digit is a word: sent, and answered by the service.
    expect(await vault.search("7x9")).toEqual({ kind: "ok", hits: [] });
    expect(fake.calls.filter((call) => call.op === "search").map((call) => call.query)).toEqual(["?!", "7x9"]);
  });

  it.each(["utf16", "codePoints"] as const)(
    "cuts a query to 500 UTF-16 units, never splitting a surrogate pair — accepted by a service that counts %s",
    async (queryLength) => {
      const { store, config, ownerId } = setupVault();
      const fake = createFakeMemoryClient({ queryLength });
      setMemoryClientForTests(store, fake);
      const vault = memoryVaultFor(store, config, ownerId)!;
      await vault.write("wiki/a.md", "needle");
      const sent = () => fake.calls.filter((call) => call.op === "search").map((call) => call.query!);
      // A refusal would reject: every call below resolving IS the service accepting what was sent.
      const paths = async (query: string) => {
        const result = await vault.search(query);
        return result.kind === "ok" ? result.hits.map((hit) => hit.path) : result.kind;
      };

      // The service itself refuses the long query…
      const long = `needle ${"x".repeat(600)}`;
      await expect(fake.search(ownerId, long)).rejects.toMatchObject({ code: "invalid_request", status: 400 });
      fake.calls.length = 0;
      // …the vault sends its first 500 units, and the words in them still match.
      expect(await paths(long)).toEqual(["wiki/a.md"]);
      expect(sent()).toEqual([long.slice(0, 500)]);

      // Exactly 500 goes as it is.
      const exact = `needle ${"y".repeat(493)}`;
      expect(exact).toHaveLength(500);
      expect(await paths(exact)).toEqual(["wiki/a.md"]);
      expect(sent().at(-1)).toBe(exact);

      // A pair the cut would split is left out whole (499 units go)…
      const straddling = `needle ${"z".repeat(492)}😀 tail`;
      expect(straddling.slice(0, 500).charCodeAt(499)).toBe(0xd83d);
      expect(await paths(straddling)).toEqual(["wiki/a.md"]);
      expect(sent().at(-1)).toBe(`needle ${"z".repeat(492)}`);
      // …and one that ends exactly at the cut is kept.
      const fitting = `needle ${"z".repeat(491)}😀 tail`;
      expect(await paths(fitting)).toEqual(["wiki/a.md"]);
      expect(sent().at(-1)).toBe(`needle ${"z".repeat(491)}😀`);
      expect(sent().at(-1)).toHaveLength(500);

      // Nothing but pairs holds no word: answered here as no hit, never sent (the service would refuse it).
      const sentBefore = sent().length;
      expect(await paths("😀".repeat(600))).toEqual([]);
      expect(sent()).toHaveLength(sentBefore);
      // Pairs after a word, at even offsets: 249 of them fill the 500 units (a service counting code points would take 500).
      expect(await paths(`xx${"😀".repeat(600)}`)).toEqual([]);
      expect(sent().at(-1)).toBe(`xx${"😀".repeat(249)}`);
      // The reviewers' case: 602 units but only 302 code points — still cut to 500 units (a unit-counting service refuses it whole).
      expect(await paths(`xx${"😀".repeat(300)}`)).toEqual([]);
      expect(sent().at(-1)).toBe(`xx${"😀".repeat(249)}`);
      // Pairs at odd offsets: the cut falls inside one.
      expect(await paths(`x${"😀".repeat(600)}`)).toEqual([]);
      expect(sent().at(-1)).toBe(`x${"😀".repeat(249)}`);

      // Never more than 500 units, never half a pair — whatever the service's rule.
      for (const query of sent()) {
        expect(query.length).toBeLessThanOrEqual(500);
        expect(LONE_SURROGATE.test(query)).toBe(false);
      }

      // What is left after the cut decides: only blanks in the first 500 is a query without a word.
      const before = sent().length;
      expect(await paths(`${" ".repeat(500)}needle`)).toEqual([]);
      expect(sent()).toHaveLength(before);
    },
  );

  it("passes on how many notes the service did not scan", async () => {
    const { vault, fake, ownerId } = setupVault();
    for (let i = 0; i < 2005; i += 1) fake.seed(ownerId, `wiki/n${String(i).padStart(4, "0")}.md`, i === 3 ? "needle" : "hay");
    expect(await vault.search("needle")).toEqual({
      kind: "ok",
      hits: [{ path: "wiki/n0003.md", title: "n0003", tags: [], snippet: "needle", score: 1 }],
      unscanned: 5,
    });
    // Also when nothing matched: a miss in a partly scanned vault is not "the brain lacks it".
    expect(await vault.search("zebra")).toEqual({ kind: "ok", hits: [], unscanned: 5 });
  });
});

describe("the fake memory service keeps the service's rules", () => {
  it("create refuses an existing note; replace and delete refuse a stale hash", async () => {
    const fake = createFakeMemoryClient();
    const created = await fake.put("u1", "wiki/a.md", "one");
    expect(created).toEqual({ path: "wiki/a.md", hash: fakeMemoryHash("one"), created: true });
    await expect(fake.put("u1", "wiki/a.md", "two")).rejects.toMatchObject({ code: "exists", status: 409 });
    await expect(fake.put("u1", "wiki/a.md", "two", fakeMemoryHash("other"))).rejects.toMatchObject({ code: "stale", status: 409 });
    await expect(fake.put("u1", "wiki/gone.md", "two", fakeMemoryHash("x"))).rejects.toMatchObject({ code: "stale" });
    await expect(fake.remove("u1", "wiki/a.md", fakeMemoryHash("other"))).rejects.toMatchObject({ code: "stale" });
    expect(await fake.put("u1", "wiki/a.md", "two", created.hash)).toMatchObject({ created: false, hash: fakeMemoryHash("two") });
    await expect(fake.remove("u1", "wiki/a.md", fakeMemoryHash("two"))).resolves.toBeUndefined();
    await expect(fake.remove("u1", "wiki/a.md", fakeMemoryHash("two"))).resolves.toBeUndefined();
    expect(await fake.read("u1", "wiki/a.md")).toBeNull();
  });

  it("paths: .md only, NFC, no dot segment, a prefix is a folder", async () => {
    const fake = createFakeMemoryClient();
    await fake.put("u1", "./wiki/한글.md".normalize("NFD"), "x");
    expect((await fake.list("u1")).map((entry) => entry.path)).toEqual(["wiki/한글.md"]);
    for (const bad of ["wiki/a.txt", "wiki/.x/a.md", "wiki/../a.md", "wiki", ""]) {
      await expect(fake.put("u1", bad, "x"), bad).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    }
    expect(await fake.list("u1", "wiki")).toHaveLength(1);
    expect(await fake.list("u1", "nowhere")).toEqual([]);
    await expect(fake.list("u1", "wiki/한글.md")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(fake.put("u1", "wiki/한글.md/under.md", "x")).rejects.toMatchObject({ code: "invalid_path" });
  });

  it("limits: 512 KiB per note, the wiki's note count and size, NUL, the owner, the search limit", async () => {
    const fake = createFakeMemoryClient({ maxNotes: 2, maxWikiBytes: 10 });
    await expect(fake.put("u1", "wiki/a.md", "x".repeat(512 * 1024 + 1))).rejects.toMatchObject({ code: "too_large", status: 413 });
    await expect(fake.put("u1", "wiki/a.md", "a\0b")).rejects.toMatchObject({ code: "invalid_content" });
    await fake.put("u1", "wiki/a.md", "12345");
    await expect(fake.put("u1", "wiki/b.md", "123456")).rejects.toMatchObject({ code: "wiki_full", status: 507 });
    await fake.put("u1", "wiki/b.md", "12345");
    await expect(fake.put("u1", "wiki/c.md", "")).rejects.toMatchObject({ code: "wiki_full" });
    await expect(fake.list("../u2")).rejects.toMatchObject({ code: "invalid_owner" });
    await expect(fake.search("u1", "x", 21)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(fake.search("u1", "  ")).rejects.toMatchObject({ code: "invalid_query" });
  });

  it("a search query is at most 500 characters — UTF-16 units by default, code points as the pinned service counts", async () => {
    const none = { hits: [], unscanned: 0 };
    const refused = { code: "invalid_request", status: 400 };
    // Judged before anything else about the query, under either rule.
    for (const fake of [createFakeMemoryClient(), createFakeMemoryClient({ queryLength: "codePoints" })]) {
      await expect(fake.search("u1", "x".repeat(500))).resolves.toEqual(none);
      await expect(fake.search("u1", "x".repeat(501))).rejects.toMatchObject(refused);
      await expect(fake.search("u1", " ".repeat(501))).rejects.toMatchObject(refused);
      await expect(fake.search("u1", `xx${"😀".repeat(249)}`)).resolves.toEqual(none);
      await expect(fake.search("u1", "😀".repeat(501))).rejects.toMatchObject(refused);
      // Within the limit, a query with no letter or digit has no word to look for (pi 1d4a1fe).
      await expect(fake.search("u1", "😀".repeat(250))).rejects.toMatchObject({ code: "invalid_query", status: 400 });
    }
    // Where the two rules differ: a surrogate pair is two UTF-16 units and one code point.
    const units = createFakeMemoryClient();
    await expect(units.search("u1", `${"x".repeat(499)}😀`)).rejects.toMatchObject(refused);
    await expect(units.search("u1", "😀".repeat(251))).rejects.toMatchObject(refused);
    const points = createFakeMemoryClient({ queryLength: "codePoints" });
    await expect(points.search("u1", `${"x".repeat(499)}😀`)).resolves.toEqual(none);
    await expect(points.search("u1", `x${"😀".repeat(499)}`)).resolves.toEqual(none);
    await expect(points.search("u1", `${"x".repeat(500)}😀`)).rejects.toMatchObject(refused);
  });

  it("failNext fails one call — before the operation, or after it was applied", async () => {
    const fake = createFakeMemoryClient();
    const boom = new MemoryUnavailableError();
    fake.failNext(boom);
    await expect(fake.put("u1", "wiki/a.md", "x")).rejects.toBe(boom);
    expect(fake.dump("u1")).toEqual({});
    fake.failNext(boom, { op: "put", applied: true });
    expect(await fake.read("u1", "wiki/a.md")).toBeNull();
    await expect(fake.put("u1", "wiki/a.md", "x")).rejects.toBe(boom);
    expect(fake.dump("u1")).toEqual({ "wiki/a.md": "x" });
    await fake.deleteWiki("u1");
    expect(fake.dump("u1")).toEqual({});
  });
});
