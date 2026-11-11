/**
 * `<svg>` drawings inside inline UI: the ALLOWLISTS (elements, the
 * attributes each one takes, what may sit inside what) and the SHAPE every
 * attribute value must have. One home, read by the static check (`check.ts`),
 * the renderer (`svgRender.ts`) and the manual (`svgReference`).
 *
 * The source is written by a model and is untrusted, so nothing here is a
 * blocklist: an element, an attribute or a value passes only when it matches a
 * grammar listed below, and what reaches the page is the value REBUILT from the
 * parsed parts (a number is re-printed, a colour function re-assembled, a
 * `url(#id)` rewritten to the widget's own id namespace) — never the text the
 * model wrote. There is no `style`, `class`, `href` or event attribute, no
 * `<script>`/`<style>`/`<foreignObject>`/`<image>`/`<a>`/`<use>`, no animation
 * and no filter; a reference can only be `url(#id)` to an element of the SAME
 * drawing.
 *
 * Cost is bounded too: at most MAX_SVG_NODES elements and MAX_SVG_CHARS of
 * attribute + text characters per `<svg>`, and a resource (clipPath, mask,
 * marker, pattern) may not reference another resource — only a gradient — so
 * nested references cannot multiply the work under the node cap. `<use>` is
 * left out for the same reason (nested `<use>` is exponential).
 */
import { nearest } from "./names.js";
import { SVG_PAINT_TOKENS, svgPaintToken } from "./style.js";

/** Elements one `<svg>` may draw (after `{#each}` expansion). */
export const MAX_SVG_NODES = 500;
/** Attribute + text characters one `<svg>` may carry. */
export const MAX_SVG_CHARS = 60_000;
/** Longest path `d` / `points` list. */
export const MAX_SVG_PATH_CHARS = 4000;
/** Largest coordinate magnitude. */
export const MAX_SVG_COORD = 1_000_000;
const MAX_VALUE_CHARS = 120;
const MAX_TRANSFORM_CHARS = 300;
const MAX_TRANSFORM_FUNCTIONS = 8;
const MAX_DASHES = 12;

/** The shape of an attribute's value. An array is an enum of exact words. */
export type SvgKind =
  | "len" // a number, optionally with px, % or em
  | "num" // a bare number
  | "unit" // 0–1 (opacity)
  | "offset" // 0–1 or 0%–100% (a gradient stop)
  | "paint" // a colour, none, or url(#id)
  | "color" // a colour (no url)
  | "dash" // none, or a list of dash lengths
  | "points" // x,y pairs
  | "path" // path data
  | "transform" // transform functions with numeric arguments
  | "id" // a name other attributes refer to
  | "ref" // none, or url(#id)
  | "viewBox" // four numbers
  | "orient" // auto | auto-start-reverse | degrees
  | readonly string[];

export type SvgValue =
  /** `value` is the text to write; `ref` / `id` is the BARE id a caller must namespace (then `value` is not used as-is). */
  { ok: true; value: string; ref?: string; id?: string } | { ok: false; error: string };

