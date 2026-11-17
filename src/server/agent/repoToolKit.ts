// CRUD skeleton for the personal knowledge-repo MCP server (`repoTools.ts`).
// It was shared with the group repo server until group knowledge repositories
// were retired (2026-10-30), which is why the runners are parameterized.
//
// The server exposes the file-CRUD tools — list_files / read_file / write_file /
// scaffold_skill / commit — over a guard → resolve → ensureClone → op → decode
// pipeline. This module factors the loop body — the owner gate, the
// resolve→clone→op→decode try/catch, and the shared (English, agent-facing)
// error messages — into small parameterized runners. The caller still owns its
// own `tool()` descriptions, argument schemas, success strings, and audit calls.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vaultHoldPushStop } from "../knowledgeRepo.js";
import { scrubGitError } from "../marketplace.js";
import { MemoryRefusedError, MemoryUnavailableError } from "../memory/memoryClient.js";
import { VAULT_HOME_CHANGED, isPersonalVaultPath, normalizeVaultPath, type MemoryVault } from "../personalVault.js";
import { decodeRepoFsError, text } from "./mcpTools.js";

/** Shared owner-only refusal text. */
export const OWNER_ONLY = "This tool can only be used by the avatar owner.";

/** Shared commit-tool refusal when no internal Git token is registered. */
export const NO_GIT_TOKEN = "To push, please first register an internal Git token (GIT_TOKEN) in settings.";

/** Shared commit-tool message when the working tree has nothing to commit. */
export const NO_CHANGES = "There are no changes to commit.";

/**
 * The create_repo name validation: `name` is required and
 * must match `/^[A-Za-z0-9._-]{1,100}$/`; `org` (when present) must match the same
 * pattern. Returns the trimmed values on success, or the byte-identical refusal
 * text (returned to the model verbatim) on failure. `units.test.ts` asserts the
 * "letters/digits" wording, so the strings stay byte-for-byte here.
 */
export type RepoNameValidation =
  | { ok: true; name: string; org: string }
  | { ok: false; message: string };

export function validateRepoCreateNames(rawName: string, rawOrg?: string): RepoNameValidation {
  const name = rawName.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return { ok: false, message: "The repository name may only use letters/digits and the characters - _ ." };
  }
  const org = (rawOrg ?? "").trim();
  if (org && !/^[A-Za-z0-9._-]{1,100}$/.test(org)) {
    return { ok: false, message: "The organization name may only use letters/digits and the characters - _ ." };
  }
  return { ok: true, name, org };
}

/**
 * The shared create_repo failure message (remote-create returned `ok:false`),
 * including the no-Bash-fallback hint. Takes
 * the normalized target host and the failed `CreateRepoResult`-shaped result.
 */
export function createRepoFailureMessage(
  targetHost: string,
  result: { status?: number; exitCode?: number; message: string },
): string {
  const status = result.status ? `, HTTP ${result.status}` : "";
  const exitCode = result.exitCode ? `, exit ${result.exitCode}` : "";
  return `Failed to create GitHub repository (host: ${targetHost}${status}${exitCode}): ${result.message}\nCheck whether the token (GIT_TOKEN) has repo-creation permission and whether a repository with the same name already exists. Do not work around this with Bash \`gh\`/git — the shell has no git credentials.`;
}

/** The shared create_repo outer-catch message. */
export function createRepoCatchMessage(targetHost: string, error: unknown): string {
  return `Error while creating GitHub repository (host: ${targetHost}): ${scrubGitError(error)}`;
}

/** Render a `listTree` result (dirs get a trailing slash). */
export function formatTree(entries: Array<{ type: string; path: string }>): string {
  return entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
}

/**
 * The error message returned when a clone fails (load failure):
 * identical text including the no-Bash-fallback hint line. `units.test.ts` and the
 * CLAUDE.md "git remote work is MCP-only" rule depend on this wording.
 */
export function cloneFailureMessage(error: unknown): string {
  return `Failed to load the repository: ${scrubGitError(error)}\nCheck the repository address/branch and token permissions. Do not clone directly with Bash git — the shell has no git credentials.`;
}

/**
 * The shared commit/push failure message (with the no-Bash-fallback hint). A
 * `REBASE_CONFLICT:<files>` sentinel (the pre-push rebase in commitAndPushClone
 * hit a conflicting external change) gets its own explanation — the generic
 * token/branch-protection hint would point the model at the wrong cause.
 */
export function commitFailureMessage(error: unknown): string {
  const detail = scrubGitError(error);
  const conflict = /^REBASE_CONFLICT:([\s\S]*)$/.exec(detail);
  if (conflict) {
    const files = conflict[1].trim();
    return (
      `Commit/push failed: the remote branch has new commits that CONFLICT with this change${files ? ` (conflicting file(s): ${files})` : ""}. ` +
      "The local commit is preserved, but it cannot be pushed until the conflict is resolved. Tell the user that the same file(s) were changed outside this conversation (e.g. a direct push, or another chat that already pushed), and that the repository owner/admin needs to reconcile it manually. Do not retry in a loop, and do not work around this with Bash `git` — the shell has no git credentials."
    );
  }
  return `Commit/push failed: ${detail}\nCheck the write permission of the token (GIT_TOKEN) and the remote branch protection settings. Do not work around this with Bash \`git push\` — the shell has no git credentials.`;
}

