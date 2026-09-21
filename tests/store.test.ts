import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { createServices, expandChatSlashCommand } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { applyCustomGithubCa } from "../src/server/tlsCa.js";
import { loadDotEnv } from "../src/server/loadEnv.js";
import {
  buildKnowledgeTools,
  KNOWLEDGE_SERVER_NAME,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolsContext,
} from "../src/server/agent/knowledgeTools.js";
import { normalizeHashtags } from "../src/server/store.js";
import { CURRENT_RELEASE_ID } from "../src/server/releaseNotes.js";
import {
  buildAvatarDirectoryTools,
  AVATAR_DIRECTORY_SERVER_NAME,
  AVATAR_DIRECTORY_TOOL_NAMES,
} from "../src/server/agent/avatarDirectoryTools.js";
import {
  gitAuthArgs,
  marketplaceCloneUrl,
  normalizeGithubHost,
  pathExists,
  sanitizeName,
  scrubGitError,
  syncGitRepo,
} from "../src/server/marketplace.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  tokenForGitUrl,
} from "../src/server/gitCredentials.js";
import {
  APP_MANAGED_MCP_SERVERS,
  inspectRepoContents,
  listSkillsInRoots,
  loadAgentPluginRoots,
  loadAvatarPluginRoots,
  loadDefaultPluginRoots,
  resolvePluginRoots,
  stripManagedMcpServers,
} from "../src/server/plugins.js";
import {
  attachRunClient,
  awaitResponse,
  cancelRun,
  CANCELLED,
  closeRun,
  emitRunEvent,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
} from "../src/server/agent/runRegistry.js";
import {
  agentSubprocessEnv,
  buildImageQueryPrompt,
  buildPreToolUseHook,
  buildPrompt,
  deriveAgentToolAccess,
  interpretResult,
  resultErrorMessage,
  sshMcpSecretEnv,
} from "../src/server/agent/claudeAgent.js";
import { executeRoutineJob, startRoutineScheduler } from "../src/server/scheduler.js";
import {
  formatMinuteOfDay,
  nextRunIso,
  parseRoutineSchedule,
  parseTimeToMinute,
} from "../src/server/routineSchedule.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { decryptSecret, encryptSecret } from "../src/server/crypto.js";
import {
  commitAndPush,
  commitIdentityFor,
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  resolveInRepo,
  scaffoldSkill,
  readFile as readKnowledgeFile,
  writeFile as writeKnowledgeFile,
  writeRepoTemplate,
} from "../src/server/knowledgeRepo.js";
import {
  buildRepoTools,
  createRemoteRepo,
  REPO_CREATE_TOOL_NAME,
  REPO_SERVER_NAME,
  REPO_TOOL_NAMES,
} from "../src/server/agent/repoTools.js";
import {
  buildGroupRepoTools,
  GROUP_REPO_SERVER_NAME,
  GROUP_REPO_TOOL_NAMES,
} from "../src/server/agent/groupRepoTools.js";
import {
  buildGitRepoTools,
  GIT_REPO_SERVER_NAME,
  GIT_REPO_TOOL_NAMES,
} from "../src/server/agent/gitRepoTools.js";
import { gitRepoClonePath, gitRepoContextFromRecord } from "../src/server/gitRepos.js";
import {
  buildSystemTools,
  SYSTEM_SERVER_NAME,
  SYSTEM_TOOL_NAMES,
  type SystemToolsContext,
} from "../src/server/agent/systemTools.js";
import {
  knownHostsPath,
  parseKnownHosts,
  upsertHostLine,
  addTrustedHost,
  listTrustedHosts,
  removeTrustedHost,
} from "../src/server/sshTrust.js";
import {
  buildSshTrustTools,
  SSH_TRUST_SERVER_NAME,
  SSH_TRUST_TOOL_NAMES,
} from "../src/server/agent/sshTrustTools.js";
import {
  buildSshIdentityTools,
  SSH_IDENTITY_SERVER_NAME,
  SSH_IDENTITY_TOOL_NAMES,
} from "../src/server/agent/sshIdentityTools.js";
import {
  buildConfluenceTools,
  CONFLUENCE_SERVER_NAME,
  CONFLUENCE_TOOL_NAMES,
} from "../src/server/agent/confluenceTools.js";
import { generateSshKeyPair } from "../src/server/sshIdentity.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import { personalAgentAvatarId } from "../src/server/personalAgents.js";
import type { AgentImageInput, AppConfig, Plugin } from "../src/server/types.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../src/server/hexSshPolicy.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});


describe("store plugin persistence", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "plg"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("defaults selected to null and lastSyncedAt to null on add", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    expect(p.selected).toBeNull();
    expect(p.lastSyncedAt).toBeNull();
  });

  it("round-trips a selection and clears it with null", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    const sel = store.setPluginSelected(ownerId, p.id, ["alpha", "beta"]);
    expect(sel?.selected).toEqual(["alpha", "beta"]);
    expect(store.getPlugin(ownerId, p.id)?.selected).toEqual(["alpha", "beta"]);
    const cleared = store.setPluginSelected(ownerId, p.id, null);
    expect(cleared?.selected).toBeNull();
  });

  it("updates the tracked ref and stamps sync time", () => {
    const { store, ownerId } = makeStore();
    const p = store.addPlugin(ownerId, { repo: "owner/repo" });
    expect(store.setPluginRef(ownerId, p.id, "v2")?.ref).toBe("v2");
    const synced = store.markPluginSynced(ownerId, p.id);
    expect(synced?.lastSyncedAt).toBeTruthy();
  });
});


describe("store user secrets", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "secrets"),
      agentRuntime: "local",
      sessionSecret: "shh",
    });
    const owner = store.createUser({ username: "secowner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("round-trips an encrypted secret value", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    expect(store.getUserSecrets(ownerId)).toEqual({
      SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n",
    });
  });

  it("upserts (overwrites) an existing name and lists names sorted", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    store.setUserSecret(ownerId, "ALLOWED_HOSTS", "host1");
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v2");
    expect(store.listUserSecretNames(ownerId)).toEqual(["ALLOWED_HOSTS", "SSH_PRIVATE_KEY"]);
    expect(store.getUserSecrets(ownerId).SSH_PRIVATE_KEY).toBe("v2");
  });

  it("deletes a secret", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    store.deleteUserSecret(ownerId, "SSH_PRIVATE_KEY");
    expect(store.listUserSecretNames(ownerId)).toEqual([]);
    expect(store.getUserSecrets(ownerId)).toEqual({});
  });

  it("exposes only names via toUser (getUserById), never values", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "topsecret");
    const user = store.getUserById(ownerId)!;
    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toBeNull();
    expect(JSON.stringify(user)).not.toContain("topsecret");
  });

  it("stores generated SSH public key while keeping private key secret", () => {
    const { store, ownerId } = makeStore();
    const user = store.setSshKeyPair(
      ownerId,
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----\n",
      "ssh-ed25519 AAAATEST avatar-chat-owner",
    );

    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toBe("ssh-ed25519 AAAATEST avatar-chat-owner");
    expect(store.getUserSecrets(ownerId).SSH_PRIVATE_KEY).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(JSON.stringify(user)).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("clears generated SSH public key when SSH_PRIVATE_KEY is changed or deleted manually", () => {
    const { store, ownerId } = makeStore();
    store.setSshKeyPair(ownerId, "private-key", "ssh-ed25519 AAAATEST avatar-chat-owner");
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "manual-private-key");
    expect(store.getUserById(ownerId)!.sshPublicKey).toBeNull();

    store.setSshKeyPair(ownerId, "private-key", "ssh-ed25519 AAAATEST avatar-chat-owner");
    store.deleteUserSecret(ownerId, "SSH_PRIVATE_KEY");
    expect(store.getUserById(ownerId)!.sshPublicKey).toBeNull();
    expect(store.getUserSecrets(ownerId)).toEqual({});
  });

  it("scopes secrets per user", () => {
    const { store, ownerId } = makeStore();
    const other = store.createUser({ username: "secother", displayName: "Other", password: "password123" });
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "mine");
    expect(store.getUserSecrets(other.id)).toEqual({});
  });

  it("skips entries that fail to decrypt (e.g. SESSION_SECRET changed)", () => {
    const { store, ownerId } = makeStore();
    store.setUserSecret(ownerId, "SSH_PRIVATE_KEY", "v1");
    // Re-open the same DB with a different secret: the stored value can't decrypt.
    const { store: store2 } = createServices({
      dataDir: path.join(tempDir, "secrets"),
      agentRuntime: "local",
      sessionSecret: "different",
    });
    expect(store2.getUserSecrets(ownerId)).toEqual({});
    // The name is still listed (only decryption fails, the row exists).
    expect(store2.listUserSecretNames(ownerId)).toEqual(["SSH_PRIVATE_KEY"]);
  });
});


