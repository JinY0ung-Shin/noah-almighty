<script lang="ts">
  // 관리자 → 팀 브레인: the vault's size, the review queue size (decisions go
  // through the admin's avatar + a card, never here) and the push-only backup
  // mirror. Saving the backup address binds pushes to THIS admin's git token.
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { goView } from "../lib/nav";
  import {
    TEAM_PAGE_TYPES,
    TEAM_PAGE_TYPE_LABELS,
    TEAM_POLICY_DEFAULTS,
    teamGuidelinesAreEmpty,
    type TeamBrainBackupState,
    type TeamPolicyView,
  } from "../../../shared/teamBrain";

  export let active = false;

  interface PanelState {
    /** Compiled wiki pages (structural files excluded). */
    noteCount: number;
    /** raw/ sources in the vault (raw/legacy included); absent from an older server. */
    rawSources?: number;
    /** raw/ sources no valid page cites yet — the curator's backlog. */
    uncompiledSources?: number;
    pendingReview: number;
    backup: TeamBrainBackupState;
    githubHost: string;
  }

  let initialized = false;
  let busy = false;
  let state: PanelState | null = null;
  let url = "";
  let branch = "main";
  let error = "";
  let message = "";
  // 팀 정책 (POLICY.md), read-only here: it changes only through the admin's avatar + a card.
  let policy: TeamPolicyView | null = null;
  let policyLoading = false;
  let policyError = "";
  $: if (active && !initialized) void load();
  $: guidelinesEmpty = policy ? teamGuidelinesAreEmpty(policy.guidelines) : true;
  $: uncompiled = state?.uncompiledSources ?? 0;
  // Restore needs an EMPTY vault: raw sources count too (after the schema migration every old note is one).
  $: vaultEmpty = !!state && state.noteCount === 0 && (state.rawSources ?? 0) === 0;
  $: dirty = !!state && (url.trim() !== (state.backup.url ?? "") || (branch.trim() || "main") !== state.backup.branch);

  function seed(next: PanelState) {
    state = next;
    url = next.backup.url ?? "";
    branch = next.backup.branch || "main";
  }

  async function loadPolicy() {
    if (policyLoading) return;
    policyLoading = true;
    policyError = "";
    try {
      const r = await api<{ policy?: TeamPolicyView }>("/api/admin/team-brain/policy");
      if (!r?.policy) throw new Error("팀 정책을 불러오지 못했습니다.");
      policy = r.policy;
    } catch (err) {
      policyError = (err as Error).message;
    } finally {
      policyLoading = false;
    }
  }

  /** A guidelines body that is only an HTML comment and/or headings (the template stub) counts as none. */

  async function load() {
    initialized = true;
    void loadPolicy();
    if (busy) return;
    busy = true;
    error = "";
    try {
      seed(await api<PanelState>("/api/admin/team-brain"));
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function run(fn: () => Promise<string>) {
    if (busy) return;
    busy = true;
    error = "";
    message = "";
    try {
      message = await fn();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
      // Refresh the status line (last push / last error) either way.
      try {
        const next = await api<PanelState>("/api/admin/team-brain");
        if (state && !dirty) seed(next);
        else if (state) state = { ...next };
      } catch {
        /* keep what we have */
      }
    }
  }

  const save = () =>
    run(async () => {
      const trimmed = url.trim();
      await api("/api/admin/team-brain/backup", {
        method: "PUT",
        body: JSON.stringify({ url: trimmed || null, branch: branch.trim() || "main" }),
      });
      if (state) state.backup.url = trimmed || null;
      return trimmed ? "백업 저장소를 저장했습니다. 이제 내 git 토큰으로 백업합니다." : "백업 설정을 해제했습니다.";
    });

  const pushNow = () =>
    run(async () => {
      await api("/api/admin/team-brain/backup/push", { method: "POST" });
      return "백업을 완료했습니다.";
    });

  async function restore() {
    if (!(await confirmAction("백업 저장소의 내용으로 팀 브레인을 복원할까요? 비어 있는 팀 브레인에만 복원할 수 있습니다."))) return;
    await run(async () => {
      const r = await api<{ noteCount: number }>("/api/admin/team-brain/backup/restore", { method: "POST" });
      // The restore reply carries no raw counts, and an older mirror is migrated on restore (its notes
      // become raw sources), so read the panel state again for the real numbers.
      const next = await api<PanelState>("/api/admin/team-brain").catch(() => null);
      if (!next || next.rawSources === undefined) return `복원했습니다. 위키 페이지 ${r.noteCount}개`;
      const backlog = next.uncompiledSources ? ` (미편찬 ${next.uncompiledSources}건)` : "";
      return `복원했습니다. 위키 페이지 ${next.noteCount}개 · 원본 ${next.rawSources}건${backlog}`;
    });
  }

  function openTeamBrain() {
    goView("teamBrain");
  }

  function when(iso: string | null): string {
    return iso ? new Date(iso).toLocaleString("ko-KR") : "";
  }
</script>

{#if active}
  <section class="settings-card team-brain-admin" aria-labelledby="team-brain-admin-heading" aria-busy={busy}>
    <div class="panel-section-head">
      <div>
        <h3 id="team-brain-admin-heading">팀 브레인</h3>
        <p class="muted">팀원 모두가 읽는 공용 지식입니다. 팀원의 제안은 관리자가 자기 아바타를 통해 검토하고, 카드의 버튼을 눌러 승인하거나 반려합니다.</p>
      </div>
      <button class="ghost-sm" type="button" disabled={busy} on:click={load}>새로 고침</button>
    </div>
    {#if state}
      <div class="team-brain-admin-stats">
        <button class="stat-card stat-clickable" type="button" on:click={openTeamBrain}>
          <div class="stat-value">{state.noteCount}</div>
          <div class="stat-label">위키 페이지</div>
          <div class="stat-link muted">팀 브레인에서 보기</div>
        </button>
        {#if state.rawSources !== undefined}
          <div class="stat-card">
            <div class="stat-value">{state.rawSources}</div>
            <div class="stat-label">원본</div>
            <div class="stat-link muted" class:team-brain-admin-backlog={uncompiled > 0}>미편찬 {uncompiled}건</div>
          </div>
        {/if}
        <button class="stat-card stat-clickable" type="button" on:click={openTeamBrain}>
          <div class="stat-value">{state.pendingReview}</div>
          <div class="stat-label">검토 대기 제안</div>
          <div class="stat-link muted">목록 보기 · 결정은 아바타에게 요청</div>
        </button>
      </div>

      {#if uncompiled > 0}
        <p class="team-brain-admin-hint">아바타에게 '팀 브레인 정리(team-brain-curate)'를 요청하면 미편찬 원본을 위키로 편찬합니다.</p>
      {/if}

      <h4 class="team-brain-admin-sub">백업</h4>
      <p class="muted">
        팀 브레인은 이 서버에만 저장됩니다. 사내 git({state.githubHost})의 저장소를 지정하면 변경될 때마다 그곳으로 백업합니다.
        백업은 저장한 관리자의 git 토큰으로 올립니다. 백업 브랜치에 팀 브레인이 모르는 내용이 있으면 덮어쓰지 않고 백업을 멈춥니다.
      </p>
      <form class="settings-form" on:submit|preventDefault={save}>
        <label class="field">
          <span>백업 저장소</span>
          <input bind:value={url} placeholder={`owner/repo 또는 https://${state.githubHost}/owner/repo.git`} autocomplete="off" spellcheck="false" disabled={busy} />
        </label>
        <label class="field">
          <span>브랜치</span>
          <input bind:value={branch} placeholder="main" autocomplete="off" spellcheck="false" disabled={busy} />
        </label>
        <div class="settings-save-row">
          <span class="settings-save-status" class:dirty class:pending={busy} role="status" aria-live="polite">
            {#if busy}처리 중…
            {:else if message}{message}
            {:else if dirty}저장하지 않은 변경이 있습니다.
            {:else if !state.backup.url}백업이 설정되지 않았습니다.
            {:else if state.backup.lastError}백업 실패 · {state.backup.lastError}
            {:else if state.backup.lastOkAt}마지막 백업 {when(state.backup.lastOkAt)} · {state.backup.adminName}의 토큰
            {:else}아직 백업하지 않았습니다 · {state.backup.adminName}의 토큰
            {/if}
          </span>
          <button class="primary" type="submit" disabled={busy || !dirty}>저장</button>
        </div>
      </form>
      {#if state.backup.url}
        <div class="team-brain-admin-actions">
          <button class="ghost-sm" type="button" disabled={busy || dirty} on:click={pushNow}>지금 백업</button>
          <button class="ghost-sm" type="button" disabled={busy || dirty || !vaultEmpty} on:click={restore}
            title={vaultEmpty ? "" : "비어 있는 팀 브레인에만 복원할 수 있습니다."}>백업에서 복원</button>
        </div>
      {/if}
    {:else if busy}
      <p class="muted" role="status">불러오는 중…</p>
    {/if}
    {#if error}<p class="warn-box" role="alert">{error}</p>{/if}

    <h4 class="team-brain-admin-sub">팀 정책</h4>
    <p class="muted">팀 정책은 관리자 본인의 아바타에게 요청하면 카드로 바뀝니다 (카드의 팀 정책 반영을 눌러야 저장됩니다).</p>
    {#if policy}
      {#if !policy.exists}
        <p class="muted team-brain-policy-note">아직 팀 정책 파일(POLICY.md)이 없어 기본값을 씁니다.</p>
      {/if}
      {#if policy.problems.length}
        <div class="warn-box team-brain-policy-problems" role="note">
          <span>정책 파일에 문제가 있어 해당 항목은 기본값을 씁니다.</span>
          <ul>
            {#each policy.problems as problem, i (i)}<li>{problem}</li>{/each}
          </ul>
        </div>
      {/if}
      <table class="team-brain-policy-table" aria-label="팀 정책 설정">
        <tbody>
          {#each TEAM_PAGE_TYPES as type (type)}
            <tr>
              <th scope="row">{TEAM_PAGE_TYPE_LABELS[type]} · 다시 확인 주기</th>
              <td>
                {policy.knobs.reviewMonths[type]}개월
                {#if policy.knobs.reviewMonths[type] !== TEAM_POLICY_DEFAULTS.reviewMonths[type]}
                  <span class="tag accent">기본 {TEAM_POLICY_DEFAULTS.reviewMonths[type]}개월</span>
                {/if}
              </td>
            </tr>
          {/each}
          <tr>
            <th scope="row">초안 만료</th>
            <td>
              {policy.knobs.draftTtlDays}일
              {#if policy.knobs.draftTtlDays !== TEAM_POLICY_DEFAULTS.draftTtlDays}
                <span class="tag accent">기본 {TEAM_POLICY_DEFAULTS.draftTtlDays}일</span>
              {/if}
            </td>
          </tr>
          <tr>
            <th scope="row">1인당 열린 카드</th>
            <td>
              {policy.knobs.maxOpenProposals}개
              {#if policy.knobs.maxOpenProposals !== TEAM_POLICY_DEFAULTS.maxOpenProposals}
                <span class="tag accent">기본 {TEAM_POLICY_DEFAULTS.maxOpenProposals}개</span>
              {/if}
            </td>
          </tr>
        </tbody>
      </table>

      <span class="team-brain-admin-label">가이드라인</span>
      {#if guidelinesEmpty}
        <p class="muted">작성된 가이드라인이 없습니다.</p>
      {:else}
        <!-- Admin/avatar-written text: shown as TEXT, never rendered as markdown/HTML. -->
        <pre class="team-brain-policy-guidelines">{policy.guidelines}</pre>
      {/if}

      <span class="team-brain-admin-label">변경 이력</span>
      {#if policy.history.length}
        <ul class="team-brain-policy-history" aria-label="팀 정책 변경 이력">
          {#each policy.history as entry, i (i)}
            <li><span class="muted">{when(entry.at)} · {entry.by}</span> · {entry.title}</li>
          {/each}
        </ul>
      {:else}
        <p class="muted">변경 이력이 없습니다.</p>
      {/if}
    {:else if policyLoading}
      <p class="muted" role="status">팀 정책을 불러오는 중…</p>
    {/if}
    {#if policyError}
      <div class="team-brain-admin-actions">
        <p class="warn-box" role="alert">{policyError}</p>
        <button class="ghost-sm" type="button" disabled={policyLoading} on:click={loadPolicy}>다시 불러오기</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .team-brain-admin-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--s-3); margin-bottom: var(--s-4); }
  .team-brain-admin-hint { margin: 0 0 var(--s-4); padding: var(--s-2) var(--s-2-5); border: 1px solid var(--info-line); border-radius: var(--r-sm); background: var(--info-soft); color: var(--info); font-size: var(--t-xs); }
  .team-brain-admin-backlog { color: var(--warn); }
  .team-brain-admin-sub { margin: var(--s-2) 0 var(--s-1); font-size: var(--t-sm); }
  .team-brain-admin-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; margin-top: var(--s-2); }
  .team-brain-admin-label { display: block; margin: var(--s-3) 0 var(--s-1); color: var(--text-soft); font-size: var(--t-xs); font-weight: 600; }
  .team-brain-policy-note { margin: 0 0 var(--s-2); font-size: var(--t-xs); }
  .team-brain-policy-problems { margin: 0 0 var(--s-2); }
  .team-brain-policy-problems ul { margin: var(--s-1) 0 0; padding-left: var(--s-4); }
  .team-brain-policy-table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
  .team-brain-policy-table th,
  .team-brain-policy-table td { padding: var(--s-1-5) var(--s-2); border-bottom: 1px solid var(--line-soft); text-align: left; vertical-align: middle; }
  .team-brain-policy-table th { width: 50%; color: var(--text-soft); font-weight: 500; }
  .team-brain-policy-table td { font-variant-numeric: tabular-nums; }
  .team-brain-policy-table .tag { margin-left: var(--s-1-5); }
  .team-brain-policy-guidelines { margin: 0; max-height: 320px; overflow: auto; padding: var(--s-2) var(--s-2-5); border-radius: var(--r-sm); background: var(--bg-subtle); font-family: var(--font-mono); font-size: var(--t-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
  .team-brain-policy-history { margin: 0; padding-left: var(--s-4); font-size: var(--t-xs); display: flex; flex-direction: column; gap: var(--s-1); overflow-wrap: anywhere; }
</style>
