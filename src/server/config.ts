import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime, AppConfig, PiModelMapping, PiRuntimeConfig } from "./types.js";
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./marketplace.js";
import { MODEL_TIER_IDS } from "./modelTiers.js";
import { parseMcpNetworkAcl } from "./mcpHttp/networkAcl.js";
import { assertProcFdPinning } from "./pinnedFs.js";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

/**
 * `AGENT_RUNTIME`: `pi` (default — pi-gateway is the only agent runtime) or
 * `local` (the deterministic stub the tests and the e2e harness use). The
 * Claude Agent SDK runner is removed: `claude` (and anything else) stops the
 * boot with the fix named, instead of silently running something else.
 */
function parseRuntime(value: string): AgentRuntime {
  const runtime = value.trim().toLowerCase();
  if (runtime === "" || runtime === "pi") return "pi";
  if (runtime === "local") return "local";
  if (runtime === "claude") {
    throw new Error(
      "AGENT_RUNTIME=claude is no longer supported: the Claude Agent SDK runner was removed and pi-gateway is the only agent runtime. " +
        "Set AGENT_RUNTIME=pi (or remove it) and configure PI_GATEWAY_URL, PI_GATEWAY_API_KEY and PI_MODEL_MAP (docs/architecture/pi-runtime.md).",
    );
  }
  throw new Error(`AGENT_RUNTIME must be "pi" or "local" (got "${value}").`);
}

/**
 * `PI_MODEL_MAP`: a JSON object from a composer tier (or a concrete model id an
 * admin override pins) to the pi model a NEW pi session uses — a model id
 * string, or `{ "model": "<id>", "contextWindow": <tokens> }`. It is the ONLY
 * tier → model source (a routine's fallback chain walks the tiers through it
 * too), so it is REQUIRED and must map every composer tier; a typo or a gap
 * would silently run sessions on pi's default model, so anything malformed or
 * missing stops the boot instead of being dropped.
 */
export function parsePiModelMap(value: string): Record<string, PiModelMapping> {
  if (!value) {
    throw new Error(
      `AGENT_RUNTIME=pi requires PI_MODEL_MAP: a JSON object mapping every composer tier (${MODEL_TIER_IDS.join(", ")}) to a pi model id, e.g. {"opus":"anthropic/claude-opus-5-5",…}.`,
    );
  }
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
  const missing = MODEL_TIER_IDS.filter((tier) => !map[tier]);
  if (missing.length > 0) {
    throw new Error(`PI_MODEL_MAP must map every composer tier; missing: ${missing.join(", ")}.`);
  }
  return map;
}

/**
 * pi's service key: inline in `PI_GATEWAY_API_KEY`, or read from the file
 * `PI_GATEWAY_API_KEY_FILE` names (the bundled compose stack mounts a compose
 * secret at /run/secrets/pi_gateway_api_key and never puts the key in .env).
 * Both set is ambiguous, and an unreadable or empty file would only fail every
 * run later, so each stops the boot. The key read from a file is never written
 * to process.env, and no message here ever carries it.
 */
function readPiGatewayApiKey(): string {
  const inline = env("PI_GATEWAY_API_KEY");
  const file = env("PI_GATEWAY_API_KEY_FILE");
  if (inline && file) {
    throw new Error("Set PI_GATEWAY_API_KEY or PI_GATEWAY_API_KEY_FILE, not both.");
  }
  if (!file) return inline;
  let key: string;
  try {
    key = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`PI_GATEWAY_API_KEY_FILE (${file}) cannot be read (${code}).`);
  }
  if (!key) throw new Error(`PI_GATEWAY_API_KEY_FILE (${file}) is empty.`);
  // It becomes an Authorization header value: a second line or inner blank is a wrong file.
  if (/\s/.test(key)) throw new Error(`PI_GATEWAY_API_KEY_FILE (${file}) must hold the key alone on one line.`);
  return key;
}

/**
 * pi-gateway settings, read only when `AGENT_RUNTIME=pi`. The gateway URL,
 * service key and model map are REQUIRED there: without them every run would
 * fail, so the boot refuses instead.
 */
function loadPiRuntimeConfig(): PiRuntimeConfig {
  const gatewayUrl = env("PI_GATEWAY_URL");
  const apiKey = readPiGatewayApiKey();
  if (!gatewayUrl || !apiKey) {
    throw new Error(
      "AGENT_RUNTIME=pi requires PI_GATEWAY_URL and PI_GATEWAY_API_KEY (or PI_GATEWAY_API_KEY_FILE).",
    );
  }
  try {
    new URL(gatewayUrl);
  } catch {
    throw new Error("PI_GATEWAY_URL must be an absolute URL (e.g. http://pi-gateway:8080).");
  }
  // Sandbox folders are only ever touched through descriptor pinning.
  assertProcFdPinning();
  const workspacesDir = env("PI_WORKSPACES_DIR");
  // Validated here so a typo fails the boot instead of opening or closing /mcp.
  const mcpAcl = parseMcpNetworkAcl(env("NOAH_MCP_ALLOWED_CIDRS"));
  return {
    gatewayUrl,
    apiKey,
    ...(workspacesDir ? { workspacesDir: path.resolve(workspacesDir) } : {}),
    ...(env("NOAH_MCP_PUBLIC_URL") ? { mcpPublicUrl: env("NOAH_MCP_PUBLIC_URL") } : {}),
    ...(mcpAcl ? { mcpAllowedCidrs: mcpAcl.cidrs } : {}),
    modelMap: parsePiModelMap(env("PI_MODEL_MAP")),
    deckSandbox: ["true", "1", "on"].includes(env("PI_DECK_SANDBOX").toLowerCase()),
  };
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

  const agentRuntime = overrides.agentRuntime ?? parseRuntime(process.env.AGENT_RUNTIME ?? "");

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
    // The removed SDK runner's CLI transcripts — read only by the boot
    // retirement that quarantines them (retireAgentSessions.ts).
    agentSessionsDir: path.join(dataDir, "agent-sessions"),
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
    // Upstream command used by the app's hex-ssh policy proxy. Installed into
    // the image at build time and exposed under this fixed name (see Dockerfile).
    // Override with HEX_SSH_COMMAND when the global bin isn't available.
    hexSshCommand: env("HEX_SSH_COMMAND", "hex-ssh-mcp"),
    // MODEL_VISION=off marks the serving backend as text-only: image uploads and
    // Confluence image blocks are cut off BEFORE they can 400 a whole turn.
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
