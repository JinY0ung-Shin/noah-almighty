import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig, UserGroupMembership } from "../types.js";
import {
  ensureGroupClone,
  groupKnowledgeRepoContextFor,
  type GroupKnowledgeRepoContext,
} from "../groupKnowledgeRepo.js";
import { readFile as readRepoFile } from "../knowledgeRepo.js";
import { OWNER_ONLY, type Resolved, cloneFailureMessage, readFileErrorMessage, resolveOwnerGroup } from "./repoToolKit.js";
import { text } from "./mcpTools.js";
import { formatBrainHits, normalizeWikiPath, rankBrainNotes } from "./brainSearch.js";

/**
 * Per-conversation context for the GROUP (team) second-brain search tools.
 * Read-only recall over a group's shared knowledge-repo `wiki/`, scoped to ONE
 * group. OWNER-ONLY at registration; each call then resolves the named group
 * against the OWNER's own memberships (so the avatar can never search a group
 * the owner is not in — a cross-tenant read of another team's repo). Any group
 * MEMBER may read (no admin role check for reads).
 */
export interface GroupBrainToolsContext {
  /** The avatar (== owner) whose group memberships scope these tools. */
  avatarUserId: string;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__group_brain__<tool>`. */
export const GROUP_BRAIN_SERVER_NAME = "group_brain";

/** Tool names the model may call, in `allowedTools` form. */
export const GROUP_BRAIN_TOOL_NAMES = ["mcp__group_brain__search", "mcp__group_brain__get_note"] as const;

const NO_SUCH_GROUP =
  "Could not find a group with that name/ID. First check the groups you belong to with `mcp__group_repo__list_groups`.";
const NO_REPO =
  "This group does not have a shared knowledge repository connected yet, so it has no team brain to search. If you are a group admin, create one with `mcp__group_repo__create_repo`, or connect an existing repository from group management in settings.";

/**
 * Build the group second-brain tool definitions. Mirrors `groupRepoTools`'
 * resolve chain: owner-only, then resolve the group against the OWNER's
 * memberships (NEVER pass a model-supplied group id straight to
 * `groupKnowledgeRepoContextFor`, which does not verify membership). Members read.
 */
export function buildGroupBrainTools(store: Store, ctx: GroupBrainToolsContext) {
  /** Resolve a `group` arg (id or name, case-insensitive) among the owner's groups only. */
  const resolveGroup = (arg: string): UserGroupMembership | null =>
    resolveOwnerGroup(store, ctx.avatarUserId, arg);

  type GroupResolved = { group: UserGroupMembership; repo: GroupKnowledgeRepoContext };
  const resolveRead = (groupArg: string): Resolved<GroupResolved> => {
    if (!ctx.viewerIsOwner) return { ok: false, result: text(OWNER_ONLY, true) };
    const group = resolveGroup(groupArg);
    if (!group) return { ok: false, result: text(NO_SUCH_GROUP, true) };
    const c = groupKnowledgeRepoContextFor(store, group.id, ctx.avatarUserId, ctx.config, group.name);
    if (!c) return { ok: false, result: text(NO_REPO, true) };
    return { ok: true, repo: { group, repo: c } };
  };

  return [
    tool(
      "search",
      "Search a group's shared TEAM BRAIN — the curated notes under `wiki/` in the named group's shared knowledge repository — and return the most relevant notes ranked by title/aliases, tags, then body. Use this to recall team-shared rules, prompts, decisions, and context any group member captured, scoped to ONE group. Call `mcp__group_repo__list_groups` first to confirm the group name and that a shared repository is connected. To ADD to the team brain, group admins ingest with `mcp__group_repo__write_file` then `commit`. (group member only — read access needs no admin role, only that you belong to the group)",
      {
        group: z.string().describe("Group name or ID (confirm with list_groups)"),
        query: z.string().describe("What to look for, in natural language or keywords."),
        limit: z.number().int().optional().describe("Max notes to return (default 8, max 20)."),
      },
      async (args) => {
        const r = resolveRead(args.group);
        if (!r.ok) return r.result;
        try {
          const repoRoot = await ensureGroupClone(r.repo.repo);
          const result = await rankBrainNotes(repoRoot, args.query, args.limit);
          if (result.kind === "no_vault") {
            return text(
              `The '${r.repo.group.name}' group repository has no \`wiki/\` vault yet. A group admin can run the brain-migrate skill on it to set one up.`,
              true,
            );
          }
          if (result.hits.length === 0) {
            return text(`No notes in the '${r.repo.group.name}' team brain matched "${args.query}".`);
          }
          return text(
            `Top ${result.hits.length} note(s) from the '${r.repo.group.name}' team brain for "${args.query}":\n${formatBrainHits(
              result.hits,
            )}\n\nRead a full note with get_note or mcp__group_repo__read_file.`,
          );
        } catch (error) {
          return text(cloneFailureMessage(error), true);
        }
      },
    ),
    tool(
      "get_note",
      "Read one full note from a group's shared TEAM BRAIN by its repository-relative path (e.g. `wiki/deploy-runbook.md`), usually a path returned by `search`. The path must live under `wiki/`. Returns the note's full markdown including its frontmatter. (group member only)",
      {
        group: z.string().describe("Group name or ID"),
        path: z.string().describe("Repository-relative path under wiki/ (e.g. wiki/concepts/deploy.md)"),
      },
      async (args) => {
        const r = resolveRead(args.group);
        if (!r.ok) return r.result;
        const w = normalizeWikiPath(args.path);
        if (!w.ok) {
          return text("get_note only reads notes under `wiki/`. Use mcp__group_repo__read_file for other paths.", true);
        }
        try {
          const repoRoot = await ensureGroupClone(r.repo.repo);
          return text(await readRepoFile(repoRoot, w.norm));
        } catch (error) {
          return text(readFileErrorMessage(error), true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the group second-brain tools. */
export function buildGroupBrainServer(store: Store, ctx: GroupBrainToolsContext) {
  return createSdkMcpServer({
    name: GROUP_BRAIN_SERVER_NAME,
    version: "0.1.0",
    tools: buildGroupBrainTools(store, ctx),
  });
}
