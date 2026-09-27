import type { AgentEvents, BackgroundTaskSummary } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import type { AgentUsage } from "../types.js";
import logger from "../logger.js";
import { asNumber, asString, isRecord, truncate, TOOL_TRACE_ENABLED } from "./agentUtils.js";
import {
  SDK_PLAN_TOOLS,
  SDK_SUBAGENT_TOOLS,
  SDK_TASK_CREATE_TOOLS,
  SDK_TASK_END_TOOLS,
  SDK_TASK_INSPECTION_TOOLS,
  SDK_TASK_UPDATE_TOOLS,
  SDK_TOOL_LABELS,
  SDK_UI_HANDLED_TOOLS,
  sdkToolLabel,
} from "../../shared/sdkToolPresentation.js";

/** Tools that spawn a subagent (shown as an agent node, not a tool row). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(SDK_SUBAGENT_TOOLS);

/** Tools handled by a dedicated UI (not shown as a generic tool row). */
const UI_HANDLED_TOOLS: ReadonlySet<string> = new Set(SDK_UI_HANDLED_TOOLS);
const PLAN_TOOLS: ReadonlySet<string> = new Set(SDK_PLAN_TOOLS);
const TASK_CREATE_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_CREATE_TOOLS);
const TASK_UPDATE_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_UPDATE_TOOLS);
const TASK_END_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_END_TOOLS);
const TASK_INSPECTION_TOOLS: ReadonlySet<string> = new Set(SDK_TASK_INSPECTION_TOOLS);

const traceLogger = logger.child({ module: "agent", trace: "tool" });

/**
 * Verbose, opt-in trace of one raw SDK message (gated by `AGENT_TOOL_TRACE`, see
 * agentUtils). Called once per message at the top of the run loop so it sees the
 * WHOLE lifecycle in order: streaming `tool_use` block start/stop, the per-turn
 * `stop_reason`, the assembled assistant tool calls, and every `tool_result`.
 *
 * The diagnostic signatures for a vLLM-style stall:
 *  - "tool_use block start" with no matching "content_block stop" → the backend
 *    opened a tool call but never closed its input JSON (the run then hangs).
 *  - `stop_reason: "tool_use"` + an assistant tool call, but NO PreToolUse hook
 *    entry (traced separately) and NO `tool_result` → the SDK never dispatched
 *    the announced call.
 * Wrapped in try/catch: tracing must never break a run.
 */
export function traceSdkMessage(message: Record<string, unknown>): void {
  if (!TOOL_TRACE_ENABLED) {
    return;
  }
  try {
    const type = asString(message.type);
    const agentId = asString(message.parent_tool_use_id) || MAIN_AGENT_ID;
    if (type === "stream_event") {
      const event = isRecord(message.event) ? message.event : undefined;
      const eventType = asString(event?.type);
      if (eventType === "content_block_start") {
        const block = isRecord(event?.content_block) ? event?.content_block : undefined;
        if (asString(block?.type) === "tool_use") {
          traceLogger.info(
            { agentId, index: asNumber(event?.index), toolName: asString(block?.name), toolUseId: asString(block?.id) },
            "trace: tool_use block start",
          );
        }
      } else if (eventType === "content_block_stop") {
        traceLogger.info({ agentId, index: asNumber(event?.index) }, "trace: content_block stop");
      } else if (eventType === "message_delta") {
        const stopReason = asString(isRecord(event?.delta) ? event?.delta.stop_reason : undefined);
        if (stopReason) {
          traceLogger.info({ agentId, stopReason }, "trace: message_delta stop_reason");
        }
      } else if (eventType === "message_start" || eventType === "message_stop") {
        traceLogger.info({ agentId, eventType }, "trace: stream lifecycle");
      }
      return;
    }
    if (type === "assistant") {
      const inner = isRecord(message.message) ? message.message : undefined;
      const content = Array.isArray(inner?.content) ? inner?.content : [];
      const tools = content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_use")
        .map((b) => ({ name: asString(b.name), toolUseId: asString(b.id) }));
      traceLogger.info(
        {
          agentId,
          stopReason: asString(inner?.stop_reason) || null,
          blockTypes: content.filter(isRecord).map((b) => asString(b.type)),
          toolCalls: tools,
        },
        "trace: assistant message assembled",
      );
      return;
    }
    if (type === "user") {
      const inner = isRecord(message.message) ? message.message : undefined;
      const content = Array.isArray(inner?.content) ? inner?.content : [];
      const results = content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_result")
        .map((b) => ({ toolUseId: asString(b.tool_use_id), isError: b.is_error === true }));
      if (results.length) {
        traceLogger.info({ agentId, results }, "trace: tool_result(s) returned");
      }
      return;
    }
    if (type === "result") {
      traceLogger.info({ agentId, subtype: asString(message.subtype) }, "trace: result");
    }
  } catch {
    // Tracing is best-effort diagnostics; never let it throw into the run loop.
  }
}

