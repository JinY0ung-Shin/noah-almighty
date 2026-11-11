import { describe, expect, it } from "vitest";
import { MAX_WIDGET_NODES, MAX_WIDGET_STATES, checkWidget } from "../src/shared/widget/check.js";
import { WIDGET_COMPONENTS, WIDGET_TAGS, widgetComponentReference } from "../src/shared/widget/spec.js";

// The static check `mcp__canvas__show` runs before a widget is shown. Its
// error text is read by the avatar, so every case pins WHAT it says to do.

const SAMPLES: Record<string, string> = {
  loan: [
    "{@state months = 12}",
    "{@state rate = 4.5}",
    "{@const principal = 30000000}",
    "{@const monthly = principal * (rate / 1200) / (1 - (1 + rate / 1200) ** -months)}",
    "{@const schedule = Array.from({ length: months }, (_, i) => ({ month: i + 1, balance: Math.round(principal - (principal / months) * (i + 1)) }))}",
    "",
    "## 대출 계산기",
    "",
    "기간과 금리를 바꿔 보세요. `a < b` 같은 텍스트와 {중괄호}도 그대로 보입니다.",
    "",
    '<box border padding={3} gap={2} background="surface">',
    "  <row gap={3} align=\"center\">",
    '    <slider label="기간(개월)" value={months} onChange={setMonths} min={6} max={60} step={6} suffix="개월" />',
    '    <input label="금리" type="number" value={rate} onChange={(v) => setRate(v === "" ? 0 : v)} min={0} max={20} step={0.1} />',
    "  </row>",
    '  <stat label="월 납입액" value={`${Math.round(monthly).toLocaleString()}원`} trend="flat" />',
    "  {#if months > 36}",
    '    <callout tone="warning" title="주의">36개월을 넘으면 우대 금리가 빠집니다.</callout>',
    "  {:else if months === 36}",
    "    <text color=\"muted\">딱 36개월입니다.</text>",
    "  {/if}",
    '  <chart label="잔액 추이" height={220} spec={{ mark: "line", data: { values: schedule }, encoding: { x: { field: "month", type: "quantitative" }, y: { field: "balance", type: "quantitative" } } }} />',
    '  <table columns={[{ key: "month", label: "회차" }, { key: "balance", label: "잔액", align: "end" }]} rows={schedule.slice(0, 6)} />',
    "</box>",
    "",
    "<submit values={{ months, rate }}>이 조건으로 진행</submit>",
  ].join("\n"),
  tabsAndList: [
    '{@state tab = "all"}',
    "{@state done = [false, false, true]}",
    '{@const items = ["기획", "개발", "검수"]}',
    "{@const shown = items.map((name, i) => ({ name, i, ok: done[i] })).filter((it) => tab === \"all\" || (tab === \"open\") === !it.ok)}",
    "",
    '<tabs label="보기" value={tab} onChange={setTab} options={[{ label: "전체", value: "all" }, { label: "남은 일", value: "open" }]} />',
    "<col gap={1}>",
    "  {#each shown as { name, i, ok }, row}",
    "    {@const mark = ok ? \"✓\" : \"·\"}",
    "    <row gap={2}>",
    "      <checkbox checked={ok} onChange={(v) => setDone((prev) => prev.with(i, v))}>{row + 1}. {name} {mark}</checkbox>",
    '      <button variant="ghost" onClick={() => { copy(name); }}>복사</button>',
    "    </row>",
    "  {:else}",
    "    <text color=\"muted\">표시할 항목이 없습니다.</text>",
    "  {/each}",
    "</col>",
    '<progress label="진행률" value={done.filter((d) => d).length / items.length} tone="success" />',
    '<details title="자세히" open>',
    "  <grid columns={2} gap={2}>",
    "    <grid-item><badge tone=\"info\">{items.length}개</badge></grid-item>",
    "    <grid-item span={1}><title size=\"sm\">요약</title><divider /><spacer size={2} /></grid-item>",
    "  </grid>",
    "</details>",
    '<segmented-control label="정렬" value={tab} onChange={setTab} options={["all", "open"]} />',
    '<select label="선택" value={tab} onChange={setTab} options={["all", "open"]} placeholder="고르세요" />',
    "<switch checked={done[0]} onChange={(v) => setDone((prev) => prev.with(0, v))} label=\"첫 항목\" />",
  ].join("\n"),
  proseOnly: "그냥 **마크다운**만 있는 문서도 위젯입니다.\n\n- 하나\n- 둘\n",
};

