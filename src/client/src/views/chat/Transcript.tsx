// One pane's transcript (views/ChatView.tsx): the empty state, the stored
// messages, the pending mid-turn messages and the live bubble — plus the cards
// an answer carries. State and handlers come from the controller (`ctx`).
//
// Every store write draws all of this again (the app state is mutated in
// place, so nothing here is memoized on it); what keeps that cheap is what kept
// the original cheap: `renderMarkdownCached` for stored bodies, the block-wise
// live renderer (`streamBlocks` + `markdownBlocks`), the identity-guarded
// `enhanceMarkdown`, and card bodies rendered only while open.
//
// The `{" "}` between siblings are the whitespace text nodes the original
// template rendered, kept so every element's text is what it was — and in a
// user or consultation bubble (`white-space: pre-wrap`) such a node is visible.
import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import ActivityTree from "../../components/ActivityTree";
import AvatarImage from "../../components/AvatarImage";
import Icon from "../../components/Icon";
import TeamBrainCard from "../../components/TeamBrainCard";
import TodoOverlay from "../../components/TodoOverlay";
import {
  PLUGIN_STATUS_LABELS,
  cancelRewindEdit,
  canRegenerate,
  consultationLabel,
  hasVisibleImages,
  isRewindAnchor,
  messageKey,
  regenerate,
  setRewindEditDraft,
  steerBadgeLabel,
  submitRewindEdit,
} from "../../lib/chat";
import { autosize, enhanceMarkdown, markdownBlocks } from "../../lib/dom";
import { DOCUMENT_TYPE_LIST, documentTypeLabel } from "../../lib/composerDocuments";
import { formatFileSize, renderMarkdownCached, timeLabel } from "../../lib/format";
import { cx, useAction, useMergedRef } from "../../lib/hooks";
import type { StreamBlock } from "../../lib/streamMarkdown";
import { messageRevealKey, revealedAttachments, revealedText } from "../../lib/streamReveal";
import { formatThinkingDuration, thinkingElapsed, thinkingTopic } from "../../lib/streamThinking";
import { segmentAttachments } from "../../lib/bubbleSegments";
import { diagramProblems } from "../../lib/mermaidBlock";
import type { ChatPane, MessageAttachment, StoredMessage } from "../../lib/types";
import {
  activitySummary,
  canShareCard,
  cardKey,
  compactChip,
  completedActivity,
  completedActivityLabel,
  fileSrc,
  imageSrc,
  latestAnswerId,
  memoryChip,
  messageText,
  paneDomId,
  reportDiagramProblem,
  runtimeBadge,
  visibleAttachments,
  type ChatController,
} from "./controller";

/* ------------------------------------------------------------------ */
/* cards                                                               */
/* ------------------------------------------------------------------ */

function fileCard(ctx: ChatController, item: ChatPane, att: MessageAttachment, source: MessageAttachment[] | undefined): ReactNode {
  return (
    <button className="msg-file-card" type="button" onClick={() => ctx.openFilePreview(item, att, source)}>
      <span className="msg-file-icon" aria-hidden="true">
        <Icon name="file" />
      </span>{" "}
      <span className="msg-file-meta">
        <span className="msg-file-name">{att.name || "파일"}</span>{" "}
        <span className="msg-file-info">{att.size ? `${formatFileSize(att.size)} · ` : ""}열기</span>
      </span>
    </button>
  );
}

