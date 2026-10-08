import fs from "node:fs";
import path from "node:path";
import { safeConversationDir } from "./chatImages.js";
import logger from "./logger.js";
import { avatarDir } from "./routes/_shared.js";
import type { Store } from "./store.js";
import type { RetiredPersonalAgentPurge } from "./store/retiredPersonalAgents.js";
import type { AppConfig } from "./types.js";
import { deleteConversationWorkspaceCopies } from "./workspace.js";

/**
 * Boot-time retirement of the removed 내 봇 (personal agents) feature: delete
 * every bot, bot thread, bot routine and everything they left on disk — the old
 * per-bot DELETE cascade applied to all bots at once, plus the bots' SDK
 * session transcripts. Boot calls it right after `createServices()`, before
 * the app is built, the server listens or the routine scheduler starts. The
 * users' `agents/<dir>/` memory folders live in their own knowledge repos and
 * are never touched.
 *
 * LIFECYCLE: it runs on every boot until ONE pass ends with nothing left
 * behind, which stamps the `retired:personal_agents` marker (`app_config`,
 * checked by existence). A boot returns at once only when the marker exists,
 * no pending retries are stored, and neither retired TABLE exists — an older
 * release booted after the stamp re-creates both, and with them bots and
 * bot-bound routines, so finding one runs the full retirement in that same
 * boot (its purge drops the marker; a clean finish stamps it again). That
 * re-run deletes everything under the `personal:` / `personal-` names, so
 * those prefixes, the two table names and `routine_jobs.personal_agent_id` stay
 * reserved FOREVER. A fresh install has nothing to do and is stamped silently
 * on its first boot.
 *
 * DISK FIRST, then the database. Bot avatar images and workspace trees are
 * found by NAME prefix (never through row fields), on every boot that runs.
 * Files only the rows can name — each bot thread's chat media and SDK session
 * artifacts — are swept while those rows exist; whatever of them fails is kept
 * in a PENDING list (relative, exact-shape entries plus session ids whose
 * folders could not be listed), stored in the purge's own transaction and
 * retried on every later boot. The DB purge runs on EVERY pass that finds
 * rows, even when the sweep failed: a bot-bound routine must be gone before
 * the scheduler's first tick whatever the disk did. Any failure withholds the
 * marker (one warning per boot names the paths); the purge throws, failing
 * the boot loudly.
 */
export function retirePersonalAgents(deps: {
  config: AppConfig;
  store: Store;
}): RetiredPersonalAgentPurge | null {
  const { config, store } = deps;
  if (store.personalAgentsRetired()) {
    const tablesBack = store.retiredPersonalAgentTablesExist();
    if (!tablesBack && !store.retiredPersonalAgentPendingExists()) {
      return null;
    }
    if (tablesBack) {
      logger.warn("an older release recreated the retired personal-agent tables — retiring again");
    }
  }
  const sweep: SweepTally = { failures: 0, sample: [] };
  const pending = readPending(config, store);
  const next: PendingRetries = { paths: new Set(), sessionIds: new Set() };
  for (const rel of pending.paths) {
    removeRowKeyed(config, rel, sweep, next);
  }
  const snapshot = store.snapshotRetiredPersonalAgents();
  const conversationIds = snapshot?.conversationIds ?? [];
  for (const conversationId of conversationIds) {
    const dir = safeConversationDir(conversationId);
    removeRowKeyed(config, `chat-images/${dir}`, sweep, next);
    removeRowKeyed(config, `chat-files/${dir}`, sweep, next);
  }
  // Server-written copies (attachments/captures/confluence) are resolved by
  // thread id under EVERY avatar folder; best-effort, never throws. A bot
  // thread's own workspace goes with its bot tree below.
  deleteConversationWorkspaceCopies(config, conversationIds);
  const projectsRoot = path.join(config.agentSessionsDir, "projects");
  const projectEntries = listEntries(projectsRoot, sweep);
  const sessionIds = new Set([...(snapshot?.sessionIds ?? []).filter(isSessionId), ...pending.sessionIds]);
  sweepSessionArtifacts(config, [...sessionIds], projectEntries, sweep, next);
  sweepPrefixedLeftovers(config, projectEntries, sweep);
  const pendingDocument = serializePending(next);
  const purge = snapshot ? store.purgeRetiredPersonalAgents(pendingDocument) : null;
  if (purge) {
    logger.warn({ ...purge }, "retired personal-agent data purged");
  }
  if (sweep.failures === 0) {
    guarded(
      "completion marker could not be stamped; the next boot repeats this (now cheap) pass",
      () => store.completePersonalAgentRetirement(new Date().toISOString()),
    );
    return purge;
  }
  if (!snapshot) {
    // Only rows a previous boot already purged can be pending here, so a
    // failed write leaves that boot's list — a superset of this one — in place.
    guarded(
      "pending retries could not be updated; the next boot retries the previous list",
      () => store.saveRetiredPersonalAgentPending(pendingDocument),
    );
  }
  logger.warn(
    { failures: sweep.failures, paths: sweep.sample },
    "retired personal-agent files could not be removed; the retirement marker was NOT stamped, so the next boot retries — remove these paths by hand if this repeats",
  );
  return purge;
}

