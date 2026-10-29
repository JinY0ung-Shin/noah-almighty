/**
 * The admin model override (관리자 → 시스템 → 모델) — the model a conversation
 * uses when its composer picked no tier. It is a tier name or a `PI_MODEL_MAP`
 * key, so it always resolves to a configured pi model: `PUT /api/admin/model`
 * accepts nothing else, and a value stored before that check (an SDK-era
 * deployment's concrete Claude id, a typo) is IGNORED at run time — the run
 * falls back to the default tier instead of silently landing on pi's own
 * default model while describe_system names the override (review-2 M2).
 */
import type { AppConfig } from "./types.js";
import type { Store } from "./store.js";
import { MODEL_TIER_IDS } from "./modelTiers.js";
import logger from "./logger.js";

/** Every value the override may hold: the tier names, then the extra `PI_MODEL_MAP` keys. */
export function modelOverrideChoices(config: Pick<AppConfig, "pi">): string[] {
  const keys = Object.keys(config.pi?.modelMap ?? {});
  return [...MODEL_TIER_IDS, ...keys.filter((key) => !MODEL_TIER_IDS.includes(key))];
}

/** Whether `value` names a tier or a `PI_MODEL_MAP` key. */
export function isAcceptedModelOverride(config: Pick<AppConfig, "pi">, value: string): boolean {
  return modelOverrideChoices(config).includes(value);
}

export interface ModelOverrideState {
  /** The override a run uses, or null (none stored, or the stored one is ignored). */
  effective: string | null;
  /** A stored value that is neither a tier nor a `PI_MODEL_MAP` key — ignored. */
  ignored: string | null;
}

// One warn per distinct ignored value per process: every run reads the override.
const warnedIgnored = new Set<string>();

/** The stored override split into what runs use and what is ignored (warned once per value). */
export function modelOverrideState(store: Pick<Store, "getModelOverride">, config: Pick<AppConfig, "pi">): ModelOverrideState {
  const stored = store.getModelOverride();
  if (!stored || isAcceptedModelOverride(config, stored)) return { effective: stored, ignored: null };
  if (!warnedIgnored.has(stored)) {
    warnedIgnored.add(stored);
    logger.warn(
      { model: stored, accepted: modelOverrideChoices(config) },
      "admin model override is neither a tier nor a PI_MODEL_MAP key; ignored (runs use the default tier)",
    );
  }
  return { effective: null, ignored: stored };
}

/** The override a run uses (see {@link modelOverrideState}). */
export function effectiveModelOverride(store: Pick<Store, "getModelOverride">, config: Pick<AppConfig, "pi">): string | null {
  return modelOverrideState(store, config).effective;
}
