/**
 * Widget props → safe CSS values. Design TOKENS only: a widget never supplies a
 * free CSS color or length (unlike the source this was ported from, which
 * validated arbitrary CSS).
 *
 * Ported and narrowed from mireiffe/mirineereum (src/lib/genui/style.ts @
 * 0e469c4) with the owner's permission. The CSS variables are Noah's
 * (`src/client/styles/00-tokens.css`).
 */

/** One spacing unit in px (`gap={2}` = 8px). */
export const UNIT_PX = 4;
export const MAX_SPACING_UNITS = 8;

export const COLOR_TOKENS = Object.freeze(["default", "muted", "accent", "success", "warning", "danger", "info"] as const);
export const BACKGROUND_TOKENS = Object.freeze(["none", "surface", "subtle", "accent", "success", "warning", "danger", "info"] as const);
export const TONE_TOKENS = Object.freeze(["default", "accent", "success", "warning", "danger", "info"] as const);

const TEXT_CSS: Record<string, string> = {
  default: "var(--text)",
  muted: "var(--muted)",
  accent: "var(--accent)",
  success: "var(--ok)",
  warning: "var(--warn)",
  danger: "var(--danger)",
  info: "var(--info)",
};

const BACKGROUND_CSS: Record<string, string> = {
  none: "transparent",
  surface: "var(--panel)",
  subtle: "var(--bg-subtle)",
  accent: "var(--accent-soft)",
  success: "var(--ok-soft)",
  warning: "var(--warn-soft)",
  danger: "var(--danger-soft)",
  info: "var(--info-soft)",
};

const LINE_CSS: Record<string, string> = {
  default: "var(--line)",
  accent: "var(--accent)",
  success: "var(--ok-line)",
  warning: "var(--warn-line)",
  danger: "var(--danger-line)",
  info: "var(--info-line)",
};

function own(table: Record<string, string>, v: unknown): string | undefined {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(table, v) ? table[v] : undefined;
}

/** CSS color for a text color token, or undefined for anything else. */
export function textColor(v: unknown): string | undefined {
  return own(TEXT_CSS, v);
}

/** CSS background for a background token, or undefined for anything else. */
export function background(v: unknown): string | undefined {
  return own(BACKGROUND_CSS, v);
}

/** CSS border color for a tone token, or undefined for anything else. */
export function lineColor(v: unknown): string | undefined {
  return own(LINE_CSS, v);
}

/** A finite number, or a numeric string; undefined otherwise. */
export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return undefined;
}

/** A number clamped into [min, max]; undefined when it is not a number. */
export function clamp(v: unknown, min: number, max: number): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : Math.min(Math.max(n, min), max);
}

/** gap/padding in spacing units (0–8) → a px length. */
export function spacing(v: unknown): string | undefined {
  const n = clamp(v, 0, MAX_SPACING_UNITS);
  return n === undefined ? undefined : `${n * UNIT_PX}px`;
}

export const ALIGN: Readonly<Record<string, string>> = Object.freeze({
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
});

export const JUSTIFY: Readonly<Record<string, string>> = Object.freeze({
  start: "flex-start",
  center: "center",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
});

export function bool(v: unknown): boolean {
  return v === true || v === "true" || v === "";
}

export function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}
