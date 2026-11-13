import { Router } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import { apiError, type RouterDeps } from "./_shared.js";
import {
  cancelTeamBrainCard,
  editTeamBrainProvenance,
  pressTeamBrainCard,
  teamBrainCardView,
  type TeamBrainActionDeps,
  type TeamBrainActionResult,
} from "../teamBrainActions.js";
import {
  countTeamNotes,
  normalizeTeamVaultPath,
  readTeamPolicy,
  readTeamVaultFile,
  teamBrainCounts,
  teamBrainGraph,
  teamBrainInitialized,
  teamPolicyHistory,
} from "../teamBrain.js";
import { teamPolicyProblemLabel } from "../teamBrainPolicy.js";
import { readTeamBrainBackupState } from "../teamBrainBackup.js";
import type { TeamPolicyView } from "../../shared/teamBrain.js";

// Team brain HTTP surface (docs/architecture/team-brain.md). Every write here is
// a HUMAN press on a chat card the avatar drafted; the actions module re-checks
// the presser, the row status (compare-and-set) and the note (stale) live.
// Reads: any signed-in (= approved) teammate. Errors are Korean (apiError).
//
// Retired with the review queue (2026-11-13) and reserved forever — never mount
// them again: GET /api/team-brain/status, /proposals/mine, /proposals/pending,
// POST /api/team-brain/cards/:id/submit, …/submit-all, …/withdraw.

