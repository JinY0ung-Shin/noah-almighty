/**
 * Working-repo copies for pi runs (design D1, docs/architecture/pi-runtime.md).
 *
 * The CANONICAL clone of a registered git repo stays Noah-side
 * (`dataDir/git-repos/<owner>/<name>`): it is the only `.git` Noah ever runs git
 * in, with `serverGitEnv`'s hardening, and the only one the git token touches.
 * A pi run works on a COPY in the viewer's sandbox,
 * `/workspace/repos/<owner-seg>/<name>/` — working tree AND `.git`, plain files
 * (links are never copied), so the agent can use `git status`/`diff`/`log`
 * there. Noah NEVER executes git in that copy: its `.git` is agent-writable, and
 * hooks, fsmonitor, filters or `insteadOf` there would run or redirect inside
 * Noah. Instead `mcp__git_repo__commit` reads the copy's WORKING TREE back
 * (lstat only, links skipped, size-capped, `.git` skipped, ignore rules from
 * the canonical clone), applies it file by file to the canonical clone, and
 * commits there.
 *
 * Each copy records the canonical HEAD it was made from (its BASE) Noah-side,
 * in `dataDir/pi-repo-copies/<user-key>/` — never in the sandbox. A commit
 * whose canonical clone has moved since (another conversation committed, a
 * sync pulled, a colleague's copy landed first) is refused with a redirect to
 * re-open the repo: last writer wins, but never silently over a newer base.
 *
 * Everything under `repos/` is the sandbox's: the copy folder and its parents
 * are pinned by descriptor (`piSandboxDir`, `pinnedFs.ts`) for every write,
 * rename and removal, and the read-back verifies each listed folder and read
 * file by the OPENED descriptor's path, so a link the agent swaps in (even
 * while a commit's git runs) never redirects a write, a delete or a read out of
 * the copy.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../../types.js";
import { serverGitEnv } from "../../marketplace.js";
import { git } from "../../repoGitCore.js";
import { withRepoLock } from "../../gitMutex.js";
import { listDirVerified, readFileVerified, type PinnedDir } from "../../pinnedFs.js";
import { PI_SANDBOX_ROOT, piSandboxDir, piUserKey, removeNoFollow, type PiWorkspace } from "./piWorkspace.js";

/** Copy caps (canonical → sandbox). */
const COPY_MAX_FILES = 50_000;
const COPY_MAX_BYTES = 512 * 1024 * 1024;
/** Read-back caps (sandbox → canonical). */
const READBACK_MAX_ENTRIES = 100_000;
const READBACK_MAX_FILES = 20_000;
const READBACK_MAX_BYTES = 256 * 1024 * 1024;
const READBACK_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_COMMIT_MESSAGE_CHARS = 10_000;

/** A path segment for the owner id (UUIDs pass; anything else is hashed). */
function ownerSegment(ownerId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(ownerId)
    ? ownerId
    : `h-${createHash("sha256").update(ownerId, "utf8").digest("hex").slice(0, 32)}`;
}

/** `/workspace/repos/<owner-seg>/<name>` — what the model is told. */
export function piRepoCopySandboxPath(ownerId: string, name: string): string {
  return path.posix.join(PI_SANDBOX_ROOT, "repos", ownerSegment(ownerId), name);
}

/** `repos/<owner-seg>` of the viewer's sandbox, pinned (created 0700 with `create`); null when unusable. */
function pinnedCopyParent(workspace: PiWorkspace, ownerId: string, create: boolean): PinnedDir | null {
  if (!workspace.hostRoot) return null;
  return piSandboxDir(workspace, ["repos", ownerSegment(ownerId)], { create, mode: 0o700 });
}

/** The copy folder itself, pinned; null when missing or not a plain folder. */
function pinnedCopy(workspace: PiWorkspace, ownerId: string, name: string): PinnedDir | null {
  const parent = pinnedCopyParent(workspace, ownerId, false);
  if (!parent) return null;
  try {
    return parent.dir([name]);
  } finally {
    parent.close();
  }
}

