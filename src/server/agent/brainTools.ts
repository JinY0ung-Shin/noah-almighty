import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { ensureClone, knowledgeRepoContextFor, readFile as readRepoFile } from "../knowledgeRepo.js";
import { OWNER_ONLY, cloneFailureMessage, readFileErrorMessage } from "./repoToolKit.js";
import { text } from "./mcpTools.js";
import { formatBrainHits, normalizeWikiPath, rankBrainNotes } from "./brainSearch.js";

/**
 * Per-conversation context for the PERSONAL second-brain search tools. Read-only
 * recall over the owner's knowledge-repo `wiki/`. The repo is ALWAYS resolved
 * from `avatarUserId` (the owner) — never the viewer — so a trusted teammate's
 * search hits the OWNER's vault, mirroring `mcp__repo__read_file` read-parity.
 */
export interface BrainToolsContext {
  /** The avatar (== owner) whose second brain these tools read. */
  avatarUserId: string;
  /** True only when the present viewer IS the owner and the run is interactive. */
  viewerIsOwner: boolean;
  /**
   * True for the owner OR a trusted same-group teammate (interactive turn). Gates
   * the read tools so teammates can search — but not edit — the owner's brain.
   * Defaults to `viewerIsOwner` when omitted.
   */
  elevated?: boolean;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__brain__<tool>`. */
export const BRAIN_SERVER_NAME = "brain";

/** Tool names the model may call, in `allowedTools` form. */
export const BRAIN_TOOL_NAMES = ["mcp__brain__search", "mcp__brain__get_note"] as const;

const NO_REPO =
  "No knowledge repository is connected yet, so there is no second brain to search. If you are the owner, create and connect one with the `mcp__repo__create_repo` tool first, then capture notes under `wiki/`. Do not walk through manual setup — use `create_repo`.";
const NO_VAULT =
  "Your knowledge repository has no `wiki/` vault yet (it predates the second-brain layout). Run the `brain-migrate` skill ONCE to create the vault skeleton (it never overwrites existing files), then capture notes with the `brain-ingest` skill and retry. Do not use Bash — use the repo tools.";

/**
 * Build the personal second-brain tool definitions. Read-only and gated on
 * `elevated` (owner OR trusted same-group teammate); there is no write tool here
 * (capture/consolidate go through the owner-only `mcp__repo__*` tools via the
 * brain-ingest/brain-reflect skills). Exposed separately for direct testing.
 */
export function buildBrainTools(store: Store, ctx: BrainToolsContext) {
  const canRead = ctx.elevated ?? ctx.viewerIsOwner;
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);

  return [
    tool(
      "search",
      "Search your SECOND BRAIN — the curated notes under `wiki/` in your knowledge repository, where past conversations, decisions, people, and concepts have been distilled. **Call this BEFORE answering any question that could draw on accumulated knowledge** (the owner's preferences, prior decisions, people/projects, recurring topics) instead of answering from the live conversation alone. Returns the most relevant notes ranked by title/aliases, tags, then body, each with the note path and a snippet; read a full hit with `get_note` or `mcp__repo__read_file`. (owner or trusted same-group teammates; read-only)",
      {
        query: z.string().describe("What to look for, in natural language or keywords."),
        limit: z.number().int().optional().describe("Max notes to return (default 8, max 20)."),
      },
      async (args) => {
        if (!canRead) return text(OWNER_ONLY, true);
        const c = repoCtx();
        if (!c) return text(NO_REPO, true);
        try {
          const repoRoot = await ensureClone(c);
          const result = await rankBrainNotes(repoRoot, args.query, args.limit);
          if (result.kind === "no_vault") return text(NO_VAULT, true);
          if (result.hits.length === 0) {
            return text(
              `No notes in your second brain matched "${args.query}". It may not be captured yet — if it is durable, capture it with the brain-ingest skill.`,
            );
          }
          return text(
            `Top ${result.hits.length} note(s) from your second brain for "${args.query}":\n${formatBrainHits(
              result.hits,
            )}\n\nRead a full note with get_note or mcp__repo__read_file.`,
          );
        } catch (error) {
          return text(cloneFailureMessage(error), true);
        }
      },
    ),
    tool(
      "get_note",
      "Read a full note from your second brain by its `wiki/` path (as returned by `search`). A thin, wiki-scoped convenience over `read_file`: the path must live under `wiki/`. Use it to pull the complete note after `search` surfaces a relevant hit. (owner or trusted same-group teammates; read-only)",
      {
        path: z.string().describe("Repository-relative path under wiki/ (e.g. wiki/concepts/deploy.md)"),
      },
      async (args) => {
        if (!canRead) return text(OWNER_ONLY, true);
        const c = repoCtx();
        if (!c) return text(NO_REPO, true);
        // Wiki-scoped: normalize first so `wiki/../CLAUDE.md` can't escape the
        // vault into other repo files. (readFile's resolveInRepo still guards
        // repo containment; this restricts the surface to wiki/ specifically.)
        const w = normalizeWikiPath(args.path);
        if (!w.ok) {
          return text("get_note only reads notes under `wiki/`. Use mcp__repo__read_file for other paths.", true);
        }
        try {
          const repoRoot = await ensureClone(c);
          return text(await readRepoFile(repoRoot, w.norm));
        } catch (error) {
          return text(readFileErrorMessage(error), true);
        }
      },
    ),
  ];
}

/** Build the in-process MCP server exposing the personal second-brain tools. */
export function buildBrainServer(store: Store, ctx: BrainToolsContext) {
  return createSdkMcpServer({
    name: BRAIN_SERVER_NAME,
    version: "0.1.0",
    tools: buildBrainTools(store, ctx),
  });
}
