import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { normalizeSkillSlug } from "../skillTransfer.js";
import type { Response } from "express";
import {
  apiError,
  safeString,
  type RouterDeps,
} from "./_shared.js";

// ---- Groups (membership roster + group-admin self-service) -----------
// Members of a group auto-trust each other (store.isTrustedFor) and share
// skills (group knowledge repos were retired 2026-10-30). System admins create groups +
// assign group admins via the admin API; group admins self-serve here.
export function createGroupsRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  const isGroupMember = (userId: string, groupId: string) =>
    store.groupRoleFor(userId, groupId) !== null;
  /** A group admin OR a system admin may manage a group's members/policy. */
  const canManageGroup = (userId: string, groupId: string) =>
    store.isAdmin(userId) || store.isGroupAdmin(userId, groupId);

  // The current user's groups, each with its member roster — members discover &
  // chat with teammates' avatars (now auto-trusted via group co-membership).
  router.get("/api/me/groups", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const groups = store.listUserGroups(req.user!.id).map((g) => ({
      ...g,
      members: store.listGroupMembers(g.id),
    }));
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
  // (nor skill sharing, which rides the same relation); its admin tool policy is unaffected.
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

  return router;
}