describe("store app config (app-wide secrets)", () => {
  function makeStore(secret = "appshh") {
    const { store } = createServices({
      dataDir: path.join(tempDir, "appconfig"),
      agentRuntime: "local",
      sessionSecret: secret,
    });
    return store;
  }

  it("round-trips and upserts an encrypted app-wide value", () => {
    const store = makeStore();
    expect(store.getAppSecret("claude_oauth_token")).toBeNull();
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    expect(store.getAppSecret("claude_oauth_token")).toBe("sk-ant-oat01-abc");
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-def");
    expect(store.getAppSecret("claude_oauth_token")).toBe("sk-ant-oat01-def");
  });

  it("deletes an app-wide value", () => {
    const store = makeStore();
    store.setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    store.deleteAppSecret("claude_oauth_token");
    expect(store.getAppSecret("claude_oauth_token")).toBeNull();
  });

  it("returns null when the value can't decrypt (e.g. SESSION_SECRET changed)", () => {
    makeStore("secretA").setAppSecret("claude_oauth_token", "sk-ant-oat01-abc");
    // Re-open the same DB with a different secret: the stored value can't decrypt.
    expect(makeStore("secretB").getAppSecret("claude_oauth_token")).toBeNull();
  });

  it("stores the hex-ssh tool policy as app config", () => {
    const store = makeStore();
    expect(store.getHexSshToolPolicy()).toEqual(DEFAULT_HEX_SSH_TOOL_POLICY);
    const policy: HexSshToolPolicy = {
      owner: ["ssh-read-lines", "remote-ssh"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    };
    expect(store.setHexSshToolPolicy(policy)).toEqual(policy);
    expect(store.getHexSshToolPolicy()).toEqual(policy);
  });

  it("stores the builtin tool/skill policy and discovery cache as app config", () => {
    const store = makeStore();
    expect(store.getToolSkillPolicy()).toEqual({ disabledTools: [], disabledSkills: [] });
    // The lenient normalizer drops unknown tool names and malformed skill names.
    const saved = store.setToolSkillPolicy({
      disabledTools: ["WebFetch", "WebSearch", "Bash"],
      disabledSkills: ["code-review", "bad name!"],
    });
    expect(saved).toEqual({
      disabledTools: ["WebFetch", "WebSearch"],
      disabledSkills: ["code-review"],
    });
    expect(store.getToolSkillPolicy()).toEqual(saved);

    expect(store.getSkillDiscoveryCache()).toBeNull();
    const cache = {
      cliVersion: "9.9.9",
      fetchedAt: "2026-07-14T00:00:00.000Z",
      skills: [{ name: "code-review", description: "review" }],
    };
    store.setSkillDiscoveryCache(cache);
    expect(store.getSkillDiscoveryCache()).toEqual(cache);
  });
});


describe("store agent session resume", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "sess"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "sowner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("returns null before any session is recorded", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-1", ownerId, "hi");
    expect(store.getAgentSessionId(ownerId, "conv-1")).toBeNull();
  });

  it("round-trips the session id and overwrites on the next turn", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-2", ownerId, "hi");
    store.setAgentSessionId(ownerId, "conv-2", "sess-aaa");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-aaa");
    store.setAgentSessionId(ownerId, "conv-2", "sess-bbb");
    expect(store.getAgentSessionId(ownerId, "conv-2")).toBe("sess-bbb");
  });

  it("does not leak a session id across owners", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-3", ownerId, "hi");
    store.setAgentSessionId(ownerId, "conv-3", "sess-ccc");
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    expect(store.getAgentSessionId(other.id, "conv-3")).toBeNull();
    // A different owner can't overwrite it either — the UPDATE is owner-scoped.
    store.setAgentSessionId(other.id, "conv-3", "sess-evil");
    expect(store.getAgentSessionId(ownerId, "conv-3")).toBe("sess-ccc");
  });

  it("round-trips the conversation working repo and clears it", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-wr", ownerId, "hi");
    // Default is no working repo (scratch workspace).
    expect(store.getConversationWorkingRepo("conv-wr")).toBeNull();
    store.setConversationWorkingRepo("conv-wr", "app");
    expect(store.getConversationWorkingRepo("conv-wr")).toBe("app");
    // Persists across opens (last write wins) and clears back to scratch.
    store.setConversationWorkingRepo("conv-wr", "other");
    expect(store.getConversationWorkingRepo("conv-wr")).toBe("other");
    store.setConversationWorkingRepo("conv-wr", null);
    expect(store.getConversationWorkingRepo("conv-wr")).toBeNull();
  });

  it("clears the working repo when the conversation is deleted", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-wr2", ownerId, "hi");
    store.setConversationWorkingRepo("conv-wr2", "app");
    store.deleteConversation(ownerId, "conv-wr2");
    expect(store.getConversationWorkingRepo("conv-wr2")).toBeNull();
  });

  it("returns a conversation avatar only to its owner", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "avatar", displayName: "Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-4", avatar.id, "hi");
    const other = store.createUser({ username: "viewer", displayName: "Viewer", password: "password123" });

    expect(store.getConversationAvatarId(ownerId, "conv-4")).toBe(avatar.id);
    expect(store.getConversationAvatarId(other.id, "conv-4")).toBeNull();
  });

  it("tracks the per-conversation group-knowledge OFF set (default all-on), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-gk", ownerId, "hi");
    // Default: nothing disabled → every group on.
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual([]);
    // Replace the OFF set (dedupes, drops falsy); empty clears it.
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g1", "g2", "g1", ""]);
    expect(new Set(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk"))).toEqual(new Set(["g1", "g2"]));
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g2"]);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual(["g2"]);
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", []);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual([]);
    // Another owner can't read or mutate this conversation's setting.
    store.setConversationGroupKnowledgeOff(ownerId, "conv-gk", ["g2"]);
    const other = store.createUser({ username: "gkother", displayName: "Other", password: "password123" });
    expect(store.getConversationGroupKnowledgeOff(other.id, "conv-gk")).toEqual([]);
    store.setConversationGroupKnowledgeOff(other.id, "conv-gk", ["g3"]);
    expect(store.getConversationGroupKnowledgeOff(ownerId, "conv-gk")).toEqual(["g2"]);
  });

  it("round-trips the per-conversation model tier (null default), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-model", ownerId, "hi");
    // Default: no tier chosen → null (server default resolution).
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    store.setConversationModel(ownerId, "conv-model", "opus");
    expect(store.getConversationModel(ownerId, "conv-model")).toBe("opus");
    // Empty / null clears back to the default.
    store.setConversationModel(ownerId, "conv-model", "");
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    store.setConversationModel(ownerId, "conv-model", "sonnet");
    store.setConversationModel(ownerId, "conv-model", null);
    expect(store.getConversationModel(ownerId, "conv-model")).toBeNull();
    // Another owner can't read or mutate this conversation's tier.
    store.setConversationModel(ownerId, "conv-model", "haiku");
    const other = store.createUser({ username: "modelother", displayName: "Other", password: "password123" });
    expect(store.getConversationModel(other.id, "conv-model")).toBeNull();
    store.setConversationModel(other.id, "conv-model", "opus");
    expect(store.getConversationModel(ownerId, "conv-model")).toBe("haiku");
  });

  it("round-trips the per-conversation effort level (null default), owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-effort", ownerId, "hi");
    // Default: no effort chosen → null (SDK default resolution).
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    store.setConversationEffort(ownerId, "conv-effort", "max");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBe("max");
    // Empty / null clears back to the default.
    store.setConversationEffort(ownerId, "conv-effort", "");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    store.setConversationEffort(ownerId, "conv-effort", "low");
    store.setConversationEffort(ownerId, "conv-effort", null);
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBeNull();
    // Another owner can't read or mutate this conversation's effort.
    store.setConversationEffort(ownerId, "conv-effort", "xhigh");
    const other = store.createUser({ username: "effortother", displayName: "Other", password: "password123" });
    expect(store.getConversationEffort(other.id, "conv-effort")).toBeNull();
    store.setConversationEffort(other.id, "conv-effort", "high");
    expect(store.getConversationEffort(ownerId, "conv-effort")).toBe("xhigh");
  });

  it("attaches an activity snapshot to a stored message, owner-scoped, clearing when empty", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-act", ownerId, "hi");
    const msg = store.addMessage("conv-act", { role: "assistant", content: "done", response: { kind: "text", runtime: "claude", summary: "", text: "done" } });
    const activity = {
      agents: [{ id: "main", parentId: "", label: "", status: "done" as const, isMain: true }],
      tools: [{ id: "t1", agentId: "main", kind: "tool" as const, label: "파일 읽기", detail: "a.ts", status: "done" as const }],
    };
    expect(store.setMessageActivity(ownerId, msg.id, activity)).toBe(true);
    expect(store.listMessages(ownerId, "conv-act")[0].response?.activity).toEqual(activity);
    // Empty tools clears it back off the response.
    expect(store.setMessageActivity(ownerId, msg.id, { agents: [], tools: [] })).toBe(true);
    expect(store.listMessages(ownerId, "conv-act")[0].response?.activity).toBeUndefined();
    // A different owner can't attach to someone else's message.
    const other = store.createUser({ username: "actother", displayName: "Other", password: "password123" });
    expect(store.setMessageActivity(other.id, msg.id, activity)).toBe(false);
    // A message with no stored response can't carry activity.
    const bare = store.addMessage("conv-act", { role: "user", content: "hi" });
    expect(store.setMessageActivity(ownerId, bare.id, activity)).toBe(false);
  });

  it("round-trips a mid-turn user row's kind and leaves ordinary rows shapeless", () => {
    const { store, ownerId } = makeStore();
    store.touchConversation(ownerId, "conv-steer", ownerId, "hi");
    const ordinary = store.addMessage("conv-steer", { role: "user", content: "처음 요청" });
    const steer = store.addMessage("conv-steer", {
      role: "user",
      content: "응답 중에 보낸 메시지",
      kind: "steer",
    });
    expect(steer.kind).toBe("steer");
    // An ordinary row keeps the exact shape it had before the column existed:
    // the key is ABSENT, not undefined, so equality checks elsewhere are safe.
    expect("kind" in ordinary).toBe(false);

    const [first, second] = store.listMessages(ownerId, "conv-steer");
    expect("kind" in first).toBe(false);
    expect(second.kind).toBe("steer");
    expect(second.content).toBe("응답 중에 보낸 메시지");
    // Insertion order is the transcript order: the steer sits where it landed.
    expect(first.id).toBe(ordinary.id);
    expect(second.id).toBe(steer.id);
  });

  it("persists task-only activity snapshots and deletes only regular chats in bulk", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "taskavatar", displayName: "Task Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-task-only", avatar.id, "hi");
    const msg = store.addMessage("conv-task-only", {
      role: "assistant",
      content: "done",
      response: { kind: "text", runtime: "claude", summary: "", text: "done" },
    });
    const activity = {
      agents: [{ id: "main", parentId: "", label: "", status: "done" as const, isMain: true }],
      tools: [],
      tasks: [{ id: "task-1", agentId: "main", label: "리서치", detail: "자료 확인", status: "done" as const }],
    };
    expect(store.setMessageActivity(ownerId, msg.id, activity)).toBe(true);
    expect(store.listMessages(ownerId, "conv-task-only")[0].response?.activity).toEqual(activity);

    store.touchConversation(ownerId, "conv-routine", avatar.id, "routine", { isRoutine: true });
    const other = store.createUser({ username: "bulkother", displayName: "Other", password: "password123" });
    store.touchConversation(other.id, "conv-other", other.id, "other");

    expect(new Set(store.deleteChatConversations(ownerId))).toEqual(new Set(["conv-task-only"]));
    expect(store.listConversations(ownerId)).toHaveLength(0);
    expect(store.listConversations(ownerId, undefined, "routine").map((c) => c.id)).toEqual(["conv-routine"]);
    expect(store.listConversations(other.id).map((c) => c.id)).toEqual(["conv-other"]);
  });

  it("round-trips the per-user default group-knowledge OFF set (seeds new conversations)", () => {
    const { store, ownerId } = makeStore();
    // Default on a fresh user: every group on.
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual([]);
    // Saving the default surfaces on the User; [] clears it back to "all on".
    expect(store.setGroupKnowledgeOffDefault(ownerId, ["g1", "g2"]).groupKnowledgeOffDefault).toEqual(["g1", "g2"]);
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual(["g1", "g2"]);
    expect(store.setGroupKnowledgeOffDefault(ownerId, []).groupKnowledgeOffDefault).toEqual([]);
    expect(store.getUserById(ownerId)?.groupKnowledgeOffDefault).toEqual([]);
  });

  it("seeds signups with the current release and re-stamps it via markReleaseSeen", () => {
    const { store, ownerId } = makeStore();
    // New accounts are caught up from day one (no what's-new for signups).
    expect(store.getUserById(ownerId)?.lastSeenRelease).toBe(CURRENT_RELEASE_ID);
    // Simulate a pre-feature account: the additive migration leaves NULL, which
    // is what makes existing deployments show the notice exactly once.
    (store as unknown as { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } }).db
      .prepare("UPDATE users SET last_seen_release = NULL WHERE id = ?")
      .run(ownerId);
    expect(store.getUserById(ownerId)?.lastSeenRelease).toBeNull();
    // Dismissing the what's-new dialog stamps the server-current id.
    expect(store.markReleaseSeen(ownerId).lastSeenRelease).toBe(CURRENT_RELEASE_ID);
  });
});

describe("agent image prompt", () => {
  it("builds a single SDK user message with text and image content blocks", async () => {
    const image: AgentImageInput = { mediaType: "image/png", data: "iVBORw0KGgo=" };
    const messages: Record<string, any>[] = [];
    for await (const message of buildImageQueryPrompt("이 이미지 봐줘", [image])) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe("user");
    expect(messages[0].parent_tool_use_id).toBeNull();
    expect(messages[0].shouldQuery).toBe(true);
    expect(messages[0].uuid).toEqual(expect.any(String));
    expect(messages[0].message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "이 이미지 봐줘" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    });
  });
});


describe("routineSchedule", () => {
  // Fixed UTC+9 KST math, no DST.
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  // The KST wall-clock minute-of-day of a UTC instant.
  function kstMinuteOfDay(iso: string): number {
    const kstMs = new Date(iso).getTime() + KST_OFFSET_MS;
    return Math.floor((kstMs % DAY_MS) / 60_000);
  }
  // The KST weekday (0=Sun..6=Sat) of a UTC instant.
  function kstWeekday(iso: string): number {
    const kstMs = new Date(iso).getTime() + KST_OFFSET_MS;
    return (((Math.floor(kstMs / DAY_MS) + 4) % 7) + 7) % 7;
  }

  it("formatMinuteOfDay renders zero-padded HH:MM", () => {
    expect(formatMinuteOfDay(0)).toBe("00:00");
    expect(formatMinuteOfDay(9 * 60 + 5)).toBe("09:05");
    expect(formatMinuteOfDay(1439)).toBe("23:59");
  });

  it("parseTimeToMinute parses valid times and rejects junk", () => {
    expect(parseTimeToMinute("00:00")).toBe(0);
    expect(parseTimeToMinute("09:30")).toBe(9 * 60 + 30);
    expect(parseTimeToMinute("23:59")).toBe(1439);
    expect(parseTimeToMinute("  09:30  ")).toBe(9 * 60 + 30);
    expect(parseTimeToMinute("24:00")).toBeNull();
    expect(parseTimeToMinute("09:60")).toBeNull();
    expect(parseTimeToMinute("9:5")).toBeNull();
    expect(parseTimeToMinute("nope")).toBeNull();
    expect(parseTimeToMinute(930)).toBeNull();
    expect(parseTimeToMinute(undefined)).toBeNull();
    expect(parseTimeToMinute(null)).toBeNull();
  });

  describe("parseRoutineSchedule", () => {
    it("defaults to a daily schedule when scheduleKind is absent", () => {
      const res = parseRoutineSchedule({ time: "09:30" });
      expect(res).toEqual({
        ok: true,
        value: { kind: "daily", minuteOfDay: 9 * 60 + 30, daysOfWeek: null, intervalMinutes: null, runDate: null },
      });
    });

    it("parses an explicit daily schedule", () => {
      const res = parseRoutineSchedule({ scheduleKind: "daily", time: "07:00" });
      expect(res).toEqual({
        ok: true,
        value: { kind: "daily", minuteOfDay: 7 * 60, daysOfWeek: null, intervalMinutes: null, runDate: null },
      });
    });

    it("parses a weekly schedule and normalizes days to sorted-unique", () => {
      const res = parseRoutineSchedule({
        scheduleKind: "weekly",
        time: "08:15",
        daysOfWeek: [5, 1, 1, 3],
      });
      expect(res).toEqual({
        ok: true,
        value: { kind: "weekly", minuteOfDay: 8 * 60 + 15, daysOfWeek: [1, 3, 5], intervalMinutes: null, runDate: null },
      });
    });

    it("parses an interval schedule", () => {
      const res = parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 90 });
      expect(res).toEqual({
        ok: true,
        value: { kind: "interval", minuteOfDay: 0, daysOfWeek: null, intervalMinutes: 90, runDate: null },
      });
    });

    it("parses a future one-time KST date and time", () => {
      const from = new Date("2026-07-10T00:00:00.000Z"); // 09:00 KST
      const res = parseRoutineSchedule(
        { scheduleKind: "once", date: "2026-07-11", time: "14:30" },
        from,
      );
      expect(res).toEqual({
        ok: true,
        value: {
          kind: "once",
          minuteOfDay: 14 * 60 + 30,
          daysOfWeek: null,
          intervalMinutes: null,
          runDate: "2026-07-11",
        },
      });
    });

    it("returns each ScheduleError code for the matching invalid input", () => {
      expect(parseRoutineSchedule({ scheduleKind: "monthly" })).toEqual({
        ok: false,
        error: "INVALID_KIND",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily" })).toEqual({
        ok: false,
        error: "TIME_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily", time: "" })).toEqual({
        ok: false,
        error: "TIME_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "daily", time: "25:00" })).toEqual({
        ok: false,
        error: "INVALID_TIME",
      });
      expect(parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00" })).toEqual({
        ok: false,
        error: "DAYS_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [] })).toEqual({
        ok: false,
        error: "DAYS_REQUIRED",
      });
      expect(
        parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [7] }),
      ).toEqual({ ok: false, error: "INVALID_DAYS" });
      expect(
        parseRoutineSchedule({ scheduleKind: "weekly", time: "09:00", daysOfWeek: [1.5] }),
      ).toEqual({ ok: false, error: "INVALID_DAYS" });
      expect(parseRoutineSchedule({ scheduleKind: "interval" })).toEqual({
        ok: false,
        error: "INTERVAL_REQUIRED",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 4 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 10081 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
      expect(parseRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 30.5 })).toEqual({
        ok: false,
        error: "INVALID_INTERVAL",
      });
      expect(parseRoutineSchedule({ scheduleKind: "once", time: "09:00" })).toEqual({
        ok: false,
        error: "DATE_REQUIRED",
      });
      expect(
        parseRoutineSchedule({ scheduleKind: "once", date: "2026-02-30", time: "09:00" }),
      ).toEqual({ ok: false, error: "INVALID_DATE" });
      expect(
        parseRoutineSchedule(
          { scheduleKind: "once", date: "2026-07-10", time: "08:59" },
          new Date("2026-07-10T00:00:00.000Z"),
        ),
      ).toEqual({ ok: false, error: "DATE_IN_PAST" });
    });
  });

  describe("nextRunIso", () => {
    it("daily: lands on the requested KST minute, strictly after `from`", () => {
      const from = new Date("2026-06-13T00:00:00.000Z"); // 09:00 KST
      const iso = nextRunIso(
        { kind: "daily", minuteOfDay: 9 * 60 + 30, daysOfWeek: null, intervalMinutes: null, runDate: null },
        from,
      );
      expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime());
      expect(kstMinuteOfDay(iso)).toBe(9 * 60 + 30);
    });

    it("daily: rolls to tomorrow when today's slot already passed", () => {
      const from = new Date("2026-06-13T01:00:00.000Z"); // 10:00 KST
      const iso = nextRunIso(
        { kind: "daily", minuteOfDay: 9 * 60, daysOfWeek: null, intervalMinutes: null, runDate: null },
        from,
      );
      expect(kstMinuteOfDay(iso)).toBe(9 * 60);
      // 9:00 KST already passed at 10:00 KST → next slot is the following day.
      expect(new Date(iso).getTime() - from.getTime()).toBeGreaterThan(20 * 60 * 60 * 1000);
    });

    it("weekly: returns the soonest matching weekday slot in KST, strictly after `from`", () => {
      // 2026-06-13 is a Saturday; 2026-06-13T00:00Z is 09:00 KST Saturday.
      const from = new Date("2026-06-13T00:00:00.000Z");
      expect(kstWeekday(from.toISOString())).toBe(6);
      // Schedule for Monday(1)/Wednesday(3) at 08:00 KST → next is Monday.
      const iso = nextRunIso(
        { kind: "weekly", minuteOfDay: 8 * 60, daysOfWeek: [1, 3], intervalMinutes: null, runDate: null },
        from,
      );
      expect(kstWeekday(iso)).toBe(1);
      expect(kstMinuteOfDay(iso)).toBe(8 * 60);
      expect(new Date(iso).getTime()).toBeGreaterThan(from.getTime());
    });

    it("weekly: same weekday but earlier slot today rolls a full week forward", () => {
      // Saturday 09:00 KST `from`; schedule Saturday(6) at 08:00 KST (already past today).
      const from = new Date("2026-06-13T00:00:00.000Z");
      const iso = nextRunIso(
        { kind: "weekly", minuteOfDay: 8 * 60, daysOfWeek: [6], intervalMinutes: null, runDate: null },
        from,
      );
      expect(kstWeekday(iso)).toBe(6);
      const days = (new Date(iso).getTime() - from.getTime()) / DAY_MS;
      expect(days).toBeGreaterThan(6);
      expect(days).toBeLessThan(8);
    });

    it("interval: exactly from + intervalMinutes", () => {
      const from = new Date("2026-06-13T12:00:00.000Z");
      const iso = nextRunIso(
        { kind: "interval", minuteOfDay: 0, daysOfWeek: null, intervalMinutes: 45, runDate: null },
        from,
      );
      expect(new Date(iso).getTime()).toBe(from.getTime() + 45 * 60_000);
    });

    it("once: returns the exact configured KST date and time", () => {
      const iso = nextRunIso({
        kind: "once",
        minuteOfDay: 14 * 60 + 30,
        daysOfWeek: null,
        intervalMinutes: null,
        runDate: "2026-07-11",
      });
      expect(iso).toBe("2026-07-11T05:30:00.000Z");
    });
  });
});


