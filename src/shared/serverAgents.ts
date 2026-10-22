// 서버 에이전트 — the owner's registered SSH servers the avatar delegates work to.
// The Claude Code CLI runs ON the server (SDK spawnClaudeCodeProcess over an
// ssh2 exec channel) while hooks/canUseTool stay in Noah. Import-free: shared by
// the server (store/routes/tools) and the client (settings card). Mechanics:
// docs/architecture/server-agents.md.

/** Tool-level access tiers, enforced per remote run (the server's OS account is the final boundary). */
export const SERVER_AGENT_ACCESS_LEVELS = ["read", "exec", "full"] as const;
export type ServerAgentAccess = (typeof SERVER_AGENT_ACCESS_LEVELS)[number];

/**
 * Built-in CLI tools a remote run gets per tier. `read` has NO Bash (a
 * read-only shell cannot be enforced); `exec` adds Bash but no edit tools —
 * Bash can still change files, so the exec/full line is tool-level only.
 */
export const SERVER_AGENT_ACCESS_TOOLS: Record<ServerAgentAccess, readonly string[]> = {
  read: ["Read", "Glob", "Grep"],
  exec: ["Read", "Glob", "Grep", "Bash"],
  full: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit"],
};

export const SERVER_AGENT_ACCESS_LABELS_KO: Record<ServerAgentAccess, string> = {
  read: "조회",
  exec: "명령 실행",
  full: "전체",
};

export const MAX_SERVER_AGENTS = 30;
export const SERVER_AGENT_NAME_MAX = 32;
export const SERVER_AGENT_ROLE_MAX = 200;
export const SERVER_AGENT_NOTES_MAX = 16_000;
export const SERVER_AGENT_WORKDIR_MAX = 512;

/** delegate: tasks per call, per-task timeout (minutes), result text cap per server. */
export const SERVER_AGENT_MAX_TASKS_PER_CALL = 8;
export const SERVER_AGENT_TASK_TIMEOUT_DEFAULT_MIN = 10;
export const SERVER_AGENT_TASK_TIMEOUT_MAX_MIN = 30;
export const SERVER_AGENT_TASK_TEXT_MAX = 8_000;
export const SERVER_AGENT_RESULT_CAP = 8_000;

/** Concurrent remote runs: per server (each holds ~250 MB there), per owner, process-wide. */
export const SERVER_AGENT_MAX_RUNS_PER_SERVER = 2;
export const SERVER_AGENT_MAX_RUNS_PER_OWNER = 4;
export const SERVER_AGENT_MAX_RUNS_TOTAL = 8;

/** Remote layout, relative to the account's $HOME. */
export const SERVER_AGENT_REMOTE_DIR = ".noah-agent";
export const SERVER_AGENT_REMOTE_CONFIG_DIR = ".claude-noah";

export interface ServerAgentInstallState {
  /** Whether the last check/run found the server ready (CLI installed, model reachable). */
  ok: boolean;
  /** CLI version installed on the server, when known. */
  version: string | null;
  /** Failure code of the last check (null when ok). */
  error: ServerAgentErrorCode | null;
  /** Short technical detail for the failure (English, never a secret). */
  detail: string | null;
  checkedAt: string;
}

