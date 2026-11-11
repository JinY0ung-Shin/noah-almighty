/**
 * Render reports: what the VIEWER'S BROWSER could not draw of something the
 * avatar wrote — a canvas it showed (a chart spec the renderer rejected, a
 * diagram that failed to lay out) or the inline UI in an answer's text (a block
 * that failed to evaluate, an exceeded budget). The server parses and
 * statically checks a canvas and checks an answer's inline UI not at all, so a
 * failure that appears at render time was an error only the user saw — this
 * queue carries it to the avatar on the conversation's NEXT turn
 * (`buildPiTurnPreamble`), once.
 *
 * The Store keeps TWO instances: one keyed by canvas id + version, one for
 * inline UI keyed by the MESSAGE id (version always 1) — so `canvasId` below is
 * "the reported thing's id" in the second.
 *
 * Process memory on purpose: a report is a hint about what is on screen right
 * now, worthless after a restart (the client reports again when it redraws).
 * Bounded everywhere — per canvas, per conversation, overall, in time —
 * because the reporter is a browser. DB-free: the Store owns the instances and
 * does the ownership/version checks (`store/conversations.ts`).
 */

/** At most this many error lines of one report reach the avatar. */
export const MAX_CANVAS_RENDER_ERRORS = 5;
/** Each error line is cut to this many characters. */
export const MAX_CANVAS_RENDER_ERROR_CHARS = 300;
/** Canvases with a report (pending or already delivered) kept per conversation. */
export const MAX_CANVAS_RENDER_REPORTS_PER_CONVERSATION = 5;
/** Conversations with any report kept at once (the oldest goes first). */
export const MAX_CANVAS_RENDER_REPORT_CONVERSATIONS = 500;
/** A report nobody consumed is dropped after this long. */
export const CANVAS_RENDER_REPORT_TTL_MS = 24 * 60 * 60 * 1000;

// Every C0/C1 control character (newlines and tabs included), DEL, and the
// Unicode line/paragraph separators: an error line must stay ONE line of the
// turn preamble it is quoted in.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Normalize a client-sent `errors` array: strings only, control characters to
 * spaces, trimmed, empties and repeats dropped, each cut to
 * MAX_CANVAS_RENDER_ERROR_CHARS, the first MAX_CANVAS_RENDER_ERRORS kept.
 * Anything that is not an array reads as "no errors".
 */
export function sanitizeCanvasRenderErrors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const line = item.replace(CONTROL_CHARS, " ").replace(/ {2,}/g, " ").trim().slice(0, MAX_CANVAS_RENDER_ERROR_CHARS).trim();
    if (!line || out.includes(line)) continue;
    out.push(line);
    if (out.length >= MAX_CANVAS_RENDER_ERRORS) break;
  }
  return out;
}

/** How many already-delivered lines one canvas remembers, so a reload's re-report is not news. */
const MAX_DELIVERED_LINES_REMEMBERED = 4 * MAX_CANVAS_RENDER_ERRORS;

/** One canvas's waiting report, as the queue hands it to a turn. */
export interface PendingCanvasRenderReport {
  canvasId: string;
  /** The canvas version the browser was drawing (the store's current version at report time). */
  version: number;
  errors: string[];
}

interface Entry {
  canvasId: string;
  version: number;
  /** Lines waiting for the next turn (at most MAX_CANVAS_RENDER_ERRORS). */
  pending: string[];
  /** Lines a turn already heard for this version: reported again, they are not news. */
  delivered: string[];
  at: number;
}