/**
 * The refusal for a push of the knowledge clone that was stopped because it
 * would change vault notes while their copy is on hold (`VAULT_ON_HOLD_PUSH`,
 * knowledgeRepo.ts) — null for any other failure. The general message's
 * token/branch-protection hint would name the wrong cause. `after` = what
 * gets the kept changes out once the hold has ended: for `commit` the same
 * call again; for a tool that wrote files first (learning or unlinking a
 * skill) a commit of the repository — repeating THAT call would find its own
 * leftover ("already exists", "nothing to unlink").
 */
export function vaultHoldPushRefusal(error: unknown, after: "again" | "commit" = "again"): string | null {
  const stopped = vaultHoldPushStop(error);
  if (!stopped) return null;
  const wait =
    stopped.hold === "confirm"
      ? "the connected repository (or branch) holds vault notes of its own, and nothing there is changed until the owner confirms in 설정 → 지식·플러그인 → 지식 저장소 (or connects another repository)"
      : "Noah has not finished looking at the newly connected repository (or branch) — `mcp__system__describe_system` shows the state";
  return (
    `Nothing was committed or pushed: this push would change vault notes in the repository (${stopped.files}) while the repository's copy of the vault notes is ON HOLD — ${wait}. ` +
    (after === "commit"
      ? "What this call changed is kept, uncommitted, in the server's copy of the repository: once the hold has ended, call `mcp__repo__commit` to push it — do NOT repeat this call (it would find its own files there); tell the user that. "
      : "The changes are kept, uncommitted, in the server's copy of the repository: do the same again once the hold has ended; tell the user that, and do not retry in a loop. ") +
    "If the server's copy of the repository is still on a previous branch (the branch was changed while there were uncommitted changes), the look at the new branch cannot finish until that is resolved: the owner sets the branch back, has these changes committed there, and switches again. " +
    "The notes themselves are saved in the vault. Do not work around this with Bash `git` — the shell has no git credentials."
  );
}

/** read_file's shared error decode. */
export function readFileErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    tooLarge: "The file is too large.",
    notAFile: "Not a file.",
    fallback: "Failed to read the file",
  });
}

/** write_file's shared error decode. */
export function writeFileErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    tooLarge: "The content is too large.",
    fallback: "Failed to save the file",
  });
}

/**
 * edit_file's shared error decode. Adds the edit-specific sentinels (NOT_FOUND /
 * STRING_NOT_FOUND / STRING_NOT_UNIQUE / NO_CHANGE) with a redirect that tells the
 * model how to recover, then falls back to the shared FS decode.
 */
export function editFileErrorMessage(error: unknown): string {
  const detail = scrubGitError(error);
  if (detail === "NOT_FOUND") {
    return "The file does not exist yet. Use mcp__repo__write_file to create it, or check the path with mcp__repo__list_files.";
  }
  if (detail === "STRING_NOT_FOUND") {
    return "old_string was not found in the file. Read the current file with mcp__repo__read_file and copy the exact text to replace, including whitespace and indentation.";
  }
  if (detail === "STRING_NOT_UNIQUE") {
    return "old_string matches more than one place in the file. Include enough surrounding context to make it unique, or pass replace_all: true to replace every occurrence.";
  }
  if (detail === "NO_CHANGE") {
    return "Nothing to change: old_string is empty or identical to new_string.";
  }
  return decodeRepoFsError(detail, {
    tooLarge: "The resulting file is too large.",
    notAFile: "Not a file.",
    fallback: "Failed to edit the file",
  });
}

/** scaffold_skill's shared error decode. */
export function scaffoldErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    skillExists: "A skill with the same name already exists.",
    fallback: "Failed to create the skill",
  });
}

/** delete_file's shared error decode. */
export function deleteFileErrorMessage(error: unknown): string {
  return decodeRepoFsError(scrubGitError(error), {
    fallback: "Failed to delete the file",
  });
}

/** move_file's shared error decode (adds a NOT_FOUND sentinel for a missing source). */
export function moveFileErrorMessage(error: unknown): string {
  const detail = scrubGitError(error);
  if (detail === "NOT_FOUND") return "The source path does not exist.";
  return decodeRepoFsError(detail, { fallback: "Failed to move the file" });
}

/**
 * The repo-relative file ops imported from `knowledgeRepo`. Bundled so a runner can take one object.
 */
export interface RepoFileOps {
  listTree: (repoRoot: string) => Promise<Array<{ type: string; path: string }>>;
  readFile: (repoRoot: string, p: string) => Promise<string>;
  writeFile: (repoRoot: string, p: string, content: string) => Promise<void>;
  editFile: (
    repoRoot: string,
    p: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
  ) => Promise<number>;
  deleteFile: (repoRoot: string, p: string) => Promise<void>;
  moveFile: (repoRoot: string, from: string, to: string) => Promise<void>;
  scaffoldSkill: (repoRoot: string, name: string, description: string) => Promise<string>;
}

/**
 * Outcome of a per-tool guard/resolve chain. `ok` carries the resolved repo
 * context (already past owner/role/no-repo checks) plus the working-tree clone
 * path; otherwise it carries an MCP error result returned to the model verbatim.
 */
export type Resolved<C> =
  | { ok: true; repo: C }
  | { ok: false; result: ReturnType<typeof text> };

