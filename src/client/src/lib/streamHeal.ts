// Heal the OPEN tail of a streaming answer, for display only.
//
// While a block is still being written its syntax is half there: an opened `**`
// with no closer yet, a `[text](ur` whose address is still arriving, a table
// header with no delimiter row, a `-` that may become a bullet, a rule or a
// setext underline. Rendered as they stand, those show as raw markers for a few
// frames and then snap into shape. `healMarkdownTail` returns the text as it
// will most likely read once complete — closers added, a marker that means
// nothing yet held back — so the block is drawn in its final shape from the
// first character.
//
// It only ever sees the raw text of the LAST top-level block
// (`streamMarkdown.ts`), and its output is used for that one render: the stored
// message, the copied text and the attachment anchors never see it, and a block
// that is finished is rendered from its real text. So a wrong guess here costs
// one redraw when the block completes — never content.

const FENCE_LINE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const TABLE_LINE = /^ {0,3}\|/;
const HEADING_START = /^ {0,3}#{1,6}[ \t]+/;
const BULLET_START = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const QUOTE_START = /^[ \t]*>[ \t>]*/;
/** A last line that is only a marker so far: a bullet, a rule, a heading, an emphasis or fence opener. */
const BARE_MARKER = /^[ \t>]*(?:[-*+_]{1,2}|#{1,6}|\d{1,9}[.)]|`{1,2}|~{1,2})$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)$/;
const BARE_NUMBER = /^[ \t]*\d{1,9}$/;
const DELIMITER_SO_FAR = /^ {0,3}\|?[ \t:|-]*$/;
const PUNCTUATION = /[!-/:-@[-`{-~、-〃〈-】‘-‟！-／]/;

function isSpaceChar(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}

function trailingSpaceStart(text: string): number {
  let end = text.length;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  return end;
}

/** Index of the last `|` in `line` that is not escaped, or -1. */
function lastPipe(line: string): number {
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (line[i] !== "|") continue;
    let slashes = 0;
    for (let k = i - 1; k >= 0 && line[k] === "\\"; k -= 1) slashes += 1;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}

/** Cells of a table row as written so far (0 for a bare `|`). */
function tableCells(line: string): number {
  let row = line.replace(/^ {0,3}\|/, "");
  const end = lastPipe(row);
  if (end !== -1 && !row.slice(end + 1).trim()) row = row.slice(0, end);
  if (!row.trim()) return 0;
  let cells = 1;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\") i += 1;
    else if (row[i] === "|") cells += 1;
  }
  return cells;
}

/**
 * Close what one run of inline text left open. `text` is a paragraph, a list
 * item, a heading or a table cell as written so far, without the block marker.
 */
function healInline(text: string): string {
  const n = text.length;
  /** Emphasis / strikethrough runs opened and not closed yet, innermost last. */
  const open: { ch: string; len: number }[] = [];
  const brackets: { at: number; image: boolean }[] = [];
  const closers = (): string => {
    let out = "";
    for (let k = open.length - 1; k >= 0; k -= 1) out += open[k].ch.repeat(open[k].len);
    return out;
  };
  // Closers sit BEFORE trailing whitespace: `**bold **` does not close.
  const finish = (visible: string): string => {
    const end = trailingSpaceStart(visible);
    return visible.slice(0, end) + closers() + visible.slice(end);
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (j < n && text[j] === "`") j += 1;
      const run = j - i;
      let close = -1;
      let k = j;
      while (k < n) {
        if (text[k] !== "`") {
          k += 1;
          continue;
        }
        let e = k;
        while (e < n && text[e] === "`") e += 1;
        if (e - k === run) {
          close = e;
          break;
        }
        k = e;
      }
      if (close !== -1) {
        i = close;
        continue;
      }
      // An open code span: everything after it is code. A closing run that is
      // still being typed is not part of it; an opener with nothing after it
      // waits for its first character.
      const code = text.slice(j).replace(/`+$/, "");
      if (!code.trim()) return finish(text.slice(0, i));
      return text.slice(0, i) + "`".repeat(run) + code + "`".repeat(run) + closers();
    }
    if (ch === "[") {
      brackets.push({ at: i, image: i > 0 && text[i - 1] === "!" });
      i += 1;
      continue;
    }
    if (ch === "]") {
      const from = brackets.pop();
      if (from && text[i + 1] === "(") {
        let depth = 1;
        let k = i + 2;
        while (k < n && depth > 0 && text[k] !== "\n") {
          if (text[k] === "\\") k += 1;
          else if (text[k] === "(") depth += 1;
          else if (text[k] === ")") depth -= 1;
          k += 1;
        }
        if (depth === 0) {
          i = k; // a whole link: its address is not inline text
          continue;
        }
        if (k >= n) {
          // The address is still arriving: show the label as the link it will
          // be (an <a> with no href yet), an image not at all.
          if (from.image) return finish(text.slice(0, from.at - 1));
          const label = text.slice(from.at + 1, i);
          return finish(text.slice(0, from.at) + (label.trim() ? `<a>${label}</a>` : ""));
        }
      }
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      let j = i;
      while (j < n && text[j] === ch) j += 1;
      const len = j - i;
      const prev = i > 0 ? text[i - 1] : "";
      const next = j < n ? text[j] : "";
      const left = !isSpaceChar(next);
      const right = !isSpaceChar(prev);
      let canOpen: boolean;
      let canClose: boolean;
      if (ch === "~") {
        // Only `~~` is strikethrough here: a single `~` is a range (3~5개).
        canOpen = left && len === 2;
        canClose = right && (len === 2 || (len === 1 && next === ""));
      } else if (ch === "_") {
        canOpen = left && (!right || PUNCTUATION.test(prev));
        canClose = right && (!left || PUNCTUATION.test(next));
      } else {
        // A lone `*` inside a word is a product or a glob far more often than
        // emphasis; `**` opens anywhere (값은**42**입니다).
        canOpen = left && (len >= 2 || !right || PUNCTUATION.test(prev));
        canClose = right;
      }
      let rest = len;
      if (canClose) {
        for (let k = open.length - 1; k >= 0 && rest > 0; k -= 1) {
          if (open[k].ch !== ch) continue;
          const used = Math.min(rest, open[k].len);
          open[k].len -= used;
          rest -= used;
          // Whatever was opened inside it and never closed is plain text.
          open.length = open[k].len === 0 ? k : k + 1;
        }
      }
      if (rest > 0) {
        if (canOpen) {
          open.push({ ch, len: rest });
        } else if (next === "") {
          // A run at the very end that closes nothing: most likely an opener
          // whose text has not arrived. Hold it back.
          const mayOpen = ch === "*" || (ch === "~" ? rest === 2 : !right || PUNCTUATION.test(prev));
          if (mayOpen) return finish(text.slice(0, i) + ch.repeat(len - rest));
        }
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return finish(text);
}

/** Where the last run of inline text starts in `body` (after its block marker). */
function inlineScopeStart(body: string): number {
  const lines = body.split("\n");
  let pos = body.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    pos -= line.length;
    const isLast = i === lines.length - 1;
    const nextLine = pos + line.length + 1;
    if (!line.trim()) return Math.min(nextLine, body.length);
    if (TABLE_LINE.test(line)) return isLast ? pos + lastPipe(line) + 1 : nextLine;
    const heading = HEADING_START.exec(line);
    if (heading) return isLast ? pos + heading[0].length : nextLine;
    const bullet = BULLET_START.exec(line);
    if (bullet) return pos + bullet[0].length;
    const quote = QUOTE_START.exec(line);
    if (quote) return pos + quote[0].length;
    pos -= 1; // the newline before this line
  }
  return 0;
}

export function healMarkdownTail(raw: string): string {
  if (!raw) return raw;
  const lines = raw.split("\n");

  // An open code fence shows as code to the end by itself — nothing in it is
  // markdown. Only a closing fence still being typed is held back.
  let fence: { ch: string; len: number } | null = null;
  for (const line of lines) {
    const match = FENCE_LINE.exec(line);
    if (!match) continue;
    const run = match[1];
    if (!fence) {
      if (run[0] === "`" && match[2].includes("`")) continue;
      fence = { ch: run[0], len: run.length };
    } else if (run[0] === fence.ch && run.length >= fence.len && !match[2].trim()) {
      fence = null;
    }
  }
  if (fence) {
    const lastLine = lines[lines.length - 1];
    const partial = /^[ \t>]*([`~]+)[ \t]*$/.exec(lastLine);
    if (lines.length > 1 && partial && partial[1].length < fence.len && partial[1] === fence.ch.repeat(partial[1].length)) {
      return raw.slice(0, raw.length - lastLine.length);
    }
    return raw;
  }

  const bodyEnd = trailingSpaceStart(raw);
  let body = raw.slice(0, bodyEnd);
  let trailing = raw.slice(bodyEnd);
  if (!body) return raw;

  // The line being written, when it is only a marker so far.
  if (!trailing.includes("\n")) {
    const start = body.lastIndexOf("\n") + 1;
    const lastLine = body.slice(start);
    const prevLine = start > 0 ? body.slice(body.lastIndexOf("\n", start - 2) + 1, start - 1) : null;
    const hide =
      BARE_MARKER.test(lastLine) ||
      // `Para\n-` is a setext HEADING until the next character arrives.
      (SETEXT_UNDERLINE.test(lastLine) && prevLine !== null && prevLine.trim() !== "") ||
      // The next item's number, before its dot.
      (BARE_NUMBER.test(lastLine) && BULLET_START.test(lines[0]));
    if (hide) {
      body = body.slice(0, trailingSpaceStart(body.slice(0, start)));
      trailing = body ? "\n" : "";
      if (!body) return "";
    }
  }

  // A table shows from its header row on: the delimiter row is supplied until
  // the real one is complete.
  const rows = body.split("\n");
  let tableStart = rows.length;
  while (tableStart > 0 && TABLE_LINE.test(rows[tableStart - 1])) tableStart -= 1;
  const run = rows.length - tableStart;
  if (run === 1 || (run === 2 && !trailing.includes("\n") && DELIMITER_SO_FAR.test(rows[tableStart + 1]))) {
    const header = rows[tableStart];
    const cells = tableCells(header);
    const before = rows.slice(0, tableStart);
    if (cells === 0) {
      const kept = before.join("\n");
      return kept.trim() ? kept + "\n" : "";
    }
    const pipe = lastPipe(header);
    const closed = pipe > 0 && !header.slice(pipe + 1).trim();
    const headerRow = closed ? header : header.slice(0, pipe + 1) + healInline(header.slice(pipe + 1)) + " |";
    return [...before, headerRow, `|${" --- |".repeat(cells)}`].join("\n") + "\n";
  }

  const scope = inlineScopeStart(body);
  return body.slice(0, scope) + healInline(body.slice(scope)) + trailing;
}
