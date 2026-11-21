/**
 * The one-time import of a repository's own vault notes.
 *
 * The personal vault lives in the memory service (`personalVault.ts`), and no
 * tool reads a clone file at a vault path. So a repository that is connected
 * with notes of its own (`CLAUDE.md`, `.md` under `wiki/` and `raw/`) would
 * leave those notes where the brain never sees them. This is the ONE path that
 * brings them in:
 *
 * - WHEN: a knowledge repository or its branch is connected or changed
 *   ({@link onKnowledgeRepoChanged}), and — once, at the first boot of a build
 *   without the `repo` home — for every owner who had a repository but was
 *   never moved ({@link resumeVaultImports}).
 * - A NEWLY CONNECTED REPOSITORY ONLY INTO AN EMPTY VAULT: its look (`check`)
 *   imports nothing when the owner's wiki already holds a vault note. A
 *   repository that still carries the copies the retired mirror wrote must
 *   never bring back a note its owner deleted since. A never-moved owner starts
 *   at `import` instead: their repository IS their vault.
 * - NEVER OVERWRITES: an import creates the notes the service does not hold;
 *   a note that exists is left as it is (one that differs from the
 *   repository's file is named in the log).
 * - ABOUT ONE REPOSITORY: an attempt that finds the connected repository or
 *   branch changed while it ran stops and leaves the pending state to the
 *   attempt the change queued.
 * - RESUMABLE: what is pending is kept in the store (`check` → `import`), an
 *   attempt that could not finish is tried again a few times with growing
 *   pauses, and whatever is still pending is picked up at the next boot. A
 *   repository file is never changed or deleted; whatever could not be
 *   imported stays in the repository and is named in the log.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withRepoLock } from "./gitMutex.js";
import { ensureCloneLocked, knowledgeClonePath, knowledgeRepoContextFor } from "./knowledgeRepo.js";
import { currentBranch } from "./repoGitCore.js";
import logger from "./logger.js";
import { scrubGitError } from "./marketplace.js";
import { MEMORY_REFUSAL, MemoryRefusedError, MemoryUnavailableError, memoryClientFor } from "./memory/memoryClient.js";
import { VAULT_NOTE_MAX_BYTES, isPersonalVaultPath, normalizeVaultPath, withVaultWriteLock } from "./personalVault.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";

const importLogger = logger.child({ module: "vault-import" });

export type VaultImportOutcome =
  /** Nothing to do. Nothing is pending any more — except after `repo_changed`, where the pending state is the new repository's. */
  | { kind: "nothing"; reason: "not_pending" | "no_user" | "no_repo" | "vault_not_empty" | "no_notes" | "repo_changed" }
  /**
   * Done. `skipped` = repository files at vault paths that are not in the vault: the service could not take
   * them, or (`differs`) the vault already holds a different note at that path. They stay in the repository.
   */
  | { kind: "imported"; created: number; skipped: { path: string; reason: string }[] }
  /** Could not be finished now; it stays pending for the next boot. */
  | { kind: "retry"; reason: "not_configured" | "sync_failed" | "memory_unavailable" };

interface RepoNote {
  /** The normalized vault path the service stores it under. */
  path: string;
  text: string;
}

/** Text only: valid UTF-8 without NUL (a BOM is kept). */
function decodeNote(data: Buffer): string | "not_utf8" | "nul" {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return "not_utf8";
  }
  return data.includes(0) ? "nul" : text;
}

/**
 * The vault notes the clone's working tree holds: `CLAUDE.md` at the root and
 * the `.md` files under `wiki/` and `raw/` that `isPersonalVaultPath` accepts.
 * Never follows a link — not at a folder, not at a file.
 */
async function scanRepoNotes(repoRoot: string): Promise<{ notes: RepoNote[]; skipped: { path: string; reason: string }[] }> {
  const notes = new Map<string, RepoNote>();
  const skipped: { path: string; reason: string }[] = [];

  async function visitFile(rel: string): Promise<void> {
    if (!isPersonalVaultPath(rel)) return; // a repo path: it is served from the clone as before
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path.join(repoRoot, ...rel.split("/")), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch {
      skipped.push({ path: rel, reason: "not_a_file" });
      return;
    }
    let data: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        skipped.push({ path: rel, reason: "not_a_file" });
        return;
      }
      if (stat.size > VAULT_NOTE_MAX_BYTES) {
        skipped.push({ path: rel, reason: "too_large" });
        return;
      }
      data = await handle.readFile();
    } finally {
      await handle.close();
    }
    const text = decodeNote(data);
    if (text === "not_utf8" || text === "nul") {
      skipped.push({ path: rel, reason: text });
      return;
    }
    const notePath = normalizeVaultPath(rel);
    if (notes.has(notePath)) skipped.push({ path: rel, reason: "duplicate_path" });
    else notes.set(notePath, { path: notePath, text });
  }

  async function walk(rel: string): Promise<void> {
    const dirents = await fs.readdir(path.join(repoRoot, ...rel.split("/")), { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const child = `${rel}/${dirent.name}`;
      if (dirent.isDirectory()) await walk(child);
      else if (dirent.isFile()) await visitFile(child);
    }
  }

  for (const top of ["CLAUDE.md", "raw", "wiki"]) {
    const stat = await fs.lstat(path.join(repoRoot, top)).catch(() => null);
    if (!stat) continue;
    if (top === "CLAUDE.md") {
      if (stat.isFile()) await visitFile(top);
    } else if (stat.isDirectory()) {
      await walk(top);
    }
  }
  return { notes: [...notes.values()], skipped };
}

