// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import {
  autosize,
  clickOutside,
  copyText,
  downscaleImageToDataUrl,
  enhanceMarkdown,
  readFileAsDataUrl,
} from "../src/client/src/lib/dom.js";
import {
  createStickController,
  STICK_GRACE_MS,
  TOUCH_DETACH_PX,
  TOUCH_GESTURE_MS,
  WHEEL_GESTURE_MS,
  type StickStore,
} from "../src/client/src/lib/autoscroll.js";
import { copyPng, downloadPng, downloadSvg } from "../src/client/src/lib/canvasExport.js";
import { loadRailCollapsed, persistRailCollapsed } from "../src/client/src/lib/layout.js";
import { toasts } from "../src/client/src/lib/state.js";

// theme.ts captures its MediaQueryList at module-eval time, so a controllable
// matchMedia must exist BEFORE the (static) import runs — hoisted above it.
// A static import keeps theme.ts in the instrumented module graph (a dynamic
// import + vi.resetModules is NOT attributed by the v8 coverage provider).
const themeMedia = vi.hoisted(() => {
  const listeners: Array<() => void> = [];
  const mql = {
    matches: false,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (type: string, cb: () => void) => {
      if (type === "change") listeners.push(cb);
    },
    removeEventListener: () => {},
    fire: () => listeners.forEach((l) => l()),
    reset: () => {
      mql.matches = false;
      listeners.length = 0;
    },
  };
  (globalThis as any).window = (globalThis as any).window ?? globalThis;
  (globalThis as any).window.matchMedia = () => mql;
  return mql;
});
import { applyTheme, getThemePref, setThemePref, watchSystemTheme } from "../src/client/src/lib/theme.js";

// ---------------------------------------------------------------------------
// Shared helpers + teardown. jsdom has no layout engine, so geometry
// (scrollHeight/clientHeight) is faked per element; timing is driven through a
// mocked performance.now where relevant. All global overrides are torn down
// after every test so the file stays order-independent.
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

/** Override an own/prototype property, restoring the original on teardown. */
function override(obj: any, key: string, value: unknown): void {
  const orig = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  cleanups.push(() => {
    if (orig) Object.defineProperty(obj, key, orig);
    else {
      try {
        delete obj[key];
      } catch {
        /* leave a harmless override */
      }
    }
  });
}

/** Install a fake navigator.clipboard for a test (restored on teardown). */
function defineClipboard(clip: unknown): void {
  override(navigator, "clipboard", clip);
}

/** Ensure a prototype method exists, then spy+mock it (auto-restored). */
function spyMethod(proto: any, key: string, impl: (...args: any[]) => any) {
  if (typeof proto[key] !== "function") {
    Object.defineProperty(proto, key, { value: () => undefined, configurable: true, writable: true });
  }
  return vi.spyOn(proto, key).mockImplementation(impl as any);
}

/** Dispatch a bare Event with extra props copied on (deltaY, touches, …). */
function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, props);
  target.dispatchEvent(event);
  return event;
}

/** A scrollable div whose geometry can be mutated mid-test via the returned `g`. */
function makeNode(init: { scrollHeight?: number; clientHeight?: number } = {}) {
  const el = document.createElement("div");
  const g = { scrollHeight: init.scrollHeight ?? 0, clientHeight: init.clientHeight ?? 0 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
  document.body.append(el);
  return { el, g };
}

/** A StickStore backed by a mutable value; setStuck is a spy. */
function makeStore(initial: boolean | undefined): StickStore & { setStuck: ReturnType<typeof vi.fn> } {
  let stuck = initial;
  return {
    isStuck: () => stuck,
    setStuck: vi.fn((next: boolean) => {
      stuck = next;
    }),
  };
}

// A configurable fake <img> shared by dom.downscale and canvasExport rasterize:
// jsdom neither decodes images nor paints a 2D context, so src-set schedules the
// success/error callback on a microtask.
const fakeImage = { mode: "load" as "load" | "error", dims: { width: 100, height: 100 } };
class FakeImage {
  onload: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  width = 0;
  height = 0;
  private _src = "";
  set src(value: string) {
    this._src = value;
    queueMicrotask(() => {
      if (fakeImage.mode === "error") this.onerror?.();
      else {
        this.width = fakeImage.dims.width;
        this.height = fakeImage.dims.height;
        this.onload?.();
      }
    });
  }
  get src(): string {
    return this._src;
  }
}

/** Build an SVGSVGElement fixture in the document. */
function makeSvg(opts: { viewBox?: string; text?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (opts.viewBox) svg.setAttribute("viewBox", opts.viewBox);
  if (opts.text) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.textContent = opts.text;
    svg.appendChild(t);
  }
  document.body.appendChild(svg);
  return svg;
}

function decodeDataUrl(dataUrl: string): string {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return decodeURIComponent(escape(atob(b64)));
}

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* ignore teardown errors */
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  toasts.set([]);
  themeMedia.reset();
  fakeImage.mode = "load";
  fakeImage.dims = { width: 100, height: 100 };
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  try {
    // matchMedia is set by assignment in the theme loader, not vi.stubGlobal.
    delete (window as any).matchMedia;
  } catch {
    /* ignore */
  }
});

