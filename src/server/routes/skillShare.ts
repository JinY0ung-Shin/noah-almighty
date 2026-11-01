import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { scrubGitError } from "../marketplace.js";
import {
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  commitIdentityFor,
  readFile,
  SKILL_DIR,
} from "../knowledgeRepo.js";
import {
  assertSkillShareable,
  hashSkillDir,
  learnSkillIntoRepo,
  listRepoSkills,
  listSkillFiles,
  type LearnResult,
  MAX_SKILL_INTRO_CHARS,
  normalizeSkillSlug,
  readRepoSkill,
  readSkillOrigin,
  reconcileOwnerSharedSkills,
  rescueSharedSkillRename,
  SkillIsLearnedCopyError,
  skillsDirUnreadable,
  unlinkSkillOrigin,
} from "../skillTransfer.js";
import { withRepoLock } from "../gitMutex.js";
import { apiError, safeString, type RouterDeps } from "./_shared.js";
import type { SharedSkill, SharedSkillListing, User } from "../types.js";

// ---- Skill sharing between avatars (#skill-share) ----------------------
// The owner-side management (share/unshare my repo skills) and the learner
// side (browse skills visible teammates shared, learn one into my repo).
// Reach mirrors avatar discovery: you can browse/learn a share iff you could
// see the owner's avatar in 탐색 (store.listLearnableSkills enforces it).

/** Korean messages for the skillTransfer message-coded errors. */
/**
 * The sharer's `skills/` exists but is not a plain folder (a link, even one into
 * their repo): its skills cannot be read — and must not be pruned as deleted.
 */
const SKILLS_DIR_UNREADABLE_KO =
  "공유한 아바타의 저장소에서 지금은 이 스킬을 읽을 수 없습니다(skills 폴더가 일반 폴더가 아닙니다). 공유는 그대로 유지되니, 저장소가 고쳐진 뒤 다시 시도해 주세요.";

const LEARN_ERROR_KO: Record<string, { status: number; message: string }> = {
  SKILL_EXISTS: {
    status: 409,
    message: "같은 이름의 스킬이 내 저장소에 이미 있습니다. 다른 이름을 지정해 주세요.",
  },
  SKILL_NOT_FOUND: {
    status: 404,
    message: "공유한 아바타의 저장소에서 이 스킬을 찾을 수 없습니다.",
  },
  INVALID_NAME: { status: 400, message: "스킬 이름이 올바르지 않습니다." },
  SKILL_FILE_TOO_LARGE: {
    status: 413,
    message: "스킬 파일이 너무 커서 가져올 수 없습니다 (파일당 512KB 제한).",
  },
  SKILL_TOO_LARGE: {
    status: 413,
    message: "스킬이 너무 커서 가져올 수 없습니다 (전체 4MB 제한).",
  },
  TOO_MANY_FILES: {
    status: 413,
    message: "스킬에 파일이 너무 많아 가져올 수 없습니다.",
  },
  NOT_LEARNED_FROM_SHARE: {
    status: 409,
    message: "이 공유에서 전수받은 스킬이 아니어서 덮어쓸 수 없습니다. 새 스킬로 전수받아 주세요.",
  },
  // The client string-matches this message to raise its danger confirm and
  // retry with overwriteModified — keep "전수 후 수정" stable.
  SKILL_LOCALLY_MODIFIED: {
    status: 409,
    message: "전수 후 수정한 스킬입니다. 덮어쓰면 수정 내용이 사라져요 (저장소 이력에는 남습니다).",
  },
  // SOURCE side of the re-share guard: the share row points at a copy its owner
  // learned from someone else (a row from before that was refused). Handlers
  // that hit this PRUNE the row, exactly like a share whose directory is gone.
  SKILL_IS_LEARNED_COPY: {
    status: 404,
    message:
      "이 공유는 다른 아바타에게서 전수받은 사본이라 더 이상 전수받을 수 없습니다. 원작자의 공유를 찾아 주세요.",
  },
};