describe("routine jobs", () => {
  function makeStore(label: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, label),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("creates a job with a dedicated conversation and a future next run", () => {
    const { store, ownerId } = makeStore("rj1");
    const job = store.createRoutineJob(ownerId, { prompt: "  요약해줘  ", minuteOfDay: 540 });
    expect(job.prompt).toBe("요약해줘");
    expect(job.minuteOfDay).toBe(540);
    expect(job.time).toBe("09:00");
    expect(job.enabled).toBe(true);
    expect(job.conversationId).toBeTruthy();
    expect(job.lastRunAt).toBeNull();
    // next run is scheduled and lies in the future.
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(store.listRoutineJobs(ownerId)).toHaveLength(1);
  });

  it("disabling parks the schedule; re-enabling reschedules", () => {
    const { store, ownerId } = makeStore("rj2");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 60 });
    const off = store.updateRoutineJob(ownerId, job.id, { enabled: false });
    expect(off?.enabled).toBe(false);
    expect(off?.nextRunAt).toBeNull();
    const on = store.updateRoutineJob(ownerId, job.id, { enabled: true });
    expect(on?.enabled).toBe(true);
    expect(on?.nextRunAt).toBeTruthy();
  });

  it("editing prompt/time keeps the conversation and recomputes the run", () => {
    const { store, ownerId } = makeStore("rj3");
    const job = store.createRoutineJob(ownerId, { prompt: "old", minuteOfDay: 0 });
    const edited = store.updateRoutineJob(ownerId, job.id, { prompt: "new", minuteOfDay: 1439 });
    expect(edited?.prompt).toBe("new");
    expect(edited?.time).toBe("23:59");
    expect(edited?.conversationId).toBe(job.conversationId);
  });

  it("a prompt-only edit preserves next_run_at (does not cancel a pending run)", () => {
    const { store, ownerId } = makeStore("rj-prompt");
    const job = store.createRoutineJob(ownerId, { prompt: "old", minuteOfDay: 300 });
    const edited = store.updateRoutineJob(ownerId, job.id, { prompt: "new" });
    expect(edited?.prompt).toBe("new");
    expect(edited?.nextRunAt).toBe(job.nextRunAt);
    // Re-sending enabled:true on an already-enabled job is also timing-neutral.
    const same = store.updateRoutineJob(ownerId, job.id, { enabled: true });
    expect(same?.nextRunAt).toBe(job.nextRunAt);
  });

  it("legacy { prompt, minuteOfDay } calls still behave as a daily schedule", () => {
    const { store, ownerId } = makeStore("rj-legacy");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 9 * 60 });
    expect(job.scheduleKind).toBe("daily");
    expect(job.daysOfWeek).toBeNull();
    expect(job.intervalMinutes).toBeNull();
    expect(job.time).toBe("09:00");
    expect(job.nextRunAt).toBeTruthy();
  });

  it("persists a weekly schedule (daysOfWeek + future next run)", () => {
    const { store, ownerId } = makeStore("rj-weekly");
    const job = store.createRoutineJob(ownerId, {
      name: "주간",
      prompt: "p",
      scheduleKind: "weekly",
      minuteOfDay: 8 * 60,
      daysOfWeek: [1, 3, 5],
    });
    expect(job.scheduleKind).toBe("weekly");
    expect(job.daysOfWeek).toEqual([1, 3, 5]);
    expect(job.intervalMinutes).toBeNull();
    expect(job.nextRunAt).toBeTruthy();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    // Round-trips through toRoutineJob after reload.
    const reloaded = store.listRoutineJobs(ownerId)[0];
    expect(reloaded.name).toBe("주간");
    expect(reloaded.daysOfWeek).toEqual([1, 3, 5]);
    expect(reloaded.scheduleKind).toBe("weekly");
  });

  it("persists an interval schedule (intervalMinutes)", () => {
    const { store, ownerId } = makeStore("rj-interval");
    const job = store.createRoutineJob(ownerId, {
      prompt: "p",
      scheduleKind: "interval",
      intervalMinutes: 45,
    });
    expect(job.scheduleKind).toBe("interval");
    expect(job.intervalMinutes).toBe(45);
    expect(job.daysOfWeek).toBeNull();
    expect(job.name).toBeNull();
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    const reloaded = store.listRoutineJobs(ownerId)[0];
    expect(reloaded.intervalMinutes).toBe(45);
    expect(reloaded.scheduleKind).toBe("interval");
  });

  it("persists a one-time schedule and completes it after exactly one attempt", () => {
    const { store, ownerId } = makeStore("rj-once");
    const job = store.createRoutineJob(ownerId, {
      prompt: "한 번 실행",
      scheduleKind: "once",
      minuteOfDay: 9 * 60,
      runDate: "2099-12-31",
    });
    expect(job.scheduleKind).toBe("once");
    expect(job.runDate).toBe("2099-12-31");
    expect(job.nextRunAt).toBe("2099-12-31T00:00:00.000Z");
    expect(job.completedAt).toBeNull();
    expect(store.listDueRoutineJobs("2100-01-01T00:00:00.000Z").map((r) => r.id)).toContain(job.id);

    store.markRoutineRun(job.id, { status: "success" });
    const completed = store.getRoutineJob(ownerId, job.id)!;
    expect(completed.enabled).toBe(false);
    expect(completed.nextRunAt).toBeNull();
    expect(completed.completedAt).toBeTruthy();
    expect(completed.lastStatus).toBe("success");
    expect(store.listDueRoutineJobs("2100-01-01T00:00:00.000Z").map((r) => r.id)).not.toContain(job.id);

    const failed = store.createRoutineJob(ownerId, {
      prompt: "실패해도 한 번",
      scheduleKind: "once",
      minuteOfDay: 10 * 60,
      runDate: "2099-12-31",
    });
    store.markRoutineRun(failed.id, { status: "error", error: "실행 실패" });
    const failedCompleted = store.getRoutineJob(ownerId, failed.id)!;
    expect(failedCompleted.enabled).toBe(false);
    expect(failedCompleted.completedAt).toBeTruthy();
    expect(failedCompleted.lastStatus).toBe("error");
    expect(failedCompleted.lastError).toBe("실행 실패");
  });

  it("parks a past one-time schedule created through the low-level store API", () => {
    const { store, ownerId } = makeStore("rj-once-past");
    const job = store.createRoutineJob(ownerId, {
      prompt: "지난 예약",
      scheduleKind: "once",
      minuteOfDay: 0,
      runDate: "2000-01-01",
    });
    expect(job.enabled).toBe(false);
    expect(job.nextRunAt).toBeNull();
    const stillParked = store.updateRoutineJob(ownerId, job.id, { enabled: true });
    expect(stillParked?.enabled).toBe(false);
    expect(stillParked?.nextRunAt).toBeNull();
  });

  it("a name-only edit does not reschedule, but a schedule change does", () => {
    const { store, ownerId } = makeStore("rj-name-vs-sched");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 300 });
    // Name-only: nextRunAt preserved.
    const renamed = store.updateRoutineJob(ownerId, job.id, { name: "라벨" });
    expect(renamed?.name).toBe("라벨");
    expect(renamed?.nextRunAt).toBe(job.nextRunAt);
    // name=null clears the label, still no reschedule.
    const cleared = store.updateRoutineJob(ownerId, job.id, { name: null });
    expect(cleared?.name).toBeNull();
    expect(cleared?.nextRunAt).toBe(job.nextRunAt);
    // Switching to a weekly schedule recomputes nextRunAt.
    const rescheduled = store.updateRoutineJob(ownerId, job.id, {
      scheduleKind: "weekly",
      minuteOfDay: 8 * 60,
      daysOfWeek: [2],
    });
    expect(rescheduled?.scheduleKind).toBe("weekly");
    expect(rescheduled?.daysOfWeek).toEqual([2]);
    expect(rescheduled?.nextRunAt).not.toBe(job.nextRunAt);
    expect(new Date(rescheduled!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("markRoutineRun rolls an interval job forward by its interval", () => {
    const { store, ownerId } = makeStore("rj-mark-interval");
    const job = store.createRoutineJob(ownerId, {
      prompt: "p",
      scheduleKind: "interval",
      intervalMinutes: 30,
    });
    store.markRoutineRun(job.id, { status: "success" });
    const after = store.listRoutineJobs(ownerId)[0];
    expect(after.scheduleKind).toBe("interval");
    expect(after.lastStatus).toBe("success");
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("creates the dedicated conversation eagerly, titled from the prompt", () => {
    const { store, ownerId } = makeStore("rj-conv");
    const job = store.createRoutineJob(ownerId, { prompt: "매일 상태 요약", minuteOfDay: 540 });
    expect(store.listConversations(ownerId).some((c) => c.id === job.conversationId)).toBe(false);
    const conv = store.listConversations(ownerId, undefined, "routine").find((c) => c.id === job.conversationId);
    expect(conv).toBeTruthy();
    expect(conv!.title.startsWith("[예약 작업]")).toBe(true);
    expect(conv!.isRoutine).toBe(true);
    expect(conv!.routineId).toBe(job.id);
  });

  it("binds a 봇 루틴 to the bot: composite thread, owner row, personalAgentId", () => {
    const { store, ownerId } = makeStore("rj-bot-bind");
    const bot = store.createPersonalAgent(ownerId, { displayName: "리서치 봇" });
    const job = store.createRoutineJob(ownerId, {
      name: "주간 리서치",
      prompt: "이번 주 이슈 정리",
      minuteOfDay: 540,
      personalAgentId: bot.id,
    });

    expect(job.personalAgentId).toBe(bot.id);
    // avatar_user_id stays the OWNER's uuid — that is what keeps the scheduler's
    // suspended-owner JOIN and deleteUser's sweep working for bot routines too.
    expect(job.avatarUserId).toBe(ownerId);
    // ...while the THREAD belongs to the bot, so its history lands in 봇 오피스.
    expect(store.getConversationAvatarId(ownerId, job.conversationId)).toBe(
      personalAgentAvatarId(ownerId, bot.id),
    );
    const conv = store
      .listConversations(ownerId, undefined, "routine")
      .find((c) => c.id === job.conversationId);
    expect(conv).toMatchObject({ isRoutine: true, routineId: job.id });
    expect(conv!.title).toBe("[예약 작업] 주간 리서치");

    // A legacy routine is unchanged: NULL binding, owner-bound thread.
    const legacy = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 0 });
    expect(legacy.personalAgentId).toBeNull();
    expect(store.getConversationAvatarId(ownerId, legacy.conversationId)).toBe(ownerId);
  });

  it("listRoutineJobs filters tri-state: all / one bot / main avatar only", () => {
    const { store, ownerId } = makeStore("rj-bot-filter");
    const bot = store.createPersonalAgent(ownerId, { displayName: "봇 A" });
    const other = store.createPersonalAgent(ownerId, { displayName: "봇 B" });
    const mine = store.createRoutineJob(ownerId, { prompt: "내 것", minuteOfDay: 0 });
    const botJob = store.createRoutineJob(ownerId, {
      prompt: "봇 것",
      minuteOfDay: 0,
      personalAgentId: bot.id,
    });
    const otherJob = store.createRoutineJob(ownerId, {
      prompt: "다른 봇 것",
      minuteOfDay: 0,
      personalAgentId: other.id,
    });

    // No filter = everything, which is what the routines route and RoutinesView
    // keep seeing.
    expect(store.listRoutineJobs(ownerId).map((r) => r.id).sort()).toEqual(
      [mine.id, botJob.id, otherJob.id].sort(),
    );
    expect(
      store.listRoutineJobs(ownerId, { personalAgentId: bot.id }).map((r) => r.id),
    ).toEqual([botJob.id]);
    // An explicit null is the OWN-avatar filter, not "no filter".
    expect(
      store.listRoutineJobs(ownerId, { personalAgentId: null }).map((r) => r.id),
    ).toEqual([mine.id]);
    // An undefined value reads as "no filter", same as omitting the bag.
    expect(
      store.listRoutineJobs(ownerId, { personalAgentId: undefined }),
    ).toHaveLength(3);
  });

  it("executeRoutineJob runs the job, records the outcome, and blocks overlap", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-exec"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });

    // Two simultaneous firings: the shared guard lets exactly one through.
    const [first, second] = await Promise.all([
      executeRoutineJob(services, job),
      executeRoutineJob(services, job),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.skipped)).toHaveLength(1);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);

    const after = services.store.listRoutineJobs(owner.id)[0];
    expect(after.lastStatus).toBe("success");
    expect(after.lastRunAt).toBeTruthy();
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("executeRoutineJob records an error when the avatar no longer exists", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-missing-avatar"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const job = {
      id: "missing-job",
      avatarUserId: "missing-avatar",
      conversationId: "missing-conversation",
      name: null,
      prompt: "안녕",
      scheduleKind: "daily",
      minuteOfDay: 0,
      time: "00:00",
      daysOfWeek: null,
      intervalMinutes: null,
      runDate: null,
      enabled: true,
      nextRunAt: new Date().toISOString(),
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      personalAgentId: null,
    } as const;

    const result = await executeRoutineJob(services, job);

    expect(result).toEqual({ ok: false, error: "아바타를 찾을 수 없습니다." });
  });

  it("executeRoutineJob releases the overlap guard when outcome recording fails", async () => {
    const services = createServices({
      dataDir: path.join(tempDir, "rj-record-fail"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });
    const markRoutineRun = services.store.markRoutineRun.bind(services.store);
    vi.spyOn(services.store, "markRoutineRun")
      .mockImplementationOnce(() => {
        throw new Error("db write failed");
      })
      .mockImplementation(markRoutineRun);

    const failed = await executeRoutineJob(services, job);
    const retried = await executeRoutineJob(services, job);

    expect(failed).toEqual({ ok: false, error: "db write failed" });
    expect(retried.ok).toBe(true);
  });

  it("startRoutineScheduler runs due jobs and survives list failures", async () => {
    vi.useFakeTimers();
    try {
      const services = createServices({
        dataDir: path.join(tempDir, "rj-scheduler"),
        agentRuntime: "local",
        sessionSecret: "t",
      });
      const owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
      const job = services.store.createRoutineJob(owner.id, { prompt: "안녕", minuteOfDay: 0 });
      vi.spyOn(services.store, "listDueRoutineJobs")
        .mockImplementationOnce(() => {
          throw new Error("temporary db failure");
        })
        .mockReturnValueOnce([job])
        .mockReturnValue([]);

      const stop = startRoutineScheduler(services, { tickMs: 10 });
      try {
        await vi.advanceTimersByTimeAsync(10);
        expect(services.store.listMessages(owner.id, job.conversationId)).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(10);
        expect(services.store.listMessages(owner.id, job.conversationId)).toHaveLength(2);
      } finally {
        stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes updates and deletes to the owning avatar", () => {
    const { store, ownerId } = makeStore("rj4");
    const other = store.createUser({ username: "other", displayName: "Other", password: "password123" });
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 30 });
    expect(store.updateRoutineJob(other.id, job.id, { prompt: "x" })).toBeNull();
    expect(store.deleteRoutineJob(other.id, job.id)).toBe(false);
    expect(store.deleteRoutineJob(ownerId, job.id)).toBe(true);
    expect(store.listRoutineJobs(ownerId)).toHaveLength(0);
  });

  it("lists only enabled, due jobs and rolls them forward after a run", () => {
    const { store, ownerId } = makeStore("rj5");
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 0 });
    const nextRunMs = new Date(job.nextRunAt!).getTime();
    // Just before the scheduled instant, nothing is due.
    expect(store.listDueRoutineJobs(new Date(nextRunMs - 1000).toISOString())).toHaveLength(0);
    // Just after the scheduled instant, the job is due.
    const due = store.listDueRoutineJobs(new Date(nextRunMs + 1000).toISOString());
    expect(due.map((j) => j.id)).toContain(job.id);
    // Recording a run advances next_run_at into the future again.
    store.markRoutineRun(job.id, { status: "success" });
    const after = store.listRoutineJobs(ownerId)[0];
    expect(after.lastStatus).toBe("success");
    expect(after.lastRunAt).toBeTruthy();
    expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("schedules the next run at the requested Seoul (KST) time", () => {
    const { store, ownerId } = makeStore("rj-kst");
    const minuteOfDay = 9 * 60 + 30; // 09:30 KST
    const job = store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay });
    // Convert the stored UTC instant back to KST wall-clock minutes; it must
    // land exactly on the requested time regardless of the server's timezone.
    const kstMs = new Date(job.nextRunAt!).getTime() + 9 * 60 * 60 * 1000;
    const minutesInKstDay = Math.floor((kstMs % (24 * 60 * 60 * 1000)) / 60_000);
    expect(minutesInKstDay).toBe(minuteOfDay);
  });

  it("deleting the owner removes their routine jobs", () => {
    const { store, ownerId } = makeStore("rj6");
    store.createRoutineJob(ownerId, { prompt: "p", minuteOfDay: 10 });
    expect(store.deleteUser(ownerId)).toBe(true);
    expect(store.listRoutineJobs(ownerId)).toHaveLength(0);
  });
});


