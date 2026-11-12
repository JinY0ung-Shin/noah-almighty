// Telling the avatar that a canvas it showed did not render.
//
// A canvas is drawn in the VIEWER's browser, so a failure there (a widget node
// that throws, a mermaid layout error) was
// something only the viewer saw. The client now posts the reasons — short
// English lines — to the server, which hands them to the avatar ONCE with the
// next turn so it can fix the canvas.
//
// What keeps this from being noise:
// - only NEW lines are sent: a canvas re-renders on every tab switch, theme
//   flip and widget state change, and each line goes out once per (canvas,
//   content);
// - the send waits a moment and then checks that the content is still the one
//   on screen — a reattach replays a run's whole log, so an OLDER version of a
//   canvas can render (and fail) for an instant before the current one;
// - a handful of reports per content at most, a few lines each;
// - a failed send is dropped silently: nothing here is the viewer's problem.
import { readState } from "./state";

export const CANVAS_REPORT_DELAY_MS = 1200;
export const MAX_REPORT_ERRORS = 5;
export const MAX_REPORT_ERROR_CHARS = 300;
/** Reports per (canvas, content): a widget whose errors change with its state must not trickle forever. */
export const MAX_REPORTS_PER_CONTENT = 3;
const MAX_TRACKED_CANVASES = 100;

interface Tracked {
  content: string;
  /** Lines already sent for this content. */
  sent: Set<string>;
  pending: string[];
  reports: number;
  timer: ReturnType<typeof setTimeout> | null;
  stillCurrent: () => boolean;
}

// Per page load, by conversation + canvas: outlives a CanvasTab (a conversation
// switch re-mounts it), so coming back to a broken canvas does not re-send.
const tracked = new Map<string, Tracked>();

export interface CanvasRenderReport {
  canvasId: string;
  conversationId: string | null | undefined;
  /** The content these errors belong to. */
  content: string;
  /** English lines for the avatar. */
  errors: string[];
  /** Whether that content is (still) what the viewer has on screen. Asked when the report is about to go out. */
  stillCurrent: () => boolean;
}

function clip(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REPORT_ERROR_CHARS ? `${flat.slice(0, MAX_REPORT_ERROR_CHARS - 1)}…` : flat;
}

/**
 * Queue render errors for the avatar. Only a signed-in viewer inside a
 * conversation reports (the conversation is theirs: they are who the avatar
 * answers next). Safe to call on every render — repeats are dropped.
 */
export function queueCanvasRenderReport(report: CanvasRenderReport): void {
  const { canvasId, conversationId } = report;
  if (!canvasId || !conversationId || !readState().user?.id) return;
  queueReport(`${conversationId}\n${canvasId}`, report.content, report.errors, report.stillCurrent, (errors) =>
    send(`/api/canvases/${encodeURIComponent(canvasId)}/render-report`, { conversationId, errors }),
  );
}

export interface InlineUiRenderReport {
  conversationId: string | null | undefined;
  /** The stored assistant message whose answer holds the UI. */
  messageId: string | null | undefined;
  /** The answer text these errors belong to. */
  content: string;
  /** English lines for the avatar. */
  errors: string[];
  /** Whether that answer is (still) the conversation's latest and on screen. */
  stillCurrent: () => boolean;
}

/**
 * The same for inline UI — the tags an avatar wrote in its ANSWER: what the
 * viewer's browser could not draw of the conversation's latest answer goes to
 * the avatar with the next turn. Same rules as a canvas report (new lines only,
 * a moment's wait, a few reports per answer).
 */
export function queueInlineUiReport(report: InlineUiRenderReport): void {
  const { conversationId, messageId } = report;
  if (!messageId || !conversationId || !readState().user?.id) return;
  queueReport(`${conversationId}\nmessage:${messageId}`, report.content, report.errors, report.stillCurrent, (errors) =>
    send(`/api/conversations/${encodeURIComponent(conversationId)}/ui-report`, { messageId, errors }),
  );
}

function queueReport(key: string, content: string, errors: string[], stillCurrent: () => boolean, post: (errors: string[]) => void): void {
  const report = { stillCurrent };
  const lines = errors.map(clip).filter(Boolean);
  if (lines.length === 0) return;

  let entry = tracked.get(key);
  if (!entry || entry.content !== content) {
    // Another version of the canvas: whatever was waiting belonged to the old one.
    if (entry?.timer) clearTimeout(entry.timer);
    entry = { content, sent: new Set(), pending: [], reports: 0, timer: null, stillCurrent: report.stillCurrent };
    tracked.delete(key);
    tracked.set(key, entry);
    if (tracked.size > MAX_TRACKED_CANVASES) {
      const oldest = tracked.keys().next().value;
      if (oldest !== undefined) {
        const dropped = tracked.get(oldest);
        if (dropped?.timer) clearTimeout(dropped.timer);
        tracked.delete(oldest);
      }
    }
  }
  entry.stillCurrent = report.stillCurrent;
  if (entry.reports >= MAX_REPORTS_PER_CONTENT) return;
  for (const line of lines) {
    if (!entry.sent.has(line) && !entry.pending.includes(line)) entry.pending.push(line);
  }
  if (entry.pending.length === 0 || entry.timer) return;
  const waiting = entry;
  waiting.timer = setTimeout(() => {
    waiting.timer = null;
    const errors = waiting.pending.splice(0);
    if (errors.length === 0) return;
    // Not on screen any more (replaced, navigated away from): never reported, and
    // not remembered as sent — if it shows again, it is reported then.
    if (tracked.get(key) !== waiting || !waiting.stillCurrent()) return;
    for (const line of errors) waiting.sent.add(line);
    waiting.reports += 1;
    post(errors.slice(0, MAX_REPORT_ERRORS));
  }, CANVAS_REPORT_DELAY_MS);
}

function send(url: string, body: Record<string, unknown>): void {
  try {
    // Plain fetch, not `api()`: a failure here must not toast, and a 401 must
    // not log the viewer out from a background report.
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    /* no fetch, or it threw synchronously: dropped */
  }
}

/** Forget everything queued and sent (tests; a sign-out). */
export function resetCanvasRenderReports(): void {
  for (const entry of tracked.values()) if (entry.timer) clearTimeout(entry.timer);
  tracked.clear();
}