/* ───────────────────────── value grammars ───────────────────────── */

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d{1,3})?$/;
const LEN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d{1,3})?)(px|%|em)?$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const URL_REF = /^url\(\s*#([A-Za-z][A-Za-z0-9_-]{0,39})\s*\)$/;
const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FN = /^(rgb|rgba|hsl|hsla)\(([^()]{1,80})\)$/i;
const COLOR_ARG = /^[+-]?(?:\d+\.?\d*|\.\d+)(%|deg)?$/;
const PATH = /^[Mm][MmZzLlHhVvCcSsQqTtAa0-9eE+\-.,\s]*$/;
const TRANSFORM_FN = /\s*([A-Za-z]+)\s*\(([^()]*)\)\s*,?/y;

const TRANSFORM_ARGS: Record<string, readonly number[]> = {
  translate: [1, 2],
  scale: [1, 2],
  rotate: [1, 3],
  skewX: [1],
  skewY: [1],
  matrix: [6],
};

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A finite number within the coordinate range, or null. */
function parseNum(text: string): number | null {
  if (!NUM.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && Math.abs(n) <= MAX_SVG_COORD ? n : null;
}

/** A number as it is written out: at most 4 decimals, never an exponent, never `-0`. */
function fmt(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return String(r === 0 ? 0 : r);
}

/** A list of numbers separated by spaces and/or commas, or null when any item is not one. */
function parseNums(text: string, max: number): number[] | null {
  const parts = text.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length > max) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = parseNum(p);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

const fail = (error: string): SvgValue => ({ ok: false, error });
const pass = (value: string): SvgValue => ({ ok: true, value });

const COLOR_HELP = `a token (${SVG_PAINT_TOKENS.join(", ")}), #hex, rgb(…), hsl(…), currentColor, transparent or none`;

function color(text: string, allowUrl: boolean): SvgValue {
  const lower = text.toLowerCase();
  if (lower === "none" || lower === "transparent") return pass(lower);
  if (lower === "currentcolor") return pass("currentColor");
  const token = svgPaintToken(text);
  if (token) return pass(token);
  if (HEX.test(text)) return pass(lower);
  const fn = COLOR_FN.exec(text);
  if (fn) {
    const args = fn[2].split(/[\s,/]+/).filter((p) => p !== "");
    if ((args.length === 3 || args.length === 4) && args.every((a) => COLOR_ARG.test(a))) {
      const name = fn[1].toLowerCase().slice(0, 3);
      return pass(`${name}(${args.slice(0, 3).join(" ")}${args.length === 4 ? ` / ${args[3]}` : ""})`);
    }
    return fail(`is not a valid colour function — write rgb(r g b), rgb(r g b / a) or hsl(h s% l%) with plain numbers`);
  }
  if (allowUrl) {
    const ref = URL_REF.exec(text);
    if (ref) return { ok: true, value: "", ref: ref[1] };
    if (/^url\(/i.test(text)) return fail(`may only reference an element of this drawing as url(#id) — no other URL`);
  }
  return fail(`must be ${COLOR_HELP}${allowUrl ? ", or url(#id) of a gradient/pattern in this drawing" : ""} (CSS colour names like "red" are not accepted)`);
}

function transform(text: string): SvgValue {
  if (text.length > MAX_TRANSFORM_CHARS) return fail(`is too long (limit ${MAX_TRANSFORM_CHARS} chars)`);
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    TRANSFORM_FN.lastIndex = at;
    const m = TRANSFORM_FN.exec(text);
    if (!m) break;
    const name = m[1];
    const counts = hasOwn(TRANSFORM_ARGS, name) ? TRANSFORM_ARGS[name] : null;
    const args = parseNums(m[2], 6);
    if (!counts || !args || !counts.includes(args.length) || out.length >= MAX_TRANSFORM_FUNCTIONS) {
      return fail(`must be up to ${MAX_TRANSFORM_FUNCTIONS} of translate(x y), scale(x y), rotate(deg cx cy), skewX(deg), skewY(deg), matrix(a b c d e f) with numeric arguments`);
    }
    out.push(`${name}(${args.map(fmt).join(" ")})`);
    at = TRANSFORM_FN.lastIndex;
  }
  if (out.length === 0 || text.slice(at).trim() !== "") {
    return fail(`must be transform functions with numeric arguments, e.g. "rotate(45 50 50) translate(10 0)"`);
  }
  return pass(out.join(" "));
}

/**
 * Validate one attribute value against its kind and return it REBUILT.
 * `raw` is the source string or what an `{expr}` evaluated to. English errors
 * say what is wrong and what to write instead. Never throws; linear in the
 * value's (capped) length.
 */
export function svgAttrValue(kind: SvgKind, raw: unknown): SvgValue {
  let text: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return fail("is not a finite number (NaN or Infinity)");
    if (Math.abs(raw) > MAX_SVG_COORD) return fail(`is out of range (limit ±${MAX_SVG_COORD})`);
    text = fmt(raw);
  } else if (typeof raw === "string") {
    text = raw.trim();
  } else {
    return fail(raw === true ? "needs a value" : "must be a string or a number");
  }
  const cap = kind === "path" || kind === "points" ? MAX_SVG_PATH_CHARS : kind === "transform" ? MAX_TRANSFORM_CHARS : MAX_VALUE_CHARS;
  if (text.length > cap) return fail(`is too long (limit ${cap} chars)`);
  if (text === "") return fail("is empty");

  if (typeof kind !== "string") {
    return kind.includes(text) ? pass(text) : fail(`must be one of ${kind.join(", ")}`);
  }
  switch (kind) {
    case "num": {
      const n = parseNum(text);
      return n === null ? fail(`must be a number within ±${MAX_SVG_COORD}`) : pass(fmt(n));
    }
    case "len": {
      const m = LEN.exec(text);
      const n = m ? parseNum(m[1]) : null;
      return m && n !== null ? pass(fmt(n) + (m[2] ?? "")) : fail(`must be a number, optionally with px, % or em (e.g. 12, "50%", "0.35em")`);
    }
    case "unit": {
      const n = parseNum(text);
      return n !== null && n >= 0 && n <= 1 ? pass(fmt(n)) : fail("must be a number from 0 to 1");
    }
    case "offset": {
      const m = LEN.exec(text);
      const n = m && m[2] !== "px" && m[2] !== "em" ? parseNum(m[1]) : null;
      const max = m && m[2] === "%" ? 100 : 1;
      return m && n !== null && n >= 0 && n <= max ? pass(fmt(n) + (m[2] ?? "")) : fail(`must be 0–1 or 0%–100%`);
    }
    case "paint":
      return color(text, true);
    case "color":
      return color(text, false);
    case "dash": {
      if (text === "none") return pass("none");
      const nums = parseNums(text, MAX_DASHES);
      // A pattern shorter than one unit would cut a long stroke into millions of dashes.
      if (!nums || nums.length === 0 || nums.some((n) => n < 0) || nums.reduce((a, b) => a + b, 0) < 1) {
        return fail(`must be none or up to ${MAX_DASHES} non-negative numbers that add up to at least 1 (e.g. "4 2")`);
      }
      return pass(nums.map(fmt).join(" "));
    }
    case "points": {
      const nums = parseNums(text, MAX_SVG_PATH_CHARS);
      if (!nums || nums.length < 2 || nums.length % 2 !== 0) return fail(`must be x,y number pairs (e.g. "0,0 10,5 20,0")`);
      return pass(nums.map(fmt).join(" "));
    }
    case "path":
      return PATH.test(text) ? pass(text) : fail(`must be path data: commands M L H V C S Q T A Z with numbers, starting with M (e.g. "M 10 10 L 90 10")`);
    case "transform":
      return transform(text);
    case "id":
      return ID.test(text) ? { ok: true, value: "", id: text } : fail("must start with a letter and use only letters, digits, - and _ (at most 40 chars)");
    case "ref": {
      if (text === "none") return pass("none");
      const ref = URL_REF.exec(text);
      return ref ? { ok: true, value: "", ref: ref[1] } : fail("must be url(#id) of an element in this drawing, or none");
    }
    case "viewBox": {
      const nums = parseNums(text, 4);
      if (!nums || nums.length !== 4 || nums[2] <= 0 || nums[3] <= 0) return fail(`must be four numbers "minX minY width height" with a positive width and height, e.g. "0 0 200 120"`);
      return pass(nums.map(fmt).join(" "));
    }
    case "orient": {
      if (text === "auto" || text === "auto-start-reverse") return pass(text);
      const n = parseNum(text);
      return n === null ? fail("must be auto, auto-start-reverse or an angle in degrees") : pass(fmt(n));
    }
  }
}

/* ───────────────────────── elements and attributes ───────────────────────── */

export interface SvgElementSpec {
  attrs: Readonly<Record<string, SvgKind>>;
  /** Elements it may contain. */
  children: readonly string[];
  /** Its children may be text and `{expr}`. */
  text?: boolean;
  /** A definition other elements refer to by `url(#id)`; its content may not refer to another resource. */
  resource?: boolean;
}

const UNITS = ["userSpaceOnUse", "objectBoundingBox"] as const;

/** Presentation attributes of everything that is drawn. */
const PAINT: Record<string, SvgKind> = {
  id: "id",
  fill: "paint",
  stroke: "paint",
  "stroke-width": "len",
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  "stroke-dasharray": "dash",
  "stroke-dashoffset": "num",
  "stroke-miterlimit": "num",
  opacity: "unit",
  "fill-opacity": "unit",
  "stroke-opacity": "unit",
  "fill-rule": ["nonzero", "evenodd"],
  "clip-rule": ["nonzero", "evenodd"],
  transform: "transform",
  "clip-path": "ref",
  mask: "ref",
  visibility: ["visible", "hidden"],
};
const SHAPE: Record<string, SvgKind> = { ...PAINT, "vector-effect": ["none", "non-scaling-stroke"] };
/** Only a marker at each END of a line: `marker-mid` would draw one per vertex. */
const MARKERS: Record<string, SvgKind> = { "marker-start": "ref", "marker-end": "ref" };
const FONT: Record<string, SvgKind> = {
  x: "len",
  y: "len",
  dx: "len",
  dy: "len",
  "text-anchor": ["start", "middle", "end"],
  "dominant-baseline": ["auto", "middle", "central", "hanging", "alphabetic", "ideographic", "mathematical"],
  "font-size": "len",
  "font-weight": ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
  "font-style": ["normal", "italic"],
};
const BOX: Record<string, SvgKind> = { x: "len", y: "len", width: "len", height: "len" };

const SHAPES = ["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"] as const;
const GRAPHICS = [...SHAPES, "text", "g"] as const;
const RESOURCES = ["linearGradient", "radialGradient", "clipPath", "mask", "marker", "pattern"] as const;
const META = ["title", "desc"] as const;
const ANYWHERE = [...GRAPHICS, "defs", ...RESOURCES, ...META] as const;

const TABLE: Record<string, SvgElementSpec> = {
  g: { attrs: PAINT, children: ANYWHERE },
  defs: { attrs: {}, children: [...GRAPHICS, ...RESOURCES] },
  path: { attrs: { ...SHAPE, ...MARKERS, d: "path" }, children: META },
  rect: { attrs: { ...SHAPE, ...BOX, rx: "len", ry: "len" }, children: META },
  circle: { attrs: { ...SHAPE, cx: "len", cy: "len", r: "len" }, children: META },
  ellipse: { attrs: { ...SHAPE, cx: "len", cy: "len", rx: "len", ry: "len" }, children: META },
  line: { attrs: { ...SHAPE, ...MARKERS, x1: "len", y1: "len", x2: "len", y2: "len" }, children: META },
  polyline: { attrs: { ...SHAPE, ...MARKERS, points: "points" }, children: META },
  polygon: { attrs: { ...SHAPE, points: "points" }, children: META },
  text: { attrs: { ...PAINT, ...FONT }, children: ["tspan", ...META], text: true },
  tspan: { attrs: { ...PAINT, ...FONT }, children: [], text: true },
  title: { attrs: {}, children: [], text: true },
  desc: { attrs: {}, children: [], text: true },
  linearGradient: {
    attrs: { id: "id", x1: "len", y1: "len", x2: "len", y2: "len", gradientUnits: UNITS, gradientTransform: "transform", spreadMethod: ["pad", "reflect", "repeat"] },
    children: ["stop"],
  },
  radialGradient: {
    attrs: { id: "id", cx: "len", cy: "len", r: "len", fx: "len", fy: "len", gradientUnits: UNITS, gradientTransform: "transform", spreadMethod: ["pad", "reflect", "repeat"] },
    children: ["stop"],
  },
  stop: { attrs: { offset: "offset", "stop-color": "color", "stop-opacity": "unit" }, children: [] },
  clipPath: { attrs: { id: "id", clipPathUnits: UNITS }, children: [...SHAPES, "text"], resource: true },
  mask: { attrs: { id: "id", ...BOX, maskUnits: UNITS, maskContentUnits: UNITS }, children: GRAPHICS, resource: true },
  marker: {
    attrs: { id: "id", markerWidth: "len", markerHeight: "len", refX: "len", refY: "len", orient: "orient", markerUnits: ["strokeWidth", "userSpaceOnUse"], viewBox: "viewBox" },
    children: GRAPHICS,
    resource: true,
  },
  pattern: {
    attrs: { id: "id", ...BOX, patternUnits: UNITS, patternContentUnits: UNITS, patternTransform: "transform", viewBox: "viewBox" },
    children: GRAPHICS,
    resource: true,
  },
};

for (const spec of Object.values(TABLE)) {
  for (const kind of Object.values(spec.attrs)) if (typeof kind !== "string") Object.freeze(kind);
  Object.freeze(spec.attrs);
  Object.freeze(spec.children);
  Object.freeze(spec);
}

/** Every element allowed inside `<svg>`, by name. A null-prototype map. */
export const SVG_ELEMENTS: Readonly<Record<string, SvgElementSpec>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, SvgElementSpec>, TABLE),
);
export const SVG_TAGS: readonly string[] = Object.freeze(Object.keys(TABLE));
/** What the `<svg>` root itself may contain. */
export const SVG_ROOT_CHILDREN: readonly string[] = Object.freeze([...ANYWHERE]);

