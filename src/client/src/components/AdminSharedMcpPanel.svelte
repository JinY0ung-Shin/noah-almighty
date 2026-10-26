<script lang="ts">
  import Icon from "./Icon.svelte";
  import RevealableInput from "./RevealableInput.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { notify } from "../lib/state";
  import type { SharedMcpServerView, SharedMcpTransport } from "../lib/types";

  export let active = false;

  type HeaderDraft = { name: string; value: string };
  type SlotDraft = { id: string; label: string; header: string; format: string };
  type CheckResult = { ok: boolean; tools: string[]; missingSecrets: string[]; error: string | null };

  let servers: SharedMcpServerView[] = [];
  let loading = false;
  let initialized = false;
  let error = "";
  let rowBusy: Record<string, boolean> = {};
  let rowStatus: Record<string, string> = {};

  // Inline editor: null = closed, "" = new server, otherwise the edited name.
  let editingName: string | null = null;
  let formBusy = false;
  let formError = "";
  let name = "";
  let label = "";
  let description = "";
  let url = "";
  let transport: SharedMcpTransport = "http";
  let enabled = true;
  let headers: HeaderDraft[] = [];
  // Credential slots: WHERE a user's secret goes. Users pick the secret
  // themselves in their 시크릿 card; the admin never names one. `id` is empty
  // for a new slot (the server mints it) and kept for an existing one, so
  // users' bindings survive an edit.
  let slots: SlotDraft[] = [];

  const formStatusId = "shared-mcp-form-status";

  $: if (active && !initialized && !loading) void load();
  $: isEdit = editingName !== null && editingName !== "";
  $: editedOrigin = (() => {
    try {
      return new URL(url.trim()).origin;
    } catch {
      return "";
    }
  })();
  $: savedOrigin = isEdit ? servers.find((server) => server.name === editingName)?.origin ?? "" : "";
  $: originChanges = Boolean(isEdit && savedOrigin && editedOrigin && editedOrigin !== savedOrigin);
  // Header names repeat case-insensitively across fixed headers AND slots
  // (the server refuses that too; catching it here keeps a row from being
  // silently overwritten in the payload map).
  $: duplicateHeader = (() => {
    const seen = new Set<string>();
    for (const headerName of [...headers.map((h) => h.name), ...slots.map((slot) => slot.header)]) {
      const key = headerName.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) return headerName.trim();
      seen.add(key);
    }
    return "";
  })();
  $: formReady = Boolean(name.trim() && url.trim() && !formBusy && !duplicateHeader);

  async function load(): Promise<void> {
    if (loading) return;
    loading = true;
    error = "";
    try {
      servers = (await api<{ servers: SharedMcpServerView[] }>("/api/admin/shared-mcp-servers")).servers;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
      initialized = true;
    }
  }

  function openCreate(): void {
    editingName = "";
    name = "";
    label = "";
    description = "";
    url = "";
    transport = "http";
    enabled = true;
    headers = [];
    slots = [{ id: "", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }];
    formError = "";
  }

  function openEdit(server: SharedMcpServerView): void {
    editingName = server.name;
    name = server.name;
    label = server.label;
    description = server.description;
    url = server.url;
    transport = server.transport;
    enabled = server.enabled;
    headers = Object.entries(server.headers).map(([headerName, value]) => ({ name: headerName, value }));
    slots = server.secretSlots.map((slot) => ({ ...slot }));
    formError = "";
  }

  function closeForm(): void {
    if (formBusy) return;
    editingName = null;
  }

  function addHeader(): void {
    headers = [...headers, { name: "", value: "" }];
  }

  function removeHeader(index: number): void {
    headers = headers.filter((_, i) => i !== index);
  }

  function addSlot(): void {
    slots = [...slots, { id: "", label: "", header: "", format: "{secret}" }];
  }

  function removeSlot(index: number): void {
    slots = slots.filter((_, i) => i !== index);
  }

  function payload(nextEnabled = enabled) {
    const headerMap: Record<string, string> = {};
    for (const header of headers) {
      if (header.name.trim() || header.value.trim()) headerMap[header.name.trim()] = header.value;
    }
    return {
      name: name.trim(),
      label: label.trim(),
      description: description.trim(),
      url: url.trim(),
      transport,
      headers: headerMap,
      secretSlots: slots
        .filter((slot) => slot.header.trim() || slot.label.trim())
        .map((slot) => ({
          ...(slot.id ? { id: slot.id } : {}),
          label: slot.label.trim(),
          header: slot.header.trim(),
          format: slot.format.trim(),
        })),
      enabled: nextEnabled,
    };
  }

  async function save(): Promise<void> {
    if (!formReady) return;
    formBusy = true;
    formError = "";
    try {
      if (isEdit) {
        await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(editingName!)}`, {
          method: "PUT",
          body: JSON.stringify(payload()),
        });
      } else {
        await api("/api/admin/shared-mcp-servers", { method: "POST", body: JSON.stringify(payload()) });
      }
      notify(`공용 MCP 서버 "${name.trim()}"을(를) 저장했습니다. 다음 메시지부터 적용됩니다.`, "ok");
      editingName = null;
      await load();
    } catch (err) {
      formError = (err as Error).message;
    } finally {
      formBusy = false;
    }
  }

  function serverBody(server: SharedMcpServerView, nextEnabled: boolean) {
    return {
      name: server.name,
      label: server.label,
      description: server.description,
      url: server.url,
      transport: server.transport,
      headers: server.headers,
      secretSlots: server.secretSlots,
      enabled: nextEnabled,
    };
  }

  async function toggleEnabled(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    rowBusy = { ...rowBusy, [server.name]: true };
    try {
      await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}`, {
        method: "PUT",
        body: JSON.stringify(serverBody(server, !server.enabled)),
      });
      notify(`"${server.label}"을(를) ${server.enabled ? "껐습니다" : "켰습니다"}. 다음 메시지부터 적용됩니다.`, "ok");
      await load();
    } catch (err) {
      notify(`상태 변경 실패: ${(err as Error).message}`);
    } finally {
      rowBusy = { ...rowBusy, [server.name]: false };
    }
  }

  async function remove(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    if (!(await confirmAction(`공용 MCP 서버 "${server.label}"을(를) 삭제할까요? 모든 아바타에서 다음 메시지부터 빠집니다.`))) return;
    rowBusy = { ...rowBusy, [server.name]: true };
    try {
      await api(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}`, { method: "DELETE" });
      notify(`공용 MCP 서버 "${server.label}"을(를) 삭제했습니다.`, "ok");
      if (editingName === server.name) editingName = null;
      await load();
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`);
    } finally {
      rowBusy = { ...rowBusy, [server.name]: false };
    }
  }

  async function check(server: SharedMcpServerView): Promise<void> {
    if (rowBusy[server.name]) return;
    rowBusy = { ...rowBusy, [server.name]: true };
    rowStatus = { ...rowStatus, [server.name]: "내가 연결한 시크릿으로 접속해 도구 목록을 확인하는 중…" };
    try {
      const result = await api<CheckResult>(`/api/admin/shared-mcp-servers/${encodeURIComponent(server.name)}/check`, {
        method: "POST",
      });
      rowStatus = {
        ...rowStatus,
        [server.name]: result.ok
          ? `연결됨 · 도구 ${result.tools.length}개${result.tools.length ? `: ${result.tools.slice(0, 12).join(", ")}${result.tools.length > 12 ? " …" : ""}` : ""}`
          : result.error || "연결 확인 실패",
      };
    } catch (err) {
      rowStatus = { ...rowStatus, [server.name]: `연결 확인 실패: ${(err as Error).message}` };
    } finally {
      rowBusy = { ...rowBusy, [server.name]: false };
    }
  }
