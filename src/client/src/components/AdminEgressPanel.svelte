<script lang="ts">
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { normalizeEgressDomains } from "../../../shared/egressDomains";
  import type { EgressPolicyState } from "../../../server/types";

  export let active = false;
  let initialized = false;
  let busy = false;
  let state: EgressPolicyState | null = null;
  let domains: string[] = [];
  let domainInput = "";
  let includeSubdomains = true;
  let error = "";
  let message = "";
  let statusUnconfirmed = false;
  $: dirty = !!state && JSON.stringify(domains) !== JSON.stringify(state.domains);
  $: if (active && !initialized) void load();

  async function load() {
    initialized = true;
    if (busy) return;
    if (dirty && !(await confirmAction("수정 중인 목록을 버리고 현재 적용된 목록을 불러올까요?"))) return;
    busy = true;
    error = "";
    message = "";
    try {
      state = await api<EgressPolicyState>("/api/admin/egress");
      domains = [...state.domains];
      statusUnconfirmed = false;
    } catch (err) {
      error = (err as Error).message;
      statusUnconfirmed = true;
    } finally {
      busy = false;
    }
  }

  function add() {
    error = "";
    message = "";
    try {
      const value = domainInput.trim();
      const candidate = includeSubdomains && !value.startsWith(".") && !value.startsWith("*.") ? `.${value}` : value;
      domains = normalizeEgressDomains([...domains, candidate]);
      domainInput = "";
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function remove(domain: string) {
    domains = domains.filter((value) => value !== domain);
    error = "";
    message = "";
  }

  async function save() {
    if (busy || !state?.configured || !state.revision) return;
    busy = true;
    error = "";
    message = "";
    try {
      state = await api<EgressPolicyState>("/api/admin/egress", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Noah-Egress-Admin": "1" },
        body: JSON.stringify({ domains, revision: state.revision }),
      });
      domains = [...state.domains];
      statusUnconfirmed = false;
      message = "전체 아바타에 차단 목록을 적용했습니다.";
    } catch (err) {
      error = (err as Error).message;
      statusUnconfirmed = true;
    } finally {
      busy = false;
    }
  }
</script>

{#if active}
  <section class="settings-card egress-card" aria-labelledby="egress-heading" aria-busy={busy}>
    <div class="panel-section-head">
      <div>
        <h3 id="egress-heading">외부 통신 차단</h3>
        <p class="muted">전체 아바타의 서버 요청에 공통 적용됩니다. 사용자 PC의 브라우저 도구는 적용 대상이 아닙니다.</p>
      </div>
      <button class="ghost-sm" type="button" disabled={busy} on:click={load}>현재 목록 불러오기</button>
    </div>
    {#if state?.configured}
      <p class="muted" role="status">
        {statusUnconfirmed ? "현재 적용 상태를 확인하려면 목록을 다시 불러오세요." : state.proxyReady ? "차단 서비스 작동 중" : "차단 서비스 연결 확인 필요 — 외부 요청이 실패할 수 있습니다."}
        {#if state.appliedAt} · 마지막 적용 {new Date(state.appliedAt).toLocaleString("ko-KR")}{/if}
      </p>
      <form class="settings-form" on:submit|preventDefault={add}>
        <label class="field">
          <span>차단할 도메인</span>
          <input bind:value={domainInput} placeholder="example.com" autocomplete="off" spellcheck="false"
            disabled={busy} aria-describedby="egress-help" />
        </label>
        <div class="egress-add-row">
          <label><input type="checkbox" bind:checked={includeSubdomains} disabled={busy} /> 하위 도메인도 포함</label>
          <button class="ghost-sm" type="submit" disabled={busy || !domainInput.trim()}>목록에 추가</button>
        </div>
        <p id="egress-help" class="muted">URL 경로와 IP 주소는 지원하지 않습니다. 상위 도메인 규칙에 포함되는 중복 항목은 합쳐집니다.</p>
      </form>
      <ul class="egress-domains" aria-label="차단 도메인 목록">
        {#each domains as domain (domain)}
          <li>
            <div><strong>{domain.replace(/^\./, "")}</strong><span class="muted">{domain.startsWith(".") ? "하위 도메인 포함" : "이 호스트만"}</span></div>
            <button class="ghost-sm" type="button" disabled={busy} aria-label={`${domain} 삭제`} on:click={() => remove(domain)}>삭제</button>
          </li>
        {/each}
      </ul>
      {#if !domains.length}<p class="empty-note">차단할 도메인이 없습니다. 적용하면 도메인 차단을 모두 해제합니다. 직접 IP·DNS 연결 차단은 유지됩니다.</p>{/if}
      <p class="muted">저장하고 적용하면 진행 중인 서버 외부 연결이 끊어질 수 있습니다. 모델 API·Git·사내 서비스도 이 목록의 영향을 받습니다.</p>
      <div class="settings-save-row">
        <span class="settings-save-status" class:dirty class:pending={busy} role="status" aria-live="polite">
          {busy ? "처리 중…" : message || (dirty ? "아직 적용하지 않은 변경이 있습니다." : `${domains.length}개 도메인 규칙`)}
        </span>
        <button class="primary" type="button" disabled={busy || statusUnconfirmed || (!dirty && state.proxyReady) || !!domainInput.trim()} on:click={save}>
          {busy ? "적용 중…" : "저장하고 적용"}
        </button>
      </div>
      {#if domainInput.trim()}<p class="muted">입력한 도메인을 먼저 목록에 추가하거나 입력을 지워 주세요.</p>{/if}
    {:else if state}
      <p class="empty-note">이 서버에는 외부 통신 차단 서비스가 연결되어 있지 않습니다. 운영자가 차단 서비스를 설치하면 이 화면에서 목록을 관리할 수 있습니다.</p>
    {:else if busy}
      <p class="muted" role="status">차단 정책을 불러오는 중…</p>
    {/if}
    {#if error}<p class="warn-box" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  .egress-card { margin-bottom: var(--s-4); }
  .egress-add-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  .egress-add-row label { display: flex; align-items: center; gap: .5rem; font-size: var(--t-sm); }
  .egress-domains { list-style: none; margin: var(--s-3) 0; padding: 0; max-height: 20rem; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-md); }
  .egress-domains:empty { display: none; }
  .egress-domains li { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: var(--s-2) var(--s-3); font-size: var(--t-sm); }
  .egress-domains li + li { border-top: 1px solid var(--line); }
  .egress-domains li div { min-width: 0; display: grid; gap: .2rem; overflow-wrap: anywhere; }
</style>