/** Which elements each referencing attribute may point at. */
export const SVG_REF_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  fill: ["linearGradient", "radialGradient", "pattern"],
  stroke: ["linearGradient", "radialGradient", "pattern"],
  "clip-path": ["clipPath"],
  mask: ["mask"],
  "marker-start": ["marker"],
  "marker-end": ["marker"],
});
const GRADIENTS: readonly string[] = ["linearGradient", "radialGradient"];
/** Attributes that may not be used INSIDE a resource (they would chain one resource into another). */
const NOT_IN_RESOURCE: readonly string[] = ["clip-path", "mask", "marker-start", "marker-end"];

/** Why a familiar element is refused, and what to do instead. */
const REFUSED: Record<string, string> = {
  svg: "a nested <svg> is not supported — group with <g transform=\"…\"> instead",
  script: "scripts never run in a widget — bind attributes to state with {expr} instead",
  style: "stylesheets are not supported — set fill, stroke, font-size … as attributes",
  foreignObject: "HTML cannot be embedded in a drawing — put widget components next to the <svg>",
  image: "images cannot be embedded in a drawing — use the widget's <image> component next to it",
  use: "<use> is not supported — repeat shapes with {#each} instead",
  symbol: "<symbol> is not supported (there is no <use>) — repeat shapes with {#each} instead",
  a: "links are not available inside a drawing — put a <link> or <button href> next to the <svg>",
  filter: "filters are not supported",
  textPath: "text on a path is not supported",
  switch: "<switch> is not supported — use {#if}",
};

