// Markdown for a LIVE answer: render it as top-level blocks, so a block that can
// no longer change is parsed and sanitized ONCE and its DOM is kept, and only the
// still-open tail is rendered again as text arrives.
//
// The bar is that the blocks, joined, are the SAME html `renderMarkdown` gives
// for the whole text (`tests/client-stream-markdown.test.ts` checks it at every
// prefix). That holds because the split is marked's own: the text is cut only
// where marked's block lexer has already decided — for good — that one top-level
// token ended and the next began, and each token is then rendered by itself,
// which is exactly what marked does with the whole list.
//
// A cut is "for good" when a BLANK LINE precedes it and the first line after it
// is COMPLETE. The block lexer reads line by line, so whatever it concluded
// about the lines before the cut cannot change once that line is whole: a list
// can no longer take it as another item, a paragraph or a setext heading never
// crosses the blank line, an indented code block or a closed fence is over.
//
// What does NOT split (the text is rendered whole instead, as before):
//  - reference-style link definitions (`[id]: url`, footnote-like `[^1]: …`): one
//    of them changes how EARLIER blocks render, so no block is ever final;
//  - raw HTML: sanitizing a block by itself differs from sanitizing the whole
//    document when a tag stays open across blocks (`<details>` … `</details>`, an
//    unclosed `<b>`). Everything from the first block that holds raw HTML to the
//    end is ONE block; the blocks before it are well-formed and stay split.
//
// Display only: nothing here touches the stored text, the copied text or the
// attachment anchors (`bubbleSegments.ts` counts raw text length).

import { marked, type Token, type TokensList } from "marked";
import { renderMarkdown, sanitizeMarkdownHtml } from "./format";
import { healMarkdownTail } from "./streamHeal";

export interface StreamBlock {
  /** Position of the block; a finished block keeps both its key and its html. */
  key: number;
  html: string;
}

export interface StreamMarkdownStats {
  /** Blocks parsed + sanitized so far (a finished block counts once). */
  rendered: number;
  /** Times the text had to be rendered whole (link definitions). */
  whole: number;
}

export interface StreamMarkdown {
  /**
   * The blocks of `text`. The SAME array comes back while nothing changed, and
   * a finished block is the same object every time. `heal` closes the open tail
   * for display (`streamHeal.ts`) — off, the result equals the whole render.
   */
  render(text: string | null | undefined, options?: { heal?: boolean }): StreamBlock[];
  readonly stats: StreamMarkdownStats;
}

function isSpace(token: Token): boolean {
  return token.type === "space";
}

/** Raw HTML anywhere in the token: a block of it, or an inline tag inside text. */
function holdsHtml(token: Token): boolean {
  if (token.type === "html") return true;
  const nested = token as {
    tokens?: Token[];
    items?: Token[];
    header?: { tokens?: Token[] }[];
    rows?: { tokens?: Token[] }[][];
  };
  if (nested.tokens?.some(holdsHtml)) return true;
  if (nested.items?.some(holdsHtml)) return true;
  if (nested.header?.some((cell) => cell.tokens?.some(holdsHtml))) return true;
  if (nested.rows?.some((row) => row.some((cell) => cell.tokens?.some(holdsHtml)))) return true;
  return false;
}

function hasLinkDefinitions(tokens: TokensList): boolean {
  for (const _key in tokens.links) return true;
  return false;
}

/** Does `src` end, at `end`, with a blank line (`…\n` + an empty or whitespace-only line)? */
function blankLineBefore(src: string, end: number): boolean {
  let i = end - 1;
  if (i < 0 || src[i] !== "\n") return false;
  i -= 1;
  while (i >= 0 && (src[i] === " " || src[i] === "\t")) i -= 1;
  return i >= 0 && src[i] === "\n";
}

function renderTokens(tokens: Token[]): string {
  return sanitizeMarkdownHtml(marked.parser(tokens) as string);
}