describe("group trust & visibility", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const friend = store.createUser({ username: "friend", displayName: "Friend", password: "password123" });
    const stranger = store.createUser({ username: "stranger", displayName: "Stranger", password: "password123" });
    return { store, ownerId: owner.id, friendId: friend.id, strangerId: stranger.id };
  }

  it("derives trust from group co-membership, symmetrically", () => {
    const { store, ownerId, friendId } = makeStore("gt1");
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    // Co-membership trusts both directions (unlike the old directional grant).
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.isTrustedFor(ownerId, friendId)).toBe(true);
    // Leaving the group revokes it.
    store.removeGroupMember(group.id, friendId);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
  });

  it("new avatars default to group visibility; updateProfile round-trips the 2 states", () => {
    const { store, ownerId } = makeStore("gt2");
    expect(store.getUserById(ownerId)?.visibility).toBe("group");
    expect(store.updateProfile(ownerId, { visibility: "private" }).visibility).toBe("private");
    expect(store.getUserById(ownerId)?.visibility).toBe("private");
    // …and back: `group` and `private` are the only two states.
    expect(store.updateProfile(ownerId, { visibility: "group" }).visibility).toBe("group");
    expect(store.getUserById(ownerId)?.visibility).toBe("group");
  });

  it("searchUsers matches name or @id (case-insensitive), excludes self", () => {
    const { store, ownerId } = makeStore("gt-search");
    // Substring match on display name AND username, case-insensitive.
    expect(store.searchUsers("frie", ownerId).map((u) => u.username)).toEqual(["friend"]);
    expect(store.searchUsers("STRANGER", ownerId).map((u) => u.username)).toEqual(["stranger"]);
    expect(store.searchUsers("r", ownerId).map((u) => u.username).sort()).toEqual(["friend", "stranger"]);
    // The searcher is never a candidate for their own results.
    expect(store.searchUsers("owner", ownerId)).toEqual([]);
    // Blank query short-circuits.
    expect(store.searchUsers("   ", ownerId)).toEqual([]);
    // A literal % isn't treated as a wildcard (escaped).
    expect(store.searchUsers("%", ownerId)).toEqual([]);
  });

  it("a group co-member resolves/sees a group-visible avatar; a stranger cannot", () => {
    const { store, ownerId, friendId, strangerId } = makeStore("gt3");
    // Owner keeps the default `group` visibility.
    expect(store.resolveChatAvatar(strangerId, ownerId)).toBeNull();
    expect(store.getAvatar(strangerId, ownerId)).toBeNull();
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    const detail = store.getAvatar(friendId, ownerId);
    expect(detail?.elevated).toBe(true);
    expect(detail?.isOwn).toBe(false);
  });

  it("a private avatar is reachable only by its owner, even by a group co-member", () => {
    const { store, ownerId, friendId } = makeStore("gt4");
    store.updateProfile(ownerId, { visibility: "private" });
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    // Group co-membership still grants elevation, but `private` blocks reach.
    expect(store.resolveChatAvatar(friendId, ownerId)).toBeNull();
    expect(store.getAvatar(friendId, ownerId)).toBeNull();
    // The owner always reaches their own avatar.
    expect(store.resolveChatAvatar(ownerId, ownerId)?.id).toBe(ownerId);
  });

  it("deleting a user clears their group memberships (and thus trust)", () => {
    const { store, ownerId, friendId } = makeStore("gt5");
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.deleteUser(friendId)).toBe(true);
    expect(store.listGroupMembers(group.id).map((m) => m.userId)).toEqual([ownerId]);
  });

  // ---- experimental features (#50) ----
  it("stores experimental features as a normalized key list (drops unknown)", () => {
    const { store, ownerId } = makeStore("ef1");
    expect(store.getUserById(ownerId)?.experimentalFeatures).toEqual([]);
    expect(store.getExperimentalFeatures(ownerId)).toEqual([]);
    // Unknown keys are dropped, known ones kept + deduped.
    const updated = store.updateProfile(ownerId, { experimentalFeatures: ["canvas", "canvas", "bogus"] });
    expect(updated.experimentalFeatures).toEqual(["canvas"]);
    expect(store.getExperimentalFeatures(ownerId)).toEqual(["canvas"]);
    // Clearing works.
    expect(store.updateProfile(ownerId, { experimentalFeatures: [] }).experimentalFeatures).toEqual([]);
  });

  // ---- per-secret shell exposure ----
  it("secret shell exposure defaults off, toggles per key, and dies with the secret", () => {
    const { store, ownerId } = makeStore("se1");
    store.setUserSecret(ownerId, "MY_API_KEY", "v1");
    store.setUserSecret(ownerId, "OTHER", "v2");
    expect(store.listShellExposedSecretNames(ownerId)).toEqual([]);
    expect(store.getUserById(ownerId)?.shellExposedSecretNames).toEqual([]);
    expect(store.setSecretShellExpose(ownerId, "MY_API_KEY", true)).toBe(true);
    expect(store.listShellExposedSecretNames(ownerId)).toEqual(["MY_API_KEY"]);
    expect(store.getUserById(ownerId)?.shellExposedSecretNames).toEqual(["MY_API_KEY"]);
    // Replacing the value keeps the flag; toggling off removes it.
    store.setUserSecret(ownerId, "MY_API_KEY", "v1b");
    expect(store.listShellExposedSecretNames(ownerId)).toEqual(["MY_API_KEY"]);
    expect(store.setSecretShellExpose(ownerId, "MY_API_KEY", false)).toBe(true);
    expect(store.listShellExposedSecretNames(ownerId)).toEqual([]);
    // Unknown secret → false (nothing to flag).
    expect(store.setSecretShellExpose(ownerId, "NOPE", true)).toBe(false);
    // Deleting the secret clears the exposure with it.
    store.setSecretShellExpose(ownerId, "OTHER", true);
    store.deleteUserSecret(ownerId, "OTHER");
    expect(store.listShellExposedSecretNames(ownerId)).toEqual([]);
  });

  // ---- per-secret browser input (브라우저 입력) ----
  it("browser input defaults off, round-trips the policy, and keeps hosts when disabled", () => {
    const { store, ownerId } = makeStore("bs1");
    store.setUserSecret(ownerId, "LOGIN_PW", "v1");
    store.setUserSecret(ownerId, "ALPHA_PW", "v2");
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([]);
    expect(store.getUserById(ownerId)?.browserSecrets).toEqual([]);

    expect(
      store.setSecretBrowserPolicy(ownerId, "LOGIN_PW", {
        enabled: true,
        hosts: ["jira.corp.com", "login.corp.com"],
        passwordOnly: true,
      }),
    ).toBe(true);
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([
      { name: "LOGIN_PW", hosts: ["jira.corp.com", "login.corp.com"], passwordOnly: true },
    ]);
    // toUser carries the POLICY (never a value) so the settings UI can render it.
    expect(store.getUserById(ownerId)?.browserSecrets).toEqual([
      { name: "LOGIN_PW", hosts: ["jira.corp.com", "login.corp.com"], passwordOnly: true },
    ]);

    // passwordOnly:false round-trips as the widened (any text field) policy.
    store.setSecretBrowserPolicy(ownerId, "ALPHA_PW", {
      enabled: true,
      hosts: ["wiki.corp.com"],
      passwordOnly: false,
    });
    // Ordered by name, so ALPHA_PW comes first.
    expect(store.listBrowserSecretPolicies(ownerId).map((p) => p.name)).toEqual([
      "ALPHA_PW",
      "LOGIN_PW",
    ]);
    expect(store.listBrowserSecretPolicies(ownerId)[0].passwordOnly).toBe(false);

    // Replacing the VALUE keeps the policy (the flag rides the secret row).
    store.setUserSecret(ownerId, "LOGIN_PW", "v1b");
    expect(store.listBrowserSecretPolicies(ownerId).map((p) => p.name)).toContain("LOGIN_PW");

    // Disabling with NO host list drops it from the list but KEEPS hosts/flag on
    // the row. Repeat it: the second disable must not wipe the allowlist either
    // (listBrowserSecretPolicies can't see a disabled row, so preservation has to
    // live in the write, not in a caller that re-reads it).
    expect(
      store.setSecretBrowserPolicy(ownerId, "LOGIN_PW", {
        enabled: false,
        hosts: [],
        passwordOnly: true,
      }),
    ).toBe(true);
    expect(store.listBrowserSecretPolicies(ownerId).map((p) => p.name)).toEqual(["ALPHA_PW"]);
    store.setSecretBrowserPolicy(ownerId, "LOGIN_PW", { enabled: false, hosts: [], passwordOnly: true });
    // Re-enabling with an empty list is refused at the route, so restore the way
    // the client does — send the remembered hosts back.
    store.setSecretBrowserPolicy(ownerId, "LOGIN_PW", {
      enabled: true,
      hosts: ["jira.corp.com", "login.corp.com"],
      passwordOnly: true,
    });
    expect(store.listBrowserSecretPolicies(ownerId)[1]).toEqual({
      name: "LOGIN_PW",
      hosts: ["jira.corp.com", "login.corp.com"],
      passwordOnly: true,
    });

    // A widened policy also survives disable→disable→re-enable untouched.
    store.setSecretBrowserPolicy(ownerId, "ALPHA_PW", { enabled: false, hosts: [], passwordOnly: true });
    store.setSecretBrowserPolicy(ownerId, "ALPHA_PW", { enabled: false, hosts: [], passwordOnly: true });
    store.setSecretBrowserPolicy(ownerId, "ALPHA_PW", {
      enabled: true,
      hosts: ["wiki.corp.com"],
      passwordOnly: false,
    });
    expect(store.listBrowserSecretPolicies(ownerId)[0]).toEqual({
      name: "ALPHA_PW",
      hosts: ["wiki.corp.com"],
      passwordOnly: false,
    });

    // Unknown secret → false (nothing to flag).
    expect(
      store.setSecretBrowserPolicy(ownerId, "NOPE", { enabled: true, hosts: ["a.com"], passwordOnly: true }),
    ).toBe(false);
    // Deleting the secret takes the policy with it.
    store.deleteUserSecret(ownerId, "ALPHA_PW");
    expect(store.listBrowserSecretPolicies(ownerId).map((p) => p.name)).toEqual(["LOGIN_PW"]);
  });

  it("browser-input reads fail closed on reserved names, empty hosts and malformed JSON", () => {
    const { store, ownerId } = makeStore("bs2");
    type WithDb = { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } };
    const db = (store as unknown as WithDb).db;

    // A reserved git/SSH name can never be browser-typed. The route refuses to
    // set one, so plant the flag directly: a hand-edited DB must not widen the gate.
    store.setUserSecret(ownerId, "GIT_TOKEN", "t");
    db.prepare(
      "UPDATE user_secrets SET browser_expose = 1, browser_hosts = ? WHERE user_id = ? AND name = 'GIT_TOKEN'",
    ).run(JSON.stringify(["github.corp.com"]), ownerId);
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([]);

    // Enabled with NO hosts advertises a secret the bridge would always refuse.
    store.setUserSecret(ownerId, "EMPTY_PW", "v");
    store.setSecretBrowserPolicy(ownerId, "EMPTY_PW", { enabled: true, hosts: [], passwordOnly: true });
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([]);

    // Malformed hosts JSON skips the row rather than guessing which sites were meant.
    store.setUserSecret(ownerId, "BROKEN_PW", "v");
    db.prepare(
      "UPDATE user_secrets SET browser_expose = 1, browser_hosts = '{oops' WHERE user_id = ? AND name = 'BROKEN_PW'",
    ).run(ownerId);
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([]);

    // An invalid host inside an otherwise fine list is all-or-nothing too.
    store.setUserSecret(ownerId, "WILD_PW", "v");
    db.prepare(
      "UPDATE user_secrets SET browser_expose = 1, browser_hosts = ? WHERE user_id = ? AND name = 'WILD_PW'",
    ).run(JSON.stringify(["*.corp.com", "jira.corp.com"]), ownerId);
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([]);

    // A legacy row whose browser_password_only was never written reads as the
    // SAFE end of the toggle (password fields only).
    store.setUserSecret(ownerId, "LEGACY_PW", "v");
    db.prepare(
      "UPDATE user_secrets SET browser_expose = 1, browser_hosts = ?, browser_password_only = NULL " +
        "WHERE user_id = ? AND name = 'LEGACY_PW'",
    ).run(JSON.stringify(["jira.corp.com"]), ownerId);
    expect(store.listBrowserSecretPolicies(ownerId)).toEqual([
      { name: "LEGACY_PW", hosts: ["jira.corp.com"], passwordOnly: true },
    ]);
  });

  it("adds the browser-input columns to an EXISTING deployment's user_secrets table", () => {
    // Deployment is a separate corporate box, so the columns must arrive by
    // ALTER TABLE on a live DB — a fresh-install-only schema would ship broken.
    const dataDir = path.join(tempDir, "bs-migration");
    const open = () =>
      createServices({ dataDir, agentRuntime: "local", sessionSecret: "bs" }).store;
    type WithDb = {
      db: {
        prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown };
      };
    };
    const dbOf = (store: unknown) => (store as unknown as WithDb).db;
    const columnsOf = (store: unknown) =>
      (dbOf(store).prepare("PRAGMA table_info(user_secrets)").all() as { name: string }[]).map(
        (c) => c.name,
      );

    const first = open();
    const owner = first.createUser({ username: "bsowner", displayName: "Owner", password: "password123" });
    first.setUserSecret(owner.id, "LOGIN_PW", "v");
    // Reproduce the pre-feature shape: a deployment DB where the three columns
    // simply do not exist yet.
    for (const column of ["browser_expose", "browser_hosts", "browser_password_only"]) {
      dbOf(first).prepare(`ALTER TABLE user_secrets DROP COLUMN ${column}`).run();
    }
    expect(columnsOf(first)).not.toContain("browser_expose");
    first.close();

    // Reopening the SAME dataDir runs migrate() → addColumnIfMissing.
    const second = open();
    expect(columnsOf(second)).toEqual(
      expect.arrayContaining(["browser_expose", "browser_hosts", "browser_password_only"]),
    );
    // The pre-existing secret survives, defaults to off, and can be opted in.
    expect(second.listUserSecretNames(owner.id)).toEqual(["LOGIN_PW"]);
    expect(second.listBrowserSecretPolicies(owner.id)).toEqual([]);
    expect(
      second.setSecretBrowserPolicy(owner.id, "LOGIN_PW", {
        enabled: true,
        hosts: ["jira.corp.com"],
        passwordOnly: true,
      }),
    ).toBe(true);
    expect(second.listBrowserSecretPolicies(owner.id)).toEqual([
      { name: "LOGIN_PW", hosts: ["jira.corp.com"], passwordOnly: true },
    ]);
    second.close();
  });

  // ---- shared (communal) account ----
  it("sharedAccount defaults off, round-trips through updateProfile, and reads via isSharedAccount", () => {
    const { store, ownerId } = makeStore("sa1");
    expect(store.getUserById(ownerId)?.sharedAccount).toBe(false);
    expect(store.isSharedAccount(ownerId)).toBe(false);
    expect(store.updateProfile(ownerId, { sharedAccount: true }).sharedAccount).toBe(true);
    expect(store.isSharedAccount(ownerId)).toBe(true);
    // An unrelated profile patch leaves the flag untouched.
    expect(store.updateProfile(ownerId, { bio: "b" }).sharedAccount).toBe(true);
    expect(store.updateProfile(ownerId, { sharedAccount: false }).sharedAccount).toBe(false);
  });
});


