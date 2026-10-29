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
import { PI_RUN_TOKEN_HEADER, piEphemeralRunKey, piRunPrincipal, piRunWorkspace } from "../src/server/agent/pi/piRuntime.js";
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

describe("runPiAgent: formerly read-only run classes (U8)", () => {
  it("runs an avatar consultation in the ASKER's sandbox: ephemeral folder, fresh session, nothing stored", async () => {
    const { store, config, owner, base } = setup();
    const asker = store.createUser({ username: "asker", displayName: "Asker", password: "password123" });
    const { client, requests } = fakeClient([() => textTurn("resp_c1_1", "One answer"), () => textTurn("resp_c2_1", "Again")]);
    const consult = base({
      conversationId: undefined,
      viewerUserId: asker.id,
      viewerName: "Asker",
      viewerIsOwner: false,
      elevated: true,
      headless: true,
      allowHeadlessTools: true,
      avatarConsultation: true,
      cwd: path.join(dir(), "ws-host", `avatar-ask-${asker.id}`),
    });
    const first = await runPiAgent(consult, [], config, store, {}, undefined, { client });
    expect(first.text).toBe("One answer");
    const [req] = requests;
    expect(req!.user).toBe(asker.id);
    expect(req!.previousResponseId).toBeUndefined();
    expect(req!.instructions).toContain(`/workspace/c/run-ask-${owner.id}`);
    expect(req!.instructions).toContain("sandbox of the teammate who asked");
    expect(inputText(req!)).toContain("Run kind (this turn): an automated avatar-to-avatar consultation");
    // The folder exists in the asker's sandbox, not the owner's.
    const ws = piWorkspaceFor(config, asker.id, `run-ask-${owner.id}`);
    expect(fs.statSync(ws.hostConversationDir!).isDirectory()).toBe(true);
    expect(fs.existsSync(piWorkspaceFor(config, owner.id, `run-ask-${owner.id}`).hostConversationDir!)).toBe(false);
    // No conversation: every run is a new session with freshly rendered instructions.
    await runPiAgent(consult, [], config, store, {}, undefined, { client });
    expect(requests[1]!.previousResponseId).toBeUndefined();
    expect(requests[1]!.instructions).toBe(req!.instructions);
  });

  it("runs an untrusted colleague chat in the colleague's own sandbox and says so", async () => {
    const { store, config, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    store.touchConversation(mate.id, "conv-m", base().avatar.id, "hi");
    const { client, requests } = fakeClient([() => textTurn("resp_m1_1", "Hi")]);
    await runPiAgent(
      base({ conversationId: "conv-m", viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false, elevated: false }),
      [],
      config,
      store,
      { steers: new SteerChannel() },
      undefined,
      { client },
    );
    const [req] = requests;
    expect(req!.user).toBe(mate.id);
    expect(req!.instructions).toContain("This sandbox belongs to the person you are talking to, a colleague");
    expect(req!.instructions).toContain("their files, never the owner's");
    expect(req!.instructions).not.toContain("READ-ONLY");
    expect(store.getConversationPiSessionProfile(mate.id, "conv-m", "m1")).toBe("m-opus|");
  });

  it("runs a profile generator in the owner's sandbox with the one-shot run kind", async () => {
    const { store, config, owner, base } = setup();
    const { client, requests } = fakeClient([() => textTurn("resp_g1_1", "#tag")]);
    await runPiAgent(
      base({ conversationId: undefined, headless: true, cwd: path.join(dir(), "ws-host", "hashtags") }),
      [],
      config,
      store,
      {},
      undefined,
      { client },
    );
    const [req] = requests;
    expect(req!.user).toBe(owner.id);
    expect(req!.instructions).toContain("/workspace/c/run-hashtags");
    expect(req!.instructions).toContain("do not create files or run commands");
    expect(inputText(req!)).toContain("Run kind (this turn): an automated one-shot task");
  });
});

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
    // Run-kind guidance (mid-turn messages included) rides the turn input (M2).
    expect(req!.instructions).not.toContain("arrives as the NEXT user turn");
    expect(req!.instructions).not.toContain("[Current date and time");
    expect(inputText(req!)).toMatch(/^\[Current date and time: \d{4}-\d\d-\d\d \d\d:\d\d KST\]/);
    expect(inputText(req!)).toContain("Run kind (this turn): interactive chat");
    expect(inputText(req!)).toContain("arrives as the NEXT user turn");
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

  it("restates a stopped answer only when the turn continues its session (pi does not feed it back)", async () => {
    const { store, config, base } = setup();
    const history = [
      { role: "user" as const, content: "긴 답변을 써 줘" },
      { role: "assistant" as const, content: "chunk0 chunk1" },
    ];
    const continued = fakeClient([() => textTurn("resp_s1_3", "again")]);
    await runPiAgent(
      base({ resumeSessionId: "resp_s1_2", conversationHistory: history, stoppedAnswer: "chunk0 chunk1" }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client: continued.client },
    );
    expect(continued.requests[0]).toMatchObject({ previousResponseId: "resp_s1_2" });
    expect(inputText(continued.requests[0]!)).toContain("the user STOPPED your previous answer partway");
    expect(inputText(continued.requests[0]!)).toContain("<stopped_answer>\nchunk0 chunk1\n</stopped_answer>");

    // Nothing had streamed: say so, quote nothing.
    const empty = fakeClient([() => textTurn("resp_s1_4", "again")]);
    await runPiAgent(base({ resumeSessionId: "resp_s1_3", stoppedAnswer: "" }), [], config, store, undefined, undefined, {
      client: empty.client,
    });
    expect(inputText(empty.requests[0]!)).toContain("nothing of it had reached the user yet");
    expect(inputText(empty.requests[0]!)).not.toContain("<stopped_answer>");

    // A fresh session carries the stopped row in its text history already.
    const fresh = fakeClient([() => textTurn("resp_s5_1", "fresh")]);
    await runPiAgent(base({ conversationHistory: history, stoppedAnswer: "chunk0 chunk1" }), [], config, store, undefined, undefined, {
      client: fresh.client,
    });
    expect(fresh.requests[0]!.previousResponseId).toBeUndefined();
    expect(inputText(fresh.requests[0]!)).not.toContain("STOPPED your previous answer");
    expect(inputText(fresh.requests[0]!)).toContain("chunk0 chunk1");
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

  it("self-heals a session whose pi model was removed (400 model_not_configured), but no other 400", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () =>
        new PiGatewayError("bad_request", {
          status: 400,
          code: "model_not_configured",
          upstreamMessage: "This session's model 'old' is no longer configured. Start a new conversation.",
        }),
      () => textTurn("resp_new_1", "healed"),
    ]);
    const response = await runPiAgent(
      // A rewind onto a row stamped in that session would otherwise fail every time.
      base({ resumeSessionAt: "resp_old_2", conversationHistory: [{ role: "assistant", content: "kept context" }] }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client },
    );
    expect(response.text).toBe("healed");
    expect(requests.map((r) => r.previousResponseId)).toEqual(["resp_old_2", undefined]);
    expect(inputText(requests[1]!)).toContain("kept context");

    const other = fakeClient([() => new PiGatewayError("bad_request", { status: 400, code: "invalid_input" })]);
    await expect(
      runPiAgent(base({ resumeSessionId: "resp_old_2" }), [], config, store, undefined, undefined, { client: other.client }),
    ).rejects.toMatchObject({ kind: "bad_request", code: "invalid_input" });
    expect(other.requests).toHaveLength(1);
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

  it.each([
    ["a routine, then live chat", true],
    ["live chat, then a routine", false],
  ])("one frozen prompt across run kinds, each turn stating its own (%s)", async (_label, routineFirst) => {
    const { store, config, base } = setup();
    const routineReq = base({ headless: true, allowHeadlessTools: true });
    const chatReq = (resume?: string) => base(resume ? { resumeSessionId: resume } : {});
    const { client, requests } = fakeClient([() => textTurn("resp_k_1", "one"), () => textTurn("resp_k_2", "two")]);
    const order = routineFirst ? ["routine", "chat"] : ["chat", "routine"];
    for (const [index, kind] of order.entries()) {
      const resume = index === 0 ? undefined : "resp_k_1";
      const req = kind === "routine" ? { ...routineReq, ...(resume ? { resumeSessionId: resume } : {}) } : chatReq(resume);
      const steerEvents = kind === "chat" ? recorder({ steers: new SteerChannel() }).events : undefined;
      await runPiAgent(req, [], config, store, steerEvents, undefined, { client });
    }
    const [first, second] = requests;
    // The first turn's instructions carry neither run kind's branch.
    expect(first!.instructions).toContain("each turn's input starts with a run-kind note");
    expect(first!.instructions).not.toContain("automated execution");
    expect(first!.instructions).not.toContain("talking to right now");
    // The second turn continues the SAME session, and its input names ITS kind.
    expect(second!.previousResponseId).toBe("resp_k_1");
    expect(second!.instructions).toBeUndefined();
    const [routineText, chatText] = routineFirst
      ? [inputText(first!), inputText(second!)]
      : [inputText(second!), inputText(first!)];
    expect(routineText).toContain("Run kind (this turn): the **automated execution** of a scheduled routine");
    expect(routineText).not.toContain("arrives as the NEXT user turn");
    expect(chatText).toContain("Run kind (this turn): interactive chat");
    expect(chatText).toContain("arrives as the NEXT user turn");
    expect(chatText).not.toContain("do not ask questions");
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
      expect.objectContaining({ text: "First answer", steerPending: true }),
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

describe("piRunPrincipal", () => {
  const base: AgentRequest = {
    message: "m",
    avatar: { id: "owner-1", displayName: "O", alias: "", persona: "" },
    conversationId: "c",
    viewerUserId: "owner-1",
    viewerIsOwner: true,
  };
  // Every run class runs on pi now (U8): the sandbox is whoever the run executes AS.
  it.each([
    ["owner chat", base, "owner-1"],
    ["trusted colleague (principal = viewer)", { ...base, viewerUserId: "mate-1", viewerIsOwner: false, elevated: true }, "mate-1"],
    ["owner routine", { ...base, headless: true, allowHeadlessTools: true }, "owner-1"],
    ["task API turn", { ...base, externalTaskApi: true }, "owner-1"],
    ["untrusted colleague (principal = viewer)", { ...base, viewerUserId: "x", viewerIsOwner: false }, "x"],
    ["consultation (principal = asker)", { ...base, viewerUserId: "asker-1", headless: true, avatarConsultation: true, viewerIsOwner: false, elevated: true }, "asker-1"],
    ["intro/hashtag generator (owner)", { ...base, headless: true }, "owner-1"],
    ["no viewer → the avatar", { ...base, viewerUserId: undefined }, "owner-1"],
  ] as [string, AgentRequest, string][])("%s", (_label, req, principal) => {
    expect(piRunPrincipal(req)).toBe(principal);
  });

  it("refuses an id pi-gateway would reject", () => {
    expect(() => piRunPrincipal({ ...base, viewerUserId: "bad id/../" })).toThrow(/not accepted by pi-gateway/);
  });

  it("keys a conversation-less run's folder by its kind", () => {
    expect(piEphemeralRunKey({ ...base, avatarConsultation: true, cwd: "/data/ws/target/avatar-ask-asker" })).toBe("run-ask-owner-1");
    expect(piEphemeralRunKey({ ...base, cwd: "/data/ws/owner-1/intro" })).toBe("run-intro");
    expect(piEphemeralRunKey({ ...base })).toBe("run-headless");
  });

  it("gives a conversation run a workspace only on pi with a workspaces dir", () => {
    const pi = loadConfig({ dataDir: dir(), agentRuntime: "pi", pi: { ...PI, workspacesDir: path.join(dir(), "ws") } });
    expect(piRunWorkspace(pi, base)?.conversationDir).toBe("/workspace/c/c");
    expect(piRunWorkspace(pi, { ...base, conversationId: undefined })).toBeNull();
    expect(piRunWorkspace(loadConfig({ dataDir: dir(), agentRuntime: "local" }), base)).toBeNull();
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
    expect(pi).not.toContain("arrives as the NEXT user turn");
    const turn = buildPiTurnPreamble(owner, { now: new Date("2026-10-29T00:00:00Z") });
    expect(turn).toContain("[Current date and time: 2026-10-29 09:00 KST]");
    expect(turn).toContain("Conversation rewind (this turn)");
    expect(turn).toContain("submitted by an **EXTERNAL SYSTEM**");
  });
  // Review M2: one conversation mixes routine runs, task-API turns and live
  // chat, while pi freezes the append at the first turn. The frozen text must
  // be the same whichever kind came first; the kind rides each turn's input.
  const shared = {
    message: "m",
    avatar: { id: "o", displayName: "O", alias: "", persona: "" },
    viewerIsOwner: true,
    viewerName: "Ann",
    elevated: true,
    mcpToolGroups: ["system", "git_repo", "avatars"],
    activeRepoName: "notes",
    // Setup complete: the live-chat-only getting-started pitch is a separate,
    // deliberate omission on an unattended first turn.
    gitTokenSet: true,
    knowledgeRepoConfigured: true,
    groupMemberships: [{ id: "g", name: "Team", role: "member", knowledgeRepoConfigured: false, avatarSharing: true }],
    todoState: { deleteEnabled: true },
  } as AgentRequest;
  const facts = (asyncAskAvatar: boolean) => ({
    conversationDir: "/workspace/c/x",
    shellSecretsUnavailable: [],
    asyncAskAvatar,
    activeRepoDir: "/workspace/repos/o/notes",
  });
  const routine: AgentRequest = { ...shared, headless: true, allowHeadlessTools: true, piRuntime: facts(false) };
  const chat: AgentRequest = { ...shared, midTurnMessages: true, piRuntime: facts(true) };
  const api: AgentRequest = { ...shared, externalTaskApi: true, piRuntime: facts(false), todoState: { deleteEnabled: false } };

  it("freezes the same append for a routine, a task-API and an interactive first turn", () => {
    const frozen = buildSystemPromptAppend(routine);
    expect(buildSystemPromptAppend(chat)).toBe(frozen);
    expect(buildSystemPromptAppend(api)).toBe(frozen);
    // No run-kind branch, mid-turn line, background-ask line or open-repo line in it.
    expect(frozen).not.toContain("automated execution");
    expect(frozen).not.toContain("talking to right now");
    expect(frozen).not.toContain("arrives as the NEXT user turn");
    expect(frozen).not.toContain("returns at once with a consultation id");
    expect(frozen).not.toContain("Working repository");
    // It points at the per-turn note instead, and keeps the owner's standing state.
    expect(frozen).toContain("each turn's input starts with a run-kind note");
    expect(frozen).toContain("On a turn that is not a live conversation");
  });

  it("states each turn's run kind, and only that one's guidance, in the turn input", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const routineTurn = buildPiTurnPreamble(routine, { now });
    expect(routineTurn).toContain("Run kind (this turn): the **automated execution** of a scheduled routine");
    expect(routineTurn).toContain("do not ask questions");
    expect(routineTurn).toContain("mcp__system__notify_user");
    expect(routineTurn).not.toContain("arrives as the NEXT user turn");
    expect(routineTurn).not.toContain("returns at once with a consultation id");

    const chatTurn = buildPiTurnPreamble(chat, { now });
    expect(chatTurn).toContain("Run kind (this turn): interactive chat — a person is on the other side of this conversation.");
    expect(chatTurn).toContain("arrives as the NEXT user turn");
    expect(chatTurn).toContain("returns at once with a consultation id");
    expect(chatTurn).not.toContain("do not ask questions");

    const apiTurn = buildPiTurnPreamble(api, { now });
    expect(apiTurn).toContain("Run kind (this turn): an external-system task.");
    expect(apiTurn).toContain("submitted by an **EXTERNAL SYSTEM**");
    expect(apiTurn).not.toContain("automated execution");

    // The open working repo is per turn (L8): every kind names the sandbox copy.
    for (const turn of [routineTurn, chatTurn, apiTurn]) {
      expect(turn).toContain("**Working repository (this turn)**");
      expect(turn).toContain("/workspace/repos/o/notes/");
      expect(turn).toContain("`mcp__system__describe_system` are authoritative");
    }
    expect(buildPiTurnPreamble({ ...chat, activeRepoName: undefined }, { now })).not.toContain("Working repository");
  });

  it("keeps per-turn facts out of the append even without stamped pi facts (no SDK variant)", () => {
    const unstamped = buildSystemPromptAppend(owner);
    expect(unstamped).not.toContain("Conversation rewind (this turn)");
    expect(unstamped).not.toContain("submitted by an **EXTERNAL SYSTEM**");
    expect(unstamped).toContain("sandbox shell receives NO secrets");
    expect(unstamped).not.toContain("exported into your Bash shell");
  });
});

// ---- config, app mount, registration script ----------------------------------------------------

describe("pi config", () => {
  it("parses and validates PI_MODEL_MAP", () => {
    expect(
      parsePiModelMap('{"fable":"m0","opus":"m1","sonnet":{"model":"m2","contextWindow":1000},"haiku":"m3","pinned-id":"m4"}'),
    ).toEqual({
      fable: { model: "m0" },
      opus: { model: "m1" },
      sonnet: { model: "m2", contextWindow: 1000 },
      haiku: { model: "m3" },
      "pinned-id": { model: "m4" },
    });
    // Required, and the ONLY tier → model source: every composer tier must be mapped.
    expect(() => parsePiModelMap("")).toThrow(/requires PI_MODEL_MAP/);
    expect(() => parsePiModelMap('{"opus":"m1"}')).toThrow(/missing: fable, sonnet, haiku/);
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
      delete process.env.PI_MODEL_MAP;
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/requires PI_MODEL_MAP/);
      process.env.PI_MODEL_MAP = '{"fable":"f","opus":"anthropic/claude-opus","sonnet":"s","haiku":"h"}';
      const config = loadConfig({ dataDir: dir() });
      expect(config.agentRuntime).toBe("pi");
      expect(config.pi).toEqual({
        gatewayUrl: "http://pi:8080",
        apiKey: "k",
        workspacesDir: "/srv/pi/workspaces",
        modelMap: { fable: { model: "f" }, opus: { model: "anthropic/claude-opus" }, sonnet: { model: "s" }, haiku: { model: "h" } },
        deckSandbox: true,
      });
      // pi is the default runtime.
      delete process.env.AGENT_RUNTIME;
      expect(loadConfig({ dataDir: dir() }).agentRuntime).toBe("pi");
      process.env.AGENT_RUNTIME = "local";
      expect(loadConfig({ dataDir: dir() }).pi).toBeUndefined();
      // The SDK runner is gone: `claude` stops the boot with the fix named.
      process.env.AGENT_RUNTIME = "claude";
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/AGENT_RUNTIME=claude is no longer supported.*AGENT_RUNTIME=pi/);
      process.env.AGENT_RUNTIME = "sdk";
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/must be "pi" or "local"/);
    } finally {
      process.env = saved;
    }
  });
});

