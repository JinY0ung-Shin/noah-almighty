/**
 * File mirroring between a conversation's scratch workspace and its Craft
 * session's exchange folders (Craft apps, admin-only beta):
 *
 *   workspace attachments/ captures/ confluence/ craft/out/
 *        └─ mirrorWorkspaceToInbox ─▶ inbox/<sid>/attachments/ … craft-out/
 *   stageWorkspaceFile (one file)  ─▶ inbox/<sid>/staged/
 *   outbox/<sid>/** ─ mirrorOutboxToWorkspace ─▶ workspace craft/out/** (ADDITIVE)
 *
 * The runner then mirrors inbox → `work/<sid>/in/` (`sync_in`) and
 * `work/<sid>/out/` → outbox (`sync_out`) with the same rules on its side.
 *
 * BOTH ends of every copy are directories the agent's own shell can write
 * (the workspace, and the exchange volume, which is mounted in this container
 * and owned by the same uid), so nothing here trusts a path: every entry is
 * lstat'ed and only REGULAR files are copied (symlinks, FIFOs, sockets and
 * devices are rejected and reported, never opened); sources open with
 * O_NOFOLLOW|O_NONBLOCK and are re-checked with fstat; destinations are created
 * exclusively (O_EXCL|O_NOFOLLOW) under a temp name and renamed into place;
 * and the kernel's own path of every opened descriptor (/proc/self/fd) must lie
 * inside the root it was resolved under — a parent directory swapped for a
 * link between the check and the open is caught there. Caps bound one mirror:
 * {@link CRAFT_MAX_FILE_BYTES} per file, {@link CRAFT_MAX_TOTAL_BYTES} and
 * {@link CRAFT_MAX_FILES} per tree.
 *
 * Everything here is ASYNC (Addendum A4): a mirror can move up to 1 GiB and
 * runs on the request path of a chat turn, so no copy, walk or removal may
 * block Noah's event loop. Every walk is ITERATIVE (an explicit queue, never
 * recursion) and depth-capped at {@link CRAFT_MAX_DEPTH}: deeper entries are
 * reported `too_deep`, never followed, and never fail the rest of the walk.
 *
 * Incremental: a destination file with the source's size and mtime is left
 * alone; the copy carries the source mtime. The INBOX mirror removes files
 * absent from the source from its mirrored subtrees (never from `staged/`,
 * which is cleared at the start of every run instead). The WORKSPACE mirror
 * (`craft/out/`) is ADDITIVE — copy and overwrite only, never delete: an empty
 * outbox after the runner's idle GC, a rebuilt session or a recreated volume
 * must never wipe the results the user already has. Because nothing is ever
 * pruned there, that mirror is capped as a WHOLE (Addendum B N2): what
 * `craft/out/` already holds plus what a mirror adds stays within
 * {@link CRAFT_WORKSPACE_OUT_MAX_BYTES}; further files are skipped and reported
 * `workspace_cap`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const CRAFT_MAX_FILE_BYTES = 200 * 1024 * 1024;
export const CRAFT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const CRAFT_MAX_FILES = 2000;
/** Depth cap of every walk (Addendum A4) — the runner uses the same number. */
export const CRAFT_MAX_DEPTH = 32;
/** Max UTF-8 bytes of a staged file name (the runner rejects names over 255 bytes). */
export const CRAFT_STAGED_NAME_MAX_BYTES = 200;
/** Cap of the workspace's whole `craft/out/` (Addendum B N2): the additive mirror never grows it past this. */
export const CRAFT_WORKSPACE_OUT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** The caps of one mirror (overridable for tests only). */
export interface CraftLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}
export const CRAFT_LIMITS: CraftLimits = {
  maxFileBytes: CRAFT_MAX_FILE_BYTES,
  maxTotalBytes: CRAFT_MAX_TOTAL_BYTES,
  maxFiles: CRAFT_MAX_FILES,
};

interface Budget {
  files: number;
  bytes: number;
  limits: CraftLimits;
}
const TEMP_PREFIX = ".craft-tmp-";
const COPY_CHUNK = 1024 * 1024;

/** Workspace folder → inbox folder, in mirror order. */
export const CRAFT_INBOX_MAPPINGS: readonly { workspace: string; inbox: string }[] = [
  { workspace: "attachments", inbox: "attachments" },
  { workspace: "captures", inbox: "captures" },
  { workspace: "confluence", inbox: "confluence" },
  { workspace: path.join("craft", "out"), inbox: "craft-out" },
];
/** The workspace folder outbox files land in (relative to the workspace). */
export const CRAFT_WORKSPACE_OUT_DIR = path.join("craft", "out");
/** The inbox folder `mcp__craft_files__stage` copies into. */
export const CRAFT_STAGED_DIR = "staged";

