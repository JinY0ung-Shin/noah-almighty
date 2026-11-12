// Feature hints (#feature-hints): rings a new feature's own control and says
// what is new in a bubble next to it — the first time the user is on a screen
// where that control can be pointed at, and until they press 알겠어요 or use
// the control. ONE hint at a time, in registry order. Mounted once at the app
// root (App.tsx); the controls mark themselves with `featureHintAnchor(…)`.
//
// Nothing here is driven by the store: App re-renders on every streamed token,
// so this component only derives the pending list (a handful of ids). The
// looking and the positioning happen in ONE requestAnimationFrame loop that
// writes styles directly — it runs only while a hint is pending, looks for a
// control a few times a second, and follows the control every frame only while
// a bubble is up (the rail slides, the composer grows, the window resizes).
import { useEffect, useRef, useState } from "react";
import { useLatest } from "../lib/hooks";
import {
  FEATURE_HINT_SIDES,
  featureHintAnchorBox,
  isFeatureHintAnchor,
  placeFeatureHint,
  recordFeatureHintSeen,
  visibleFeatureHintAnchor,
} from "../lib/featureHints";
import type { User } from "../lib/types";
import { pendingFeatureHints, type FeatureHint } from "../../../server/releaseNotes";
import "./FeatureHintLayer.css";

/** How often an unshown hint looks for its control. */
const SCAN_MS = 250;
/**
 * The first look after the list changes: the screen has settled (and the app's
 * first layout is over — nothing here may measure during the mount commit, see
 * client.md "Never force a layout inside a component's mount commit"), and the
 * next hint does not land on the press that closed the one before.
 */
const FIRST_SCAN_MS = 600;
/** The ring stands this far off the control. */
const RING_OFFSET = 4;

export interface FeatureHintLayerProps {
  user: User;
  /** True while a first-run dialog (welcome, what's new) is up: the bubbles wait for it. */
  blocked?: boolean;
}

