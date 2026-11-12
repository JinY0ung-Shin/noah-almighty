// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FEATURE_HINT_GAP,
  FEATURE_HINT_MARGIN,
  FEATURE_HINT_SIDES,
  featureHintAnchor,
  featureHintAnchorBox,
  isFeatureHintAnchor,
  placeFeatureHint,
  recordFeatureHintSeen,
  visibleFeatureHintAnchor,
} from "../src/client/src/lib/featureHints.js";
import { FEATURE_HINTS } from "../src/server/releaseNotes.js";

// Coverage target: src/client/src/lib/featureHints.ts — where the feature-hint
// anchors are, whether one can be pointed at, and where its bubble goes.
// (jsdom lays nothing out: every rect is given by hand. The real geometry is
// checked in a browser.)

const viewport = { width: 1280, height: 800 };
const bubble = { width: 288, height: 180 };

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

/** A control with a given box, attached to the page, marked as `anchor`. */
function mount(anchor: Parameters<typeof featureHintAnchor>[0], box = rect(100, 100, 40, 40), parent: HTMLElement = document.body) {
  const element = document.createElement("button");
  element.getBoundingClientRect = () => box;
  parent.appendChild(element);
  const unmark = featureHintAnchor(anchor)(element) as (() => void) | void;
  return { element, unmark: () => unmark?.() };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("placeFeatureHint", () => {
  it("opens above a control at the bottom, starting near it with the arrow on its centre", () => {
    const anchor = { left: 389, top: 695, width: 40, height: 40 };
    const place = placeFeatureHint(anchor, bubble, viewport, "top");
    expect(place.side).toBe("top");
    expect(place.y).toBe(anchor.top - FEATURE_HINT_GAP - bubble.height);
    // The arrow's window position is the control's centre.
    expect(place.x + place.arrow).toBe(anchor.left + anchor.width / 2);
    expect(place.x).toBeLessThanOrEqual(anchor.left);
  });

  it("opens to the right of a rail item, level with it", () => {
    const anchor = { left: 12, top: 238, width: 255, height: 40 };
    const place = placeFeatureHint(anchor, bubble, viewport, "right");
    expect(place.side).toBe("right");
    expect(place.x).toBe(anchor.left + anchor.width + FEATURE_HINT_GAP);
    expect(place.y + place.arrow).toBe(anchor.top + anchor.height / 2);
  });

  it("moves to a side that has room (phone: the open rail leaves none on the right)", () => {
    const phone = { width: 390, height: 780 };
    const anchor = { left: 12, top: 238, width: 295, height: 40 };
    const place = placeFeatureHint(anchor, bubble, phone, "right");
    expect(place.side).toBe("bottom");
    expect(place.y).toBe(anchor.top + anchor.height + FEATURE_HINT_GAP);
    // Kept inside the window, with the arrow still on the control.
    expect(place.x + bubble.width).toBeLessThanOrEqual(phone.width - FEATURE_HINT_MARGIN);
    expect(place.x + place.arrow).toBe(anchor.left + anchor.width / 2);
  });

  it("falls back in a fixed order per side, and keeps the preferred side when nothing fits", () => {
    // No room above → below.
    expect(placeFeatureHint({ left: 400, top: 10, width: 40, height: 40 }, bubble, viewport, "top").side).toBe("bottom");
    // No room below → above.
    expect(placeFeatureHint({ left: 400, top: 750, width: 40, height: 40 }, bubble, viewport, "bottom").side).toBe("top");
    // No room on the left → below.
    expect(placeFeatureHint({ left: 20, top: 300, width: 40, height: 40 }, bubble, viewport, "left").side).toBe("bottom");
    // Room on the left.
    const left = placeFeatureHint({ left: 900, top: 300, width: 40, height: 40 }, bubble, viewport, "left");
    expect(left.side).toBe("left");
    expect(left.x).toBe(900 - FEATURE_HINT_GAP - bubble.width);

    // A window smaller than the bubble: preferred side, clamped to the margin.
    const tiny = { width: 200, height: 150 };
    for (const side of ["top", "bottom", "right", "left"] as const) {
      const place = placeFeatureHint({ left: 80, top: 60, width: 40, height: 40 }, bubble, tiny, side);
      expect(place.side).toBe(side);
      expect(place.x).toBeGreaterThanOrEqual(FEATURE_HINT_MARGIN);
      expect(place.y).toBeGreaterThanOrEqual(FEATURE_HINT_MARGIN);
    }
  });

  it("keeps the arrow clear of the bubble's corners", () => {
    // A control wider than the bubble, pushed against the right edge.
    const place = placeFeatureHint({ left: 1270, top: 400, width: 8, height: 8 }, bubble, viewport, "top");
    expect(place.arrow).toBeLessThan(bubble.width);
    expect(place.arrow).toBeGreaterThan(0);
    const low = placeFeatureHint({ left: 300, top: 795, width: 40, height: 4 }, bubble, viewport, "right");
    expect(low.arrow).toBeLessThan(bubble.height);
  });

  it("has a side for every hint in the registry", () => {
    for (const hint of FEATURE_HINTS) expect(FEATURE_HINT_SIDES[hint.anchor]).toBeDefined();
  });
});

describe("feature hint anchors", () => {
  it("hands out ONE ref per anchor, and marks and un-marks the element", () => {
    expect(featureHintAnchor("composer-attach")).toBe(featureHintAnchor("composer-attach"));
    expect(featureHintAnchor("composer-attach")).not.toBe(featureHintAnchor("nav-brain"));

    const { element, unmark } = mount("composer-attach");
    expect(isFeatureHintAnchor("composer-attach", element)).toBe(true);
    expect(isFeatureHintAnchor("nav-brain", element)).toBe(false);
    expect(visibleFeatureHintAnchor("composer-attach")).toBe(element);
    unmark();
    expect(isFeatureHintAnchor("composer-attach", element)).toBe(false);
    expect(visibleFeatureHintAnchor("composer-attach")).toBeNull();
    // React calls a ref with null when it has no cleanup to run: nothing happens.
    expect(featureHintAnchor("composer-attach")(null)).toBeUndefined();
  });

  it("returns the first control that can be pointed at (one composer per split pane)", () => {
    const hidden = mount("composer-attach", rect(0, 0, 0, 0));
    const shown = mount("composer-attach", rect(500, 700, 40, 40));
    expect(visibleFeatureHintAnchor("composer-attach")).toBe(shown.element);
    hidden.unmark();
    shown.unmark();
  });

  it("does not point at a control that is detached, inert, hidden, disabled, sizeless or outside the window", () => {
    const inertParent = document.createElement("div");
    inertParent.setAttribute("inert", "");
    document.body.appendChild(inertParent);
    const ariaHidden = document.createElement("div");
    ariaHidden.setAttribute("aria-hidden", "true");
    document.body.appendChild(ariaHidden);

    const ok = mount("nav-brain");
    expect(featureHintAnchorBox(ok.element, true)).toEqual({ left: 100, top: 100, width: 40, height: 40 });

    expect(featureHintAnchorBox(mount("nav-brain", undefined, inertParent).element, true)).toBeNull();
    expect(featureHintAnchorBox(mount("nav-brain", undefined, ariaHidden).element, true)).toBeNull();

    const disabledClass = mount("nav-brain").element;
    disabledClass.classList.add("disabled");
    expect(featureHintAnchorBox(disabledClass, true)).toBeNull();
    const disabled = mount("nav-brain").element as HTMLButtonElement;
    disabled.disabled = true;
    expect(featureHintAnchorBox(disabled, true)).toBeNull();

    expect(featureHintAnchorBox(mount("nav-brain", rect(10, 10, 0, 40)).element, true)).toBeNull();
    expect(featureHintAnchorBox(mount("nav-brain", rect(-400, 100, 40, 40)).element, true)).toBeNull();
    expect(featureHintAnchorBox(mount("nav-brain", rect(100, 5000, 40, 40)).element, true)).toBeNull();

    const detached = mount("nav-brain").element;
    detached.remove();
    expect(featureHintAnchorBox(detached, true)).toBeNull();
  });

  it("asks what is painted at the control's centre only when told to", () => {
    const { element } = mount("nav-teamBrain");
    const cover = document.createElement("div");
    document.body.appendChild(cover);
    const elementFromPoint = vi.fn(() => cover as Element | null);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });
    try {
      // Something else is on top: not while looking for a control…
      expect(featureHintAnchorBox(element, true)).toBeNull();
      expect(elementFromPoint).toHaveBeenCalledWith(120, 120);
      // …but the per-frame follow-up never hit-tests.
      elementFromPoint.mockClear();
      expect(featureHintAnchorBox(element, false)).not.toBeNull();
      expect(elementFromPoint).not.toHaveBeenCalled();
      // The control itself (or something inside it) is what is painted there.
      const icon = document.createElement("span");
      element.appendChild(icon);
      elementFromPoint.mockReturnValue(icon);
      expect(featureHintAnchorBox(element, true)).not.toBeNull();
      // Nothing there at all (outside any element) does not rule it out.
      elementFromPoint.mockReturnValue(null);
      expect(featureHintAnchorBox(element, true)).not.toBeNull();
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  });
});

describe("recordFeatureHintSeen", () => {
  it("posts the id and swallows a failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ user: {} }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    recordFeatureHintSeen("2026-11-12.document-attach");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/me/feature-hints/seen");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ id: "2026-11-12.document-attach" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "알 수 없는 안내입니다." }), { status: 400, headers: { "Content-Type": "application/json" } })),
    );
    // Fire-and-forget: a refusal must not surface as an unhandled rejection.
    expect(() => recordFeatureHintSeen("gone")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
