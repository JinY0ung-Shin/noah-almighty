import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import { decodeExecError, text } from "./mcpTools.js";
import { PI_REPO_REPLACED_COPY_SENTENCE } from "./ownerState.js";
import { setWorkspaceRepo } from "../repoWorkspace.js";
import { commitIdentityFor } from "../knowledgeRepo.js";
import type { PiWorkspace } from "./pi/piWorkspace.js";
import {
  claimPiRepoCopy,
  commitPiRepoCopy,
  ensurePiRepoCopy,
  piRepoCopyLockKey,
  piRepoCopySandboxPath,
  piRepoCopyStatus,
  copyChangeCount,
  copyHasChanges,
  removePiRepoCopy,
  setPiRepoCopyHolder,
  type PiRepoCopyRef,
} from "./pi/piRepoCopy.js";
import { activeRepoHolder, type RunRepoLocks } from "../activeRepoLock.js";
import { RepoReadError, grepRepo, listRepoFiles, readRepoFile } from "../gitRepoRead.js";
import {
  configureGitRepoIdentity,
  defaultGitRepoName,
  ensureGitRepoClone,
  gitRepoClonePath,
  gitRepoContextFor,
  gitRepoContextFromRecord,
  normalizeGitRepoName,
  pushGitRepo,
  removeGitRepoClone,
} from "../gitRepos.js";

export interface GitRepoToolsContext {
  /** The avatar owner whose registered repos and git tokens are used. */
  avatarUserId: string;
  owner: AgentOwner;
  /** True for the avatar owner in an interactive chat AND in an owner routine run. */
  viewerIsOwner: boolean;
  /**
   * True for owner/trusted-user interactive chats AND owner routine runs (the
   * scheduler passes elevated:true). open_repo/close_repo gate on this, so a
   * routine can open a working repo.
   */
  elevated: boolean;
  config: AppConfig;
  /**
   * The conversation this run belongs to. Needed by `open_repo`/`close_repo` to
   * record the working-repo selection the chat route AND the routine scheduler
   * read on the next turn/run (persisted on conversations.working_repo). Unset
   * only for runs with no conversation (e.g. headless intro generation) —
   * open_repo then reports it cannot open a working repo.
   */
  conversationId?: string;
  /**
   * The VIEWER's sandbox workspace the repo copy lives in (docs/architecture/pi-runtime.md,
   * design D1): the model works on a sandbox COPY, so open_repo makes that copy and
   * `commit` reads its working tree back into Noah's clone and commits there. Unset
   * (the static tool catalog, a run without the workspace mount) → the copy tools
   * refuse with NO_PI_WORKSPACE.
   */
  piWorkspace?: PiWorkspace;
  /**
   * This RUN's copy locks (`RunRepoLocks`, made and released by `runPiAgent`):
   * open_repo, sync_repo and commit TAKE the sandbox copy's run lock for this
   * conversation and keep it until the run ends, so another conversation's run
   * cannot take the copy over mid-turn. Unset (a direct tool build in a test, a
   * run with no run scope) → they only check that no other run holds it.
   */
  copyRunLock?: Pick<RunRepoLocks, "acquire">;
}

/** MCP server name; tools surface to the model as `mcp__git_repo__<tool>`. */
export const GIT_REPO_SERVER_NAME = "git_repo";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const GIT_REPO_TOOL_NAMES = [
  "mcp__git_repo__register_repo",
  "mcp__git_repo__list_repos",
  "mcp__git_repo__sync_repo",
  "mcp__git_repo__remove_repo",
  "mcp__git_repo__open_repo",
  "mcp__git_repo__close_repo",
  "mcp__git_repo__push",
] as const;

/** Commit the sandbox copy's working tree into Noah's clone. */
export const GIT_REPO_PI_COMMIT_TOOL_NAME = "mcp__git_repo__commit";

/**
 * Read-only access to the owner's canonical clone for a run whose sandbox is
 * NOT the owner's (a trusted colleague's chat): no copy of the owner's repo is
 * ever made there (review #11, user decision 2026-11-01). Registered on every
 * git_repo server (the static catalog lists them); `mcpAllowedTools` admits
 * them only on such runs, and the handlers re-check the same.
 */
export const GIT_REPO_READ_TOOL_NAMES = [
  "mcp__git_repo__list_files",
  "mcp__git_repo__read_file",
  "mcp__git_repo__grep",
] as const;

