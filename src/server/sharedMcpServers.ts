// 공용 MCP 서버 — external HTTP MCP servers a system admin registers for EVERY
// avatar. Stored as ONE JSON blob in `app_config` (encrypted like every app
// secret) and read fresh on every run, so a panel change applies from the next
// turn without a restart.
//
// Credentials: the admin never names a user's secret. A server declares
// credential SLOTS (which header, in what format), and each user binds one of
// THEIR OWN vault secrets to each slot (`user_shared_mcp_bindings`) — the bind
// is the consent, and it is tied to the server's ORIGIN: an admin who moves the
// server to another host silently loses every binding until each user rebinds
// (user decision 2026-10-26). The resolved values never ride the server
// definition: the SDK serializes `mcpServers` into the CLI's `--mcp-config` ARGV
// (readable via /proc/<pid>/cmdline by the agent's own Bash), so a server with
// headers runs through `scripts/mcp-http-bridge.mjs` — a stdio↔HTTP relay that
// reads its URL and headers from a one-shot 0600 file and deletes it. Only the
// file PATH is in argv.
//
// Registration is the gate (a third-party server cannot self-gate per viewer and
// the PreToolUse hook auto-allows every mcp__* call): a server with slots
// registers ONLY on runs that may carry the owner's vault (the elevated line the
// plugin-MCP injection draws — never a plain colleague, a restricted headless
// run, a group agent or a consultation) and only when every slot is bound for
// the current origin to a secret that still exists; otherwise it is left out of
// that run and both metacognition surfaces say why.

import { randomUUID } from "node:crypto";
import { RESERVED_SECRET_ENV_NAMES } from "./secretPolicy.js";
import type {
  SharedMcpBinding,
  SharedMcpRunState,
  SharedMcpSecretSlot,
  SharedMcpServer,
  SharedMcpServerUserView,
  SharedMcpServerView,
  SharedMcpTransport,
} from "./types.js";

export const SHARED_MCP_SERVERS_CONFIG_KEY = "shared_mcp_servers";
export const MAX_SHARED_MCP_SERVERS = 20;
export const MAX_SHARED_MCP_HEADERS = 20;
export const MAX_SHARED_MCP_SLOTS = 5;
/** The one placeholder a slot format carries. */
export const SECRET_PLACEHOLDER = "{secret}";
const MAX_LABEL_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_URL_LENGTH = 2048;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_FORMAT_LENGTH = 200;

const SERVER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SLOT_ID_RE = /^[a-z0-9-]{1,40}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

/**
 * Names an admin may not take: every in-process app server (they would win the
 * collision anyway and silently hide the shared one), the app-managed hex-ssh,
 * and the generic words the CLI or the app use for their own namespaces.
 */
const RESERVED_SERVER_NAMES: ReadonlySet<string> = new Set([
  "avatars",
  "brain",
  "browser",
  "canvas",
  "confluence",
  "file_output",
  "git_repo",
  "group_agent",
  "group_brain",
  "group_repo",
  "hex-ssh",
  "knowledge",
  "repo",
  "server_agents",
  "skill_exchange",
  "ssh_identity",
  "ssh_trust",
  "system",
  "todo",
  "web",
  "claude",
  "noah",
]);

/** Headers the transport owns — an admin value would break the protocol. */
const TRANSPORT_OWNED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "transfer-encoding",
]);

/** True when a vault secret may be bound to a slot (reserved git/SSH names never). */
export function isBindableSecretName(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && !RESERVED_SECRET_ENV_NAMES.has(name);
}

/** The server's origin (`scheme://host[:port]`) — what a binding is tied to. */
export function sharedMcpOrigin(server: Pick<SharedMcpServer, "url">): string {
  try {
    return new URL(server.url).origin;
  } catch {
    return "";
  }
}

type ParseResult = { server: SharedMcpServer } | { error: string };

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function headerNameError(headerName: string, seen: Set<string>): string | null {
  if (!HEADER_NAME_RE.test(headerName)) {
    return `헤더 이름 "${headerName}"이(가) 올바르지 않습니다.`;
  }
  const lower = headerName.toLowerCase();
  if (TRANSPORT_OWNED_HEADERS.has(lower)) {
    return `${headerName} 헤더는 MCP 전송이 직접 관리하므로 지정할 수 없습니다.`;
  }
  if (seen.has(lower)) {
    return `${headerName} 헤더가 중복되었습니다.`;
  }
  seen.add(lower);
  return null;
}

