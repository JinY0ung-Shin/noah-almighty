import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type {
  AgentEvents,
} from "../src/server/agent/events.js";
import type { AgentRequest, AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Partially mock the Claude Agent SDK: keep tool()/createSdkMcpServer() and
// everything else REAL (the in-process MCP servers build against them at
// registration time), replacing only `query` with a per-test scriptable fake.
// The fake records a SNAPSHOT of each call's `options` — the real run loop
// mutates the single `options` object in place across attempts (resume/model),
// so a live reference would read the post-mutation state.
// ---------------------------------------------------------------------------
type QueryArgs = { prompt: unknown; options: Record<string, unknown> };
type QueryHandle = AsyncIterable<unknown> & {
  getContextUsage?: () => Promise<{ totalTokens?: number; maxTokens?: number } | undefined>;
};

const sdkMock = vi.hoisted(() => ({
  impl: null as null | ((args: QueryArgs) => QueryHandle),
  calls: [] as { prompt: unknown; options: Record<string, unknown> }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: QueryArgs) => {
      sdkMock.calls.push({ prompt: args.prompt, options: { ...args.options } });
      if (!sdkMock.impl) {
        throw new Error("sdkMock.impl not programmed for this test");
      }
      return sdkMock.impl(args);
    },
  };
});

// ---------------------------------------------------------------------------
// Turn ON the opt-in SDK tool-call trace for this file. `TOOL_TRACE_ENABLED`
// (agentUtils) reads AGENT_TOOL_TRACE ONCE at module load, so the flag has to be
// set before any import — hence vi.hoisted. Every run-loop test in this file
// then exercises the trace path with real message shapes, and the tracing suite
// below asserts what it emits. Cleared in afterAll so the flag can't ride along
// into another test file sharing this worker process.
// ---------------------------------------------------------------------------
vi.hoisted(() => {
  process.env.AGENT_TOOL_TRACE = "1";
});
afterAll(() => {
  delete process.env.AGENT_TOOL_TRACE;
});

// The trace's only observable output is its logger, so capture the ONE child
// logger sdkMessageHandlers binds (`trace: "tool"`). Every other child — the
// PreToolUse hook's included — stays the real, test-silent pino instance.
const traceLog = vi.hoisted(() => {
  const entries: { payload: Record<string, unknown>; msg: string }[] = [];
  const record = (payload?: unknown, msg?: string) => {
    entries.push({
      payload: (typeof payload === "object" && payload ? payload : {}) as Record<string, unknown>,
      msg: typeof payload === "string" ? payload : (msg ?? ""),
    });
  };
  const child: Record<string, unknown> = { child: () => child };
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    child[level] = record;
  }
  return { entries, child };
});

vi.mock("../src/server/logger.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.default as { child: (bindings: Record<string, unknown>) => unknown };
  const realChild = real.child.bind(real);
  return {
    ...actual,
    default: Object.assign(Object.create(real as object), {
      child: (bindings: Record<string, unknown>) =>
        bindings?.trace === "tool" ? traceLog.child : realChild(bindings),
    }),
  };
});

import { createServices } from "../src/server/app.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../src/server/store.js";
import { runAgentStream } from "../src/server/agent/index.js";
import {
  buildImageQueryPrompt,
  runClaudeAgent,
  resultErrorMessage,
} from "../src/server/agent/claudeAgent.js";
import { DEFAULT_MODEL_TIER } from "../src/server/modelTiers.js";
import {
  attachRunClient,
  awaitResponse,
  cancelAllRuns,
  cancelRun,
  CANCELLED,
  closeRun,
  emitRunEvent,
  getActiveRun,
  getActiveRunForConversation,
  isRunCancelled,
  openRun,
  submitResponse,
} from "../src/server/agent/runRegistry.js";
import {
  createLoopState,
  dispatchSdkMessage,
  traceSdkMessage,
} from "../src/server/agent/sdkMessageHandlers.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";

// ---------------------------------------------------------------------------
// SDK-message + query-handle builders (shapes copied from sdkMessageHandlers /
// agent-core fixtures).
// ---------------------------------------------------------------------------
const initMsg = (sessionId = "sess-1", model = "opus") => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
});
const startMsg = (usage: Record<string, number>) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "message_start", message: { usage } },
});
const deltaMsg = (text: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const thinkingMsg = (thinking: string) => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});
const textBlock = (text: string) => ({ type: "text", text });
const toolUseBlock = (id: string, name: string, input: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const assistantMsg = (content: unknown[], usage?: Record<string, number>) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content, ...(usage ? { usage } : {}) },
});
const toolResultMsg = (toolUseId: string, isError = false) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError }] },
});
const successResult = (result: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  result,
  ...extra,
});
/**
 * The CLI's report on a mid-turn message we wrote to its stdin. `started` is
 * the ONLY delivery signal — a folded steer is never echoed back as a stream
 * `user` message.
 */
const lifecycleMsg = (commandUuid: string, state: string) => ({
  type: "command_lifecycle",
  command_uuid: commandUuid,
  state,
});

/** A query handle that yields a fixed message list, optionally with a getContextUsage control method. */
function handleFrom(
  messages: unknown[],
  opts: { getContextUsage?: QueryHandle["getContextUsage"] } = {},
): QueryHandle {
  async function* gen() {
    for (const message of messages) {
      yield message;
    }
  }
  const handle = gen() as QueryHandle;
  if (opts.getContextUsage) {
    handle.getContextUsage = opts.getContextUsage;
  }
  return handle;
}

/**
 * Read the single user message's text block off a generator prompt (streaming
 * turns pass the held-open generator; safe to consume after the run — its gate
 * is released on attempt exit, and the mock never consumes the prompt itself).
 */
async function promptTextOf(prompt: unknown): Promise<string> {
  const gen = prompt as AsyncGenerator<Record<string, unknown>>;
  const first = await gen.next();
  const message = (
    first.value as { message?: { content?: Array<{ type?: string; text?: string }> } }
  ).message;
  return message?.content?.find((block) => block.type === "text")?.text ?? "";
}

/** A query handle that throws on iteration (optionally aborting a controller first). */
function throwingHandle(error: unknown, opts: { abort?: AbortController } = {}): QueryHandle {
  async function* gen() {
    if (opts.abort) {
      opts.abort.abort();
    }
    throw error;
  }
  return gen() as QueryHandle;
}

/** Events sink of vi.fn spies; pass overrides to add optional callbacks (e.g. onCanvas). */
function makeEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
  return {
    onDelta: vi.fn(),
    onThinking: vi.fn(),
    onThinkingReset: vi.fn(),
    onStatus: vi.fn(),
    onModel: vi.fn(),
    onSessionId: vi.fn(),
    onPlugin: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskUpdate: vi.fn(),
    onTaskEnd: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentEnd: vi.fn(),
    onBlocked: vi.fn(),
    onPlan: vi.fn(),
    ...overrides,
  };
}

let tempDir: string;
const getTempDir = withTempDir("agent-run", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
  sdkMock.impl = null;
});