/**
 * One attempt at the owner's pending import (see the file comment). Holds the
 * owner's vault write queue for its whole length, then the clone's repo lock
 * while the repository is read. Never throws.
 */
export function runVaultImport(store: Store, config: AppConfig, userId: string): Promise<VaultImportOutcome> {
  return withVaultWriteLock(store, userId, async (): Promise<VaultImportOutcome> => {
    const stage = store.listVaultImports()[userId];
    if (!stage) return { kind: "nothing", reason: "not_pending" };
    const over = (reason: "no_user" | "no_repo" | "vault_not_empty" | "no_notes"): VaultImportOutcome => {
      store.clearVaultImport(userId);
      return { kind: "nothing", reason };
    };
    if (!store.getUserById(userId)) return over("no_user");
    const ctx = knowledgeRepoContextFor(store, userId, config);
    if (!ctx) return over("no_repo");
    const client = memoryClientFor(store, config);
    if (!client) return { kind: "retry", reason: "not_configured" };
    // The repository this attempt is about. A change while it runs queues its own attempt (`onKnowledgeRepoChanged`
    // resets the stage), so from then on the pending state is not this attempt's to advance or clear.
    const changed = (): boolean => {
      const now = store.getKnowledgeRepo(userId);
      return now.repo !== ctx.repo || now.branch !== ctx.branch;
    };
    const repoChanged: VaultImportOutcome = { kind: "nothing", reason: "repo_changed" };

    try {
      const held = new Set((await client.list(userId)).map((entry) => entry.path).filter(isPersonalVaultPath));
      if (changed()) return repoChanged;
      if (stage === "check" && held.size > 0) {
        importLogger.info(
          { userId, repo: ctx.repo, held: held.size },
          "vault import: the owner's vault already holds notes, so nothing is imported; the repository's own notes stay in the repository",
        );
        return over("vault_not_empty");
      }

      const repoRoot = knowledgeClonePath(userId, config);
      let scan: Awaited<ReturnType<typeof scanRepoNotes>>;
      try {
        scan = await withRepoLock(repoRoot, async () => {
          await ensureCloneLocked(ctx, repoRoot);
          // A clone that could not switch (uncommitted repository files in the way) is still on the branch
          // connected BEFORE: its notes are not the ones this import is about.
          const branch = await currentBranch(repoRoot);
          if (ctx.branch && branch !== ctx.branch) throw new Error(`the clone is on ${branch ?? "no branch"}, not on the connected branch`);
          return scanRepoNotes(repoRoot);
        });
      } catch (error) {
        importLogger.warn({ userId, repo: ctx.repo, error: scrubGitError(error) }, "vault import: the repository could not be read; it stays pending");
        return { kind: "retry", reason: "sync_failed" };
      }
      if (changed()) return repoChanged;
      if (scan.notes.length === 0) return over("no_notes");
      if (stage === "check") store.setVaultImport(userId, "import");

      const skipped = [...scan.skipped];
      let created = 0;
      for (const note of scan.notes) {
        if (changed()) return repoChanged;
        if (held.has(note.path)) {
          // Never overwritten — but a note that differs from the repository's file is worth a line in the log.
          const current = await client.read(userId, note.path);
          if (current && current.content !== note.text) skipped.push({ path: note.path, reason: "differs" });
          continue;
        }
        try {
          await client.put(userId, note.path, note.text);
          created += 1;
        } catch (error) {
          if (!(error instanceof MemoryRefusedError)) throw error;
          // `exists`: written meanwhile — left as it is. Any other refusal: the service cannot take this note.
          if (error.code !== MEMORY_REFUSAL.exists) skipped.push({ path: note.path, reason: error.code });
        }
      }
      if (changed()) return repoChanged;
      store.clearVaultImport(userId);
      importLogger[skipped.length > 0 ? "warn" : "info"](
        { userId, repo: ctx.repo, created, skipped },
        "vault import: the repository's own notes were imported into the owner's vault (repository files are unchanged; skipped ones stay there)",
      );
      return { kind: "imported", created, skipped };
    } catch (error) {
      if (error instanceof MemoryUnavailableError) {
        importLogger.warn({ userId, repo: ctx.repo, reason: error.reason }, "vault import: the memory service could not be used; it stays pending");
        return { kind: "retry", reason: "memory_unavailable" };
      }
      importLogger.error({ userId, repo: ctx.repo, err: error }, "vault import failed; it stays pending");
      return { kind: "retry", reason: "memory_unavailable" };
    }
  });
}

