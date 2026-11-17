/**
 * The git mirror of a personal vault whose home is `memory` (`personalVault.ts`).
 *
 * The memory service is the ONLY writer of such a vault. The owner's knowledge
 * repository receives a COPY: Noah writes the service's notes into its own
 * clone (`dataDir/knowledge/<userId>`), commits them as the owner and pushes
 * with the owner's stored token. The copy is push-only — nothing here reads a
 * vault note back from the clone or the remote to decide content (a file is
 * compared only to skip an identical write), so an edit made directly in git
 * to a vault note is overwritten by the next mirror commit and stays in the
 * repository's history.
 *
 * What one pass does to the clone, for paths where `isPersonalVaultPath` is
 * true and for no other file:
 * - ADD / REPLACE every note the service holds.
 * - DELETE only what Noah deleted: a clone vault file is removed when its path
 *   is in the owner's deletion ledger (`store.recordVaultDelete`, written by
 *   `MemoryVault.remove` before the service is asked) AND the service no longer
 *   holds it. The ledger entries a pass settled are cleared when that pass is
 *   recorded ok.
 * - A clone vault file the service lacks and the ledger does not name is NEVER
 *   deleted (a note that only exists in git, a wiped service volume): the pass
 *   still ends `synced` and leaves a NOTICE on the row with their count.
 * - The one exception is the owner's own press: with the row's one-shot
 *   `mirrorReplaceAll` set, that pass makes the repository equal to the service
 *   (unledgered vault files are deleted too) and clears the flag.
 *
 * Never through a link: every file operation goes through `CloneVaultFiles`,
 * which refuses a linked or non-folder ancestor. A link sitting at a note's own
 * path is replaced by a plain file, never written through. Only Noah's
 * canonical clone is touched — never a sandbox copy.
 *
 * Locks: a pass runs under the clone's repo lock (`withRepoLock`, not
 * reentrant — `locked: true` = the caller holds it). It reads the service with
 * the `MemoryClient` directly and never takes the vault write lock
 * (`withVaultWriteLock`), so the one lock order is "vault write lock → repo
 * lock": a caller may hold the vault write lock around `syncVaultMirror`, and
 * nothing that holds the repo lock may ask for the vault write lock.
 *
 * A pass reads the row's `mirrorSeq` BEFORE it reads the service and hands it
 * back when success is recorded, so a write that arrived while it ran keeps
 * the row dirty for the next pass. Row and ledger are finalized only once the
 * push went through (`finishVaultMirror`). A failure loses nothing: the row
 * stays dirty, `mirrorError` says why, the next pass retries.
 */
import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import logger from "./logger.js";
import { withRepoLock } from "./gitMutex.js";
import {
  VAULT_MIRROR_COMMIT_MESSAGE,
  commitAndPushLocked,
  commitIdentityFor,
  ensureCloneLocked,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  type KnowledgeRepoContext,
} from "./knowledgeRepo.js";
import { marketplaceCloneUrl, pathExists, scrubGitError } from "./marketplace.js";
import { MemoryRefusedError, MemoryUnavailableError, memoryClientFor, type MemoryClient } from "./memory/memoryClient.js";
import { isPersonalVaultPath, normalizeVaultPath } from "./personalVault.js";
import { originUrl, statusEntries } from "./repoGitCore.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";

/**
 * What finalizes a pass on the row and the ledger once its commit is pushed
 * ({@link finishVaultMirror}): the `mirrorSeq` it started from, its notice,
 * the ledger entries it settled, and whether it carried out `mirrorReplaceAll`.
 */
export interface VaultMirrorPending {
  seq: number;
  notice: string | null;
  settledDeletes: string[];
  replacedAll: boolean;
}

export type VaultMirrorOutcome =
  /**
   * The clone's working tree now holds every note of the service, and none that Noah deleted (`changed` =
   * files written or deleted). `notice` (one of {@link VAULT_MIRROR_NOTICE}, with a count) says what the
   * pass left alone; null = nothing. With `push: true` that state is committed, pushed and recorded. With
   * `push: false` nothing is recorded: `pending` is what the caller hands to {@link finishVaultMirror}
   * after ITS push.
   */
  | { kind: "synced"; changed: number; seq: number; notice?: string | null; pending?: VaultMirrorPending }
  | { kind: "skipped"; reason: "hold" | "no_repo" | "repo_dirty" }
  | { kind: "failed"; error: string };

