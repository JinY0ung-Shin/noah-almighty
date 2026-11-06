<script lang="ts">
  // 관리자 ▸ 도구·스킬 ▸ MCP 도구 정책 — ONE deployment-wide allowlist of MCP
  // tool groups (GET/PUT /api/admin/tool-policy). Replaced the per-group policy
  // editor when groups were retired (single team, 2026-11-06). Always mounted by
  // AdminView with an `active` prop so an unsaved draft survives tab switches.
  import { api, refreshMe } from "../lib/api";
  import { notify } from "../lib/state";
  import { MCP_TOOL_GROUPS, effectiveMcpToolGroups, isRequiredMcpToolGroup, type McpToolGroupId } from "../../../shared/mcpToolGroups";

  export let active = false;

  const statusId = "admin-tool-policy-status";
  let initialized = false;
  let loading = false;
  let loadError = "";
  // `undefined` until the first successful load; `null` = no restriction.
  let saved: McpToolGroupId[] | null | undefined = undefined;
  // `restricted` off ⇒ null(제한 없음); on ⇒ the checked allowlist (may be []).
  let restricted = false;
  let draft = new Set<McpToolGroupId>();
  let busy = false;
  let error = "";

  $: if (active && !initialized) void load();

  $: loaded = saved !== undefined;
  $: savedEffective = saved === undefined || saved === null ? null : effectiveMcpToolGroups(saved);
  $: dirty =
    loaded &&
    (restricted !== (savedEffective !== null) ||
      (restricted &&
        savedEffective !== null &&
        (draft.size !== savedEffective.length || savedEffective.some((id) => !draft.has(id)))));
  $: status = busy
    ? "저장 중…"
    : error
      ? `저장 실패: ${error}`
      : restricted && [...draft].every(isRequiredMcpToolGroup)
        ? "선택 가능한 도구 묶음이 모두 차단됩니다. 시스템 도구는 항상 사용할 수 있습니다."
        : dirty
          ? "저장하지 않은 도구 정책 변경 사항이 있습니다."
          : restricted
            ? `허용 ${draft.size}/${MCP_TOOL_GROUPS.length} — 저장됨`
            : "제한 없음 — 모든 팀원이 모든 MCP 도구 묶음을 쓸 수 있습니다.";

  function seed(value: McpToolGroupId[] | null): void {
    saved = value;
    restricted = value !== null;
    draft = new Set<McpToolGroupId>(effectiveMcpToolGroups(value));
    error = "";
  }

  async function load(): Promise<void> {
    initialized = true;
    if (loading) return;
    loading = true;
    loadError = "";
    try {
      const { allowedMcpToolGroups } = await api<{ allowedMcpToolGroups: McpToolGroupId[] | null }>("/api/admin/tool-policy");
      // A manual 다시 불러오기 never discards an unsaved draft.
      if (!dirty) seed(allowedMcpToolGroups);
      else saved = allowedMcpToolGroups;
    } catch (err) {
      loadError = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  function toggle(id: McpToolGroupId, on: boolean): void {
    if (busy || isRequiredMcpToolGroup(id)) return;
    const next = new Set(draft);
    if (on) next.add(id);
    else next.delete(id);
    draft = next;
    error = "";
  }

  async function save(): Promise<void> {
    if (busy || !dirty) return;
    busy = true;
    error = "";
    const allowed = restricted ? MCP_TOOL_GROUPS.map((g) => g.id).filter((id) => draft.has(id)) : null;
    try {
      const result = await api<{ allowedMcpToolGroups: McpToolGroupId[] | null }>("/api/admin/tool-policy", {
        method: "PUT",
        body: JSON.stringify({ allowedMcpToolGroups: allowed }),
      });
      seed(result.allowedMcpToolGroups);
      notify(
        result.allowedMcpToolGroups === null
          ? "MCP 도구 제한을 해제했습니다."
          : `MCP 도구 정책을 저장했습니다. (허용 ${result.allowedMcpToolGroups.length}/${MCP_TOOL_GROUPS.length})`,
        "ok",
      );
    } catch (err) {
      error = (err as Error).message;
      notify(`도구 정책 저장 실패: ${error}`);
      return;
    } finally {
      busy = false;
    }
    // The admin's own composer reads the policy from /api/me — refresh it so
    // the picker reflects the change without a reload. Best-effort.
    try {
      await refreshMe();
    } catch {
      /* the next /api/me picks it up */
    }
  }
</script>

{#if active}
  <section class="settings-card" aria-labelledby="admin-tool-policy-heading">
    <div class="panel-section-head">
      <div>
        <h3 id="admin-tool-policy-heading">MCP 도구 정책</h3>
        <p class="muted">
          모든 팀원이 아바타 대화에서 사용할 수 있는 MCP 도구 묶음을 제한합니다. 허용하지 않은 묶음은 대화 도구 선택에서
          꺼진 채 표시되고, 서버가 모든 실행에서 다시 막습니다. 시스템 도구는 항상 사용하며 개별 작업의 권한 검사는 유지됩니다.
        </p>
      </div>
      <button class="ghost-sm" type="button" disabled={loading || busy} on:click={() => void load()}>
        {loading ? "불러오는 중…" : "다시 불러오기"}
      </button>
    </div>
    {#if !loaded && loading}
      <div class="muted" role="status">불러오는 중…</div>
    {:else if !loaded && loadError}
      <div class="warn-box" role="alert">
        도구 정책을 불러오지 못했습니다: {loadError}
        <button class="linkish" type="button" disabled={loading} on:click={() => void load()}>다시 시도</button>
      </div>
    {:else if loaded}
      {#if loadError}
        <div class="warn-box" role="alert">최신 정책을 불러오지 못했습니다: {loadError}</div>
      {/if}
      <form class="settings-form" on:submit|preventDefault={save}>
        <label class="policy-option">
          <input
            type="checkbox"
            bind:checked={restricted}
            aria-describedby={statusId}
            disabled={busy}
            on:change={() => (error = "")}
          />
          <span><strong>MCP 도구 묶음 제한 사용</strong><small class="muted">끄면 모든 팀원이 모든 MCP 도구 묶음을 쓸 수 있습니다.</small></span>
        </label>
        {#if restricted}
          <div class="policy-option-picker" role="group" aria-label="허용할 MCP 도구 묶음" aria-describedby={statusId}>
            {#each MCP_TOOL_GROUPS as toolGroup (toolGroup.id)}
              <label class="policy-option">
                <input
                  type="checkbox"
                  checked={draft.has(toolGroup.id)}
                  aria-describedby={statusId}
                  disabled={busy || isRequiredMcpToolGroup(toolGroup.id)}
                  on:change={(event) => toggle(toolGroup.id, event.currentTarget.checked)}
                />
                <span>
                  <strong>{toolGroup.labelKo}{isRequiredMcpToolGroup(toolGroup.id) ? " · 항상 사용" : ""}</strong>
                  <small class="muted">{toolGroup.descriptionKo}</small>
                </span>
              </label>
            {/each}
          </div>
        {/if}
        <div class="settings-save-row">
          <span
            id={statusId}
            class="settings-save-status"
            class:dirty={Boolean(dirty && !busy && !error)}
            class:pending={busy}
            class:invalid={Boolean(error)}
            role="status"
            aria-live="polite"
          >{status}</span>
          <button class="primary" type="submit" disabled={busy || !dirty}>{busy ? "저장 중…" : "정책 저장"}</button>
        </div>
      </form>
    {/if}
  </section>
{/if}
