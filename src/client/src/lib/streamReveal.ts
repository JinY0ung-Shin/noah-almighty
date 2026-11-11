// Paced reveal of a live answer.
//
// Text arrives from the network in bursts (a few dozen characters every
// 0.1–0.3 s, depending on the provider). Shown as it lands, the answer jerks
// forward a clause at a time. This module lets the bubble show the text a
// little BEHIND its arrival, advancing on animation frames at the rate the text
// is actually coming in, so it flows.
//
// The store is the truth and this is only a view of it: `pane.liveText` always
// holds everything that arrived, and `liveReveal` holds, per pane, how many
// characters of it the bubble shows RIGHT NOW (no entry = all of it). Stop,
// errors, folds and finalizers read the pane, never this — so nothing here can
// lose or duplicate text; the worst a bug can do is show it early.
//
// Rules (each is a requirement, see `tests/client-stream-reveal.test.ts`):
//  - 움직임 줄이기 (the app's own setting, `lib/motion.ts` — never the OS's
//    `prefers-reduced-motion`) → no pacing at all. Read when a reveal STARTS.
//  - A hidden tab gets no animation frames: text goes straight through while
//    hidden, and a frame loop that stalls is abandoned on the next arrival.
//  - Every pane paces by itself (split view).
//  - `flush` (a card arrived, a mid-turn message was delivered) and `reset`
//    (fold, stop, error, a new turn) show everything at once.
//  - At the end of a turn the remainder drains within DRAIN_SECONDS, on the
//    stored message that replaced the live bubble (`handoff`).

import { writable, type Readable } from "./store";
import { prefersReducedMotion } from "./motion";

/** Seconds of text the reveal deliberately trails the arrival by — what absorbs the bursts. */
export const REVEAL_LAG_SECONDS = 0.25;
/** Never more than this many times the arrival rate, however far behind. */
export const REVEAL_MAX_CATCH_UP = 3;
/** A finished turn's remainder is on screen within this long. */
export const REVEAL_DRAIN_SECONDS = 0.3;
/** Arrival-rate estimate before the first measurement, and its clamp (characters per second). */
const INITIAL_CPS = 120;
const MIN_CPS = 20;
const MAX_CPS = 2000;
/** Floor for the reveal speed: a trickle still moves. */
const MIN_REVEAL_CPS = 24;
/** A pause longer than this is the model thinking or a tool running, not the stream's rate. */
const RATE_GAP_SECONDS = 1.5;
/** A backlog this large is a replayed log or a paste, not a stream: skip to near its end. */
const MAX_BACKLOG = 1200;
const BACKLOG_KEEP = 240;
/** No frame for this long while text keeps arriving = frames are not running (occluded window, throttling). */
const STALL_MS = 400;
/** A frame's time step is capped, so one late frame cannot fling the text forward. */
const MAX_FRAME_SECONDS = 0.1;
/** How far a reveal position may run ahead to end on a word boundary. */
const SNAP_REACH = 12;
const BOUNDARY = /[\s.,!?;:)\]}，。、！？]/;

export interface RevealClock {
  now(): number;
  /** Schedule one frame; returns a handle for `cancel`. */
  request(callback: (time: number) => void): number;
  cancel(handle: number): void;
  /** The viewer chose 움직임 줄이기 in this app. */
  reducedMotion(): boolean;
  /** The document is hidden (no frames will run). */
  hidden(): boolean;
}

/** The browser's clock; `null` where there are no animation frames (node tests, SSR) — nothing is paced there. */
export function browserRevealClock(): RevealClock | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  if (typeof window.requestAnimationFrame !== "function") return null;
  return {
    now: () => performance.now(),
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
    reducedMotion: prefersReducedMotion,
    hidden: () => document.hidden === true,
  };
}

/**
 * Where to stop showing `text` for a reveal position `pos`: run on to the next
 * word boundary (at most SNAP_REACH characters) so a word is not shown half
 * written, and never between the two halves of a surrogate pair.
 */
export function snapReveal(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let at = Math.max(0, Math.floor(pos));
  const limit = Math.min(text.length, at + SNAP_REACH);
  while (at < limit && !BOUNDARY.test(text[at])) at += 1;
  const code = text.charCodeAt(at - 1);
  if (at < text.length && code >= 0xd800 && code <= 0xdbff) at += 1;
  return at;
}

