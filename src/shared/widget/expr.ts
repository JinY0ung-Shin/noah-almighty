/**
 * Widget expression language — lexer + parser for a safe JavaScript subset.
 * No eval / new Function: the AST is walked by interp.ts.
 *
 * Ported from mireiffe/mirineereum (src/lib/genui/expr.ts @ 0e469c4) with the
 * owner's permission. Noah changes: no JSX-in-expression hook, no `{@body}`
 * statement lists, an explicit nesting-depth cap, and a shared work budget so a
 * parse of a size-capped source is bounded in time (the server runs this parser
 * in its own process).
 *
 * Supported: number/string/template literals, true/false/null, arrays/objects
 * (spread, shorthand, computed keys), . [] ?. member access, calls, arrow
 * functions (expression or block body), ternary, || && ??, arithmetic /
 * comparison / bitwise operators, typeof/void/!/-/+/~, comma expressions in
 * parentheses. Block-body statements: const/let/var (destructuring), function
 * declarations, return, if/else, expression statements.
 */

/** Counted parser work. Shared by the template parser and every expression parser of one document. */
export interface WorkBudget {
  left: number;
}

/** Thrown when a parse exceeds its work budget (pathological input). */
export class WidgetTooComplex extends Error {
  constructor() {
    super("widget source is too complex to parse");
  }
}

export function spend(budget: WorkBudget | null | undefined, n: number): void {
  if (budget && (budget.left -= n) < 0) throw new WidgetTooComplex();
}

/** Expression nesting limit (64 bracket levels; each level costs up to 3 counted frames). */
export const MAX_EXPR_NESTING = 64;
const MAX_PARSE_DEPTH = MAX_EXPR_NESTING * 3;
/**
 * Longest left-associative chain: `a + b + c …` operators, or `.b` / `(…)` /
 * `[…]` steps after one primary. Such a chain nests the AST one level per
 * link without any bracket, so it needs its own cap.
 */
export const MAX_EXPR_CHAIN = 200;
/**
 * Deepest AST an expression may have. The interpreter recurses once per AST
 * level, so this — together with its own run-time nesting cap — is what keeps
 * an ACCEPTED expression from overflowing the native stack when it is evaluated.
 */
export const MAX_AST_DEPTH = 300;


export class WidgetIncomplete extends Error {
  constructor(public pos: number) {
    super("unexpected end of input");
  }
}

export class WidgetSyntaxError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

/* ───────────────────────── AST ───────────────────────── */

export type Pattern =
  | { type: "Id"; name: string }
  | { type: "ArrPat"; items: (PatItem | null)[]; rest: Pattern | null }
  | { type: "ObjPat"; props: { key: string | Expr; computed: boolean; value: PatItem }[]; rest: string | null };

export interface PatItem {
  target: Pattern;
  def: Expr | null;
}

export interface Param {
  target: Pattern;
  def: Expr | null;
  rest: boolean;
}

export type SpreadEl = { type: "Spread"; arg: Expr };

export type ObjProp =
  | { kind: "prop"; key: string; value: Expr }
  | { kind: "computed"; key: Expr; value: Expr }
  | { kind: "spread"; arg: Expr };

export type Expr =
  | { type: "Lit"; value: unknown }
  | { type: "Tmpl"; quasis: string[]; exprs: Expr[] }
  | { type: "Id"; name: string }
  | { type: "Arr"; items: (Expr | SpreadEl | null)[] }
  | { type: "Obj"; props: ObjProp[] }
  | { type: "Mem"; obj: Expr; prop: string | Expr; computed: boolean; optional: boolean }
  | { type: "Call"; callee: Expr; args: (Expr | SpreadEl)[]; optional: boolean }
  | { type: "Arrow"; params: Param[]; body: Expr | Stmt[]; expr: boolean }
  | { type: "Un"; op: string; arg: Expr }
  | { type: "Bin"; op: string; left: Expr; right: Expr }
  | { type: "Log"; op: "||" | "&&" | "??"; left: Expr; right: Expr }
  | { type: "Cond"; test: Expr; cons: Expr; alt: Expr }
  | { type: "Seq"; exprs: Expr[] };

