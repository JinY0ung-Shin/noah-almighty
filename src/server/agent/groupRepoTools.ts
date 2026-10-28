import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AgentOwner, AppConfig, UserGroupMembership } from "../types.js";
import { normalizeGithubHost, scrubGitError } from "../marketplace.js";
import { text } from "./mcpTools.js";
import {
  commitIdentityFor,
  deleteFile as deleteRepoFile,
  editFile as editRepoFile,
  listTree,
  moveFile as moveRepoFile,
  readFile as readRepoFile,
  scaffoldSkill,
  writeFile as writeRepoFile,
  writeRepoTemplate,
} from "../knowledgeRepo.js";
import {
  ensureGroupClone,
  groupCommitAndPush,
  type GroupKnowledgeRepoContext,
  groupKnowledgeRepoContextFor,
} from "../groupKnowledgeRepo.js";
import { createRemoteRepo } from "./repoTools.js";
import {
  NO_CHANGES,
  NO_GIT_TOKEN,
  OWNER_ONLY as REPO_OWNER_ONLY,
  type Resolved,
  commitFailureMessage,
  createRepoCatchMessage,
  createRepoFailureMessage,
  resolveOwnerGroup,
  runDeleteFile,
  runEditFile,
  isBrainNotePath,
  runListFiles,
  runMoveFile,
  runReadFile,
  runScaffoldSkill,
  runWriteFile,
  validateRepoCreateNames,
} from "./repoToolKit.js";

/**
 * Per-conversation context the group knowledge-repo tools act within. These let
 * the avatar manage the SHARED knowledge repos of the groups its OWNER belongs
 * to, from chat. They are OWNER-ONLY (a colleague/trusted teammate or a headless
 * routine gets a refusal): a group admin edits their group repo through their
 * OWN avatar. Per-tool the OWNER's role in the named group is then checked —
 * members may read, only group admins may write/commit/create.
 */
export interface GroupRepoToolsContext {
  /** The avatar (== owner) whose group memberships these tools act on. */
  avatarUserId: string;
  owner: AgentOwner;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
  /**
   * Fired after a SUCCESSFUL write/edit under `wiki/` (a group second-brain
   * note): the host shows a "그룹 기억 추가/갱신" notice in the activity tree.
   */
  onMemory?: (event: { action: "add" | "update"; path: string; groupName: string }) => void;
}

/** MCP server name; tools surface to the model as `mcp__group_repo__<tool>`. */
export const GROUP_REPO_SERVER_NAME = "group_repo";

/** Tool names the model may call, in `allowedTools` form. */
export const GROUP_REPO_TOOL_NAMES = [
  "mcp__group_repo__list_groups",
  "mcp__group_repo__list_files",
  "mcp__group_repo__read_file",
  "mcp__group_repo__write_file",
  "mcp__group_repo__edit_file",
  "mcp__group_repo__delete_file",
  "mcp__group_repo__move_file",
  "mcp__group_repo__scaffold_skill",
  "mcp__group_repo__commit",
  "mcp__group_repo__create_repo",
] as const;

const OWNER_ONLY = REPO_OWNER_ONLY;
const NO_SUCH_GROUP =
  "Could not find a group with that name/ID. First check the groups you belong to with list_groups.";
const ADMIN_ONLY =
  "Only a group admin can modify this group's shared knowledge repository. (Members can only read.)";
const NO_REPO =
  "This group does not have a shared knowledge repository connected yet. If you are a group admin, create a new one with `create_repo`, or connect an existing repository from group management in settings.";

function githubHostDescription(host: string): string {
  const normalized = normalizeGithubHost(host);
  return `The current GitHub host is \`${normalized}\`, and create_repo creates the repo with \`GH_HOST=${normalized} gh repo create\`.`;
}

/**
 * Build the group knowledge-repo management tools bound to one conversation's
 * store + context. Exposed separately from the server so handlers can be tested
 * directly. Owner-only + per-group-role gating is enforced in the handlers.
 */
