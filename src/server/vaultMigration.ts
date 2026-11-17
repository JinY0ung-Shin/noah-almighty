/**
 * Moving an owner's personal vault between its two homes (`personalVault.ts`):
 * the dry run, the cutover `repo` → `memory`, the rollback `memory` → `repo`,
 * the pass over every owner, and what happens when an owner connects or
 * changes their knowledge repository.
 *
 * What holds everywhere in this file:
 * - A source file is never deleted or rewritten. The clone is only synced
 *   (what `ensureClone` does for every run) and read — without following a link.
 * - The home flips only after the service holds EXACTLY the clone's vault:
 *   every note was read back and its hash compared, and the service holds no
 *   other vault note of that owner.
 * - `retirementGate()` comes before any change. It backs the database up only
 *   while the database still holds retired data; what it guarantees here is
 *   that a boot in which that backup FAILED holds every cutover and rollback.
 * - Locks are taken in ONE order: the owner's vault write lock
 *   (`withVaultWriteLock`), then the clone's repo lock (`withRepoLock`).
 *   Inside the vault write lock the service is used through the
 *   `MemoryClient` directly — never `MemoryVault` writes, which would wait for
 *   this file's own turn. Every vault-changing tool call takes the same vault
 *   write lock and decides the home inside it (`withVaultWrite`), so a write
 *   can never straddle a flip — that, not run tracking, is what makes a flip
 *   safe.
 * - What a job decided before it waited for a lock is asked again once the
 *   lock is held, and what a flip depends on (the user exists; the same
 *   repository and branch are connected) once more in the same tick as the
 *   flip. A vault read from one repository is never mirrored into another.
 * - One background job at a time per app instance (`running` in the admin
 *   view). Jobs are started by the admin routes and by a repository change,
 *   never at boot.
 *
 * Blockers and skip reasons are short English text that starts with a stable
 * code (`VAULT_BLOCKER`, `VAULT_SKIP`): the admin screen turns them into
 * Korean sentences and shows text it does not know as it came.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getActiveRunForConversation } from "./agent/runRegistry.js";
import { tokenForGitUrl } from "./gitCredentials.js";
import { withRepoLock } from "./gitMutex.js";
import { ensureCloneLocked, knowledgeClonePath, knowledgeRepoContextFor, type KnowledgeRepoContext } from "./knowledgeRepo.js";
import logger from "./logger.js";
import { marketplaceCloneUrl, sanitizeName, scrubGitError } from "./marketplace.js";
import {
  MEMORY_REFUSAL,
  MemoryRefusedError,
  MemoryUnavailableError,
  memoryClientFor,
  type MemoryClient,
} from "./memory/memoryClient.js";
import { VAULT_NOTE_MAX_BYTES, isPersonalVaultPath, normalizeVaultPath, withVaultWriteLock } from "./personalVault.js";
import { aheadOfRemote, behindRemote, currentBranch, dirtyPaths, git, originUrl } from "./repoGitCore.js";
import { QUARANTINE_DIR, isPlainSegment, openRetirementSweep, quarantineRetired } from "./retiredFiles.js";
import { runningRoutineCountForOwner } from "./routineRunRegistry.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import { syncVaultMirror } from "./vaultMirror.js";

const migrationLogger = logger.child({ module: "vaultMigration" });

export interface VaultMigrationReport {
  userId: string;
  /** The owner's connected knowledge repository now. */
  repo: string | null;
  /** HEAD of the clone the notes were read from (`memory`: at cutover). */
  sourceCommit: string | null;
  /** Vault notes: in the clone (`repo`), in the service (`memory`). */
  notes: number;
  bytes: number;
  /** Files under `wiki/` / `raw/` (and a linked `CLAUDE.md`) that are not vault notes: they stay in the repository. */
  skipped: { path: string; reason: string }[];
  /** Non-empty → this owner is not cut over. */
  blockers: string[];
  state: "repo" | "memory" | "no_repo";
}

/** The code every blocker starts with (`<code>: <detail>`). */
export const VAULT_BLOCKER = {
  noUser: "no_user",
  notConfigured: "memory_not_configured",
  unavailable: "memory_unavailable",
  refused: "refused",
  backupFailed: "backup_failed",
  runInProgress: "run_in_progress",
  noToken: "no_git_token",
  /** The owner connected another repository or branch while this one was being looked at. */
  repoChanged: "repo_changed",
  syncFailed: "sync_failed",
  uncommitted: "uncommitted_changes",
  unpushed: "unpushed_commits",
  tooLarge: "note_too_large",
  notUtf8: "not_utf8",
  invalidContent: "invalid_content",
  /** Two files of the CLONE are one note path once normalized, with different content. */
  conflict: "note_conflict",
  /** The SERVICE already holds a different note at a path of the clone. */
  serviceConflict: "service_note_conflict",
  /** The SERVICE already holds a vault note the clone does not have. */
  serviceOnly: "service_only_note",
  folderLink: "vault_folder_link",
  wikiFull: "wiki_full",
  sourceChanged: "source_changed",
  verifyFailed: "verify_failed",
  internal: "internal_error",
} as const;

/** The code every skip reason starts with. */
export const VAULT_SKIP = {
  notMarkdown: "not_markdown",
  dotName: "dot_name",
  tooDeep: "too_deep",
  tooLong: "path_too_long",
  invalidPath: "invalid_path",
  unsupported: "unsupported path",
  symlink: "symlink",
  notAFile: "not_a_file",
  duplicate: "duplicate",
} as const;

/** Why a rollback did not happen (`rollbackVault`'s `reason`; `mirror_failed` is followed by `: <the mirror's error>`). */
export const VAULT_ROLLBACK_REFUSAL = {
  notConfigured: "memory_not_configured",
  unavailable: "memory_unavailable",
  backupFailed: "backup_failed",
  mirrorHold: "mirror_hold",
  mirrorNoRepo: "mirror_no_repo",
  mirrorRepoDirty: "mirror_repo_dirty",
  mirrorFailed: "mirror_failed",
  mirrorBehind: "mirror_behind",
  /** The owner's home is not the one the caller said it was acting on (a stale screen). */
  homeMismatch: "home_mismatch",
  /** A leftover copy (home `repo`) holds notes the repository does not, and they could not be read or put aside: nothing was deleted. */
  leftoverNotSaved: "leftover_not_saved",
  internal: "internal_error",
} as const;

/** `rollbackVault`'s answer. `leftover` is set when the owner's home already was `repo` and a leftover copy was discarded. */
export type VaultRollbackResult =
  | {
      ok: true;
      /** The leftover copy: how many notes it held, and how many of them the clone did not hold as they were (quarantined first). */
      leftover?: { notes: number; quarantined: number };
      /** A real rollback: how many wiki notes OUTSIDE the vault paths (never mirrored) were quarantined before the wiki was deleted, when any. */
      quarantined?: number;
    }
  | { ok: false; reason: string };

/**
 * Where the notes of a discarded leftover copy are written before they are
 * quarantined: `<dataDir>/personal-vault-leftover/<user>/<time>/<note path>`,
 * moved at once to `<dataDir>/retired/<boot stamp>/` + the same path.
 */
export const VAULT_LEFTOVER_DIR = "personal-vault-leftover";

// The service's own limits (its contract): a wiki holds at most this much.
const SERVICE_MAX_NOTES = 10_000;
const SERVICE_MAX_WIKI_BYTES = 256 * 1024 * 1024;
/** At most this many blockers of one kind are spelled out; the rest are counted. */
const MAX_BLOCKERS_PER_KIND = 20;
/** At most this many non-markdown files are listed one by one. */
const MAX_LISTED_NON_MARKDOWN = 200;
/** How many uncommitted paths a blocker names. */
const MAX_NAMED_DIRTY_PATHS = 5;

const blocker = (code: string, detail: string) => `${code}: ${detail}`;

/**
 * What a held retirement gate means, said as it is: no backup is promised (the
 * gate takes one only while the database holds retired data) — a boot in which
 * that backup failed holds every data-changing maintenance step until a restart.
 */
