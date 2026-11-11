// `containsInlineUi` — the cheap scan that decides whether an answer needs the
// inline UI renderer at all. It imports nothing, so its tag names repeat the
// spec table's: this file is what fails when they drift.
import { describe, expect, it } from "vitest";

import { INLINE_UI_TAG_NAMES, containsInlineUi, inlineUiPlainText } from "../src/shared/widget/detect.js";
import { WIDGET_TAGS } from "../src/shared/widget/index.js";

describe("containsInlineUi", () => {
  it("knows exactly the components of the spec table", () => {
    expect([...INLINE_UI_TAG_NAMES].sort()).toEqual([...WIDGET_TAGS].sort());
  });

  it("says yes to a component tag or a directive at the start of a line", () => {
    expect(containsInlineUi("매출입니다.\n\n<chart type=\"bar\" data={rows} />")).toBe(true);
    expect(containsInlineUi("<box>\n  <text>a</text>\n</box>")).toBe(true);
    expect(containsInlineUi("   <divider />")).toBe(true);
    expect(containsInlineUi("<chart")).toBe(true); // the tag is still being written
    expect(containsInlineUi("{@state n = 1}\n글")).toBe(true);
    expect(containsInlineUi("{ @const a = 1 }")).toBe(true);
    expect(containsInlineUi("{#each rows as r}")).toBe(true);
    expect(containsInlineUi("{#if ok}")).toBe(true);
  });

  it("says no to ordinary Markdown, HTML and code", () => {
    expect(containsInlineUi("")).toBe(false);
    expect(containsInlineUi(null)).toBe(false);
    expect(containsInlineUi("그냥 **글**입니다. a < b, {x}")).toBe(false);
    expect(containsInlineUi("<div>html</div>\n<b>굵게</b>\n<br>")).toBe(false);
    expect(containsInlineUi("문장 안의 <chart /> 는 줄 맨 앞이 아니다")).toBe(false);
    expect(containsInlineUi("    <box>네 칸 들여쓴 줄은 코드 블록</box>")).toBe(false);
    expect(containsInlineUi("<boxes>")).toBe(false);
    expect(containsInlineUi("{@statement}")).toBe(false);
    expect(containsInlineUi("```\n<box>\n  <chart />\n</box>\n{@state n = 1}\n```\n끝")).toBe(false);
    expect(containsInlineUi("~~~svelte\n{#if ok}\n~~~")).toBe(false);
  });

  it("looks again after a fence closes, and treats an inline-code line as text", () => {
    expect(containsInlineUi("```\n<box>\n```\n\n<stat label=\"a\" value={1} />")).toBe(true);
    expect(containsInlineUi("``` `x` ```\n<stat label=\"a\" value={1} />")).toBe(true);
  });
});

describe("inlineUiPlainText", () => {
  it("keeps the prose and leaves the UI source out — for a snippet that cannot draw UI", () => {
    const answer = '{@state qty = 2}\n{@const total = qty * 3}\n매출을 정리했어요.\n\n<box border>\n  <stat label="합계" value={total} />\n  {#if qty > 1}\n  <text>많음</text>\n  {:else}\n  <text>적음</text>\n  {/if}\n</box>\n\n원하는 기간으로 바꿔 보세요.\n';
    const plain = inlineUiPlainText(answer).replace(/\s+/g, " ").trim();
    expect(plain).toBe("매출을 정리했어요. 원하는 기간으로 바꿔 보세요.");
  });

  it("leaves an ordinary answer, HTML and fenced source untouched", () => {
    const plain = "그냥 답변입니다.\n<div>html</div>\n";
    expect(inlineUiPlainText(plain)).toBe(plain);
    const fenced = '<stat label="a" value={1} />\n\n```\n<box>\n```\n끝';
    expect(inlineUiPlainText(fenced)).toBe("\n```\n<box>\n```\n끝");
    expect(inlineUiPlainText(null)).toBe("");
  });
});
