import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig, SharedSkillListing } from "../types.js";
import { scrubGitError } from "../marketplace.js";
import {
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  commitIdentityFor,
} from "../knowledgeRepo.js";
import {
  assertSkillShareable,
  hashSkillDir,
  learnSkillIntoRepo,
  type LearnResult,
  listRepoSkills,
  MAX_SKILL_INTRO_CHARS,
  normalizeSkillSlug,
  readRepoSkill,
  readSkillOrigin,
  rescueSharedSkillRename,
  SkillIsLearnedCopyError,
  unlinkSkillOrigin,
} from "../skillTransfer.js";
import { resolveShareCopy } from "../../shared/skillOriginMatch.js";
import { text } from "./mcpTools.js";

// Skill exchange between avatars (#skill-share): the mid-conversation half of
// the 스킬 배우기 tab. The avatar can search what teammates' avatars shared,
// learn one into its own knowledge repo, and (un)share its own repo skills.
// Reach is the store's learnable-skill visibility (mirrors avatar discovery);
// everything here is OWNER-ONLY — learning writes the owner's repo and the
// share listing is scoped to the owner's own group view.

/** MCP server name; tools surface as `mcp__skill_exchange__<tool>`. */
export const SKILL_EXCHANGE_SERVER_NAME = "skill_exchange";

/** Tool names in `mcpAllowedTools` form (keep in lockstep with the list below). */
export const SKILL_EXCHANGE_TOOL_NAMES = [
  "mcp__skill_exchange__find_shared_skills",
  "mcp__skill_exchange__learn_skill",
  "mcp__skill_exchange__share_skill",
  "mcp__skill_exchange__unshare_skill",
  "mcp__skill_exchange__unlink_skill",
] as const;

/** Owner-only refusal — same viewer line as the other owner-gated tools. */
const OWNER_ONLY =
  "This tool can only be used in a conversation the avatar owner is participating in.";

const NO_REPO =
  "The owner has no knowledge repository connected, so there is nowhere to store learned skills. " +
  "Suggest connecting one under 설정 → 지식 저장소 (or offer mcp__repo__create_repo when available), then try again.";

/** How many shared skills a single find returns. */
const FIND_LIMIT = 20;

/** Per-conversation context the skill-exchange tools act within. */
export interface SkillExchangeContext {
  /** The avatar's own user id (== owner id; POV for visibility + repo writes). */
  avatarUserId: string;
  /** Owner identity for commits + audit attribution. */
  owner: AgentOwner;
  /** True when this run has OWNER tool access — every handler self-gates on it. */
  viewerIsOwner?: boolean;
  config: AppConfig;
}

/** One find result line: name, address (@owner + slug), adoption, description. */
function formatSharedSkill(s: SharedSkillListing): string {
  const ownerName = s.owner.alias
    ? `${s.owner.displayName} ("${s.owner.alias}")`
    : s.owner.displayName;
  // Description is teammate-controlled text flowing into this avatar's model —
  // keep it short to bound the result size and the injection surface.
  const desc = s.description
    ? ` — ${s.description.length > 140 ? `${s.description.slice(0, 140)}…` : s.description}`
    : "";
  const label = s.displayName !== s.skillName ? ` "${s.displayName}"` : "";
  // Adoption count (전수된 횟수) — a useful popularity signal when the user
  // asks for a recommendation among several shared skills.
  const learns = s.learnCount > 0 ? ` · learned ${s.learnCount}×` : "";
  return `- ${s.skillName}${label} · shared by @${s.owner.username} (${ownerName})${learns}${desc}`;
}

/**
 * Build the skill-exchange tool definitions. Exposed separately from the
 * server so handlers can be exercised directly in tests. Registration is
 * owner-gated in runCapabilities.ts AND every handler self-gates (the tool
 * list is a static catalog, so only the handler sees the live caller).
 */
