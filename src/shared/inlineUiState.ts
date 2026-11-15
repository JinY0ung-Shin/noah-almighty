// Inline UI state kept on the SERVER, per viewer: what a viewer changed in the
// controls of one stored answer (`{@state}` values set through a setter), each
// value with the declaration text it was set under (`sig`). The client keeps a
// debounced copy (`src/client/src/lib/widgetState.ts`), the server stores it
// (`store/inlineUiStates.ts`), and the avatar hears what changed in its latest
// answer at the start of its next turn (`buildPiTurnPreamble`).
//
// The caps are shared so both ends refuse the same record.

/** One answer's record, measured as its JSON text. */
export const MAX_INLINE_UI_STATE_CHARS = 200_000;
/** Answers kept per (viewer, conversation); the least recently saved go first. */
export const MAX_INLINE_UI_STATE_ANSWERS = 50;
/** State variables per answer (the grammar allows ≤ 50 declarations). */
export const MAX_INLINE_UI_STATE_NAMES = 50;
/** A state name / its declaration text. */
export const MAX_INLINE_UI_STATE_NAME_CHARS = 100;
export const MAX_INLINE_UI_STATE_SIG_CHARS = 4_000;

export interface InlineUiStateEntry {
  /** The declaration text (`name = initial`) the value was set under. */
  sig: string;
  value: unknown;
}

export type InlineUiStateRecord = Record<string, InlineUiStateEntry>;

/** `GET /api/messages` → `inlineUiStates`: the caller's records by message id. */
export type InlineUiStatesByMessage = Record<string, InlineUiStateRecord>;

/**
 * The well-formed part of a record that came over the wire or out of storage,
 * or null when `input` is not a record at all. Entries without a string `sig`,
 * with an over-long name or sig, and names past the count cap are dropped. The
 * values are JSON already (they were parsed from JSON); the size cap is the
 * caller's (`MAX_INLINE_UI_STATE_CHARS` over the serialized record).
 */
export function normalizeInlineUiStateRecord(input: unknown): InlineUiStateRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: InlineUiStateRecord = {};
  let count = 0;
  for (const [name, entry] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_INLINE_UI_STATE_NAMES) break;
    if (!name || name.length > MAX_INLINE_UI_STATE_NAME_CHARS || name === "__proto__") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { sig, value } = entry as { sig?: unknown; value?: unknown };
    if (typeof sig !== "string" || sig.length > MAX_INLINE_UI_STATE_SIG_CHARS) continue;
    out[name] = { sig, value };
    count += 1;
  }
  return out;
}