export type Stmt =
  | { type: "Decl"; decls: { target: Pattern; init: Expr | null }[] }
  | { type: "Func"; name: string; fn: Expr & { type: "Arrow" } }
  | { type: "Return"; arg: Expr | null }
  | { type: "If"; test: Expr; cons: Stmt; alt: Stmt | null }
  | { type: "Block"; body: Stmt[] }
  | { type: "ExprStmt"; expr: Expr }
  | { type: "Empty" };

/* ───────────────────────── Lexer ───────────────────────── */

export type TokType = "num" | "str" | "tmpl" | "ident" | "punc" | "eof";

export interface Token {
  type: TokType;
  value: string | number;
  start: number;
  end: number;
  nl: boolean;
}

const PUNCS = [
  ">>>",
  "...",
  "===",
  "!==",
  "**",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "++",
  "--",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ",",
  ";",
  ":",
  "?",
  ".",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "<",
  ">",
  "=",
  "~",
  "&",
  "|",
  "^",
];

const ID_START = /[\p{ID_Start}$_]/u;
const ID_RE = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const NUM_RE = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/y;

export class Lexer {
  pos: number;
  constructor(
    public src: string,
    pos = 0,
    public budget: WorkBudget | null = null,
  ) {
    this.pos = pos;
  }

  skipWs(): boolean {
    const s = this.src;
    let nl = false;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) {
        nl = true;
        this.pos++;
      } else if (c === 32 || c === 9 || c === 11 || c === 12 || c === 0xa0 || c === 0xfeff) {
        this.pos++;
      } else if (c === 47 /* / */ && s.charCodeAt(this.pos + 1) === 47) {
        const e = s.indexOf("\n", this.pos);
        this.pos = e < 0 ? s.length : e;
      } else if (c === 47 && s.charCodeAt(this.pos + 1) === 42 /* * */) {
        const e = s.indexOf("*/", this.pos + 2);
        if (e < 0) throw new WidgetIncomplete(s.length);
        if (s.slice(this.pos, e).includes("\n")) nl = true;
        this.pos = e + 2;
      } else break;
    }
    return nl;
  }

  next(): Token {
    spend(this.budget, 1);
    const nl = this.skipWs();
    const s = this.src;
    const start = this.pos;
    if (start >= s.length) return { type: "eof", value: "", start, end: start, nl };
    const ch = s[start];

    // number
    if ((ch >= "0" && ch <= "9") || (ch === "." && s[start + 1] >= "0" && s[start + 1] <= "9")) {
      NUM_RE.lastIndex = start;
      const m = NUM_RE.exec(s);
      if (m) {
        const raw = m[0].replace(/_/g, "");
        this.pos = start + m[0].length;
        let v: number;
        if (/^0[bB]/.test(raw)) v = parseInt(raw.slice(2), 2);
        else if (/^0[oO]/.test(raw)) v = parseInt(raw.slice(2), 8);
        else v = Number(raw);
        if (ID_START.test(s[this.pos] ?? "")) throw new WidgetSyntaxError("invalid number", start);
        return { type: "num", value: v, start, end: this.pos, nl };
      }
    }

    // string
    if (ch === '"' || ch === "'") {
      const v = this.readString(ch);
      return { type: "str", value: v, start, end: this.pos, nl };
    }

    if (ch === "`") {
      this.pos = start + 1;
      return { type: "tmpl", value: "`", start, end: start + 1, nl };
    }

    // identifier
    if (ID_START.test(ch)) {
      ID_RE.lastIndex = start;
      const m = ID_RE.exec(s);
      if (m) {
        this.pos = start + m[0].length;
        return { type: "ident", value: m[0], start, end: this.pos, nl };
      }
    }

    // punctuator
    for (const p of PUNCS) {
      if (s.startsWith(p, start)) {
        if (p === "?." && s[start + 2] >= "0" && s[start + 2] <= "9") continue;
        this.pos = start + p.length;
        return { type: "punc", value: p, start, end: this.pos, nl };
      }
    }
    throw new WidgetSyntaxError(`unexpected character ${JSON.stringify(ch)}`, start);
  }

  readString(q: string): string {
    const s = this.src;
    let i = this.pos + 1;
    let out = "";
    for (;;) {
      if (i >= s.length) throw new WidgetIncomplete(i);
      const c = s[i];
      if (c === q) {
        this.pos = i + 1;
        return out;
      }
      if (c === "\\") {
        const r = readEscape(s, i);
        out += r.value;
        i = r.end;
        continue;
      }
      if (c === "\n") throw new WidgetSyntaxError("unterminated string", i);
      out += c;
      i++;
    }
  }

  readTemplatePart(): { text: string; more: boolean } {
    const s = this.src;
    let i = this.pos;
    let out = "";
    for (;;) {
      if (i >= s.length) throw new WidgetIncomplete(i);
      const c = s[i];
      if (c === "`") {
        this.pos = i + 1;
        return { text: out, more: false };
      }
      if (c === "$" && s[i + 1] === "{") {
        this.pos = i + 2;
        return { text: out, more: true };
      }
      if (c === "\\") {
        const r = readEscape(s, i);
        out += r.value;
        i = r.end;
        continue;
      }
      if (c === "\r") {
        out += "\n";
        i += s[i + 1] === "\n" ? 2 : 1;
        continue;
      }
      out += c;
      i++;
    }
  }
}

