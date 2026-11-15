import {
  MAX_INLINE_UI_STATE_ANSWERS,
  MAX_INLINE_UI_STATE_CHARS,
  normalizeInlineUiStateRecord,
  type InlineUiStateRecord,
  type InlineUiStatesByMessage,
} from "../../shared/inlineUiState.js";
import { type Constructor, type StoreBase, now } from "./internal.js";

// Inline UI state, per VIEWER and per stored ANSWER (see the inline_ui_states
// table comment in internal.ts). Storage only: the route validates the request
// shape, the turn route decides when the avatar hears the values.
//
// Every read and write is limited to the caller's OWN conversation (the same
// rule as the render report): a conversation that is not theirs reads as
// "not_found" (the route's ONE 404).

/** What `putInlineUiState` did. */
export type InlineUiStatePutOutcome =
  | "saved"
  | "cleared"
  | "not_found"
  | "message_not_found"
  | "not_assistant"
  | "too_large";

/** The latest answer's changed values, as the turn that is starting takes them. */
export interface InlineUiStateForTurn {
  messageId: string;
  /** The answer text: the turn keeps only the values whose declaration it still holds. */
  answer: string;
  values: InlineUiStateRecord;
}

function parseRecord(raw: string): InlineUiStateRecord | null {
  try {
    const record = normalizeInlineUiStateRecord(JSON.parse(raw));
    return record && Object.keys(record).length ? record : null;
  } catch {
    return null;
  }
}

export function withInlineUiStates<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class extends Base {
    private ownsConversationForUiState(userId: string, conversationId: string): boolean {
      const row = this.db.prepare("SELECT owner_user_id FROM conversations WHERE id = ?").get(conversationId) as
        | { owner_user_id: string }
        | undefined;
      return Boolean(row && row.owner_user_id === userId);
    }

    /** The caller's saved records for one of their conversations, by message id ({} for anyone else). */
    listInlineUiStates(userId: string, conversationId: string): InlineUiStatesByMessage {
      if (!this.ownsConversationForUiState(userId, conversationId)) return {};
      const rows = this.db
        .prepare("SELECT message_id, values_json FROM inline_ui_states WHERE user_id = ? AND conversation_id = ?")
        .all(userId, conversationId) as { message_id: string; values_json: string }[];
      const out: InlineUiStatesByMessage = {};
      for (const row of rows) {
        const record = parseRecord(row.values_json);
        if (record) out[row.message_id] = record;
      }
      return out;
    }

    /**
     * Save what the caller changed in one answer of their own conversation (an
     * empty record removes it). Only an ASSISTANT message of that conversation;
     * a record whose JSON passes the cap is refused (and nothing stored is
     * changed). A save that changes the values marks them unreported, so the
     * avatar hears them on its next turn; the same values again change nothing.
     * Past MAX_INLINE_UI_STATE_ANSWERS answers in the conversation, the least
     * recently saved are dropped.
     */
    putInlineUiState(
      userId: string,
      conversationId: string,
      messageId: string,
      record: InlineUiStateRecord,
    ): InlineUiStatePutOutcome {
      if (!this.ownsConversationForUiState(userId, conversationId)) return "not_found";
      const message = this.db
        .prepare("SELECT role FROM messages WHERE id = ? AND conversation_id = ?")
        .get(messageId, conversationId) as { role: string } | undefined;
      if (!message) return "message_not_found";
      if (message.role !== "assistant") return "not_assistant";
      if (Object.keys(record).length === 0) {
        this.db.prepare("DELETE FROM inline_ui_states WHERE user_id = ? AND message_id = ?").run(userId, messageId);
        return "cleared";
      }
      const json = JSON.stringify(record);
      if (json.length > MAX_INLINE_UI_STATE_CHARS) return "too_large";
      const tx = this.db.transaction(() => {
        const existing = this.db
          .prepare("SELECT values_json FROM inline_ui_states WHERE user_id = ? AND message_id = ?")
          .get(userId, messageId) as { values_json: string } | undefined;
        if (existing) {
          this.db
            .prepare(
              "UPDATE inline_ui_states SET values_json = ?, updated_at = ?, reported = CASE WHEN values_json = ? THEN reported ELSE 0 END WHERE user_id = ? AND message_id = ?",
            )
            .run(json, now(), json, userId, messageId);
        } else {
          this.db
            .prepare(
              "INSERT INTO inline_ui_states (user_id, conversation_id, message_id, values_json, reported, updated_at) VALUES (?, ?, ?, ?, 0, ?)",
            )
            .run(userId, conversationId, messageId, json, now());
        }
        // Keep the most recently saved answers (rowid breaks a same-millisecond tie).
        this.db
          .prepare(
            `DELETE FROM inline_ui_states WHERE user_id = ? AND conversation_id = ? AND rowid NOT IN (
               SELECT rowid FROM inline_ui_states WHERE user_id = ? AND conversation_id = ?
               ORDER BY updated_at DESC, rowid DESC LIMIT ?)`,
          )
          .run(userId, conversationId, userId, conversationId, MAX_INLINE_UI_STATE_ANSWERS);
      });
      tx();
      return "saved";
    }

    /**
     * CONSUME what the caller changed in the conversation's LATEST answer for
     * the turn that is starting: returned once per change (a later save that
     * changes the values makes them due again), null when nothing is due — no
     * answer, nothing changed there, or already told. Only for the
     * conversation's owner (the person the turn answers).
     */
    takeInlineUiStateForTurn(userId: string, conversationId: string): InlineUiStateForTurn | null {
      if (!this.ownsConversationForUiState(userId, conversationId)) return null;
      const latest = this.db
        .prepare(
          "SELECT id, content FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1",
        )
        .get(conversationId) as { id: string; content: string | null } | undefined;
      if (!latest) return null;
      const row = this.db
        .prepare("SELECT values_json FROM inline_ui_states WHERE user_id = ? AND message_id = ? AND reported = 0")
        .get(userId, latest.id) as { values_json: string } | undefined;
      if (!row) return null;
      this.db
        .prepare("UPDATE inline_ui_states SET reported = 1 WHERE user_id = ? AND message_id = ?")
        .run(userId, latest.id);
      const values = parseRecord(row.values_json);
      return values ? { messageId: latest.id, answer: latest.content ?? "", values } : null;
    }
  };
}