/** One-line, human-readable summary of a tool's input for the activity UI. */
export function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const path = asString(input.file_path) || asString(input.path) || asString(input.notebook_path);
  const cmd = asString(input.command);
  const pattern = asString(input.pattern);
  const url = asString(input.url);
  const query = asString(input.query) || asString(input.prompt);
  let summary = "";
  if (name === "SendMessage") {
    // Agent-teams coordination: show WHO is being messaged and a content
    // preview (the CLI's input keys are recipient/content/summary; to/message
    // kept as fallbacks across CLI versions).
    const recipient = asString(input.recipient) || asString(input.to);
    const preview =
      asString(input.summary) || asString(input.content) || asString(input.message);
    summary = [recipient, preview].filter(Boolean).join(" · ");
  } else if (name === "Bash" && cmd) summary = cmd;
  else if (pattern) summary = pattern + (path ? ` · ${path}` : "");
  else if (path) summary = path;
  else if (url) summary = url;
  else if (query) summary = query;
  else {
    const firstString = Object.values(input).find((v) => typeof v === "string" && v);
    summary = typeof firstString === "string" ? firstString : "";
  }
  return truncate(summary.replace(/\s+/g, " ").trim(), 160);
}

type TaskKind = "task" | "agent";

interface TaskRecord {
  uiId: string;
  kind: TaskKind;
}

/**
 * `task_started.task_type` values (background-task path, distinct from the
 * inline TaskCreate/TaskUpdate tool family) that mean "this is a spawned
 * agent, not a plain background task": the plain `subagent` label used by
 * agent-teams background teammate spawns, plus the SDK's newer `local_agent`/
 * `remote_agent` local-workflow-script agent-spawn literals (per
 * sdk-tools.d.ts: is_backgrounded is "Set for local_agent and local_bash
 * tasks"). Kept permissive — an unmatched value simply falls back to a
 * generic task row, never breaks anything.
 */
const AGENT_TASK_TYPES: ReadonlySet<string> = new Set(["subagent", "local_agent", "remote_agent"]);

export interface LoopState {
  /** tool_use ids that spawned a subagent → distinguishes onAgentEnd from onToolEnd. */
  spawnedAgentIds: Set<string>;
  /** SDK task ids → rendered task/agent ids. */
  tasks: Map<string, TaskRecord>;
  /** Ambient SDK tasks that should not render in the inline transcript. */
  hiddenTasks: Set<string>;
  /**
   * Live background tasks, mirrored from the SDK's `background_tasks_changed`
   * level signal (REPLACE semantics). Consulted at each `result` boundary to
   * tell "turn over" from "turn over BUT background work still running".
   */
  backgroundTasks: Map<string, BackgroundTaskSummary>;
  /**
   * uiId of the most recently started, still-running Workflow (ultracode)
   * container task, if any — so a subagent the workflow spawns nests under it
   * in the activity tree (agentId chain) instead of flattening to main. Last
   * workflow wins on concurrent workflows (rare); good enough for a visual
   * grouping aid, not a correctness guarantee.
   */
  activeWorkflowAgentId?: string;
}

export function createLoopState(): LoopState {
  return {
    spawnedAgentIds: new Set(),
    tasks: new Map(),
    hiddenTasks: new Set(),
    backgroundTasks: new Map(),
    activeWorkflowAgentId: undefined,
  };
}

/** Mutable fold bookkeeping for one attempt's chunk accumulators. */
export interface TextFoldState {
  chunkIndex: number;
  deltaIndex: number;
}

export function createTextFoldState(): TextFoldState {
  return { chunkIndex: 0, deltaIndex: 0 };
}

/**
 * Fold every unfolded chunk (all of them, or all but the last when `keepLast`).
 * Fires onTextFold with the folded text and advances the fold indexes.
 *
 * WHY: during an agentic turn the model narrates between tool calls, so the
 * answer accumulates many interim text blocks. Only the LAST block is the
 * answer; everything before it is narration, which belongs in the reasoning
 * view (`response.thinking`) rather than the bubble. The fold indexes are where
 * the kept tail starts — the accumulators themselves are never rewritten, since
 * the empty-turn check still reads the WHOLE attempt.
 *
 * No-op without an onTextFold sink — headless runs keep the legacy full-join
 * text, per the AgentEvents contract (no sink ⇒ original behavior).
 */
export function foldPendingText(
  state: TextFoldState,
  assistantChunks: string[],
  deltaChunks: string[],
  events: AgentEvents | undefined,
  keepLast: boolean,
): void {
  if (typeof events?.onTextFold !== "function") {
    return;
  }
  const end = keepLast ? assistantChunks.length - 1 : assistantChunks.length;
  if (end - state.chunkIndex <= 0) {
    return;
  }
  const folded = assistantChunks.slice(state.chunkIndex, end).join("\n\n").trim();
  if (folded) {
    events.onTextFold(folded);
  }
  state.chunkIndex = end;
  state.deltaIndex = deltaChunks.length;
}

function taskDescription(input: Record<string, unknown>): string {
  return (
    asString(input.task_subject) ||
    asString(input.subject) ||
    asString(input.title) ||
    asString(input.description) ||
    asString(input.task_description) ||
    asString(input.prompt) ||
    asString(input.task)
  );
}

function taskDetails(input: Record<string, unknown>): string {
  const subject = asString(input.task_subject) || asString(input.subject) || asString(input.title);
  const description = asString(input.task_description) || asString(input.description) || asString(input.prompt) || asString(input.task);
  return truncate([subject, description].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim(), 200);
}

function taskType(input: Record<string, unknown>): string {
  return asString(input.task_type) || asString(input.type) || asString(input.kind);
}

function taskIdFromInput(input: Record<string, unknown>, fallback: string): string {
  return asString(input.task_id) || asString(input.taskId) || asString(input.id) || fallback;
}

