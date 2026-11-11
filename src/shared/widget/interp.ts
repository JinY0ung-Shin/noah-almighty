/**
 * Widget expression interpreter — a tree-walking sandbox.
 *
 * Ported from mireiffe/mirineereum (src/lib/genui/interp.ts @ 0e469c4) with the
 * owner's permission. Noah changes: result sizes are checked BEFORE the
 * allocation they guard, an allocation budget bounds total memory per budget
 * window, every implicit string/number coercion of a non-primitive goes through
 * the bounded `toStr` (never the native Array#toString), no `Math.random`, no
 * `console`, no JSX values, no `process.env`.
 *
 * - Member access goes through getMember only: constructor/__proto__/prototype
 *   are always undefined, plain objects expose own properties only, and
 *   arrays/strings/numbers expose a method allowlist.
 * - Globals are an allowlist (Math, Number, String, …) plus what the host
 *   binds. There is no window/globalThis.
 * - Steps, call depth, string/array sizes and total allocation are capped.
 */
import type { Expr, Param, Pattern, SpreadEl, Stmt } from "./expr.js";

export const MAX_STEPS = 50_000;
export const MAX_DEPTH = 200;
export const MAX_STR = 100_000;
export const MAX_ARR = 10_000;
/** Elements + characters that one budget window (a block render, an event handler) may allocate. */
export const MAX_ALLOC = 2_000_000;
/** evalNode nesting across closure calls, kept far under what the native stack can hold. */
export const MAX_EVAL_NESTING = 400;
/** Steps one whole render pass may hand out to its blocks (each block window is at most MAX_STEPS). */
export const MAX_RENDER_STEPS = 1_000_000;
/** What one render pass may put on screen: elements (and `{#each}` iterations), and characters. */
export const MAX_OUT_ELEMENTS = 20_000;
export const MAX_OUT_CHARS = 2_000_000;

export class WidgetRuntimeError extends Error {}
export class WidgetBudgetError extends WidgetRuntimeError {
  constructor(message = "evaluation step budget exceeded") {
    super(message);
  }
}

export interface Runtime {
  /** Steps left in the current window (a block render, an event handler). */
  steps: number;
  /** Remaining allocation budget (elements + characters) of the current window. */
  alloc: number;
  depth: number;
  /** evalNode nesting in progress. */
  nest: number;
  /** Setters and host actions act only in "event" (no side effects while rendering). */
  phase: "render" | "event";
  /** Steps the render pass can still hand out to later blocks (see beginRender / resetBudget). */
  renderSteps: number;
  /** Remaining output budget of the render pass (see beginRender / chargeOutput). */
  outEls: number;
  outChars: number;
  /**
   * What the CURRENT block ignored: setter / `copy` calls made while rendering
   * (see `noteIgnoredCall`). Emptied at the start of every block; a renderer
   * reads it after the block to say so, since the call itself has no effect.
   */
  warnings: string[];
}

/** Most ignored-call warnings kept per block. */
export const MAX_RENDER_WARNINGS = 5;

/**
 * Record a setter or `copy` call made in the render phase. The call is still
 * IGNORED (rendering must not change state or re-trigger itself) — this only
 * leaves a trace, because a call inside a function body passes the static check
 * (`{xs.map((x) => setA(x))}`) and would otherwise do nothing without a word.
 * One entry per callee per block, at most MAX_RENDER_WARNINGS.
 */
export function noteIgnoredCall(rt: Runtime, callee: string): void {
  const fix = callee === "copy" ? "call copy only from an event handler (onChange/onClick)" : "call a setter only from an event handler (onChange/onClick)";
  const message = `${callee}(…) was called while rendering and was ignored — ${fix}.`;
  if (rt.warnings.length < MAX_RENDER_WARNINGS && !rt.warnings.includes(message)) rt.warnings.push(message);
}

export function createRuntime(): Runtime {
  return {
    steps: MAX_STEPS,
    alloc: MAX_ALLOC,
    depth: 0,
    nest: 0,
    phase: "render",
    renderSteps: MAX_RENDER_STEPS - MAX_STEPS,
    outEls: MAX_OUT_ELEMENTS,
    outChars: MAX_OUT_CHARS,
    warnings: [],
  };
}

function tick(rt: Runtime) {
  if (--rt.steps < 0) throw new WidgetBudgetError();
}

/**
 * The runtime of the evaluation in progress. Evaluation is synchronous, so the
 * allowlisted methods and globals (which receive no runtime argument) charge
 * their allocations here.
 */
let ACTIVE: Runtime | null = null;

function charge(n: number): void {
  const rt = ACTIVE;
  if (rt && n > 0 && (rt.alloc -= n) < 0) throw new WidgetBudgetError("allocation budget exceeded");
}

/** Charge `n` steps to the evaluation in progress. */
function step(n: number): void {
  const rt = ACTIVE;
  if (rt && (rt.steps -= n) < 0) throw new WidgetBudgetError();
}

/**
 * One step is not one unit of time: a single native call can scan a 100k
 * string or a 10k array. These two convert WORK into steps, so the step budget
 * bounds time and not just the number of calls.
 * - `work(n)`: n elementary operations at native speed (a memcmp, a native copy or scan).
 * - `visit(n)`: n iterations of an interpreter-side loop.
 */
function work(n: number): void {
  if (n > 0) step(Math.ceil(n / 1024));
}
function visit(n: number): void {
  if (n > 0) step(Math.ceil(n / 64));
}

/** Steps for a host helper that walks data on a runtime's behalf (`eachScopes`). */
export function spendSteps(rt: Runtime, n: number): void {
  if ((rt.steps -= n) < 0) throw new WidgetBudgetError();
}

/** Charge what a render pass puts on screen. Throws WidgetBudgetError once the pass is over its output budget. */
export function chargeOutput(rt: Runtime, elements: number, chars: number): void {
  rt.outEls -= elements;
  rt.outChars -= chars;
  if (rt.outEls < 0 || rt.outChars < 0) throw new WidgetBudgetError("too much is rendered (output budget exceeded)");
}

/* ───────────────────────── Environment ───────────────────────── */

type Binding = { v: unknown } | { lazy: () => unknown; st: 0 | 1 | 2; v?: unknown };

export class Env {
  vars = new Map<string, Binding>();
  constructor(public parent: Env | null = null) {}

  set(name: string, v: unknown) {
    this.vars.set(name, { v });
  }
  setLazy(name: string, fn: () => unknown) {
    this.vars.set(name, { lazy: fn, st: 0 });
  }
  hasOwn(name: string) {
    return this.vars.has(name);
  }
  lookup(name: string): { found: boolean; value: unknown } {
    for (let e: Env | null = this.vars.has(name) ? this : this.parent; e; e = e.parent) {
      const b = e.vars.get(name);
      if (b) {
        if ("lazy" in b) {
          if (b.st === 2) return { found: true, value: b.v };
          if (b.st === 1) return { found: true, value: undefined }; // cycle
          b.st = 1;
          try {
            b.v = b.lazy();
          } catch (err) {
            if (err instanceof WidgetBudgetError) {
              b.st = 0; // not cached: the next budget window evaluates it again
              throw err;
            }
            b.v = undefined;
            b.st = 2;
            return { found: true, value: undefined };
          }
          b.st = 2;
          return { found: true, value: b.v };
        }
        return { found: true, value: b.v };
      }
    }
    const g = GLOBALS.get(name);
    if (g !== undefined || GLOBALS.has(name)) return { found: true, value: g };
    return { found: false, value: undefined };
  }
}

