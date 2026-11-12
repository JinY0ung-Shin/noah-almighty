import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import "./AdminView.css";
import Icon from "../components/Icon";
import AdminUserRow from "../components/AdminUserRow";
import AdminEgressPanel from "../components/AdminEgressPanel";
import AdminSharedMcpPanel from "../components/AdminSharedMcpPanel";
import AdminTeamBrainPanel from "../components/AdminTeamBrainPanel";
import AdminToolPolicyPanel from "../components/AdminToolPolicyPanel";
import AdminSharedSkillsPanel from "../components/AdminSharedSkillsPanel";
import { api } from "../lib/api";
import { cx, useAppState } from "../lib/hooks";
import { loadAdminOverview } from "../lib/loaders";
import { notify, readState, replaceState, updateState, type ClientState } from "../lib/state";
import { timeLabel } from "../lib/format";
import type { AdminTab, AdminUserSummary, SignupMode } from "../lib/types";

type UserFilterId = ClientState["adminUserFilter"];
type HexMatrix = Record<string, Record<string, boolean>>;

const signupStatusId = "admin-signup-status";
const hexStatusId = "admin-hex-policy-status";
const toolSkillStatusId = "admin-tool-skill-status";

// Groups were retired (single team, 2026-11-06): their admin powers live in
// 사용자 (approval = joining the team) and 도구·스킬 (tool policy + shared-skill
// blocks).
type AdminTabDef = { id: AdminTab; label: string; icon: string };
const tabs: AdminTabDef[] = [
  { id: "overview", label: "개요", icon: "activity" },
  { id: "users", label: "사용자", icon: "users" },
  { id: "mcp", label: "공용 MCP", icon: "link" },
  { id: "access", label: "가입·접근", icon: "key" },
  { id: "system", label: "시스템", icon: "server" },
  { id: "tools", label: "도구·스킬", icon: "sparkles" },
  { id: "team_brain", label: "팀 브레인", icon: "book" },
  { id: "audit", label: "감사 로그", icon: "list" },
];

const userFilters: { id: UserFilterId; label: string; match: (u: AdminUserSummary) => boolean }[] = [
  { id: "all", label: "전체", match: () => true },
  { id: "admins", label: "관리자", match: (u) => u.roles?.includes("admin") },
  { id: "suspended", label: "정지", match: (u) => u.suspended },
  { id: "group", label: "팀 공개", match: (u) => u.visibility === "group" },
  { id: "sessions", label: "활성 세션", match: (u) => (u.activeSessions || 0) > 0 },
];

const roleDefs = [
  { key: "owner", label: "소유자" },
  { key: "trusted", label: "팀원" },
];
const categoryLabels: Record<string, string> = { read: "조회", execute: "실행", write: "수정·전송", session: "세션" };

const signupModes = [
  {
    id: "approval" as SignupMode,
    label: "승인제",
    desc: "가입 신청은 받지만 관리자가 승인(활성화)해야 로그인됩니다. 승인이 곧 팀 합류이며, 승인된 사용자는 모두 서로 신뢰하는 팀원이 됩니다. 대기 중인 계정은 사용자 탭에 ‘정지’ 상태로 표시됩니다.",
  },
  { id: "closed" as SignupMode, label: "가입 차단", desc: "신규 가입을 받지 않습니다." },
];

// ---- derived ----
// loadAdminOverview stores the raw GET /api/admin/system response, which is
// shaped { system: {...} } — unwrap it (the old loadAdminSystem did r.system).
function unwrapSystem(raw: Record<string, unknown> | null): Record<string, any> {
  if (!raw) return {};
  const inner = (raw as Record<string, any>).system;
  return (inner && typeof inner === "object" ? inner : raw) as Record<string, any>;
}

const filterLabel = (id: string) => userFilters.find((f) => f.id === id)?.label || "전체";

