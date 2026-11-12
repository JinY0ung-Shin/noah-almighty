// The entrance of a ```mermaid diagram of an answer (lib/mermaidBlock.ts): its
// parts arrive in order instead of all at once. Mermaid hands over
// ONE finished SVG, so only the first appearance of a diagram moves.
//
// The plan is read off the SVG mermaid really writes — classes and geometry
// attributes only, no layout:
// - A GRAPH (flowchart, state, ER, class, mindmap — they share one renderer):
//   subgraph frames first, the nodes one after the other, then each edge is
//   drawn from its start to its arrowhead, its label right behind it.
// - A SEQUENCE diagram: everything from top to bottom — the participants, then
//   each message drawn in the direction it is sent, notes and loops where they
//   stand, the bottom row of participants last.
// - Anything else (gantt, pie, …): its parts fade in, in the order mermaid
//   wrote them.
// The order of a graph is the order mermaid WROTE the nodes and edges (roughly
// the source's), not a walk of the graph. A mermaid upgrade that renames these
// classes falls back to the last form, or to one fade of the whole drawing —
// never to a broken one; tests/visual/ui-gallery.spec.ts pins the real output.
//
// When a diagram may enter, and how the steps are played: lib/uiEntrance.ts.
import { EASE_OUT, staggered, type EntranceStep } from "./uiEntrance";

/** A wipe draws a line at a near-even pace. */
const EASE_DRAW = "cubic-bezier(0.4, 0, 0.2, 1)";

const FADE_MS = 240;
const NODE_WINDOW_MS = 300;
const EDGE_START_MS = 180;
const EDGE_WINDOW_MS = 300;
const EDGE_MS = 300;
const LABEL_LAG_MS = 160;
const LABEL_MS = 200;
const SEQUENCE_WINDOW_MS = 600;
const MESSAGE_MS = 260;
const UNIT_WINDOW_MS = 500;

/** Past this many parts the drawing fades in as one (a 500-node graph is not 500 animations). */
const MAX_STEPS = 160;
/** Room for a stroke's width and an arrowhead outside the box a wipe is measured in. */
const MARGIN = "-12px";

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

function fade(el: Element, delay: number, duration = FADE_MS): EntranceStep {
  // One keyframe, pinned to the START (a lone keyframe is otherwise taken for the end): it ends at the element's own opacity.
  return { el, keyframes: [{ opacity: 0, offset: 0 }], delay, duration, easing: "ease-out" };
}

/**
 * Uncover `el` along the way it runs (`dx`, `dy`: from its start to its end), so
 * a line is drawn towards its arrowhead. A line that goes nowhere fades.
 */
function draw(el: Element, dx: number, dy: number, delay: number, duration: number): EntranceStep {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) return fade(el, delay, duration);
  // top right bottom left: the side the line ENDS on starts fully cut off.
  const cut = [MARGIN, MARGIN, MARGIN, MARGIN];
  if (Math.abs(dx) >= Math.abs(dy)) cut[dx > 0 ? 1 : 3] = "100%";
  else cut[dy > 0 ? 2 : 0] = "100%";
  return {
    el,
    keyframes: [{ clipPath: `inset(${cut.join(" ")})` }, { clipPath: `inset(${MARGIN} ${MARGIN} ${MARGIN} ${MARGIN})` }],
    delay,
    duration,
    easing: EASE_DRAW,
  };
}

function numberOf(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** From the first point of a path's `d` to its last (mermaid writes absolute M/L/C coordinates). */
function runOfPath(el: Element): { dx: number; dy: number } {
  const n = ((el.getAttribute("d") ?? "").match(NUMBER) ?? []).map(Number);
  if (n.length < 4) return { dx: 0, dy: 0 };
  return { dx: n[n.length - 2] - n[0], dy: n[n.length - 1] - n[1] };
}

function drawable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return tag !== "style" && tag !== "defs" && tag !== "marker" && tag !== "title" && tag !== "desc" && !(tag === "g" && el.children.length === 0);
}

