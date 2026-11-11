import { writable } from "svelte/store";
import { prefersReducedMotion } from "./motion";

const THEME_KEY = "noah-theme";

export type ThemePref = "system" | "light" | "dark";
/** The theme actually in effect — "system" already resolved against the OS. */
export type ResolvedTheme = "light" | "dark";

const media = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function getThemePref(): ThemePref {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): ResolvedTheme {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

/** The theme in effect right now, for one-shot imperative reads. */
export function currentTheme(): ResolvedTheme {
  if (typeof document === "undefined") return resolve(getThemePref());
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const resolvedTheme = writable<ResolvedTheme>(currentTheme());

/**
 * Resolved theme as a subscribable store. Canvas-style renderers (cytoscape,
 * Vega, mermaid) read their colors imperatively at build time, so a `data-theme`
 * flip alone leaves them stranded on the old palette — they subscribe here and
 * re-derive. `applyTheme` is the single writer.
 */
export const theme = { subscribe: resolvedTheme.subscribe };

/**
 * A design-token value resolved against the theme in effect — e.g.
 * `cssToken("--accent")` → "#0f766e". Custom properties are substituted in the
 * computed style, so the `var()` chains resolve; `fallback` covers a context
 * with no stylesheet loaded. For canvas/chart renderers that need a real color
 * string instead of a CSS reference.
 */
export function cssToken(name: string, fallback = ""): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * A color token as a string ANY color parser accepts: `rgba(r, g, b, a)`, or the
 * value unchanged when it is already a plain color. The production CSS minifier
 * rewrites `rgba(255, 255, 255, 0.88)` to `#ffffffe0`, which cytoscape rejects
 * (it falls back to its default — a black label box); dev builds are unminified,
 * so only a deployed build shows it. Use this, not `cssToken`, for colors handed
 * to a renderer with its own parser.
 */
export function cssColor(name: string, fallback: string): string {
  return normalizeColor(cssToken(name, fallback)) ?? fallback;
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

/** `value` as `#rgb`/`#rrggbb`/`rgb()`/`rgba()`, or `null` if it is not a color. Exported for tests. */
export function normalizeColor(value: string): string | null {
  const v = value.trim();
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(v)?.[1];
  if (hex) {
    const full = hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b, a] = [0, 2, 4, 6].map((i) => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
  }
  if (/^(#[0-9a-f]{3}|#[0-9a-f]{6}|(rgba?|hsla?)\([^)]*\))$/i.test(v)) return v;
  // Anything else (a color name, color-mix(), oklch()…): let the browser's canvas
  // serialize it — `fillStyle` reads back as `#rrggbb` or `rgba(…)`. Two sentinels
  // tell "not a color" (assignment ignored) apart from a color equal to one of them.
  if (colorProbe === undefined) {
    try {
      colorProbe = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
    } catch {
      colorProbe = null;
    }
  }
  if (!colorProbe || !v) return null;
  const read = (sentinel: string): string => {
    colorProbe!.fillStyle = sentinel;
    colorProbe!.fillStyle = v;
    return String(colorProbe!.fillStyle);
  };
  const a = read("#000000");
  return a === read("#ffffff") ? a : null;
}

export function applyTheme(pref = getThemePref()): ThemePref {
  const resolved = resolve(pref);
  document.documentElement.dataset.theme = resolved;
  resolvedTheme.set(resolved);
  return pref;
}

function applyThemeWithTransition(pref: ThemePref): void {
  const reduced = prefersReducedMotion();
  const documentWithTransitions = document as Document & {
    startViewTransition?: (update: () => void) => { finished: Promise<void> };
  };
  if (!reduced && documentWithTransitions.startViewTransition) {
    documentWithTransitions.startViewTransition(() => applyTheme(pref));
    return;
  }
  if (!reduced) {
    // Hold the element, not the global: the timer can outlive the document it was
    // started in (a test environment torn down inside the 220 ms).
    const root = document.documentElement;
    root.classList.add("theme-changing");
    window.setTimeout(() => root.classList.remove("theme-changing"), 220);
  }
  applyTheme(pref);
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  applyThemeWithTransition(pref);
}

export function watchSystemTheme(): void {
  media?.addEventListener?.("change", () => {
    if (getThemePref() === "system") applyThemeWithTransition("system");
  });
}
