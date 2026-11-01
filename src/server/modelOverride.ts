/**
 * The admin model override (관리자 → 시스템 → 모델) — the model a conversation
 * uses when its composer picked none. It is a pi model id from pi-gateway's live
 * list (`agent/pi/modelCatalog.ts`): `PUT /api/admin/model` accepts nothing else,
 * and a stored value pi no longer offers (a model pi dropped, an SDK-era Claude
 * id, a retired tier alias like `opus`) is IGNORED at run time — the run uses
 * pi-gateway's default model and describe_system says why (review-2 M2).
 */
import type { Store } from "./store.js";
import logger from "./logger.js";

export interface ModelOverrideState {
  /** The override a run uses, or null (none stored, or the stored one is ignored). */
  effective: string | null;
  /** A stored value pi-gateway does not currently offer — ignored. */
  ignored: string | null;
}

// One warn per distinct ignored value per process: every run reads the override.
const warnedIgnored = new Set<string>();

/**
 * The stored override split into what runs use and what is ignored (warned once
 * per value), against `catalogIds` — the ids pi-gateway currently offers.
 */
export function modelOverrideState(
  store: Pick<Store, "getModelOverride">,
  catalogIds: readonly string[],
): ModelOverrideState {
  const stored = store.getModelOverride();
  if (!stored || catalogIds.includes(stored)) return { effective: stored, ignored: null };
  if (!warnedIgnored.has(stored)) {
    warnedIgnored.add(stored);
    logger.warn(
      { model: stored, offered: catalogIds },
      "admin model override is not a model pi-gateway currently offers; ignored (runs use pi-gateway's default model)",
    );
  }
  return { effective: null, ignored: stored };
}

/** The override a run uses (see {@link modelOverrideState}). */
export function effectiveModelOverride(
  store: Pick<Store, "getModelOverride">,
  catalogIds: readonly string[],
): string | null {
  return modelOverrideState(store, catalogIds).effective;
}