function isTaskCreateTool(name: string): boolean {
  return TASK_CREATE_TOOLS.has(name);
}

function isTaskUpdateTool(name: string): boolean {
  return TASK_UPDATE_TOOLS.has(name);
}

function isTaskEndTool(name: string): boolean {
  return TASK_END_TOOLS.has(name);
}

function isTaskInspectionTool(name: string): boolean {
  return TASK_INSPECTION_TOOLS.has(name);
}

function isPlanTool(name: string): boolean {
  return PLAN_TOOLS.has(name);
}

function statusIsTerminal(status: string): boolean {
  return ["completed", "failed", "killed", "stopped"].includes(status);
}

function taskOk(status: string): boolean {
  return status === "completed";
}

function taskRecord(state: LoopState, taskId: string): TaskRecord {
  let record = state.tasks.get(taskId);
  if (!record) {
    record = { uiId: taskId, kind: "task" };
    state.tasks.set(taskId, record);
  }
  return record;
}

function emitTaskUpdate(
  events: AgentEvents,
  state: LoopState,
  taskId: string,
  update: { status?: string; description?: string; summary?: string; lastToolName?: string; error?: string; isBackgrounded?: boolean },
): void {
  const record = taskRecord(state, taskId);
  if (record.kind === "agent") {
    if (statusIsTerminal(update.status || "")) {
      if (state.activeWorkflowAgentId === record.uiId) {
        state.activeWorkflowAgentId = undefined;
      }
      events.onAgentEnd?.({ agentId: record.uiId, ok: taskOk(update.status || "") });
    } else {
      if (update.isBackgrounded === true) {
        // Backgrounded mid-run: same card, now flagged. parentId only places a
        // card the client has not seen, which this one always has.
        events.onAgentStart?.({ agentId: record.uiId, parentId: MAIN_AGENT_ID, background: true });
      }
      // A mapped Korean tool label outranks the SDK's summary/description, which
      // it writes in English; an unmapped name still gets humanized rather than
      // shown as a raw id.
      const detail =
        (update.lastToolName && SDK_TOOL_LABELS[update.lastToolName]) ||
        update.summary ||
        update.description ||
        sdkToolLabel(update.lastToolName);
      if (detail) {
        events.onStatus?.(`에이전트 작업 중: ${truncate(detail.replace(/\s+/g, " ").trim(), 120)}`);
      }
    }
    return;
  }
  if (statusIsTerminal(update.status || "")) {
    events.onTaskEnd?.({ taskId: record.uiId, ok: taskOk(update.status || ""), status: update.status, summary: update.summary || update.error });
    return;
  }
  events.onTaskUpdate?.({ taskId: record.uiId, ...update });
}

function handleTaskToolUse(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): boolean {
  if (isPlanTool(name)) {
    // ExitPlanMode carries the proposed plan markdown in `input.plan`. Surface it
    // as a dedicated plan card (display-only — autoApprove turns just continue);
    // without this the plan content was discarded and only a status line showed.
    if (name === "ExitPlanMode") {
      const plan = asString(input.plan);
      // A real plan becomes a card. An empty ExitPlanMode (degenerate output) still
      // ENDS the planning phase, so signal planning:false to clear the "writing
      // plan…" placeholder right away instead of letting it linger until the turn's
      // terminal reset and then vanish with no trace.
      events.onPlan?.(plan ? { plan } : { plan: "", planning: false });
      events.onStatus?.(plan ? "계획을 확인하는 중…" : "계획 단계 완료");
    } else {
      // EnterPlanMode: no plan exists yet. Signal the UI to show a "writing plan…"
      // placeholder so the planning phase (which suppresses tool rows) doesn't look
      // like a stalled/disconnected turn.
      events.onPlan?.({ plan: "", planning: true });
      events.onStatus?.("계획 모드로 전환 중…");
    }
    return true;
  }
  if (isTaskInspectionTool(name)) {
    return true;
  }
  if (!isTaskCreateTool(name) && !isTaskUpdateTool(name) && !isTaskEndTool(name)) {
    return false;
  }
  const taskId = taskIdFromInput(input, toolUseId);
  if (isTaskCreateTool(name)) {
    const record = { uiId: taskId, kind: "task" as const };
    state.tasks.set(taskId, record);
    if (toolUseId !== taskId) {
      state.tasks.set(toolUseId, record);
    }
    events.onTaskStart?.({
      taskId,
      toolUseId,
      taskType: taskType(input) || undefined,
      subagentType: asString(input.subagent_type) || asString(input.agent_type) || undefined,
      workflowName: asString(input.workflow_name) || undefined,
      description: taskDescription(input) || undefined,
      prompt: asString(input.prompt) || undefined,
    });
    return true;
  }
  if (isTaskEndTool(name)) {
    const status = name === "TaskStop" ? "stopped" : "completed";
    emitTaskUpdate(events, state, taskId, { status, summary: taskDetails(input) || undefined });
    return true;
  }
  emitTaskUpdate(events, state, taskId, {
    status: asString(input.status) || undefined,
    description: taskDescription(input) || undefined,
    summary: taskDetails(input) || undefined,
  });
  return true;
}

