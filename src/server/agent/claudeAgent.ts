import { randomUUID } from "node:crypto";
import type {
  AppConfig,
  AgentRequest,
  AgentResponse,
  AgentUsage,
  AgentImageInput,
  PluginRoot,
} from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";
import logger from "../logger.js";
import { isRecord, asNumber, asString } from "./agentUtils.js";
import { steerToSdkUserMessage, type SteerChannel } from "./steerChannel.js";
import {
  buildSystemPromptAppend,
  buildUserPrompt,
} from "./promptBuilder.js";
import {
  createLoopState,
  createTextFoldState,
  dispatchSdkMessage,
  finalizeTurnUsage,
  foldPendingText,
  peekMainTextDelta,
  resultErrorMessage,
} from "./sdkMessageHandlers.js";

// Re-export the symbols moved into sibling modules so existing import paths
// (app.ts, index.ts, tests/units.test.ts, infra/agent-core/… tests) keep
// resolving against this module unchanged.
export {
  buildPrompt,
  buildSystemPromptAppend,
  buildUserPrompt,
} from "./promptBuilder.js";
export { buildPreToolUseHook } from "./preToolUseHook.js";
export { interpretResult, resultErrorMessage } from "./sdkMessageHandlers.js";
export {
  withoutGitCredentialEnv,
  agentSubprocessEnv,
  sshMcpSecretEnv,
  mcpInjectableSecretEnv,
  deriveAgentToolAccess,
  planMcpToolFamilies,
  buildModelFallbackChain,
  type AgentToolAccess,
  type McpToolFamilyPlan,
} from "./runPlan.js";
import { buildAgentRunPlan } from "./runPlan.js";

const agentLogger = logger.child({ module: "agent" });

/**
 * Build the HELD-OPEN "streaming input" prompt for a live chat turn: a single
 * SDK user message (the full prompt text + one image block per attachment),
 * after which the generator PARKS on `closed` instead of returning. A prompt
 * that ends — a plain string, or a generator that returns — makes the SDK close
 * the CLI's stdin at the turn's FIRST `result` (`isSingleUserTurn`, and the
 * bidirectional-needs wait when hooks/MCP servers are attached), and the CLI
 * process exits with it, killing any still-RUNNING background task
 * (`run_in_background` Bash) before it can wake the model — a task survived
 * only when it settled before that first result. Keeping the generator pending
 * keeps stdin open, so the CLI holds the session through the background phase
 * and streams wake-up turns; `runClaudeAgent` resolves `closed` at a result
 * boundary with no live background tasks (and on every attempt exit, so a
 * failed run never leaks the parked promise). The SDK's `query` is typed
 * loosely here (`input: unknown`), so the SDKUserMessage shape is constructed
 * inline; `parent_tool_use_id: null` marks a top-level turn. The wire format is
 * identical to the string path (the SDK writes a string prompt as this same
 * stream-json user message), so `resume` and all `options` behave the same.
 *
 * With a `steers` channel the park becomes a LOOP: every mid-turn message the
 * viewer sends is yielded here as another SDK user message, which writes it to
 * the CLI's stdin at once — the CLI queues it and folds it into the running
 * turn after the next tool_result (or runs it as the next turn). The generator
 * returns when `closed` settles or the channel closes; it never closes the
 * channel itself (the run loop owns that, so a self-heal retry can rebuild this
 * generator and keep consuming).
 */
export async function* buildHeldOpenQueryPrompt(
  promptText: string,
  images: AgentImageInput[],
  closed: Promise<void>,
  steers?: SteerChannel,
): AsyncGenerator<Record<string, unknown>> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    shouldQuery: true,
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        })),
      ],
    },
  };
  if (!steers) {
    await closed;
    return;
  }
  for (;;) {
    const steer = await steers.next(closed);
    if (!steer) {
      return;
    }
    yield steerToSdkUserMessage(steer);
  }
}

/**
 * Single-turn variant for HEADLESS turns that carry images: same message, but
 * the generator returns immediately, so the SDK closes the CLI's stdin at the
 * first result exactly like a string prompt. Headless runs have no events sink
 * to deliver background wake-ups, so the prompt single-turn teardown is wanted.
 */
export async function* buildImageQueryPrompt(
  promptText: string,
  images: AgentImageInput[],
): AsyncGenerator<Record<string, unknown>> {
  yield* buildHeldOpenQueryPrompt(promptText, images, Promise.resolve());
}

