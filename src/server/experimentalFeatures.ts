/**
 * Registry of experimental (beta) avatar features the owner can toggle on/off
 * per avatar (#50). Each feature is gated end-to-end on its key being present in
 * the owner's `users.experimental_features` JSON array.
 *
 * `name`/`description` are shown to the user in Settings, so they are KOREAN
 * (the language split: user-facing strings are Korean). The KEYS are stable
 * identifiers and never shown. This module is intentionally dependency-free so
 * it can be imported by BOTH the server and the Svelte client (it is listed in
 * `tsconfig.client.json` includes), mirroring `routineSchedule.ts` — the client
 * renders the settings card from the same registry, avoiding drift.
 *
 * GRADUATING a feature = deleting its entry and its key gate: the stored key then
 * normalizes away on the next read, so nothing else has to migrate. The registry
 * may be empty (it is now), and the settings card hides itself then.
 *
 * RETIRED keys — reserved forever, never register them again (a stored value
 * from an old instance must not switch on something new):
 *  - `canvas`       — the visual canvas; graduated to always-on in 2026-10.
 *  - `canvasWidget` — the canvas `widget` content type (2026-11-10); replaced on
 *                     2026-11-11 by inline UI, which the avatar writes in its
 *                     answer text and which is always on (no flag).
 */
export interface ExperimentalFeature {
  /** Stable key stored in `users.experimental_features` and checked in gating. */
  key: string;
  /** User-facing name (Korean). */
  name: string;
  /** User-facing one-line description (Korean). */
  description: string;
}

export const EXPERIMENTAL_FEATURES: ExperimentalFeature[] = [];

/** All registered feature keys, for validation + membership checks. */
export const EXPERIMENTAL_FEATURE_KEYS: string[] = EXPERIMENTAL_FEATURES.map((f) => f.key);

/**
 * Normalize a raw experimental-features input (array from the PATCH body or a
 * parsed JSON column) to a deduped list of KNOWN keys. Unknown/removed keys are
 * dropped so a stale value can never enable a feature that no longer exists.
 * `known` defaults to the registry; tests pass their own while it is empty.
 */
export function normalizeExperimentalFeatures(
  input: unknown,
  known: readonly string[] = EXPERIMENTAL_FEATURE_KEYS,
): string[] {
  const raw: string[] = Array.isArray(input) ? input.filter((s): s is string => typeof s === "string") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const key = item.trim();
    if (!key || seen.has(key) || !known.includes(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}