/* ───────────────────────── Safe values ───────────────────────── */

const FORBIDDEN = new Set([
  "constructor",
  "__proto__",
  "prototype",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "caller",
  "callee",
  "arguments",
]);

const SAFE_FNS = new WeakSet<object>();
const NAMESPACES = new WeakSet<object>();

export function markSafe<T extends (...a: never[]) => unknown>(fn: T): T {
  SAFE_FNS.add(fn);
  return fn;
}

function makeNamespace<T extends object>(obj: T, callable?: (...a: unknown[]) => unknown): T {
  const target: Record<string, unknown> = callable ? (callable as unknown as Record<string, unknown>) : Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "function") SAFE_FNS.add(v);
    target[k] = v;
  }
  if (callable) SAFE_FNS.add(callable);
  NAMESPACES.add(target);
  return Object.freeze(target) as unknown as T;
}

export function hostNamespace<T extends object>(obj: T): T {
  return makeNamespace(obj);
}

export function isPlainData(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return true;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Size guards. Call them with the size a result WILL have, before building it. */
function fitStr(n: number): void {
  if (n > MAX_STR) throw new WidgetRuntimeError("string too long");
}
function fitArr(n: number): void {
  if (n > MAX_ARR) throw new WidgetRuntimeError("array too large");
}

/** Safe numeric coercion: a non-primitive is stringified by the bounded toStr first. */
function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (v === undefined || typeof v === "function") return NaN;
  return Number(prim(v));
}
function optNum(v: unknown): number | undefined {
  return v === undefined ? undefined : num(v);
}

function isIndexKey(k: string | number): boolean {
  if (typeof k === "number") return Number.isInteger(k) && k >= 0;
  return /^(0|[1-9]\d*)$/.test(k);
}

/** An object property costs several array elements' worth of memory (a key, a slot, dictionary overhead). */
const OBJECT_KEY_COST = 4;

function safeDefine(obj: Record<string, unknown>, key: string, value: unknown) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else obj[key] = value;
}

function copyOwn(target: Record<string, unknown>, src: unknown) {
  if (src == null) return;
  if (typeof src === "string") {
    charge(src.length * OBJECT_KEY_COST);
    visit(src.length);
    for (let i = 0; i < src.length; i++) target[String(i)] = src[i];
    return;
  }
  if (!isPlainData(src)) return;
  const keys = Object.keys(src);
  charge(keys.length * OBJECT_KEY_COST);
  visit(keys.length);
  for (const k of keys) safeDefine(target, k, (src as Record<string, unknown>)[k]);
}

function toIterable(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    // A string spreads into one element per character: size it BEFORE building the array.
    fitArr(v.length);
    charge(v.length);
    visit(v.length);
    return Array.from(v);
  }
  if (v == null) throw new WidgetRuntimeError(`${v} is not iterable`);
  throw new WidgetRuntimeError("value is not iterable");
}

export function callValue(fn: unknown, args: unknown[], rt?: Runtime): unknown {
  if (typeof fn !== "function" || !SAFE_FNS.has(fn)) throw new WidgetRuntimeError("not a function");
  if (rt) tick(rt);
  return (fn as (...a: unknown[]) => unknown)(...args);
}

/**
 * A callback an allowlisted method is about to call, wrapped so that EVERY call
 * costs a step. A closure ticks on its own, but a native callback
 * (`Array.isArray`, a bound method, a host setter) does not — without this,
 * `a.forEach(a.forEach)` style nesting multiplies native work for free.
 */
function assertFn(fn: unknown): (...a: unknown[]) => unknown {
  if (typeof fn !== "function" || !SAFE_FNS.has(fn)) throw new WidgetRuntimeError("callback is not a function");
  const f = fn as (...a: unknown[]) => unknown;
  return (...a: unknown[]) => {
    step(1);
    return f(...a);
  };
}

/** Run an allowlisted method: a step, plus work proportional to the receiver it scans. */
function invokeMethod(impl: MethodImpl, obj: unknown, args: unknown[]): unknown {
  step(1);
  if (typeof obj === "string" || Array.isArray(obj)) work(obj.length);
  return impl(obj as never, args);
}

/** Worst-case work of a native search for `needle` in an array (a string needle may be compared in full against each element). */
function arraySearch(a: unknown[], needle: unknown): void {
  if (typeof needle === "string") work(a.length * (needle.length + 1));
}

/** Worst-case work of a native substring search: the engines' algorithms degrade to O(n·m) on adversarial input. */
function stringSearch(s: string, needle: string): void {
  if (needle.length > 1 && needle.length <= s.length) work(s.length * needle.length);
}

type MethodImpl = (self: never, args: unknown[]) => unknown;

