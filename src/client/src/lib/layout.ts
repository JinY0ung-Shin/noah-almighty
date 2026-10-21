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

const TODO_OVERLAY_COLLAPSED_KEY = "noah.todoOverlayCollapsed";

/** The chat card's collapsed sections (ids), browser-local. Unknown or malformed values read as none. */
export function loadTodoOverlayCollapsed(known: readonly string[]): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(TODO_OVERLAY_COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && known.includes(id)) : []);
  } catch {
    return new Set();
  }
}

/** Persist the collapsed sections; none collapsed removes the key. */
export function persistTodoOverlayCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    if (collapsed.size) window.localStorage.setItem(TODO_OVERLAY_COLLAPSED_KEY, JSON.stringify([...collapsed]));
    else window.localStorage.removeItem(TODO_OVERLAY_COLLAPSED_KEY);
  } catch {
    /* Private mode / blocked storage: the sections still fold for this page. */
  }
}

const TODO_OVERLAY_MINIMIZED_KEY = "noah.todoOverlayMinimized";

/** Whether the pinned chat card is folded to its header, browser-local. Expanded is the default. */
export function loadTodoOverlayMinimized(): boolean {
  try {
    return window.localStorage.getItem(TODO_OVERLAY_MINIMIZED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist only the non-default (minimized) state. */
export function persistTodoOverlayMinimized(minimized: boolean): void {
  try {
    if (minimized) window.localStorage.setItem(TODO_OVERLAY_MINIMIZED_KEY, "true");
    else window.localStorage.removeItem(TODO_OVERLAY_MINIMIZED_KEY);
  } catch {
    /* Private mode / blocked storage: the card still folds for this page. */
  }
}
