// Label measuring without a renderer. There is no browser in this tool, so the
// room a label needs is ESTIMATED from its characters: good enough to size a
// box before a layout and to warn about a label that clearly does not fit,
// never exact. Hangul, kana, CJK ideographs and full-width forms are a full em
// wide — draw.io's own headless estimate counts every character as 0.6 em,
// which is why Korean labels overflow the boxes it reserves.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] !== "#") return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The lines of a label as the viewer shows them. With `html` the value is
 * markup: block ends and <br> break the line and the tags go. Without it the
 * value is plain text and only a real line break counts.
 */
export function labelLines(label, html) {
  // A label is a few words; the cap keeps a pathological value from costing seconds.
  let text = String(label ?? "").slice(0, 4000);
  if (html) {
    text = text
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<hr\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "");
    text = decodeEntities(text);
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, all) => line !== "" || (index > 0 && index < all.length - 1));
}

function isWide(code) {
  return (
    (code >= 0x1100 && code <= 0x11ff) || // Hangul jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals … Yi (kana, ideographs, compat jamo)
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // full-width forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f000 // emoji and the supplementary ideographs
  );
}

/** Advance of one character, in em. */
function advance(ch) {
  const code = ch.codePointAt(0);
  if (isWide(code)) return 1;
  if (ch === " ") return 0.3;
  if ("ilI.,:;'|!()[]{}`\"-/\\tfjr".includes(ch)) return 0.34;
  if ("mwMW@%".includes(ch)) return 0.88;
  if ((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")) return 0.66;
  return 0.56;
}

export function textWidth(text, fontSize, bold) {
  let em = 0;
  for (const ch of text) em += advance(ch);
  return em * fontSize * (bold ? 1.06 : 1);
}

/**
 * Break one line into the pieces a browser may wrap at: a run of non-wide
 * characters stays together (a word), every wide character stands alone
 * (Hangul and CJK wrap between any two characters).
 */
function pieces(line) {
  const out = [];
  let word = "";
  const flush = () => {
    if (word) out.push(word);
    word = "";
  };
  for (const ch of line) {
    if (ch === " ") {
      flush();
      out.push(" ");
    } else if (isWide(ch.codePointAt(0))) {
      flush();
      out.push(ch);
    } else {
      word += ch;
    }
  }
  flush();
  return out;
}

/** Width of the widest piece that cannot be broken: the least width a wrapped label needs. */
export function widestPiece(lines, fontSize, bold) {
  let widest = 0;
  for (const line of lines) for (const piece of pieces(line)) widest = Math.max(widest, textWidth(piece, fontSize, bold));
  return widest;
}

/** How many lines the label takes when wrapped at `maxWidth`. */
export function wrappedLineCount(lines, fontSize, bold, maxWidth) {
  let count = 0;
  for (const line of lines) {
    let width = 0;
    let rows = 1;
    for (const piece of pieces(line)) {
      const w = textWidth(piece, fontSize, bold);
      if (piece === " " && width === 0) continue;
      if (width + w > maxWidth && width > 0) {
        rows += 1;
        width = piece === " " ? 0 : w;
      } else {
        width += w;
      }
    }
    count += rows;
  }
  return Math.max(count, 1);
}

export const LINE_HEIGHT = 1.25;