// ===========================================================================
// dom.ts
// ===========================================================================

describe("dom.readFileAsDataUrl", () => {
  it("resolves a File to a base64 data: URL preserving its content", async () => {
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    const url = await readFileAsDataUrl(file);
    expect(url.startsWith("data:text/plain")).toBe(true);
    expect(url).toContain(";base64,");
    expect(atob(url.slice(url.indexOf(",") + 1))).toBe("hello");
  });

  it("rejects with the reader's error when reading fails", async () => {
    class FailReader {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error = new Error("read failed");
      result: unknown = null;
      readAsDataURL(): void {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal("FileReader", FailReader);
    await expect(readFileAsDataUrl(new File([""], "x"))).rejects.toThrow("read failed");
  });
});

describe("dom.downscaleImageToDataUrl", () => {
  // Paint path is browser-only, so Image + the 2D canvas are stubbed; this pins
  // the scaling math, the output-type ternary, and the failure branches.
  function stubCanvas(): {
    ctx: { drawImage: ReturnType<typeof vi.fn> };
    calls: { type?: string; quality?: number; canvas?: HTMLCanvasElement };
  } {
    const ctx = { drawImage: vi.fn() };
    const calls: { type?: string; quality?: number; canvas?: HTMLCanvasElement } = {};
    spyMethod(HTMLCanvasElement.prototype, "getContext", () => ctx);
    spyMethod(HTMLCanvasElement.prototype, "toDataURL", function (this: HTMLCanvasElement, type?: string, q?: number) {
      calls.type = type;
      calls.quality = q;
      calls.canvas = this;
      return "data:image/OUT";
    });
    return { ctx, calls };
  }

  it("downscales to the max long edge and defaults type to the source family + q=0.9", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.dims = { width: 2000, height: 1000 };
    const { ctx, calls } = stubCanvas();
    const out = await downscaleImageToDataUrl(new File(["x"], "p.png", { type: "image/png" }), 1000);
    expect(out).toBe("data:image/OUT");
    expect(calls.canvas!.width).toBe(1000); // 2000 * min(1, 1000/2000)
    expect(calls.canvas!.height).toBe(500);
    expect(calls.type).toBe("image/png");
    expect(calls.quality).toBe(0.9);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1000, 500);
  });

  it("honors an explicit outputType and quality over the source family", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.dims = { width: 800, height: 400 };
    const { calls } = stubCanvas();
    await downscaleImageToDataUrl(new File(["x"], "p.png", { type: "image/png" }), 4000, {
      outputType: "image/webp",
      quality: 0.5,
    });
    expect(calls.type).toBe("image/webp");
    expect(calls.quality).toBe(0.5);
  });

  it("maps jpeg→jpeg, webp→webp, and everything else→png", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.dims = { width: 10, height: 10 };
    for (const [source, expected] of [
      ["image/jpeg", "image/jpeg"],
      ["image/webp", "image/webp"],
      ["image/gif", "image/png"],
    ] as const) {
      const { calls } = stubCanvas();
      await downscaleImageToDataUrl(new File(["x"], "p", { type: source }), 100);
      expect(calls.type).toBe(expected);
    }
  });

  it("never upscales (scale clamped to 1) and floors dimensions to >= 1px", async () => {
    vi.stubGlobal("Image", FakeImage);
    const { calls: small } = stubCanvas();
    fakeImage.dims = { width: 100, height: 50 };
    await downscaleImageToDataUrl(new File(["x"], "p"), 1000);
    expect(small.canvas!.width).toBe(100); // no upscaling
    expect(small.canvas!.height).toBe(50);

    const { calls: zero } = stubCanvas();
    fakeImage.dims = { width: 0, height: 0 };
    await downscaleImageToDataUrl(new File(["x"], "p"), 1000);
    expect(zero.canvas!.width).toBe(1); // Math.max(1, …)
    expect(zero.canvas!.height).toBe(1);
  });

  it("rejects when the 2D context is unavailable", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.dims = { width: 10, height: 10 };
    spyMethod(HTMLCanvasElement.prototype, "getContext", () => null);
    await expect(downscaleImageToDataUrl(new File(["x"], "p"), 100)).rejects.toThrow("no 2d context");
  });

  it("rejects when the image fails to load", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.mode = "error";
    await expect(downscaleImageToDataUrl(new File(["x"], "p"), 100)).rejects.toThrow("image load failed");
  });
});

