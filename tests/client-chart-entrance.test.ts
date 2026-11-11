// @vitest-environment jsdom
// lib/chartEntrance.ts — the entrance of an inline `<chart>`. The plan is read
// off the SVG Vega really writes (rendered here the way `renderVegaSvg` does,
// sanitizer included), so a Vega upgrade that renames a class or a role fails
// HERE instead of silently drawing every chart at rest. What the motion looks
// like is a real browser's job (tests/visual/inline-ui.spec.ts).
import DOMPurify from "dompurify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vega from "vega";
import * as vegaLite from "vega-lite";

import { chartSvg, pathBox, planChartEntrance, playChartEntrance } from "../src/client/src/lib/chartEntrance.js";
import {
  ENTRANCE_WINDOW_MS,
  claimEntrance,
  continuesEntranceText,
  noteEntranceText,
  openEntranceScope,
  resetEntrances,
  type EntranceStep,
} from "../src/client/src/lib/uiEntrance.js";
import { simpleChartSpec } from "../src/shared/widget/chart.js";

const MONTHLY = [
  { month: "7월", sales: 120, cost: 80 },
  { month: "8월", sales: 150, cost: 90 },
  { month: "9월", sales: 175, cost: 95 },
];

async function drawSpec(spec: Record<string, unknown>): Promise<HTMLElement> {
  const view = new vega.View(vega.parse(vegaLite.compile({ width: 300, height: 200, ...spec } as any).spec as any), { renderer: "none" } as any);
  const host = document.createElement("div");
  try {
    host.innerHTML = DOMPurify.sanitize(await view.toSVG(), { USE_PROFILES: { svg: true, svgFilters: true } });
  } finally {
    view.finalize();
  }
  return host;
}

async function draw(props: Record<string, unknown>): Promise<HTMLElement> {
  const { spec } = simpleChartSpec(props);
  if (!spec) throw new Error("nothing to draw");
  return drawSpec(spec);
}

function transformOf(step: EntranceStep, at: 0 | 1): string {
  return String(step.keyframes[at]?.transform ?? "");
}

function stepsOn(steps: EntranceStep[], selector: string): EntranceStep[] {
  return steps.filter((step) => step.el.matches(selector));
}

describe("pathBox", () => {
  it("reads the rectangle Vega writes for a bar", () => {
    expect(pathBox("M10,20h30v40h-30Z")).toEqual({ x0: 10, y0: 20, x1: 40, y1: 60 });
  });

  it("reads a rounded bar, whose corners are cubic curves", () => {
    expect(pathBox("M4,0L26,0C28.2,0,30,1.8,30,4L30,60L0,60L0,4C0,1.8,1.8,0,4,0Z")).toEqual({ x0: 0, y0: 0, x1: 30, y1: 60 });
  });

  it("keeps an exponent inside its number", () => {
    expect(pathBox("M1.5e1,0h1e1v5h-1e1Z")).toEqual({ x0: 15, y0: 0, x1: 25, y1: 5 });
  });

  it("gives up on a shape it does not know (an arc)", () => {
    expect(pathBox("M56,19A60,60,0,0,0,0,-60Z")).toBeNull();
    expect(pathBox("")).toBeNull();
  });
});

