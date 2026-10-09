const RAIL_COLLAPSED_KEY = "noah.railCollapsed";

/** Read the browser-local desktop rail preference. Expanded is the safe default. */
export function loadRailCollapsed(): boolean {
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist only the non-default state so clearing preferences restores the rail. */
export function persistRailCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(RAIL_COLLAPSED_KEY, "true");
    else window.localStorage.removeItem(RAIL_COLLAPSED_KEY);
  } catch {
    /* Private mode / blocked storage: keep the in-memory UI state working. */
  }
}

const TODO_OVERLAY_OPEN_KEY = "noah.todoOverlayOpen";

/** Read the browser-local 할 일 chat-overlay switch. Off is the default. */
export function loadTodoOverlayOpen(): boolean {
  try {
    return window.localStorage.getItem(TODO_OVERLAY_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist only the non-default (on) state, like the rail preference above. */
export function persistTodoOverlayOpen(open: boolean): void {
  try {
    if (open) window.localStorage.setItem(TODO_OVERLAY_OPEN_KEY, "true");
    else window.localStorage.removeItem(TODO_OVERLAY_OPEN_KEY);
  } catch {
    /* Private mode / blocked storage: the switch still works for this page. */
  }
}