interface CopyState {
  base: string;
  copiedAt: string;
}

function statePath(config: AppConfig, principal: string, ownerId: string, name: string): string {
  return path.join(config.dataDir, "pi-repo-copies", piUserKey(principal), `${ownerSegment(ownerId)}--${name}.json`);
}

/** Every Noah-side copy record of one user (account deletion sweeps it). */
export function piRepoCopyStateDir(config: AppConfig, principal: string): string {
  return path.join(config.dataDir, "pi-repo-copies", piUserKey(principal));
}

function readState(file: string): CopyState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CopyState>;
    return typeof parsed.base === "string" && /^[0-9a-f]{40,64}$/.test(parsed.base)
      ? { base: parsed.base, copiedAt: String(parsed.copiedAt ?? "") }
      : null;
  } catch {
    return null;
  }
}

function writeState(file: string, state: CopyState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function headOf(clone: string): Promise<string> {
  const { stdout } = await git(clone, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/** NUL-separated `git ls-files` output (canonical clone only). */
async function lsFiles(clone: string, args: string[]): Promise<string[]> {
  const { stdout } = await git(clone, ["ls-files", "-z", ...args], 120_000);
  return stdout.split("\0").filter(Boolean);
}

/** `git check-ignore --stdin -z` in the canonical clone: which of `paths` its ignore rules exclude. */
function checkIgnored(clone: string, paths: string[]): Promise<Set<string>> {
  if (paths.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", clone, "check-ignore", "--stdin", "-z"], {
      env: serverGitEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 0 = some ignored, 1 = none ignored, anything else = a real failure.
      if (code === 0 || code === 1) resolve(new Set(out.split("\0").filter(Boolean)));
      else reject(new Error(`git check-ignore failed: ${err.trim() || `exit ${code}`}`));
    });
    child.stdin.end(paths.join("\0") + "\0");
  });
}

/** Repo-relative POSIX path → host path under `root`, refusing `..`/absolute/odd segments. */
function under(root: string, rel: string): string | null {
  const parts = rel.split("/");
  if (!rel || rel.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) return null;
  return path.join(root, ...parts);
}

/**
 * lstat every component of `rel` below `root`: "file"/"dir" only when no
 * component on the way is a link; "missing" when the chain ends early at a
 * missing entry (no link on the way); "other" for links/specials.
 */
function kindNoFollow(root: string, rel: string): "file" | "dir" | "missing" | "other" {
  const parts = rel.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
    } catch {
      return "other";
    }
    if (!stat) return "missing";
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink()) return "other";
    if (!last && !stat.isDirectory()) return "other";
    if (last) return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  }
  return "other";
}

/** Write `data` as a file of Noah's CANONICAL clone (never the sandbox). */
function writeCanonicalFile(target: string, data: Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  removeNoFollow(target);
  fs.writeFileSync(target, data, { flag: "wx", mode });
  fs.chmodSync(target, mode);
}

/** Recursively copy a `.git` directory as plain files (links and specials skipped) into a pinned sandbox folder. */
function copyGitDir(source: string, target: PinnedDir, budget: { files: number; bytes: number }): void {
  const walk = (from: string, to: PinnedDir, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const stat = fs.lstatSync(src);
      if (stat.isDirectory()) {
        const sub = to.dir([entry.name], { create: true, mode: 0o755 });
        if (!sub) throw new Error(`The sandbox copy's .git/${entry.name} is not a plain folder.`);
        try {
          walk(src, sub, depth + 1);
        } finally {
          sub.close();
        }
      } else if (stat.isFile()) {
        budget.files += 1;
        budget.bytes += stat.size;
        if (budget.files > COPY_MAX_FILES || budget.bytes > COPY_MAX_BYTES) throw new CopyTooLargeError();
        to.copyFileIn(src, entry.name, stat.mode & 0o777);
      }
    }
  };
  walk(source, target, 0);
}