function readEscape(s: string, i: number): { value: string; end: number } {
  const n = s[i + 1];
  if (n === undefined) throw new WidgetIncomplete(i + 1);
  switch (n) {
    case "n":
      return { value: "\n", end: i + 2 };
    case "t":
      return { value: "\t", end: i + 2 };
    case "r":
      return { value: "\r", end: i + 2 };
    case "b":
      return { value: "\b", end: i + 2 };
    case "f":
      return { value: "\f", end: i + 2 };
    case "v":
      return { value: "\v", end: i + 2 };
    case "0":
      return { value: "\0", end: i + 2 };
    case "\r":
      return { value: "", end: s[i + 2] === "\n" ? i + 3 : i + 2 };
    case "\n":
      return { value: "", end: i + 2 };
    case "x": {
      const h = s.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(h)) return { value: String.fromCharCode(parseInt(h, 16)), end: i + 4 };
      return { value: "x", end: i + 2 };
    }
    case "u": {
      if (s[i + 2] === "{") {
        const e = s.indexOf("}", i + 3);
        const h = e > 0 ? s.slice(i + 3, e) : "";
        if (/^[0-9a-fA-F]{1,6}$/.test(h)) {
          const cp = parseInt(h, 16);
          if (cp <= 0x10ffff) return { value: String.fromCodePoint(cp), end: e + 1 };
        }
        return { value: "u", end: i + 2 };
      }
      const h = s.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(h)) return { value: String.fromCharCode(parseInt(h, 16)), end: i + 6 };
      return { value: "u", end: i + 2 };
    }
    default:
      return { value: n, end: i + 2 };
  }
}

/* ───────────────────────── Parser ───────────────────────── */

const BIN_PREC: Record<string, number> = {
  "??": 1,
  "||": 1,
  "&&": 2,
  "|": 3,
  "^": 4,
  "&": 5,
  "==": 6,
  "!=": 6,
  "===": 6,
  "!==": 6,
  "<": 7,
  ">": 7,
  "<=": 7,
  ">=": 7,
  in: 7,
  "<<": 8,
  ">>": 8,
  ">>>": 8,
  "+": 9,
  "-": 9,
  "*": 10,
  "/": 10,
  "%": 10,
  "**": 11,
};

const RESERVED = new Set([
  "new",
  "class",
  "delete",
  "while",
  "for",
  "do",
  "switch",
  "try",
  "catch",
  "throw",
  "await",
  "async",
  "yield",
  "import",
  "export",
  "with",
  "debugger",
  "super",
  "this",
  "instanceof",
]);

export interface ParserOptions {
  /** Shared work budget; every token and bracket scan is charged against it. */
  budget?: WorkBudget | null;
}

export class Parser {
  lex: Lexer;
  tok: Token;
  /** End offset of the last consumed token (source slices of what was just parsed). */
  lastEnd: number;
  private depth = 0;

  private enter(): void {
    if (++this.depth > MAX_PARSE_DEPTH) {
      throw new WidgetSyntaxError(`expression is nested too deeply (limit ${MAX_EXPR_NESTING} levels)`, this.tok.start);
    }
  }
  constructor(
    public src: string,
    pos = 0,
    public opts: ParserOptions = {},
  ) {
    this.lex = new Lexer(src, pos, opts.budget ?? null);
    this.lastEnd = pos;
    this.tok = this.lex.next();
  }

