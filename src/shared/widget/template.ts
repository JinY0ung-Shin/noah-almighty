/**
 * Inline UI document parser: component tags, `{@state}`/`{@const}` directives
 * and `{#each}`/`{#if}` blocks, with Markdown prose between them at the top level.
 *
 * Ported from mireiffe/mirineereum (src/lib/genui/template.ts @ 0e469c4) with
 * the owner's permission. Two entry points:
 *
 * `parseWidget(source)` — a source that is all UI and arrives whole (the
 * server's examples, the tests). Strict:
 * - An unfinished tag or block is an ERROR.
 * - Nothing is skipped silently. Every malformed directive, stray closing tag
 *   or unclosed block is recorded in `problems`, so the avatar can fix it.
 *
 * `parseAnswer(source, { streaming })` — an avatar's ANSWER: Markdown that may
 * hold UI, possibly still being written. Lenient where an answer differs:
 * - At the top level only a KNOWN component name opens an element; any other
 *   `<name>`, a stray closing tag, an HTML comment or an unknown `{@…}` is the
 *   answer's own Markdown/HTML and stays text.
 * - A construct the text ends inside of (a tag whose `>` has not come, an open
 *   `{`) is left out: the document is parsed up to where it starts (`end`),
 *   and `pending` says what is being written. An element or block that is open
 *   at the end keeps the children it has so far and is marked `partial`.
 * - `problems` are advice for the avatar; the tree is still what is drawn.
 *
 * Both:
 * - `{@state}` exists only at the top level; a duplicate name is a problem.
 * - Any `<name …>` is an element (the static checker rejects unknown names).
 *   There is no generic-HTML pass-through.
 * - Nesting is capped, and every scan is charged to a work budget, so a parse
 *   of a size-capped source is bounded in time.
 *
 * Modes
 * - top : the document's top level. Tags and directives are recognised only at
 *         the start of a line (indent ≤ 3); everything else is static Markdown
 *         (no `{expr}` interpolation). Fenced code and code spans are text.
 * - comp: inside a tag or a block. Tags anywhere, `{expr}` interpolation.
 * - svg : inside an `<svg>` (at any depth, blocks included). As `comp`, except
 *         that text is LITERAL (a backtick is a character, not a code span) and
 *         an element is never implicitly self-closing — SVG names like `<text>`
 *         or `<title>` are not the widget components of the same name. Every
 *         element parsed here carries `svg: true`; the same nesting cap and
 *         work budget apply.
 */
import {
  Parser,
  WidgetIncomplete,
  WidgetSyntaxError,
  WidgetTooComplex,
  assertExprDepth,
  matchBracket,
  spend,
  type Expr,
  type Pattern,
  type WorkBudget,
} from "./expr.js";
import { WIDGET_COMPONENTS } from "./spec.js";

/** Tag / block nesting limit. */
export const MAX_TEMPLATE_NESTING = 32;
/** Longest source parsed (the canvas content cap). */
export const MAX_WIDGET_SOURCE_CHARS = 20_000;
const MAX_PROBLEMS = 20;

export interface WidgetProblem {
  /** Agent-facing English: what is wrong and how to fix it. */
  message: string;
  /** Source offset the problem is anchored to. */
  pos: number;
}

export interface Attr {
  name: string;
  /** A quoted/unquoted string, a `{expr}`, or `true` for a bare name. */
  value: Expr | string | true;
  /** Source offset of the attribute name. */
  s: number;
  /** The value did not parse (a problem is recorded). Kept so the prop is not ALSO reported as missing. */
  bad?: boolean;
}

interface Base {
  /** Source start / end offsets (stable keys for a renderer). */
  s: number;
  e: number;
}

export type TNode =
  /** `block`: top-level static Markdown. Otherwise an inline text run inside a tag or block. */
  | (Base & { t: "text"; value: string; block: boolean })
  | (Base & { t: "expr"; expr: Expr })
  /**
   * `svg`: the element is an `<svg>` or sits inside one (it is checked and drawn by the SVG allowlist, not as a component).
   * `partial` (here and on a block): still open where a streaming answer ends — it has the children written so far.
   */
  | (Base & { t: "el"; name: string; attrs: Attr[]; children: TNode[]; svg?: true; partial?: true })
  | (Base & {
      t: "each";
      list: Expr;
      item: Pattern | null;
      index: string | null;
      children: TNode[];
      /** The `{:else}` body, shown when the list is empty. */
      empty: TNode[] | null;
      partial?: true;
    })
  | (Base & { t: "if"; branches: { test: Expr | null; children: TNode[] }[]; partial?: true })
  /** `sig`: the declaration's source text (`name = expr`). */
  | (Base & { t: "const"; pattern: Pattern; expr: Expr; sig: string });

export type TextNode = Extract<TNode, { t: "text" }>;
export type ExprNode = Extract<TNode, { t: "expr" }>;
export type ElNode = Extract<TNode, { t: "el" }>;
export type EachNode = Extract<TNode, { t: "each" }>;
export type IfNode = Extract<TNode, { t: "if" }>;
export type ConstNode = Extract<TNode, { t: "const" }>;

export interface StateDecl {
  name: string;
  /** `setName`. */
  setter: string;
  init: Expr | null;
  /** The declaration's source text (`name = expr`): unchanged ⇒ a stored value still applies. */
  sig: string;
  /** Source offset of the name. */
  s: number;
}

export interface WidgetDoc {
  src: string;
  /** Top-level nodes (no state nodes: see `states`). Empty when the parse aborted. */
  nodes: TNode[];
  states: StateDecl[];
  /** Everything wrong with the source. A document with problems must not be rendered as-is. */
  problems: WidgetProblem[];
}

