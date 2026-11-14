/**
 * `mcp__system__turn_timings`' report: where the time went in the FINISHED
 * turns of this conversation's pi session, written from pi's own per-turn
 * traces (`PiResponsesClient.traces`) — so the avatar answers "why was that
 * slow?" from measurements instead of guessing.
 *
 * A trace holds names, durations, token counts and error flags only (pi
 * records no prompt, tool argument or result), and this module adds nothing:
 * the report is arithmetic over those spans. Agent-facing text → English.
 *
 * The split follows pi's own 실행 시간 page (`admin/traces.ts`): the model
 * calls and tool executions DIRECTLY under the turn are "model" and "tools"
 * (overlapping spans counted once), the rest of the turn is "other". What a
 * subagent did sits under the tool call that started it.
 */

import type { PiTraceSpan, PiTurnTrace } from "./pi/responsesClient.js";

export const TURN_TIMINGS_DEFAULT_TURNS = 5;
export const TURN_TIMINGS_MAX_TURNS = 20;
/** Slowest steps listed per turn. */
const SLOWEST_STEPS = 5;
/** Largest steps named inside one slow tool call (sandbox / MCP broker work, a subagent's own calls). */
const INSIDE_STEPS = 2;
/** A span below this is never worth a line of its own. */
const NOTABLE_MS = 500;
const NAME_LIMIT = 120;

/** A span name or attribute is pi's (tool names come from MCP servers): one line, bounded. */
const label = (value: unknown): string =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT);

export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const percent = (part: number, whole: number): string => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%");
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Time the spans cover — tools that ran side by side are counted once. */
function covered(spans: PiTraceSpan[]): number {
  let total = 0;
  let end = 0;
  for (const span of [...spans].sort((a, b) => a.startMs - b.startMs)) {
    const stop = span.startMs + span.durationMs;
    if (stop > end) total += stop - Math.max(span.startMs, end);
    end = Math.max(end, stop);
  }
  return total;
}

const isChat = (span: PiTraceSpan): boolean => span.name.startsWith("chat ");
const isTool = (span: PiTraceSpan): boolean => span.name.startsWith("execute_tool ");

/** `execute_tool mcp_call` names the MCP tool it really called (`pi_gateway.mcp_tool`). */
function stepName(span: PiTraceSpan): string {
  const mcpTool = span.attributes["pi_gateway.mcp_tool"];
  const mcpServer = span.attributes["pi_gateway.mcp_server"];
  const name = label(span.name);
  if (typeof mcpTool === "string" && mcpTool) return `${name} → ${label(mcpTool)}`;
  if (typeof mcpServer === "string" && mcpServer) return `${name} (${label(mcpServer)})`;
  return span.service && span.service !== "gateway" && !name.startsWith(span.service) ? `${label(span.service)} ${name}` : name;
}

function chatDetail(span: PiTraceSpan): string {
  const parts: string[] = [];
  const firstToken = num(span.attributes["pi_gateway.first_token_ms"]);
  const input = num(span.attributes["gen_ai.usage.input_tokens"]);
  const cached = num(span.attributes["gen_ai.usage.cache_read.input_tokens"]);
  const output = num(span.attributes["gen_ai.usage.output_tokens"]);
  if (firstToken !== undefined) parts.push(`first token after ${formatDuration(firstToken)}`);
  if (input !== undefined) {
    parts.push(`${input.toLocaleString("en-US")} input tokens${cached !== undefined ? ` (${cached.toLocaleString("en-US")} read from cache)` : ""}`);
  }
  if (output !== undefined) {
    // Over the whole call, like pi's page: hidden reasoning is produced before the first visible token.
    const rate = span.durationMs > 0 && output > 0 ? `, ${Math.round(output / (span.durationMs / 1000))} tokens/s over the call` : "";
    parts.push(`${output.toLocaleString("en-US")} output tokens${rate}`);
  }
  return parts.join("; ");
}

