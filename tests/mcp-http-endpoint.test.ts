import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRunRegistry, RUN_TOKEN_PREFIX, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface Probe {
  aborted: boolean;
  started: boolean;
  authExtra: unknown;
}

function buildServer(probe: Probe): McpServer {
  const mcp = new McpServer({ name: "repo", version: "1.0.0" });
  mcp.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }, extra) => {
    probe.authExtra = extra.authInfo?.extra;
    return { content: [{ type: "text", text: `echo:${text}` }] };
  });
  mcp.registerTool("secret", { description: "Leaks a secret", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: "token=hunter2" }],
  }));
  mcp.registerTool("image", { description: "A picture", inputSchema: {} }, async () => ({
    content: [
      { type: "text", text: "one pixel" },
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
    ],
  }));
  mcp.registerTool("wait", { description: "Waits until aborted", inputSchema: {} }, async (_args, extra) => {
    probe.started = true;
    await new Promise<void>((resolve) => {
      if (extra.signal.aborted) resolve();
      extra.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    probe.aborted = extra.signal.aborted;
    return { content: [{ type: "text", text: "aborted" }] };
  });
  return mcp;
}

let httpServer: http.Server;
let baseUrl = "";
let registry: McpRunRegistry;
const clients: Client[] = [];

beforeEach(async () => {
  registry = new McpRunRegistry();
  const app = express();
  app.use(express.json({ limit: "50mb" })); // like createApp: the router must cope with a pre-parsed body
  app.use(createMcpHttpRouter({ registry }));
  httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await registry.closeAll();
  httpServer.closeAllConnections();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connect(server: string, token: string | null): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${server}`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "broker-under-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};
async function rawInit(server: string, token?: string) {
  return fetch(`${baseUrl}/mcp/${server}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(initBody),
  });
}

