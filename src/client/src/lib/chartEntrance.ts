// The entrance of an inline `<chart>`: bars grow from their baseline, a line or
// an area is wiped in from the left, the slices of a pie arrive one after the
// other. Vega draws a chart as ONE static SVG string (`renderVegaSvg`) that is
// written whole into a shadow root, so there is no "previous value" to tween
// from — only the first appearance of a chart moves. A redraw (a slider, a
// theme flip) replaces the drawing at rest.
//
// Nothing here changes the drawing: every step is a Web Animations keyframe
// set on an element Vega emitted (found by the classes and ARIA roles of its
// SVG output), filled BACKWARDS only, so a finished or cancelled entrance
// leaves the sanitized markup exactly as it was written. Axes, legends and
// titles do not move — they are what the marks arrive into.
//
// When a chart may enter, and how its steps are played, is shared with the
// rest of inline UI: lib/uiEntrance.ts.
import { shadowSvg } from "./shadowSvg";
import { EASE_OUT, playSteps, staggered, type Entrance, type EntranceStep } from "./uiEntrance";

/** A wipe crosses the plot at a near-even pace, so the points it uncovers keep up with the line. */
const EASE_WIPE = "cubic-bezier(0.4, 0, 0.2, 1)";

const BAR_MS = 560;
const BAR_STAGGER_MS = 240;
const WIPE_MS = 720;
const ARC_MS = 320;
const ARC_STAGGER_MS = 320;
const ARC_SETTLE_MS = 640;
const POINT_MS = 260;
const POINT_STAGGER_MS = 320;
const FADE_MS = 280;
/** What is not the chart's main mark (value labels, rules) follows it in. */
const FOLLOW_DELAY_MS = 220;

/** Past this many marks in one group the group moves as one (a 4000-bar chart is not 4000 animations). */
const MAX_ITEM_STEPS = 300;

const WIPED = new Set(["line", "area", "trail"]);

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const COMMAND = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/**
 * The bounding box of a path Vega wrote for a rectangle, from its `d` alone
 * (no layout is read): `M x,y h w v h h -w Z`, or lines and cubic corners for a
 * rounded one — whose control points lie on the box. Null for anything else.
 */