  /* — token helpers — */
  advance(): Token {
    const t = this.tok;
    this.lastEnd = t.end;
    this.tok = this.lex.next();
    return t;
  }
  isP(v: string): boolean {
    return this.tok.type === "punc" && this.tok.value === v;
  }
  isId(v?: string): boolean {
    return this.tok.type === "ident" && (v === undefined || this.tok.value === v);
  }
  eatP(v: string): boolean {
    if (this.isP(v)) {
      this.advance();
      return true;
    }
    return false;
  }
  expectP(v: string): Token {
    if (this.isP(v)) return this.advance();
    this.fail(`expected '${v}'`);
  }
  fail(msg: string): never {
    if (this.tok.type === "eof") throw new WidgetIncomplete(this.tok.start);
    throw new WidgetSyntaxError(`${msg} but found ${JSON.stringify(this.tok.value)}`, this.tok.start);
  }
  peekNext(): Token {
    const save = this.lex.pos;
    const t = this.lex.next();
    this.lex.pos = save;
    return t;
  }

  /* — expressions — */

  parseExpr(): Expr {
    this.enter();
    try {
      return this.parseExprInner();
    } finally {
      this.depth--;
    }
  }

  private parseExprInner(): Expr {
    const arrow = this.tryArrow();
    if (arrow) return arrow;
    return this.parseCond();
  }

  parseSeq(): Expr {
    const first = this.parseExpr();
    if (!this.isP(",")) return first;
    const exprs = [first];
    while (this.eatP(",")) {
      if (this.isP(")")) break;
      exprs.push(this.parseExpr());
    }
    return { type: "Seq", exprs };
  }

  parseCond(): Expr {
    const test = this.parseBin(1);
    if (this.isP("?")) {
      this.advance();
      const cons = this.parseExpr();
      this.expectP(":");
      const alt = this.parseExpr();
      return { type: "Cond", test, cons, alt };
    }
    if (this.tok.type === "punc" && /^(=|\+=|-=|\*=|\/=|\+\+|--)$/.test(String(this.tok.value))) {
      throw new WidgetSyntaxError("assignment is not allowed", this.tok.start);
    }
    return test;
  }

  binOp(): string | null {
    const t = this.tok;
    if (t.type === "punc" && BIN_PREC[t.value as string] !== undefined) return t.value as string;
    if (t.type === "ident" && t.value === "in") return "in";
    return null;
  }

  parseBin(minPrec: number): Expr {
    this.enter();
    try {
      return this.parseBinInner(minPrec);
    } finally {
      this.depth--;
    }
  }

  private parseBinInner(minPrec: number): Expr {
    let left = this.parseUnary();
    let links = 0;
    for (;;) {
      const op = this.binOp();
      if (!op) break;
      const prec = BIN_PREC[op];
      if (prec < minPrec) break;
      if (++links > MAX_EXPR_CHAIN) {
        throw new WidgetSyntaxError(`too many chained operators (limit ${MAX_EXPR_CHAIN}); split the expression into {@const} steps`, this.tok.start);
      }
      this.advance();
      const right = op === "**" ? this.parseBin(prec) : this.parseBin(prec + 1);
      if (op === "||" || op === "&&" || op === "??") left = { type: "Log", op, left, right };
      else left = { type: "Bin", op, left, right };
    }
    return left;
  }

  parseUnary(): Expr {
    this.enter();
    try {
      return this.parseUnaryInner();
    } finally {
      this.depth--;
    }
  }

  private parseUnaryInner(): Expr {
    const t = this.tok;
    if (t.type === "punc" && (t.value === "!" || t.value === "-" || t.value === "+" || t.value === "~")) {
      this.advance();
      return { type: "Un", op: t.value as string, arg: this.parseUnary() };
    }
    if (t.type === "ident" && (t.value === "typeof" || t.value === "void")) {
      this.advance();
      return { type: "Un", op: t.value as string, arg: this.parseUnary() };
    }
    if (t.type === "punc" && (t.value === "++" || t.value === "--")) {
      throw new WidgetSyntaxError("update expressions are not allowed", t.start);
    }
    return this.parsePostfix();
  }

