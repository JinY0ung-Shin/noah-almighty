/**
 * The pi runner (lane I1): `runPiAgent` against a scripted fake pi client, the
 * run-class decision, the HTTP MCP endpoint as pi's broker sees it, config and
 * the registration script's server list. The fake client replaces the network;
 * everything Noah-side (store, capability plan, MCP servers, router) is real.
 */
import { execFileSync, spawn } from "node:child_process";
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
import { loadConfig } from "../src/server/config.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";
import type { AgentRequest, PiRuntimeConfig } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { McpRunRegistry, createMcpHttpRouter } from "../src/server/mcpHttp/endpoint.js";
import { PI_MCP_SERVER_NAMES } from "../src/server/agent/pi/mcpCatalog.js";
import {
  PI_CONSULTATION_PRINCIPAL_PATTERN,
  PI_RUN_TOKEN_HEADER,
  beginPiConsultationSandbox,
  piEphemeralRunKey,
  piRunPrincipal,
  piRunWorkspace,
  piServicesFor,
  sweepPiConsultationSandboxes,
} from "../src/server/agent/pi/piRuntime.js";
import { askAvatar } from "../src/server/agent/avatarAsk.js";
import { PI_NO_ASK_USER_SENTENCE, piSandboxOwnerSentence } from "../src/server/agent/ownerState.js";
import { isPiResponseId, runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import { piConversationSegment, piHostPath, piUserKey, piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { PiGatewayError, type PiResponseRequest, type PiResponsesClient, type PiStreamEvent } from "../src/server/agent/pi/responsesClient.js";
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { gitInit, makeBareRemote, withTempDir, signup } from "./helpers.js";

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
  // The models the fake pi-gateway offers (`GET /v1/models`).
  piServicesFor(store, config).models = createPiModelCatalog({
    listModels: async () => [{ id: "m-opus" }, { id: "m-sonnet" }],
  });
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

describe("runPiAgent: run classes and their sandboxes (U8, P1)", () => {
  it("runs each avatar consultation in a FRESH, EMPTY sandbox of its own, gated as before, and removes it afterwards", async () => {
    const { store, config, owner } = setup();
    // owner = the CONSULTED avatar (C), asker = the asking avatar's owner (A).
    const asker = store.createUser({ username: "asker", displayName: "Asker", password: "password123" });
    const group = store.createGroup({ name: "Team", createdBy: null });
    store.addGroupMember(group.id, owner.id, "member");
    store.addGroupMember(group.id, asker.id, "member");
    // C's knowledge: a real vault the recall tools clone and search.
    const seed = path.join(dir(), "kb-seed");
    gitInit(seed);
    fs.mkdirSync(path.join(seed, "wiki"), { recursive: true });
    fs.writeFileSync(path.join(seed, "wiki", "release.md"), "---\ntitle: Release policy\n---\nReleases ship every Tuesday after the freeze.\n");
    const remote = makeBareRemote(path.join(dir(), "kb.git"));
    const git = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    git("add", "-A");
    git("commit", "-q", "-m", "kb");
    git("branch", "-M", "main");
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "main");
    store.setKnowledgeRepo(owner.id, remote, "main");
    // Both users' own sandboxes hold files the consultation must never see or touch.
    const ownFile = (userId: string) => {
      const file = path.join(piWorkspaceFor(config, userId, "conv-x").hostConversationDir!, "attachments", "private.txt");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${userId} only`);
      return file;
    };
    const askerFile = ownFile(asker.id);
    const ownerFile = ownFile(owner.id);
    const workspacesDir = config.pi!.workspacesDir!;
    const rootsBefore = fs.readdirSync(workspacesDir).sort();

    const registry = new McpRunRegistry();
    const app = express();
    app.use(express.json());
    app.use(createMcpHttpRouter({ registry }));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const connect = async (name: string, token: string) => {
      const mcp = new Client({ name: "broker", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp/${name}`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
      );
      return mcp;
    };
    const seen: Record<string, unknown> = {};
    const step = async (req: PiResponseRequest) => {
      const root = path.join(workspacesDir, piUserKey(req.user));
      seen.during = { exists: fs.existsSync(root), entries: fs.readdirSync(root).sort(), runDir: fs.readdirSync(path.join(root, "c")) };
      const token = req.headers![PI_RUN_TOKEN_HEADER]!;
      const [brain, todo, repo, system] = await Promise.all(["brain", "todo", "repo", "system"].map((name) => connect(name, token)));
      seen.recall = await brain.callTool({ name: "search", arguments: { query: "release" } });
      seen.todo = await todo.callTool({ name: "list_todos", arguments: {} });
      seen.write = await repo.callTool({ name: "write_file", arguments: { path: "x.md", content: "x" } });
      seen.describe = await system.callTool({ name: "describe_system", arguments: {} });
      await Promise.all([brain.close(), todo.close(), repo.close(), system.close()]);
      return textTurn(`resp_c${requests.length}_1`, "Releases ship every Tuesday.");
    };
    const { client, requests } = fakeClient([step, step]);
    const run: typeof runPiAgent = (request, roots, cfg, st, events, abort) =>
      runPiAgent(request, roots, cfg, st, events, abort, { client, registry });
    try {
      const outcome = await askAvatar(store, config, { askerUserId: asker.id, askerName: "Asker", targetUsername: "owner", question: "When do releases ship?" }, { run, loadRoots: async () => [] });
      expect(outcome).toMatchObject({ ok: true, answer: "Releases ship every Tuesday." });
      // A second consultation gets ANOTHER fresh sandbox.
      await askAvatar(store, config, { askerUserId: asker.id, askerName: "Asker", targetUsername: "owner", question: "Again?" }, { run, loadRoots: async () => [] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const [first, second] = requests;
    expect(first!.user).toMatch(/^consult-[0-9a-f]{24}$/);
    expect(second!.user).toMatch(/^consult-[0-9a-f]{24}$/);
    expect(second!.user).not.toBe(first!.user);
    expect([asker.id, owner.id]).not.toContain(first!.user);
    // While it ran: a new root holding only the run folder (and the skill index dir).
    expect(seen.during).toMatchObject({ exists: true, runDir: ["run-ask"] });
    expect((seen.during as { entries: string[] }).entries.every((name) => ["c", ".noah"].includes(name))).toBe(true);
    expect(first!.previousResponseId).toBeUndefined();
    // Nothing of anyone's is in that sandbox: the consultation keeps the full built-ins.
    expect(first!.readOnly).toBeUndefined();
    expect(first!.instructions).toContain("Work in this run's folder `/workspace/c/run-ask`");
    expect(first!.instructions).toContain(piSandboxOwnerSentence("nobody"));
    expect(first!.instructions).not.toContain("THIS user's Linux sandbox");
    expect(inputText(first!)).toContain("Run kind (this turn): an automated avatar-to-avatar consultation");
    // Nobody can answer a consultation: its session has no AskUserQuestion, and both surfaces say so.
    expect(first!.interactive).toBe(false);
    expect(inputText(first!)).toContain(PI_NO_ASK_USER_SENTENCE);
    // Gates unchanged: C's knowledge stays readable, owner-only tools refuse.
    expect(seen.recall).not.toMatchObject({ isError: true });
    expect(JSON.stringify(seen.recall)).toContain("wiki/release.md");
    expect(seen.todo).toMatchObject({ isError: true });
    expect(seen.write).toMatchObject({ isError: true });
    const describeText = JSON.stringify(seen.describe);
    expect(describeText).toContain("You run in a temporary Linux sandbox made for this one run");
    expect(describeText).toContain("owned by nobody");
    expect(describeText).toContain(PI_NO_ASK_USER_SENTENCE);
    // Afterwards: both consultation roots are gone, nothing else changed.
    expect(fs.readdirSync(workspacesDir).sort()).toEqual(rootsBefore);
    expect(fs.readFileSync(askerFile, "utf8")).toBe(`${asker.id} only`);
    expect(fs.readFileSync(ownerFile, "utf8")).toBe(`${owner.id} only`);
    expect(fs.readdirSync(path.join(config.dataDir, "pi-consultation-sandboxes"))).toEqual([]);
    expect(registry.size).toBe(0);
  });

  it("refuses to run a consultation in a user's sandbox, and the boot sweeps a crashed one", () => {
    const { config } = setup();
    expect(() => piRunPrincipal({ viewerUserId: "asker-1", avatarConsultation: true, avatar: { id: "owner-1" } })).toThrow(/own fresh sandbox/);
    const principal = beginPiConsultationSandbox(config);
    expect(principal).toMatch(PI_CONSULTATION_PRINCIPAL_PATTERN);
    const ws = piWorkspaceFor(config, principal, "run-ask");
    fs.mkdirSync(path.join(ws.hostConversationDir!, "junk"), { recursive: true });
    // A link the sandbox planted is removed, never followed.
    const outside = path.join(dir(), "outside.txt");
    fs.writeFileSync(outside, "keep");
    fs.symlinkSync(outside, path.join(ws.hostRoot!, "link"));
    expect(sweepPiConsultationSandboxes(config)).toBe(1);
    expect(fs.existsSync(ws.hostRoot!)).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(sweepPiConsultationSandboxes(config)).toBe(0);
  });

  it("runs a colleague chat in the colleague's own sandbox as a read_only pi session, and says so", async () => {
    const { store, config, base } = setup();
    const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    store.touchConversation(mate.id, "conv-m", base().avatar.id, "hi");
    const { client, requests } = fakeClient([() => textTurn("resp_m1_1", "Hi"), () => textTurn("resp_m1_2", "Again")]);
    const turn = (resumeSessionId?: string) =>
      runPiAgent(
        base({ conversationId: "conv-m", viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false, elevated: true, resumeSessionId }),
        [],
        config,
        store,
        { steers: new SteerChannel() },
        undefined,
        { client },
      );
    await turn();
    const [req] = requests;
    expect(req!.user).toBe(mate.id);
    // A trusted colleague too: someone else's avatar never gets write/edit/bash in the colleague's sandbox.
    expect(req!.readOnly).toBe(true);
    // A person is on the other side: pi's default (interactive) session.
    expect(req!.interactive).toBeUndefined();
    expect(inputText(req!)).not.toContain(PI_NO_ASK_USER_SENTENCE);
    expect(req!.instructions).toContain("This sandbox belongs to the person you are talking to, a colleague");
    expect(req!.instructions).toContain("this session is READ-ONLY there");
    expect(req!.instructions).toContain("Built-in tools (read-only): `read` (files and images), `ls`/`find`/`grep` (explore).");
    expect(req!.instructions).not.toContain("`bash` (run programs");
    // The continued session already is read_only; only a new session carries the flag.
    await turn("resp_m1_1");
    expect(requests[1]!.previousResponseId).toBe("resp_m1_1");
    expect(requests[1]!.readOnly).toBeUndefined();
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
    expect(req!.readOnly).toBeUndefined();
    expect(req!.interactive).toBe(false);
    expect(inputText(req!)).toContain(PI_NO_ASK_USER_SENTENCE);
    expect(req!.instructions).toContain("/workspace/c/run-hashtags");
    expect(req!.instructions).toContain("do not create files or run commands");
    expect(inputText(req!)).toContain("Run kind (this turn): an automated one-shot task");
  });

  it("starts a routine's session interactive: false, but never a task-API turn's or a continued one", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => textTurn("resp_r1_1", "Done"),
      () => textTurn("resp_t1_1", "Done"),
      () => textTurn("resp_t1_2", "Done"),
    ]);
    // A scheduled routine (scheduler.ts): headless, owner tools, no events but onDelta.
    await runPiAgent(base({ headless: true, allowHeadlessTools: true }), [], config, store, { onDelta: () => {} }, undefined, { client });
    expect(requests[0]!.interactive).toBe(false);
    expect(inputText(requests[0]!)).toContain("Run kind (this turn): the **automated execution** of a scheduled routine task");
    expect(inputText(requests[0]!)).toContain(PI_NO_ASK_USER_SENTENCE);
    // The external task API: the key holder answers questions through /respond.
    const apiTurn = (resumeSessionId?: string) =>
      runPiAgent(base({ externalTaskApi: true, resumeSessionId }), [], config, store, { onQuestion: async () => ({ behavior: "cancelled" }) }, undefined, { client });
    await apiTurn();
    expect(requests[1]!.previousResponseId).toBeUndefined();
    expect(requests[1]!.interactive).toBeUndefined();
    expect(inputText(requests[1]!)).not.toContain(PI_NO_ASK_USER_SENTENCE);
    await apiTurn("resp_t1_1");
    expect(requests[2]!.previousResponseId).toBe("resp_t1_1");
    expect(requests[2]!.interactive).toBeUndefined();
  });
});