export type CraftRejectReason =
  | "symlink"
  | "not_regular"
  | "too_large"
  | "total_cap"
  | "count_cap"
  | "too_deep"
  | "escaped"
  | "changed"
  | "io_error"
  /** The workspace's `craft/out/` is at {@link CRAFT_WORKSPACE_OUT_MAX_BYTES}. */
  | "workspace_cap";

export interface CraftMirrorReport {
  copied: number;
  removed: number;
  /** Already up to date (same size + mtime). */
  skipped: number;
  /** Bytes of every source file kept in the mirror (copied or up to date). */
  bytes: number;
  rejected: { path: string; reason: CraftRejectReason }[];
}

function emptyReport(): CraftMirrorReport {
  return { copied: 0, removed: 0, skipped: 0, bytes: 0, rejected: [] };
}

/** The kernel's path of an open descriptor (Linux /proc), or null when unavailable. */
async function descriptorPath(fd: number): Promise<string | null> {
  try {
    return await fsp.readlink(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fsp.realpath(target);
  } catch {
    return null;
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

/** A real directory at `target` (a link to one does not count). */
async function isRealDir(target: string): Promise<boolean> {
  return (await lstatOrNull(target))?.isDirectory() ?? false;
}

/**
 * Remove `target` without following links: a file or link is unlinked, a
 * directory is emptied ITERATIVELY (depth-capped at {@link CRAFT_MAX_DEPTH}
 * below `target`) and removed bottom-up. Never throws; resolves to the number
 * of entries it had to leave (too deep or not removable) — 0 = gone.
 *
 * Every entry here is owned by Noah's own uid, which the agent's shell shares;
 * a directory swapped for a link mid-walk can therefore only make Noah remove
 * files that uid could remove itself.
 */
export async function removeTreeNoFollow(target: string): Promise<number> {
  const top = await lstatOrNull(target);
  if (!top) return 0;
  if (!top.isDirectory()) {
    try {
      await fsp.unlink(target);
      return 0;
    } catch {
      return 1;
    }
  }
  let left = 0;
  const dirs: string[] = [];
  const queue: { abs: string; depth: number }[] = [{ abs: target, depth: 0 }];
  while (queue.length > 0) {
    const { abs, depth } = queue.pop()!;
    dirs.push(abs);
    let names: string[];
    try {
      names = await fsp.readdir(abs);
    } catch {
      left += 1;
      continue;
    }
    for (const name of names) {
      const child = path.join(abs, name);
      const stat = await lstatOrNull(child);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth + 1 > CRAFT_MAX_DEPTH) {
          left += 1; // too deep: never followed
          continue;
        }
        queue.push({ abs: child, depth: depth + 1 });
        continue;
      }
      try {
        await fsp.unlink(child);
      } catch {
        left += 1;
      }
    }
  }
  // Pre-order list reversed = every directory after all of its descendants.
  for (const dir of dirs.reverse()) {
    try {
      await fsp.rmdir(dir);
    } catch {
      // Not empty (something was left inside, already counted) or gone.
    }
  }
  return left;
}

/**
 * Make `rel` (segments under `root`) a chain of REAL directories, replacing any
 * link or file squatting on a segment. Returns the absolute directory, or null.
 * `root` itself must already be a real directory.
 */
async function ensureRealDirChain(root: string, rel: string, mode: number): Promise<string | null> {
  let current = root;
  for (const segment of rel.split(path.sep).filter((part) => part && part !== ".")) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (stat && !stat.isDirectory()) await removeTreeNoFollow(current);
    if (!stat || !stat.isDirectory()) {
      try {
        await fsp.mkdir(current, { mode });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      }
    }
    if (!(await isRealDir(current))) return null;
  }
  return current;
}

interface SourceFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Collect the regular files under `srcRoot` (lstat walk, links never
 * followed, iterative, depth-capped), enforcing the caps against `budget` —
 * which is SHARED by every subtree of one mirror, so the total cap covers the
 * whole mirror. Breadth-first, names sorted per directory.
 */