class CopyTooLargeError extends Error {
  constructor() {
    super(
      `The repository is too large to copy into the sandbox (limits: ${COPY_MAX_FILES} files, ${Math.round(COPY_MAX_BYTES / 1024 / 1024)} MB including .git).`,
    );
  }
}

/**
 * Fresh copy of the canonical clone (tracked + untracked-not-ignored files,
 * and `.git`) into the pinned, freshly made `target`: every folder pinned and
 * every file created exclusively, so a link raced into it fails the copy.
 */
async function writeFreshCopy(clone: string, target: PinnedDir): Promise<void> {
  const files = await lsFiles(clone, ["--cached", "--others", "--exclude-standard"]);
  const budget = { files: 0, bytes: 0 };
  const folders = new Map<string, PinnedDir>();
  try {
    for (const rel of new Set(files)) {
      const source = under(clone, rel);
      if (!source || !under(target.hostPath, rel) || kindNoFollow(clone, rel) !== "file") continue; // links, submodules, deleted
      const stat = fs.statSync(source);
      budget.files += 1;
      budget.bytes += stat.size;
      if (budget.files > COPY_MAX_FILES || budget.bytes > COPY_MAX_BYTES) throw new CopyTooLargeError();
      const parts = rel.split("/");
      const name = parts.pop()!;
      const key = parts.join("/");
      let folder = key ? folders.get(key) : target;
      if (!folder) {
        const opened = target.dir(parts, { create: true, mode: 0o755 });
        if (!opened) throw new Error(`The sandbox copy's '${key}' is not a plain folder.`);
        folders.set(key, opened);
        folder = opened;
      }
      folder.copyFileIn(source, name, stat.mode & 0o111 ? 0o755 : 0o644);
    }
  } finally {
    for (const folder of folders.values()) folder.close();
  }
  const gitDir = target.dir([".git"], { create: true, mode: 0o755 });
  if (!gitDir) throw new Error("The sandbox copy's .git is not a plain folder.");
  try {
    copyGitDir(path.join(clone, ".git"), gitDir, budget);
  } finally {
    gitDir.close();
  }
}

export interface PiRepoCopyRef {
  config: AppConfig;
  workspace: PiWorkspace;
  ownerId: string;
  /** Registered (normalized) repo name. */
  name: string;
  /** The canonical clone (`gitRepoClonePath`). */
  clonePath: string;
}

export interface EnsuredCopy {
  /** Sandbox path the model is told. */
  sandboxPath: string;
  /** "kept" = the existing copy is current; "created" = a fresh copy was written. */
  outcome: "kept" | "created";
  /** Sandbox path of the previous copy, when a stale one was moved aside. */
  previousPath?: string;
  base: string;
}

/**
 * Make sure the viewer's sandbox has a copy of the repo. `keep` (turn start,
 * open_repo) leaves an existing copy alone when it was made from the current
 * canonical HEAD — the agent's uncommitted work stays; `when-missing` (turn
 * start) never touches an existing copy; `refresh` (after a sync) always
 * writes a fresh one. A copy that is replaced is first moved aside to
 * `<name>.prev` (replacing an older one) so no edit is silently lost.
 * Serialized with every other operation on the canonical clone.
 */
export function ensurePiRepoCopy(
  ref: PiRepoCopyRef,
  mode: "keep" | "when-missing" | "refresh",
): Promise<EnsuredCopy> {
  return withRepoLock(ref.clonePath, () => ensureCopyLocked(ref, mode));
}