// Display-only Korean labels for the audit `action`/`status` ids the server
// writes (store.audit / auditAs). The raw id stays the filter value and the
// `title=`, so an id added server-side without a label here still reads —
// it just falls back to the raw string in a mono tag.
const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: "로그인",
  signup: "회원가입",
  signup_pending: "가입 승인 대기",
  force_logout: "강제 로그아웃",
  reset_password: "비밀번호 초기화",
  set_role: "역할 변경",
  delete_user: "사용자 삭제",
  suspend_user: "사용자 정지",
  activate_user: "사용자 정지 해제",
  set_signup_mode: "가입 방식 변경",
  set_avatar_visibility: "아바타 공개 범위 변경",
  set_claude_token: "구독 토큰 저장",
  clear_claude_token: "구독 토큰 해제",
  // Noah's own model settings were retired (pi-gateway's admin page owns them);
  // their labels stay for the retained audit rows.
  set_model_override: "아바타 모델 지정",
  clear_model_override: "아바타 모델 해제",
  // Speech-to-text was removed; its labels stay for the retained audit rows.
  set_stt_override: "STT 설정 변경",
  clear_stt_override: "STT 설정 해제",
  set_model_vision_policy: "모델 비전 정책 변경",
  set_hex_ssh_policy: "hex-ssh 도구 정책 변경",
  // Server agents were removed; the label stays for the retained audit rows.
  set_server_agents_enabled: "서버 에이전트 기능 설정",
  set_craft_apps_enabled: "Craft 앱 기능 설정",
  craft_tool: "Craft 앱 도구 실행",
  set_tool_skill_policy: "도구·스킬 정책 변경",
  set_egress_policy: "외부 통신 차단 정책 적용",
  egress_policy_failed: "외부 통신 차단 정책 적용 실패",
  set_tool_policy: "MCP 도구 정책 변경",
  skill_block: "공유 스킬 차단",
  skill_unblock: "공유 스킬 차단 해제",
  single_team_suspend: "단일 팀 전환으로 정지",
  // Groups were retired (single team); their labels stay for the retained
  // audit rows.
  group_create: "그룹 생성",
  group_update: "그룹 정보 수정",
  group_delete: "그룹 삭제",
  group_member_add: "그룹원 추가",
  group_member_remove: "그룹원 제거",
  group_member_role: "그룹원 역할 변경",
  group_repo_set: "그룹 지식 저장소 설정",
  group_tool_policy: "그룹 도구 정책 변경",
  group_avatar_sharing: "그룹원 아바타 상호 공개 변경",
  group_skill_block: "그룹 공유 스킬 차단",
  group_skill_unblock: "그룹 공유 스킬 차단 해제",
  group_agent_create: "그룹 에이전트 생성",
  group_agent_delete: "그룹 에이전트 삭제",
  group_agent_update: "그룹 에이전트 프로필 변경",
  group_agent_image: "그룹 에이전트 사진 변경",
  external_agent_create: "외부 아바타 생성",
  external_agent_update: "외부 아바타 수정",
  external_agent_delete: "외부 아바타 삭제",
  external_agent_enable: "외부 아바타 사용",
  external_agent_disable: "외부 아바타 비활성화",
  external_agent_image: "외부 아바타 사진 변경",
  external_agent_test: "외부 아바타 연결 확인",
  shared_mcp_create: "공용 MCP 서버 추가",
  shared_mcp_update: "공용 MCP 서버 수정",
  shared_mcp_enable: "공용 MCP 서버 사용",
  shared_mcp_disable: "공용 MCP 서버 끄기",
  shared_mcp_delete: "공용 MCP 서버 삭제",
  shared_mcp_check: "공용 MCP 서버 연결 확인",
  shared_mcp_bind: "공용 MCP 서버 시크릿 연결",
  shared_mcp_unbind: "공용 MCP 서버 시크릿 연결 해제",
  knowledge_repo_create: "지식 저장소 생성",
  knowledge_repo_push: "지식 저장소 푸시",
  group_repo_create: "그룹 지식 저장소 생성",
  group_repo_push: "그룹 지식 저장소 푸시",
  ssh_identity_generate_key: "SSH 키 생성",
  system_tool_add_plugin: "플러그인 추가",
  system_tool_set_plugin_enabled: "플러그인 사용 변경",
  system_tool_create_routine: "예약 작업 생성",
  system_tool_update_routine: "예약 작업 수정",
  system_tool_delete_routine: "예약 작업 삭제",
  system_tool_notify_user: "알림 발송",
  todo_tool_add: "할 일 추가(아바타)",
  todo_tool_update: "할 일 수정(아바타)",
  todo_tool_delete: "할 일 삭제(아바타)",
  routine_run: "예약 작업 실행",
  avatar_api_key_create: "외부 작업 API 키 발급",
  avatar_api_key_revoke: "외부 작업 API 키 폐기",
  avatar_api_task_accept: "외부 작업 접수",
  avatar_api_task: "외부 작업 실행",
  share_link_create: "PPT 공유 링크 생성",
  share_link_revoke: "PPT 공유 링크 해제",
  chat: "대화",
};
const AUDIT_STATUS_LABELS: Record<string, string> = {
  success: "성공",
  ok: "성공",
  error: "실패",
};
function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] || action;
}
function auditStatusLabel(status: string): string {
  return AUDIT_STATUS_LABELS[status] || status;
}

// ---- system: pi-gateway's models (READ-ONLY) ----
// pi-gateway's live model list (empty under the local stub or when pi is
// unreachable). Noah no longer sets a model or image input of its own: the
// default model, each model's image input and efforts are pi-gateway's admin
// LLM settings (opened at /admin/ through Noah's own port).
type PiModelRow = {
  id: string;
  server: string | null;
  default?: true;
  imageInput?: boolean;
  reasoning?: { efforts: string[]; defaultEffort?: string } | null;
};

function imageInputLabel(model: PiModelRow): string {
  if (model.imageInput === false) return "미지원";
  return model.imageInput === true ? "지원" : "알 수 없음 (지원으로 처리)";
}

function reasoningLabel(model: PiModelRow): string {
  if (model.reasoning === null) return "사용 안 함";
  if (!model.reasoning) return "알 수 없음";
  const efforts = model.reasoning.efforts.join(", ") || "없음";
  return model.reasoning.defaultEffort ? `${efforts} (기본 ${model.reasoning.defaultEffort})` : efforts;
}

// ---- system: hex-ssh policy ----
function hexToolNames(tools: any[]): string[] {
  return tools.map((tool) => String(tool?.name || "")).filter(Boolean).sort();
}

function hexPolicyKeyFromSaved(policy: Record<string, string[]> = {}, tools: any[]): string {
  const names = hexToolNames(tools);
  return roleDefs
    .map((role) => {
      const allowed = Array.isArray(policy[role.key]) ? policy[role.key] : [];
      return `${role.key}:${names.filter((name) => allowed.includes(name)).join(",")}`;
    })
    .join("|");
}

function hexPolicyKeyFromMatrix(matrix: HexMatrix, tools: any[]): string {
  const names = hexToolNames(tools);
  return roleDefs
    .map((role) => `${role.key}:${names.filter((name) => Boolean(matrix[role.key]?.[name])).join(",")}`)
    .join("|");
}

/** Does the local checkbox matrix differ from the policy `sys` has saved? */
function hexDirtyOf(sys: Record<string, any>, matrix: HexMatrix): boolean {
  const tools = Array.isArray(sys.hexSshTools) ? sys.hexSshTools : [];
  return Boolean(tools.length && hexPolicyKeyFromMatrix(matrix, tools) !== hexPolicyKeyFromSaved(sys.hexSshToolPolicy || {}, tools));
}

// ---- system: skill policy ----
// Hand-mirrors SKILL_NAME_RE in src/server/toolSkillPolicy.ts (no shared
// module across the client-server boundary) — update in lockstep.
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function toolSkillPolicyKey(skills: string[]): string {
  return [...skills].sort().join(",");
}

