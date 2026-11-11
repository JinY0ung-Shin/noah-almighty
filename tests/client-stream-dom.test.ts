// @vitest-environment jsdom
//
// DOM side of the live answer (lib/dom.ts): the block action that keeps finished
// blocks' nodes, the code-block header, and copyText's selection fallback.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText, enhanceMarkdown, markdownBlocks } from "../src/client/src/lib/dom.js";
import { renderMarkdown } from "../src/client/src/lib/format.js";
import { createStreamMarkdown } from "../src/client/src/lib/streamMarkdown.js";

function defineClipboard(clip: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value: clip, configurable: true, writable: true });
}

function stubExecCommand(impl: (command: string) => boolean) {
  Object.defineProperty(document, "execCommand", { value: () => false, configurable: true, writable: true });
  return vi.spyOn(document, "execCommand").mockImplementation(impl as never);
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The container as the bubble has it: Svelte's own child (the caret) already inside. */
function liveContainer(): { node: HTMLElement; caret: HTMLElement } {
  const node = document.createElement("div");
  node.className = "md";
  const caret = document.createElement("span");
  caret.className = "stream-caret";
  node.append(caret);
  document.body.append(node);
  return { node, caret };
}

/** The html a reader gets, without what the enhancement adds (headers, wrappers). */
function plainHtml(node: HTMLElement): string {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".stream-caret, .code-head").forEach((el) => el.remove());
  copy.querySelectorAll(".code-block, .table-wrap").forEach((wrapper) => wrapper.replaceWith(...Array.from(wrapper.childNodes)));
  return copy.innerHTML.replace(/<!---->/g, "");
}

