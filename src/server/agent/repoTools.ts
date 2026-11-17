import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import logger from "../logger.js";
import { normalizeGithubHost, pathExists, scrubGitError } from "../marketplace.js";
import { MemoryUnavailableError } from "../memory/memoryClient.js";
import {
  isPersonalVaultPath,
  memoryVaultFor,
  normalizeVaultPath,
  withVaultWrite,
  type MemoryVault,
  type VaultWriteTarget,
} from "../personalVault.js";
import { onKnowledgeRepoChanged } from "../vaultMigration.js";
import { finishVaultMirror, syncVaultMirror, type VaultMirrorOutcome } from "../vaultMirror.js";
import { decodeExecError, text } from "./mcpTools.js";
import {
  commitAndPush,
  commitIdentityFor,
  deleteFile as deleteRepoFile,
  editFile as editRepoFile,
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  listTree,
  moveFile as moveRepoFile,
  readFile as readRepoFile,
  scaffoldSkill,
  writeFile as writeRepoFile,
  writeRepoTemplate,
  type KnowledgeRepoContext,
} from "../knowledgeRepo.js";
import { withRepoLock } from "../gitMutex.js";
import {
  reconcileOwnerSharedSkills,
  type SharedSkillReconcileResult,
  type SharedSkillReconcileStore,
} from "../skillTransfer.js";
import {
  NO_CHANGES,
  NO_GIT_TOKEN,
  OWNER_ONLY as REPO_OWNER_ONLY,
  VAULT_NOTES_NEED_NO_COMMIT,
  VAULT_NOTE_SAVED,
  type Resolved,
  cloneWithoutVaultAlias,
  commitFailureMessage,
  createRepoCatchMessage,
  createRepoFailureMessage,
  isBrainNotePath,
  refuseNoteTreeCollision,
  runDeleteFile,
  runEditFile,
  runListFiles,
  runMoveFile,
  runReadFile,
  runScaffoldSkill,
  runVaultDeleteFile,
  runVaultEditFile,
  runVaultListFiles,
  runVaultMoveFile,
  runVaultReadFile,
  runVaultWriteFile,
  runWriteFile,
  touchesVault,
  validateRepoCreateNames,
  vaultNotePathOf,
} from "./repoToolKit.js";

const execFileAsync = promisify(execFile);

/**
 * Per-conversation context the knowledge-repo management tools act within. These
 * tools let the avatar manage its OWNER's personal knowledge repo (the repo the
 * avatar accumulates work knowledge/skills into) directly from chat.
 *
 * Access is split: the WRITE tools (write/delete/move/scaffold/commit) are
 * OWNER-ONLY by default — a colleague, a trusted user, or a headless routine gets
 * a refusal. The READ tools (`list_files`/`read_file`) additionally allow an
 * `elevated` viewer (a trusted teammate), so a teammate's chat can
 * read the owner's accumulated knowledge without being able to modify it.
 * When the owner marked the account as a SHARED (communal) account, the caller
 * passes `writeAccess` so trusted teammates may also write/commit; `create_repo`
 * and repo connection settings stay owner-only regardless.
 */
export interface RepoToolsContext {
  /** The avatar (== owner) whose knowledge repo these tools manage. */
  avatarUserId: string;
  /** The avatar owner (for the username/displayName fallback in commits). */
  owner: AgentOwner;
  /**
   * True only when the present viewer IS the owner and the run is interactive.
   * The caller computes `viewerIsOwner && !headless`; every WRITE tool refuses
   * otherwise.
   */
  viewerIsOwner: boolean;
  /**
   * True for the owner OR a trusted teammate (interactive turn). Gates
   * the READ tools (`list_files`/`read_file`) so teammates can read — but not
   * modify — the personal repo. Defaults to `viewerIsOwner` when omitted.
   */
  elevated?: boolean;
  /**
   * True when the current run may WRITE (write/delete/move/scaffold/commit): the
   * owner, or — when the owner marked this a SHARED (communal) account — a
   * trusted teammate. Defaults to `viewerIsOwner` when omitted.
   * `create_repo` ignores this and stays strictly owner-only.
   */
  writeAccess?: boolean;
  /**
   * The user actually chatting, for commit AUDIT attribution when a shared
   * account lets a teammate push. Omitted/null (or the owner themselves) keeps
   * the audit actor = owner, byte-identical to the pre-shared-account behavior.
   */
  viewer?: { id: string; name: string } | null;
  config: AppConfig;
  /**
   * Fired after a SUCCESSFUL write/edit under `wiki/` (a second-brain note):
   * the host shows a "기억 추가/갱신" notice in the activity tree. Optional —
   * headless runs have no viewer to notify.
   */
  onMemory?: (event: { action: "add" | "update"; path: string }) => void;
}

/** MCP server name; tools surface to the model as `mcp__repo__<tool>`. */
export const REPO_SERVER_NAME = "repo";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const REPO_TOOL_NAMES = [
  "mcp__repo__list_files",
  "mcp__repo__read_file",
  "mcp__repo__write_file",
  "mcp__repo__edit_file",
  "mcp__repo__delete_file",
  "mcp__repo__move_file",
  "mcp__repo__scaffold_skill",
  "mcp__repo__commit",
] as const;

