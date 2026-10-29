import fs from "node:fs";
import path from "node:path";
import { safeConversationDir } from "./chatImages.js";
import logger from "./logger.js";
import {
  errorCode,
  isPlainSegment,
  listEntries,
  newSweep,
  quarantineRetired,
  recordFailure,
  type SweepTally,
} from "./retiredFiles.js";
import { avatarDir } from "./routes/_shared.js";
import type { AppConfig } from "./types.js";
import { SERVER_WORKSPACE_COPY_DIRS, workspaceDirFor } from "./workspace.js";

/**
 * Row-keyed disk primitives shared by the boot-time retirements of removed
 * avatar KINDS whose threads ran on the local SDK (`retirePersonalAgents.ts`,
 * `retireGroupAgents.ts`): each thread's chat media and SDK session artifacts
 * can only be named through its rows, so they are QUARANTINED (moved under
 * `retired/<stamp>/`, never deleted — `retiredFiles.ts`) while the rows exist
 * and whatever fails is kept in a PENDING document (relative, exact-shape
 * paths plus session ids whose folders could not be listed) that later boots
 * retry. Plus the NAME-prefix sweep of the kind's avatar images, workspace
 * trees and the SDK project folders of runs whose cwd was one of those trees.
 * Nothing here throws.
 */

/** An SDK session id as the CLI mints it; anything else is never joined into a path. */
const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** Version tag of the stored pending document. */
const PENDING_VERSION = 1;

/**
 * What a later boot must retry: exact-shape paths RELATIVE to their root (see
 * resolveRowKeyed), so a remounted data volume still resolves them, and the
 * session ids whose folders could not be listed (their whole pass re-runs).
 */
export interface PendingRetries {
  paths: Set<string>;
  sessionIds: Set<string>;
}


export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/**
 * Resolve a ROW-KEYED entry — a relative path in one of the exact shapes this
 * module writes — to its absolute target plus the folders between the root
 * and it, or null when it is anything else (absolute, empty, `.`/`..`, an
 * unknown folder, a bare `chat-images`, a non-uuid session name). The roots
 * come from the CURRENT config, never from the stored text:
 *   chat-images/<conversation dir>, chat-files/<conversation dir>   (dataDir)
 *   agent-sessions/projects/<project>/<uuid>[.jsonl],
 *   agent-sessions/{session-env,tasks,file-history}/<uuid>,
 *   agent-sessions/debug/<uuid>.txt, agent-sessions/todos/<uuid>…   (agentSessionsDir)
 */
export function resolveRowKeyed(
  config: AppConfig,
  rel: string,
): { target: string; ancestors: string[] } | null {
  const [head, ...rest] = rel.split("/");
  if (head === "chat-images" || head === "chat-files") {
    const [dir] = rest;
    if (rest.length !== 1 || !isPlainSegment(dir) || safeConversationDir(dir) !== dir) {
      return null;
    }
    const root = path.join(config.dataDir, head);
    return { target: path.join(root, dir), ancestors: [root] };
  }
  if (head !== "agent-sessions") {
    return null;
  }
  const [area, ...tail] = rest;
  const areaDir = path.join(config.agentSessionsDir, area ?? "");
  if (area === "projects") {
    const [project, name] = tail;
    if (tail.length !== 2 || !isPlainSegment(project) || !isPlainSegment(name)) {
      return null;
    }
    if (!isSessionId(name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name)) {
      return null;
    }
    const projectDir = path.join(areaDir, project);
    return { target: path.join(projectDir, name), ancestors: [areaDir, projectDir] };
  }
  const [name] = tail;
  if (tail.length !== 1 || !isPlainSegment(name)) {
    return null;
  }
  const valid =
    area === "session-env" || area === "tasks" || area === "file-history"
      ? isSessionId(name)
      : area === "debug"
        ? name.endsWith(".txt") && isSessionId(name.slice(0, -".txt".length))
        : area === "todos"
          ? isSessionId(name.slice(0, 36))
          : false;
  return valid ? { target: path.join(areaDir, name), ancestors: [areaDir] } : null;
}

/**
 * Quarantine one row-keyed entry; a failure (EXDEV included) keeps it in
 * `next` for the next boot.
 * The target's existence is checked first (an entry already gone is done),
 * then every folder between the root and it must be a REAL directory — a link
 * there would send a valid-looking path somewhere else, so it is refused and
 * kept pending until someone looks.
 */
export function quarantineRowKeyed(
  config: AppConfig,
  rel: string,
  sweep: SweepTally,
  next: PendingRetries,
): void {
  const resolved = resolveRowKeyed(config, rel);
  if (!resolved) {
    return;
  }
  try {
    if (!targetExists(resolved.target)) {
      return;
    }
    for (const ancestor of resolved.ancestors) {
      if (!fs.lstatSync(ancestor).isDirectory()) {
        recordFailure(sweep, resolved.target, "ANCESTOR_NOT_A_FOLDER");
        next.paths.add(rel);
        return;
      }
    }
  } catch (err) {
    recordFailure(sweep, resolved.target, errorCode(err));
    next.paths.add(rel);
    return;
  }
  if (!quarantineRetired(resolved.target, sweep)) {
    next.paths.add(rel);
  }
}

