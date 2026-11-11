// @vitest-environment jsdom
//
// The live answer is rendered as top-level markdown blocks (lib/streamMarkdown.ts)
// so finished blocks keep their DOM. The correctness bar: the blocks, joined, are
// the SAME html as rendering the whole text at once — at every prefix a stream
// can stop at. Healing (lib/streamHeal.ts) only ever changes the open tail.
//
// Volume is bounded on purpose: DOMPurify under jsdom keeps ~15 KB per call
// alive for the life of the worker, so a wide fuzz belongs in a one-off run, not
// in the gate.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/client/src/lib/format.js";
import { healMarkdownTail } from "../src/client/src/lib/streamHeal.js";
import { createStreamMarkdown, renderMarkdownBlocks } from "../src/client/src/lib/streamMarkdown.js";

const LONG_TOKEN = "noah_almighty_unbroken_token_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789";

/** A Korean + English answer: headings, nested and ordered lists, a quote, a table, fences with backticks inside, a long token. */
const ANSWER_MIXED = `# 로컬 시연: Markdown 스트리밍

이 답변은 **local 스텁**이 미리 정해진 문장을 흘려보냅니다. 실제 실행과 같은 \`delta\` 이벤트로 도착합니다.

## 1. 목록

- 순서 없는 항목 하나 — *기울임*, **굵게**, ~~취소선~~, \`inline code\`
- 한글과 English: Noah는 BFF이고 pi-gateway가 agent runtime입니다.
  - 들여쓴 하위 항목
  - 링크: [Noah 문서](https://example.com/docs)
1. 순서 있는 항목
2. 두 번째 항목

> 인용문도 한 줄 넣어 둡니다.

| 표면 | 이벤트 | 시연 명령 |
| --- | --- | --- |
| 생각 과정 | \`thinking\` | \`demo thinking\` |
| 도구 활동 | \`tool\` / \`tool_end\` | **굵은** 셀 |

\`\`\`ts
export function greet(name: string): string {
  const message = \`안녕하세요, \${name}님\`;

  return message;
}
\`\`\`

${LONG_TOKEN}

값은**42**입니다. 3 * 4 = 12, 범위는 3~5개.

---

끝입니다.
`;

/** A coding answer: loose and tight lists, code inside list items, a fence nested in a longer fence, setext headings, task items. */
const ANSWER_CODE = `Setext 제목
===========

두 가지 방법이 있습니다:

1. 먼저 설치합니다.

   \`\`\`bash
   npm install --save-dev vitest   # \`npx\`도 됩니다
   \`\`\`

2. 그다음 실행합니다.
3. 끝.

부제목
------

- [ ] 할 일 하나
- [x] 끝난 일

- 느슨한 목록

- 두 번째 항목
  이어지는 줄

\`\`\`\`md
\`\`\`js
console.log("fence in a fence");
\`\`\`
\`\`\`\`

    들여쓴 코드
    둘째 줄

마지막 문단은 줄바꿈 없이 끝납니다`;

/** What does NOT split cleanly: raw HTML (a tag open across blocks), reference links, a footnote-like definition. */
const ANSWER_HTML = `첫 문단은 평범합니다.

두 번째 문단.

<details>
<summary>펼치기</summary>

안쪽 **문단**

</details>

표 안의 줄바꿈:

| a | b |
| --- | --- |
| 1<br>2 | 3 |

끝 <b>굵게`;

const ANSWER_REFS = `참고 문서는 [Noah 문서][docs]에 있습니다.

각주처럼 쓴 표시[^1]도 있습니다.

- 목록 하나
- 목록 둘

[docs]: https://example.com/docs
[^1]: 각주 본문

마지막 문단.
`;

