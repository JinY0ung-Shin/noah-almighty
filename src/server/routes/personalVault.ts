import { Router, type NextFunction, type Response } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { memoryClientFor, probeMemoryVault } from "../memory/memoryClient.js";
import type { PersonalVaultRow, VaultMirrorHold } from "../store/personalVault.js";
import {
  VAULT_CONFIRM_REFUSAL,
  VAULT_ROLLBACK_REFUSAL,
  confirmVaultMirrorHold,
  isVaultMigrationRunning,
  lastVaultMigrationReport,
  planVaultMigration,
  recheckVaultMirrorHold,
  rollbackVault,
  startVaultMigrationPass,
  type VaultMigrationReport,
} from "../vaultMigration.js";
import { apiError, safeString, type RouterDeps } from "./_shared.js";

// ---- Personal vault: where it lives, its mirror, the migration ----------------
// The admin half moves vaults between the knowledge repository and the memory
// service (vaultMigration.ts): dry run, mode, pass, rollback. The `me` half is
// what the settings tab shows an owner, and the one press that lets the mirror
// write into a newly connected repository that holds vault notes of its own.

/** How many owners a dry run looks at at once (each one syncs its own clone, under its own lock). */
const DRY_RUN_CONCURRENCY = 4;

const NOT_CONFIGURED_MESSAGE =
  "이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 서버 설정(PI_MEMORY_URL, PI_MEMORY_API_KEY_FILE)을 확인해 주세요.";

interface VaultMirrorView {
  dirty: boolean;
  syncedAt: string | null;
  error: string | null;
  /** `checking`: a repository or branch was just connected and is being looked at; `confirm`: the owner must confirm; null: no hold. */
  hold: VaultMirrorHold | null;
  /** What the last successful copy has to tell the owner (repository notes the service does not hold); null = nothing. */
  notice: string | null;
}

function mirrorOf(row: PersonalVaultRow | null): VaultMirrorView | null {
  return row
    ? { dirty: row.mirrorDirty, syncedAt: row.mirrorSyncedAt, error: row.mirrorError, hold: row.mirrorHold, notice: row.mirrorNotice }
    : null;
}

/** Why a rollback did not happen, for the admin who pressed it. */
function rollbackRefusalMessage(reason: string): string {
  const cut = reason.indexOf(": ");
  const code = cut === -1 ? reason : reason.slice(0, cut);
  const detail = cut === -1 ? "" : reason.slice(cut + 2);
  switch (code) {
    case VAULT_ROLLBACK_REFUSAL.notConfigured:
      return NOT_CONFIGURED_MESSAGE;
    case VAULT_ROLLBACK_REFUSAL.unavailable:
      return "메모리 서비스에 연결하지 못해 남아 있는 사본을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.backupFailed:
      return "이 서버는 마지막으로 시작한 뒤 데이터베이스 백업에 실패해, 데이터를 바꾸는 정비 작업을 보류하고 있습니다(원인은 서버 로그에 있습니다). 그 문제를 해결하고 서버를 다시 시작하기 전에는 되돌리지 않습니다.";
    case VAULT_ROLLBACK_REFUSAL.homeMismatch:
      return "이 팀원의 개인 브레인 위치가 화면에 보이던 것과 다릅니다. 아무것도 바꾸지 않았습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.mirrorHold:
      return "이 팀원의 저장소 사본이 보류 중이라 되돌릴 수 없습니다(새로 연결한 저장소를 확인하는 중이거나, 본인의 확인을 기다리는 중입니다). 본인이 설정 ▸ 지식·플러그인에서 확인한 뒤 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.mirrorNoRepo:
      return "연결된 저장소가 없어 노트를 돌려놓을 곳이 없습니다. 본인이 저장소를 연결한 뒤 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.mirrorRepoDirty:
      return "저장소에 커밋하지 않은 다른 변경이 있어 사본만 따로 올리지 않았습니다. 본인이 아바타에게 저장소 커밋을 요청하면 사본도 함께 올라갑니다. 그 뒤 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.leftoverNotSaved:
      return "메모리 서비스에 있는 노트 중 저장소에 없는 것을 읽어 따로 보관하지 못했습니다. 아무것도 지우거나 바꾸지 않았습니다. 잠시 후 다시 시도해 주세요.";
    case VAULT_ROLLBACK_REFUSAL.mirrorFailed:
      return `저장소 사본을 최신으로 올리지 못해 되돌릴 수 없습니다. 노트는 메모리 서비스에 그대로 있습니다.${detail ? ` (상세: ${detail})` : ""}`;
    case VAULT_ROLLBACK_REFUSAL.mirrorBehind:
      return "저장소 사본이 아직 최신이 아니어서 되돌릴 수 없습니다. 잠시 후 다시 시도해 주세요.";
    default:
      return "되돌리는 중 오류가 발생했습니다. 서버 로그를 확인해 주세요.";
  }
}