/** Fresh services + an owner user + a realistic owner AgentRequest, over the per-test temp dir. */
function setup(configOverrides: Partial<AppConfig> = {}) {
  const { config, store } = createServices({
    dataDir: tempDir,
    agentRuntime: "claude",
    sessionSecret: "test",
    // Neutralize any ANTHROPIC_MODEL/API key from the dev machine's env so model
    // resolution is deterministic (env pin would otherwise win over the tier).
    anthropicModel: undefined,
    anthropicApiKey: undefined,
    ...configOverrides,
  });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const cwd = path.join(tempDir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const baseRequest: AgentRequest = {
    message: "안녕하세요",
    avatar: { id: owner.id, displayName: "Owner", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    autoApprove: true,
  };
  return { config, store, owner, baseRequest };
}

// ===========================================================================
// runClaudeAgent orchestration (real run loop against the scripted SDK)
// ===========================================================================
describe("runClaudeAgent orchestration (SDK mocked)", () => {
  it("retains system tools when an old admin policy blocks every optional group", async () => {
    const { config, store, baseRequest } = setup();
    vi.spyOn(store, "allowedMcpToolGroupsForUser").mockReturnValue([]);
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    const { options } = sdkMock.calls[0];
    const servers = options.mcpServers as Record<string, unknown>;
    expect(servers.system).toBeDefined();
    expect(servers.web).toBeUndefined();
    expect(servers.git_repo).toBeUndefined();
    expect(options.allowedTools).toContain("mcp__system__read_manual");
    expect(options.allowedTools).toContain("mcp__system__describe_system");
    expect((options.systemPrompt as { append: string }).append).toContain("System tools are always available");
  });

  it.each([true, false])("always registers system tools regardless of saved selection (selected=%s)", async (enabled) => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);
    await runAgentStream({ ...baseRequest, mcpToolGroups: enabled ? ["system"] : [] }, [], config, store, makeEvents());
    const { options } = sdkMock.calls[0];
    const allowed = options.allowedTools as string[];
    const servers = options.mcpServers as Record<string, unknown>;
    const prompt = options.systemPrompt as { append: string };
    expect(allowed).toContain("mcp__system__read_manual");
    expect(servers.system).toBeDefined();
    expect(prompt.append).toContain("mcp__system__read_manual");
    expect(prompt.append).toContain("external-tasks: External Task API integration");
  });

  it("streams session id, model, and deltas, then maps the result + getContextUsage occupancy", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom(
        [
          initMsg("sess-happy", "claude-opus-4-8"),
          startMsg({ input_tokens: 1000, cache_read_input_tokens: 2000 }),
          deltaMsg("Hello "),
          deltaMsg("world"),
          assistantMsg([textBlock("Hello world")], { input_tokens: 10, output_tokens: 5 }),
          successResult("Hello world", {
            usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: 3000 },
            modelUsage: { "claude-opus-4-8": { contextWindow: 200000 } },
          }),
        ],
        { getContextUsage: async () => ({ totalTokens: 4200, maxTokens: 200000 }) },
      );

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(events.onSessionId).toHaveBeenCalledWith("sess-happy");
    expect(events.onModel).toHaveBeenCalledWith("claude-opus-4-8");
    expect(events.onDelta).toHaveBeenCalledWith("Hello ");
    expect(events.onDelta).toHaveBeenCalledWith("world");

    expect(response.kind).toBe("text");
    expect(response.runtime).toBe("claude");
    expect(response.summary).toBe("Claude Agent SDK 실행이 완료되었습니다.");
    // Assistant text block wins over the terminal result string (identical here).
    expect(response.text).toBe("Hello world");
    // getContextUsage supersedes the scraped snapshot AND the cumulative result input.
    expect(response.usage).toEqual({
      inputTokens: 4200,
      outputTokens: 20,
      contextWindow: 200000,
    });
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("wires the SDK options: preset system prompt, hook, strict MCP, disallowed tools, default model", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    expect(options.permissionMode).toBe("default");
    expect(options.strictMcpConfig).toBe(true);
    expect(options.skills).toBe("all");
    expect(options.settingSources).toEqual([]);
    expect(options.maxTurns).toBe(config.maxTurns);
    expect(options.cwd).toBe(baseRequest.cwd);
    expect(options.model).toBe(DEFAULT_MODEL_TIER);
    expect(options.disallowedTools).toContain("Monitor");
    // Agent teams: SendMessage stays advertised (auto-allowed) and the CLI
    // feature flag rides in the subprocess env.
    expect(options.disallowedTools).not.toContain("SendMessage");
    expect(options.allowedTools).toContain("SendMessage");
    // ultracode: Workflow stays advertised (auto-allowed) too, so the keyword
    // trigger has a live tool to switch the turn into.
    expect(options.disallowedTools).not.toContain("Workflow");
    expect(options.allowedTools).toContain("Workflow");
    expect(
      (options.env as Record<string, string | undefined>)
        .CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
    ).toBe("1");
    expect(options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
    });
    expect(typeof (options.systemPrompt as { append?: unknown }).append).toBe("string");
    // Events present → the PreToolUse hook is registered (the real permission gate).
    const hooks = options.hooks as { PreToolUse?: unknown[] } | undefined;
    expect(Array.isArray(hooks?.PreToolUse)).toBe(true);
    expect(hooks?.PreToolUse).toHaveLength(1);
    // All tool groups on (default) for a plain owner with no repo/groups/ssh/canvas.
    const serverNames = Object.keys(options.mcpServers as Record<string, unknown>);
    expect(serverNames).toEqual(
      expect.arrayContaining(["knowledge", "repo", "system", "confluence", "avatars", "git_repo"]),
    );
    expect(serverNames).not.toContain("canvas");
    expect(serverNames).not.toContain("brain");
    expect(serverNames).not.toContain("group_repo");
    expect(serverNames).not.toContain("ssh_trust");
    // No extra writable dirs (empty plugin roots, no additionalDirs).
    expect(options.additionalDirectories).toBeUndefined();
  });

  it("pre-allows the gated built-ins by rule exactly when the hook would blanket-allow them", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Owner live chat (elevated + autoApprove): the gated built-ins ride
    // allowedTools so they never enter the CLI's cancellable ask path — 2.1.222
    // cancels it in turns where a queued task-notification arrived and words
    // the cancellation as a user refusal (the silent auto-deny flake).
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    const allowed = sdkMock.calls[0].options.allowedTools as string[];
    expect(allowed).toEqual(
      expect.arrayContaining(["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"]),
    );
    // The hook intercepts AskUserQuestion (deny-carrying-answer) — a rule
    // allowing it would still be overridden, but it must never be listed.
    expect(allowed).not.toContain("AskUserQuestion");

    // Colleague (not elevated): the hook denies these tools, so no rule may allow them.
    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[1].options.allowedTools as string[]).not.toContain("Bash");

    // Restricted headless run (no allowHeadlessTools): read-only, same rule.
    await runAgentStream({ ...baseRequest, headless: true }, [], config, store, makeEvents());
    expect(sdkMock.calls[2].options.allowedTools as string[]).not.toContain("Bash");

    // Owner routine that opted into headless tools (scheduler: autoApprove) keeps the rule.
    await runAgentStream(
      { ...baseRequest, headless: true, allowHeadlessTools: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[3].options.allowedTools as string[]).toContain("Bash");

    // Elevated but NOT autoApprove: the interactive permission prompt is the
    // gate, so the ask path must stay live and no rule may pre-allow.
    await runAgentStream({ ...baseRequest, autoApprove: false }, [], config, store, makeEvents());
    expect(sdkMock.calls[4].options.allowedTools as string[]).not.toContain("Bash");
  });

  it("admin agent-teams toggle turns off the CLI flag AND the SendMessage tool", async () => {
    const { config, store, baseRequest } = setup();
    store.setToolSkillPolicy({ disabledTools: ["SendMessage"], disabledSkills: [] });
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    expect(
      (options.env as Record<string, string | undefined>)
        .CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS,
    ).toBe("0");
    expect(options.disallowedTools).toContain("SendMessage");
  });

  it("plumbs the model tier, effort, and MCP tool-group selection into the query options", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg("s", "sonnet"), successResult("ok")]);

    await runAgentStream(
      { ...baseRequest, modelTier: "sonnet", effort: "high", mcpToolGroups: ["system"] },
      [],
      config,
      store,
      events,
    );

    const { options } = sdkMock.calls[0];
    expect(options.model).toBe("sonnet");
    expect(options.effort).toBe("high");
    // Only the `system` group enabled → only the system server registers from
    // the tool-group families. `personal_agent` rides alongside it: like the
    // group agent's self-config server it belongs to no family, and this owner
    // is an admin on an interactive run, so create_agent is available.
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual([
      "system",
      "personal_agent",
    ]);
  });

  it("withholds bot creation/hand-off from a turn the external task API submitted", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Control: the same owner run, typed in the chat, registers both tools.
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    const interactive = sdkMock.calls[0].options;
    expect(interactive.allowedTools as string[]).toContain(
      "mcp__personal_agent__create_agent",
    );
    expect(interactive.allowedTools as string[]).toContain(
      "mcp__personal_agent__delegate_to_bot",
    );

    // An external system's instruction is still a FULL owner run, but standing
    // up (or handing work to) a bot is a decision the owner makes in
    // conversation — the same exclusion an unattended routine already gets.
    await runAgentStream(
      { ...baseRequest, externalTaskApi: true },
      [],
      config,
      store,
      makeEvents(),
    );
    const external = sdkMock.calls[1].options;
    expect(external.allowedTools as string[]).not.toContain(
      "mcp__personal_agent__create_agent",
    );
    expect(external.allowedTools as string[]).not.toContain(
      "mcp__personal_agent__delegate_to_bot",
    );
    const externalServers = Object.keys(
      external.mcpServers as Record<string, unknown>,
    );
    expect(externalServers).not.toContain("personal_agent");
    // Owner capability is otherwise untouched — this is not a downgrade.
    expect(externalServers).toContain("system");
    expect(externalServers).toContain("repo");

    // Both metacognition halves follow the tool: the prompt states the
    // provenance and drops the create trigger it can no longer act on.
    const externalPrompt = JSON.stringify(external.systemPrompt);
    expect(externalPrompt).toContain("EXTERNAL SYSTEM");
    expect(externalPrompt).not.toContain("mcp__personal_agent__create_agent");
    expect(JSON.stringify(interactive.systemPrompt)).toContain(
      "mcp__personal_agent__create_agent",
    );
    expect(JSON.stringify(interactive.systemPrompt)).not.toContain(
      "EXTERNAL SYSTEM",
    );
  });

  it("registers the brain + canvas servers when a repo is connected and canvas is enabled", async () => {
    const { config, store, baseRequest, owner } = setup();
    store.setKnowledgeRepo(owner.id, "owner/kb", "main");
    store.updateProfile(owner.id, { experimentalFeatures: ["canvas"] });
    const events = makeEvents({ onCanvas: vi.fn(async () => ({ behavior: "shown" as const })) });
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const serverNames = Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>);
    // repoConfigured + elevated → second brain; canvas feature + onCanvas sink → canvas.
    expect(serverNames).toContain("brain");
    expect(serverNames).toContain("canvas");
    expect(serverNames).toContain("repo");
  });

  it("registers file_output only when an interactive file sink is present", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);
    const onFile = vi.fn(async () => ({
      behavior: "shown" as const,
      attachment: { id: "out-1", kind: "image" as const, mediaType: "image/png" as const },
      url: "/api/conversations/c1/images/out-1",
    }));

    await runAgentStream(baseRequest, [], config, store, makeEvents({ onFile }));

    const options = sdkMock.calls[0].options;
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toContain("file_output");
    expect(options.allowedTools as string[]).toContain("mcp__file_output__show_file");
    expect(options.allowedTools as string[]).toContain("mcp__file_output__share_file");
    expect(JSON.stringify(options.systemPrompt)).toContain("mcp__file_output__show_file");
  });

  it("registers the group repo + group brain servers when the owner belongs to a group with a shared repo", async () => {
    const { config, store, baseRequest, owner } = setup();
    const group = store.createGroup({ name: "팀" });
    store.addGroupMember(group.id, owner.id, "admin");
    store.setGroupKnowledgeRepo(group.id, "team/kb", "main");
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const serverNames = Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>);
    // owner in ≥1 group → group_repo; the group has a connected repo → group_brain.
    expect(serverNames).toContain("group_repo");
    expect(serverNames).toContain("group_brain");
  });

  it("allows ask_avatar ONLY on owner-driven runs and never inside a consultation", async () => {
    const { config, store, baseRequest, owner } = setup();
    const group = store.createGroup({ name: "팀" });
    store.addGroupMember(group.id, owner.id, "member");
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Owner chat with a group → the consultation tool is allow-listed.
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    expect(sdkMock.calls[0].options.allowedTools as string[]).toContain(
      "mcp__avatars__ask_avatar",
    );

    // A consultation run must never re-register it (the depth guard)...
    await runAgentStream(
      { ...baseRequest, avatarConsultation: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[1].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );

    // ...nor a teammate turn (not owner-driven)...
    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[2].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );

    // ...nor a restricted headless run (intro/hashtag generation).
    await runAgentStream(
      { ...baseRequest, headless: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(sdkMock.calls[3].options.allowedTools as string[]).not.toContain(
      "mcp__avatars__ask_avatar",
    );
  });

  it("keeps ask_avatar out when the owner belongs to no group (no reachable target)", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, makeEvents());

    const allowedTools = sdkMock.calls[0].options.allowedTools as string[];
    expect(allowedTools).not.toContain("mcp__avatars__ask_avatar");
    // The discovery tool itself stays available.
    expect(allowedTools).toContain("mcp__avatars__search_avatars");
  });

  it("suppresses plugin MCP servers for consultation runs (registration is their only gate)", async () => {
    const { config, store, baseRequest } = setup();
    const rootDir = path.join(tempDir, "consult-plugin-root");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { corp: { command: "node", args: ["server.js"] } } }),
    );
    const roots = [{ type: "local" as const, path: rootDir }];
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    // Control: a normal owner run lifts the plugin server.
    await runAgentStream(baseRequest, roots, config, store, makeEvents());
    expect(
      Object.keys(sdkMock.calls[0].options.mcpServers as Record<string, unknown>),
    ).toContain("corp");

    // A consultation run (trusted-colleague viewer class) gets NO plugin servers.
    await runAgentStream(
      {
        ...baseRequest,
        avatarConsultation: true,
        viewerUserId: "asker-id",
        viewerIsOwner: false,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
      },
      roots,
      config,
      store,
      makeEvents(),
    );
    expect(
      Object.keys(sdkMock.calls[1].options.mcpServers as Record<string, unknown>),
    ).not.toContain("corp");
  });

  it("emits tool / progress / blocked activity events across the run loop", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        assistantMsg([toolUseBlock("t1", "Bash", { command: "ls" })]),
        { type: "tool_progress", tool_name: "Bash" },
        toolResultMsg("t1"),
        {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Edit",
          tool_use_id: "t2",
          agent_id: "main",
          decision_reason: "read-only",
        },
        assistantMsg([textBlock("done")]),
        successResult("done"),
      ]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(events.onToolStart).toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: "t1", name: "Bash", agentId: "main", inputSummary: "ls" }),
    );
    expect(events.onToolEnd).toHaveBeenCalledWith({ toolUseId: "t1", ok: true });
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("실행 중"));
    expect(events.onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "Edit", toolUseId: "t2", reason: "read-only" }),
    );
    expect(response.text).toBe("done");
  });

  it("falls back to the scraped context snapshot when getContextUsage throws", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom(
        [
          initMsg(),
          startMsg({ input_tokens: 3000, cache_read_input_tokens: 1000 }), // snapshot = 4000
          deltaMsg("x"),
          assistantMsg([textBlock("x")]), // no usage → does not override the snapshot
          successResult("x", {
            usage: { input_tokens: 100, output_tokens: 10 },
            modelUsage: { opus: { contextWindow: 200000 } },
          }),
        ],
        {
          getContextUsage: async () => {
            throw new Error("session closing");
          },
        },
      );

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(response.usage).toEqual({ inputTokens: 4000, outputTokens: 10, contextWindow: 200000 });
  });

  // A tool round between two text blocks is the shape that used to grow the
  // bubble without bound: the narration before the tool call is now demoted to
  // the reasoning view and only the LAST block stays the answer.
  const foldStream = [
    initMsg(),
    deltaMsg("A"),
    assistantMsg([textBlock("A"), toolUseBlock("t1", "Read", { file_path: "a.ts" })]),
    toolResultMsg("t1"),
    deltaMsg("B"),
    assistantMsg([textBlock("B")]),
    successResult("B"),
  ];

  it("folds the superseded text block into onTextFold and answers with the last one", async () => {
    const { config, store, baseRequest } = setup();
    const onTextFold = vi.fn();
    const events = makeEvents({ onTextFold });
    sdkMock.impl = () => handleFrom(foldStream);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // The first block's own deltas must not re-fold it; only block B's first delta does.
    expect(onTextFold.mock.calls).toEqual([["A"]]);
    expect(response.text).toBe("B");
  });

  it("emits the fold BEFORE the new block's first delta", async () => {
    const { config, store, baseRequest } = setup();
    // Wire order the chat-route/client sinks assume: `text_fold` arrives ahead
    // of the new block's first chunk. Folding after dispatch put the fold
    // BEHIND that chunk, so the sinks (foldedTextOffset / liveText → thinking)
    // swept it into the reasoning view and clipped the head off every
    // post-fold block — live and, on the cancel/error paths, persisted.
    const order: string[] = [];
    const events = makeEvents({
      onDelta: (text) => order.push(`delta:${text}`),
      onTextFold: (text) => order.push(`fold:${text}`),
    });
    sdkMock.impl = () => handleFrom(foldStream);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(order).toEqual(["delta:A", "fold:A", "delta:B"]);
    expect(response.text).toBe("B");
  });

  it("keeps the legacy full join when the run has no onTextFold sink", async () => {
    const { config, store, baseRequest } = setup();
    // Same stream, sink without onTextFold → the documented no-sink contract:
    // headless runs behave exactly as before the fold existed.
    const events = makeEvents();
    sdkMock.impl = () => handleFrom(foldStream);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(response.text).toBe("A\n\nB");
  });

  it("sweeps at the result boundary for a backend that streams no text deltas", async () => {
    const { config, store, baseRequest } = setup();
    const onTextFold = vi.fn();
    const onTurnResult = vi.fn();
    const events = makeEvents({ onTextFold, onTurnResult });
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        assistantMsg([textBlock("첫 설명")]),
        assistantMsg([textBlock("두번째 설명")]),
        assistantMsg([textBlock("최종")]),
        successResult("최종"),
      ]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // No delta ever arrived, so the keepLast sweep is what folds — in one call,
    // and the boundary segment carries the tail only.
    expect(onTextFold.mock.calls).toEqual([["첫 설명\n\n두번째 설명"]]);
    expect(onTurnResult).toHaveBeenCalledWith(expect.objectContaining({ text: "최종" }));
    expect(response.text).toBe("최종");
  });

  it("runs non-streaming (no events) via extractMainAssistantText + the finalizeTurnUsage fallback", async () => {
    const { config, store, baseRequest } = setup();
    // No getContextUsage attached, and no events sink → control method never called.
    sdkMock.impl = () =>
      handleFrom([
        assistantMsg([textBlock("direct answer")], { input_tokens: 1000, cache_read_input_tokens: 500 }),
        successResult("direct answer", {
          usage: { input_tokens: 2000, output_tokens: 50, cache_read_input_tokens: 8000 },
          modelUsage: { opus: { contextWindow: 200000 } },
        }),
      ]);

    const response = await runClaudeAgent(baseRequest, [], config, store);

    expect(response.text).toBe("direct answer");
    // Snapshot (1500) replaces the cumulative result input (10000); output preserved.
    expect(response.usage).toEqual({ inputTokens: 1500, outputTokens: 50, contextWindow: 200000 });
  });

  it("self-heals a missing resume session by re-running without resume and injecting stored history", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      resumeSessionId: "sess-old",
      conversationHistory: [
        { role: "user", content: "이전 질문" },
        { role: "assistant", content: "이전 답변" },
      ],
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return throwingHandle(new Error("No conversation found with session ID sess-old"));
      }
      return handleFrom([initMsg("sess-new"), successResult("resumed ok")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    // First attempt carried resume; the self-heal dropped it for the retry.
    expect(sdkMock.calls[0].options.resume).toBe("sess-old");
    expect(sdkMock.calls[1].options.resume).toBeUndefined();
    // The retry's prompt (streaming → held-open generator) now carries the
    // stored history in its single user message.
    const retryPrompt = await promptTextOf(sdkMock.calls[1].prompt);
    expect(retryPrompt).toContain("Earlier conversation history");
    expect(retryPrompt).toContain("이전 질문");
    expect(response.text).toBe("resumed ok");
  });

  it("does NOT self-heal a missing resume when the run was aborted (propagates the error)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const abort = new AbortController();
    const request: AgentRequest = { ...baseRequest, resumeSessionId: "sess-old" };
    sdkMock.impl = () =>
      throwingHandle(new Error("No conversation found with session ID sess-old"), { abort });

    await expect(runAgentStream(request, [], config, store, events, abort)).rejects.toThrow(
      /no conversation found/i,
    );
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("retries down the model fallback chain on a transient error (scheduled routine)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
      modelTier: "opus",
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        // Anthropic-style numeric status → retryable via the status branch.
        return throwingHandle(Object.assign(new Error("upstream hiccup"), { status: 503 }));
      }
      return handleFrom([initMsg("s2", "sonnet"), successResult("fell back")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    expect(sdkMock.calls[0].options.model).toBe("opus");
    expect(sdkMock.calls[1].options.model).toBe("sonnet");
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("sonnet"));
    expect(response.text).toBe("fell back");
  });

  it("falls back from an admin-override (non-tier) model on a transient message-matched error", async () => {
    const { config, store, baseRequest } = setup();
    store.setModelOverride("noah-custom-model"); // concrete id, not a tier alias
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
    };
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return throwingHandle(new Error("Error: overloaded_error, please retry"));
      }
      return handleFrom([initMsg("s2", "sonnet"), successResult("recovered on sonnet")]);
    };

    const response = await runAgentStream(request, [], config, store, events);

    // Non-tier primary → chain is [primary, sonnet, haiku]; first retry lands on sonnet.
    expect(sdkMock.calls[0].options.model).toBe("noah-custom-model");
    expect(sdkMock.calls[1].options.model).toBe("sonnet");
    expect(response.text).toBe("recovered on sonnet");
  });

  it("does NOT fall back on a non-retryable error even when the chain has more tiers", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const request: AgentRequest = {
      ...baseRequest,
      headless: true,
      allowHeadlessTools: true,
      modelFallback: true,
      modelTier: "opus",
    };
    sdkMock.impl = () => throwingHandle(new Error("invalid_request: model does not exist"));

    await expect(runAgentStream(request, [], config, store, events)).rejects.toThrow(/invalid_request/);
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("propagates a transient error when there is no fallback chain (chat behavior)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => throwingHandle(new Error("overloaded"));

    await expect(runAgentStream(baseRequest, [], config, store, events)).rejects.toThrow("overloaded");
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("keeps the streamed partial text on an error_max_turns result (not the raw error)", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        deltaMsg("partial answer"),
        { type: "result", subtype: "error_max_turns", errors: ["Reached maximum number of turns (6)"] },
      ]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(response.text).toBe("partial answer");
    expect(response.usage).toBeUndefined();
  });

  it("returns the friendly Korean error message on an error result with no text anywhere", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), { type: "result", subtype: "error_max_turns" }]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // Error subtype present → the empty-turn retry is suppressed; friendly text shown.
    expect(response.text).toBe(resultErrorMessage("error_max_turns"));
    expect(response.text).toContain("최대 처리 단계");
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("retries once on an empty (thinking-only) turn and keeps the recovered answer", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    let call = 0;
    sdkMock.impl = () => {
      call += 1;
      if (call === 1) {
        return handleFrom([initMsg(), thinkingMsg("just reasoning, no answer"), successResult("")]);
      }
      return handleFrom([successResult("recovered")]);
    };

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(sdkMock.calls).toHaveLength(2);
    expect(events.onThinkingReset).toHaveBeenCalledTimes(1);
    // The retry prompt carries the empty-turn nudge.
    expect(await promptTextOf(sdkMock.calls[1].prompt)).toContain("internal reasoning only");
    expect(response.text).toBe("recovered");
  });

  it("falls back to the empty-response message when the retry is still empty", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("")]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // First empty turn triggers exactly one retry; the second empty turn gives up.
    expect(sdkMock.calls).toHaveLength(2);
    expect(events.onThinkingReset).toHaveBeenCalledTimes(1);
    expect(response.text).toBe("Claude Agent SDK 응답이 비어 있습니다.");
  });

  it("suppresses the empty-turn retry when the run was aborted mid-stream", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    const abort = new AbortController();
    sdkMock.impl = () => {
      async function* gen() {
        yield initMsg("sess-abort");
        abort.abort();
        yield successResult("");
      }
      return gen() as QueryHandle;
    };

    const response = await runAgentStream(baseRequest, [], config, store, events, abort);

    // Aborted → no retry despite an empty turn.
    expect(sdkMock.calls).toHaveLength(1);
    expect(response.text).toBe("Claude Agent SDK 응답이 비어 있습니다.");
  });

  it("builds a streaming-input prompt (image blocks) when the turn carries images", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("saw the image")]);

    const response = await runAgentStream(
      { ...baseRequest, images: [{ mediaType: "image/png", data: "AAAA" }] },
      [],
      config,
      store,
      events,
    );

    // Image turns pass an async-iterable prompt instead of a plain string.
    const prompt = sdkMock.calls[0].prompt as { [Symbol.asyncIterator]?: unknown };
    expect(typeof prompt[Symbol.asyncIterator]).toBe("function");
    expect(response.text).toBe("saw the image");
  });

  it("feeds streaming turns through a held-open generator released at a task-free result", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    const response = await runAgentStream(baseRequest, [], config, store, events);
    expect(response.text).toBe("ok");

    // Text-only streaming turns now ALSO pass an async-iterable prompt: a string
    // prompt makes the SDK close the CLI's stdin at the first result
    // (isSingleUserTurn), which kills still-running background tasks with the
    // process. Same wire format either way — one stream-json user message.
    const prompt = sdkMock.calls[0].prompt as AsyncGenerator<Record<string, unknown>>;
    expect(typeof prompt[Symbol.asyncIterator]).toBe("function");
    const first = await prompt.next();
    const content = (
      first.value as { message: { content: Array<{ type: string; text?: string }> } }
    ).message.content;
    expect(content.find((block) => block.type === "text")?.text).toContain("안녕하세요");
    // …and the generator COMPLETES: the task-free result released the hold. An
    // unreleased gate would park this `next()` forever (and, live, would hold
    // the CLI's stdin open past the turn).
    const second = await prompt.next();
    expect(second.done).toBe(true);
  });

  it("holds the input open across a result with live background tasks, releasing on settle", async () => {
    const { config, store, baseRequest } = setup();
    const onTurnResult = vi.fn();
    const events = makeEvents({ onTurnResult });
    const bgChanged = (tasks: Array<{ task_id: string }>) => ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks,
    });
    // Consume the held-open prompt like the real SDK does, recording when it
    // completes relative to the scripted stream.
    let promptCompleted = false;
    let completedBeforeWake: boolean | null = null;
    sdkMock.impl = (args) => {
      const prompt = args.prompt as AsyncGenerator<Record<string, unknown>>;
      void (async () => {
        await prompt.next(); // the user message
        await prompt.next(); // parks on the gate
        promptCompleted = true;
      })();
      async function* messages() {
        yield initMsg();
        yield bgChanged([{ task_id: "t1" }]);
        yield assistantMsg([textBlock("접수")]);
        yield successResult("접수");
        // A result with a LIVE task must NOT release the gate — give a released
        // gate's microtasks a beat to land before sampling, so a regression here
        // cannot pass on scheduling luck.
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedBeforeWake = promptCompleted;
        yield bgChanged([]);
        yield assistantMsg([textBlock("완료 보고")]);
        yield successResult("완료 보고");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return messages() as QueryHandle;
    };

    const response = await runAgentStream(baseRequest, [], config, store, events);

    // No onTextFold sink in this test → legacy full join of both segments.
    expect(response.text).toBe("접수\n\n완료 보고");
    // Held through the background phase, released at the task-free boundary.
    expect(completedBeforeWake).toBe(false);
    expect(promptCompleted).toBe(true);
    expect(onTurnResult).toHaveBeenCalledTimes(2);
    expect(onTurnResult.mock.calls[0][0].backgroundTasks).toHaveLength(1);
    expect(onTurnResult.mock.calls[1][0].backgroundTasks).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Mid-turn user messages ("steers"). The channel is the seam between the
  // held-open prompt generator (which writes them to the CLI's stdin) and the
  // CLI's command_lifecycle frames (the only delivery signal).
  // -------------------------------------------------------------------------

  it("yields a mid-turn message into the live prompt and marks it delivered inside the turn", async () => {
    const { config, store, baseRequest } = setup();
    const steers = new SteerChannel();
    const onTurnResult = vi.fn();
    const events = makeEvents({ steers, onTurnResult });

    const yielded: Record<string, unknown>[] = [];
    let promptCompleted = false;
    let steerId = "";
    sdkMock.impl = (args) => {
      const prompt = args.prompt as AsyncGenerator<Record<string, unknown>>;
      void (async () => {
        for await (const message of prompt) {
          yielded.push(message);
        }
        promptCompleted = true;
      })();
      async function* messages() {
        yield initMsg();
        // Mid-turn: the model is between tool calls when the viewer types.
        yield assistantMsg([toolUseBlock("tu-1", "Read", { file_path: "a.ts" })]);
        yield toolResultMsg("tu-1");
        steerId = steers.push("사실 b.ts부터 봐줘")!.id;
        // Let the prompt generator pick it up the way the CLI's stdin would.
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield lifecycleMsg(steerId, "queued");
        yield lifecycleMsg(steerId, "started");
        yield assistantMsg([textBlock("b.ts로 바꿔서 확인했습니다")]);
        yield successResult("b.ts로 바꿔서 확인했습니다");
      }
      return messages() as QueryHandle;
    };

    const response = await runAgentStream(baseRequest, [], config, store, events);
    expect(response.text).toBe("b.ts로 바꿔서 확인했습니다");

    // The steer rode the SAME held-open generator as the turn's first prompt,
    // as its second item, keyed by the record id the CLI echoes back.
    expect(yielded).toHaveLength(2);
    expect(yielded[1].uuid).toBe(steerId);
    expect(yielded[1].parent_tool_use_id).toBeNull();
    expect(
      (yielded[1].message as { content: { text: string }[] }).content[0].text,
    ).toBe("사실 b.ts부터 봐줘");

    // Folded INTO the running turn: delivered before the result, so it never
    // becomes a follow-up.
    const record = steers.records()[0];
    expect(record.state).toBe("delivered");
    expect(record.followUp).toBe(false);
    expect(onTurnResult).toHaveBeenCalledTimes(1);
    expect(onTurnResult.mock.calls[0][0].steerPending).toBe(false);

    // Task-free, steer-free boundary → the gate released and the channel closed.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptCompleted).toBe(true);
    expect(steers.closed).toBe(true);
  });

  it("keeps the run open for a steer the turn ended before, and segments the follow-up turn", async () => {
    const { config, store, baseRequest } = setup();
    const steers = new SteerChannel();
    const onTurnResult = vi.fn();
    const onTextFold = vi.fn();
    const events = makeEvents({ steers, onTurnResult, onTextFold });

    let promptCompleted = false;
    let completedBeforeFollowUp: boolean | null = null;
    let steerId = "";
    sdkMock.impl = (args) => {
      const prompt = args.prompt as AsyncGenerator<Record<string, unknown>>;
      void (async () => {
        for await (const _message of prompt) {
          /* drain */
        }
        promptCompleted = true;
      })();
      async function* messages() {
        yield initMsg();
        yield deltaMsg("첫 답변");
        yield assistantMsg([textBlock("첫 답변")]);
        // The viewer types just as the turn wraps up: the CLI has it queued but
        // has not handed it to the model, so this result is NOT the run's end.
        steerId = steers.push("한 가지 더 확인해줘")!.id;
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield successResult("첫 답변");
        // A released gate's microtasks get a beat to land before sampling, so a
        // regression cannot pass on scheduling luck.
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedBeforeFollowUp = promptCompleted;
        // The CLI starts it as its OWN turn in the same session.
        yield lifecycleMsg(steerId, "started");
        yield initMsg("sess-1", "opus");
        yield deltaMsg("추가 확인 결과");
        yield assistantMsg([textBlock("추가 확인 결과")]);
        yield successResult("추가 확인 결과");
      }
      return messages() as QueryHandle;
    };

    const response = await runAgentStream(baseRequest, [], config, store, events);

    expect(onTurnResult).toHaveBeenCalledTimes(2);
    expect(onTurnResult.mock.calls[0][0]).toMatchObject({
      text: "첫 답변",
      backgroundTasks: [],
      steerPending: true,
    });
    expect(onTurnResult.mock.calls[1][0]).toMatchObject({
      text: "추가 확인 결과",
      steerPending: false,
    });

    // The gate stayed shut across the first result (the CLI still had to run
    // the steer) and opened at the second.
    expect(completedBeforeFollowUp).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptCompleted).toBe(true);
    expect(steers.closed).toBe(true);

    const record = steers.records()[0];
    expect(record.state).toBe("delivered");
    expect(record.followUp).toBe(true);

    // The first segment was already handed to the host as its own message, so
    // the run's final text is the FOLLOW-UP turn only, and the first segment is
    // never folded into the reasoning view behind it.
    expect(response.text).toBe("추가 확인 결과");
    expect(onTextFold).not.toHaveBeenCalledWith("첫 답변");
    expect(onTextFold).not.toHaveBeenCalled();
  });

  it("tells the model it can be interrupted only when the run really has a channel", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, makeEvents({ steers: new SteerChannel() }));
    const withChannel = (sdkMock.calls[0].options.systemPrompt as { append: string }).append;
    expect(withChannel).toContain(
      "The user may send additional messages while you are working",
    );

    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);
    await runAgentStream(baseRequest, [], config, store, makeEvents());
    const without = (sdkMock.calls[1].options.systemPrompt as { append: string }).append;
    expect(without).not.toContain(
      "The user may send additional messages while you are working",
    );
  });

  it("drops a still-queued mid-turn message when the run is aborted", async () => {
    const { config, store, baseRequest } = setup();
    const steers = new SteerChannel();
    const abort = new AbortController();
    sdkMock.impl = () => {
      async function* messages() {
        yield initMsg();
        steers.push("중간에 보낸 메시지");
        abort.abort();
        throw new Error("aborted");
      }
      return messages() as QueryHandle;
    };

    await expect(
      runAgentStream(baseRequest, [], config, store, makeEvents({ steers }), abort),
    ).rejects.toThrow("aborted");

    // The model never saw it, so it must not look delivered — and the channel
    // is closed, which is what stops the route from persisting it.
    expect(steers.closed).toBe(true);
    expect(steers.records().map((r) => r.state)).toEqual(["dropped"]);
    expect(steers.hasUndelivered()).toBe(false);
  });

  it("keeps the plain string prompt on headless runs (single-turn teardown)", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    const response = await runClaudeAgent(baseRequest, [], config, store);

    expect(response.text).toBe("ok");
    expect(typeof sdkMock.calls[0].prompt).toBe("string");
  });

  it("injects the stored subscription OAuth token, applies autoCompactWindow, and skips non-record messages", async () => {
    const { config, store, baseRequest } = setup({ autoCompactWindow: 150_000 });
    store.setAppSecret(CLAUDE_OAUTH_TOKEN_KEY, "oauth-tok");
    const events = makeEvents();
    sdkMock.impl = () =>
      // A stray non-record message the run loop must skip without throwing.
      handleFrom([null, initMsg(), successResult("ok")]);

    const response = await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    // The window rides the SDK `settings` option (serialized by the SDK into the
    // CLI `--settings` JSON), not a top-level SDK option: the pinned SDK's Options
    // has no such field and would drop it silently.
    expect(options.settings).toEqual({ autoCompactWindow: 150_000 });
    expect(options.autoCompactWindow).toBeUndefined();
    const env = options.env as Record<string, string | undefined>;
    // No API key configured → the OAuth token is injected and any empty API key dropped.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(response.text).toBe("ok");
  });

  it("passes no settings JSON when no autoCompactWindow is configured", async () => {
    const { config, store, baseRequest } = setup();
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    expect(sdkMock.calls[0].options.settings).toBeUndefined();
  });

  it("lifts plugin-defined MCP servers and exposes plugin roots as writable directories", async () => {
    const { config, store, baseRequest } = setup();
    const pluginDir = path.join(tempDir, "plugin-root");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({ corp: { command: "node", args: ["server.js"] } }),
    );
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(
      baseRequest,
      [{ type: "local", path: pluginDir }],
      config,
      store,
      events,
    );

    const { options } = sdkMock.calls[0];
    // The plugin's .mcp.json server is registered by the app (strictMcpConfig).
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toContain("corp");
    // The plugin root is exposed as an additional writable dir.
    expect(options.additionalDirectories).toEqual([pluginDir]);
  });

  it("shell-exposes an owner secret into env and injects it into an OWNED plugin MCP server", async () => {
    const { config, store, baseRequest, owner } = setup();
    // An owner secret opted into shell exposure (a non-reserved, injectable name).
    store.setUserSecret(owner.id, "MY_API_KEY", "vault-value-123");
    store.setSecretShellExpose(owner.id, "MY_API_KEY", true);
    // An OWNED plugin (under dataDir/plugins/<uid>/…) with a stdio MCP server, so
    // the secret rides in via the one-shot secret-file wrapper.
    const pluginDir = path.join(config.dataDir, "plugins", owner.id, "repo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".mcp.json"),
      JSON.stringify({ corp: { command: "node", args: ["server.js"] } }),
    );
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [{ type: "local", path: pluginDir }], config, store, events);

    const { options } = sdkMock.calls[0];
    // Shell-exposed value reaches the CLI subprocess env on this elevated run.
    expect((options.env as Record<string, string>).MY_API_KEY).toBe("vault-value-123");
    // The owned stdio server was rewritten through the secret-file wrapper (value
    // never in argv), and the secret-value redaction PostToolUse hook is registered.
    const corp = (options.mcpServers as Record<string, { args?: string[] }>).corp;
    expect(corp.args).toContain("--secrets");
    const hooks = options.hooks as { PostToolUse?: unknown[] };
    expect(Array.isArray(hooks.PostToolUse)).toBe(true);
    // The one-shot secret file was written to disk (consumed by the wrapper at runtime).
    const secretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
    expect(fs.readdirSync(secretsDir).length).toBeGreaterThan(0);
  });

  it("registers the redaction hook for a BROWSER-typeable secret, and only for the opted-in names", async () => {
    // Browser input is its own exposure path: the value reaches the user's
    // browser, so it must be redactable from every OTHER tool output for the
    // rest of the turn. Without this the run would register no PostToolUse hook
    // at all (no shell exposure, no plugin server) and a page echoing the
    // password back would print it in the next snapshot.
    const { config, store, baseRequest, owner } = setup();
    store.setUserSecret(owner.id, "LOGIN_PW", "hunter2-corp-secret");
    store.setUserSecret(owner.id, "OTHER_KEY", "unrelated-vault-value");
    store.setSecretBrowserPolicy(owner.id, "LOGIN_PW", {
      enabled: true,
      hosts: ["jira.corp.com"],
      passwordOnly: true,
    });
    const events = makeEvents({ onBrowser: vi.fn() });
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const { options } = sdkMock.calls[0];
    const hooks = options.hooks as {
      PostToolUse?: { hooks: ((input: unknown) => Promise<unknown>)[] }[];
    };
    expect(hooks.PostToolUse?.length).toBe(1);
    const hook = hooks.PostToolUse![0].hooks[0];
    const leaked = (await hook({
      tool_response: { stdout: "log line: hunter2-corp-secret / unrelated-vault-value" },
    })) as { hookSpecificOutput?: { updatedToolOutput?: { stdout: string } } };
    const out = leaked.hookSpecificOutput!.updatedToolOutput!.stdout;
    expect(out).toContain("[REDACTED:LOGIN_PW]");
    expect(out).not.toContain("hunter2-corp-secret");
    // A vault secret the owner did NOT opt into browser input stays out of the
    // redaction set: this run exposes it nowhere, and redacting it would only
    // shred unrelated output.
    expect(out).toContain("unrelated-vault-value");
  });

  it("registers no redaction hook for a browser secret when the bridge is not in this run", async () => {
    // The policy exists, but with no browser sink there is nothing to type it
    // into — so nothing is exposed and nothing needs redacting.
    const { config, store, baseRequest, owner } = setup();
    store.setUserSecret(owner.id, "LOGIN_PW", "hunter2-corp-secret");
    store.setSecretBrowserPolicy(owner.id, "LOGIN_PW", {
      enabled: true,
      hosts: ["jira.corp.com"],
      passwordOnly: true,
    });
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    const hooks = sdkMock.calls[0].options.hooks as { PostToolUse?: unknown[] };
    expect(hooks.PostToolUse).toBeUndefined();
  });

  it("sweeps stale one-shot MCP secret files older than the max age", async () => {
    const { config, store, baseRequest } = setup();
    const secretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    const staleFile = path.join(secretsDir, "plugin-old.json");
    fs.writeFileSync(staleFile, "{}");
    // Backdate it two hours (the sweep threshold is one hour).
    const old = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(staleFile, old / 1000, old / 1000);
    const events = makeEvents();
    sdkMock.impl = () => handleFrom([initMsg(), successResult("ok")]);

    await runAgentStream(baseRequest, [], config, store, events);

    expect(fs.existsSync(staleFile)).toBe(false);
  });
});

