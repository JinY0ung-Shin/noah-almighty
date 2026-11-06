// A small, pure, BOUNDED line diff (LCS) — the team-brain review card renders a
// page's before → after with it, so an admin sees exactly which lines a
// changeset removes. No dependencies, no DOM; shared so a test can pin it.
//
// Cost guard: the common prefix/suffix is trimmed first, then the LCS table
// covers only the changed middle. Beyond `maxLines` lines on either side (or a
// table above `maxCells`) it falls back to "whole before deleted / whole after
// added" and says so (`fallback: true`) instead of burning the main thread.

export type DiffLineKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in `before` (same / del). */
  oldNo: number | null;
  /** 1-based line number in `after` (same / add). */
  newNo: number | null;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The middle was too large to diff line by line. */
  fallback: boolean;
}

export interface LineDiffOptions {
  /** Max lines of the changed middle on either side (default 2000). */
  maxLines?: number;
  /** Max LCS table cells (default 4,000,000). */
  maxCells?: number;
}

export const LINE_DIFF_MAX_LINES = 2000;
export const LINE_DIFF_MAX_CELLS = 4_000_000;

/** Split into lines; CRLF/CR normalized; a single trailing newline does not add an empty last line. */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(before: string, after: string, options: LineDiffOptions = {}): LineDiff {
  const maxLines = options.maxLines ?? LINE_DIFF_MAX_LINES;
  const maxCells = options.maxCells ?? LINE_DIFF_MAX_CELLS;
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const lines: DiffLine[] = [];
  const same = (i: number, j: number) => lines.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: j + 1 });
  const del = (i: number) => lines.push({ kind: "del", text: a[i], oldNo: i + 1, newNo: null });
  const add = (j: number) => lines.push({ kind: "add", text: b[j], oldNo: null, newNo: j + 1 });

  for (let k = 0; k < start; k++) same(k, k);

  const n = endA - start;
  const m = endB - start;
  let fallback = false;
  if (n === 0) {
    for (let j = start; j < endB; j++) add(j);
  } else if (m === 0) {
    for (let i = start; i < endA; i++) del(i);
  } else if (n > maxLines || m > maxLines || (n + 1) * (m + 1) > maxCells) {
    fallback = true;
    for (let i = start; i < endA; i++) del(i);
    for (let j = start; j < endB; j++) add(j);
  } else {
    // lcs[i][j] = LCS length of a[start+i..endA) and b[start+j..endB), row-major.
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        same(start + i, start + j);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        // Deletions first within a change block (the reviewer reads what goes, then what comes).
        del(start + i);
        i++;
      } else {
        add(start + j);
        j++;
      }
    }
    for (; i < n; i++) del(start + i);
    for (; j < m; j++) add(start + j);
  }

  for (let k = 0; k < a.length - endA; k++) same(endA + k, endB + k);

  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { lines, added, removed, fallback };
}

export type DiffHunkItem = DiffLine | { kind: "skip"; count: number };

/**
 * Collapse unchanged runs to `context` lines around each change; a run of
 * unchanged lines farther away becomes one `{ kind: "skip", count }`. A diff
 * with no change collapses to a single skip.
 */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffHunkItem[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].kind === "same") continue;
    for (let d = Math.max(0, k - context); d <= Math.min(lines.length - 1, k + context); d++) keep[d] = true;
  }
  // A lone hidden line costs as much as its "skipped" marker — show it instead.
  for (let k = 0; k < lines.length; k++) {
    if (!keep[k] && (k === 0 || keep[k - 1]) && (k === lines.length - 1 || keep[k + 1]) && lines.length > 1) keep[k] = true;
  }
  const out: DiffHunkItem[] = [];
  let skipped = 0;
  for (let k = 0; k < lines.length; k++) {
    if (keep[k]) {
      if (skipped) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(lines[k]);
    } else {
      skipped++;
    }
  }
  if (skipped) out.push({ kind: "skip", count: skipped });
  return out;
}
