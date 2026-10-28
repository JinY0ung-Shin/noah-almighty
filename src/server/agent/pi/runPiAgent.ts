/**
 * One Noah run on pi-gateway (`AGENT_RUNTIME=pi`, design §6 N3,
 * docs/architecture/pi-runtime.md). Dispatched by `runAgentStream` for the run
 * classes `piRuntimeSupports` accepts; everything else stays on the SDK runner.
 *
 * The run shares the capability plan with the SDK runner (`runCapabilities.ts`)
 * — the same gates, the same in-process MCP servers, the same self-state on
 * both metacognition surfaces — and differs only in how it reaches the model:
 *
 *  1. A run TOKEN is registered with the HTTP MCP endpoint for every Noah
 *     server (built ones serve their calls, the rest are refusing stubs), the
 *     tool list being the static catalog (pi freezes it per session). pi's
 *     broker calls `/mcp/<server>` with it; it is revoked when the run ends.
 *  2. The system prompt is the SDK append rendered with the pi flag and FROZEN
 *     per conversation (design D2): sent as `instructions` only on a session's
 *     first turn. Per-turn facts (date, rewind, task-API provenance) ride the
 *     user input instead.
 *  3. `previous_response_id` = the stored resume point (a `resp_…` id; an SDK
 *     session id from before the switch is ignored → a new session from the
 *     text history). Each committed turn reports its response id as both the
 *     session id and the row's resume point, so a rewind forks from it.
 *  4. A lost session (404/409) self-heals once from the text history; 503/429
 *     at stream open retry with backoff; a model fallback chain (routines, the
 *     task API) gives each attempt a fresh session.
 *  5. pi has no mid-turn input (design P2): steers queue, and once the current
 *     pi response completes they are delivered TOGETHER as a follow-up turn on
 *     the same run (the SDK path's "undelivered steer → turn_end" contract).
 *  6. A model/effort change starts a new session from the text history (pi
 *     fixes both per session, design P3); the user hears it on the status line.
 *  7. hex-ssh, plugin `.mcp.json` and 공용 MCP servers are relayed by Noah as an
 *     MCP client (`mcpProxies.ts`, stable ids `hex-ssh`/`plugins`/`shared`);
 *     every Noah MCP result is redacted at the endpoint with the run's set.
 *  8. A tool that would hold the broker for minutes runs in the background
 *     (design D8, `asyncJobs.ts`): its result is pushed as a steer, and the run
 *     stays open until its jobs settle, so it always arrives as a follow-up turn.
 */
import type { McpServer as McpServerType } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRequest, AgentResponse, AgentUsage, AppConfig, PluginRoot } from "../../types.js";
import type { Store } from "../../store.js";
import type { AgentEvents } from "../events.js";
import logger from "../../logger.js";
import { isEffortLevel } from "../../effortLevels.js";
import type { McpRunRegistry, McpServerSource } from "../../mcpHttp/endpoint.js";
import { buildRunCapabilities, stampPromptRequest } from "../runCapabilities.js";
import {
  PI_FIRST_TURN_HISTORY_LIMITS,
  buildPiTurnPreamble,
  buildSystemPromptAppend,
  buildUserPrompt,
} from "../promptBuilder.js";
import { resultErrorMessage } from "../sdkMessageHandlers.js";
import { PI_MCP_SERVER_NAMES, noahMcpCatalog } from "./mcpCatalog.js";
import { PI_RUN_TOKEN_HEADER, piRuntimeSupports, piServicesFor } from "./piRuntime.js";
import { ensurePiConversationDir, piWorkspaceFor, stagePiAttachmentFiles } from "./piWorkspace.js";
import { materializePiSkills } from "./piSkills.js";
import { PiTurnFailedError, runPiTurn, type PiRunResult } from "./eventAdapter.js";
import { PI_PROXY_SERVER_NAMES, PiMcpProxyPool } from "./mcpProxies.js";
import { PiAsyncJobs } from "./asyncJobs.js";
import { redactSecretValues } from "../postToolUseHook.js";
import { AVATAR_ASK_TIMEOUT_MS } from "../avatarAskShared.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PiGatewayError,
  type PiReasoningEffort,
  type PiResponseRequest,
  type PiResponsesClient,
  type PiRetryOptions,
} from "./responsesClient.js";

