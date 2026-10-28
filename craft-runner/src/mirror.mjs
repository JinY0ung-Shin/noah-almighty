// One-way tree mirroring with strict file rules (spec §3 sync_in / sync_out).
// `planMirror` is pure (listing in, plan out) so the rules are unit-testable without a filesystem;
// `mirrorTree` walks both trees through descriptors (fsx.mjs) and applies the plan.

import path from "node:path";
import fs from "node:fs";
import {
  closeQuiet,
  copyFileBetween,
  CopyRejected,
  ensureChildDir,
  openChildDir,
  openDirNoFollow,
  removeEntry,
  walkTree,
} from "./fsx.mjs";
import { nameProblem } from "./paths.mjs";

const isUnder = (p, ancestor) => p === ancestor || p.startsWith(`${ancestor}/`);
const sameMtime = (a, b) => Math.abs(a - b) < 1;

/**
 * Plan a mirror from a source listing onto a destination listing.
 * @param {{entries: any[], rejected: {path:string,reason:string}[]}} src
 * @param {{entries: any[], foreign: string[]}} dst
 * @param {{maxFileBytes:number,maxTotalBytes:number,maxFiles:number,maxDirs:number}} limits
 * @param {{rejectHardlinks?: boolean}} [opts]
 */
export function planMirror(src, dst, limits, { rejectHardlinks = false } = {}) {
  const rejected = [...src.rejected];
  const blocked = [];
  const accepted = new Map();
  let files = 0;
  let dirs = 0;
  let total = 0;
  for (const e of src.entries) {
    if (blocked.some((b) => isUnder(e.path, b))) continue;
    if (e.type === "dir") {
      if (dirs >= limits.maxDirs) {
        rejected.push({ path: e.path, reason: `directory count cap (${limits.maxDirs}) reached` });
        blocked.push(e.path);
        continue;
      }
      dirs += 1;
      accepted.set(e.path, e);
      continue;
    }
    if (rejectHardlinks && (e.nlink ?? 1) > 1) {
      rejected.push({ path: e.path, reason: "hard link rejected" });
      continue;
    }
    if (e.size > limits.maxFileBytes) {
      rejected.push({ path: e.path, reason: `file exceeds the ${fmtBytes(limits.maxFileBytes)} per-file cap` });
      continue;
    }
    if (files >= limits.maxFiles) {
      rejected.push({ path: e.path, reason: `file count cap (${limits.maxFiles}) reached` });
      continue;
    }
    if (total + e.size > limits.maxTotalBytes) {
      rejected.push({ path: e.path, reason: `total size cap (${fmtBytes(limits.maxTotalBytes)}) reached` });
      continue;
    }
    files += 1;
    total += e.size;
    accepted.set(e.path, e);
  }

  const dstByPath = new Map(dst.entries.map((e) => [e.path, e]));
  const removeSet = new Set(dst.foreign);
  for (const d of dst.entries) {
    const want = accepted.get(d.path);
    if (!want || want.type !== d.type) removeSet.add(d.path);
  }
  const removes = [...removeSet]
    .sort()
    .filter((p, _i, all) => !all.some((q) => q !== p && isUnder(p, q)));

  const mkdirs = [];
  const copies = [];
  let unchanged = 0;
  for (const e of accepted.values()) {
    if (e.type === "dir") {
      mkdirs.push(e.path);
      continue;
    }
    const have = dstByPath.get(e.path);
    const removed = removes.some((r) => isUnder(e.path, r));
    if (have && !removed && have.type === "file" && have.size === e.size && sameMtime(have.mtimeMs, e.mtimeMs)) {
      unchanged += 1;
    } else {
      copies.push(e);
    }
  }
  return {
    mkdirs,
    copies,
    removes,
    unchanged,
    rejected,
    files: [...accepted.values()].filter((e) => e.type === "file"),
  };
}

function fmtBytes(n) {
  if (n >= 1024 ** 3 && n % 1024 ** 3 === 0) return `${n / 1024 ** 3} GiB`;
  if (n >= 1024 ** 2 && n % 1024 ** 2 === 0) return `${n / 1024 ** 2} MiB`;
  return `${n} bytes`;
}

/** Lazily open nested directories below a root descriptor, caching descriptors by relative path. */
function dirOpener(rootFd, openChild) {
  const cache = new Map([["", rootFd]]);
  const get = (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const parent = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const fd = openChild(get(parent), path.posix.basename(rel));
    cache.set(rel, fd);
    return fd;
  };
  const closeAll = () => {
    for (const [rel, fd] of cache) if (rel !== "") closeQuiet(fd);
  };
  return { get, closeAll };
}

/**
 * Open a mirror root, treating a missing source as an empty tree.
 * Throws if the path exists but is not a real directory (e.g. a symlink planted in its place).
 */
function openRoot(absPath, { missingOk }) {
  try {
    return openDirNoFollow(absPath);
  } catch (err) {
    if (missingOk && err.code === "ENOENT") return null;
    if (err.code === "ELOOP" || err.code === "ENOTDIR") throw new Error(`${absPath} is not a directory`);
    throw err;
  }
}

