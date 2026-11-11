// @vitest-environment jsdom
//
// A ```mermaid code block of rendered Markdown is drawn as its diagram
// (lib/mermaidBlock.ts, driven by lib/dom.ts): only once the fence is closed,
// once per (source, theme), with a 소스 toggle — and a diagram that cannot be
// drawn keeps its source on screen and says so to whoever listens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.hoisted(() => vi.fn<(source: string, dark: boolean) => Promise<string>>());
vi.mock("../src/client/src/lib/mermaidRender.js", () => {
  class MermaidLoadError extends Error {}
  return { MermaidLoadError, renderMermaidSvg: render };
});

import { MAX_REPORT_ERROR_CHARS } from "../src/client/src/lib/canvasReport.js";
import { enhanceMarkdown, markdownBlocks } from "../src/client/src/lib/dom.js";
import { renderMarkdown } from "../src/client/src/lib/format.js";
import { DIAGRAM_ERROR_EVENT, diagramProblems, resetMermaidBlocks } from "../src/client/src/lib/mermaidBlock.js";
import { MermaidLoadError } from "../src/client/src/lib/mermaidRender.js";
import { createStreamMarkdown, renderMarkdownBlocks } from "../src/client/src/lib/streamMarkdown.js";
import { setThemePref } from "../src/client/src/lib/theme.js";

const DIAGRAM = 'flowchart LR\n  A["로그인 (SSO)"] --> B{승인됨?}\n  B -->|예| C[홈]';
const ANSWER = `흐름입니다.\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\n끝.`;

