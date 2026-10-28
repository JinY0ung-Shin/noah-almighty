import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvents, QuestionAnswer, QuestionRequest } from "../src/server/agent/events.js";
import {
  PI_TOOL_PRESENTATION,
  PiEventAdapter,
  PiTurnFailedError,
  formatPiQuestionAnswer,
  resolvePiTool,
  runPiTurn,
  summarizePiToolInput,
  type PiTurnOutcome,
} from "../src/server/agent/pi/eventAdapter.js";
import { PiGatewayError, type PiResponseRequest, type PiResponsesClient, type PiStreamEvent } from "../src/server/agent/pi/responsesClient.js";

// Real pi-gateway SSE transcripts captured from an e2e instance (2026-10-29, pi commit 0eab426):
// one `{event, data}` per line, exactly the frames the gateway wrote.
const FIXTURES = path.join(__dirname, "fixtures", "pi-sse");
function fixture(name: string): PiStreamEvent[] {
  return fs
    .readFileSync(path.join(FIXTURES, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string; data: Record<string, unknown> })
    // Capture-script annotations (the cancel HTTP call) are not SSE frames.
    .filter((f) => f.event.startsWith("response."))
    .map((f) => ({ type: f.event, data: f.data }));
}

type Call = [string, unknown];
function recorder(options: { fold?: boolean; answer?: QuestionAnswer } = {}): { events: AgentEvents; calls: Call[] } {
  const calls: Call[] = [];
  const push = (name: string) => (arg: unknown) => void calls.push([name, arg]);
  const events: AgentEvents = {
    onDelta: push("delta"),
    onThinking: push("thinking"),
    onStatus: push("status"),
    onModel: push("model"),
    onSessionId: push("session"),
    onToolStart: push("toolStart"),
    onToolEnd: push("toolEnd"),
    onAgentStart: push("agentStart"),
    onAgentEnd: push("agentEnd"),
    onTurnResult: push("turnResult"),
    ...(options.fold === false ? {} : { onTextFold: push("fold") }),
  };
  if (options.answer) {
    const answer = options.answer;
    events.onQuestion = async (request: QuestionRequest) => {
      calls.push(["question", request]);
      return answer;
    };
  }
  return { events, calls };
}
const only = (calls: Call[], ...names: string[]) => calls.filter(([n]) => names.includes(n));

function feed(adapter: PiEventAdapter, events: PiStreamEvent[]): PiTurnOutcome | null {
  let outcome: PiTurnOutcome | null = null;
  for (const e of events) {
    const result = adapter.handle(e);
    if (result) outcome = result;
  }
  return outcome;
}

/** A PiResponsesClient that replays scripted streams and records requests. */
function fakeClient(streams: PiStreamEvent[][], opts: { holdAfter?: number } = {}) {
  const requests: PiResponseRequest[] = [];
  const cancels: string[] = [];
  let release: (() => void) | undefined;
  const client: PiResponsesClient = {
    async *stream(request, options) {
      requests.push(request);
      const script = streams.shift() ?? [];
      for (let i = 0; i < script.length; i++) {
        if (opts.holdAfter !== undefined && i === opts.holdAfter) {
          // Park until cancel() releases us (pi then ends the turn incomplete) or the stream is aborted.
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            options?.signal?.addEventListener("abort", () => reject(new PiGatewayError("aborted")), { once: true });
          });
        }
        yield script[i]!;
      }
    },
    async cancel(id) {
      cancels.push(id);
      release?.();
      return { status: "cancelling" };
    },
    async listModels() {
      return [];
    },
    async fileContent() {
      return { bytes: Buffer.alloc(0), contentType: "text/plain" };
    },
  };
  return { client, requests, cancels };
}