const BACKUP_HELD_DETAIL =
  "this server has been holding data-changing maintenance steps since its last start because a database backup failed (the server log has the reason); nobody is moved until that is fixed and the server is restarted";

/**
 * The blocker codes that mean "the memory service already holds something for
 * this owner": the admin screen keys the offer to discard that leftover copy
 * (`rollbackVault` on an owner whose home is `repo`) on these codes only.
 */
export const VAULT_LEFTOVER_BLOCKERS: readonly string[] = ["service_note_conflict", "service_only_note"];

// ---- A run of the owner in progress ---------------------------------------------

/**
 * Whether a run that can write this owner's vault is in progress: a routine of
 * theirs, a chat / task-API turn on their own avatar, or — when the account is
 * SHARED, where trusted teammates write the owner's repository too — any
 * teammate's chat with the avatar. (On an account that is not shared a
 * teammate's chat and a consultation only read the brain; they are not
 * counted.)
 *
 * A COURTESY, not what keeps a flip safe: every vault-changing tool call runs
 * inside the owner's vault write queue and decides the home there
 * (`withVaultWrite`), and the cutover holds that queue — so no write can
 * straddle a flip, whatever run it comes from. This only avoids moving a vault
 * under a run whose frozen prompt describes the other home.
 */
export function ownerRunInProgress(store: Store, userId: string): boolean {
  if (runningRoutineCountForOwner(userId) > 0) return true;
  const ownRun = store
    .listConversations(userId, userId, "all")
    .some((conversation) => getActiveRunForConversation(userId, conversation.id) !== null);
  if (ownRun || !store.isSharedAccount(userId)) return ownRun;
  return store.listConversationIdsForAvatar(userId).some((conversationId) => {
    const viewer = store.conversationOwner(conversationId);
    return viewer !== null && getActiveRunForConversation(viewer, conversationId) !== null;
  });
}

// ---- The clone's vault ----------------------------------------------------------

interface SourceNote {
  /** The vault path the service stores (NFC). */
  path: string;
  /** The file in the clone, repo-relative, as it is spelled on disk. */
  file: string;
  bytes: number;
  /** sha256 hex of the file's bytes. */
  hash: string;
}

interface VaultScan {
  notes: SourceNote[];
  bytes: number;
  skipped: { path: string; reason: string }[];
  blockers: string[];
}

/** Collects problems of one kind, spelling out the first few. */
class CappedList {
  private readonly counts = new Map<string, number>();
  readonly items: string[] = [];

  push(code: string, detail: string): void {
    const seen = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, seen);
    if (seen <= MAX_BLOCKERS_PER_KIND) this.items.push(blocker(code, detail));
  }

  /** The collected blockers, with one closing line per kind that had more. */
  done(): string[] {
    const out = [...this.items];
    for (const [code, seen] of this.counts) {
      if (seen > MAX_BLOCKERS_PER_KIND) out.push(blocker(code, `and ${seen - MAX_BLOCKERS_PER_KIND} more of this kind`));
    }
    return out;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The bytes of one clone file, opened WITHOUT following a link at the leaf
 * (the walk never descends through a linked folder either). Null when it is
 * not a regular file any more.
 */
async function readCloneFile(repoRoot: string, rel: string, maxBytes: number): Promise<{ bytes: number; data: Buffer | null } | null> {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path.join(repoRoot, ...rel.split("/")), fsConstants.O_RDONLY | noFollow);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return { bytes: stat.size, data: null };
    const data = await handle.readFile();
    return { bytes: data.byteLength, data };
  } finally {
    await handle.close();
  }
}

/** Text only: valid UTF-8 (a BOM is kept — the bytes must come back the same) without NUL. */
function decodeNote(data: Buffer): { text: string } | { problem: "not_utf8" | "nul" } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return { problem: "not_utf8" };
  }
  return data.includes(0) ? { problem: "nul" } : { text };
}

/**
 * Why `isPersonalVaultPath` said no — for the report's wording ONLY (the
 * decision is always `isPersonalVaultPath`'s; a reason this cannot name is
 * reported as an unsupported path).
 */
function skipReason(rel: string): string {
  const norm = normalizeVaultPath(rel);
  if (!norm.endsWith(".md")) return `${VAULT_SKIP.notMarkdown}: not a markdown note; it stays in the repository`;
  if (/[\u0000-\u001f\u007f\\]/.test(norm)) return `${VAULT_SKIP.invalidPath}: the path has a backslash or a control character; it stays in the repository`;
  const parts = norm.split("/");
  if (parts.some((part) => part.startsWith("."))) return `${VAULT_SKIP.dotName}: a folder or file name starts with a dot; it stays in the repository`;
  if (parts.length > 16) return `${VAULT_SKIP.tooDeep}: the path is too deep (more than 16 parts); it stays in the repository`;
  if (Buffer.byteLength(norm, "utf8") > 512 || parts.some((part) => Buffer.byteLength(part, "utf8") > 255)) {
    return `${VAULT_SKIP.tooLong}: the path is too long (over 512 bytes, or a name over 255 bytes); it stays in the repository`;
  }
  return `${VAULT_SKIP.unsupported}: the service cannot hold this path; it stays in the repository`;
}

const SYMLINK_REASON = `${VAULT_SKIP.symlink}: a symbolic link is never followed; it stays in the repository`;
const NOT_A_FILE_REASON = `${VAULT_SKIP.notAFile}: not a regular file; it stays in the repository`;

/**
 * The vault as the clone's working tree holds it: `CLAUDE.md` at the root and
 * everything under `wiki/` and `raw/`. Every file there is either a note, a
 * skipped file (it stays in the repository) or — a vault path the service
 * could not store as it is — a blocker. `.gitkeep` placeholders are the only
 * files not listed. Never follows a link.
 */
