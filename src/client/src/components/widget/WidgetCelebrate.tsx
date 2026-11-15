// `<celebrate when={…}>`: draws nothing until `when` turns from false to true
// WHILE the viewer watches — then a short confetti burst over the answer (the
// Web Animations API on a few plain elements, no library, nothing loaded).
//
// It never plays for a value that was already true when the answer was drawn
// (a reload, a restored state) or that turned true while the answer was being
// written: only after the viewer changed something in it (`ctx.interacted`).
// With the app's 움직임 줄이기 on, a still 🎉 badge shows for a moment instead
// of anything moving. Either way the label is read out to screen readers.
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { prefersReducedMotion } from "../../lib/motion";

/** How long a burst lasts, and how long the still badge stays. */
export const CELEBRATE_MS = 1300;
export const CELEBRATE_STILL_MS = 1500;
const PIECES = 28;
const PALETTE = ["var(--accent)", "var(--ok)", "var(--warn)", "var(--danger)", "var(--info)"];
const TONED = ["var(--wg-tone)", "var(--wg-tone-line)"];

/**
 * Throw `PIECES` bits of confetti out of `host` (they rise in a fan, then fall
 * and fade). Returns the cleanup; the layer also removes itself when done.
 */
export function playConfetti(host: HTMLElement, toned: boolean): () => void {
  const colors = toned ? TONED : PALETTE;
  const layer = document.createElement("span");
  layer.className = "wg-confetti";
  layer.setAttribute("aria-hidden", "true");
  const animations: Animation[] = [];
  for (let i = 0; i < PIECES; i++) {
    const piece = document.createElement("span");
    piece.className = i % 3 === 0 ? "wg-confetti-piece wg-confetti-round" : "wg-confetti-piece";
    piece.style.background = colors[i % colors.length];
    layer.appendChild(piece);
    if (typeof piece.animate !== "function") continue;
    // An upward fan, ±75° around straight up.
    const angle = ((-90 + (Math.random() - 0.5) * 150) * Math.PI) / 180;
    const reach = 60 + Math.random() * 90;
    const dx = Math.cos(angle) * reach;
    const dy = Math.sin(angle) * reach;
    const fall = 50 + Math.random() * 70;
    const spin = (Math.random() - 0.5) * 720;
    animations.push(
      piece.animate(
        [
          { transform: "translate(0, 0) rotate(0deg) scale(0.6)", opacity: 1, easing: "cubic-bezier(0.15, 0.7, 0.35, 1)" },
          { transform: `translate(${dx}px, ${dy}px) rotate(${spin / 2}deg) scale(1)`, opacity: 1, offset: 0.4, easing: "cubic-bezier(0.45, 0, 0.8, 0.5)" },
          { transform: `translate(${dx * 1.25}px, ${dy + fall}px) rotate(${spin}deg) scale(0.9)`, opacity: 0 },
        ],
        { duration: CELEBRATE_MS - Math.random() * 300, fill: "forwards" },
      ),
    );
  }
  host.appendChild(layer);
  const timer = setTimeout(() => layer.remove(), CELEBRATE_MS + 50);
  return () => {
    clearTimeout(timer);
    for (const animation of animations) animation.cancel();
    layer.remove();
  };
}

export interface WidgetCelebrateProps {
  when: unknown;
  /** A tone token: the confetti in that tone's colours instead of the mixed palette. */
  toned: boolean;
  label: string;
  /** The viewer has changed something in this answer (WidgetCtx.interacted). */
  interacted: boolean;
  /** The tone's custom properties (lib/widgetStyle.ts `toneStyle`), already an object. */
  style?: CSSProperties;
}

export default function WidgetCelebrate({ when, toned, label, interacted, style }: WidgetCelebrateProps) {
  const on = when === true;
  const was = useRef(on);
  const host = useRef<HTMLSpanElement>(null);
  const count = useRef(0);
  const [burst, setBurst] = useState<{ n: number; still: boolean } | null>(null);

  // Only a change from false to true counts, and only one the viewer brought about.
  useEffect(() => {
    const before = was.current;
    was.current = on;
    if (!on || before || !interacted) return;
    count.current += 1;
    // Read when the motion starts, never the OS setting (client CLAUDE.md).
    setBurst({ n: count.current, still: prefersReducedMotion() });
  }, [on, interacted]);

  useEffect(() => {
    if (!burst) return;
    const stop = !burst.still && host.current ? playConfetti(host.current, toned) : null;
    const timer = setTimeout(() => setBurst(null), burst.still ? CELEBRATE_STILL_MS : CELEBRATE_MS);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, [burst, toned]);

  return (
    <span className="wg-celebrate" ref={host} style={style} data-burst={burst ? (burst.still ? "still" : "motion") : undefined}>
      <span className="sr-only" role="status">
        {burst ? label || "축하합니다!" : ""}
      </span>
      {burst?.still ? (
        <span className="wg-celebrate-badge" aria-hidden="true">
          🎉{label ? ` ${label}` : ""}
        </span>
      ) : null}
    </span>
  );
}
