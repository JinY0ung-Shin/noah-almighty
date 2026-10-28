import {
  configureGitRepoIdentity,
  ensureGitRepoClone,
  gitRepoClonePath,
  gitRepoContextFor,
} from "./gitRepos.js";
import { commitIdentityFor } from "./knowledgeRepo.js";
import { acquireActiveRepo, releaseActiveRepo } from "./activeRepoLock.js";
import { getWorkspaceRepo, setWorkspaceRepo } from "./repoWorkspace.js";
import { scrubGitError } from "./marketplace.js";
import type { AppConfig } from "./types.js";
import type { Store } from "./store.js";
import type { PiWorkspace } from "./agent/pi/piWorkspace.js";
import { ensurePiRepoCopy } from "./agent/pi/piRepoCopy.js";

/** Identity needed to stamp commits made in the opened clone. */
export interface ActiveRepoAvatar {
  id: string;
  displayName: string;
  alias: string;
}

/**
 * Result of resolving a conversation's opened working repository into a usable
 * cwd. `none` = nothing opened (run in the scratch workspace). `ok` carries the
 * clone path + a `release()` the caller MUST invoke when the run ends to free the
 * per-clone serialization lock. `error` reports why opening failed, with a
 * token-scrubbed `detail` each caller renders for its own audience.
 */
export type ActiveRepoResolution =
  | { kind: "none" }
  | { kind: "ok"; cwd: string; repoName: string; release: () => void }
  | { kind: "error"; reason: "not_found" | "locked" | "open_failed"; detail?: string };

/**
 * Resolve the working repo a conversation opened (via `mcp__git_repo__open_repo`)
 * into an SDK cwd, mirroring exactly what the chat route needs at turn start AND
 * what the routine scheduler needs before a headless run — kept in ONE place so
 * the two can't drift (clone, per-clone lock, commit identity).
 *
 * Resolve/clone/lock BEFORE the run so a failure surfaces synchronously (the chat
 * route can still answer with plain JSON; the scheduler can fall back to scratch).
 * The clone path is server-side only and never returned to the model — only the
 * repo NAME. The `elevated` gate is belt-and-suspenders: open_repo is itself
 * elevated-only, but trust may have changed since the repo was opened.
 *
 * A pi run (`piWorkspace` set) never works in this clone: it works on its
 * sandbox COPY (design D1, `agent/pi/piRepoCopy.ts`), made here when missing
 * (an existing one is left alone — the agent's uncommitted edits stay, and a
 * commit from a stale copy is refused by `mcp__git_repo__commit`). So no
 * per-clone run lock is taken: Noah's own git operations on the clone are
 * serialized per operation (`withRepoLock`), and two pi conversations may
 * work on their copies at once.
 */
export async function resolveActiveWorkspaceRepo(opts: {
  store: Store;
  config: AppConfig;
  avatar: ActiveRepoAvatar;
  conversationId: string;
  elevated: boolean;
  gitRepoToolsEnabled: boolean;
  piWorkspace?: PiWorkspace;
}): Promise<ActiveRepoResolution> {
  const { store, config, avatar, conversationId, elevated, gitRepoToolsEnabled, piWorkspace } = opts;
  const requested =
    elevated && gitRepoToolsEnabled
      ? (getWorkspaceRepo(store, conversationId) ?? "")
      : "";
  if (!requested) {
    return { kind: "none" };
  }

  const repoCtx = gitRepoContextFor(store, avatar.id, requested, config);
  if (!repoCtx) {
    // Dangling pointer: the opened repo was removed or renamed (remove_repo does
    // not clear working_repo) and this stored name no longer resolves. Hard-
    // failing here dead-ends the conversation — EVERY later turn would error, and
    // close_repo (the only other path that clears the pointer) needs a turn to
    // run. Self-heal: clear the stale pointer and fall back to the scratch
    // workspace so the turn proceeds.
    setWorkspaceRepo(store, conversationId, null);
    return { kind: "none" };
  }

  const clonePath = gitRepoClonePath(avatar.id, repoCtx.name, config);
  if (piWorkspace) {
    try {
      const cwd = await ensureGitRepoClone(repoCtx);
      const owner = store.getUserById(avatar.id);
      await configureGitRepoIdentity(
        repoCtx,
        commitIdentityFor(store, {
          id: avatar.id,
          username: owner?.username ?? avatar.id,
          displayName: avatar.displayName,
          alias: avatar.alias,
        }),
      );
      await ensurePiRepoCopy({ config, workspace: piWorkspace, ownerId: avatar.id, name: repoCtx.name, clonePath }, "when-missing");
      return { kind: "ok", cwd, repoName: repoCtx.name, release: () => undefined };
    } catch (error) {
      return { kind: "error", reason: "open_failed", detail: scrubGitError(error) };
    }
  }
  if (!acquireActiveRepo(clonePath, conversationId)) {
    return { kind: "error", reason: "locked" };
  }
  try {
    // Ensure the clone exists WITHOUT syncing — a fetch/checkout here could
    // clobber native edits; sync stays an explicit mcp__git_repo__sync_repo.
    const cwd = await ensureGitRepoClone(repoCtx);
    const owner = store.getUserById(avatar.id);
    await configureGitRepoIdentity(
      repoCtx,
      commitIdentityFor(store, {
        id: avatar.id,
        username: owner?.username ?? avatar.id,
        displayName: avatar.displayName,
        alias: avatar.alias,
      }),
    );
    return {
      kind: "ok",
      cwd,
      repoName: repoCtx.name,
      release: () => releaseActiveRepo(clonePath, conversationId),
    };
  } catch (error) {
    releaseActiveRepo(clonePath, conversationId);
    return { kind: "error", reason: "open_failed", detail: scrubGitError(error) };
  }
}
