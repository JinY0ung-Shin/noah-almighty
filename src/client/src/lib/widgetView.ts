// A canvas `widget` document, EVALUATED into plain data the Svelte components
// only have to draw.
//
// The whole evaluation happens here, in one pass per state change — not spread
// over the components' reactive blocks — for three reasons:
// - budgets: every top-level block gets a fresh step/allocation budget and a
//   block that blows it becomes ONE error node, which a tree of independently
//   evaluating components could not attribute;
// - isolation: a node whose expression throws becomes an error node in place
//   and its siblings still render;
// - Svelte 5 legacy mode resolves template deps at compile time, so state read
//   inside a helper renders stale. The components here read nothing but the
//   `VNode` they are handed.
//
// Nothing in a VNode is HTML: text is text, and inline Markdown is a list of
// styled segments the component assembles from elements. The one exception is a
// top-level static Markdown block (`k: "md"`), which carries its SOURCE and is
// sanitized by `renderMarkdown` where it is drawn.
import {
  WidgetBudgetError,
  beginRender,
  childScope,
  componentSpec,
  conversationImageRef,
  eachScopes,
  interpolate,
  jsxWhitespace,
  lineCol,
  pickBranch,
  resetBudget,
  resolveProps,
  safeLinkUrl,
  type ElNode,
  type Env,
  type Runtime,
  type TNode,
  type WidgetDoc,
} from "../../../shared/widget/index";

/** A run of inline text and its Markdown styling. */
export interface Seg {
  text: string;
  b?: boolean;
  i?: boolean;
  code?: boolean;
  s?: boolean;
  /** The run is a link: a normalized absolute http(s) URL (`safeLinkUrl`), opened in a new tab. */
  href?: string;
  /** Why this run is NOT the link it was written as (English, for the avatar). */
  problem?: string;
}

export type VNode =
  /** Top-level static Markdown (source text; sanitized where it is drawn). */
  | { k: "md"; key: string; text: string }
  /** Loose inline content inside a block container. */
  | { k: "inline"; key: string; segs: Seg[] }
  | {
      k: "el";
      key: string;
      tag: string;
      props: Record<string, unknown>;
      /** Block children (a `block` component). */
      children: VNode[];
      /** Inline children (an `inline` component, or a label taken from children). */
      segs: Seg[];
      /** A prop expression failed and was dropped: the component drew with defaults. */
      flawed: string;
      /** Source offset of the tag. */
      at: number;
    }
  /**
   * A node that could not be evaluated. `detail` is the library's English reason
   * (a tooltip, and what the avatar is told); `what` names the node and `at` is
   * its source offset (-1 when it has none).
   */
  | { k: "error"; key: string; message: string; detail: string; what: string; at: number }
  /**
   * A block that did something with no effect — a setter or `copy` called while
   * rendering. `detail` holds the runtime's English lines.
   */
  | { k: "warn"; key: string; message: string; detail: string; at: number }
  /** A quiet remark, e.g. a list cut at its limit. */
  | { k: "note"; key: string; message: string };

export type ElVNode = Extract<VNode, { k: "el" }>;

const NODE_ERROR = "이 부분을 표시하지 못했습니다.";
const BUDGET_ERROR = "계산이 너무 커서 이 부분을 표시하지 못했습니다.";
const EACH_TRUNCATED = "항목이 많아 일부만 표시했습니다.";
const OUTPUT_ERROR = "위젯이 그리는 내용이 너무 많아 일부를 표시하지 못했습니다.";
const IGNORED_CALL = "렌더 중에 호출된 상태 변경은 무시됩니다.";

/** How a node is named to the avatar. */
function nameOf(node: TNode): string {
  if (node.t === "el") return `<${node.name}>`;
  if (node.t === "each") return "{#each}";
  if (node.t === "if") return "{#if}";
  if (node.t === "expr") return "{…}";
  return "text";
}

function errorNode(key: string, node: TNode, message: string, detail: string): VNode {
  return { k: "error", key, message, detail, what: nameOf(node), at: node.s };
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : "evaluation failed";
}

/* ───────────────────────── inline Markdown ───────────────────────── */

const ESCAPABLE = "\\{}<>`*_~";

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

/**
 * Bold, italic, code, strike-through and `[text](https://…)` links — nothing
 * else, and never HTML. The result is a flat list of styled text runs; a marker
 * without its closing pair stays literal, and so does a link whose target is
 * not an absolute http(s) URL (`safeLinkUrl`: no javascript:, data:, relative
 * or protocol-relative address). `\x` shows `x` for the template's escapable
 * characters.
 */
