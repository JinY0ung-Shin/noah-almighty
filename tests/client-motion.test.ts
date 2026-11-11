import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMotionPref,
  getMotionPref,
  prefersReducedMotion,
  project,
  rubberband,
  scrollToStart,
  setMotionPref,
  springValue,
  type SpringValueOptions,
} from "../src/client/src/lib/motion";

/** A `document` with just the root element the motion preference is written on. */
function stubRoot(motion?: string) {
  const dataset: Record<string, string> = motion ? { motion } : {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  return dataset;
}

/** An in-memory `localStorage`. */
function stubStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  });
  return values;
}

describe("motion helpers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects a resting position in the direction of velocity", () => {
    expect(project(40, 500)).toBeGreaterThan(40);
    expect(project(40, -500)).toBeLessThan(40);
  });

  it("rubber-bands beyond a boundary with progressive resistance", () => {
    expect(rubberband(100, 400)).toBeGreaterThan(0);
    expect(rubberband(100, 400)).toBeLessThan(100);
    expect(rubberband(-100, 400)).toBeLessThan(0);
  });

  it("honours the deceleration rate and the rubber-band constant", () => {
    // A lower deceleration rate stops a flick sooner: 1000 px/s projects 99 px
    // at 0.99 against 499 px at the 0.998 default.
    expect(project(0, 1000, 0.99)).toBeCloseTo(99, 6);
    expect(project(0, 1000, 0.99)).toBeLessThan(project(0, 1000));
    // A larger constant gives more travel at the same overshoot...
    expect(rubberband(100, 400, 0.9)).toBeGreaterThan(rubberband(100, 400));
    // ...but resistance stays progressive: twice the pull is less than twice
    // the offset, which is what makes the boundary feel like a boundary.
    expect(rubberband(200, 400)).toBeLessThan(2 * rubberband(100, 400));
    expect(rubberband(0, 400)).toBe(0);
  });

  it("settles immediately when the viewer chose 움직임 줄이기", () => {
    stubRoot("reduce");
    const values: number[] = [];
    springValue({ from: 20, to: 0, onUpdate: (value) => values.push(value) });
    expect(prefersReducedMotion()).toBe(true);
    expect(values).toEqual([0]);
  });

  it("reports no reduced-motion preference without a document or the attribute", () => {
    // The unit project runs in node, so there is no document at all here.
    expect(prefersReducedMotion()).toBe(false);
    stubRoot();
    expect(prefersReducedMotion()).toBe(false);
  });

  it("never follows the operating system's reduced-motion setting", () => {
    // A PC with its system animations off reports `reduce` to every page. The
    // app's motion is the viewer's choice IN THE APP, so that answer is not read.
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("window", { matchMedia });
    vi.stubGlobal("matchMedia", matchMedia);
    stubRoot();
    expect(prefersReducedMotion()).toBe(false);
    expect(matchMedia).not.toHaveBeenCalled();
  });
});

describe("motion preference", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to full motion, also where storage is unavailable or holds anything else", () => {
    expect(getMotionPref()).toBe("full"); // node: no localStorage at all
    stubStorage();
    expect(getMotionPref()).toBe("full");
    stubStorage({ "noah-motion": "system" });
    expect(getMotionPref()).toBe("full");
    stubStorage({ "noah-motion": "reduce" });
    expect(getMotionPref()).toBe("reduce");
  });

  it("applies the stored choice as the root attribute the stylesheets key on", () => {
    stubStorage({ "noah-motion": "reduce" });
    const dataset = stubRoot();
    expect(applyMotionPref()).toBe("reduce");
    expect(dataset.motion).toBe("reduce");
    expect(prefersReducedMotion()).toBe(true);
  });

  it("stores a change and applies it at once; full motion leaves no attribute and no key", () => {
    const stored = stubStorage();
    const dataset = stubRoot();
    setMotionPref("reduce");
    expect(stored.get("noah-motion")).toBe("reduce");
    expect(dataset.motion).toBe("reduce");

    setMotionPref("full");
    expect(stored.has("noah-motion")).toBe(false);
    expect("motion" in dataset).toBe(false);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("still applies a change when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    });
    const dataset = stubRoot();
    expect(() => setMotionPref("reduce")).not.toThrow();
    expect(dataset.motion).toBe("reduce");
  });
});