/** Flowchart, state, ER, class, mindmap: one renderer, one shape — `g.nodes`, `g.edgePaths`, `g.edgeLabels`, `g.clusters`. */
function graphSteps(svg: Element): EntranceStep[] | null {
  const nodes = Array.from(svg.querySelectorAll("g.nodes > g.node"));
  if (nodes.length === 0) return null;
  const edges = Array.from(svg.querySelectorAll("g.edgePaths > path"));
  const labels = Array.from(svg.querySelectorAll("g.edgeLabels > *")).filter(drawable);
  const clusters = Array.from(svg.querySelectorAll("g.clusters > g.cluster"));
  const steps: EntranceStep[] = clusters.map((el) => fade(el, 0));
  nodes.forEach((el, i) => steps.push(fade(el, staggered(i, nodes.length, NODE_WINDOW_MS, 60))));
  const edgeDelay = (i: number) => EDGE_START_MS + staggered(i, edges.length, EDGE_WINDOW_MS, 70);
  edges.forEach((el, i) => {
    const { dx, dy } = runOfPath(el);
    steps.push(draw(el, dx, dy, edgeDelay(i), EDGE_MS));
  });
  // The i-th `g.edgeLabel` is the i-th edge's; what else sits there (label backgrounds) comes with the first.
  let nth = 0;
  for (const el of labels) {
    const own = el.classList.contains("edgeLabel") && nth < edges.length;
    steps.push(fade(el, (own ? edgeDelay(nth) : EDGE_START_MS) + LABEL_LAG_MS, LABEL_MS));
    if (own) nth += 1;
  }
  return steps;
}

/** The highest point of a part: the smallest `y` / `y1` it or anything in it is placed at. */
function topOf(el: Element): number {
  let top = Infinity;
  for (const part of [el, ...Array.from(el.querySelectorAll("*"))]) {
    for (const name of ["y", "y1"]) {
      const value = numberOf(part, name);
      if (value !== null && value < top) top = value;
    }
  }
  return top === Infinity ? -Infinity : top;
}

/** A sequence diagram: flat under the <svg>, and read from top to bottom. */
function sequenceSteps(svg: Element): EntranceStep[] | null {
  if (!svg.querySelector(".messageLine0, .messageLine1, .actor")) return null;
  const parts = Array.from(svg.children)
    .filter(drawable)
    .map((el, index) => ({ el, index, top: topOf(el) }))
    .sort((a, b) => a.top - b.top || a.index - b.index);
  return parts.map(({ el }, rank) => {
    const delay = staggered(rank, parts.length, SEQUENCE_WINDOW_MS, 70);
    if (el.tagName.toLowerCase() === "line" && /(^|\s)messageLine[01](\s|$)/.test(el.getAttribute("class") ?? "")) {
      const dx = (numberOf(el, "x2") ?? 0) - (numberOf(el, "x1") ?? 0);
      const dy = (numberOf(el, "y2") ?? 0) - (numberOf(el, "y1") ?? 0);
      return draw(el, dx, dy, delay, MESSAGE_MS);
    }
    return fade(el, delay);
  });
}

/** Any other diagram: its parts, in the order mermaid wrote them. A lone wrapping group is opened up. */
function unitSteps(svg: Element): EntranceStep[] {
  let units = Array.from(svg.children).filter(drawable);
  for (let depth = 0; depth < 3 && units.length > 0 && units.length < 3; depth += 1) {
    const opened = units.flatMap((el) => (el.tagName.toLowerCase() === "g" ? Array.from(el.children).filter(drawable) : [el]));
    if (opened.length <= units.length) break;
    units = opened;
  }
  return units.map((el, i) => fade(el, staggered(i, units.length, UNIT_WINDOW_MS, 50)));
}

/**
 * What moves, and how, for the mermaid diagram drawn under `root`. Reads
 * classes and attributes only — no layout — so it is the same in a test.
 */
export function planMermaidEntrance(root: ParentNode): EntranceStep[] {
  const svg = root.querySelector("svg");
  if (!svg) return [];
  const steps = graphSteps(svg) ?? sequenceSteps(svg) ?? unitSteps(svg);
  return steps.length === 0 || steps.length > MAX_STEPS ? [{ ...fade(svg, 0, 320), easing: EASE_OUT }] : steps;
}