/**
 * 409 body for a re-share the provenance marker blocks. Learned copies stay
 * inside the original owner's discovery boundary until the learner claims them
 * with 연결 끊기 (구독 해지).
 */
function reshareBlockedKo(error: unknown): string {
  const from =
    error instanceof SkillIsLearnedCopyError ? `@${error.origin.ownerUsername}` : "원작자";
  return (
    `${from}에게서 전수받은 스킬은 원본과 연결된 동안 다시 공유할 수 없습니다. ` +
    `동료에게는 ${from}의 원본 공유를 안내하고, 내 스킬로 공유하려면 ` +
    `먼저 '연결 끊기(구독 해지)' 후 다시 시도해 주세요.`
  );
}

/**
 * Attribute one of MY OWN share rows as a listing. The store's learnable query
 * is others-only, so the viewer's own rows carry no joined owner — the feed and
 * the preview route both build it from the authenticated user, right here.
 */
function ownShareListing(row: SharedSkill, me: User): SharedSkillListing {
  return {
    ...row,
    owner: {
      id: me.id,
      username: me.username,
      displayName: me.displayName,
      alias: me.alias ?? "",
      hasImage: Boolean(me.hasImage),
    },
  };
}

/** Commit message for a first learn vs. an in-place update. */
function learnCommitMessage(
  listing: { skillName: string; owner: { username: string } },
  isUpdate: boolean,
): string {
  return isUpdate
    ? `Update skill "${listing.skillName}" from @${listing.owner.username}`
    : `Learn skill "${listing.skillName}" from @${listing.owner.username}`;
}

