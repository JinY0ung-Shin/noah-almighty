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
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { piEphemeralRunKey, piRunPrincipal, piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { EMPTY_PI_RESPONSE_MESSAGE, runPiAgent } from "../src/server/agent/pi/runPiAgent.js";
import {
  PiGatewayError,
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
  it("retains system tools when an old admin policy blocks every optional group", async () => {
    const env = setup();
    vi.spyOn(env.store, "allowedMcpToolGroupsForUser").mockReturnValue([]);
    const run = await plan(env, env.baseRequest);
    expect(run.servers).toContain("system");
    expect(run.servers).not.toContain("web");
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
    for (const absent of ["canvas", "brain", "group_repo", "ssh_trust", "browser", "file_output"]) {
      expect(run.servers).not.toContain(absent);
    }
    // Every built server is one pi's broker knows; nothing is relayed for this run.
    expect(run.caps.piMcpProxies.upstreams).toEqual([]);
    expect(run.caps.piRuntimeFacts.sandboxOwner).toBe("owner");
  });

  it("a stored policy still naming the retired SendMessage/Workflow toggles changes nothing", async () => {
    const env = setup();
    // A pre-retirement row: the read path normalizes the retired names away.
    env.store.setAppSecret(
      TOOL_SKILL_POLICY_CONFIG_KEY,
      JSON.stringify({ disabledTools: ["SendMessage", "Workflow", "WebFetch"], disabledSkills: [] }),
    );
    expect(env.store.getToolSkillPolicy().disabledTools).toEqual(["WebFetch"]);
    const run = await plan(env, env.baseRequest);
    // Both surfaces read the normalized list (advisory on pi).
    expect(run.caps.toolSkillPolicy.disabledTools).toEqual(["WebFetch"]);
    expect(run.stamped.adminDisabledTools).toEqual(["WebFetch"]);
  });

  it("plumbs the model, effort, and MCP tool-group selection into the run", async () => {
    const env = setup();
    const request: AgentRequest = { ...env.baseRequest, model: "m-sonnet", effort: "high", mcpToolGroups: ["system"] };
    const run = await plan(env, request);
    expect(run.caps.effectiveModel).toBe("m-sonnet");
    expect(run.caps.userEffort).toBe("high");
    // Only the `system` group enabled → only the system family is registered:
    // the system server plus, on this owner run, the to-do server riding it.
    expect(run.servers).toEqual(["system", "todo"]);

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

  it("registers no group repo or team brain server for a group admin (both retired 2026-10-30)", async () => {
    const env = setup();
    const group = env.store.createGroup({ name: "팀" });
    env.store.addGroupMember(group.id, env.owner.id, "admin");
    const run = await plan(env, env.baseRequest);
    expect(run.servers).not.toContain("group_repo");
    expect(run.servers).not.toContain("group_brain");
    expect(run.allowed.some((name) => name.startsWith("mcp__group_"))).toBe(false);
    // The groups section still states the group and that it has no repository.
    expect(run.append).toContain("팀(admin)");
    expect(run.append).toContain("Groups have NO shared knowledge repository");
  });

  it("allows ask_avatar ONLY on owner-driven runs and never inside a consultation", async () => {
    const env = setup();
    const group = env.store.createGroup({ name: "팀" });
    env.store.addGroupMember(group.id, env.owner.id, "member");
    const ASK = "mcp__avatars__ask_avatar";

    // Owner chat with a group → the consultation tool is allow-listed.
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

  it("keeps ask_avatar out when the owner belongs to no group (no reachable target)", async () => {
    const env = setup();
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

  it("resolves pick > admin override > pi's default, each only while pi offers it", async () => {
    const env = setup();
    env.store.setModelOverride("m-haiku");
    // A pick pi offers wins over the override.
    expect((await plan(env, routine(env))).caps).toMatchObject({ effectiveModel: "m-opus", userModel: "m-opus" });
    // No pick, or one pi does not offer (a legacy tier alias) → the override, chained onto the default.
    for (const model of [undefined, "opus"]) {
      const run = await plan(env, { ...routine(env), model });
      expect(run.caps.effectiveModel).toBe("m-haiku");
      expect(run.caps.userModel).toBeUndefined();
      expect(run.caps.modelChain).toEqual(["m-haiku", undefined]);
    }
  });

  it("ignores a stored override pi-gateway does not offer, and a run on the default gets ONE attempt (review-2 M2)", async () => {
    const env = setup();
    // An SDK-era deployment's concrete Claude id, kept across the upgrade.
    env.store.setModelOverride("claude-opus-4-1-20250805");
    const run = await plan(env, { ...routine(env), model: undefined });
    expect(run.caps.effectiveModel).toBeUndefined();
    expect(run.caps.modelChain).toEqual([undefined]);
    expect(run.caps.ownerState.modelOverrideIgnored).toBe("claude-opus-4-1-20250805");
  });

  it("treats every stored model as the default while pi's list is unavailable", async () => {
    const env = setup({}, []);
    env.store.setModelOverride("m-haiku");
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
    const NEXT_TURN = "arrives as the NEXT user turn";
    const withChannel = fakeClient([() => textTurn("resp_c_1", "ok")]);
    await runPiAgent(env.baseRequest, [], env.config, env.store, makeEvents({ steers: new SteerChannel() }), undefined, {
      client: withChannel.client,
    });
    expect(inputText(withChannel.requests[0]!)).toContain(NEXT_TURN);

    env.store.touchConversation(env.owner.id, "conv-2", env.owner.id, "x");
    const without = fakeClient([() => textTurn("resp_c_2", "ok")]);
    await runPiAgent({ ...env.baseRequest, conversationId: "conv-2" }, [], env.config, env.store, makeEvents(), undefined, {
      client: without.client,
    });
    expect(inputText(without.requests[0]!)).not.toContain(NEXT_TURN);
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