/** A bot's avatar id always starts with this; so does its profile-image file. */
const BOT_AVATAR_PREFIX = "personal:";
/** `workspaceDirFor` turns that id into a folder name starting with this. */
const BOT_WORKSPACE_PREFIX = "personal-";
/** An SDK session id as the CLI mints it; anything else is never joined into a path. */
const SESSION_ID = /^[0-9a-f-]{36}$/i;
/** How many failed paths the warning names. */
const FAILED_PATH_SAMPLE = 20;
/** Version tag of the stored pending document. */
const PENDING_VERSION = 1;

interface SweepTally {
  failures: number;
  /** The first FAILED_PATH_SAMPLE failed paths, each with its error code. */
  sample: string[];
}

/**
 * What a later boot must retry: exact-shape paths RELATIVE to their root (see
 * resolveRowKeyed), so a remounted data volume still resolves them, and the
 * session ids whose folders could not be listed (their whole pass re-runs).
 */
interface PendingRetries {
  paths: Set<string>;
  sessionIds: Set<string>;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

function recordFailure(sweep: SweepTally, target: string, code: string | undefined): void {
  sweep.failures += 1;
  if (sweep.sample.length < FAILED_PATH_SAMPLE) {
    sweep.sample.push(`${target} (${code ?? "error"})`);
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

function isPermissionError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "EACCES" || code === "EPERM";
}

/** A failed bookkeeping write only costs a cheap re-run; it never fails the boot. */
function guarded(consequence: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    logger.warn({ err }, `retired personal-agent ${consequence}`);
  }
}

/**
 * Remove `target` — a file, a link (unlinked, never followed) or a whole tree —
 * when it exists; true when it is gone. A read-only directory inside a tree
 * (what `go mod download` leaves behind) makes every unlink in it fail with
 * EACCES, so on a permission error the target and every real directory below
 * it are made owner-writable and the removal is retried once. Anything still
 * in place counts as a failure.
 */
function removeRetired(target: string, sweep: SweepTally): boolean {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(target, { throwIfNoEntry: false });
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
    return false;
  }
  if (!stat) {
    return true;
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (!stat.isDirectory() || !isPermissionError(err)) {
      recordFailure(sweep, target, errorCode(err));
      return false;
    }
  }
  grantOwnerAccess(target);
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (err) {
    recordFailure(sweep, target, errorCode(err));
    return false;
  }
}

/**
 * Add u+rwx to `dir` ITSELF and to every real directory below it, each BEFORE
 * it is read (a 0000 or 0444 folder cannot even be listed). Every entry is
 * lstat-checked first and a link is never chmodded or descended into:
 * chmodSync follows links, and Node has no lchmod on Linux, so following one
 * could rewrite the mode of a folder outside the bot tree. Nothing above `dir`
 * is touched. Best-effort: the retried removal is what decides success.
 */
function grantOwnerAccess(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      return;
    }
    fs.chmodSync(dir, (stat.mode & 0o7777) | 0o700);
  } catch {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      grantOwnerAccess(path.join(dir, entry.name));
    }
  }
}

/**
 * The entries of `dir` ([] when it does not exist). Any other listing error
 * counts as a failure and yields null, so a folder that cannot be read never
 * lets the marker be stamped.
 */
function listEntries(dir: string, sweep: SweepTally): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return [];
    }
    recordFailure(sweep, dir, code);
    return null;
  }
}

