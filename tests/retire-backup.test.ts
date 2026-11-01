// The safety net in front of every retirement (user decision 2026-10-29): a
// boot that is about to delete what a removed feature left first backs the
// whole SQLite DB up to `<dataDir>/backups/pre-retire-<stamp>.db` (0600, folder
// 0700) and MOVES the files it retires to `<dataDir>/retired/<stamp>/` instead
// of deleting them. A failed backup holds EVERY destructive retirement step of
// that boot — the migrate() drops and key deletes, and every boot purge — and
// the next boot retries. Noah never prunes either folder.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatImagesDir } from "../src/server/chatImages.js";
import { loadConfig } from "../src/server/config.js";
import logger from "../src/server/logger.js";
import { retireCraftApps } from "../src/server/retireCraftApps.js";
import { retireExternalAvatars } from "../src/server/retireExternalAvatars.js";
import { newSweep, quarantineRetired } from "../src/server/retiredFiles.js";
import { retireGroupAgents } from "../src/server/retireGroupAgents.js";
import { retirePersonalAgents } from "../src/server/retirePersonalAgents.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-backup");

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_ENV = {};

function configFor(label: string): AppConfig {
  return loadConfig({ dataDir: path.join(tempDir(), label), agentRuntime: "local", sessionSecret: "t" });
}

function writeFile(file: string, body = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Every boot purge, in index.ts order. */
function bootRetirements(config: AppConfig, store: Store): void {
  retirePersonalAgents({ config, store });
  retireExternalAvatars({ config, store, env: NO_ENV });
  retireGroupAgents({ config, store });
  retireCraftApps({ config, store });
}

/**
 * A deployment an older release left behind: an external-avatar thread with
 * chat media, a server-agents table with a row and its admin switch (both
 * dropped by migrate()), the Craft purge queue — plus the owner's own thread.
 */
function seedLegacy(config: AppConfig) {
  const store = new Store(config);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
  store.addMessage("own-chat", { role: "user", content: "안녕" });
  store.touchConversation(owner.id, "ext-chat", "external:research", "조사해줘");
  store.addMessage("ext-chat", { role: "user", content: "조사해줘" });
  store.addMessage("ext-chat", { role: "assistant", content: "외부 답변" });
  store.setAppSecret("server_agents_enabled", "1");
  store.close();
  const raw = new Database(config.dbPath);
  raw.exec("CREATE TABLE server_agents (id TEXT PRIMARY KEY, host TEXT NOT NULL)");
  raw.prepare("INSERT INTO server_agents (id, host) VALUES ('srv-1', 'build.internal')").run();
  raw.close();
  return {
    owner,
    extImage: writeFile(path.join(chatImagesDir(config, "ext-chat"), "a.png")),
    craftQueue: writeFile(path.join(config.dataDir, "runtime", "craft-purge", "s-0123")),
  };
}

function backups(config: AppConfig): string[] {
  const dir = path.join(config.dataDir, "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function stamps(config: AppConfig): string[] {
  const dir = path.join(config.dataDir, "retired");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function tableExists(dbPath: string, table: string): boolean {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } finally {
    raw.close();
  }
}

function countRows(dbPath: string, sql: string): number {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare(sql).get() as { c: number }).c;
  } finally {
    raw.close();
  }
}