/**
 * The repo-creation tool name. Surfaced separately because it's exposed ONLY
 * when the owner has NO knowledge repo yet — once one is connected, hiding it
 * keeps the (rarely-needed) tool out of the prompt to save tokens.
 */
export const REPO_CREATE_TOOL_NAME = "mcp__repo__create_repo";

type CreateRepoResult =
  | { ok: true; fullName: string; defaultBranch: string; isPrivate: boolean }
  | { ok: false; status?: number; exitCode?: number; message: string };

type GhRunner = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

function githubHostDescription(host: string): string {
  const normalized = normalizeGithubHost(host);
  return `The currently configured GitHub host is \`${normalized}\`, and create_repo creates the repo with \`GH_HOST=${normalized} gh repo create\`.`;
}

function ghErrorMessage(error: unknown, token: string): { message: string; exitCode?: number } {
  return decodeExecError(error, { redactToken: token, fallback: "gh command failed" });
}

function isAlreadyExistsError(message: string): boolean {
  return /already exists|name.*exists|exists on this account/i.test(message);
}

function ghEnv(host: string, token: string, githubCaCert?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GH_HOST: normalizeGithubHost(host),
    GH_PROMPT_DISABLED: "1",
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_ENTERPRISE_TOKEN: token,
  };
  if (githubCaCert) {
    const certPath = path.resolve(githubCaCert);
    env.SSL_CERT_FILE ??= certPath;
    env.GIT_SSL_CAINFO ??= certPath;
  }
  return env;
}

async function runGh(
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
}

async function viewGhRepo(
  runner: GhRunner,
  env: NodeJS.ProcessEnv,
  fullName: string,
): Promise<{ fullName: string; defaultBranch: string; isPrivate: boolean }> {
  const view = await runner(
    ["repo", "view", fullName, "--json", "nameWithOwner,defaultBranchRef,isPrivate"],
    { env, timeout: 20_000 },
  );
  const body = JSON.parse(view.stdout || "{}") as {
    nameWithOwner?: unknown;
    defaultBranchRef?: { name?: unknown } | null;
    isPrivate?: unknown;
  };
  return {
    fullName: typeof body.nameWithOwner === "string" ? body.nameWithOwner : fullName,
    defaultBranch: typeof body.defaultBranchRef?.name === "string" ? body.defaultBranchRef.name : "main",
    isPrivate: body.isPrivate === true,
  };
}

/**
 * Create a new repo through GitHub CLI. `gh` handles github.com vs GHES routing
 * via GH_HOST, and the user's token is passed only in this child process's env.
 * `--add-readme` gives the repo an initial commit/default branch so the
 * knowledge-repo clone can push immediately. When `org` is given the repo is
 * created under that organization (`org/name`); otherwise it lands under the token owner's personal account (resolved via `gh api user`).
 */
export async function createRemoteRepo(
  host: string,
  token: string,
  name: string,
  isPrivate: boolean,
  description: string,
  githubCaCert?: string,
  org?: string,
  runner: GhRunner = runGh,
): Promise<CreateRepoResult> {
  const normalizedHost = normalizeGithubHost(host);
  const env = ghEnv(normalizedHost, token, githubCaCert);
  try {
    let owner = (org ?? "").trim();
    if (!owner) {
      const user = await runner(["api", "user", "--jq", ".login"], { env, timeout: 20_000 });
      owner = user.stdout.trim();
      if (!owner) {
        return { ok: false, message: "gh api user did not return a login" };
      }
    }

    const fullName = `${owner}/${name}`;
    const createArgs = ["repo", "create", fullName, isPrivate ? "--private" : "--public", "--add-readme"];
    if (description) {
      createArgs.push("--description", description);
    }
    try {
      await runner(createArgs, { env, timeout: 60_000 });
    } catch (error) {
      const detail = ghErrorMessage(error, token);
      if (!isAlreadyExistsError(detail.message)) {
        return { ok: false, ...detail };
      }
    }
    const repo = await viewGhRepo(runner, env, fullName);
    return {
      ok: true,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      isPrivate: repo.isPrivate,
    };
  } catch (error) {
    return { ok: false, ...ghErrorMessage(error, token) };
  }
}

/**
 * Agent-facing summary of a reconciliation pass — metacognition, so the avatar
 * can TELL the owner that committing just changed what their teammates see
 * (empty when the commit touched no shared skill).
 */
