import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafeGitValue } from "./repoGitGuards.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_GITHUB_HOST = "github.com";

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Sanitize an arbitrary repo/source string into a safe directory segment. */
export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Normalize an operator-provided GitHub host into the host[:port] part only. */
export function normalizeGithubHost(host?: string | null): string {
  const raw = (host ?? "").trim();
  if (!raw) {
    return DEFAULT_GITHUB_HOST;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).host || DEFAULT_GITHUB_HOST;
  } catch {
    return raw.replace(/^https?:\/\//i, "").replace(/\/+$/g, "") || DEFAULT_GITHUB_HOST;
  }
}

/**
 * Redact an auth header from a git error before it's returned to a client or
 * logged. The header now rides the environment (gitAuthConfig), not the argv
 * `execFile` embeds in `err.message`, but git or a remote can still echo it and
 * the base64 trivially decodes back to the token — keep stripping it.
 */
export function scrubGitError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/Authorization: Basic [^\s'"]+/g, "Authorization: Basic [REDACTED]");
}

/**
 * Reject a source that git would interpret as an option (leading `-`) rather
 * than a repo, plus `scheme::` remote-helper syntax. Combined with a `--`
 * separator before positionals, this blocks argument-injection
 * (e.g. `--upload-pack=…` → RCE). Delegates to the ONE shared validator so the
 * plugin clone path can't drift from the knowledge/git-repo clone paths (T3.8).
 */
function assertSafeArg(value: string, what: string): void {
  assertSafeGitValue(value, what);
}

/**
 * Resolve a repo reference (`owner/repo`, a github URL, or a git/https URL) into
 * a clonable git URL.
 *
 * The token is intentionally NOT injected here: embedding it in the remote URL
 * would persist it in the clone's `.git/config` on disk. Authentication is
 * instead supplied per-invocation via `gitAuthConfig` (an `http.extraHeader`
 * passed through the environment), which git uses for the transfer but never
 * writes to disk.
 */
export function marketplaceCloneUrl(source: string, githubHost = DEFAULT_GITHUB_HOST): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return `https://${normalizeGithubHost(githubHost)}/${source}.git`;
  }
  return source;
}

/** git config entries applied to ONE server-side git invocation (key, value). */
export type GitConfigPairs = readonly (readonly [string, string])[];

/**
 * Per-invocation git auth for a token: an `http.extraHeader` carrying
 * `Authorization: Basic …` (GitHub accepts `x-access-token:TOKEN`). Returns []
 * when there's no token or the URL isn't an https transfer (e.g. ssh/git@), so
 * the header is only attached where it's actually used.
 *
 * The entry reaches git through {@link serverGitEnv} (GIT_CONFIG_* env), never
 * argv: a process's cmdline is world-readable under /proc, its environment is
 * not (#71). git never persists it to `.git/config`, so the clone stays clean.
 */
export function gitAuthConfig(url: string, token?: string): GitConfigPairs {
  // Case-insensitive https check to match `tokenForGitUrl` (gitCredentials.ts):
  // a `HTTPS://`-cased URL must route auth consistently in both places (git-08).
  if (!token || !/^https:\/\//i.test(url)) {
    return [];
  }
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return [["http.extraHeader", `Authorization: Basic ${basic}`]];
}

/**
 * Config every server-run git command gets: the clones it works in are edited
 * by the agent, so repo-local hooks and an fsmonitor command must never run
 * inside the server's git (#71).
 */
const SERVER_GIT_HARDENING: GitConfigPairs = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
];

/**
 * Environment for a server-side git process: the server's own env plus
 * {@link SERVER_GIT_HARDENING} and `extra` (e.g. {@link gitAuthConfig}) as
 * GIT_CONFIG_COUNT/KEY/VALUE entries — command-scoped config that git reads
 * like `-c` without it ever appearing in argv.
 */
export function serverGitEnv(
  extra: GitConfigPairs = [],
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const pairs = [...SERVER_GIT_HARDENING, ...extra];
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

/**
 * Resolve the revision a clone's working tree should be forced to:
 * an explicit `ref` (preferring its remote-tracking branch, else the ref as-is
 * for a tag/sha), or the default branch's upstream when no ref is given.
 */
async function resolveTarget(destination: string, ref?: string): Promise<string> {
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", destination, ...args], { timeout: 60_000, env: serverGitEnv() });
  if (ref) {
    try {
      await git("rev-parse", "--verify", "--quiet", `origin/${ref}`);
      return `origin/${ref}`;
    } catch {
      return ref;
    }
  }
  try {
    await git("rev-parse", "--verify", "--quiet", "@{upstream}");
    return "@{upstream}";
  } catch {
    return "HEAD";
  }
}

/**
 * Clone (or fetch) a git repo into `destination` and force its working tree to
 * exactly match the target revision. When `token` is given it is passed as a
 * per-invocation auth header (see `gitAuthArgs`), never written into the remote.
 *
 * `git fetch` alone only moves remote-tracking refs — it leaves the working
 * tree on the old commit, so files deleted upstream (e.g. a skill removed from
 * a marketplace) would linger on refresh. We `reset --hard` to the fetched
 * target and `clean -fd` untracked leftovers so the clone is an exact mirror.
 *
 * Shallow but multi-branch: a plain `clone --depth 1` implies `--single-branch`
 * (only the default branch's refspec), so a plugin pinned to a NON-default
 * branch never materializes `origin/<ref>` — `resolveTarget` falls back to the
 * raw ref and `reset --hard <branch>` errors on every clone and refresh. We add
 * `--no-single-branch` so all branches' remote-tracking refs exist (still
 * shallow), and the existing `fetch --all` keeps them current on refresh (git-03).
 */
export async function syncGitRepo(
  url: string,
  destination: string,
  ref?: string,
  token?: string,
): Promise<void> {
  assertSafeArg(url, "repo");
  // The ref reaches `git reset --hard <ref>` (via resolveTarget's fallback) and
  // a `git rev-parse origin/<ref>`; reject a leading-dash value git would parse
  // as an option, consistent with the url guard above (git-04).
  if (ref !== undefined) {
    assertSafeArg(ref, "ref");
  }
  const auth = gitAuthConfig(url, token);
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", destination, ...args], { timeout: 120_000, env: serverGitEnv() });

  if (await pathExists(path.join(destination, ".git"))) {
    await execFileAsync("git", ["-C", destination, "fetch", "--all", "--prune", "--tags"], {
      timeout: 120_000,
      env: serverGitEnv(auth),
    });
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // `--` stops git from treating a crafted url/destination as an option.
    // `--no-single-branch` keeps every branch's remote-tracking ref (so a
    // non-default `ref` resolves) while staying shallow.
    try {
      await execFileAsync(
        "git",
        ["clone", "--depth", "1", "--no-single-branch", "--", url, destination],
        { timeout: 120_000, env: serverGitEnv(auth) },
      );
    } catch (error) {
      // A timeout kills git mid-clone, so its own cleanup doesn't run; a leftover
      // half-clone makes the NEXT call take the fetch branch against a tree with
      // no valid target. Remove the partial dir and rethrow (git-06, matching the
      // knowledge/group clone paths).
      await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  const target = await resolveTarget(destination, ref);
  await git("reset", "--hard", target);
  await git("clean", "-fd");
}
