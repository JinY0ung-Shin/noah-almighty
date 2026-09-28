import {
  EXPIRED_SHARE_LINK_RETENTION_DAYS,
  MAX_ACTIVE_SHARE_LINKS,
  MAX_SHARE_LINK_SLIDES,
} from "../../shared/shareLinks.js";
import { type Constructor, type StoreBase, now } from "./internal.js";

// PPT share links (see the share_links table comment in internal.ts). This mixin
// is storage only: token/ticket derivation, which threads may share, and the
// per-call recipient validity all live in the service (../shareLinks.ts), so the
// share router and the chat route's onShareLink host callback cannot drift.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows one owner listing returns at most (active first, then newest). */
export const SHARE_LINK_LIST_LIMIT = 200;

interface ShareLinkRow {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  file_id: string;
  file_name: string;
  slide_ids_json: string;
  token_hash: string;
  token_salt: string;
  created_at: string;
  expires_at: string;
  view_count: number;
  last_viewed_at: string | null;
  conversation_title: string | null;
}

interface ShareLinkOwnerRow extends ShareLinkRow {
  owner_display_name: string;
  owner_username: string;
  owner_suspended: number | null;
}

/**
 * One share_links row as the share-link service reads it. `tokenHash` and
 * `tokenSalt` never leave the server (the wire shapes are `ShareLinkSummary` /
 * `ShareViewPayload`, built field by field) and are never logged.
 */
export interface ShareLinkRecord {
  id: string;
  ownerUserId: string;
  conversationId: string;
  fileId: string;
  fileName: string;
  slideIds: string[];
  tokenHash: string;
  /** The row's random salt: the token and every viewer ticket are MACed over it. */
  tokenSalt: string;
  createdAt: string;
  expiresAt: string;
  viewCount: number;
  lastViewedAt: string | null;
  /** The conversation's title at read time (null when it has none or is gone). */
  conversationTitle: string | null;
}

/** A row joined with its creator — what every recipient call validates. */
export interface ShareLinkLookup extends ShareLinkRecord {
  ownerDisplayName: string;
  ownerUsername: string;
  ownerSuspended: boolean;
}

export interface NewShareLink {
  id: string;
  ownerUserId: string;
  conversationId: string;
  fileId: string;
  fileName: string;
  slideIds: string[];
  tokenHash: string;
  /** Required: a row without its salt could never have its token recomputed. */
  tokenSalt: string;
  /** Also the "now" the active-link and cap checks run against. */
  createdAt: string;
  expiresAt: string;
}

export type CreateShareLinkResult =
  | { status: "created" | "reused"; link: ShareLinkRecord }
  | { status: "cap" };

const SELECT_LINK = `SELECT s.*, c.title AS conversation_title
  FROM share_links s LEFT JOIN conversations c ON c.id = s.conversation_id`;
// JOIN (not LEFT JOIN) users: a row whose creator is gone is no link at all.
const SELECT_LINK_WITH_OWNER = `SELECT s.*, c.title AS conversation_title,
  u.display_name AS owner_display_name, u.username AS owner_username, u.suspended AS owner_suspended
  FROM share_links s JOIN users u ON u.id = s.owner_user_id
  LEFT JOIN conversations c ON c.id = s.conversation_id`;

/** Tolerant read of slide_ids_json: a corrupt row degrades to download-only, never throws. */
function parseSlideIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(0, MAX_SHARE_LINK_SLIDES)
      : [];
  } catch {
    return [];
  }
}

function toRecord(row: ShareLinkRow): ShareLinkRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    fileId: row.file_id,
    fileName: row.file_name,
    slideIds: parseSlideIds(row.slide_ids_json),
    tokenHash: row.token_hash,
    tokenSalt: row.token_salt,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewCount: row.view_count,
    lastViewedAt: row.last_viewed_at,
    conversationTitle: row.conversation_title ?? null,
  };
}

function toLookup(row: ShareLinkOwnerRow | undefined): ShareLinkLookup | null {
  return row
    ? {
        ...toRecord(row),
        ownerDisplayName: row.owner_display_name,
        ownerUsername: row.owner_username,
        ownerSuspended: row.owner_suspended === 1,
      }
    : null;
}