const ARRAY_METHODS: Record<string, MethodImpl> = {
  map: (a: unknown[], [f]) => {
    const fn = assertFn(f);
    fitArr(a.length);
    charge(a.length);
    return a.map(fn);
  },
  filter: (a: unknown[], [f]) => {
    const fn = assertFn(f);
    charge(a.length);
    return a.filter(fn);
  },
  reduce: (a: unknown[], args) => {
    const f = assertFn(args[0]);
    return args.length > 1 ? a.reduce(f, args[1]) : a.reduce(f);
  },
  reduceRight: (a: unknown[], args) => {
    const f = assertFn(args[0]);
    return args.length > 1 ? a.reduceRight(f, args[1]) : a.reduceRight(f);
  },
  find: (a: unknown[], [f]) => a.find(assertFn(f)),
  findIndex: (a: unknown[], [f]) => a.findIndex(assertFn(f)),
  findLast: (a: unknown[], [f]) => {
    const fn = assertFn(f);
    for (let i = a.length - 1; i >= 0; i--) if (fn(a[i], i, a)) return a[i];
    return undefined;
  },
  findLastIndex: (a: unknown[], [f]) => {
    const fn = assertFn(f);
    for (let i = a.length - 1; i >= 0; i--) if (fn(a[i], i, a)) return i;
    return -1;
  },
  some: (a: unknown[], [f]) => a.some(assertFn(f)),
  every: (a: unknown[], [f]) => a.every(assertFn(f)),
  forEach: (a: unknown[], [f]) => {
    a.forEach(assertFn(f));
    return undefined;
  },
  flatMap: (a: unknown[], [f]) => {
    const fn = assertFn(f);
    const out: unknown[] = [];
    for (let i = 0; i < a.length; i++) {
      const r = fn(a[i], i, a);
      const n = Array.isArray(r) ? r.length : 1;
      fitArr(out.length + n);
      charge(n);
      visit(n);
      if (Array.isArray(r)) for (const x of r) out.push(x);
      else out.push(r);
    }
    return out;
  },
  includes: (a: unknown[], [v, from]) => {
    arraySearch(a, v);
    return a.includes(v, optNum(from));
  },
  indexOf: (a: unknown[], [v, from]) => {
    arraySearch(a, v);
    return a.indexOf(v, optNum(from));
  },
  lastIndexOf: (a: unknown[], args) => {
    arraySearch(a, args[0]);
    return args.length > 1 ? a.lastIndexOf(args[0], num(args[1])) : a.lastIndexOf(args[0]);
  },
  slice: (a: unknown[], [s, e]) => {
    charge(a.length);
    return a.slice(optNum(s), optNum(e));
  },
  concat: (a: unknown[], args) => {
    let total = a.length;
    for (const x of args) total += Array.isArray(x) ? x.length : 1;
    fitArr(total);
    charge(total);
    return a.concat(...args.map((x) => (Array.isArray(x) ? x : [x])));
  },
  join: (a: unknown[], [sep]) => {
    const s = sep === undefined ? "," : strArg(sep);
    const parts: string[] = [];
    let total = 0;
    visit(a.length);
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const piece = x === null || x === undefined ? "" : toStr(x);
      total += piece.length + (i > 0 ? s.length : 0);
      fitStr(total);
      parts.push(piece);
    }
    charge(total);
    return parts.join(s);
  },
  flat: (a: unknown[], [d]) => {
    const depth = Math.min(Math.max(Math.floor(num(d ?? 1)) || 0, 0), 10);
    const out: unknown[] = [];
    const walk = (arr: unknown[], left: number): void => {
      charge(arr.length); // visits count too: nested empty arrays produce no output
      visit(arr.length);
      for (const x of arr) {
        if (left > 0 && Array.isArray(x)) walk(x, left - 1);
        else {
          fitArr(out.length + 1);
          out.push(x);
        }
      }
    };
    walk(a, depth);
    return out;
  },
  at: (a: unknown[], [i]) => a.at(num(i) || 0),
  sort: (a: unknown[], [f]) => sortCopy(a, f),
  toSorted: (a: unknown[], [f]) => sortCopy(a, f),
  reverse: (a: unknown[]) => copyArr(a).reverse(),
  toReversed: (a: unknown[]) => copyArr(a).reverse(),
  fill: (a: unknown[], [v, s, e]) => copyArr(a).fill(v, optNum(s), optNum(e)),
  with: (a: unknown[], [i, v]) => {
    const c = copyArr(a);
    let idx = num(i) || 0;
    if (idx < 0) idx += c.length;
    if (idx < 0 || idx >= c.length) throw new WidgetRuntimeError("index out of range");
    c[idx] = v;
    return c;
  },
  keys: (a: unknown[]) => {
    charge(a.length);
    return a.map((_, i) => i);
  },
  values: (a: unknown[]) => copyArr(a),
  entries: (a: unknown[]) => {
    charge(a.length * 3);
    return a.map((v, i) => [i, v]);
  },
  toString: (a: unknown[]) => toStr(a),
};

/** Every "mutating" array method works on a copy: no value is ever changed in place. */
function copyArr(a: unknown[]): unknown[] {
  charge(a.length);
  return [...a];
}

function sortCopy(a: unknown[], f: unknown): unknown[] {
  const c = copyArr(a);
  if (f === undefined) {
    // The default order compares string forms; build them with the bounded toStr.
    // toStr charges what it allocates; the comparisons are paid for up front:
    // n·log n of them, each as long as the keys.
    charge(c.length * 2);
    visit(c.length);
    let chars = 0;
    const keyed = c.map((x) => {
      const k = x === undefined ? undefined : toStr(x);
      if (k !== undefined) chars += k.length;
      return { k, x };
    });
    work(chars * Math.ceil(Math.log2(c.length + 2)));
    keyed.sort((p, q) => (p.k === undefined ? (q.k === undefined ? 0 : 1) : q.k === undefined ? -1 : p.k < q.k ? -1 : p.k > q.k ? 1 : 0));
    return keyed.map((e) => e.x);
  }
  const fn = assertFn(f);
  return c.sort((x, y) => {
    const r = num(fn(x, y));
    return Number.isNaN(r) ? 0 : r;
  });
}

function strArg(v: unknown): string {
  return typeof v === "string" ? v : toStr(v);
}

/** String#replace / replaceAll with a string pattern, sized as it goes. `$&`-style patterns are not expanded. */
function replaceImpl(s: string, pat: unknown, r: unknown, all: boolean): string {
  const p = strArg(pat);
  const fn = typeof r === "function" ? assertFn(r) : null;
  const lit = fn ? "" : strArg(r);
  const parts: string[] = [];
  let total = 0;
  let last = 0;
  let from = 0;
  const add = (piece: string): void => {
    total += piece.length;
    fitStr(total);
    parts.push(piece);
  };
  stringSearch(s, p);
  let rounds = 0;
  for (;;) {
    const at = p === "" ? (from <= s.length ? from : -1) : s.indexOf(p, from);
    if (at < 0) break;
    if ((++rounds & 63) === 0) step(1);
    add(s.slice(last, at));
    add(fn ? toStr(fn(p, at, s)) : lit);
    last = at + p.length;
    from = p === "" ? at + 1 : last;
    if (!all) break;
  }
  add(s.slice(last));
  charge(total);
  return parts.join("");
}

function pad(s: string, n: unknown, f: unknown, start: boolean): string {
  const len = Math.floor(num(n)) || 0;
  fitStr(len);
  charge(Math.max(len, s.length));
  const fill = f === undefined ? " " : strArg(f);
  return start ? s.padStart(len, fill) : s.padEnd(len, fill);
}

const LOCALE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
/** A BCP-47-shaped tag (or a short list of them); anything else is dropped. */
function safeLocale(l: unknown): string | string[] | undefined {
  if (typeof l === "string") return LOCALE_RE.test(l) ? l : undefined;
  if (Array.isArray(l)) {
    const out = l.filter((x): x is string => typeof x === "string" && LOCALE_RE.test(x)).slice(0, 4);
    return out.length ? out : undefined;
  }
  return undefined;
}
/** Intl options: primitive values only (a nested value would be coerced natively). */
function primOptions(o: unknown): Record<string, string | number | boolean> | undefined {
  if (!isPlainData(o) || Array.isArray(o)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const NORMAL_FORMS = new Set(["NFC", "NFD", "NFKC", "NFKD"]);
/** A string result of a native method: within MAX_STR (case mapping and normalization can expand), and charged. */
function sized(s: string): string {
  charge(s.length);
  fitStr(s.length);
  return s;
}

/** Intl objects are costly to construct; a widget formats with the same few (locale, options) over and over. */
const INTL_CACHE_MAX = 32;
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
const COLLATORS = new Map<string, Intl.Collator>();
function cached<T>(cache: Map<string, T>, locale: string | string[] | undefined, options: object | undefined, make: () => T): T {
  const key = JSON.stringify([locale ?? null, options ?? null]);
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size >= INTL_CACHE_MAX) cache.clear();
    hit = make();
    cache.set(key, hit);
  }
  return hit;
}