export function createTeamBrainRouter(deps: RouterDeps): Router {
  const { store, config } = deps;
  const router = Router();
  router.use("/api/team-brain", requireAuth(store));

  const actionDeps = (req: AuthenticatedRequest): TeamBrainActionDeps => ({
    store,
    config,
    onCommitted: () => deps.services.teamBrainBackup?.schedule(),
    audit: (action, detail, status) => deps.auditAs(req, action, detail, status),
  });
  const actor = (req: AuthenticatedRequest) => ({
    id: req.user!.id,
    username: req.user!.username,
    displayName: req.user!.displayName,
  });
  const respond = (res: import("express").Response, result: TeamBrainActionResult) => {
    if (!result.ok) {
      apiError(res, result.status, result.message);
      return;
    }
    res.json(result.view);
  };

  router.get("/api/team-brain/cards/:id", async (req: AuthenticatedRequest, res) => {
    const view = await teamBrainCardView(actionDeps(req), req.user!.id, String(req.params.id));
    if (!view) {
      apiError(res, 404, "카드를 찾을 수 없습니다.");
      return;
    }
    res.json(view);
  });

  // The drafter's 출처 정보 edit on their own draft card (body: TeamProvenanceInput).
  router.put("/api/team-brain/cards/:id/provenance", async (req: AuthenticatedRequest, res) => {
    respond(res, await editTeamBrainProvenance(actionDeps(req), actor(req), String(req.params.id), req.body));
  });

  // 취소: the drafter takes a draft card back (never reported to the avatar).
  router.post("/api/team-brain/cards/:id/cancel", async (req: AuthenticatedRequest, res) => {
    respond(res, await cancelTeamBrainCard(actionDeps(req), actor(req), String(req.params.id)));
  });

  // The confirm button (팀 브레인에 반영 / 팀 정책 반영) goes through pressTeamBrainCard:
  // the action, plus the report the presser's chat hands to the avatar at once
  // (teamBrainCardPress.ts).
  router.post("/api/team-brain/cards/:id/apply", async (req: AuthenticatedRequest, res) => {
    respond(res, await pressTeamBrainCard(actionDeps(req), actor(req), String(req.params.id), "apply"));
  });

  // The knowledge-graph 팀 브레인 tab (read-only).
  router.get("/api/team-brain/graph", async (_req, res) => {
    try {
      // Same shape as the personal graph route ({graph}), so BrainView reads both alike.
      res.json({ graph: await teamBrainGraph(config) });
    } catch {
      apiError(res, 500, "팀 브레인 그래프를 만들지 못했습니다.");
    }
  });

  router.get("/api/team-brain/note", async (req, res) => {
    // SCHEMA.md, wiki pages (incl. the generated index/log) and raw sources.
    const notePath = normalizeTeamVaultPath(typeof req.query.path === "string" ? req.query.path : "");
    if (!notePath) {
      apiError(res, 400, "잘못된 노트 경로입니다.");
      return;
    }
    const content = await readTeamVaultFile(config, notePath).catch(() => null);
    if (content === null) {
      apiError(res, 404, "노트를 찾을 수 없습니다.");
      return;
    }
    res.json({ note: { path: notePath, content } });
  });

  // ---- Admin: the push-only backup mirror (teamBrainBackup.ts) ----------------
  router.use("/api/admin/team-brain", requireAuth(store), requireAdmin);

  router.get("/api/admin/team-brain", async (_req, res) => {
    const backup = deps.services.teamBrainBackup;
    const counts = await teamBrainCounts(config);
    res.json({
      noteCount: counts.pages,
      rawSources: counts.rawSources,
      uncompiledSources: counts.uncompiledSources,
      backup: backup ? backup.state() : readTeamBrainBackupState(store),
      githubHost: config.githubHost,
    });
  });

  // The team policy (POLICY.md), READ-only: changes go through an admin's card.
  router.get("/api/admin/team-brain/policy", async (_req, res) => {
    try {
      const exists = teamBrainInitialized(config) && (await readTeamVaultFile(config, "POLICY.md")) !== null;
      const policy = await readTeamPolicy(config);
      const view: TeamPolicyView = {
        knobs: policy.knobs,
        guidelines: policy.guidelines,
        exists,
        problems: policy.problems.map(teamPolicyProblemLabel),
        history: await teamPolicyHistory(config),
      };
      res.json({ policy: view });
    } catch {
      apiError(res, 500, "팀 정책을 읽지 못했습니다.");
    }
  });

  // Saving binds the mirror to THIS admin's git token from now on.
  router.put("/api/admin/team-brain/backup", (req: AuthenticatedRequest, res) => {
    const backup = deps.services.teamBrainBackup;
    if (!backup) {
      apiError(res, 503, "백업 기능을 사용할 수 없습니다.");
      return;
    }
    const url = typeof req.body?.url === "string" ? req.body.url : req.body?.url === null ? null : undefined;
    if (url === undefined) {
      apiError(res, 400, "url이 필요합니다.");
      return;
    }
    const branch = typeof req.body?.branch === "string" ? req.body.branch : null;
    const result = backup.configure(url, branch, req.user!.id);
    if (!result.ok) {
      apiError(res, 400, result.message);
      return;
    }
    deps.auditAs(req, "team_brain_backup_config", url ? `${url.trim()} @ ${branch?.trim() || "main"}` : "cleared");
    res.json({ backup: backup.state() });
  });

  router.post("/api/admin/team-brain/backup/push", async (req: AuthenticatedRequest, res) => {
    const backup = deps.services.teamBrainBackup;
    if (!backup) {
      apiError(res, 503, "백업 기능을 사용할 수 없습니다.");
      return;
    }
    const result = await backup.pushNow();
    deps.auditAs(req, "team_brain_backup", result.ok ? "pushed" : result.message, result.ok ? "success" : "error");
    if (!result.ok) {
      apiError(res, 502, result.message);
      return;
    }
    res.json({ backup: backup.state() });
  });

  router.post("/api/admin/team-brain/backup/restore", async (req: AuthenticatedRequest, res) => {
    const backup = deps.services.teamBrainBackup;
    if (!backup) {
      apiError(res, 503, "백업 기능을 사용할 수 없습니다.");
      return;
    }
    const result = await backup.restore();
    deps.auditAs(req, "team_brain_restore", result.ok ? "restored" : result.message, result.ok ? "success" : "error");
    if (!result.ok) {
      apiError(res, 409, result.message);
      return;
    }
    res.json({ backup: backup.state(), noteCount: await countTeamNotes(config) });
  });

  return router;
}
