// lib/widgetView.ts — a widget document evaluated into plain nodes for the
// Svelte components: inline Markdown as styled runs (never HTML), one error
// node per failing node / over-budget block, and keys stable across renders.
import { describe, expect, it } from "vitest";

import { buildWidgetView, cellText, parseInlineMarkdown, type ElVNode, type VNode } from "../src/client/src/lib/widgetView.js";
import { createRootEnv, createRuntime, parseWidget, restoreState } from "../src/shared/widget/index.js";

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
    expect(parseInlineMarkdown("<b>x</b> [링크](https://example.com)")).toEqual([{ text: "<b>x</b> [링크](https://example.com)" }]);
  });
});

describe("buildWidgetView", () => {
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
    expect(view[0]).toMatchObject({ k: "md", text: expect.stringContaining("머리말 **문단**") });
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

  it("isolates a failing node and reports a missing required prop in place", () => {
    const doc = parseWidget(`<col>\n  <text>앞</text>\n  <text>{nope(1)}</text>\n  <slider label="x" value={1} />\n  <text>뒤</text>\n</col>\n`);
    const rt = createRuntime();
    const view = buildWidgetView(doc, createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} }), rt);
    const kinds = el(view, "col").children.map((c) => c.k);
    expect(kinds).toEqual(["el", "error", "error", "el"]);
    const errors = el(view, "col").children.filter((c) => c.k === "error");
    expect(errors[0]).toMatchObject({ message: "이 부분을 표시하지 못했습니다.", detail: expect.stringContaining("nope") });
    expect(errors[1]).toMatchObject({ detail: expect.stringContaining("onChange") });
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
      message: "위젯이 그리는 내용이 너무 많아 일부를 표시하지 못했습니다.",
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
