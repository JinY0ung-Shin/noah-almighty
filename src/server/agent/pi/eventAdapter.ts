/**
 * pi-gateway `/v1/responses` SSE → Noah `AgentEvents` (design §6 N3).
 *
 * The `AgentEvents` contract (kept from the removed SDK runner) this adapter fulfils:
 * - `onDelta` carries MAIN-agent answer text only; reasoning goes to `onThinking`.
 * - Text FOLD: during an agentic turn the model narrates between tool calls; only
 *   the LAST text block is the answer, earlier blocks are demoted to the reasoning
 *   view via `onTextFold` — fired at the first delta of a NEW block (before that
 *   delta reaches `onDelta`) and once more at the end (keep last). No `onTextFold`
 *   sink ⇒ no folding and the final text is every block joined (legacy contract).
 * - `onToolStart`/`onToolEnd` use Noah's tool names (`Read`, `Bash`,
 *   `mcp__repo__commit`, …) and a one-line input summary; subagent runs
 *   (`Agent`, and `SendMessage` continuing one) use `onAgentStart`/`onAgentEnd`;
 *   AskUserQuestion never shows as a tool row.
 * - A subagent's own tool calls arrive as the same tool events tagged with
 *   `parent_tool_use_id` (the `Agent`/`SendMessage` call); they nest under that
 *   card (`ToolEvent.agentId`), never under the main agent.
 *
 * pi specifics the adapter absorbs (verified against pi-gateway `api/mapper.ts`):
 * - pi keeps ONE `message` output item open across tool calls (it closes it only
 *   at reasoning, a file item, or the turn end), so a block boundary is "a text
 *   delta after any tool/reasoning/item event since the last text delta", not
 *   only a new `message` item.
 * - MCP tools are called through `mcp_call {name, arguments}` (discovered with
 *   `mcp_search`); the real `mcp__<server>__<tool>` name lives in `input.name`.
 *   `response.tool_use_started` only has the proxy name, so rows start on the
 *   full `response.tool_use`.
 * - pi retries a failed model attempt internally and closes that attempt's open
 *   items with status `incomplete` (the deltas were already streamed). An
 *   `incomplete` message item that is NOT immediately followed by the terminal
 *   event is such a discarded attempt: its text leaves the answer (folded into
 *   the reasoning view when a fold sink exists). Only the FAILED attempt's text
 *   goes: pi checkpoints at each model call's `message_start` and keeps the
 *   item's text before it, and since that event is not on the wire the adapter
 *   uses the call boundaries it does see — a `response.created` and every
 *   `response.tool_result` (the next model call starts after the tools ran).
 * - AskUserQuestion ends the pi turn (`requires_action` + `function_call`); the
 *   answer is the NEXT request's `function_call_output`. `runPiTurn` loops that
 *   inside one Noah run so the host still sees one blocking `onQuestion`.
 */
import type { AgentUsage } from "../../types.js";
import { MAIN_AGENT_ID, type AgentEvents, type QuestionAnswer } from "../events.js";
import { asString, isRecord, truncate } from "../agentUtils.js";
import { mcpToolInputSummary, sdkToolLabel } from "../../../shared/sdkToolPresentation.js";
import {
  PiGatewayError,
  type PiResponseRequest,
  type PiResponsesClient,
  type PiRetryOptions,
  type PiStreamEvent,
} from "./responsesClient.js";

// ---- Tool presentation ---------------------------------------------------------

export type PiToolKind = "tool" | "agent" | "question" | "hidden";

/**
 * pi built-in tool name → how Noah presents it. `noahName` is what reaches
 * `ToolEvent.name` (and so the client's label/summary tables). Their Korean
 * labels (`LS`, `McpSearch`, `PresentFile`, `RequestAdmin` included) live in
 * `SDK_TOOL_LABELS` (`src/shared/sdkToolPresentation.ts`); pi inputs key their
 * path as `path`, which both summaries already read.
 */
