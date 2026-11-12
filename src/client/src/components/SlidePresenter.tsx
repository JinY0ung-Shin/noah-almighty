import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useLatest, useWindowEvent } from "../lib/hooks";
import { inertOutside, trapTab } from "../lib/modalBehavior";
import type { ShareViewSlide } from "../lib/types";
import "./SlidePresenter.css";

// 발표 모드 for a shared deck: one slide fitted to the screen. It asks for real
// fullscreen and falls back to a fixed overlay where the Fullscreen API is
// missing or the request is refused — the overlay IS the fullscreen element,
// so both paths share one set of controls. Keys, a visible bar and left/right
// tap zones all turn the page: a touch user has neither arrow keys nor Esc,
// so every action also has an on-screen control (DESIGN §4.4: fullscreen
// viewers carry an explicit close).
export interface SlidePresenterProps {
  slides?: ShareViewSlide[];
  /** Position (0-based) to start on — the slide clicked in the list. */
  start?: number;
  title?: string;
  onClose?: () => void;
  onRetry?: () => void;
}

const NO_SLIDES: ShareViewSlide[] = [];

// Warm the cache for the next slide so turning the page never waits on it.
function preload(url: string | undefined): void {
  if (!url || typeof Image === "undefined") return;
  const img = new Image();
  img.src = url;
}

function leaveFullscreen(): void {
  try {
    void document.exitFullscreen?.()?.catch(() => {});
  } catch {
    /* already leaving */
  }
}