async function scanCloneVault(repoRoot: string): Promise<VaultScan> {
  const notes = new Map<string, SourceNote>();
  const skippedNotes: { path: string; reason: string }[] = [];
  const skippedOther: { path: string; reason: string }[] = [];
  const problems = new CappedList();

  const skip = (rel: string, reason: string) => {
    (reason.startsWith(VAULT_SKIP.notMarkdown) ? skippedOther : skippedNotes).push({ path: rel, reason });
  };

  async function visitFile(rel: string): Promise<void> {
    if (path.posix.basename(rel) === ".gitkeep") return;
    if (!isPersonalVaultPath(rel)) {
      skip(rel, skipReason(rel));
      return;
    }
    const file = await readCloneFile(repoRoot, rel, VAULT_NOTE_MAX_BYTES);
    if (!file) {
      skip(rel, NOT_A_FILE_REASON);
      return;
    }
    if (!file.data) {
      problems.push(VAULT_BLOCKER.tooLarge, `${rel} is ${file.bytes} bytes (a note is at most ${VAULT_NOTE_MAX_BYTES})`);
      return;
    }
    const decoded = decodeNote(file.data);
    if ("problem" in decoded) {
      if (decoded.problem === "nul") problems.push(VAULT_BLOCKER.invalidContent, `${rel} contains a NUL character`);
      else problems.push(VAULT_BLOCKER.notUtf8, `${rel} is not UTF-8 text`);
      return;
    }
    const note: SourceNote = { path: normalizeVaultPath(rel), file: rel, bytes: file.bytes, hash: sha256(file.data) };
    const twin = notes.get(note.path);
    if (!twin) {
      notes.set(note.path, note);
    } else if (twin.hash === note.hash) {
      skip(rel, `${VAULT_SKIP.duplicate}: the same note as ${twin.file} once the path is normalized (NFC)`);
    } else {
      problems.push(VAULT_BLOCKER.conflict, `${twin.file} and ${rel} are one note path once normalized (NFC) and their content differs`);
    }
  }

  async function walk(rel: string): Promise<void> {
    const dirents = await fs.readdir(path.join(repoRoot, ...rel.split("/")), { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (dirent.name === ".git") continue;
      const child = `${rel}/${dirent.name}`;
      if (dirent.isSymbolicLink()) skip(child, SYMLINK_REASON);
      else if (dirent.isDirectory()) await walk(child);
      else if (dirent.isFile()) await visitFile(child);
      else skip(child, NOT_A_FILE_REASON);
    }
  }

  for (const top of ["CLAUDE.md", "raw", "wiki"]) {
    const stat = await fs.lstat(path.join(repoRoot, top)).catch(() => null);
    if (!stat) continue;
    if (top === "CLAUDE.md") {
      if (stat.isSymbolicLink()) skip(top, SYMLINK_REASON);
      else if (stat.isFile()) await visitFile(top);
      else skip(top, NOT_A_FILE_REASON);
    } else if (stat.isDirectory()) {
      await walk(top);
    } else {
      // The mirror never writes through a link: once the vault moved, the first note under this folder could
      // not be mirrored, and a rollback (which needs the mirror in sync) would be blocked for good.
      problems.push(
        VAULT_BLOCKER.folderLink,
        `${top} is a ${stat.isSymbolicLink() ? "link" : "file"} in the repository, not a plain folder: the mirror could never write notes under it`,
      );
    }
  }

  const list = [...notes.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bytes = list.reduce((sum, note) => sum + note.bytes, 0);
  if (list.length > SERVICE_MAX_NOTES || bytes > SERVICE_MAX_WIKI_BYTES) {
    problems.push(
      VAULT_BLOCKER.wikiFull,
      `${list.length} notes / ${bytes} bytes are more than a wiki holds (at most ${SERVICE_MAX_NOTES} notes and ${SERVICE_MAX_WIKI_BYTES} bytes)`,
    );
  }
  const skipped = [...skippedNotes, ...skippedOther.slice(0, MAX_LISTED_NON_MARKDOWN)];
  if (skippedOther.length > MAX_LISTED_NON_MARKDOWN) {
    skipped.push({
      path: "wiki/, raw/",
      reason: `${VAULT_SKIP.notMarkdown}: ${skippedOther.length - MAX_LISTED_NON_MARKDOWN} more files that are not markdown notes stay in the repository`,
    });
  }
  return { notes: list, bytes, skipped, blockers: problems.done() };
}

// ---- The clone itself -----------------------------------------------------------

/** What a failed sync was about, in words that carry nothing of git's own output. */
function syncFailureDetail(error: unknown): string {
  const text = scrubGitError(error);
  if (/authentication failed|could not read username|invalid credentials|\b40[13]\b|permission denied|access denied/i.test(text)) {
    return "authentication failed";
  }
  if (/not found|does not exist|does not appear to be a git repository/i.test(text)) return "repository not found";
  if (/could not resolve host|unable to access|timed out|connection refused|network is unreachable|ETIMEDOUT/i.test(text)) {
    return "network error";
  }
  return "git error";
}

/**
 * Where the owner's clone is and what it is a clone of — or the blocker when
 * there is no token to sync it with (nothing is fetched then).
 */
function cloneTarget(ctx: KnowledgeRepoContext): { repoRoot: string; url: string } | { blocker: string } {
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  // The gate of the repo tools and of the mirror (no token at all), plus the one git itself needs: an https
  // remote is only ever sent the token of ITS host. A vault moved without a token could never be mirrored.
  const noneAtAll = !ctx.token && !ctx.externalToken;
  const noneForHost = /^https:\/\//i.test(url) && !tokenForGitUrl(url, ctx.config, { internal: ctx.token, external: ctx.externalToken ?? null });
  if (noneAtAll || noneForHost) {
    return {
      blocker: blocker(
        VAULT_BLOCKER.noToken,
        noneAtAll
          ? "no git token is set, so the repository cannot be synced or mirrored"
          : "no git token is set for this repository's host, so the repository cannot be synced or mirrored",
      ),
    };
  }
  return { repoRoot: knowledgeClonePath(ctx.userId, ctx.config), url };
}

/**
 * Sync the owner's clone with its remote, the way `ensureClone` does (the
 * caller holds the clone's repo lock). A repository that cannot be synced is a
 * blocker, never an exception.
 */
async function syncCloneLocked(ctx: KnowledgeRepoContext, repoRoot: string): Promise<string | null> {
  try {
    await ensureCloneLocked(ctx, repoRoot);
    return null;
  } catch (error) {
    migrationLogger.warn({ userId: ctx.userId, repo: ctx.repo, error: scrubGitError(error) }, "vault migration: the knowledge repo could not be synced");
    return blocker(VAULT_BLOCKER.syncFailed, `could not fetch the repository (${syncFailureDetail(error)})`);
  }
}

async function headCommit(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A tracked `.mcp.json` Noah itself edits at load time and restores before
 * every commit (`restoreTrackedMcpJson`) is not the owner's uncommitted work.
 */
function isRuntimeEdit(dirtyPath: string): boolean {
  return dirtyPath.replace(/"$/, "").endsWith(".mcp.json");
}

/**
 * Whether the clone (the caller holds its lock) is exactly its remote branch:
 * nothing uncommitted, nothing unpushed, not left behind. HEAD is null in a
 * repository without a commit.
 */
async function inspectCloneState(ctx: KnowledgeRepoContext, repoRoot: string, url: string): Promise<{ head: string | null; blockers: string[] }> {
  const blockers: string[] = [];
  if ((await originUrl(repoRoot)) !== url) {
    // The owner connected another repository after the sync above.
    return { head: null, blockers: [blocker(VAULT_BLOCKER.syncFailed, "the clone belongs to another repository (the connected repository just changed)")] };
  }
  const head = await headCommit(repoRoot);
  const dirty = (await dirtyPaths(repoRoot)).filter((entry) => !isRuntimeEdit(entry));
  if (dirty.length > 0) {
    const named = dirty.slice(0, MAX_NAMED_DIRTY_PATHS).join(", ");
    const more = dirty.length > MAX_NAMED_DIRTY_PATHS ? `, and ${dirty.length - MAX_NAMED_DIRTY_PATHS} more` : "";
    blockers.push(blocker(VAULT_BLOCKER.uncommitted, `the clone has uncommitted changes (${named}${more})`));
  }
  if (head) {
    const branch = ctx.branch || (await currentBranch(repoRoot));
    if (!branch) {
      blockers.push(blocker(VAULT_BLOCKER.syncFailed, "the clone is not on a branch"));
    } else {
      const ahead = await aheadOfRemote(repoRoot, branch);
      if (ahead === null) {
        blockers.push(blocker(VAULT_BLOCKER.unpushed, `branch ${branch} does not exist on the remote: the clone's commits are not pushed`));
      } else if (ahead > 0) {
        blockers.push(blocker(VAULT_BLOCKER.unpushed, `${ahead} commit${ahead === 1 ? "" : "s"} on ${branch} ${ahead === 1 ? "is" : "are"} not pushed`));
      } else if ((await behindRemote(repoRoot, branch)) > 0) {
        blockers.push(blocker(VAULT_BLOCKER.syncFailed, "the clone is behind its remote and could not be fast-forwarded"));
      }
    }
  }
  return { head, blockers };
}

/**
 * Why the clone's tree is NOT the tree of the connected branch's remote tip
 * (plus, at most, local commits on top of it) — null when it is. A branch the
 * remote does not have yet has nothing a copy could replace, so it passes; so
 * do uncommitted changes by themselves (they do not move HEAD).
 */
async function cloneNotAtConnectedTip(
  ctx: KnowledgeRepoContext,
  repoRoot: string,
  clone: { head: string | null; blockers: string[] },
): Promise<string | null> {
  if (!clone.head) {
    // No commit at all, or (the only blocker `inspectCloneState` returns without a head) another repository's clone.
    return clone.blockers.find((entry) => !entry.startsWith(`${VAULT_BLOCKER.uncommitted}:`)) ?? null;
  }
  const branch = ctx.branch || (await currentBranch(repoRoot));
  if (!branch) return blocker(VAULT_BLOCKER.syncFailed, "the clone is not on a branch");
  if ((await aheadOfRemote(repoRoot, branch)) === null) return null;
  if ((await behindRemote(repoRoot, branch)) > 0) {
    return blocker(
      VAULT_BLOCKER.syncFailed,
      `the server's copy of the repository does not hold the newest commits of ${branch} — it could not be switched to that branch or fast-forwarded (uncommitted changes there can be in the way: have the avatar commit them)`,
    );
  }
  return null;
}

// ---- The service ----------------------------------------------------------------

/** A service failure as a blocker — an outage is said as an outage, a refusal with its code. */
function serviceBlocker(error: unknown, notePath?: string): string {
  const subject = notePath ?? "the request";
  if (error instanceof MemoryUnavailableError) {
    return blocker(VAULT_BLOCKER.unavailable, `the memory service could not be used (${error.reason})`);
  }
  if (error instanceof MemoryRefusedError) {
    switch (error.code) {
      case MEMORY_REFUSAL.wikiFull:
        return blocker(VAULT_BLOCKER.wikiFull, `the owner's wiki is full (at most ${SERVICE_MAX_NOTES} notes and ${SERVICE_MAX_WIKI_BYTES} bytes)`);
      case MEMORY_REFUSAL.tooLarge:
      case MEMORY_REFUSAL.bodyTooLarge:
        return blocker(VAULT_BLOCKER.tooLarge, `${subject} is larger than a note may be (${VAULT_NOTE_MAX_BYTES} bytes)`);
      case MEMORY_REFUSAL.exists:
      case MEMORY_REFUSAL.stale:
        return blocker(VAULT_BLOCKER.serviceConflict, `the memory service already holds a different note at ${subject} (it changed during the import)`);
      case "invalid_content":
        return blocker(VAULT_BLOCKER.invalidContent, `${subject} is not text the service stores`);
      default:
        return blocker(VAULT_BLOCKER.refused, `the service refused ${subject} (code: ${error.code})`);
    }
  }
  throw error;
}

/** The owner's vault notes in the service (anything else there is not Noah's to see). */
async function serviceVaultNotes(client: MemoryClient, userId: string) {
  return (await client.list(userId)).filter((entry) => isPersonalVaultPath(entry.path));
}

/**
 * The service against the clone's notes: `present` = the paths the service
 * already holds with the SAME content (nothing to import); a different note at
 * a clone path, and a vault note the clone does not have, are blockers.
 */
async function compareWithService(
  client: MemoryClient,
  userId: string,
  notes: SourceNote[],
): Promise<{ present: Set<string>; held: number; blockers: string[] }> {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const present = new Set<string>();
  const problems = new CappedList();
  const held = await serviceVaultNotes(client, userId);
  for (const entry of held) {
    const source = byPath.get(entry.path);
    if (!source) {
      problems.push(VAULT_BLOCKER.serviceOnly, `the memory service already holds ${entry.path}, which the repository does not have`);
      continue;
    }
    // A different size is a different note; the same size needs the hash.
    const same = entry.bytes === source.bytes && (await client.read(userId, entry.path))?.hash === source.hash;
    if (same) present.add(entry.path);
    else problems.push(VAULT_BLOCKER.serviceConflict, `the memory service already holds a different note at ${entry.path}`);
  }
  return { present, held: held.length, blockers: problems.done() };
}

/** Take back what a failed import put into the service — only notes that still are exactly what it sent. */
async function discardImported(client: MemoryClient, userId: string, sent: SourceNote[]): Promise<void> {
  try {
    for (const note of sent) {
      const current = await client.read(userId, note.path);
      if (current && current.hash === note.hash) await client.remove(userId, note.path, current.hash);
    }
  } catch (error) {
    migrationLogger.warn(
      { userId, sent: sent.length, err: error },
      "vault migration: the notes of a failed import could not all be taken back; the next attempt skips the ones that still match",
    );
  }
}

/**
 * Import the clone's notes and prove the service holds exactly them. Returns
 * the blocker when it does not — and then the notes this attempt created are
 * taken back, so a failed import leaves the service as it found it — else a
 * `discard` that takes them back (the caller decides not to flip after all).
 */
async function importNotes(
  client: MemoryClient,
  userId: string,
  repoRoot: string,
  notes: SourceNote[],
  present: Set<string>,
): Promise<{ problem: string } | { discard(): Promise<void> }> {
  const sent: SourceNote[] = [];
  let current: string | undefined;
  const failed = async (problem: string) => {
    await discardImported(client, userId, sent);
    return { problem };
  };
  try {
    for (const note of notes) {
      if (present.has(note.path)) continue;
      current = note.path;
      const file = await readCloneFile(repoRoot, note.file, VAULT_NOTE_MAX_BYTES);
      const decoded = file?.data ? decodeNote(file.data) : null;
      if (!file?.data || !decoded || "problem" in decoded || sha256(file.data) !== note.hash) {
        return await failed(blocker(VAULT_BLOCKER.sourceChanged, `${note.file} changed while it was being imported`));
      }
      sent.push(note);
      const put = await client.put(userId, note.path, decoded.text);
      if (put.hash !== note.hash) {
        return await failed(blocker(VAULT_BLOCKER.verifyFailed, `${note.path} was stored with content that differs from the repository's file`));
      }
    }
    // Verify: the same set of vault notes, and every one read back with the clone's hash.
    current = undefined;
    const wanted = new Set(notes.map((note) => note.path));
    for (const entry of await serviceVaultNotes(client, userId)) {
      if (!wanted.has(entry.path)) {
        return await failed(blocker(VAULT_BLOCKER.serviceOnly, `the memory service already holds ${entry.path}, which the repository does not have`));
      }
    }
    for (const note of notes) {
      current = note.path;
      const stored = await client.read(userId, note.path);
      if (!stored) return await failed(blocker(VAULT_BLOCKER.verifyFailed, `${note.path} is missing after the import`));
      if (stored.hash !== note.hash) {
        return await failed(blocker(VAULT_BLOCKER.verifyFailed, `${note.path} read back from the service differs from the repository's file`));
      }
    }
    // Verified. `discard` is for a caller whose last look before the flip says no after all.
    return { discard: () => discardImported(client, userId, sent) };
  } catch (error) {
    return failed(serviceBlocker(error, current));
  }
}

/**
 * The first mirror record of a vault that just moved (the clone equals the
 * service, so there is nothing to write). The caller holds both locks. A
 * failure never undoes the move: the row is marked for the mirror loop.
 */
async function recordFirstMirror(store: Store, config: AppConfig, userId: string): Promise<void> {
  try {
    const outcome = await syncVaultMirror(store, config, userId, { push: true, locked: true });
    if (outcome.kind === "synced") return;
    migrationLogger.warn({ userId, outcome }, "vault migration: the first mirror record did not end in sync; the mirror loop retries");
  } catch (error) {
    migrationLogger.warn({ userId, err: error }, "vault migration: the first mirror record failed; the mirror loop retries");
  }
  store.markVaultMirrorDirty(userId);
}

// ---- Per-instance state: the last reports and the one job queue -----------------

interface MigrationState {
  reports: Map<string, VaultMigrationReport>;
  /** Jobs queued or running. */
  jobs: number;
  tail: Promise<unknown>;
  /** The pass queued or running, if any. */
  pass: Promise<VaultMigrationReport[]> | null;
  /** Owners whose cutover (asked for by a repository change) waits for their run to end. */
  retries: Map<string, NodeJS.Timeout>;
}

const states = new WeakMap<Store, MigrationState>();

function stateOf(store: Store): MigrationState {
  let state = states.get(store);
  if (!state) {
    state = { reports: new Map(), jobs: 0, tail: Promise.resolve(), pass: null, retries: new Map() };
    states.set(store, state);
  }
  return state;
}

function remember(store: Store, report: VaultMigrationReport): VaultMigrationReport {
  stateOf(store).reports.set(report.userId, report);
  return report;
}

/** The owner's last dry-run or cutover report of this process, else null. */
export function lastVaultMigrationReport(store: Store, userId: string): VaultMigrationReport | null {
  return stateOf(store).reports.get(userId) ?? null;
}

/** Whether a migration job (a pass, or one owner's repository change) is queued or running. */
export function isVaultMigrationRunning(store: Store): boolean {
  return stateOf(store).jobs > 0;
}

/** Resolves when the queue is empty: every job queued so far, and every job those queued, has finished (tests; shutdown). Never rejects. */
export async function whenVaultMigrationIdle(store: Store): Promise<void> {
  const state = stateOf(store);
  for (;;) {
    const tail = state.tail;
    await tail; // the stored tail never rejects (see `enqueue`)
    if (state.tail === tail) return;
  }
}

/** Run `job` after every job queued before it. The returned promise settles as `job` does; the queue never breaks. */
function enqueue<T>(store: Store, job: () => Promise<T>): Promise<T> {
  const state = stateOf(store);
  state.jobs += 1;
  const run = state.tail.then(job);
  state.tail = run.then(
    () => undefined,
    () => undefined,
  );
  void state.tail.then(() => {
    state.jobs -= 1;
  });
  return run;
}

// ---- Dry run and cutover --------------------------------------------------------

/**
 * Whether what a job set out with still holds: the user exists and the SAME
 * repository and branch are connected. Asked again inside the locks (the job
 * may have waited there while the owner connected another repository) and once
 * more, synchronously, right before a flip or a change of the hold — a vault
 * imported from the old repository must never be mirrored into the new one.
 */
function contextBlocker(store: Store, userId: string, ctx: KnowledgeRepoContext): string | null {
  if (!store.getUserById(userId)) return blocker(VAULT_BLOCKER.noUser, "the user was deleted while their vault was being looked at");
  const now = store.getKnowledgeRepo(userId);
  if (now.repo !== ctx.repo || (now.branch ?? null) !== (ctx.branch ?? null)) {
    return blocker(VAULT_BLOCKER.repoChanged, "the connected repository or branch changed while this owner was being looked at; the new one is handled on its own");
  }
  return null;
}

async function migrateOwner(store: Store, config: AppConfig, userId: string, mode: "plan" | "cutover"): Promise<VaultMigrationReport> {
  const repo = store.getKnowledgeRepo(userId).repo;
  const report: VaultMigrationReport = {
    userId,
    repo,
    sourceCommit: null,
    notes: 0,
    bytes: 0,
    skipped: [],
    blockers: [],
    state: repo ? "repo" : "no_repo",
  };
  if (!store.getUserById(userId)) {
    report.state = "no_repo";
    report.blockers.push(blocker(VAULT_BLOCKER.noUser, "no such user"));
    return report;
  }
  const client = memoryClientFor(store, config);
  const notConfigured = blocker(VAULT_BLOCKER.notConfigured, "this server has no memory service configured");

  const row = store.getPersonalVault(userId);
  if (row) {
    // Already moved: nothing to import. The report says what the service holds.
    report.state = "memory";
    report.sourceCommit = row.sourceCommit;
    if (!client) {
      report.blockers.push(notConfigured);
      return report;
    }
    try {
      const held = await serviceVaultNotes(client, userId);
      report.notes = held.length;
      report.bytes = held.reduce((sum, entry) => sum + entry.bytes, 0);
    } catch (error) {
      report.blockers.push(serviceBlocker(error));
    }
    return report;
  }

  const ctx = knowledgeRepoContextFor(store, userId, config);
  if (!ctx) return report; // No repository: nothing to import; the vault starts in the service when one is connected.

  if (!client) report.blockers.push(notConfigured);
  if (mode === "cutover") {
    if (!client) return report;
    if (!store.retirementGate().allowed) {
      report.blockers.push(blocker(VAULT_BLOCKER.backupFailed, BACKUP_HELD_DETAIL));
      return report;
    }
  }
  const running = blocker(VAULT_BLOCKER.runInProgress, "a run is in progress for this owner");
  if (ownerRunInProgress(store, userId)) {
    report.blockers.push(running);
    if (mode === "cutover") return report;
  }

  const target = cloneTarget(ctx);
  if ("blocker" in target) {
    report.blockers.push(target.blocker);
    return report;
  }
  const { repoRoot, url } = target;
  return withRepoLock(repoRoot, async () => {
    // Everything decided before this lock is asked again now that it is held: the wait may have been long.
    // The owner connected another repository or branch meanwhile (the clone path is the same for both), or was deleted.
    const stale = contextBlocker(store, userId, ctx);
    if (stale) {
      report.blockers.push(stale);
      return report;
    }
    // A run that started while this waited for the clone.
    if (mode === "cutover" && ownerRunInProgress(store, userId)) {
      report.blockers.push(running);
      return report;
    }
    const unsynced = await syncCloneLocked(ctx, repoRoot);
    if (unsynced) {
      report.blockers.push(unsynced);
      return report;
    }
    const clone = await inspectCloneState(ctx, repoRoot, url);
    const scan = await scanCloneVault(repoRoot);
    report.sourceCommit = clone.head;
    report.notes = scan.notes.length;
    report.bytes = scan.bytes;
    report.skipped = scan.skipped;
    report.blockers.push(...clone.blockers, ...scan.blockers);

    let present = new Set<string>();
    if (client) {
      try {
        const compared = await compareWithService(client, userId, scan.notes);
        present = compared.present;
        report.blockers.push(...compared.blockers);
      } catch (error) {
        report.blockers.push(serviceBlocker(error));
      }
    }
    if (mode === "plan" || !client || report.blockers.length > 0) return report;

    const imported = await importNotes(client, userId, repoRoot, scan.notes, present);
    if ("problem" in imported) {
      report.blockers.push(imported.problem);
      return report;
    }
    // The last look, in the same tick as the flip: the import took a while, and a flip from a repository that
    // is no longer the connected one (or for a user deleted meanwhile) must not happen.
    const late = contextBlocker(store, userId, ctx);
    if (late) {
      await imported.discard();
      report.blockers.push(late);
      return report;
    }
    store.setPersonalVaultMemory(userId, { sourceRepo: ctx.repo, sourceCommit: clone.head });
    report.state = "memory";
    migrationLogger.warn(
      { userId, repo: ctx.repo, sourceCommit: clone.head, notes: scan.notes.length, bytes: scan.bytes },
      "personal vault moved to the memory service (the repository keeps a mirror; no source file was changed)",
    );
    await recordFirstMirror(store, config, userId);
    return report;
  });
}

function failedReport(store: Store, userId: string, error: unknown, what: string): VaultMigrationReport {
  migrationLogger.error({ userId, err: error }, `vault migration: ${what} failed unexpectedly`);
  let repo: string | null = null;
  let state: VaultMigrationReport["state"] = "no_repo";
  try {
    repo = store.getKnowledgeRepo(userId).repo;
    state = store.getPersonalVault(userId) ? "memory" : repo ? "repo" : "no_repo";
  } catch {
    // The store itself is what failed (closed at shutdown): the report still says that it failed.
  }
  return {
    userId,
    repo,
    sourceCommit: null,
    notes: 0,
    bytes: 0,
    skipped: [],
    blockers: [blocker(VAULT_BLOCKER.internal, `${what} failed unexpectedly (see the server log)`)],
    state,
  };
}

/**
 * Dry run: what a cutover of this owner would import, skip and be blocked by —
 * right now. Changes nothing in the service or the store (the clone is synced
 * with its remote, as any run does). Never throws.
 */
export async function planVaultMigration(store: Store, config: AppConfig, userId: string): Promise<VaultMigrationReport> {
  try {
    return remember(store, await migrateOwner(store, config, userId, "plan"));
  } catch (error) {
    return remember(store, failedReport(store, userId, error, "the dry run"));
  }
}

/**
 * Move this owner's vault into the memory service: backup gate, sync, import,
 * verify, flip, first mirror record. Idempotent and resumable — an owner
 * already moved is reported as `memory` and nothing is sent; a note the
 * service already holds with the same content is not sent again. A blocker
 * leaves the owner on `repo` and the service as it was found. Never throws.
 */
export async function cutoverVault(store: Store, config: AppConfig, userId: string): Promise<VaultMigrationReport> {
  try {
    return remember(
      store,
      await withVaultWriteLock(store, userId, () => migrateOwner(store, config, userId, "cutover")),
    );
  } catch (error) {
    return remember(store, failedReport(store, userId, error, "the cutover"));
  }
}

// ---- Rollback -------------------------------------------------------------------

/**
 * The bytes of a note in the owner's clone, found WITHOUT following a link
 * anywhere on the way; null when the clone does not hold it as a plain file.
 */
async function cloneNoteBytes(repoRoot: string, notePath: string): Promise<Buffer | null> {
  const parts = notePath.split("/");
  let dir = repoRoot;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    const stat = await fs.lstat(dir).catch(() => null);
    if (!stat || !stat.isDirectory()) return null;
  }
  return (await readCloneFile(repoRoot, notePath, VAULT_NOTE_MAX_BYTES))?.data ?? null;
}

/**
 * Before a leftover copy is deleted: every note of it that the owner's clone
 * does not hold byte for byte (missing there, or different) is written under
 * `VAULT_LEFTOVER_DIR` and moved into this boot's quarantine with the
 * retirement helpers — `<dataDir>/retired/<boot stamp>/personal-vault-leftover/
 * <user>/<time>/<note path>`, which Noah never prunes. Nothing differs →
 * nothing is written. THROWS when a note cannot be read or put aside: the
 * caller then deletes nothing.
 */
async function quarantineLeftoverNotes(
  config: AppConfig,
  client: MemoryClient,
  userId: string,
  gate: { allowed: boolean; stamp: string },
  /** Which notes are looked at (default: all). A real rollback passes "not a vault path": the mirror already put the vault paths into the repository. */
  only: (notePath: string) => boolean = () => true,
): Promise<{ notes: number; quarantined: number }> {
  const sweep = openRetirementSweep(config.dataDir, gate, "personal vault leftover");
  if (!sweep) throw new Error("the retirement gate is held");
  const repoRoot = knowledgeClonePath(userId, config);
  const userDir = path.join(config.dataDir, VAULT_LEFTOVER_DIR, sanitizeName(userId));
  const folder = path.join(userDir, new Date().toISOString().replace(/[:.]/g, "-"));
  // Everything the wiki holds goes with `deleteWiki`, not only vault paths.
  const entries = (await client.list(userId)).filter((entry) => only(entry.path));
  let quarantined = 0;
  for (const entry of entries) {
    const note = await client.read(userId, entry.path);
    if (!note) continue; // gone since the listing: nothing left to lose
    const inClone = await cloneNoteBytes(repoRoot, entry.path);
    if (inClone && sha256(inClone) === note.hash) continue;
    const parts = entry.path.split("/");
    if (!parts.every(isPlainSegment)) throw new Error(`a leftover note has a path that cannot be saved: ${entry.path}`);
    const file = path.join(folder, ...parts);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, note.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    quarantined += 1;
  }
  if (quarantined > 0) {
    if (!quarantineRetired(folder, sweep)) {
      throw new Error(`the leftover notes were written to ${folder} but could not be moved into the quarantine (${sweep.sample.join(", ")})`);
    }
    migrationLogger.warn(
      { userId, quarantined, path: path.join(config.dataDir, QUARANTINE_DIR, gate.stamp, path.relative(config.dataDir, folder)) },
      "vault rollback: leftover notes the repository's clone does not hold were quarantined (Noah never deletes them)",
    );
    // The emptied parents; only ever an empty folder.
    await fs.rmdir(userDir).catch(() => undefined);
    await fs.rmdir(path.dirname(userDir)).catch(() => undefined);
  }
  return { notes: entries.length, quarantined };
}

/**
 * Move this owner's vault back to the repository: the mirror is pushed one
 * last time and must end in sync, then the home flips and the service's copy
 * is deleted. A mirror that cannot be brought up to date blocks the rollback
 * and says why — it never falls back to an older copy. A vault write that was
 * waiting meanwhile ends in `VAULT_HOME_CHANGED` and reaches nothing.
 *
 * For an owner whose home already is `repo`, this discards what the service
 * still holds for them (an import that never flipped, a wiki an earlier
 * rollback could not delete): nothing reads it, and it would block the next
 * cutover once the repository's notes change. That copy was never verified
 * against the repository, so every note of it that the owner's clone does not
 * hold as it is goes into the retirement quarantine first; when one cannot be
 * read or put aside, nothing is deleted (`leftover_not_saved`).
 */
export async function rollbackVault(
  store: Store,
  config: AppConfig,
  userId: string,
  options: {
    /** The home the caller believes the owner has. When it is not, nothing is done (`home_mismatch`): a stale screen must not turn "discard the leftover copy" into a real rollback, or the reverse. */
    expect?: "memory" | "repo";
  } = {},
): Promise<VaultRollbackResult> {
  try {
    return await withVaultWriteLock(store, userId, async () => {
      const client = memoryClientFor(store, config);
      const row = store.getPersonalVault(userId);
      if (options.expect && options.expect !== (row ? "memory" : "repo")) {
        return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.homeMismatch };
      }
      if (!row && !client) return { ok: true as const };
      if (!client) return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.notConfigured };
      const gate = store.retirementGate();
      if (!gate.allowed) return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.backupFailed };

      if (!row) {
        // Nothing here was verified against the repository (unlike a real rollback): what the clone does not
        // hold as it is goes to the quarantine first. Never deleted without a way back.
        let leftover: { notes: number; quarantined: number };
        try {
          leftover = await quarantineLeftoverNotes(config, client, userId, gate);
        } catch (error) {
          migrationLogger.warn(
            { userId, err: error },
            "vault rollback: the leftover copy's notes could not all be read and put aside; nothing was deleted",
          );
          return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved };
        }
        try {
          await client.deleteWiki(userId);
        } catch (error) {
          migrationLogger.warn({ userId, err: error }, "vault rollback: the service's leftover copy could not be deleted");
          return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.unavailable };
        }
        migrationLogger.warn(
          { userId, ...leftover },
          "vault rollback: the leftover copy in the memory service was discarded (notes the repository's clone did not hold were quarantined first)",
        );
        // The report that named the leftover (and offered to discard it) is about a copy that is gone.
        stateOf(store).reports.delete(userId);
        return { ok: true as const, leftover };
      }

      let outcome: Awaited<ReturnType<typeof syncVaultMirror>>;
      try {
        outcome = await syncVaultMirror(store, config, userId, { push: true });
      } catch (error) {
        migrationLogger.warn({ userId, err: error }, "vault rollback: the last mirror push threw");
        outcome = { kind: "failed", error: "the mirror could not run" };
      }
      if (outcome.kind === "skipped") {
        const reason = {
          hold: VAULT_ROLLBACK_REFUSAL.mirrorHold,
          no_repo: VAULT_ROLLBACK_REFUSAL.mirrorNoRepo,
          repo_dirty: VAULT_ROLLBACK_REFUSAL.mirrorRepoDirty,
        }[outcome.reason];
        return { ok: false as const, reason };
      }
      if (outcome.kind === "failed") {
        return { ok: false as const, reason: `${VAULT_ROLLBACK_REFUSAL.mirrorFailed}: ${outcome.error}` };
      }
      // This lock kept every Noah write out during the push, so a row that is still marked was not fully mirrored.
      // A NOTICE on the row does not block: the repository then holds everything the service has, and more
      // (the way back after a lost service volume).
      if (store.getPersonalVault(userId)?.mirrorDirty) {
        return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.mirrorBehind };
      }
      // The mirror carries vault paths only. Whatever else the wiki holds is deleted with it, so it is put
      // aside first — before the flip, so that a note that cannot be saved leaves everything as it was.
      let quarantined: number;
      try {
        ({ quarantined } = await quarantineLeftoverNotes(config, client, userId, gate, (notePath) => !isPersonalVaultPath(notePath)));
      } catch (error) {
        migrationLogger.warn({ userId, err: error }, "vault rollback: wiki notes outside the vault paths could not be read and put aside; nothing was changed");
        return { ok: false as const, reason: VAULT_ROLLBACK_REFUSAL.leftoverNotSaved };
      }

      // The flip comes first: a wiki deleted under a row that still says `memory` would be mirrored as "delete every note".
      store.clearPersonalVault(userId);
      migrationLogger.warn({ userId, repo: row.sourceRepo }, "personal vault moved back to the repository (the mirror was in sync)");
      try {
        await client.deleteWiki(userId);
      } catch (error) {
        migrationLogger.warn(
          { userId, err: error },
          "vault rollback: the home is `repo` again, but the service's copy could not be deleted — roll this owner back once more to discard it",
        );
      }
      return quarantined > 0 ? { ok: true as const, quarantined } : { ok: true as const };
    });
  } catch (error) {
    migrationLogger.error({ userId, err: error }, "vault rollback failed unexpectedly");
    return { ok: false, reason: VAULT_ROLLBACK_REFUSAL.internal };
  }
}

