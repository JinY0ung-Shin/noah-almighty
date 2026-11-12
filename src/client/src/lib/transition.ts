// Element enter/exit transitions, framework-free: the easing curves, the
// `fade`/`fly`/`slide` configs and the runner that plays a config through the
// Web Animations API. The numbers and the keyframe sampling are the ones the
// app has always shipped with (one keyframe per 60 Hz frame along the easing
// curve), so a transition looks the same as before the React move. The React
// side — when an intro plays, how an element outlives its removal — is
// lib/presence.tsx.

export type Easing = (t: number) => number;

export interface TransitionConfig {
  delay?: number;
  duration?: number;
  easing?: Easing;
  /** Inline CSS for progress `t` (0 = gone, 1 = fully there); `u` is `1 - t`. */
  css?: (t: number, u: number) => string;
  tick?: (t: number, u: number) => void;
}

/**
 * What a transition function may return: the config, or a function producing it
 * that is called one microtask later ("deferred") — the way to decide a
 * conditional exit on state read when the exit actually starts.
 */
export type TransitionResult = TransitionConfig | (() => TransitionConfig);
export type TransitionFn<E extends Element = HTMLElement> = (node: E) => TransitionResult;

export const linear: Easing = (t) => t;

export const cubicOut: Easing = (t) => {
  const f = t - 1.0;
  return f * f * f + 1.0;
};

/** The curve closest to the CSS `--ease-out` token (cubic-bezier(0.16, 1, 0.3, 1)). */
export const quartOut: Easing = (t) => Math.pow(t - 1.0, 3.0) * (1.0 - t) + 1.0;

function splitCssUnit(value: number | string): [number, string] {
  const split = typeof value === "string" && value.match(/^\s*(-?[\d.]+)([^\s]*)\s*$/);
  return split ? [parseFloat(split[1]), split[2] || "px"] : [value as number, "px"];
}

export interface FadeParams {
  delay?: number;
  duration?: number;
  easing?: Easing;
}

/** Opacity from 0 to the element's own opacity (in), and back (out). */
export function fade(node: Element, { delay = 0, duration = 400, easing = linear }: FadeParams = {}): TransitionConfig {
  const o = +getComputedStyle(node).opacity;
  return { delay, duration, easing, css: (t) => `opacity: ${t * o}` };
}

export interface FlyParams extends FadeParams {
  x?: number | string;
  y?: number | string;
  opacity?: number;
}

/** Position and opacity: in from the given offset, out to it. */
export function fly(
  node: Element,
  { delay = 0, duration = 400, easing = cubicOut, x = 0, y = 0, opacity = 0 }: FlyParams = {},
): TransitionConfig {
  const style = getComputedStyle(node);
  const targetOpacity = +style.opacity;
  const transform = style.transform === "none" ? "" : style.transform;
  const od = targetOpacity * (1 - opacity);
  const [xValue, xUnit] = splitCssUnit(x);
  const [yValue, yUnit] = splitCssUnit(y);
  return {
    delay,
    duration,
    easing,
    css: (t, u) =>
      `transform: ${transform} translate(${(1 - t) * xValue}${xUnit}, ${(1 - t) * yValue}${yUnit});` +
      `opacity: ${targetOpacity - od * u}`,
  };
}

export interface SlideParams extends FadeParams {
  axis?: "x" | "y";
}

/** Collapses the element's box along one axis (padding, margin and border with it). */
export function slide(
  node: Element,
  { delay = 0, duration = 400, easing = cubicOut, axis = "y" }: SlideParams = {},
): TransitionConfig {
  const style = getComputedStyle(node) as CSSStyleDeclaration & Record<string, string>;
  const opacity = +style.opacity;
  const primary = axis === "y" ? "height" : "width";
  const primaryValue = parseFloat(style[primary]);
  const secondary = axis === "y" ? ["top", "bottom"] : ["left", "right"];
  const capitalized = secondary.map((e) => `${e[0].toUpperCase()}${e.slice(1)}`);
  const paddingStart = parseFloat(style[`padding${capitalized[0]}`]);
  const paddingEnd = parseFloat(style[`padding${capitalized[1]}`]);
  const marginStart = parseFloat(style[`margin${capitalized[0]}`]);
  const marginEnd = parseFloat(style[`margin${capitalized[1]}`]);
  const borderStart = parseFloat(style[`border${capitalized[0]}Width`]);
  const borderEnd = parseFloat(style[`border${capitalized[1]}Width`]);
  return {
    delay,
    duration,
    easing,
    css: (t) =>
      "overflow: hidden;" +
      `opacity: ${Math.min(t * 20, 1) * opacity};` +
      `${primary}: ${t * primaryValue}px;` +
      `padding-${secondary[0]}: ${t * paddingStart}px;` +
      `padding-${secondary[1]}: ${t * paddingEnd}px;` +
      `margin-${secondary[0]}: ${t * marginStart}px;` +
      `margin-${secondary[1]}: ${t * marginEnd}px;` +
      `border-${secondary[0]}-width: ${t * borderStart}px;` +
      `border-${secondary[1]}-width: ${t * borderEnd}px;` +
      `min-${primary}: 0`,
  };
}