interface Track {
  /** The text being revealed (the whole of it, as it arrived). */
  text: string;
  /** Reveal position, fractional. */
  pos: number;
  /** Published count (`pos` snapped), or -1 when nothing is published (everything shows). */
  shown: number;
  cps: number;
  /** Length and time of the last arrival, for the rate estimate. */
  arrivedLength: number;
  arrivedAt: number;
  /** The turn is over: drain within REVEAL_DRAIN_SECONDS, then drop the entry. */
  draining: boolean;
  /** Speed that empties the backlog a drain started with in REVEAL_DRAIN_SECONDS. */
  drainCps: number;
  /** This reveal started under reduced motion: it is never paced. */
  still: boolean;
  frame: number;
  lastFrameAt: number;
}

export interface RevealController {
  /** Per key, how many characters are shown; a missing key shows everything. */
  readonly shown: Readable<Record<string, number>>;
  /** The live text of `key` is now `text` (it grew). */
  push(key: string, text: string): void;
  /** Show everything of `key` now; later text is paced again. */
  flush(key: string): void;
  /** Forget `key` (a fold, a stop, an error, a new turn): everything shows, the next text starts from nothing. */
  reset(key: string): void;
  /**
   * The live turn of `from` ended and `text` now shows under `to` (the stored
   * message): carry the unrevealed remainder over and drain it. Returns whether
   * there was anything left to drain.
   */
  handoff(from: string, to: string, text: string): boolean;
  /** Show everything everywhere (the tab went hidden). */
  flushAll(): void;
  /** Characters shown for `key` (`undefined` = all) — for tests and callers that do not subscribe to the store. */
  peek(key: string): number | undefined;
}

export function createRevealController(clock: RevealClock | null): RevealController {
  const store = writable<Record<string, number>>({});
  let published: Record<string, number> = {};
  const tracks = new Map<string, Track>();

  function publish(key: string, shown: number | undefined): void {
    if (published[key] === shown) return;
    const next = { ...published };
    if (shown === undefined) delete next[key];
    else next[key] = shown;
    published = next;
    store.set(next);
  }

  function stop(track: Track): void {
    if (track.frame && clock) clock.cancel(track.frame);
    track.frame = 0;
  }

  /** Everything of `key` shows, and the track idles at the end of its text. */
  function settle(key: string, track: Track): void {
    stop(track);
    track.pos = track.text.length;
    track.shown = -1;
    publish(key, undefined);
    if (track.draining) tracks.delete(key);
  }

  function step(key: string, track: Track, time: number): void {
    track.frame = 0;
    const seconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (time - track.lastFrameAt) / 1000));
    track.lastFrameAt = time;
    const target = track.text.length;
    let backlog = target - track.pos;
    if (backlog > MAX_BACKLOG) {
      track.pos = target - BACKLOG_KEEP;
      backlog = BACKLOG_KEEP;
    }
    if (backlog > 0) {
      // Aim to stay REVEAL_LAG_SECONDS behind: at exactly that distance the
      // reveal runs at the arrival rate; further behind it speeds up (capped),
      // closer it eases off instead of catching the arrival and stuttering.
      const steady = track.cps;
      let cps = steady * Math.min(REVEAL_MAX_CATCH_UP, Math.max(0.5, backlog / Math.max(1, steady * REVEAL_LAG_SECONDS)));
      if (track.draining) cps = Math.max(cps, track.drainCps);
      track.pos = Math.min(target, track.pos + Math.max(cps, MIN_REVEAL_CPS) * seconds);
    }
    if (track.pos >= target) {
      settle(key, track);
      return;
    }
    const shown = snapReveal(track.text, track.pos);
    if (shown >= target) {
      settle(key, track);
      return;
    }
    if (shown !== track.shown) {
      track.shown = shown;
      publish(key, shown);
    }
    schedule(key, track);
  }

  function schedule(key: string, track: Track): void {
    if (!clock || track.frame) return;
    track.frame = clock.request((time) => step(key, track, time));
  }

  function newTrack(text: string, pos: number, now: number): Track {
    return {
      text,
      pos,
      shown: -1,
      cps: INITIAL_CPS,
      arrivedLength: text.length,
      arrivedAt: now,
      draining: false,
      drainCps: 0,
      still: false,
      frame: 0,
      lastFrameAt: now,
    };
  }

  function push(key: string, text: string): void {
    if (!clock) return;
    const now = clock.now();
    let track = tracks.get(key);
    if (!track || track.draining || !text.startsWith(track.text)) {
      // A reveal starts here (first text of a turn, or text that is not a
      // continuation of what is on screen): this is the moment motion is decided.
      if (track) stop(track);
      track = newTrack(text, 0, now);
      track.arrivedLength = 0;
      track.still = clock.reducedMotion();
      tracks.set(key, track);
      publish(key, undefined);
    }
    const grew = text.length - track.arrivedLength;
    if (grew > 0) {
      const gap = (now - track.arrivedAt) / 1000;
      if (track.arrivedLength > 0 && gap < RATE_GAP_SECONDS) {
        const instant = grew / Math.max(gap, 0.05);
        track.cps = Math.min(MAX_CPS, Math.max(MIN_CPS, track.cps * 0.75 + instant * 0.25));
      }
      track.arrivedLength = text.length;
      track.arrivedAt = now;
    }
    track.text = text;
    // No pacing: reduced motion, a hidden tab, or frames that stopped coming.
    const stalled = track.frame !== 0 && now - track.lastFrameAt > STALL_MS;
    if (track.still || clock.hidden() || stalled) {
      settle(key, track);
      return;
    }
    if (track.pos >= text.length) {
      settle(key, track);
      return;
    }
    if (track.shown === -1) {
      // Until now everything showed; hold the bubble exactly where it is.
      track.shown = Math.min(text.length, Math.floor(track.pos));
      track.lastFrameAt = now;
      publish(key, track.shown);
    }
    schedule(key, track);
  }

  function flush(key: string): void {
    const track = tracks.get(key);
    if (track) settle(key, track);
    else publish(key, undefined);
  }

  function reset(key: string): void {
    const track = tracks.get(key);
    if (track) stop(track);
    tracks.delete(key);
    publish(key, undefined);
  }

  function handoff(from: string, to: string, text: string): boolean {
    const track = tracks.get(from);
    const shown = track && track.shown !== -1 ? track.shown : -1;
    const still = track?.still === true;
    const onScreen = track ? track.text.slice(0, Math.max(0, shown)) : "";
    reset(from);
    if (!clock || shown < 0 || shown >= text.length || still || clock.hidden()) return false;
    // Only a text that CONTINUES what is on screen is drained; anything else
    // (the stored text differs from the streamed one) simply shows.
    if (!text.startsWith(onScreen)) return false;
    const now = clock.now();
    const next = newTrack(text, shown, now);
    next.cps = track?.cps ?? INITIAL_CPS;
    next.draining = true;
    next.drainCps = (text.length - shown) / REVEAL_DRAIN_SECONDS;
    next.shown = shown;
    tracks.set(to, next);
    publish(to, shown);
    schedule(to, next);
    return true;
  }

  function flushAll(): void {
    for (const [key, track] of Array.from(tracks)) settle(key, track);
  }

  return {
    shown: { subscribe: store.subscribe },
    push,
    flush,
    reset,
    handoff,
    flushAll,
    peek: (key) => published[key],
  };
}

