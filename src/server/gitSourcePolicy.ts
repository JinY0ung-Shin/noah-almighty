// Source POLICY for a user-registered git repository (`mcp__git_repo__register_repo`
// and every later clone/sync/push of what it registered — gitRepos.ts).
//
// Noah clones a registered repository in ITS OWN container: the one that holds
// the database, every user's clones, the team-brain vault and the secrets. So
// the source an owner names decides what Noah's own git reads or connects to:
//
// - a LOCAL path inside Noah's own directories is another user's clone or
//   working copy, the team-brain vault, a knowledge repo… — cloning it hands
//   their content to whoever registered it;
// - a URL whose host is loopback, link-local (cloud metadata) or 0.0.0.0/8 makes
//   Noah's git speak to Noah's own host or to the hosting platform.
//
// Arg-safety (`assertSafeGitValue`, repoGitGuards.ts) stays a separate layer and
// keeps accepting local paths: a bare local repository OUTSIDE Noah's
// directories is a legitimate source (offline tests clone from one), and the
// deployment's internal git host lives on a private (RFC 1918) address — both
// stay allowed. Mechanics: docs/architecture/repo-knowledge.md.

import dnsPromises from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { gitHostFromSource } from "./gitCredentials.js";
import { normalizeGithubHost, type GitConfigPairs } from "./marketplace.js";
import type { AppConfig } from "./types.js";

/** What the policy reads from the app config. */
export type GitSourcePolicyConfig = Pick<AppConfig, "dataDir" | "githubHost" | "defaultPluginsDir" | "pi"> &
  Partial<Pick<AppConfig, "egressControlUrl">>;

/** A resolver with `dns.promises.lookup(host, { all: true })`'s shape (injectable in tests). */
export type GitSourceLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface GitSourcePolicyOptions {
  /**
   * Also RESOLVE a host name and refuse when any address it returns is in a
   * blocked class. Set on the paths that are about to use the network (clone,
   * sync, push); the static checks (local path, literal address, `localhost`)
   * run on every use.
   */
  resolve?: boolean;
  lookup?: GitSourceLookup;
  /** How long to wait for the resolver before letting git report its own error. */
  lookupTimeoutMs?: number;
  /** The environment whose proxy settings git will see (default: Noah's own). */
  env?: NodeJS.ProcessEnv;
}

export interface AllowedGitSource {
  kind: "local" | "remote";
  /**
   * Command-scoped git config for a transfer from/to this source (rides
   * `serverGitEnv`, next to the auth header). For an http(s) host that is NOT
   * the configured git host: redirects are not followed (a redirect could
   * point git at an address this policy just refused), and the connection is
   * pinned to the addresses that were checked (`http.curloptResolve`), so a
   * second DNS answer cannot move it. Empty for everything else.
   */
  gitConfig: GitConfigPairs;
}

/** Why a source was refused — what the user-facing (Korean) wording keys on. */
export type GitSourceRefusalCode = "local_path" | "blocked_host" | "internal_service" | "unreadable";

/**
 * Thrown for a source the policy refuses. Its message is the agent-facing
 * (English) tool error; a user-facing surface renders {@link gitSourceRefusalKorean}.
 */
export class GitSourceRefusedError extends Error {
  constructor(
    message: string,
    readonly code: GitSourceRefusalCode,
  ) {
    super(message);
    this.name = "GitSourceRefusedError";
  }
}

/**
 * The user-facing (Korean) sentence for a refusal — HTTP `apiError`s and UI
 * warnings; the English `message` stays for the agent. It names the kind of
 * source that was refused, never a server path or an address.
 */
