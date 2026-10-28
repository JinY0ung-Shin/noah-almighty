import { MODEL_TIER_IDS, isModelTier } from "./modelTiers.js";

/**
 * Admin-managed per-model-TIER vision policy: which composer tiers accept image
 * input. Serving backends map each tier alias to a different concrete model
 * (`ANTHROPIC_DEFAULT_<TIER>_MODEL`), and those models can differ in vision
 * support — a deployment-wide `MODEL_VISION` flag alone is too coarse.
 *
 * Shape: `{ [tierId]: boolean }`. A tier PRESENT in the map is explicitly
 * set; an ABSENT tier inherits the deployment default (`config.visionEnabled`,
 * env `MODEL_VISION`). Stored as one JSON `app_config` row, mirroring the
 * tool/skill policy (missing/corrupt → empty map = everything inherits).
 */
export type ModelVisionPolicy = Record<string, boolean>;

/** app_config row key (see store/secrets.ts get/setModelVisionPolicy). */
export const MODEL_VISION_POLICY_CONFIG_KEY = "model_vision_policy";

/**
 * Normalize unknown input into a policy map: keep only known tier ids with
 * strict-boolean values. Anything else (bad shape, unknown tier, non-boolean)
 * is dropped rather than failing — the safe reading for a stored row.
 */
export function normalizeModelVisionPolicy(raw: unknown): ModelVisionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const policy: ModelVisionPolicy = {};
  for (const id of MODEL_TIER_IDS) {
    const value = (raw as Record<string, unknown>)[id];
    if (typeof value === "boolean") {
      policy[id] = value;
    }
  }
  return policy;
}

/**
 * Strict parse for the admin PUT: must be a plain object whose keys are all
 * known tier ids and whose values are booleans. Returns null on any violation
 * so the route can 400 instead of silently dropping entries.
 */
export function parseModelVisionPolicy(raw: unknown): ModelVisionPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const policy: ModelVisionPolicy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MODEL_TIER_IDS.includes(key) || typeof value !== "boolean") {
      return null;
    }
    policy[key] = value;
  }
  return policy;
}

/**
 * Effective vision for the model a run resolved to. `model` is whatever the
 * resolution chain produced (`env pin > user tier > admin override > default`):
 * a tier ALIAS consults the policy (falling back to the deployment default for
 * unset tiers); a concrete model id (env pin / non-tier admin override) can't
 * be looked up per-tier, so it uses the deployment default.
 */
export function visionForModel(
  model: string | null | undefined,
  policy: ModelVisionPolicy,
  deploymentDefault: boolean,
): boolean {
  if (isModelTier(model) && model in policy) {
    return policy[model];
  }
  return deploymentDefault;
}
