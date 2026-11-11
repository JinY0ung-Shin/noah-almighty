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

/* ───────────────────────── URLs a widget may name ───────────────────────── */

/** Longest link target accepted. */
export const MAX_URL_CHARS = 2000;

/** C0/C1 controls, spaces of any kind and line separators: none may appear inside a URL or a path. */
const URL_FORBIDDEN = /[\u0000-\u0020\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff\\]/;

/**
 * A link target a widget may open: an ABSOLUTE `http:` / `https:` URL, written
 * with its scheme and `//`, without credentials, at most MAX_URL_CHARS long and
 * free of control characters, whitespace and backslashes. Returns the
 * NORMALIZED href (what a renderer should both show and open — an
 * internationalized host comes back as punycode), or null.
 *
 * Everything else is null: `javascript:` / `data:` / `vbscript:` (however the
 * scheme is cased or split by a tab or newline, which URL parsers silently
 * drop), relative paths, protocol-relative `//host`, `https:\\host`.
 */
export function safeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_URL_CHARS) return null;
  if (URL_FORBIDDEN.test(text)) return null;
  if (!/^https?:\/\/[^/?#]/i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  return url.href.length <= MAX_URL_CHARS ? url.href : null;
}

const IMAGE_REF = /^\/api\/conversations\/([A-Za-z0-9_.-]+)\/images\/([A-Za-z0-9_.-]+)$/;

/**
 * The parts of a CONVERSATION IMAGE address — the only kind of `src` a widget
 * image accepts: `/api/conversations/<conversationId>/images/<imageId>`, a
 * same-origin path with no query, no fragment, no `..` and nothing encoded.
 * An absolute URL, a `data:` URL, `//host/…` or any other path is null.
 *
 * This checks the SHAPE only. Whether `conversationId` is the conversation the
 * widget is shown in is the renderer's check — it must refuse any other id.
 */
export function conversationImageRef(value: unknown): { conversationId: string; imageId: string } | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const m = IMAGE_REF.exec(value);
  if (!m) return null;
  const [, conversationId, imageId] = m;
  // A segment made only of dots is a path step, not an id.
  if (/^\.+$/.test(conversationId) || /^\.+$/.test(imageId)) return null;
  return { conversationId, imageId };
}
