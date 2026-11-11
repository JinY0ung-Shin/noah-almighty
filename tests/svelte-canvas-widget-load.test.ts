// A widget's library and components are a lazy chunk. A chunk that fails to
// load (offline, a deploy that replaced it) is not a broken widget: the tab
// says so in its own words and offers to try again.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SidePanel from "../src/client/src/components/SidePanel.svelte";
import { CANVAS_REPORT_DELAY_MS, resetCanvasRenderReports } from "../src/client/src/lib/canvasReport.js";
import { replaceState } from "../src/client/src/lib/state.js";

const load = vi.hoisted(() => ({ fail: true, attempts: 0 }));

vi.mock("../src/client/src/components/widget/WidgetView.svelte", async (original) => {
  load.attempts += 1;
  if (load.fail) throw new TypeError("Failed to fetch dynamically imported module");
  return await original();
});

function widgetPane(content: string): any {
  return {
    id: "p1",
    streaming: false,
    sideTab: { kind: "canvas", id: "cv1" },
    conversationId: "conv-1",
    liveAttachments: [],
    fileTabs: [],
    canvases: [{ id: "cv1", title: "계산기", content, contentType: "widget" }],
  };
}

beforeEach(() => {
  resetCanvasRenderReports();
  load.fail = true;
  load.attempts = 0;
  replaceState({ chatPanes: [], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
});

describe("SidePanel widget canvas — a chunk that does not load", () => {
  it("says the widget could not be loaded (not that its source is wrong) and retries on request", async () => {
    // A chunk that did not load is not the avatar's mistake: nothing is reported for it.
    const fetchFn = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchFn);
    const { container } = render(SidePanel, { props: { pane: widgetPane("{@state n = 1}\n\n<text>값 {n}</text>\n") } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("위젯을 불러오지 못했습니다. 다시 시도하거나 새로고침해 주세요.");
    expect(alert.textContent).not.toContain("위젯 소스에 오류");
    expect(container.querySelector(".wg-root")).toBeNull();
    expect(container.querySelector(".canvas-content pre")?.textContent).toContain("{@state n = 1}"); // the source, meanwhile
    const before = load.attempts;
    await new Promise((resolve) => setTimeout(resolve, CANVAS_REPORT_DELAY_MS + 150));
    expect(fetchFn).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    // Still failing: the message and the retry stay.
    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(load.attempts).toBeGreaterThan(before));
    expect((await screen.findByRole("alert")).textContent).toContain("위젯을 불러오지 못했습니다.");

    // The chunk is reachable again: the retry draws the widget.
    load.fail = false;
    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("값 1")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });
});
