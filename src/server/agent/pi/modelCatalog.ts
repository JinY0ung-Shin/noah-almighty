/**
 * pi-gateway's LIVE model list (`GET /v1/models`) — the ONLY source of the
 * models the composer offers, the admin override and vision policy name, and a
 * run may pick (docs/architecture/pi-runtime.md, "Models"). A model value
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
import type { PiResponsesClient } from "./responsesClient.js";

/** One model pi-gateway offers. `server` is pi's `owned_by` (null when pi sent none). */
export interface CatalogModel {
  id: string;
  server: string | null;
  /** pi-gateway's default model — the id a continuing turn sends to switch to "기본 모델" (P3). */
  default?: true;
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
          good.push({ id, server: model.ownedBy?.trim() || null, ...(model.default ? { default: true as const } : {}) });
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

/** `value` when it names a model in `models`, else undefined (unset / unknown → pi's default model). */
export function catalogModel(models: readonly CatalogModel[], value: unknown): string | undefined {
  return typeof value === "string" && value && models.some((model) => model.id === value) ? value : undefined;
}

/**
 * `PI_MODEL_MAP` is RETIRED (the composer shows pi-gateway's live model list):
 * it is no longer read, and while it is still set every boot logs one warning
 * so the operator deletes it.
 */
export function warnRetiredModelMapEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PI_MODEL_MAP?.trim()) {
    logger.warn(
      "PI_MODEL_MAP is set but ignored: the composer now offers pi-gateway's live model list — delete it from the deployment environment",
    );
  }
}
