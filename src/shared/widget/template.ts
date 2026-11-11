/**
 * Widget document parser: component tags, `{@state}`/`{@const}` directives and
 * `{#each}`/`{#if}` blocks, with Markdown prose between them at the top level.
 *
 * Ported from mireiffe/mirineereum (src/lib/genui/template.ts @ 0e469c4) with
 * the owner's permission, and narrowed for a canvas artifact that arrives whole:
 *
 * - No streaming: an unfinished tag or block is an ERROR, not a pending node.
 * - Nothing is skipped silently. Every malformed directive, stray closing tag
 *   or unclosed block is recorded in `problems`, so the avatar can fix it.
 * - `{@state}` exists only at the top level; a duplicate name is a problem.
 * - Any `<name …>` is an element (the static checker rejects unknown names).
 *   There is no generic-HTML pass-through and no `<svg>` mode.
 * - Nesting is capped, and every scan is charged to a work budget, so a parse
 *   of a size-capped source is bounded in time.
 *
 * Modes
 * - top : the document's top level. Tags and directives are recognised only at
 *         the start of a line (indent ≤ 3); everything else is static Markdown
 *         (no `{expr}` interpolation). Fenced code and code spans are text.
 * - comp: inside a tag or a block. Tags anywhere, `{expr}` interpolation.
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
  | (Base & { t: "el"; name: string; attrs: Attr[]; children: TNode[] })
  | (Base & {
      t: "each";
      list: Expr;
      item: Pattern | null;
      index: string | null;
      children: TNode[];
      /** The `{:else}` body, shown when the list is empty. */
      empty: TNode[] | null;
    })
  | (Base & { t: "if"; branches: { test: Expr | null; children: TNode[] }[] })
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

