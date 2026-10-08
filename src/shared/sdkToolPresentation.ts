import { DEFAULT_SHARE_LINK_EXPIRY_DAYS } from "./shareLinks.js";

export const SDK_SUBAGENT_TOOLS = ["Task", "Agent"] as const;

export const SDK_UI_HANDLED_TOOLS = ["AskUserQuestion"] as const;

export const SDK_TASK_CREATE_TOOLS = ["TaskCreate", "TaskCreated", "TaskStarted"] as const;

export const SDK_TASK_UPDATE_TOOLS = ["TaskUpdate", "TaskProgress", "TaskStatus"] as const;

export const SDK_TASK_END_TOOLS = ["TaskComplete", "TaskCompleted", "TaskStop"] as const;

export const SDK_TASK_INSPECTION_TOOLS = [
  "TaskGet",
  "TaskRead",
  "TaskOutput",
  "TaskList",
] as const;

export const SDK_PLAN_TOOLS = ["EnterPlanMode", "ExitPlanMode"] as const;

/**
 * Agent-teams coordination tools (CLI's experimental agent teams, enabled via
 * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS in `agentSubprocessEnv`): `Agent` with a
 * `name:` spawns an addressable teammate; `SendMessage` messages it. Auto-allowed
 * like the orchestration set but deliberately NOT in SDK_HIDDEN_ACTIVITY_TOOLS —
 * teammate coordination should show as activity rows, not look like dead air.
 */
export const SDK_TEAM_TOOLS = ["SendMessage"] as const;

/**
 * The "ultracode" dynamic multi-agent orchestration tool. Auto-allowed like
 * SDK_TEAM_TOOLS (its own spawn is meta-work; the agents it spawns still hit
 * the PreToolUse hook individually, modulo the background-subagent hook-bypass
 * caveat — see SUBAGENT_SPAWN_TOOLS in preToolUseHook.ts) and deliberately NOT
 * in SDK_HIDDEN_ACTIVITY_TOOLS so a workflow launch shows as an activity row.
 */
export const SDK_WORKFLOW_TOOLS = ["Workflow"] as const;

export const SDK_INTERNAL_HIDDEN_TOOLS = [
  "ToolSearch",
  "TodoWrite",
  "SlashCommand",
  "ShowOnboardingRolePicker",
] as const;

export const SDK_ORCHESTRATION_TOOLS = [
  ...SDK_SUBAGENT_TOOLS,
  ...SDK_TASK_CREATE_TOOLS,
  ...SDK_TASK_UPDATE_TOOLS,
  ...SDK_TASK_END_TOOLS,
  ...SDK_TASK_INSPECTION_TOOLS,
  ...SDK_PLAN_TOOLS,
] as const;

export const SDK_HIDDEN_ACTIVITY_TOOLS = [
  ...SDK_INTERNAL_HIDDEN_TOOLS,
  ...SDK_ORCHESTRATION_TOOLS,
] as const;

/**
 * The permission-gated built-ins an ELEVATED viewer may use — the tools the
 * PreToolUse hook blanket-allows once `elevated && autoApprove` holds, i.e.
 * every live chat and owner routine today. Named here so runPlan can ALSO list
 * them in `allowedTools` for exactly those runs: the bundled CLI (2.1.222)
 * cancels an in-flight permission evaluation when queued input (typically a
 * background <task-notification>) entered the same turn and reports the
 * cancellation as a USER REFUSAL ("The user doesn't want to take this action
 * right now" / toolDenialKind: "cancelled") — the flaky silent auto-deny.
 * Rule-allowed tools never enter that cancellable ask path, and a hook DENY
 * still overrides an allowedTools rule, so the hook's guards (admin policy,
 * active-repo git, read-only viewers) keep working. Unknown
 * names are harmless no-ops (same contract as UNUSED_SDK_BUILTIN_TOOLS), so
 * both shell-kill spellings ride along. AskUserQuestion stays OFF this list:
 * the hook intercepts it with a deny-carrying-answer, which must stay ahead
 * of any rule.
 */
export const SDK_ELEVATED_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "KillBash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
] as const;

/**
 * Full-CLI harness tools the SDK/CLI advertises by default but that Noah Almighty
 * does NOT use: they're absent from `allowedTools`, duplicate an app feature
 * (Cron* vs. `mcp__system__*_routine`, PushNotification/ReadNotifications vs.
 * `mcp__system__notify_user`, Enter/ExitWorktree vs. `mcp__git_repo__open_repo`),
 * or are interactive-CLI-only (Monitor / DesignSync / ClaudeDesign /
 * ScheduleWakeup / RemoteTrigger / ReportFindings / SendFeedback / ProposeSkills /
 * ProposeGoal).
 * `SendMessage` and `Workflow` are NOT here: they power agent teams
 * (SDK_TEAM_TOOLS) and ultracode/dynamic-workflow orchestration
 * (SDK_WORKFLOW_TOOLS) respectively, and an admin can turn either off via the
 * togglable-tool policy instead.
 * Fed to the SDK `disallowedTools` option so they're dropped from the advertised
 * `tools` array on every request — several kB of tool descriptions. Unknown
 * names are harmless no-ops, so the list can name tools a given CLI version may
 * not ship.
 */
export const UNUSED_SDK_BUILTIN_TOOLS = [
  "Monitor",
  "DesignSync",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterWorktree",
  "ExitWorktree",
  "ScheduleWakeup",
  "PushNotification",
  "RemoteTrigger",
  "ReportFindings",
  "SendFeedback",
  "ClaudeDesign",
  "ProposeSkills",
  "ProposeGoal",
  "ReadNotifications",
] as const;