function joined(blocks: { html: string }[]): string {
  return blocks.map((block) => block.html).join("");
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("stream markdown: block split equals the whole render", () => {
  for (const [name, answer] of [
    ["mixed", ANSWER_MIXED],
    ["code", ANSWER_CODE],
    ["html", ANSWER_HTML],
    ["refs", ANSWER_REFS],
  ] as const) {
    it(`${name}: every prefix, fed one character at a time`, () => {
      const md = createStreamMarkdown();
      const healing = createStreamMarkdown();
      for (let end = 1; end <= answer.length; end += 1) {
        const prefix = answer.slice(0, end);
        const blocks = md.render(prefix);
        expect(joined(blocks), `prefix ${end}: ${JSON.stringify(prefix.slice(-40))}`).toBe(renderMarkdown(prefix));
        // Healing never throws, and never touches a block before the open tail.
        const healed = healing.render(prefix, { heal: true });
        const settled = Math.max(0, blocks.length - 1);
        expect(healed.slice(0, settled).map((b) => b.html)).toEqual(blocks.slice(0, settled).map((b) => b.html));
      }
    });
  }

  it("a fresh renderer on any prefix agrees with one that saw every prefix", () => {
    const md = createStreamMarkdown();
    for (let end = 1; end <= ANSWER_CODE.length; end += 7) {
      const prefix = ANSWER_CODE.slice(0, end);
      expect(joined(md.render(prefix))).toBe(joined(renderMarkdownBlocks(prefix)));
    }
  });

  it("renders a finished block once and hands back the same object", () => {
    const md = createStreamMarkdown();
    let first: unknown = null;
    let calls = 0;
    for (let end = 1; end <= ANSWER_MIXED.length; end += 1) {
      const blocks = md.render(ANSWER_MIXED.slice(0, end));
      calls += 1;
      if (blocks.length > 3) {
        first ??= blocks[0];
        expect(blocks[0]).toBe(first);
      }
    }
    expect(first).not.toBeNull();
    // About one block per call (the open one), not the whole text every time.
    expect(md.stats.rendered).toBeLessThan(calls * 2);
    expect(md.stats.whole).toBe(0);
    const final = md.render(ANSWER_MIXED);
    expect(final.length).toBeGreaterThan(8);
    expect(final.map((block) => block.key)).toEqual(final.map((_, index) => index));
    // Unchanged text → the same array (the action skips its sweep on identity).
    expect(md.render(ANSWER_MIXED)).toBe(final);
  });

  it("starts over when the text is not a continuation (a fold, a new turn)", () => {
    const md = createStreamMarkdown();
    md.render("첫 문단\n\n둘째 문단\n\n셋째");
    const next = md.render("전혀 다른 글\n\n새 문단");
    expect(joined(next)).toBe(renderMarkdown("전혀 다른 글\n\n새 문단"));
  });

  it("keeps the blocks before raw HTML split and renders the rest as one", () => {
    const blocks = renderMarkdownBlocks(ANSWER_HTML);
    expect(blocks.length).toBe(3);
    expect(blocks[0].html).toBe("<p>첫 문단은 평범합니다.</p>\n");
    // <details> stays open across the blocks it wraps — only a whole render keeps that.
    expect(blocks[2].html).toContain("<details>");
    expect(blocks[2].html).toContain("</details>");
    expect(blocks[2].html.indexOf("안쪽")).toBeLessThan(blocks[2].html.indexOf("</details>"));
  });

  it("renders whole when a link definition is present, and splits again without one", () => {
    const md = createStreamMarkdown();
    const withRef = "앞 문단 [문서][d]\n\n둘째 문단\n\n[d]: https://example.com\n\n셋째\n";
    const blocks = md.render(withRef);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].html).toContain('<a href="https://example.com">문서</a>');
    expect(md.stats.whole).toBeGreaterThan(0);
    expect(renderMarkdownBlocks("앞 문단 [문서][d]\n\n둘째 문단\n\n셋째\n").length).toBe(3);
  });

  it("shows text markdown makes nothing of, like the whole render", () => {
    const source = "<!-- 주석만 있는 글 -->";
    expect(joined(renderMarkdownBlocks(source))).toBe(renderMarkdown(source));
    expect(renderMarkdown(source)).toContain("<pre>");
    expect(renderMarkdownBlocks("")).toEqual([]);
    expect(renderMarkdownBlocks(null as unknown as string)).toEqual([]);
  });

  it("normalizes CRLF the way marked does", () => {
    const source = "첫 줄\r\n\r\n- a\r\n- b\r\n\r\n끝\r\n";
    expect(joined(renderMarkdownBlocks(source))).toBe(renderMarkdown(source));
  });
});