// ---- When it runs --------------------------------------------------------------

/**
 * An attempt that could not finish (the service or the repository could not be
 * reached) is tried again after a pause that doubles, a bounded number of
 * times; after that it waits for the next boot. `not_configured` is not
 * retried: a server without a memory service will not grow one while it runs.
 */
const retry = { delayMs: 60_000, maxDelayMs: 30 * 60_000, attempts: 6 };

/** Tests: shorten the pauses, or turn the retries off (`attempts: 0`). No argument = the defaults. */
export function setVaultImportRetryForTests(options: { delayMs?: number; attempts?: number } = {}): void {
  retry.delayMs = options.delayMs ?? 60_000;
  retry.attempts = options.attempts ?? 6;
}

interface ImportQueue {
  tail: Promise<unknown>;
  /** How many retry rounds ran since the last attempt that did not ask for one. */
  round: number;
  timer: NodeJS.Timeout | null;
}

const queues = new WeakMap<Store, ImportQueue>();

function queueOf(store: Store): ImportQueue {
  let queue = queues.get(store);
  if (!queue) {
    queue = { tail: Promise.resolve(), round: 0, timer: null };
    queues.set(store, queue);
  }
  return queue;
}

/** One more round later, for whatever is still pending then. The timer never keeps the process alive. */
function retryLater(store: Store, config: AppConfig): void {
  const queue = queueOf(store);
  if (queue.timer || queue.round >= retry.attempts) return;
  const delay = Math.min(retry.delayMs * 2 ** queue.round, retry.maxDelayMs);
  queue.round += 1;
  queue.timer = setTimeout(() => {
    queue.timer = null;
    try {
      for (const userId of Object.keys(store.listVaultImports()).sort()) enqueue(store, config, userId);
    } catch {
      // The store was closed: nothing is pending any more for this process.
    }
  }, delay);
  queue.timer.unref();
}

/** One import at a time per app instance, in the background. */
function enqueue(store: Store, config: AppConfig, userId: string): void {
  const queue = queueOf(store);
  queue.tail = queue.tail
    .then(() => runVaultImport(store, config, userId))
    .then((outcome) => {
      if (outcome.kind === "retry" && outcome.reason !== "not_configured") retryLater(store, config);
      else if (outcome.kind !== "retry") queue.round = 0;
    })
    .catch(() => undefined);
}

/** Resolves when every import queued so far has finished (tests). */
export async function whenVaultImportsIdle(store: Store): Promise<void> {
  await queueOf(store).tail;
}

/**
 * A knowledge repository (or its branch) was connected or changed for this
 * user: its own notes are imported when the owner's vault is empty. Fire and
 * forget; a repository that was DISCONNECTED ends whatever was pending.
 */
export function onKnowledgeRepoChanged(store: Store, config: AppConfig, userId: string): void {
  try {
    if (!store.getKnowledgeRepo(userId).repo) {
      store.clearVaultImport(userId);
      return;
    }
    // A new repository is judged afresh: an import that had begun for the previous one is not continued, and
    // one that is running right now stops by itself (it sees the change).
    store.setVaultImport(userId, "check");
    enqueue(store, config, userId);
  } catch (error) {
    importLogger.error({ userId, err: error }, "onKnowledgeRepoChanged failed");
  }
}

/**
 * Boot: continue what an earlier process left pending, and — once, at the
 * first boot of a build without the `repo` home — import the repository notes
 * of every owner who had a repository connected but was never moved into the
 * memory service. Returns how many imports were queued.
 */
export function resumeVaultImports(store: Store, config: AppConfig): number {
  try {
    const unmoved = store.takeVaultImportStragglers();
    if (unmoved.length > 0) {
      importLogger.warn(
        { users: unmoved },
        "vault import: these owners had a repository connected but their notes were never moved into the memory service; each repository's notes are imported now",
      );
    }
    const pending = Object.keys(store.listVaultImports()).sort();
    for (const userId of pending) enqueue(store, config, userId);
    return pending.length;
  } catch (error) {
    importLogger.error({ err: error }, "resumeVaultImports failed");
    return 0;
  }
}