describe("group avatar-sharing policy", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const friend = store.createUser({ username: "friend", displayName: "Friend", password: "password123" });
    return { store, ownerId: owner.id, friendId: friend.id };
  }

  it("sharing OFF removes BOTH visibility and trust for that group; ON restores both", () => {
    const { store, ownerId, friendId } = makeStore("as1");
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    expect(store.getGroup(group.id)?.avatarSharing).toBe(true); // default on
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    expect(store.listPublishedAvatars(friendId).some((a) => a.id === ownerId)).toBe(true);

    expect(store.setGroupAvatarSharing(group.id, false)?.avatarSharing).toBe(false);
    // The two axes ride the same SHARING_TEAMMATES fragment: both drop together.
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
    expect(store.resolveChatAvatar(friendId, ownerId)).toBeNull();
    expect(store.getAvatar(friendId, ownerId)).toBeNull();
    expect(store.listPublishedAvatars(friendId).some((a) => a.id === ownerId)).toBe(false);
    expect(store.searchAvatars(friendId, "").some((a) => a.id === ownerId)).toBe(false);
    // Own avatar still lists (self-exception is not group-derived).
    expect(store.listPublishedAvatars(friendId).some((a) => a.id === friendId)).toBe(true);

    store.setGroupAvatarSharing(group.id, true);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
  });

  it("any avatar-sharing group suffices; sharedGroupNames names only sharing groups", () => {
    const { store, ownerId, friendId } = makeStore("as2");
    const g1 = store.createGroup({ name: "Alpha" });
    const g2 = store.createGroup({ name: "Beta" });
    for (const g of [g1, g2]) {
      store.addGroupMember(g.id, ownerId, "member");
      store.addGroupMember(g.id, friendId, "member");
    }
    store.setGroupAvatarSharing(g1.id, false);
    // g2 still shares → reach + trust survive; the why-elevated list is exact.
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    expect(store.sharedGroupNames(friendId, ownerId)).toEqual(["Beta"]);
    store.setGroupAvatarSharing(g2.id, false);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
    expect(store.sharedGroupNames(friendId, ownerId)).toEqual([]);
  });

  it("a sharing-off group still shares its knowledge repo and its admin tool policy", () => {
    const { store, ownerId, friendId } = makeStore("as3");
    const group = store.createGroup({ name: "Workshop" });
    store.addGroupMember(group.id, ownerId, "admin");
    store.addGroupMember(group.id, friendId, "member");
    store.setGroupKnowledgeRepo(group.id, "acme/wiki", null);
    store.setGroupAllowedMcpToolGroups(group.id, ["personal_knowledge"]);
    store.setGroupAvatarSharing(group.id, false);
    // Knowledge-sharing-only: repo membership + tool clamp are policy-independent.
    expect(
      store.listGroupKnowledgeReposForUser(friendId).some((g) => g.groupId === group.id),
    ).toBe(true);
    expect(store.listUserGroups(friendId)[0]).toMatchObject({
      knowledgeRepoConfigured: true,
      avatarSharing: false,
    });
    expect(store.allowedMcpToolGroupsForUser(friendId)).toEqual(["personal_knowledge", "system"]);
    expect(store.listGroupMembers(group.id)).toHaveLength(2);
  });

  it("NULL (pre-policy rows) reads as ON; only an explicit 0 turns it off", () => {
    const { store, ownerId, friendId } = makeStore("as4");
    const group = store.createGroup({ name: "Legacy" });
    store.addGroupMember(group.id, ownerId, "member");
    store.addGroupMember(group.id, friendId, "member");
    // Simulate a pre-policy row (the addColumnIfMissing migration leaves NULL).
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...v: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE groups SET avatar_sharing = NULL WHERE id = ?").run(group.id);
    expect(store.getGroup(group.id)?.avatarSharing).toBe(true);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(true);
    expect(store.resolveChatAvatar(friendId, ownerId)?.id).toBe(ownerId);
    store.setGroupAvatarSharing(group.id, false);
    expect(store.getGroup(group.id)?.avatarSharing).toBe(false);
    expect(store.isTrustedFor(friendId, ownerId)).toBe(false);
  });
});


describe("normalizeHashtags", () => {
  it("strips leading #/markers, trims, hyphenates spaces, dedupes case-insensitively", () => {
    expect(normalizeHashtags(["#코드리뷰", "코드리뷰", "  - 파이썬 ", "데이터 분석"])).toEqual([
      "코드리뷰",
      "파이썬",
      "데이터-분석",
    ]);
  });
  it("keeps C#/C++ intact (only the LEADING # is removed)", () => {
    expect(normalizeHashtags(["C#", "C++"])).toEqual(["C#", "C++"]);
  });
  it("parses a raw string by splitting on whitespace/commas", () => {
    expect(normalizeHashtags("#a #b, c")).toEqual(["a", "b", "c"]);
  });
  it("caps the count at 12 and each tag at 30 chars", () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    expect(normalizeHashtags(many)).toHaveLength(12);
    expect(normalizeHashtags(["x".repeat(50)])[0]).toHaveLength(30);
  });
  it("ignores non-strings, empties, and bare punctuation", () => {
    expect(normalizeHashtags([123, "", "  ", "#", "ok"])).toEqual(["ok"]);
  });
});


