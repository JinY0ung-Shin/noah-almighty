import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { ensureClone, knowledgeRepoContextFor, readFile as readRepoFile } from "../knowledgeRepo.js";
import { OWNER_ONLY, cloneFailureMessage, readFileErrorMessage } from "./repoToolKit.js";
import { text } from "./mcpTools.js";
import { formatBrainHits, normalizeWikiPath, rankBrainNotes } from "./brainSearch.js";
import { buildTeamBrainTools, readTeamNoteTool, teamSearchBlock, type TeamBrainToolsContext } from "./teamBrainTools.js";
import { BRAIN_CONFLICT_RULE, PERSONAL_TEAM_PAGE_KEY } from "./brainPolicy.js";
import { parseTeamFrontmatter } from "../teamBrainSchema.js";
import { readTeamVaultFile } from "../teamBrain.js";
import type { TeamBrainPersonalLink } from "../store/teamBrain.js";
import crypto from "node:crypto";

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

/** A note's git blob id (`blob <bytes>\0<content>`, SHA-1) — what `personalNotes` records at submit time. */
export function personalNoteBlobId(content: string): string {
  const body = Buffer.from(content, "utf8");
  return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, "utf8"), body])).digest("hex");
}

/** The `team_page:` a personal link note points at (null when the note is not a link note). */
function linkNoteTarget(content: string): string | null {
  const block = parseTeamFrontmatter(content);
  const v = block?.fields.get(PERSONAL_TEAM_PAGE_KEY);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "wiki/decisions/x.md (Title)" — the team page's title when it still exists. */
async function teamPageLabel(config: AppConfig, pagePath: string): Promise<string> {
  const content = await readTeamVaultFile(config, pagePath).catch(() => null);
  if (content === null) return `${pagePath} (not in the team brain any more)`;
  const title = parseTeamFrontmatter(content)?.fields.get("title");
  return typeof title === "string" && title ? `${pagePath} ("${title}")` : pagePath;
}

/**
 * The read-time mark for one personal note (null = nothing to say): a link note
 * names its team page; a promoted note (an approved submission recorded it)
 * names the canonical team page(s), the approval date and whether the note
 * changed since it was submitted. `forOwner` adds the PROMOTED NOTES hint.
 */
async function personalNoteMark(
  config: AppConfig,
  notePath: string,
  content: string,
  links: TeamBrainPersonalLink[],
  forOwner: boolean,
): Promise<string | null> {
  const target = linkNoteTarget(content);
  if (target) {
    return `${notePath} is a LINK note: its fact lives in the team brain — the canonical version is ${await teamPageLabel(config, target)} (read it with get_note, scope "team").`;
  }
  const hits = links.filter((l) => l.notes.some((n) => n.path === notePath));
  if (hits.length === 0) return null;
  const lines: string[] = [];
  for (const l of hits) {
    const note = l.notes.find((n) => n.path === notePath)!;
    const changed = personalNoteBlobId(content) !== note.blob;
    const pages = l.teamPages.length > 0 ? (await Promise.all(l.teamPages.slice(0, 5).map((p) => teamPageLabel(config, p)))).join(", ") : "(the approving changeset is not on record)";
    lines.push(
      `PROMOTED: ${notePath} was submitted to the team brain and approved${l.approvedAt ? ` on ${l.approvedAt.slice(0, 10)}` : ""} (submission ${l.proposalId}). The canonical version is now the team page ${pages}. This note ${changed ? "HAS CHANGED since it was submitted — the changed part is not in the team brain" : "has not changed since it was submitted"}.`,
    );
  }
  if (forOwner) lines.push("Nothing in this note changes automatically: follow PROMOTED NOTES in the Brain policy (ask the user, with all five points, before rewriting it).");
  return lines.join("\n");
}

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
  // The OWNER's approved submissions that recorded personal notes (read-time marks).
  const personalLinks = () => (teamRead ? store.listTeamBrainPersonalLinks(ctx.avatarUserId) : []);
  /** Resolve a `personalNotes` entry against the owner's clone (owner runs only). */
  const personalNote: TeamBrainToolsContext["personalNote"] =
    personalActive && ctx.viewerIsOwner
      ? async (rawPath) => {
          const c = repoCtx();
          if (!c) return { ok: false, reason: "no knowledge repository is connected" };
          const w = normalizeWikiPath(rawPath);
          if (!w.ok || !w.norm.endsWith(".md")) return { ok: false, reason: "not a `wiki/…md` note path of the personal brain" };
          try {
            const content = await readRepoFile(await ensureClone(c), w.norm);
            if (linkNoteTarget(content)) return { ok: false, reason: "already a link note to the team brain" };
            return { ok: true, link: { path: w.norm, blob: personalNoteBlobId(content) } };
          } catch {
            return { ok: false, reason: "no such note in the personal brain (search it with scope \"personal\" for the exact path)" };
          }
        }
      : undefined;
  const teamCtx: TeamBrainToolsContext | undefined = team ? { ...team, personalNote } : undefined;

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
          // Read-time marks: link notes and promoted notes point at the canonical team page.
          const marks: string[] = [];
          if (teamRead) {
            const links = personalLinks();
            for (const hit of result.hits) {
              const content = await readRepoFile(repoRoot, hit.path).catch(() => null);
              const mark = content === null ? null : await personalNoteMark(ctx.config, hit.path, content, links, false);
              if (mark) marks.push(mark);
            }
          }
          const markBlock = marks.length
            ? `\n\nTeam-brain links of these notes (the team page is the canonical version${ctx.viewerIsOwner ? "; PROMOTED NOTES in the Brain policy says what to ask the user" : ""}):\n${marks.join("\n")}`
            : "";
          return text(
            `Top ${result.hits.length} note(s) from your second brain for "${args.query}":\n${formatBrainHits(
              result.hits,
            )}${markBlock}\n\nRead a full note with get_note or mcp__repo__read_file.`,
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
      "Search your SECOND BRAIN — the curated notes under `wiki/` in your knowledge repository, where past conversations, decisions, people, and concepts have been distilled. **Call this BEFORE answering any question that could draw on accumulated knowledge** (the owner's preferences, prior decisions, people/projects, recurring topics) instead of answering from the live conversation alone. Returns the most relevant notes ranked by title/aliases, tags, then body, each with the note path and a snippet; read a full hit with `mcp__brain__get_note` or `mcp__repo__read_file`. (owner or trusted teammates; read-only) With `scope` it also searches the TEAM brain — the team's shared wiki, compiled by an admin's avatar from teammates' submitted sources (decisions, system facts, fixes, glossary, conventions, owners); team results list wiki pages first, then submitted sources not yet compiled into a page (labeled as such). Search it (scope \"team\") before answering a team question and before submitting to the team brain. A personal note promoted to the team brain (or turned into a link) is marked as such: the team page is then the canonical version. When a personal note and a team page disagree, never pick one silently — show both and ask the user (WHEN THEY DISAGREE in the Brain policy).",
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
        // Both brains answered: the conflict rule rides the result where it applies.
        const both = personalText && !personalText.startsWith("No notes in your second brain")
          ? `\n\n(Results from BOTH brains. ${BRAIN_CONFLICT_RULE})`
          : "";
        return text(personalText ? `${personalText}\n\n${teamBlock.body}${both}` : teamBlock.body);
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
          if (!teamCtx) return text("The team brain is not readable in this run.", true);
          return readTeamNoteTool(teamCtx, args.path);
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
          const content = await readRepoFile(repoRoot, w.norm);
          const mark = teamRead ? await personalNoteMark(ctx.config, w.norm, content, personalLinks(), ctx.viewerIsOwner) : null;
          return text(mark ? `${mark}\n\n${content}` : content);
        } catch (error) {
          return text(readFileErrorMessage(error), true);
        }
      },
    ),
    ...(teamCtx ? buildTeamBrainTools(store, teamCtx) : []),
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