type Mode = "top" | "comp" | "svg";
type Frame = { k: "el"; name: string } | { k: "each" } | { k: "if" };
type CtlTok = { kind: "else" } | { kind: "elseif"; test: Expr } | { kind: "end"; which: "each" | "if" };
type Stop = { kind: "eof" } | { kind: "close"; consumed: boolean } | { kind: "ctl"; tok: CtlTok; consumed: boolean };

interface ChildResult {
  nodes: TNode[];
  pos: number;
  stop: Stop;
}

/** Stops the whole parse (nesting limit); the recorded problems say why. */
class ParseAbort extends Error {}

/**
 * An answer ends INSIDE a construct that starts at `pos` (a tag being written,
 * an open `{`): the parse starts over on the text before it.
 */
class StreamCut extends Error {
  constructor(
    public pos: number,
    /** The component being written, when its name is already there. */
    public tag: string | undefined,
    /** It sits at the top level of the document (not inside an element or block). */
    public top: boolean,
    /** What is wrong with it, for an answer that is NOT being written any more. */
    public advice: string,
  ) {
    super("stream cut");
  }
}

export interface ParseOptions {
  /** The source is an avatar's answer (see the file header). */
  answer?: boolean;
  /** The answer is still being written: open elements are `partial`, nothing about its end is a problem. */
  streaming?: boolean;
}

/**
 * Component names that are also HTML elements an answer may write as HTML
 * (`<details><summary>…`, a raw `<table>`, a task list's `<input>`). At the top
 * level of an answer such a tag is ours only when it carries one of the props
 * the component cannot do without; otherwise it is left to Markdown.
 */
const HTML_LOOKALIKES: Readonly<Record<string, readonly string[]>> = {
  details: ["title"],
  table: ["columns", "rows"],
  select: ["options", "onChange"],
  input: ["onChange"],
  button: ["onClick", "send", "href"],
  link: [],
  progress: [],
};
/**
 * HTML elements that open an HTML BLOCK in Markdown (CommonMark's list, plus the
 * containers an answer writes): at the top level of an answer the block runs to
 * the next blank line and nothing inside it is ours.
 */
const HTML_BLOCK_TAGS = new Set(
  (
    "address article aside blockquote body center colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form " +
    "h1 h2 h3 h4 h5 h6 head header hr html iframe legend li main menu nav ol optgroup option p pre section select summary table tbody " +
    "td textarea tfoot th thead tr ul script style video audio picture"
  ).split(" "),
);

/** Attributes the HTML element takes too: they say nothing about whose tag it is. */
const HTML_SHARED_ATTRS = new Set(["value", "type", "placeholder", "min", "max", "step", "disabled", "checked", "open", "title", "width", "height", "name", "href"]);
/** Attributes only the HTML element takes: with one of these the tag is HTML. */
const HTML_ONLY_ATTRS: Readonly<Record<string, readonly string[]>> = {
  link: ["rel", "as", "crossorigin", "media"],
  progress: ["max"],
};

/**
 * Whose tag a top-level lookalike is. Ours when it carries a prop the component
 * cannot do without, any `{expression}` value (HTML has none) or a prop only
 * the component has (`variant`, `tone`, `options`…); HTML when it carries an
 * attribute only the HTML element has, or nothing that tells.
 */
function isHtmlLookalike(name: string, attrs: Attr[]): boolean {
  if (!hasOwn(HTML_LOOKALIKES, name)) return false;
  if (hasOwn(HTML_ONLY_ATTRS, name) && attrs.some((a) => HTML_ONLY_ATTRS[name].includes(a.name))) return true;
  if (HTML_LOOKALIKES[name].some((prop) => attrs.some((a) => a.name === prop))) return false;
  if (attrs.some((a) => a.bad || (a.value !== true && typeof a.value !== "string"))) return false;
  const props = WIDGET_COMPONENTS[name].props;
  if (attrs.some((a) => hasOwn(props, a.name) && !HTML_SHARED_ATTRS.has(a.name))) return false;
  // `<link href>` and `<progress value>` with nothing HTML-only about them are ours.
  return HTML_LOOKALIKES[name].length > 0 || attrs.length === 0;
}

const NAME_RE = /[A-Za-z][\w-]*/y;
const ATTR_NAME_RE = /[A-Za-z_][\w-]*/y;

function isWs(c: string | undefined) {
  return c === " " || c === "\t" || c === "\r" || c === "\n";
}