/**
 * Validate one admin-submitted (or stored) server. Error strings are Korean —
 * they reach only the admin panel (`apiError`). `now` stamps `updatedAt`; a
 * slot without an id gets a fresh one (stored slots always carry theirs, so
 * bindings survive an edit).
 */
export function parseSharedMcpServer(raw: unknown, now: string): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "서버 정보 형식이 올바르지 않습니다." };
  }
  const body = raw as Record<string, unknown>;
  const name = stringField(body.name);
  if (!SERVER_NAME_RE.test(name) || name.includes("__")) {
    return {
      error: "서버 이름은 영문 소문자로 시작하고 소문자·숫자·-·_만 쓸 수 있습니다 (최대 32자, __ 불가).",
    };
  }
  if (RESERVED_SERVER_NAMES.has(name)) {
    return { error: `"${name}"은(는) 앱 기본 도구가 쓰는 이름이라 사용할 수 없습니다.` };
  }
  const label = stringField(body.label) || name;
  if (label.length > MAX_LABEL_LENGTH) {
    return { error: `표시 이름은 ${MAX_LABEL_LENGTH}자 이하로 입력해 주세요.` };
  }
  const description = stringField(body.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `설명은 ${MAX_DESCRIPTION_LENGTH}자 이하로 입력해 주세요.` };
  }
  if (body.transport !== undefined && body.transport !== "http" && body.transport !== "sse") {
    return { error: "전송 방식은 http 또는 sse만 지원합니다." };
  }
  const transport: SharedMcpTransport = body.transport === "sse" ? "sse" : "http";

  const url = stringField(body.url);
  if (!url || url.length > MAX_URL_LENGTH) {
    return { error: "서버 주소(URL)를 입력해 주세요." };
  }
  if (url.includes("${") || url.includes(SECRET_PLACEHOLDER)) {
    return { error: "주소에는 시크릿을 넣을 수 없습니다. 사용자 시크릿은 인증 자리(헤더)로 받아 주세요." };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: "서버 주소(URL) 형식이 올바르지 않습니다." };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { error: "서버 주소는 http:// 또는 https://로 시작해야 합니다." };
  }
  if (parsedUrl.username || parsedUrl.password) {
    return { error: "주소에 사용자 이름·비밀번호를 넣지 말고 헤더를 사용해 주세요." };
  }

  const seenHeaders = new Set<string>();
  const rawHeaders = body.headers ?? {};
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return { error: "헤더 형식이 올바르지 않습니다." };
  }
  const headerEntries = Object.entries(rawHeaders as Record<string, unknown>);
  if (headerEntries.length > MAX_SHARED_MCP_HEADERS) {
    return { error: `고정 헤더는 최대 ${MAX_SHARED_MCP_HEADERS}개까지 등록할 수 있습니다.` };
  }
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of headerEntries) {
    const headerName = rawName.trim();
    const nameError = headerNameError(headerName, seenHeaders);
    if (nameError) {
      return { error: nameError };
    }
    if (typeof rawValue !== "string") {
      return { error: `${headerName} 헤더 값은 문자열이어야 합니다.` };
    }
    const value = rawValue.trim();
    if (!value || value.length > MAX_HEADER_VALUE_LENGTH || /[\r\n\0]/.test(value)) {
      return { error: `${headerName} 헤더 값이 비었거나 올바르지 않습니다.` };
    }
    if (value.includes(SECRET_PLACEHOLDER) || value.includes("${")) {
      return { error: `${headerName}: 사용자 시크릿은 고정 헤더가 아니라 인증 자리로 받아 주세요.` };
    }
    headers[headerName] = value;
  }

  const rawSlots = body.secretSlots ?? [];
  if (!Array.isArray(rawSlots)) {
    return { error: "인증 자리 형식이 올바르지 않습니다." };
  }
  if (rawSlots.length > MAX_SHARED_MCP_SLOTS) {
    return { error: `인증 자리는 최대 ${MAX_SHARED_MCP_SLOTS}개까지 만들 수 있습니다.` };
  }
  const secretSlots: SharedMcpSecretSlot[] = [];
  const seenSlotIds = new Set<string>();
  for (const entry of rawSlots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "인증 자리 형식이 올바르지 않습니다." };
    }
    const slot = entry as Record<string, unknown>;
    const id = stringField(slot.id) || randomUUID().slice(0, 8);
    if (!SLOT_ID_RE.test(id) || seenSlotIds.has(id)) {
      return { error: "인증 자리 식별자가 올바르지 않습니다." };
    }
    seenSlotIds.add(id);
    const header = stringField(slot.header);
    const nameError = headerNameError(header, seenHeaders);
    if (nameError) {
      return { error: nameError };
    }
    const slotLabel = stringField(slot.label) || header;
    if (slotLabel.length > MAX_LABEL_LENGTH) {
      return { error: `인증 자리 이름은 ${MAX_LABEL_LENGTH}자 이하로 입력해 주세요.` };
    }
    const format = stringField(slot.format) || SECRET_PLACEHOLDER;
    if (
      format.length > MAX_FORMAT_LENGTH ||
      /[\r\n\0]/.test(format) ||
      format.split(SECRET_PLACEHOLDER).length !== 2
    ) {
      return { error: `${header} 형식에는 ${SECRET_PLACEHOLDER}가 정확히 한 번 들어가야 합니다 (예: Bearer ${SECRET_PLACEHOLDER}).` };
    }
    secretSlots.push({ id, label: slotLabel, header, format });
  }

  return {
    server: {
      name,
      label,
      description,
      url,
      transport,
      headers,
      secretSlots,
      enabled: body.enabled !== false,
      updatedAt: typeof body.updatedAt === "string" && body.updatedAt ? body.updatedAt : now,
    },
  };
}

