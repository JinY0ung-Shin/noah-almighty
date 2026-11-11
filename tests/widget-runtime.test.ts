import { describe, expect, it } from "vitest";
import {
  Env,
  WidgetBudgetError,
  WidgetRuntimeError,
  MAX_EACH_ITEMS,
  MAX_OUT_CHARS,
  MAX_OUT_ELEMENTS,
  MAX_RENDER_STEPS,
  MAX_STEPS,
  MAX_SUBMIT_CHARS,
  NOOP_HANDLER,
  beginRender,
  chargeOutput,
  background,
  bool,
  childScope,
  clamp,
  createRootEnv,
  createRuntime,
  dedent,
  displayText,
  eachScopes,
  initialState,
  interpolate,
  invokeHandler,
  jsxWhitespace,
  lineColor,
  normalizeProps,
  normalizeSubmitValues,
  parseWidget,
  pickBranch,
  resetBudget,
  resolveProps,
  restoreState,
  snapshotState,
  spacing,
  textColor,
  unescapeText,
  type Runtime,
  type TNode,
  type WidgetDoc,
  type WidgetHost,
} from "../src/shared/widget/index.js";

// The evaluation model a renderer drives, exercised without a DOM: a tiny text
// "renderer" walks the document with the same helpers the Svelte layer uses.

interface Mounted {
  doc: WidgetDoc;
  rt: Runtime;
  values: Record<string, unknown>;
  copied: string[];
  render(): string;
  /** Props of the n-th element named `tag` in render order. */
  props(tag: string, n?: number): Record<string, unknown>;
}

function mount(src: string, stored?: Parameters<typeof restoreState>[1]): Mounted {
  const doc = parseWidget(src);
  expect(doc.problems, JSON.stringify(doc.problems)).toEqual([]);
  const rt = createRuntime();
  const values = restoreState(doc, stored).values;
  const copied: string[] = [];
  const host: WidgetHost = {
    get: (name) => values[name],
    set: (name, value) => {
      values[name] = value;
    },
    copy: (text) => copied.push(text),
  };
  let seen: { tag: string; props: Record<string, unknown> }[] = [];
  const walk = (nodes: TNode[], env: Env): string => {
    const scope = childScope(nodes, env, rt);
    let out = "";
    for (const node of nodes) {
      if (node.t === "text") out += node.block ? node.value : jsxWhitespace(unescapeText(node.value), false, false);
      else if (node.t === "expr") out += interpolate(node, scope, rt);
      else if (node.t === "el") {
        const { props } = resolveProps(node, scope, rt);
        seen.push({ tag: node.name, props });
        out += `<${node.name}>${walk(node.children, scope)}</${node.name}>`;
      } else if (node.t === "each") {
        const { scopes } = eachScopes(node, scope, rt);
        out += scopes.length ? scopes.map((s) => walk(node.children, s)).join("") : node.empty ? walk(node.empty, scope) : "";
      } else if (node.t === "if") {
        const branch = pickBranch(node, scope, rt);
        if (branch) out += walk(branch, scope);
      }
    }
    return out;
  };
  return {
    doc,
    rt,
    values,
    copied,
    render() {
      seen = [];
      resetBudget(rt);
      // top-level consts live in the root env, so the top-level list is walked in it directly
      return walk(doc.nodes.filter((n) => n.t !== "const"), createRootEnv(doc, values, rt, host));
    },
    props(tag, n = 0) {
      return seen.filter((s) => s.tag === tag)[n].props;
    },
  };
}

