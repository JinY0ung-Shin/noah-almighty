/**
 * OPT-IN live integration against the isolated pi-gateway e2e instance
 * (~/.noah-work/pi-e2e, see its RUNBOOK.md). Skipped unless PI_E2E_LIVE=1 and
 * the instance env is present:
 *
 *   source ~/.noah-work/pi-e2e/env.sh && PI_E2E_LIVE=1 npx vitest run tests/pi-gateway-live.test.ts
 *   PI_E2E_LIVE=1 PI_E2E_DIR=~/.noah-work/pi-e2e npx vitest run tests/pi-gateway-live.test.ts
 *
 * It proves the whole N2/N3 chain: Noah's responses client + event adapter on
 * the real stream, and pi-gateway's MCP broker calling Noah's HTTP MCP endpoint
 * with the run token it got from `x-noah-run-token`. It registers a temporary
 * broker server `noahlane` (removed afterwards) and scripts the SHARED fake LLM
 * under a unique `[[fake:KEY]]`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { runPiTurn } from "../src/server/agent/pi/eventAdapter.js";
import { PiGatewayError, createPiResponsesClient } from "../src/server/agent/pi/responsesClient.js";
import { McpRunRegistry, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";
import { createServices } from "../src/server/app.js";
import type { AgentRequest } from "../src/server/types.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { runPiAgent } from "../src/server/agent/pi/runPiAgent.js";

// Either `source env.sh`, or point PI_E2E_DIR at the instance dir and the keys are read from its secrets.
function fromDir(): Record<string, string | undefined> {
  const dir = process.env.PI_E2E_DIR;
  if (!dir || process.env.PI_E2E_LIVE !== "1") return {};
  const read = (p: string) => {
    try {
      return fs.readFileSync(path.join(dir, p), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  return {
    PI_E2E_URL: "http://127.0.0.1:18080",
    FAKE_LLM_URL: "http://10.213.0.3:18091",
    PI_E2E_API_KEY: read("secrets/gateway/api_key"),
    PI_E2E_ADMIN_KEY: read("secrets/gateway/admin_api_key"),
    PI_E2E_WORKSPACES: path.join(dir, "home", "workspaces"),
  };
}
const env = { ...fromDir(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PI_E2E_") || k === "FAKE_LLM_URL")) };
const LIVE = env.PI_E2E_LIVE === "1" && Boolean(env.PI_E2E_URL && env.PI_E2E_API_KEY && env.PI_E2E_ADMIN_KEY && env.FAKE_LLM_URL);
const HOST_IP = env.PI_E2E_HOST_IP ?? "10.213.0.1";
const SERVER_ID = "noahlane";
const USER = "noahe2e-pilane";

async function fake(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${env.FAKE_LLM_URL}${path}`, { method: "POST", body: JSON.stringify(body) });
  return res.json();
}
async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${env.PI_E2E_URL}/admin/api${path}`, {
    method,
    headers: { authorization: `Bearer ${env.PI_E2E_ADMIN_KEY}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe.skipIf(!LIVE)("pi-gateway live (e2e instance)", () => {
  let httpServer: http.Server;
  const registry = new McpRunRegistry();
  const client = createPiResponsesClient({ baseUrl: env.PI_E2E_URL ?? "http://invalid", serviceKey: env.PI_E2E_API_KEY ?? "" });
  const seenRuns: unknown[] = [];

  function noahServer(): McpServer {
    const mcp = new McpServer({ name: SERVER_ID, version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echo text back (Noah lane test)", inputSchema: { text: z.string() } }, async ({ text }, extra) => {
      seenRuns.push(extra.authInfo?.extra?.run);
      return { content: [{ type: "text", text: `noah-echo:${text}` }] };
    });
    return mcp;
  }

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "50mb" }));
    app.use(createMcpHttpRouter({ registry }));
    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "0.0.0.0", resolve));
    const port = (httpServer.address() as AddressInfo).port;
    const put = await admin("PUT", `/mcp/servers/${SERVER_ID}`, {
      config: {
        runIn: "broker",
        transport: {
          type: "http",
          url: `http://${HOST_IP}:${port}/mcp/${SERVER_ID}`,
          headers: { Authorization: "Bearer {{ctx.header:x-noah-run-token}}" },
        },
        timeoutSec: 60,
      },
    });
    expect(put.status, await put.text()).toBeLessThan(300);
  });

  afterAll(async () => {
    await admin("DELETE", `/mcp/servers/${SERVER_ID}`).catch(() => undefined);
    await registry.closeAll();
    httpServer?.closeAllConnections();
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  });

  it("text → mcp_call into Noah's endpoint → text, with folding and the run token honored", async () => {
    const key = `pilane-${randomUUID().slice(0, 8)}`;
    await fake("/_fake/enqueue", {
      key,
      turns: [
        { text: "Checking.", toolCalls: [{ name: "mcp_call", arguments: { name: `mcp__${SERVER_ID}__echo`, arguments: { text: "hi" } } }] },
        { text: "all done", usage: { prompt_tokens: 1234, completion_tokens: 7, cached_tokens: 1000 } },
      ],
    });
    const token = registry.register({ servers: { [SERVER_ID]: noahServer() }, context: { lane: key } });
    const calls: [string, unknown][] = [];
    const events: AgentEvents = {
      onDelta: (d) => calls.push(["delta", d]),
      onTextFold: (t) => calls.push(["fold", t]),
      onToolStart: (e) => calls.push(["toolStart", e.name]),
      onToolEnd: (e) => calls.push(["toolEnd", e.ok]),
      onSessionId: (id) => calls.push(["session", id]),
    };
    const result = await runPiTurn({
      client,
      request: { user: USER, input: { kind: "prompt", text: `go [[fake:${key}]]` }, headers: { "x-noah-run-token": token } },
      events,
      contextWindow: 131072,
    });
    await registry.revoke(token);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("all done");
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(calls.filter(([n]) => n !== "session")).toEqual([
      ["delta", "Checking."],
      ["toolStart", `mcp__${SERVER_ID}__echo`],
      ["toolEnd", true],
      ["fold", "Checking."],
      ["delta", "all done"],
    ]);
    expect(calls.find(([n]) => n === "session")?.[1]).toBe(result.responseId);
    expect(seenRuns).toContainEqual({ lane: key });
    const recorded = (await (await fetch(`${env.FAKE_LLM_URL}/_fake/requests?key=${key}&limit=5`)).json()) as unknown;
    expect(JSON.stringify(recorded)).toContain("noah-echo:hi");
  });

  it("AskUserQuestion round trip inside one run", async () => {
    const key = `pilane-${randomUUID().slice(0, 8)}`;
    await fake("/_fake/enqueue", {
      key,
      turns: [
        {
          text: "Let me ask.",
          toolCalls: [
            {
              name: "AskUserQuestion",
              arguments: {
                questions: [
                  { question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] },
                ],
              },
            },
          ],
        },
        { echo: true },
      ],
    });
    let asked: unknown;
    const result = await runPiTurn({
      client,
      request: { user: USER, input: { kind: "prompt", text: `ask [[fake:${key}]]` } },
      events: {
        onQuestion: async (q) => {
          asked = q.payload;
          return { behavior: "completed", result: { answers: { "Which?": "B" } } };
        },
      },
    });
    expect(asked).toEqual({ questions: [expect.objectContaining({ question: "Which?" })] });
    expect(result.status).toBe("completed");
    expect(result.text).toContain('"Which?" → B');
  });

  it("abort cancels the live response (pi commits it incomplete) and throws aborted", async () => {
    const key = `pilane-${randomUUID().slice(0, 8)}`;
    await fake("/_fake/enqueue", { key, turns: [{ textChunks: ["one ", "two ", "three ", "four "], chunkDelayMs: 400 }] });
    const controller = new AbortController();
    const sessions: string[] = [];
    const run = runPiTurn({
      client,
      request: { user: USER, input: { kind: "prompt", text: `slow [[fake:${key}]]` } },
      signal: controller.signal,
      events: {
        onDelta: () => controller.abort(),
        onSessionId: (id) => sessions.push(id),
      },
    });
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(PiGatewayError);
    expect(err.kind).toBe("aborted");
    expect(sessions).toHaveLength(1);
    // The cancelled turn is continuable.
    await fake("/_fake/enqueue", { key, turns: [{ text: "resumed" }] });
    const next = await runPiTurn({
      client,
      request: { user: USER, previousResponseId: sessions[0], input: { kind: "prompt", text: "again" } },
    });
    expect(next.text).toBe("resumed");
  });

  it("a revoked token makes the broker skip Noah's server (401) instead of failing the turn", async () => {
    const key = `pilane-${randomUUID().slice(0, 8)}`;
    const token = registry.register({ servers: { [SERVER_ID]: noahServer() } });
    await registry.revoke(token);
    await fake("/_fake/enqueue", {
      key,
      turns: [{ toolCalls: [{ name: "mcp_call", arguments: { name: `mcp__${SERVER_ID}__echo`, arguments: { text: "x" } } }] }, { text: "ok" }],
    });
    const ends: boolean[] = [];
    const result = await runPiTurn({
      client,
      request: { user: USER, input: { kind: "prompt", text: `revoked [[fake:${key}]]` }, headers: { "x-noah-run-token": token } },
      events: { onToolEnd: (e) => ends.push(e.ok) },
    });
    expect(result.text).toBe("ok");
    expect(ends).toEqual([false]);
  });
});

// ---- runPiAgent end to end (lane I1) --------------------------------------------------------------
// Noah's real runner against the real gateway: frozen instructions, continuation, an effort change
// starting a new session from the text history, and steers delivered as a follow-up turn. MCP calls
// through the broker are covered by the harness (~/.noah-work/pi-e2e/noah-harness, S08): the broker's
// Noah server ids point at the harness Noah, not at this test process.
describe.skipIf(!LIVE)("runPiAgent live (e2e instance)", () => {
  let services: ReturnType<typeof createServices>;
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-pi-live-"));
    services = createServices({
      dataDir: tmp,
      agentRuntime: "pi",
      sessionSecret: "t",
      pi: {
        gatewayUrl: env.PI_E2E_URL!,
        apiKey: env.PI_E2E_API_KEY!,
        ...(env.PI_E2E_WORKSPACES ? { workspacesDir: env.PI_E2E_WORKSPACES } : {}),
        modelMap: { opus: { model: "fake-model", contextWindow: 131072 } },
        deckSandbox: false,
      },
    });
  });
  afterAll(() => {
    services?.store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function llmRequests(key: string): Promise<{ body: { messages: { role: string; content: unknown }[] } }[]> {
    const r = (await (await fetch(`${env.FAKE_LLM_URL}/_fake/requests?key=${key}&limit=20`)).json()) as unknown;
    return (Array.isArray(r) ? r : (r as { requests: unknown[] }).requests) as never;
  }
  const textOf = (content: unknown) =>
    typeof content === "string" ? content : JSON.stringify(content);

  it("frozen instructions, continuation, an effort change, then steers as one follow-up turn", async () => {
    const { store, config } = services;
    const user = store.createUser({ username: `live-${randomUUID().slice(0, 6)}`, displayName: "Live", password: "password123" });
    const conversationId = randomUUID();
    store.touchConversation(user.id, conversationId, user.id, "live");
    const key = `pilane-i1-${randomUUID().slice(0, 8)}`;
    await fake("/_fake/enqueue", {
      key,
      turns: [{ text: "first" }, { text: "second" }, { text: "third" }, { text: "fourth", delayMs: 1500 }, { text: "fifth" }],
    });
    const base: AgentRequest = {
      message: `hello [[fake:${key}]]`,
      avatar: { id: user.id, displayName: "Live", alias: "", persona: "" },
      conversationId,
      viewerUserId: user.id,
      viewerIsOwner: true,
      elevated: true,
      autoApprove: true,
      effort: "low",
    };
    const sessions: string[] = [];
    const events = (): AgentEvents => ({ onSessionId: (id) => sessions.push(id) });
    const r1 = await runPiAgent(base, [], config, store, events(), undefined);
    expect(r1.text).toBe("first");
    const r2 = await runPiAgent({ ...base, message: "next", resumeSessionId: sessions.at(-1) }, [], config, store, events(), undefined);
    expect(r2.text).toBe("second");
    const r3 = await runPiAgent(
      {
        ...base,
        message: "now think harder",
        effort: "high",
        resumeSessionId: sessions.at(-1),
        conversationHistory: [
          { role: "user", content: `hello [[fake:${key}]]` },
          { role: "assistant", content: "first" },
          { role: "user", content: "next" },
          { role: "assistant", content: "second" },
        ],
      },
      [],
      config,
      store,
      events(),
      undefined,
    );
    expect(r3.text).toBe("third");
    const steers = new SteerChannel();
    const turnResults: unknown[] = [];
    const r4 = await runPiAgent(
      { ...base, message: "long one", effort: "high", resumeSessionId: sessions.at(-1) },
      [],
      config,
      store,
      {
        ...events(),
        steers,
        onDelta: () => undefined,
        onStatus: (label) => {
          if (label === "응답 생성 중…" && steers.records().length === 0) steers.push("steered text");
        },
        onTurnResult: (segment) => turnResults.push(segment),
      },
      undefined,
    );
    expect(r4.text).toBe("fifth");
    expect(turnResults).toEqual([
      expect.objectContaining({ text: "fourth", steerPending: true }),
      expect.objectContaining({ text: "fifth", steerPending: false }),
    ]);
    const reqs = await llmRequests(key);
    expect(reqs).toHaveLength(5);
    const system = (i: number) => textOf(reqs[i]!.body.messages[0]!.content);
    expect(system(0)).toContain("Runtime: your own pi sandbox");
    expect(system(2)).toBe(system(0)); // the frozen prompt reused by the new session
    // Turn 2 continued the session; turn 3 (effort changed) started a new one from the text history.
    expect(reqs[1]!.body.messages.some((m) => m.role === "assistant" && textOf(m.content).includes("first"))).toBe(true);
    const third = reqs[2]!.body.messages;
    expect(third.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(textOf(third.at(-1)!.content)).toContain("Session note: the model or reasoning effort changed");
    expect(textOf(reqs[4]!.body.messages.at(-1)!.content)).toContain("steered text");
    await fake("/_fake/reset", { key });
  });
});
