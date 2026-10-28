/**
 * Run-plan assembly for a Claude Agent SDK turn.
 *
 * `runClaudeAgent` used to do this inline: ~1000 lines of pure derivation ahead
 * of its ~400-line streaming loop. The two halves share no mutable state — the
 * setup half declares NO `let` at all — so it lives here as one function that
 * returns the plan the loop consumes. Split behind unchanged exports:
 * `claudeAgent.ts` re-exports every helper that moved with it, so existing
 * import paths (app.ts, the agent-core/agent-tools/infra/store
 * suites) resolve against that module unchanged.
 *
 * The backend-agnostic half — tool access, the in-process MCP servers, the
 * self-state both metacognition surfaces report — lives in
 * `runCapabilities.ts` (shared with the pi runner, design N1); this module adds
 * only what the SDK/CLI needs on top: the `options` bag, hooks, CLI-spawned MCP
 * subprocesses (hex-ssh, plugin `.mcp.json`, 공용 MCP) and their secret handoff.
 * Its helpers are re-exported here so import paths stay stable.
 *
 * `options` is returned as a live object the loop still mutates (systemPrompt,
 * model, resume) — same object identity as before the split, on purpose.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AgentRequest,
  PluginRoot,
} from "../types.js";
import type { Store } from "../store.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../store.js";
import { CROSS_SESSION_SETTINGS } from "./sessionIsolation.js";
import type { AgentEvents } from "./events.js";
import logger from "../logger.js";
import { knownHostsPath } from "../sshTrust.js";
import {
  GIT_CREDENTIAL_ENV_NAMES,
  SSH_MCP_SECRET_ENV_NAMES,
  scrubServerOnlySecretEnv,
} from "../secretPolicy.js";
import { HEX_SSH_SERVER_NAME } from "../hexSshPolicy.js";
import { liftPluginMcpServers } from "../plugins.js";
import {
  mcpBridgeRedactions,
  mcpHttpBridgeServerDef,
  type McpHttpBridgeConfig,
} from "../sharedMcpServers.js";
import {
  buildCanUseToolSafetyNet,
  buildPreToolUseHook,
  createHookApprovalLedger,
  TASK_ORCHESTRATION_TOOLS,
} from "./preToolUseHook.js";
import { buildPostToolUseHook } from "./postToolUseHook.js";
import { PROMPT_TTL_MS } from "./runRegistry.js";
import {
  SDK_ELEVATED_BUILTIN_TOOLS,
  UNUSED_SDK_BUILTIN_TOOLS,
} from "../../shared/sdkToolPresentation.js";
import {
  disallowedEntriesForPolicy,
} from "../toolSkillPolicy.js";
import { computeSkillsOption, freshSkillDiscoveryCache } from "./skillDiscovery.js";
import {
  buildRunCapabilities,
  type RunCapabilityOptions,
} from "./runCapabilities.js";

// The pure helpers moved with the backend-agnostic half; re-exported so every
// importer of this module keeps resolving them here.
export {
  mcpInjectableSecretEnv,
  deriveAgentToolAccess,
  planMcpToolFamilies,
  conversationScratchDir,
  buildModelFallbackChain,
  type AgentToolAccess,
  type McpToolFamilyPlan,
} from "./runCapabilities.js";

// Same `{ module: "agent" }` tag claudeAgent.ts logs under: the plan is one
// half of a single run, so its lines must stay indistinguishable in the log.
const agentLogger = logger.child({ module: "agent" });

export function withoutGitCredentialEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

// App-internal secrets the agent subprocess must NEVER be able to read from its
// environment (SERVER_ONLY_SECRET_ENV_NAMES, secretPolicy.ts): SESSION_SECRET is
// the master key for EVERY user's at-rest secrets. The boot scrub already removed it
// from process.env; stripping here again keeps a caller-supplied base env safe.
// (Git credentials are stripped separately above — they flow only through the
// app-managed git MCP bridge.)

export function agentSubprocessEnv(
  baseEnv: Record<string, string | undefined>,
  agentSessionsDir: string,
): Record<string, string | undefined> {
  const env = withoutGitCredentialEnv(baseEnv);
  scrubServerOnlySecretEnv(env);
  return {
    ...env,
    CLAUDE_CONFIG_DIR: agentSessionsDir,
    // Agent teams (the CLI's experimental addressable `Agent{name}` spawns) are
    // retired: pinned OFF so a deploy-environment value cannot turn the teams
    // runtime back on (its SendMessage tool is disallowed regardless).
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0",
    // Background tasks are disabled (ahead of the pi-gateway move, which has
    // none). Measured on the bundled CLI 2.1.283: the flag drops
    // `run_in_background` from the Bash AND Agent schemas, so a Bash call that
    // still passes it fails the CLI's own input validation before any hook, and
    // nothing can outlive the turn. The held-open stdin generator and
    // onTurnResult stay — mid-turn steers ride them.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

export function sshMcpSecretEnv(
  ownerSecrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SSH_MCP_SECRET_ENV_NAMES) {
    const value = ownerSecrets[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Backstop for the one-shot MCP secret files: the wrapper deletes its file on
 * read, so anything older than an hour is a crash leftover — remove it. Never
 * throws (missing dir on first run is the normal case).
 */
