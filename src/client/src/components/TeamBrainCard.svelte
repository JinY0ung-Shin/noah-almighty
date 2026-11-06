<script lang="ts">
  // A team-brain confirmation card (a `kind:"team_brain"` attachment). The avatar
  // only DRAFTED it; this card is where a human decides. Its state is read LIVE
  // from the server (/api/team-brain/cards/:id) and every button re-checks there.
  import { onDestroy, onMount } from "svelte";
  import { api } from "../lib/api";
  import Icon from "./Icon.svelte";
  import type { TeamBrainCardView } from "../../../shared/teamBrain";
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

  // A pending proposal is decided elsewhere (an admin's conversation): re-read on return.
  function onVisible(): void {
    if (document.visibilityState === "visible" && view && (view.proposal.status === "pending" || view.proposal.status === "draft")) {
      void load();
    }
  }

  onMount(() => {
    void load();
    document.addEventListener("visibilitychange", onVisible);
  });
  onDestroy(() => document.removeEventListener("visibilitychange", onVisible));

  const KIND_LABEL = { propose: "팀 브레인 제안", direct: "팀 브레인 노트", review: "팀 브레인 검토" } as const;

  function statusText(v: TeamBrainCardView): { text: string; tone: "info" | "ok" | "warn" | "muted" } {
    const p = v.proposal;
    if (p.kind === "propose") {
      switch (p.status) {
        case "draft":
          return v.stale
            ? { text: "그 사이 노트가 바뀌어 제출할 수 없습니다. 아바타에게 다시 제안을 요청하세요.", tone: "warn" }
            : { text: "아직 공유되지 않았습니다. 내용을 확인하고 제출하세요.", tone: "info" };
        case "pending":
          return { text: "관리자의 검토를 기다리고 있습니다.", tone: "info" };
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
      if (v.stale) return { text: "그 사이 노트가 바뀌었습니다. 아바타에게 현재 노트에 맞춰 다시 정리해 달라고 요청하세요.", tone: "warn" };
      if (p.kind === "review" && v.target && v.target.status !== "pending") {
        return { text: "이 제안은 이미 처리되었거나 철회되었습니다.", tone: "muted" };
      }
      if (!v.actions.apply) return { text: "관리자만 반영할 수 있습니다.", tone: "warn" };
      return { text: p.kind === "review" ? "버튼을 눌러야 결정이 반영됩니다." : "버튼을 눌러야 팀 브레인에 저장됩니다.", tone: "info" };
    }
    if (p.status === "applied") {
      if (p.kind === "review") return { text: p.decision === "approve" ? "승인해서 팀 브레인에 반영했습니다." : "반려했습니다.", tone: "ok" };
      return { text: "팀 브레인에 저장했습니다.", tone: "ok" };
    }
    if (p.status === "expired") return { text: "누르지 않아 만료되었습니다.", tone: "muted" };
    return { text: "취소했습니다.", tone: "muted" };
  }

  function applyLabel(v: TeamBrainCardView): string {
    if (v.proposal.kind === "review") return v.proposal.decision === "approve" ? "승인 반영" : "반려 확정";
    return "팀 브레인에 반영";
  }

  $: status = view ? statusText(view) : null;
  $: showContent = Boolean(view && !(view.proposal.kind === "review" && view.proposal.decision === "reject"));
</script>

{#if gone}
  <div class="team-brain-card is-gone">
    <span class="team-brain-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
    <span class="team-brain-muted">이 팀 브레인 카드는 더 이상 없습니다.</span>
  </div>
{:else if !view}
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
  <section class="team-brain-card" aria-label={KIND_LABEL[view.proposal.kind]}>
    <header class="team-brain-head">
      <span class="team-brain-icon" aria-hidden="true"><Icon name="book" size={16} /></span>
      <div class="team-brain-title">
        <span class="team-brain-kind">
          {KIND_LABEL[view.proposal.kind]}{view.proposal.kind === "review" ? ` · ${view.proposal.decision === "approve" ? "승인" : "반려"}` : ""}
          · {view.proposal.op === "create" ? "새 노트" : "노트 수정"}
        </span>
        <strong class="team-brain-name">{view.proposal.title}</strong>
        <code class="team-brain-path">{view.proposal.path}</code>
      </div>
    </header>
    {#if view.proposal.kind === "review" && view.target}
      <p class="team-brain-summary">{view.target.proposerName || "팀원"}님의 제안{view.target.summary ? ` — ${view.target.summary}` : ""}</p>
    {:else if view.proposal.summary}
      <p class="team-brain-summary">{view.proposal.summary}</p>
    {/if}
    {#if view.proposal.kind === "review" && view.proposal.decision === "reject" && view.proposal.decisionReason}
      <p class="team-brain-summary">반려 사유: {view.proposal.decisionReason}</p>
    {/if}
    {#if showContent}
      <details class="team-brain-details">
        <summary>{view.proposal.kind === "review" ? "반영할 내용 보기" : "공유할 내용 보기"}</summary>
        <pre class="team-brain-pre">{view.proposal.content}</pre>
      </details>
      {#if view.proposal.op === "update" && view.currentContent !== null && view.proposal.status === "draft"}
        <details class="team-brain-details">
          <summary>현재 노트 보기</summary>
          <pre class="team-brain-pre">{view.currentContent}</pre>
        </details>
      {/if}
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
            {view.proposal.status === "pending" ? "제안 철회" : "취소"}
          </button>
        {/if}
        {#if view.actions.cancel}
          <button class="ghost-sm" type="button" disabled={busy} on:click={() => act("withdraw")}>취소</button>
        {/if}
      </div>
    {/if}
  </section>
{/if}
