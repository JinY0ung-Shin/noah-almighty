// lib/widgetView.ts — inline UI evaluated into plain nodes for the React
// components: inline Markdown as styled runs (never HTML), one error node per
// failing node / over-budget block, keys stable across renders, and finished
// blocks kept (not evaluated again) while an answer grows.
import { describe, expect, it } from "vitest";

import {
  answerNodes,
  buildAnswerItems,
  cellText,
  collectWidgetProblems,
  createAnswerViewCache,
  parseInlineMarkdown,
  type AnswerItem,
  type ElVNode,
  type VNode,
} from "../src/client/src/lib/widgetView.js";
import { createRootEnv, createRuntime, parseAnswer, parseWidget, restoreState, type AnswerDoc, type Env, type Runtime, type WidgetDoc } from "../src/shared/widget/index.js";

/** A strictly parsed source as the document the evaluator takes. */
function asAnswer(doc: WidgetDoc): AnswerDoc {
  return { ...doc, end: doc.src.length, pending: null, failed: false };
}

/** The evaluated UI nodes of a document (its top-level Markdown runs are not nodes). */
function buildWidgetView(doc: WidgetDoc, root: Env, rt: Runtime, options: { conversationId?: string | null; svgNs?: string } = {}): VNode[] {
  return answerNodes(buildAnswerItems(asAnswer(doc), root, rt, {}, createAnswerViewCache(), options));
}

function evaluate(source: string, override: Record<string, unknown> = {}): VNode[] {
  const doc = parseWidget(source);
  expect(doc.problems).toEqual([]);
  const values = { ...restoreState(doc, null).values, ...override };
  const rt = createRuntime();
  const host = { get: (name: string) => values[name], set: () => {}, copy: () => {} };
  return buildWidgetView(doc, createRootEnv(doc, values, rt, host), rt);
}

function el(nodes: VNode[], tag: string): ElVNode {
  const found = nodes.find((n): n is ElVNode => n.k === "el" && n.tag === tag);
  if (!found) throw new Error(`no <${tag}> in ${JSON.stringify(nodes.map((n) => n.k))}`);
  return found;
}

describe("parseInlineMarkdown", () => {
  it("styles bold, italic, code and strike-through", () => {
    expect(parseInlineMarkdown("a **b** *c* _d_ `e` ~~f~~ g")).toEqual([
      { text: "a " },
      { text: "b", b: true },
      { text: " " },
      { text: "c", i: true },
      { text: " " },
      { text: "d", i: true },
      { text: " " },
      { text: "e", code: true },
      { text: " " },
      { text: "f", s: true },
      { text: " g" },
    ]);
  });

  it("nests emphasis and keeps code literal", () => {
    expect(parseInlineMarkdown("**굵고 *기울인* 글**")).toEqual([
      { text: "굵고 ", b: true },
      { text: "기울인", b: true, i: true },
      { text: " 글", b: true },
    ]);
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }]);
  });

  it("leaves lone markers, arithmetic and snake_case alone", () => {
    expect(parseInlineMarkdown("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]);
    expect(parseInlineMarkdown("snake_case_name")).toEqual([{ text: "snake_case_name" }]);
    expect(parseInlineMarkdown("별표 하나 * 그리고 **열린 채")).toEqual([{ text: "별표 하나 * 그리고 **열린 채" }]);
    expect(parseInlineMarkdown("a ~ b ~ c")).toEqual([{ text: "a ~ b ~ c" }]);
  });

  it("honours backslash escapes and never produces markup", () => {
    expect(parseInlineMarkdown("\\*별표\\* \\{중괄호\\} \\<꺾쇠\\>")).toEqual([{ text: "*별표* {중괄호} <꺾쇠>" }]);
    expect(parseInlineMarkdown("<b>x</b> <a href='https://example.com'>링크</a>")).toEqual([{ text: "<b>x</b> <a href='https://example.com'>링크</a>" }]);
  });

  it("links only to absolute http(s) addresses, and shows anything else as written", () => {
    expect(parseInlineMarkdown("자세한 내용은 [**사내** 문서](https://wiki.example.com/a?b=1)를 보세요")).toEqual([
      { text: "자세한 내용은 " },
      { text: "사내", b: true, href: "https://wiki.example.com/a?b=1" },
      { text: " 문서", href: "https://wiki.example.com/a?b=1" },
      { text: "를 보세요" },
    ]);
    // The href is the NORMALIZED one (what the tooltip shows is what opens).
    expect(parseInlineMarkdown("[x](HTTPS://Example.com)")).toEqual([{ text: "x", href: "https://example.com/" }]);
    for (const bad of [
      "[x](javascript:alert(1))",
      "[x](data:text/html,hi)",
      "[x](/api/me)",
      "[x](//evil.example/a)",
      "[x](mailto:a@b.c)",
      "[x](https://user:pw@example.com/)",
      "[x]( java\tscript:alert(1))",
    ]) {
      expect(parseInlineMarkdown(bad).every((seg) => seg.href === undefined), bad).toBe(true);
      expect(parseInlineMarkdown(bad).map((seg) => seg.text).join(""), bad).toContain("[x](");
    }
    // Code is literal, and a link never nests in a link.
    expect(parseInlineMarkdown("`[x](https://a.example)`")).toEqual([{ text: "[x](https://a.example)", code: true }]);
  });
});

