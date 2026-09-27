// Per-transcript stick-to-bottom controller: owns ALL the event wiring around
// `nextStickBottom` (lib/scroll.ts) for one chat pane.
//
// Why input-driven intent instead of scroll-event heuristics: scroll events
// don't say who caused them, and two real-world effects defeated every
// heuristic-only attempt (the long trail of auto-scroll fix commits):
//
// - While tokens stream, the re-pin resets the viewport to the bottom many
//   times a second, so per-event scroll deltas from the user's wheel keep
//   "starting over" — a single wheel notch never got past a distance
//   threshold, and slow trackpad drags (1–4px per event) never got past a
//   jitter deadzone. Verdict: whether you could scroll away depended on how
//   HARD you flicked — the intermittent "auto-scroll does what it wants".
// - The wheel's scroll event can coalesce with our own programmatic pin into
//   one net-downward event, swallowing the gesture entirely.
//
// So user intent is read from the INPUT events themselves:
// - `wheel` up  → detach synchronously, BEFORE the browser even applies the
//   scroll (kills the coalescing race outright).
// - `touchmove` dragging down (= scrolling up) → detach.
// - While a pointer is held down (scrollbar drag) or a wheel/touch fired
//   recently, scroll events pass `userGesture: true` into `nextStickBottom`,
//   which then detaches on ANY real upward move that doesn't land at the
//   bottom (a browser clamp's signature landing spot).
// Unattributed scrolls (keyboard PageUp etc.) still fall back to the
// conservative direction + distance rule inside `nextStickBottom`.
import { nextStickBottom } from "./scroll";

// How long after a wheel tick its scroll events still count as user-driven.
export const WHEEL_GESTURE_MS = 250;
// Touch keeps scrolling after the finger lifts (momentum); refresh the window
// on every touchmove and let it run out past the tail.
export const TOUCH_GESTURE_MS = 1200;
// Minimum downward finger travel (px) that reads as "scrolling up".
export const TOUCH_DETACH_PX = 8;
// Chromium ANIMATES wheel (and keyboard) scrolls. When we re-engage and pin to
// the bottom, the still-running animation's next frame lands ABOVE our pin —
// an upward move that is pure artifact, not intent. For a short grace period
// after re-engaging (or a down-wheel / FAB jump) such heuristic detaches are
// suppressed; direct input (wheel-up, touch drag, scrollbar drag) bypasses it.
export const STICK_GRACE_MS = 250;

export interface StickStore {
  /** Current stickBottom for the pane (undefined = sticky, the store default). */
  isStuck(): boolean | undefined;
  /** Persist a stickBottom change. */
  setStuck(next: boolean): void;
}

export interface StickController {
  /** Svelte-action-compatible: wire up a mounted `.transcript` element. */
  attach(node: HTMLElement): { destroy(): void };
  /** Re-pin to the bottom if sticking (afterUpdate / ResizeObserver ticks). */
  pin(): void;
  /** Scroll-to-bottom FAB: force stick and jump. */
  jumpToBottom(): void;
}

