import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, PluginRoot, SharedMcpServer } from "../src/server/types.js";
import { callTool, withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// 공용 MCP 서버 through a REAL run plan. On pi every admin server rides Noah's
// `shared` relay (agent/pi/mcpProxies.ts): the plan resolves one bridge
// upstream per mounted server, the pool writes its one-shot 0600 handoff right
// before the child starts, and the endpoint redacts the plan's `piRedactions`
// from every result. createMcpToolServer stays real (recorded, so describe_system
// can be called). The real bridge against a live HTTP server is covered in
// pi-mcp-proxies.test.ts; here the plan, the surfaces and the handoff contract.
// ---------------------------------------------------------------------------
const recorded = vi.hoisted(() => ({
  servers: [] as {
    name: string;
    tools: { name: string; handler: (args: unknown, extra: unknown) => unknown }[];
  }[],
}));

vi.mock("../src/server/agent/mcpServer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const createMcpToolServer = actual.createMcpToolServer as (opts: Record<string, unknown>) => unknown;
  return {
    ...actual,
    createMcpToolServer: (opts: Record<string, unknown> & { name: string; tools?: { name: string; handler: (a: unknown, e: unknown) => unknown }[] }) => {
      recorded.servers.push({ name: opts.name, tools: opts.tools ?? [] });
      return createMcpToolServer(opts);
    },
  };
});

import { createServices } from "../src/server/app.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { piEphemeralRunKey, piRunPrincipal } from "../src/server/agent/pi/piRuntime.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { PiMcpProxyPool, type PiMcpUpstream } from "../src/server/agent/pi/mcpProxies.js";
import { redactSecretValues } from "../src/server/agent/secretRedaction.js";

function makeEvents(): AgentEvents {
  return {
    onDelta: vi.fn(),
    onThinking: vi.fn(),
    onThinkingReset: vi.fn(),
    onStatus: vi.fn(),
    onModel: vi.fn(),
    onSessionId: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentEnd: vi.fn(),
  };
}

let tempDir: string;
const getTempDir = withTempDir("agent-shared-mcp", () => {
  tempDir = getTempDir();
  recorded.servers.length = 0;
});

