// Matching a LEARNED skill copy to the share it came from (#skill-share).
// Shared client↔server on purpose: the learn authorization (skillTransfer.ts),
// the agent's update resolution (agent/skillExchangeTools.ts) and the 스킬 배우기
// update badge (SkillsView.tsx) all join copies to shares, and three
// hand-written versions of this rule drifted apart once already.

/** One resolution: the single copy, several equally plausible ones, or none. */
export type ShareCopyMatch<T> = { match: T } | { ambiguous: T[] } | null;

/**
 * Pick the copy a share applies to. `markerNameOf` reads a copy's provenance
 * marker `skillName` — the share's name AT LEARN TIME — and `share` carries its
 * current name plus its rename trail, so a copy learned before the share
 * followed a rename still resolves.
 *
 * Exact matches WIN OUTRIGHT: the trail is consulted only when NO copy names
 * the share's current name. A name the share left behind is FREED, and an
 * unrelated new share may take it over — so a trail hit sitting next to an
 * exact hit belongs to that other share, and treating the two as
 * interchangeable is what lets a widened trail capture a stranger's copy.
 *
 * Anything that doesn't resolve to exactly one copy is `ambiguous`, never a
 * guess: callers fail closed (refuse the update, light no badge).
 *
 * Callers pre-filter `copies` to markers written by the share's OWNER.
 */
export function resolveShareCopy<T>(
  copies: readonly T[],
  markerNameOf: (copy: T) => string,
  share: { skillName: string; previousNames: readonly string[] },
): ShareCopyMatch<T> {
  const exact = copies.filter((copy) => markerNameOf(copy) === share.skillName);
  const hits =
    exact.length > 0
      ? exact
      : copies.filter((copy) => share.previousNames.includes(markerNameOf(copy)));
  if (hits.length === 1) {
    return { match: hits[0] };
  }
  return hits.length > 1 ? { ambiguous: hits } : null;
}