/** Whether `target` exists (a missing or non-folder ancestor means it cannot). */
function targetExists(target: string): boolean {
  try {
    return Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
  } catch (err) {
    if (errorCode(err) === "ENOTDIR") {
      return false;
    }
    throw err;
  }
}

/** A stored pending document as the store reads it (missing, unreadable, or its text). */
export type PendingState = { status: "missing" } | { status: "unreadable" } | { status: "ok"; value: string };

/**
 * The pending retries a previous boot stored, validated entry by entry: a
 * malformed one is dropped with a warning, and an undecryptable or garbled
 * document (a SESSION_SECRET rotation, a hand edit) counts as empty with a
 * warning that row-keyed leftovers may remain — it is replaced when this pass
 * stores its own.
 */
export function readRowKeyedPending(
  config: AppConfig,
  readState: () => PendingState,
  label: string,
): { paths: string[]; sessionIds: string[] } {
  const empty = { paths: [], sessionIds: [] };
  let state: PendingState;
  try {
    state = readState();
  } catch (err) {
    logger.warn({ err }, `retired ${label} pending retries could not be read; files only the purged rows named may remain`);
    return empty;
  }
  if (state.status === "missing") {
    return empty;
  }
  let parsed: unknown = null;
  if (state.status === "ok") {
    try {
      parsed = JSON.parse(state.value);
    } catch {
      parsed = null;
    }
  }
  const document = parsed as { v?: unknown; paths?: unknown; sessionIds?: unknown } | null;
  if (
    !document ||
    typeof document !== "object" ||
    document.v !== PENDING_VERSION ||
    !Array.isArray(document.paths) ||
    !Array.isArray(document.sessionIds)
  ) {
    logger.warn(
      { status: state.status },
      `retired ${label} pending retries are unreadable and were discarded; files only the purged rows named may remain on disk`,
    );
    return empty;
  }
  const paths: string[] = [];
  const sessionIds: string[] = [];
  const dropped: string[] = [];
  for (const entry of document.paths) {
    if (typeof entry === "string" && resolveRowKeyed(config, entry)) {
      paths.push(entry);
    } else {
      dropped.push(String(entry).slice(0, 200));
    }
  }
  for (const entry of document.sessionIds) {
    if (isSessionId(entry)) {
      sessionIds.push(entry);
    } else {
      dropped.push(String(entry).slice(0, 200));
    }
  }
  if (dropped.length) {
    logger.warn({ dropped }, `malformed retired ${label} pending retries were dropped`);
  }
  return { paths, sessionIds };
}


/** The pending document to store, or null when nothing is left to retry. */
export function serializePending(next: PendingRetries): string | null {
  if (next.paths.size === 0 && next.sessionIds.size === 0) {
    return null;
  }
  return JSON.stringify({ v: PENDING_VERSION, paths: [...next.paths], sessionIds: [...next.sessionIds] });
}

/**
 * The retired threads' SDK session artifacts under the CLI's config dir
 * (`CLAUDE_CONFIG_DIR` = `config.agentSessionsDir`), keyed by session id: a
 * thread that opened a work repo ran in the owner's shared clone, so its
 * transcripts sit in a project folder shared with the owner's own sessions —
 * which is why only these exact entries go, never the folder. Each real
 * project folder is read ONCE and its entries matched against the id set
 * (links are never read). A folder that cannot be listed counts as a failure
 * and its ids go pending, so the whole pass re-runs for them.
 */
export function sweepSessionArtifacts(
  config: AppConfig,
  ids: string[],
  projectEntries: fs.Dirent[] | null,
  sweep: SweepTally,
  next: PendingRetries,
): void {
  if (ids.length === 0) {
    return;
  }
  const idSet = new Set(ids);
  let incomplete = projectEntries === null;
  for (const project of projectEntries ?? []) {
    if (!project.isDirectory()) {
      continue;
    }
    const entries = listEntries(path.join(config.agentSessionsDir, "projects", project.name), sweep);
    if (entries === null) {
      incomplete = true;
      continue;
    }
    for (const entry of entries) {
      const id = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : entry.name;
      if (idSet.has(id)) {
        quarantineRowKeyed(config, `agent-sessions/projects/${project.name}/${entry.name}`, sweep, next);
      }
    }
  }
  for (const id of ids) {
    quarantineRowKeyed(config, `agent-sessions/session-env/${id}`, sweep, next);
    quarantineRowKeyed(config, `agent-sessions/tasks/${id}`, sweep, next);
    quarantineRowKeyed(config, `agent-sessions/file-history/${id}`, sweep, next);
    quarantineRowKeyed(config, `agent-sessions/debug/${id}.txt`, sweep, next);
  }
  const todos = listEntries(path.join(config.agentSessionsDir, "todos"), sweep);
  if (todos === null) {
    incomplete = true;
  }
  for (const entry of todos ?? []) {
    if (idSet.has(entry.name.slice(0, 36))) {
      quarantineRowKeyed(config, `agent-sessions/todos/${entry.name}`, sweep, next);
    }
  }
  if (incomplete) {
    for (const id of ids) {
      next.sessionIds.add(id);
    }
  }
}