const STRING_METHODS: Record<string, MethodImpl> = {
  toUpperCase: (s: string) => sized(s.toUpperCase()),
  toLowerCase: (s: string) => sized(s.toLowerCase()),
  toLocaleUpperCase: (s: string) => sized(s.toUpperCase()),
  toLocaleLowerCase: (s: string) => sized(s.toLowerCase()),
  trim: (s: string) => sized(s.trim()),
  trimStart: (s: string) => sized(s.trimStart()),
  trimEnd: (s: string) => sized(s.trimEnd()),
  split: (s: string, [sep, lim]) => {
    if (sep === undefined) return [s];
    const cap = lim === undefined ? MAX_ARR + 1 : Math.min(Math.max(Math.floor(num(lim)) || 0, 0), MAX_ARR + 1);
    const by = strArg(sep);
    stringSearch(s, by);
    const out = s.split(by, cap);
    fitArr(out.length);
    charge(out.length + s.length);
    return out;
  },
  replace: (s: string, [p, r]) => replaceImpl(s, p, r, false),
  replaceAll: (s: string, [p, r]) => replaceImpl(s, p, r, true),
  startsWith: (s: string, [p, i]) => {
    const needle = strArg(p);
    work(needle.length);
    return s.startsWith(needle, optNum(i));
  },
  endsWith: (s: string, [p, i]) => {
    const needle = strArg(p);
    work(needle.length);
    return s.endsWith(needle, optNum(i));
  },
  includes: (s: string, [p, i]) => {
    const needle = strArg(p);
    stringSearch(s, needle);
    return s.includes(needle, optNum(i));
  },
  indexOf: (s: string, [p, i]) => {
    const needle = strArg(p);
    stringSearch(s, needle);
    return s.indexOf(needle, optNum(i));
  },
  lastIndexOf: (s: string, [p]) => {
    const needle = strArg(p);
    stringSearch(s, needle);
    return s.lastIndexOf(needle);
  },
  padStart: (s: string, [n, f]) => pad(s, n, f, true),
  padEnd: (s: string, [n, f]) => pad(s, n, f, false),
  repeat: (s: string, [n]) => {
    const c = Math.max(0, Math.floor(num(n)) || 0);
    fitStr(s.length * c);
    charge(s.length * c);
    return s.repeat(c);
  },
  charAt: (s: string, [i]) => s.charAt(num(i) || 0),
  charCodeAt: (s: string, [i]) => s.charCodeAt(num(i) || 0),
  codePointAt: (s: string, [i]) => s.codePointAt(num(i) || 0),
  substring: (s: string, [a, b]) => sized(s.substring(num(a) || 0, optNum(b))),
  substr: (s: string, [a, b]) => sized(s.substr(num(a) || 0, optNum(b))),
  slice: (s: string, [a, b]) => sized(s.slice(optNum(a), optNum(b))),
  at: (s: string, [i]) => s.at(num(i) || 0),
  concat: (s: string, args) => {
    const parts = args.map(strArg);
    let total = s.length;
    for (const x of parts) total += x.length;
    fitStr(total);
    charge(total);
    return s.concat(...parts);
  },
  localeCompare: (s: string, [o, l, opt]) => {
    const other = strArg(o);
    work((s.length + other.length) * 32); // collation is far slower than a memcmp
    const locale = safeLocale(l);
    const options = primOptions(opt) as Intl.CollatorOptions | undefined;
    if (locale === undefined && options === undefined) return s.localeCompare(other);
    try {
      return cached(COLLATORS, locale, options, () => new Intl.Collator(locale, options)).compare(s, other);
    } catch {
      return s.localeCompare(other);
    }
  },
  normalize: (s: string, [f]) => {
    const form = f === undefined ? "NFC" : strArg(f);
    if (!NORMAL_FORMS.has(form)) throw new WidgetRuntimeError("normalize: the form must be NFC, NFD, NFKC or NFKD");
    work(s.length * 8);
    return sized(s.normalize(form));
  },
  toString: (s: string) => s,
  valueOf: (s: string) => s,
};

const NUMBER_METHODS: Record<string, MethodImpl> = {
  toFixed: (n: number, [d]) => n.toFixed(Math.min(Math.max(num(d) || 0, 0), 20)),
  toPrecision: (n: number, [d]) => (d === undefined ? n.toPrecision() : n.toPrecision(Math.min(Math.max(num(d) || 1, 1), 100))),
  toLocaleString: (n: number, args: unknown[]) => {
    const [l, o] = args;
    const locale = safeLocale(l);
    const options = primOptions(o) as Intl.NumberFormatOptions | undefined;
    step(1);
    try {
      return cached(NUMBER_FORMATS, locale, options, () => new Intl.NumberFormat(locale, options)).format(n);
    } catch {
      return String(n);
    }
  },
  toString: (n: number, args: unknown[]) => {
    const r = args[0];
    return n.toString(r === undefined ? 10 : Math.min(Math.max(Math.floor(num(r)) || 10, 2), 36));
  },
  valueOf: (n: number) => n,
};

const BOOL_METHODS: Record<string, MethodImpl> = {
  toString: (b: boolean) => String(b),
  valueOf: (b: boolean) => b,
};

function methodTable(obj: unknown): Record<string, MethodImpl> | null {
  if (Array.isArray(obj)) return ARRAY_METHODS;
  switch (typeof obj) {
    case "string":
      return STRING_METHODS;
    case "number":
      return NUMBER_METHODS;
    case "boolean":
      return BOOL_METHODS;
  }
  return null;
}

export function getMember(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) {
    throw new WidgetRuntimeError(`Cannot read properties of ${obj} (reading '${typeof key === "string" || typeof key === "number" ? key : "…"}')`);
  }
  const k = typeof key === "number" ? key : toStr(key);
  if (typeof k === "string" && FORBIDDEN.has(k)) return undefined;

  if (typeof obj === "string") {
    if (k === "length") return obj.length;
    if (isIndexKey(k)) return obj[Number(k)];
  } else if (Array.isArray(obj)) {
    if (k === "length") return obj.length;
    if (isIndexKey(k)) return obj[Number(k)];
  }
  const table = methodTable(obj);
  if (table) {
    const impl = typeof k === "string" ? table[k] : undefined;
    if (impl && Object.prototype.hasOwnProperty.call(table, k)) {
      // A method taken as a value (`a.forEach`, `s.localeCompare`) pays the same way when it is finally called.
      return markSafe((...args: unknown[]) => invokeMethod(impl, obj, args));
    }
    return undefined;
  }
  if (typeof obj === "function" || typeof obj === "object") {
    if (NAMESPACES.has(obj as object) || isPlainData(obj)) {
      return Object.prototype.hasOwnProperty.call(obj, k) ? (obj as Record<string | number, unknown>)[k] : undefined;
    }
    return undefined;
  }
  return undefined;
}

function callMethod(obj: unknown, key: unknown, args: unknown[], rt: Runtime): unknown {
  if (obj === null || obj === undefined) {
    throw new WidgetRuntimeError(`Cannot read properties of ${obj} (reading '${typeof key === "string" || typeof key === "number" ? key : "…"}')`);
  }
  const table = methodTable(obj);
  const k = typeof key === "string" ? key : toStr(key);
  if (table && Object.prototype.hasOwnProperty.call(table, k) && !FORBIDDEN.has(k)) {
    return invokeMethod(table[k], obj, args);
  }
  const fn = getMember(obj, key);
  if (typeof fn !== "function") throw new WidgetRuntimeError(`${k} is not a function`);
  return callValue(fn, args, rt);
}