/**
 * What a pass stores in `mirrorError` (and returns as `failed.error`). The
 * values are stable: each is the whole text, or its beginning when a detail
 * follows in parentheses or after a colon. `hold` and `no_repo` store nothing.
 */
export const VAULT_MIRROR_ERROR = {
  /** `skipped: repo_dirty` — uncommitted changes outside vault paths; the avatar's own commit carries the mirror. */
  repoDirty: "repo has uncommitted changes",
  noToken: "no git token",
  /** `locked: true` only: the caller's clone is not there. */
  notCloned: "not cloned",
  ownerMissing: "owner not found",
  /** + ` (<reason>)` — network, timeout, unauthorized, no_route, server_error, bad_answer, not_configured. */
  serviceUnavailable: "memory service unavailable",
  /** + ` (<code>)` — the service answered and said no. */
  serviceRefused: "memory service refused",
  /** + `: <git's words>` — the clone could not be cloned / fetched. */
  cloneSync: "clone sync failed",
  /** + `: <files>` — the remote and unpushed local commits changed the same files outside the vault. */
  rebaseConflict: "rebase conflict",
  /** + `: <git's words>` — rejected, no permission, network. */
  push: "push failed",
  /** + `: <git's words>`. */
  commit: "commit failed",
  /** + `: <what>` — a link or a file where the mirror needs a plain folder (or a folder where it needs a note). */
  path: "path blocked",
  /** + `: <detail>` — anything else. */
  other: "mirror failed",
} as const;

/**
 * What a successful pass stores in `mirrorNotice` (and returns as
 * `synced.notice`): the stable beginning, then `: <count>`.
 */
export const VAULT_MIRROR_NOTICE = {
  /** + `: <count>` — vault notes in the repository that the service does not hold and Noah did not delete; they were left as they are. */
  repoOnly: "repository notes not in the memory service",
} as const;

const DEFAULT_INTERVAL_MS = 60_000;
/** Notes read from the service at a time (each is written before the next is read: memory stays bounded). */
const READ_CONCURRENCY = 8;
/** The service's own depth limit — nothing deeper can be a vault path. */
const MAX_WALK_DEPTH = 16;
const MAX_DETAIL_CHARS = 200;

const log = logger.child({ module: "vaultMirror" });

/** A failure with its final text (one of {@link VAULT_MIRROR_ERROR}, with or without a detail). */
class MirrorFailure extends Error {}
/** The clone has uncommitted changes outside vault paths. */
class RepoDirty extends Error {}

// ---- failure text ---------------------------------------------------------------

/** git's own telling lines, without the clone path, credentials or the command echo. */
function gitDetail(error: unknown, repoRoot: string): string {
  if ((error as { killed?: unknown } | null)?.killed === true) return "git did not finish in time";
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : String(error);
  const text = scrubGitError(raw)
    .split(repoRoot)
    .join("<clone>")
    .replace(/:\/\/[^/@\s]+@/g, "://");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Command failed:") && !line.startsWith("hint:"));
  const telling = lines.filter((line) => /^(fatal:|error:|remote:|! \[)/.test(line));
  return (telling.length > 0 ? telling : lines.slice(-1)).slice(-3).join("; ").slice(0, MAX_DETAIL_CHARS) || "git failed";
}

const withDetail = (head: string, detail: string) => `${head}: ${detail}`.slice(0, MAX_DETAIL_CHARS + head.length + 2);

/**
 * The `mirrorError` text for a failed commit + push of the knowledge clone
 * (what `commitAndPush` / `commitAndPushClone` threw). For the `commit` tool:
 * after a `push: false` mirror it records
 * `store.recordVaultMirror(userId, { ok: false, error: vaultMirrorCommitError(error, repoRoot) })`.
 */
export function vaultMirrorCommitError(error: unknown, repoRoot: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "NOT_CLONED") return VAULT_MIRROR_ERROR.notCloned;
  if (message.startsWith("REBASE_CONFLICT:")) {
    const files = message.slice("REBASE_CONFLICT:".length).trim();
    return withDetail(VAULT_MIRROR_ERROR.rebaseConflict, files || "the working tree could not be rebased");
  }
  // The failing command is named in execFile's message: `Command failed: git -C <clone> push origin HEAD:<branch>`.
  const head = /\bgit -C \S+ push /.test(message) ? VAULT_MIRROR_ERROR.push : VAULT_MIRROR_ERROR.commit;
  return withDetail(head, gitDetail(error, repoRoot));
}