function refusal(tag: string): string | null {
  if (hasOwn(REFUSED, tag)) return REFUSED[tag];
  if (/^(animate|set$|mpath$|discard$)/.test(tag)) return "animation elements are not supported — a drawing moves by binding attributes to state ({expr})";
  if (/^fe[A-Z]/.test(tag)) return "filters are not supported";
  return null;
}

export function svgElementSpec(tag: string): SvgElementSpec | undefined {
  return hasOwn(SVG_ELEMENTS, tag) ? SVG_ELEMENTS[tag] : undefined;
}

/** What `parent` (an element name, or "svg" for the root) may contain. */
function childrenOf(parent: string): readonly string[] {
  return parent === "svg" ? SVG_ROOT_CHILDREN : (svgElementSpec(parent)?.children ?? []);
}

/** Whether text and `{expr}` may sit directly inside `parent`. */
export function svgTakesText(parent: string): boolean {
  return svgElementSpec(parent)?.text === true;
}

export function svgIsResource(tag: string): boolean {
  return svgElementSpec(tag)?.resource === true;
}

/**
 * Why `tag` may not appear inside `parent` (null when it may). `inResource`:
 * the place is inside a clipPath / mask / marker / pattern.
 */
export function svgElementProblem(tag: string, parent: string, inResource: boolean): string | null {
  const spec = svgElementSpec(tag);
  if (!spec) {
    const why = refusal(tag);
    if (why) return `<${tag}> is not allowed inside <svg>: ${why}.`;
    const hint = nearest(tag, SVG_TAGS);
    return `<${tag}> is not an SVG element a widget can draw.${hint ? ` Did you mean <${hint}>?` : ""} Allowed inside <svg>: ${SVG_TAGS.join(", ")}.`;
  }
  if (inResource && (spec.resource || tag === "defs" || GRADIENTS.includes(tag))) {
    return `<${tag}> cannot be defined inside another <clipPath>, <mask>, <marker> or <pattern>. Move it to the <svg>'s <defs>.`;
  }
  const allowed = childrenOf(parent);
  if (!allowed.includes(tag)) {
    return `<${tag}> cannot be a child of <${parent}>. <${parent}> takes ${allowed.length ? allowed.map((t) => `<${t}>`).join(", ") : "no elements"}${svgTakesText(parent) ? " and text" : ""}.`;
  }
  return null;
}