/* ───────────────────────── Globals ───────────────────────── */

const mathObj: Record<string, unknown> = {};
for (const k of Object.getOwnPropertyNames(Math)) {
  if (k === "random") continue; // the same source always renders the same screen
  const v = (Math as unknown as Record<string, unknown>)[k];
  if (typeof v === "number") mathObj[k] = v;
  else if (typeof v === "function") {
    const fn = v as (...a: number[]) => number;
    mathObj[k] = (...a: unknown[]) => fn(...a.map(num));
  }
}

function safeAssign(...objs: unknown[]) {
  const out: Record<string, unknown> = {};
  for (const o of objs) copyOwn(out, o);
  return out;
}

function arrayFrom(src: unknown, fn?: unknown) {
  let base: unknown[];
  if (Array.isArray(src)) {
    charge(src.length);
    base = [...src];
  } else if (typeof src === "string") {
    fitArr(src.length);
    charge(src.length);
    base = Array.from(src);
  } else if (isPlainData(src) && typeof (src as { length?: unknown }).length === "number") {
    const n = Math.max(0, Math.floor((src as { length: number }).length) || 0);
    fitArr(n);
    charge(n);
    visit(n);
    base = [];
    for (let i = 0; i < n; i++) base.push((src as Record<string, unknown>)[String(i)]);
  } else base = [];
  fitArr(base.length);
  if (fn !== undefined) {
    const f = assertFn(fn);
    charge(base.length);
    return base.map((v, i) => f(v, i));
  }
  return base;
}

/** Lower-bound size of the JSON text of `v`; throws before anything is built when it cannot fit. */
function jsonCost(v: unknown, acc: { left: number }, pad: number, depth: number): void {
  if (depth > MAX_DATA_DEPTH) throw new WidgetRuntimeError("value is nested too deeply");
  if (typeof v === "string") acc.left -= v.length + 2;
  else if (v === null || typeof v !== "object") acc.left -= 4;
  else if (Array.isArray(v)) {
    acc.left -= 2;
    for (const x of v) {
      acc.left -= 1 + pad * (depth + 1);
      if (acc.left < 0) break;
      jsonCost(x, acc, pad, depth + 1);
    }
  } else {
    acc.left -= 2;
    for (const k of Object.keys(v)) {
      acc.left -= k.length + 4 + pad * (depth + 1);
      if (acc.left < 0) break;
      jsonCost((v as Record<string, unknown>)[k], acc, pad, depth + 1);
    }
  }
  if (acc.left < 0) throw new WidgetRuntimeError("string too long");
}

export function stringifyJSON(v: unknown, replacer?: unknown, space?: unknown): string | undefined {
  // A function replacer is not supported (its output cannot be sized up front); a key list is.
  const rep = Array.isArray(replacer) ? replacer.filter((k): k is string => typeof k === "string").slice(0, 200) : undefined;
  const sp = typeof space === "number" ? Math.min(Math.max(Math.floor(space), 0), 10) : typeof space === "string" ? space.slice(0, 10) : undefined;
  const padLen = typeof sp === "number" ? sp : typeof sp === "string" ? sp.length : 0;
  // Stringify a sanitized COPY: plain data only, so no `toJSON` (or any other
  // function) is left for the native serializer to call, and the copy is
  // bounded in nodes and characters before anything is serialized.
  const acc = { nodes: JSON_MAX_NODES, chars: MAX_STR };
  const clean = sanitizeWalk(v, acc, 0);
  visit(JSON_MAX_NODES - acc.nodes);
  jsonCost(clean, { left: MAX_STR }, padLen, 0);
  const out = JSON.stringify(clean, rep, sp);
  if (out === undefined) return undefined;
  fitStr(out.length);
  charge(out.length);
  return out;
}

function parseJSON(s: unknown): unknown {
  const text = strArg(s);
  fitStr(text.length);
  charge(text.length);
  work(text.length * 8);
  const out: unknown = JSON.parse(text);
  // A parsed array can be longer than a literal could ever be; refuse it here.
  let nodes = 0;
  const check = (v: unknown, depth: number): void => {
    nodes++;
    if (v === null || typeof v !== "object") return;
    if (depth > MAX_DATA_DEPTH) throw new WidgetRuntimeError("value is nested too deeply");
    if (Array.isArray(v)) {
      fitArr(v.length);
      for (const x of v) check(x, depth + 1);
    } else for (const k of Object.keys(v)) check((v as Record<string, unknown>)[k], depth + 1);
  };
  check(out, 0);
  visit(nodes);
  return out;
}

const GLOBALS = new Map<string, unknown>([
  ["undefined", undefined],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["Math", makeNamespace(mathObj)],
  [
    "Number",
    makeNamespace(
      {
        isFinite: Number.isFinite,
        isInteger: Number.isInteger,
        isNaN: Number.isNaN,
        isSafeInteger: Number.isSafeInteger,
        parseFloat: (s: unknown) => parseFloat(strArg(s)),
        parseInt: (s: unknown, r?: unknown) => parseInt(strArg(s), optNum(r)),
        MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
        MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
        EPSILON: Number.EPSILON,
        MAX_VALUE: Number.MAX_VALUE,
        MIN_VALUE: Number.MIN_VALUE,
        POSITIVE_INFINITY: Infinity,
        NEGATIVE_INFINITY: -Infinity,
        NaN: NaN,
      },
      (...a: unknown[]) => (a.length === 0 ? 0 : num(a[0])),
    ),
  ],
  ["String", makeNamespace({ fromCharCode: (...c: unknown[]) => String.fromCharCode(...c.map(num)) }, (v?: unknown) => (v === undefined ? "" : toStr(v)))],
  ["Boolean", makeNamespace({}, (v?: unknown) => Boolean(v))],
  ["parseInt", markSafe((s: unknown, r?: unknown) => parseInt(strArg(s), optNum(r)))],
  ["parseFloat", markSafe((s: unknown) => parseFloat(strArg(s)))],
  ["isNaN", markSafe((v: unknown) => Number.isNaN(num(v)))],
  ["isFinite", markSafe((v: unknown) => Number.isFinite(num(v)))],
  [
    "Array",
    makeNamespace({
      isArray: Array.isArray,
      from: arrayFrom,
      of: (...a: unknown[]) => {
        charge(a.length);
        return a;
      },
    }),
  ],
  [
    "Object",
    makeNamespace({
      keys: (o: unknown) => {
        if (!isPlainData(o)) return [];
        const out = Object.keys(o);
        fitArr(out.length);
        charge(out.length);
        return out;
      },
      values: (o: unknown) => {
        if (!isPlainData(o)) return [];
        const out = Object.values(o);
        fitArr(out.length);
        charge(out.length);
        return out;
      },
      entries: (o: unknown) => {
        if (!isPlainData(o)) return [];
        const out = Object.entries(o);
        fitArr(out.length);
        charge(out.length * 3);
        return out;
      },
      fromEntries: (e: unknown) => {
        const out: Record<string, unknown> = {};
        const pairs = toIterable(e);
        charge(pairs.length);
        for (const pair of pairs) {
          if (Array.isArray(pair)) safeDefine(out, toStr(pair[0]), pair[1]);
        }
        return out;
      },
      assign: safeAssign,
    }),
  ],
  ["JSON", makeNamespace({ stringify: stringifyJSON, parse: parseJSON })],
]);