export function gitSourceRefusalKorean(error: GitSourceRefusedError): string {
  const allowed = "사내 git 호스트의 owner/repo 또는 외부에서 접근할 수 있는 git/https 주소를 입력해 주세요.";
  switch (error.code) {
    case "local_path":
      return `Noah 서버 내부 경로는 저장소 주소로 쓸 수 없습니다. ${allowed}`;
    case "blocked_host":
      return `서버 자신을 가리키는 주소(loopback·link-local·0.0.0.0)는 저장소 주소로 쓸 수 없습니다. ${allowed}`;
    case "internal_service":
      return `Noah 내부 서비스의 주소는 저장소 주소로 쓸 수 없습니다. ${allowed}`;
    case "unreadable":
      return "저장소 주소의 호스트를 읽을 수 없습니다. 주소를 다시 확인해 주세요.";
  }
}

/** The source as it may be quoted back: credentials in the URL are never echoed. */
function shownSource(source: string): string {
  const redacted = source.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
  return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted;
}

function refuse(source: string, reason: string, config: GitSourcePolicyConfig, code: GitSourceRefusalCode): never {
  throw new GitSourceRefusedError(
    `Refused git source '${shownSource(source)}': ${reason}. Noah clones a registered repository inside its own server, so the source must be one of: ` +
      `owner/repo on the configured git host (${normalizeGithubHost(config.githubHost)}); ` +
      `an https, http, ssh or git URL whose host is not a loopback, link-local (169.254.0.0/16, fe80::/10) or 0.0.0.0/8 address and not one of Noah's own internal services — a private-network host is fine; ` +
      `or a local repository path outside Noah's own directories. Nothing was cloned, fetched or pushed. ` +
      `Do not work around this with Bash \`git clone\` — the shell has no git credentials.`,
    code,
  );
}

// ---- Addresses ---------------------------------------------------------------

/**
 * An IPv4 address in ANY textual form the transports accept (`inet_aton`, which
 * libcurl, OpenSSH and the WHATWG URL parser all follow): 1–4 dot-separated
 * parts, each decimal, octal (leading `0`) or hex (`0x`), the last part filling
 * the remaining bytes — `2130706433`, `0x7f.1`, `0177.0.0.1`, `127.1` are all
 * 127.0.0.1. Null when the host is not such a number (it is a name).
 */
export function parseLooseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]*$/i.test(part)) value = part.length === 2 ? 0 : Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]*$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^[1-9][0-9]*$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value)) return null;
    values.push(value);
  }
  const last = values.pop()!;
  if (values.some((value) => value > 255)) return null;
  if (last >= 256 ** (4 - values.length)) return null;
  const bytes = [...values];
  for (let shift = 3 - values.length; shift >= 0; shift -= 1) {
    bytes.push(Math.floor(last / 256 ** shift) % 256);
  }
  return bytes as [number, number, number, number];
}