export function pathBox(d: string): Box | null {
  let x = 0;
  let y = 0;
  let box: Box | null = null;
  const reach = (px: number, py: number) => {
    if (!box) box = { x0: px, y0: py, x1: px, y1: py };
    else {
      box.x0 = Math.min(box.x0, px);
      box.y0 = Math.min(box.y0, py);
      box.x1 = Math.max(box.x1, px);
      box.y1 = Math.max(box.y1, py);
    }
  };
  COMMAND.lastIndex = 0;
  for (let m = COMMAND.exec(d); m; m = COMMAND.exec(d)) {
    const cmd = m[1];
    const n = (m[2].match(NUMBER) ?? []).map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    if (cmd === "Z" || cmd === "z") continue;
    if (cmd === "M" || cmd === "L" || cmd === "m" || cmd === "l") {
      if (n.length === 0 || n.length % 2) return null;
      const rel = cmd === "m" || cmd === "l";
      for (let i = 0; i < n.length; i += 2) {
        x = rel ? x + n[i] : n[i];
        y = rel ? y + n[i + 1] : n[i + 1];
        reach(x, y);
      }
    } else if (cmd === "H" || cmd === "h" || cmd === "V" || cmd === "v") {
      if (n.length === 0) return null;
      for (const v of n) {
        if (cmd === "H") x = v;
        else if (cmd === "h") x += v;
        else if (cmd === "V") y = v;
        else y += v;
        reach(x, y);
      }
    } else if (cmd === "C" || cmd === "c") {
      if (n.length === 0 || n.length % 6) return null;
      for (let i = 0; i < n.length; i += 6) {
        const ox = cmd === "c" ? x : 0;
        const oy = cmd === "c" ? y : 0;
        reach(ox + n[i], oy + n[i + 1]);
        reach(ox + n[i + 2], oy + n[i + 3]);
        x = ox + n[i + 4];
        y = oy + n[i + 5];
        reach(x, y);
      }
    } else return null;
  }
  return box;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function px(n: number): string {
  return `${Number(n.toFixed(3))}px`;
}

/** `mark-rect role-mark marks` → "rect". */
function markType(group: Element): string {
  for (const name of Array.from(group.classList)) if (name.startsWith("mark-")) return name.slice(5);
  return "";
}

function items(group: Element, tag: string): Element[] {
  return Array.from(group.children).filter((child) => child.tagName.toLowerCase() === tag);
}

function allEqual(values: number[]): boolean {
  return values.every((v) => Math.abs(v - values[0]) <= 0.5);
}

/** How many of `sets` hold each value: the value held by most, and by how many; `pick` settles a tie. */
function sharedEdge(sets: Iterable<Iterable<number>>, pick: (a: number, b: number) => number): { value: number; count: number } {
  const counts = new Map<number, number>();
  for (const set of sets) for (const edge of new Set(set)) counts.set(edge, (counts.get(edge) ?? 0) + 1);
  let value = 0;
  let count = 0;
  for (const [edge, n] of counts) {
    if (n > count || (n === count && pick(edge, value) === edge)) {
      value = edge;
      count = n;
    }
  }
  return { value, count };
}

function fade(el: Element, delay: number, duration = FADE_MS): EntranceStep {
  // One keyframe, pinned to the START (a lone keyframe is otherwise taken for the end): it ends at the
  // element's own opacity, whatever Vega gave it.
  return { el, keyframes: [{ opacity: 0, offset: 0 }], delay, duration, easing: "ease-out" };
}

/**
 * Bars grow from the line they stand on. Which way they stand is read from
 * their THICKNESS — the bars of one band scale are equally wide (vertical) or
 * equally high (horizontal), whatever is stacked on what. The line is the edge
 * every category has — the zero line, also for negative and stacked bars — and
 * each bar scales about it, so a stack stays one column while it rises. Bars
 * with no line in common (ranged bars, a Gantt chart) each grow from their own
 * start. Bars of one category move together; categories follow each other
 * along the axis.
 */
function barSteps(group: Element): EntranceStep[] | null {
  const bars = items(group, "path");
  if (bars.length === 0 || bars.length !== group.children.length || bars.length > MAX_ITEM_STEPS) return null;
  const boxes: Box[] = [];
  for (const bar of bars) {
    if (bar.getAttribute("aria-roledescription") !== "bar" || bar.hasAttribute("transform")) return null;
    const box = pathBox(bar.getAttribute("d") ?? "");
    if (!box) return null;
    boxes.push(box);
  }
  const sameWidth = allEqual(boxes.map((b) => b.x1 - b.x0));
  const sameHeight = allEqual(boxes.map((b) => b.y1 - b.y0));
  let vertical = sameWidth;
  if (sameWidth === sameHeight) {
    // Thickness says nothing (one bar, equal values, a histogram of uneven bins): the side more bars share is the floor.
    const floor = sharedEdge(boxes.map((b) => [round(b.y0), round(b.y1)]), Math.max);
    const wall = sharedEdge(boxes.map((b) => [round(b.x0), round(b.x1)]), Math.min);
    vertical = floor.count >= wall.count;
  }
  const centre = (b: Box) => round(vertical ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2);
  // A category: the bars at one place on the band axis (a stack), with every edge they have along the other.
  const categories = new Map<number, { edges: number[]; start: number }>();
  for (const box of boxes) {
    const at = centre(box);
    const lo = round(vertical ? box.y0 : box.x0);
    const hi = round(vertical ? box.y1 : box.x1);
    const category = categories.get(at);
    const start = vertical ? hi : lo; // where a positive bar begins: its bottom, or its left
    if (!category) categories.set(at, { edges: [lo, hi], start });
    else {
      category.edges.push(lo, hi);
      category.start = vertical ? Math.max(category.start, start) : Math.min(category.start, start);
    }
  }
  const order = [...categories.keys()].sort((a, b) => a - b);
  const base = sharedEdge(
    [...categories.values()].map((category) => category.edges),
    vertical ? Math.max : Math.min,
  );
  const common = base.count === categories.size;
  const flat = vertical ? "scale(1, 0)" : "scale(0, 1)";
  return bars.map((el, i) => {
    const at = centre(boxes[i]);
    const pivot = common ? base.value : (categories.get(at)?.start ?? base.value);
    const about = vertical ? `translate(0px, ${px(pivot)})` : `translate(${px(pivot)}, 0px)`;
    const back = vertical ? `translate(0px, ${px(-pivot)})` : `translate(${px(-pivot)}, 0px)`;
    return {
      el,
      keyframes: [{ transform: `${about} ${flat} ${back}` }, { transform: `${about} scale(1, 1) ${back}` }],
      delay: staggered(order.indexOf(at), order.length, BAR_STAGGER_MS, 60),
      duration: BAR_MS,
      easing: EASE_OUT,
    };
  });
}

/** A line, an area — and the points drawn on them — are uncovered from the left. */
function wipe(group: Element): EntranceStep {
  return {
    el: group,
    // The box is the group's own; the negative insets keep stroke caps and a flat line inside it.
    keyframes: [{ clipPath: "inset(-20px 100% -20px -20px)" }, { clipPath: "inset(-20px -4px -20px -20px)" }],
    delay: 0,
    duration: WIPE_MS,
    easing: EASE_WIPE,
  };
}

const TRANSLATE = /^translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)\s*\)$/i;