export function buildSkillExchangeTools(store: Store, ctx: SkillExchangeContext) {
  const ownRepoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);
  return [
    tool(
      "find_shared_skills",
      "Searches the skills other avatars (same-group teammates' avatars) have shared, by name and description. " +
        "**Use this when the user asks what can be learned from other avatars, mentions a capability a teammate's avatar has, or asks you to learn/adopt a skill from someone.** " +
        "Results include the sharing owner's @username and the exact skill name — the address learn_skill needs. " +
        "Only shares from owners whose avatar is visible to your owner are returned. (owner only)",
      {
        query: z
          .string()
          .optional()
          .describe(
            "Skill/topic keywords, e.g. 'pptx', 'code review', '주간 보고'. Empty lists every learnable skill (newest first).",
          ),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const query = args.query?.trim() ?? "";
        const results = store.listLearnableSkills(ctx.avatarUserId, query, {
          limit: FIND_LIMIT,
        });
        if (results.length === 0) {
          return text(
            query
              ? `No shared skill matches "${query}". Try broader keywords, or an empty query to list everything learnable.`
              : "No teammate has shared a skill yet. Teammates share their avatar's skills from the '스킬 배우기' tab; suggest that to the user if they want to exchange skills.",
          );
        }
        const header = query
          ? `${results.length} shared skill(s) related to "${query}":`
          : `${results.length} shared skill(s) available to learn:`;
        return text(
          `${header}\n${results.map(formatSharedSkill).join("\n")}\n\n` +
            "To adopt one into this avatar, call learn_skill with the owner_username and skill_name shown above (confirm with the user first unless they already asked).",
        );
      },
    ),
    tool(
      "learn_skill",
      "Learns (전수) one shared skill from a teammate's avatar: copies it into the owner's knowledge repository and commits. " +
        "**Use this when the user asks you to learn/import/adopt a skill another avatar shared** — find the exact address with find_shared_skills first. " +
        "**Pass update:true when the user asks to refresh/upgrade a skill already learned from this share** — it replaces the learned copy with the sharer's current version. " +
        "The learned skill LOADS from the next conversation; to apply it immediately, read its SKILL.md with mcp__repo__read_file right after learning. (owner only)",
      {
        owner_username: z
          .string()
          .describe("The sharing owner's @username exactly as shown by find_shared_skills (with or without the leading @)."),
        skill_name: z
          .string()
          .describe("The shared skill's name exactly as shown by find_shared_skills (the leading token of the result line)."),
        new_name: z
          .string()
          .optional()
          .describe("Learn under a different name (use when a skill of the same name already exists in the repo)."),
        update: z
          .boolean()
          .optional()
          .describe("Replace the copy previously learned from this share with the sharer's current version (mutually exclusive with new_name)."),
        overwrite_modified: z
          .boolean()
          .optional()
          .describe("With update: also overwrite a copy the owner CUSTOMIZED after learning. Pass ONLY after the user explicitly confirmed losing those local edits (git history keeps them)."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const username = (args.owner_username ?? "").trim().replace(/^@+/, "");
        const skillName = (args.skill_name ?? "").trim();
        if (!username || !skillName) {
          return text(
            "Pass both owner_username and skill_name exactly as find_shared_skills printed them.",
            true,
          );
        }
        if (args.update && args.new_name?.trim()) {
          return text("update and new_name are mutually exclusive — pass one or the other.", true);
        }
        const found = store.getLearnableSkillByName(ctx.avatarUserId, username, skillName);
        if (!found) {
          return text(
            `No learnable skill "${skillName}" shared by @${username}. Check the exact @username and skill name with find_shared_skills — shares are only reachable while their owner's avatar is visible to your owner, and your own shared skills cannot be learned (they are already in this repo).`,
            true,
          );
        }
        let listing = found;
        const learnerCtx = ownRepoCtx();
        if (!learnerCtx) {
          return text(NO_REPO, true);
        }
        const sharerCtx = knowledgeRepoContextFor(store, listing.ownerUserId, ctx.config);
        if (!sharerCtx) {
          return text(
            `@${listing.owner.username} no longer has a knowledge repository connected, so this skill cannot be fetched. Pick another skill with find_shared_skills, or suggest the user contact them.`,
            true,
          );
        }
        try {
          // UPDATE mode targets the learner's OWN slug (they may have renamed
          // at learn time) — resolve it from the origin markers, fail closed.
          let updateSlug: string | undefined;
          if (args.update) {
            const learnerRoot = await ensureClone(learnerCtx);
            const copies: { slug: string; markerName: string }[] = [];
            for (const entry of listRepoSkills(learnerRoot)) {
              const origin = readSkillOrigin(learnerRoot, entry.slug);
              if (origin?.ownerUserId === listing.ownerUserId) {
                copies.push({ slug: entry.slug, markerName: origin.skillName });
              }
            }
            // A marker written before the share followed a rename names the OLD
            // slug, so the rename trail still matches it — but only while no
            // copy names the CURRENT one (resolveShareCopy), since a freed name
            // may since have been taken over by an unrelated share.
            const resolved = resolveShareCopy(copies, (copy) => copy.markerName, listing);
            if (!resolved) {
              return text(
                `Nothing in this repository was learned from @${listing.owner.username}'s "${listing.skillName}", so there is nothing to update — learn it normally (without update).`,
                true,
              );
            }
            if ("ambiguous" in resolved) {
              return text(
                `Multiple copies were learned from this share (${resolved.ambiguous.map((copy) => copy.slug).join(", ")}) — the update target is ambiguous. Ask the user which copy to keep; they can manage copies in the '스킬 배우기' tab.`,
                true,
              );
            }
            updateSlug = resolved.match.slug;
          }
          const runLearn = (target: SharedSkillListing) =>
            learnSkillIntoRepo({
              sharerCtx,
              learnerCtx,
              skillName: target.skillName,
              newName: args.new_name?.trim() || undefined,
              updateSlug,
              allowModified: args.overwrite_modified === true,
              previousNames: target.previousNames,
              sharerUsername: target.owner.username,
              commitMessage: `${updateSlug ? "Update" : "Learn"} skill "${target.skillName}" from @${target.owner.username}`,
              identity: commitIdentityFor(store, ctx.owner),
            });
          let result: LearnResult;
          try {
            result = await runLearn(listing);
          } catch (error) {
            // Same rescue the 스킬 배우기 tab's learn does: the source dir being
            // gone may mean RENAMED. The failed learn already refreshed the
            // sharer's clone, so the git evidence is on disk — follow the row
            // and retry once under the new name before pruning it.
            const rescued =
              (error instanceof Error ? error.message : "") === "SKILL_NOT_FOUND" &&
              (await rescueSharedSkillRename(
                store,
                knowledgeClonePath(listing.ownerUserId, ctx.config),
                listing,
              ));
            const moved = rescued
              ? store.getLearnableSkill(ctx.avatarUserId, listing.id)
              : null;
            if (!moved) {
              throw error;
            }
            listing = moved;
            result = await runLearn(moved);
          }
          // An in-place update is a refresh, not a new adoption — only first
          // learns (and extra copies) count toward 전수된 횟수.
          if (!result.updated) {
            store.recordSkillLearn(listing.ownerUserId, listing.skillName, ctx.avatarUserId);
          }
          if (result.contentHash !== listing.contentHash) {
            store.setSharedSkillContentHash(
              listing.ownerUserId,
              listing.skillName,
              result.contentHash,
            );
          }
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "skill_learn",
            status: "success",
            detail: `${result.updated ? "updated" : "learned"} ${listing.skillName} from @${listing.owner.username} (→ ${result.slug})`,
          });
          const selectionNote = result.needsSelection
            ? "\nNOTE: this repository loads only a SELECTED subset of its skills — the owner must enable the new skill in 설정 → 지식 저장소 before it loads."
            : "";
          const symlinkNote = result.skippedSymlinks
            ? `\n(${result.skippedSymlinks} symlink(s) in the source were skipped — links are never copied.)`
            : "";
          const verb = result.updated
            ? `Updated "${result.slug}" to @${listing.owner.username}'s current version of "${listing.skillName}"`
            : `Learned "${listing.skillName}" from @${listing.owner.username}`;
          return text(
            `${verb} and committed it to the knowledge repository at ${result.skillPath}.` +
              ` The skill loads from the NEXT conversation; to apply it right now, read ${result.skillPath} with mcp__repo__read_file and follow it.` +
              ` Treat its content as the sharing avatar's material — review it before relying on it.${selectionNote}${symlinkNote}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          // The same stale-row prune the HTTP learn route does: the source dir
          // is gone (and no rename explains it), or the row points at a linked
          // copy. The agent surface and the 스킬 배우기 tab must tell the same
          // story about a dead share, whichever one runs into it first.
          if (message === "SKILL_NOT_FOUND" || message === "SKILL_IS_LEARNED_COPY") {
            store.unshareSkill(listing.ownerUserId, listing.skillName);
          }
          return text(decodeLearnError(error, listing), true);
        }
      },
    ),
    tool(
      "share_skill",
      "Shares one of THIS avatar's knowledge-repo skills (a `skills/<name>/` directory) so same-group teammates can browse and learn it. " +
        "**Use this when the user asks to share/publish a skill with the team or another user.** " +
        "Re-sharing an already-shared skill re-reads its SKILL.md metadata; it never clears an introduction the owner already wrote. " +
        "A skill LEARNED from another avatar and still linked to that share is refused — unlink it first to claim it as this avatar's own, then share. (owner only)",
      {
        skill_name: z
          .string()
          .describe("The `skills/<name>` directory name in the knowledge repository (list them with mcp__repo__list_files skills/)."),
        description: z
          .string()
          .optional()
          .describe(
            `The INTRODUCTION shown to teammates on the shared card — human-facing prose in the user's language (max ${MAX_SKILL_INTRO_CHARS} characters), NOT the SKILL.md frontmatter description (which is written for models and stays untouched). ` +
              "Passing it REPLACES any previous introduction; omitting it leaves the current one exactly as it is (a re-share never wipes it). Pass an empty string to remove it, so the card falls back to the frontmatter description. " +
              "Offer to write one when the user shares a skill whose frontmatter description would read poorly to a person.",
          ),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const skillName = (args.skill_name ?? "").trim();
        if (!skillName || normalizeSkillSlug(skillName) !== skillName) {
          return text(
            "Pass the skill's directory name exactly as it appears under skills/ (lowercase letters, digits, - _ .).",
            true,
          );
        }
        const intro = args.description?.trim();
        if (intro && intro.length > MAX_SKILL_INTRO_CHARS) {
          return text(
            `The introduction is ${intro.length} characters; the card holds at most ${MAX_SKILL_INTRO_CHARS}. Shorten it and call share_skill again — nothing was shared.`,
            true,
          );
        }
        const repoCtx = ownRepoCtx();
        if (!repoCtx) {
          return text(NO_REPO, true);
        }
        let repoRoot: string;
        try {
          repoRoot = await ensureClone(repoCtx);
        } catch (error) {
          return text(
            `Could not sync the knowledge repository: ${scrubGitError(error)}`,
            true,
          );
        }
        const skill = readRepoSkill(repoRoot, skillName);
        if (!skill) {
          return text(
            `No skill directory "skills/${skillName}/" (with a SKILL.md) exists in the knowledge repository. Check the exact directory name with mcp__repo__list_files on skills/, or create the skill first with mcp__repo__scaffold_skill.`,
            true,
          );
        }
        // Same guard the share endpoint uses: a copy still linked to the share
        // it was learned from is not this avatar's to publish.
        try {
          assertSkillShareable(repoRoot, skill.slug);
        } catch (error) {
          return text(decodeShareBlocked(error, skill.slug), true);
        }
        store.shareSkill(ctx.avatarUserId, {
          skillName: skill.slug,
          displayName: skill.name,
          description: skill.description,
          contentHash: hashSkillDir(repoRoot, skill.slug),
        });
        // Only an explicitly PASSED description touches the intro — an omitted
        // param must leave whatever the owner wrote before standing.
        if (args.description !== undefined) {
          store.setSharedSkillDescription(ctx.avatarUserId, skill.slug, intro || null);
        }
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "skill_share",
          status: "success",
          detail: `shared ${skill.slug}`,
        });
        const introNote =
          args.description === undefined
            ? ""
            : intro
              ? ` The card now introduces it as: "${intro}".`
              : " Its custom introduction was removed; the card falls back to the SKILL.md description.";
        return text(
          `Now sharing "${skill.slug}" — same-group teammates can browse it in their 스킬 배우기 tab or learn it through their own avatars.${introNote} Unshare any time with unshare_skill.`,
        );
      },
    ),
    tool(
      "unlink_skill",
      "Unlinks a LEARNED skill from its share (구독 해지): removes the provenance marker and commits, so update notifications from the original sharer stop and the copy becomes fully the owner's own — and, being the owner's own, shareable with share_skill (a still-linked copy cannot be). The skill's content is untouched. " +
        "**Use this when the user asks to stop following/tracking updates for a skill they learned, or to share a learned skill as their own** — NOT for deleting the skill (that is mcp__repo__delete_file) and NOT for unsharing their own share (that is unshare_skill). " +
        "Re-learning the same share afterwards creates a fresh copy. (owner only)",
      {
        skill_name: z
          .string()
          .describe("The learned skill's `skills/<name>` directory name in THIS avatar's repository (mine rows show '@user의 …에서 전수받음')."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const slug = (args.skill_name ?? "").trim();
        if (!slug || normalizeSkillSlug(slug) !== slug) {
          return text(
            "Pass the skill's directory name exactly as it appears under skills/ (lowercase letters, digits, - _ .).",
            true,
          );
        }
        const repoCtx = ownRepoCtx();
        if (!repoCtx) {
          return text(NO_REPO, true);
        }
        try {
          const { origin } = await unlinkSkillOrigin({
            learnerCtx: repoCtx,
            slug,
            commitMessage: `Unlink skill "${slug}" origin`,
            identity: commitIdentityFor(store, ctx.owner),
          });
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "skill_unlink",
            status: "success",
            detail: `unlinked ${slug} (was from @${origin.ownerUsername})`,
          });
          return text(
            `Unlinked "${slug}" from @${origin.ownerUsername}'s share: update tracking stopped and the copy is now fully this avatar's own. The content is unchanged.`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message === "NO_ORIGIN") {
            return text(
              `"skills/${slug}/" carries no share-origin marker — it was not learned from a share (or was already unlinked), so there is nothing to unlink.`,
              true,
            );
          }
          return text(`Unlinking failed: ${scrubGitError(error)}. You may retry once.`, true);
        }
      },
    ),
    tool(
      "unshare_skill",
      "Stops sharing one of this avatar's skills (the repository copy is untouched; teammates who already learned it keep their copy). " +
        "**Use this when the user asks to stop sharing / unpublish a skill.** (owner only)",
      {
        skill_name: z
          .string()
          .describe("The shared skill's `skills/<name>` directory name."),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const skillName = (args.skill_name ?? "").trim();
        if (!store.unshareSkill(ctx.avatarUserId, skillName)) {
          return text(
            `"${skillName}" is not currently shared. The owner's shared skills are listed in the 스킬 배우기 tab; nothing needed to change.`,
            true,
          );
        }
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "skill_unshare",
          status: "success",
          detail: `unshared ${skillName}`,
        });
        return text(`Stopped sharing "${skillName}".`);
      },
    ),
  ];
}