/** The CLI's project-folder name for a cwd (it also truncates past 200 chars). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Leftovers found by NAME, on every boot that runs — also once the rows are
 * gone, so whatever a failed sweep left is retried until it goes: profile
 * images starting with `avatarPrefix`, workspace trees starting with
 * `workspacePrefix`, and the SDK project folders of runs whose cwd was one of
 * those trees — including a run that died before recording any session id.
 * The caller's prefixes must belong to ONE retired namespace only (user ids are
 * UUIDs; every namespaced avatar kind has its own). Each is quarantined; a link
 * is moved as a link, never followed.
 */
export function sweepNamedLeftovers(
  config: AppConfig,
  prefixes: { avatarPrefix: string; workspacePrefix: string },
  projectEntries: fs.Dirent[] | null,
  sweep: SweepTally,
): void {
  const avatars = avatarDir(config);
  for (const entry of listEntries(avatars, sweep) ?? []) {
    if (entry.name.startsWith(prefixes.avatarPrefix)) {
      quarantineRetired(path.join(avatars, entry.name), sweep);
    }
  }
  const workspacesRoot = path.resolve(config.dataDir, "workspaces");
  for (const entry of listEntries(workspacesRoot, sweep) ?? []) {
    if (entry.name.startsWith(prefixes.workspacePrefix)) {
      quarantineRetired(path.join(workspacesRoot, entry.name), sweep);
    }
  }
  // The CLI encodes the PHYSICAL cwd, so both spellings of the workspaces root
  // are tried; a wrong guess can only fail to match, never match a folder that
  // is not this namespace's (no other cwd lives under
  // `<workspaces>/<workspacePrefix>…`).
  const roots = new Set([workspacesRoot]);
  try {
    roots.add(fs.realpathSync(workspacesRoot));
  } catch {
    // No workspaces folder yet: nothing ran there.
  }
  const projectsRoot = path.join(config.agentSessionsDir, "projects");
  const projectPrefixes = [...roots].map((root) => `${encodeProjectDir(root)}-${prefixes.workspacePrefix}`);
  for (const entry of projectEntries ?? []) {
    if (projectPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
      quarantineRetired(path.join(projectsRoot, entry.name), sweep);
    }
  }
}

/**
 * The retirement form of `deleteConversationWorkspaceCopies`: QUARANTINE the
 * server-written copies (`SERVER_WORKSPACE_COPY_DIRS`) of retired threads,
 * resolved by thread id under EVERY real avatar folder of `workspaces/` (a
 * link there is skipped, a link named like a copy folder is moved as a link).
 * Best effort with its own tally, like the delete it replaces: a copy that
 * cannot be moved (EXDEV included) stays in place and is named in one warning,
 * never deleted and never holding the marker. Run it AFTER the name-prefix
 * sweep, so copies inside a retired avatar's own tree travel with that tree.
 * The pi runtime's sandbox copies (`PI_WORKSPACES_DIR`, outside `dataDir`) are
 * left in place: no released build ran a retired kind on pi.
 */
export function quarantineConversationWorkspaceCopies(
  config: AppConfig,
  conversationIds: readonly string[],
  sweep: SweepTally,
): void {
  if (conversationIds.length === 0) {
    return;
  }
  const tally = newSweep(sweep.quarantine);
  // The conversation segment depends on the id alone (`workspaceDirFor`).
  const segments = new Set(conversationIds.map((id) => path.basename(workspaceDirFor(config, "avatar", id))));
  const root = path.join(config.dataDir, "workspaces");
  for (const avatar of listEntries(root, tally) ?? []) {
    if (!avatar.isDirectory()) {
      continue;
    }
    const avatarPath = path.join(root, avatar.name);
    for (const entry of listEntries(avatarPath, tally) ?? []) {
      if (!entry.isDirectory() || !segments.has(entry.name)) {
        continue;
      }
      for (const name of SERVER_WORKSPACE_COPY_DIRS) {
        quarantineRetired(path.join(avatarPath, entry.name, name), tally);
      }
    }
  }
  if (tally.failures > 0) {
    logger.warn(
      { failures: tally.failures, paths: tally.sample },
      "server-written workspace copies of retired threads could not be quarantined and were left in place",
    );
  }
}
