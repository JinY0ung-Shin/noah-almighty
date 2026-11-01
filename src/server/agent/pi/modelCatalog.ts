/**
 * pi-gateway's LIVE model list (`GET /v1/models`) — the ONLY source of the
 * models the composer offers and a run may pick, and of each model's image
 * input and reasoning efforts (docs/architecture/pi-runtime.md, "Models"). pi's
 * admin LLM page owns all of it: Noah has no model override and no vision
 * policy of its own (both retired 2026-11-01). A model value
 * anywhere in Noah is a pi model id; null/"" is pi-gateway's DEFAULT model (the
 * one picked on pi's admin LLM page), and then Noah sends no `model` at all. A
 * stored id pi no longer offers (or a legacy tier alias like `opus`) reads as
 * that default — no migration rewrites old values.
 *
 * One catalog per app instance (`piServicesFor(store, config).models`): a 60 s
 * cache, one in-flight fetch shared by every caller, and stale-on-error — a
 * failed refresh keeps the last good list, so a pi hiccup never empties the
 * picker or drops a valid pick. Never fetched successfully → empty. The
 * `local` stub has no pi, so its catalog is always empty.
 */
import logger from "../../logger.js";
import type { ModelEffortSupport } from "../../effortLevels.js";
import type { PiResponsesClient } from "./responsesClient.js";

/** One model pi-gateway offers. `server` is pi's `owned_by` (null when pi sent none). */
export interface CatalogModel {
  id: string;
  server: string | null;
  /** pi-gateway's default model — the id a continuing turn sends to switch to "기본 모델" (P3). */
  default?: true;
  /**
   * pi's LLM setting for image input: false = text-only (pi 400s an image),
   * true = accepted. Absent = pi did not say (an older pi) → read as accepted
   * ({@link visionForCatalogModel}).
   */
  imageInput?: boolean;
  /**
   * pi's reasoning efforts for the model (`effortForModel` clamps a pick to
   * them); null = not a reasoning model; absent = pi did not say (an older pi).
   */
  reasoning?: ModelEffortSupport | null;
}

/** What one lookup knows: the models, and whether that list came from pi at all. */
export interface CatalogSnapshot {
  models: CatalogModel[];
  /**
   * False when pi has never answered this process (no list ever fetched) and the
   * fetch just made failed — callers that WRITE a model value answer 503 then
   * instead of rejecting every id as unknown. Always true on the `local` stub.
   */
  available: boolean;
}

export interface PiModelCatalog {
  /** The models (cached, refreshed after the TTL; stale-on-error). Never throws. */
  list(): Promise<CatalogModel[]>;
  /** {@link list} plus whether pi was reachable at all (see {@link CatalogSnapshot}). Never throws. */
  snapshot(): Promise<CatalogSnapshot>;
  /** The last good list without fetching ([] before the first successful fetch). */
  peek(): CatalogModel[];
}

/** How long a fetched list is served before the next lookup refreshes it. */
export const PI_MODEL_CATALOG_TTL_MS = 60_000;
/** After a failed fetch, lookups serve what they have for this long before trying again. */
const FAILURE_RETRY_MS = 5_000;
/** A hung `/v1/models` must not hold a chat turn (or the bootstrap) for long. */
const FETCH_TIMEOUT_MS = 5_000;
/** Longest string Noah stores as a model id (pi ids are short; this only bounds garbage). */
export const MAX_MODEL_ID_CHARS = 200;

export interface PiModelCatalogOptions {
  ttlMs?: number;
  now?: () => number;
}

