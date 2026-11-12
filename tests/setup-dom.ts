// jsdom does not implement Web Animations. The client plays every element
// enter/exit transition through it (lib/transition.ts `runTransition`, driven by
// lib/presence.tsx and by the 할 일 card), so component tests get a zero-time,
// deterministic stand-in while real timing remains covered by Playwright.
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

// The 할 일 card's sibling glide (components/TodoOverlay.tsx, `CardMotion.hold`)
// asks a LEAVING row or section for its running animations, and jsdom has none.
// Nothing runs here, so an empty list is honest.
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
