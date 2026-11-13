// Feature hints (#feature-hints): the bubble shown AT a new feature's control,
// on top of the one-time "새로워진 기능" dialog. The registry is the release
// notes (`hint` on an item, server/releaseNotes.ts); this module is the client
// half that has no React in it — where the anchors are, whether one can be
// pointed at right now, and where the bubble goes. The layer that draws it is
// components/FeatureHintLayer.tsx.
import type { RefCallback } from "react";
import { api } from "./api";
import type { FeatureHintAnchor } from "../../../server/releaseNotes";

export type FeatureHintSide = "top" | "bottom" | "right" | "left";

/**
 * Which side of its control each bubble prefers (it moves to another side when
 * that one has no room). Typed over every anchor: a new `FeatureHintAnchor`
 * does not compile until it has a side here.
 */
export const FEATURE_HINT_SIDES: Record<FeatureHintAnchor, FeatureHintSide> = {
  // The composer sits at the bottom of the window.
  "composer-attach": "top",
  // The rail is the left edge; the bubble opens over the view next to it.
  "nav-brain": "right",
  "nav-teamBrain": "right",
  // The 파일 button sits in the chat header, at the top of the window.
  "chat-workspace": "bottom",
};

// ---- Anchors --------------------------------------------------------------
// A control says "I am this feature's home" with `ref={featureHintAnchor(id)}`.
// The same anchor may be mounted more than once (one composer per split pane).

const mounted = new Map<FeatureHintAnchor, Set<HTMLElement>>();
const anchorRefs = new Map<FeatureHintAnchor, RefCallback<HTMLElement>>();

/**
 * The ref that marks an element as a hint anchor. ONE function per anchor id,
 * so passing it on every render never detaches and re-attaches it. Not a hook:
 * usable inside `.map()`, and `undefined` in its place un-marks the element.
 */
export function featureHintAnchor(anchor: FeatureHintAnchor): RefCallback<HTMLElement> {
  let ref = anchorRefs.get(anchor);
  if (!ref) {
    ref = (element) => {
      if (!element) return;
      let elements = mounted.get(anchor);
      if (!elements) mounted.set(anchor, (elements = new Set()));
      elements.add(element);
      const registered = elements;
      return () => {
        registered.delete(element);
      };
    };
    anchorRefs.set(anchor, ref);
  }
  return ref;
}