describe("tool presentation", () => {
  it("maps pi built-ins onto Noah names and unwraps mcp_call", () => {
    expect(resolvePiTool("read", { path: "/workspace/a.txt" })).toEqual({ kind: "tool", name: "Read", input: { path: "/workspace/a.txt" } });
    expect(resolvePiTool("find", { pattern: "*.md" }).name).toBe("Glob");
    expect(resolvePiTool("mcp_call", { name: "mcp__repo__commit", arguments: { message: "m" } })).toEqual({
      kind: "tool",
      name: "mcp__repo__commit",
      input: { message: "m" },
    });
    // arguments as a JSON string (a model that stringified them) still unwraps.
    expect(resolvePiTool("mcp_call", { name: "mcp__todo__add_todos", arguments: '{"items":[{"title":"x"}]}' }).input).toEqual({
      items: [{ title: "x" }],
    });
    // A hidden MCP declaration called directly already is the Noah name.
    expect(resolvePiTool("mcp__web__fetch", { url: "https://x" }).name).toBe("mcp__web__fetch");
    expect(resolvePiTool("AskUserQuestion", {}).kind).toBe("question");
    expect(resolvePiTool("Agent", {}).kind).toBe("agent");
    expect(resolvePiTool("StructuredOutput", {}).kind).toBe("hidden");
    expect(Object.keys(PI_TOOL_PRESENTATION)).toEqual(
      expect.arrayContaining(["read", "write", "edit", "ls", "find", "bash", "grep", "present_file", "AskUserQuestion", "Agent", "SendMessage"]),
    );
  });

  it("summarizes inputs like the SDK path (path-keyed pi tools, shared special cases)", () => {
    expect(summarizePiToolInput("Bash", { command: "ls  -la\n/workspace" })).toBe("ls -la /workspace");
    expect(summarizePiToolInput("Grep", { pattern: "TODO", path: "src" })).toBe("TODO · src");
    expect(summarizePiToolInput("Read", { path: "/workspace/a.txt", offset: 3 })).toBe("/workspace/a.txt");
    expect(summarizePiToolInput("SendMessage", { to: "abc", message: "go on" })).toBe("abc · go on");
    expect(summarizePiToolInput("mcp__todo__add_todos", { items: [{ title: "우유 사기" }] })).toBe("우유 사기");
  });
});

