import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildCanvasTools,
  CANVAS_SHOW_CONTENT_TYPES,
  MAX_CANVAS_CONTENT_CHARS,
  VEGA_RETIRED_ERROR,
  WIDGET_RETIRED_ERROR,
} from "../src/server/agent/canvasTools.js";
import type { CanvasRequest, CanvasResult } from "../src/server/agent/events.js";
import { callTool } from "./helpers.js";

// The canvas is a SIDE-PANEL artifact. Interactive UI the user only looks at or
// operates is inline UI in the answer text (no tool), and the canvas `widget`
// content type that used to carry it is retired — but a conversation whose
// prompt was frozen before the retirement still calls it, so that call must be
// answered with a redirect. tests/agent-run.test.ts makes the same call through
// real MCP (zod included); this file pins the tool's own text and order.
//
// The `vega` content type is retired the same way (2026-11-12, the app no
// longer carries a Vega renderer): a chart is an inline <chart> in the answer,
// and on a canvas a mermaid chart.

function harness() {
  const shown: CanvasRequest[] = [];
  const tools = buildCanvasTools({
    emitCanvas: async (req): Promise<CanvasResult> => {
      shown.push(req);
      return { behavior: "shown" };
    },
  });
  return { tools, shown, show: tools.find((t) => t.name === "show")! };
}

const WIDGET = `{@state n = 1}\n<slider label="n" value={n} onChange={setN} min={1} max={9} />\n<stat label="double" value={n * 2} />`;