describe("planChartEntrance", () => {
  it("grows every bar from the line the bars stand on, one category after the other", async () => {
    const host = await draw({ type: "bar", data: MONTHLY, xKey: "month", series: [{ key: "sales" }] });
    const steps = planChartEntrance(host);
    const bars = stepsOn(steps, "g.mark-rect > path");
    expect(bars).toHaveLength(3);
    // One baseline for all of them: the plot is 200 high and a bar stands on y = 200.
    for (const bar of bars) {
      expect(transformOf(bar, 0)).toBe("translate(0px, 200px) scale(1, 0) translate(0px, -200px)");
      expect(transformOf(bar, 1)).toBe("translate(0px, 200px) scale(1, 1) translate(0px, -200px)");
    }
    const delays = bars.map((bar) => bar.delay);
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    // Axes and legends are not part of it.
    expect(steps.every((step) => !step.el.closest(".role-axis, .role-legend"))).toBe(true);
  });

  it("grows horizontal bars from the left", async () => {
    const host = await draw({ type: "bar", horizontal: true, data: MONTHLY, xKey: "month", series: [{ key: "sales" }] });
    const bars = stepsOn(planChartEntrance(host), "g.mark-rect > path");
    expect(bars).toHaveLength(3);
    for (const bar of bars) expect(transformOf(bar, 0)).toBe("translate(0px, 0px) scale(0, 1) translate(0px, 0px)");
  });

  it("keeps a stack one column: its segments share the baseline and the moment", async () => {
    const host = await draw({ type: "bar", stacked: true, data: MONTHLY, xKey: "month", series: [{ key: "sales" }, { key: "cost" }] });
    const bars = stepsOn(planChartEntrance(host), "g.mark-rect > path");
    expect(bars).toHaveLength(6);
    expect(new Set(bars.map((bar) => transformOf(bar, 0))).size).toBe(1);
    expect(new Set(bars.map((bar) => bar.delay)).size).toBe(3);
  });

  it("reads which way a stack stands from its thickness, also with more series than categories", async () => {
    const data = [
      { m: "a", p: 4, q: 3, r: 2, s: 1 },
      { m: "b", p: 1, q: 2, r: 3, s: 4 },
    ];
    const series = [{ key: "p" }, { key: "q" }, { key: "r" }, { key: "s" }];
    const upright = stepsOn(planChartEntrance(await draw({ type: "bar", stacked: true, data, xKey: "m", series })), "g.mark-rect > path");
    expect(upright).toHaveLength(8);
    expect(new Set(upright.map((bar) => transformOf(bar, 0)))).toEqual(new Set(["translate(0px, 200px) scale(1, 0) translate(0px, -200px)"]));
    const lying = stepsOn(planChartEntrance(await draw({ type: "bar", stacked: true, horizontal: true, data, xKey: "m", series })), "g.mark-rect > path");
    expect(lying).toHaveLength(8);
    expect(new Set(lying.map((bar) => transformOf(bar, 0)))).toEqual(new Set(["translate(0px, 0px) scale(0, 1) translate(0px, 0px)"]));
  });

  it("grows ranged bars, which stand on no common line, each from its own start", async () => {
    const host = await drawSpec({
      data: { values: [{ task: "a", from: 0, to: 4 }, { task: "b", from: 3, to: 8 }, { task: "c", from: 6, to: 10 }] },
      mark: "bar",
      encoding: { y: { field: "task", type: "nominal" }, x: { field: "from", type: "quantitative" }, x2: { field: "to" } },
    });
    const bars = stepsOn(planChartEntrance(host), "g.mark-rect > path");
    expect(bars).toHaveLength(3);
    // 0…10 on a 300px plot: the bars begin at x = 0, 90 and 180.
    expect(bars.map((bar) => transformOf(bar, 0))).toEqual([
      "translate(0px, 0px) scale(0, 1) translate(0px, 0px)",
      "translate(90px, 0px) scale(0, 1) translate(-90px, 0px)",
      "translate(180px, 0px) scale(0, 1) translate(-180px, 0px)",
    ]);
  });

  it("grows negative bars away from the zero line, not from the bottom of the plot", async () => {
    const host = await draw({ type: "bar", data: [{ m: "a", v: 10 }, { m: "b", v: -10 }, { m: "c", v: 5 }], xKey: "m", series: [{ key: "v" }] });
    const bars = stepsOn(planChartEntrance(host), "g.mark-rect > path");
    expect(bars).toHaveLength(3);
    // -10…10 on a 200px plot: zero is the middle.
    for (const bar of bars) expect(transformOf(bar, 0)).toBe("translate(0px, 100px) scale(1, 0) translate(0px, -100px)");
  });

  it("wipes a line in from the left, its points with it", async () => {
    const host = await draw({ type: "line", data: MONTHLY, xKey: "month", series: [{ key: "sales" }] });
    const steps = planChartEntrance(host);
    const wiped = steps.filter((step) => "clipPath" in step.keyframes[0]);
    expect(wiped.map((step) => step.el.getAttribute("class"))).toEqual([expect.stringContaining("mark-line"), expect.stringContaining("mark-symbol")]);
    expect(steps).toHaveLength(2);
    expect(wiped[0].duration).toBe(wiped[1].duration);
  });

  it("wipes an area in", async () => {
    const host = await draw({ type: "area", stacked: true, data: MONTHLY, xKey: "month", series: [{ key: "sales" }, { key: "cost" }] });
    const steps = planChartEntrance(host);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((step) => "clipPath" in step.keyframes[0])).toBe(true);
    expect(steps.some((step) => step.el.matches("g.mark-area"))).toBe(true);
  });

  it("brings the slices of a pie in one after the other while the circle settles about its centre", async () => {
    const host = await draw({ type: "donut", data: [{ team: "a", share: 45 }, { team: "b", share: 35 }, { team: "c", share: 20 }], xKey: "team", series: ["share"] });
    const steps = planChartEntrance(host);
    const slices = stepsOn(steps, "g.mark-arc > path");
    expect(slices).toHaveLength(3);
    expect(slices.map((slice) => slice.keyframes)).toEqual([[{ opacity: 0, offset: 0 }], [{ opacity: 0, offset: 0 }], [{ opacity: 0, offset: 0 }]]);
    expect(slices[1].delay).toBeGreaterThan(slices[0].delay);
    const [settle] = stepsOn(steps, "g.mark-arc");
    // A 300×200 plot: the circle's centre.
    expect(transformOf(settle, 0)).toBe("translate(150px, 100px) rotate(-24deg) scale(0.9) translate(-150px, -100px)");
    expect(transformOf(settle, 1)).toBe("translate(150px, 100px) rotate(0deg) scale(1) translate(-150px, -100px)");
  });

  it("shows the points of a scatter from left to right", async () => {
    const host = await drawSpec({
      data: { values: [{ x: 1, y: 3 }, { x: 5, y: 1 }, { x: 9, y: 2 }] },
      mark: "point",
      encoding: { x: { field: "x", type: "quantitative" }, y: { field: "y", type: "quantitative" } },
    });
    const points = stepsOn(planChartEntrance(host), "g.mark-symbol > path");
    expect(points).toHaveLength(3);
    expect(points[0].delay).toBe(0);
    expect(points[1].delay).toBeGreaterThan(0);
    expect(points[2].delay).toBeGreaterThan(points[1].delay);
  });

  it("lets what is not the main mark follow it in (value labels over bars)", async () => {
    const host = await drawSpec({
      data: { values: MONTHLY },
      encoding: { x: { field: "month", type: "nominal" }, y: { field: "sales", type: "quantitative" } },
      layer: [{ mark: "bar" }, { mark: { type: "text", dy: -6 }, encoding: { text: { field: "sales" } } }],
    });
    const steps = planChartEntrance(host);
    const [labels] = stepsOn(steps, "g.mark-text");
    expect(labels.keyframes).toEqual([{ opacity: 0, offset: 0 }]);
    expect(labels.delay).toBeGreaterThan(0);
    expect(stepsOn(steps, "g.mark-rect > path")).toHaveLength(3);
  });

  it("fades a mark it has no better idea for, at once", async () => {
    const host = await drawSpec({
      data: { values: [{ a: "x", b: "p", v: 1 }, { a: "y", b: "q", v: 2 }] },
      mark: "rect",
      encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "nominal" }, color: { field: "v", type: "quantitative" } },
    });
    const steps = planChartEntrance(host);
    expect(steps).toHaveLength(1);
    expect(steps[0].el.matches("g.mark-rect")).toBe(true);
    expect(steps[0].keyframes).toEqual([{ opacity: 0, offset: 0 }]);
    expect(steps[0].delay).toBe(0);
  });

  it("plans nothing for markup that is not a chart", () => {
    const host = document.createElement("div");
    host.innerHTML = "<svg><g><path d='M0,0h1v1h-1Z'/></g></svg>";
    expect(planChartEntrance(host)).toEqual([]);
  });
});