function reconcileNote(result: SharedSkillReconcileResult): string {
  if (result.skillsDirUnreadable) {
    return "\nShared skills were NOT reconciled with this commit: skills/ in the knowledge repository is not a plain folder (a symlink — even one inside the repository — or unreadable), and Noah never reads skills through a link. Every share was left exactly as it was, but teammates cannot preview or learn those skills until skills/ is a plain folder again. Tell the owner so.";
  }
  const parts = [
    ...result.renamed.map((r) => `the share follows the rename ${r.from} → ${r.to}`),
    ...result.unshared.map((name) => `${name} is no longer shared (its directory was deleted)`),
    ...result.drained.map(
      (name) => `${name} is no longer shared (it became a copy learned from another avatar)`,
    ),
  ];
  if (result.resnapshotted.length > 0) {
    parts.push(
      `refreshed the shared fingerprint of ${result.resnapshotted.length} skill(s) so teammates see the update`,
    );
  }
  return parts.length === 0
    ? ""
    : `\nShared skills were reconciled with this commit: ${parts.join("; ")}. Tell the owner what changed about their shares.`;
}

/**
 * Reconcile the owner's share rows against the tree that was just committed.
 * Under the repo lock: commitAndPush holds it only for its own add/commit/push
 * and has released it by now, so re-acquiring keeps the reconciliation's git
 * reads from overlapping a concurrent ensureClone that is removing and
 * re-cloning the very working tree being read (never nested — this runs after
 * commitAndPush returned).
 *
 * BEST EFFORT by construction: the commit already succeeded and was pushed, so
 * every failure here is swallowed — a stale share row is a far smaller problem
 * than a commit tool that reports failure after a successful push.
 */
async function reconcileSharesAfterCommit(
  store: SharedSkillReconcileStore,
  ownerUserId: string,
  repoRoot: string,
): Promise<string> {
  try {
    return reconcileNote(
      await withRepoLock(repoRoot, () =>
        reconcileOwnerSharedSkills(store, repoRoot, ownerUserId),
      ),
    );
  } catch {
    return "";
  }
}

/**
 * `commit` for an owner whose vault lives in the memory service: mirror →
 * commit → rebase onto what the remote got meanwhile (a conflict confined to
 * vault notes is settled for the vault's text — a direct git edit of a note
 * never blocks the commit) → mirror AGAIN on the rebased tree → push. Both
 * mirror passes run in `commitAndPush`'s hook, inside the repo lock it takes,
 * so no sync or other commit lands in between.
 *
 * The mirror never stops the commit of the other changes: the outcome of its
 * LAST pass is returned and reported (null = it did not run), and that pass is
 * finalized on the row and the deletion ledger only once the push is over —
 * as synced when it went through, as the failure when it did not.
 * `changed` = files the passes wrote or deleted in the clone, together.
 */
async function commitWithVaultMirror(
  store: Store,
  c: KnowledgeRepoContext,
  message: string,
  identity: { name: string; email: string },
): Promise<{ committed: boolean; mirror: VaultMirrorOutcome | null; changed: number }> {
  const repoRoot = knowledgeClonePath(c.userId, c.config);
  // A vault write never needs the clone, so it may not be there yet (the other tools clone on first use).
  if (!(await pathExists(path.join(repoRoot, ".git")))) {
    await ensureClone(c);
  }
  const pass: { last: VaultMirrorOutcome | null; changed: number } = { last: null, changed: 0 };
  try {
    const committed = await commitAndPush(c, message, identity, {
      beforeCommit: async () => {
        try {
          pass.last = await syncVaultMirror(store, c.config, c.userId, { push: false, locked: true });
        } catch (error) {
          pass.last = { kind: "failed", error: scrubGitError(error) };
        }
        if (pass.last.kind === "synced") pass.changed += pass.last.changed;
      },
      vaultPaths: isPersonalVaultPath,
    });
    finishVaultMirror(store, c.config, c.userId, pass.last, { ok: true });
    return { committed, mirror: pass.last, changed: pass.changed };
  } catch (error) {
    finishVaultMirror(store, c.config, c.userId, pass.last, { ok: false, error });
    throw error;
  }
}

/**
 * What the `commit` result says about the repository's copy of the vault notes
 * ("" when there is nothing to say). Only reached when the push went through,
 * and `mirror` is the LAST pass (the one on the rebased tree when the commit
 * had to rebase) — so "up to date" is said only when that pass succeeded. A
 * copy that was not updated is never a lost note — the note is saved in the
 * vault — and the model is told so.
 */
function vaultMirrorNote(
  mirror: VaultMirrorOutcome | null,
  committed: boolean,
  changed: number,
  hold: "checking" | "confirm" | null,
): string {
  if (!mirror) return "";
  if (mirror.kind === "synced") {
    const updated =
      committed && changed > 0
        ? `\nThis commit also brought the repository's copy of the vault notes up to date (${changed} file(s)).`
        : "";
    // The repository may hold vault notes the vault does not (written there directly): they are never deleted.
    const leftAlone = mirror.notice ? `\nLeft as they are in the repository (${mirror.notice}): vault notes there that the vault itself does not hold.` : "";
    return `${updated}${leftAlone}`;
  }
  const safe = "The notes themselves are saved in the vault; only their copy in the repository is behind.";
  if (mirror.kind === "skipped" && mirror.reason === "hold") {
    return hold === "checking"
      ? `\nThe repository's copy of the vault notes was NOT updated yet: this repository (or branch) was just connected and is still being checked before anything is copied into it. ${safe} The copy follows by itself once the check is done.`
      : `\nThe repository's copy of the vault notes was NOT updated: it is on hold until the owner confirms, in the knowledge-repository settings, that this repository may receive their vault notes (it holds vault notes of its own that the copy would replace). ${safe} Tell the owner.`;
  }
  const why = mirror.kind === "failed" ? mirror.error : mirror.reason;
  return `\nThe repository's copy of the vault notes was NOT updated this time (${why}). ${safe} It is retried in the background and on the next commit; tell the owner if this keeps happening.`;
}