</script>

{#if active}
  <div class="admin-users shared-mcp-panel">
    <section class="settings-card">
      <div class="panel-section-head">
        <div>
          <h3>공용 MCP 서버</h3>
          <p class="muted">
            외부 HTTP MCP 서버를 등록하면 모든 아바타가 그 도구를 씁니다. 사용자별 인증이 필요하면 <strong>인증 자리</strong>(어느 헤더에 어떤 형식으로)만
            정해 두세요. 어떤 시크릿을 넣을지는 각 사용자가 자기 시크릿 카드에서 직접 고릅니다.
          </p>
        </div>
        <div class="ar-actions">
          <button class="ghost-sm" type="button" disabled={loading} on:click={load}>{loading ? "새로고침 중…" : "새로고침"}</button>
          <button class="primary small" type="button" disabled={editingName !== null} on:click={openCreate}>
            <Icon name="plus" size={16} /> 추가
          </button>
        </div>
      </div>
      <ul class="hint-list">
        <li>관리자는 사용자의 시크릿을 지정하거나 볼 수 없습니다. 사용자가 인증 자리에 자기 시크릿을 연결해야 그 사용자의 본인 대화·같은 그룹원 대화에서 서버가 붙고, 일반 동료 대화·그룹 에이전트에서는 빠집니다.</li>
        <li>연결은 서버 주소의 호스트에 묶입니다. 주소의 호스트를 바꾸면 모든 사용자의 연결이 해제되어 다시 연결해야 합니다.</li>
        <li>고정 헤더는 모든 사용자의 실행에 그대로 전송됩니다. 외부 통신 차단이 켜져 있다면 서버 도메인이 차단 목록에 없어야 합니다. 변경은 다음 메시지부터 적용됩니다.</li>
      </ul>

      {#if editingName !== null}
        <form class="settings-form shared-mcp-form" aria-busy={formBusy} on:submit|preventDefault={save}>
          <h4>{isEdit ? `"${editingName}" 편집` : "새 공용 MCP 서버"}</h4>
          <div class="field-row-2col">
            <label class="field">
              <span>서버 이름</span>
              <input bind:value={name} disabled={isEdit || formBusy} placeholder="jira" autocomplete="off" spellcheck="false" required aria-describedby={formStatusId} />
              <small class="field-hint">도구 이름이 <code>mcp__{name.trim() || "이름"}__도구</code>가 됩니다. 영문 소문자로 시작하고 저장 후에는 바꿀 수 없습니다.</small>
            </label>
            <label class="field">
              <span>표시 이름</span>
              <input bind:value={label} disabled={formBusy} placeholder="사내 Jira" autocomplete="off" />
            </label>
          </div>
          <label class="field">
            <span>설명</span>
            <textarea bind:value={description} disabled={formBusy} rows="2" placeholder="이 서버로 무엇을 할 수 있는지 (아바타와 사용자에게 함께 보입니다)"></textarea>
          </label>
          <div class="field-row-2col">
            <label class="field">
              <span>서버 주소 (URL)</span>
              <input bind:value={url} disabled={formBusy} placeholder="https://mcp.example.com/mcp" autocomplete="off" spellcheck="false" required />
            </label>
            <label class="field">
              <span>전송 방식</span>
              <select bind:value={transport} disabled={formBusy}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE (레거시)</option>
              </select>
            </label>
          </div>
          {#if originChanges}
            <div class="warn-box" role="status">호스트가 {savedOrigin}에서 {editedOrigin}(으)로 바뀝니다. 저장하면 모든 사용자의 시크릿 연결이 해제되어 각자 다시 연결해야 합니다.</div>
          {/if}
          <div class="field">
            <span>인증 자리</span>
            {#each slots as slot, index}
              <div class="shared-mcp-slot-row">
                <input bind:value={slot.label} disabled={formBusy} placeholder="API 토큰" autocomplete="off" aria-label={`인증 자리 ${index + 1} 이름`} />
                <input bind:value={slot.header} disabled={formBusy} placeholder="Authorization" autocomplete="off" spellcheck="false" aria-label={`인증 자리 ${index + 1} 헤더`} />
                <input bind:value={slot.format} disabled={formBusy} placeholder={"Bearer {secret}"} autocomplete="off" spellcheck="false" aria-label={`인증 자리 ${index + 1} 형식`} />
                <button class="ghost-sm" type="button" disabled={formBusy} aria-label={`인증 자리 ${index + 1} 삭제`} on:click={() => removeSlot(index)}>삭제</button>
              </div>
            {/each}
            <div><button class="ghost-sm" type="button" disabled={formBusy} on:click={addSlot}><Icon name="plus" size={14} /> 인증 자리 추가</button></div>
            <small class="field-hint">
              형식의 <code>{"{secret}"}</code> 자리에 사용자가 고른 시크릿 값이 들어갑니다. 인증 자리가 없으면 모든 대화에서 같은 설정으로 연결됩니다.
            </small>
          </div>
          <div class="field">
            <span>고정 헤더</span>
            {#each headers as header, index}
              <div class="shared-mcp-header-row">
                <input bind:value={header.name} disabled={formBusy} placeholder="X-Team" autocomplete="off" spellcheck="false" aria-label={`고정 헤더 ${index + 1} 이름`} />
                <RevealableInput bind:value={header.value} disabled={formBusy} placeholder="값" ariaLabel={`고정 헤더 ${index + 1} 값`} />
                <button class="ghost-sm" type="button" disabled={formBusy} aria-label={`고정 헤더 ${index + 1} 삭제`} on:click={() => removeHeader(index)}>삭제</button>
              </div>
            {/each}
            <div><button class="ghost-sm" type="button" disabled={formBusy} on:click={addHeader}><Icon name="plus" size={14} /> 고정 헤더 추가</button></div>
            <small class="field-hint">모든 사용자에게 같은 값입니다. 사용자별 값은 인증 자리로 받으세요.</small>
          </div>
          <label class="shared-mcp-enabled"><input type="checkbox" bind:checked={enabled} disabled={formBusy} /> 사용</label>
          <div class="settings-save-row">
            <span id={formStatusId} class="settings-save-status" class:pending={formBusy} class:invalid={Boolean(formError || duplicateHeader)} role="status" aria-live="polite">
              {formBusy
                ? "저장 중…"
                : formError
                  ? `저장 실패: ${formError}`
                  : duplicateHeader
                    ? `${duplicateHeader} 헤더가 두 번 들어 있습니다.`
                    : "저장하면 다음 메시지부터 모든 아바타에 적용됩니다."}
            </span>
            <button class="btn" type="button" disabled={formBusy} on:click={closeForm}>취소</button>
            <button class="primary" type="submit" disabled={!formReady}>{formBusy ? "저장 중…" : "저장"}</button>
          </div>
        </form>
      {/if}

      {#if error}
        <div class="warn-box" role="alert">
          공용 MCP 서버 목록을 불러오지 못했습니다: {error}
          <button class="linkish" type="button" disabled={loading} on:click={load}>다시 시도</button>
        </div>
      {:else if loading && !initialized}
        <div class="muted pad" role="status">공용 MCP 서버 목록을 불러오는 중…</div>
      {:else if !servers.length}
        {#if editingName === null}
          <div class="empty-note">
            <strong>등록된 공용 MCP 서버가 없습니다.</strong>
            <span class="muted">사내 HTTP MCP 서버 주소와 인증 헤더를 등록해 모든 아바타에 도구를 붙이세요.</span>
          </div>
        {/if}
      {:else}
        <div class="admin-list" aria-busy={loading}>
          {#each servers as server (server.name)}
            <article class="admin-user" class:is-disabled={!server.enabled}>
              <div class="admin-row">
                <div class="ar-main">
                  <strong>{server.label}</strong>
                  <div class="muted mono">mcp__{server.name}__*</div>
                  <div class="muted shared-mcp-url">{server.url}</div>
                  {#if server.description}<div class="muted">{server.description}</div>{/if}
                </div>
                <div class="ar-tags">
                  <span class="tag {server.enabled ? 'read' : 'danger'}">{server.enabled ? "사용" : "꺼짐"}</span>
                  <span class="tag mono">{server.transport === "sse" ? "SSE" : "HTTP"}</span>
                  {#if server.secretSlots.length}
                    {#each server.secretSlots as slot}<span class="tag write" title={`${slot.header}: ${slot.format}`}>인증 자리 · {slot.label}</span>{/each}
                  {:else}
                    <span class="tag">사용자 시크릿 불필요</span>
                  {/if}
                </div>
                <div class="ar-actions">
                  <button class="ghost-sm" type="button" disabled={rowBusy[server.name]} on:click={() => check(server)}>
                    {rowBusy[server.name] ? "확인 중…" : "연결 확인"}
                  </button>
                  <button class="ghost-sm" type="button" disabled={rowBusy[server.name] || editingName !== null} on:click={() => openEdit(server)}>편집</button>
                  <button class="ghost-sm" type="button" disabled={rowBusy[server.name]} on:click={() => toggleEnabled(server)}>{server.enabled ? "끄기" : "켜기"}</button>
                  <button class="ghost-sm danger" type="button" disabled={rowBusy[server.name]} on:click={() => remove(server)}>삭제</button>
                </div>
              </div>
              {#if rowStatus[server.name]}
                <div class="muted shared-mcp-row-note" role="status" aria-live="polite">{rowStatus[server.name]}</div>
              {/if}
            </article>
          {/each}
        </div>
        <p class="muted shared-mcp-footnote">연결 확인은 지금 로그인한 관리자 본인이 시크릿 카드에서 연결한 시크릿으로 접속합니다.</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .shared-mcp-form { margin: var(--s-3) 0; padding: var(--s-3); border: 1px solid var(--line); border-radius: var(--r-md); }
  .shared-mcp-form h4 { margin: 0 0 var(--s-2); }
  .shared-mcp-header-row { display: grid; grid-template-columns: minmax(8rem, 1fr) minmax(10rem, 2fr) auto; gap: var(--s-2); align-items: center; margin-bottom: var(--s-1); }
  .shared-mcp-slot-row { display: grid; grid-template-columns: minmax(6rem, 1fr) minmax(7rem, 1fr) minmax(8rem, 1.5fr) auto; gap: var(--s-2); align-items: center; margin-bottom: var(--s-1); }
  .shared-mcp-enabled { display: flex; align-items: center; gap: var(--s-2); }
  .shared-mcp-url, .shared-mcp-row-note { overflow-wrap: anywhere; }
  .shared-mcp-row-note { padding: 0 var(--s-3) var(--s-2); font-size: var(--t-sm); }
  .shared-mcp-footnote { margin: var(--s-2) 0 0; font-size: var(--t-sm); }
  @media (max-width: 640px) {
    .shared-mcp-header-row, .shared-mcp-slot-row { grid-template-columns: 1fr; }
  }
</style>