export default function FeatureHintLayer({ user, blocked = false }: FeatureHintLayerProps) {
  // Dismissed in this session. The account's own list (`user.seenFeatureHints`)
  // is not patched: a `/api/me` answer that was already on its way would put
  // the old list back and the bubble with it.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const recorded = useRef(new Set<string>());
  const pending = pendingFeatureHints(user.seenFeatureHints).filter((hint) => !dismissed.has(hint.id));
  const pendingKey = pending.map((hint) => hint.id).join("\n");
  const pendingRef = useLatest(pending);

  const [activeId, setActiveId] = useState<string | null>(null);
  const active: FeatureHint | null = blocked ? null : (pending.find((hint) => hint.id === activeId) ?? null);
  const activeRef = useLatest(active);

  const layer = useRef<HTMLDivElement | null>(null);
  const ring = useRef<HTMLDivElement | null>(null);
  const bubble = useRef<HTMLDivElement | null>(null);
  /** The control the shown hint points at. */
  const target = useRef<HTMLElement | null>(null);

  function dismiss(id: string): void {
    // A press on a <label> is two clicks (the label, then its input).
    if (recorded.current.has(id)) return;
    recorded.current.add(id);
    setDismissed((previous) => new Set(previous).add(id));
    recordFeatureHintSeen(id);
  }

  useEffect(() => {
    target.current = null;
    if (blocked || !pendingKey) return;
    let frame = 0;
    let nextScan = performance.now() + FIRST_SCAN_MS;
    let shownId: string | null = null;
    let painted = "";

    const show = (hint: FeatureHint | null, element: HTMLElement | null): void => {
      target.current = element;
      if ((hint?.id ?? null) === shownId) return;
      shownId = hint?.id ?? null;
      painted = "";
      setActiveId(shownId);
    };

    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const held = target.current;
      const heldHint = shownId ? pendingRef.current.find((hint) => hint.id === shownId) : undefined;
      // Every frame, cheaply: is the control we point at still this hint's control?
      const holding = Boolean(held && heldHint && isFeatureHintAnchor(heldHint.anchor, held));

      if (now >= nextScan || (shownId && !holding)) {
        nextScan = now + SCAN_MS;
        // The hint on screen stays while its control can be pointed at — a
        // bubble that jumps to another control under the pointer is worse than
        // one shown out of order.
        if (!(holding && held && featureHintAnchorBox(held, true))) {
          let found: { hint: FeatureHint; element: HTMLElement } | null = null;
          for (const hint of pendingRef.current) {
            const element = visibleFeatureHintAnchor(hint.anchor);
            if (element) {
              found = { hint, element };
              break;
            }
          }
          show(found?.hint ?? null, found?.element ?? null);
        }
      }

      const root = layer.current;
      const element = target.current;
      const hint = activeRef.current;
      // The layer on screen may still belong to the hint before (render pending).
      if (!root || !ring.current || !bubble.current || !element || !hint || hint.id !== shownId) return;
      const box = featureHintAnchorBox(element, false);
      if (!box) {
        if (painted) root.removeAttribute("data-placed");
        painted = "";
        return;
      }
      const size = { width: bubble.current.offsetWidth, height: bubble.current.offsetHeight };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const place = placeFeatureHint(box, size, viewport, FEATURE_HINT_SIDES[hint.anchor]);
      const next = [box.left, box.top, box.width, box.height, place.x, place.y, place.side, place.arrow].map((v) => (typeof v === "number" ? Math.round(v) : v)).join(",");
      if (next === painted) return;
      if (!painted) ring.current.style.setProperty("--feature-hint-radius", getComputedStyle(element).borderRadius || "0px");
      painted = next;
      const ringStyle = ring.current.style;
      ringStyle.width = `${Math.round(box.width) + RING_OFFSET * 2}px`;
      ringStyle.height = `${Math.round(box.height) + RING_OFFSET * 2}px`;
      ringStyle.transform = `translate3d(${Math.round(box.left) - RING_OFFSET}px, ${Math.round(box.top) - RING_OFFSET}px, 0)`;
      const bubbleStyle = bubble.current.style;
      bubbleStyle.transform = `translate3d(${Math.round(place.x)}px, ${Math.round(place.y)}px, 0)`;
      bubbleStyle.setProperty("--feature-hint-arrow", `${Math.round(place.arrow)}px`);
      bubble.current.dataset.side = place.side;
      root.setAttribute("data-placed", "");
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // `pendingRef`/`activeRef` are read through refs on purpose (see the header).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, blocked]);

  // Using the control is the other way to say "I saw it".
  const activeHintId = active?.id ?? null;
  useEffect(() => {
    if (!activeHintId) return;
    const onClick = (event: MouseEvent): void => {
      const element = target.current;
      if (element && event.target instanceof Node && element.contains(event.target)) dismiss(activeHintId);
    };
    // Capture: the control's own handler may stop the event (the upload relay does).
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHintId]);

  if (!active) return null;

  // Keyed by the hint: the next one starts unplaced (hidden) and plays its own entrance.
  return (
    <div key={active.id} ref={layer} className="cmp-feature-hint feature-hint-layer">
      <div ref={ring} className="feature-hint-ring" aria-hidden="true"></div>
      <div ref={bubble} className="feature-hint" role="status" data-hint={active.id}>
        <div className="feature-hint-card">
          <span className="tag accent feature-hint-tag">새 기능</span>
          <strong className="feature-hint-title">{active.title}</strong>
          <p className="feature-hint-body">{active.body}</p>
          {active.details.length ? (
            <ul className="feature-hint-details">
              {active.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          <div className="feature-hint-actions">
            <button className="btn primary sm" type="button" onClick={() => dismiss(active.id)}>
              알겠어요
            </button>
          </div>
          <span className="feature-hint-arrow" aria-hidden="true"></span>
        </div>
      </div>
    </div>
  );
}
