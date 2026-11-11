import { describe, expect, it } from "vitest";
import { MAX_WIDGET_NODES, MAX_WIDGET_STATES, checkWidget } from "../src/shared/widget/check.js";
import { NOOP_HANDLER } from "../src/shared/widget/interp.js";
import { WIDGET_ICON_NAMES } from "../src/shared/widget/icons.js";
import { MAX_SEND_CHARS, WIDGET_COMPONENTS, WIDGET_TAGS, normalizeProps, widgetComponentReference } from "../src/shared/widget/spec.js";
import { svgReference } from "../src/shared/widget/svg.js";
import { MAX_URL_CHARS, conversationImageRef, safeLinkUrl } from "../src/shared/widget/style.js";

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
    const hint = /This source has no component: inline UI needs at least one \(plain text is just Markdown\)\. If the components are there but every line is indented 4\+ spaces, the whole source is read as a Markdown code block — unindent it\./;
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
    expect(err.startsWith("The inline UI source has 1 problem:\n")).toBe(true);
    expect(err).toMatch(/\n1\. line 3:3 — Unknown component <sliderr>\. Did you mean <slider>\?/);
    expect(err).toContain(`Components: ${WIDGET_TAGS.join(", ")}`);
  });

  it("unknown components: HTML and case mistakes get a pointed fix", () => {
    expect(errorOf("<div>hi</div>")).toMatch(/Unknown component <div>\. HTML tags are not supported in inline UI\./);
    expect(errorOf("<Slider />")).toMatch(/Did you mean <slider>\?/);
    // <svg> is a component now (tests/widget-svg.test.ts); an SVG element outside one says where it belongs
    expect(errorOf("<span>hi</span>")).toMatch(/Unknown component <span>/);
    expect(errorOf('<circle r="3" />')).toMatch(/<circle> is an SVG element: it exists only inside <svg viewBox="…">…<\/svg>\. Wrap the drawing in an <svg>\./);
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
    expect(errorOf("<text>hello <badge>new</badge></text>")).toMatch(/<text> takes text, \{expr\} and <link> only, but contains <badge>\. Put <badge> next to it/);
    expect(errorOf("<title>{#if true}<badge>x</badge>{/if}</title>")).toMatch(/<title> takes text, \{expr\} and <link> only/);
    expect(errorOf("{@state a = 1}\n<checkbox checked={a} onChange={setA}>on <badge>x</badge></checkbox>")).toMatch(/<checkbox> takes text and \{expr\} only, but contains <badge>/);
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
    expect(err).toMatch(/^The inline UI source has 6 problems:\n/);
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
        expect(r.error, `round ${round}`).toMatch(/^The inline UI source (has \d+ problems?:|is empty\.)/);
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
      "title", "text", "badge", "link", "callout",
      "button", "segmented-control", "checkbox", "switch", "slider", "select", "input", "tabs",
      "stat", "progress", "table", "chart", "details",
      "image", "icon", "svg",
      "submit",
    ]);
    // not reachable through Object.prototype
    expect(WIDGET_COMPONENTS["constructor"]).toBe(undefined);
    // every input is labelled: `label` is required, or the children are the label
    for (const tag of ["segmented-control", "slider", "select", "input", "tabs", "progress"]) {
      expect(WIDGET_COMPONENTS[tag].props.label.required, tag).toBe(true);
    }
    for (const tag of ["button", "checkbox", "switch", "submit"]) expect(WIDGET_COMPONENTS[tag].labelFromChildren, tag).toBe(true);
    // there is no way to style; a URL is accepted only through the two validated prop types
    for (const c of Object.values(WIDGET_COMPONENTS)) {
      for (const [name, p] of Object.entries(c.props)) {
        expect(["style", "class", "url"], `${c.tag}.${name}`).not.toContain(name);
        if (name === "href") expect(p.type.k, `${c.tag}.href`).toBe("url");
        if (name === "src") expect(p.type.k, `${c.tag}.src`).toBe("image");
        if (p.type.k === "url" || p.type.k === "image" || p.type.k === "send") expect(`${c.tag}.${name}`).toMatch(/^(button\.(href|send)|link\.href|image\.src)$/);
      }
    }
  });

  it("generates the manual reference from the table", () => {
    const ref = widgetComponentReference();
    for (const tag of WIDGET_TAGS) expect(ref, tag).toContain(`<${tag}`);
    // A legend first: the page it rides has a size cap, so what repeats is said once.
    const [legend, types, first, second] = ref.split("\n");
    expect(legend).toContain("`*` = required; a bool prop written bare is true.");
    expect(legend).toContain("`text` = text, {expr}, {#if}, {#each}, no tags — on button, checkbox, switch and submit that text is the label, or pass `label`.");
    expect(legend).toContain("Every input needs `label`; its onChange gets the new value.");
    expect(types).toContain("fn: {() => …} or a setter name; any: string|number|boolean; options: [\"A\",\"B\"] or [{label, value}]");
    expect(types).toContain("align: start|center|end|stretch|baseline; justify: start|center|end|between|around; color: default|muted|accent|success|warning|danger|info; tone: default|accent|success|warning|danger|info");
    expect([first, second]).toEqual(["Layout", "- <box>…</box> — A container; with `border`/`background` it reads as a card."]);
    // A prop whose type has its own name is just the name; a self-evident component has no description.
    expect(ref).toContain("\n- <row>…</row>\n  gap: 0–8; align; justify; wrap: bool\n");
    expect(ref).toContain("\n- <slider />\n  value*: num; onChange*: fn; label*: str; min: num (default 0); max: num (default 100); step: num (default 1); suffix: str (unit after the value); showValue: bool (default true)\n");
    expect(ref).toContain("- <submit>text</submit> — Sends `values` to you as STRUCTURED data in the user's next message.");
    expect(ref).toContain("- <button>text</button> — Does ONE thing, shown to the user before they press: give exactly one of onClick | send | href.");
    expect(ref).toContain("send: text (posted as the user's NEXT chat message (1–2000 chars)); href: http(s) URL (opens in a new tab)");
    expect(ref).toContain("- <link>text</link> — Opens in a new tab. Works on its own and inside <text>, <title>, <badge> and <callout>.\n  href*: http(s) URL\n");
    expect(ref).toContain("- <image /> — An image of THIS conversation only.");
    expect(ref).toContain("src*: conversation image URL (/api/conversations/<conversationId>/images/<imageId>); alt*: str (what it shows)");
    expect(ref).toContain("background: none|surface|subtle|accent|success|warning|danger|info");
    expect(ref).toContain('onChange*: fn (called with the text; for type="number" with a number, or "" when empty)');
    // The three additions: a sortable table, icons (the names once, at the end), and an <svg>.
    expect(ref).toContain("columns*: [{key, label?, align?, sortable?}] (align: start|center|end; sortable: false opts a column out)");
    expect(ref).toContain("sortable: bool (headers sort on click — the viewer's own view; your rows and state are untouched)");
    expect(ref).toContain("- <icon /> — One of the app's line icons.\n  name*: icon; size: sm|md|lg|xl (14/18/24/32 px, default md); color; label: str (accessible name; without it the icon is decoration)");
    expect(ref).toContain("tone: info|success|warning|danger; title: str; icon\n");
    expect(ref).toContain("icon (drawn before the label)");
    expect(ref.endsWith(`\nIcons: ${WIDGET_ICON_NAMES.join(" ")}`)).toBe(true);
    expect(ref).toContain("- <svg>SVG elements</svg> — A drawing that follows state (a gauge, a diagram).");
    expect(ref).toContain(svgReference());
    // A chart has two forms, and its `series` is not spelled like a table's columns.
    expect(ref).toContain("- <chart /> — Give `data` (+ type, xKey, series) for the common charts, or a whole Vega-Lite `spec` — exactly one of the two.");
    expect(ref).toContain('type: bar|line|area|pie|donut (default bar); xKey: str (category key; default the first); series: ["key"] | [{key, label}] (numeric keys; default all)');
    // The manual page it rides is capped (tests/system-manual.test.ts): keep the reference terse.
    expect(ref.length).toBeLessThan(6800);
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
    expect(err).toMatch(/^The inline UI source has 2 problems/);
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

// 2026-11-11 (user decision): a widget may send a chat message, open a link and
// show an image of its conversation — each as a DECLARED prop whose value is
// fixed at render time, so the renderer can show it before it happens.
describe("widget effects are declared props: button send / href, <link>, <image>", () => {
  const ok = (src: string) => {
    const r = checkWidget(src);
    expect(r.ok ? "" : r.error).toBe("");
  };
  const IMG = "/api/conversations/c_1/images/img-2.png";

  it("a send text may never be a chat command (a leading slash)", () => {
    // A `send` arrives exactly like a typed message, and a typed "/…" runs a
    // command (/compact, /routine, /todo …) — a widget button must not.
    for (const text of ["/compact", "  /routine add x", "\n/todo done 1", "\u0000/compact", "\u007f /new"]) {
      // An expression literal, so the escapes are real characters (an attribute string takes them literally).
      expect(errorOf(`<button send={${JSON.stringify(text)}}>x</button>`), JSON.stringify(text)).toMatch(/must not start with "\/"/);
    }
    ok('<button send="1/2 지점부터 다시 설명해 줘">x</button>');
    // A computed text is judged when it renders: dropped and reported, never sent.
    const computed = normalizeProps("button", { send: "/compact" });
    expect(computed.props).not.toHaveProperty("send");
    expect(computed.errors.join(" ")).toMatch(/must not start with "\/"/);
    expect(normalizeProps("button", { send: "\u0001/compact" }).props).not.toHaveProperty("send");
    expect(normalizeProps("button", { send: " 다음 단계로 " }).props.send).toBe("다음 단계로");
  });

  it("a button does exactly one thing: onClick | send | href", () => {
    ok('{@state n = 0}\n<button onClick={() => setN(n + 1)}>+1</button>\n<button send="요약해 줘">요약</button>\n<button href="https://example.com/docs">문서</button>');
    ok('{@state picked = "B"}\n<button send={`정답은 ${picked}`}>제출</button>\n<button href={`https://example.com/q?a=${picked}`} label="열기" />');
    const none = errorOf("<button>nothing</button>");
    expect(none).toMatch(
      /<button> needs EXACTLY ONE of onClick \| send \| href — onClick \(runs a function: changes state locally, sends nothing to you\); send \(the text becomes the user's NEXT chat message when pressed \(1–2000 chars; may be computed from state\)\); href \(opens this absolute http\(s\) URL in a new tab\)\. It has none\./,
    );
    expect(errorOf('{@state n = 0}\n<button onClick={() => setN(1)} send="go">x</button>')).toMatch(/It has onClick and send: keep one \(a second one needs its own <button>\)\./);
    expect(errorOf('<button send="a" href="https://example.com">x</button>')).toMatch(/It has send and href: keep one/);
    expect(errorOf('{@state n = 0}\n<button onClick={() => setN(1)} send="a" href="https://example.com">x</button>')).toMatch(/It has onClick and send and href: keep one/);
    // a prop that failed to parse still counts as written: one problem, not two
    const broken = errorOf("<button send={`a${}>x</button>");
    expect(broken).not.toMatch(/EXACTLY ONE/);
  });

  it("send / href / src are ordinary render-time values, not handlers", () => {
    // a setter cannot hide in them (they are evaluated while rendering)
    expect(errorOf("{@state n = 0}\n<button send={setN}>x</button>")).toMatch(/setN is used while rendering/);
    expect(errorOf("{@state n = 0}\n<button href={setN(1)}>x</button>")).toMatch(/setN\(…\) is called while rendering/);
    expect(errorOf(`{@state n = 0}\n<image src={copy("x")} alt="a" />`)).toMatch(/copy\(…\) is called while rendering/);
    expect(errorOf('<button send={() => "hi"}>x</button>')).toMatch(/Prop "send" of <button> must be a string, not a function/);
    expect(errorOf("<button href={[1]}>x</button>")).toMatch(/Prop "href" of <button> must be a string/);
    expect(errorOf("<button send={5}>x</button>")).toMatch(/Prop "send" of <button> must be a string/);
    expect(errorOf("<button send>x</button>")).toMatch(/Prop "send" of <button> needs a value/);
  });

  it("a literal that can never be valid is refused before anything is shown", () => {
    expect(errorOf('<button send="   ">x</button>')).toMatch(/Prop "send" of <button> is empty — nothing would be sent/);
    expect(errorOf(`<button send="${"가".repeat(MAX_SEND_CHARS + 1)}">x</button>`)).toMatch(/Prop "send" of <button> is too long \(limit 2000 chars\)/);
    ok(`<button send="${"가".repeat(MAX_SEND_CHARS)}">x</button>`);
    const url = /must be an absolute http\(s\) URL, e\.g\. "https:\/\/example\.com\/page" \(no javascript:, data:, relative or \/\/host URLs\)/;
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x", "/docs", "docs/page", "//evil.example", "example.com", "ftp://example.com", "https://user:pw@example.com"]) {
      expect(errorOf(`<button href="${bad}">x</button>`), bad).toMatch(url);
      expect(errorOf(`<link href={"${bad}"}>x</link>`), bad).toMatch(url);
    }
    expect(errorOf("<link href={`javascript:alert(1)`}>x</link>")).toMatch(url);
    expect(errorOf('<link href="">x</link>')).toMatch(/Prop "href" of <link> is empty — there is no link to open/);
    const img = /Prop "src" of <image> must be an image of THIS conversation, "\/api\/conversations\/<conversationId>\/images\/<imageId>" \(the URL a file-output tool returned\); remote, data: and other URLs are not allowed/;
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "//cdn.example/a.png", "/api/files/1", "a.png", IMG + "?x=1", IMG + "#f", "/api/conversations/../images/x", "/api/conversations/c/images/a%2fb"]) {
      expect(errorOf(`<image src="${bad}" alt="a" />`), bad).toMatch(img);
    }
    ok(`<image src="${IMG}" alt="차트 캡처" width={320} maxHeight={200} radius="md" fit="contain" />`);
    // a computed value is left to the renderer
    ok(`{@state id = "x"}\n<image src={\`/api/conversations/c_1/images/\${id}\`} alt="a" />\n<link href={"https://example.com/" + id}>go</link>`);
  });

  it("<link>: required href, text between the tags, allowed inside running text only", () => {
    ok('<link href="https://example.com">문서 보기</link>');
    ok('{@state n = 1}\n<text>자세한 내용은 <link href="https://example.com/a">여기</link>와 <link href={`https://example.com/${n}`}>{n}번</link>을 보세요.</text>');
    ok('<title>제목 <link href="https://example.com">↗</link></title>\n<badge tone="info"><link href="https://example.com">new</link></badge>\n<callout tone="info">참고: <link href="https://example.com">링크</link></callout>');
    ok('<text>{#if true}<link href="https://example.com">a</link>{/if}</text>');
    expect(errorOf("<link>문서</link>")).toMatch(/<link> is missing the required prop "href" \(absolute http\(s\) URL\)/);
    expect(errorOf('<link href="https://example.com"></link>')).toMatch(/<link> needs its text between the tags: <link …>text<\/link>\./);
    expect(errorOf('<link href="https://example.com" />')).toMatch(/<link> needs its text between the tags/);
    // nothing nests inside a link, and a link does not go inside a control's label
    expect(errorOf('<link href="https://example.com">a <badge>b</badge></link>')).toMatch(/<link> takes text and \{expr\} only, but contains <badge>/);
    expect(errorOf('<link href="https://example.com">a <link href="https://example.org">b</link></link>')).toMatch(/<link> takes text and \{expr\} only, but contains <link>/);
    expect(errorOf('<button send="x">go <link href="https://example.com">a</link></button>')).toMatch(/<button> takes text and \{expr\} only, but contains <link>/);
    expect(errorOf('<submit values={{}}>go <link href="https://example.com">a</link></submit>')).toMatch(/<submit> takes text and \{expr\} only, but contains <link>/);
    expect(errorOf('<link href="https://example.com" onClick={() => 1}>a</link>')).toMatch(/<link> has no prop "onClick"/);
  });

  it("<image>: src and alt are required, and it takes no children", () => {
    expect(errorOf('<image alt="a" />')).toMatch(/<image> is missing the required prop "src" \(\/api\/conversations\/<conversationId>\/images\/<imageId>\)/);
    expect(errorOf(`<image src="${IMG}" />`)).toMatch(/<image> is missing the required prop "alt" \(what the image shows \(required\)\)/);
    expect(errorOf(`<row><image src="${IMG}" alt="a">caption</image></row>`)).toMatch(/Unexpected closing tag <\/image>/);
    expect(errorOf(`<image src="${IMG}" alt="a" fit="fill" />`)).toMatch(/Prop "fit" of <image> must be one of cover, contain/);
    expect(errorOf(`<image src="${IMG}" alt="a" href="https://example.com" />`)).toMatch(/<image> has no prop "href"/);
  });

  it("safeLinkUrl: only a clean absolute http(s) URL, returned normalized", () => {
    expect(safeLinkUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeLinkUrl("  HTTP://Example.COM  ")).toBe("http://example.com/");
    expect(safeLinkUrl("https://example.com:8443/경로?q=한글")).toBe("https://example.com:8443/%EA%B2%BD%EB%A1%9C?q=%ED%95%9C%EA%B8%80");
    expect(safeLinkUrl("https://192.168.0.10/x")).toBe("https://192.168.0.10/x");
    // an internationalized host comes back as punycode, so a look-alike is visible in the preview
    expect(safeLinkUrl("https://пример.рф/")).toBe("https://xn--e1afmkfd.xn--p1ai/");
    expect(safeLinkUrl("https://аpple.com/")).toMatch(/^https:\/\/xn--/);
    const refused: unknown[] = [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "JaVa\tScRiPt:alert(1)", // parsers drop tabs and newlines inside a URL
      "java\nscript:alert(1)",
      "\u0001javascript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://example.com/x",
      "ht\ttps://example.com",
      "https://exa\nmple.com",
      "https://example.com/a b",
      "https://example.com/\u2028x",
      "https://example.com/\u200bx",
      "/relative",
      "relative/path",
      "?q=1",
      "#frag",
      "//example.com/x",
      "\\\\example.com\\x",
      "https:\\\\example.com",
      "https:/example.com",
      "https:example.com",
      "https://",
      "https:///x",
      "https://user:pass@example.com/",
      "https://user@example.com/",
      "https://example.com\\@evil.example/",
      "https://" + "a".repeat(MAX_URL_CHARS) + ".com/",
      "https://example.com/" + "a".repeat(MAX_URL_CHARS),
      "",
      "   ",
      null,
      undefined,
      42,
      ["https://example.com"],
      { href: "https://example.com" },
      { toString: () => "https://example.com" },
    ];
    for (const v of refused) expect(safeLinkUrl(v), JSON.stringify(v)).toBe(null);
    expect(safeLinkUrl("https://example.com/" + "a".repeat(MAX_URL_CHARS - 20))).not.toBe(null);
  });

  it("conversationImageRef: the conversation-image path and nothing else", () => {
    expect(conversationImageRef(IMG)).toEqual({ conversationId: "c_1", imageId: "img-2.png" });
    expect(conversationImageRef("/api/conversations/0b1c2d3e-4f5a/images/a.b_c-d")).toEqual({ conversationId: "0b1c2d3e-4f5a", imageId: "a.b_c-d" });
    const refused: unknown[] = [
      "https://example.com" + IMG,
      "//example.com" + IMG,
      "http://localhost" + IMG,
      "data:image/png;base64,AAAA",
      IMG + "?download=1",
      IMG + "#x",
      IMG + "/",
      IMG + "/extra",
      " " + IMG,
      IMG + "\n",
      "/api/conversations/../images/x",
      "/api/conversations/c/images/..",
      "/api/conversations/./images/x",
      "/api/conversations/c/images/...",
      "/api/conversations/c/../../secrets/images/x",
      "/api/conversations/c/images/a%2fb",
      "/api/conversations/c/images/a%2e%2e",
      "/api/conversations/c/images/a/b",
      "/api/conversations/c/images/a\\b",
      "/api/conversations//images/x",
      "/api/conversations/c/images/",
      "/API/conversations/c/images/x",
      "api/conversations/c/images/x",
      "/api/conversations/c/files/x",
      "/api/conversations/c/images/한글",
      "/api/conversations/c/images/" + "a".repeat(400),
      "",
      null,
      undefined,
      7,
      [IMG],
    ];
    for (const v of refused) expect(conversationImageRef(v), JSON.stringify(v)).toBe(null);
  });

  it("at render time: a valid value comes back normalized; an empty or invalid one is dropped and reported", () => {
    // button: the declared effect, or nothing plus the reason (the renderer draws it disabled)
    expect({ ...normalizeProps("button", { send: "  정답은 B\n둘째 줄\u0000  ", label: "제출" }).props }).toEqual({ send: "정답은 B\n둘째 줄", label: "제출" });
    expect({ ...normalizeProps("button", { send: 42 }).props }).toEqual({ send: "42" });
    expect({ ...normalizeProps("button", { href: " HTTPS://Example.com/a " }).props }).toEqual({ href: "https://example.com/a" });
    for (const [raw, reason] of [
      [{ send: "" }, "send: is empty — nothing would be sent"],
      [{ send: "   " }, "send: is empty — nothing would be sent"],
      [{ send: null }, "send: is empty — nothing would be sent"],
      [{ send: undefined }, "send: is empty — nothing would be sent"],
      [{ send: "x".repeat(MAX_SEND_CHARS + 1) }, "send: is too long (limit 2000 chars)"],
      [{ send: ["a"] }, "send: must be a string"],
      [{ send: { toString: () => "x" } }, "send: must be a string"],
      [{ href: null }, "href: is empty — there is no link to open"],
      [{ href: "" }, "href: is empty — there is no link to open"],
      [{ href: 5 }, "href: must be a string"],
    ] as [Record<string, unknown>, string][]) {
      const r = normalizeProps("button", raw);
      expect({ ...r.props }, reason).toEqual({});
      expect(r.errors, reason).toEqual([reason]);
    }
    const js = normalizeProps("button", { href: "javascript:alert(1)", label: "x" });
    expect({ ...js.props }).toEqual({ label: "x" });
    expect(js.errors[0]).toMatch(/^href: must be an absolute http\(s\) URL/);
    // an onClick that is written but empty stays a button that does nothing (as before)
    expect(normalizeProps("button", { onClick: null }).props.onClick).toBe(NOOP_HANDLER);
    expect("onClick" in normalizeProps("button", { send: "hi" }).props).toBe(false);
    // link / image: required, and never defaulted
    expect({ ...normalizeProps("link", { href: "https://example.com" }).props }).toEqual({ href: "https://example.com/" });
    const badLink = normalizeProps("link", { href: "/internal" });
    expect("href" in badLink.props).toBe(false);
    expect(badLink.errors[0]).toMatch(/^href: must be an absolute http\(s\) URL/);
    expect({ ...normalizeProps("image", { src: IMG, alt: null, width: 5000, maxHeight: 1, radius: "xl", fit: "cover" }).props }).toEqual({ src: IMG, alt: "", width: 800, maxHeight: 40, fit: "cover" });
    for (const src of ["https://example.com/a.png", "data:image/png;base64,AAAA", IMG + "?x", null, 5]) {
      const r = normalizeProps("image", { src, alt: "a" });
      expect("src" in r.props, String(src)).toBe(false);
      expect(r.errors.length, String(src)).toBe(1);
    }
    // nothing written, nothing reported
    expect(normalizeProps("button", { label: "x" })).toEqual({ props: Object.assign(Object.create(null), { label: "x" }), errors: [] });
  });
});