export function createPersonalVaultRouter(deps: RouterDeps): Router {
  const { config, store, auditAs } = deps;
  const router = Router();

  const serviceConfigured = () => memoryClientFor(store, config) !== null;

  // Every owner, where their vault lives, the mirror's state and the last
  // report this process still holds (a dry run or a cutover).
  router.get("/api/admin/personal-vaults", requireAuth(store), requireAdmin, (_req, res) => {
    const owners = store.listUsers().map((user) => {
      const row = store.getPersonalVault(user.id);
      const repo = store.getKnowledgeRepo(user.id).repo;
      return {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        state: row ? ("memory" as const) : repo ? ("repo" as const) : ("no_repo" as const),
        repo,
        migratedAt: row?.migratedAt ?? null,
        mirror: mirrorOf(row),
        report: lastVaultMigrationReport(store, user.id),
      };
    });
    res.json({
      mode: store.getPersonalVaultMode(),
      serviceConfigured: serviceConfigured(),
      running: isVaultMigrationRunning(store),
      owners,
    });
  });

  // Dry run over every owner: what a cutover would import, skip and be blocked
  // by. Changes nothing in the service or the database (each clone is synced
  // with its remote, as any run does), so it is not an audited change.
  router.post(
    "/api/admin/personal-vaults/dry-run",
    requireAuth(store),
    requireAdmin,
    async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userIds = store.listUsers().map((user) => user.id);
        const reports: VaultMigrationReport[] = new Array(userIds.length);
        let cursor = 0;
        const worker = async () => {
          while (cursor < userIds.length) {
            const index = cursor++;
            reports[index] = await planVaultMigration(store, config, userIds[index]);
          }
        };
        await Promise.all(Array.from({ length: Math.min(DRY_RUN_CONCURRENCY, userIds.length) }, worker));
        res.json({ reports });
      } catch (error) {
        // Express 4 does not catch a rejected async handler.
        next(error);
      }
    },
  );

  // Where vaults SHOULD live. `memory` starts the pass in the background;
  // `repo` only stops NEW cutovers — it rolls nobody back.
  router.post("/api/admin/personal-vaults/mode", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const mode = safeString(req.body?.mode);
    if (mode !== "repo" && mode !== "memory") {
      apiError(res, 400, "mode는 'repo' 또는 'memory' 여야 합니다.");
      return;
    }
    if (mode === "memory" && !serviceConfigured()) {
      apiError(res, 409, NOT_CONFIGURED_MESSAGE);
      return;
    }
    store.setPersonalVaultMode(mode);
    const started = mode === "memory" ? startVaultMigrationPass(store, config) : false;
    auditAs(req, "set_personal_vault_mode", `personal vault mode = ${mode}${started ? " (migration pass started)" : ""}`);
    logger.warn({ actorId: req.user!.id, mode, started }, "personal vault mode changed");
    res.json({ mode, started });
  });

  // Run the pass now (a manual retry of the owners that were blocked).
  router.post("/api/admin/personal-vaults/run", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    if (!serviceConfigured()) {
      apiError(res, 409, NOT_CONFIGURED_MESSAGE);
      return;
    }
    if (store.getPersonalVaultMode() !== "memory") {
      apiError(res, 409, "개인 브레인의 위치가 '저장소'로 설정되어 있어 아무도 옮기지 않습니다. 먼저 '메모리 서비스'로 바꿔 주세요.");
      return;
    }
    const started = startVaultMigrationPass(store, config);
    if (started) {
      auditAs(req, "personal_vault_run", "personal vault migration pass started");
      logger.warn({ actorId: req.user!.id }, "personal vault migration pass started");
    }
    res.status(202).json({ started });
  });

  // One owner back to the repository (`expect: "memory"`), or — for an owner
  // already on the repository — the leftover copy in the service discarded
  // (`expect: "repo"`). The body says which of the two the admin's screen
  // offered; when the owner's home is the other one by now, nothing is done
  // (409). A real rollback is blocked (409, with the reason) when the mirror
  // cannot be brought up to date — it never falls back to an older copy.
  router.post(
    "/api/admin/personal-vaults/:userId/rollback",
    requireAuth(store),
    requireAdmin,
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const userId = req.params.userId;
        if (!store.getUserById(userId)) {
          apiError(res, 404, "사용자를 찾을 수 없습니다.");
          return;
        }
        const expect = req.body?.expect;
        if (expect !== "memory" && expect !== "repo") {
          apiError(res, 400, "expect는 'memory' 또는 'repo' 여야 합니다.");
          return;
        }
        const result = await rollbackVault(store, config, userId, { expect });
        if (!result.ok) {
          auditAs(req, "personal_vault_rollback", `rollback of ${userId} refused: ${result.reason}`, "error");
          logger.warn({ actorId: req.user!.id, targetId: userId, reason: result.reason }, "personal vault rollback refused");
          apiError(res, 409, rollbackRefusalMessage(result.reason));
          return;
        }
        // `leftover`: the owner's home already was `repo`; what the service still held for them was discarded.
        auditAs(
          req,
          "personal_vault_rollback",
          result.leftover
            ? `leftover copy of ${userId} in the memory service discarded (${result.leftover.notes} notes; ${result.leftover.quarantined} not in the repository were quarantined first)`
            : `personal vault of ${userId} moved back to the repository${result.quarantined ? ` (${result.quarantined} wiki notes outside the vault paths were quarantined first)` : ""}`,
        );
        logger.warn({ actorId: req.user!.id, targetId: userId, leftover: result.leftover ?? null }, "personal vault rolled back");
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    },
  );

  // What the settings tab shows an owner. `mirror` is null only while the
  // vault lives in the repository (there is no mirror then). `serviceConfigured`
  // false = this server has no memory service: for an owner in `memory` nothing
  // of the brain works and the copy loop does not run, whatever `mirror` says.
  // `service` (home `memory` only, else null): whether the memory service answers RIGHT NOW for this vault —
  // the same bounded check as describe_system's line, so the card states an outage instead of only the
  // copy's last state. `ok` | `unavailable` (no answer, or not as the service) | `refused`.
  router.get("/api/me/personal-vault", requireAuth(store), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.id;
      const row = store.getPersonalVault(userId);
      const client = memoryClientFor(store, config);
      let service: "ok" | "unavailable" | "refused" | null = null;
      if (row && client) {
        const outcome = await probeMemoryVault(client, userId);
        service = outcome.kind === "ok" ? "ok" : outcome.kind === "refused" ? "refused" : "unavailable";
        if (service !== "ok") {
          logger.warn({ userId, outcome }, "personal vault status: the memory service did not answer the settings card's check");
        }
      }
      res.json({ home: row ? "memory" : "repo", mirror: mirrorOf(row), serviceConfigured: client !== null, service });
    } catch (error) {
      // Express 4 does not catch a rejected async handler.
      next(error);
    }
  });

  // The owner asks for the look at their newly connected repository to run
  // again now (they fixed what was in the way: a git token, the address).
  // Only while the hold is `checking`; it changes nothing by itself — the
  // look does, as after the connect. 202: the look runs in the background.
  router.post("/api/me/personal-vault/mirror-recheck", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.status(202).json({ started: recheckVaultMirrorHold(store, config, req.user!.id) });
  });

  // The owner's press: the memory service's version may replace the vault
  // notes of the connected repository. Only in the `confirm` state (the check
  // found repository vault notes the copy would replace), and only for the
  // repository and branch the owner's screen showed — the body carries them.
  // The press covers the repository as it is NOW: `confirmVaultMirrorHold`
  // reads it now and writes the vault notes only it holds into the deletion
  // ledger, then lifts the hold and marks the mirror behind. A note that
  // reaches the repository by git after the press is not covered and is kept.
  // An unreadable repository or service changes nothing (503, press again).
  router.post("/api/me/personal-vault/mirror-confirm", requireAuth(store), async (req: AuthenticatedRequest, res, next) => {
    try {
      const userId = req.user!.id;
      const repo = typeof req.body?.repo === "string" ? req.body.repo.trim() : "";
      const branch = typeof req.body?.branch === "string" ? req.body.branch.trim() || null : null;
      const result = await confirmVaultMirrorHold(store, config, userId, { repo, branch });
      if (!result.ok) {
        switch (result.reason) {
          case VAULT_CONFIRM_REFUSAL.notMemory:
            apiError(res, 409, "개인 브레인이 저장소에 있어 확인할 사본이 없습니다.");
            return;
          case VAULT_CONFIRM_REFUSAL.checking:
            apiError(res, 409, "새로 연결한 저장소를 아직 확인하는 중입니다. 확인이 끝난 뒤, 필요할 때만 다시 물어봅니다.");
            return;
          case VAULT_CONFIRM_REFUSAL.noHold:
            apiError(res, 409, "지금은 확인할 것이 없습니다. 화면을 새로 고쳐 주세요.");
            return;
          case VAULT_CONFIRM_REFUSAL.repoChanged:
            apiError(res, 409, "연결된 저장소나 브랜치가 화면에 보이던 것과 다릅니다. 아무것도 바꾸지 않았습니다. 화면을 새로 고친 뒤 다시 확인해 주세요.");
            return;
          default:
            logger.warn({ userId, repo, branch, detail: result.detail ?? null }, "vault mirror confirmation not applied: the repository or the memory service could not be read");
            apiError(res, 503, "지금 저장소나 메모리 서비스를 읽지 못해 확인을 적용하지 못했습니다. 아무것도 바꾸지 않았습니다. 잠시 후 다시 눌러 주세요.");
            return;
        }
      }
      auditAs(
        req,
        "personal_vault_mirror_confirm",
        `confirmed: the memory service's vault replaces the vault notes of ${repo}${branch ? ` (${branch})` : ""} (${result.removes} repository-only notes will be removed)`,
      );
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
