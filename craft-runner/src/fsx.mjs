// Descriptor-relative filesystem primitives ("openat emulation").
//
// The daemon runs as root with CAP_DAC_OVERRIDE/CAP_CHOWN/CAP_FOWNER, and the trees it mirrors are
// writable by less trusted parties (inbox/outbox by Noah's uid 1000 — which includes the avatar's shell —
// and work/<sid>/out by the app's session uid). A path-based copy could therefore be redirected by a
// symlink swapped in at ANY component. Every operation here starts from an already-open directory
// descriptor and addresses the child through `/proc/self/fd/<fd>/<name>`: the magic link resolves to the
// directory we hold open (not to whatever the path says now), and O_NOFOLLOW covers the final
// component. Node has no openat(2); this is the standard Linux equivalent.

import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import { DEFAULT_LIMITS } from "./config.mjs";
import { TMP_PREFIX } from "./paths.mjs";

const C = fs.constants;
const DIR_FLAGS = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;

/** `/proc/self/fd/<fd>` or `/proc/self/fd/<fd>/<name>`. */
export function fdPath(fd, name) {
  return name === undefined ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
}

/** Open a directory by absolute path WITHOUT following a final symlink. Throws on non-directories. */
export function openDirNoFollow(absPath) {
  return fs.openSync(absPath, DIR_FLAGS);
}

/** Open a child directory of an open directory descriptor without following symlinks. */
export function openChildDir(dirFd, name) {
  return fs.openSync(fdPath(dirFd, name), DIR_FLAGS);
}

export function closeQuiet(fd) {
  try {
    fs.closeSync(fd);
  } catch {
    /* already closed */
  }
}

/** Classify an fs.Stats into the mirror's vocabulary. */
export function entryType(st) {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "symlink";
  if (st.isFIFO()) return "fifo";
  if (st.isSocket()) return "socket";
  if (st.isBlockDevice() || st.isCharacterDevice()) return "device";
  return "other";
}

/**
 * Apply owner + mode to an open descriptor. `owner` null = leave ownership alone (unprivileged tests).
 * @param {number} fd
 * @param {{uid:number,gid:number}|null} owner
 * @param {number} mode
 */
export function applyOwnerMode(fd, owner, mode) {
  if (owner) fs.fchownSync(fd, owner.uid, owner.gid);
  fs.fchmodSync(fd, mode);
}

/**
 * Ensure `name` is a real directory inside `dirFd` and return an open descriptor to it.
 * A non-directory in the way (symlink, file, FIFO…) is removed first — the parent is a tree the
 * daemon owns the shape of.
 * @param {number} dirFd
 * @param {string} name
 * @param {{ owner: {uid:number,gid:number}|null, mode: number }} opts
 */
export function ensureChildDir(dirFd, name, { owner, mode }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(fdPath(dirFd, name), { mode: 0o700 });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let fd;
    try {
      fd = openChildDir(dirFd, name);
    } catch (err) {
      if (err.code === "ELOOP" || err.code === "ENOTDIR") {
        removeEntry(dirFd, name);
        continue;
      }
      throw err;
    }
    try {
      applyOwnerMode(fd, owner, mode);
    } catch (err) {
      closeQuiet(fd);
      throw err;
    }
    return fd;
  }
  throw new Error(`could not create directory ${name}`);
}

/** Directory levels any walk/removal opens at once (Addendum A4). */
export const MAX_WALK_DEPTH = DEFAULT_LIMITS.maxDepth;
/** Reason attached to entries below `maxDepth` levels: never followed, never mirrored. */
export const TOO_DEEP = "too_deep";

export class TreeTooLarge extends Error {}

/**
 * Remove a directory entry of any type, ITERATIVELY (no recursion, so a 100 000-level chain cannot
 * overflow the stack) and with at most `maxDepth` directory descriptors open: a directory found at the
 * depth cap is not descended into but RENAMED up into the root being removed (under a reserved
 * `.craft-tmp-` name), where a later pass empties it — each hoist removes `maxDepth` levels from the
 * chain. Symlinks inside are unlinked, never followed. `maxOps` bounds the work against a writer that
 * keeps adding entries concurrently (→ TreeTooLarge; everything already removed stays removed).
 * @param {number} dirFd
 * @param {string} name
 * @param {{ maxDepth?: number, maxOps?: number }} [opts]
 */
export function removeEntry(dirFd, name, { maxDepth = MAX_WALK_DEPTH, maxOps = DEFAULT_LIMITS.removeMaxOps } = {}) {
  let st;
  try {
    st = fs.lstatSync(fdPath(dirFd, name));
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(fdPath(dirFd, name));
    return;
  }
  const rootFd = openChildDir(dirFd, name);
  try {
    emptyDirIteratively(rootFd, Math.max(2, maxDepth), maxOps);
  } finally {
    closeQuiet(rootFd);
  }
  fs.rmdirSync(fdPath(dirFd, name));
}

