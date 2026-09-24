import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createServices, expandChatSlashCommand } from "../src/server/app.js";
import { createAppServer } from "../src/server/appServer.js";
import {
  BROWSER_EXTENSION_MIN_COMPATIBLE,
  browserExtensionId,
  browserExtensionOrigins,
  browserExtensionVersion,
  buildBrowserExtensionZip,
  listBrowserExtensionFiles,
  matchPatternForOrigin,
  BROWSER_EXTENSION_DIR,
} from "../src/server/browserExtensionBundle.js";
import {
  extensionIdFromPublicKey,
  manifestKeyFromPrivateKey,
} from "../src/server/browserExtensionUpdate.js";
import { buildUpdatesXml, packCrx3 } from "../src/server/browserExtensionCrx.js";
import { loadConfig } from "../src/server/config.js";
import { applyCustomGithubCa } from "../src/server/tlsCa.js";
import { loadDotEnv } from "../src/server/loadEnv.js";
import { createRateLimiter } from "../src/server/rateLimit.js";
import {
  buildKnowledgeTools,
  KNOWLEDGE_SERVER_NAME,
  KNOWLEDGE_TOOL_NAMES,
  type KnowledgeToolsContext,
} from "../src/server/agent/knowledgeTools.js";
import { normalizeHashtags } from "../src/server/store.js";
import { MODEL_TIERS, MODEL_TIER_IDS, isModelTier } from "../src/server/modelTiers.js";
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
  isInternalGitSource,
  tokenForGitUrl,
} from "../src/server/gitCredentials.js";
import { assertSafeGitValue } from "../src/server/repoGitGuards.js";
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
  buildPreToolUseHook,
  buildPrompt,
  deriveAgentToolAccess,
  interpretResult,
  resultErrorMessage,
  sshMcpSecretEnv,
} from "../src/server/agent/claudeAgent.js";
import { executeRoutineJob } from "../src/server/scheduler.js";
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
import { buildKnowledgeGraph, isVaultNotePath } from "../src/server/knowledgeGraph.js";
import { rankBrainNotes } from "../src/server/agent/brainSearch.js";
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
import { generateSshKeyPair, deriveSshPublicKey } from "../src/server/sshIdentity.js";
import { workspaceDirFor } from "../src/server/workspace.js";
import type { AppConfig, Plugin } from "../src/server/types.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../src/server/hexSshPolicy.js";

import { callTool } from "./helpers.js";

let tempDir: string;
const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-units-"));
  process.env.NODE_ENV = originalNodeEnv;
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});


describe("routine run timeout config", () => {
  function withEnv(value: string | undefined, fn: () => void) {
    const saved = process.env.ROUTINE_RUN_TIMEOUT_MINUTES;
    try {
      if (value === undefined) delete process.env.ROUTINE_RUN_TIMEOUT_MINUTES;
      else process.env.ROUTINE_RUN_TIMEOUT_MINUTES = value;
      fn();
    } finally {
      if (saved === undefined) delete process.env.ROUTINE_RUN_TIMEOUT_MINUTES;
      else process.env.ROUTINE_RUN_TIMEOUT_MINUTES = saved;
    }
  }

  const load = () => loadConfig({ dataDir: tempDir, sessionSecret: "test" }).routineRunTimeoutMs;

  it("defaults to 30 minutes", () => {
    withEnv(undefined, () => expect(load()).toBe(30 * 60_000));
  });

  it("takes ROUTINE_RUN_TIMEOUT_MINUTES when set", () => {
    withEnv("90", () => expect(load()).toBe(90 * 60_000));
  });

  it("clamps to a 1-minute floor so the deadline can never abort runs instantly", () => {
    // "0" disables the plugin-refresh interval, but here it would mean a 0ms deadline
    // that kills every run before it starts — the deadline is deliberately not disablable.
    withEnv("0", () => expect(load()).toBe(60_000));
    withEnv("-5", () => expect(load()).toBe(30 * 60_000));
  });

  it("falls back to the default on a non-numeric value", () => {
    withEnv("soon", () => expect(load()).toBe(30 * 60_000));
  });
});

/** Set (or, with `undefined`, unset) several env vars around `fn`, then restore them. */
function withEnvVars(values: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    apply(values);
    fn();
  } finally {
    apply(saved);
  }
}

describe("avatar task API run timeout config", () => {
  const withEnv = withEnvVars;
  const load = () => loadConfig({ dataDir: tempDir, sessionSecret: "test" });
  const unset = { AVATAR_TASK_TIMEOUT_MINUTES: undefined, BOT_TASK_TIMEOUT_MINUTES: undefined };

  it("defaults to 5 hours while bot tasks keep 30 minutes", () => {
    withEnv(unset, () => {
      expect(load().avatarTaskRunTimeoutMs).toBe(300 * 60_000);
      expect(load().botTaskRunTimeoutMs).toBe(30 * 60_000);
    });
  });

  it("takes AVATAR_TASK_TIMEOUT_MINUTES when set, independent of BOT_TASK_TIMEOUT_MINUTES", () => {
    withEnv({ ...unset, AVATAR_TASK_TIMEOUT_MINUTES: "90" }, () => {
      expect(load().avatarTaskRunTimeoutMs).toBe(90 * 60_000);
      expect(load().botTaskRunTimeoutMs).toBe(30 * 60_000);
    });
    withEnv({ ...unset, BOT_TASK_TIMEOUT_MINUTES: "7" }, () => {
      expect(load().avatarTaskRunTimeoutMs).toBe(300 * 60_000);
      expect(load().botTaskRunTimeoutMs).toBe(7 * 60_000);
    });
  });

  it("clamps to a 1-minute floor and falls back to the default on junk", () => {
    withEnv({ ...unset, AVATAR_TASK_TIMEOUT_MINUTES: "0" }, () => expect(load().avatarTaskRunTimeoutMs).toBe(60_000));
    withEnv({ ...unset, AVATAR_TASK_TIMEOUT_MINUTES: "-5" }, () => expect(load().avatarTaskRunTimeoutMs).toBe(300 * 60_000));
    withEnv({ ...unset, AVATAR_TASK_TIMEOUT_MINUTES: "soon" }, () => expect(load().avatarTaskRunTimeoutMs).toBe(300 * 60_000));
  });

  it("caps at setTimeout's maximum so a huge value can't abort every run after 1 ms", () => {
    withEnv({ ...unset, AVATAR_TASK_TIMEOUT_MINUTES: "100000" }, () =>
      expect(load().avatarTaskRunTimeoutMs).toBe(2_147_483_647),
    );
  });
});

describe("routine concurrency config", () => {
  const load = () => loadConfig({ dataDir: tempDir, sessionSecret: "test" });
  const unset = { ROUTINE_MAX_CONCURRENT_RUNS: undefined, ROUTINE_MAX_CONCURRENT_RUNS_PER_USER: undefined };

  it("defaults to 10 routines server-wide and 2 per owner", () => {
    withEnvVars(unset, () => {
      expect(load().routineMaxConcurrentRuns).toBe(10);
      expect(load().routineMaxConcurrentRunsPerUser).toBe(2);
    });
  });

  it("takes both env values when set", () => {
    withEnvVars({ ROUTINE_MAX_CONCURRENT_RUNS: "4", ROUTINE_MAX_CONCURRENT_RUNS_PER_USER: "1" }, () => {
      expect(load().routineMaxConcurrentRuns).toBe(4);
      expect(load().routineMaxConcurrentRunsPerUser).toBe(1);
    });
  });

  it("falls back to the default on anything but a whole number >= 1", () => {
    for (const junk of ["0", "-3", "2.5", "many"]) {
      withEnvVars({ ROUTINE_MAX_CONCURRENT_RUNS: junk, ROUTINE_MAX_CONCURRENT_RUNS_PER_USER: junk }, () => {
        expect(load().routineMaxConcurrentRuns).toBe(10);
        expect(load().routineMaxConcurrentRunsPerUser).toBe(2);
      });
    }
  });
});

