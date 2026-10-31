/**
 * One Noah run on pi-gateway (`AGENT_RUNTIME=pi`, design §6 N3,
 * docs/architecture/pi-runtime.md) — the only agent runtime: `runAgentStream`
 * sends every non-`local` run here, in the sandbox of the user it runs AS
 * (`piRunPrincipal`) — or, for an avatar consultation, in a fresh empty sandbox
 * of its own that is removed when the run ends (`beginPiConsultationSandbox`).
 * A run without a conversation (a consultation, a profile generator) uses a
 * run folder (`piEphemeralRunKey`) and always a fresh pi session: nothing is
 * stored for it.
 *
 * The capability plan (`runCapabilities.ts`) decides the gates, the in-process
 * MCP servers and the self-state both metacognition surfaces report; this
 * runner decides how the run reaches the model:
 *
 *  1. A run TOKEN is registered with the HTTP MCP endpoint for every Noah
 *     server (built ones serve their calls, the rest are refusing stubs), the
 *     tool list being the static catalog (pi freezes it per session). pi's
 *     broker calls `/mcp/<server>` with it; it is revoked when the run ends.
 *  2. The system prompt is Noah's append (`buildSystemPromptAppend`), FROZEN
 *     per conversation (design D2): sent as `instructions` only on a session's
 *     first turn. Per-turn facts (date, rewind, task-API provenance) ride the
 *     user input instead.
 *  3. `previous_response_id` = the stored resume point (a `resp_…` id; a CLI
 *     session id left by the removed SDK runner is ignored → a new session
 *     from the text history). Each committed turn reports its response id as both the
 *     session id and the row's resume point, so a rewind forks from it.
 *  4. A lost session (404/409) self-heals once from the text history; 503/429
 *     at stream open retry with backoff; an empty turn (`empty_response`, not
 *     committed by pi) is re-sent once while nothing was shown (a queued steer
 *     waits and follows as its own turn); a model fallback chain (routines,
 *     the task API) gives each attempt a fresh session.
 *  5. pi has no mid-turn input (design P2): steers queue, and once the current
 *     pi response completes they are delivered TOGETHER as a follow-up turn on
 *     the same run (the route's `turn_end` contract).
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
import { unknownArgumentProblem, type McpRunRegistry, type McpServerSource } from "../../mcpHttp/endpoint.js";
import { buildRunCapabilities, stampPromptRequest } from "../runCapabilities.js";
import {
  PI_FIRST_TURN_HISTORY_LIMITS,
  buildPiTurnPreamble,
  buildSystemPromptAppend,
  buildUserPrompt,
} from "../promptBuilder.js";
import { resultErrorMessage } from "../runErrors.js";
import { PI_MCP_SERVER_NAMES, noahMcpCatalog, piKnownTools } from "./mcpCatalog.js";
import {
  PI_RUN_TOKEN_HEADER,
  beginPiConsultationSandbox,
  endPiConsultationSandbox,
  piEphemeralRunKey,
  piRunPrincipal,
  piServicesFor,
} from "./piRuntime.js";
import { ensurePiConversationDir, piWorkspaceFor, stagePiAttachmentFiles } from "./piWorkspace.js";
import { materializePiSkills } from "./piSkills.js";
import { PiTurnFailedError, runPiTurn, type PiRunResult } from "./eventAdapter.js";
import { PI_PROXY_SERVER_NAMES, PiMcpProxyPool } from "./mcpProxies.js";
import { PiAsyncJobs } from "./asyncJobs.js";
import { redactSecretValues } from "../secretRedaction.js";
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

/**
 * A continued session pi cannot run: unknown (404), in a state that does not
 * match (409), or pinned to a model pi no longer has (400
 * `model_not_configured` — pi fixes a session's model at creation, so only a
 * new session can recover). Each self-heals once from the text history.
 */
export function isLostPiSession(error: unknown): error is PiGatewayError {
  return (
    error instanceof PiGatewayError &&
    (error.kind === "not_found" ||
      error.kind === "conflict" ||
      (error.kind === "bad_request" && error.code === "model_not_configured"))
  );
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
  if (!request.avatarConsultation) {
    return runPiAgentAs(piRunPrincipal(request), request, pluginRoots, config, store, events, abortController, deps);
  }
  // A consultation runs in a fresh, empty sandbox of its own — never the
  // asker's or the consulted owner's (piRunPrincipal) — removed when it ends.
  const principal = beginPiConsultationSandbox(config);
  try {
    return await runPiAgentAs(principal, request, pluginRoots, config, store, events, abortController, deps);
  } finally {
    endPiConsultationSandbox(config, principal);
  }
}

