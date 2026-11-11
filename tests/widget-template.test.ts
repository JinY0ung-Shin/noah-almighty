import { describe, expect, it } from "vitest";
import { MAX_TEMPLATE_NESTING, MAX_WIDGET_SOURCE_CHARS, lineCol, parseWidget, type ElNode, type TNode } from "../src/shared/widget/template.js";

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