async function ensureCopyLocked(ref: PiRepoCopyRef, mode: "keep" | "when-missing" | "refresh"): Promise<EnsuredCopy> {
  if (!ref.workspace.hostRoot) {
    throw new Error("The sandbox workspace mount is not configured, so the repository cannot be copied into the sandbox.");
  }
  const sandboxPath = piRepoCopySandboxPath(ref.ownerId, ref.name);
  const stateFile = statePath(ref.config, ref.workspace.principal, ref.ownerId, ref.name);
  const head = await headOf(ref.clonePath);
  const state = readState(stateFile);
  // `repos/<owner>` pinned for the whole operation: a planted link there (or
  // one swapped in while git runs) is refused, never followed.
  const parent = pinnedCopyParent(ref.workspace, ref.ownerId, true);
  if (!parent) throw new Error("The sandbox folder for repository copies is not a plain folder; remove it and retry.");
  try {
    const existing = parent.kind(ref.name);
    if (existing === "dir" && state && (mode === "when-missing" || (mode === "keep" && state.base === head))) {
      return { sandboxPath, outcome: "kept", base: state.base };
    }
    const tmpName = `.${ref.name}.tmp-${randomBytes(4).toString("hex")}`;
    const tmp = parent.dir([tmpName], { create: true, mode: 0o755 });
    if (!tmp) throw new Error("The sandbox folder for repository copies is not writable.");
    try {
      await writeFreshCopy(ref.clonePath, tmp);
    } catch (error) {
      tmp.close();
      parent.remove(tmpName);
      throw error;
    }
    tmp.close();
    let previousPath: string | undefined;
    if (existing !== "missing") {
      parent.remove(`${ref.name}.prev`);
      if (existing === "dir") {
        parent.rename(ref.name, `${ref.name}.prev`);
        previousPath = `${sandboxPath}.prev`;
      } else {
        parent.remove(ref.name);
      }
    }
    parent.rename(tmpName, ref.name);
    writeState(stateFile, { base: head, copiedAt: new Date().toISOString() });
    return { sandboxPath, outcome: "created", base: head, ...(previousPath ? { previousPath } : {}) };
  } finally {
    parent.close();
  }
}

export interface CopyChanges {
  /**
   * Files to write into the canonical clone (repo-relative), with the sandbox
   * source: `source` is its I/O path through the pinned copy, `real` the exact
   * path the opened file must have (re-verified when it is read).
   */
  writes: { rel: string; source: string; real: string; exec: boolean }[];
  /** Files to delete from the canonical clone. */
  deletes: string[];
  /** Entries that were left alone (links, specials, type changes), repo-relative. */
  skipped: string[];
}

/**
 * Read the sandbox copy's working tree back against the canonical clone:
 * which files differ (content or exec bit), which canonical files the copy
 * deleted, and what was skipped. lstat-only walk, `.git` skipped at every
 * level, links never followed, directories the canonical ignore rules exclude
 * pruned (a tracked file inside one is still compared), and caps on entries,
 * files and bytes. Never runs anything in the copy. Every folder listed and
 * every file read is checked by its OPENED descriptor's path against the
 * pinned copy's real path, so a folder the agent swaps for a link mid-walk is
 * skipped instead of read through.
 */
