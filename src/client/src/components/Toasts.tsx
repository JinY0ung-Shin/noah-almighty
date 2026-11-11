import { useLayoutEffect, useRef, type FocusEvent } from "react";
import Icon from "./Icon";
import { useDocumentEvent, useStore } from "../lib/hooks";
import { prefersReducedMotion } from "../lib/motion";
import { Presence, useTransition } from "../lib/presence";
import { dismissToast, pauseToast, resumeToast, toasts as toastStore } from "../lib/state";
import { fly, quartOut } from "../lib/transition";
import type { Toast } from "../lib/types";

type PauseReason = "pointer" | "focus" | "document";
type SetPaused = (id: string, reason: PauseReason, paused: boolean) => void;

// quartOut is the easing closest to the CSS `--ease-out`
// (cubic-bezier(0.16, 1, 0.3, 1)); 240ms is the top of the DESIGN §2.5 range.
function toastIn() {
  return { y: prefersReducedMotion() ? 0 : 14, duration: prefersReducedMotion() ? 120 : 240, easing: quartOut };
}

function toastOut() {
  return { y: prefersReducedMotion() ? 0 : 10, duration: prefersReducedMotion() ? 100 : 180, easing: quartOut };
}

function ToastItem({ toast, setPaused }: { toast: Toast; setPaused: SetPaused }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useTransition(ref, { in: (node) => fly(node, toastIn()), out: (node) => fly(node, toastOut()) });
  const urgent = toast.kind === "warn";

  function onFocusOut(event: FocusEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setPaused(toast.id, "focus", false);
  }

  return (
    <div
      ref={ref}
      className={`toast ${toast.kind}`}
      role={urgent ? "alert" : "status"}
      aria-live={urgent ? "assertive" : "polite"}
      onPointerEnter={() => setPaused(toast.id, "pointer", true)}
      onPointerLeave={() => setPaused(toast.id, "pointer", false)}
      onFocus={() => setPaused(toast.id, "focus", true)}
      onBlur={onFocusOut}
    >
      <span>{toast.message}</span>
      {toast.action && toast.actionLabel ? (
        <button
          type="button"
          className="linkish small"
          onClick={() => {
            toast.action?.();
            dismissToast(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="알림 닫기" onClick={() => dismissToast(toast.id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export default function Toasts() {
  const toasts = useStore(toastStore);
  const pauseReasons = useRef(new Map<string, Set<PauseReason>>()).current;
  const latest = useRef(toasts);
  latest.current = toasts;

  const setPaused: SetPaused = (id, reason, paused) => {
    const reasons = pauseReasons.get(id) ?? new Set<PauseReason>();
    if (paused) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size) {
      pauseReasons.set(id, reasons);
      pauseToast(id);
    } else {
      pauseReasons.delete(id);
      resumeToast(id);
    }
  };

  // On every change of the toast set: forget the pause reasons of toasts that
  // are gone, and pause any current toast while the tab is hidden.
  useLayoutEffect(() => {
    const ids = new Set(toasts.map((toast) => toast.id));
    for (const id of [...pauseReasons.keys()]) {
      if (!ids.has(id)) pauseReasons.delete(id);
    }
    for (const toast of toasts) setPaused(toast.id, "document", document.hidden);
  });

  // `document.hidden` changing with an unchanged toast set re-renders nothing,
  // so the visibility change is handled here.
  useDocumentEvent("visibilitychange", () => {
    for (const toast of latest.current) setPaused(toast.id, "document", document.hidden);
  });

  return (
    <div className="toast-wrap" aria-atomic="false">
      <Presence>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} setPaused={setPaused} />
        ))}
      </Presence>
    </div>
  );
}
