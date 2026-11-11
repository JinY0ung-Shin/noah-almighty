// The live "생각 과정" card's header: how long the avatar has been reasoning and
// which sub-heading it is on — without parsing the reasoning text into HTML
// while the card is closed.
//
// The time is measured HERE, per pane, from the frames as they arrive: reasoning
// runs from a `thinking` frame until the first answer text / tool / agent / task
// frame (`thinkingActive` in the pane store). It is a view-layer clock like
// `streamReveal.ts`: the pane store is not involved, and a reattached run starts
// counting from the replay (the header then simply shows no duration).

import { writable, type Readable } from "svelte/store";

export interface ThinkingClock {
  /** Finished reasoning intervals of this turn, in ms. */
  total: number;
  /** When the running interval started, or null while not reasoning. */
  since: number | null;
}

let clocks: Record<string, ThinkingClock> = {};
const clockStore = writable<Record<string, ThinkingClock>>(clocks);
const nowStore = writable<number>(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

/** `$thinkingClocks[paneId]`: that pane's live turn. */
export const thinkingClocks: Readable<Record<string, ThinkingClock>> = { subscribe: clockStore.subscribe };
/** The wall clock, advanced once a second while any pane is reasoning — name it in the markup next to the clock. */
export const thinkingNow: Readable<number> = { subscribe: nowStore.subscribe };

function syncTicker(): void {
  const running = Object.values(clocks).some((clock) => clock.since !== null);
  if (running && !ticker && typeof setInterval === "function") {
    nowStore.set(Date.now());
    ticker = setInterval(() => nowStore.set(Date.now()), 1000);
  } else if (!running && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** A frame arrived: `active` = it was reasoning. Only a change of state does anything. */
export function noteThinking(paneId: string, active: boolean, now: number = Date.now()): void {
  const clock = clocks[paneId];
  if (active) {
    if (clock?.since != null) return;
    clocks = { ...clocks, [paneId]: { total: clock?.total ?? 0, since: now } };
  } else {
    if (!clock || clock.since === null) return;
    clocks = { ...clocks, [paneId]: { total: clock.total + Math.max(0, now - clock.since), since: null } };
  }
  clockStore.set(clocks);
  syncTicker();
}

/** The live turn is over (or a new one starts): forget its clock. */
export function resetThinkingClock(paneId: string): void {
  if (!(paneId in clocks)) return;
  const next = { ...clocks };
  delete next[paneId];
  clocks = next;
  clockStore.set(clocks);
  syncTicker();
}

/** Reasoning time of `clock` so far, in ms. */
export function thinkingElapsed(clock: ThinkingClock | undefined, now: number): number {
  if (!clock) return 0;
  return clock.total + (clock.since === null ? 0 : Math.max(0, now - clock.since));
}

/** Reasoning time of the pane's live turn so far — what a finalizer stamps on the message. */
export function thinkingElapsedMs(paneId: string, now: number = Date.now()): number {
  return thinkingElapsed(clocks[paneId], now);
}

/** "12초" / "1분 5초"; "" under a second (nothing worth saying). */
export function formatThinkingDuration(ms: number | null | undefined): string {
  const seconds = Math.floor((Number(ms) || 0) / 1000);
  if (seconds < 1) return "";
  if (seconds < 60) return `${seconds}초`;
  const rest = seconds % 60;
  return rest ? `${Math.floor(seconds / 60)}분 ${rest}초` : `${Math.floor(seconds / 60)}분`;
}

const TOPIC_LINE = /^\s*\*\*([^*\n]{2,80}?)\*\*:?\s*$/;
let topicText: string | null = null;
let topicValue: string | null = null;

/**
 * The sub-heading the reasoning is on: the last line that is nothing but
 * `**…**` (how reasoning summaries title their steps). Read from the raw text —
 * no markdown parse. The last result is remembered, since the header asks on
 * every token.
 */
export function thinkingTopic(text: string | null | undefined): string | null {
  const source = text || "";
  if (source === topicText) return topicValue;
  let topic: string | null = null;
  let end = source.length;
  while (end > 0) {
    const start = source.lastIndexOf("\n", end - 1) + 1;
    // A line still being written has no closing `**` yet and is skipped.
    const match = TOPIC_LINE.exec(source.slice(start, end));
    if (match) {
      topic = match[1].trim();
      break;
    }
    end = start - 1;
  }
  topicText = source;
  topicValue = topic || null;
  return topicValue;
}
