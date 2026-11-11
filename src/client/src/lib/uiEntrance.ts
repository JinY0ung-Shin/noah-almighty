// Entrances of inline UI: what moves when a piece of an answer's UI APPEARS —
// a block rising in, a number counting up, a progress bar filling, the rows of
// a table arriving, a chart's marks (lib/chartEntrance.ts plans those). This
// module is the part they share: WHEN a thing may enter, and how its steps are
// played.
//
// When: only when it appears NOW (`EntranceRule`, built by AnswerUi) — in an
// answer that is being written, once, however often that answer is mounted (the
// live bubble, then the stored message it becomes); or because the viewer
// brought it up (a tab). An answer opened from the history is drawn at rest,
// and so is a change to something that is already there.
//
// How: Web Animations keyframes filled BACKWARDS only — nothing is written to
// the element, so a finished or cancelled entrance leaves it as it was drawn —
// created paused in the task that mounted the element (no frame of the finished
// thing first) and released when it is on screen. 움직임 줄이기 (the app's own
// setting, never the OS's) draws everything at rest.
import { prefersReducedMotion } from "./motion";

/** One element's part in an entrance. */
export interface EntranceStep {
  el: Element;
  keyframes: Keyframe[];
  delay: number;
  duration: number;
  easing: string;
}

/** `--ease-out` (00-tokens.css): a fast start that settles. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Longest an entrance runs, start to rest — a remount inside it continues instead of cutting. */
export const ENTRANCE_WINDOW_MS = 900;

/** Delay of the `index`-th of `count` things spread over `window` ms (never more than `step` apart). */
export function staggered(index: number, count: number, window: number, step: number): number {
  return count > 1 ? index * Math.min(step, window / (count - 1)) : 0;
}

/* ---------- once per answer ---------- */

/**
 * Where a thing that appears now may enter, and how often. `always`: the viewer
 * brought it up (the tab they pressed) or it is a preview — every new one
 * enters. Otherwise the answer is being written: a thing enters ONCE, however
 * many times the answer is mounted.
 */
export interface EntranceRule {
  scope: string;
  always: boolean;
}

/** A permission to enter: where in the entrance to begin, and a call for the moment it starts. */
export interface Entrance {
  /** ms already played by the instance this one replaces (0: from the start). */
  offset: number;
  started(): void;
}

interface Shown {
  /** null: claimed, not started yet (still off screen). -Infinity: at rest. */
  startedAt: number | null;
}

const MAX_SCOPES = 16;
const MIN_SAME_TEXT = 24;
const MAX_SHOWN = 2000;
const scopes = new Map<string, { run: string | null; text: string; shown: Map<string, Shown> }>();

function scopeOf(scope: string) {
  let entry = scopes.get(scope);
  if (!entry) {
    entry = { run: null, text: "", shown: new Map() };
    scopes.set(scope, entry);
    while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value as string);
  }
  return entry;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** FNV-1a over the key: a chart's key is its spec — up to 200 000 characters — and only its identity is kept. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/**
 * A live answer begins in `scope` (a chat pane). What an EARLIER run drew there
 * no longer counts — the same chart asked for again enters again — while the
 * same run's bubble, remounted mid-stream, keeps what it has shown.
 */
export function openEntranceScope(scope: string, run: string | null): void {
  const entry = scopes.get(scope);
  if (entry && run && entry.run === run) return;
  scopes.delete(scope);
  scopeOf(scope).run = run;
}

/** The text of the live answer in `scope`, so far: what the stored message it becomes is recognised by. */
export function noteEntranceText(scope: string, text: string): void {
  scopeOf(scope).text = text;
}

/**
 * Is `text` the answer that was last written live in `scope` — the same text,
 * or the part of it revealed so far? A stored message that is still continues
 * the live bubble's entrances: a turn can end before a chart of its last lines
 * was drawn at all, and that chart still appears NOW.
 */
export function continuesEntranceText(scope: string, text: string): boolean {
  const entry = scopes.get(scope);
  if (!entry) return false;
  const overlap = Math.min(entry.text.length, text.length);
  // A handful of shared opening characters is not the same answer (a bubble left as it began).
  if (overlap === 0 || (overlap < MIN_SAME_TEXT && entry.text.length !== text.length)) return false;
  return entry.text.slice(0, overlap) === text.slice(0, overlap);
}

/**
 * May the thing `key` (a chart's spec, an element's place in the answer) enter, under `rule`? An answer is mounted more
 * than once — the live bubble, then the stored message it becomes — and only
 * the first drawing anywhere moves: a later instance gets nothing, or, when the
 * entrance is still running, the rest of it. `first` is false for a redraw of
 * an instance that already drew (a state change): that is shown at rest, and
 * remembered so. Under `rule.always` a first drawing enters whatever was shown
 * before.
 */
