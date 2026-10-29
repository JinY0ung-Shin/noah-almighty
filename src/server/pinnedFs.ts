/**
 * Folder operations that never resolve an AGENT-CONTROLLED path component by
 * name (pi review C1, docs/architecture/pi-runtime.md "Host-side filesystem
 * discipline").
 *
 * A pi sandbox workspace (`PI_WORKSPACES_DIR/u-<key>`, the sandbox's
 * `/workspace`) is agent-writable at Noah's own uid (as the removed SDK
 * runner's scratch workspace was): the agent can turn any folder Noah later walks into (`.noah/skills`,
 * `c/<conv>`, `repos/<owner>`, `attachments/`) into a symlink, and a host path
 * that crosses it follows the link out of the workspace — `ln -s ../..
 * .noah/skills` once made the skill sync list `PI_WORKSPACES_DIR` and delete
 * every other user's sandbox. Checking a path and then acting on it by name
 * only narrows that race.
 *
 * So a folder is PINNED by descriptor: opened component by component with
 * `O_DIRECTORY|O_NOFOLLOW`, each from the previous folder's descriptor
 * (`/proc/self/fd/<fd>/<name>` — Linux's openat for a runtime that has none),
 * and every operation on an entry goes through that descriptor too: exclusive
 * creates, no-follow reads, renames inside the folder, and a recursive removal
 * that pins each sub-folder the same way and unlinks (never follows) every
 * link. A link or a non-folder anywhere on the way refuses the operation.
 * Reads by an already-checked absolute path ({@link fdPathIs}) verify the
 * OPENED file's kernel path instead of trusting the name.
 *
 * Residual (not closable from Node, documented): a MISSING folder on the way is
 * created by mkdir under the pinned parent and then opened no-follow, so a race
 * there can only make Noah refuse; file CONTENT stays the agent's after Noah
 * wrote it; and without `/proc/self/fd` (non-Linux dev hosts) entries are
 * addressed by name under the pinned folder's original path, i.e.
 * check-then-act — which is why `AGENT_RUNTIME=pi` refuses to boot there
 * ({@link assertProcFdPinning}); only the `local` stub's scratch writers ever
 * run in that mode.
 */
import fs from "node:fs";
import path from "node:path";

const DIR_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
/** Nesting a removal descends before it leaves the rest in place (one descriptor per level). */
const MAX_REMOVE_DEPTH = 128;

let procFd: boolean | undefined;
/** Whether `/proc/self/fd` resolves descriptors (Linux). Probed once. */
export function procFdAvailable(): boolean {
  if (procFd === undefined) {
    try {
      procFd = fs.statSync("/proc/self/fd").isDirectory();
    } catch {
      procFd = false;
    }
  }
  return procFd;
}

/**
 * True when the open descriptor `fd` is the file at the absolute `expected`
 * path — the kernel's own record of what was opened, so a link swapped into
 * any ancestor between a caller's realpath check and its open is caught.
 * Without `/proc/self/fd` the check cannot be made and passes (see the module
 * note).
 */
