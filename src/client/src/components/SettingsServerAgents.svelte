<script lang="ts">
  import Modal from "./Modal.svelte";
  import {
    MAX_SERVER_AGENTS,
    SERVER_AGENT_ACCESS_LABELS_KO,
    SERVER_AGENT_ACCESS_LEVELS,
    SERVER_AGENT_ERROR_KO,
    SERVER_AGENT_NAME_MAX,
    SERVER_AGENT_NOTES_MAX,
    SERVER_AGENT_ROLE_MAX,
    SERVER_AGENT_WORKDIR_MAX,
    serverAgentInputErrorKo,
    validateServerAgentInput,
  } from "../../../shared/serverAgents";
  import { api } from "../lib/api";
  import { appState, notify } from "../lib/state";
  import type {
    ServerAgentAccess,
    ServerAgentHostKeyResponse,
    ServerAgentInput,
    ServerAgentInstallState,
    ServerAgentListResponse,
    ServerAgentView,
  } from "../lib/types";

  // 권한·연결 → 서버 에이전트: the owner's SSH servers the avatar delegates
  // work to (the Claude Code CLI runs ON the server). Registration flow:
  // save → read + trust the host-key fingerprint → check (installs the CLI).
  export let active = false;

  const ACCESS_DESCRIPTIONS: Record<ServerAgentAccess, string> = {
    read: "파일 읽기·검색만 합니다(Read, Glob, Grep). 셸 명령은 실행하지 않습니다.",
    exec: "읽기에 더해 셸 명령(Bash)을 실행합니다. 파일 편집 도구는 쓰지 않습니다.",
    full: "셸 명령과 파일 편집 도구(Edit, Write)까지 모두 씁니다.",
  };
  const ACCESS_TAG: Record<ServerAgentAccess, string> = { read: "read", exec: "write", full: "danger" };
  // Host-key errors are fixed by re-reading the fingerprint, so those rows keep
  // the 호스트 키 확인 action even while known_hosts already has an entry.
  const HOST_KEY_ERRORS = new Set(["HOST_NOT_TRUSTED", "HOST_KEY_MISMATCH"]);
  const CHECK_TIMEOUT_MS = 10 * 60_000;

  interface Draft {
    name: string;
    host: string;
    port: string;
    username: string;
    workdir: string;
    role: string;
    notes: string;
    access: ServerAgentAccess;
    enabled: boolean;
  }

  const ADMIN_DISABLED_BANNER =
    "관리자가 아직 서버 에이전트 기능을 켜지 않았습니다. 등록과 호스트 신뢰는 할 수 있지만 점검·위임은 관리자가 켠 뒤에 동작합니다.";

  let servers: ServerAgentView[] = [];
  let listSshKeySet = false;
  let egressBlocked = false;
  // Until a system admin enables the feature a check would be refused (it sends the
  // deployment's model credentials to the server), so 점검 explains instead of calling.
  let adminEnabled = true;
  let cliVersion = "";
  let loaded = false;
  let loading = false;
  let error = "";

  // Editor (one at a time): "add" renders under the list, "edit" in place of its row.
  let editorMode: "closed" | "add" | "edit" = "closed";
  let editingId = "";
  let draft: Draft = emptyDraft();
  let showValidation = false;
  let saving = false;
  let saveError = "";

  // Host-key trust panel (one server at a time).
  let hostKeyFor = "";
  let hostKey: ServerAgentHostKeyResponse | null = null;
  let hostKeyBusy = false;
  let trustBusy = false;
  let hostKeyError = "";

  let checkingIds: string[] = [];
  let checkErrors: Record<string, string> = {};
  let rowBusy = "";

  let deleteTarget: ServerAgentView | null = null;
  let deleteCleanup = true;
  let deleteBusy = false;

  $: if (active && !loaded && !loading) void load();
  // Leaving the tab drops the cached list (a re-entry, or another account after
  // a re-login, refetches) but keeps an unsaved draft.
  $: if (!active) loaded = false;
  // The secrets card writes the vault through appState, so generating a key
  // there clears the banner here without a refetch.
  $: sshKeySet = $appState.user ? $appState.user.secretNames.includes("SSH_PRIVATE_KEY") : listSshKeySet;
  $: draftCheck = validateServerAgentInput(draftBody(draft), { partial: false });
  $: invalidField = showValidation && !draftCheck.ok ? draftCheck.error.field : null;
  $: draftMessage = saveError || (showValidation && !draftCheck.ok ? serverAgentInputErrorKo(draftCheck.error) : "");

  function emptyDraft(): Draft {
    return { name: "", host: "", port: "22", username: "", workdir: "", role: "", notes: "", access: "read", enabled: true };
  }

  function draftFrom(server: ServerAgentView): Draft {
    return {
      name: server.name,
      host: server.host,
      port: String(server.port),
      username: server.username,
      workdir: server.workdir,
      role: server.role,
      notes: server.notes,
      access: server.access,
      enabled: server.enabled,
    };
  }

  function draftBody(value: Draft): Record<string, unknown> {
    return { ...value, port: value.port.trim() === "" ? undefined : value.port };
  }

  function sorted(list: ServerAgentView[]): ServerAgentView[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }

  function replaceServer(next: ServerAgentView): void {
    servers = sorted([...servers.filter((server) => server.id !== next.id), next]);
  }

  function serverPath(id: string, suffix = ""): string {
    return `/api/me/server-agents/${encodeURIComponent(id)}${suffix}`;
  }

  async function load(): Promise<void> {
    loading = true;
    loaded = true;
    error = "";
    try {
      const body = await api<ServerAgentListResponse>("/api/me/server-agents");
      servers = sorted(body.servers ?? []);
      listSshKeySet = body.sshKeySet;
      egressBlocked = body.egressBlocked;
      adminEnabled = body.adminEnabled !== false;
      cliVersion = body.cliVersion;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function openAdd(): void {
    editorMode = "add";
    editingId = "";
    draft = emptyDraft();
    showValidation = false;
    saveError = "";
  }

  function openEdit(server: ServerAgentView): void {
    editorMode = "edit";
    editingId = server.id;
    draft = draftFrom(server);
    showValidation = false;
    saveError = "";
  }

  function closeEditor(): void {
    editorMode = "closed";
    editingId = "";
    saveError = "";
    showValidation = false;
  }

  async function save(): Promise<void> {
    if (saving) return;
    showValidation = true;
    saveError = "";
    const check = validateServerAgentInput(draftBody(draft), { partial: false });
    if (!check.ok) return;
    const value = check.value as ServerAgentInput;
    const before = editorMode === "edit" ? servers.find((server) => server.id === editingId) : undefined;
    saving = true;
    try {
      const saved = before
        ? await api<ServerAgentView>(serverPath(before.id), { method: "PATCH", body: JSON.stringify(value) })
        : await api<ServerAgentView>("/api/me/server-agents", { method: "POST", body: JSON.stringify(value) });
      replaceServer(saved);
      closeEditor();
      const targetMoved = !before || before.host !== saved.host || before.port !== saved.port;
      if (!saved.hostTrusted && targetMoved && !egressBlocked) {
        notify(before ? "서버를 수정했습니다. 새 호스트의 키를 확인하세요." : "서버를 등록했습니다. 호스트 키 지문을 확인하세요.", "ok");
        void inspectHost(saved);
      } else {
        notify(before ? "서버를 수정했습니다." : "서버를 등록했습니다.", "ok");
      }
    } catch (err) {
      saveError = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  async function inspectHost(server: ServerAgentView): Promise<void> {
    hostKeyFor = server.id;
    hostKey = null;
    hostKeyError = "";
    hostKeyBusy = true;
    try {
      const seen = await api<ServerAgentHostKeyResponse>(serverPath(server.id, "/host-key"), { method: "POST" });
      if (hostKeyFor === server.id) hostKey = seen;
    } catch (err) {
      if (hostKeyFor === server.id) hostKeyError = (err as Error).message;
    } finally {
      hostKeyBusy = false;
    }
  }

  function closeHostKey(): void {
    hostKeyFor = "";
    hostKey = null;
    hostKeyError = "";
  }

  async function trustHost(server: ServerAgentView): Promise<void> {
    if (!hostKey || trustBusy) return;
    trustBusy = true;
    hostKeyError = "";
    try {
      const result = await api<{ server: ServerAgentView }>(serverPath(server.id, "/trust-host"), {
        method: "POST",
        body: JSON.stringify({ fingerprint: hostKey.fingerprint }),
      });
      replaceServer(result.server);
      closeHostKey();
      notify(`${server.name}의 호스트 키를 신뢰했습니다.`, "ok");
      // A never-checked server's next step is always the check (it installs the CLI).
      // The automatic first check waits for the admin switch (the banner says so).
      if (!result.server.installState && adminEnabled) void runCheck(result.server);
    } catch (err) {
      hostKeyError = (err as Error).message;
    } finally {
      trustBusy = false;
    }
  }

  async function runCheck(server: ServerAgentView): Promise<void> {
    if (checkingIds.includes(server.id)) return;
    if (!adminEnabled) {
      notify(ADMIN_DISABLED_BANNER, "info");
      return;
    }
    // The prerequisite is the button's first step, not a dead disabled state.
    if (!server.hostTrusted) {
      void inspectHost(server);
      return;
    }
    checkingIds = [...checkingIds, server.id];
    checkErrors = { ...checkErrors, [server.id]: "" };
    try {
      const state = await api<ServerAgentInstallState>(serverPath(server.id, "/check"), {
        method: "POST",
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(CHECK_TIMEOUT_MS) : undefined,
      });
      const current = servers.find((row) => row.id === server.id);
      if (current) replaceServer({ ...current, installState: state });
      if (state.ok) notify(`${server.name} 점검을 마쳤습니다. 서버 에이전트를 쓸 수 있습니다.`, "ok");
      else notify(`${server.name} 점검 실패: ${SERVER_AGENT_ERROR_KO[state.error ?? "UNKNOWN"]}`, "warn");
    } catch (err) {
      checkErrors = { ...checkErrors, [server.id]: (err as Error).message };
    } finally {
      checkingIds = checkingIds.filter((id) => id !== server.id);
    }
  }

  function askDelete(server: ServerAgentView): void {
    deleteTarget = server;
    deleteCleanup = true;
  }

  function closeDelete(): void {
    if (deleteBusy) return;
    deleteTarget = null;
  }

  async function confirmDelete(): Promise<void> {
    const server = deleteTarget;
    if (!server || deleteBusy) return;
    deleteBusy = true;
    rowBusy = server.id;
    try {
      const result = await api<{ ok: true; cleanup: "skipped" | "done" | "failed"; cleanupError?: string; cleanupReason?: string }>(
        serverPath(server.id, deleteCleanup ? "?cleanupRemote=1" : ""),
        { method: "DELETE" },
      );
      servers = servers.filter((row) => row.id !== server.id);
      if (editingId === server.id) closeEditor();
      if (hostKeyFor === server.id) closeHostKey();
      if (result.cleanup === "failed") {
        notify(`서버 등록은 삭제했지만 서버의 에이전트 파일은 지우지 못했습니다. ${result.cleanupError ?? ""}`.trim(), "warn");
      } else if (result.cleanupReason) {
        // Remote cleanup was deliberately skipped (a shared account or a live run there).
        notify(`서버 등록은 삭제했습니다. ${result.cleanupReason}`, "info");
      } else {
        notify(result.cleanup === "done" ? "서버와 서버의 에이전트 파일을 삭제했습니다." : "서버를 삭제했습니다.", "ok");
      }
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`, "warn");
    } finally {
      deleteBusy = false;
      deleteTarget = null;
      rowBusy = "";
    }
  }

  /** The row's install status; `version` is the build's CLI so a stale install reads as 업데이트 필요. */
  function statusOf(server: ServerAgentView, version: string): { text: string; tone: "ok" | "warn" | "danger"; title: string } {
    const state = server.installState;
    if (!state) return { text: "점검 필요", tone: "warn", title: "아직 점검하지 않았습니다. 점검을 실행하면 에이전트 프로그램이 설치됩니다." };
    const checked = `마지막 점검: ${new Date(state.checkedAt).toLocaleString("ko-KR")}`;
    if (!state.ok) {
      return { text: `실패: ${SERVER_AGENT_ERROR_KO[state.error ?? "UNKNOWN"]}`, tone: "danger", title: [checked, state.detail].filter(Boolean).join("\n") };
    }
    if (version && state.version !== version) {
      return { text: "업데이트 필요", tone: "warn", title: `${checked}\n설치된 버전 ${state.version ?? "알 수 없음"} → 다음 위임이나 점검 때 ${version}(으)로 자동 업데이트됩니다.` };
    }
    return { text: `설치됨 ${state.version ?? ""}`.trim(), tone: "ok", title: checked };
  }
</script>

{#snippet editor(heading: string)}
  <form class="settings-form server-agent-editor" aria-label={heading} aria-busy={saving} novalidate on:submit|preventDefault={save}>
    <strong class="server-agent-editor-title">{heading}</strong>
    <div class="field">
      <label for="server-agent-name"><span>이름</span></label>
      <input id="server-agent-name" aria-describedby="server-agent-name-hint" bind:value={draft.name} maxlength={SERVER_AGENT_NAME_MAX} placeholder="web-01" autocomplete="off" spellcheck="false" aria-invalid={invalidField === "name" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      <small id="server-agent-name-hint" class="field-hint">아바타가 이 이름으로 서버를 부릅니다. 영문 소문자·숫자·하이픈.</small>
    </div>
    <div class="field-row-2col server-agent-target">
      <label class="field">
        <span>호스트</span>
        <input bind:value={draft.host} placeholder="web-01.corp.example" autocomplete="off" spellcheck="false" aria-invalid={invalidField === "host" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      </label>
      <label class="field">
        <span>포트</span>
        <input bind:value={draft.port} inputmode="numeric" placeholder="22" autocomplete="off" aria-invalid={invalidField === "port" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      </label>
    </div>
    <div class="field-row-2col">
      <label class="field">
        <span>계정</span>
        <input bind:value={draft.username} placeholder="noah-agent" autocomplete="off" spellcheck="false" aria-invalid={invalidField === "username" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      </label>
      <label class="field">
        <span>작업 디렉터리</span>
        <input bind:value={draft.workdir} maxlength={SERVER_AGENT_WORKDIR_MAX} placeholder="/srv/app" autocomplete="off" spellcheck="false" aria-invalid={invalidField === "workdir" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      </label>
    </div>
    <div class="field">
      <label for="server-agent-role"><span>역할</span></label>
      <input id="server-agent-role" aria-describedby="server-agent-role-hint" bind:value={draft.role} maxlength={SERVER_AGENT_ROLE_MAX} placeholder="예: 주문 API 웹 서버 (nginx + node)" autocomplete="off" aria-invalid={invalidField === "role" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")} />
      <small id="server-agent-role-hint" class="field-hint">아바타가 어느 서버에 위임할지 고를 때 참고하는 한 줄 설명입니다.</small>
    </div>
    <div class="field">
      <label for="server-agent-notes"><span>운영 메모</span></label>
      <textarea id="server-agent-notes" aria-describedby="server-agent-notes-hint" rows="4" bind:value={draft.notes} maxlength={SERVER_AGENT_NOTES_MAX} placeholder="로그 위치, 재시작 절차, 건드리면 안 되는 것 등" aria-invalid={invalidField === "notes" ? "true" : undefined} disabled={saving} on:input={() => (saveError = "")}></textarea>
      <small id="server-agent-notes-hint" class="field-hint">서버에서 실행되는 에이전트에게만 전달됩니다. 비밀번호·토큰은 적지 마세요.</small>
    </div>
    <div class="field">
      <span>권한 등급</span>
      <div class="radio-cards" role="radiogroup" aria-label="권한 등급" aria-describedby="server-agent-access-caveat server-agent-access-unattended">
        {#each SERVER_AGENT_ACCESS_LEVELS as level (level)}
          <label class="radio-card">
            <input type="radio" name="server-agent-access" bind:group={draft.access} value={level} disabled={saving} />
            <div class="radio-card-body">
              <strong>{SERVER_AGENT_ACCESS_LABELS_KO[level]}</strong>
              <div class="muted">{ACCESS_DESCRIPTIONS[level]}</div>
            </div>
          </label>
        {/each}
      </div>
      <small id="server-agent-access-caveat" class="field-hint warn">명령 실행 등급도 셸로 파일을 바꿀 수 있습니다 — 실제 차단은 서버 계정 권한으로 하세요.</small>
      <small id="server-agent-access-unattended" class="field-hint">예약 작업·외부 API 실행에도 이 등급이 그대로 적용됩니다.</small>
    </div>
    <label class="server-agent-enabled">
      <input type="checkbox" bind:checked={draft.enabled} disabled={saving} />
      <span>사용 <span class="muted">— 끄면 아바타가 이 서버에 위임하지 않습니다.</span></span>
    </label>
    <div class="settings-save-row">
      <span class="settings-save-status" class:invalid={Boolean(draftMessage)} class:pending={saving} role="status" aria-live="polite">{saving ? "저장 중…" : draftMessage}</span>
      <div class="server-agent-editor-actions">
        <button class="btn sm" type="button" disabled={saving} on:click={closeEditor}>취소</button>
        <button class="btn primary sm" type="submit" disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
      </div>
    </div>
  </form>
{/snippet}

{#snippet trustPanel(server: ServerAgentView)}
  <div class="server-agent-trust" role="group" aria-label={`호스트 키 확인: ${server.name}`}>
    {#if hostKeyBusy}
      <p class="muted" role="status">호스트 키를 가져오는 중…</p>
    {:else if hostKey}
      {#if hostKey.mismatch}
        <div class="server-agent-danger" role="alert">
          이 호스트에 이미 신뢰된 키와 다른 키입니다. 서버 키를 교체했는지 서버 관리자에게 확인한 뒤에만 신뢰하세요 — 확인 없이 신뢰하면 연결이 가로채질 수 있습니다.
        </div>
      {/if}
      <dl class="server-agent-key">
        <dt>키 종류</dt><dd><code>{hostKey.keyType}</code></dd>
        <dt>지문</dt><dd><code>{hostKey.fingerprint}</code></dd>
      </dl>
      {#if hostKey.trusted}
        <p class="muted">이미 이 지문으로 신뢰된 호스트입니다.</p>
      {:else}
        <p class="muted">서버 관리자에게 받은 지문(<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>)과 같은지 확인하세요.</p>
      {/if}
    {/if}
    {#if hostKeyError}<div class="warn-box" role="alert">{hostKeyError}</div>{/if}
    <div class="server-agent-trust-actions">
      {#if hostKey && !hostKey.trusted}
        <button class="btn primary sm" type="button" disabled={trustBusy} on:click={() => trustHost(server)}>{trustBusy ? "신뢰하는 중…" : "이 지문을 신뢰"}</button>
      {/if}
      {#if hostKeyError && !hostKeyBusy}
        <button class="btn sm" type="button" on:click={() => inspectHost(server)}>다시 시도</button>
      {/if}
      <button class="btn sm" type="button" disabled={trustBusy} on:click={closeHostKey}>닫기</button>
    </div>
  </div>
{/snippet}

{#if active}
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>서버 에이전트</h3>
        <p class="muted">
          등록한 서버에서 Claude Code 에이전트를 실행해, 아바타가 서버 작업을 맡깁니다. 여러 서버에 동시에 맡길 수도 있어요.
          서버에는 데몬이나 열린 포트가 필요 없고, 내 SSH 키와 등록한 계정으로 접속합니다.
          내 아바타와의 대화(예약 작업·외부 작업 API 포함)에서만 쓰이고, 동료가 내 아바타와 대화할 때는 쓸 수 없습니다.
        </p>
      </div>
    </div>
    <ul class="hint-list">
      <li>서버에 전용 계정(예: <code>noah-agent</code>)을 만들고, 위 시크릿 카드의 SSH 공개키를 그 계정의 <code>~/.ssh/authorized_keys</code>에 등록하세요.</li>
      <li>에이전트의 권한은 그 계정의 권한을 넘지 못합니다. sudo가 필요하면 꼭 필요한 명령만 허용하세요.</li>
      <li>등록한 뒤 호스트 키 지문을 확인해 신뢰하고 점검을 실행하면, 서버의 <code>~/.noah-agent</code>에 에이전트 프로그램이 설치됩니다. 서버에서 모델 API에 접속할 수 있어야 합니다.</li>
    </ul>

    {#if !adminEnabled}
      <div class="warn-box" role="alert">{ADMIN_DISABLED_BANNER}</div>
    {/if}
    {#if egressBlocked}
      <div class="warn-box" role="alert">{SERVER_AGENT_ERROR_KO.EGRESS_BLOCKED}</div>
    {/if}
    {#if !sshKeySet}
      <div class="warn-box" role="alert">SSH 키가 없습니다. 위 시크릿 카드에서 SSH 키를 먼저 생성하세요.</div>
    {/if}
    {#if error}
      <div class="warn-box" role="alert">{error} <button class="linkish" type="button" disabled={loading} on:click={load}>목록 다시 불러오기</button></div>
    {/if}

    <div class="server-agent-list">
      {#each servers as server (server.id)}
        {@const status = statusOf(server, cliVersion)}
        {@const checking = checkingIds.includes(server.id)}
        {#if editorMode === "edit" && editingId === server.id}
          {@render editor(`서버 수정: ${server.name}`)}
        {:else}
          <div class="server-agent-row">
            <div class="server-agent-main">
              <div class="server-agent-title">
                <strong>{server.name}</strong>
                <code>{server.username}@{server.host}:{server.port}</code>
              </div>
              {#if server.role}<span class="muted server-agent-role">{server.role}</span>{/if}
              <div class="server-agent-badges">
                <span class={`tag ${ACCESS_TAG[server.access]}`} title={ACCESS_DESCRIPTIONS[server.access]}>{SERVER_AGENT_ACCESS_LABELS_KO[server.access]}</span>
                {#if server.hostTrusted}
                  <span class="tag">호스트 신뢰됨</span>
                {:else}
                  <span class="tag write">호스트 미신뢰</span>
                {/if}
                {#if !server.enabled}<span class="tag">꺼짐</span>{/if}
              </div>
              <span class="server-agent-status" data-tone={checking ? "pending" : status.tone} title={checking ? undefined : status.title} role="status" aria-live="polite">
                {checking ? "점검 중… 처음에는 에이전트 프로그램(약 240MB)을 올리느라 1분 정도 걸릴 수 있습니다." : status.text}
              </span>
              {#if checkErrors[server.id]}<span class="server-agent-status" data-tone="danger">{checkErrors[server.id]}</span>{/if}
            </div>
            <div class="server-agent-actions">
              <button class="btn sm" type="button" disabled={checking || egressBlocked || rowBusy === server.id} aria-label={`점검: ${server.name}`} on:click={() => runCheck(server)}>{checking ? "점검 중…" : "점검"}</button>
              {#if !server.hostTrusted || HOST_KEY_ERRORS.has(server.installState?.error ?? "")}
                <button class="linkish small" type="button" disabled={egressBlocked || (hostKeyBusy && hostKeyFor === server.id)} aria-label={`호스트 키 확인: ${server.name}`} on:click={() => inspectHost(server)}>호스트 키 확인</button>
              {/if}
              <button class="linkish small" type="button" disabled={checking || saving || rowBusy === server.id} aria-label={`수정: ${server.name}`} on:click={() => openEdit(server)}>수정</button>
              <button class="linkish small" type="button" disabled={checking || rowBusy === server.id} aria-label={`삭제: ${server.name}`} on:click={() => askDelete(server)}>삭제</button>
            </div>
            {#if hostKeyFor === server.id}
              {@render trustPanel(server)}
            {/if}
          </div>
        {/if}
      {:else}
        <p class="muted">{loading ? "불러오는 중…" : "등록된 서버가 없습니다."}</p>
      {/each}
    </div>

    {#if editorMode === "add"}
      {@render editor("서버 추가")}
    {:else}
      <div>
        <button class="btn" type="button" disabled={!loaded || loading || servers.length >= MAX_SERVER_AGENTS} on:click={openAdd}>서버 추가</button>
        {#if servers.length >= MAX_SERVER_AGENTS}<span class="muted">서버는 최대 {MAX_SERVER_AGENTS}개까지 등록할 수 있습니다.</span>{/if}
      </div>
    {/if}
  </section>
{/if}

{#if active && deleteTarget}
  <Modal
    portal
    cardClass="confirm-card"
    ariaLabelledby="server-agent-delete-title"
    ariaDescribedby="server-agent-delete-copy"
    closeDisabled={deleteBusy}
    on:close={closeDelete}
  >
    <div class="confirm-symbol danger" aria-hidden="true">!</div>
    <div class="confirm-content">
      <h2 id="server-agent-delete-title">서버를 삭제할까요?</h2>
      <div id="server-agent-delete-copy" class="confirm-copy">
        <p>{deleteTarget.name} ({deleteTarget.username}@{deleteTarget.host}:{deleteTarget.port}) 등록과 이 서버의 대화별 세션 기록을 지웁니다.</p>
        <p>서버 계정의 authorized_keys는 서버 관리자가 직접 정리해야 합니다.</p>
      </div>
      <label class="server-agent-cleanup">
        <input type="checkbox" bind:checked={deleteCleanup} disabled={deleteBusy} />
        <span>서버에 설치된 에이전트 파일도 삭제 <span class="muted">(~/.noah-agent, ~/.claude-noah)</span></span>
      </label>
    </div>
    <div class="confirm-actions">
      <button class="ghost-sm" type="button" data-modal-autofocus disabled={deleteBusy} on:click={closeDelete}>취소</button>
      <button class="confirm-danger" type="button" disabled={deleteBusy} on:click={confirmDelete}>{deleteBusy ? "삭제 중…" : "삭제"}</button>
    </div>
  </Modal>
{/if}

<style>
  .server-agent-list {
    display: grid;
    gap: var(--s-2);
    margin-block: var(--s-3);
  }
  .server-agent-row {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-3);
    background: var(--bg-elevated);
  }
  .server-agent-main {
    display: grid;
    gap: var(--s-1);
    flex: 1 1 280px;
    min-width: 0;
  }
  .server-agent-title {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-2);
    min-width: 0;
  }
  .server-agent-title code {
    font-family: var(--font-mono);
    font-size: var(--t-sm);
    color: var(--text-soft);
    overflow-wrap: anywhere;
  }
  .server-agent-role {
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }
  .server-agent-badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .server-agent-status {
    font-size: var(--t-sm);
    font-weight: 600;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .server-agent-status[data-tone="ok"] {
    color: var(--ok);
  }
  .server-agent-status[data-tone="warn"] {
    color: var(--warn);
  }
  .server-agent-status[data-tone="danger"] {
    color: var(--danger);
  }
  .server-agent-status[data-tone="pending"] {
    color: var(--info);
  }
  .server-agent-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-3);
    flex: none;
  }
  /* Takes a full line of the wrapping row, like the secrets card's browser-input box. */
  .server-agent-trust {
    flex: 1 0 100%;
    display: grid;
    gap: var(--s-2);
    padding-top: var(--s-3);
    border-top: 1px dashed var(--line-soft);
  }
  .server-agent-trust p {
    margin: 0;
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }
  .server-agent-key {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--s-1) var(--s-3);
    margin: 0;
    font-size: var(--t-sm);
  }
  .server-agent-key dt {
    color: var(--muted);
  }
  .server-agent-key dd {
    margin: 0;
    min-width: 0;
  }
  .server-agent-key code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .server-agent-danger {
    border: 1px solid var(--danger-line);
    background: var(--danger-soft);
    color: var(--danger);
    border-radius: var(--r-md);
    padding: var(--s-2-5) var(--s-3);
    font-size: var(--t-sm);
    font-weight: 600;
    line-height: 1.5;
  }
  .server-agent-trust-actions,
  .server-agent-editor-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .server-agent-editor {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    padding: var(--s-4);
    background: var(--bg-elevated);
  }
  .server-agent-editor-title {
    font-size: var(--t-md);
  }
  .server-agent-editor textarea {
    font-family: inherit;
  }
  /* Host takes the room; the port is a short number. */
  .server-agent-target {
    grid-template-columns: minmax(0, 1fr) 7rem;
  }
  .server-agent-enabled,
  .server-agent-cleanup {
    display: inline-flex;
    align-items: flex-start;
    gap: var(--s-2);
    font-size: var(--t-sm);
    cursor: pointer;
  }
  .server-agent-enabled input,
  .server-agent-cleanup input {
    margin-top: var(--s-0-5);
    accent-color: var(--accent);
  }
  .server-agent-cleanup {
    text-align: left;
  }
  @media (max-width: 640px) {
    .field-row-2col {
      grid-template-columns: 1fr;
    }
  }
</style>
