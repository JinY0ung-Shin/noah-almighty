<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "../components/Icon.svelte";
  import RevealableInput from "../components/RevealableInput.svelte";
  import AdminUserRow from "../components/AdminUserRow.svelte";
  import AdminExternalAgentsPanel from "../components/AdminExternalAgentsPanel.svelte";
  import AdminEgressPanel from "../components/AdminEgressPanel.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { loadAdminGroups, loadAdminOverview } from "../lib/loaders";
  import { goView } from "../lib/nav";
  import { appState, notify, replaceState, updateState } from "../lib/state";
  import { timeLabel } from "../lib/format";
  import { MODEL_TIERS } from "../../../server/modelTiers";
  import type { AdminTab, AdminUserSummary, SignupMode } from "../lib/types";

  let loading = true;
  let loadBusy = false;
  let error = "";
  // One-shot latch for load()'s dirty-guards: before the FIRST seeding the
  // panels' local state is empty, so the reactive dirty flags (recomputed when
  // replaceState lands, before load()'s continuation resumes) read as "unsaved
  // edits" against the fresh server payload and would skip seeding entirely —
  // hexPolicy stays {} and the 시스템 tab crashes on hexPolicy[role][tool].
  let panelsSeeded = false;

  // system tab field state
  let modelInput = "";
  let claudeToken = "";
  let subBusy = false;
  let modelBusy = false;
  let hexBusy = false;
  let signupBusy = false;
  let tokenError = "";
  let modelError = "";
  let signupError = "";
  let hexError = "";
  // hex-ssh policy local checkbox matrix: policy[role][toolName] = boolean
  let hexPolicy: Record<string, Record<string, boolean>> = {};
  // STT endpoint override draft (empty url = "no admin override")
  let sttUrlInput = "";
  let sttModelInput = "";
  let sttLanguageInput = "";
  let sttBusy = false;
  let sttError = "";
  // builtin tool/skill policy local state: checked = DISABLED deployment-wide
  let toolSkillBusy = false;
  let toolSkillError = "";
  let disabledToolChecks: Record<string, boolean> = {};
  let disabledSkillChecks: Record<string, boolean> = {};
  let customDisabledSkills: string[] = [];
  let customSkillInput = "";

  // audit action filter
  let auditAction = "";
  const signupStatusId = "admin-signup-status";
  const tokenStatusId = "admin-token-status";
  const modelStatusId = "admin-model-status";
  const sttStatusId = "admin-stt-status";
  const hexStatusId = "admin-hex-policy-status";
  const toolSkillStatusId = "admin-tool-skill-status";

  // 그룹 관리 moved to the shared 그룹 view (GroupsView) — #/admin/groups
  // redirects there (lib/nav.ts); adminGroups stays loaded for the
  // external-agents panel's visibility picker.
  type AdminTabDef = { id: AdminTab; label: string; icon: string };
  const tabs: AdminTabDef[] = [
    { id: "overview", label: "개요", icon: "activity" },
    { id: "users", label: "사용자", icon: "users" },
    { id: "external-agents", label: "외부 아바타", icon: "globe" },
    { id: "access", label: "가입·접근", icon: "key" },
    { id: "system", label: "시스템", icon: "server" },
    { id: "audit", label: "감사 로그", icon: "list" },
  ];

  const userFilters: { id: typeof $appState.adminUserFilter; label: string; match: (u: AdminUserSummary) => boolean }[] = [
    { id: "all", label: "전체", match: () => true },
    { id: "admins", label: "관리자", match: (u) => u.roles?.includes("admin") },
    { id: "suspended", label: "정지", match: (u) => u.suspended },
    { id: "group", label: "그룹 공개", match: (u) => u.visibility === "group" },
    { id: "sessions", label: "활성 세션", match: (u) => (u.activeSessions || 0) > 0 },
  ];

  const roleDefs = [
    { key: "owner", label: "소유자" },
    { key: "trusted", label: "같은 그룹원" },
    { key: "colleague", label: "일반 동료" },
  ];
  const categoryLabels: Record<string, string> = { read: "조회", execute: "실행", write: "수정·전송", session: "세션" };

  const signupModes = [
    { id: "open" as SignupMode, label: "개방", desc: "누구나 즉시 가입하고 바로 사용할 수 있습니다." },
    { id: "approval" as SignupMode, label: "승인 후 사용", desc: "가입은 가능하지만 관리자가 활성화해야 로그인됩니다. 대기 중인 계정은 사용자 탭에 ‘정지’ 상태로 표시됩니다." },
    { id: "closed" as SignupMode, label: "차단", desc: "신규 가입을 받지 않습니다." },
  ];

  onMount(load);

  // ---- derived ----
  // loadAdminOverview stores the raw GET /api/admin/system response, which is
  // shaped { system: {...} } — unwrap it (the old loadAdminSystem did r.system).
  function unwrapSystem(raw: Record<string, unknown> | null): Record<string, any> {
    if (!raw) return {};
    const inner = (raw as Record<string, any>).system;
    return (inner && typeof inner === "object" ? inner : raw) as Record<string, any>;
  }
  $: sys = unwrapSystem($appState.adminSystem);
  $: filterLabel = (id: string) => userFilters.find((f) => f.id === id)?.label || "전체";
  $: currentUserFilter = userFilters.find((f) => f.id === $appState.adminUserFilter) || userFilters[0];
  $: filteredUsers = (() => {
    const q = $appState.adminUserSearch.trim().toLowerCase();
    return $appState.adminUsers.filter(
      (u) =>
        currentUserFilter.match(u) &&
        (!q || (u.displayName || "").toLowerCase().includes(q) || (u.username || "").toLowerCase().includes(q)),
    );
  })();
  $: auditActions = [...new Set(($appState.audit || []).map((r) => r.action))].sort();
  $: shownAudit = auditAction ? ($appState.audit || []).filter((r) => r.action === auditAction) : $appState.audit || [];
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
    set_model_override: "아바타 모델 지정",
    clear_model_override: "아바타 모델 해제",
    set_stt_override: "STT 설정 변경",
    clear_stt_override: "STT 설정 해제",
    set_model_vision_policy: "모델 비전 정책 변경",
    set_hex_ssh_policy: "hex-ssh 도구 정책 변경",
    set_tool_skill_policy: "도구·스킬 정책 변경",
    set_egress_policy: "외부 통신 차단 정책 적용",
    egress_policy_failed: "외부 통신 차단 정책 적용 실패",
    group_create: "그룹 생성",
    group_delete: "그룹 삭제",
    group_member_add: "그룹원 추가",
    group_member_remove: "그룹원 제거",
    group_member_role: "그룹원 역할 변경",
    group_repo_set: "그룹 지식 저장소 설정",
    group_tool_policy: "그룹 도구 정책 변경",
    group_avatar_sharing: "그룹원 아바타 상호 공개 변경",
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
  $: stats = $appState.adminStats;
  $: savedModelOverride = String(sys.modelOverride || "");
  $: modelValueTrimmed = modelInput.trim();
  $: modelDirty = modelValueTrimmed !== savedModelOverride;
  $: modelCanSave = Boolean(!modelBusy && modelDirty);
  $: modelStatus = modelBusy
    ? "저장 중…"
    : modelError
      ? `저장 실패: ${modelError}`
      : modelDirty
        ? modelValueTrimmed
          ? "저장하지 않은 모델 변경 사항이 있습니다."
          : "저장하면 SDK 기본값으로 되돌립니다."
        : savedModelOverride
          ? "저장됨"
          : "SDK 기본값 사용 중";
  // STT: an admin override WINS over env, so the inputs seed from the effective
  // saved value — env values show pre-filled and stay saveable as an override.
  $: sttOverride = (sys.sttOverride && typeof sys.sttOverride === "object" ? sys.sttOverride : null) as {
    url?: string;
    model?: string | null;
    language?: string | null;
  } | null;
  $: sttEnvUrl = String(sys.sttEnvUrl || "");
  $: sttEnvModel = String(sys.sttEnvModel || "");
  $: sttEnvLanguage = String(sys.sttEnvLanguage || "");
  $: savedSttUrl = String(sttOverride?.url ?? sttEnvUrl ?? "");
  // Empty = inherit. The env model shows only as a PLACEHOLDER: pre-filling it
  // would pin it into the override on the next save.
  $: savedSttModel = String(sttOverride?.model ?? "");
  // Same inherit rule for the language bias; an override saved before the
  // language field existed simply has no key, which reads as "inherit".
  $: savedSttLanguage = String(sttOverride?.language ?? "");
  $: sttUrlTrimmed = sttUrlInput.trim();
  $: sttModelTrimmed = sttModelInput.trim();
  // Lowercased here, not just server-side, so the card shows the value that
  // will actually be stored.
  $: sttLanguageTrimmed = sttLanguageInput.trim().toLowerCase();
  $: sttDirty =
    sttUrlTrimmed !== savedSttUrl || sttModelTrimmed !== savedSttModel || sttLanguageTrimmed !== savedSttLanguage;
  $: sttCanSave = Boolean(!sttBusy && sttDirty);
  $: sttStatus = sttBusy
    ? "저장 중…"
    : sttError
      ? `저장 실패: ${sttError}`
      : sttDirty
        ? !sttUrlTrimmed && sttOverride
          ? sttEnvUrl
            ? "저장하면 환경 변수(STT_URL) 값으로 되돌립니다."
            : "저장하면 STT 설정을 해제합니다. 마이크 버튼이 숨겨집니다."
          : "저장하지 않은 변경 사항이 있습니다."
        : sttOverride
          ? "관리자 설정 적용 중"
          : sttEnvUrl
            ? "환경 변수(STT_URL) 값을 사용 중입니다."
            : "미설정 — 마이크 버튼이 숨겨져 있습니다.";
  $: claudeTokenTrimmed = claudeToken.trim();
  $: tokenCanSave = Boolean(!subBusy && claudeTokenTrimmed);
  $: tokenStatus = subBusy
    ? "저장 중…"
    : tokenError
      ? `저장 실패: ${tokenError}`
      : claudeTokenTrimmed
        ? "저장할 준비가 됐습니다."
        : sys.subscriptionConnected
          ? "새 토큰을 붙여넣으면 기존 토큰을 교체합니다."
          : "토큰을 붙여넣어 주세요.";
  $: signupMode = (sys.signupMode || "open") as SignupMode;
  $: signupModeLabel = signupModes.find((m) => m.id === signupMode)?.label || "개방";
  $: signupStatus = signupBusy ? "회원가입 정책을 저장 중입니다." : signupError ? `저장 실패: ${signupError}` : `현재 정책: ${signupModeLabel}`;
  $: hexTools = Array.isArray(sys.hexSshTools) ? sys.hexSshTools : [];
  $: hexSavedKey = hexPolicyKeyFromSaved(sys.hexSshToolPolicy || {}, hexTools);
  $: hexCurrentKey = hexPolicyKeyFromMatrix(hexPolicy, hexTools);
  $: hexDirty = Boolean(hexTools.length && hexCurrentKey !== hexSavedKey);
  $: hexCanSave = Boolean(!hexBusy && hexDirty);
  $: hexStatus = hexBusy
    ? "정책을 저장 중입니다."
    : hexError
      ? `저장 실패: ${hexError}`
      : hexDirty
        ? "저장하지 않은 정책 변경 사항이 있습니다."
        : hexTools.length
          ? "저장된 정책과 같습니다."
          : "설정할 SSH 도구가 없습니다.";
  $: togglableTools = Array.isArray(sys.togglableBuiltinTools) ? sys.togglableBuiltinTools : [];
  $: discoveredSkills = sys.skillDiscovery && Array.isArray(sys.skillDiscovery.skills) ? sys.skillDiscovery.skills : [];
  $: savedToolSkillPolicy = sys.toolSkillPolicy || {};
  $: toolSkillSavedKey = toolSkillPolicyKey(savedToolSkillPolicy.disabledTools || [], savedToolSkillPolicy.disabledSkills || []);
  $: localDisabledTools = disabledToolNamesFrom(togglableTools, disabledToolChecks);
  $: localDisabledSkills = disabledSkillNamesFrom(disabledSkillChecks, customDisabledSkills);
  $: toolSkillCurrentKey = toolSkillPolicyKey(localDisabledTools, localDisabledSkills);
  $: toolSkillDirty = toolSkillCurrentKey !== toolSkillSavedKey;
  $: toolSkillCanSave = Boolean(!toolSkillBusy && toolSkillDirty);
  $: toolSkillStatus = toolSkillBusy
    ? "정책을 저장 중입니다."
    : toolSkillError
      ? `저장 실패: ${toolSkillError}`
      : toolSkillDirty
        ? "저장하지 않은 정책 변경 사항이 있습니다."
        : "저장된 정책과 같습니다.";

  // Vision has a draft but no explicit dirty flag; derive one so a manual refresh
  // can preserve unsaved vision-policy edits (see load()).
  $: visionDirty = MODEL_TIERS.some((tier) => {
    const saved = (unwrapSystem($appState.adminSystem).modelVisionPolicy || {}) as Record<string, boolean>;
    const savedVal = tier.id in saved ? (saved[tier.id] ? "on" : "off") : "default";
    return (visionPolicyDraft[tier.id] ?? "default") !== savedVal;
  });

  // overview stat cards
  $: statCards = [
    { label: "전체 사용자", value: stats?.users, sub: stats?.suspended ? `정지 ${stats.suspended}명 포함` : "", target: "users", filter: "all" },
    { label: "관리자", value: stats?.admins, sub: "", target: "users", filter: "admins" },
    { label: "그룹 공개 아바타", value: stats?.groupAvatars, sub: "", target: "users", filter: "group" },
    { label: "대화", value: stats?.conversations, sub: "", target: "", filter: "all" },
    { label: "메시지", value: stats?.messages, sub: "", target: "", filter: "all" },
    { label: "활성 예약 작업", value: stats?.activeRoutines, sub: "", target: "", filter: "all" },
    { label: "미응답 질문", value: stats?.openRequests, sub: "", target: "", filter: "all" },
    { label: "활성 세션", value: stats?.activeSessions, sub: "", target: "users", filter: "sessions" },
    { label: "그룹", value: stats?.groups, sub: "", target: "groups", filter: "all" },
  ] as { label: string; value: number | undefined; sub: string; target: string; filter: typeof $appState.adminUserFilter }[];

  async function load() {
    if (loadBusy) return;
    loadBusy = true;
    loading = true;
    error = "";
    try {
      await Promise.all([loadAdminOverview(), loadAdminGroups()]);
      // Preserve unsaved policy edits across a manual 새로고침 (the header button
      // calls load() on every tab): only re-seed a panel from server state when
      // it has NO pending edits — otherwise the refresh silently discards them,
      // which contradicts the "저장하지 않은 변경 사항" banner shown right there.
      // The guards apply only AFTER the first seed (panelsSeeded) — see the
      // flag's declaration for why they misfire on the initial load.
      if (!panelsSeeded || !hexDirty) syncHexPolicyFromSys();
      if (!panelsSeeded || !toolSkillDirty) syncToolSkillFromSys();
      if (!panelsSeeded || !visionDirty) syncVisionPolicyFromSys();
      if (!panelsSeeded || !modelDirty) modelInput = String(unwrapSystem($appState.adminSystem).modelOverride || "");
      if (!panelsSeeded || !sttDirty) syncSttFromSys();
      panelsSeeded = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
      loadBusy = false;
    }
  }

  function setTab(id: AdminTab) {
    updateState((state) => (state.adminTab = id));
  }

  function focusAdminTab(id: AdminTab): void {
    requestAnimationFrame(() => document.getElementById(`admin-tab-${id}`)?.focus());
  }

  function onAdminTabKeydown(event: KeyboardEvent, currentId: AdminTab): void {
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

  function goOverviewTarget(target: string, filter: typeof $appState.adminUserFilter) {
    if (!target) return;
    if (target === "groups") {
      // Group management lives on the shared 그룹 view now.
      goView("groups");
      return;
    }
    updateState((state) => {
      state.adminTab = target as AdminTab;
      if (target === "users") state.adminUserFilter = filter;
    });
  }

  function setUserFilter(id: typeof $appState.adminUserFilter) {
    updateState((state) => (state.adminUserFilter = id));
  }

  function focusUserFilter(id: typeof $appState.adminUserFilter): void {
    requestAnimationFrame(() => document.getElementById(`admin-user-filter-${id}`)?.focus());
  }

  function onUserFilterKeydown(event: KeyboardEvent, currentId: typeof $appState.adminUserFilter): void {
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

  // Reactive per-filter counts: a template call reading $appState.adminUsers only
  // in a helper body would freeze the chip counts at first render (userFilters
  // never changes identity). Reading this map in the template tracks adminUsers,
  // so counts update after suspend/delete/role change.
  $: userFilterCounts = new Map(
    userFilters.map((f) => [f.id, $appState.adminUsers.filter(f.match).length]),
  );

  // ---- access ----
  async function saveSignupMode(mode: SignupMode) {
    if (signupBusy || signupMode === mode) return;
    signupBusy = true;
    signupError = "";
    try {
      await api("/api/admin/signup-mode", { method: "PUT", body: JSON.stringify({ mode }) });
    } catch (err) {
      signupBusy = false;
      signupError = (err as Error).message;
      notify(`저장 실패: ${signupError}`);
      return;
    }
    try {
      await loadAdminOverview();
      if ($appState.bootstrap) replaceState({ bootstrap: { ...$appState.bootstrap, signupMode: mode } });
      notify("회원가입 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`회원가입 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      signupBusy = false;
    }
  }

  // ---- system: per-tier vision policy ----
  // Draft: tier id → "default" (inherit MODEL_VISION) | "on" | "off".
  let visionPolicyDraft: Record<string, "default" | "on" | "off"> = {};
  let visionBusy = false;
  $: visionDefaultLabel = sys.visionDefault === false ? "미지원" : "지원";
  // Concrete model id each tier maps to (ANTHROPIC_DEFAULT_<TIER>_MODEL), from
  // the bootstrap payload the composer picker already uses. Null = unmapped
  // (the SDK resolves the alias to the account default).
  $: tierModelById = new Map(
    ($appState.bootstrap?.modelSelection?.tiers ?? []).map((tier) => [tier.id, tier.model]),
  );

  function syncVisionPolicyFromSys() {
    const saved = (unwrapSystem($appState.adminSystem).modelVisionPolicy || {}) as Record<string, boolean>;
    const draft: Record<string, "default" | "on" | "off"> = {};
    for (const tier of MODEL_TIERS) {
      draft[tier.id] = tier.id in saved ? (saved[tier.id] ? "on" : "off") : "default";
    }
    visionPolicyDraft = draft;
  }

  async function saveVisionPolicy() {
    if (visionBusy) return;
    const policy: Record<string, boolean> = {};
    for (const tier of MODEL_TIERS) {
      const pick = visionPolicyDraft[tier.id];
      if (pick === "on") policy[tier.id] = true;
      else if (pick === "off") policy[tier.id] = false;
    }
    visionBusy = true;
    try {
      await api("/api/admin/model-vision-policy", { method: "PUT", body: JSON.stringify({ policy }) });
      await loadAdminOverview();
      syncVisionPolicyFromSys();
      notify("모델별 이미지 입력 설정을 저장했습니다.", "ok");
    } catch (err) {
      notify(`저장 실패: ${(err as Error).message}`);
    } finally {
      visionBusy = false;
    }
  }

  // ---- system: model ----
  async function saveModel() {
    if (modelBusy || !modelDirty) return;
    const value = modelValueTrimmed;
    const successMessage = value ? "모델을 저장했습니다." : "모델 지정을 해제했습니다. SDK 기본값을 사용합니다.";
    modelBusy = true;
    modelError = "";
    try {
      if (value) await api("/api/admin/model", { method: "PUT", body: JSON.stringify({ model: value }) });
      else await api("/api/admin/model", { method: "DELETE" });
    } catch (err) {
      modelBusy = false;
      modelError = (err as Error).message;
      notify(`저장 실패: ${modelError}`);
      return;
    }
    try {
      await loadAdminOverview();
      modelInput = String(unwrapSystem($appState.adminSystem).modelOverride || "");
      notify(successMessage, "ok");
    } catch (err) {
      notify(`모델 설정은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      modelBusy = false;
    }
  }

  // ---- system: speech-to-text endpoint ----
  function syncSttFromSys() {
    const cur = unwrapSystem($appState.adminSystem);
    const override = cur.sttOverride && typeof cur.sttOverride === "object" ? cur.sttOverride : null;
    sttUrlInput = String(override?.url ?? cur.sttEnvUrl ?? "");
    sttModelInput = String(override?.model ?? "");
    sttLanguageInput = String(override?.language ?? "");
  }

  async function saveStt() {
    if (sttBusy || !sttDirty) return;
    const url = sttUrlTrimmed;
    const model = sttModelTrimmed;
    const language = sttLanguageTrimmed;
    // Clearing the url with no override to delete leaves nothing to send — the
    // env value, if any, isn't ours to remove.
    if (!url && !sttOverride) {
      notify("서버 주소를 입력해 주세요.", "warn");
      return;
    }
    const successMessage = url
      ? "STT 설정을 저장했습니다."
      : sttEnvUrl
        ? "STT 설정을 해제했습니다. 환경 변수 값을 사용합니다."
        : "STT 설정을 해제했습니다.";
    sttBusy = true;
    sttError = "";
    try {
      if (url)
        await api("/api/admin/stt", {
          method: "PUT",
          body: JSON.stringify({ url, ...(model ? { model } : {}), ...(language ? { language } : {}) }),
        });
      else await api("/api/admin/stt", { method: "DELETE" });
    } catch (err) {
      sttBusy = false;
      sttError = (err as Error).message;
      notify(`저장 실패: ${sttError}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncSttFromSys();
      notify(successMessage, "ok");
    } catch (err) {
      notify(`STT 설정은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      sttBusy = false;
    }
  }

  // ---- system: subscription ----
  async function saveToken() {
    if (subBusy) return;
    const token = claudeTokenTrimmed;
    if (!token) {
      tokenError = "토큰을 붙여넣어 주세요.";
      notify("토큰을 붙여넣어 주세요.", "warn");
      return;
    }
    subBusy = true;
    tokenError = "";
    try {
      await api("/api/admin/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
    } catch (err) {
      subBusy = false;
      tokenError = (err as Error).message;
      notify(`저장 실패: ${tokenError}`);
      return;
    }
    claudeToken = "";
    try {
      await loadAdminOverview();
      notify("구독 토큰을 저장했습니다.", "ok");
    } catch (err) {
      notify(`구독 토큰은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      subBusy = false;
    }
  }

  async function disconnectToken() {
    if (subBusy) return;
    if (!(await confirmAction("저장된 구독 토큰을 삭제할까요?"))) return;
    subBusy = true;
    tokenError = "";
    try {
      await api("/api/admin/claude-token", { method: "DELETE" });
    } catch (err) {
      subBusy = false;
      tokenError = (err as Error).message;
      notify(`해제 실패: ${tokenError}`);
      return;
    }
    try {
      await loadAdminOverview();
      notify("구독 토큰 연결을 해제했습니다.", "ok");
    } catch (err) {
      notify(`구독 토큰은 삭제했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      subBusy = false;
    }
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

  function hexPolicyKeyFromMatrix(matrix: Record<string, Record<string, boolean>>, tools: any[]): string {
    const names = hexToolNames(tools);
    return roleDefs
      .map((role) => `${role.key}:${names.filter((name) => Boolean(matrix[role.key]?.[name])).join(",")}`)
      .join("|");
  }

  function syncHexPolicyFromSys() {
    const cur = unwrapSystem($appState.adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const policy = cur.hexSshToolPolicy || {};
    const next: Record<string, Record<string, boolean>> = {};
    for (const role of roleDefs) {
      next[role.key] = {};
      for (const tool of tools) {
        next[role.key][tool.name] = Array.isArray(policy[role.key]) && policy[role.key].includes(tool.name);
      }
    }
    hexPolicy = next;
  }

  async function saveHexPolicy() {
    if (!hexCanSave) return;
    const cur = unwrapSystem($appState.adminSystem);
    const tools = Array.isArray(cur.hexSshTools) ? cur.hexSshTools : [];
    const nextPolicy: Record<string, string[]> = {};
    for (const role of roleDefs) {
      nextPolicy[role.key] = tools.filter((t: any) => hexPolicy[role.key]?.[t.name]).map((t: any) => t.name);
    }
    hexBusy = true;
    hexError = "";
    try {
      await api("/api/admin/hex-ssh-policy", { method: "PUT", body: JSON.stringify({ policy: nextPolicy }) });
    } catch (err) {
      hexBusy = false;
      hexError = (err as Error).message;
      notify(`저장 실패: ${hexError}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncHexPolicyFromSys();
      notify("SSH 도구 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`SSH 도구 정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      hexBusy = false;
    }
  }

  // ---- system: builtin tool/skill policy ----
  // Hand-mirrors SKILL_NAME_RE in src/server/toolSkillPolicy.ts (no shared
  // module across the client-server boundary) — update in lockstep.
  const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

  function toolSkillPolicyKey(tools: string[], skills: string[]): string {
    return `${[...tools].sort().join(",")}|${[...skills].sort().join(",")}`;
  }

  function disabledToolNamesFrom(catalog: any[], checks: Record<string, boolean>): string[] {
    return catalog
      .filter((entry) => checks[entry.id])
      .flatMap((entry) => (Array.isArray(entry.names) ? entry.names.map(String) : []));
  }

  function disabledSkillNamesFrom(checks: Record<string, boolean>, custom: string[]): string[] {
    const out = Object.keys(checks).filter((name) => checks[name]);
    for (const name of custom) {
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  function syncToolSkillFromSys() {
    const cur = unwrapSystem($appState.adminSystem);
    const catalog = Array.isArray(cur.togglableBuiltinTools) ? cur.togglableBuiltinTools : [];
    const saved = cur.toolSkillPolicy || {};
    const savedTools: string[] = Array.isArray(saved.disabledTools) ? saved.disabledTools.map(String) : [];
    const savedSkills: string[] = Array.isArray(saved.disabledSkills) ? saved.disabledSkills.map(String) : [];
    const discovered = cur.skillDiscovery && Array.isArray(cur.skillDiscovery.skills) ? cur.skillDiscovery.skills : [];
    const toolChecks: Record<string, boolean> = {};
    for (const entry of catalog) {
      toolChecks[entry.id] = Array.isArray(entry.names) && entry.names.some((name: string) => savedTools.includes(name));
    }
    const skillChecks: Record<string, boolean> = {};
    const discoveredNames = new Set<string>();
    for (const skill of discovered) {
      const name = String(skill?.name || "");
      if (!name) continue;
      discoveredNames.add(name);
      skillChecks[name] = savedSkills.includes(name);
    }
    disabledToolChecks = toolChecks;
    disabledSkillChecks = skillChecks;
    // Saved names the discovery list doesn't cover (typed by an admin, or from
    // an older CLI) stay visible/removable so the dirty-compare stays honest.
    customDisabledSkills = savedSkills.filter((name) => !discoveredNames.has(name));
  }

  function addCustomDisabledSkill() {
    const name = customSkillInput.trim();
    if (!name) return;
    if (!SKILL_NAME_RE.test(name)) {
      toolSkillError = "스킬 이름 형식이 올바르지 않습니다. (영숫자로 시작, 최대 128자)";
      return;
    }
    toolSkillError = "";
    if (name in disabledSkillChecks) {
      disabledSkillChecks = { ...disabledSkillChecks, [name]: true };
    } else if (!customDisabledSkills.includes(name)) {
      customDisabledSkills = [...customDisabledSkills, name];
    }
    customSkillInput = "";
  }

  function removeCustomDisabledSkill(name: string) {
    customDisabledSkills = customDisabledSkills.filter((n) => n !== name);
  }

  async function saveToolSkillPolicy() {
    if (!toolSkillCanSave) return;
    toolSkillBusy = true;
    toolSkillError = "";
    try {
      await api("/api/admin/tool-skill-policy", {
        method: "PUT",
        body: JSON.stringify({ policy: { disabledTools: localDisabledTools, disabledSkills: localDisabledSkills } }),
      });
    } catch (err) {
      toolSkillBusy = false;
      toolSkillError = (err as Error).message;
      notify(`저장 실패: ${toolSkillError}`);
      return;
    }
    try {
      await loadAdminOverview();
      syncToolSkillFromSys();
      notify("내장 도구·스킬 정책을 저장했습니다.", "ok");
    } catch (err) {
      notify(`정책은 저장했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      toolSkillBusy = false;
    }
  }

  async function reloadUsers() {
    await loadAdminOverview();
  }
  async function reloadGroups() {
    await loadAdminGroups();
  }
</script>

<header class="view-header">
  <div class="title">
    <h1>관리자</h1>
    <p>사용자·외부 아바타·접근·시스템을 관리하세요</p>
  </div>
  {#if $appState.adminTab !== "external-agents"}
    <button class="ghost-sm" type="button" disabled={loadBusy} on:click={load}>{loadBusy ? "새로고침 중…" : "새로고침"}</button>
  {/if}
</header>

<div class="view-body scroll-thin">
  {#if loading}
    <div class="muted pad" role="status">불러오는 중…</div>
  {:else if error}
    <div class="warn-box" role="alert">
      관리자 정보를 불러오지 못했습니다: {error}
      <button class="linkish" type="button" disabled={loadBusy} on:click={load}>다시 시도</button>
    </div>
  {:else}
    <div class="settings-tabs admin-primary-tabs" role="tablist" aria-label="관리자 분류">
      {#each tabs as tab}
        <button
          id={`admin-tab-${tab.id}`}
          class="settings-tab"
          type="button"
          class:active={$appState.adminTab === tab.id}
          role="tab"
          aria-selected={$appState.adminTab === tab.id}
          aria-controls="admin-panel"
          tabindex={$appState.adminTab === tab.id ? 0 : -1}
          on:click={() => setTab(tab.id)}
          on:keydown={(event) => onAdminTabKeydown(event, tab.id)}
        >
          <Icon name={tab.icon} />
          <span>{tab.label}</span>
        </button>
      {/each}
    </div>

    <div class="admin-panel" role="tabpanel" id="admin-panel" aria-labelledby={`admin-tab-${$appState.adminTab}`}>
      <AdminExternalAgentsPanel
        active={$appState.adminTab === "external-agents"}
        groups={$appState.adminGroups}
        {reloadGroups}
      />
      <AdminEgressPanel active={$appState.adminTab === "access"} />
      {#if $appState.adminTab === "overview"}
        <div class="admin-list">
          <section class="settings-card">
            <h3>현황</h3>
            <p class="muted">이 인스턴스의 전체 사용 현황입니다.</p>
            <div class="stat-grid">
              {#each statCards as c}
                {#if c.target}
                  <button
                    class="stat-card stat-clickable"
                    type="button"
                    aria-label={`${c.label} ${c.target === "groups" ? "그룹 관리" : "사용자 관리"}로 이동`}
                    on:click={() => goOverviewTarget(c.target, c.filter)}
                  >
                    <div class="stat-value">{c.value ?? 0}</div>
                    <div class="stat-label">{c.label}</div>
                    {#if c.sub}<div class="stat-sub muted">{c.sub}</div>{/if}
                    <div class="stat-link muted">{c.target === "groups" ? "그룹 관리" : "사용자 관리"}</div>
                  </button>
                {:else}
                  <div class="stat-card">
                    <div class="stat-value">{c.value ?? 0}</div>
                    <div class="stat-label">{c.label}</div>
                    {#if c.sub}<div class="stat-sub muted">{c.sub}</div>{/if}
                  </div>
                {/if}
              {/each}
            </div>
          </section>
        </div>
      {:else if $appState.adminTab === "users"}
        <div class="admin-users">
          <div class="admin-users-head">
            <input
              type="search"
              class="admin-search"
              placeholder="이름 또는 아이디로 검색"
              aria-label="사용자 검색"
              value={$appState.adminUserSearch}
              on:input={(e) => updateState((s) => (s.adminUserSearch = e.currentTarget.value))}
            />
            <span class="muted nowrap">표시 {filteredUsers.length}명 / 전체 {$appState.adminUsers.length}명</span>
          </div>
          <div class="admin-filter seg-control" role="radiogroup" aria-label="사용자 필터">
            {#each userFilters as f}
              <button
                id={`admin-user-filter-${f.id}`}
                class="seg-btn"
                class:active={$appState.adminUserFilter === f.id}
                type="button"
                role="radio"
                aria-checked={$appState.adminUserFilter === f.id}
                tabindex={$appState.adminUserFilter === f.id ? 0 : -1}
                on:click={() => setUserFilter(f.id)}
                on:keydown={(event) => onUserFilterKeydown(event, f.id)}
              >{f.label} {userFilterCounts.get(f.id) ?? 0}</button>
            {/each}
          </div>
          <div class="admin-list">
            {#if !filteredUsers.length}
              <div class="muted pad">
                {#if $appState.adminUserSearch.trim()}
                  "{$appState.adminUserSearch.trim()}"에 맞는 {$appState.adminUserFilter === "all" ? "사용자" : `${filterLabel($appState.adminUserFilter)} 사용자`}가 없습니다.
                  <button class="linkish small" type="button" on:click={() => updateState((s) => (s.adminUserSearch = ""))}>검색어 지우기</button>
                  {#if $appState.adminUserFilter !== "all"}
                    <button class="linkish small" type="button" on:click={() => setUserFilter("all")}>전체 사용자 보기</button>
                  {/if}
                {:else if $appState.adminUserFilter !== "all"}
                  {filterLabel($appState.adminUserFilter)} 사용자가 없습니다.
                  <button class="linkish small" type="button" on:click={() => setUserFilter("all")}>전체 사용자 보기</button>
                {:else}
                  사용자가 없습니다.
                {/if}
              </div>
            {:else}
              {#each filteredUsers as user (user.id)}
                <AdminUserRow {user} reload={reloadUsers} />
              {/each}
            {/if}
          </div>
        </div>
      {:else if $appState.adminTab === "access"}
        <div class="admin-list">
          <section class="settings-card">
            <div class="panel-section-head">
              <div>
                <h3>회원가입 정책</h3>
                <p class="muted">새 사용자가 스스로 가입하는 방식을 정합니다. 첫 관리자 계정은 정책과 무관하게 항상 허용됩니다.</p>
              </div>
            </div>
            <div class="radio-cards" role="radiogroup" aria-label="회원가입 정책" aria-describedby={signupStatusId}>
              {#each signupModes as m}
                <label class="radio-card" for={`sm-${m.id}`}>
                  <input
                    type="radio"
                    name="signup-mode"
                    id={`sm-${m.id}`}
                    value={m.id}
                    checked={signupMode === m.id}
                    disabled={signupBusy}
                    on:change={() => saveSignupMode(m.id)}
                  />
                  <div class="radio-card-body">
                    <strong>{m.label}</strong>
                    <div class="muted">{m.desc}</div>
                  </div>
                </label>
              {/each}
            </div>
            <div class="settings-save-row compact">
              <span id={signupStatusId} class="settings-save-status" class:pending={signupBusy} class:invalid={Boolean(signupError)} role="status" aria-live="polite">{signupStatus}</span>
            </div>
          </section>
        </div>
      {:else if $appState.adminTab === "system"}
        {#if !$appState.adminSystem}
          <div class="warn-box" role="alert">
            시스템 정보를 불러올 수 없습니다.
            <button class="linkish" type="button" disabled={loadBusy} on:click={load}>다시 시도</button>
          </div>
        {:else}
          <div class="admin-list">
            <!-- system info -->
            <div class="settings-card sys-card">
              <h3>시스템 정보</h3>
              <div class="sys-grid">
                <div class="sys-row">
                  <span class="sys-key muted">런타임</span>
                  <span class="sys-val"><span class="tag mono">{sys.agentRuntime === "claude" ? "Claude Agent SDK" : "로컬 스텁"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">설정된 모델</span>
                  <span class="sys-val">
                    {#if sys.configuredModel}<span class="tag mono">{sys.configuredModel}</span>{:else}<span class="muted">미설정 (SDK 기본값)</span>{/if}
                  </span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">실제 사용 모델</span>
                  <span class="sys-val">
                    {#if sys.observedModel}<span class="tag mono accent">{sys.observedModel}</span>{:else}<span class="muted">아직 확인되지 않음 (첫 대화 후 표시)</span>{/if}
                  </span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">인증 방식</span>
                  <span class="sys-val"><span class="tag">{sys.authMode === "api_key" ? "API 키" : "구독 로그인"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">읽기 전용 도구</span>
                  <span class="sys-val"><span class="muted">{(sys.readOnlyTools || []).join(", ") || "없음"}</span></span>
                </div>
                <div class="sys-row">
                  <span class="sys-key muted">Confluence</span>
                  <span class="sys-val">
                    {#if sys.confluenceConfigured}<span class="tag">host 설정됨</span>{:else}<span class="muted">CONFLUENCE_URL 미설정</span>{/if}
                  </span>
                </div>
              </div>
            </div>

            <!-- subscription -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>구독 로그인</h3>
                  <p class="muted">Claude 구독으로 아바타를 구동합니다. ① 내 PC에서 claude setup-token 실행 → ② 출력된 sk-ant-oat… 토큰을 아래에 붙여넣고 저장하세요. 토큰은 암호화되어 저장되며 다시 표시되지 않습니다.</p>
                </div>
              </div>
              <div class="sys-grid">
                <div class="sys-row">
                  <span class="sys-key muted">구독 연결</span>
                  <span class="sys-val">
                    <span class={sys.subscriptionConnected ? "tag accent" : "muted"}>{sys.subscriptionConnected ? "● 연결됨" : "○ 미연결"}</span>
                  </span>
                </div>
              </div>
              {#if sys.apiKeyOverride}
                <p class="muted">.env의 ANTHROPIC_API_KEY가 설정되어 있어 API 키가 구독 토큰보다 우선합니다. 구독 토큰을 사용하려면 API 키를 비우세요.</p>
              {/if}
              {#if sys.subscriptionConnected}
                <div class="ar-actions">
                  <button class="ghost-sm danger" type="button" disabled={subBusy} on:click={disconnectToken}>연결 해제</button>
                </div>
              {/if}
              <form class="settings-form" on:submit|preventDefault={saveToken}>
                <label class="field">
                  <span>{sys.subscriptionConnected ? "토큰 교체" : "Claude 구독 토큰"}</span>
                  <RevealableInput
                    bind:value={claudeToken}
                    name="token"
                    placeholder="sk-ant-oat01-…"
                    ariaLabel={sys.subscriptionConnected ? "Claude 구독 토큰 교체" : "Claude 구독 토큰"}
                    ariaDescribedby={tokenStatusId}
                    ariaInvalid={Boolean(tokenError)}
                    revealLabel="토큰"
                    disabled={subBusy}
                    onInput={() => (tokenError = "")}
                  />
                </label>
                <div class="settings-save-row">
                  <span id={tokenStatusId} class="settings-save-status" class:dirty={Boolean(claudeTokenTrimmed && !subBusy && !tokenError)} class:pending={subBusy} class:invalid={Boolean(tokenError)} role="status" aria-live="polite">{tokenStatus}</span>
                  <button class="primary" type="submit" disabled={!tokenCanSave}>{subBusy ? "저장 중…" : sys.subscriptionConnected ? "교체 저장" : "저장"}</button>
                </div>
              </form>
            </section>

            <!-- model override -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>아바타 모델</h3>
                  <p class="muted">아바타 대화에 사용할 모델을 지정합니다. 비워 두면 SDK 기본값을 사용합니다. 예: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5-20251001.</p>
                </div>
              </div>
              {#if sys.modelEnvLocked}
                <p class="muted">.env의 ANTHROPIC_MODEL이 설정되어 있어 환경 변수가 우선합니다. 아래 설정은 환경 변수가 없을 때만 적용됩니다.</p>
              {/if}
              <form class="settings-form" on:submit|preventDefault={saveModel}>
                <label class="field">
                  <span>모델 이름</span>
                  <input
                    name="model"
                    bind:value={modelInput}
                    placeholder="claude-opus-4-8 (비우면 기본값)"
                    autocomplete="off"
                    aria-describedby={modelStatusId}
                    aria-invalid={modelError ? "true" : undefined}
                    disabled={modelBusy}
                    on:input={() => (modelError = "")}
                  />
                </label>
                <div class="settings-save-row">
                  <span id={modelStatusId} class="settings-save-status" class:dirty={modelDirty && !modelBusy && !modelError} class:pending={modelBusy} class:invalid={Boolean(modelError)} role="status" aria-live="polite">{modelStatus}</span>
                  <button class="primary" type="submit" disabled={!modelCanSave}>{modelBusy ? "저장 중…" : modelValueTrimmed ? "모델 저장" : "기본값 사용"}</button>
                </div>
              </form>
            </section>

            <!-- speech-to-text endpoint -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>음성 인식 (STT)</h3>
                  <p class="muted">채팅 입력창 마이크 버튼이 사용할 OpenAI 호환 음성 인식 서버입니다. 저장하면 환경 변수(STT_URL)보다 우선 적용됩니다.</p>
                </div>
              </div>
              <form class="settings-form" on:submit|preventDefault={saveStt}>
                <label class="field">
                  <span>서버 주소</span>
                  <!-- aria-label disambiguates from the 아바타 모델 card's own
                       fields; it keeps the visible label as a prefix (WCAG 2.5.3). -->
                  <input
                    name="stt-url"
                    bind:value={sttUrlInput}
                    placeholder="http://127.0.0.1:8000/v1"
                    autocomplete="off"
                    aria-label="STT 서버 주소"
                    aria-describedby={sttStatusId}
                    aria-invalid={sttError ? "true" : undefined}
                    disabled={sttBusy}
                    on:input={() => (sttError = "")}
                  />
                </label>
                <label class="field">
                  <span>모델 이름</span>
                  <input
                    name="stt-model"
                    bind:value={sttModelInput}
                    placeholder={sttEnvModel}
                    autocomplete="off"
                    aria-label="STT 모델 이름"
                    aria-describedby={sttStatusId}
                    disabled={sttBusy}
                    on:input={() => (sttError = "")}
                  />
                  <span class="field-hint">비워 두면 기본 모델을 사용합니다.</span>
                </label>
                <label class="field">
                  <span>언어</span>
                  <input
                    name="stt-language"
                    bind:value={sttLanguageInput}
                    placeholder={sttEnvLanguage}
                    autocomplete="off"
                    aria-label="STT 언어"
                    aria-describedby={sttStatusId}
                    disabled={sttBusy}
                    on:input={() => (sttError = "")}
                  />
                  <span class="field-hint">전사 언어 바이어스 (ISO 코드, 예: ko). 비워 두면 기본값, auto는 자동 감지.</span>
                </label>
                <div class="settings-save-row">
                  <span id={sttStatusId} class="settings-save-status" class:dirty={sttDirty && !sttBusy && !sttError} class:pending={sttBusy} class:invalid={Boolean(sttError)} role="status" aria-live="polite">{sttStatus}</span>
                  <button class="primary" type="submit" disabled={!sttCanSave}>{sttBusy ? "저장 중…" : sttUrlTrimmed ? "STT 저장" : "설정 해제"}</button>
                </div>
              </form>
              <p class="muted">변경 사항은 각 사용자가 페이지를 새로 고친 뒤부터 적용됩니다.</p>
            </section>

            <!-- per-tier vision (image input) policy -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>모델별 이미지 입력(비전)</h3>
                  <p class="muted">
                    모델 티어별 이미지 입력 지원 여부를 지정합니다. "기본값"은 배포 환경설정(MODEL_VISION, 현재 {visionDefaultLabel})을 따릅니다.
                    미지원으로 설정된 모델을 쓰는 대화에서는 이미지 첨부가 차단되고, 아바타의 이미지/PDF 파일 읽기가 거부되며, 아바타에게도 그 사실이 안내됩니다.
                  </p>
                </div>
              </div>
              <form class="settings-form" on:submit|preventDefault={saveVisionPolicy}>
                {#each MODEL_TIERS as tier (tier.id)}
                  <label class="field">
                    <span>
                      {tier.label}
                      {#if tierModelById.get(tier.id)}
                        <span class="muted mono">{tierModelById.get(tier.id)}</span>
                      {:else}
                        <span class="muted">(매핑 없음 — ANTHROPIC_DEFAULT_{tier.id.toUpperCase()}_MODEL 미설정, SDK 기본값 사용)</span>
                      {/if}
                    </span>
                    <select bind:value={visionPolicyDraft[tier.id]} disabled={visionBusy} aria-label={`${tier.label} 이미지 입력 지원`}>
                      <option value="default">기본값 ({visionDefaultLabel})</option>
                      <option value="on">지원</option>
                      <option value="off">미지원</option>
                    </select>
                  </label>
                {/each}
                <div class="settings-save-row">
                  <button class="primary" type="submit" disabled={visionBusy}>{visionBusy ? "저장 중…" : "저장"}</button>
                </div>
              </form>
            </section>

            <!-- hex-ssh policy -->
            {#if Array.isArray(sys.hexSshTools) && sys.hexSshTools.length}
              <section class="settings-card">
                <div class="panel-section-head">
                  <div>
                    <h3>SSH 도구 정책</h3>
                    <p class="muted">역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다.</p>
                  </div>
                </div>
                <form class="hex-policy-form" on:submit|preventDefault={saveHexPolicy}>
                  <div class="hex-policy-grid" role="group" aria-label="SSH 도구 역할별 정책" aria-describedby={hexStatusId}>
                    <div class="hex-policy-head muted">도구</div>
                    {#each roleDefs as role}
                      <div class="hex-policy-head">{role.label}</div>
                    {/each}
                    {#each sys.hexSshTools as tool}
                      <div class="hex-policy-tool">
                        <strong>{tool.label || tool.name}</strong>
                        <span class="muted mono">{tool.name}</span>
                        <span class="tag {tool.category === 'read' ? 'read' : 'write'}">{categoryLabels[tool.category] || tool.category}</span>
                      </div>
                      {#each roleDefs as role}
                        <label class="hex-policy-check">
                          <input type="checkbox" bind:checked={hexPolicy[role.key][tool.name]} aria-label={`${role.label} ${tool.label || tool.name}`} aria-describedby={hexStatusId} disabled={hexBusy} on:change={() => (hexError = "")} />
                        </label>
                      {/each}
                    {/each}
                  </div>
                  <div class="settings-save-row">
                    <span id={hexStatusId} class="settings-save-status" class:dirty={hexDirty && !hexBusy && !hexError} class:pending={hexBusy} class:invalid={Boolean(hexError)} role="status" aria-live="polite">{hexStatus}</span>
                    <button class="primary" type="submit" disabled={!hexCanSave}>{hexBusy ? "저장 중…" : "정책 저장"}</button>
                  </div>
                </form>
              </section>
            {:else}
              <section class="settings-card">
                <div class="panel-section-head">
                  <div>
                    <h3>SSH 도구 정책</h3>
                    <p class="muted">역할별로 hex-ssh MCP 도구 노출과 실행을 제한합니다.</p>
                  </div>
                </div>
                <div class="empty-note">현재 설정할 SSH 도구가 없습니다. hex-ssh 도구 목록이 서버에서 제공되면 역할별 정책 표가 여기에 표시됩니다.</div>
              </section>
            {/if}

            <!-- builtin tool/skill policy -->
            <section class="settings-card">
              <div class="panel-section-head">
                <div>
                  <h3>내장 도구·스킬 정책</h3>
                  <p class="muted">체크한 항목은 모든 아바타에서 비활성화됩니다. 도구는 대화에서 완전히 제거되고, 스킬은 목록에서 숨겨지거나 실행이 차단됩니다.</p>
                </div>
              </div>
              <form class="settings-form" on:submit|preventDefault={saveToolSkillPolicy}>
                <div class="field">
                  <span>내장 도구 비활성화</span>
                  <div class="external-agent-group-picker" role="group" aria-label="내장 도구 비활성화" aria-describedby={toolSkillStatusId}>
                    {#each togglableTools as entry (entry.id)}
                      <label class="external-agent-group-option">
                        <input type="checkbox" bind:checked={disabledToolChecks[entry.id]} aria-describedby={toolSkillStatusId} disabled={toolSkillBusy} on:change={() => (toolSkillError = "")} />
                        <span><strong>{entry.labelKo}</strong><small class="muted">{entry.descriptionKo}</small></span>
                      </label>
                    {/each}
                  </div>
                </div>
                <div class="field">
                  <span>스킬 비활성화</span>
                  {#if sys.skillDiscovery}
                    <p class="muted">CLI v{sys.skillDiscovery.cliVersion} 기준으로 발견한 스킬/커맨드 {discoveredSkills.length}개입니다.</p>
                    <div class="external-agent-group-picker" role="group" aria-label="스킬 비활성화" aria-describedby={toolSkillStatusId}>
                      {#each discoveredSkills as skill (skill.name)}
                        <label class="external-agent-group-option">
                          <input type="checkbox" bind:checked={disabledSkillChecks[skill.name]} aria-describedby={toolSkillStatusId} disabled={toolSkillBusy} on:change={() => (toolSkillError = "")} />
                          <span><strong>{skill.name}</strong>{#if skill.description}<small class="muted">{skill.description}</small>{/if}</span>
                        </label>
                      {/each}
                      {#each customDisabledSkills as name (name)}
                        <label class="external-agent-group-option">
                          <input type="checkbox" checked disabled={toolSkillBusy} on:change={() => removeCustomDisabledSkill(name)} />
                          <span><strong>{name}</strong><small class="muted">직접 추가됨 — 체크를 해제하면 목록에서 제거됩니다.</small></span>
                        </label>
                      {/each}
                    </div>
                  {:else}
                    <div class="empty-note">스킬 목록을 불러오지 못했습니다. 아래 입력으로 스킬 이름을 직접 추가해 비활성화할 수 있습니다.</div>
                    {#if customDisabledSkills.length}
                      <div class="external-agent-group-picker" role="group" aria-label="직접 추가한 비활성 스킬" aria-describedby={toolSkillStatusId}>
                        {#each customDisabledSkills as name (name)}
                          <label class="external-agent-group-option">
                            <input type="checkbox" checked disabled={toolSkillBusy} on:change={() => removeCustomDisabledSkill(name)} />
                            <span><strong>{name}</strong><small class="muted">직접 추가됨 — 체크를 해제하면 목록에서 제거됩니다.</small></span>
                          </label>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
                <label class="field">
                  <span>스킬 이름 직접 추가</span>
                  <input
                    bind:value={customSkillInput}
                    placeholder="예: code-review"
                    autocomplete="off"
                    aria-describedby={toolSkillStatusId}
                    aria-invalid={toolSkillError ? "true" : undefined}
                    disabled={toolSkillBusy}
                    on:input={() => (toolSkillError = "")}
                    on:keydown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addCustomDisabledSkill();
                      }
                    }}
                  />
                </label>
                <div class="ar-actions">
                  <button class="ghost-sm" type="button" disabled={toolSkillBusy || !customSkillInput.trim()} on:click={addCustomDisabledSkill}>비활성 목록에 추가</button>
                </div>
                <div class="settings-save-row">
                  <span id={toolSkillStatusId} class="settings-save-status" class:dirty={toolSkillDirty && !toolSkillBusy && !toolSkillError} class:pending={toolSkillBusy} class:invalid={Boolean(toolSkillError)} role="status" aria-live="polite">{toolSkillStatus}</span>
                  <button class="primary" type="submit" disabled={!toolSkillCanSave}>{toolSkillBusy ? "저장 중…" : "정책 저장"}</button>
                </div>
              </form>
            </section>
          </div>
        {/if}
      {:else if $appState.adminTab === "audit"}
        <div class="admin-list">
          <section class="settings-card">
            <div class="panel-section-head">
              <div>
                <h3>감사 로그</h3>
                <p class="muted">최근 활동 {($appState.audit || []).length}건 (로그인·권한 변경·관리 작업 등).</p>
              </div>
            </div>
            <div class="admin-users-head">
              <select class="admin-search" aria-label="액션 필터" bind:value={auditAction} disabled={!auditActions.length}>
                <option value="">{auditActions.length ? "전체 액션" : "필터할 액션 없음"}</option>
                {#each auditActions as a}
                  <option value={a} title={a}>{auditActionLabel(a)}</option>
                {/each}
              </select>
              <span class="muted nowrap">
                {#if auditAction}표시 {shownAudit.length}건 / 전체 {($appState.audit || []).length}건{:else}총 {shownAudit.length}건{/if}
              </span>
              {#if auditAction}
                <button class="linkish small" type="button" on:click={() => (auditAction = "")}>필터 해제</button>
              {/if}
            </div>
            <div class="audit-table-wrap">
              {#if !shownAudit.length}
                {#if auditAction}
                  <div class="muted pad">
                    “{auditActionLabel(auditAction)}” 액션 기록이 없습니다.
                    <button class="linkish small" type="button" on:click={() => (auditAction = "")}>전체 액션 보기</button>
                  </div>
                {:else}
                  <div class="muted pad">기록이 없습니다.</div>
                {/if}
              {:else}
                <div class="audit-table">
                  {#each shownAudit as r (r.id)}
                    <div class="audit-row">
                      <span class="audit-time muted">{timeLabel(r.createdAt)}</span>
                      <span class="audit-actor">{r.actorName || "—"}</span>
                      <span class="tag audit-action-tag" class:mono={!AUDIT_ACTION_LABELS[r.action]} title={r.action}>{auditActionLabel(r.action)}</span>
                      <span class="tag {r.status === 'success' || r.status === 'ok' ? 'read' : 'danger'}" title={r.status}>{auditStatusLabel(r.status)}</span>
                      <span class="audit-detail muted">{r.detail || ""}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </section>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Localized action labels are longer than the raw ids, and only `.tag.mono`
     truncates in the shared audit-table rule — give the Korean variant the same
     clipping so a long label can't push the detail column out of the row. */
  .audit-action-tag {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
