<script lang="ts">
  // One routine "run" rendered as a collapsible <details>: a header (run number,
  // outcome chip, relative timestamp), an optional per-run prompt (when it
  // differs from the routine's current prompt), and the result message(s).
  //
  // The header states the OUTCOME, not just an index — scanning a run history is
  // about finding the run that went wrong, and "실행 #7" alone can't answer that.
  import { enhanceMarkdown } from "../lib/dom";
  import { relativeDayTimeLabel, renderMarkdown, timeLabel } from "../lib/format";
  import { appState } from "../lib/state";
  import type { StoredMessage } from "../lib/types";

  export let run: { prompt: StoredMessage | null; responses: StoredMessage[]; at: string | null };
  export let runNumber: number;
  export let expanded = false;
  export let currentPrompt = "";
  export let onRun: (() => void) | null = null;
  export let runBusy = false;
  /** Reference instant for relative labels; injected so the whole pane agrees. */
  export let now: Date = new Date();

  $: time = run.at ? relativeDayTimeLabel(run.at, now) : "";
  $: runPrompt = (run.prompt?.content || "").trim();
  $: showRunPrompt = Boolean(runPrompt) && runPrompt !== currentPrompt;
  $: authorName = $appState.user?.displayName || "아바타";
  $: failed = run.responses.some((m) => isErrored(m));
  $: outcome = !run.responses.length ? "결과 없음" : failed ? "실패" : "성공";
  $: outcomeKind = !run.responses.length ? "idle" : failed ? "err" : "ok";

  function assistantText(message: StoredMessage): string {
    return message.response?.text || message.response?.summary || message.content;
  }
  function isErrored(message: StoredMessage): boolean {
    return (message as { errored?: boolean }).errored === true || message.response?.summary === "오류" || message.response?.summary === "중지됨";
  }
  // runtime only says "local" vs a real model; error/blocked/stopped surface via summary.
  function runtimeBadge(message: StoredMessage): string | null {
    if (message.response?.runtime === "local") return "로컬";
    const summary = message.response?.summary;
    if (summary === "오류" || summary === "차단됨" || summary === "중지됨") return summary;
    return null;
  }
</script>

<details class="routine-run-block" class:failed open={expanded}>
  <summary class="routine-run-summary">
    <span class="routine-run-chevron" aria-hidden="true"></span>
    <span class={`routine-mark ${outcomeKind}`} aria-hidden="true"></span>
    <span class="routine-run-num">실행 #{runNumber}</span>
    <span class="routine-run-outcome">{outcome}</span>
    {#if time}<span class="routine-run-time muted">{time}</span>{/if}
  </summary>
  <div class="routine-run-body">
    {#if showRunPrompt}
      <div class="routine-run-prompt-label muted">이때의 지시</div>
      <div class="routine-run-prompt md" use:enhanceMarkdown={runPrompt}>{@html renderMarkdown(runPrompt)}</div>
    {/if}
    {#if run.responses.length}
      {#each run.responses as message (message.id)}
        {@const isUser = message.role === "user"}
        <div class={`message ${message.role}`}>
          <div class="msg-role">
            <span class="role-dot"></span>
            <span>{isUser ? "예약 작업 지시" : authorName}</span>
            {#if message.createdAt}<time class="msg-time" datetime={message.createdAt}>{timeLabel(message.createdAt)}</time>{/if}
          </div>
          {#if isUser}
            <div class="bubble"><p>{message.content}</p></div>
          {:else}
            <div class={`bubble ${isErrored(message) ? "errored" : ""}`}>
              {#if runtimeBadge(message)}
                <div class="response-meta"><span class="meta-badge">{runtimeBadge(message)}</span></div>
              {/if}
              <div class="md" use:enhanceMarkdown={assistantText(message)}>{@html renderMarkdown(assistantText(message))}</div>
            </div>
          {/if}
        </div>
      {/each}
    {:else}
      <div class="routine-run-empty">
        이 실행에는 결과 메시지가 없습니다.
        {#if onRun}<button class="linkish small" type="button" disabled={runBusy} on:click={onRun}>{runBusy ? "실행 중…" : "다시 실행"}</button>{/if}
      </div>
    {/if}
  </div>
</details>
