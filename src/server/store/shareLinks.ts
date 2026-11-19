import {
  EXPIRED_SHARE_LINK_RETENTION_DAYS,
  MAX_ACTIVE_SHARE_LINKS,
  MAX_SHARE_LINK_SLIDES,
  type ShareLinkKind,
} from "../../shared/shareLinks.js";
import { type Constructor, type StoreBase, now } from "./internal.js";

// Share links (see the share_links table comment in internal.ts). This mixin
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
  kind: string | null;
  through_message_id: string | null;
  include_files: number | null;
  source_path: string | null;
  /** Conversation links only (a correlated count in SELECT_LINK): user/assistant rows up to the anchor. */
  message_count: number | null;
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
  /** What the link exports: one file card, a conversation up to `throughMessageId`, or a workspace file's copy. */
  kind: ShareLinkKind;
  ownerUserId: string;
  conversationId: string;
  /** The card's id; '' on a conversation link. */
  fileId: string;
  /** The file's download name; on a conversation link the conversation's title when it was made. */
  fileName: string;
  /** Conversation links: the last message the link shows (null on a file link). */
  throughMessageId: string | null;
  /** Conversation links: whether the avatar-delivered file cards in range can be downloaded. */
  includeFiles: boolean;
  /** Conversation links: user/assistant messages in range right now (0 once the anchor is gone). */
  messageCount: number;
  /** Workspace-file links: the file's workspace path when the copy was taken ('' otherwise). */
  sourcePath: string;
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
  /** Default "file". */
  kind?: ShareLinkKind;
  ownerUserId: string;
  conversationId: string;
  /** '' on a conversation link. */
  fileId: string;
  fileName: string;
  slideIds: string[];
  /** Conversation links only. */
  throughMessageId?: string;
  includeFiles?: boolean;
  /** Workspace-file links only: part of what "the same target" means for reuse. */
  sourcePath?: string;
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

// How many user/assistant rows a conversation link shows NOW: those at or
// before its anchor row (0 once the anchor is gone — the link is then dead).
const MESSAGE_COUNT = `(CASE WHEN s.kind = 'conversation' THEN (
    SELECT COUNT(*) FROM messages m
     WHERE m.conversation_id = s.conversation_id AND m.role IN ('user', 'assistant')
       AND m.rowid <= (SELECT a.rowid FROM messages a WHERE a.id = s.through_message_id AND a.conversation_id = s.conversation_id)
  ) ELSE 0 END) AS message_count`;
const SELECT_LINK = `SELECT s.*, c.title AS conversation_title, ${MESSAGE_COUNT}
  FROM share_links s LEFT JOIN conversations c ON c.id = s.conversation_id`;