/* ---------- the app's controller ---------- */

const controller = createRevealController(browserRevealClock());

/** The store's value at `[key]`: characters of that key's text to show; `undefined` = all. */
export const liveReveal = controller.shown;

/** Key of the stored message a finished turn's remainder drains on. */
export function messageRevealKey(messageId: string): string {
  return `m:${messageId}`;
}

export const noteLiveText = controller.push;
export const flushReveal = controller.flush;
export const resetReveal = controller.reset;
export const handoffReveal = (paneId: string, messageId: string, text: string): boolean =>
  controller.handoff(paneId, messageRevealKey(messageId), text);

// A hidden tab runs no animation frames: whatever was mid-reveal shows at once,
// and text arriving while hidden goes straight through (`push`).
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) controller.flushAll();
  });
}

/**
 * What the bubble shows of `text`: the first `shown` characters (`undefined` =
 * everything). Clamped — a count from an older, longer text never reads past
 * the end.
 */
export function revealedText(text: string, shown: number | undefined): string {
  if (shown === undefined || shown >= text.length) return text;
  return text.slice(0, Math.max(0, shown));
}

/**
 * The attachments whose anchor the reveal has reached. A card anchored at
 * character N belongs AFTER the first N characters, so it must not be on screen
 * before they are. Un-anchored attachments sit after the whole text, so they
 * wait for all of it. The same array comes back when nothing is held.
 */
export function revealedAttachments<T extends { anchor?: number | null }>(
  attachments: T[] | undefined,
  textLength: number,
  shown: number | undefined,
): T[] | undefined {
  if (!attachments || shown === undefined || shown >= textLength) return attachments;
  const reached = attachments.filter((att) => typeof att.anchor === "number" && Number.isFinite(att.anchor) && att.anchor <= shown);
  return reached.length === attachments.length ? attachments : reached;
}