/** A catalog over `client`; null (the `local` stub) → always empty, always available. */
export function createPiModelCatalog(
  client: Pick<PiResponsesClient, "listModels"> | null,
  options: PiModelCatalogOptions = {},
): PiModelCatalog {
  const ttlMs = options.ttlMs ?? PI_MODEL_CATALOG_TTL_MS;
  const now = options.now ?? Date.now;
  let good: CatalogModel[] | null = null;
  /** When the next lookup may fetch again (0 = now). */
  let freshUntil = 0;
  let lastFetchFailed = false;
  let inFlight: Promise<void> | null = null;

  const refresh = (): Promise<void> => {
    if (!client) return Promise.resolve();
    inFlight ??= (async () => {
      try {
        const models = await client.listModels(AbortSignal.timeout(FETCH_TIMEOUT_MS));
        const seen = new Set<string>();
        good = [];
        for (const model of models) {
          const id = model.id.trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          good.push({
            id,
            server: model.ownedBy?.trim() || null,
            ...(model.default ? { default: true as const } : {}),
            ...(model.imageInput !== undefined ? { imageInput: model.imageInput } : {}),
            ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
          });
        }
        lastFetchFailed = false;
        freshUntil = now() + ttlMs;
      } catch (error) {
        lastFetchFailed = true;
        freshUntil = now() + FAILURE_RETRY_MS;
        logger.warn(
          { err: error, cachedModels: good?.length ?? null },
          good ? "pi-gateway model list refresh failed; serving the last good list" : "pi-gateway model list unavailable",
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const snapshot = async (): Promise<CatalogSnapshot> => {
    if (!client) return { models: [], available: true };
    if (now() >= freshUntil) await refresh();
    return { models: good ?? [], available: good !== null || !lastFetchFailed };
  };

  return {
    snapshot,
    list: async () => (await snapshot()).models,
    peek: () => good ?? [],
  };
}

/** The ids of `models`, for membership checks. */
export function catalogModelIds(models: readonly CatalogModel[]): string[] {
  return models.map((model) => model.id);
}

/** The id of pi-gateway's default model (`default: true` in its list); undefined when pi named none. */
export function catalogDefaultModelId(models: readonly CatalogModel[]): string | undefined {
  return models.find((model) => model.default)?.id;
}

/**
 * pi's effort support for `model` (undefined → pi's default model, by its id):
 * the input of `effortForModel`. Undefined when the model or the field is unknown.
 */
export function catalogEffortSupport(
  models: readonly CatalogModel[],
  model: string | null | undefined,
): ModelEffortSupport | null | undefined {
  const id = model || catalogDefaultModelId(models);
  return id ? models.find((entry) => entry.id === id)?.reasoning : undefined;
}

/**
 * Whether the model a run resolves to accepts image input — pi's own LLM
 * setting and nothing else (Noah's admin vision policy and `MODEL_VISION` are
 * retired). `model` undefined/null is pi's DEFAULT model, looked up by the id
 * its list marks `default`. ONLY an explicit `imageInput: false` makes a model
 * text-only (pi would 400 an image): a model pi did not describe (an older pi),
 * an id not in the list and an empty list (the `local` stub, or pi never
 * answered) all read as vision ON — the pre-retirement default — so a wrong
 * guess surfaces as pi's visible `unsupported_image_input` error instead of a
 * silently image-less turn. The chat route's upload mode, the capability plan
 * and the bootstrap all call this, so the upload mode, both metacognition
 * surfaces and the composer agree.
 */
export function visionForCatalogModel(models: readonly CatalogModel[], model: string | null | undefined): boolean {
  const id = model || catalogDefaultModelId(models);
  return !(id && models.find((entry) => entry.id === id)?.imageInput === false);
}

/** `value` when it names a model in `models`, else undefined (unset / unknown → pi's default model). */
export function catalogModel(models: readonly CatalogModel[], value: unknown): string | undefined {
  return typeof value === "string" && value && models.some((model) => model.id === value) ? value : undefined;
}

/**
 * Retired model env vars: `PI_MODEL_MAP` (the composer shows pi-gateway's live
 * model list) and `MODEL_VISION` (pi's admin LLM page sets each model's image
 * input; retired 2026-11-01). Neither is read any more; while one is still set
 * every boot logs one warning for it so the operator deletes it.
 */
export function warnRetiredModelEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PI_MODEL_MAP?.trim()) {
    logger.warn(
      "PI_MODEL_MAP is set but ignored: the composer now offers pi-gateway's live model list — delete it from the deployment environment",
    );
  }
  if (env.MODEL_VISION?.trim()) {
    logger.warn(
      "MODEL_VISION is set but ignored: pi-gateway's admin LLM page sets each model's image input — delete it from the deployment environment",
    );
  }
}