describe("searchAvatars (cross-avatar discovery)", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "search"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    return store;
  }

  it("ranks a hashtag match above a body match and excludes the querying avatar", () => {
    const store = makeStore();
    const reviewer = store.createUser({ username: "reviewer", displayName: "리뷰어", password: "password123" });
    const analyst = store.createUser({ username: "analyst", displayName: "분석가", password: "password123" });
    const me = store.createUser({ username: "me", displayName: "나", password: "password123" });
    // Both keep the default `group` visibility; a shared group is what makes them
    // discoverable by `me` cross-avatar (there is no wider "public" state).
    store.updateProfile(reviewer.id, { hashtags: ["코드리뷰", "파이썬"] });
    store.updateProfile(analyst.id, { hashtags: ["데이터분석"], bio: "코드리뷰도 가끔 합니다" });
    const group = store.createGroup({ name: "Search", createdBy: null });
    store.addGroupMember(group.id, me.id, "member");
    store.addGroupMember(group.id, reviewer.id, "member");
    store.addGroupMember(group.id, analyst.id, "member");

    const hits = store.searchAvatars(me.id, "코드리뷰", { excludeId: me.id });
    expect(hits.map((a) => a.username)).toEqual(["reviewer", "analyst"]);
    expect(hits.some((a) => a.username === "me")).toBe(false);
    expect(hits[0].hashtags).toContain("코드리뷰");
  });

  it("only surfaces avatars visible to the viewer (plus the viewer's own)", () => {
    const store = makeStore();
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const hidden = store.createUser({ username: "hidden", displayName: "H", password: "password123" });
    store.updateProfile(hidden.id, { hashtags: ["쿠버네티스"], visibility: "private" });

    expect(store.searchAvatars(a.id, "쿠버네티스")).toHaveLength(0);
    // The owner still finds their OWN non-visible avatar.
    expect(store.searchAvatars(hidden.id, "쿠버네티스").map((x) => x.username)).toContain("hidden");
  });

  it("lists candidates for an empty query, excluding self", () => {
    const store = makeStore();
    const a = store.createUser({ username: "a", displayName: "A", password: "password123" });
    const b = store.createUser({ username: "b", displayName: "B", password: "password123" });
    // b keeps the default `group` visibility, so a shared group is what makes b
    // discoverable by a.
    const group = store.createGroup({ name: "Empty Query", createdBy: null });
    store.addGroupMember(group.id, a.id, "member");
    store.addGroupMember(group.id, b.id, "member");
    expect(store.searchAvatars(a.id, "", { excludeId: a.id }).map((x) => x.username)).toEqual(["b"]);
  });
});


describe("store groups", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const admin = store.createUser({ username: "admin", displayName: "Admin", password: "password123" });
    const alice = store.createUser({ username: "alice", displayName: "Alice", password: "password123" });
    const bob = store.createUser({ username: "bob", displayName: "Bob", password: "password123" });
    const carol = store.createUser({ username: "carol", displayName: "Carol", password: "password123" });
    return { store, adminId: admin.id, aliceId: alice.id, bobId: bob.id, carolId: carol.id };
  }

  it("creates, lists, updates, and deletes groups", () => {
    const { store } = makeStore("g-crud");
    const g = store.createGroup({ name: "Team A", description: "desc", createdBy: null });
    expect(g.name).toBe("Team A");
    expect(store.getGroup(g.id)?.description).toBe("desc");
    expect(store.listGroups().map((x) => x.name)).toContain("Team A");
    expect(store.listGroups()[0].memberCount).toBe(0);
    store.updateGroup(g.id, { name: "Team B" });
    expect(store.getGroup(g.id)?.name).toBe("Team B");
    expect(store.deleteGroup(g.id)).toBe(true);
    expect(store.getGroup(g.id)).toBeNull();
  });

  it("manages members + roles", () => {
    const { store, aliceId, bobId } = makeStore("g-mem");
    const g = store.createGroup({ name: "T", createdBy: null });
    expect(store.addGroupMember(g.id, aliceId, "admin")?.role).toBe("admin");
    expect(store.addGroupMemberByUsername(g.id, "bob")?.role).toBe("member");
    expect(store.groupRoleFor(aliceId, g.id)).toBe("admin");
    expect(store.isGroupAdmin(aliceId, g.id)).toBe(true);
    expect(store.isGroupAdmin(bobId, g.id)).toBe(false);
    expect(store.listGroupMembers(g.id).map((m) => m.userId).sort()).toEqual([aliceId, bobId].sort());
    expect(store.setGroupMemberRole(g.id, bobId, "admin")?.role).toBe("admin");
    expect(store.listGroups()[0].adminCount).toBe(2);
    expect(store.removeGroupMember(g.id, bobId)).toBe(true);
    expect(store.groupRoleFor(bobId, g.id)).toBeNull();
    expect(store.addGroupMemberByUsername(g.id, "nobody")).toBeNull();
  });

  it("group co-membership grants mutual, symmetric trust + group-visible-avatar access", () => {
    const { store, aliceId, bobId, carolId } = makeStore("g-trust");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId, "member");
    store.addGroupMember(g.id, bobId, "member");
    // Group trust is symmetric.
    expect(store.isTrustedFor(aliceId, bobId)).toBe(true);
    expect(store.isTrustedFor(bobId, aliceId)).toBe(true);
    expect(store.isTrustedFor(carolId, aliceId)).toBe(false);
    // alice keeps the default `group` visibility — bob (co-member) reaches her
    // avatar at elevated level; carol (not a teammate) cannot.
    expect(store.getAvatar(bobId, aliceId)?.elevated).toBe(true);
    expect(store.getAvatar(carolId, aliceId)).toBeNull();
    expect(store.resolveChatAvatar(bobId, aliceId)?.id).toBe(aliceId);
  });

  it("removing the shared group drops the auto-trust", () => {
    const { store, aliceId, bobId } = makeStore("g-trust-drop");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(true);
    store.deleteGroup(g.id);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(false);
  });

  it("deleting a user removes their group memberships (and the trust they conferred)", () => {
    const { store, aliceId, bobId } = makeStore("g-cascade");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    expect(store.deleteUser(bobId)).toBe(true);
    expect(store.listGroupMembers(g.id).map((m) => m.userId)).toEqual([aliceId]);
    expect(store.isTrustedFor(aliceId, bobId)).toBe(false);
  });

  it("toUser exposes group memberships with role", () => {
    const { store, aliceId } = makeStore("g-user");
    const g = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(g.id, aliceId, "admin");
    const u = store.getUserById(aliceId);
    expect(u?.groups.map((x) => x.name)).toEqual(["Team"]);
    expect(u?.groups[0].role).toBe("admin");
  });

  it("group knowledge repo: setting it clears selection; lists per-user repos", () => {
    const { store, aliceId, bobId } = makeStore("g-repo");
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    expect(store.getGroupKnowledgeRepo(g.id).repo).toBeNull();
    store.setGroupKnowledgeRepo(g.id, "org/team-knowledge", "main");
    store.setGroupKnowledgeSelected(g.id, ["a"]);
    expect(store.getGroupKnowledgeRepo(g.id).selected).toEqual(["a"]);
    store.setGroupKnowledgeRepo(g.id, "org/other", null);
    expect(store.getGroupKnowledgeRepo(g.id).selected).toBeNull();
    const repos = store.listGroupKnowledgeReposForUser(aliceId);
    expect(repos.map((r) => r.repo)).toEqual(["org/other"]);
    // bob isn't in the group → sees no group repos.
    expect(store.listGroupKnowledgeReposForUser(bobId)).toEqual([]);
  });

  it("listPublishedAvatars surfaces group-visible teammates with sharesGroup, and nobody else", () => {
    const { store, aliceId, bobId, carolId } = makeStore("g-explore");
    // bob and carol both keep the default `group` visibility; only bob shares a
    // group with alice.
    const g = store.createGroup({ name: "T", createdBy: null });
    store.addGroupMember(g.id, aliceId);
    store.addGroupMember(g.id, bobId);
    const forAlice = store.listPublishedAvatars(aliceId);
    const bobCard = forAlice.find((a) => a.id === bobId);
    // bob is group-visible AND a teammate → visible + flagged.
    expect(bobCard?.sharesGroup).toBe(true);
    // carol shares no group with alice, so she is not listed AT ALL — group
    // co-membership is the only thing that grants reach now, and a `sharesGroup:
    // false` card (the old "public but not a teammate" state) can no longer exist.
    expect(forAlice.some((a) => a.id === carolId)).toBe(false);
    expect(forAlice.every((a) => a.id === aliceId || a.sharesGroup)).toBe(true);
  });
});

describe("store canvas artifacts (#50)", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "canvas-" + Math.random().toString(36).slice(2)),
      agentRuntime: "local",
      sessionSecret: "cvs",
    });
    const owner = store.createUser({ username: "cvsowner", displayName: "Owner", password: "password123" });
    const avatar = store.createUser({ username: "cvsavatar", displayName: "Avatar", password: "password123" });
    store.touchConversation(owner.id, "conv-cvs", avatar.id, "hi");
    return { store, ownerId: owner.id };
  }

  it("creates v1, lists current state, and is owner-scoped", () => {
    const { store, ownerId } = makeStore();
    const art = store.upsertCanvasArtifact(ownerId, "conv-cvs", {
      artifactId: "a1",
      title: "Chart",
      content: "# hi",
      contentType: "markdown",
      controls: [{ type: "select", id: "p", options: [{ label: "High" }] }],
      interaction: "blocking",
    });
    expect(art?.currentVersion).toBe(1);
    expect(art?.versionCount).toBe(1);
    expect(art?.controls?.[0].type).toBe("select");
    const list = store.listCanvasArtifacts(ownerId, "conv-cvs");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Chart");
    // Another owner sees nothing.
    const other = store.createUser({ username: "cvsother", displayName: "Other", password: "password123" });
    expect(store.listCanvasArtifacts(other.id, "conv-cvs")).toHaveLength(0);
    expect(store.getCanvasArtifact(other.id, "a1")).toBeNull();
  });

  it("appends a version on content change but dedups an unchanged re-show", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v1", contentType: "markdown" });
    // Identical re-show with a submission → no new version, values attach.
    const same = store.upsertCanvasArtifact(ownerId, "conv-cvs", {
      artifactId: "a1",
      title: "T",
      content: "v1",
      contentType: "markdown",
      submittedValues: { p: "x" },
    });
    expect(same?.currentVersion).toBe(1);
    expect(same?.submittedValues).toEqual({ p: "x" });
    // Changed content → version 2.
    const next = store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v2", contentType: "markdown" });
    expect(next?.currentVersion).toBe(2);
    expect(next?.versionCount).toBe(2);
    expect(next?.content).toBe("v2");
  });

  it("rolls back non-destructively to an earlier version", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v1", contentType: "markdown" });
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v2", contentType: "markdown" });
    const rolled = store.rollbackCanvasArtifact(ownerId, "a1", 1);
    expect(rolled?.content).toBe("v1");
    expect(rolled?.currentVersion).toBe(3); // appended, not destructive
    expect(store.listCanvasVersions(ownerId, "a1").map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it("hard-deletes an artifact and its versions, owner-scoped", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v1", contentType: "markdown" });
    const other = store.createUser({ username: "cvsdel", displayName: "Other", password: "password123" });
    expect(store.deleteCanvasArtifact(other.id, "a1")).toBe(false);
    expect(store.deleteCanvasArtifact(ownerId, "a1")).toBe(true);
    expect(store.getCanvasArtifact(ownerId, "a1")).toBeNull();
    expect(store.listCanvasVersions(ownerId, "a1")).toHaveLength(0);
  });

  it("refuses to upsert an existing artifact id across owner or conversation boundaries", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", {
      artifactId: "a1",
      title: "Owner",
      content: "owner-v1",
      contentType: "markdown",
    });

    const other = store.createUser({ username: "cvshijack", displayName: "Other", password: "password123" });
    store.touchConversation(other.id, "conv-other-cvs", other.id, "hi");
    expect(
      store.upsertCanvasArtifact(other.id, "conv-other-cvs", {
        artifactId: "a1",
        title: "Other",
        content: "other-v1",
        contentType: "markdown",
      }),
    ).toBeNull();

    store.touchConversation(ownerId, "conv-cvs-2", ownerId, "second");
    expect(
      store.upsertCanvasArtifact(ownerId, "conv-cvs-2", {
        artifactId: "a1",
        title: "Same owner, other conversation",
        content: "other-conv",
        contentType: "markdown",
      }),
    ).toBeNull();

    expect(store.getCanvasArtifact(ownerId, "a1")?.content).toBe("owner-v1");
    expect(store.listCanvasArtifacts(ownerId, "conv-cvs-2")).toHaveLength(0);
  });

  it("cascades canvas artifacts when deleting a conversation", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v1", contentType: "markdown" });
    expect(store.deleteConversation(ownerId, "conv-cvs")).toBe(true);

    store.touchConversation(ownerId, "conv-cvs-new", ownerId, "new");
    const re = store.upsertCanvasArtifact(ownerId, "conv-cvs-new", {
      artifactId: "a1",
      title: "T2",
      content: "fresh",
      contentType: "markdown",
    });
    expect(re?.currentVersion).toBe(1);
    expect(re?.content).toBe("fresh");
  });

  it("cascades canvas artifacts when bulk-deleting chat conversations", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "bulk-a1", title: "T", content: "v1", contentType: "markdown" });
    expect(store.deleteChatConversations(ownerId)).toContain("conv-cvs");

    store.touchConversation(ownerId, "conv-cvs-bulk-new", ownerId, "new");
    const re = store.upsertCanvasArtifact(ownerId, "conv-cvs-bulk-new", {
      artifactId: "bulk-a1",
      title: "T2",
      content: "fresh",
      contentType: "markdown",
    });
    expect(re?.currentVersion).toBe(1);
  });

  it("cascades canvas artifacts on deleteUser", () => {
    const { store, ownerId } = makeStore();
    store.upsertCanvasArtifact(ownerId, "conv-cvs", { artifactId: "a1", title: "T", content: "v1", contentType: "markdown" });
    expect(store.deleteUser(ownerId)).toBe(true);
    // Re-create same id under a fresh owner to confirm the old rows are gone (no PK clash).
    const fresh = store.createUser({ username: "cvsfresh", displayName: "Fresh", password: "password123" });
    store.touchConversation(fresh.id, "conv-fresh", fresh.id, "hi");
    const re = store.upsertCanvasArtifact(fresh.id, "conv-fresh", { artifactId: "a1", title: "T2", content: "n", contentType: "markdown" });
    expect(re?.currentVersion).toBe(1);
  });

  it("cascades canvas artifacts when deleting the avatar targeted by a conversation", () => {
    const { store, ownerId } = makeStore();
    const avatar = store.createUser({ username: "cvsdeletedavatar", displayName: "Avatar", password: "password123" });
    store.touchConversation(ownerId, "conv-target-avatar", avatar.id, "hi");
    store.upsertCanvasArtifact(ownerId, "conv-target-avatar", {
      artifactId: "target-a1",
      title: "Target",
      content: "v1",
      contentType: "markdown",
    });

    expect(store.deleteUser(avatar.id)).toBe(true);
    store.touchConversation(ownerId, "conv-target-new", ownerId, "new");
    const re = store.upsertCanvasArtifact(ownerId, "conv-target-new", {
      artifactId: "target-a1",
      title: "T2",
      content: "fresh",
      contentType: "markdown",
    });
    expect(re?.currentVersion).toBe(1);
  });
});

