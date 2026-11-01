/**
 * Read-only access to a registered git repo's CANONICAL clone
 * (`dataDir/git-repos/<owner>/<name>`) for a run that has no sandbox copy of it
 * — a trusted colleague's chat with the owner's avatar (review #11, user
 * decision 2026-11-01: the owner's repository never lands in someone else's
 * sandbox). Backs `mcp__git_repo__list_files` / `read_file` / `grep`
 * (`agent/gitRepoTools.ts`), whose handlers do the access gating.
 *
 * The clone's tree comes from the remote, so it may hold committed links:
 * every component of a path is lstat-checked from the clone root and a link
 * is never followed, files are opened O_NOFOLLOW, `..` and any `.git`
 * component are refused, and every result is capped. `grep` runs `git grep
 * --cached` in the clone (Noah's own `.git`, `serverGitEnv`): it searches the
 * committed blobs, never the working tree, so a link is matched as its target
 * text and never followed.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serverGitEnv } from "./marketplace.js";

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
 * component without following anything. Returns the host path and its lstat.
 */
function resolveInRepo(root: string, rel: string): { abs: string; rel: string; stat: fs.Stats } {
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
  return { abs: current, rel: parts.join("/"), stat };
}

/** The files and folders under `rel` (recursive, links shown but never entered), capped. */
export function listRepoFiles(root: string, rel = ""): string {
  const target = resolveInRepo(root, rel);
  if (!target.stat.isDirectory()) throw new RepoReadError(`'${target.rel}' is a file; read it with read_file.`);
  const out: string[] = [];
  let truncated = false;
  const visit = (abs: string, prefix: string, depth: number): void => {
    if (truncated) return;
    if (depth > LIST_MAX_DEPTH) {
      out.push(`${prefix}… (deeper folders not listed)`);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
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
        visit(path.join(abs, entry.name), `${name}/`, depth + 1);
      } else if (entry.isFile()) out.push(name);
    }
  };
  visit(target.abs, target.rel ? `${target.rel}/` : "", 0);
  const head = `Files in ${target.rel || "the repository root"}${truncated ? ` (first ${LIST_MAX_ENTRIES}; list a subfolder with path to see more)` : ""}:`;
  return `${head}\n${out.join("\n") || "(empty)"}`;
}

/** Lines `offset`..`offset+limit-1` (1-based) of a text file, capped. */
export function readRepoFile(root: string, rel: string, offset = 1, limit = READ_DEFAULT_LINES): string {
  const target = resolveInRepo(root, rel);
  if (!target.rel) throw new RepoReadError("Name a file to read (list_files shows them).");
  if (target.stat.isDirectory()) throw new RepoReadError(`'${target.rel}' is a folder; list it with list_files.`);
  let fd: number;
  try {
    fd = fs.openSync(target.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new RepoReadError(`'${target.rel}' could not be opened.`);
  }
  let data: Buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new RepoReadError(`'${target.rel}' is not a regular file.`);
    if (stat.size > READ_MAX_FILE_BYTES) {
      throw new RepoReadError(
        `'${target.rel}' is ${stat.size} bytes, over the ${READ_MAX_FILE_BYTES / 1024 / 1024} MB limit of this tool; search it with grep instead.`,
      );
    }
    data = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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
}

/** `git grep --cached -n -I -E` in the canonical clone, optionally under `rel`; capped output. */
export function grepRepo(root: string, pattern: string, rel = "", ignoreCase = false): Promise<string> {
  if (!pattern) return Promise.reject(new RepoReadError("A search pattern is required."));
  if (pattern.length > GREP_MAX_PATTERN_CHARS) {
    return Promise.reject(new RepoReadError(`The pattern is longer than ${GREP_MAX_PATTERN_CHARS} characters.`));
  }
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
