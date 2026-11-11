// @vitest-environment jsdom
// lib/canvasReport.ts — the viewer's browser tells the avatar that a canvas it
// showed did not render: once per (canvas, content, line), only while that
// content is still on screen, and never loudly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CANVAS_REPORT_DELAY_MS,
  MAX_REPORTS_PER_CONTENT,
  MAX_REPORT_ERROR_CHARS,
  queueCanvasRenderReport,
  resetCanvasRenderReports,
} from "../src/client/src/lib/canvasReport.js";
import { replaceState } from "../src/client/src/lib/state.js";

type Posted = { url: string; body: { conversationId: string; errors: string[] } };

function useFetch(impl: () => Promise<unknown> = async () => ({ ok: true, status: 204 })) {
  const posted: Posted[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      expect(init.method).toBe("POST");
      return impl();
    }),
  );
  return posted;
}

const base = { canvasId: "cv1", conversationId: "conv-1", content: "v1", stillCurrent: () => true };

beforeEach(() => {
  vi.useFakeTimers();
  resetCanvasRenderReports();
  replaceState({ user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("queueCanvasRenderReport", () => {
  it("posts the errors once, after a moment, to the canvas's report route", () => {
    const posted = useFetch();
    queueCanvasRenderReport({ ...base, errors: ["line 3:1 <text>: x is not defined"] });
    queueCanvasRenderReport({ ...base, errors: ["line 3:1 <text>: x is not defined", "line 5:1 <chart>: bad spec"] });
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted).toEqual([
      { url: "/api/canvases/cv1/render-report", body: { conversationId: "conv-1", errors: ["line 3:1 <text>: x is not defined", "line 5:1 <chart>: bad spec"] } },
    ]);

    // The same canvas renders again (a tab switch, a theme flip, a widget re-evaluation): nothing new, nothing sent.
    queueCanvasRenderReport({ ...base, errors: ["line 3:1 <text>: x is not defined", "line 5:1 <chart>: bad spec"] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS * 2);
    expect(posted).toHaveLength(1);

    // A line that was not there before goes out on its own.
    queueCanvasRenderReport({ ...base, errors: ["line 3:1 <text>: x is not defined", "an event handler failed: boom"] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted[1].body.errors).toEqual(["an event handler failed: boom"]);
  });

  it("does not report a version that is no longer on screen (a replayed older frame)", () => {
    const posted = useFetch();
    // The reattach replay draws the previous, broken version for an instant…
    queueCanvasRenderReport({ ...base, content: "old", errors: ["old version error"], stillCurrent: () => false });
    // …and then the current one, which renders fine (no call at all).
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS * 2);
    expect(posted).toEqual([]);

    // A new version with its own error replaces what was waiting for the old one.
    queueCanvasRenderReport({ ...base, content: "v1", errors: ["first"] });
    queueCanvasRenderReport({ ...base, content: "v2", errors: ["second"] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted.map((p) => p.body.errors)).toEqual([["second"]]);

    // An error that was dropped because its content was off screen is reported when it is shown for real.
    let shown = false;
    queueCanvasRenderReport({ ...base, content: "v3", errors: ["third"], stillCurrent: () => shown });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted).toHaveLength(1);
    shown = true;
    queueCanvasRenderReport({ ...base, content: "v3", errors: ["third"], stillCurrent: () => shown });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted.at(-1)?.body.errors).toEqual(["third"]);
  });

  it("sends at most five lines of at most 300 characters, a few times per content", () => {
    const posted = useFetch();
    queueCanvasRenderReport({ ...base, errors: Array.from({ length: 9 }, (_, i) => `error ${i} ${"x".repeat(400)}`) });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted[0].body.errors).toHaveLength(5);
    for (const line of posted[0].body.errors) expect(line.length).toBeLessThanOrEqual(MAX_REPORT_ERROR_CHARS);

    // A widget whose errors change with its state cannot trickle forever.
    for (let i = 0; i < 10; i++) {
      queueCanvasRenderReport({ ...base, errors: [`state-dependent error ${i}`] });
      vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    }
    expect(posted).toHaveLength(MAX_REPORTS_PER_CONTENT);
    // New content starts over.
    queueCanvasRenderReport({ ...base, content: "v2", errors: ["fresh"] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted).toHaveLength(MAX_REPORTS_PER_CONTENT + 1);
  });

  it("reports only for a signed-in viewer inside a conversation", () => {
    const posted = useFetch();
    queueCanvasRenderReport({ ...base, conversationId: null, errors: ["x"] });
    queueCanvasRenderReport({ ...base, conversationId: "", errors: ["x"] });
    replaceState({ user: null } as unknown as Parameters<typeof replaceState>[0]);
    queueCanvasRenderReport({ ...base, errors: ["x"] });
    queueCanvasRenderReport({ ...base, errors: [] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS * 2);
    expect(posted).toEqual([]);
  });

  it("keeps the same canvas id in two conversations apart", () => {
    const posted = useFetch();
    queueCanvasRenderReport({ ...base, errors: ["same line"] });
    queueCanvasRenderReport({ ...base, conversationId: "conv-2", errors: ["same line"] });
    vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS);
    expect(posted.map((p) => p.body.conversationId).sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("stays silent when the send fails", async () => {
    useFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    queueCanvasRenderReport({ ...base, errors: ["x"] });
    expect(() => vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS)).not.toThrow();
    await Promise.resolve();

    vi.stubGlobal("fetch", () => {
      throw new Error("no fetch here");
    });
    queueCanvasRenderReport({ ...base, content: "v2", errors: ["y"] });
    expect(() => vi.advanceTimersByTime(CANVAS_REPORT_DELAY_MS)).not.toThrow();
  });
});