// ---- The pass -------------------------------------------------------------------

async function passBody(store: Store, config: AppConfig): Promise<VaultMigrationReport[]> {
  const reports: VaultMigrationReport[] = [];
  for (const user of store.listUsers()) {
    // Setting the mode back to `repo` stops NEW cutovers, also in the middle of a pass.
    if (store.getPersonalVaultMode() !== "memory") break;
    if (store.getPersonalVault(user.id) || !store.getKnowledgeRepo(user.id).repo) continue;
    reports.push(await cutoverVault(store, config, user.id));
  }
  // An owner whose repository changed and could not be looked at then (no token, unreachable) is looked at again.
  for (const row of store.listPersonalVaults()) {
    if (row.mirrorHold !== "checking") continue;
    await settleRepoChange(store, config, row.userId).catch((error: unknown) => {
      migrationLogger.warn({ userId: row.userId, err: error }, "vault migration: a held mirror could not be re-checked");
    });
  }
  return reports;
}

/**
 * Cut over every owner with a connected repo and home `repo`, one at a time
 * (only while the instance's mode is `memory`); returns each report. One pass
 * at a time per app instance: a call made while a pass is queued or running
 * joins that pass.
 */
export function runVaultMigrationPass(store: Store, config: AppConfig): Promise<VaultMigrationReport[]> {
  const state = stateOf(store);
  if (state.pass) return state.pass;
  const pass = enqueue(store, () => passBody(store, config)).catch((error: unknown) => {
    migrationLogger.error({ err: error }, "vault migration pass failed unexpectedly");
    return [] as VaultMigrationReport[];
  });
  state.pass = pass;
  void pass.then(() => {
    if (state.pass === pass) state.pass = null;
  });
  return pass;
}