/**
 * Run the shared list_files body: clone the resolved repo, list its tree, and
 * either report it empty or hand the rendered tree body to `onBody`. Clone
 * failures map to the shared `cloneFailureMessage`. `onBody`/`empty` carry the
 * caller-specific success wording, so no string moves here.
 */
export async function runListFiles<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  listTree: RepoFileOps["listTree"],
  opts: { empty: string; onBody: (body: string) => string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    const entries = await listTree(repoRoot);
    if (entries.length === 0) return text(opts.empty);
    return text(opts.onBody(formatTree(entries)));
  } catch (error) {
    return text(cloneFailureMessage(error), true);
  }
}

/** Run the shared read_file body (clone → read → decode). */
export async function runReadFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  readFile: RepoFileOps["readFile"],
  path: string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    return text(await readFile(repoRoot, path));
  } catch (error) {
    return text(readFileErrorMessage(error), true);
  }
}

/**
 * True when a repo-relative path lands in the second-brain vault (`wiki/`) —
 * the write then raises a "기억" notice (MemoryEvent) on top of the tool row.
 */
export function isBrainNotePath(path: string): boolean {
  return /^(\.\/)*wiki\//.test(path.trim());
}

/** Run the shared write_file body; `success` builds the caller-specific message. */
export async function runWriteFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  writeFile: RepoFileOps["writeFile"],
  args: { path: string; content: string },
  success: (path: string) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    await writeFile(repoRoot, args.path, args.content);
    return text(success(args.path));
  } catch (error) {
    return text(writeFileErrorMessage(error), true);
  }
}

/**
 * Run the shared edit_file body (clone → targeted replace → decode). `success`
 * builds the caller-specific message from the path + replacement count.
 */
export async function runEditFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  editFile: RepoFileOps["editFile"],
  args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  success: (path: string, count: number) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    const count = await editFile(
      repoRoot,
      args.path,
      args.old_string,
      args.new_string,
      args.replace_all ?? false,
    );
    return text(success(args.path, count));
  } catch (error) {
    return text(editFileErrorMessage(error), true);
  }
}

/** Run the shared delete_file body; `success` builds the caller-specific message. */
export async function runDeleteFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  deleteFile: RepoFileOps["deleteFile"],
  path: string,
  success: (path: string) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    await deleteFile(repoRoot, path);
    return text(success(path));
  } catch (error) {
    return text(deleteFileErrorMessage(error), true);
  }
}

/** Run the shared move_file body; `success` builds the caller-specific message. */
export async function runMoveFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  moveFile: RepoFileOps["moveFile"],
  args: { from: string; to: string },
  success: (from: string, to: string) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    await moveFile(repoRoot, args.from, args.to);
    return text(success(args.from, args.to));
  } catch (error) {
    return text(moveFileErrorMessage(error), true);
  }
}

/**
 * Run the shared scaffold_skill body. The success string lives here; the
 * description/arg text stays with the caller.
 */
export async function runScaffoldSkill<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  scaffoldSkill: RepoFileOps["scaffoldSkill"],
  args: { name: string; description?: string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const repoRoot = await ensureClone(resolved.repo);
    const filePath = await scaffoldSkill(repoRoot, args.name, args.description ?? "");
    return text(
      `Created a new skill: ${filePath} (fill in the content with mcp__repo__write_file, then push with mcp__repo__commit.)`,
    );
  } catch (error) {
    return text(scaffoldErrorMessage(error), true);
  }
}

// ---- The personal vault in the memory service (vault home `memory`) ------------
//
// For an owner whose vault lives in the memory service (`memoryVaultFor` is not
// null), a vault note — the root `CLAUDE.md` and the `.md` notes under `wiki/`
// and `raw/` — is read and written through `MemoryVault`, never in the clone:
// the clone's copy of a vault note is the mirror's to write and nobody's to
// read. Everything below is that second branch; the runners above are the
// repo-home code and the code for every path that is not a vault note.

/**
 * The vault note a tool's repo-relative path argument names (normalized the
 * way the service stores it), or null when the path is not a vault note. Reads
 * the path the way the clone file ops would resolve it, so no spelling of a
 * vault note (`./wiki/a.md`, `wiki//a.md`, `wiki/x/../a.md`, `wiki/a.md/`)
 * reaches the clone's mirror copy; an absolute path stays what those ops make
 * of it — refused.
 */
export function vaultNotePathOf(raw: string): string | null {
  if (path.isAbsolute(raw)) return null;
  const norm = normalizeVaultPath(raw).replace(/\/+$/, "");
  return isPersonalVaultPath(norm) ? norm : null;
}

