export interface SpringValueOptions {
  from: number;
  to: number;
  velocity?: number;
  response?: number;
  dampingRatio?: number;
  onUpdate: (value: number) => void;
  onComplete?: () => void;
}

/** Apple-style exponential momentum projection. */
export function project(value: number, velocity: number, decelerationRate = 0.998): number {
  return value + (velocity / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Progressive resistance once a direct-manipulation gesture crosses a bound. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

const MOTION_KEY = "noah-motion";

/** `full` (default) animates everything; `reduce` is the viewer's own choice in 설정. */
export type MotionPref = "full" | "reduce";

/**
 * The motion preference is the APP's, never the operating system's: one
 * device-local value (`localStorage["noah-motion"]`, like the theme), applied as
 * `<html data-motion="reduce">`. Nothing in the client reads
 * `prefers-reduced-motion` — a PC whose OS animations are off (a corporate
 * performance policy, a remote session) would otherwise silently lose every
 * animation and the paced answer text with it. CSS keys on the attribute, JS on
 * `prefersReducedMotion()`.
 */
export function getMotionPref(): MotionPref {
  try {
    return localStorage.getItem(MOTION_KEY) === "reduce" ? "reduce" : "full";
  } catch {
    return "full";
  }
}

/** Writes the attribute the stylesheets key on. `full` removes it, so absent = animate. */
export function applyMotionPref(pref: MotionPref = getMotionPref()): MotionPref {
  if (typeof document !== "undefined") {
    if (pref === "reduce") document.documentElement.dataset.motion = "reduce";
    else delete document.documentElement.dataset.motion;
  }
  return pref;
}

export function setMotionPref(pref: MotionPref): void {
  try {
    if (pref === "reduce") localStorage.setItem(MOTION_KEY, "reduce");
    else localStorage.removeItem(MOTION_KEY);
  } catch {
    /* ignore — the choice still holds for this page */
  }
  applyMotionPref(pref);
}

/** The viewer chose 움직임 줄이기 in this app. Read when a motion STARTS; never the OS setting. */
export function prefersReducedMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement?.dataset?.motion === "reduce";
}

/**
 * Display-synchronised scalar spring. Retargeting callers can cancel this and
 * feed the current presentation value and velocity into the next spring.
 *
 * The default `dampingRatio` is critically damped (1.0) per DESIGN §2.5: a
 * programmatic settle must not overshoot. Underdamping (~0.8) is reserved for
 * springs continuing a user's flick momentum, and those callers pass it
 * explicitly.
 */
export function springValue(options: SpringValueOptions): () => void {
  const {
    from,
    to,
    velocity: initialVelocity = 0,
    response = 0.3,
    dampingRatio = 1,
    onUpdate,
    onComplete,
  } = options;

  if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
    onUpdate(to);
    onComplete?.();
    return () => {};
  }

  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const damping = 2 * dampingRatio * omega;
  let position = from;
  let velocity = initialVelocity;
  let previous = performance.now();
  let frame = 0;
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;
    const dt = Math.min(1 / 30, Math.max(1 / 240, (now - previous) / 1000));
    previous = now;
    const acceleration = -stiffness * (position - to) - damping * velocity;
    velocity += acceleration * dt;
    position += velocity * dt;
    onUpdate(position);

    if (Math.abs(position - to) < 0.5 && Math.abs(velocity) < 5) {
      onUpdate(to);
      onComplete?.();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  frame = requestAnimationFrame(step);
  return () => {
    cancelled = true;
    if (frame) cancelAnimationFrame(frame);
  };
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const SCROLL_INTERRUPTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Bring `element`'s top to the top of its scroll container on the app's own
 * spring — what `scrollIntoView({ behavior: "smooth", block: "start" })` did.
 * The browser's smooth scroll is switched off by the OS animation setting, which
 * this app does not follow; a spring on `scrollTop` is not. The viewer's own
 * scroll input takes over at once, and 움직임 줄이기 jumps (`springValue`).
 */
export function scrollToStart(element: HTMLElement): () => void {
  const scroller = scrollParent(element);
  const isRoot = scroller === document.scrollingElement || scroller === document.documentElement;
  const origin = isRoot ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
  const from = scroller.scrollTop;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const to = Math.min(max, Math.max(0, from + element.getBoundingClientRect().top - origin));
  if (Math.abs(to - from) < 1) return () => {};

  let settled = false;
  const release = () => {
    settled = true;
    for (const type of SCROLL_INTERRUPTS) scroller.removeEventListener(type, stop);
  };
  const cancel = springValue({
    from,
    to,
    response: 0.4,
    onUpdate: (value) => (scroller.scrollTop = value),
    onComplete: release,
  });
  function stop(): void {
    cancel();
    release();
  }
  // A spring that settled at once (움직임 줄이기, no display clock) has nothing to interrupt.
  if (settled) return () => {};
  for (const type of SCROLL_INTERRUPTS) scroller.addEventListener(type, stop, { passive: true });
  return stop;
}
