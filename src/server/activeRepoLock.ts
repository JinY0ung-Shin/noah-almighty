/**
 * Minimal in-memory serialization for the "active repo workspace" feature (#47).
 *
 * Used only by the `local` stub now: a pi run works on its sandbox COPY and
 * takes no lock (see `activeRepoResolve.ts`). When a `local` conversation opens
 * a registered git repo as its active workspace, the run's cwd becomes that
 * repo's single local clone and the avatar edits the
 * working tree with native tools. Two different conversations doing that against
 * the SAME clone would stomp each other's working tree (the per-tool
 * `withRepoLock` in gitRepos.ts only guards the MCP git ops, not native edits).
 *
 * This holds, per clone path, the conversation that currently owns it as an
 * active workspace. A second conversation is refused (the chat route returns
 * 409) — the issue's accepted "repo-unit lock" minimum. Re-acquiring from the
 * SAME conversation succeeds (sequential turns of one chat). Single-process only,
 * matching the rest of the app (in-process SQLite + runRegistry).
 *
 * SCOPE CAVEAT: this only serializes opening an *active workspace* on a clone. It
 * does NOT block a plain mcp__git_repo__sync_repo/commit from ANOTHER conversation
 * (those still take their own per-op withRepoLock in gitRepos.ts), so a concurrent
 * sync elsewhere could fetch/checkout the working tree mid-edit. Acceptable for the
 * MVP (the issue flags per-conversation `git worktree` isolation as the eventual
 * fix); revisit if that races in practice.
 *
 * Re-acquire by the SAME conversation id always succeeds (sequential turns of one
 * chat), so this lock does NOT serialize two runs that share a conversation id — a
 * routine run and an interactive chat on the routine's thread. They are kept apart
 * upstream instead: the scheduler skips a job whose conversation has an active chat
 * run (`getActiveRunForConversation` in scheduler.ts). The reverse (a chat starting
 * mid-routine-run) is a narrow window left to the MVP.
 */
const heldBy = new Map<string, string>();

/** Try to claim `clonePath` for `conversationId`. False if another conv holds it. */
export function acquireActiveRepo(clonePath: string, conversationId: string): boolean {
  const current = heldBy.get(clonePath);
  if (current && current !== conversationId) {
    return false;
  }
  heldBy.set(clonePath, conversationId);
  return true;
}

/** Release `clonePath` if (and only if) `conversationId` holds it. */
export function releaseActiveRepo(clonePath: string, conversationId: string): void {
  if (heldBy.get(clonePath) === conversationId) {
    heldBy.delete(clonePath);
  }
}
