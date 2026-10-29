import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * The SAFETY NET in front of every destructive retirement step (user decision
 * 2026-10-29): before a boot drops a retired table, deletes a retired
 * `app_config` key or purges a removed feature's rows, the whole SQLite DB is
 * copied to `<dataDir>/backups/pre-retire-<stamp>.db` (0600, folder 0700), and
 * the files the boot purges are MOVED to `<dataDir>/retired/<stamp>/` instead of
 * deleted (`retiredFiles.ts`). One stamp per boot, shared by both. A backup
 * that fails HOLDS every destructive retirement step of that boot — the
 * migrate() drops and every boot purge — and the next boot tries again.
 *
 * Noah never prunes `backups/` or `retired/`: they hold full user data
 * (conversations, encrypted secrets, files), and deleting them is the
 * operator's decision, by hand (docs/architecture/server-core.md).
 */

/** The backup folder under `dataDir`. Reserved: no other code writes or reads it. */
export const BACKUP_DIR = "backups";

/**
 * Tables only a retired feature (or an older release booted after its
 * retirement) creates. Every name is reserved FOREVER by its retirement.
 */
const RETIRED_TABLES = [
  "server_agents",
  "server_agent_sessions",
  "group_agents",
  "group_agents_legacy",
  "external_avatar_images",
  "personal_agents",
  "bot_tasks",
  "avatar_trusted_users",
] as const;

/**
 * `app_config` keys a retirement deletes: the removed features' settings, the
 * external-avatar registry, and the retirements' pending-retry documents.
 */
const RETIRED_APP_CONFIG_KEYS = [
  "server_agents_enabled",
  "server_agent_deployment_id",
  "craft_apps_enabled",
  "stt_override",
  "claude_oauth_token",
  "skill_discovery_cache",
  "external_agents_registry_v1",
  "retired:personal_agents:pending",
  "retired:external_avatars:pending",
  "retired:group_agents:pending",
] as const;

/**
 * Columns only a retired feature wrote, dropped by migrate() behind the gate.
 * Every name is reserved FOREVER by its retirement. Group knowledge
 * repositories (retired 2026-10-30): the group's repo connection, the owner's
 * default and each conversation's group-knowledge OFF-set.
 */
export const RETIRED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ["groups", "knowledge_repo"],
  ["groups", "knowledge_branch"],
  ["groups", "knowledge_selected"],
  ["users", "group_knowledge_off_default"],
  ["conversations", "group_knowledge_off"],
];

/** Avatar-id namespaces of the retired avatar kinds. */
const RETIRED_AVATAR_PREFIXES = ["personal:", "external:", "group:"] as const;

/** Tables whose `avatar_user_id` rows a retirement purges by prefix. */
const AVATAR_KEYED_TABLES = ["conversations", "routine_jobs", "avatar_notifications", "knowledge_requests"] as const;

/**
 * This boot's stamp: UTC to the millisecond plus a short random tail (two
 * boots — or two Store opens — in one millisecond must never share a backup
 * file or quarantine folder), safe as a file and folder name, sorting by time.
 */
export function retirementStamp(at: Date = new Date()): string {
  return `${at.toISOString().replace(/:/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

/**
 * Whether this DB holds anything a retirement would delete. Read-only, and
 * safe BEFORE migrate(): every table and column is checked before it is read,
 * so a fresh, an old and a current schema all answer. Mirrors what the
 * migrate() drops and the boot purges match; a clean or fully retired DB
 * answers false, so it is never backed up.
 */
export function retirementDataPresent(db: Database.Database): boolean {
  if (RETIRED_TABLES.some((table) => tableExists(db, table))) {
    return true;
  }
  // A retired column counts only while it holds a value: dropping an all-NULL
  // column loses nothing, so it needs no backup.
  for (const [table, column] of RETIRED_COLUMNS) {
    if (
      tableExists(db, table) &&
      columnExists(db, table, column) &&
      db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`).get()
    ) {
      return true;
    }
  }
  if (tableExists(db, "app_config")) {
    const placeholders = RETIRED_APP_CONFIG_KEYS.map(() => "?").join(", ");
    if (db.prepare(`SELECT 1 FROM app_config WHERE key IN (${placeholders}) LIMIT 1`).get(...RETIRED_APP_CONFIG_KEYS)) {
      return true;
    }
  }
  // Exact, case-sensitive prefix tests, like the purges' own predicates.
  const prefixed = RETIRED_AVATAR_PREFIXES.map(
    (prefix) => `substr(avatar_user_id, 1, ${prefix.length}) = '${prefix}'`,
  ).join(" OR ");
  for (const table of AVATAR_KEYED_TABLES) {
    if (
      tableExists(db, table) &&
      columnExists(db, table, "avatar_user_id") &&
      db.prepare(`SELECT 1 FROM ${table} WHERE ${prefixed} LIMIT 1`).get()
    ) {
      return true;
    }
  }
  return (
    tableExists(db, "routine_jobs") &&
    columnExists(db, "routine_jobs", "personal_agent_id") &&
    Boolean(db.prepare("SELECT 1 FROM routine_jobs WHERE personal_agent_id IS NOT NULL LIMIT 1").get())
  );
}

/**
 * Copy the whole DB to `<dataDir>/backups/pre-retire-<stamp>.db` with SQLite's
 * `VACUUM INTO` (a consistent snapshot, WAL included, synchronous). The file is
 * created EMPTY at 0600 first (VACUUM INTO accepts an empty target), so the copy
 * is never readable to others even for a moment; the folder is created 0700 and
 * must be a REAL folder (a link is refused). The copy is opened read-only and
 * its schema compared before it counts. A failed attempt removes only its own
 * partial file (a disk-full copy must not eat the space a retry needs), then
 * throws.
 */
export function backupDatabase(
  db: Database.Database,
  dataDir: string,
  stamp: string,
): { path: string; bytes: number } {
  const dir = path.join(dataDir, BACKUP_DIR);
  const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!existing) {
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  } else if (!existing.isDirectory()) {
    throw Object.assign(new Error(`${dir} is not a folder`), { code: "BACKUP_DIR_NOT_A_FOLDER" });
  }
  const file = path.join(dir, `pre-retire-${stamp}.db`);
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  try {
    fs.chmodSync(file, 0o600);
    db.prepare("VACUUM INTO ?").run(file);
    fs.chmodSync(file, 0o600);
    const copy = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const objects = "SELECT COUNT(*) AS c FROM sqlite_master";
      const expected = (db.prepare(objects).get() as { c: number }).c;
      const actual = (copy.prepare(objects).get() as { c: number }).c;
      if (actual !== expected) {
        throw Object.assign(new Error(`backup has ${actual} schema objects, expected ${expected}`), {
          code: "BACKUP_INCOMPLETE",
        });
      }
    } finally {
      copy.close();
    }
    return { path: file, bytes: fs.statSync(file).size };
  } catch (err) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // The operator sees the error; the next boot uses a new stamp.
    }
    throw err;
  }
}