describe("dom.markdownBlocks", () => {
  const ANSWER = "# 제목\n\n첫 문단 **굵게**\n\n- 하나\n- 둘\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n끝 문단";

  it("draws the same tree a whole render does, before the caret", () => {
    const { node, caret } = liveContainer();
    const md = createStreamMarkdown();
    const action = markdownBlocks(node, md.render(ANSWER));
    expect(plainHtml(node)).toBe(renderMarkdown(ANSWER));
    expect(node.lastElementChild).toBe(caret);
    // No wrapper per block: the prose CSS sees the elements themselves.
    expect(node.firstElementChild?.tagName).toBe("H1");
    action.destroy();
    expect(node.children).toHaveLength(1);
  });

  it("keeps the nodes of finished blocks while the tail is rewritten on every token", () => {
    const { node } = liveContainer();
    const md = createStreamMarkdown();
    const action = markdownBlocks(node, md.render(""));
    let heading: Element | null = null;
    let paragraph: Element | null = null;
    let list: Element | null = null;
    for (let end = 1; end <= ANSWER.length; end += 1) {
      action.update(md.render(ANSWER.slice(0, end), { heal: true }));
      const h1 = node.querySelector("h1");
      const ul = node.querySelector("ul");
      const p = node.querySelector("p");
      // Once the text has moved past a block, its element is the SAME node from then on.
      if (end > ANSWER.indexOf("- 하나")) {
        heading ??= h1;
        paragraph ??= p;
        expect(h1).toBe(heading);
        expect(p).toBe(paragraph);
      }
      if (end > ANSWER.indexOf("| a |")) {
        list ??= ul;
        expect(ul).toBe(list);
      }
    }
    expect(heading).not.toBeNull();
    expect(list).not.toBeNull();
    action.update(md.render(ANSWER));
    expect(plainHtml(node)).toBe(renderMarkdown(ANSWER));
    expect(node.querySelectorAll(".code-block")).toHaveLength(1);
    expect(node.querySelectorAll(".table-wrap")).toHaveLength(1);
  });

  it("grows an open code block in place: one wrapper, its 줄바꿈 state and buttons kept", () => {
    const { node } = liveContainer();
    const md = createStreamMarkdown();
    const source = "설명\n\n```python\nprint('a')\nprint('b')\nprint('c')\n```\n\n뒤";
    const action = markdownBlocks(node, md.render("설명\n\n```python\npri", { heal: true }));
    const wrapper = node.querySelector(".code-block")!;
    const code = wrapper.querySelector("pre > code")!;
    const wrapToggle = wrapper.querySelector<HTMLButtonElement>("button.code-wrap")!;
    const copyButton = wrapper.querySelector("button.code-copy")!;
    wrapToggle.click();
    expect(wrapper.classList.contains("code-wrapped")).toBe(true);
    for (let end = source.indexOf("pri") + 4; end <= source.length; end += 1) {
      action.update(md.render(source.slice(0, end), { heal: true }));
      expect(node.querySelectorAll(".code-block")).toHaveLength(1);
    }
    expect(node.querySelector(".code-block")).toBe(wrapper);
    expect(wrapper.querySelector("pre > code")).toBe(code);
    expect(wrapper.querySelector("button.code-copy")).toBe(copyButton);
    expect(wrapper.classList.contains("code-wrapped")).toBe(true);
    expect(wrapToggle.getAttribute("aria-pressed")).toBe("true");
    expect(code.textContent).toBe("print('a')\nprint('b')\nprint('c')\n");
    expect(wrapper.querySelector(".code-lang")?.textContent).toBe("Python");
  });

  it("removes a block's nodes — its code wrapper included — when the text starts over", () => {
    const { node, caret } = liveContainer();
    const md = createStreamMarkdown();
    const action = markdownBlocks(node, md.render("```js\nx\n```\n\n문단\n\n| a |\n| - |\n| 1 |\n"));
    expect(node.querySelectorAll(".code-block, .table-wrap")).toHaveLength(2);
    action.update(md.render("새 글"));
    expect(node.querySelectorAll(".code-block, .table-wrap")).toHaveLength(0);
    expect(plainHtml(node)).toBe(renderMarkdown("새 글"));
    action.update(md.render(""));
    expect(node.children).toHaveLength(1);
    expect(node.firstElementChild).toBe(caret);
  });

  it("does nothing for the same array", () => {
    const { node } = liveContainer();
    const md = createStreamMarkdown();
    const blocks = md.render("문단 하나\n\n문단 둘");
    const action = markdownBlocks(node, blocks);
    const insert = vi.spyOn(node, "insertBefore");
    action.update(blocks);
    action.update(md.render("문단 하나\n\n문단 둘"));
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("dom.enhanceMarkdown code-block header", () => {
  function codeBlock(html: string): HTMLElement {
    const node = document.createElement("div");
    node.innerHTML = html;
    document.body.append(node);
    enhanceMarkdown(node, html);
    return node;
  }

  it("labels the block with the fence's language, and falls back to 코드", () => {
    expect(codeBlock(renderMarkdown("```ts\nx\n```")).querySelector(".code-lang")?.textContent).toBe("TypeScript");
    expect(codeBlock(renderMarkdown("```bash\nx\n```")).querySelector(".code-lang")?.textContent).toBe("Bash");
    expect(codeBlock(renderMarkdown("```gleam\nx\n```")).querySelector(".code-lang")?.textContent).toBe("gleam");
    expect(codeBlock(renderMarkdown("```\nx\n```")).querySelector(".code-lang")?.textContent).toBe("코드");
    expect(codeBlock(renderMarkdown("    indented")).querySelector(".code-lang")?.textContent).toBe("코드");
  });

  it("has a 줄바꿈 toggle that is a real, labelled, pressed-state button before the copy button", () => {
    const node = codeBlock(renderMarkdown("```js\nconst veryLongLine = 1;\n```"));
    const wrapper = node.querySelector(".code-block")!;
    const buttons = Array.from(wrapper.querySelectorAll("button"));
    expect(buttons.map((b) => b.className)).toEqual(["code-wrap", "code-copy"]);
    const toggle = buttons[0];
    expect(toggle.type).toBe("button");
    expect(toggle.textContent).toBe("줄바꿈");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.tabIndex).toBe(0);
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(wrapper.classList.contains("code-wrapped")).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(wrapper.classList.contains("code-wrapped")).toBe(false);
    // The <pre> stays the wrapper's own child (what the idempotency check reads).
    expect(wrapper.querySelector(":scope > pre")).not.toBeNull();
  });

  it("does not rebuild the header while the block is unchanged", () => {
    const node = document.createElement("div");
    node.innerHTML = renderMarkdown("```js\nx\n```");
    document.body.append(node);
    const action = enhanceMarkdown(node, "v1");
    const head = node.querySelector(".code-head");
    node.querySelector<HTMLButtonElement>("button.code-wrap")!.click();
    action.update("v2"); // a re-sweep over html that did not change
    expect(node.querySelector(".code-head")).toBe(head);
    expect(node.querySelectorAll(".code-head")).toHaveLength(1);
    expect(node.querySelector(".code-block")!.classList.contains("code-wrapped")).toBe(true);
  });

  it("copies the code as it is at click time", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard({ writeText });
    const node = codeBlock(renderMarkdown("```js\nfirst\n```"));
    node.querySelector("code")!.textContent = "first\nsecond\n";
    node.querySelector<HTMLButtonElement>("button.code-copy")!.click();
    expect(writeText).toHaveBeenCalledWith("first\nsecond\n");
  });
});

describe("dom.copyText fallback", () => {
  it("falls back to the selection copy when the clipboard THROWS, and reports success", async () => {
    defineClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    let copied = "";
    const exec = stubExecCommand(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    const btn = document.createElement("button");
    document.body.append(btn);
    await expect(copyText("복사할 글", btn)).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("복사할 글");
    expect(btn.classList.contains("copied")).toBe(true);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when the fallback fails too (execCommand false or throwing)", async () => {
    defineClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    stubExecCommand(() => false);
    const btn = document.createElement("button");
    document.body.append(btn);
    await expect(copyText("x", btn)).resolves.toBe(false);
    expect(btn.classList.contains("copy-failed")).toBe(true);
    stubExecCommand(() => {
      throw new Error("blocked");
    });
    await expect(copyText("x")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("puts the textarea inside the open dialog the button is in", async () => {
    defineClipboard(undefined);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const btn = document.createElement("button");
    dialog.append(btn);
    document.body.append(dialog);
    let host: Element | null = null;
    stubExecCommand(() => {
      host = document.querySelector("textarea")?.parentElement ?? null;
      return true;
    });
    await copyText("x", btn);
    expect(host).toBe(dialog);
  });

  it("uses the top-most open modal when there is no button, and <body> when there is none", async () => {
    defineClipboard(undefined);
    const hosts: (Element | null)[] = [];
    stubExecCommand(() => {
      hosts.push(document.querySelector("textarea")?.parentElement ?? null);
      return true;
    });
    await copyText("x");
    const lower = document.createElement("div");
    lower.setAttribute("aria-modal", "true");
    const upper = document.createElement("div");
    upper.setAttribute("aria-modal", "true");
    document.body.append(lower, upper);
    await copyText("x");
    expect(hosts).toEqual([document.body, upper]);
  });

  it("restores the viewer's selection and focus", async () => {
    defineClipboard(undefined);
    stubExecCommand(() => true);
    const text = document.createElement("p");
    text.textContent = "선택해 둔 글";
    const btn = document.createElement("button");
    document.body.append(text, btn);
    btn.focus(); // first: jsdom moves the selection on focus (a browser does not for a button)
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.rangeCount).toBe(1);
    let during = -1;
    vi.mocked(document.execCommand).mockImplementation(() => {
      // What a browser does when the textarea is selected: the page selection moves.
      selection.removeAllRanges();
      during = selection.rangeCount;
      return true;
    });
    await copyText("다른 글", btn);
    expect(during).toBe(0);
    expect(document.activeElement).toBe(btn);
    expect(selection.rangeCount).toBe(1);
    expect(selection.getRangeAt(0).startContainer).toBe(text);
    expect(selection.getRangeAt(0).toString()).toBe("선택해 둔 글");
  });
});