export const PI_TOOL_PRESENTATION: Readonly<Record<string, { kind: PiToolKind; noahName: string }>> = {
  read: { kind: "tool", noahName: "Read" },
  write: { kind: "tool", noahName: "Write" },
  edit: { kind: "tool", noahName: "Edit" },
  bash: { kind: "tool", noahName: "Bash" },
  grep: { kind: "tool", noahName: "Grep" },
  find: { kind: "tool", noahName: "Glob" },
  ls: { kind: "tool", noahName: "LS" },
  mcp_search: { kind: "tool", noahName: "McpSearch" },
  // Noah publishes files through its own mcp__file_output__*; pi's present_file
  // also yields a `file` output item, handed to `onPresentedFile`.
  present_file: { kind: "tool", noahName: "PresentFile" },
  request_admin: { kind: "tool", noahName: "RequestAdmin" },
  // Continues a subagent: its own tool calls nest under this call like an Agent's.
  SendMessage: { kind: "agent", noahName: "SendMessage" },
  Agent: { kind: "agent", noahName: "Agent" },
  AskUserQuestion: { kind: "question", noahName: "AskUserQuestion" },
  // text.format json_schema only — Noah does not request it; never a row.
  StructuredOutput: { kind: "hidden", noahName: "StructuredOutput" },
};

export const PI_MCP_CALL_TOOL = "mcp_call";

