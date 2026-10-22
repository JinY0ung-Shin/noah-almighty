import { describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import type { Store } from "../src/server/store.js";
import { MAX_SERVER_AGENTS, type ServerAgentInput } from "../src/shared/serverAgents.js";
import { withTempDir } from "./helpers.js";

// Coverage target: src/server/store/serverAgents.ts — CRUD, the per-owner cap,
// name uniqueness, the target-change reset, the (conversation, server) session
// map, and the manual cascades wired into the conversation/user deletes.

let tempDir: string;
const getTempDir = withTempDir("store-server-agents", () => {
  tempDir = getTempDir();
});

function boot() {
  const { store } = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  return { store, ownerId: owner.id };
}

function input(overrides: Partial<ServerAgentInput> = {}): ServerAgentInput {
  return {
    name: "web-01",
    host: "web-01.corp.example",
    port: 22,
    username: "noah-agent",
    workdir: "/srv/app",
    role: "주문 API",
    notes: "logs in /var/log/app",
    access: "read",
    enabled: true,
    ...overrides,
  };
}

function create(store: Store, ownerId: string, overrides: Partial<ServerAgentInput> = {}) {
  const result = store.createServerAgent(ownerId, input(overrides));
  if (!result.ok) throw new Error(result.error);
  return result.server;
}

function sessionCount(store: Store): number {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  return (db.prepare("SELECT COUNT(*) AS c FROM server_agent_sessions").get() as { c: number }).c;
}

const OK_STATE = { ok: true, version: "0.3.283", error: null, detail: null, checkedAt: "2026-10-22T00:00:00.000Z" };

describe("server agents — store CRUD", () => {
  it("creates, lists (by name), reads by id/name, updates and deletes per owner", () => {
    const { store, ownerId } = boot();
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const web = create(store, ownerId);
    create(store, ownerId, { name: "db-01", host: "db-01.corp.example", access: "exec" });

    expect(web).toMatchObject({ name: "web-01", port: 22, access: "read", enabled: true, installState: null });
    expect(store.listServerAgents(ownerId).map((s) => s.name)).toEqual(["db-01", "web-01"]);
    expect(store.getServerAgent(ownerId, web.id)?.notes).toBe("logs in /var/log/app");
    expect(store.getServerAgentByName(ownerId, " WEB-01 ")?.id).toBe(web.id);
    // Another owner sees nothing and cannot touch the row.
    expect(store.listServerAgents(other.id)).toEqual([]);
    expect(store.getServerAgent(other.id, web.id)).toBeNull();
    expect(store.updateServerAgent(other.id, web.id, { role: "x" })).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(store.deleteServerAgent(other.id, web.id)).toBe(false);

    const updated = store.updateServerAgent(ownerId, web.id, { role: "새 역할", access: "full", enabled: false });
    expect(updated.ok && updated.server).toMatchObject({ role: "새 역할", access: "full", enabled: false, host: "web-01.corp.example" });

    expect(store.deleteServerAgent(ownerId, web.id)).toBe(true);
    expect(store.getServerAgent(ownerId, web.id)).toBeNull();
    expect(store.deleteServerAgent(ownerId, web.id)).toBe(false);
  });

  it("refuses a duplicate name on create and rename, and caps the owner's rows", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const db = create(store, ownerId, { name: "db-01" });
    expect(store.createServerAgent(ownerId, input())).toEqual({ ok: false, error: "DUPLICATE_NAME" });
    expect(store.updateServerAgent(ownerId, db.id, { name: "web-01" })).toEqual({ ok: false, error: "DUPLICATE_NAME" });
    // Renaming to its OWN name is not a duplicate.
    expect(store.updateServerAgent(ownerId, web.id, { name: "web-01" }).ok).toBe(true);
    // The same name under another owner is fine.
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    expect(store.createServerAgent(other.id, input()).ok).toBe(true);

    for (let i = store.listServerAgents(ownerId).length; i < MAX_SERVER_AGENTS; i += 1) create(store, ownerId, { name: `s-${i}` });
    expect(store.listServerAgents(ownerId)).toHaveLength(MAX_SERVER_AGENTS);
    expect(store.createServerAgent(ownerId, input({ name: "one-more" }))).toEqual({ ok: false, error: "LIMIT" });
  });

  it("a target change clears the install state and every session of that server; other edits keep them", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const db = create(store, ownerId, { name: "db-01" });
    store.setServerAgentInstallState(ownerId, web.id, OK_STATE);
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c2", web.id, "remote-2", "0.3.283");
    store.setServerAgentSession("c1", db.id, "remote-3", "0.3.283");

    const roleOnly = store.updateServerAgent(ownerId, web.id, { role: "only the role", notes: "n", access: "exec" });
    expect(roleOnly.ok && roleOnly.server.installState).toEqual(OK_STATE);
    expect(store.getServerAgentSession("c1", web.id)?.remoteSessionId).toBe("remote-1");

    for (const patch of [{ host: "web-02.corp.example" }, { port: 2222 }, { username: "deploy" }, { workdir: "/srv/other" }]) {
      store.setServerAgentInstallState(ownerId, web.id, OK_STATE);
      store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
      const moved = store.updateServerAgent(ownerId, web.id, patch);
      expect(moved.ok && moved.server.installState).toBeNull();
      expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    }
    expect(store.getServerAgentSession("c2", web.id)).toBeNull();
    // The OTHER server's session is untouched.
    expect(store.getServerAgentSession("c1", db.id)?.remoteSessionId).toBe("remote-3");
  });

  it("install state round-trips, and a malformed stored value reads as null", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const failed = { ok: false, version: null, error: "AUTH_FAILED" as const, detail: "All configured authentication methods failed", checkedAt: "2026-10-22T01:00:00.000Z" };
    store.setServerAgentInstallState(ownerId, web.id, failed);
    expect(store.getServerAgent(ownerId, web.id)?.installState).toEqual(failed);
    store.setServerAgentInstallState(ownerId, web.id, null);
    expect(store.getServerAgent(ownerId, web.id)?.installState).toBeNull();
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare("UPDATE server_agents SET install_state = ?, access = ? WHERE id = ?").run("{not json", "root", web.id);
    const read = store.getServerAgent(ownerId, web.id)!;
    expect(read.installState).toBeNull();
    // An unknown stored tier reads as the safest one.
    expect(read.access).toBe("read");
  });
});