  parsePostfix(): Expr {
    let e = this.parsePrimary();
    let links = 0;
    for (;;) {
      if (links++ > MAX_EXPR_CHAIN && (this.isP(".") || this.isP("?.") || this.isP("[") || this.isP("("))) {
        throw new WidgetSyntaxError(`too many chained member accesses or calls (limit ${MAX_EXPR_CHAIN}); split the expression into {@const} steps`, this.tok.start);
      }
      if (this.isP(".")) {
        this.advance();
        if (this.tok.type !== "ident") this.fail("expected property name");
        e = { type: "Mem", obj: e, prop: this.advance().value as string, computed: false, optional: false };
      } else if (this.isP("?.")) {
        this.advance();
        if (this.isP("(")) {
          e = { type: "Call", callee: e, args: this.parseArgs(), optional: true };
        } else if (this.isP("[")) {
          this.advance();
          const prop = this.parseSeq();
          this.expectP("]");
          e = { type: "Mem", obj: e, prop, computed: true, optional: true };
        } else {
          if (this.tok.type !== "ident") this.fail("expected property name");
          e = { type: "Mem", obj: e, prop: this.advance().value as string, computed: false, optional: true };
        }
      } else if (this.isP("[")) {
        this.advance();
        const prop = this.parseSeq();
        this.expectP("]");
        e = { type: "Mem", obj: e, prop, computed: true, optional: false };
      } else if (this.isP("(")) {
        e = { type: "Call", callee: e, args: this.parseArgs(), optional: false };
      } else if (this.tok.type === "tmpl") {
        throw new WidgetSyntaxError("tagged templates are not allowed", this.tok.start);
      } else break;
    }
    return e;
  }

  parseArgs(): (Expr | SpreadEl)[] {
    this.expectP("(");
    const args: (Expr | SpreadEl)[] = [];
    while (!this.isP(")")) {
      if (this.eatP("...")) args.push({ type: "Spread", arg: this.parseExpr() });
      else args.push(this.parseExpr());
      if (!this.eatP(",")) break;
    }
    this.expectP(")");
    return args;
  }

  parsePrimary(): Expr {
    const t = this.tok;
    switch (t.type) {
      case "num":
      case "str":
        this.advance();
        return { type: "Lit", value: t.value };
      case "tmpl":
        return this.parseTemplate();
      case "ident": {
        const name = t.value as string;
        if (name === "true" || name === "false") {
          this.advance();
          return { type: "Lit", value: name === "true" };
        }
        if (name === "null") {
          this.advance();
          return { type: "Lit", value: null };
        }
        if (name === "function") return this.parseFunctionExpr();
        if (RESERVED.has(name)) throw new WidgetSyntaxError(`'${name}' is not supported`, t.start);
        this.advance();
        return { type: "Id", name };
      }
      case "punc":
        if (t.value === "(") {
          this.advance();
          const e = this.parseSeq();
          this.expectP(")");
          return e;
        }
        if (t.value === "[") return this.parseArray();
        if (t.value === "{") return this.parseObject();
        this.fail("unexpected token");
        break;
      case "eof":
        throw new WidgetIncomplete(t.start);
    }
    this.fail("unexpected token");
  }

  parseTemplate(): Expr {
    const quasis: string[] = [];
    const exprs: Expr[] = [];
    this.lex.pos = this.tok.end;
    for (;;) {
      const part = this.lex.readTemplatePart();
      quasis.push(part.text);
      if (!part.more) break;
      this.tok = this.lex.next();
      exprs.push(this.parseSeq());
      if (!this.isP("}")) this.fail("expected '}' in template");
      this.lex.pos = this.tok.end;
    }
    this.lastEnd = this.lex.pos;
    this.tok = this.lex.next();
    return { type: "Tmpl", quasis, exprs };
  }

  parseArray(): Expr {
    this.expectP("[");
    const items: (Expr | SpreadEl | null)[] = [];
    while (!this.isP("]")) {
      if (this.isP(",")) {
        this.advance();
        items.push(null);
        continue;
      }
      if (this.eatP("...")) items.push({ type: "Spread", arg: this.parseExpr() });
      else items.push(this.parseExpr());
      if (!this.eatP(",")) break;
    }
    this.expectP("]");
    return { type: "Arr", items };
  }

