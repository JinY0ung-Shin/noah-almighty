// Math in rendered Markdown: `$$…$$` / `\[…\]` (display) and `$…$` / `\(…\)`
// (inline), drawn with KaTeX as MathML.
//
// Two halves, so KaTeX is fetched only by an answer that HAS math:
// - `mathExtension` (here, in the main chunk) teaches marked the delimiters. A
//   formula becomes a placeholder element that shows its own SOURCE (delimiters
//   and all) and carries the TeX in `data-tex`; the html stays pure in the text,
//   so the stream renderer's "same html as a whole render" bar is untouched, and
//   a surface that never draws math (a team-brain note) reads as before.
// - `syncMath` (run by lib/dom.ts wherever rendered Markdown is mounted) finds
//   those placeholders and, the first time there is one, loads `./mathRender`
//   (KaTeX's own chunk). Until it arrives the source is shown; then every
//   placeholder still waiting is drawn in place.
//
// Currency is not math: `$5 and $10` stays text (no space right after an opening
// `$` or right before a closing one, and a closing `$` is never followed by a
// digit). Code spans and fences are marked's own tokens and are never looked
// into, and a formula never contains a backtick or a blank line. An unclosed
// `$$` (an answer still streaming) matches nothing and stays text.
import type { TokenizerAndRendererExtension, Tokens } from "marked";

/** The marker class of a formula placeholder (sanitized html keeps class and data-* attributes). */
export const MATH_CLASS = "md-math";

interface MathToken extends Tokens.Generic {
  type: "math" | "mathBlock";
  raw: string;
  tex: string;
  display: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** A formula must say something, and never runs over a blank line or a code span. */
function usable(tex: string): boolean {
  return tex.trim() !== "" && !tex.includes("`") && !/\n[ \t]*\n/.test(tex);
}

// Display math on lines of its own: `$$` … `$$` or `\[` … `\]`, the closing
// delimiter ending its line.
const BLOCK_DOLLAR = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;
const BLOCK_BRACKET = /^ {0,3}\\\[([\s\S]+?)\\\][ \t]*(?:\n|$)/;
// Inside running text.
const INLINE_DISPLAY_DOLLAR = /^\$\$(?!\$)([\s\S]+?)\$\$/;
const INLINE_DISPLAY_BRACKET = /^\\\[([\s\S]+?)\\\]/;
const INLINE_PAREN = /^\\\(([\s\S]+?)\\\)/;
// `$x$`: not `$ x$`, not `$x $`, not `$5 and $10`; `\$` inside is a literal dollar.
const INLINE_DOLLAR = /^\$(?![\s$])((?:\\[\s\S]|[^\\$\n])+?)\$(?!\d)/;

/** The display-math block at the start of `src`, if it is one. */
function blockMath(src: string): MathToken | undefined {
  const match = BLOCK_DOLLAR.exec(src) ?? BLOCK_BRACKET.exec(src);
  if (!match || !usable(match[1])) return undefined;
  return { type: "mathBlock", raw: match[0], tex: match[1].trim(), display: true };
}

/** The formula at the start of `src` (inside a paragraph, a list item, a cell…), if it is one. */
export function inlineMath(src: string): MathToken | undefined {
  for (const [pattern, display] of [
    [INLINE_DISPLAY_DOLLAR, true],
    [INLINE_DISPLAY_BRACKET, true],
    [INLINE_PAREN, false],
  ] as const) {
    const match = pattern.exec(src);
    if (match && usable(match[1])) return { type: "math", raw: match[0], tex: match[1].trim(), display };
  }
  if (src.startsWith("$$")) return undefined;
  const match = INLINE_DOLLAR.exec(src);
  // The closing `$` may not follow a space (`$5 and $10`).
  if (!match || /\s$/.test(match[1]) || !usable(match[1])) return undefined;
  return { type: "math", raw: match[0], tex: match[1], display: false };
}

function placeholder(token: MathToken): string {
  return `<span class="${MATH_CLASS}" data-tex="${escapeHtml(token.tex)}"${token.display ? ' data-display=""' : ""}>${escapeHtml(token.raw.trim())}</span>`;
}

export const mathExtension: { extensions: TokenizerAndRendererExtension[] } = {
  extensions: [
    {
      name: "mathBlock",
      level: "block",
      // No `start`: display math never interrupts a paragraph (it would cut a code
      // span that runs over lines). Inside one, the inline rule draws it.
      tokenizer(src: string) {
        return blockMath(src);
      },
      renderer(token) {
        return `<div class="md-math-block">${placeholder(token as MathToken)}</div>\n`;
      },
    },
    {
      name: "math",
      level: "inline",
      start(src: string) {
        const at = src.search(/\$|\\[([]/);
        return at < 0 ? undefined : at;
      },
      tokenizer(src: string) {
        return inlineMath(src);
      },
      renderer(token) {
        return placeholder(token as MathToken);
      },
    },
  ],
};

type MathRenderModule = typeof import("./mathRender");

let loaded: MathRenderModule | null = null;
let loading: Promise<MathRenderModule | null> | null = null;
/** Placeholders seen before KaTeX arrived: drawn once it has. */
const waiting = new Set<HTMLElement>();

function draw(module: MathRenderModule, el: HTMLElement): void {
  if (el.dataset.mathDrawn !== undefined) return;
  const tex = el.dataset.tex ?? "";
  const html = module.renderMathHtml(tex, el.dataset.display !== undefined);
  if (!html) return;
  el.dataset.mathDrawn = "";
  // The source stays readable for a screen reader through KaTeX's own annotation; the
  // title shows it on hover.
  el.title = tex;
  el.innerHTML = html;
}

/**
 * Draw every formula placeholder under `root` (an element, a fragment, or a
 * block's own nodes). Loads KaTeX the first time one is seen; idempotent.
 */
export function syncMath(root: ParentNode | readonly Node[]): void {
  const found: HTMLElement[] = [];
  const scan = (node: ParentNode): void => {
    if (node instanceof Element && node.classList.contains(MATH_CLASS)) found.push(node as HTMLElement);
    node.querySelectorAll<HTMLElement>(`.${MATH_CLASS}`).forEach((el) => found.push(el));
  };
  if (Array.isArray(root)) {
    for (const node of root as readonly Node[]) if (node.nodeType === 1) scan(node as Element);
  } else scan(root as ParentNode);
  const pending = found.filter((el) => el.dataset.mathDrawn === undefined);
  if (pending.length === 0) return;
  if (loaded) {
    for (const el of pending) draw(loaded, el);
    return;
  }
  for (const el of pending) waiting.add(el);
  loading ??= import("./mathRender").then(
    (module) => {
      loaded = module;
      for (const el of waiting) draw(module, el);
      waiting.clear();
      return module;
    },
    () => {
      // The chunk did not load (offline, a deploy in between): the source stays, and the next sighting tries again.
      loading = null;
      waiting.clear();
      return null;
    },
  );
}
