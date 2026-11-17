// Shared low-level git plumbing for the repo clone/commit/push paths
// (knowledgeRepo.ts, gitRepos.ts; the retired groupKnowledgeRepo.ts too). These modules
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
import { gitAuthConfig, pathExists, scrubGitError, serverGitEnv, type GitConfigPairs } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import { safeIdentity, safePushBranch } from "./repoGitGuards.js";
import type { AppConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export { assertSafeGitValue } from "./repoGitGuards.js";

/**
 * Run `git -C <repoRoot> <args>` and resolve with `{stdout, stderr}`. The
 * default timeout (120s) matches every call site's prior inline wrapper; pass an
 * explicit timeout to override (the clone paths use longer ones at their own
 * `execFile` call, outside this helper). `config` (e.g. gitAuthConfig) rides
 * the environment via serverGitEnv — never argv — next to the hardening every
 * server git command gets.
 */
export function git(repoRoot: string, args: string[], timeout = 120_000, config: GitConfigPairs = []) {
  return execFileAsync("git", ["-C", repoRoot, ...args], { timeout, env: serverGitEnv(config), maxBuffer: GIT_OUTPUT_MAX_BUFFER });
}

/**
 * How much output one git command may print before Node kills it (Node's own
 * default is 1 MiB). git names every path of a large change — `status`, the
 * summary `commit` prints (`create mode … <path>`), a fast-forward's diffstat —
 * so one commit of thousands of files (a vault mirrored into an empty
 * repository) passes 1 MiB. Only a cap: nothing is allocated until it is printed.
 */
const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The clone's `origin` remote URL (clean, without any auth — auth is supplied
 * per-call via an env-borne `http.extraHeader`, never written to `.git/config`), or null when
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
 * Every uncommitted change of the working tree, one entry per path, with the
 * path EXACTLY as it is on disk (`-z`: no quoting of non-ASCII names, no
 * `old -> new` pairs) and untracked files listed one by one. `code` is git's
 * two-letter XY status (`" M"`, `"??"`, `"A "`, …). For callers that must
 * judge each path — {@link dirtyPaths} keeps its own, coarser reading.
 */