export default function SlidePresenter({ slides = NO_SLIDES, start = 0, title = "", onClose, onRetry }: SlidePresenterProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [positionState, setPosition] = useState(() => Math.max(0, Math.min(start, slides.length - 1)));
  // The render that failed, by URL: fresh tickets from the view change every
  // URL, which clears the error without any bookkeeping.
  const [failedUrl, setFailedUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const wasFullscreen = useRef(false);
  const closed = useRef(false);

  const count = slides.length;
  // A deck that got shorter (fresh tickets for fewer renders) pulls the
  // position back onto its last slide.
  const position = count > 0 && positionState > count - 1 ? count - 1 : positionState;
  if (position !== positionState) setPosition(position);
  const current = slides[position] ?? null;
  const failed = Boolean(current && failedUrl === current.url);
  const nextUrl = slides[position + 1]?.url;

  // Read by the key and click handlers, which may run again before the next
  // render (two key presses in one task).
  const positionRef = useRef(position);
  positionRef.current = position;
  const countRef = useLatest(count);
  const onCloseRef = useLatest(onClose);

  useEffect(() => {
    preload(nextUrl);
  }, [nextUrl]);

  function go(next: number, focusStage = false): void {
    const total = countRef.current;
    if (!total) return;
    const target = Math.max(0, Math.min(total - 1, next));
    positionRef.current = target;
    // The DOM has to show the new position before the focus check below.
    flushSync(() => setPosition(target));
    // A tap zone hands focus back to the stage so Space/Enter keep turning
    // pages; so does an end of the deck, where the 이전/다음 button just pressed
    // turns disabled and would drop focus to <body>.
    const active = document.activeElement as HTMLButtonElement | null;
    if (focusStage || !rootRef.current?.contains(active) || active?.disabled) {
      stageRef.current?.focus({ preventScroll: true });
    }
  }

  function close(): void {
    if (closed.current) return;
    closed.current = true;
    if (document.fullscreenElement) leaveFullscreen();
    onCloseRef.current?.();
  }
  const closeRef = useLatest(close);

  function retry(): void {
    setFailedUrl("");
    setAttempt((value) => value + 1);
    // The usual cause is an expired viewer ticket: ask the view for fresh URLs.
    onRetry?.();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "Tab":
        trapTab(event, rootRef.current);
        return;
      case "ArrowRight":
      case "PageDown":
        event.preventDefault();
        go(positionRef.current + 1);
        return;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        go(positionRef.current - 1);
        return;
      case "Home":
        event.preventDefault();
        go(0);
        return;
      case "End":
        event.preventDefault();
        go(countRef.current - 1);
        return;
      case " ":
      case "Enter":
        // A focused bar button activates itself; only the stage turns the page.
        if (event.target instanceof Element && event.target.closest("button, a, input")) return;
        event.preventDefault();
        go(positionRef.current + 1);
    }
  }

  useWindowEvent("keydown", onKeydown);

  useLayoutEffect(() => {
    const rootEl = rootRef.current;
    const stageEl = stageRef.current;
    if (!rootEl || !stageEl) return;
    const previous = document.activeElement as HTMLElement | null;
    const restoreInert = inertOutside(rootEl);
    // Focus the STAGE, never 닫기: a presenter's first Space or Enter must turn
    // the page, not end present mode.
    stageEl.focus({ preventScroll: true });
    const onFullscreenChange = (): void => {
      if (document.fullscreenElement === rootEl) {
        wasFullscreen.current = true;
      } else if (wasFullscreen.current && !document.fullscreenElement) {
        // Esc in element fullscreen is consumed by the browser — no keydown
        // reaches the page. Leaving fullscreen by ANY route ends present mode, or
        // the overlay would stay behind and need a second Esc.
        closeRef.current();
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    if (typeof rootEl.requestFullscreen === "function") {
      // Refused (the click's user activation ran out, a policy): the fixed
      // overlay already covers the page, so there is nothing to undo.
      try {
        void rootEl.requestFullscreen()?.catch(() => {});
      } catch {
        /* the overlay stays */
      }
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === rootEl) leaveFullscreen();
      restoreInert();
      previous?.focus?.({ preventScroll: true });
    };
    // Mount/unmount only; `closeRef` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={rootRef}
      className="slide-presenter cmp-slide-presenter"
      role="dialog"
      aria-modal="true"
      aria-label={`발표 모드: ${title}`}
    >
      <div
        ref={stageRef}
        className="slide-presenter-stage"
        role="group"
        aria-label={current ? current.alt : "슬라이드"}
        tabIndex={-1}
      >
        {current ? (
          failed ? (
            <p className="slide-presenter-error" role="alert">
              <span>슬라이드를 불러오지 못했습니다</span>{" "}
              <span aria-hidden="true">·</span>{" "}
              <button className="btn sm" type="button" onClick={retry}>
                다시 시도
              </button>
            </p>
          ) : (
            <img
              key={`${current.url}#${attempt}`}
              className="slide-presenter-image"
              src={current.url}
              alt={current.alt}
              onError={(event) => setFailedUrl(event.currentTarget.getAttribute("src") ?? "")}
            />
          )
        ) : null}
        {/* Tap zones: the bar carries the same actions for keyboards and screen
            readers, so the zones stay out of the tab order. */}
        <button
          className="slide-presenter-zone prev"
          type="button"
          tabIndex={-1}
          aria-label="이전 슬라이드"
          disabled={position === 0}
          onClick={() => go(positionRef.current - 1, true)}
        ></button>
        <button
          className="slide-presenter-zone next"
          type="button"
          tabIndex={-1}
          aria-label="다음 슬라이드"
          disabled={position >= count - 1}
          onClick={() => go(positionRef.current + 1, true)}
        ></button>
      </div>
      <div className="slide-presenter-bar">
        <span className="slide-presenter-title">{title}</span>
        <div className="slide-presenter-controls">
          <button className="btn sm" type="button" disabled={position === 0} onClick={() => go(positionRef.current - 1)}>
            이전
          </button>
          <span className="slide-presenter-count" role="status" aria-live="polite" aria-atomic="true">
            <span className="sr-only">슬라이드</span> {count ? position + 1 : 0} / {count}
          </span>
          <button
            className="btn sm"
            type="button"
            disabled={position >= count - 1}
            onClick={() => go(positionRef.current + 1)}
          >
            다음
          </button>
          <button className="btn sm" type="button" onClick={close}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
