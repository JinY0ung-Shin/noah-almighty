#!/usr/bin/env node
// theme-check.mjs — checks a deck theme (one of the skill's themes/*.css, or a deck's own deck.css) against what the
// kit and the example slides actually draw: the WCAG contrast pairs of reference/AUTHORING.md §9 (text >= 4.5:1,
// marks >= 3:1), the distinctness of the data colours that share a chart, semantic PowerPoint theme slots, and hue
// leftovers (a token still in the colours of the theme it was copied from). It also derives a theme from brand
// colours that passes the same audit. Read-only (a derived theme goes to stdout); no dependencies.
//
//   node theme-check.mjs <deck folder | theme .css> [--json]
//   node theme-check.mjs --derive <brand colour> [--accent <colour>] [--base classic|midnight]
//   node theme-check.mjs --from-pptx <template.pptx> [--accent <colour>] [--base classic|midnight]
//
// exit 0: every check holds (warnings possible) · 1: a check failed (each one printed) · 2: usage, an unreadable
// file, or a token that does not resolve to a colour. The skill's tests run the same audit over every shipped theme.
// Deriving prints a complete deck.css on stdout and its report on stderr (colours are RRGGBB or RGB, with or without
// '#'): exit 0 = it passes the audit · 1 = it still fails after repair · 2 = bad input (a colour, a flag, an
// unreadable or refused .pptx). Nothing reaches stdout unless it exits 0, so
// `… > <deck>/deck.css.new && mv <deck>/deck.css.new <deck>/deck.css` never replaces a theme with a broken or empty one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE_CSS_PATH = path.join(HERE, "..", "converter", "theme", "base.css");
const THEMES_DIR = path.join(HERE, "..", "themes");

/** The custom properties a stylesheet declares in its `:root` blocks (comments stripped), in declaration order. */
export function cssTokens(css) {
  const out = new Map();
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  }
  return out;
}

/** The value of a token with every var() substituted. Throws on an undefined token or a loop. */
export function resolveToken(vars, name, depth = 0) {
  if (depth > 20) throw new Error(`var() loop at ${name}`);
  const v = vars.get(name);
  if (v === undefined) throw new Error(`${name} is not defined`);
  return v.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (_, n) => resolveToken(vars, n, depth + 1));
}

/** '#RGB' / '#RRGGBB' / 'rgb(…)' / 'rgba(…)' → [r, g, b, a]. */
export function parseColour(str) {
  const t = String(str).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(t);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)).concat(1);
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(t);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4] / (m[5] ? 100 : 1)];
  if (/^white$/i.test(t)) return [255, 255, 255, 1];
  if (/^black$/i.test(t)) return [0, 0, 0, 1];
  throw new Error(`not a colour this check reads: ${t} (use hex or rgb()/rgba())`);
}

const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const luminance = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** CIE76 ΔE between two opaque colours (sRGB → CIELAB, D65). */
export function deltaE(a, b) {
  const lab = (c) => {
    const [r, g, b_] = [lin(c[0]), lin(c[1]), lin(c[2])];
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b_) / 0.95047);
    const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b_);
    const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b_) / 1.08883);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
