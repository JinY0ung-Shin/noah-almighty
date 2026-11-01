/**
 * Minimal in-memory serialization for the "active repo workspace" feature (#47).
 *
 * Keys are clone paths for the `local` stub and `piRepoCopyLockKey` for a pi
 * run, which works on its principal's sandbox COPY — one copy per (principal,
 * owner, repo), shared by all of that principal's conversations, so two runs
 * of different conversations must not edit and commit it at once (see
 * `activeRepoResolve.ts`; the git_repo tools refuse while another
 * conversation's run holds it). When a `local` conversation opens
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

/** The conversation holding `key` right now, or null. */
export function activeRepoHolder(key: string): string | null {
  return heldBy.get(key) ?? null;
}

/**
 * The copy run locks ONE run took MID-TURN (`mcp__git_repo__open_repo`,
 * `sync_repo`, `commit` on a pi sandbox copy), held until that run ends. The
 * turn-start lock (`resolveActiveWorkspaceRepo`) covers only a repo that was
 * open when the turn began; without this, a conversation that opens the repo
 * mid-turn works on the shared copy unlocked, and another conversation's run
 * (a routine starting with the repo open) could take the copy over and commit
 * the half-done edits. `runPiAgent` makes one per run, hands it to the git_repo
 * tools through their context, and calls `releaseAll` when the run ends.
 *
 * Only a lock this run newly took is released here: one the conversation
 * already held (the turn-start lock) stays with whoever took it. After
 * `releaseAll` nothing more is taken, so a tool call racing the run's end
 * cannot leave a lock behind.
 */
export class RunRepoLocks {
  private readonly taken = new Set<string>();
  private closed = false;

  constructor(private readonly holderId: string) {}

  /**
   * Take `key` for this run's conversation. `ok: false` when another
   * conversation holds it or the run already ended. On success `undo` gives
   * back a lock THIS call newly took (a no-op otherwise) — for a tool that is
   * refused right after taking it, so a refusal never blocks anyone.
   */
  acquire(key: string): { ok: true; undo: () => void } | { ok: false } {
    if (this.closed) return { ok: false };
    const fresh = activeRepoHolder(key) === null;
    if (!acquireActiveRepo(key, this.holderId)) return { ok: false };
    if (!fresh || this.taken.has(key)) return { ok: true, undo: () => {} };
    this.taken.add(key);
    return {
      ok: true,
      undo: () => {
        if (this.taken.delete(key)) releaseActiveRepo(key, this.holderId);
      },
    };
  }

  /** The run ended: release every lock it took, and take no more. */
  releaseAll(): void {
    this.closed = true;
    for (const key of this.taken) releaseActiveRepo(key, this.holderId);
    this.taken.clear();
  }
}