/** Start the pass in the background. False when one is already queued or running. */
export function startVaultMigrationPass(store: Store, config: AppConfig): boolean {
  if (stateOf(store).pass) return false;
  void runVaultMigrationPass(store, config);
  return true;
}

// ---- A repository connected or changed ------------------------------------------

/**
 * An owner in `memory` has a repository or branch newly connected; the hook
 * put the mirror on hold as `checking`. Look at what is there and settle it:
 *
 * - LIFT (the mirror continues into it): the repository holds no vault file,
 *   or every vault note it holds is already in the service with the same
 *   content (a repository reconnected) — nothing there would be replaced.
 * - `confirm`: both hold notes and the repository has vault notes of its own.
 *   Only the owner's press in settings (`mirror-confirm`) lets the copy
 *   replace them.
 * - The service's wiki is EMPTY and the repository holds vault notes → they
 *   are imported, as in a cutover (same blockers), and the hold is lifted.
 * - Could not look, or could not import (no token, unreachable, service down,
 *   a blocker) → it stays `checking`: retried a bounded number of times and by
 *   every pass.
 *
 * What the job set out with (repository and branch) is asked again inside the
 * locks and right before every change of state: when the owner connected yet
 * another repository meanwhile, this stops — that change has its own check
 * queued — and the state stays `checking`.
 */