describe("dom.copyText", () => {
  it("writes via the async clipboard and flashes the button, reverting after 1200ms", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard({ writeText });
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "복사");
    btn.title = "복사";
    btn.innerHTML = "COPY";
    document.body.append(btn);

    await copyText("hello", btn);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(btn.classList.contains("copied")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("복사됨");
    expect(btn.innerHTML).toContain("<svg"); // CHECK_SVG swapped in

    vi.advanceTimersByTime(1200);
    expect(btn.classList.contains("copied")).toBe(false);
    expect(btn.innerHTML).toBe("COPY"); // original restored
    expect(btn.getAttribute("aria-label")).toBe("복사");
  });

  it("falls back to execCommand('copy') via a throwaway textarea when clipboard is absent", async () => {
    defineClipboard(undefined);
    const exec = spyMethod(document, "execCommand", () => true);
    const btn = document.createElement("button");
    document.body.append(btn);

    await copyText("copy me", btn);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull(); // appended then removed
    expect(btn.classList.contains("copied")).toBe(true);
  });

  it("flashes the failure state when the clipboard write rejects", async () => {
    defineClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", "복사");
    document.body.append(btn);

    await copyText("x", btn);
    expect(btn.classList.contains("copy-failed")).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("복사 실패");
  });

  it("does not throw when no button is supplied", async () => {
    defineClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    await expect(copyText("x")).resolves.toBeUndefined();
    defineClipboard({ writeText: vi.fn().mockRejectedValue(new Error("nope")) });
    await expect(copyText("x")).resolves.toBeUndefined();
  });

  it("clears the title on revert when the button had no original aria-label", async () => {
    vi.useFakeTimers();
    defineClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
    const btn = document.createElement("button"); // no aria-label / title
    btn.innerHTML = "COPY";
    document.body.append(btn);

    await copyText("x", btn);
    vi.advanceTimersByTime(1200);
    expect(btn.title).toBe(""); // label was null → title reset to ""
    expect(btn.innerHTML).toBe("COPY");
  });
});

describe("dom.autosize", () => {
  it("grows to content height (capped at 200px) and re-measures on input", () => {
    const ta = document.createElement("textarea");
    document.body.append(ta);
    let sh = 500;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => sh });

    const action = autosize(ta);
    expect(ta.style.height).toBe("200px"); // min(500, cap 200)

    sh = 80;
    ta.dispatchEvent(new Event("input"));
    expect(ta.style.height).toBe("80px"); // input path is synchronous

    action.destroy();
    sh = 150;
    ta.dispatchEvent(new Event("input"));
    expect(ta.style.height).toBe("80px"); // listener removed → no re-grow
  });

  it("caps at 30% of the viewport when that is below 200px", () => {
    override(window, "innerHeight", 400); // cap = min(200, round(120)) = 120
    const ta = document.createElement("textarea");
    document.body.append(ta);
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => 500 });
    const action = autosize(ta);
    expect(ta.style.height).toBe("120px");
    action.destroy();
  });

  it("defers the param-driven grow to a microtask (shrink-after-send regression)", async () => {
    const ta = document.createElement("textarea");
    document.body.append(ta);
    let sh = 100;
    Object.defineProperty(ta, "scrollHeight", { configurable: true, get: () => sh });

    const action = autosize(ta, "multi\nline\ndraft");
    expect(ta.style.height).toBe("100px");

    // A programmatic value change: Svelte calls update() BEFORE flushing the new
    // value, so grow() must NOT run synchronously (it would measure stale content).
    sh = 250;
    action.update();
    expect(ta.style.height).toBe("100px"); // still stale — deferred

    await Promise.resolve(); // flush the microtask
    expect(ta.style.height).toBe("200px"); // now re-measured (min(250, cap 200))
    action.destroy();
  });
});

describe("dom.clickOutside", () => {
  it("fires onOutside only for outside pointerdowns, not inside or ignored targets", () => {
    const panel = document.createElement("div");
    const child = document.createElement("span");
    panel.append(child);
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    const outside = document.createElement("div");
    document.body.append(panel, toggle, outside);

    const onOutside = vi.fn();
    const action = clickOutside(panel, { onOutside, ignore: ".toggle" });

    fire(child, "pointerdown");
    expect(onOutside).not.toHaveBeenCalled(); // inside the panel

    fire(toggle, "pointerdown");
    expect(onOutside).not.toHaveBeenCalled(); // matches ignore selector

    fire(outside, "pointerdown");
    expect(onOutside).toHaveBeenCalledTimes(1);

    action.destroy();
    fire(outside, "pointerdown");
    expect(onOutside).toHaveBeenCalledTimes(1); // listener detached
  });

  it("update() swaps the callback and ignore selector", () => {
    const panel = document.createElement("div");
    const outside = document.createElement("div");
    document.body.append(panel, outside);
    const first = vi.fn();
    const second = vi.fn();

    const action = clickOutside(panel, { onOutside: first });
    action.update({ onOutside: second });
    fire(outside, "pointerdown");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    action.destroy();
  });
});

