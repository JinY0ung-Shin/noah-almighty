import crypto from "node:crypto";
import type {
  AvatarDetail,
  AvatarSummary,
  GroupSharedSkill,
  SharedSkill,
  SharedSkillListing,
} from "../types.js";
import {
  type Constructor,
  type StoreBase,
  type UserRow,
  DEFAULT_SEARCH_LIMIT,
  now,
  parseHashtags,
} from "./internal.js";

/**
 * A users row plus the optional per-avatar aggregates the discovery queries
 * precompute (plugin_count + updated_at). getAvatar passes a plain UserRow, so
 * both are optional and toAvatarSummary falls back when they're absent.
 */
interface AvatarSummaryRow extends UserRow {
  plugin_count?: number;
  updated_at?: string | null;
}

/** A shared_skills row, optionally joined with its owner's users columns. */
interface SharedSkillRow {
  id: string;
  owner_user_id: string;
  skill_name: string;
  display_name: string;
  /** SKILL.md frontmatter snapshot — reconciliation's comparison target. */
  description: string | null;
  /** Owner-written introduction; NULL falls back to `description`. */
  custom_description: string | null;
  content_hash: string | null;
  /** JSON array of former skill_name values (rename trail); NULL = none. */
  previous_names: string | null;
  created_at: string;
  updated_at: string;
  learn_count?: number;
  owner_username?: string;
  owner_display_name?: string;
  owner_alias?: string | null;
  owner_avatar_ext?: string | null;
  /** 1 when this row is blocked in the group the management query asked about. */
  blocked?: number;
}

/**
 * Correlated learn-count column for shared_skills SELECTs (전수된 횟수).
 * Counted per (owner, skill_name) from skill_learn_events, so the number
 * survives unshare→re-share (rows are re-created; events are not).
 */
const LEARN_COUNT_COLUMN = `(SELECT COUNT(*) FROM skill_learn_events e
             WHERE e.owner_user_id = s.owner_user_id AND e.skill_name = s.skill_name) AS learn_count`;

/**
 * How many former names one share row remembers. The trail exists so learners'
 * origin markers keep matching after a rename; a marker that stale (five
 * renames without a single 업데이트 받기) is better dropped than carried forever.
 */
const PREVIOUS_NAMES_CAP = 5;

/**
 * Read the rename trail column. Anything unparseable — hand-edited JSON, a
 * value from a future shape — reads as NO trail rather than throwing: a lost
 * trail costs a learner one re-learn, a throw breaks every share listing.
 */