/** True while `element` is marked as the anchor's control (a component withdraws it by passing no ref). */
export function isFeatureHintAnchor(anchor: FeatureHintAnchor, element: HTMLElement): boolean {
  return Boolean(mounted.get(anchor)?.has(element));
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** Cheap half of the visibility test: nothing here reads layout. */
function reachable(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  // Behind a dialog, in the collapsed rail, in a view the open mobile rail covers.
  if (element.closest("[inert], [aria-hidden='true'], [hidden]")) return false;
  // A control that cannot be used right now (the attach button mid-answer) is
  // not the moment to say "press here".
  if (element.matches(".disabled, :disabled, [aria-disabled='true']")) return false;
  return true;
}

/**
 * The anchor's box when it can be pointed at: it has a size and its centre is
 * inside the window. `occlusion` also asks what is painted there, so a control
 * under another surface (or slid off-screen) does not count — that is a hit
 * test, so the caller does it on its slow cadence, not every frame.
 */
export function featureHintAnchorBox(element: HTMLElement, occlusion: boolean): Box | null {
  if (!reachable(element)) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
  if (occlusion && typeof document.elementFromPoint === "function") {
    const hit = document.elementFromPoint(x, y);
    if (hit && !element.contains(hit)) return null;
  }
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** The first mounted control of the anchor that can be pointed at right now. */
export function visibleFeatureHintAnchor(anchor: FeatureHintAnchor): HTMLElement | null {
  const elements = mounted.get(anchor);
  if (!elements) return null;
  for (const element of elements) {
    if (featureHintAnchorBox(element, true)) return element;
  }
  return null;
}

// ---- Placement ------------------------------------------------------------

/** Space between the control and the bubble (the arrow lives in it). */
export const FEATURE_HINT_GAP = 12;
/** The bubble never touches the window edge. */
export const FEATURE_HINT_MARGIN = 8;
/** Where along the bubble's edge the arrow sits when nothing pushes it. */
const ARROW_INSET = 28;
/** The arrow stays this far from the bubble's corners (clear of the radius). */
const ARROW_CORNER = 18;

export interface FeatureHintPlacement {
  /** Top-left of the bubble, in window coordinates. */
  x: number;
  y: number;
  side: FeatureHintSide;
  /** Distance of the arrow's centre from the bubble's left (top/bottom) or top (right/left) edge. */
  arrow: number;
}

const FALLBACKS: Record<FeatureHintSide, FeatureHintSide[]> = {
  top: ["top", "bottom", "right", "left"],
  bottom: ["bottom", "top", "right", "left"],
  right: ["right", "bottom", "top", "left"],
  left: ["left", "bottom", "top", "right"],
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max));

function fits(anchor: Box, bubble: Size, viewport: Size, side: FeatureHintSide): boolean {
  const room =
    side === "top"
      ? anchor.top
      : side === "bottom"
        ? viewport.height - (anchor.top + anchor.height)
        : side === "left"
          ? anchor.left
          : viewport.width - (anchor.left + anchor.width);
  const need = (side === "top" || side === "bottom" ? bubble.height : bubble.width) + FEATURE_HINT_GAP + FEATURE_HINT_MARGIN;
  // Across the other axis the bubble only has to fit in the window at all.
  const across =
    side === "top" || side === "bottom"
      ? bubble.width + FEATURE_HINT_MARGIN * 2 <= viewport.width
      : bubble.height + FEATURE_HINT_MARGIN * 2 <= viewport.height;
  return room >= need && across;
}

/**
 * Where the bubble goes: on the preferred side when it fits there, else the
 * first side that does, else the preferred side anyway (clamped into the
 * window). The bubble starts near the control rather than centring on it, so a
 * control at the window's edge still gets an arrow that points at it.
 */
export function placeFeatureHint(anchor: Box, bubble: Size, viewport: Size, prefer: FeatureHintSide): FeatureHintPlacement {
  const side = FALLBACKS[prefer].find((candidate) => fits(anchor, bubble, viewport, candidate)) ?? prefer;
  const centerX = anchor.left + anchor.width / 2;
  const centerY = anchor.top + anchor.height / 2;
  if (side === "top" || side === "bottom") {
    const x = clamp(centerX - ARROW_INSET, FEATURE_HINT_MARGIN, viewport.width - bubble.width - FEATURE_HINT_MARGIN);
    const y =
      side === "top"
        ? Math.max(FEATURE_HINT_MARGIN, anchor.top - FEATURE_HINT_GAP - bubble.height)
        : Math.min(anchor.top + anchor.height + FEATURE_HINT_GAP, Math.max(FEATURE_HINT_MARGIN, viewport.height - bubble.height - FEATURE_HINT_MARGIN));
    return { x, y, side, arrow: clamp(centerX - x, ARROW_CORNER, bubble.width - ARROW_CORNER) };
  }
  const y = clamp(centerY - ARROW_INSET, FEATURE_HINT_MARGIN, viewport.height - bubble.height - FEATURE_HINT_MARGIN);
  const x =
    side === "right"
      ? Math.min(anchor.left + anchor.width + FEATURE_HINT_GAP, Math.max(FEATURE_HINT_MARGIN, viewport.width - bubble.width - FEATURE_HINT_MARGIN))
      : Math.max(FEATURE_HINT_MARGIN, anchor.left - FEATURE_HINT_GAP - bubble.width);
  return { x, y, side, arrow: clamp(centerY - y, ARROW_CORNER, bubble.height - ARROW_CORNER) };
}

// ---- Dismissal ------------------------------------------------------------

/**
 * Record the dismissal on the account. Fire-and-forget with NO readback: the
 * layer already stopped offering the hint for this session, and a failed write
 * only means it is offered once more on a later load.
 */
export function recordFeatureHintSeen(id: string): void {
  api("/api/me/feature-hints/seen", { method: "POST", body: JSON.stringify({ id }) }).catch(() => {});
}
