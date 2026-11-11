/**
 * Does an answer hold inline UI? A cheap line scan that runs on every answer
 * (and on every token of a streaming one), so the parser, the interpreter and
 * the components are loaded only for an answer that needs them.
 *
 * Ported from mireiffe/mirineereum (src/lib/genui/detect.ts @ 0e469c4) with the
 * owner's permission. It answers "maybe": a line outside fenced code that
 * starts (indent ≤ 3) with a component tag or with a `{@state|@const|#each|#if`
 * directive. `parseAnswer` decides what is really there — an answer this says
 * yes to and that turns out to hold none is drawn as the Markdown it is.
 *
 * This file imports NOTHING, on purpose: the names below repeat the tags of the
 * spec table (`spec.ts`), and `tests/widget-detect.test.ts` fails when they drift.
 */
export const INLINE_UI_TAG_NAMES: readonly string[] = [
  "box",
  "row",
  "col",
  "grid",
  "grid-item",
  "divider",
  "spacer",
  "title",
  "text",
  "badge",
  "link",
  "callout",
  "button",
  "segmented-control",
  "checkbox",
  "switch",
  "slider",
  "select",
  "input",
  "tabs",
  "stat",
  "progress",
  "table",
  "chart",
  "details",
  "image",
  "icon",
  "svg",
  "submit",
];

const TAGS = new Set(INLINE_UI_TAG_NAMES);
const TAG_LINE = /^ {0,3}<([A-Za-z][\w-]*)(?=[\s/>]|$)/;
const DIRECTIVE_LINE = /^ {0,3}\{\s*(?:@state|@const|#each|#if)(?![\w$])/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function containsInlineUi(source: string | null | undefined): boolean {
  if (!source || (source.indexOf("<") < 0 && source.indexOf("{") < 0)) return false;
  let fence: { ch: string; len: number } | null = null;
  let start = 0;
  const n = source.length;
  while (start <= n) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = n;
    const line = source.slice(start, end);
    start = end + 1;

    const fm = FENCE.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && line.slice(fm[0].length).trim() === "") fence = null;
      continue;
    }
    if (fm) {
      // A backtick in the info string means it is inline code, not a fence.
      if (!(fm[1][0] === "`" && line.slice(fm[0].length).includes("`"))) {
        fence = { ch: fm[1][0], len: fm[1].length };
        continue;
      }
    }
    const tm = TAG_LINE.exec(line);
    if (tm && TAGS.has(tm[1])) return true;
    if (DIRECTIVE_LINE.test(line)) return true;
    if (end >= n) break;
  }
  return false;
}

const UI_LINE = /^\s*(?:<\/?([A-Za-z][\w-]*)(?=[\s/>]|$)|\{\s*(?:@state|@const|#each|#if|:else|\/each|\/if)(?![\w$]))/;

/**
 * An answer as plain reading text, for places that show a SNIPPET of it and
 * cannot draw UI (a notification body): the lines that are UI source — a
 * component tag, its closing tag, a directive — are left out, outside fenced
 * code. What remains is the answer's own prose.
 */
export function inlineUiPlainText(source: string | null | undefined): string {
  if (!source) return "";
  if (!containsInlineUi(source)) return source;
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of source.split("\n")) {
    const fm = FENCE.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && line.slice(fm[0].length).trim() === "") fence = null;
      out.push(line);
      continue;
    }
    if (fm && !(fm[1][0] === "`" && line.slice(fm[0].length).includes("`"))) {
      fence = { ch: fm[1][0], len: fm[1].length };
      out.push(line);
      continue;
    }
    const m = UI_LINE.exec(line);
    if (m && (m[1] === undefined || TAGS.has(m[1]))) continue;
    out.push(line);
  }
  return out.join("\n");
}