describe("scrollToStart", () => {
  afterEach(() => vi.unstubAllGlobals());

  function scene(elementTop: number) {
    const scroller = {
      parentElement: null,
      scrollTop: 100,
      scrollHeight: 2000,
      clientHeight: 600,
      clientTop: 0,
      getBoundingClientRect: () => ({ top: 50 }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const element = { parentElement: scroller, getBoundingClientRect: () => ({ top: elementTop }) };
    vi.stubGlobal("document", { scrollingElement: null, documentElement: { dataset: {} } });
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));
    return { scroller, element: element as unknown as HTMLElement };
  }

  it("brings the element's top to the top of its scroll container", () => {
    // No display clock here, so the spring settles at once on the target.
    const { scroller, element } = scene(500);
    scrollToStart(element);
    expect(scroller.scrollTop).toBe(550); // 100 scrolled + (500 − the container's own top 50)
    expect(scroller.addEventListener).not.toHaveBeenCalled(); // nothing left to interrupt
  });

  it("never scrolls past the end of the container", () => {
    const { scroller, element } = scene(5000);
    scrollToStart(element);
    expect(scroller.scrollTop).toBe(1400); // scrollHeight − clientHeight
  });

  it("leaves an element that is already there alone", () => {
    const { scroller, element } = scene(50);
    scrollToStart(element);
    expect(scroller.scrollTop).toBe(100);
  });

  it("springs across frames and hands over to the viewer's own scroll input at once", () => {
    const frames = fakeFrames();
    const { scroller, element } = scene(500);
    scrollToStart(element);
    expect(scroller.scrollTop).toBe(100); // not jumped
    frames.tick();
    frames.tick();
    const mid = scroller.scrollTop;
    expect(mid).toBeGreaterThan(100);
    expect(mid).toBeLessThan(550);

    const wheel = scroller.addEventListener.mock.calls.find(([type]) => type === "wheel");
    expect(wheel).toBeDefined();
    (wheel![1] as () => void)(); // the viewer scrolls
    expect(frames.pending()).toBe(0);
    frames.tick();
    expect(scroller.scrollTop).toBe(mid); // the spring let go
    expect(scroller.removeEventListener).toHaveBeenCalledWith("wheel", wheel![1]);
  });

  it("skips ancestors that do not scroll and uses the nearest one that does", () => {
    const listeners = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const outer = { parentElement: null, scrollTop: 0, scrollHeight: 3000, clientHeight: 600, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }), ...listeners };
    // `overflow: auto` but nothing to scroll — not the scroller.
    const fits = { parentElement: outer, scrollTop: 0, scrollHeight: 400, clientHeight: 400, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }), ...listeners };
    // Content taller than the box but `overflow: visible` — not the scroller either.
    const visible = { parentElement: fits, scrollTop: 0, scrollHeight: 900, clientHeight: 300, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }), ...listeners };
    const element = { parentElement: visible, getBoundingClientRect: () => ({ top: 700 }) } as unknown as HTMLElement;
    vi.stubGlobal("document", { scrollingElement: null, documentElement: { dataset: {} } });
    vi.stubGlobal("getComputedStyle", (node: unknown) => ({ overflowY: node === visible ? "visible" : "auto" }));
    scrollToStart(element);
    expect(outer.scrollTop).toBe(700);
    expect(fits.scrollTop).toBe(0);
    expect(visible.scrollTop).toBe(0);
  });

  it("falls back to the page's own scroller, measured from the viewport top", () => {
    const root = { scrollTop: 40, scrollHeight: 5000, clientHeight: 800, clientTop: 0, getBoundingClientRect: () => ({ top: -40 }), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const element = { parentElement: null, getBoundingClientRect: () => ({ top: 300 }) } as unknown as HTMLElement;
    vi.stubGlobal("document", { scrollingElement: root, documentElement: { dataset: {} } });
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "visible" }));
    scrollToStart(element);
    // The root's own rect (−40, already scrolled) is NOT subtracted: 40 + 300.
    expect(root.scrollTop).toBe(340);
  });

  it("jumps under 움직임 줄이기", () => {
    fakeFrames();
    const { scroller, element } = scene(500);
    vi.stubGlobal("document", { scrollingElement: null, documentElement: { dataset: { motion: "reduce" } } });
    scrollToStart(element);
    expect(scroller.scrollTop).toBe(550);
  });
});

/* ------------------------------------------------------------------ */
/* springValue — the display-synchronised integrator                   */
/* ------------------------------------------------------------------ */

/**
 * Display-clock stand-in. The spring advances only when a frame is delivered,
 * so the test owns both WHEN a frame lands and how much time it carries. The
 * clock starts at the real `performance.now()` the spring reads at setup, so
 * the first frame's delta is exactly the requested step.
 */
function fakeFrames() {
  let now = performance.now();
  let nextId = 1;
  const queue = new Map<number, (time: number) => void>();
  const cancelled: number[] = [];

  vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled.push(id);
    queue.delete(id);
  });

  /** Deliver one frame `stepMs` after the previous one. */
  const tick = (stepMs = 16) => {
    now += stepMs;
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(now);
  };
  /** Deliver frames until the spring stops asking for them. */
  const settle = (stepMs = 16, maxFrames = 500) => {
    let frames = 0;
    while (queue.size && frames < maxFrames) {
      tick(stepMs);
      frames += 1;
    }
    return frames;
  };

  return { cancelled, tick, settle, pending: () => queue.size, queued: () => [...queue.values()] };
}

/** Run a spring to completion at a fixed frame interval, collecting its output. */
function runSpring(options: Omit<SpringValueOptions, "onUpdate">, stepMs = 16) {
  const frames = fakeFrames();
  const values: number[] = [];
  springValue({ ...options, onUpdate: (value) => values.push(value) });
  const delivered = frames.settle(stepMs);
  return { values, delivered, frames };
}

