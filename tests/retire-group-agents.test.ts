// Boot-time retirement of the removed group shared agents (pi migration
// decision D4: their history is deleted). A deployment that ran them still
// holds the `group_agents` table and every member's `group:<groupId>:<agentId>`
// thread (or a pre-multi `group:<groupId>` one) with messages, canvases, share
// links, notifications, task-API rows, chat media, SDK session artifacts and
// the agents' images and workspace trees. The retirement deletes all of it —
// disk first, then one DB transaction that also drops the table — while the
// groups themselves, their members and knowledge repos, and every personal
// avatar's data survive. It runs on every boot until one clean pass stamps the
// `retired:group_agents` marker.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir, safeConversationDir } from "../src/server/chatImages.js";
import { loadConfig } from "../src/server/config.js";
import { groupKnowledgeClonePath } from "../src/server/groupKnowledgeRepo.js";
import logger from "../src/server/logger.js";
import { retireGroupAgents } from "../src/server/retireGroupAgents.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import { signup, withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-group-agents");

afterEach(() => {
  vi.restoreAllMocks();
});

function configFor(label: string): AppConfig {
  return loadConfig({
    dataDir: path.join(tempDir(), label),
    agentRuntime: "local",
    sessionSecret: "t",
  });
}

/** The table exactly as the last release created it. */
const LEGACY_TABLE = `
  CREATE TABLE IF NOT EXISTS group_agents (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    alias TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    intro TEXT DEFAULT '',
    persona TEXT DEFAULT '',
    hashtags TEXT,
    avatar_ext TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    capture_scope TEXT NOT NULL DEFAULT 'members',
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_group_agents_group ON group_agents(group_id);
`;
const T0 = "2026-09-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
/** SDK session ids: an agent thread's own, its fork, and the owner's. */
const AGENT_SESSION = "44444444-4444-4444-8444-444444444444";
const AGENT_FORK_SESSION = "55555555-5555-4555-8555-555555555555";
const OWN_SESSION = "66666666-6666-4666-8666-666666666666";

function writeFile(file: string, body = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** The CLI's project-folder name for a cwd. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function shareLink(ownerUserId: string, conversationId: string, id: string) {
  return {
    id,
    ownerUserId,
    conversationId,
    fileId: `${id}-file`,
    fileName: "deck.pptx",
    slideIds: [],
    tokenHash: `${id}-hash`,
    tokenSalt: `${id}-salt`,
    createdAt: new Date().toISOString(),
    expiresAt: FAR_FUTURE,
  };
}

function tableExists(config: AppConfig, name: string, type = "table"): boolean {
  const raw = new Database(config.dbPath, { readonly: true });
  try {
    return Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name));
  } finally {
    raw.close();
  }
}

function countRows(config: AppConfig, sql: string, ...params: unknown[]): number {
  const raw = new Database(config.dbPath, { readonly: true });
  try {
    return (raw.prepare(sql).get(...params) as { c: number }).c;
  } finally {
    raw.close();
  }
}

/** The stored pending-retry document, parsed (null when there is none). */
function pendingDocument(store: Store): { v: number; paths: string[]; sessionIds: string[] } | null {
  const state = store.retiredGroupAgentPendingState();
  return state.status === "ok" ? JSON.parse(state.value) : null;
}

/**
 * Build a deployment as the last release left it: two members chatting with a
 * group agent (one thread with a canvas, a share link, a notification, a
 * task-API row, chat media and SDK sessions; one pre-multi thread), rows keyed
 * by the agent id itself, the agent table, image and workspace files — and,
 * as CONTROLS, the owner's own thread with its session, the group with its
 * members and knowledge repo, a personal avatar image and workspace.
 */