async function readBack(clone: string, pinned: PinnedDir): Promise<CopyChanges> {
  const copyReal = pinned.realPath();
  if (!copyReal) throw new Error("The working copy could not be resolved; open the repository again.");
  const copy = pinned.base(); // for lstat-only checks and the verified reads below
  const real = (rel: string): string => (rel ? path.join(copyReal, ...rel.split("/")) : copyReal);
  const tracked = new Set([
    ...(await lsFiles(clone, ["--cached"])),
    ...(await lsFiles(clone, ["--others", "--exclude-standard"])),
  ]);
  const seen = new Set<string>();
  const skipped: string[] = [];
  let entries = 0;
  let level: string[] = [""];
  for (let depth = 0; level.length > 0 && depth <= MAX_DEPTH; depth += 1) {
    const files: string[] = [];
    const dirs: string[] = [];
    for (const dirRel of level) {
      const names = listDirVerified(pinned.descendant(dirRel), real(dirRel));
      if (!names) {
        if (dirRel) skipped.push(dirRel); // swapped for a link (or gone) since it was listed
        continue;
      }
      for (const entry of names) {
        if (entry.name === ".git") continue;
        entries += 1;
        if (entries > READBACK_MAX_ENTRIES) {
          throw new Error(
            `The working copy has more than ${READBACK_MAX_ENTRIES} entries outside ignored folders; remove build output or add it to .gitignore, then commit again.`,
          );
        }
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) skipped.push(rel);
        else if (entry.isDirectory()) dirs.push(rel);
        else if (entry.isFile()) files.push(rel);
        else skipped.push(rel);
      }
    }
    const ignored = await checkIgnored(clone, [...files, ...dirs.map((rel) => `${rel}/`)]);
    for (const rel of files) if (!ignored.has(rel)) seen.add(rel);
    level = dirs.filter((rel) => !ignored.has(`${rel}/`) && !ignored.has(rel));
  }
  // A tracked file under a pruned (ignored) folder is still part of the commit.
  for (const rel of tracked) if (!seen.has(rel) && kindNoFollow(copy, rel) === "file") seen.add(rel);

  const writes: CopyChanges["writes"] = [];
  let bytes = 0;
  for (const rel of seen) {
    const source = under(copy, rel);
    const target = under(clone, rel);
    if (!source || !target) {
      skipped.push(rel);
      continue;
    }
    const stat = fs.lstatSync(source);
    if (stat.size > READBACK_MAX_FILE_BYTES) {
      throw new Error(`'${rel}' is larger than ${Math.round(READBACK_MAX_FILE_BYTES / 1024 / 1024)} MB; it cannot be committed from the sandbox.`);
    }
    const exec = (stat.mode & 0o111) !== 0;
    const canonical = kindNoFollow(clone, rel);
    if (canonical === "other" || canonical === "dir") {
      skipped.push(rel); // a tracked link / a folder in Noah's clone: never written through
      continue;
    }
    if (canonical === "file") {
      const current = fs.statSync(target);
      if (current.size === stat.size && ((current.mode & 0o111) !== 0) === exec && sameBytes(source, real(rel), target)) continue;
    }
    bytes += stat.size;
    if (writes.length + 1 > READBACK_MAX_FILES || bytes > READBACK_MAX_BYTES) {
      throw new Error(
        `The change set is too large to commit from the sandbox (limits: ${READBACK_MAX_FILES} changed files, ${Math.round(READBACK_MAX_BYTES / 1024 / 1024)} MB).`,
      );
    }
    writes.push({ rel, source, real: real(rel), exec });
  }
  const deletes: string[] = [];
  for (const rel of tracked) {
    if (seen.has(rel)) continue;
    const inCopy = kindNoFollow(copy, rel);
    // Only a file that is really GONE from the copy is deleted; a link or a
    // folder where it was (or a link on the way) is left alone.
    if (inCopy === "missing" && kindNoFollow(clone, rel) === "file") deletes.push(rel);
    else if (inCopy !== "missing" && inCopy !== "file") skipped.push(rel);
  }
  return { writes, deletes, skipped: [...new Set(skipped)] };
}

/** The sandbox file (verified read) holds the same bytes as the canonical one. */
function sameBytes(source: string, sourceReal: string, canonical: string): boolean {
  try {
    const data = readFileVerified(source, sourceReal, READBACK_MAX_FILE_BYTES);
    return data !== null && data.equals(fs.readFileSync(canonical));
  } catch {
    return false;
  }
}

export type CopyStatus =
  | { kind: "no_copy" }
  | { kind: "moved"; base: string; head: string }
  | { kind: "ok"; base: string; changes: CopyChanges };

/** Where the copy stands against the canonical clone (no writes anywhere). */
export function piRepoCopyStatus(ref: PiRepoCopyRef): Promise<CopyStatus> {
  return withRepoLock(ref.clonePath, async () => {
    const state = readState(statePath(ref.config, ref.workspace.principal, ref.ownerId, ref.name));
    const copy = state ? pinnedCopy(ref.workspace, ref.ownerId, ref.name) : null;
    if (!copy || !state) return { kind: "no_copy" };
    try {
      const head = await headOf(ref.clonePath);
      if (head !== state.base) return { kind: "moved", base: state.base, head };
      return { kind: "ok", base: state.base, changes: await readBack(ref.clonePath, copy) };
    } finally {
      copy.close();
    }
  });
}