export const SDK_TOOL_LABELS: Record<string, string> = {
  Agent: "에이전트 실행",
  Artifact: "아티팩트 게시",
  AskUserQuestion: "사용자 질문",
  Bash: "명령 실행",
  ClaudeDesign: "디자인 작업",
  CronCreate: "예약 생성",
  CronDelete: "예약 삭제",
  CronList: "예약 목록",
  Edit: "파일 편집",
  EnterPlanMode: "계획 모드 시작",
  EnterWorktree: "작업트리 진입",
  ExitPlanMode: "계획 제출",
  ExitWorktree: "작업트리 종료",
  FileEdit: "파일 편집",
  FileRead: "파일 읽기",
  FileWrite: "파일 쓰기",
  Glob: "파일 찾기",
  Grep: "내용 검색",
  ListMcpResources: "MCP 리소스 목록",
  Mcp: "MCP 도구",
  Monitor: "모니터링 시작",
  NotebookEdit: "노트북 편집",
  Projects: "프로젝트 지식",
  ProposeGoal: "목표 제안",
  ProposeSkills: "스킬 제안",
  PushNotification: "푸시 알림",
  Read: "파일 읽기",
  ReadMcpResource: "MCP 리소스 읽기",
  ReadMcpResourceDir: "MCP 리소스 폴더 읽기",
  ReadNotifications: "알림 확인",
  RefreshMcpTools: "MCP 도구 새로고침",
  RemoteTrigger: "원격 트리거",
  REPL: "REPL 실행",
  ReportFindings: "리뷰 결과 보고",
  ScheduleWakeup: "후속 실행 예약",
  SendFeedback: "피드백 전송",
  SendMessage: "팀원 메시지 전송",
  Skill: "스킬 실행",
  Task: "하위 작업",
  TaskComplete: "태스크 완료",
  TaskCompleted: "태스크 완료",
  TaskCreate: "태스크 생성",
  TaskCreated: "태스크 생성",
  TaskGet: "태스크 조회",
  TaskList: "태스크 목록",
  TaskOutput: "태스크 출력 확인",
  TaskProgress: "태스크 진행",
  TaskRead: "태스크 조회",
  TaskStarted: "태스크 시작",
  TaskStatus: "태스크 상태",
  TaskStop: "태스크 중지",
  TaskUpdate: "태스크 업데이트",
  TodoWrite: "할 일 갱신",
  WebFetch: "웹 페이지 읽기",
  WebSearch: "웹 검색",
  Workflow: "워크플로 실행",
  Write: "파일 쓰기",
};

/**
 * Labels for Noah's own in-process MCP tools (user-facing, so Korean). Kept in
 * the SHARED layer so the server status line ("실행 중: <label>" from
 * tool_progress in sdkMessageHandlers) and the client activity row (humanTool)
 * can never disagree about the same tool — mcp__canvas__show once showed
 * "캔버스 표시" in the activity row but a raw "show" in the status line.
 */
export const MCP_TOOL_LABELS: Record<string, string> = {
  mcp__canvas__show: "캔버스 표시",
  mcp__confluence__describe_config: "Confluence 설정 확인",
  mcp__confluence__extract_page_assets: "Confluence 자산 추출",
  mcp__confluence__get_attachment: "Confluence 첨부 가져오기",
  mcp__confluence__get_page: "Confluence 페이지 조회",
  mcp__confluence__list_attachments: "Confluence 첨부 조회",
  mcp__confluence__list_spaces: "Confluence 스페이스 조회",
  mcp__confluence__search: "Confluence 검색",
  mcp__file_output__create_share_link: "공유 링크 만들기",
  mcp__file_output__share_file: "파일 공유",
  mcp__file_output__show_file: "이미지 표시",
  mcp__knowledge__pending_requests: "대기 요청 확인",
  mcp__knowledge__request_info: "정보 요청 기록",
  mcp__knowledge__resolve_request: "요청 처리 완료",
  mcp__system__notify_user: "사용자 알림",
  mcp__system__read_manual: "시스템 사용 매뉴얼 조회",
  mcp__web__fetch: "웹 페이지 읽기",
};

/**
 * Human-readable label for a tool name, for status lines and activity rows. Raw
 * ids like `mcp__repo__write_file` are an implementation detail, so an unmapped
 * name degrades to its bare tool segment — the same fallback the client's
 * `humanTool` applies, so a status line and its activity row agree.
 */
export function sdkToolLabel(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const mapped = SDK_TOOL_LABELS[name] ?? MCP_TOOL_LABELS[name];
  if (mapped) return mapped;
  // Server segments may themselves contain underscores (git_repo, group_agent),
  // so match the server non-greedily and take the tool segment.
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return (mcp ? mcp[2] : name).replace(/_/g, " ");
}

/**
 * The activity-row input summary (user-facing, Korean) for Noah tools whose
 * generic summary — the first string argument — would mislead. Kept here next
 * to the labels for the same reason: the server status line
 * (`summarizeToolInput`) and the client activity row (`summarizeInput`) must
 * agree about one tool. Undefined → the caller's generic summary applies.
 *
 * - `create_share_link`: its only string argument is an opaque attachment id,
 *   while what the user should see is how long the link will live — "7일"
 *   (the default when the model omits the expiry).
 */
export function mcpToolInputSummary(name: string | undefined, input: unknown): string | undefined {
  if (name === "mcp__file_output__create_share_link") {
    const days =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).expiresInDays
        : undefined;
    return `${typeof days === "number" && Number.isInteger(days) && days > 0 ? days : DEFAULT_SHARE_LINK_EXPIRY_DAYS}일`;
  }
  return undefined;
}