describe("stream markdown: seeded fuzz", () => {
  const ATOMS = ["- ", "* ", "1. ", "2. ", "10) ", "# ", "## ", "> ", "```", "~~~", "`", "**", "*", "_", "~~", "|", "| --- |", "---", "===", "***",
    "\n", "\n", "\n\n", "\n\n", "  ", "    ", "\t", "a", "가나", "word ", "텍스트 ", "[", "]", "(", ")", "[x]: /u", "[^1]", ":", "<b>", "</b>", "<div>", "</div>",
    "<br>", "<!--", "-->", "<pre>", "</pre>", "&amp;", "\\", "!", "1", ".", "http://a.b ", "=", "-", "~", "<", ">"];

  it("random markdown-ish noise: never throws, split equals whole", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rand = rng(seed);
      const md = createStreamMarkdown();
      const healing = createStreamMarkdown();
      let text = "";
      const parts = 5 + Math.floor(rand() * 30);
      for (let i = 0; i < parts; i += 1) {
        text += ATOMS[Math.floor(rand() * ATOMS.length)];
        expect(joined(md.render(text)), `seed ${seed}: ${JSON.stringify(text)}`).toBe(renderMarkdown(text));
        expect(() => healing.render(text, { heal: true })).not.toThrow();
      }
    }
  });

  it("real answers, cut and salted with noise, in random chunks", () => {
    const answers = [ANSWER_MIXED, ANSWER_CODE, ANSWER_HTML, ANSWER_REFS];
    for (let seed = 1; seed <= 24; seed += 1) {
      const rand = rng(seed * 7919);
      let doc = answers[seed % answers.length];
      for (let i = 0; i < 6; i += 1) {
        const at = Math.floor(rand() * doc.length);
        if (rand() < 0.5) doc = doc.slice(0, at) + doc.slice(at + Math.floor(rand() * 40));
        else doc = doc.slice(0, at) + ATOMS[Math.floor(rand() * ATOMS.length)] + doc.slice(at);
      }
      const md = createStreamMarkdown();
      const healing = createStreamMarkdown();
      for (let end = 0; end < doc.length; ) {
        end = Math.min(doc.length, end + 1 + Math.floor(rand() * 9));
        const prefix = doc.slice(0, end);
        expect(joined(md.render(prefix)), `seed ${seed}: ${JSON.stringify(prefix.slice(-60))}`).toBe(renderMarkdown(prefix));
        expect(() => healing.render(prefix, { heal: true })).not.toThrow();
      }
    }
  });
});

