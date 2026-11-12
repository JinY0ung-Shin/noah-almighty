import { Fragment, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import SlidePresenter from "../components/SlidePresenter";
import { useAppState } from "../lib/hooks";
import { goView } from "../lib/nav";
import { readState, updateState } from "../lib/state";
import { openShareLink, shareOwnerLine, shareTicketsStale, type ShareOpenResult } from "../lib/shareLinks";
import { SHARE_LINK_GONE_MESSAGE } from "../../../shared/shareLinks";
import type { ShareViewPayload } from "../lib/types";
import "./ShareView.css";

// The recipient's viewer for a PPTX share link (#/share/<token>). Any
// signed-in user may open a valid link; it grants reading ONE deck — its
// renders and the .pptx — and nothing else. Every payload string is the deck
// author's (file name, slide titles), so it is rendered as plain text only.

type Phase = "loading" | "ready" | "gone" | "error";

function setShareTitle(title: string): void {
  if (readState().shareTitle !== title) updateState((state) => (state.shareTitle = title));
}

export default function ShareView() {
  const state = useAppState();
  // What the markup shows is state; what an answer arriving LATER has to read
  // (after an await) is the ref next to it, written together with the state.
  const [phase, setPhaseState] = useState<Phase>("loading");
  const phaseRef = useRef<Phase>("loading");
  const [payload, setPayloadState] = useState<ShareViewPayload | null>(null);
  const payloadRef = useRef<ShareViewPayload | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshingState] = useState(false);
  const refreshingRef = useRef(false);
  const loadedFor = useRef<string | null>(null);
  const loadSeq = useRef(0);
  const loadedAt = useRef(0);
  /** Position the presenter starts on; null = present mode closed. */
  const [presentFrom, setPresentFrom] = useState<number | null>(null);
  /** List renders that failed to load, by URL (fresh tickets change every URL). */
  const [failedSlides, setFailedSlides] = useState<Record<string, boolean>>({});

  function setPhase(next: Phase): void {
    phaseRef.current = next;
    setPhaseState(next);
  }

  function setPayload(next: ShareViewPayload | null): void {
    payloadRef.current = next;
    setPayloadState(next);
  }

  function setRefreshing(next: boolean): void {
    refreshingRef.current = next;
    setRefreshingState(next);
  }

  const token = state.shareToken;

  async function load(target: string): Promise<void> {
    const seq = ++loadSeq.current;
    loadedFor.current = target;
    setPhase("loading");
    setPayload(null);
    setPresentFrom(null);
    setFailedSlides({});
    setErrorMessage("");
    setRefreshError("");
    setShareTitle("");
    const result = await openShareLink(target);
    if (seq !== loadSeq.current) return;
    if (result.status === "ok") show(result);
    else if (result.status === "gone") setPhase("gone");
    else {
      setErrorMessage(result.message);
      setPhase("error");
    }
  }

  function show(result: Extract<ShareOpenResult, { status: "ok" }>): void {
    setPayload(result.payload);
    loadedAt.current = Date.now();
    setFailedSlides({});
    setPhase("ready");
    setShareTitle(result.payload.fileName);
  }

  /**
   * Re-open the link for fresh viewer tickets (they last 30 minutes), keeping
   * what is on screen. A link revoked meanwhile turns into the dead-link state.
   */
  async function refreshTickets(): Promise<boolean> {
    if (loadedFor.current === null || refreshingRef.current) return false;
    const seq = ++loadSeq.current;
    setRefreshing(true);
    setRefreshError("");
    // Not another view: the same open page renewing its tickets.
    const result = await openShareLink(loadedFor.current, { refresh: true });
    setRefreshing(false);
    if (seq !== loadSeq.current) return false;
    if (result.status === "ok") {
      show(result);
      return true;
    }
    if (result.status === "gone") {
      setPayload(null);
      setPresentFrom(null);
      setPhase("gone");
      setShareTitle("");
    } else {
      setRefreshError(result.message);
    }
    return false;
  }

  async function present(position: number): Promise<void> {
    if (!payloadRef.current?.slides.length) return;
    if (shareTicketsStale(loadedAt.current)) await refreshTickets();
    const current = payloadRef.current;
    if (phaseRef.current === "ready" && current?.slides.length) {
      setPresentFrom(Math.min(position, current.slides.length - 1));
    }
  }

  // The link's own href works while its ticket is fresh; a viewer left open
  // longer fetches a fresh ticket first and then starts the same download.
  async function download(event: ReactMouseEvent<HTMLAnchorElement>): Promise<void> {
    if (!payloadRef.current?.downloadUrl || !shareTicketsStale(loadedAt.current)) return;
    event.preventDefault();
    if (!(await refreshTickets())) return;
    const fresh = payloadRef.current;
    if (!fresh?.downloadUrl) return;
    const anchor = document.createElement("a");
    anchor.href = fresh.downloadUrl;
    anchor.download = fresh.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function markFailed(url: string): void {
    setFailedSlides((prev) => ({ ...prev, [url]: true }));
  }

  // Keyed on the token STRING read from the store in this render: a second link
  // opened while the view is mounted changes only state.shareToken, and must
  // refetch. A layout effect, so the deck of the previous link is taken off
  // the screen before the next paint.
  useLayoutEffect(() => {
    if (token !== loadedFor.current) void load(token);
    // `load` reads only refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(
    () => () => {
      // Drop any answer still in flight: it belongs to a view that is gone.
      loadSeq.current += 1;
      // And a view mounted again (a development double-run of the effects)
      // loads again instead of waiting for the answer just dropped.
      loadedFor.current = null;
    },
    [],
  );

  let body;
  if (phase === "loading") {
    body = (
      <Fragment key="loading">
        <p className="muted" role="status">
          공유 자료를 불러오는 중…
        </p>
      </Fragment>
    );
  } else if (phase === "gone") {
    body = (
      <Fragment key="gone">
        <div className="card share-state">
          <strong>{SHARE_LINK_GONE_MESSAGE}</strong>
          <p className="muted">링크를 보낸 분께 새 링크를 요청해 주세요.</p>
          <button className="btn primary" type="button" onClick={() => goView("explore")}>
            탐색으로 이동
          </button>
        </div>
      </Fragment>
    );
  } else if (phase === "error") {
    body = (
      <Fragment key="error">
        <div className="card share-state" role="alert">
          <strong>공유 자료를 불러오지 못했습니다.</strong>
          {errorMessage ? <p className="muted">{errorMessage}</p> : null}
          <button className="btn primary" type="button" onClick={() => void load(token)}>
            다시 시도
          </button>
        </div>
      </Fragment>
    );
  } else if (payload) {
    body = (
      <Fragment key="ready">
        {refreshError ? (
          <div className="warn-box share-note" role="alert">
            {refreshError}
          </div>
        ) : null}
        {payload.slides.length ? (
          <Fragment key="slides">
            {payload.previewCapped ? (
              <p className="muted share-note">
                미리보기는 최대 30장까지 표시됩니다. 전체 슬라이드는 파일을 내려받아 확인해 주세요.
              </p>
            ) : null}
            <ol className="share-slides" aria-label="슬라이드">
              {payload.slides.map((slide, position) => (
                <li key={position}>
                  <figure className="file-preview-slide">
                    {failedSlides[slide.url] ? (
                      <div className="share-slide-error" role="alert">
                        <span>슬라이드를 불러오지 못했습니다</span>{" "}
                        <span aria-hidden="true">·</span>{" "}
                        <button
                          className="linkish"
                          type="button"
                          disabled={refreshing}
                          onClick={() => void refreshTickets()}
                        >
                          다시 시도
                        </button>
                      </div>
                    ) : (
                      <button
                        className="share-slide-open"
                        type="button"
                        aria-label={`${slide.alt} — 이 슬라이드부터 발표`}
                        onClick={() => void present(position)}
                      >
                        <img src={slide.url} alt={slide.alt} loading="lazy" onError={() => markFailed(slide.url)} />
                      </button>
                    )}
                    <figcaption className="muted">
                      슬라이드 {slide.index} / {payload.slides.length}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ol>
          </Fragment>
        ) : (
          <p key="empty" className="empty-note share-empty">
            미리보기가 없습니다. 파일을 내려받아 확인해 주세요.
          </p>
        )}
      </Fragment>
    );
  } else {
    body = null;
  }

  return (
    <>
      <header className="view-header cmp-share-view">
        <div className="title">
          <h1>{payload ? payload.fileName : "공유된 PPT"}</h1>
          {/* Not a <p>: narrow layouts hide `.view-header .title p`, and who shared
              the deck is the recipient's only provenance signal. */}
          {payload ? <span className="share-meta">{shareOwnerLine(payload)}</span> : null}
        </div>
        {payload ? (
          <div className="share-actions">
            {payload.slides.length ? (
              <button className="btn" type="button" onClick={() => void present(0)}>
                발표 모드
              </button>
            ) : null}
            {payload.downloadUrl ? (
              // draggable=false: a link styled as a button must not start a native
              // link-drag when the pointer moves during the press.
              <a
                className="btn primary"
                href={payload.downloadUrl}
                download={payload.fileName}
                draggable={false}
                onClick={(event) => void download(event)}
              >
                다운로드
              </a>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="view-body scroll-thin share-body cmp-share-view">{body}</div>

      {presentFrom !== null && payload ? (
        <SlidePresenter
          slides={payload.slides}
          start={presentFrom}
          title={payload.fileName}
          onClose={() => setPresentFrom(null)}
          onRetry={() => void refreshTickets()}
        />
      ) : null}
    </>
  );
}
