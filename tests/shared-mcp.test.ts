import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  mcpHttpBridgeServerDef,
  normalizeStoredSharedMcpServers,
  parseSharedMcpServer,
  planSharedMcpRun,
  toSharedMcpUserView,
  type McpHttpBridgeConfig,
} from "../src/server/sharedMcpServers.js";
import type { AppConfig, SharedMcpBinding, SharedMcpServer } from "../src/server/types.js";
import { createApp, createServices } from "../src/server/app.js";
import { liftPluginMcpServers } from "../src/server/plugins.js";
import { signup, withTempDir } from "./helpers.js";

const NOW = "2026-10-26T00:00:00.000Z";
const BRIDGE = path.join(process.cwd(), "scripts", "mcp-http-bridge.mjs");
const ORIGIN = "https://mcp.example.com";

function server(overrides: Partial<SharedMcpServer> = {}): SharedMcpServer {
  return {
    name: "jira",
    label: "Jira",
    description: "Corporate Jira issues",
    url: `${ORIGIN}/mcp`,
    transport: "http",
    headers: {},
    secretSlots: [{ id: "token", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }],
    enabled: true,
    updatedAt: NOW,
    ...overrides,
  };
}

const bound = (secretName: string, overrides: Partial<SharedMcpBinding> = {}): SharedMcpBinding => ({
  serverName: "jira",
  slotId: "token",
  secretName,
  origin: ORIGIN,
  ...overrides,
});

describe("shared MCP server validation", () => {
  it("accepts slots (an id is minted for a new one) and fixed headers", () => {
    const parsed = parseSharedMcpServer(
      {
        name: "jira",
        label: "Jira",
        url: `${ORIGIN}/mcp`,
        headers: { "X-Team": "qa" },
        secretSlots: [{ label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }, { header: "X-Site" }],
      },
      NOW,
    );
    expect("server" in parsed).toBe(true);
    if (!("server" in parsed)) return;
    expect(parsed.server).toMatchObject({ transport: "http", enabled: true, updatedAt: NOW, headers: { "X-Team": "qa" } });
    const [token, site] = parsed.server.secretSlots;
    expect(token).toMatchObject({ label: "API 토큰", header: "Authorization", format: "Bearer {secret}" });
    expect(token.id).toMatch(/^[a-z0-9-]{1,40}$/);
    // Defaults: label = header, format = the bare value.
    expect(site).toMatchObject({ label: "X-Site", header: "X-Site", format: "{secret}" });
  });

  it.each([
    [{ name: "Jira", url: "https://x.example.com" }, "서버 이름"],
    [{ name: "a__b", url: "https://x.example.com" }, "서버 이름"],
    [{ name: "system", url: "https://x.example.com" }, "앱 기본 도구"],
    [{ name: "jira", url: "ftp://x.example.com" }, "http://"],
    [{ name: "jira", url: "https://u:p@x.example.com" }, "사용자 이름"],
    // The admin never names a secret — not in the URL, not in a fixed header.
    [{ name: "jira", url: "https://x.example.com/?k=${JIRA_TOKEN}" }, "주소에는 시크릿을"],
    [{ name: "jira", url: "https:${HOST}/mcp" }, "주소에는 시크릿을"],
    [{ name: "jira", url: "https://x.example.com", headers: { Authorization: "Bearer ${JIRA_TOKEN}" } }, "인증 자리"],
    [{ name: "jira", url: "https://x.example.com", headers: { Authorization: "Bearer {secret}" } }, "인증 자리"],
    [{ name: "jira", url: "https://x.example.com", transport: "ws" }, "전송 방식"],
    [{ name: "jira", url: "https://x.example.com", headers: { "Mcp-Session-Id": "x" } }, "MCP 전송"],
    [{ name: "jira", url: "https://x.example.com", headers: { "X-A": "a\r\nb" } }, "헤더 값"],
    [{ name: "jira", url: "https://x.example.com", headers: { "bad name": "x" } }, "헤더 이름"],
    [{ name: "jira", url: "https://x.example.com", headers: { "x-a": "1", "X-A": "2" } }, "중복"],
    [{ name: "jira", url: "https://x.example.com", headers: { "X-A": "1" }, secretSlots: [{ header: "x-a" }] }, "중복"],
    [{ name: "jira", url: "https://x.example.com", secretSlots: [{ header: "Authorization", format: "Bearer" }] }, "정확히 한 번"],
    [{ name: "jira", url: "https://x.example.com", secretSlots: [{ header: "A", format: "{secret}{secret}" }] }, "정확히 한 번"],
    [{ name: "jira", url: "https://x.example.com", secretSlots: [{ id: "Bad Id", header: "A" }] }, "식별자"],
    [{ name: "jira", url: "https://x.example.com", secretSlots: [{ id: "a", header: "A" }, { id: "a", header: "B" }] }, "식별자"],
    [{ name: "jira", url: "https://x.example.com", secretSlots: Array.from({ length: 6 }, (_, i) => ({ header: `X-${i}` })) }, "최대 5개"],
  ])("rejects %j", (body, fragment) => {
    const parsed = parseSharedMcpServer(body, NOW);
    expect("error" in parsed && parsed.error).toContain(fragment);
  });

  it("drops malformed stored entries, duplicate names and id-less stored slots (fail closed)", () => {
    const stored = normalizeStoredSharedMcpServers([
      server(),
      server({ label: "dup" }),
      { name: "BAD", url: "https://x.example.com" },
      "junk",
      { ...server({ name: "noid" }), secretSlots: [{ label: "x", header: "Authorization", format: "{secret}" }] },
      server({ name: "wiki", secretSlots: [] }),
    ]);
    expect(stored.map((entry) => entry.name)).toEqual(["jira", "wiki"]);
    expect(stored[0].label).toBe("Jira");
    expect(normalizeStoredSharedMcpServers({ not: "a list" })).toEqual([]);
  });

  it("the user view shows the origin and marks a binding made for another origin as stale", () => {
    const view = toSharedMcpUserView(server({ url: "https://moved.example.com/mcp" }), [bound("JIRA_TOKEN")]);
    expect(view).toEqual({
      name: "jira",
      label: "Jira",
      description: "Corporate Jira issues",
      origin: "https://moved.example.com",
      slots: [{ id: "token", label: "API 토큰", header: "Authorization", boundSecret: null, stale: true }],
    });
    expect(toSharedMcpUserView(server(), [bound("JIRA_TOKEN")]).slots[0]).toMatchObject({ boundSecret: "JIRA_TOKEN", stale: false });
  });
});

