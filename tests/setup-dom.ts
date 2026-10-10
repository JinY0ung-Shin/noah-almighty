// jsdom does not implement Web Animations. Svelte 5 uses it internally for
// transition directives, so component tests get a zero-time, deterministic
// stand-in while real timing remains covered by Playwright.
if (typeof Element !== "undefined" && !(Element.prototype as Element & { animate?: unknown }).animate) {
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(_keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const duration = typeof options === "number" ? options : Number(options?.duration ?? 0);
      let cancelled = false;
      let finish: (() => void) | null = null;
      const animation = {
        currentTime: duration,
        effect: null,
        playState: "finished",
        cancel() {
          cancelled = true;
        },
        get onfinish() {
          return finish;
        },
        set onfinish(callback: (() => void) | null) {
          finish = callback;
          if (callback) queueMicrotask(() => {
            if (!cancelled && finish === callback) callback();
          });
        },
      };
      return animation;
    },
  });
}

// Svelte's `animate:` directive (the 할 일 card's sibling glide) asks a LEAVING
// keyed row for its running animations, and jsdom has none. Nothing runs here,
// so an empty list is honest.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
}

// jsdom has no ResizeObserver, and the transcript's stick-to-bottom controller
// (lib/autoscroll.ts) constructs one on attach — so ANY component test that
// mounts the chat transcript throws without this. Layout never changes in jsdom,
// so a no-op observer is honest here; real re-pin behavior is Playwright's job.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