/** Process a full `assistant` message: emit tool/agent starts, return main-agent text. */
export function handleAssistantMessage(
  message: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): string {
  const agentId = asString(message.parent_tool_use_id) || MAIN_AGENT_ID;
  const isMain = agentId === MAIN_AGENT_ID;
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      if (isMain) {
        textParts.push(block.text);
      }
      continue;
    }
    if (block.type === "tool_use") {
      const toolUseId = asString(block.id);
      const name = asString(block.name);
      const input = isRecord(block.input) ? block.input : {};
      if (!toolUseId || !name) {
        continue;
      }
      if (handleTaskToolUse(name, toolUseId, input, events, state)) {
        continue;
      }
      if (SUBAGENT_TOOLS.has(name)) {
        state.spawnedAgentIds.add(toolUseId);
        events.onAgentStart?.({
          agentId: toolUseId,
          parentId: agentId,
          // Agent-teams spawn: `name` is the teammate's addressable identity
          // (SendMessage({to: name})) — surface it so the activity tree can
          // label the node.
          name: asString(input.name) || undefined,
          subagentType: asString(input.subagent_type) || undefined,
          description: (asString(input.description) || asString(input.prompt) || "").slice(0, 200) || undefined,
        });
      } else if (!UI_HANDLED_TOOLS.has(name)) {
        // AskUserQuestion (and similar) are shown as their own card, not a tool row.
        events.onToolStart?.({
          toolUseId,
          name,
          agentId,
          inputSummary: summarizeToolInput(name, input),
        });
      }
    }
  }
  return textParts.filter(Boolean).join("\n");
}

/**
 * A subagent spawn's structured result when the CLI launched the agent in the
 * BACKGROUND (`AgentOutput` in sdk-tools.d.ts: status "async_launched", or
 * "remote_launched" for a remote agent), with the id its task events carry.
 */
function backgroundLaunch(toolUseResult: unknown): { agentId: string } | null {
  if (!isRecord(toolUseResult)) {
    return null;
  }
  const status = asString(toolUseResult.status);
  if (status !== "async_launched" && status !== "remote_launched" && toolUseResult.isAsync !== true) {
    return null;
  }
  return { agentId: asString(toolUseResult.agentId) || asString(toolUseResult.taskId) };
}

/** Process a full `user` message: emit tool/agent ends from tool_result blocks. */
export function handleUserMessage(
  message: Record<string, unknown>,
  events: AgentEvents,
  state: LoopState,
): void {
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return;
  }
  // The structured result describes the message's tool_result, so it is only
  // attributable when there is exactly one.
  const toolResults = content.filter((block) => isRecord(block) && block.type === "tool_result");
  const toolUseResult = toolResults.length === 1 ? message.tool_use_result : undefined;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId = asString(block.tool_use_id);
    if (!toolUseId) {
      continue;
    }
    const ok = block.is_error !== true;
    if (state.spawnedAgentIds.has(toolUseId)) {
      // A BACKGROUND spawn's tool_result is only the launch receipt: the agent
      // keeps working and its task_notification ends the card. Ending it here
      // painted a still-running agent as done.
      const launch = ok ? backgroundLaunch(toolUseResult) : null;
      if (launch) {
        if (launch.agentId && !state.tasks.has(launch.agentId)) {
          state.tasks.set(launch.agentId, { uiId: toolUseId, kind: "agent" });
        }
        events.onAgentStart?.({
          agentId: toolUseId,
          parentId: asString(message.parent_tool_use_id) || MAIN_AGENT_ID,
          background: true,
        });
        continue;
      }
      events.onAgentEnd?.({ agentId: toolUseId, ok });
    } else {
      events.onToolEnd?.({ toolUseId, ok });
    }
  }
}

/**
 * Interpret the SDK's terminal `result` message.
 * - success → `{ text }` with the final answer.
 * - error (e.g. `error_max_turns`, which carries `errors[]` but NO `result`
 *   field) → `{ errorSubtype }` so the caller can fall back to the partial
 *   answer streamed so far instead of leaking a raw "Reached maximum number of
 *   turns" string into the chat.
 */
export function interpretResult(message: unknown): { text?: string; errorSubtype?: string; usage?: AgentUsage } {
  if (!isRecord(message) || message.type !== "result") {
    return {};
  }
  const usage = extractUsage(message);
  const withUsage = usage ? { usage } : {};
  if (message.subtype === "success" && typeof message.result === "string") {
    return { text: message.result, ...withUsage };
  }
  if (typeof message.subtype === "string" && message.subtype.startsWith("error")) {
    return { errorSubtype: message.subtype, ...withUsage };
  }
  return withUsage;
}

/**
 * Pull per-turn token usage out of the SDK's terminal `result` message.
 * `usage` (snake_case) carries the input/output/cache counts; `modelUsage`
 * (camelCase, keyed by model) carries the `contextWindow` size. Returns
 * undefined when the message has no usable counts (e.g. error results).
 *
 * IMPORTANT: the result `usage` is CUMULATIVE across every model request the
 * turn made (one per tool round, each re-sending the resumed transcript), NOT
 * a snapshot — so `inputTokens` here sums many overlapping prompts and dividing
 * it by `contextWindow` overstates context fill (the % runs past 100% on
 * tool-heavy turns). `runClaudeAgent` therefore OVERRIDES `inputTokens` with
 * `mainAssistantContextTokens` (the final request's prompt size ≈ live context
 * occupancy) for display; `outputTokens` stays cumulative (total generated this
 * turn). The cumulative value is kept here so the unit test / fallback path
 * still works when no assistant snapshot is available.
 */