describe("planSharedMcpRun", () => {
  it("fills each slot from the secret the owner bound, through the bridge", () => {
    const plan = planSharedMcpRun([server({ headers: { "X-Team": "qa" } })], {
      bindings: [bound("MY_JIRA")],
      secrets: { MY_JIRA: "tok-$&-123456" },
      secretsAllowed: true,
    });
    expect(plan.states).toEqual([
      expect.objectContaining({ name: "jira", status: "active", unboundSlots: [], missingSecrets: [] }),
    ]);
    expect(plan.registrations).toEqual([
      {
        name: "jira",
        kind: "bridge",
        config: {
          url: `${ORIGIN}/mcp`,
          transport: "http",
          // `$&` stays literal (no String.replace substitution patterns).
          headers: { "X-Team": "qa", Authorization: "Bearer tok-$&-123456" },
          redact: ["tok-$&-123456"],
        },
      },
    ]);
  });

  it("an unbound slot leaves the server out, naming the slot", () => {
    const plan = planSharedMcpRun([server()], { bindings: [], secrets: { JIRA_TOKEN: "x" }, secretsAllowed: true });
    expect(plan.states[0]).toMatchObject({ status: "needs_binding", unboundSlots: ["API 토큰"], hostChanged: false });
    expect(plan.registrations).toEqual([]);
  });

  it("a binding made for another origin never applies to the moved server", () => {
    const plan = planSharedMcpRun([server({ url: "https://moved.example.com/mcp" })], {
      bindings: [bound("JIRA_TOKEN")],
      secrets: { JIRA_TOKEN: "tok-123456" },
      secretsAllowed: true,
    });
    expect(plan.states[0]).toMatchObject({ status: "needs_binding", hostChanged: true });
    expect(plan.registrations).toEqual([]);
  });

  it("a bound secret gone from the vault (or a reserved name) leaves the server out", () => {
    for (const secretName of ["GONE", "GITHUB_TOKEN"]) {
      const plan = planSharedMcpRun([server()], {
        bindings: [bound(secretName)],
        secrets: { GITHUB_TOKEN: "ghp-should-never-go" },
        secretsAllowed: true,
      });
      expect(plan.states[0]).toMatchObject({ status: "missing_secrets", missingSecrets: [secretName] });
      expect(plan.registrations).toEqual([]);
    }
  });

  it("trims a pasted trailing newline; a value with an inner line break is unusable", () => {
    const ok = planSharedMcpRun([server()], { bindings: [bound("T")], secrets: { T: "tok-123456\n" }, secretsAllowed: true });
    expect(ok.registrations[0]).toMatchObject({ config: { headers: { Authorization: "Bearer tok-123456" }, redact: ["tok-123456"] } });
    const bad = planSharedMcpRun([server()], { bindings: [bound("T")], secrets: { T: "tok\r\nX-Evil: 1" }, secretsAllowed: true });
    expect(bad.states[0]).toMatchObject({ status: "missing_secrets", missingSecrets: ["T"] });
    expect(bad.registrations).toEqual([]);
  });

  it("a slotted server sits out a run that may not carry the vault, even when bound", () => {
    const plan = planSharedMcpRun([server()], {
      bindings: [bound("JIRA_TOKEN")],
      secrets: { JIRA_TOKEN: "tok-123456" },
      secretsAllowed: false,
    });
    expect(plan.states[0]).toMatchObject({ status: "secrets_unavailable" });
    expect(plan.registrations).toEqual([]);
  });

  it("registers a header-less server natively on every run, and skips disabled ones entirely", () => {
    const plan = planSharedMcpRun(
      [server({ name: "public", secretSlots: [], transport: "sse" }), server({ name: "off", enabled: false })],
      { bindings: [], secrets: {}, secretsAllowed: false },
    );
    expect(plan.states.map((state) => [state.name, state.status])).toEqual([["public", "active"]]);
    expect(plan.registrations).toEqual([
      { name: "public", kind: "native", def: { type: "sse", url: `${ORIGIN}/mcp` } },
    ]);
  });

  it("routes a fixed-header server through the bridge too (no value in argv)", () => {
    const plan = planSharedMcpRun([server({ secretSlots: [], headers: { "X-Api-Key": "static-shared-key" } })], {
      bindings: [],
      secrets: {},
      secretsAllowed: false,
    });
    expect(plan.registrations[0]).toMatchObject({ kind: "bridge", config: { headers: { "X-Api-Key": "static-shared-key" }, redact: [] } });
    const def = mcpHttpBridgeServerDef("/app/scripts/mcp-http-bridge.mjs", "/data/runtime/mcp-secrets/http-x.json");
    expect(JSON.stringify(def)).not.toContain("static-shared-key");
    expect(def.args).toEqual(["--use-system-ca", "/app/scripts/mcp-http-bridge.mjs", "--config", "/data/runtime/mcp-secrets/http-x.json"]);
  });
});