describe("PI_GATEWAY_API_KEY_FILE", () => {
  const MAP = '{"fable":"f","opus":"o","sonnet":"s","haiku":"h"}';
  function withPiEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved = { ...process.env };
    try {
      process.env.AGENT_RUNTIME = "pi";
      process.env.PI_GATEWAY_URL = "http://gateway:8080";
      process.env.PI_MODEL_MAP = MAP;
      delete process.env.PI_GATEWAY_API_KEY;
      delete process.env.PI_GATEWAY_API_KEY_FILE;
      for (const [name, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fn();
    } finally {
      process.env = saved;
    }
  }

  it("reads and trims the key from the file and never puts it in process.env", () => {
    const keyFile = path.join(dir(), "pi_gateway_api_key");
    fs.writeFileSync(keyFile, "  sk-from-file\n", { mode: 0o400 });
    withPiEnv({ PI_GATEWAY_API_KEY_FILE: keyFile }, () => {
      const config = loadConfig({ dataDir: dir() });
      expect(config.pi?.apiKey).toBe("sk-from-file");
      expect(process.env.PI_GATEWAY_API_KEY).toBeUndefined();
      expect(Object.values(process.env)).not.toContain("sk-from-file");
    });
  });

  it("stops the boot when both are set, or the file is unreadable, empty or not one line — without the key in the message", () => {
    const keyFile = path.join(dir(), "key");
    fs.writeFileSync(keyFile, "sk-secret-value");
    withPiEnv({ PI_GATEWAY_API_KEY: "inline", PI_GATEWAY_API_KEY_FILE: keyFile }, () => {
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/PI_GATEWAY_API_KEY or PI_GATEWAY_API_KEY_FILE, not both/);
    });
    const missing = path.join(dir(), "nope");
    withPiEnv({ PI_GATEWAY_API_KEY_FILE: missing }, () => {
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/cannot be read \(ENOENT\)/);
    });
    withPiEnv({ PI_GATEWAY_API_KEY_FILE: dir() }, () => {
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/cannot be read \(EISDIR\)/);
    });
    const empty = path.join(dir(), "empty");
    fs.writeFileSync(empty, " \n\n");
    withPiEnv({ PI_GATEWAY_API_KEY_FILE: empty }, () => {
      expect(() => loadConfig({ dataDir: dir() })).toThrow(/PI_GATEWAY_API_KEY_FILE \(.*\) is empty/);
    });
    const twoLines = path.join(dir(), "two");
    fs.writeFileSync(twoLines, "sk-secret-value\nsecond\n");
    withPiEnv({ PI_GATEWAY_API_KEY_FILE: twoLines }, () => {
      let message = "";
      try {
        loadConfig({ dataDir: dir() });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/alone on one line/);
      expect(message).not.toContain("sk-secret-value");
    });
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
      description: "Personal knowledge repository (git) of notes, skills and the second-brain wiki.",
      transport: {
        type: "http",
        url: "http://10.0.0.1:48787/mcp/repo",
        headers: { Authorization: "Bearer {{ctx.header:x-noah-run-token}}" },
      },
      timeoutSec: 600,
    });
  });
});