export interface ServerAgent {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  workdir: string;
  role: string;
  notes: string;
  access: ServerAgentAccess;
  enabled: boolean;
  installState: ServerAgentInstallState | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServerAgentInput {
  name: string;
  host: string;
  port: number;
  username: string;
  workdir: string;
  role: string;
  notes: string;
  access: ServerAgentAccess;
  enabled: boolean;
}

/** GET /api/me/server-agents */
export interface ServerAgentListResponse {
  servers: ServerAgentView[];
  /** The owner has an SSH_PRIVATE_KEY in the vault. */
  sshKeySet: boolean;
  /** The deployment blocks direct outbound connections (egress domain-proxy) — no SSH at all. */
  egressBlocked: boolean;
  /** The CLI version this Noah build installs on servers. */
  cliVersion: string;
  /**
   * A system admin enabled the feature (Admin → 시스템 → 서버 에이전트). Off by
   * default: a check or delegation sends the deployment's model credentials to the
   * registrant's server, so registration/host trust work but check/delegate refuse.
   */
  adminEnabled: boolean;
}

export interface ServerAgentView extends ServerAgent {
  /** The owner's known_hosts has a key for this host:port. */
  hostTrusted: boolean;
}

/** POST /api/me/server-agents/:id/host-key — the host's key as seen now, NOT yet trusted. */
export interface ServerAgentHostKeyResponse {
  fingerprint: string;
  keyType: string;
  /** Already trusted with this exact key. */
  trusted: boolean;
  /** A DIFFERENT key is trusted for this host:port (rotated key or interception). */
  mismatch: boolean;
}

export const SERVER_AGENT_ERROR_CODES = [
  "ADMIN_DISABLED",
  "NO_SSH_KEY",
  "EGRESS_BLOCKED",
  "HOST_NOT_TRUSTED",
  "HOST_KEY_MISMATCH",
  "PASSPHRASE_REQUIRED",
  "BAD_PASSPHRASE",
  "AUTH_FAILED",
  "UNREACHABLE",
  "TIMEOUT",
  "UNSUPPORTED_ARCH",
  "MISSING_TOOLS",
  "NOEXEC_HOME",
  "DISK_SPACE",
  "UPLOAD_FAILED",
  "TLS_CA",
  "MODEL_UNREACHABLE",
  "WORKDIR",
  "HOME_NOT_WRITABLE",
  "BUSY",
  "UNKNOWN",
] as const;
export type ServerAgentErrorCode = (typeof SERVER_AGENT_ERROR_CODES)[number];

export function isServerAgentErrorCode(value: unknown): value is ServerAgentErrorCode {
  return typeof value === "string" && (SERVER_AGENT_ERROR_CODES as readonly string[]).includes(value);
}

/** User-facing (settings card, apiError). */
export const SERVER_AGENT_ERROR_KO: Record<ServerAgentErrorCode, string> = {
  ADMIN_DISABLED: "관리자가 서버 에이전트 기능을 켜지 않았습니다.",
  NO_SSH_KEY: "SSH 키가 없습니다. 시크릿 카드에서 SSH 키를 먼저 생성하거나 등록하세요.",
  EGRESS_BLOCKED: "이 배포는 외부 직접 연결(SSH 포함)을 차단합니다. 관리자에게 문의하세요.",
  HOST_NOT_TRUSTED: "호스트 키가 아직 신뢰되지 않았습니다. 지문을 확인하고 신뢰하세요.",
  HOST_KEY_MISMATCH: "신뢰된 호스트 키와 서버가 보낸 키가 다릅니다. 서버 키가 바뀌었는지 관리자에게 확인하세요.",
  PASSPHRASE_REQUIRED: "SSH 키에 패스프레이즈가 걸려 있습니다. 시크릿에 SSH_PASSPHRASE를 등록하세요.",
  BAD_PASSPHRASE: "SSH_PASSPHRASE가 키와 맞지 않습니다.",
  AUTH_FAILED: "인증에 실패했습니다. 서버 계정의 authorized_keys에 공개키가 등록됐는지 확인하세요.",
  UNREACHABLE: "서버에 연결할 수 없습니다. 호스트·포트와 Noah 서버에서의 네트워크 경로를 확인하세요.",
  TIMEOUT: "서버 응답 시간이 초과됐습니다.",
  UNSUPPORTED_ARCH: "지원하지 않는 서버 아키텍처입니다. 현재 x86_64 리눅스만 지원합니다.",
  MISSING_TOOLS: "서버에 필요한 기본 도구(sh, base64, timeout, sha256sum)가 없습니다.",
  NOEXEC_HOME: "홈 디렉터리에서 프로그램을 실행할 수 없습니다(noexec 마운트).",
  DISK_SPACE: "서버 홈 디렉터리의 여유 공간이 부족합니다(약 600MB 필요).",
  UPLOAD_FAILED: "에이전트 프로그램 업로드에 실패했습니다.",
  TLS_CA: "서버에서 모델 API의 TLS 인증서를 신뢰하지 못합니다. 사내 CA 설정을 확인하세요.",
  MODEL_UNREACHABLE: "서버에서 모델 API에 연결하지 못했습니다. 서버의 네트워크/프록시를 확인하세요.",
  WORKDIR: "작업 디렉터리를 만들거나 이동할 수 없습니다.",
  HOME_NOT_WRITABLE: "서버 계정의 홈 디렉터리에 쓸 수 없습니다.",
  BUSY: "이 서버에서 실행 중인 위임이 많아 지금은 점검할 수 없습니다. 잠시 후 다시 시도하세요.",
  UNKNOWN: "알 수 없는 오류가 발생했습니다.",
};

/** Agent-facing (tool results, describe_system). */
export const SERVER_AGENT_ERROR_EN: Record<ServerAgentErrorCode, string> = {
  ADMIN_DISABLED:
    "The system administrator has not enabled server agents on this Noah deployment (Admin → 시스템 → 서버 에이전트); nothing was sent to the server.",
  NO_SSH_KEY: "No SSH_PRIVATE_KEY in the owner's vault; generate or register one first.",
  EGRESS_BLOCKED: "The deployment blocks direct outbound connections, so SSH is unavailable.",
  HOST_NOT_TRUSTED: "The host key is not trusted yet; the owner must confirm the fingerprint in Settings → 권한·연결 → 서버 에이전트.",
  HOST_KEY_MISMATCH: "The server presented a key different from the trusted one; do not proceed — the owner must verify with the server admin.",
  PASSPHRASE_REQUIRED: "The SSH key is passphrase-protected; the owner must store SSH_PASSPHRASE.",
  BAD_PASSPHRASE: "SSH_PASSPHRASE does not match the key.",
  AUTH_FAILED: "SSH authentication failed; the owner's public key is probably not in the account's authorized_keys.",
  UNREACHABLE: "Could not connect to the server from the Noah host.",
  TIMEOUT: "The server did not respond in time.",
  UNSUPPORTED_ARCH: "Unsupported server architecture (only x86_64 Linux is supported).",
  MISSING_TOOLS: "The server lacks required base tools (sh, base64, timeout, sha256sum).",
  NOEXEC_HOME: "The account's home directory is mounted noexec.",
  DISK_SPACE: "Not enough free space in the account's home directory (~600 MB needed).",
  UPLOAD_FAILED: "Uploading the agent CLI to the server failed.",
  TLS_CA: "The server does not trust the model API's TLS certificate (private CA).",
  MODEL_UNREACHABLE: "The server could not reach the model API.",
  WORKDIR: "The working directory could not be created or entered.",
  HOME_NOT_WRITABLE: "The account's home directory is not writable.",
  BUSY: "The server is at its concurrent-run limit; retry when the running delegations finish.",
  UNKNOWN: "Unknown error.",
};

// ---------- validation (pure; the routes and the settings form share it) ----------

export type ServerAgentInputError =
  | { code: "INVALID"; field: keyof ServerAgentInput }
  | { code: "MISSING"; field: keyof ServerAgentInput };

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// DNS name, IPv4 or bracket-less IPv6; never leading '-' (would read as an ssh option elsewhere).
const HOST_RE = /^(?!-)[A-Za-z0-9.:-]{1,253}$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9._-]{0,31}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isPlainText(value: string, max: number, allowNewlines: boolean): boolean {
  if (value.length > max) return false;
  const probe = allowNewlines ? value.replace(/[\n\t]/g, "") : value;
  return !CONTROL_RE.test(probe);
}