describe("widget runtime", () => {
  it("renders from state, and an event recomputes everything that depends on it", () => {
    const w = mount(
      [
        "{@state months = 12}",
        "{@const total = months * 250000}",
        '<slider label="기간" value={months} onChange={setMonths} min={6} max={60} />',
        "<text>{months}개월: {total.toLocaleString('en-US')}원</text>",
        "{#if months > 36}<badge>long</badge>{:else}<badge>short</badge>{/if}",
      ].join("\n"),
    );
    expect(w.render()).toContain("<text>12개월: 3,000,000원</text>");
    expect(w.render()).toContain("<badge>short</badge>");
    expect(w.props("slider")).toMatchObject({ label: "기간", value: 12, min: 6, max: 60 });
    expect(invokeHandler(w.rt, w.props("slider").onChange, [48]).ok).toBe(true);
    expect(w.values.months).toBe(48);
    expect(w.render()).toContain("<text>48개월: 12,000,000원</text>");
    expect(w.render()).toContain("<badge>long</badge>");
  });

  it("setters and copy do nothing while rendering", () => {
    const w = mount("{@state n = 1}\n{@const bump = () => setN(n + 1)}\n<text>{bump() ?? 'x'}{copy('leak') ?? ''}</text>\n<button onClick={() => { setN(n + 1); copy(`n=${n}`) }}>go</button>");
    expect(w.render()).toContain("<text>x</text>");
    expect(w.values.n).toBe(1);
    expect(w.copied).toEqual([]);
    invokeHandler(w.rt, w.props("button").onClick, []);
    expect(w.values.n).toBe(2);
    expect(w.copied).toEqual(["n=1"]);
    expect(w.rt.phase).toBe("render");
  });

  it("a setter or copy call made while rendering is ignored but leaves a warning for that block", () => {
    // Inside a function body, so the static check lets it through.
    const w = mount("{@state a = 0}\n{@state xs = [1, 2, 3]}\n<text>{xs.map((x) => setA(x)).length}{copy('x') ?? ''}</text>\n<button onClick={() => setA(9)}>go</button>");
    expect(w.render()).toContain("<text>3</text>");
    expect(w.values.a).toBe(0);
    expect(w.copied).toEqual([]);
    // One line per callee, however often it was called.
    expect(w.rt.warnings).toEqual([
      "setA(…) was called while rendering and was ignored — call a setter only from an event handler (onChange/onClick).",
      "copy(…) was called while rendering and was ignored — call copy only from an event handler (onChange/onClick).",
    ]);
    // An event neither adds to the list nor is affected by it; phase and budgets are as before.
    const steps = w.rt.steps;
    expect(invokeHandler(w.rt, w.props("button").onClick, []).ok).toBe(true);
    expect(w.values.a).toBe(9);
    expect(w.rt.warnings).toHaveLength(2);
    expect(w.rt.phase).toBe("render");
    expect(w.rt.steps).toBe(steps);
    // The next block starts with an empty list.
    resetBudget(w.rt);
    expect(w.rt.warnings).toEqual([]);
  });

  it("keeps at most five ignored-call warnings per block", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const w = mount(
      names.map((n) => `{@state ${n} = 0}`).join("\n") +
        "\n<text>{[1].map(() => { " +
        names.map((n) => `set${n.toUpperCase()}(1);`).join(" ") +
        " return 1 }).length}</text>",
    );
    w.render();
    expect(w.rt.warnings).toHaveLength(5);
    expect(w.rt.warnings[0]).toContain("setA(…)");
    expect(Object.values(w.values)).toEqual(names.map(() => 0));
  });

  it("an updater sees the latest value, so chained calls in one handler compose", () => {
    const w = mount("{@state n = 0}\n<button onClick={() => { setN((p) => p + 1); setN((p) => p + 1); setN((p) => p * 10) }}>go</button>");
    w.render();
    invokeHandler(w.rt, w.props("button").onClick, []);
    expect(w.values.n).toBe(20);
  });

  it("stored state is plain data: a function never gets in", () => {
    const w = mount("{@state v = 1}\n<button onClick={() => setV({ f: () => 1, list: [1, () => 2], s: 'ok' })}>go</button>");
    w.render();
    invokeHandler(w.rt, w.props("button").onClick, []);
    expect(w.values.v).toEqual({ f: undefined, list: [1, undefined], s: "ok" });
    const big = mount("{@state v = 1}\n<button onClick={() => setV(Array.from({length: 40}).reduce((a) => [a, a], [0]))}>go</button>");
    big.render();
    const r = invokeHandler(big.rt, big.props("button").onClick, []);
    expect(r.ok).toBe(false);
    expect(big.values.v).toBe(1);
  });

  it("state initializers run in order and see only earlier states", () => {
    const doc = parseWidget('{@state a = 2}\n{@state b = a * 3}\n{@state c = [a, b].map((x) => x + 1)}\n{@state d}\n{@state bad = nope.x}\n{@state fn = () => 1}');
    const init = initialState(doc);
    expect({ ...init.values }).toEqual({ a: 2, b: 6, c: [3, 7], d: undefined, bad: undefined, fn: undefined });
    expect(init.errors).toEqual(["state bad: nope is not defined"]);
  });

  it("a stored value applies only while its declaration is unchanged", () => {
    const v1 = parseWidget("{@state months = 12}\n{@state rate = 4.5}");
    const stored = snapshotState(v1, { months: 48, rate: 3 });
    expect({ ...stored }).toEqual({ months: { sig: "months = 12", value: 48 }, rate: { sig: "rate = 4.5", value: 3 } });
    // refinement: `rate` got a new initializer, `months` did not, `extra` is new
    const v2 = parseWidget("{@state months = 12}\n{@state rate = 5.0}\n{@state extra = months}");
    expect({ ...restoreState(v2, stored).values }).toEqual({ months: 48, rate: 5, extra: 12 });
    // garbage in the store is ignored
    expect({ ...restoreState(v2, { months: null, rate: { sig: "rate = 5.0" } } as never).values }).toEqual({ months: 12, rate: undefined, extra: 12 });
    expect({ ...restoreState(v2, null).values }).toEqual({ months: 12, rate: 5, extra: 12 });
    expect({ ...restoreState(v2, { months: { sig: "months = 12", value: new Array(30_000).fill(0) } }).values }.months).toBe(12);
    // a state named like an Object member reads its own value, never the prototype's
    const odd = parseWidget("{@state constructor = 1}");
    expect(restoreState(odd, {}).values.constructor).toBe(1);
  });

  it("consts are lazy, order-independent, scoped to their list, and a cycle reads undefined", () => {
    const w = mount(
      [
        "{@const b = a + 1}",
        "{@const a = 1}",
        "{@const [first, { deep = 9 }] = [10, {}]}",
        "{@const x = y}",
        "{@const y = x}",
        "<col>",
        "  {@const local = b * 2}",
        "  <text>{b} {local} {first} {deep} [{x}]</text>",
        "</col>",
      ].join("\n"),
    );
    expect(w.render()).toContain("<text>2 4 10 9 []</text>");
  });

  it("each: arrays, counts, strings, objects, destructuring, the else branch and the item cap", () => {
    const w = mount(
      [
        "{@state rows = [{ n: 'a', v: 1 }, { n: 'b', v: 2 }]}",
        "<col>",
        "{#each rows as { n, v }, i}<text>{i}{n}{v}</text>{/each}",
        "{#each 3 as k}<badge>{k}</badge>{/each}",
        "{#each 'hé' as ch}<title>{ch}</title>{/each}",
        "{#each { p: 1, q: 2 } as val}<stat label=\"x\" value={val} />{/each}",
        "{#each [] as z}<text>never</text>{:else}<callout>empty</callout>{/each}",
        "{#each null as z}<text>never</text>{/each}",
        "</col>",
      ].join("\n"),
    );
    const html = w.render();
    expect(html).toContain("<text>0a1</text><text>1b2</text>");
    expect(html).toContain("<badge>0</badge><badge>1</badge><badge>2</badge>");
    expect(html).toContain("<title>h</title><title>é</title>");
    expect(html).toContain("<callout>empty</callout>");
    expect(html).not.toContain("never");
    expect(w.props("stat", 1).value).toBe(2);

    const doc = parseWidget("<col>{#each Array.from({length: 5000}, (_, i) => i) as n}<text>{n}</text>{/each}</col>");
    const each = (doc.nodes[0] as Extract<TNode, { t: "el" }>).children[0] as Extract<TNode, { t: "each" }>;
    const rt = createRuntime();
    const { scopes, truncated } = eachScopes(each, new Env(), rt);
    expect(scopes.length).toBe(MAX_EACH_ITEMS);
    expect(truncated).toBe(true);
  });

  it("a prop whose expression fails is dropped and reported; running out of budget is not swallowed", () => {
    const w = mount("{@state o = null}\n<stat label=\"a\" value={o.missing} hint=\"kept\" />");
    w.render();
    expect(w.props("stat")).toEqual({ label: "a", hint: "kept" });
    const doc = parseWidget("<stat label=\"a\" value={o.missing} />");
    const rt = createRuntime();
    const el = doc.nodes[0] as Extract<TNode, { t: "el" }>;
    const env = new Env();
    env.set("o", null);
    expect(resolveProps(el, env, rt).errors[0]).toMatch(/^value: Cannot read properties of null/);
    rt.steps = 0;
    expect(() => resolveProps(el, env, rt)).toThrow(WidgetBudgetError);
  });

  it("interpolation shows text and numbers, and nothing for null/boolean/objects", () => {
    expect([0, "a", null, undefined, true, false, [1, [2, 3]], { a: 1 }, () => 1].map(displayText)).toEqual(["0", "a", "", "", "", "", "1,2,3", "", ""]);
    const w = mount("{@state ok = false}\n<text>[{ok && 'yes'}][{1 > 0 && 'shown'}]</text>");
    expect(w.render()).toContain("<text>[][shown]</text>");
  });
});