// ---------------------------------------------------------------------------
// The bridge end to end: a real Streamable HTTP / SSE MCP server, the bridge
// spawned exactly as the CLI would (stdio), an SDK client on the CLI side.
// ---------------------------------------------------------------------------

describe("mcp-http-bridge.mjs", () => {
  let httpServer: http.Server;
  let baseUrl = "";
  const seenAuth: string[] = [];
  const seenProbe: string[] = [];
  let tempDir = "";

  function buildMcp(): McpServer {
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echo text", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
    );
    return mcp;
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-bridge-"));
    const app = express();
    app.use(express.json());
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const requireAuth = (req: express.Request, res: express.Response): boolean => {
      const auth = req.headers.authorization ?? "";
      seenAuth.push(auth);
      if (typeof req.headers["x-probe"] === "string") seenProbe.push(req.headers["x-probe"]);
      if (auth !== "Bearer good-token-123") {
        res.status(401).json({ error: `bad token ${auth}` });
        return false;
      }
      return true;
    };
    app.all("/mcp", async (req, res) => {
      if (!requireAuth(req, res)) return;
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        await buildMcp().connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    });
    const sseSessions = new Map<string, SSEServerTransport>();
    app.get("/sse", async (req, res) => {
      if (!requireAuth(req, res)) return;
      const transport = new SSEServerTransport("/messages", res);
      sseSessions.set(transport.sessionId, transport);
      await buildMcp().connect(transport);
    });
    app.post("/messages", async (req, res) => {
      if (!requireAuth(req, res)) return;
      const transport = sseSessions.get(String(req.query.sessionId));
      if (!transport) {
        res.status(404).end();
        return;
      }
      await transport.handlePostMessage(req, res, req.body);
    });
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function bridgeClient(config: McpHttpBridgeConfig) {
    const file = path.join(tempDir, `bridge-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const def = mcpHttpBridgeServerDef(BRIDGE, file);
    const transport = new StdioClientTransport({
      command: def.command,
      args: def.args,
      env: { PATH: process.env.PATH ?? "", PROBE_ENV: "from-env" },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    const client = new Client({ name: "cli", version: "1.0.0" });
    return { client, transport, file, stderr: () => stderr };
  }

  it.each(["http", "sse"] as const)("relays %s tools/list + tools/call with the resolved header", async (kind) => {
    seenAuth.length = 0;
    const { client, transport, file } = bridgeClient({
      url: `${baseUrl}/${kind === "http" ? "mcp" : "sse"}`,
      transport: kind,
      headers: { Authorization: "Bearer good-token-123" },
      redact: ["good-token-123"],
    });
    try {
      await client.connect(transport);
      // One-shot handoff: the bridge consumed (deleted) its config file.
      expect(fs.existsSync(file)).toBe(false);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["echo"]);
      const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
      expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth.every((auth) => auth === "Bearer good-token-123")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("answers a rejected request with a JSON-RPC error that never echoes the secret", async () => {
    const { client, transport, stderr } = bridgeClient({
      url: `${baseUrl}/mcp`,
      transport: "http",
      headers: { Authorization: "Bearer wrong-secret-999" },
      redact: ["wrong-secret-999"],
    });
    try {
      const error = await client.connect(transport).then(
        () => null,
        (err: unknown) => err as Error,
      );
      expect(error).not.toBeNull();
      expect(String(error?.message)).toContain("Remote MCP server request failed");
      expect(String(error?.message)).toContain("401");
      expect(String(error?.message)).not.toContain("wrong-secret-999");
      expect(stderr()).not.toContain("wrong-secret-999");
    } finally {
      await client.close();
    }
  });

  it.each([
    [false, "${PROBE_ENV}"],
    [true, "from-env"],
  ])("expandEnv=%s sends X-Probe %s (admin servers never read env)", async (expandEnv, expected) => {
    seenProbe.length = 0;
    const { client, transport } = bridgeClient({
      url: `${baseUrl}/mcp`,
      transport: "http",
      headers: { Authorization: "Bearer good-token-123", "X-Probe": "${PROBE_ENV}" },
      redact: [],
      expandEnv,
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      expect(seenProbe.length).toBeGreaterThan(0);
      expect(new Set(seenProbe)).toEqual(new Set([expected]));
    } finally {
      await client.close();
    }
  });

  it("the admin connection check runs the same bridge with the checking admin's OWN bound secret", async () => {
    const services = createServices({ dataDir: path.join(tempDir, `check-${randomUUID()}`), agentRuntime: "local", sessionSecret: "test" });
    try {
      const app = createApp(services);
      const admin = request.agent(app);
      await signup(admin, "admin").expect(201);
      await admin
        .post("/api/admin/shared-mcp-servers")
        .send({ name: "fixture", url: `${baseUrl}/mcp`, secretSlots: [{ label: "토큰", header: "Authorization", format: "Bearer {secret}" }] })
        .expect(200);
      const fixtureSlot = (await admin.get("/api/admin/shared-mcp-servers").expect(200)).body.servers[0].secretSlots[0].id;
      const unbound = await admin.post("/api/admin/shared-mcp-servers/fixture/check").expect(200);
      expect(unbound.body).toMatchObject({ ok: false, missingSecrets: ["토큰"] });
      await admin.put("/api/me/secrets/FIXTURE_TOKEN").send({ value: "wrong-secret-999" }).expect(200);
      await admin.put(`/api/me/shared-mcp-servers/fixture/slots/${fixtureSlot}`).send({ secretName: "FIXTURE_TOKEN" }).expect(200);
      const rejected = await admin.post("/api/admin/shared-mcp-servers/fixture/check").expect(200);
      expect(rejected.body.ok).toBe(false);
      expect(rejected.body.error).toContain("401");
      expect(JSON.stringify(rejected.body)).not.toContain("wrong-secret-999");
      await admin.put("/api/me/secrets/FIXTURE_TOKEN").send({ value: "good-token-123" }).expect(200);
      const ok = await admin.post("/api/admin/shared-mcp-servers/fixture/check").expect(200);
      expect(ok.body).toEqual({ ok: true, tools: ["echo"], missingSecrets: [], error: null });
      // The one-shot check file never outlives the check.
      const secretsDir = path.join(services.config.dataDir, "runtime", "mcp-secrets");
      expect(fs.readdirSync(secretsDir)).toEqual([]);
    } finally {
      services.store.close();
    }
  });

  it("fills vault and env refs in ONE pass — a vault value containing ${…} is never expanded again", async () => {
    seenProbe.length = 0;
    const { client, transport } = bridgeClient({
      url: `${baseUrl}/mcp`,
      transport: "http",
      headers: { Authorization: "Bearer ${TOKEN}", "X-Probe": "${ODD}|${PROBE_ENV}" },
      redact: ["good-token-123"],
      vault: { TOKEN: "good-token-123", ODD: "a${PROBE_ENV}b" },
      expandEnv: true,
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      expect(new Set(seenProbe)).toEqual(new Set(["a${PROBE_ENV}b|from-env"]));
    } finally {
      await client.close();
    }
  });

  it("fails loudly when its one-shot config file is gone (respawn)", async () => {
    const { client, transport, file, stderr } = bridgeClient({
      url: `${baseUrl}/mcp`,
      transport: "http",
      headers: {},
      redact: [],
    });
    fs.rmSync(file);
    await expect(client.connect(transport)).rejects.toThrow();
    expect(stderr()).toContain("cannot read config file");
  });
});

// ---------------------------------------------------------------------------
// Admin + user routes
// ---------------------------------------------------------------------------

describe("shared MCP routes", () => {
  const routeDir = withTempDir("shared-mcp-routes");
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  async function boot() {
    const services = createServices({ dataDir: routeDir(), agentRuntime: "local", sessionSecret: "test" });
    cleanup.push(() => services.store.close());
    const app = createApp(services);
    const admin = request.agent(app);
    await signup(admin, "admin").expect(201);
    const member = request.agent(app);
    const memberUser = (await signup(member, "member").expect(201)).body.user;
    return { services, app, admin, member, memberUser };
  }

  const JIRA = {
    name: "jira",
    label: "Jira",
    description: "Issues",
    url: "https://jira.example.com/mcp",
    secretSlots: [{ id: "token", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }],
  };

  it("admin-gates CRUD, keeps the name and slot ids fixed, and audits", async () => {
    const { app, admin, member } = await boot();
    await request(app).get("/api/admin/shared-mcp-servers").expect(401);
    await member.get("/api/admin/shared-mcp-servers").expect(403);
    await member.post("/api/admin/shared-mcp-servers").send({ name: "x", url: "https://x.example.com" }).expect(403);

    const created = await admin.post("/api/admin/shared-mcp-servers").send(JIRA).expect(200);
    expect(created.body.server).toMatchObject({ name: "jira", enabled: true, origin: "https://jira.example.com" });
    await admin.post("/api/admin/shared-mcp-servers").send({ ...JIRA, url: "https://other.example.com" }).expect(409);
    const bad = await admin.post("/api/admin/shared-mcp-servers").send({ name: "repo", url: "https://x.example.com" }).expect(400);
    expect(bad.body.error).toContain("앱 기본 도구");

    // A NEW server never keeps a client-chosen slot id.
    expect(created.body.server.secretSlots[0].id).not.toBe("token");
    await admin.delete("/api/admin/shared-mcp-servers/jira").expect(200);
    const recreated = await admin.post("/api/admin/shared-mcp-servers").send(JIRA).expect(200);
    const slotId = recreated.body.server.secretSlots[0].id as string;
    expect(slotId).not.toBe("token");
    // Full replace keeps the URL-param name even if the body tries another.
    const updated = await admin
      .put("/api/admin/shared-mcp-servers/jira")
      .send({ ...JIRA, name: "renamed", label: "Jira 2", enabled: false })
      .expect(200);
    expect(updated.body.server).toMatchObject({ name: "jira", label: "Jira 2", enabled: false });
    // An UPDATE keeps an id the server already has (bindings survive an edit)…
    // (an id the server does not have — "token" — is a NEW slot: fresh id)
    const updatedId = updated.body.server.secretSlots[0].id as string;
    expect([slotId, "token"]).not.toContain(updatedId);
    const kept = await admin
      .put("/api/admin/shared-mcp-servers/jira")
      .send({ ...JIRA, secretSlots: [{ ...JIRA.secretSlots[0], id: updatedId }] })
      .expect(200);
    expect(kept.body.server.secretSlots[0].id).toBe(updatedId);
    await admin.put("/api/admin/shared-mcp-servers/nope").send({ url: "https://x.example.com" }).expect(404);
    await admin.delete("/api/admin/shared-mcp-servers/jira").expect(200);
    await admin.delete("/api/admin/shared-mcp-servers/jira").expect(404);

    const audit = await admin.get("/api/audit").expect(200);
    const actions = (audit.body.audit as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["shared_mcp_create", "shared_mcp_disable", "shared_mcp_delete"]));
  });

  it("a user binds ONE OF THEIR OWN secrets; a moved origin, a removed slot or a deleted secret undoes it", async () => {
    const { services, admin, member, memberUser } = await boot();
    const createdId = (await admin.post("/api/admin/shared-mcp-servers").send(JIRA).expect(200)).body.server.secretSlots[0].id as string;
    const SAME = { ...JIRA, secretSlots: [{ ...JIRA.secretSlots[0], id: createdId }] };

    const before = await member.get("/api/me/shared-mcp-servers").expect(200);
    expect(before.body.servers).toEqual([
      {
        name: "jira",
        label: "Jira",
        description: "Issues",
        origin: "https://jira.example.com",
        slots: [{ id: createdId, label: "API 토큰", header: "Authorization", boundSecret: null, stale: false }],
      },
    ]);
    // Only a secret the user HAS, and never a reserved git/SSH one.
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${createdId}`).send({ secretName: "MY_JIRA" }).expect(400);
    await member.put("/api/me/secrets/GITHUB_TOKEN").send({ value: "ghp-xyz-123456" }).expect(200);
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${createdId}`).send({ secretName: "GITHUB_TOKEN" }).expect(400);
    await member.put("/api/me/shared-mcp-servers/jira/slots/nope").send({ secretName: "MY_JIRA" }).expect(404);
    await member.put("/api/me/secrets/MY_JIRA").send({ value: "member-jira-secret" }).expect(200);
    const boundRes = await member.put(`/api/me/shared-mcp-servers/jira/slots/${createdId}`).send({ secretName: "MY_JIRA" }).expect(200);
    expect(boundRes.body.servers[0].slots[0]).toMatchObject({ boundSecret: "MY_JIRA", stale: false });
    expect(services.store.listSharedMcpBindings(memberUser.id)).toEqual([
      { serverName: "jira", slotId: createdId, secretName: "MY_JIRA", origin: "https://jira.example.com" },
    ]);
    expect(JSON.stringify(boundRes.body)).not.toContain("member-jira-secret");

    // The admin moves the server: the binding is stale, not applied to the new host.
    await admin.put("/api/admin/shared-mcp-servers/jira").send({ ...SAME, url: "https://collector.example.net/mcp" }).expect(200);
    const moved = await member.get("/api/me/shared-mcp-servers").expect(200);
    expect(moved.body.servers[0]).toMatchObject({ origin: "https://collector.example.net" });
    expect(moved.body.servers[0].slots[0]).toMatchObject({ boundSecret: null, stale: true });

    // Rebind, then: removing the slot prunes it; deleting the secret prunes it.
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${createdId}`).send({ secretName: "MY_JIRA" }).expect(200);
    await admin.put("/api/admin/shared-mcp-servers/jira").send({ ...SAME, secretSlots: [] }).expect(200);
    expect(services.store.listSharedMcpBindings(memberUser.id)).toEqual([]);
    const readdedId = (await admin.put("/api/admin/shared-mcp-servers/jira").send(JIRA).expect(200)).body.server.secretSlots[0].id as string;
    // A removed slot's id is gone: re-adding it mints a fresh one, so nothing can be revived.
    expect(readdedId).not.toBe(createdId);
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${readdedId}`).send({ secretName: "MY_JIRA" }).expect(200);
    await member.delete("/api/me/secrets/MY_JIRA").expect(200);
    expect(services.store.listSharedMcpBindings(memberUser.id)).toEqual([]);

    // Unbind is idempotent; deleting the server prunes everyone's bindings.
    await member.put("/api/me/secrets/MY_JIRA").send({ value: "member-jira-secret" }).expect(200);
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${readdedId}`).send({ secretName: "MY_JIRA" }).expect(200);
    await member.delete(`/api/me/shared-mcp-servers/jira/slots/${readdedId}`).expect(200);
    await member.delete(`/api/me/shared-mcp-servers/jira/slots/${readdedId}`).expect(200);
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${readdedId}`).send({ secretName: "MY_JIRA" }).expect(200);
    await admin.delete("/api/admin/shared-mcp-servers/jira").expect(200);
    expect(services.store.listSharedMcpBindings(memberUser.id)).toEqual([]);

    const audit = await admin.get("/api/audit").expect(200);
    const actions = (audit.body.audit as { action: string }[]).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["shared_mcp_bind", "shared_mcp_unbind"]));
  });

  it("deleting a user removes their bindings", async () => {
    const { services, admin, member, memberUser } = await boot();
    const id = (await admin.post("/api/admin/shared-mcp-servers").send(JIRA).expect(200)).body.server.secretSlots[0].id as string;
    await member.put("/api/me/secrets/MY_JIRA").send({ value: "member-jira-secret" }).expect(200);
    await member.put(`/api/me/shared-mcp-servers/jira/slots/${id}`).send({ secretName: "MY_JIRA" }).expect(200);
    expect(services.store.deleteUser(memberUser.id)).toBe(true);
    expect(services.store.listSharedMcpBindings(memberUser.id)).toEqual([]);
  });

  it("an unreadable stored list (SESSION_SECRET rotated) reads as empty", async () => {
    const { services } = await boot();
    services.store.setAppSecret("shared_mcp_servers", "{not json");
    expect(services.store.getSharedMcpServers()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Plugin .mcp.json http/sse entries
// ---------------------------------------------------------------------------

describe("plugin .mcp.json lift", () => {
  const liftDir = withTempDir("shared-mcp-lift");
  const writeMcp = (dir: string, body: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(body));
  };

  it("expands only ${CLAUDE_PLUGIN_ROOT}, keeps the first definition of a name, and resolves no secret", async () => {
    const owned = path.join(liftDir(), "plugins", "u", "repo");
    const group = path.join(liftDir(), "group-knowledge", "g1");
    writeMcp(owned, {
      corp: { type: "http", url: "https://corp.example.com/mcp", headers: { Authorization: "Bearer ${CORP_TOKEN}" } },
      tool: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool", args: ["--root", "${CLAUDE_PLUGIN_ROOT}"], env: { A: "${CLAUDE_PLUGIN_ROOT}/x" } },
    });
    writeMcp(group, { corp: { type: "sse", url: "https://shadow.example.com/" } });
    const { servers } = await liftPluginMcpServers([owned, group]);
    // Placeholders other than the root stay for the pi relay to judge (piPlaceholderRefusal).
    expect(servers.corp).toEqual({ type: "http", url: "https://corp.example.com/mcp", headers: { Authorization: "Bearer ${CORP_TOKEN}" } });
    expect(servers.tool).toEqual({ command: `${owned}/bin/tool`, args: ["--root", owned], env: { A: `${owned}/x` } });
  });
});