export function setterName(name: string) {
  return "set" + name.charAt(0).toUpperCase() + name.slice(1);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

class TemplateParser {
  problems: WidgetProblem[] = [];
  states: StateDecl[] = [];
  budget: WorkBudget;

  /** An answer: only known components open an element at the top level, and its end is cut, not reported. */
  answer: boolean;
  /** The answer is still being written. */
  live: boolean;

  constructor(
    public src: string,
    options: ParseOptions = {},
  ) {
    this.answer = Boolean(options.answer);
    this.live = this.answer && Boolean(options.streaming);
    // Linear in the source. An ordinary document costs a few units per
    // character; the factor leaves room for the arrow-function lookahead
    // rescanning nested parentheses, and little else — input that makes the
    // parser re-read the same text over and over runs out quickly.
    this.budget = { left: src.length * 20 + 50_000 };
  }

  problem(message: string, pos: number) {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ message, pos });
  }

  /** The text ends inside the construct at `pos`: an answer is cut there, a whole source gets `fallback`. */
  cut(pos: number, advice: string, tag?: string, top = false): void {
    if (this.answer) throw new StreamCut(pos, tag, top, advice);
  }

  /**
   * Where to resume after a construct at `start` that did not parse, `close`
   * being its matching bracket (-1: none). A whole source skips to the bracket,
   * as before. An ANSWER is drawn even with problems, so the damage is kept to
   * the construct's own LINE: a `}` that was left out must not swallow the
   * paragraphs after it (or run on to some unrelated `}` further down).
   */
  resume(start: number, close: number, missing: number): number {
    if (!this.answer) return close < 0 ? missing : close + 1;
    const eol = this.src.indexOf("\n", start);
    const lineEnd = eol < 0 ? this.src.length : eol;
    return close >= 0 && close < lineEnd ? close + 1 : lineEnd;
  }

  /** Whether everything from `from` to the end of the text matches `re` — a token whose rest has not arrived. */
  tail(from: number, re: RegExp): boolean {
    return this.live && this.src.length - from <= 40 && re.test(this.src.slice(from));
  }

  /* ─────────── children ─────────── */

  parseChildren(pos: number, mode: Mode, stack: Frame[]): ChildResult {
    const src = this.src;
    const n = src.length;
    const nodes: TNode[] = [];
    let textStart = pos;
    let afterNode = pos;
    let i = pos;

    const flush = (end: number) => {
      if (end > textStart) nodes.push({ t: "text", s: textStart, e: end, value: src.slice(textStart, end), block: mode === "top" });
    };
    /** Whether only whitespace precedes `at` on its line (or since the previous node), and the indent. */
    const lineInfo = (at: number): { start: boolean; indent: number; newline: boolean } => {
      let j = at - 1;
      let indent = 0;
      while (j >= 0 && (src[j] === " " || src[j] === "\t")) {
        indent += src[j] === "\t" ? 4 : 1;
        j--;
      }
      spend(this.budget, at - j);
      const b = j + 1;
      if (b === 0 || src[j] === "\n") return { start: true, indent, newline: true };
      if (b === afterNode) return { start: true, indent: 0, newline: false };
      return { start: false, indent, newline: false };
    };

    while (i < n) {
      spend(this.budget, 1);
      const c = src[i];

      if (mode === "top" && (c === "`" || c === "~") && src.startsWith(c + c + c, i)) {
        const li = lineInfo(i);
        if (li.newline && li.indent <= 3 && this.opensFence(i)) {
          i = this.skipFence(i);
          continue;
        }
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`" && mode !== "svg") {
        let k = 0;
        while (src[i + k] === "`") k++;
        const end = this.skipCodeSpan(i, mode === "top");
        // Inside a component, a code span the streaming text has not closed yet
        // must not have its `{…}` read as an expression meanwhile.
        if (end === i + k && mode !== "top" && this.live && src.indexOf("\n", i) < 0) this.cut(i, "", undefined, false);
        i = end;
        continue;
      }

      if (c === "<") {
        if (mode === "top") {
          const li = lineInfo(i);
          if (!(li.start && (!li.newline || li.indent <= 3))) {
            i++;
            continue;
          }
        }
        if (src[i + 1] === "/") {
          const close = this.readCloseTag(i);
          if (!close) {
            // `</bo` at the end of a streaming answer: the rest of the closing tag is on its way.
            if (stack.length > 0 && this.tail(i, /^<\/\s*[\w-]*\s*$/)) this.cut(i, "", undefined, false);
            i++;
            continue;
          }
          const top = stack[stack.length - 1];
          if (top && top.k === "el" && top.name === close.name) {
            flush(i);
            return { nodes, pos: close.end, stop: { kind: "close", consumed: true } };
          }
          if (stack.some((f) => f.k === "el" && f.name === close.name)) {
            flush(i);
            return { nodes, pos: i, stop: { kind: "close", consumed: false } };
          }
          // An answer's own HTML (`</details>`, `</div>`): Markdown, not ours.
          if (this.answer && mode === "top") {
            i++;
            continue;
          }
          flush(i);
          this.problem(`Unexpected closing tag </${close.name}>: no <${close.name}> is open here. Remove it, or add the matching opening tag.`, i);
          i = textStart = afterNode = close.end;
          continue;
        }
        if (src.startsWith("<!--", i)) {
          if (this.answer && mode === "top") {
            i++;
            continue;
          }
          const e = src.indexOf("-->", i + 4);
          if (e < 0) {
            this.cut(i, "This <!-- comment is never closed. Add -->.", undefined, stack.length === 0);
            flush(i);
            this.problem("This <!-- comment is never closed. Add -->.", i);
            i = textStart = afterNode = n;
            break;
          }
          flush(i);
          spend(this.budget, e - i);
          i = textStart = afterNode = e + 3;
          continue;
        }
        const r = this.tryElement(i, stack, mode === "svg", mode === "top");
        if (r === null || "html" in r) {
          // An answer's own block-level HTML at the start of a line is an HTML
          // BLOCK, as it is to Markdown: it runs to the next blank line, and
          // nothing inside it is ours (a `<col>` of its `<table>`, a `<button>`
          // of its form). An inline tag (`<b>`, `<br>`) is just text.
          if (this.answer && mode === "top" && HTML_BLOCK_TAGS.has((/^<([A-Za-z][\w-]*)/.exec(src.slice(i, i + 40))?.[1] ?? "").toLowerCase())) {
            const blank = /\n[ \t]*\n/g;
            blank.lastIndex = i;
            const m = blank.exec(src);
            const stop = m ? m.index + 1 : n;
            spend(this.budget, stop - i);
            i = stop;
            continue;
          }
          i = r ? Math.max(r.html, i + 1) : i + 1;
          continue;
        }
        flush(i);
        nodes.push(r.node);
        i = textStart = afterNode = r.end;
        continue;
      }

      if (c === "{") {
        let j = i + 1;
        while (j < n && (src[j] === " " || src[j] === "\t")) j++;
        const k = src[j];
        if (k === "@" || k === "#") {
          if (mode === "top") {
            const li = lineInfo(i);
            if (!(li.start && (!li.newline || li.indent <= 3))) {
              i++;
              continue;
            }
          }
          const kw = /^(@state|@const|#each|#if)(?![\w$])/.exec(src.slice(j, j + 8));
          if (!kw) {
            // `{@sta` at the end of a streaming answer: the keyword is still being written.
            if (this.tail(j, /^[@#][a-z]*$/)) this.cut(i, "", undefined, stack.length === 0);
            // In an answer's prose, `{@…}` / `{#…}` that is not one of ours is just text.
            if (this.answer && mode === "top") {
              i++;
              continue;
            }
            this.problem(
              `Unknown directive ${JSON.stringify(src.slice(i, Math.min(n, j + 12)))}. The directives are {@state …}, {@const …}, {#each …} and {#if …}. To show a literal "{", write \\{.`,
              i,
            );
            i++;
            continue;
          }
          flush(i);
          const r =
            kw[1][0] === "@"
              ? this.parseDirective(i, j + kw[1].length, kw[1] as "@state" | "@const", mode, stack)
              : this.parseControl(i, j + kw[1].length, kw[1] as "#each" | "#if", stack, mode === "svg" ? "svg" : "comp");
          for (const nd of r.nodes) nodes.push(nd);
          i = textStart = afterNode = r.end;
          continue;
        }
        if (k === ":" || k === "/") {
          // Top-level prose of an answer has no open block: `{:…}` / `{/…}` there is text.
          if (this.answer && mode === "top") {
            i++;
            continue;
          }
          const tok = this.readCtlToken(i, j);
          if (tok && "error" in tok) {
            flush(i);
            this.exprProblem(tok.error, tok, i);
            i = textStart = afterNode = this.resume(i, matchBracket(src, i, this.budget), i + 1);
            continue;
          }
          if (tok) {
            const matches = (f: Frame | undefined) =>
              !!f && f.k !== "el" && (tok.tok.kind === "end" ? tok.tok.which === f.k : tok.tok.kind === "else" || f.k === "if");
            if (matches(stack[stack.length - 1])) {
              flush(i);
              return { nodes, pos: tok.end, stop: { kind: "ctl", tok: tok.tok, consumed: true } };
            }
            if (stack.some((f) => matches(f))) {
              flush(i);
              return { nodes, pos: i, stop: { kind: "ctl", tok: tok.tok, consumed: false } };
            }
            if (this.answer && mode === "top") {
              i++;
              continue;
            }
            flush(i);
            this.problem(`Unexpected ${src.slice(i, tok.end)}: there is no open {#each} / {#if} block for it.`, i);
            i = textStart = afterNode = tok.end;
            continue;
          }
          // `{/ea` or `{:el` at the end of a streaming answer, inside a block: the token is still being written.
          if (stack.length > 0 && this.tail(j, /^[:/]\s*[a-z]*\s*[a-z]*$/)) this.cut(i, "", undefined, false);
        }
        // A lone `{` at the very end of a streaming answer may become a directive or an expression.
        if (j >= n && this.live && (mode !== "top" || lineInfo(i).start)) this.cut(i, "", undefined, stack.length === 0);
        if (mode !== "top") {
          const r = this.parseBraceExpr(i);
          flush(i);
          if ("error" in r) {
            this.exprProblem(`${r.error}. To show a literal "{", write \\{.`, r, i);
            i = textStart = afterNode = this.resume(i, matchBracket(src, i, this.budget), i + 1);
            continue;
          }
          if (r.expr) nodes.push({ t: "expr", s: i, e: r.end, expr: r.expr });
          i = textStart = afterNode = r.end;
          continue;
        }
        i++;
        continue;
      }

      i++;
    }

    flush(n);
    return { nodes, pos: n, stop: { kind: "eof" } };
  }

  /* ─────────── text skipping ─────────── */

  /** Whether the backtick/tilde run at `i` (start of a line) opens a fence: a backtick fence has no backtick in its info string. */
  opensFence(i: number): boolean {
    const src = this.src;
    if (src[i] !== "`") return true;
    let p = i;
    while (src[p] === "`") p++;
    const eol = src.indexOf("\n", p);
    return !src.slice(p, eol < 0 ? src.length : eol).includes("`");
  }

  skipFence(i: number): number {
    const src = this.src;
    const ch = src[i];
    let len = 0;
    while (src[i + len] === ch) len++;
    let p = src.indexOf("\n", i);
    if (p < 0) return src.length;
    p++;
    while (p < src.length) {
      let q = p;
      let indent = 0;
      while (src[q] === " " || src[q] === "\t") {
        q++;
        indent++;
      }
      let run = 0;
      while (src[q + run] === ch) run++;
      const eol = src.indexOf("\n", q);
      const lineEnd = eol < 0 ? src.length : eol;
      spend(this.budget, lineEnd - p + 1);
      if (run >= len && indent <= 3 && src.slice(q + run, lineEnd).trim() === "") return lineEnd;
      if (eol < 0) return src.length;
      p = eol + 1;
    }
    return src.length;
  }

  skipCodeSpan(i: number, top = false): number {
    const src = this.src;
    let k = 0;
    while (src[i + k] === "`") k++;
    let p = i + k;
    while (p < src.length) {
      const q = src.indexOf("`", p);
      if (q < 0) break;
      spend(this.budget, q - p + 1);
      // A code span never crosses a blank line…
      if (/\n[ \t]*\n/.test(src.slice(p, q))) break;
      // …nor, at the top level, the line that opens a fenced block: a lone
      // backtick in prose must not swallow the fence after it.
      if (top && /\n {0,3}(?:```|~~~)/.test(src.slice(Math.max(i, p - 1), q + 3))) break;
      let r = 0;
      while (src[q + r] === "`") r++;
      if (r === k) return q + r;
      p = q + r;
    }
    return i + k;
  }

  /* ─────────── tags ─────────── */

  readCloseTag(i: number): { name: string; end: number } | null {
    const src = this.src;
    let p = i + 2;
    while (isWs(src[p])) p++;
    NAME_RE.lastIndex = p;
    const m = NAME_RE.exec(src);
    if (!m) return null;
    p += m[0].length;
    while (isWs(src[p])) p++;
    if (src[p] !== ">") return null;
    return { name: m[0], end: p + 1 };
  }

  /**
   * An element starting at `<` (position i), or null when this `<` is plain text.
   * `inSvg`: it sits inside an `<svg>`. `top`: it is at the document's top level.
   */
  tryElement(i: number, stack: Frame[], inSvg = false, top = false): { node: TNode; end: number } | { html: number } | null {
    const src = this.src;
    const n = src.length;
    let p = i + 1;
    NAME_RE.lastIndex = p;
    const m = NAME_RE.exec(src);
    if (!m) {
      // A `<` that ends a streaming answer: what follows decides what it is.
      if (this.live && p >= n) this.cut(i, "", undefined, top);
      return null;
    }
    const name = m[0];
    p += name.length;
    if (p < n && !isWs(src[p]) && src[p] !== ">" && src[p] !== "/") return null;
    const known = hasOwn(WIDGET_COMPONENTS, name);
    if (this.answer && top && !known) {
      // Not a component: the answer's own HTML or text. While streaming, a name
      // that ends the text may still grow into one (`<sli` → `<slider`).
      if (this.live && p >= n && Object.keys(WIDGET_COMPONENTS).some((tag) => tag.startsWith(name))) this.cut(i, "", undefined, true);
      return null;
    }

    const attrs: Attr[] = [];
    const problemsBefore = this.problems.length;
    // The element is an <svg>, or anything inside one.
    const svg = inSvg || name === "svg";
    const el = (e: number, children: TNode[]): TNode => (svg ? { t: "el", s: i, e, name, attrs, children, svg: true } : { t: "el", s: i, e, name, attrs, children });
    const unfinished = (): { node: TNode; end: number } => {
      const message = `The <${name}> tag is never finished. End it with "/>" (no children) or ">".`;
      this.cut(i, message, known || inSvg ? name : undefined, top);
      this.problem(message, i);
      return { node: el(n, []), end: n };
    };

    let selfClose = false;
    for (;;) {
      const from = p;
      while (p < n && isWs(src[p])) p++;
      spend(this.budget, p - from + 1);
      if (p >= n) return unfinished();
      const c = src[p];
      if (c === "/") {
        if (src[p + 1] === ">") {
          selfClose = true;
          p += 2;
          break;
        }
        this.problem(`Unexpected "/" inside the <${name}> tag.`, p);
        p++;
        continue;
      }
      if (c === ">") {
        p++;
        break;
      }
      if (c === "{") {
        this.problem(`Spread props ({...obj}) are not supported on <${name}>. Write each prop explicitly.`, p);
        const e = matchBracket(src, p, this.budget);
        if (e < 0) return unfinished();
        p = e + 1;
        continue;
      }
      ATTR_NAME_RE.lastIndex = p;
      const am = ATTR_NAME_RE.exec(src);
      if (!am) {
        this.problem(`Unexpected ${JSON.stringify(c)} inside the <${name}> tag. If this "<" was meant as text, write \\< or &lt;.`, p);
        p++;
        continue;
      }
      const an = am[0];
      const at = p;
      p += an.length;
      let q = p;
      while (q < n && (src[q] === " " || src[q] === "\t")) q++;
      if (src[q] !== "=") {
        attrs.push({ name: an, value: true, s: at });
        continue;
      }
      p = q + 1;
      while (p < n && isWs(src[p])) p++;
      if (p >= n) return unfinished();
      const quote = src[p];
      if (quote === '"' || quote === "'") {
        const e = src.indexOf(quote, p + 1);
        const eol = src.indexOf("\n", p);
        if (this.answer && eol >= 0 && (e < 0 || e > eol)) {
          // An answer's string prop that does not close on its line never will:
          // the tag ends there, and what follows is drawn as what it is.
          this.problem(`The string for prop "${an}" of <${name}> is never closed.`, p);
          return { node: el(eol, []), end: eol };
        }
        if (e < 0) {
          this.cut(i, `The string for prop "${an}" of <${name}> is never closed.`, known || inSvg ? name : undefined, top);
          this.problem(`The string for prop "${an}" of <${name}> is never closed.`, p);
          return { node: el(n, []), end: n };
        }
        spend(this.budget, e - p);
        attrs.push({ name: an, value: decodeEntities(src.slice(p + 1, e)), s: at });
        p = e + 1;
        continue;
      }
      if (quote === "{") {
        const r = this.parseBraceExpr(p);
        if ("error" in r) {
          attrs.push({ name: an, value: true, s: at, bad: true });
          this.exprProblem(`Prop "${an}" of <${name}>: ${r.error}.`, r, p);
          const e = matchBracket(src, p, this.budget);
          const eol = src.indexOf("\n", p);
          if (this.answer && (e < 0 || (eol >= 0 && e > eol))) {
            // The `}` was left out: the tag ends with its line instead of at some later `}` (or never).
            const stop = eol < 0 ? n : eol;
            return { node: el(stop, []), end: stop };
          }
          if (e < 0) return { node: el(n, []), end: n };
          p = e + 1;
          continue;
        }
        if (r.expr) attrs.push({ name: an, value: r.expr, s: at });
        else {
          attrs.push({ name: an, value: true, s: at, bad: true });
          this.problem(`Prop "${an}" of <${name}> has an empty {}. Give it an expression, or remove the prop.`, p);
        }
        p = r.end;
        continue;
      }
      // An unquoted value (HTML habit): up to whitespace or ">".
      const um = /^[^\s>"'`=<{}]+/.exec(src.slice(p, p + 200));
      if (!um) {
        this.problem(`Prop "${an}" of <${name}> has no value after "=".`, p);
        p++;
        continue;
      }
      let v = um[0];
      if (v.endsWith("/") && src[p + v.length] === ">") v = v.slice(0, -1);
      if (v === "") {
        this.problem(`Prop "${an}" of <${name}> has no value after "=".`, p);
        continue;
      }
      attrs.push({ name: an, value: v, s: at });
      p += v.length;
    }

    if (this.answer && top && isHtmlLookalike(name, attrs)) {
      // The answer's own HTML: whatever its attributes looked like to us is not a
      // problem. `html`: where its opening tag ends — it was read once, and is not read again.
      this.problems.length = problemsBefore;
      return { html: p };
    }

    // A component that takes no children is self-closing even when written `<slider …>`.
    // Not inside an <svg>: there `<image>` or `<link>` is not that component, and an element closes only as written.
    const isVoid = selfClose || (!inSvg && hasOwn(WIDGET_COMPONENTS, name) && WIDGET_COMPONENTS[name].child === "none");
    if (isVoid) {
      let end = p;
      if (!selfClose) {
        const m2 = /^\s*<\/\s*([A-Za-z][\w-]*)\s*>/.exec(src.slice(p, p + 80));
        if (m2 && m2[1] === name) end = p + m2[0].length;
      }
      return { node: el(end, []), end };
    }

    this.guardDepth(stack, i);
    const res = this.parseChildren(p, svg ? "svg" : "comp", [...stack, { k: "el", name }]);
    const node = el(res.pos, res.nodes);
    if (!(res.stop.kind === "close" && res.stop.consumed)) {
      if (res.stop.kind === "eof" && this.live) {
        // Still being written: it shows the children it has.
        (node as ElNode).partial = true;
      } else {
        const fix = inSvg ? `End the tag with "/>" (no children) or add </${name}>` : `Add </${name}>`;
        this.problem(
          res.stop.kind === "eof"
            ? `<${name}> is never closed. ${fix}.`
            : `<${name}> is not closed before ${JSON.stringify(src.slice(res.pos, Math.min(n, res.pos + 12)))}. ${fix} first.`,
          i,
        );
      }
    }
    return { node, end: res.pos };
  }

  guardDepth(stack: Frame[], pos: number) {
    if (stack.length >= MAX_TEMPLATE_NESTING) {
      this.problem(`Tags and blocks are nested too deeply (limit ${MAX_TEMPLATE_NESTING} levels). Flatten the layout.`, pos);
      throw new ParseAbort();
    }
  }

  exprError(err: unknown, at: number): { error: string; pos: number } {
    if (err instanceof WidgetIncomplete) return { error: "The expression is never finished (unexpected end of input)", pos: at, eof: true } as { error: string; pos: number };
    if (err instanceof WidgetSyntaxError) return { error: `Syntax error in expression: ${err.message}`, pos: err.pos };
    throw err;
  }

  /**
   * Record an expression problem. One that ran to the END of the input (an
   * unclosed `{`, string, template or comment) stops the parse: everything
   * after it was swallowed, and re-reading the tail from each later `{` is
   * what made such input quadratic.
   */
  exprProblem(message: string, e: { error: string; pos: number }, start?: number): void {
    if ((e as { eof?: boolean }).eof) this.cut(start ?? e.pos, message);
    // A streaming answer that ends inside the construct (its `{` has no `}` yet):
    // a half-written keyword or operand reads as a syntax error only for now.
    // An error further back is a real one (the line-bound recovery of `resume` applies).
    else if (this.live && start !== undefined && this.src.length - e.pos <= 40 && matchBracket(this.src, start, this.budget) < 0) this.cut(start, message);
    this.problem(message, e.pos);
    if ((e as { eof?: boolean }).eof) throw new ParseAbort();
  }

  /** `{expr}` starting at `{` (position i). An empty `{}` (or a comment only) has expr = null. */
  parseBraceExpr(i: number): { expr: Expr | null; end: number } | { error: string; pos: number } {
    try {
      const p = new Parser(this.src, i + 1, { budget: this.budget });
      if (p.isP("}")) return { expr: null, end: p.tok.end };
      const expr = p.parseSeq();
      if (!p.isP("}")) {
        if (p.tok.type === "eof") return { error: 'This "{" is never closed', pos: i, eof: true } as { error: string; pos: number };
        return { error: `Unexpected ${JSON.stringify(p.tok.value)} in expression (expected "}")`, pos: p.tok.start };
      }
      assertExprDepth(expr, i);
      return { expr, end: p.tok.end };
    } catch (err) {
      return this.exprError(err, i);
    }
  }

  readCtlToken(i: number, j: number): { tok: CtlTok; end: number } | { error: string; pos: number } | null {
    const src = this.src;
    if (src[j] === "/") {
      const m = /^\/\s*(each|if)\s*\}/.exec(src.slice(j, j + 12));
      return m ? { tok: { kind: "end", which: m[1] as "each" | "if" }, end: j + m[0].length } : null;
    }
    const m = /^:\s*else(?![\w$])/.exec(src.slice(j, j + 10));
    if (!m) return null;
    let p = j + m[0].length;
    while (p < src.length && isWs(src[p])) p++;
    if (src[p] === "}") return { tok: { kind: "else" }, end: p + 1 };
    if (p >= src.length) return { error: "{:else} is never closed", pos: i, eof: true } as { error: string; pos: number };
    if (src.startsWith("if", p) && !/[\w$]/.test(src[p + 2] ?? "")) {
      try {
        const ps = new Parser(src, p + 2, { budget: this.budget });
        const test = ps.parseSeq();
        if (!ps.isP("}")) return { error: `{:else if …} is not closed with "}"`, pos: i, eof: ps.tok.type === "eof" } as { error: string; pos: number };
        assertExprDepth(test, i);
        return { tok: { kind: "elseif", test }, end: ps.tok.end };
      } catch (err) {
        const e = this.exprError(err, i);
        return { ...e, error: `{:else if}: ${e.error}.` };
      }
    }
    return { error: `Malformed {:else}. Write {:else} or {:else if condition}.`, pos: i };
  }

  /* ─────────── directives ─────────── */

  parseDirective(i: number, after: number, kw: "@state" | "@const", mode: Mode, stack: Frame[]): { nodes: TNode[]; end: number } {
    const src = this.src;
    const nodes: TNode[] = [];
    try {
      const p = new Parser(src, after, { budget: this.budget });
      if (kw === "@state") {
        const topLevel = mode === "top" && stack.length === 0;
        if (!topLevel) {
          this.problem("{@state} must be declared at the top level, on its own line — not inside a tag or a block. Move it to the top.", i);
        }
        do {
          if (p.tok.type !== "ident") p.fail("expected a state name");
          const start = p.tok.start;
          const name = p.advance().value as string;
          let init: Expr | null = null;
          if (p.eatP("=")) {
            init = p.parseExpr();
            assertExprDepth(init, start);
          }
          const sig = src.slice(start, p.lastEnd).trim();
          if (!topLevel) continue;
          if (this.states.some((s) => s.name === name)) {
            this.problem(`State "${name}" is declared more than once. Declare each state once.`, start);
            continue;
          }
          this.states.push({ name, setter: setterName(name), init, sig, s: start });
        } while (p.eatP(","));
      } else {
        do {
          const start = p.tok.start;
          const pattern = p.parsePattern();
          p.expectP("=");
          const expr = p.parseExpr();
          assertExprDepth(expr, start);
          nodes.push({ t: "const", s: i, e: i, pattern, expr, sig: src.slice(start, p.lastEnd).trim() });
        } while (p.eatP(","));
      }
      if (!p.isP("}")) p.fail('expected "}"');
      const end = p.tok.end;
      for (const nd of nodes) nd.e = end;
      return { nodes, end };
    } catch (err) {
      const e = this.exprError(err, i);
      this.exprProblem(`{${kw}}: ${e.error}. Write {${kw} name = expression}.`, e, i);
      return { nodes: [], end: this.resume(i, matchBracket(src, i, this.budget), src.length) };
    }
  }

  parseControl(i: number, after: number, kw: "#each" | "#if", stack: Frame[], inner: Mode = "comp"): { nodes: TNode[]; end: number } {
    const src = this.src;
    this.guardDepth(stack, i);
    let headerEnd: number;
    let list: Expr | null = null;
    let item: Pattern | null = null;
    let index: string | null = null;
    let test: Expr | null = null;
    try {
      const p = new Parser(src, after, { budget: this.budget });
      if (kw === "#each") {
        list = p.parseSeq();
        if (p.isId("as")) {
          p.advance();
          item = p.parsePattern();
          if (p.eatP(",")) {
            if (p.tok.type !== "ident") p.fail("expected an index name");
            index = p.advance().value as string;
          }
        }
      } else {
        test = p.parseSeq();
      }
      if (!p.isP("}")) p.fail('expected "}"');
      if (list) assertExprDepth(list, i);
      if (test) assertExprDepth(test, i);
      headerEnd = p.tok.end;
    } catch (err) {
      const e = this.exprError(err, i);
      this.exprProblem(`{${kw}}: ${e.error}. Write ${kw === "#each" ? "{#each list as item, index} … {/each}" : "{#if condition} … {/if}"}.`, e, i);
      return { nodes: [], end: this.resume(i, matchBracket(src, i, this.budget), src.length) };
    }

    const which = kw === "#each" ? "each" : "if";
    /** Returns whether the block is merely still being written (a streaming answer ends inside it). */
    const unclosed = (res: ChildResult): boolean => {
      if (res.stop.kind === "eof" && this.live) return true;
      this.problem(
        res.stop.kind === "eof"
          ? `{${kw}} is never closed. Add {/${which}}.`
          : `{${kw}} is not closed before ${JSON.stringify(src.slice(res.pos, Math.min(src.length, res.pos + 12)))}. Add {/${which}} first.`,
        i,
      );
      return false;
    };

    if (kw === "#each") {
      const frames: Frame[] = [...stack, { k: "each" }];
      const body = this.parseChildren(headerEnd, inner, frames);
      let empty: TNode[] | null = null;
      let res = body;
      if (body.stop.kind === "ctl" && body.stop.consumed && body.stop.tok.kind === "else") {
        res = this.parseChildren(body.pos, inner, frames);
        empty = res.nodes;
      }
      let partial = false;
      if (!(res.stop.kind === "ctl" && res.stop.consumed)) partial = unclosed(res);
      else if (res.stop.tok.kind !== "end") this.problem("{#each} takes one {:else} (shown when the list is empty), then {/each}.", i);
      const each: EachNode = { t: "each", s: i, e: res.pos, list: list!, item, index, children: body.nodes, empty };
      if (partial) each.partial = true;
      return { nodes: [each], end: res.pos };
    }

    const frames: Frame[] = [...stack, { k: "if" }];
    const branches: { test: Expr | null; children: TNode[] }[] = [];
    let curTest: Expr | null = test;
    let pos = headerEnd;
    let sawElse = false;
    let partial = false;
    for (;;) {
      const res = this.parseChildren(pos, inner, frames);
      branches.push({ test: curTest, children: res.nodes });
      pos = res.pos;
      if (!(res.stop.kind === "ctl" && res.stop.consumed)) {
        partial = unclosed(res);
        break;
      }
      const tok = res.stop.tok;
      if (tok.kind === "end") break;
      if (sawElse) {
        this.problem("Nothing may follow {:else} in an {#if} block except {/if}.", i);
        break;
      }
      if (tok.kind === "elseif") curTest = tok.test;
      else {
        curTest = null;
        sawElse = true;
      }
    }
    const node: IfNode = { t: "if", s: i, e: pos, branches };
    if (partial) node.partial = true;
    return { nodes: [node], end: pos };
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return hasOwn(ENTITIES, g) ? ENTITIES[g] : m;
  });
}

/* ───────────────────────── public API ───────────────────────── */

/** 1-based line and column of a source offset. */
export function lineCol(src: string, pos: number): { line: number; col: number } {
  const at = Math.max(0, Math.min(pos, src.length));
  let line = 1;
  let last = -1;
  for (let i = src.indexOf("\n"); i >= 0 && i < at; i = src.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, col: at - last };
}

/**
 * Parse a widget source. Never throws for bad input: everything wrong with it
 * is in `problems` (and `nodes` is empty when the parse had to stop).
 */
export function parseWidget(source: string): WidgetDoc {
  const parser = new TemplateParser(source);
  return finish(parser, source, MAX_WIDGET_SOURCE_CHARS);
}

function finish(parser: TemplateParser, source: string, limit: number): WidgetDoc {
  let nodes: TNode[] = [];
  if (source.length > limit) {
    parser.problem(`The UI source is too long (${source.length} chars; limit ${limit}). Shorten it.`, 0);
    return { src: source, nodes, states: [], problems: parser.problems };
  }
  try {
    nodes = parser.parseChildren(0, "top", []).nodes;
  } catch (err) {
    if (err instanceof ParseAbort) {
      // the problem that stopped it is already recorded
    } else if (err instanceof WidgetTooComplex) {
      // Pushed directly: this verdict must survive the problem cap.
      parser.problems.push({ message: "The UI source is too complex to parse (too many unmatched brackets or backticks). Simplify it.", pos: 0 });
    } else if (err instanceof RangeError) {
      parser.problems.push({ message: "The UI source is nested too deeply. Flatten it.", pos: 0 });
    } else throw err;
    nodes = [];
  }
  return { src: source, nodes, states: parser.states, problems: parser.problems };
}

/** Longest answer looked at for UI: past it the answer is drawn as plain Markdown. */
export const MAX_ANSWER_SOURCE_CHARS = 400_000;
/** How many times an answer is re-read on the text before an unfinished construct. */
const MAX_ANSWER_CUTS = 8;

export interface AnswerDoc extends WidgetDoc {
  /**
   * Where the parsed text ends: `src.length`, or the start of a construct the
   * text ends inside of (it is not in `nodes`).
   */
  end: number;
  /**
   * The unfinished construct at `end`, while the answer is streaming: `tag` is
   * the component whose tag is being written (when its name is there), `top`
   * whether it sits at the document's top level. Null when nothing is cut.
   */
  pending: { tag?: string; top: boolean } | null;
  /** The parse gave up (too long, too deep, too complex): draw the answer as plain Markdown. */
  failed: boolean;
}

/**
 * Parse an avatar's answer (see the file header). Never throws for bad input.
 * `nodes` covers `src.slice(0, end)`; when the answer is finished and something
 * was cut, the rest follows as one top-level text node, so nothing the avatar
 * wrote disappears.
 */
export function parseAnswer(source: string, options: { streaming?: boolean } = {}): AnswerDoc {
  const streaming = Boolean(options.streaming);
  let end = source.length;
  let pending: AnswerDoc["pending"] = null;
  const advice: WidgetProblem[] = [];
  for (let round = 0; round <= MAX_ANSWER_CUTS; round++) {
    const text = end === source.length ? source : source.slice(0, end);
    const parser = new TemplateParser(text, { answer: true, streaming });
    try {
      const doc = finish(parser, text, MAX_ANSWER_SOURCE_CHARS);
      const failed = doc.nodes.length === 0 && doc.problems.length > 0;
      const nodes = doc.nodes;
      if (!failed && !streaming && end < source.length) {
        nodes.push({ t: "text", s: end, e: source.length, value: source.slice(end), block: true });
      }
      return { src: source, nodes, states: doc.states, problems: [...doc.problems, ...advice], end, pending: streaming ? pending : null, failed };
    } catch (err) {
      if (!(err instanceof StreamCut)) throw err;
      // The innermost cut is the construct actually being written; a later round only peels its parents.
      if (!pending) pending = { tag: err.tag, top: err.top };
      else if (err.tag && err.pos < end) pending = { tag: err.tag, top: err.top };
      if (!streaming && err.advice && advice.length < MAX_PROBLEMS) advice.push({ message: err.advice, pos: err.pos });
      end = Math.min(err.pos, end - 1);
      if (end <= 0) {
        end = 0;
        return { src: source, nodes: streaming ? [] : [{ t: "text", s: 0, e: source.length, value: source, block: true }], states: [], problems: advice, end, pending: streaming ? pending : null, failed: false };
      }
    }
  }
  return { src: source, nodes: [], states: [], problems: [{ message: "The UI source could not be parsed.", pos: 0 }], end: source.length, pending: null, failed: true };
}