describe("server agents — target-conditional writes and shared accounts", () => {
  it("an install state or session keyed to a target lands only while the row still has it", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const target = { host: web.host, port: web.port, username: web.username, workdir: web.workdir };
    expect(store.setServerAgentInstallState(ownerId, web.id, OK_STATE, target)).toBe(true);
    expect(store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283", target)).toBe(true);
    // Re-pointed (or deleted) meanwhile: neither write lands.
    store.updateServerAgent(ownerId, web.id, { workdir: "/srv/other" });
    expect(store.setServerAgentInstallState(ownerId, web.id, OK_STATE, target)).toBe(false);
    expect(store.getServerAgent(ownerId, web.id)?.installState).toBeNull();
    expect(store.setServerAgentSession("c1", web.id, "remote-2", "0.3.283", target)).toBe(false);
    expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    store.deleteServerAgent(ownerId, web.id);
    expect(store.setServerAgentSession("c1", web.id, "remote-3", "0.3.283", { ...target, workdir: "/srv/other" })).toBe(false);
    expect(sessionCount(store)).toBe(0);
  });

  it("counts rows of ANY owner on the same remote account, excluding the row itself", () => {
    const { store, ownerId } = boot();
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const web = create(store, ownerId);
    expect(store.countServerAgentsOnAccount("WEB-01.corp.example", 22, "noah-agent", web.id)).toBe(0);
    create(store, other.id, { workdir: "/srv/elsewhere" });
    create(store, ownerId, { name: "web-02", username: "someone-else" });
    expect(store.countServerAgentsOnAccount("web-01.corp.example", 22, "noah-agent", web.id)).toBe(1);
  });

  it("the admin switch is OFF by default and persists once set", () => {
    const { store } = boot();
    expect(store.isServerAgentsEnabled()).toBe(false);
    store.setServerAgentsEnabled(true);
    expect(store.isServerAgentsEnabled()).toBe(true);
    const { store: reopened } = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    expect(reopened.isServerAgentsEnabled()).toBe(true);
    reopened.setServerAgentsEnabled(false);
    expect(reopened.isServerAgentsEnabled()).toBe(false);
  });

  it("mints ONE deployment id and reads it back across restarts", () => {
    const { store } = boot();
    const id = store.serverAgentDeploymentId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
    expect(store.serverAgentDeploymentId()).toBe(id);
    const { store: reopened } = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    expect(reopened.serverAgentDeploymentId()).toBe(id);
  });
});

