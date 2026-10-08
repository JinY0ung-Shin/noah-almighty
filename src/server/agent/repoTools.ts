import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig } from "../types.js";
import { normalizeGithubHost, scrubGitError } from "../marketplace.js";
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
  type Resolved,
  commitFailureMessage,
  createRepoCatchMessage,
  createRepoFailureMessage,
  isBrainNotePath,
  runDeleteFile,
  runEditFile,
  runListFiles,
  runMoveFile,
  runReadFile,
  runScaffoldSkill,
  runWriteFile,
  validateRepoCreateNames,
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
 * `elevated` viewer (a trusted same-group teammate), so a teammate's chat can
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
   * True for the owner OR a trusted same-group teammate (interactive turn). Gates
   * the READ tools (`list_files`/`read_file`) so teammates can read — but not
   * modify — the personal repo. Defaults to `viewerIsOwner` when omitted.
   */
  elevated?: boolean;
  /**
   * True when the current run may WRITE (write/delete/move/scaffold/commit): the
   * owner, or — when the owner marked this a SHARED (communal) account — a
   * trusted same-group teammate. Defaults to `viewerIsOwner` when omitted.
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

/** Tool names the model may call, in `allowedTools` form. */
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
 * created under that organization (`org/name`) — required for a shared GROUP
 * repo so every member's token can reach it via org/team permissions; otherwise
 * it lands under the token owner's personal account (resolved via `gh api user`).
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