describe("dom.enhanceMarkdown", () => {
  it("wraps <pre> in a copy-button code block and <table> in a scroller, idempotently", () => {
    const node = document.createElement("div");
    node.innerHTML = "<pre><code>const x = 1;</code></pre><table><tr><td>c</td></tr></table>";
    document.body.append(node);

    const action = enhanceMarkdown(node, "source-v1");
    const wrapper = node.querySelector(".code-block");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector("pre")).not.toBeNull();
    expect(wrapper!.querySelector("button.code-copy")).not.toBeNull();
    expect(node.querySelector(".table-wrap table")).not.toBeNull();

    action.update("source-v2");
    expect(node.querySelectorAll(".code-block")).toHaveLength(1);
    expect(node.querySelectorAll(".table-wrap")).toHaveLength(1);
    action.destroy();
  });

  it("skips the sweep when the source text is unchanged", () => {
    // Svelte re-runs update() on every appState emission (one per SSE token), so
    // an unchanged body must not re-query the DOM once per message per token.
    const node = document.createElement("div");
    node.innerHTML = "<pre><code>const x = 1;</code></pre>";
    document.body.append(node);
    const querySpy = vi.spyOn(node, "querySelectorAll");

    const action = enhanceMarkdown(node, "same-source");
    const afterMount = querySpy.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);

    action.update("same-source");
    action.update("same-source");
    expect(querySpy.mock.calls.length).toBe(afterMount);

    action.update("changed-source");
    expect(querySpy.mock.calls.length).toBeGreaterThan(afterMount);
    action.destroy();
    querySpy.mockRestore();
  });

  it("the injected copy button copies through the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    defineClipboard({ writeText });
    const node = document.createElement("div");
    node.innerHTML = "<pre><code>payload</code></pre>";
    document.body.append(node);
    enhanceMarkdown(node);

    const btn = node.querySelector<HTMLButtonElement>("button.code-copy")!;
    btn.dispatchEvent(new Event("click", { bubbles: true }));
    expect(writeText).toHaveBeenCalledTimes(1); // write is invoked synchronously
  });
});

// ===========================================================================
// autoscroll.ts — createStickController
// ===========================================================================