// HTTP statuses that indicate a transient model/server-side condition worth
// retrying on a different model (overload/rate-limit/5xx/timeout).
const RETRYABLE_MODEL_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Fallback `response.text` when a run ends with no streamed text, no result
// text, and no error subtype. Exported so programmatic consumers (avatar
// consultation) can recognize "no real model output" without string drift;
// the chat UI keeps rendering it as-is (user-facing → Korean).
export const EMPTY_SDK_RESPONSE_MESSAGE = "Claude Agent SDK 응답이 비어 있습니다.";

// Appended to the prompt on the one-shot empty-turn retry (see emptyTurnRetryTried).
// Agent-facing → English. Steers the model to emit a visible text answer after a
// turn that produced only an (invisible) thinking block.
const EMPTY_TURN_RETRY_NUDGE =
  "[note] Your previous turn ended with internal reasoning only and produced no " +
  "visible reply. Answer the user's message now as plain text — do not stop after thinking.";

/**
 * Whether an SDK/query failure looks like a transient MODEL or SERVER-side
 * problem (overloaded, rate-limited, 5xx, network) — as opposed to a genuine
 * error (bad request, auth, a tool failure). Used to decide model fallback.
 * Inspects an `Anthropic`-style numeric `status` first, then the message text.
 */
/**
 * True when the SDK failed because a resumed session id has no transcript on
 * disk — e.g. the agent-sessions dir wasn't preserved across a redeploy, or the
 * transcript was cleaned up while the DB still holds the id. The CLI surfaces
 * this as "No conversation found with session ID …". We self-heal by re-running
 * the turn WITHOUT `resume`, rebuilding context from the stored history instead.
 */
export function isMissingResumeSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no conversation found with session/i.test(message);
}

export function isRetryableModelError(error: unknown): boolean {
  const status =
    isRecord(error) && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status && RETRYABLE_MODEL_STATUS.has(status)) {
    return true;
  }
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return /overloaded|rate.?limit|too many requests|\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b|internal server error|service unavailable|bad gateway|gateway timeout|timed?\s?out|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|connection error|network error|server_error|api_error/.test(
    message,
  );
}


/**
 * Run the Claude Agent SDK against the avatar's plugin roots.
 *
 * Permission model — enforced by a PreToolUse hook, NOT canUseTool/onUserDialog.
 * (Empirically, the SDK's interactive control callbacks `canUseTool`/`onUserDialog`
 * do NOT fire in this headless `query()` setup — verified against v0.3.169 — but
 * PreToolUse hooks DO fire and can block asynchronously, so the hook is our gate.)
 * The bundled CLI bounds every SDK callback hook with a per-hook abort (10 min
 * default; CLIs before 2.1.218 then misreport the abort to the model as a USER
 * REJECTION), so the PreToolUse matcher pins `timeout` ABOVE the run registry's
 * PROMPT_TTL_MS: the server always settles a parked prompt (answer, TTL
 * auto-cancel, or run end) before the CLI gives up on the hook.
 * BACKGROUND subagents would escape this gate entirely (the CLI consults no
 * hooks/canUseTool/allowedTools for their tool calls and auto-denies them as a
 * user refusal), so the hook rewrites every Task/Agent spawn to the foreground
 * (see SUBAGENT_SPAWN_TOOLS in preToolUseHook.ts).
 *
 *  - Read-only tools / knowledge MCP / orchestration meta-tools → allowed silently.
 *  - AskUserQuestion → intercepted: we surface the question, await the user's
 *    answer, and inject it back as the tool result (via a deny+reason, which the
 *    model reads as the answer).
 *  - Any other tool (Write/Edit/Bash/WebFetch/…):
 *      • OWNER  → interactive permission prompt (approve → allow, else deny).
 *      • COLLEAGUE → denied (read-only) and surfaced as a "blocked" notice.
 *
 * Streaming + interactivity are opt-in via the events sink.
 */
