import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { ensureClone, knowledgeRepoContextFor, readFile as readRepoFile } from "../knowledgeRepo.js";
import { OWNER_ONLY, cloneFailureMessage, readFileErrorMessage } from "./repoToolKit.js";
import { text } from "./mcpTools.js";
import { formatBrainHits, normalizeWikiPath, rankBrainNotes } from "./brainSearch.js";
import { buildTeamBrainTools, readTeamNoteTool, teamSearchBlock, type TeamBrainToolsContext } from "./teamBrainTools.js";

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
   * True for the owner OR a trusted teammate (interactive turn). Gates
   * the read tools so teammates can search — but not edit — the owner's brain.
   * Defaults to `viewerIsOwner` when omitted.
   */
  elevated?: boolean;
  /**
   * The PERSONAL vault is live in this run (`personalBrainActive` in
   * runCapabilities: tool group on + repo connected + read access). The server
   * is also built for a team-only run, where personal scope must refuse.
   * Defaults to true (the pre-team-brain behavior) when omitted.
   */
  personalActive?: boolean;
  /** The team brain half (teamBrainTools.ts); omitted = no team brain in this run. */
  team?: TeamBrainToolsContext;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__brain__<tool>`. */
export const BRAIN_SERVER_NAME = "brain";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const BRAIN_TOOL_NAMES = ["mcp__brain__search", "mcp__brain__get_note"] as const;

const NO_REPO =
  "No knowledge repository is connected yet, so there is no second brain to search. If you are the owner, create and connect one with the `mcp__repo__create_repo` tool first, then capture notes under `wiki/`. Do not walk through manual setup — use `create_repo`.";
const NO_VAULT =
  "Your knowledge repository has no `wiki/` vault yet (it predates the second-brain layout). Run the `brain-migrate` skill ONCE to create the vault skeleton (it never overwrites existing files), then capture notes with the `brain-ingest` skill and retry. Do not use Bash — use the repo tools.";

/**
 * Build the personal second-brain tool definitions. Read-only and gated on
 * `elevated` (owner OR trusted teammate); there is no write tool here
 * (capture/consolidate go through the owner-only `mcp__repo__*` tools via the
 * brain-ingest/brain-reflect skills). Exposed separately for direct testing.
 */
export function buildBrainTools(store: Store, ctx: BrainToolsContext) {
  const canRead = ctx.elevated ?? ctx.viewerIsOwner;
  const personalActive = ctx.personalActive ?? true;
  const team = ctx.team;
  const teamRead = Boolean(team?.read);
  const repoCtx = () => knowledgeRepoContextFor(store, ctx.avatarUserId, ctx.config);

  const searchPersonal = async (args: { query: string; limit?: number }) => {
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
  };

  const scopeShape = z
    .enum(["personal", "team", "all"])
    .optional()
    .describe('"personal" = your own second brain, "team" = the shared team brain, "all" (default) = both that are available in this run.');

  return [
    tool(
      "search",
      "Search your SECOND BRAIN — the curated notes under `wiki/` in your knowledge repository, where past conversations, decisions, people, and concepts have been distilled. **Call this BEFORE answering any question that could draw on accumulated knowledge** (the owner's preferences, prior decisions, people/projects, recurring topics) instead of answering from the live conversation alone. Returns the most relevant notes ranked by title/aliases, tags, then body, each with the note path and a snippet; read a full hit with `mcp__brain__get_note` or `mcp__repo__read_file`. (owner or trusted teammates; read-only) With `scope` it also searches the TEAM brain — the team's shared wiki, compiled by an admin's avatar from teammates' submitted sources (decisions, system facts, fixes, glossary, conventions, owners); team results list wiki pages first, then submitted sources not yet compiled into a page (labeled as such). Search it (scope \"team\") before answering a team question and before submitting to the team brain.",
      {
        query: z.string().describe("What to look for, in natural language or keywords."),
        limit: z.number().int().optional().describe("Max notes to return (default 8, max 20)."),
        scope: scopeShape,
      },
      async (args) => {
        const scope = args.scope ?? "all";
        if (scope === "team") {
          if (!teamRead || !team) return text("The team brain is not readable in this run.", true);
          const block = await teamSearchBlock(team.config, args.query, args.limit);
          return text(block.count > 0 ? block.body : `Nothing in the team brain matched "${args.query}".`);
        }
        if (scope === "personal" && !personalActive) {
          return text("Your personal second brain is not available in this conversation (the personal knowledge tools are off or no repository is connected).", true);
        }
        const teamBlock = teamRead && team ? await teamSearchBlock(team.config, args.query, args.limit) : { count: 0, body: "" };
        if (!personalActive) {
          return text(teamBlock.count > 0 ? teamBlock.body : `Nothing in the team brain matched "${args.query}".`);
        }
        const personal = await searchPersonal(args);
        if (scope === "personal" || teamBlock.count === 0) return personal;
        // Both halves: keep a personal hit list or its no-match line; a personal ERROR
        // (no repo / no vault) gives way to the team hits rather than hiding them.
        const personalText = personal.isError ? "" : personal.content.map((c) => ("text" in c ? c.text : "")).join("\n");
        return text(personalText ? `${personalText}\n\n${teamBlock.body}` : teamBlock.body);
      },
    ),
    tool(
      "get_note",
      "Read a full note from your second brain by its `wiki/` path (as returned by `mcp__brain__search`). A thin, wiki-scoped convenience over `mcp__repo__read_file`: the path must live under `wiki/`. Use it to pull the complete note after `mcp__brain__search` surfaces a relevant hit. (owner or trusted teammates; read-only) Pass scope \"team\" to read from the TEAM brain: a wiki page (`wiki/…`, start with `wiki/index.md`), a raw source (`raw/…`), or the fixed page rules (`SCHEMA.md`).",
      {
        path: z.string().describe("Repository-relative path under wiki/ (e.g. wiki/concepts/deploy.md); with scope \"team\" also raw/… or SCHEMA.md."),
        scope: z.enum(["personal", "team"]).optional().describe('"personal" (default) or "team" — use the scope the search hit came from.'),
      },
      async (args) => {
        if (args.scope === "team") {
          if (!team) return text("The team brain is not readable in this run.", true);
          return readTeamNoteTool(team, args.path);
        }
        if (!personalActive) {
          return text('Your personal second brain is not available in this conversation. For the team brain pass scope "team".', true);
        }
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
    ...(team ? buildTeamBrainTools(store, team) : []),
  ];
}

/** Build the in-process MCP server exposing the personal second-brain tools. */
export function buildBrainServer(store: Store, ctx: BrainToolsContext) {
  return createMcpToolServer({
    name: BRAIN_SERVER_NAME,
    version: "0.1.0",
    tools: buildBrainTools(store, ctx),
  });
}