const OWNER_ONLY = REPO_OWNER_ONLY;
const NO_REPO =
  "No knowledge repository is connected yet. If you are the owner, first create and connect a new repository with the `create_repo` tool, then try again. (If you already have a repo you've been using, you can also connect it directly in settings.) Do not walk through manual setup steps — use `create_repo`.";

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
      ? "(shared account: the owner and trusted same-group teammates may write)"
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

  const manageTools = [
    tool(
      "list_files",
      "Get the file list of my knowledge repository (personal repo). (owner or trusted same-group teammates; read-only)",
      {},
      () =>
        runListFiles(resolveRead(), ensureClone, listTree, {
          empty: "(The repository is empty.)",
          onBody: (body) => `Knowledge repository file list:\n${body}`,
        }),
    ),
    tool(
      "read_file",
      "Read the content of a file in my knowledge repository. (owner or trusted same-group teammates; read-only)",
      { path: z.string().describe("Path relative to the repository root (e.g. skills/foo/SKILL.md)") },
      (args) => runReadFile(resolveRead(), ensureClone, readRepoFile, args.path),
    ),
    tool(
      "write_file",
      `Create/modify a file in my knowledge repository (creates it if it doesn't exist). Changes apply only to the working tree, and **until you commit & push with the commit tool they are saved only temporarily** and may disappear on the next sync. ${writeGate}`,
      {
        path: z.string().describe("Path relative to the repository root"),
        content: z.string().describe("The full file content"),
      },
      async (args) => {
        const out = await runWriteFile(
          resolve(),
          ensureClone,
          writeRepoFile,
          args,
          (path) => `Saved the file ${path}. (Not committed yet — push it with the commit tool.)`,
        );
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({ action: "add", path: args.path });
        }
        return out;
      },
    ),
    tool(
      "edit_file",
      `Modify an EXISTING file in my knowledge repository by replacing an exact text snippet. **Prefer this over write_file when changing a file that already exists** — you only send the part that changes, not the whole file (cheaper and safer for large notes/skills). Read the file first if unsure of the exact text. \`old_string\` must match the file exactly (including whitespace/indentation) and be unique, unless you set \`replace_all\`. Changes apply only to the working tree, and **until you commit & push with the commit tool they are saved only temporarily** and may disappear on the next sync. ${writeGate}`,
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
        const out = await runEditFile(
          resolve(),
          ensureClone,
          editRepoFile,
          args,
          (path, count) =>
            `Edited ${path} (${count} replacement${count === 1 ? "" : "s"}). (Not committed yet — push it with the commit tool.)`,
        );
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({ action: "update", path: args.path });
        }
        return out;
      },
    ),
    tool(
      "delete_file",
      `Delete a file OR a whole directory (e.g. an entire skill folder \`skills/<name>\`) from my knowledge repository. The deletion applies only to the working tree, and **until you commit & push with the commit tool it is not removed from the remote** and may reappear on the next sync. ${writeGate}`,
      { path: z.string().describe("Path relative to the repository root — a file (skills/foo/SKILL.md) or a directory (skills/foo)") },
      (args) =>
        runDeleteFile(
          resolve(),
          ensureClone,
          deleteRepoFile,
          args.path,
          (path) => `Deleted ${path}. (Not committed yet — push it with the commit tool.)`,
        ),
    ),
    tool(
      "move_file",
      `Rename or move a file/directory within my knowledge repository (e.g. rename a skill folder or relocate a note). Applies only to the working tree until you commit & push. ${writeGate}`,
      {
        from: z.string().describe("Current path relative to the repository root"),
        to: z.string().describe("New path relative to the repository root"),
      },
      (args) =>
        runMoveFile(
          resolve(),
          ensureClone,
          moveRepoFile,
          args,
          (from, to) => `Moved ${from} → ${to}. (Not committed yet — push it with the commit tool.)`,
        ),
    ),
    tool(
      "scaffold_skill",
      `Create a new skill (skills/<name>/SKILL.md + marketplace registration) in my knowledge repository. After creating it, fill in the content with write_file and push with commit, and from the next conversation the avatar can use that skill. ${writeGate}`,
      {
        name: z.string().describe("Skill name (e.g. deploy-runbook)"),
        description: z.string().optional().describe("One-line description of the skill"),
      },
      (args) => runScaffoldSkill(resolve(), ensureClone, scaffoldSkill, args),
    ),
    tool(
      "commit",
      `Commit all changes in my knowledge repository and push to the remote (branch). Call this when a unit of work is finished or when the user requests it. ${writeGate}`,
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
          const committed = await commitAndPush(c, message, commitIdentityFor(store, ctx.owner));
          if (!committed) {
            return text(NO_CHANGES);
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
          return text(`Committed and pushed the changes: ${c.repo}${shares}`);
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
    `**Use this tool when the owner asks you to create or connect a knowledge repository** — do not walk through manual setup or try scaffold_skill first. ${githubHostDescription(ctx.config.githubHost)} Using the configured internal Git token (GIT_TOKEN), it creates a new internal GitHub knowledge repository (private by default, initialized from the Claude plugin marketplace template) and connects it right away. By default the repo is created under the owner's personal account; pass \`org\` to create it under a GitHub organization instead. Use it when there is no knowledge repository yet; you only need the repository name. After creation, fill in the content with scaffold_skill → write_file → commit. (owner only)`,
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
        try {
          const c = knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);
          if (c) {
            const repoRoot = await ensureClone(c);
            if (await writeRepoTemplate(repoRoot, result.fullName)) {
              await commitAndPush(c, "Initialize knowledge repo", commitIdentityFor(store, ctx.owner));
              seeded = true;
            }
          }
        } catch (error) {
          seedNote = ` (Skipped initializing the default template: ${scrubGitError(error)})`;
        }
        const kind = result.isPrivate ? "private" : "public";
        return text(
          seeded
            ? `Created the ${kind} knowledge repository \`${result.fullName}\` and initialized it with the default template (Claude plugin marketplace: \`.claude-plugin/marketplace.json\` + README + a root \`CLAUDE.md\` that is injected as standing guidance every conversation). Edit \`CLAUDE.md\` for always-apply rules, add your first skill with \`scaffold_skill\`, and push with \`commit\`.`
            : `Created and connected the ${kind} knowledge repository \`${result.fullName}\`.${seedNote} Create your first skill with \`scaffold_skill\`, then push with \`commit\`.`,
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
  return createSdkMcpServer({
    name: REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildRepoTools(store, ctx, opts),
  });
}