async function settleRepoChange(store: Store, config: AppConfig, userId: string): Promise<void> {
  await withVaultWriteLock(store, userId, async () => {
    // Rolled back meanwhile, or already settled by an earlier check of the same change.
    if (store.getPersonalVault(userId)?.mirrorHold !== "checking") return;
    const ctx = knowledgeRepoContextFor(store, userId, config);
    const client = memoryClientFor(store, config);
    if (!ctx || !client) return;
    /**
     * The look could not happen: logged, and kept as this owner's report so the
     * admin table names what is in the way (`keep: false` for a look that is
     * merely outdated — the newer change has its own check and report).
     */
    const unseen = (why: string, keep = true) => {
      migrationLogger.warn({ userId, repo: ctx.repo, blocker: why }, "vault mirror stays on hold (checking): the newly connected repository could not be looked at");
      if (keep) remember(store, { userId, repo: ctx.repo, sourceCommit: null, notes: 0, bytes: 0, skipped: [], blockers: [why], state: "memory" });
    };
    /** The look happened: a report that only said why an earlier one could not is dropped. */
    const seen = () => {
      const reports = stateOf(store).reports;
      if ((reports.get(userId)?.blockers.length ?? 0) > 0) reports.delete(userId);
    };
    const target = cloneTarget(ctx);
    if ("blocker" in target) {
      unseen(target.blocker);
      return;
    }
    const { repoRoot, url } = target;
    await withRepoLock(repoRoot, async () => {
      /** True (and logged) when this check is about a repository that is no longer the connected one. */
      const outdated = () => {
        const why = contextBlocker(store, userId, ctx);
        if (why) unseen(why, false);
        return why !== null;
      };
      if (outdated()) return;
      const unsynced = await syncCloneLocked(ctx, repoRoot);
      if (unsynced) {
        unseen(unsynced);
        return;
      }
      const clone = await inspectCloneState(ctx, repoRoot, url);
      // The tree about to be judged must be the connected branch's: a clone that could not be switched or
      // fast-forwarded (uncommitted changes in the way) still shows the PREVIOUS branch, and judging that
      // would lift the hold — or ask about the wrong notes — for a branch nobody looked at.
      const elsewhere = await cloneNotAtConnectedTip(ctx, repoRoot, clone);
      if (elsewhere) {
        unseen(elsewhere);
        return;
      }
      const scan = await scanCloneVault(repoRoot);
      const lift = () => {
        if (outdated()) return;
        store.setVaultMirrorHold(userId, null);
        store.markVaultMirrorDirty(userId);
        seen();
      };
      if (scan.notes.length === 0 && scan.blockers.length === 0) {
        lift();
        return;
      }
      const compared = await compareWithService(client, userId, scan.notes);
      if (compared.held > 0) {
        const nothingReplaced = scan.blockers.length === 0 && scan.notes.every((note) => compared.present.has(note.path));
        if (nothingReplaced) {
          lift();
        } else if (!outdated()) {
          store.setVaultMirrorHold(userId, "confirm");
          seen();
          migrationLogger.info({ userId, repo: ctx.repo }, "vault mirror on hold (confirm): the connected repository holds vault notes of its own; the owner must confirm");
        }
        return;
      }
      // An empty wiki: the repository's vault becomes the vault.
      const report: VaultMigrationReport = {
        userId,
        repo: ctx.repo,
        sourceCommit: clone.head,
        notes: scan.notes.length,
        bytes: scan.bytes,
        skipped: scan.skipped,
        blockers: [...clone.blockers, ...scan.blockers],
        state: "memory",
      };
      if (ownerRunInProgress(store, userId)) report.blockers.push(blocker(VAULT_BLOCKER.runInProgress, "a run is in progress for this owner"));
      if (report.blockers.length === 0 && !store.retirementGate().allowed) {
        report.blockers.push(blocker(VAULT_BLOCKER.backupFailed, BACKUP_HELD_DETAIL));
      }
      if (report.blockers.length === 0) {
        const imported = await importNotes(client, userId, repoRoot, scan.notes, compared.present);
        if ("problem" in imported) {
          report.blockers.push(imported.problem);
        } else {
          // The last look, in the same tick as the change of provenance and hold.
          const late = contextBlocker(store, userId, ctx);
          if (late) {
            await imported.discard();
            report.blockers.push(late);
          }
        }
      }
      remember(store, report);
      if (report.blockers.length > 0) {
        migrationLogger.warn({ userId, repo: ctx.repo, blockers: report.blockers }, "vault mirror stays on hold (checking): the connected repository's vault could not be imported into the empty wiki");
        return;
      }
      store.setPersonalVaultMemory(userId, { sourceRepo: ctx.repo, sourceCommit: clone.head });
      store.setVaultMirrorHold(userId, null);
      migrationLogger.warn({ userId, repo: ctx.repo, notes: scan.notes.length }, "personal vault imported from the newly connected repository (the wiki was empty)");
      await recordFirstMirror(store, config, userId);
    });
  });
}

