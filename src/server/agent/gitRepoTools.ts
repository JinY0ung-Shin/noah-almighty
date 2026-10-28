import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import { decodeExecError, text } from "./mcpTools.js";
import { setWorkspaceRepo } from "../repoWorkspace.js";
import { commitIdentityFor } from "../knowledgeRepo.js";
import type { PiWorkspace } from "./pi/piWorkspace.js";
import {
  commitPiRepoCopy,
  ensurePiRepoCopy,
  piRepoCopySandboxPath,
  piRepoCopyStatus,
  removePiRepoCopy,
  type PiRepoCopyRef,
} from "./pi/piRepoCopy.js";
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
   * `pi`: the run executes in a pi sandbox (docs/architecture/pi-runtime.md,
   * design D1). The model works on a sandbox COPY of the repo, so open_repo
   * makes that copy, `commit` (pi only) reads the copy's working tree back into
   * Noah's clone and commits there, and the descriptions say so. The static pi
   * tool catalog is built with this flag (no workspace) for the wording.
   */
  runtime?: "pi";
  /** pi runs: the VIEWER's sandbox workspace the copy lives in. */
  piWorkspace?: PiWorkspace;
}

/** MCP server name; tools surface to the model as `mcp__git_repo__<tool>`. */
export const GIT_REPO_SERVER_NAME = "git_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GIT_REPO_TOOL_NAMES = [
  "mcp__git_repo__register_repo",
  "mcp__git_repo__list_repos",
  "mcp__git_repo__sync_repo",
  "mcp__git_repo__remove_repo",
  "mcp__git_repo__open_repo",
  "mcp__git_repo__close_repo",
  "mcp__git_repo__push",
] as const;