/** Empty (not remove) the directory open at `rootFd`. See removeEntry. */
function emptyDirIteratively(rootFd, maxDepth, maxOps) {
  /** @type {{fd:number, name:string, names:string[], i:number}[]} */
  const stack = [{ fd: rootFd, name: "", names: fs.readdirSync(fdPath(rootFd)), i: 0 }];
  let ops = 0;
  const tick = () => {
    ops += 1;
    if (ops > maxOps) throw new TreeTooLarge(`tree removal exceeded ${maxOps} operations`);
  };
  try {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.names.length) {
        // Re-read before leaving: hoisted subtrees land in the root, and a concurrent writer may add more.
        tick();
        const again = fs.readdirSync(fdPath(top.fd));
        if (again.length > 0) {
          top.names = again;
          top.i = 0;
          continue;
        }
        stack.pop();
        if (stack.length === 0) break; // the root itself is removed by the caller
        closeQuiet(top.fd);
        const parent = stack[stack.length - 1];
        try {
          fs.rmdirSync(fdPath(parent.fd, top.name));
        } catch (err) {
          if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY" && err.code !== "EEXIST") throw err;
          // ENOTEMPTY: refilled meanwhile — the parent's re-read picks it up again.
        }
        continue;
      }
      const child = top.names[top.i++];
      tick();
      let cst;
      try {
        cst = fs.lstatSync(fdPath(top.fd, child));
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      if (!cst.isDirectory()) {
        try {
          fs.unlinkSync(fdPath(top.fd, child));
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
        }
        continue;
      }
      if (stack.length >= maxDepth) {
        // Never descend past the cap: hoist the subtree into the root and empty it from there.
        fs.renameSync(fdPath(top.fd, child), fdPath(rootFd, `${TMP_PREFIX}deep-${crypto.randomBytes(8).toString("hex")}`));
        continue;
      }
      let fd;
      try {
        fd = openChildDir(top.fd, child);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      stack.push({ fd, name: child, names: fs.readdirSync(fdPath(fd)), i: 0 });
    }
  } finally {
    for (const frame of stack) if (frame.fd !== rootFd) closeQuiet(frame.fd);
  }
}

/**
 * Remove `<parentAbs>/<name>` (any type) starting from a trusted parent path.
 * @param {string} parentAbs
 * @param {string} name
 * @param {{ maxDepth?: number, maxOps?: number }} [opts]   see removeEntry
 */