// JOIN (not LEFT JOIN) users: a row whose creator is gone is no link at all.
const SELECT_LINK_WITH_OWNER = `SELECT s.*, c.title AS conversation_title, ${MESSAGE_COUNT},
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
    // Anything but a known other kind is a file link (NULL on old rows).
    kind: row.kind === "conversation" || row.kind === "workspace_file" ? row.kind : "file",
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    fileId: row.file_id,
    fileName: row.file_name,
    throughMessageId: row.through_message_id ?? null,
    includeFiles: row.include_files === 1,
    messageCount: row.message_count ?? 0,
    sourcePath: row.source_path ?? "",
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
     * Create a link, or return the ACTIVE one that already exists for the same
     * target — (owner, conversation, file) for a card, (owner, conversation)
     * for a conversation, (owner, workspace path) for a workspace file: one
     * active link per target; changing the expiry (or
     * a conversation link's range) means revoke, then create. The per-user cap counts active links
     * only and never blocks the reuse path. One transaction, so the reuse check,
     * the cap and the insert cannot interleave with another create.
     */
    createShareLink(input: NewShareLink): CreateShareLinkResult {
      return this.db.transaction((): CreateShareLinkResult => {
        this.pruneExpiredShareLinks();
        const kind: ShareLinkKind = input.kind ?? "file";
        const sourcePath = kind === "workspace_file" ? (input.sourcePath ?? "") : "";
        const existing = this.db
          .prepare(
            `${SELECT_LINK} WHERE s.owner_user_id = ? AND s.conversation_id = ? AND s.file_id = ?
               AND COALESCE(s.kind, 'file') = ? AND COALESCE(s.source_path, '') = ? AND s.expires_at > ?
             ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`,
          )
          .get(input.ownerUserId, input.conversationId, input.fileId, kind, sourcePath, input.createdAt) as
          | ShareLinkRow
          | undefined;
        if (existing) {
          return { status: "reused", link: toRecord(existing) };
        }
        if (this.countActiveShareLinks(input.ownerUserId, input.createdAt) >= MAX_ACTIVE_SHARE_LINKS) {
          return { status: "cap" };
        }
        this.db
          .prepare(
            `INSERT INTO share_links (id, owner_user_id, conversation_id, file_id, file_name, slide_ids_json, token_hash, token_salt, created_at, expires_at, kind, through_message_id, include_files, source_path)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            kind,
            kind === "conversation" ? (input.throughMessageId ?? null) : null,
            kind === "conversation" && input.includeFiles ? 1 : 0,
            sourcePath || null,
          );
        const created = this.db.prepare(`${SELECT_LINK} WHERE s.id = ?`).get(input.id) as ShareLinkRow;
        return { status: "created", link: toRecord(created) };
      })();
    }

    /**
     * The owner's links: active first, then expired ones still inside the
     * retention window, newest first within each, at most
     * {@link SHARE_LINK_LIST_LIMIT}. Optionally narrowed to one conversation,
     * file and/or kind (the link dialog). Prunes globally first.
     */
    listShareLinks(
      ownerUserId: string,
      filter: { conversationId?: string; fileId?: string; kind?: ShareLinkKind; sourcePath?: string } = {},
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
      if (filter.kind) {
        where.push("COALESCE(s.kind, 'file') = ?");
        params.push(filter.kind);
      }
      if (filter.sourcePath) {
        where.push("s.source_path = ?");
        params.push(filter.sourcePath);
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

    /**
     * The ids of every UNEXPIRED workspace-file link — the copies that must stay
     * on disk. Whatever else sits in the copy store is an orphan (its row was
     * revoked, pruned, expired or went with its owner) and is swept
     * (`shareFiles.ts` `sweepShareFileCopies`).
     */
    listLiveWorkspaceShareLinkIds(at: string = now()): string[] {
      const rows = this.db
        .prepare("SELECT id FROM share_links WHERE kind = 'workspace_file' AND expires_at > ?")
        .all(at) as { id: string }[];
      return rows.map((row) => row.id);
    }

    /** Drop one row by id whatever its owner — the create path undoing a row whose copy could not be written. */
    deleteShareLinkRow(id: string): void {
      this.db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
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
      // file_id '' is a conversation link's, never a card's.
      const del = this.db.prepare("DELETE FROM share_links WHERE conversation_id = ? AND file_id = ? AND file_id <> ''");
      this.db.transaction(() => {
        for (const fileId of fileIds) del.run(conversationId, fileId);
      })();
    }

    /**
     * The cascade of every path that deletes SOME of a conversation's messages
     * (rewind/regenerate, a routine thread's prune): a conversation link whose
     * anchor row is gone no longer has a range to show, so it goes too. A link
     * whose anchor survived keeps showing exactly what it showed.
     */
    deleteConversationShareLinksWithoutAnchor(conversationId: string): void {
      this.db
        .prepare(
          `DELETE FROM share_links WHERE conversation_id = ? AND kind = 'conversation'
             AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = share_links.through_message_id AND m.conversation_id = share_links.conversation_id)`,
        )
        .run(conversationId);
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