describe("autoscroll.createStickController", () => {
  let roInstances: Array<{ cb: () => void; observed: HTMLElement[]; disconnected: boolean }>;
  let nowMs: number;

  beforeEach(() => {
    roInstances = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        cb: () => void;
        observed: HTMLElement[] = [];
        disconnected = false;
        constructor(cb: () => void) {
          this.cb = cb;
          roInstances.push(this);
        }
        observe(el: HTMLElement): void {
          this.observed.push(el);
        }
        disconnect(): void {
          this.disconnected = true;
        }
      },
    );
    // Drive gesture/grace windows deterministically. Start > 0 so the initial
    // gestureUntil/stickGraceUntil (0) read as expired.
    nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  it("exposes the tuning constants", () => {
    expect(WHEEL_GESTURE_MS).toBe(250);
    expect(TOUCH_GESTURE_MS).toBe(1200);
    expect(TOUCH_DETACH_PX).toBe(8);
    expect(STICK_GRACE_MS).toBe(250);
  });

  it("pins to the bottom on mount and observes the transcript + its inner", () => {
    const store = makeStore(undefined);
    const { el } = makeNode({ scrollHeight: 1000, clientHeight: 600 });
    const inner = document.createElement("div");
    inner.className = "transcript-inner";
    el.append(inner);

    const handle = createStickController(store).attach(el);
    expect(el.scrollTop).toBe(1000); // landed at the bottom
    expect(roInstances).toHaveLength(1);
    expect(roInstances[0].observed).toContain(el);
    expect(roInstances[0].observed).toContain(inner);

    handle.destroy();
    expect(roInstances[0].disconnected).toBe(true);
  });

  it("does not pin on mount when the pane is already detached", () => {
    const store = makeStore(false);
    const { el } = makeNode({ scrollHeight: 1000, clientHeight: 600 });
    createStickController(store).attach(el);
    expect(el.scrollTop).toBe(0);
  });

  it("pin() re-pins while sticky and is a no-op once detached", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el, g } = makeNode({ scrollHeight: 500, clientHeight: 300 });
    ctrl.attach(el);

    g.scrollHeight = 1200;
    ctrl.pin();
    expect(el.scrollTop).toBe(1200);

    store.setStuck(false);
    g.scrollHeight = 2000;
    ctrl.pin();
    expect(el.scrollTop).toBe(1200); // unchanged
  });

  it("the ResizeObserver re-pins on every content-size change while sticky", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el, g } = makeNode({ scrollHeight: 800, clientHeight: 400 });
    ctrl.attach(el);

    g.scrollHeight = 1600;
    roInstances[0].cb();
    expect(el.scrollTop).toBe(1600);

    g.scrollHeight = 2400;
    roInstances[0].cb();
    expect(el.scrollTop).toBe(2400);
  });

  it("the ResizeObserver does nothing when detached", () => {
    const store = makeStore(false);
    const ctrl = createStickController(store);
    const { el, g } = makeNode({ scrollHeight: 800, clientHeight: 400 });
    ctrl.attach(el);
    g.scrollHeight = 2000;
    roInstances[0].cb();
    expect(el.scrollTop).toBe(0);
  });

  it("opening a transcript disclosure detaches before its resize can pin to the bottom", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el, g } = makeNode({ scrollHeight: 1000, clientHeight: 600 });
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.textContent = "생각 과정";
    summary.append(label);
    details.append(summary, document.createElement("div"));
    el.append(details);
    ctrl.attach(el);

    expect(el.scrollTop).toBe(1000);
    label.click(); // nested targets and keyboard-generated clicks bubble here
    expect(details.open).toBe(true);
    expect(store.isStuck()).toBe(false);

    g.scrollHeight = 1800; // the disclosure body became visible
    roInstances[0].cb();
    expect(el.scrollTop).toBe(1000); // keep the summary where the reader opened it
  });

  it("opening a collapsed disclosure button (a folded agent card) detaches like a summary", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el, g } = makeNode({ scrollHeight: 1000, clientHeight: 600 });
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-expanded", "false");
    const label = document.createElement("span");
    label.textContent = "@tester";
    toggle.append(label);
    el.append(toggle);
    ctrl.attach(el);

    label.click();
    expect(store.isStuck()).toBe(false);
    g.scrollHeight = 1600; // the card's rows unfolded
    roInstances[0].cb();
    expect(el.scrollTop).toBe(1000);
  });

  it("does not detach for ordinary transcript clicks or when closing a disclosure", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 1000, clientHeight: 600 });
    const ordinary = document.createElement("button");
    const openToggle = document.createElement("button");
    openToggle.setAttribute("aria-expanded", "true");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.open = true;
    details.append(summary, document.createElement("div"));
    el.append(ordinary, openToggle, details);
    ctrl.attach(el);

    ordinary.click();
    openToggle.click();
    summary.click();
    expect(details.open).toBe(false);
    expect(store.setStuck).not.toHaveBeenCalled();
  });

  it("jumpToBottom() forces stick, jumps to the bottom, from a detached state", () => {
    const store = makeStore(false);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 1500, clientHeight: 600 });
    ctrl.attach(el);
    ctrl.jumpToBottom();
    expect(store.setStuck).toHaveBeenCalledWith(true);
    expect(store.isStuck()).toBe(true);
    expect(el.scrollTop).toBe(1500);
  });

  it("a wheel-up on a scrollable pane detaches synchronously", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrl.attach(el);
    fire(el, "wheel", { deltaY: -100 });
    expect(store.isStuck()).toBe(false);
  });

  it("ignores wheel events that are not an upward scroll gesture", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrl.attach(el);
    fire(el, "wheel", { deltaY: -100, ctrlKey: true }); // pinch-zoom
    fire(el, "wheel", { deltaY: -100, shiftKey: true }); // horizontal intent
    fire(el, "wheel", { deltaY: 0 }); // no movement
    fire(el, "wheel", { deltaY: 100 }); // downward → toward the bottom
    expect(store.setStuck).not.toHaveBeenCalled();
  });

  it("does not detach on wheel-up when the pane cannot scroll", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 600, clientHeight: 600 }); // not scrollable
    ctrl.attach(el);
    fire(el, "wheel", { deltaY: -100 });
    expect(store.setStuck).not.toHaveBeenCalled();
  });

  it("a touch drag downward past the deadzone detaches; a smaller drag does not", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrl.attach(el);

    fire(el, "touchstart", { touches: [{ clientY: 100 }] });
    fire(el, "touchmove", { touches: [{ clientY: 105 }] }); // +5px <= 8, ignored
    expect(store.setStuck).not.toHaveBeenCalled();

    fire(el, "touchmove", { touches: [{ clientY: 130 }] }); // +30px > 8 → detach
    expect(store.isStuck()).toBe(false);
  });

  it("ignores touchmove without a touchstart, with empty touches, or on a non-scrollable pane", () => {
    const s1 = makeStore(undefined);
    const c1 = createStickController(s1);
    const { el: e1 } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    c1.attach(e1);
    fire(e1, "touchmove", { touches: [{ clientY: 200 }] }); // no prior touchstart
    expect(s1.setStuck).not.toHaveBeenCalled();
    fire(e1, "touchstart", { touches: [{ clientY: 100 }] });
    fire(e1, "touchmove", { touches: [] }); // no active touch point
    expect(s1.setStuck).not.toHaveBeenCalled();

    const s2 = makeStore(undefined);
    const c2 = createStickController(s2);
    const { el: e2 } = makeNode({ scrollHeight: 600, clientHeight: 600 }); // not scrollable
    c2.attach(e2);
    fire(e2, "touchstart", { touches: [{ clientY: 100 }] });
    fire(e2, "touchmove", { touches: [{ clientY: 200 }] }); // real drag, nothing to scroll
    expect(s2.setStuck).not.toHaveBeenCalled();
  });

  it("an unattributed scroll-up detaches only when it lands clearly above the bottom", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrl.attach(el); // pin → scrollTop 2000, lastTop 2000
    el.scrollTop = 800; // 600px from the bottom, no gesture attribution
    fire(el, "scroll");
    expect(store.isStuck()).toBe(false);
  });

  it("a small near-bottom scroll-up stays engaged without a gesture but detaches with one", () => {
    // Without gesture attribution.
    const storeA = makeStore(undefined);
    const ctrlA = createStickController(storeA);
    const { el: elA } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrlA.attach(elA);
    elA.scrollTop = 1400; // settle lastTop at the real bottom (clamp-null)
    fire(elA, "scroll");
    elA.scrollTop = 1390; // up 10px, 10px from the bottom
    fire(elA, "scroll");
    expect(storeA.setStuck).not.toHaveBeenCalled(); // conservative rule keeps it

    // With a held pointer (scrollbar drag) the same move is intent.
    const storeB = makeStore(undefined);
    const ctrlB = createStickController(storeB);
    const { el: elB } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrlB.attach(elB);
    elB.scrollTop = 1400;
    fire(elB, "scroll");
    fire(elB, "pointerdown");
    elB.scrollTop = 1390;
    fire(elB, "scroll");
    expect(storeB.isStuck()).toBe(false);
    fire(window, "pointerup"); // releases the gesture attribution without throwing
  });

  it("re-engages when the user scrolls back down into the bottom zone", () => {
    const store = makeStore(false);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2500, clientHeight: 653 });
    ctrl.attach(el); // detached: no pin, lastTop undefined
    el.scrollTop = 500;
    fire(el, "scroll"); // first event only seeds lastTop
    el.scrollTop = 1800; // moved down, 47px from the bottom
    fire(el, "scroll");
    expect(store.isStuck()).toBe(true);
  });

  it("stays detached while scrolling down but still far from the bottom", () => {
    const store = makeStore(false);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2500, clientHeight: 653 });
    ctrl.attach(el);
    el.scrollTop = 300;
    fire(el, "scroll");
    el.scrollTop = 600; // down but 1247px from the bottom
    fire(el, "scroll");
    expect(store.setStuck).not.toHaveBeenCalled();
  });

  it("does not disengage on a browser range-clamp that lands at the new bottom", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    // Attach tall so pin seeds lastTop high; then content shrinks and the browser
    // clamps scrollTop down to the new bottom (distanceFromBottom === 0).
    const { el, g } = makeNode({ scrollHeight: 1400, clientHeight: 600 });
    ctrl.attach(el); // lastTop = 1400
    g.scrollHeight = 800; // content collapsed → new bottom is 200
    el.scrollTop = 200;
    fire(el, "scroll");
    expect(store.setStuck).not.toHaveBeenCalled(); // clamp, not a scroll-up
  });

  it("suppresses heuristic detaches inside the post-jump grace window, then honors them", () => {
    const store = makeStore(false);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    ctrl.attach(el);

    nowMs = 1000;
    ctrl.jumpToBottom(); // stick + arm grace until 1250, lastTop = 2000
    el.scrollTop = 800; // an upward animation frame after the jump
    fire(el, "scroll");
    expect(store.isStuck()).toBe(true); // grace suppressed the detach

    nowMs = 1300; // grace + gesture windows expired
    el.scrollTop = 700; // a genuine further scroll-up
    fire(el, "scroll");
    expect(store.isStuck()).toBe(false);
  });

  it("lets a nested scroller consume wheel-up until it bottoms out", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    const inner = document.createElement("div");
    inner.style.overflowY = "auto";
    Object.defineProperty(inner, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(inner, "clientHeight", { configurable: true, get: () => 100 });
    inner.scrollTop = 50; // still room to scroll up inside
    el.append(inner);
    ctrl.attach(el);

    fire(inner, "wheel", { deltaY: -100 });
    expect(store.setStuck).not.toHaveBeenCalled(); // consumed by the inner pane

    inner.scrollTop = 0; // inner bottomed out at its top
    fire(inner, "wheel", { deltaY: -100 });
    expect(store.isStuck()).toBe(false); // now the transcript detaches
  });

  it("removes every listener and disconnects the observer on destroy", () => {
    const store = makeStore(undefined);
    const ctrl = createStickController(store);
    const { el } = makeNode({ scrollHeight: 2000, clientHeight: 600 });
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    details.append(summary);
    el.append(details);
    const handle = ctrl.attach(el);
    handle.destroy();
    fire(el, "wheel", { deltaY: -100 });
    summary.click();
    expect(store.setStuck).not.toHaveBeenCalled();
    expect(roInstances[0].disconnected).toBe(true);
  });
});