describe("runPiAgent", () => {
  it("first turn: frozen instructions, no pick → pi's default model (no model, no context window), session id doubles as the resume point", async () => {
    const { store, config, owner, base } = setup();
    const { client, requests } = fakeClient([() => textTurn("resp_s1_1", "Hello!")]);
    const { events, calls } = recorder({ steers: new SteerChannel() });
    const response = await runPiAgent(base(), [], config, store, events, new AbortController(), { client });

    expect(response).toMatchObject({ runtime: "pi", text: "Hello!" });
    expect(response.usage).toMatchObject({ outputTokens: 7 });
    expect(response.usage).not.toHaveProperty("contextWindow");
    const [req] = requests;
    expect(req!.user).toBe(owner.id);
    expect(req!.model).toBeUndefined();
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
    // Frozen per conversation (D2).
    expect(store.ensureConversationPiInstructions(owner.id, "conv-1", () => "never")).toBe(req!.instructions);
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

  it("a model/effort change continues the same session with the new settings; 기본 모델 is named by pi's default id", async () => {
    const { store, config, base } = setup();
    piServicesFor(store, config).models = createPiModelCatalog({
      listModels: async () => [{ id: "m-opus", default: true }, { id: "m-sonnet" }],
    });
    await piServicesFor(store, config).models.list();
    const { client, requests } = fakeClient([() => textTurn("resp_s1_5", "switched"), () => textTurn("resp_s1_6", "default")]);
    const { events, calls } = recorder();
    const history = [
      { role: "user" as const, content: "q1" },
      { role: "assistant" as const, content: "a1 from opus" },
    ];
    await runPiAgent(
      base({ model: "m-sonnet", effort: "low", resumeSessionId: "resp_s1_4", conversationHistory: history }),
      [],
      config,
      store,
      events,
      undefined,
      { client },
    );
    expect(requests[0]).toMatchObject({ previousResponseId: "resp_s1_4", model: "m-sonnet", reasoningEffort: "low" });
    expect(requests[0]!.instructions).toBeUndefined();
    expect(inputText(requests[0]!)).not.toContain("Session note");
    expect(inputText(requests[0]!)).not.toContain("a1 from opus");
    expect(of(calls, "status").filter((line) => String(line).includes("세션"))).toEqual([]);
    // No pick on a continuing turn: omitting `model` would keep the session's, so pi's default is sent by id.
    await runPiAgent(base({ resumeSessionId: "resp_s1_5", conversationHistory: history }), [], config, store, undefined, undefined, { client });
    expect(requests[1]).toMatchObject({ previousResponseId: "resp_s1_5", model: "m-opus" });
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

  it("retries an empty turn (empty_response) ONCE on the same previous_response_id", async () => {
    const { store, config, base } = setup();
    const empty = (id: string, before: PiStreamEvent[] = []): PiStreamEvent[] => [
      ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } }),
      ...before,
      ev("response.failed", { response: { id, status: "failed", error: { code: "empty_response", message: "No response generated" } } }),
    ];
    // Retried once: the same request again, and the run completes.
    const once = fakeClient([() => empty("resp_e_2"), () => textTurn("resp_e_3", "Here it is")]);
    const { events, calls } = recorder();
    const response = await runPiAgent(base({ resumeSessionId: "resp_e_1" }), [], config, store, events, undefined, { client: once.client });
    expect(response.text).toBe("Here it is");
    expect(once.requests).toHaveLength(2);
    expect(once.requests[1]).toEqual(once.requests[0]);
    expect(once.requests[1]!.previousResponseId).toBe("resp_e_1");
    expect(of(calls, "status")).toContain("모델이 빈 응답을 보내 한 번 더 시도하는 중…");
    expect(of(calls, "session")).toEqual(["resp_e_3"]);

    // Only once: a second empty turn fails the run.
    const twice = fakeClient([() => empty("resp_e_2"), () => empty("resp_e_3")]);
    await expect(
      runPiAgent(base({ resumeSessionId: "resp_e_1" }), [], config, store, undefined, undefined, { client: twice.client }),
    ).rejects.toMatchObject({ name: "PiTurnFailedError", code: "empty_response" });
    expect(twice.requests).toHaveLength(2);

    // Never once text reached the user…
    const shown = fakeClient([
      () => empty("resp_e_2", [ev("response.output_item.added", { item: { type: "message", id: "m" } }), ev("response.output_text.delta", { delta: "Par" })]),
    ]);
    await expect(
      runPiAgent(base({ resumeSessionId: "resp_e_1" }), [], config, store, recorder().events, undefined, { client: shown.client }),
    ).rejects.toMatchObject({ code: "empty_response" });
    expect(shown.requests).toHaveLength(1);

    // A steer queued during the empty turn does not stop the retry: it waits
    // and follows as its own turn on the retried answer (review-2 L2).
    const steers = new SteerChannel();
    const steered = fakeClient([
      () => {
        steers.push("are you there?");
        return empty("resp_e_2");
      },
      () => textTurn("resp_e_3", "Here it is"),
      () => textTurn("resp_e_4", "Yes, still here"),
    ]);
    const steeredRun = await runPiAgent(base({ resumeSessionId: "resp_e_1" }), [], config, store, recorder({ steers }).events, undefined, {
      client: steered.client,
    });
    expect(steeredRun.text).toBe("Yes, still here");
    expect(steered.requests.map((r) => r.previousResponseId)).toEqual(["resp_e_1", "resp_e_1", "resp_e_3"]);
    expect(inputText(steered.requests[1]!)).toBe(inputText(steered.requests[0]!));
    expect(inputText(steered.requests[2]!)).toContain("are you there?");
    expect(steers.records().map((r) => r.state)).toEqual(["completed"]);

    // …or for a steer follow-up turn.
    const followSteers = new SteerChannel();
    const follow = fakeClient([
      () => {
        followSteers.push("one more thing");
        return textTurn("resp_e_2", "First");
      },
      () => empty("resp_e_3"),
    ]);
    await expect(
      runPiAgent(base({ resumeSessionId: "resp_e_1" }), [], config, store, recorder({ steers: followSteers }).events, undefined, {
        client: follow.client,
      }),
    ).rejects.toMatchObject({ code: "empty_response" });
    expect(follow.requests).toHaveLength(2);
  });

  it("falls back once onto pi-gateway's default model with a fresh session", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
      () => textTurn("resp_f_1", "from the default"),
    ]);
    const response = await runPiAgent(
      base({ headless: true, allowHeadlessTools: true, modelFallback: true, model: "m-opus" }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client, retry: { attempts: 1 } },
    );
    expect(response.text).toBe("from the default");
    expect(requests.map((r) => r.model)).toEqual(["m-opus", undefined]);
    expect(requests.every((r) => r.instructions && !r.previousResponseId)).toBe(true);
  });

  it("a fallback on a continuing turn stays in the session when pi's default can be named, else starts a new one", async () => {
    const { store, config, base } = setup();
    const turn = async (models: { id: string; default?: true }[]) => {
      piServicesFor(store, config).models = createPiModelCatalog({ listModels: async () => models });
      const { client, requests } = fakeClient([
        () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
        () => textTurn("resp_f_2", "from the default"),
      ]);
      await runPiAgent(
        base({ headless: true, allowHeadlessTools: true, modelFallback: true, model: "m-sonnet", resumeSessionId: "resp_f_1" }),
        [],
        config,
        store,
        undefined,
        undefined,
        { client, retry: { attempts: 1 } },
      );
      return requests;
    };
    const named = await turn([{ id: "m-opus", default: true }, { id: "m-sonnet" }]);
    expect(named.map((r) => [r.model, r.previousResponseId])).toEqual([
      ["m-sonnet", "resp_f_1"],
      ["m-opus", "resp_f_1"],
    ]);
    const unnamed = await turn([{ id: "m-opus" }, { id: "m-sonnet" }]);
    expect(unnamed.map((r) => [r.model, r.previousResponseId])).toEqual([
      ["m-sonnet", "resp_f_1"],
      [undefined, undefined],
    ]);
  });

  it("never falls back onto the model it just failed on: a run already on pi's default gets one attempt", async () => {
    const { store, config, base } = setup();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
      () => textTurn("resp_d_1", "same default model again"),
    ]);
    const outcome = await runPiAgent(
      // A legacy tier alias pi does not offer reads as the default.
      base({ headless: true, allowHeadlessTools: true, modelFallback: true, model: "opus" }),
      [],
      config,
      store,
      undefined,
      undefined,
      { client, retry: { attempts: 1 } },
    ).catch((error: unknown) => error);
    expect(requests.map((r) => r.model)).toEqual([undefined]);
    expect(outcome).toBeInstanceOf(Error);
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
    ["intro/hashtag generator (owner)", { ...base, headless: true }, "owner-1"],
    ["no viewer → the avatar", { ...base, viewerUserId: undefined }, "owner-1"],
  ] as [string, AgentRequest, string][])("%s", (_label, req, principal) => {
    expect(piRunPrincipal(req)).toBe(principal);
  });

  it("refuses an id pi-gateway would reject", () => {
    expect(() => piRunPrincipal({ ...base, viewerUserId: "bad id/../" })).toThrow(/not accepted by pi-gateway/);
  });

  it("keys a conversation-less run's folder by its kind", () => {
    expect(piEphemeralRunKey({ ...base, avatarConsultation: true, cwd: "/data/ws/target/avatar-ask-asker" })).toBe("run-ask");
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
    const pi = buildSystemPromptAppend({ ...owner, piRuntime: { conversationDir: "/workspace/c/x", readOnlyBuiltins: false, shellSecretNames: ["API_TOKEN"] } });
    expect(pi).toContain("Runtime: your own pi sandbox");
    expect(pi).not.toContain("Conversation rewind (this turn)");
    expect(pi).not.toContain("submitted by an **EXTERNAL SYSTEM**");
    expect(pi).toContain("`API_TOKEN` is set to 셸 노출 and present as `$NAME` environment variables in every `bash` command of this run");
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
    groupMemberships: [{ id: "g", name: "Team", role: "member", avatarSharing: true }],
    todoState: { deleteEnabled: true },
  } as AgentRequest;
  const facts = (asyncAskAvatar: boolean) => ({
    conversationDir: "/workspace/c/x",
    shellSecretNames: [],
    readOnlyBuiltins: false,
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
    expect(unstamped).toContain("`API_TOKEN` is set to 셸 노출 but NOT in the shell");
    expect(unstamped).not.toContain("exported into your Bash shell");
  });
});