/**
 * `create_repo` for an owner whose vault already lives in the memory service
 * (their row outlived a disconnected repository): the template's vault notes
 * (`CLAUDE.md`, `wiki/index.md`, `wiki/log.md`, `wiki/_template.md`) belong in
 * the service, not in the commit — the repository's copy of a vault note is
 * the mirror's to write. Each is taken out of the working tree, and saved to
 * the service unless the vault already holds a note at that path (a template
 * never overwrites). Returns a note for the tool result ("" when all went well).
 */
async function moveTemplateNotesToVault(vault: MemoryVault, repoRoot: string): Promise<string> {
  const pending: { path: string; content: string }[] = [];
  for (const entry of await listTree(repoRoot)) {
    if (entry.type !== "file" || !isPersonalVaultPath(entry.path)) continue;
    pending.push({ path: normalizeVaultPath(entry.path), content: await readRepoFile(repoRoot, entry.path) });
    await deleteRepoFile(repoRoot, entry.path);
  }
  try {
    const held = new Set((await vault.list()).map((note) => note.path));
    for (const note of pending) {
      if (!held.has(note.path)) await vault.write(note.path, note.content);
    }
    return "";
  } catch (error) {
    const why =
      error instanceof MemoryUnavailableError ? "the memory service is unavailable right now" : scrubGitError(error);
    return ` (The starter vault notes — CLAUDE.md, wiki/index.md, wiki/log.md, wiki/_template.md — could not all be saved: ${why}. Check with mcp__repo__list_files and write the missing ones with mcp__repo__write_file later.)`;
  }
}

const OWNER_ONLY = REPO_OWNER_ONLY;
const NO_REPO =
  "No knowledge repository is connected yet. If you are the owner, first create and connect a new repository with the `mcp__repo__create_repo` tool, then try again. (If you already have a repo you've been using, you can also connect it directly in settings.) Do not walk through manual setup steps — use `mcp__repo__create_repo`.";

/**
 * Build the knowledge-repo management tool definitions bound to a single
 * conversation's store + context. Exposed separately from the server so the
 * handlers can be exercised directly in tests. Gating is enforced here (the
 * model can call them, but a viewer past the read/write gate gets a refusal
 * result — see `RepoToolsContext.writeAccess` for the shared-account widening).
 */