export function createSkillShareRouter({ config, store, auditAs }: RouterDeps): Router {
  const router = Router();

  // My avatar's knowledge-repo skills with their shared state. No repo is a
  // NORMAL state (the tab renders a connect guide), not an error. Serving this
  // list also reconciles the share rows with the working tree: stale rows
  // (skill dir deleted) are unshared, drifted metadata is re-snapshotted.
  router.get(
    "/api/skill-share/mine",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
      if (!ctx) {
        res.json({ repoConfigured: false, skills: [] });
        return;
      }
      let repoRoot: string;
      try {
        repoRoot = await ensureClone(ctx);
      } catch (error) {
        apiError(res, 502, `지식 저장소를 불러오지 못했습니다: ${scrubGitError(error)}`);
        return;
      }
      const repoSkills = listRepoSkills(repoRoot);
      // skills/ exists but is not a plain folder (a link, even one into the
      // repo): it lists as empty, yet nothing was deleted — the reconcile below
      // leaves every share as it is, and the tab says why the list is empty.
      const skillsUnreadable = skillsDirUnreadable(repoRoot);
      // Provenance for LEARNED skills (전수받은 것) — drives the response's
      // origin field (reconciliation reads its own copy off the same tree).
      const originBySlug = new Map(
        repoSkills.map((s) => [s.slug, readSkillOrigin(repoRoot, s.slug)]),
      );
      // The owner opening this tab is one of the two moments the share rows are
      // reconciled with the working tree (the other is their commit tool). Same
      // helper, so drift re-snapshots, deletions/learned copies unshare, and
      // renames are FOLLOWED identically wherever they are noticed. Under the
      // repo lock: it reads git history off this clone, which a concurrent
      // ensureClone may be removing and rebuilding (ensureClone above has
      // already released the lock, so this is not nested). Best-effort like the
      // commit-path reconcile: Express 4 routes an async handler's rejection
      // nowhere (see src/server/index.ts), so an uncaught throw here would
      // stall this request until the client's 120s abort — while a reconcile
      // failure only means stale rows, and the tab can still render.
      try {
        await withRepoLock(repoRoot, () =>
          reconcileOwnerSharedSkills(store, repoRoot, req.user!.id),
        );
      } catch (error) {
        logger.warn(
          { err: error, userId: req.user!.id },
          "skill-share reconcile failed; serving the tab unreconciled",
        );
      }
      const sharedRows = store.listSharedSkillsByOwner(req.user!.id);
      // 전수된 횟수 — keyed by skill name, so a currently-unshared skill keeps
      // showing its history (events outlive the share row).
      const learnCounts = store.skillLearnCounts(req.user!.id);
      const shared = new Set(sharedRows.map((row) => row.skillName));
      // The owner's custom 소개 문구 per shared slug — the mine rows carry it so
      // the tab can show what teammates read and offer 소개 수정 / 되돌리기.
      const customDescriptions = new Map(
        sharedRows.map((row) => [row.skillName, row.customDescription]),
      );
      res.json({
        repoConfigured: true,
        // Present only when set, so the ordinary response shape is unchanged.
        ...(skillsUnreadable ? { skillsDirUnreadable: true } : {}),
        skills: repoSkills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          shared: shared.has(s.slug),
          // Null while unshared or while the share falls back to the
          // frontmatter text above — the tab renders 되돌리기 only when set.
          customDescription: shared.has(s.slug) ? (customDescriptions.get(s.slug) ?? null) : null,
          learnCount: learnCounts[s.slug] ?? 0,
          // Who it came from and the source hash at learn time — the client
          // joins this against the shared listing's current hash to flag
          // available updates (and a set origin means "not re-shareable").
          origin: originBySlug.get(s.slug) ?? null,
        })),
      });
    },
  );

  // Share one of my repo skills (idempotent re-share refreshes the snapshot).
  router.post(
    "/api/skill-share/share",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const skillName = safeString(req.body?.skill);
      if (!skillName || normalizeSkillSlug(skillName) !== skillName) {
        apiError(res, 400, "공유할 스킬 이름이 올바르지 않습니다.");
        return;
      }
      const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
      if (!ctx) {
        apiError(res, 400, "지식 저장소가 연결되어 있지 않습니다.");
        return;
      }
      let repoRoot: string;
      try {
        repoRoot = await ensureClone(ctx);
      } catch (error) {
        apiError(res, 502, `지식 저장소를 불러오지 못했습니다: ${scrubGitError(error)}`);
        return;
      }
      const skill = readRepoSkill(repoRoot, skillName);
      if (!skill) {
        apiError(res, 404, "지식 저장소에 없는 스킬입니다.");
        return;
      }
      try {
        assertSkillShareable(repoRoot, skill.slug);
      } catch (error) {
        apiError(res, 409, reshareBlockedKo(error));
        return;
      }
      const row = store.shareSkill(req.user!.id, {
        skillName: skill.slug,
        displayName: skill.name,
        description: skill.description,
        contentHash: hashSkillDir(repoRoot, skill.slug),
      });
      auditAs(req, "skill_share", `${skill.slug} 공유`);
      res.json({ shared: row });
    },
  );

  // Set (or clear) the owner's 소개 문구 for one share. The frontmatter
  // description is written FOR THE MODEL and often reads badly to a human
  // browsing 스킬 배우기, so the owner may put their own introduction on the
  // card; an empty body clears it back to that frontmatter snapshot. Owner-only
  // by construction — the row is addressed by the authenticated user's id.
  router.put(
    "/api/skill-share/share/:skillName/description",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const description = safeString(req.body?.description);
      if (description.length > MAX_SKILL_INTRO_CHARS) {
        apiError(res, 400, `소개 문구는 ${MAX_SKILL_INTRO_CHARS}자까지 쓸 수 있습니다.`);
        return;
      }
      const row = store.setSharedSkillDescription(
        req.user!.id,
        req.params.skillName,
        description || null,
      );
      if (!row) {
        apiError(res, 404, "공유 중인 스킬이 아닙니다.");
        return;
      }
      // Its own action, not skill_share: this changes what a share SAYS, not
      // whether it exists — an admin counting shares shouldn't catch edits.
      auditAs(
        req,
        "skill_share_intro",
        `${req.params.skillName} 소개 문구 ${description ? "수정" : "되돌리기"}`,
      );
      res.json({ shared: row });
    },
  );

  // Stop sharing one skill (the repo copy is untouched).
  router.delete(
    "/api/skill-share/share/:skillName",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const skillName = req.params.skillName;
      if (!store.unshareSkill(req.user!.id, skillName)) {
        apiError(res, 404, "공유 중인 스킬이 아닙니다.");
        return;
      }
      auditAs(req, "skill_unshare", `${skillName} 공유 해제`);
      res.json({ ok: true });
    },
  );

  // Unlink a LEARNED copy from its share (구독 해지): removes the origin
  // marker + commits. The skill stays; update tracking stops, and re-learning
  // the same share later is a fresh copy.
  router.post(
    "/api/skill-share/unlink",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const slug = safeString(req.body?.slug);
      if (!slug || normalizeSkillSlug(slug) !== slug) {
        apiError(res, 400, "스킬 이름이 올바르지 않습니다.");
        return;
      }
      const ctx = knowledgeRepoContextFor(store, req.user!.id, config);
      if (!ctx) {
        apiError(res, 400, "지식 저장소가 연결되어 있지 않습니다.");
        return;
      }
      try {
        const { origin } = await unlinkSkillOrigin({
          learnerCtx: ctx,
          slug,
          commitMessage: `Unlink skill "${slug}" origin`,
          identity: commitIdentityFor(store, req.user!),
        });
        auditAs(req, "skill_unlink", `${slug} 원본 연결 끊기 (@${origin.ownerUsername})`);
        res.json({ ok: true, origin: { ownerUsername: origin.ownerUsername } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "NO_ORIGIN") {
          apiError(res, 404, "전수받은 스킬이 아니거나 이미 연결이 끊긴 스킬입니다.");
          return;
        }
        apiError(res, 502, `연결을 끊지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  // The group's shared-skill feed: teammates' shares I could learn PLUS my own
  // shares (like 탐색 shows my own avatar) — seeing my skill alongside its
  // 전수 count is how I know how far it spread. Metadata only, never touches a
  // clone, so the tab list stays fast. The client tells mine apart by
  // ownerUserId and disables learning on them.
  router.get(
    "/api/skill-share/available",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const query = safeString(req.query?.query);
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const me = req.user!;
      const own = store
        .listSharedSkillsByOwner(me.id)
        .filter(
          (s) =>
            tokens.length === 0 ||
            tokens.some((t) =>
              // Both description columns, like listLearnableSkills: the custom
              // intro is what shows on the card, the snapshot is the skill's
              // own words (s.description already resolves to the former).
              [s.skillName, s.displayName, s.description, s.snapshotDescription]
                .join(" ")
                .toLowerCase()
                .includes(t),
            ),
        )
        .map((s) => ownShareListing(s, me));
      res.json({
        skills: [...own, ...store.listLearnableSkills(me.id, query, { limit: 100 })],
      });
    },
  );

  // One shared skill with a fresh SKILL.md preview (refreshes the sharer's
  // clone, so the preview shows what would actually be learned).
  router.get(
    "/api/skill-share/available/:id",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const me = req.user!;
      // Re-resolvable because a rename rescue below moves the row's skill_name
      // while KEEPING its id — the same lookup then finds it under the new name.
      const resolveListing = (): SharedSkillListing | null => {
        const learnable = store.getLearnableSkill(me.id, req.params.id);
        if (learnable) {
          return learnable;
        }
        // My own shares are IN the feed (badged 나) but are deliberately not
        // learnable — LEARNABLE_SKILLS_FROM excludes self — so 미리보기 on my
        // own card resolves the row here or it would always 404. Everything
        // below works unchanged: ownerUserId is my own id.
        const own = store.listSharedSkillsByOwner(me.id).find((s) => s.id === req.params.id);
        return own ? ownShareListing(own, me) : null;
      };
      const found = resolveListing();
      if (!found) {
        apiError(res, 404, "공유된 스킬을 찾을 수 없습니다.");
        return;
      }
      const sharerCtx = knowledgeRepoContextFor(store, found.ownerUserId, config);
      if (!sharerCtx) {
        apiError(res, 410, "공유한 사용자의 지식 저장소가 더 이상 연결되어 있지 않습니다.");
        return;
      }
      let listing = found;
      try {
        const srcRoot = await ensureClone(sharerCtx);
        // The dir may have been RENAMED, not deleted — usually the owner's own
        // commit already moved the row, but a viewer arriving first rescues it
        // here rather than pruning a live share. A no-op while the dir is still
        // there, and it never bumps updated_at (no reordering by a viewer).
        if (await rescueSharedSkillRename(store, srcRoot, listing)) {
          listing = resolveListing() ?? listing;
        }
        // Before serving anything: a source that is itself a linked copy is a
        // row from before re-sharing those was refused (see the catch).
        assertSkillShareable(srcRoot, listing.skillName);
        // A linked skills/ (even into the sharer's own repo) is never read
        // through — and not pruned as a deletion by the catch below either.
        if (skillsDirUnreadable(srcRoot)) {
          apiError(res, 409, SKILLS_DIR_UNREADABLE_KO);
          return;
        }
        const content = await readFile(srcRoot, `${SKILL_DIR}/${listing.skillName}/SKILL.md`);
        // A skill is the whole directory, not one file: list what a learn would
        // actually copy (aux docs, scripts, templates) so nobody adopts a tree
        // they never saw. Read-only walk — no file contents are loaded.
        const manifest = listSkillFiles(srcRoot, listing.skillName);
        // The clone is fresh — opportunistically refresh the fingerprint so
        // update badges appear even before the owner next opens their tab.
        // (Hash-only: a viewer's preview must not reorder the owner's listing.)
        const currentHash = hashSkillDir(srcRoot, listing.skillName);
        if (currentHash !== listing.contentHash) {
          store.setSharedSkillContentHash(listing.ownerUserId, listing.skillName, currentHash);
        }
        res.json({ skill: { ...listing, contentHash: currentHash }, content, manifest });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "NOT_FOUND" || (error as NodeJS.ErrnoException).code === "ENOENT") {
          store.unshareSkill(listing.ownerUserId, listing.skillName); // stale share
          apiError(res, 404, "공유한 아바타의 저장소에서 이 스킬을 찾을 수 없습니다.");
          return;
        }
        if (message === "SKILL_IS_LEARNED_COPY") {
          // Legacy row, drained on sight like a deleted dir: teammates must not
          // be served content that escaped the original owner's boundary.
          store.unshareSkill(listing.ownerUserId, listing.skillName);
          const known = LEARN_ERROR_KO.SKILL_IS_LEARNED_COPY;
          apiError(res, known.status, known.message);
          return;
        }
        apiError(res, 502, `스킬을 불러오지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  // Learn (전수): copy the shared skill into MY repo and commit as me.
  router.post(
    "/api/skill-share/learn",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const id = safeString(req.body?.id);
      const rawNewName = safeString(req.body?.newName);
      // UPDATE mode: overwrite this existing learner slug in place (allowed
      // only for a copy whose origin marker matches the share — fail closed).
      const updateSlug = safeString(req.body?.updateSlug);
      // Second-step consent for overwriting a LOCALLY CUSTOMIZED copy: the
      // first attempt 409s with SKILL_LOCALLY_MODIFIED, the client confirms
      // with the user, then retries with this flag.
      const overwriteModified = req.body?.overwriteModified === true;
      if (!id) {
        apiError(res, 400, "배울 스킬을 선택해 주세요.");
        return;
      }
      if (rawNewName.length > 100) {
        apiError(res, 400, "새 스킬 이름이 너무 깁니다.");
        return;
      }
      if (updateSlug && rawNewName) {
        apiError(res, 400, "업데이트와 새 이름 지정은 함께 쓸 수 없습니다.");
        return;
      }
      const found = store.getLearnableSkill(req.user!.id, id);
      if (!found) {
        apiError(res, 404, "공유된 스킬을 찾을 수 없습니다.");
        return;
      }
      let listing = found;
      const learnerCtx = knowledgeRepoContextFor(store, req.user!.id, config);
      if (!learnerCtx) {
        apiError(res, 400, "먼저 설정에서 내 지식 저장소를 연결해 주세요.");
        return;
      }
      const sharerCtx = knowledgeRepoContextFor(store, listing.ownerUserId, config);
      if (!sharerCtx) {
        apiError(res, 410, "공유한 사용자의 지식 저장소가 더 이상 연결되어 있지 않습니다.");
        return;
      }
      const runLearn = (target: SharedSkillListing) =>
        learnSkillIntoRepo({
          sharerCtx,
          learnerCtx,
          skillName: target.skillName,
          newName: rawNewName || undefined,
          updateSlug: updateSlug || undefined,
          allowModified: overwriteModified,
          // A copy learned before the share followed a rename carries the OLD
          // name in its origin marker; the trail is what still authorizes an
          // in-place update (the marker is rewritten with the current name).
          previousNames: target.previousNames,
          sharerUsername: target.owner.username,
          commitMessage: learnCommitMessage(target, Boolean(updateSlug)),
          identity: commitIdentityFor(store, req.user!),
        });
      try {
        let result: LearnResult;
        try {
          result = await runLearn(listing);
        } catch (error) {
          // The source dir being gone may mean RENAMED rather than deleted. The
          // learn just refreshed the sharer's clone, so read the evidence off it
          // (no second fetch) and retry once under the new name before pruning.
          const rescued =
            (error instanceof Error ? error.message : "") === "SKILL_NOT_FOUND" &&
            (await rescueSharedSkillRename(
              store,
              knowledgeClonePath(listing.ownerUserId, config),
              listing,
            ));
          const moved = rescued ? store.getLearnableSkill(req.user!.id, id) : null;
          if (!moved) {
            throw error;
          }
          listing = moved;
          result = await runLearn(moved);
        }
        // An in-place update is a refresh, not a new adoption — only first
        // learns (and extra copies) count toward 전수된 횟수.
        if (!result.updated) {
          store.recordSkillLearn(listing.ownerUserId, listing.skillName, req.user!.id);
        }
        // The learn read the sharer's fresh clone — keep the row's fingerprint
        // current so other learners' update badges reflect what was just seen.
        if (result.contentHash !== listing.contentHash) {
          store.setSharedSkillContentHash(
            listing.ownerUserId,
            listing.skillName,
            result.contentHash,
          );
        }
        auditAs(
          req,
          "skill_learn",
          `@${listing.owner.username}의 ${listing.skillName} ${result.updated ? "업데이트" : "전수"} (→ ${result.slug})`,
        );
        logger.info(
          {
            userId: req.user!.id,
            ownerUserId: listing.ownerUserId,
            skill: listing.skillName,
            slug: result.slug,
            updated: result.updated,
          },
          "shared skill learned",
        );
        res.json({
          slug: result.slug,
          skillPath: result.skillPath,
          needsSelection: result.needsSelection,
          updated: result.updated,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (
          message === "SKILL_NOT_FOUND" &&
          skillsDirUnreadable(knowledgeClonePath(listing.ownerUserId, config))
        ) {
          apiError(res, 409, SKILLS_DIR_UNREADABLE_KO); // not deleted: the share stays
          return;
        }
        const known = LEARN_ERROR_KO[message];
        if (known) {
          // Both stale-row shapes drain here: the source dir is gone, or it
          // turned out to be a linked copy (a row predating that refusal).
          if (message === "SKILL_NOT_FOUND" || message === "SKILL_IS_LEARNED_COPY") {
            store.unshareSkill(listing.ownerUserId, listing.skillName); // stale share
          }
          apiError(res, known.status, known.message);
          return;
        }
        auditAs(req, "skill_learn", `@${listing.owner.username}의 ${listing.skillName} 전수 실패`, "error");
        apiError(res, 502, `스킬을 가져오지 못했습니다: ${scrubGitError(error)}`);
      }
    },
  );

  return router;
}