describe("claimEntrance (lib/uiEntrance.ts): once per answer", () => {
  beforeEach(() => {
    resetEntrances();
    vi.useFakeTimers({ toFake: ["performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets a chart enter once: the stored message that replaces the live bubble draws it at rest", () => {
    openEntranceScope("pane:1", "run-1");
    const live = claimEntrance({ scope: "pane:1", always: false }, "{spec}", true);
    expect(live?.offset).toBe(0);
    live?.started();
    vi.advanceTimersByTime(ENTRANCE_WINDOW_MS + 1);
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)).toBeNull();
  });

  it("hands the rest of a running entrance to the instance that replaces it", () => {
    const live = claimEntrance({ scope: "pane:1", always: false }, "{spec}", true);
    live?.started();
    vi.advanceTimersByTime(300);
    const stored = claimEntrance({ scope: "pane:1", always: false }, "{spec}", true);
    expect(stored?.offset).toBe(300);
  });

  it("still owes the entrance of a chart that was never on screen", () => {
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)?.offset).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)?.offset).toBe(0);
  });

  it("draws a redraw at rest, and remembers the new drawing as shown", () => {
    claimEntrance({ scope: "pane:1", always: false }, "{a}", true)?.started();
    expect(claimEntrance({ scope: "pane:1", always: false }, "{b}", false)).toBeNull();
    expect(claimEntrance({ scope: "pane:1", always: false }, "{b}", true)).toBeNull();
  });

  it("keeps panes apart", () => {
    claimEntrance({ scope: "pane:1", always: false }, "{spec}", false);
    expect(claimEntrance({ scope: "pane:2", always: false }, "{spec}", true)?.offset).toBe(0);
  });

  it("lets a chart the viewer brings up enter every time, and hands that entrance on as well", () => {
    const always = { scope: "pane:1", always: true };
    claimEntrance({ scope: "pane:1", always: false }, "{spec}", false);
    const brought = claimEntrance(always, "{spec}", true);
    expect(brought?.offset).toBe(0);
    brought?.started();
    vi.advanceTimersByTime(200);
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)?.offset).toBe(200);
    vi.advanceTimersByTime(ENTRANCE_WINDOW_MS);
    expect(claimEntrance(always, "{spec}", true)?.offset).toBe(0);
  });

  it("recognises the stored message of the answer that was just written in the pane", () => {
    expect(continuesEntranceText("pane:1", "답변")).toBe(false);
    openEntranceScope("pane:1", "run-1");
    const live = "분기 매출을 차트로 정리했습니다.\n<chart";
    noteEntranceText("pane:1", live);
    expect(continuesEntranceText("pane:1", `${live} data={rows} />\n끝.`)).toBe(true);
    expect(continuesEntranceText("pane:1", live)).toBe(true);
    // The part revealed so far of the same answer.
    expect(continuesEntranceText("pane:1", live.slice(0, 26))).toBe(true);
    // A few shared opening characters are not the same answer.
    expect(continuesEntranceText("pane:1", live.slice(0, 5))).toBe(false);
    expect(continuesEntranceText("pane:1", "다른 답변입니다. 길이는 충분히 깁니다만 다른 글입니다.")).toBe(false);
    expect(continuesEntranceText("pane:1", "")).toBe(false);
    expect(continuesEntranceText("pane:2", live)).toBe(false);
    // The next run's answer is another answer.
    openEntranceScope("pane:1", "run-2");
    expect(continuesEntranceText("pane:1", live)).toBe(false);
  });

  it("starts over for a new run in the pane, and not for the same run's remounted bubble", () => {
    openEntranceScope("pane:1", "run-1");
    claimEntrance({ scope: "pane:1", always: false }, "{spec}", false);
    openEntranceScope("pane:1", "run-1");
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)).toBeNull();
    openEntranceScope("pane:1", "run-2");
    expect(claimEntrance({ scope: "pane:1", always: false }, "{spec}", true)?.offset).toBe(0);
  });
});

