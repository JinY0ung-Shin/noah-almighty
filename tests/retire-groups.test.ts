// Single team (groups retired 2026-11-06, user decision): ONE Noah instance is
// ONE team. On an existing deployment migrate() converts what groups left —
// ONCE (marker `single_team:migrated`): every active non-admin user outside an
// avatar-sharing group is SUSPENDED (fail closed; an admin re-approves the ones
// that belong), the groups' tool policies are intersected into the global
// `mcp_tool_policy`; on EVERY boot while `shared_skill_group_blocks` exists its
// blocks are copied into `shared_skill_blocks`; and behind the retirement gate
// (pre-retirement DB backup first) the three group tables are dropped.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import logger from "../src/server/logger.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-groups");

afterEach(() => {
  vi.restoreAllMocks();
});

const MARKER = "single_team:migrated";
const GROUP_TABLES = ["groups", "group_members", "shared_skill_group_blocks"];
const GROUP_INDEXES = ["idx_shared_skill_group_blocks_skill", "idx_group_members_user", "idx_group_members_group"];

function configFor(label: string): AppConfig {
  return loadConfig({ dataDir: path.join(tempDir(), label), agentRuntime: "local", sessionSecret: "t" });
}

function raw(config: AppConfig): Database.Database {
  return new Database(config.dbPath);
}

function dbOf(store: Store): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function indexExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}

function suspendedOf(store: Store, id: string): boolean {
  return (dbOf(store).prepare("SELECT suspended FROM users WHERE id = ?").get(id) as { suspended: number }).suspended === 1;
}

function auditRows(store: Store, action: string) {
  return dbOf(store)
    .prepare("SELECT actor_user_id, actor_name, status, detail FROM audit WHERE action = ? ORDER BY detail")
    .all(action) as { actor_user_id: string | null; actor_name: string | null; status: string; detail: string }[];
}

