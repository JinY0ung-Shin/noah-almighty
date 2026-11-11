// Where things go in an answer that holds inline UI (lib/answerLayout.ts), and
// what became of the retired canvas `widget` type on the client: its
// attachments draw nothing and its canvases are ordinary panel tabs.
import { describe, expect, it } from "vitest";

import { answerPieces } from "../src/client/src/lib/answerLayout.js";
import { segmentAttachments } from "../src/client/src/lib/bubbleSegments.js";
import { hasSideTabs, panelCanvases, resolveSideTab, sideTabs } from "../src/client/src/lib/sidePanel.js";
import type { AnswerItem, VNode } from "../src/client/src/lib/widgetView.js";

const node = (key: string): VNode => ({ k: "note", key, message: key });
const md = (s: number, text: string): AnswerItem => ({ kind: "md", key: `/${s}`, s, e: s + text.length, text });
const ui = (s: number, e: number, ...keys: string[]): AnswerItem => ({ kind: "ui", key: `/${s}`, s, e, nodes: keys.map(node) });
const card = (id: string, anchor?: number, over: Record<string, unknown> = {}) => ({ id, kind: "file", name: id, ...(anchor === undefined ? {} : { anchor }), ...over }) as any;
const brief = (pieces: ReturnType<typeof answerPieces>) =>
  pieces.map((p) => (p.kind === "md" ? `md:${p.text}${p.tail ? "|" : ""}` : p.kind === "ui" ? `ui:${p.nodes.map((n) => n.key).join("+")}` : p.kind === "cards" ? `cards:${p.atts.map((a) => a.id).join("+")}` : `pending:${p.tag}`));

describe("answerPieces", () => {
  it("keeps the answer's order: Markdown runs, UI blocks, then Markdown again", () => {
    const items = [md(0, "앞 문장\n\n"), ui(6, 40, "a"), md(40, "\n\n뒤 문장")];
    expect(brief(answerPieces(items, 46, undefined))).toEqual(["md:앞 문장\n\n", "ui:a", "md:\n\n뒤 문장|"]);
  });

  it("joins UI blocks written back to back, and drops whitespace-only runs between them", () => {
    const items = [ui(0, 10, "a"), md(10, "\n\n"), ui(12, 30, "b", "c"), md(30, "\n끝")];
    expect(brief(answerPieces(items, 32, undefined))).toEqual(["ui:a+b+c", "md:\n끝|"]);
  });

  it("puts a card where it is anchored: inside a Markdown run it splits the run", () => {
    const items = [md(0, "가나다라마바사")];
    expect(brief(answerPieces(items, 7, [card("f1", 3)]))).toEqual(["md:가나다", "cards:f1", "md:라마바사|"]);
    // Two cards at one spot share a row; an anchor at 0 comes first.
    expect(brief(answerPieces(items, 7, [card("f1", 3), card("f2", 3), card("f0", 0)]))).toEqual(["cards:f0", "md:가나다", "cards:f1+f2", "md:라마바사|"]);
  });

  it("a card anchored inside a UI block comes right after the block", () => {
    const items = [md(0, "앞\n"), ui(2, 30, "a"), md(30, "\n뒤")];
    expect(brief(answerPieces(items, 32, [card("f1", 12)]))).toEqual(["md:앞\n", "ui:a", "cards:f1", "md:\n뒤|"]);
  });

  it("cards past the end, and cards without an anchor, follow everything; hidden ones never show", () => {
    const items = [md(0, "글"), ui(1, 9, "a")];
    const pieces = answerPieces(items, 9, [card("late", 50), card("legacy"), card("hidden", 0, { hidden: true })]);
    expect(brief(pieces)).toEqual(["md:글", "ui:a", "cards:late+legacy"]);
  });

  it("marks only the run that ends the text as the tail, and holds a place for a component being written", () => {
    const streaming = [md(0, "글\n\n"), ui(3, 20, "a")];
    // The text ends with a UI block: no Markdown tail (no caret there).
    expect(brief(answerPieces(streaming, 20, undefined))).toEqual(["md:글\n\n", "ui:a"]);
    // A top-level component whose tag is still arriving gets a placeholder; a nested one does not.
    expect(brief(answerPieces([md(0, "글\n\n")], 3, undefined, { tag: "chart", top: true }))).toEqual(["md:글\n\n|", "pending:chart"]);
    expect(brief(answerPieces([md(0, "글\n\n")], 3, undefined, { tag: "chart", top: false }))).toEqual(["md:글\n\n|"]);
    expect(brief(answerPieces([md(0, "글\n\n")], 3, undefined, { top: true }))).toEqual(["md:글\n\n|"]);
  });

  it("ignores the attachment of a retired canvas widget", () => {
    const widgetAtt = { id: "cv1", kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", anchor: 1 } as any;
    expect(brief(answerPieces([md(0, "가나")], 2, [widgetAtt, card("f1", 1)]))).toEqual(["md:가", "cards:f1", "md:나|"]);
  });
});

describe("the retired canvas widget on the client", () => {
  it("its attachment is not a card of the bubble", () => {
    const widgetAtt = { id: "cv1", kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", anchor: 2 } as any;
    const segments = segmentAttachments("가나다라", [widgetAtt, card("f1", 3)]);
    expect(segments.map((seg) => [seg.text, seg.atts.map((a) => a.id)])).toEqual([
      ["가나다", ["f1"]],
      ["라", []],
    ]);
  });

  it("a stored widget canvas is a panel tab like any other canvas", () => {
    const pane = {
      canvases: [
        { id: "md", title: "문서", content: "", contentType: "markdown" },
        { id: "old", title: "옛 위젯", content: "{@state n = 1}", contentType: "widget" },
      ],
      fileTabs: [],
      sideTab: null,
    } as any;
    expect(panelCanvases(pane).map((c) => c.id)).toEqual(["md", "old"]);
    expect(sideTabs(pane).map((t) => t.id)).toEqual(["md", "old"]);
    expect(hasSideTabs(pane)).toBe(true);
    expect(resolveSideTab(pane)).toEqual({ kind: "canvas", id: "old" });
  });
});