describe("store canvas backfill migration (#50)", () => {
  // Reach the underlying SQLite handle to read/poke PRAGMA user_version (the
  // backfill guard), simulating a pre-feature DB that predates the migration.
  type WithDb = { db: { pragma(stmt: string, opts?: { simple?: boolean }): unknown } };
  const dbOf = (store: unknown): WithDb["db"] => (store as unknown as WithDb).db;

  it("backfills legacy response_json canvases into the tables on (re)open, idempotently", () => {
    const dataDir = path.join(tempDir, "canvas-backfill");
    const first = createServices({ dataDir, agentRuntime: "local", sessionSecret: "bf" }).store;
    const owner = first.createUser({ username: "bfowner", displayName: "Owner", password: "password123" });
    const avatar = first.createUser({ username: "bfavatar", displayName: "Avatar", password: "password123" });
    first.touchConversation(owner.id, "conv-bf", avatar.id, "hi");
    // A legacy assistant message that carried canvases on its response JSON.
    first.addMessage("conv-bf", {
      role: "assistant",
      content: "done",
      response: {
        kind: "text",
        runtime: "claude",
        summary: "",
        text: "done",
        canvases: [
          { id: "legacy-1", title: "Legacy", content: "# old", contentType: "markdown" },
        ],
      },
    });
    // No table row yet (legacy data only lives in response_json).
    expect(first.listCanvasArtifacts(owner.id, "conv-bf")).toHaveLength(0);
    // The first open already climbed the backfill ladder (user_version=2). Reset
    // it to 0 to mimic a real pre-feature DB: legacy canvases present, migration
    // not yet run.
    dbOf(first).pragma("user_version = 0");

    // Reopen the same DB → migrate() runs migrateCanvasArtifacts() and backfills.
    const second = createServices({ dataDir, agentRuntime: "local", sessionSecret: "bf" }).store;
    const list = second.listCanvasArtifacts(owner.id, "conv-bf");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("legacy-1");
    expect(list[0].content).toBe("# old");
    // The guard advanced user_version to the top of the backfill ladder so later
    // boots skip the scan (canvas backfill=1, then onboarded/routine wave=2).
    expect(dbOf(second).pragma("user_version", { simple: true })).toBe(2);

    // Re-running migrate (a third open) must not duplicate.
    const third = createServices({ dataDir, agentRuntime: "local", sessionSecret: "bf" }).store;
    expect(third.listCanvasArtifacts(owner.id, "conv-bf")).toHaveLength(1);
  });

  it("skips the scan on later boots — legacy data added after migration is not rescanned", () => {
    const dataDir = path.join(tempDir, "canvas-backfill-guard");
    const first = createServices({ dataDir, agentRuntime: "local", sessionSecret: "bf" }).store;
    const owner = first.createUser({ username: "bfgowner", displayName: "Owner", password: "password123" });
    const avatar = first.createUser({ username: "bfgavatar", displayName: "Avatar", password: "password123" });
    first.touchConversation(owner.id, "conv-bfg", avatar.id, "hi");
    // First open already ran the backfill (nothing to do) and climbed the ladder
    // to the top (canvas=1, then onboarded/routine wave=2).
    expect(dbOf(first).pragma("user_version", { simple: true })).toBe(2);
    // Inject a legacy-shaped canvas AFTER the marker is set.
    first.addMessage("conv-bfg", {
      role: "assistant",
      content: "done",
      response: {
        kind: "text",
        runtime: "claude",
        summary: "",
        text: "done",
        canvases: [{ id: "post-marker", title: "Late", content: "# late", contentType: "markdown" }],
      },
    });

    // Reopen: the guard short-circuits, so the post-marker legacy canvas is NOT backfilled.
    const second = createServices({ dataDir, agentRuntime: "local", sessionSecret: "bf" }).store;
    expect(second.listCanvasArtifacts(owner.id, "conv-bfg")).toHaveLength(0);
  });
});


// ---- Just-applied dedup/efficiency store refactors (regression locks) ----

describe("store avatar directory aggregates (N+1 reshape)", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    return store;
  }

  it("directory pluginCount counts only ENABLED avatar_plugins, and getAvatar agrees", () => {
    const store = makeStore("dir-plugins");
    // The owner is its own viewer here, so the discovery queries' self-exception
    // lists it regardless of visibility — no group scaffold needed.
    const owner = store.createUser({ username: "dirowner", displayName: "Dir Owner", password: "password123" });

    // Two enabled + one disabled plugin → directory count must be 2.
    const p1 = store.addPlugin(owner.id, { repo: "owner/one" });
    store.addPlugin(owner.id, { repo: "owner/two" });
    const p3 = store.addPlugin(owner.id, { repo: "owner/three" });
    store.setPluginEnabled(owner.id, p3.id, false);
    void p1;

    // listPublishedAvatars path: pluginCount comes from the correlated subquery column.
    const listCard = store.listPublishedAvatars(owner.id).find((a) => a.id === owner.id);
    expect(listCard?.pluginCount).toBe(2);

    // searchAvatars path: same subquery column.
    const searchCard = store.searchAvatars(owner.id, "").find((a) => a.id === owner.id);
    expect(searchCard?.pluginCount).toBe(2);

    // getAvatar single-row path: toAvatarSummary FALLS BACK to the per-row query
    // (no subquery columns on the plain UserRow). It must compute the SAME count.
    const detail = store.getAvatar(owner.id, owner.id);
    expect(detail?.pluginCount).toBe(2);
    expect(detail?.pluginCount).toBe(listCard?.pluginCount);

    // Re-enabling the disabled plugin bumps every path to 3 in lockstep.
    store.setPluginEnabled(owner.id, p3.id, true);
    expect(store.listPublishedAvatars(owner.id).find((a) => a.id === owner.id)?.pluginCount).toBe(3);
    expect(store.searchAvatars(owner.id, "").find((a) => a.id === owner.id)?.pluginCount).toBe(3);
    expect(store.getAvatar(owner.id, owner.id)?.pluginCount).toBe(3);
  });

  it("directory updatedAt reflects MAX(updated_at) over the owner's own-avatar conversations; getAvatar agrees", () => {
    const store = makeStore("dir-updated");
    // Own-viewer again: the self-exception is what makes the card listable.
    const owner = store.createUser({ username: "updowner", displayName: "Upd Owner", password: "password123" });

    // No own-avatar conversations yet → MAX over an empty set is NULL.
    expect(store.listPublishedAvatars(owner.id).find((a) => a.id === owner.id)?.updatedAt).toBeNull();
    expect(store.getAvatar(owner.id, owner.id)?.updatedAt).toBeNull();

    // The subquery only counts conversations where avatar_user_id == owner_user_id
    // (the owner chatting with their OWN avatar). Create two such conversations.
    store.touchConversation(owner.id, "own-conv-1", owner.id, "first");
    store.touchConversation(owner.id, "own-conv-2", owner.id, "second");
    // A conversation targeting a DIFFERENT avatar must NOT count toward this owner.
    const otherAvatar = store.createUser({ username: "otheravatar", displayName: "Other", password: "password123" });
    store.touchConversation(owner.id, "cross-conv", otherAvatar.id, "ignored");

    const ownConvs = store
      .listConversations(owner.id)
      .filter((c) => c.avatarUserId === owner.id);
    const maxOwn = ownConvs.map((c) => c.updatedAt).sort().at(-1)!;

    // The directory + search + single-row paths all surface that MAX, in agreement.
    const listed = store.listPublishedAvatars(owner.id).find((a) => a.id === owner.id);
    const searched = store.searchAvatars(owner.id, "").find((a) => a.id === owner.id);
    const detail = store.getAvatar(owner.id, owner.id);
    expect(listed?.updatedAt).toBe(maxOwn);
    expect(searched?.updatedAt).toBe(maxOwn);
    // Single-row path uses the avatarUpdatedAt fallback — must match the subquery paths.
    expect(detail?.updatedAt).toBe(maxOwn);
    expect(detail?.updatedAt).toBe(listed?.updatedAt);

    // Re-touching one own-avatar conversation advances MAX in lockstep across paths.
    store.touchConversation(owner.id, "own-conv-1", owner.id, "first");
    const bumped = store
      .listConversations(owner.id)
      .filter((c) => c.avatarUserId === owner.id)
      .map((c) => c.updatedAt)
      .sort()
      .at(-1)!;
    expect(store.listPublishedAvatars(owner.id).find((a) => a.id === owner.id)?.updatedAt).toBe(bumped);
    expect(store.getAvatar(owner.id, owner.id)?.updatedAt).toBe(bumped);
  });
});


describe("store avatar visibility scope parity (shared VISIBILITY_WHERE)", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const subject = store.createUser({ username: "subject", displayName: "주제", password: "password123" });
    const teammate = store.createUser({ username: "teammate", displayName: "Teammate", password: "password123" });
    const stranger = store.createUser({ username: "stranger", displayName: "Stranger", password: "password123" });
    return { store, subjectId: subject.id, teammateId: teammate.id, strangerId: stranger.id };
  }

  it("a group-visible avatar reaches a co-member but not a stranger, consistently across list + search", () => {
    const { store, subjectId, teammateId, strangerId } = makeStore("vis-parity");
    // subject keeps the default `group` visibility, with a hashtag so search can match.
    store.updateProfile(subjectId, { hashtags: ["쿠버네티스"] });

    // Before any shared group: invisible to BOTH viewers via list AND search.
    expect(store.listPublishedAvatars(teammateId).some((a) => a.id === subjectId)).toBe(false);
    expect(store.searchAvatars(teammateId, "쿠버네티스").some((a) => a.id === subjectId)).toBe(false);
    expect(store.listPublishedAvatars(strangerId).some((a) => a.id === subjectId)).toBe(false);
    expect(store.searchAvatars(strangerId, "쿠버네티스").some((a) => a.id === subjectId)).toBe(false);

    // Put subject + teammate in one group; stranger stays out.
    const group = store.createGroup({ name: "Platform" });
    store.addGroupMember(group.id, subjectId, "member");
    store.addGroupMember(group.id, teammateId, "member");

    // Teammate now sees the subject in BOTH the list and the matching search,
    // and the two surfaces agree on membership.
    const inList = store.listPublishedAvatars(teammateId).some((a) => a.id === subjectId);
    const inSearch = store.searchAvatars(teammateId, "쿠버네티스").some((a) => a.id === subjectId);
    expect(inList).toBe(true);
    expect(inSearch).toBe(true);
    expect(inSearch).toBe(inList);
    // The list surface also flags the group co-membership.
    expect(store.listPublishedAvatars(teammateId).find((a) => a.id === subjectId)?.sharesGroup).toBe(true);

    // The stranger still sees the subject in NEITHER surface — also in agreement.
    const strangerList = store.listPublishedAvatars(strangerId).some((a) => a.id === subjectId);
    const strangerSearch = store.searchAvatars(strangerId, "쿠버네티스").some((a) => a.id === subjectId);
    expect(strangerList).toBe(false);
    expect(strangerSearch).toBe(false);
    expect(strangerSearch).toBe(strangerList);
  });
});