describe("PiEventAdapter on captured transcripts", () => {
  it("a1: plain text turn → deltas, model, committed session id, usage", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events, { contextWindow: 131072 });
    const outcome = feed(adapter, fixture("a1-turn1"));
    expect(outcome?.status).toBe("completed");
    const deltas = only(calls, "delta").map(([, d]) => d).join("");
    expect(adapter.answerText(true)).toBe(deltas);
    expect(only(calls, "model")).toEqual([["model", "fake-model"]]);
    expect(only(calls, "session")).toEqual([["session", outcome!.status === "completed" ? outcome!.responseId : ""]]);
    const turn = only(calls, "turnResult")[0]![1] as { usage?: { inputTokens: number; contextWindow?: number }; backgroundTasks: unknown[] };
    expect(turn.backgroundTasks).toEqual([]);
    if (outcome?.status === "completed" && outcome.usage) {
      expect(outcome.usage.inputTokens).toBeGreaterThanOrEqual(0);
    }
  });

  it("b1: text → bash → text in ONE message item still folds the narration at the tool boundary", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events);
    const outcome = feed(adapter, fixture("b1-bash"));
    expect(outcome?.status).toBe("completed");
    const seq = calls.filter(([n]) => ["delta", "fold", "toolStart", "toolEnd"].includes(n)).map(([n, a]) => [
      n,
      n === "toolStart" ? (a as { name: string }).name : n === "toolEnd" ? (a as { ok: boolean }).ok : a,
    ]);
    expect(seq).toEqual([
      ["delta", "Running a command."],
      ["toolStart", "Bash"],
      ["toolEnd", true],
      // the fold lands BEFORE the new block's first delta
      ["fold", "Running a command."],
      ["delta", "bash done"],
    ]);
    const start = only(calls, "toolStart")[0]![1] as { inputSummary: string; agentId: string };
    expect(start.agentId).toBe("main");
    expect(start.inputSummary.startsWith("id; pwd; hostname;")).toBe(true);
    expect(adapter.answerText(true)).toBe("bash done");
  });

  it("b1 without a fold sink keeps the legacy full join", () => {
    const { events } = recorder({ fold: false });
    const adapter = new PiEventAdapter(events);
    feed(adapter, fixture("b1-bash"));
    expect(adapter.answerText(true)).toBe("Running a command.\n\nbash done");
  });

  it("d1: mcp_search + mcp_call rows show the real MCP names; image results stay ok", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events);
    feed(adapter, fixture("d1-mcp"));
    const starts = only(calls, "toolStart").map(([, a]) => a as { name: string; inputSummary: string });
    expect(starts.map((s) => s.name)).toEqual(["McpSearch", "mcp__noahtest__whoami", "mcp__noahtest__image"]);
    expect(starts[0]!.inputSummary).toBe("whoami token");
    expect(only(calls, "toolEnd").map(([, a]) => (a as { ok: boolean }).ok)).toEqual([true, true, true]);
    expect(adapter.answerText(true)).toBe("mcp done");
  });

  it("d2: a failing tool reports ok=false", () => {
    const { events, calls } = recorder();
    feed(new PiEventAdapter(events), fixture("d2-mcp-no-header"));
    expect(only(calls, "toolEnd")).toEqual([["toolEnd", { toolUseId: "call_16_0", ok: false }]]);
  });

  it("g1: reasoning streams once (summary/text duplicates dropped), MCP progress becomes status", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events);
    feed(adapter, fixture("g1-reasoning-progress"));
    expect(only(calls, "thinking")).toEqual([["thinking", "Thinking about the slow tool."]]);
    const statuses = only(calls, "status").map(([, s]) => s as string);
    expect(statuses).toContain("실행 중: slow — 1/3s");
    expect(statuses).toContain("실행 중: slow — 3/3s");
    expect(adapter.answerText(true)).toBe("slow finished");
  });

  it("f1: present_file → a PresentFile row and an onPresentedFile item", () => {
    const { events, calls } = recorder();
    const files: unknown[] = [];
    const adapter = new PiEventAdapter(events, { onPresentedFile: (f) => files.push(f) });
    feed(adapter, fixture("f1-present-file"));
    expect(only(calls, "toolStart").map(([, a]) => (a as { name: string }).name)).toEqual(["Bash", "PresentFile"]);
    expect(files).toEqual([{ path: "/workspace/c/conv1/report.md", filename: "report.md", mimeType: "text/markdown", size: 5 }]);
    expect(adapter.answerText(true)).toBe("Here it is.");
  });

  it("e1: a cancelled text turn keeps its partial text (the incomplete close is not a retry discard)", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events);
    const outcome = feed(adapter, fixture("e1-cancel-text"));
    expect(outcome).toMatchObject({ status: "incomplete", reason: "user_cancelled" });
    expect(only(calls, "fold")).toEqual([]);
    expect(adapter.answerText(true)).toBe("one two");
    expect(only(calls, "session")).toHaveLength(1);
    expect((only(calls, "turnResult")[0]![1] as { errorSubtype?: string }).errorSubtype).toBeUndefined();
  });

  it("e3: a cancelled bash ends its row failed", () => {
    const { events, calls } = recorder();
    const outcome = feed(new PiEventAdapter(events), fixture("e3-cancel-bash"));
    expect(outcome?.status).toBe("incomplete");
    expect(only(calls, "toolEnd")).toEqual([["toolEnd", { toolUseId: "call_20_0", ok: false }]]);
  });

  it("c1: AskUserQuestion → requires_action with the parsed question, no row, no session id", () => {
    const { events, calls } = recorder();
    const outcome = feed(new PiEventAdapter(events), fixture("c1-ask"));
    expect(outcome?.status).toBe("requires_action");
    if (outcome?.status !== "requires_action") return;
    expect(outcome.question.callId).toBe("call_ask_1");
    expect(outcome.question.name).toBe("AskUserQuestion");
    expect(outcome.question.questions).toEqual([
      expect.objectContaining({ question: "Which color do you want?", header: "Color" }),
    ]);
    expect(only(calls, "toolStart", "session", "turnResult")).toEqual([]);
  });

  it("every captured transcript ends in exactly one terminal outcome", () => {
    for (const file of fs.readdirSync(FIXTURES).filter((f) => f.endsWith(".ndjson"))) {
      const adapter = new PiEventAdapter(recorder().events);
      const outcomes = fixture(file.replace(/\.ndjson$/, ""))
        .map((e) => adapter.handle(e))
        .filter(Boolean);
      expect(outcomes, file).toHaveLength(1);
    }
  });
});

