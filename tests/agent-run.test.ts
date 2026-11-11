import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, AppConfig, PluginRoot } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

import { createServices } from "../src/server/app.js";
import {
  buildRunCapabilities,
  stampPromptRequest,
} from "../src/server/agent/runCapabilities.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PI_EFFORT_CLAMP_SENTENCE, buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { piEphemeralRunKey, piRunPrincipal, piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { EMPTY_PI_RESPONSE_MESSAGE, runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import {
  PiGatewayError,
  type PiModel,
  type PiResponseRequest,
  type PiResponsesClient,
  type PiStreamEvent,
} from "../src/server/agent/pi/responsesClient.js";
import { resultErrorMessage } from "../src/server/agent/runErrors.js";
import { redactSecretValues } from "../src/server/agent/secretRedaction.js";
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
  getRunPrompts,
  isRunCancelled,
  openRun,
  pushRunSteer,
  submitResponse,
} from "../src/server/agent/runRegistry.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { TOOL_SKILL_POLICY_CONFIG_KEY } from "../src/server/toolSkillPolicy.js";

// ---------------------------------------------------------------------------
// One run = the capability plan (`buildRunCapabilities` + `stampPromptRequest`,
// called here exactly as runPiAgent calls them) and the pi run loop (driven
// against a scripted fake gateway client). Everything Noah-side is real.
// ---------------------------------------------------------------------------

/** Events sink of vi.fn spies; pass overrides to add optional callbacks (e.g. onCanvas). */
function makeEvents(overrides: Partial<AgentEvents> = {}): AgentEvents {
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
    ...overrides,
  };
}

let tempDir: string;
const getTempDir = withTempDir("agent-run", () => {
  tempDir = getTempDir();
});

/** The models the fake pi-gateway offers (`GET /v1/models`) unless a test passes its own. */
const PI_MODELS = ["m-opus", "m-sonnet", "m-haiku"];

/** Fresh services + an owner user + a realistic owner AgentRequest, over the per-test temp dir. */
function setup(configOverrides: Partial<AppConfig> = {}, models: string[] = PI_MODELS) {
  const { config, store } = createServices({
    dataDir: tempDir,
    agentRuntime: "pi",
    sessionSecret: "test",
    defaultPluginsDir: path.join(tempDir, "default-plugins"),
    pi: {
      gatewayUrl: "http://pi.invalid",
      apiKey: "k",
      deckSandbox: false,
      workspacesDir: path.join(tempDir, "pi-ws"),
    },
    ...configOverrides,
  });
  // Every route and run reads the process's catalog; serve it from the fake list.
  piServicesFor(store, config).models = createPiModelCatalog({
    listModels: async () => models.map((id) => ({ id, ownedBy: "fake" })),
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

type Env = ReturnType<typeof setup>;

/** The plan as runPiAgent builds it, plus the frozen append and this turn's preamble its stamps produce. */
async function plan(env: Env, request: AgentRequest, events: AgentEvents | undefined = makeEvents(), pluginRoots: PluginRoot[] = []) {
  const principal = request.avatarConsultation ? "consult-000000000000000000000000" : piRunPrincipal(request);
  const workspace = piWorkspaceFor(env.config, principal, request.conversationId ?? piEphemeralRunKey(request));
  const caps = await buildRunCapabilities(request, pluginRoots, env.config, env.store, events, undefined, () => 0, {
    piConversationDir: workspace.conversationDir,
    piWorkspace: workspace,
  });
  const stamped = stampPromptRequest(request, caps, env.config, events);
  return {
    caps,
    stamped,
    servers: Object.keys(caps.inProcessMcpServers),
    allowed: caps.mcpAllowedTools,
    append: buildSystemPromptAppend(stamped),
    turn: buildPiTurnPreamble(stamped, { now: new Date("2026-10-29T00:00:00Z") }),
  };
}

// ---- fake pi gateway --------------------------------------------------------------------

const ev = (type: string, data: Record<string, unknown>): PiStreamEvent => ({ type, data });

function textTurn(id: string, text: string): PiStreamEvent[] {
  return [
    ev("response.created", { response: { id, model: "fake-model", status: "in_progress" } }),
    ...(text
      ? [
          ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } }),
          ev("response.output_text.delta", { delta: text }),
          ev("response.output_item.done", { item: { type: "message", id: `${id}-m`, status: "completed" } }),
        ]
      : []),
    ev("response.completed", { response: { id, status: "completed", usage: { output_tokens: 3 } } }),
  ];
}

type Step = (req: PiResponseRequest) => PiStreamEvent[] | Error;

