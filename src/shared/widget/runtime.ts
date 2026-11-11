/**
 * Widget runtime glue between a parsed document and a renderer: the root
 * environment (state, setters, `copy`, top-level consts), per-node evaluation
 * helpers and the shape of what a `<submit>` may send. Framework-free, so the
 * whole evaluation model is testable without a DOM.
 *
 * A renderer walks `doc.nodes` with these helpers and never calls the
 * interpreter on its own:
 *
 *   const rt = createRuntime();
 *   const values = restoreState(doc, stored) // or initialState(doc).values
 *   const root = createRootEnv(doc, values, rt, host); // starts a render pass (beginRender)
 *   // per top-level block: resetBudget(rt), then render it
 *   // (walking the SAME root again later? call beginRender(rt) first)
 *   // el     → resolveProps(node, env, rt), children in childScope(node.children, env, rt)
 *   // each   → eachScopes(node, env, rt)
 *   // if     → pickBranch(node, env, rt)
 *   // expr   → interpolate(node, env, rt)
 *   // events → invokeHandler(rt, props.onChange, [value])
 */
import {
  Env,
  WidgetBudgetError,
  WidgetRuntimeError,
  beginRender,
  bindPattern,
  callValue,
  chargeOutput,
  createRuntime,
  dataSize,
  evaluate,
  guarded,
  isPlainData,
  markSafe,
  noteIgnoredCall,
  patternNames,
  resetBudget,
  sanitizeData,
  spendSteps,
  toStr,
  type Runtime,
} from "./interp.js";
import { normalizeProps } from "./spec.js";
import type { ConstNode, EachNode, ElNode, ExprNode, IfNode, TNode, WidgetDoc } from "./template.js";
import { displayText } from "./text.js";

/** What the renderer provides. Both callbacks run only inside an event handler. */
export interface WidgetHost {
  /** The LATEST value of a state variable, so chained setter calls in one handler compose. */
  get(name: string): unknown;
  /** Store a new value (already a sanitized deep copy) and re-render. */
  set(name: string, value: unknown): void;
  /** Copy text to the clipboard. */
  copy(text: string): void;
}

export const MAX_EACH_ITEMS = 1000;
/**
 * What a state change / a clipboard write costs in steps, on top of the work
 * of evaluating it: each one makes the host do real work (store and re-render;
 * a clipboard call), so one handler gets at most ~1,000 state changes and ~10
 * copies out of its 50,000 steps.
 */
export const SETTER_STEPS = 50;
export const COPY_STEPS = 5000;
export const MAX_COPY_CHARS = 20_000;
export const MAX_SUBMIT_KEYS = 20;
export const MAX_SUBMIT_CHARS = 8000;
const MAX_STATE_NODES = 20_000;

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "evaluation failed";
}

/**
 * Evaluate every `{@state}` initializer in declaration order. An initializer
 * sees the globals and the states declared BEFORE it (not consts, not setters).
 * A failing one yields `undefined` and is reported in `errors`.
 */
export function initialState(doc: WidgetDoc): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const errors: string[] = [];
  const rt = createRuntime();
  const env = new Env();
  for (const st of doc.states) {
    let v: unknown;
    if (st.init) {
      resetBudget(rt);
      try {
        v = sanitizeData(guarded(() => evaluate(st.init!, env, rt)), MAX_STATE_NODES);
      } catch (err) {
        errors.push(`state ${st.name}: ${message(err)}`);
        v = undefined;
      }
    }
    values[st.name] = v;
    env.set(st.name, v);
  }
  return { values, errors };
}

/** One stored state entry: the value and the declaration it was stored under. */
export interface StoredState {
  sig: string;
  value: unknown;
}

/**
 * State for a document, carrying over what was there before: a stored value
 * applies only while its declaration text (`sig`) is unchanged — the rule for a
 * refinement in place, a rollback and a reload alike. Everything else starts
 * from its initializer.
 */
export function restoreState(doc: WidgetDoc, stored: Record<string, StoredState> | null | undefined): { values: Record<string, unknown>; errors: string[] } {
  const init = initialState(doc);
  if (!stored || typeof stored !== "object") return init;
  for (const st of doc.states) {
    if (!hasOwn(stored, st.name)) continue;
    const entry = stored[st.name];
    if (!entry || typeof entry !== "object" || entry.sig !== st.sig) continue;
    try {
      init.values[st.name] = sanitizeData(entry.value, MAX_STATE_NODES);
    } catch {
      // too large to trust: keep the initializer's value
    }
  }
  return init;
}

/** The `{ name: { sig, value } }` record to store for `restoreState`. */
export function snapshotState(doc: WidgetDoc, values: Record<string, unknown>): Record<string, StoredState> {
  const out: Record<string, StoredState> = Object.create(null) as Record<string, StoredState>;
  for (const st of doc.states) out[st.name] = { sig: st.sig, value: hasOwn(values, st.name) ? values[st.name] : undefined };
  return out;
}