/**
 * Mirror `srcAbs` onto `dstAbs` (which must already exist as a real directory).
 * @param {object} o
 * @param {string} o.srcAbs
 * @param {string} o.dstAbs
 * @param {object} o.limits  DEFAULT_LIMITS-shaped
 * @param {{uid:number,gid:number}|null} o.owner  owner for created files and dirs (null = unchanged)
 * @param {number} o.fileMode
 * @param {number} o.dirMode
 * @param {boolean} [o.rejectHardlinks]
 */
export async function mirrorTree(o) {
  const walkOpts = { maxDepth: o.limits.maxDepth, nameProblem };
  const srcFd = openRoot(o.srcAbs, { missingOk: true });
  const dstFd = openRoot(o.dstAbs, { missingOk: false });
  try {
    const src = srcFd === null ? { entries: [], rejected: [], foreign: [], bytes: 0, unmeasured: 0 } : walkTree(srcFd, walkOpts);
    // The destination is walked with the SAME depth cap: anything deeper (planted by a writer of the
    // destination) is `foreign` and removed by the iterative, depth-bounded removeEntry.
    const dst = walkTree(dstFd, walkOpts);
    const plan = planMirror(src, dst, o.limits, { rejectHardlinks: o.rejectHardlinks });
    const dstDirs = dirOpener(dstFd, (fd, name) => ensureChildDir(fd, name, { owner: o.owner, mode: o.dirMode }));
    const srcDirs = srcFd === null ? null : dirOpener(srcFd, openChildDir);
    const rejected = plan.rejected;
    const failed = new Set();
    let removed = 0;
    let copied = 0;
    let bytes = 0;
    try {
      for (const rel of plan.removes) {
        const parent = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
        try {
          removeEntry(dstDirs.get(parent), path.posix.basename(rel));
          removed += 1;
        } catch (err) {
          rejected.push({ path: rel, reason: `could not remove stale entry (${err.code ?? err.message})` });
        }
      }
      for (const rel of plan.mkdirs) dstDirs.get(rel);
      for (const e of plan.copies) {
        const parent = path.posix.dirname(e.path) === "." ? "" : path.posix.dirname(e.path);
        const name = path.posix.basename(e.path);
        let dstParent;
        try {
          dstParent = dstDirs.get(parent);
          bytes += await copyFileBetween(srcDirs.get(parent), name, dstParent, name, {
            expect: { ino: e.ino, dev: e.dev },
            maxBytes: o.limits.maxFileBytes,
            owner: o.owner,
            mode: o.fileMode,
            rejectHardlinks: o.rejectHardlinks,
          });
          copied += 1;
        } catch (err) {
          failed.add(e.path);
          const reason = err instanceof CopyRejected ? err.message : `copy failed (${err.code ?? err.message})`;
          rejected.push({ path: e.path, reason });
          if (dstParent !== undefined) {
            try {
              removeEntry(dstParent, name);
            } catch {
              /* best effort: leave the stale copy for the next sync */
            }
          }
        }
      }
    } finally {
      dstDirs.closeAll();
      srcDirs?.closeAll();
    }
    return {
      copied,
      removed,
      skipped: plan.unchanged,
      bytes,
      rejected: capRejected(rejected, o.limits.maxRejectedListed),
      rejectedTotal: rejected.length,
      /** Every regular file in the source walk (before caps) and the directories it could not see into. */
      srcBytes: src.bytes,
      srcUnmeasured: src.unmeasured,
      files: plan.files
        .filter((f) => !failed.has(f.path))
        .map((f) => ({ path: f.path, size: f.size, mtimeMs: Math.trunc(f.mtimeMs) })),
    };
  } finally {
    if (srcFd !== null) closeQuiet(srcFd);
    closeQuiet(dstFd);
  }
}

/** Top-level directory whose rejections are never truncated: Noah's stage tool checks its own file there (N7). */
export const STAGED_DIR = "staged";

/**
 * Truncate a rejection list for the reply: EVERY `staged/…` entry first (never cut — the sorted walk
 * puts staged/ last, so a plain slice dropped exactly the entries the stage tool looks for), then the
 * rest up to `cap`. Pure.
 * @param {{path:string}[]} rejected
 * @param {number} cap
 */
export function capRejected(rejected, cap) {
  const isStaged = (r) => r.path === STAGED_DIR || r.path.startsWith(`${STAGED_DIR}/`);
  return [...rejected.filter(isStaged), ...rejected.filter((r) => !isStaged(r)).slice(0, cap)];
}

/** Make sure an absolute directory exists as a REAL directory owned/moded as given (boot layout). */
export function ensureDirAt(parentAbs, name, { owner, mode }) {
  const parentFd = openDirNoFollow(parentAbs);
  try {
    closeQuiet(ensureChildDir(parentFd, name, { owner, mode }));
  } finally {
    closeQuiet(parentFd);
  }
}

/** Ownership of an existing path without following a final symlink (null when missing). */
export function lstatOwner(absPath) {
  try {
    const st = fs.lstatSync(absPath);
    return { uid: st.uid, gid: st.gid, isDir: st.isDirectory() };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
