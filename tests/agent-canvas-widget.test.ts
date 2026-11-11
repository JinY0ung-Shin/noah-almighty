import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetCheck } from "../src/shared/widget/check.js";

// The static checker is the OTHER half of the contract (src/shared/widget): this
// file pins what `mcp__canvas__show` does with each verdict, so it scripts the
// checker. The real checker is exercised in tests/agent-tools.test.ts
// ("canvas widget … real checker") and tests/system-manual.test.ts.
const H = vi.hoisted(() => ({
  check: (source: string): unknown => ({ ok: true, submits: source.includes("<submit") }),
  sources: [] as string[],
}));
vi.mock("../src/shared/widget/check.js", () => ({
  checkWidget: (source: string) => {
    H.sources.push(source);
    return H.check(source);
  },
}));

import {
  buildCanvasTools,
  MAX_CANVAS_CONTENT_CHARS,
  WIDGET_CONTROLS_ERROR,
  WIDGET_DISABLED_ERROR,
  WIDGET_EDITABLE_ERROR,
} from "../src/server/agent/canvasTools.js";
import type { CanvasRequest, CanvasResult } from "../src/server/agent/events.js";
import { callTool } from "./helpers.js";

const WIDGET = `{@state n = 1}\n<slider label="n" value={n} onChange={setN} min={1} max={9} />\n<stat label="double" value={n * 2} />`;
const WIDGET_WITH_SUBMIT = `${WIDGET}\n<submit values={{ n }}>보내기</submit>`;

/** `flag`: "on" (default) | "off" | "absent" (the context field left out entirely). */
function harness(flag: "on" | "off" | "absent" = "on") {
  const shown: CanvasRequest[] = [];
  const tools = buildCanvasTools({
    emitCanvas: async (req): Promise<CanvasResult> => {
      shown.push(req);
      return { behavior: "shown" };
    },
    ...(flag === "absent" ? {} : { widgetEnabled: flag === "on" }),
  });
  return { tools, shown };
}

beforeEach(() => {
  H.check = (source: string): WidgetCheck => ({ ok: true, submits: source.includes("<submit") });
  H.sources = [];
});

