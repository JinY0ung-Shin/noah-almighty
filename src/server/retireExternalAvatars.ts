import fs from "node:fs";
import path from "node:path";
import { safeConversationDir } from "./chatImages.js";
import logger from "./logger.js";
import {
  errorCode,
  isPlainSegment,
  listEntries,
  recordFailure,
  removeRetired,
  type SweepTally,
} from "./retiredFiles.js";
import { avatarDir } from "./routes/_shared.js";
import type { Store } from "./store.js";
import type { RetiredExternalAvatarPurge } from "./store/retiredExternalAvatars.js";
import type { AppConfig } from "./types.js";
import { deleteConversationWorkspaceCopies } from "./workspace.js";

/**
 * Boot-time retirement of the removed external avatars (removed 2026-10-29,
 * pi migration decision D4: their history is deleted, not kept): every
 * `external:` conversation with its messages, canvases, share links and media,
 * the admin-managed registry with its gateway API keys, the profile-image table
 * and the image files. Boot calls it right after the personal-agent
 * retirement, before the app is built or the server listens.
 *
 * LIFECYCLE: it runs on every boot until ONE pass ends with nothing left
 * behind, which stamps the `retired:external_avatars` marker (`app_config`,
 * checked by existence). A boot returns at once only when the marker exists,
 * no pending retries are stored, and the retired `external_avatar_images`
 * table does not exist — an older release booted after the stamp re-creates
 * it (and could write new external threads), so finding it runs the full
 * retirement in that same boot. That re-run deletes everything under the
 * `external:` / `external-` names, so those prefixes stay reserved FOREVER. A
 * fresh install has nothing to do and is stamped silently on its first boot.
 *
 * DISK FIRST, then the database. Avatar image files (`avatars/external:<id>.*`)
 * and workspace trees (`workspaces/external-…`; external turns never created
 * one, swept by name in case an old build did) are found by NAME prefix, on
 * every boot that runs. Each thread's chat media (`chat-images/<dir>`,
 * `chat-files/<dir>`) can only be named through its row, so it is swept while
 * the rows exist and whatever fails is kept in a PENDING list (the folder
 * names), stored in the purge's own transaction and retried on every later
 * boot. The DB purge runs on every pass that finds rows, even when the sweep
 * failed: the history must go whatever the disk did. Any failure withholds the
 * marker (one warning per boot names the paths); the purge throws, failing the
 * boot loudly.
 *
 * `EXTERNAL_AGENTS_JSON` is no longer read; while it is still set every boot
 * logs one warning that it is ignored.
 */
export function retireExternalAvatars(deps: {
  config: AppConfig;
  store: Store;
  env?: Record<string, string | undefined>;
}): RetiredExternalAvatarPurge | null {
  const { config, store } = deps;
  if ((deps.env ?? process.env).EXTERNAL_AGENTS_JSON?.trim()) {
    logger.warn(
      "EXTERNAL_AGENTS_JSON is set but ignored: external avatars were removed — delete it from the deployment environment",
    );
  }
  if (store.externalAvatarsRetired()) {
    const tableBack = store.retiredExternalAvatarTableExists();
    if (!tableBack && !store.retiredExternalAvatarPendingExists()) {
      return null;
    }
    if (tableBack) {
      logger.warn("an older release recreated the retired external-avatar table — retiring again");
    }
  }
  const sweep: SweepTally = { failures: 0, sample: [] };
  const next = new Set<string>();
  const snapshot = store.snapshotRetiredExternalAvatars();
  const conversationIds = snapshot?.conversationIds ?? [];
  const mediaDirs = new Set([...readPending(store), ...conversationIds.map(safeConversationDir)]);
  removeMedia(config, mediaDirs, sweep, next);
  // Server-written workspace copies, resolved by thread id under EVERY avatar
  // folder; best-effort, never throws.
  deleteConversationWorkspaceCopies(config, conversationIds);
  sweepPrefixedLeftovers(config, sweep);
  const pendingDocument = serializePending(next);
  const purge = snapshot ? store.purgeRetiredExternalAvatars(pendingDocument) : null;
  if (purge) {
    logger.warn({ ...purge }, "retired external-avatar data purged");
  }
  if (sweep.failures === 0) {
    guarded(
      "completion marker could not be stamped; the next boot repeats this (now cheap) pass",
      () => store.completeExternalAvatarRetirement(new Date().toISOString()),
    );
    return purge;
  }
  if (!snapshot) {
    // Only rows a previous boot already purged can be pending here, so a
    // failed write leaves that boot's list — a superset of this one — in place.
    guarded(
      "pending retries could not be updated; the next boot retries the previous list",
      () => store.saveRetiredExternalAvatarPending(pendingDocument),
    );
  }
  logger.warn(
    { failures: sweep.failures, paths: sweep.sample },
    "retired external-avatar files could not be removed; the retirement marker was NOT stamped, so the next boot retries — remove these paths by hand if this repeats",
  );
  return purge;
}

