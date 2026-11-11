// @vitest-environment jsdom
// lib/uiEntrance.ts — the entrances of plain inline UI elements: a block rising
// in, a progress bar filling, the rows of a table arriving, a number counting
// up. (The rule of WHEN a thing may enter is pinned with the chart's, in
// tests/client-chart-entrance.test.ts; what the motion looks like is a real
// browser's job, tests/visual/ui-gallery.spec.ts.)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COUNT_MS, countUp, countUpFormat, enter, enterChildren, fillSteps, resetEntrances, riseSteps, rowSteps, type EntranceRule } from "../src/client/src/lib/uiEntrance.js";

const ONCE: EntranceRule = { scope: "pane:1", always: false };
const ALWAYS: EntranceRule = { scope: "pane:1", always: true };

interface FakeAnimation {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  state: "paused" | "running" | "cancelled";
  currentTime: number;
  pause(): void;
  play(): void;
  cancel(): void;
}

let animations: FakeAnimation[];
let observers: { callback: IntersectionObserverCallback; disconnected: boolean }[];

function seeAll(): void {
  for (const observer of observers) if (!observer.disconnected) observer.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
}

beforeEach(() => {
  resetEntrances();
  delete document.documentElement.dataset.motion;
  animations = [];
  observers = [];
  (Element.prototype as unknown as { animate: unknown }).animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    const animation: FakeAnimation = {
      el: this,
      keyframes,
      options,
      state: "running",
      currentTime: 0,
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
      private entry: { callback: IntersectionObserverCallback; disconnected: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
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
  vi.useRealTimers();
});

describe("countUpFormat", () => {
  it("counts a value that is one number, in the number's own format", () => {
    const won = countUpFormat("24,000원");
    expect(won?.(0)).toBe("0원");
    expect(won?.(0.5)).toBe("12,000원");
    expect(won?.(1)).toBe("24,000원");

    const percent = countUpFormat("+12.4%");
    expect(percent?.(0)).toBe("+0.0%");
    expect(percent?.(0.5)).toBe("+6.2%");
    expect(percent?.(1)).toBe("+12.4%");

    expect(countUpFormat("605만원")?.(1 / 5)).toBe("121만원");
    expect(countUpFormat("7")?.(1)).toBe("7");
    expect(countUpFormat("1,234,567.50")?.(1)).toBe("1,234,567.50");
  });

  it("never shows a negative zero on the way to a negative number", () => {
    const down = countUpFormat("-2");
    expect(down?.(0)).toBe("0");
    expect(down?.(0.6)).toBe("-1");
    expect(down?.(1)).toBe("-2");
  });

  it("does not count what is not one number", () => {
    for (const text of ["", "완료", "3 / 10", "2026-11-11", "10:30", "1,2,3", "0", "0%", "v1.2.3"]) expect(countUpFormat(text), text).toBeNull();
  });
});

describe("the steps of plain elements", () => {
  it("fills a progress bar from nothing to the width it was given", () => {
    const bar = document.createElement("div");
    expect(fillSteps(bar)).toEqual([expect.objectContaining({ el: bar, keyframes: [{ width: "0%", offset: 0 }], delay: 0 })]);
  });

  it("brings the first rows of a table in one after the other, and leaves the rest alone", () => {
    const body = document.createElement("tbody");
    for (let i = 0; i < 30; i += 1) body.append(document.createElement("tr"));
    const steps = rowSteps(body);
    expect(steps).toHaveLength(12);
    expect(steps.map((step) => step.el)).toEqual(Array.from(body.children).slice(0, 12));
    expect(steps[0].delay).toBe(0);
    expect(steps[11].delay).toBeGreaterThan(steps[10].delay);
  });

  it("rises a block into place", () => {
    const block = document.createElement("div");
    const [step] = riseSteps(block, 80);
    expect(step.delay).toBe(80);
    expect(step.keyframes[0]).toEqual({ opacity: 0, transform: "translateY(6px)" });
  });
});

describe("enter (action)", () => {
  it("plays when the element is mounted under a rule, held until it is on screen", () => {
    const bar = document.createElement("div");
    enter(bar, { rule: ONCE, key: "progress:/0", steps: fillSteps });
    expect(animations).toHaveLength(1);
    expect(animations[0].state).toBe("paused");
    expect(animations[0].options.fill).toBe("backwards");
    seeAll();
    expect(animations[0].state).toBe("running");
  });

  it("draws at rest without a rule (an answer opened from the history) and under 움직임 줄이기", () => {
    enter(document.createElement("div"), { rule: null, key: "progress:/0", steps: fillSteps });
    document.documentElement.dataset.motion = "reduce";
    enter(document.createElement("div"), { rule: ALWAYS, key: "progress:/1", steps: fillSteps });
    expect(animations).toHaveLength(0);
  });

  it("enters once across the two mounts of an answer, and again whenever the viewer brings it up", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    enter(document.createElement("div"), { rule: ONCE, key: "progress:/0", steps: fillSteps });
    seeAll();
    vi.advanceTimersByTime(2000);
    enter(document.createElement("div"), { rule: ONCE, key: "progress:/0", steps: fillSteps });
    expect(animations).toHaveLength(1);
    enter(document.createElement("div"), { rule: ALWAYS, key: "progress:/0", steps: fillSteps });
    expect(animations).toHaveLength(2);
  });

  it("leaves the element as it was drawn when the entrance cannot be set up", () => {
    // A stand-in `animate` with no pause() — what a test DOM's polyfill for Svelte transitions looks like.
    const cancelled: string[] = [];
    (Element.prototype as unknown as { animate: unknown }).animate = () => ({ cancel: () => cancelled.push("cancel") });
    const body = document.createElement("tbody");
    body.append(document.createElement("tr"), document.createElement("tr"));
    expect(() => enter(body, { rule: ALWAYS, key: "table:/0", steps: rowSteps })).not.toThrow();
    expect(cancelled).toEqual(["cancel"]);
    expect(observers).toHaveLength(0);
  });

  it("puts the element at rest when it is destroyed", () => {
    const action = enter(document.createElement("div"), { rule: ALWAYS, key: "k", steps: fillSteps });
    action.destroy();
    expect(animations[0].state).toBe("cancelled");
    expect(observers[0].disconnected).toBe(true);
  });
});

describe("enterChildren (action)", () => {
  function block(count: number): HTMLElement {
    const node = document.createElement("div");
    for (let i = 0; i < count; i += 1) node.append(document.createElement("section"));
    document.body.append(node);
    return node;
  }
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("rises every component the block is mounted with, a little apart", () => {
    const node = block(3);
    enterChildren(node, { rule: ONCE, key: "block:/0" });
    expect(animations.map((a) => a.el)).toEqual(Array.from(node.children));
    expect(animations.map((a) => a.options.delay)).toEqual([0, 40, 80]);
  });

  it("rises a component that is added later, while the answer is still being written", async () => {
    const node = block(1);
    enterChildren(node, { rule: ONCE, key: "block:/0" });
    const added = document.createElement("section");
    node.append(added);
    await flush();
    expect(animations).toHaveLength(2);
    expect(animations[1].el).toBe(added);
    expect(animations[1].options.delay).toBe(0);
  });

  it("does not move the block of an answer opened from the history — until the viewer changes something in it", async () => {
    const node = block(2);
    const action = enterChildren(node, { rule: null, key: "block:/0" });
    expect(animations).toHaveLength(0);
    action.update({ rule: ALWAYS, key: "block:/0" });
    expect(animations).toHaveLength(0); // what is already there stays where it is
    node.append(document.createElement("section"));
    await flush();
    expect(animations).toHaveLength(1);
  });

  it("does not rise the same components again in the stored message that replaces the live bubble", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    enterChildren(block(2), { rule: ONCE, key: "block:/0" });
    seeAll();
    vi.advanceTimersByTime(2000);
    enterChildren(block(2), { rule: ONCE, key: "block:/0" });
    expect(animations).toHaveLength(2);
    // A third component, which the live bubble never drew, still enters.
    enterChildren(block(3), { rule: ONCE, key: "block:/0" });
    expect(animations).toHaveLength(3);
  });

  it("stops watching and puts everything at rest when it is destroyed", async () => {
    const node = block(1);
    const action = enterChildren(node, { rule: ALWAYS, key: "block:/0" });
    action.destroy();
    expect(animations[0].state).toBe("cancelled");
    node.append(document.createElement("section"));
    await flush();
    expect(animations).toHaveLength(1);
  });
});

