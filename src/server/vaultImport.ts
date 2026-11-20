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
 *   ({@link onKnowledgeRepoChanged}), and — once, at the boot that retired the
 *   vault tables — for every owner who had a repository but was never moved
 *   ({@link resumeVaultImports}).
 * - ONLY INTO AN EMPTY VAULT: the look (`check`) imports nothing when the
 *   owner's wiki already holds a vault note. A repository that still carries
 *   the copies the retired mirror wrote must never bring back a note its owner
 *   deleted since.
 * - NEVER OVERWRITES: an import creates the notes the service does not hold;
 *   a note that exists is left as it is.
 * - RESUMABLE: what is pending is kept in the store (`check` → `import`), so an
 *   outage or a restart half-way is picked up at the next boot. A repository
 *   file is never changed or deleted; whatever could not be imported stays in
 *   the repository and is named in the log.
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
  /** Nothing to do, and nothing is pending any more. */
  | { kind: "nothing"; reason: "not_pending" | "no_user" | "no_repo" | "vault_not_empty" | "no_notes" }
  /** Done. `skipped` = repository files at vault paths the service could not take; they stay in the repository. */
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

    try {
      const held = new Set((await client.list(userId)).map((entry) => entry.path).filter(isPersonalVaultPath));
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
      if (scan.notes.length === 0) return over("no_notes");
      if (stage === "check") store.setVaultImport(userId, "import");

      const skipped = [...scan.skipped];
      let created = 0;
      for (const note of scan.notes) {
        if (held.has(note.path)) continue;
        try {
          await client.put(userId, note.path, note.text);
          created += 1;
        } catch (error) {
          if (!(error instanceof MemoryRefusedError)) throw error;
          // `exists`: written meanwhile — left as it is. Any other refusal: the service cannot take this note.
          if (error.code !== MEMORY_REFUSAL.exists) skipped.push({ path: note.path, reason: error.code });
        }
      }
      store.clearVaultImport(userId);
      importLogger.info(
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

const tails = new WeakMap<Store, Promise<unknown>>();

/** One import at a time per app instance, in the background. */
function enqueue(store: Store, config: AppConfig, userId: string): void {
  const run = (tails.get(store) ?? Promise.resolve()).then(() => runVaultImport(store, config, userId)).catch(() => undefined);
  tails.set(store, run);
}

/** Resolves when every import queued so far has finished (tests). */
export async function whenVaultImportsIdle(store: Store): Promise<void> {
  await (tails.get(store) ?? Promise.resolve());
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
    // A new repository is judged afresh: an import that had begun for the previous one is not continued.
    store.setVaultImport(userId, "check");
    enqueue(store, config, userId);
  } catch (error) {
    importLogger.error({ userId, err: error }, "onKnowledgeRepoChanged failed");
  }
}

/**
 * Boot: continue what an earlier process left pending, and — once, at the
 * boot that retired the vault tables — look at every owner who had a
 * repository connected but was never moved into the memory service. Returns
 * how many imports were queued.
 */
export function resumeVaultImports(store: Store, config: AppConfig): number {
  try {
    const unmoved = store.takeVaultImportStragglers();
    if (unmoved.length > 0) {
      importLogger.warn(
        { users: unmoved },
        "vault import: these owners had a repository connected but their notes were never moved into the memory service; each repository is looked at now",
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
