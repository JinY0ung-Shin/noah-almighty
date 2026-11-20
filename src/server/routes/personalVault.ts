import { Router, type NextFunction, type Response } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import {
  MEMORY_WIKI_MAX_BYTES,
  MEMORY_WIKI_MAX_NOTES,
  MemoryRefusedError,
  MemoryUnavailableError,
  memoryClientFor,
  probeMemoryVault,
} from "../memory/memoryClient.js";
import type { RouterDeps } from "./_shared.js";

// ---- Personal vault: how full it is (admin), whether it answers (the owner) ----
// Every owner's brain notes live in the memory service (../personalVault.ts);
// nothing here moves or copies them. The admin half shows how full each wiki is,
// the `me` half tells the settings card whether the service answers right now.

/** How many owners' wikis the usage view lists at once, and how long one listing may take. */
const USAGE_CONCURRENCY = 4;
const USAGE_TIMEOUT_MS = 10_000;

/** One owner's wiki in the usage view: its size, or why it could not be listed. Never a note path or content. */
type OwnerUsage =
  | { userId: string; notes: number; bytes: number }
  | { userId: string; error: "unavailable" | "refused" | "timeout" };

export function createPersonalVaultRouter(deps: RouterDeps): Router {
  const { config, store } = deps;
  const router = Router();

  // How full each owner's wiki in the memory service is (notes, bytes) against the service's limits —
  // counts and sizes only, never a note path or content: an admin sees whether a brain is near `wiki_full`,
  // not what is in it. An owner = a user with a knowledge repository connected (the brain needs one; there
  // is no other record of "has the brain set up"). One `list` per owner. Read-only, not audited.
  router.get(
    "/api/admin/personal-vaults/usage",
    requireAuth(store),
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const limits = { notes: MEMORY_WIKI_MAX_NOTES, bytes: MEMORY_WIKI_MAX_BYTES };
        const client = memoryClientFor(store, config);
        if (!client) {
          res.json({ serviceConfigured: false, limits, owners: [] });
          return;
        }
        const ownerIds = store
          .listUsers()
          .map((user) => user.id)
          .filter((userId) => Boolean(store.getKnowledgeRepo(userId).repo));
        const owners: OwnerUsage[] = new Array(ownerIds.length);
        const usageOf = async (userId: string): Promise<OwnerUsage> => {
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<OwnerUsage>((resolve) => {
            timer = setTimeout(() => resolve({ userId, error: "timeout" }), USAGE_TIMEOUT_MS);
            timer.unref?.();
          });
          const listed = client.list(userId).then(
            (entries): OwnerUsage => ({ userId, notes: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }),
            (error: unknown): OwnerUsage => {
              if (!(error instanceof MemoryRefusedError) && !(error instanceof MemoryUnavailableError)) {
                logger.warn({ userId, err: error }, "personal vault usage: the listing failed unexpectedly");
              }
              return { userId, error: error instanceof MemoryRefusedError ? "refused" : "unavailable" };
            },
          );
          try {
            return await Promise.race([listed, timedOut]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        let cursor = 0;
        const worker = async () => {
          while (cursor < ownerIds.length) {
            const index = cursor++;
            owners[index] = await usageOf(ownerIds[index]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(USAGE_CONCURRENCY, ownerIds.length) }, worker));
        res.json({ serviceConfigured: true, limits, owners });
      } catch (error) {
        // Express 4 does not catch a rejected async handler.
        next(error);
      }
    },
  );

  // What the settings tab shows an owner. `serviceConfigured` false = this server has no memory service:
  // nothing of the brain works. `service` (null without one): whether the memory service answers RIGHT NOW
  // for this owner's wiki — the same bounded check as describe_system's line, so the card states an outage.
  // `ok` | `unavailable` (no answer, or not as the service) | `refused`.
  router.get("/api/me/personal-vault", requireAuth(store), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const client = memoryClientFor(store, config);
      let service: "ok" | "unavailable" | "refused" | null = null;
      if (client) {
        const outcome = await probeMemoryVault(client, userId);
        service = outcome.kind === "ok" ? "ok" : outcome.kind === "refused" ? "refused" : "unavailable";
        if (service !== "ok") {
          logger.warn({ userId, outcome }, "personal vault status: the memory service did not answer the settings card's check");
        }
      }
      res.json({ serviceConfigured: client !== null, service });
    } catch (error) {
      // Express 4 does not catch a rejected async handler.
      next(error);
    }
  });

  return router;
}