function disabledSkillNamesFrom(checks: Record<string, boolean>, custom: string[]): string[] {
  const out = Object.keys(checks).filter((name) => checks[name]);
  for (const name of custom) {
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Does the local skill selection differ from the policy `sys` has saved? */
function toolSkillDirtyOf(sys: Record<string, any>, checks: Record<string, boolean>, custom: string[]): boolean {
  const saved = sys.toolSkillPolicy || {};
  return toolSkillPolicyKey(disabledSkillNamesFrom(checks, custom)) !== toolSkillPolicyKey(saved.disabledSkills || []);
}

/**
 * State that a continuation running LATER (after an `await`) reads as it is
 * now: the ref is written together with the state, not at the next render.
 */
function useLive<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(initial);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  });
  return [value, set.current, ref];
}

export default function AdminView() {
  const state = useAppState();
  const [loading, setLoading] = useState(true);
  const [loadBusy, setLoadBusy, loadBusyRef] = useLive(false);
  const [error, setError] = useState("");
  // One-shot latch for load()'s dirty-guards: before the FIRST seeding the
  // panels' local state is empty, so the dirty flags read as "unsaved edits"
  // against the fresh server payload and would skip seeding entirely —
  // hexPolicy stays {} and the 시스템 tab has nothing to show for
  // hexPolicy[role][tool].
  const panelsSeeded = useRef(false);

  // system tab field state
  const [hexBusy, setHexBusy] = useState(false);
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState("");
  const [hexError, setHexError] = useState("");
  // hex-ssh policy local checkbox matrix: policy[role][toolName] = boolean
  const [hexPolicy, setHexPolicy, hexPolicyRef] = useLive<HexMatrix>({});
  // skill policy local state: checked = DISABLED deployment-wide
  const [toolSkillBusy, setToolSkillBusy] = useState(false);
  const [toolSkillError, setToolSkillError] = useState("");
  const [disabledSkillChecks, setDisabledSkillChecks, disabledSkillChecksRef] = useLive<Record<string, boolean>>({});
  const [customDisabledSkills, setCustomDisabledSkills, customDisabledSkillsRef] = useLive<string[]>([]);
  const [customSkillInput, setCustomSkillInput] = useState("");

  // audit action filter
  const [auditAction, setAuditAction] = useState("");
  const auditSelect = useRef<HTMLSelectElement | null>(null);

  // The radio the admin last clicked. The saved mode decides which card is
  // checked only when it CHANGES; until then the clicked one stays checked
  // (through the save, and after a failed one) — `base` is the saved mode the
  // click was made against.
  const [signupPick, setSignupPick] = useState<{ base: SignupMode; mode: SignupMode } | null>(null);

  // ---- derived ----
  const sys = unwrapSystem(state.adminSystem);
  const currentUserFilter = userFilters.find((f) => f.id === state.adminUserFilter) || userFilters[0];
  const filteredUsers = (() => {
    const q = state.adminUserSearch.trim().toLowerCase();
    return state.adminUsers.filter(
      (u) =>
        currentUserFilter.match(u) &&
        (!q || (u.displayName || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q)),
    );
  })();
  const audit = state.audit || [];
  const auditActions = [...new Set(audit.map((r) => r.action))].sort();
  const shownAudit = auditAction ? audit.filter((r) => r.action === auditAction) : audit;
  const stats = state.adminStats;
  // The retired `open` mode reads as 승인제 (the server fails closed the same way).
  const signupMode = (sys.signupMode === "closed" ? "closed" : "approval") as SignupMode;
  if (signupPick && signupPick.base !== signupMode) setSignupPick(null);
  const checkedSignupMode = signupPick && signupPick.base === signupMode ? signupPick.mode : signupMode;
  const signupModeLabel = signupModes.find((m) => m.id === signupMode)?.label || "승인제";
  const signupStatus = signupBusy ? "회원가입 정책을 저장 중입니다." : signupError ? `저장 실패: ${signupError}` : `현재 정책: ${signupModeLabel}`;
  const hexTools: any[] = Array.isArray(sys.hexSshTools) ? sys.hexSshTools : [];
  const hexDirty = hexDirtyOf(sys, hexPolicy);
  const hexCanSave = Boolean(!hexBusy && hexDirty);
  const hexStatus = hexBusy
    ? "정책을 저장 중입니다."
    : hexError
      ? `저장 실패: ${hexError}`
      : hexDirty
        ? "저장하지 않은 정책 변경 사항이 있습니다."
        : hexTools.length
          ? "저장된 정책과 같습니다."
          : "설정할 SSH 도구가 없습니다.";
  const discoveredSkills: any[] = sys.skillDiscovery && Array.isArray(sys.skillDiscovery.skills) ? sys.skillDiscovery.skills : [];
  const localDisabledSkills = disabledSkillNamesFrom(disabledSkillChecks, customDisabledSkills);
  const toolSkillDirty = toolSkillDirtyOf(sys, disabledSkillChecks, customDisabledSkills);
  const toolSkillCanSave = Boolean(!toolSkillBusy && toolSkillDirty);
  const toolSkillStatus = toolSkillBusy
    ? "정책을 저장 중입니다."
    : toolSkillError
      ? `저장 실패: ${toolSkillError}`
      : toolSkillDirty
        ? "저장하지 않은 정책 변경 사항이 있습니다."
        : "저장된 정책과 같습니다.";
  const piModels = (Array.isArray(sys.piModels) ? sys.piModels : []) as PiModelRow[];

  // overview stat cards
  const statCards = [
    { label: "전체 사용자", value: stats?.users, sub: stats?.suspended ? `정지 ${stats.suspended}명 포함` : "", target: "users", filter: "all" },
    { label: "관리자", value: stats?.admins, sub: "", target: "users", filter: "admins" },
    { label: "팀 공개 아바타", value: stats?.groupAvatars, sub: "", target: "users", filter: "group" },
    { label: "대화", value: stats?.conversations, sub: "", target: "", filter: "all" },
    { label: "메시지", value: stats?.messages, sub: "", target: "", filter: "all" },
    { label: "활성 예약 작업", value: stats?.activeRoutines, sub: "", target: "", filter: "all" },
    { label: "미응답 질문", value: stats?.openRequests, sub: "", target: "", filter: "all" },
    { label: "활성 세션", value: stats?.activeSessions, sub: "", target: "users", filter: "sessions" },
  ] as { label: string; value: number | undefined; sub: string; target: string; filter: UserFilterId }[];

  // Per-filter counts, recomputed with the user list so the chips follow a
  // suspend/delete/role change.
  const userFilterCounts = new Map(userFilters.map((f) => [f.id, state.adminUsers.filter(f.match).length]));

  async function load() {
    if (loadBusyRef.current) return;
    setLoadBusy(true);
    setLoading(true);
    setError("");
    try {
      await loadAdminOverview();
      // Preserve unsaved policy edits across a manual 새로고침 (the header button
      // calls load() on every tab): only re-seed a panel from server state when
      // it has NO pending edits — otherwise the refresh silently discards them,
      // which contradicts the "저장하지 않은 변경 사항" banner shown right there.
      // The guards apply only AFTER the first seed (panelsSeeded) — see the
      // flag's declaration for why they misfire on the initial load. "Pending
      // edits" is the local state as it is NOW against the payload that just
      // landed.
      const fresh = unwrapSystem(readState().adminSystem);
      if (!panelsSeeded.current || !hexDirtyOf(fresh, hexPolicyRef.current)) syncHexPolicyFromSys();
      if (!panelsSeeded.current || !toolSkillDirtyOf(fresh, disabledSkillChecksRef.current, customDisabledSkillsRef.current)) {
        syncToolSkillFromSys();
      }
      panelsSeeded.current = true;
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setLoadBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A filter value that is no longer among the options (its last record left
  // the log) shows as NO selection, not as the first option.
  useLayoutEffect(() => {
    const select = auditSelect.current;
    if (select && auditAction && !auditActions.includes(auditAction)) select.selectedIndex = -1;
  });

  function setTab(id: AdminTab) {
    updateState((s) => (s.adminTab = id));
  }

  function focusAdminTab(id: AdminTab): void {
    requestAnimationFrame(() => document.getElementById(`admin-tab-${id}`)?.focus());
  }

  function onAdminTabKeydown(event: ReactKeyboardEvent<HTMLButtonElement>, currentId: AdminTab): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.findIndex((tab) => tab.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex].id;
    setTab(next);
    focusAdminTab(next);
  }

  function goOverviewTarget(target: string, filter: UserFilterId) {
    if (!target) return;
    updateState((s) => {
      s.adminTab = target as AdminTab;
      if (target === "users") s.adminUserFilter = filter;
    });
  }

  function setUserFilter(id: UserFilterId) {
    updateState((s) => (s.adminUserFilter = id));
  }

  function focusUserFilter(id: UserFilterId): void {
    requestAnimationFrame(() => document.getElementById(`admin-user-filter-${id}`)?.focus());
  }

  function onUserFilterKeydown(event: ReactKeyboardEvent<HTMLButtonElement>, currentId: UserFilterId): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = userFilters.findIndex((item) => item.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? userFilters.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + userFilters.length) % userFilters.length;
    const next = userFilters[nextIndex].id;
    setUserFilter(next);
    focusUserFilter(next);
  }

  // ---- access ----
  async function saveSignupMode(mode: SignupMode) {
    if (signupBusy || signupMode === mode) return;
    setSignupBusy(true);
    setSignupError("");
    try {
      await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode }) });
    } catch (err) {
      const message = (err as Error).message;
      setSignupBusy(false);
      setSignupError(message);
      notify(`저장 실패: ${message}`);
      return;
    }
    try {
      await loadAdminOverview();
      const bootstrap = readState().bootstrap;
      if (bootstrap) replaceState({ bootstrap: { ...bootstrap, signupMode: mode } });
      notify("회원가입 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`회원가입 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setSignupBusy(false);
    }
  }

  // ---- system: hex-ssh policy ----
  function syncHexPolicyFromSys() {
    const cur = unwrapSystem(readState().adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const policy = cur.hexSshToolPolicy || {};
    const next: HexMatrix = {};
    for (const role of roleDefs) {
      next[role.key] = {};
      for (const tool of tools) {
        next[role.key][tool.name] = Array.isArray(policy[role.key]) && policy[role.key].includes(tool.name);
      }
    }
    setHexPolicy(next);
  }

  async function saveHexPolicy() {
    if (!hexCanSave) return;
    const cur = unwrapSystem(readState().adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const nextPolicy: Record<string, string[]> = {};
    for (const role of roleDefs) {
      nextPolicy[role.key] = tools.filter((t: any) => hexPolicy[role.key]?.[t.name]).map((t: any) => t.name);
    }
    setHexBusy(true);
    setHexError("");
    try {
      await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
    } catch (err) {
      const message = (err as Error).message;
      setHexBusy(false);
      setHexError(message);
      notify(`저장 실패: ${message}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncHexPolicyFromSys();
      notify("SSH 도구 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`SSH 도구 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setHexBusy(false);
    }
  }

  // ---- system: skill policy ----
  function syncToolSkillFromSys() {
    const cur = unwrapSystem(readState().adminSystem);
    const saved = cur.toolSkillPolicy || {};
    const savedSkills: string[] = Array.isArray(saved.disabledSkills) ? saved.disabledSkills.map(String) : [];
    const discovered = cur.skillDiscovery && Array.isArray(cur.skillDiscovery.skills) ? cur.skillDiscovery.skills : [];
    const skillChecks: Record<string, boolean> = {};
    const discoveredNames = new Set<string>();
    for (const skill of discovered) {
      const name = String(skill?.name || "");
      if (!name) continue;
      discoveredNames.add(name);
      skillChecks[name] = savedSkills.includes(name);
    }
    setDisabledSkillChecks(skillChecks);
    // Saved names the discovery list doesn't cover (typed by an admin, or from
    // an older skill list) stay visible/removable so the dirty-compare stays honest.
    setCustomDisabledSkills(savedSkills.filter((name) => !discoveredNames.has(name)));
  }

  function addCustomDisabledSkill() {
    const name = customSkillInput.trim();
    if (!name) return;
    if (!SKILL_NAME_RE.test(name)) {
      setToolSkillError("스킬 이름 형식이 올바르지 않습니다. (영숫자로 시작, 최대 128자)");
      return;
    }
    setToolSkillError("");
    if (name in disabledSkillChecks) {
      setDisabledSkillChecks({ ...disabledSkillChecks, [name]: true });
    } else if (!customDisabledSkills.includes(name)) {
      setCustomDisabledSkills([...customDisabledSkills, name]);
    }
    setCustomSkillInput("");
  }

  function removeCustomDisabledSkill(name: string) {
    setCustomDisabledSkills(customDisabledSkills.filter((n) => n !== name));
  }

  async function saveToolSkillPolicy() {
    if (!toolSkillCanSave) return;
    setToolSkillBusy(true);
    setToolSkillError("");
    try {
      await api("/api/admin/tool-skill-policy", {
        method: "PUT",
        body: JSON.stringify({ policy: { disabledSkills: localDisabledSkills } }),
      });
    } catch (err) {
      const message = (err as Error).message;
      setToolSkillBusy(false);
      setToolSkillError(message);
      notify(`저장 실패: ${message}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncToolSkillFromSys();
      notify("스킬 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setToolSkillBusy(false);
    }
  }

  async function reloadUsers() {
    await loadAdminOverview();
  }

  const customDisabledSkillOptions = customDisabledSkills.map((name) => (
    <label className="policy-option" key={name}>
      <input type="checkbox" checked disabled={toolSkillBusy} onChange={() => removeCustomDisabledSkill(name)} />
      <span>
        <strong>{name}</strong>
        <small className="muted">직접 추가됨 — 체크를 해제하면 목록에서 제거됩니다.</small>
      </span>
    </label>
  ));

  return (
    <>
      <header className="view-header cmp-admin-view">
        <div className="title">
          <h1>관리자</h1>
          <p>사용자·접근·시스템을 관리하세요</p>
        </div>
        <button className="ghost-sm" type="button" disabled={loadBusy} onClick={() => void load()}>
          {loadBusy ? "새로고침 중…" : "새로고침"}
        </button>
      </header>

      <div className="view-body scroll-thin cmp-admin-view">
        {loading ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : error ? (
          <div className="warn-box" role="alert">
            관리자 정보를 불러오지 못했습니다: {error}{" "}
            <button className="linkish" type="button" disabled={loadBusy} onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        ) : (
          <>
            <div className="settings-tabs admin-primary-tabs" role="tablist" aria-label="관리자 분류">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  id={`admin-tab-${tab.id}`}
                  className={cx("settings-tab", state.adminTab === tab.id && "active")}
                  type="button"
                  role="tab"
                  aria-selected={state.adminTab === tab.id}
                  aria-controls="admin-panel"
                  tabIndex={state.adminTab === tab.id ? 0 : -1}
                  onClick={() => setTab(tab.id)}
                  onKeyDown={(event) => onAdminTabKeydown(event, tab.id)}
                >
                  <Icon name={tab.icon} /> <span>{tab.label}</span>
                </button>
              ))}
            </div>

            <div className="admin-panel" role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${state.adminTab}`}>
              <AdminEgressPanel active={state.adminTab === "access"} />
              <AdminSharedMcpPanel active={state.adminTab === "mcp"} />
              <AdminTeamBrainPanel active={state.adminTab === "team_brain"} />
              {/* 도구·스킬: always mounted so a draft survives tab switches; each panel
                  renders only while active, and the wrapper takes the list layout only
                  then (an empty grid elsewhere would add a stray gap). */}
              <div className={state.adminTab === "tools" ? "admin-list" : undefined}>
                <AdminToolPolicyPanel active={state.adminTab === "tools"} />
                <AdminSharedSkillsPanel active={state.adminTab === "tools"} />
              </div>
              {state.adminTab === "overview" ? (
                <div className="admin-list">
                  <section className="settings-card">
                    <div className="panel-section-head">
                      <div>
                        <h3>현황</h3>
                        <p className="muted">이 인스턴스의 전체 사용 현황입니다.</p>
                      </div>
                    </div>
                    <div className="stat-grid">
                      {statCards.map((c, index) =>
                        c.target ? (
                          <button
                            key={index}
                            className="stat-card stat-clickable"
                            type="button"
                            aria-label={`${c.label} 사용자 관리로 이동`}
                            onClick={() => goOverviewTarget(c.target, c.filter)}
                          >
                            <div className="stat-value">{c.value ?? 0}</div>
                            <div className="stat-label">{c.label}</div>
                            {c.sub && <div className="stat-sub muted">{c.sub}</div>}
                            <div className="stat-link muted">사용자 관리</div>
                          </button>
                        ) : (
                          <div className="stat-card" key={index}>
                            <div className="stat-value">{c.value ?? 0}</div>
                            <div className="stat-label">{c.label}</div>
                            {c.sub && <div className="stat-sub muted">{c.sub}</div>}
                          </div>
                        ),
                      )}
                    </div>
                  </section>
                </div>
              ) : state.adminTab === "users" ? (
                <div className="admin-users">
                  <div className="admin-users-head">
                    <input
                      type="search"
                      className="admin-search"
                      placeholder="이름 또는 아이디로 검색"
                      aria-label="사용자 검색"
                      value={state.adminUserSearch}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        updateState((s) => (s.adminUserSearch = value));
                      }}
                    />
                    <span className="muted nowrap">
                      표시 {filteredUsers.length}명 / 전체 {state.adminUsers.length}명
                    </span>
                  </div>
                  <div className="admin-filter seg-control" role="radiogroup" aria-label="사용자 필터">
                    {userFilters.map((f) => (
                      <button
                        key={f.id}
                        id={`admin-user-filter-${f.id}`}
                        className={cx("seg-btn", state.adminUserFilter === f.id && "active")}
                        type="button"
                        role="radio"
                        aria-checked={state.adminUserFilter === f.id}
                        tabIndex={state.adminUserFilter === f.id ? 0 : -1}
                        onClick={() => setUserFilter(f.id)}
                        onKeyDown={(event) => onUserFilterKeydown(event, f.id)}
                      >
                        {f.label} {userFilterCounts.get(f.id) ?? 0}
                      </button>
                    ))}
                  </div>
                  <div className="admin-list">
                    {!filteredUsers.length ? (
                      <div className="muted pad">
                        {state.adminUserSearch.trim() ? (
                          <>
                            "{state.adminUserSearch.trim()}"에 맞는{" "}
                            {state.adminUserFilter === "all" ? "사용자" : `${filterLabel(state.adminUserFilter)} 사용자`}가 없습니다.{" "}
                            <button className="linkish small" type="button" onClick={() => updateState((s) => (s.adminUserSearch = ""))}>
                              검색어 지우기
                            </button>{" "}
                            {state.adminUserFilter !== "all" && (
                              <button className="linkish small" type="button" onClick={() => setUserFilter("all")}>
                                전체 사용자 보기
                              </button>
                            )}
                          </>
                        ) : state.adminUserFilter !== "all" ? (
                          <>
                            {filterLabel(state.adminUserFilter)} 사용자가 없습니다.{" "}
                            <button className="linkish small" type="button" onClick={() => setUserFilter("all")}>
                              전체 사용자 보기
                            </button>
                          </>
                        ) : (
                          "사용자가 없습니다."
                        )}
                      </div>
                    ) : (
                      filteredUsers.map((user) => <AdminUserRow key={user.id} user={user} reload={reloadUsers} />)
                    )}
                  </div>
                </div>
              ) : state.adminTab === "access" ? (
                <div className="admin-list">
                  <section className="settings-card">
                    <div className="panel-section-head">
                      <div>
                        <h3>회원가입 정책</h3>
                        <p className="muted">
                          새 사용자가 팀에 합류하는 방식을 정합니다. 이 서버의 승인된 사용자는 모두 한 팀이며 서로 신뢰하므로, 누구나 바로 가입하는 방식은 없습니다. 첫 관리자
                          계정은 정책과 무관하게 항상 허용됩니다.
                        </p>
                      </div>
                    </div>
                    <div className="radio-cards" role="radiogroup" aria-label="회원가입 정책" aria-describedby={signupStatusId}>
                      {signupModes.map((m) => (
                        <label className="radio-card" htmlFor={`sm-${m.id}`} key={m.id}>
                          <input
                            type="radio"
                            name="signup-mode"
                            id={`sm-${m.id}`}
                            value={m.id}
                            checked={checkedSignupMode === m.id}
                            disabled={signupBusy}
                            onChange={() => {
                              setSignupPick({ base: signupMode, mode: m.id });
                              void saveSignupMode(m.id);
                            }}
                          />
                          <div className="radio-card-body">
                            <strong>{m.label}</strong>
                            <div className="muted">{m.desc}</div>
                          </div>
                        </label>
                      ))}
                    </div>
                    <div className="settings-save-row compact">
                      <span
                        id={signupStatusId}
                        className={cx("settings-save-status", signupBusy && "pending", Boolean(signupError) && "invalid")}
                        role="status"
                        aria-live="polite"
                      >
                        {signupStatus}
                      </span>
                    </div>
                  </section>
                </div>
              ) : state.adminTab === "system" ? (
                !state.adminSystem ? (
                  <div className="warn-box" role="alert">
                    시스템 정보를 불러올 수 없습니다.{" "}
                    <button className="linkish" type="button" disabled={loadBusy} onClick={() => void load()}>
                      다시 시도
                    </button>
                  </div>
                ) : (
                  <div className="admin-list">
                    {/* system info */}
                    <div className="settings-card sys-card">
                      <h3>시스템 정보</h3>
                      <div className="sys-grid">
                        <div className="sys-row">
                          <span className="sys-key muted">런타임</span>{" "}
                          <span className="sys-val">
                            <span className="tag mono">{sys.agentRuntime === "pi" ? "pi-gateway" : "로컬 스텁"}</span>
                          </span>
                        </div>
                        <div className="sys-row">
                          <span className="sys-key muted">pi 모델</span>{" "}
                          <span className="sys-val">
                            {piModels.length ? (
                              piModels.map((model) => (
                                <Fragment key={model.id}>
                                  <span className="tag mono" title={model.server ? `제공: ${model.server}` : undefined}>
                                    {model.id}
                                  </span>{" "}
                                </Fragment>
                              ))
                            ) : (
                              <span className="muted">
                                {sys.agentRuntime === "pi"
                                  ? "없음 — pi-gateway 모델 목록을 불러오지 못했습니다 (기본 모델로 실행)"
                                  : "없음 (로컬 스텁)"}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="sys-row">
                          <span className="sys-key muted">실제 사용 모델</span>{" "}
                          <span className="sys-val">
                            {sys.observedModel ? (
                              <span className="tag mono accent">{sys.observedModel}</span>
                            ) : (
                              <span className="muted">아직 확인되지 않음 (첫 대화 후 표시)</span>
                            )}
                          </span>
                        </div>
                        <div className="sys-row">
                          <span className="sys-key muted">Confluence</span>{" "}
                          <span className="sys-val">
                            {sys.confluenceConfigured ? <span className="tag">host 설정됨</span> : <span className="muted">CONFLUENCE_URL 미설정</span>}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* pi-gateway's models: read-only (pi's admin LLM page owns them) */}
                    <section className="settings-card">
                      <div className="panel-section-head">
                        <div>
                          <h3>LLM 모델 (pi-gateway)</h3>
                          <p className="muted">
                            LLM 서버·키·모델·기본 모델·이미지 입력·시스템 프롬프트는 pi-gateway 관리 화면에서 바꿉니다. 이 표는 pi-gateway가 지금 제공하는 모델을 보여 주기만 합니다.
                            대화에서 모델을 고르지 않으면 Noah는 pi-gateway의 <span className="mono">falcon</span> 티어를 사용합니다. falcon 티어가 없으면 아래 표에서 '기본'으로 표시된 pi-gateway 기본 모델을 사용합니다. 이미지 입력이 미지원인 모델을 쓰는 대화에서는 첨부한 이미지가 파일로만 전달됩니다.
                          </p>
                          <p className="muted">
                            pi-gateway의 시스템 프롬프트 <span className="mono">noah</span>, Noah MCP 서버 등록, Noah가 꺼 둔 pi 도구는 배포(docker compose up) 때마다 저장소 기준으로 되돌아갑니다. 관리 화면에서 바꾼 내용은 다음 배포 전까지만 유지됩니다.
                          </p>
                        </div>
                        <a className="btn sm" href="/admin/" target="_blank" rel="noopener">
                          pi-gateway 관리 화면 열기
                        </a>
                      </div>
                      {piModels.length ? (
                        <div className="hex-policy-grid" role="group" aria-label="pi-gateway 모델 목록">
                          <div className="hex-policy-head muted">모델</div>
                          <div className="hex-policy-head">기본</div>
                          <div className="hex-policy-head">이미지 입력</div>
                          <div className="hex-policy-head">추론 단계</div>
                          {piModels.map((model) => (
                            <Fragment key={model.id}>
                              <div className="hex-policy-tool">
                                <strong className="mono">{model.id}</strong>{" "}
                                {model.server && <span className="muted mono">{model.server}</span>}
                              </div>
                              <div className="hex-policy-check">
                                {model.default ? <span className="tag ok">기본</span> : <span className="muted">—</span>}
                              </div>
                              <div className="hex-policy-check">
                                <span className={model.imageInput !== true ? "muted" : undefined}>{imageInputLabel(model)}</span>
                              </div>
                              <div className="hex-policy-check">
                                <span className="muted">{reasoningLabel(model)}</span>
                              </div>
                            </Fragment>
                          ))}
                        </div>
                      ) : (
                        <div className="empty-note">
                          {sys.agentRuntime === "pi"
                            ? "pi-gateway 모델 목록을 불러오지 못했습니다. 대화는 pi-gateway 기본 모델로 실행됩니다."
                            : "로컬 스텁에는 모델이 없습니다."}
                        </div>
                      )}
                    </section>

                    {/* hex-ssh policy */}
                    {Array.isArray(sys.hexSshTools) && sys.hexSshTools.length ? (
                      <section className="settings-card">
                        <div className="panel-section-head">
                          <div>
                            <h3>SSH 도구 정책</h3>
                            <p className="muted">hex-ssh MCP 도구를 아바타 소유자 본인과, 그 아바타와 대화하는 팀원에게 각각 허용할지 정합니다.</p>
                          </div>
                        </div>
                        <form
                          className="hex-policy-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveHexPolicy();
                          }}
                        >
                          <div className="hex-policy-grid cols-2" role="group" aria-label="SSH 도구 역할별 정책" aria-describedby={hexStatusId}>
                            <div className="hex-policy-head muted">도구</div>
                            {roleDefs.map((role, index) => (
                              <div className="hex-policy-head" key={index}>
                                {role.label}
                              </div>
                            ))}
                            {sys.hexSshTools.map((tool: any, toolIndex: number) => (
                              <Fragment key={toolIndex}>
                                <div className="hex-policy-tool">
                                  <strong>{tool.label || tool.name}</strong> <span className="muted mono">{tool.name}</span>{" "}
                                  <span className={`tag ${tool.category === "read" ? "read" : "write"}`}>
                                    {categoryLabels[tool.category] || tool.category}
                                  </span>
                                </div>
                                {roleDefs.map((role, roleIndex) => (
                                  <label className="hex-policy-check" key={roleIndex}>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(hexPolicy[role.key]?.[tool.name])}
                                      aria-label={`${role.label} ${tool.label || tool.name}`}
                                      aria-describedby={hexStatusId}
                                      disabled={hexBusy}
                                      onChange={(event) => {
                                        const current = hexPolicyRef.current;
                                        setHexPolicy({ ...current, [role.key]: { ...current[role.key], [tool.name]: event.currentTarget.checked } });
                                        setHexError("");
                                      }}
                                    />
                                  </label>
                                ))}
                              </Fragment>
                            ))}
                          </div>
                          <div className="settings-save-row">
                            <span
                              id={hexStatusId}
                              className={cx(
                                "settings-save-status",
                                hexDirty && !hexBusy && !hexError && "dirty",
                                hexBusy && "pending",
                                Boolean(hexError) && "invalid",
                              )}
                              role="status"
                              aria-live="polite"
                            >
                              {hexStatus}
                            </span>
                            <button className="primary" type="submit" disabled={!hexCanSave}>
                              {hexBusy ? "저장 중…" : "정책 저장"}
                            </button>
                          </div>
                        </form>
                      </section>
                    ) : (
                      <section className="settings-card">
                        <div className="panel-section-head">
                          <div>
                            <h3>SSH 도구 정책</h3>
                            <p className="muted">hex-ssh MCP 도구를 아바타 소유자 본인과, 그 아바타와 대화하는 팀원에게 각각 허용할지 정합니다.</p>
                          </div>
                        </div>
                        <div className="empty-note">
                          현재 설정할 SSH 도구가 없습니다. hex-ssh 도구 목록이 서버에서 제공되면 역할별 정책 표가 여기에 표시됩니다.
                        </div>
                      </section>
                    )}

                    {/* skill policy (built-in tool toggles retired, #78) */}
                    <section className="settings-card">
                      <div className="panel-section-head">
                        <div>
                          <h3>스킬 정책</h3>
                          <p className="muted">체크한 스킬은 모든 아바타에서 비활성화됩니다. 아바타의 스킬 목록에서 빠지고 읽기도 차단됩니다.</p>
                          <p className="muted">
                            하위 에이전트(Agent) 같은 내장 도구는 여기서 끄지 않습니다. <a href="/admin/" target="_blank" rel="noopener">pi-gateway 관리 화면</a>의 도구 설정에서 끄면 모든 세션에서 실제로 빠집니다. (Agent 도구는 pi에 에이전트가 들어 있는 플러그인을 설치했을 때만 생깁니다.)
                          </p>
                        </div>
                      </div>
                      <form
                        className="settings-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveToolSkillPolicy();
                        }}
                      >
                        <div className="field">
                          <span>스킬 비활성화</span>
                          {sys.skillDiscovery ? (
                            <>
                              <p className="muted">기본 스킬 플러그인에서 찾은 스킬 {discoveredSkills.length}개입니다.</p>
                              <div className="policy-option-picker" role="group" aria-label="스킬 비활성화" aria-describedby={toolSkillStatusId}>
                                {discoveredSkills.map((skill) => (
                                  <label className="policy-option" key={skill.name}>
                                    <input
                                      type="checkbox"
                                      checked={Boolean(disabledSkillChecks[skill.name])}
                                      aria-describedby={toolSkillStatusId}
                                      disabled={toolSkillBusy}
                                      onChange={(event) => {
                                        setDisabledSkillChecks({ ...disabledSkillChecksRef.current, [skill.name]: event.currentTarget.checked });
                                        setToolSkillError("");
                                      }}
                                    />
                                    <span>
                                      <strong>{skill.name}</strong>
                                      {skill.description && <small className="muted">{skill.description}</small>}
                                    </span>
                                  </label>
                                ))}
                                {customDisabledSkillOptions}
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="empty-note">
                                스킬 목록을 불러오지 못했습니다. 아래 입력으로 스킬 이름을 직접 추가해 비활성화할 수 있습니다.
                              </div>
                              {customDisabledSkills.length ? (
                                <div className="policy-option-picker" role="group" aria-label="직접 추가한 비활성 스킬" aria-describedby={toolSkillStatusId}>
                                  {customDisabledSkillOptions}
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                        <label className="field">
                          <span>스킬 이름 직접 추가</span>
                          <input
                            value={customSkillInput}
                            placeholder="예: code-review"
                            autoComplete="off"
                            aria-describedby={toolSkillStatusId}
                            aria-invalid={toolSkillError ? "true" : undefined}
                            disabled={toolSkillBusy}
                            onChange={(event) => {
                              setCustomSkillInput(event.currentTarget.value);
                              setToolSkillError("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                addCustomDisabledSkill();
                              }
                            }}
                          />
                        </label>
                        <div className="ar-actions">
                          <button className="ghost-sm" type="button" disabled={toolSkillBusy || !customSkillInput.trim()} onClick={addCustomDisabledSkill}>
                            비활성 목록에 추가
                          </button>
                        </div>
                        <div className="settings-save-row">
                          <span
                            id={toolSkillStatusId}
                            className={cx(
                              "settings-save-status",
                              toolSkillDirty && !toolSkillBusy && !toolSkillError && "dirty",
                              toolSkillBusy && "pending",
                              Boolean(toolSkillError) && "invalid",
                            )}
                            role="status"
                            aria-live="polite"
                          >
                            {toolSkillStatus}
                          </span>
                          <button className="primary" type="submit" disabled={!toolSkillCanSave}>
                            {toolSkillBusy ? "저장 중…" : "정책 저장"}
                          </button>
                        </div>
                      </form>
                    </section>
                  </div>
                )
              ) : state.adminTab === "audit" ? (
                <div className="admin-list">
                  <section className="settings-card">
                    <div className="panel-section-head">
                      <div>
                        <h3>감사 로그</h3>
                        <p className="muted">최근 활동 {audit.length}건 (로그인·권한 변경·관리 작업 등).</p>
                      </div>
                    </div>
                    <div className="admin-users-head">
                      <select
                        ref={auditSelect}
                        className="admin-search"
                        aria-label="액션 필터"
                        value={auditAction}
                        onChange={(event) => setAuditAction(event.currentTarget.value)}
                        disabled={!auditActions.length}
                      >
                        <option value="">{auditActions.length ? "전체 액션" : "필터할 액션 없음"}</option>
                        {auditActions.map((a, index) => (
                          <option value={a} title={a} key={index}>
                            {auditActionLabel(a)}
                          </option>
                        ))}
                      </select>
                      <span className="muted nowrap">
                        {auditAction ? `표시 ${shownAudit.length}건 / 전체 ${audit.length}건` : `총 ${shownAudit.length}건`}
                      </span>
                      {auditAction && (
                        <button className="linkish small" type="button" onClick={() => setAuditAction("")}>
                          필터 해제
                        </button>
                      )}
                    </div>
                    <div className="audit-table-wrap">
                      {!shownAudit.length ? (
                        auditAction ? (
                          <div className="muted pad">
                            “{auditActionLabel(auditAction)}” 액션 기록이 없습니다.{" "}
                            <button className="linkish small" type="button" onClick={() => setAuditAction("")}>
                              전체 액션 보기
                            </button>
                          </div>
                        ) : (
                          <div className="muted pad">기록이 없습니다.</div>
                        )
                      ) : (
                        <div className="audit-table">
                          {shownAudit.map((r) => (
                            <div className="audit-row" key={r.id}>
                              <span className="audit-time muted">{timeLabel(r.createdAt)}</span>
                              <span className="audit-actor">{r.actorName || "—"}</span>
                              <span className={cx("tag audit-action-tag", !AUDIT_ACTION_LABELS[r.action] && "mono")} title={r.action}>
                                {auditActionLabel(r.action)}
                              </span>
                              <span className={`tag ${r.status === "success" || r.status === "ok" ? "read" : "danger"}`} title={r.status}>
                                {auditStatusLabel(r.status)}
                              </span>
                              <span className="audit-detail muted">{r.detail || ""}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </>
  );
}
