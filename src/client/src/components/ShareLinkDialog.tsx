import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from "react";
import { flushSync } from "react-dom";
import Modal from "./Modal";
import { copyText } from "../lib/dom";
import { cx, useLatest } from "../lib/hooks";
import {
  absoluteShareUrl,
  activeShareLink,
  createShareLink,
  latestExpiredShareLink,
  listShareLinks,
  revokeShareLink,
  SHARE_AUDIENCE_NOTE,
  shareDateLabel,
  shareDateTimeLabel,
} from "../lib/shareLinks";
import {
  DEFAULT_SHARE_LINK_EXPIRY_DAYS,
  SHARE_LINK_EXPIRY_DAYS,
  type ShareLinkExpiryDays,
} from "../../../shared/shareLinks";
import type { MessageAttachment, ShareLinkSummary } from "../lib/types";
import "./ShareLinkDialog.css";

// Create / show / revoke the share link of ONE deck card. ChatView owns the
// one instance (the card's link button and the deck's side-panel tab's 공유
// 링크 both open it there). It is a portaled Modal (mounted inside the chat view,
// a fixed overlay would otherwise sit in that view's stacking contexts), and
// a portaled modal inerts everything else under <body>, App's
// ConfirmationDialog and Toasts included. So this dialog NEVER calls
// confirmAction or notify (both would mount inert and hidden UNDER it):
// revoke confirms inline and every error renders inside the card.
export interface ShareLinkDialogProps {
  conversationId: string;
  attachment: Pick<MessageAttachment, "id" | "name">;
  onClose?: () => void;
}

type Phase = "loading" | "load-error" | "none" | "active";

const audience = SHARE_AUDIENCE_NOTE;

function selectAll(event: SyntheticEvent<HTMLInputElement>): void {
  event.currentTarget.select();
}

function expiryLabel(days: ShareLinkExpiryDays): string {
  return days === DEFAULT_SHARE_LINK_EXPIRY_DAYS ? `${days}일(기본)` : `${days}일`;
}

export default function ShareLinkDialog({ conversationId, attachment, onClose }: ShareLinkDialogProps) {
  const [uid] = useState(() => Math.random().toString(36).slice(2, 8));
  const titleId = `share-link-title-${uid}`;
  const expiryLabelId = `share-link-expiry-${uid}`;
  const confirmTextId = `share-link-confirm-${uid}`;

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
  const card = useLatest({ conversationId, fileId: attachment.id });

  function setLink(next: ShareLinkSummary | null): void {
    linkRef.current = next;
    setLinkState(next);
  }

  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }

  const fileName = attachment.name || "파일";
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
      const { conversationId: cid, fileId } = card.current;
      const links = (await listShareLinks({ conversationId: cid, fileId })).filter(
        (item) => item.conversationId === card.current.conversationId && item.fileId === card.current.fileId,
      );
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
      const result = await createShareLink(card.current.conversationId, card.current.fileId, expiry);
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
        <p className="muted">{audience}</p>
        <p className="muted">유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요.</p>
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
      <h2 id={titleId}>공유 링크</h2>
      <p className="muted share-link-file">{fileName}</p>

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