async function collectSources(
  srcRoot: string,
  displayPrefix: string,
  report: CraftMirrorReport,
  budget: Budget,
): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: srcRoot, rel: "", depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const { dir, rel, depth } = queue[index]!;
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(TEMP_PREFIX)) continue;
      const abs = path.join(dir, name);
      const childRel = rel ? path.join(rel, name) : name;
      const shown = path.join(displayPrefix, childRel);
      const stat = await lstatOrNull(abs);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        report.rejected.push({ path: shown, reason: "symlink" });
        continue;
      }
      if (stat.isDirectory()) {
        if (depth + 1 > CRAFT_MAX_DEPTH) {
          report.rejected.push({ path: shown, reason: "too_deep" });
          continue;
        }
        queue.push({ dir: abs, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!stat.isFile()) {
        report.rejected.push({ path: shown, reason: "not_regular" });
        continue;
      }
      if (stat.size > budget.limits.maxFileBytes) {
        report.rejected.push({ path: shown, reason: "too_large" });
        continue;
      }
      if (budget.files >= budget.limits.maxFiles) {
        report.rejected.push({ path: shown, reason: "count_cap" });
        continue;
      }
      if (budget.bytes + stat.size > budget.limits.maxTotalBytes) {
        report.rejected.push({ path: shown, reason: "total_cap" });
        continue;
      }
      budget.files += 1;
      budget.bytes += stat.size;
      out.push({ rel: childRel, abs, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  return out;
}

/**
 * Same size and mtime (within 1 ms — utimes round-trips through a double):
 * the destination already mirrors the source.
 */
async function upToDate(dest: string, source: SourceFile): Promise<boolean> {
  const stat = await lstatOrNull(dest);
  return Boolean(stat?.isFile() && stat.size === source.size && Math.abs(stat.mtimeMs - source.mtimeMs) <= 1);
}

type CopyOutcome = "copied" | CraftRejectReason;

/**
 * Copy ONE file: `src` (inside real `srcRootReal`) → `destDir/name` (inside real
 * `destRootReal`), with every check from the module comment. Async, chunked:
 * the event loop runs between chunks.
 */
async function copyOneFile(
  source: SourceFile,
  srcRootReal: string,
  destDir: string,
  destRootReal: string,
  fileMode: number,
  maxFileBytes: number,
): Promise<CopyOutcome> {
  let src: fsp.FileHandle | null = null;
  let tmpHandle: fsp.FileHandle | null = null;
  const name = path.basename(source.rel);
  const tmp = path.join(destDir, `${TEMP_PREFIX}${process.pid}-${Math.random().toString(16).slice(2)}`);
  let tmpCreated = false;
  try {
    try {
      src = await fsp.open(source.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "io_error";
    }
    const stat = await src.stat();
    if (!stat.isFile()) return "not_regular";
    if (stat.size > maxFileBytes) return "too_large";
    const srcReal = await descriptorPath(src.fd);
    if (!srcReal || !isWithin(srcRootReal, srcReal)) return "escaped";

    tmpHandle = await fsp.open(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      fileMode,
    );
    tmpCreated = true;
    const tmpReal = await descriptorPath(tmpHandle.fd);
    if (!tmpReal || !isWithin(destRootReal, tmpReal)) {
      // The folder was swapped for a link after it was checked: the temp file
      // landed elsewhere — remove it THERE, by the path the kernel reported.
      if (tmpReal) await fsp.rm(tmpReal, { force: true }).catch(() => undefined);
      tmpCreated = false;
      return "escaped";
    }
    const chunk = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(stat.size, 1) + 1));
    let total = 0;
    for (;;) {
      const { bytesRead } = await src.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      // A file growing past what fstat promised (or past the cap) is still
      // being written — reject rather than mirror a torn copy.
      if (total > stat.size || total > maxFileBytes) return "changed";
      let written = 0;
      while (written < bytesRead) {
        const { bytesWritten } = await tmpHandle.write(chunk, written, bytesRead - written);
        written += bytesWritten;
      }
    }
    if (total !== stat.size) return "changed";
    await tmpHandle.utimes(stat.atimeMs / 1000, stat.mtimeMs / 1000);
    await tmpHandle.close();
    tmpHandle = null;
    const dest = path.join(destDir, name);
    const existing = await lstatOrNull(dest);
    if (existing && !existing.isFile()) await removeTreeNoFollow(dest);
    await fsp.rename(tmp, dest);
    tmpCreated = false;
    return "copied";
  } catch {
    return "io_error";
  } finally {
    await src?.close().catch(() => undefined);
    await tmpHandle?.close().catch(() => undefined);
    if (tmpCreated) await fsp.unlink(tmp).catch(() => undefined);
  }
}

/**
 * Remove destination files (and emptied folders) under `destRoot` that `keep`
 * lacks. Links are unlinked, never followed. Iterative and depth-capped:
 * nothing deeper than {@link CRAFT_MAX_DEPTH} is entered (the mirror never
 * creates anything that deep; the runner rejects it).
 */
async function pruneDestination(destRoot: string, keep: Set<string>, report: CraftMirrorReport): Promise<void> {
  const dirs: string[] = [];
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: destRoot, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { dir, rel, depth } = queue.pop()!;
    if (depth > 0) dirs.push(dir);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      const childRel = rel ? path.join(rel, name) : name;
      const stat = await lstatOrNull(abs);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth + 1 <= CRAFT_MAX_DEPTH) queue.push({ dir: abs, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (stat.isFile() && keep.has(childRel)) continue;
      try {
        await fsp.unlink(abs);
        if (!name.startsWith(TEMP_PREFIX)) report.removed += 1;
      } catch {
        // best effort
      }
    }
  }
  for (const dir of dirs.reverse()) {
    try {
      await fsp.rmdir(dir);
    } catch {
      // still holds kept files
    }
  }
}

/**
 * What a destination tree already holds (rel path → size) and the cap of the
 * WHOLE tree after the mirror — for the additive workspace mirror, whose
 * destination is never pruned.
 */
interface DestinationCap {
  existing: Map<string, number>;
  bytes: number;
  maxBytes: number;
}

/**
 * Mirror the regular files under `srcRoot` into `destRoot` (both must be real
 * directories; the destination chain is created by the caller). With `prune`,
 * a null or unusable source mirrors as EMPTY (its old destination files are
 * pruned); without it the mirror only adds and overwrites. With `destCap`, a
 * copy that would grow the destination past its cap is skipped (`workspace_cap`).
 */
async function mirrorTree(
  srcRoot: string | null,
  destRoot: string,
  displayPrefix: string,
  fileMode: number,
  dirMode: number,
  report: CraftMirrorReport,
  budget: Budget,
  prune: boolean,
  destCap?: DestinationCap,
): Promise<void> {
  const destRootReal = await realpathOrNull(destRoot);
  if (!destRootReal || !(await isRealDir(destRoot))) return;
  const srcRootReal = srcRoot && (await isRealDir(srcRoot)) ? await realpathOrNull(srcRoot) : null;
  const sources = srcRoot && srcRootReal ? await collectSources(srcRoot, displayPrefix, report, budget) : [];
  const keep = new Set<string>();
  for (const source of sources) {
    const destDir = await ensureRealDirChain(destRoot, path.dirname(source.rel), dirMode);
    if (!destDir || !srcRootReal) {
      report.rejected.push({ path: path.join(displayPrefix, source.rel), reason: "io_error" });
      continue;
    }
    const dest = path.join(destDir, path.basename(source.rel));
    if (await upToDate(dest, source)) {
      keep.add(source.rel);
      report.skipped += 1;
      report.bytes += source.size;
      continue;
    }
    // An overwrite only grows the tree by the difference.
    const growth = destCap ? source.size - (destCap.existing.get(source.rel) ?? 0) : 0;
    if (destCap && destCap.bytes + growth > destCap.maxBytes) {
      report.rejected.push({ path: path.join(displayPrefix, source.rel), reason: "workspace_cap" });
      continue;
    }
    const outcome = await copyOneFile(source, srcRootReal, destDir, destRootReal, fileMode, budget.limits.maxFileBytes);
    if (outcome === "copied") {
      keep.add(source.rel);
      report.copied += 1;
      report.bytes += source.size;
      if (destCap) {
        destCap.bytes += growth;
        destCap.existing.set(source.rel, source.size);
      }
    } else {
      report.rejected.push({ path: path.join(displayPrefix, source.rel), reason: outcome });
    }
  }
  if (prune) await pruneDestination(destRoot, keep, report);
}

/**
 * Prepare `<inboxRoot>/<sid>/` as a real 0700 directory Noah owns. Null when
 * the inbox root is missing (the runner has not created the layout) or a link
 * squats on the session folder and cannot be replaced.
 */
export async function ensureCraftInbox(inboxRoot: string, sid: string): Promise<string | null> {
  if (!(await isRealDir(inboxRoot))) return null;
  return ensureRealDirChain(inboxRoot, sid, 0o700);
}

/**
 * Empty the session's `staged/` folder — at the start of every run (Addendum
 * A4), so files staged by earlier runs never accumulate against the inbox cap.
 */
export async function clearCraftStaged(inboxDir: string): Promise<void> {
  await removeTreeNoFollow(path.join(inboxDir, CRAFT_STAGED_DIR));
}

/**
 * Mirror the workspace's server-written input folders (+ the previous Craft
 * results in `craft/out/`) into the session inbox. Caps are shared across the
 * four subtrees AND whatever `staged/` holds — the runner enforces them on the
 * whole inbox.
 */
export async function mirrorWorkspaceToInbox(
  workspaceDir: string,
  inboxDir: string,
  limits: CraftLimits = CRAFT_LIMITS,
): Promise<CraftMirrorReport> {
  const report = emptyReport();
  const budget: Budget = { files: 0, bytes: 0, limits };
  if (!(await isRealDir(inboxDir))) return report;
  const staged = path.join(inboxDir, CRAFT_STAGED_DIR);
  if (await isRealDir(staged)) {
    await collectSources(staged, CRAFT_STAGED_DIR, emptyReport(), budget);
  }
  const workspaceOk = await isRealDir(workspaceDir);
  for (const mapping of CRAFT_INBOX_MAPPINGS) {
    const destRoot = await ensureRealDirChain(inboxDir, mapping.inbox, 0o700);
    if (!destRoot) {
      report.rejected.push({ path: mapping.workspace, reason: "io_error" });
      continue;
    }
    // A source folder that is not a REAL directory under a real workspace is
    // treated as empty (its old mirror is pruned), never followed.
    const src = path.join(workspaceDir, mapping.workspace);
    const parentOk = mapping.workspace.includes(path.sep)
      ? await isRealDir(path.join(workspaceDir, path.dirname(mapping.workspace)))
      : true;
    await mirrorTree(parentOk && workspaceOk ? src : null, destRoot, mapping.workspace, 0o600, 0o700, report, budget, true);
  }
  return report;
}

/** Regular files under `root` (rel path → size), uncapped — what a tree holds now. */
async function treeUsage(root: string): Promise<{ files: Map<string, number>; bytes: number }> {
  const budget: Budget = {
    files: 0,
    bytes: 0,
    limits: { maxFileBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER },
  };
  const sources = await collectSources(root, "", emptyReport(), budget);
  return { files: new Map(sources.map((source) => [source.rel, source.size])), bytes: budget.bytes };
}

/**
 * Mirror the session outbox into the workspace's `craft/out/` so the avatar
 * can place or `share_file` what an app saved. ADDITIVE: files are copied or
 * overwritten, never deleted — an empty or missing outbox changes nothing. The
 * whole `craft/out/` stays within `workspaceMaxBytes` (Addendum B N2): a file
 * that would grow it further is skipped and reported `workspace_cap`.
 */
export async function mirrorOutboxToWorkspace(
  outboxDir: string,
  workspaceDir: string,
  limits: CraftLimits = CRAFT_LIMITS,
  workspaceMaxBytes: number = CRAFT_WORKSPACE_OUT_MAX_BYTES,
): Promise<CraftMirrorReport> {
  const report = emptyReport();
  if (!(await isRealDir(outboxDir)) || !(await isRealDir(workspaceDir))) return report;
  const destRoot = await ensureRealDirChain(workspaceDir, CRAFT_WORKSPACE_OUT_DIR, 0o755);
  if (!destRoot) {
    report.rejected.push({ path: CRAFT_WORKSPACE_OUT_DIR, reason: "io_error" });
    return report;
  }
  const usage = await treeUsage(destRoot);
  await mirrorTree(outboxDir, destRoot, "out", 0o644, 0o755, report, { files: 0, bytes: 0, limits }, false, {
    existing: usage.files,
    bytes: usage.bytes,
    maxBytes: workspaceMaxBytes,
  });
  return report;
}

export type StageWorkspaceFileResult =
  | { name: string; size: number }
  | {
      error: "OUTSIDE_WORKSPACE" | "NOT_FOUND" | "NOT_FILE" | "TOO_LARGE" | "INBOX_FULL" | "NO_SESSION" | "COPY_FAILED";
      detail?: string;
    };

/** A trailing extension worth keeping when a name is shortened: short, ASCII alphanumeric. */
const KEPT_EXTENSION_RE = /\.[A-Za-z0-9]{1,10}$/;

/**
 * A safe, per-SOURCE staged file name (Addendum B N6):
 * `<stem>-<8 hex of sha256(source path)><ext>` — two different files with the
 * same basename (`a/logo.png`, `b/logo.png`) never land on one staged name,
 * while re-staging the same file replaces its own copy. The basename has
 * path/control characters replaced and no leading dots; the whole name is at
 * most {@link CRAFT_STAGED_NAME_MAX_BYTES} UTF-8 BYTES — the stem cut on a
 * code-point boundary, the tag and a short extension kept (Addendum A4; the
 * runner rejects names over 255 bytes, which ~86 Hangul characters reach).
 * `sourcePath` is the RESOLVED path of the file being staged.
 */
export function stagedFileName(sourcePath: string): string {
  const base = path.basename(sourcePath).replace(/[\p{Cc}\p{Cs}\\/]+/gu, "_").replace(/^\.+/, "") || "file";
  const tag = `-${crypto.createHash("sha256").update(sourcePath, "utf8").digest("hex").slice(0, 8)}`;
  const ext = KEPT_EXTENSION_RE.exec(base)?.[0] ?? "";
  const stem = base.slice(0, base.length - ext.length);
  let out = "";
  let bytes = Buffer.byteLength(`${tag}${ext}`, "utf8");
  for (const char of stem) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > CRAFT_STAGED_NAME_MAX_BYTES) break;
    out += char;
    bytes += size;
  }
  return `${out.trimEnd() || "file"}${tag}${ext}`;
}