// A document the USER attached, in their own bubble. Always a DOWNLOAD of
// their own file: user-uploaded content is never rendered inline and never
// opened in the side-panel preview. Until the server has stored it (`unsent`)
// there is nothing to link to, so the card only says it is on its way.
function uploadedDocumentCard(item: ChatPane, att: MessageAttachment, unsent: boolean): ReactNode {
  if (unsent) {
    return (
      <div key={att.id} className="msg-file-card is-unsent" aria-busy="true">
        <span className="msg-file-icon" aria-hidden="true">
          <Icon name="file-text" />
        </span>{" "}
        <span className="msg-file-meta">
          <span className="msg-file-name">{att.name || "파일"}</span>{" "}
          <span className="msg-file-info">
            {documentTypeLabel(att.name)}
            {att.size ? ` · ${formatFileSize(att.size)}` : ""} · 보내는 중…
          </span>
        </span>
      </div>
    );
  }
  return (
    <a key={att.id} className="msg-file-card" href={fileSrc(item.conversationId, att)} download={att.name || "file"} title={`${att.name || "파일"} 내려받기`}>
      <span className="msg-file-icon" aria-hidden="true">
        <Icon name="file-text" />
      </span>{" "}
      <span className="msg-file-meta">
        <span className="msg-file-name">{att.name || "파일"}</span>{" "}
        <span className="msg-file-info">
          {documentTypeLabel(att.name)}
          {att.size ? ` · ${formatFileSize(att.size)}` : ""} · 내려받기
        </span>
      </span>
    </a>
  );
}

// Shown over the pane a file drag is on. Pointer-events are off (CSS), so it
// never becomes the drag's target and the pane keeps receiving the events.
export function fileDropOverlay(ctx: ChatController, item: ChatPane, takesDocuments: boolean): ReactNode {
  if (ctx.fileDropPaneId !== item.id) return null;
  return (
    <div className="chat-drop-overlay" aria-hidden="true">
      <div className="chat-drop-card">
        <Icon name="file-text" size={28} /> <strong>{takesDocuments ? "여기에 놓아 첨부" : "여기에 놓아 이미지 첨부"}</strong>{" "}
        <span>{takesDocuments ? `이미지 · ${DOCUMENT_TYPE_LIST}` : "문서는 내 아바타와의 대화에서만 첨부할 수 있어요"}</span>
      </div>
    </div>
  );
}