/**
 * Prompt-token size of a usage record: `input_tokens` + cache reads + cache
 * creation — the size of the prompt sent on that model request.
 */
function promptTokens(usage: Record<string, unknown>): number {
  return (
    asNumber(usage.input_tokens) +
    asNumber(usage.cache_read_input_tokens) +
    asNumber(usage.cache_creation_input_tokens)
  );
}

/**
 * Reasoning tokens within `output_tokens`, from `output_tokens_details`
 * (`thinking_tokens`) when the SDK populates it — 0 otherwise. `output_tokens`
 * stays the inclusive total; this is just the breakdown so the badge can show
 * the reasoning share separately.
 */
function thinkingTokens(usage: Record<string, unknown>): number {
  const details = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : undefined;
  return details ? asNumber(details.thinking_tokens) : 0;
}

function extractUsage(message: Record<string, unknown>): AgentUsage | undefined {
  const usage = isRecord(message.usage) ? message.usage : undefined;
  const inputTokens = usage ? promptTokens(usage) : 0;
  const outputTokens = usage ? asNumber(usage.output_tokens) : 0;
  const thinking = usage ? thinkingTokens(usage) : 0;
  let contextWindow = 0;
  if (isRecord(message.modelUsage)) {
    for (const entry of Object.values(message.modelUsage)) {
      if (isRecord(entry)) contextWindow = Math.max(contextWindow, asNumber(entry.contextWindow));
    }
  }
  if (!inputTokens && !outputTokens && !contextWindow) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    ...(thinking ? { thinkingTokens: thinking } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/**
 * Prompt-token count of a MAIN-agent assistant message — `input_tokens` +
 * cache reads + cache creation, i.e. the size of the prompt sent on THAT model
 * request. The LAST main-agent assistant message of a turn was prompted with
 * the full transcript so far, so its prompt size ≈ the live context-window
 * occupancy at the end of the turn — a true snapshot, unlike the CUMULATIVE
 * `result` usage (see extractUsage). Returns undefined for subagent messages
 * (`parent_tool_use_id` set — their context is separate) or when the message
 * carries no usage. `runClaudeAgent` tracks the latest value across the turn
 * and feeds it into the usage badge's context %.
 */
export function mainAssistantContextTokens(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== "assistant") {
    return undefined;
  }
  if (asString(message.parent_tool_use_id)) {
    return undefined;
  }
  const inner = isRecord(message.message) ? message.message : undefined;
  const usage = inner && isRecord(inner.usage) ? inner.usage : undefined;
  if (!usage) {
    return undefined;
  }
  const tokens = promptTokens(usage);
  return tokens > 0 ? tokens : undefined;
}

/**
 * Context-occupancy snapshot from a streaming `message_start` event. In
 * streaming mode (`includePartialMessages`) the prompt-size counts
 * (`input_tokens` + cache reads/creation) ride on the `message_start` event's
 * `message.usage`; the FINAL assembled `assistant` message's usage carries only
 * the `message_delta` counts (output, with `input_tokens` null), so
 * `mainAssistantContextTokens` reads 0 there and the occupancy snapshot is
 * never captured during streaming. Reading it here is the streaming counterpart
 * of `mainAssistantContextTokens`: same sum, same MAIN-agent-only gate
 * (`parent_tool_use_id` unset), but off the `stream_event`/`message_start`
 * envelope. The LAST main-agent `message_start` of a turn = the final request's
 * prompt size ≈ live context occupancy. Returns undefined for subagent streams,
 * non-`message_start` events, or a usage-less/zero start.
 */
export function streamStartContextTokens(message: unknown): number | undefined {
  if (!isRecord(message) || message.type !== "stream_event") {
    return undefined;
  }
  if (asString(message.parent_tool_use_id)) {
    return undefined;
  }
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event || event.type !== "message_start") {
    return undefined;
  }
  const inner = isRecord(event.message) ? event.message : undefined;
  const usage = inner && isRecord(inner.usage) ? inner.usage : undefined;
  if (!usage) {
    return undefined;
  }
  const tokens = promptTokens(usage);
  return tokens > 0 ? tokens : undefined;
}

/** Largest standard Claude input window — Opus 4.8 / Sonnet 4.x are natively 1M. */
export const MAX_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * The SDK's `modelUsage.contextWindow` is a STATIC model-table figure that can
 * read a stale base (e.g. 200000) for a model whose true window is larger — Opus
 * 4.8 is natively 1M, not beta-gated. On long/resumed turns the real prompt
 * snapshot (`mainAssistantContextTokens`) then overflows the reported window and
 * the context-occupancy badge % ran PAST 100% on every long turn. Current Claude
 * windows are the 200K or 1M tier, so when the snapshot overflows the reported
 * window the true window must be the 1M tier — lift the denominator there (never
 * below the snapshot itself). Returns the reported window unchanged when it
 * already accommodates the snapshot, or 0 when no window was reported.
 */
export function correctContextWindow(reportedWindow: number, snapshotTokens: number): number {
  if (reportedWindow && snapshotTokens > reportedWindow) {
    return Math.max(MAX_CONTEXT_WINDOW_TOKENS, snapshotTokens);
  }
  return reportedWindow;
}