describe("entities in a component's text", () => {
  it("shows the few entities the advice tells an avatar to write as the characters they are", () => {
    expect(parseInlineMarkdown("a &lt; b &amp; c \\< d &gt; e &quot;f&quot; &amp;lt;")).toEqual([{ text: 'a < b & c < d > e "f" &lt;' }]);
    // Inside a code span the text is literal.
    expect(parseInlineMarkdown("`&lt;`")).toEqual([{ text: "&lt;", code: true }]);
  });
});

describe("buildAnswerItems", () => {
  const source = `앞 문단 **굵게**

{@state n = 2}
<stat label="수" value={n} />

가운데 문단

<text>끝 {n * 2}</text>
`;
  const brief = (items: AnswerItem[]) => items.map((item) => (item.kind === "md" ? `md:${item.text.trim()}` : `ui:${item.nodes.map((n) => (n.k === "el" ? n.tag : n.k)).join("+")}`));

  it("hands the answer's Markdown back as source, between the evaluated UI blocks, with their offsets", () => {
    const doc = parseAnswer(source);
    const rt = createRuntime();
    const values = { ...restoreState(doc, null).values };
    const items = buildAnswerItems(doc, createRootEnv(doc, values, rt, { get: (name) => values[name], set: () => {}, copy: () => {} }), rt, values, createAnswerViewCache());
    expect(brief(items)).toEqual(["md:앞 문단 **굵게**", "ui:stat", "md:가운데 문단", "ui:text"]);
    for (const item of items) expect(source.slice(item.s, item.e)).toContain(item.kind === "md" ? item.text : "<");
    expect(items.map((item) => item.s)).toEqual([...items.map((item) => item.s)].sort((a, b) => a - b));
  });

  it("does not evaluate a finished block again while the answer grows — until a value or a declaration changes", () => {
    const rt = createRuntime();
    const cache = createAnswerViewCache();
    let values: Record<string, unknown> = { n: 2 };
    const run = (text: string, streaming: boolean) => {
      const doc = parseAnswer(text, { streaming });
      return buildAnswerItems(doc, createRootEnv(doc, values, rt, { get: (name) => values[name], set: () => {}, copy: () => {} }), rt, values, cache);
    };
    const cut = source.indexOf("가운데");
    const first = run(source.slice(0, cut), true);
    const second = run(source, true);
    // The stat block is the SAME nodes: a chart above the text being written is not redrawn per token.
    expect(second[1].kind === "ui" && first[1].kind === "ui" && second[1].nodes === first[1].nodes).toBe(true);
    // A state change evaluates everything again, with the new value.
    values = { n: 5 };
    const third = run(source, false);
    expect(third[1].kind === "ui" && second[1].kind === "ui" && third[1].nodes !== second[1].nodes).toBe(true);
    const last = third[3];
    expect(last.kind === "ui" ? (last.nodes[0] as ElVNode).segs.map((seg) => seg.text).join("") : "").toBe("끝 10");
    // A declaration that arrives LATER invalidates what was drawn before it (a block may read it).
    const later = run(source + "{@const extra = 1}\n", false);
    expect(later[1].kind === "ui" && third[1].kind === "ui" && later[1].nodes !== third[1].nodes).toBe(true);
  });

  it("an element still open at the end of a streaming answer is evaluated every time, with the children it has", () => {
    const rt = createRuntime();
    const cache = createAnswerViewCache();
    const values = {};
    const run = (text: string) => {
      const doc = parseAnswer(text, { streaming: true });
      return buildAnswerItems(doc, createRootEnv(doc, values, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt, values, cache);
    };
    const one = run("<box>\n  <text>하나</text>\n");
    const two = run("<box>\n  <text>하나</text>\n  <text>둘</text>\n");
    const boxOf = (items: AnswerItem[]) => (items[0].kind === "ui" ? (items[0].nodes[0] as ElVNode) : null);
    expect(boxOf(one)?.children).toHaveLength(1);
    expect(boxOf(two)?.children).toHaveLength(2);
    expect(boxOf(two)?.key).toBe(boxOf(one)?.key);
  });
});

describe("evaluating UI nodes", () => {
  it("evaluates props, interpolation and control flow into nodes", () => {
    const view = evaluate(`{@state n = 3}
{@const total = n * 1000}

머리말 **문단**

<box border gap={4}>
  <text size="lg">합계 {total}원</text>
  {#if n > 2}
    <badge tone="success">충분</badge>
  {:else}
    <badge tone="danger">부족</badge>
  {/if}
  {#each [1, 2] as k, i}
    <text>{i}:{k}</text>
  {/each}
</box>
`);
    const box = el(view, "box");
    expect(box.props).toMatchObject({ border: true, gap: 4 });
    expect(box.children.map((c) => (c.k === "el" ? `${c.tag}:${c.segs.map((s) => s.text).join("")}` : c.k))).toEqual([
      "text:합계 3000원",
      "badge:충분",
      "text:0:1",
      "text:1:2",
    ]);
    expect(el(box.children, "badge").props.tone).toBe("success");
    // Keys are unique, and the same for the same source position on the next render.
    const keys = box.children.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(el(evaluate(`{@state n = 3}
{@const total = n * 1000}

머리말 **문단**

<box border gap={4}>
  <text size="lg">합계 {total}원</text>
  {#if n > 2}
    <badge tone="success">충분</badge>
  {:else}
    <badge tone="danger">부족</badge>
  {/if}
  {#each [1, 2] as k, i}
    <text>{i}:{k}</text>
  {/each}
</box>
`, { n: 9 }), "box").children.map((c) => c.key)).toEqual(keys);
  });

  it("treats an interpolated value as literal text, not Markdown", () => {
    const view = evaluate(`{@state s = "**굵게 아님** <i>x</i>"}\n\n<text>정적 **굵게** {s}</text>\n`);
    expect(el(view, "text").segs).toEqual([{ text: "정적 " }, { text: "굵게", b: true }, { text: " " }, { text: "**굵게 아님** <i>x</i>" }]);
  });

  it("drops props a component does not declare and values outside its tokens", () => {
    const doc = parseWidget(`<text color="red" style="position:fixed" class="x" onclick="alert(1)" size="lg">글</text>\n`);
    const rt = createRuntime();
    const view = buildWidgetView(doc, createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt);
    expect(Object.keys(el(view, "text").props)).toEqual(["size"]);
  });

  it("isolates a failing node, and draws a control whose required prop was left out with its empty value", () => {
    const doc = parseWidget(`<col>\n  <text>앞</text>\n  <text>{nope(1)}</text>\n  <slider label="x" value={1} />\n  <text>뒤</text>\n</col>\n`);
    const rt = createRuntime();
    const view = buildWidgetView(doc, createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt);
    const kinds = el(view, "col").children.map((c) => c.k);
    // The answer is already on screen: a slider without `onChange` is drawn (it
    // just does nothing) instead of an error in the middle of the layout.
    expect(kinds).toEqual(["el", "error", "el", "el"]);
    const errors = el(view, "col").children.filter((c) => c.k === "error");
    expect(errors[0]).toMatchObject({ message: "이 부분을 표시하지 못했습니다.", detail: expect.stringContaining("nope") });
    const slider = el(view, "col").children[2];
    expect(slider).toMatchObject({ k: "el", tag: "slider" });
    expect(typeof (slider as { props: Record<string, unknown> }).props.onChange).toBe("function");
  });

  it("replaces an over-budget block with ONE error and still renders the next block", () => {
    const view = evaluate(`<text>{Array.from({ length: 9000 }, (_, i) => Array.from({ length: 9000 }, (_, j) => i * j)).length}</text>\n<text>다음 블록</text>\n`);
    expect(view.map((n) => n.k)).toEqual(["error", "el"]);
    expect(view[0]).toMatchObject({ message: "계산이 너무 커서 이 부분을 표시하지 못했습니다." });
    expect(el(view, "text").segs).toEqual([{ text: "다음 블록" }]);
  });

  it("stops at ONE notice when the render pass is spent, keeping what was already drawn", () => {
    const doc = parseWidget(`<text>앞 블록</text>
{#each 1000 as i}
  {#each 1000 as j}
    <divider />
  {/each}
{/each}
<text>뒤 블록 하나</text>
<text>뒤 블록 둘</text>
`);
    expect(doc.problems).toEqual([]);
    const rt = createRuntime();
    const root = createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} });
    const started = Date.now();
    const view = buildWidgetView(doc, root, rt);
    expect(Date.now() - started).toBeLessThan(2000);
    // The first block is there; the pass ran out inside the second; nothing after it is attempted…
    expect(view.map((n) => n.k)).toEqual(["el", "error"]);
    expect(el(view, "text").segs).toEqual([{ text: "앞 블록" }]);
    // …and the reader is told once, not once per remaining block.
    expect(view.at(-1)).toMatchObject({
      k: "error",
      message: "그릴 내용이 너무 많아 일부를 표시하지 못했습니다.",
      detail: expect.stringContaining("output budget"),
    });

    // Walking the SAME root again (the fullscreen copy, a re-evaluation) starts a
    // fresh pass: it does not inherit the spent budget and fail at the first block.
    const again = buildWidgetView(doc, root, rt);
    expect(again.map((n) => n.k)).toEqual(["el", "error"]);
    expect(el(again, "text").segs).toEqual([{ text: "앞 블록" }]);
  });

  it("gives a written prop that evaluates to nothing its type's empty value", () => {
    const view = evaluate(`{@state done = {}}
{@state pick = null}

{#each ["여권", "환전"] as k}
  <checkbox checked={done[k]} onChange={(c) => setDone({ ...done, [k]: c })}>{k}</checkbox>
{/each}
<select label="선택" value={pick} onChange={setPick} options={null} />
<chart spec={pick ? { mark: "bar" } : null} />
<submit values={pick}>보내기</submit>
`);
    expect(view.filter((n) => n.k === "error")).toEqual([]);
    const boxes = view.filter((n): n is ElVNode => n.k === "el" && n.tag === "checkbox");
    expect(boxes.map((b) => [b.props.checked, b.flawed])).toEqual([
      [false, ""],
      [false, ""],
    ]);
    expect(el(view, "select").props).toMatchObject({ value: "", options: [] });
    expect(el(view, "chart").props.spec).toEqual({});
    expect(el(view, "submit").props.values).toEqual({});
  });

  it("says so under a block that called a setter or copy while rendering", () => {
    // Inside a function body, so the static check lets it through; the runtime ignores the call.
    const source = `{@state a = 0}
{@state xs = [1, 2, 3]}

<text>깨끗한 블록</text>
<text>합 {xs.map((x) => setA(x)).length}{copy("x") ?? ""}</text>
<text>다음 블록</text>
`;
    const doc = parseWidget(source);
    const rt = createRuntime();
    const values = { ...restoreState(doc, null).values };
    const view = buildWidgetView(doc, createRootEnv(doc, values, rt, { get: (n) => values[n], set: () => {}, copy: () => {} }), rt);
    expect(view.map((n) => n.k)).toEqual(["el", "el", "warn", "el"]);
    expect(view[2]).toMatchObject({
      k: "warn",
      message: "렌더 중에 호출된 상태 변경은 무시됩니다.",
      detail:
        "setA(…) was called while rendering and was ignored — call a setter only from an event handler (onChange/onClick).\n" +
        "copy(…) was called while rendering and was ignored — call copy only from an event handler (onChange/onClick).",
    });
    expect(values.a).toBe(0);
    // The block itself still rendered, and the one after it carries no leftover warning.
    expect((view[1] as ElVNode).segs).toEqual([{ text: "합 " }, { text: "3" }]);
    expect(collectWidgetProblems(doc, view)).toEqual([
      "line 5:1 setA(…) was called while rendering and was ignored — call a setter only from an event handler (onChange/onClick).",
      "line 5:1 copy(…) was called while rendering and was ignored — call copy only from an event handler (onChange/onClick).",
    ]);
  });

  it("lists what failed, with the line and column of each node, for the avatar", () => {
    const doc = parseWidget(`<text>좋음</text>
<col>
  <text>{nope(1)}</text>
  <slider label="x" value={1} />
  <stat label="a" value={1} hint={nope(2)} />
</col>
{#each 1000 as i}
  {#each 1000 as j}
    <divider />
  {/each}
{/each}
`);
    const rt = createRuntime();
    const view = buildWidgetView(doc, createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt);
    const problems = collectWidgetProblems(doc, view);
    // The slider's missing `onChange` is the static check's to report (`widgetProblems`), not a render failure.
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^line 3:3 <text>: .*nope/);
    expect(problems[1]).toMatch(/^line 5:3 <stat>: a prop was dropped — hint: .*nope/);
    expect(problems[2]).toBe("inline UI: too much is rendered (output budget exceeded)");
    // A clean view has nothing to report.
    const clean = parseWidget(`<text>좋음</text>\n`);
    expect(collectWidgetProblems(clean, buildWidgetView(clean, createRootEnv(clean, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt))).toEqual([]);
  });

  it("cuts a long list and says so", () => {
    const view = evaluate(`<col>\n  {#each 1500 as i}\n    <text>{i}</text>\n  {/each}\n</col>\n`);
    const children = el(view, "col").children;
    expect(children).toHaveLength(1001);
    expect(children.at(-1)).toMatchObject({ k: "note", message: "항목이 많아 일부만 표시했습니다." });
  });

  it("uses a component's text children as its label", () => {
    const view = evaluate(`{@state on = false}\n\n<checkbox checked={on} onChange={setOn}>알림 **받기**</checkbox>\n<submit values={{ on }} label="보내기 라벨" />\n`);
    expect(el(view, "checkbox").segs).toEqual([{ text: "알림 " }, { text: "받기", b: true }]);
    expect(el(view, "submit")).toMatchObject({ segs: [], props: { label: "보내기 라벨", values: { on: false } } });
  });
});

