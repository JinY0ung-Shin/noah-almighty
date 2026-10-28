import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { inspectRepoContents } from "../plugins.js";
import { scrubGitError } from "../marketplace.js";
import { isInternalGitSource } from "../gitCredentials.js";
import {
  ensureGroupClone,
  groupKnowledgeRepoContextFor,
  type GroupKnowledgeRepoContext,
} from "../groupKnowledgeRepo.js";
import { readFile } from "../knowledgeRepo.js";
import { normalizeSkillSlug } from "../skillTransfer.js";
import { buildKnowledgeGraph, isVaultNotePath } from "../knowledgeGraph.js";
import type { Response } from "express";
import {
  apiError,
  looksLikeRepo,
  respondNoteFsError,
  safeString,
  type RouterDeps,
} from "./_shared.js";

/**
 * ensureGroupClone → inspectRepoContents → res.json, shared by the group repo's
 * GET /contents and POST /refresh (functionally identical bodies; only the
 * Korean catch label differs). User-facing Korean — `errorLabel` carries it.
 */
async function respondRepoContents(
  res: Response,
  ctx: GroupKnowledgeRepoContext,
  errorLabel: string,
): Promise<void> {
  try {
    const repoRoot = await ensureGroupClone(ctx);
    res.json({ contents: await inspectRepoContents(repoRoot) });
  } catch (error) {
    apiError(res, 502, `${errorLabel}: ${scrubGitError(error)}`);
  }
}

