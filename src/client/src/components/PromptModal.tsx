import { useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { answerPrompt } from "../lib/chat";
import { cx, useAppState, useWindowEvent } from "../lib/hooks";
import { isTopDialogLayer, openModalFocus, trapTab } from "../lib/modalBehavior";

export interface PromptModalProps {
  // When `paneId` is set the modal is scoped to one chat pane (rendered inside it
  // by ChatView): it shows only that pane's pending prompt and is positioned over
  // the pane, so in split chat the owner can see which session is asking. When it
  // is null the modal is the app-root fallback: it surfaces prompts whose pane is
  // NOT currently rendered as a chat pane (e.g. raised while the owner is on
  // explore/inbox/settings) so they never queue invisibly.
  paneId?: string | null;
}

function joinIds(...ids: Array<string | null | undefined | false>): string | undefined {
  const joined = ids.filter(Boolean).join(" ");
  return joined || undefined;
}
function questionId(base: string, qi: number, part: string): string {
  return `prompt-${base}-question-${qi}-${part}`;
}

export default function PromptModal({ paneId = null }: PromptModalProps) {
  const state = useAppState();

  const visiblePaneIds = state.view === "chat" ? new Set(state.chatPanes.map((p) => p.id)) : new Set<string>();
  const request = paneId
    ? (state.promptQueue.find((p) => p.paneId === paneId) ?? null)
    : (state.promptQueue.find((p) => !visiblePaneIds.has(p.paneId)) ?? null);

  // Per-question answer state for the AskUserQuestion card, rebuilt whenever the
  // active request changes.
  const [activeId, setActiveId] = useState("");
  const [selectionsState, setSelections] = useState<string[][]>([]);
  const [customOnState, setCustomOn] = useState<boolean[]>([]);
  const [customTextState, setCustomText] = useState<string[]>([]);
  const [busyState, setBusyState] = useState(false);
  const [errorState, setError] = useState("");
  // `busy` is shown AND guards re-entry from handlers that can fire twice
  // before a re-render (two Escape presses), so it is kept in a ref as well.
  const busyRef = useRef(false);

  const questions: any[] | null =
    request?.kind === "question" && Array.isArray(request.data?.payload?.questions) ? request.data.payload.questions : null;

  let selections = selectionsState;
  let customOn = customOnState;
  let customText = customTextState;
  let busy = busyState;
  let error = errorState;
  if (request && request.id !== activeId) {
    setActiveId(request.id);
    error = "";
    busy = false;
    const count = questions?.length ?? 0;
    selections = Array.from({ length: count }, () => []);
    customOn = Array.from({ length: count }, () => false);
    customText = Array.from({ length: count }, () => "");
    setError(error);
    setBusyState(busy);
    setSelections(selections);
    setCustomOn(customOn);
    setCustomText(customText);
  }

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }
  // The reset above clears `busy` for a new request; the ref follows what was rendered.
  useLayoutEffect(() => {
    busyRef.current = busy;
  });

  const promptBase = request ? String(request.id).replace(/[^A-Za-z0-9_-]/g, "-") : "current";
  const questionTitleId = `prompt-${promptBase}-question-title`;
  const questionHintId = `prompt-${promptBase}-question-hint`;
  const questionPayloadId = `prompt-${promptBase}-question-payload`;
  const questionErrorId = `prompt-${promptBase}-question-error`;
  const questionDescribedBy = joinIds(questions ? questionHintId : questionPayloadId, error ? questionErrorId : null);

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
  const questionStates = questions ? questions.map((q: any, qi: number) => questionState(q, qi)) : [];
  const canSubmit =
    !questions ||
    questions.every(
      (_: unknown, qi: number) => selections[qi]?.length > 0 || (customOn[qi] && customText[qi].trim().length > 0),
    );

  function toggleOption(qi: number, q: any, label: string) {
    const nextSelections = selections.map((picked) => [...picked]);
    const nextCustomOn = [...customOn];
    if (q.multiSelect) {
      const idx = nextSelections[qi].indexOf(label);
      if (idx >= 0) nextSelections[qi].splice(idx, 1);
      else nextSelections[qi].push(label);
    } else {
      nextSelections[qi] = [label];
      nextCustomOn[qi] = false;
    }
    setSelections(nextSelections);
    setCustomOn(nextCustomOn);
  }

  function toggleCustom(qi: number, q: any) {
    const nextSelections = selections.map((picked) => [...picked]);
    const nextCustomOn = [...customOn];
    nextCustomOn[qi] = !nextCustomOn[qi];
    if (nextCustomOn[qi] && !q.multiSelect) nextSelections[qi] = [];
    setCustomOn(nextCustomOn);
    setSelections(nextSelections);
  }

  async function respond(value: unknown) {
    if (!request || busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      await answerPrompt(request.id, value);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submitQuestions() {
    if (!request || !questions || busyRef.current || !canSubmit) return;
    const answers: Record<string, string> = {};
    questions.forEach((q: any, qi: number) => {
      const vals = [...selections[qi]];
      if (customOn[qi] && customText[qi].trim()) vals.push(customText[qi].trim());
      answers[q.question || `q${qi}`] = vals.join(", ");
    });
    void respond({ result: { questions, answers } });
  }

  function cancel() {
    if (!request || busyRef.current) return;
    void respond({ cancelled: true });
  }

  /* ---- keyboard + focus management (shared with Modal via lib/modalBehavior) ----
     Only the app-root instance is a true modal dialog, so only it contains focus
     and inerts the page; a pane instance sits inside its chat pane and must
     leave the rest of the app reachable (see the aria-modal note below). */
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const releaseFocus = useRef<(() => void) | null>(null);
  const focusedCard = useRef<HTMLElement | null>(null);
  const focusedRequestId = useRef<string | undefined>(undefined);

  const isRootModal = !paneId;

  function syncModalFocus(backdrop: HTMLElement | null, card: HTMLElement | null, requestId?: string): void {
    const target = backdrop && card ? card : null;
    // Key on the request too, not just the card element: a queued same-kind
    // prompt swaps `request` WITHOUT remounting the card, and answering the
    // previous one blurred focus to <body> (the button disables itself) — the
    // new prompt must re-arm initial focus on its safe action.
    if (target === focusedCard.current && requestId === focusedRequestId.current) return;
    releaseFocus.current?.();
    releaseFocus.current = null;
    focusedCard.current = target;
    focusedRequestId.current = requestId;
    // The autofocus target is the SAFE action (건너뛰기): a stray Enter must
    // never answer for the owner.
    if (target && backdrop) releaseFocus.current = openModalFocus(backdrop, target);
  }

  // After every commit (guarded above, so it acts only when the card or the
  // request changed). The release-then-reopen of a request swap must happen
  // HERE and not in an effect cleanup: React puts focus back on the element
  // that had it before the commit when a cleanup moves it, so the reopened
  // dialog would remember its own button as the place to return focus to.
  useLayoutEffect(() => {
    if (isRootModal) syncModalFocus(backdropRef.current, cardRef.current, request?.id);
  });

  useLayoutEffect(
    () => () => {
      releaseFocus.current?.();
      releaseFocus.current = null;
      // Forget what was focused, so effects that are run again on the same
      // instance (a dev hot update) open the dialog's focus handling again.
      focusedCard.current = null;
      focusedRequestId.current = undefined;
    },
    [],
  );

  function onKeydown(event: KeyboardEvent): void {
    if (!request) return;
    // The root prompt is a dialog layer: one opened over it takes the keys first.
    if (isRootModal && !isTopDialogLayer(backdropRef.current)) return;
    if (event.key === "Escape") {
      // A question must not be silently dismissible, so Escape maps to the same
      // SAFE decision as the 건너뛰기 button rather than to a no-answer close.
      // A pane instance only answers for its own card so that one Escape can't
      // resolve several panes' prompts at once.
      if (!isRootModal && !cardRef.current?.contains(document.activeElement)) return;
      event.stopPropagation();
      cancel();
    } else if (event.key === "Tab" && isRootModal) {
      trapTab(event, cardRef.current);
    }
  }

  useWindowEvent("keydown", onKeydown);

  if (!request) return null;

  return (
    // No backdrop-click dismiss on purpose: this is a blocking gate, and a stray
    // click outside must not answer for the owner. Escape maps to 건너뛰기.
    <div ref={backdropRef} className={cx("prompt-modal-backdrop", !!paneId && "in-pane")} role="presentation">
      {/* aria-modal only on the app-root fallback (paneId=null): an in-pane modal
          doesn't make the rest of the page inert, and several aria-modal="true"
          dialogs on screen at once (one per split pane) is invalid ARIA. */}
      <div
        ref={cardRef}
        className="prompt-card question"
        role="dialog"
        aria-modal={paneId ? undefined : "true"}
        aria-labelledby={questionTitleId}
        aria-describedby={questionDescribedBy}
        aria-busy={busy}
      >
        <div className="prompt-head">
          <span className="prompt-icon">
            <Icon name="chat" />
          </span>
          <span className="prompt-head-label" id={questionTitleId}>
            질문
          </span>
          <button className="msg-act prompt-close" type="button" aria-label="질문 닫기" title="닫기" disabled={busy} onClick={cancel}>
            <Icon name="close" />
          </button>
        </div>
        {questions ? (
          <>
            <div className="sr-only" id={questionHintId}>
              모든 질문에 답하면 보낼 수 있습니다. 건너뛰기를 선택하면 요청이 취소됩니다.
            </div>
            {questions.map((q: any, qi: number) => (
              <div
                key={qi}
                className="q-block"
                role="group"
                aria-labelledby={questionId(promptBase, qi, "text")}
                aria-describedby={questionId(promptBase, qi, "state")}
              >
                {q.header ? <span className="q-chip">{q.header}</span> : null}
                <div className="q-text" id={questionId(promptBase, qi, "text")}>
                  {q.question || ""}
                </div>
                <div className="q-state sr-only" id={questionId(promptBase, qi, "state")} role="status" aria-live="polite">
                  {questionStates[qi]}
                </div>
                <div className="q-options" role="group" aria-label={q.multiSelect ? "여러 개 선택 가능" : "하나 선택"}>
                  {(q.options || []).map((opt: any, oi: number) => (
                    <button
                      key={oi}
                      className={cx("q-option", selections[qi]?.includes(opt.label) && "selected")}
                      type="button"
                      aria-pressed={selections[qi]?.includes(opt.label) ? "true" : "false"}
                      disabled={busy}
                      onClick={() => toggleOption(qi, q, opt.label)}
                    >
                      <span className="q-opt-label">{opt.label || ""}</span>
                      {opt.description ? <span className="q-opt-desc">{opt.description}</span> : null}
                    </button>
                  ))}
                  <button
                    className={cx("q-option q-option-custom", customOn[qi] && "selected")}
                    type="button"
                    aria-pressed={customOn[qi] ? "true" : "false"}
                    disabled={busy}
                    onClick={() => toggleCustom(qi, q)}
                  >
                    <span className="q-opt-label">직접 입력</span>
                  </button>
                </div>
                {customOn[qi] ? (
                  <textarea
                    className="q-custom-input"
                    rows={2}
                    placeholder="직접 답변을 입력하세요…"
                    aria-label={`${q.question || `질문 ${qi + 1}`} 직접 답변`}
                    value={customText[qi] ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setCustomText((previous) => previous.map((text, index) => (index === qi ? value : text)));
                    }}
                    disabled={busy}
                  ></textarea>
                ) : null}
              </div>
            ))}
          </>
        ) : (
          <pre className="prompt-input" id={questionPayloadId}>
            {JSON.stringify(request.data?.payload ?? request.data, null, 2)}
          </pre>
        )}
        {error ? (
          <div className="error-note prompt-error" id={questionErrorId} role="alert">
            {error}
          </div>
        ) : null}
        <div className="prompt-actions">
          <button className="btn btn-ghost btn-sm" type="button" data-modal-autofocus="" disabled={busy} onClick={cancel}>
            건너뛰기
          </button>
          {questions ? (
            <button className="btn btn-primary btn-sm" type="button" disabled={busy || !canSubmit} onClick={submitQuestions}>
              보내기
            </button>
          ) : (
            <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={() => void respond({ result: {} })}>
              확인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