describe("stream markdown: healing the open tail", () => {
  const healed = (text: string) => joined(renderMarkdownBlocks(text, { heal: true }));
  /** The text a reader sees, without code (where markers are content). */
  const visibleText = (html: string) =>
    html.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "").replace(/<[^>]+>/g, "");

  it("closes emphasis, strikethrough and code that are still open", () => {
    expect(healed("이것은 **굵")).toBe("<p>이것은 <strong>굵</strong></p>\n");
    expect(healed("이것은 **굵게 ")).toContain("<strong>굵게</strong>");
    expect(healed("값은**42")).toContain("<strong>42</strong>");
    expect(healed("조금 *기울")).toContain("<em>기울</em>");
    expect(healed("이건 ~~취소")).toContain("<del>취소</del>");
    expect(healed("명령은 `npm te")).toContain("<code>npm te</code>");
    expect(healed("***둘 다")).toContain("<em><strong>둘 다</strong></em>");
    // A closer that is half typed completes instead of doubling.
    expect(healed("**굵게*")).toBe("<p><strong>굵게</strong></p>\n");
    expect(healed("- 항목 **굵")).toContain("<li>항목 <strong>굵</strong></li>");
    expect(healed("## 제목 `co")).toContain("<h2>제목 <code>co</code></h2>");
  });

  it("holds back a marker that means nothing yet", () => {
    expect(healed("문단 **")).toBe("<p>문단 </p>\n");
    expect(healed("문단 `")).toBe("<p>문단 </p>\n");
    expect(healed("문단\n\n#")).toBe("<p>문단</p>\n");
    expect(healed("문단\n\n-")).toBe("<p>문단</p>\n");
    // `Para\n-` is a setext HEADING for one frame without healing.
    expect(renderMarkdown("문단\n-")).toContain("<h2>");
    expect(healed("문단\n-")).toBe("<p>문단</p>\n");
    expect(healed("문단\n=")).toBe("<p>문단</p>\n");
    expect(healed("- a\n- b\n2")).not.toContain("b\n2");
    expect(healed("``")).toBe("");
  });

  it("leaves products, ranges, snake_case and escapes alone", () => {
    for (const text of ["3 * 4 = 12", "3*4=12 입니다", "범위는 3~5개", "snake_case_name 변수", "별표 \\* 그대로", "5 > 3 그리고 a < b"]) {
      expect(healed(text), text).toBe(renderMarkdown(text));
    }
  });

  it("shows a link whose address is still arriving as its label", () => {
    const html = healed("자세한 내용은 [Noah 문서](https://exa");
    expect(html).toContain("<a>Noah 문서</a>");
    expect(visibleText(html)).not.toMatch(/[\[\]()]/);
    expect(healed("그림 ![대체 글](/api/im")).toBe("<p>그림 </p>\n");
    // Whole links are untouched, underscores in the address included.
    const whole = "링크 [문서](https://example.com/a_b_c) 뒤 **굵";
    expect(healed(whole)).toContain('<a href="https://example.com/a_b_c">문서</a>');
    expect(healed(whole)).toContain("<strong>굵</strong>");
  });

  it("draws a table from its header row on", () => {
    const header = healed("| 표면 | 이벤");
    expect(header).toContain("<table>");
    expect(header).toContain("<th>표면</th>");
    expect(header).toContain("<th>이벤</th>");
    expect(healed("| 표면 | 이벤트 |\n| --- | -")).toContain("<th>이벤트</th>");
    const row = healed("| 표면 | 이벤트 |\n| --- | --- |\n| 생각 | `thin");
    expect(row).toContain("<td>생각</td>");
    expect(row).toContain("<code>thin</code>");
    expect(visibleText(row)).not.toContain("|");
    expect(healed("문단\n\n|")).toBe("<p>문단</p>\n");
  });

  it("keeps an open fence as code and hides a closing fence being typed", () => {
    expect(healed("```ts\nconst a = `x`; **not bold")).toBe(renderMarkdown("```ts\nconst a = `x`; **not bold"));
    expect(healed("```ts\ncode\n``")).toBe(renderMarkdown("```ts\ncode\n"));
    expect(healed("```ts\ncode\n```\n")).toBe(renderMarkdown("```ts\ncode\n```\n"));
  });

  it("is the identity on complete blocks", () => {
    for (const block of [
      "평범한 문단입니다.\n",
      "**굵게** 그리고 `code` 그리고 [링크](https://example.com).",
      "- a\n- b\n",
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n",
      "```js\nx\n```\n",
      "Setext\n===\n",
    ]) {
      expect(healMarkdownTail(block), block).toBe(block);
    }
  });

  it("never shows a raw marker while a realistic answer streams", () => {
    const md = createStreamMarkdown();
    const flashes: string[] = [];
    for (let end = 1; end <= ANSWER_MIXED.length; end += 1) {
      const prefix = ANSWER_MIXED.slice(0, end);
      const text = visibleText(joined(md.render(prefix, { heal: true })));
      // `[` alone stays visible on purpose: a bracket is as often plain text as a link.
      const marker = /\*\*|~~|\]\(|`|^\s*\|.*$|^#+\s*$|^[-=]+\s*$/m.exec(text);
      if (marker) flashes.push(`${JSON.stringify(prefix.slice(-24))} → ${marker[0]}`);
    }
    expect(flashes).toEqual([]);
  });
});
