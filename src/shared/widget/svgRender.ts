/**
 * Evaluate a widget's `<svg>` subtree into a plain tree of ALLOWLISTED
 * elements and REBUILT attribute values (`svg.ts`), and print that tree as
 * markup. A renderer still passes the markup through its SVG sanitizer and
 * draws it in a shadow root — this is the first of two walls, not the only one.
 *
 * What the static check refused is refused again here, on the evaluated
 * values: the browser parses the source itself, and an `{expr}` is only known
 * now. An element or attribute that fails is LEFT OUT and reported in
 * `errors` (English, for the avatar); the rest still draws.
 *
 * Budgets: every element is one unit of the render pass's output budget and
 * its attribute/text characters are charged with it (`chargeOutput`), on top of
 * the per-drawing caps MAX_SVG_NODES / MAX_SVG_CHARS.
 */
import { WidgetBudgetError, WidgetRuntimeError, chargeOutput, evaluate, guarded, type Env, type Runtime } from "./interp.js";
import { childScope, eachScopes, interpolate, pickBranch } from "./runtime.js";
import { MAX_SVG_CHARS, MAX_SVG_NODES, svgAttrKind, svgAttrValue, svgElementProblem, svgIsResource, svgRefProblem, svgTakesText } from "./svg.js";
import type { ElNode, TNode } from "./template.js";
import { jsxWhitespace, unescapeText } from "./text.js";

/** One drawn element: its name, its attributes in order, and its children (a string is a text node). */
export interface SvgTree {
  tag: string;
  attrs: [string, string][];
  children: (SvgTree | string)[];
}

const MAX_SVG_ERRORS = 10;
/** The drawn size in px: the width a widget may ask for, and the height its viewBox may lead to. */
const MIN_SVG_WIDTH_PX = 16;
const MAX_SVG_WIDTH_PX = 800;
export const MAX_SVG_HEIGHT_PX = 1200;

interface Pending {
  el: SvgTree;
  attr: string;
  /** The bare id the attribute refers to. */
  id: string;
  inResource: boolean;
}

interface Pass {
  rt: Runtime;
  ns: string;
  nodes: number;
  chars: number;
  errors: string[];
  /** Bare id → the element that declares it. */
  ids: Map<string, string>;
  refs: Pending[];
}

function note(pass: Pass, text: string): void {
  if (pass.errors.length < MAX_SVG_ERRORS && !pass.errors.includes(text)) pass.errors.push(text);
}

function spendChars(pass: Pass, elements: number, chars: number): void {
  chargeOutput(pass.rt, elements, chars);
  pass.chars += chars;
  if (pass.chars > MAX_SVG_CHARS) throw new WidgetRuntimeError(`the <svg> carries too much (limit ${MAX_SVG_CHARS} characters of attributes and text) — simplify the drawing`);
}

function pushText(out: SvgTree, text: string): void {
  const last = out.children.length - 1;
  if (typeof out.children[last] === "string") out.children[last] = (out.children[last] as string) + text;
  else out.children.push(text);
}

function element(node: ElNode, env: Env, parent: string, inResource: boolean, out: SvgTree, pass: Pass): void {
  const tag = node.name;
  const refused = svgElementProblem(tag, parent, inResource);
  if (refused) {
    // Nothing of a refused element is evaluated or drawn — its children included.
    note(pass, refused);
    return;
  }
  if (++pass.nodes > MAX_SVG_NODES) throw new WidgetRuntimeError(`the <svg> draws too many elements (limit ${MAX_SVG_NODES}) — draw fewer shapes, e.g. one <path> or <polyline> instead of many <line>s`);

  const el: SvgTree = { tag, attrs: [], children: [] };
  const seen = new Set<string>();
  let chars = 0;
  for (const attr of node.attrs) {
    if (seen.has(attr.name) || attr.bad) continue;
    seen.add(attr.name);
    const slot = svgAttrKind(tag, attr.name, inResource);
    if ("problem" in slot) {
      note(pass, slot.problem);
      continue;
    }
    let raw: unknown = attr.value;
    if (attr.value !== true && typeof attr.value !== "string") {
      const expr = attr.value;
      try {
        raw = guarded(() => evaluate(expr, env, pass.rt));
      } catch (err) {
        if (err instanceof WidgetBudgetError) throw err;
        note(pass, `<${tag}> ${attr.name}: ${err instanceof Error ? err.message : "evaluation failed"}`);
        continue;
      }
      // `fill={over ? "danger" : null}`: an empty value simply leaves the attribute out.
      if (raw === null || raw === undefined || raw === false) continue;
    }
    const value = svgAttrValue(slot.kind, raw);
    if (!value.ok) {
      note(pass, `<${tag}> ${attr.name} ${value.error}`);
      continue;
    }
    let text = value.value;
    if (value.id !== undefined) {
      if (pass.ids.has(value.id)) {
        note(pass, `<${tag}> id="${value.id}" is used more than once in this <svg> — ids must be unique (inside {#each}, build it from the index)`);
        continue;
      }
      pass.ids.set(value.id, tag);
      text = `${pass.ns}-${value.id}`;
    } else if (value.ref !== undefined) {
      text = `url(#${pass.ns}-${value.ref})`;
      pass.refs.push({ el, attr: attr.name, id: value.ref, inResource });
    }
    el.attrs.push([attr.name, text]);
    chars += attr.name.length + text.length;
  }
  spendChars(pass, 1, chars);
  out.children.push(el);
  children(node.children, env, tag, inResource || svgIsResource(tag), el, pass);
}