export function attachmentCards(
  ctx: ChatController,
  item: ChatPane,
  atts: MessageAttachment[],
  source: MessageAttachment[] | undefined,
): ReactNode {
  return (
    <div className="msg-images">
      {atts.map((att) => {
        if (att.kind === "file") {
          // A LIVE card has no persisted message the server could find yet, so
          // the link control appears once the turn is stored.
          if (source !== item.liveAttachments && canShareCard(att)) {
            // One flex item: the card is itself a <button>, so the control is
            // a sibling, and the wrapper keeps the pair together on a wrap.
            return (
              <div key={att.id} className="msg-file-share">
                {fileCard(ctx, item, att, source)}{" "}
                <button
                  className="msg-act"
                  type="button"
                  title="공유 링크"
                  aria-label={`공유 링크: ${att.name || "파일"}`}
                  onClick={() => ctx.openShareDialog(item, att)}
                >
                  <Icon name="link" />
                </button>
              </div>
            );
          }
          return <Fragment key={att.id}>{fileCard(ctx, item, att, source)}</Fragment>;
        }
        if (att.kind === "team_brain") return <TeamBrainCard key={att.id} proposalId={att.id} />;
        // The attachment of the retired canvas `widget` type (an older build's row): nothing to draw.
        if ((att.kind as string) === "widget") return null;
        const src = `/api/conversations/${encodeURIComponent(item.conversationId)}/images/${encodeURIComponent(att.id)}`;
        return (
          <figure key={att.id} className="msg-image-item">
            <a className="msg-image-link" href={src} target="_blank" rel="noopener noreferrer">
              <img className="msg-image" src={src} alt={att.caption || att.name || "생성된 이미지"} loading="lazy" />
            </a>{" "}
            {att.caption ? <figcaption className="msg-image-caption">{att.caption}</figcaption> : null}
          </figure>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* rendered markdown                                                   */
/* ------------------------------------------------------------------ */

/** A stored body (a thinking or plan card): the cached whole render, enhanced once per source text. */
function MarkdownHtml({ className, source }: { className: string; source: string }) {
  // The SAME source string the html is rendered from, so an unchanged text skips the sweep.
  return <div className={className} ref={useAction(enhanceMarkdown, source)} dangerouslySetInnerHTML={{ __html: renderMarkdownCached(source) }} />;
}

/** One text run of a stored answer; a diagram in it that cannot be drawn is told to `onProblem`. */
function AnswerMarkdownHtml({ source, onProblem }: { source: string; onProblem: (problem: string) => void }) {
  // The listener first: a diagram whose failure is already known is reported while the html is enhanced.
  const ref = useMergedRef<HTMLDivElement>(useAction(diagramProblems, onProblem), useAction(enhanceMarkdown, source));
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: renderMarkdownCached(source) }} />;
}

/** Live markdown blocks (lib/streamMarkdown.ts): only a block whose html changed is touched. */
function StreamMarkdown({ className, blocks, caret }: { className: string; blocks: StreamBlock[]; caret: boolean }) {
  return (
    <div className={className} ref={useAction(markdownBlocks, blocks)}>
      {caret ? <span className="stream-caret" aria-hidden="true"></span> : null}
    </div>
  );
}

/** Where an answer with inline UI will be, while its components load. */
function AnswerUiLoadingSlot({ ctx }: { ctx: ChatController }) {
  const load = ctx.loadAnswerUi;
  useEffect(() => {
    load();
    // Once, when the placeholder mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="widget-slot-pending" role="status">
      <span className="widget-slot-bar" aria-hidden="true"></span> <span>화면을 준비하는 중…</span>
    </div>
  );
}

// An answer drawn as live blocks: the streaming bubble, and for a moment the
// stored message it became. `text`/`atts` are what is revealed so far;
// `source` stays the full attachment list the cards compare against.
function streamedAnswer(
  ctx: ChatController,
  item: ChatPane,
  scope: string,
  text: string,
  atts: MessageAttachment[] | undefined,
  source: MessageAttachment[] | undefined,
  caret: boolean,
): ReactNode {
  if (!ctx.answerUiFailed && ctx.hasInlineUi(caret ? item.liveText : text)) {
    // The live bubble of an answer that holds inline UI (judged on ALL of the
    // text so far, not on what the paced reveal has shown).
    const AnswerUi = ctx.AnswerUi;
    return AnswerUi ? (
      <AnswerUi
        key="live-answer-ui"
        pane={item}
        text={text}
        atts={atts}
        source={source}
        streaming
        caret={caret}
        cards={(pane, cardAtts, cardSource) => attachmentCards(ctx, pane, cardAtts, cardSource)}
      />
    ) : (
      <AnswerUiLoadingSlot key="answer-ui-loading" ctx={ctx} />
    );
  }
  return segmentAttachments(text, atts).map((seg, segIndex) => (
    <Fragment key={segIndex}>
      {seg.text || (seg.tail && text) ? (
        // Only the tail segment is still being written, so only it is healed.
        <StreamMarkdown className="md" blocks={ctx.streamBlocks(scope, segIndex, seg.text, seg.tail === true)} caret={Boolean(caret && seg.tail)} />
      ) : null}{" "}
      {seg.atts.length ? attachmentCards(ctx, item, seg.atts, source) : null}
    </Fragment>
  ));
}

/* ------------------------------------------------------------------ */
/* a stored message                                                    */
/* ------------------------------------------------------------------ */

/** The inline editor of 여기서부터 다시: the bubble's text, in place. */
function RewindEditor({ ctx, item, message }: { ctx: ChatController; item: ChatPane; message: StoredMessage }) {
  const draft = item.rewindEdit?.draft ?? "";
  const node = useRef<HTMLTextAreaElement | null>(null);
  const ref = useMergedRef<HTMLTextAreaElement>(node, useAction(autosize, draft));
  // The editor opens on a click: focus it with the caret at the end, the way the
  // composer is focused. The value is in the node by now.
  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <>
      {/* The images and documents above ride along unchanged; only the text is edited. */}
      <textarea
        className="rewind-editor-input"
        rows={2}
        value={draft}
        aria-label="수정할 메시지"
        aria-describedby={paneDomId("rewind-hint", item.id)}
        ref={ref}
        onChange={(event) => setRewindEditDraft(item.id, event.currentTarget.value)}
        onKeyDown={(event) => ctx.onRewindEditKeydown(event, item)}
      ></textarea>{" "}
      <p id={paneDomId("rewind-hint", item.id)} className="rewind-editor-hint">
        보내면 이 메시지부터 다시 시작하고, 이후 대화는 삭제됩니다.
      </p>{" "}
      <div className="rewind-editor-actions">
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => cancelRewindEdit(item.id)}>
          취소
        </button>{" "}
        {/* An image- or document-only message may go back with no text: its attachments are the message. */}
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={item.streaming || (!(item.rewindEdit?.draft ?? "").trim() && !hasVisibleImages(message))}
          onClick={() => void submitRewindEdit(item.id)}
        >
          보내기
        </button>
      </div>
    </>
  );
}

function assistantBody(ctx: ChatController, item: ChatPane, message: StoredMessage): ReactNode {
  const activity = completedActivity(message);
  // How much of this answer the paced reveal still holds back (undefined =
  // none, the usual case).
  const draining = ctx.reveal[messageRevealKey(message.id)];
  const badge = runtimeBadge(message);
  const text = messageText(message);
  const thinking = message.response?.thinking;
  const plan = message.response?.plan;
  const thinkingKey = cardKey(message, "thinking");
  const thinkingFor = thinking ? formatThinkingDuration(message.response?.thinkingMs) : "";

  let answer: ReactNode;
  if (!ctx.answerUiFailed && ctx.hasInlineUi(text)) {
    // An answer that holds inline UI: ONE component from the moment it is
    // stored — while its end drains in and after — so the state the viewer set
    // is not remounted away.
    const AnswerUi = ctx.AnswerUi;
    answer = AnswerUi ? (
      <AnswerUi
        key="answer-ui"
        pane={item}
        text={draining !== undefined ? revealedText(text, draining) : text}
        atts={draining !== undefined ? revealedAttachments(message.attachments, text.length, draining) : message.attachments}
        source={message.attachments}
        streaming={draining !== undefined}
        messageId={message.id}
        latest={message.id === latestAnswerId(item.messages)}
        cards={(pane, cardAtts, cardSource) => attachmentCards(ctx, pane, cardAtts, cardSource)}
      />
    ) : (
      <AnswerUiLoadingSlot key="answer-ui-loading" ctx={ctx} />
    );
  } else if (draining !== undefined) {
    // The turn just ended and the paced reveal had not shown all of it: the
    // remainder drains in here (≤ 0.3 s), drawn like the live bubble. Then the
    // entry goes and the cached whole render below takes over — the same html.
    answer = (
      <Fragment key="draining">
        {streamedAnswer(
          ctx,
          item,
          messageRevealKey(message.id),
          revealedText(text, draining),
          revealedAttachments(message.attachments, text.length, draining),
          message.attachments,
          false,
        )}
      </Fragment>
    );
  } else {
    answer = (
      <Fragment key="stored">
        {segmentAttachments(text, message.attachments).map((seg, segIndex) => (
          <Fragment key={segIndex}>
            {seg.text ? <AnswerMarkdownHtml source={seg.text} onProblem={(problem) => reportDiagramProblem(item, message, problem)} /> : null}{" "}
            {seg.atts.length ? attachmentCards(ctx, item, seg.atts, message.attachments) : null}
          </Fragment>
        ))}
      </Fragment>
    );
  }

  let activityCard: ReactNode = null;
  if (activity) {
    // BELOW the answer, mirroring the live bubble: the card is a footnote about
    // how the answer was made, and keeping the two positions identical means
    // nothing teleports when a stream finalizes into a stored message.
    const activityKey = cardKey(message, "activity");
    const memChip = memoryChip(activity.tools);
    const cmpChip = compactChip(activity.tools);
    activityCard = (
      <details className="activity-live activity-done" onToggle={(event) => ctx.toggleCard(activityKey, event)}>
        <summary>
          <span className="activity-summary-text">{completedActivityLabel(activity)}</span>{" "}
          {memChip ? (
            <span className="activity-memory-chip" title={memChip.title}>
              <span aria-hidden="true">🧠</span>
              {memChip.label}
            </span>
          ) : null}{" "}
          {cmpChip ? (
            <span className="activity-memory-chip" title={cmpChip.title}>
              <span aria-hidden="true">{cmpChip.icon}</span>
              {cmpChip.label}
            </span>
          ) : null}
        </summary>{" "}
        {ctx.expandedCards.has(activityKey) ? (
          <div className="agent-activity">
            <ActivityTree agentId="main" agents={activity.agents} tools={activity.tools} tasks={activity.tasks || []} />
          </div>
        ) : null}
      </details>
    );
  }

  return (
    <>
      {badge ? (
        <div className="response-meta">
          <span className="meta-badge">{badge}</span>
        </div>
      ) : null}{" "}
      {thinking ? (
        <details className="thinking-card" onToggle={(event) => ctx.toggleCard(thinkingKey, event)}>
          <summary className="thinking-card-head">
            <span className="tag thinking-card-badge">생각 과정</span>{" "}
            {thinkingFor ? <span className="thinking-card-hint">{thinkingFor} 동안 생각함</span> : null}
          </summary>{" "}
          {ctx.expandedCards.has(thinkingKey) ? <MarkdownHtml className="md thinking-card-body" source={thinking} /> : null}
        </details>
      ) : null}{" "}
      {plan ? (
        // Read-only: plan mode is retired, but an older turn's stored plan still renders.
        <details className="plan-card" open>
          <summary className="plan-card-head">
            <span className="tag plan-card-badge">계획</span>
            <span className="plan-card-hint">계획 모드</span>
          </summary>{" "}
          <MarkdownHtml className="md plan-card-body" source={plan} />
        </details>
      ) : null}{" "}
      {answer} {activityCard}
    </>
  );
}

function userBody(ctx: ChatController, item: ChatPane, message: StoredMessage, editing: boolean): ReactNode {
  const visible = visibleAttachments(message.attachments);
  return (
    <>
      {visible.length ? (
        <div className="msg-images">
          {visible.map((att) =>
            att.kind === "file" ? (
              // A user row's file attachment is a document they attached (`uploaded`).
              uploadedDocumentCard(item, att, (item.unsentDocumentIds ?? []).includes(att.id))
            ) : (
              <figure key={att.id} className="msg-image-item">
                <a className="msg-image-link" href={imageSrc(message, att, item)} target="_blank" rel="noopener noreferrer">
                  <img className="msg-image" src={imageSrc(message, att, item)} alt={att.caption || att.name || "첨부 이미지"} loading="lazy" />
                </a>{" "}
                {att.caption ? <figcaption className="msg-image-caption">{att.caption}</figcaption> : null}
              </figure>
            ),
          )}
        </div>
      ) : null}{" "}
      {editing ? <RewindEditor ctx={ctx} item={item} message={message} /> : message.content ? message.content : null}
    </>
  );
}

/**
 * One stored row. Not memoized: it reads the pane and the message, both
 * mutated in place, so it is drawn again with every render of the view.
 */
function MessageRow({ ctx, item, message, index }: { ctx: ChatController; item: ChatPane; message: StoredMessage; index: number }) {
  const editing = message.role === "user" && item.rewindEdit?.messageId === message.id;
  // A consulted teammate avatar's answer (kind "consultation") is a user-role
  // row Noah wrote: it renders on the avatars' side under THAT avatar's name,
  // never as "나", and offers no edit.
  const consultation = message.role === "user" && message.kind === "consultation";
  return (
    <div className={`message ${consultation ? "consultation" : message.role}`}>
      <div className="msg-role">
        <span className="role-dot"></span>{" "}
        <span>{consultation ? consultationLabel(message) : message.role === "user" ? "나" : item.avatar.alias || item.avatar.displayName}</span>{" "}
        {consultation ? <span className="tag steer-badge">팀원 상담 결과</span> : null}{" "}
        {/* A message the viewer sent WHILE the avatar was answering. The badge is
            what tells it apart from an ordinary turn, and says when the model
            got it: between tool calls, or after the answer. */}
        {message.role === "user" && message.kind === "steer" ? (
          <span className="tag steer-badge">{steerBadgeLabel(item.messages, index)}</span>
        ) : null}{" "}
        {message.createdAt ? (
          <time className="msg-time" dateTime={message.createdAt}>
            {timeLabel(message.createdAt)}
          </time>
        ) : null}
      </div>{" "}
      <div className={cx("bubble", message.response?.summary === "오류" && "errored", editing && "rewind-editing")}>
        {message.role === "assistant" ? assistantBody(ctx, item, message) : userBody(ctx, item, message, editing)}
      </div>{" "}
      <div className="msg-actions">
        <button className="msg-act" type="button" aria-label="복사" title="복사" onClick={(event) => ctx.copyMessage(message, event)}>
          <Icon name="copy" />
        </button>{" "}
        {message.role === "user" ? (
          // 여기서부터 다시 starts only from a row that opened its own turn:
          // never a steer (it landed mid-turn) or a queued row (it sits before
          // an earlier run's answer), and never mid-stream.
          isRewindAnchor(message) && !item.streaming && !editing ? (
            <button className="msg-act" type="button" aria-label="편집" title="수정해서 여기서부터 다시 보내기" onClick={() => ctx.openRewindEdit(item, message)}>
              <Icon name="edit" />
            </button>
          ) : null
        ) : index === item.messages.length - 1 && !item.streaming && canRegenerate(item.messages) ? (
          <button className="msg-act regen" type="button" aria-label="다시 생성" title="다시 생성" onClick={() => regenerate(item.id)}>
            <Icon name="refresh" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the live turn                                                       */
/* ------------------------------------------------------------------ */

function liveTurn(ctx: ChatController, item: ChatPane): ReactNode {
  // What the live bubble shows: the text arrives in bursts and is revealed
  // evenly (lib/streamReveal.ts). `item.liveText` is always all of it; the
  // reveal store says how much is on screen yet, and a card waits for the text
  // before it.
  const liveShown = ctx.reveal[item.id];
  const liveShownText = revealedText(item.liveText, liveShown);
  const liveShownAtts = revealedAttachments(item.liveAttachments, item.liveText.length, liveShown);

  let thinkingCard: ReactNode = null;
  if (item.liveThinking) {
    // The header says what the reasoning is doing without opening it: the
    // elapsed time (a view-layer clock, ticking once a second) and the
    // sub-heading it is on, both read from the raw text. The body is parsed
    // only while the card is open.
    const thinkingOpen = ctx.openLiveThinking.has(item.id);
    const thinkingFor = formatThinkingDuration(thinkingElapsed(ctx.clocks[item.id], ctx.now));
    const thinkingOn = item.thinkingActive ? thinkingTopic(item.liveThinking) : null;
    thinkingCard = (
      <details className={cx("thinking-card", item.thinkingActive && "thinking-card-active")} onToggle={(event) => ctx.toggleLiveThinking(item.id, event)}>
        <summary className="thinking-card-head">
          <span className="tag thinking-card-badge">생각 과정</span>{" "}
          {item.thinkingActive ? (
            <>
              <span className="thinking-card-hint">{thinkingOn ? `생각 중 · ${thinkingOn}` : "생각 중…"}</span>{" "}
              {thinkingFor ? <span className="thinking-card-time">{thinkingFor}</span> : null}{" "}
              <span className="thinking-card-spin" aria-hidden="true"></span>
            </>
          ) : thinkingFor ? (
            <span className="thinking-card-hint">{thinkingFor} 동안 생각함</span>
          ) : null}
        </summary>{" "}
        {thinkingOpen ? (
          <StreamMarkdown
            className="md thinking-card-body"
            blocks={ctx.streamBlocks(item.id, "thinking", item.liveThinking, item.thinkingActive === true)}
            caret={false}
          />
        ) : null}
      </details>
    );
  }

  let activityCard: ReactNode = null;
  if (item.liveAgents.length) {
    const liveRows = { agents: item.liveAgents, tools: item.liveTools, tasks: item.liveTasks };
    const liveMemChip = memoryChip(liveRows.tools);
    const liveCmpChip = compactChip(liveRows.tools);
    activityCard = (
      <details className="activity-live" open>
        <summary>
          <span className="activity-summary-text">{activitySummary(liveRows)}</span>{" "}
          {liveMemChip ? (
            <span className="activity-memory-chip" title={liveMemChip.title}>
              <span aria-hidden="true">🧠</span>
              {liveMemChip.label}
            </span>
          ) : null}{" "}
          {liveCmpChip ? (
            <span className="activity-memory-chip" title={liveCmpChip.title}>
              <span aria-hidden="true">{liveCmpChip.icon}</span>
              {liveCmpChip.label}
            </span>
          ) : null}
        </summary>{" "}
        <div className="agent-activity">
          <ActivityTree agentId="main" agents={liveRows.agents} tools={liveRows.tools} tasks={liveRows.tasks} />
        </div>
      </details>
    );
  }

  return (
    <>
      {/* Accepted by the server, not handed to the model yet. Rendered from
          `item.steers` and replaced by the persisted user row on
          `steer{delivered}`. Above the live bubble: it is waiting on the answer
          below it. */}
      {(item.steers ?? []).map((steer) => (
        <div key={steer.id} className="message user steer-pending">
          <div className="msg-role">
            <span className="role-dot"></span> <span>나</span> <span className="tag steer-badge">전달 대기 중</span>
          </div>{" "}
          <div className="bubble">{steer.text}</div>
        </div>
      ))}
      {/* Three text nodes in the original (around its three declarations). */}
      {"   "}
      <div className="message assistant" aria-live="off">
        <div className="msg-role">
          <span className="role-dot"></span> <span>{item.avatar.alias || item.avatar.displayName}</span>
        </div>{" "}
        <div className="bubble">
          {thinkingCard} {streamedAnswer(ctx, item, item.id, liveShownText, liveShownAtts, item.liveAttachments, true)}{" "}
          {/* BELOW the streamed text, at the reading edge, for two reasons that
              are both about motion: the card GROWS as tools run, and at the top
              every growth spurt shoved the text the user was reading downward;
              and the text grows too, which at the top pushed the one live "what
              is it doing right now" signal ever further from where the eyes
              are. At the bottom both kinds of growth extend the bubble's edge
              instead, which is exactly what autoscroll already follows. */}
          {activityCard}{" "}
          <div className="stream-status">
            <span className="spinner"></span> <span className="label">{item.liveStatus || "응답 생성 중…"}</span>
          </div>{" "}
          {item.livePlugins.length ? (
            <div className="plugin-chips">
              {item.livePlugins.map((chip) => (
                <span key={chip.name} className="plugin-chip" data-status={chip.status}>
                  <span className="pc-dot"></span>{" "}
                  <span className="pc-text">
                    {chip.name} · {PLUGIN_STATUS_LABELS[chip.status] || chip.status}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* the pane's transcript                                               */
/* ------------------------------------------------------------------ */

function emptyState(ctx: ChatController, item: ChatPane): ReactNode {
  const own = ctx.isOwnPane(item);
  const starters =
    item.avatar.elevated || own
      ? ["내가 지금 맡길 수 있는 일을 3가지로 제안해줘.", "이 대화에서 필요한 배경 정보를 먼저 물어봐줘.", "반복해서 실행할 예약 작업을 같이 설계해줘."]
      : ["이 아바타가 잘 아는 분야를 요약해줘.", "내 질문에 답하기 전에 필요한 맥락을 물어봐줘.", "관련된 지식을 바탕으로 핵심만 정리해줘."];
  return (
    <div className="empty-state">
      <AvatarImage user={item.avatar} size={72} alt="" />{" "}
      <div className="hero">
        <h3>{item.avatar.alias || item.avatar.displayName} 아바타와 대화</h3>{" "}
        <p>
          {item.avatar.bio ||
            (item.avatar.elevated || own ? "무엇이든 물어보세요." : "무엇이든 물어보세요. 이 아바타의 도구는 읽기 전용으로 실행됩니다.")}
        </p>
      </div>{" "}
      {own ? (
        // The owner's own avatar gets guided tours instead of generic chips: a
        // first-time owner needs to see what the avatar can do, not a prompt
        // they still have to judge. Colleague panes keep the chips (isOwn is
        // false there).
        <div className="starter-prompts tour-cards" role="group" aria-label="체험 시나리오">
          <p className="tour-caption">처음이라면 이 중 하나로 시작해 보세요. 카드를 누르면 입력창에 준비됩니다.</p>{" "}
          {ctx.tourScenarios.map((scenario) => (
            <button key={scenario.slug} className="starter-prompt tour-card" type="button" onClick={() => ctx.seedTour(item, scenario)}>
              <strong>{scenario.titleKo}</strong> <small>{scenario.descriptionKo}</small> <span className="tag">{scenario.durationKo}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="starter-prompts" role="group" aria-label="시작 프롬프트">
          {starters.map((text, index) => (
            <button key={index} className="starter-prompt" type="button" onClick={() => ctx.seedStarter(item, text)}>
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PaneTranscript({ ctx, item }: { ctx: ChatController; item: ChatPane }) {
  // The pane's StickController takes the transcript element (lib/autoscroll.ts).
  const stick = useAction<HTMLDivElement, string>(ctx.transcriptStick, item.id);
  const { pane, state } = ctx;
  return (
    <div className="chat-body">
      {ctx.todoOverlayOpen && pane && item.id === pane.id ? <TodoOverlay ownAvatar={item.avatar.id === state.user?.id} /> : null}{" "}
      <div
        className="transcript scroll-thin"
        ref={stick}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={item.streaming ? "true" : "false"}
      >
        <div className="transcript-inner">
          {!item.messages.length && !item.streaming ? emptyState(ctx, item) : null}{" "}
          {/* Keyed on messageKey, not the raw id: a bubble the client created
              keeps its key when it adopts the server's id, so it is updated in
              place instead of re-mounted (and re-animated) right after it
              appeared. */}
          {item.messages.map((message, index) => (
            <MessageRow key={messageKey(message, index)} ctx={ctx} item={item} message={message} index={index} />
          ))}{" "}
          {item.streaming ? liveTurn(ctx, item) : null}
        </div>
      </div>{" "}
      {item.stickBottom === false ? (
        <button className="scroll-bottom" type="button" aria-label="맨 아래로" title="맨 아래로" onClick={() => ctx.scrollToBottom(item)}>
          <Icon name="arrow-down" />
        </button>
      ) : null}
    </div>
  );
}
