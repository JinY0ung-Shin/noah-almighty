/**
 * Registry of model TIERS a user can pick per conversation in the chat composer.
 *
 * Each tier `id` (`fable`/`opus`/`sonnet`/`haiku`) is a stable alias. Which
 * concrete pi model a tier runs is the OPERATOR's call: `PI_MODEL_MAP` maps
 * every tier (and any concrete model id an admin override names) to a pi model
 * id, read by `parsePiModelMap` (config.ts) — the only tier → model source. So
 * the picker offers tiers; the deployment pins the models.
 *
 * Precedence (`runCapabilities.ts`): user tier (this) > admin override > the
 * DEFAULT tier.
 *
 * `label`/`description` are shown to the user, so they are KOREAN (the language
 * split: user-facing strings are Korean); the `id` aliases are stable identifiers
 * the model reads and are never localized. This module is intentionally
 * dependency-free so BOTH the server and the Svelte client can import it (it is
 * listed in `tsconfig.client.json` includes), mirroring `experimentalFeatures.ts`
 * / `routineSchedule.ts` — the composer renders the same registry, avoiding drift.
 */
export interface ModelTier {
  /** Tier alias, mapped to a pi model by `PI_MODEL_MAP`. */
  id: string;
  /** User-facing tier name (a proper noun; kept as-is). */
  label: string;
  /** User-facing one-line description (Korean). */
  description: string;
}

export const MODEL_TIERS: ModelTier[] = [
  {
    id: "fable",
    label: "Fable",
    description: "Opus를 넘어서는 최상위 모델 — 가장 까다로운 추론·장기 작업에 적합 (가장 느리고 비쌈)",
  },
  {
    id: "opus",
    label: "Opus",
    description: "가장 정교한 추론 — 복잡하고 어려운 작업에 적합 (느리고 비쌈)",
  },
  {
    id: "sonnet",
    label: "Sonnet",
    description: "속도와 성능의 균형 — 대부분의 대화에 적합",
  },
  {
    id: "haiku",
    label: "Haiku",
    description: "가장 빠르고 가벼움 — 간단한 작업에 적합",
  },
];

/** All registered tier ids (aliases), for validation + membership checks. */
export const MODEL_TIER_IDS: string[] = MODEL_TIERS.map((t) => t.id);

/**
 * The tier used when no more-specific choice applies (user pick / admin
 * override both absent). The composer has no "default" option — every conversation
 * resolves to a concrete tier, and this is the floor.
 */
export const DEFAULT_MODEL_TIER = "opus";

/** Type guard: a non-empty string that names a known tier alias. */
export function isModelTier(value: unknown): value is string {
  return typeof value === "string" && MODEL_TIER_IDS.includes(value);
}

/** User-facing tier label for an alias, or the raw id when it isn't a known tier. */
export function modelTierLabel(id: string): string {
  return MODEL_TIERS.find((t) => t.id === id)?.label ?? id;
}
