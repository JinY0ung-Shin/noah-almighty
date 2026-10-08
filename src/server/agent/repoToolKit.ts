// Shared CRUD skeleton for the knowledge-repo MCP servers (`repoTools.ts` =
// the owner's personal repo, `groupRepoTools.ts` = a group's shared repo).
//
// Both servers expose the same five file-CRUD tools — list_files / read_file /
// write_file / scaffold_skill / commit — over a guard → resolve → ensureClone →
// op → decode pipeline. The ONLY differences are:
//   - the guard/resolve chain (personal = owner-only; group = owner-only +
//     resolve the named group + an admin role gate on write/scaffold/commit),
//   - which clone/commit helpers run (knowledgeRepo vs groupKnowledgeRepo),
//   - a handful of success-message strings + the commit audit action/detail,
//   - tool descriptions / arg-`describe` text (personal vs group wording).
//
// This module factors the loop body — the owner gate, the resolve→clone→op→decode
// try/catch, and the shared (byte-identical, English, agent-facing) error
// messages — into small parameterized runners. Each caller still owns its own
// `tool()` descriptions, argument schemas, success strings, and audit calls, so
// every string that units.test.ts asserts stays at the call site unchanged.

import { scrubGitError } from "../marketplace.js";
import type { Store } from "../store.js";
import type { UserGroupMembership } from "../types.js";
import { decodeRepoFsError, text } from "./mcpTools.js";

/** Shared owner-only refusal text (identical in both repo servers). */
export const OWNER_ONLY = "This tool can only be used by the avatar owner.";

/** Shared commit-tool refusal when no internal Git token is registered (identical in both repo servers). */
export const NO_GIT_TOKEN = "To push, please first register an internal Git token (GIT_TOKEN) in settings.";

/** Shared commit-tool message when the working tree has nothing to commit (identical in both repo servers). */
export const NO_CHANGES = "There are no changes to commit.";

/**
 * The shared create_repo name validation both servers run: `name` is required and
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
 * byte-identical in both repo servers, including the no-Bash-fallback hint. Takes
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

/** The shared create_repo outer-catch message (byte-identical in both repo servers). */
export function createRepoCatchMessage(targetHost: string, error: unknown): string {
  return `Error while creating GitHub repository (host: ${targetHost}): ${scrubGitError(error)}`;
}

/**
 * Resolve a `group` argument (id or name, case-insensitive) among the groups the
 * avatar's owner belongs to. Shared by `groupRepoTools.ts`/`groupBrainTools.ts`
 * so a model-supplied group is always checked against the owner's OWN memberships
 * (never a cross-tenant read of another team's repo). Returns null when blank or
 * unmatched; the caller maps that to its own NO_SUCH_GROUP refusal.
 */
export function resolveOwnerGroup(
  store: Store,
  avatarUserId: string,
  arg: string,
): UserGroupMembership | null {
  const a = arg.trim().toLowerCase();
  if (!a) return null;
  const groups = store.listUserGroups(avatarUserId);
  return (
    groups.find((g) => g.id.toLowerCase() === a) ??
    groups.find((g) => g.name.toLowerCase() === a) ??
    null
  );
}

/** Render a `listTree` result the same way both servers do (dirs get a trailing slash). */
export function formatTree(entries: Array<{ type: string; path: string }>): string {
  return entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
}

/**
 * The shared error message both servers return when a clone fails (load failure):
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

/** read_file's shared error decode (identical sentinels/wording in both servers). */
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
    return "The file does not exist yet. Use write_file to create it (or check the path with list_files/read_file).";
  }
  if (detail === "STRING_NOT_FOUND") {
    return "old_string was not found in the file. Read the current file with read_file and copy the exact text to replace, including whitespace and indentation.";
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
 * The repo-relative file ops both servers import from `knowledgeRepo` (the group
 * server reuses them on its own clone). Bundled so a runner can take one object.
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
 * caller-specific success wording (personal vs group), so no string moves here.
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
 * Run the shared scaffold_skill body. The success string is byte-identical in
 * both servers, so it lives here; only the description/arg text (kept by callers)
 * differs.
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
      `Created a new skill: ${filePath} (fill in the content with write_file, then push with commit.)`,
    );
  } catch (error) {
    return text(scaffoldErrorMessage(error), true);
  }
}