describe("McpRunRegistry + /mcp/:server", () => {
  it("serves tools to a valid run token and hands the run context to handlers", async () => {
    const probe: Probe = { aborted: false, started: false, authExtra: undefined };
    const token = registry.register({ servers: { repo: buildServer(probe) }, context: { conversationId: "c1" } });
    expect(token.startsWith(RUN_TOKEN_PREFIX)).toBe(true);
    const client = await connect("repo", token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "image", "secret", "wait"]);
    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "echo:hi" }]);
    expect(probe.authExtra).toEqual({ run: { conversationId: "c1" }, server: "repo" });
  });

  it("accepts the createSdkMcpServer `{ instance }` shape and factories", async () => {
    const probe: Probe = { aborted: false, started: false, authExtra: undefined };
    const token = registry.register({
      servers: {
        repo: { type: "sdk", name: "repo", instance: buildServer(probe) } as unknown as { instance: McpServer },
        todo: () => buildServer(probe),
      },
    });
    const a = await connect("repo", token);
    const b = await connect("todo", token);
    const c = await connect("todo", token); // factory: concurrent sessions coexist
    await expect(a.callTool({ name: "echo", arguments: { text: "a" } })).resolves.toMatchObject({ content: [{ text: "echo:a" }] });
    await expect(b.callTool({ name: "echo", arguments: { text: "b" } })).resolves.toMatchObject({ content: [{ text: "echo:b" }] });
    await expect(c.callTool({ name: "echo", arguments: { text: "c" } })).resolves.toMatchObject({ content: [{ text: "echo:c" }] });
  });

  it("an instance source re-initializes cleanly (the previous session is released)", async () => {
    const probe: Probe = { aborted: false, started: false, authExtra: undefined };
    const token = registry.register({ servers: { repo: buildServer(probe) } });
    const first = await connect("repo", token);
    await first.callTool({ name: "echo", arguments: { text: "1" } });
    const second = await connect("repo", token);
    await expect(second.callTool({ name: "echo", arguments: { text: "2" } })).resolves.toMatchObject({ content: [{ text: "echo:2" }] });
    // the old session is gone (404 → its client errors)
    await expect(first.callTool({ name: "echo", arguments: { text: "x" } })).rejects.toThrow();
  });

  it("401s a missing, unknown or revoked token on every path, before revealing servers", async () => {
    const token = registry.register({ servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    for (const [server, presented] of [
      ["repo", undefined],
      ["repo", "nrt_not-a-real-token"],
      ["nope", undefined],
      ["nope", "nrt_not-a-real-token"],
    ] as const) {
      const res = await rawInit(server, presented);
      expect(res.status, `${server} ${presented}`).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    await expect(connect("repo", null)).rejects.toThrow();
    // valid token + unknown server → 404
    expect((await rawInit("nope", token)).status).toBe(404);
    await registry.revoke(token);
    expect((await rawInit("repo", token)).status).toBe(401);
    expect(registry.size).toBe(0);
  });

  it("refuses a non-initialize request without a session and an unknown session id", async () => {
    const token = registry.register({ servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    const noSession = await fetch(`${baseUrl}/mcp/repo`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(noSession.status).toBe(400);
    const unknown = await fetch(`${baseUrl}/mcp/repo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-session-id": "00000000-0000-0000-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("passes image content through untouched", async () => {
    const token = registry.register({ servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    const client = await connect("repo", token);
    const result = await client.callTool({ name: "image", arguments: {} });
    expect(result.content).toEqual([
      { type: "text", text: "one pixel" },
      { type: "image", data: PNG_1PX, mimeType: "image/png" },
    ]);
  });

  it("revoke aborts an in-flight tool call and kills the session", async () => {
    const probe: Probe = { aborted: false, started: false, authExtra: undefined };
    const token = registry.register({ servers: { repo: buildServer(probe) } });
    const client = await connect("repo", token);
    const pending = client.callTool({ name: "wait", arguments: {} });
    await expect.poll(() => probe.started).toBe(true);
    await registry.revoke(token);
    await expect(pending).rejects.toThrow();
    await expect.poll(() => probe.aborted).toBe(true);
    await expect(client.listTools()).rejects.toThrow();
  });

  it("the run's AbortSignal revokes the token", async () => {
    const probe: Probe = { aborted: false, started: false, authExtra: undefined };
    const run = new AbortController();
    const token = registry.register({ servers: { repo: buildServer(probe) }, signal: run.signal });
    const client = await connect("repo", token);
    const pending = client.callTool({ name: "wait", arguments: {} });
    await expect.poll(() => probe.started).toBe(true);
    run.abort();
    await expect(pending).rejects.toThrow();
    await expect.poll(() => probe.aborted).toBe(true);
    expect((await rawInit("repo", token)).status).toBe(401);
    // an already-aborted signal never yields a usable token
    const dead = new AbortController();
    dead.abort();
    const deadToken = registry.register({ servers: { repo: buildServer(probe) }, signal: dead.signal });
    await expect.poll(async () => (await rawInit("repo", deadToken)).status).toBe(401);
  });

  it("gates hide AND refuse tools, and transform results (redaction)", async () => {
    const token = registry.register({
      servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) },
      gates: {
        allowTool: (server, tool) => server === "repo" && tool !== "wait",
        transformResult: (_server, _tool, result) => ({
          ...result,
          content: result.content.map((c) => (c.type === "text" ? { ...c, text: c.text.replace("hunter2", "[REDACTED]") } : c)),
        }),
      },
    });
    const client = await connect("repo", token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "image", "secret"]);
    const refused = await client.callTool({ name: "wait", arguments: {} });
    expect(refused).toMatchObject({ isError: true, content: [{ type: "text", text: "Tool 'wait' is not available in this run." }] });
    const redacted = await client.callTool({ name: "secret", arguments: {} });
    expect(redacted.content).toEqual([{ type: "text", text: "token=[REDACTED]" }]);
  });

  it("tokens are scoped to their own run's servers", async () => {
    const a = registry.register({ servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    const b = registry.register({ servers: { todo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    expect((await rawInit("todo", a)).status).toBe(404);
    expect((await rawInit("repo", b)).status).toBe(404);
    expect(a).not.toBe(b);
  });
});

describe("NOAH_MCP_ALLOWED_CIDRS (optional peer allowlist)", () => {
  it("parses CIDRs and bare hosts, maps IPv4-on-IPv6 peers, and fails the boot on a typo", async () => {
    const { parseMcpNetworkAcl } = await import("../src/server/mcpHttp/networkAcl.js");
    expect(parseMcpNetworkAcl("")).toBeNull();
    expect(parseMcpNetworkAcl(undefined)).toBeNull();
    const acl = parseMcpNetworkAcl("10.0.0.0/8, 192.168.1.7 fd00::/8")!;
    expect(acl.cidrs).toEqual(["10.0.0.0/8", "192.168.1.7", "fd00::/8"]);
    expect(acl.allows("10.1.2.3")).toBe(true);
    expect(acl.allows("::ffff:10.1.2.3")).toBe(true);
    expect(acl.allows("192.168.1.7")).toBe(true);
    expect(acl.allows("192.168.1.8")).toBe(false);
    expect(acl.allows("fd12::1")).toBe(true);
    expect(acl.allows("127.0.0.1")).toBe(false);
    expect(acl.allows(undefined)).toBe(false);
    for (const bad of ["10.0.0.0/33", "nope", "10.0.0.0/x", "fd00::/129"]) {
      expect(() => parseMcpNetworkAcl(bad), bad).toThrow("NOAH_MCP_ALLOWED_CIDRS");
    }
  });

  it("refuses a peer outside the list with 403 before the token is even looked at; inside it the token rules", async () => {
    const { parseMcpNetworkAcl } = await import("../src/server/mcpHttp/networkAcl.js");
    const token = registry.register({ servers: { repo: buildServer({ aborted: false, started: false, authExtra: null }) } });
    for (const [cidrs, expected] of [["10.0.0.0/8", 403], ["127.0.0.0/8", 200]] as const) {
      const app = express();
      app.use(createMcpHttpRouter({ registry, networkAcl: parseMcpNetworkAcl(cidrs) }));
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/repo`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
          body: JSON.stringify(initBody),
        });
        expect(res.status, cidrs).toBe(expected);
        await res.body?.cancel();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