export function buildGroupRepoTools(
  store: Store,
  ctx: GroupRepoToolsContext,
  opts: { createRemoteRepo?: typeof createRemoteRepo } = {},
) {
  const create = opts.createRemoteRepo ?? createRemoteRepo;

  /** The owner's groups (id/name/role/repo flag). */
  const ownerGroups = (): UserGroupMembership[] => store.listUserGroups(ctx.avatarUserId);

  /** Resolve a `group` argument (id or name, case-insensitive) among the owner's groups. */
  const resolveGroup = (arg: string): UserGroupMembership | null =>
    resolveOwnerGroup(store, ctx.avatarUserId, arg);

  const repoCtx = (groupId: string, groupName?: string) =>
    groupKnowledgeRepoContextFor(store, groupId, ctx.avatarUserId, ctx.config, groupName);

  // The resolved file-CRUD context: the group (for its name in success text) plus
  // the cloned repo context. Read tools gate on owner + group + repo; write tools
  // additionally require the owner be a group admin.
  type GroupResolved = { group: UserGroupMembership; repo: GroupKnowledgeRepoContext };
  const resolveRead = (groupArg: string): Resolved<GroupResolved> => {
    if (!ctx.viewerIsOwner) return { ok: false, result: text(OWNER_ONLY, true) };
    const group = resolveGroup(groupArg);
    if (!group) return { ok: false, result: text(NO_SUCH_GROUP, true) };
    const c = repoCtx(group.id, group.name);
    if (!c) return { ok: false, result: text(NO_REPO, true) };
    return { ok: true, repo: { group, repo: c } };
  };
  const resolveWrite = (groupArg: string): Resolved<GroupResolved> => {
    if (!ctx.viewerIsOwner) return { ok: false, result: text(OWNER_ONLY, true) };
    const group = resolveGroup(groupArg);
    if (!group) return { ok: false, result: text(NO_SUCH_GROUP, true) };
    if (group.role !== "admin") return { ok: false, result: text(ADMIN_ONLY, true) };
    const c = repoCtx(group.id, group.name);
    if (!c) return { ok: false, result: text(NO_REPO, true) };
    return { ok: true, repo: { group, repo: c } };
  };
  // Adapt the kit's ensureClone(repo) shape to the resolved {group,repo} bundle.
  const cloneResolved = (r: GroupResolved) => ensureGroupClone(r.repo);

  return [
    tool(
      "list_groups",
      "List the groups I belong to, my role in each group (admin/member), and whether a shared knowledge repository is connected. Call this first, before working on a group knowledge repository, to confirm the group name. (owner only)",
      {},
      async () => {
        if (!ctx.viewerIsOwner) {
          return text(OWNER_ONLY, true);
        }
        const groups = ownerGroups();
        if (groups.length === 0) {
          return text("You do not belong to any group. Groups are created and have members added by the system admin.");
        }
        const body = groups
          .map(
            (g) =>
              `- ${g.name} (role: ${g.role === "admin" ? "admin" : "member"}, shared repository: ${
                g.knowledgeRepoConfigured ? "connected" : "none"
              })`,
          )
          .join("\n");
        return text(`${groups.length} group(s) I belong to:\n${body}`);
      },
    ),
    tool(
      "list_files",
      "Get the file list of the specified group's shared knowledge repository. (group member only)",
      { group: z.string().describe("Group name or ID (confirm with list_groups)") },
      (args) => {
        const r = resolveRead(args.group);
        return runListFiles(r, cloneResolved, listTree, {
          empty: "(The repository is empty.)",
          onBody: (body) =>
            `File list of the '${r.ok ? r.repo.group.name : ""}' group knowledge repository:\n${body}`,
        });
      },
    ),
    tool(
      "read_file",
      "Read the content of a file from the specified group's shared knowledge repository. (group member only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Path relative to the repository root (e.g. skills/foo/SKILL.md)"),
      },
      (args) => runReadFile(resolveRead(args.group), cloneResolved, readRepoFile, args.path),
    ),
    tool(
      "write_file",
      "Create/modify a file in the specified group's shared knowledge repository (creates it if it doesn't exist). Changes apply only to the working tree and are **saved only temporarily until commit**. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Path relative to the repository root"),
        content: z.string().describe("The full file content"),
      },
      async (args) => {
        const out = await runWriteFile(
          resolveWrite(args.group),
          cloneResolved,
          writeRepoFile,
          args,
          (path) => `Saved the file ${path}. (Not committed yet — push it with commit.)`,
        );
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({
            action: "add",
            path: args.path,
            groupName: resolveGroup(args.group)?.name ?? args.group,
          });
        }
        return out;
      },
    ),
    tool(
      "edit_file",
      "Modify an EXISTING file in the specified group's shared knowledge repository by replacing an exact text snippet. **Prefer this over write_file when changing a file that already exists** — you send only the part that changes, not the whole file. `old_string` must match the file exactly (including whitespace/indentation) and be unique, unless you set `replace_all`. Applies only to the working tree until commit. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
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
          resolveWrite(args.group),
          cloneResolved,
          editRepoFile,
          args,
          (path, count) =>
            `Edited ${path} (${count} replacement${count === 1 ? "" : "s"}). (Not committed yet — push it with commit.)`,
        );
        if (!out.isError && isBrainNotePath(args.path)) {
          ctx.onMemory?.({
            action: "update",
            path: args.path,
            groupName: resolveGroup(args.group)?.name ?? args.group,
          });
        }
        return out;
      },
    ),
    tool(
      "delete_file",
      "Delete a file OR a whole directory (e.g. an entire skill folder `skills/<name>`) from the specified group's shared knowledge repository. The deletion applies only to the working tree and is **not removed from the remote until commit**. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Path relative to the repository root — a file (skills/foo/SKILL.md) or a directory (skills/foo)"),
      },
      (args) =>
        runDeleteFile(
          resolveWrite(args.group),
          cloneResolved,
          deleteRepoFile,
          args.path,
          (path) => `Deleted ${path}. (Not committed yet — push it with commit.)`,
        ),
    ),
    tool(
      "move_file",
      "Rename or move a file/directory within the specified group's shared knowledge repository. Applies only to the working tree until commit. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        from: z.string().describe("Current path relative to the repository root"),
        to: z.string().describe("New path relative to the repository root"),
      },
      (args) =>
        runMoveFile(
          resolveWrite(args.group),
          cloneResolved,
          moveRepoFile,
          args,
          (from, to) => `Moved ${from} → ${to}. (Not committed yet — push it with commit.)`,
        ),
    ),
    tool(
      "scaffold_skill",
      "Create a new skill (skills/<name>/SKILL.md + marketplace registration) in the specified group's shared knowledge repository. After that, fill it in with write_file and push with commit, and the avatars of all group members can use that skill. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        name: z.string().describe("Skill name (e.g. team-runbook)"),
        description: z.string().optional().describe("One-line description of the skill"),
      },
      (args) => runScaffoldSkill(resolveWrite(args.group), cloneResolved, scaffoldSkill, args),
    ),
    tool(
      "commit",
      "Commit the changes in the specified group's shared knowledge repository and push to the remote. Call this when a unit of work is finished. (group admin only)",
      {
        group: z.string().describe("Group name or ID"),
        message: z.string().describe("Commit message"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        const c = repoCtx(group.id, group.name);
        if (!c) return text(NO_REPO, true);
        // Either token can authenticate: a github.com group repo on a GHES
        // deployment is covered by the external token (tokenForGitUrl routes by
        // host), so refuse only when BOTH are absent.
        if (!c.token && !c.externalToken) {
          return text(NO_GIT_TOKEN, true);
        }
        try {
          const committed = await groupCommitAndPush(c, args.message, commitIdentityFor(store, ctx.owner));
          if (!committed) return text(NO_CHANGES);
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_push",
            status: "success",
            detail: `group=${group.name} pushed to ${c.repo}`,
          });
          return text(`Committed and pushed the changes to the '${group.name}' group knowledge repository: ${c.repo}`);
        } catch (error) {
          return text(commitFailureMessage(error), true);
        }
      },
    ),
    tool(
      "create_repo",
      `**Use this tool when a group admin asks you to create the group's shared knowledge repository.** ${githubHostDescription(
        ctx.config.githubHost,
      )} Using the configured internal Git token (GIT_TOKEN), it creates a new internal GitHub repository (private by default, initialized from the Claude plugin marketplace template) and connects it to that group right away. It only works when the group does not have a repository yet. **IMPORTANT: a shared group repo should normally live under a GitHub ORGANIZATION, not your personal account — a private repo under your personal account is NOT reachable by other members' tokens, so the shared skills will silently fail to load for them. Before creating, ASK the group admin which organization to create it under (pass it as \`org\`), or confirm they really want it under your personal account.** (group admin only)`,
      {
        group: z.string().describe("Group name or ID"),
        name: z.string().describe("New repository name (letters/digits and - _ . only, e.g. team-knowledge)"),
        org: z.string().optional().describe("GitHub organization to create the shared repo under (e.g. acme), so all members can access it. Ask the admin which org to use. Omit only if they explicitly want it under the personal account."),
        private: z.boolean().optional().describe("Whether it is private (default true)"),
        description: z.string().optional().describe("Repository description (optional)"),
      },
      async (args) => {
        if (!ctx.viewerIsOwner) return text(OWNER_ONLY, true);
        const group = resolveGroup(args.group);
        if (!group) return text(NO_SUCH_GROUP, true);
        if (group.role !== "admin") return text(ADMIN_ONLY, true);
        if (group.knowledgeRepoConfigured) {
          return text("This group already has a shared knowledge repository connected.", true);
        }
        const token = store.getGitToken(ctx.avatarUserId);
        if (!token) {
          return text(
            "To create a GitHub repository, please first register an internal Git token (GIT_TOKEN) under Settings → Git credentials.",
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
          const result = await create(
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
          store.setGroupKnowledgeRepo(group.id, result.fullName, result.defaultBranch);
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "group_repo_create",
            status: "success",
            detail: `group=${group.name} created ${result.fullName}`,
          });
          let seeded = false;
          let seedNote = "";
          try {
            const c = repoCtx(group.id, group.name);
            if (c) {
              const repoRoot = await ensureGroupClone(c);
              if (await writeRepoTemplate(repoRoot, result.fullName, "group")) {
                await groupCommitAndPush(c, "Initialize group knowledge repo", commitIdentityFor(store, ctx.owner));
                seeded = true;
              }
            }
          } catch (error) {
            seedNote = ` (Skipped initializing the default template: ${scrubGitError(error)})`;
          }
          const kind = result.isPrivate ? "private" : "public";
          return text(
            seeded
              ? `Created the ${kind} shared knowledge repository \`${result.fullName}\` for the '${group.name}' group and initialized its second-brain vault (\`raw/\` for captures, \`wiki/\` for consolidated notes). Members capture with brain-ingest; group admins consolidate with brain-reflect over raw/+wiki only. Commit to persist.`
              : `Created and connected the ${kind} shared knowledge repository \`${result.fullName}\` for the '${group.name}' group.${seedNote}`,
          );
        } catch (error) {
          return text(createRepoCatchMessage(targetHost, error), true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the group knowledge-repo tools. */
export function buildGroupRepoServer(store: Store, ctx: GroupRepoToolsContext) {
  return createSdkMcpServer({
    name: GROUP_REPO_SERVER_NAME,
    version: "0.1.0",
    tools: buildGroupRepoTools(store, ctx),
  });
}