export function claimEntrance(rule: EntranceRule, key: string, first: boolean): Entrance | null {
  const { shown } = scopeOf(rule.scope);
  const id = digest(key);
  if (!first) {
    shown.set(id, { startedAt: -Infinity });
    return null;
  }
  let record = rule.always ? undefined : shown.get(id);
  if (!record) {
    record = { startedAt: null };
    shown.set(id, record);
    while (shown.size > MAX_SHOWN) shown.delete(shown.keys().next().value as string);
  }
  const mine = record;
  if (mine.startedAt === null) {
    return {
      offset: 0,
      started: () => {
        if (mine.startedAt === null) mine.startedAt = now();
      },
    };
  }
  const elapsed = now() - mine.startedAt;
  return elapsed >= 0 && elapsed < ENTRANCE_WINDOW_MS ? { offset: elapsed, started: () => {} } : null;
}

/**
 * The thing `key` is being shown ANEW in `scope` — written again, in another
 * answer: an entrance that is over no longer counts against it. (One that has
 * not started, or is still running, is the same appearance.)
 */
export function renewEntrance(scope: string, key: string): void {
  const { shown } = scopeOf(scope);
  const id = digest(key);
  const record = shown.get(id);
  if (record && record.startedAt !== null && now() - record.startedAt >= ENTRANCE_WINDOW_MS) shown.delete(id);
}

/** Test seam: forget every scope. */
export function resetEntrances(): void {
  scopes.clear();
}

/* ---------- playing ---------- */

const NOTHING = () => {};

/**
 * Call `show` once `host` is on screen (any part of it — never a share of its
 * height: something taller than the window would not reach it). Without an
 * IntersectionObserver there is no telling, and it is shown at once. Returns a
 * cancel.
 */