describe("canvas `widget` content type (experimental canvasWidget)", () => {
  it("lists `widget` in the contentType enum and points at the manual topic", () => {
    const { tools } = harness();
    const show = tools.find((t) => t.name === "show")!;
    // callTool bypasses zod, so the schema itself is what proves the enum.
    const contentType = (show.inputSchema as Record<string, { options?: readonly string[] }>).contentType;
    expect(contentType.options).toEqual(["markdown", "vega", "mermaid", "svg", "html", "widget"]);
    expect(show.description).toContain("'widget' (EXPERIMENTAL");
    expect(show.description).toContain("you are NOT called again on each change");
    expect(show.description).toContain("topic `canvas-widget`");
    // The standing rules of the tool are untouched by the new type.
    expect(show.description).toContain("it is sanitized away");
    expect(show.description).toContain("On this runtime the tool NEVER waits");
  });

  it("shows a checked widget as display-only and says nothing comes back without a <submit>", async () => {
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", { title: "배수 계산", content: WIDGET, contentType: "widget" });
    expect(res.isError).toBeFalsy();
    expect(H.sources).toEqual([WIDGET]);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ contentType: "widget", content: WIDGET, awaitInput: false, editable: false });
    expect(shown[0]!.interaction).toBeUndefined();
    expect(shown[0]!.controls).toBeUndefined();
    const body = res.content[0].text;
    expect(body).toContain("recomputes locally in the user's browser");
    expect(body).toContain("you are NOT called on those changes");
    expect(body).toContain("It has no `<submit>`");
    expect(body).toContain(`canvas id: ${shown[0]!.artifactId}`);
  });

  it("marks a widget with a <submit> async: its values arrive as the next message", async () => {
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", {
      title: "배수 계산",
      content: WIDGET_WITH_SUBMIT,
      contentType: "widget",
      canvasId: "w-1",
    });
    expect(res.isError).toBeFalsy();
    expect(shown[0]!.interaction).toBe("async");
    expect(shown[0]!.awaitInput).toBe(false); // never parks the run (design D8)
    expect(shown[0]!.artifactId).toBe("w-1"); // refine-in-place works for a widget too
    const body = res.content[0].text;
    expect(body).toContain("It has a `<submit>`");
    expect(body).toContain("arrive as their NEXT message referencing this canvas");
    expect(body).toContain("canvas id: w-1");
  });

  it("returns the checker's error to the model and shows nothing", async () => {
    H.check = (): WidgetCheck => ({ ok: false, error: "line 2, column 9: unknown tag <div>. Only widget components exist." });
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", { title: "t", content: "{@state a = 1}\n<div>x</div>", contentType: "widget" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("Widget source error — the canvas was NOT shown");
    expect(res.content[0].text).toContain("line 2, column 9: unknown tag <div>");
    expect(res.content[0].text).toContain("topic `canvas-widget`");
    expect(shown).toHaveLength(0);
  });

  it("fails OPEN only when the checker itself throws (unverified, the client renders its own error)", async () => {
    H.check = () => {
      throw new Error("checker bug");
    };
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", { title: "t", content: WIDGET_WITH_SUBMIT, contentType: "widget" });
    expect(res.isError).toBeFalsy();
    expect(shown).toHaveLength(1);
    // The <submit> is still detected, so a submission is not announced as impossible.
    expect(shown[0]!.interaction).toBe("async");
  });

  it("refuses a widget unless the avatar owner enabled the experimental feature — before anything else", async () => {
    for (const flag of ["off", "absent"] as const) {
      const { tools, shown } = harness(flag);
      const res = await callTool(tools, "show", { title: "t", content: WIDGET, contentType: "widget" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toBe(WIDGET_DISABLED_ERROR);
      expect(res.content[0].text).toContain("Settings → 실험 기능");
      expect(res.content[0].text).toContain("Use 'vega' (a chart) or 'markdown' instead");
      expect(shown).toHaveLength(0);
    }
    expect(H.sources).toEqual([]); // the gate runs before the checker
    // Every other content type is untouched by the flag.
    const { tools, shown } = harness("off");
    const res = await callTool(tools, "show", { title: "t", content: "# hi", contentType: "markdown" });
    expect(res.isError).toBeFalsy();
    expect(shown).toHaveLength(1);
  });

  it("rejects `controls` and `editable` on a widget with the <submit> redirect", async () => {
    const { tools, shown } = harness();
    const withControls = await callTool(tools, "show", {
      title: "t",
      content: WIDGET,
      contentType: "widget",
      controls: [{ type: "text", id: "note" }],
    });
    expect(withControls.isError).toBe(true);
    expect(withControls.content[0].text).toBe(WIDGET_CONTROLS_ERROR);
    expect(withControls.content[0].text).toContain("<submit values={{ key: value }}>");

    const editable = await callTool(tools, "show", { title: "t", content: WIDGET, contentType: "widget", editable: true });
    expect(editable.isError).toBe(true);
    expect(editable.content[0].text).toBe(WIDGET_EDITABLE_ERROR);

    expect(shown).toHaveLength(0);
    expect(H.sources).toEqual([]); // neither reaches the checker

    // `editable:false` and an empty controls array are not a conflict.
    const ok = await callTool(tools, "show", { title: "t", content: WIDGET, contentType: "widget", editable: false, controls: [] });
    expect(ok.isError).toBeFalsy();
  });

  it("words the size-cap error for a widget (no vega advice) and never checks an oversized source", async () => {
    const { tools, shown } = harness();
    const res = await callTool(tools, "show", {
      title: "t",
      content: "x".repeat(MAX_CANVAS_CONTENT_CHARS + 1),
      contentType: "widget",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("too large");
    expect(res.content[0].text).toContain("inline less data");
    expect(res.content[0].text).not.toContain("Vega-Lite");
    expect(shown).toHaveLength(0);
    expect(H.sources).toEqual([]);
  });
});