describe("model tiers", () => {
  it("registers the fable/opus/sonnet/haiku aliases with user-facing labels", () => {
    expect(MODEL_TIER_IDS).toEqual(["fable", "opus", "sonnet", "haiku"]);
    for (const tier of MODEL_TIERS) {
      expect(tier.label.trim()).not.toBe("");
      expect(tier.description.trim()).not.toBe("");
    }
  });

  it("maps each tier to its ANTHROPIC_DEFAULT_<TIER>_MODEL env (omits unset)", () => {
    const keys = [
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ];
    const saved = keys.map((k) => process.env[k]);
    try {
      process.env.ANTHROPIC_DEFAULT_FABLE_MODEL = "claude-fable-5";
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-4-8";
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6";
      delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      const config = loadConfig({ dataDir: tempDir, sessionSecret: "test" });
      expect(config.defaultTierModels).toEqual({
        fable: "claude-fable-5",
        opus: "claude-opus-4-8",
        sonnet: "claude-sonnet-4-6",
      });
      // Unset tier (haiku) is omitted — the app can't name the SDK's account default.
      expect(config.defaultTierModels.haiku).toBeUndefined();
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  it("isModelTier accepts only known aliases", () => {
    expect(isModelTier("fable")).toBe(true);
    expect(isModelTier("opus")).toBe(true);
    expect(isModelTier("sonnet")).toBe(true);
    expect(isModelTier("haiku")).toBe(true);
    // Full model ids, empty, garbage, and non-strings are rejected — the chat
    // route falls those back to the server default so they never reach the SDK.
    expect(isModelTier("claude-opus-4-8")).toBe(false);
    expect(isModelTier("")).toBe(false);
    expect(isModelTier("gpt-4")).toBe(false);
    expect(isModelTier(undefined)).toBe(false);
    expect(isModelTier(null)).toBe(false);
    expect(isModelTier(42)).toBe(false);
  });
});

describe("rate limiter", () => {
  function makeResponse() {
    const headers = new Map<string, string>();
    const res = {
      setHeader: vi.fn((name: string, value: string | number) => {
        headers.set(name, String(value));
      }),
      status: vi.fn(function status(this: Response, _code: number) {
        return this;
      }),
      json: vi.fn(function json(this: Response, _body: unknown) {
        return this;
      }),
    } as unknown as Response & {
      setHeader: ReturnType<typeof vi.fn>;
      status: ReturnType<typeof vi.fn>;
      json: ReturnType<typeof vi.fn>;
    };
    return { res, headers };
  }

  function runLimiter(
    limiter: ReturnType<typeof createRateLimiter>,
    key: string,
  ): { headers: Map<string, string>; next: ReturnType<typeof vi.fn>; res: ReturnType<typeof makeResponse>["res"] } {
    const { res, headers } = makeResponse();
    const req = { testKey: key } as unknown as Request & { testKey: string };
    const next = vi.fn() as NextFunction & ReturnType<typeof vi.fn>;
    limiter(req, res, next);
    return { headers, next, res };
  }

  it("bypasses checks in test mode", () => {
    process.env.NODE_ENV = "test";
    const limiter = createRateLimiter({
      windowMs: 1_000,
      max: 0,
      keyFn: () => {
        throw new Error("keyFn should not run in test mode");
      },
    });

    const { next, res } = runLimiter(limiter, "ignored");

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows requests up to the fixed-window limit and then returns 429", () => {
    process.env.NODE_ENV = "production";
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const limiter = createRateLimiter({
      windowMs: 5_000,
      max: 2,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
      message: "slow down",
    });

    expect(runLimiter(limiter, "same").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "same").next).toHaveBeenCalledTimes(1);
    const blocked = runLimiter(limiter, "same");

    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(429);
    expect(blocked.res.json).toHaveBeenCalledWith({ error: "slow down" });
    expect(blocked.headers.get("Retry-After")).toBe("5");
  });

  it("starts a fresh bucket after expiry and keeps keys independent", () => {
    process.env.NODE_ENV = "production";
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const limiter = createRateLimiter({
      windowMs: 1_000,
      max: 1,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
    });

    expect(runLimiter(limiter, "a").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "b").next).toHaveBeenCalledTimes(1);
    expect(runLimiter(limiter, "a").res.status).toHaveBeenCalledWith(429);

    now.mockReturnValue(11_000);
    const reset = runLimiter(limiter, "a");

    expect(reset.next).toHaveBeenCalledTimes(1);
    expect(reset.res.status).not.toHaveBeenCalled();
  });

  it("prunes expired buckets once many keys have accumulated", () => {
    process.env.NODE_ENV = "production";
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const limiter = createRateLimiter({
      windowMs: 1,
      max: 1,
      keyFn: (req) => (req as Request & { testKey: string }).testKey,
    });

    for (let i = 0; i < 5_001; i += 1) {
      expect(runLimiter(limiter, `key-${i}`).next).toHaveBeenCalledTimes(1);
    }

    now.mockReturnValue(20_002);
    const afterPrune = runLimiter(limiter, "fresh");

    expect(afterPrune.next).toHaveBeenCalledTimes(1);
    expect(afterPrune.res.status).not.toHaveBeenCalled();
  });
});


describe("sshTrust", () => {
  // A real ed25519 public key blob (base64), so the fingerprint is deterministic.
  const KEY =
    "AAAAC3NzaC1lZDI1NTE5AAAAIE3Q5Z7dQ2bqf3pVnE0Yk1m2sJ8t4hX9aBcDeFgHiJk";
  const line = (host: string, key = KEY) => `${host} ssh-ed25519 ${key}`;

  function makeStore() {
    const { store, config } = createServices({
      dataDir: path.join(tempDir, "ssht"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const owner = store.createUser({ username: "o", displayName: "O", password: "password123" });
    return { config, ownerId: owner.id };
  }

  it("derives a per-user known_hosts path under the data volume", () => {
    const { config, ownerId } = makeStore();
    const p = knownHostsPath(ownerId, config);
    expect(p.startsWith(path.join(config.dataDir, "ssh"))).toBe(true);
    expect(p.endsWith("known_hosts")).toBe(true);
  });

  it("parses known_hosts into host/type/fingerprint and computes SHA256: form", () => {
    const entries = parseKnownHosts(`# comment\n${line("1.2.3.4")}\n\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0].host).toBe("1.2.3.4");
    expect(entries[0].keyType).toBe("ssh-ed25519");
    expect(entries[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(entries[0].fingerprint).not.toMatch(/=$/); // unpadded
  });

  it("TS fingerprint format agrees with the embedded-python (paramiko) form", () => {
    // The TS `fingerprintOf` (exercised via parseKnownHosts) and `fetchHostKey`'s
    // embedded paramiko script must compute the SAME SHA256: form, or trusting a
    // host via add_host would store a fingerprint hex-ssh can never match. Drive
    // BOTH off one valid key blob and assert they agree — guards a silent drift.
    const validKeyBase64 = "bm9haC1hbG1pZ2h0eS1zc2gtdHJ1c3QtZmluZ2VycHJpbnQtYWdyZWVtZW50LWZpeHR1cmU=";
    const tsFingerprint = parseKnownHosts(line("h.example", validKeyBase64))[0].fingerprint;
    // The exact expression fetchHostKey runs (sshTrust.ts), fed the same raw bytes.
    const pyFingerprint = execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys, base64, hashlib",
          "raw = base64.b64decode(sys.argv[1])",
          'print("SHA256:" + base64.b64encode(hashlib.sha256(raw).digest()).decode().rstrip("="))',
        ].join("\n"),
        validKeyBase64,
      ],
      { encoding: "utf8" },
    ).trim();
    expect(tsFingerprint).toBe(pyFingerprint);
  });

  it("expands comma-separated host fields and skips @markers/short lines", () => {
    const entries = parseKnownHosts(
      `${line("a,b")}\n@revoked ${line("c").replace("c ", "")}\nbroken line\n`,
    );
    const hosts = entries.map((e) => e.host).sort();
    expect(hosts).toContain("a");
    expect(hosts).toContain("b");
  });

  it("upsertHostLine appends a new host and reports changed", () => {
    const r = upsertHostLine("", line("1.1.1.1"));
    expect(r.changed).toBe(true);
    expect(r.body.trim()).toBe(line("1.1.1.1"));
  });

  it("upsertHostLine is idempotent for an identical line", () => {
    const r = upsertHostLine(`${line("1.1.1.1")}\n`, line("1.1.1.1"));
    expect(r.changed).toBe(false);
    expect(r.body.trim()).toBe(line("1.1.1.1"));
  });

  it("upsertHostLine replaces a rotated key for the same host+type", () => {
    const r = upsertHostLine(`${line("1.1.1.1", "OLDKEY")}\n`, line("1.1.1.1", "NEWKEY"));
    expect(r.changed).toBe(true);
    expect(r.body).toContain("NEWKEY");
    expect(r.body).not.toContain("OLDKEY");
  });

  it("lists and removes hosts from the on-disk file", async () => {
    const { config, ownerId } = makeStore();
    const file = knownHostsPath(ownerId, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line("9.9.9.9")}\n${line("8.8.8.8")}\n`);

    const before = await listTrustedHosts(ownerId, config);
    expect(before.map((e) => e.host).sort()).toEqual(["8.8.8.8", "9.9.9.9"]);

    const removed = await removeTrustedHost(ownerId, config, "9.9.9.9");
    expect(removed).toBe(1);
    const after = await listTrustedHosts(ownerId, config);
    expect(after.map((e) => e.host)).toEqual(["8.8.8.8"]);
  });

  it("listTrustedHosts is empty when no file exists", async () => {
    const { config, ownerId } = makeStore();
    expect(await listTrustedHosts(ownerId, config)).toEqual([]);
  });

  it("trust tools: list reports empty, then reflects the file", async () => {
    const { config, ownerId } = makeStore();
    const tools = buildSshTrustTools({ avatarUserId: ownerId, config });

    expect(SSH_TRUST_SERVER_NAME).toBe("ssh_trust");
    expect(SSH_TRUST_TOOL_NAMES).toContain("mcp__ssh_trust__add_host");

    const empty = await callTool(tools, "list_hosts", {});
    expect(empty.content[0].text).toContain("No trusted hosts");

    const file = knownHostsPath(ownerId, config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${line("5.5.5.5")}\n`);
    const listed = await callTool(tools, "list_hosts", {});
    expect(listed.content[0].text).toContain("5.5.5.5");

    const gone = await callTool(tools, "remove_host", { host: "5.5.5.5" });
    expect(gone.content[0].text).toContain("Removed");
  });
});


describe("ssh identity", () => {
  function makeStore() {
    const { store } = createServices({
      dataDir: path.join(tempDir, "ssh-identity"),
      agentRuntime: "local",
      sessionSecret: "shh",
    });
    const owner = store.createUser({ username: "sshowner", displayName: "Owner", password: "password123" });
    return { store, owner };
  }

  it("generates OpenSSH private key material and a reusable public key", async () => {
    const pair = await generateSshKeyPair("avatar-chat-test");
    expect(pair.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ avatar-chat-test$/);
    expect(pair.fingerprint).toMatch(/^SHA256:/);
  });

  it("derives the same public key/fingerprint back from a private key, and rejects junk", async () => {
    const pair = await generateSshKeyPair("derive-test");
    const derived = await deriveSshPublicKey(pair.privateKey, "derive-test");
    expect(derived).not.toBeNull();
    // Same key material (blob) and fingerprint as generation produced.
    expect(derived!.publicKey.split(" ").slice(0, 2).join(" ")).toBe(
      pair.publicKey.split(" ").slice(0, 2).join(" "),
    );
    expect(derived!.fingerprint).toBe(pair.fingerprint);
    // Unparseable input returns null rather than throwing, so the secret save survives.
    expect(await deriveSshPublicKey("not a private key", "x")).toBeNull();
  });

  it("tools generate a key, store only the public half on the user, and refuse overwrite", async () => {
    const { store, owner } = makeStore();
    const tools = buildSshIdentityTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      viewerIsOwner: true,
    });

    expect(SSH_IDENTITY_SERVER_NAME).toBe("ssh_identity");
    expect(SSH_IDENTITY_TOOL_NAMES).toContain("mcp__ssh_identity__generate_key");

    const generated = await callTool(tools, "generate_key", { comment: "avatar-chat-owner" });
    expect(generated.isError).toBeFalsy();
    expect(generated.content[0].text).toContain("Public key:");
    expect(generated.content[0].text).not.toContain("BEGIN OPENSSH PRIVATE KEY");

    const user = store.getUserById(owner.id)!;
    expect(user.secretNames).toEqual(["SSH_PRIVATE_KEY"]);
    expect(user.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(store.getUserSecrets(owner.id).SSH_PRIVATE_KEY).toContain("BEGIN OPENSSH PRIVATE KEY");

    const shown = await callTool(tools, "show_public_key", {});
    expect(shown.content[0].text).toContain(user.sshPublicKey!);

    const second = await callTool(tools, "generate_key", { comment: "again" });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("An SSH key is already configured");
  });

  it("refuses key management to non-owner viewers", async () => {
    const { store, owner } = makeStore();
    const tools = buildSshIdentityTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      viewerIsOwner: false,
    });

    const res = await callTool(tools, "generate_key", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("avatar owner is present");
    expect(store.listUserSecretNames(owner.id)).toEqual([]);
  });
});


describe("secret encryption", () => {
  const SECRET = "session-secret-key";

  it("round-trips a secret and authenticates it", () => {
    const enc = encryptSecret("ghp_token123", SECRET);
    expect(enc).not.toContain("ghp_token123");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc, SECRET)).toBe("ghp_token123");
  });

  it("produces a different ciphertext each time (random salt/iv)", () => {
    const a = encryptSecret("same", SECRET);
    const b = encryptSecret("same", SECRET);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, SECRET)).toBe("same");
    expect(decryptSecret(b, SECRET)).toBe("same");
  });

  it("fails closed on the wrong key, tampering, or garbage", () => {
    const enc = encryptSecret("secret", SECRET);
    expect(decryptSecret(enc, "wrong-key")).toBeNull();
    // Tamper with the ciphertext segment — the GCM tag must reject it.
    const parts = enc.split(":");
    const data = Buffer.from(parts[4], "base64url");
    data[0] ^= 0xff;
    parts[4] = data.toString("base64url");
    expect(decryptSecret(parts.join(":"), SECRET)).toBeNull();
    expect(decryptSecret("not-a-token", SECRET)).toBeNull();
    expect(decryptSecret("", SECRET)).toBeNull();
  });
});


// The source/host POLICY gate for the knowledge + group knowledge repo entry
// points. It must fail CLOSED: it used to return true whenever it could not parse
// a host, which admitted bare filesystem paths and `scheme::` remote-helper
// syntax past the one check meant to require the internal host.
describe("isInternalGitSource (source/host policy)", () => {
  const HOST = "github.enterprise.local";

  it("accepts owner/repo shorthand (resolved against the internal host)", () => {
    expect(isInternalGitSource("owner/knowledge", HOST)).toBe(true);
    expect(isInternalGitSource("  owner/knowledge  ", HOST)).toBe(true);
  });

  it("accepts explicit remotes on the internal host", () => {
    expect(isInternalGitSource(`https://${HOST}/owner/kb.git`, HOST)).toBe(true);
    expect(isInternalGitSource(`git@${HOST}:owner/kb.git`, HOST)).toBe(true);
  });

  it("rejects remotes on any other host", () => {
    expect(isInternalGitSource("https://github.com/owner/kb.git", HOST)).toBe(false);
    expect(isInternalGitSource("git@evil.example:owner/kb.git", HOST)).toBe(false);
  });

  it("fails CLOSED on sources with no parseable host", () => {
    // Absolute paths — the cross-user disclosure vector. Each ends in `.git`, so
    // `looksLikeRepo` accepts them and this is the only gate left.
    expect(isInternalGitSource("/data/knowledge/other-user-id/.git", HOST)).toBe(false);
    expect(isInternalGitSource("/data/group-knowledge/some-group/.git", HOST)).toBe(false);
    expect(isInternalGitSource("./relative/path.git", HOST)).toBe(false);
    // Remote-helper syntax (command execution if it reaches git).
    expect(isInternalGitSource("ext::sh -c evil .git", HOST)).toBe(false);
    expect(isInternalGitSource("fd::7 .git", HOST)).toBe(false);
  });
});

// ONE arg-safety validator shared by every clone path (knowledge, group
// knowledge, registered git repos, plugins). Deliberately transport-agnostic:
// a bare local path is a legitimate repo source, so host policy is NOT its job.
describe("assertSafeGitValue (shared clone arg guard)", () => {
  it("passes benign values, including local paths", () => {
    for (const ok of [
      "owner/repo",
      "https://github.enterprise.local/owner/repo.git",
      "git@github.enterprise.local:owner/repo.git",
      "/tmp/some/bare-remote.git",
      "main",
      null,
      undefined,
    ]) {
      expect(() => assertSafeGitValue(ok, "repo")).not.toThrow();
    }
  });

  it("rejects values git would read as an option", () => {
    expect(() => assertSafeGitValue("-oProxyCommand=evil", "repo")).toThrow(
      /must not start with/,
    );
    expect(() => assertSafeGitValue("--upload-pack=evil", "repo")).toThrow(
      /must not start with/,
    );
  });

  it("rejects scheme:: remote-helper syntax regardless of git's own policy", () => {
    for (const bad of ["ext::sh -c evil", "EXT::sh -c evil", "fd::7", "::plain"]) {
      expect(() => assertSafeGitValue(bad, "repo")).toThrow(/remote-helper/);
    }
  });
});

describe("git token secret storage", () => {
  function makeStore(dir: string) {
    const { store } = createServices({
      dataDir: path.join(tempDir, dir),
      agentRuntime: "local",
      sessionSecret: "a-secret",
    });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    return { store, ownerId: owner.id };
  }

  it("stores the token encrypted and never leaks it through the User shape", () => {
    const { store, ownerId } = makeStore("gt1");
    const user = store.setGitToken(ownerId, "ghp_secretvalue");
    // The public User shape exposes only a boolean flag, never the token.
    expect(user.gitTokenSet).toBe(true);
    expect(JSON.stringify(user)).not.toContain("ghp_secretvalue");
    expect(JSON.stringify(store.getUserById(ownerId))).not.toContain("ghp_secretvalue");
    expect(user.secretNames).toContain(INTERNAL_GIT_TOKEN_SECRET_NAME);
    expect(store.getUserSecrets(ownerId)[INTERNAL_GIT_TOKEN_SECRET_NAME]).toBe("ghp_secretvalue");
    // Server-side decryption recovers the plaintext for git auth.
    expect(store.getGitToken(ownerId)).toBe("ghp_secretvalue");
  });

  it("clears the token", () => {
    const { store, ownerId } = makeStore("gt2");
    store.setGitToken(ownerId, "ghp_x");
    const cleared = store.setGitToken(ownerId, null);
    expect(cleared.gitTokenSet).toBe(false);
    expect(cleared.secretNames).not.toContain(INTERNAL_GIT_TOKEN_SECRET_NAME);
    expect(store.getGitToken(ownerId)).toBeNull();
  });

  it("stores the external github.com token as a separate user secret", () => {
    const { store, ownerId } = makeStore("gt-external");
    store.setUserSecret(ownerId, EXTERNAL_GIT_TOKEN_SECRET_NAME, "ghp_external");
    expect(store.getExternalGitToken(ownerId)).toBe("ghp_external");
    expect(store.getGitTokens(ownerId)).toMatchObject({
      internal: null,
      external: "ghp_external",
    });
    expect(store.getUserById(ownerId)!.secretNames).toContain(EXTERNAL_GIT_TOKEN_SECRET_NAME);
  });

  it("persists identity and knowledge repo settings", () => {
    const { store, ownerId } = makeStore("gt3");
    const u1 = store.setGitIdentity(ownerId, "Avatar Bot", "bot@example.com");
    expect(u1.gitIdentityName).toBe("Avatar Bot");
    expect(u1.gitIdentityEmail).toBe("bot@example.com");
    const u2 = store.setKnowledgeRepo(ownerId, "me/knowledge", "main");
    expect(u2.knowledgeRepo).toBe("me/knowledge");
    expect(u2.knowledgeBranch).toBe("main");
    expect(u2.knowledgeSelected).toBeNull();
    expect(store.getKnowledgeRepo(ownerId)).toEqual({ repo: "me/knowledge", branch: "main", selected: null });
  });

  it("uses the avatar alias as the default knowledge-repo commit author name", () => {
    const { store, ownerId } = makeStore("gt-alias");
    store.updateProfile(ownerId, { alias: "Knowledge Bot" });
    expect(commitIdentityFor(store, { id: ownerId, username: "owner", displayName: "Owner" })).toEqual({
      name: "Knowledge Bot",
      email: "owner@noah-almighty.local",
    });

    store.setGitIdentity(ownerId, "Explicit Committer", null);
    expect(commitIdentityFor(store, { id: ownerId, username: "owner", displayName: "Owner" }).name).toBe("Explicit Committer");
  });

  it("persists and clears the knowledge-repo plugin selection", () => {
    const { store, ownerId } = makeStore("gt4");
    store.setKnowledgeRepo(ownerId, "me/knowledge", "main");
    const u1 = store.setKnowledgeSelected(ownerId, ["alpha", "beta"]);
    expect(u1.knowledgeSelected).toEqual(["alpha", "beta"]);
    expect(store.getKnowledgeRepo(ownerId).selected).toEqual(["alpha", "beta"]);
    // null = "load all".
    const u2 = store.setKnowledgeSelected(ownerId, null);
    expect(u2.knowledgeSelected).toBeNull();
    // Re-pointing at a repo resets the selection to "load all".
    store.setKnowledgeSelected(ownerId, ["alpha"]);
    const u3 = store.setKnowledgeRepo(ownerId, "me/other", null);
    expect(u3.knowledgeSelected).toBeNull();
  });
});


describe("knowledge repo file ops", () => {
  it("rejects path traversal and absolute paths", () => {
    const root = path.join(tempDir, "repo");
    expect(resolveInRepo(root, "../etc/passwd")).toBeNull();
    expect(resolveInRepo(root, "a/../../b")).toBeNull();
    expect(resolveInRepo(root, "/etc/passwd")).toBeNull();
    expect(resolveInRepo(root, ".git/config")).toBeNull();
    // In-repo paths resolve under the root.
    expect(resolveInRepo(root, "skills/foo/SKILL.md")).toBe(
      path.join(root, "skills/foo/SKILL.md"),
    );
  });

  it("refuses to read/write outside the repo", async () => {
    const root = path.join(tempDir, "repo2");
    fs.mkdirSync(root, { recursive: true });
    await expect(readKnowledgeFile(root, "../escape.txt")).rejects.toThrow("INVALID_PATH");
    await expect(writeKnowledgeFile(root, "../escape.txt", "x")).rejects.toThrow("INVALID_PATH");
  });

  it("rejects reads/writes that escape via a symlink in the clone", async () => {
    const root = path.join(tempDir, "symrepo");
    fs.mkdirSync(root, { recursive: true });
    // A committed-style symlink pointing outside the repo.
    const secret = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(secret, "TOPSECRET");
    fs.symlinkSync(secret, path.join(root, "evil"));
    await expect(readKnowledgeFile(root, "evil")).rejects.toThrow("INVALID_PATH");
    // A symlinked directory ancestor must not let a write escape either.
    fs.symlinkSync(tempDir, path.join(root, "outdir"));
    await expect(writeKnowledgeFile(root, "outdir/pwned.txt", "x")).rejects.toThrow("INVALID_PATH");
    expect(fs.existsSync(path.join(tempDir, "pwned.txt"))).toBe(false);
    // A not-yet-existing path UNDER a symlinked ancestor is rejected before any
    // dirs are created at the link target.
    await expect(writeKnowledgeFile(root, "outdir/sub/deep.txt", "x")).rejects.toThrow("INVALID_PATH");
    expect(fs.existsSync(path.join(tempDir, "sub"))).toBe(false);
  });

  it("scaffolds a skill with a SKILL.md and marketplace manifest entry", async () => {
    const root = path.join(tempDir, "repo3");
    fs.mkdirSync(root, { recursive: true });
    const rel = await scaffoldSkill(root, "Deploy Runbook", "How to deploy");
    expect(rel).toBe("skills/deploy-runbook/SKILL.md");
    expect(fs.existsSync(path.join(root, rel))).toBe(true);
    expect(fs.existsSync(path.join(root, "skills/deploy-runbook/.claude-plugin/plugin.json"))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
    );
    expect(manifest.plugins).toContainEqual({ name: "deploy-runbook", source: "./skills/deploy-runbook" });
    // A second skill is appended, not duplicated.
    await scaffoldSkill(root, "Other", "");
    const manifest2 = JSON.parse(
      fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"),
    );
    expect(manifest2.plugins).toHaveLength(2);
    // Re-scaffolding an existing skill fails.
    await expect(scaffoldSkill(root, "Deploy Runbook", "")).rejects.toThrow("SKILL_EXISTS");
  });
});

describe("knowledge graph (wikilink extraction)", () => {
  async function seed(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      await writeKnowledgeFile(root, rel, content);
    }
  }

  it("flags a repo with no vault layout", async () => {
    const root = path.join(tempDir, "graph-novault");
    fs.mkdirSync(root, { recursive: true });
    await seed(root, { "README.md": "# hi" });
    const g = await buildKnowledgeGraph(root);
    expect(g.noVault).toBe(true);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it("builds nodes per note and resolves [[links]] by title, alias, and stem", async () => {
    const root = path.join(tempDir, "graph-links");
    fs.mkdirSync(root, { recursive: true });
    await seed(root, {
      // links by title, by alias, and by filename stem
      "wiki/concepts/deploy.md":
        "---\ntitle: Deploy Pipeline\naliases: [CD]\ntags: [ops]\n---\nUses [[Prod Cluster]] and [[k8s-notes]].",
      "wiki/entities/cluster.md": "---\ntitle: Prod Cluster\n---\nManaged by [[CD]].",
      "wiki/entities/k8s-notes.md": "---\ntitle: Kubernetes\n---\nNo links here.",
      "wiki/_template.md": "---\ntitle:\n---\n[[ignored]]",
      // Structural files (TOC + brain-reflect's pass log) — never nodes, never link sources.
      "wiki/index.md": "# Index\n\n- [[Deploy Pipeline]]\n- [[Prod Cluster]]",
      "wiki/log.md": "# Reflection log\n\n2026-06-16: added [[Deploy Pipeline]]",
      "raw/2026-06-16-note.md": "raw capture mentioning [[Deploy Pipeline]] and [[Ghost Note]].",
    });
    const g = await buildKnowledgeGraph(root);
    expect(g.noVault).toBeUndefined();

    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    // Template is excluded; three real notes + one raw note = 4 real nodes.
    expect(byId.has("wiki/concepts/deploy.md")).toBe(true);
    expect(byId.has("wiki/_template.md")).toBe(false);
    // index.md/log.md are structural, excluded exactly like brainSearch's noteFiles filter.
    expect(byId.has("wiki/index.md")).toBe(false);
    expect(byId.has("wiki/log.md")).toBe(false);
    expect(byId.get("wiki/concepts/deploy.md")?.label).toBe("Deploy Pipeline");
    expect(byId.get("wiki/concepts/deploy.md")?.section).toBe("concepts");
    expect(byId.get("raw/2026-06-16-note.md")?.section).toBe("raw");

    const edgeSet = new Set(g.edges.map((e) => `${e.source}->${e.target}`));
    // title link
    expect(edgeSet.has("wiki/concepts/deploy.md->wiki/entities/cluster.md")).toBe(true);
    // stem link ([[k8s-notes]] → the file whose stem is k8s-notes, title "Kubernetes")
    expect(edgeSet.has("wiki/concepts/deploy.md->wiki/entities/k8s-notes.md")).toBe(true);
    // alias link ([[CD]] → Deploy Pipeline's alias)
    expect(edgeSet.has("wiki/entities/cluster.md->wiki/concepts/deploy.md")).toBe(true);
    // raw note resolves a title link too
    expect(edgeSet.has("raw/2026-06-16-note.md->wiki/concepts/deploy.md")).toBe(true);

    // [[Ghost Note]] has no backing file → a dangling node + edge to it.
    const ghost = g.nodes.find((n) => n.dangling && n.label === "Ghost Note");
    expect(ghost).toBeTruthy();
    expect(ghost?.section).toBe("unresolved");
    expect(edgeSet.has(`raw/2026-06-16-note.md->${ghost!.id}`)).toBe(true);

    // Structural files contribute no edges either, and the rest of the graph is unchanged:
    // 4 real notes + 1 dangling node, 5 edges (the ones asserted above).
    expect(g.edges.some((e) => e.source === "wiki/index.md" || e.source === "wiki/log.md")).toBe(false);
    expect(g.nodes).toHaveLength(5);
    expect(g.edges).toHaveLength(5);
  });

  it("strips alias/anchor suffixes and ignores self-links", async () => {
    const root = path.join(tempDir, "graph-anchors");
    fs.mkdirSync(root, { recursive: true });
    await seed(root, {
      "wiki/concepts/a.md": "---\ntitle: A\n---\nSee [[B|the b note]] and [[B#section]]. Also [[A]] (self).",
      "wiki/concepts/b.md": "---\ntitle: B\n---\nplain",
    });
    const g = await buildKnowledgeGraph(root);
    const edges = g.edges.filter((e) => e.source === "wiki/concepts/a.md");
    // Both [[B|...]] and [[B#...]] resolve to b.md and de-dupe to ONE edge; self-link dropped.
    expect(edges).toEqual([{ source: "wiki/concepts/a.md", target: "wiki/concepts/b.md" }]);
  });

  it("a freshly seeded vault has no nodes (empty state), not noVault", async () => {
    const root = path.join(tempDir, "graph-seeded");
    fs.mkdirSync(root, { recursive: true });
    // The REAL seeder (fs-level writes only, no git): the vault it creates holds
    // nothing but wiki/index.md, wiki/log.md, wiki/_template.md and .gitkeep stubs.
    expect(await writeRepoTemplate(root, "brain-empty", "personal")).toBe(true);

    const g = await buildKnowledgeGraph(root);
    expect(g.noVault).toBeUndefined(); // the vault EXISTS — it is merely empty
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);

    // Search agrees: present-but-empty is {ok, hits:[]}, never a hit on the TOC itself.
    expect(await rankBrainNotes(root, "index")).toEqual({ kind: "ok", hits: [] });
  });

  it("isVaultNotePath gates the note-content endpoint to vault markdown", () => {
    // Accepts the same files buildKnowledgeGraph turns into real nodes.
    expect(isVaultNotePath("wiki/concepts/deploy.md")).toBe(true);
    expect(isVaultNotePath("raw/2026-06-16-note.md")).toBe(true);
    // Rejects: templates, non-markdown, outside-vault, traversal, non-strings.
    expect(isVaultNotePath("wiki/_template.md")).toBe(false);
    expect(isVaultNotePath("wiki/concepts/deploy.txt")).toBe(false);
    expect(isVaultNotePath("README.md")).toBe(false);
    expect(isVaultNotePath("skills/foo/SKILL.md")).toBe(false);
    expect(isVaultNotePath("wiki/../secret.md")).toBe(true); // prefix ok; readFile's realpath guard rejects it
    expect(isVaultNotePath(["wiki/a.md"])).toBe(false);
    expect(isVaultNotePath(undefined)).toBe(false);
  });
});


describe("createAppServer (TLS_CERT_FILE/TLS_KEY_FILE → native HTTPS)", () => {
  // Throwaway self-signed localhost pair (10y), used only to prove the listener
  // terminates TLS. Trusted by nothing, never used for real traffic.
  const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUA01l/w1ot9BvM7NTf/oN0UTsUAYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgwNzAxNTAyNloXDTM2MDgw
NDAxNTAyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqY4OA/QMGkl3nVNX6A92KQQxBz3Q6nm7HaugYeD+In4c
VGxOq8Ec0/gAUt1MLR6FoswRyRkW02H9LETRDfwcs/kQZ90ZSxj+1w6WWYqJfDK8
XBcb59whAJ1j6qsSbEw7fgwwlBwQHASNR6bFRSWPvi8Zm9uxkqCvBOYnin8VcUyG
+bVPZ0jZewqYnBDHc3bmgoJUcsKH04Yf5idWgUO7LOjPrpGBQIP7Xb+wVbNyIY7K
3lWLku5E6VBP+AiSk2NPrZEq9e/cb1/U5y3VKRhCmPlYvojq9LVqX2BjZTvr+8JW
cEXgpmEz0Qxe7e8QKxCTf5rX8O8g4AugJ8DtHYxMuwIDAQABo28wbTAdBgNVHQ4E
FgQUQv6ajKcx1fdlYNiC3CVusmWsAOQwHwYDVR0jBBgwFoAUQv6ajKcx1fdlYNiC
3CVusmWsAOQwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAImUOMyhRMYQ8/6gwcHB+o7MqTiNDSSN
lf3r2xuREqq+60vhVClAq1qlxWJgipzJck2MA6J9wCeBXyp7p4Ts56kZnyC5gwqc
7ADpEsx9vde2rm+R68k912otKwdaOTc/j41gWGXSQaKHZmCDfFVEcan9EY01QWb8
Oj0sLOZgnrK9mjj2xRdiDo4Pj9AUOcrc1aU6+HpJdKj8djsOb71YBvKDEQKD1sYM
Q/nlEfRwYt5XrR6IvEGG5MCf3IUBjxqu/NgcnR9FwyM4RNT8aJKYRCfP/pKKKZs2
IjSdm43cc4/e9g73VdbY0hMi5TNbB2ZuG80S7XM+M/RyKoqNqjuXH2U=
-----END CERTIFICATE-----
`;
  const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCpjg4D9AwaSXed
U1foD3YpBDEHPdDqebsdq6Bh4P4ifhxUbE6rwRzT+ABS3UwtHoWizBHJGRbTYf0s
RNEN/Byz+RBn3RlLGP7XDpZZiol8MrxcFxvn3CEAnWPqqxJsTDt+DDCUHBAcBI1H
psVFJY++Lxmb27GSoK8E5ieKfxVxTIb5tU9nSNl7CpicEMdzduaCglRywofThh/m
J1aBQ7ss6M+ukYFAg/tdv7BVs3IhjsreVYuS7kTpUE/4CJKTY0+tkSr179xvX9Tn
LdUpGEKY+Vi+iOr0tWpfYGNlO+v7wlZwReCmYTPRDF7t7xArEJN/mtfw7yDgC6An
wO0djEy7AgMBAAECggEAFzWdz4a5nWOPHxcIgniTWRv8xhv9HAubxHz40E0nHHuc
zyWgQzyFALMDAFTQl6CE9HrwuFFZ4YeZS1UENODc4Pnn9/+49aGvSKrzg8BF/51G
UWjMZhmo3teslLPkKrTos+FhSPTqc5tf5335pPR2T7dMzxvsm8CpFIeYxAmPWtnA
0/vlx71ZOgOoiG79/vCvuVJxvwk00Q2LrBOosGMrI7L52IlrnQdsF6E9NgonK4cN
Dmrj/ShBAlLYGUIr+uyCBJmMXznIGMtr0+ndcjHKTm29pKsCfVGfrOz/CeoSe4y5
XgP33aEL97wuMOedjTPSdDBhbANCgfNYIMWgwNCj+QKBgQDWm9HBhu8YjbgcLuI5
IaSaNscNOrijxLpuvZ/N7zd5lwOqy/1iZXrirEKic0IJqKq+ZelmJKf7DP0+y3s9
MzYvfkjuoHKkSNB7AIw4HnmuUe3whpkrTazJ0zK7+cMNWVVGJ1qaHko9S13E5/jH
9MxZkTcCh/tOdZA68kWT87oRnQKBgQDKQbs14WccD9rCn5c3FfYQT+SgH+Xwb2jZ
jE/O/ztwuz72Cs6sROeQDz/nwIC55UtVdAA1wJEMk5bi0/enPm6s7FHTIG+DPfHt
OYnNx6qUKDlR8s2AHv9aXGOlVtZQpe4biR3Jz32BeN1ulqWnW4Y9pAAU3RrJrYSq
3OltPYdUNwKBgD2q6MtDitDzaEQw9LCWCkaGFwymIwhsL2ZC9vimFLrLujIKC/WK
U5VvCnbDx+YeoXG0tyyyu9JYGS1CK1ear6dWEn7/e/HZOo8dyS0XFMASqtzC0KCw
4UXdemapjnL3iJlwFYjTy2FxlrBOOB69KTtTjwsbKAuTnK5Tj8rD7mPBAoGBAMTf
4MxcwRJGuIlz8SyUuvU7326iPh+hQq1ocBMszH46NdonwO9dDw5iWbFL58GL2Z2v
kbjA3jAgxeG7tLheBDtcuXVKgGF+/awNsv7UmU0oLkt/jdtl0OfzQKejdHACZFj3
SkC0MRXDQb+w8kSKyYvcxJuKcdXYimgLK0jDeKRXAoGAE8tX02bFCK4KjBHWvqoa
nCR2pChnp2ZOd28wYdEBpazKP3Q+iTgm/ueeHMMCsjrBT1PnB6aoz+TFjxsE7e8Z
0f/jxB8CVMq1tjaDZTIlHF0Wk/ceber6b+OMhNMPELGdmGODKJGA+qZi3FYTMgDn
o/0YiKsVu64wIJLqb4PGGCM=
-----END PRIVATE KEY-----
`;

  function writePemPair(): { cert: string; key: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-tls-"));
    const cert = path.join(dir, "cert.pem");
    const key = path.join(dir, "key.pem");
    fs.writeFileSync(cert, TEST_TLS_CERT);
    fs.writeFileSync(key, TEST_TLS_KEY);
    return { cert, key };
  }

  it("serves plain http when neither var is set", () => {
    const { server, protocol } = createAppServer(() => {}, {});
    expect(protocol).toBe("http");
    expect(server).toBeInstanceOf(http.Server);
  });

  it("refuses a half-configured pair instead of silently downgrading to http", () => {
    expect(() => createAppServer(() => {}, { tlsCertFile: "/tls/cert.pem" })).toThrow(/together/);
    expect(() => createAppServer(() => {}, { tlsKeyFile: "/tls/key.pem" })).toThrow(/together/);
  });

  it("fails the boot loudly when a PEM path does not exist, naming the path", () => {
    expect(() =>
      createAppServer(() => {}, {
        tlsCertFile: "/no/such/tls-cert.pem",
        tlsKeyFile: "/no/such/tls-key.pem",
      }),
    ).toThrow(/tls-cert\.pem/);
  });

  it("terminates TLS end-to-end when both PEMs are set", async () => {
    const { cert, key } = writePemPair();
    const { server, protocol } = createAppServer((_req, res) => res.end("over-tls"), {
      tlsCertFile: cert,
      tlsKeyFile: key,
    });
    expect(protocol).toBe("https");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          // Self-signed: the point is the handshake + response, not chain trust.
          { host: "127.0.0.1", port, path: "/api/bootstrap", rejectUnauthorized: false },
          (res) => {
            let out = "";
            res.on("data", (chunk: Buffer) => (out += chunk));
            res.on("end", () => resolve(out));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(body).toBe("over-tls");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("applyCustomGithubCa (one GITHUB_CA_CERT for fetch + git)", () => {
  // A throwaway self-signed CA (10y) — only used to prove the cert is registered.
  const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUcqTjIIRo8c5W5rPd4IUUQ2k80ggwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMTm9haCBUZXN0IENBMB4XDTI2MDYxMjA1MDUwOFoXDTM2
MDYwOTA1MDUwOFowFzEVMBMGA1UEAwwMTm9haCBUZXN0IENBMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxiMQNWVb4iqF9mKflqgp5p+n+3LSyHeT5Har
apRgGPVhtYpz68GjMOMn7/VKGw2D5YWVup7jKAcYCvwjT+Ukj6/3wm7nxPWgvyoz
0XJpUG0LTYCnHRCkXzKcjlS6H51A+MkM2aJET5TB2ShKot/zbRBw8vVjipNnOozK
3z+io0KO9IaejvKxDg7wMxbsbt/cV8+hXlv05LcbEFr/tvW8fvDvqeFzwT4GWNOT
DdoFNCu8ZEa0XIrPCpTPr3+al5Miozbfdwq7bdpgDu4jsbcWUJrCTlbqlzExaAlP
SGApBv1IWwnR1Ke8trvaCfoHoRyLtglxHaNroErsJE4wnf5NCQIDAQABo1MwUTAd
BgNVHQ4EFgQUBGaTeJgpnW2L/2rPIJLI8HQL6okwHwYDVR0jBBgwFoAUBGaTeJgp
nW2L/2rPIJLI8HQL6okwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAKnENhipsapusqB11Hw7gbE1goF+7Gwyi0yvosEjdFk/mcxSqYlDNRksS3z6X
bFYa6nNa650egp8b0zvkGTNypIFFu7Ch+DI16ksHoMqepCoaj5BvRm0gwo/b/6of
hqc7FkZtQS0HkGmtGcxLhJQ458MVol9Jnwt8E2Exx/D3PHGtajIb5AZXkA9c9sBw
ERc1OguGascDEMRZK6bhvTbsAV61YoK+xQ7lBWhPOPxrEACx21kqpKrPYQXCtCHs
1QQXhW5lzK/QgKN3xYfu9Yd2XcK/KJpr2PUhlbn5YXj5x4RNRcMNhrs8sg7u2CTo
6UIgE2hSD+xkPUz7lTgYUjA4oQ==
-----END CERTIFICATE-----
`;
  const silent = { info: () => {}, warn: () => {} };

  it("is a no-op when GITHUB_CA_CERT is unset", () => {
    const prevGit = process.env.GIT_SSL_CAINFO;
    const applied = applyCustomGithubCa({ ...loadConfig(), githubCaCert: undefined }, silent);
    expect(applied).toBe(false);
    expect(process.env.GIT_SSL_CAINFO).toBe(prevGit);
  });

  it("warns and returns false when the cert file is unreadable", () => {
    const warn = vi.fn();
    const applied = applyCustomGithubCa(
      { ...loadConfig(), githubCaCert: "/no/such/internal-ca.pem" },
      { info: () => {}, warn },
    );
    expect(applied).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("trusts the CA for fetch (tls default set) and git (GIT_SSL_CAINFO)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ca-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, TEST_CA_PEM);
    const prevGit = process.env.GIT_SSL_CAINFO;
    delete process.env.GIT_SSL_CAINFO;
    const before = tls.getCACertificates("default").length;

    const applied = applyCustomGithubCa({ ...loadConfig(), githubCaCert: caPath }, silent);

    expect(applied).toBe(true);
    // git: every `git` execFile child inherits this.
    expect(process.env.GIT_SSL_CAINFO).toBe(path.resolve(caPath));
    // fetch (undici): appended to the default set, not replacing system roots.
    expect(tls.getCACertificates("default").length).toBe(before + 1);

    if (prevGit === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = prevGit;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps an operator-set GIT_SSL_CAINFO instead of clobbering it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ca-"));
    const caPath = path.join(dir, "ca.pem");
    fs.writeFileSync(caPath, TEST_CA_PEM);
    const prevGit = process.env.GIT_SSL_CAINFO;
    process.env.GIT_SSL_CAINFO = "/operator/explicit/bundle.pem";

    applyCustomGithubCa({ ...loadConfig(), githubCaCert: caPath }, silent);
    expect(process.env.GIT_SSL_CAINFO).toBe("/operator/explicit/bundle.pem");

    if (prevGit === undefined) delete process.env.GIT_SSL_CAINFO;
    else process.env.GIT_SSL_CAINFO = prevGit;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});


describe("loadDotEnv (.env auto-load)", () => {
  it("is a no-op for a missing file", () => {
    expect(loadDotEnv("/no/such/dir/.env")).toBe(false);
  });

  it("fills unset keys from the file but never overwrites the real environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "NOAH_TEST_FROM_FILE=fromfile\nNOAH_TEST_REAL=fromfile\n");
    const prevReal = process.env.NOAH_TEST_REAL;
    const prevFile = process.env.NOAH_TEST_FROM_FILE;
    process.env.NOAH_TEST_REAL = "realenv";
    delete process.env.NOAH_TEST_FROM_FILE;

    expect(loadDotEnv(file)).toBe(true);
    expect(process.env.NOAH_TEST_FROM_FILE).toBe("fromfile"); // unset key gets filled
    expect(process.env.NOAH_TEST_REAL).toBe("realenv"); // real env wins over the file

    if (prevReal === undefined) delete process.env.NOAH_TEST_REAL;
    else process.env.NOAH_TEST_REAL = prevReal;
    if (prevFile === undefined) delete process.env.NOAH_TEST_FROM_FILE;
    else process.env.NOAH_TEST_FROM_FILE = prevFile;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("browser extension bundle", () => {
  it("reports the bundled manifest version for the compatibility badge", () => {
    // The chat composer badge compares the installed extension against this;
    // a null here would render every install as incomparable.
    expect(browserExtensionVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("never demands a build newer than the one it ships", () => {
    // The floor must stay at or below the bundled version — the invariant
    // BROWSER_EXTENSION_MIN_COMPATIBLE's own comment claims a test enforces.
    // Above it, even a just-downloaded install badges orange FOREVER: the
    // user is told to update to something no download can give them.
    const parse = (v: string) => v.split(".").map(Number);
    const min = parse(BROWSER_EXTENSION_MIN_COMPATIBLE);
    const bundled = parse(browserExtensionVersion()!);
    expect(BROWSER_EXTENSION_MIN_COMPATIBLE).toMatch(/^\d+\.\d+\.\d+$/);
    for (let i = 0; i < Math.max(min.length, bundled.length); i += 1) {
      const diff = (min[i] ?? 0) - (bundled[i] ?? 0);
      if (diff !== 0) {
        // Numeric per segment, so 0.10.0 correctly outranks 0.9.1.
        expect(
          diff,
          `min-compatible ${BROWSER_EXTENSION_MIN_COMPATIBLE} exceeds bundled ${browserExtensionVersion()}`,
        ).toBeLessThan(0);
        break;
      }
    }
  });

  it("never asks for a secret-capable build newer than the one it ships", () => {
    // The client refuses to relay a stored secret to an extension older than
    // SECRET_INPUT_MIN_EXTENSION_VERSION and tells the user to update. Above the
    // bundled version that instruction is unfollowable: the download IS the
    // bundle, so the user updates and the secret still never gets typed. Same
    // failure shape as the min-compatible ceiling above, different lever.
    //
    // Read out of the client source rather than imported: this file compiles
    // under the ROOT tsconfig (NodeNext), which excludes src/client precisely
    // because its extensionless imports do not resolve there. A rename or a
    // reformat of the declaration fails this pin loudly, which is the point.
    const clientSource = fs.readFileSync(
      path.join(process.cwd(), "src", "client", "src", "lib", "browserBridge.ts"),
      "utf8",
    );
    const declared = /export const SECRET_INPUT_MIN_EXTENSION_VERSION = "([^"]+)"/.exec(clientSource);
    expect(declared, "browserBridge.ts must export SECRET_INPUT_MIN_EXTENSION_VERSION").toBeTruthy();
    const SECRET_INPUT_MIN_EXTENSION_VERSION = declared![1];
    expect(SECRET_INPUT_MIN_EXTENSION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const parse = (v: string) => v.split(".").map(Number);
    const need = parse(SECRET_INPUT_MIN_EXTENSION_VERSION);
    const bundled = parse(browserExtensionVersion()!);
    for (let i = 0; i < Math.max(need.length, bundled.length); i += 1) {
      const diff = (need[i] ?? 0) - (bundled[i] ?? 0);
      if (diff !== 0) {
        expect(
          diff,
          `secret-input floor ${SECRET_INPUT_MIN_EXTENSION_VERSION} exceeds bundled ${browserExtensionVersion()}`,
        ).toBeLessThan(0);
        break;
      }
    }
    // …and the FLEET floor must not move for this feature: the value rides a new
    // field (`secretText`), so an older build types nothing rather than
    // mishandling the op. Raising the reinstall order would be a false alarm.
    expect(BROWSER_EXTENSION_MIN_COMPATIBLE).toBe("0.6.0");
  });

  it("ships every extension/ file except deliberate dev-only excludes", () => {
    // Field-bricking invariant: a new file under extension/ that a coder forgets
    // to add to BUNDLE_FILES silently ships an incomplete zip/install. Diff the
    // shipped set against the actual directory; only dev-only docs may be absent.
    const NOT_SHIPPED = new Set(["CLAUDE.md"]);
    const shipped = new Set(listBrowserExtensionFiles().map((f) => f.name));
    const onDisk = fs
      .readdirSync(BROWSER_EXTENSION_DIR, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    const missing = onDisk.filter((name) => !shipped.has(name) && !NOT_SHIPPED.has(name));
    expect(missing, `add these to BUNDLE_FILES (or NOT_SHIPPED): ${missing.join(", ")}`).toEqual([]);
  });

  it("flags every shipped binary file as base64 so the updater can't utf8-corrupt it", () => {
    // A binary file missing from BINARY_BUNDLE_FILES ships as utf8 and the
    // one-click updater writes a corrupted copy — an install that fails to load.
    for (const file of listBrowserExtensionFiles()) {
      if (/\.(png|jpe?g|gif|webp|woff2?|ico)$/i.test(file.name)) {
        expect(file.encoding, `${file.name} must be a BINARY_BUNDLE_FILES entry`).toBe("base64");
      }
    }
  });

  it("produces a zip the OS unzip accepts, containing every shipped file", () => {
    const zip = buildBrowserExtensionZip();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ext-"));
    const zipPath = path.join(dir, "bundle.zip");
    fs.writeFileSync(zipPath, zip);

    // Validate with a real unzip rather than our own reader: the writer is
    // hand-rolled, so a self-consistent bug would pass a self-written parser.
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    execFileSync("unzip", ["-q", zipPath, "-d", dir], { stdio: "pipe" });

    const root = path.join(dir, "noah-browser-bridge");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    // The pinned key is what makes the extension id stable across installs; a
    // bundle without it would install under a random id the client can't reach.
    expect(typeof manifest.key).toBe("string");
    expect(manifest.permissions).toContain("debugger");

    // Round-trips byte-for-byte, so deflate/CRC are right, not just parseable.
    // consent.js doubles as a regression pin: dropping the consent page from
    // BUNDLE_FILES would ship a bundle whose new_tab popup 404s. axtree.js is a
    // harder one — background.js imports it, so losing it breaks every op, and
    // secretInput.js is imported the same way (a bundle without it bricks the
    // worker, so no browser op works at all — not just secret input).
    // icon-128.png pins the BINARY path: the manifest names the icons, so a
    // bundle that mangles (or drops) them fails to load at install time.
    for (const name of [
      "background.js",
      "axtree.js",
      "secretInput.js",
      "options.js",
      "consent.js",
      "policy-schema.json",
      "icon-128.png",
    ]) {
      expect(fs.readFileSync(path.join(root, name)).equals(
        fs.readFileSync(path.join(process.cwd(), "extension", name)),
      )).toBe(true);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stamps the downloading Noah address into the bundle's manifest", () => {
    // An origin missing from externally_connectable fails SILENTLY — the page
    // simply has no chrome.runtime — so the bundle carries the address it was
    // downloaded from instead of leaving a manual manifest edit per install.
    const pattern = matchPatternForOrigin("https://noah.internal.example:8443");
    expect(pattern).toBe("https://noah.internal.example:8443/*");

    const zip = buildBrowserExtensionZip(undefined, [pattern!]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-ext-origin-"));
    fs.writeFileSync(path.join(dir, "b.zip"), zip);
    execFileSync("unzip", ["-q", path.join(dir, "b.zip"), "-d", dir], { stdio: "pipe" });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "noah-browser-bridge", "manifest.json"), "utf8"),
    );

    expect(manifest.externally_connectable.matches).toContain(pattern);
    // The shipped defaults survive, and the pinned key must not be disturbed —
    // rewriting the manifest would otherwise change the extension id.
    expect(manifest.externally_connectable.matches).toContain("https://noah.corp.local/*");
    expect(manifest.key).toBe(
      JSON.parse(fs.readFileSync(path.join(process.cwd(), "extension", "manifest.json"), "utf8")).key,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to stamp anything that is not an http(s) origin", () => {
    expect(matchPatternForOrigin("file:///etc/passwd")).toBeNull();
    expect(matchPatternForOrigin("not a url")).toBeNull();
    expect(matchPatternForOrigin("javascript:alert(1)")).toBeNull();
  });

  it("derives the same extension id Chrome would, and reports the bridge origins", () => {
    const id = browserExtensionId();
    // 32 chars drawn from a-p — Chrome's base-16-shifted-into-letters encoding.
    expect(id).toMatch(/^[a-p]{32}$/);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "extension", "manifest.json"), "utf8"),
    );
    const der = Buffer.from(manifest.key, "base64");
    const hash = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
    const expected = [...hash].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");
    expect(id).toBe(expected);

    // The client's default target must match, or a correct install never connects.
    const bridge = fs.readFileSync(
      path.join(process.cwd(), "src/client/src/lib/browserBridge.ts"),
      "utf8",
    );
    expect(bridge).toContain(`"${id}"`);

    expect(browserExtensionOrigins().length).toBeGreaterThan(0);
  });
});

describe("browser extension policy-channel artifacts", () => {
  // One keypair for the whole block — 2048-bit generation is the slow part.
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  it("packs a crx3 Chrome can verify, carrying the zip byte-for-byte", async () => {
    // Chrome reads manifest.json at the crx archive ROOT; the friendly
    // noah-browser-bridge/ folder of the manual download would brick it.
    const zip = buildBrowserExtensionZip(undefined, [], "");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-crx-"));
    fs.writeFileSync(path.join(dir, "b.zip"), zip);
    execFileSync("unzip", ["-q", path.join(dir, "b.zip"), "-d", dir], { stdio: "pipe" });
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });

    const packed = packCrx3(zip, pem);
    expect(packed.crx.subarray(0, 4).toString("latin1")).toBe("Cr24");
    expect(packed.crx.readUInt32LE(4)).toBe(3);
    const headerLen = packed.crx.readUInt32LE(8);
    expect(packed.crx.subarray(12 + headerLen).equals(zip)).toBe(true);

    // The signature must cover EXACTLY what Chrome hashes: magic, the
    // signed-header length, the header, then the archive.
    const shdLength = Buffer.alloc(4);
    shdLength.writeUInt32LE(packed.signedHeaderData.length, 0);
    const signed = Buffer.concat([
      Buffer.from("CRX3 SignedData\x00", "latin1"),
      shdLength,
      packed.signedHeaderData,
      zip,
    ]);
    expect(
      crypto.verify(
        "sha256",
        signed,
        crypto.createPublicKey({ key: packed.publicKeyDer, format: "der", type: "spki" }),
        packed.signature,
      ),
    ).toBe(true);
    // crx_id inside signed_header_data is what ties the payload to the id a
    // policy pinned (field 1, so the first two bytes are the proto tag+len).
    expect(
      packed.signedHeaderData
        .subarray(2)
        .equals(crypto.createHash("sha256").update(packed.publicKeyDer).digest().subarray(0, 16)),
    ).toBe(true);
  });

  it("escapes updates.xml attributes and pins appid, version, and codebase", () => {
    const xml = buildUpdatesXml({
      extensionId: "abcdefghijklmnopabcdefghijklmnop",
      version: "0.8.0",
      crxUrl: "https://github.com/o/r/releases/download/v1.3.0/bridge.crx?a=1&b='x'",
      minChromeVersion: "116",
    });
    expect(xml).toContain("appid='abcdefghijklmnopabcdefghijklmnop'");
    expect(xml).toContain("version='0.8.0'");
    expect(xml).toContain("prodversionmin='116'");
    // An unescaped apostrophe would end the attribute and hand Chrome a
    // malformed manifest — the whole fleet's update check then fails.
    expect(xml).toContain("&amp;b=&apos;x&apos;");
    expect(xml).not.toContain("b='x'");
  });

  it("derives extension ids exactly like the bundle helper (Chrome's a-p mapping)", () => {
    const fromNewKey = extensionIdFromPublicKey(
      Buffer.from(manifestKeyFromPrivateKey(pem), "base64"),
    );
    expect(fromNewKey).toMatch(/^[a-p]{32}$/);
    // Same mapping as browserExtensionId over the CURRENT manifest key: the
    // bootstrap instructions print ids from this helper, and the badge/client
    // code trusts the bundle helper — they must never disagree.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "extension", "manifest.json"), "utf8"),
    );
    expect(extensionIdFromPublicKey(Buffer.from(manifest.key, "base64"))).toBe(
      browserExtensionId(),
    );
  });
});