function seedLegacyDeployment(config: AppConfig) {
  const store = new Store(config);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
  const group = store.createGroup({ name: "Team" });
  store.addGroupMember(group.id, owner.id, "member");
  store.addGroupMember(group.id, other.id, "admin");
  store.setGroupKnowledgeRepo(group.id, "acme/team-knowledge", "main");
  const agentAvatar = `group:${group.id}:agent-1`;
  const legacyAvatar = `group:${group.id}`;

  // Controls.
  store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
  store.addMessage("own-chat", { role: "user", content: "안녕" });
  store.addMessage("own-chat", { role: "assistant", content: "반가워요" });
  store.upsertCanvasArtifact(owner.id, "own-chat", {
    artifactId: "own-canvas",
    title: "내 캔버스",
    content: "<p>own</p>",
    contentType: "text/html",
  });
  expect(store.createShareLink(shareLink(owner.id, "own-chat", "own-link")).status).toBe("created");
  store.addAvatarNotification(owner.id, { avatarUserId: owner.id, message: "own", conversationId: "own-chat" });
  store.addKnowledgeRequest(owner.id, { question: "owner gap" });
  const ownRoutine = store.createRoutineJob(owner.id, { prompt: "매일 요약", minuteOfDay: 540 });

  // Agent data the store API can still write (it never validates the id).
  store.touchConversation(owner.id, "ga-chat", agentAvatar, "팀 질문");
  store.addMessage("ga-chat", { role: "user", content: "팀 질문" });
  store.addMessage("ga-chat", { role: "assistant", content: "팀 답" });
  store.upsertCanvasArtifact(owner.id, "ga-chat", {
    artifactId: "ga-canvas",
    title: "팀 캔버스",
    content: "<p>ga</p>",
    contentType: "text/html",
  });
  expect(store.createShareLink(shareLink(owner.id, "ga-chat", "ga-link")).status).toBe("created");
  store.addAvatarNotification(owner.id, { avatarUserId: owner.id, message: "ga", conversationId: "ga-chat" });
  // Keyed by the agent id itself rather than by an agent thread.
  store.addAvatarNotification(owner.id, { avatarUserId: agentAvatar, message: "ga-keyed" });
  store.addKnowledgeRequest(agentAvatar, { question: "agent gap" });
  store.touchConversation(other.id, "ga-legacy", legacyAvatar, "예전 스레드");
  store.addMessage("ga-legacy", { role: "user", content: "예전" });
  store.close();

  // What only the retired code (or the SDK) could write.
  const raw = new Database(config.dbPath);
  raw.exec(LEGACY_TABLE);
  raw
    .prepare(
      "INSERT INTO group_agents (id, group_id, display_name, avatar_ext, capture_scope, created_at) VALUES (?, ?, ?, 'png', 'members', ?)",
    )
    .run("agent-1", group.id, "팀 비서", T0);
  raw
    .prepare(
      "INSERT INTO avatar_tasks (id, owner_user_id, api_key_id, conversation_id, message, status, fingerprint, created_at, updated_at) VALUES (?, ?, 'key', ?, 'm', 'succeeded', 'fp', ?, ?)",
    )
    .run("api-ga", owner.id, "ga-chat", T0, T0);
  raw
    .prepare(
      "INSERT INTO routine_jobs (id, avatar_user_id, conversation_id, prompt, minute_of_day, created_at) VALUES ('ga-keyed-routine', ?, 'no-thread', 'p', 0, ?)",
    )
    .run(agentAvatar, T0);
  raw.prepare("UPDATE conversations SET agent_session_id = ? WHERE id = ?").run(AGENT_SESSION, "ga-chat");
  raw
    .prepare("UPDATE messages SET sdk_session_id = ? WHERE conversation_id = ? AND role = 'assistant'")
    .run(AGENT_FORK_SESSION, "ga-chat");
  raw.prepare("UPDATE conversations SET agent_session_id = ? WHERE id = ?").run(OWN_SESSION, "own-chat");
  raw.close();

  const avatars = path.join(config.dataDir, "avatars");
  const sessions = config.agentSessionsDir;
  const projects = path.join(sessions, "projects");
  // A project folder shared with the owner's own sessions (a work repo cwd).
  const sharedProject = path.join(projects, projectDirName(path.join(config.dataDir, "git-repos", owner.id, "repo")));
  const agentWorkspace = workspaceDirFor(config, agentAvatar, "ga-chat");
  const files = {
    image: writeFile(path.join(avatars, `${agentAvatar}.png`)),
    legacyImage: writeFile(path.join(avatars, `${legacyAvatar}.webp`)),
    chatImage: writeFile(path.join(chatImagesDir(config, "ga-chat"), "a.png")),
    chatFile: writeFile(path.join(chatFilesDir(config, "ga-legacy"), "f.pdf")),
    workspace: writeFile(path.join(agentWorkspace, "attachments", "a.png")),
    legacyWorkspace: writeFile(path.join(workspaceDirFor(config, legacyAvatar, "ga-legacy"), "notes.md")),
    sharedTranscript: writeFile(path.join(sharedProject, `${AGENT_SESSION}.jsonl`)),
    workspaceProject: writeFile(path.join(projects, projectDirName(agentWorkspace), `${AGENT_FORK_SESSION}.jsonl`)),
    sessionEnv: writeFile(path.join(sessions, "session-env", AGENT_SESSION, "env")),
    todos: writeFile(path.join(sessions, "todos", `${AGENT_FORK_SESSION}-agent-${AGENT_FORK_SESSION}.json`)),
  };
  const controls = {
    ownerImage: writeFile(path.join(avatars, `${owner.id}.png`)),
    ownWorkspace: writeFile(path.join(workspaceDirFor(config, owner.id, "own-chat"), "notes.md")),
    ownChatImage: writeFile(path.join(chatImagesDir(config, "own-chat"), "a.png")),
    ownTranscript: writeFile(path.join(sharedProject, `${OWN_SESSION}.jsonl`)),
    ownSessionEnv: writeFile(path.join(sessions, "session-env", OWN_SESSION, "env")),
    groupClone: writeFile(path.join(groupKnowledgeClonePath(group.id, config), "wiki", "rule.md")),
  };
  return { owner, other, group, agentAvatar, legacyAvatar, ownRoutine, files, controls };
}

