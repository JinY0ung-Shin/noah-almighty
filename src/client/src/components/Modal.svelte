<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { quartOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";
  import { openModalFocus, trapTab } from "../lib/modalBehavior";
  import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";

  export let cardClass = "";
  export let ariaLabelledby: string | undefined = undefined;
  export let ariaDescribedby: string | undefined = undefined;
  export let closeOnBackdrop = true;
  export let closeDisabled = false;
  /** Reparent the overlay to <body> — see adoptIntoBody below for when to set it. */
  export let portal = false;

  const dispatch = createEventDispatcher<{ close: void }>();
  let overlayEl: HTMLDivElement;
  let cardEl: HTMLDivElement;
  let cancelSheetSpring: () => void = () => {};
  let sheetY = 0;
  let dragging = false;

  const mobileSheetMedia =
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;

  function overlayMotion() {
    return { duration: prefersReducedMotion() ? 120 : 180 };
  }

  // quartOut is the svelte/easing curve closest to the CSS `--ease-out`
  // (cubic-bezier(0.16, 1, 0.3, 1)); 240ms is the top of the DESIGN §2.5 range.
  function cardMotion() {
    return { y: prefersReducedMotion() ? 0 : 18, duration: prefersReducedMotion() ? 120 : 240, easing: quartOut };
  }

  function close() {
    if (closeDisabled) return;
    dispatch("close");
  }

  function setSheetY(value: number): void {
    sheetY = value;
  }

  function settleSheet(from: number, to: number, velocity = 0, complete?: () => void): void {
    cancelSheetSpring();
    cancelSheetSpring = springValue({
      from,
      to,
      velocity,
      response: 0.3,
      dampingRatio: 0.84,
      onUpdate: setSheetY,
      onComplete: () => {
        cancelSheetSpring = () => {};
        complete?.();
      },
    });
  }

  function startSheetDrag(event: PointerEvent): void {
    if (!mobileSheetMedia?.matches || closeDisabled) return;
    event.preventDefault();
    cancelSheetSpring();
    dragging = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const height = Math.max(1, cardEl.getBoundingClientRect().height);
    const startPointer = event.clientY;
    const startPosition = sheetY;
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
      setSheetY(position);
    };
    const cleanup = () => {
      dragging = false;
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
            if (cardEl?.isConnected) settleSheet(height, 0);
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

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // NOTE: stopPropagation does NOT stop the sibling window-level keydown
      // listeners (Shell rail, CanvasTab fullscreen, PromptModal) — window is
      // the last node in the path. Each of those gates on its own open-state, so
      // one Escape won't cross-dismiss; we still close here.
      close();
    } else if (event.key === "Tab") {
      trapTab(event, cardEl);
    }
  }

  onMount(() => {
    // Reparent to <body> when the caller asks. A modal mounted deep in a view
    // is a fixed-position element inside whatever stacking contexts that view
    // built (the rail's backdrop-filter is one), so the overlay can end up
    // painted UNDER chrome it is supposed to cover — the scrim stops at the
    // content column and the dialog's edge disappears behind the sidebar.
    // Modals mounted at the App root never hit this; portalling gives the same
    // footing to one mounted inside a settings tab.
    const restore = portal ? adoptIntoBody(overlayEl) : () => {};
    const releaseFocus = openModalFocus(overlayEl, cardEl);
    return () => {
      cancelSheetSpring();
      releaseFocus();
      restore();
    };
  });

  /** Move `el` to <body>, returning a teardown that removes it again. */
  function adoptIntoBody(el: HTMLElement): () => void {
    document.body.appendChild(el);
    return () => {
      // Svelte's own transition/destroy also removes the node; guard so the
      // teardown is safe in either order.
      if (el.parentElement === document.body) el.remove();
    };
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div
  bind:this={overlayEl}
  class="modal-overlay"
  class:sheet-dragging={dragging}
  role="presentation"
  transition:fade={overlayMotion()}
  on:pointerdown={(event) => {
    if (!closeOnBackdrop || event.target !== overlayEl) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    overlayEl.setPointerCapture(pointerId);
    const finish = (up: PointerEvent) => {
      overlayEl.removeEventListener("pointerup", finish);
      overlayEl.removeEventListener("pointercancel", finish);
      if (up.type === "pointerup" && Math.hypot(up.clientX - startX, up.clientY - startY) < 10) close();
    };
    overlayEl.addEventListener("pointerup", finish);
    overlayEl.addEventListener("pointercancel", finish);
  }}
>
  <div class="modal-motion" transition:fly={cardMotion()}>
    <div
      bind:this={cardEl}
      class={`modal-card ${cardClass}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      tabindex="-1"
      style={`--sheet-translate-y: ${sheetY}px`}
    >
      <button
        class="modal-sheet-grabber"
        type="button"
        aria-label="아래로 쓸어 창 닫기"
        disabled={closeDisabled}
        tabindex="-1"
        on:pointerdown={startSheetDrag}
      ><span></span></button>
      <slot />
    </div>
  </div>
</div>