export function onScreen(host: Element, show: () => void, rootMargin = "0px"): () => void {
  if (typeof IntersectionObserver === "undefined") {
    show();
    return NOTHING;
  }
  let observer: IntersectionObserver | null = new IntersectionObserver(
    (entries) => {
      if (!observer || !entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      observer = null;
      show();
    },
    { threshold: 0, rootMargin },
  );
  observer.observe(host);
  return () => {
    observer?.disconnect();
    observer = null;
  };
}

/**
 * Play `steps`. The elements are held at their first keyframe from the same
 * task that drew them and released when `host` is on screen: something drawn
 * below the fold enters when it is scrolled to. Returns a cancel that puts
 * everything at rest.
 */
export function playSteps(host: Element, steps: EntranceStep[], entrance: Entrance, rootMargin = "0px"): () => void {
  if (prefersReducedMotion()) return NOTHING;
  const animations: Animation[] = [];
  // An entrance is decoration: whatever goes wrong while it is set up (no Web
  // Animations, a stand-in `animate` that cannot pause, a keyframe the browser
  // refuses) leaves the element as it was drawn — it never breaks the drawing.
  try {
    for (const step of steps) {
      if (typeof step.el.animate !== "function") return NOTHING;
      // Continuing an entrance: a step that is already over stays over (played again, it would rewind).
      if (entrance.offset > 0 && entrance.offset >= step.delay + step.duration) continue;
      const animation = step.el.animate(step.keyframes, { duration: step.duration, delay: step.delay, easing: step.easing, fill: "backwards" });
      animations.push(animation);
      animation.pause();
    }
  } catch {
    for (const animation of animations) {
      try {
        animation.cancel();
      } catch {
        /* a stand-in that cannot cancel either */
      }
    }
    return NOTHING;
  }
  if (animations.length === 0) return NOTHING;

  const start = () => {
    entrance.started();
    for (const animation of animations) animation.play();
  };
  let release = NOTHING;
  if (entrance.offset > 0) {
    // The rest of an entrance another instance began: it is not held back for the viewport again.
    for (const animation of animations) animation.currentTime = entrance.offset;
    start();
  } else release = onScreen(host, start, rootMargin);
  return () => {
    release();
    for (const animation of animations) animation.cancel();
  };
}

/* ---------- the entrances of plain elements ---------- */

const RISE_MS = 260;
const FILL_MS = 600;
const ROW_MS = 220;
const ROW_STAGGER_MS = 30;
/** Rows past these arrive with the table, at rest: a long table is not a long wait. */
const MAX_ROWS = 12;
export const COUNT_MS = 700;

/** A block of UI rises into place. One keyframe each way: it ends at the element's own values. */
export function riseSteps(el: Element, delay = 0): EntranceStep[] {
  return [{ el, keyframes: [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0px)" }], delay, duration: RISE_MS, easing: EASE_OUT }];
}

/**
 * A progress bar fills from nothing to the width it was given. One keyframe,
 * pinned to the START: a lone keyframe without an offset is taken for the END
 * of the animation, which would empty the bar instead.
 */
export function fillSteps(el: Element): EntranceStep[] {
  return [{ el, keyframes: [{ width: "0%", offset: 0 }], delay: 0, duration: FILL_MS, easing: EASE_OUT }];
}

/** The first rows of a table body arrive one after the other. */
export function rowSteps(body: Element): EntranceStep[] {
  return Array.from(body.children)
    .slice(0, MAX_ROWS)
    .map((el, i) => ({ el, keyframes: [{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0px)" }], delay: i * ROW_STAGGER_MS, duration: ROW_MS, easing: EASE_OUT }));
}

/**
 * Action (attached with `useAction`): the element enters when it is MOUNTED and `rule` lets the
 * thing `key` enter. What it does is `steps` (read off the element as mounted);
 * a later change of the element is not an entrance.
 */
export function enter(node: Element, params: { rule: EntranceRule | null; key: string; steps: (node: Element) => EntranceStep[] }) {
  const entrance = params.rule ? claimEntrance(params.rule, params.key, true) : null;
  const stop = entrance ? playSteps(node, params.steps(node), entrance) : NOTHING;
  return { destroy: stop };
}

/**
 * Action (attached with `useAction`) for a block of an answer's UI: each of its top-level components
 * rises in as it appears — those it is mounted with (a little apart), and each
 * one that is added later, while the answer is still being written or because
 * the viewer changed something. A component is named by its place in the block,
 * which is the same in the live bubble and in the stored message.
 */
export function enterChildren(node: Element, params: { rule: EntranceRule | null; key: string }) {
  let rule = params.rule;
  const stops = new Map<Element, () => void>();
  const play = (child: Element, delay: number) => {
    if (!rule || stops.has(child)) return;
    const index = Array.prototype.indexOf.call(node.children, child);
    const entrance = claimEntrance(rule, `${params.key}#${index}`, true);
    if (entrance) stops.set(child, playSteps(child, riseSteps(child, delay), entrance));
  };
  Array.from(node.children).forEach((child, i) => play(child, Math.min(i, 4) * 40));
  const observer =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          for (const record of records) {
            for (const removed of Array.from(record.removedNodes)) {
              stops.get(removed as Element)?.();
              stops.delete(removed as Element);
            }
            for (const added of Array.from(record.addedNodes)) if (added.nodeType === 1 && added.parentNode === node) play(added as Element, 0);
          }
        });
  observer?.observe(node, { childList: true });
  return {
    update(next: { rule: EntranceRule | null; key: string }) {
      rule = next.rule;
    },
    destroy() {
      observer?.disconnect();
      for (const stop of stops.values()) stop();
      stops.clear();
    },
  };
}

/* ---------- a number counting up ---------- */

const NUMBER_IN_TEXT = /\d[\d,]*(?:\.\d+)?/g;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * A value that is ONE number with something around it ("605만원", "+12.4%",
 * "1,234") → the text at each point of the way up from zero, in the number's
 * own format (its decimals, its thousands separators). Null for anything else —
 * a date, a ratio, a word — which is not counted.
 */
export function countUpFormat(text: string): ((progress: number) => string) | null {
  const found = text.match(NUMBER_IN_TEXT);
  if (!found || found.length !== 1) return null;
  const raw = found[0];
  const grouped = GROUPED.test(raw);
  if (raw.includes(",") && !grouped) return null;
  const target = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(target) || target === 0) return null;
  const decimals = raw.includes(".") ? raw.length - raw.indexOf(".") - 1 : 0;
  const at = text.indexOf(raw);
  const head = text.slice(0, at);
  const tail = text.slice(at + raw.length);
  return (progress) => {
    const fixed = (target * Math.min(1, Math.max(0, progress))).toFixed(decimals);
    const [whole, fraction] = fixed.split(".");
    const number = (grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole) + (fraction ? `.${fraction}` : "");
    // "-0" on the way to "-2" reads as a mistake.
    const lead = Number(fixed) === 0 ? head.replace(/[-−]$/, "") : head;
    return `${lead}${number}${tail}`;
  };
}

/**
 * Count a value up: `show` is handed the text to display on every frame and
 * null when the value itself is to be shown again (the end). It starts when
 * `host` is on screen. Needs an IntersectionObserver — where there is none
 * (a test's DOM) nothing can be on screen, and the value is simply shown.
 * Returns a cancel, which shows nothing more.
 */
export function countUp(host: Element, format: (progress: number) => string, entrance: Entrance, show: (text: string | null) => void): () => void {
  if (prefersReducedMotion() || typeof IntersectionObserver === "undefined" || typeof requestAnimationFrame !== "function") return NOTHING;
  if (entrance.offset >= COUNT_MS) return NOTHING;
  const eased = (elapsed: number) => 1 - Math.pow(1 - Math.min(1, elapsed / COUNT_MS), 3);
  show(format(eased(entrance.offset)));
  let frame = 0;
  let cancelled = false;
  let since = 0;
  const tick = (time: number) => {
    if (cancelled) return;
    const elapsed = entrance.offset + (time - since);
    if (elapsed >= COUNT_MS) {
      show(null);
      return;
    }
    show(format(eased(elapsed)));
    frame = requestAnimationFrame(tick);
  };
  const begin = () => {
    entrance.started();
    frame = requestAnimationFrame((time) => {
      since = time;
      tick(time);
    });
  };
  const release = entrance.offset > 0 ? (begin(), NOTHING) : onScreen(host, begin);
  return () => {
    cancelled = true;
    release();
    if (frame) cancelAnimationFrame(frame);
  };
}