const OWNER_ONLY = "This tool can only be used in a conversation the avatar owner is taking part in.";
const ELEVATED_ONLY = "This git repo tool can only be used in a conversation with the avatar owner or a trusted user.";

function errorMessage(error: unknown): string {
  return decodeExecError(error).message;
}

function renderRepo(repo: ReturnType<Store["listGitRepos"]>[number]): string {
  return [
    `name=${repo.name}`,
    `repo=${repo.repo}`,
    repo.branch ? `branch=${repo.branch}` : "branch=(default)",
    repo.lastSyncedAt ? `lastSyncedAt=${repo.lastSyncedAt}` : "lastSyncedAt=null",
  ].join(" | ");
}

/**
 * Build general git repository tools. Persistent repo registration is
 * owner-only; work on already-registered repos is owner/trusted-only.
 */
export function buildGitRepoTools(store: Store, ctx: GitRepoToolsContext) {
  const ownerRepoContext = (name: string) => {
    const repoCtx = gitRepoContextFor(store, ctx.avatarUserId, name, ctx.config);
    if (!repoCtx) {
      throw new Error(`Could not find a registered git repo named '${normalizeGitRepoName(name)}'. Use register_repo first.`);
    }
    return repoCtx;
  };

  const elevatedGuard = () => {
    if (!ctx.elevated) {
      return text(ELEVATED_ONLY, true);
    }
    return null;
  };
  const ownerGuard = () => {
    if (!ctx.viewerIsOwner) {
      return text(OWNER_ONLY, true);
    }
    return null;
  };
  /**
   * Whether this run works in the avatar OWNER's own sandbox (owner chat,
   * routine, task API). Anyone else's run — a colleague chatting with the
   * owner's avatar — gets NO copy of the owner's repo in their sandbox: it reads
   * the canonical clone through the read tools below instead (review #11).
   */
  const ownSandbox = ctx.piWorkspace ? ctx.piWorkspace.principal === ctx.avatarUserId : ctx.viewerIsOwner;
  const readToolsRedirect = (name: string) =>
    `read it with mcp__git_repo__list_files / mcp__git_repo__read_file / mcp__git_repo__grep (name='${name}') — there is no copy of it in your sandbox and no /workspace path to it`;
  // The owner's sandbox copy of one of the OWNER's repos (none on anyone else's run).
  const copyRef = (name: string): PiRepoCopyRef | null =>
    ctx.piWorkspace && ownSandbox
      ? {
          config: ctx.config,
          workspace: ctx.piWorkspace,
          ownerId: ctx.avatarUserId,
          name,
          clonePath: gitRepoClonePath(ctx.avatarUserId, name, ctx.config),
        }
      : null;
  /**
   * The copy is ONE per (principal, owner, repo), shared by all of the
   * principal's conversations (activeRepoResolve.ts): refuse while another
   * conversation's RUN holds it, or while another conversation that still has
   * the repo open left uncommitted changes in it — committing, syncing or
   * re-copying then would take that conversation's half-done work. Null = go,
   * and the copy's run lock is then HELD by this run until it ends
   * (`copyRunLock`), exactly like a turn that started with the repo open.
   */
  const copyAccessRefusal = async (ref: PiRepoCopyRef): Promise<ReturnType<typeof text> | null> => {
    const conversationId = ctx.conversationId ?? "";
    const key = piRepoCopyLockKey(ref);
    const running = activeRepoHolder(key);
    const lock = ctx.copyRunLock
      ? ctx.copyRunLock.acquire(key)
      : running && running !== conversationId
        ? { ok: false as const }
        : { ok: true as const, undo: () => {} };
    if (!lock.ok) {
      return text(
        `'${ref.name}': another conversation's run is working on this sandbox copy right now, so this conversation cannot change, commit or sync it. Tell the user and try again after that run ends.`,
        true,
      );
    }
    const claim = await claimPiRepoCopy(ref, conversationId, (holder) => store.getConversationWorkingRepo(holder) === ref.name).catch(
      (error: unknown) => {
        lock.undo();
        throw error;
      },
    );
    if (claim.kind === "held") {
      lock.undo(); // a refused tool never keeps the other conversation's run out
      return text(
        `'${ref.name}': the sandbox copy ${piRepoCopySandboxPath(ctx.avatarUserId, ref.name)} holds uncommitted changes from another conversation that still has this repository open, so this conversation must not commit, sync or re-copy it. Do not edit that copy. Tell the user to commit those changes (or close_repo) in that other conversation first.`,
        true,
      );
    }
    return null;
  };
  /** The refusal for a copy whose own git HEAD left its base (checkout/switch/reset/rebase in the sandbox). */
  const divergedRefusal = (lead: string, name: string, status: { base: string; tip: string | null }): string =>
    `${lead}: the git HEAD of your sandbox copy ${piRepoCopySandboxPath(ctx.avatarUserId, name)} is no longer on the commit Noah gave it (base ${status.base.slice(0, 8)}, copy HEAD ${status.tip ? status.tip.slice(0, 8) : "unreadable"}) — a checkout, switch, reset or rebase in the sandbox replaced its files with another state, and applying them would silently undo other work. Nothing was applied. If you only switched branches, switch the copy back to the branch it was on (your uncommitted edits ride along) and try again; otherwise call mcp__git_repo__open_repo with name='${name}' for a fresh copy (this one is moved aside, not deleted) and redo the edits there. Never checkout/switch/reset/rebase in the copy.`;
  const NO_PI_WORKSPACE =
    "This run cannot reach your sandbox workspace from Noah (the workspace mount is not configured), so the repository cannot be copied in or committed from it.";
  /**
   * The read tools' gate: elevated, NOT the owner's own sandbox (the owner
   * works on its copy), and the repo still registered for the avatar owner —
   * then the canonical clone (made if missing, never synced here). Returns the
   * clone path or a refusal.
   */
  const readableClone = async (name: string): Promise<{ clone: string; name: string } | ReturnType<typeof text>> => {
    const denied = elevatedGuard();
    if (denied) return denied;
    if (ownSandbox && ctx.piWorkspace) {
      return text(
        "On the avatar owner's own runs a repository is read from its sandbox copy: call mcp__git_repo__open_repo and read the copy it reports with your built-in tools. These read tools are for a conversation that has no copy (a trusted colleague's).",
        true,
      );
    }
    const repoCtx = ownerRepoContext(name);
    return { clone: await ensureGitRepoClone(repoCtx), name: repoCtx.name };
  };
  const readFailure = (error: unknown) =>
    text(error instanceof RepoReadError ? error.message : `Could not read the repository: ${errorMessage(error)}`, true);

  const tools = [
    tool(
      "register_repo",
      "Register a general git repository in this avatar owner's repo list and create a local working clone. repo accepts owner/repo, an https URL, a git URL, or a local bare repo path. If branch is specified, subsequent sync/commit/push target that branch; if left empty, the repository's default branch is used. NEW-BRANCH NOTE: a branch that does NOT yet exist on origin cannot be cloned/checked out here, so this call ERRORS (e.g. \"'origin/<branch>' is not a commit\") — but creating a remote branch is the job of `mcp__git_repo__push`, not this tool. The branch you pass is still saved on an ALREADY-registered repo even when this checkout step errors (only a brand-new registration is rolled back on failure), so the normal flow to start a new branch is: set the new branch name here, ignore the checkout error, then commit your local HEAD and `mcp__git_repo__push` — push creates the branch on origin. (Alternatively, create the branch on the remote first, then register.) Public repo clone/sync is attempted without a token, and a token is only used if one exists for the configured internal host or github.com. (owner only)",
      {
        repo: z.string().describe("The git repository to register. e.g. owner/repo, https://github.com/owner/repo.git, /path/to/repo.git"),
        name: z.string().optional().describe("A short name to use in the conversation. If empty, it is auto-generated from the repo name."),
        branch: z.string().optional().describe("The branch to use. Not limited to main; if empty, the repository's default branch is used. A branch that does not exist on origin yet cannot be checked out here (this call errors), but `mcp__git_repo__push` will create it on origin — so for a new branch, set the name here and then commit + push."),
      },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        const name = normalizeGitRepoName(args.name || defaultGitRepoName(args.repo));
        // Track whether this name was already registered: on a failed clone we roll
        // back a NEWLY-created row (so a typo'd repo doesn't linger in list_repos),
        // but must leave a pre-existing registration intact. NOTE: this is also what
        // lets a re-register with a not-yet-existing branch "stick" — the branch is
        // upserted before the clone, and an already-existing registration is NOT
        // rolled back on the checkout error, so a later push can create that branch.
        const existed = Boolean(store.getGitRepo(ctx.avatarUserId, name));
        try {
          const record = store.upsertGitRepo(ctx.avatarUserId, name, args.repo, args.branch || null);
          const repoCtx = gitRepoContextFromRecord(store, record, ctx.config);
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, name);
          return text(`Registered and synced the git repo: ${renderRepo(store.getGitRepo(ctx.avatarUserId, name)!)}.`);
        } catch (error) {
          if (!existed) store.deleteGitRepo(ctx.avatarUserId, name);
          return text(
            `Failed to register/sync git repo: ${errorMessage(error)}\nCheck the repo address, branch name, and access permissions. If you named a branch that does not exist on origin yet, that is expected — the branch setting is still saved for an already-registered repo, so you can now commit and push (push creates the new branch on origin). A private repo requires the token under Settings → Git credentials. Do not work around this with Bash \`git clone\` — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "list_repos",
      "List the general git repositories registered for this avatar owner. (owner / trusted user only)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        const repos = store.listGitRepos(ctx.avatarUserId);
        if (repos.length === 0) {
          return text("There are no registered general git repos. The owner must register one first with register_repo.");
        }
        return text(`${repos.length} registered git repo(s):\n${repos.map(renderRepo).join("\n")}`);
      },
    ),
    tool(
      "sync_repo",
      "Fetch a registered git repository into Noah's clone, rebasing its commits onto the upstream, then refresh your sandbox copy to the result. Refused while your sandbox copy has changes that are not committed yet (commit them first with `mcp__git_repo__commit`), so nothing you wrote is overwritten. A public repo attempts this without a token. If Noah's commits genuinely conflict with the remote the rebase is rolled back and this errors. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const ref = copyRef(repoCtx.name);
          if (ref) {
            const refused = await copyAccessRefusal(ref);
            if (refused) return refused;
            const status = await piRepoCopyStatus(ref);
            if (status.kind === "diverged") return text(divergedRefusal("Not synced", repoCtx.name, status), true);
            if (copyHasChanges(status)) {
              const count = copyChangeCount(status);
              const copyPath = piRepoCopySandboxPath(ctx.avatarUserId, repoCtx.name);
              return text(
                status.kind === "moved"
                  ? `Not synced: your sandbox copy ${copyPath} has ${count === null ? "uncommitted changes" : `${count} uncommitted file change(s)`} made on an older state of '${repoCtx.name}' (Noah's clone moved since the copy was made, so they cannot be committed as they are). Call mcp__git_repo__open_repo with name='${repoCtx.name}' for a fresh copy — this one, with your changes, is moved aside to ${copyPath}.prev-<UTC stamp> and kept there until remove_repo — re-apply the edits there, commit them, then sync again.`
                  : `Not synced: your sandbox copy ${copyPath} has ${count} uncommitted file change(s). Save them with mcp__git_repo__commit first (or move them out of the copy), then sync again.`,
                true,
              );
            }
          }
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, repoCtx.name);
          if (ref) {
            // No tracked change just now; deleted only if it holds nothing but its base.
            const copy = await ensurePiRepoCopy(ref, "refresh");
            return text(
              `Synced the git repo: ${repoCtx.name}. Your sandbox copy at ${copy.sandboxPath} now matches it.` +
                (copy.previousPath
                  ? ` The previous copy held content that is not in its commit (ignored or extra files, links, stashes or sandbox commits), so it was moved to ${copy.previousPath}, where it stays until remove_repo; move anything you still need out of it.`
                  : ""),
            );
          }
          return text(`Synced the git repo: ${repoCtx.name}`);
        } catch (error) {
          return text(
            `Sync failed: ${errorMessage(error)}\nIf the rebase conflicted, the clone was rolled back to its previous state — reconcile the conflicting changes (re-apply them on top of the latest remote, or discard local work) and sync again. Do not work around this with Bash git — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "remove_repo",
      "Remove a registered general git repository from the list and delete its local working clone, together with your sandbox copy of it and every `<name>.prev-<UTC stamp>` folder moved aside next to it. Does not delete the remote repository. (owner only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = ownerGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const removed = store.deleteGitRepo(ctx.avatarUserId, repoCtx.name);
          await removeGitRepoClone(repoCtx);
          if (ctx.piWorkspace) {
            removePiRepoCopy({ config: ctx.config, workspace: ctx.piWorkspace, ownerId: ctx.avatarUserId, name: repoCtx.name });
          }
          return text(removed ? `Removed the git repo registration: ${repoCtx.name}` : `No registered git repo found: ${repoCtx.name}`);
        } catch (error) {
          return text(`Failed to remove repo: ${errorMessage(error)}`, true);
        }
      },
    ),
    tool(
      "open_repo",
      "Open a registered git repository for THIS conversation: Noah copies its current state — working tree AND .git, as plain files — into your sandbox at `/workspace/repos/<owner>/<name>/` and the result gives that absolute path; it is usable right away, in this same turn. Edit and test the files there with your built-in tools; `git status`/`diff`/`log` work in the copy (never checkout/switch/reset/rebase there — commit refuses a copy whose git HEAD left the commit Noah gave it), but anything you commit with git there stays in the sandbox — to SAVE your work call `mcp__git_repo__commit` (name + message), which reads the copy's files back into Noah's own clone and commits there, then `mcp__git_repo__push` to send it to origin; `mcp__git_repo__sync_repo` pulls upstream changes and refreshes the copy. Re-opening keeps an existing copy that is still current; a copy made from an older state (or whose git HEAD left that commit) is replaced. " +
        PI_REPO_REPLACED_COPY_SENTENCE +
        " The selection persists for this conversation (later turns are told the path) until close_repo. In a trusted colleague's conversation (not the owner's sandbox) NO copy is made: the repo is selected for reading through `mcp__git_repo__list_files`/`read_file`/`grep`. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (!ctx.conversationId) {
          return text("Cannot open a working repository in this run (no conversation context).", true);
        }
        try {
          const repoCtx = ownerRepoContext(args.name);
          if (!ownSandbox) {
            // A colleague's run: select the repo, never copy it into their sandbox.
            await ensureGitRepoClone(repoCtx);
            setWorkspaceRepo(store, ctx.conversationId, repoCtx.name);
            return text(
              `Opened '${repoCtx.name}' for reading in this conversation. It is the avatar owner's repository and this conversation does not run in the owner's sandbox, so no copy is made: ${readToolsRedirect(repoCtx.name)}. You cannot edit, commit or push it from here; to change it, tell the user what to change so the owner can do it in their own conversation.`,
            );
          }
          const ref = copyRef(repoCtx.name);
          if (!ref) return text(NO_PI_WORKSPACE, true);
          const refused = await copyAccessRefusal(ref);
          if (refused) return refused;
          await ensureGitRepoClone(repoCtx);
          await configureGitRepoIdentity(repoCtx, commitIdentityFor(store, ctx.owner));
          const copy = await ensurePiRepoCopy(ref, "keep");
          await setPiRepoCopyHolder(ref, ctx.conversationId);
          setWorkspaceRepo(store, ctx.conversationId, repoCtx.name);
          return text(
            `Opened '${repoCtx.name}'. Your working copy is at ${copy.sandboxPath} (${copy.outcome === "kept" ? "your existing copy was kept — it is current" : "a fresh copy of the current state"}).` +
              (copy.previousPath
                ? ` Your previous copy was made from an older state (or its git HEAD left that commit) and held content of its own, so it was moved to ${copy.previousPath}, where it stays until remove_repo; re-apply any edits you still need from there.`
                : copy.discardedPrevious
                  ? " Your previous copy was made from an older state and held nothing but that commit, so it was deleted."
                  : "") +
              ` Work there with absolute paths; save with mcp__git_repo__commit (name='${repoCtx.name}', message), then mcp__git_repo__push.`,
          );
        } catch (error) {
          return text(
            `Failed to open the working repository: ${errorMessage(error)}\nCheck the repo is registered (list_repos) and reachable. Do not work around this with git in the sandbox — it has no credentials and no network.`,
            true,
          );
        }
      },
    ),
    tool(
      "close_repo",
      "Close the working repository opened for this conversation, so later turns are no longer pointed at its sandbox copy. The copy itself stays in your sandbox (uncommitted edits in it are NOT saved — commit first). (owner / trusted user only)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (ctx.conversationId) setWorkspaceRepo(store, ctx.conversationId, null);
        return text("Closed the working repository for this conversation. Its sandbox copy stays where it was; open_repo brings it back.");
      },
    ),
    tool(
      "push",
      "On this runtime push sends Noah's clone — what `mcp__git_repo__commit` saved from your sandbox copy — NOT git commits you made inside the sandbox; call `mcp__git_repo__commit` first. " +
        "Push the registered git repository's current HEAD to the target branch on origin. The target is the branch saved in register_repo; if branch is empty, it's the current/default branch. Not limited to main, AND if the target branch does not exist on origin yet, push CREATES it (this — not register_repo — is how a new remote branch is made). To push to a branch other than the one currently registered, set that name via register_repo's `branch` first (the setting persists even if register's checkout step errors on a not-yet-existing branch), then push. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const branch = await pushGitRepo(repoCtx);
          const ref = copyRef(repoCtx.name);
          const status = ref ? await piRepoCopyStatus(ref).catch(() => null) : null;
          const pending = status ? copyChangeCount(status) : 0;
          return text(
            `Pushed the changes: ${repoCtx.name} -> ${branch}` +
              (pending !== 0
                ? `. Note: your sandbox copy still has ${pending === null ? "uncommitted changes" : `${pending} uncommitted file change(s)`} that were NOT pushed — commit them with mcp__git_repo__commit and push again if they belong in it.`
                : ""),
          );
        } catch (error) {
          return text(
            `push failed: ${errorMessage(error)}\nCheck remote write permission, token, and whether the branch is protected (even a public repo needs write permission to push). Do not work around this with Bash \`git push\` — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
  ];
  return [
    ...tools,
      tool(
        "commit",
        "Save your work on an opened repository: read the working tree of your sandbox copy (`/workspace/repos/<owner>/<name>/`, see open_repo) back into Noah's own clone and commit it there with this message, under the configured commit identity. Every changed, added and deleted file of the copy is included (ignored files, the copy's .git and symbolic links are not); git commits you made inside the sandbox are not used — only the files. Refused when Noah's clone moved since your copy was made (another conversation committed or a sync pulled): then open_repo again for a fresh copy (your current one is moved aside to a new `<name>.prev-<UTC stamp>` folder, kept until remove_repo, unless it provably holds nothing of yours) and redo the edits there. Also refused when the copy's own git HEAD left the commit Noah gave it: never checkout/switch/reset/rebase in the copy — its files would then be another state's, and committing them would undo other work. Then `mcp__git_repo__push` to send it to origin. (owner / trusted user only)",
        {
          name: z.string().describe("Registered repo name"),
          message: z.string().describe("The commit message"),
        },
        async (args) => {
          const denied = elevatedGuard();
          if (denied) return denied;
          try {
            const repoCtx = ownerRepoContext(args.name);
            if (!ownSandbox) {
              return text(
                `Not committed: '${repoCtx.name}' is the avatar owner's repository and this conversation does not run in the owner's sandbox, so it has no copy to commit from and cannot change the repository. ${readToolsRedirect(repoCtx.name).replace(/^r/, "R")}; to change it, tell the user what to change so the owner can do it in their own conversation.`,
                true,
              );
            }
            const ref = copyRef(repoCtx.name);
            if (!ref) return text(NO_PI_WORKSPACE, true);
            const refused = await copyAccessRefusal(ref);
            if (refused) return refused;
            await ensureGitRepoClone(repoCtx);
            await configureGitRepoIdentity(repoCtx, commitIdentityFor(store, ctx.owner));
            const outcome = await commitPiRepoCopy(ref, args.message);
            const copyPath = piRepoCopySandboxPath(ctx.avatarUserId, repoCtx.name);
            const skippedNote = (skipped: string[]) =>
              skipped.length
                ? ` Left out (links, special files or type changes Noah does not apply): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ` and ${skipped.length - 10} more` : ""}.`
                : "";
            switch (outcome.kind) {
              case "no_copy":
                return text(
                  `There is no sandbox copy of '${repoCtx.name}' to commit from. Call mcp__git_repo__open_repo with name='${repoCtx.name}' first, make your edits in the copy it reports, then commit.`,
                  true,
                );
              case "moved":
                return text(
                  `Not committed: '${repoCtx.name}' changed in Noah since your copy was made (copy base ${outcome.base.slice(0, 8)}, now ${outcome.head.slice(0, 8)}) — another conversation committed or a sync pulled. Nothing was applied. Call mcp__git_repo__open_repo with name='${repoCtx.name}' to get a fresh copy (your current copy is moved aside to ${copyPath}.prev-<UTC stamp> and kept there until remove_repo, unless it provably holds nothing of yours — then it is deleted), re-apply your edits there, and commit again.`,
                  true,
                );
              case "diverged":
                return text(divergedRefusal("Not committed", repoCtx.name, outcome), true);
              case "nothing":
                return text(`Nothing to commit: your copy ${copyPath} matches '${repoCtx.name}'.${skippedNote(outcome.skipped)}`);
              case "committed":
                return text(
                  `Committed ${outcome.commit.slice(0, 8)} to '${repoCtx.name}' (${outcome.written} file(s) written, ${outcome.deleted} deleted). Your copy's .git was refreshed, so git status there is clean again. Push it with mcp__git_repo__push (name='${repoCtx.name}').${skippedNote(outcome.skipped)}`,
                );
            }
          } catch (error) {
            return text(
              `Commit failed: ${errorMessage(error)}\nDo not work around this with git in the sandbox — it has no credentials and Noah never reads its commits.`,
              true,
            );
          }
        },
      ),
    tool(
      "list_files",
      "List the files of one of the avatar owner's registered repositories (the working tree of Noah's clone of it, read while no sync or commit is running — as its last sync or commit left it) when this conversation has NO sandbox copy of it — a trusted colleague's conversation with the owner's avatar. `path` narrows to a folder (default: the whole repo); links are shown but never followed, `.git` is not listed. Read-only. (trusted colleague only — the owner reads its own sandbox copy instead)",
      {
        name: z.string().describe("Registered repo name"),
        path: z.string().optional().describe("A folder inside the repo (default: the root)"),
      },
      async (args) => {
        try {
          const clone = await readableClone(args.name);
          if ("content" in clone) return clone;
          return text(`'${clone.name}': ${await listRepoFiles(clone.clone, args.path ?? "")}`);
        } catch (error) {
          return readFailure(error);
        }
      },
    ),
    tool(
      "read_file",
      "Read a text file of one of the avatar owner's registered repositories (the working tree of Noah's clone of it, read while no sync or commit is running — as its last sync or commit left it) when this conversation has NO sandbox copy of it — a trusted colleague's conversation with the owner's avatar. Returns lines `offset`..`offset+limit-1` (1-based; default the first 2000) and says how to continue; files over 1 MB, binary files, links and `.git` are refused. Read-only. (trusted colleague only)",
      {
        name: z.string().describe("Registered repo name"),
        path: z.string().describe("The file's path inside the repo, e.g. src/index.ts"),
        offset: z.number().int().min(1).optional().describe("First line to return (1-based, default 1)"),
        limit: z.number().int().min(1).max(5000).optional().describe("How many lines (default 2000)"),
      },
      async (args) => {
        try {
          const clone = await readableClone(args.name);
          if ("content" in clone) return clone;
          return text(await readRepoFile(clone.clone, args.path, args.offset ?? 1, args.limit ?? 2000));
        } catch (error) {
          return readFailure(error);
        }
      },
    ),
    tool(
      "grep",
      "Search one of the avatar owner's registered repositories (the files in the git index of Noah's clone of it — its last commit or sync; a link is matched as its target text) for an extended regular expression when this conversation has NO sandbox copy of it — a trusted colleague's conversation with the owner's avatar. Returns `path:line:text` matches (binary files skipped, output capped); `path` narrows to a file or folder. Read-only. (trusted colleague only)",
      {
        name: z.string().describe("Registered repo name"),
        pattern: z.string().describe("An extended (POSIX ERE) regular expression"),
        path: z.string().optional().describe("A file or folder inside the repo to search (default: everything)"),
        ignoreCase: z.boolean().optional().describe("Match case-insensitively"),
      },
      async (args) => {
        try {
          const clone = await readableClone(args.name);
          if ("content" in clone) return clone;
          return text(`'${clone.name}': ${await grepRepo(clone.clone, args.pattern, args.path ?? "", args.ignoreCase ?? false)}`);
        } catch (error) {
          return readFailure(error);
        }
      },
    ),
  ];
}

export function buildGitRepoServer(store: Store, ctx: GitRepoToolsContext) {
  return createMcpToolServer({
    name: GIT_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGitRepoTools(store, ctx),
  });
}