/** pi runs only: commit the sandbox copy's working tree into Noah's clone. */
export const GIT_REPO_PI_COMMIT_TOOL_NAME = "mcp__git_repo__commit";

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
  const pi = ctx.runtime === "pi";
  // The viewer's copy of one of the OWNER's repos (pi runs).
  const copyRef = (name: string): PiRepoCopyRef | null =>
    ctx.piWorkspace
      ? {
          config: ctx.config,
          workspace: ctx.piWorkspace,
          ownerId: ctx.avatarUserId,
          name,
          clonePath: gitRepoClonePath(ctx.avatarUserId, name, ctx.config),
        }
      : null;
  const NO_PI_WORKSPACE =
    "This run cannot reach your sandbox workspace from Noah (the workspace mount is not configured), so the repository cannot be copied in or committed from it.";

  const tools = [
    tool(
      "register_repo",
      "Register a general git repository in this avatar owner's repo list and create a local working clone. repo accepts owner/repo, an https URL, a git URL, or a local bare repo path. If branch is specified, subsequent sync/commit/push target that branch; if left empty, the repository's default branch is used. NEW-BRANCH NOTE: a branch that does NOT yet exist on origin cannot be cloned/checked out here, so this call ERRORS (e.g. \"'origin/<branch>' is not a commit\") — but creating a remote branch is the job of `push`, not this tool. The branch you pass is still saved on an ALREADY-registered repo even when this checkout step errors (only a brand-new registration is rolled back on failure), so the normal flow to start a new branch is: set the new branch name here, ignore the checkout error, then `commit` your local HEAD and `push` — push creates the branch on origin. (Alternatively, create the branch on the remote first, then register.) Public repo clone/sync is attempted without a token, and a token is only used if one exists for the configured internal host or github.com. (owner only)",
      {
        repo: z.string().describe("The git repository to register. e.g. owner/repo, https://github.com/owner/repo.git, /path/to/repo.git"),
        name: z.string().optional().describe("A short name to use in the conversation. If empty, it is auto-generated from the repo name."),
        branch: z.string().optional().describe("The branch to use. Not limited to main; if empty, the repository's default branch is used. A branch that does not exist on origin yet cannot be checked out here (this call errors), but `push` will create it on origin — so for a new branch, set the name here and then commit + push."),
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
      pi
        ? "Fetch a registered git repository into Noah's clone, rebasing its commits onto the upstream, then refresh your sandbox copy to the result. Refused while your sandbox copy has changes that are not committed yet (commit them first with `commit`), so nothing you wrote is overwritten. A public repo attempts this without a token. If Noah's commits genuinely conflict with the remote the rebase is rolled back and this errors. (owner / trusted user only)"
        : "Fetch a registered git repository and update it by rebasing local commits onto the upstream (uncommitted changes are auto-stashed and restored). A public repo attempts this without a token. If the local commits genuinely conflict with the remote the rebase is rolled back (the clone is left untouched) and this errors — reconcile and sync again. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const ref = pi ? copyRef(repoCtx.name) : null;
          if (ref) {
            const status = await piRepoCopyStatus(ref);
            if (status.kind === "ok" && (status.changes.writes.length > 0 || status.changes.deletes.length > 0)) {
              return text(
                `Not synced: your sandbox copy ${piRepoCopySandboxPath(ctx.avatarUserId, repoCtx.name)} has ${status.changes.writes.length + status.changes.deletes.length} uncommitted file change(s). Save them with mcp__git_repo__commit first (or move them out of the copy), then sync again.`,
                true,
              );
            }
          }
          await ensureGitRepoClone(repoCtx, { sync: true });
          store.markGitRepoSynced(ctx.avatarUserId, repoCtx.name);
          if (ref) {
            const copy = await ensurePiRepoCopy(ref, "refresh");
            return text(`Synced the git repo: ${repoCtx.name}. Your sandbox copy at ${copy.sandboxPath} now matches it.`);
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
      "Remove a registered general git repository from the list and delete its local working clone. Does not delete the remote repository. (owner only)",
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
    pi
      ? tool(
          "open_repo",
          "Open a registered git repository for THIS conversation: Noah copies its current state — working tree AND .git, as plain files — into your sandbox at `/workspace/repos/<owner>/<name>/` and the result gives that absolute path; it is usable right away, in this same turn. Edit and test the files there with your built-in tools; `git status`/`diff`/`log` work in the copy, but anything you commit with git there stays in the sandbox — to SAVE your work call `commit` (name + message), which reads the copy's files back into Noah's own clone and commits there, then `push` to send it to origin; `sync_repo` pulls upstream changes and refreshes the copy. Re-opening keeps an existing copy that is still current; a copy made from an older state is moved aside to `<name>.prev` and replaced. The selection persists for this conversation (later turns are told the path) until close_repo. (owner / trusted user only)",
          { name: z.string().describe("Registered repo name") },
          async (args) => {
            const denied = elevatedGuard();
            if (denied) return denied;
            if (!ctx.conversationId) {
              return text("Cannot open a working repository in this run (no conversation context).", true);
            }
            try {
              const repoCtx = ownerRepoContext(args.name);
              const ref = copyRef(repoCtx.name);
              if (!ref) return text(NO_PI_WORKSPACE, true);
              await ensureGitRepoClone(repoCtx);
              await configureGitRepoIdentity(repoCtx, commitIdentityFor(store, ctx.owner));
              const copy = await ensurePiRepoCopy(ref, "keep");
              setWorkspaceRepo(store, ctx.conversationId, repoCtx.name);
              return text(
                `Opened '${repoCtx.name}'. Your working copy is at ${copy.sandboxPath} (${copy.outcome === "kept" ? "your existing copy was kept — it is current" : "a fresh copy of the current state"}).` +
                  (copy.previousPath
                    ? ` Your previous copy was made from an older state and was moved to ${copy.previousPath}; re-apply any edits you still need from there.`
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
        )
      : tool(
      "open_repo",
      "Open a registered git repository as THIS conversation's working directory so you can read, edit, and test it with native tools (Read/Edit/Write/Bash). The change takes effect from the NEXT turn — the next message in a chat, or (in a scheduled routine) this routine's next scheduled run — because the working directory is fixed when a turn/run starts and cannot be repointed mid-turn; the selection persists for this conversation until close_repo. So after calling this, in a chat tell the user it is ready and continue on their next message; in a routine, finish this run and the repo applies on the next one. From then on, work the repo natively in the working directory: read/edit files, run tests, and use local git (`git status`/`diff`/`log`/`add`/`commit`); then `push` the result and `sync_repo` to pull updates (those need server-side credentials, so they stay MCP-only). Only one repo is open at a time per conversation — opening another replaces it. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (!ctx.conversationId) {
          return text("Cannot open a working repository in this run (no conversation context).", true);
        }
        try {
          const repoCtx = ownerRepoContext(args.name);
          // Make sure the clone exists now so a bad-repo/access error surfaces
          // immediately — WITHOUT syncing (a fetch/checkout could clobber edits).
          await ensureGitRepoClone(repoCtx);
          setWorkspaceRepo(store, ctx.conversationId, repoCtx.name);
          return text(
            `Opened '${repoCtx.name}' as this conversation's working directory. It becomes your working directory from the NEXT turn — the next message in a chat, or this routine's next scheduled run — so let the user know it is ready and continue from there; then edit/test it with native tools and use \`push\`/\`sync_repo\` for remote git. The selection persists for this conversation until you \`close_repo\`.`,
          );
        } catch (error) {
          return text(
            `Failed to open the working repository: ${errorMessage(error)}\nCheck the repo is registered (list_repos) and reachable. Do not work around this with Bash git — the shell has no git credentials.`,
            true,
          );
        }
      },
    ),
    tool(
      "close_repo",
      pi
        ? "Close the working repository opened for this conversation, so later turns are no longer pointed at its sandbox copy. The copy itself stays in your sandbox (uncommitted edits in it are NOT saved — commit first). (owner / trusted user only)"
        : "Close the working repository opened for this conversation so later turns run in the default scratch workspace again. Takes effect from the next message. (owner / trusted user only)",
      {},
      async () => {
        const denied = elevatedGuard();
        if (denied) return denied;
        if (ctx.conversationId) setWorkspaceRepo(store, ctx.conversationId, null);
        return text(
          pi
            ? "Closed the working repository for this conversation. Its sandbox copy stays where it was; open_repo brings it back."
            : "Closed the working repository. From the next turn this conversation runs in the default scratch workspace.",
        );
      },
    ),
    tool(
      "push",
      (pi
        ? "On this runtime push sends Noah's clone — what `commit` saved from your sandbox copy — NOT git commits you made inside the sandbox; call `commit` first. "
        : "") +
        "Push the registered git repository's current HEAD to the target branch on origin. The target is the branch saved in register_repo; if branch is empty, it's the current/default branch. Not limited to main, AND if the target branch does not exist on origin yet, push CREATES it (this — not register_repo — is how a new remote branch is made). To push to a branch other than the one currently registered, set that name via register_repo's `branch` first (the setting persists even if register's checkout step errors on a not-yet-existing branch), then push. (owner / trusted user only)",
      { name: z.string().describe("Registered repo name") },
      async (args) => {
        const denied = elevatedGuard();
        if (denied) return denied;
        try {
          const repoCtx = ownerRepoContext(args.name);
          const branch = await pushGitRepo(repoCtx);
          const ref = pi ? copyRef(repoCtx.name) : null;
          const status = ref ? await piRepoCopyStatus(ref).catch(() => null) : null;
          const pending =
            status?.kind === "ok" ? status.changes.writes.length + status.changes.deletes.length : 0;
          return text(
            `Pushed the changes: ${repoCtx.name} -> ${branch}` +
              (pending
                ? `. Note: your sandbox copy still has ${pending} uncommitted file change(s) that were NOT pushed — commit them with mcp__git_repo__commit and push again if they belong in it.`
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
  if (!pi) return tools;
  return [
    ...tools,
      tool(
        "commit",
        "Save your work on an opened repository: read the working tree of your sandbox copy (`/workspace/repos/<owner>/<name>/`, see open_repo) back into Noah's own clone and commit it there with this message, under the configured commit identity. Every changed, added and deleted file of the copy is included (ignored files, the copy's .git and symbolic links are not); git commits you made inside the sandbox are not used — only the files. Refused when Noah's clone moved since your copy was made (another conversation committed or a sync pulled): then open_repo again for a fresh copy (your current one is kept as `<name>.prev`) and redo the edits there. Then `push` to send it to origin. (owner / trusted user only)",
        {
          name: z.string().describe("Registered repo name"),
          message: z.string().describe("The commit message"),
        },
        async (args) => {
          const denied = elevatedGuard();
          if (denied) return denied;
          try {
            const repoCtx = ownerRepoContext(args.name);
            const ref = copyRef(repoCtx.name);
            if (!ref) return text(NO_PI_WORKSPACE, true);
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
                  `Not committed: '${repoCtx.name}' changed in Noah since your copy was made (copy base ${outcome.base.slice(0, 8)}, now ${outcome.head.slice(0, 8)}) — another conversation committed or a sync pulled. Nothing was applied. Call mcp__git_repo__open_repo with name='${repoCtx.name}' to get a fresh copy (your current copy is moved to ${copyPath}.prev), re-apply your edits there, and commit again.`,
                  true,
                );
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
  ];
}

export function buildGitRepoServer(store: Store, ctx: GitRepoToolsContext) {
  return createSdkMcpServer({
    name: GIT_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGitRepoTools(store, ctx),
  });
}