/** Names every expression can read without declaring them (for the static checker and the manual). */
export const GLOBAL_NAMES: readonly string[] = Object.freeze([...GLOBALS.keys()]);

/* ───────────────────────── Evaluation ───────────────────────── */

const SHORT = Symbol("short-circuit");

/**
 * Evaluate an expression — the HOST entry point. It marks `rt` as the
 * evaluation in progress for its duration only, so the size and work
 * accounting of the allowlisted methods never leaks onto host code that runs
 * afterwards (a renderer calling `toStr`, `normalizeProps`, …).
 */
export function evaluate(node: Expr, env: Env, rt: Runtime): unknown {
  const prev = ACTIVE;
  ACTIVE = rt;
  try {
    return evalValue(node, env, rt);
  } finally {
    ACTIVE = prev;
  }
}

function evalValue(node: Expr, env: Env, rt: Runtime): unknown {
  const v = evalNode(node, env, rt);
  return v === SHORT ? undefined : v;
}

function evalNode(node: Expr, env: Env, rt: Runtime): unknown {
  tick(rt);
  // The interpreter recurses once per AST level and once more per closure
  // call; cap the total so a deep (or deeply recursive) computation ends with
  // a widget error instead of overflowing the native stack.
  if (++rt.nest > MAX_EVAL_NESTING) {
    rt.nest--;
    throw new WidgetRuntimeError("the computation is nested too deeply");
  }
  try {
    return evalInner(node, env, rt);
  } finally {
    rt.nest--;
  }
}

function evalInner(node: Expr, env: Env, rt: Runtime): unknown {
  switch (node.type) {
    case "Lit":
      return node.value;
    case "Tmpl": {
      let s = node.quasis[0];
      for (let i = 0; i < node.exprs.length; i++) {
        const piece = toStr(evalValue(node.exprs[i], env, rt));
        const next = node.quasis[i + 1];
        fitStr(s.length + piece.length + next.length);
        s += piece + next;
      }
      charge(s.length);
      return s;
    }
    case "Id": {
      const r = env.lookup(node.name);
      if (!r.found) throw new WidgetRuntimeError(`${node.name} is not defined`);
      return r.value;
    }
    case "Arr": {
      const out: unknown[] = [];
      for (const it of node.items) {
        if (it === null) out.push(undefined);
        else if (it.type === "Spread") {
          const more = toIterable(evalValue(it.arg, env, rt));
          fitArr(out.length + more.length);
          visit(more.length);
          for (const x of more) out.push(x);
        } else out.push(evalValue(it, env, rt));
        fitArr(out.length);
      }
      charge(out.length);
      return out;
    }
    case "Obj": {
      const out: Record<string, unknown> = {};
      for (const p of node.props) {
        if (p.kind === "spread") copyOwn(out, evalValue(p.arg, env, rt));
        else if (p.kind === "prop") safeDefine(out, p.key, evalValue(p.value, env, rt));
        else safeDefine(out, toStr(evalValue(p.key, env, rt)), evalValue(p.value, env, rt));
      }
      charge(node.props.length);
      return out;
    }
    case "Mem": {
      const obj = evalNode(node.obj, env, rt);
      if (obj === SHORT) return SHORT;
      if (node.optional && (obj === null || obj === undefined)) return SHORT;
      const key = node.computed ? evalValue(node.prop as Expr, env, rt) : (node.prop as string);
      return getMember(obj, key);
    }
    case "Call": {
      const args = (): unknown[] => evalArgs(node.args, env, rt);
      if (node.callee.type === "Mem") {
        const m = node.callee;
        const obj = evalNode(m.obj, env, rt);
        if (obj === SHORT) return SHORT;
        if (m.optional && (obj === null || obj === undefined)) return SHORT;
        const key = m.computed ? evalValue(m.prop as Expr, env, rt) : (m.prop as string);
        if (node.optional) {
          const fn = getMember(obj, key);
          if (fn === null || fn === undefined) return SHORT;
        }
        return callMethod(obj, key, args(), rt);
      }
      const fn = evalNode(node.callee, env, rt);
      if (fn === SHORT) return SHORT;
      if (node.optional && (fn === null || fn === undefined)) return SHORT;
      if (typeof fn !== "function") {
        const name = node.callee.type === "Id" ? node.callee.name : "expression";
        throw new WidgetRuntimeError(`${name} is not a function`);
      }
      return callValue(fn, args(), rt);
    }
    case "Arrow":
      return makeClosure(node, env, rt);
    case "Un": {
      if (node.op === "typeof") {
        if (node.arg.type === "Id") {
          const r = env.lookup(node.arg.name);
          if (!r.found) return "undefined";
          return typeof r.value;
        }
        return typeof evalValue(node.arg, env, rt);
      }
      const v = evalValue(node.arg, env, rt);
      switch (node.op) {
        case "!":
          return !v;
        case "-":
          return -num(v);
        case "+":
          return num(v);
        case "~":
          return ~num(v);
        case "void":
          return undefined;
      }
      throw new WidgetRuntimeError(`unknown operator ${node.op}`);
    }
    case "Log": {
      const l = evalValue(node.left, env, rt);
      if (node.op === "||") return l ? l : evalValue(node.right, env, rt);
      if (node.op === "&&") return l ? evalValue(node.right, env, rt) : l;
      return l === null || l === undefined ? evalValue(node.right, env, rt) : l;
    }
    case "Bin":
      return binary(node.op, evalValue(node.left, env, rt), evalValue(node.right, env, rt));
    case "Cond":
      return evalValue(node.test, env, rt) ? evalValue(node.cons, env, rt) : evalValue(node.alt, env, rt);
    case "Seq": {
      let v: unknown;
      for (const e of node.exprs) v = evalValue(e, env, rt);
      return v;
    }
  }
}

function evalArgs(args: (Expr | SpreadEl)[], env: Env, rt: Runtime): unknown[] {
  const out: unknown[] = [];
  for (const a of args) {
    if (a.type === "Spread") {
      const more = toIterable(evalValue(a.arg, env, rt));
      if (out.length + more.length > MAX_ARR) throw new WidgetRuntimeError("too many arguments");
      visit(more.length);
      for (const x of more) out.push(x);
    } else out.push(evalValue(a, env, rt));
    if (out.length > MAX_ARR) throw new WidgetRuntimeError("too many arguments");
  }
  return out;
}

/** Deepest data nesting any bounded walk follows. */
const MAX_DATA_DEPTH = 100;

/**
 * String form of a value, bounded: an array is joined piece by piece against
 * MAX_STR, so a value that shares sub-arrays (a DAG) cannot expand into a huge
 * string the way the native Array#toString would.
 */
export function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === "function") return "[function]";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    const out = joinArr(v, { left: MAX_STR }, 0);
    charge(out.length);
    return out;
  }
  return isPlainData(v) ? "[object Object]" : "";
}

