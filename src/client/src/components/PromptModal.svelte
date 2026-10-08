<script lang="ts">
  import { onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import { answerPrompt, humanTool, summarizeInput } from "../lib/chat";
  import { openModalFocus, trapTab } from "../lib/modalBehavior";
  import { appState } from "../lib/state";
  import type { PromptRequest } from "../lib/types";

  // When `paneId` is set the modal is scoped to one chat pane (rendered inside it
  // by ChatView): it shows only that pane's pending prompt and is positioned over
  // the pane, so in split chat the owner can see which session is asking. When it
  // is null the modal is the app-root fallback: it surfaces prompts whose pane is
  // NOT currently rendered as a chat pane (e.g. raised while the owner is on
  // explore/inbox/settings) so they never queue invisibly.
  export let paneId: string | null = null;

  $: visiblePaneIds =
    $appState.view === "chat" ? new Set($appState.chatPanes.map((p) => p.id)) : new Set<string>();
  $: request = paneId
    ? ($appState.promptQueue.find((p) => p.paneId === paneId) ?? null)
    : ($appState.promptQueue.find((p) => !visiblePaneIds.has(p.paneId)) ?? null);

  // Per-question answer state for the AskUserQuestion card, rebuilt whenever the
  // active request changes.
  let activeId = "";
  let selections: string[][] = [];
  let customOn: boolean[] = [];
  let customText: string[] = [];
  let busy = false;
  let error = "";

  $: questions = request?.kind === "question" && Array.isArray(request.data?.payload?.questions) ? request.data.payload.questions : null;
  $: promptBase = request ? String(request.id).replace(/[^A-Za-z0-9_-]/g, "-") : "current";
  $: permissionTitleId = `prompt-${promptBase}-permission-title`;
  $: permissionToolId = `prompt-${promptBase}-permission-tool`;
  $: permissionDescId = `prompt-${promptBase}-permission-desc`;
  $: permissionErrorId = `prompt-${promptBase}-permission-error`;
  $: permissionDescribedBy = joinIds(permissionToolId, request?.data?.description ? permissionDescId : null, error ? permissionErrorId : null);
  $: questionTitleId = `prompt-${promptBase}-question-title`;
  $: questionHintId = `prompt-${promptBase}-question-hint`;
  $: questionPayloadId = `prompt-${promptBase}-question-payload`;
  $: questionErrorId = `prompt-${promptBase}-question-error`;
  $: questionDescribedBy = joinIds(questions ? questionHintId : questionPayloadId, error ? questionErrorId : null);
  $: questionStates = questions
    ? questions.map((q: any, qi: number) => {
        // Touch the reactive deps INLINE — questionState reads them only in its
        // body, so without this the per-question status region never updates
        // (the same trap canSubmit avoids below).
        void selections[qi];
        void customOn[qi];
        void customText[qi];
        return questionState(q, qi);
      })
    : [];

  $: if (request && request.id !== activeId) {
    activeId = request.id;
    error = "";
    busy = false;
    const count = questions?.length ?? 0;
    selections = Array.from({ length: count }, () => []);
    customOn = Array.from({ length: count }, () => false);
    customText = Array.from({ length: count }, () => "");
  }

  $: permissionTitle = request?.kind === "permission"
    ? request.data?.title || `이 아바타가 "${humanTool(request.data?.toolName)}" 작업을 실행하려고 합니다.`
    : "";
  $: permissionArg = request?.kind === "permission" ? summarizeInput(request.data?.input) : "";

  function joinIds(...ids: Array<string | null | undefined | false>): string | undefined {
    const joined = ids.filter(Boolean).join(" ");
    return joined || undefined;
  }
  function questionId(base: string, qi: number, part: string): string {
    return `prompt-${base}-question-${qi}-${part}`;
  }
  function questionState(q: any, qi: number): string {
    const picked = selections[qi]?.length ?? 0;
    const customReady = customOn[qi] && customText[qi].trim().length > 0;
    if (!picked && !customReady) return "답변이 필요합니다.";
    if (q?.multiSelect) {
      const count = picked + (customReady ? 1 : 0);
      return `${count}개 답변이 선택되었습니다.`;
    }
    return "답변이 선택되었습니다.";
  }
  // Reference selections/customOn/customText directly so Svelte tracks them — a
  // call to answeredFor() alone hides those deps and leaves the submit button
  // stuck in its initial (disabled) state no matter what the user selects/types.
  $: canSubmit =
    !questions ||
    questions.every(
      (_: unknown, qi: number) => selections[qi]?.length > 0 || (customOn[qi] && customText[qi].trim().length > 0),
    );

  function toggleOption(qi: number, q: any, label: string) {
    if (q.multiSelect) {
      const idx = selections[qi].indexOf(label);
      if (idx >= 0) selections[qi].splice(idx, 1);
      else selections[qi].push(label);
    } else {
      selections[qi] = [label];
      customOn[qi] = false;
    }
    selections = [...selections];
    customOn = [...customOn];
  }

  function toggleCustom(qi: number, q: any) {
    customOn[qi] = !customOn[qi];
    if (customOn[qi] && !q.multiSelect) selections[qi] = [];
    customOn = [...customOn];
    selections = [...selections];
  }

  async function respond(value: unknown) {
    if (!request || busy) return;
    busy = true;
    error = "";
    try {
      await answerPrompt(request.id, value);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function submitQuestions() {
    if (!request || !questions || busy || !canSubmit) return;
    const answers: Record<string, string> = {};
    questions.forEach((q: any, qi: number) => {
      const vals = [...selections[qi]];
      if (customOn[qi] && customText[qi].trim()) vals.push(customText[qi].trim());
      answers[q.question || `q${qi}`] = vals.join(", ");
    });
    void respond({ result: { questions, answers } });
  }

  function cancel() {
    if (!request || busy) return;
    if (request.kind === "permission") void respond({ behavior: "deny" });
    else void respond({ cancelled: true });
  }

  /* ---- keyboard + focus management (shared with Modal via lib/modalBehavior) ----
     Only the app-root instance is a true modal dialog, so only it contains focus
     and inerts the page; a pane instance sits inside its chat pane and must
     leave the rest of the app reachable (see the aria-modal note below). */
  let backdropEl: HTMLDivElement | undefined;
  let cardEl: HTMLDivElement | undefined;
  let releaseFocus: (() => void) | null = null;
  let focusedCard: HTMLElement | null = null;
  let focusedRequestId: string | undefined;

  $: isRootModal = !paneId;
  $: if (isRootModal) syncModalFocus(backdropEl, cardEl, request?.id);

  function syncModalFocus(
    backdrop: HTMLElement | undefined,
    card: HTMLElement | undefined,
    requestId?: string,
  ): void {
    const target = backdrop && card ? card : null;
    // Key on the request too, not just the card element: a queued same-kind
    // prompt swaps `request` WITHOUT remounting the card, and answering the
    // previous one blurred focus to <body> (the button disables itself) — the
    // new prompt must re-arm initial focus on its safe action.
    if (target === focusedCard && requestId === focusedRequestId) return;
    releaseFocus?.();
    releaseFocus = null;
    focusedCard = target;
    focusedRequestId = requestId;
    // The autofocus target is the SAFE action (거부 / 건너뛰기): a permission gate
    // must never put approval under a stray Enter.
    if (target && backdrop) releaseFocus = openModalFocus(backdrop, target);
  }

  onDestroy(() => {
    releaseFocus?.();
    releaseFocus = null;
  });

  function onKeydown(event: KeyboardEvent): void {
    if (!request) return;
    if (event.key === "Escape") {
      // A permission gate must not be silently dismissible, so Escape maps to
      // the same SAFE decision as the 거부/건너뛰기 button rather than to a
      // no-answer close. A pane instance only answers for its own card so that
      // one Escape can't resolve several panes' prompts at once.
      if (!isRootModal && !cardEl?.contains(document.activeElement)) return;
      event.stopPropagation();
      cancel();
    } else if (event.key === "Tab" && isRootModal) {
      trapTab(event, cardEl);
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if request}
  <!-- No backdrop-click dismiss on purpose: this is a blocking gate, and a stray
       click outside must not answer for the owner. Escape maps to 거부/건너뛰기. -->
  <div bind:this={backdropEl} class="prompt-modal-backdrop" class:in-pane={!!paneId} role="presentation">
    {#if request.kind === "permission"}
      <!-- aria-modal only on the app-root fallback (paneId=null): an in-pane modal
           doesn't make the rest of the page inert, and several aria-modal="true"
           dialogs on screen at once (one per split pane) is invalid ARIA. -->
      <div
        bind:this={cardEl}
        class="prompt-card permission"
        role="dialog"
        aria-modal={paneId ? undefined : "true"}
        aria-labelledby={permissionTitleId}
        aria-describedby={permissionDescribedBy}
        aria-busy={busy}
      >
        <div class="prompt-head">
          <span class="prompt-icon"><Icon name="lock" /></span>
          <span class="prompt-head-label">권한 요청</span>
          <button class="msg-act prompt-close" type="button" aria-label="권한 요청 닫기" title="닫기" disabled={busy} on:click={cancel}><Icon name="close" /></button>
        </div>
        <div class="prompt-title" id={permissionTitleId}>{permissionTitle}</div>
        <div class="prompt-tool" id={permissionToolId}>
          <code>{request.data?.toolName || "도구"}</code>
          {#if permissionArg}<span class="prompt-arg">{permissionArg}</span>{/if}
        </div>
        {#if request.data?.description}<div class="prompt-desc" id={permissionDescId}>{request.data.description}</div>{/if}
        {#if error}<div class="error-note prompt-error" id={permissionErrorId} role="alert">{error}</div>{/if}
        <div class="prompt-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-modal-autofocus disabled={busy} on:click={cancel}>거부</button>
          <button class="btn btn-primary btn-sm" type="button" disabled={busy} on:click={() => respond({ behavior: "allow" })}>승인</button>
        </div>
      </div>
    {:else}
      <div
        bind:this={cardEl}
        class="prompt-card question"
        role="dialog"
        aria-modal={paneId ? undefined : "true"}
        aria-labelledby={questionTitleId}
        aria-describedby={questionDescribedBy}
        aria-busy={busy}
      >
        <div class="prompt-head">
          <span class="prompt-icon"><Icon name="chat" /></span>
          <span class="prompt-head-label" id={questionTitleId}>질문</span>
          <button class="msg-act prompt-close" type="button" aria-label="질문 닫기" title="닫기" disabled={busy} on:click={cancel}><Icon name="close" /></button>
        </div>
        {#if questions}
          <div class="sr-only" id={questionHintId}>모든 질문에 답하면 보낼 수 있습니다. 건너뛰기를 선택하면 요청이 취소됩니다.</div>
          {#each questions as q, qi}
            <div
              class="q-block"
              role="group"
              aria-labelledby={questionId(promptBase, qi, "text")}
              aria-describedby={questionId(promptBase, qi, "state")}
            >
              {#if q.header}<span class="q-chip">{q.header}</span>{/if}
              <div class="q-text" id={questionId(promptBase, qi, "text")}>{q.question || ""}</div>
              <div class="q-state sr-only" id={questionId(promptBase, qi, "state")} role="status" aria-live="polite">{questionStates[qi]}</div>
              <div class="q-options" role="group" aria-label={q.multiSelect ? "여러 개 선택 가능" : "하나 선택"}>
                {#each (q.options || []) as opt}
                  <button
                    class="q-option"
                    class:selected={selections[qi]?.includes(opt.label)}
                    type="button"
                    aria-pressed={selections[qi]?.includes(opt.label) ? "true" : "false"}
                    disabled={busy}
                    on:click={() => toggleOption(qi, q, opt.label)}
                  >
                    <span class="q-opt-label">{opt.label || ""}</span>
                    {#if opt.description}<span class="q-opt-desc">{opt.description}</span>{/if}
                  </button>
                {/each}
                <button
                  class="q-option q-option-custom"
                  class:selected={customOn[qi]}
                  type="button"
                  aria-pressed={customOn[qi] ? "true" : "false"}
                  disabled={busy}
                  on:click={() => toggleCustom(qi, q)}
                >
                  <span class="q-opt-label">직접 입력</span>
                </button>
              </div>
              {#if customOn[qi]}
                <textarea
                  class="q-custom-input"
                  rows="2"
                  placeholder="직접 답변을 입력하세요…"
                  aria-label={`${q.question || `질문 ${qi + 1}`} 직접 답변`}
                  bind:value={customText[qi]}
                  disabled={busy}
                ></textarea>
              {/if}
            </div>
          {/each}
        {:else}
          <pre class="prompt-input" id={questionPayloadId}>{JSON.stringify(request.data?.payload ?? request.data, null, 2)}</pre>
        {/if}
        {#if error}<div class="error-note prompt-error" id={questionErrorId} role="alert">{error}</div>{/if}
        <div class="prompt-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-modal-autofocus disabled={busy} on:click={cancel}>건너뛰기</button>
          {#if questions}
            <button class="btn btn-primary btn-sm" type="button" disabled={busy || !canSubmit} on:click={submitQuestions}>보내기</button>
          {:else}
            <button class="btn btn-primary btn-sm" type="button" disabled={busy} on:click={() => respond({ result: {} })}>확인</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}