export function createStreamMarkdown(): StreamMarkdown {
  const stats: StreamMarkdownStats = { rendered: 0, whole: 0 };
  /** Finished blocks, in order — never rendered again. */
  let stable: StreamBlock[] = [];
  /** The source the finished blocks came from (always a prefix of the text). */
  let stablePrefix = "";
  /** Html of the open tail's tokens by their raw text, from the previous call. */
  let tailCache = new Map<string, string>();
  let lastText: string | null = null;
  let lastHeal = false;
  let lastBlocks: StreamBlock[] = [];

  function reset(): void {
    stable = [];
    stablePrefix = "";
    tailCache = new Map();
  }

  function whole(text: string): StreamBlock[] {
    stats.whole += 1;
    stats.rendered += 1;
    const html = renderMarkdown(text);
    return html ? [{ key: 0, html }] : [];
  }

  function render(input: string | null | undefined, options: { heal?: boolean } = {}): StreamBlock[] {
    // marked normalizes line endings itself; doing it here keeps token offsets
    // (sums of `raw`) aligned with the text they are counted in.
    const raw = input || "";
    const text = raw.includes("\r") ? raw.replace(/\r\n?/g, "\n") : raw;
    const heal = options.heal === true;
    if (text === lastText && heal === lastHeal) return lastBlocks;
    lastText = text;
    lastHeal = heal;
    lastBlocks = build(text, heal);
    return lastBlocks;
  }

  function build(text: string, heal: boolean): StreamBlock[] {
    if (!text.startsWith(stablePrefix)) reset();
    const tail = text.slice(stablePrefix.length);
    let tokens = marked.lexer(tail);

    // Offsets come from the tokens' own text; if that ever stops adding up to
    // the source, nothing here can be trusted — render whole.
    const offsets: number[] = [];
    let offset = 0;
    for (const token of tokens) {
      offsets.push(offset);
      offset += token.raw.length;
    }
    if (offset !== tail.length) return whole(text);

    let last = tokens.length - 1;
    while (last >= 0 && isSpace(tokens[last])) last -= 1;

    if (hasLinkDefinitions(tokens)) {
      // A definition reaches every block, the finished ones included.
      if (!heal || last < 0) return whole(text);
      const healed = healMarkdownTail(tokens[last].raw);
      return whole(text.slice(0, stablePrefix.length + offsets[last]) + healed);
    }

    let firstHtml = tokens.length;
    for (let i = 0; i < tokens.length; i += 1) {
      if (holdsHtml(tokens[i])) {
        firstHtml = i;
        break;
      }
    }

    // The last cut that is final (see the header): everything before it is done.
    let cut = 0;
    for (let k = Math.min(firstHtml, last); k > 0; k -= 1) {
      if (isSpace(tokens[k])) continue;
      if (!blankLineBefore(tail, offsets[k])) continue;
      if (tail.indexOf("\n", offsets[k]) === -1) continue;
      cut = k;
      break;
    }

    const nextCache = new Map<string, string>();
    const htmlOf = (token: Token): string => {
      let html = tailCache.get(token.raw);
      if (html === undefined) {
        html = renderTokens([token]);
        stats.rendered += 1;
      }
      nextCache.set(token.raw, html);
      return html;
    };

    if (cut > 0) {
      const next = stable.slice();
      for (let i = 0; i < cut; i += 1) {
        if (isSpace(tokens[i])) continue;
        const html = htmlOf(tokens[i]);
        if (html) next.push({ key: next.length, html });
      }
      stable = next;
      stablePrefix = text.slice(0, stablePrefix.length + offsets[cut]);
    }

    // The open tail. Its last token is the one still being written: for display
    // it is healed and lexed again by itself (never used to decide a cut).
    let open: Token[] = tokens.slice(cut);
    let htmlFrom = firstHtml - cut;
    let healedAway = false;
    if (heal && last >= cut) {
      const lastRaw = tokens[last].raw;
      const healed = healMarkdownTail(lastRaw);
      if (healed !== lastRaw) {
        const replacement: Token[] = healed.trim() ? marked.lexer(healed) : [];
        healedAway = replacement.length === 0;
        open = [...tokens.slice(cut, last), ...replacement];
        const at = open.findIndex(holdsHtml);
        htmlFrom = at === -1 ? open.length : at;
      }
    }
    let lastOpen = open.length - 1;
    while (lastOpen >= 0 && isSpace(open[lastOpen])) lastOpen -= 1;

    const blocks = stable.slice();
    for (let i = 0; i < open.length && i < htmlFrom; i += 1) {
      if (isSpace(open[i])) continue;
      // The token being written changes on every call: caching it only churns.
      const isLast = i === lastOpen;
      let html: string;
      if (isLast) {
        html = renderTokens([open[i]]);
        stats.rendered += 1;
      } else {
        html = htmlOf(open[i]);
      }
      if (html) blocks.push({ key: blocks.length, html });
    }
    if (htmlFrom < open.length) {
      // Raw HTML: one block to the end, sanitized as a unit — and as content
      // that follows the blocks before it, which is what it is in the whole text.
      const follows = blocks.some((block) => block.html !== "");
      if (follows && !blocks.some((block) => block.html.trim())) return whole(text);
      const html = sanitizeMarkdownHtml(marked.parser(open.slice(htmlFrom)) as string, { forceBody: follows });
      stats.rendered += 1;
      if (html) blocks.push({ key: blocks.length, html });
    }
    tailCache = nextCache;

    // `renderMarkdown` shows the source in a <pre> when markdown made nothing
    // of it; the same text must not vanish here.
    // (A tail the healing hid on purpose is not that case.)
    if (!healedAway && text.trim() && !blocks.some((block) => block.html.trim())) return whole(text);
    return blocks;
  }

  return { render, stats };
}

/**
 * One-shot: the blocks of `text` as a fresh renderer sees them. Tests and
 * callers with no incremental state use it; a live bubble keeps a renderer.
 */
export function renderMarkdownBlocks(text: string, options?: { heal?: boolean }): StreamBlock[] {
  return createStreamMarkdown().render(text, options);
}