/**
 * Copy ONE workspace file into `<inboxDir>/staged/`: its realpath must lie in
 * one of `roots` (the run's working roots), it must be a regular file within
 * {@link CRAFT_MAX_FILE_BYTES}, and the whole inbox — staged/ included — must
 * stay within the mirror caps afterwards. The caller runs `sync_in`
 * afterwards and checks its `rejected` list.
 */
export async function stageWorkspaceFile(
  roots: readonly string[],
  inputPath: string,
  inboxDir: string,
  limits: CraftLimits = CRAFT_LIMITS,
): Promise<StageWorkspaceFileResult> {
  const realRoots: string[] = [];
  for (const root of roots) {
    const real = await realpathOrNull(root);
    if (real) realRoots.push(real);
  }
  if (realRoots.length === 0) return { error: "OUTSIDE_WORKSPACE" };
  const unresolved = path.isAbsolute(inputPath) ? inputPath : path.resolve(realRoots[0]!, inputPath);
  const real = await realpathOrNull(unresolved);
  if (!real) return { error: "NOT_FOUND" };
  const root = realRoots.find((candidate) => isWithin(candidate, real));
  if (!root) return { error: "OUTSIDE_WORKSPACE" };
  const stat = await lstatOrNull(real);
  if (!stat?.isFile()) return { error: "NOT_FILE" };
  if (stat.size > limits.maxFileBytes) return { error: "TOO_LARGE" };
  if (!(await isRealDir(inboxDir))) return { error: "NO_SESSION" };
  const name = stagedFileName(real);
  // The whole inbox counts (Addendum A4); the same source staged again replaces its copy.
  const usage = await treeUsage(inboxDir);
  const replaced = await lstatOrNull(path.join(inboxDir, CRAFT_STAGED_DIR, name));
  const replacedBytes = replaced?.isFile() ? replaced.size : 0;
  const filesAfter = usage.files.size + (replaced?.isFile() ? 0 : 1);
  if (filesAfter > limits.maxFiles || usage.bytes - replacedBytes + stat.size > limits.maxTotalBytes) {
    return { error: "INBOX_FULL" };
  }
  const destDir = await ensureRealDirChain(inboxDir, CRAFT_STAGED_DIR, 0o700);
  const destReal = destDir ? await realpathOrNull(destDir) : null;
  if (!destDir || !destReal) return { error: "COPY_FAILED" };
  // Copy from the RESOLVED path, checked against the root it resolved in.
  const outcome = await copyOneFile(
    { rel: name, abs: real, size: stat.size, mtimeMs: stat.mtimeMs },
    root,
    destDir,
    destReal,
    0o600,
    limits.maxFileBytes,
  );
  if (outcome !== "copied") {
    return outcome === "too_large"
      ? { error: "TOO_LARGE" }
      : outcome === "not_regular"
        ? { error: "NOT_FILE" }
        : { error: "COPY_FAILED", detail: outcome };
  }
  return { name, size: stat.size };
}