function joinArr(arr: unknown[], acc: { left: number }, depth: number): string {
  if (depth > MAX_DATA_DEPTH) throw new WidgetRuntimeError("value is nested too deeply");
  visit(arr.length); // every coercion of an array walks it: that walk is paid for in steps
  const parts: string[] = [];
  for (const x of arr) {
    let piece: string;
    if (Array.isArray(x)) {
      piece = joinArr(x, acc, depth + 1); // its characters were counted inside
      acc.left -= 1;
    } else {
      piece = x === null || x === undefined ? "" : toStr(x);
      acc.left -= piece.length + 1;
    }
    if (acc.left < 0) throw new WidgetRuntimeError("string too long");
    parts.push(piece);
  }
  return parts.join(",");
}

/** Nodes a value handed to JSON.stringify may have. */
const JSON_MAX_NODES = 40_000;

function sanitizeWalk(x: unknown, acc: { nodes: number; chars: number }, depth: number): unknown {
  if (--acc.nodes < 0) throw new WidgetRuntimeError("value is too large");
  if (x === null || x === undefined) return x;
  if (typeof x === "string") {
    fitStr(x.length);
    // Counted on EVERY visit: a string shared by many cells is still that many characters once it is serialized or drawn.
    if ((acc.chars -= x.length) < 0) throw new WidgetRuntimeError("value is too large");
    return x;
  }
  if (typeof x === "number" || typeof x === "boolean") return x;
  if (typeof x !== "object") return undefined;
  if (depth > MAX_DATA_DEPTH) throw new WidgetRuntimeError("value is nested too deeply");
  if (Array.isArray(x)) {
    const out: unknown[] = [];
    for (const y of x) out.push(sanitizeWalk(y, acc, depth + 1));
    return out;
  }
  if (!isPlainData(x)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x)) {
    if (k === "__proto__") continue; // never carried over: a consumer that merges objects naively would be polluted by it
    if ((acc.chars -= k.length) < 0) throw new WidgetRuntimeError("value is too large");
    out[k] = sanitizeWalk((x as Record<string, unknown>)[k], acc, depth + 1);
  }
  return out;
}

/**
 * A deep copy holding only JSON-like data (strings, numbers, booleans, null,
 * arrays, plain objects); functions become undefined and an own `__proto__`
 * key is dropped. Bounded in nodes, in total characters (string values and
 * keys, counted on every visit — so shared sub-structures and shared strings
 * cannot expand without limit) and in depth. Use it for anything that leaves
 * the interpreter: stored state, submitted values, props handed to a renderer.
 */
export function sanitizeData(v: unknown, maxNodes = 20_000, maxChars = 1_000_000): unknown {
  const acc = { nodes: maxNodes, chars: maxChars };
  try {
    return sanitizeWalk(v, acc, 0);
  } finally {
    // Inside an evaluation (a setter called from a handler) the copy is work like any other.
    visit(maxNodes - acc.nodes);
  }
}

/**
 * Approximate JSON size of a value in characters, WITHOUT serializing it.
 * Counting stops as soon as the total passes `limit` (the returned number is
 * then just "more than limit"), so the cost is bounded by `limit`, not by the
 * value. Check this before a `JSON.stringify` whose result you would discard
 * for being too long.
 */
export function dataSize(value: unknown, limit: number): number {
  let total = 0;
  const walk = (x: unknown, depth: number): void => {
    if (total > limit) return;
    if (typeof x === "string") total += x.length + 2;
    else if (typeof x === "number") total += String(x).length;
    else if (x === null || typeof x !== "object") total += 4;
    else if (depth > MAX_DATA_DEPTH) total = limit + 1;
    else if (Array.isArray(x)) {
      total += 2;
      for (const y of x) {
        total += 1;
        if (total > limit) return;
        walk(y, depth + 1);
      }
    } else if (isPlainData(x)) {
      total += 2;
      for (const k of Object.keys(x)) {
        total += k.length + 4;
        if (total > limit) return;
        walk((x as Record<string, unknown>)[k], depth + 1);
      }
    } else total += 2;
  };
  walk(value, 0);
  return total;
}

function prim(v: unknown): unknown {
  if (v !== null && typeof v === "object") return toStr(v);
  return v;
}

function binary(op: string, a: unknown, b: unknown): unknown {
  // Comparing two long strings is a scan, not a constant-time step.
  if (typeof a === "string" && typeof b === "string" && a.length > 64 && b.length > 64 && op !== "+") work(Math.min(a.length, b.length));
  switch (op) {
    case "+": {
      const pa = prim(a);
      const pb = prim(b);
      if (typeof pa === "string" || typeof pb === "string") {
        const sa = toStr(pa);
        const sb = toStr(pb);
        fitStr(sa.length + sb.length);
        charge(sa.length + sb.length);
        return sa + sb;
      }
      return (pa as number) + (pb as number);
    }
    case "-":
      return (prim(a) as number) - (prim(b) as number);
    case "*":
      return (prim(a) as number) * (prim(b) as number);
    case "/":
      return (prim(a) as number) / (prim(b) as number);
    case "%":
      return (prim(a) as number) % (prim(b) as number);
    case "**":
      return (prim(a) as number) ** (prim(b) as number);
    case "===":
      return a === b;
    case "!==":
      return a !== b;
    case "==":
      return looseEq(a, b);
    case "!=":
      return !looseEq(a, b);
    case "<":
      return (prim(a) as number) < (prim(b) as number);
    case ">":
      return (prim(a) as number) > (prim(b) as number);
    case "<=":
      return (prim(a) as number) <= (prim(b) as number);
    case ">=":
      return (prim(a) as number) >= (prim(b) as number);
    case "&":
      return (prim(a) as number) & (prim(b) as number);
    case "|":
      return (prim(a) as number) | (prim(b) as number);
    case "^":
      return (prim(a) as number) ^ (prim(b) as number);
    case "<<":
      return (prim(a) as number) << (prim(b) as number);
    case ">>":
      return (prim(a) as number) >> (prim(b) as number);
    case ">>>":
      return (prim(a) as number) >>> (prim(b) as number);
    case "in":
      if (b === null || typeof b !== "object") throw new WidgetRuntimeError("'in' needs an object");
      if (!isPlainData(b)) return false;
      return Object.prototype.hasOwnProperty.call(b, toStr(a)) || (Array.isArray(b) && a === "length");
  }
  throw new WidgetRuntimeError(`unknown operator ${op}`);
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const oa = typeof a === "object";
  const ob = typeof b === "object";
  if (oa && ob) return false;
  return prim(a) == prim(b);
}

/* ───────────────────────── Functions & statements ───────────────────────── */

function makeClosure(node: Expr & { type: "Arrow" }, env: Env, rt: Runtime) {
  const fn = (...args: unknown[]) => {
    if (rt.depth >= MAX_DEPTH) throw new WidgetRuntimeError("maximum call depth exceeded");
    // A closure may be called straight from the host (an event handler): it is an entry point too.
    const prev = ACTIVE;
    ACTIVE = rt;
    rt.depth++;
    try {
      tick(rt);
      const scope = new Env(env);
      bindParams(node.params, args, scope, rt);
      if (node.expr) return evalValue(node.body as Expr, scope, rt);
      const r = execStmts(node.body as Stmt[], scope, rt);
      return r ? r.value : undefined;
    } finally {
      rt.depth--;
      ACTIVE = prev;
    }
  };
  SAFE_FNS.add(fn);
  return fn;
}