describe("countUp", () => {
  let frames: FrameRequestCallback[];
  const frame = (time: number) => {
    const run = frames;
    frames = [];
    for (const callback of run) callback(time);
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  it("holds the number at its start until it is on screen, counts, and ends on the value itself", () => {
    const shown: (string | null)[] = [];
    const started = vi.fn();
    countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: 0, started }, (text) => shown.push(text));
    expect(shown).toEqual(["0원"]);
    expect(started).not.toHaveBeenCalled();
    seeAll();
    expect(started).toHaveBeenCalledTimes(1);
    frame(100); // the first frame is where the clock starts
    frame(100 + COUNT_MS / 2);
    expect(shown.at(-1)).toBe("875원"); // eased: 1 - (1/2)^3
    frame(100 + COUNT_MS);
    expect(shown.at(-1)).toBeNull();
    expect(frames).toHaveLength(0);
  });

  it("continues a count another instance began, without waiting for the viewport", () => {
    const shown: (string | null)[] = [];
    countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: COUNT_MS / 2, started: () => {} }, (text) => shown.push(text));
    expect(shown).toEqual(["875원"]);
    expect(observers).toHaveLength(0);
    expect(frames).toHaveLength(1);
    // Over already: nothing is shown but the value.
    const late: (string | null)[] = [];
    countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: COUNT_MS, started: () => {} }, (text) => late.push(text));
    expect(late).toEqual([]);
  });

  it("shows nothing more once it is cancelled", () => {
    const shown: (string | null)[] = [];
    const cancel = countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: 0, started: () => {} }, (text) => shown.push(text));
    seeAll();
    frame(0);
    cancel();
    frame(300);
    expect(shown).toEqual(["0원", "0원"]);
  });

  it("does not count under 움직임 줄이기, or where nothing can be on screen", () => {
    const shown: (string | null)[] = [];
    document.documentElement.dataset.motion = "reduce";
    countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: 0, started: () => {} }, (text) => shown.push(text));
    delete document.documentElement.dataset.motion;
    vi.stubGlobal("IntersectionObserver", undefined);
    countUp(document.createElement("span"), countUpFormat("1,000원")!, { offset: 0, started: () => {} }, (text) => shown.push(text));
    expect(shown).toEqual([]);
  });
});
