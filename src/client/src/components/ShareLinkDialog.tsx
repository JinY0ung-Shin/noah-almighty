import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";
import { flushSync } from "react-dom";
import Modal from "./Modal";
import { copyText } from "../lib/dom";
import { cx, useLatest } from "../lib/hooks";
import {
  absoluteShareUrl,
  activeShareLink,
  createConversationShareLink,
  createShareLink,
  createWorkspaceShareLink,
  latestExpiredShareLink,
  listShareLinks,
  revokeShareLink,
  SHARE_AUDIENCE_NOTE,
  SHARE_CONVERSATION_AUDIENCE_NOTE,
  SHARE_CONVERSATION_SCOPE_NOTE,
  SHARE_WORKSPACE_SCOPE_NOTE,
  shareDateLabel,
  shareDateTimeLabel,
  shareLinkMatches,
  type ShareLinkFilter,
} from "../lib/shareLinks";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  SHARE_LINK_EXPIRY_DAYS,
  type ShareLinkExpiryDays,
} from "../../../shared/shareLinks";
import type { MessageAttachment, ShareLinkSummary } from "../lib/types";
import "./ShareLinkDialog.css";

// Create / show / revoke ONE share link: a file card's (`attachment`), a file
// of the viewer's own workspace (`workspaceFile`, the 파일 tab — a copy taken
// when they press), or — with neither — the link of the CONVERSATION itself,
// read-only, as it stands when the owner presses. ChatView owns the one
// instance (the card's link button, the side panel's 공유 링크 buttons and the
// pane header's 대화 공유 all open it there). It is a portaled Modal (mounted inside the chat view,
// a fixed overlay would otherwise sit in that view's stacking contexts), and
// a portaled modal inerts everything else under <body>, App's
// ConfirmationDialog and Toasts included. So this dialog NEVER calls
// confirmAction or notify (both would mount inert and hidden UNDER it):
// revoke confirms inline and every error renders inside the card.
export interface ShareLinkDialogProps {
  conversationId: string;
  /** The file card whose link this is. */
  attachment?: Pick<MessageAttachment, "id" | "name">;
  /** A file of the viewer's own workspace (its path in the 파일 tab's grammar). Neither = the conversation itself. */
  workspaceFile?: { path: string; name: string };
  /** A conversation link: the conversation's title, shown under the heading. */
  conversationTitle?: string;
  onClose?: () => void;
}

type Phase = "loading" | "load-error" | "none" | "active";


function selectAll(event: SyntheticEvent<HTMLInputElement>): void {
  event.currentTarget.select();
}

function expiryLabel(days: ShareLinkExpiryDays): string {
  return days === DEFAULT_SHARE_LINK_EXPIRY_DAYS ? `${days}일(기본)` : `${days}일`;
}