export function fdPathIs(fd: number, expected: string): boolean {
  if (!procFdAvailable()) return true;
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`) === expected;
  } catch {
    return false;
  }
}

/**
 * pi runs depend on descriptor pinning for their safety (the sandbox is
 * agent-writable at Noah's uid), so `AGENT_RUNTIME=pi` refuses to boot without
 * `/proc/self/fd` instead of silently falling back to check-then-act.
 */
export function assertProcFdPinning(available: boolean = procFdAvailable()): void {
  if (!available) {
    throw new Error(
      "AGENT_RUNTIME=pi requires /proc/self/fd (Linux with /proc mounted): Noah pins every sandbox folder by descriptor and will not fall back to check-then-act path operations.",
    );
  }
}

function isSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0");
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export type PinnedEntryKind = "file" | "dir" | "missing" | "other";

/** A folder held open by descriptor; every method addresses entries through it. Close it. */
export class PinnedDir {
  private open = true;

  private constructor(
    private readonly fd: number,
    /** Host path the folder had when it was opened — for naming and mapping, never for I/O. */
    readonly hostPath: string,
  ) {}

  /**
   * Pin `absPath` itself. Its LAST component must be a real folder (a link
   * there is refused); its ancestors are the caller's to trust — pass the
   * deepest folder the agent cannot replace (the pi user root, the scratch
   * workspace) and reach the rest with {@link dir}.
   */
  static open(absPath: string): PinnedDir | null {
    let fd: number;
    try {
      fd = fs.openSync(absPath, DIR_FLAGS);
    } catch {
      return null;
    }
    return new PinnedDir(fd, path.resolve(absPath));
  }

  /** `anchor` pinned, then `rel` (segments, or a path relative to it) below it; the anchor is closed again. */
  static openBelow(
    anchor: string,
    rel: string | readonly string[],
    options: { create?: boolean; mode?: number } = {},
  ): PinnedDir | null {
    const root = PinnedDir.open(anchor);
    if (!root) return null;
    try {
      return root.dir(rel, options);
    } finally {
      root.close();
    }
  }

  /** The folder's own I/O path (through the descriptor); deeper names below it are resolved by name. */
  base(): string {
    return procFdAvailable() ? `/proc/self/fd/${this.fd}` : this.hostPath;
  }

  /** The path of a direct child, resolved through this descriptor. */
  entry(name: string): string {
    if (!isSegment(name)) throw new Error(`not a single path segment: ${JSON.stringify(name)}`);
    return `${this.base()}/${name}`;
  }

  /**
   * The I/O path of a descendant (`a/b/c`, plain segments) through this
   * descriptor. Only the FIRST segment is pinned; deeper ones are resolved by
   * name, so pair it with {@link readFileVerified} / {@link listDirVerified}
   * (or lstat-only checks). An empty `rel` is the folder itself.
   */
  descendant(rel: string): string {
    if (!rel) return `${this.base()}/.`;
    const parts = rel.split("/");
    if (!parts.every(isSegment)) throw new Error(`not a relative path of plain segments: ${JSON.stringify(rel)}`);
    return `${this.base()}/${parts.join("/")}`;
  }

  /** Host path of a direct child (for naming and mapping only). */
  hostEntry(name: string): string {
    return path.join(this.hostPath, name);
  }

  /** The folder's current real path (the kernel's view of the descriptor). */
  realPath(): string | null {
    try {
      return procFdAvailable() ? fs.readlinkSync(`/proc/self/fd/${this.fd}`) : fs.realpathSync(this.hostPath);
    } catch {
      return null;
    }
  }

  private child(name: string, create: boolean, mode: number): PinnedDir | null {
    if (!isSegment(name)) return null;
    const target = this.entry(name);
    const attempt = (): PinnedDir | null | "missing" => {
      try {
        return new PinnedDir(fs.openSync(target, DIR_FLAGS), this.hostEntry(name));
      } catch (error) {
        return errnoOf(error) === "ENOENT" ? "missing" : null; // ENOTDIR/ELOOP: a link or a file
      }
    };
    let opened = attempt();
    if (opened === "missing" && create) {
      try {
        fs.mkdirSync(target, { mode });
      } catch (error) {
        if (errnoOf(error) !== "EEXIST") return null;
      }
      opened = attempt(); // re-opened no-follow: whatever is there now must be a real folder
    }
    return opened === "missing" ? null : opened;
  }

  /**
   * A descendant folder, opened one segment at a time without following
   * links; with `create`, missing segments are made (`mode`, default 0755).
   * Null when any segment is a link, a non-folder, missing (without
   * `create`), or not a plain name. An empty `rel` re-opens this folder.
   */
  dir(rel: string | readonly string[], options: { create?: boolean; mode?: number } = {}): PinnedDir | null {
    const parts = typeof rel === "string" ? rel.split(/[\\/]+/).filter(Boolean) : [...rel];
    if (parts.length === 0) {
      try {
        return new PinnedDir(fs.openSync(`${this.base()}/.`, DIR_FLAGS), this.hostPath);
      } catch {
        return null;
      }
    }
    let current: PinnedDir | null = null;
    for (const part of parts) {
      const next: PinnedDir | null = (current ?? this).child(part, options.create ?? false, options.mode ?? 0o755);
      current?.close();
      if (!next) return null;
      current = next;
    }
    return current;
  }

  /** What a direct child is, by lstat through the descriptor. */
  kind(name: string): PinnedEntryKind {
    try {
      const stat = fs.lstatSync(this.entry(name), { throwIfNoEntry: false });
      if (!stat) return "missing";
      return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    } catch {
      return "other";
    }
  }

  lstat(name: string): fs.Stats | undefined {
    try {
      return fs.lstatSync(this.entry(name), { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
  }

  /** The folder's entries (lstat types: a link reads as a link). */
  list(): fs.Dirent[] {
    return fs.readdirSync(`${this.base()}/.`, { withFileTypes: true });
  }

  /** A direct child's bytes when it is a regular file (never through a link) of at most `maxBytes`, else null. */
  readFile(name: string, maxBytes = Number.MAX_SAFE_INTEGER): Buffer | null {
    let fd: number;
    try {
      fd = fs.openSync(this.entry(name), READ_FLAGS);
    } catch {
      return null;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      return fs.readFileSync(fd);
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Create a direct child EXCLUSIVELY (never replacing anything, never through
   * a link) holding `data`, with `mode` applied to the descriptor. "exists"
   * when the name is taken; a failed write removes the partial file.
   */
  writeFileExclusive(name: string, data: string | NodeJS.ArrayBufferView, mode = 0o644): "written" | "exists" {
    const target = this.entry(name);
    let fd: number;
    try {
      fd = fs.openSync(target, CREATE_FLAGS, mode);
    } catch (error) {
      if (errnoOf(error) === "EEXIST") return "exists";
      throw error;
    }
    try {
      fs.writeFileSync(fd, data);
      fs.fchmodSync(fd, mode);
    } catch (error) {
      fs.closeSync(fd);
      this.unlink(name);
      throw error;
    }
    fs.closeSync(fd);
    return "written";
  }

  /**
   * Copy the Noah-side file `source` in as a NEW direct child (exclusive
   * create: a link or anything else at the name fails with EEXIST), then set
   * `mode` through a no-follow descriptor.
   */
  copyFileIn(source: string, name: string, mode = 0o644): void {
    const target = this.entry(name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    let fd: number | undefined;
    try {
      fd = fs.openSync(target, READ_FLAGS);
      fs.fchmodSync(fd, mode);
    } catch {
      /* swapped since the create: the agent's own entry now, left as is */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** Rename a direct child to another name in this folder (replacing a file or an empty folder there). */
  rename(from: string, to: string): void {
    fs.renameSync(this.entry(from), this.entry(to));
  }

  /** Unlink a direct non-folder child (a link itself, never its target). Best effort. */
  unlink(name: string): void {
    try {
      fs.unlinkSync(this.entry(name));
    } catch {
      /* best effort */
    }
  }

  /**
   * Remove a direct child without following anything: a link or file is
   * unlinked, a folder is pinned and emptied the same way, then removed.
   * Best effort; never throws.
   */
  remove(name: string): void {
    this.removeAt(name, 0);
  }

  /** Remove every entry of this folder (see {@link remove}). */
  clear(): void {
    this.clearAt(0);
  }

  private removeAt(name: string, depth: number): void {
    try {
      const stat = this.lstat(name);
      if (!stat) return;
      if (!stat.isDirectory()) {
        this.unlink(name);
        return;
      }
      if (depth >= MAX_REMOVE_DEPTH) return;
      const sub = this.child(name, false, 0);
      if (!sub) {
        // Swapped for a link or a file since the lstat: unlink that instead.
        if (this.kind(name) !== "dir") this.unlink(name);
        return;
      }
      try {
        sub.clearAt(depth + 1);
      } finally {
        sub.close();
      }
      fs.rmdirSync(this.entry(name));
    } catch {
      /* best effort */
    }
  }

  private clearAt(depth: number): void {
    let entries: fs.Dirent[];
    try {
      entries = this.list();
    } catch {
      return;
    }
    for (const entry of entries) this.removeAt(entry.name, depth);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Read the regular file at `openPath` (no-follow on its last component) only
 * when the OPENED file is exactly `expectedReal` ({@link fdPathIs}) — a link
 * swapped into any folder on the way since the caller listed it is refused.
 * Null on any mismatch, a non-file, or more than `maxBytes`.
 */
export function readFileVerified(openPath: string, expectedReal: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(openPath, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    if (!fdPathIs(fd, expectedReal)) return null;
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** List the folder at `openPath` (no-follow) only when the OPENED folder is exactly `expectedReal`; null otherwise. */
export function listDirVerified(openPath: string, expectedReal: string): fs.Dirent[] | null {
  let fd: number;
  try {
    fd = fs.openSync(openPath, DIR_FLAGS);
  } catch {
    return null;
  }
  try {
    if (!fdPathIs(fd, expectedReal)) return null;
    return fs.readdirSync(procFdAvailable() ? `/proc/self/fd/${fd}/.` : openPath, { withFileTypes: true });
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Run `fn` with a pinned folder (or null) and always close it. */
export function withPinnedDir<T>(dir: PinnedDir | null, fn: (dir: PinnedDir | null) => T): T {
  try {
    return fn(dir);
  } finally {
    dir?.close();
  }
}

/** Async {@link withPinnedDir}. */
export async function withPinnedDirAsync<T>(dir: PinnedDir | null, fn: (dir: PinnedDir | null) => Promise<T>): Promise<T> {
  try {
    return await fn(dir);
  } finally {
    dir?.close();
  }
}

/**
 * `rel` of `child` below `anchor` as path segments, or null when `child` is
 * not inside `anchor` (lexically).
 */
export function segmentsBelow(anchor: string, child: string): string[] | null {
  const relative = path.relative(path.resolve(anchor), path.resolve(child));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).filter(Boolean);
}
