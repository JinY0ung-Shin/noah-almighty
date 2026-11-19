import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import Icon from "./Icon";
import { chatThumbSize } from "./ReservedImage";
import ZoomableImage from "./ZoomableImage";
import type AnswerUiComponent from "./widget/AnswerUi";
import { segmentAttachments } from "../lib/bubbleSegments";
import { enhanceMarkdown } from "../lib/dom";
import { formatFileSize, renderMarkdownCached, sanitizeMarkdownHtml, timeLabel } from "../lib/format";
import { useAction } from "../lib/hooks";
import { containsInlineUi } from "../../../shared/widget/detect";
import type { ChatPane, MessageAttachment } from "../lib/types";
import type { ShareViewAttachment, ShareViewConversation, ShareViewMessage } from "../../../shared/shareLinks";
import "./SharedConversation.css";

// A shared conversation, READ-ONLY (views/ShareView.tsx, a `conversation`
// share link): the text of both sides and what the answers showed, drawn with
// the chat's own pieces — the same sanitized Markdown, the same inline UI
// interpreter (in its preview mode: nothing is sent, kept or reported), the
// same bubble markup and classes — so it reads like the conversation did.
//
// The viewer is not the conversation's owner, so nothing here may point at a
// conversation route: every image and file comes from the link's own ticket
// URLs (the payload carries them), and an address an answer's text wrote for
// one of its conversation's images is re-pointed at the link's image route.
// There is no composer, no copy/edit/regenerate, no activity or reasoning card
// — the server never sends those.
//
// And the text is SOMEONE ELSE's: the chat keeps an answer's inline `style=""`
// (the owner looks at their own avatar's words), but here it is dropped
// (`sharedHtml`) — content another person chose to send must not position
// itself over the app (`position:fixed; inset:0` fake UI), the rule a team-brain
// note and a workspace file already follow.

export interface SharedConversationProps {
  conversation: ShareViewConversation;
  /** Who shared it: the name over the user's bubbles (never "나" — the reader is someone else). */
  ownerName: string;
}

/** The address an answer writes for an image of its own conversation, up to the image id. */
function conversationImagePrefixes(conversationId: string): string[] {
  if (!conversationId) return [];
  const raw = `/api/conversations/${conversationId}/images/`;
  const encoded = `/api/conversations/${encodeURIComponent(conversationId)}/images/`;
  return raw === encoded ? [raw] : [raw, encoded];
}

/**
 * The last word on a Markdown block's html (the chat's own sanitized output)
 * before a share link's viewer draws it: inline `style=""` goes, and an address
 * the text wrote for its own conversation's image is re-pointed at the link's
 * image route. Both replacements are of server-given, attribute-safe strings
 * inside already-sanitized html, so no markup is made.
 */
function sharedHtml(html: string, conversationId: string, imageBase: string): string {
  // `forceBody`: the block is content that follows other content — it must come back as it went in.
  let out = sanitizeMarkdownHtml(html, { forbidInlineStyle: true, forceBody: true });
  if (imageBase) {
    for (const prefix of conversationImagePrefixes(conversationId)) out = out.split(prefix).join(imageBase);
  }
  return out;
}

/** One text run of an answer: the chat's cached Markdown through {@link sharedHtml}. */
function SharedMarkdown({ source, conversation }: { source: string; conversation: ShareViewConversation }) {
  const html = useMemo(
    () => sharedHtml(renderMarkdownCached(source), conversation.conversationId, conversation.imageBase),
    [source, conversation.conversationId, conversation.imageBase],
  );
  return <div className="md" ref={useAction(enhanceMarkdown, html)} dangerouslySetInnerHTML={{ __html: html }} />;
}

function fileCard(att: ShareViewAttachment, uploaded: boolean): ReactNode {
  const name = att.name || "파일";
  const size = att.size ? formatFileSize(att.size) : "";
  const meta = (
    <>
      <span className="msg-file-icon" aria-hidden="true">
        <Icon name={uploaded ? "file-text" : "file"} />
      </span>{" "}
      <span className="msg-file-meta">
        <span className="msg-file-name">{name}</span>{" "}
        <span className="msg-file-info">
          {size ? `${size} · ` : ""}
          {att.url ? "내려받기" : "공유에 포함되지 않음"}
        </span>
      </span>
    </>
  );
  return att.url ? (
    // draggable=false: a link styled as a card must not start a native link-drag.
    <a key={att.id} className="msg-file-card" href={att.url} download={name} draggable={false} title={`${name} 내려받기`}>
      {meta}
    </a>
  ) : (
    // Not a control: the link's owner shared the conversation without this file.
    <div key={att.id} className="msg-file-card shared-file-unavailable">
      {meta}
    </div>
  );
}

function attachmentCards(atts: readonly ShareViewAttachment[], uploaded: boolean): ReactNode {
  if (!atts.length) return null;
  return (
    <div className="msg-images">
      {atts.map((att) =>
        att.kind === "file" ? (
          fileCard(att, uploaded)
        ) : att.url ? (
          <figure key={att.id} className="msg-image-item">
            <ZoomableImage
              src={att.url}
              alt={att.caption || att.name || (uploaded ? "첨부 이미지" : "생성된 이미지")}
              title={att.name || "이미지"}
              size={chatThumbSize(att)}
              loading="lazy"
            />{" "}
            {att.caption ? <figcaption className="msg-image-caption">{att.caption}</figcaption> : null}
          </figure>
        ) : null,
      )}
    </div>
  );
}

// What AnswerUi reads of a pane. A preview: it never sends, keeps or reports
// through it; the conversation id only tells it which image addresses are this
// conversation's own.
function previewPane(conversationId: string): ChatPane {
  return { id: "shared-conversation", conversationId, streaming: false, liveRunId: null } as unknown as ChatPane;
}