/** Normalize + validate a full create body (`partial: false`) or a PATCH body (`partial: true`). */
export function validateServerAgentInput(
  raw: unknown,
  opts: { partial: boolean },
): { ok: true; value: Partial<ServerAgentInput> } | { ok: false; error: ServerAgentInputError } {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Partial<ServerAgentInput> = {};
  const required: (keyof ServerAgentInput)[] = ["name", "host", "username", "workdir"];
  for (const field of required) {
    if (!opts.partial && (body[field] === undefined || body[field] === "")) {
      return { ok: false, error: { code: "MISSING", field } };
    }
  }
  const str = (field: keyof ServerAgentInput): string | undefined | null => {
    const v = body[field];
    if (v === undefined) return undefined;
    return typeof v === "string" ? v.trim() : null;
  };
  const name = str("name");
  if (name !== undefined) {
    if (name === null || name.length > SERVER_AGENT_NAME_MAX || !NAME_RE.test(name)) return bad("name");
    out.name = name;
  }
  const host = str("host");
  if (host !== undefined) {
    if (host === null || !HOST_RE.test(host)) return bad("host");
    out.host = host.toLowerCase();
  }
  if (body.port !== undefined) {
    const port = typeof body.port === "string" && body.port.trim() !== "" ? Number(body.port) : body.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return bad("port");
    out.port = port;
  } else if (!opts.partial) {
    out.port = 22;
  }
  const username = str("username");
  if (username !== undefined) {
    if (username === null || !USER_RE.test(username)) return bad("username");
    out.username = username;
  }
  const workdir = str("workdir");
  if (workdir !== undefined) {
    if (
      workdir === null ||
      !workdir.startsWith("/") ||
      !isPlainText(workdir, SERVER_AGENT_WORKDIR_MAX, false) ||
      workdir.split("/").includes("..")
    ) {
      return bad("workdir");
    }
    out.workdir = workdir.length > 1 ? workdir.replace(/\/+$/, "") : workdir;
  }
  const role = str("role");
  if (role !== undefined) {
    if (role === null || !isPlainText(role, SERVER_AGENT_ROLE_MAX, false)) return bad("role");
    out.role = role;
  } else if (!opts.partial) {
    out.role = "";
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string" || !isPlainText(body.notes, SERVER_AGENT_NOTES_MAX, true)) return bad("notes");
    out.notes = body.notes.replace(/\r\n/g, "\n").trim();
  } else if (!opts.partial) {
    out.notes = "";
  }
  if (body.access !== undefined) {
    if (!(SERVER_AGENT_ACCESS_LEVELS as readonly unknown[]).includes(body.access)) return bad("access");
    out.access = body.access as ServerAgentAccess;
  } else if (!opts.partial) {
    out.access = "read";
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return bad("enabled");
    out.enabled = body.enabled;
  } else if (!opts.partial) {
    out.enabled = true;
  }
  return { ok: true, value: out };
}

