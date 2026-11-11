import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig, GitRepository } from "./types.js";
import type { Store } from "./store.js";
import {
  gitAuthConfig,
  marketplaceCloneUrl,
  pathExists,
  sanitizeName,
  scrubGitError,
  serverGitEnv,
  type GitConfigPairs,
} from "./marketplace.js";
import { tokenForGitUrl } from "./gitCredentials.js";
import { assertAllowedGitSource } from "./gitSourcePolicy.js";
import { withRepoLock } from "./gitMutex.js";
import { assertSafeGitValue, safeIdentity, safePushBranch } from "./repoGitGuards.js";
import { git, currentBranch, originUrl } from "./repoGitCore.js";
import logger from "./logger.js";

const execFileAsync = promisify(execFile);

export interface GitRepoContext {
  userId: string;
  name: string;
  repo: string;
  branch: string | null;
  token: string | null;
  config: AppConfig;
}

export function normalizeGitRepoName(name: string): string {
  return sanitizeName(name.trim()).toLowerCase().replace(/^-+|-+$/g, "") || "repo";
}

export function defaultGitRepoName(repo: string): string {
  const withoutSlash = repo.trim().replace(/\/+$/g, "");
  const leaf = withoutSlash.split(/[/:]/).pop() || "repo";
  return normalizeGitRepoName(leaf.replace(/\.git$/i, ""));
}

export function gitRepoClonePath(userId: string, name: string, config: AppConfig): string {
  return path.join(config.dataDir, "git-repos", sanitizeName(userId), normalizeGitRepoName(name));
}

export function gitRepoContextFor(
  store: Store,
  userId: string,
  name: string,
  config: AppConfig,
): GitRepoContext | null {
  const record = store.getGitRepo(userId, normalizeGitRepoName(name));
  if (!record) {
    return null;
  }
  const url = marketplaceCloneUrl(record.repo, config.githubHost);
  return {
    userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: tokenForGitUrl(url, config, store.getGitTokens(userId)) ?? null,
    config,
  };
}

export function gitRepoContextFromRecord(
  store: Store,
  record: GitRepository,
  config: AppConfig,
): GitRepoContext {
  const url = marketplaceCloneUrl(record.repo, config.githubHost);
  return {
    userId: record.userId,
    name: record.name,
    repo: record.repo,
    branch: record.branch,
    token: tokenForGitUrl(url, config, store.getGitTokens(record.userId)) ?? null,
    config,
  };
}

async function checkoutBranch(repoRoot: string, branch: string): Promise<void> {
  assertSafeGitValue(branch, "branch");
  try {
    await git(repoRoot, ["checkout", branch]);
  } catch {
    await git(repoRoot, ["checkout", "-B", branch, `origin/${branch}`]);
  }
}

/**
 * Command-scoped git config for a transfer with the registered origin: the auth
 * header plus what the source policy asks for (`gitSourcePolicy.ts` — no
 * redirects and pinned addresses for a host that is not the configured one).
 */
function transferConfig(ctx: GitRepoContext, url: string, sourceConfig: GitConfigPairs): GitConfigPairs {
  return [...gitAuthConfig(url, ctx.token ?? undefined), ...sourceConfig];
}

async function pullRebase(ctx: GitRepoContext, repoRoot: string, url: string, sourceConfig: GitConfigPairs): Promise<void> {
  const auth = transferConfig(ctx, url, sourceConfig);
  await git(repoRoot, ["fetch", "--prune", "--tags", "origin"], undefined, auth);
  try {
    if (ctx.branch) {
      await checkoutBranch(repoRoot, ctx.branch);
      await git(repoRoot, ["rebase", "--autostash", `origin/${ctx.branch}`]);
    } else {
      await git(repoRoot, ["pull", "--rebase", "--autostash"], undefined, auth);
    }
  } catch (error) {
    // NEVER leave the clone mid-rebase: the avatar never works in Noah's clone
    // (a pi run edits its sandbox copy), so nothing in chat could finish or abort
    // it and a stuck rebase is unrecoverable from chat. Roll back to the pre-sync state
    // and surface an actionable error instead. The abort is best-effort AND the
    // try also covers checkout/fetch (where no rebase is in progress), so
    // `git rebase --abort` exits non-zero there — only claim "rolled back" when it
    // actually ran.
    const rolledBack = await git(repoRoot, ["rebase", "--abort"]).then(
      () => true,
      () => false,
    );
    const detail =
      (error as { stderr?: string; stdout?: string })?.stderr?.trim() ||
      (error as { stdout?: string })?.stdout?.trim() ||
      (error instanceof Error ? error.message : String(error));
    throw new Error(
      scrubGitError(
        `Sync failed while updating from the upstream${rolledBack ? " (the local clone was rolled back to its previous state)" : ""}. Reconcile the conflicting changes (re-create them on top of the latest remote, or discard the local work) and sync again. Do not work around this with Bash git — the shell has no git credentials. Original error: ${detail}`,
      ),
    );
  }
}