const errorOf = (src: string): string => {
  const r = checkWidget(src);
  expect(r.ok, "expected the check to fail").toBe(false);
  return r.ok ? "" : r.error;
};

describe("checkWidget", () => {
  it("accepts well-formed widgets and reports whether they can submit", () => {
    expect(checkWidget(SAMPLES.loan)).toEqual({ ok: true, submits: true });
    expect(checkWidget(SAMPLES.tabsAndList)).toEqual({ ok: true, submits: false });
  });

  it("a source without any component is refused, and the 4-space trap is named", () => {
    const hint = /This widget has no component: a widget needs at least one \(for plain text use contentType 'markdown'\)\. If the components are there but every line is indented 4\+ spaces, the whole source is read as a Markdown code block — unindent it\./;
    expect(errorOf(SAMPLES.proseOnly)).toMatch(hint);
    expect(errorOf("{@state n = 1}\n{@const d = n * 2}")).toMatch(hint);
    // every line indented 4+: the whole widget is a Markdown code block
    expect(errorOf("    {@state count = 0}\n    <box border>\n      <text>{count}</text>\n    </box>")).toMatch(hint);
    // one component anywhere is enough (also inside a block)
    expect(checkWidget("{#if true}\n<divider />\n{/if}").ok).toBe(true);
  });

  it("an empty source is refused", () => {
    expect(errorOf("   \n")).toMatch(/empty/);
    expect(errorOf(undefined as unknown as string)).toMatch(/empty/);
  });

  it("leads with what happened and how to retry, then numbered problems with line:col", () => {
    const err = errorOf("{@state n = 1}\n<row>\n  <sliderr value={n} />\n</row>");
    expect(err.startsWith("Widget source has 1 problem — the canvas was NOT shown. Fix it and call show again (pass the same canvasId if you were refining one).")).toBe(true);
    expect(err).toMatch(/\n1\. line 3:3 — Unknown component <sliderr>\. Did you mean <slider>\?/);
    expect(err).toContain(`Components: ${WIDGET_TAGS.join(", ")}`);
  });

  it("unknown components: HTML and case mistakes get a pointed fix", () => {
    expect(errorOf("<div>hi</div>")).toMatch(/Unknown component <div>\. HTML tags are not supported in a widget\./);
    expect(errorOf("<Slider />")).toMatch(/Did you mean <slider>\?/);
    expect(errorOf("<svg viewBox=\"0 0 1 1\"></svg>")).toMatch(/Unknown component <svg>/);
    expect(errorOf("<row>\n  <text>a<b and c>d</text>\n</row>")).toMatch(/If this "<" was meant as text, write \\< or &lt;/);
    // a tag named like an Object member is just unknown
    expect(errorOf("<constructor />")).toMatch(/Unknown component <constructor>/);
    expect(errorOf("<toString />")).toMatch(/Unknown component <toString>/);
  });

  it("props: unknown, duplicate, missing, wrong literal form", () => {
    expect(errorOf('<slider label="a" value={1} onChange={(v) => v} minn={0} />')).toMatch(/<slider> has no prop "minn"\. Did you mean "min"\? Props: value, onChange, label, min, max, step, suffix, showValue\./);
    expect(errorOf('<box style="color:red">x</box>')).toMatch(/Styling props are not supported/);
    expect(errorOf('<text onClick={() => 1}>x</text>')).toMatch(/This component has no such event/);
    expect(errorOf('<box gap={1} gap={2}>x</box>')).toMatch(/Prop "gap" is given twice on <box>/);
    expect(errorOf("<slider value={1} onChange={(v) => v} />")).toMatch(/<slider> is missing the required prop "label" \(visible label/);
    expect(errorOf('<stat label="a" />')).toMatch(/<stat> is missing the required prop "value"/);
    expect(errorOf('<callout tone="warn">x</callout>')).toMatch(/Prop "tone" of <callout> must be one of info, success, warning, danger/);
    expect(errorOf('<callout tone={"warn"}>x</callout>')).toMatch(/must be one of info, success, warning, danger/);
    expect(errorOf('<box gap="wide">x</box>')).toMatch(/Prop "gap" of <box> must be a number — write it in braces, e\.g\. \{12\}/);
    expect(errorOf('<box border="yes">x</box>')).toMatch(/must be a boolean — write the bare prop name for true, or \{false\}/);
    expect(errorOf('<button onClick="setA(1)">x</button>')).toMatch(/must be a function in braces/);
    expect(errorOf("<button onClick={1}>x</button>")).toMatch(/must be a function, e\.g\./);
    expect(errorOf('<slider label value={1} onChange={(v) => v} />')).toMatch(/Prop "label" of <slider> needs a value/);
    expect(errorOf('<select label="a" value="x" onChange={(v) => v} options="a,b" />')).toMatch(/Prop "options" of <select> must be an expression in braces/);
    expect(errorOf('<select label="a" value="x" onChange={(v) => v} options={{ a: 1 }} />')).toMatch(/must be an array, not an object/);
    expect(errorOf('<chart spec={[1]} />')).toMatch(/Prop "spec" of <chart> must be an object, not an array/);
    expect(errorOf('<chart spec={() => 1} />')).toMatch(/must not be a function/);
    expect(errorOf("<box gap={[1]}>x</box>")).toMatch(/must not be an array/);
    expect(errorOf("<box gap={true}>x</box>")).toMatch(/Prop "gap" of <box> must be a number/);
    // accepted literal forms
    expect(checkWidget('<box gap="2" border padding={1}>x</box>').ok).toBe(true);
    expect(checkWidget('<stat label="n" value={3} />\n<stat label="s" value="x" />').ok).toBe(true);
  });

  it("labels and children", () => {
    expect(errorOf("{@state a = 1}\n<button onClick={() => setA(2)}></button>")).toMatch(/<button> needs a label: put text between its tags, or pass label="…"/);
    expect(checkWidget('{@state a = 1}\n<button onClick={() => setA(2)} label="go" />').ok).toBe(true);
    expect(checkWidget("{@state a = 1}\n<button onClick={() => setA(2)}>{a}</button>").ok).toBe(true);
    expect(errorOf('<row><stat label="a" value={1}>child</stat></row>')).toMatch(/Unexpected closing tag <\/stat>/); // a void tag never opens
    expect(errorOf("<text>hello <badge>new</badge></text>")).toMatch(/<text> takes text and \{expr\} only, but contains <badge>\. Put <badge> next to it/);
    expect(errorOf("<title>{#if true}<badge>x</badge>{/if}</title>")).toMatch(/<title> takes text and \{expr\} only/);
  });

  it("names: undefined identifiers get a near-miss suggestion and the list of built-ins", () => {
    const err = errorOf("{@state months = 1}\n<text>{monts + 1}</text>");
    expect(err).toMatch(/"monts" is not defined\. Did you mean "months"\? Declare it BEFORE this use with \{@state monts = …\}, \{@const monts = …\} or a local const\./);
    expect(err).toMatch(/no Date, no window, no fetch/);
    expect(errorOf("<text>{Date.now()}</text>")).toMatch(/"Date" is not defined/);
    expect(errorOf("{@state a = b}\n{@state b = 1}")).toMatch(/"b" is not defined in a \{@state\} initializer \(it can use only built-ins and states declared before it\)/);
    expect(errorOf("{@const k = 1}\n{@state a = k}")).toMatch(/"k" is not defined in a \{@state\} initializer/);
    expect(checkWidget("{@state a = 1}\n{@state b = a + Math.max(1, 2)}\n<divider />").ok).toBe(true);
    // scopes: each item / index, arrow params, block declarations, nested const
    expect(
      checkWidget(
        "{@state rows = [{ n: 1 }]}\n<col>\n{#each rows as { n }, i}\n{@const sq = n * n}\n<text>{i}: {sq} {rows.map((r, j) => { const d = r.n + j; function f(x) { return x + d } return f(1) }).length}</text>\n{/each}\n</col>",
      ).ok,
    ).toBe(true);
    expect(errorOf("<col>\n{#each [1] as item}\n<text>{item}</text>\n{/each}\n<text>{item}</text>\n</col>")).toMatch(/"item" is not defined/);
    expect(errorOf("<col>\n<text>{inner}</text>\n<box>{@const inner = 1}</box>\n</col>")).toMatch(/"inner" is not defined/);
    // top-level consts are visible everywhere, in any order; typeof tolerates an undeclared name
    expect(checkWidget("<text>{later} {typeof nothing}</text>\n{@const later = 1}").ok).toBe(true);
    // member names and object keys are not identifiers
    expect(checkWidget("{@state o = { key: 1 }}\n<text>{o.key} {o?.missing} {({ other: 2 }).other}</text>").ok).toBe(true);
  });

  it("names: collisions and shadowing built-ins", () => {
    expect(errorOf("{@state Math = 1}")).toMatch(/"Math" \(a state\) shadows a built-in name/);
    expect(errorOf("{@const copy = 1}")).toMatch(/"copy" \(a top-level const\) shadows a built-in name/);
    expect(errorOf("{@state a = 1}\n{@const setA = 2}")).toMatch(/"setA" \(a top-level const\) collides with the setter of state "a"/);
    expect(errorOf("{@state a = 1}\n{@const a = 2}")).toMatch(/collides with a state/);
  });

  it("setters and copy act only in an event", () => {
    expect(errorOf("{@state a = 1}\n<text>{setA(2)}</text>")).toMatch(/setA\(…\) is called while rendering, where it does nothing\. Call it inside an event handler, e\.g\. onClick=\{\(\) => setA\(…\)\}/);
    expect(errorOf("{@state a = 1}\n<button onClick={setA(2)}>x</button>")).toMatch(/setA\(…\) is called while rendering, where it does nothing\. Call it inside an event handler/);
    expect(errorOf("{@const x = copy('a')}")).toMatch(/copy\(…\) is called while rendering/);
    // fine: passed as a value, or called inside a function
    expect(checkWidget("{@state a = 1}\n{@const bump = () => setA(a + 1)}\n<button onClick={bump}>x</button>\n<button onClick={() => { setA(0); copy(String(a)) }}>y</button>").ok).toBe(true);
    expect(checkWidget('{@state a = 1}\n<slider label="a" value={a} onChange={setA} />').ok).toBe(true);
  });

  it("top-level prose is static: an interpolation there is called out", () => {
    expect(errorOf("{@state total = 1}\n\nTotal: {total}")).toMatch(/Top-level text is static Markdown, so \{total…\} would be shown literally\. Wrap the sentence in <text>…<\/text>/);
    expect(checkWidget("{@state total = 1}\n\nBraces like {other} or \\{total} are fine.\n\n<divider />").ok).toBe(true);
    // code is exempt: showing {total} literally is what code is for
    expect(checkWidget("{@state total = 1}\n\nExample payload:\n\n```json\n{ total: 1 }\n```\n\nThe value `{total}` and ``{ total }`` appear below.\n\n<text>{total}</text>").ok).toBe(true);
    expect(errorOf("{@state total = 1}\n\n```json\n{ total: 1 }\n```\n\nAfter the fence: {total}\n\n<divider />")).toMatch(/line 7:18 — Top-level text is static Markdown/);
    expect(errorOf("{@state total = 1}\n\nAn unclosed ` backtick does not hide {total}\n\n<divider />")).toMatch(/Top-level text is static Markdown/);
  });

  it("limits: nodes and state variables", () => {
    const many = "<col>\n" + "<divider />\n".repeat(MAX_WIDGET_NODES) + "</col>";
    // (the source cap bites first for most documents; the node limit is the tighter bound for dense ones)
    const tooMany = checkWidget(many);
    expect(tooMany.ok).toBe(false);
    expect(errorOf(Array.from({ length: MAX_WIDGET_STATES + 1 }, (_, i) => `{@state s${i} = ${i}}`).join("\n"))).toMatch(/Too many state variables \(51; limit 50\)/);
    expect(checkWidget(Array.from({ length: MAX_WIDGET_STATES }, (_, i) => `{@state s${i} = ${i}}`).join("\n") + "\n<divider />").ok).toBe(true);
  });

  it("the node limit names the fix", () => {
    const dense = "<col>" + "<divider/>".repeat(MAX_WIDGET_NODES - 100) + "</col>";
    expect(dense.length).toBeLessThan(20_000);
    expect(checkWidget(dense).ok).toBe(true);
    const over = "<col>" + "<divider/>".repeat(1990) + "{a}".repeat(20) + "</col>";
    expect(over.length).toBeLessThan(20_000);
    expect(errorOf("{@state a = 1}\n" + over)).toMatch(/too many nodes \(limit 2000\)\. Render long lists from data with \{#each\}/);
  });

  it("several problems are reported together, sorted, at most five, without duplicates", () => {
    const src = ["<row>", "  <nope1 />", "  <nope2 />", "  <text>{x1}</text>", "  <text>{x2}</text>", "  <text>{x3}</text>", "  <text>{x4}</text>", "  <text>{x1}</text>", "</row>"].join("\n");
    const err = errorOf(src);
    expect(err).toMatch(/^Widget source has 6 problems — the canvas was NOT shown\. Fix them and call show again/);
    expect(err.match(/^\d\. line/gm)).toHaveLength(5);
    expect(err).toMatch(/1\. line 2:3[^\n]*\n2\. line 3:3[^\n]*\n3\. line 4:9/);
    expect(err).toMatch(/\(\+1 more; fix these first\.\)$/);
  });

  it("parse problems and analysis problems come back in one round", () => {
    const err = errorOf("<row>\n  <text>{a +}</text>\n  <nope />\n</row>");
    expect(err).toMatch(/Syntax error in expression/);
    expect(err).toMatch(/Unknown component <nope>/);
  });

  it("never throws and always terminates: seeded fuzz over truncations and noise", () => {
    let seed = 20261110;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const noise = ["<", ">", "{", "}", "</", "/>", "{#if", "{/if}", "{:else}", "{@state", "`", "```", "\\", '"', "'", "(", ")", "=>", "${", "<box>", "</box>", "\n", "{...x}", "<!--", "[", "{@const a = }"];
    const sources = Object.values(SAMPLES);
    let failed = 0;
    for (let round = 0; round < 300; round++) {
      let src = sources[round % sources.length];
      if (rnd() < 0.5) src = src.slice(0, Math.floor(rnd() * src.length));
      const edits = Math.floor(rnd() * 4);
      for (let k = 0; k < edits; k++) {
        const at = Math.floor(rnd() * (src.length + 1));
        src = src.slice(0, at) + noise[Math.floor(rnd() * noise.length)] + src.slice(at);
      }
      const t0 = Date.now();
      const r = checkWidget(src); // must not throw
      expect(Date.now() - t0, `round ${round}`).toBeLessThan(2000);
      if (!r.ok) {
        failed++;
        expect(r.error, `round ${round}`).toMatch(/^Widget source (has \d+ problems?|is empty) — the canvas was NOT shown\./);
      }
    }
    expect(failed).toBeGreaterThan(100); // the noise really does break documents
  });

  it("worst-case shapes at the size cap stay bounded", () => {
    const cap = 20_000;
    const shapes = [
      "<text>" + "{(".repeat(9990) + "</text>",
      "{@const a = " + "[".repeat(9000) + "}",
      "<box>".repeat(4000),
      "{#if a}".repeat(2800),
      "<a ".repeat(6000),
      "<text>{" + "a => ".repeat(3900) + "1}</text>",
      "<text>{'" + "\\".repeat(19_000),
      "<slider " + "x=1 ".repeat(4900) + "/>",
    ];
    for (const src of shapes) {
      expect(src.length).toBeLessThanOrEqual(cap);
      const t0 = Date.now();
      const r = checkWidget(src);
      expect(Date.now() - t0, src.slice(0, 20)).toBeLessThan(3000);
      expect(r.ok, src.slice(0, 20)).toBe(false);
    }
    // legal but odd: one enormous backtick run is just text
    const t1 = Date.now();
    expect(checkWidget("<text>" + "`".repeat(19_000) + "</text>").ok).toBe(true);
    expect(Date.now() - t1).toBeLessThan(3000);
  });
});

describe("widget component spec", () => {
  it("covers the v1 components", () => {
    expect(WIDGET_TAGS).toEqual([
      "box", "row", "col", "grid", "grid-item", "divider", "spacer",
      "title", "text", "badge", "callout",
      "button", "segmented-control", "checkbox", "switch", "slider", "select", "input", "tabs",
      "stat", "progress", "table", "chart", "details",
      "submit",
    ]);
    // not reachable through Object.prototype
    expect(WIDGET_COMPONENTS["constructor"]).toBe(undefined);
    // every input is labelled: `label` is required, or the children are the label
    for (const tag of ["segmented-control", "slider", "select", "input", "tabs", "progress"]) {
      expect(WIDGET_COMPONENTS[tag].props.label.required, tag).toBe(true);
    }
    for (const tag of ["button", "checkbox", "switch", "submit"]) expect(WIDGET_COMPONENTS[tag].labelFromChildren, tag).toBe(true);
    // there is no way to style or link out
    for (const c of Object.values(WIDGET_COMPONENTS)) {
      for (const name of Object.keys(c.props)) expect(["style", "class", "href", "src", "url"], `${c.tag}.${name}`).not.toContain(name);
    }
  });

  it("generates the manual reference from the table", () => {
    const ref = widgetComponentReference();
    for (const tag of WIDGET_TAGS) expect(ref, tag).toContain(`<${tag}`);
    expect(ref).toMatch(/^Layout\n- <box>…components…<\/box> — /);
    expect(ref).toContain("- <slider /> — A numeric range.");
    expect(ref).toContain("value*: number; onChange*: function (called with the new number); label*: string (visible label (required: every input is labelled))");
    expect(ref).toContain("- <submit>text and {expr}</submit> — The ONLY way back to you");
    expect(ref).toContain("Its text children are its label (or pass `label`).");
    expect(ref).toContain("background: none|surface|subtle|accent|success|warning|danger|info");
    expect(ref.length).toBeLessThan(6000);
  });
});

// Regressions from the adversarial review (2026-11-10): where the checker
// disagreed with the runtime, and inputs that made it slow.
describe("checkWidget: agrees with the runtime", () => {
  const ok = (src: string) => {
    const r = checkWidget(src);
    expect(r.ok ? "" : r.error).toBe("");
  };

  it("a setter may be named in an event prop or used inside a function body — nowhere else", () => {
    // accepted: these all run the setter in an event
    ok('{@state sel = ""}\n{@const pick = (id) => () => setSel(id)}\n<row>{#each ["a", "b"] as id}<button onClick={pick(id)}>{id}</button>{/each}</row>');
    ok("{@state n = 0}\n{@const h = { inc: () => setN(n + 1) }}\n<button onClick={h.inc}>+</button>");
    ok("{@state n = 0}\n<button onClick={n > 3 ? () => setN(0) : () => setN(n + 1)}>+</button>");
    ok('{@state a = 0}\n{@state b = 0}\n<slider label="x" value={a} onChange={a > 3 ? setA : setB} />');
    ok("{@state n = 0}\n<button onClick={() => [1, 2].forEach(setN)}>x</button>\n<button onClick={() => { const s = setN; s(1); copy(String(n)) }}>y</button>");
    // refused: each of these reaches the setter while rendering, where it is a no-op
    const used = /is used while rendering, where it does nothing\. A setter \(and copy\) may appear only in an event prop \(onChange=\{setN\}\) or inside a function body/;
    expect(errorOf("{@state n = 0}\n{@const s = setN}\n<text>{n}</text>")).toMatch(used);
    expect(errorOf("{@state n = 0}\n<text>{[3].map(setN).length}</text>")).toMatch(used);
    expect(errorOf("{@state n = 0}\n<text>{(0, setN)(2)}</text>")).toMatch(used);
    expect(errorOf("{@state n = 0}\n<text>{({ setN }).setN}</text>")).toMatch(used);
    expect(errorOf("<text>{[4].forEach(copy)}</text>")).toMatch(/copy is used while rendering/);
    expect(errorOf('{@state n = 0}\n<stat label="x" value={setN} />')).toMatch(used);
    // a direct call is refused in an event prop too (it would run during the render)
    expect(errorOf('{@state n = 0}\n<slider label="x" value={n} onChange={setN(1)} />')).toMatch(/setN\(…\) is called while rendering/);
    // a local that shadows the name is not the setter
    ok('{@state n = 0}\n<col>{#each ["a"] as copy}<text>{copy}</text>{/each}</col>\n<text>{((setN) => setN)(1)}</text>');
  });

  it("defaults see the parameters and pattern names bound before them", () => {
    ok("{@const area = (w, h = w) => w * h}\n<text>{area(3)}</text>");
    ok("{@const f = ({ a, b = a }) => a + b}\n<text>{f({ a: 1 })}</text>");
    ok("{@const g = ([x, y = x * 2], z = y) => x + y + z}\n<text>{g([1])}</text>");
    ok("{@const rows = [{ a: 1 }]}\n<col>{#each rows as { a, b = a }}<text>{a + b}</text>{/each}</col>");
    expect(errorOf("{@const bad = (w = h, h = 1) => w * h}\n<text>{bad()}</text>")).toMatch(/"h" is not defined/);
  });

  it("a block's declarations are visible only after they are made (functions are hoisted)", () => {
    expect(errorOf("<text>{(() => { const a = b; const b = 1; return a })()}</text>")).toMatch(/"b" is not defined\..* Declare it BEFORE this use/);
    expect(errorOf("<text>{(() => { const c = c; return c })()}</text>")).toMatch(/"c" is not defined/);
    ok("<text>{(() => { const a = 1; const b = a + 1; return b })()}</text>");
    ok("<text>{(() => { return twice(2); function twice(x) { return x * 2 } })()}</text>");
    ok("{@const f = (x) => { if (x) var y = 1; return y }}\n<text>{f(1)}</text>");
    // an outer name still resolves, exactly as at run time
    ok("{@const b = 5}\n<text>{(() => { const a = b; return a })()}</text>");
    // a block's names end with the block
    expect(errorOf("<text>{(() => { { const inner = 1 } return inner })()}</text>")).toMatch(/"inner" is not defined/);
    // the report says "declared later", not "did you mean <the same name>"
    const later = errorOf("<text>{(() => { const a = b; const b = 1; return a })()}</text>");
    expect(later).toMatch(/"b" is not defined\. It is declared later in this block: move the declaration above this use\./);
    expect(later).not.toMatch(/Did you mean "b"/);
  });

  it("an expression the interpreter could not evaluate without overflowing the stack is refused up front", () => {
    const terms = (n: number) => Array.from({ length: n }, () => '"a"').join(" + ");
    expect(errorOf(`<text>{${terms(1700)}}</text>`)).toMatch(/too many chained operators \(limit 200\); split the expression into \{@const\} steps/);
    expect(errorOf(`{@const a = {}}\n<text>{a${"?.b".repeat(2000)}}</text>`)).toMatch(/too many chained member accesses or calls \(limit 200\)/);
    expect(errorOf(`{@const f = () => f}\n<text>{f${"()".repeat(2000)} ? 1 : 0}</text>`)).toMatch(/too many chained member accesses or calls/);
    ok(`<text>{${terms(150)}}</text>`);
    // chains inside nested brackets add up: the AST depth has its own cap
    const nested = "(".repeat(40) + "1" + " + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1)".repeat(40);
    expect(errorOf(`<text>{${nested}}</text>`)).toMatch(/expression is too deeply nested \(limit 300 levels\)/);
  });

  it("a prop whose value does not parse is reported once, not also as missing", () => {
    const err = errorOf("{@state n = 0}\n<button onClick={() => { if (n) }}>x</button>\n<stat label=\"a\" value={} />");
    expect(err).toMatch(/^Widget source has 2 problems/);
    expect(err).toMatch(/Prop "onClick" of <button>: Syntax error in expression/);
    expect(err).toMatch(/Prop "value" of <stat> has an empty \{\}/);
    expect(err).not.toMatch(/missing the required prop/);
  });

  it("stays fast on inputs built to make it slow (20,000 chars)", () => {
    const timed = (src: string) => {
      expect(src.length).toBeLessThanOrEqual(20_000);
      const t0 = performance.now();
      const r = checkWidget(src);
      return { ms: performance.now() - t0, r };
    };
    // ~2,000 undeclared names against ~2,000 parameters: the suggestion used to be computed for every one
    const b36 = (i: number, p: string) => p + i.toString(36).padStart(3, "0");
    const names = Array.from({ length: 1990 }, (_, i) => b36(i, "a"));
    const refs = Array.from({ length: 1990 }, (_, i) => b36(i, "b"));
    const flood = timed(`<text>{((${names.join(",")}) => [${refs.join(",")}])()}</text>`);
    expect(flood.ms).toBeLessThan(400);
    expect(flood.r.ok).toBe(false);
    // ...and the reported ones still carry their suggestion
    expect(flood.r.ok ? "" : flood.r.error).toMatch(/1\. line 1:\d+ — "b000" is not defined\. Did you mean "a000"\?/);
    // a `{` inside a `//` comment of an unclosed expression: every one used to re-parse the tail
    const unit = "1,//{\n";
    const body = unit.repeat(Math.floor(8000 / unit.length));
    const comment = timed("<col>" + "x".repeat(20_000 - 6 - body.length) + "{" + body);
    expect(comment.ms).toBeLessThan(400);
    expect(comment.r.ok ? "" : comment.r.error).toMatch(/expression is never finished|"\{" is never closed/);
    // long backtick runs in prose that mentions a state name
    const ticks = timed("{@state n = 1}\n" + "` {n} ".repeat(3000) + "\n<divider />");
    expect(ticks.ms).toBeLessThan(400);
  });
});