type Mode = "top" | "comp";
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

  constructor(public src: string) {
    // Linear in the source. An ordinary document costs a few units per
    // character; the factor leaves room for the arrow-function lookahead
    // rescanning nested parentheses, and little else — input that makes the
    // parser re-read the same text over and over runs out quickly.
    this.budget = { left: src.length * 20 + 50_000 };
  }

  problem(message: string, pos: number) {
    if (this.problems.length < MAX_PROBLEMS) this.problems.push({ message, pos });
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
        if (li.newline && li.indent <= 3) {
          i = this.skipFence(i);
          continue;
        }
      }
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i = this.skipCodeSpan(i);
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
            i++;
            continue;
          }
          flush(i);
          const top = stack[stack.length - 1];
          if (top && top.k === "el" && top.name === close.name) {
            return { nodes, pos: close.end, stop: { kind: "close", consumed: true } };
          }
          if (stack.some((f) => f.k === "el" && f.name === close.name)) {
            return { nodes, pos: i, stop: { kind: "close", consumed: false } };
          }
          this.problem(`Unexpected closing tag </${close.name}>: no <${close.name}> is open here. Remove it, or add the matching opening tag.`, i);
          i = textStart = afterNode = close.end;
          continue;
        }
        if (src.startsWith("<!--", i)) {
          flush(i);
          const e = src.indexOf("-->", i + 4);
          if (e < 0) {
            this.problem("This <!-- comment is never closed. Add -->.", i);
            i = textStart = afterNode = n;
            break;
          }
          spend(this.budget, e - i);
          i = textStart = afterNode = e + 3;
          continue;
        }
        const r = this.tryElement(i, stack);
        if (r === null) {
          i++;
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
              : this.parseControl(i, j + kw[1].length, kw[1] as "#each" | "#if", stack);
          for (const nd of r.nodes) nodes.push(nd);
          i = textStart = afterNode = r.end;
          continue;
        }
        if (k === ":" || k === "/") {
          const tok = this.readCtlToken(i, j);
          if (tok && "error" in tok) {
            flush(i);
            this.exprProblem(tok.error, tok);
            const e = matchBracket(src, i, this.budget);
            i = textStart = afterNode = e < 0 ? i + 1 : e + 1;
            continue;
          }
          if (tok) {
            flush(i);
            const matches = (f: Frame | undefined) =>
              !!f && f.k !== "el" && (tok.tok.kind === "end" ? tok.tok.which === f.k : tok.tok.kind === "else" || f.k === "if");
            if (matches(stack[stack.length - 1])) return { nodes, pos: tok.end, stop: { kind: "ctl", tok: tok.tok, consumed: true } };
            if (stack.some((f) => matches(f))) return { nodes, pos: i, stop: { kind: "ctl", tok: tok.tok, consumed: false } };
            this.problem(`Unexpected ${src.slice(i, tok.end)}: there is no open {#each} / {#if} block for it.`, i);
            i = textStart = afterNode = tok.end;
            continue;
          }
        }
        if (mode === "comp") {
          const r = this.parseBraceExpr(i);
          flush(i);
          if ("error" in r) {
            this.exprProblem(`${r.error}. To show a literal "{", write \\{.`, r);
            const e = matchBracket(src, i, this.budget);
            i = textStart = afterNode = e < 0 ? i + 1 : e + 1;
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

  skipCodeSpan(i: number): number {
    const src = this.src;
    let k = 0;
    while (src[i + k] === "`") k++;
    let p = i + k;
    while (p < src.length) {
      const q = src.indexOf("`", p);
      if (q < 0) break;
      spend(this.budget, q - p + 1);
      // A code span never crosses a blank line.
      if (/\n[ \t]*\n/.test(src.slice(p, q))) break;
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

  /** An element starting at `<` (position i), or null when this `<` is plain text. */
  tryElement(i: number, stack: Frame[]): { node: TNode; end: number } | null {
    const src = this.src;
    const n = src.length;
    let p = i + 1;
    NAME_RE.lastIndex = p;
    const m = NAME_RE.exec(src);
    if (!m) return null;
    const name = m[0];
    p += name.length;
    if (p < n && !isWs(src[p]) && src[p] !== ">" && src[p] !== "/") return null;

    const attrs: Attr[] = [];
    const unfinished = (): { node: TNode; end: number } => {
      this.problem(`The <${name}> tag is never finished. End it with "/>" (no children) or ">".`, i);
      return { node: { t: "el", s: i, e: n, name, attrs, children: [] }, end: n };
    };

    let selfClose = false;
    for (;;) {
      while (p < n && isWs(src[p])) p++;
      if (p >= n) return unfinished();
      spend(this.budget, 1);
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
        if (e < 0) {
          this.problem(`The string for prop "${an}" of <${name}> is never closed.`, p);
          return { node: { t: "el", s: i, e: n, name, attrs, children: [] }, end: n };
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
          this.exprProblem(`Prop "${an}" of <${name}>: ${r.error}.`, r);
          const e = matchBracket(src, p, this.budget);
          if (e < 0) return { node: { t: "el", s: i, e: n, name, attrs, children: [] }, end: n };
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

    // A component that takes no children is self-closing even when written `<slider …>`.
    const isVoid = selfClose || (hasOwn(WIDGET_COMPONENTS, name) && WIDGET_COMPONENTS[name].child === "none");
    if (isVoid) {
      let end = p;
      if (!selfClose) {
        const m2 = /^\s*<\/\s*([A-Za-z][\w-]*)\s*>/.exec(src.slice(p, p + 80));
        if (m2 && m2[1] === name) end = p + m2[0].length;
      }
      return { node: { t: "el", s: i, e: end, name, attrs, children: [] }, end };
    }

    this.guardDepth(stack, i);
    const res = this.parseChildren(p, "comp", [...stack, { k: "el", name }]);
    if (!(res.stop.kind === "close" && res.stop.consumed)) {
      this.problem(
        res.stop.kind === "eof"
          ? `<${name}> is never closed. Add </${name}>.`
          : `<${name}> is not closed before ${JSON.stringify(src.slice(res.pos, Math.min(n, res.pos + 12)))}. Add </${name}> first.`,
        i,
      );
    }
    return { node: { t: "el", s: i, e: res.pos, name, attrs, children: res.nodes }, end: res.pos };
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
  exprProblem(message: string, e: { error: string; pos: number }): void {
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
          this.problem("{@state} must be declared at the top level of the widget, not inside a tag or a block. Move it to the top.", i);
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
      this.exprProblem(`{${kw}}: ${e.error}. Write {${kw} name = expression}.`, e);
      const close = matchBracket(src, i, this.budget);
      return { nodes: [], end: close < 0 ? src.length : close + 1 };
    }
  }

  parseControl(i: number, after: number, kw: "#each" | "#if", stack: Frame[]): { nodes: TNode[]; end: number } {
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
      this.exprProblem(`{${kw}}: ${e.error}. Write ${kw === "#each" ? "{#each list as item, index} … {/each}" : "{#if condition} … {/if}"}.`, e);
      const close = matchBracket(src, i, this.budget);
      return { nodes: [], end: close < 0 ? src.length : close + 1 };
    }

    const which = kw === "#each" ? "each" : "if";
    const unclosed = (res: ChildResult) => {
      this.problem(
        res.stop.kind === "eof"
          ? `{${kw}} is never closed. Add {/${which}}.`
          : `{${kw}} is not closed before ${JSON.stringify(src.slice(res.pos, Math.min(src.length, res.pos + 12)))}. Add {/${which}} first.`,
        i,
      );
    };

    if (kw === "#each") {
      const frames: Frame[] = [...stack, { k: "each" }];
      const body = this.parseChildren(headerEnd, "comp", frames);
      let empty: TNode[] | null = null;
      let res = body;
      if (body.stop.kind === "ctl" && body.stop.consumed && body.stop.tok.kind === "else") {
        res = this.parseChildren(body.pos, "comp", frames);
        empty = res.nodes;
      }
      if (!(res.stop.kind === "ctl" && res.stop.consumed)) unclosed(res);
      else if (res.stop.tok.kind !== "end") this.problem("{#each} takes one {:else} (shown when the list is empty), then {/each}.", i);
      return { nodes: [{ t: "each", s: i, e: res.pos, list: list!, item, index, children: body.nodes, empty }], end: res.pos };
    }

    const frames: Frame[] = [...stack, { k: "if" }];
    const branches: { test: Expr | null; children: TNode[] }[] = [];
    let curTest: Expr | null = test;
    let pos = headerEnd;
    let sawElse = false;
    for (;;) {
      const res = this.parseChildren(pos, "comp", frames);
      branches.push({ test: curTest, children: res.nodes });
      pos = res.pos;
      if (!(res.stop.kind === "ctl" && res.stop.consumed)) {
        unclosed(res);
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
    return { nodes: [{ t: "if", s: i, e: pos, branches }], end: pos };
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
  let nodes: TNode[] = [];
  if (source.length > MAX_WIDGET_SOURCE_CHARS) {
    parser.problem(`The widget source is too long (${source.length} chars; limit ${MAX_WIDGET_SOURCE_CHARS}). Shorten it or split it across canvases.`, 0);
    return { src: source, nodes, states: [], problems: parser.problems };
  }
  try {
    nodes = parser.parseChildren(0, "top", []).nodes;
  } catch (err) {
    if (err instanceof ParseAbort) {
      // the problem that stopped it is already recorded
    } else if (err instanceof WidgetTooComplex) {
      // Pushed directly: this verdict must survive the problem cap.
      parser.problems.push({ message: "The widget source is too complex to parse (too many unmatched brackets or backticks). Simplify it.", pos: 0 });
    } else if (err instanceof RangeError) {
      parser.problems.push({ message: "The widget source is nested too deeply. Flatten it.", pos: 0 });
    } else throw err;
    nodes = [];
  }
  return { src: source, nodes, states: parser.states, problems: parser.problems };
}
