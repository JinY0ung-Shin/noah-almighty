// Single source of truth for RESERVED secret env names — the names whose
// values have app-dedicated routing and must NEVER ride the generic injection
// paths (agent shell env / plugin MCP servers):
//  - git credentials are used server-side only ("git remote work is MCP-only
//    BY DESIGN", root CLAUDE.md) — reaching any agent-adjacent process would
//    hand out push rights;
//  - SSH material flows exclusively to the app-pinned hex-ssh subprocess.
//
// LEAF MODULE on purpose: no imports, so the Svelte client can import it
// directly (like experimentalFeatures.ts) to hide the per-secret "셸 노출"
// toggle for reserved names. The two git-token literals mirror
// INTERNAL/EXTERNAL_GIT_TOKEN_SECRET_NAME in gitCredentials.ts — a unit test
// pins them together so they can't drift.

export const GIT_CREDENTIAL_ENV_NAMES = [
  "GIT_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

export const SSH_MCP_SECRET_ENV_NAMES = [
  "SSH_PRIVATE_KEY",
  "SSH_PASSPHRASE",
  "SSH_PASSWORD",
  "SSH_USER",
  "SSH_USERNAME",
  "ALLOWED_HOSTS",
  "ALLOWED_HOST_FINGERPRINTS",
] as const;

/**
 * Server-only secrets read from the environment at boot. SESSION_SECRET is the
 * AES-256-GCM master key for every user's at-rest secrets. No agent-adjacent
 * process may ever hold them: `agentSubprocessEnv` strips them per spawn, and the server
 * deletes them from its own `process.env` once the config has read them, so no
 * child process it starts afterwards (git, converters, CLIs) inherits them (#71).
 */
export const SERVER_ONLY_SECRET_ENV_NAMES = ["SESSION_SECRET"] as const;

/** Delete {@link SERVER_ONLY_SECRET_ENV_NAMES} from `env` in place. */
export function scrubServerOnlySecretEnv(env: Record<string, string | undefined>): void {
  for (const name of SERVER_ONLY_SECRET_ENV_NAMES) {
    delete env[name];
  }
}

export const RESERVED_SECRET_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...GIT_CREDENTIAL_ENV_NAMES,
  ...SSH_MCP_SECRET_ENV_NAMES,
]);

/**
 * True when a secret name may be exposed beyond its dedicated consumer —
 * i.e. injected into the owner's plugin MCP servers and (per-key opt-in)
 * exported into the agent shell env.
 */
export function isShellExposableSecret(name: string): boolean {
  return !RESERVED_SECRET_ENV_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Browser secret input (브라우저 입력) — per-secret policy for typing a stored
// secret into the owner's OWN browser through the extension bridge
// (`mcp__browser__type` / `fill_form` `secretName`). The MODEL never sees the
// value: it names the secret, the server resolves it, the extension types it.
//
// The policy is the prompt-injection defence, so it is enforced at BOTH ends:
// the server pre-checks the last tab URL it saw, and the extension re-checks the
// tab it is about to type into. Exact hostnames only — no wildcards — because an
// over-broad match is exactly how a phishing page on a sibling host would get the
// value. Reserved git/SSH names can never be browser-typed (same line as shell
// exposure).
// ---------------------------------------------------------------------------

export interface BrowserSecretPolicy {
  /** Secret env-name (`user_secrets.name`). */
  name: string;
  /** Exact, lowercase hostnames (no scheme/port/path) the secret may be typed on. Never empty when enabled. */
  hosts: string[];
  /** True = only into an `<input type=password>`; false = any text control. */
  passwordOnly: boolean;
}

/** Cap on allowed hosts per secret — an SSO redirect chain rarely needs more than a handful. */
export const MAX_BROWSER_SECRET_HOSTS = 20;

// RFC 1123-ish hostname: labels of [a-z0-9-] (no leading/trailing hyphen), dots
// between, ≤253 chars overall. Covers IPv4 literals and `localhost`; IPv6 is
// deliberately not accepted.
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * One user-entered host → a canonical lowercase hostname, or null when it is not
 * one. Tolerates a pasted URL or `host:port` (the hostname is extracted), a
 * trailing dot, and surrounding whitespace; rejects wildcards, paths, empty input.
 */
export function normalizeBrowserSecretHost(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed || /[\s*]/.test(trimmed)) return null;
  let hostname = trimmed;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  return HOSTNAME_RE.test(hostname) ? hostname : null;
}

/**
 * A user-entered host list → unique canonical hostnames, or null when the input
 * is not an array, exceeds MAX_BROWSER_SECRET_HOSTS, or contains an invalid entry
 * (all-or-nothing: a silently dropped typo would leave the user believing a site
 * is allowed when it is not).
 */
export function normalizeBrowserSecretHosts(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_BROWSER_SECRET_HOSTS) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return null;
    const host = normalizeBrowserSecretHost(entry);
    if (!host) return null;
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

/** Exact (case-insensitive, trailing-dot-insensitive) match of a tab hostname against the policy. */
export function browserSecretHostAllowed(tabHostname: string, policy: Pick<BrowserSecretPolicy, "hosts">): boolean {
  const host = String(tabHostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  return host.length > 0 && policy.hosts.some((allowed) => allowed === host);
}

/** True when a secret name may be typed into the owner's browser at all (reserved git/SSH names never). */
export function isBrowserExposableSecret(name: string): boolean {
  return isShellExposableSecret(name);
}