export function buildRepoTools(
  store: Store,
  ctx: RepoToolsContext,
  opts: { allowCreate?: boolean; createRemoteRepo?: typeof createRemoteRepo } = {},
) {
  // Resolve the repo context fresh on each call so a token/repo change mid-
  // conversation is picked up. Returns null when no repo is configured.
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);

  // Guard chains for the file-CRUD tools: <gate> → repo configured. WRITE tools
  // gate on `writeAccess` (owner; plus trusted teammates on a shared account);
  // READ tools gate on `elevated` (owner OR trusted teammate), so a teammate can
  // read — but not modify — a non-shared owner's personal repo.
  type RepoCtx = NonNullable<ReturnType<typeof repoCtx>>;
  const canRead = ctx.elevated ?? ctx.viewerIsOwner;
  const canWrite = ctx.writeAccess ?? ctx.viewerIsOwner;
  // Write-gate label on the write tools' descriptions, accurate PER RUN: on a
  // shared-account teammate turn the tools must not advertise "(owner only)" or
  // the model refuses on its own before ever calling them (action-trigger rule).
  const writeGate =
    canWrite && !ctx.viewerIsOwner
      ? "(shared account: the owner and trusted teammates may write)"
      : "(owner only)";
  const resolveGated = (allowed: boolean): Resolved<RepoCtx> => {
    if (!allowed) {
      return { ok: false, result: text(OWNER_ONLY, true) };
    }
    const c = repoCtx();
    if (!c) {
      return { ok: false, result: text(NO_REPO, true) };
    }
    return { ok: true, repo: c };
  };
  const resolve = (): Resolved<RepoCtx> => resolveGated(canWrite);
  const resolveRead = (): Resolved<RepoCtx> => resolveGated(canRead);

  // The owner's vault when its home is the memory service; null = the clone is
  // the vault. For READS, and for deciding how a path that is NOT a vault note
  // is guarded; read on each call, so a cutover or rollback mid-conversation is
  // picked up.
  const vault = () => memoryVaultFor(store, ctx.config, ctx.avatarUserId);
  type ToolText = ReturnType<typeof text>;
  /**
   * Run an operation that CHANGES a vault path inside the owner's vault write
   * queue, with the home decided INSIDE it: the cutover and the rollback hold
   * the same queue, so a write can never pick a home, wait, and land in the one
   * that is no longer the vault. `repo` → the clone code this tool always ran,
   * run inside the queue; `memory` → the queue's writer. A refused caller never
   * enters the queue.
   */
  const vaultWrite = (run: (target: VaultWriteTarget) => Promise<ToolText>): Promise<ToolText> => {
    const gate = resolve();
    if (!gate.ok) return Promise.resolve(gate.result);
    return withVaultWrite(store, ctx.config, ctx.avatarUserId, run);
  };
  /**
   * `ensureClone` for a clone op on paths that are not vault notes. For an
   * owner whose vault is in the memory service it also refuses a path that
   * resolves, through a link in the repository, to a clone file in the vault
   * folders (those are not the tools'); for everyone else it is `ensureClone`.
   */
  const cloneFor = (memoryHome: boolean, ...rawPaths: string[]) =>
    memoryHome ? cloneWithoutVaultAlias(ensureClone, ...rawPaths) : ensureClone;
  const listText = {
    empty: "(The repository is empty.)",
    onBody: (body: string) => `Knowledge repository file list:\n${body}`,
  };
  // The result lines of a clone change (what every path said before the vault could live elsewhere).
  const repoText = {
    saved: (path: string) => `Saved the file ${path}. (Not committed yet — push it with mcp__repo__commit.)`,
    edited: (path: string, count: number) =>
      `Edited ${path} (${count} replacement${count === 1 ? "" : "s"}). (Not committed yet — push it with mcp__repo__commit.)`,
    deleted: (path: string) => `Deleted ${path}. (Not committed yet — push it with mcp__repo__commit.)`,
    moved: (from: string, to: string) => `Moved ${from} → ${to}. (Not committed yet — push it with mcp__repo__commit.)`,
  };

  const manageTools = [
    tool(
      "list_files",
      "List the files of the owner's personal knowledge repository (notes, skills and the second-brain wiki) — not a registered code repository (mcp__git_repo__list_files). (owner or trusted teammates; read-only)",
      {},
      () => {
        const v = vault();
        if (v) return runVaultListFiles(resolveRead(), ensureClone, listTree, v, listText);
        return runListFiles(resolveRead(), ensureClone, listTree, listText);
      },
    ),
    tool(
      "read_file",
      "Read a file of the owner's personal knowledge repository (notes, skills and the second-brain wiki) — not a registered code repository (mcp__git_repo__read_file). (owner or trusted teammates; read-only)",
      { path: z.string().describe("Path relative to the repository root (e.g. skills/foo/SKILL.md)") },
      (args) => {
        const v = vault();
        const note = v ? vaultNotePathOf(args.path) : null;
        if (v && note) return runVaultReadFile(resolveRead(), v, note);
        return runReadFile(resolveRead(), cloneFor(v !== null, args.path), readRepoFile, args.path);
      },
    ),
    tool(
      "write_file",
      `Create/modify a file in the owner's personal knowledge repository (creates it if it doesn't exist). The change reaches the repository only when you call mcp__repo__commit, so commit after writing. Until then a repository file exists only in Noah's working copy and may disappear on the next sync; a vault note (CLAUDE.md, wiki/, raw/ markdown) of an owner whose vault lives in the memory service is already saved when this returns — the result says which applies. ${writeGate}`,
      {
        path: z.string().describe("Path relative to the repository root"),
        content: z.string().describe("The full file content"),
      },
      async (args) => {
        const note = vaultNotePathOf(args.path);
        let out: ToolText;
        if (note) {
          out = await vaultWrite((target) =>
            target.home === "memory"
              ? runVaultWriteFile(resolve(), target.vault, note, args, (path) => `Saved the file ${path}. ${VAULT_NOTE_SAVED}`)
              : runWriteFile(resolve(), ensureClone, writeRepoFile, args, repoText.saved),
          );
        } else {
          // Not a vault note: the clone, in both homes. Next to a vault in the memory service the new file
          // must not take the place of a folder of notes (or sit under a note).
          const v = vault();
          out =
            (v ? await refuseNoteTreeCollision(resolve(), v, args.path) : null) ??
            (await runWriteFile(resolve(), cloneFor(v !== null, args.path), writeRepoFile, args, repoText.saved));
        }
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({ action: "add", path: args.path });
        }
        return out;
      },
    ),
    tool(
      "edit_file",
      `Modify an EXISTING file in the knowledge repository by replacing an exact text snippet. **Prefer this over mcp__repo__write_file when changing a file that already exists** — you only send the part that changes, not the whole file (cheaper and safer for large notes/skills). Read the file first if unsure of the exact text. \`old_string\` must match the file exactly (including whitespace/indentation) and be unique, unless you set \`replace_all\`. The change reaches the repository only when you call mcp__repo__commit, so commit after writing. Until then a repository file exists only in Noah's working copy and may disappear on the next sync; a vault note (CLAUDE.md, wiki/, raw/ markdown) of an owner whose vault lives in the memory service is already saved when this returns — the result says which applies. ${writeGate}`,
      {
        path: z.string().describe("Path relative to the repository root"),
        old_string: z.string().describe("The exact text to replace (must be unique in the file unless replace_all is true)"),
        new_string: z.string().describe("The replacement text"),
        replace_all: z
          .boolean()
          .optional()
          .describe("Replace every occurrence instead of requiring a unique match (default false)"),
      },
      async (args) => {
        const note = vaultNotePathOf(args.path);
        const out = note
          ? await vaultWrite((target) =>
              target.home === "memory"
                ? runVaultEditFile(
                    resolve(),
                    target.vault,
                    note,
                    args,
                    (path, count) => `Edited ${path} (${count} replacement${count === 1 ? "" : "s"}). ${VAULT_NOTE_SAVED}`,
                  )
                : runEditFile(resolve(), ensureClone, editRepoFile, args, repoText.edited),
            )
          : await runEditFile(resolve(), cloneFor(vault() !== null, args.path), editRepoFile, args, repoText.edited);
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({ action: "update", path: args.path });
        }
        return out;
      },
    ),
    tool(
      "delete_file",
      `Delete a file OR a whole directory (e.g. an entire skill folder \`skills/<name>\`) from the knowledge repository. The deletion reaches the repository only when you call mcp__repo__commit, so commit after deleting. Until then a deleted repository file may reappear on the next sync; a vault note of an owner whose vault lives in the memory service is deleted at once — the result says which applies. ${writeGate}`,
      { path: z.string().describe("Path relative to the repository root — a file (skills/foo/SKILL.md) or a directory (skills/foo)") },
      (args) => {
        if (touchesVault(args.path)) {
          return vaultWrite((target) =>
            target.home === "memory"
              ? runVaultDeleteFile(
                  resolve(),
                  cloneWithoutVaultAlias(ensureClone, { path: args.path, leafLinkOk: true }),
                  { listTree, deleteFile: deleteRepoFile },
                  target.vault,
                  args.path,
                  {
                    repo: repoText.deleted,
                    note: (path) =>
                      `Deleted ${path}. (Vault note: the deletion is saved now. It needs no commit to take effect; mcp__repo__commit pushes it to the repository's copy.)`,
                    folder: (path, count) =>
                      `Deleted ${path}. (Its ${count} vault note(s) are deleted now; any other file under it is deleted in the working tree only. mcp__repo__commit pushes both to the repository.)`,
                  },
                )
              : runDeleteFile(resolve(), ensureClone, deleteRepoFile, args.path, repoText.deleted),
          );
        }
        const memoryHome = vault() !== null;
        return runDeleteFile(
          resolve(),
          memoryHome ? cloneWithoutVaultAlias(ensureClone, { path: args.path, leafLinkOk: true }) : ensureClone,
          deleteRepoFile,
          args.path,
          repoText.deleted,
        );
      },
    ),
    tool(
      "move_file",
      `Rename or move a file/directory within the knowledge repository (e.g. rename a skill folder or relocate a note). The move reaches the repository only when you call mcp__repo__commit; a vault note of an owner whose vault lives in the memory service is moved at once — the result says which applies. ${writeGate}`,
      {
        from: z.string().describe("Current path relative to the repository root"),
        to: z.string().describe("New path relative to the repository root"),
      },
      (args) => {
        if (touchesVault(args.from) || touchesVault(args.to)) {
          return vaultWrite((target) =>
            target.home === "memory"
              ? runVaultMoveFile(
                  resolve(),
                  cloneFor(true, args.from, args.to),
                  { listTree, readFile: readRepoFile, writeFile: writeRepoFile, deleteFile: deleteRepoFile, moveFile: moveRepoFile },
                  target.vault,
                  args,
                  {
                    repo: repoText.moved,
                    notes: (from, to) =>
                      `Moved ${from} → ${to}. (Vault notes: the move is saved now. It needs no commit to take effect; mcp__repo__commit pushes it to the repository's copy.)`,
                    mixed: (from, to) =>
                      `Moved ${from} → ${to}. (The vault notes of this move are saved now; the files outside the vault changed in the working tree only. mcp__repo__commit pushes both to the repository.)`,
                  },
                )
              : runMoveFile(resolve(), ensureClone, moveRepoFile, args, repoText.moved),
          );
        }
        return runMoveFile(resolve(), cloneFor(vault() !== null, args.from, args.to), moveRepoFile, args, repoText.moved);
      },
    ),
    tool(
      "scaffold_skill",
      `Create a new skill (skills/<name>/SKILL.md + marketplace registration) in the knowledge repository. After creating it, fill in the content with mcp__repo__write_file and push with mcp__repo__commit, and from the next conversation the avatar can use that skill. ${writeGate}`,
      {
        name: z.string().describe("Skill name (e.g. deploy-runbook)"),
        description: z.string().optional().describe("One-line description of the skill"),
      },
      (args) => runScaffoldSkill(resolve(), ensureClone, scaffoldSkill, args),
    ),
    tool(
      "commit",
      `Commit all changes in the owner's personal knowledge repository and push them to its remote branch — not a registered code repository (mcp__git_repo__commit). Call this when a unit of work is finished or when the user requests it. ${writeGate}`,
      { message: z.string().describe("Commit message") },
      async (args) => {
        if (!canWrite) {
          return text(OWNER_ONLY, true);
        }
        const c = repoCtx();
        if (!c) {
          return text(NO_REPO, true);
        }
        // Either token can authenticate the push: on a GHES deployment a
        // github.com knowledge repo is covered by the EXTERNAL token
        // (tokenForGitUrl routes by host), so refuse only when BOTH are absent.
        if (!c.token && !c.externalToken) {
          return text(NO_GIT_TOKEN, true);
        }
        // Shared-account teammate commits carry a Co-authored-by trailer so git
        // HISTORY records the actual person too — the commit stays authored as
        // the owner (whose token pushes), and the audit below logs the actor.
        const teammate =
          ctx.viewer && ctx.viewer.id !== ctx.owner.id ? ctx.viewer : null;
        let message = args.message;
        if (teammate) {
          const viewerUser = store.getUserById(teammate.id);
          const co = viewerUser
            ? commitIdentityFor(store, viewerUser)
            : {
                name: teammate.name || "teammate",
                email: "teammate@noah-almighty.local",
              };
          const coName = co.name.replace(/[<>]/g, "").trim() || "teammate";
          message = `${args.message.trim() || "Update knowledge repo"}\n\nCo-authored-by: ${coName} <${co.email}>`;
        }
        try {
          // No ensureClone here: commitAndPush operates on the already-synced
          // working tree (write_file/scaffold_skill cloned it) and guards with
          // its own NOT_CLONED check. Re-syncing would only add a needless fetch.
          // Vault in the memory service: the clone's copy of the vault notes is brought up to date first, so
          // this commit carries it. A copy that could not be updated is reported, never a reason to stop.
          const mirrored = vault() ? await commitWithVaultMirror(store, c, message, commitIdentityFor(store, ctx.owner)) : null;
          const committed = mirrored ? mirrored.committed : await commitAndPush(c, message, commitIdentityFor(store, ctx.owner));
          const mirrorNote = mirrored
            ? vaultMirrorNote(mirrored.mirror, committed, mirrored.changed, store.getPersonalVault(c.userId)?.mirrorHold ?? null)
            : "";
          if (!committed) {
            return text(mirrored ? `${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}${mirrorNote}` : NO_CHANGES);
          }
          // Audit the person who actually drove the push: on a shared account a
          // trusted teammate can commit, and the trail must say so. An owner run
          // (viewer == owner, or no viewer) keeps the original owner attribution.
          const actor =
            ctx.viewer && ctx.viewer.id !== ctx.owner.id
              ? ctx.viewer
              : { id: ctx.owner.id, name: ctx.owner.username };
          store.audit({
            actorUserId: actor.id,
            actorName: actor.name,
            action: "knowledge_repo_push",
            status: "success",
            detail:
              actor.id === ctx.owner.id
                ? `pushed to ${c.repo}`
                : `pushed to ${c.repo} (shared account, owner ${ctx.owner.username})`,
          });
          // The commit may have moved, deleted or edited a SHARED skill dir, and
          // the share rows are only a snapshot of it. The working tree is right
          // here and freshly committed, so reconcile now instead of waiting for
          // the owner to open the 스킬 배우기 tab — and the rename this commit
          // just recorded is the evidence the reconciliation reads.
          const shares = await reconcileSharesAfterCommit(
            store,
            ctx.owner.id,
            knowledgeClonePath(c.userId, c.config),
          );
          return text(`Committed and pushed the changes: ${c.repo}${shares}${mirrorNote}`);
        } catch (error) {
          return text(commitFailureMessage(error), true);
        }
      },
    ),
  ];

  // Only meaningful (and only exposed) when no repo is connected yet. Once one
  // exists, the caller passes allowCreate=false so this tool stays out of the
  // prompt — the manage tools above are what an established repo needs.
  if (!opts.allowCreate) {
    return manageTools;
  }
  const createTool = tool(
    "create_repo",
    `Create (or connect) the owner's personal knowledge repository — the git repo of their notes, skills and second-brain wiki. **Use it when the owner asks you to create or connect a knowledge repository** — do not walk through manual setup or try mcp__repo__scaffold_skill first. ${githubHostDescription(ctx.config.githubHost)} Using the configured internal Git token (GIT_TOKEN), it creates a new internal GitHub knowledge repository (private by default, initialized from the Claude plugin marketplace template) and connects it right away. By default the repo is created under the owner's personal account; pass \`org\` to create it under a GitHub organization instead. Use it when there is no knowledge repository yet; you only need the repository name. After creation, fill in the content with mcp__repo__scaffold_skill → mcp__repo__write_file → mcp__repo__commit. (owner only)`,
    {
      name: z.string().describe("New repository name (letters/digits and - _ . only, e.g. my-knowledge)"),
      org: z.string().optional().describe("GitHub organization to create the repo under (e.g. acme). Omit to create under the owner's personal account."),
      private: z.boolean().optional().describe("Whether it is private (default true)"),
      description: z.string().optional().describe("Repository description (optional)"),
    },
    async (args) => {
      if (!ctx.viewerIsOwner) {
        return text(OWNER_ONLY, true);
      }
      if (repoCtx()) {
        return text("A knowledge repository is already connected. There is no need to create a new one.", true);
      }
      const token = store.getGitToken(ctx.avatarUserId);
      if (!token) {
        return text(
          "To create a GitHub repository, please first register an internal Git token (GIT_TOKEN) under Settings → Git credentials. (A token with repo-creation permission is required.)",
          true,
        );
      }
      const validated = validateRepoCreateNames(args.name, args.org);
      if (!validated.ok) {
        return text(validated.message, true);
      }
      const { name, org } = validated;
      const targetHost = normalizeGithubHost(ctx.config.githubHost);
      try {
        const result = await (opts.createRemoteRepo ?? createRemoteRepo)(
          targetHost,
          token,
          name,
          args.private ?? true,
          (args.description ?? "").trim(),
          ctx.config.githubCaCert,
          org || undefined,
        );
        if (!result.ok) {
          return text(createRepoFailureMessage(targetHost, result), true);
        }
        store.setKnowledgeRepo(ctx.avatarUserId, result.fullName, result.defaultBranch);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "knowledge_repo_create",
          status: "success",
          detail: `created ${result.fullName}`,
        });
        // Seed the default template (a valid empty Claude plugin marketplace +
        // README) as the repo's initial content, so it loads as a marketplace
        // immediately. Best-effort: the repo is already created + connected, so a
        // clone/push hiccup shouldn't read as a hard failure — the avatar can
        // still start with scaffold_skill (which writes the manifest itself).
        let seeded = false;
        let seedNote = "";
        let vaultSeedNote = "";
        try {
          // The template holds vault notes (CLAUDE.md, wiki/index.md, …): it is written inside the owner's
          // vault write queue, with the home decided there — like every other vault write.
          await withVaultWrite(store, ctx.config, ctx.avatarUserId, async (target) => {
            const c = knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);
            if (!c) return;
            const repoRoot = await ensureClone(c);
            if (target.home === "memory") {
              // The vault is ALREADY in the memory service (the row outlived a disconnected repository). A
              // repository that brings vault notes of its own is not written over — a clone file at a vault
              // path is never a tool's to touch, and the repo-change rules judge what happens to those notes.
              if ((await listTree(repoRoot)).some((e) => e.type === "file" && isPersonalVaultPath(e.path))) {
                seedNote =
                  " (Skipped the default template: this repository already holds vault notes of its own, which are left as they are.)";
                return;
              }
              if (await writeRepoTemplate(repoRoot, result.fullName)) {
                vaultSeedNote = await moveTemplateNotesToVault(target.vault, repoRoot);
                await commitAndPush(c, "Initialize knowledge repo", commitIdentityFor(store, ctx.owner));
                seeded = true;
              }
              return;
            }
            if (await writeRepoTemplate(repoRoot, result.fullName)) {
              await commitAndPush(c, "Initialize knowledge repo", commitIdentityFor(store, ctx.owner));
              seeded = true;
            }
          });
        } catch (error) {
          seedNote = ` (Skipped initializing the default template: ${scrubGitError(error)})`;
        }
        // The repository is connected (and seeded when that worked): the vault's side of a new connection —
        // cutting the owner over, or checking the repository before the mirror writes into it — starts now.
        try {
          onKnowledgeRepoChanged(store, ctx.config, ctx.avatarUserId, null);
        } catch (error) {
          logger.warn({ userId: ctx.avatarUserId, err: error }, "knowledge repo created, but the vault follow-up could not be started");
        }
        const kind = result.isPrivate ? "private" : "public";
        return text(
          seeded
            ? `Created the ${kind} knowledge repository \`${result.fullName}\` and initialized it with the default template (Claude plugin marketplace: \`.claude-plugin/marketplace.json\` + README + a root \`CLAUDE.md\` that is injected as standing guidance every conversation). Edit \`CLAUDE.md\` for always-apply rules, add your first skill with \`mcp__repo__scaffold_skill\`, and push with \`mcp__repo__commit\`.${vaultSeedNote}`
            : `Created and connected the ${kind} knowledge repository \`${result.fullName}\`.${seedNote} Create your first skill with \`mcp__repo__scaffold_skill\`, then push with \`mcp__repo__commit\`.`,
        );
      } catch (error) {
        return text(createRepoCatchMessage(targetHost, error), true);
      }
    },
  );
  return [createTool, ...manageTools];
}

/**
 * Build the in-process MCP server exposing the knowledge-repo management tools,
 * bound to a single conversation's store + context. `allowCreate` adds the
 * repo-creation tool (only when the owner has no repo yet — see its export doc).
 */
export function buildRepoServer(
  store: Store,
  ctx: RepoToolsContext,
  opts: { allowCreate?: boolean } = {},
) {
  return createMcpToolServer({
    name: REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildRepoTools(store, ctx, opts),
  });
}
