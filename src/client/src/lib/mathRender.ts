// KaTeX, in its own chunk: loaded by lib/mathMarkdown.ts only once an answer
// holds a formula.
//
// Output is MathML only (`output: "mathml"`), which Chrome and Edge draw natively
// (MathML Core): no KaTeX stylesheet, no KaTeX fonts, no inline `style`
// attributes — nothing for the CSP or the app's CSS to accommodate. KaTeX's
// output then goes through its OWN allowlist (the MathML elements and
// attributes KaTeX emits, nothing else): the TeX is model-written text.
import DOMPurify from "dompurify";
import katex from "katex";

/** Every element KaTeX's MathML output uses (plus the error span). */
const MATH_TAGS = [
  "span",
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "mfrac",
  "msqrt",
  "mroot",
  "msub",
  "msup",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "none",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mstyle",
  "menclose",
  "mpadded",
  "mphantom",
  "merror",
];

/** Presentation attributes only: no `style`, no `href`, no event handler, nothing that loads. */
const MATH_ATTRS = [
  "class",
  "title",
  "xmlns",
  "display",
  "encoding",
  "mathvariant",
  "mathcolor",
  "mathbackground",
  "stretchy",
  "fence",
  "separator",
  "form",
  "largeop",
  "movablelimits",
  "symmetric",
  "lspace",
  "rspace",
  "minsize",
  "maxsize",
  "accent",
  "accentunder",
  "linethickness",
  "scriptlevel",
  "displaystyle",
  "notation",
  "width",
  "height",
  "depth",
  "voffset",
  "rowspacing",
  "rowalign",
  "rowlines",
  "columnspacing",
  "columnalign",
  "columnlines",
  "frame",
];

/** KaTeX's own bounds on what one formula may cost. */
const KATEX_OPTIONS = {
  output: "mathml",
  throwOnError: false,
  trust: false,
  strict: "ignore",
  maxSize: 50,
  maxExpand: 500,
} as const;

const MAX_TEX_CHARS = 4000;
const CACHE_LIMIT = 300;
const cache = new Map<string, string>();

/** KaTeX's MathML output, cleaned to the MathML allowlist. */
export function sanitizeMathHtml(html: string): string {
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: MATH_TAGS, ALLOWED_ATTR: MATH_ATTRS, ALLOW_DATA_ATTR: false });
}

/**
 * `tex` as sanitized MathML html (`<span class="katex"><math …>`), or "" when
 * there is nothing to draw (too long, or empty after cleaning). A TeX error is
 * drawn by KaTeX as its source in the error colour, never thrown.
 */
export function renderMathHtml(tex: string, display: boolean): string {
  if (!tex || tex.length > MAX_TEX_CHARS) return "";
  const key = `${display ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let html = "";
  try {
    html = sanitizeMathHtml(katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display }));
  } catch {
    html = "";
  }
  cache.set(key, html);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return html;
}