function failureText(error: unknown, repoRoot: string): { text: string; serviceDown: boolean } {
  if (error instanceof MemoryUnavailableError) {
    return { text: `${VAULT_MIRROR_ERROR.serviceUnavailable} (${error.reason})`, serviceDown: true };
  }
  if (error instanceof MemoryRefusedError) {
    return { text: `${VAULT_MIRROR_ERROR.serviceRefused} (${error.code})`, serviceDown: false };
  }
  if (error instanceof MirrorFailure) return { text: error.message, serviceDown: false };
  // A git command outside the commit/push (status, checkout): execFile names it in `cmd`.
  if (typeof (error as { cmd?: unknown } | null)?.cmd === "string") {
    return { text: withDetail(VAULT_MIRROR_ERROR.other, gitDetail(error, repoRoot)), serviceDown: false };
  }
  const code = (error as { code?: unknown } | null)?.code;
  const detail = typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? `file system error (${code})` : "unexpected error";
  return { text: withDetail(VAULT_MIRROR_ERROR.other, detail), serviceDown: false };
}

// ---- the clone's vault files, never through a link -------------------------------

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Every file operation of the mirror in the clone. ONE gate, {@link locate},
 * stands before each of them: it walks from the clone root down to the path's
 * own folder and accepts plain folders only — a linked folder (or a file where
 * a folder should be) is never crossed. So nothing here can read, write or
 * delete outside the clone, whatever the repository has committed.
 */
class CloneVaultFiles {
  /** Folders (clone-relative) already seen to be plain during this use. */
  private readonly plain = new Set<string>();

  constructor(private readonly repoRoot: string) {}

  private abs(rel: string): string {
    return path.join(this.repoRoot, ...rel.split("/"));
  }

