/**
 * Text-run helpers for widget children: indentation, JSX-style whitespace,
 * backslash escapes, and the display form of an interpolated value.
 *
 * `dedent` and `jsxWhitespace` are ported from mireiffe/mirineereum
 * (src/lib/genui/text.ts @ 0e469c4) with the owner's permission.
 */
import { toStr } from "./interp.js";

/** Remove the common leading indentation (a first line that continues after a tag is ignored). */
export function dedent(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let min = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (i === 0 && !/^[ \t]/.test(l)) continue;
    const m = /^[ \t]*/.exec(l)![0];
    const w = m.replace(/\t/g, "    ").length;
    if (w < min) min = w;
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n");
  return lines
    .map((l, i) => {
      if (i === 0 && !/^[ \t]/.test(l)) return l;
      let w = 0;
      let k = 0;
      while (k < l.length && w < min && (l[k] === " " || l[k] === "\t")) {
        w += l[k] === "\t" ? 4 : 1;
        k++;
      }
      return l.slice(k);
    })
    .join("\n");
}

/**
 * JSX whitespace for an inline text run: whitespace that contains a line break
 * collapses (dropped at the run's edges, one space inside); same-line spaces
 * are kept. `first`/`last` say whether the run is the first/last child.
 */
export function jsxWhitespace(text: string, first: boolean, last: boolean): string {
  const lines = text.split(/\r?\n/);
  const parts = lines.map((l, i) => {
    let s = l;
    if (i > 0 || first) s = s.replace(/^[ \t]+/, "");
    if (i < lines.length - 1 || last) s = s.replace(/[ \t]+$/, "");
    return s;
  });
  return parts.filter((p) => p.length > 0).join(" ");
}

/** Drop the backslash of an escaped template character (`\{` → `{`, `\<` → `<`). */
export function unescapeText(text: string): string {
  return text.replace(/\\([\\{}<>`*_~])/g, "$1");
}

/**
 * What an interpolated `{value}` shows: strings and numbers as text; null,
 * undefined and booleans as nothing (so `{cond && "x"}` works); an array as its
 * comma-joined (bounded) string form; anything else as nothing.
 */
export function displayText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return toStr(v);
  return "";
}