/** HSL hue (degrees), saturation and lightness (0–1) of a colour. */
function hueSat(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// A layer is a token ("--c-brand-900"), a literal colour, "white@0.56" (translucent white) or
// "mix(--a,--b)" (the middle of a two-stop gradient). A check's background is one layer or a stack (bottom first);
// its foreground is composited over the stack's top.
const text = (fgs, bg, what) => fgs.map((fg) => ({ fg, bg, min: 4.5, what }));
const mark = (fgs, bg, what) => fgs.map((fg) => ({ fg, bg, min: 3, what }));
const COVER_MID = "mix(--c-cover-from,--c-cover-to)";
export const PAIRS = [
  ...text(["--c-ink-900", "--c-ink-700", "--c-ink-600", "--c-ink-500", "--c-brand-600", "--c-accent-700"], "--c-ink-50", "text on the page"),
  ...text(["--c-ink-900", "--c-ink-700", "--c-ink-600", "--c-ink-500", "--c-brand-600", "--c-brand-700", "--c-up-600", "--c-down-600"], "--c-surface", "text on the surface"),
  ...text(["--c-brand-700", "--c-brand-600", "--c-ink-900", "--c-ink-700", "--c-ink-600", "--c-ink-500"], "--c-brand-50", "text on the brand-50 tint"),
  ...text(["--c-brand-700", "--c-ink-800"], "--c-brand-100", "text on the brand-100 tint"),
  { fg: "--c-up-600", bg: "--c-up-50", min: 4.5, what: "up pill" },
  { fg: "--c-down-600", bg: "--c-down-50", min: 4.5, what: "down pill" },
  { fg: "--c-ink-900", bg: "--c-accent-100", min: 4.5, what: "text on the accent tint" },
  // the photo slot's hint on its fill (in the HTML renders only — the converter drops the hint)
  { fg: "--c-ink-600", bg: "--c-ink-100", min: 4.5, what: "photo-slot hint" },
  // the dark emphasis surface, the section divider, the cover gradient (white 56 % and the accent kicker sit in its
  // first half; its light end carries white 60 % at the least — the closing's page number)
  ...["--c-brand-900", "--c-brand-950", "--c-cover-from", COVER_MID].flatMap((bg) =>
    text(["--c-white", "white@0.56", "--c-accent-500"], bg, "text on a dark surface")),
  ...text(["--c-white", "white@0.60"], "--c-cover-to", "text on the cover's light end"),
  // translucent boxes and chips on the dark surfaces, as the examples draw them: the section divider's preview rows
  // (6 %, white 56 % kickers), the agenda's ask box and the directory's urgent note (8 %, white 64 % labels), glass
  // pills (12 %, white text), the closing's approval rows (8 % on the cover gradient's light end, white 72 % labels)
  { fg: "white@0.56", bg: ["--c-brand-900", "white@0.06"], min: 4.5, what: "text in a glass row on the emphasis surface" },
  { fg: "white@0.64", bg: ["--c-brand-900", "white@0.08"], min: 4.5, what: "text in a glass box on the emphasis surface" },
  ...text(["--c-white"], ["--c-brand-900", "white@0.12"], "text in a glass pill on the emphasis surface"),
  ...text(["--c-white"], ["--c-cover-from", "white@0.12"], "text in a glass pill on the cover"),
  { fg: "white@0.72", bg: ["--c-cover-to", "white@0.08"], min: 4.5, what: "text in a glass box on the cover's light end" },
  { fg: "#5FE0A5", bg: ["--c-brand-900", "rgba(52, 211, 140, 0.16)"], min: 4.5, what: "up-on-dark pill" },
  { fg: "#FFA39D", bg: ["--c-brand-900", "rgba(255, 107, 107, 0.16)"], min: 4.5, what: "down-on-dark pill" },
  { fg: "#5FE0A5", bg: ["--c-brand-900", "white@0.08", "rgba(52, 211, 140, 0.16)"], min: 4.5, what: "up-on-dark pill in a glass box" },
  { fg: "#FFA39D", bg: ["--c-brand-900", "white@0.08", "rgba(255, 107, 107, 0.16)"], min: 4.5, what: "down-on-dark pill in a glass box" },
  // text on fills
  { fg: "--c-on-fill", bg: "--c-brand-600", min: 4.5, what: "bar label on brand-600" },
  { fg: "--c-on-fill", bg: "--c-ink-500", min: 4.5, what: "bar label on ink-500" },
  { fg: "--c-brand-900", bg: "--c-white", min: 4.5, what: "text on a white chip" },
  // data marks
  ...mark(["--c-series-prev", "--c-series-curr", "--c-series-fcst", "--c-series-strong", "--c-accent-600", "--c-brand-600"], "--c-surface", "mark on the surface"),
  ...mark(["--c-brand-600", "--c-accent-700", "--c-ink-500"], "--c-ink-50", "mark on the page"),
  ...mark(["--c-accent-500", "white@0.40"], "--c-brand-900", "mark on the emphasis surface"),
  { fg: "--c-accent-500", bg: "--c-cover-to", min: 3, what: "mark on the cover's light end" },
  // PowerPoint theme slots: inserted text on the background slot, both ways
  { fg: "--pptx-lt1", bg: "--pptx-dk1", min: 4.5, what: "PowerPoint lt1 on dk1" },
  { fg: "--pptx-lt2", bg: "--pptx-dk2", min: 4.5, what: "PowerPoint lt2 on dk2" },
];
// Data colours that share one chart must be told apart (CIE76 ΔE; classic's closest pair is 35).
export const DISTINCT = [
  ["--c-series-prev", "--c-series-curr"], ["--c-series-curr", "--c-series-fcst"], ["--c-series-prev", "--c-series-fcst"],
  ["--c-series-strong", "--c-series-curr"], ["--c-series-strong", "--c-series-fcst"],
];
export const MIN_DELTA_E = 20;
// Tokens that carry the brand's or the accent's hue: a copy of another theme keeps its old hue here unless replaced.
export const HUE_FAMILIES = {
  "--c-brand-600": ["--c-brand-950", "--c-brand-900", "--c-brand-800", "--c-brand-700", "--c-brand-500",
    "--c-brand-400", "--c-brand-300", "--c-brand-200", "--c-brand-100", "--c-brand-50", "--c-cover-from",
    "--c-cover-to", "--c-cover-fcst", "--c-series-curr", "--c-series-fcst"],
  "--c-accent-500": ["--c-accent-700", "--c-accent-600", "--c-accent-300", "--c-accent-100", "--c-mark-b",
    "--c-accent-soft"],
};
const MAX_HUE_DRIFT = 45;
const CHROMATIC = 0.2; // saturation below which a colour has no hue worth comparing

// Every check of one theme as data — each contrast pair with its ratio and the luminances of its two sides, each data
// pair with its ΔE, the semantic-slot comparisons, the hue leftovers. auditTheme() words them; the derive repairs
// from them.
function runChecks(vars) {
  const layer = (t) => {
    const mix = /^mix\((--[a-z0-9-]+),(--[a-z0-9-]+)\)$/.exec(t);
    if (mix) {
      const [a, b] = [layer(mix[1]), layer(mix[2])];
      return [0, 1, 2].map((i) => (a[i] + b[i]) / 2).concat(1);
    }
    if (t.startsWith("white@")) return [255, 255, 255, Number(t.slice(6))];
    return parseColour(t.startsWith("--") ? resolveToken(vars, t) : t);
  };
  const stack = (bg) => (Array.isArray(bg) ? bg : [bg]).map(layer).reduce((under, l) => (under ? over(l, under) : l), null);
  const pairs = PAIRS.map((p) => {
    const bg = stack(p.bg), fg = over(layer(p.fg), bg);
    return { ...p, r: contrast(fg, bg), fgLum: luminance(fg), bgLum: luminance(bg) };
  });
  const distinct = DISTINCT.map(([a, b]) => ({ a, b, d: deltaE(layer(a), layer(b)), la: luminance(layer(a)), lb: luminance(layer(b)) }));
  const slots = [["--pptx-dk1", "--pptx-lt1"], ["--pptx-dk2", "--pptx-lt2"]]
    .map(([dark, light]) => ({ dark, light, ok: luminance(layer(dark)) < luminance(layer(light)) }));
  const hues = [];
  for (const [anchor, members] of Object.entries(HUE_FAMILIES)) {
    const a = hueSat(layer(anchor));
    if (a.s < CHROMATIC) continue;
    for (const t of members) {
      const c = hueSat(layer(t));
      if (c.s < CHROMATIC) continue;
      const drift = hueDistance(c.h, a.h);
      if (drift > MAX_HUE_DRIFT) hues.push({ t, anchor, drift });
    }
  }
  return { pairs, distinct, slots, hues };
}
const failed = (p) => p.r < p.min - 1e-9;
const layerNames = (x) => (Array.isArray(x) ? x.join(" + ") : x);
/** The audit's words for every check that fails in a runChecks() result. */
function failureLines({ pairs, distinct, slots }) {
  return [
    ...pairs.filter(failed).map((p) => `${p.what}: ${p.fg} on ${layerNames(p.bg)} = ${p.r.toFixed(2)}:1 (needs ${p.min}:1)`),
    ...distinct.filter((x) => x.d < MIN_DELTA_E)
      .map((x) => `data colours too alike: ${x.a} and ${x.b} (ΔE ${x.d.toFixed(0)}, needs ${MIN_DELTA_E})`),
    ...slots.filter((s) => !s.ok)
      .map((s) => `PowerPoint slots must be semantic: ${s.dark} (the dark text/background colour) is lighter than ${s.light}`),
  ];
}

/**
 * The audit of one theme: the base.css defaults overlaid with the theme's own tokens.
 * Returns {failures: string[], warnings: string[], checks: number, worst: string}. Throws when a token does not
 * resolve to a colour this check reads.
 */
export function auditTheme(baseCss, themeCss) {
  const vars = new Map([...cssTokens(baseCss), ...cssTokens(themeCss)]);
  const res = runChecks(vars), { pairs, hues } = res;
  const failures = failureLines(res);
  const warnings = hues.map((w) =>
    `hue leftover? ${w.t} ${resolveToken(vars, w.t)} is ${w.drift.toFixed(0)}° from ${w.anchor} ${resolveToken(vars, w.anchor)}`);
  const ratios = pairs.map((p) => [p.r / p.min, `${p.fg} on ${layerNames(p.bg)} ${p.r.toFixed(2)}:1`]).sort((x, y) => x[0] - y[0]);
  return { failures, warnings, checks: PAIRS.length + DISTINCT.length + 2, worst: ratios.slice(0, 3).map((x) => x[1]).join(", ") };
}

// ---------------------------------------------------------------------------------------------------------------
// Deriving a theme from brand colours. The base theme (classic, or midnight for a dark deck) keeps its neutrals,
// deltas, surfaces, shapes and every lightness step; each token in the brand's or the accent's hue family takes the
// anchor's HSL hue and saturation at the WCAG luminance of the token it replaces. The audit's pairs are driven by
// luminance, so the base's margins carry over; what does not (translucent white composited in sRGB, data colours
// told apart by hue, 8-bit rounding) is repaired against the audit itself.
// ---------------------------------------------------------------------------------------------------------------
export const DERIVE_BASES = ["classic", "midnight"];
const MAX_REPAIR_ROUNDS = 40;
// Data series the brand's hue cannot tell apart — a grey brand's, or a dull one's next to the grey prior-period
// colour — step in lightness instead, as CIE L*: classic's steps are mono's, midnight's the light-on-dark mirror
// (strong and prev never share a chart). prev keeps the base's own neutral hue, the others take the brand's.
const SERIES_STEPS = {
  classic: { "--c-series-strong": 0, "--c-series-curr": 20.6, "--c-series-fcst": 41, "--c-series-prev": 61.3 },
  midnight: { "--c-series-fcst": 46, "--c-series-prev": 67, "--c-series-curr": 88, "--c-series-strong": 67 },
};
const lstarLuminance = (L) => (L > 8 ? ((L + 16) / 116) ** 3 : L / 903.3);
const toHex = (c) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;

function fromHsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgb.map((v) => (v + m) * 255);
}
/** The 8-bit colour of hue h and saturation s whose luminance is y: HSL lightness by bisection (luminance rises
 *  monotonically with it at a fixed hue and saturation). */