function fakeClient(steps: Step[]) {
  const requests: PiResponseRequest[] = [];
  let index = 0;
  const client: PiResponsesClient = {
    async *stream(req) {
      requests.push(structuredClone(req));
      const step = steps[index++];
      if (!step) throw new Error(`unexpected pi request #${index}`);
      const out = step(req);
      if (out instanceof Error) throw out;
      for (const event of out) yield event;
    },
    async cancel() {
      return { status: "cancelled" };
    },
    async input() {
      throw new Error("not used");
    },
    async compact() {
      throw new Error("not used");
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

const inputText = (req: PiResponseRequest) => (req.input.kind === "prompt" ? req.input.text : "");

// ===========================================================================
// The capability plan: which Noah servers and tools a run class gets
// ===========================================================================
describe("run capability plan", () => {
  it("reports the effort it SENDS on the run's model in describe_system, and the clamp rule in the prompt (review #9)", async () => {
    const env = setup();
    piServicesFor(env.store, env.config).models = createPiModelCatalog({
      listModels: async () => [
        { id: "small", default: true, reasoning: { efforts: ["none", "minimal", "low", "medium", "high"], defaultEffort: "high" } },
        { id: "plain", reasoning: null },
        { id: "older-pi" },
      ],
    });
    const describe = async (request: AgentRequest) => {
      const run = await plan(env, request);
      const server = run.caps.inProcessMcpServers.system as unknown as { instance: McpServer };
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await server.instance.connect(b);
      await client.connect(a);
      try {
        const result = (await client.callTool({ name: "describe_system", arguments: {} })) as { content: { text: string }[] };
        return { run, line: result.content[0]!.text.split("\n").find((l) => l.startsWith("- Reasoning effort: ")) ?? "" };
      } finally {
        await client.close();
      }
    };
    // 기본 모델 lists up to high: max is lowered to high.
    let { run, line } = await describe({ ...env.baseRequest, effort: "max" });
    expect(line).toContain("high (High) — max was chosen for this conversation, but the current model does not support it");
    expect(line).toContain("it supports: none, minimal, low, medium, high");
    expect(run.append).toContain(PI_EFFORT_CLAMP_SENTENCE);
    // A model that does not reason gets no effort.
    ({ line } = await describe({ ...env.baseRequest, model: "plain", effort: "low" }));
    expect(line).toContain("none — the current model does not use reasoning effort");
    // Control: pi silent about efforts (an older pi) → reported as picked.
    ({ line } = await describe({ ...env.baseRequest, model: "older-pi", effort: "max" }));
    expect(line).toBe("- Reasoning effort: max (Maximum) (chosen for this conversation)");
  });

  it("resolves a run on pi's default model to that model's vision, and pi's text-only setting wins (review #12)", async () => {
    const env = setup();
    const offer = (models: PiModel[]) => {
      piServicesFor(env.store, env.config).models = createPiModelCatalog({ listModels: async () => models });
    };
    // pi silent on input (an older pi) reads as vision on.
    offer([{ id: "text-llm", default: true }, { id: "vis-llm" }]);
    let run = await plan(env, env.baseRequest);
    expect(run.caps.runVisionEnabled).toBe(true);
    offer([{ id: "text-llm", default: true, imageInput: false }, { id: "vis-llm", imageInput: true }]);
    // A vision policy an older release stored is never consulted.
    env.store.setAppSecret("model_vision_policy", JSON.stringify({ "text-llm": true }));
    run = await plan(env, env.baseRequest);
    expect(run.caps.runVisionEnabled).toBe(false);
    expect(run.append).toContain("**No image input**");
    // Control: the vision model the user picked keeps vision.
    run = await plan(env, { ...env.baseRequest, model: "vis-llm" });
    expect(run.caps.runVisionEnabled).toBe(true);
    expect(run.append).not.toContain("**No image input**");
  });

  it("retains system tools when an old admin policy blocks every optional group", async () => {
    const env = setup();
    vi.spyOn(env.store, "allowedMcpToolGroupsForUser").mockReturnValue([]);
    const run = await plan(env, env.baseRequest);
    expect(run.servers).toContain("system");
    expect(run.servers).not.toContain("canvas");
    expect(run.servers).not.toContain("git_repo");
    expect(run.allowed).toContain("mcp__system__read_manual");
    expect(run.allowed).toContain("mcp__system__describe_system");
    expect(run.append).toContain("System tools are always available");
    // The pi endpoint's gate and describe_system's "callable now" list are the same set.
    expect(run.caps.piRuntimeFacts.callableNoahTools).toEqual(run.allowed);
  });

  it.each([true, false])("always registers system tools regardless of saved selection (selected=%s)", async (enabled) => {
    const env = setup();
    const run = await plan(env, { ...env.baseRequest, mcpToolGroups: enabled ? ["system"] : [] });
    expect(run.allowed).toContain("mcp__system__read_manual");
    expect(run.servers).toContain("system");
    expect(run.append).toContain("mcp__system__read_manual");
    expect(run.append).toContain("external-tasks: External Task API integration");
  });

  it("registers the default families for a plain owner, and no server it has no sink or setup for", async () => {
    const env = setup();
    const run = await plan(env, env.baseRequest);
    // No pick, no override → pi-gateway's default model (no model id at all).
    expect(run.caps.effectiveModel).toBeUndefined();
    expect(run.caps.modelChain).toEqual([undefined]);
    expect(run.servers).toEqual(
      expect.arrayContaining(["knowledge", "repo", "system", "todo", "confluence", "avatars", "git_repo"]),
    );
    for (const absent of ["canvas", "group_repo", "ssh_trust", "browser", "file_output"]) {
      expect(run.servers).not.toContain(absent);
    }
    // The brain server rides every owner run for TEAM-brain recall (no personal repo
    // here, so only search/get_note); without a card sink no team-brain write tool exists.
    expect(run.servers).toContain("brain");
    expect(run.allowed).toContain("mcp__brain__search");
    expect(run.allowed).not.toContain("mcp__brain__propose_team_note");
    // Every built server is one pi's broker knows; nothing is relayed for this run.
    expect(run.caps.piMcpProxies.upstreams).toEqual([]);
    expect(run.caps.piRuntimeFacts.sandboxOwner).toBe("owner");
  });

  it("a stored policy still naming retired built-in tool toggles changes nothing", async () => {
    const env = setup();
    // A pre-#78 row: the read path drops every built-in tool toggle.
    env.store.setAppSecret(
      TOOL_SKILL_POLICY_CONFIG_KEY,
      JSON.stringify({ disabledTools: ["SendMessage", "Workflow", "WebFetch", "Task", "Agent"], disabledSkills: ["code-review"] }),
    );
    expect(env.store.getToolSkillPolicy()).toEqual({ disabledSkills: ["code-review"] });
    const run = await plan(env, env.baseRequest);
    expect(run.caps.toolSkillPolicy).toEqual({ disabledSkills: ["code-review"] });
    expect(run.stamped).not.toHaveProperty("adminDisabledTools");
    expect(run.stamped.adminDisabledSkills).toEqual(["code-review"]);
  });

  it("plumbs the model, effort, and MCP tool-group selection into the run", async () => {
    const env = setup();
    const request: AgentRequest = { ...env.baseRequest, model: "m-sonnet", effort: "high", mcpToolGroups: ["system"] };
    const run = await plan(env, request);
    expect(run.caps.effectiveModel).toBe("m-sonnet");
    expect(run.caps.userEffort).toBe("high");
    // Only the `system` group enabled → only the system family is registered:
    // the system server plus, on this owner run, the to-do server riding it — and
    // the brain server for TEAM-brain recall, which no tool group gates.
    expect(run.servers).toEqual(["system", "todo", "brain"]);

    // …and the gateway receives the picked pi model id as is, and the effort.
    const { client, requests } = fakeClient([() => textTurn("resp_t_1", "ok")]);
    await runPiAgent(request, [], env.config, env.store, makeEvents(), undefined, { client });
    expect(requests[0]).toMatchObject({ model: "m-sonnet", reasoningEffort: "high" });
  });

  it("keeps a turn the external task API submitted a full owner run", async () => {
    const env = setup();
    // Control: the same owner run, typed in the chat.
    const interactive = await plan(env, env.baseRequest);
    // An external system's instruction is still a FULL owner run: provenance
    // changes what the turn input says, never which owner servers register.
    const external = await plan(env, { ...env.baseRequest, externalTaskApi: true });
    expect(external.servers).toContain("system");
    expect(external.servers).toContain("repo");
    expect(external.caps.ownerToolAccess).toBe(true);
    // The provenance rides THAT turn's input, never the frozen append.
    expect(external.turn).toContain("EXTERNAL SYSTEM");
    expect(interactive.turn).not.toContain("EXTERNAL SYSTEM");
    expect(external.append).not.toContain("submitted by an **EXTERNAL SYSTEM**");
  });

  it("stamps the configured task API budget into an owner run", async () => {
    // 90, not the 300-minute default: the stamp must carry the live config.
    const env = setup({ avatarTaskRunTimeoutMs: 90 * 60_000 });
    const api = await plan(env, { ...env.baseRequest, externalTaskApi: true });
    expect(api.turn).toContain("This run has a hard wall-clock budget of 90 minutes");
    expect(api.append).toContain("Each task may run for up to 90 minutes");

    // An interactive owner run hears the standing fact, never the per-run one.
    const chat = await plan(env, env.baseRequest);
    expect(chat.append).toContain("Each task may run for up to 90 minutes");
    expect(chat.turn).not.toContain("hard wall-clock budget");
  });

  it("registers the brain + canvas servers when a repo is connected and a canvas sink exists", async () => {
    const env = setup();
    env.store.setKnowledgeRepo(env.owner.id, "owner/kb", "main");
    // No opt-in: the canvas graduated from the experimental flag.
    const events = makeEvents({ onCanvas: vi.fn(async () => ({ behavior: "shown" as const })) });
    const run = await plan(env, env.baseRequest, events);
    // repoConfigured + elevated → second brain; canvas tool group + onCanvas sink → canvas.
    expect(run.servers).toEqual(expect.arrayContaining(["brain", "canvas", "repo"]));
    expect(run.allowed).toContain("mcp__canvas__show");
  });

  it("gates the experimental canvas `widget` on the AVATAR OWNER's flag, on both surfaces and in the handler", async () => {
    const WIDGET_NUDGE = "The experimental `widget` content type was ON for this avatar when this conversation started: use it UNPROMPTED";
    const env = setup();
    const onCanvas = vi.fn(async (_request: { contentType: string }) => ({ behavior: "shown" as const }));
    const WIDGET = '{@state n = 1}\n<slider label="n" value={n} onChange={setN} min={1} max={9} />\n<stat label="double" value={n * 2} />';
    // One call per server of a planned run, through real MCP (zod included).
    const call = async (request: AgentRequest, server: "canvas" | "system", name: string, args: Record<string, unknown>) => {
      const run = await plan(env, request, makeEvents({ onCanvas }));
      const built = run.caps.inProcessMcpServers[server] as unknown as { instance: McpServer };
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await built.instance.connect(b);
      await client.connect(a);
      try {
        const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        return { run, isError: Boolean(result.isError), text: result.content[0]!.text };
      } finally {
        await client.close();
      }
    };
    const showWidget = (request: AgentRequest) => call(request, "canvas", "show", { title: "배수", content: WIDGET, contentType: "widget" });
    const canvasLine = async (request: AgentRequest) =>
      (await call(request, "system", "describe_system", {})).text.split("\n").find((l) => l.startsWith("- Visual canvas")) ?? "";

    // Off by default: the static catalog still lists the type, the handler refuses it.
    const refused = await showWidget(env.baseRequest);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("experimental feature the avatar owner has not turned on (Settings → 실험 기능)");
    expect(onCanvas).not.toHaveBeenCalled();
    expect(await canvasLine(env.baseRequest)).toContain("contentType 'widget' (experimental; renders inline in the answer, not in the side panel, and recomputes locally): DISABLED");
    // No standing nudge either: on an avatar without the feature it would only buy refused calls.
    expect(refused.run.append).toContain("**Visual canvas** is available via `mcp__canvas__show`.");
    expect(refused.run.append).not.toContain(WIDGET_NUDGE);
    // Tool registration is unchanged by the flag — it is a content type, not a tool.
    expect(refused.run.allowed).toContain("mcp__canvas__show");
    expect(refused.run.allowed.filter((n) => n.startsWith("mcp__canvas__"))).toEqual(["mcp__canvas__show"]);

    // The owner turns it on: the SAME call goes through and both surfaces say so.
    env.store.updateProfile(env.owner.id, { experimentalFeatures: ["canvasWidget"] });
    const shown = await showWidget(env.baseRequest);
    expect(shown.isError, shown.text).toBe(false);
    expect(shown.text).toContain("recomputes locally in the user's browser");
    expect(onCanvas).toHaveBeenCalledTimes(1);
    expect(onCanvas.mock.calls[0]![0]).toMatchObject({ contentType: "widget", awaitInput: false });
    // A widget is drawn inline where the tool ran: the run stamps the answer-text
    // anchor (this plan's accessor reads 0) — a panel canvas carries none.
    expect(onCanvas.mock.calls[0]![0]).toHaveProperty("anchor", 0);
    expect((await call(env.baseRequest, "canvas", "show", { title: "메모", content: "# hi", contentType: "markdown" })).isError).toBe(false);
    expect(onCanvas.mock.calls[1]![0]).toMatchObject({ contentType: "markdown" });
    expect(onCanvas.mock.calls[1]![0]).not.toHaveProperty("anchor");
    expect(shown.text).toContain("The widget was shown INLINE in your answer, at this point of the text (not in the side panel)");
    expect(await canvasLine(env.baseRequest)).toContain("ENABLED for this avatar");
    // The standing guidance now tells the avatar to reach for it unprompted — and where it appears.
    expect(shown.run.append).toContain(WIDGET_NUDGE);
    expect(shown.run.append).toContain("It renders INLINE in your answer where you call it (not in the side panel)");
    expect(shown.run.append).toContain("if `describe_system` says the type is DISABLED, do not use it.");
    // The frozen prompt carries the owner's enabled feature list (owner-driven turns).
    expect(shown.run.append).toContain("Enabled experimental (beta) features for this avatar: `canvasWidget`");

    // It is the avatar OWNER's flag: a teammate chatting with this avatar gets
    // widgets too (canvases reach every viewer class), without the owner-only
    // feature list in their prompt.
    const mate: AgentRequest = { ...env.baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true };
    const mateShown = await showWidget(mate);
    expect(mateShown.isError, mateShown.text).toBe(false);
    expect(await canvasLine(mate)).toContain("ENABLED for this avatar");
    expect(mateShown.run.append).not.toContain("Enabled experimental (beta) features");
    // …but with the same standing nudge: the widget works on their run too.
    expect(mateShown.run.append).toContain(WIDGET_NUDGE);

    // A run with no canvas sink (a routine, a headless generator) has no canvas at all —
    // no server, no tool, no widget nudge — whatever the owner's flag says.
    const routine = await plan(env, { ...env.baseRequest, headless: true, allowHeadlessTools: true }, makeEvents());
    expect(routine.servers).not.toContain("canvas");
    expect(routine.allowed).not.toContain("mcp__canvas__show");
    expect(routine.append).not.toContain(WIDGET_NUDGE);
    expect(routine.append).not.toContain("**Visual canvas** is available");
  });

  it("registers file_output only when an interactive file sink is present", async () => {
    const env = setup();
    const onFile = vi.fn(async () => ({
      behavior: "shown" as const,
      attachment: { id: "out-1", kind: "image" as const, mediaType: "image/png" as const },
      url: "/api/conversations/c1/images/out-1",
    }));
    const run = await plan(env, env.baseRequest, makeEvents({ onFile }));
    expect(run.servers).toContain("file_output");
    expect(run.allowed).toContain("mcp__file_output__show_file");
    expect(run.allowed).toContain("mcp__file_output__share_file");
    expect(run.append).toContain("mcp__file_output__show_file");
    // A file sink alone never brings create_share_link: that needs the host's
    // onShareLink too (tests/agent-share-link.test.ts has the full matrix).
    expect(run.allowed).not.toContain("mcp__file_output__create_share_link");
  });

  it("registers no group repo or group brain server (both retired 2026-10-30) and states the single team", async () => {
    const env = setup();
    env.store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const run = await plan(env, env.baseRequest);
    expect(run.servers).not.toContain("group_repo");
    expect(run.servers).not.toContain("group_brain");
    expect(run.allowed.some((name) => name.startsWith("mcp__group_"))).toBe(false);
    // The team section states the single team, its size and that there is no shared repository.
    expect(run.append).toContain("Noah serves a single team: every approved user is a teammate.");
    expect(run.append).toContain("Team size when this conversation started: 1 teammate besides the owner");
    expect(run.append).toContain("The old per-GROUP knowledge repositories and per-group brain were removed with groups");
    // …and the ONE team brain is stated as readable (no card sink in this plan → no proposing).
    expect(run.append).toContain("**Team brain**: the team's ONE shared knowledge vault");
    expect(run.append).not.toContain("avatar sharing off");
  });

  it("allows ask_avatar ONLY on owner-driven runs and never inside a consultation", async () => {
    const env = setup();
    env.store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const ASK = "mcp__avatars__ask_avatar";

    // Owner chat with a teammate → the consultation tool is allow-listed.
    expect((await plan(env, env.baseRequest)).allowed).toContain(ASK);
    // A consultation run must never re-register it (the depth guard)...
    expect((await plan(env, { ...env.baseRequest, avatarConsultation: true })).allowed).not.toContain(ASK);
    // ...nor a teammate turn (not owner-driven)...
    expect(
      (await plan(env, { ...env.baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true })).allowed,
    ).not.toContain(ASK);
    // ...nor a restricted headless run (intro/hashtag generation).
    expect((await plan(env, { ...env.baseRequest, headless: true })).allowed).not.toContain(ASK);
    // An owner routine keeps it, and waits for the answer (no live steer channel).
    const routine = await plan(env, { ...env.baseRequest, headless: true, allowHeadlessTools: true });
    expect(routine.allowed).toContain(ASK);
    expect(routine.caps.piRuntimeFacts.asyncAskAvatar).toBe(false);
  });

  it("keeps ask_avatar out when the owner has no active teammate (no reachable target)", async () => {
    const env = setup();
    // A suspended (pending) user is no one's teammate.
    const pending = env.store.createUser({ username: "pending", displayName: "Pending", password: "password123" });
    env.store.setSuspended(pending.id, true);
    const run = await plan(env, env.baseRequest);
    expect(run.allowed).not.toContain("mcp__avatars__ask_avatar");
    // The discovery tool itself stays available.
    expect(run.allowed).toContain("mcp__avatars__search_avatars");
  });

  it("relays no plugin MCP server on a consultation run (registration is its only gate)", async () => {
    const env = setup();
    // A plugin bundled with Noah: the one root whose stdio servers a pi run may start.
    const rootDir = path.join(env.config.defaultPluginsDir, "consult-plugin");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { corp: { command: "node", args: ["server.js"] } } }),
    );
    const roots: PluginRoot[] = [{ type: "local", path: rootDir }];

    // Control: a normal owner run relays the plugin server.
    const owner = await plan(env, env.baseRequest, makeEvents(), roots);
    expect(owner.caps.piMcpProxies.facts.pluginServers).toEqual(["corp"]);
    expect(owner.caps.piMcpProxies.upstreams.map((u) => `${u.proxy}/${u.name}`)).toEqual(["plugins/corp"]);

    // A consultation run (trusted-colleague viewer class) relays NO plugin servers.
    const consultation = await plan(
      env,
      {
        ...env.baseRequest,
        avatarConsultation: true,
        viewerUserId: "asker-id",
        viewerIsOwner: false,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
      },
      makeEvents(),
      roots,
    );
    expect(consultation.caps.piMcpProxies.facts.pluginServers).toEqual([]);
    expect(consultation.caps.piMcpProxies.upstreams).toEqual([]);
    expect(consultation.caps.piRuntimeFacts.sandboxOwner).toBe("nobody");
  });

  it("redacts a BROWSER-typeable secret from every result, and only the opted-in names", async () => {
    // Browser input is its own exposure path: the value reaches the user's
    // browser, so a page echoing it back must not print it in the next
    // snapshot — the endpoint redacts `piRedactions` from every Noah result.
    const env = setup();
    env.store.setUserSecret(env.owner.id, "LOGIN_PW", "hunter2-corp-secret");
    env.store.setUserSecret(env.owner.id, "OTHER_KEY", "unrelated-vault-value");
    env.store.setSecretBrowserPolicy(env.owner.id, "LOGIN_PW", { enabled: true, hosts: ["jira.corp.com"], passwordOnly: true });
    const run = await plan(env, env.baseRequest, makeEvents({ onBrowser: vi.fn() }));
    expect(run.caps.browserActive).toBe(true);
    expect(run.caps.piRedactions).toEqual({ LOGIN_PW: "hunter2-corp-secret" });
    const leaked = { content: [{ type: "text", text: "log line: hunter2-corp-secret / unrelated-vault-value" }] };
    const out = JSON.stringify(redactSecretValues(leaked, run.caps.piRedactions).value);
    expect(out).toContain("[REDACTED:LOGIN_PW]");
    expect(out).not.toContain("hunter2-corp-secret");
    // A vault secret the owner did NOT opt into browser input stays out of the
    // redaction set: this run exposes it nowhere, and redacting it would only
    // shred unrelated output.
    expect(out).toContain("unrelated-vault-value");
  });

  it("redacts no browser secret when the bridge is not in this run", async () => {
    // The policy exists, but with no browser sink there is nothing to type it
    // into — so nothing is exposed and nothing needs redacting.
    const env = setup();
    env.store.setUserSecret(env.owner.id, "LOGIN_PW", "hunter2-corp-secret");
    env.store.setSecretBrowserPolicy(env.owner.id, "LOGIN_PW", { enabled: true, hosts: ["jira.corp.com"], passwordOnly: true });
    const run = await plan(env, env.baseRequest);
    expect(run.caps.browserActive).toBe(false);
    expect(run.caps.piRedactions).toEqual({});
  });

  it("hands the owner's 셸 노출 secrets to bash ONLY on owner runs in the owner's sandbox", async () => {
    const env = setup();
    env.store.setUserSecret(env.owner.id, "API_TOKEN", "owner-shell-secret-1");
    env.store.setUserSecret(env.owner.id, "HTTPS_PROXY", "http://reserved.invalid");
    env.store.setUserSecret(env.owner.id, "NOT_EXPOSED", "vault-only-value");
    env.store.setSecretShellExpose(env.owner.id, "API_TOKEN", true);
    env.store.setSecretShellExpose(env.owner.id, "HTTPS_PROXY", true);

    // Owner chat, owner routine and the external task API: the flagged secret pi
    // accepts, never the unflagged one nor a name pi's sandbox reserves.
    for (const request of [
      env.baseRequest,
      { ...env.baseRequest, headless: true, allowHeadlessTools: true },
      { ...env.baseRequest, externalTaskApi: true },
    ]) {
      const run = await plan(env, request);
      expect(run.caps.piSandboxEnv).toEqual({ API_TOKEN: "owner-shell-secret-1" });
      expect(run.caps.piRuntimeFacts.shellSecretNames).toEqual(["API_TOKEN"]);
      // Bash can copy the value into a file a Noah tool reads: it joins the redaction set.
      expect(run.caps.piRedactions).toMatchObject({ API_TOKEN: "owner-shell-secret-1" });
      expect(run.append).toContain("`API_TOKEN` is set to 셸 노출 and present as `$NAME`");
      expect(run.append).toContain("`HTTPS_PROXY` is set to 셸 노출 but NOT in the shell");
    }

    // A colleague's chat, a consultation and a restricted generator: nothing.
    for (const request of [
      { ...env.baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      { ...env.baseRequest, avatarConsultation: true, viewerUserId: "asker-id", viewerIsOwner: false, elevated: true, headless: true, allowHeadlessTools: true },
      { ...env.baseRequest, headless: true },
    ]) {
      const run = await plan(env, request);
      expect(run.caps.piSandboxEnv).toEqual({});
      expect(run.caps.piRuntimeFacts.shellSecretNames).toEqual([]);
      expect(JSON.stringify(run.caps.piRedactions)).not.toContain("owner-shell-secret-1");
      expect(run.append).not.toContain("owner-shell-secret-1");
    }

    // The wire: the owner run's pi request carries it, a colleague's does not.
    const owner = fakeClient([() => textTurn("resp_env_1", "ok")]);
    await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client: owner.client });
    expect(owner.requests[0]!.sandboxEnv).toEqual({ API_TOKEN: "owner-shell-secret-1" });
    const colleague = fakeClient([() => textTurn("resp_env_2", "ok")]);
    await runPiAgent(
      { ...env.baseRequest, conversationId: "conv-2", viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      env.config,
      env.store,
      makeEvents(),
      undefined,
      { client: colleague.client },
    );
    expect(colleague.requests[0]!.sandboxEnv).toBeUndefined();
  });
});

