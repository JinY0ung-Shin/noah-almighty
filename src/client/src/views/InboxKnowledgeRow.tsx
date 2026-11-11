import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { timeLabel } from "../lib/format";
import { api } from "../lib/api";
import { cx } from "../lib/hooks";
import { notify, readState } from "../lib/state";
import { recordKnowledgeViaAvatar } from "../lib/knowledge";
import type { KnowledgeRequest } from "../lib/types";

export interface InboxKnowledgeRowProps {
  request: KnowledgeRequest;
  // Re-render the inbox after a record/ignore so the resolved row drops out.
  refresh: () => Promise<void>;
}

export default function InboxKnowledgeRow({ request, refresh }: InboxKnowledgeRowProps) {
  const [showCompose, setShowCompose] = useState(false);
  const [answer, setAnswer] = useState("");
  // Each in-flight flag is rendered (state) and read by the re-entry guards (ref).
  const [busy, setBusyState] = useState(false); // record in flight
  const busyRef = useRef(false);
  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }
  const [ignoring, setIgnoringState] = useState(false);
  const ignoringRef = useRef(false);
  function setIgnoring(next: boolean): void {
    ignoringRef.current = next;
    setIgnoringState(next);
  }
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const disabled = busy || ignoring;
  const answerTrimmed = answer.trim();
  const canSubmitAnswer = Boolean(!disabled && answerTrimmed);
  const rowBase = request.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const questionId = `knowledge-request-question-${rowBase}`;
  const statusId = `knowledge-request-status-${rowBase}`;
  const composeId = `knowledge-request-compose-${rowBase}`;
  const rowStatus = ignoring
    ? "정보 요청을 무시하는 중입니다."
    : busy
      ? "답변을 지식 저장소에 기록 요청하는 중입니다."
      : showCompose
        ? answerTrimmed
          ? "답변을 기록 요청할 수 있습니다."
          : "답변을 입력해 주세요."
        : "정보 추가를 누르면 답변 입력창이 열립니다.";

  function toggleCompose() {
    const next = !showCompose;
    flushSync(() => setShowCompose(next));
    if (next) {
      // focus once the textarea is rendered
      textarea.current?.focus();
    }
  }

  function cancelCompose() {
    setShowCompose(false);
  }

  async function ignore() {
    if (busyRef.current || ignoringRef.current) return;
    setIgnoring(true);
    // Single try/finally so `ignoring` always resets (the success path relied on
    // the row unmounting, which isn't guaranteed if the refresh returns it).
    try {
      await api(`/api/me/knowledge/requests/${encodeURIComponent(request.id)}`, { method: "DELETE" });
      await refresh();
      notify("정보 요청을 무시했습니다.", "ok");
    } catch (e) {
      notify(`무시 처리에 실패했거나 목록 새로고침에 실패했습니다: ${(e as Error).message}`);
    } finally {
      setIgnoring(false);
    }
  }

  async function submit() {
    const text = answerTrimmed;
    if (!text) {
      textarea.current?.focus();
      notify("기록할 답변을 입력해 주세요.", "warn");
      return;
    }
    if (busyRef.current || ignoringRef.current) return;
    setBusy(true);
    // try/finally so busy ALWAYS resets — the stillOpen branch keeps this row
    // rendered, so a success path that forgot to reset locked every button at
    // "기록 중…" until remount.
    try {
      const result = await recordKnowledgeViaAvatar(request, text);
      if (!result.ok) {
        notify(`기록 요청 실패: ${result.error}`);
        return;
      }
      // The avatar resolves the request itself after committing; a refresh then
      // drops this row out. If it's still open afterward the recording didn't
      // complete — say so honestly instead of claiming success.
      try {
        await refresh();
      } catch (e) {
        notify(`기록은 요청했지만 목록 새로고침에 실패했어요: ${(e as Error).message}`, "warn");
        return;
      }
      const stillOpen = readState().knowledgeRequests.some((x) => x.id === request.id && x.status === "open");
      notify(
        stillOpen
          ? "아바타가 기록을 완료하지 못한 것 같아요. ‘대화’의 ‘지식 기록’ 대화를 확인해 주세요."
          : "아바타가 답을 지식 저장소에 기록했어요.",
        stillOpen ? "warn" : "info",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="knowledge-row" aria-busy={disabled ? "true" : "false"} aria-describedby={statusId}>
      <div className="inbox-row-head">
        <span className="inbox-chip req">정보 요청</span>
      </div>
      <div className="kr-q" id={questionId}>
        {request.question}
      </div>
      <div className="muted kr-meta">
        {request.askerName
          ? `질문자: ${request.askerName} · ${timeLabel(request.createdAt)}`
          : timeLabel(request.createdAt)}
      </div>
      <div className="sr-only" id={statusId} role="status" aria-live="polite">
        {rowStatus}
      </div>
      <div className="kr-actions">
        <button
          className={cx("primary small", showCompose && "active")}
          type="button"
          aria-expanded={showCompose ? "true" : "false"}
          aria-controls={composeId}
          aria-describedby={statusId}
          title="답변 입력창 열기"
          disabled={disabled}
          onClick={toggleCompose}
        >
          정보 추가
        </button>
        <button className="ghost-sm" type="button" aria-describedby={statusId} disabled={disabled} onClick={() => void ignore()}>
          {ignoring ? "무시 중…" : "무시"}
        </button>
      </div>
      {showCompose ? (
        <div id={composeId} className="kr-compose" role="region" aria-labelledby={questionId} aria-describedby={statusId}>
          <textarea
            className="kr-answer"
            rows={3}
            ref={textarea}
            value={answer}
            onChange={(event) => setAnswer(event.currentTarget.value)}
            disabled={disabled}
            placeholder="이 질문에 대한 답·정보를 적어 주세요. 아바타가 지식 저장소에 기록하고 이 요청을 닫습니다"
            aria-label="정보 요청 답변"
            aria-describedby={statusId}
          ></textarea>
          <div className="kr-compose-actions">
            <button
              className="primary small"
              type="button"
              aria-describedby={statusId}
              disabled={!canSubmitAnswer}
              onClick={() => void submit()}
            >
              {busy ? "기록 중…" : "기록 요청"}
            </button>
            <button className="ghost-sm" type="button" disabled={disabled} onClick={cancelCompose}>
              취소
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