describe("widget props normalization", () => {
  it("only declared props survive, each coerced to its type", () => {
    const fn = () => 1;
    const { props } = normalizeProps("slider", {
      label: 12,
      value: "7",
      onChange: fn,
      min: -5,
      max: 1e99,
      step: 0,
      suffix: "x".repeat(50),
      showValue: "true",
      style: "color:red",
      __proto__: { polluted: true },
    } as Record<string, unknown>);
    expect({ ...props }).toEqual({ label: "12", value: 7, onChange: fn, min: -5, max: 1e12, step: 1e-6, suffix: "x".repeat(20), showValue: true });
    expect(Object.getPrototypeOf(props)).toBe(null);
  });

  it("enums, tokens and booleans", () => {
    expect({ ...normalizeProps("box", { background: "red", radius: "lg", direction: "row", border: "", gap: 99, padding: -1, align: "top" }).props }).toEqual({
      radius: "lg",
      direction: "row",
      border: true,
      gap: 8,
      padding: 0,
    });
    expect({ ...normalizeProps("grid", { columns: 2.6 }).props }).toEqual({ columns: 3 });
    expect({ ...normalizeProps("details", { title: ["a", "b"], open: 0 }).props }).toEqual({ title: "a,b", open: false });
    expect(normalizeProps("nope", {}).errors).toEqual(["unknown component <nope>"]);
  });

  it("options, columns, rows and objects are rebuilt as bounded plain data", () => {
    const fn = () => 1;
    expect(normalizeProps("select", { options: ["a", 2, { label: "L", value: true }, { label: "only" }, { value: 5 }, null, [1], { label: fn }] }).props.options).toEqual([
      { label: "a", value: "a" },
      { label: "2", value: 2 },
      { label: "L", value: true },
      { label: "only", value: "only" },
      { label: "5", value: 5 },
    ]);
    expect((normalizeProps("select", { options: Array.from({ length: 500 }, (_, i) => i) }).props.options as unknown[]).length).toBe(60);
    expect(normalizeProps("select", { options: "a,b" }).props.options).toEqual([]); // required and written: empty, not missing
    const table = normalizeProps("table", {
      columns: ["id", { key: "v", label: "값", align: "end" }, { key: "w", align: "sideways" }, { label: "no key" }, 5],
      rows: [{ id: 1, v: fn }, "junk", [1], { id: 2, nested: { deep: [1, fn] } }],
    }).props;
    expect(table.columns).toEqual([
      { key: "id", label: "id", align: "start", sortable: true },
      { key: "v", label: "값", align: "end", sortable: true },
      { key: "w", label: "w", align: "start", sortable: true },
    ]);
    // A column opts out of a sortable table with `sortable: false` — and only with that.
    expect(normalizeProps("table", { columns: [{ key: "a", sortable: false }, { key: "b", sortable: 0 }, { key: "c", sortable: "no" }] }).props.columns).toEqual([
      { key: "a", label: "a", align: "start", sortable: false },
      { key: "b", label: "b", align: "start", sortable: true },
      { key: "c", label: "c", align: "start", sortable: true },
    ]);
    expect(table.rows).toEqual([{ id: 1, v: undefined }, { id: 2, nested: { deep: [1, undefined] } }]);
    const spec = { mark: "bar", data: { values: [{ a: 1 }] }, fn };
    const chart = normalizeProps("chart", { spec, height: 9999 }).props;
    expect(chart.spec).toEqual({ mark: "bar", data: { values: [{ a: 1 }] }, fn: undefined });
    expect(chart.spec).not.toBe(spec); // a copy: the renderer never holds interpreter values
    expect(chart.height).toBe(600);
    expect(normalizeProps("chart", { spec: [1] }).props.spec).toEqual({}); // required and written: empty, not missing
    // data too large to copy is dropped and reported, never passed through
    const dag = Array.from({ length: 40 }).reduce<unknown[]>((a) => [a, a], [0]);
    const huge = normalizeProps("chart", { spec: { data: dag } });
    expect(huge.props.spec).toBe(undefined);
    expect(huge.errors[0]).toMatch(/^spec: value is too large/);
  });
});