// ===========================================================================
// theme.ts
// ===========================================================================

describe("theme.ts", () => {
  it("getThemePref reads the persisted value and treats anything else as system", () => {
    expect(getThemePref()).toBe("system");
    localStorage.setItem("noah-theme", "light");
    expect(getThemePref()).toBe("light");
    localStorage.setItem("noah-theme", "dark");
    expect(getThemePref()).toBe("dark");
    localStorage.setItem("noah-theme", "banana");
    expect(getThemePref()).toBe("system");
  });

  it("getThemePref falls back to system when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getThemePref()).toBe("system");
  });

  it("applyTheme sets data-theme for explicit prefs and returns the pref", () => {
    expect(applyTheme("dark")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applyTheme('system') resolves via matchMedia", () => {
    themeMedia.matches = true;
    expect(applyTheme("system")).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");

    themeMedia.matches = false;
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("applyTheme() with no arg reads the pref, and a persisted choice wins over the OS", () => {
    themeMedia.matches = true; // OS prefers dark
    localStorage.setItem("noah-theme", "light"); // user overrode to light
    expect(applyTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("setThemePref persists explicit prefs, removes the key for system, and applies", () => {
    themeMedia.matches = true;
    setThemePref("dark");
    expect(localStorage.getItem("noah-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    setThemePref("system");
    expect(localStorage.getItem("noah-theme")).toBeNull(); // key removed
    expect(document.documentElement.dataset.theme).toBe("dark"); // resolved from the OS
  });

  it("setThemePref still applies the theme when localStorage writes throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    setThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("watchSystemTheme re-applies on OS change only while the pref is system", () => {
    watchSystemTheme();

    themeMedia.matches = true; // OS switches to dark; pref is still system
    themeMedia.fire();
    expect(document.documentElement.dataset.theme).toBe("dark");

    localStorage.setItem("noah-theme", "light"); // user pins an explicit pref
    themeMedia.matches = false;
    themeMedia.fire();
    expect(document.documentElement.dataset.theme).toBe("dark"); // unchanged: guard skipped applyTheme
  });
});

// ===========================================================================
// layout.ts
// ===========================================================================

describe("layout.ts", () => {
  it("defaults the desktop rail to expanded and reads only the persisted true state", () => {
    expect(loadRailCollapsed()).toBe(false);
    localStorage.setItem("noah.railCollapsed", "true");
    expect(loadRailCollapsed()).toBe(true);
    localStorage.setItem("noah.railCollapsed", "invalid");
    expect(loadRailCollapsed()).toBe(false);
  });

  it("persists collapse and removes the key when returning to the default", () => {
    persistRailCollapsed(true);
    expect(localStorage.getItem("noah.railCollapsed")).toBe("true");
    persistRailCollapsed(false);
    expect(localStorage.getItem("noah.railCollapsed")).toBeNull();
  });

  it("keeps working when browser storage is unavailable", () => {
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadRailCollapsed()).toBe(false);
    read.mockRestore();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => persistRailCollapsed(true)).not.toThrow();
  });
});

// ===========================================================================
// canvasExport.ts
// ===========================================================================

describe("canvasExport.downloadSvg", () => {
  // Capture the throwaway <a> at click time (it is removed immediately after).
  function captureDownload(): { current: { href: string; download: string } | null } {
    const box: { current: { href: string; download: string } | null } = { current: null };
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      box.current = { href: this.href, download: this.download };
    });
    return box;
  }

  it("serializes the SVG to a base64 data: URL and downloads it with a slugged name", () => {
    const box = captureDownload();
    downloadSvg(makeSvg({ text: "한글 テスト" }), "My Chart: A/B?");
    expect(box.current!.download).toBe("My-Chart-AB.svg");
    expect(box.current!.href.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = decodeDataUrl(box.current!.href);
    expect(decoded).toContain("<svg");
    expect(decoded).toContain('xmlns="http://www.w3.org/2000/svg"'); // namespace added
    expect(decoded).toContain("한글 テスト"); // UTF-8 survives btoa
  });

  it("keeps an SVG's existing xmlns instead of re-adding it", () => {
    const box = captureDownload();
    const svg = makeSvg();
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    downloadSvg(svg, "x");
    // The already-present xmlns is kept (serializeSvg skips the re-add branch).
    expect(decodeDataUrl(box.current!.href)).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("slugs filenames: empty/all-illegal → canvas, collapses whitespace, caps at 60 chars", () => {
    const cases: Array<[string, string]> = [
      ["", "canvas.svg"],
      ["///:::", "canvas.svg"],
      ["  spaced  out  ", "spaced-out.svg"],
      ["x".repeat(80), `${"x".repeat(60)}.svg`],
    ];
    for (const [title, expected] of cases) {
      const box = captureDownload();
      downloadSvg(makeSvg(), title);
      expect(box.current!.download).toBe(expected);
      vi.restoreAllMocks();
    }
  });
});

describe("canvasExport.downloadPng", () => {
  function stubRaster(): {
    ctx: { fillStyle: string; fillRect: ReturnType<typeof vi.fn>; scale: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn> };
    pngCanvas: { current: HTMLCanvasElement | null };
    download: { current: { href: string; download: string } | null };
  } {
    vi.stubGlobal("Image", FakeImage);
    const ctx = { fillStyle: "", fillRect: vi.fn(), scale: vi.fn(), drawImage: vi.fn() };
    const pngCanvas: { current: HTMLCanvasElement | null } = { current: null };
    const download: { current: { href: string; download: string } | null } = { current: null };
    spyMethod(HTMLCanvasElement.prototype, "getContext", () => ctx);
    spyMethod(HTMLCanvasElement.prototype, "toDataURL", function (this: HTMLCanvasElement) {
      pngCanvas.current = this;
      return "data:image/png;base64,PNGDATA";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download.current = { href: this.href, download: this.download };
    });
    return { ctx, pngCanvas, download };
  }

  it("rasterizes at the device pixel ratio, paints the background, and downloads a PNG", async () => {
    override(window, "devicePixelRatio", 2);
    const { ctx, pngCanvas, download } = stubRaster();
    const ok = await downloadPng(makeSvg(), "chart"); // no viewBox → 640x480 fallback
    expect(ok).toBe(true);
    expect(pngCanvas.current!.width).toBe(1280); // 640 * 2
    expect(pngCanvas.current!.height).toBe(960);
    expect(ctx.fillStyle).toBe("#ffffff"); // --bg unset in jsdom → fallback
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1280, 960);
    expect(ctx.scale).toHaveBeenCalledWith(2, 2);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 480);
    expect(download.current!.download).toBe("chart.png");
    expect(download.current!.href).toBe("data:image/png;base64,PNGDATA");
  });

  it("reads the SVG viewBox for its size and caps the DPR at 3", async () => {
    override(window, "devicePixelRatio", 5); // capped to 3
    const { ctx, pngCanvas } = stubRaster();
    const svg = makeSvg();
    Object.defineProperty(svg, "viewBox", {
      configurable: true,
      value: { baseVal: { width: 800, height: 600 } },
    });
    await downloadPng(svg, "x");
    expect(pngCanvas.current!.width).toBe(2400); // 800 * 3
    expect(pngCanvas.current!.height).toBe(1800);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
  });

  it("returns false and notifies when rasterization fails (image load error)", async () => {
    vi.stubGlobal("Image", FakeImage);
    fakeImage.mode = "error";
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const ok = await downloadPng(makeSvg(), "chart");
    expect(ok).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(get(toasts).some((t) => t.kind === "warn" && t.message.includes("PNG로 저장"))).toBe(true);
  });

  it("returns false when the 2D context is unavailable", async () => {
    vi.stubGlobal("Image", FakeImage);
    spyMethod(HTMLCanvasElement.prototype, "getContext", () => null);
    const ok = await downloadPng(makeSvg(), "chart");
    expect(ok).toBe(false);
  });
});

describe("canvasExport.copyPng", () => {
  function stubCanvasWithBlob(blob: Blob | null): {
    write: ReturnType<typeof vi.fn>;
    ClipboardItemCalls: Array<Record<string, Blob>>;
  } {
    vi.stubGlobal("Image", FakeImage);
    spyMethod(HTMLCanvasElement.prototype, "getContext", () => ({
      fillStyle: "",
      fillRect: vi.fn(),
      scale: vi.fn(),
      drawImage: vi.fn(),
    }));
    spyMethod(HTMLCanvasElement.prototype, "toBlob", function (this: HTMLCanvasElement, cb: (b: Blob | null) => void) {
      cb(blob);
    });
    const write = vi.fn().mockResolvedValue(undefined);
    defineClipboard({ write });
    const ClipboardItemCalls: Array<Record<string, Blob>> = [];
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(items: Record<string, Blob>) {
          ClipboardItemCalls.push(items);
        }
      },
    );
    return { write, ClipboardItemCalls };
  }

  it("returns false when the async clipboard or ClipboardItem is unavailable", async () => {
    defineClipboard(undefined); // no clipboard, no ClipboardItem in jsdom
    expect(await copyPng(makeSvg())).toBe(false);
  });

  it("writes a PNG ClipboardItem to the clipboard and returns true", async () => {
    override(window, "devicePixelRatio", 0); // exercises the `|| 1` scale fallback
    const blob = new Blob(["x"], { type: "image/png" });
    const { write, ClipboardItemCalls } = stubCanvasWithBlob(blob);
    const ok = await copyPng(makeSvg());
    expect(ok).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(ClipboardItemCalls).toHaveLength(1);
    expect(ClipboardItemCalls[0]["image/png"]).toBe(blob);
  });

  it("returns false when the canvas yields no blob", async () => {
    const { write } = stubCanvasWithBlob(null);
    expect(await copyPng(makeSvg())).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("returns false when the clipboard write rejects", async () => {
    const { write } = stubCanvasWithBlob(new Blob(["x"], { type: "image/png" }));
    write.mockRejectedValueOnce(new Error("denied"));
    expect(await copyPng(makeSvg())).toBe(false);
  });
});