/** Bind the `{@const}` declarations of one children list into `env`: lazy, order-independent, a cycle reads undefined. */
function bindConsts(children: TNode[], env: Env, rt: Runtime): void {
  for (const node of children) {
    if (node.t !== "const") continue;
    bindConst(node, env, rt);
  }
}

function bindConst(node: ConstNode, env: Env, rt: Runtime): void {
  if (node.pattern.type === "Id") {
    env.setLazy(node.pattern.name, () => evaluate(node.expr, env, rt));
    return;
  }
  // A destructuring const: evaluate once, on the first name that is read.
  let cell: Env | null = null;
  const resolve = (): Env => {
    if (!cell) {
      const tmp = new Env(env);
      bindPattern(node.pattern, evaluate(node.expr, env, rt), tmp, rt);
      cell = tmp;
    }
    return cell;
  };
  for (const name of patternNames(node.pattern)) env.setLazy(name, () => resolve().vars.has(name) ? resolve().lookup(name).value : undefined);
}

/**
 * The root environment of a render pass: each state's current value, its
 * setter, `copy`, and the top-level consts. Build a new one whenever `values`
 * changes (consts are cached per environment). Building it STARTS the pass: it
 * calls `beginRender(rt)`, which refills the pass-wide step and output budgets.
 *
 * Setters and `copy` do nothing unless the runtime is in the "event" phase, so
 * rendering can never change state or re-trigger itself. A call made while
 * rendering is ignored but leaves a line in `rt.warnings` (the current block's),
 * which a renderer shows under that block.
 */
export function createRootEnv(doc: WidgetDoc, values: Record<string, unknown>, rt: Runtime, host: WidgetHost): Env {
  beginRender(rt);
  const env = new Env();
  for (const st of doc.states) {
    const name = st.name;
    env.set(name, hasOwn(values, name) ? values[name] : undefined);
    env.set(
      st.setter,
      markSafe((next: unknown) => {
        if (rt.phase !== "event") {
          noteIgnoredCall(rt, st.setter);
          return undefined;
        }
        spendSteps(rt, SETTER_STEPS);
        const value = typeof next === "function" ? callValue(next, [host.get(name)], rt) : next;
        host.set(name, sanitizeData(value, MAX_STATE_NODES));
        return undefined;
      }),
    );
  }
  env.set(
    "copy",
    markSafe((text: unknown) => {
      if (rt.phase !== "event") {
        noteIgnoredCall(rt, "copy");
        return undefined;
      }
      spendSteps(rt, COPY_STEPS);
      host.copy(toStr(text).slice(0, MAX_COPY_CHARS));
      return undefined;
    }),
  );
  bindConsts(doc.nodes, env, rt);
  return env;
}

/** The environment a children list renders in: `env` itself, or a child scope holding the list's `{@const}`s. */
export function childScope(children: TNode[], env: Env, rt: Runtime): Env {
  if (!children.some((n) => n.t === "const")) return env;
  const scope = new Env(env);
  bindConsts(children, scope, rt);
  return scope;
}

/** Characters a normalized prop value can put on screen (strings, and the data of a table / chart / option list). */
function propChars(v: unknown, limit: number): number {
  if (typeof v === "string") return v.length;
  if (v !== null && typeof v === "object") return dataSize(v, limit);
  return 0;
}

/**
 * Evaluate an element's attributes and normalize them against the component
 * spec. A prop whose expression throws is dropped and reported; a budget error
 * is NOT swallowed (the whole block is over budget).
 *
 * A prop that is WRITTEN in the source always comes back defined when the
 * component requires it: a value that evaluates to null/undefined (or to
 * something its type cannot take) becomes the type's empty value — see
 * `normalizeProps`. So "required prop missing" can only mean the prop is not in
 * the source at all (which the static check already refuses), or that its
 * expression threw (reported in `errors`).
 *
 * Each call charges the render pass's output budget: one element, plus the
 * characters its props carry.
 */
export function resolveProps(node: ElNode, env: Env, rt: Runtime): { props: Record<string, unknown>; errors: string[] } {
  const raw: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const errors: string[] = [];
  for (const attr of node.attrs) {
    if (attr.value === true || typeof attr.value === "string") {
      raw[attr.name] = attr.value;
      continue;
    }
    const expr = attr.value;
    try {
      raw[attr.name] = guarded(() => evaluate(expr, env, rt));
    } catch (err) {
      if (err instanceof WidgetBudgetError) throw err;
      errors.push(`${attr.name}: ${message(err)}`);
    }
  }
  const normalized = normalizeProps(node.name, raw);
  let chars = 0;
  for (const name of Object.keys(normalized.props)) chars += propChars(normalized.props[name], rt.outChars);
  chargeOutput(rt, 1, chars);
  return { props: normalized.props, errors: errors.concat(normalized.errors) };
}

/** Static text an `{#each}` body repeats per item (nested `{#each}` bodies charge themselves). */
const STATIC_CHARS = new WeakMap<EachNode, number>();
function staticChars(nodes: TNode[]): number {
  let total = 0;
  for (const n of nodes) {
    if (n.t === "text") total += n.value.length;
    else if (n.t === "el") total += staticChars(n.children);
    else if (n.t === "if") for (const b of n.branches) total += staticChars(b.children);
  }
  return total;
}

