<script lang="ts">
  // A team-brain confirmation card (a `kind:"team_brain"` attachment). The avatar
  // only DRAFTED it; this card is where a human decides. Its state is read LIVE
  // from the server (/api/team-brain/cards/:id) and every button re-checks there.
  //
  // Everything shown here is teammate- or model-written text: it is rendered as
  // TEXT only (`<pre>`, diff lines, list items) — never as markdown or HTML.
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api";
  import Icon from "./Icon.svelte";
  import type { TeamBrainCardView, TeamBrainIntake, TeamPageChangeView } from "../../../shared/teamBrain";
  import {
    TEAM_INTAKE_SLOTS,
    TEAM_INTAKE_SLOT_LABELS,
    TEAM_PAGE_TYPE_LABELS,
    isTeamIntakeUnknown,
  } from "../../../shared/teamBrain";
  import { collapseUnchanged, diffLines, type DiffHunkItem } from "../../../shared/lineDiff";
  import { refreshTeamBrainStatus } from "../lib/teamBrain";

  export let proposalId: string;

  let view: TeamBrainCardView | null = null;
  let loadError = "";
  let actionError = "";
  let busy = false;
  let gone = false;

  async function load(): Promise<void> {
    try {
      view = await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}`);
      loadError = "";
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) gone = true;
      else loadError = (err as Error).message;
    }
  }

  async function act(action: "submit" | "withdraw" | "apply"): Promise<void> {
    if (busy) return;
    busy = true;
    actionError = "";
    try {
      view = await api<TeamBrainCardView>(`/api/team-brain/cards/${encodeURIComponent(proposalId)}/${action}`, { method: "POST" });
      void refreshTeamBrainStatus();
    } catch (err) {
      actionError = (err as Error).message;
      await load();
    } finally {
      busy = false;
    }
  }

  // An open proposal is decided (or answered) elsewhere — an admin's conversation,
  // the proposer's avatar: re-read on return.
  function onVisible(): void {
    const s = view?.proposal.status;
    if (document.visibilityState === "visible" && (s === "pending" || s === "draft" || s === "needs_info")) {
      void load();
    }
  }

  onMount(() => {
    void load();
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => document.removeEventListener("visibilitychange", onVisible));

  const KIND_LABEL = { propose: "팀 브레인 제안", direct: "팀 브레인 변경", review: "팀 브레인 검토" } as const;
  const DECISION_LABEL = { approve: "승인", reject: "반려", ask: "보완 요청" } as const;

  type Tone = "info" | "ok" | "warn" | "muted";

  function statusText(v: TeamBrainCardView): { text: string; tone: Tone } {
    const p = v.proposal;
    if (p.kind === "propose") {
      switch (p.status) {
        case "draft":
          // Sources have no staleness; only a legacy note row the server refuses to submit can be stale.
          if (v.stale && !v.actions.submit) {
            return { text: "그 사이 노트가 바뀌어 제출할 수 없습니다. 아바타에게 다시 제안을 요청하세요.", tone: "warn" };
          }
          return p.intake && p.intake.followups.length
            ? { text: "답변을 반영했습니다. 다시 제출하세요.", tone: "info" }
            : { text: "아직 공유되지 않았습니다. 내용을 확인하고 제출하세요.", tone: "info" };
        case "pending":
          return { text: "관리자의 검토를 기다리고 있습니다.", tone: "info" };
        case "needs_info": {
          const q = (p.decisionReason ?? "").trim();
          const asked = q ? `: ${q}${/[.?!。？！]$/.test(q) ? "" : "."}` : ".";
          return { text: `관리자가 보완을 요청했습니다${asked} 아바타에게 답을 알려 주세요.`, tone: "warn" };
        }
        case "approved":
          return { text: `승인되어 팀 브레인에 반영되었습니다${p.decidedByName ? ` (${p.decidedByName})` : ""}.`, tone: "ok" };
        case "rejected":
          return { text: `반려되었습니다${p.decisionReason ? `: ${p.decisionReason}` : "."}`, tone: "warn" };
        case "withdrawn":
          return { text: "철회했습니다.", tone: "muted" };
        case "expired":
          return { text: "제출하지 않아 만료되었습니다.", tone: "muted" };
        default:
          return { text: "처리된 카드입니다.", tone: "muted" };
      }
    }
    if (p.status === "draft") {
      if (p.kind === "review" && v.target && v.target.status !== "pending") {
        return { text: "이 제안은 이미 처리되었거나 철회되었습니다.", tone: "muted" };
      }
      if (v.stale) {
        return { text: "그 사이 팀 브레인이 바뀌었습니다. 아바타에게 현재 내용에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" };
      }
      if (!v.actions.apply) return { text: "관리자만 반영할 수 있습니다.", tone: "warn" };
      if (p.kind === "review" && p.decision === "ask") return { text: "버튼을 눌러야 보완 요청이 제안자에게 전달됩니다.", tone: "info" };
      return { text: p.kind === "review" ? "버튼을 눌러야 결정이 반영됩니다." : "버튼을 눌러야 팀 브레인에 저장됩니다.", tone: "info" };
    }
    if (p.status === "applied") {
      if (p.kind === "review") {
        if (p.decision === "approve") return { text: "승인해서 팀 브레인에 반영했습니다.", tone: "ok" };
        if (p.decision === "ask") return { text: "보완 요청을 보냈습니다.", tone: "ok" };
        return { text: "반려했습니다.", tone: "ok" };
      }
      return { text: "팀 브레인에 저장했습니다.", tone: "ok" };
    }
    if (p.status === "expired") return { text: "누르지 않아 만료되었습니다.", tone: "muted" };
    // A review card is also cancelled by the server when another decision on the same proposal lands
    // or the proposal is withdrawn — so the wording does not claim the viewer pressed 취소.
    if (p.kind === "review") return { text: "취소되었습니다. 이 제안에 다른 결정이 반영되었거나 제안이 철회되었을 수 있습니다.", tone: "muted" };
    return { text: "취소했습니다.", tone: "muted" };
  }

  function applyLabel(v: TeamBrainCardView): string {
    if (v.proposal.kind === "review") {
      if (v.proposal.decision === "approve") return "승인 반영";
      if (v.proposal.decision === "ask") return "보완 요청 보내기";
      return "반려 확정";
    }
    return "팀 브레인에 반영";
  }

  function kindLine(v: TeamBrainCardView): string {
    const p = v.proposal;
    if (p.kind === "review") return `${KIND_LABEL.review} · ${DECISION_LABEL[p.decision ?? "reject"]}`;
    // Legacy single-note rows (no intake, no changeset) still read as a note write.
    if (p.kind === "propose" && !p.intake) return `${KIND_LABEL.propose} · ${p.op === "create" ? "새 노트" : "노트 수정"}`;
    return KIND_LABEL[p.kind];
  }

  /** "원본 1건 · 페이지 N개 (새 페이지 a · 수정 b)" — for changeset cards. */
  function changesetLine(pages: TeamPageChangeView[], hasSource: boolean): string {
    const creates = pages.filter((p) => p.op === "create").length;
    const updates = pages.length - creates;
    const parts = [creates ? `새 페이지 ${creates}` : "", updates ? `수정 ${updates}` : ""].filter(Boolean).join(" · ");
    return `${hasSource ? "원본 1건 · " : ""}페이지 ${pages.length}개${parts ? ` (${parts})` : ""}`;
  }

  interface IntakeRow {
    label: string;
    answer: string;
    unknown: boolean;
  }

  function intakeRows(intake: TeamBrainIntake): IntakeRow[] {
    const rows: IntakeRow[] = [];
    for (const slot of TEAM_INTAKE_SLOTS) {
      const answer = intake.answers[slot];
      if (typeof answer !== "string" || !answer.trim()) continue;
      rows.push({ label: TEAM_INTAKE_SLOT_LABELS[slot], answer, unknown: isTeamIntakeUnknown(answer) });
    }
    return rows;
  }

  function gapLabels(intake: TeamBrainIntake): string {
    return intake.gaps.map((slot) => TEAM_INTAKE_SLOT_LABELS[slot] ?? slot).join(", ");
  }

  interface PageDiff {
    items: DiffHunkItem[];
    added: number;
    removed: number;
    fallback: boolean;
  }

  function pageDiff(page: TeamPageChangeView): PageDiff | null {
    if (page.op !== "update" || page.before === null) return null;
    const d = diffLines(page.before, page.after);
    return { items: collapseUnchanged(d.lines, 3), added: d.added, removed: d.removed, fallback: d.fallback };
  }

  $: status = view ? statusText(view) : null;
  $: proposal = view?.proposal ?? null;
  $: isReview = proposal?.kind === "review";
  $: isChangesetCard = Boolean(proposal && (proposal.kind === "direct" || (proposal.kind === "review" && proposal.decision === "approve")));
  // The source being compiled: a review's target, or a direct card's own source (a maintenance changeset has none).
  $: source = !view || !proposal
    ? null
    : proposal.kind === "review"
      ? view.target && proposal.decision !== "reject"
        ? { content: view.target.content, intake: view.target.intake }
        : null
      : proposal.kind === "direct" && (proposal.intake || proposal.content)
        ? { content: proposal.content, intake: proposal.intake }
        : null;
  $: pages = view?.pages ?? [];
  $: diffs = pages.map(pageDiff);
  $: conflicts = proposal?.changeset?.conflicts ?? [];
</script>

{#snippet intakeBlock(intake: TeamBrainIntake)}
  {@const rows = intakeRows(intake)}
  {#if rows.length || intake.gaps.length}
    <div class="team-brain-intake">
      <span class="team-brain-section-label">보충 정보</span>
      {#if rows.length}
        <dl class="team-brain-intake-list">
          {#each rows as row (row.label)}
            <div class="team-brain-intake-row">
              <dt>{row.label}</dt>
              <dd>{#if row.unknown}<span class="tag team-brain-unknown">모름</span>{:else}{row.answer}{/if}</dd>
            </div>
          {/each}
        </dl>
      {/if}
      {#if intake.gaps.length}
        <p class="team-brain-gaps">아직 모르는 정보: {gapLabels(intake)}</p>
      {/if}
    </div>
  {/if}
  {#if intake.followups.length}
    <ol class="team-brain-followups" aria-label="보완 요청 기록">
      {#each intake.followups as round, i (i)}
        <li class="team-brain-followup">
          <span class="team-brain-section-label">보완 요청 {i + 1}</span>
          <p class="team-brain-qa"><span class="team-brain-qa-label">질문</span><span class="team-brain-qa-text">{round.questions}</span></p>
          <p class="team-brain-qa"><span class="team-brain-qa-label">답변</span><span class="team-brain-qa-text">{round.answer}</span></p>
        </li>
      {/each}
    </ol>
  {/if}
{/snippet}

{#if gone}
  <div class="team-brain-card is-gone">
    <span class="team-brain-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
    <span class="team-brain-muted">이 팀 브레인 카드는 더 이상 없습니다.</span>
  </div>
{:else if !view || !proposal}
  <div class="team-brain-card" aria-busy={!loadError}>
    <span class="team-brain-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
    {#if loadError}
      <span class="team-brain-muted">{loadError}</span>
      <button class="ghost-sm" type="button" on:click={load}>다시 불러오기</button>
    {:else}
      <span class="team-brain-muted">팀 브레인 카드를 불러오는 중…</span>
    {/if}
  </div>
{:else}
  <section class="team-brain-card" aria-label={KIND_LABEL[proposal.kind]}>
    <header class="team-brain-head">
      <span class="team-brain-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
      <div class="team-brain-title">
        <span class="team-brain-kind">
          {kindLine(view)}
          {#if proposal.kind === "propose" && proposal.intake?.type}
            <span class="tag accent team-brain-type">{TEAM_PAGE_TYPE_LABELS[proposal.intake.type]}</span>
          {/if}
        </span>
        <strong class="team-brain-name">{proposal.title}</strong>
        {#if isChangesetCard}
          <span class="team-brain-count">{changesetLine(pages, Boolean(source))}</span>
        {:else if proposal.path}
          <code class="team-brain-path">{proposal.path}</code>
        {/if}
      </div>
    </header>

    {#if isReview && view.target}
      <p class="team-brain-summary">{view.target.proposerName || "팀원"}님의 제안{view.target.summary ? ` — ${view.target.summary}` : ""}</p>
    {:else if proposal.summary}
      <p class="team-brain-summary">{proposal.summary}</p>
    {/if}

    {#if isReview && proposal.decision === "reject" && proposal.decisionReason}
      <p class="team-brain-summary">반려 사유: {proposal.decisionReason}</p>
    {/if}
    {#if isReview && proposal.decision === "ask"}
      <div class="team-brain-box team-brain-ask">
        <span class="team-brain-section-label">보완 요청</span>
        <p class="team-brain-box-text">{proposal.decisionReason ?? ""}</p>
      </div>
    {/if}

    {#if proposal.kind === "propose"}
      {#if proposal.intake}
        <details class="team-brain-details">
          <summary>원문 보기</summary>
          <pre class="team-brain-pre">{proposal.content}</pre>
        </details>
        {@render intakeBlock(proposal.intake)}
      {:else}
        <details class="team-brain-details">
          <summary>제안 내용 보기</summary>
          <pre class="team-brain-pre">{proposal.content}</pre>
        </details>
      {/if}
    {/if}

    {#if source}
      <details class="team-brain-details">
        <summary>원본 보기</summary>
        <pre class="team-brain-pre">{source.content}</pre>
        {#if source.intake}{@render intakeBlock(source.intake)}{/if}
      </details>
    {/if}

    {#if isChangesetCard && conflicts.length}
      <div class="team-brain-box team-brain-conflicts" role="note">
        <span class="team-brain-section-label">확인이 필요한 충돌</span>
        <ul>
          {#each conflicts as conflict, i (i)}
            <li>{conflict}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if isChangesetCard && pages.length}
      <ul class="team-brain-pages" aria-label="바뀌는 페이지">
        {#each pages as page, i (page.path)}
          {@const diff = diffs[i]}
          <li class="team-brain-page" class:is-stale={page.stale}>
            <div class="team-brain-page-top">
              <span class={`tag ${page.op === "create" ? "ok" : "write"}`}>{page.op === "create" ? "새 페이지" : "수정"}</span>
              {#if page.type}<span class="tag">{TEAM_PAGE_TYPE_LABELS[page.type]}</span>{/if}
              {#if diff && diff.removed > 0}<span class="tag danger">삭제 {diff.removed}줄</span>{/if}
              <strong class="team-brain-page-title">{page.title || page.path}</strong>
            </div>
            <code class="team-brain-path">{page.path}</code>
            {#if page.stale}
              <p class="team-brain-page-stale">
                {page.op === "create" ? "그 사이 같은 경로에 페이지가 생겼습니다." : "그 사이 이 페이지가 바뀌었습니다."}
              </p>
            {/if}
            <details class="team-brain-details">
              <summary>
                변경 보기{#if diff}{" "}<span class="team-brain-diff-stat">(+{diff.added} −{diff.removed})</span>{/if}
              </summary>
              {#if diff}
                {#if diff.fallback}
                  <p class="team-brain-hint">변경이 커서 이전 내용 전체와 새 내용 전체를 보여 줍니다.</p>
                {/if}
                <div class="team-brain-diff" role="group" aria-label={`${page.path} 변경 내용`}>
                  {#each diff.items as item, k (k)}
                    {#if item.kind === "skip"}
                      <div class="team-brain-diff-skip">… 변경 없는 {item.count}줄 …</div>
                    {:else if item.kind === "del"}
                      <del class="team-brain-diff-line is-del"><span class="team-brain-diff-sign" aria-hidden="true">−</span>{item.text}</del>
                    {:else if item.kind === "add"}
                      <ins class="team-brain-diff-line is-add"><span class="team-brain-diff-sign" aria-hidden="true">+</span>{item.text}</ins>
                    {:else}
                      <div class="team-brain-diff-line"><span class="team-brain-diff-sign" aria-hidden="true"> </span>{item.text}</div>
                    {/if}
                  {/each}
                </div>
              {:else}
                <!-- The server sends `before` only while the card is a draft: after apply the page IS `after`. -->
                {#if page.op === "update" && proposal.status === "draft"}
                  <p class="team-brain-hint">현재 페이지를 찾을 수 없어 새 내용만 보여 줍니다.</p>
                {/if}
                <pre class="team-brain-pre">{page.after}</pre>
              {/if}
            </details>
          </li>
        {/each}
      </ul>
    {/if}

    {#if status}
      <p class={`team-brain-status tone-${status.tone}`} role="status">{status.text}</p>
    {/if}
    {#if actionError}
      <p class="team-brain-status tone-warn" role="alert">{actionError}</p>
    {/if}
    {#if view.actions.submit || view.actions.withdraw || view.actions.apply || view.actions.cancel}
      <div class="team-brain-actions">
        {#if view.actions.submit}
          <button class="primary" type="button" disabled={busy} on:click={() => act("submit")}>관리자에게 제출</button>
        {/if}
        {#if view.actions.apply}
          <button class="primary" type="button" disabled={busy} on:click={() => act("apply")}>{applyLabel(view)}</button>
        {/if}
        {#if view.actions.withdraw}
          <button class="ghost-sm" type="button" disabled={busy} on:click={() => act("withdraw")}>
            {proposal.status === "draft" ? "취소" : "제안 철회"}
          </button>
        {/if}
        {#if view.actions.cancel}
          <button class="ghost-sm" type="button" disabled={busy} on:click={() => act("withdraw")}>취소</button>
        {/if}
      </div>
    {/if}
  </section>
{/if}