const MCP_SECRET_FILE_MAX_AGE_MS = 60 * 60 * 1000;
function sweepStaleMcpSecretFiles(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > MCP_SECRET_FILE_MAX_AGE_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      /* raced with a wrapper's own unlink */
    }
  }
}

/**
 * Derive everything a run needs before the SDK stream opens: tool access, MCP
 * servers, model chain, prompt/self-state inputs, and the SDK `options` bag.
 * Pure with respect to the run loop — it reads store/config/plugins and builds
 * servers, but touches none of the loop's accumulators.
 */
export async function buildAgentRunPlan(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents | undefined,
  abortController: AbortController | undefined,
  currentTextAnchor: () => number,
  runOptions: RunCapabilityOptions = {},
) {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    // `query()` returns an AsyncIterable PLUS control methods. We use
    // getContextUsage() — the SDK's first-party "current context-window usage"
    // breakdown — to report true occupancy instead of scraping message usage.
    // It only answers while the session is live (streaming I/O), so we call it
    // mid-turn (see the assistant branch in the run loop).
    query: (input: unknown) => AsyncIterable<unknown> & {
      getContextUsage?: () => Promise<
        { totalTokens?: number; maxTokens?: number } | undefined
      >;
    };
  };
  const capabilities = await buildRunCapabilities(
    request,
    pluginRoots,
    config,
    store,
    events,
    abortController,
    currentTextAnchor,
    runOptions,
  );
  const {
    streaming,
    headless,
    allowHeadlessTools,
    elevatedToolAccess,
    elevated,
    autoApprove,
    consultationRun,
    hexSshViewerClass,
    hexSshPolicy,
    hexSshAllowedTools,
    ownerState,
    ownerSecrets,
    injectableSecretEnv,
    browserSecretPolicies,
    effectiveModel,
    userEffort,
    runVisionEnabled,
    toolSkillPolicy,
    sshActive,
    sharedMcpPlan,
    sharedMcpStates,
    inProcessMcpServers,
    mcpAllowedTools,
  } = capabilities;

  // `ownerSecrets` (the OWNER's decrypted vault) is read above, ahead of
  // describe_system's ctx.
  const sshSecrets = sshMcpSecretEnv(ownerSecrets);
  // Secret handoff for app-registered EXTERNAL MCP subprocesses. The SDK
  // serializes `mcpServers` into the CLI's `--mcp-config` ARGV — readable via
  // /proc/<pid>/cmdline by the agent's own Bash — so secret VALUES must never
  // sit in a server definition. They ride in per-server one-shot 0600 files
  // that scripts/mcp-secret-wrapper.mjs reads, deletes, and merges into the
  // real server's env; only the file PATH appears in the definition. Stale
  // files (a crash before the wrapper consumed them) are swept after an hour.
  const mcpSecretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
  const mcpSecretWrapperPath = path.join(
    process.cwd(),
    "scripts",
    "mcp-secret-wrapper.mjs",
  );
  // The stdio↔HTTP relay for HTTP MCP servers whose url/headers carry secrets
  // (admin 공용 servers + owned `.mcp.json` http/sse entries): same one-shot
  // 0600 handoff, but the bridge holds the values in memory, not in its env.
  const mcpHttpBridgePath = path.join(
    process.cwd(),
    "scripts",
    "mcp-http-bridge.mjs",
  );
  const mcpRunId = randomUUID();
  sweepStaleMcpSecretFiles(mcpSecretsDir);
  // Per-key shell exposure: only the secrets the owner individually toggled
  // (`user_secrets.shell_expose`) export into the agent shell env, and only on
  // ELEVATED runs — the same viewer line as the MCP injection, so a plain
  // colleague's Bash stays secret-free. Reserved git/SSH names are already
  // absent from injectableSecretEnv regardless of the flag.
  const shellSecretEnv: Record<string, string> = {};
  if (elevatedToolAccess && !consultationRun) {
    for (const name of ownerState.shellExposedSecretNames) {
      const value = injectableSecretEnv[name];
      if (value !== undefined) {
        shellSecretEnv[name] = value;
      }
    }
  }
  // Browser-typed secrets reach a process too — the user's own browser — so
  // their values join the PostToolUse redaction set. Without this a run whose
  // ONLY secret exposure is browser input would register no hook at all, and a
  // page echoing the password back into its DOM would print it in the next
  // snapshot. The browser tools redact their own reply; this covers every OTHER
  // tool output for the rest of the turn.
  const browserSecretEnv: Record<string, string> = {};
  for (const policy of browserSecretPolicies) {
    const value = injectableSecretEnv[policy.name];
    if (value !== undefined) {
      browserSecretEnv[policy.name] = value;
    }
  }
  // Plugin-defined MCP servers (each root's `.mcp.json`): the APP registers
  // them (strictMcpConfig below stops the CLI from auto-spawning duplicates),
  // so the owner's secret vault — minus the reserved git/SSH names — can reach
  // the OWNED servers while the agent shell env stays clean. Group and default
  // roots load too but never receive secrets.
  const lifted = await liftPluginMcpServers(
    pluginRoots.map((root) => root.path),
    {
      avatarUserId: request.avatar.id,
      config,
      // Secrets ride only on ELEVATED runs (owner or trusted same-group
      // teammate, incl. owner-scheduled routines) — the exact line the
      // Confluence tools draw for the owner's PAT. Plugin servers are
      // third-party processes that cannot self-gate per viewer, and the
      // PreToolUse hook auto-allows every mcp__* call, so REGISTRATION is the
      // gate: a plain colleague or a restricted headless run still gets the
      // servers, but credential-less (the pre-lift CLI behavior).
      secretWrapper:
        elevatedToolAccess &&
        !consultationRun &&
        Object.keys(injectableSecretEnv).length > 0
          ? {
              scriptPath: mcpSecretWrapperPath,
              secretsDir: mcpSecretsDir,
              runId: mcpRunId,
            }
          : null,
      // Shell-exposed values live in the CLI subprocess env (options.env
      // below), which every CLI-spawned server INHERITS — blank them on
      // non-owned (group/default) servers so those never see the vault.
      maskEnvNames: Object.keys(shellSecretEnv),
      // Same gate as secretWrapper (the lift ignores it while that is null).
      httpBridge: { scriptPath: mcpHttpBridgePath, secrets: injectableSecretEnv },
    },
  );
  // Every ENABLED admin server reserves its name for this run — mounted or
  // not. Otherwise a server that sits the run out (unbound slot, colleague
  // run) would let a same-named plugin server take `mcp__<name>__*` while both
  // metacognition surfaces say that name is NOT available.
  const sharedMcpNames = new Set((sharedMcpStates ?? []).map((state) => state.name));
  const liftedPluginMcpServers = Object.fromEntries(
    Object.entries(lifted.servers).filter(([name]) => !sharedMcpNames.has(name)),
  );
  // 공용 MCP servers this run registers (sharedMcpPlan above): a header-less
  // server goes to the CLI natively; anything with headers runs through the
  // bridge on its own handoff file, so no header value enters --mcp-config.
  // (Every handoff file is written by writeMcpHandoffFiles below.)
  const sharedMcpServerDefs: Record<string, unknown> = {};
  const sharedMcpBridgeFiles: { name: string; path: string; config: McpHttpBridgeConfig }[] = [];
  for (const registration of sharedMcpPlan?.registrations ?? []) {
    if (registration.kind === "native") {
      sharedMcpServerDefs[registration.name] = registration.def;
      continue;
    }
    const file = path.join(
      mcpSecretsDir,
      `shared-${mcpRunId}-${registration.name}.json`,
    );
    sharedMcpBridgeFiles.push({ name: registration.name, path: file, config: registration.config });
    sharedMcpServerDefs[registration.name] = mcpHttpBridgeServerDef(
      mcpHttpBridgePath,
      file,
    );
  }
  // An admin server takes its name over from a plugin `.mcp.json` server —
  // reported like the app-server shadowing below, never dropped silently.
  for (const name of sharedMcpNames) {
    if (Object.hasOwn(lifted.servers, name)) {
      agentLogger.warn(
        { avatarId: request.avatar.id, server: name },
        "plugin mcp server shadowed by a shared mcp server of the same name",
      );
      events?.onStatus?.(
        `플러그인 경고: MCP 서버 "${name}"은(는) 관리자가 등록한 공용 MCP 서버와 이름이 같아 이번 실행에서 제외됩니다`,
      );
    }
  }
  if (Object.keys(liftedPluginMcpServers).length > 0) {
    agentLogger.info(
      {
        avatarId: request.avatar.id,
        pluginMcpServers: Object.keys(liftedPluginMcpServers),
        secretInjected: lifted.secretFiles.length,
      },
      "plugin mcp servers lifted",
    );
  }
  // hex-ssh (remote-server access MCP, ssh2-based — no system ssh binary needed):
  // registered explicitly (not via a plugin's .mcp.json) so we can inject the
  // owner's per-user SSH identity. The policy proxy filters tools/list before
  // the model sees it, and the PreToolUse hook below enforces the same allowlist
  // again on tools/call.
  const hexSshProxyPath = path.join(
    process.cwd(),
    "scripts",
    "hex-ssh-policy-proxy.mjs",
  );
  // (`sshActive` is computed above, ahead of describe_system's ctx.)
  // The SSH key/passphrase ride the same one-shot secret-file handoff as the
  // plugin servers: embedding them in `env` here would serialize them into the
  // CLI's --mcp-config ARGV, world-readable via /proc/<pid>/cmdline (this was
  // a real pre-wrapper exposure). Only non-secret config stays in env.
  const sshSecretsFile = path.join(mcpSecretsDir, `ssh-${mcpRunId}.json`);
  const sshServers = sshActive
    ? {
        [HEX_SSH_SERVER_NAME]: {
          type: "stdio" as const,
          command: process.execPath,
          args: [
            mcpSecretWrapperPath,
            "--secrets",
            sshSecretsFile,
            "--",
            process.execPath,
            hexSshProxyPath,
          ],
          // KNOWN_HOSTS_PATH points hex-ssh at the owner's persistent trust file
          // (under the data volume). hex-ssh re-reads it on every connection, so
          // the `mcp__ssh_trust__*` tools can add a host mid-session and it takes
          // effect immediately. SSH-specific secrets arrive via the wrapper's
          // secrets file: git credentials stay inside the app-managed git MCP
          // handlers, and no secret value enters this definition.
          env: {
            REMOTE_SSH_MODE: "safe",
            KNOWN_HOSTS_PATH: knownHostsPath(request.avatar.id, config),
            HEX_SSH_UPSTREAM_COMMAND: config.hexSshCommand,
            HEX_SSH_ALLOWED_TOOLS: hexSshAllowedTools.join(","),
          },
        },
      }
    : {};

  const appMcpServers: Record<string, unknown> = {
    ...inProcessMcpServers,
    ...sshServers,
  };
  // A plugin's .mcp.json server whose name an app server takes in THIS run is
  // replaced by it. Say so (logs + the run's status line, like the chat route's
  // pluginWarnings) rather than dropping a user's server without a trace; runs
  // where that app server is inactive still register the plugin's.
  const shadowedPluginServers = consultationRun
    ? []
    : Object.keys(liftedPluginMcpServers).filter((name) => Object.hasOwn(appMcpServers, name));
  for (const name of shadowedPluginServers) {
    agentLogger.warn(
      { avatarId: request.avatar.id, server: name },
      "plugin mcp server shadowed by an app server of the same name",
    );
    events?.onStatus?.(
      `플러그인 경고: MCP 서버 "${name}"은(는) 앱 기본 도구와 이름이 같아 이번 실행에서는 앱 도구가 대신 쓰입니다`,
    );
  }

  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    // The PreToolUse hook (below) is the real gate. `default` mode is required —
    // it's the mode in which the hook's deny decision is honored.
    permissionMode: "default",
    // Auto-approve (no prompt) the read-only + knowledge + meta tools. NOTE: this
    // is only an auto-approve list, NOT a restriction — the hook does enforcement.
    allowedTools: [
      ...config.readOnlyTools,
      ...mcpAllowedTools,
      "Skill",
      "TodoWrite",
      ...TASK_ORCHESTRATION_TOOLS,
      // Silent auto-deny workaround: when the hook blanket-allows every tool
      // anyway (elevated + autoApprove — the same condition as its
      // canRunElevatedTools fast path), pre-allow the gated built-ins by RULE
      // so they never enter the CLI's ask path — 2.1.222 cancels that path in
      // turns where queued input (a background task-notification) arrived and
      // words it as a user refusal. Hook denies still override these rules.
      // See SDK_ELEVATED_BUILTIN_TOOLS for the full account.
      ...(elevated && (!headless || allowHeadlessTools) && autoApprove
        ? SDK_ELEVATED_BUILTIN_TOOLS
        : []),
    ],
    // Drop full-CLI harness tools we never use from the advertised tool list.
    // `allowedTools` only auto-approves; it does NOT restrict what the CLI offers,
    // so these (Monitor/Cron*/Worktree/…) would otherwise ride along on every
    // request as unused tool descriptions. See the constant.
    disallowedTools: Array.from(
      new Set([
        ...UNUSED_SDK_BUILTIN_TOOLS,
        // Admin policy: bare tool names remove built-ins from the advertised
        // set entirely; `Skill(<name>)` denies that one skill's invocation at
        // the CLI layer (the skill may still be LISTED — the skills allowlist
        // below and the PreToolUse hook cover that side).
        ...disallowedEntriesForPolicy(toolSkillPolicy),
      ]),
    ),
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    // "all" unless the admin disabled skills AND the discovery cache is fresh
    // for the bundled CLI version — then an explicit allowlist hides them from
    // the model's skill listing. Visibility is fail-open (a stale/missing
    // cache must never make skills vanish), execution stays fail-closed (the
    // hook denies disabled skills regardless).
    skills: computeSkillsOption(
      toolSkillPolicy,
      freshSkillDiscoveryCache(store),
      pluginRoots.map((root) => root.path),
    ),
    // Only the servers registered HERE exist: the CLI's own MCP discovery
    // (plugin .mcp.json, cwd project .mcp.json, user settings) is disabled so
    // plugin servers can't double-spawn beside the lifted, secret-injected
    // registrations below — and so an opened work repo's .mcp.json can't
    // register servers behind the app's back.
    strictMcpConfig: true,
    mcpServers: {
      // Plugin-provided servers first: every app-managed name spread after
      // this wins a collision, so a plugin can't shadow an app server (the
      // shadowed ones are reported above). A consultation run gets NO plugin
      // servers at all — third-party servers can't self-gate per viewer, so
      // registration is their only gate.
      ...(consultationRun ? {} : liftedPluginMcpServers),
      // Admin 공용 servers override a same-named plugin server (reported
      // above); app servers still win over both (their names are reserved).
      ...sharedMcpServerDefs,
      ...appMcpServers,
    },
    maxTurns: config.maxTurns,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  // Persist session transcripts under dataDir (not the SDK's default ~/.claude)
  // so a conversation's session can be resumed after a server/container restart.
  // `env` REPLACES the subprocess environment. Start from process.env for SDK
  // auth/proxy settings, but strip git credentials: git auth is only available
  // through the app-managed in-process MCP bridge.
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  options.env = {
    ...agentSubprocessEnv(process.env, config.agentSessionsDir),
    // Per-key OPT-IN shell exposure (elevated runs only): `$NAME` works in
    // Bash and in anything the CLI spawns. The PostToolUse hook below redacts
    // these values from every tool output before the model sees it, and
    // non-owned lifted MCP servers get them blanked (maskEnvNames above).
    ...shellSecretEnv,
  };
  // Subscription auth: when no ANTHROPIC_API_KEY is configured, fall back to the
  // admin-pasted `claude setup-token` token (stored encrypted in app_config),
  // injecting it as CLAUDE_CODE_OAUTH_TOKEN. Precedence is API key (.env) > stored
  // subscription token, matching the authMode reported by /api/admin/system. The
  // token is decrypted only here into the subprocess env — never exposed to the
  // agent (Bash/`env` run in a separate process), same as the secret vault. We
  // also drop any empty ANTHROPIC_API_KEY left over from `.env` so it can't shadow
  // the OAuth token.
  if (!config.anthropicApiKey) {
    const oauthToken = store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    if (oauthToken) {
      delete (options.env as Record<string, string | undefined>)
        .ANTHROPIC_API_KEY;
      (
        options.env as Record<string, string | undefined>
      ).CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  // Resume the conversation's prior session so the model keeps its context.
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
    if (request.resumeSessionAt) {
      // A REWIND resumes only up to the kept row's recorded transcript entry and
      // FORKS, so the source transcript — still the resume point of every older
      // row — is never rewritten. No `resumeDropsTurn`: its guard validates ONE
      // dropped turn, and a rewind can drop many (steers and wake-ups included).
      options.resumeSessionAt = request.resumeSessionAt;
      options.forkSession = true;
    }
  }
  // Pin the model when configured (env or admin override); otherwise the SDK default.
  if (effectiveModel) {
    options.model = effectiveModel;
  }
  // Apply the user's reasoning effort when they picked one; otherwise omit it so
  // the SDK uses its default. The SDK downgrades unsupported levels per model.
  if (userEffort) {
    options.effort = userEffort;
  }
  // Every run refuses inbound cross-session messages (sessionIsolation.ts).
  // Override the autocompact trigger window when the operator set one (env
  // AUTO_COMPACT_WINDOW). Both ride the SDK `settings` option — typed
  // `string | Settings`, where `Settings.autoCompactWindow` is a real field and a
  // bare string means a settings-FILE path, so inline values go as an OBJECT and
  // the SDK serializes it into the CLI `--settings` JSON. It is NOT a top-level
  // SDK option: the pinned Options has no such field and drops unknown keys
  // silently, and `options` is a loose Record so tsc can't catch that.
  // `settingSources: []` above does not suppress it (flag settings always load),
  // and the CLI's settings schema drops out-of-range values, which is why
  // config.ts clamps to 100K–1M. Omitted → the CLI compacts near the model's
  // full context window.
  options.settings = {
    ...CROSS_SESSION_SETTINGS,
    ...(config.autoCompactWindow ? { autoCompactWindow: config.autoCompactWindow } : {}),
  };
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to this session's workspace + the avatar's plugin dirs.
  if (request.cwd) {
    options.cwd = request.cwd;
  }
  // Plugin roots are always exposed as additional readable/writable dirs; an
  // active repo workspace (#47) also adds the per-conversation scratch dir here
  // (its clone became the cwd, so the scratch must stay reachable).
  const additionalDirectories = [
    ...pluginRoots.map((root) => root.path),
    ...(request.additionalDirs ?? []),
  ];
  if (additionalDirectories.length > 0) {
    options.additionalDirectories = additionalDirectories;
  }

  // One-shot MCP handoff files (plugin secret-wrapper env, hex-ssh secrets,
  // HTTP-bridge configs). Only files a REGISTERED server's argv names are
  // written — a server shadowed by an app/shared server of the same name never
  // spawns, so its plaintext would otherwise sit there until the stale sweep.
  // The run loop calls writeMcpHandoffFiles right before EVERY query() attempt:
  // the first attempt's servers consume (delete) their files, and a model
  // fallback / self-heal retry respawns the CLI on the same options.
  const registeredMcpArgs = new Set(
    Object.values(options.mcpServers as Record<string, { args?: unknown }>).flatMap(
      (def) => (Array.isArray(def?.args) ? def.args : []),
    ),
  );
  const mcpBridgeFiles = [...lifted.bridgeFiles, ...sharedMcpBridgeFiles].filter((file) =>
    registeredMcpArgs.has(file.path),
  );
  const mcpHandoffFiles = [
    ...lifted.secretFiles.map((file) => ({ path: file, content: JSON.stringify(injectableSecretEnv) })),
    ...(sshActive && Object.keys(sshSecrets).length > 0
      ? [{ path: sshSecretsFile, content: JSON.stringify(sshSecrets) }]
      : []),
    ...mcpBridgeFiles.map((file) => ({ path: file.path, content: JSON.stringify(file.config) })),
  ].filter((file) => registeredMcpArgs.has(file.path));
  const writeMcpHandoffFiles = (): void => {
    if (mcpHandoffFiles.length === 0) {
      return;
    }
    fs.mkdirSync(mcpSecretsDir, { recursive: true, mode: 0o700 });
    for (const file of mcpHandoffFiles) {
      fs.writeFileSync(file.path, file.content, { mode: 0o600 });
    }
  };
  // Run end (every exit path): a file the CLI never consumed — an abort right
  // after query(), a crash before a server spawned — must not wait for the
  // hourly stale sweep with resolved values in it. Best-effort.
  const removeMcpHandoffFiles = (): void => {
    for (const file of mcpHandoffFiles) {
      try {
        fs.rmSync(file.path, { force: true });
      } catch {
        /* best effort — the stale sweep is the backstop */
      }
    }
  };
  // Credential-looking header values + the bridges' own redact lists
  // (mcpBridgeRedactions, shared with the pi proxies).
  const bridgeHeaderRedactions = mcpBridgeRedactions(mcpBridgeFiles);

  // PreToolUse hook: enforcement + interactivity. Runs in-process, so it can call
  // straight into the events sink and await the user.
  if (events) {
    // Redaction set: every injectable value that can actually reach a process
    // this run (shell-exposed env and/or the plugin-MCP wrapper files). Tool
    // outputs echoing one of these come back `[REDACTED:<NAME>]`.
    // The broad exposures (shell env / plugin-MCP wrapper files) hand the WHOLE
    // injectable vault to a process, so everything in it is redactable; browser
    // input exposes only the individually opted-in names, and its set is a
    // subset of the broad one, so this reads as a merge either way.
    // A bridged server holding vault values counts as a broad exposure too.
    const redactSecretEnv = {
      ...(Object.keys(shellSecretEnv).length > 0 ||
      mcpHandoffFiles.some((file) => file.path !== sshSecretsFile) ||
      mcpBridgeFiles.some((file) => file.config.redact.length > 0)
        ? injectableSecretEnv
        : browserSecretEnv),
      ...bridgeHeaderRedactions,
    };
    const hookApprovals = createHookApprovalLedger();
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            buildPreToolUseHook(
              events,
              elevated,
              config.readOnlyTools,
              headless,
              allowHeadlessTools,
              autoApprove,
              hexSshViewerClass,
              hexSshPolicy,
              // Active repo workspace (#47): block remote/branch/destructive Bash
              // git so sync/push stay app-managed; local add/commit is allowed.
              Boolean(request.activeRepoName),
              toolSkillPolicy,
              // Text-only model this run: deny image/PDF Read before it 400s the turn.
              runVisionEnabled,
              hookApprovals,
            ),
          ],
          // CLI-side budget for this hook, in SECONDS. The CLI aborts an SDK
          // callback hook after 10 minutes by default, and CLIs before 2.1.218
          // misreport that abort to the model as a USER REJECTION — fatal here,
          // because this hook legitimately parks while the owner answers the
          // permission/question modal. Pin the budget just above the run
          // registry's PROMPT_TTL_MS so the server always settles the prompt
          // first; the CLI timeout remains only a dead-man's switch.
          timeout: Math.ceil(PROMPT_TTL_MS / 1000) + 60,
        },
      ],
      ...(Object.keys(redactSecretEnv).length > 0
        ? {
            PostToolUse: [
              { hooks: [buildPostToolUseHook(redactSecretEnv)] },
            ],
          }
        : {}),
    };
    // A confirmer, not a second gate: its presence makes the SDK pass
    // `--permission-prompt-tool stdio`, without which the CLI hides
    // AskUserQuestion from this non-interactive session. It confirms only an
    // AskUserQuestion the hook above allowed and denies every other CLI-side
    // ask (see buildCanUseToolSafetyNet).
    options.canUseTool = buildCanUseToolSafetyNet(hookApprovals);
  }

  return {
    ...capabilities,
    sdk,
    options,
    // Called by the run loop before every query() attempt, and at run end.
    writeMcpHandoffFiles,
    removeMcpHandoffFiles,
  };
}
