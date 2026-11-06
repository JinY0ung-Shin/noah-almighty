import { Router } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import { apiError, type RouterDeps } from "./_shared.js";
import {
  applyTeamBrainCard,
  submitTeamBrainProposal,
  teamBrainCardView,
  withdrawTeamBrainProposal,
  type TeamBrainActionDeps,
  type TeamBrainActionResult,
} from "../teamBrainActions.js";
import { countTeamNotes, readTeamNote, teamBrainGraph, validateTeamNotePath } from "../teamBrain.js";
import { readTeamBrainBackupState } from "../teamBrainBackup.js";
import { isVaultNotePath } from "../knowledgeGraph.js";
import type { TeamBrainStatus } from "../../shared/teamBrain.js";

// Team brain HTTP surface (docs/architecture/team-brain.md). Every write here is
// a HUMAN press on a chat card the avatar drafted; the actions module re-checks
// the presser, the row status (compare-and-set) and the note (stale) live.
// Reads: any signed-in (= approved) teammate. Errors are Korean (apiError).

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

  router.get("/api/team-brain/status", (req: AuthenticatedRequest, res) => {
    store.expireTeamBrainDrafts();
    const status: TeamBrainStatus = {
      unseenResults: store.countUnseenTeamBrainResults(req.user!.id),
      pendingReview: store.isActiveAdmin(req.user!.id) ? store.countPendingTeamBrainProposals() : 0,
    };
    res.json(status);
  });

  // My own proposals (the read-only 내 제안 list the badge opens). Opening it marks results seen.
  router.get("/api/team-brain/proposals/mine", (req: AuthenticatedRequest, res) => {
    const proposals = store.listTeamBrainProposals({ kind: "propose", proposerUserId: req.user!.id, limit: 50 });
    store.markTeamBrainResultsSeen(req.user!.id);
    res.json({ proposals: proposals.map(({ content: _content, ...rest }) => rest) });
  });

  // Admins: the pending queue, READ-only (decisions go through the avatar + a card).
  router.get("/api/team-brain/proposals/pending", (req: AuthenticatedRequest, res) => {
    if (!store.isActiveAdmin(req.user!.id)) {
      apiError(res, 403, "관리자만 볼 수 있습니다.");
      return;
    }
    const proposals = store.listTeamBrainProposals({ kind: "propose", statuses: ["pending"], limit: 100 });
    res.json({ proposals: proposals.map(({ content: _content, ...rest }) => rest) });
  });

  router.get("/api/team-brain/cards/:id", async (req: AuthenticatedRequest, res) => {
    const view = await teamBrainCardView(actionDeps(req), req.user!.id, String(req.params.id));
    if (!view) {
      apiError(res, 404, "카드를 찾을 수 없습니다.");
      return;
    }
    res.json(view);
  });

  router.post("/api/team-brain/cards/:id/submit", async (req: AuthenticatedRequest, res) => {
    respond(res, await submitTeamBrainProposal(actionDeps(req), actor(req), String(req.params.id)));
  });

  router.post("/api/team-brain/cards/:id/withdraw", async (req: AuthenticatedRequest, res) => {
    respond(res, await withdrawTeamBrainProposal(actionDeps(req), actor(req), String(req.params.id)));
  });

  router.post("/api/team-brain/cards/:id/apply", async (req: AuthenticatedRequest, res) => {
    respond(res, await applyTeamBrainCard(actionDeps(req), actor(req), String(req.params.id)));
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
    const raw = typeof req.query.path === "string" ? req.query.path : "";
    const checked = validateTeamNotePath(raw);
    // The structural index is readable too (graph content panel parity).
    const notePath = checked.ok ? checked.path : raw === "wiki/index.md" ? raw : null;
    if (!notePath || !isVaultNotePath(notePath)) {
      apiError(res, 400, "잘못된 노트 경로입니다.");
      return;
    }
    const content = await readTeamNote(config, notePath).catch(() => null);
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
    res.json({
      noteCount: await countTeamNotes(config),
      pendingReview: store.countPendingTeamBrainProposals(),
      backup: backup ? backup.state() : readTeamBrainBackupState(store),
      githubHost: config.githubHost,
    });
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