  parsePropKey(): { key: string | Expr; computed: boolean } {
    const t = this.tok;
    if (t.type === "ident" || t.type === "str") {
      this.advance();
      return { key: String(t.value), computed: false };
    }
    if (t.type === "num") {
      this.advance();
      return { key: String(t.value), computed: false };
    }
    if (this.isP("[")) {
      this.advance();
      const key = this.parseExpr();
      this.expectP("]");
      return { key, computed: true };
    }
    this.fail("expected property key");
  }

  parseObject(): Expr {
    this.expectP("{");
    const props: ObjProp[] = [];
    while (!this.isP("}")) {
      if (this.eatP("...")) {
        props.push({ kind: "spread", arg: this.parseExpr() });
      } else {
        const isIdent = this.tok.type === "ident";
        const { key, computed } = this.parsePropKey();
        let value: Expr;
        if (this.eatP(":")) value = this.parseExpr();
        else if (this.isP("(")) value = this.parseFunctionRest();
        else if (isIdent && !computed) value = { type: "Id", name: key as string };
        else this.fail("expected ':'");
        if (computed) props.push({ kind: "computed", key: key as Expr, value });
        else props.push({ kind: "prop", key: key as string, value });
      }
      if (!this.eatP(",")) break;
    }
    this.expectP("}");
    return { type: "Obj", props };
  }

  /* — arrow functions & patterns — */

  tryArrow(): Expr | null {
    const t = this.tok;
    if (t.type === "ident" && !RESERVED.has(t.value as string)) {
      const n = this.peekNext();
      if (n.type === "punc" && n.value === "=>") {
        this.advance();
        this.advance();
        return this.parseArrowBody([{ target: { type: "Id", name: t.value as string }, def: null, rest: false }]);
      }
      if (t.value === "async") throw new WidgetSyntaxError("async is not supported", t.start);
      return null;
    }
    if (t.type === "punc" && t.value === "(") {
      const close = matchBracket(this.src, t.start, this.opts.budget ?? null);
      if (close < 0) return null;
      const after = new Lexer(this.src, close + 1);
      let nt: Token;
      try {
        nt = after.next();
      } catch {
        return null;
      }
      if (nt.type !== "punc" || nt.value !== "=>") return null;
      const params = this.parseParams();
      this.expectP("=>");
      return this.parseArrowBody(params);
    }
    return null;
  }

  parseParams(): Param[] {
    this.expectP("(");
    const params: Param[] = [];
    while (!this.isP(")")) {
      if (this.eatP("...")) {
        params.push({ target: this.parsePattern(), def: null, rest: true });
        break;
      }
      const target = this.parsePattern();
      const def = this.eatP("=") ? this.parseExpr() : null;
      params.push({ target, def, rest: false });
      if (!this.eatP(",")) break;
    }
    this.expectP(")");
    return params;
  }

  parseArrowBody(params: Param[]): Expr {
    if (this.isP("{")) {
      const body = this.parseBlockBody();
      return { type: "Arrow", params, body, expr: false };
    }
    return { type: "Arrow", params, body: this.parseExpr(), expr: true };
  }

  parseFunctionExpr(): Expr {
    this.advance(); // function
    if (this.tok.type === "ident") this.advance();
    return this.parseFunctionRest();
  }

  parseFunctionRest(): Expr & { type: "Arrow" } {
    const params = this.parseParams();
    const body = this.parseBlockBody();
    return { type: "Arrow", params, body, expr: false };
  }

  parsePattern(): Pattern {
    this.enter();
    try {
      return this.parsePatternInner();
    } finally {
      this.depth--;
    }
  }