// ===========================================================================
// The pi run loop: fallback, self-heal, empty and failed turns, image turns
// (the rest — sessions, rewinds, steers, the endpoint — lives in pi-runner.test.ts)
// ===========================================================================
describe("pi run loop (fake gateway)", () => {
  const routine = (env: Env): AgentRequest => ({
    ...env.baseRequest,
    headless: true,
    allowHeadlessTools: true,
    modelFallback: true,
    model: "m-opus",
  });

  it("falls back once onto pi-gateway's default model on a transient error, says so, and resets the reasoning view", async () => {
    const env = setup();
    const events = makeEvents();
    const { client, requests } = fakeClient([
      () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
      () => textTurn("resp_fb_1", "fell back"),
    ]);
    const response = await runPiAgent(routine(env), [], env.config, env.store, events, undefined, {
      client,
      retry: { attempts: 1 },
    });
    expect(requests.map((r) => r.model)).toEqual(["m-opus", undefined]);
    expect(events.onStatus).toHaveBeenCalledWith("모델을 기본 모델(으)로 전환해 다시 시도 중…");
    expect(events.onThinkingReset).toHaveBeenCalledTimes(1);
    expect(response.text).toBe("fell back");
  });

  it("resolves pick > pi's default, the pick only while pi offers it; a run on the default gets ONE attempt", async () => {
    const env = setup();
    // A stored admin override from an older release is never consulted (retired).
    env.store.setAppSecret("agent_model_override", "m-haiku");
    expect((await plan(env, routine(env))).caps).toMatchObject({ effectiveModel: "m-opus", userModel: "m-opus" });
    // No pick, or one pi does not offer (a legacy tier alias) → pi's default model, one attempt.
    for (const model of [undefined, "opus"]) {
      const run = await plan(env, { ...routine(env), model });
      expect(run.caps.effectiveModel).toBeUndefined();
      expect(run.caps.userModel).toBeUndefined();
      expect(run.caps.modelChain).toEqual([undefined]);
    }
  });

  // User decision 2026-11-06: with no pick Noah runs pi's `falcon` tier while pi
  // offers it; pi itself is untouched (no tier → pi's own default, as before).
  it("runs Noah's default `falcon` tier when nothing is picked, and falls back from it onto pi's default", async () => {
    const env = setup({}, [...PI_MODELS, "falcon"]);
    const chat = await plan(env, env.baseRequest);
    expect(chat.caps.userModel).toBeUndefined();
    expect(chat.caps.effectiveModel).toBe("falcon");
    expect(chat.caps.modelChain).toEqual(["falcon"]);
    // An unattended run keeps its ONE fallback onto pi's own default.
    expect((await plan(env, { ...routine(env), model: undefined })).caps.modelChain).toEqual(["falcon", undefined]);
    // A pick still wins.
    expect((await plan(env, routine(env))).caps.effectiveModel).toBe("m-opus");
    // A fresh session names the tier (pi would otherwise use ITS default).
    const { client, requests } = fakeClient([() => textTurn("resp_falcon_1", "hi")]);
    await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client });
    expect(requests.map((r) => r.model)).toEqual(["falcon"]);
  });

  // Review: the fallback entry is pi's OWN default — its effort is clamped for
  // THAT model, never for falcon (pi would 400 an effort its default lacks).
  it("clamps the fallback attempt's effort for pi's default, not for falcon", async () => {
    const env = setup();
    piServicesFor(env.store, env.config).models = createPiModelCatalog({
      listModels: async () => [
        { id: "falcon", reasoning: { efforts: ["low", "high", "xhigh"], defaultEffort: "high" } },
        { id: "small", default: true, reasoning: { efforts: ["low", "high"], defaultEffort: "high" } },
      ],
    });
    const { client, requests } = fakeClient([
      () => new PiGatewayError("unavailable", { status: 503, retryable: true }),
      () => textTurn("resp_fb_effort", "fell back"),
    ]);
    await runPiAgent({ ...routine(env), model: undefined, effort: "xhigh" }, [], env.config, env.store, makeEvents(), undefined, {
      client,
      retry: { attempts: 1 },
    });
    expect(requests.map((r) => [r.model, r.reasoningEffort])).toEqual([
      ["falcon", "xhigh"],
      [undefined, "high"],
    ]);
  });

  it("never falls back onto the same model: falcon that IS pi's default gets one attempt", async () => {
    const env = setup();
    piServicesFor(env.store, env.config).models = createPiModelCatalog({
      listModels: async () => [{ id: "falcon", default: true }, { id: "m-opus" }],
    });
    const caps = (await plan(env, { ...routine(env), model: undefined })).caps;
    expect(caps.effectiveModel).toBe("falcon");
    expect(caps.modelChain).toEqual(["falcon"]);
  });

  it("treats every stored model as the default while pi's list is unavailable", async () => {
    const env = setup({}, []);
    const run = await plan(env, routine(env));
    expect(run.caps.effectiveModel).toBeUndefined();
    expect(run.caps.modelChain).toEqual([undefined]);
  });

  it("does NOT fall back on a non-retryable error even when the chain has a default to fall back on", async () => {
    const env = setup();
    const { client, requests } = fakeClient([() => new PiGatewayError("bad_request", { status: 400, code: "invalid_input" })]);
    await expect(
      runPiAgent(routine(env), [], env.config, env.store, makeEvents(), undefined, { client, retry: { attempts: 1 } }),
    ).rejects.toMatchObject({ kind: "bad_request" });
    expect(requests).toHaveLength(1);
  });

  it("propagates a transient error when there is no fallback chain (chat behavior)", async () => {
    const env = setup();
    const { client, requests } = fakeClient([() => new PiGatewayError("unavailable", { status: 503, retryable: true })]);
    await expect(
      runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client, retry: { attempts: 1 } }),
    ).rejects.toMatchObject({ kind: "unavailable" });
    expect(requests).toHaveLength(1);
  });

  it("does NOT self-heal a lost session when the run was aborted (propagates the error)", async () => {
    const env = setup();
    const abort = new AbortController();
    const { client, requests } = fakeClient([
      () => {
        abort.abort();
        return new PiGatewayError("not_found", { status: 404 });
      },
    ]);
    await expect(
      runPiAgent(
        { ...env.baseRequest, resumeSessionId: "resp_old_1", conversationHistory: [{ role: "user", content: "q" }] },
        [],
        env.config,
        env.store,
        makeEvents(),
        abort,
        { client },
      ),
    ).rejects.toMatchObject({ kind: "aborted" });
    // No second, history-carrying request: the stopped run stays stopped.
    expect(requests).toHaveLength(1);
  });

  it("answers with the empty-response message when pi returns no text", async () => {
    const env = setup();
    const { client } = fakeClient([() => textTurn("resp_e_1", "")]);
    const response = await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client });
    expect(response.text).toBe(EMPTY_PI_RESPONSE_MESSAGE);
    expect(response.resultError).toBeUndefined();
  });

  it("keeps the streamed partial text on an incomplete turn, and the friendly Korean error without any text", async () => {
    const env = setup();
    const incomplete = (id: string, text: string): PiStreamEvent[] => [
      ev("response.created", { response: { id, model: "fake-model" } }),
      ...(text
        ? [
            ev("response.output_item.added", { item: { type: "message", id: `${id}-m` } }),
            ev("response.output_text.delta", { delta: text }),
          ]
        : []),
      ev("response.incomplete", { response: { id, status: "incomplete", incomplete_details: { reason: "max_tool_calls" } } }),
    ];
    const partial = fakeClient([() => incomplete("resp_i_1", "partial answer")]);
    const kept = await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client: partial.client });
    expect(kept.text).toBe("partial answer");
    expect(kept.resultError).toBeUndefined();

    const bare = fakeClient([() => incomplete("resp_i_2", "")]);
    const friendly = await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents(), undefined, { client: bare.client });
    expect(friendly.text).toBe(resultErrorMessage("error_max_turns"));
    expect(friendly.text).toContain("최대 처리 단계");
    expect(friendly.resultError).toBe("error_max_turns");
  });

  it("sends a turn's images with its first input", async () => {
    const env = setup();
    const { client, requests } = fakeClient([() => textTurn("resp_img_1", "saw the image")]);
    const response = await runPiAgent(
      { ...env.baseRequest, images: [{ mediaType: "image/png", data: "AAAA" }] },
      [],
      env.config,
      env.store,
      makeEvents(),
      undefined,
      { client },
    );
    expect(requests[0]!.input).toMatchObject({ kind: "prompt", images: [{ mediaType: "image/png", data: "AAAA" }] });
    expect(inputText(requests[0]!)).toContain("User message:\n안녕하세요");
    expect(response.text).toBe("saw the image");
  });

  it("tells the model it can be interrupted only when the run really has a channel", async () => {
    const env = setup();
    const MID_TURN = "They are delivered DURING your work";
    const withChannel = fakeClient([() => textTurn("resp_c_1", "ok")]);
    await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents({ steers: new SteerChannel() }), undefined, {
      client: withChannel.client,
    });
    expect(inputText(withChannel.requests[0]!)).toContain(MID_TURN);

    env.store.touchConversation(env.owner.id, "conv-2", env.owner.id, "x");
    const without = fakeClient([() => textTurn("resp_c_2", "ok")]);
    await runPiAgent({ ...env.baseRequest, conversationId: "conv-2" }, [], env.config, env.store, makeEvents(), undefined, {
      client: without.client,
    });
    expect(inputText(without.requests[0]!)).not.toContain(MID_TURN);
  });

  it("closes the steer channel at a steer-free boundary, so a late message is refused", async () => {
    const env = setup();
    const steers = new SteerChannel();
    const { client } = fakeClient([() => textTurn("resp_s_1", "done")]);
    await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents({ steers }), undefined, { client });
    expect(steers.closed).toBe(true);
    expect(steers.push("too late")).toBeFalsy();
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
    expect(submitResponse("sr-1", "req", "u", { answers: { "Color?": "Blue" } })).toBe(true);
    await expect(parked).resolves.toEqual({ answers: { "Color?": "Blue" } });
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

  it("pushRunSteer queues a mid-turn message and refuses every state the route maps to a status", () => {
    expect(pushRunSteer("ghost", "u", "hi")).toEqual({ ok: false, reason: "not_found" });
    // A run without a channel (an external-task-API turn) cannot be steered.
    openRun("ps-0", "u");
    expect(pushRunSteer("ps-0", "u", "hi")).toEqual({ ok: false, reason: "unsupported" });
    closeRun("ps-0");

    const steers = new SteerChannel();
    openRun("ps-1", "u", { steers });
    expect(pushRunSteer("ps-1", "intruder", "hi")).toEqual({ ok: false, reason: "not_found" });
    const pushed = pushRunSteer("ps-1", "u", "also check the logs");
    expect(pushed).toMatchObject({ ok: true, steer: { text: "also check the logs" } });
    expect(steers.undelivered().map((s) => s.text)).toEqual(["also check the logs"]);
    // Past the cap of undelivered messages the next one is refused.
    let last: ReturnType<typeof pushRunSteer> = pushed;
    for (let i = 0; i < 50 && last.ok; i += 1) last = pushRunSteer("ps-1", "u", `more ${i}`);
    expect(last).toEqual({ ok: false, reason: "too_many" });
    // A closed channel (the turn is wrapping up) refuses too.
    steers.close();
    expect(pushRunSteer("ps-1", "u", "late")).toEqual({ ok: false, reason: "closed" });
    closeRun("ps-1");

    // A cancelled run refuses even while its channel is open.
    openRun("ps-2", "u", { steers: new SteerChannel() });
    cancelRun("ps-2", "u");
    expect(pushRunSteer("ps-2", "u", "late")).toEqual({ ok: false, reason: "closed" });
    closeRun("ps-2");
  });

  it("getRunPrompts returns only the still-pending question and canvas prompts, scoped to the owner", () => {
    openRun("gp-1", "u");
    const question = awaitResponse("gp-1", "q-1");
    void awaitResponse("gp-1", "c-1");
    emitRunEvent("gp-1", "question", { requestId: "q-1", questions: [] });
    emitRunEvent("gp-1", "canvas", { requestId: "c-1", title: "보드" });
    emitRunEvent("gp-1", "status", { label: "x", requestId: "q-1" });
    emitRunEvent("gp-1", "question", { requestId: "never-parked" });
    expect(getRunPrompts("gp-1", "u").map((p) => p.event)).toEqual(["question", "canvas"]);
    expect(getRunPrompts("gp-1", "intruder")).toEqual([]);
    // An answered prompt drops out.
    expect(submitResponse("gp-1", "q-1", "u", { answers: {} })).toBe(true);
    expect(getRunPrompts("gp-1", "u")).toEqual([{ event: "canvas", data: { requestId: "c-1", title: "보드" } }]);
    void question;
    closeRun("gp-1");
    expect(getRunPrompts("gp-1", "u")).toEqual([]);
  });
});