describe("PiEventAdapter edge semantics (synthetic frames per pi api/mapper.ts)", () => {
  const ev = (type: string, data: Record<string, unknown> = {}): PiStreamEvent => ({ type, data: { type, ...data } });
  const created = ev("response.created", { response: { id: "resp_s_1", model: "m" } });
  const msgAdded = (id: string) => ev("response.output_item.added", { item: { id, type: "message", status: "in_progress" } });
  const msgDone = (id: string, status: string) => ev("response.output_item.done", { item: { id, type: "message", status } });
  const delta = (id: string, text: string) => ev("response.output_text.delta", { item_id: id, delta: text });

  it("a retried attempt's message (incomplete close followed by more output) leaves the answer", () => {
    const { events, calls } = recorder();
    const adapter = new PiEventAdapter(events);
    feed(adapter, [
      created,
      msgAdded("msg_1"),
      delta("msg_1", "half an ans"),
      msgDone("msg_1", "incomplete"),
      msgAdded("msg_2"),
      delta("msg_2", "The full answer."),
      msgDone("msg_2", "completed"),
      ev("response.completed", { response: { id: "resp_s_1", status: "completed", usage: { output_tokens: 3 } } }),
    ]);
    expect(only(calls, "fold")).toEqual([["fold", "half an ans"]]);
    expect(adapter.answerText(true)).toBe("The full answer.");
  });

  it("without a fold sink the discarded attempt still drops from the final text", () => {
    const { events } = recorder({ fold: false });
    const adapter = new PiEventAdapter(events);
    feed(adapter, [
      created,
      msgAdded("msg_1"),
      delta("msg_1", "half"),
      msgDone("msg_1", "incomplete"),
      msgAdded("msg_2"),
      delta("msg_2", "full"),
      ev("response.completed", { response: { id: "resp_s_1", status: "completed" } }),
    ]);
    expect(adapter.answerText(true)).toBe("full");
  });

  it("a retry keeps the item's text from EARLIER model calls (before the last tool result), like pi's discardAttempt", () => {
    // pi keeps ONE message item across tool calls; the failed model call is
    // the one after the last tool result, so only ITS text leaves the answer.
    const toolUse = ev("response.tool_use", { tool_use_id: "t1", name: "bash", input: { command: "ls" } });
    const toolResult = ev("response.tool_result", { tool_use_id: "t1", is_error: false });
    for (const fold of [false, true]) {
      const { events, calls } = recorder({ fold });
      const adapter = new PiEventAdapter(events);
      feed(adapter, [
        created,
        msgAdded("msg_1"),
        delta("msg_1", "Looking first."),
        toolUse,
        toolResult,
        delta("msg_1", "half an ans"),
        msgDone("msg_1", "incomplete"),
        msgAdded("msg_2"),
        delta("msg_2", "The full answer."),
        msgDone("msg_2", "completed"),
        ev("response.completed", { response: { id: "resp_s_1", status: "completed" } }),
      ]);
      if (fold) {
        expect(only(calls, "fold")).toEqual([["fold", "Looking first."], ["fold", "half an ans"]]);
        expect(adapter.answerText(true)).toBe("The full answer.");
      } else {
        expect(adapter.answerText(true)).toBe("Looking first.\n\nThe full answer.");
      }
    }
  });

  it("usage: context_tokens is the snapshot, output accumulates, no snapshot → no window", () => {
    const withCtx = new PiEventAdapter(recorder().events, { contextWindow: 200_000 });
    const a = withCtx.handle(
      ev("response.completed", {
        response: {
          id: "resp_s_1",
          status: "completed",
          usage: { input_tokens: 5000, output_tokens: 40, input_tokens_details: { cached_tokens: 4000, cache_creation_tokens: 0, context_tokens: 1800 } },
        },
      }),
    );
    expect(a).toMatchObject({ usage: { inputTokens: 1800, outputTokens: 40, contextWindow: 200_000 } });
    const noCtx = new PiEventAdapter(recorder().events, { contextWindow: 200_000 });
    const b = noCtx.handle(
      ev("response.completed", { response: { id: "resp_s_1", status: "completed", usage: { input_tokens: 5000, output_tokens: 40 } } }),
    );
    expect(b).toMatchObject({ usage: { inputTokens: 0, outputTokens: 40 } });
    expect((b as { usage: { contextWindow?: number } }).usage.contextWindow).toBeUndefined();
  });

  it("incomplete reasons map onto SDK-style error subtypes", () => {
    const { events, calls } = recorder();
    const outcome = new PiEventAdapter(events).handle(
      ev("response.incomplete", { response: { id: "resp_s_1", status: "incomplete", incomplete_details: { reason: "max_tool_calls" } } }),
    );
    expect(outcome).toMatchObject({ status: "incomplete", reason: "max_tool_calls" });
    expect((only(calls, "turnResult")[0]![1] as { errorSubtype?: string }).errorSubtype).toBe("error_max_turns");
  });

  it("Agent spawns render as agent cards", () => {
    const { events, calls } = recorder();
    feed(new PiEventAdapter(events), [
      created,
      ev("response.tool_use_started", { tool_use_id: "t1", name: "Agent" }),
      ev("response.tool_use", { tool_use_id: "t1", name: "Agent", input: { description: "look around", prompt: "p", subagent_type: "general-purpose" } }),
      ev("response.tool_result", { tool_use_id: "t1", content: "done", is_error: false }),
    ]);
    expect(only(calls, "agentStart", "agentEnd", "toolStart")).toEqual([
      ["agentStart", { agentId: "t1", parentId: "main", subagentType: "general-purpose", description: "look around" }],
      ["agentEnd", { agentId: "t1", ok: true }],
    ]);
  });

  it("failed turns carry the in-band error and never report a session id", () => {
    const { events, calls } = recorder();
    const outcome = new PiEventAdapter(events).handle(
      ev("response.failed", { response: { id: "resp_s_1", status: "failed", error: { code: "rate_limit", message: "429 too many" } } }),
    );
    expect(outcome).toEqual({ status: "failed", responseId: "resp_s_1", error: { code: "rate_limit", message: "429 too many" } });
    expect(only(calls, "session")).toEqual([]);
  });
});

