import path from "node:path";
import type { AgentRuntime, AppConfig, PiModelMapping, PiRuntimeConfig } from "./types.js";
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./marketplace.js";
import { MODEL_TIER_IDS } from "./modelTiers.js";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function parseRuntime(value: string): AgentRuntime {
  return value === "local" ? "local" : value === "pi" ? "pi" : "claude";
}

/**
 * `PI_MODEL_MAP`: a JSON object from a composer tier (or a concrete model id an
 * admin override pins) to the pi model a NEW pi session uses — a model id
 * string, or `{ "model": "<id>", "contextWindow": <tokens> }`. A typo here would
 * silently run every session on pi's default model, so anything malformed
 * stops the boot instead of being dropped.
 */
export function parsePiModelMap(value: string): Record<string, PiModelMapping> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("PI_MODEL_MAP must be a JSON object (tier → pi model id).");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PI_MODEL_MAP must be a JSON object (tier → pi model id).");
  }
  const map: Record<string, PiModelMapping> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const tier = key.trim();
    if (!tier) throw new Error("PI_MODEL_MAP has an empty key.");
    if (typeof entry === "string" && entry.trim()) {
      map[tier] = { model: entry.trim() };
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const { model, contextWindow } = entry as { model?: unknown; contextWindow?: unknown };
      const windowOk =
        contextWindow === undefined ||
        (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0);
      if (typeof model === "string" && model.trim() && windowOk) {
        map[tier] = {
          model: model.trim(),
          ...(typeof contextWindow === "number" ? { contextWindow } : {}),
        };
        continue;
      }
    }
    throw new Error(
      `PI_MODEL_MAP["${tier}"] must be a model id string or {"model": "<id>", "contextWindow": <positive integer>}.`,
    );
  }
  return map;
}

/**
 * pi-gateway settings, read only when `AGENT_RUNTIME=pi`. The gateway URL and
 * service key are REQUIRED there: without them every owner turn would fail, so
 * the boot refuses rather than silently running the SDK.
 */
function loadPiRuntimeConfig(): PiRuntimeConfig {
  const gatewayUrl = env("PI_GATEWAY_URL");
  const apiKey = env("PI_GATEWAY_API_KEY");
  if (!gatewayUrl || !apiKey) {
    throw new Error("AGENT_RUNTIME=pi requires PI_GATEWAY_URL and PI_GATEWAY_API_KEY.");
  }
  try {
    new URL(gatewayUrl);
  } catch {
    throw new Error("PI_GATEWAY_URL must be an absolute URL (e.g. http://pi-gateway:8080).");
  }
  const workspacesDir = env("PI_WORKSPACES_DIR");
  return {
    gatewayUrl,
    apiKey,
    ...(workspacesDir ? { workspacesDir: path.resolve(workspacesDir) } : {}),
    ...(env("NOAH_MCP_PUBLIC_URL") ? { mcpPublicUrl: env("NOAH_MCP_PUBLIC_URL") } : {}),
    modelMap: parsePiModelMap(env("PI_MODEL_MAP")),
    deckSandbox: ["true", "1", "on"].includes(env("PI_DECK_SANDBOX").toLowerCase()),
  };
}

// Bounds the CLI's settings schema accepts for `autoCompactWindow`. Out-of-range
// values are SILENTLY DROPPED there (`.catch(undefined)`), not rejected, so we
// clamp into range rather than pass through, and ignore non-numeric/≤0.
const AUTO_COMPACT_WINDOW_MIN = 100_000;
const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

function parseAutoCompactWindow(value: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(AUTO_COMPACT_WINDOW_MAX, Math.max(AUTO_COMPACT_WINDOW_MIN, Math.round(n)));
}

function parseMinutes(value: string, fallbackMinutes: number): number {
  if (!value) {
    return Math.round(fallbackMinutes * 60_000);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return Math.round(fallbackMinutes * 60_000);
  }
  return Math.round(n * 60_000);
}

// setTimeout's delay is a 32-bit signed int: Node fires anything longer after
// 1 ms, so an "effectively unlimited" deadline would abort every run at once.
const MAX_TIMER_MS = 2_147_483_647;