/**
 * How the follow-up of a repository change is retried while it cannot finish (a
 * run in progress, a repository that cannot be looked at): `attempts` times
 * every `delayMs`. A cutover then waits for the next pass; the look at a
 * repository on hold (`checking`) never gives up — it goes on every
 * `slowDelayMs`, because nothing else would end that hold while the mode is
 * `repo` and no admin runs a pass.
 */
const repoChangeRetry = { delayMs: 60_000, attempts: 30, slowDelayMs: 10 * 60_000 };

/** Tests: shorten (or restore, with no argument) the retry of a repository change's follow-up. */
export function setVaultCutoverRetryForTests(options: { delayMs?: number; attempts?: number; slowDelayMs?: number } = {}): void {
  repoChangeRetry.delayMs = options.delayMs ?? 60_000;
  repoChangeRetry.attempts = options.attempts ?? 30;
  repoChangeRetry.slowDelayMs = options.slowDelayMs ?? 10 * 60_000;
}

function cancelRepoChangeRetry(store: Store, userId: string): void {
  const retries = stateOf(store).retries;
  clearTimeout(retries.get(userId));
  retries.delete(userId);
}

/** Run `again` for this owner after the retry delay (one pending retry per owner; never keeps the process alive). */
function retryRepoChange(store: Store, userId: string, again: () => void, delayMs = repoChangeRetry.delayMs): void {
  cancelRepoChangeRetry(store, userId);
  const timer = setTimeout(() => {
    stateOf(store).retries.delete(userId);
    again();
  }, delayMs);
  timer.unref?.();
  stateOf(store).retries.set(userId, timer);
}