describe("retireGroupAgents", () => {
  it("purges every agent thread, row, table and file, then stamps the marker", () => {
    const config = configFor("legacy");
    const seed = seedLegacyDeployment(config);
    const store = new Store(config);
    expect(store.groupAgentsRetired()).toBe(false);

    const purge = retireGroupAgents({ config, store });

    expect(purge).toEqual({ agents: 1, conversations: 2, messages: 3, routines: 1, notifications: 2 });
    expect(tableExists(config, "group_agents")).toBe(false);
    expect(tableExists(config, "idx_group_agents_group", "index")).toBe(false);
    for (const avatarId of [seed.agentAvatar, seed.legacyAvatar]) {
      expect(store.countConversationsForAvatar(avatarId)).toBe(0);
    }
    for (const id of ["ga-chat", "ga-legacy"]) {
      expect(countRows(config, "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?", id)).toBe(0);
    }
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'ga-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'ga-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM avatar_tasks WHERE id = 'api-ga'")).toBe(0);
    for (const table of ["routine_jobs", "avatar_notifications", "knowledge_requests"]) {
      expect(
        countRows(config, `SELECT COUNT(*) AS c FROM ${table} WHERE substr(avatar_user_id, 1, 6) = 'group:'`),
        table,
      ).toBe(0);
    }
    for (const [name, file] of Object.entries(seed.files)) {
      expect(fs.existsSync(file), name).toBe(false);
    }
    // Whole agent trees go: workspace folders and the workspace-cwd project folder.
    expect(fs.existsSync(path.dirname(path.dirname(path.dirname(seed.files.workspace))))).toBe(false);
    expect(fs.existsSync(path.dirname(seed.files.workspaceProject))).toBe(false);

    // Controls survive untouched — the group itself included.
    expect(store.listConversations(seed.owner.id).map((c) => c.id)).toEqual(["own-chat"]);
    expect(store.listMessages(seed.owner.id, "own-chat")).toHaveLength(2);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(
      countRows(config, "SELECT COUNT(*) AS c FROM knowledge_requests WHERE avatar_user_id = ?", seed.owner.id),
    ).toBe(1);
    expect(store.listRoutineJobs(seed.owner.id).map((job) => job.id)).toEqual([seed.ownRoutine.id]);
    expect(store.getGroup(seed.group.id)?.name).toBe("Team");
    expect(store.groupRoleFor(seed.other.id, seed.group.id)).toBe("admin");
    expect(store.getGroupKnowledgeRepo(seed.group.id).repo).toBe("acme/team-knowledge");
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }

    expect(store.groupAgentsRetired()).toBe(true);
    expect(pendingDocument(store)).toBeNull();
    // Every later boot returns at once.
    expect(retireGroupAgents({ config, store })).toBeNull();
    store.close();
  });

  it("stamps a fresh database silently on its first boot, and the schema never re-creates the table", () => {
    const config = configFor("fresh");
    const store = new Store(config);
    expect(tableExists(config, "group_agents")).toBe(false);
    const warn = vi.spyOn(logger, "warn");

    expect(retireGroupAgents({ config, store })).toBeNull();

    expect(store.groupAgentsRetired()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    store.close();
  });

  it("purges the rows even when a media folder cannot be removed, keeps it pending, and finishes next boot", () => {
    const config = configFor("sweep-fails");
    const seed = seedLegacyDeployment(config);
    const busy = path.dirname(seed.files.chatImage);
    const realRm = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target) === busy) {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      }
      realRm(target, options);
    }) as typeof fs.rmSync);
    const warn = vi.spyOn(logger, "warn");
    const store = new Store(config);

    const purge = retireGroupAgents({ config, store });

    // The history never waits on the disk: the rows and the table are gone...
    expect(purge).toMatchObject({ agents: 1, conversations: 2 });
    expect(store.countConversationsForAvatar(seed.agentAvatar)).toBe(0);
    expect(tableExists(config, "group_agents")).toBe(false);
    // ...but the folder stays, only the purged rows could name it, so it is
    // stored as pending, the marker is withheld, and ONE warning names it.
    expect(fs.existsSync(busy)).toBe(true);
    expect(pendingDocument(store)).toEqual({
      v: 1,
      paths: [`chat-images/${safeConversationDir("ga-chat")}`],
      sessionIds: [],
    });
    expect(store.groupAgentsRetired()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { failures: 1, paths: [`${busy} (EBUSY)`] },
      expect.stringContaining("NOT stamped"),
    );

    vi.mocked(fs.rmSync).mockRestore();
    expect(retireGroupAgents({ config, store })).toBeNull();
    expect(fs.existsSync(busy)).toBe(false);
    expect(store.groupAgentsRetired()).toBe(true);
    expect(pendingDocument(store)).toBeNull();
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }
    store.close();
  });

  it("does not skip a marked boot while pending retries are stored, and drops malformed entries", () => {
    const config = configFor("pending");
    const store = new Store(config);
    expect(retireGroupAgents({ config, store })).toBeNull();
    expect(store.groupAgentsRetired()).toBe(true);
    const leftover = writeFile(path.join(chatFilesDir(config, "ga-left"), "f.pdf"));
    const sentinel = writeFile(path.join(config.dataDir, "sentinel", "keep.txt"));
    store.saveRetiredGroupAgentPending(
      JSON.stringify({
        v: 1,
        paths: [`chat-files/${safeConversationDir("ga-left")}`, "../sentinel", "chat-images"],
        sessionIds: ["../../sentinel"],
      }),
    );
    const warn = vi.spyOn(logger, "warn");

    expect(retireGroupAgents({ config, store })).toBeNull();

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ dropped: expect.any(Array) }),
      expect.stringContaining("malformed retired group-agent"),
    );
    expect(pendingDocument(store)).toBeNull();
    expect(store.groupAgentsRetired()).toBe(true);
    store.close();
  });

  it("re-runs the full retirement when an older release re-created the table after the stamp", () => {
    const config = configFor("rollback");
    seedLegacyDeployment(config);
    const first = new Store(config);
    retireGroupAgents({ config, store: first });
    expect(first.groupAgentsRetired()).toBe(true);
    // The older release: migrate() re-creates the table, and a member chats again.
    first.touchConversation("someone", "ga-again", "group:g:agent-2", "다시");
    first.addMessage("ga-again", { role: "user", content: "다시" });
    first.close();
    const raw = new Database(config.dbPath);
    raw.exec(LEGACY_TABLE);
    raw.close();
    const image = writeFile(path.join(config.dataDir, "avatars", "group:g:agent-2.png"));
    const warn = vi.spyOn(logger, "warn");

    const store = new Store(config);
    expect(retireGroupAgents({ config, store })).toMatchObject({ conversations: 1, messages: 1 });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recreated"));
    expect(tableExists(config, "group_agents")).toBe(false);
    expect(store.countConversationsForAvatar("group:g:agent-2")).toBe(0);
    expect(fs.existsSync(image)).toBe(false);
    expect(store.groupAgentsRetired()).toBe(true);
    store.close();
  });
});

