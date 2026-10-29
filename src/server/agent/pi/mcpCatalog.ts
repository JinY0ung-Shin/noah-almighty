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
import type { AgentOwner, AppConfig, PiKnownTool, PiKnownTools } from "../../types.js";
import type { Store } from "../../store.js";
import { piSandboxDeckToolchain } from "../../deckRender.js";
import { buildFileOutputServer, FILE_OUTPUT_SERVER_NAME } from "../fileOutputTools.js";
import { createHash } from "node:crypto";
import logger from "../../logger.js";
import { PI_PROXY_SERVER_NAMES, type PiMcpProxyPool, type PiMcpUpstream } from "./mcpProxies.js";
import { PI_COMPACT_DESCRIPTIONS, PI_DISCOVERY_SENTENCES } from "./catalogText.js";

/**
 * Every in-process MCP server a Noah run can build (runCapabilities.ts), in
 * registration order — the servers this static catalog lists.
 */
export const PI_NOAH_SERVER_NAMES = [
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
  "canvas",
  "browser",
  "file_output",
  "ssh_trust",
  "skills",
] as const;

/**
 * The pi broker ids: Noah's own servers, then the proxies of servers Noah
 * relays as an MCP client (`pi/mcpProxies.ts` — hex-ssh, plugin `.mcp.json`,
 * 공용 MCP), whose tool lists are per run and are NOT in this catalog. All
 * match pi's id rule `^[a-z0-9][a-z0-9_-]{0,47}$`.
 */
export const PI_MCP_SERVER_NAMES = [...PI_NOAH_SERVER_NAMES, ...PI_PROXY_SERVER_NAMES] as const;

export type PiNoahServerName = (typeof PI_NOAH_SERVER_NAMES)[number];
export type PiMcpServerName = (typeof PI_MCP_SERVER_NAMES)[number];

export type NoahMcpCatalog = Record<PiNoahServerName, Tool[]>;

const INERT_OWNER: AgentOwner = { id: "", username: "", displayName: "" };
const refuse = async (): Promise<never> => {
  throw new Error("catalog server: never called");
};

/** The widest form of each server — every optional tool registered. */
async function buildCatalogServers(store: Store, config: AppConfig): Promise<Record<PiNoahServerName, { instance: McpServer }>> {
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
    git_repo: buildGitRepoServer(store, { ...base, elevated: false }),
    group_repo: buildGroupRepoServer(store, base),
    brain: buildBrainServer(store, base),
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
  } as Record<PiNoahServerName, { instance: McpServer }>;
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

/** The 16-hex sha256 a compact description names as the builder text it replaces. */
export function piDescriptionHash(description: string): string {
  return createHash("sha256").update(description, "utf8").digest("hex").slice(0, 16);
}

/**
 * The pi wording of one listed tool (`catalogText.ts`): a compact description
 * for a very long one — only while the builder text is the one it was written
 * for — and a discovery sentence for a tool common requests miss. Schemas are
 * untouched.
 */
export function piCatalogTool(server: string, tool: Tool): Tool {
  const key = `${server}/${tool.name}`;
  let description = tool.description ?? "";
  const compact = PI_COMPACT_DESCRIPTIONS[key];
  if (compact) {
    if (piDescriptionHash(description) === compact.replaces) description = compact.text;
    else logger.warn({ tool: key }, "pi catalog: builder description changed; serving it instead of the stale compact text");
  }
  const sentence = PI_DISCOVERY_SENTENCES[key];
  if (sentence) description = `${description} ${sentence}`;
  return description === tool.description ? tool : { ...tool, description };
}

const catalogs = new WeakMap<Store, Promise<NoahMcpCatalog>>();

/** The process's catalog (per Store, built once on the first pi run). */
export function noahMcpCatalog(store: Store, config: AppConfig): Promise<NoahMcpCatalog> {
  let catalog = catalogs.get(store);
  if (!catalog) {
    catalog = (async () => {
      const servers = await buildCatalogServers(store, config);
      const entries = await Promise.all(
        PI_NOAH_SERVER_NAMES.map(
          async (name) => [name, (await listServerTools(servers[name].instance)).map((tool) => piCatalogTool(name, tool))] as const,
        ),
      );
      return Object.fromEntries(entries) as NoahMcpCatalog;
    })();
    // A failed build must not poison every later run.
    catalog.catch(() => catalogs.delete(store));
    catalogs.set(store, catalog);
  }
  return catalog;
}

/** pi's model-facing name of a broker tool (`mcp-client/proxy.ts`: characters outside `[A-Za-z0-9_-]` become `_`). */
export function piToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function requiredOf(tool: Tool): string[] {
  const required = (tool.inputSchema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The frozen prompt's "Known Noah tool names" (PiRuntimeFacts.knownTools):
 * every tool THIS run registered and allowed — Noah's own in catalog order
 * (servers as listed to pi, tools in registration order), then the relayed
 * ones sorted by name — so the text is the same for the same capabilities.
 */
export async function piKnownTools(
  catalog: NoahMcpCatalog,
  allowedTools: ReadonlySet<string>,
  proxies: Pick<PiMcpProxyPool, "listToolsReport">,
  upstreams: readonly Pick<PiMcpUpstream, "proxy">[],
): Promise<PiKnownTools> {
  const noah: PiKnownTool[] = [];
  for (const server of PI_NOAH_SERVER_NAMES) {
    for (const tool of catalog[server] ?? []) {
      const name = `mcp__${server}__${tool.name}`;
      if (allowedTools.has(name)) noah.push({ name, required: requiredOf(tool) });
    }
  }
  const relayed: PiKnownTool[] = [];
  let relayedIncomplete = false;
  for (const proxy of PI_PROXY_SERVER_NAMES) {
    if (!upstreams.some((upstream) => upstream.proxy === proxy)) continue;
    const report = await proxies.listToolsReport(proxy).catch(() => ({ tools: [] as Tool[], failedSources: 1 }));
    if (report.failedSources > 0) relayedIncomplete = true;
    for (const tool of report.tools) relayed.push({ name: piToolName(proxy, tool.name), required: requiredOf(tool) });
  }
  relayed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { noah, relayed, relayedIncomplete };
}