const agentLogger = logger.child({ module: "agent" });

export const EMPTY_PI_RESPONSE_MESSAGE = "pi-gateway 응답이 비어 있습니다.";

/** Longest the run stays open for its background jobs after the answer (a consultation's own budget + margin). */
const ASYNC_WAIT_CAP_MS = AVATAR_ASK_TIMEOUT_MS + 30_000;
/** How long run end waits for relayed MCP children to exit before returning (they keep closing after). */
const PROXY_CLOSE_GRACE_MS = 500;

/** Retries of a stream OPEN on 503 capacity / 429 (no turn ran). */
const PI_OPEN_RETRY: Omit<PiRetryOptions, "signal"> = { attempts: 4, baseDelayMs: 2_000, maxDelayMs: 30_000 };

/** pi response ids are `resp_<session uuid>_<turn>`; anything else (an SDK session id) is no pi session. */
export function isPiResponseId(value: string | undefined | null): value is string {
  return typeof value === "string" && /^resp_[A-Za-z0-9-]+_\d+$/.test(value);
}

/** The session part of a response id (the key of the per-session model/effort profile). */
export function piSessionKey(responseId: string): string {
  return responseId.replace(/^resp_/, "").replace(/_\d+$/, "");
}

/** The pi model a NEW session uses for a Noah tier / model id (unmapped → pi's default model). */
function piModelFor(config: AppConfig, model: string | undefined): { model?: string; contextWindow?: number } {
  const mapped = model ? config.pi?.modelMap[model] : undefined;
  return mapped ? { model: mapped.model, ...(mapped.contextWindow ? { contextWindow: mapped.contextWindow } : {}) } : {};
}

/** Noah's effort ids are a subset of pi's REASONING_EFFORTS (low…max). */
function piEffortFor(effort: string | undefined): PiReasoningEffort | undefined {
  return isEffortLevel(effort) ? (effort as PiReasoningEffort) : undefined;
}

/** A server this run did not build: lists nothing of its own (the catalog answers) and every call is refused. */
function stubServer(name: string): () => McpServerType {
  return () => new McpServer({ name, version: "0.1.0" }, { capabilities: { tools: {} } });
}

function refusalMessage(server: string, tool: string): string {
  return (
    `Tool 'mcp__${server}__${tool}' is not available in this run — it needs a tool group, connection, permission or interactive chat this turn does not have. ` +
    "Check mcp__system__describe_system for what this run can use; do not retry it, and do not look for a shell or other workaround."
  );
}

export interface RunPiAgentDeps {
  /** Injected for tests; default: the process's client for `config.pi`. */
  client?: PiResponsesClient;
  /** Injected for tests; default: the registry the `/mcp` router serves. */
  registry?: McpRunRegistry;
  now?: () => Date;
  retry?: Omit<PiRetryOptions, "signal">;
}