function bad(field: keyof ServerAgentInput): { ok: false; error: ServerAgentInputError } {
  return { ok: false, error: { code: "INVALID", field } };
}

export const SERVER_AGENT_FIELD_LABELS_KO: Record<keyof ServerAgentInput, string> = {
  name: "이름",
  host: "호스트",
  port: "포트",
  username: "계정",
  workdir: "작업 디렉터리",
  role: "역할",
  notes: "운영 메모",
  access: "권한 등급",
  enabled: "사용",
};

/** `known_hosts` token for a host:port — bare host on 22, `[host]:port` otherwise. */
export function serverAgentHostToken(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

// ---------- Korean validation messages (lane U; routes' 400 bodies + the settings form) ----------

/** What a valid value looks like, per field — the second half of an INVALID message. */
export const SERVER_AGENT_FIELD_HINTS_KO: Record<keyof ServerAgentInput, string> = {
  name: `영문 소문자·숫자·하이픈으로 ${SERVER_AGENT_NAME_MAX}자 이내, 소문자나 숫자로 시작`,
  host: "호스트 이름 또는 IP 주소(하이픈으로 시작할 수 없음)",
  port: "1~65535 사이의 정수",
  username: "영문자나 밑줄로 시작하는 32자 이내의 계정 이름",
  workdir: `/로 시작하는 ${SERVER_AGENT_WORKDIR_MAX}자 이내의 절대 경로(.. 불가)`,
  role: `${SERVER_AGENT_ROLE_MAX}자 이내의 한 줄`,
  notes: "16,000자 이내",
  access: "조회·명령 실행·전체 중 하나",
  enabled: "켜기 또는 끄기",
};

/** `을`/`를` by the last Hangul syllable's final consonant. */
function objectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? "을" : "를";
}

/** The Korean sentence for a validateServerAgentInput error (route 400 body = form message). */
export function serverAgentInputErrorKo(error: ServerAgentInputError): string {
  const label = SERVER_AGENT_FIELD_LABELS_KO[error.field];
  return error.code === "MISSING"
    ? `${label}${objectParticle(label)} 입력해 주세요.`
    : `${label} 형식이 올바르지 않습니다 — ${SERVER_AGENT_FIELD_HINTS_KO[error.field]}.`;
}