function AssistantBody({
  message,
  conversation,
  AnswerUi,
  answerUiFailed,
  onNeedAnswerUi,
  onBlockedSend,
}: {
  message: ShareViewMessage;
  conversation: ShareViewConversation;
  AnswerUi: typeof AnswerUiComponent | null;
  /** The inline UI chunk did not load: an answer is then drawn as its Markdown, tags and all. */
  answerUiFailed: boolean;
  onNeedAnswerUi: () => void;
  onBlockedSend: () => void;
}) {
  const byId = useMemo(() => new Map(message.attachments.map((att) => [att.id, att])), [message.attachments]);
  // The chat's own placement rule (lib/bubbleSegments.ts) reads id / anchor / hidden only.
  const atts = message.attachments as unknown as MessageAttachment[];
  const cardsOf = (list: readonly MessageAttachment[]): ReactNode =>
    attachmentCards(
      list.flatMap((att) => {
        const shared = byId.get(att.id);
        return shared ? [shared] : [];
      }),
      false,
    );
  const pane = useMemo(() => previewPane(conversation.conversationId), [conversation.conversationId]);
  const imageSrc = useMemo(
    () => (conversation.imageBase ? (imageId: string) => `${conversation.imageBase}${encodeURIComponent(imageId)}` : null),
    [conversation.imageBase],
  );
  const mdHtml = useMemo(
    () => (html: string) => sharedHtml(html, conversation.conversationId, conversation.imageBase),
    [conversation.conversationId, conversation.imageBase],
  );
  const inlineUi = !answerUiFailed && containsInlineUi(message.content);
  useEffect(() => {
    if (inlineUi) onNeedAnswerUi();
    // Once per message: the loader itself is idempotent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineUi]);

  if (inlineUi) {
    return AnswerUi ? (
      <AnswerUi
        pane={pane}
        text={message.content}
        atts={atts}
        source={atts}
        // A preview: a control's message goes here instead of to a chat this reader is not in.
        outbox={onBlockedSend}
        imageSrc={imageSrc}
        // The Markdown between the components is someone else's text too.
        mdHtml={mdHtml}
        cards={(_pane, cardAtts) => cardsOf(cardAtts)}
      />
    ) : (
      <div className="widget-slot-pending" role="status">
        <span className="widget-slot-bar" aria-hidden="true"></span> <span>화면을 준비하는 중…</span>
      </div>
    );
  }
  return (
    <>
      {segmentAttachments(message.content, atts).map((seg, index) => (
        <Fragment key={index}>
          {seg.text ? <SharedMarkdown source={seg.text} conversation={conversation} /> : null}{" "}
          {seg.atts.length ? cardsOf(seg.atts) : null}
        </Fragment>
      ))}
    </>
  );
}

export default function SharedConversation({ conversation, ownerName }: SharedConversationProps) {
  // The inline UI chunk (parser, interpreter, components) loads only for a
  // conversation that has an answer with component tags, like in the chat.
  const [AnswerUi, setAnswerUi] = useState<typeof AnswerUiComponent | null>(null);
  const [answerUiState, setAnswerUiState] = useState<"idle" | "loading" | "failed">("idle");
  const [blockedSend, setBlockedSend] = useState(false);

  function loadAnswerUi(): void {
    if (AnswerUi || answerUiState !== "idle") return;
    setAnswerUiState("loading");
    void import("./widget/AnswerUi").then(
      (mod) => setAnswerUi(() => mod.default),
      () => setAnswerUiState("failed"),
    );
  }

  // "<name> 아바타": in a chat with one's OWN avatar both sides carry the same
  // person's name (the owner reads "나" there; this reader cannot).
  const avatarName = conversation.avatarName ? `${conversation.avatarName} 아바타` : "아바타";
  const sharer = ownerName || "공유한 사용자";

  return (
    <div className="cmp-shared-conversation">
      <p className="muted shared-conversation-note">
        읽기 전용으로 공유된 대화입니다. 도구 실행 기록과 생각 과정은 포함되지 않습니다.
        {conversation.includesFiles ? "" : " 대화 속 파일은 공유되지 않았습니다."}
      </p>
      {blockedSend ? (
        <p className="warn-box shared-conversation-note" role="status">
          공유된 대화에서는 버튼이나 입력 내용을 아바타에게 보낼 수 없습니다.
        </p>
      ) : null}
      <div className="transcript-inner" role="log" aria-label="공유된 대화">
        {conversation.messages.map((message) => {
          const consultation = message.kind === "consultation";
          const speaker = consultation
            ? message.speaker || "팀원 아바타"
            : message.role === "user"
              ? sharer
              : avatarName;
          return (
            <div key={message.id} className={`message ${consultation ? "consultation" : message.role}`}>
              <div className="msg-role">
                <span>{speaker}</span> {consultation ? <span className="tag steer-badge">팀원 상담 결과</span> : null}{" "}
                {message.kind === "steer" ? <span className="tag steer-badge">응답 중 전달</span> : null}{" "}
                {message.createdAt ? (
                  <time className="msg-time" dateTime={message.createdAt}>
                    {timeLabel(message.createdAt)}
                  </time>
                ) : null}
              </div>{" "}
              <div className={message.errored ? "bubble errored" : "bubble"}>
                {message.role === "assistant" ? (
                  <AssistantBody
                    message={message}
                    conversation={conversation}
                    AnswerUi={AnswerUi}
                    answerUiFailed={answerUiState === "failed"}
                    onNeedAnswerUi={loadAnswerUi}
                    onBlockedSend={() => setBlockedSend(true)}
                  />
                ) : (
                  <>
                    {attachmentCards(message.attachments, true)}
                    {message.content ? message.content : null}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