function parsePreviousNames(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Shared FROM/JOIN fragment for "users m1 and m2 share an avatar-sharing
 * group" — the SINGLE source of the co-membership SQL (T3.2). Every
 * visibility/trust/badge query below builds on it, so reach and elevation can
 * never drift apart. A group whose `avatar_sharing` policy is off (explicit 0;
 * NULL = on for pre-policy rows — keep in lockstep with the TS `!== 0` reads)
 * grants NEITHER (nor skill sharing): it drops out of this relation entirely. Binds NO params; consumers append their WHERE over m1/m2/g.
 */
const SHARING_TEAMMATES = `FROM group_members m1
                JOIN group_members m2 ON m1.group_id = m2.group_id
                JOIN groups g ON g.id = m1.group_id
                 AND (g.avatar_sharing IS NULL OR g.avatar_sharing != 0)`;

export function withAvatars<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Avatars extends Base {
    // ---- Avatars (discovery) ---------------------------------------------

    /**
     * Shared visibility WHERE predicate for the discovery queries
     * (listPublishedAvatars + searchAvatars): suspended owners are hidden; the
     * viewer's own avatar always shows, and `group` avatars show to group
     * teammates only (`private` to no one else — there is no wider state).
     * Binds TWO positional params, both the viewer id, in order: the `id = ?`
     * self-exception, then the teammate subquery's `m1.user_id = ?`. Callers
     * must pass `(viewerId, viewerId, ...)`.
     */
    private static readonly VISIBILITY_WHERE = `suspended = 0
             AND (id = ?
              OR (visibility = 'group' AND id IN (
                SELECT m2.user_id ${SHARING_TEAMMATES}
                WHERE m1.user_id = ?
              )))`;

    /**
     * Correlated per-avatar aggregates (plugin_count + updated_at) embedded in the
     * discovery SELECTs so toAvatarSummary reads them off the row instead of
     * issuing two extra queries per avatar. Mirrors avatarUpdatedAt + the enabled
     * plugin count below.
     */
    private static readonly SUMMARY_AGGREGATES = `(SELECT COUNT(*) FROM avatar_plugins p WHERE p.user_id = users.id AND p.enabled = 1) AS plugin_count,
           (SELECT MAX(updated_at) FROM conversations cx WHERE cx.avatar_user_id = users.id AND cx.owner_user_id = users.id) AS updated_at`;

    private avatarUpdatedAt(userId: string): string | null {
      const row = this.db
        .prepare(
          "SELECT MAX(updated_at) AS m FROM conversations WHERE avatar_user_id = ? AND owner_user_id = ?",
        )
        .get(userId, userId) as { m: string | null };
      return row.m;
    }

    /** User ids that share at least one group with `viewerId` (excludes self). */
    private groupTeammateIds(viewerId: string): Set<string> {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT m2.user_id AS id ${SHARING_TEAMMATES}
           WHERE m1.user_id = ? AND m2.user_id != ?`,
        )
        .all(viewerId, viewerId) as { id: string }[];
      return new Set(rows.map((r) => r.id));
    }

    listPublishedAvatars(viewerId: string): AvatarSummary[] {
      // Visibility model: `group` avatars are visible to group teammates only;
      // `private` only to the owner. The viewer's own avatar always shows
      // regardless of visibility; nothing reaches beyond the viewer's groups.
      // (Group co-membership is also what makes teammates mutually elevated —
      // see isTrustedFor, built on the same SHARING_TEAMMATES fragment.)
      const rows = this.db
        .prepare(
          `SELECT *,
           ${Avatars.SUMMARY_AGGREGATES}
           FROM users
           WHERE ${Avatars.VISIBILITY_WHERE}
           ORDER BY display_name COLLATE NOCASE ASC`,
        )
        .all(viewerId, viewerId) as AvatarSummaryRow[];
      const teammates = this.groupTeammateIds(viewerId);
      return rows.map((row) => ({
        ...this.toAvatarSummary(row),
        sharesGroup: teammates.has(row.id),
      }));
    }

    private toAvatarSummary(row: AvatarSummaryRow): AvatarSummary {
      // The discovery queries (listPublishedAvatars/searchAvatars) precompute the
      // enabled-plugin count and last-activity timestamp as correlated subquery
      // columns; getAvatar passes a plain UserRow, so fall back to the per-row
      // queries when those columns are absent.
      const pluginCount =
        row.plugin_count ??
        this.count(
          "SELECT COUNT(*) AS c FROM avatar_plugins WHERE user_id = ? AND enabled = 1",
          row.id,
        );
      const updatedAt =
        row.updated_at !== undefined ? row.updated_at : this.avatarUpdatedAt(row.id);
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        alias: row.alias ?? "",
        bio: row.bio ?? "",
        hashtags: parseHashtags(row.hashtags),
        hasImage: Boolean(row.avatar_ext),
        pluginCount,
        visibility: this.rowVisibility(row),
        updatedAt,
      };
    }

    /**
     * Find avatars visible to the viewer (own + group teammates') whose capabilities match a
     * free-text query, ranked. Matches across hashtags, bio, intro, name, alias,
     * and username; a hashtag hit outranks a body hit. An empty query lists all
     * (capped). Backs the cross-avatar `mcp__avatars__search_avatars` tool, so an
     * avatar can point the user at a teammate avatar that specializes in something
     * it can't do. `excludeId` drops the current avatar from its own results.
     */
    searchAvatars(
      viewerId: string,
      query: string,
      opts: { excludeId?: string; limit?: number } = {},
    ): AvatarSummary[] {
      const limit = Math.min(
        Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1),
        50,
      );
      // Visibility mirrors listPublishedAvatars: the viewer's own avatar plus
      // `group` avatars of group teammates (`private` ones stay owner-only).
      // Suspended users are never discoverable. Keeping this in sync with
      // listPublishedAvatars is what the avatar-directory MCP tool relies on
      // to surface the same teammates the viewer can browse.
      const rows = this.db
        .prepare(
          `SELECT *,
           ${Avatars.SUMMARY_AGGREGATES}
           FROM users
           WHERE ${Avatars.VISIBILITY_WHERE}`,
        )
        .all(viewerId, viewerId) as AvatarSummaryRow[];
      const teammates = this.groupTeammateIds(viewerId);
      const tokens = query
        .toLowerCase()
        .split(/[\s,，、]+/)
        .map((t) => t.replace(/^#+/, "").trim())
        .filter(Boolean);
      const scored = rows
        .filter((row) => row.id !== opts.excludeId)
        .map((row) => {
          const tags = parseHashtags(row.hashtags);
          const tagHay = tags.join(" ").toLowerCase();
          const bodyHay = [
            row.display_name,
            row.alias,
            row.username,
            row.bio,
            row.intro,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          let score = 0;
          // Per token, one tier only: exact hashtag (5) > partial hashtag (3) > body (1).
          for (const token of tokens) {
            if (tags.some((tag) => tag.toLowerCase() === token)) score += 5;
            else if (tagHay.includes(token)) score += 3;
            else if (bodyHay.includes(token)) score += 1;
          }
          return { row, score };
        });
      const matches = tokens.length
        ? scored.filter((s) => s.score > 0)
        : scored;
      matches.sort(
        (a, b) =>
          b.score - a.score ||
          a.row.display_name.localeCompare(b.row.display_name),
      );
      return matches
        .slice(0, limit)
        .map((s) => ({
          ...this.toAvatarSummary(s.row),
          sharesGroup: teammates.has(s.row.id),
        }));
    }

    getAvatar(viewerId: string, id: string): AvatarDetail | null {
      const row = this.userRowById(id);
      if (!row) {
        return null;
      }
      // A suspended owner's avatar is not discoverable/viewable by others (the
      // owner can't log in to view their own either, so the self-exception is moot).
      if (row.suspended === 1 && id !== viewerId) {
        return null;
      }
      const isOwn = id === viewerId;
      const trusted = !isOwn && this.isTrustedFor(viewerId, id);
      if (!isOwn && !this.isVisibleTo(row, viewerId)) {
        return null;
      }
      const plugins = (
        this.db
          .prepare(
            "SELECT repo, label FROM avatar_plugins WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC",
          )
          .all(id) as { repo: string; label: string | null }[]
      ).map((p) => ({ repo: p.repo, label: p.label }));
      return {
        ...this.toAvatarSummary(row),
        persona: row.persona ?? "",
        intro: row.intro ?? "",
        isOwn,
        elevated: isOwn || trusted,
        plugins,
      };
    }

    /**
     * Resolve a chat target avatar: reachable if it's the viewer's own, or visible
     * to the viewer per its visibility — `group` (group teammates) or `private`
     * (owner only). See `isVisibleTo`.
     */
    resolveChatAvatar(
      viewerId: string,
      id: string,
    ): {
      id: string;
      displayName: string;
      alias: string;
      persona: string;
    } | null {
      const row = this.userRowById(id);
      if (!row) {
        return null;
      }
      // A suspended owner's avatar is unreachable for chat (and the scheduler skips
      // suspended owners' routines via listDueRoutineJobs). Self is moot — a
      // suspended user has no session.
      if (row.suspended === 1 && id !== viewerId) {
        return null;
      }
      if (id !== viewerId && !this.isVisibleTo(row, viewerId)) {
        return null;
      }
      return {
        id: row.id,
        displayName: row.display_name,
        alias: row.alias ?? "",
        persona: row.persona ?? "",
      };
    }

    // ---- Trust & visibility ----------------------------------------------
    // Trust (elevated tool access) is derived PURELY from group co-membership:
    // members of the same group are mutually + symmetrically elevated. A trusted
    // viewer chats with someone else's avatar at the OWNER's tool-permission level
    // (the elevated MCP tools, not just the read-only set; pi built-ins run in the
    // viewer's own sandbox either way) — but it does NOT grant the owner-only
    // knowledge inbox.

    /**
     * True when `viewerId` may use tools at the owner's level on `avatarId`'s
     * avatar. The ONLY source is sharing at least one group (see `shareAnyGroup`).
     * This is THE single point every trust/elevated check flows through, so all
     * elevation derives from group membership — manage trust by managing groups.
     */
    isTrustedFor(viewerId: string, avatarId: string): boolean {
      if (!viewerId || !avatarId || viewerId === avatarId) {
        return false;
      }
      return this.shareAnyGroup(viewerId, avatarId);
    }

    /**
     * Whether an avatar row is discoverable/reachable by `viewerId` (NOT counting
     * the self-exception, which callers handle). `group` → group teammates only;
     * `private` → no one. TS mirror of the SQL VISIBILITY_WHERE — both are built
     * on the same teammate relation, so keep them in lockstep. Suspended owners
     * are filtered by the callers before this is consulted.
     */
    private isVisibleTo(row: UserRow, viewerId: string): boolean {
      if (this.rowVisibility(row) === "group") {
        return this.shareAnyGroup(viewerId, row.id);
      }
      return false; // private
    }

    /**
     * True when two distinct users share at least one group. Group co-membership
     * is the sole source of trust (members of the same group are mutually
     * elevated) via `isTrustedFor`, and the same relation gates `group`
     * visibility. Indexed on group_members(user_id).
     */
    private shareAnyGroup(userA: string, userB: string): boolean {
      if (!userA || !userB || userA === userB) {
        return false;
      }
      const row = this.db
        .prepare(
          `SELECT 1 ${SHARING_TEAMMATES}
           WHERE m1.user_id = ? AND m2.user_id = ? LIMIT 1`,
        )
        .get(userA, userB);
      return Boolean(row);
    }

    /**
     * Names of the groups two distinct users share. Explains WHY a viewer is
     * auto-trusted (group co-membership) for the prompt — the trust DECISION
     * itself still goes through `isTrustedFor`/`shareAnyGroup`.
     */
    sharedGroupNames(userA: string, userB: string): string[] {
      if (!userA || !userB || userA === userB) {
        return [];
      }
      const rows = this.db
        .prepare(
          `SELECT DISTINCT g.name AS name ${SHARING_TEAMMATES}
           WHERE m1.user_id = ? AND m2.user_id = ?
           ORDER BY g.name COLLATE NOCASE ASC`,
        )
        .all(userA, userB) as { name: string }[];
      return rows.map((r) => r.name);
    }

    /**
     * Search users by username OR display name (case-insensitive substring) to
     * populate the group member-add picker. `searcherId` is excluded. Prefix
     * matches sort first, then by display name. Returns [] for a blank query.
     * Capped at `limit`.
     */
    searchUsers(
      query: string,
      searcherId: string,
      limit = 8,
    ): { id: string; username: string; displayName: string }[] {
      const q = query.trim();
      if (!q) {
        return [];
      }
      // Escape LIKE wildcards so a literal %, _ or \ in the query stays literal.
      const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const like = `%${esc}%`;
      const prefix = `${esc}%`;
      const rows = this.db
        .prepare(
          `SELECT u.id AS id, u.username AS username, u.display_name AS display_name
           FROM users u
           WHERE u.id != ?
             AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
           ORDER BY
             CASE WHEN u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
             u.display_name COLLATE NOCASE ASC
           LIMIT ?`,
        )
        .all(searcherId, like, like, prefix, prefix, limit) as {
        id: string;
        username: string;
        display_name: string;
      }[];
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
      }));
    }

    // ---- Shared skills (#skill-share) --------------------------------------
    // An owner shares skills FROM their knowledge repo (`skills/<slug>/`); the
    // rows here are metadata snapshots for discovery — content is copied from
    // the owner's clone at learn time (skillTransfer.ts). Reach deliberately
    // mirrors avatar discovery: a viewer sees a share iff they could see the
    // owner's avatar in 탐색 (not suspended, visibility='group', and sharing a
    // group per SHARING_TEAMMATES) — never wider than the avatar itself.

    /**
     * JOIN/WHERE for shares VISIBLE to a viewer. Keep the predicate in lockstep
     * with VISIBILITY_WHERE above, minus the self-exception: a viewer's own
     * shares are managed via listSharedSkillsByOwner, not browsed as learnable.
     * Binds TWO positional params, both the viewer id.
     *
     * The teammate test is an EXISTS over the shared groups rather than
     * VISIBILITY_WHERE's `IN (…)` because a GROUP-CHANNEL BLOCK
     * (shared_skill_group_blocks) removes ONE group from the relation for ONE
     * (owner, skill_name): the share survives as long as SOME mutual sharing
     * group is unblocked, and avatar visibility itself never changes. That
     * per-skill subtraction is the ONLY intended divergence — the
     * suspended/`group`/SHARING_TEAMMATES half stays in lockstep. Enforcing it
     * HERE is what makes it fail closed: every learnable read (listing, by-id,
     * by-name, count) is built on this fragment, so a direct id fetch from
     * preview/learn can't route around a block.
     */
    private static readonly LEARNABLE_SKILLS_FROM = `FROM shared_skills s
           JOIN users u ON u.id = s.owner_user_id
           WHERE u.suspended = 0
             AND s.owner_user_id != ?
             AND u.visibility = 'group'
             AND EXISTS (
               SELECT 1 ${SHARING_TEAMMATES}
               WHERE m1.user_id = ?
                 AND m2.user_id = s.owner_user_id
                 AND NOT EXISTS (
                   SELECT 1 FROM shared_skill_group_blocks b
                   WHERE b.group_id = m1.group_id
                     AND b.owner_user_id = s.owner_user_id
                     AND b.skill_name = s.skill_name
                 )
             )`;

    /**
     * The EFFECTIVE description resolution lives HERE, in the one mapper every
     * shared_skills read passes through: the owner's custom introduction when
     * set, else the frontmatter snapshot. Consumers (feed, preview header, MCP
     * find, group management) read `description` and cannot drift apart; the
     * two raw columns stay available for the owner's own UIs and for the mine
     * reconciliation, which must compare the SNAPSHOT only.
     */
    private toSharedSkill(row: SharedSkillRow): SharedSkill {
      return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        skillName: row.skill_name,
        displayName: row.display_name,
        description: row.custom_description ?? row.description ?? "",
        customDescription: row.custom_description ?? null,
        snapshotDescription: row.description ?? "",
        learnCount: row.learn_count ?? 0,
        contentHash: row.content_hash ?? null,
        previousNames: parsePreviousNames(row.previous_names),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }

    private toSharedSkillListing(row: SharedSkillRow): SharedSkillListing {
      return {
        ...this.toSharedSkill(row),
        owner: {
          id: row.owner_user_id,
          username: row.owner_username ?? "",
          displayName: row.owner_display_name ?? "",
          alias: row.owner_alias ?? "",
          hasImage: Boolean(row.owner_avatar_ext),
        },
      };
    }

    /**
     * Share (or re-share) one knowledge-repo skill. Upsert: re-sharing an
     * already-shared slug refreshes the metadata snapshot + updated_at and
     * keeps the row id. Callers validate that `skills/<skillName>/` actually
     * exists in the owner's repo BEFORE calling.
     *
     * `description` is the frontmatter SNAPSHOT column only. The owner's custom
     * introduction is deliberately absent from the conflict update, so a
     * re-share (and every reconciliation re-snapshot) leaves it standing —
     * setSharedSkillDescription is the single write point for it.
     */
    shareSkill(
      ownerUserId: string,
      skill: {
        skillName: string;
        displayName: string;
        description: string;
        contentHash?: string | null;
      },
    ): SharedSkill {
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO shared_skills (id, owner_user_id, skill_name, display_name, description, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_user_id, skill_name) DO UPDATE SET
             display_name = excluded.display_name,
             description = excluded.description,
             content_hash = COALESCE(excluded.content_hash, shared_skills.content_hash),
             updated_at = excluded.updated_at`,
        )
        .run(
          crypto.randomUUID(),
          ownerUserId,
          skill.skillName,
          skill.displayName,
          skill.description,
          skill.contentHash ?? null,
          timestamp,
          timestamp,
        );
      return this.readOwnShare(ownerUserId, skill.skillName)!;
    }

    /**
     * Refresh ONE share's content fingerprint without touching updated_at —
     * used when a TEAMMATE's preview/learn observes drift (a viewer action
     * must not reorder the owner's listing; owner-side reconciliation goes
     * through shareSkill, which does bump it).
     */
    setSharedSkillContentHash(
      ownerUserId: string,
      skillName: string,
      contentHash: string | null,
    ): void {
      this.db
        .prepare(
          "UPDATE shared_skills SET content_hash = ? WHERE owner_user_id = ? AND skill_name = ?",
        )
        .run(contentHash, ownerUserId, skillName);
    }

    /**
     * Move one share onto a RENAMED skill directory. The row keeps its id,
     * created_at and custom_description — a rename is the same share under a
     * new name, not an unshare plus a re-share — and takes the new slug, a
     * fresh metadata snapshot, and the old name appended to its rename trail.
     *
     * Everything else keyed by the skill NAME moves with it in the SAME
     * transaction, or the rename would silently drop moderation and history:
     *
     * - `shared_skill_group_blocks` is COPIED to the new name (INSERT OR IGNORE
     *   merges with a block already standing there — never lost, never
     *   duplicated) and the old name's blocks are LEFT IN PLACE. Blocks are
     *   name-keyed anti-evasion, which is why they already survive
     *   unshare→re-share; letting two `git mv`s clear one would hand every
     *   owner a way around a group admin's decision. Only an explicit unblock
     *   removes a block, so re-minting a share under the freed old name stays
     *   blocked.
     * - `skill_learn_events` is re-keyed onto the new name, and any event
     *   ALREADY under that name is deleted first. The collision guard below
     *   proved no live share holds it, so those are orphans of a dead share
     *   whose name this one is taking over — counted by name, they would
     *   permanently inflate the renamed skill's 전수 count. The trade-off is
     *   deliberate: the dead share's history (restorable by re-sharing under
     *   its own name) is forfeited once another skill claims the name.
     *
     * `bumpUpdatedAt` is the owner/viewer split: owner-side reconciliation
     * bumps (the listing legitimately reorders), while a VIEWER's preview/learn
     * rescue must not reorder the owner's listing — same invariant as
     * setSharedSkillContentHash.
     *
     * Returns null WITHOUT side effects when there is no row under
     * `fromSkillName`, or when `toSkillName` is already shared (the caller
     * falls back to unsharing the stale row — merging two shares would silently
     * pick one row's introduction and learn history over the other's).
     */
    renameSharedSkill(
      ownerUserId: string,
      fromSkillName: string,
      toSkillName: string,
      next: {
        displayName: string;
        description: string;
        contentHash: string | null;
        bumpUpdatedAt: boolean;
      },
    ): SharedSkill | null {
      const move = this.db.transaction((): boolean => {
        const row = this.db
          .prepare("SELECT * FROM shared_skills WHERE owner_user_id = ? AND skill_name = ?")
          .get(ownerUserId, fromSkillName) as SharedSkillRow | undefined;
        if (!row || fromSkillName === toSkillName) {
          return false;
        }
        const taken = this.db
          .prepare(
            "SELECT 1 AS taken FROM shared_skills WHERE owner_user_id = ? AND skill_name = ?",
          )
          .get(ownerUserId, toSkillName);
        if (taken) {
          return false;
        }
        // Oldest first, most recent last, deduped, and never carrying the name
        // the row is moving TO (a → b → a must leave a trail of just "b").
        const trail = [
          ...parsePreviousNames(row.previous_names).filter(
            (name) => name !== fromSkillName && name !== toSkillName,
          ),
          fromSkillName,
        ].slice(-PREVIOUS_NAMES_CAP);
        this.db
          .prepare(
            `UPDATE shared_skills
                SET skill_name = ?, display_name = ?, description = ?, content_hash = ?,
                    previous_names = ?, updated_at = ?
              WHERE owner_user_id = ? AND skill_name = ?`,
          )
          .run(
            toSkillName,
            next.displayName,
            next.description,
            next.contentHash,
            JSON.stringify(trail),
            next.bumpUpdatedAt ? now() : row.updated_at,
            ownerUserId,
            fromSkillName,
          );
        this.db
          .prepare(
            "DELETE FROM skill_learn_events WHERE owner_user_id = ? AND skill_name = ?",
          )
          .run(ownerUserId, toSkillName);
        this.db
          .prepare(
            "UPDATE skill_learn_events SET skill_name = ? WHERE owner_user_id = ? AND skill_name = ?",
          )
          .run(toSkillName, ownerUserId, fromSkillName);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO shared_skill_group_blocks
               (group_id, owner_user_id, skill_name, blocked_by, created_at)
             SELECT group_id, owner_user_id, ?, blocked_by, created_at
               FROM shared_skill_group_blocks
              WHERE owner_user_id = ? AND skill_name = ?`,
          )
          .run(toSkillName, ownerUserId, fromSkillName);
        return true;
      });
      return move() ? this.readOwnShare(ownerUserId, toSkillName) : null;
    }

    /**
     * Set (or clear) the owner's custom INTRODUCTION for one share — the
     * human-facing card text. Empty/whitespace clears it, so viewers fall back
     * to the frontmatter snapshot; the snapshot column is never touched here.
     * Bumps updated_at like a re-share does: this is an owner-initiated change
     * to what teammates see, unlike a viewer's fingerprint refresh. Returns the
     * refreshed row, or null when the skill isn't shared.
     */
    setSharedSkillDescription(
      ownerUserId: string,
      skillName: string,
      customDescription: string | null,
    ): SharedSkill | null {
      const value = customDescription?.trim() || null;
      const changed = this.db
        .prepare(
          `UPDATE shared_skills SET custom_description = ?, updated_at = ?
           WHERE owner_user_id = ? AND skill_name = ?`,
        )
        .run(value, now(), ownerUserId, skillName).changes;
      return changed > 0 ? this.readOwnShare(ownerUserId, skillName) : null;
    }

    /** One of an owner's OWN share rows (no visibility filter — it's theirs). */
    private readOwnShare(ownerUserId: string, skillName: string): SharedSkill | null {
      const row = this.db
        .prepare(
          `SELECT s.*, ${LEARN_COUNT_COLUMN} FROM shared_skills s
           WHERE s.owner_user_id = ? AND s.skill_name = ?`,
        )
        .get(ownerUserId, skillName) as SharedSkillRow | undefined;
      return row ? this.toSharedSkill(row) : null;
    }

    /**
     * Drop EVERY share of one owner — used when their knowledge repo is
     * disconnected or repointed (the rows advertise `skills/` dirs of the
     * previous repo, which no longer resolve). Returns how many were dropped.
     */
    clearSharedSkills(ownerUserId: string): number {
      return this.db
        .prepare("DELETE FROM shared_skills WHERE owner_user_id = ?")
        .run(ownerUserId).changes;
    }

    /** Stop sharing one skill. False when it wasn't shared. */
    unshareSkill(ownerUserId: string, skillName: string): boolean {
      const res = this.db
        .prepare(
          "DELETE FROM shared_skills WHERE owner_user_id = ? AND skill_name = ?",
        )
        .run(ownerUserId, skillName);
      return res.changes > 0;
    }

    /** Every skill this owner currently shares (settings/mine view + prompt). */
    listSharedSkillsByOwner(ownerUserId: string): SharedSkill[] {
      const rows = this.db
        .prepare(
          `SELECT s.*, ${LEARN_COUNT_COLUMN} FROM shared_skills s
           WHERE s.owner_user_id = ? ORDER BY s.skill_name COLLATE NOCASE ASC`,
        )
        .all(ownerUserId) as SharedSkillRow[];
      return rows.map((row) => this.toSharedSkill(row));
    }

    /**
     * Record one successful learn (전수) of `ownerUserId`'s `skillName` by
     * `learnerUserId`. Called by the learn route + MCP tool AFTER the copy and
     * commit succeed, never before.
     */
    recordSkillLearn(ownerUserId: string, skillName: string, learnerUserId: string): void {
      this.db
        .prepare(
          `INSERT INTO skill_learn_events (id, owner_user_id, skill_name, learner_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), ownerUserId, skillName, learnerUserId, now());
    }

    /**
     * Learn counts for EVERY skill name of one owner (shared or not — events
     * outlive the share row, so a re-shared or currently-unshared skill keeps
     * its history). Backs the mine view's per-skill 전수 badge.
     */
    skillLearnCounts(ownerUserId: string): Record<string, number> {
      const rows = this.db
        .prepare(
          `SELECT skill_name, COUNT(*) AS c FROM skill_learn_events
           WHERE owner_user_id = ? GROUP BY skill_name`,
        )
        .all(ownerUserId) as { skill_name: string; c: number }[];
      return Object.fromEntries(rows.map((r) => [r.skill_name, r.c]));
    }

    /** Total learns across all of one owner's skills (describe_system fact). */
    countSkillLearnsForOwner(ownerUserId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM skill_learn_events WHERE owner_user_id = ?",
        ownerUserId,
      );
    }

    /**
     * Skills shared by teammates whose avatar the viewer can see, newest first,
     * optionally filtered by free-text tokens across the skill name/description
     * and owner name (a name hit ranks under a skill-field hit). Backs the
     * 스킬 배우기 tab and the `mcp__skill_exchange__find_shared_skills` tool.
     */
    listLearnableSkills(
      viewerId: string,
      query = "",
      opts: { limit?: number } = {},
    ): SharedSkillListing[] {
      const limit = Math.min(Math.max(opts.limit ?? DEFAULT_SEARCH_LIMIT, 1), 100);
      const rows = this.db
        .prepare(
          `SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name,
                  u.alias AS owner_alias, u.avatar_ext AS owner_avatar_ext,
                  ${LEARN_COUNT_COLUMN}
           ${Avatars.LEARNABLE_SKILLS_FROM}
           ORDER BY s.updated_at DESC`,
        )
        .all(viewerId, viewerId) as SharedSkillRow[];
      const tokens = query
        .toLowerCase()
        .split(/[\s,，、]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (tokens.length === 0) {
        return rows.slice(0, limit).map((row) => this.toSharedSkillListing(row));
      }
      const scored = rows.map((row) => {
        // Both description columns: the custom intro is what the browser READS
        // on the card, the snapshot is what the skill says about itself.
        const skillHay = [
          row.skill_name,
          row.display_name,
          row.custom_description,
          row.description,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const ownerHay = [row.owner_display_name, row.owner_alias, row.owner_username]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        let score = 0;
        // Per token, one tier only: skill name/description (3) > owner (1).
        for (const token of tokens) {
          if (skillHay.includes(token)) score += 3;
          else if (ownerHay.includes(token)) score += 1;
        }
        return { row, score };
      });
      return scored
        .filter((s) => s.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at),
        )
        .slice(0, limit)
        .map((s) => this.toSharedSkillListing(s.row));
    }

    /** One learnable share by row id, visibility-checked for the viewer. */
    getLearnableSkill(viewerId: string, id: string): SharedSkillListing | null {
      const row = this.db
        .prepare(
          `SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name,
                  u.alias AS owner_alias, u.avatar_ext AS owner_avatar_ext,
                  ${LEARN_COUNT_COLUMN}
           ${Avatars.LEARNABLE_SKILLS_FROM}
             AND s.id = ?`,
        )
        .get(viewerId, viewerId, id) as SharedSkillRow | undefined;
      return row ? this.toSharedSkillListing(row) : null;
    }

    /**
     * One learnable share by owner @username + skill slug (the address the
     * MCP find tool prints), visibility-checked for the viewer.
     */
    getLearnableSkillByName(
      viewerId: string,
      ownerUsername: string,
      skillName: string,
    ): SharedSkillListing | null {
      const row = this.db
        .prepare(
          `SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name,
                  u.alias AS owner_alias, u.avatar_ext AS owner_avatar_ext,
                  ${LEARN_COUNT_COLUMN}
           ${Avatars.LEARNABLE_SKILLS_FROM}
             AND u.username = ? AND s.skill_name = ?`,
        )
        .get(viewerId, viewerId, ownerUsername, skillName) as
        | SharedSkillRow
        | undefined;
      return row ? this.toSharedSkillListing(row) : null;
    }

    /** How many shares are learnable by this viewer (metacognition surfaces). */
    countLearnableSkills(viewerId: string): number {
      return this.count(
        `SELECT COUNT(*) AS c ${Avatars.LEARNABLE_SKILLS_FROM}`,
        viewerId,
        viewerId,
      );
    }

    // ---- Group-channel blocks (group-admin moderation) ---------------------
    // A group admin may take a member's shared skill out of THEIR group's
    // discovery channel. The block is keyed by (group, owner, skill NAME) —
    // like skill_learn_events, NOT the share-row id, so an unshare→re-share
    // can't evade it — and it subtracts exactly one group from
    // LEARNABLE_SKILLS_FROM's teammate relation: another mutual sharing group
    // still carries the skill, avatar visibility is untouched, and copies
    // already learned stay in their learners' repos.

    /**
     * Every share by a MEMBER of this group, with its owner, 전수 count, and
     * whether it is blocked in THIS group — the group-admin management view.
     * Unlike the learnable listing this is not viewer-scoped: an admin manages
     * their channel, so blocked rows stay listed (that's how they're unblocked).
     */
    listGroupSharedSkills(groupId: string): GroupSharedSkill[] {
      const rows = this.db
        .prepare(
          `SELECT s.*, u.username AS owner_username, u.display_name AS owner_display_name,
                  u.alias AS owner_alias, u.avatar_ext AS owner_avatar_ext,
                  ${LEARN_COUNT_COLUMN},
                  EXISTS (SELECT 1 FROM shared_skill_group_blocks b
                          WHERE b.group_id = ?
                            AND b.owner_user_id = s.owner_user_id
                            AND b.skill_name = s.skill_name) AS blocked
           FROM shared_skills s
           JOIN users u ON u.id = s.owner_user_id
           JOIN group_members m ON m.user_id = s.owner_user_id AND m.group_id = ?
           ORDER BY u.display_name COLLATE NOCASE ASC, s.skill_name COLLATE NOCASE ASC`,
        )
        .all(groupId, groupId) as SharedSkillRow[];
      return rows.map((row) => ({
        ...this.toSharedSkillListing(row),
        blocked: row.blocked === 1,
      }));
    }

    /**
     * Block one owner's skill in one group's channel (idempotent — an already
     * blocked row keeps its original blocker/timestamp). Deliberately does NOT
     * require a live share row: the key is the skill NAME, so blocking survives
     * (and pre-empts) an unshare→re-share cycle.
     */
    blockSharedSkillInGroup(
      groupId: string,
      ownerUserId: string,
      skillName: string,
      blockedBy: string | null = null,
    ): void {
      this.db
        .prepare(
          `INSERT INTO shared_skill_group_blocks (group_id, owner_user_id, skill_name, blocked_by, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (group_id, owner_user_id, skill_name) DO NOTHING`,
        )
        .run(groupId, ownerUserId, skillName, blockedBy, now());
    }

    /** Lift a group-channel block. False when it wasn't blocked. */
    unblockSharedSkillInGroup(
      groupId: string,
      ownerUserId: string,
      skillName: string,
    ): boolean {
      return (
        this.db
          .prepare(
            "DELETE FROM shared_skill_group_blocks WHERE group_id = ? AND owner_user_id = ? AND skill_name = ?",
          )
          .run(groupId, ownerUserId, skillName).changes > 0
      );
    }
  };
}