export default function ShareLinkDialog({
  conversationId,
  attachment,
  workspaceFile,
  conversationTitle,
  onClose,
}: ShareLinkDialogProps) {
  const [uid] = useState(() => Math.random().toString(36).slice(2, 8));
  const titleId = `share-link-title-${uid}`;
  const expiryLabelId = `share-link-expiry-${uid}`;
  const confirmTextId = `share-link-confirm-${uid}`;
  // What this dialog is about is fixed while it is open.
  const forConversation = !attachment && !workspaceFile;
  const audience = forConversation ? SHARE_CONVERSATION_AUDIENCE_NOTE : SHARE_AUDIENCE_NOTE;
  /** A conversation link: also let the files the avatar delivered be downloaded. */
  const [includeFiles, setIncludeFiles] = useState(false);

  const [phase, setPhase] = useState<Phase>("loading");
  // `link` and `busy` are also read by handlers that may run before the next
  // render, so each has a ref written together with its state.
  const [link, setLinkState] = useState<ShareLinkSummary | null>(null);
  const linkRef = useRef<ShareLinkSummary | null>(null);
  /** Expiry of this card's most recent lapsed link, for the "이전 링크" note. */
  const [lastExpiredAt, setLastExpiredAt] = useState("");
  /** null = found on open; true = just created; false = the create call handed back an existing link. */
  const [created, setCreated] = useState<boolean | null>(null);
  const [expiry, setExpiry] = useState<ShareLinkExpiryDays>(DEFAULT_SHARE_LINK_EXPIRY_DAYS);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const createButton = useRef<HTMLButtonElement | null>(null);
  const copyButton = useRef<HTMLButtonElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const revokeButton = useRef<HTMLButtonElement | null>(null);
  const cancelButton = useRef<HTMLButtonElement | null>(null);
  const target = useLatest<ShareLinkFilter>(
    workspaceFile
      ? { kind: "workspace_file", sourcePath: workspaceFile.path }
      : attachment
        ? { conversationId, fileId: attachment.id }
        : { conversationId, kind: "conversation" },
  );
  const options = useLatest({ expiry, includeFiles });

  function setLink(next: ShareLinkSummary | null): void {
    linkRef.current = next;
    setLinkState(next);
  }

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }

  const subject = workspaceFile
    ? workspaceFile.name || "파일"
    : attachment
      ? attachment.name || "파일"
      : conversationTitle || "제목 없는 대화";
  const linkUrl = link?.url ? absoluteShareUrl(link.url) : "";

  useEffect(() => {
    void load();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(): Promise<void> {
    setPhase("loading");
    setError("");
    try {
      const filter = target.current;
      const links = (await listShareLinks(filter)).filter((item) => shareLinkMatches(item, filter));
      const active = activeShareLink(links);
      setLink(active);
      setLastExpiredAt(latestExpiredShareLink(links)?.expiresAt ?? "");
      setCreated(null);
      setPhase(active ? "active" : "none");
    } catch (err) {
      setError((err as Error).message);
      setPhase("load-error");
    }
  }

  async function create(): Promise<void> {
    if (busyRef.current) return;
    setBusy(true);
    setError("");
    setRevoked(false);
    try {
      const filter = target.current;
      const result =
        "sourcePath" in filter
          ? await createWorkspaceShareLink(filter.sourcePath, options.current.expiry)
          : "fileId" in filter
            ? await createShareLink(filter.conversationId, filter.fileId, options.current.expiry)
            : await createConversationShareLink(filter.conversationId, {
                expiresInDays: options.current.expiry,
                includeFiles: options.current.includeFiles,
              });
      // Settle BEFORE the commit that mounts the active footer. A button that
      // mounts disabled starts at the disabled opacity and fades in (the
      // global button transition), so 공유 해제 first read as unavailable —
      // and focus() on a still-disabled button is a no-op. So `busy` is
      // cleared in the SAME synchronous commit that switches the phase: the
      // DOM goes from "creating" straight to "active and enabled".
      flushSync(() => {
        setLink(result.link);
        setCreated(result.created);
        setPhase("active");
        setBusy(false);
      });
      (copyButton.current ?? closeButton.current)?.focus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startRevoke(): void {
    flushSync(() => {
      setError("");
      setConfirming(true);
    });
    // The safe choice takes focus: a stray Enter must not revoke.
    cancelButton.current?.focus();
  }

  function cancelRevoke(): void {
    flushSync(() => setConfirming(false));
    revokeButton.current?.focus();
  }

  async function revoke(): Promise<void> {
    const current = linkRef.current;
    if (!current || busyRef.current) return;
    setBusy(true);
    setError("");
    try {
      await revokeShareLink(current.id);
      // Same as create(): 공유 링크 만들기 must mount enabled to take the focus.
      flushSync(() => {
        setLink(null);
        setCreated(null);
        setConfirming(false);
        setRevoked(true);
        setPhase("none");
        setBusy(false);
      });
      createButton.current?.focus();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function copy(event: ReactMouseEvent<HTMLButtonElement>): void {
    // Pass the button: copyText reports failure by flashing it and is silent
    // without one (a plain-HTTP deployment has no async clipboard) — the
    // readonly field stays the manual fallback either way.
    void copyText(linkUrl, event.currentTarget);
  }

  function onExpiryKeydown(event: ReactKeyboardEvent<HTMLButtonElement>, current: ShareLinkExpiryDays): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = SHARE_LINK_EXPIRY_DAYS.indexOf(current);
    const last = SHARE_LINK_EXPIRY_DAYS.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + last + 1) % (last + 1);
    const next = SHARE_LINK_EXPIRY_DAYS[nextIndex];
    setExpiry(next);
    requestAnimationFrame(() => document.getElementById(`share-link-expiry-${uid}-${next}`)?.focus());
  }

  function close(): void {
    if (!busyRef.current) onClose?.();
  }

  // Each branch is keyed: a phase change builds new elements, as it always
  // did, instead of turning one branch's nodes into the next one's.
  let body;
  if (phase === "loading") {
    body = (
      <Fragment key="loading">
        <p className="muted" role="status">
          불러오는 중…
        </p>
      </Fragment>
    );
  } else if (phase === "load-error") {
    body = (
      <Fragment key="load-error">
        <div className="warn-box" role="alert">
          {error}{" "}
          <button className="linkish" type="button" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      </Fragment>
    );
  } else if (phase === "none") {
    body = (
      <Fragment key="none">
        {revoked ? (
          <p className="share-link-status" role="status">
            공유 링크를 해제했습니다.
          </p>
        ) : null}
        {lastExpiredAt ? <p className="muted">이전 링크는 {shareDateLabel(lastExpiredAt)}에 만료되었습니다.</p> : null}
        <div className="share-link-expiry">
          <span id={expiryLabelId} className="share-link-label">
            유효 기간
          </span>
          <div className="seg-control" role="radiogroup" aria-labelledby={expiryLabelId}>
            {SHARE_LINK_EXPIRY_DAYS.map((days, index) => (
              <button
                key={index}
                id={`share-link-expiry-${uid}-${days}`}
                className={cx("seg-btn", expiry === days && "active")}
                type="button"
                role="radio"
                aria-checked={expiry === days ? "true" : "false"}
                tabIndex={expiry === days ? 0 : -1}
                disabled={busy}
                onClick={() => setExpiry(days)}
                onKeyDown={(event) => onExpiryKeydown(event, days)}
              >
                {expiryLabel(days)}
              </button>
            ))}
          </div>
        </div>
        {forConversation ? (
          <>
            <label className="share-link-files">
              <input
                type="checkbox"
                checked={includeFiles}
                disabled={busy}
                onChange={(event) => setIncludeFiles(event.currentTarget.checked)}
              />{" "}
              <span>아바타가 만들어 준 파일도 내려받을 수 있게 하기</span>
            </label>
            <p className="muted">{SHARE_CONVERSATION_SCOPE_NOTE}</p>
          </>
        ) : null}
        {workspaceFile ? <p className="muted">{SHARE_WORKSPACE_SCOPE_NOTE}</p> : null}
        <p className="muted">{audience}</p>
      </Fragment>
    );
  } else if (link) {
    body = (
      <Fragment key="active">
        {created === false ? (
          <p className="share-link-status" role="status">
            이미 만든 링크를 보여 드립니다.
          </p>
        ) : null}
        {linkUrl ? (
          <div className="share-link-url">
            <label className="field">
              <span>링크 주소</span>
              <input
                readOnly
                value={linkUrl}
                autoComplete="off"
                spellCheck={false}
                onFocus={selectAll}
                onClick={selectAll}
              />
            </label>
            {/* Named for what it copies; the visible 복사 stays inside the name. */}
            <button ref={copyButton} className="btn" type="button" aria-label="공유 링크 복사" onClick={copy}>
              복사
            </button>
          </div>
        ) : (
          <p className="warn-box">
            이 링크는 계속 열리지만 다시 표시할 수 없습니다. 다시 보내려면 공유를 해제하고 새 링크를 만드세요.
          </p>
        )}
        <p className="muted">
          {shareDateTimeLabel(link.expiresAt)}까지 · 조회 {link.viewCount}회
        </p>
        {forConversation ? (
          <p className="muted">
            메시지 {link.messageCount}개까지 공유 중 · {link.includesFiles ? "아바타가 만든 파일 포함" : "파일 제외"}. 이 링크를 만든
            뒤의 대화는 보이지 않습니다.
          </p>
        ) : null}
        <p className="muted">{audience}</p>
        <p className="muted">
          {forConversation
            ? "이후 대화를 포함하거나 파일 포함 여부·유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요."
            : workspaceFile
              ? `이 링크는 ${shareDateTimeLabel(link.createdAt)}에 만든 사본을 보여 줍니다. 바뀐 파일을 공유하거나 유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요.`
              : "유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요."}
        </p>
      </Fragment>
    );
  } else {
    body = null;
  }

  return (
    <Modal
      cardClass="cmp-share-link-dialog"
      ariaLabelledby={titleId}
      portal
      closeDisabled={busy}
      onClose={close}
    >
      <h2 id={titleId}>{forConversation ? "대화 공유 링크" : "공유 링크"}</h2>
      <p className="muted share-link-file">{subject}</p>

      {body}

      {error && phase !== "load-error" ? (
        <div className="warn-box" role="alert">
          {error}
        </div>
      ) : null}

      {phase === "active" && confirming ? (
        <div key="confirm" className="share-link-confirm" role="group" aria-labelledby={confirmTextId}>
          <p id={confirmTextId}>이 링크를 해제할까요? 해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.</p>
          <div className="routine-modal-actions-right">
            <button ref={cancelButton} className="btn" type="button" disabled={busy} onClick={cancelRevoke}>
              취소
            </button>
            <button className="btn confirm-danger" type="button" disabled={busy} onClick={() => void revoke()}>
              {busy ? "해제하는 중…" : "해제"}
            </button>
          </div>
        </div>
      ) : (
        <div key="actions" className="routine-modal-actions">
          <div className="routine-modal-actions-left">
            {phase === "active" ? (
              <button ref={revokeButton} className="btn danger" type="button" disabled={busy} onClick={startRevoke}>
                공유 해제
              </button>
            ) : null}
          </div>
          <div className="routine-modal-actions-right">
            <button ref={closeButton} className="btn" type="button" disabled={busy} onClick={close}>
              닫기
            </button>
            {phase === "none" ? (
              <button ref={createButton} className="btn primary" type="button" disabled={busy} onClick={() => void create()}>
                {busy ? "만드는 중…" : "공유 링크 만들기"}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}