/** An external avatar id always starts with this; so does its profile-image file. */
const EXTERNAL_AVATAR_PREFIX = "external:";
/** `workspaceDirFor` turns that id into a folder name starting with this. */
const EXTERNAL_WORKSPACE_PREFIX = "external-";
/** Version tag of the stored pending document. */
const PENDING_VERSION = 1;
/** The two per-conversation media roots under `dataDir`. */
const MEDIA_ROOTS = ["chat-images", "chat-files"] as const;

/** A failed bookkeeping write only costs a cheap re-run; it never fails the boot. */
function guarded(consequence: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    logger.warn({ err }, `retired external-avatar ${consequence}`);
  }
}

/** A conversation media folder name exactly as `safeConversationDir` mints it. */
function isMediaDir(dir: unknown): dir is string {
  return typeof dir === "string" && isPlainSegment(dir) && safeConversationDir(dir) === dir;
}

/**
 * Remove the threads' media folders; a failure keeps the folder name in
 * `next`. Each root is listed ONCE and must be a REAL directory — a link there
 * would send the folder names somewhere else, so it is refused and every name
 * is kept pending until someone looks.
 */
function removeMedia(config: AppConfig, dirs: Set<string>, sweep: SweepTally, next: Set<string>): void {
  if (dirs.size === 0) {
    return;
  }
  for (const head of MEDIA_ROOTS) {
    const root = path.join(config.dataDir, head);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(root, { throwIfNoEntry: false });
    } catch (err) {
      recordFailure(sweep, root, errorCode(err));
      dirs.forEach((dir) => next.add(dir));
      continue;
    }
    if (!stat) {
      continue;
    }
    const entries = stat.isDirectory() ? listEntries(root, sweep) : null;
    if (entries === null) {
      if (!stat.isDirectory()) recordFailure(sweep, root, "NOT_A_FOLDER");
      dirs.forEach((dir) => next.add(dir));
      continue;
    }
    const present = new Set(entries.map((entry) => entry.name));
    for (const dir of dirs) {
      if (present.has(dir) && !removeRetired(path.join(root, dir), sweep)) {
        next.add(dir);
      }
    }
  }
}

/**
 * The pending folder names a previous boot stored, validated entry by entry;
 * an undecryptable or garbled document (a SESSION_SECRET rotation, a hand
 * edit) counts as empty with a warning — it is replaced when this pass stores
 * its own.
 */
function readPending(store: Store): string[] {
  let state: ReturnType<Store["retiredExternalAvatarPendingState"]>;
  try {
    state = store.retiredExternalAvatarPendingState();
  } catch (err) {
    logger.warn({ err }, "retired external-avatar pending retries could not be read; media of purged threads may remain");
    return [];
  }
  if (state.status === "missing") {
    return [];
  }
  let parsed: unknown = null;
  if (state.status === "ok") {
    try {
      parsed = JSON.parse(state.value);
    } catch {
      parsed = null;
    }
  }
  const document = parsed as { v?: unknown; dirs?: unknown } | null;
  if (!document || typeof document !== "object" || document.v !== PENDING_VERSION || !Array.isArray(document.dirs)) {
    logger.warn(
      { status: state.status },
      "retired external-avatar pending retries are unreadable and were discarded; media of purged threads may remain on disk",
    );
    return [];
  }
  const dirs = document.dirs.filter(isMediaDir);
  if (dirs.length !== document.dirs.length) {
    logger.warn("malformed retired external-avatar pending retries were dropped");
  }
  return dirs;
}

/** The pending document to store, or null when nothing is left to retry. */
function serializePending(next: Set<string>): string | null {
  return next.size === 0 ? null : JSON.stringify({ v: PENDING_VERSION, dirs: [...next] });
}

/**
 * Leftovers found by NAME, on every boot that runs: profile images and
 * workspace trees. Only an external id carries these prefixes: user ids are
 * UUIDs (a UUID can never start with `external`) and every other namespaced
 * avatar uses its own (the retired `group:` / `personal:`). A link is unlinked,
 * never followed.
 */
function sweepPrefixedLeftovers(config: AppConfig, sweep: SweepTally): void {
  const avatars = avatarDir(config);
  for (const entry of listEntries(avatars, sweep) ?? []) {
    if (entry.name.startsWith(EXTERNAL_AVATAR_PREFIX)) {
      removeRetired(path.join(avatars, entry.name), sweep);
    }
  }
  const workspacesRoot = path.resolve(config.dataDir, "workspaces");
  for (const entry of listEntries(workspacesRoot, sweep) ?? []) {
    if (entry.name.startsWith(EXTERNAL_WORKSPACE_PREFIX)) {
      removeRetired(path.join(workspacesRoot, entry.name), sweep);
    }
  }
}
