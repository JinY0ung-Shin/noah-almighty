// Shared low-level git plumbing for the repo clone/commit/push paths
// (knowledgeRepo.ts, groupKnowledgeRepo.ts, gitRepos.ts). These three modules
// each re-implemented the same `git -C <root> …` exec wrapper plus a
// `currentBranch` and a porcelain dirty-status reader — extracted here so they
// share one definition rather than copy-paste. Everything is keyed off a single
// `repoRoot`, matching the per-clone working-tree model the callers use.
//
// The arg guards live in repoGitGuards.ts. `safeIdentity`/`safePushBranch` are
// used only INTERNALLY here (commitAndPushClone/alignBranch); `assertSafeGitValue`
// is re-exported below because the knowledge-repo callers pull it through this
// module. gitRepos.ts imports the guards straight from repoGitGuards.ts.
// NOTE: the extracted helpers have since diverged from the old inline versions
// (the scheme:: reject, ff-only preservation, the rebase self-heal + REBASE_
// CONFLICT sentinel) — do not "restore parity" with logic that was deliberately
// changed.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import logger from "./logger.js";
import { gitAuthArgs, pathExists, scrubGitError } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import { safeIdentity, safePushBranch } from "./repoGitGuards.js";
import type { AppConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export { assertSafeGitValue } from "./repoGitGuards.js";

/**
 * Run `git -C <repoRoot> <args>` and resolve with `{stdout, stderr}`. The
 * default timeout (120s) matches every call site's prior inline wrapper; pass an
 * explicit timeout to override (the clone paths use longer ones at their own
 * `execFile` call, outside this helper).
 */
export function git(repoRoot: string, args: string[], timeout = 120_000) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout });
}

/**
 * The clone's `origin` remote URL (clean, without any auth — auth is supplied
 * per-call via `http.extraHeader`, never written to `.git/config`), or null when
 * there's no origin / on error. Used to detect that the configured repo changed
 * out from under an existing clone so the stale one can be re-cloned.
 */
