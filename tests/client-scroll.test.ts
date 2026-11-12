import { describe, expect, it } from "vitest";
import {
  CLAMP_LANDING_PX,
  GESTURE_DEADZONE_PX,
  NEAR_BOTTOM_PX,
  SCROLL_UP_DEADZONE_PX,
  nextStickBottom,
} from "../src/client/src/lib/scroll.js";

// The chat transcript auto-scrolls ("sticks") to the bottom while tokens stream,
// and must disengage only when the USER scrolls up. Two traps broke this
// repeatedly:
//
// 1. The browser itself DECREASES scrollTop when it clamps to a shrunk scroll
//    range (composer collapsing after a multi-line send, an activity card
//    shrinking, …), firing a `scroll` event that looks like an upward gesture.
//    A clamp is told apart by where it LANDS: always at the bottom.
// 2. Scroll-event heuristics alone can't see user intent: mid-stream re-pins
//    reset the viewport between wheel notches, so per-event deltas/distances
//    never accumulated. The wiring layer (lib/autoscroll.ts) therefore marks
//    events that happen during a live wheel/touch/pointer gesture, and those
//    detach on ANY real upward move that doesn't land at the bottom.
// These tests lock both invariants.

describe("nextStickBottom — browser scroll clamps must NOT disengage", () => {
  it("ignores the composer-shrink-after-send clamp (the reported bug)", () => {
    // Observed in a real-browser repro: the after-render pin set lastScrollTop to 887
    // (composer still multi-line), then autosize collapsed the composer in a
    // microtask, growing the viewport and clamping scrollTop to 775 — which lands
    // exactly at the new bottom. The OLD "any decrease is a scroll-up" rule
    // flipped stickBottom off here; the fix must not.
    expect(
      nextStickBottom({ prev: 887, top: 775, scrollHeight: 1428, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("ignores a content-shrink clamp (activity/thinking card collapses)", () => {
    // Pinned at 1400, content shrinks so the max offset drops to 200 → clamp to
    // 200, which is the bottom (800 - 600). distanceFromBottom === 0.
    expect(
      nextStickBottom({ prev: 1400, top: 200, scrollHeight: 800, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });

  it("ignores a large clamp as long as it lands at the bottom", () => {
    // A 500px downward clamp is still not a scroll-up if it ends at the bottom.
    expect(
      nextStickBottom({ prev: 900, top: 400, scrollHeight: 1000, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });

  it("ignores a clamp even during a live gesture (text-selection near the bottom)", () => {
    // Pointer held down while content shrinks: the clamp still lands AT the
    // bottom, which the gesture path must also reject.
    expect(
      nextStickBottom({ prev: 1400, top: 200, scrollHeight: 800, clientHeight: 600, stickBottom: true, userGesture: true }),
    ).toBeNull();
  });
});

describe("nextStickBottom — genuine user scroll-up disengages", () => {
  it("disengages when the user scrolls up and lands away from the bottom", () => {
    // Moved up 459px and now 459px from the bottom (> NEAR_BOTTOM_PX).
    expect(
      nextStickBottom({ prev: 1259, top: 800, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBe(false);
  });

  it("without gesture attribution, a tiny scroll-up within the bottom zone stays engaged", () => {
    // Up 59px but still only 59px from the bottom — could be a coalesced
    // programmatic move; only the conservative rule applies.
    expect(
      nextStickBottom({ prev: 1259, top: 1200, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("WITH gesture attribution, one wheel notch near the bottom disengages (the streaming trap)", () => {
    // Mid-stream the re-pin resets to the bottom between notches, so a single
    // ~100px notch always lands inside NEAR_BOTTOM_PX. Attributed to a real
    // wheel, it must detach anyway — this was the "can't escape the stream" bug.
    expect(
      nextStickBottom({ prev: 1259, top: 1159, scrollHeight: 1912, clientHeight: 653, stickBottom: true, userGesture: true }),
    ).toBe(false);
  });

  it("WITH gesture attribution, a slow 3px scrollbar crawl disengages", () => {
    // Slow drags move 1–3px per event — under the unattributed deadzone but
    // over the gesture one.
    expect(
      nextStickBottom({ prev: 1259, top: 1256, scrollHeight: 3000, clientHeight: 653, stickBottom: true, userGesture: true }),
    ).toBe(false);
  });

  it("respects the deadzone for sub-pixel jitter without a gesture", () => {
    // Up 3px (< SCROLL_UP_DEADZONE_PX) even though far from the bottom.
    expect(
      nextStickBottom({ prev: 1259, top: 1256, scrollHeight: 3000, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("respects the 1px gesture deadzone (fractional-pixel jitter)", () => {
    expect(
      nextStickBottom({ prev: 1259, top: 1258.5, scrollHeight: 3000, clientHeight: 653, stickBottom: true, userGesture: true }),
    ).toBeNull();
  });

  it("just past the deadzone AND far from the bottom disengages", () => {
    const top = 1000;
    const prev = top + SCROLL_UP_DEADZONE_PX + 1;
    expect(
      nextStickBottom({ prev, top, scrollHeight: 3000, clientHeight: 653, stickBottom: true }),
    ).toBe(false);
  });

  it("detaches a fresh pane whose stickBottom is still undefined (store default = sticky)", () => {
    // undefined reads as sticky in the pin path, so it must be detachable here
    // too — otherwise a pane attached to an active run can never let go.
    expect(
      nextStickBottom({ prev: 1259, top: 800, scrollHeight: 1912, clientHeight: 653, stickBottom: undefined }),
    ).toBe(false);
  });
});

describe("nextStickBottom — re-engaging by scrolling back down", () => {
  it("re-engages once the user returns within the bottom zone", () => {
    expect(
      nextStickBottom({ prev: 500, top: 1800, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBe(true);
  });

  it("re-engages exactly at the bottom", () => {
    expect(
      nextStickBottom({ prev: 1000, top: 1847, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBe(true);
  });

  it("stays disengaged while still far from the bottom", () => {
    expect(
      nextStickBottom({ prev: 300, top: 600, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBeNull();
  });

  it("a clamp landing at the bottom does NOT re-engage a detached reader", () => {
    // The user scrolled up to read; content then shrank enough that the browser
    // clamped scrollTop down to the new bottom. scrollTop DECREASED — you cannot
    // reach the bottom by scrolling up, so this must not flip stickBottom back
    // on (it used to, yanking the reader on the next token).
    expect(
      nextStickBottom({ prev: 1400, top: 200, scrollHeight: 800, clientHeight: 600, stickBottom: false }),
    ).toBeNull();
  });

  it("an upward keyboard step near the bottom does NOT re-engage", () => {
    // ArrowUp from 10px to 50px above the bottom: inside the zone but moving
    // AWAY from it — re-engaging here yanked keyboard readers back down.
    expect(
      nextStickBottom({ prev: 1837, top: 1797, scrollHeight: 2500, clientHeight: 653, stickBottom: false }),
    ).toBeNull();
  });
});

describe("nextStickBottom — no-op and edge cases", () => {
  it("returns null on the first event (no previous scrollTop)", () => {
    expect(
      nextStickBottom({ prev: undefined, top: 100, scrollHeight: 2000, clientHeight: 600, stickBottom: true }),
    ).toBeNull();
  });

  it("returns null while sticking and content grows downward (pin, no gesture)", () => {
    // scrollTop increased (we followed growth) — never a scroll-up.
    expect(
      nextStickBottom({ prev: 800, top: 1259, scrollHeight: 1912, clientHeight: 653, stickBottom: true }),
    ).toBeNull();
  });

  it("does not re-write when already disengaged and scrolling further up", () => {
    expect(
      nextStickBottom({ prev: 900, top: 500, scrollHeight: 3000, clientHeight: 653, stickBottom: false }),
    ).toBeNull();
  });

  it("does not re-write when already disengaged and gesturing further up", () => {
    expect(
      nextStickBottom({ prev: 900, top: 880, scrollHeight: 3000, clientHeight: 653, stickBottom: false, userGesture: true }),
    ).toBeNull();
  });

  it("exposes the tuning constants", () => {
    expect(NEAR_BOTTOM_PX).toBe(120);
    expect(SCROLL_UP_DEADZONE_PX).toBe(5);
    expect(GESTURE_DEADZONE_PX).toBe(1);
    expect(CLAMP_LANDING_PX).toBe(2);
  });
});
