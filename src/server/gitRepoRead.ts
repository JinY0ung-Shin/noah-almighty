/**
 * Read-only access to a registered git repo's CANONICAL clone
 * (`dataDir/git-repos/<owner>/<name>`) for a run that has no sandbox copy of it
 * — a trusted colleague's chat with the owner's avatar (review #11, user
 * decision 2026-11-01: the owner's repository never lands in someone else's
 * sandbox). Backs `mcp__git_repo__list_files` / `read_file` / `grep`
 * (`agent/gitRepoTools.ts`), whose handlers do the access gating.
 *
 * Every read runs under the clone's `withRepoLock` (the key every sync, commit
 * and clone of it takes), so it never sees a working tree half-way through a
 * sync's checkout or a commit's file-by-file apply: list_files / read_file show
 * the clone's working tree as the last sync or commit left it.
 *
 * The clone's tree comes from the remote, so it may hold committed links:
 * every component of a path is lstat-checked from the clone root and a link
 * is never followed; a folder is listed and a file read only when the OPENED
 * descriptor's path is exactly the checked one (`listDirVerified`,
 * `readRegularFileAsync` — O_NOFOLLOW covers only the last component, so a
 * folder turned into a link in between is refused, never read through); `..`
 * and any `.git` component are refused, and every result is capped. `grep`
 * runs `git grep --cached` in the clone (Noah's own `.git`, `serverGitEnv`):
 * it searches the blobs in the clone's index (= its last commit or sync),
 * never the working tree, so a link is matched as its target text and never
 * followed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverGitEnv } from "./marketplace.js";
import { withRepoLock } from "./gitMutex.js";
import { listDirVerified } from "./pinnedFs.js";
import { readRegularFileAsync } from "./chatImages.js";

const READ_MAX_FILE_BYTES = 1024 * 1024;
const READ_DEFAULT_LINES = 2000;
const READ_MAX_CHARS = 100_000;
const LIST_MAX_ENTRIES = 1000;
const LIST_MAX_DEPTH = 16;
const GREP_MAX_BYTES = 64 * 1024;
const GREP_MAX_LINES = 400;
const GREP_MAX_LINE_CHARS = 400;
const GREP_MAX_PATTERN_CHARS = 500;
const GREP_TIMEOUT_MS = 30_000;

/** A refusal the tool returns as an error text (agent-facing English). */
export class RepoReadError extends Error {}

/**
 * `rel` (repo-relative, `/`-separated; empty = the root) checked component by
 * component without following anything. Returns the host path, its lstat and
 * the REAL path it must have (the clone root's real path + `rel`), which every
 * open is verified against.
 */
function resolveInRepo(root: string, rel: string): { abs: string; real: string; rel: string; stat: fs.Stats } {
  const cleaned = rel.trim().replace(/^\/+/, "");
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new RepoReadError("The path must stay inside the repository (no `..`).");
  if (parts.some((part) => part.toLowerCase() === ".git")) throw new RepoReadError("The repository's .git folder is not readable through this tool.");
  let current = root;
  let stat = fs.lstatSync(root);
  for (const [index, part] of parts.entries()) {
    if (!stat.isDirectory()) throw new RepoReadError(`'${parts.slice(0, index).join("/")}' is not a folder.`);
    current = path.join(current, part);
    const next = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!next) throw new RepoReadError(`'${parts.join("/")}' does not exist in the repository.`);
    if (next.isSymbolicLink()) throw new RepoReadError(`'${parts.slice(0, index + 1).join("/")}' is a link, which this tool does not follow.`);
    stat = next;
  }
  return { abs: current, real: path.join(fs.realpathSync(root), ...parts), rel: parts.join("/"), stat };
}