export function withShareLinks<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class extends Base {
    /**
     * Create a link for one card, or return the ACTIVE one that already exists
     * for (owner, conversation, file) — one active link per card; changing the
     * expiry means revoke, then create. The per-user cap counts active links
     * only and never blocks the reuse path. One transaction, so the reuse check,
     * the cap and the insert cannot interleave with another create.
     */
    createShareLink(input: NewShareLink): CreateShareLinkResult {
      return this.db.transaction((): CreateShareLinkResult => {
        this.pruneExpiredShareLinks();
        const existing = this.db
          .prepare(
            `${SELECT_LINK} WHERE s.owner_user_id = ? AND s.conversation_id = ? AND s.file_id = ? AND s.expires_at > ?
             ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
          )
          .get(input.ownerUserId, input.conversationId, input.fileId, input.createdAt) as ShareLinkRow | undefined;
        if (existing) {
          return { status: "reused", link: toRecord(existing) };
        }
        if (this.countActiveShareLinks(input.ownerUserId, input.createdAt) >= MAX_ACTIVE_SHARE_LINKS) {
          return { status: "cap" };
        }
        this.db
          .prepare(
            `INSERT INTO share_links (id, owner_user_id, conversation_id, file_id, file_name, slide_ids_json, token_hash, token_salt, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.ownerUserId,
            input.conversationId,
            input.fileId,
            input.fileName,
            JSON.stringify(input.slideIds.slice(0, MAX_SHARE_LINK_SLIDES)),
            input.tokenHash,
            input.tokenSalt,
            input.createdAt,
            input.expiresAt,
          );
        const created = this.db.prepare(`${SELECT_LINK} WHERE s.id = ?`).get(input.id) as ShareLinkRow;
        return { status: "created", link: toRecord(created) };
      })();
    }

    /**
     * The owner's links: active first, then expired ones still inside the
     * retention window, newest first within each, at most
     * {@link SHARE_LINK_LIST_LIMIT}. Optionally narrowed to one conversation
     * and/or file (the file card's dialog). Prunes globally first.
     */
    listShareLinks(
      ownerUserId: string,
      filter: { conversationId?: string; fileId?: string } = {},
    ): ShareLinkRecord[] {
      this.pruneExpiredShareLinks();
      const where = ["s.owner_user_id = ?"];
      const params: unknown[] = [ownerUserId];
      if (filter.conversationId) {
        where.push("s.conversation_id = ?");
        params.push(filter.conversationId);
      }
      if (filter.fileId) {
        where.push("s.file_id = ?");
        params.push(filter.fileId);
      }
      const rows = this.db
        .prepare(
          `${SELECT_LINK} WHERE ${where.join(" AND ")}
           ORDER BY (s.expires_at > ?) DESC, s.created_at DESC, s.rowid DESC LIMIT ?`,
        )
        .all(...params, now(), SHARE_LINK_LIST_LIMIT) as ShareLinkRow[];
      return rows.map(toRecord);
    }

    /** Recipient lookup by the stored hash of the presented token (the regex runs first, in the service). */
    getShareLinkByTokenHash(tokenHash: string): ShareLinkLookup | null {
      return toLookup(
        this.db.prepare(`${SELECT_LINK_WITH_OWNER} WHERE s.token_hash = ?`).get(tokenHash) as
          | ShareLinkOwnerRow
          | undefined,
      );
    }

    /** Recipient lookup by id (a verified viewer ticket names the link). */
    getShareLink(id: string): ShareLinkLookup | null {
      return toLookup(
        this.db.prepare(`${SELECT_LINK_WITH_OWNER} WHERE s.id = ?`).get(id) as ShareLinkOwnerRow | undefined,
      );
    }

    /**
     * Revoke = delete (active and expired rows alike), owner-scoped. Returns the
     * removed row (the audit names its file), or null when the caller owns no
     * such link.
     */
    revokeShareLink(ownerUserId: string, id: string): ShareLinkRecord | null {
      return this.db.transaction((): ShareLinkRecord | null => {
        const row = this.db
          .prepare(`${SELECT_LINK} WHERE s.id = ? AND s.owner_user_id = ?`)
          .get(id, ownerUserId) as ShareLinkRow | undefined;
        if (!row) return null;
        this.db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
        return toRecord(row);
      })();
    }

    /** One recipient view (the owner's own opens are not counted — the service decides). */
    recordShareLinkView(id: string): void {
      this.db
        .prepare("UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?")
        .run(now(), id);
    }

    countActiveShareLinks(ownerUserId: string, at: string = now()): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM share_links WHERE owner_user_id = ? AND expires_at > ?",
        ownerUserId,
        at,
      );
    }

    /** Manual cascade next to every deleteCanvasArtifactsForConversation call. */
    deleteShareLinksForConversation(conversationId: string): void {
      this.db.prepare("DELETE FROM share_links WHERE conversation_id = ?").run(conversationId);
    }

    /** Regenerate cascade: the replaced turn's cards are deleted from disk, so are their links. */
    deleteShareLinksForFiles(conversationId: string, fileIds: readonly string[]): void {
      if (fileIds.length === 0) return;
      const del = this.db.prepare("DELETE FROM share_links WHERE conversation_id = ? AND file_id = ?");
      this.db.transaction(() => {
        for (const fileId of fileIds) del.run(conversationId, fileId);
      })();
    }

    /**
     * Drop links that expired more than EXPIRED_SHARE_LINK_RETENTION_DAYS ago —
     * GLOBALLY, in one statement, so an inactive owner's rows cannot linger.
     * Runs on create and on list; an expired row inside the window stays so its
     * owner can see what lapsed.
     */
    pruneExpiredShareLinks(): void {
      const cutoff = new Date(Date.now() - EXPIRED_SHARE_LINK_RETENTION_DAYS * DAY_MS).toISOString();
      this.db.prepare("DELETE FROM share_links WHERE expires_at < ?").run(cutoff);
    }
  };
}