function atLuminance(h, s, y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(fromHsl(h, s, mid)) < y) lo = mid;
    else hi = mid;
  }
  return fromHsl(h, s, (lo + hi) / 2).map((v) => Math.min(255, Math.max(0, Math.round(v)))).concat(1);
}
/** Text wrapped into the lines of a CSS comment (" * …"). */
const commentLines = (text, width = 118) => text.split(" ").reduce((lines, word) => {
  if (lines.length && `${lines[lines.length - 1]} ${word}`.length <= width) lines[lines.length - 1] += ` ${word}`;
  else lines.push(` * ${word}`);
  return lines;
}, []);

/** A colour given on the command line: RRGGBB or RGB, with or without '#'. */
function parseHexArg(value, what = "colour") {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim());
  if (!m) throw new Error(`${what} ${value}: not a colour — give RRGGBB or RGB, with or without # (quote a leading #)`);
  return parseColour(`#${m[1]}`);
}

/**
 * A complete deck.css in the brand's colours, built on a shipped base theme and checked with auditTheme().
 * brand / accent: a hex string (see parseHexArg) or [r, g, b, a]; the accent is optional. `via` names where the
 * colours came from (a template), for the file header. Returns {css, audit, notes: string[] (where each colour went),
 * rounds}: css is complete whatever the audit says — the CLI prints it only when the audit has no failure.
 */
export function deriveTheme(brand, { accent = null, base = "classic", via = "" } = {}) {
  const { css, audit, notes, rounds } = derive(brand, { accent, base, via }, true);
  return { css, audit, notes, rounds };
}