describe("widget submit values", () => {
  it("flattens to primitives and arrays of primitives", () => {
    const r = normalizeSubmitValues({ months: 12, ok: true, name: "kim", tags: ["a", 1, { x: 1 }], nested: { a: [1] }, none: null, inf: Infinity, fn: () => 1 });
    expect(r.ok && { ...r.values }).toEqual({ months: 12, ok: true, name: "kim", tags: ["a", 1, '{"x":1}'], nested: '{"a":[1]}', none: "", inf: "Infinity", fn: "" });
  });

  it("refuses what is not an object, too many keys, or too much text", () => {
    expect(normalizeSubmitValues([1])).toEqual({ ok: false, error: "submit values must be an object" });
    expect(normalizeSubmitValues("x")).toEqual({ ok: false, error: "submit values must be an object" });
    expect(normalizeSubmitValues(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])))).toEqual({ ok: false, error: "submit values has too many keys (limit 20)" });
    expect(normalizeSubmitValues({ a: "x".repeat(MAX_SUBMIT_CHARS + 1) })).toEqual({ ok: false, error: "submit values are too long (limit 8000 chars)" });
    expect(normalizeSubmitValues({ a: new Array(5000).fill(0) }).ok).toBe(false);
    const r = normalizeSubmitValues({ ["k".repeat(100)]: 1 });
    expect(r.ok && Object.keys(r.values)[0].length).toBe(64);
  });
});

