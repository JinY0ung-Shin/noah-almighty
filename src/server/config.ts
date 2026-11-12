import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime, AppConfig, PiRuntimeConfig, UploadRelayConfig } from "./types.js";
import { DEFAULT_GITHUB_HOST, normalizeGithubHost } from "./marketplace.js";
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
        "Set AGENT_RUNTIME=pi (or remove it) and configure PI_GATEWAY_URL and PI_GATEWAY_API_KEY (docs/architecture/pi-runtime.md).",
    );
  }
  throw new Error(`AGENT_RUNTIME must be "pi" or "local" (got "${value}").`);
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
 * pi's ADMIN key, for the `/admin` panel proxy (`routes/piAdminProxy.ts`): read
 * ONLY from the file `PI_GATEWAY_ADMIN_API_KEY_FILE` names (the bundled stack
 * mounts Noah's own uid-1000 0400 copy). Unset → the proxy is off. An inline
 * `PI_GATEWAY_ADMIN_API_KEY` stops the boot: it would sit in process.env, where
 * every child Noah spawns could inherit it. Like the service key, a set but
 * unreadable/empty file stops the boot, and no message carries the key.
 */
function readPiGatewayAdminApiKey(): string | undefined {
  if (env("PI_GATEWAY_ADMIN_API_KEY")) {
    throw new Error("PI_GATEWAY_ADMIN_API_KEY is not read: put pi's admin key in a file and set PI_GATEWAY_ADMIN_API_KEY_FILE.");
  }
  const file = env("PI_GATEWAY_ADMIN_API_KEY_FILE");
  if (!file) return undefined;
  let key: string;
  try {
    key = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "read error";
    throw new Error(`PI_GATEWAY_ADMIN_API_KEY_FILE (${file}) cannot be read (${code}).`);
  }
  if (!key) throw new Error(`PI_GATEWAY_ADMIN_API_KEY_FILE (${file}) is empty.`);
  if (/\s/.test(key)) throw new Error(`PI_GATEWAY_ADMIN_API_KEY_FILE (${file}) must hold the key alone on one line.`);
  return key;
}

/**
 * pi-gateway settings, read only when `AGENT_RUNTIME=pi`. The gateway URL and
 * service key are REQUIRED there: without them every run would fail, so the
 * boot refuses instead. The models come from pi's live list (`GET /v1/models`,
 * `agent/pi/modelCatalog.ts`); the retired `PI_MODEL_MAP` and `MODEL_VISION`
 * are not read (`warnRetiredModelEnv`).
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
  const adminApiKey = readPiGatewayAdminApiKey();
  return {
    gatewayUrl,
    apiKey,
    ...(adminApiKey ? { adminApiKey } : {}),
    ...(workspacesDir ? { workspacesDir: path.resolve(workspacesDir) } : {}),
    ...(env("NOAH_MCP_PUBLIC_URL") ? { mcpPublicUrl: env("NOAH_MCP_PUBLIC_URL") } : {}),
    ...(mcpAcl ? { mcpAllowedCidrs: mcpAcl.cidrs } : {}),
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

/**
 * `TRUSTED_ORIGINS`: comma-separated origins (`scheme://host[:port]`, http or
 * https) that the same-origin gate on state-changing requests accepts as this
 * Noah's OWN address (`createCrossSiteMutationGuard`, routes/_shared.ts). The
 * operator's way out when a reverse proxy rewrites `Host` without sending
 * `X-Forwarded-Host`, so Noah cannot tell that the browser's `Origin` is itself
 * and answers every save — and every login — with 403.
 *
 * Each entry is normalized to its origin (lowercase host, default port
 * dropped, a trailing `/` tolerated). Anything else — a wildcard, a path, a
 * non-http(s) scheme, something unparsable — is returned in `invalid` and
 * ignored (the caller logs it once at boot): a typo must never widen the gate,
 * and never stop the boot of an instance that is already locked out.
 */
export function parseTrustedOrigins(raw: string): { origins: string[]; invalid: string[] } {
  const origins = new Set<string>();
  const invalid: string[] = [];
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    const plainOrigin =
      url !== null &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "" &&
      !url.hostname.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "";
    if (url && plainOrigin) origins.add(url.origin);
    else invalid.push(entry);
  }
  return { origins: [...origins], invalid };
}

/** {@link parseTrustedOrigins} of this process's `TRUSTED_ORIGINS`. */
export function loadTrustedOrigins(): { origins: string[]; invalid: string[] } {
  return parseTrustedOrigins(env("TRUSTED_ORIGINS"));
}

/**
 * `UPLOAD_RELAY_URL` + `UPLOAD_RELAY_SECRET` → the relay block, or undefined
 * when neither is set (the feature is off and the attach button keeps the
 * browser's own file dialog). Half a configuration, a URL that is not a plain
 * http(s) origin or a short secret stops the boot: a typo must not silently
 * leave the fleet on a button that uploads encrypted files.
 * `UPLOAD_RELAY_API_URL` is where THIS SERVER reaches the relay's service when
 * that differs from the browser's address (default `<url>/_api`).
 */
export function parseUploadRelayConfig(values: { url: string; apiUrl: string; secret: string }): UploadRelayConfig | undefined {
  const { url, apiUrl, secret } = values;
  if (!url && !secret && !apiUrl) return undefined;
  if (!url || !secret) {
    throw new Error("The upload relay needs both UPLOAD_RELAY_URL and UPLOAD_RELAY_SECRET (set both, or neither to turn it off).");
  }
  if (secret.length < 32) throw new Error("UPLOAD_RELAY_SECRET must be at least 32 characters.");
  const origin = parseHttpUrl(url, "UPLOAD_RELAY_URL");
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("UPLOAD_RELAY_URL must be an origin only (scheme://host[:port], no path).");
  }
  const api = apiUrl ? parseHttpUrl(apiUrl, "UPLOAD_RELAY_API_URL") : null;
  if (api && (api.search || api.hash)) throw new Error("UPLOAD_RELAY_API_URL must not carry a query or fragment.");
  return {
    url: origin.origin,
    apiUrl: api ? `${api.origin}${api.pathname.replace(/\/+$/, "")}` : `${origin.origin}/_api`,
    secret,
  };
}

function parseHttpUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${name} must be an http(s) URL.`);
  if (parsed.username || parsed.password) throw new Error(`${name} must not carry credentials.`);
  return parsed;
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
  // An override (tests) supplies its own relay block; only the env path validates.
  const uploadRelay =
    overrides.uploadRelay ??
    parseUploadRelayConfig({
      url: env("UPLOAD_RELAY_URL"),
      apiUrl: env("UPLOAD_RELAY_API_URL"),
      secret: env("UPLOAD_RELAY_SECRET"),
    });

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
    // Off unless both the URL and the secret are set; half a configuration
    // stops the boot (parseUploadRelayConfig).
    ...(uploadRelay ? { uploadRelay } : {}),
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
