// What the user has typed but not sent: the composer's text, its staged
// (unsent) images and documents, and an open 여기서부터 다시 edit.
//
// Two jobs, one module:
//
// 1. THE TYPING CHANNEL. A keystroke writes `pane.draft` (or
//    `pane.rewindEdit.draft`) IN PLACE and bumps `draftEdits` — it does NOT
//    publish the app state. Everything under `useAppState()` (the whole chat
//    view, every transcript row, the shell) re-renders on a publication, so a
//    publication per keystroke redrew every message. Only the components that
//    draw a draft (the composer, the rewind editor) subscribe to `draftEdits`.
//    `pane.draft` stays the one source of truth: handlers read it live, and
//    every other write (a send clearing it, a failed send putting it back, a
//    seeded chat) still goes through `updateState`, which redraws everything.
//
// 2. DRAFTS THAT SURVIVE A SWITCH. A pane-replacing navigation (another
//    conversation, 새 대화, closing a split pane) stashes the dropped pane's
//    draft here, and a pane that later shows the SAME conversation takes it
//    back (lib/chat.ts `settlePaneSwap`). Memory only, for the page's lifetime:
//    staged files cannot be persisted, and a reload is guarded by a
//    `beforeunload` prompt that is registered ONLY while some draft has content
//    (`watchUnsentDrafts`).
//
//    "The same conversation" (`draftKey`): a SAVED conversation — one the
//    server knows (it has messages, or it is in the conversation lists) — is
//    keyed by its id, wherever it is opened (single view or any split pane). A
//    brand-new, never-sent chat has a throwaway client id, so its draft is
//    keyed by the AVATAR instead: the next new chat with that avatar gets it
//    back. A sent draft is never stashed (the send cleared it), a taken draft
//    leaves the stash, and a deleted conversation's draft is dropped and never
//    stashed again. The stash belongs to the signed-in user; another user
//    signing in starts empty.
import { appState, readState, type ClientState } from "./state";
import { writable } from "./store";
import type { ChatPane, PendingDocument, PendingImage } from "./types";

/** Bumped by every in-place draft write; the draft-drawing components subscribe to it. */
export const draftEdits = writable(0);

function bump(): void {
  draftEdits.update((n) => n + 1);
}

/** The composer's text, written in place (no app-state publication). */
export function setPaneDraft(paneId: string, value: string): void {
  const pane = readState().chatPanes.find((item) => item.id === paneId);
  if (!pane || pane.draft === value) return;
  pane.draft = value;
  bump();
}

/** The open 여기서부터 다시 editor's text, written in place (no app-state publication). */
export function setPaneRewindDraft(paneId: string, value: string): void {
  const edit = readState().chatPanes.find((item) => item.id === paneId)?.rewindEdit;
  if (!edit || edit.draft === value) return;
  edit.draft = value;
  bump();
}

export interface ConversationDraft {
  text: string;
  images: PendingImage[];
  /** Only documents whose bytes were fully read: a read still running writes into the dropped pane. */
  documents: PendingDocument[];
  rewindEdit: { messageId: string; draft: string } | null;
  /** The open edit's text differs from the message it edits (real typed work). */
  rewindEdited: boolean;
}

const drafts = new Map<string, ConversationDraft>();
/** Conversations deleted in this page: a late stash for one is ignored. */
const forgotten = new Set<string>();
/** The user the stash belongs to (the last signed-in one). */
let owner: string | null = null;

function syncOwner(state: ClientState): void {
  const user = state.user?.id ?? null;
  // Signed out keeps the stash for the same user signing back in; a DIFFERENT
  // user never sees it.
  if (!user || user === owner) return;
  if (owner !== null) {
    drafts.clear();
    forgotten.clear();
  }
  owner = user;
}

function isSaved(pane: Pick<ChatPane, "conversationId" | "messages">, state: ClientState): boolean {
  return (
    pane.messages.length > 0 ||
    state.conversations.some((c) => c.id === pane.conversationId) ||
    state.routineConversations.some((c) => c.id === pane.conversationId)
  );
}

/** Which stash entry a pane's draft belongs to (see the header). */
export function draftKey(pane: Pick<ChatPane, "conversationId" | "messages" | "avatar">, state: ClientState = readState()): string {
  return isSaved(pane, state) ? `conversation:${pane.conversationId}` : `new:${pane.avatar.id}`;
}

