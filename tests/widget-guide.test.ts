// The inline UI brief that rides the system prompt of every interactive chat
// run (`src/shared/widget/guide.ts`). It is the only thing that tells the model
// the grammar without a tool call, and it is paid for on every such run — so it
// must be right (generated from the spec table, its example must check) and it
// must stay small (procedures and the full reference live in the manual).
import { describe, expect, it } from "vitest";

import { INLINE_UI_MANUAL_TOPIC, INLINE_UI_REPORT_TITLE, WIDGET_COMPONENTS, WIDGET_TAGS, checkWidget, containsInlineUi, inlineUiPromptSpec, parseAnswer, widgetComponentBrief } from "../src/shared/widget/index.js";

describe("inlineUiPromptSpec", () => {
  const brief = inlineUiPromptSpec();

  it("names every component with its props, required ones starred — from the spec table", () => {
    const list = widgetComponentBrief();
    for (const tag of WIDGET_TAGS) {
      expect(list, tag).toContain(`<${tag}`);
      for (const [name, prop] of Object.entries(WIDGET_COMPONENTS[tag].props)) {
        expect(list, `${tag}.${name}`).toMatch(new RegExp(`<${tag}[^>]*\\s${name}${prop.required ? "\\*" : "(?![\\w*])"}`));
      }
    }
    expect(brief).toContain(list);
  });

  it("says where the UI goes, what reaches the avatar, and where the full reference is", () => {
    expect(brief.startsWith("# Inline UI\n")).toBe(true);
    expect(brief).toContain("write UI tags DIRECTLY IN YOUR ANSWER TEXT");
    expect(brief).toContain("There is no tool to call for this, and nothing opens in the side panel.");
    expect(brief).toContain("Write the UI in your FINAL answer text.");
    expect(brief).toContain("never decorate a simple answer");
    expect(brief).toContain("You are NOT called when they change an input");
    expect(brief).toContain(`topic \`${INLINE_UI_MANUAL_TOPIC}\``);
    expect(brief).toContain(INLINE_UI_REPORT_TITLE);
  });

  it("sends a diagram to a ```mermaid fenced block in the answer — not to a tag, not to a canvas", () => {
    expect(brief).toContain("as an ordinary ```mermaid fenced code block (not a tag)");
    expect(brief).toContain('`A["Login (SSO)"] -->|"POST /api"| B`');
    // A fence is not inline UI: an answer that holds only a diagram is plain Markdown.
    expect(containsInlineUi('그림입니다.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n')).toBe(false);
  });

  it("its examples are valid inline UI", () => {
    const example = brief.slice(brief.indexOf("{@state qty"), brief.indexOf("\n\nEvery prop"));
    expect(checkWidget(example)).toMatchObject({ ok: true });
    const chart = /`(<chart type="bar"[^`]+\/>)`/.exec(brief)?.[1] ?? "";
    expect(checkWidget(chart)).toMatchObject({ ok: true });
    // Read as an answer, the brief's example is UI — and is detected as such.
    expect(containsInlineUi(example)).toBe(true);
    expect(parseAnswer(example).problems).toEqual([]);
  });

  it("stays small: it is in the prompt of every interactive chat run", () => {
    expect(brief.length).toBeLessThan(6200);
  });
});