export interface ResolvedPiTool {
  kind: PiToolKind;
  /** Noah-facing tool name (`mcp__repo__commit`, `Read`, …). */
  name: string;
  /** The input as Noah sees it (an `mcp_call`'s inner `arguments`). */
  input: Record<string, unknown>;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Unwrap pi's proxy names. `mcp_call {name, arguments}` becomes the real MCP tool
 * (pi registers each MCP tool under `mcp__<server id>__<tool>`, and Noah's broker
 * ids are its server names, so `mcp__repo__commit` survives unchanged). A model
 * may also call a hidden MCP declaration directly by its full name — that already
 * is the Noah name. Unknown names pass through as-is.
 */
export function resolvePiTool(name: string, input: unknown): ResolvedPiTool {
  const args = parseArguments(input);
  if (name === PI_MCP_CALL_TOOL) {
    const inner = asString(args.name).trim();
    return { kind: "tool", name: inner || PI_MCP_CALL_TOOL, input: parseArguments(args.arguments) };
  }
  const mapped = PI_TOOL_PRESENTATION[name];
  if (mapped) return { kind: mapped.kind, name: mapped.noahName, input: args };
  return { kind: "tool", name, input: args };
}

/**
 * One-line input summary for the activity UI (the removed SDK runner's
 * `summarizeToolInput` rules, ported).
 * pi built-ins key their path as `path` (read/write/edit/ls/find/grep).
 */
export function summarizePiToolInput(name: string, input: Record<string, unknown>): string {
  const special = mcpToolInputSummary(name, input);
  if (special !== undefined) return special;
  const path = asString(input.file_path) || asString(input.path) || asString(input.notebook_path);
  const cmd = asString(input.command);
  const pattern = asString(input.pattern);
  const url = asString(input.url);
  const query = asString(input.query) || asString(input.prompt);
  let summary = "";
  if (name === "SendMessage") {
    const recipient = asString(input.recipient) || asString(input.to);
    const preview = asString(input.summary) || asString(input.content) || asString(input.message);
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

// ---- Outcomes -------------------------------------------------------------------

export interface PiPresentedFile {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface PiPendingQuestion {
  callId: string;
  name: string;
  questions: unknown[];
}

export type PiTurnOutcome =
  | { status: "completed"; responseId: string; usage?: AgentUsage }
  | { status: "incomplete"; responseId: string; reason?: string; usage?: AgentUsage }
  | { status: "requires_action"; responseId: string; question: PiPendingQuestion; usage?: AgentUsage }
  | { status: "failed"; responseId?: string; error: { code: string; message: string } };

/** pi `incomplete_details.reason` → the result error subtype Noah's fallbacks key on (names kept from the SDK era). */
export function incompleteErrorSubtype(reason: string | undefined): string | undefined {
  if (reason === "max_tool_calls") return "error_max_turns";
  if (reason === "max_output_tokens") return "error_max_output_tokens";
  // user_cancelled is Noah's own stop; the host's abort path owns it.
  return undefined;
}

export interface PiEventAdapterOptions {
  /** Model context window for the usage badge (until pi reports `usage.context_window`, design P5). */
  contextWindow?: number;
  /** pi `present_file` output items (Noah publishes via its own file_output MCP; wiring is later work). */
  onPresentedFile?: (file: PiPresentedFile) => void;
}

interface TextBlock {
  text: string;
  /** Dropped from the answer (a discarded pi retry attempt). */
  discarded: boolean;
}

interface ToolRecord {
  kind: PiToolKind;
  name: string;
}

/**
 * Stateful adapter for ONE Noah run. It may span several pi responses (an
 * AskUserQuestion round trip continues the same bubble), so fold/tool state lives
 * here and survives `handle()` calls across streams.
 */
export class PiEventAdapter {
  private readonly events: AgentEvents;
  private readonly options: PiEventAdapterOptions;
  private readonly blocks: TextBlock[] = [];
  private textOpen = false;
  private foldIndex = 0;
  /** message item id → index of the first text block it carried. */
  private readonly itemFirstBlock = new Map<string, number>();
  private currentMessageItem: string | null = null;
  private pendingDiscard: string | null = null;
  /** First block of the CURRENT model call (blocks before it survive a retry discard). */
  private attemptStartBlock = 0;
  private readonly tools = new Map<string, ToolRecord>();
  /** reasoning item id → which delta family it streams (pi sends both summary_text and reasoning_text). */
  private readonly reasoningSource = new Map<string, "text" | "summary">();
  private pendingQuestion: PiPendingQuestion | null = null;
  private modelReported = false;
  private lastStatus = "";
  /** The response currently streaming (cancel target). */
  responseId: string | null = null;

  constructor(events: AgentEvents | undefined, options: PiEventAdapterOptions = {}) {
    this.events = events ?? {};
    this.options = options;
  }

  private get foldEnabled(): boolean {
    return typeof this.events.onTextFold === "function";
  }

  private status(label: string): void {
    if (label === this.lastStatus) return;
    this.lastStatus = label;
    this.events.onStatus?.(label);
  }

  private closeText(): void {
    this.textOpen = false;
  }

  private foldUpTo(end: number): void {
    if (!this.foldEnabled || end - this.foldIndex <= 0) return;
    const folded = this.blocks
      .slice(this.foldIndex, end)
      .filter((b) => !b.discarded)
      .map((b) => b.text)
      .join("\n\n")
      .trim();
    if (folded) this.events.onTextFold!(folded);
    this.foldIndex = end;
  }

  private textDelta(delta: string): void {
    if (!delta) return;
    if (!this.textOpen) {
      // A new text block: everything before it is narration (fold BEFORE the
      // delta reaches onDelta, or the sink sweeps the new head into reasoning).
      this.foldUpTo(this.blocks.length);
      this.blocks.push({ text: "", discarded: false });
      this.textOpen = true;
      if (this.currentMessageItem && !this.itemFirstBlock.has(this.currentMessageItem)) {
        this.itemFirstBlock.set(this.currentMessageItem, this.blocks.length - 1);
      }
    }
    this.blocks[this.blocks.length - 1]!.text += delta;
    this.events.onDelta?.(delta);
  }

  /** A retried pi attempt's message item: its text is no longer part of the answer. */
  private applyPendingDiscard(): void {
    const itemId = this.pendingDiscard;
    this.pendingDiscard = null;
    if (!itemId) return;
    const itemFirst = this.itemFirstBlock.get(itemId);
    if (itemFirst === undefined) return;
    // Text the item carried from EARLIER model calls (before the last tool
    // result) stays, like pi's own `discardAttempt`.
    const first = Math.max(itemFirst, this.attemptStartBlock);
    const end = this.blocks.length;
    if (this.foldEnabled) {
      const start = Math.max(first, this.foldIndex);
      const text = this.blocks
        .slice(start, end)
        .filter((b) => !b.discarded)
        .map((b) => b.text)
        .join("\n\n")
        .trim();
      if (text) this.events.onTextFold!(text);
      this.foldIndex = Math.max(this.foldIndex, end);
    }
    for (let i = first; i < end; i++) this.blocks[i]!.discarded = true;
    this.closeText();
  }

  /** `parent` is the subagent card a nested call belongs to (pi's `parent_tool_use_id`). */
  private toolStart(id: string, rawName: string, input: unknown, parent: string): void {
    if (!id || this.tools.has(id)) return;
    const tool = resolvePiTool(rawName, input);
    this.tools.set(id, { kind: tool.kind, name: tool.name });
    // Only a subagent card owns nested calls; an unknown parent falls back to the main agent.
    const agentId = parent && this.tools.get(parent)?.kind === "agent" ? parent : MAIN_AGENT_ID;
    if (tool.kind === "agent") {
      this.events.onAgentStart?.({
        agentId: id,
        parentId: agentId,
        subagentType: asString(tool.input.subagent_type) || undefined,
        description:
          (asString(tool.input.description) || asString(tool.input.prompt) || asString(tool.input.message)).slice(0, 200) || undefined,
      });
      this.status("에이전트 작업 중…");
    } else if (tool.kind === "tool") {
      this.events.onToolStart?.({
        toolUseId: id,
        name: tool.name,
        agentId,
        inputSummary: summarizePiToolInput(tool.name, tool.input),
      });
      const label = sdkToolLabel(tool.name);
      this.status(label ? `실행 중: ${label}` : "실행 중…");
    }
  }

  private toolEnd(id: string, ok: boolean): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    if (tool.kind === "agent") this.events.onAgentEnd?.({ agentId: id, ok });
    else if (tool.kind === "tool") this.events.onToolEnd?.({ toolUseId: id, ok });
  }

  private usage(response: Record<string, unknown>): AgentUsage | undefined {
    const usage = isRecord(response.usage) ? response.usage : undefined;
    if (!usage) return undefined;
    const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const outputDetails = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const context = typeof details.context_tokens === "number" && details.context_tokens > 0 ? details.context_tokens : 0;
    const reported = typeof usage.context_window === "number" ? usage.context_window : undefined;
    const window = reported ?? this.options.contextWindow ?? 0;
    const thinking = typeof outputDetails.reasoning_tokens === "number" ? outputDetails.reasoning_tokens : 0;
    if (!output && !context) return undefined;
    // Without a context snapshot there is no honest fill ratio (finalizeTurnUsage rule).
    return {
      inputTokens: context,
      outputTokens: output,
      ...(thinking ? { thinkingTokens: thinking } : {}),
      ...(context && window ? { contextWindow: Math.max(window, context) } : {}),
    };
  }

  private turnResult(usage: AgentUsage | undefined, errorSubtype: string | undefined): void {
    this.events.onTurnResult?.({
      text: this.answerText(false),
      ...(usage ? { usage } : {}),
      ...(errorSubtype ? { errorSubtype } : {}),
    });
  }

  /**
   * Feed one SSE event. Returns the turn's outcome on a terminal event (the
   * stream ends right after), else null.
   */
  handle(event: PiStreamEvent): PiTurnOutcome | null {
    const { type, data } = event;
    const isTerminal =
      type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error";
    if (this.pendingDiscard) {
      if (isTerminal) this.pendingDiscard = null; // a turn-end close, not a retry
      else this.applyPendingDiscard();
    }
    switch (type) {
      case "response.created": {
        this.attemptStartBlock = this.blocks.length;
        const response = isRecord(data.response) ? data.response : {};
        this.responseId = asString(response.id) || this.responseId;
        const model = asString(response.model);
        if (model && !this.modelReported) {
          this.modelReported = true;
          this.events.onModel?.(model);
        }
        return null;
      }
      case "response.in_progress":
        this.status("응답 생성 중…");
        return null;
      case "response.output_item.added": {
        const item = isRecord(data.item) ? data.item : {};
        const itemType = asString(item.type);
        if (itemType === "message") {
          this.closeText();
          this.currentMessageItem = asString(item.id) || null;
        } else if (itemType === "reasoning") {
          this.closeText();
        } else if (itemType === "file") {
          this.closeText();
          const file: PiPresentedFile = {
            path: asString(item.path),
            filename: asString(item.filename),
            mimeType: asString(item.mime_type) || "application/octet-stream",
            size: typeof item.size === "number" ? item.size : 0,
          };
          if (file.path) this.options.onPresentedFile?.(file);
        } else if (itemType === "function_call") {
          this.closeText();
          const args = parseArguments(item.arguments);
          this.pendingQuestion = {
            callId: asString(item.call_id),
            name: asString(item.name),
            questions: Array.isArray(args.questions) ? args.questions : [],
          };
        }
        return null;
      }
      case "response.output_text.delta":
        this.textDelta(asString(data.delta));
        return null;
      case "response.output_item.done": {
        const item = isRecord(data.item) ? data.item : {};
        if (asString(item.type) === "message") {
          const id = asString(item.id);
          if (asString(item.status) === "incomplete" && id) this.pendingDiscard = id;
          if (this.currentMessageItem === id) this.currentMessageItem = null;
          this.closeText();
        }
        return null;
      }
      case "response.reasoning_text.delta":
      case "response.reasoning_summary_text.delta": {
        const source = type === "response.reasoning_text.delta" ? "text" : "summary";
        const itemId = asString(data.item_id);
        const chosen = this.reasoningSource.get(itemId);
        if (!chosen) this.reasoningSource.set(itemId, source);
        else if (chosen !== source) return null;
        this.closeText();
        const delta = asString(data.delta);
        if (delta) this.events.onThinking?.(delta);
        return null;
      }
      case "response.tool_use_started": {
        this.closeText();
        const name = asString(data.name);
        if (name && name !== PI_MCP_CALL_TOOL && PI_TOOL_PRESENTATION[name]?.kind === "tool") {
          const label = sdkToolLabel(PI_TOOL_PRESENTATION[name]!.noahName);
          this.status(label ? `준비 중: ${label}` : "도구 준비 중…");
        } else {
          this.status("도구 준비 중…");
        }
        return null;
      }
      case "response.tool_use":
        this.closeText();
        this.toolStart(asString(data.tool_use_id), asString(data.name), data.input, asString(data.parent_tool_use_id));
        return null;
      case "response.tool_progress": {
        const tool = this.tools.get(asString(data.tool_use_id));
        if (tool?.kind === "tool") {
          const label = sdkToolLabel(tool.name);
          const message = asString(data.message).trim();
          this.status(`실행 중: ${label ?? tool.name}${message ? ` — ${truncate(message, 80)}` : ""}`);
        }
        return null;
      }
      case "response.tool_result":
        this.closeText();
        this.toolEnd(asString(data.tool_use_id), data.is_error !== true);
        this.attemptStartBlock = this.blocks.length;
        return null;
      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "error":
        return this.terminal(type, data);
      default:
        return null;
    }
  }

  private terminal(type: string, data: Record<string, unknown>): PiTurnOutcome {
    this.closeText();
    const response = isRecord(data.response) ? data.response : {};
    const responseId = asString(response.id) || this.responseId || "";
    const status = asString(response.status);
    if (type === "response.failed" || type === "error") {
      const error = isRecord(response.error) ? response.error : isRecord(data.error) ? data.error : {};
      return {
        status: "failed",
        ...(responseId ? { responseId } : {}),
        error: { code: asString(error.code) || "server_error", message: asString(error.message) || "Turn failed" },
      };
    }
    const usage = this.usage(response);
    if (status === "requires_action") {
      let question = this.pendingQuestion;
      const output = Array.isArray(response.output) ? response.output.filter(isRecord) : [];
      const call = output.find((item) => item.type === "function_call");
      if (!question && call) {
        const args = parseArguments(call.arguments);
        question = {
          callId: asString(call.call_id),
          name: asString(call.name),
          questions: Array.isArray(args.questions) ? args.questions : [],
        };
      }
      this.pendingQuestion = null;
      if (!question?.callId) {
        return { status: "failed", responseId, error: { code: "protocol", message: "requires_action without a function_call" } };
      }
      return { status: "requires_action", responseId, question, ...(usage ? { usage } : {}) };
    }
    // Only a COMMITTED pi turn may become the conversation's resume point.
    if (responseId) this.events.onSessionId?.(responseId);
    if (type === "response.incomplete" || status === "incomplete") {
      const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
      const reason = asString(details.reason) || undefined;
      this.turnResult(usage, incompleteErrorSubtype(reason));
      return { status: "incomplete", responseId, ...(reason ? { reason } : {}), ...(usage ? { usage } : {}) };
    }
    this.turnResult(usage, undefined);
    return { status: "completed", responseId, ...(usage ? { usage } : {}) };
  }

  /**
   * The run's answer text. With a fold sink: the LAST kept block (`finalize`
   * folds the rest); without one: every kept block joined (legacy contract).
   */
  answerText(finalize: boolean): string {
    if (finalize) {
      const kept = this.blocks.map((b, i) => ({ b, i })).filter(({ b }) => !b.discarded && b.text.trim());
      const last = kept.at(-1);
      if (this.foldEnabled && last) this.foldUpTo(last.i);
    }
    const kept = this.blocks.slice(this.foldEnabled ? this.foldIndex : 0).filter((b) => !b.discarded);
    return kept
      .map((b) => b.text)
      .join("\n\n")
      .trim();
  }
}

// ---- AskUserQuestion answers ------------------------------------------------------

/**
 * Noah's question answer → the `function_call_output` text (model-facing English;
 * pi prefixes it with "User responded: "). Keeps the removed SDK runner's wording.
 */
export function formatPiQuestionAnswer(answer: QuestionAnswer | null): string {
  if (!answer || answer.behavior !== "completed") {
    return "The user dismissed the question without answering. Proceed without an answer.";
  }
  const result = answer.result;
  const answers = isRecord(result) && isRecord(result.answers) ? result.answers : null;
  const lines = answers
    ? Object.entries(answers)
        .map(([question, value]): [string, string] => [
          question,
          Array.isArray(value) ? value.map(String).join(", ") : asString(value) || (value == null ? "" : String(value)),
        ])
        .filter(([question, value]) => question && value)
        .map(([question, value]) => `- "${question}" → ${value}`)
    : [];
  return lines.length ? `The user answered the question(s) as follows:\n${lines.join("\n")}` : "The user provided an answer.";
}

// ---- One Noah run over pi -----------------------------------------------------------

/** A pi turn ended `failed` in-band. `status` lets `isRetryableModelError` classify it. */
export class PiTurnFailedError extends Error {
  readonly code: string;
  readonly status: number;
  readonly upstreamMessage: string;
  constructor(code: string, upstreamMessage: string) {
    super(
      code === "rate_limit"
        ? "모델 요청 한도에 걸려 응답을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."
        : code === "empty_response"
          ? "모델이 빈 응답을 반환했습니다. 다시 시도해 주세요."
          : "응답 생성 중 오류가 발생해 완료하지 못했습니다. 다시 시도해 주세요.",
    );
    this.name = "PiTurnFailedError";
    this.code = code;
    this.status = code === "rate_limit" ? 429 : code === "empty_response" ? 500 : 502;
    this.upstreamMessage = upstreamMessage.slice(0, 1000);
  }
}

export interface PiRunResult {
  status: "completed" | "incomplete";
  /** The committed response to continue from (`previous_response_id`). */
  responseId: string;
  text: string;
  usage?: AgentUsage;
  incompleteReason?: string;
  /** Result error subtype for an incomplete turn (`error_max_turns`, …). */
  errorSubtype?: string;
}

export interface RunPiTurnOptions extends PiEventAdapterOptions {
  client: PiResponsesClient;
  request: PiResponseRequest;
  events?: AgentEvents;
  signal?: AbortSignal;
  /** Retries of each stream OPEN (503 capacity / 429). */
  retry?: PiRetryOptions;
  /** AskUserQuestion round trips per run before giving up. */
  maxQuestionRounds?: number;
  /** After an abort, how long to wait for pi's `incomplete(user_cancelled)` before cutting the stream. */
  cancelGraceMs?: number;
}

function sumUsage(previous: AgentUsage | undefined, next: AgentUsage | undefined): AgentUsage | undefined {
  if (!previous) return next;
  if (!next) return previous;
  // Context is a snapshot (latest wins); generated tokens accumulate.
  const thinking = (previous.thinkingTokens ?? 0) + (next.thinkingTokens ?? 0);
  return {
    inputTokens: next.inputTokens || previous.inputTokens,
    outputTokens: previous.outputTokens + next.outputTokens,
    ...(thinking ? { thinkingTokens: thinking } : {}),
    ...((next.inputTokens ? next.contextWindow : previous.contextWindow)
      ? { contextWindow: next.inputTokens ? next.contextWindow : previous.contextWindow }
      : {}),
  };
}

/**
 * Drive one Noah run over pi: stream the turn, answer AskUserQuestion pauses
 * through `events.onQuestion`, and return the final text. A run without
 * `onQuestion` (nobody can answer) starts its session `interactive: false`, so
 * pi never asks there; a question anyway is a protocol error. Abort → `cancel` the live response so pi
 * KEEPS the partial turn (a dropped connection would discard it), wait briefly
 * for its `incomplete`, then cut the stream and throw `PiGatewayError("aborted")`.
 * A `requires_action` response id is never reported via `onSessionId`: if the run
 * dies while a question waits, the conversation resumes from the last committed
 * turn instead of a session stuck on an unanswered question (409).
 */
export async function runPiTurn(options: RunPiTurnOptions): Promise<PiRunResult> {
  const events = options.events ?? {};
  const adapter = new PiEventAdapter(events, options);
  const maxRounds = options.maxQuestionRounds ?? 20;
  const graceMs = options.cancelGraceMs ?? 5_000;
  const outer = options.signal;
  let request = options.request;
  let usage: AgentUsage | undefined;

  for (let round = 0; ; round++) {
    const inner = new AbortController();
    let graceTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      const id = adapter.responseId;
      if (!id) {
        inner.abort(outer?.reason);
        return;
      }
      void options.client.cancel(id, request.user).catch(() => inner.abort(outer?.reason));
      graceTimer = setTimeout(() => inner.abort(outer?.reason), graceMs);
      graceTimer.unref?.();
    };
    if (outer?.aborted) throw new PiGatewayError("aborted");
    outer?.addEventListener("abort", onAbort, { once: true });
    adapter.responseId = null;
    let outcome: PiTurnOutcome | null = null;
    try {
      for await (const event of options.client.stream(request, { signal: inner.signal, retry: options.retry })) {
        outcome = adapter.handle(event);
        if (outcome) break;
      }
    } catch (error) {
      if (outer?.aborted) throw new PiGatewayError("aborted", { cause: error });
      throw error;
    } finally {
      outer?.removeEventListener("abort", onAbort);
      if (graceTimer) clearTimeout(graceTimer);
    }
    if (!outcome) {
      if (outer?.aborted) throw new PiGatewayError("aborted");
      throw new PiGatewayError("protocol", { message: "pi-gateway 스트림이 완료 이벤트 없이 종료되었습니다." });
    }
    if (outcome.status === "failed") throw new PiTurnFailedError(outcome.error.code, outcome.error.message);
    usage = sumUsage(usage, outcome.usage);
    if (outcome.status === "requires_action") {
      if (round + 1 >= maxRounds) {
        throw new PiGatewayError("protocol", { message: "질문이 너무 많이 반복되어 실행을 중단했습니다." });
      }
      if (!events.onQuestion) {
        throw new PiGatewayError("protocol", { message: "사용자가 답할 수 없는 실행에서 질문이 와 실행을 중단했습니다." });
      }
      events.onStatus?.("사용자 답변 대기 중…");
      const answer = await events.onQuestion({
        dialogKind: "AskUserQuestion",
        payload: { questions: outcome.question.questions },
        toolUseId: outcome.question.callId,
      });
      const output = formatPiQuestionAnswer(answer);
      if (outer?.aborted) throw new PiGatewayError("aborted");
      request = {
        user: request.user,
        previousResponseId: outcome.responseId,
        input: { kind: "answer", callId: outcome.question.callId, output },
        ...(request.metadata ? { metadata: request.metadata } : {}),
        ...(request.headers ? { headers: request.headers } : {}),
      };
      continue;
    }
    if (outer?.aborted) {
      // pi committed the partial turn (user_cancelled); onSessionId already fired.
      throw new PiGatewayError("aborted");
    }
    const errorSubtype = outcome.status === "incomplete" ? incompleteErrorSubtype(outcome.reason) : undefined;
    return {
      status: outcome.status,
      responseId: outcome.responseId,
      text: adapter.answerText(true),
      ...(usage ? { usage } : {}),
      ...(outcome.status === "incomplete" && outcome.reason ? { incompleteReason: outcome.reason } : {}),
      ...(errorSubtype ? { errorSubtype } : {}),
    };
  }
}