export function createStickController(store: StickStore): StickController {
  let node: HTMLElement | null = null;
  let ro: ResizeObserver | null = null;
  // Previous scrollTop, the base for the direction check in nextStickBottom.
  let lastTop: number | undefined;
  let gestureUntil = 0;
  let stickGraceUntil = 0;
  let pointerDown = false;
  let touchStartY: number | null = null;

  const scrollable = () => !!node && node.scrollHeight - node.clientHeight > 1;
  const armGrace = () => {
    stickGraceUntil = performance.now() + STICK_GRACE_MS;
  };

  function pin() {
    if (!node || store.isStuck() === false) return;
    node.scrollTop = node.scrollHeight;
    // Record the pinned position so the pin's own (coalesced) scroll event
    // reads as "no move" instead of a gesture.
    lastTop = node.scrollTop;
  }

  function jumpToBottom() {
    store.setStuck(true);
    armGrace(); // a wheel animation still in flight must not undo the jump
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    lastTop = node.scrollTop;
  }

  // Direct user input: overrides any grace window.
  function detach() {
    stickGraceUntil = 0;
    if (store.isStuck() !== false) store.setStuck(false);
  }

  // A nested scroller between the event target and the transcript (e.g. the
  // activity tree's `.activity-live > .agent-activity`, overflow-y:auto) that
  // can still scroll up will consume the gesture itself — the transcript won't
  // move, so don't detach. Once it hits its top the browser chains the scroll
  // out to the transcript and the scroll handler takes over (gesture window).
  function innerConsumesScrollUp(target: EventTarget | null): boolean {
    let el = target instanceof Element ? target : null;
    while (el && el !== node) {
      if (el instanceof HTMLElement && el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 1) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function onWheel(event: WheelEvent) {
    if (event.ctrlKey) return; // trackpad pinch-zoom, not a scroll
    gestureUntil = performance.now() + WHEEL_GESTURE_MS;
    if (event.shiftKey) return; // horizontal intent
    if (event.deltaY > 0) {
      // Wheeling DOWN means "toward the bottom", never "let me read above" —
      // shield the stick from this tick's animation artifacts.
      armGrace();
      return;
    }
    if (event.deltaY === 0) return;
    if (!scrollable() || innerConsumesScrollUp(event.target)) return;
    detach();
  }

  function onTouchStart(event: TouchEvent) {
    touchStartY = event.touches[0]?.clientY ?? null;
    gestureUntil = performance.now() + TOUCH_GESTURE_MS;
  }

  function onTouchMove(event: TouchEvent) {
    gestureUntil = performance.now() + TOUCH_GESTURE_MS;
    const y = event.touches[0]?.clientY;
    if (touchStartY == null || y == null) return;
    if (y - touchStartY <= TOUCH_DETACH_PX) return; // finger must move DOWN
    if (!scrollable() || innerConsumesScrollUp(event.target)) return;
    detach();
  }

  // Expanding a <details> inside the transcript is a user-driven content
  // resize. Without this signal the ResizeObserver below cannot distinguish it
  // from streamed content growth and immediately pins the viewport to the
  // bottom, moving the disclosure the user just opened out of view. Detach
  // before the summary's default click action toggles the element so the
  // observer preserves the reader's current position. Keyboard activation of a
  // <summary> dispatches the same click event, so it follows this path too.
  // A collapsed disclosure BUTTON (a folded agent card's header) is the same
  // gesture: its handler flips aria-expanded, but the DOM update lands in a
  // microtask, so the attribute still reads "false" while the click bubbles here.
  function onClick(event: MouseEvent) {
    if (event.defaultPrevented) return;
    const target = event.target instanceof Element ? event.target : null;
    const opener = target?.closest('button[aria-expanded="false"]');
    if (opener && node?.contains(opener)) {
      detach();
      return;
    }
    const summary = target?.closest("summary");
    if (!summary || !node?.contains(summary)) return;
    const details = summary.parentElement;
    if (!(details instanceof HTMLDetailsElement) || details.open) return;
    detach();
  }

  // Scrollbar drags produce scroll events with no wheel/touch — attribute them
  // via the held pointer. (Chromium fires pointerdown on the element for its
  // scrollbar; where a browser doesn't, the distance fallback still applies.)
  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerUp = () => {
    pointerDown = false;
  };

  function onScroll() {
    if (!node) return;
    const prev = lastTop;
    const top = node.scrollTop;
    lastTop = top;
    const next = nextStickBottom({
      prev,
      top,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      stickBottom: store.isStuck(),
      userGesture: pointerDown || performance.now() < gestureUntil,
    });
    // Skip no-op store writes — scroll fires rapidly while streaming.
    if (next === null) return;
    if (next === false) {
      // Inside the post-re-engage grace window an upward move is a wheel/key
      // animation frame chasing a target our pin already overtook — not user
      // intent. A held scrollbar drag is direct manipulation, so it bypasses.
      if (!pointerDown && performance.now() < stickGraceUntil) return;
      store.setStuck(false);
      return;
    }
    store.setStuck(true);
    armGrace(); // the tick that landed us here may still be animating
  }

  function attach(el: HTMLElement) {
    node = el;
    // A newly mounted element is a fresh coordinate space; don't compare its
    // scrollTop against a predecessor's.
    lastTop = undefined;
    // `afterUpdate` re-pins only at the instant the store changes — but the
    // streaming bubble keeps GROWING afterward (activity tree, plugin chips,
    // lazy images, markdown settling). The ResizeObserver re-pins on every
    // content-size change of `.transcript-inner` and on viewport resizes of
    // the transcript itself (composer growing/shrinking).
    ro = new ResizeObserver(() => pin());
    ro.observe(el);
    const inner = el.querySelector<HTMLElement>(".transcript-inner");
    if (inner) ro.observe(inner);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("click", onClick);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    pin(); // land at the bottom on mount (conversation open / pane restore)
    return {
      destroy() {
        ro?.disconnect();
        ro = null;
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("touchstart", onTouchStart);
        el.removeEventListener("touchmove", onTouchMove);
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("click", onClick);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        if (node === el) node = null;
      },
    };
  }

  return { attach, pin, jumpToBottom };
}