async function runPiAgentAs(
  principal: string,
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents | undefined,
  abortController: AbortController | undefined,
  deps: RunPiAgentDeps,
): Promise<AgentResponse> {
  // Undefined for a run without a conversation: a run folder, a fresh
  // session every time, no stored profile, instructions or resume point.
  const conversationId = request.conversationId;
  const workKey = conversationId ?? piEphemeralRunKey(request);
  const services = piServicesFor(store, config);
  const client = deps.client ?? services.client;
  if (!client) throw new Error("pi-gateway is not configured (PI_GATEWAY_URL / PI_GATEWAY_API_KEY).");
  const registry = deps.registry ?? services.registry;
  const now = deps.now ?? (() => new Date());
  const signal = abortController?.signal;
  const workspace = piWorkspaceFor(config, principal, workKey);
  ensurePiConversationDir(workspace);
  // Skills as sandbox files (owner runs: every root in .noah/skills, the only
  // runs that prune; a colleague or consultation: the bundled ones in
  // .noah/skills-shared, plus the owner's through mcp__skills__read).
  // Re-synced each turn by a stat fingerprint; the index rides the frozen
  // instructions.
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
  // steer boundary.
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
      piConversationDir: workspace.conversationDir,
      piWorkspace: workspace,
      piSkills,
      ...(asyncJobs ? { piAsyncJobs: asyncJobs } : {}),
    },
  );
  const promptRequest = stampPromptRequest(request, capabilities, config, events);
  const effort = piEffortFor(capabilities.userEffort);
  // The model chain is the capability plan's (one entry unless the run opted into
  // fallback): each entry is a pi model id sent as is, or undefined = pi-gateway's
  // default model (no `model` sent). Each attempt runs in a FRESH session.
  const chain = capabilities.modelChain;
  let attempt = 0;
  const profileOf = (index: number) => `${chain[index] ?? ""}|${effort ?? ""}`;

  // ---- session ------------------------------------------------------------
  const resumeCandidate = request.resumeSessionAt ?? request.resumeSessionId;
  let previous: string | undefined = isPiResponseId(resumeCandidate) ? resumeCandidate : undefined;
  let newSessionReason: "model_changed" | "session_lost" | undefined;
  if (conversationId && previous) {
    const known = store.getConversationPiSessionProfile(principal, conversationId, piSessionKey(previous));
    if (known !== null && known !== profileOf(0)) {
      previous = undefined;
      newSessionReason = "model_changed";
      events?.onStatus?.("모델 또는 사고 강도가 바뀌어 새 세션에서 이전 대화 기록으로 이어갑니다…");
    }
  }
  // ---- input --------------------------------------------------------------
  const stagedFiles = request.imageFiles?.length ? stagePiAttachmentFiles(workspace, request.imageFiles) : [];
  const userRequest: AgentRequest = { ...promptRequest, imageFiles: stagedFiles.length ? stagedFiles : undefined };
  const firstInputText = (fresh: boolean): string =>
    [
      buildPiTurnPreamble(promptRequest, {
        now: now(),
        ...(fresh && newSessionReason ? { newSessionReason } : {}),
        // A fresh session's text history already ends with the stopped row.
        ...(fresh ? {} : { continuedAfterStop: true }),
      }),
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
  // The frozen prompt's tool list (design D2): rendered only while the
  // conversation has no instructions yet. Relayed lists are read now (pi reads
  // them at session build anyway), bounded by the pool's own deadline.
  const knownTools = conversationId && store.hasConversationPiInstructions(principal, conversationId)
    ? undefined
    : await piKnownTools(catalog, allowedTools, proxies, capabilities.piMcpProxies?.upstreams ?? []);
  const frozenRequest: AgentRequest =
    knownTools && promptRequest.piRuntime ? { ...promptRequest, piRuntime: { ...promptRequest.piRuntime, knownTools } } : promptRequest;
  const frozenInstructions = (): string =>
    (conversationId
      ? store.ensureConversationPiInstructions(principal, conversationId, () => buildSystemPromptAppend(frozenRequest))
      : null) ?? buildSystemPromptAppend(frozenRequest);
  const catalogTools = new Map(
    Object.entries(catalog).flatMap(([server, tools]) => tools.map((tool) => [`${server}/${tool.name}`, tool] as const)),
  );
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
      // A misnamed argument would be stripped by the server's zod object and
      // the call would run as if it were absent (`list_todos {state}` listing
      // everything): refuse it with the valid names instead. Noah's own
      // servers only — a relayed server's schema is its own business.
      checkArguments: (server, tool, args) => {
        if (proxyNames.has(server)) return null;
        const listed = catalogTools.get(`${server}/${tool}`);
        return listed ? unknownArgumentProblem(`mcp__${server}__${tool}`, listed.inputSchema, args) : null;
      },
      // Every result leaves Noah redacted: a relayed server echoing a vault
      // value or a header, a page echoing a browser-typed password.
      transformResult: (_server, _tool, result) =>
        Object.keys(redactions).length > 0 ? (redactSecretValues(result, redactions).value as CallToolResult) : result,
    },
    signal: tokenAbort.signal,
    context: { conversationId: conversationId ?? null, principal },
    label: workKey,
  });

  const steers = events?.steers;
  // Whether the CURRENT pi request already showed the user anything (text, a
  // question): an empty turn is only retried while nothing has.
  let attemptShowedOutput = false;
  // The host sees pi's committed turns as session ids AND resume points (a
  // rewind onto that row forks from it); segment boundaries are this runner's.
  const piEvents: AgentEvents = {
    ...events,
    steers: undefined,
    onDelta: (text) => {
      attemptShowedOutput = true;
      anchorText += text;
      events?.onDelta?.(text);
    },
    ...(events?.onQuestion
      ? {
          onQuestion: (question: Parameters<NonNullable<AgentEvents["onQuestion"]>>[0]) => {
            attemptShowedOutput = true;
            return events.onQuestion!(question);
          },
        }
      : {}),
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
  let emptyRetried = false;
  try {
    let input: PiResponseRequest["input"] | null = null;
    for (;;) {
      // One pi response (+ its AskUserQuestion round trips).
      for (;;) {
        const fresh = !previous;
        const currentModel = chain[attempt];
        attemptShowedOutput = false;
        const piRequest: PiResponseRequest = {
          user: principal,
          input: input ?? { kind: "prompt", text: firstInputText(fresh), ...(images.length ? { images } : {}) },
          ...(fresh
            ? {
                instructions: frozenInstructions(),
                ...(currentModel ? { model: currentModel } : {}),
                ...(effort ? { reasoningEffort: effort } : {}),
                ...(capabilities.piRuntimeFacts.readOnlyBuiltins ? { readOnly: true } : {}),
              }
            : { previousResponseId: previous }),
          // Every request: pi keeps sandbox_env only for the request it came with.
          ...(Object.keys(capabilities.piSandboxEnv).length ? { sandboxEnv: capabilities.piSandboxEnv } : {}),
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
          });
          if (fresh && conversationId) {
            store.setConversationPiSessionProfile(principal, conversationId, piSessionKey(result.responseId), profileOf(attempt));
          }
          break;
        } catch (error) {
          if (signal?.aborted || input) throw error;
          // The stored session is gone (pi restarted with a wiped DB, another
          // user's id, a session stuck on a question) or can no longer run (the
          // operator removed its model from pi): rebuild from history once.
          if (!healed && previous && isLostPiSession(error)) {
            healed = true;
            agentLogger.warn({ conversationId, previous, kind: error.kind, code: error.code }, "pi session missing; retrying with stored history");
            previous = undefined;
            newSessionReason = "session_lost";
            continue;
          }
          // pi fails a turn with no text, reasoning or tool call as
          // `empty_response` and does NOT commit it, so the same request (same
          // previous_response_id, or the same fresh session) runs once more — the
          // retired SDK runner's one empty-turn retry. Never once the user saw
          // output, and never for a follow-up turn (`input`, refused above). A
          // steer queued meanwhile simply stays queued: once the retried turn
          // completes it is delivered as the follow-up turn below, as it would
          // have been after a non-empty answer (review-2 L2).
          if (
            !emptyRetried &&
            error instanceof PiTurnFailedError &&
            error.code === "empty_response" &&
            !attemptShowedOutput
          ) {
            emptyRetried = true;
            agentLogger.warn({ conversationId, previous: previous ?? null }, "pi returned an empty turn; retrying once");
            events?.onStatus?.("모델이 빈 응답을 보내 한 번 더 시도하는 중…");
            continue;
          }
          const retryable =
            (error instanceof PiTurnFailedError && error.status !== 500) ||
            (error instanceof PiGatewayError && error.retryable);
          if (retryable && attempt + 1 < chain.length) {
            attempt += 1;
            agentLogger.warn(
              { conversationId, from: chain[attempt - 1] ?? null, to: chain[attempt] ?? null, detail: String(error) },
              "model fallback after transient error",
            );
            previous = undefined;
            events?.onThinkingReset?.();
            events?.onStatus?.(`모델을 ${chain[attempt] ?? "기본 모델"}(으)로 전환해 다시 시도 중…`);
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
        // Stop pressed while waiting: the run was CANCELLED (its jobs are
        // aborted in the finally), not completed — the route maps this error
        // through its cancel path instead of emitting `done`.
        if (signal?.aborted) throw new PiGatewayError("aborted");
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
    steerPending: false,
  });
  const text = final.text || (final.errorSubtype ? resultErrorMessage(final.errorSubtype) : EMPTY_PI_RESPONSE_MESSAGE);
  agentLogger.info(
    {
      avatarId: request.avatar.id,
      runtime: "pi",
      model: chain[attempt] ?? null,
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