// ===========================================================================
// buildImageQueryPrompt (direct — the run loop never consumes it under the mock)
// ===========================================================================
describe("buildImageQueryPrompt", () => {
  it("yields exactly one SDK user message with the prompt text followed by image blocks", async () => {
    const gen = buildImageQueryPrompt("look at these", [
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "image/jpeg", data: "BBBB" },
    ]);
    const first = await gen.next();
    expect(first.done).toBe(false);
    const message = first.value as {
      type: string;
      parent_tool_use_id: unknown;
      message: { role: string; content: Record<string, unknown>[] };
    };
    expect(message.type).toBe("user");
    expect(message.parent_tool_use_id).toBeNull();
    expect(message.message.role).toBe("user");
    expect(message.message.content[0]).toEqual({ type: "text", text: "look at these" });
    expect(message.message.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
    expect(message.message.content[2]).toMatchObject({
      source: { media_type: "image/jpeg", data: "BBBB" },
    });
    // The stream closes after the single message (one turn).
    expect((await gen.next()).done).toBe(true);
  });
});

// ===========================================================================
// runRegistry — coverage of the branches not exercised by agent-core.test.ts
// ===========================================================================
interface SseSink {
  res: Response;
  chunks: string[];
  setThrow: (v: boolean) => void;
  setEnded: (v: boolean) => void;
}