const JIRA: SharedMcpServer = {
  name: "jira",
  label: "사내 Jira",
  description: "Search and update Jira issues",
  url: "https://jira.example.com/mcp",
  transport: "http",
  headers: {},
  secretSlots: [{ id: "token", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }],
  enabled: true,
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const DOCS: SharedMcpServer = {
  ...JIRA,
  name: "docs",
  label: "Docs",
  description: "Public product docs",
  url: "https://docs.example.com/mcp",
  secretSlots: [],
};

/** The owner stores a secret AND binds it to jira's slot (both are needed). */
function bindJira(env: ReturnType<typeof setup>, value = "jira-secret-value-1") {
  env.store.setUserSecret(env.owner.id, "JIRA_TOKEN", value);
  env.store.setSharedMcpBinding(env.owner.id, {
    serverName: "jira",
    slotId: "token",
    secretName: "JIRA_TOKEN",
    origin: "https://jira.example.com",
  });
}

function setup() {
  const { config, store } = createServices({
    dataDir: tempDir,
    agentRuntime: "pi",
    sessionSecret: "test",
    pi: {
      gatewayUrl: "http://pi.invalid",
      apiKey: "k",
      deckSandbox: false,
      workspacesDir: path.join(tempDir, "pi-ws"),
    },
  });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const cwd = path.join(tempDir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  store.setSharedMcpServers([JIRA, DOCS, { ...DOCS, name: "off", label: "Off", enabled: false }]);
  const ownerRequest: AgentRequest = {
    message: "안녕하세요",
    avatar: { id: owner.id, displayName: "Owner", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    autoApprove: true,
  };
  return { config, store, owner, ownerRequest };
}

const secretsDir = () => path.join(tempDir, "runtime", "mcp-secrets");
const handoffFiles = () => (fs.existsSync(secretsDir()) ? fs.readdirSync(secretsDir()) : []);

/** The plan as runPiAgent builds it, with both metacognition surfaces. */
async function run(request: AgentRequest, env: ReturnType<typeof setup>, pluginRoots: PluginRoot[] = []) {
  recorded.servers.length = 0;
  const events = makeEvents();
  const workspace = piWorkspaceFor(env.config, request.avatarConsultation ? "consult-000000000000000000000000" : piRunPrincipal(request), request.conversationId ?? piEphemeralRunKey(request));
  const caps = await buildRunCapabilities(request, pluginRoots, env.config, env.store, events, undefined, () => 0, {
    piConversationDir: workspace.conversationDir,
    piWorkspace: workspace,
  });
  const system = recorded.servers.filter((server) => server.name === "system").at(-1)!;
  const describe = await callTool(system.tools, "describe_system", {});
  const shared = Object.fromEntries(
    caps.piMcpProxies.upstreams.filter((u) => u.proxy === "shared").map((u) => [u.name, u] as const),
  ) as Record<string, PiMcpUpstream>;
  return {
    caps,
    events,
    shared,
    append: buildSystemPromptAppend(stampPromptRequest(request, caps, env.config, events)),
    describe: describe.content[0].text ?? "",
  };
}

/** Everything a relayed child receives on its command line or in its env. */
const launchOf = (upstream: PiMcpUpstream) => JSON.stringify({ command: upstream.command, args: upstream.args, env: upstream.env });

/**
 * A stand-in for the bridge: a dependency-free stdio MCP server that, like the
 * real bridge, reads its `--config` file and DELETES it on start, and reports
 * what it saw (file mode + content) through its one tool. With FAIL_ONCE set it
 * exits once before answering, so the pool's retry has to start it again.
 */
function writeFakeBridge(): string {
  const file = path.join(tempDir, "fake-bridge.mjs");
  fs.writeFileSync(
    file,
    `
import fs from "node:fs";
import readline from "node:readline";
const config = process.argv[process.argv.indexOf("--config") + 1];
const seen = { mode: (fs.statSync(config).mode & 0o777).toString(8), content: fs.readFileSync(config, "utf8") };
fs.rmSync(config);
const marker = process.env.FAIL_ONCE;
if (marker && !fs.existsSync(marker)) { fs.writeFileSync(marker, "x"); process.exit(1); }
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-bridge", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "seen", description: "what the bridge read", inputSchema: { type: "object" } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(seen) }] } });
  else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
rl.on("close", () => process.exit(0));
`,
  );
  return file;
}

describe("공용 MCP 서버 in a run", () => {
  it("owner with the secret: a bridged relay, no value in argv/env, both surfaces say available", async () => {
    const env = setup();
    bindJira(env);
    const { caps, shared, append, describe } = await run(env.ownerRequest, env);

    const jira = shared.jira!;
    expect(jira).toMatchObject({ proxy: "shared", name: "jira", command: process.execPath });
    expect(jira.args[0]).toBe("--use-system-ca");
    expect(jira.args[1]).toMatch(/scripts[\\/]mcp-http-bridge\.mjs$/);
    expect(jira.args[jira.args.indexOf("--config") + 1]).toBe(jira.handoff!.path);
    expect(jira.handoff!.path).toMatch(/pi-.*-shared-jira\.json$/);
    expect(launchOf(jira)).not.toContain("jira-secret-value-1");
    expect(JSON.parse(jira.handoff!.content)).toEqual({
      url: "https://jira.example.com/mcp",
      transport: "http",
      headers: { Authorization: "Bearer jira-secret-value-1" },
      redact: ["jira-secret-value-1"],
    });
    // Planning spawns and writes nothing: the pool writes the handoff at start.
    expect(handoffFiles()).toEqual([]);
    // A header-less server rides the bridge too (corporate CA + error scrubbing); a disabled one: nowhere.
    expect(JSON.parse(shared.docs!.handoff!.content)).toEqual({
      url: "https://docs.example.com/mcp",
      transport: "http",
      headers: {},
      redact: [],
    });
    expect(shared.off).toBeUndefined();

    for (const surface of [append, describe]) {
      expect(surface).toContain(
        "`jira` (사내 Jira) — Search and update Jira issues: available in this run as `mcp__shared__jira__<tool>` (relayed by Noah).",
      );
      expect(surface).toContain(
        "`docs` (Docs) — Public product docs: available in this run as `mcp__shared__docs__<tool>` (relayed by Noah).",
      );
      expect(surface).not.toContain("`off`");
    }
    // A bridged vault value joins the endpoint's redaction set.
    expect(Object.values(caps.piRedactions)).toContain("jira-secret-value-1");
  });

  it("owner who has the secret but never bound it: left out — an admin cannot pull a secret by name", async () => {
    const env = setup();
    env.store.setUserSecret(env.owner.id, "JIRA_TOKEN", "jira-secret-value-1");
    const { caps, shared, append, describe } = await run(env.ownerRequest, env);
    expect(shared.jira).toBeUndefined();
    expect(shared.docs).toBeDefined();
    expect(JSON.stringify(caps.piMcpProxies.upstreams)).not.toContain("jira-secret-value-1");
    for (const surface of [append, describe]) {
      expect(surface).toContain('NOT available in this run — the owner has not connected a secret to "API 토큰".');
      expect(surface).toContain("Settings → 권한·연결 → 시크릿");
    }
  });

  it("owner whose bound secret was for the server's OLD address: told to reconnect", async () => {
    const env = setup();
    bindJira(env);
    env.store.setSharedMcpServers([{ ...JIRA, url: "https://moved.example.net/mcp" }]);
    const { shared, append, describe } = await run(env.ownerRequest, env);
    expect(shared.jira).toBeUndefined();
    for (const surface of [append, describe]) {
      expect(surface).toContain("the admin moved it to a new address since the owner connected a secret");
    }
  });

  it("plain colleague: the secret-needing server is never relayed, even with the owner's secret set", async () => {
    const env = setup();
    bindJira(env);
    const colleague = env.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    const { caps, shared, append, describe } = await run(
      { ...env.ownerRequest, viewerUserId: colleague.id, viewerName: "Colleague", viewerIsOwner: false, elevated: false },
      env,
    );
    expect(shared.jira).toBeUndefined();
    expect(shared.docs).toBeDefined();
    expect(JSON.stringify(caps.piMcpProxies.upstreams)).not.toContain("jira-secret-value-1");
    expect(handoffFiles()).toEqual([]);
    for (const surface of [append, describe]) {
      expect(surface).toContain("`jira` (사내 Jira) — Search and update Jira issues: NOT available in this conversation — it authenticates with personal secrets from a user's own vault, which this kind of run never carries.");
    }
  });

  it("trusted teammate: uses the owner's bound secret; an unbound slot is reported without its name", async () => {
    const env = setup();
    const mate = env.store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const mateRequest = { ...env.ownerRequest, viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false, elevated: true };
    // The TEAMMATE's own binding never counts — the run uses the avatar owner's.
    env.store.setUserSecret(mate.id, "JIRA_TOKEN", "mate-secret-value-1");
    env.store.setSharedMcpBinding(mate.id, { serverName: "jira", slotId: "token", secretName: "JIRA_TOKEN", origin: "https://jira.example.com" });

    const missing = await run(mateRequest, env);
    expect(missing.shared.jira).toBeUndefined();
    for (const surface of [missing.append, missing.describe]) {
      expect(surface).toContain("`jira` (사내 Jira) — Search and update Jira issues: NOT available in this conversation — the avatar owner has not connected a secret to it.");
      expect(surface).not.toContain("API 토큰");
    }

    bindJira(env);
    const present = await run(mateRequest, env);
    expect(JSON.parse(present.shared.jira!.handoff!.content).headers.Authorization).toBe("Bearer jira-secret-value-1");
    expect(present.shared.jira!.handoff!.content).not.toContain("mate-secret-value-1");
  });

  it("the pool writes the 0600 handoff right before EVERY start of a child, and none outlives the run", async () => {
    const env = setup();
    bindJira(env);
    const { shared } = await run(env.ownerRequest, env);
    const jira = shared.jira!;
    const fake = writeFakeBridge();
    const marker = path.join(tempDir, "failed-once");
    // The REAL plan's handoff, launched through the stand-in bridge.
    const stand: PiMcpUpstream = { ...jira, args: [fake, "--config", jira.handoff!.path], env: { ...jira.env, FAIL_ONCE: marker } };
    const pool = new PiMcpProxyPool([stand]);
    try {
      // First start: the child consumed the file and crashed (a failed source
      // lists nothing) — and nothing is left behind.
      expect(await pool.listTools("shared")).toEqual([]);
      expect(fs.existsSync(marker)).toBe(true);
      expect(handoffFiles()).toEqual([]);
      // The next call starts it again, from a freshly written file.
      const result = await pool.callTool("shared", "jira__seen", {});
      const seen = JSON.parse((result.content as { text: string }[])[0]!.text) as { mode: string; content: string };
      expect(seen.mode).toBe("600");
      expect(JSON.parse(seen.content).headers.Authorization).toBe("Bearer jira-secret-value-1");
      expect(handoffFiles()).toEqual([]);
    } finally {
      await pool.close();
    }
    // A child that never read its file (a closed pool) leaves no plaintext either.
    const unread = new PiMcpProxyPool([{ ...shared.docs! }]);
    fs.mkdirSync(secretsDir(), { recursive: true });
    fs.writeFileSync(shared.docs!.handoff!.path, shared.docs!.handoff!.content, { mode: 0o600 });
    await unread.close();
    expect(handoffFiles()).toEqual([]);
  });

  it("a same-named plugin server sits out behind the admin server, and so does a vault-placeholder one", async () => {
    const env = setup();
    bindJira(env);
    // The owner's installed plugin repo (agent-writable via git_repo push).
    const root = path.join(tempDir, "plugins", env.owner.id, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        jira: { type: "http", url: "https://other.example.com/mcp", headers: { Authorization: "Bearer ${JIRA_TOKEN}" } },
        corp: { type: "http", url: "https://corp.example.com/mcp", headers: { "X-Api-Key": "${JIRA_TOKEN}" } },
      }),
    );
    const { caps, shared, append, describe } = await run(
      { ...env.ownerRequest, headless: true, allowHeadlessTools: true, modelFallback: true },
      env,
      [{ type: "local", path: root }],
    );
    // Only the admin's jira is relayed; no plugin def is relayed at all.
    expect(shared.jira!.handoff!.content).toContain("https://jira.example.com/mcp");
    expect(caps.piMcpProxies.upstreams.filter((u) => u.proxy === "plugins")).toEqual([]);
    expect(JSON.stringify(caps.piMcpProxies.upstreams)).not.toContain("other.example.com");
    expect(caps.piMcpProxies.facts.skippedPluginServers).toEqual([
      { name: "jira", reason: "an admin-registered shared MCP server has the same name" },
      { name: "corp", reason: expect.stringContaining("placeholders (`JIRA_TOKEN`)") },
    ]);
    for (const surface of [append, describe]) {
      expect(surface).toContain("`jira` (an admin-registered shared MCP server has the same name)");
    }
  });

  it("an enabled admin server reserves its name even when it sits the run out", async () => {
    const env = setup();
    // Not bound → jira is NOT relayed; the owner's same-named plugin server must not take its place.
    const root = path.join(tempDir, "plugins", env.owner.id, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ jira: { command: "node", args: ["fake-jira.js"] } }));
    const { caps, shared } = await run(env.ownerRequest, env, [{ type: "local", path: root }]);
    expect(shared.jira).toBeUndefined();
    expect(caps.piMcpProxies.upstreams.some((u) => u.name === "jira")).toBe(false);
    expect(caps.piMcpProxies.facts.skippedPluginServers).toEqual([
      { name: "jira", reason: "an admin-registered shared MCP server has the same name" },
    ]);
  });

  it("redacts an admin's LITERAL credential header from tool output, even on a plain colleague run", async () => {
    const env = setup();
    env.store.setSharedMcpServers([
      {
        ...DOCS,
        name: "static",
        headers: {
          "X-Api-Key": "static-admin-key-123",
          Authorization: "Bearer bare-static-token-9",
          "X-Team": "quality-assurance",
          // Name looks credential-ish only to a loose match; never shredded.
          "X-Session-Mode": "stateless-mode",
        },
      },
    ]);
    const colleague = env.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    const { caps, shared } = await run(
      { ...env.ownerRequest, viewerUserId: colleague.id, viewerName: "Colleague", viewerIsOwner: false, elevated: false },
      env,
    );
    expect(shared.static).toBeDefined();
    // What the endpoint's transformResult does to every result of the run.
    const result = {
      content: [{ type: "text", text: "echo: static-admin-key-123 team quality-assurance tok=bare-static-token-9 mode=stateless-mode" }],
    };
    const out = (redactSecretValues(result, caps.piRedactions).value as typeof result).content[0]!.text;
    expect(out).toContain("[REDACTED:static:X-Api-Key]");
    expect(out).not.toContain("static-admin-key-123");
    // A remote echoing only the token part of `Bearer <tok>` is caught too.
    expect(out).not.toContain("bare-static-token-9");
    expect(out).toContain("stateless-mode");
    // A non-credential header is not shredded out of unrelated output.
    expect(out).toContain("quality-assurance");
  });

  it.each([
    ["a restricted headless run (intro/hashtag generation)", { headless: true, allowHeadlessTools: false }],
    ["an avatar consultation", { headless: true, avatarConsultation: true }],
  ])("%s relays no shared server at all", async (_label, extra) => {
    const env = setup();
    bindJira(env);
    const { caps, append } = await run({ ...env.ownerRequest, ...extra } as AgentRequest, env);
    expect(caps.piMcpProxies.upstreams.filter((u) => u.proxy === "shared")).toEqual([]);
    expect(caps.sharedMcpStates).toBeUndefined();
    expect(append).not.toContain("Shared MCP servers");
  });

  it("redacts and sends the TRIMMED value", async () => {
    const env = setup();
    bindJira(env, "jira-secret-value-1\n");
    const { caps, shared } = await run(env.ownerRequest, env);
    expect(JSON.parse(shared.jira!.handoff!.content)).toMatchObject({
      headers: { Authorization: "Bearer jira-secret-value-1" },
      redact: ["jira-secret-value-1"],
    });
    const out = redactSecretValues({ content: [{ type: "text", text: "got jira-secret-value-1 back" }] }, caps.piRedactions);
    expect(JSON.stringify(out.value)).not.toContain("jira-secret-value-1");
  });
});