function children(nodes: TNode[], env: Env, parent: string, inResource: boolean, out: SvgTree, pass: Pass): void {
  const scope = childScope(nodes, env, pass.rt);
  const takesText = svgTakesText(parent);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    switch (node.t) {
      case "const":
        break;
      case "text": {
        if (!takesText) {
          if (node.value.trim()) note(pass, `text directly inside <${parent}> is not drawn — put it in a <text> element`);
          break;
        }
        const text = unescapeText(jsxWhitespace(node.value, i === 0, i === nodes.length - 1));
        if (text) {
          spendChars(pass, 0, text.length);
          pushText(out, text);
        }
        break;
      }
      case "expr": {
        if (!takesText) {
          note(pass, `{…} directly inside <${parent}> is not drawn — put it in a <text> element, or bind it to an attribute`);
          break;
        }
        // `interpolate` charges the characters to the render pass.
        const text = interpolate(node, scope, pass.rt);
        if (text) {
          pass.chars += text.length;
          if (pass.chars > MAX_SVG_CHARS) throw new WidgetRuntimeError(`the <svg> carries too much (limit ${MAX_SVG_CHARS} characters of attributes and text) — simplify the drawing`);
          pushText(out, text);
        }
        break;
      }
      case "if": {
        const branch = pickBranch(node, scope, pass.rt);
        if (branch) children(branch, scope, parent, inResource, out, pass);
        break;
      }
      case "each": {
        const { scopes } = eachScopes(node, scope, pass.rt);
        if (scopes.length === 0 && node.empty) children(node.empty, scope, parent, inResource, out, pass);
        for (const item of scopes) children(node.children, item, parent, inResource, out, pass);
        break;
      }
      case "el":
        element(node, scope, parent, inResource, out, pass);
        break;
    }
  }
}

const MAX_NS_CHARS = 64;

/**
 * A namespace as it may be written into markup: letters, digits, `-` and `_`
 * only, starting with a letter. A long one (a node key deep inside loops) is
 * cut and closed with a hash of the WHOLE text, so two long keys that share a
 * beginning still get different namespaces.
 */
function safeNs(ns: string): string {
  let clean = ns.replace(/[^A-Za-z0-9_-]/g, "_");
  if (clean.length > MAX_NS_CHARS) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < ns.length && i < 4096; i++) hash = Math.imul(hash ^ ns.charCodeAt(i), 0x01000193) >>> 0;
    clean = `${clean.slice(0, MAX_NS_CHARS)}_${hash.toString(36)}`;
  }
  return /^[A-Za-z]/.test(clean) ? clean : `w${clean}`;
}

/**
 * Evaluate the children of a widget `<svg>` element.
 *
 * `root` is the normalized props of the `<svg>` itself (`normalizeProps`):
 * `viewBox` (rebuilt by the library) and an optional pixel `width`. `ns` is a
 * prefix unique to this drawing on the page — every id is written as
 * `<ns>-<id>` and every `url(#id)` is rewritten the same way, so two widgets,
 * or a card and its fullscreen copy, can never refer to each other's elements.
 *
 * Throws only a WidgetBudgetError / WidgetRuntimeError for a drawing that is
 * over a limit (the caller shows an error in its place).
 */
export function renderSvg(node: ElNode, root: { viewBox: string; width?: number }, env: Env, rt: Runtime, ns: string): { tree: SvgTree; errors: string[] } {
  const pass: Pass = { rt, ns: safeNs(ns), nodes: 0, chars: 0, errors: [], ids: new Map(), refs: [] };
  const box = svgAttrValue("viewBox", root.viewBox);
  const viewBox = box.ok ? box.value : "0 0 100 100";
  const [, , boxWidth, boxHeight] = viewBox.split(" ").map(Number);
  let width = Math.min(MAX_SVG_WIDTH_PX, Math.max(MIN_SVG_WIDTH_PX, Math.round(typeof root.width === "number" && Number.isFinite(root.width) ? root.width : boxWidth)));
  // The height follows the viewBox: a very tall one is drawn narrower, so it cannot take over the page.
  if ((width * boxHeight) / boxWidth > MAX_SVG_HEIGHT_PX) width = Math.max(MIN_SVG_WIDTH_PX, Math.floor((MAX_SVG_HEIGHT_PX * boxWidth) / boxHeight));
  const tree: SvgTree = {
    tag: "svg",
    attrs: [
      ["viewBox", viewBox],
      ["width", String(width)],
      // Shapes and text default to the app's text colour, so a drawing reads in the light and the dark theme.
      ["fill", "currentColor"],
    ],
    children: [],
  };
  children(node.children, env, "svg", false, tree, pass);
  // References are judged once every id of the drawing is known.
  for (const ref of pass.refs) {
    const problem = svgRefProblem(ref.attr, ref.id, pass.ids.get(ref.id), ref.inResource);
    if (!problem) continue;
    note(pass, problem);
    ref.el.attrs = ref.el.attrs.filter(([name]) => name !== ref.attr);
  }
  return { tree, errors: pass.errors };
}

const NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

function escapeAttr(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/**
 * Print a tree as SVG markup. Text and attribute values are escaped; a name
 * that is not a plain word is not printed at all. The result is still to be
 * sanitized by the renderer before it is parsed.
 */
export function svgMarkup(tree: SvgTree): string {
  const out: string[] = [];
  const walk = (node: SvgTree | string, depth: number): void => {
    if (typeof node === "string") {
      out.push(escapeText(node));
      return;
    }
    if (!NAME.test(node.tag) || depth > 64) return;
    out.push(`<${node.tag}`);
    for (const [name, value] of node.attrs) if (NAME.test(name)) out.push(` ${name}="${escapeAttr(value)}"`);
    if (node.children.length === 0) {
      out.push("/>");
      return;
    }
    out.push(">");
    for (const child of node.children) walk(child, depth + 1);
    out.push(`</${node.tag}>`);
  };
  walk(tree, 0);
  return out.join("");
}
