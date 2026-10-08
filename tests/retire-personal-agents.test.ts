// Boot-time retirement of the removed 내 봇 (personal agents) feature. A
// deployment that ran it still holds the `personal_agents` / `bot_tasks` tables,
// bot threads (`personal:<owner>:<agent>` avatar ids) with their messages,
// canvases, share links, notifications and SDK session ids, bot-bound routines
// (`routine_jobs.personal_agent_id`) and the bots' files. The retirement deletes
// all of it — disk first, then one DB transaction that also drops the two
// tables — while everything that is not a bot's survives: the owner's own and
// group-agent threads, the owner's routines, sessions and files, and the bots'
// memory folders inside the owner's knowledge repo (user content, never
// touched). It runs on every boot until one clean pass stamps the
// `retired:personal_agents` marker, and never again after that.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir } from "../src/server/chatImages.js";
import { loadConfig } from "../src/server/config.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import logger from "../src/server/logger.js";
import { retirePersonalAgents } from "../src/server/retirePersonalAgents.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-personal-agents");

afterEach(() => {
  vi.restoreAllMocks();
});

function configFor(label: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig({
    dataDir: path.join(tempDir(), label),
    agentRuntime: "local",
    sessionSecret: "t",
    ...overrides,
  });
}

/** The two tables exactly as the last release created them. */
const LEGACY_TABLES = `
  CREATE TABLE personal_agents (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    alias TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    intro TEXT DEFAULT '',
    persona TEXT DEFAULT '',
    hashtags TEXT,
    avatar_ext TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    default_model TEXT,
    memory_dir TEXT,
    selected_skills TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX idx_personal_agents_owner ON personal_agents(owner_user_id);
  CREATE TABLE bot_tasks (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    run_id TEXT,
    title TEXT NOT NULL,
    request_text TEXT NOT NULL,
    status TEXT NOT NULL,
    reported_outcome TEXT,
    result_summary TEXT,
    pending_question TEXT,
    error TEXT,
    model TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    seen_at TEXT,
    routine_job_id TEXT,
    delegated_by_agent_id TEXT,
    delegation_depth INTEGER DEFAULT 0,
    resume_log TEXT
  );
  CREATE INDEX idx_bot_tasks_owner ON bot_tasks(owner_user_id, created_at DESC);
  CREATE INDEX idx_bot_tasks_conversation ON bot_tasks(conversation_id, created_at ASC);
`;
/** ...plus the routine column it added. */
const LEGACY_SCHEMA = `${LEGACY_TABLES}
  ALTER TABLE routine_jobs ADD COLUMN personal_agent_id TEXT;
`;

const T0 = "2026-09-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
/** SDK session ids: a bot thread's own, a bot thread's fork, and the owner's. */
const BOT_SESSION = "11111111-1111-4111-8111-111111111111";
const BOT_FORK_SESSION = "22222222-2222-4222-8222-222222222222";
const OWN_SESSION = "33333333-3333-4333-8333-333333333333";
/** A stored session id that would escape `session-env/` if it were ever joined into a path. */
const TRAVERSAL_SESSION = "../../sentinel";

function writeFile(file: string, body = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** The CLI's project-folder name for a cwd. */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

/** Make `fs.rmSync` throw `code` the first time it is called on one of `targets`. */
function failRmOnce(targets: string[], code: string) {
  const realRm = fs.rmSync;
  const remaining = new Set(targets);
  return vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
    if (remaining.delete(String(target))) {
      throw errnoError(code);
    }
    realRm(target, options);
  }) as typeof fs.rmSync);
}

/** Make `fs.readdirSync` throw `code` whenever it lists `dir`. */
function failReaddir(dir: string, code: string) {
  const realReaddir = fs.readdirSync as (target: fs.PathLike, options?: unknown) => unknown;
  return vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
    if (String(target) === dir) {
      throw errnoError(code);
    }
    return realReaddir(target, options);
  }) as unknown as typeof fs.readdirSync);
}

