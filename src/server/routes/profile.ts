import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import { listSkillsInRoots } from "../plugins.js";
import { normalizeHashtags } from "../store.js";
import { isModelTier } from "../modelTiers.js";
import { isEffortLevel } from "../effortLevels.js";
import {
  type McpToolGroupId,
  normalizeMcpToolGroups,
} from "../../shared/mcpToolGroups.js";
import type { AvatarVisibility } from "../types.js";
import {
  apiError,
  avatarDir,
  decodeAvatarImage,
  deleteAvatarImageFile,
  describeAvatarEquipment,
  isAvatarVisibility,
  resolveAvatarSkillSources,
  runHeadlessAvatarPrompt,
  safeString,
  saveAvatarImageFile,
  EXT_MIME,
  type RouterDeps,
} from "./_shared.js";

// ---- Profile ---------------------------------------------------------
export function createProfileRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  router.patch(
    "/api/me",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const patch: {
        displayName?: string;
        alias?: string;
        bio?: string;
        persona?: string;
        intro?: string;
        hashtags?: string[];
        visibility?: AvatarVisibility;
        experimentalFeatures?: string[];
        sharedAccount?: boolean;
      } = {};
      if (typeof req.body?.displayName === "string")
        patch.displayName = req.body.displayName;
      if (typeof req.body?.alias === "string") patch.alias = req.body.alias;
      if (typeof req.body?.bio === "string") patch.bio = req.body.bio;
      if (typeof req.body?.persona === "string")
        patch.persona = req.body.persona;
      if (typeof req.body?.intro === "string") patch.intro = req.body.intro;
      // Accept an array of tag strings; updateProfile normalizes/caps it.
      if (Array.isArray(req.body?.hashtags)) {
        patch.hashtags = req.body.hashtags.filter(
          (t: unknown): t is string => typeof t === "string",
        );
      }
      if (isAvatarVisibility(req.body?.visibility))
        patch.visibility = req.body.visibility;
      // Experimental-feature toggles: an array of registry keys; updateProfile
      // normalizes to known keys only. (#50)
      if (Array.isArray(req.body?.experimentalFeatures)) {
        patch.experimentalFeatures = req.body.experimentalFeatures.filter(
          (k: unknown): k is string => typeof k === "string",
        );
      }
      // Shared (communal) account: opens the owner's knowledge-repo WRITE tools
      // to trusted same-group teammates. Self-service is safe — the flag only
      // widens access to the caller's OWN repo, never grants the caller anything.
      if (typeof req.body?.sharedAccount === "boolean")
        patch.sharedAccount = req.body.sharedAccount;
      const user = store.updateProfile(req.user!.id, patch);
      // Audit the two security-relevant grants (visible in /api/audit, not just
      // the pino log): who is reachable, and who gains write access via a shared
      // account. Names/values only — never secrets.
      if (patch.visibility !== undefined) {
        auditAs(req, "set_avatar_visibility", `set own visibility to ${patch.visibility}`);
      }
      if (patch.sharedAccount !== undefined) {
        auditAs(req, "set_shared_account", `${patch.sharedAccount ? "enabled" : "disabled"} shared account`);
      }
      res.json({ user });
    },
  );

  // Mark first-run onboarding as seen. Server-persisted (not localStorage) so the
  // welcome modal shows ONCE per account — across devices, surviving a cleared
  // browser store. Idempotent: re-posting keeps the original timestamp.
  router.post(
    "/api/me/onboarded",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const user = store.markOnboarded(req.user!.id);
      res.json({ user });
    },
  );

  // Mark the current release-notes entry (releaseNotes.ts) as seen — the client
  // posts this when the one-time "새로운 기능" (what's new) dialog is dismissed.
  // No body: the server stamps ITS current release id, so a stale client bundle
  // can neither skip ahead nor store an arbitrary value.
  router.post(
    "/api/me/release-seen",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const user = store.markReleaseSeen(req.user!.id);
      res.json({ user });
    },
  );

  // Owner's DEFAULT group-knowledge OFF-set (group ids turned off). The composer
  // toggle writes here so the choice seeds every NEW conversation — the
  // per-conversation value (chat POST `groupKnowledgeOff`) still overrides it for
  // an already-started conversation. Body: `{ off: string[] }` ([] re-enables all).
  router.put(
    "/api/me/group-knowledge-default",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const raw = req.body?.off;
      if (!Array.isArray(raw) || !raw.every((s) => typeof s === "string")) {
        apiError(res, 400, "off는 문자열 배열이어야 합니다.");
        return;
      }
      const user = store.setGroupKnowledgeOffDefault(
        req.user!.id,
        raw as string[],
      );
      res.json({ user });
    },
  );

  // Owner's remembered chat-composer defaults (model tier / reasoning effort / MCP
  // tool groups). The composer pickers write here so each choice seeds the NEXT new
  // conversation — the per-conversation `selected_*` value (chat POST) still
  // overrides it for an already-started conversation. Each field is optional: omit
  // to leave untouched, send null/"" to clear back to the default. Body:
  // `{ model?: string|null, effort?: string|null, mcpToolGroups?: string[]|null }`.
  router.put(
    "/api/me/chat-defaults",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const patch: {
        model?: string | null;
        effort?: string | null;
        mcpToolGroups?: McpToolGroupId[] | null;
      } = {};
      if (req.body?.model !== undefined) {
        const raw = req.body.model;
        if (raw === null || raw === "") patch.model = null;
        else if (isModelTier(raw)) patch.model = raw;
        else {
          apiError(res, 400, "알 수 없는 모델입니다.");
          return;
        }
      }
      if (req.body?.effort !== undefined) {
        const raw = req.body.effort;
        if (raw === null || raw === "") patch.effort = null;
        else if (isEffortLevel(raw)) patch.effort = raw;
        else {
          apiError(res, 400, "알 수 없는 사고 강도입니다.");
          return;
        }
      }
      if (req.body?.mcpToolGroups !== undefined) {
        const raw = req.body.mcpToolGroups;
        if (raw === null) patch.mcpToolGroups = null;
        else if (Array.isArray(raw))
          patch.mcpToolGroups = normalizeMcpToolGroups(raw);
        else {
          apiError(res, 400, "MCP 도구 설정이 올바르지 않습니다.");
          return;
        }
      }
      const user = store.setChatDefaults(req.user!.id, patch);
      res.json({ user });
    },
  );

  // Typeahead for the group member-add picker: match by username OR display name.
  // Excludes self. Used by the group management UIs (managing group membership is
  // how trust/elevation is granted — see Store.isTrustedFor).
  router.get(
    "/api/me/users/search",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const q = safeString(req.query?.q);
      res.json({ users: q ? store.searchUsers(q, req.user!.id) : [] });
    },
  );

  // One intro/hashtags generation per user at a time: each spawns a ~2-minute
  // SDK subprocess and they share one workspace dir (workspaceDirFor(…, "intro"/
  // "hashtags")), so concurrent runs would stomp each other AND let one user fan
  // out unbounded subprocesses. A per-user in-flight set gates re-entry with 409.
  const generateInFlight = new Set<string>();

  // Generate a first-person self-introduction for the owner's avatar. The
  // avatar inspects its own persona + skills and writes a short blurb the owner
  // then reviews/edits before saving (this endpoint does NOT persist it). Runs
  // headless and read-only, like a routine — no human is mid-conversation.
  router.post(
    "/api/me/intro/generate",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
      if (!avatar) {
        apiError(res, 404, "아바타를 찾을 수 없습니다.");
        return;
      }

      // The local runtime loads no plugins and can't introspect skills; return a
      // deterministic placeholder so the feature still works offline/in tests.
      if (config.agentRuntime === "local") {
        const name = avatar.alias || avatar.displayName;
        res.json({
          intro: `안녕하세요, ${name}입니다. 무엇이든 편하게 물어보세요.`,
        });
        return;
      }

      if (generateInFlight.has(req.user!.id)) {
        apiError(res, 409, "이미 생성 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      generateInFlight.add(req.user!.id);
      try {
      // Resolve plugin roots and their skills exactly like the skills endpoint,
      // so the intro reflects what the avatar can actually do. (resolveAvatarSkillSources
      // /listSkillsInRoots can throw — e.g. an unguarded fs write in plugin-root
      // resolution — so the whole body is wrapped; an unhandled async throw would
      // otherwise hang the request until the client's timeout in Express 4.)
      const { sourced, enabledPlugins, pluginRoots } =
        await resolveAvatarSkillSources(store, avatar, config, true);
      const skills = await listSkillsInRoots(sourced);

      // Describe the avatar's equipment so it can ground the intro in reality
      // rather than inventing capabilities.
      const message =
        "You are writing a short self-introduction. It is the intro a conversation partner (a colleague) will read before they start talking to you.\n\n" +
        "Based on the information below, write the introduction in the first person, centered on 'what you can help with'. " +
        "Ground concrete capabilities in the skills and tools you have, but do not exaggerate.\n\n" +
        "**Write the introduction in Korean.** Output in Markdown. Start with a short one- or two-sentence greeting paragraph, then " +
        "organize your main capabilities as a bullet list (`- `). Write each bullet as a single line about 'what you can help with', " +
        "and use bold (`**`) to emphasize key keywords where helpful. Do not use Markdown headings (`#`), code blocks, or wrapping quotes — " +
        "output only the introduction body.\n\n" +
        describeAvatarEquipment(skills, enabledPlugins, avatar.persona);

      const result = await runHeadlessAvatarPrompt(
        store,
        config,
        avatar,
        "intro",
        message,
        pluginRoots,
        "intro generation failed",
        req.user!.id,
      );
      if (!result.ok) {
        apiError(res, 502, "소개글 생성 중 오류가 발생했습니다.");
        return;
      }
      const intro = result.raw.trim();
      if (!intro) {
        apiError(res, 502, "소개글을 생성하지 못했습니다. 다시 시도해 주세요.");
        return;
      }
      res.json({ intro });
      } catch {
        apiError(res, 502, "소개글 생성 중 오류가 발생했습니다.");
      } finally {
        generateInFlight.delete(req.user!.id);
      }
    },
  );

  // Generate capability hashtags (역량 해시태그) for the owner's avatar, mirroring
  // intro/generate: the avatar inspects its persona + skills and proposes a short
  // set of searchable tags the owner reviews/edits before saving (NOT persisted
  // here). Runs headless + read-only, like a routine.
  router.post(
    "/api/me/hashtags/generate",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const avatar = store.resolveChatAvatar(req.user!.id, req.user!.id);
      if (!avatar) {
        apiError(res, 404, "아바타를 찾을 수 없습니다.");
        return;
      }

      // Optional: tags the owner already has. When present the avatar proposes
      // ADDITIONAL tags not already in the list (the "더 추가" button), and we
      // filter any overlap server-side so only genuinely new tags come back.
      const existing = normalizeHashtags(req.body?.existing);
      const existingKeys = new Set(existing.map((t) => t.toLowerCase()));

      // The local runtime can't introspect skills; return a deterministic
      // placeholder so the feature still works offline/in tests.
      if (config.agentRuntime === "local") {
        const placeholder = [
          "업무지원",
          "질문답변",
          "일정관리",
          "문서작성",
        ].filter((t) => !existingKeys.has(t.toLowerCase()));
        res.json({
          hashtags: placeholder.length ? placeholder : ["업무지원", "질문답변"],
        });
        return;
      }

      if (generateInFlight.has(req.user!.id)) {
        apiError(res, 409, "이미 생성 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      generateInFlight.add(req.user!.id);
      try {
      // Resolve plugin roots + skills exactly like intro/generate, so the tags
      // reflect what the avatar can actually do. (Wrapped like intro/generate so a
      // resolve/list throw becomes a 502 instead of a hung request.)
      const { sourced, enabledPlugins, pluginRoots } =
        await resolveAvatarSkillSources(store, avatar, config, true);
      const skills = await listSkillsInRoots(sourced);

      // When adding to an existing set, tell the avatar what it already has and ask
      // for DISTINCT new tags only; otherwise generate a fresh set.
      const addingMore = existing.length > 0;
      const taskLine = addingMore
        ? `You already have these hashtags: ${existing.map((t) => `#${t}`).join(" ")}\n\n` +
          "Based on the information below, propose 3–8 ADDITIONAL capability hashtags that are NOT already in the list above and cover capabilities, domains, or tools not yet represented. " +
          "Do not repeat or merely rephrase existing tags. Ground them in the skills, plugins, and persona you have, and do not invent capabilities you lack.\n\n"
        : "Based on the information below, create 5–12 hashtags representing the core capabilities, domains, and tools you can actually help with. " +
          "Ground them in the skills, plugins, and persona you have, and do not invent capabilities you lack.\n\n";
      const message =
        "You are creating 'capability hashtags' for searching and categorizing yourself. These tags help colleagues find what you can do by keyword on the discovery screen.\n\n" +
        taskLine +
        "Output format: output only the hashtags on a single line separated by spaces. Each tag starts with `#` and contains no spaces (join multiple words together or connect them with hyphens). " +
        "Default to Korean, but widely used technical terms may be written in English. Output only the hashtag line — no explanatory sentences, lists, or code blocks.\n" +
        "Example: #코드리뷰 #파이썬 #데이터분석 #기술문서작성\n\n" +
        describeAvatarEquipment(skills, enabledPlugins, avatar.persona);

      const result = await runHeadlessAvatarPrompt(
        store,
        config,
        avatar,
        "hashtags",
        message,
        pluginRoots,
        "hashtag generation failed",
        req.user!.id,
      );
      if (!result.ok) {
        apiError(res, 502, "해시태그 생성 중 오류가 발생했습니다.");
        return;
      }
      // Prefer explicit "#tag" tokens; fall back to splitting the whole reply.
      const raw = result.raw;
      const tagged = [...raw.matchAll(/#([^\s#,，、]+)/g)].map((m) => m[1]);
      // Drop any the owner already has so "더 추가" only returns genuinely new tags
      // (the model can still echo existing ones despite the prompt).
      const hashtags = normalizeHashtags(tagged.length ? tagged : raw).filter(
        (t) => !existingKeys.has(t.toLowerCase()),
      );
      if (hashtags.length === 0) {
        apiError(
          res,
          502,
          addingMore
            ? "추가할 새 해시태그를 찾지 못했습니다. 페르소나나 스킬을 보강해 보세요."
            : "해시태그를 생성하지 못했습니다. 다시 시도해 주세요.",
        );
        return;
      }
      res.json({ hashtags });
      } catch {
        apiError(res, 502, "해시태그 생성 중 오류가 발생했습니다.");
      } finally {
        generateInFlight.delete(req.user!.id);
      }
    },
  );

  router.put(
    "/api/me/avatar-image",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const decoded = decodeAvatarImage(req.body?.image);
      if ("error" in decoded) {
        apiError(res, 400, decoded.error);
        return;
      }
      saveAvatarImageFile(config, req.user!.id, decoded.ext, decoded.buffer);
      store.setAvatarExt(req.user!.id, decoded.ext);
      res.json({ ok: true, hasImage: true });
    },
  );

  router.delete(
    "/api/me/avatar-image",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      deleteAvatarImageFile(config, req.user!.id, store.getAvatarExt(req.user!.id));
      store.setAvatarExt(req.user!.id, null);
      res.json({ ok: true, hasImage: false });
    },
  );

  router.get("/api/users/:id/avatar-image", (req, res) => {
    // Users first, then the namespaced avatar kinds ("external:<id>",
    // "group:<groupId>:<agentId>") — the prefixes can't collide with a user UUID, and
    // every lookup only hits disk when a registered row matched (so an
    // arbitrary :id never becomes a file path).
    const ext =
      store.getAvatarExt(req.params.id) ??
      store.getExternalAvatarImageExt(req.params.id) ??
      store.getGroupAgentImageExtByAvatarId(req.params.id);
    if (!ext) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    const file = path.join(avatarDir(config), `${req.params.id}.${ext}`);
    if (!fs.existsSync(file)) {
      res.status(404).json({ error: "No avatar image" });
      return;
    }
    res.type(EXT_MIME[ext] ?? "application/octet-stream");
    res.sendFile(file);
  });

  return router;
}
