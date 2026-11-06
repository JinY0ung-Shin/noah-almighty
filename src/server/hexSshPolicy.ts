export const HEX_SSH_SERVER_NAME = "hex-ssh";
export const HEX_SSH_POLICY_CONFIG_KEY = "hex_ssh_tool_policy";

export const HEX_SSH_TOOLS = [
  "remote-ssh",
  "ssh-read-lines",
  "ssh-edit-block",
  "ssh-search-code",
  "ssh-write-chunk",
  "ssh-verify",
  "ssh-capabilities",
  "ssh-session-open",
  "ssh-session-exec",
  "ssh-session-read",
  "ssh-session-close",
  "ssh-session-gc",
] as const;

export type HexSshTool = (typeof HEX_SSH_TOOLS)[number];

/**
 * hex-ssh tools Noah NEVER offers. hex-ssh runs in Noah's container, not in the
 * run principal's sandbox, so its local-path tools would read and write NOAH's
 * filesystem (the DB, pi's service-key file, every user's sandbox and repo copy,
 * other runs' /proc/<pid>/environ) while the agent's real files under /workspace
 * are invisible to it. They are left out of HEX_SSH_TOOLS (so no stored policy can
 * grant them — `normalizeHexSshToolPolicy` drops unknown names) AND refused by
 * the policy proxy itself (`scripts/hex-ssh-policy-proxy.mjs`), whatever its
 * allowlist says. A future transfer tool must be Noah's own, reading the sandbox
 * through `PinnedDir`, never a path handed to hex-ssh.
 *
 * The same rule covers ARGUMENTS of the offered tools: every hex-ssh 1.9.2 tool
 * takes `privateKeyPath`, which hex-ssh reads with readFileSync in Noah's
 * container (an existence oracle over Noah's disk, SSH auth with any key file on
 * it, a `/dev/zero` hang). The policy proxy refuses any call carrying it (or
 * `localPath`) and strips both from every listed input schema; Noah supplies the
 * key only through the child's env (`SSH_PRIVATE_KEY`, passed on only as key
 * TEXT — hex-ssh would read any other value as a path too). known_hosts and
 * ssh_config locations are env-only (`KNOWN_HOSTS_PATH`, `SSH_CONFIG_PATH`).
 */
export const HEX_SSH_NEVER_OFFERED_TOOLS = ["ssh-upload", "ssh-download"] as const;

/** Agent-facing: why there is no local↔remote file transfer (BOTH metacognition surfaces). */
export const HEX_SSH_NO_TRANSFER_SENTENCE =
  "hex-ssh has no local↔remote file transfer (ssh-upload/ssh-download are not offered): it runs on Noah's server, not in your sandbox, so it cannot see your /workspace files — write a remote file with ssh-write-chunk/ssh-edit-block and read one with ssh-read-lines. ";
/**
 * Who a run's hex-ssh allowlist is judged for. ONE team (2026-11-06): every
 * approved viewer is a teammate (`trusted`), so the admin policy has just two
 * columns (소유자 / 팀원). `none` is a run with no SSH at all — a restricted
 * headless run (intro / hashtag generation) or a viewer without elevated
 * access — and is never configurable. The retired `colleague` column (일반 동료)
 * is dropped from a stored policy on read and ignored on write; never mint a
 * third column again.
 */
export type HexSshViewerClass = "owner" | "trusted" | "none";
export type HexSshPolicyRole = Exclude<HexSshViewerClass, "none">;
export type HexSshToolPolicy = Record<HexSshPolicyRole, HexSshTool[]>;

export interface HexSshToolInfo {
  name: HexSshTool;
  label: string;
  category: "read" | "execute" | "write" | "session";
}

export const HEX_SSH_TOOL_INFOS: HexSshToolInfo[] = [
  { name: "ssh-read-lines", label: "원격 파일 읽기", category: "read" },
  { name: "ssh-search-code", label: "원격 검색", category: "read" },
  { name: "ssh-verify", label: "체크섬 검증", category: "read" },
  { name: "ssh-capabilities", label: "서버 기능 확인", category: "read" },
  { name: "remote-ssh", label: "원격 명령 실행", category: "execute" },
  { name: "ssh-session-exec", label: "세션 명령 실행", category: "execute" },
  { name: "ssh-edit-block", label: "원격 파일 수정", category: "write" },
  { name: "ssh-write-chunk", label: "원격 파일 쓰기", category: "write" },
  { name: "ssh-session-open", label: "세션 열기", category: "session" },
  { name: "ssh-session-read", label: "세션 출력 읽기", category: "session" },
  { name: "ssh-session-close", label: "세션 닫기", category: "session" },
  { name: "ssh-session-gc", label: "만료 세션 정리", category: "session" },
];

const TOOL_SET = new Set<string>(HEX_SSH_TOOLS);
const ROLE_KEYS: HexSshPolicyRole[] = ["owner", "trusted"];
const READ_ONLY_HEX_SSH_TOOLS: HexSshTool[] = [
  "ssh-read-lines",
  "ssh-search-code",
  "ssh-verify",
  "ssh-capabilities",
];

export const DEFAULT_HEX_SSH_TOOL_POLICY: HexSshToolPolicy = {
  owner: [...HEX_SSH_TOOLS],
  trusted: [...READ_ONLY_HEX_SSH_TOOLS],
};

function uniqueKnownTools(value: unknown): HexSshTool[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((tool): tool is HexSshTool => typeof tool === "string" && TOOL_SET.has(tool))));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Leniently normalize stored policy. Corrupt or older records keep the default
 * for the affected role so a bad DB value does not silently disable owner SSH.
 */
export function normalizeHexSshToolPolicy(value: unknown): HexSshToolPolicy {
  if (!isRecord(value)) {
    return { ...DEFAULT_HEX_SSH_TOOL_POLICY };
  }
  return {
    owner: Array.isArray(value.owner) ? uniqueKnownTools(value.owner) : [...DEFAULT_HEX_SSH_TOOL_POLICY.owner],
    trusted: Array.isArray(value.trusted) ? uniqueKnownTools(value.trusted) : [...DEFAULT_HEX_SSH_TOOL_POLICY.trusted],
  };
}

/** Strict parser for the admin API: both roles must be arrays (a retired `colleague` is ignored). */
export function parseHexSshToolPolicy(value: unknown): HexSshToolPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const role of ROLE_KEYS) {
    if (!Array.isArray(value[role])) {
      return null;
    }
  }
  return {
    owner: uniqueKnownTools(value.owner),
    trusted: uniqueKnownTools(value.trusted),
  };
}

export function allowedHexSshToolsForViewer(
  policy: HexSshToolPolicy,
  viewerClass: HexSshViewerClass,
): HexSshTool[] {
  if (viewerClass === "none") return [];
  return policy[viewerClass] ?? [];
}

export function viewerClassForAgentRequest(input: {
  viewerIsOwner?: boolean;
  elevated?: boolean;
  headless?: boolean;
}): HexSshViewerClass {
  if (!input.headless && input.viewerIsOwner) {
    return "owner";
  }
  if (!input.headless && input.elevated) {
    return "trusted";
  }
  return "none";
}