  private parsePatternInner(): Pattern {
    const t = this.tok;
    if (t.type === "ident") {
      if (RESERVED.has(t.value as string)) this.fail("reserved word");
      this.advance();
      return { type: "Id", name: t.value as string };
    }
    if (this.isP("[")) {
      this.advance();
      const items: (PatItem | null)[] = [];
      let rest: Pattern | null = null;
      while (!this.isP("]")) {
        if (this.isP(",")) {
          this.advance();
          items.push(null);
          continue;
        }
        if (this.eatP("...")) {
          rest = this.parsePattern();
          break;
        }
        const target = this.parsePattern();
        const def = this.eatP("=") ? this.parseExpr() : null;
        items.push({ target, def });
        if (!this.eatP(",")) break;
      }
      this.expectP("]");
      return { type: "ArrPat", items, rest };
    }
    if (this.isP("{")) {
      this.advance();
      const props: { key: string | Expr; computed: boolean; value: PatItem }[] = [];
      let rest: string | null = null;
      while (!this.isP("}")) {
        if (this.eatP("...")) {
          if (this.tok.type !== "ident") this.fail("expected identifier");
          rest = this.advance().value as string;
          break;
        }
        const isIdent = this.tok.type === "ident";
        const { key, computed } = this.parsePropKey();
        let target: Pattern;
        if (this.eatP(":")) target = this.parsePattern();
        else if (isIdent && !computed) target = { type: "Id", name: key as string };
        else this.fail("expected ':'");
        const def = this.eatP("=") ? this.parseExpr() : null;
        props.push({ key, computed, value: { target, def } });
        if (!this.eatP(",")) break;
      }
      this.expectP("}");
      return { type: "ObjPat", props, rest };
    }
    this.fail("expected binding pattern");
  }

  /* — statements — */

  parseBlockBody(): Stmt[] {
    this.expectP("{");
    const body: Stmt[] = [];
    while (!this.isP("}")) {
      if (this.tok.type === "eof") throw new WidgetIncomplete(this.tok.start);
      body.push(this.parseStmt());
    }
    this.expectP("}");
    return body;
  }

  endStmt() {
    if (this.eatP(";")) return;
    if (this.isP("}") || this.tok.type === "eof" || this.tok.nl) return;
    this.fail("expected ';'");
  }

  parseStmt(): Stmt {
    this.enter();
    try {
      return this.parseStmtInner();
    } finally {
      this.depth--;
    }
  }

  private parseStmtInner(): Stmt {
    const t = this.tok;
    if (this.isP(";")) {
      this.advance();
      return { type: "Empty" };
    }
    if (this.isP("{")) return { type: "Block", body: this.parseBlockBody() };
    if (t.type === "ident") {
      const kw = t.value as string;
      if (kw === "const" || kw === "let" || kw === "var") {
        this.advance();
        const decls: { target: Pattern; init: Expr | null }[] = [];
        do {
          const target = this.parsePattern();
          const init = this.eatP("=") ? this.parseExpr() : null;
          decls.push({ target, init });
        } while (this.eatP(","));
        this.endStmt();
        return { type: "Decl", decls };
      }
      if (kw === "function") {
        this.advance();
        if (this.tok.type !== "ident") this.fail("expected function name");
        const name = this.advance().value as string;
        const fn = this.parseFunctionRest();
        return { type: "Func", name, fn };
      }
      if (kw === "return") {
        this.advance();
        if (this.isP(";") || this.isP("}") || this.tok.type === "eof" || this.tok.nl) {
          this.eatP(";");
          return { type: "Return", arg: null };
        }
        const arg = this.parseSeq();
        this.endStmt();
        return { type: "Return", arg };
      }
      if (kw === "if") {
        this.advance();
        this.expectP("(");
        const test = this.parseSeq();
        this.expectP(")");
        const cons = this.parseStmt();
        let alt: Stmt | null = null;
        if (this.isId("else")) {
          this.advance();
          alt = this.parseStmt();
        }
        return { type: "If", test, cons, alt };
      }
    }
    const expr = this.parseSeq();
    this.endStmt();
    return { type: "ExprStmt", expr };
  }
}

export function matchBracket(src: string, open: number, budget: WorkBudget | null = null, depth = 0): number {
  if (depth > MAX_EXPR_NESTING) return -1;
  const r = scanBracket(src, open, budget, depth);
  // Charge the scanned span: to the match, or to the end of input on a miss.
  spend(budget, (r < 0 ? src.length : r) - open + 1);
  return r;
}

function scanBracket(src: string, open: number, budget: WorkBudget | null, depth: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i, c);
      if (i < 0) return -1;
      continue;
    }
    if (c === "`") {
      i = skipTemplate(src, i, budget, depth);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      if (e < 0) return -1;
      i = e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      if (e < 0) return -1;
      i = e + 2;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
    i++;
  }
  return -1;
}

function skipQuoted(src: string, i: number, q: string): number {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (c === "\n") return -1;
    i++;
  }
  return -1;
}

