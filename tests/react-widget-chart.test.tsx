// WidgetChart — an inline <chart>, drawn with Recharts.
//
// The frame (WidgetChart) has the chart's height from its first frame, loads
// the drawing on demand and, when the chart is to arrive with motion, holds it
// back until the frame is on screen. The drawing (ChartDrawing) is the
// library's: bars, lines, slices, a legend, a tooltip. jsdom has no layout, so
// what is checked here is WHAT is drawn and WHEN it is mounted; how it looks
// and moves is the Playwright suite's (inline-ui.spec.ts, ui-gallery.spec.ts).
//
// Runs in the vitest "react" project.
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WidgetChart, { DEFAULT_CHART_HEIGHT } from "../src/client/src/components/widget/WidgetChart";
import { resetEntrances, type EntranceRule } from "../src/client/src/lib/uiEntrance";
import { normalizeProps, simpleChartModel, type SimpleChartModel } from "../src/shared/widget/index";

function model(props: Record<string, unknown>): SimpleChartModel {
  const read = simpleChartModel(normalizeProps("chart", props).props);
  if (!read.model) throw new Error("no model: " + read.problems.join("; "));
  return read.model;
}

const MONTHLY = [
  { month: "7월", sales: 120, cost: 80 },
  { month: "8월", sales: 150, cost: 90 },
  { month: "9월", sales: 175, cost: 95 },
];
const SERIES = [
  { key: "sales", label: "매출" },
  { key: "cost", label: "비용" },
];

const host = (): HTMLElement => document.querySelector<HTMLElement>(".wg-chart")!;
const drawn = (selector: string): number => document.querySelectorAll(`.wg-chart ${selector}`).length;

/** An IntersectionObserver the test fires by hand. */
function fakeObserver(): { show(): void } {
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        callbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  return { show: () => act(() => callbacks.forEach((callback) => callback([{ isIntersecting: true }]))) };
}

// jsdom lays nothing out, and the chart library sizes itself from its
// container's measured box: give that container a size, as a browser would.
const measure = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  resetEntrances();
  document.documentElement.removeAttribute("data-motion");
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList.contains("recharts-responsive-container")) return { x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 240, width: 480, height: 240, toJSON: () => ({}) } as DOMRect;
    return measure.call(this);
  };
});
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = measure;
  vi.unstubAllGlobals();
});

describe("WidgetChart", () => {
  it("draws the bars, the legend and the title of a grouped bar chart", async () => {
    render(<WidgetChart model={model({ data: MONTHLY, xKey: "month", series: SERIES, unit: "만원", title: "월별 매출과 비용" })} />);
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6)); // 3 months × 2 series
    expect(screen.getByRole("group", { name: "월별 매출과 비용" })).toBe(host());
    expect(host().querySelector(".wg-chart-title")?.textContent).toBe("월별 매출과 비용");
    const legend = [...document.querySelectorAll(".recharts-legend-item-text")].map((node) => node.textContent);
    expect(legend).toEqual(["매출", "비용"]);
  });

  it("draws one mark per series for a line and an area, and one slice per row for a pie and a donut", async () => {
    const line = render(<WidgetChart model={model({ type: "line", data: MONTHLY, xKey: "month", series: SERIES })} />);
    await waitFor(() => expect(drawn(".recharts-line-curve")).toBe(2));
    line.unmount();
    const area = render(<WidgetChart model={model({ type: "area", stacked: true, data: MONTHLY, xKey: "month", series: SERIES })} />);
    await waitFor(() => expect(drawn(".recharts-area-area")).toBe(2));
    area.unmount();
    const share = [
      { team: "플랫폼", share: 45 },
      { team: "제품", share: 35 },
      { team: "디자인", share: 20 },
    ];
    const pie = render(<WidgetChart model={model({ type: "pie", data: share, xKey: "team" })} />);
    await waitFor(() => expect(drawn(".recharts-pie-sector")).toBe(3));
    // The legend keeps the rows' own order (the slices are laid out largest first).
    expect([...document.querySelectorAll(".recharts-legend-item-text")].map((node) => node.textContent)).toEqual(["플랫폼", "제품", "디자인"]);
    pie.unmount();
    render(<WidgetChart model={model({ type: "donut", data: share, xKey: "team" })} />);
    await waitFor(() => expect(drawn(".recharts-pie-sector")).toBe(3));
  });

  it("has its height before anything is drawn — the answer below never jumps", () => {
    render(<WidgetChart model={model({ data: MONTHLY })} />);
    // First frame: the chart library is not even loaded yet.
    expect(host().querySelector<HTMLElement>(".wg-chart-plot")?.style.height).toBe(`${DEFAULT_CHART_HEIGHT}px`);
    render(<WidgetChart model={model({ data: MONTHLY })} height={320} />);
    expect([...document.querySelectorAll<HTMLElement>(".wg-chart-plot")].at(-1)?.style.height).toBe("320px");
  });

  it("says so when there is nothing to plot, and names the retired form when the answer used it", () => {
    const empty = render(<WidgetChart model={null} />);
    expect(host().textContent).toBe("표시할 차트가 없습니다.");
    expect(host().querySelector(".wg-chart-plot")).toBeNull();
    empty.unmount();
    render(<WidgetChart model={null} retired />);
    expect(host().textContent).toBe("예전 형식(Vega-Lite 스펙)으로 작성된 차트라 더 이상 그릴 수 없습니다.");
  });
});

describe("WidgetChart entrance", () => {
  const rule: EntranceRule = { scope: "test", always: true };

  it("holds a chart that will enter until its frame is on screen, then draws it", async () => {
    const observer = fakeObserver();
    render(<WidgetChart model={model({ data: MONTHLY })} entrance={rule} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60)); // the chunk is here by now
    });
    expect(drawn(".recharts-bar-rectangle")).toBe(0); // off screen: nothing spent
    expect(host().querySelector<HTMLElement>(".wg-chart-plot")?.style.height).toBe(`${DEFAULT_CHART_HEIGHT}px`); // …and its place is held

    observer.show();
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6));
  });

  it("draws at once the chart whose entrance was already played elsewhere (the stored message taking over from the live bubble)", async () => {
    const once: EntranceRule = { scope: "pane-1", always: false };
    const chart = model({ data: MONTHLY });
    // The live bubble's chart: on screen, it enters.
    const observer = fakeObserver();
    const live = render(<WidgetChart model={chart} entrance={once} />);
    observer.show();
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6));
    live.unmount();

    // The stored message mounts the same chart: nothing to wait for — drawn without the screen saying anything.
    fakeObserver(); // never fires
    render(<WidgetChart model={model({ data: MONTHLY })} entrance={once} />);
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6));
  });

  it("draws at once a chart with no entrance (an answer from the history), on screen or not", async () => {
    fakeObserver(); // never fires
    render(<WidgetChart model={model({ data: MONTHLY })} entrance={null} />);
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6));
  });

  it("draws at once under the app's 움직임 줄이기, whatever the entrance rule says", async () => {
    document.documentElement.setAttribute("data-motion", "reduce");
    fakeObserver(); // never fires
    render(<WidgetChart model={model({ data: MONTHLY })} entrance={rule} />);
    await waitFor(() => expect(drawn(".recharts-bar-rectangle")).toBe(6));
  });
});