function translateOf(el: Element): { x: number; y: number } | null {
  const m = TRANSLATE.exec(el.getAttribute("transform") ?? "");
  if (!m) return null;
  const x = Number(m[1]);
  const y = Number(m[2]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** The slices of a pie or donut arrive in turn around the circle while the whole settles into place. */
function arcSteps(group: Element): EntranceStep[] | null {
  const arcs = items(group, "path");
  if (arcs.length === 0 || arcs.length > MAX_ITEM_STEPS) return null;
  const steps = arcs.map((el, i) => ({ ...fade(el, staggered(i, arcs.length, ARC_STAGGER_MS, 70), ARC_MS) }));
  const centres = arcs.map(translateOf);
  const c = centres[0];
  // One circle (every slice is placed at the same centre) and a group Vega did not transform itself.
  if (c && !group.hasAttribute("transform") && centres.every((p) => p && Math.abs(p.x - c.x) < 0.5 && Math.abs(p.y - c.y) < 0.5)) {
    const to = `translate(${px(c.x)}, ${px(c.y)})`;
    const from = `translate(${px(-c.x)}, ${px(-c.y)})`;
    steps.push({
      el: group,
      keyframes: [{ transform: `${to} rotate(-24deg) scale(0.9) ${from}` }, { transform: `${to} rotate(0deg) scale(1) ${from}` }],
      delay: 0,
      duration: ARC_SETTLE_MS,
      easing: EASE_OUT,
    });
  }
  return steps;
}

/** The points of a scatter appear from left to right. */
function pointSteps(group: Element): EntranceStep[] | null {
  const points = items(group, "path");
  if (points.length === 0 || points.length > MAX_ITEM_STEPS) return null;
  const xs = points.map((el) => translateOf(el)?.x ?? null);
  if (xs.some((x) => x === null)) return null;
  const min = Math.min(...(xs as number[]));
  const span = Math.max(...(xs as number[])) - min;
  return points.map((el, i) => fade(el, span > 0 ? (((xs[i] as number) - min) / span) * POINT_STAGGER_MS : 0, POINT_MS));
}

/**
 * What moves, and how, for the chart drawn under `root` (Vega's SVG output).
 * Reads classes and attributes only — no layout — so it is the same in a test.
 */
export function planChartEntrance(root: ParentNode): EntranceStep[] {
  const groups = Array.from(root.querySelectorAll("g.role-mark")).filter((g) => !g.classList.contains("mark-group"));
  const wiped = groups.some((g) => WIPED.has(markType(g)));
  const lead: EntranceStep[] = [];
  const rest: Element[] = [];
  for (const group of groups) {
    const type = markType(group);
    let steps: EntranceStep[] | null = null;
    if (type === "rect") steps = barSteps(group);
    else if (WIPED.has(type) || (type === "symbol" && wiped)) steps = [wipe(group)];
    else if (type === "arc") steps = arcSteps(group);
    else if (type === "symbol") steps = pointSteps(group);
    if (steps) lead.push(...steps);
    else rest.push(group);
  }
  const follow = lead.length > 0 ? FOLLOW_DELAY_MS : 0;
  return [...lead, ...rest.map((group) => fade(group, follow))];
}

/* ---------- playing ---------- */

const NOTHING = () => {};

/**
 * Play the entrance of the chart drawn in `host`'s shadow root, once the chart
 * is on screen — a little above the bottom edge, so the marks are seen moving.
 * Returns a cancel that puts the drawing at rest.
 */
export function playChartEntrance(host: HTMLElement, entrance: Entrance): () => void {
  const root = host.shadowRoot;
  return root ? playSteps(host, planChartEntrance(root), entrance, "0px 0px -40px 0px") : NOTHING;
}

/**
 * Svelte action: draw a chart's sanitized SVG in the node's shadow root
 * (`shadowSvg`) and, when the drawing it is MOUNTED with may enter, play that.
 * A later drawing replaces it at rest.
 */
export function chartSvg(node: HTMLElement, params: { markup: string; enter: Entrance | null }) {
  const drawing = shadowSvg(node, params.markup);
  let drawn = params.markup;
  let stop = params.enter ? playChartEntrance(node, params.enter) : NOTHING;
  return {
    update(next: { markup: string; enter: Entrance | null }) {
      if (next.markup === drawn) return;
      drawn = next.markup;
      stop();
      stop = NOTHING;
      drawing.update(next.markup);
    },
    destroy() {
      stop();
    },
  };
}