describe("deleting a group after the retirement", () => {
  it("still removes the group's knowledge clone, and nothing else of the members'", async () => {
    const services = createServices({
      dataDir: path.join(tempDir(), "group-delete"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const { config, store } = services;
    const app = createApp(services);
    const admin = request.agent(app);
    const adminId = (await signup(admin, "sys-admin").expect(201)).body.user.id as string;
    const created = await admin.post("/api/admin/groups").send({ name: "Team" }).expect(200);
    const groupId = created.body.group.id as string;
    await admin.post(`/api/admin/groups/${groupId}/members`).send({ username: "sys-admin" }).expect(200);
    const clone = writeFile(path.join(groupKnowledgeClonePath(groupId, config), "wiki", "rule.md"));
    store.touchConversation(adminId, "own-chat", adminId, "안녕");
    const ownMedia = writeFile(path.join(chatImagesDir(config, "own-chat"), "a.png"));

    await admin.delete(`/api/admin/groups/${groupId}`).expect(200);

    expect(store.getGroup(groupId)).toBeNull();
    expect(fs.existsSync(path.dirname(path.dirname(clone)))).toBe(false);
    expect(store.listConversations(adminId).map((c) => c.id)).toEqual(["own-chat"]);
    expect(fs.existsSync(ownMedia)).toBe(true);
    store.close();
  });
});