export function removeTreeAt(parentAbs, name, opts) {
  let parentFd;
  try {
    parentFd = openDirNoFollow(parentAbs);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  try {
    removeEntry(parentFd, name, opts);
  } finally {
    closeQuiet(parentFd);
  }
}

export class CopyRejected extends Error {}

/**
 * Copy one regular file between two open directories.
 * - Source: opened O_NOFOLLOW|O_NONBLOCK (a FIFO swapped in cannot block us), then fstat'ed: it must
 *   still be the regular file the walk saw (same dev/ino), within `maxBytes`, and (optionally) not a
 *   hard link.
 * - Destination: a fresh O_EXCL|O_NOFOLLOW temp file in the destination directory, owner/mode/mtime
 *   applied on the descriptor, then renamed over the final name (rename replaces a planted symlink
 *   instead of writing through it).
 * @returns {Promise<number>} bytes copied
 */
export async function copyFileBetween(srcDirFd, srcName, dstDirFd, dstName, opts) {
  const { expect, maxBytes, owner, mode, rejectHardlinks } = opts;
  const src = await fsp.open(fdPath(srcDirFd, srcName), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
  let dst;
  const tmpName = `${TMP_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
  try {
    const st = await src.stat();
    if (!st.isFile()) throw new CopyRejected(`${entryType(st)} rejected`);
    if (expect && (st.ino !== expect.ino || st.dev !== expect.dev)) {
      throw new CopyRejected("file changed during sync");
    }
    if (rejectHardlinks && st.nlink > 1) throw new CopyRejected("hard link rejected");
    if (st.size > maxBytes) throw new CopyRejected("file exceeds the per-file size cap");
    dst = await fsp.open(fdPath(dstDirFd, tmpName), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new CopyRejected("file grew beyond the per-file size cap");
      await dst.write(buf, 0, bytesRead);
    }
    if (owner) await dst.chown(owner.uid, owner.gid);
    await dst.chmod(mode);
    await dst.utimes(st.atime, st.mtime);
    await dst.close();
    dst = undefined;
    fs.renameSync(fdPath(dstDirFd, tmpName), fdPath(dstDirFd, dstName));
    return total;
  } catch (err) {
    if (dst) await dst.close().catch(() => {});
    try {
      fs.unlinkSync(fdPath(dstDirFd, tmpName));
    } catch {
      /* temp file never created or already renamed */
    }
    throw err;
  } finally {
    await src.close().catch(() => {});
  }
}

/** Reason attached to entries whose NAME the runner will not mirror (the specific problem rides `detail`). */
export const BAD_NAME = "bad_name";

/**
 * Walk a tree from an open directory descriptor — ITERATIVELY, holding at most `maxDepth` descriptors.
 * Lists directories and regular files in sorted pre-order; every other entry type (symlink, FIFO,
 * socket, device), a bad name (`bad_name`), and a directory more than `maxDepth` levels down
 * (`too_deep`, never opened) is reported in `rejected` AND kept in `foreign` so a destination walk can
 * delete it. `bytes` sums every regular file seen — a directory with a bad name is still walked
 * (measure-only: nothing listed, nothing mirrored) so its bytes COUNT (N4); `unmeasured` counts only
 * directories deeper than `maxDepth`, so a budget can fail closed.
 * @param {number} rootFd
 * @param {{ maxDepth: number, nameProblem: (n:string)=>string|null }} opts
 */
export function walkTree(rootFd, { maxDepth, nameProblem }) {
  /** @type {{path:string,type:"file"|"dir",size:number,mtimeMs:number,ino:number,dev:number}[]} */
  const entries = [];
  /** @type {{path:string,reason:string}[]} */
  const rejected = [];
  /** @type {string[]} */
  const foreign = [];
  let bytes = 0;
  let unmeasured = 0;
  /** @type {{fd:number, prefix:string, depth:number, names:string[], i:number, measureOnly:boolean}[]} */
  const stack = [{ fd: rootFd, prefix: "", depth: 0, names: fs.readdirSync(fdPath(rootFd)).sort(), i: 0, measureOnly: false }];
  /** Open `name` (lstat'ed as `st`) below `top` as a verified child descriptor, or null on a race. */
  const openVerified = (top, name, st) => {
    let childFd;
    try {
      childFd = openChildDir(top.fd, name);
    } catch (err) {
      return { fd: null, code: err.code };
    }
    const cst = fs.fstatSync(childFd);
    if (cst.ino !== st.ino || cst.dev !== st.dev) {
      closeQuiet(childFd);
      return { fd: null, code: undefined };
    }
    return { fd: childFd };
  };
  const pushChild = (fd, prefix, depth, measureOnly) => {
    let names;
    try {
      names = fs.readdirSync(fdPath(fd)).sort();
    } catch (err) {
      closeQuiet(fd);
      throw err;
    }
    stack.push({ fd, prefix, depth, names, i: 0, measureOnly });
  };
  try {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.names.length) {
        stack.pop();
        if (top.fd !== rootFd) closeQuiet(top.fd);
        continue;
      }
      const name = top.names[top.i++];
      const rel = top.prefix ? `${top.prefix}/${name}` : name;
      let st;
      try {
        st = fs.lstatSync(fdPath(top.fd, name));
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
      const type = entryType(st);
      if (type === "file") bytes += st.size;
      if (top.measureOnly) {
        // Inside a bad-named directory: count bytes, list nothing (the whole subtree is already rejected).
        if (type !== "dir") continue;
        if (top.depth + 1 > maxDepth) {
          unmeasured += 1;
          continue;
        }
        const child = openVerified(top, name, st);
        if (child.fd !== null) pushChild(child.fd, rel, top.depth + 1, true);
        continue;
      }
      const problem = nameProblem(name);
      if (problem) {
        rejected.push({ path: rel, reason: BAD_NAME, detail: problem });
        foreign.push(rel);
        if (type === "dir") {
          if (top.depth + 1 > maxDepth) {
            unmeasured += 1;
            continue;
          }
          const child = openVerified(top, name, st);
          if (child.fd !== null) pushChild(child.fd, rel, top.depth + 1, true);
        }
        continue;
      }
      if (type === "dir") {
        if (top.depth + 1 > maxDepth) {
          rejected.push({ path: rel, reason: `${TOO_DEEP} (more than ${maxDepth} directory levels)` });
          foreign.push(rel);
          unmeasured += 1;
          continue;
        }
        const child = openVerified(top, name, st);
        if (child.fd === null) {
          rejected.push({ path: rel, reason: child.code ? `directory changed during sync (${child.code})` : "directory changed during sync" });
          continue;
        }
        entries.push({ path: rel, type: "dir", size: 0, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev });
        pushChild(child.fd, rel, top.depth + 1, false);
      } else if (type === "file") {
        entries.push({
          path: rel,
          type: "file",
          size: st.size,
          mtimeMs: st.mtimeMs,
          ino: st.ino,
          dev: st.dev,
          nlink: st.nlink,
        });
      } else {
        rejected.push({ path: rel, reason: `${type} rejected` });
        foreign.push(rel);
      }
    }
  } finally {
    for (const frame of stack) if (frame.fd !== rootFd) closeQuiet(frame.fd);
  }
  return { entries, rejected, foreign, bytes, unmeasured };
}

/**
 * Bytes used by the regular files under an absolute directory (descriptor-relative, iterative, depth
 * capped, nothing built per entry). A missing directory measures 0.
 * @param {string} absPath
 * @param {number} [maxDepth]
 * @returns {{ bytes: number, files: number, unmeasured: number }}
 */
export function measureTree(absPath, maxDepth = MAX_WALK_DEPTH) {
  let rootFd;
  try {
    rootFd = openDirNoFollow(absPath);
  } catch (err) {
    if (err.code === "ENOENT") return { bytes: 0, files: 0, unmeasured: 0 };
    throw err;
  }
  let bytes = 0;
  let files = 0;
  let unmeasured = 0;
  const stack = [{ fd: rootFd, depth: 0, names: fs.readdirSync(fdPath(rootFd)), i: 0 }];
  try {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.names.length) {
        stack.pop();
        closeQuiet(top.fd);
        continue;
      }
      const name = top.names[top.i++];
      let st;
      try {
        st = fs.lstatSync(fdPath(top.fd, name));
      } catch {
        continue;
      }
      if (st.isFile()) {
        bytes += st.size;
        files += 1;
      } else if (st.isDirectory()) {
        if (top.depth + 1 > maxDepth) {
          unmeasured += 1;
          continue;
        }
        let fd;
        try {
          fd = openChildDir(top.fd, name);
        } catch {
          continue;
        }
        let names;
        try {
          names = fs.readdirSync(fdPath(fd));
        } catch {
          closeQuiet(fd);
          continue;
        }
        stack.push({ fd, depth: top.depth + 1, names, i: 0 });
      }
    }
  } finally {
    for (const frame of stack) closeQuiet(frame.fd);
  }
  return { bytes, files, unmeasured };
}

/**
 * `measureTree` without blocking the event loop: the same descriptor-relative, iterative, depth-capped
 * walk on fs.promises (the exchange-wide measurement runs on the call path; a large or deliberately
 * filled inbox must not stall every relay meanwhile).
 * @param {string} absPath
 * @param {number} [maxDepth]
 * @returns {Promise<{ bytes: number, files: number, unmeasured: number }>}
 */
export async function measureTreeAsync(absPath, maxDepth = MAX_WALK_DEPTH) {
  let root;
  try {
    root = await fsp.open(absPath, DIR_FLAGS);
  } catch (err) {
    if (err.code === "ENOENT") return { bytes: 0, files: 0, unmeasured: 0 };
    throw err;
  }
  let bytes = 0;
  let files = 0;
  let unmeasured = 0;
  /** @type {{fh: import("node:fs/promises").FileHandle, depth:number, names:string[], i:number}[]} */
  const stack = [];
  try {
    let rootNames;
    try {
      rootNames = await fsp.readdir(fdPath(root.fd));
    } catch (err) {
      await root.close().catch(() => {});
      throw err;
    }
    stack.push({ fh: root, depth: 0, names: rootNames, i: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i >= top.names.length) {
        stack.pop();
        await top.fh.close().catch(() => {});
        continue;
      }
      const name = top.names[top.i++];
      let st;
      try {
        st = await fsp.lstat(fdPath(top.fh.fd, name));
      } catch {
        continue;
      }
      if (st.isFile()) {
        bytes += st.size;
        files += 1;
      } else if (st.isDirectory()) {
        if (top.depth + 1 > maxDepth) {
          unmeasured += 1;
          continue;
        }
        let fh;
        try {
          fh = await fsp.open(fdPath(top.fh.fd, name), DIR_FLAGS);
        } catch {
          continue;
        }
        let names;
        try {
          names = await fsp.readdir(fdPath(fh.fd));
        } catch {
          await fh.close().catch(() => {});
          continue;
        }
        stack.push({ fh, depth: top.depth + 1, names, i: 0 });
      }
    }
  } finally {
    for (const frame of stack) await frame.fh.close().catch(() => {});
  }
  return { bytes, files, unmeasured };
}
