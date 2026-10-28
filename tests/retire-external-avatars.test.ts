// Boot-time retirement of the removed external avatars (user decision D4:
// their history is deleted). A deployment that ran them still holds
// `external:<id>` conversations with messages, canvases, share links,
// notifications, task-API rows and chat media, the encrypted admin registry
// (`app_config` key `external_agents_registry_v1`), the `external_avatar_images`
// table and the image files. The retirement deletes all of it — disk first,
// then one DB transaction that also drops the table — while everything that is
// not an external avatar's survives. It runs on every boot until one clean
// pass stamps the `retired:external_avatars` marker.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatFilesDir } from "../src/server/chatFiles.js";
import { chatImagesDir, safeConversationDir } from "../src/server/chatImages.js";
import { loadConfig } from "../src/server/config.js";
import logger from "../src/server/logger.js";
import { retireExternalAvatars } from "../src/server/retireExternalAvatars.js";
import { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("retire-external-avatars");

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
const LEGACY_IMAGE_TABLE = `
  CREATE TABLE IF NOT EXISTS external_avatar_images (
    external_avatar_id TEXT PRIMARY KEY,
    ext TEXT NOT NULL
  );
`;
const REGISTRY_KEY = "external_agents_registry_v1";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const T0 = "2026-09-01T00:00:00.000Z";
/** No env: the EXTERNAL_AGENTS_JSON warning stays out of the assertions. */
const NO_ENV = {};

function writeFile(file: string, body = "x"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
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

/** The stored pending-retry document, parsed (null when there is none). */
function pendingDocument(store: Store): { v: number; dirs: string[] } | null {
  const state = store.retiredExternalAvatarPendingState();
  return state.status === "ok" ? JSON.parse(state.value) : null;
}

/**
 * Build a deployment as the last release left it: two users chatting with an
 * external avatar (one thread with a canvas, a share link, a notification, a
 * task-API row and chat media), a row keyed by the external id itself, the
 * registry, the image table and image files — and, as CONTROLS, the owner's own
 * thread, a group-agent thread, their media and images.
 */
function seedLegacyDeployment(config: AppConfig) {
  const store = new Store(config);
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
  const group = store.createGroup({ name: "Team" });
  store.addGroupMember(group.id, owner.id, "member");
  const groupAgent = store.createGroupAgent(group.id, { displayName: "팀 비서" })!;
  const groupAvatar = `group:${group.id}:${groupAgent.id}`;
  const external = "external:research";

  // Controls.
  store.touchConversation(owner.id, "own-chat", owner.id, "안녕");
  store.addMessage("own-chat", { role: "user", content: "안녕" });
  store.upsertCanvasArtifact(owner.id, "own-chat", {
    artifactId: "own-canvas",
    title: "내 캔버스",
    content: "<p>own</p>",
    contentType: "text/html",
  });
  expect(store.createShareLink(shareLink(owner.id, "own-chat", "own-link")).status).toBe("created");
  store.addAvatarNotification(owner.id, { avatarUserId: owner.id, message: "own", conversationId: "own-chat" });
  store.touchConversation(owner.id, "group-chat", groupAvatar, "팀");
  store.addMessage("group-chat", { role: "user", content: "팀" });
  const ownRoutine = store.createRoutineJob(owner.id, { prompt: "매일 요약", minuteOfDay: 540 });

  // External data the store API can still write (it never validates the id).
  store.touchConversation(owner.id, "ext-chat", external, "조사해줘");
  store.addMessage("ext-chat", { role: "user", content: "조사해줘" });
  store.addMessage("ext-chat", { role: "assistant", content: "외부 답변" });
  store.upsertCanvasArtifact(owner.id, "ext-chat", {
    artifactId: "ext-canvas",
    title: "외부 캔버스",
    content: "<p>ext</p>",
    contentType: "text/html",
  });
  expect(store.createShareLink(shareLink(owner.id, "ext-chat", "ext-link")).status).toBe("created");
  store.addAvatarNotification(owner.id, { avatarUserId: owner.id, message: "ext", conversationId: "ext-chat" });
  store.addAvatarNotification(owner.id, { avatarUserId: external, message: "ext-keyed" });
  store.touchConversation(other.id, "ext-other", "external:gone", "다른 사용자");
  store.addMessage("ext-other", { role: "user", content: "다른 사용자" });
  store.setAppSecret(REGISTRY_KEY, JSON.stringify({ v: 1, agents: [{ id: "research", apiKey: "gw-secret" }] }));
  store.close();

  const raw = new Database(config.dbPath);
  raw.exec(LEGACY_IMAGE_TABLE);
  // A fresh DB never gets the column; the old release added it, and it stays dead.
  raw.exec("ALTER TABLE conversations ADD COLUMN external_endpoint TEXT");
  raw.prepare("INSERT INTO external_avatar_images (external_avatar_id, ext) VALUES (?, 'png')").run(external);
  raw
    .prepare(
      "INSERT INTO avatar_tasks (id, owner_user_id, api_key_id, conversation_id, message, status, fingerprint, created_at, updated_at) VALUES (?, ?, 'key', ?, 'm', 'succeeded', 'fp', ?, ?)",
    )
    .run("api-ext", owner.id, "ext-chat", T0, T0);
  raw.prepare("UPDATE conversations SET external_endpoint = ? WHERE id = 'ext-chat'").run(
    "https://gateway.example.com/v1/agents/messages",
  );
  raw.close();

  const avatars = path.join(config.dataDir, "avatars");
  const files = {
    image: writeFile(path.join(avatars, `${external}.png`)),
    unrecordedImage: writeFile(path.join(avatars, "external:gone.webp")),
    chatImage: writeFile(path.join(chatImagesDir(config, "ext-chat"), "a.png")),
    chatFile: writeFile(path.join(chatFilesDir(config, "ext-other"), "f.pdf")),
    workspace: writeFile(path.join(workspaceDirFor(config, external, "ext-chat"), "attachments", "a.png")),
  };
  const controls = {
    ownerImage: writeFile(path.join(avatars, `${owner.id}.png`)),
    groupAgentImage: writeFile(path.join(avatars, `${groupAvatar}.png`)),
    ownWorkspace: writeFile(path.join(workspaceDirFor(config, owner.id, "own-chat"), "notes.md")),
    ownChatImage: writeFile(path.join(chatImagesDir(config, "own-chat"), "a.png")),
    groupChatFile: writeFile(path.join(chatFilesDir(config, "group-chat"), "f.pdf")),
  };
  return { owner, other, external, ownRoutine, files, controls };
}

describe("retireExternalAvatars", () => {
  it("purges every external thread, row, registry, table and file, then stamps the marker", () => {
    const config = configFor("legacy");
    const seed = seedLegacyDeployment(config);
    const store = new Store(config);
    expect(store.externalAvatarsRetired()).toBe(false);

    const purge = retireExternalAvatars({ config, store, env: NO_ENV });

    expect(purge).toEqual({
      conversations: 2,
      messages: 3,
      routines: 0,
      notifications: 2,
      registry: true,
      images: 1,
    });
    expect(tableExists(config, "external_avatar_images")).toBe(false);
    expect(store.getAppSecretState(REGISTRY_KEY)).toEqual({ status: "missing" });
    expect(store.countConversationsForAvatar(seed.external)).toBe(0);
    expect(store.countConversationsForAvatar("external:gone")).toBe(0);
    for (const id of ["ext-chat", "ext-other"]) {
      expect(countRows(config, "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?", id)).toBe(0);
    }
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'ext-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'ext-chat'")).toBe(0);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM avatar_tasks WHERE id = 'api-ext'")).toBe(0);
    expect(
      countRows(config, "SELECT COUNT(*) AS c FROM avatar_notifications WHERE avatar_user_id = ?", seed.external),
    ).toBe(0);
    for (const [name, file] of Object.entries(seed.files)) {
      expect(fs.existsSync(file), name).toBe(false);
    }
    expect(fs.existsSync(path.dirname(path.dirname(seed.files.workspace)))).toBe(false);

    // Controls survive untouched.
    expect(store.listConversations(seed.owner.id).map((c) => c.id).sort()).toEqual(["group-chat", "own-chat"]);
    expect(store.listMessages(seed.owner.id, "own-chat")).toHaveLength(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM canvas_artifacts WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(countRows(config, "SELECT COUNT(*) AS c FROM share_links WHERE conversation_id = 'own-chat'")).toBe(1);
    expect(store.listRoutineJobs(seed.owner.id).map((job) => job.id)).toEqual([seed.ownRoutine.id]);
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }

    expect(store.externalAvatarsRetired()).toBe(true);
    expect(pendingDocument(store)).toBeNull();
    // Every later boot returns at once.
    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toBeNull();
    store.close();
  });

  it("stamps a fresh database silently on its first boot", () => {
    const config = configFor("fresh");
    const store = new Store(config);
    expect(tableExists(config, "external_avatar_images")).toBe(false);
    const warn = vi.spyOn(logger, "warn");

    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toBeNull();

    expect(store.externalAvatarsRetired()).toBe(true);
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

    const purge = retireExternalAvatars({ config, store, env: NO_ENV });

    // The history never waits on the disk: the rows are gone...
    expect(purge).toMatchObject({ conversations: 2, registry: true });
    expect(store.countConversationsForAvatar(seed.external)).toBe(0);
    // ...but the folder stays, only the purged rows could name it, so it is
    // stored as pending, the marker is withheld, and ONE warning names it.
    expect(fs.existsSync(busy)).toBe(true);
    expect(pendingDocument(store)).toEqual({ v: 1, dirs: [safeConversationDir("ext-chat")] });
    expect(store.externalAvatarsRetired()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      { failures: 1, paths: [`${busy} (EBUSY)`] },
      expect.stringContaining("NOT stamped"),
    );

    vi.mocked(fs.rmSync).mockRestore();
    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toBeNull();
    expect(fs.existsSync(busy)).toBe(false);
    expect(store.externalAvatarsRetired()).toBe(true);
    expect(pendingDocument(store)).toBeNull();
    for (const [name, file] of Object.entries(seed.controls)) {
      expect(fs.existsSync(file), name).toBe(true);
    }
    store.close();
  });

  it("does not skip a marked boot while pending retries are stored, and drops malformed entries", () => {
    const config = configFor("pending");
    const store = new Store(config);
    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toBeNull();
    expect(store.externalAvatarsRetired()).toBe(true);
    const leftover = writeFile(path.join(chatFilesDir(config, "ext-left"), "f.pdf"));
    const sentinel = writeFile(path.join(config.dataDir, "sentinel", "keep.txt"));
    store.saveRetiredExternalAvatarPending(
      JSON.stringify({ v: 1, dirs: [safeConversationDir("ext-left"), "../sentinel", "", 7] }),
    );
    const warn = vi.spyOn(logger, "warn");

    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toBeNull();

    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
    expect(pendingDocument(store)).toBeNull();
    expect(store.externalAvatarsRetired()).toBe(true);
    store.close();
  });

  it("refuses a media root that is a link, and keeps the folder pending", () => {
    const config = configFor("linked-root");
    const store = new Store(config);
    store.touchConversation("someone", "ext-linked", "external:x", "링크");
    const elsewhere = path.join(config.dataDir, "elsewhere");
    const victim = writeFile(path.join(elsewhere, safeConversationDir("ext-linked"), "keep.txt"));
    fs.symlinkSync(elsewhere, path.join(config.dataDir, "chat-images"));

    retireExternalAvatars({ config, store, env: NO_ENV });

    expect(fs.existsSync(victim)).toBe(true);
    expect(store.countConversationsForAvatar("external:x")).toBe(0);
    expect(pendingDocument(store)).toEqual({ v: 1, dirs: [safeConversationDir("ext-linked")] });
    expect(store.externalAvatarsRetired()).toBe(false);
    store.close();
  });

  it("re-runs the full retirement when an older release re-created the table after the stamp", () => {
    const config = configFor("rollback");
    seedLegacyDeployment(config);
    const first = new Store(config);
    retireExternalAvatars({ config, store: first, env: NO_ENV });
    expect(first.externalAvatarsRetired()).toBe(true);
    // The older release: migrate() re-creates the table, and someone chats again.
    first.touchConversation("someone", "ext-again", "external:research", "다시");
    first.addMessage("ext-again", { role: "user", content: "다시" });
    first.close();
    const raw = new Database(config.dbPath);
    raw.exec(LEGACY_IMAGE_TABLE);
    raw.close();
    const image = writeFile(path.join(config.dataDir, "avatars", "external:research.png"));

    const store = new Store(config);
    expect(retireExternalAvatars({ config, store, env: NO_ENV })).toMatchObject({ conversations: 1, messages: 1 });

    expect(tableExists(config, "external_avatar_images")).toBe(false);
    expect(store.countConversationsForAvatar("external:research")).toBe(0);
    expect(fs.existsSync(image)).toBe(false);
    expect(store.externalAvatarsRetired()).toBe(true);
    store.close();
  });

  it("warns on every boot while EXTERNAL_AGENTS_JSON is still set", () => {
    const config = configFor("env");
    const store = new Store(config);
    const warn = vi.spyOn(logger, "warn");
    const env = { EXTERNAL_AGENTS_JSON: '[{"id":"research"}]' };

    retireExternalAvatars({ config, store, env });
    retireExternalAvatars({ config, store, env });

    const ignored = warn.mock.calls.filter(([message]) =>
      String(message).includes("EXTERNAL_AGENTS_JSON is set but ignored"),
    );
    expect(ignored).toHaveLength(2);
    expect(store.externalAvatarsRetired()).toBe(true);
    store.close();
  });
});