describe("store visibility migration (retired `public` state)", () => {
  // Reach the raw SQLite handle to plant pre-migration rows and to read the
  // stored column back — asserting on getUserById alone would pass on
  // rowVisibility()'s defensive mapping even if migrateVisibility() never ran.
  type WithDb = {
    db: {
      prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): unknown;
      };
    };
  };
  const dbOf = (store: unknown): WithDb["db"] => (store as unknown as WithDb).db;
  const rawVisibility = (store: unknown, id: string) =>
    (dbOf(store).prepare("SELECT visibility FROM users WHERE id = ?").get(id) as {
      visibility: string | null;
    }).visibility;

  it("folds legacy 'public', NULL and '' rows into 'group' on reopen, leaving 'private' alone", () => {
    const dataDir = path.join(tempDir, "vis-migration");
    const open = () =>
      createServices({ dataDir, agentRuntime: "local", sessionSecret: "vis" }).store;

    const first = open();
    const legacy = first.createUser({ username: "legacypub", displayName: "Legacy Public", password: "password123" });
    const blank = first.createUser({ username: "blankvis", displayName: "Blank", password: "password123" });
    const empty = first.createUser({ username: "emptyvis", displayName: "Empty", password: "password123" });
    const secret = first.createUser({ username: "secretvis", displayName: "Secret", password: "password123" });
    const stranger = first.createUser({ username: "strangervis", displayName: "Stranger", password: "password123" });
    const teammate = first.createUser({ username: "teammatevis", displayName: "Teammate", password: "password123" });
    // A group that spans the migrated avatars + teammate, so we can prove the
    // migrated rows are reachable through the normal group path afterwards.
    const group = first.createGroup({ name: "Migrated", createdBy: null });
    for (const id of [teammate.id, legacy.id, blank.id, empty.id, secret.id]) {
      first.addGroupMember(group.id, id, "member");
    }
    // The fresh schema declares `visibility TEXT NOT NULL DEFAULT 'group'`, so a
    // NULL is only reachable on an EXISTING deployment, where the column was added
    // by addColumnIfMissing's nullable ALTER TABLE. Reproduce that exact shape:
    // drop the column and re-add it nullable, which is the state a pre-enum
    // deployment's DB is in the moment it first boots this build.
    dbOf(first).prepare("ALTER TABLE users DROP COLUMN visibility").run();
    dbOf(first).prepare("ALTER TABLE users ADD COLUMN visibility TEXT").run();
    // Plant the three pre-migration states the 2-state enum retired ('public',
    // NULL, ''), plus an explicit 'private' row that migration must never touch.
    dbOf(first).prepare("UPDATE users SET visibility = 'public' WHERE id = ?").run(legacy.id);
    dbOf(first).prepare("UPDATE users SET visibility = '' WHERE id = ?").run(empty.id);
    dbOf(first).prepare("UPDATE users SET visibility = 'private' WHERE id = ?").run(secret.id);
    expect(rawVisibility(first, legacy.id)).toBe("public");
    expect(rawVisibility(first, blank.id)).toBeNull();
    expect(rawVisibility(first, empty.id)).toBe("");
    first.close();

    // Reopen the SAME dataDir → migrate() runs migrateVisibility().
    const second = open();
    // The rows were REWRITTEN, not just normalized on read.
    expect(rawVisibility(second, legacy.id)).toBe("group");
    expect(rawVisibility(second, blank.id)).toBe("group");
    expect(rawVisibility(second, empty.id)).toBe("group");
    expect(rawVisibility(second, secret.id)).toBe("private");
    expect(second.getUserById(legacy.id)?.visibility).toBe("group");
    expect(second.getUserById(blank.id)?.visibility).toBe("group");
    expect(second.getUserById(empty.id)?.visibility).toBe("group");
    expect(second.getUserById(secret.id)?.visibility).toBe("private");

    // Folding into 'group' is not a privacy regression: a stranger who shares no
    // group still cannot reach any migrated avatar.
    for (const id of [legacy.id, blank.id, empty.id, secret.id]) {
      expect(second.getAvatar(stranger.id, id)).toBeNull();
      expect(second.resolveChatAvatar(stranger.id, id)).toBeNull();
      expect(second.listPublishedAvatars(stranger.id).some((a) => a.id === id)).toBe(false);
    }
    // …and the migrated rows now match the SQL `visibility = 'group'` predicate,
    // so a co-member reaches them (a literal 'public'/NULL row would NOT have).
    expect(second.getAvatar(teammate.id, legacy.id)?.id).toBe(legacy.id);
    expect(second.getAvatar(teammate.id, blank.id)?.id).toBe(blank.id);
    expect(second.getAvatar(teammate.id, empty.id)?.id).toBe(empty.id);
    expect(second.listPublishedAvatars(teammate.id).map((a) => a.id).sort()).toEqual(
      [teammate.id, legacy.id, blank.id, empty.id].sort(),
    );
    // 'private' stays owner-only even for a co-member.
    expect(second.getAvatar(teammate.id, secret.id)).toBeNull();
    second.close();

    // Idempotent: a third open changes nothing.
    const third = open();
    expect(rawVisibility(third, legacy.id)).toBe("group");
    expect(rawVisibility(third, secret.id)).toBe("private");
    third.close();
  });
});


describe("store renameConversation single-row summary", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "rcowner", displayName: "RC Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("returns a summary with the new title that equals the matching listConversations entry", () => {
    const { store, ownerId } = makeStore("rc-title");
    const avatar = store.createUser({ username: "rcavatar", displayName: "RC Avatar", password: "password123" });
    store.touchConversation(ownerId, "rc-1", avatar.id, "original");

    const renamed = store.renameConversation(ownerId, "rc-1", "  새 제목  ");
    expect(renamed?.title).toBe("새 제목");
    expect(renamed?.isRoutine).toBe(false);
    expect(renamed?.routineId).toBeNull();
    expect(renamed?.avatarDisplayName).toBe("RC Avatar");

    // The single-row summary must be identical to the entry the list scan produces.
    const fromList = store.listConversations(ownerId).find((c) => c.id === "rc-1");
    expect(renamed).toEqual(fromList);

    // Blank title falls back to the default "새 대화".
    const blanked = store.renameConversation(ownerId, "rc-1", "   ");
    expect(blanked?.title).toBe("새 대화");
  });

  it("sets isRoutine + routineId from the joined routine_jobs row for a routine-backed conversation", () => {
    const { store, ownerId } = makeStore("rc-routine");
    const job = store.createRoutineJob(ownerId, { prompt: "매일 요약", minuteOfDay: 540 });

    const renamed = store.renameConversation(ownerId, job.conversationId, "루틴 새 이름");
    expect(renamed?.title).toBe("루틴 새 이름");
    expect(renamed?.isRoutine).toBe(true);
    expect(renamed?.routineId).toBe(job.id);
    expect(renamed?.routinePrompt).toBe("매일 요약");

    // Equals the matching entry from the routine list (same join, single-row vs scan).
    const fromList = store
      .listConversations(ownerId, undefined, "routine")
      .find((c) => c.id === job.conversationId);
    expect(renamed).toEqual(fromList);
  });

  it("falls back to the Korean '(삭제된 아바타)' label when the target avatar was removed", () => {
    const { store, ownerId } = makeStore("rc-deleted");
    const avatar = store.createUser({ username: "rcgone", displayName: "Gone", password: "password123" });
    store.touchConversation(ownerId, "rc-del", avatar.id, "hi");
    expect(store.deleteUser(avatar.id)).toBe(true);
    // The owner's conversation survives (deleteUser only drops conversations the
    // deleted user OWNS or where they're the avatar — this one targets them, so
    // it is removed; recreate one targeting a since-deleted avatar id instead).
    store.touchConversation(ownerId, "rc-del2", avatar.id, "hi again");

    const renamed = store.renameConversation(ownerId, "rc-del2", "고아 대화");
    expect(renamed?.title).toBe("고아 대화");
    expect(renamed?.avatarDisplayName).toBe("(삭제된 아바타)");
    expect(renamed).toEqual(store.listConversations(ownerId).find((c) => c.id === "rc-del2"));
  });

  it("is owner-scoped: renaming a conversation you don't own returns null", () => {
    const { store, ownerId } = makeStore("rc-scope");
    store.touchConversation(ownerId, "rc-mine", ownerId, "mine");
    const other = store.createUser({ username: "rcother", displayName: "Other", password: "password123" });
    expect(store.renameConversation(other.id, "rc-mine", "stolen")).toBeNull();
    expect(store.listConversations(ownerId).find((c) => c.id === "rc-mine")?.title).toBe("mine");
  });
});


describe("store addAvatarNotification keyed single-row return", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "anowner", displayName: "AN Owner", password: "password123" });
    const avatar = store.createUser({ username: "anavatar", displayName: "AN Avatar", password: "password123" });
    return { store, ownerId: owner.id, avatarId: avatar.id };
  }

  it("returns the inserted row with the right fields AND the joined avatar display name", () => {
    const { store, ownerId, avatarId } = makeStore("an-fields");
    const created = store.addAvatarNotification(ownerId, {
      avatarUserId: avatarId,
      title: "알림 제목",
      message: "  본문 내용  ",
      conversationId: "conv-an",
    });

    expect(created.ownerUserId).toBe(ownerId);
    expect(created.avatarUserId).toBe(avatarId);
    expect(created.title).toBe("알림 제목");
    // message is trimmed on insert.
    expect(created.message).toBe("본문 내용");
    expect(created.conversationId).toBe("conv-an");
    expect(created.readAt).toBeNull();
    // The LEFT JOIN alias must be populated, not the deleted-avatar fallback.
    expect(created.avatarDisplayName).toBe("AN Avatar");

    // The keyed single-row return must equal what the list query produces for the same id.
    const fromList = store.listAvatarNotifications(ownerId).find((n) => n.id === created.id);
    expect(created).toEqual(fromList);
  });

  it("defaults a blank title to the Korean fallback and still resolves the display name", () => {
    const { store, ownerId, avatarId } = makeStore("an-title");
    const created = store.addAvatarNotification(ownerId, {
      avatarUserId: avatarId,
      title: "   ",
      message: "내용",
    });
    expect(created.title).toBe("아바타 알림");
    expect(created.avatarDisplayName).toBe("AN Avatar");
    expect(created.conversationId).toBeNull();
    expect(created).toEqual(store.listAvatarNotifications(ownerId).find((n) => n.id === created.id));
  });
});


describe("store deleteUser canvas cascade (no orphans)", () => {
  // Reach the raw better-sqlite3 handle to assert no canvas rows survive, mirroring
  // the dbOf() pattern used by the canvas backfill tests above.
  type WithDb = { db: { prepare(sql: string): { get(...a: unknown[]): unknown } } };
  const dbOf = (store: unknown): WithDb["db"] => (store as unknown as WithDb).db;
  const countRows = (store: unknown, sql: string, ...params: unknown[]): number =>
    (dbOf(store).prepare(sql).get(...params) as { n: number }).n;

  it("removes canvas_artifacts AND canvas_versions for the deleted owner, leaving no orphans", () => {
    const { store } = createServices({
      dataDir: path.join(tempDir, "del-canvas"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "delowner", displayName: "Del Owner", password: "password123" });
    const avatar = store.createUser({ username: "delavatar", displayName: "Del Avatar", password: "password123" });
    store.touchConversation(owner.id, "conv-del-1", avatar.id, "hi");
    store.touchConversation(owner.id, "conv-del-2", avatar.id, "hi2");

    // Seed two artifacts; refine one so it carries multiple versions.
    store.upsertCanvasArtifact(owner.id, "conv-del-1", { artifactId: "art-1", title: "T", content: "v1", contentType: "markdown" });
    store.upsertCanvasArtifact(owner.id, "conv-del-1", { artifactId: "art-1", title: "T", content: "v2", contentType: "markdown" });
    store.upsertCanvasArtifact(owner.id, "conv-del-2", { artifactId: "art-2", title: "T2", content: "x", contentType: "markdown" });

    // Sanity: rows exist before deletion (1 artifact w/ 2 versions + 1 artifact w/ 1 version).
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_artifacts WHERE owner_user_id = ?", owner.id)).toBe(2);
    expect(
      countRows(
        store,
        "SELECT COUNT(*) AS n FROM canvas_versions WHERE artifact_id IN (SELECT id FROM canvas_artifacts WHERE owner_user_id = ?)",
        owner.id,
      ),
    ).toBe(3);
    // Capture the version artifact_ids so we can prove no orphan versions remain after delete.
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_versions WHERE artifact_id IN ('art-1','art-2')")).toBe(3);

    expect(store.deleteUser(owner.id)).toBe(true);

    // Both tables fully cleared for this owner — and no version rows left dangling
    // for the now-deleted artifact ids.
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_artifacts WHERE owner_user_id = ?", owner.id)).toBe(0);
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_versions WHERE artifact_id IN ('art-1','art-2')")).toBe(0);
    // Whole-table guard: no canvas rows remain at all in this single-owner DB.
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_artifacts")).toBe(0);
    expect(countRows(store, "SELECT COUNT(*) AS n FROM canvas_versions")).toBe(0);
  });
});

describe("store adminPresence (admin rail badge)", () => {
  // last_seen_at is normally stamped by getUserBySessionToken; poke it directly
  // so the window boundary is testable without faking clocks.
  type WithDb = { db: { prepare(sql: string): { run(...params: unknown[]): unknown } } };
  const seenAgo = (store: unknown, userId: string, minutesAgo: number): void => {
    (store as unknown as WithDb).db
      .prepare("UPDATE users SET last_seen_at = ? WHERE id = ?")
      .run(new Date(Date.now() - minutesAgo * 60_000).toISOString(), userId);
  };

  function makeStore(dir: string) {
    return createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "presence",
    }).store;
  }

  // Straddle the hour boundary with a minute of slack on each side, so the
  // assertion pins PRESENCE_WINDOW_MS rather than merely "some window".
  it("lists only users seen inside the window, freshest first", () => {
    const store = makeStore("presence-window");
    const here = store.createUser({ username: "here", displayName: "Here", password: "password123" });
    const edge = store.createUser({ username: "edge", displayName: "Edge", password: "password123" });
    const gone = store.createUser({ username: "gone", displayName: "Gone", password: "password123" });
    seenAgo(store, here.id, 0);
    seenAgo(store, edge.id, 59);
    seenAgo(store, gone.id, 61);

    const presence = store.adminPresence();
    expect(presence.windowMinutes).toBe(60);
    expect(presence.users.map((u) => u.username)).toEqual(["here", "edge"]);
    expect(presence.users[0].displayName).toBe("Here");
    expect(presence.users[0].hasImage).toBe(false);
  });

  it("excludes suspended accounts even with a fresh stamp", () => {
    const store = makeStore("presence-suspended");
    const admin = store.createUser({ username: "boss", displayName: "Boss", password: "password123" });
    const banned = store.createUser({ username: "banned", displayName: "Banned", password: "password123" });
    seenAgo(store, admin.id, 0);
    seenAgo(store, banned.id, 0);
    store.setSuspended(banned.id, true);

    expect(store.adminPresence().users.map((u) => u.username)).toEqual(["boss"]);
  });

  it("omits users who have never been seen", () => {
    const store = makeStore("presence-never");
    const user = store.createUser({ username: "fresh", displayName: "Fresh", password: "password123" });
    (store as unknown as WithDb).db
      .prepare("UPDATE users SET last_seen_at = NULL WHERE id = ?")
      .run(user.id);

    expect(store.adminPresence().users).toEqual([]);
  });
});