export function parseInlineMarkdown(text: string, base: Omit<Seg, "text"> = {}, depth = 0): Seg[] {
  const out: Seg[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ ...base, text: buf });
    buf = "";
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "\\" && i + 1 < n && ESCAPABLE.includes(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ ...base, code: true, text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[" && depth < 3 && !base.href) {
      const close = text.indexOf("](", i + 1);
      const end = close < 0 ? -1 : text.indexOf(")", close + 2);
      // No nested brackets in the label: `[a [b](x)` links only `b`.
      if (close > i + 1 && end > close + 2 && !text.slice(i + 1, close).includes("[")) {
        const href = safeLinkUrl(text.slice(close + 2, end));
        if (href) {
          flush();
          for (const seg of parseInlineMarkdown(text.slice(i + 1, close), { ...base, href }, depth + 1)) out.push(seg);
          i = end + 1;
          continue;
        }
      }
    }
    if (depth < 3 && (c === "*" || c === "_" || c === "~")) {
      const double = text[i + 1] === c;
      const marker = c === "~" ? (double ? "~~" : "") : double ? c + c : c;
      // `snake_case` and `2*3` are not emphasis: `_` opens only at a word start,
      // and a marker must be followed by something other than a space.
      const opens =
        marker !== "" &&
        text[i + marker.length] !== undefined &&
        !/\s/.test(text[i + marker.length]) &&
        !(c === "_" && isWordChar(text[i - 1]));
      if (opens) {
        let end = text.indexOf(marker, i + marker.length);
        // A single `*` must not close on the first half of a `**`.
        while (end >= 0 && marker.length === 1 && (text[end + 1] === c || text[end - 1] === "\\")) {
          end = text.indexOf(marker, end + (text[end + 1] === c ? 2 : 1));
        }
        const closes =
          end > i + marker.length &&
          !/\s/.test(text[end - 1]) &&
          !(c === "_" && isWordChar(text[end + marker.length]));
        if (closes) {
          flush();
          const style: Omit<Seg, "text"> =
            marker === "~~" ? { ...base, s: true } : marker.length === 2 ? { ...base, b: true } : { ...base, i: true };
          for (const seg of parseInlineMarkdown(text.slice(i + marker.length, end), style, depth + 1)) out.push(seg);
          i = end + marker.length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/* ───────────────────────── evaluation ───────────────────────── */

/** Text, an interpolation, or a `<link>` — what sits in a line of text. */
function isInline(node: TNode): boolean {
  return node.t === "text" || node.t === "expr" || (node.t === "el" && node.name === "link");
}

/**
 * A `<link href>` inside running text: its children as runs that carry the
 * href. The library hands back a NORMALIZED absolute http(s) href or drops the
 * prop; a link without one shows as plain text and says why (`problem`).
 */
function linkSegs(node: ElNode, env: Env, rt: Runtime, out: Seg[]): void {
  const { props, errors } = resolveProps(node, env, rt);
  const href = typeof props.href === "string" ? props.href : "";
  const inner = inlineSegs(node.children, env, rt);
  if (href) {
    for (const seg of inner) out.push({ ...seg, href: seg.href ?? href });
    return;
  }
  const problem = `<link>: ${errors.join("; ") || "href is missing"}`;
  for (let i = 0; i < inner.length; i++) out.push(i === 0 ? { ...inner[i], problem } : inner[i]);
}

/** The inline content of a children list: text runs, interpolations, and whatever `{#if}`/`{#each}` yield. */
function inlineSegs(children: TNode[], env: Env, rt: Runtime, out: Seg[] = []): Seg[] {
  const scope = childScope(children, env, rt);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.t === "text") {
      const text = jsxWhitespace(node.value, i === 0, i === children.length - 1);
      if (text) for (const seg of parseInlineMarkdown(text)) out.push(seg);
    } else if (node.t === "expr") {
      // An interpolated VALUE is literal text: its `*` and `_` are not Markdown.
      const text = interpolate(node, scope, rt);
      if (text) out.push({ text });
    } else if (node.t === "if") {
      const branch = pickBranch(node, scope, rt);
      if (branch) inlineSegs(branch, scope, rt, out);
    } else if (node.t === "each") {
      const { scopes } = eachScopes(node, scope, rt);
      if (scopes.length === 0 && node.empty) inlineSegs(node.empty, scope, rt, out);
      for (const item of scopes) inlineSegs(node.children, item, rt, out);
    } else if (node.t === "el" && node.name === "link") {
      linkSegs(node, scope, rt, out);
    }
    // Any other element inside inline content has no place to go (the static check rejects it).
  }
  return out;
}

// The conversation the document is being evaluated for (see buildWidgetView):
// an <image> may only show an image of THIS conversation. Evaluation is
// synchronous, so one module variable serves the whole walk.
let viewConversationId: string | null = null;

function renderEl(node: ElNode, env: Env, rt: Runtime, key: string): VNode {
  const spec = componentSpec(node.name);
  if (!spec) return errorNode(key, node, NODE_ERROR, `unknown component <${node.name}>`);
  const { props, errors } = resolveProps(node, env, rt);
  let segs: Seg[] = [];
  let children: VNode[] = [];
  if (spec.child === "inline") segs = inlineSegs(node.children, env, rt);
  else if (spec.child === "block") children = renderChildren(node.children, env, rt, key);
  for (const [name, prop] of Object.entries(spec.props)) {
    if (!prop.required || name in props) continue;
    if (name === "label" && spec.labelFromChildren && segs.length) continue;
    return errorNode(key, node, NODE_ERROR, errors.join("; ") || `<${node.name}> is missing ${name}`);
  }
  if (node.name === "image") {
    // The library checked the SHAPE of `src`; whose conversation it names is
    // checked here. Another conversation's image is never requested — the
    // address is rebuilt from the two ids, not passed through.
    const ref = conversationImageRef(props.src);
    if (!ref || !viewConversationId || ref.conversationId !== viewConversationId) {
      return errorNode(key, node, NODE_ERROR, "src: the image belongs to another conversation — a widget can only show images of the conversation it is in");
    }
    props.src = `/api/conversations/${encodeURIComponent(ref.conversationId)}/images/${encodeURIComponent(ref.imageId)}`;
  }
  return { k: "el", key, tag: node.name, props, children, segs, flawed: errors.join("; "), at: node.s };
}

function renderNode(node: TNode, env: Env, rt: Runtime, key: string, out: VNode[]): void {
  try {
    if (node.t === "el") {
      out.push(renderEl(node, env, rt, key));
    } else if (node.t === "if") {
      const branch = pickBranch(node, env, rt);
      if (branch) for (const v of renderChildren(branch, env, rt, `${key}?${node.branches.findIndex((b) => b.children === branch)}`)) out.push(v);
    } else if (node.t === "each") {
      const { scopes, truncated } = eachScopes(node, env, rt);
      if (scopes.length === 0 && node.empty) {
        for (const v of renderChildren(node.empty, env, rt, `${key}:else`)) out.push(v);
      }
      for (let i = 0; i < scopes.length; i++) {
        for (const v of renderChildren(node.children, scopes[i], rt, `${key}#${i}`)) out.push(v);
      }
      if (truncated) out.push({ k: "note", key: `${key}:cut`, message: EACH_TRUNCATED });
    }
  } catch (err) {
    // A block over its budget is reported once, by the top-level caller.
    if (err instanceof WidgetBudgetError) throw err;
    out.push(errorNode(key, node, NODE_ERROR, detailOf(err)));
  }
}

/** A block container's children; consecutive inline runs become one `inline` node. */
function renderChildren(children: TNode[], env: Env, rt: Runtime, prefix: string): VNode[] {
  const scope = childScope(children, env, rt);
  const out: VNode[] = [];
  let i = 0;
  while (i < children.length) {
    const node = children[i];
    if (node.t === "const") {
      i++;
      continue;
    }
    const key = `${prefix}/${node.s}`;
    if (isInline(node)) {
      let j = i;
      while (j < children.length && isInline(children[j])) j++;
      const run = children.slice(i, j);
      try {
        const segs: Seg[] = [];
        for (let k = 0; k < run.length; k++) {
          const part = run[k];
          if (part.t === "text") {
            const text = jsxWhitespace(part.value, i + k === 0, i + k === children.length - 1);
            if (text) for (const seg of parseInlineMarkdown(text)) segs.push(seg);
          } else if (part.t === "expr") {
            const text = interpolate(part, scope, rt);
            if (text) segs.push({ text });
          } else if (part.t === "el") {
            linkSegs(part, scope, rt, segs);
          }
        }
        if (segs.some((seg) => seg.text.trim())) out.push({ k: "inline", key, segs });
      } catch (err) {
        if (err instanceof WidgetBudgetError) throw err;
        out.push(errorNode(key, node, NODE_ERROR, detailOf(err)));
      }
      i = j;
      continue;
    }
    renderNode(node, scope, rt, key, out);
    i++;
  }
  return out;
}

/** The render PASS is spent (its output or its steps): every later block would fail at its first step. */
function passExhausted(rt: Runtime): boolean {
  return rt.outEls < 0 || rt.outChars < 0 || rt.renderSteps <= 0;
}

/**
 * Evaluate a document against a root environment (`createRootEnv`). One call is
 * one render PASS: its budgets (total steps, elements and characters put on
 * screen) are refilled here, so walking the same root again — the panel and the
 * fullscreen copy, a re-evaluation — never inherits what an earlier walk spent.
 *
 * Each top-level block gets its own step window out of the pass. A block that
 * exceeds its window, or throws, is replaced by a single error node and the
 * next block still renders. Once the PASS is spent, the walk stops: what was
 * rendered so far stays, and ONE notice at the end says the rest is missing
 * (not one error per remaining block). Never throws.
 */
export function buildWidgetView(doc: WidgetDoc, root: Env, rt: Runtime, options: { conversationId?: string | null } = {}): VNode[] {
  viewConversationId = options.conversationId || null;
  try {
    return walkDocument(doc, root, rt);
  } finally {
    viewConversationId = null;
  }
}

function walkDocument(doc: WidgetDoc, root: Env, rt: Runtime): VNode[] {
  const out: VNode[] = [];
  beginRender(rt);
  for (const node of doc.nodes) {
    const key = `/${node.s}`;
    if (node.t === "const") continue;
    if (node.t === "text") {
      if (node.block) {
        if (node.value.trim()) out.push({ k: "md", key, text: node.value });
      } else if (node.value.trim()) {
        out.push({ k: "inline", key, segs: parseInlineMarkdown(node.value.trim()) });
      }
      continue;
    }
    resetBudget(rt);
    const block: VNode[] = [];
    try {
      if (node.t === "expr") {
        const text = interpolate(node, root, rt);
        if (text) block.push({ k: "inline", key, segs: [{ text }] });
      } else if (node.t === "el" && node.name === "link") {
        // A link on its own line: a one-run paragraph.
        const segs: Seg[] = [];
        linkSegs(node, root, rt, segs);
        if (segs.length) block.push({ k: "inline", key, segs });
      } else {
        renderNode(node, root, rt, key, block);
      }
      for (const v of block) out.push(v);
      ignoredCalls(rt, key, node, out);
    } catch (err) {
      const budget = err instanceof WidgetBudgetError;
      if (budget && passExhausted(rt)) {
        out.push({ k: "error", key: "/output-budget", message: OUTPUT_ERROR, detail: detailOf(err), what: "widget", at: -1 });
        break;
      }
      out.push(errorNode(key, node, budget ? BUDGET_ERROR : NODE_ERROR, detailOf(err)));
      ignoredCalls(rt, key, node, out);
    }
  }
  return out;
}

/**
 * A setter or `copy` call made while the block rendered was ignored by the
 * runtime (rendering must not change state); it left a line in `rt.warnings`.
 * Say so under the block — otherwise the widget just silently does nothing.
 */
function ignoredCalls(rt: Runtime, key: string, node: TNode, out: VNode[]): void {
  if (rt.warnings.length === 0) return;
  out.push({ k: "warn", key: `${key}:ignored`, message: IGNORED_CALL, detail: rt.warnings.join("\n"), at: node.s });
}

const MAX_PROBLEMS = 20;

/**
 * What went wrong in an evaluated view, as short ENGLISH lines for the avatar
 * (the render report): every error node, dropped prop and ignored call, each
 * with the line:column of the node it belongs to. Empty when the view is clean.
 */
export function collectWidgetProblems(doc: WidgetDoc, view: VNode[]): string[] {
  const out: string[] = [];
  const where = (at: number): string => {
    if (at < 0) return "";
    const { line, col } = lineCol(doc.src, at);
    return `line ${line}:${col} `;
  };
  const add = (text: string) => {
    if (out.length < MAX_PROBLEMS && !out.includes(text)) out.push(text);
  };
  const walk = (nodes: VNode[]) => {
    for (const v of nodes) {
      if (out.length >= MAX_PROBLEMS) return;
      if (v.k === "error") add(`${where(v.at)}${v.what}: ${v.detail}`);
      else if (v.k === "warn") for (const line of v.detail.split("\n")) add(`${where(v.at)}${line}`);
      else if (v.k === "inline") {
        for (const seg of v.segs) if (seg.problem) add(seg.problem);
      } else if (v.k === "el") {
        if (v.flawed) add(`${where(v.at)}<${v.tag}>: a prop was dropped — ${v.flawed}`);
        for (const seg of v.segs) if (seg.problem) add(`${where(v.at)}${seg.problem}`);
        walk(v.children);
      }
    }
  };
  walk(view);
  return out;
}

/** What a table cell, a stat or an option shows for a value. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}