export async function runPiAgent(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents | undefined,
  abortController: AbortController | undefined,
  deps: RunPiAgentDeps = {},
): Promise<AgentResponse> {
  const decision = piRuntimeSupports(request);
  if (!decision.supported) {
    throw new Error(`runPiAgent called for a run pi does not support: ${decision.reason}`);
  }
  const principal = decision.principal;
  const conversationId = request.conversationId!;
  const services = piServicesFor(store, config);
  const client = deps.client ?? services.client;
  if (!client) throw new Error("pi-gateway is not configured (PI_GATEWAY_URL / PI_GATEWAY_API_KEY).");
  const registry = deps.registry ?? services.registry;
  const now = deps.now ?? (() => new Date());
  const signal = abortController?.signal;
  const workspace = piWorkspaceFor(config, principal, conversationId);
  ensurePiConversationDir(workspace);
  // Skills as sandbox files (owner runs: every root; a colleague: the bundled
  // ones, plus the owner's through mcp__skills__read). Re-synced each turn by
  // a stat fingerprint; the index rides the frozen instructions.
  const piSkills = materializePiSkills({
    config,
    workspace,
    pluginRoots,
    ownerRun: principal === request.avatar.id,
    disabledSkills: store.getToolSkillPolicy().disabledSkills,
  });
  if (piSkills.failures.length) {
    agentLogger.warn({ conversationId, failures: piSkills.failures }, "pi runtime: some skill roots could not be copied into the sandbox");
  }

  // Answer text of the CURRENT segment since the last fold — the attachment
  // anchor (see runCapabilities' currentTextAnchor). Reset on a fold and at a
  // steer boundary, exactly where the SDK loop moves its fold index.
  let anchorText = "";
  // Background jobs of this run (ask_avatar in an interactive chat): a result
  // rides the steer channel — the model text (with its provenance) + the Korean
  // bubble + WHO answered, so the route persists it as that avatar's row, never
  // as the owner's — and becomes a follow-up turn below.
  const steerChannel = events?.steers;
  const asyncJobs = steerChannel
    ? new PiAsyncJobs((delivery) =>
        Boolean(steerChannel.push(delivery.agentText, { displayText: delivery.displayText, source: delivery.source })),
      )
    : undefined;
  const capabilities = await buildRunCapabilities(
    request,
    pluginRoots,
    config,
    store,
    events,
    abortController,
    () => anchorText.length,
    {
      runtime: "pi",
      piConversationDir: workspace.conversationDir,
      piWorkspace: workspace,
      piSkills,
      ...(asyncJobs ? { piAsyncJobs: asyncJobs } : {}),
    },
  );
  const promptRequest = stampPromptRequest(request, capabilities, config, events);
  const effort = piEffortFor(capabilities.userEffort);
  // The model chain is the SDK's tier chain (one entry unless the run opted
  // into fallback); each entry maps to the pi model a FRESH session uses.
  const chain = capabilities.modelChain.map((model) => ({ noah: model, ...piModelFor(config, model) }));
  let attempt = 0;
  const profileOf = (index: number) => `${chain[index]?.model ?? ""}|${effort ?? ""}`;

  // ---- session ------------------------------------------------------------
  const resumeCandidate = request.resumeSessionAt ?? request.resumeSessionId;
  let previous: string | undefined = isPiResponseId(resumeCandidate) ? resumeCandidate : undefined;
  // The chat route starts image turns fresh (an SDK streaming-input limit);
  // pi takes images on a continued session, so continue the stored one —
  // unless this is a rewind, whose resume point the route already chose.
  if (!previous && !request.rewind && request.images?.length) {
    const stored = store.getAgentSessionId(principal, conversationId);
    if (isPiResponseId(stored)) previous = stored;
  }
  let newSessionReason: "model_changed" | "session_lost" | undefined;
  if (previous) {
    const known = store.getConversationPiSessionProfile(principal, conversationId, piSessionKey(previous));
    if (known !== null && known !== profileOf(0)) {
      previous = undefined;
      newSessionReason = "model_changed";
      events?.onStatus?.("모델 또는 사고 강도가 바뀌어 새 세션에서 이전 대화 기록으로 이어갑니다…");
    }
  }
  const frozenInstructions = (): string =>
    store.ensureConversationPiInstructions(principal, conversationId, () => buildSystemPromptAppend(promptRequest)) ??
    buildSystemPromptAppend(promptRequest);

  // ---- input --------------------------------------------------------------
  const stagedFiles = request.imageFiles?.length ? stagePiAttachmentFiles(workspace, request.imageFiles) : [];
  const userRequest: AgentRequest = { ...promptRequest, imageFiles: stagedFiles.length ? stagedFiles : undefined };
  const firstInputText = (fresh: boolean): string =>
    [
      buildPiTurnPreamble(promptRequest, { now: now(), ...(fresh && newSessionReason ? { newSessionReason } : {}) }),
      buildUserPrompt(
        // A fresh session carries the stored text history; a continued one has it.
        { ...userRequest, resumeSessionId: fresh ? undefined : (previous ?? "pi") },
        { historyLimits: PI_FIRST_TURN_HISTORY_LIMITS },
      ),
    ].join("\n\n");
  const images = (request.images ?? []).map((image) => ({ mediaType: image.mediaType, data: image.data }));

  // ---- MCP run token ------------------------------------------------------
  const catalog = await noahMcpCatalog(store, config);
  const allowedTools = new Set(capabilities.mcpAllowedTools);
  const built = capabilities.inProcessMcpServers as Record<string, McpServerSource | undefined>;
  // Relayed servers: children start on first use, all closed at run end.
  const proxies = new PiMcpProxyPool(capabilities.piMcpProxies?.upstreams ?? []);
  const proxyNames = new Set<string>(PI_PROXY_SERVER_NAMES);
  const servers: Record<string, McpServerSource> = {};
  for (const name of PI_MCP_SERVER_NAMES) {
    servers[name] = proxyNames.has(name)
      ? proxies.serverFor(name as (typeof PI_PROXY_SERVER_NAMES)[number])
      : (built[name] ?? stubServer(name));
  }
  const redactions = capabilities.piRedactions ?? {};
  const tokenAbort = new AbortController();
  const token = registry.register({
    servers,
    gates: {
      // Noah's own servers answer from the static catalog; a relayed one lists
      // THIS run's tools (undefined → the endpoint asks the server).
      listTools: (server) => catalog[server as keyof typeof catalog],
      allowCall: (server, tool) =>
        proxyNames.has(server) ? proxies.allowsCall(server, tool) : allowedTools.has(`mcp__${server}__${tool}`),
      refusalMessage,
      // Every result leaves Noah redacted: a relayed server echoing a vault
      // value or a header, a page echoing a browser-typed password.
      transformResult: (_server, _tool, result) =>
        Object.keys(redactions).length > 0 ? (redactSecretValues(result, redactions).value as CallToolResult) : result,
    },
    signal: tokenAbort.signal,
    context: { conversationId, principal },
    label: conversationId,
  });

  const steers = events?.steers;
  const contextWindow = chain[0]?.contextWindow;
  // The host sees pi's committed turns as session ids AND resume points (a
  // rewind onto that row forks from it); segment boundaries are this runner's.
  const piEvents: AgentEvents = {
    ...events,
    steers: undefined,
    onDelta: (text) => {
      anchorText += text;
      events?.onDelta?.(text);
    },
    ...(events?.onTextFold
      ? {
          onTextFold: (text: string) => {
            anchorText = "";
            events.onTextFold!(text);
          },
        }
      : {}),
    onSessionId: (responseId) => {
      events?.onSessionId?.(responseId);
      events?.onResumePoint?.({ sessionId: responseId, uuid: responseId });
    },
    onTurnResult: undefined,
  };

  let result: PiRunResult | undefined;
  let usage: AgentUsage | undefined;
  let healed = false;
  try {
    let input: PiResponseRequest["input"] | null = null;
    for (;;) {
      // One pi response (+ its AskUserQuestion round trips).
      for (;;) {
        const fresh = !previous;
        const current = chain[attempt] ?? {};
        const piRequest: PiResponseRequest = {
          user: principal,
          input: input ?? { kind: "prompt", text: firstInputText(fresh), ...(images.length ? { images } : {}) },
          ...(fresh
            ? {
                instructions: frozenInstructions(),
                ...(current.model ? { model: current.model } : {}),
                ...(effort ? { reasoningEffort: effort } : {}),
              }
            : { previousResponseId: previous }),
          headers: { [PI_RUN_TOKEN_HEADER]: token },
        };
        try {
          result = await runPiTurn({
            client,
            request: piRequest,
            events: piEvents,
            ...(signal ? { signal } : {}),
            retry: {
              ...PI_OPEN_RETRY,
              ...deps.retry,
              ...(signal ? { signal } : {}),
              onRetry: () => events?.onStatus?.("pi-gateway가 바빠서 잠시 후 다시 시도하는 중…"),
            },
            ...(contextWindow ? { contextWindow } : {}),
          });
          if (fresh) {
            store.setConversationPiSessionProfile(principal, conversationId, piSessionKey(result.responseId), profileOf(attempt));
          }
          break;
        } catch (error) {
          if (signal?.aborted || input) throw error;
          // The stored session is gone (pi restarted with a wiped DB, another
          // user's id, a session stuck on a question): rebuild from history once.
          if (
            !healed &&
            previous &&
            error instanceof PiGatewayError &&
            (error.kind === "not_found" || error.kind === "conflict")
          ) {
            healed = true;
            agentLogger.warn({ conversationId, previous, kind: error.kind }, "pi session missing; retrying with stored history");
            previous = undefined;
            newSessionReason = "session_lost";
            continue;
          }
          const retryable =
            (error instanceof PiTurnFailedError && error.status !== 500) ||
            (error instanceof PiGatewayError && error.retryable);
          if (retryable && attempt + 1 < chain.length) {
            attempt += 1;
            agentLogger.warn(
              { conversationId, from: chain[attempt - 1]?.noah, to: chain[attempt]?.noah, detail: String(error) },
              "model fallback after transient error",
            );
            previous = undefined;
            events?.onThinkingReset?.();
            events?.onStatus?.(`모델을 ${chain[attempt]?.noah}(으)로 전환해 다시 시도 중…`);
            continue;
          }
          throw error;
        }
      }
      usage = result.usage ?? usage;
      // Background jobs still running (design D8): keep the run open until one
      // delivers (or the user sends a message) — their result is a steer.
      if (asyncJobs && steers && !signal?.aborted && asyncJobs.pending > 0 && steers.undelivered().length === 0) {
        const waitStart = Date.now();
        events?.onStatus?.("팀원 아바타의 답변을 기다리는 중…");
        while (asyncJobs.pending > 0 && steers.undelivered().length === 0 && !signal?.aborted) {
          const left = ASYNC_WAIT_CAP_MS - (Date.now() - waitStart);
          if (left <= 0) break;
          await new Promise<void>((resolve) => {
            let off = (): void => undefined;
            const finish = (): void => {
              off();
              resolve();
            };
            // A push (a job's result or a message the user typed) wakes the run.
            off = steers.onChange((_record, change) => {
              if (change.previous === null) finish();
            });
            void asyncJobs.waitForChange(signal, left).then(finish);
          });
        }
      }
      // Steers that arrived while pi was answering: pi cannot take them
      // mid-response (design P2), so they become ONE follow-up turn. Checked
      // and closed in the same tick so nothing slips between.
      const pending = signal?.aborted ? [] : (steers?.undelivered() ?? []);
      if (pending.length === 0) {
        steers?.close();
        break;
      }
      steers!.noteResultBoundary();
      events?.onTurnResult?.({
        text: result.text,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.errorSubtype ? { errorSubtype: result.errorSubtype } : {}),
        backgroundTasks: [],
        steerPending: true,
      });
      anchorText = "";
      for (const steer of pending) steers!.noteLifecycle(steer.id, "started");
      previous = result.responseId;
      input = {
        kind: "prompt",
        text: [
          buildPiTurnPreamble({ ...promptRequest, rewind: undefined, externalTaskApi: false }, { now: now() }),
          ...pending.map((steer) => steer.text),
        ].join("\n\n"),
      };
      // Loop: the follow-up turn runs as the next pi response of this run.
    }
  } finally {
    steers?.close();
    // A job the run did not wait out (cancel, error) delivers nothing.
    asyncJobs?.abortAll();
    tokenAbort.abort();
    await registry.revoke(token).catch(() => undefined);
    const closing = proxies.close().catch((error: unknown) =>
      agentLogger.warn({ conversationId, err: String(error) }, "pi mcp proxies did not close cleanly"),
    );
    await Promise.race([closing, new Promise((resolve) => setTimeout(resolve, PROXY_CLOSE_GRACE_MS).unref())]);
  }

  const final = result!;
  // Every delivered steer has now been answered.
  for (const steer of steers?.records() ?? []) {
    if (steer.state === "delivered") steers!.noteLifecycle(steer.id, "completed");
  }
  events?.onTurnResult?.({
    text: final.text,
    ...(final.usage ? { usage: final.usage } : {}),
    ...(final.errorSubtype ? { errorSubtype: final.errorSubtype } : {}),
    backgroundTasks: [],
    steerPending: false,
  });
  const text = final.text || (final.errorSubtype ? resultErrorMessage(final.errorSubtype) : EMPTY_PI_RESPONSE_MESSAGE);
  agentLogger.info(
    {
      avatarId: request.avatar.id,
      runtime: "pi",
      model: chain[attempt]?.model ?? null,
      modelFellBack: attempt > 0,
      textLength: text.length,
      durationMs: Date.now() - capabilities.agentStart,
    },
    "agent run completed",
  );
  return {
    kind: "text",
    runtime: "pi",
    summary: "pi-gateway 실행이 완료되었습니다.",
    text,
    ...(final.errorSubtype && !final.text ? { resultError: final.errorSubtype } : {}),
    ...(usage ? { usage } : {}),
  };
}