/** The clone-relative path the repo file ops resolve `raw` to (no leading `./`, no trailing `/`); null for one they refuse. */
function repoRelOf(raw: string): string | null {
  if (path.isAbsolute(raw)) return null;
  const norm = path.posix.normalize(raw.replace(/^(\.\/)+/, "")).replace(/\/+$/, "");
  if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

/** `wiki`, `raw`, or anything under them: the part of the tree where vault notes live. */
function inVaultRegion(rel: string): boolean {
  return rel === "wiki" || rel === "raw" || rel.startsWith("wiki/") || rel.startsWith("raw/");
}

/**
 * Whether a delete/move of this path can involve vault notes: it names a note,
 * or a folder (or file) where notes live. Anything else — `skills/…`, the
 * manifest — never touches the memory service.
 */
export function touchesVault(raw: string): boolean {
  if (vaultNotePathOf(raw)) return true;
  const rel = repoRelOf(raw);
  return rel !== null && inVaultRegion(rel.normalize("NFC"));
}

/**
 * Appended to a success line about a vault note: it is saved. It never says
 * "do not commit" — the standing guidance has the avatar commit after writing
 * in both vault homes, and a commit is what pushes the note's copy to the repository.
 */
export const VAULT_NOTE_SAVED =
  "(Vault note: it is saved now. It needs no commit to exist; mcp__repo__commit pushes its copy to the repository.)";

/** The `commit` tool's extra sentence when there was nothing to commit for an owner whose vault is in the memory service. */
export const VAULT_NOTES_NEED_NO_COMMIT =
  "Vault notes (CLAUDE.md and the .md notes under wiki/ and raw/) are saved the moment they are written — they need no commit to exist; a commit pushes their copy to the repository.";

/**
 * The memory service could not be used. Never "not found" / "no match": the
 * model must not answer as if the vault were empty.
 * `what`: "read" (nothing was read) or "write" (the change may or may not have landed).
 */
export function memoryUnavailableMessage(what: "read" | "write", subject: string): string {
  const head =
    "The memory service — where the owner's vault notes (CLAUDE.md and the notes under wiki/ and raw/) are stored — is unavailable right now";
  if (what === "read") {
    return `${head}, so ${subject} could not be read. This is NOT an empty result and does NOT mean a note is missing: nothing was read. Tell the user the memory service is unavailable right now and try again later; do not answer as if nothing were there, do not retry in a loop, and do not work around it with Bash.`;
  }
  return `${head}, so the change to ${subject} could not be confirmed. This does NOT mean the note is missing, and the change may or may not have been saved: read the note again (mcp__repo__read_file) before repeating it. Tell the user the memory service is unavailable right now; do not retry in a loop, and do not work around it with Bash.`;
}

/**
 * A vault operation's error as the model reads it. The `MemoryVault` sentinels
 * (INVALID_PATH, FILE_TOO_LARGE, NOT_FOUND, the edit sentinels) go through the
 * tool's existing decoder; the three failures only a vault has are worded here.
 */
export function vaultToolErrorMessage(error: unknown, decode: (error: unknown) => string, unavailable: string): string {
  if (error instanceof MemoryUnavailableError) return unavailable;
  if (error instanceof MemoryRefusedError) return `The memory service refused this: ${error.message}`;
  if (error instanceof Error && error.message === VAULT_HOME_CHANGED) {
    return "Nothing was done: where the owner's vault lives changed while this call was waiting. Call the tool again with the same arguments.";
  }
  return decode(error);
}

/** read_file of a vault note: the existing decode, plus the missing note it never had to word (a missing clone file is an invalid path there). */
function vaultReadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "NOT_FOUND") {
    return "The file does not exist. Check the path with mcp__repo__list_files.";
  }
  return readFileErrorMessage(error);
}

/** `listTree`'s order: directories first, then files, each by path. */
function byTreeOrder(a: { type: string; path: string }, b: { type: string; path: string }): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.path.localeCompare(b.path);
}

/**
 * The clone tree with its vault-note entries replaced by the notes the memory
 * service holds: the clone's own copies of vault notes (the mirror's, possibly
 * behind) are dropped, every service note is listed with its parent folders,
 * and the result is in `listTree`'s order. Under `wiki/` and `raw/` a folder is
 * listed only when it holds a repo file or a note — the service has no empty
 * folders, and a folder that exists only for mirror copies is not shown.
 */
export function mergeVaultTree(
  entries: Array<{ type: string; path: string }>,
  notes: Array<{ path: string }>,
): Array<{ type: string; path: string }> {
  const files = new Set<string>();
  for (const e of entries) {
    if (e.type !== "dir" && !isPersonalVaultPath(e.path)) files.add(e.path);
  }
  for (const n of notes) files.add(n.path);
  const dirs = new Set<string>();
  for (const e of entries) {
    if (e.type === "dir" && !inVaultRegion(e.path.normalize("NFC"))) dirs.add(e.path);
  }
  for (const file of files) {
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join("/"));
  }
  return [
    ...[...dirs].map((p) => ({ type: "dir", path: p })),
    ...[...files].map((p) => ({ type: "file", path: p })),
  ].sort(byTreeOrder);
}

/** list_files for an owner whose vault is in the memory service: the clone tree merged with the service's notes. */
export async function runVaultListFiles<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  listTree: RepoFileOps["listTree"],
  vault: MemoryVault,
  opts: { empty: string; onBody: (body: string) => string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  let cloneEntries: Array<{ type: string; path: string }>;
  try {
    cloneEntries = await listTree(await ensureClone(resolved.repo));
  } catch (error) {
    return text(cloneFailureMessage(error), true);
  }
  try {
    const entries = mergeVaultTree(cloneEntries, await vault.list());
    if (entries.length === 0) return text(opts.empty);
    return text(opts.onBody(formatTree(entries)));
  } catch (error) {
    return text(
      vaultToolErrorMessage(error, cloneFailureMessage, memoryUnavailableMessage("read", "the file list (its vault notes)")),
      true,
    );
  }
}

