// Dialog keyboard/focus behaviors, extracted from Modal.svelte so every
// dialog-ish surface gets the SAME treatment — including the ones that cannot
// use <Modal> because they render inside a chat pane (PromptModal) or float
// over the whole app without an overlay component (CanvasTab's fullscreen
// stage). Modal.svelte remains the reference implementation; these helpers are
// a straight lift of what it already did.

const FOCUSABLE_SELECTOR =
  "button:not(:disabled), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** Visible, reachable focus targets inside `root`, in DOM order. */
export function focusables(root: HTMLElement | null | undefined): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((el) => {
    if (el.getAttribute("aria-hidden") === "true" || el.hidden) return false;
    // Drop tabindex="-1" elements: the FOCUSABLE_SELECTOR excludes them for the
    // [tabindex] clause but NOT for buttons/inputs, so a decorative
    // tabindex="-1" button (e.g. the sheet grabber) would otherwise become the
    // initial-focus target and a Tab-trap edge. A -1 element is not tab-reachable.
    if (el.tabIndex < 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/**
 * Keep Tab cycling inside `root`. Call from a keydown handler once the key is
 * known to be Tab; it only preventDefaults on the wrap-around edges, so normal
 * in-dialog tabbing keeps the browser's own order.
 */
export function trapTab(event: KeyboardEvent, root: HTMLElement | null | undefined): void {
  if (!root) return;
  const items = focusables(root);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
    last.focus();
    event.preventDefault();
  } else if (!event.shiftKey && document.activeElement === last) {
    first.focus();
    event.preventDefault();
  }
}

/**
 * Mark every element outside `root` inert, up to <body>, so neither Tab nor a
 * screen reader reaches the page behind a modal. Returns the undo.
 */
export function inertOutside(root: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let branch: HTMLElement = root;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement) || sibling.inert) continue;
      sibling.inert = true;
      changed.push(sibling);
    }
    if (parent === document.body) break;
    branch = parent;
  }
  return () => {
    for (const element of changed) element.inert = false;
  };
}

/**
 * Move focus into `root`: the `[data-modal-autofocus]` target when it is
 * actually focusable, else the first focusable, else the container itself.
 *
 * preventScroll: an autofocus target below the fold (e.g. the what's-new
 * confirm button under a long release list) must not open the card
 * pre-scrolled past its heading.
 */
export function focusInitial(root: HTMLElement, preferredSelector = "[data-modal-autofocus]"): void {
  const items = focusables(root);
  const preferred = root.querySelector<HTMLElement>(preferredSelector);
  (preferred && items.includes(preferred) ? preferred : items[0] || root).focus({ preventScroll: true });
}

/**
 * The full root-dialog treatment: inert the background, move focus into the
 * card, and restore both when the returned cleanup runs. `card` defaults to
 * `overlay` for dialogs that are their own overlay.
 */
export function openModalFocus(overlay: HTMLElement, card: HTMLElement = overlay, preferredSelector?: string): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const restoreOutside = inertOutside(overlay);
  focusInitial(card, preferredSelector);
  return () => {
    restoreOutside();
    previous?.focus?.();
  };
}
