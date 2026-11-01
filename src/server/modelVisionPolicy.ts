import { MAX_MODEL_ID_CHARS, catalogDefaultModelId, type CatalogModel } from "./agent/pi/modelCatalog.js";

/**
 * Admin-managed per-MODEL vision policy: which of pi-gateway's models accept
 * image input. The models pi offers (`agent/pi/modelCatalog.ts`) can differ in
 * vision support — a deployment-wide `MODEL_VISION` flag alone is too coarse.
 *
 * Shape: `{ [piModelId]: boolean }`. A model PRESENT in the map is explicitly
 * set; an ABSENT model inherits the deployment default (`config.visionEnabled`,
 * env `MODEL_VISION`). pi-gateway's default model (nothing picked, no override)
 * is looked up by its id like any other. Above both sits pi's own LLM setting:
 * a model pi reports without image input is text-only whatever this map or
 * MODEL_VISION say ({@link visionForCatalogModel}) — the policy can turn a
 * vision model OFF, never a text-only one on. Stored as one JSON `app_config`
 * row, mirroring the tool/skill policy (missing/corrupt → empty map =
 * everything inherits). Entries for models pi later drops stay stored and are
 * simply never consulted.
 */
export type ModelVisionPolicy = Record<string, boolean>;

/** app_config row key (see store/secrets.ts get/setModelVisionPolicy). */
export const MODEL_VISION_POLICY_CONFIG_KEY = "model_vision_policy";

/**
 * Normalize unknown input into a policy map: keep only plausible model-id keys
 * with strict-boolean values. Anything else (bad shape, non-boolean) is dropped
 * rather than failing — the safe reading for a stored row.
 */
export function normalizeModelVisionPolicy(raw: unknown): ModelVisionPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const policy: ModelVisionPolicy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.length > 0 && key.length <= MAX_MODEL_ID_CHARS && key.trim() === key && typeof value === "boolean") {
      policy[key] = value;
    }
  }
  return policy;
}

/**
 * Strict parse for the admin PUT: must be a plain object whose keys are all
 * ids in `catalogIds` (the models pi-gateway currently offers) and whose values
 * are booleans. Returns null on any violation so the route can 400 instead of
 * silently dropping entries.
 */
export function parseModelVisionPolicy(raw: unknown, catalogIds: readonly string[]): ModelVisionPolicy | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const policy: ModelVisionPolicy = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!catalogIds.includes(key) || typeof value !== "boolean") {
      return null;
    }
    policy[key] = value;
  }
  return policy;
}

/**
 * The admin policy alone: a pi model id consults the policy (an unset model
 * inherits the deployment default); no id → the deployment default. A run's
 * model goes through {@link visionForCatalogModel}, which also names pi's
 * default model and honors pi's own image setting.
 */
export function visionForModel(
  model: string | null | undefined,
  policy: ModelVisionPolicy,
  deploymentDefault: boolean,
): boolean {
  if (model && Object.hasOwn(policy, model)) {
    return policy[model];
  }
  return deploymentDefault;
}

/**
 * Vision of the model a run resolves to, against pi-gateway's live list:
 * `model` undefined/null is pi's DEFAULT model, looked up by the id its list
 * marks `default` (so the admin policy for that model applies too). A model pi
 * reports without image input (`imageInput: false`) is text-only — pi would
 * 400 an image — regardless of the policy and MODEL_VISION; otherwise
 * {@link visionForModel} decides. pi silent on input (an older pi) → the policy
 * alone, as before. The chat route, the capability plan and the bootstrap all
 * call this, so the upload mode, both metacognition surfaces and the composer
 * agree.
 */
export function visionForCatalogModel(
  models: readonly CatalogModel[],
  model: string | null | undefined,
  policy: ModelVisionPolicy,
  deploymentDefault: boolean,
): boolean {
  const id = model || catalogDefaultModelId(models);
  if (id && models.find((entry) => entry.id === id)?.imageInput === false) {
    return false;
  }
  return visionForModel(id, policy, deploymentDefault);
}