/** The files and folders under `rel` (recursive, links shown but never entered), capped. */
export function listRepoFiles(root: string, rel = ""): Promise<string> {
  return withRepoLock(root, async () => {
    const target = resolveInRepo(root, rel);
    if (!target.stat.isDirectory()) throw new RepoReadError(`'${target.rel}' is a file; read it with read_file.`);
    const out: string[] = [];
    let truncated = false;
    const visit = (abs: string, real: string, prefix: string, depth: number): void => {
      if (truncated) return;
      if (depth > LIST_MAX_DEPTH) {
        out.push(`${prefix}… (deeper folders not listed)`);
        return;
      }
      // Listed only when the opened folder is exactly the checked one.
      const entries = listDirVerified(abs, real);
      if (!entries) {
        if (depth === 0) throw new RepoReadError(`'${target.rel || "the repository root"}' could not be listed.`);
        out.push(`${prefix}… (could not be listed)`);
        return;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (entry.name === ".git") continue;
        if (out.length >= LIST_MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const name = `${prefix}${entry.name}`;
        if (entry.isSymbolicLink()) out.push(`${name} -> (link, not followed)`);
        else if (entry.isDirectory()) {
          out.push(`${name}/`);
          visit(path.join(abs, entry.name), path.join(real, entry.name), `${name}/`, depth + 1);
        } else if (entry.isFile()) out.push(name);
      }
    };
    visit(target.abs, target.real, target.rel ? `${target.rel}/` : "", 0);
    const head = `Files in ${target.rel || "the repository root"}${truncated ? ` (first ${LIST_MAX_ENTRIES}; list a subfolder with path to see more)` : ""}:`;
    return `${head}\n${out.join("\n") || "(empty)"}`;
  });
}

/** Lines `offset`..`offset+limit-1` (1-based) of a text file, capped. */
export function readRepoFile(root: string, rel: string, offset = 1, limit = READ_DEFAULT_LINES): Promise<string> {
  return withRepoLock(root, async () => {
    const target = resolveInRepo(root, rel);
    if (!target.rel) throw new RepoReadError("Name a file to read (list_files shows them).");
    if (target.stat.isDirectory()) throw new RepoReadError(`'${target.rel}' is a folder; list it with list_files.`);
    // The checked path must still resolve to itself (no folder on the way turned
    // into a link), and the opened descriptor must be exactly it (fdPathIs).
    let resolved: string;
    try {
      resolved = fs.realpathSync(target.abs);
    } catch {
      throw new RepoReadError(`'${target.rel}' could not be opened.`);
    }
    if (resolved !== target.real) throw new RepoReadError(`'${target.rel}' is reached through a link, which this tool does not follow.`);
    const read = await readRegularFileAsync(target.real, READ_MAX_FILE_BYTES);
    let data: Buffer;
    if ("buffer" in read) data = read.buffer;
    else if (read.error === "EMPTY") data = Buffer.alloc(0);
    else if (read.error === "NOT_FILE") throw new RepoReadError(`'${target.rel}' is not a regular file.`);
    else if (read.error === "TOO_LARGE") {
      throw new RepoReadError(
        `'${target.rel}' is ${target.stat.size} bytes, over the ${READ_MAX_FILE_BYTES / 1024 / 1024} MB limit of this tool; search it with grep instead.`,
      );
    } else throw new RepoReadError(`'${target.rel}' could not be opened.`);
    if (data.includes(0)) throw new RepoReadError(`'${target.rel}' is a binary file (${data.length} bytes); it cannot be shown as text.`);
    const lines = data.toString("utf8").split("\n");
    const start = Math.max(1, Math.floor(offset));
    const count = Math.max(1, Math.floor(limit));
    if (start > lines.length) throw new RepoReadError(`'${target.rel}' has ${lines.length} line(s); offset ${start} is past the end.`);
    let body = lines.slice(start - 1, start - 1 + count).join("\n");
    let end = Math.min(lines.length, start - 1 + count);
    if (body.length > READ_MAX_CHARS) {
      body = body.slice(0, READ_MAX_CHARS);
      end = start - 1 + body.split("\n").length;
    }
    const more = end < lines.length ? ` — continue with offset=${end + 1}` : "";
    return `${target.rel} (lines ${start}-${end} of ${lines.length}${more}):\n${body}`;
  });
}

/** `git grep --cached -n -I -E` in the canonical clone, optionally under `rel`; capped output. */
export function grepRepo(root: string, pattern: string, rel = "", ignoreCase = false): Promise<string> {
  if (!pattern) return Promise.reject(new RepoReadError("A search pattern is required."));
  if (pattern.length > GREP_MAX_PATTERN_CHARS) {
    return Promise.reject(new RepoReadError(`The pattern is longer than ${GREP_MAX_PATTERN_CHARS} characters.`));
  }
  return withRepoLock(root, () => grepLocked(root, pattern, rel, ignoreCase));
}

function grepLocked(root: string, pattern: string, rel: string, ignoreCase: boolean): Promise<string> {
  const target = resolveInRepo(root, rel);
  const args = ["-C", root, "grep", "--cached", "-n", "-I", "-E", "--no-color", ...(ignoreCase ? ["-i"] : []), "-e", pattern];
  if (target.rel) args.push("--", target.rel);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      env: { ...serverGitEnv(), GIT_LITERAL_PATHSPECS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, GREP_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (truncated) return; // keep draining while git is killed
      out += chunk;
      if (out.length > GREP_MAX_BYTES || out.split("\n").length > GREP_MAX_LINES) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (err.length < 2048) err += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new RepoReadError(`The search took longer than ${GREP_TIMEOUT_MS / 1000} s; narrow it with path or a simpler pattern.`));
      if (!truncated && code === 1) return resolve(`No matches for /${pattern}/${target.rel ? ` under ${target.rel}` : ""}.`);
      if (!truncated && code !== 0) return reject(new RepoReadError(`The search failed: ${err.trim().slice(0, 500) || `exit ${code}`}`));
      const lines = out
        .split("\n")
        .filter(Boolean)
        .slice(0, GREP_MAX_LINES)
        .map((line) => (line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line));
      if (truncated) lines.pop(); // the last line may be cut mid-way
      resolve(
        `${lines.length} matching line(s)${truncated ? " (truncated — narrow it with path or a more specific pattern)" : ""} as path:line:text:\n${lines.join("\n")}`,
      );
    });
  });
}