/**
 * One child environment per item of an `{#each}`. The list may be an array, a
 * non-negative integer n (0..n-1), a string (its characters) or a plain object
 * (its values). At most MAX_EACH_ITEMS are produced; `truncated` says so.
 */
export function eachScopes(node: EachNode, env: Env, rt: Runtime): { scopes: Env[]; truncated: boolean } {
  const list = guarded(() => evaluate(node.list, env, rt));
  let items: unknown[];
  let total: number;
  if (Array.isArray(list)) {
    total = list.length;
    items = list.slice(0, MAX_EACH_ITEMS);
  } else if (typeof list === "number" && Number.isFinite(list) && list > 0) {
    total = Math.floor(list);
    items = [];
    for (let i = 0; i < Math.min(total, MAX_EACH_ITEMS); i++) items.push(i);
  } else if (typeof list === "string") {
    items = Array.from(list.slice(0, MAX_EACH_ITEMS * 2)).slice(0, MAX_EACH_ITEMS);
    total = list.length > MAX_EACH_ITEMS * 2 ? MAX_EACH_ITEMS + 1 : items.length;
  } else if (isPlainData(list)) {
    const vals = Object.values(list);
    total = vals.length;
    items = vals.slice(0, MAX_EACH_ITEMS);
  } else {
    total = 0;
    items = [];
  }
  // Every iteration is output: a step each (an `{#each 1000}` without `as`
  // evaluates nothing per item), one unit of the pass's element budget each, and
  // the static text the body repeats. Nested loops multiply against that budget.
  let repeated = STATIC_CHARS.get(node);
  if (repeated === undefined) {
    repeated = staticChars(node.children);
    STATIC_CHARS.set(node, repeated);
  }
  spendSteps(rt, items.length);
  chargeOutput(rt, items.length, repeated * items.length);
  const scopes: Env[] = [];
  const item = node.item;
  for (let i = 0; i < items.length; i++) {
    const scope = new Env(env);
    if (item) guarded(() => bindPattern(item, items[i], scope, rt));
    if (node.index) scope.set(node.index, i);
    scopes.push(scope);
  }
  return { scopes, truncated: total > items.length };
}

/** The children of the first `{#if}` branch whose test holds (an `{:else}` always holds), or null. */
export function pickBranch(node: IfNode, env: Env, rt: Runtime): TNode[] | null {
  for (const b of node.branches) {
    const test = b.test;
    if (test === null || guarded(() => evaluate(test, env, rt))) return b.children;
  }
  return null;
}

/** The text an interpolated `{expr}` shows. */
export function interpolate(node: ExprNode, env: Env, rt: Runtime): string {
  const text = displayText(guarded(() => evaluate(node.expr, env, rt)));
  chargeOutput(rt, 0, text.length);
  return text;
}

export type SubmitValue = string | number | boolean | (string | number | boolean)[];
export type SubmitValues = { ok: true; values: Record<string, SubmitValue> } | { ok: false; error: string };

/**
 * What a `<submit values={…}>` may send: a plain object of up to
 * MAX_SUBMIT_KEYS entries whose values are strings, numbers, booleans or
 * arrays of them (a nested object is sent as its JSON text), MAX_SUBMIT_CHARS
 * in total. `error` is user-facing-neutral English for a log / the avatar.
 */
export function normalizeSubmitValues(raw: unknown): SubmitValues {
  // Size it BEFORE copying or serializing anything: a nested value is sent as its JSON text.
  const roomy = MAX_SUBMIT_CHARS + 2000;
  if (dataSize(raw, roomy) > roomy) return { ok: false, error: `submit values are too long (limit ${MAX_SUBMIT_CHARS} chars)` };
  let data: unknown;
  try {
    data = sanitizeData(raw, 2000, roomy);
  } catch (err) {
    return { ok: false, error: `submit values: ${message(err)}` };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "submit values must be an object" };
  const keys = Object.keys(data);
  if (keys.length > MAX_SUBMIT_KEYS) return { ok: false, error: `submit values has too many keys (limit ${MAX_SUBMIT_KEYS})` };
  const out: Record<string, SubmitValue> = Object.create(null) as Record<string, SubmitValue>;
  const flat = (v: unknown): string | number | boolean => {
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    if (v === null || v === undefined) return "";
    return JSON.stringify(v) ?? "";
  };
  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    // The key is shown to the avatar as `- key: value`: one line, no control characters.
    const key = k.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 64) || `value${i + 1}`;
    const v = (data as Record<string, unknown>)[k];
    const value: SubmitValue = Array.isArray(v) ? v.map(flat) : flat(v);
    total += key.length + (Array.isArray(value) ? value.reduce<number>((n, x) => n + String(x).length + 2, 0) : String(value).length);
    if (total > MAX_SUBMIT_CHARS) return { ok: false, error: `submit values are too long (limit ${MAX_SUBMIT_CHARS} chars)` };
    out[key] = value;
  }
  return { ok: true, values: out };
}

export { WidgetRuntimeError };