export async function runClaudeAgent(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events?: AgentEvents,
  abortController?: AbortController,
): Promise<AgentResponse> {
  // Hoisted above the plan: the plan's attachment-anchor accessor reads this
  // accumulator, and the empty-turn retry below REASSIGNS it — so the accessor
  // has to close over the binding, not over the array it happens to hold now.
  // Same for the fold state, which marks where the KEPT tail starts.
  let assistantChunks: string[] = [];
  let textFold = createTextFoldState();
  const plan = await buildAgentRunPlan(
    request,
    pluginRoots,
    config,
    store,
    events,
    abortController,
    // Anchor into the answer that will actually PERSIST: after a fold the answer
    // restarts from the tail, so an attachment stamped now belongs at the tail's
    // offset, not the whole-run one. Attachments stamped BEFORE the fold are
    // re-anchored to 0 by the host on each onTextFold.
    () => assistantChunks.slice(textFold.chunkIndex).join("\n\n").length,
  );
  const {
    sdk,
    streaming,
    options,
    ownerToolAccess,
    webFetchProxyState,
    owner,
    ownerState,
    ownerGroups,
    ownerSecrets,
    groupAgentState,
    personalAgentState,
    personalAgentCreateActive,
    effectiveModel,
    modelChain,
    runVisionEnabled,
    agentStart,
    knowledgeRepoConfigured,
    sharedAccount,
    toolSkillPolicy,
    registeredMcpToolGroups,
    adminBlockedMcpToolGroups,
    runKindBlockedMcpToolGroups,
    browserActive,
    canvasActive,
    fileOutputActive,
    skillExchangeActive,
    deckRenderingAvailable,
  } = plan;

  if (events) {
    events.onStatus?.("응답 생성 중…");
  }

  let state = createLoopState();
  let deltaChunks: string[] = [];
  let resultText = "";
  let resultErrorSubtype = "";
  let runUsage: AgentUsage | undefined;
  // Snapshot of the latest main-agent prompt size (≈ live context occupancy),
  // used to override the result usage's CUMULATIVE inputTokens for the badge.
  // FALLBACK only — preferred source is `contextUsage` below.
  let contextTokens: number | undefined;
  // Authoritative context occupancy from the SDK's first-party getContextUsage()
  // control method, captured mid-turn on streaming chat. When set it supersedes
  // the scraped `contextTokens` snapshot (it carries the true window too, so no
  // correctContextWindow guess is needed). Undefined on headless/non-streaming
  // turns or if the control call fails — then we fall back to contextTokens.
  let contextUsage: { total: number; window: number } | undefined;
  let usedModel = effectiveModel;

  // Owner self-state (secret names, group memberships) flows to every
  // OWNER-DRIVEN turn: interactive owner chats AND owner-scheduled routines
  // (ownerToolAccess) — the same gate that registers the owner-level tools, so
  // prompt awareness and tool availability never diverge. Restricted headless
  // runs (intro/hashtag generation) and colleague/trusted chats keep them empty.
  const promptRequest: AgentRequest = {
    ...request,
    secretNames: ownerToolAccess ? ownerState.secretNames : [],
    shellExposedSecretNames: ownerToolAccess
      ? ownerState.shellExposedSecretNames
      : [],
    // Secrets the owner enabled for BROWSER INPUT. Same owner gate as the two
    // above; the browser paragraph only renders when the bridge is actually on,
    // so a run without it never advertises names it could not type.
    browserSecrets: ownerToolAccess ? ownerState.browserSecrets : [],
    knowledgeRepoConfigured,
    // Shared-account self-state rides on EVERY viewer class (it is not a secret):
    // the teammate branch switches its repo guidance to "writes allowed" on it,
    // and the owner branch surfaces it as META-COGNITION.
    sharedAccount,
    gitTokenSet: ownerState.gitTokenSet,
    githubHost: config.githubHost,
    confluenceUrlConfigured: Boolean(config.confluenceUrl),
    confluencePatConfigured: Boolean(
      ownerSecrets.CONFLUENCE_PAT ||
      ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN,
    ),
    // Web-fetch proxy self-state (META-COGNITION): redacted HTTP(S)_PROXY/
    // NO_PROXY snapshot so the avatar knows whether external sites are
    // reachable through the corporate proxy. Mirrored by describe_system.
    webFetchProxy: webFetchProxyState(),
    groupMemberships: ownerToolAccess ? ownerGroups : [],
    // Skill-exchange self-state (#skill-share): counts ride ONLY runs that
    // registered the tools (skillExchangeActive), so the standing note and
    // tool availability can't diverge.
    learnableSkillCount: skillExchangeActive
      ? ownerState.learnableSkillCount
      : 0,
    sharedSkillCount: skillExchangeActive ? ownerState.sharedSkillCount : 0,
    // The REGISTERED set (see registeredMcpToolGroups): standing tool guidance
    // must match the servers this run actually mounts.
    mcpToolGroups: registeredMcpToolGroups,
    // Rides to the prompt ONLY so admin-blocked groups are excluded from the
    // "user deselected" standing note — the avatar is deliberately NOT told
    // that a policy exists or what it blocks (it only knows its enabled set).
    // Run-kind-stripped families (group-agent forcing) are excluded the same
    // way: absent, but never misattributed to the member's composer choice.
    adminBlockedMcpToolGroups: [
      ...adminBlockedMcpToolGroups,
      ...runKindBlockedMcpToolGroups,
    ],
    // Canvas standing guidance fires for ALL viewer classes of a canvas-enabled
    // turn (colleagues see canvases too). Experimental-feature self-state is
    // owner-driven only (META-COGNITION), matching describe_system's gating.
    canvasEnabled: canvasActive,
    browserEnabled: browserActive,
    fileOutputEnabled: fileOutputActive,
    // Deck standing guidance needs BOTH the deployment toolchain and a turn
    // that can publish files (preview embeds + the download card).
    deckRenderingEnabled: deckRenderingAvailable && fileOutputActive,
    visionEnabled: runVisionEnabled,
    experimentalFeatures: ownerToolAccess
      ? ownerState.experimentalFeatures
      : [],
    // Admin tool/skill policy self-state (META-COGNITION): all viewer classes —
    // a disabled skill may still show in the CLI's listing (stale discovery
    // cache), so the standing note stops the avatar from attempting/suggesting
    // it. Mirrored by describe_system.
    adminDisabledTools: toolSkillPolicy.disabledTools,
    adminDisabledSkills: toolSkillPolicy.disabledSkills,
    // Group-agent self-state for the prompt branch (same facts as
    // describe_system's group ctx — the GroupAgentState invariant).
    groupAgentState,
    // Personal-agent (내 봇) self-state: the bot identity the prompt speaks AS,
    // carrying the same facts describe_system's bot block reports. Null on every
    // non-bot run, which is also what the prompt's identity swap keys off.
    personalAgentState,
    // External task API self-state, owner (non-group-agent) runs only: the live
    // key count, plus the CONFIGURED per-run budget — config, not store, so an
    // operator's AVATAR_TASK_TIMEOUT_MINUTES is what the avatar states, never
    // the manual's default. An API run is an owner run, so the same gate covers
    // its provenance paragraph; describe_system reads the same config value.
    avatarApiKeyCount: request.viewerIsOwner && !request.groupAgent ? ownerState.avatarApiKeyCount : undefined,
    avatarTaskRunTimeoutMs: request.viewerIsOwner && !request.groupAgent ? config.avatarTaskRunTimeoutMs : undefined,
    // Bot-creation self-state, rides ONLY runs that registered create_agent
    // (the skillExchangeActive precedent) so the standing guidance and the tool
    // can't diverge. The roster is the owner's ENABLED bots.
    personalAgentsEnabled: personalAgentCreateActive,
    personalAgentNames: personalAgentCreateActive
      ? ownerState.personalAgentNames
      : [],
    // Mid-turn messages (steers) — META-COGNITION only, no capability change:
    // this run has a live steer channel, so the viewer can keep typing while it
    // works. Same boolean describe_system reports (runPlan's system ctx).
    midTurnMessages: Boolean(events?.steers),
  };

  const setSystemPrompt = () => {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPromptAppend(promptRequest),
      // Keep Claude Code's stable default prompt, but move its per-user dynamic
      // cwd/memory/git-status sections out of the system layer. The app supplies
      // its own workspace/tool-state guidance in the appended system prompt.
      excludeDynamicSections: true,
    };
  };
  setSystemPrompt();

  // The user prompt text. STREAMING (live chat) turns wrap it in the held-open
  // generator built per attempt below, so the CLI session can outlive the first
  // result while background tasks run. HEADLESS runs keep the single-turn
  // prompts: a plain string, or — when the turn carries image attachments — a
  // single-message async-iterable (the only way to feed the model images). All
  // `options` (resume/hooks/mcpServers/model) work identically in every mode.
  let promptText = buildUserPrompt(promptRequest);

  // One-shot guard for the stale-resume self-heal below: if the SDK can't find
  // the session we asked it to resume, we drop `resume`, rebuild the prompt with
  // the stored history, and retry the SAME model once. This fires BEFORE any
  // assistant text streams (resume loads at query start), so it's safe even for
  // a live chat — nothing the viewer saw gets discarded.
  let resumeFallbackTried = false;

  // One-shot guard for the empty-turn self-heal below: occasionally the model
  // ends a turn with ONLY a thinking block (stopReason end_turn, no `text`
  // block, no tool call) and the SDK reports a `success` result with an empty
  // string, so the bubble would otherwise show the bare "응답이 비어 있습니다"
  // fallback. We re-run the SAME model once with a nudge to actually emit a text
  // answer. No ANSWER text streamed (producedText is false), so nothing the
  // viewer reads as the reply is discarded — but the failed attempt's reasoning
  // DID stream to the thinking view, so the retry fires onThinkingReset to drop
  // it (otherwise the kept turn's reasoning would render glued to the throwaway).
  let emptyTurnRetryTried = false;

  // Result-boundary segmentation (streaming runs only). A query is NOT one
  // model turn: with live background tasks the SDK holds the session open past
  // the first `result`, wakes the model when a task settles, and streams
  // follow-up turns that each end in another `result`. onTurnResult hands the
  // host each boundary's text slice so it can finalize the visible turn early
  // and deliver wake-up turns as separate messages. Indexes mark where the
  // previous segment ended in the chunk accumulators.
  let segmentAssistantStart = 0;
  let segmentDeltaStart = 0;
  // True once any result boundary passed with live background tasks. Blocks the
  // empty-turn retry: re-running the whole query after a background phase would
  // duplicate work the host already delivered as messages.
  let backgroundTurnSeen = false;
  // Mid-turn user messages for THIS run (interactive streaming chat only). The
  // held-open generator yields them into the CLI's stdin and the loop below
  // feeds the CLI's `command_lifecycle` frames back so the host can report
  // delivery. Absent on headless/external runs.
  const steers = events?.steers;

  // Run the SDK query, walking the model fallback chain (single-element unless a
  // routine opted in). A retry re-runs from scratch on a fresh attempt, so it is
  // only safe for headless routines (no live stream consuming partial output);
  // chat always has a single-element chain.
  //
  // The steer channel spans the WHOLE loop, not one attempt: a self-heal retry
  // rebuilds the prompt generator, which must keep consuming messages the
  // viewer sent in between. It closes at the task-free steer-free result
  // boundary above, and here on every other exit (abort, error, normal end).
  try {
    for (let attempt = 0; attempt < modelChain.length; attempt += 1) {
      const model = modelChain[attempt];
      if (model) {
        options.model = model;
        usedModel = model;
      }
      // Reset per-attempt accumulators so a retry never inherits a failed
      // attempt's partial text / usage.
      state = createLoopState();
      assistantChunks = [];
      textFold = createTextFoldState();
      deltaChunks = [];
      resultText = "";
      resultErrorSubtype = "";
      runUsage = undefined;
      contextTokens = undefined;
      contextUsage = undefined;
      segmentAssistantStart = 0;
      segmentDeltaStart = 0;
      // Build the prompt fresh each attempt: the generator paths are single-use,
      // so a retry needs a new one (the headless string path is reused as-is).
      // Streaming turns ALWAYS go through the held-open generator — an input that
      // ends makes the SDK close the CLI's stdin at the first result, killing
      // still-running background tasks with the process (see
      // buildHeldOpenQueryPrompt). The gate resolves at a task-free result
      // boundary (below) and in this attempt's `finally`, so normal turns still
      // tear down promptly while a live background phase keeps the session open
      // for wake-up turns (delivered via onTurnResult → bg_message).
      let releaseHeldInput: (() => void) | undefined;
      const queryPrompt = streaming
        ? buildHeldOpenQueryPrompt(
            promptText,
            request.images ?? [],
            new Promise<void>((resolve) => {
              releaseHeldInput = resolve;
            }),
            steers,
          )
        : request.images && request.images.length > 0
          ? buildImageQueryPrompt(promptText, request.images)
          : promptText;

      try {
        // Keep the Query handle (not just its iterator) so we can call the
        // getContextUsage() control method on it during the turn.
        const queryHandle = sdk.query({ prompt: queryPrompt, options });
        for await (const message of queryHandle) {
          if (!isRecord(message)) {
            continue;
          }
          // The CLI's lifecycle report for a mid-turn message we wrote to its
          // stdin. `started` is the ONLY signal that the text actually reached
          // the model (a folded steer is never echoed back as a stream `user`
          // message), so the channel's whole delivery state machine hangs off
          // these frames. Nothing else consumes them — dispatchSdkMessage would
          // just answer `other`.
          if (message.type === "command_lifecycle") {
            steers?.noteLifecycle(
              asString(message.command_uuid),
              asString(message.state),
            );
            continue;
          }
          // A delta arriving while completed chunks are still unfolded means a
          // NEW text block just started (block k's deltas stream BEFORE block
          // k's assembled `assistantText` is recorded), so the narration so far
          // demotes to the reasoning view. The fold must run BEFORE dispatch:
          // dispatch emits this very delta through onDelta, and the fold has to
          // reach the sinks ahead of the new block's first chunk — behind it,
          // they sweep that chunk into the reasoning view and the kept text
          // loses its head (live bubble always; persisted text on the
          // cancel/error paths via foldedTextOffset). Later deltas of the SAME
          // block no-op: chunkIndex already caught up.
          if (peekMainTextDelta(message)) {
            foldPendingText(textFold, assistantChunks, deltaChunks, events, false);
          }
          const dispatched = dispatchSdkMessage(message, events, state);
          if (dispatched.delta) {
            deltaChunks.push(dispatched.delta);
          }
          if (dispatched.assistantText) {
            assistantChunks.push(dispatched.assistantText);
          }
          if (dispatched.contextTokens !== undefined) {
            contextTokens = dispatched.contextTokens;
          }
          if (dispatched.resultText) {
            resultText = dispatched.resultText;
          }
          if (dispatched.errorSubtype) {
            resultErrorSubtype = dispatched.errorSubtype;
          }
          if (dispatched.usage) {
            runUsage = dispatched.usage;
          }

          if (dispatched.kind === "assistant") {
            // PREFERRED source: ask the SDK for the authoritative current context
            // usage while the session is still live. The control channel answers
            // until the result message closes it, so we call it per main-agent
            // assistant message and keep the latest — the LAST one ≈ the final
            // request's true occupancy (totalTokens) and real window (maxTokens).
            // Streaming chat only (control methods need the live streaming
            // session); headless/non-streaming turns keep the scraped fallback.
            if (streaming && dispatched.mainAssistant) {
              try {
                const cu = await queryHandle.getContextUsage?.();
                const total = asNumber(cu?.totalTokens);
                if (total > 0) {
                  contextUsage = { total, window: asNumber(cu?.maxTokens) };
                }
              } catch {
                // Session closing or control unsupported on this backend — fall
                // back to the contextTokens snapshot captured above.
              }
            }
          }

          if (dispatched.kind === "result") {
            // Anything still queued at a result boundary can no longer be folded
            // INTO the turn the viewer watched — the CLI will start it as its own
            // follow-up turn in the same session. Mark that before reading the
            // pending flag, so `delivered` can report which it was.
            steers?.noteResultBoundary();
            const steerPending = steers?.hasUndelivered() === true;
            if (state.backgroundTasks.size === 0 && !steerPending) {
              // Task-free, steer-free result boundary → let the held-open input
              // generator return: the SDK then closes the CLI's stdin and the
              // process winds down. A task notification already queued by a
              // settle racing this close is not lost — the CLI drains queued
              // turns after stdin EOF (that drain is how tasks that settle
              // mid-turn ever reported at all). With live tasks the input stays
              // open and the session survives to run them; their wake-up turns
              // end in another result, which closes here once the task set is
              // empty. An UNDELIVERED steer keeps it open for the same reason:
              // the CLI is about to run it as a follow-up turn, and closing the
              // channel here would drop a message the viewer already sent.
              releaseHeldInput?.();
              steers?.close();
            }
            if (events?.onTurnResult) {
              // Result boundary: hand the host this segment's text (chunks since
              // the previous boundary; the boundary's own resultText is only a
              // fallback — it duplicates the last assistant turn's text) plus the
              // live background-task set, so it can finalize the visible turn while
              // the SDK keeps running background work underneath.
              //
              // Sweep first (non-delta backends never hit the delta trigger above):
              // everything but the LAST block folds, so the segment text is exactly
              // the block the model ended the boundary on.
              foldPendingText(textFold, assistantChunks, deltaChunks, events, true);
              const segmentText =
                assistantChunks
                  .slice(Math.max(segmentAssistantStart, textFold.chunkIndex))
                  .join("\n\n")
                  .trim() ||
                deltaChunks
                  .slice(Math.max(segmentDeltaStart, textFold.deltaIndex))
                  .join("")
                  .trim() ||
                (dispatched.resultText || "").trim();
              segmentAssistantStart = assistantChunks.length;
              segmentDeltaStart = deltaChunks.length;
              const backgroundTasks = [...state.backgroundTasks.values()];
              if (backgroundTasks.length > 0) {
                backgroundTurnSeen = true;
              }
              events.onTurnResult({
                text: segmentText,
                ...(dispatched.usage ? { usage: dispatched.usage } : {}),
                ...(dispatched.errorSubtype
                  ? { errorSubtype: dispatched.errorSubtype }
                  : {}),
                backgroundTasks,
                // Always present, unlike the conditional fields above: the host
                // branches on it at EVERY boundary, and "no channel" and "the
                // channel is drained" mean the same thing to it — false.
                steerPending,
              });
              if (steerPending && backgroundTasks.length === 0) {
                // The steer's follow-up turn streams into this SAME run, and the
                // host just persisted the segment above as its own message. Move
                // the fold anchors past it so the follow-up's first delta neither
                // folds the previous answer into the reasoning view (the viewer
                // would watch it vanish) nor leaves it in the run's final text
                // (it would be persisted twice).
                textFold.chunkIndex = assistantChunks.length;
                textFold.deltaIndex = deltaChunks.length;
              }
            }
          }
        }
        // Attempt finished (success or an in-band error result, e.g. max_turns) —
        // those are not transient model-server failures, so don't fall back.
        //
        // Empty-turn self-heal: a `success` result that yielded NO text anywhere
        // (no streamed/assistant text, no result string) and carried NO error
        // subtype means the model ended on a thinking-only turn. Re-run the SAME
        // model once with a nudge to emit a visible answer; mirrors the resume
        // self-heal (re-run, don't consume a fallback step). Skip if aborted or
        // already retried — then fall through to the empty-text fallback below.
        const producedText = Boolean(
          assistantChunks.join("").trim() ||
            deltaChunks.join("").trim() ||
            resultText.trim(),
        );
        // A steer accepted this run also blocks the retry: a re-run replays only
        // the FIRST prompt, so the viewer's mid-turn message would be silently
        // lost (the CLI already consumed its uuid and ignores a re-send). Same
        // reasoning as backgroundTurnSeen above.
        const steerAccepted = Boolean(steers && steers.records().length > 0);
        if (
          !producedText &&
          !resultErrorSubtype &&
          !emptyTurnRetryTried &&
          !backgroundTurnSeen &&
          !steerAccepted &&
          !abortController?.signal.aborted
        ) {
          emptyTurnRetryTried = true;
          promptText = `${promptText}\n\n${EMPTY_TURN_RETRY_NUDGE}`;
          agentLogger.warn(
            {
              avatarId: request.avatar.id,
              conversationId: request.conversationId,
              model,
            },
            "empty turn (thinking-only); retrying once with a text-answer nudge",
          );
          // Drop the throwaway attempt's streamed reasoning so the kept turn's
          // thinking doesn't render concatenated onto it (the chat-route/client
          // thinking accumulators live outside this loop and never reset on retry).
          events?.onThinkingReset?.();
          events?.onStatus?.("응답을 다시 생성하는 중…");
          attempt -= 1; // re-run the SAME model (don't consume a fallback step)
          continue;
        }
        break;
      } catch (error) {
        // Self-heal a stale/missing resume target: re-run this same attempt with
        // `resume` dropped so the stored history (now injected by buildPrompt once
        // resumeSessionId is unset) rebuilds the context. The viewer never sees the
        // error. On success the run reports a FRESH session id, which the chat route
        // persists in place of the dangling one — so the next turn resumes cleanly.
        if (
          !resumeFallbackTried &&
          options.resume &&
          !abortController?.signal.aborted &&
          isMissingResumeSessionError(error)
        ) {
          resumeFallbackTried = true;
          delete options.resume;
          promptRequest.resumeSessionId = undefined;
          setSystemPrompt();
          promptText = buildUserPrompt(promptRequest);
          agentLogger.warn(
            {
              avatarId: request.avatar.id,
              conversationId: request.conversationId,
            },
            "resume session missing; retrying with stored history",
          );
          attempt -= 1; // re-run the SAME model (don't consume a fallback step)
          continue;
        }
        const nextModel = modelChain[attempt + 1];
        const canFallback =
          Boolean(nextModel) &&
          !abortController?.signal.aborted &&
          isRetryableModelError(error);
        if (!canFallback) {
          throw error;
        }
        agentLogger.warn(
          {
            avatarId: request.avatar.id,
            from: model,
            to: nextModel,
            detail: error instanceof Error ? error.message : String(error),
          },
          "model fallback after transient error",
        );
        // No live viewer on a routine, but keep the channel consistent.
        events?.onStatus?.(`모델을 ${nextModel}(으)로 전환해 다시 시도 중…`);
      } finally {
        // Whatever ended this attempt — the normal `break`, an abort, an error,
        // or a self-heal retry's `continue` — release the held-open input so the
        // generator never leaks a parked promise (a crashed CLI can no longer be
        // waiting on stdin, and a retry builds a fresh gate). The steer channel
        // is deliberately NOT closed here: a retry must still be able to consume
        // what the viewer sent in the meantime.
        releaseHeldInput?.();
      }
    }
  } finally {
    // Every exit path: no more mid-turn messages can reach the model, so drop
    // whatever is still queued. The host reports each as `dropped`, and this
    // close runs BEFORE the route's own `cancelled`/`error` frame, which is the
    // order the client relies on.
    steers?.close();
  }

  // The answer is what the model STREAMED, not the SDK's terminal `result`
  // string — but only the LAST text block of it. Interim narration (preambles,
  // the text between tool calls) is FOLDED as it is superseded: each fold hands
  // the demoted text to the host via onTextFold, which files it under the turn's
  // reasoning (`response.thinking`) — so nothing is lost, it just stops bloating
  // the bubble. `textFold.chunkIndex`/`deltaIndex` mark where the kept tail
  // starts. Runs with NO onTextFold sink (headless routines, POST /api/chat) fold
  // nothing and keep the legacy full join, which is why persisting from
  // `resultText` is still wrong there: it is the last assistant TURN's text and
  // would drop everything before it with no reasoning view to catch it.
  // resultText stays a fallback for the rare case nothing streamed; the error
  // fallback applies when neither produced text.
  // The result usage's inputTokens is cumulative across all of the turn's model
  // requests, so dividing it by the context window made the badge's % balloon
  // past 100% on tool-heavy turns. We replace it with true occupancy + keep
  // outputTokens cumulative (total generated this turn).
  //   PREFERRED: getContextUsage()'s totalTokens/maxTokens (authoritative,
  //   carries the real window — no stale-200K guess). Used whenever the control
  //   call succeeded this turn (streaming chat).
  //   FALLBACK: finalizeTurnUsage with the scraped contextTokens snapshot — and
  //   when even that is undefined (error_max_turns, subagent-only, or a backend
  //   that doesn't emit usage) it zeroes the context numbers so the badge shows
  //   output-only rather than a fabricated ratio.
  if (runUsage) {
    if (contextUsage) {
      runUsage = {
        ...runUsage,
        inputTokens: contextUsage.total,
        ...(contextUsage.window ? { contextWindow: contextUsage.window } : {}),
      };
    } else {
      runUsage = finalizeTurnUsage(runUsage, contextTokens);
    }
  }

  // Final sweep: a backend that emits no text deltas never hit the in-loop fold
  // trigger, so fold everything but the last block here — the tail below is then
  // exactly the last text block either way.
  foldPendingText(textFold, assistantChunks, deltaChunks, events, true);
  const partialText =
    assistantChunks.slice(textFold.chunkIndex).join("\n\n").trim() ||
    deltaChunks.slice(textFold.deltaIndex).join("").trim();
  const text =
    partialText ||
    resultText ||
    (resultErrorSubtype
      ? resultErrorMessage(resultErrorSubtype)
      : EMPTY_SDK_RESPONSE_MESSAGE);
  agentLogger.info(
    {
      avatarId: request.avatar.id,
      runtime: "claude",
      model: usedModel,
      modelFellBack: usedModel !== effectiveModel,
      textLength: text.length,
      durationMs: Date.now() - agentStart,
    },
    "agent run completed",
  );
  return {
    kind: "text",
    runtime: "claude",
    summary: "Claude Agent SDK 실행이 완료되었습니다.",
    text,
    // In-band error subtype (text is then a fallback message, not model output)
    // — set only when nothing real streamed, so a partial answer stays usable.
    ...(resultErrorSubtype && !partialText && !resultText
      ? { resultError: resultErrorSubtype }
      : {}),
    ...(runUsage ? { usage: runUsage } : {}),
  };
}