  /**
   * The absolute path of `rel`, once every folder above it is known to be a
   * plain folder of the clone. `create`: missing folders are made, and a link
   * or a file in the way is a failure (`path blocked`). Otherwise a missing or
   * blocked folder means the mirror has no file there: null, nothing touched.
   */
  private async locate(rel: string, create: boolean): Promise<string | null> {
    const segments = rel.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join("/");
      if (this.plain.has(folder)) continue;
      const abs = this.abs(folder);
      let stat = await lstatOrNull(abs);
      if (!stat && create) {
        try {
          await fs.mkdir(abs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        stat = await lstatOrNull(abs);
      }
      if (!stat?.isDirectory()) {
        if (!create) return null;
        throw new MirrorFailure(withDetail(VAULT_MIRROR_ERROR.path, `${folder} is a link or a file in the repository, not a plain folder`));
      }
      this.plain.add(folder);
    }
    return this.abs(rel);
  }

  /**
   * The vault files the clone holds now: plain files only, found without
   * following a link (a linked folder is not entered, a link at a note's path
   * is not a file). Names are returned exactly as they are on disk.
   */
  async list(): Promise<string[]> {
    const found: string[] = [];
    if ((await lstatOrNull(this.abs("CLAUDE.md")))?.isFile()) found.push("CLAUDE.md");
    const walk = async (rel: string, depth: number): Promise<void> => {
      const dirents = await fs.readdir(this.abs(rel), { withFileTypes: true });
      for (const dirent of dirents) {
        // A name starting with a dot can never be on a vault path (isPersonalVaultPath).
        if (dirent.name.startsWith(".")) continue;
        const child = `${rel}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (depth < MAX_WALK_DEPTH) await walk(child, depth + 1);
        } else if (dirent.isFile() && isPersonalVaultPath(child)) {
          found.push(child);
        }
      }
    };
    for (const folder of ["wiki", "raw"]) {
      if ((await lstatOrNull(this.abs(folder)))?.isDirectory()) await walk(folder, 1);
    }
    return found;
  }

  /** Whether the clone holds a plain file at `rel` (reached through plain folders only). */
  async holds(rel: string): Promise<boolean> {
    const abs = await this.locate(rel, false);
    return abs !== null && (await lstatOrNull(abs))?.isFile() === true;
  }

  /**
   * Delete the plain file at `rel` and the folders it leaves empty (below
   * `wiki/` / `raw/`; git tracks no folder). Returns whether a file was deleted.
   */
  async remove(rel: string): Promise<boolean> {
    const abs = await this.locate(rel, false);
    if (abs === null || !(await lstatOrNull(abs))?.isFile()) return false;
    await fs.unlink(abs);
    // Every folder climbed here was seen plain by `locate` just now.
    const segments = rel.split("/");
    for (let depth = segments.length - 1; depth > 1; depth -= 1) {
      const folder = segments.slice(0, depth).join("/");
      try {
        await fs.rmdir(this.abs(folder));
        this.plain.delete(folder);
      } catch {
        break; // not empty (or already gone): stop climbing
      }
    }
    return true;
  }

  /** Make the file at `rel` equal `content`. Returns whether anything was written. */
  async write(rel: string, content: string): Promise<boolean> {
    const abs = await this.locate(rel, true);
    if (abs === null) return false; // not reachable with `create` (it throws instead)
    const data = Buffer.from(content, "utf8");
    const stat = await lstatOrNull(abs);
    if (stat?.isFile()) {
      // The one read of a vault file in the clone: to skip writing what is already there.
      if (stat.size === data.length) {
        const handle = await fs.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          if ((await handle.readFile()).equals(data)) return false;
        } finally {
          await handle.close();
        }
      }
    } else if (stat?.isDirectory()) {
      try {
        await fs.rmdir(abs);
      } catch {
        throw new MirrorFailure(withDetail(VAULT_MIRROR_ERROR.path, `${rel} is a folder with other files in the repository`));
      }
    } else if (stat) {
      // A link (or another special entry) where the note goes: the entry itself is replaced, its target is never touched.
      await fs.unlink(abs);
    }
    const handle = await fs.open(
      abs,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return true;
  }
}

/** The service's vault notes (paths only): what the clone's copy must hold. */
async function listVault(client: MemoryClient, userId: string): Promise<string[]> {
  return (await client.list(userId))
    .map((entry) => entry.path)
    // The service stores canonical paths; anything else is not written anywhere.
    .filter((notePath) => isPersonalVaultPath(notePath) && normalizeVaultPath(notePath) === notePath);
}

interface ApplyPlan {
  /** The service's notes, as listed at the start of the pass. */
  wanted: string[];
  /** The owner's deletion ledger, read AFTER that listing (an entry is written before the service is asked to delete). */
  ledger: Set<string>;
  /** The owner's one-shot "make the repository equal to the service". */
  replaceAll: boolean;
}

interface Applied {
  /** Files written or deleted. */
  changed: number;
  /** Clone vault files the service does not hold and that were left alone. */
  repoOnly: number;
}

/**
 * Bring the clone's vault files up to the service: write every note whose
 * file differs, and delete a clone vault file the service no longer holds —
 * but only one the ledger names (Noah deleted it), or any such file under
 * `replaceAll`. The others are counted and left exactly as they are.
 */
async function applyVault(
  client: MemoryClient,
  store: Store,
  userId: string,
  repoRoot: string,
  plan: ApplyPlan,
): Promise<Applied> {
  const files = new CloneVaultFiles(repoRoot);
  const applied: Applied = { changed: 0, repoOnly: 0 };
  const wantedSet = new Set(plan.wanted);
  /** A clone vault file whose note the service does not hold. */
  const settleAbsent = async (rel: string, ledger: Set<string>): Promise<void> => {
    if (plan.replaceAll || ledger.has(rel)) {
      if (await files.remove(rel)) applied.changed += 1;
    } else if (await files.holds(rel)) {
      applied.repoOnly += 1;
    }
  };
  for (const rel of await files.list()) {
    if (!wantedSet.has(rel)) await settleAbsent(rel, plan.ledger);
  }
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const rel = plan.wanted[next];
      next += 1;
      if (rel === undefined) return;
      try {
        const note = await client.read(userId, rel);
        if (note) {
          if (await files.write(rel, note.content)) applied.changed += 1;
        } else {
          // Gone between the listing and this read. If Noah deleted it, its ledger entry was written before the
          // service was asked — so the ledger is read again, now.
          await settleAbsent(rel, new Set(store.listVaultDeletes(userId)));
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  // Every worker has stopped before this returns (or throws): nothing writes after the lock is released.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(READ_CONCURRENCY, plan.wanted.length) }, worker));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (rejected) throw rejected.reason;
  return applied;
}

const noticeOf = (applied: Applied): string | null =>
  applied.repoOnly > 0 ? `${VAULT_MIRROR_NOTICE.repoOnly}: ${applied.repoOnly}` : null;

/**
 * Finalize a `push: false` pass once the caller's own commit + push is over —
 * the ONE call that settles the row and the ledger for it. `{ ok: true }`: the
 * push went through (also when there was nothing to commit) — the row is
 * recorded synced with the pass's notice (clean unless a write arrived since),
 * the ledger entries the pass settled are cleared, and a carried-out
 * `mirrorReplaceAll` is cleared. `{ ok: false, error }`: what the commit or the
 * push threw — recorded as the failure; the row stays dirty and the ledger
 * untouched, so the next pass does it again. Pass the outcome of the LAST pass
 * the commit ran (the hook runs again after a rebase). An outcome that is not
 * `synced`, or one a `push: true` pass already finalized, is left alone.
 */
export function finishVaultMirror(
  store: Store,
  config: AppConfig,
  userId: string,
  outcome: VaultMirrorOutcome | null | undefined,
  result: { ok: true } | { ok: false; error: unknown },
): void {
  if (outcome?.kind !== "synced" || !outcome.pending) return;
  if (!result.ok) {
    store.recordVaultMirror(userId, { ok: false, error: vaultMirrorCommitError(result.error, knowledgeClonePath(userId, config)) });
    return;
  }
  settlePass(store, userId, outcome.pending);
}

/** Record a pushed pass: the row first, then the ledger entries it settled. */
function settlePass(store: Store, userId: string, pending: VaultMirrorPending): void {
  store.recordVaultMirror(userId, {
    ok: true,
    seq: pending.seq,
    notice: pending.notice,
    ...(pending.replacedAll ? { replacedAll: true } : {}),
  });
  store.clearVaultDeletes(userId, pending.settledDeletes);
}

// ---- one pass ---------------------------------------------------------------------

/**
 * Uncommitted changes outside vault paths. A tracked `.mcp.json` that is only
 * modified in the working tree does not count: that is the load-time strip of
 * app-managed servers, which every commit restores before staging.
 */
async function hasForeignChanges(repoRoot: string): Promise<boolean> {
  return (await statusEntries(repoRoot)).some(
    (entry) => !isPersonalVaultPath(entry.path) && !(entry.code === " M" && entry.path.endsWith(".mcp.json")),
  );
}

interface PassResult {
  outcome: VaultMirrorOutcome;
  /** The memory service could not be used — true for every owner, so a caller working through many may stop. */
  serviceDown: boolean;
}

const done = (outcome: VaultMirrorOutcome, serviceDown = false): PassResult => ({ outcome, serviceDown });

async function passHoldingLock(
  store: Store,
  config: AppConfig,
  ctx: KnowledgeRepoContext,
  repoRoot: string,
  options: { push: boolean; locked: boolean },
): Promise<PassResult> {
  const { userId } = ctx;
  // Again, now that the lock is held: a rollback or a hold may have come while this pass waited.
  const row = store.getPersonalVault(userId);
  if (!row) return done({ kind: "synced", changed: 0, seq: 0 });
  if (row.mirrorHold) return done({ kind: "skipped", reason: "hold" });
  // Before the service is read: a write marked after this point keeps the row dirty.
  const seq = row.mirrorSeq;
  const replaceAll = row.mirrorReplaceAll;
  try {
    const client = memoryClientFor(store, config);
    if (!client) {
      throw new MemoryUnavailableError("memory service unavailable: this server has none configured", "not_configured");
    }
    const owner = options.push ? store.getUserById(userId) : null;
    if (options.push) {
      if (!owner) throw new MirrorFailure(VAULT_MIRROR_ERROR.ownerMissing);
      if (!ctx.token && !ctx.externalToken) throw new MirrorFailure(VAULT_MIRROR_ERROR.noToken);
    }
    const cloned = await pathExists(path.join(repoRoot, ".git"));
    if (options.locked && !cloned) throw new MirrorFailure(VAULT_MIRROR_ERROR.notCloned);
    // A mirror commit must not sweep someone's unfinished work along: with changes outside vault paths the
    // clone is left exactly as it is. (A clone of ANOTHER repository is discarded by the sync below.)
    if (options.push && cloned) {
      const sameRepo = options.locked || (await originUrl(repoRoot)) === marketplaceCloneUrl(ctx.repo, config.githubHost);
      if (sameRepo && (await hasForeignChanges(repoRoot))) throw new RepoDirty();
    }
    // The service first: when it is down, no git command runs. The ledger AFTER the listing: a deletion's entry
    // is written before the service is asked, so every note the listing lacks because Noah deleted it is named.
    const wanted = await listVault(client, userId);
    const ledger = store.listVaultDeletes(userId);
    const plan: ApplyPlan = { wanted, ledger: new Set(ledger), replaceAll };
    if (!options.locked) {
      try {
        await ensureCloneLocked(ctx, repoRoot);
      } catch (error) {
        throw new MirrorFailure(withDetail(VAULT_MIRROR_ERROR.cloneSync, gitDetail(error, repoRoot)));
      }
    }
    let applied = await applyVault(client, store, userId, repoRoot, plan);
    let changed = applied.changed;
    const wantedSet = new Set(wanted);
    const pending = (): VaultMirrorPending => ({
      seq,
      notice: noticeOf(applied),
      // Settled = the entries whose note the listing did not hold. One it still held stays in the ledger.
      settledDeletes: ledger.filter((deleted) => !wantedSet.has(deleted)),
      replacedAll: replaceAll,
    });
    if (!options.push || !owner) {
      return done({ kind: "synced", changed, seq, notice: noticeOf(applied), pending: pending() });
    }
    try {
      await commitAndPushLocked(ctx, VAULT_MIRROR_COMMIT_MESSAGE, commitIdentityFor(store, owner), {
        checkStaged: (staged) => {
          // Something outside the vault was written between the check above and `git add -A`.
          if (!staged.every((stagedPath) => isPersonalVaultPath(stagedPath))) throw new RepoDirty();
        },
        // A direct git edit of a vault note never blocks the copy: the service's side wins the conflict…
        vaultPaths: isPersonalVaultPath,
        // …and what the remote's commits brought into the tree is brought back to the service's content.
        afterRebase: async () => {
          applied = await applyVault(client, store, userId, repoRoot, plan);
          changed += applied.changed;
        },
      });
    } catch (error) {
      if (error instanceof RepoDirty || error instanceof MemoryUnavailableError || error instanceof MemoryRefusedError || error instanceof MirrorFailure) {
        throw error;
      }
      throw new MirrorFailure(vaultMirrorCommitError(error, repoRoot));
    }
    const settled = pending();
    settlePass(store, userId, settled);
    if (changed > 0) log.info({ userId, changed }, "vault mirror pushed");
    return done({ kind: "synced", changed, seq, notice: settled.notice });
  } catch (error) {
    if (error instanceof RepoDirty) {
      store.recordVaultMirror(userId, { ok: false, error: VAULT_MIRROR_ERROR.repoDirty });
      return done({ kind: "skipped", reason: "repo_dirty" });
    }
    const { text, serviceDown } = failureText(error, repoRoot);
    store.recordVaultMirror(userId, { ok: false, error: text });
    // Once per cause, not once per retry.
    if (row.mirrorError !== text) {
      log.warn({ userId, error: text, ...(text.startsWith(VAULT_MIRROR_ERROR.other) ? { err: error } : {}) }, "vault mirror failed");
    }
    return done({ kind: "failed", error: text }, serviceDown);
  }
}

async function runPass(
  store: Store,
  config: AppConfig,
  userId: string,
  options: { push: boolean; locked?: boolean },
): Promise<PassResult> {
  try {
    const row = store.getPersonalVault(userId);
    // Home `repo`: the clone IS the vault — there is nothing to mirror.
    if (!row) return done({ kind: "synced", changed: 0, seq: 0 });
    if (row.mirrorHold) return done({ kind: "skipped", reason: "hold" });
    const ctx = knowledgeRepoContextFor(store, userId, config);
    if (!ctx) return done({ kind: "skipped", reason: "no_repo" });
    const repoRoot = knowledgeClonePath(userId, config);
    const locked = options.locked === true;
    const pass = () => passHoldingLock(store, config, ctx, repoRoot, { push: options.push, locked });
    return await (locked ? pass() : withRepoLock(repoRoot, pass));
  } catch (error) {
    // Nothing above is expected to throw (a closed store, at most): still an outcome, never a rejection.
    log.error({ userId, err: error }, "vault mirror pass failed unexpectedly");
    return done({ kind: "failed", error: withDetail(VAULT_MIRROR_ERROR.other, "unexpected error") });
  }
}

/**
 * Write the service's vault into the owner's clone (add / replace / delete
 * vault files so they equal the service). Never rejects: every ordinary
 * failure is an outcome.
 *
 * - `push: true` (the background loop, cutover, rollback): also commits those
 *   files as the owner and pushes with the owner's stored token, then records
 *   the result on the row (`synced` ⇒ the remote has it; the row is clean unless
 *   a write arrived meanwhile). When the clone has uncommitted changes OUTSIDE
 *   vault paths it touches nothing and answers `skipped: repo_dirty`
 *   (`mirrorError = "repo has uncommitted changes"`) — for EVERY caller, the
 *   loop and a rollback alike: a mirror commit never carries someone's
 *   unfinished work, and a rollback gets that definite reason (the owner's
 *   avatar commits, which carries the mirror; then the rollback is retried).
 * - `push: false` (the `commit` tool): only writes the working tree; the caller
 *   commits and pushes right after in the same repo lock. It records NO success
 *   on the row — the caller does, with the returned `seq`, once its push worked
 *   (`store.recordVaultMirror(userId, { ok: true, seq })`), or a failure
 *   (`vaultMirrorCommitError`). A failed pass records its own error.
 * - `locked: true`: the caller already holds `withRepoLock(knowledgeClonePath(…))`.
 *   No lock is taken and the clone is used as it is (no clone / fetch / align; a
 *   missing clone is `failed: not cloned`). Otherwise the pass takes the lock
 *   and syncs the clone the way `ensureClone` does.
 *
 * `skipped: hold` (the owner must confirm first) and `skipped: no_repo` leave
 * the row untouched. An owner whose home is `repo` (no row) is `synced` with
 * nothing done.
 */
export async function syncVaultMirror(
  store: Store,
  config: AppConfig,
  userId: string,
  options: { push: boolean; locked?: boolean },
): Promise<VaultMirrorOutcome> {
  return (await runPass(store, config, userId, options)).outcome;
}

// ---- the background loop -----------------------------------------------------------

/**
 * Start the background mirror: at start EVERY vault is marked for a pass (a
 * crash between a service write and its dirty mark loses the mark, so after a
 * restart no row is trusted to be clean), then a pass runs right away and again
 * `intervalMs` after each one ends — so passes never overlap. A pass mirrors
 * the dirty owners one at a time (`push: true`) and stops early when the memory
 * service is down (it is down for everyone). Nothing it does can reject or keep
 * the process alive. `stop()` ends it after the owner in progress.
 */
export function startVaultMirrorLoop(
  store: Store,
  config: AppConfig,
  options: { intervalMs?: number } = {},
): { stop(): void } {
  const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const pass = async (): Promise<void> => {
    for (const row of store.listPersonalVaults()) {
      if (stopped) return;
      if (!row.mirrorDirty) continue;
      const { serviceDown } = await runPass(store, config, row.userId, { push: true });
      if (serviceDown) return;
    }
  };

  const run = async (): Promise<void> => {
    try {
      await pass();
    } catch (error) {
      log.error({ err: error }, "vault mirror loop pass failed");
    }
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
    // Never the reason the process stays up.
    timer.unref?.();
  };

  try {
    for (const row of store.listPersonalVaults()) store.markVaultMirrorDirty(row.userId);
  } catch (error) {
    log.error({ err: error }, "vault mirror loop could not mark the vaults at start");
  }
  void run();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