/**
 * Cut over an owner whose repository was just connected. A repository created
 * BY the avatar (`create_repo`) is connected in the middle of a run, and a
 * cutover is refused while a run of the owner is in progress — so that one
 * blocker is retried here, a bounded number of times, instead of leaving the
 * owner on `repo` until an admin runs the pass. Every other blocker waits for
 * the next pass.
 */
function cutoverAfterRepoChange(store: Store, config: AppConfig, userId: string, attempt: number): void {
  void enqueue(store, async () => {
    // Again, now that it is this job's turn: the mode, the home or the repository may have changed.
    if (store.getPersonalVault(userId) || store.getPersonalVaultMode() !== "memory" || !store.getKnowledgeRepo(userId).repo) return;
    const report = await cutoverVault(store, config, userId);
    const busy = report.state === "repo" && report.blockers.some((text) => text.startsWith(`${VAULT_BLOCKER.runInProgress}:`));
    if (busy && attempt + 1 < repoChangeRetry.attempts) {
      retryRepoChange(store, userId, () => cutoverAfterRepoChange(store, config, userId, attempt + 1));
    }
  }).catch((error: unknown) => {
    migrationLogger.warn({ userId, err: error }, "vault migration: the cutover after a repository change could not run");
  });
}

/**
 * Check the newly connected repository of an owner in `memory`
 * (`settleRepoChange`). A check that could not finish leaves the hold at
 * `checking`; it is retried here for as long as the hold is `checking` — about
 * once a minute at first, then every ten minutes — and by every pass, so the
 * owner never waits for an admin. The timers live in this process: after a
 * restart `resumeVaultMirrorChecks` starts them again.
 */
function settleAfterRepoChange(store: Store, config: AppConfig, userId: string, attempt: number): void {
  void enqueue(store, async () => {
    try {
      await settleRepoChange(store, config, userId);
    } catch (error) {
      migrationLogger.warn({ userId, err: error }, "vault mirror stays on hold (checking): the newly connected repository could not be checked");
      // The memory service not answering in the middle of the look is named in the admin table like the
      // obstacles the look itself reports; anything else is in the log only.
      if (error instanceof MemoryUnavailableError || error instanceof MemoryRefusedError) {
        const repo = store.getKnowledgeRepo(userId).repo;
        if (repo && store.getPersonalVault(userId)?.mirrorHold === "checking") {
          remember(store, { userId, repo, sourceCommit: null, notes: 0, bytes: 0, skipped: [], blockers: [serviceBlocker(error)], state: "memory" });
        }
      }
    }
    if (store.getPersonalVault(userId)?.mirrorHold === "checking") {
      const delayMs = attempt + 1 < repoChangeRetry.attempts ? repoChangeRetry.delayMs : repoChangeRetry.slowDelayMs;
      retryRepoChange(store, userId, () => settleAfterRepoChange(store, config, userId, attempt + 1), delayMs);
    }
  }).catch((error: unknown) => {
    migrationLogger.warn({ userId, err: error }, "vault migration: the check after a repository change could not run");
  });
}

/**
 * Boot: every hold left at `checking` gets its look (and its retries) again —
 * the retry timers of the process that set the hold are gone. Returns how many.
 */
export function resumeVaultMirrorChecks(store: Store, config: AppConfig): number {
  let resumed = 0;
  for (const row of store.listPersonalVaults()) {
    if (row.mirrorHold !== "checking" || stateOf(store).retries.has(row.userId)) continue;
    settleAfterRepoChange(store, config, row.userId, 0);
    resumed += 1;
  }
  return resumed;
}

/**
 * The owner asks for the look at their newly connected repository to run again
 * NOW — after fixing what was in the way (a git token, the repository's
 * address) instead of waiting for the next retry or an admin's pass. Does
 * nothing, and says so, unless the hold is `checking`; it never changes the
 * hold by itself.
 */
export function recheckVaultMirrorHold(store: Store, config: AppConfig, userId: string): boolean {
  if (store.getPersonalVault(userId)?.mirrorHold !== "checking") return false;
  cancelRepoChangeRetry(store, userId);
  settleAfterRepoChange(store, config, userId, 0);
  return true;
}

/**
 * An owner's knowledge repository or branch was connected or changed (called
 * by the route and `create_repo` right after the change is stored).
 * Fire-and-forget; never throws.
 *
 * - Home `repo`, mode `memory`: the owner is cut over (queued behind any
 *   running job; retried while a run of theirs is in progress).
 * - Home `memory`: the mirror is put on hold AT ONCE as `checking` — before
 *   anything could write into the new repository — and an armed "make the
 *   repository equal to the service" (the owner's confirmation of the PREVIOUS
 *   repository) is disarmed. The queued check then lifts the hold or turns it
 *   into `confirm` (see `settleRepoChange`). Nothing in the repository is
 *   replaced without the owner's press.
 */
export function onKnowledgeRepoChanged(store: Store, config: AppConfig, userId: string, previousRepo: string | null): void {
  try {
    cancelRepoChangeRetry(store, userId);
    const { repo } = store.getKnowledgeRepo(userId);
    if (!repo) return; // Disconnected: nothing to import, nowhere to mirror.
    if (store.getPersonalVault(userId)) {
      store.setVaultMirrorHold(userId, "checking");
      store.setVaultMirrorReplaceAll(userId, false);
      migrationLogger.info({ userId, repo, previousRepo }, "knowledge repo changed for a vault in the memory service; mirror on hold (checking) until the new repository is looked at");
      settleAfterRepoChange(store, config, userId, 0);
      return;
    }
    if (store.getPersonalVaultMode() !== "memory" || !memoryClientFor(store, config)) return;
    cutoverAfterRepoChange(store, config, userId, 0);
  } catch (error) {
    migrationLogger.error({ userId, err: error }, "onKnowledgeRepoChanged failed");
  }
}