describe("pre-retirement database backup", () => {
  it("backs the DB up BEFORE migrate() and the purges, 0600 in a 0700 folder, with the pre-purge rows inside", () => {
    const config = configFor("legacy");
    const seed = seedLegacy(config);
    const warn = vi.spyOn(logger, "warn");

    const store = new Store(config);
    const gate = store.retirementGate();
    bootRetirements(config, store);

    // Exactly one backup, named after this boot's stamp, private.
    expect(backups(config)).toEqual([`pre-retire-${gate.stamp}.db`]);
    const backup = path.join(config.dataDir, "backups", `pre-retire-${gate.stamp}.db`);
    expect(gate.backupPath).toBe(backup);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(backup)).mode & 0o777).toBe(0o700);
    expect(warn).toHaveBeenCalledWith(
      { path: backup, bytes: fs.statSync(backup).size },
      expect.stringContaining("backed up"),
    );
    // It holds what this boot then deleted: the table migrate() dropped, the key
    // it deleted, and the thread the purge removed.
    expect(tableExists(backup, "server_agents")).toBe(true);
    expect(countRows(backup, "SELECT COUNT(*) AS c FROM server_agents")).toBe(1);
    expect(countRows(backup, "SELECT COUNT(*) AS c FROM app_config WHERE key = 'server_agents_enabled'")).toBe(1);
    expect(countRows(backup, "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = 'ext-chat'")).toBe(2);
    expect(countRows(backup, "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = 'own-chat'")).toBe(1);
    // ...and the live DB no longer does.
    expect(tableExists(config.dbPath, "server_agents")).toBe(false);
    expect(countRows(config.dbPath, "SELECT COUNT(*) AS c FROM app_config WHERE key = 'server_agents_enabled'")).toBe(0);
    expect(store.countConversationsForAvatar("external:research")).toBe(0);
    expect(store.listConversations(seed.owner.id).map((c) => c.id)).toEqual(["own-chat"]);
    // The files went to the SAME stamp's quarantine.
    expect(stamps(config)).toEqual([gate.stamp]);
    const quarantine = path.join(config.dataDir, "retired", gate.stamp);
    expect(fs.existsSync(seed.extImage)).toBe(false);
    expect(fs.readFileSync(path.join(quarantine, path.relative(config.dataDir, seed.extImage)), "utf8")).toBe("x");
    expect(fs.existsSync(path.join(quarantine, "runtime", "craft-purge", "s-0123"))).toBe(true);
    store.close();
  });

  it("is idempotent across boots: a fully retired DB is never backed up again and nothing moves twice", () => {
    const config = configFor("idempotent");
    const seed = seedLegacy(config);
    const first = new Store(config);
    const firstStamp = first.retirementGate().stamp;
    bootRetirements(config, first);
    first.close();
    expect(backups(config)).toHaveLength(1);
    const quarantined = path.join(config.dataDir, "retired", firstStamp, path.relative(config.dataDir, seed.extImage));

    for (let boot = 0; boot < 2; boot += 1) {
      const store = new Store(config);
      bootRetirements(config, store);
      expect(store.retirementGate()).toMatchObject({ allowed: true, backupPath: null });
      store.close();
    }

    expect(backups(config)).toHaveLength(1);
    expect(stamps(config)).toEqual([firstStamp]);
    expect(fs.readFileSync(quarantined, "utf8")).toBe("x");
  });

  it("never backs up a clean DB", () => {
    const config = configFor("clean");
    const store = new Store(config);
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
    bootRetirements(config, store);
    store.close();
    const again = new Store(config);
    bootRetirements(config, again);

    expect(again.retirementGate()).toMatchObject({ allowed: true, backupPath: null });
    expect(fs.existsSync(path.join(config.dataDir, "backups"))).toBe(false);
    expect(fs.existsSync(path.join(config.dataDir, "retired"))).toBe(false);
    again.close();
  });

  it("backs up a stamped DB again only when an older release brought retired data back", () => {
    const config = configFor("rollback");
    seedLegacy(config);
    const first = new Store(config);
    bootRetirements(config, first);
    // The older release: its migrate() re-creates the image table, and someone
    // chats with an external avatar again.
    first.touchConversation("someone", "ext-again", "external:research", "다시");
    first.close();
    const raw = new Database(config.dbPath);
    raw.exec("CREATE TABLE external_avatar_images (id TEXT PRIMARY KEY)");
    raw.close();

    const store = new Store(config);
    expect(store.retirementGate().backupPath).not.toBeNull();
    expect(backups(config)).toHaveLength(2);
    retireExternalAvatars({ config, store, env: NO_ENV });
    expect(store.countConversationsForAvatar("external:research")).toBe(0);
    store.close();
  });

  it("a failed backup holds every destructive step of that boot, and the next boot retries", () => {
    const config = configFor("backup-fails");
    const seed = seedLegacy(config);
    // A regular file where the backups folder belongs: the backup cannot be written.
    const blocker = writeFile(path.join(config.dataDir, "backups"), "not a folder");
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");

    const held = new Store(config);
    expect(held.retirementGate()).toMatchObject({ allowed: false, backupPath: null });
    bootRetirements(config, held);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.stringContaining("FAILED"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("external-avatar purge skipped"));
    // Nothing was dropped, deleted, purged or moved; nothing is marked done.
    expect(tableExists(config.dbPath, "server_agents")).toBe(true);
    expect(countRows(config.dbPath, "SELECT COUNT(*) AS c FROM app_config WHERE key = 'server_agents_enabled'")).toBe(1);
    expect(held.countConversationsForAvatar("external:research")).toBe(1);
    expect(held.externalAvatarsRetired()).toBe(false);
    expect(held.personalAgentsRetired()).toBe(false);
    expect(held.groupAgentsRetired()).toBe(false);
    expect(fs.existsSync(seed.extImage)).toBe(true);
    expect(fs.existsSync(seed.craftQueue)).toBe(true);
    expect(fs.existsSync(path.join(config.dataDir, "retired"))).toBe(false);
    // The app keeps working on the held boot.
    expect(held.listConversations(seed.owner.id).map((c) => c.id).sort()).toEqual(["ext-chat", "own-chat"]);
    held.close();

    // The operator frees the path; the next boot backs up and retires.
    fs.rmSync(blocker);
    const next = new Store(config);
    expect(next.retirementGate().allowed).toBe(true);
    bootRetirements(config, next);
    expect(backups(config)).toHaveLength(1);
    expect(tableExists(config.dbPath, "server_agents")).toBe(false);
    expect(next.countConversationsForAvatar("external:research")).toBe(0);
    expect(next.externalAvatarsRetired()).toBe(true);
    expect(fs.existsSync(seed.extImage)).toBe(false);
    expect(fs.existsSync(seed.craftQueue)).toBe(false);
    next.close();
  });

  it("refuses a backups folder that is a link, holding the boot", () => {
    const config = configFor("backup-link");
    seedLegacy(config);
    const elsewhere = path.join(tempDir(), "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(config.dataDir, "backups"), "dir");

    const store = new Store(config);

    expect(store.retirementGate().allowed).toBe(false);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(tableExists(config.dbPath, "server_agents")).toBe(true);
    store.close();
  });

  it("removes only its own partial file when the copy itself fails", () => {
    const config = configFor("copy-fails");
    seedLegacy(config);
    const realPrepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith("VACUUM INTO")) {
        throw Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
      }
      return realPrepare.call(this, sql);
    } as typeof Database.prototype.prepare);

    const store = new Store(config);

    expect(store.retirementGate().allowed).toBe(false);
    expect(backups(config)).toEqual([]);
    expect(tableExists(config.dbPath, "server_agents")).toBe(true);
    store.close();
  });

  it("never fires a retired bot-bound routine while the purge is held", () => {
    const config = configFor("held-bot-routine");
    const store = new Store(config);
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const own = store.createRoutineJob(owner.id, { prompt: "매일 요약", minuteOfDay: 540 });
    const bot = store.createRoutineJob(owner.id, { prompt: "봇 루틴", minuteOfDay: 600 });
    store.close();
    const raw = new Database(config.dbPath);
    raw.exec("ALTER TABLE routine_jobs ADD COLUMN personal_agent_id TEXT");
    raw.prepare("UPDATE routine_jobs SET personal_agent_id = 'agent-a' WHERE id = ?").run(bot.id);
    raw.prepare("UPDATE routine_jobs SET next_run_at = '2000-01-01T00:00:00.000Z'").run();
    raw.close();
    writeFile(path.join(config.dataDir, "backups"), "not a folder");

    const held = new Store(config);
    retirePersonalAgents({ config, store: held });

    expect(held.listRoutineJobs(owner.id).map((job) => job.id).sort()).toEqual([own.id, bot.id].sort());
    expect(held.listDueRoutineJobs(new Date().toISOString()).map((job) => job.id)).toEqual([own.id]);
    held.close();
  });
});