/**
 * The stored list, leniently: a malformed blob or entry is DROPPED (fail
 * closed — an unreadable row never registers), duplicates keep the first, and
 * the cap applies. A SESSION_SECRET rotation (unreadable blob) reads as empty.
 */
export function normalizeStoredSharedMcpServers(raw: unknown): SharedMcpServer[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SharedMcpServer[] = [];
  for (const entry of raw) {
    // A stored slot without an id is malformed, not new: never mint one here
    // (that would orphan every binding on each read).
    const slots = (entry as { secretSlots?: unknown } | null)?.secretSlots;
    if (Array.isArray(slots) && slots.some((slot) => !stringField((slot as { id?: unknown } | null)?.id))) {
      continue;
    }
    const parsed = parseSharedMcpServer(entry, "");
    if ("server" in parsed && !out.some((server) => server.name === parsed.server.name)) {
      out.push(parsed.server);
    }
    if (out.length >= MAX_SHARED_MCP_SERVERS) {
      break;
    }
  }
  return out;
}

export function toSharedMcpAdminView(server: SharedMcpServer): SharedMcpServerView {
  return {
    ...server,
    headers: { ...server.headers },
    secretSlots: server.secretSlots.map((slot) => ({ ...slot })),
    origin: sharedMcpOrigin(server),
  };
}

/** The bindings of ONE server that count for its CURRENT origin, keyed by slot id. */
function liveBindings(server: SharedMcpServer, bindings: SharedMcpBinding[]): {
  live: Map<string, string>;
  stale: Set<string>;
} {
  const origin = sharedMcpOrigin(server);
  const live = new Map<string, string>();
  const stale = new Set<string>();
  for (const binding of bindings) {
    if (binding.serverName !== server.name) continue;
    if (binding.origin === origin) {
      live.set(binding.slotId, binding.secretName);
    } else {
      stale.add(binding.slotId);
    }
  }
  return { live, stale };
}

export function toSharedMcpUserView(
  server: SharedMcpServer,
  bindings: SharedMcpBinding[],
): SharedMcpServerUserView {
  const { live, stale } = liveBindings(server, bindings);
  return {
    name: server.name,
    label: server.label,
    description: server.description,
    origin: sharedMcpOrigin(server),
    slots: server.secretSlots.map((slot) => ({
      id: slot.id,
      label: slot.label,
      header: slot.header,
      boundSecret: live.get(slot.id) ?? null,
      stale: !live.has(slot.id) && stale.has(slot.id),
    })),
  };
}

/** What `scripts/mcp-http-bridge.mjs` reads from its one-shot config file. */
export interface McpHttpBridgeConfig {
  url: string;
  transport: SharedMcpTransport;
  headers: Record<string, string>;
  /** Plain-text fragments the bridge must never echo in an error (resolved secret values). */
  redact: string[];
  /**
   * Plugin `.mcp.json` entries only (admin servers arrive fully resolved):
   * `${NAME}` in url/headers is filled in ONE pass — from `vault` when the name
   * is there, else (with `expandEnv`) from the bridge's env, as the CLI would.
   */
  vault?: Record<string, string>;
  expandEnv?: boolean;
}