describe("widget style and text helpers", () => {
  it("only design tokens become CSS", () => {
    expect(textColor("accent")).toBe("var(--accent)");
    expect(textColor("red")).toBe(undefined);
    expect(textColor("constructor")).toBe(undefined);
    expect(background("warning")).toBe("var(--warn-soft)");
    expect(background("url(x)")).toBe(undefined);
    expect(lineColor("danger")).toBe("var(--danger-line)");
    expect(lineColor(3)).toBe(undefined);
    expect(spacing(2)).toBe("8px");
    expect(spacing("3")).toBe("12px");
    expect(spacing(99)).toBe("32px");
    expect(spacing("1px; color:red")).toBe(undefined);
    expect(clamp("x", 0, 1)).toBe(undefined);
    expect([bool(true), bool(""), bool("true"), bool("false"), bool(1)]).toEqual([true, true, true, false, false]);
  });

  it("dedent, JSX whitespace and escapes", () => {
    expect(dedent("  a\n    b\n  c")).toBe("a\n  b\nc");
    expect(dedent("first\n    x\n    y")).toBe("first\nx\ny");
    expect(dedent("no indent\nhere")).toBe("no indent\nhere");
    expect(jsxWhitespace("\n   hello   \n   world  \n", true, true)).toBe("hello world");
    expect(jsxWhitespace(" a ", false, false)).toBe(" a ");
    expect(unescapeText("\\{x\\} \\< \\\\ \\n")).toBe("{x} < \\ \\n");
  });
});

