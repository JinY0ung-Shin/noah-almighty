// One routine "run" rendered as a collapsible <details>: a header (run number,
// outcome chip, relative timestamp), an optional per-run prompt (when it
// differs from the routine's current prompt), and the result message(s).
//
// The header states the OUTCOME, not just an index — scanning a run history is
// about finding the run that went wrong, and "실행 #7" alone can't answer that.
import { useMemo, useState } from "react";
import { enhanceMarkdown } from "../lib/dom";
import { relativeDayTimeLabel, renderMarkdown, timeLabel } from "../lib/format";
import { cx, useAction, useAppState } from "../lib/hooks";
import type { StoredMessage } from "../lib/types";

export interface RoutineRunBlockProps {
  run: { prompt: StoredMessage | null; responses: StoredMessage[]; at: string | null };
  runNumber: number;
  expanded?: boolean;
  currentPrompt?: string;
  onRun?: (() => void) | null;
  runBusy?: boolean;
  /** Reference instant for relative labels; injected so the whole pane agrees. */
  now?: Date;
}

/**
 * A box of rendered Markdown: the sanitized html of `source`, enhanced
 * (`enhanceMarkdown`) once it is in the DOM and again whenever the source
 * changes. Its own component because the action is a hook and the boxes sit
 * inside conditionals and lists; the html is rendered once per source text, as
 * it was before (not on every store publication). Shared by the routine
 * screens (RoutinesView, RoutineModal).
 */
export function RoutineMarkdown({ className, source }: { className: string; source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className} ref={useAction(enhanceMarkdown, source)} dangerouslySetInnerHTML={{ __html: html }} />;
}

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

export default function RoutineRunBlock({
  run,
  runNumber,
  expanded = false,
  currentPrompt = "",
  onRun = null,
  runBusy = false,
  now: nowProp,
}: RoutineRunBlockProps) {
  const state = useAppState();
  // The default is taken once per block, as a prop default was.
  const [defaultNow] = useState(() => new Date());
  const now = nowProp ?? defaultNow;

  const time = run.at ? relativeDayTimeLabel(run.at, now) : "";
  const runPrompt = (run.prompt?.content || "").trim();
  const showRunPrompt = Boolean(runPrompt) && runPrompt !== currentPrompt;
  const authorName = state.user?.displayName || "아바타";
  const failed = run.responses.some((m) => isErrored(m));
  const outcome = !run.responses.length ? "결과 없음" : failed ? "실패" : "성공";
  const outcomeKind = !run.responses.length ? "idle" : failed ? "err" : "ok";

  return (
    <details className={cx("routine-run-block", failed && "failed")} open={expanded}>
      <summary className="routine-run-summary">
        <span className="routine-run-chevron" aria-hidden="true"></span>{" "}
        <span className={`routine-mark ${outcomeKind}`} aria-hidden="true"></span>{" "}
        <span className="routine-run-num">실행 #{runNumber}</span>{" "}
        <span className="routine-run-outcome">{outcome}</span>{" "}
        {time ? <span className="routine-run-time muted">{time}</span> : null}
      </summary>
      <div className="routine-run-body">
        {showRunPrompt && (
          <>
            <div className="routine-run-prompt-label muted">이때의 지시</div>
            <RoutineMarkdown className="routine-run-prompt md" source={runPrompt} />
          </>
        )}
        {run.responses.length ? (
          run.responses.map((message) => {
            const isUser = message.role === "user";
            const badge = runtimeBadge(message);
            return (
              <div key={message.id} className={`message ${message.role}`}>
                <div className="msg-role">
                  <span className="role-dot"></span> <span>{isUser ? "예약 작업 지시" : authorName}</span>{" "}
                  {message.createdAt ? (
                    <time className="msg-time" dateTime={message.createdAt}>
                      {timeLabel(message.createdAt)}
                    </time>
                  ) : null}
                </div>
                {isUser ? (
                  <div className="bubble">
                    <p>{message.content}</p>
                  </div>
                ) : (
                  <div className={`bubble ${isErrored(message) ? "errored" : ""}`}>
                    {badge && (
                      <div className="response-meta">
                        <span className="meta-badge">{badge}</span>
                      </div>
                    )}
                    <RoutineMarkdown className="md" source={assistantText(message)} />
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="routine-run-empty">
            이 실행에는 결과 메시지가 없습니다.{" "}
            {onRun ? (
              <button className="linkish small" type="button" disabled={runBusy} onClick={onRun}>
                {runBusy ? "실행 중…" : "다시 실행"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </details>
  );
}