// ---- config, app mount, registration script ----------------------------------------------------

describe("pi config", () => {
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
      // A leftover PI_MODEL_MAP — even a malformed one — no longer affects the config.
      process.env.PI_MODEL_MAP = "{oops";
      const config = loadConfig({ dataDir: dir() });
      expect(config.agentRuntime).toBe("pi");
      expect(config.pi).toEqual({
        gatewayUrl: "http://pi:8080",
        apiKey: "k",
        workspacesDir: "/srv/pi/workspaces",
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
  function withPiEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved = { ...process.env };
    try {
      process.env.AGENT_RUNTIME = "pi";
      process.env.PI_GATEWAY_URL = "http://gateway:8080";
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

  it("deletes this Noah's entry under a retired id on a normal run, and leaves a foreign one alone", async () => {
    const noahUrl = "http://10.0.0.1:48787";
    const calls: string[] = [];
    const servers = [
      { config: { id: "group_brain", transport: { type: "http", url: `${noahUrl}/mcp/group_brain` } } },
    ];
    const fake = http.createServer((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      res.end(req.method === "GET" ? JSON.stringify({ servers }) : "{}");
    });
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const gateway = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const run = (extra: string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/pi-register-mcp.mjs", "--gateway", gateway, "--noah-url", noahUrl, ...extra], {
          env: { ...process.env, PI_GATEWAY_ADMIN_KEY: "k" },
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (out += d));
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
      });
    try {
      const dry = await run(["--dry-run"]);
      expect(dry).toContain("would DELETE group_brain (retired)");
      expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

      await run([]);
      expect(calls).toContain("DELETE /admin/api/mcp/servers/group_brain");
      // Never re-registered.
      expect(calls).not.toContain("PUT /admin/api/mcp/servers/group_brain");

      // An entry under that id pointing somewhere else is not this Noah's: untouched.
      calls.length = 0;
      servers[0]!.config.transport.url = "http://elsewhere/mcp/group_brain";
      await run([]);
      expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });
});