// Regressions from the adversarial review and the integration review (2026-11-10).
describe("widget runtime: what a render may produce", () => {
  /** Render like a client does: one budget window per top-level block; a block that throws is recorded. */
  const blocks = (src: string) => {
    const doc = parseWidget(src);
    expect(doc.problems).toEqual([]);
    const rt = createRuntime();
    const values = restoreState(doc, null).values;
    const host: WidgetHost = { get: (n) => values[n], set: (n, v) => void (values[n] = v), copy: () => {} };
    const root = createRootEnv(doc, values, rt, host);
    let els = 0;
    let chars = 0;
    const errors: string[] = [];
    const walk = (nodes: TNode[], env: Env) => {
      const scope = childScope(nodes, env, rt);
      for (const n of nodes) {
        if (n.t === "text") chars += n.value.length;
        else if (n.t === "expr") chars += interpolate(n, scope, rt).length;
        else if (n.t === "el") {
          els++;
          resolveProps(n, scope, rt);
          walk(n.children, scope);
        } else if (n.t === "each") for (const sc of eachScopes(n, scope, rt).scopes) walk(n.children, sc);
        else if (n.t === "if") {
          const b = pickBranch(n, scope, rt);
          if (b) walk(b, scope);
        }
      }
    };
    const t0 = performance.now();
    for (const n of doc.nodes) {
      resetBudget(rt);
      try {
        walk([n], root);
      } catch (err) {
        errors.push(`${(err as Error).constructor.name}: ${(err as Error).message}`);
      }
    }
    return { els, chars, errors, ms: performance.now() - t0, rt };
  };

  it("a loop pays a step and a unit of output per iteration, even with nothing to evaluate", () => {
    const doc = parseWidget("<col>{#each 500}<divider />{/each}</col>");
    const each = (doc.nodes[0] as Extract<TNode, { t: "el" }>).children[0] as Extract<TNode, { t: "each" }>;
    const rt = createRuntime();
    const { scopes } = eachScopes(each, new Env(), rt);
    expect(scopes.length).toBe(500);
    expect(MAX_STEPS - rt.steps).toBeGreaterThanOrEqual(500);
    expect(MAX_OUT_ELEMENTS - rt.outEls).toBe(500);
  });

  it("nested loops cannot multiply past the output budget", () => {
    // 1,000,000 elements (300 ms, +237 MB) without the budget
    const r = blocks("<col>\n{#each 1000}{#each 1000}<divider/>{/each}{/each}\n</col>");
    expect(r.errors).toEqual(["WidgetBudgetError: too much is rendered (output budget exceeded)"]);
    expect(r.els).toBeLessThanOrEqual(MAX_OUT_ELEMENTS);
    expect(r.ms).toBeLessThan(1000);
    // static text repeated by a loop counts too, with no component in the body
    const text = blocks("<col>{#each 1000}{#each 1000}" + "x".repeat(100) + "{/each}{/each}</col>");
    expect(text.errors[0]).toMatch(/output budget exceeded/);
    // and so does interpolated text: 1,000 x 100,000 characters
    const interp = blocks('{@const s = "x".repeat(100000)}\n<col>{#each Array.from({length:1000}).fill(s) as t}<text>{t}</text>{/each}</col>');
    expect(interp.errors[0]).toMatch(/output budget exceeded/);
    expect(interp.chars).toBeLessThanOrEqual(MAX_OUT_CHARS + 100); // (+ the document's own static text)
    // a big-but-reasonable list is fine
    const fine = blocks("<col>{#each 1000 as i}<row><text>{i}</text><badge>ok</badge></row>{/each}</col>");
    expect(fine.errors).toEqual([]);
    expect(fine.els).toBe(3001);
  });

  it("the output budget is per render pass: createRootEnv (or beginRender) starts a new one", () => {
    const src = "<col>{#each 1000}{#each 15}<divider/>{/each}{/each}</col>"; // 16,000 of the 20,000 units
    const doc = parseWidget(src);
    const rt = createRuntime();
    const host: WidgetHost = { get: () => 0, set: () => {}, copy: () => {} };
    const col = doc.nodes[0] as Extract<TNode, { t: "el" }>;
    const pass = (root: Env) => {
      const outer = col.children[0] as Extract<TNode, { t: "each" }>;
      for (const sc of eachScopes(outer, root, rt).scopes) for (const n of outer.children) if (n.t === "each") eachScopes(n, sc, rt);
    };
    for (let i = 0; i < 5; i++) pass(createRootEnv(doc, {}, rt, host)); // five renders: each starts fresh
    const root = createRootEnv(doc, {}, rt, host);
    pass(root);
    expect(() => pass(root)).toThrow(/output budget exceeded/); // the same pass, walked twice
    beginRender(rt);
    pass(root); // ...unless the renderer says a new pass began
    expect(() => chargeOutput(rt, MAX_OUT_ELEMENTS, 0)).toThrow(WidgetBudgetError);
  });

  it("a render pass has a total step budget across its blocks", () => {
    // 660 blocks that each burn most of a window: 455 ms without a pass-wide total
    let src = "{@const burn = () => Array.from({length:9900}).map((x, i) => i).length}\n";
    for (let i = 0; i < 660; i++) src += "<text>{burn()}</text>\n";
    const r = blocks(src);
    const failed = r.errors.filter((e) => /step budget exceeded/.test(e)).length;
    expect(failed).toBeGreaterThan(600);
    expect(r.errors.length).toBe(failed);
    expect(r.chars).toBeGreaterThan(0); // the first blocks rendered
    expect(r.ms).toBeLessThan(1000);
    // unused steps go back to the pass: many cheap blocks never run out
    const cheap = blocks("{@state n = 1}\n" + "<text>{n + 1}</text>\n".repeat(900));
    expect(cheap.errors).toEqual([]);
    expect(cheap.rt.renderSteps + cheap.rt.steps).toBeGreaterThan(MAX_RENDER_STEPS * 0.9);
    // an event never spends the pass's steps
    const rt = createRuntime();
    const fn = blocksHandler(rt);
    const before = { steps: rt.steps, renderSteps: rt.renderSteps };
    expect(invokeHandler(rt, fn, []).ok).toBe(true);
    expect({ steps: rt.steps, renderSteps: rt.renderSteps }).toEqual(before);
  });

  function blocksHandler(rt: Runtime): unknown {
    const doc = parseWidget("{@state n = 0}\n<button onClick={() => setN(Array.from({length: 2000}).map((x, i) => i).length)}>go</button>");
    const values = restoreState(doc, null).values;
    const env = createRootEnv(doc, values, rt, { get: (n) => values[n], set: (n, v) => void (values[n] = v), copy: () => {} });
    return resolveProps(doc.nodes[1] as Extract<TNode, { t: "el" }>, env, rt).props.onClick;
  }

  it("a deep computation in any helper is a widget error, not a RangeError", () => {
    const r = blocks("{@const f = (n) => " + "[".repeat(20) + "f(n + 1)" + "]".repeat(20) + '}\n<text>{f(0)}</text>\n<stat label="a" value={f(0)} />\n<col>{#each f(0) as x}<divider />{/each}</col>\n<col>{#if f(0)}<divider />{/if}</col>');
    expect(r.errors).toEqual(["WidgetRuntimeError: the computation is nested too deeply", "WidgetRuntimeError: the computation is nested too deeply", "WidgetRuntimeError: the computation is nested too deeply"]);
    // (the <stat> block reports through resolveProps' errors instead of throwing)
  });
});

