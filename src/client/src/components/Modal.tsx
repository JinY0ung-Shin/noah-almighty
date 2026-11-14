import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx, useLatest, useWindowEvent } from "../lib/hooks";
import { isTopDialogLayer, openModalFocus, trapTab } from "../lib/modalBehavior";
import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";
import { useTransition } from "../lib/presence";
import { fade, fly, quartOut } from "../lib/transition";

export interface ModalProps {
  cardClass?: string;
  ariaLabelledby?: string;
  ariaDescribedby?: string;
  closeOnBackdrop?: boolean;
  closeDisabled?: boolean;
  /**
   * Render the overlay under <body>. A modal mounted deep in a view is a
   * fixed-position element inside whatever stacking contexts that view built
   * (the rail's backdrop-filter is one), so the overlay can end up painted
   * UNDER chrome it is supposed to cover — the scrim stops at the content
   * column and the dialog's edge disappears behind the sidebar. Modals mounted
   * at the App root never hit this; a portal gives the same footing to one
   * mounted inside a settings tab.
   */
  portal?: boolean;
  onClose?: () => void;
  children?: ReactNode;
}

const mobileSheetMedia =
  typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;

function overlayMotion() {
  return { duration: prefersReducedMotion() ? 120 : 180 };
}

// quartOut is the easing closest to the CSS `--ease-out`
// (cubic-bezier(0.16, 1, 0.3, 1)); 240ms is the top of the DESIGN §2.5 range.
function cardMotion() {
  return { y: prefersReducedMotion() ? 0 : 18, duration: prefersReducedMotion() ? 120 : 240, easing: quartOut };
}

/**
 * The app's dialog. To let it play its exit, the parent renders it inside
 * `<Presence>` (lib/presence.tsx): `<Presence>{open && <Modal key="m" …/>}</Presence>`.
 */
export default function Modal({
  cardClass = "",
  ariaLabelledby,
  ariaDescribedby,
  closeOnBackdrop = true,
  closeDisabled = false,
  portal = false,
  onClose,
  children,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const cancelSheetSpring = useRef<() => void>(() => {});
  const [sheetY, setSheetY] = useState(0);
  const sheetYRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const closeRef = useLatest(() => {
    if (closeDisabled) return;
    onClose?.();
  });
  const close = (): void => closeRef.current();

  useTransition(overlayRef, { both: (node) => fade(node, overlayMotion()) });
  useTransition(motionRef, { both: (node) => fly(node, cardMotion()) });

  function moveSheet(value: number): void {
    sheetYRef.current = value;
    setSheetY(value);
  }

  function settleSheet(from: number, to: number, velocity = 0, complete?: () => void): void {
    cancelSheetSpring.current();
    cancelSheetSpring.current = springValue({
      from,
      to,
      velocity,
      response: 0.3,
      dampingRatio: 0.84,
      onUpdate: moveSheet,
      onComplete: () => {
        cancelSheetSpring.current = () => {};
        complete?.();
      },
    });
  }

  function startSheetDrag(event: ReactPointerEvent<HTMLButtonElement>): void {
    const cardEl = cardRef.current;
    if (!mobileSheetMedia?.matches || closeDisabled || !cardEl) return;
    event.preventDefault();
    cancelSheetSpring.current();
    setDragging(true);
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const height = Math.max(1, cardEl.getBoundingClientRect().height);
    const startPointer = event.clientY;
    const startPosition = sheetYRef.current;
    let position = startPosition;
    let velocity = 0;
    let lastPosition = position;
    let lastTime = event.timeStamp;

    const onMove = (move: PointerEvent) => {
      const raw = startPosition + move.clientY - startPointer;
      position = raw < 0 ? rubberband(raw, height) : raw;
      const dt = Math.max(1, move.timeStamp - lastTime) / 1000;
      velocity = velocity * 0.65 + ((position - lastPosition) / dt) * 0.35;
      lastPosition = position;
      lastTime = move.timeStamp;
      moveSheet(position);
    };
    const cleanup = () => {
      setDragging(false);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onUp = () => {
      cleanup();
      const shouldClose = project(position, velocity) > height * 0.45 || velocity > 620;
      if (shouldClose) {
        settleSheet(position, height, velocity, () => {
          close();
          // If a parent vetoes close, bring the still-mounted sheet back.
          queueMicrotask(() => {
            if (cardRef.current?.isConnected) settleSheet(height, 0);
          });
        });
      } else {
        settleSheet(position, 0, velocity);
      }
    };
    const onCancel = () => {
      cleanup();
      settleSheet(position, 0);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  useWindowEvent("keydown", (event) => {
    // Every open dialog hears this window listener, and stopPropagation cannot
    // stop a sibling window listener: a dialog covered by another one (a form
    // under its own confirmation) leaves Escape and Tab to the one on top.
    if (!isTopDialogLayer(overlayRef.current)) return;
    if (event.key === "Escape") {
      close();
    } else if (event.key === "Tab") {
      trapTab(event, cardRef.current);
    }
  });

  useLayoutEffect(() => {
    const overlayEl = overlayRef.current;
    const cardEl = cardRef.current;
    if (!overlayEl || !cardEl) return;
    const releaseFocus = openModalFocus(overlayEl, cardEl);
    return () => {
      cancelSheetSpring.current();
      releaseFocus();
    };
  }, []);

  function onOverlayPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const overlayEl = overlayRef.current;
    if (!closeOnBackdrop || !overlayEl || event.target !== overlayEl) return;
    const startX = event.clientX;
    const startY = event.clientY;
    overlayEl.setPointerCapture(event.pointerId);
    const finish = (up: PointerEvent) => {
      overlayEl.removeEventListener("pointerup", finish);
      overlayEl.removeEventListener("pointercancel", finish);
      if (up.type === "pointerup" && Math.hypot(up.clientX - startX, up.clientY - startY) < 10) close();
    };
    overlayEl.addEventListener("pointerup", finish);
    overlayEl.addEventListener("pointercancel", finish);
  }

  const overlay = (
    <div
      ref={overlayRef}
      className={cx("modal-overlay", dragging && "sheet-dragging")}
      role="presentation"
      onPointerDown={onOverlayPointerDown}
    >
      <div className="modal-motion" ref={motionRef}>
        <div
          ref={cardRef}
          className={`modal-card ${cardClass}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledby}
          aria-describedby={ariaDescribedby}
          tabIndex={-1}
          style={{ "--sheet-translate-y": `${sheetY}px` } as CSSProperties}
        >
          <button
            className="modal-sheet-grabber"
            type="button"
            aria-label="아래로 쓸어 창 닫기"
            disabled={closeDisabled}
            tabIndex={-1}
            onPointerDown={startSheetDrag}
          >
            <span></span>
          </button>
          {children}
        </div>
      </div>
    </div>
  );

  return portal ? createPortal(overlay, document.body) : overlay;
}