function makeSseSink(): SseSink {
  const chunks: string[] = [];
  let ended = false;
  let throwOnWrite = false;
  const handlers = new Map<string, () => void>();
  const res = {
    get writableEnded() {
      return ended;
    },
    write(chunk: string) {
      if (throwOnWrite) {
        throw new Error("EPIPE");
      }
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
      handlers.get("close")?.();
    },
    on(event: string, cb: () => void) {
      handlers.set(event, cb);
      return this;
    },
  } as unknown as Response;
  return {
    res,
    chunks,
    setThrow: (v) => {
      throwOnWrite = v;
    },
    setEnded: (v) => {
      ended = v;
    },
  };
}

describe("runRegistry (additional coverage)", () => {
  it("getActiveRun resolves by id and rejects unknown / wrong-user / ended runs", () => {
    openRun("ar-1", "u", { conversationId: "c-ar", avatarId: "av" });
    expect(getActiveRun("ar-1", "u")).toMatchObject({
      runId: "ar-1",
      conversationId: "c-ar",
      avatarId: "av",
      eventCount: 0,
      pendingCount: 0,
      cancelled: false,
    });
    expect(getActiveRun("ar-1", "intruder")).toBeNull();
    expect(getActiveRun("ghost", "u")).toBeNull();
    closeRun("ar-1");
    expect(getActiveRun("ar-1", "u")).toBeNull();
  });

  it("cancelAllRuns aborts every controller and unparks pending prompts (shutdown)", async () => {
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    openRun("all-1", "u", { abortController: ac1 });
    openRun("all-2", "u2", { conversationId: "c2", abortController: ac2 });
    const p1 = awaitResponse("all-1", "r1");
    const p2 = awaitResponse("all-2", "r2");

    cancelAllRuns();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(isRunCancelled("all-1")).toBe(true);
    await expect(p1).resolves.toBe(CANCELLED);
    await expect(p2).resolves.toBe(CANCELLED);
    closeRun("all-1");
    closeRun("all-2");
  });

  it("submitResponse clears the pending timeout and rejects unknown / wrong-user / no-pending", async () => {
    expect(submitResponse("ghost", "req", "u", {})).toBe(false); // unknown run
    openRun("sr-1", "u");
    const parked = awaitResponse("sr-1", "req"); // sets the auto-cancel timeout
    expect(submitResponse("sr-1", "req", "intruder", {})).toBe(false); // wrong user
    expect(submitResponse("sr-1", "other-req", "u", {})).toBe(false); // no such pending
    expect(submitResponse("sr-1", "req", "u", { behavior: "allow" })).toBe(true);
    await expect(parked).resolves.toEqual({ behavior: "allow" });
    closeRun("sr-1");
  });

  it("cancelRun marks cancelled, aborts the controller, unparks prompts, and rejects wrong users", async () => {
    const ac = new AbortController();
    openRun("cr-1", "u", { conversationId: "c-cr", abortController: ac });
    const parked = awaitResponse("cr-1", "req");
    expect(cancelRun("cr-1", "intruder")).toBe(false);
    expect(cancelRun("cr-1", "u")).toBe(true);
    expect(isRunCancelled("cr-1")).toBe(true);
    expect(ac.signal.aborted).toBe(true);
    await expect(parked).resolves.toBe(CANCELLED);
    closeRun("cr-1");
  });

  it("awaitResponse resolves CANCELLED for an unknown run and closeRun no-ops on an unknown id", async () => {
    await expect(awaitResponse("ghost", "req")).resolves.toBe(CANCELLED);
    expect(() => closeRun("never-opened")).not.toThrow();
  });

  it("attachRunClient replays buffered events after the given event id", () => {
    openRun("rp-1", "u");
    emitRunEvent("rp-1", "status", { label: "first" });
    emitRunEvent("rp-1", "status", { label: "second" });
    const sink = makeSseSink();
    attachRunClient("rp-1", "u", sink.res, 1); // since id 1 → only the second frame
    const replayed = sink.chunks.join("");
    expect(replayed).toContain("second");
    expect(replayed).not.toContain("first");
    closeRun("rp-1");
  });

  it("emitRunEvent with replay:false reaches live clients but is never replayed", () => {
    // The frame carrying a stored secret's plaintext must not sit in the run's
    // replay buffer, where a reconnect would re-send it verbatim.
    openRun("tr-1", "u");
    const live = makeSseSink();
    attachRunClient("tr-1", "u", live.res);
    expect(emitRunEvent("tr-1", "browser", { op: "type", secretText: "hunter2" }, { replay: false })).toBe(
      true,
    );
    emitRunEvent("tr-1", "status", { label: "after" });
    expect(live.chunks.join("")).toContain("hunter2"); // the live client DID get it
    // A client attaching afterwards is caught up on everything BUT that frame,
    // and the id it consumed is still spent, so the cursor stays monotonic.
    const late = makeSseSink();
    attachRunClient("tr-1", "u", late.res, 0);
    const replayed = late.chunks.join("");
    expect(replayed).not.toContain("hunter2");
    expect(replayed).toContain("after");
    expect(replayed).toContain("id: 2");
    closeRun("tr-1");
  });

  it("getActiveRunForConversation clears a stale conversation→run mapping", () => {
    openRun("st-1", "u", { conversationId: "c-old" });
    // Reusing the runId for a new conversation leaves the old key dangling; the
    // close then removes only the new key + the run, so the old key is now stale.
    openRun("st-1", "u", { conversationId: "c-new" });
    closeRun("st-1");
    expect(getActiveRunForConversation("u", "c-old")).toBeNull();
    // Idempotent — the stale entry was pruned on the first lookup.
    expect(getActiveRunForConversation("u", "c-old")).toBeNull();
  });

  it("awaitResponse auto-cancels a parked prompt after the TTL and notifies clients", async () => {
    vi.useFakeTimers();
    try {
      openRun("to-1", "u", { conversationId: "c-to" });
      const sink = makeSseSink();
      attachRunClient("to-1", "u", sink.res);
      const parked = awaitResponse("to-1", "req-to");

      vi.advanceTimersByTime(30 * 60 * 1000 + 1000);

      await expect(parked).resolves.toBe(CANCELLED);
      expect(sink.chunks.join("")).toContain("event: prompt_resolved");
      closeRun("to-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeat pings the client, then detaches once the response has ended", () => {
    vi.useFakeTimers();
    try {
      openRun("hb-1", "u");
      const sink = makeSseSink();
      attachRunClient("hb-1", "u", sink.res);

      vi.advanceTimersByTime(15_000);
      const pingsAfterFirst = sink.chunks.filter((c) => c === ": ping\n\n").length;
      expect(pingsAfterFirst).toBeGreaterThan(0);

      sink.setEnded(true); // res.writableEnded → the next heartbeat detaches
      vi.advanceTimersByTime(15_000);
      expect(sink.chunks.filter((c) => c === ": ping\n\n").length).toBe(pingsAfterFirst);
      closeRun("hb-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeat detaches the client when a ping write throws", () => {
    vi.useFakeTimers();
    try {
      openRun("hb-2", "u");
      const sink = makeSseSink();
      sink.setThrow(true); // every write throws
      attachRunClient("hb-2", "u", sink.res);

      vi.advanceTimersByTime(15_000); // ping write throws → detach (clearInterval)
      vi.advanceTimersByTime(15_000); // interval cleared → no further callback
      expect(sink.chunks).toHaveLength(0);
      closeRun("hb-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emitRunEvent detaches a client whose write fails or whose response already ended", () => {
    openRun("em-1", "u");
    const sink = makeSseSink();
    attachRunClient("em-1", "u", sink.res);
    expect(emitRunEvent("em-1", "status", { label: "a" })).toBe(true);
    expect(sink.chunks.join("")).toContain("event: status");

    // Write now throws → writeSse catch returns false → the client is detached.
    sink.setThrow(true);
    emitRunEvent("em-1", "status", { label: "b" });
    sink.setThrow(false);
    const before = sink.chunks.length;
    emitRunEvent("em-1", "status", { label: "c" });
    expect(sink.chunks.length).toBe(before); // detached client no longer receives events
    closeRun("em-1");

    // Separately, a client whose response has ended is dropped on the next emit.
    openRun("em-2", "u");
    const ended = makeSseSink();
    attachRunClient("em-2", "u", ended.res);
    ended.setEnded(true);
    emitRunEvent("em-2", "status", { label: "x" }); // writableEnded → writeSse false → detach
    ended.setEnded(false);
    const before2 = ended.chunks.length;
    emitRunEvent("em-2", "status", { label: "y" });
    expect(ended.chunks.length).toBe(before2);
    closeRun("em-2");
  });

  it("emitRunEvent and attachRunClient reject unknown, ended, and wrong-user runs", () => {
    expect(emitRunEvent("ghost", "e", {})).toBe(false);
    const sink = makeSseSink();
    expect(attachRunClient("ghost", "u", sink.res)).toBe(false);

    openRun("ae-1", "u");
    expect(attachRunClient("ae-1", "intruder", sink.res)).toBe(false); // wrong user
    closeRun("ae-1");
    expect(attachRunClient("ae-1", "u", sink.res)).toBe(false); // gone after close
    expect(emitRunEvent("ae-1", "e", {})).toBe(false);
  });

  it("getActiveRunForConversation resolves the active run and returns null for an unknown key", () => {
    openRun("gc-1", "u", { conversationId: "c-gc", avatarId: "a" });
    expect(getActiveRunForConversation("u", "c-gc")?.runId).toBe("gc-1");
    expect(getActiveRunForConversation("u", "no-such-conv")).toBeNull();
    expect(getActiveRunForConversation("other", "c-gc")).toBeNull(); // key is per-user
    closeRun("gc-1");
    expect(getActiveRunForConversation("u", "c-gc")).toBeNull();
  });
});

// ===========================================================================
// AGENT_TOOL_TRACE — the opt-in diagnostic trace of one turn's tool lifecycle
// ===========================================================================
describe("SDK tool-call tracing (AGENT_TOOL_TRACE)", () => {
  beforeEach(() => {
    traceLog.entries.length = 0;
  });

  /** The payloads of every trace line whose message matches `msg`. */
  function traced(msg: string): Record<string, unknown>[] {
    return traceLog.entries.filter((e) => e.msg === msg).map((e) => e.payload);
  }

  it("traces the streaming tool_use block lifecycle and the turn's stop_reason", () => {
    // The documented stall signature is a "tool_use block start" with no matching
    // "content_block stop": the backend opened a tool call and never closed its
    // input JSON. Both halves have to be traced with the same index for that
    // comparison to be possible at all.
    const state = createLoopState();
    const events = makeEvents();
    const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      dispatchSdkMessage({ type: "stream_event", ...extra, event }, events, state);

    stream({ type: "message_start", message: { usage: { input_tokens: 10 } } });
    stream({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
    });
    // A text block start is NOT a tool call and must not be traced as one.
    stream({ type: "content_block_start", index: 2, content_block: { type: "text" } });
    stream({ type: "content_block_stop", index: 1 });
    stream({ type: "message_delta", delta: { stop_reason: "tool_use" } });
    // A delta with no stop_reason yet is silent (it fires on every chunk).
    stream({ type: "message_delta", delta: {} });
    stream({ type: "message_stop" }, { parent_tool_use_id: "agent-7" });

    expect(traced("trace: tool_use block start")).toEqual([
      { agentId: "main", index: 1, toolName: "Bash", toolUseId: "toolu_1" },
    ]);
    expect(traced("trace: content_block stop")).toEqual([{ agentId: "main", index: 1 }]);
    expect(traced("trace: message_delta stop_reason")).toEqual([
      { agentId: "main", stopReason: "tool_use" },
    ]);
    // Subagent streams are attributed to their spawning tool_use id, not "main".
    expect(traced("trace: stream lifecycle")).toEqual([
      { agentId: "main", eventType: "message_start" },
      { agentId: "agent-7", eventType: "message_stop" },
    ]);
  });

  it("traces the assembled assistant tool calls, every tool_result, and the result subtype", () => {
    // The other documented stall signature: stop_reason "tool_use" + an assistant
    // tool call, but no tool_result — the SDK never dispatched the announced call.
    const state = createLoopState();
    const events = makeEvents();
    dispatchSdkMessage(
      {
        type: "assistant",
        message: {
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "확인해 볼게요" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      },
      events,
      state,
    );
    expect(traced("trace: assistant message assembled")).toEqual([
      {
        agentId: "main",
        stopReason: "tool_use",
        blockTypes: ["text", "tool_use", "tool_use"],
        toolCalls: [
          { name: "Bash", toolUseId: "toolu_1" },
          { name: "Read", toolUseId: "toolu_2" },
        ],
      },
    ]);

    dispatchSdkMessage(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", is_error: true },
            { type: "tool_result", tool_use_id: "toolu_2" },
          ],
        },
      },
      events,
      state,
    );
    // A user turn with no tool_result blocks stays out of the trace entirely.
    dispatchSdkMessage(
      { type: "user", message: { content: [{ type: "text", text: "다음은?" }] } },
      events,
      state,
    );
    expect(traced("trace: tool_result(s) returned")).toEqual([
      {
        agentId: "main",
        results: [
          { toolUseId: "toolu_1", isError: true },
          { toolUseId: "toolu_2", isError: false },
        ],
      },
    ]);

    dispatchSdkMessage({ type: "result", subtype: "error_max_turns" }, events, state);
    expect(traced("trace: result")).toEqual([{ agentId: "main", subtype: "error_max_turns" }]);
  });

  it("stays silent for envelopes it does not model, and never throws into the run loop", () => {
    const state = createLoopState();
    dispatchSdkMessage({ type: "tool_progress", tool_name: "Bash" }, makeEvents(), state);
    dispatchSdkMessage({ type: "system", subtype: "init" }, makeEvents(), state);
    expect(traceLog.entries).toEqual([]);

    // Tracing is best-effort diagnostics: a hostile/exotic envelope must not take
    // the turn down with it.
    const hostile = {
      get type(): string {
        throw new Error("boom");
      },
    } as unknown as Record<string, unknown>;
    expect(() => traceSdkMessage(hostile)).not.toThrow();
    expect(traceLog.entries).toEqual([]);
  });

  it("traces a real streamed turn end to end through runClaudeAgent", async () => {
    const { config, store, baseRequest } = setup();
    sdkMock.impl = () =>
      handleFrom([
        initMsg(),
        startMsg({ input_tokens: 100 }),
        deltaMsg("답변"),
        assistantMsg([textBlock("답변"), toolUseBlock("toolu_run", "Read", { file_path: "a.ts" })]),
        toolResultMsg("toolu_run"),
        successResult("답변"),
      ]);
    const res = await runClaudeAgent(baseRequest, [], config, store, makeEvents());
    expect(res.text).toBe("답변");

    // The whole lifecycle is visible in order from a single run, which is the
    // point of the flag: assistant tool call → its result → the terminal result.
    expect(traced("trace: stream lifecycle")).toEqual([
      { agentId: "main", eventType: "message_start" },
    ]);
    expect(traced("trace: assistant message assembled")[0]).toMatchObject({
      toolCalls: [{ name: "Read", toolUseId: "toolu_run" }],
    });
    expect(traced("trace: tool_result(s) returned")[0]).toMatchObject({
      results: [{ toolUseId: "toolu_run", isError: false }],
    });
    expect(traced("trace: result")).toEqual([{ agentId: "main", subtype: "success" }]);
  });
});