describe("server agents — sessions", () => {
  it("upserts, lists and deletes the (conversation, server) mapping", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const db = create(store, ownerId, { name: "db-01" });
    expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c1", web.id, "remote-1b", "0.3.290");
    expect(store.getServerAgentSession("c1", web.id)).toMatchObject({ remoteSessionId: "remote-1b", cliVersion: "0.3.290" });
    store.setServerAgentSession("c1", db.id, "remote-2", "0.3.290");
    expect(store.listServerAgentSessionIds("c1").sort()).toEqual([db.id, web.id].sort());
    expect(store.deleteServerAgentSession("c1", web.id)).toBe(true);
    expect(store.deleteServerAgentSession("c1", web.id)).toBe(false);
    expect(store.listServerAgentSessionIds("c1")).toEqual([db.id]);
    store.deleteServerAgentSessionsForConversation("c1");
    expect(store.listServerAgentSessionIds("c1")).toEqual([]);
  });

  it("deleting a server drops its sessions", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.deleteServerAgent(ownerId, web.id);
    expect(sessionCount(store)).toBe(0);
  });
});

describe("server agents — cascades", () => {
  function seedConversation(store: Store, ownerId: string, conversationId: string) {
    store.touchConversation(ownerId, conversationId, ownerId, "첫 질문");
    const first = store.addMessage(conversationId, { role: "user", content: "첫 질문" });
    store.addMessage(conversationId, { role: "assistant", content: "첫 답" });
    return first;
  }

  it("deleteConversation drops only that conversation's sessions", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    seedConversation(store, ownerId, "c1");
    seedConversation(store, ownerId, "c2");
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c2", web.id, "remote-2", "0.3.283");
    expect(store.deleteConversation(ownerId, "c1")).toBe(true);
    expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    expect(store.getServerAgentSession("c2", web.id)?.remoteSessionId).toBe("remote-2");
    // The server row itself survives a conversation delete.
    expect(store.getServerAgent(ownerId, web.id)).not.toBeNull();
  });

  it("deleteChatConversations drops every chat conversation's sessions", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    seedConversation(store, ownerId, "c1");
    seedConversation(store, ownerId, "c2");
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c2", web.id, "remote-2", "0.3.283");
    expect(store.deleteChatConversations(ownerId).sort()).toEqual(["c1", "c2"]);
    expect(sessionCount(store)).toBe(0);
  });

  it("applyConversationRewind resets the rewound conversation's sessions (the next delegation starts fresh)", () => {
    const { store, ownerId } = boot();
    const web = create(store, ownerId);
    const first = seedConversation(store, ownerId, "c1");
    seedConversation(store, ownerId, "c2");
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c2", web.id, "remote-2", "0.3.283");
    const plan = store.planConversationRewind(ownerId, "c1", first.id, "after")!;
    expect(store.applyConversationRewind(ownerId, "c1", plan)).toBe(true);
    expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    expect(store.getServerAgentSession("c2", web.id)?.remoteSessionId).toBe("remote-2");
  });

  it("deleteUser removes the owner's servers and their sessions, not another owner's", () => {
    const { store, ownerId } = boot();
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const web = create(store, ownerId);
    const theirs = create(store, other.id);
    seedConversation(store, ownerId, "c1");
    store.setServerAgentSession("c1", web.id, "remote-1", "0.3.283");
    store.setServerAgentSession("c-other", theirs.id, "remote-x", "0.3.283");
    expect(store.deleteUser(ownerId)).toBe(true);
    expect(store.listServerAgents(ownerId)).toEqual([]);
    expect(store.getServerAgentSession("c1", web.id)).toBeNull();
    expect(store.listServerAgents(other.id).map((s) => s.id)).toEqual([theirs.id]);
    expect(store.getServerAgentSession("c-other", theirs.id)?.remoteSessionId).toBe("remote-x");
  });
});