describe("widget props: a prop that is written but empty is not a missing prop", () => {
  const propsOf = (src: string) => {
    const doc = parseWidget(src);
    expect(doc.problems).toEqual([]);
    const rt = createRuntime();
    const values = restoreState(doc, null).values;
    const env = createRootEnv(doc, values, rt, { get: (n) => values[n], set: (n, v) => void (values[n] = v), copy: () => {} });
    const out: { tag: string; props: Record<string, unknown>; errors: string[] }[] = [];
    const walk = (nodes: TNode[], e: Env) => {
      for (const n of nodes) {
        if (n.t === "el") {
          const r = resolveProps(n, e, rt);
          out.push({ tag: n.name, props: { ...r.props }, errors: r.errors });
          walk(n.children, e);
        } else if (n.t === "each") for (const sc of eachScopes(n, e, rt).scopes) walk(n.children, sc);
      }
    };
    walk(doc.nodes, env);
    return { out, rt, values };
  };

  it("a checkbox bound to a key that is not set yet renders unchecked, and ticking it works", () => {
    const { out, rt, values } = propsOf('{@state done = {}}\n<col>{#each ["a", "b"] as k}<checkbox checked={done[k]} onChange={(c) => setDone({ ...done, [k]: c })}>{k}</checkbox>{/each}</col>');
    const boxes = out.filter((o) => o.tag === "checkbox");
    expect(boxes.map((b) => [b.props.checked, b.errors])).toEqual([
      [false, []],
      [false, []],
    ]);
    expect(invokeHandler(rt, boxes[1].props.onChange, [true]).ok).toBe(true);
    expect(values.done).toEqual({ b: true });
  });

  it("every type has an empty value for a required prop that evaluated to null / undefined", () => {
    const { out } = propsOf(
      [
        "{@state pick = null}",
        "{@const rows = []}",
        "{@const none = null}",
        '<select label="s" value={pick} onChange={setPick} options={["a"]} />',
        '<segmented-control label="g" value={pick} onChange={setPick} options={none} />',
        '<tabs label="t" value={rows.find((r) => r.on)?.id} onChange={setPick} options={["a"]} />',
        '<input label="i" value={pick} onChange={setPick} />',
        '<stat label="price" value={rows.find((r) => r.id === 1)?.price} />',
        '<slider label="n" value={pick} onChange={setPick} min={5} max={9} />',
        '<slider label="n2" value={none} onChange={none} />',
        '<progress label="p" value={pick} />',
        "<switch checked={pick} onChange={none}>on</switch>",
        "<table columns={none} rows={none} />",
        "<chart spec={none} />",
        "<submit values={none}>go</submit>",
        '<details title={none}><text>x</text></details>',
        "<button onClick={none}>b</button>",
      ].join("\n"),
    );
    const by = (tag: string, n = 0) => out.filter((o) => o.tag === tag)[n].props;
    expect(out.flatMap((o) => o.errors)).toEqual([]);
    expect(by("select").value).toBe("");
    expect(by("segmented-control")).toMatchObject({ value: "", options: [] });
    expect(by("tabs").value).toBe("");
    expect(by("input").value).toBe("");
    expect(by("stat").value).toBe("");
    expect(by("slider", 0).value).toBe(5); // the component's own min
    expect(by("slider", 1)).toMatchObject({ value: 0, onChange: NOOP_HANDLER });
    expect(by("progress").value).toBe(0);
    expect(by("switch")).toMatchObject({ checked: false, onChange: NOOP_HANDLER });
    expect(by("table")).toMatchObject({ columns: [], rows: [] });
    expect(by("chart").spec).toEqual({});
    expect(by("submit").values).toEqual({});
    expect(by("details").title).toBe("");
    expect(by("button").onClick).toBe(NOOP_HANDLER);
    expect(invokeHandler(createRuntime(), by("button").onClick, [])).toEqual({ ok: true, value: undefined });
  });

  it("an unusable value falls back the same way; an OPTIONAL prop is simply left out", () => {
    expect({ ...normalizeProps("stat", { label: "x", value: 0 / 0 }).props }).toEqual({ label: "x", value: "" }); // NaN is not displayable
    expect({ ...normalizeProps("stat", { label: "x", value: 1 / 0, hint: null, delta: undefined }).props }).toEqual({ label: "x", value: "" });
    expect({ ...normalizeProps("select", { label: "x", value: { a: 1 }, onChange: "nope", options: 5 }).props }).toEqual({ label: "x", value: "", onChange: NOOP_HANDLER, options: [] });
    expect({ ...normalizeProps("slider", { label: "x", value: "abc", onChange: NOOP_HANDLER, min: -1 / 0, max: 20, step: 0 }).props }).toEqual({ label: "x", value: 0, onChange: NOOP_HANDLER, max: 20, step: 1e-6 });
    expect({ ...normalizeProps("box", { gap: null, border: undefined, background: null }).props }).toEqual({});
  });

  it("a required prop that is not written at all is still missing (the static check refuses it; a renderer reports it)", () => {
    expect("checked" in normalizeProps("checkbox", { onChange: NOOP_HANDLER }).props).toBe(false);
    expect("value" in normalizeProps("stat", { label: "x" }).props).toBe(false);
    // ...and one whose expression threw is reported, not defaulted
    const doc = parseWidget('<stat label="x" value={nope.price} />');
    const env = new Env();
    env.set("nope", null);
    const r = resolveProps(doc.nodes[0] as Extract<TNode, { t: "el" }>, env, createRuntime());
    expect("value" in r.props).toBe(false);
    expect(r.errors[0]).toMatch(/^value: Cannot read properties of null/);
  });
});