/** Let the render promise and the microtask that reports a failure run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function mount(source: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "md";
  node.innerHTML = renderMarkdown(source);
  document.body.append(node);
  return node;
}

function drawing(wrapper: Element): string {
  return wrapper.querySelector(".code-diagram")?.shadowRoot?.innerHTML ?? "";
}

beforeEach(() => {
  resetMermaidBlocks();
  render.mockReset();
  render.mockImplementation(async (source, dark) => `<svg data-theme="${dark ? "dark" : "light"}"><text>${source.length}</text></svg>`);
  setThemePref("light");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("a ```mermaid block of a whole render (enhanceMarkdown)", () => {
  it("is drawn in place: the diagram instead of the <pre>, the header and the source kept", async () => {
    const node = mount(ANSWER);
    enhanceMarkdown(node, ANSWER);
    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    // Until the render lands the block is the code block it was.
    expect(wrapper.dataset.diagram).toBe("drawing");
    expect(wrapper.querySelector<HTMLElement>(".code-diagram")!.hidden).toBe(true);
    await settle();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(DIAGRAM, false);
    expect(wrapper.dataset.diagram).toBe("drawn");
    expect(drawing(wrapper)).toContain("<svg");
    expect(wrapper.querySelector<HTMLElement>(".code-diagram")!.hidden).toBe(false);
    expect(wrapper.querySelector(".code-diagram")!.getAttribute("role")).toBe("img");
    expect(wrapper.querySelector(".code-lang")?.textContent).toBe("Mermaid");
    // The source is still there (copy reads it; 소스 shows it).
    expect(wrapper.querySelector("pre > code")?.textContent).toBe(`${DIAGRAM}\n`);
    // The drawing lives in a shadow root: its <style> cannot restyle the app.
    expect(wrapper.querySelector(".code-diagram svg")).toBeNull();
  });

  it("has a 소스 toggle — a real pressed-state button before 줄바꿈 and copy, hidden until there is a diagram", async () => {
    const node = mount(ANSWER);
    enhanceMarkdown(node, ANSWER);
    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    const toggle = wrapper.querySelector<HTMLButtonElement>("button.code-view")!;
    expect(toggle.hidden).toBe(true);
    await settle();
    expect(toggle.hidden).toBe(false);
    expect(toggle.textContent).toBe("소스");
    expect(toggle.type).toBe("button");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const buttons = Array.from(wrapper.querySelectorAll(".code-actions > button")).map((button) => button.className);
    expect(buttons).toEqual(["code-view", "code-wrap", "code-copy"]);

    toggle.click();
    expect(wrapper.classList.contains("code-source-on")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(wrapper.classList.contains("code-source-on")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Toggling never renders again.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("leaves every other code block alone", async () => {
    const source = "```ts\nconst a = 1;\n```\n\n```\nflowchart LR\n  A --> B\n```";
    const node = mount(source);
    enhanceMarkdown(node, source);
    await settle();
    expect(render).not.toHaveBeenCalled();
    expect(node.querySelectorAll(".code-block")).toHaveLength(2);
    expect(node.querySelector("[data-diagram], .code-view, .code-diagram")).toBeNull();
  });

  it("draws a second mount of the same diagram from the cache, in the same task", async () => {
    const first = mount(ANSWER);
    enhanceMarkdown(first, ANSWER);
    await settle();
    // The stored message takes over from the live bubble: a new element, the same answer.
    const second = mount(ANSWER);
    enhanceMarkdown(second, ANSWER);
    const wrapper = second.querySelector<HTMLElement>(".code-block")!;
    expect(wrapper.dataset.diagram).toBe("drawn");
    expect(drawing(wrapper)).toContain("<svg");
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("shares one render between two blocks that ask for the same diagram at once", async () => {
    const source = `${ANSWER}\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\``;
    const node = mount(source);
    enhanceMarkdown(node, source);
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(node.querySelectorAll('[data-diagram="drawn"]')).toHaveLength(2);
  });

  it("draws again in the new palette on a theme flip, keeping the old drawing until it lands", async () => {
    const node = mount(ANSWER);
    enhanceMarkdown(node, ANSWER);
    await settle();
    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    expect(drawing(wrapper)).toContain('data-theme="light"');

    setThemePref("dark");
    expect(wrapper.dataset.diagram).toBe("drawn");
    expect(drawing(wrapper)).toContain('data-theme="light"');
    await settle();
    expect(render).toHaveBeenLastCalledWith(DIAGRAM, true);
    expect(drawing(wrapper)).toContain('data-theme="dark"');
  });
});

describe("a ```mermaid block that cannot be drawn", () => {
  it("keeps showing its source with the reason, and tells the listener one English line", async () => {
    render.mockRejectedValue(new Error("Parse error on line 2:\n...A[로그인 (SSO)] --> B\n-----------^\nExpecting 'SQE', got 'PS'"));
    const node = mount(ANSWER);
    const problems: string[] = [];
    diagramProblems(node, (problem) => problems.push(problem));
    enhanceMarkdown(node, ANSWER);
    await settle();

    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    expect(wrapper.dataset.diagram).toBe("failed");
    expect(wrapper.querySelector<HTMLElement>(".code-diagram")!.hidden).toBe(true);
    expect(wrapper.querySelector<HTMLElement>(".code-view")!.hidden).toBe(true);
    expect(wrapper.querySelector("pre > code")?.textContent).toBe(`${DIAGRAM}\n`);
    const note = wrapper.querySelector<HTMLElement>(".code-diagram-note")!;
    expect(note.hidden).toBe(false);
    // The viewer gets the first line; the token list is the avatar's.
    expect(note.textContent).toBe("다이어그램을 그리지 못해 소스를 표시합니다 (상세: Parse error on line 2)다시 그리기");
    expect(note.querySelector("span")?.textContent).toBe("다이어그램을 그리지 못해 소스를 표시합니다 (상세: Parse error on line 2)");
    // Not the avatar's reader's job to retry a source that does not parse.
    expect(note.querySelector<HTMLElement>(".code-diagram-retry")!.hidden).toBe(true);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toBe(
      "```mermaid block: the diagram could not be drawn and the user sees its source instead — Parse error on line 2: ...A[로그인 (SSO)] --> B -----------^ Expecting 'SQE', got 'PS'",
    );
  });

  it("remembers the failure: a remount neither parses again nor stays silent", async () => {
    render.mockRejectedValue(new Error("Parse error on line 2"));
    const first = mount(ANSWER);
    enhanceMarkdown(first, ANSWER);
    await settle();

    const second = mount(ANSWER);
    const problems: string[] = [];
    // The listener is attached AFTER the block was enhanced, as an action later on the same element is.
    enhanceMarkdown(second, ANSWER);
    diagramProblems(second, (problem) => problems.push(problem));
    expect(second.querySelector<HTMLElement>(".code-block")!.dataset.diagram).toBe("failed");
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(problems).toHaveLength(1);
  });

  it("clips a long library message", async () => {
    render.mockRejectedValue(new Error("x".repeat(2000)));
    const node = mount(ANSWER);
    const problems: string[] = [];
    diagramProblems(node, (problem) => problems.push(problem));
    enhanceMarkdown(node, ANSWER);
    await settle();
    // The whole line fits the report's per-line cap (lib/canvasReport.ts), so its end is not cut there.
    expect(problems[0]!.length).toBeLessThanOrEqual(MAX_REPORT_ERROR_CHARS);
    expect(problems[0]!.endsWith("…")).toBe(true);
    expect(node.querySelector(".code-diagram-note span")!.textContent!.length).toBeLessThan(150);
  });

  it("a library that did not LOAD is not the avatar's mistake: nothing is reported, and 다시 그리기 tries again", async () => {
    render.mockRejectedValueOnce(new MermaidLoadError("Failed to fetch dynamically imported module"));
    const node = mount(ANSWER);
    const heard = vi.fn();
    node.addEventListener(DIAGRAM_ERROR_EVENT, heard);
    enhanceMarkdown(node, ANSWER);
    await settle();

    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    expect(wrapper.dataset.diagram).toBe("failed");
    expect(wrapper.querySelector(".code-diagram-note")?.textContent).toContain("다이어그램 도구를 불러오지 못해 소스를 표시합니다.");
    expect(heard).not.toHaveBeenCalled();
    const retry = wrapper.querySelector<HTMLButtonElement>("button.code-diagram-retry")!;
    expect(retry.hidden).toBe(false);
    expect(retry.textContent).toBe("다시 그리기");

    retry.click();
    await settle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(wrapper.dataset.diagram).toBe("drawn");
    expect(wrapper.querySelector<HTMLElement>(".code-diagram-note")!.hidden).toBe(true);
  });
});

describe("a ```mermaid block of a live answer (markdownBlocks)", () => {
  function live(): HTMLElement {
    const node = document.createElement("div");
    node.className = "md";
    document.body.append(node);
    return node;
  }

  it("stays a code block while it is being written, and is drawn the moment its fence closes", async () => {
    const node = live();
    const md = createStreamMarkdown();
    const closedAt = ANSWER.indexOf("```\n\n끝.") + 3;
    const action = markdownBlocks(node, md.render(ANSWER.slice(0, 20), { heal: true }));
    for (let end = 21; end < closedAt; end += 1) {
      action.update(md.render(ANSWER.slice(0, end), { heal: true }));
      await settle();
      expect(render, `after ${end} characters`).not.toHaveBeenCalled();
      expect(node.querySelector('[data-diagram="drawn"], [data-diagram="drawing"]')).toBeNull();
    }
    const wrapper = node.querySelector<HTMLElement>(".code-block")!;
    // Written out, but the closing fence has not come: still code.
    expect(wrapper.dataset.diagram).toBe("code");
    expect(wrapper.querySelector("pre > code")?.textContent).toBe(`${DIAGRAM}\n`);

    // The closing fence — nothing after it yet.
    action.update(md.render(ANSWER.slice(0, closedAt), { heal: true }));
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(DIAGRAM, false);
    expect(node.querySelector(".code-block")).toBe(wrapper);
    expect(wrapper.dataset.diagram).toBe("drawn");

    // The rest of the answer arrives: the diagram is not drawn again.
    for (let end = closedAt + 1; end <= ANSWER.length; end += 1) action.update(md.render(ANSWER.slice(0, end), { heal: true }));
    action.update(md.render(ANSWER));
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".code-block")).toBe(wrapper);
    expect(wrapper.dataset.diagram).toBe("drawn");
  });

  it("draws a block the stream ENDED inside of once the text is no longer live", async () => {
    const node = live();
    const md = createStreamMarkdown();
    const cut = `그림:\n\n\`\`\`mermaid\n${DIAGRAM}`;
    const action = markdownBlocks(node, md.render(cut, { heal: true }));
    await settle();
    expect(render).not.toHaveBeenCalled();
    // The same text, not healed: the turn is over (a stopped answer).
    action.update(md.render(cut));
    await settle();
    expect(render).toHaveBeenCalledTimes(1);
    expect(node.querySelector<HTMLElement>(".code-block")!.dataset.diagram).toBe("drawn");
  });

  it("does not take a block for a diagram before its language is written out", async () => {
    const node = live();
    const md = createStreamMarkdown();
    const action = markdownBlocks(node, md.render("```mer\nflowchart LR\n```\n\n뒤", { heal: true }));
    await settle();
    expect(node.querySelector("[data-diagram]")).toBeNull();
    action.update(md.render("```mermaid\nflowchart LR\n```\n\n뒤", { heal: true }));
    await settle();
    expect(node.querySelector<HTMLElement>(".code-block")!.dataset.diagram).toBe("drawn");
    // And back: the block is a plain code block again, with nothing of the diagram left.
    action.update(md.render("```text\nflowchart LR\n```\n\n뒤", { heal: true }));
    expect(node.querySelector("[data-diagram], .code-view, .code-diagram, .code-diagram-note")).toBeNull();
  });
});

describe("streamMarkdown: which block is still being written", () => {
  const open = (text: string, heal = true) => renderMarkdownBlocks(text, { heal }).map((block) => block.open === true);

  it("marks only the last block of a live text", () => {
    expect(open("첫 문단\n\n둘째 문")).toEqual([false, true]);
    expect(open("첫 문단\n\n```mermaid\nflowchart LR\n  A --")).toEqual([false, true]);
  });

  it("a fence whose closing line has come is finished, even as the last block", () => {
    expect(open("첫 문단\n\n```mermaid\nflowchart LR\n```")).toEqual([false, false]);
    expect(open("첫 문단\n\n```mermaid\nflowchart LR\n```\n")).toEqual([false, false]);
    expect(open("~~~mermaid\nflowchart LR\n~~~~")).toEqual([false]);
    // A shorter run, or the other character, does not close it.
    expect(open("````mermaid\nflowchart LR\n```")).toEqual([true]);
    expect(open("```mermaid\nflowchart LR\n~~~")).toEqual([true]);
  });

  it("marks nothing in a text that is not live", () => {
    expect(open("첫 문단\n\n```mermaid\nflowchart LR", false)).toEqual([false, false]);
  });
});