/**
 * Reconcile a turn's usage for display. `runUsage` carries `extractUsage`'s
 * fields: `inputTokens` there is the CUMULATIVE sum across every tool-round
 * request (each re-sends the resumed transcript), and `contextWindow` is the
 * SDK's STATIC model-table figure (a stale 200K base for Opus 4.8's real 1M).
 * `snapshotTokens` is the last MAIN-agent request's prompt size — true live
 * context occupancy — or `undefined` when no such snapshot was seen this turn
 * (an `error_max_turns` result, or a turn whose only assistant messages were
 * subagents).
 *
 * With a snapshot: it becomes the occupancy numerator and the (possibly stale)
 * window is lifted to fit it — so `inputTokens / contextWindow` is a real
 * fraction in [0, 1]. WITHOUT one: the cumulative `inputTokens` has no meaning
 * as "current fill", so we DON'T divide it by the window — zero out both
 * context numbers (`inputTokens: 0`, `contextWindow: 0`) and let the badge fall
 * back to its output-only label rather than show a fabricated ratio.
 * `outputTokens` (cumulative total generated) is preserved either way.
 */
export function finalizeTurnUsage(runUsage: AgentUsage, snapshotTokens: number | undefined): AgentUsage {
  if (snapshotTokens === undefined) {
    return { ...runUsage, inputTokens: 0, contextWindow: 0 };
  }
  const contextWindow = correctContextWindow(runUsage.contextWindow ?? 0, snapshotTokens);
  return {
    ...runUsage,
    inputTokens: snapshotTokens,
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/** Human-facing fallback when the run ended on an error with no usable text. */
export function resultErrorMessage(subtype: string): string {
  if (subtype === "error_max_turns") {
    return "응답이 최대 처리 단계에 도달해 중단되었습니다. 질문을 더 작게 나눠 다시 시도해 주세요.";
  }
  return "응답 생성 중 오류가 발생해 완료하지 못했습니다. 다시 시도해 주세요.";
}

/**
 * The main-agent text delta carried by this message, or "" for anything else
 * (subagent deltas, thinking deltas, non-stream messages).
 *
 * WHY it is separate from `handleStreamEvent`: the streaming loops must detect a
 * main-agent text delta BEFORE calling `dispatchSdkMessage`, because dispatch is
 * what emits the delta through `onDelta`. A fold triggered by this delta has to
 * reach the sinks AHEAD of the new block's first chunk — behind it, the sinks
 * sweep that chunk into the reasoning view and the kept text loses its head
 * (the live bubble always; the persisted text on the cancel/error paths, which
 * slice from `foldedTextOffset`).
 */
export function peekMainTextDelta(message: Record<string, unknown>): string {
  if (message.type !== "stream_event" || asString(message.parent_tool_use_id)) {
    return "";
  }
  const event = isRecord(message.event) ? message.event : undefined;
  if (
    !event ||
    event.type !== "content_block_delta" ||
    !isRecord(event.delta) ||
    event.delta.type !== "text_delta"
  ) {
    return "";
  }
  return asString(event.delta.text);
}

/**
 * Parse a single SDK `stream_event` message and fire matching streaming
 * callbacks. Returns the text delta (if any) so callers can accumulate it.
 * Subagent deltas (parent_tool_use_id set) are NOT appended to the main bubble.
 *
 * The text branch delegates to `peekMainTextDelta` so the loops' pre-dispatch
 * peek and this dispatch can never drift into disagreeing about what counts as
 * a main-agent text delta.
 */
export function handleStreamEvent(message: Record<string, unknown>, events: AgentEvents): string {
  const text = peekMainTextDelta(message);
  if (text) {
    events.onDelta?.(text);
    return text;
  }
  const event = isRecord(message.event) ? message.event : undefined;
  if (!event) {
    return "";
  }
  const isMain = !asString(message.parent_tool_use_id);
  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    if (event.delta.type === "thinking_delta") {
      // Reasoning stream: forward to the dedicated thinking view only. It is NOT
      // returned (so the caller never appends it to the answer bubble's deltas).
      const thinking = asString(event.delta.thinking);
      if (thinking && isMain) {
        events.onThinking?.(thinking);
      }
    }
  }
  return "";
}

function handleTaskSystemEvent(message: Record<string, unknown>, events: AgentEvents, state: LoopState): boolean {
  const subtype = asString(message.subtype);
  const taskId = asString(message.task_id);
  if (!taskId) {
    return false;
  }

  if (subtype === "task_started") {
    if (message.skip_transcript === true) {
      state.hiddenTasks.add(taskId);
      return true;
    }
    const toolUseId = asString(message.tool_use_id);
    const existing = state.tasks.get(taskId) || (toolUseId ? state.tasks.get(toolUseId) : undefined);
    const uiId = existing?.uiId || toolUseId || taskId;
    // A Workflow (ultracode) container task carries workflow_name regardless of
    // its exact task_type literal ("local_workflow" today) — a more robust
    // signal than matching the type string. It renders as an agent node too
    // (not a plain task row) purely so its spawned agents have somewhere in
    // the liveAgents parentId chain to nest under; TASK rows only ever attach
    // to an agentId, they can't themselves be a parent.
    const workflowName = asString(message.workflow_name) || undefined;
    const isWorkflowContainer = Boolean(workflowName);
    const taskKind: TaskKind =
      isWorkflowContainer ||
      AGENT_TASK_TYPES.has(asString(message.task_type)) ||
      Boolean(asString(message.subagent_type))
        ? "agent"
        : existing?.kind || "task";
    const record = { uiId, kind: taskKind };
    state.tasks.set(taskId, record);
    if (toolUseId) {
      state.tasks.set(toolUseId, record);
    }
    if (taskKind === "agent") {
      state.spawnedAgentIds.add(uiId);
      // A workflow's own container spawn is top-level; everything else nests
      // under whichever workflow is currently active, if any (agent-teams
      // background teammate spawns and Task/Agent's own background_tasks_changed
      // echoes have no workflow in flight, so they fall back to MAIN_AGENT_ID
      // exactly as before).
      const parentId = isWorkflowContainer ? MAIN_AGENT_ID : state.activeWorkflowAgentId || MAIN_AGENT_ID;
      events.onAgentStart?.({
        agentId: uiId,
        parentId,
        // Background teammate spawns announce via task_started; carry the
        // teammate name when the event provides it.
        name: asString(message.teammate_name) || undefined,
        subagentType: asString(message.subagent_type) || undefined,
        description:
          (isWorkflowContainer ? `워크플로 실행: ${workflowName}` : undefined) ||
          asString(message.description) ||
          asString(message.prompt) ||
          undefined,
      });
      if (isWorkflowContainer) {
        state.activeWorkflowAgentId = uiId;
      }
    } else {
      events.onTaskStart?.({
        taskId: uiId,
        toolUseId: asString(message.tool_use_id) || undefined,
        taskType: asString(message.task_type) || undefined,
        subagentType: asString(message.subagent_type) || undefined,
        workflowName: asString(message.workflow_name) || undefined,
        description: asString(message.description) || undefined,
        prompt: asString(message.prompt) || undefined,
      });
    }
    return true;
  }

  if (state.hiddenTasks.has(taskId)) {
    return true;
  }

  if (subtype === "task_progress") {
    emitTaskUpdate(events, state, taskId, {
      description: asString(message.description) || undefined,
      summary: asString(message.summary) || undefined,
      lastToolName: asString(message.last_tool_name) || undefined,
    });
    return true;
  }

  if (subtype === "task_updated") {
    const patch = isRecord(message.patch) ? message.patch : {};
    emitTaskUpdate(events, state, taskId, {
      status: asString(patch.status) || undefined,
      description: asString(patch.description) || undefined,
      error: asString(patch.error) || undefined,
      isBackgrounded: typeof patch.is_backgrounded === "boolean" ? patch.is_backgrounded : undefined,
    });
    return true;
  }

  if (subtype === "task_notification") {
    emitTaskUpdate(events, state, taskId, {
      status: asString(message.status) || undefined,
      summary: asString(message.summary) || undefined,
    });
    return true;
  }

  return false;
}

export function handleSystemEvent(message: Record<string, unknown>, events: AgentEvents, state: LoopState): void {
  const subtype = asString(message.subtype);
  // Level signal: the FULL set of live background tasks after a membership
  // change (start/completion/kill/backgrounding). Replace — never pair edges —
  // so a missed bookend can't wedge a stale running indicator.
  if (subtype === "background_tasks_changed") {
    state.backgroundTasks.clear();
    const tasks = Array.isArray(message.tasks) ? message.tasks : [];
    for (const entry of tasks) {
      if (!isRecord(entry)) {
        continue;
      }
      const taskId = asString(entry.task_id);
      if (!taskId) {
        continue;
      }
      state.backgroundTasks.set(taskId, {
        taskId,
        taskType: asString(entry.task_type) || undefined,
        description: asString(entry.description) || undefined,
      });
    }
    events.onBackgroundTasks?.({ tasks: [...state.backgroundTasks.values()] });
    return;
  }
  if (handleTaskSystemEvent(message, events, state)) {
    return;
  }
  if (subtype === "init") {
    const model = asString(message.model);
    if (model) {
      events.onModel?.(model);
    }
    const sessionId = asString(message.session_id);
    if (sessionId) {
      events.onSessionId?.(sessionId);
    }
    events.onStatus?.(model ? `Claude 준비 완료 (${model})` : "Claude 준비 완료");
    const pluginList =
      (Array.isArray(message.plugins) && message.plugins) ||
      (Array.isArray(message.loadedPlugins) && message.loadedPlugins) ||
      [];
    for (const entry of pluginList) {
      let name = "";
      if (typeof entry === "string") {
        name = entry;
      } else if (isRecord(entry)) {
        name = asString(entry.name);
      }
      if (name) {
        events.onPlugin?.({ status: "completed", name });
      }
    }
    return;
  }
  if (subtype === "plugin_install") {
    const name = asString(message.name);
    const status = asString(message.status);
    const normalized: "started" | "installed" | "failed" | "completed" =
      status === "started" || status === "installed" || status === "failed" || status === "completed"
        ? status
        : "started";
    events.onPlugin?.({ status: normalized, name });
    events.onStatus?.(name ? `플러그인 불러오는 중… (${name})` : "플러그인 불러오는 중…");
    return;
  }
  if (subtype === "permission_denied") {
    // A tool was auto-denied without an interactive prompt (read-only colleague,
    // dontAsk, or a deny rule). Surface it so the client can show "blocked".
    // `decision_reason` is MODEL-facing text (English — on our own hook denies it
    // is the directive prose from hookDeny), and this event arrives with the SAME
    // toolUseId the hook already reported, so it would overwrite the hook's Korean
    // row label. Carry a Korean `uiReason` so the row stays Korean either way.
    const decisionReason =
      asString(message.decision_reason) || asString(message.message);
    events.onBlocked?.({
      toolUseId: asString(message.tool_use_id) || undefined,
      toolName: asString(message.tool_name),
      agentId: asString(message.agent_id) || MAIN_AGENT_ID,
      reason: decisionReason || undefined,
      uiReason: decisionReason
        ? `권한 정책에 따라 자동 거부되었습니다: ${truncate(decisionReason.replace(/\s+/g, " ").trim(), 120)}`
        : "권한 정책에 따라 자동 거부되었습니다.",
    });
    return;
  }
  if (subtype === "compact_boundary") {
    // The conversation was summarized. The live "맥락 정리 중…" label is gone by
    // now, so raise a durable notice carrying what the SDK told us about it.
    const metadata = isRecord(message.compact_metadata) ? message.compact_metadata : undefined;
    const trigger = asString(metadata?.trigger);
    const preTokens = asNumber(metadata?.pre_tokens);
    events.onCompact?.({
      ok: true,
      trigger: trigger === "auto" || trigger === "manual" ? trigger : undefined,
      preTokens: preTokens > 0 ? preTokens : undefined,
    });
    return;
  }
  if (subtype === "status") {
    const status = asString(message.status);
    // A FAILED compaction is otherwise silent: the run continues until it dies
    // on the context limit with an opaque error. `compact_error` is SDK English
    // (model/diagnostic text), so it rides as a suffix on Korean label prose —
    // same shape as the permission_denied uiReason above. A SUCCESSFUL result
    // raises no event: the compact_boundary message already made the row.
    const compactResult = asString(message.compact_result);
    const compactError = asString(message.compact_error);
    if (compactResult === "failed") {
      events.onCompact?.({ ok: false, error: compactError || undefined });
      events.onStatus?.(
        compactError
          ? `맥락 정리에 실패했습니다: ${truncate(compactError.replace(/\s+/g, " ").trim(), 120)}`
          : "맥락 정리에 실패했습니다",
      );
      return;
    }
    const label =
      status === "requesting"
        ? "응답 생성 중…"
        : status === "compacting"
          ? "맥락 정리 중…"
          : "처리 중…";
    events.onStatus?.(label);
  }
}

/** Non-streaming text extraction (main agent only); used when no events sink. */
export function extractMainAssistantText(message: Record<string, unknown>): string {
  if (asString(message.parent_tool_use_id)) {
    return "";
  }
  const messageRecord = isRecord(message.message) ? message.message : undefined;
  const content = messageRecord?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Normalized result of dispatching one recursively-serialized Claude Agent SDK
 * envelope. Both the in-process SDK iterator and the external gateway runner use
 * this function, so SDK event semantics stay identical across the two paths.
 */
export interface SdkMessageDispatchResult {
  kind:
    | "stream_event"
    | "system"
    | "user"
    | "tool_progress"
    | "assistant"
    | "result"
    | "other";
  delta?: string;
  assistantText?: string;
  resultText?: string;
  errorSubtype?: string;
  usage?: AgentUsage;
  contextTokens?: number;
  /** True only for a main-agent assembled assistant envelope. */
  mainAssistant?: boolean;
}

export function dispatchSdkMessage(
  message: Record<string, unknown>,
  events: AgentEvents | undefined,
  state: LoopState,
): SdkMessageDispatchResult {
  // One trace point for both local and gateway-delivered SDK messages.
  traceSdkMessage(message);

  if (message.type === "stream_event") {
    const delta = events ? handleStreamEvent(message, events) : "";
    const contextTokens = events
      ? streamStartContextTokens(message)
      : undefined;
    return {
      kind: "stream_event",
      ...(delta ? { delta } : {}),
      ...(contextTokens !== undefined
        ? { contextTokens }
        : {}),
    };
  }
  if (message.type === "system") {
    if (events) handleSystemEvent(message, events, state);
    return { kind: "system" };
  }
  if (message.type === "user") {
    if (events) handleUserMessage(message, events, state);
    return { kind: "user" };
  }
  if (message.type === "tool_progress") {
    if (events) {
      // Raw ids (`mcp__repo__write_file`) are an implementation detail — show the
      // same label the activity row uses.
      const label = sdkToolLabel(
        asString(message.tool_name) || asString(message.toolName),
      );
      events.onStatus?.(label ? `실행 중: ${label}` : "실행 중…");
    }
    return { kind: "tool_progress" };
  }
  if (message.type === "assistant") {
    const assistantText = events
      ? handleAssistantMessage(message, events, state)
      : extractMainAssistantText(message);
    const contextTokens = mainAssistantContextTokens(message);
    return {
      kind: "assistant",
      mainAssistant: !asString(message.parent_tool_use_id),
      ...(assistantText ? { assistantText } : {}),
      ...(contextTokens !== undefined ? { contextTokens } : {}),
    };
  }

  const { text, errorSubtype, usage } = interpretResult(message);
  if (message.type === "result") {
    return {
      kind: "result",
      ...(text ? { resultText: text } : {}),
      ...(errorSubtype ? { errorSubtype } : {}),
      ...(usage ? { usage } : {}),
    };
  }
  return { kind: "other" };
}
