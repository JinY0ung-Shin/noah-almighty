#!/usr/bin/env node
// theme-check.mjs — checks a deck theme (one of the skill's themes/*.css, or a deck's own deck.css) against what the
// kit and the example slides actually draw: the WCAG contrast pairs of reference/AUTHORING.md §9 (text >= 4.5:1,
// marks >= 3:1), the distinctness of the data colours that share a chart, semantic PowerPoint theme slots, and hue
// leftovers (a token still in the colours of the theme it was copied from). Read-only; no dependencies.
//
//   node theme-check.mjs <deck folder | theme .css> [--json]
//
// exit 0: every check holds (warnings possible) · 1: a check failed (each one printed) · 2: usage, an unreadable
// file, or a token that does not resolve to a colour. The skill's tests run the same audit over every shipped theme.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE_CSS_PATH = path.join(HERE, "..", "converter", "theme", "base.css");

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
function hueSat(c) {
  const [r, g, b] = c.slice(0, 3).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s };
}

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

/**
 * The audit of one theme: the base.css defaults overlaid with the theme's own tokens.
 * Returns {failures: string[], warnings: string[], checks: number, worst: string}. Throws when a token does not
 * resolve to a colour this check reads.
 */
export function auditTheme(baseCss, themeCss) {
  const vars = new Map([...cssTokens(baseCss), ...cssTokens(themeCss)]);
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
  const failures = [], warnings = [], ratios = [];
  const name = (x) => (Array.isArray(x) ? x.join(" + ") : x);
  for (const p of PAIRS) {
    const bg = stack(p.bg);
    const r = contrast(over(layer(p.fg), bg), bg);
    ratios.push([r / p.min, `${p.fg} on ${name(p.bg)} ${r.toFixed(2)}:1`]);
    if (r < p.min - 1e-9) failures.push(`${p.what}: ${p.fg} on ${name(p.bg)} = ${r.toFixed(2)}:1 (needs ${p.min}:1)`);
  }
  for (const [a, b] of DISTINCT) {
    const d = deltaE(layer(a), layer(b));
    if (d < MIN_DELTA_E) failures.push(`data colours too alike: ${a} and ${b} (ΔE ${d.toFixed(0)}, needs ${MIN_DELTA_E})`);
  }
  for (const [dark, light] of [["--pptx-dk1", "--pptx-lt1"], ["--pptx-dk2", "--pptx-lt2"]]) {
    if (luminance(layer(dark)) >= luminance(layer(light))) {
      failures.push(`PowerPoint slots must be semantic: ${dark} (the dark text/background colour) is lighter than ${light}`);
    }
  }
  for (const [anchor, members] of Object.entries(HUE_FAMILIES)) {
    const a = hueSat(layer(anchor));
    if (a.s < CHROMATIC) continue;
    for (const t of members) {
      const c = hueSat(layer(t));
      if (c.s < CHROMATIC) continue;
      const drift = Math.min(Math.abs(c.h - a.h), 360 - Math.abs(c.h - a.h));
      if (drift > MAX_HUE_DRIFT) {
        warnings.push(`hue leftover? ${t} ${resolveToken(vars, t)} is ${drift.toFixed(0)}° from ${anchor} ${resolveToken(vars, anchor)}`);
      }
    }
  }
  ratios.sort((x, y) => x[0] - y[0]);
  return { failures, warnings, checks: PAIRS.length + DISTINCT.length + 2, worst: ratios.slice(0, 3).map((x) => x[1]).join(", ") };
}

function main(argv) {
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  if (args.length !== 1 || args[0] === "--help") {
    process.stderr.write("usage: node theme-check.mjs <deck folder | theme .css> [--json]\n");
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