// deriveTheme() itself, also saying whether brand-600 is the colour verbatim. `tips`: the report may suggest the other
// base, which it checks by deriving there first (with tips off, so the check never nests).
function derive(brand, { accent, base, via }, tips) {
  if (!DERIVE_BASES.includes(base)) throw new Error(`--base is ${DERIVE_BASES.join(" or ")}, not ${base}`);
  brand = Array.isArray(brand) ? brand : parseHexArg(brand, "brand");
  if (accent !== null && !Array.isArray(accent)) accent = parseHexArg(accent, "accent");
  const baseText = fs.readFileSync(BASE_CSS_PATH, "utf8"), baseDefaults = cssTokens(baseText);
  const themeCss = fs.readFileSync(path.join(THEMES_DIR, `${base}.css`), "utf8"), own = cssTokens(themeCss);
  const baseVars = new Map([...baseDefaults, ...own]);
  const colourOf = (t) => parseColour(resolveToken(baseVars, t));
  const hex = toHex(brand), b = hueSat(brand), grey = b.s < CHROMATIC;

  // The anchors. Without --accent the base's own accent stays, unless its hue is within 45° of the brand's: then it
  // turns to the brand's complement at its own saturation. A colour that IS the base's own keeps the base's ramp.
  const baseAccent = colourOf("--c-accent-500"), ba = hueSat(baseAccent), accentGap = hueDistance(ba.h, b.h);
  // (+1°: brand-600 is painted at the base's luminance and rounded to 8 bits, which moves its hue by up to ~0.6°.)
  const turned = !accent && !grey && accentGap < MAX_HUE_DRIFT + 1;
  const keep = {
    brand: hex === toHex(colourOf("--c-brand-600")),
    accent: !turned && (!accent || toHex(accent) === toHex(baseAccent)),
  };
  const anchors = {
    brand: b,
    accent: keep.accent ? ba : accent ? hueSat(accent) : { h: (b.h + 180) % 360, s: ba.s },
    neutral: hueSat(colourOf("--c-series-prev")),
  };

  // Which anchor each literal token follows: the audit's hue families and their anchors, and the decoration the
  // families leave out (the cover's halo and orbit, midnight's light strong series) by the hue it has in the base —
  // midnight's orbit is its cyan accent. A var() reference (series-curr: var(--c-brand-600)) follows by itself.
  const follows = new Map();
  for (const t of ["--c-brand-600", ...HUE_FAMILIES["--c-brand-600"]]) follows.set(t, "brand");
  for (const t of ["--c-accent-500", ...HUE_FAMILIES["--c-accent-500"]]) follows.set(t, "accent");
  const brandHue = hueSat(colourOf("--c-brand-600")).h;
  for (const t of ["--c-cover-halo", "--c-cover-orbit", "--c-series-strong"]) {
    const c = hueSat(colourOf(t));
    if (c.s >= CHROMATIC) follows.set(t, hueDistance(c.h, ba.h) < hueDistance(c.h, brandHue) ? "accent" : "brand");
  }
  // A plan: the anchor and target luminance of every token the derive paints — the base token's own luminance, or
  // for stepped data series their lightness step. A kept colour leaves the base's own tokens of its family as they are.
  const plan = (stepped) => {
    const targets = new Map();
    for (const [t, anchor] of follows) {
      if (!own.has(t) || /^var\(/.test(own.get(t)) || keep[anchor]) continue;
      const c = colourOf(t);
      const alpha = c[3] < 1 ? (/[\d.]+%?(?=\s*\)$)/.exec(own.get(t))?.[0] ?? String(c[3])) : null; // the base's own text
      targets.set(t, { anchor, y: luminance(c), alpha });
    }
    if (stepped) {
      for (const [t, L] of Object.entries(SERIES_STEPS[base])) {
        targets.set(t, { anchor: t === "--c-series-prev" ? "neutral" : "brand", y: lstarLuminance(L), alpha: null });
      }
    }
    return targets;
  };
  const paint = (targets, exact) => {
    const values = new Map(own);
    for (const [t, { anchor, y, alpha }] of targets) {
      const c = atLuminance(anchors[anchor].h, anchors[anchor].s, Math.min(1, Math.max(0, y)));
      values.set(t, alpha ? `rgba(${c.slice(0, 3).join(", ")}, ${alpha})` : toHex(c));
    }
    if (exact) values.set("--c-brand-600", hex);
    return values;
  };
  const check = (values) => runChecks(new Map([...baseDefaults, ...values]));
  const failing = (res) => [...res.pairs.filter(failed), ...res.distinct.filter((x) => x.d < MIN_DELTA_E)];

  // Bounded repair, re-checked every round. Text on a surface the derive paints moves the surface away from the text
  // (a dark surface darker: luminance ×0.93), otherwise the text moves (×0.95); a data pair too alike moves apart (the
  // lighter ×1.04, the darker ×0.96), series-curr and -strong through brand-600 and -900 while they point there.
  // Legibility wins where the two disagree; brand-600 stays put while it is the user's exact colour.
  const repair = (planned, exact) => {
    const targets = new Map([...planned].map(([t, x]) => [t, { ...x }]));
    if (exact) targets.delete("--c-brand-600");
    const painted = (t) => { // the painted token a layer comes from, through var() references; null for a literal
      for (let i = 0; i < 5 && t; i++) {
        if (targets.has(t)) return t;
        t = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(own.get(t) ?? "")?.[1];
      }
      return null;
    };
    const paintedIn = (layer) =>
      (/^mix\((--[a-z0-9-]+),(--[a-z0-9-]+)\)$/.exec(layer)?.slice(1) ?? [layer]).map(painted).filter(Boolean);
    const moved = new Set();
    let values = paint(targets, exact), res = check(values), rounds = 0;
    for (; rounds < MAX_REPAIR_ROUNDS && failing(res).length; rounds++) {
      const step = new Map();
      for (const x of res.distinct.filter((d) => d.d < MIN_DELTA_E)) {
        const [lighter, darker] = (x.la >= x.lb ? [x.a, x.b] : [x.b, x.a]).map(painted);
        if (lighter === darker) continue;
        if (lighter) step.set(lighter, (y) => Math.min(1, y * 1.04));
        if (darker) step.set(darker, (y) => y * 0.96);
      }
      for (const p of res.pairs.filter(failed)) {
        const under = paintedIn([p.bg].flat()[0]), textIsLighter = p.fgLum > p.bgLum;
        if (under.length) for (const t of under) step.set(t, textIsLighter ? (y) => y * 0.93 : (y) => 1 - (1 - y) * 0.93);
        else for (const t of paintedIn(p.fg)) step.set(t, textIsLighter ? (y) => 1 - (1 - y) * 0.95 : (y) => y * 0.95);
      }
      if (!step.size) break; // nothing that fails is the derive's to move
      for (const [t, f] of step) {
        targets.get(t).y = f(targets.get(t).y);
        moved.add(t);
      }
      values = paint(targets, exact);
      res = check(values);
    }
    return { values, rounds, moved, res, failures: failing(res).length + res.slots.filter((s) => !s.ok).length };
  };

  // The user's colour wins over the data series' look. Every plan — the data series in the brand's hue (a grey brand
  // has none to use), then stepped in lightness — is tried first with the colour itself as brand-600, wherever that
  // alone breaks no pair it is part of (a data pair too alike is left to the repair, which moves the other colour);
  // only when no plan passes with it does brand-600 become the brand's hue at the base's brand-600 luminance, plan by
  // plan. The first attempt that passes is the theme; when none does, the one with the fewest failures (reported,
  // never printed).
  const plans = (grey ? [true] : [false, true]).map((stepped) => {
    const planned = plan(stepped);
    const asGiven = check(paint(planned, true)).pairs
      .filter((p) => failed(p) && /--c-(brand-600|series-curr)\b/.test([p.fg, p.bg].flat().join(" ")));
    return { stepped, planned, asGiven };
  });
  const attempts = [];
  let passed = null;
  for (const exact of [true, false]) {
    for (const { stepped, planned, asGiven } of plans) {
      if (passed || (exact && asGiven.length)) continue;
      const attempt = { ...repair(planned, exact), stepped, exact, asGiven };
      attempts.push(attempt);
      if (!attempt.failures) passed = attempt;
    }
  }
  const fewest = (list) => list.reduce((a, x) => (x.failures < a.failures ? x : a));
  const best = passed ?? fewest(attempts), { values, exact } = best;
  // Fell back: the colour breaks none of its own pairs, yet no plan passes with it verbatim.
  const verbatim = attempts.filter((x) => x.exact), fellBack = !exact && verbatim.length > 0;

  // Where each colour went: the report on stderr, and the file's header.
  const v = (t) => resolveToken(new Map([...baseDefaults, ...values]), t);
  const notes = [];
  if (exact) {
    notes.push(`brand-600 ${hex}: your brand colour, verbatim — eyebrows, key numbers, marks and bars${
      keep.brand ? ` (${base}'s own: its brand ramp stays as it is)` : ""}`);
  } else {
    let why, tip = "";
    if (fellBack) {
      // not a matter of lightness, so no other base is suggested: the check the repair could not fix around it
      const left = failureLines(fewest(verbatim).res);
      why = `with it verbatim, repair still left ${left.slice(0, 2).join("; ")}${left.length > 2 ? ` (and ${left.length - 2} more)` : ""}`;
    } else {
      why = `as given it fails ${best.asGiven.slice(0, 3).map((p) => `${p.what} (${p.r.toFixed(2)}:1)`).join(", ")}`;
      // the other base is named only when deriving there keeps the colour verbatim and passes
      const other = base === "classic" ? "midnight" : "classic";
      const there = tips ? derive(brand, { accent, base: other, via }, false) : null;
      if (there?.exact && !there.audit.failures.length) {
        tip = `; it stays exact as the brand on --base ${other}${base === "classic" ? ", or keeps its hue as --accent" : ""}`;
      }
    }
    notes.push(`brand-600 ${v("--c-brand-600")}: your ${hex} in its own hue at ${base}'s brand-600 luminance — ${why}${tip}`);
  }
  notes.push(`the brand ramp and the cover in its hue at ${base}'s lightness steps: brand-900 ${v("--c-brand-900")} (the ` +
    `dark emphasis surface), brand-50 ${v("--c-brand-50")}, cover ${v("--c-cover-from")} → ${v("--c-cover-to")}`);
  const series = `strong ${v("--c-series-strong")}, curr ${v("--c-series-curr")}, fcst ${v("--c-series-fcst")}, prev ${v("--c-series-prev")}`;
  notes.push(!best.stepped ? `data series: ${series} (curr follows brand-600)`
    : `${grey ? `a grey brand (saturation ${b.s.toFixed(2)})` : "the brand's hue alone does not keep the data series apart"}` +
      `: they step in lightness — ${series}`);
  const a500 = v("--c-accent-500"), gap = (h) => `${hueDistance(h, b.h).toFixed(0)}° from the brand`;
  if (accent && keep.accent) notes.push(`accent-500 ${a500}: your accent, ${base}'s own (its accent ramp stays as it is)`);
  else if (accent) {
    let note = `accent-500 ${a500}: your accent ${toHex(accent)} in its own hue at ${base}'s accent luminance`;
    if (anchors.accent.s < CHROMATIC) note += " (grey: a grey second colour belongs in the ink scale — consider no --accent)";
    else if (!grey && hueDistance(anchors.accent.h, b.h) < MAX_HUE_DRIFT) {
      note += ` (only ${gap(anchors.accent.h)}: the two may read as one colour)`;
    }
    notes.push(note);
  } else if (turned) {
    notes.push(`accent-500 ${a500}: ${base}'s accent ${toHex(baseAccent)} is only ${gap(ba.h)}, so it turns to the brand's complement`);
  } else notes.push(`accent-500 ${a500}: ${base}'s own accent${grey ? "" : `, ${gap(ba.h)}`}`);
  if (best.rounds) notes.push(`repaired in ${best.rounds} round${best.rounds > 1 ? "s" : ""}: ${[...best.moved].join(", ")}`);

  const fits = /^ \* Fits: (.*)\.$/m.exec(themeCss)?.[1] ?? `what ${base} fits`;
  const header = [
    `/* deck.css — Derived by theme-check.mjs --derive ${hex}${accent ? ` --accent ${toHex(accent)}` : ""} --base ${base}.`,
    ...commentLines(`${base} in the brand's colours${via ? ` (those of ${via})` : ""}: brand-600 is ${exact ? `${hex}, verbatim`
      : `${v("--c-brand-600")}, the hue of ${hex} at ${base}'s lightness`}; the brand ramp and the cover carry that hue at ${
      base}'s lightness steps; the accent is ${keep.accent ? `${base}'s own ${a500}` : `${a500} and its ramp`}; ` +
      `neutrals, surfaces and shapes are ${base}'s.`),
    ` * Fits: ${fits}, in the brand's colours.`,
    " *",
    ...commentLines("To change a colour, derive again (another --accent, or the other --base) rather than editing " +
      "values; after a hand edit, run theme-check.mjs on the deck. */"),
  ];
  // The base file's own :root block (its group comments, order and alignment) with the derived values in place.
  const body = themeCss.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "").replace(/\/\*[\s\S]*?\*\/|(--[a-z0-9-]+)(\s*:\s*)([^;]+);/gi,
    (m, t, sep) => (t && values.has(t) ? `${t}${sep}${values.get(t)};` : m));
  const css = `${header.join("\n")}\n${body.trimEnd()}\n`;
  return { css, audit: auditTheme(baseText, css), notes, rounds: best.rounds, exact };
}