describe("runPiTurn", () => {
  const request: PiResponseRequest = {
    user: "u1",
    input: { kind: "prompt", text: "pick a color" },
    instructions: "sys",
    headers: { "x-noah-run-token": "nrt_x" },
    metadata: { conversation: "c1" },
  };

  it("loops AskUserQuestion through onQuestion and continues the same bubble (c1 → c2)", async () => {
    const { client, requests } = fakeClient([fixture("c1-ask"), fixture("c2-answer")]);
    const { events, calls } = recorder({ answer: { behavior: "completed", result: { answers: { "Which color do you want?": "Blue" } } } });
    const result = await runPiTurn({ client, request, events });
    expect(result.status).toBe("completed");
    expect(result.text).toBe("You picked blue, noted.");
    expect(result.responseId).toBe("resp_72e8b3c4-5a3d-4234-85ff-def19550df43_2");
    const question = only(calls, "question")[0]![1] as QuestionRequest;
    expect(question.dialogKind).toBe("AskUserQuestion");
    expect(question.toolUseId).toBe("call_ask_1");
    expect(requests[1]).toEqual({
      user: "u1",
      previousResponseId: "resp_72e8b3c4-5a3d-4234-85ff-def19550df43_1",
      input: {
        kind: "answer",
        callId: "call_ask_1",
        output: 'The user answered the question(s) as follows:\n- "Which color do you want?" → Blue',
      },
      metadata: { conversation: "c1" },
      headers: { "x-noah-run-token": "nrt_x" },
    });
    // only the committed final response becomes the resume point
    expect(only(calls, "session")).toEqual([["session", "resp_72e8b3c4-5a3d-4234-85ff-def19550df43_2"]]);
    expect(only(calls, "fold")).toEqual([["fold", "Let me ask."]]);
  });

  it("answers for a headless run (no onQuestion) without blocking", async () => {
    const { client, requests } = fakeClient([fixture("c1-ask"), fixture("c2-answer")]);
    const { events } = recorder();
    await runPiTurn({ client, request, events });
    const answer = requests[1]!.input as { output: string };
    expect(answer.output).toContain("cannot ask the user questions");
  });

  it("throws PiTurnFailedError (status-classified) on an in-band failure", async () => {
    const failed: PiStreamEvent = {
      type: "response.failed",
      data: { response: { id: "resp_f_1", status: "failed", error: { code: "rate_limit", message: "429: slow down" } } },
    };
    const { client } = fakeClient([[failed]]);
    const err = await runPiTurn({ client, request }).catch((e) => e);
    expect(err).toBeInstanceOf(PiTurnFailedError);
    expect(err.status).toBe(429);
    expect(err.upstreamMessage).toBe("429: slow down");
  });

  it("errors on a stream that ends without a terminal event", async () => {
    const { client } = fakeClient([fixture("a1-turn1").slice(0, 3)]);
    const err = await runPiTurn({ client, request }).catch((e) => e);
    expect(err).toBeInstanceOf(PiGatewayError);
    expect(err.kind).toBe("protocol");
  });

  it("abort → cancel the live response, keep pi's committed partial, then throw aborted", async () => {
    const script = fixture("e1-cancel-text");
    const holdAfter = script.findIndex((e) => e.type === "response.output_item.done");
    const { client, cancels } = fakeClient([script], { holdAfter });
    const { events, calls } = recorder();
    const controller = new AbortController();
    const run = runPiTurn({ client, request, events, signal: controller.signal, cancelGraceMs: 2_000 });
    await expect.poll(() => only(calls, "delta").length).toBe(2);
    controller.abort();
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(PiGatewayError);
    expect(err.kind).toBe("aborted");
    expect(cancels).toEqual(["resp_2b5c0aab-a22f-4557-9150-c52b9940be86_1"]);
    expect(only(calls, "session")).toEqual([["session", "resp_2b5c0aab-a22f-4557-9150-c52b9940be86_1"]]);
  });

  it("abort with no graceful end cuts the stream after the grace period", async () => {
    const script = fixture("a1-turn1");
    const { client } = fakeClient([script], { holdAfter: 2 });
    // cancel() releasing the hold would finish the turn; make it a no-op instead.
    client.cancel = async () => ({ status: "cancelling" });
    const controller = new AbortController();
    const run = runPiTurn({ client, request, signal: controller.signal, cancelGraceMs: 20 });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const err = await run.catch((e) => e);
    expect(err.kind).toBe("aborted");
  });

  it("formats dismissed and empty answers for the model", () => {
    expect(formatPiQuestionAnswer({ behavior: "cancelled" })).toContain("dismissed");
    expect(formatPiQuestionAnswer({ behavior: "completed", result: {} })).toBe("The user provided an answer.");
    expect(formatPiQuestionAnswer({ behavior: "completed", result: { answers: { Q: ["a", "b"] } } })).toContain('"Q" → a, b');
  });
});
