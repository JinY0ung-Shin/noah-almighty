// WidgetChart — the answer must not jump around a chart.
//
// Drawing is asynchronous, so for a moment after a <chart> tag has arrived
// there is nothing to show. The chart used to have no height in that moment:
// the text that follows it was painted in its place and pushed down when the
// drawing landed, and at the end of a turn (the stored message replacing the
// live bubble) every chart blinked out and back. Now the place is held, and a
// chart that mounts with a spec drawn a moment ago is there in its first frame.
//
// Runs in the vitest "react" project. Vega is replaced by a render the test
// resolves by hand; real drawing is the Playwright suite's (inline-ui.spec.ts).
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pending: Array<(markup: string) => void> = [];
const renderVegaSvg = vi.fn(() => new Promise<string>((resolve) => pending.push(resolve)));
vi.mock("../src/client/src/lib/vegaCanvas", () => ({ renderVegaSvg: (...args: unknown[]) => renderVegaSvg(...(args as [])) }));

import WidgetChart, { forgetDrawnCharts } from "../src/client/src/components/widget/WidgetChart";

const SPEC = { mark: "bar", height: 180, data: { values: [{ a: "가", b: 1 }] }, encoding: { x: { field: "a" }, y: { field: "b", type: "quantitative" } } };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="10" height="10"/></svg>';

/** Let the chart's animation frame fire (it coalesces renders into one per frame). */
const frame = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
const host = (): HTMLElement => document.querySelector<HTMLElement>(".wg-chart")!;

beforeEach(() => {
  pending.length = 0;
  renderVegaSvg.mockClear();
  forgetDrawnCharts();
});

describe("WidgetChart holds its place", () => {
  it("reserves a height while the drawing is on its way, and gives it up when the drawing lands", async () => {
    render(<WidgetChart spec={SPEC} />);
    await frame();

    expect(renderVegaSvg).toHaveBeenCalledTimes(1);
    expect(host().querySelector(".canvas-svg")).toBeNull();
    expect(parseFloat(host().style.minHeight)).toBeGreaterThan(150); // the spec's 180 plus the axes, not 0

    await act(async () => pending[0](SVG));

    expect(host().querySelector(".canvas-svg")).not.toBeNull();
    expect(host().style.minHeight).toBe("");
  });

  it("is on screen in its first frame when the same chart was drawn a moment ago — no second render", async () => {
    const live = render(<WidgetChart spec={SPEC} />);
    await frame();
    await act(async () => pending[0](SVG));
    live.unmount(); // the live bubble goes; the stored message mounts its own chart

    render(<WidgetChart spec={{ ...SPEC }} />);

    expect(host().querySelector(".canvas-svg")).not.toBeNull(); // no frame, no await
    await frame();
    expect(renderVegaSvg).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a drawing for another spec or another theme", async () => {
    const first = render(<WidgetChart spec={SPEC} />);
    await frame();
    await act(async () => pending[0](SVG));
    first.unmount();

    const other = render(<WidgetChart spec={{ ...SPEC, height: 120 }} />);
    expect(host().querySelector(".canvas-svg")).toBeNull();
    await frame();
    expect(renderVegaSvg).toHaveBeenCalledTimes(2);
    other.unmount();

    render(<WidgetChart spec={SPEC} dark />);
    expect(host().querySelector(".canvas-svg")).toBeNull();
    await frame();
    expect(renderVegaSvg).toHaveBeenCalledTimes(3);
  });

  it("holds nothing for a chart with nothing to draw, or one that failed", async () => {
    const empty = render(<WidgetChart spec={null} />);
    expect(host().style.minHeight).toBe("");
    expect(host().textContent).toContain("표시할 차트가 없습니다.");
    empty.unmount();

    renderVegaSvg.mockImplementationOnce(() => Promise.reject(new Error("bad spec")));
    render(<WidgetChart spec={SPEC} />);
    await frame();
    await act(async () => {});
    expect(host().querySelector('[role="alert"]')?.textContent).toContain("차트를 그리지 못했습니다");
    expect(host().style.minHeight).toBe("");
  });
});