/** One path segment that cannot climb out of its folder. */
function isPlainSegment(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
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
function resolveRowKeyed(
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
 * Remove one row-keyed entry; a failure keeps it in `next` for the next boot.
 * The target's existence is checked first (an entry already gone is done),
 * then every folder between the root and it must be a REAL directory — a link
 * there would send a valid-looking path somewhere else, so it is refused and
 * kept pending until someone looks.
 */
function removeRowKeyed(
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
  if (!removeRetired(resolved.target, sweep)) {
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

/**
 * The pending retries a previous boot stored, validated entry by entry: a
 * malformed one is dropped with a warning, and an undecryptable or garbled
 * document (a SESSION_SECRET rotation, a hand edit) counts as empty with a
 * warning that row-keyed leftovers may remain — it is replaced when this pass
 * stores its own.
 */
function readPending(config: AppConfig, store: Store): { paths: string[]; sessionIds: string[] } {
  const empty = { paths: [], sessionIds: [] };
  let state: ReturnType<Store["retiredPersonalAgentPendingState"]>;
  try {
    state = store.retiredPersonalAgentPendingState();
  } catch (err) {
    logger.warn({ err }, "retired personal-agent pending retries could not be read; files only the purged rows named may remain");
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
      "retired personal-agent pending retries are unreadable and were discarded; files only the purged rows named may remain on disk",
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
    logger.warn({ dropped }, "malformed retired personal-agent pending retries were dropped");
  }
  return { paths, sessionIds };
}

/** The pending document to store, or null when nothing is left to retry. */
function serializePending(next: PendingRetries): string | null {
  if (next.paths.size === 0 && next.sessionIds.size === 0) {
    return null;
  }
  return JSON.stringify({ v: PENDING_VERSION, paths: [...next.paths], sessionIds: [...next.sessionIds] });
}

/**
 * The bots' SDK session artifacts under the CLI's config dir
 * (`CLAUDE_CONFIG_DIR` = `config.agentSessionsDir`), keyed by session id: a bot
 * thread that opened a work repo ran in the owner's shared clone, so its
 * transcripts sit in a project folder shared with the owner's own sessions —
 * which is why only these exact entries go, never the folder. Each real
 * project folder is read ONCE and its entries matched against the id set
 * (links are never read). A folder that cannot be listed counts as a failure
 * and its ids go pending, so the whole pass re-runs for them.
 */
function sweepSessionArtifacts(
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
        removeRowKeyed(config, `agent-sessions/projects/${project.name}/${entry.name}`, sweep, next);
      }
    }
  }
  for (const id of ids) {
    removeRowKeyed(config, `agent-sessions/session-env/${id}`, sweep, next);
    removeRowKeyed(config, `agent-sessions/tasks/${id}`, sweep, next);
    removeRowKeyed(config, `agent-sessions/file-history/${id}`, sweep, next);
    removeRowKeyed(config, `agent-sessions/debug/${id}.txt`, sweep, next);
  }
  const todos = listEntries(path.join(config.agentSessionsDir, "todos"), sweep);
  if (todos === null) {
    incomplete = true;
  }
  for (const entry of todos ?? []) {
    if (idSet.has(entry.name.slice(0, 36))) {
      removeRowKeyed(config, `agent-sessions/todos/${entry.name}`, sweep, next);
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
 * gone, so whatever a failed sweep left is retried until it goes. Only a bot id
 * carries these prefixes: user ids are UUIDs and every other namespaced avatar
 * uses its own (`external:`, `group:`). A link is unlinked, never followed.
 */
function sweepPrefixedLeftovers(
  config: AppConfig,
  projectEntries: fs.Dirent[] | null,
  sweep: SweepTally,
): void {
  const avatars = avatarDir(config);
  for (const entry of listEntries(avatars, sweep) ?? []) {
    if (entry.name.startsWith(BOT_AVATAR_PREFIX)) {
      removeRetired(path.join(avatars, entry.name), sweep);
    }
  }
  const workspacesRoot = path.resolve(config.dataDir, "workspaces");
  for (const entry of listEntries(workspacesRoot, sweep) ?? []) {
    if (entry.name.startsWith(BOT_WORKSPACE_PREFIX)) {
      removeRetired(path.join(workspacesRoot, entry.name), sweep);
    }
  }
  // SDK project folders of runs whose cwd was a bot workspace — including a
  // run that died before recording any session id. The CLI encodes the
  // PHYSICAL cwd, so both spellings of the workspaces root are tried; a wrong
  // guess can only fail to match, never match a folder that is not a bot's
  // (no other cwd lives under `<workspaces>/personal-…`).
  const roots = new Set([workspacesRoot]);
  try {
    roots.add(fs.realpathSync(workspacesRoot));
  } catch {
    // No workspaces folder yet: nothing ran there.
  }
  const projectsRoot = path.join(config.agentSessionsDir, "projects");
  const prefixes = [...roots].map((root) => `${encodeProjectDir(root)}-${BOT_WORKSPACE_PREFIX}`);
  for (const entry of projectEntries ?? []) {
    if (prefixes.some((prefix) => entry.name.startsWith(prefix))) {
      removeRetired(path.join(projectsRoot, entry.name), sweep);
    }
  }
}
