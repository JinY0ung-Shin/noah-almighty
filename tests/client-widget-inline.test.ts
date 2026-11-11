// Where a canvas is drawn: a `widget` in the chat bubble that carries its
// attachment, every other type — and a widget with no attachment — in the side
// panel (lib/sidePanel.ts), and one widget card per message (lib/bubbleSegments.ts).
import { describe, expect, it } from "vitest";

import { segmentAttachments } from "../src/client/src/lib/bubbleSegments.js";
import {
  hasSideTabs,
  isInlineCanvas,
  isWidgetAttachment,
  neighborTab,
  panelCanvases,
  resolveSideTab,
  sideTabs,
  widgetHome,
} from "../src/client/src/lib/sidePanel.js";

const widgetAtt = (id: string, anchor?: number) => ({ id, kind: "widget", mediaType: "application/vnd.noah.canvas-widget+json", name: "위젯", anchor }) as any;
const widget = (id: string, over: Record<string, unknown> = {}) => ({ id, title: id, content: "", contentType: "widget", ...over }) as any;
const other = (id: string, contentType = "markdown", over: Record<string, unknown> = {}) => ({ id, title: id, content: "", contentType, ...over }) as any;
const message = (id: string, attachments?: unknown[]) => ({ id, role: "assistant", content: "", attachments }) as any;

function pane(over: Record<string, unknown>): any {
  return { canvases: [], fileTabs: [], messages: [], liveAttachments: [], streaming: false, liveRunId: null, sideTab: null, ...over };
}

describe("where a canvas is drawn", () => {
  it("a widget with an attachment is inline; every other canvas, and a widget without one, is a panel tab", () => {
    const p = pane({
      canvases: [widget("w-inline"), other("md"), widget("w-legacy"), other("chart", "vega")],
      messages: [message("m1", [widgetAtt("w-inline")]), message("m2")],
    });
    expect(panelCanvases(p).map((c: any) => c.id)).toEqual(["md", "w-legacy", "chart"]);
    expect(sideTabs(p).map((t) => t.id)).toEqual(["md", "w-legacy", "chart"]);
    expect(isInlineCanvas(p, p.canvases[0])).toBe(true);
    expect(isInlineCanvas(p, p.canvases[2])).toBe(false); // the safety net: it is never without a place
    // An attachment id that names a NON-widget canvas does not pull that canvas out of the panel.
    const q = pane({ canvases: [other("md")], messages: [message("m1", [widgetAtt("md")])] });
    expect(sideTabs(q).map((t) => t.id)).toEqual(["md"]);
  });

  it("a pane whose only canvases are inline widgets has no panel at all, and never selects one", () => {
    const p = pane({ canvases: [widget("w1"), widget("w2")], messages: [message("m1", [widgetAtt("w1"), widgetAtt("w2")])] });
    expect(hasSideTabs(p)).toBe(false);
    expect(resolveSideTab(p)).toBeNull();
    // A stale selection of an inline widget does not resurrect it as a tab.
    expect(resolveSideTab({ ...p, sideTab: { kind: "canvas", id: "w1" } })).toBeNull();
    // With a file open the panel is there for the file only.
    const withFile = { ...p, fileTabs: [{ attachment: { id: "f1" }, slides: [] }] };
    expect(hasSideTabs(withFile)).toBe(true);
    expect(resolveSideTab(withFile)).toEqual({ kind: "file", id: "f1" });
    expect(neighborTab(withFile, { kind: "file", id: "f1" })).toBeNull();
  });

  it("the default tab and a pending ask ignore inline widgets", () => {
    const p = pane({
      canvases: [other("md"), widget("w1", { pending: true })],
      messages: [message("m1", [widgetAtt("w1")])],
    });
    expect(resolveSideTab(p)).toEqual({ kind: "canvas", id: "md" });
  });

  it("a live widget whose attachment has not arrived yet stays out of the panel while its run streams", () => {
    const canvases = [widget("w-live", { inlineRunId: "run-1" })];
    // The canvas frame came first: nothing in the messages yet.
    expect(hasSideTabs(pane({ canvases, streaming: true, liveRunId: "run-1" }))).toBe(false);
    // The attachment arrives in the live bubble.
    expect(hasSideTabs(pane({ canvases, streaming: true, liveRunId: "run-1", liveAttachments: [widgetAtt("w-live")] }))).toBe(false);
    // The run ended and no attachment was ever stored (an older server): the widget becomes a tab.
    expect(sideTabs(pane({ canvases, streaming: false, liveRunId: "run-1" })).map((t) => t.id)).toEqual(["w-live"]);
    // Another run streaming later does not hide it again.
    expect(sideTabs(pane({ canvases, streaming: true, liveRunId: "run-2" })).map((t) => t.id)).toEqual(["w-live"]);
  });

  it("a widget's home is the NEWEST message that carries its attachment — the live bubble first", () => {
    const first = [widgetAtt("w1")];
    const second = [widgetAtt("w1"), widgetAtt("w2")];
    const live = [widgetAtt("w1")];
    const p = pane({ messages: [message("m1", first), message("m2"), message("m3", second)] });
    expect(widgetHome(p, "w1")).toBe(second);
    expect(widgetHome(p, "w2")).toBe(second);
    expect(widgetHome(p, "nope")).toBeNull();
    expect(widgetHome({ ...p, liveAttachments: live }, "w1")).toBe(live);
    // A file with the same id is not a widget attachment.
    expect(widgetHome(pane({ messages: [message("m1", [{ id: "w1", kind: "file", mediaType: "application/pdf" }])] }), "w1")).toBeNull();
    expect(isWidgetAttachment(widgetAtt("x"))).toBe(true);
    expect(isWidgetAttachment({ kind: "team_brain" } as any)).toBe(false);
    expect(isWidgetAttachment(null)).toBe(false);
  });
});

describe("segmentAttachments with widget cards", () => {
  it("anchors a widget in the text like any card", () => {
    const text = "앞 문단\n\n뒤 문단";
    const segments = segmentAttachments(text, [widgetAtt("w1", 4)]);
    expect(segments.map((seg) => [seg.text, seg.atts.map((att) => att.id)])).toEqual([
      ["앞 문단", ["w1"]],
      ["\n\n뒤 문단", []],
    ]);
  });

  it("keeps ONE card per widget in a message: its latest spot", () => {
    const text = "하나 둘 셋";
    const segments = segmentAttachments(text, [widgetAtt("w1", 2), { id: "f1", kind: "file", mediaType: "application/pdf", anchor: 3 } as any, widgetAtt("w1", 5)]);
    const ids = segments.flatMap((seg) => seg.atts.map((att) => `${att.id}@${att.anchor}`));
    expect(ids).toEqual(["f1@3", "w1@5"]);
  });
});