/** The stored pending-retry document, parsed (null when there is none). */
function pendingDocument(store: Store): { v: number; paths: string[]; sessionIds: string[] } | null {
  const state = store.retiredPersonalAgentPendingState();
  return state.status === "ok" ? JSON.parse(state.value) : null;
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

/**
 * Build a deployment as the last release left it: an owner with two bots (one
 * with a recorded image extension, one without), a bot thread with a canvas, a
 * share link, a notification, a task-API row and two session ids, a thread
 * whose bot row is already gone, a bot routine (composite-bound thread), a
 * bound routine whose thread is gone, rows keyed by a bot avatar id, bot tasks
 * and the bots' files and SDK artifacts — and, as CONTROLS, the owner's own
 * thread + routine + task-API row + knowledge request + sessions + files, a
 * group-agent thread, another user's avatar image, and a bot memory folder in
 * the owner's knowledge clone.
 */
function seedLegacyDeployment(config: AppConfig) {
  const store = new Store(config);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const colleague = store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
  const group = store.createGroup({ name: "Team" });
  store.addGroupMember(group.id, owner.id, "member");
  const groupAgent = store.createGroupAgent(group.id, { displayName: "팀 비서" })!;
  const groupAvatar = `group:${group.id}:${groupAgent.id}`;
  const botA = `personal:${owner.id}:agent-a`;
  const botB = `personal:${owner.id}:agent-b`;
  const botGone = `personal:${owner.id}:agent-gone`;

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
  store.touchConversation(owner.id, "group-chat", groupAvatar, "팀");
  store.addMessage("group-chat", { role: "user", content: "팀" });
  const ownRoutine = store.createRoutineJob(owner.id, { prompt: "매일 요약", minuteOfDay: 540 });

  // Bot data that the store API can still write (it never validates the id).
  store.touchConversation(owner.id, "bot-chat", botA, "봇 대화");
  store.addMessage("bot-chat", { role: "user", content: "봇에게" });
  store.addMessage("bot-chat", { role: "assistant", content: "봇 답" });
  store.upsertCanvasArtifact(owner.id, "bot-chat", {
    artifactId: "bot-canvas",
    title: "봇 캔버스",
    content: "<p>bot</p>",
    contentType: "text/html",
  });
  expect(store.createShareLink(shareLink(owner.id, "bot-chat", "bot-link")).status).toBe("created");
  store.addAvatarNotification(owner.id, { avatarUserId: owner.id, message: "bot", conversationId: "bot-chat" });
  // Keyed by the bot id itself rather than by a bot thread.
  store.addAvatarNotification(owner.id, { avatarUserId: botA, message: "bot-keyed" });
  store.addKnowledgeRequest(botA, { question: "bot gap" });
  store.touchConversation(owner.id, "bot-orphan-chat", botGone, "주인 잃은 스레드");
  store.addMessage("bot-orphan-chat", { role: "user", content: "고아" });
  const botRoutine = store.createRoutineJob(owner.id, { prompt: "봇 루틴", minuteOfDay: 600 });
  const orphanRoutine = store.createRoutineJob(owner.id, { prompt: "스레드 없는 봇 루틴", minuteOfDay: 660 });
  store.close();

  // What only the retired code (or the SDK) could write.
  const raw = new Database(config.dbPath);
  raw.exec(LEGACY_SCHEMA);
  const insertBot = raw.prepare(
    "INSERT INTO personal_agents (id, owner_user_id, display_name, avatar_ext, memory_dir, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertBot.run("agent-a", owner.id, "리서치 봇", "png", "research-agent-a", T0);
  insertBot.run("agent-b", owner.id, "릴리즈 봇", null, "release-agent-b", T0);
  const insertTask = raw.prepare(
    "INSERT INTO bot_tasks (id, owner_user_id, agent_id, conversation_id, title, request_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertTask.run("task-1", owner.id, "agent-a", "bot-chat", "조사", "조사해 줘", "done", T0);
  insertTask.run("task-2", owner.id, "agent-a", "bot-chat", "정리", "정리해 줘", "queued", T0);
  const insertApiTask = raw.prepare(
    "INSERT INTO avatar_tasks (id, owner_user_id, api_key_id, conversation_id, message, status, fingerprint, created_at, updated_at) VALUES (?, ?, 'key', ?, 'm', 'succeeded', 'fp', ?, ?)",
  );
  insertApiTask.run("api-bot", owner.id, "bot-chat", T0, T0);
  insertApiTask.run("api-own", owner.id, "own-chat", T0, T0);
  raw
    .prepare(
      "INSERT INTO routine_jobs (id, avatar_user_id, conversation_id, prompt, minute_of_day, created_at) VALUES ('bot-keyed-routine', ?, 'no-thread', 'p', 0, ?)",
    )
    .run(botA, T0);
  raw.prepare("UPDATE conversations SET avatar_user_id = ? WHERE id = ?").run(botA, botRoutine.conversationId);
  raw.prepare("UPDATE routine_jobs SET personal_agent_id = ? WHERE id = ?").run("agent-a", botRoutine.id);
  raw.prepare("UPDATE routine_jobs SET personal_agent_id = ? WHERE id = ?").run("agent-b", orphanRoutine.id);
  raw.prepare("DELETE FROM conversations WHERE id = ?").run(orphanRoutine.conversationId);
  const setThreadSession = raw.prepare("UPDATE conversations SET agent_session_id = ? WHERE id = ?");
  const setMessageSession = raw.prepare(
    "UPDATE messages SET sdk_session_id = ? WHERE conversation_id = ? AND role = ?",
  );
  setThreadSession.run(BOT_SESSION, "bot-chat");
  setMessageSession.run(BOT_FORK_SESSION, "bot-chat", "assistant");
  setMessageSession.run(TRAVERSAL_SESSION, "bot-orphan-chat", "user");
  setThreadSession.run(OWN_SESSION, "own-chat");
  setMessageSession.run(OWN_SESSION, "own-chat", "assistant");
  raw.close();

  // Files.
  const avatars = path.join(config.dataDir, "avatars");
  const sessions = config.agentSessionsDir;
  const projects = path.join(sessions, "projects");
  // A work-repo thread runs in the owner's shared clone: bot and owner
  // transcripts share this project folder.
  const sharedProject = path.join(projects, projectDirName(path.join(config.dataDir, "git-repos", owner.id, "repo")));
  const files = {
    botImage: writeFile(path.join(avatars, `${botA}.png`)),
    unrecordedBotImage: writeFile(path.join(avatars, `${botB}.webp`)),
    botWorkspace: writeFile(path.join(workspaceDirFor(config, botA, "bot-chat"), "notes.md")),
    orphanBotWorkspace: writeFile(path.join(workspaceDirFor(config, botGone, "bot-orphan-chat"), "notes.md")),
    strayBotTree: writeFile(path.join(config.dataDir, "workspaces", "personal-stray-0123456789ab", "x", "f")),
    botChatImage: writeFile(path.join(chatImagesDir(config, "bot-chat"), "a.png")),
    botChatFile: writeFile(path.join(chatFilesDir(config, "bot-chat"), "f.pdf")),
    orphanChatFile: writeFile(path.join(chatFilesDir(config, "bot-orphan-chat"), "f.pdf")),
    sharedProjectBotTranscript: writeFile(path.join(sharedProject, `${BOT_SESSION}.jsonl`)),
    sharedProjectBotSubagent: writeFile(path.join(sharedProject, BOT_SESSION, "subagents", "agent-1.jsonl")),
    botWorkspaceTranscript: writeFile(
      path.join(projects, projectDirName(workspaceDirFor(config, botA, "bot-chat")), `${BOT_FORK_SESSION}.jsonl`),
    ),
    // A run that died before recording any session id: only its cwd names it.
    unrecordedRunTranscript: writeFile(
      path.join(projects, projectDirName(workspaceDirFor(config, botGone, "bot-orphan-chat")), "lost.jsonl"),
    ),
    botSessionEnv: writeFile(path.join(sessions, "session-env", BOT_SESSION, "env")),
    botTasks: writeFile(path.join(sessions, "tasks", BOT_FORK_SESSION, "1.json")),
    botFileHistory: writeFile(path.join(sessions, "file-history", BOT_SESSION, "abc@v1")),
    botDebug: writeFile(path.join(sessions, "debug", `${BOT_SESSION}.txt`)),
    botTodos: writeFile(path.join(sessions, "todos", `${BOT_FORK_SESSION}-agent-${BOT_FORK_SESSION}.json`)),
  };
  const controls = {
    ownerImage: writeFile(path.join(avatars, `${owner.id}.png`)),
    colleagueImage: writeFile(path.join(avatars, `${colleague.id}.jpg`)),
    groupAgentImage: writeFile(path.join(avatars, `${groupAvatar}.png`)),
    ownWorkspace: writeFile(path.join(workspaceDirFor(config, owner.id, "own-chat"), "notes.md")),
    groupWorkspace: writeFile(path.join(workspaceDirFor(config, groupAvatar, "group-chat"), "notes.md")),
    ownChatImage: writeFile(path.join(chatImagesDir(config, "own-chat"), "a.png")),
    groupChatFile: writeFile(path.join(chatFilesDir(config, "group-chat"), "f.pdf")),
    botMemory: writeFile(
      path.join(knowledgeClonePath(owner.id, config), "agents", "research-agent-a", "wiki", "note.md"),
    ),
    sharedProjectOwnTranscript: writeFile(path.join(sharedProject, `${OWN_SESSION}.jsonl`)),
    sharedProjectOwnSubagent: writeFile(path.join(sharedProject, OWN_SESSION, "subagents", "agent-1.jsonl")),
    ownWorkspaceTranscript: writeFile(
      path.join(projects, projectDirName(workspaceDirFor(config, owner.id, "own-chat")), `${OWN_SESSION}.jsonl`),
    ),
    ownSessionEnv: writeFile(path.join(sessions, "session-env", OWN_SESSION, "env")),
    ownTasks: writeFile(path.join(sessions, "tasks", OWN_SESSION, "1.json")),
    ownTodos: writeFile(path.join(sessions, "todos", `${OWN_SESSION}-agent-${OWN_SESSION}.json`)),
    // Where TRAVERSAL_SESSION would land if it were joined under session-env/.
    traversalTarget: writeFile(path.join(config.dataDir, "sentinel", "keep.txt")),
  };
  return { owner, groupAvatar, botA, botGone, ownRoutine, botRoutine, orphanRoutine, files, controls };
}

/**
 * A deployment retired cleanly (marker stamped), then rolled back to the
 * release that still had bots: its migrate() re-created both tables, and an
 * admin made a bot, a bot thread with chat media, and a bot-bound routine.
 */
function seedRollback(config: AppConfig) {
  const seed = seedLegacyDeployment(config);
  const first = new Store(config);
  retirePersonalAgents({ config, store: first });
  expect(first.personalAgentsRetired()).toBe(true);
  const botC = `personal:${seed.owner.id}:agent-c`;
  first.touchConversation(seed.owner.id, "rollback-chat", botC, "다시 봇");
  first.addMessage("rollback-chat", { role: "user", content: "다시" });
  const routine = first.createRoutineJob(seed.owner.id, { prompt: "되돌린 봇 루틴", minuteOfDay: 720 });
  first.close();
  const raw = new Database(config.dbPath);
  raw.exec(LEGACY_TABLES);
  raw
    .prepare("INSERT INTO personal_agents (id, owner_user_id, display_name, created_at) VALUES ('agent-c', ?, '복귀 봇', ?)")
    .run(seed.owner.id, T0);
  raw.prepare("UPDATE conversations SET avatar_user_id = ? WHERE id = ?").run(botC, routine.conversationId);
  raw.prepare("UPDATE routine_jobs SET personal_agent_id = 'agent-c' WHERE id = ?").run(routine.id);
  raw.close();
  const chatImages = chatImagesDir(config, "rollback-chat");
  return {
    seed,
    botC,
    routine,
    chatImages,
    chatImage: writeFile(path.join(chatImages, "a.png")),
    botImage: writeFile(path.join(config.dataDir, "avatars", `${botC}.png`)),
  };
}

function tableExists(config: AppConfig, table: string): boolean {
  const raw = new Database(config.dbPath, { readonly: true });
  try {
    return Boolean(raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
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

describe("retirePersonalAgents", () => {
  it("purges every bot row, thread, routine, file and session artifact, then stamps the marker", () => {
    const config = configFor("legacy");
    const seed = seedLegacyDeployment(config);
    // The next boot: the Store opens the legacy DB (migrate() no longer knows
    // the two tables), then the retirement runs.
    const store = new Store(config);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(store.listConversations(seed.owner.id).map((c) => c.id).sort()).toEqual(
      ["bot-chat", "bot-orphan-chat", "group-chat", "own-chat"],
    );

    const purge = retirePersonalAgents({ config, store });

    expect(purge).toEqual({
      bots: 2,
      tasks: 2,
      conversations: 3,
      messages: 3,
      routines: 3,
      notifications: 2,
    });
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(tableExists(config, "bot_tasks")).toBe(false);

    // Bot threads and everything hanging off them are gone...
    expect(store.countConversationsForAvatar(seed.botA)).toBe(0);
    expect(store.countConversationsForAvatar(seed.botGone)).toBe(0);
    for (const id of ["bot-chat", "bot-orphan-chat", seed.botRoutine.conversationId]) {
      expect(countRows(config, "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?", id)).toBe(0);
    }
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'bot-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_versions WHERE artifact_id = 'bot-canvas'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'bot-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM avatar_tasks WHERE id = 'api-bot'")).toBe(0);
    expect(
      countRows(config, "SELECT COUNT(*) AS c FROM avatar_notifications WHERE conversation_id = 'bot-chat'"),
    ).toBe(0);
    // ...as are the rows keyed by the bot id itself...
    for (const table of ["routine_jobs", "avatar_notifications", "knowledge_requests"]) {
      expect(countRows(config, `SELECT COUNT(*) AS c FROM ${table} WHERE avatar_user_id = ?`, seed.botA), table).toBe(0);
    }
    // ...and both bot-bound routines (one through its thread, one by the
    // binding alone), which the scheduler would otherwise run as the owner.
    expect(store.listRoutineJobs(seed.owner.id).map((job) => job.id)).toEqual([seed.ownRoutine.id]);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM routine_jobs WHERE personal_agent_id IS NOT NULL")).toBe(0);

    // Controls survive untouched.
    const remaining = store.listConversations(seed.owner.id);
    expect(remaining.map((c) => c.id).sort()).toEqual(["group-chat", "own-chat"]);
    expect(remaining.find((c) => c.id === "group-chat")?.avatarDisplayName).toBe("팀 비서");
    expect(store.listMessages(seed.owner.id, "own-chat")).toHaveLength(2);
    expect(store.listMessages(seed.owner.id, "group-chat")).toHaveLength(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM avatar_tasks WHERE id = 'api-own'")).toBe(1);
    expect(
      countRows(config, "SELECT COUNT(*) AS c FROM avatar_notifications WHERE conversation_id = 'own-chat'"),
    ).toBe(1);
    expect(
      countRows(config, "SELECT COUNT(*) AS c FROM knowledge_requests WHERE avatar_user_id = ?", seed.owner.id),
    ).toBe(1);
    expect(
      store.listConversations(seed.owner.id, undefined, "routine").map((c) => c.id),
    ).toEqual([seed.ownRoutine.conversationId]);

    // Files: every bot artifact is gone, every control file is still there.
    for (const [name, file] of Object.entries(seed.files)) {
      expect(fs.existsSync(file), name).toBe(false);
    }
    expect(fs.existsSync(path.dirname(workspaceDirFor(config, seed.botA, "x")))).toBe(false);
    // Bot-workspace project folders go whole, by name; the work-repo folder the
    // owner shares stays, with only the bot sessions' files taken out of it.
    expect(fs.existsSync(path.dirname(seed.files.botWorkspaceTranscript))).toBe(false);
    expect(fs.existsSync(path.dirname(seed.files.unrecordedRunTranscript))).toBe(false);
    expect(fs.existsSync(path.dirname(seed.files.sharedProjectBotTranscript))).toBe(true);
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }

    // The clean pass stamped the marker (with nothing pending), so the next
    // boot does NOTHING — not even the name-prefixed sweep (a file planted
    // under a bot prefix stays) — and a `personal:` conversation created later
    // is never touched by a marked boot. (The prefix stays reserved anyway: a
    // re-retirement after a rollback would delete it.)
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });
    const planted = writeFile(path.join(config.dataDir, "avatars", "personal:planted.png"));
    const plantedTree = writeFile(path.join(config.dataDir, "workspaces", "personal-planted-0123456789ab", "f"));
    store.touchConversation(seed.owner.id, "reused", "personal:someone:new", "새 기능");
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(planted)).toBe(true);
    expect(fs.existsSync(plantedTree)).toBe(true);
    expect(store.countConversationsForAvatar("personal:someone:new")).toBe(1);
    store.close();
    // Read by existence: a SESSION_SECRET rotation cannot un-mark the deployment.
    const rotated = new Store({ ...config, sessionSecret: "rotated" });
    expect(rotated.personalAgentsRetired()).toBe(true);
    expect(retirePersonalAgents({ config, store: rotated })).toBeNull();
    expect(rotated.countConversationsForAvatar("personal:someone:new")).toBe(1);
    rotated.close();
  });

  it("stamps a fresh database silently on its first boot", () => {
    const config = configFor("fresh");
    const store = new Store(config);
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    store.createRoutineJob(owner.id, { prompt: "매일 요약", minuteOfDay: 540 });
    store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
    const warn = vi.spyOn(logger, "warn");

    expect(retirePersonalAgents({ config, store })).toBeNull();

    expect(warn).not.toHaveBeenCalled();
    expect(store.personalAgentsRetired()).toBe(true);
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(tableExists(config, "bot_tasks")).toBe(false);
    expect(store.listConversations(owner.id)).toHaveLength(1);
    expect(store.listRoutineJobs(owner.id)).toHaveLength(1);
    store.close();
  });

  it("sweeps the disk BEFORE the purge, and a failed purge fails loudly and re-runs", () => {
    const config = configFor("purge-fails");
    const seed = seedLegacyDeployment(config);
    const store = new Store(config);
    const purge = vi.spyOn(store, "purgeRetiredPersonalAgents").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    expect(() => retirePersonalAgents({ config, store })).toThrow("disk I/O error");
    // The files went first; the rows that name them are all still there, so
    // nothing is orphaned, nothing is marked, and the next boot retries.
    expect(fs.existsSync(seed.files.botImage)).toBe(false);
    expect(tableExists(config, "personal_agents")).toBe(true);
    expect(store.countConversationsForAvatar(seed.botA)).toBe(2);
    expect(store.personalAgentsRetired()).toBe(false);

    purge.mockRestore();
    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 2, conversations: 3 });
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("purges the rows even when the sweep fails, withholds the marker, and retries the leftover", () => {
    const config = configFor("sweep-fails");
    const seed = seedLegacyDeployment(config);
    const busyTree = path.join(config.dataDir, "workspaces", "personal-stray-0123456789ab");
    const realRm = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target) === busyTree) {
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
      }
      realRm(target, options);
    }) as typeof fs.rmSync);
    const warn = vi.spyOn(logger, "warn");
    const store = new Store(config);

    const purge = retirePersonalAgents({ config, store });

    // The scheduler hazard never waits on the disk: the rows are gone...
    expect(purge).toMatchObject({ bots: 2, conversations: 3, routines: 3 });
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(store.listRoutineJobs(seed.owner.id).map((job) => job.id)).toEqual([seed.ownRoutine.id]);
    // ...but the leftover stays, the marker is withheld, and ONE warning names it.
    expect(fs.existsSync(busyTree)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { failures: 1, paths: [`${busyTree} (EBUSY)`] },
      expect.stringContaining("NOT stamped"),
    );

    // The next boot finds no rows, retries the name-prefixed sweep, and stamps.
    vi.mocked(fs.rmSync).mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(busyTree)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }
    store.close();
  });

  it("removes a read-only bot tree, chmodding only real folders inside it", () => {
    const config = configFor("read-only");
    const seed = seedLegacyDeployment(config);
    const botTree = path.dirname(workspaceDirFor(config, seed.botA, "x"));
    const threadDir = workspaceDirFor(config, seed.botA, "bot-chat");
    // What `go mod download` leaves behind: read-only folders full of files —
    // here also holding a link to the owner's knowledge clone, which the
    // first removal cannot unlink (its folder is not writable). It must be
    // unlinked, never followed: neither the clone's contents nor its mode may
    // change (0o550 lacks u+w, so a chmod through the link would show).
    const moduleCache = path.join(threadDir, "go", "pkg", "mod", "example.com", "lib@v1.0.0");
    writeFile(path.join(moduleCache, "lib.go"));
    const clone = knowledgeClonePath(seed.owner.id, config);
    const link = path.join(moduleCache, "clone-link");
    fs.symlinkSync(clone, link, "dir");
    fs.chmodSync(moduleCache, 0o555);
    fs.chmodSync(path.dirname(moduleCache), 0o555);
    fs.chmodSync(clone, 0o550);
    const cloneMode = fs.statSync(clone).mode;
    // Permissions do not bite for root (Docker CI), so the first removal of
    // the tree is forced to fail with EACCES; the chmod walk and the retry run
    // for real either way.
    failRmOnce([botTree], "EACCES");
    const chmod = vi.spyOn(fs, "chmodSync");
    const store = new Store(config);

    try {
      retirePersonalAgents({ config, store });

      expect(fs.existsSync(botTree)).toBe(false);
      expect(store.personalAgentsRetired()).toBe(true);
      expect(fs.statSync(clone).mode).toBe(cloneMode);
      expect(fs.existsSync(seed.controls.botMemory)).toBe(true);
      const chmodded = chmod.mock.calls.map(([target]) => String(target));
      expect(chmodded).toContain(botTree);
      expect(chmodded).toContain(moduleCache);
      expect(chmodded.every((target) => target === botTree || target.startsWith(`${botTree}${path.sep}`))).toBe(true);
      expect(chmodded).not.toContain(link);
    } finally {
      // Leave nothing the temp-dir cleanup could trip over if an assertion failed.
      for (const dir of [moduleCache, path.dirname(moduleCache), clone]) {
        if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755);
      }
      store.close();
    }
  });

  it("unlinks a bot-prefixed workspace link without following it", () => {
    const config = configFor("symlink");
    const seed = seedLegacyDeployment(config);
    const ownTree = path.dirname(workspaceDirFor(config, seed.owner.id, "x"));
    const link = path.join(config.dataDir, "workspaces", "personal-link-0123456789ab");
    fs.symlinkSync(ownTree, link, "dir");
    const store = new Store(config);

    retirePersonalAgents({ config, store });

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(seed.controls.ownWorkspace)).toBe(true);
    store.close();
  });

  it("keeps a failed ROW-KEYED path pending past the purge, retries it next boot, and only then stamps", () => {
    const config = configFor("row-keyed-fails");
    const seed = seedLegacyDeployment(config);
    const botImages = chatImagesDir(config, "bot-chat");
    const botEnv = path.join(config.agentSessionsDir, "session-env", BOT_SESSION);
    const rm = failRmOnce([botImages, botEnv], "EBUSY");
    const store = new Store(config);

    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 2, conversations: 3 });

    // The rows that named both folders are gone, but the folders are not — so
    // they are pending, stored with the purge, and the marker is withheld.
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(fs.existsSync(botImages)).toBe(true);
    expect(fs.existsSync(botEnv)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(pendingDocument(store)).toEqual({
      v: 1,
      paths: ["chat-images/bot-chat", `agent-sessions/session-env/${BOT_SESSION}`],
      sessionIds: [],
    });

    // Boot 2 finds no rows, retries exactly the pending paths, and stamps.
    rm.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(botImages)).toBe(false);
    expect(fs.existsSync(botEnv)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }
    store.close();
  });

  it("re-runs the session pass for ids whose project folder could not be listed", () => {
    const config = configFor("project-listing-fails");
    const seed = seedLegacyDeployment(config);
    const sharedProject = path.dirname(seed.files.sharedProjectBotTranscript);
    const readdir = failReaddir(sharedProject, "EACCES");
    const store = new Store(config);

    retirePersonalAgents({ config, store });

    // That folder may hold a bot session from a work-repo thread, and once the
    // rows are purged only the stored ids can find it again.
    expect(fs.existsSync(seed.files.sharedProjectBotTranscript)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(pendingDocument(store)?.sessionIds.sort()).toEqual([BOT_SESSION, BOT_FORK_SESSION].sort());

    readdir.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(seed.files.sharedProjectBotTranscript)).toBe(false);
    expect(fs.existsSync(seed.files.sharedProjectBotSubagent)).toBe(false);
    expect(fs.existsSync(seed.controls.sharedProjectOwnTranscript)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("withholds the marker when a folder cannot be listed, and finishes next boot", () => {
    const config = configFor("listing-fails");
    const seed = seedLegacyDeployment(config);
    const avatars = path.join(config.dataDir, "avatars");
    const readdir = failReaddir(avatars, "EACCES");
    const warn = vi.spyOn(logger, "warn");
    const store = new Store(config);

    retirePersonalAgents({ config, store });

    expect(fs.existsSync(seed.files.botImage)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { failures: 1, paths: [`${avatars} (EACCES)`] },
      expect.stringContaining("NOT stamped"),
    );

    readdir.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(seed.files.botImage)).toBe(false);
    expect(fs.existsSync(seed.files.unrecordedBotImage)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("validates every stored pending entry by its exact shape before removing anything", () => {
    const config = configFor("pending-shapes");
    const store = new Store(config);
    const kept = {
      otherChatImages: writeFile(path.join(config.dataDir, "chat-images", "other-conv", "a.png")),
      knowledge: writeFile(path.join(config.dataDir, "knowledge", "owner", "f")),
      outside: writeFile(path.join(tempDir(), "outside", "f")),
      notASession: writeFile(path.join(config.agentSessionsDir, "tasks", "not-a-uuid", "1.json")),
    };
    const removed = {
      chatImages: writeFile(path.join(config.dataDir, "chat-images", "gone-conv", "a.png")),
      transcript: writeFile(path.join(config.agentSessionsDir, "projects", "p", `${BOT_SESSION}.jsonl`)),
      // Reached through the stored session id, not a path.
      tasks: writeFile(path.join(config.agentSessionsDir, "tasks", BOT_FORK_SESSION, "1.json")),
    };
    store.saveRetiredPersonalAgentPending(
      JSON.stringify({
        v: 1,
        paths: [
          "chat-images",
          "chat-images/gone-conv",
          "chat-images/a/b",
          "agent-sessions/projects/p",
          path.join(tempDir(), "outside"),
          "../outside",
          "chat-images/../knowledge",
          "knowledge/owner",
          "",
          ".",
          `agent-sessions/projects/p/${BOT_SESSION}.jsonl`,
          "agent-sessions/tasks/not-a-uuid",
          42,
        ],
        sessionIds: ["../../x", BOT_FORK_SESSION],
      }),
    );
    const warn = vi.spyOn(logger, "warn");

    expect(retirePersonalAgents({ config, store })).toBeNull();

    for (const [name, file] of Object.entries(removed)) {
      expect(fs.existsSync(file), name).toBe(false);
    }
    for (const [name, file] of Object.entries(kept)) {
      expect(fs.existsSync(file), name).toBe(true);
    }
    expect(warn).toHaveBeenCalledWith(
      {
        dropped: [
          "chat-images",
          "chat-images/a/b",
          "agent-sessions/projects/p",
          path.join(tempDir(), "outside"),
          "../outside",
          "chat-images/../knowledge",
          "knowledge/owner",
          "",
          ".",
          "agent-sessions/tasks/not-a-uuid",
          "42",
          "../../x",
        ],
      },
      expect.stringContaining("malformed"),
    );
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });
    store.close();
  });

  it("refuses a pending path whose folder is a link, and keeps it pending", () => {
    const config = configFor("pending-link");
    const store = new Store(config);
    const elsewhere = path.join(tempDir(), "elsewhere");
    const outsideFile = writeFile(path.join(elsewhere, `${BOT_SESSION}.jsonl`));
    fs.mkdirSync(path.join(config.agentSessionsDir, "projects"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(config.agentSessionsDir, "projects", "linked"), "dir");
    const entry = `agent-sessions/projects/linked/${BOT_SESSION}.jsonl`;
    store.saveRetiredPersonalAgentPending(JSON.stringify({ v: 1, paths: [entry], sessionIds: [] }));

    expect(retirePersonalAgents({ config, store })).toBeNull();

    expect(fs.existsSync(outsideFile)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(pendingDocument(store)).toEqual({ v: 1, paths: [entry], sessionIds: [] });
    store.close();
  });

  it("discards an unreadable pending list with a warning instead of trusting it", () => {
    const config = configFor("pending-unreadable");
    // Written under another SESSION_SECRET: this deployment can no longer decrypt it.
    const before = new Store({ ...config, sessionSecret: "rotated-away" });
    before.saveRetiredPersonalAgentPending(
      JSON.stringify({ v: 1, paths: ["chat-images/x"], sessionIds: [] }),
    );
    before.close();
    const store = new Store(config);
    const warn = vi.spyOn(logger, "warn");

    expect(retirePersonalAgents({ config, store })).toBeNull();

    expect(warn).toHaveBeenCalledWith({ status: "unreadable" }, expect.stringContaining("may remain"));
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });

    // A garbled document (it decrypts, but is not ours) is treated the same
    // way — and a stored pending row alone keeps a marked boot from skipping.
    store.saveRetiredPersonalAgentPending("not json");
    warn.mockClear();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(warn).toHaveBeenCalledWith({ status: "ok" }, expect.stringContaining("may remain"));
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("re-runs the full retirement when an older release re-created the tables after the stamp", () => {
    const config = configFor("rollback");
    const rollback = seedRollback(config);
    const warn = vi.spyOn(logger, "warn");
    // Rolling forward again: the marker alone would short-circuit and the
    // scheduler would fire that routine as the owner's main avatar.
    const store = new Store(config);

    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 1, conversations: 2, routines: 1 });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recreated"));
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(tableExists(config, "bot_tasks")).toBe(false);
    expect(store.countConversationsForAvatar(rollback.botC)).toBe(0);
    expect(store.listRoutineJobs(rollback.seed.owner.id).map((job) => job.id)).toEqual([rollback.seed.ownRoutine.id]);
    expect(fs.existsSync(rollback.botImage)).toBe(false);
    expect(fs.existsSync(rollback.chatImages)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("drops the marker in a re-retirement's purge, so its failed sweep is retried next boot", () => {
    const config = configFor("rollback-sweep-fails");
    const rollback = seedRollback(config);
    const rm = failRmOnce([rollback.chatImages], "EBUSY");
    const store = new Store(config);

    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 1, conversations: 2 });

    // The purge dropped the marker together with the rows and stored the
    // pending path, so nothing can short-circuit the retry.
    expect(tableExists(config, "personal_agents")).toBe(false);
    expect(store.personalAgentsRetired()).toBe(false);
    expect(pendingDocument(store)).toEqual({ v: 1, paths: ["chat-images/rollback-chat"], sessionIds: [] });
    expect(fs.existsSync(rollback.chatImage)).toBe(true);

    rm.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(rollback.chatImages)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });
    store.close();
  });

  it("rolls a re-retirement back whole when dropping the marker fails, and the next boot finishes it", () => {
    const config = configFor("rollback-purge-fails");
    const rollback = seedRollback(config);
    const rm = failRmOnce([rollback.chatImages], "EBUSY");
    const store = new Store(config);
    const realDelete = store.deleteAppSecret.bind(store);
    const deleteSecret = vi.spyOn(store, "deleteAppSecret").mockImplementation((key: string) => {
      if (key === "retired:personal_agents") {
        throw new Error("database is locked");
      }
      realDelete(key);
    });

    expect(() => retirePersonalAgents({ config, store })).toThrow("database is locked");

    // One transaction: the rows, the tables, the marker and the (unwritten)
    // pending list are exactly as before — and the tables re-trigger it.
    expect(tableExists(config, "personal_agents")).toBe(true);
    expect(store.countConversationsForAvatar(rollback.botC)).toBe(2);
    expect(store.personalAgentsRetired()).toBe(true);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });

    deleteSecret.mockRestore();
    rm.mockRestore();
    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 1, conversations: 2 });
    expect(fs.existsSync(rollback.chatImages)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("does not skip a marked boot while pending retries are stored", () => {
    const config = configFor("marked-with-pending");
    const store = new Store(config);
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(store.personalAgentsRetired()).toBe(true);
    const leftover = writeFile(path.join(chatImagesDir(config, "leftover"), "a.png"));
    store.saveRetiredPersonalAgentPending(JSON.stringify({ v: 1, paths: ["chat-images/leftover"], sessionIds: [] }));

    expect(retirePersonalAgents({ config, store })).toBeNull();

    expect(fs.existsSync(leftover)).toBe(false);
    expect(store.retiredPersonalAgentPendingState()).toEqual({ status: "missing" });
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("keeps the boot up when the completion write throws, and completes next boot", () => {
    const config = configFor("complete-fails");
    seedLegacyDeployment(config);
    const store = new Store(config);
    const complete = vi.spyOn(store, "completePersonalAgentRetirement").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const warn = vi.spyOn(logger, "warn");

    expect(retirePersonalAgents({ config, store })).toMatchObject({ bots: 2 });

    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.stringContaining("could not be stamped"));
    expect(store.personalAgentsRetired()).toBe(false);
    complete.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("keeps the boot up when a standalone pending write throws, and the previous list is retried", () => {
    const config = configFor("pending-write-fails");
    seedLegacyDeployment(config);
    const botImages = chatImagesDir(config, "bot-chat");
    let rm = failRmOnce([botImages], "EBUSY");
    const store = new Store(config);
    retirePersonalAgents({ config, store });
    expect(pendingDocument(store)?.paths).toEqual(["chat-images/bot-chat"]);
    rm.mockRestore();
    // Boot 2 has no rows left: the retry fails again, and storing its list throws.
    rm = failRmOnce([botImages], "EBUSY");
    const save = vi.spyOn(store, "saveRetiredPersonalAgentPending").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
    const warn = vi.spyOn(logger, "warn");

    expect(retirePersonalAgents({ config, store })).toBeNull();

    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, expect.stringContaining("retries the previous list"));
    expect(pendingDocument(store)?.paths).toEqual(["chat-images/bot-chat"]);
    rm.mockRestore();
    save.mockRestore();
    expect(retirePersonalAgents({ config, store })).toBeNull();
    expect(fs.existsSync(botImages)).toBe(false);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });

  it("finds bot project folders named after the PHYSICAL workspaces path", () => {
    const config = configFor("realpath");
    const realWorkspaces = path.join(config.dataDir, "real-workspaces");
    fs.mkdirSync(realWorkspaces, { recursive: true });
    fs.symlinkSync(realWorkspaces, path.join(config.dataDir, "workspaces"), "dir");
    const seed = seedLegacyDeployment(config);
    // The CLI encodes its cwd as the kernel reports it: links resolved.
    const physicalCwd = path.join(
      fs.realpathSync(realWorkspaces),
      path.relative(path.join(config.dataDir, "workspaces"), workspaceDirFor(config, seed.botA, "bot-chat")),
    );
    const physicalProject = path.join(config.agentSessionsDir, "projects", projectDirName(physicalCwd));
    const transcript = writeFile(path.join(physicalProject, "never-recorded.jsonl"));
    const store = new Store(config);

    retirePersonalAgents({ config, store });

    expect(fs.existsSync(transcript)).toBe(false);
    expect(fs.existsSync(physicalProject)).toBe(false);
    expect(fs.lstatSync(path.join(config.dataDir, "workspaces")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(seed.files.botWorkspace)).toBe(false);
    expect(fs.existsSync(seed.controls.ownWorkspace)).toBe(true);
    expect(store.personalAgentsRetired()).toBe(true);
    store.close();
  });
});