export async function originUrl(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["remote", "get-url", "origin"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The clone's current branch name, or null when detached (`HEAD`) or on error.
 * Identical to the inline `currentBranch` each repo module used.
 */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const name = stdout.trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/**
 * Relative paths with uncommitted changes, parsed from `git status --porcelain`.
 *
 * CRITICAL: the porcelain flag is parameterized so each caller keeps its CURRENT
 * behavior — knowledge/group repos use plain `--porcelain`, the user-registered
 * git repos use `--porcelain -uall` (list untracked files individually). This is
 * a deferred breaking item; do NOT unify the flags here.
 */
export async function dirtyPaths(
  repoRoot: string,
  extraStatusArgs: string[] = [],
): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain", ...extraStatusArgs]);
  return stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Count commits on local HEAD not yet on origin/<branch>. Returns 0 when the
 * branch is up to date or behind, a positive count when ahead, and null when
 * origin/<branch> doesn't exist (so callers can tell "fresh repo" apart from
 * "in sync"). Shared by the knowledge / group-knowledge align paths.
 */
export async function aheadOfRemote(repoRoot: string, branch: string): Promise<number | null> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `origin/${branch}`]);
  } catch {
    return null;
  }
  try {
    const { stdout } = await git(repoRoot, ["rev-list", `origin/${branch}..HEAD`, "--count"]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Count commits on origin/<branch> not yet on local HEAD (how far the clone is
 * BEHIND the remote). 0 when up to date or ahead-only, and 0 when
 * origin/<branch> doesn't exist. Complement of `aheadOfRemote`; used by the
 * push path to decide whether a pre-push rebase is needed.
 */
export async function behindRemote(repoRoot: string, branch: string): Promise<number> {
  try {
    const { stdout } = await git(repoRoot, ["rev-list", `HEAD..origin/${branch}`, "--count"]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Move the working tree onto `branch`@origin without discarding unpushed
 * commits. If local HEAD is ahead of origin/<branch>, a hard `checkout -B`
 * would silently destroy those commits — so we only `checkout -B` when HEAD is
 * NOT ahead; when it is, we merge --ff-only (a no-op if the remote didn't move,
 * a clean catch-up otherwise) and, if that can't fast-forward (diverged), leave
 * the branch as-is with a warning so the unpushed work survives (git-01). When
 * the branch doesn't exist on the remote yet (fresh repo), stay on HEAD. The
 * caller supplies `warnMessage` so each repo kind keeps its own log wording.
 */
export async function alignBranch(
  repoRoot: string,
  branch: string,
  log: Record<string, unknown>,
  warnMessage: string,
): Promise<void> {
  const ahead = await aheadOfRemote(repoRoot, branch);
  if (ahead === null) {
    // origin/<branch> doesn't exist yet (fresh repo) — keep the clone's HEAD.
    return;
  }
  if (ahead === 0) {
    // No unpushed work — safe to re-point the branch at the remote tip.
    try {
      await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
    } catch {
      // Branch may not exist locally/remotely in some edge state — stay put.
    }
    return;
  }
  // HEAD is ahead of the remote: preserve the local commits. Make sure we're on
  // the branch, then only fast-forward (never reset) to absorb new remote work.
  try {
    await git(repoRoot, ["checkout", branch]);
    await git(repoRoot, ["merge", "--ff-only", `origin/${branch}`]);
  } catch (error) {
    logger.warn({ ...log, branch, ahead, error: scrubGitError(error) }, warnMessage);
  }
}

/**
 * Restore every tracked `.mcp.json` to its committed (HEAD) state, discarding
 * the runtime `stripManagedMcpServers` edit so it never gets committed/pushed.
 * Best-effort and tolerant: untracked `.mcp.json` files (genuinely new, added
 * by the avatar) are left alone; if `ls-files` finds none it's a no-op.
 */
export async function restoreTrackedMcpJson(repoRoot: string): Promise<void> {
  let tracked: string[];
  try {
    const { stdout } = await git(repoRoot, ["ls-files", "-z", "*.mcp.json"]);
    tracked = stdout.split("\0").filter(Boolean);
  } catch {
    return;
  }
  if (tracked.length === 0) {
    return;
  }
  // `--` so paths are never parsed as options. Ignore failures (e.g. a path
  // that's tracked but unchanged) — this is purely defensive cleanup.
  try {
    await git(repoRoot, ["checkout", "HEAD", "--", ...tracked]);
  } catch {
    /* best-effort */
  }
}

/**
 * Stage all changes, commit with the given identity, and push to the remote
 * branch — the shared body of the knowledge / group-knowledge commitAndPush
 * paths. Returns false when there is nothing to do (clean tree AND nothing
 * stacked); a clean tree with unpushed local commits (a prior push failed
 * transiently) still pushes, so an explicit retry self-heals. Throws NOT_CLONED
 * if the clone is missing, and on git failure (auth, conflicts) so the caller
 * can surface the detail. The caller already holds the per-clone lock.
 *
 * Before pushing, remote commits that landed since the last sync (a direct push
 * from the owner's laptop, CI, another chat's already-pushed work) are absorbed
 * by fetch + rebase, so a non-conflicting external push no longer leaves the
 * clone permanently diverged. A CONFLICTING rebase is aborted — the local
 * commits stay intact — and surfaces as `REBASE_CONFLICT:<files>` so the tool
 * layer can explain the real cause (see repoToolKit.commitFailureMessage)
 * instead of hinting at token/branch-protection problems.
 *
 * PRESERVE: restoreTrackedMcpJson runs BEFORE `git add -A`, and auth is routed
 * per-host via tokenForGitUrl — this is the security-sensitive auth/push path.
 */
export async function commitAndPushClone(
  repoRoot: string,
  options: {
    url: string;
    config: Pick<AppConfig, "githubHost">;
    tokens: GitTokenSet;
    branch: string | null;
    message: string;
    defaultMessage: string;
    identity: { name: string; email: string };
    log: Record<string, unknown>;
    pushedMessage: string;
  },
): Promise<boolean> {
  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    throw new Error("NOT_CLONED");
  }
  // Guard against identity values git would read as options (passed positionally
  // after the config key). Fall back to a safe default rather than failing.
  const { name, email } = safeIdentity(options.identity);
  await git(repoRoot, ["config", "user.name", name]);
  await git(repoRoot, ["config", "user.email", email]);
  // Undo any in-place `.mcp.json` strip done at load time before staging, so the
  // runtime-only edit never gets committed/pushed. MUST run before `git add -A`.
  await restoreTrackedMcpJson(repoRoot);
  await git(repoRoot, ["add", "-A"]);
  const hasChanges = (await dirtyPaths(repoRoot)).length > 0;
  const branch = safePushBranch(options.branch || (await currentBranch(repoRoot)) || "HEAD");
  if (hasChanges) {
    // commitMsg is the value of `-m` (a discrete argv element), so it's never
    // parsed as a flag even if it starts with `-`.
    const commitMsg = options.message.trim() || options.defaultMessage;
    await git(repoRoot, ["commit", "-m", commitMsg]);
  } else if (branch === "HEAD" || !(await aheadOfRemote(repoRoot, branch))) {
    // Clean tree and nothing stacked locally → genuinely nothing to do. (With
    // unpushed commits we fall through and push them instead of reporting "no
    // changes" until the next edit.)
    return false;
  }

  const auth = gitAuthArgs(options.url, tokenForGitUrl(options.url, options.config, options.tokens));
  // Absorb remote commits pushed since the last sync BEFORE pushing. Fetch is
  // best-effort: offline, the push below reports the real network error.
  if (branch !== "HEAD") {
    try {
      await git(repoRoot, [...auth, "fetch", "origin", branch]);
    } catch {
      /* fall through to push */
    }
    if ((await behindRemote(repoRoot, branch)) > 0) {
      try {
        await git(repoRoot, ["rebase", `origin/${branch}`]);
      } catch {
        // Conflicting external change: capture the conflicted paths, restore
        // the pre-rebase state (local commits preserved), and surface a
        // decodable sentinel — the generic push-failure hint would mislead.
        let conflicted: string[] = [];
        try {
          const { stdout } = await git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]);
          conflicted = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        } catch {
          /* file list is best-effort */
        }
        await git(repoRoot, ["rebase", "--abort"]).catch(() => {});
        throw new Error(`REBASE_CONFLICT:${conflicted.join(", ")}`);
      }
    }
  }
  await git(repoRoot, [...auth, "push", "origin", `HEAD:${branch}`]);
  logger.info({ ...options.log, branch }, options.pushedMessage);
  return true;
}
