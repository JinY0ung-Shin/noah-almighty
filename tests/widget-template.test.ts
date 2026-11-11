import { describe, expect, it } from "vitest";
import { MAX_TEMPLATE_NESTING, MAX_WIDGET_SOURCE_CHARS, lineCol, parseAnswer, parseWidget, type ElNode, type TNode } from "../src/shared/widget/template.js";

// The widget document parser: what becomes a node, and — unlike the streaming
// parser it was ported from — that nothing malformed is skipped silently.

const parse = (src: string) => parseWidget(src);
const clean = (src: string) => {
  const doc = parse(src);
  expect(doc.problems, JSON.stringify(doc.problems)).toEqual([]);
  return doc;
};
const el = (n: TNode | undefined): ElNode => {
  expect(n?.t).toBe("el");
  return n as ElNode;
};
const messages = (src: string) => parse(src).problems.map((p) => p.message);

describe("widget template parser", () => {
  it("separates top-level Markdown, tags and state declarations", () => {
    const doc = clean(
      ["{@state months = 12, rate = 4.5}", "{@const total = months * rate}", "", "Adjust the **terms**.", "", '<slider label="Months" value={months} onChange={setMonths} min={6} max={60} />', ""].join("\n"),
    );
    expect(doc.states.map((s) => [s.name, s.setter, s.sig])).toEqual([
      ["months", "setMonths", "months = 12"],
      ["rate", "setRate", "rate = 4.5"],
    ]);
    const kinds = doc.nodes.map((n) => n.t);
    expect(kinds).toEqual(["text", "const", "text", "el", "text"]);
    const prose = doc.nodes[2];
    expect(prose.t === "text" && prose.block && prose.value.includes("Adjust the **terms**.")).toBe(true);
    const slider = el(doc.nodes[3]);
    expect(slider.name).toBe("slider");
    expect(slider.attrs.map((a) => a.name)).toEqual(["label", "value", "onChange", "min", "max"]);
    expect(slider.attrs[0].value).toBe("Months");
    const c = doc.nodes[1];
    expect(c.t === "const" && c.sig).toBe("total = months * rate");
  });

  it("attributes: quoted (entities decoded), braces, bare and unquoted", () => {
    const doc = clean(`<box border gap=2 background="surface">\n<text color='muted'>a &amp; b</text>\n<badge tone="A &lt; B &#x41;&#66;">x</badge>\n</box>`);
    const box = el(doc.nodes[0]);
    expect(box.attrs.map((a) => [a.name, a.value])).toEqual([
      ["border", true],
      ["gap", "2"],
      ["background", "surface"],
    ]);
    const badge = el(box.children.find((n) => n.t === "el" && n.name === "badge"));
    expect(badge.attrs[0].value).toBe("A < B AB");
  });

  it("a component that takes no children is self-closing, however it is written", () => {
    const doc = clean(`<row>\n<divider>\n<spacer></spacer>\n<divider />\n<text>after</text>\n</row>`);
    const row = el(doc.nodes[0]);
    const names = row.children.filter((n) => n.t === "el").map((n) => (n as ElNode).name);
    expect(names).toEqual(["divider", "spacer", "divider", "text"]);
  });

  it("inside a tag: interpolation, blocks, nested consts, escapes and code spans", () => {
    const doc = clean(
      [
        "<col>",
        "  {@const doubled = items.map(x => x * 2)}",
        "  {#each doubled as value, i}",
        "    <text>{i}: {value} \\{literal} `{code}`</text>",
        "  {:else}",
        "    <text>none</text>",
        "  {/each}",
        "  {#if a > 1}<badge>big</badge>{:else if a === 1}<badge>one</badge>{:else}<badge>small</badge>{/if}",
        "  <!-- a comment -->",
        "</col>",
      ].join("\n"),
    );
    const col = el(doc.nodes[0]);
    const kinds = col.children.filter((n) => !(n.t === "text" && n.value.trim() === "")).map((n) => n.t);
    expect(kinds).toEqual(["const", "each", "if"]);
    const each = col.children.find((n) => n.t === "each");
    expect(each?.t === "each" && each.index).toBe("i");
    expect(each?.t === "each" && each.empty?.some((n) => n.t === "el")).toBe(true);
    const text = each?.t === "each" ? el(each.children.find((n) => n.t === "el")) : undefined;
    expect(text?.children.map((n) => n.t)).toEqual(["expr", "text", "expr", "text"]);
    const last = text?.children[3];
    expect(last?.t === "text" && last.value).toBe(" \\{literal} `{code}`");
    const cond = col.children.find((n) => n.t === "if");
    expect(cond?.t === "if" && cond.branches.map((b) => b.test === null)).toEqual([false, false, true]);
  });

  it("top-level prose keeps its Markdown: fences, code spans, mid-line < and { are text", () => {
    const src = ["Compare a < b and {curly} braces, and `<box>` in code.", "", "```html", "<box>", "{#if x}", "```", "", "    <box>indented code</box>", "", "a <text>mid-line</text> tag"].join("\n");
    const doc = clean(src);
    expect(doc.nodes.map((n) => n.t)).toEqual(["text"]);
    expect(doc.nodes[0].t === "text" && doc.nodes[0].value).toBe(src);
  });

  it("reports what the streaming parser used to hide", () => {
    expect(messages("<box>\n<text>never closed</text>")[0]).toMatch(/<box> is never closed\. Add <\/box>\./);
    expect(messages("<row>\n<box>\n<text>x</text>\n</row>")[0]).toMatch(/<box> is not closed before/);
    expect(messages("<row>\n</box>\n</row>")[0]).toMatch(/Unexpected closing tag <\/box>/);
    expect(messages("<slider value={months")[0]).toMatch(/never closed|never finished/);
    expect(messages('<text color="muted>x</text>').join("\n")).toMatch(/never closed/);
    expect(messages("<row>\n{#if a}\n<text>x</text>\n</row>").join("\n")).toMatch(/\{#if\} is not closed before/);
    expect(messages("<row>\n{#each list as x}\n<text>x</text>").join("\n")).toMatch(/\{#each\} is never closed\. Add \{\/each\}\./);
    expect(messages("<row>{/if}</row>")[0]).toMatch(/Unexpected \{\/if\}/);
    expect(messages("<row>{:else}</row>")[0]).toMatch(/Unexpected \{:else\}/);
    expect(messages("<row>{#if a}x{:else}y{:else}z{/if}</row>").join("\n")).toMatch(/Nothing may follow \{:else\}/);
    expect(messages("<row>{#each a as x}1{:else}2{:else}3{/each}</row>").join("\n")).toMatch(/takes one \{:else\}/);
    expect(messages("<row>{:else nope}</row>")[0]).toMatch(/Malformed \{:else\}/);
    expect(messages("<row>{:else if a +}</row>")[0]).toMatch(/\{:else if\}/);
    expect(messages("<row>\n<!-- open\n</row>")[0]).toMatch(/comment is never closed/);
  });

  it("a malformed directive is an error, never skipped", () => {
    expect(messages("{@state = 3}")[0]).toMatch(/\{@state\}: .*expected a state name/);
    expect(messages("{@state a = }")[0]).toMatch(/\{@state\}: Syntax error/);
    expect(messages("{@const total}")[0]).toMatch(/\{@const\}: Syntax error/);
    expect(messages("{@const a = 1 2}")[0]).toMatch(/\{@const\}/);
    expect(messages("{#each}")[0]).toMatch(/\{#each\}: /);
    expect(messages("{#if }")[0]).toMatch(/\{#if\}: /);
    expect(messages("{@body const a = 1}")[0]).toMatch(/Unknown directive/);
    expect(messages("{@state x = 1")[0]).toMatch(/never finished/);
    // and the parse goes on, so later problems are reported in the same round
    expect(parse("{@state = 3}\n<row>\n</box>\n</row>").problems.length).toBe(2);
  });

  it("{@state} lives at the top level only, once per name", () => {
    expect(messages("<box>\n{@state a = 1}\n</box>")[0]).toMatch(/top level/);
    expect(messages("{#if true}\n{@state a = 1}\n{/if}").join("\n")).toMatch(/top level/);
    const dup = parse("{@state a = 1}\n{@state a = 2}");
    expect(dup.problems[0].message).toMatch(/declared more than once/);
    expect(dup.states.length).toBe(1);
  });

  it("expression problems carry the parser's message and a position inside the expression", () => {
    const doc = parse("<row>\n  <text>{a +}</text>\n  <text>{b = 1}</text>\n  <text>{}</text>\n</row>");
    expect(doc.problems.map((p) => p.message).join("\n")).toMatch(/Syntax error in expression: .*\n.*assignment is not allowed/);
    expect(lineCol(doc.src, doc.problems[0].pos).line).toBe(2);
    expect(lineCol(doc.src, doc.problems[1].pos).line).toBe(3);
    const attr = parse("<slider value={1 +} />");
    expect(attr.problems[0].message).toMatch(/Prop "value" of <slider>: Syntax error/);
    expect(messages("<slider value={} />")[0]).toMatch(/empty \{\}/);
    expect(messages("<slider {...props} />")[0]).toMatch(/Spread props/);
    expect(messages("<slider value= />")[0]).toMatch(/no value after "="/);
  });

  it("nesting is capped with a problem instead of a stack overflow", () => {
    const nest = (n: number) => "<box>\n".repeat(n) + "<divider />\n" + "</box>\n".repeat(n);
    expect(parse(nest(MAX_TEMPLATE_NESTING)).problems).toEqual([]);
    const over = parse(nest(MAX_TEMPLATE_NESTING + 1));
    expect(over.problems.at(-1)?.message).toMatch(/nested too deeply \(limit 32 levels\)/);
    expect(over.nodes).toEqual([]);
    const blocks = parse("<box>" + "{#if a}".repeat(100) + "{/if}".repeat(100) + "</box>");
    expect(blocks.problems.at(-1)?.message).toMatch(/nested too deeply/);
  });

  it("a source over the size cap is refused outright", () => {
    const doc = parse("x".repeat(MAX_WIDGET_SOURCE_CHARS + 1));
    expect(doc.problems[0].message).toMatch(/too long/);
    expect(doc.nodes).toEqual([]);
  });

  it("pathological inputs end quickly with a 'too complex' problem (the work budget)", () => {
    // Each "{" opens an expression that never closes, so every one rescans to the end: quadratic without a budget.
    for (const src of ["<text>" + "{(".repeat(4000) + "</text>", "<text>" + "{`${".repeat(3000) + "</text>", "<text>" + "{[".repeat(9000) + "</text>"]) {
      const t0 = Date.now();
      const doc = parse(src);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(doc.problems.at(-1)?.message).toMatch(/too complex to parse/);
      expect(doc.nodes).toEqual([]);
    }
    // Backtick runs of every length (each code-span scan runs far): slow-ish by construction, still bounded.
    const ticks = Array.from({ length: 190 }, (_, i) => "`".repeat(i + 1) + " x ").join("\n");
    expect(ticks.length).toBeLessThan(MAX_WIDGET_SOURCE_CHARS);
    const t1 = Date.now();
    parse(ticks);
    expect(Date.now() - t1).toBeLessThan(3000);
    // a long but ordinary document is nowhere near the budget
    const ordinary = "{@state n = 1}\n" + '<row gap={2}>\n  <text>{n + 1} items (`code`)</text>\n</row>\n'.repeat(250);
    expect(ordinary.length).toBeLessThan(MAX_WIDGET_SOURCE_CHARS);
    expect(parse(ordinary).problems).toEqual([]);
  });

  it("lineCol is 1-based", () => {
    expect(lineCol("ab\ncd", 0)).toEqual({ line: 1, col: 1 });
    expect(lineCol("ab\ncd", 3)).toEqual({ line: 2, col: 1 });
    expect(lineCol("ab\ncd", 4)).toEqual({ line: 2, col: 2 });
    expect(lineCol("ab", 99)).toEqual({ line: 1, col: 3 });
  });
});

// An avatar's ANSWER: Markdown that may hold UI, possibly still being written.
describe("parseAnswer", () => {
  const shape = (nodes: TNode[]): string =>
    nodes
      .map((n) =>
        n.t === "el" ? `${n.name}${n.partial ? "~" : ""}(${shape(n.children)})` : n.t === "each" || n.t === "if" ? `${n.t}${n.partial ? "~" : ""}` : n.t,
      )
      .join(",");

  const ANSWER = `월별 매출입니다.

{@state qty = 2}
{@const total = qty * 12000}
<box border padding={3} gap={2}>
  <title size="md">주문 **계산**</title>
  <slider label="수량" value={qty} onChange={setQty} min={1} max={10} />
  {#if qty > 5}
    <badge tone="warning">많음 {qty}</badge>
  {:else if qty > 3}
    <text>보통</text>
  {:else}
    <text>적음</text>
  {/if}
  {#each [1, 2, 3] as n, i}
    <stat label={\`항목 \${n}\`} value={n * qty} />
  {:else}
    <text>없음</text>
  {/each}
  <button send={\`수량 \${qty}개로 주문해 줘\`}>이대로 주문</button>
</box>

끝 문장입니다.
`;

  it("reads prose as text and UI as nodes, with the states it declares", () => {
    const doc = parseAnswer(ANSWER);
    expect(doc.problems).toEqual([]);
    expect(doc.failed).toBe(false);
    expect(doc.pending).toBeNull();
    expect(doc.end).toBe(ANSWER.length);
    expect(doc.states.map((s) => s.name)).toEqual(["qty"]);
    expect(shape(doc.nodes)).toBe("text,text,const,text,box(text,title(text),text,slider(),text,if,text,each,text,button(text),text),text");
    expect(doc.nodes[0]).toMatchObject({ t: "text", block: true, s: 0 });
  });

  it("never reports a problem for an answer that is only half written — at ANY prefix", () => {
    for (let i = 0; i <= ANSWER.length; i++) {
      const doc = parseAnswer(ANSWER.slice(0, i), { streaming: true });
      expect(doc.problems.map((p) => p.message), `prefix ${i}: ${JSON.stringify(ANSWER.slice(Math.max(0, i - 20), i))}`).toEqual([]);
      expect(doc.failed, `prefix ${i}`).toBe(false);
      // What is parsed is always a prefix, and nothing past the cut is in the tree.
      expect(doc.end).toBeLessThanOrEqual(i);
      for (const node of doc.nodes) expect(node.e).toBeLessThanOrEqual(doc.end);
    }
  });

  it("an open element or block keeps the children it has so far and is marked partial", () => {
    const upTo = (needle: string) => ANSWER.slice(0, ANSWER.indexOf(needle) + needle.length);
    let doc = parseAnswer(upTo("</title>\n"), { streaming: true });
    expect(shape(doc.nodes)).toBe("text,text,const,text,box~(text,title(text),text)");
    doc = parseAnswer(upTo("<badge tone=\"warning\">많음"), { streaming: true });
    expect(shape(doc.nodes)).toBe("text,text,const,text,box~(text,title(text),text,slider(),text,if~)");
    // The same text as a FINISHED answer: the open tags are problems (advice), the tree is still there.
    const done = parseAnswer(upTo("</title>\n"));
    expect(shape(done.nodes)).toBe("text,text,const,text,box(text,title(text),text)");
    expect(done.problems.map((p) => p.message)).toEqual(["<box> is never closed. Add </box>."]);
  });

  it("leaves out a construct the text ends inside of, and says which component is being written", () => {
    const cut = (text: string) => parseAnswer(text, { streaming: true });
    // A tag whose `>` has not come: nothing of it is drawn yet.
    let doc = cut('앞 문장\n\n<chart type="bar" data={[{ a: 1');
    expect(shape(doc.nodes)).toBe("text");
    expect(doc.end).toBe("앞 문장\n\n".length);
    expect(doc.pending).toEqual({ tag: "chart", top: true });
    // Inside an open element the pending tag is not top-level.
    doc = cut("<box>\n  <stat label=\"a\" value={1} />\n  <slider val");
    expect(shape(doc.nodes)).toBe("box~(text,stat(),text)");
    expect(doc.pending).toEqual({ tag: "slider", top: false });
    // A name that may still grow into a component is held back, not shown as text.
    expect(shape(cut("글\n\n<sli").nodes)).toBe("text");
    expect(cut("글\n\n<sli").end).toBe(3);
    expect(shape(cut("글\n\n<").nodes)).toBe("text");
    // …but one that cannot is the answer's own text.
    expect(cut("글\n\n<xyz").end).toBe("글\n\n<xyz".length);
    // Half a directive, half a closing tag, half an `{:else}`.
    expect(cut("글\n\n{@sta").end).toBe(3);
    expect(cut("글\n\n{@state n = [1, 2").end).toBe(3);
    expect(shape(cut("<box>\n  <text>a</text>\n</bo").nodes)).toBe("box~(text,text(text),text)");
    expect(shape(cut("<box>\n{#if a}\n  <text>a</text>\n{:el").nodes)).toBe("box~(text,if~)");
    expect(cut("<box>\n{#each rows a").problems).toEqual([]);
  });

  it("a finished answer that ends inside a construct shows the tail as text and says what is wrong", () => {
    const text = '앞\n\n<box>\n  <stat label="a" value={1} />\n  <slider value={';
    const doc = parseAnswer(text);
    expect(shape(doc.nodes)).toBe("text,box(text,stat(),text),text");
    const tail = doc.nodes[doc.nodes.length - 1];
    expect(tail).toMatchObject({ t: "text", block: true, value: "<slider value={" });
    expect(doc.pending).toBeNull();
    expect(doc.problems.map((p) => p.message).join("\n")).toMatch(/The <slider> tag is never finished/);
  });

  it("leaves the answer's own HTML, comments and braces to Markdown", () => {
    const html = [
      "<details><summary>접기</summary>본문</details>",
      "<div align=\"center\">가운데</div>",
      "</div>",
      "<!-- 주석 -->",
      "<table><tr><td>1</td></tr></table>",
      "- [ ] <input type=\"checkbox\" disabled> 할 일",
      "<input type=\"checkbox\" checked>",
      "<button>HTML 버튼</button>",
      "{@html raw} 그리고 {:else} {/if} {x}",
      "a < b && c > d",
    ].join("\n\n");
    const doc = parseAnswer(html);
    expect(doc.problems).toEqual([]);
    expect(doc.nodes.every((n) => n.t === "text")).toBe(true);
    expect(doc.nodes.map((n) => (n.t === "text" ? n.value : "")).join("")).toBe(html);
    // The same names ARE components when they carry what the component cannot do without.
    expect(shape(parseAnswer('<details title="자세히">본문</details>').nodes)).toBe("details(text)");
    expect(shape(parseAnswer("{@state n = 0}\n<button onClick={() => setN(1)}>누르기</button>").nodes)).toBe("text,button(text)");
    expect(shape(parseAnswer('<table columns={["a"]} rows={[{ a: 1 }]} />').nodes)).toBe("table()");
  });

  it("does not look inside fenced code or a code span", () => {
    const doc = parseAnswer("소스는 이렇습니다.\n\n```\n<box>\n  <chart />\n</box>\n{@state n = 1}\n```\n\n그리고 `<box>` 는 컨테이너입니다.\n");
    expect(doc.nodes.every((n) => n.t === "text")).toBe(true);
    expect(doc.states).toEqual([]);
  });

  it("inside a component an unknown tag is an element (the renderer drops it, the check reports it)", () => {
    const doc = parseAnswer("<box>\n  <span>글</span>\n</box>");
    expect(shape(doc.nodes)).toBe("box(text,span(text),text)");
    expect(doc.problems).toEqual([]);
  });

  // An answer is drawn even when it has problems, so a mistake must cost its own line — not the rest of the answer.
  it("a `}` or a quote that was left out does not swallow what follows", () => {
    const texts = (nodes: TNode[]): string => nodes.map((n) => (n.t === "text" ? n.value : n.t === "el" ? texts(n.children) : "")).join("");
    const tail = "\n\n## 결론\n\n이 문단은 중요합니다. 중괄호 } 도 있습니다.\n";
    const cases = [
      `앞\n\n<box border padding={3}>\n  <stat label="합계" value={total />\n  <text>설명</text>\n</box>${tail}`,
      `{@state qty = 2}\n{@const total = qty * 12000\n\n<box border>\n  <text>설명</text>\n</box>${tail}`,
      `<box>\n  {#if qty > \n  <text>설명</text>\n</box>${tail}`,
      `<box>\n  <text color="muted>첫 줄</text>\n  <text>설명</text>\n</box>${tail}`,
    ];
    for (const text of cases) {
      for (const streaming of [false, true]) {
        const doc = parseAnswer(text, { streaming });
        const label = `${streaming ? "streaming" : "finished"}: ${JSON.stringify(text.slice(0, 40))}`;
        expect(doc.failed, label).toBe(false);
        expect(doc.end, label).toBe(text.length);
        expect(shape(doc.nodes), label).toMatch(/box\(.*text\(text\).*\),text$/);
        expect(texts(doc.nodes), label).toContain("설명");
        expect(texts(doc.nodes), label).toContain("이 문단은 중요합니다. 중괄호 } 도 있습니다.");
        expect(doc.problems.length, label).toBeGreaterThan(0);
      }
    }
  });

  it("while streaming, a syntax error is 'still being written' only at the very end of the text", () => {
    // Half a keyword at the end: wait for the rest.
    expect(parseAnswer("<box>\n{#each rows a", { streaming: true }).problems).toEqual([]);
    // The same mistake with more text after it is a real one: the answer goes on being drawn.
    const doc = parseAnswer(`<box>\n  <stat label="a" value={total />\n  <text>하나</text>\n  <text>둘 ${"가".repeat(60)}</text>\n`, { streaming: true });
    expect(shape(doc.nodes)).toBe("box~(text,stat(),text,text(text),text,text(text),text)");
    expect(doc.end).toBe(doc.src.length);
  });

  it("an answer's block-level HTML runs to its blank line: nothing inside it is ours", () => {
    const table = "<table>\n<colgroup>\n<col style=\"width:40%\">\n<col>\n</colgroup>\n<tr><td><button>확인</button></td></tr>\n</table>\n\n## 결론\n\n- 하나\n";
    const doc = parseAnswer(table);
    expect(doc.nodes.every((n) => n.t === "text")).toBe(true);
    expect(doc.problems).toEqual([]);
    // HTML that only shares a name with a component stays HTML…
    for (const html of ['<link rel="stylesheet" href="style.css">\n\n## 다음\n', '<progress value="32" max="100">32%</progress>\n\n끝\n', "<form>\n<input name=\"q\">\n<select><option>a</option></select>\n</form>\n"]) {
      expect(parseAnswer(html).nodes.every((n) => n.t === "text"), html).toBe(true);
    }
    // …and the component of that name is still a component.
    expect(shape(parseAnswer('<progress value={0.4} />\n<link href="https://a.example">링크</link>\n').nodes)).toBe("progress(),text,link(text),text");
    // An inline tag at the start of a line does not hide the UI on the next line.
    expect(shape(parseAnswer('<b>중요</b>: 아래를 보세요.\n<stat label="a" value={1} />\n').nodes)).toBe("text,stat(),text");
  });

  it("a lookalike with a prop only the component has is ours, so the avatar hears what it is missing", () => {
    const doc = parseAnswer('<button variant="primary">확인</button>\n<input label="이름" value="x" />\n');
    expect(shape(doc.nodes)).toBe("button(text),text,input(),text");
    expect(shape(parseAnswer('{@state v = ""}\n<select value={v} />').nodes)).toBe("text,select()");
  });

  it("a lone backtick in prose does not swallow the fence after it", () => {
    const text = "백틱(`) 문자로 감쌉니다:\n```js\nconst s = `hi`;\n<box>\n```\n\n<box border>\n<text>진짜 UI</text>\n</box>\n";
    expect(shape(parseAnswer(text).nodes)).toBe("text,box(text,text(text),text),text");
    // A backtick run with a backtick later on its line is inline code, not a fence (the detector agrees).
    expect(shape(parseAnswer("```code``` 는 인라인\n\n<stat label=\"a\" value={1} />\n").nodes)).toBe("text,stat(),text");
  });

  it("inside a component, a code span the stream has not closed yet is held back", () => {
    const doc = parseAnswer("<box>\n<text>형식은 `{name}", { streaming: true });
    expect(shape(doc.nodes)).toBe("box~(text,text~(text))");
    expect(doc.end).toBe("<box>\n<text>형식은 ".length);
    expect(shape(parseAnswer("<box>\n<text>형식은 `{name}` 입니다</text>\n</box>").nodes)).toBe("box(text,text(text),text)");
  });

  it("stays linear on input built to make it re-read the same text", () => {
    const timed = (text: string) => {
      const started = Date.now();
      parseAnswer(text, { streaming: true });
      return Date.now() - started;
    };
    expect(timed(("<table" + " ".repeat(134) + "\n").repeat(2800) + ">")).toBeLessThan(400);
    expect(timed("<button x={1}\n".repeat(28000) + ">")).toBeLessThan(400);
    expect(timed("<input a\n".repeat(44000) + ">")).toBeLessThan(400);
  });

  it("gives up on an answer that is too long or too deep, without throwing", () => {
    const deep = "<box>\n".repeat(40) + "<text>a</text>\n" + "</box>\n".repeat(40);
    expect(parseAnswer(deep)).toMatchObject({ failed: true, nodes: [] });
    expect(parseAnswer(`<box>\n${"가".repeat(400_001)}\n</box>`)).toMatchObject({ failed: true, nodes: [] });
  });
});