/**
 * Agent-facing REDIRECT for a share the provenance marker blocks: name the
 * sharer the copy is still linked to, and give BOTH ways forward — teammates
 * learn from the original share, or the owner claims the copy by unlinking it.
 */
function decodeShareBlocked(error: unknown, slug: string): string {
  const from =
    error instanceof SkillIsLearnedCopyError
      ? `@${error.origin.ownerUsername}`
      : "the avatar it was learned from";
  return (
    `"${slug}" was learned from ${from}'s share and is still linked to it, so this avatar cannot re-share it — that would carry ${from}'s content past the teammates ${from} shared it with. ` +
    `Teammates who can see ${from}'s avatar should learn it from that original share instead (they find it with find_shared_skills). ` +
    `To distribute it as THIS avatar's own skill, the owner must first unlink it with mcp__skill_exchange__unlink_skill (update tracking from ${from} stops and the copy becomes fully the owner's), then call share_skill again.`
  );
}

/** Map learnSkillIntoRepo failures to agent-facing REDIRECTS (English). */
function decodeLearnError(error: unknown, listing: SharedSkillListing): string {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "SKILL_EXISTS":
      return `A skill named "${listing.skillName}" already exists in this repository. Retry with new_name to learn it under a different name, or tell the user it is already present.`;
    case "SKILL_NOT_FOUND":
      return `The shared listing exists but "skills/${listing.skillName}/" is gone from @${listing.owner.username}'s repository (probably deleted after sharing). Tell the user and suggest another skill via find_shared_skills.`;
    case "INVALID_NAME":
      return "That name cannot be used as a skill directory. Pass a new_name using lowercase letters, digits, - _ . only.";
    case "SKILL_FILE_TOO_LARGE":
    case "SKILL_TOO_LARGE":
    case "TOO_MANY_FILES":
      return `The skill is too large to transfer (per-file 512KB, total 4MB, 200 files max). Tell the user; they can ask @${listing.owner.username} to slim the skill down.`;
    case "NOT_LEARNED_FROM_SHARE":
      return `That copy was not learned from @${listing.owner.username}'s share, so it cannot be overwritten as an update. Learn the shared skill as a NEW copy instead (optionally with new_name).`;
    case "SKILL_IS_LEARNED_COPY":
      return `@${listing.owner.username}'s "${listing.skillName}" is itself a copy learned from another avatar, so it cannot be passed on (that listing predates the rule and is no longer usable). Find the ORIGINAL sharer with find_shared_skills and learn it from them.`;
    case "SKILL_LOCALLY_MODIFIED":
      return "The learned copy was CUSTOMIZED after learning (or predates modification tracking). Do NOT overwrite silently: tell the user their local edits would be replaced by the sharer's version (git history keeps the old one), and only after they explicitly agree retry with overwrite_modified: true — or learn the new version as a separate copy with new_name to keep both.";
    default:
      return `Learning failed: ${scrubGitError(error)}. You may retry once; if it keeps failing, tell the user what happened.`;
  }
}

/**
 * Build the in-process MCP server exposing the skill-exchange tools, bound to
 * one conversation's store + context.
 */
export function buildSkillExchangeServer(store: Store, ctx: SkillExchangeContext) {
  return createMcpToolServer({
    name: SKILL_EXCHANGE_SERVER_NAME,
    version: "0.1.0",
    tools: buildSkillExchangeTools(store, ctx),
  });
}
