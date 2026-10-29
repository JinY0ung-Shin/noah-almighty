import type { Store } from "./store.js";

/**
 * Per-conversation "working repository" selection for general git repos.
 *
 * Direction B (single working surface): the avatar no longer edits a registered
 * repo through MCP file tools. Instead it OPENS one repo as the conversation's
 * working directory (`mcp__git_repo__open_repo`). On pi the avatar edits/tests
 * its sandbox COPY of the repo with the built-in tools (the turn input names the
 * copy, `piActiveRepoTurnLine`), while saving (`mcp__git_repo__commit`) and
 * remote git (push/sync) stay MCP.
 *
 * The chat route (and the routine scheduler) read the selection at turn start
 * to prepare the copy and the turn's working-repo line, so it has to live
 * OUTSIDE the model turn. It is persisted
 * on the `conversations.working_repo` column (store), NOT in memory: routine runs
 * are spaced out over time and survive server restarts, so an in-memory map would
 * silently drop the selection between scheduled runs. Durability also gives a
 * clean bootstrap — opening a repo interactively in a routine's thread carries to
 * every later scheduled run on that same conversation id.
 */

/** Set (or clear, when `repoName` is null) the working repo for a conversation. */
export function setWorkspaceRepo(
  store: Store,
  conversationId: string,
  repoName: string | null,
): void {
  store.setConversationWorkingRepo(conversationId, repoName || null);
}

/** The working repo opened for this conversation, or null when none is open. */
export function getWorkspaceRepo(store: Store, conversationId: string): string | null {
  return store.getConversationWorkingRepo(conversationId);
}
