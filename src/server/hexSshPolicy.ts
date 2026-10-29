export const HEX_SSH_SERVER_NAME = "hex-ssh";
export const HEX_SSH_POLICY_CONFIG_KEY = "hex_ssh_tool_policy";

export const HEX_SSH_TOOLS = [
  "remote-ssh",
  "ssh-read-lines",
  "ssh-edit-block",
  "ssh-search-code",
  "ssh-write-chunk",
  "ssh-upload",
  "ssh-download",
  "ssh-verify",
  "ssh-capabilities",
  "ssh-session-open",
  "ssh-session-exec",
  "ssh-session-read",
  "ssh-session-close",
  "ssh-session-gc",
] as const;

export type HexSshTool = (typeof HEX_SSH_TOOLS)[number];
export type HexSshViewerClass = "owner" | "trusted" | "colleague";
export type HexSshToolPolicy = Record<HexSshViewerClass, HexSshTool[]>;

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
  { name: "ssh-upload", label: "로컬 파일 업로드", category: "write" },
  { name: "ssh-download", label: "원격 파일 다운로드", category: "write" },
  { name: "ssh-session-open", label: "세션 열기", category: "session" },
  { name: "ssh-session-read", label: "세션 출력 읽기", category: "session" },
  { name: "ssh-session-close", label: "세션 닫기", category: "session" },
  { name: "ssh-session-gc", label: "만료 세션 정리", category: "session" },
];

const TOOL_SET = new Set<string>(HEX_SSH_TOOLS);
const ROLE_KEYS: HexSshViewerClass[] = ["owner", "trusted", "colleague"];
const READ_ONLY_HEX_SSH_TOOLS: HexSshTool[] = [
  "ssh-read-lines",
  "ssh-search-code",
  "ssh-verify",
  "ssh-capabilities",
];

export const DEFAULT_HEX_SSH_TOOL_POLICY: HexSshToolPolicy = {
  owner: [...HEX_SSH_TOOLS],
  trusted: [...READ_ONLY_HEX_SSH_TOOLS],
  colleague: [...READ_ONLY_HEX_SSH_TOOLS],
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
    colleague: Array.isArray(value.colleague)
      ? uniqueKnownTools(value.colleague)
      : [...DEFAULT_HEX_SSH_TOOL_POLICY.colleague],
  };
}

/** Strict parser for the admin API: all roles must be arrays. */
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
    colleague: uniqueKnownTools(value.colleague),
  };
}

export function allowedHexSshToolsForViewer(
  policy: HexSshToolPolicy,
  viewerClass: HexSshViewerClass,
): HexSshTool[] {
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
  return "colleague";
}

