import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { MAX_ACTIVE_SHARE_LINKS } from "../../../shared/shareLinks";
import { confirmAction } from "../lib/confirm";
import { copyText } from "../lib/dom";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import {
  absoluteShareUrl,
  listShareLinks,
  revokeShareLink,
  SHARE_AUDIENCE_NOTE,
  shareDateLabel,
  shareDateTimeLabel,
} from "../lib/shareLinks";
import type { ShareLinkSummary } from "../lib/types";
import "./SettingsShareLinks.css";

export interface SettingsShareLinksProps {
  active?: boolean;
}

const audience = SHARE_AUDIENCE_NOTE;

// 권한·연결 → 공유 링크: every PPTX share link the owner made, active and
// recently lapsed. Unlike the file card's dialog this card is NOT a modal, so
// the app-root confirmAction and toasts are safe to use here.
export default function SettingsShareLinks({ active = false }: SettingsShareLinksProps) {
  const [links, setLinks] = useState<ShareLinkSummary[]>([]);
  const [loaded, setLoadedState] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState("");
  // `busy`/`loaded` are shown AND read by code that runs later (after an await,
  // from an effect), so each has a ref that always holds the value last set.
  const loadedRef = useRef(false);
  const busyRef = useRef(false);

  function setLoaded(next: boolean): void {
    loadedRef.current = next;
    setLoadedState(next);
  }
  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }

  // Layout effects, so the list never paints in a state the load is about to
  // replace (the first frame of the tab already says 불러오는 중…).
  useLayoutEffect(() => {
    if (active && !loadedRef.current && !busyRef.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loaded, busy]);
  // Leaving the tab drops the cached list, so a re-entry (or a different
  // account after a re-login) always refetches.
  useLayoutEffect(() => {
    if (!active) setLoaded(false);
  }, [active]);
  const activeCount = links.filter((link) => !link.expired).length;

  async function load(): Promise<void> {
    setBusy(true);
    setLoaded(true);
    setError("");
    try {
      setLinks(await listShareLinks());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link: ShareLinkSummary): Promise<void> {
    if (busyRef.current) return;
    const confirmed = await confirmAction(
      `"${link.fileName}" 공유 링크를 해제할까요?\n해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.`,
      { title: "공유 링크 해제", confirmLabel: "해제", tone: "danger" },
    );
    if (!confirmed) return;
    await remove(link, "공유 링크를 해제했습니다.");
  }

  // An expired row is already dead for recipients; deleting it only tidies the
  // list, so it needs no confirmation.
  async function removeExpired(link: ShareLinkSummary): Promise<void> {
    if (busyRef.current) return;
    await remove(link, "만료된 공유 링크를 삭제했습니다.");
  }

  async function remove(link: ShareLinkSummary, done: string): Promise<void> {
    setBusy(true);
    setError("");
    try {
      await revokeShareLink(link.id);
      setLinks((prev) => prev.filter((item) => item.id !== link.id));
      notify(done, "ok");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // copyText never throws: it reports the outcome by flashing the button it is
  // given, and stays SILENT without one.
  function copy(event: MouseEvent<HTMLButtonElement>, link: ShareLinkSummary): void {
    void copyText(absoluteShareUrl(link.url), event.currentTarget);
  }

  if (!active) return null;

  return (
    <section className="settings-card cmp-settings-share-links">
      <div className="panel-section-head">
        <div>
          <h3>공유 링크</h3>
          <p className="muted">
            채팅에서 만든 PPT 공유 링크입니다. {audience}{" "}
            쓰지 않는 링크는 해제하세요. 활성 링크는 최대 {MAX_ACTIVE_SHARE_LINKS}개까지 만들 수 있습니다.
          </p>
        </div>
      </div>
      {error ? (
        <div className="warn-box" role="alert">
          {error}{" "}
          <button className="linkish" type="button" disabled={busy} onClick={() => void load()}>
            목록 다시 불러오기
          </button>
        </div>
      ) : null}
      {links.length ? <p className="muted share-links-count">활성 링크 {activeCount}개</p> : null}
      <div className="secret-list">
        {links.length ? (
          links.map((link) => (
            <div className="secret-row share-link-row" key={link.id}>
              <div className="share-link-main">
                <strong className="share-link-name">{link.fileName}</strong>
                <span className="muted share-link-source">{link.conversationTitle || "제목 없는 대화"}</span>
                <span className="muted share-link-dates">
                  {shareDateLabel(link.createdAt)} 만듦 ·{" "}
                  {link.expired
                    ? `${shareDateLabel(link.expiresAt)} 만료`
                    : `${shareDateTimeLabel(link.expiresAt)}까지`}{" "}
                  · 조회 {link.viewCount}회
                </span>
              </div>
              <span className={cx("tag", !link.expired && "accent")}>{link.expired ? "만료" : "활성"}</span>
              <div className="share-link-actions">
                {!link.expired && link.url ? (
                  <button
                    className="linkish small"
                    type="button"
                    aria-label={`공유 링크 복사: ${link.fileName}`}
                    onClick={(event) => copy(event, link)}
                  >
                    복사
                  </button>
                ) : null}
                {link.expired ? (
                  <button
                    className="linkish small"
                    type="button"
                    disabled={busy}
                    aria-label={`만료된 공유 링크 삭제: ${link.fileName}`}
                    onClick={() => void removeExpired(link)}
                  >
                    삭제
                  </button>
                ) : (
                  <button
                    className="linkish small danger"
                    type="button"
                    disabled={busy}
                    aria-label={`공유 링크 해제: ${link.fileName}`}
                    onClick={() => void revoke(link)}
                  >
                    해제
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="muted">{busy ? "불러오는 중…" : "만든 공유 링크가 없습니다."}</p>
        )}
      </div>
    </section>
  );
}