// ---------------------------------------------------------------------------------------------------------------
// --from-pptx: a template's theme colours. A .pptx is a zip; only the few small XML parts on the way to the slide
// master's theme are read (positioned reads, never the whole file), bounded against hostile files in memory and in
// time: sizes come from the central directory and must match each entry's local header (a data-descriptor entry —
// bit 3 — keeps its sizes only in the directory), each inflate is capped at the declared size and CRC-checked, zip64
// or encrypted entries are refused, a part larger than any real one is refused before it is inflated (relationships
// and presentation.xml 1 MiB, the theme 2 MiB), and every XML scan is linear in the part's length — a tag's scan stops
// at the next '<', a closing tag is found with indexOf, only the relationships taken are resolved — so crafted text
// cannot make a pattern backtrack.
// ---------------------------------------------------------------------------------------------------------------
const ZIP_MAX_ENTRIES = 20000;
const ZIP_MAX_DIRECTORY = 16 * 1024 * 1024; // the central directory itself
const XML_MAX_RELS = 1024 * 1024; // a relationships part or presentation.xml, inflated (real ones: a few KB)
const XML_MAX_THEME = 2 * 1024 * 1024; // a theme, inflated (real ones: tens of KB)
const ZIP_MAX_TOTAL = 8 * 1024 * 1024; // every part read, inflated (a backstop: the reads below stay under it)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (buf) => (buf.reduce((c, byte) => CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