/** The stdio definition that runs the bridge on a config file (only the PATH is in argv). */
export function mcpHttpBridgeServerDef(
  bridgeScriptPath: string,
  configFile: string,
): { type: "stdio"; command: string; args: string[] } {
  return {
    type: "stdio",
    command: process.execPath,
    // --use-system-ca: the image trusts the corporate CA in the OS store
    // (update-ca-certificates), which Node ignores by default. Additive to the
    // bundled roots and NODE_EXTRA_CA_CERTS.
    args: ["--use-system-ca", bridgeScriptPath, "--config", configFile],
  };
}

export interface SharedMcpRunPlan {
  /** Every ENABLED server, resolved for this run (both metacognition surfaces). */
  states: SharedMcpRunState[];
  /** Servers to register: a native CLI def (no headers at all) or a bridge config. */
  registrations: Array<
    | { name: string; kind: "native"; def: { type: SharedMcpTransport; url: string } }
    | { name: string; kind: "bridge"; config: McpHttpBridgeConfig }
  >;
}

/**
 * Resolve the admin list for ONE run. `bindings` are the run OWNER's own;
 * `secrets` is the owner's INJECTABLE vault (reserved git/SSH names already
 * removed); `secretsAllowed` is the run's permission to carry it (elevated, not
 * a consultation, not a group agent). Pure — runPlan writes the bridge files.
 */
export function planSharedMcpRun(
  servers: SharedMcpServer[],
  opts: { bindings: SharedMcpBinding[]; secrets: Record<string, string>; secretsAllowed: boolean },
): SharedMcpRunPlan {
  const states: SharedMcpRunState[] = [];
  const registrations: SharedMcpRunPlan["registrations"] = [];
  for (const server of servers) {
    if (!server.enabled) {
      continue;
    }
    const base = {
      name: server.name,
      label: server.label,
      description: server.description,
      unboundSlots: [] as string[],
      hostChanged: false,
      missingSecrets: [] as string[],
    };
    if (server.secretSlots.length > 0 && !opts.secretsAllowed) {
      states.push({ ...base, status: "secrets_unavailable" });
      continue;
    }
    const { live, stale } = liveBindings(server, opts.bindings);
    const unbound = server.secretSlots.filter((slot) => !live.has(slot.id));
    if (unbound.length > 0) {
      states.push({
        ...base,
        status: "needs_binding",
        unboundSlots: unbound.map((slot) => slot.label),
        hostChanged: unbound.some((slot) => stale.has(slot.id)),
      });
      continue;
    }
    const boundNames = server.secretSlots.map((slot) => live.get(slot.id)!);
    // A pasted value often carries a trailing newline; a header cannot, so the
    // value is trimmed, and one with an inner line break counts as unusable
    // (fetch would reject it and the server would silently never connect).
    const valueOf = (secretName: string): string =>
      Object.hasOwn(opts.secrets, secretName) ? opts.secrets[secretName].trim() : "";
    const missingSecrets = [
      ...new Set(
        boundNames.filter(
          (secretName) =>
            !isBindableSecretName(secretName) ||
            !valueOf(secretName) ||
            /[\r\n\0]/.test(valueOf(secretName)),
        ),
      ),
    ];
    if (missingSecrets.length > 0) {
      states.push({ ...base, status: "missing_secrets", missingSecrets });
      continue;
    }
    states.push({ ...base, status: "active" });
    if (Object.keys(server.headers).length === 0 && server.secretSlots.length === 0) {
      registrations.push({
        name: server.name,
        kind: "native",
        def: { type: server.transport, url: server.url },
      });
      continue;
    }
    const headers: Record<string, string> = { ...server.headers };
    for (const slot of server.secretSlots) {
      // split/join, never String.replace: a `$&` inside a secret must stay literal.
      headers[slot.header] = slot.format.split(SECRET_PLACEHOLDER).join(valueOf(live.get(slot.id)!));
    }
    registrations.push({
      name: server.name,
      kind: "bridge",
      config: {
        url: server.url,
        transport: server.transport,
        headers,
        redact: [...new Set(boundNames.map(valueOf))].filter((value) => value.length > 0),
      },
    });
  }
  return { states, registrations };
}