describe("widget data that leaves the interpreter is bounded in characters", () => {
  it("labels and keys are cut, on every path", () => {
    expect((normalizeProps("table", { columns: ["k".repeat(100_000), { key: "x".repeat(5000), label: "y".repeat(5000) }], rows: [] }).props.columns as { key: string; label: string }[]).map((c) => [c.key.length, c.label.length])).toEqual([
      [200, 200],
      [200, 200],
    ]);
    const options = normalizeProps("select", { options: ["o".repeat(5000), { label: "l".repeat(5000), value: 1 }] }).props.options as { label: string; value: unknown }[];
    expect(options.map((o) => o.label.length)).toEqual([200, 200]);
    expect((options[0].value as string).length).toBe(2000);
  });

  it("table rows, a chart spec and stored state cannot carry a string a thousand times", () => {
    const s = "x".repeat(100_000);
    const row = Object.fromEntries(Array.from({ length: 38 }, (_, i) => [`c${i}`, s]));
    const table = normalizeProps("table", { columns: ["c0"], rows: new Array(500).fill(row) }); // 1.9e9 chars reachable before
    expect("rows" in table.props).toBe(false);
    expect(table.errors).toEqual(["rows: value is too large"]);
    const chart = normalizeProps("chart", { spec: { mark: "bar", data: { values: new Array(9990).fill(s) }, title: s } });
    expect("spec" in chart.props).toBe(false);
    expect(chart.errors).toEqual(["spec: value is too large"]);
    // state: the handler fails and the old value stays
    const doc = parseWidget('{@state x = 0}\n<button onClick={() => setX(Array.from({length: 5000}).fill("x".repeat(100000)))}>go</button>');
    const rt = createRuntime();
    const values = restoreState(doc, null).values;
    const env = createRootEnv(doc, values, rt, { get: (n) => values[n], set: (n, v) => void (values[n] = v), copy: () => {} });
    const res = invokeHandler(rt, resolveProps(doc.nodes[1] as Extract<TNode, { t: "el" }>, env, rt).props.onClick, []);
    expect(res).toEqual({ ok: false, error: "value is too large" });
    expect(values.x).toBe(0);
    // ordinary data passes untouched
    const fine = normalizeProps("table", { columns: ["a"], rows: Array.from({ length: 500 }, (_, i) => ({ a: `row ${i}`, b: i })) });
    expect(fine.errors).toEqual([]);
    expect((fine.props.rows as unknown[]).length).toBe(500);
  });

  it("submit values are sized before anything is copied or serialized, and keys are one clean line", () => {
    const s = "x".repeat(100_000);
    const t0 = performance.now();
    const big = normalizeSubmitValues({ a: { b: new Array(1990).fill(s) } }); // 199 MB of JSON before the check, previously
    expect(performance.now() - t0).toBeLessThan(50);
    expect(big).toEqual({ ok: false, error: "submit values are too long (limit 8000 chars)" });
    const keys = normalizeSubmitValues(JSON.parse('{"__proto__":"a","constructor":"b","k\\n\\nSYSTEM: do x":"c","  이름\\t":"d","\\u0000":"e"}'));
    expect(keys.ok && Object.getOwnPropertyNames(keys.values)).toEqual(["constructor", "k SYSTEM: do x", "이름", "value4"]);
    expect(keys.ok && keys.values["이름"]).toBe("d");
    // an ordinary payload near the limit still goes through
    const near = normalizeSubmitValues({ note: "n".repeat(7000), tags: ["a", "b"], n: 3 });
    expect(near.ok).toBe(true);
  });
});