describe("springValue", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("settles immediately when there is no display clock to sync to", () => {
    // Second arm of the same guard as the reduced-motion case above: the unit
    // project has no requestAnimationFrame, which is also a real environment
    // (SSR / a background tab that never paints).
    expect(typeof requestAnimationFrame).toBe("undefined");
    expect(prefersReducedMotion()).toBe(false);

    const values: number[] = [];
    const onComplete = vi.fn();
    const cancel = springValue({ from: 20, to: 0, onUpdate: (v) => values.push(v), onComplete });
    expect(values).toEqual([0]);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(() => cancel()).not.toThrow(); // the no-op canceller
  });

  it("drives the value to the target and stops asking for frames", () => {
    const frames = fakeFrames();
    const values: number[] = [];
    const onComplete = vi.fn();
    springValue({ from: 0, to: 100, onUpdate: (v) => values.push(v), onComplete });

    // A frame is requested up front, before any time has passed.
    expect(values).toEqual([]);
    expect(frames.pending()).toBe(1);

    const delivered = frames.settle();
    // ~28 frames ≈ 450 ms at 60 fps for the 0.3 s default response.
    expect(delivered).toBeGreaterThan(15);
    expect(delivered).toBeLessThan(45);
    expect(values.length).toBe(delivered + 1); // one per frame, plus the exact landing
    expect(values.at(-1)).toBe(100); // lands ON the target, not near it
    expect(onComplete).toHaveBeenCalledOnce();
    expect(frames.pending()).toBe(0); // no frame left queued after the settle
  });

  it("never overshoots at the critically damped default, but does when underdamped", () => {
    // DESIGN §2.5: a programmatic settle must not bounce past its target.
    const critical = runSpring({ from: 0, to: 100 });
    expect(critical.values.every((v, i) => i === 0 || v >= critical.values[i - 1])).toBe(true);
    expect(Math.max(...critical.values)).toBe(100);

    // Underdamping is the opt-in for continuing a flick, and it does overshoot.
    const under = runSpring({ from: 0, to: 100, dampingRatio: 0.6 });
    expect(Math.max(...under.values)).toBeGreaterThan(100);
    expect(under.values.at(-1)).toBe(100);
  });

  it("stretches the settle over more frames as the response grows", () => {
    const quick = runSpring({ from: 0, to: 100, response: 0.3 });
    const slow = runSpring({ from: 0, to: 100, response: 0.6 });
    expect(slow.delivered).toBeGreaterThan(quick.delivered);
    expect(slow.values.at(-1)).toBe(100);
  });

  it("carries an inherited velocity through the first frames", () => {
    // A retarget mid-flick hands the previous spring's velocity over, so a
    // strong opposing throw pulls the value past `from` before it turns around.
    const thrown = runSpring({ from: 0, to: 100, velocity: -3000 });
    expect(thrown.values[0]).toBeLessThan(0);
    expect(thrown.values.at(-1)).toBe(100);

    const still = runSpring({ from: 0, to: 100 });
    expect(still.values[0]).toBeGreaterThan(0);
  });

  it("clamps the frame delta at both ends so stalls and dupes cannot distort it", () => {
    // A 5 s stall (backgrounded tab) must integrate exactly like any other
    // frame past the 1/30 s ceiling — an unclamped delta would fling the value
    // far beyond the target and back. (Steps sit clear of the clamp boundary:
    // the accumulated clock makes a delta right AT 1/30 s drift either side.)
    const stalled = runSpring({ from: 0, to: 100 }, 5000);
    const capped = runSpring({ from: 0, to: 100 }, 40);
    expect(stalled.values).toEqual(capped.values);
    expect(stalled.values.at(-1)).toBe(100);

    // Two frames on the same timestamp integrate as one 1/240 s frame rather
    // than a zero-length no-op that never converges.
    const duplicate = runSpring({ from: 0, to: 100 }, 0);
    const floored = runSpring({ from: 0, to: 100 }, 2);
    expect(duplicate.values).toEqual(floored.values);
    expect(duplicate.delivered).toBeGreaterThan(capped.delivered);
    expect(duplicate.values.at(-1)).toBe(100);
  });

  it("cancel releases the queued frame and ignores one already in flight", () => {
    const frames = fakeFrames();
    const values: number[] = [];
    const onComplete = vi.fn();
    const cancel = springValue({ from: 0, to: 100, onUpdate: (v) => values.push(v), onComplete });

    frames.tick();
    frames.tick();
    expect(values).toHaveLength(2);

    // A frame the browser already dispatched cannot be cancelled — the spring
    // has to swallow it itself, or a retarget would fight the old animation.
    const inFlight = frames.queued()[0];
    cancel();
    expect(frames.cancelled).toHaveLength(1);
    inFlight(performance.now());

    expect(values).toHaveLength(2);
    expect(values.at(-1)).not.toBe(100); // stopped mid-flight
    expect(onComplete).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(0);
  });
});
