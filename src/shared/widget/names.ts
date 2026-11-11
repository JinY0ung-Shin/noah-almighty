/**
 * "Did you mean" for the widget checker: a capped edit distance and the
 * nearest names out of a known list. Shared by the component check
 * (`check.ts`), the enum check (`spec.ts`) and the `<svg>` check (`svg.ts`).
 */

/** Edit distance, capped: enough to suggest a near-miss name. */
export function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Names compared ignoring case, `-` and `_`. A name longer than any real one is not compared at all. */
function fold(name: string): string {
  return name.slice(0, 64).toLowerCase().replace(/[-_]/g, "");
}

/** The closest candidate within two edits (an exact match ignoring case/`-`/`_` wins), or null. */
export function nearest(name: string, candidates: Iterable<string>): string | null {
  const lower = fold(name);
  let best: string | null = null;
  let bestD = 3;
  for (const c of candidates) {
    const cl = fold(c);
    if (cl === lower) return c;
    const d = distance(lower, cl);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Up to `limit` candidates that look like `name`, best first: near misses by
 * edit distance, then names that contain it or are contained in it (`arrow` →
 * `arrow-down`, `chevronright` → `chevron-right`).
 */
export function nearestFew(name: string, candidates: readonly string[], limit = 3): string[] {
  const lower = fold(name);
  if (lower === "") return [];
  const scored: { c: string; d: number }[] = [];
  for (const c of candidates) {
    const cl = fold(c);
    let d = distance(lower, cl);
    if (d > 2 && lower.length >= 3 && (cl.includes(lower) || lower.includes(cl))) d = 2.5;
    if (d < 3) scored.push({ c, d });
  }
  scored.sort((x, y) => x.d - y.d);
  return scored.slice(0, limit).map((s) => s.c);
}