/** read_file of a vault note. */
export async function runVaultReadFile<C>(
  resolved: Resolved<C>,
  vault: MemoryVault,
  note: string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    return text(await vault.read(note));
  } catch (error) {
    return text(vaultToolErrorMessage(error, vaultReadErrorMessage, memoryUnavailableMessage("read", note)), true);
  }
}

/** write_file of a vault note; `success` builds the caller-specific message. */
export async function runVaultWriteFile<C>(
  resolved: Resolved<C>,
  vault: MemoryVault,
  note: string,
  args: { path: string; content: string },
  success: (path: string) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    await vault.write(note, args.content);
    return text(success(args.path));
  } catch (error) {
    return text(vaultToolErrorMessage(error, writeFileErrorMessage, memoryUnavailableMessage("write", note)), true);
  }
}

/** edit_file of a vault note; `success` builds the caller-specific message from the path + replacement count. */
export async function runVaultEditFile<C>(
  resolved: Resolved<C>,
  vault: MemoryVault,
  note: string,
  args: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  success: (path: string, count: number) => string,
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  try {
    const count = await vault.edit(note, args.old_string, args.new_string, args.replace_all ?? false);
    return text(success(args.path, count));
  } catch (error) {
    return text(vaultToolErrorMessage(error, editFileErrorMessage, memoryUnavailableMessage("write", note)), true);
  }
}

// ---- A memory-home owner's clone: never a file at a vault path (D4) -------------
//
// The clone's files at vault paths are the mirror's copies (or, while the mirror
// is on hold, the connected repository's own notes): no tool reads, writes,
// moves or deletes them. A path is classified lexically (`vaultNotePathOf`);
// the two checks below close what that cannot see.

/**
 * Refuse (INVALID_PATH, as the clone ops word a path they will not follow) a
 * path that is not a vault path by its spelling but RESOLVES, through a link
 * committed in the repository, into the vault folders of the clone
 * (`notes -> wiki`: `notes/a.md` is the clone's copy of `wiki/a.md`). Only for
 * an owner whose vault is in the memory service; a path the clone ops refuse
 * anyway is left to them.
 */