function backups(config: AppConfig): string[] {
  const dir = path.join(config.dataDir, "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** The group schema the last group-bearing release created (incl. its additive columns). */
function createLegacyGroupTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', created_by TEXT, created_at TEXT,
      allowed_mcp_tool_groups TEXT, avatar_sharing INTEGER
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', created_at TEXT,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS shared_skill_group_blocks (
      group_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, skill_name TEXT NOT NULL, blocked_by TEXT, created_at TEXT,
      PRIMARY KEY (group_id, owner_user_id, skill_name)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_skill_group_blocks_skill ON shared_skill_group_blocks(owner_user_id, skill_name);
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
  `);
}

/**
 * Prod today: one avatar-sharing group, signup mode `approval`, and active users
 * outside it. Seeded through this build's Store (users, sessions, shares), then
 * the legacy group tables are planted and the marker removed — exactly the
 * state a pre-single-team DB is in the moment it first boots this build.
 */
function seedLegacyDeployment(config: AppConfig) {
  const store = new Store(config);
  const admin = store.createUser({ username: "boss", displayName: "Boss", password: "password123" }); // first = admin
  const member = store.createUser({ username: "member", displayName: "Member", password: "password123" });
  const outsider = store.createUser({ username: "outsider", displayName: "Outsider", password: "password123" });
  const offOnly = store.createUser({ username: "offonly", displayName: "Off Only", password: "password123" });
  const pending = store.createUser({ username: "pending", displayName: "Pending", password: "password123" });
  store.setSuspended(pending.id, true);
  store.setSignupMode("approval");
  const outsiderSession = store.createSession(outsider.id);
  const memberSession = store.createSession(member.id);
  store.close();

  const db = raw(config);
  createLegacyGroupTables(db);
  const at = "2026-10-01T00:00:00.000Z";
  db.prepare("INSERT INTO groups (id, name, created_at, allowed_mcp_tool_groups, avatar_sharing) VALUES (?, ?, ?, ?, ?)").run(
    "team",
    "Team",
    at,
    JSON.stringify(["canvas", "personal_knowledge", "group_knowledge"]),
    null, // pre-policy row: NULL = sharing on
  );
  db.prepare("INSERT INTO groups (id, name, created_at, allowed_mcp_tool_groups, avatar_sharing) VALUES (?, ?, ?, ?, ?)").run(
    "quiet",
    "Quiet",
    at,
    null,
    0, // avatar sharing OFF: its co-membership never made anyone a teammate
  );
  const addMember = db.prepare("INSERT INTO group_members (group_id, user_id, role, created_at) VALUES (?, ?, ?, ?)");
  addMember.run("team", member.id, "admin", at);
  addMember.run("team", pending.id, "member", at);
  addMember.run("quiet", offOnly.id, "member", at);
  const block = db.prepare(
    "INSERT INTO shared_skill_group_blocks (group_id, owner_user_id, skill_name, blocked_by, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  block.run("team", member.id, "deploy-notes", admin.id, at);
  // The same (owner, name) blocked in two groups collapses to ONE global block.
  block.run("quiet", member.id, "deploy-notes", admin.id, at);
  block.run("quiet", offOnly.id, "secret-sauce", member.id, at);
  db.prepare("DELETE FROM app_config WHERE key = ?").run(MARKER);
  db.close();
  return { admin, member, outsider, offOnly, pending, outsiderSession, memberSession };
}

describe("single-team conversion (groups retired)", () => {
  it("suspends active non-admins outside a sharing group, copies policy + blocks, drops the group tables after a backup", () => {
    const config = configFor("convert");
    const seeded = seedLegacyDeployment(config);
    const warn = vi.spyOn(logger, "warn");

    const store = new Store(config);
    const db = dbOf(store);

    // Fail closed: the outsider (in no group) and the member of ONLY a
    // sharing-off group are suspended; the sharing-group member and the admin
    // (in no group at all) are untouched; the pending signup stays pending.
    expect(suspendedOf(store, seeded.outsider.id)).toBe(true);
    expect(suspendedOf(store, seeded.offOnly.id)).toBe(true);
    expect(suspendedOf(store, seeded.member.id)).toBe(false);
    expect(suspendedOf(store, seeded.admin.id)).toBe(false);
    expect(suspendedOf(store, seeded.pending.id)).toBe(true);
    // A suspension is immediate: the suspended user's sessions are gone.
    expect(store.getUserBySessionToken(seeded.outsiderSession)).toBeNull();
    expect(store.getUserBySessionToken(seeded.memberSession)?.id).toBe(seeded.member.id);

    // One audit row per suspended user (system actor, Korean detail).
    const audits = auditRows(store, "single_team_suspend");
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      expect(row.actor_user_id).toBeNull();
      expect(row.actor_name).toBe("system");
      expect(row.status).toBe("success");
      expect(row.detail).toContain("단일 팀 전환");
    }
    expect(audits.map((r) => r.detail).join("\n")).toContain("@outsider");
    expect(audits.map((r) => r.detail).join("\n")).toContain("@offonly");
    expect(audits.map((r) => r.detail).join("\n")).not.toContain("@pending");

    // ONE warn line with the count + usernames + the merged policy.
    const conversion = warn.mock.calls.filter((call) => String(call[1] ?? "").includes("single-team conversion"));
    expect(conversion).toHaveLength(1);
    expect(conversion[0][0]).toEqual({
      count: 2,
      usernames: ["offonly", "outsider"],
      mcpToolPolicy: ["canvas", "personal_knowledge"],
    });
    // The written policy is audited as a system action.
    const policyAudits = auditRows(store, "set_tool_policy");
    expect(policyAudits).toHaveLength(1);
    expect(policyAudits[0]).toMatchObject({ actor_user_id: null, actor_name: "system", status: "success" });
    expect(policyAudits[0].detail).toContain("canvas,personal_knowledge");

    // The (only) group policy is now the global one; the retired id is dropped.
    expect(store.getMcpToolPolicy()).toEqual(["canvas", "personal_knowledge"]);
    expect(store.allowedMcpToolGroupsForUser(seeded.member.id)).toEqual(["canvas", "personal_knowledge", "system"]);

    // Blocks: union across groups, one row per (owner, name), blocker kept.
    const blocks = db
      .prepare("SELECT owner_user_id, skill_name, blocked_by FROM shared_skill_blocks ORDER BY skill_name")
      .all();
    expect(blocks).toEqual([
      { owner_user_id: seeded.member.id, skill_name: "deploy-notes", blocked_by: seeded.admin.id },
      { owner_user_id: seeded.offOnly.id, skill_name: "secret-sauce", blocked_by: seeded.member.id },
    ]);
    expect(store.isSharedSkillBlocked(seeded.member.id, "deploy-notes")).toBe(true);

    // Marker stamped; tables + indexes dropped; the DB was backed up first.
    expect(db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(MARKER)).toBeTruthy();
    for (const table of GROUP_TABLES) expect(tableExists(db, table)).toBe(false);
    for (const index of GROUP_INDEXES) expect(indexExists(db, index)).toBe(false);
    const files = backups(config);
    expect(files).toHaveLength(1);
    const backup = new Database(path.join(config.dataDir, "backups", files[0]), { readonly: true });
    // The backup holds the PRE-conversion state: tables present, nobody suspended yet.
    expect(tableExists(backup, "groups")).toBe(true);
    expect(
      (backup.prepare("SELECT suspended FROM users WHERE id = ?").get(seeded.outsider.id) as { suspended: number }).suspended,
    ).toBe(0);
    backup.close();

    // Trust is now team membership: the surviving active users are teammates.
    expect(store.isTrustedFor(seeded.member.id, seeded.admin.id)).toBe(true);
    expect(store.isTrustedFor(seeded.outsider.id, seeded.admin.id)).toBe(false);
    // A stored legacy `open` would read as approval; here it stays approval.
    expect(store.getSignupMode()).toBe("approval");
    store.close();
  });

  it("intersects the policies of groups WITH members (fail closed); an empty group's policy never narrows", () => {
    const config = configFor("policy");
    const store = new Store(config);
    const boss = store.createUser({ username: "boss", displayName: "Boss", password: "password123" });
    store.close();
    const db = raw(config);
    createLegacyGroupTables(db);
    const add = db.prepare("INSERT INTO groups (id, name, allowed_mcp_tool_groups) VALUES (?, ?, ?)");
    add.run("a", "A", JSON.stringify(["canvas", "ssh", "personal_knowledge"]));
    add.run("b", "B", JSON.stringify(["ssh", "canvas", "browser"]));
    add.run("c", "C", null); // no policy: never narrows
    add.run("empty", "Empty", JSON.stringify([])); // NO members: restricted nobody, so it must not block everything now
    const member = db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')");
    for (const group of ["a", "b", "c"]) member.run(group, boss.id);
    db.prepare("DELETE FROM app_config WHERE key = ?").run(MARKER);
    db.close();
    const converted = new Store(config);
    expect(converted.getMcpToolPolicy()).toEqual(["canvas", "ssh"]);
    expect(auditRows(converted, "set_tool_policy")[0].detail).toContain("= canvas,ssh");
    converted.close();

    const config2 = configFor("no-policy");
    const store2 = new Store(config2);
    store2.createUser({ username: "boss", displayName: "Boss", password: "password123" });
    store2.close();
    const db2 = raw(config2);
    createLegacyGroupTables(db2);
    db2.prepare("INSERT INTO groups (id, name) VALUES ('x', 'X')").run();
    db2.prepare("DELETE FROM app_config WHERE key = ?").run(MARKER);
    db2.close();
    const converted2 = new Store(config2);
    expect(converted2.getMcpToolPolicy()).toBeNull();
    expect(auditRows(converted2, "set_tool_policy")).toHaveLength(0);
    expect(dbOf(converted2).prepare("SELECT 1 FROM app_config WHERE key = 'mcp_tool_policy'").get()).toBeUndefined();
    converted2.close();
  });

  it("a second boot is a no-op: nobody new is suspended, an admin's re-approval stands", () => {
    const config = configFor("second-boot");
    const seeded = seedLegacyDeployment(config);
    const first = new Store(config);
    // The admin re-approves the outsider, who does belong to the team.
    first.setSuspended(seeded.outsider.id, false);
    // A user created after the conversion (no group exists any more).
    const late = first.createUser({ username: "late", displayName: "Late", password: "password123" });
    first.close();
    const warn = vi.spyOn(logger, "warn");

    const second = new Store(config);
    expect(suspendedOf(second, seeded.outsider.id)).toBe(false);
    expect(suspendedOf(second, late.id)).toBe(false);
    expect(suspendedOf(second, seeded.offOnly.id)).toBe(true);
    expect(auditRows(second, "single_team_suspend")).toHaveLength(2);
    expect(warn.mock.calls.some((call) => String(call[1] ?? "").includes("single-team conversion"))).toBe(false);
    // Nothing left to retire: no second backup.
    expect(backups(config)).toHaveLength(1);
    second.close();
  });

  it("a fresh DB stamps the marker, suspends nobody, creates no group table and takes no backup", () => {
    const config = configFor("fresh");
    const warn = vi.spyOn(logger, "warn");
    const store = new Store(config);
    const db = dbOf(store);
    expect(db.prepare("SELECT 1 FROM app_config WHERE key = ?").get(MARKER)).toBeTruthy();
    for (const table of GROUP_TABLES) expect(tableExists(db, table)).toBe(false);
    expect(tableExists(db, "shared_skill_blocks")).toBe(true);
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const b = store.createUser({ username: "b", displayName: "B", password: "password123" });
    store.close();

    const reopened = new Store(config);
    expect(suspendedOf(reopened, a.id)).toBe(false);
    expect(suspendedOf(reopened, b.id)).toBe(false);
    expect(auditRows(reopened, "single_team_suspend")).toHaveLength(0);
    expect(warn.mock.calls.some((call) => String(call[1] ?? "").includes("single-team conversion"))).toBe(false);
    expect(backups(config)).toHaveLength(0);
    reopened.close();
  });

  it("rollback: an older release re-creating the group tables after the marker gets its blocks copied and the tables dropped, suspending nobody new", () => {
    const config = configFor("rollback");
    const seeded = seedLegacyDeployment(config);
    const converted = new Store(config); // the conversion boot
    // A user who joined after the conversion: active, and in no group.
    const groupless = converted.createUser({ username: "groupless", displayName: "G", password: "password123" });
    converted.close();

    // An older release boots: it re-creates the (empty) group tables, and one
    // of its group admins blocks a skill before this build comes back.
    const db = raw(config);
    createLegacyGroupTables(db);
    const insertBlock = db.prepare(
      "INSERT INTO shared_skill_group_blocks (group_id, owner_user_id, skill_name, blocked_by, created_at) VALUES ('old', ?, ?, ?, ?)",
    );
    // Created by the older release AFTER the conversion → copied.
    insertBlock.run(seeded.member.id, "rolled-back", seeded.admin.id, new Date(Date.now() + 60_000).toISOString());
    // A stale row dated BEFORE the conversion (already copied once, then
    // lifted by an admin) → never resurrected.
    insertBlock.run(seeded.member.id, "lifted-before", seeded.admin.id, "2020-01-01T00:00:00.000Z");
    db.close();
    const backupsBefore = backups(config).length;

    const store = new Store(config);
    const sdb = dbOf(store);
    expect(store.isSharedSkillBlocked(seeded.member.id, "rolled-back")).toBe(true);
    expect(store.isSharedSkillBlocked(seeded.member.id, "lifted-before")).toBe(false);
    for (const table of GROUP_TABLES) expect(tableExists(sdb, table)).toBe(false);
    expect(suspendedOf(store, groupless.id)).toBe(false);
    expect(suspendedOf(store, seeded.member.id)).toBe(false);
    expect(auditRows(store, "single_team_suspend")).toHaveLength(2);
    // The re-created tables counted as retired data: backed up before the drop.
    expect(backups(config).length).toBe(backupsBefore + 1);
    store.close();
  });

  it("a failed backup holds the drop (the conversion and the blocks copy still run); the next boot drops", () => {
    const config = configFor("held");
    const seeded = seedLegacyDeployment(config);
    // A FILE where the backups folder belongs makes the backup fail.
    fs.writeFileSync(path.join(config.dataDir, "backups"), "not a folder");
    vi.spyOn(logger, "error").mockImplementation(() => logger);

    const held = new Store(config);
    const db = dbOf(held);
    for (const table of GROUP_TABLES) expect(tableExists(db, table)).toBe(true);
    expect(suspendedOf(held, seeded.outsider.id)).toBe(true);
    expect(held.isSharedSkillBlocked(seeded.member.id, "deploy-notes")).toBe(true);
    // Trust never reads the leftover tables.
    expect(held.isTrustedFor(seeded.member.id, seeded.admin.id)).toBe(true);
    // An admin lifts a copied block while the old table is still there…
    expect(held.unblockSharedSkill(seeded.member.id, "deploy-notes")).toBe(true);
    held.close();

    // …and a reboot that is STILL held does not resurrect it from the stale
    // group row (only rows created after the last copy are copied).
    const stillHeld = new Store(config);
    for (const table of GROUP_TABLES) expect(tableExists(dbOf(stillHeld), table)).toBe(true);
    expect(stillHeld.isSharedSkillBlocked(seeded.member.id, "deploy-notes")).toBe(false);
    expect(stillHeld.isSharedSkillBlocked(seeded.offOnly.id, "secret-sauce")).toBe(true);
    expect(auditRows(stillHeld, "single_team_suspend")).toHaveLength(2);
    stillHeld.close();

    fs.rmSync(path.join(config.dataDir, "backups"));
    const next = new Store(config);
    for (const table of GROUP_TABLES) expect(tableExists(dbOf(next), table)).toBe(false);
    expect(next.isSharedSkillBlocked(seeded.member.id, "deploy-notes")).toBe(false);
    expect(auditRows(next, "single_team_suspend")).toHaveLength(2);
    next.close();
  });
});
