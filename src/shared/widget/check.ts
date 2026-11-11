/**
 * Static check of a canvas `widget` source — what `mcp__canvas__show` runs
 * before anything is shown. It parses the document and analyses it WITHOUT
 * evaluating a single expression (the avatar's code never runs in Noah's
 * process): syntax, known components and props, required props, declared
 * names, where setters may be called, and the size limits.
 */
import type { Expr, Param, Pattern, Stmt } from "./expr.js";
import { GLOBAL_NAMES } from "./interp.js";
import { WIDGET_COMPONENTS, WIDGET_TAGS, literalProblem, type ComponentSpec } from "./spec.js";
import { lineCol, parseWidget, type Attr, type ElNode, type TNode, type WidgetDoc, type WidgetProblem } from "./template.js";

export type WidgetCheck = { ok: true; submits: boolean } | { ok: false; error: string };

export const MAX_WIDGET_NODES = 2000;
export const MAX_WIDGET_STATES = 50;
/** Problems reported in one error (the rest are counted). */
const MAX_REPORTED = 5;

const ACTION_NAMES = ["copy"];

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Edit distance, capped: enough to suggest a near-miss name. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function nearest(name: string, candidates: Iterable<string>): string | null {
  const lower = name.toLowerCase().replace(/[-_]/g, "");
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    const cl = c.toLowerCase().replace(/[-_]/g, "");
    if (cl === lower) return c;
    const d = distance(lower, cl);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

class Scope {
  names = new Set<string>();
  constructor(public parent: Scope | null = null) {}
  /** The scope that declares `name`, or null. */
  find(name: string): Scope | null {
    for (let s: Scope | null = this; s; s = s.parent) if (s.names.has(name)) return s;
    return null;
  }
  has(name: string): boolean {
    return this.find(name) !== null;
  }
  /** Visible names, innermost first, at most `limit` of them (candidates for a "did you mean"). */
  some(limit: number): string[] {
    const out: string[] = [];
    for (let s: Scope | null = this; s; s = s.parent) {
      for (const n of s.names) {
        out.push(n);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

function patternNames(pat: Pattern, out: string[] = []): string[] {
  if (pat.type === "Id") out.push(pat.name);
  else if (pat.type === "ArrPat") {
    for (const it of pat.items) if (it) patternNames(it.target, out);
    if (pat.rest) patternNames(pat.rest, out);
  } else {
    for (const p of pat.props) patternNames(p.value.target, out);
    if (pat.rest) out.push(pat.rest);
  }
  return out;
}

/**
 * Where an expression sits, for the rule that a setter (and `copy`) acts only
 * in an event:
 * - `render`: evaluated while rendering. A setter may not appear here at all —
 *   not called, and not passed around either (`{@const s = setN}`,
 *   `[1].map(setN)` and `(0, setN)(2)` all end up calling it during the render,
 *   where it does nothing).
 * - `handler`: the value of an event prop (`onClick={…}`). A setter may be
 *   NAMED (`onChange={setN}`, `onClick={ok ? setA : setB}`) but not called.
 * - `deferred`: the body of a function, which runs later. Anything goes.
 */
type Phase = "render" | "handler" | "deferred";

/** A problem whose text may be completed lazily (the "did you mean" of an undefined name is costly to compute). */
interface Finding extends WidgetProblem {
  full?: () => string;
}

/** Problems recorded per check (the report shows the first few; the rest are only counted). */
const MAX_FINDINGS = 200;
/** Names compared against for one "did you mean". */
const MAX_HINT_CANDIDATES = 300;

class Checker {
  problems: Finding[];
  nodeCount = 0;
  elements = 0;
  submits = false;
  /** Names whose use changes state or the clipboard — when they resolve to the root scope (a local may shadow them). */
  effects = new Set<string>(ACTION_NAMES);
  root = new Scope();

  constructor(public doc: WidgetDoc) {
    this.problems = [...doc.problems];
  }

  problem(message: string, pos: number, full?: () => string) {
    if (this.problems.length < MAX_FINDINGS) this.problems.push(full ? { message, pos, full } : { message, pos });
  }

  run(): void {
    const doc = this.doc;
    const globals = new Scope();
    for (const g of GLOBAL_NAMES) globals.names.add(g);

    if (doc.states.length > MAX_WIDGET_STATES) {
      this.problem(`Too many state variables (${doc.states.length}; limit ${MAX_WIDGET_STATES}). Group related values into one object state.`, doc.states[MAX_WIDGET_STATES].s);
    }

    // State initializers see the globals and the states declared before them.
    const stateScope = new Scope(globals);
    const taken = new Map<string, string>(); // name → what declared it
    const claim = (name: string, what: string, pos: number): boolean => {
      if (GLOBAL_NAMES.includes(name) || ACTION_NAMES.includes(name)) {
        this.problem(`"${name}" (${what}) shadows a built-in name. Choose another name.`, pos);
        return false;
      }
      const prev = taken.get(name);
      if (prev) {
        this.problem(`"${name}" (${what}) collides with ${prev}. Names of states, their setters and top-level consts must be unique.`, pos);
        return false;
      }
      taken.set(name, what);
      return true;
    };
    for (const st of doc.states) {
      if (st.init) this.expr(st.init, stateScope, "render", st.s, "a {@state} initializer (it can use only built-ins and states declared before it)");
      claim(st.name, "a state", st.s);
      claim(st.setter, `the setter of state "${st.name}"`, st.s);
      stateScope.names.add(st.name);
      this.effects.add(st.setter);
    }

    const root = (this.root = new Scope(globals));
    for (const st of doc.states) {
      root.names.add(st.name);
      root.names.add(st.setter);
    }
    for (const a of ACTION_NAMES) root.names.add(a);
    for (const node of doc.nodes) {
      if (node.t === "const") for (const n of patternNames(node.pattern)) if (claim(n, "a top-level const", node.s)) root.names.add(n);
    }
    this.children(doc.nodes, root, true);

    if (this.elements === 0 && this.problems.length === 0) {
      this.problem(
        "This widget has no component: a widget needs at least one (for plain text use contentType 'markdown'). " +
          "If the components are there but every line is indented 4+ spaces, the whole source is read as a Markdown code block — unindent it. " +
          "A component is recognised at the top level only at the START of a line.",
        0,
      );
    }
  }

  /** Check a children list. Its `{@const}` names are visible to the whole list (they are lazy at run time). */
  children(nodes: TNode[], scope: Scope, top = false): void {
    let inner = scope;
    if (!top && nodes.some((n) => n.t === "const")) {
      inner = new Scope(scope);
      for (const n of nodes) if (n.t === "const") for (const name of patternNames(n.pattern)) inner.names.add(name);
    }
    for (const node of nodes) this.node(node, inner, top);
  }

  node(node: TNode, scope: Scope, top: boolean): void {
    if (++this.nodeCount === MAX_WIDGET_NODES + 1) {
      this.problem(`The widget has too many nodes (limit ${MAX_WIDGET_NODES}). Render long lists from data with {#each} instead of writing each row.`, node.s);
    }
    switch (node.t) {
      case "text":
        if (top) this.topText(node.value, node.s, scope);
        return;
      case "expr":
        this.expr(node.expr, scope, "render", node.s);
        return;
      case "const":
        // The value is computed while rendering; only a FUNCTION kept in it runs later.
        this.expr(node.expr, scope, "render", node.s);
        this.pattern(node.pattern, scope, node.s, null);
        return;
      case "each": {
        this.expr(node.list, scope, "render", node.s);
        const inner = new Scope(scope);
        if (node.item) this.pattern(node.item, inner, node.s, inner);
        if (node.index) inner.names.add(node.index);
        this.children(node.children, inner);
        if (node.empty) this.children(node.empty, scope);
        return;
      }
      case "if":
        for (const b of node.branches) {
          if (b.test) this.expr(b.test, scope, "render", node.s);
          this.children(b.children, scope);
        }
        return;
      case "el":
        this.elements++;
        this.element(node, scope);
        return;
    }
  }

  /**
   * Top-level prose is static Markdown: an `{name}` there would be shown
   * literally. Code (fenced blocks and `code spans`) is exempt — showing
   * `{count}` literally is exactly what code is for.
   */
  topText(text: string, at: number, scope: Scope): void {
    if (!text.includes("{")) return;
    const prose = blankCode(text);
    const re = /\{\s*([A-Za-z_$][\w$]*)/g;
    for (let m = re.exec(prose); m; m = re.exec(prose)) {
      if (prose[m.index - 1] === "\\") continue;
      const name = m[1];
      if (scope.has(name) && !GLOBAL_NAMES.includes(name)) {
        this.problem(
          `Top-level text is static Markdown, so {${name}…} would be shown literally. Wrap the sentence in <text>…</text> to interpolate values.`,
          at + m.index,
        );
        return;
      }
    }
  }

  element(node: ElNode, scope: Scope): void {
    const spec: ComponentSpec | undefined = hasOwn(WIDGET_COMPONENTS, node.name) ? WIDGET_COMPONENTS[node.name] : undefined;
    if (!spec) {
      const hint = nearest(node.name, WIDGET_TAGS);
      this.problem(
        `Unknown component <${node.name}>.${hint ? ` Did you mean <${hint}>?` : ""} HTML tags are not supported in a widget. Components: ${WIDGET_TAGS.join(", ")}. If this "<" was meant as text, write \\< or &lt;.`,
        node.s,
      );
      // Still check what is inside, so its expressions are reported in the same round.
      for (const a of node.attrs) if (!a.bad && a.value !== true && typeof a.value !== "string") this.expr(a.value, scope, /^on[A-Z]/.test(a.name) ? "handler" : "render", a.s);
      this.children(node.children, scope);
      return;
    }
    if (spec.tag === "submit") this.submits = true;

    const seen = new Set<string>();
    for (const attr of node.attrs) {
      if (seen.has(attr.name)) {
        this.problem(`Prop "${attr.name}" is given twice on <${spec.tag}>.`, attr.s);
        continue;
      }
      seen.add(attr.name);
      if (attr.bad) continue; // its own problem is already recorded
      this.attr(spec, attr, scope);
    }
    for (const [name, p] of Object.entries(spec.props)) {
      if (!p.required || seen.has(name)) continue;
      if (name === "label" && spec.labelFromChildren && this.hasText(node.children)) continue;
      this.problem(`<${spec.tag}> is missing the required prop "${name}"${p.doc ? ` (${p.doc})` : ""}.`, node.s);
    }
    if (spec.labelFromChildren && !seen.has("label") && !this.hasText(node.children)) {
      this.problem(`<${spec.tag}> needs a label: put text between its tags, or pass label="…".`, node.s);
    }

    if (spec.child === "none") {
      if (this.hasContent(node.children)) this.problem(`<${spec.tag}> takes no children. Write it as <${spec.tag} … />.`, node.s);
      return;
    }
    if (spec.child === "inline") {
      const bad = this.firstElement(node.children);
      if (bad) {
        this.problem(
          `<${spec.tag}> takes text and {expr} only, but contains <${bad.name}>. Put <${bad.name}> next to it (for example both inside a <row>).`,
          bad.s,
        );
      }
    }
    this.children(node.children, scope);
  }

  attr(spec: ComponentSpec, attr: Attr, scope: Scope): void {
    const p = hasOwn(spec.props, attr.name) ? spec.props[attr.name] : undefined;
    if (!p) {
      const names = Object.keys(spec.props);
      const hint = nearest(attr.name, names);
      const note =
        attr.name === "style" || attr.name === "class" || attr.name === "className"
          ? " Styling props are not supported; use the component's own props."
          : /^on[A-Z]/.test(attr.name)
            ? " This component has no such event."
            : "";
      this.problem(
        `<${spec.tag}> has no prop "${attr.name}".${hint ? ` Did you mean "${hint}"?` : ""}${note} Props: ${names.length ? names.join(", ") : "(none)"}.`,
        attr.s,
      );
      if (attr.value !== true && typeof attr.value !== "string") this.expr(attr.value, scope, /^on[A-Z]/.test(attr.name) ? "handler" : "render", attr.s);
      return;
    }
    const fix = literalProblem(p.type, attr.value);
    if (fix) this.problem(`Prop "${attr.name}" of <${spec.tag}> ${fix}.`, attr.s);
    if (attr.value === true || typeof attr.value === "string") return;
    this.expr(attr.value, scope, p.type.k === "handler" ? "handler" : "render", attr.s);
  }

  hasText(nodes: TNode[]): boolean {
    return nodes.some((n) => (n.t === "text" ? n.value.trim() !== "" : n.t === "expr" || n.t === "if" || n.t === "each"));
  }

  hasContent(nodes: TNode[]): boolean {
    return nodes.some((n) => (n.t === "text" ? n.value.trim() !== "" : true));
  }

  firstElement(nodes: TNode[]): ElNode | null {
    for (const n of nodes) {
      if (n.t === "el") return n;
      if (n.t === "each") {
        const inner = this.firstElement(n.children) ?? (n.empty ? this.firstElement(n.empty) : null);
        if (inner) return inner;
      }
      if (n.t === "if") {
        for (const b of n.branches) {
          const inner = this.firstElement(b.children);
          if (inner) return inner;
        }
      }
    }
    return null;
  }

  /* ─────────── expressions ─────────── */

  /** Whether `name` here is a state setter or `copy` (and not a local that shadows one). */
  isEffect(name: string, scope: Scope): boolean {
    return this.effects.has(name) && scope.find(name) === this.root;
  }

  ident(name: string, scope: Scope, pos: number, where?: string): void {
    if (scope.has(name)) return;
    if (this.problems.length >= MAX_FINDINGS) return;
    const head = `"${name}" is not defined${where ? ` in ${where}` : ""}.`;
    const tail = ` Declare it BEFORE this use with {@state ${name} = …}, {@const ${name} = …} or a local const. Only these built-ins exist: ${GLOBAL_NAMES.join(", ")}, copy (no Date, no window, no fetch).`;
    // The suggestion is computed only for the problems that are actually reported.
    this.problem(head + tail, pos, () => {
      // By the time the report is built the scope also holds what was declared AFTER this use.
      const visible = scope.some(MAX_HINT_CANDIDATES);
      if (visible.includes(name)) return `${head} It is declared later in this block: move the declaration above this use.${tail}`;
      const hint = nearest(name, visible);
      return head + (hint ? ` Did you mean "${hint}"?` : "") + tail;
    });
  }

  /**
   * Check a binding pattern. Defaults and computed keys are checked in `scope`;
   * with `bind`, each name becomes visible there as soon as it is bound, so a
   * later default may use an earlier name (`({ a, b = a }) => …`), as at run time.
   */
  pattern(pat: Pattern, scope: Scope, pos: number, bind: Scope | null): void {
    if (pat.type === "Id") {
      bind?.names.add(pat.name);
    } else if (pat.type === "ArrPat") {
      for (const it of pat.items) {
        if (!it) continue;
        if (it.def) this.expr(it.def, scope, "render", pos);
        this.pattern(it.target, scope, pos, bind);
      }
      if (pat.rest) this.pattern(pat.rest, scope, pos, bind);
    } else {
      for (const p of pat.props) {
        if (p.computed) this.expr(p.key as Expr, scope, "render", pos);
        if (p.value.def) this.expr(p.value.def, scope, "render", pos);
        this.pattern(p.value.target, scope, pos, bind);
      }
      if (pat.rest) bind?.names.add(pat.rest);
    }
  }

  expr(e: Expr, scope: Scope, phase: Phase, pos: number, where?: string): void {
    switch (e.type) {
      case "Lit":
        return;
      case "Tmpl":
        for (const x of e.exprs) this.expr(x, scope, phase, pos, where);
        return;
      case "Id":
        this.ident(e.name, scope, pos, where);
        if (phase === "render" && this.isEffect(e.name, scope)) {
          this.problem(
            `${e.name} is used while rendering, where it does nothing. A setter (and copy) may appear only in an event prop (onChange={${e.name}}) or inside a function body ({@const fn = () => ${e.name}(…)}).`,
            pos,
          );
        }
        return;
      case "Arr":
        for (const it of e.items) if (it) this.expr(it.type === "Spread" ? it.arg : it, scope, phase, pos, where);
        return;
      case "Obj":
        for (const p of e.props) {
          if (p.kind === "spread") this.expr(p.arg, scope, phase, pos, where);
          else {
            if (p.kind === "computed") this.expr(p.key, scope, phase, pos, where);
            this.expr(p.value, scope, phase, pos, where);
          }
        }
        return;
      case "Mem":
        this.expr(e.obj, scope, phase, pos, where);
        if (e.computed) this.expr(e.prop as Expr, scope, phase, pos, where);
        return;
      case "Call":
        if (phase !== "deferred" && e.callee.type === "Id" && this.isEffect(e.callee.name, scope)) {
          this.problem(
            `${e.callee.name}(…) is called while rendering, where it does nothing. Call it inside an event handler, e.g. onClick={() => ${e.callee.name}(…)}.`,
            pos,
          );
        } else this.expr(e.callee, scope, phase, pos, where);
        for (const a of e.args) this.expr(a.type === "Spread" ? a.arg : a, scope, phase, pos, where);
        return;
      case "Arrow":
        this.arrow(e.params, e.body, e.expr, scope, pos, where);
        return;
      case "Un":
        // `typeof x` on an undeclared name is "undefined" at run time, not an error.
        if (e.op === "typeof" && e.arg.type === "Id") return;
        this.expr(e.arg, scope, phase, pos, where);
        return;
      case "Bin":
      case "Log":
        this.expr(e.left, scope, phase, pos, where);
        this.expr(e.right, scope, phase, pos, where);
        return;
      case "Cond":
        this.expr(e.test, scope, phase, pos, where);
        this.expr(e.cons, scope, phase, pos, where);
        this.expr(e.alt, scope, phase, pos, where);
        return;
      case "Seq":
        for (const x of e.exprs) this.expr(x, scope, phase, pos, where);
        return;
    }
  }

  /**
   * A function. Its body is `deferred` (it may run in an event). Parameters
   * are bound left to right, so a default sees the parameters before it.
   */
  arrow(params: Param[], body: Expr | Stmt[], isExpr: boolean, scope: Scope, pos: number, where?: string): void {
    const inner = new Scope(scope);
    for (const p of params) {
      if (p.def) this.expr(p.def, inner, "deferred", pos, where);
      this.pattern(p.target, inner, pos, inner);
    }
    if (isExpr) this.expr(body as Expr, inner, "deferred", pos, where);
    else this.block(body as Stmt[], inner, pos, where);
  }

  /**
   * Statements run in order, as at run time: a `const` is visible only AFTER
   * its declaration (`const a = b; const b = 1` fails on `b`), while function
   * declarations are hoisted to the top of their block.
   */
  block(stmts: Stmt[], scope: Scope, pos: number, where?: string): void {
    for (const s of stmts) if (s.type === "Func") scope.names.add(s.name);
    for (const s of stmts) this.stmt(s, scope, pos, where);
  }

  stmt(s: Stmt, scope: Scope, pos: number, where?: string): void {
    switch (s.type) {
      case "Empty":
        return;
      case "Decl":
        for (const d of s.decls) {
          if (d.init) this.expr(d.init, scope, "deferred", pos, where);
          this.pattern(d.target, scope, pos, scope);
        }
        return;
      case "Func":
        this.arrow(s.fn.params, s.fn.body, s.fn.expr, scope, pos, where);
        return;
      case "Return":
        if (s.arg) this.expr(s.arg, scope, "deferred", pos, where);
        return;
      case "If":
        this.expr(s.test, scope, "deferred", pos, where);
        this.stmt(s.cons, scope, pos, where);
        if (s.alt) this.stmt(s.alt, scope, pos, where);
        return;
      case "Block":
        this.block(s.body, new Scope(scope), pos, where);
        return;
      case "ExprStmt":
        this.expr(s.expr, scope, "deferred", pos, where);
        return;
    }
  }
}

/**
 * The same text with fenced code blocks and code spans blanked out (offsets
 * preserved). A hand-written scan: a regex with a backreference is quadratic
 * on a long run of unmatched backticks.
 */
function blankCode(text: string): string {
  if (!text.includes("`") && !text.includes("~~~")) return text;
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Fenced blocks, line by line.
  let fence: { ch: string; len: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    let p = lineStart;
    while (p < lineEnd && p - lineStart < 3 && text[p] === " ") p++;
    const ch = text[p];
    let run = 0;
    if (ch === "`" || ch === "~") while (text[p + run] === ch) run++;
    if (fence) {
      blank(lineStart, lineEnd);
      if (ch === fence.ch && run >= fence.len && text.slice(p + run, lineEnd).trim() === "") fence = null;
    } else if (run >= 3) {
      fence = { ch, len: run };
      blank(lineStart, lineEnd);
    }
    lineStart = lineEnd + 1;
  }
  // Code spans in what is left: a run of backticks up to the next run of the same length.
  const rest = out.join("");
  let i = rest.indexOf("`");
  while (i >= 0) {
    let k = 0;
    while (rest[i + k] === "`") k++;
    let q = i + k;
    let close = -1;
    while (q < rest.length) {
      const next = rest.indexOf("`", q);
      if (next < 0) break;
      let r = 0;
      while (rest[next + r] === "`") r++;
      if (r === k) {
        close = next;
        break;
      }
      q = next + r;
    }
    if (close < 0) {
      i = rest.indexOf("`", i + k);
      continue;
    }
    blank(i, close + k);
    i = rest.indexOf("`", close + k);
  }
  return out.join("");
}

function report(src: string, problems: Finding[]): string {
  const sorted = [...problems].sort((a, b) => a.pos - b.pos);
  const unique: Finding[] = [];
  const seen = new Set<string>();
  for (const p of sorted) {
    if (seen.has(p.message)) continue;
    seen.add(p.message);
    unique.push(p);
  }
  const shown = unique.slice(0, MAX_REPORTED);
  const lines = shown.map((p, i) => {
    const { line, col } = lineCol(src, p.pos);
    return `${i + 1}. line ${line}:${col} — ${p.full ? p.full() : p.message}`;
  });
  const more = unique.length > shown.length ? `\n(+${unique.length - shown.length} more; fix these first.)` : "";
  return (
    `Widget source has ${unique.length} problem${unique.length === 1 ? "" : "s"} — the canvas was NOT shown. ` +
    `Fix ${unique.length === 1 ? "it" : "them"} and call show again (pass the same canvasId if you were refining one).\n` +
    lines.join("\n") +
    more
  );
}

/**
 * Parse + statically check a widget source. `error` is AGENT-FACING ENGLISH: what is
 * wrong, where (line:col), and how to fix it. Never throws for bad input.
 */
export function checkWidget(source: string): WidgetCheck {
  if (typeof source !== "string" || source.trim() === "") {
    return { ok: false, error: "Widget source is empty — the canvas was NOT shown. Pass the widget document as content." };
  }
  const doc = parseWidget(source);
  const checker = new Checker(doc);
  // A parse that had to stop has no tree to analyse; its own problems say why.
  if (!(doc.nodes.length === 0 && doc.problems.length > 0)) {
    try {
      checker.run();
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      checker.problem("The widget source is nested too deeply to analyse. Flatten it.", 0);
    }
  }
  if (checker.problems.length > 0) return { ok: false, error: report(source, checker.problems) };
  return { ok: true, submits: checker.submits };
}