function descendantsOf(span: PiTraceSpan, childrenOf: Map<string, PiTraceSpan[]>): PiTraceSpan[] {
  const out: PiTraceSpan[] = [];
  const seen = new Set<string>([span.id]);
  const queue = [...(childrenOf.get(span.id) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
    queue.push(...(childrenOf.get(next.id) ?? []));
  }
  return out;
}

function turnLines(trace: PiTurnTrace): string[] {
  const root = trace.spans.find((span) => !span.parentId);
  const heading = `Turn${trace.turn !== undefined ? ` ${trace.turn}` : ""} — started ${label(trace.startedAt)}`;
  if (!root) return [`${heading}, took ${formatDuration(trace.durationMs)} (no detail recorded)`];

  const childrenOf = new Map<string, PiTraceSpan[]>();
  for (const span of trace.spans) {
    if (!span.parentId) continue;
    const list = childrenOf.get(span.parentId);
    if (list) list.push(span);
    else childrenOf.set(span.parentId, [span]);
  }
  const top = childrenOf.get(root.id) ?? [];
  const chats = top.filter(isChat);
  const tools = top.filter(isTool);
  const total = root.durationMs;
  const modelMs = covered(chats);
  const toolMs = covered(tools);
  const otherMs = Math.max(total - modelMs - toolMs, 0);
  const status = root.attributes["pi_gateway.status"];
  const model = root.attributes["gen_ai.request.model"];

  const lines = [
    `${heading}, took ${formatDuration(total)}${typeof status === "string" && status ? `, ended ${label(status)}` : ""}${root.error ? " (failed)" : ""}${typeof model === "string" && model ? `, model ${label(model)}` : ""}`,
    `  model: ${formatDuration(modelMs)} (${percent(modelMs, total)}) in ${count(chats.length, "call")}; tools: ${formatDuration(toolMs)} (${percent(toolMs, total)}) in ${count(tools.length, "call")}; other: ${formatDuration(otherMs)} (${percent(otherMs, total)})`,
  ];

  const firstChat = chats[0];
  const firstToken = firstChat ? num(firstChat.attributes["pi_gateway.first_token_ms"]) : undefined;
  if (firstChat && firstToken !== undefined) {
    lines.push(`  first token of the answer: ${formatDuration(firstChat.startMs - root.startMs + firstToken)} after the turn started`);
  }

  const slowest = [...chats, ...tools].sort((a, b) => b.durationMs - a.durationMs).slice(0, SLOWEST_STEPS);
  if (slowest.length) lines.push("  slowest steps:");
  slowest.forEach((span, index) => {
    const detail = isChat(span) ? chatDetail(span) : "";
    lines.push(`    ${index + 1}. ${stepName(span)} — ${formatDuration(span.durationMs)}${span.error ? " (error)" : ""}${detail ? ` — ${detail}` : ""}`);
    if (!isTool(span)) return;
    const inside = descendantsOf(span, childrenOf)
      .filter((child) => child.durationMs >= NOTABLE_MS)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, INSIDE_STEPS);
    if (inside.length) {
      lines.push(`       inside it: ${inside.map((child) => `${stepName(child)} ${formatDuration(child.durationMs)}${child.error ? " (error)" : ""}`).join("; ")}`);
    }
  });

  // Starting a sandbox container or connecting an MCP server is a one-off cost worth naming wherever it sits.
  const oneOff = trace.spans.filter(
    (span) => span.durationMs >= NOTABLE_MS && (span.name === "sandbox create" || span.name === "mcp-broker connect upstream"),
  );
  if (oneOff.length) {
    lines.push(`  one-off setup in this turn: ${oneOff.map((span) => `${stepName(span)} ${formatDuration(span.durationMs)}`).join("; ")}`);
  }
  return lines;
}

/**
 * The report for the `turns` most recent finished turns (`traces` is most
 * recent first, as pi answers it). Empty `traces` → the caller's own "nothing
 * finished yet" text; this function is only asked with at least one.
 */
export function summarizeTurnTimings(traces: PiTurnTrace[], turns: number = TURN_TIMINGS_DEFAULT_TURNS): string {
  const limit = Math.min(Math.max(1, Math.trunc(turns) || TURN_TIMINGS_DEFAULT_TURNS), TURN_TIMINGS_MAX_TURNS);
  const shown = traces.slice(0, limit);
  const slowestTurn = shown.reduce<PiTurnTrace | undefined>((best, trace) => (!best || trace.durationMs > best.durationMs ? trace : best), undefined);
  const header = [
    `Turn timings of this conversation's session — measured by the runtime, most recent turn first (${shown.length} of ${traces.length} recorded turn${traces.length === 1 ? "" : "s"} shown).`,
    "Only FINISHED turns are recorded: the turn you are in now is not listed. A turn here is one model run of the runtime (a question you asked the user and their answer are two turns). Times are wall-clock; names, durations and token counts are all the runtime records — no prompt, argument or result — so say what was slow, and treat WHY as your inference.",
    ...(shown.length > 1 && slowestTurn
      ? [`Slowest of these: turn${slowestTurn.turn !== undefined ? ` ${slowestTurn.turn}` : ""} started ${label(slowestTurn.startedAt)} (${formatDuration(slowestTurn.durationMs)}).`]
      : []),
  ];
  return [header.join("\n"), ...shown.map((trace) => turnLines(trace).join("\n"))].join("\n\n");
}