export class CanvasRenderReportQueue {
  /** conversationId → canvasId → that canvas's ONE report. Both maps keep insertion order (oldest first). */
  private readonly byConversation = new Map<string, Map<string, Entry>>();

  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * Add a browser's report to the canvas's one waiting report. A browser sends
   * only the lines that are NEW to it (and all of them again after a reload),
   * so reports of the SAME version are merged — up to MAX_CANVAS_RENDER_ERRORS
   * waiting lines — and a line that is already waiting or was already delivered
   * for that version is not queued again. A report for ANOTHER version replaces
   * the entry: the earlier lines described content no longer on screen. An
   * empty report means the canvas draws fine now and clears it.
   */
  put(conversationId: string, canvasId: string, version: number, errors: string[]): void {
    if (errors.length === 0) {
      this.forgetCanvas(conversationId, canvasId);
      return;
    }
    const now = this.clock();
    this.dropExpired(now);
    let canvases = this.byConversation.get(conversationId);
    const known = canvases?.get(canvasId);
    const sameVersion = known && known.version === version ? known : undefined;
    const pending = sameVersion ? [...sameVersion.pending] : [];
    const delivered = sameVersion ? sameVersion.delivered : [];
    let added = false;
    for (const line of errors) {
      if (pending.length >= MAX_CANVAS_RENDER_ERRORS) break;
      if (pending.includes(line) || delivered.includes(line)) continue;
      pending.push(line);
      added = true;
    }
    if (!added) return; // nothing new: neither the order nor the clock moves
    if (!canvases) {
      canvases = new Map();
      // Overall cap: the conversation whose reports are oldest makes room.
      while (this.byConversation.size >= MAX_CANVAS_RENDER_REPORT_CONVERSATIONS) {
        const oldest = this.byConversation.keys().next().value;
        if (oldest === undefined) break;
        this.byConversation.delete(oldest);
      }
    } else {
      // Re-insert so this conversation — and this canvas — count as the most recently reported.
      this.byConversation.delete(conversationId);
      canvases.delete(canvasId);
    }
    this.byConversation.set(conversationId, canvases);
    // Per-conversation cap: a canvas with nothing waiting goes before one a turn has yet to hear, oldest first.
    while (canvases.size >= MAX_CANVAS_RENDER_REPORTS_PER_CONVERSATION) {
      const victim =
        [...canvases.values()].find((entry) => entry.pending.length === 0)?.canvasId ?? canvases.keys().next().value;
      if (victim === undefined) break;
      canvases.delete(victim);
    }
    canvases.set(canvasId, { canvasId, version, pending, delivered: [...delivered], at: now });
  }

  /**
   * The conversation's waiting reports, oldest first — each is handed out ONCE
   * (its lines move to "delivered", so a second call returns nothing). The
   * caller validates them (canvas still there, same version) and
   * `forgetCanvas`es the stale ones.
   */
  take(conversationId: string): PendingCanvasRenderReport[] {
    this.dropExpired(this.clock());
    const canvases = this.byConversation.get(conversationId);
    if (!canvases) return [];
    const out: PendingCanvasRenderReport[] = [];
    for (const entry of canvases.values()) {
      if (entry.pending.length === 0) continue;
      out.push({ canvasId: entry.canvasId, version: entry.version, errors: entry.pending });
      entry.delivered = [...entry.delivered, ...entry.pending].slice(-MAX_DELIVERED_LINES_REMEMBERED);
      entry.pending = [];
    }
    return out;
  }

  /** Drop one canvas's report (deleted, or a new version was shown — its report no longer describes it). */
  forgetCanvas(conversationId: string, canvasId: string): void {
    const canvases = this.byConversation.get(conversationId);
    if (!canvases) return;
    canvases.delete(canvasId);
    if (canvases.size === 0) this.byConversation.delete(conversationId);
  }

  /** Drop every report of a conversation (it was deleted). */
  forgetConversation(conversationId: string): void {
    this.byConversation.delete(conversationId);
  }

  /** Canvases with a report held right now, delivered-only ones included (tests + bounds). */
  get size(): number {
    let total = 0;
    for (const canvases of this.byConversation.values()) total += canvases.size;
    return total;
  }

  private dropExpired(now: number): void {
    for (const [conversationId, canvases] of this.byConversation) {
      for (const [canvasId, entry] of canvases) {
        if (now - entry.at >= CANVAS_RENDER_REPORT_TTL_MS) canvases.delete(canvasId);
      }
      if (canvases.size === 0) this.byConversation.delete(conversationId);
    }
  }
}