/** A reader of the named parts of an open zip file (fd, size in bytes); throws on anything it refuses. */
function zipParts(fd, size) {
  const at = (pos, len) => {
    const buf = Buffer.alloc(len);
    if (pos < 0 || pos + len > size || fs.readSync(fd, buf, 0, len, pos) !== len) throw new Error("the .pptx is truncated");
    return buf;
  };
  // The end-of-central-directory record: 22 bytes and a comment of up to 64 KiB that end the file — or that a few
  // stray bytes follow (a download or mail tool's trailing newline), which other zip readers accept too. The last
  // record that ends the file exactly wins; else the last one that fits in it. Every check below still applies.
  const tail = at(size - Math.min(size, 22 + 0xffff), Math.min(size, 22 + 0xffff));
  const lastRecord = (fits) => {
    let e = tail.length - 22;
    while (e >= 0 && !(tail.readUInt32LE(e) === 0x06054b50 && fits(e + 22 + tail.readUInt16LE(e + 20)))) e--;
    return e;
  };
  let e = lastRecord((end) => end === tail.length);
  if (e < 0) e = lastRecord((end) => end <= tail.length);
  if (e < 0) {
    throw new Error(lastRecord(() => true) < 0 ? "not a .pptx (no zip directory at its end), or the file is truncated"
      : "not a .pptx (no complete zip directory record near its end)");
  }
  const eocd = size - tail.length + e;
  const [count, cdSize, cdPos] = [tail.readUInt16LE(e + 10), tail.readUInt32LE(e + 12), tail.readUInt32LE(e + 16)];
  const zip64Locator = eocd >= 20 && at(eocd - 20, 4).readUInt32LE(0) === 0x07064b50;
  if (count === 0xffff || cdSize === 0xffffffff || cdPos === 0xffffffff || zip64Locator) throw new Error("zip64 .pptx files are not read");
  if (tail.readUInt16LE(e + 4) !== 0 || tail.readUInt16LE(e + 6) !== 0 || tail.readUInt16LE(e + 8) !== count) {
    throw new Error("split zip archives are not read");
  }
  if (count > ZIP_MAX_ENTRIES || cdSize > ZIP_MAX_DIRECTORY) {
    throw new Error(`the .pptx's zip directory is too large (${count} entries, ${cdSize} bytes)`);
  }
  if (cdPos + cdSize > eocd) throw new Error("the .pptx is truncated (its zip directory is incomplete)");
  const cd = at(cdPos, cdSize), entries = new Map();
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error("the .pptx's zip directory is damaged");
    const nameLen = cd.readUInt16LE(p + 28), next = p + 46 + nameLen + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    if (next > cd.length) throw new Error("the .pptx's zip directory is damaged");
    const entry = { flags: cd.readUInt16LE(p + 8), method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20), usize: cd.readUInt32LE(p + 24), offset: cd.readUInt32LE(p + 42),
      name: cd.subarray(p + 46, p + 46 + nameLen) };
    const key = entry.name.toString("utf8").toLowerCase();
    if (entry.flags & 0x41 || entry.method === 99) throw new Error(`the .pptx is encrypted (${key})`);
    if ([entry.csize, entry.usize, entry.offset].includes(0xffffffff) || cd.readUInt16LE(p + 34) === 0xffff) {
      throw new Error("zip64 .pptx files are not read");
    }
    if (entries.has(key)) throw new Error(`the .pptx names ${key} twice`);
    entries.set(key, entry);
    p = next;
  }
  let total = 0;
  // A part's text (null when the zip has no such entry), refused above max bytes inflated (or without a max at all).
  return (part, max) => {
    const x = entries.get(part.toLowerCase());
    if (!x) return null;
    if (x.method !== 0 && x.method !== 8) throw new Error(`${part}: zip compression method ${x.method} is not read`);
    total += x.usize;
    if (!(x.usize <= max) || total > ZIP_MAX_TOTAL) throw new Error(`${part} is too large to read (${x.usize} bytes)`);
    // The local header must name the same entry with the same method (and, unless its sizes follow the data in a
    // descriptor, the same CRC and sizes), and the data must end before the directory and fit its declared size.
    const local = at(x.offset, 30), nameLen = local.readUInt16LE(26);
    const start = x.offset + 30 + nameLen + local.readUInt16LE(28);
    const sameSizes = local.readUInt32LE(14) === x.crc && local.readUInt32LE(18) === x.csize && local.readUInt32LE(22) === x.usize;
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(8) !== x.method || local.readUInt16LE(6) & 0x41 ||
      !(x.flags & 8 || sameSizes) || !at(x.offset + 30, nameLen).equals(x.name)) {
      throw new Error(`${part}: its zip entry does not match the zip directory`);
    }
    if (start + x.csize > cdPos || (x.method === 0 ? x.csize !== x.usize : x.csize > x.usize + (x.usize >>> 8) + 1024)) {
      throw new Error(`${part}: its zip entry's sizes are impossible`);
    }
    let data = at(start, x.csize);
    if (x.method === 8) {
      try {
        data = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, x.usize) });
      } catch {
        throw new Error(`${part}: its zip entry inflates beyond its declared size, or is damaged`);
      }
    }
    if (data.length !== x.usize || crc32(data) !== x.crc) throw new Error(`${part}: its zip entry fails its size or CRC check`);
    return data.toString("utf8").replace(/^\uFEFF/, "");
  };
}