// ---- Groups (membership roster + group-admin self-service) -----------
// Members of a group auto-trust each other (store.isTrustedFor) and share one
// knowledge repo only group admins may edit. System admins create groups +
// assign group admins via the admin API; group admins self-serve here.
export function createGroupsRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  const isGroupMember = (userId: string, groupId: string) =>
    store.groupRoleFor(userId, groupId) !== null;
  /** A group admin OR a system admin may manage a group's members/repo. */
  const canManageGroup = (userId: string, groupId: string) =>
    store.isAdmin(userId) || store.isGroupAdmin(userId, groupId);
  /** Any group member OR a system admin may VIEW the group's shared repo. */
  const canViewGroupRepo = (userId: string, groupId: string) =>
    isGroupMember(userId, groupId) || store.isAdmin(userId);

  // The current user's groups, each with its member roster — members discover &
  // chat with teammates' avatars (now auto-trusted via group co-membership).
  router.get("/api/me/groups", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groups = store.listUserGroups(req.user!.id).map((g) => {
      const repo = store.getGroupKnowledgeRepo(g.id);
      return {
        ...g,
        knowledgeRepo: repo.repo,
        knowledgeBranch: repo.branch,
        knowledgeSelected: repo.selected,
        members: store.listGroupMembers(g.id),
      };
    });
    res.json({ groups });
  });

  // Group admin (or system admin) adds a member by username.
  router.post("/api/me/groups/:id/members", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 그룹원을 관리할 권한이 없습니다. (그룹 관리자 전용)");
      return;
    }
    const username = safeString(req.body?.username);
    if (!username) {
      apiError(res, 400, "username이 필요합니다.");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.addGroupMemberByUsername(groupId, username, role);
    if (!member) {
      apiError(res, 404, "해당 사용자를 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "group_member_add", `group=${groupId} +${member.userId} (${role})`);
    res.json({ member });
  });

  // Change a member's role within the group (promote/demote group admin).
  router.patch("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 그룹원을 관리할 권한이 없습니다. (그룹 관리자 전용)");
      return;
    }
    const role = req.body?.role === "admin" ? "admin" : "member";
    const member = store.setGroupMemberRole(groupId, req.params.userId, role);
    if (!member) {
      apiError(res, 404, "그룹원을 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "group_member_role", `group=${groupId} ${req.params.userId} -> ${role}`);
    res.json({ member });
  });

  // Remove a member from the group.
  router.delete("/api/me/groups/:id/members/:userId", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "이 그룹의 그룹원을 관리할 권한이 없습니다. (그룹 관리자 전용)");
      return;
    }
    const removed = store.removeGroupMember(groupId, req.params.userId);
    // 404 (like the PATCH-role sibling) when nothing was removed — don't write a
    // misleading audit row for a no-op, and don't 200 {ok:false}.
    if (!removed) {
      apiError(res, 404, "그룹원을 찾을 수 없습니다.");
      return;
    }
    auditAs(req, "group_member_remove", `group=${groupId} -${req.params.userId}`);
    res.json({ ok: removed });
  });

  // ---- Shared-skill channel moderation (group admin or system admin) ----
  // A group admin may take a member's shared skill out of THEIR group's
  // discovery channel. Scope = the admin's authority, no wider: the block is
  // keyed by (group, owner, skill NAME) — not the share-row id, so an
  // unshare→re-share can't evade it — the skill stays learnable through any
  // OTHER sharing group the two users share, avatar visibility is untouched,
  // and copies already learned stay in their learners' repos. Enforcement is
  // in the store's learnable queries (store/avatars.ts LEARNABLE_SKILLS_FROM),
  // so the feed, the preview/learn single-row lookups, the MCP find tool, and
  // the metacognition count all follow from one predicate.

  // Every member's share with its 전수 count + this group's blocked flag.
  router.get("/api/me/groups/:id/shared-skills", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 그룹의 공유 스킬을 관리할 수 있습니다.");
      return;
    }
    res.json({ skills: store.listGroupSharedSkills(groupId) });
  });

  /**
   * Group + manage gate + (ownerUserId, skillName) decode shared by the two
   * block endpoints. The owner must be a MEMBER of this group — an admin
   * moderates their own channel and nothing beyond it. Responds and returns
   * null on any failure.
   */
  const blockTarget = (
    req: AuthenticatedRequest,
    res: Response,
    ownerUserIdRaw: unknown,
    skillNameRaw: unknown,
  ): { groupId: string; ownerUserId: string; skillName: string; ownerLabel: string } | null => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return null;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 그룹의 공유 스킬을 관리할 수 있습니다.");
      return null;
    }
    const ownerUserId = safeString(ownerUserIdRaw);
    const skillName = safeString(skillNameRaw);
    if (!ownerUserId || !skillName || normalizeSkillSlug(skillName) !== skillName) {
      apiError(res, 400, "ownerUserId와 스킬 이름이 필요합니다.");
      return null;
    }
    if (!store.getGroupMember(groupId, ownerUserId)) {
      apiError(res, 404, "이 그룹의 그룹원이 아닙니다.");
      return null;
    }
    const owner = store.getUserById(ownerUserId);
    return {
      groupId,
      ownerUserId,
      skillName,
      ownerLabel: owner ? `@${owner.username}` : ownerUserId,
    };
  };

  // Block: idempotent, and deliberately allowed even with no live share row —
  // the key is the skill NAME, so a re-share lands already blocked.
  router.post("/api/me/groups/:id/shared-skills/blocks", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const target = blockTarget(req, res, req.body?.ownerUserId, req.body?.skillName);
    if (!target) return;
    store.blockSharedSkillInGroup(
      target.groupId,
      target.ownerUserId,
      target.skillName,
      req.user!.id,
    );
    auditAs(
      req,
      "group_skill_block",
      `group=${target.groupId} ${target.ownerLabel}의 "${target.skillName}" 공유를 그룹 채널에서 차단`,
    );
    res.json({ ok: true });
  });

  // Unblock. 404 when it wasn't blocked (mirrors the member-remove sibling —
  // no misleading audit row for a no-op).
  router.delete(
    "/api/me/groups/:id/shared-skills/blocks/:ownerUserId/:skillName",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const target = blockTarget(req, res, req.params.ownerUserId, req.params.skillName);
      if (!target) return;
      if (
        !store.unblockSharedSkillInGroup(
          target.groupId,
          target.ownerUserId,
          target.skillName,
        )
      ) {
        apiError(res, 404, "이 그룹에서 차단된 공유 스킬이 아닙니다.");
        return;
      }
      auditAs(
        req,
        "group_skill_unblock",
        `group=${target.groupId} ${target.ownerLabel}의 "${target.skillName}" 공유 차단을 그룹 채널에서 해제`,
      );
      res.json({ ok: true });
    },
  );

  // Group policy: avatar sharing (group admin or system admin). Off = this
  // group's co-membership grants neither avatar visibility nor trust/elevation
  // (knowledge-sharing-only group); the shared repo/brain are unaffected.
  router.put("/api/me/groups/:id/avatar-sharing", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 설정할 수 있습니다.");
      return;
    }
    if (typeof req.body?.enabled !== "boolean") {
      apiError(res, 400, "enabled는 boolean이어야 합니다.");
      return;
    }
    const group = store.setGroupAvatarSharing(groupId, req.body.enabled);
    auditAs(req, "group_avatar_sharing", `group=${groupId} enabled=${req.body.enabled}`);
    res.json({ group });
  });

  // Connect/clear the group's shared knowledge repo (group admin only). Validated
  // like the personal repo: a real owner/repo|URL on the internal GitHub host.
  router.put("/api/me/groups/:id/knowledge-repo", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!store.getGroup(groupId)) {
      apiError(res, 404, "그룹을 찾을 수 없습니다.");
      return;
    }
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 공용 지식 저장소를 설정할 수 있습니다.");
      return;
    }
    const repoRaw = req.body?.repo;
    if (repoRaw === null || repoRaw === "") {
      const group = store.setGroupKnowledgeRepo(groupId, null, null);
      // Disconnecting a whole group's shared brain is as audit-worthy as setting it.
      auditAs(req, "group_repo_set", `group=${groupId} repo=(cleared)`);
      res.json({ group });
      return;
    }
    const repo = safeString(repoRaw);
    if (!repo || !looksLikeRepo(repo)) {
      apiError(res, 400, "repo는 owner/repo 또는 git/https URL 형식이어야 합니다.");
      return;
    }
    if (!isInternalGitSource(repo, config.githubHost)) {
      apiError(res, 400, `그룹 지식 저장소는 사내 GitHub host(${config.githubHost})에 있어야 합니다.`);
      return;
    }
    const branch = safeString(req.body?.branch) || null;
    const group = store.setGroupKnowledgeRepo(groupId, repo, branch);
    auditAs(req, "group_repo_set", `group=${groupId} repo=${repo}`);
    res.json({ group });
  });

  // Choose which group-repo plugins members' avatars load; null = load all.
  router.put("/api/me/groups/:id/knowledge-repo/selected", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groupId = req.params.id;
    if (!canManageGroup(req.user!.id, groupId)) {
      apiError(res, 403, "그룹 관리자만 설정할 수 있습니다.");
      return;
    }
    if (!store.getGroupKnowledgeRepo(groupId).repo) {
      apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
      return;
    }
    const raw = req.body?.selected;
    let selected: string[] | null;
    if (raw === null || raw === undefined) {
      selected = null;
    } else if (Array.isArray(raw) && raw.every((s) => typeof s === "string")) {
      selected = raw as string[];
    } else {
      apiError(res, 400, "selected는 문자열 배열이거나 null이어야 합니다.");
      return;
    }
    const group = store.setGroupKnowledgeSelected(groupId, selected);
    auditAs(req, "group_repo_selected", `group=${groupId} selected=${selected ? selected.length : "all"}`);
    res.json({ group });
  });

  // List the group repo's plugins (any member may view). Clones with the viewer's token.
  router.get(
    "/api/me/groups/:id/knowledge-repo/contents",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!canViewGroupRepo(req.user!.id, groupId)) {
        apiError(res, 403, "이 그룹의 그룹원이 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      await respondRepoContents(res, ctx, "저장소를 가져오지 못했습니다");
    },
  );

  // Build the group brain's `[[wikilink]]` graph (any member may view).
  router.get(
    "/api/me/groups/:id/knowledge-repo/graph",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!canViewGroupRepo(req.user!.id, groupId)) {
        apiError(res, 403, "이 그룹의 그룹원이 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        res.json({ graph: await buildKnowledgeGraph(repoRoot) });
      } catch (error) {
        apiError(res, 502, `지식 그래프를 만들지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  // Read one note from the group brain's vault for the graph view's content
  // panel (any member may view). Mirrors the personal note endpoint.
  router.get(
    "/api/me/groups/:id/knowledge-repo/note",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!canViewGroupRepo(req.user!.id, groupId)) {
        apiError(res, 403, "이 그룹의 그룹원이 아닙니다.");
        return;
      }
      const path = req.query.path;
      if (!isVaultNotePath(path)) {
        apiError(res, 400, "유효한 노트 경로가 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      try {
        const repoRoot = await ensureGroupClone(ctx);
        const content = await readFile(repoRoot, path);
        res.json({ note: { path, content } });
      } catch (error) {
        respondNoteFsError(res, error);
      }
    },
  );

  router.post(
    "/api/me/groups/:id/knowledge-repo/refresh",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const groupId = req.params.id;
      if (!canViewGroupRepo(req.user!.id, groupId)) {
        apiError(res, 403, "이 그룹의 그룹원이 아닙니다.");
        return;
      }
      const ctx = groupKnowledgeRepoContextFor(store, groupId, req.user!.id, config);
      if (!ctx) {
        apiError(res, 404, "연결된 그룹 지식 저장소가 없습니다.");
        return;
      }
      await respondRepoContents(res, ctx, "새로고침 실패");
    },
  );

  return router;
}
