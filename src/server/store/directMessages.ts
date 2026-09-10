import type { DirectMessage, DirectMessageInbox, DirectMessagePage } from "../../shared/directMessages.js";
import { type Constructor, type StoreBase, PRESENCE_WINDOW_MS, now } from "./internal.js";

// DM presence deliberately shares the admin presence window (PRESENCE_WINDOW_MS) so both surfaces agree on "접속 중".
const MESSAGE_COLUMNS = "id, sender_id AS senderId, recipient_id AS recipientId, text, created_at AS createdAt";

export function withDirectMessages<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class DirectMessages extends Base {
    directMessageInbox(userId: string): DirectMessageInbox {
      const peers = this.db.prepare(`
        SELECT u.id, u.username, u.display_name AS displayName,
          (u.suspended = 0 AND u.last_seen_at > @since AND EXISTS (
            SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > @now
          )) AS online, (u.suspended = 0) AS available,
          (SELECT COUNT(*) FROM direct_messages d WHERE d.sender_id = u.id
            AND d.recipient_id = @id AND d.read_at IS NULL) AS unread
        FROM users u WHERE u.id != @id AND (
          (u.suspended = 0 AND u.last_seen_at > @since AND EXISTS (
            SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > @now
          )) OR EXISTS (SELECT 1 FROM direct_messages d
            WHERE (d.sender_id = @id AND d.recipient_id = u.id)
               OR (d.sender_id = u.id AND d.recipient_id = @id))
        ) ORDER BY unread DESC, online DESC, u.display_name, u.id
      `).all({ id: userId, since: new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString(), now: now() }) as {
        id: string; username: string; displayName: string; online: number | null; available: number; unread: number;
      }[];
      return {
        peers: peers.map(p => ({ ...p, online: Boolean(p.online), available: Boolean(p.available) })),
        unread: peers.reduce((sum, p) => sum + p.unread, 0),
        windowMinutes: Math.round(PRESENCE_WINDOW_MS / 60_000),
      };
    }

    directMessagePeerExists(userId: string, peerId: string): boolean {
      return peerId !== userId && Boolean(this.userRowById(peerId));
    }

    directMessageHistory(userId: string, peerId: string, before = Number.MAX_SAFE_INTEGER): DirectMessagePage {
      const rows = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM direct_messages
        WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        AND id < ? ORDER BY id DESC LIMIT 51`).all(userId, peerId, peerId, userId, before) as DirectMessage[];
      return { messages: rows.slice(0, 50).reverse(), hasMore: rows.length > 50 };
    }

    sendDirectMessage(userId: string, peerId: string, text: string, nonce: string):
      { message: DirectMessage; replay: boolean } | { error: "unavailable" | "rate" | "conflict" } {
      return this.db.transaction(() => {
        const prior = this.db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM direct_messages
          WHERE sender_id = ? AND nonce = ?`).get(userId, nonce) as DirectMessage | undefined;
        if (prior) return prior.recipientId === peerId && prior.text === text
          ? { message: prior, replay: true } : { error: "conflict" as const };
        const peer = this.userRowById(peerId);
        if (!peer || peer.suspended || peerId === userId) return { error: "unavailable" as const };
        if (this.count("SELECT COUNT(*) AS c FROM direct_messages WHERE sender_id = ? AND created_at > ?",
          userId, new Date(Date.now() - 60_000).toISOString()) >= 60) return { error: "rate" as const };
        const createdAt = now();
        const result = this.db.prepare(`INSERT INTO direct_messages
          (sender_id, recipient_id, text, nonce, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(userId, peerId, text, nonce, createdAt);
        return { message: { id: Number(result.lastInsertRowid), senderId: userId, recipientId: peerId, text, createdAt }, replay: false };
      }).immediate();
    }

    readDirectMessages(userId: string, peerId: string, throughId: number): void {
      // Acknowledge only the messages the client actually displayed, never a later arrival.
      this.db.prepare(`UPDATE direct_messages SET read_at = ?
        WHERE recipient_id = ? AND sender_id = ? AND id <= ? AND read_at IS NULL`)
        .run(now(), userId, peerId, throughId);
    }
  };
}