describe("canvas content types (`widget` and `vega` are retired)", () => {
  it("lists exactly the four side-panel types in the schema — `widget` and `vega` are not advertised anywhere", () => {
    const { show } = harness();
    expect(CANVAS_SHOW_CONTENT_TYPES).toEqual(["markdown", "mermaid", "svg", "html"]);
    // What tools/list serves: a string with the enum (zod itself accepts any
    // string, so the handler — not a bare validation error — answers 'widget').
    const listed = z.toJSONSchema(z.object(show.inputSchema)) as { properties: Record<string, { type?: string; enum?: string[]; description?: string }> };
    expect(listed.properties.contentType).toMatchObject({ type: "string", enum: ["markdown", "mermaid", "svg", "html"] });
    expect(z.object(show.inputSchema).safeParse({ title: "t", content: "c", contentType: "widget" }).success).toBe(true);
    expect(z.object(show.inputSchema).safeParse({ title: "t", content: "{}", contentType: "vega" }).success).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("widget");
    expect(JSON.stringify(listed).toLowerCase()).not.toContain("vega");
    expect(show.description).not.toContain("widget");
    expect(show.description.toLowerCase()).not.toContain("vega");
    expect(show.description).not.toContain("EXPERIMENTAL");
  });

  it("describes the division of labour: a side-panel artifact here, what the user only sees or operates as inline UI in the answer", () => {
    const { show } = harness();
    expect(show.description).toContain(
      "Show a visual canvas in the chat side panel: an ARTIFACT you work on WITH the user — a document to edit, a page mockup or layout, a diagram, an option comparison, a chart that will be refined, exported or needs controls — or anything the user asks to see in the side panel.",
    );
    expect(show.description).toContain(
      "NOT for a chart, table, calculator or dashboard the user only needs to SEE or operate in the answer: that is inline UI, written directly in your answer text with no tool call (manual topic `inline-ui`; `mcp__system__describe_system` says whether this run has it).",
    );
    // The standing rules of the tool are untouched.
    for (const type of ["'markdown' (rich text)", "'mermaid' (a flow/sequence/graph diagram, or a simple chart as `xychart-beta` / `pie`", "'svg' (an inline <svg>", "or 'html' (a static page"]) {
      expect(show.description).toContain(type);
    }
    expect(show.description).toContain("it is sanitized away");
    expect(show.description).toContain("On this runtime the tool NEVER waits");
    expect(show.description).toContain("use the built-in AskUserQuestion tool instead");
    expect(show.description).toContain("call show again with the SAME `canvasId`");
  });

  it("answers the retired 'widget' with a redirect to inline UI — before every other check, and shows nothing", async () => {
    expect(WIDGET_RETIRED_ERROR).toBe(
      "contentType 'widget' is retired: interactive UI is no longer a canvas. It is now written directly in your answer text (inline UI) and the user's app draws it in place — " +
        "read mcp__system__read_manual topic `inline-ui`, then write the tags in your answer; there is no tool to call for it. " +
        "(mcp__system__describe_system says whether inline UI is available in this run; where it is not, use 'mermaid' for a chart — `xychart-beta` or `pie` — or 'markdown'.) Nothing was shown.",
    );
    const { tools, shown } = harness();
    const variants: Record<string, unknown>[] = [
      { title: "배수 계산", content: WIDGET, contentType: "widget" },
      { title: "t", content: WIDGET, contentType: " widget " }, // trimmed, like canvasId
      { title: "t", content: WIDGET, contentType: "widget", canvasId: "w-1" }, // refining an old one
      { title: "t", content: WIDGET, contentType: "widget", controls: [{ type: "text", id: "note" }], editable: true },
      // …even when another check would fire: the avatar must hear where the feature went.
      { title: "t", content: "x".repeat(MAX_CANVAS_CONTENT_CHARS + 1), contentType: "widget" },
      { title: "t".repeat(500), content: WIDGET, contentType: "widget" },
    ];
    for (const args of variants) {
      const res = await callTool(tools, "show", args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(WIDGET_RETIRED_ERROR);
    }
    expect(shown).toHaveLength(0);
  });

  it("answers the retired 'vega' with where charts went — before every other check, and shows nothing", async () => {
    expect(VEGA_RETIRED_ERROR).toBe(
      "contentType 'vega' is retired: the app no longer has a Vega-Lite renderer. " +
        "A chart the user only needs to see or hover goes directly in your answer text as inline UI — " +
        '`<chart type="bar" data={[…rows]} xKey="…" series={["…"]} />` (bar, line, area, pie, donut; ' +
        "read mcp__system__read_manual topic `inline-ui`; mcp__system__describe_system says whether inline UI is available in this run). " +
        "For a chart on a canvas, or where inline UI is not available, call show again with contentType 'mermaid' and a mermaid chart " +
        "(`xychart-beta` for bars and lines, `pie` for shares), or 'svg' for a bespoke drawing, or give the numbers as a 'markdown' table. " +
        "Nothing was shown.",
    );
    const { tools, shown } = harness();
    const spec = JSON.stringify({ mark: "bar", data: { values: [{ a: 1 }] } });
    const variants: Record<string, unknown>[] = [
      { title: "월별 매출", content: spec, contentType: "vega" },
      { title: "t", content: spec, contentType: " vega " },
      { title: "t", content: spec, contentType: "vega", canvasId: "v-1" }, // refining a chart shown before the retirement
      { title: "t", content: "x".repeat(MAX_CANVAS_CONTENT_CHARS + 1), contentType: "vega" },
    ];
    for (const args of variants) {
      const res = await callTool(tools, "show", args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(VEGA_RETIRED_ERROR);
    }
    expect(shown).toHaveLength(0);
  });

  it("refuses a content type that never existed with the list of real ones", async () => {
    const { tools, shown } = harness();
    for (const contentType of ["pdf", "Widget", "", "markdown2"]) {
      const res = await callTool(tools, "show", { title: "t", content: "x", contentType });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(
        `Unknown contentType '${contentType}'. Use one of: 'markdown', 'mermaid', 'svg', 'html'. Nothing was shown.`,
      );
    }
    // An absurd value is quoted bounded.
    const long = await callTool(tools, "show", { title: "t", content: "x", contentType: "z".repeat(5000) });
    expect(long.content[0].text!.length).toBeLessThan(200);
    expect(shown).toHaveLength(0);
  });

  it("still shows every remaining type, display-only without controls", async () => {
    const { tools, shown } = harness();
    const sources: Record<string, string> = {
      markdown: "# hi",
      mermaid: "flowchart LR\n  A --> B",
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>',
      html: "<p>hi</p>",
    };
    for (const contentType of CANVAS_SHOW_CONTENT_TYPES) {
      const res = await callTool(tools, "show", { title: contentType, content: sources[contentType]!, contentType });
      expect(res.isError, `${contentType}: ${res.content[0].text}`).toBeFalsy();
    }
    expect(shown.map((req) => req.contentType)).toEqual([...CANVAS_SHOW_CONTENT_TYPES]);
    for (const req of shown) {
      expect(req).toMatchObject({ awaitInput: false, editable: false });
      expect(req.interaction).toBeUndefined();
      expect(req).not.toHaveProperty("anchor");
    }
    // Controls are what make a canvas async — nothing else does any more.
    await callTool(tools, "show", { title: "t", content: "# q", contentType: "markdown", controls: [{ type: "text", id: "note" }] });
    expect(shown.at(-1)!.interaction).toBe("async");
  });

  it("words the size-cap error with the mermaid-chart advice", async () => {
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", { title: "t", content: "x".repeat(MAX_CANVAS_CONTENT_CHARS + 1), contentType: "svg" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("too large");
    expect(res.content[0].text).toContain("for a chart prefer a mermaid `xychart-beta` / `pie` over hand-written SVG");
    expect(shown).toHaveLength(0);
  });
});