describe("quarantine moves", () => {
  it("never moves anything inside Noah's own backups/ or retired/, or outside dataDir", () => {
    const config = configFor("scope");
    const sweep = newSweep({ dataDir: config.dataDir, stamp: "s" });
    const inBackups = writeFile(path.join(config.dataDir, "backups", "pre-retire-x.db"));
    const inRetired = writeFile(path.join(config.dataDir, "retired", "old", "f"));
    const outside = writeFile(path.join(tempDir(), "outside", "f"));

    for (const target of [inBackups, inRetired, outside, config.dataDir]) {
      expect(quarantineRetired(target, sweep), target).toBe(false);
      expect(fs.existsSync(target), target).toBe(true);
    }
    expect(sweep.failures).toBe(4);
  });

  it("refuses a quarantine root that is a link and keeps the item pending", () => {
    const config = configFor("retired-link");
    const store = new Store(config);
    store.touchConversation("someone", "ext-linked", "external:x", "링크");
    const image = writeFile(path.join(chatImagesDir(config, "ext-linked"), "a.png"));
    const elsewhere = path.join(tempDir(), "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(config.dataDir, "retired"), "dir");

    retireExternalAvatars({ config, store, env: NO_ENV });

    expect(fs.existsSync(image)).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(store.externalAvatarsRetired()).toBe(false);
    expect(store.retiredExternalAvatarPendingState().status).toBe("ok");
    store.close();
  });
});