function camelCase(property: string): string {
  if (property === "float") return "cssFloat";
  if (property === "offset") return "cssOffset";
  if (property.startsWith("--")) return property;
  const parts = property.split("-");
  if (parts.length === 1) return parts[0];
  return parts[0] + parts.slice(1).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
}

function cssToKeyframe(css: string): Record<string, string> {
  const keyframe: Record<string, string> = {};
  for (const part of css.split(";")) {
    const [property, value] = part.split(":");
    if (!property || value === undefined) break;
    keyframe[camelCase(property.trim())] = value.trim();
  }
  return keyframe;
}

/** A running (or finished) half of a transition. */
export interface TransitionRun {
  /** Cancel the animation and drop its styles. */
  abort(): void;
  /** Keep the animation but never report its finish. */
  deactivate(): void;
  /** After an aborted exit: put a `tick`-driven element back at "fully there". */
  reset(): void;
  /** Current progress, so the opposite half can start from where this one is. */
  t(): number;
}

const noop = (): void => {};

/**
 * Play `options` on `element` towards `target` (1 = intro, 0 = outro).
 * `counterpart` is the opposite half when it is still running: the new run
 * starts from its progress instead of from the far end.
 */
export function runTransition(
  element: Element,
  options: TransitionResult,
  counterpart: TransitionRun | undefined,
  target: 0 | 1,
  onFinish: () => void,
): TransitionRun {
  const isIntro = target === 1;

  if (typeof options === "function") {
    let inner: TransitionRun | undefined;
    let aborted = false;
    queueMicrotask(() => {
      if (aborted) return;
      inner = runTransition(element, options(), counterpart, target, onFinish);
    });
    return {
      abort: () => {
        aborted = true;
        inner?.abort();
      },
      deactivate: () => inner?.deactivate(),
      reset: () => inner?.reset(),
      t: () => inner?.t() ?? 1 - target,
    };
  }

  counterpart?.deactivate();

  if (!options?.duration && !options?.delay) {
    onFinish();
    return { abort: noop, deactivate: noop, reset: noop, t: () => target };
  }

  const { delay = 0, css, tick, easing = linear } = options;
  const first: Keyframe[] = [];
  if (isIntro && counterpart === undefined) {
    tick?.(0, 1);
    if (css) {
      const styles = cssToKeyframe(css(0, 1));
      first.push(styles, styles);
    }
  }

  let getT = (): number => 1 - target;
  let finish = onFinish;

  // A hold that lasts the delay. It is kept when the delay is 0 too, so the
  // keyframes are computed only after the DOM has settled; it fills forwards
  // so an arriving element is never painted without its starting styles.
  let animation = element.animate(first, { duration: delay, fill: "forwards" });

  animation.onfinish = () => {
    animation.cancel();
    const from = counterpart?.t() ?? 1 - target;
    counterpart?.abort();

    const delta = target - from;
    const duration = (options.duration as number) * Math.abs(delta);
    const keyframes: Keyframe[] = [];

    if (duration > 0) {
      if (css) {
        // `n` must be an integer, or the last keyframe could miss `target`.
        const n = Math.ceil(duration / (1000 / 60));
        for (let i = 0; i <= n; i += 1) {
          const t = from + delta * easing(i / n);
          keyframes.push(cssToKeyframe(css(t, 1 - t)));
        }
      }
      getT = () => from + delta * easing(Number(animation.currentTime) / duration);
      if (tick) {
        const step = (): void => {
          if (animation.playState !== "running") return;
          const t = getT();
          tick(t, 1 - t);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }

    animation = element.animate(keyframes, { duration, fill: "forwards" });
    animation.onfinish = () => {
      getT = () => target;
      tick?.(target, 1 - target);
      finish();
    };
  };

  return {
    abort: () => {
      animation.cancel();
      // Chromium keeps a cancelled animation's effect alive otherwise.
      animation.effect = null;
      animation.onfinish = noop;
    },
    deactivate: () => {
      finish = noop;
    },
    reset: () => {
      if (target === 0) tick?.(1, 0);
    },
    t: () => getT(),
  };
}