/**
 * Why attribute `name` cannot be written on `tag` at all (null when it can);
 * its VALUE is judged by `svgAttrValue` with the returned kind.
 */
export function svgAttrKind(tag: string, name: string, inResource: boolean): { kind: SvgKind } | { problem: string } {
  const spec = svgElementSpec(tag);
  if (!spec) return { problem: `<${tag}> is not an allowed SVG element.` };
  if (!hasOwn(spec.attrs, name)) {
    const names = Object.keys(spec.attrs);
    const note =
      name === "style" || name === "class" || name === "className"
        ? " There is no style/class: set fill, stroke, opacity, font-size … as attributes."
        : /^on/i.test(name)
          ? " A drawing has no events: put a widget control (slider, button) next to it and bind attributes to state."
          : name === "href" || name === "xlink" || name === "src"
            ? " A drawing cannot link or load anything; refer to a gradient/clipPath/mask/marker/pattern of the same drawing as url(#id)."
            : name === "xmlns"
              ? " It is not needed — remove it."
              : name === "marker-mid"
                ? " Only marker-start and marker-end exist."
                : name === "font-family"
                  ? " Text uses the app's font."
                  : "";
    const hint = note ? null : nearest(name, names);
    return {
      problem: `<${tag}> inside <svg> has no attribute "${name}".${hint ? ` Did you mean "${hint}"?` : ""}${note} Attributes: ${names.length ? names.join(", ") : "(none)"}.`,
    };
  }
  if (inResource && NOT_IN_RESOURCE.includes(name)) {
    return { problem: `"${name}" cannot be used inside a <clipPath>, <mask>, <marker> or <pattern> (a resource may not use another one). Apply it to the element that uses the resource instead.` };
  }
  return { kind: spec.attrs[name] };
}