const xmlText = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[e]);
// A tag's attributes. Every position matches one of the three branches, so a run of name characters that is not an
// attribute is consumed whole (no match restarts inside it) and the scan stays linear.
const xmlAttrs = (s) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')|[\w:.-]+|[^\w:.-]+/g)]
  .filter((m) => m[1] !== undefined).map((m) => [m[1], xmlText(m[2] ?? m[3])]));
/**
 * The relationships of a part ("" = the package itself) whose Type ends in /<type>, in order, as their attributes
 * (Id, Target, …). The caller resolves the one it takes with partName(): resolving each would repeat the source's path.
 */
function relationships(readPart, source, type) {
  const xml = readPart(source.replace(/(^|\/)([^/]*)$/, "$1_rels/$2.rels"), XML_MAX_RELS) ?? "";
  return [...xml.matchAll(/<(?:\w+:)?Relationship\b([^<>]*)>/g)].map((m) => xmlAttrs(m[1]))
    .filter((r) => r.Target && r.TargetMode !== "External" && (r.Type ?? "").endsWith(`/${type}`));
}
/** A relationship's target as a part name: from the package root, or relative to the source part's folder. */
const partName = (source, target) =>
  path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(source), target));
/** The content of the first `name` element (any namespace prefix), or null when it has no closing tag. */
function firstElement(xml, name) {
  const open = new RegExp(`<((?:\\w+:)?)${name}\\b[^<>]*>`).exec(xml);
  if (!open) return null;
  const start = open.index + open[0].length, end = xml.indexOf(`</${open[1]}${name}>`, start);
  return end < 0 ? null : xml.slice(start, end);
}
const SCHEME_SLOTS = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];

/**
 * The colour scheme of a .pptx: the theme of its first slide master, followed through the package relationships
 * (ppt/theme/theme1.xml when they lead nowhere). Returns {part, viaMaster, slots: {dk1 … folHlink: [r, g, b, 1] or
 * null}} — a slot is an a:srgbClr, or an a:sysClr's lastClr (the colour the system slot had when last saved).
 */