export function assertNoVaultAlias(repoRoot: string, raw: string, opts: { leafLinkOk?: boolean } = {}): void {
  const rel = repoRelOf(raw);
  if (!rel) return;
  let realRoot: string;
  try {
    realRoot = fsSync.realpathSync(repoRoot);
  } catch {
    return;
  }
  // The real path of the deepest part that exists, plus the rest as spelled.
  const rest: string[] = [];
  let current = path.resolve(repoRoot, rel);
  if (opts.leafLinkOk) {
    // A delete of a link removes the link itself, wherever it points: only the way TO it is checked.
    let leafIsLink = false;
    try {
      leafIsLink = fsSync.lstatSync(current).isSymbolicLink();
    } catch {
      leafIsLink = false;
    }
    if (leafIsLink) {
      rest.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  for (;;) {
    let real: string | null = null;
    try {
      real = fsSync.realpathSync(current);
    } catch {
      real = null;
    }
    if (real !== null) {
      const resolved = path.relative(realRoot, path.join(real, ...[...rest].reverse())).split(path.sep).join("/");
      if (resolved === rel || resolved.startsWith("../") || resolved === ".." || path.isAbsolute(resolved)) return;
      const where = resolved.normalize("NFC");
      if (where === "CLAUDE.md" || inVaultRegion(where)) throw new Error("INVALID_PATH");
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    rest.push(path.basename(current));
    current = parent;
  }
}

/** `ensureClone` for a memory-home owner's clone op on paths that are not vault notes: the clone, with {@link assertNoVaultAlias} on each path. */
export function cloneWithoutVaultAlias<C>(
  ensureClone: (repo: C) => Promise<string>,
  ...rawPaths: Array<string | { path: string; leafLinkOk?: boolean }>
): (repo: C) => Promise<string> {
  return async (repo) => {
    const repoRoot = await ensureClone(repo);
    for (const raw of rawPaths) {
      if (typeof raw === "string") assertNoVaultAlias(repoRoot, raw);
      else assertNoVaultAlias(repoRoot, raw.path, { leafLinkOk: raw.leafLinkOk });
    }
    return repoRoot;
  };
}

/**
 * Why a repo path cannot be CREATED next to the vault's notes, or null: a file
 * at `wiki/topic` while notes live under `wiki/topic/` (the mirror could no
 * longer write that folder), or a path under a note (`wiki/a.md/x.txt`).
 * `notes` = the service's notes; only a path in the vault folders can collide.
 */
export function noteTreeCollision(raw: string, notes: Array<{ path: string }>): string | null {
  const rel = repoRelOf(raw)?.normalize("NFC");
  if (!rel || !inVaultRegion(rel) || vaultNotePathOf(raw)) return null;
  const folderOfNotes = notes.find((n) => n.path.startsWith(`${rel}/`));
  if (folderOfNotes) {
    return `${raw} cannot be a file: the vault holds notes in a folder of that name (e.g. ${folderOfNotes.path}). Choose another path, or a note path ending in .md inside that folder.`;
  }
  const underNote = notes.find((n) => rel.startsWith(`${n.path}/`));
  if (underNote) {
    return `${raw} cannot be created: ${underNote.path} is a vault note, not a folder. Choose another path.`;
  }
  return null;
}

/**
 * Before a memory-home owner's write_file of a path that is not a vault note:
 * the refusal when it would collide with the vault's notes
 * ({@link noteTreeCollision}), else null — the caller then runs the clone op.
 * Asks the service only for a path in the vault folders.
 */
export async function refuseNoteTreeCollision<C>(
  resolved: Resolved<C>,
  vault: MemoryVault,
  rawPath: string,
): Promise<ReturnType<typeof text> | null> {
  if (!resolved.ok) return null;
  const rel = repoRelOf(rawPath)?.normalize("NFC");
  if (!rel || !inVaultRegion(rel) || vaultNotePathOf(rawPath)) return null;
  try {
    const refusal = noteTreeCollision(rawPath, await vault.list());
    return refusal ? text(refusal, true) : null;
  } catch (error) {
    return text(vaultToolErrorMessage(error, writeFileErrorMessage, memoryUnavailableMessage("write", rawPath)), true);
  }
}

/** The clone's regular files that are repo paths under `folder` (clone-relative, no trailing slash) — never a file at a vault path. */
function repoFilesUnder(entries: Array<{ type: string; path: string }>, folder: string): string[] {
  const prefix = `${folder}/`;
  return entries.filter((e) => e.type !== "dir" && e.path.startsWith(prefix) && !isPersonalVaultPath(e.path)).map((e) => e.path);
}

/**
 * Remove the folders at and under `folder` that are now empty, deepest first.
 * One that still holds something — a file at a vault path, which is not a
 * tool's to remove — stays (`rmdir` refuses it).
 */
async function removeEmptiedFolders(repoRoot: string, entries: Array<{ type: string; path: string }>, folder: string): Promise<void> {
  const prefix = `${folder}/`;
  const dirs = entries
    .filter((e) => e.type === "dir" && (e.path === folder || e.path.startsWith(prefix)))
    .map((e) => e.path)
    .sort((a, b) => b.length - a.length);
  for (const dir of dirs) await fs.rmdir(path.join(repoRoot, dir)).catch(() => undefined);
}

/**
 * delete_file for an owner whose vault is in the memory service, where vault
 * notes can be involved (`touchesVault`), run inside the owner's vault write
 * queue (`vault` is the queue's writer). A vault note is deleted in the
 * service. A folder is deleted on BOTH sides: its notes in the service, and in
 * the clone ONLY the repo files under it — a clone file at a vault path is
 * never touched. A plain repo file (`wiki/.gitkeep`) or a link is the clone op
 * alone and never asks the service. `success.repo` is today's text,
 * `success.note` a vault note's, `success.folder` a folder that held `count` notes.
 */
export async function runVaultDeleteFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  ops: Pick<RepoFileOps, "listTree" | "deleteFile">,
  vault: MemoryVault,
  rawPath: string,
  success: { repo: (path: string) => string; note: (path: string) => string; folder: (path: string, count: number) => string },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  const note = vaultNotePathOf(rawPath);
  let removed = 0;
  let covered = 0;
  try {
    if (note) {
      await vault.remove(note);
      return text(success.note(rawPath));
    }
    const repoRoot = await ensureClone(resolved.repo);
    const rel = repoRelOf(rawPath);
    const stat = rel ? await fs.lstat(path.join(repoRoot, rel)).catch(() => null) : null;
    if (!rel || (stat && !stat.isDirectory())) {
      // A repo file, a link (the link itself is removed), or a path the clone op refuses.
      await ops.deleteFile(repoRoot, rawPath);
      return text(success.repo(rawPath));
    }
    const prefix = `${rel.normalize("NFC")}/`;
    const notes = (await vault.list()).filter((n) => n.path.startsWith(prefix));
    covered = notes.length;
    // The notes first: a failure here leaves the clone untouched.
    for (const n of notes) {
      await vault.remove(n.path);
      removed += 1;
    }
    const entries = await ops.listTree(repoRoot);
    for (const file of repoFilesUnder(entries, rel)) await ops.deleteFile(repoRoot, file);
    await removeEmptiedFolders(repoRoot, entries, rel);
    return text(covered > 0 ? success.folder(rawPath, covered) : success.repo(rawPath));
  } catch (error) {
    const message = vaultToolErrorMessage(error, deleteFileErrorMessage, memoryUnavailableMessage("write", rawPath));
    const partial =
      covered > 0
        ? ` (${removed} of the ${covered} vault note(s) under ${rawPath} were deleted before this failed; the remaining notes and the repository files under it are unchanged.)`
        : "";
    return text(`${message}${partial}`, true);
  }
}

/** A move's refusals that only the two-sided (clone + service) move has. */
const MOVE_FOLDER_ONTO_NOTE =
  "A folder cannot be moved to a note path (a path ending in .md under wiki/ or raw/). Give the destination folder's path.";
const MOVE_DESTINATION_IS_FOLDER = "The destination is an existing folder. Give the full destination file path.";
const MOVE_DESTINATION_IS_FILE = "The destination is an existing file, not a folder. Give a folder path.";

/** One file of a move: where it is and where it goes, each on the side it belongs to. */
interface MoveItem {
  /** Service note path (side `note`) or clone-relative path (side `file`). */
  from: string;
  fromSide: "note" | "file";
  to: string;
  toSide: "note" | "file";
}

const showMove = (item: MoveItem) => `${item.from} → ${item.to}`;

/**
 * move_file for an owner whose vault is in the memory service, where vault
 * notes can be involved (`touchesVault(from)` or `touchesVault(to)`), run
 * inside the owner's vault write queue (`vault` is the queue's writer).
 *
 * A move is carried out file by file, each on the side it belongs to: note →
 * note inside the service; note → repo path (written into the clone, deleted
 * in the service); repo file → note (written to the service, deleted in the
 * clone); repo file → repo path (the clone's own move). A folder move does
 * this for every repo file of the folder in the clone and every note under it
 * in the service. A clone file at a vault path is never read, moved or
 * removed, and a folder that holds nothing but such files does not exist.
 *
 * RESUMABLE: a destination that already holds exactly the source's text counts
 * as copied — only the source is then removed — so the same call finishes a
 * move that failed half-way. A folder move refuses, before anything moves,
 * only a destination file that exists with DIFFERENT text (it never overwrites;
 * a single file's move does, as a rename always did). On a failure the result
 * names the files that exist at both paths at that moment.
 *
 * `success.repo` is today's text; `success.notes` when only vault notes
 * changed; `success.mixed` when both sides did.
 */
export async function runVaultMoveFile<C>(
  resolved: Resolved<C>,
  ensureClone: (repo: C) => Promise<string>,
  ops: Pick<RepoFileOps, "listTree" | "readFile" | "writeFile" | "deleteFile" | "moveFile">,
  vault: MemoryVault,
  args: { from: string; to: string },
  success: {
    repo: (from: string, to: string) => string;
    notes: (from: string, to: string) => string;
    mixed: (from: string, to: string) => string;
  },
): Promise<ReturnType<typeof text>> {
  if (!resolved.ok) return resolved.result;
  const fromNote = vaultNotePathOf(args.from);
  const toNote = vaultNotePathOf(args.to);
  const fromRel = repoRelOf(args.from);
  const toRel = repoRelOf(args.to);
  let noteChanges = 0;
  let repoChanges = 0;
  let moved = 0;
  let items: MoveItem[] = [];
  let repoRoot: string | null = null;
  const refuse = (message: string) => text(message, true);
  const done = () =>
    text(
      noteChanges === 0
        ? success.repo(args.from, args.to)
        : repoChanges === 0
          ? success.notes(args.from, args.to)
          : success.mixed(args.from, args.to),
    );
  const cloneFileExists = async (rel: string) => Boolean((await fs.lstat(path.join(repoRoot!, rel)).catch(() => null))?.isFile());

  /** Carry out one file's move. `noteSet` = the service's notes when the move started. */
  const moveItem = async (item: MoveItem, noteSet: Set<string>): Promise<void> => {
    if (item.fromSide === "file" && item.toSide === "file") {
      await ops.moveFile(repoRoot!, item.from, item.to);
      repoChanges += 1;
      return;
    }
    const content = item.fromSide === "note" ? await vault.read(item.from) : await ops.readFile(repoRoot!, item.from);
    // A note moved onto itself changes nothing (and must not be removed).
    const onto = item.fromSide === item.toSide && item.from === item.to;
    if (!onto) {
      // Already at the destination with the same text (an earlier attempt copied it): only the source is left to remove.
      if (item.toSide === "note") {
        const copied = noteSet.has(item.to) && (await vault.read(item.to).catch(() => null)) === content;
        if (!copied) await vault.write(item.to, content);
      } else {
        const copied = (await cloneFileExists(item.to)) && (await ops.readFile(repoRoot!, item.to).catch(() => null)) === content;
        if (!copied) await ops.writeFile(repoRoot!, item.to, content);
      }
      if (item.fromSide === "note") await vault.remove(item.from);
      else await ops.deleteFile(repoRoot!, item.from);
    }
    if (item.fromSide === "note" || item.toSide === "note") noteChanges += 1;
    if (item.fromSide === "file" || item.toSide === "file") repoChanges += 1;
  };

  try {
    if (!fromRel || !toRel) throw new Error("INVALID_PATH");
    const notes = await vault.list();
    const noteSet = new Set(notes.map((n) => n.path));
    const fromService = fromRel.normalize("NFC");
    const toService = toRel.normalize("NFC");
    const notesUnder = (folder: string) => notes.filter((n) => n.path.startsWith(`${folder}/`));

    // ---- One vault note is the source ----
    if (fromNote) {
      if (!noteSet.has(fromNote)) throw new Error("NOT_FOUND");
      if (toNote) {
        items = [{ from: fromNote, fromSide: "note", to: toNote, toSide: "note" }];
      } else {
        const collision = noteTreeCollision(args.to, notes);
        if (collision) return refuse(notesUnder(toService).length > 0 ? MOVE_DESTINATION_IS_FOLDER : collision);
        repoRoot = await ensureClone(resolved.repo);
        items = [{ from: fromNote, fromSide: "note", to: toRel, toSide: "file" }];
      }
      await moveItem(items[0], noteSet);
      moved = 1;
      return done();
    }

    // ---- The source is in the clone: a repo file, or a folder (which may also hold notes in the service) ----
    repoRoot = await ensureClone(resolved.repo);
    const entries = await ops.listTree(repoRoot);
    const source = entries.find((e) => e.path === fromRel);

    if (source && source.type !== "dir") {
      if (!toNote) {
        const collision = noteTreeCollision(args.to, notes);
        if (collision) return refuse(notesUnder(toService).length > 0 ? MOVE_DESTINATION_IS_FOLDER : collision);
      }
      items = [{ from: fromRel, fromSide: "file", to: toNote ?? toRel, toSide: toNote ? "note" : "file" }];
      await moveItem(items[0], noteSet);
      moved = 1;
      return done();
    }

    const sourceNotes = notesUnder(fromService);
    const sourceFiles = source ? repoFilesUnder(entries, fromRel) : [];
    if (sourceNotes.length === 0 && sourceFiles.length === 0) {
      // In the vault folders, a folder is its repo files and its notes: one that holds neither (only the
      // clone's copies of notes, which are not the tools') does not exist.
      if (inVaultRegion(fromService)) throw new Error("NOT_FOUND");
      // Elsewhere nothing of the vault is involved: the clone op moves an empty folder, or words what is
      // wrong with the source (missing, a link).
      await ops.moveFile(repoRoot, args.from, args.to);
      return done();
    }
    if (toNote) return refuse(MOVE_FOLDER_ONTO_NOTE);
    if (toRel === fromRel || `${toRel}/`.startsWith(`${fromRel}/`)) throw new Error("INVALID_PATH");
    if (entries.some((e) => e.type !== "dir" && e.path === toRel)) return refuse(MOVE_DESTINATION_IS_FILE);
    const underNote = notes.find((n) => `${toService}/`.startsWith(`${n.path}/`));
    if (underNote) return refuse(`${args.to} cannot be a folder: ${underNote.path} is a vault note. Choose another destination.`);

    const destinationOf = (p: string, from: string) => `${toRel}${p.slice(from.length)}`;
    items = [
      ...sourceNotes.map((n): MoveItem => {
        const to = destinationOf(n.path, fromService);
        const note = vaultNotePathOf(to);
        return { from: n.path, fromSide: "note", to: note ?? to, toSide: note ? "note" : "file" };
      }),
      ...sourceFiles.map((f): MoveItem => {
        const to = destinationOf(f, fromRel);
        const note = vaultNotePathOf(to);
        return { from: f, fromSide: "file", to: note ?? to, toSide: note ? "note" : "file" };
      }),
    ];

    // Nothing is overwritten by a folder move: a destination file that exists must hold the source's text
    // (then it is the copy an earlier attempt made). Checked for every file before the first one moves.
    const cloneFiles = new Set(entries.filter((e) => e.type !== "dir").map((e) => e.path));
    const clashes: string[] = [];
    for (const item of items) {
      const exists = item.toSide === "note" ? noteSet.has(item.to) : cloneFiles.has(item.to);
      if (!exists) continue;
      const readSide = (side: "note" | "file", p: string) => (side === "note" ? vault.read(p) : ops.readFile(repoRoot!, p));
      const [theirs, ours] = await Promise.all([
        readSide(item.toSide, item.to).catch(() => null),
        readSide(item.fromSide, item.from).catch(() => null),
      ]);
      if (theirs === null || ours === null || theirs !== ours) clashes.push(item.to);
    }
    if (clashes.length > 0) {
      const shown = clashes.slice(0, 5).join(", ");
      return refuse(
        `Nothing was moved: the destination already holds ${clashes.length} file(s) with different content (${shown}${clashes.length > 5 ? ", …" : ""}). A folder move never overwrites — move to a path that does not exist yet, or move those files one by one.`,
      );
    }

    for (const item of items) {
      await moveItem(item, noteSet);
      moved += 1;
    }
    if (source) await removeEmptiedFolders(repoRoot, entries, fromRel);
    return done();
  } catch (error) {
    const message = vaultToolErrorMessage(
      error,
      moveFileErrorMessage,
      memoryUnavailableMessage("write", `${args.from} → ${args.to}`),
    );
    if (items.length === 0) return text(message, true);
    // What is true NOW, not what the failed step meant to do: which files exist at both paths.
    const resume =
      "Call mcp__repo__move_file again with the same arguments to finish: a copy that is already at the destination is recognised and only the original is removed.";
    const said: string[] = [];
    if (items.length > 1) said.push(`${moved} of ${items.length} file(s) were moved completely.`);
    try {
      const now = new Set((await vault.list()).map((n) => n.path));
      const exists = (side: "note" | "file", p: string) => (side === "note" ? Promise.resolve(now.has(p)) : cloneFileExists(p));
      const both: MoveItem[] = [];
      for (const item of items) {
        if (item.from === item.to && item.fromSide === item.toSide) continue;
        if ((await exists(item.fromSide, item.from)) && (await exists(item.toSide, item.to))) both.push(item);
      }
      if (both.length > 0) {
        said.push(`These exist at BOTH paths now (copied; the original is not removed yet): ${both.map(showMove).join(", ")}. ${resume}`);
      } else if (items.length > 1) {
        said.push(`No file of this move exists at both paths; what was not moved is still under ${args.from}.`);
      }
    } catch {
      said.push(`Which files exist at both paths could not be checked (the memory service did not answer). When it does: ${resume}`);
    }
    return text(said.length > 0 ? `${message} (${said.join(" ")})` : message, true);
  }
}