function bindParams(params: Param[], args: unknown[], env: Env, rt: Runtime) {
  params.forEach((p, i) => {
    if (p.rest) {
      const rest = args.slice(i);
      charge(rest.length);
      bindPat(p.target, rest, env, rt);
      return;
    }
    let v = args[i];
    if (v === undefined && p.def) v = evalValue(p.def, env, rt);
    bindPat(p.target, v, env, rt);
  });
}

/** Bind a destructuring pattern into `env` — the host entry point (see `evaluate`). */
export function bindPattern(pat: Pattern, value: unknown, env: Env, rt: Runtime): void {
  const prev = ACTIVE;
  ACTIVE = rt;
  try {
    bindPat(pat, value, env, rt);
  } finally {
    ACTIVE = prev;
  }
}

function bindPat(pat: Pattern, value: unknown, env: Env, rt: Runtime) {
  tick(rt);
  switch (pat.type) {
    case "Id":
      env.set(pat.name, value);
      return;
    case "ArrPat": {
      // Without a rest element only the first few items are read: take just
      // those from a string instead of exploding all of it into an array.
      const arr = typeof value === "string" && !pat.rest ? firstChars(value, pat.items.length) : toIterable(value);
      pat.items.forEach((it, i) => {
        if (!it) return;
        let v = arr[i];
        if (v === undefined && it.def) v = evalValue(it.def, env, rt);
        bindPat(it.target, v, env, rt);
      });
      if (pat.rest) {
        const rest = arr.slice(pat.items.length);
        charge(rest.length);
        work(rest.length);
        bindPat(pat.rest, rest, env, rt);
      }
      return;
    }
    case "ObjPat": {
      if (value === null || value === undefined) throw new WidgetRuntimeError(`Cannot destructure ${value}`);
      const used = new Set<string>();
      for (const p of pat.props) {
        const key = p.computed ? toStr(evalValue(p.key as Expr, env, rt)) : (p.key as string);
        used.add(key);
        let v = getMember(value, key);
        if (v === undefined && p.value.def) v = evalValue(p.value.def, env, rt);
        bindPat(p.value.target, v, env, rt);
      }
      if (pat.rest) {
        const rest: Record<string, unknown> = {};
        if (isPlainData(value)) {
          const keys = Object.keys(value);
          charge(keys.length * OBJECT_KEY_COST);
          visit(keys.length);
          for (const k of keys) if (!used.has(k)) safeDefine(rest, k, (value as Record<string, unknown>)[k]);
        }
        env.set(pat.rest, rest);
      }
      return;
    }
  }
}

/** The first `n` characters (code points) of a string, as an array. */
function firstChars(s: string, n: number): string[] {
  const out: string[] = [];
  if (n <= 0) return out;
  for (const ch of s) {
    out.push(ch);
    if (out.length >= n) break;
  }
  return out;
}

export function patternNames(pat: Pattern, out: string[] = []): string[] {
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

function execStmts(stmts: Stmt[], env: Env, rt: Runtime): { value: unknown } | null {
  for (const s of stmts) if (s.type === "Func") env.set(s.name, makeClosure(s.fn, env, rt));
  for (const s of stmts) {
    const r = execStmt(s, env, rt);
    if (r) return r;
  }
  return null;
}

function execStmt(s: Stmt, env: Env, rt: Runtime): { value: unknown } | null {
  tick(rt);
  switch (s.type) {
    case "Empty":
    case "Func":
      return null;
    case "Decl":
      for (const d of s.decls) bindPat(d.target, d.init ? evalValue(d.init, env, rt) : undefined, env, rt);
      return null;
    case "Return":
      return { value: s.arg ? evalValue(s.arg, env, rt) : undefined };
    case "If":
      if (evalValue(s.test, env, rt)) return execStmt(s.cons, env, rt);
      return s.alt ? execStmt(s.alt, env, rt) : null;
    case "Block":
      return execStmts(s.body, new Env(env), rt);
    case "ExprStmt":
      evalValue(s.expr, env, rt);
      return null;
  }
}

/**
 * Start of a render PASS (once per render, before its first block): refill the
 * pass-wide budgets — the steps the pass can hand out to its blocks and what it
 * may put on screen — and open the first block window. `createRootEnv` calls
 * this; call it yourself when one root environment is walked again.
 */
export function beginRender(rt: Runtime): void {
  rt.renderSteps = MAX_RENDER_STEPS;
  rt.outEls = MAX_OUT_ELEMENTS;
  rt.outChars = MAX_OUT_CHARS;
  rt.steps = 0;
  resetBudget(rt);
}

/**
 * Start of a BLOCK of a render pass: a fresh step window (at most MAX_STEPS,
 * drawn from what the pass has left — the previous window's unused steps go
 * back first), a fresh allocation budget, an empty `warnings` list, and back to
 * the render phase. Once the pass is out of steps, every further block fails at
 * its first step.
 *
 * Never call it (or beginRender) while `invokeHandler` is running on the SAME
 * runtime: the handler would drop back to "render" and its remaining
 * setter/`copy` calls would be ignored. A renderer defers re-evaluation until
 * the handler returns.
 */
export function resetBudget(rt: Runtime) {
  rt.renderSteps += Math.max(rt.steps, 0);
  const grant = Math.min(MAX_STEPS, Math.max(rt.renderSteps, 0));
  rt.renderSteps -= grant;
  rt.steps = grant;
  rt.alloc = MAX_ALLOC;
  rt.depth = 0;
  rt.nest = 0;
  rt.phase = "render";
  rt.warnings = [];
}

/**
 * Run a host-side evaluation step, turning a native stack overflow into a
 * widget error. The nesting caps make an overflow unreachable in practice; this
 * is the net under them, so no widget can surface a RangeError to its renderer.
 */
export function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof RangeError) throw new WidgetRuntimeError("the computation is nested too deeply");
    throw err;
  }
}

/** A handler that does nothing: what a required handler prop falls back to when its expression yields no function. */
export const NOOP_HANDLER: () => undefined = markSafe(() => undefined);

export type HandlerResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Call a closure from outside a render (an event): its own step and
 * allocation budgets and phase "event", all restored afterwards — an event
 * never spends the render pass's budgets. Never throws.
 */
export function invokeHandler(rt: Runtime, fn: unknown, args: unknown[]): HandlerResult {
  if (typeof fn !== "function" || !SAFE_FNS.has(fn)) return { ok: false, error: "the handler is not a function" };
  const prev = { phase: rt.phase, steps: rt.steps, alloc: rt.alloc, depth: rt.depth, nest: rt.nest };
  rt.phase = "event";
  rt.steps = MAX_STEPS;
  rt.alloc = MAX_ALLOC;
  rt.depth = 0;
  rt.nest = 0;
  const prevActive = ACTIVE;
  ACTIVE = rt;
  try {
    return { ok: true, value: callValue(fn, args) };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, error: "the computation is nested too deeply" };
    return { ok: false, error: err instanceof Error ? err.message : "the handler failed" };
  } finally {
    rt.phase = prev.phase;
    rt.steps = prev.steps;
    rt.alloc = prev.alloc;
    rt.depth = prev.depth;
    rt.nest = prev.nest;
    ACTIVE = prevActive;
  }
}