/**
 * Update from the upstream WITHOUT rewriting any local commit (#81): fetch,
 * then fast-forward to the upstream when the clone is behind, keep the clone
 * when it is ahead (its local commits — e.g. commits fast-forwarded in from
 * another registered repo — keep their SHAs), and refuse when the two
 * diverged, where `pullRebase` would re-create the local commits with new SHAs.
 * No upstream ref yet (a branch origin does not have) = nothing to update.
 */
async function pullFastForwardOnly(ctx: GitRepoContext, repoRoot: string, url: string, sourceConfig: GitConfigPairs): Promise<void> {
  const auth = transferConfig(ctx, url, sourceConfig);
  await git(repoRoot, ["fetch", "--prune", "--tags", "origin"], undefined, auth);
  if (ctx.branch) await checkoutBranch(repoRoot, ctx.branch);
  const upstream = ctx.branch ? `origin/${ctx.branch}` : "@{upstream}";
  const known = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]).then(
    () => true,
    () => false,
  );
  if (!known) return;
  if (await isAncestor(repoRoot, upstream, "HEAD")) return; // up to date, or ahead with local commits
  if (await isAncestor(repoRoot, "HEAD", upstream)) {
    await git(repoRoot, ["merge", "--ff-only", "--quiet", upstream]);
    return;
  }
  const ahead = Number.parseInt((await git(repoRoot, ["rev-list", "--count", `${upstream}..HEAD`])).stdout.trim(), 10) || 0;
  throw new Error(
    `Not synced: origin moved past Noah's clone of '${ctx.name}', which holds ${ahead} commit(s) origin does not have. A normal sync would rebase them onto origin and give them NEW SHAs, so this fast-forward-only sync changed nothing. If their SHAs do not matter, run mcp__git_repo__sync_repo without 'from' (rebase), then push; to keep the SHAs, the history has to be reconciled outside Noah (or bring origin's new commits into the source repo first and sync with 'from' again).`,
  );
}

/**
 * True when the clone has commits not present on ANY upstream — i.e. local work
 * that a `rm -rf` would silently destroy. Uses the configured-branch upstream
 * when set, else the tracking upstream of HEAD; returns false when there's no
 * upstream to compare against (can't prove unpushed work, so don't block).
 */
async function hasUnpushedCommits(repoRoot: string, branch: string | null): Promise<boolean> {
  const upstream = branch ? `origin/${branch}` : "@{upstream}";
  try {
    const { stdout } = await git(repoRoot, ["rev-list", `${upstream}..HEAD`, "--count"]);
    return Number.parseInt(stdout.trim(), 10) > 0;
  } catch {
    // No such upstream / detached with no tracking ref: can't determine, and a
    // freshly-cloned mismatch typically has none. Treat as "no unpushed work".
    return false;
  }
}

/**
 * Ensure the user-registered repo has a local full clone under dataDir. When
 * `sync` is true, fetch and rebase local work onto the upstream (--autostash;
 * aborts cleanly on conflict, see pullRebase); otherwise preserve local work.
 * Serialized per clone path so concurrent turns/tools can't interleave
 * clone/fetch/checkout on one working tree (git-02).
 */
export async function ensureGitRepoClone(
  ctx: GitRepoContext,
  options: { sync?: boolean; fastForwardOnly?: boolean } = {},
): Promise<string> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  return withRepoLock(repoRoot, () => ensureGitRepoCloneLocked(ctx, repoRoot, options));
}