describe("an <svg> in the view model", () => {
  const two = `{@state r = 4}\n<svg viewBox="0 0 10 10" label="원"><linearGradient id="g" /><circle r={r} fill="url(#g)" /></svg>\n<col>\n  <svg viewBox="0 0 10 10" width={64}><linearGradient id="g" /><text>{r}</text></svg>\n</col>\n`;

  it("carries the drawing as a plain tree of rebuilt values, with ids namespaced per view and per node", () => {
    const doc = parseWidget(two);
    const values = restoreState(doc, null).values;
    const rt = createRuntime();
    const host = { get: (name: string) => values[name], set: () => {}, copy: () => {} };
    const view = buildWidgetView(doc, createRootEnv(doc, values, rt, host), rt, { svgNs: "wg7" });
    const first = el(view, "svg");
    const second = el(el(view, "col").children, "svg");
    expect(first.props).toEqual(Object.assign(Object.create(null), { viewBox: "0 0 10 10", label: "원" }));
    expect(first.flawed).toBe("");
    expect(first.svg).toEqual({
      tag: "svg",
      attrs: [["viewBox", "0 0 10 10"], ["width", "16"], ["fill", "currentColor"]],
      children: [
        { tag: "linearGradient", attrs: [["id", "wg7_15-g"]], children: [] },
        { tag: "circle", attrs: [["r", "4"], ["fill", "url(#wg7_15-g)"]], children: [] },
      ],
    });
    // the second drawing of the same widget has its own namespace (its node key), and its own width
    expect(second.svg?.attrs).toEqual([["viewBox", "0 0 10 10"], ["width", "64"], ["fill", "currentColor"]]);
    const secondId = (second.svg!.children[0] as { attrs: [string, string][] }).attrs[0][1];
    expect(secondId).toMatch(/^wg7_\d+_\d+-g$/);
    expect(secondId).not.toBe("wg7_15-g");
    expect(second.svg!.children[1]).toEqual({ tag: "text", attrs: [], children: ["4"] });
    // another view (the fullscreen copy) of the same document: other ids; no namespace given: "wg"
    const other = buildWidgetView(doc, createRootEnv(doc, values, rt, host), rt, { svgNs: "wg8" });
    expect((el(other, "svg").svg!.children[0] as { attrs: [string, string][] }).attrs[0][1]).toBe("wg8_15-g");
    const bare = buildWidgetView(doc, createRootEnv(doc, values, rt, host), rt);
    expect((el(bare, "svg").svg!.children[0] as { attrs: [string, string][] }).attrs[0][1]).toBe("wg_15-g");
  });

  it("reports what it left out, and turns a drawing over its limits into one error node", () => {
    const doc = parseWidget(`{@state evil = "javascript:alert(1)"}\n<svg viewBox="0 0 10 10"><rect fill={evil} x="1" /><use href="#a" /></svg>\n<svg viewBox="0 0 10 10">{#each 501 as i}<rect />{/each}</svg>\n<svg viewBox={"nope"}></svg>\n<text>뒤</text>\n`);
    expect(doc.problems).toEqual([]);
    const values = restoreState(doc, null).values;
    const rt = createRuntime();
    const view = buildWidgetView(doc, createRootEnv(doc, values, rt, { get: (name: string) => values[name], set: () => {}, copy: () => {} }), rt);
    const drawn = el(view, "svg");
    expect(drawn.svg?.children).toEqual([{ tag: "rect", attrs: [["x", "1"]], children: [] }]);
    expect(drawn.flawed).toContain("<rect> fill must be a token");
    expect(drawn.flawed).toContain("<use> is not allowed inside <svg>");
    expect(view.filter((n) => n.k === "error").map((n) => (n.k === "error" ? n.detail : ""))).toEqual([
      "the <svg> draws too many elements (limit 500) — draw fewer shapes, e.g. one <path> or <polyline> instead of many <line>s",
      'viewBox: must be four numbers "minX minY width height" with a positive width and height, e.g. "0 0 200 120"',
    ]);
    expect(el(view, "text").segs).toEqual([{ text: "뒤" }]);
    const problems = collectWidgetProblems(doc, view);
    expect(problems[0]).toMatch(/^line 2:1 <svg>: a prop was dropped — <rect> fill must be a token/);
    expect(problems[1]).toBe("line 3:1 <svg>: the <svg> draws too many elements (limit 500) — draw fewer shapes, e.g. one <path> or <polyline> instead of many <line>s");
  });
});

describe("cellText", () => {
  it("shows primitives as text and data as JSON", () => {
    expect([cellText("a"), cellText(1.5), cellText(true), cellText(null), cellText(undefined), cellText({ a: 1 }), cellText([1, 2])]).toEqual([
      "a",
      "1.5",
      "true",
      "",
      "",
      '{"a":1}',
      "[1,2]",
    ]);
  });
});
