/**
 * The pi runner (lane I1): `runPiAgent` against a scripted fake pi client, the
 * run-class decision, the HTTP MCP endpoint as pi's broker sees it, config and
 * the registration script's server list. The fake client replaces the network;
 * everything Noah-side (store, capability plan, MCP servers, router) is real.
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, createServices } from "../src/server/app.js";
import { loadConfig, parsePiModelMap } from "../src/server/config.js";
import type { AgentRequest, PiRuntimeConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { McpRunRegistry, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";
import { PI_MCP_SERVER_NAMES } from "../src/server/agent/pi/mcpCatalog.js";
import { PI_RUN_TOKEN_HEADER, piRuntimeSupports } from "../src/server/agent/pi/piRuntime.js";
import { isPiResponseId, piSessionKey, runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import { piConversationSegment, piHostPath, piUserKey, piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { PiGatewayError, type PiResponseRequest, type PiResponsesClient, type PiStreamEvent } from "../src/server/agent/pi/responsesClient.js";
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { withTempDir, signup } from "./helpers.js";

const dir = withTempDir("pi-runner");

// ---- fake pi ----------------------------------------------------------------------

type Step = (req: PiResponseRequest) => PiStreamEvent[] | Error | Promise<PiStreamEvent[] | Error>;

function fakeClient(steps: Step[]) {
  const requests: PiResponseRequest[] = [];
  let index = 0;
  const client: PiResponsesClient = {
    async *stream(req) {
      requests.push(structuredClone(req));
      const step = steps[index++];
      if (!step) throw new Error(`unexpected pi request #${index}`);
      const out = await step(req);
      if (out instanceof Error) throw out;
      for (const event of out) yield event;
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

const ev = (type: string, data: Record<string, unknown>): PiStreamEvent => ({ type, data });

function textTurn(id: string, text: string): PiStreamEvent[] {
  return [
    ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } }),
    ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } }),
    ev("response.output_text.delta", { delta: text }),
    ev("response.output_item.done", { item: { type: "message", id: `${id}-m`, status: "completed" } }),
    ev("response.completed", {
      response: { id, status: "completed", usage: { output_tokens: 7, input_tokens_details: { context_tokens: 120 } } },
    }),
  ];
}

function questionTurn(id: string, callId: string): PiStreamEvent[] {
  const args = JSON.stringify({ questions: [{ question: "Color?", options: [{ label: "Blue" }] }] });
  return [
    ev("response.created", { response: { id, model: "fake-model" } }),
    ev("response.output_item.added", { item: { type: "function_call", call_id: callId, name: "AskUserQuestion", arguments: args } }),
    ev("response.completed", {
      response: { id, status: "requires_action", output: [{ type: "function_call", call_id: callId, name: "AskUserQuestion", arguments: args }] },
    }),
  ];
}

// ---- fixtures ---------------------------------------------------------------------------

const PI: PiRuntimeConfig = {
  gatewayUrl: "http://pi.invalid",
  apiKey: "service-key",
  modelMap: { opus: { model: "m-opus", contextWindow: 200_000 }, sonnet: { model: "m-sonnet" } },
  deckSandbox: false,
};

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

function recorder(extra: Partial<AgentEvents> = {}) {
  const calls: [string, unknown][] = [];
  const push = (name: string) => (arg: unknown) => void calls.push([name, arg]);
  const events: AgentEvents = {
    onDelta: push("delta"),
    onStatus: push("status"),
    onSessionId: push("session"),
    onResumePoint: push("resume"),
    onTurnResult: push("turnResult"),
    onTextFold: push("fold"),
    ...extra,
  };
  return { events, calls };
}
const of = (calls: [string, unknown][], name: string) => calls.filter(([n]) => n === name).map(([, v]) => v);
const inputText = (req: PiResponseRequest) => (req.input.kind === "prompt" ? req.input.text : "");

// ---- runPiAgent ---------------------------------------------------------------------------

describe("runPiAgent", () => {
  it("first turn: frozen instructions, model + context window from PI_MODEL_MAP, session id doubles as the resume point", async () => {
    const { store, config, owner, base } = setup();
    const { client, requests } = fakeClient([() => textTurn("resp_s1_1", "Hello!")]);
    const { events, calls } = recorder({ steers: new SteerChannel() });
    const response = await runPiAgent(base(), [], config, store, events, new AbortController(), { client });

    expect(response).toMatchObject({ runtime: "pi", text: "Hello!" });
    expect(response.usage).toMatchObject({ inputTokens: 120, outputTokens: 7, contextWindow: 200_000 });
    const [req] = requests;
    expect(req!.user).toBe(owner.id);
    expect(req!.model).toBe("m-opus");
    expect(req!.previousResponseId).toBeUndefined();
    expect(req!.headers?.[PI_RUN_TOKEN_HEADER]).toMatch(/^nrt_/);
    // The pi append: runtime facts + the conversation folder, and no per-turn lines.
    const conversationDir = `/workspace/c/${piConversationSegment("conv-1")}`;
    expect(req!.instructions).toContain("Runtime: your own pi sandbox");
    expect(req!.instructions).toContain(conversationDir);
    expect(req!.instructions).toContain("arrives as the NEXT user turn");
    expect(req!.instructions).not.toContain("[Current date and time");
    expect(inputText(req!)).toMatch(/^\[Current date and time: \d{4}-\d\d-\d\d \d\d:\d\d KST\]/);
    expect(inputText(req!)).toContain("User message:\nhello there");
    expect(of(calls, "session")).toEqual(["resp_s1_1"]);
    expect(of(calls, "resume")).toEqual([{ sessionId: "resp_s1_1", uuid: "resp_s1_1" }]);
    expect(of(calls, "turnResult")).toEqual([expect.objectContaining({ text: "Hello!", steerPending: false })]);
    // Frozen per conversation (D2), and the session's profile recorded (P3).
    expect(store.ensureConversationPiInstructions(owner.id, "conv-1", () => "never")).toBe(req!.instructions);
    expect(store.getConversationPiSessionProfile(owner.id, "conv-1", "s1")).toBe("m-opus|");
    // The conversation folder exists on the host side, 0700.
    const hostDir = piWorkspaceFor(config, owner.id, "conv-1").hostConversationDir!;
    expect(fs.statSync(hostDir).mode & 0o777).toBe(0o700);
  });

  it("continues the stored session without instructions or history; an SDK session id is ignored", async () => {
    const { store, config, base } = setup();
    const history = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    const first = fakeClient([() => textTurn("resp_s1_2", "again")]);
    await runPiAgent(base({ resumeSessionId: "resp_s1_1", conversationHistory: history }), [], config, store, undefined, undefined, {
      client: first.client,
    });
    expect(first.requests[0]).toMatchObject({ previousResponseId: "resp_s1_1" });
    expect(first.requests[0]!.instructions).toBeUndefined();
    expect(first.requests[0]!.model).toBeUndefined();
    expect(inputText(first.requests[0]!)).not.toContain("earlier answer");

    const legacy = fakeClient([() => textTurn("resp_s2_1", "fresh")]);
    await runPiAgent(
      base({ resumeSessionId: "0b5e7a4c-sdk-session", conversationHistory: history }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client: legacy.client },
    );
    expect(legacy.requests[0]!.previousResponseId).toBeUndefined();
    expect(legacy.requests[0]!.instructions).toBeTruthy();
    expect(inputText(legacy.requests[0]!)).toContain("earlier answer");
  });

  it("reuses the frozen prompt for every new session, even after the self-state changed", async () => {
    const { store, config, base } = setup();
    const one = fakeClient([() => textTurn("resp_a_1", "one")]);
    await runPiAgent(base(), [], config, store, undefined, undefined, { client: one.client });
    const two = fakeClient([() => textTurn("resp_b_1", "two")]);
    await runPiAgent(base({ avatar: { ...base().avatar, persona: "A brand-new persona" } }), [], config, store, undefined, undefined, {
      client: two.client,
    });
    expect(two.requests[0]!.instructions).toBe(one.requests[0]!.instructions);
    expect(two.requests[0]!.instructions).not.toContain("A brand-new persona");
  });

  it("a model change starts a new session from the text history and says so", async () => {
    const { store, config, owner, base } = setup();
    store.setConversationPiSessionProfile(owner.id, "conv-1", "s1", "m-opus|");
    const { client, requests } = fakeClient([() => textTurn("resp_s9_1", "switched")]);
    const { events, calls } = recorder();
    await runPiAgent(
      base({
        modelTier: "sonnet",
        resumeSessionId: "resp_s1_4",
        conversationHistory: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1 from opus" },
        ],
      }),
      [],
      config,
      store,
      events,
      undefined,
      { client },
    );
    const [req] = requests;
    expect(req!.previousResponseId).toBeUndefined();
    expect(req!.model).toBe("m-sonnet");
    expect(req!.instructions).toBeTruthy();
    expect(inputText(req!)).toContain("Session note: the model or reasoning effort changed");
    expect(inputText(req!)).toContain("a1 from opus");
    expect(of(calls, "status")).toContain("모델 또는 사고 강도가 바뀌어 새 세션에서 이전 대화 기록으로 이어갑니다…");
    expect(store.getConversationPiSessionProfile(owner.id, "conv-1", "s9")).toBe("m-sonnet|");
  });

  it("a rewind forks at the kept row's response id and states the rewind in the turn input", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([() => textTurn("resp_s1_5", "redo")]);
    await runPiAgent(
      base({ resumeSessionId: "resp_s1_1", resumeSessionAt: "resp_s1_1", rewind: { kind: "regenerate", discardedMessages: 1 } }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client },
    );
    expect(requests[0]!.previousResponseId).toBe("resp_s1_1");
    expect(inputText(requests[0]!)).toContain("Conversation rewind (this turn):");
  });

  it("self-heals a lost session (404) once from the stored history", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("not_found", { status: 404 }),
      () => textTurn("resp_new_1", "healed"),
    ]);
    const response = await runPiAgent(
      base({ resumeSessionId: "resp_gone_3", conversationHistory: [{ role: "assistant", content: "kept context" }] }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client },
    );
    expect(response.text).toBe("healed");
    expect(requests.map((r) => r.previousResponseId)).toEqual(["resp_gone_3", undefined]);
    expect(requests[1]!.instructions).toBeTruthy();
    expect(inputText(requests[1]!)).toContain("Session note: the previous session could not be resumed");
    expect(inputText(requests[1]!)).toContain("kept context");
  });

  it("answers AskUserQuestion through onQuestion and continues the same run", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([() => questionTurn("resp_q_1", "call_1"), () => textTurn("resp_q_2", "Blue it is")]);
    const questions: unknown[] = [];
    const { events } = recorder({
      onQuestion: async (q) => {
        questions.push(q);
        return { behavior: "completed", result: { answers: { "Color?": "Blue" } } };
      },
    });
    const response = await runPiAgent(base(), [], config, store, events, undefined, { client });
    expect(response.text).toBe("Blue it is");
    expect(questions).toHaveLength(1);
    expect(requests[1]).toMatchObject({ previousResponseId: "resp_q_1", input: { kind: "answer", callId: "call_1" } });
  });

  it("delivers mid-turn messages together as ONE follow-up turn after the answer (turn_end contract)", async () => {
    const { store, config, base } = setup();
    const steers = new SteerChannel();
    const { client, requests } = fakeClient([
      () => {
        steers.push("also check the logs");
        steers.push("and be brief");
        return textTurn("resp_t_1", "First answer");
      },
      () => textTurn("resp_t_2", "Follow-up answer"),
    ]);
    const { events, calls } = recorder({ steers });
    const response = await runPiAgent(base(), [], config, store, events, undefined, { client });

    expect(response.text).toBe("Follow-up answer");
    expect(of(calls, "turnResult")).toEqual([
      expect.objectContaining({ text: "First answer", steerPending: true, backgroundTasks: [] }),
      expect.objectContaining({ text: "Follow-up answer", steerPending: false }),
    ]);
    expect(requests[1]!.previousResponseId).toBe("resp_t_1");
    expect(requests[1]!.instructions).toBeUndefined();
    expect(inputText(requests[1]!)).toMatch(/also check the logs\n\nand be brief$/);
    expect(steers.records().map((r) => [r.state, r.followUp])).toEqual([
      ["completed", true],
      ["completed", true],
    ]);
    expect(steers.closed).toBe(true);
  });

  it("walks the model fallback chain with a fresh session per attempt", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
      () => textTurn("resp_f_1", "from sonnet"),
    ]);
    const response = await runPiAgent(
      base({ headless: true, allowHeadlessTools: true, modelFallback: true }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client, retry: { attempts: 1 } },
    );
    expect(response.text).toBe("from sonnet");
    expect(requests.map((r) => r.model)).toEqual(["m-opus", "m-sonnet"]);
    expect(requests.every((r) => r.instructions && !r.previousResponseId)).toBe(true);
  });

  it("serves EVERY Noah server to the broker: the full catalog listed, calls gated per run", async () => {
    const { store, config, owner, base } = setup();
    const registry = new McpRunRegistry();
    const app = express();
    app.use(express.json());
    app.use(createMcpHttpRouter({ registry }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const seen: Record<string, unknown> = {};
    try {
      const connect = async (name: string, token: string) => {
        const mcp = new Client({ name: "broker", version: "1" });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(`${url}/mcp/${name}`), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        return mcp;
      };
      const { client } = fakeClient([
        async (req) => {
          const token = req.headers![PI_RUN_TOKEN_HEADER]!;
          // A server this run did not build (no canvas sink) still lists its tools…
          const canvas = await connect("canvas", token);
          seen.canvasTools = (await canvas.listTools()).tools.map((t) => t.name);
          // …and refuses the call with a redirect.
          seen.canvasCall = await canvas.callTool({ name: "show", arguments: {} });
          // The todo server lists delete_todo (widest form) but this run allows the rest.
          const todo = await connect("todo", token);
          seen.todoTools = (await todo.listTools()).tools.map((t) => t.name);
          const system = await connect("system", token);
          seen.describe = await system.callTool({ name: "describe_system", arguments: {} });
          await Promise.all([canvas.close(), todo.close(), system.close()]);
          return textTurn("resp_m_1", "done");
        },
      ]);
      await runPiAgent(base(), [], config, store, { steers: new SteerChannel() }, undefined, { client, registry });
      expect(registry.size).toBe(0); // revoked at run end
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(seen.canvasTools).toEqual(["show"]);
    expect(seen.canvasCall).toMatchObject({ isError: true });
    expect(JSON.stringify(seen.canvasCall)).toContain("mcp__system__describe_system");
    expect(seen.todoTools).toEqual(expect.arrayContaining(["add_todos", "list_todos", "delete_todo"]));
    const describeText = JSON.stringify(seen.describe);
    expect(describeText).toContain("runtime: pi (pi-gateway)");
    expect(describeText).toContain(`/workspace/c/${piConversationSegment("conv-1")}`);
    expect(describeText).toContain("delivered as the NEXT turn");
    expect(describeText).toContain("conversation scratch workspace (`/workspace/c/");
    void owner;
  });
});

// ---- decisions, paths, prompt --------------------------------------------------------------

describe("piRuntimeSupports", () => {
  const base: AgentRequest = {
    message: "m",
    avatar: { id: "owner-1", displayName: "O", alias: "", persona: "" },
    conversationId: "c",
    viewerUserId: "owner-1",
    viewerIsOwner: true,
  };
  it.each([
    ["owner chat", base, true],
    ["trusted colleague (principal = viewer)", { ...base, viewerUserId: "mate-1", viewerIsOwner: false, elevated: true }, true],
    ["owner routine", { ...base, headless: true, allowHeadlessTools: true }, true],
    ["task API turn", { ...base, externalTaskApi: true }, true],
    ["untrusted colleague", { ...base, viewerUserId: "x", viewerIsOwner: false }, false],
    ["consultation", { ...base, headless: true, avatarConsultation: true, viewerIsOwner: false, elevated: true }, false],
    ["intro/hashtag generator", { ...base, headless: true }, false],
    ["no conversation", { ...base, conversationId: undefined }, false],
  ] as [string, AgentRequest, boolean][])("%s", (_label, req, supported) => {
    const decision = piRuntimeSupports(req);
    expect(decision.supported).toBe(supported);
    if (decision.supported) expect(decision.principal).toBe(req.viewerUserId);
  });
});

describe("pi workspace + ids", () => {
  it("maps paths inside the user's root only", () => {
    const config = loadConfig({ dataDir: dir(), agentRuntime: "pi", pi: { ...PI, workspacesDir: path.join(dir(), "ws") } });
    const ws = piWorkspaceFor(config, "user-1", "conv-1");
    expect(ws.hostRoot).toBe(path.join(dir(), "ws", piUserKey("user-1")));
    expect(piUserKey("user-1")).toMatch(/^u-[0-9a-f]{24}$/);
    expect(piHostPath(ws, "/workspace/c/conv-1/a.txt")).toBe(path.join(ws.hostRoot!, "c", "conv-1", "a.txt"));
    expect(piHostPath(ws, "/workspace/../etc/passwd")).toBeNull();
    expect(piHostPath(ws, "/etc/passwd")).toBeNull();
    expect(piConversationSegment("../x")).toMatch(/^h-[0-9a-f]{32}$/);
  });
  it("recognizes pi response ids", () => {
    expect(isPiResponseId("resp_3f2a-11_4")).toBe(true);
    expect(isPiResponseId("4f0e0c8e-sdk")).toBe(false);
    expect(piSessionKey("resp_3f2a-11_4")).toBe("3f2a-11");
  });
});

describe("pi prompt variant", () => {
  const owner: AgentRequest = {
    message: "m",
    avatar: { id: "o", displayName: "O", alias: "", persona: "" },
    viewerIsOwner: true,
    viewerName: "Ann",
    externalTaskApi: true,
    rewind: { kind: "edit", discardedMessages: 2 },
    midTurnMessages: true,
    secretNames: ["API_TOKEN"],
    shellExposedSecretNames: ["API_TOKEN"],
  };
  it("moves per-turn provenance out of the frozen append and states the runtime", () => {
    const pi = buildSystemPromptAppend({ ...owner, piRuntime: { conversationDir: "/workspace/c/x", shellSecretsUnavailable: ["API_TOKEN"] } });
    expect(pi).toContain("Runtime: your own pi sandbox");
    expect(pi).not.toContain("Conversation rewind (this turn)");
    expect(pi).not.toContain("submitted by an **EXTERNAL SYSTEM**");
    expect(pi).toContain("sandbox shell receives NO secrets");
    expect(pi).toContain("arrives as the NEXT user turn");
    const turn = buildPiTurnPreamble(owner, { now: new Date("2026-10-29T00:00:00Z") });
    expect(turn).toContain("[Current date and time: 2026-10-29 09:00 KST]");
    expect(turn).toContain("Conversation rewind (this turn)");
    expect(turn).toContain("submitted by an **EXTERNAL SYSTEM**");
  });
  it("leaves the SDK append unchanged", () => {
    const sdk = buildSystemPromptAppend(owner);
    expect(sdk).not.toContain("Runtime: your own pi sandbox");
    expect(sdk).toContain("Conversation rewind (this turn)");
    expect(sdk).toContain("submitted by an **EXTERNAL SYSTEM**");
    expect(sdk).toContain("ALSO exported into your Bash shell");
  });
});

// ---- config, app mount, registration script ----------------------------------------------------

describe("pi config", () => {
  it("parses and validates PI_MODEL_MAP", () => {
    expect(parsePiModelMap('{"opus":"m1","sonnet":{"model":"m2","contextWindow":1000}}')).toEqual({
      opus: { model: "m1" },
      sonnet: { model: "m2", contextWindow: 1000 },
    });
    expect(parsePiModelMap("")).toEqual({});
    expect(() => parsePiModelMap("[1]")).toThrow(/JSON object/);
    expect(() => parsePiModelMap("{oops")).toThrow(/JSON object/);
    expect(() => parsePiModelMap('{"opus":{"model":"m","contextWindow":-1}}')).toThrow(/PI_MODEL_MAP\["opus"\]/);
    expect(() => parsePiModelMap('{"opus":""}')).toThrow(/PI_MODEL_MAP\["opus"\]/);
  });

  it("AGENT_RUNTIME=pi requires the gateway URL and service key", () => {
    const saved = { ...process.env };
    try {
      process.env.AGENT_RUNTIME = "pi";
      delete process.env.PI_GATEWAY_URL;
      delete process.env.PI_GATEWAY_API_KEY;
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/PI_GATEWAY_URL and PI_GATEWAY_API_KEY/);
      process.env.PI_GATEWAY_URL = "http://pi:8080";
      process.env.PI_GATEWAY_API_KEY = "k";
      process.env.PI_WORKSPACES_DIR = "/srv/pi/workspaces";
      process.env.PI_DECK_SANDBOX = "true";
      process.env.PI_MODEL_MAP = '{"opus":"anthropic/claude-opus"}';
      const config = loadConfig({ dataDir: dir() });
      expect(config.agentRuntime).toBe("pi");
      expect(config.pi).toEqual({
        gatewayUrl: "http://pi:8080",
        apiKey: "k",
        workspacesDir: "/srv/pi/workspaces",
        modelMap: { opus: { model: "anthropic/claude-opus" } },
        deckSandbox: true,
      });
      process.env.AGENT_RUNTIME = "claude";
      expect(loadConfig({ dataDir: dir() }).pi).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe("/mcp mount", () => {
  it("only a run token authenticates: a session cookie alone is a 401", async () => {
    const svc = createServices({ dataDir: path.join(dir(), "app"), agentRuntime: "local", sessionSecret: "t" });
    services = svc;
    const agent = request.agent(createApp(svc));
    await signup(agent, "alice").expect(201);
    await agent.get("/api/me").expect(200); // the cookie works for the app…
    const res = await agent
      .post("/mcp/system")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(401); // …but not for the MCP endpoint
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });
});

describe("scripts/pi-register-mcp.mjs", () => {
  it("registers exactly the servers the runner serves", async () => {
    // A non-literal specifier: the .mjs has no type declarations (tsc includes tests).
    const scriptPath = "../scripts/pi-register-mcp.mjs";
    const script = (await import(scriptPath)) as {
      NOAH_MCP_SERVER_NAMES: string[];
      brokerEntry: (name: string, url: string, timeoutSec: number) => unknown;
    };
    expect(script.NOAH_MCP_SERVER_NAMES).toEqual([...PI_MCP_SERVER_NAMES]);
    expect(script.brokerEntry("repo", "http://10.0.0.1:48787/", 600)).toEqual({
      runIn: "broker",
      displayName: "Noah repo",
      transport: {
        type: "http",
        url: "http://10.0.0.1:48787/mcp/repo",
        headers: { Authorization: "Bearer {{ctx.header:x-noah-run-token}}" },
      },
      timeoutSec: 600,
    });
  });
});
