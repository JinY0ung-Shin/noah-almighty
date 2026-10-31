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
} from "./marketplace.js";
import { tokenForGitUrl } from "./gitCredentials.js";
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

async function pullRebase(ctx: GitRepoContext, repoRoot: string, url: string): Promise<void> {
  const auth = gitAuthConfig(url, ctx.token ?? undefined);
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
  options: { sync?: boolean } = {},
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
  options: { sync?: boolean } = {},
): Promise<string> {
  assertSafeGitValue(ctx.repo, "repo");
  assertSafeGitValue(ctx.branch, "branch");
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  assertSafeGitValue(url, "repo");
  const auth = gitAuthConfig(url, ctx.token ?? undefined);

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
    await pullRebase(ctx, repoRoot, url);
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
  const repoRoot = gitRepoClonePath(ctx.userId, ctx.name, ctx.config);
  // Serialize the ensure+push against concurrent ops on the same clone (git-02).
  return withRepoLock(repoRoot, async () => {
    await ensureGitRepoCloneLocked(ctx, repoRoot);
    const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
    const auth = gitAuthConfig(url, ctx.token ?? undefined);
    const branch = safePushBranch(ctx.branch || (await currentBranch(repoRoot)) || "HEAD");
    await git(repoRoot, ["push", "origin", `HEAD:${branch}`], undefined, auth);
    return branch;
  });
}