/** A whole number >= 1, else the fallback (empty, junk, 0, negative, 2.5). */
function parsePositiveInt(value: string, fallback: number): number {
  const n = Number(value);
  return value && Number.isInteger(n) && n >= 1 ? n : fallback;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const dataDir = overrides.dataDir ?? env("APP_DATA_DIR", path.join(process.cwd(), "data"));
  const githubHost = normalizeGithubHost(overrides.githubHost ?? env("GITHUB_HOST", DEFAULT_GITHUB_HOST));

  const sessionSecret =
    overrides.sessionSecret ?? env("SESSION_SECRET", isProduction ? "" : "dev-session-secret");
  if (!sessionSecret && isProduction) {
    throw new Error("SESSION_SECRET is required in production.");
  }

  const agentRuntime = overrides.agentRuntime ?? parseRuntime(env("AGENT_RUNTIME", "claude"));

  const readOnlyTools = env("READONLY_TOOLS", "Read,Glob,Grep")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  // Concrete model id each composer TIER maps to, from the operator's
  // ANTHROPIC_DEFAULT_<TIER>_MODEL env (e.g. ANTHROPIC_DEFAULT_OPUS_MODEL). Keyed
  // by the modelTiers alias so it stays in sync with the registry. A tier with no
  // env mapping is omitted — the SDK then resolves the alias to the account/tier
  // default, which the app can't know, so we surface only what's explicitly pinned.
  const defaultTierModels: Record<string, string> = {};
  for (const id of MODEL_TIER_IDS) {
    const value = env(`ANTHROPIC_DEFAULT_${id.toUpperCase()}_MODEL`);
    if (value) defaultTierModels[id] = value;
  }

  return {
    // `|| 48787` guards a typo'd PORT (NaN would ERR_SOCKET_BAD_PORT at boot).
    port: Number(env("PORT", "48787")) || 48787,
    egressControlUrl: env("NOAH_EGRESS_CONTROL_URL") || undefined,
    tlsCertFile: env("TLS_CERT_FILE") || undefined,
    tlsKeyFile: env("TLS_KEY_FILE") || undefined,
    dataDir,
    dbPath: path.join(dataDir, "noah-almighty.db"),
    sessionSecret,
    agentRuntime,
    // An override (tests) supplies its own pi block; only the env path validates.
    ...(agentRuntime === "pi" && !overrides.pi ? { pi: loadPiRuntimeConfig() } : {}),
    anthropicApiKey: env("ANTHROPIC_API_KEY") || undefined,
    anthropicModel: env("ANTHROPIC_MODEL") || undefined,
    defaultTierModels,
    readOnlyTools,
    githubHost,
    confluenceUrl: env("CONFLUENCE_URL") || undefined,
    // Default browser-control allowlist, seeded into browsers whose extension
    // allowlist is still empty (see AppConfig). Normalized here once; the
    // self-host filtering happens per request, where Noah's host is known.
    browserDefaultAllowedOrigins: [
      ...new Set(
        env("BROWSER_ALLOWED_ORIGINS", "")
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean),
      ),
    ],
    githubCaCert: env("GITHUB_CA_CERT") || undefined,
    // Repo-bundled default skills, loaded for every avatar. cwd-based to match
    // dataDir; cwd is the app root under both `tsx` (dev) and `node dist` (prod).
    defaultPluginsDir: env("DEFAULT_PLUGINS_DIR", path.join(process.cwd(), "default-skills")),
    // Avoid stale avatar plugins on long-lived server processes while keeping
    // chat startup from fetching on every turn. Set 0 to disable automatic refresh.
    pluginAutoRefreshIntervalMs: parseMinutes(env("PLUGIN_AUTO_REFRESH_MINUTES"), 10),
    // SDK session transcripts (the subprocess's CLAUDE_CONFIG_DIR). Under dataDir
    // so a conversation's resumable session survives a server/container restart.
    agentSessionsDir: path.join(dataDir, "agent-sessions"),
    // Generous default: tool/skill/subagent-heavy replies blow past a handful of
    // turns. Override via MAX_TURNS; values <1 fall back to the default.
    maxTurns: Math.max(1, Number(env("MAX_TURNS", "1000")) || 1000),
    // Whole-run budget for an unattended routine (see AppConfig). Clamped to >=1
    // minute: parseMinutes maps "0" to 0ms, which here would abort every run
    // instantly instead of meaning "no deadline" as it does for plugin refresh.
    routineRunTimeoutMs: Math.max(60_000, parseMinutes(env("ROUTINE_RUN_TIMEOUT_MINUTES"), 30)),
    // Routine scheduler concurrency (see AppConfig): how many routines may be in
    // flight at once, server-wide and per owner.
    routineMaxConcurrentRuns: parsePositiveInt(env("ROUTINE_MAX_CONCURRENT_RUNS"), 10),
    routineMaxConcurrentRunsPerUser: parsePositiveInt(env("ROUTINE_MAX_CONCURRENT_RUNS_PER_USER"), 2),
    // The external task API's own budget (see AppConfig). Same floor as the
    // routine deadline above, plus a ceiling: this is the knob operators set to
    // hours or days.
    avatarTaskRunTimeoutMs: Math.min(
      MAX_TIMER_MS,
      Math.max(60_000, parseMinutes(env("AVATAR_TASK_TIMEOUT_MINUTES"), 300)),
    ),
    // Optional: compact the conversation near this many context tokens instead
    // of waiting for the model's full window. Unset → SDK/CLI default.
    autoCompactWindow: parseAutoCompactWindow(env("AUTO_COMPACT_WINDOW")),
    // Upstream command used by the app's hex-ssh policy proxy. Installed into
    // the image at build time and exposed under this fixed name (see Dockerfile).
    // Override with HEX_SSH_COMMAND when the global bin isn't available.
    hexSshCommand: env("HEX_SSH_COMMAND", "hex-ssh-mcp"),
    // MODEL_VISION=off marks the serving backend as text-only: image uploads,
    // image/PDF Read, and Confluence image blocks are all cut off BEFORE they
    // can 400 a whole turn at the API layer.
    visionEnabled: env("MODEL_VISION", "on").trim().toLowerCase() !== "off",
    // Corp-policy line in the browser-bridge install guide pointing the unzip
    // step at the upload-approved "Multimedia" folder. Hidden unless the
    // operator opts in.
    browserBridgeMultimediaNotice: ["true", "1", "on"].includes(
      env("BROWSER_BRIDGE_MULTIMEDIA_NOTICE").toLowerCase(),
    ),
    ...overrides,
    // dbPath/agentSessionsDir need no re-spread: `dataDir` above is already
    // `overrides.dataDir ?? env(...)`, so both derive from the overridden value
    // unless the caller supplied them explicitly (in which case ...overrides
    // wins). githubHost DOES need it — ...overrides would put the caller's RAW
    // value back where the normalized one belongs.
    ...(overrides.githubHost !== undefined ? { githubHost } : {}),
  };
}