export type CommitOutcome =
  | { kind: "no_copy" }
  | { kind: "moved"; base: string; head: string }
  | { kind: "nothing" ; skipped: string[] }
  | { kind: "committed"; commit: string; written: number; deleted: number; skipped: string[] };

/**
 * Apply the copy's working tree to the canonical clone and commit it there
 * (`git add -A` + `git commit`, `serverGitEnv`), refusing when the canonical
 * clone moved since the copy's base. On success the copy's `.git` is replaced
 * by a fresh copy of the canonical one (so `git status` in the sandbox is clean
 * again) and the new HEAD becomes its base.
 */
export function commitPiRepoCopy(ref: PiRepoCopyRef, message: string): Promise<CommitOutcome> {
  const text = message.trim();
  if (!text) return Promise.reject(new Error("A commit message is required."));
  if (text.length > MAX_COMMIT_MESSAGE_CHARS) {
    return Promise.reject(new Error(`The commit message is longer than ${MAX_COMMIT_MESSAGE_CHARS} characters.`));
  }
  return withRepoLock(ref.clonePath, async () => {
    const stateFile = statePath(ref.config, ref.workspace.principal, ref.ownerId, ref.name);
    const state = readState(stateFile);
    // The copy is pinned for the WHOLE commit: git runs for a while, and a
    // link swapped in meanwhile must not redirect the `.git` refresh below.
    const copy = state ? pinnedCopy(ref.workspace, ref.ownerId, ref.name) : null;
    if (!copy || !state) return { kind: "no_copy" };
    try {
      const head = await headOf(ref.clonePath);
      if (head !== state.base) return { kind: "moved", base: state.base, head };
      const changes = await readBack(ref.clonePath, copy);
      for (const write of changes.writes) {
        const data = readFileVerified(write.source, write.real, READBACK_MAX_FILE_BYTES);
        if (!data) throw new Error(`'${write.rel}' changed in the sandbox while it was being committed; commit again.`);
        writeCanonicalFile(under(ref.clonePath, write.rel)!, data, write.exec ? 0o755 : 0o644);
      }
      for (const rel of changes.deletes) {
        fs.unlinkSync(under(ref.clonePath, rel)!);
      }
      await git(ref.clonePath, ["add", "-A"]);
      const staged = await git(ref.clonePath, ["diff", "--cached", "--quiet"]).then(
        () => false,
        () => true,
      );
      if (!staged) return { kind: "nothing", skipped: changes.skipped };
      await git(ref.clonePath, ["commit", "-q", "-m", text]);
      const commit = await headOf(ref.clonePath);
      // The sandbox `.git` is now behind: refresh it so the agent's status is clean.
      copy.remove(".git");
      const gitDir = copy.dir([".git"], { create: true, mode: 0o755 });
      if (gitDir) {
        try {
          copyGitDir(path.join(ref.clonePath, ".git"), gitDir, { files: 0, bytes: 0 });
        } finally {
          gitDir.close();
        }
      }
      writeState(stateFile, { base: commit, copiedAt: new Date().toISOString() });
      return {
        kind: "committed",
        commit,
        written: changes.writes.length,
        deleted: changes.deletes.length,
        skipped: changes.skipped,
      };
    } finally {
      copy.close();
    }
  });
}

/** Remove the viewer's copy (and its record) of a repo that was unregistered. Best effort. */
export function removePiRepoCopy(ref: Omit<PiRepoCopyRef, "clonePath">): void {
  const parent = pinnedCopyParent(ref.workspace, ref.ownerId, false);
  if (parent) {
    try {
      parent.remove(ref.name);
      parent.remove(`${ref.name}.prev`);
    } finally {
      parent.close();
    }
  }
  removeNoFollow(statePath(ref.config, ref.workspace.principal, ref.ownerId, ref.name));
}
