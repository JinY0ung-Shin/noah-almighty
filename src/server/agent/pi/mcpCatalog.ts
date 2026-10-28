/**
 * The STATIC tool catalog Noah's HTTP MCP endpoint lists to pi-gateway.
 *
 * pi fetches a session's MCP tool list once, when it builds the session, and
 * keeps it while later turns reuse that session — each turn with its OWN run
 * token and its own capabilities (a browser that connected, a tool group the
 * user switched on, trust that changed). So the pi runner registers EVERY Noah
 * server for EVERY run, answers `tools/list` from this catalog (all tools of
 * every server, in their widest form), and gates each `tools/call` against the
 * tools THIS run actually registered (`mcpAllowedTools`). A server the run did
 * not build is a tool-less stub whose every call is refused with a redirect.
 *
 * The catalog servers are built with INERT contexts (no ids, refusing
 * callbacks) and are only ever listed, never called: they exist to read the
 * tool names, descriptions and input schemas the run's real servers share.
 * Descriptions that vary per run (e.g. share_file naming the deck converter)
 * take this process's deployment values — pi would freeze the first run's
 * wording for the session anyway.
 *
 * `PI_MCP_SERVER_NAMES` is also what `scripts/pi-register-mcp.mjs` registers as
 * broker ids (a test keeps the two lists equal). The ids are Noah's server
 * names verbatim, so pi's `mcp__<server id>__<tool>` names are exactly the
 * `mcp__repo__commit`-style names Noah's prompts, skills and manual use.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentOwner, AppConfig } from "../../types.js";
import type { Store } from "../../store.js";
import { piSandboxDeckToolchain } from "../../deckRender.js";
import { buildFileOutputServer, FILE_OUTPUT_SERVER_NAME } from "../fileOutputTools.js";

/**
 * Every in-process MCP server a Noah run can build (runCapabilities.ts). The
 * pi broker ids, in registration order. All match pi's id rule
 * `^[a-z0-9][a-z0-9_-]{0,47}$`.
 */
export const PI_MCP_SERVER_NAMES = [
  "knowledge",
  "repo",
  "system",
  "todo",
  "confluence",
  "web",
  "avatars",
  "skill_exchange",
  "ssh_identity",
  "git_repo",
  "group_repo",
  "brain",
  "group_brain",
  "canvas",
  "browser",
  "file_output",
  "ssh_trust",
  "skills",
] as const;

export type PiMcpServerName = (typeof PI_MCP_SERVER_NAMES)[number];

export type NoahMcpCatalog = Record<PiMcpServerName, Tool[]>;

const INERT_OWNER: AgentOwner = { id: "", username: "", displayName: "" };
const refuse = async (): Promise<never> => {
  throw new Error("catalog server: never called");
};

/** The widest form of each server — every optional tool registered. */
async function buildCatalogServers(store: Store, config: AppConfig): Promise<Record<PiMcpServerName, { instance: McpServer }>> {
  const [
    { buildKnowledgeServer },
    { buildRepoServer },
    { buildSystemServer },
    { buildTodoServer },
    { buildConfluenceServer },
    { buildWebFetchServer },
    { buildAvatarDirectoryServer },
    { buildSkillExchangeServer },
    { buildSshIdentityServer },
    { buildGitRepoServer },
    { buildGroupRepoServer },
    { buildBrainServer },
    { buildGroupBrainServer },
    { buildCanvasServer },
    { buildBrowserServer },
    { buildSshTrustServer },
    { buildSkillsServer },
  ] = await Promise.all([
    import("../knowledgeTools.js"),
    import("../repoTools.js"),
    import("../systemTools.js"),
    import("../todoTools.js"),
    import("../confluenceTools.js"),
    import("../webFetchTools.js"),
    import("../avatarDirectoryTools.js"),
    import("../skillExchangeTools.js"),
    import("../sshIdentityTools.js"),
    import("../gitRepoTools.js"),
    import("../groupRepoTools.js"),
    import("../brainTools.js"),
    import("../groupBrainTools.js"),
    import("../canvasTools.js"),
    import("../browserTools.js"),
    import("../sshTrustTools.js"),
    import("../skillsTools.js"),
  ]);
  const base = { avatarUserId: "", owner: INERT_OWNER, viewerIsOwner: false, config };
  return {
    knowledge: buildKnowledgeServer(store, { avatarUserId: "", viewerIsOwner: false }),
    repo: buildRepoServer(store, base, { allowCreate: true }),
    system: buildSystemServer(store, base),
    todo: buildTodoServer(store, { ...base, source: "avatar", deleteEnabled: true }),
    confluence: buildConfluenceServer({ config, ownerSecrets: {}, elevated: false, visionEnabled: true }),
    web: buildWebFetchServer({ elevated: false }),
    avatars: buildAvatarDirectoryServer(store, {
      avatarUserId: "",
      viewerUserId: "",
      askAvatar: refuse,
    }),
    skill_exchange: buildSkillExchangeServer(store, base),
    ssh_identity: buildSshIdentityServer(store, base),
    // The pi wording (sandbox copy + `commit`): this catalog only ever serves pi runs.
    git_repo: buildGitRepoServer(store, { ...base, elevated: false, runtime: "pi" }),
    group_repo: buildGroupRepoServer(store, base),
    brain: buildBrainServer(store, base),
    group_brain: buildGroupBrainServer(store, base),
    canvas: buildCanvasServer({ emitCanvas: refuse }),
    browser: buildBrowserServer({
      execute: refuse,
      allowed: false,
      vision: true,
      stageClipboardImage: refuse,
      stageClipboardText: refuse,
    }),
    [FILE_OUTPUT_SERVER_NAME]: buildFileOutputServer({
      showFile: refuse,
      shareFile: refuse,
      // pi decks build in the sandbox: the operator's flag, not the host probe.
      deckConverterInstalled: piSandboxDeckToolchain(config).converter,
      shareLinkEnabled: true,
      createShareLink: refuse,
    }),
    ssh_trust: buildSshTrustServer({ avatarUserId: "", config }),
    skills: buildSkillsServer({}),
  } as Record<PiMcpServerName, { instance: McpServer }>;
}

/** `tools/list` of one server, exactly as the endpoint would serve it. */
export async function listServerTools(server: McpServer): Promise<Tool[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "noah-catalog", version: "1.0.0" });
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

const catalogs = new WeakMap<Store, Promise<NoahMcpCatalog>>();

/** The process's catalog (per Store, built once on the first pi run). */
export function noahMcpCatalog(store: Store, config: AppConfig): Promise<NoahMcpCatalog> {
  let catalog = catalogs.get(store);
  if (!catalog) {
    catalog = (async () => {
      const servers = await buildCatalogServers(store, config);
      const entries = await Promise.all(
        PI_MCP_SERVER_NAMES.map(async (name) => [name, await listServerTools(servers[name].instance)] as const),
      );
      return Object.fromEntries(entries) as NoahMcpCatalog;
    })();
    // A failed build must not poison every later run.
    catalog.catch(() => catalogs.delete(store));
    catalogs.set(store, catalog);
  }
  return catalog;
}