/**
 * Why `attr="url(#id)"` on an element may not point at a `target` element
 * (null when it may). Inside a resource only a gradient may be referenced.
 */
export function svgRefProblem(attr: string, id: string, target: string | undefined, inResource: boolean): string | null {
  const wanted = hasOwn(SVG_REF_TARGETS, attr) ? SVG_REF_TARGETS[attr] : [];
  if (target === undefined) return `${attr}="url(#${id})": this drawing has no element with id="${id}". Define it (usually inside <defs>) in the SAME <svg>.`;
  if (!wanted.includes(target)) return `${attr}="url(#${id})" points at a <${target}>; ${attr} can reference only ${wanted.map((t) => `<${t}>`).join(" or ")}.`;
  if (inResource && !GRADIENTS.includes(target)) {
    return `${attr}="url(#${id})" inside a <clipPath>, <mask>, <marker> or <pattern> may reference only a gradient, not a <${target}> (resources cannot be nested).`;
  }
  return null;
}

/* ───────────────────────── manual text ───────────────────────── */

/**
 * English reference of what an `<svg>` may contain, generated from the tables
 * above (the manual embeds it through `widgetComponentReference`). Terse on
 * purpose — it rides the manual page's size cap, and the checker's own errors
 * list an element's attributes when one is wrong.
 */
export function svgReference(): string {
  const text = Object.keys(FONT).filter((name) => !hasOwn(BOX, name) && name !== "dx" && name !== "dy");
  // `stroke-width stroke-linecap …` → `stroke-(width linecap …)`.
  // The rarely needed ones are left to the checker's own attribute list.
  const rare = ["stroke-miterlimit", "clip-rule", "visibility", "vector-effect"];
  const strokes = Object.keys(SHAPE).filter((name) => name.startsWith("stroke-") && !rare.includes(name));
  const paint = Object.keys(SHAPE).filter((name) => !name.startsWith("stroke-") && !rare.includes(name));
  return [
    `  Inside <svg>: SVG elements only, as XML (close every tag or end it with />). Attribute values and the text of <text>/<tspan>/<title> may be {expr}; {#if}/{#each} work.`,
    `  - elements: ${SVG_TAGS.join(" ")}`,
    `  - attributes: each element's geometry (d, points, x y width height rx ry, cx cy r, x1 y1 x2 y2, dx dy), ${paint.join(" ")}, stroke-(${strokes.map((name) => name.slice(7)).join(" ")}); ${text.join(" ")} on text; ${Object.keys(MARKERS).join(" ")} on path/line/polyline; the defs elements take their SVG attributes`,
    `  - values: numbers (a length may end in px, % or em); colours are ${SVG_PAINT_TOKENS.join(" ")} | #hex | rgb() | hsl() | currentColor | none — no CSS colour names, and fill defaults to the text colour; url(#id) only to an id of the same <svg>; transform takes ${Object.keys(TRANSFORM_ARGS).join(" ")}`,
    `  - limits: ≤ ${MAX_SVG_NODES} elements, path d ≤ ${MAX_SVG_PATH_CHARS} chars; inside clipPath/mask/marker/pattern there is no clip-path/mask/marker and url(#id) may name only a gradient`,
    `  - NOT available: style class href events font-family, <style> <script> <use> <image> <a> <foreignObject>, filters, animation`,
  ].join("\n");
}