export function readPptxTheme(file) {
  const fd = fs.openSync(file, "r");
  try {
    const readPart = zipParts(fd, fs.fstatSync(fd).size);
    const docRel = relationships(readPart, "", "officeDocument")[0];
    const doc = docRel ? partName("", docRel.Target) : "ppt/presentation.xml";
    const masters = relationships(readPart, doc, "slideMaster");
    const firstId = /<(?:\w+:)?sldMasterId\b[^<>]*?\s\w+:id\s*=\s*["']([^"'<>]+)["']/.exec(readPart(doc, XML_MAX_RELS) ?? "")?.[1];
    const master = masters.find((r) => r.Id === firstId) ?? masters[0], masterPart = master && partName(doc, master.Target);
    const themeRel = masterPart && relationships(readPart, masterPart, "theme")[0];
    const viaMaster = themeRel && partName(masterPart, themeRel.Target);
    let part = viaMaster, xml = viaMaster ? readPart(viaMaster, XML_MAX_THEME) : null;
    if (xml === null) xml = readPart((part = "ppt/theme/theme1.xml"), XML_MAX_THEME);
    if (xml === null) throw new Error("the .pptx has no theme (ppt/theme/theme1.xml): is it a PowerPoint file?");
    const scheme = firstElement(xml, "clrScheme");
    if (scheme === null) throw new Error(`${part} has no colour scheme (a:clrScheme)`);
    const slots = {};
    for (const slot of SCHEME_SLOTS) {
      const el = firstElement(scheme, slot) ?? "";
      const hex = /<(?:\w+:)?srgbClr\b[^<>]*?\bval\s*=\s*["']([0-9a-f]{6})["']/i.exec(el)?.[1] ??
        /<(?:\w+:)?sysClr\b[^<>]*?\blastClr\s*=\s*["']([0-9a-f]{6})["']/i.exec(el)?.[1];
      slots[slot] = hex ? parseColour(`#${hex}`) : null;
    }
    return { part, viaMaster: part === viaMaster, slots };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Brand and accent from a template's scheme: accent1 is the brand (a grey accent1 stays a grey brand); accent2 is
 * the accent unless it is grey or within 45° of the brand — then the first of accent3–6 and dk2 that is neither
 * (none: accent null, and the derive's default applies). picks: what was taken or passed over, for the report.
 */
export function pickPptxColours(slots) {
  const brand = slots.accent1;
  if (!brand) throw new Error("the template's theme has no accent1 colour this check reads (srgbClr or sysClr)");
  const b = hueSat(brand), passed = [];
  const brandPick = `brand = accent1 ${toHex(brand)}${b.s < CHROMATIC ? " (grey: a grey brand)" : ""}`;
  for (const slot of ["accent2", "accent3", "accent4", "accent5", "accent6", "dk2"]) {
    const c = slots[slot], hs = c && hueSat(c);
    const why = !c ? "unreadable" : hs.s < CHROMATIC ? "grey"
      : b.s >= CHROMATIC && hueDistance(hs.h, b.h) < MAX_HUE_DRIFT ? `${hueDistance(hs.h, b.h).toFixed(0)}° from the brand` : "";
    if (!why) return { brand, accent: c, picks: [brandPick, `accent = ${slot} ${toHex(c)}${passed.length ? ` (${passed.join("; ")})` : ""}`] };
    passed.push(`${slot}${c ? ` ${toHex(c)}` : ""} is ${why}`);
  }
  return { brand, accent: null, picks: [brandPick, `no accent (${passed.join("; ")}): the base theme's rule decides`] };
}

const USAGE = [
  "usage: node theme-check.mjs <deck folder | theme .css> [--json]",
  "       node theme-check.mjs --derive <brand colour> [--accent <colour>] [--base classic|midnight]",
  "       node theme-check.mjs --from-pptx <template.pptx> [--accent <colour>] [--base classic|midnight]",
].join("\n");

function deriveOptions(argv) {
  const keys = { "--derive": "derive", "--from-pptx": "fromPptx", "--accent": "accent", "--base": "base" };
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^(--[a-z-]+)(?:=(.*))?$/.exec(argv[i]), key = m && keys[m[1]];
    if (!key) throw new Error(`unexpected argument: ${argv[i]}`);
    const value = m[2] ?? (argv[i + 1]?.startsWith("--") ? undefined : argv[++i]);
    if (!value) {
      throw new Error(`${m[1]} needs a value${key === "derive" || key === "accent"
        ? ` — quote a colour written with # (a bare # starts a shell comment): ${m[1]} '#0055AA'` : ""}`);
    }
    if (key in opts) throw new Error(`${m[1]} is given twice`);
    opts[key] = value;
  }
  if (!opts.derive === !opts.fromPptx) throw new Error("give exactly one of --derive <brand colour> or --from-pptx <file.pptx>");
  return { base: "classic", ...opts };
}

function deriveMain(argv) {
  const report = (lines) => process.stderr.write(`${lines.join("\n")}\n`);
  let opts;
  try {
    opts = deriveOptions(argv);
  } catch (e) {
    report([`theme derive: ${e.message}`, USAGE]);
    return 2;
  }
  try {
    let brand = opts.derive === undefined ? null : parseHexArg(opts.derive, "--derive");
    let accent = opts.accent === undefined ? null : parseHexArg(opts.accent, "--accent");
    const lead = [], via = opts.fromPptx ? path.basename(opts.fromPptx).replace(/[\u0000-\u001f\u007f*/\\]/g, "_") : "";
    if (opts.fromPptx) {
      const theme = readPptxTheme(opts.fromPptx), pick = pickPptxColours(theme.slots);
      brand = pick.brand;
      accent ??= pick.accent;
      lead.push(`theme derive: colours of ${via} (${theme.viaMaster ? "its slide master's theme" : "no slide master theme found — read"} ${
        theme.part}): ${pick.picks[0]}, ${opts.accent === undefined ? pick.picks[1] : "accent = your --accent"}`);
    }
    const d = deriveTheme(brand, { accent, base: opts.base, via });
    const { failures, warnings } = d.audit;
    report([
      ...lead,
      `theme derive: ${toHex(brand)} on ${opts.base}`,
      ...d.notes.map((n) => `  ${n}`),
      failures.length
        ? `theme check: the derived theme — ${failures.length} failed after ${d.rounds} repair round${d.rounds === 1 ? "" : "s"}`
        : `theme check: the derived theme — all ${d.audit.checks} checks hold (closest: ${d.audit.worst})`,
      ...failures.map((f) => `  FAIL ${f}`),
      ...warnings.map((w) => `  WARN ${w}`),
      ...(failures.length
        ? ["Next: derive again with another --accent, a darker or lighter brand colour, or the other --base; nothing was written to stdout."]
        : []),
    ]);
    if (failures.length) return 1;
    process.stdout.write(d.css);
    return 0;
  } catch (e) {
    report([`theme derive: ${e.message}`]);
    return 2;
  }
}

function main(argv) {
  if (argv.some((a) => /^--(derive|from-pptx|accent|base)(=|$)/.test(a))) return deriveMain(argv);
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  if (args.length !== 1 || args[0] === "--help") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let file = args[0];
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "deck.css");
    const result = auditTheme(fs.readFileSync(BASE_CSS_PATH, "utf8"), fs.readFileSync(file, "utf8"));
    if (json) process.stdout.write(`${JSON.stringify({ file, ...result })}\n`);
    else {
      const head = result.failures.length
        ? `theme check: ${file} — ${result.failures.length} failed`
        : `theme check: ${file} — all ${result.checks} checks hold (closest: ${result.worst})`;
      process.stdout.write(`${[head, ...result.failures.map((f) => `  FAIL ${f}`), ...result.warnings.map((w) => `  WARN ${w}`)].join("\n")}\n`);
      if (result.failures.length) process.stdout.write("Next: change the named values in the theme file and re-run this check.\n");
    }
    return result.failures.length ? 1 : 0;
  } catch (e) {
    process.stderr.write(`theme check: ${file}: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