function skipTemplate(src: string, i: number, budget: WorkBudget | null, depth: number): number {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && src[i + 1] === "{") {
      const e = matchBracket(src, i + 1, budget, depth + 1);
      if (e < 0) return -1;
      i = e + 1;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Depth of an expression's AST (an iterative walk: the tree may be far deeper
 * than the native stack could follow). Stops counting past `limit`.
 */
export function exprDepth(root: Expr, limit = MAX_AST_DEPTH): number {
  type Node = Expr | Stmt | Pattern | SpreadEl | null | undefined;
  const stack: [Node, number][] = [[root, 1]];
  let max = 0;
  const pattern = (pat: Pattern, d: number) => {
    if (pat.type === "ArrPat") {
      for (const it of pat.items) {
        if (!it) continue;
        stack.push([it.target, d]);
        if (it.def) stack.push([it.def, d]);
      }
      if (pat.rest) stack.push([pat.rest, d]);
    } else if (pat.type === "ObjPat") {
      for (const p of pat.props) {
        if (p.computed) stack.push([p.key as Expr, d]);
        stack.push([p.value.target, d]);
        if (p.value.def) stack.push([p.value.def, d]);
      }
    }
  };
  while (stack.length) {
    const [n, depth] = stack.pop()!;
    if (!n) continue;
    if (depth > max) max = depth;
    if (max > limit) return max;
    const d = depth + 1;
    switch (n.type) {
      case "Lit":
      case "Id":
      case "Empty":
        break;
      case "Tmpl":
      case "Seq":
        for (const x of n.exprs) stack.push([x, d]);
        break;
      case "Arr":
        for (const x of n.items) stack.push([x, d]);
        break;
      case "Spread":
        stack.push([n.arg, d]);
        break;
      case "Obj":
        for (const p of n.props) {
          if (p.kind === "spread") stack.push([p.arg, d]);
          else {
            if (p.kind === "computed") stack.push([p.key, d]);
            stack.push([p.value, d]);
          }
        }
        break;
      case "Mem":
        stack.push([n.obj, d]);
        if (n.computed) stack.push([n.prop as Expr, d]);
        break;
      case "Call":
        stack.push([n.callee, d]);
        for (const x of n.args) stack.push([x, d]);
        break;
      case "Arrow":
        for (const p of n.params) {
          pattern(p.target, d);
          if (p.def) stack.push([p.def, d]);
        }
        if (n.expr) stack.push([n.body as Expr, d]);
        else for (const st of n.body as Stmt[]) stack.push([st, d]);
        break;
      case "Un":
        stack.push([n.arg, d]);
        break;
      case "Bin":
      case "Log":
        stack.push([n.left, d]);
        stack.push([n.right, d]);
        break;
      case "Cond":
        stack.push([n.test, d]);
        stack.push([n.cons, d]);
        stack.push([n.alt, d]);
        break;
      case "Decl":
        for (const dec of n.decls) {
          pattern(dec.target, d);
          if (dec.init) stack.push([dec.init, d]);
        }
        break;
      case "Func":
        stack.push([n.fn, d]);
        break;
      case "Return":
        stack.push([n.arg, d]);
        break;
      case "If":
        stack.push([n.test, d]);
        stack.push([n.cons, d]);
        stack.push([n.alt, d]);
        break;
      case "Block":
        for (const st of n.body) stack.push([st, d]);
        break;
      case "ExprStmt":
        stack.push([n.expr, d]);
        break;
      case "ArrPat":
      case "ObjPat":
        pattern(n, d);
        break;
    }
  }
  return max;
}

/** Throw a syntax error (anchored at `pos`) when an expression's AST is deeper than the interpreter may recurse. */
export function assertExprDepth(expr: Expr, pos: number): void {
  if (exprDepth(expr) > MAX_AST_DEPTH) {
    throw new WidgetSyntaxError(`expression is too deeply nested (limit ${MAX_AST_DEPTH} levels); split it into {@const} steps`, pos);
  }
}

/** Parse one standalone expression (tests, convenience). The whole input must be consumed. */
export function parseExpression(src: string, opts?: ParserOptions): Expr {
  const p = new Parser(src, 0, opts);
  const e = p.parseSeq();
  if (p.tok.type !== "eof") throw new WidgetSyntaxError(`unexpected ${JSON.stringify(p.tok.value)}`, p.tok.start);
  assertExprDepth(e, 0);
  return e;
}
