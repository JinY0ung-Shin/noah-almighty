// Group knowledge repositories are retired (user decision 2026-10-30): groups
// stay only as the avatar-sharing / trust / skill-sharing unit. An existing
// deployment's DB columns (`groups.knowledge_*`, the group-knowledge OFF-sets)
// are dropped by migrate() behind the pre-retirement backup, and Noah's clones
// (`<dataDir>/group-knowledge`) are quarantined, never deleted.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import {
  GROUP_KNOWLEDGE_REPOS_RETIRED_KEY,
  retireGroupKnowledgeRepos,
} from "../src/server/retireGroupKnowledgeRepos.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-group-knowledge");

function configFor(label: string): AppConfig {
  return loadConfig({ dataDir: path.join(tempDir(), label), agentRuntime: "local", sessionSecret: "t" });
}

function columns(dbPath: string, table: string): string[] {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    raw.close();
  }
}

/** A deployment the last release left: a group with a connected repo, OFF-sets, and a clone on disk. */
function seedLegacy(config: AppConfig) {
  const store = new Store(config);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const group = store.createGroup({ name: "Team" });
  store.addGroupMember(group.id, owner.id, "admin");
  store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
  store.close();
  const raw = new Database(config.dbPath);
  raw.exec("ALTER TABLE groups ADD COLUMN knowledge_repo TEXT");
  raw.exec("ALTER TABLE groups ADD COLUMN knowledge_branch TEXT");
  raw.exec("ALTER TABLE groups ADD COLUMN knowledge_selected TEXT");
  raw.exec("ALTER TABLE users ADD COLUMN group_knowledge_off_default TEXT");
  raw.exec("ALTER TABLE conversations ADD COLUMN group_knowledge_off TEXT");
  raw.prepare("UPDATE groups SET knowledge_repo = 'acme/team-kb', knowledge_branch = 'main' WHERE id = ?").run(group.id);
  raw.prepare("UPDATE users SET group_knowledge_off_default = ? WHERE id = ?").run(JSON.stringify([group.id]), owner.id);
  raw.prepare("UPDATE conversations SET group_knowledge_off = ? WHERE id = 'own-chat'").run(JSON.stringify([group.id]));
  raw.close();
  const clone = path.join(config.dataDir, "group-knowledge", group.id);
  fs.mkdirSync(path.join(clone, "wiki"), { recursive: true });
  fs.writeFileSync(path.join(clone, "wiki", "rule.md"), "# Rule\n");
  return { owner, group, clone };
}

describe("group knowledge repository retirement", () => {
  it("backs the DB up, drops the retired columns, and keeps groups and memberships", () => {
    const config = configFor("legacy");
    const seed = seedLegacy(config);

    const store = new Store(config);
    try {
      const gate = store.retirementGate();
      expect(gate.allowed).toBe(true);
      // The backup holds what migrate() then dropped.
      const backup = path.join(config.dataDir, "backups", `pre-retire-${gate.stamp}.db`);
      expect(gate.backupPath).toBe(backup);
      const copy = new Database(backup, { readonly: true });
      expect(copy.prepare("SELECT knowledge_repo AS r FROM groups").get()).toEqual({ r: "acme/team-kb" });
      copy.close();
      // ...and the live DB no longer has any of them.
      expect(columns(config.dbPath, "groups")).not.toEqual(expect.arrayContaining(["knowledge_repo"]));
      for (const [table, column] of [
        ["groups", "knowledge_repo"],
        ["groups", "knowledge_branch"],
        ["groups", "knowledge_selected"],
        ["users", "group_knowledge_off_default"],
        ["conversations", "group_knowledge_off"],
      ] as const) {
        expect(columns(config.dbPath, table), `${table}.${column}`).not.toContain(column);
      }
      // Groups stay: the group, its admin and the owner's own conversation.
      expect(store.getGroup(seed.group.id)?.name).toBe("Team");
      expect(store.groupRoleFor(seed.owner.id, seed.group.id)).toBe("admin");
      expect(store.listConversations(seed.owner.id).map((c) => c.id)).toEqual(["own-chat"]);
    } finally {
      store.close();
    }
  });

  it("quarantines the clones (never deletes them) under the boot stamp, then stamps the marker", () => {
    const config = configFor("clones");
    const seed = seedLegacy(config);
    const store = new Store(config);
    try {
      const { stamp } = store.retirementGate();
      retireGroupKnowledgeRepos({ config, store });
      expect(fs.existsSync(path.join(config.dataDir, "group-knowledge"))).toBe(false);
      const moved = path.join(config.dataDir, "retired", stamp, "group-knowledge", seed.group.id, "wiki", "rule.md");
      expect(fs.readFileSync(moved, "utf8")).toBe("# Rule\n");
      expect(store.getAppSecret(GROUP_KNOWLEDGE_REPOS_RETIRED_KEY)).not.toBeNull();
      // A later boot is a no-op even if something recreated the folder.
      fs.mkdirSync(path.join(config.dataDir, "group-knowledge"));
      retireGroupKnowledgeRepos({ config, store });
      expect(fs.existsSync(path.join(config.dataDir, "group-knowledge"))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("moves nothing and stamps no marker while the pre-retirement backup is held", () => {
    const dataDir = path.join(tempDir(), "held");
    const clone = path.join(dataDir, "group-knowledge", "g1");
    fs.mkdirSync(clone, { recursive: true });
    const marker = new Map<string, string>();
    retireGroupKnowledgeRepos({
      config: { dataDir },
      store: {
        retirementGate: () => ({ allowed: false, stamp: "2026-10-30T00-00-00.000Z-abcdef" }),
        getAppSecret: (key) => marker.get(key) ?? null,
        setAppSecret: (key, value) => void marker.set(key, value),
      },
    });
    expect(fs.existsSync(clone)).toBe(true);
    expect(marker.size).toBe(0);
  });

  it("a fresh install has nothing to retire: no backup, no retired columns, a clean marker", () => {
    const config = configFor("fresh");
    const store = new Store(config);
    try {
      expect(store.retirementGate().backupPath).toBeNull();
      expect(fs.existsSync(path.join(config.dataDir, "backups"))).toBe(false);
      expect(columns(config.dbPath, "groups")).not.toContain("knowledge_repo");
      expect(columns(config.dbPath, "users")).not.toContain("group_knowledge_off_default");
      expect(columns(config.dbPath, "conversations")).not.toContain("group_knowledge_off");
      retireGroupKnowledgeRepos({ config, store });
      expect(store.getAppSecret(GROUP_KNOWLEDGE_REPOS_RETIRED_KEY)).not.toBeNull();
      expect(fs.existsSync(path.join(config.dataDir, "retired"))).toBe(false);
    } finally {
      store.close();
    }
  });

  it("an all-NULL retired column is dropped without a backup (nothing to lose)", () => {
    const config = configFor("all-null");
    new Store(config).close();
    const raw = new Database(config.dbPath);
    raw.exec("ALTER TABLE groups ADD COLUMN knowledge_repo TEXT");
    raw.close();
    const store = new Store(config);
    try {
      expect(store.retirementGate().backupPath).toBeNull();
      expect(columns(config.dbPath, "groups")).not.toContain("knowledge_repo");
    } finally {
      store.close();
    }
  });
});