function rewindEdited(pane: ChatPane): boolean {
  const edit = pane.rewindEdit;
  if (!edit) return false;
  const original = pane.messages.find((m) => m.id === edit.messageId)?.content ?? "";
  return edit.draft !== original;
}

/** Work the user would lose with this pane: typed text, staged files, an edited rewind. */
export function paneHasUnsentDraft(pane: ChatPane): boolean {
  return Boolean(pane.draft.trim() || pane.pendingImages?.length || pane.pendingDocuments?.length || rewindEdited(pane));
}

function recordHasUnsent(record: ConversationDraft): boolean {
  return Boolean(record.text.trim() || record.images.length || record.documents.length || record.rewindEdited);
}

/**
 * Keep a pane's draft for when its conversation is shown again. Called for a
 * pane that is leaving the screen. An empty draft stores nothing (and does not
 * erase an entry: only `takeDraft` removes one).
 */
export function stashPaneDraft(pane: ChatPane, state: ClientState = readState()): void {
  syncOwner(state);
  if (!owner) return;
  const key = draftKey(pane, state);
  if (key.startsWith("conversation:") && forgotten.has(pane.conversationId)) return;
  const record: ConversationDraft = {
    text: pane.draft,
    images: [...(pane.pendingImages ?? [])],
    documents: (pane.pendingDocuments ?? []).filter((doc) => doc.dataUrl !== null),
    rewindEdit: pane.rewindEdit ? { ...pane.rewindEdit } : null,
    rewindEdited: rewindEdited(pane),
  };
  if (!record.text.trim() && !record.images.length && !record.documents.length && !record.rewindEdit) return;
  drafts.set(key, record);
  bump();
}

/** Remove and return the draft kept for this pane's conversation (or new chat), if any. */
export function takeDraft(pane: ChatPane, state: ClientState = readState()): ConversationDraft | null {
  syncOwner(state);
  if (!owner) return null;
  const key = draftKey(pane, state);
  const record = drafts.get(key);
  if (!record) return null;
  drafts.delete(key);
  bump();
  return record;
}

/** A deleted conversation's draft goes with it, and a pane of it closing later stashes nothing. */
export function forgetConversationDraft(conversationId: string): void {
  forgotten.add(conversationId);
  if (drafts.delete(`conversation:${conversationId}`)) bump();
}

/** Is there anything a reload would lose — on screen or stashed? */
export function hasUnsentDraft(state: ClientState = readState()): boolean {
  syncOwner(state);
  if (!state.user) return false;
  if (state.chatPanes.some(paneHasUnsentDraft)) return true;
  for (const record of drafts.values()) if (recordHasUnsent(record)) return true;
  return false;
}

/** Test seam: forget every stashed draft. */
export function resetDraftsForTest(): void {
  drafts.clear();
  forgotten.clear();
  owner = null;
}

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Older engines show the prompt only for a set returnValue.
  event.returnValue = "";
}

/**
 * Ask before leaving the page while a draft has content — and ONLY then: the
 * listener is added when the first unsent draft appears and removed when the
 * last one is sent, cleared or discarded (an always-on `beforeunload` also
 * costs the page the browser's back/forward cache). Returns the uninstaller.
 */
export function watchUnsentDrafts(target: Pick<Window, "addEventListener" | "removeEventListener"> = window): () => void {
  let armed = false;
  let stopped = false;
  let queued = false;
  const check = () => {
    queued = false;
    if (stopped) return;
    const want = hasUnsentDraft();
    if (want === armed) return;
    armed = want;
    if (want) target.addEventListener("beforeunload", onBeforeUnload);
    else target.removeEventListener("beforeunload", onBeforeUnload);
  };
  // Judged once the current task's writes are done, not per write: a pane swap
  // publishes the new panes BEFORE it stashes the dropped pane's draft, and a
  // per-write check would drop the guard for that instant and add it again.
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(check);
  };
  // Every draft change is either an app-state publication or a draftEdits bump.
  const offState = appState.subscribe(schedule);
  const offEdits = draftEdits.subscribe(schedule);
  return () => {
    stopped = true;
    offState();
    offEdits();
    if (armed) target.removeEventListener("beforeunload", onBeforeUnload);
    armed = false;
  };
}