export async function statusEntries(repoRoot: string): Promise<{ code: string; path: string }[]> {
  const { stdout } = await git(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames"]);
  const fields = stdout.split("\0");
  const entries: { code: string; path: string }[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    // A rename/copy record (only if git ignored --no-renames) carries its origin as the next field.
    if (/[RC]/.test(code) && fields[i + 1]) {
      i += 1;
      entries.push({ code, path: fields[i] });
    }
  }
  return entries;
}

/** The paths staged in the index (what a `git commit` would record), exactly as on disk. */
export async function stagedPaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await git(repoRoot, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
  return stdout.split("\0").filter(Boolean);
}

/**
 * Count commits on local HEAD not yet on origin/<branch>. Returns 0 when the
 * branch is up to date or behind, a positive count when ahead, and null when
 * origin/<branch> doesn't exist (so callers can tell "fresh repo" apart from
 * "in sync"). Used by the knowledge align path.
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

/** The unmerged paths of a stopped rebase/merge, exactly as on disk, each with the index stages it has (1 base, 2 ours, 3 theirs). */
async function unmergedPaths(repoRoot: string): Promise<Map<string, Set<number>>> {
  const { stdout } = await git(repoRoot, ["ls-files", "-u", "-z"]);
  const unmerged = new Map<string, Set<number>>();
  for (const entry of stdout.split("\0")) {
    // `<mode> <object> <stage>\t<path>`
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const stage = Number.parseInt(entry.slice(0, tab).split(" ")[2] ?? "", 10);
    const file = entry.slice(tab + 1);
    if (!file || !Number.isFinite(stage)) continue;
    const stages = unmerged.get(file) ?? new Set<number>();
    stages.add(stage);
    unmerged.set(file, stages);
  }
  return unmerged;
}

/** Path arguments per git command (argv has a size limit; a path is at most a few hundred bytes). */
const PATHS_PER_COMMAND = 100;
/** A rebase stops at most once per replayed commit; this only bounds a loop that would otherwise never end. */
const MAX_REBASE_STOPS = 1000;

/**
 * Settle every unmerged path of a stopped rebase in favour of the LOCAL side —
 * in a rebase that is "theirs" (stage 3), the commit being replayed: its
 * content where it has the file, a deletion where it deleted a file both sides
 * knew (stage 1 without 3). A path only the remote side added (stage 2 alone —
 * a rename on the remote) is not the local side's to delete and is kept as the
 * remote has it. Paths go to git as literal pathspecs, after `--`.
 */
async function keepLocalSide(repoRoot: string, unmerged: Map<string, Set<number>>): Promise<void> {
  const pick = (test: (stages: Set<number>) => boolean) => [...unmerged].filter(([, stages]) => test(stages)).map(([file]) => file);
  const settle = async (files: string[], commands: string[][]): Promise<void> => {
    for (let i = 0; i < files.length; i += PATHS_PER_COMMAND) {
      const chunk = files.slice(i, i + PATHS_PER_COMMAND);
      for (const command of commands) await git(repoRoot, ["--literal-pathspecs", ...command, "--", ...chunk]);
    }
  };
  await settle(pick((stages) => stages.has(3)), [["checkout", "--theirs"], ["add"]]);
  await settle(pick((stages) => !stages.has(3) && stages.has(1)), [["rm", "-q", "-f"]]);
  await settle(pick((stages) => !stages.has(3) && !stages.has(1)), [["checkout", "--ours"], ["add"]]);
}

/**
 * Replay the local commits onto `origin/<branch>`. A conflict stops it: when
 * the caller gave `vaultPaths` and EVERY conflicted path satisfies it, the
 * local side is kept and the rebase goes on (to the next commit, which may
 * stop again); any other conflict — or a rebase that cannot start — is
 * aborted, which leaves the local commits exactly as they were, and thrown as
 * `REBASE_CONFLICT:<files>`.
 */
async function rebaseOntoRemote(repoRoot: string, branch: string, vaultPaths?: (path: string) => boolean): Promise<void> {
  // `rebase --continue` re-commits the replayed commit with its own message: no editor.
  const noEditor: GitConfigPairs = [["core.editor", "true"]];
  let step: () => Promise<unknown> = () => git(repoRoot, ["rebase", `origin/${branch}`]);
  for (let stops = 0; ; stops += 1) {
    try {
      await step();
      return;
    } catch {
      // Conflicting external change (or a rebase that could not start): capture
      // the conflicted paths. The file list is best-effort.
      let unmerged = new Map<string, Set<number>>();
      try {
        unmerged = await unmergedPaths(repoRoot);
      } catch {
        /* an unreadable list is "not ours to settle" */
      }
      const conflicted = [...unmerged.keys()];
      let settled = false;
      if (vaultPaths && conflicted.length > 0 && stops < MAX_REBASE_STOPS && conflicted.every((file) => vaultPaths(file))) {
        try {
          await keepLocalSide(repoRoot, unmerged);
          settled = true;
        } catch {
          /* falls through to the abort */
        }
      }
      if (!settled) {
        // Restore the pre-rebase state (local commits preserved) and surface a
        // decodable sentinel — the generic push-failure hint would mislead.
        await git(repoRoot, ["rebase", "--abort"]).catch(() => {});
        throw new Error(`REBASE_CONFLICT:${conflicted.join(", ")}`);
      }
      // Keeping the local side can leave the replayed commit with nothing to add (the remote already says the same).
      const empty = await git(repoRoot, ["diff", "--cached", "--quiet"]).then(
        () => true,
        () => false,
      );
      step = () => git(repoRoot, ["rebase", empty ? "--skip" : "--continue"], undefined, noEditor);
    }
  }
}

/**
 * Stage all changes, commit with the given identity, and push to the remote
 * branch — the body of the knowledge commitAndPush path. Returns false when there is nothing to do (clean tree AND nothing
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
 * instead of hinting at token/branch-protection problems. A caller that owns some
 * paths outright (`vaultPaths`) gets conflicts confined to them settled for its
 * side, and its `afterRebase` hook before the push — see the options.
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
    /**
     * A last look before a commit is made: called with every path `git add -A`
     * staged (exactly as on disk), only when there is something to commit. A
     * throw stops here — nothing is committed or pushed (the paths stay staged,
     * which the next `git add -A` re-reads anyway). Absent = today's behaviour.
     */
    checkStaged?: (staged: string[]) => void | Promise<void>;
    /**
     * Paths whose content the CALLER owns outright (the vault notes of an owner
     * whose vault lives in the memory service: the clone only holds a copy). A
     * rebase conflict whose conflicted paths ALL satisfy it is resolved in
     * favour of the local side and the rebase continues — a direct git edit of
     * such a file never blocks a commit. Any other conflict aborts as always.
     * Absent = every conflict aborts (today's behaviour).
     */
    vaultPaths?: (path: string) => boolean;
    /**
     * Runs after local commits were rebased onto remote commits and before the
     * push: the remote's commits changed the working tree, so the caller may
     * write its own files again. What it changed is committed too
     * (`followUpMessage`, else the commit message; `checkStaged` looks at it
     * as well). Not called when nothing was rebased.
     */
    afterRebase?: () => Promise<void>;
    followUpMessage?: string;
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
  // commitMsg is the value of `-m` (a discrete argv element), so it's never
  // parsed as a flag even if it starts with `-`.
  const commitMsg = options.message.trim() || options.defaultMessage;
  if (hasChanges) {
    if (options.checkStaged) {
      await options.checkStaged(await stagedPaths(repoRoot));
    }
    await git(repoRoot, ["commit", "-m", commitMsg]);
  } else if (branch === "HEAD" || !(await aheadOfRemote(repoRoot, branch))) {
    // Clean tree and nothing stacked locally → genuinely nothing to do. (With
    // unpushed commits we fall through and push them instead of reporting "no
    // changes" until the next edit.)
    return false;
  }

  const auth = gitAuthConfig(options.url, tokenForGitUrl(options.url, options.config, options.tokens));
  // Absorb remote commits pushed since the last sync BEFORE pushing. Fetch is
  // best-effort: offline, the push below reports the real network error.
  if (branch !== "HEAD") {
    try {
      await git(repoRoot, ["fetch", "origin", branch], undefined, auth);
    } catch {
      /* fall through to push */
    }
    if ((await behindRemote(repoRoot, branch)) > 0) {
      await rebaseOntoRemote(repoRoot, branch, options.vaultPaths);
      if (options.afterRebase) {
        await options.afterRebase();
        // Same order as the first commit: the `.mcp.json` restore BEFORE `git add -A`.
        await restoreTrackedMcpJson(repoRoot);
        await git(repoRoot, ["add", "-A"]);
        if ((await dirtyPaths(repoRoot)).length > 0) {
          if (options.checkStaged) {
            await options.checkStaged(await stagedPaths(repoRoot));
          }
          await git(repoRoot, ["commit", "-m", options.followUpMessage?.trim() || commitMsg]);
        }
      }
    }
  }
  await git(repoRoot, ["push", "origin", `HEAD:${branch}`], undefined, auth);
  logger.info({ ...options.log, branch }, options.pushedMessage);
  return true;
}