describe("playChartEntrance", () => {
  interface FakeAnimation {
    state: "paused" | "running" | "cancelled";
    currentTime: number;
    options: KeyframeAnimationOptions;
    pause(): void;
    play(): void;
    cancel(): void;
  }

  let animations: FakeAnimation[];
  let observed: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; disconnected: boolean }[];

  async function chartHost(): Promise<HTMLElement> {
    const drawn = await draw({ type: "bar", data: MONTHLY, xKey: "month", series: [{ key: "sales" }] });
    const host = document.createElement("div");
    host.attachShadow({ mode: "open" }).innerHTML = drawn.innerHTML;
    return host;
  }

  function intersect(index = 0): void {
    observed[index].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
  }

  beforeEach(() => {
    resetEntrances();
    delete document.documentElement.dataset.motion;
    animations = [];
    observed = [];
    (Element.prototype as unknown as { animate: unknown }).animate = function (_keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const animation: FakeAnimation = {
        state: "running",
        currentTime: 0,
        options,
        pause() {
          this.state = "paused";
        },
        play() {
          this.state = "running";
        },
        cancel() {
          this.state = "cancelled";
        },
      };
      animations.push(animation);
      return animation;
    };
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private entry: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; disconnected: boolean };
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.entry = { callback, options, disconnected: false };
          observed.push(this.entry);
        }
        observe() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
  });
  afterEach(() => {
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
    delete document.documentElement.dataset.motion;
    vi.unstubAllGlobals();
  });

  it("holds the marks at their start until the chart is on screen, then plays", async () => {
    const host = await chartHost();
    const started = vi.fn();
    playChartEntrance(host, { offset: 0, started });
    expect(animations).toHaveLength(3);
    expect(animations.every((a) => a.state === "paused" && a.options.fill === "backwards")).toBe(true);
    expect(started).not.toHaveBeenCalled();
    // Any visible part releases it — a share of its height would hold a chart taller than the window for good.
    expect(observed[0].options?.threshold).toBe(0);
    intersect();
    expect(animations.every((a) => a.state === "running")).toBe(true);
    expect(started).toHaveBeenCalledTimes(1);
    expect(observed[0].disconnected).toBe(true);
  });

  it("continues an entrance another instance began, without waiting for the viewport again", async () => {
    const host = await chartHost();
    playChartEntrance(host, { offset: 300, started: () => {} });
    expect(observed).toHaveLength(0);
    expect(animations.every((a) => a.state === "running" && a.currentTime === 300)).toBe(true);
  });

  it("leaves a step that is already over alone when it continues an entrance", async () => {
    const host = await chartHost();
    // Three bars, 560 ms each, 60 ms apart: at 600 ms the first is over, at 650 the second too.
    playChartEntrance(host, { offset: 600, started: () => {} });
    expect(animations).toHaveLength(2);
    expect(animations.every((a) => a.state === "running" && a.currentTime === 600)).toBe(true);
    animations = [];
    playChartEntrance(await chartHost(), { offset: 650, started: () => {} });
    expect(animations).toHaveLength(1);
  });

  it("draws the chart at rest under 움직임 줄이기", async () => {
    document.documentElement.dataset.motion = "reduce";
    const host = await chartHost();
    playChartEntrance(host, { offset: 0, started: () => {} });
    expect(animations).toHaveLength(0);
    expect(observed).toHaveLength(0);
  });

  it("puts the drawing at rest when it is cancelled", async () => {
    const host = await chartHost();
    const cancel = playChartEntrance(host, { offset: 0, started: () => {} });
    cancel();
    expect(animations.every((a) => a.state === "cancelled")).toBe(true);
    expect(observed[0].disconnected).toBe(true);
  });

  it("as an action: the first drawing enters, the drawing that replaces it does not", async () => {
    const first = await chartHost();
    const markup = first.shadowRoot!.innerHTML;
    const node = document.createElement("div");
    const action = chartSvg(node, { markup, enter: { offset: 0, started: () => {} } });
    expect(node.shadowRoot!.querySelector("svg")).not.toBeNull();
    expect(animations).toHaveLength(3);

    const next = markup.replace("7월", "칠월");
    action.update({ markup: next, enter: null });
    expect(animations.slice(0, 3).every((a) => a.state === "cancelled")).toBe(true);
    expect(animations).toHaveLength(3);
    expect(node.shadowRoot!.innerHTML).toContain("칠월");

    // Mounted without an entrance (an answer opened from the history): nothing moves.
    chartSvg(document.createElement("div"), { markup, enter: null });
    expect(animations).toHaveLength(3);
  });
});