/** The 16 bytes of an IPv6 literal (no brackets; a `%zone` is ignored), or null. */
export function parseIPv6(host: string): number[] | null {
  const literal = host.split("%", 1)[0] ?? "";
  if (!net.isIPv6(literal)) return null;
  const groupsOf = (text: string): number[] | null => {
    if (text === "") return [];
    const out: number[] = [];
    const pieces = text.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (piece.includes(".")) {
        // An embedded dotted IPv4 tail — only valid as the last piece.
        if (index !== pieces.length - 1 || !net.isIPv4(piece)) return null;
        const v4 = piece.split(".").map((part) => Number.parseInt(part, 10));
        out.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const head = groupsOf(halves[0] ?? "");
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

/** The always-blocked class an IPv4 address is in, or null. RFC 1918 and every other range pass. */
function blockedIPv4Class(bytes: readonly number[]): string | null {
  if (bytes[0] === 0) return "a 0.0.0.0/8 (\"this host\") address";
  if (bytes[0] === 127) return "a loopback address";
  if (bytes[0] === 169 && bytes[1] === 254) return "a link-local address (169.254.0.0/16 — cloud metadata lives there)";
  return null;
}

/** The always-blocked class an IPv6 address is in — including the IPv4 address it embeds — or null. */
function blockedIPv6Class(bytes: readonly number[]): string | null {
  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  if (zero(0, 16)) return "the unspecified address (::)";
  if (zero(0, 15) && bytes[15] === 1) return "a loopback address";
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "a link-local address (fe80::/10)";
  const embedded =
    // IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d
    (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) ||
    zero(0, 12) ||
    (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12));
  if (embedded) {
    const inner = blockedIPv4Class(bytes.slice(12, 16));
    if (inner) return `${inner} in its IPv6 form`;
  }
  return null;
}

/** The blocked class of a numeric address in any accepted spelling; null when it is allowed OR not numeric. */
function blockedAddressClass(host: string): string | null {
  const v6 = parseIPv6(host);
  if (v6) return blockedIPv6Class(v6);
  const v4 = parseLooseIPv4(host);
  return v4 ? blockedIPv4Class(v4) : null;
}

function isNumericAddress(host: string): boolean {
  return parseIPv6(host) !== null || parseLooseIPv4(host) !== null;
}

/** A host as written → comparable: brackets, one trailing dot and case removed. */
function foldHostname(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
}

/** The blocked class of a host that needs no lookup to judge (numeric, or a `localhost` name); else null. */
function staticBlockedClass(host: string): string | null {
  const numeric = blockedAddressClass(host);
  if (numeric) return numeric;
  if (host === "localhost" || host.endsWith(".localhost")) return "a loopback name";
  return null;
}

/**
 * One spelling per host, so two ways of writing the same address compare equal:
 * a numeric IPv4 in any form → dotted quad, an IPv6 literal → its 16 bytes (an
 * IPv4-mapped one → the IPv4 it carries), a name → itself (already folded).
 */
function canonicalHost(host: string): string {
  const v6 = parseIPv6(host);
  if (v6) {
    const mapped = v6.slice(0, 10).every((byte) => byte === 0) && v6[10] === 0xff && v6[11] === 0xff;
    return mapped ? v6.slice(12).join(".") : `v6:${v6.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  const v4 = parseLooseIPv4(host);
  return v4 ? v4.join(".") : host;
}

/**
 * The internal services Noah itself is configured to talk to — pi-gateway
 * (`PI_GATEWAY_URL`), the address pi's broker reaches Noah's `/mcp` at
 * (`NOAH_MCP_PUBLIC_URL`) and the egress policy controller
 * (`NOAH_EGRESS_CONTROL_URL`) — as canonical host + port. They sit on private
 * addresses, which the address classes allow on purpose (the internal git host
 * is private too), so they are refused by identity: a registered source must
 * never make Noah's git send a request to them. The configured git host is
 * judged before this list and wins when it shares a host[:port] with one.
 */
function internalServices(config: GitSourcePolicyConfig): { host: string; port: number | null }[] {
  const services: { host: string; port: number | null }[] = [];
  for (const raw of [config.pi?.gatewayUrl, config.pi?.mcpPublicUrl, config.egressControlUrl]) {
    if (!raw) continue;
    try {
      const url = new URL(raw);
      const host = canonicalHost(foldHostname(url.hostname));
      if (!host) continue;
      const scheme = url.protocol.replace(/:$/, "").toLowerCase();
      services.push({ host, port: url.port ? Number.parseInt(url.port, 10) : (DEFAULT_PORTS[scheme] ?? null) });
    } catch {
      // Not a URL: nothing to match.
    }
  }
  return services;
}

// ---- Source shapes -----------------------------------------------------------

interface RemoteSource {
  kind: "remote";
  /** Every reading of the host that a transport might act on (as written, percent-decoded, WHATWG-parsed). */
  hosts: string[];
  /** Lowercase scheme, or null for the scp-like `[user@]host:path` form (ssh). */
  scheme: string | null;
  /** The port the transport will connect to (written, or the scheme's default); null for an unknown scheme. */
  port: number | null;
}
type ParsedSource = RemoteSource | { kind: "local"; paths: string[] } | { kind: "unreadable" };

const URL_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** The port a transport uses when the source names none. */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  http: 80,
  https: 443,
  ssh: 22,
  "git+ssh": 22,
  "ssh+git": 22,
  git: 9418,
  ftp: 21,
  ftps: 990,
};

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Read a source the way git will. git and Node's URL parser disagree on where
 * an authority ends (gitCredentials.ts, `gitHostFromSource`), so a URL host is
 * taken BOTH ways and every reading is judged; a URL with a backslash,
 * whitespace or a control character has no trustworthy reading at all.
 */
function parseSource(source: string): ParsedSource {
  const scheme = URL_SCHEME_RE.exec(source)?.[1]?.toLowerCase();
  if (scheme === "file") {
    // git drops the host of a file:// URL and uses the (percent-decoded) path.
    const afterScheme = source.slice("file://".length);
    const slash = afterScheme.indexOf("/");
    if (slash < 0) return { kind: "unreadable" };
    const raw = afterScheme.slice(slash);
    const plain = decoded(raw);
    return { kind: "local", paths: plain !== null && plain !== raw ? [raw, plain] : [raw] };
  }
  if (scheme) {
    if (/[\\\s\u0000-\u001f\u007f]/.test(source)) return { kind: "unreadable" };
    const authority = source.slice(source.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
    const gitHostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const gitHost = gitHostPort.replace(/:\d*$/, "");
    if (!gitHost) return { kind: "unreadable" };
    const hosts = new Set<string>([foldHostname(gitHost)]);
    // git percent-decodes an ssh/git URL before it reads the host.
    const plain = decoded(gitHost);
    if (plain === null) return { kind: "unreadable" };
    hosts.add(foldHostname(plain));
    let port: number | null = null;
    try {
      const url = new URL(source);
      if (url.hostname) hosts.add(foldHostname(url.hostname));
      port = url.port ? Number.parseInt(url.port, 10) : (DEFAULT_PORTS[scheme] ?? null);
    } catch {
      // Node cannot read it; git's own reading above is still judged.
      const written = /:(\d+)$/.exec(gitHostPort)?.[1];
      port = written ? Number.parseInt(written, 10) : (DEFAULT_PORTS[scheme] ?? null);
    }
    return { kind: "remote", hosts: [...hosts].filter(Boolean), scheme, port };
  }
  // No scheme: git reads `[user@]host:path` as ssh when a colon comes before the first slash.
  const colon = source.indexOf(":");
  const slash = source.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return { kind: "local", paths: [source] };
  if (/[\\\s\u0000-\u001f\u007f]/.test(source)) return { kind: "unreadable" };
  const afterUser = source.slice(source.slice(0, colon).lastIndexOf("@") + 1);
  let host: string;
  let port = DEFAULT_PORTS.ssh;
  if (afterUser.startsWith("[")) {
    // `[::1]:path` or `[host:port]:path`.
    const close = afterUser.indexOf("]");
    if (close < 0) return { kind: "unreadable" };
    const inside = afterUser.slice(1, close);
    const written = parseIPv6(inside) ? undefined : /:(\d+)$/.exec(inside)?.[1];
    if (written) port = Number.parseInt(written, 10);
    host = parseIPv6(inside) ? inside : inside.replace(/:\d*$/, "");
  } else {
    host = afterUser.slice(0, afterUser.indexOf(":"));
  }
  if (!host) return { kind: "unreadable" };
  return { kind: "remote", hosts: [foldHostname(host)], scheme: null, port };
}

// ---- Local paths ---------------------------------------------------------------

/** Noah's own directories: a local source must resolve outside every one of them. */
function managedRoots(config: GitSourcePolicyConfig): { root: string; label: string }[] {
  return [
    { root: config.dataDir, label: "Noah's data directory (the database, every user's clones, the team brain)" },
    ...(config.pi?.workspacesDir ? [{ root: config.pi.workspacesDir, label: "the sandbox workspaces Noah manages" }] : []),
    { root: config.defaultPluginsDir, label: "Noah's bundled skills" },
    { root: process.cwd(), label: "Noah's own application directory" },
  ];
}

/**
 * `target` with every symbolic link resolved. A path that does not exist yet is
 * judged by its nearest existing ancestor (resolved), with the missing tail
 * appended. Throws for anything else (a loop, no permission): unjudgeable.
 */
async function realpathOrNearest(target: string): Promise<string> {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...tail);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.lstat(candidate).then(
    () => true,
    () => false,
  );
}

async function assertLocalPathAllowed(source: string, paths: string[], config: GitSourcePolicyConfig): Promise<void> {
  const roots = await Promise.all(
    managedRoots(config).map(async ({ root, label }) => ({
      label,
      lexical: path.resolve(root),
      real: await realpathOrNearest(root).catch(() => path.resolve(root)),
    })),
  );
  for (const given of paths) {
    // git also tries these spellings of the path it is given.
    for (const spelling of [given, `${given}.git`, path.join(given, ".git"), path.join(`${given}.git`, ".git")]) {
      const lexical = path.resolve(spelling);
      let real: string;
      try {
        real = await realpathOrNearest(lexical);
      } catch {
        refuse(source, "the local path could not be resolved (a link loop, or a folder Noah cannot read)", config, "local_path");
      }
      for (const root of roots) {
        if ([lexical, real].some((candidate) => isInside(candidate, root.lexical) || isInside(candidate, root.real))) {
          refuse(source, `the local path resolves inside ${root.label}`, config, "local_path");
        }
      }
    }
  }
}

// ---- Hosts ---------------------------------------------------------------------

const defaultLookup: GitSourceLookup = (hostname) => dnsPromises.lookup(hostname, { all: true });

/** The resolver's answer, or null when it failed or took too long (git then reports its own error). */
async function lookupAll(
  hostname: string,
  lookup: GitSourceLookup,
  timeoutMs: number,
): Promise<{ address: string; family: number }[] | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether git (libcurl) will send this http(s) request through a proxy: the
 * proxy variables libcurl reads (`https_proxy`/`HTTPS_PROXY`, lowercase-only
 * `http_proxy`, `all_proxy`) minus `no_proxy` (a `*`, an exact host, or a domain
 * suffix). Through a proxy the PROXY resolves the name, so Noah's own DNS answer
 * says nothing about where the connection lands — and a corporate resolver that
 * sinkholes external names to 0.0.0.0 must not get a working source refused.
 */
function goesThroughProxy(scheme: string, host: string, env: NodeJS.ProcessEnv): boolean {
  const all = env.all_proxy || env.ALL_PROXY;
  const proxy = scheme === "https" ? env.https_proxy || env.HTTPS_PROXY || all : env.http_proxy || all;
  if (!proxy) return false;
  const exempt = (env.no_proxy ?? env.NO_PROXY ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of exempt) {
    if (entry === "*") return false;
    const bare = entry.replace(/^\*?\./, "").replace(/:\d+$/, "");
    if (host === bare || host.endsWith(`.${bare}`)) return false;
  }
  return true;
}

/**
 * Judge a repository source and return how to talk to it. Throws
 * {@link GitSourceRefusedError} for a refused one. `source` is the value git
 * will be given (after `marketplaceCloneUrl` resolved an `owner/repo`
 * shorthand).
 *
 * Refused: a local path (or `file://` URL) whose real location is inside one of
 * Noah's own directories; a host that IS — in any textual form, including an
 * IPv4 address inside an IPv6 one — or (with `resolve`) RESOLVES TO a loopback,
 * link-local or 0.0.0.0/8 address; and a host[:port] that is one of Noah's own
 * internal services (`internalServices`), by name, by address or — with
 * `resolve` — by what it resolves to. The configured git host
 * (`config.githubHost`, exact host[:port]) is the operator's own choice and is
 * never judged, so an instance whose git host is on loopback keeps working.
 *
 * NOT closed here: with a proxy in the way the PROXY resolves and connects, so
 * only the literal checks apply (the name is not looked up); and ssh/git
 * transports are not pinned.
 */
export async function assertAllowedGitSource(
  source: string,
  config: GitSourcePolicyConfig,
  options: GitSourcePolicyOptions = {},
): Promise<AllowedGitSource> {
  const parsed = parseSource(source);
  if (parsed.kind === "unreadable") {
    refuse(source, "its host cannot be read unambiguously (git and Noah would read it differently)", config, "unreadable");
  }
  // git prefers an existing local path over any URL-looking reading of the same text.
  if (parsed.kind === "local" || (await pathExists(source))) {
    await assertLocalPathAllowed(source, parsed.kind === "local" ? parsed.paths : [source], config);
    if (parsed.kind === "local") return { kind: "local", gitConfig: [] };
  }
  const remote = parsed as RemoteSource;
  const configuredHost = normalizeGithubHost(config.githubHost);
  if (gitHostFromSource(source) === configuredHost) {
    return { kind: "remote", gitConfig: [] };
  }
  for (const host of remote.hosts) {
    const blocked = staticBlockedClass(host);
    if (blocked) refuse(source, `host '${host}' is ${blocked}`, config, "blocked_host");
  }
  // Noah's own internal services (pi-gateway, the egress controller, Noah's own
  // MCP address): private addresses, so the classes above let them through.
  const services = internalServices(config);
  for (const host of remote.hosts) {
    if (services.some((service) => service.port === remote.port && service.host === canonicalHost(host))) {
      refuse(source, `host '${host}' is one of Noah's own internal services`, config, "internal_service");
    }
  }
  const web = remote.scheme === "http" || remote.scheme === "https";
  // A redirect could send git to an address refused above; only the configured host may redirect.
  const gitConfig: [string, string][] = web ? [["http.followRedirects", "false"]] : [];
  if (!options.resolve) return { kind: "remote", gitConfig };

  const env = options.env ?? process.env;
  const lookup = options.lookup ?? defaultLookup;
  const timeoutMs = options.lookupTimeoutMs ?? 5_000;
  // Where each internal service really is, so another name for it — or its bare
  // address — on the same port is refused too.
  const serviceAddresses = new Set<string>();
  for (const service of services.filter((candidate) => candidate.port === remote.port)) {
    if (isNumericAddress(service.host)) serviceAddresses.add(service.host);
    else for (const { address } of (await lookupAll(service.host, lookup, timeoutMs)) ?? []) serviceAddresses.add(canonicalHost(foldHostname(address)));
  }
  for (const host of remote.hosts.filter(isNumericAddress)) {
    if (serviceAddresses.has(canonicalHost(host))) {
      refuse(source, `host '${host}' is one of Noah's own internal services`, config, "internal_service");
    }
  }
  const names = remote.hosts.filter((host) => !isNumericAddress(host));
  for (const name of names) {
    if (web && goesThroughProxy(remote.scheme!, name, env)) continue;
    const addresses = await lookupAll(name, lookup, timeoutMs);
    if (!addresses || addresses.length === 0) continue;
    for (const { address } of addresses) {
      const blocked = blockedAddressClass(foldHostname(address));
      if (blocked) refuse(source, `host '${name}' resolves to ${address}, ${blocked}`, config, "blocked_host");
      if (serviceAddresses.has(canonicalHost(foldHostname(address)))) {
        refuse(source, `host '${name}' resolves to ${address}, one of Noah's own internal services`, config, "internal_service");
      }
    }
    // Pin the connection to what was just checked, so a second DNS answer cannot
    // move it (only when git and Node read ONE host, and its port is known).
    if (web && remote.port !== null && remote.hosts.length === 1) {
      const pinned = addresses.map(({ address, family }) => (family === 6 ? `[${address}]` : address)).join(",");
      gitConfig.push(["http.curloptResolve", `${name}:${remote.port}:${pinned}`]);
    }
  }
  return { kind: "remote", gitConfig };
}
