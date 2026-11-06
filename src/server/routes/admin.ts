import fs from "node:fs";
import path from "node:path";
import { Router, type Response } from "express";
import { requireAdmin, requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { knowledgeClonePath } from "../knowledgeRepo.js";
import { sanitizeName } from "../marketplace.js";
import { deleteConversationWorkspaceCopies, workspaceDirFor } from "../workspace.js";
import { deletePiUserWorkspace } from "../agent/pi/piWorkspace.js";
import { piRepoCopyStateDir } from "../agent/pi/piRepoCopy.js";
import { knownHostsPath } from "../sshTrust.js";
import { deleteConversationImages } from "../chatImages.js";
import { deleteConversationFiles } from "../chatFiles.js";
import { HEX_SSH_TOOL_INFOS, parseHexSshToolPolicy } from "../hexSshPolicy.js";
import { TOGGLABLE_BUILTIN_TOOLS, parseToolSkillPolicy } from "../toolSkillPolicy.js";
import {
  isMcpToolGroupId,
  normalizeMcpToolGroups,
  type McpToolGroupId,
} from "../../shared/mcpToolGroups.js";
import { listPluginRootSkills } from "../agent/skillCatalog.js";
import { loadDefaultPluginRoots } from "../plugins.js";
import { piServicesFor } from "../agent/pi/piRuntime.js";
import { normalizeSkillSlug } from "../skillTransfer.js";
import {
  apiError,
  avatarDir,
  isAvatarVisibility,
  safeString,
  MIN_PASSWORD_LENGTH,
  type RouterDeps,
} from "./_shared.js";
import { registerAdminEgressRoutes } from "./adminEgress.js";

// ---- Admin -----------------------------------------------------------
export function createAdminRouter(deps: RouterDeps): Router {
  const { config, store, observedModel, auditAs } = deps;
  const router = Router();

  registerAdminEgressRoutes(router, deps);

  // System/runtime info: the runtime, the models pi-gateway offers (its live
  // list), the model the last run reported (observed), and the policy catalogs.
  // Read-only; admin-gated.
  router.get("/api/admin/system", requireAuth(store), requireAdmin, async (_req, res) => {
    // Global skill list for the tool/skill policy card: the bundled
    // default-skills root, read from disk (cheap: SKILL.md frontmatter only).
    // A root that cannot be loaded lists nothing — the admin can still type a
    // skill name into the free-form input.
    let rootPaths: string[] = [];
    try {
      rootPaths = (await loadDefaultPluginRoots(config)).map((root) => root.path);
    } catch (error) {
      logger.warn({ err: error }, "default plugin roots could not be listed for the skill policy");
    }
    const skillDiscovery = { fetchedAt: new Date().toISOString(), skills: listPluginRootSkills(rootPaths) };
    // pi-gateway's live model list (cached, stale-on-error); empty on the
    // `local` stub and while pi has never answered. READ-ONLY here: the default
    // model, each model's image input and efforts are set on pi-gateway's admin
    // LLM page (Noah's model override and vision policy are retired).
    const piModels = await piServicesFor(store, config).models.list();
    res.json({
      system: {
        agentRuntime: config.agentRuntime,
        piModels,
        observedModel: observedModel.get(),
        confluenceConfigured: Boolean(config.confluenceUrl),
        hexSshTools: HEX_SSH_TOOL_INFOS,
        hexSshToolPolicy: store.getHexSshToolPolicy(),
        // Admin-managed built-in tool/skill on-off policy + the catalogs the
        // panel renders it against.
        toolSkillPolicy: store.getToolSkillPolicy(),
        togglableBuiltinTools: TOGGLABLE_BUILTIN_TOOLS,
        skillDiscovery,
        // Self-service signup gating, admin-managed (see PUT /api/admin/signup-mode).
        signupMode: store.getSignupMode(),
      },
    });
  });

  router.put("/api/admin/hex-ssh-policy", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const policy = parseHexSshToolPolicy(req.body?.policy);
    if (!policy) {
      apiError(res, 400, "hex-ssh 정책 형식이 올바르지 않습니다.");
      return;
    }
    const saved = store.setHexSshToolPolicy(policy);
    auditAs(
      req,
      "set_hex_ssh_policy",
      `owner=${saved.owner.length}, trusted=${saved.trusted.length}, colleague=${saved.colleague.length}`,
    );
    logger.warn({ actorId: req.user!.id, policy: saved }, "hex-ssh tool policy changed");
    res.json({ policy: saved });
  });

  router.put("/api/admin/tool-skill-policy", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const policy = parseToolSkillPolicy(req.body?.policy);
    if (!policy) {
      apiError(res, 400, "도구/스킬 정책 형식이 올바르지 않습니다.");
      return;
    }
    const saved = store.setToolSkillPolicy(policy);
    auditAs(
      req,
      "set_tool_skill_policy",
      `disabledTools=${saved.disabledTools.length}, disabledSkills=${saved.disabledSkills.length}`,
    );
    logger.warn({ actorId: req.user!.id, policy: saved }, "builtin tool/skill policy changed");
    res.json({ policy: saved });
  });

  router.get("/api/admin/stats", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ stats: store.adminStats() });
  });

  // Live presence for the rail badge. Polled from every admin's open tab, so it
  // stays ONE users scan with no per-user subqueries — unlike /stats, which is
  // fine to keep heavy because only the admin view asks for it.
  router.get("/api/admin/presence", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ presence: store.adminPresence() });
  });

  router.get("/api/admin/users", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ users: store.listUsers() });
  });

  router.get("/api/admin/users/:id", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const detail = store.adminUserDetail(req.params.id);
    if (!detail) {
      apiError(res, 404, "사용자를 찾을 수 없습니다.");
      return;
    }
    res.json({ user: detail });
  });

  router.delete(
    "/api/admin/users/:id",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (req.params.id === req.user!.id) {
        apiError(res, 400, "자기 자신은 삭제할 수 없습니다.");
        return;
      }
      if (store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
        apiError(res, 400, "마지막 관리자 계정은 삭제할 수 없습니다.");
        return;
      }
      // Snapshot conversation ids BEFORE the row cascade: the per-conversation
      // chat-image/file dirs are keyed by these ids, and deleteUser erases the
      // rows we'd need to find them. Two directions — conversations the user
      // OWNS plus colleague-owned threads TARGETING this avatar (deleteUser
      // removes both, so both sets of media dirs must be swept).
      const conversationIds = Array.from(
        new Set([
          ...store
            .listConversations(req.params.id, undefined, "all")
            .map((conversation) => conversation.id),
          ...store.listConversationIdsForAvatar(req.params.id),
        ]),
      );
      const removed = store.deleteUser(req.params.id);
      if (!removed) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      auditAs(req, "delete_user", `deleted user ${req.params.id}`);
      logger.warn({ actorId: req.user!.id, targetId: req.params.id }, "user deleted");
      // Best-effort on-disk cleanup (the DB rows are already gone). Never throw:
      // a cleanup failure must not turn a successful deletion into a 500. The
      // knowledge clone is a full copy of a possibly-private repo, so removing it
      // matters most; also drop the user's plugin clones (same private-repo
      // class), workspace trees, ssh trust dir, avatar image, and the
      // per-conversation chat image/file stores. (store-03)
      try {
        fs.rmSync(knowledgeClonePath(req.params.id, config), { recursive: true, force: true });
        // dataDir/plugins/<userId>/… — full working trees of possibly-private repos.
        fs.rmSync(path.join(config.dataDir, "plugins", sanitizeName(req.params.id)), {
          recursive: true,
          force: true,
        });
        // dataDir/workspaces/<avatarSeg>/… — per-conversation scratch workspaces
        // (dirname of any conversation's dir is the avatar-level parent).
        fs.rmSync(path.dirname(workspaceDirFor(config, req.params.id, "x")), {
          recursive: true,
          force: true,
        });
        fs.rmSync(path.dirname(knownHostsPath(req.params.id, config)), { recursive: true, force: true });
        // pi runtime: the user's whole sandbox workspace (<PI_WORKSPACES_DIR>/u-<key>,
        // their /workspace — conversation folders, skill and repo copies) and
        // Noah's records of their repo copies.
        deletePiUserWorkspace(config, req.params.id);
        fs.rmSync(piRepoCopyStateDir(config, req.params.id), { recursive: true, force: true });
        const avatarsDir = avatarDir(config);
        if (fs.existsSync(avatarsDir)) {
          for (const f of fs.readdirSync(avatarsDir)) {
            if (f === req.params.id || f.startsWith(`${req.params.id}.`)) {
              fs.rmSync(path.join(avatarsDir, f), { force: true });
            }
          }
        }
        for (const conversationId of conversationIds) {
          deleteConversationImages(config, conversationId);
          deleteConversationFiles(config, conversationId);
        }
        // The server-written copies (attachments/captures/confluence) in each
        // deleted conversation's scratch workspace. This user's own avatar tree
        // is already gone above, but their threads with OTHER avatars live
        // under those avatars' trees — resolved by conversation id.
        deleteConversationWorkspaceCopies(config, conversationIds);
      } catch (err) {
        logger.warn({ err, targetId: req.params.id }, "post-delete disk cleanup failed");
      }
      res.json({ ok: true });
    },
  );

  router.post(
    "/api/admin/users/:id/roles",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const role = safeString(req.body?.role);
      const grant = req.body?.grant === true;
      if (role !== "admin" && role !== "member") {
        apiError(res, 400, "role은 'admin' 또는 'member' 여야 합니다.");
        return;
      }
      // Don't let an admin strip the last admin (or themselves) out of the role —
      // that would lock everyone out of the admin panel.
      if (role === "admin" && !grant) {
        if (req.params.id === req.user!.id) {
          apiError(res, 400, "자기 자신의 관리자 권한은 해제할 수 없습니다.");
          return;
        }
        if (store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
          apiError(res, 400, "마지막 관리자의 권한은 해제할 수 없습니다.");
          return;
        }
      }
      const user = store.setRole(req.params.id, role, grant);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      auditAs(req, "set_role", `${grant ? "grant" : "revoke"} ${role} for ${req.params.id}`);
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, role, grant }, "role changed");
      res.json({ user });
    },
  );

  // Admin password reset. Also force-logs-out the target so the old password's
  // sessions can't linger. The actor's own sessions are untouched.
  router.post(
    "/api/admin/users/:id/password",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (password.length < MIN_PASSWORD_LENGTH) {
        apiError(res, 400, "비밀번호는 8자 이상이어야 합니다.");
        return;
      }
      if (!store.setPassword(req.params.id, password)) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      const revoked = store.revokeAllSessions(req.params.id);
      auditAs(req, "reset_password", `reset password for ${req.params.id} (revoked ${revoked} sessions)`);
      logger.warn({ actorId: req.user!.id, targetId: req.params.id }, "admin reset password");
      res.json({ ok: true });
    },
  );

  // Suspend / un-suspend (activate) an account. Suspending kills its sessions.
  router.post(
    "/api/admin/users/:id/suspend",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const suspended = req.body?.suspended === true;
      if (suspended && req.params.id === req.user!.id) {
        apiError(res, 400, "자기 자신은 정지할 수 없습니다.");
        return;
      }
      if (suspended && store.isAdmin(req.params.id) && store.countAdmins() <= 1) {
        apiError(res, 400, "마지막 관리자 계정은 정지할 수 없습니다.");
        return;
      }
      const user = store.setSuspended(req.params.id, suspended);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      auditAs(
        req,
        suspended ? "suspend_user" : "activate_user",
        `${suspended ? "suspended" : "activated"} ${req.params.id}`,
      );
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, suspended }, "suspension changed");
      res.json({ user });
    },
  );

  // Force-logout: revoke every active session for a user without changing anything else.
  router.post(
    "/api/admin/users/:id/logout",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (!store.getUserById(req.params.id)) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      const revoked = store.revokeAllSessions(req.params.id);
      auditAs(req, "force_logout", `revoked ${revoked} sessions for ${req.params.id}`);
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, revoked }, "force logout");
      res.json({ ok: true, revoked });
    },
  );

  // Admin override of an avatar's visibility (content moderation): force it to
  // group (팀 공개) / private regardless of the owner's own setting (the legacy `public`
  // state is retired — isAvatarVisibility rejects it).
  router.put(
    "/api/admin/users/:id/visibility",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      if (!isAvatarVisibility(req.body?.visibility)) {
        apiError(res, 400, "공개 범위 값이 올바르지 않습니다.");
        return;
      }
      const visibility = req.body.visibility;
      const user = store.setVisibilityByAdmin(req.params.id, visibility);
      if (!user) {
        apiError(res, 404, "사용자를 찾을 수 없습니다.");
        return;
      }
      auditAs(req, "set_avatar_visibility", `set avatar ${req.params.id} visibility=${visibility}`);
      logger.warn({ actorId: req.user!.id, targetId: req.params.id, visibility }, "admin set visibility");
      res.json({ user });
    },
  );

  // ---- Admin: MCP tool policy ------------------------------------------
  // SYSTEM-ADMIN-ONLY, deployment-wide (single team, 2026-11-06 — replaced the
  // per-group policies): which MCP tool groups every user may use in chats
  // they drive. The composer disables the rest and every run is clamped
  // server-side (runCapabilities via allowedMcpToolGroupsForUser). Body
  // `{ allowedMcpToolGroups: string[] | null }` — null clears the policy, []
  // blocks every optional MCP tool group (`system` always stays). Unknown ids
  // are rejected (not silently dropped) so an admin typo can't change the
  // policy's meaning.
  router.get("/api/admin/tool-policy", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({ allowedMcpToolGroups: store.getMcpToolPolicy() });
  });

  router.put("/api/admin/tool-policy", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const raw = req.body?.allowedMcpToolGroups;
    let allowed: McpToolGroupId[] | null;
    if (raw === null) {
      allowed = null;
    } else if (Array.isArray(raw) && raw.every((v) => isMcpToolGroupId(v))) {
      allowed = normalizeMcpToolGroups(raw);
    } else {
      apiError(res, 400, "allowedMcpToolGroups는 MCP 도구 묶음 id 배열이거나 null이어야 합니다.");
      return;
    }
    const saved = store.setMcpToolPolicy(allowed);
    const summary = saved === null ? "(제한 없음)" : saved.length ? saved.join(",") : "(모두 차단)";
    auditAs(req, "set_tool_policy", `MCP 도구 정책 = ${summary}`);
    logger.warn({ actorId: req.user!.id, allowed: saved }, "admin MCP tool policy changed");
    res.json({ allowedMcpToolGroups: saved });
  });

  // ---- Admin: shared-skill moderation -----------------------------------
  // The system admin may take any user's shared skill out of the team's
  // discovery. The block is keyed by (owner, skill NAME) — not the share-row
  // id, so an unshare→re-share can't evade it — avatar visibility is
  // untouched, and copies already learned stay in their learners' repos.
  // Enforcement is in the store's learnable queries (store/avatars.ts
  // LEARNABLE_SKILLS_FROM), so the feed, the preview/learn single-row lookups,
  // the MCP find tool, and the metacognition count all follow from one predicate.

  // Every active user's share with its 전수 count + blocked flag, plus the
  // blocks no active listing carries (`otherBlocks`: a suspended owner, an
  // unshared skill) so every block stays visible — and liftable.
  router.get("/api/admin/shared-skills", requireAuth(store), requireAdmin, (_req, res) => {
    res.json({
      skills: store.listSharedSkillsForModeration(),
      otherBlocks: store.listOtherSharedSkillBlocks(),
    });
  });

  /**
   * (ownerUserId, skillName) decode shared by the two block endpoints. The
   * owner must be an existing user. Responds and returns null on any failure.
   */
  const blockTarget = (
    res: Response,
    ownerUserIdRaw: unknown,
    skillNameRaw: unknown,
  ): { ownerUserId: string; skillName: string; ownerLabel: string } | null => {
    const ownerUserId = safeString(ownerUserIdRaw);
    const skillName = safeString(skillNameRaw);
    if (!ownerUserId || !skillName || normalizeSkillSlug(skillName) !== skillName) {
      apiError(res, 400, "ownerUserId와 스킬 이름이 필요합니다.");
      return null;
    }
    const owner = store.getUserById(ownerUserId);
    if (!owner) {
      apiError(res, 404, "사용자를 찾을 수 없습니다.");
      return null;
    }
    return { ownerUserId, skillName, ownerLabel: `@${owner.username}` };
  };

  // Block: idempotent, and deliberately allowed even with no live share row —
  // the key is the skill NAME, so a re-share lands already blocked.
  router.post(
    "/api/admin/shared-skills/blocks",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const target = blockTarget(res, req.body?.ownerUserId, req.body?.skillName);
      if (!target) return;
      store.blockSharedSkill(target.ownerUserId, target.skillName, req.user!.id);
      auditAs(req, "skill_block", `${target.ownerLabel}의 "${target.skillName}" 공유를 팀 전체에서 차단`);
      res.json({ ok: true });
    },
  );

  // Unblock. 404 when it wasn't blocked — no misleading audit row for a no-op.
  router.delete(
    "/api/admin/shared-skills/blocks/:ownerUserId/:skillName",
    requireAuth(store),
    requireAdmin,
    (req: AuthenticatedRequest, res) => {
      const target = blockTarget(res, req.params.ownerUserId, req.params.skillName);
      if (!target) return;
      if (!store.unblockSharedSkill(target.ownerUserId, target.skillName)) {
        apiError(res, 404, "차단된 공유 스킬이 아닙니다.");
        return;
      }
      auditAs(req, "skill_unblock", `${target.ownerLabel}의 "${target.skillName}" 공유 차단을 해제`);
      res.json({ ok: true });
    },
  );

  // Self-service signup gating: approval | closed. The retired `open` mode is
  // rejected: approving a pending signup IS joining the team (and with it
  // trust), so self-service must never skip it.
  router.put("/api/admin/signup-mode", requireAuth(store), requireAdmin, (req: AuthenticatedRequest, res) => {
    const mode = safeString(req.body?.mode);
    if (mode !== "closed" && mode !== "approval") {
      apiError(res, 400, "mode는 'approval' · 'closed' 중 하나여야 합니다.");
      return;
    }
    store.setSignupMode(mode);
    auditAs(req, "set_signup_mode", `signup mode = ${mode}`);
    logger.warn({ actorId: req.user!.id, mode }, "signup mode changed");
    res.json({ signupMode: mode });
  });

  // ---- Audit -----------------------------------------------------------

  router.get("/api/audit", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const isAdmin = req.user!.roles.includes("admin");
    res.json({ audit: store.listAudit(req.user!.id, isAdmin) });
  });

  return router;
}