/**
 * Clone/fetch body of ensureGitRepoClone WITHOUT the per-path lock. Callers that
 * already hold the lock for `repoRoot` (commit/push) call this directly so they
 * never re-enter `withRepoLock` for the same key (deadlock-free, see gitMutex).
 */
async function ensureGitRepoCloneLocked(
  ctx: GitRepoContext,
  repoRoot: string,
  options: { sync?: boolean; fastForwardOnly?: boolean } = {},
): Promise<string> {
  assertSafeGitValue(ctx.repo, "repo");
  assertSafeGitValue(ctx.branch, "branch");
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  assertSafeGitValue(url, "repo");
  // Source policy on EVERY use (gitSourcePolicy.ts): a repo registered before
  // the policy existed with a source it refuses — another user's clone, a
  // loopback host — is refused here with the same message, never silently
  // skipped, even when its clone already exists and nothing would be fetched.
  // The host itself is resolved further down, only when this call is about to
  // use the network (a clone or a sync).
  await assertAllowedGitSource(url, ctx.config);

  if (await pathExists(path.join(repoRoot, ".git"))) {
    const existing = await originUrl(repoRoot);
    if (existing && existing !== url) {
      // The remote URL changed. Blowing the clone away silently destroys any
      // committed-but-unpushed work, so refuse when such work exists; only
      // auto-remove a clone with nothing unpushed (git-07).
      if (await hasUnpushedCommits(repoRoot, ctx.branch)) {
        throw new Error(
          scrubGitError(
            `The local clone's remote (${existing}) differs from the registered repository, but it has unpushed commits, so it was not replaced automatically. Push or back up those changes and try again.`,
          ),
        );
      }
      logger.warn(
        { userId: ctx.userId, name: ctx.name, existing, url },
        "git repo clone remote URL changed; removing clone (no unpushed commits)",
      );
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  }

  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    const source = await assertAllowedGitSource(url, ctx.config, { resolve: true });
    const auth = transferConfig(ctx, url, source.gitConfig);
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    const args = ["clone"];
    if (ctx.branch) {
      args.push("--branch", ctx.branch);
    }
    args.push("--", url, repoRoot);
    try {
      await execFileAsync("git", args, { timeout: 180_000, env: serverGitEnv(auth) });
    } catch (error) {
      // Remove a half-initialized clone so the next run re-clones cleanly (git-06).
      await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return repoRoot;
  }

  if (options.sync) {
    const source = await assertAllowedGitSource(url, ctx.config, { resolve: true });
    if (options.fastForwardOnly) await pullFastForwardOnly(ctx, repoRoot, url, source.gitConfig);
    else await pullRebase(ctx, repoRoot, url, source.gitConfig);
  }
  return repoRoot;
}

export async function removeGitRepoClone(ctx: GitRepoContext): Promise<void> {
  await fs.rm(gitRepoClonePath(ctx.userId, ctx.name, ctx.config), { recursive: true, force: true });
}

export async function configureGitRepoIdentity(
  ctx: GitRepoContext,
  identity: { name: string; email: string },
): Promise<void> {
  const repoRoot = await ensureGitRepoClone(ctx);
  await configureGitRepoIdentityInClone(repoRoot, identity);
}

async function configureGitRepoIdentityInClone(
  repoRoot: string,
  identity: { name: string; email: string },
): Promise<void> {
  const { name, email } = safeIdentity(identity);
  await git(repoRoot, ["config", "user.name", name]);
  await git(repoRoot, ["config", "user.email", email]);
}

export async function pushGitRepo(ctx: GitRepoContext): Promise<string> {
  return (await pushGitRepoDetailed(ctx)).branch;
}

export interface GitRepoPushResult {
  branch: string;
  /** The clone's HEAD that was pushed. */
  head: string;
  /** origin's branch already had that HEAD: nothing was sent (#81 — never report it as "Pushed"). */
  upToDate: boolean;
}

/** {@link pushGitRepo}, also telling whether origin already had the clone's HEAD (`git push --porcelain` flag `=`). */
export async function pushGitRepoDetailed(ctx: GitRepoContext): Promise<GitRepoPushResult> {
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  // Serialize the ensure+push against concurrent ops on the same clone (git-02).
  return withRepoLock(repoRoot, async () => {
    await ensureGitRepoCloneLocked(ctx, repoRoot);
    const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
    // The push is the network use: resolve the host now (an existing clone was not resolved above).
    const source = await assertAllowedGitSource(url, ctx.config, { resolve: true });
    const auth = transferConfig(ctx, url, source.gitConfig);
    const branch = safePushBranch(ctx.branch || (await currentBranch(repoRoot)) || "HEAD");
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const { stdout } = await git(repoRoot, ["push", "--porcelain", "origin", `HEAD:${branch}`], undefined, auth);
    // Porcelain ref lines are `<flag>\t<from>:<to>\t<summary>`; `=` = up to date (locale-independent).
    const refLines = stdout.split("\n").filter((line) => /^[ +\-*=!]\t/.test(line));
    const upToDate = refLines.length > 0 && refLines.every((line) => line.startsWith("=\t"));
    return { branch, head, upToDate };
  });
}

/**
 * Fetch the branch tip of ANOTHER registered repo's canonical clone (`source`,
 * same owner) into `target`'s clone — objects only, no ref or working-tree
 * change — and return that commit. Both are Noah's own clones (never a
 * sandbox `.git`), so commits travel with their SHA, author and message
 * intact: the external→internal bridge of #81 (`sync_repo` `from`). The BRANCH
 * ref is fetched, not HEAD: a branch moves only when a rebase/commit there
 * finishes, while HEAD is detached mid-rebase (the source lock is NOT taken —
 * nesting it under the target's could deadlock `a from b` against `b from a`).
 * The source clone must exist (`ensureGitRepoClone(source)` first); it is used
 * as it stands, not synced here.
 */
export async function fetchRegisteredCloneHead(target: GitRepoContext, source: GitRepoContext): Promise<string> {
  const targetRoot = gitRepoClonePath(target.userId, target.name, target.config);
  const sourceRoot = gitRepoClonePath(source.userId, source.name, source.config);
  if (path.resolve(targetRoot) === path.resolve(sourceRoot)) throw new Error("A repository cannot be fast-forwarded from itself.");
  const branch = source.branch || (await currentBranch(sourceRoot));
  assertSafeGitValue(branch, "branch");
  const sourceRef = branch ? `refs/heads/${branch}` : "HEAD";
  return withRepoLock(targetRoot, async () => {
    await ensureGitRepoCloneLocked(target, targetRoot);
    await git(targetRoot, ["fetch", "--no-tags", "--quiet", "--", sourceRoot, sourceRef], 180_000);
    return (await git(targetRoot, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).stdout.trim();
  });
}

export type GitRepoFastForward =
  | { kind: "forwarded"; from: string; to: string; commits: number }
  | { kind: "contains"; head: string }
  | { kind: "not_fast_forward"; head: string; behind: number };

/** Whether `ancestor` is an ancestor of (or equal to) `descendant` in the clone. */
async function isAncestor(repoRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
    () => true,
    () => false,
  );
}

/**
 * Where `commit` (already in the clone, see {@link fetchRegisteredCloneHead})
 * stands against the clone's HEAD, and — unless `dryRun` — fast-forward the
 * clone to it (`git merge --ff-only`, never a merge commit or a rebase, so its
 * SHA is kept). `not_fast_forward`: the clone has commits `commit` lacks
 * (`behind` of them) — nothing is changed.
 */
export async function fastForwardGitRepo(ctx: GitRepoContext, commit: string, options: { dryRun?: boolean } = {}): Promise<GitRepoFastForward> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) throw new Error("Not a commit id.");
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  return withRepoLock(repoRoot, async () => {
    const head = (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    if (await isAncestor(repoRoot, commit, head)) return { kind: "contains", head };
    if (!(await isAncestor(repoRoot, head, commit))) {
      const behind = Number.parseInt((await git(repoRoot, ["rev-list", "--count", `${commit}..${head}`])).stdout.trim(), 10) || 0;
      return { kind: "not_fast_forward", head, behind };
    }
    const commits = Number.parseInt((await git(repoRoot, ["rev-list", "--count", `${head}..${commit}`])).stdout.trim(), 10) || 0;
    if (!options.dryRun) await git(repoRoot, ["merge", "--ff-only", "--quiet", commit]);
    return { kind: "forwarded", from: head, to: commit, commits };
  });
}
