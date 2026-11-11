/**
 * The `local` runtime (`AGENT_RUNTIME=local`): a deterministic offline stub.
 * It runs no model, no tool and no plugin, never touches the network and
 * writes no file.
 *
 * Two behaviours:
 *
 *  1. Any ordinary message is ECHOED: `[local] <message>` (what tests and the
 *     e2e harness pin — byte-for-byte unchanged).
 *  2. A scripted DEMO, so the surfaces that need a real run can be seen on a
 *     machine that cannot reach pi-gateway: `demo` lists the scenarios and
 *     `demo <name>` replays one (`localScenarios.ts`) through the run's
 *     `AgentEvents`, in the order and shapes the real runner emits them
 *     (`pi/runPiAgent.ts` + `pi/eventAdapter.ts`); a turn that is a canvas
 *     submission echoes the values it received.
 *
 * Reachability: `runAgentStream` (`agent/index.ts`) is the only caller and it
 * branches on `config.agentRuntime === "local"` — `parseRuntime` (`config.ts`)
 * accepts only `pi` (the default) and `local` — so nothing here can run on a
 * deployment that talks to pi-gateway.
 *
 * What the demo deliberately does NOT mirror: there is no pi session, so
 * `onModel`, `onSessionId` and `onResumePoint` are never called and the
 * response carries no `usage`.
 */
import path from "node:path";
import type { AgentRequest, AgentResponse } from "../types.js";
import { MAIN_AGENT_ID, type AgentEvents, type CanvasRequest } from "./events.js";
import type { SteerRecord } from "./steerChannel.js";
import { sdkToolLabel } from "../../shared/sdkToolPresentation.js";
import { PiTurnFailedError } from "./pi/eventAdapter.js";
import { PiGatewayError } from "./pi/responsesClient.js";
import {
  localDemoListing,
  localDemoUnknown,
  localSubmissionEcho,
  parseLocalCanvasSubmission,
  parseLocalDemoCommand,
  type LocalDemoCanvas,
  type LocalDemoState,
  type LocalDemoStep,
  type LocalDemoToolCall,
} from "./localScenarios.js";

const LOCAL_SUMMARY = "(로컬 런타임 응답)";
const LOCAL_STATUS = "응답 생성 중…";

/** The echo is replayed in slices of this many codepoints (no delay). */
const ECHO_CHUNK_SIZE = 40;
/** Demo answer text: codepoints per delta, and the pause between deltas. */
const DEMO_TEXT_CHUNK = 6;
const DEMO_TEXT_DELAY_MS = 20;
/** Demo reasoning text. */
const DEMO_THINKING_CHUNK = 5;
const DEMO_THINKING_DELAY_MS = 30;
/** How long a canvas / file tool row stays `running` around its event. */
const DEMO_EVENT_TOOL_MS = 350;

const CANVAS_TOOL = "mcp__canvas__show";
const SHOW_FILE_TOOL = "mcp__file_output__show_file";

export interface LocalRunnerDeps {
  /**
   * Waits between stream steps. Default: a real timer that an abort cuts short.
   * Tests inject an immediate one, so no test sleeps.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function timerSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function localResponse(text: string): AgentResponse {
  return { kind: "text", runtime: "local", summary: LOCAL_SUMMARY, text };
}

/**
 * The stub's plain response, for a caller with no events sink: the echo, or —
 * for the inputs whose answer is text alone — the demo listing and the
 * canvas-submission echo. A scenario cannot be replayed without events, so it
 * says so instead of echoing a command the listing advertises. No events, no
 * delays; `runLocalAgentStream` is the streaming entry point.
 */
export function runLocalAgent(request: AgentRequest): AgentResponse {
  const submission = parseLocalCanvasSubmission(request.message);
  if (submission) return localResponse(localSubmissionEcho(submission));
  const command = parseLocalDemoCommand(request.message);
  if (command?.kind === "list") return localResponse(localDemoListing());
  if (command?.kind === "unknown") return localResponse(localDemoUnknown(command.name));
  if (command?.kind === "scenario") {
    return localResponse(
      `\`demo ${command.scenario.name}\` 시나리오는 이벤트 스트림으로만 재생됩니다. 이 호출에는 이벤트를 받을 통로가 없어 재생하지 않았습니다.`,
    );
  }
  return localResponse(`[local] ${request.message}`);
}

function chunks(text: string, size: number): string[] {
  const codePoints = Array.from(text);
  const out: string[] = [];
  for (let index = 0; index < codePoints.length; index += size) {
    out.push(codePoints.slice(index, index + size).join(""));
  }
  return out;
}

/**
 * One scripted "pi response" of a demo run: the text-block bookkeeping of
 * `PiEventAdapter`, so the same fold / answer-text rules apply — only the LAST
 * text block is the answer; earlier blocks (narration between tool calls, the
 * text before a delivered mid-turn message) are demoted to the reasoning view
 * through `onTextFold` at the first delta of the next block.
 */
class LocalDemoTurn {
  private readonly blocks: string[] = [];
  private textOpen = false;
  private foldIndex = 0;
  /** Answer text since the last fold — the attachment anchor (`runPiAgent`'s `anchorText`). */
  private anchorLength = 0;

  constructor(
    private readonly events: AgentEvents,
    private readonly signal: AbortSignal | undefined,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {}

  private get foldEnabled(): boolean {
    return typeof this.events.onTextFold === "function";
  }

  /** Stop pressed: the real runner throws `PiGatewayError("aborted")`; the host maps it through its cancel path. */
  checkAbort(): void {
    if (this.signal?.aborted) throw new PiGatewayError("aborted");
  }

  async pause(ms: number): Promise<void> {
    this.checkAbort();
    if (ms > 0) await this.sleep(ms, this.signal);
    this.checkAbort();
  }

  /** A block boundary: a tool call, reasoning, or a delivered mid-turn message. */
  closeText(): void {
    this.textOpen = false;
  }

  private foldUpTo(end: number): void {
    if (!this.foldEnabled || end - this.foldIndex <= 0) return;
    const folded = this.blocks.slice(this.foldIndex, end).join("\n\n").trim();
    if (folded) {
      this.events.onTextFold!(folded);
      this.anchorLength = 0;
    }
    this.foldIndex = end;
  }

  private textDelta(delta: string): void {
    if (!delta) return;
    if (!this.textOpen) {
      // Fold BEFORE the new block's first delta reaches onDelta (the adapter's order).
      this.foldUpTo(this.blocks.length);
      this.blocks.push("");
      this.textOpen = true;
    }
    this.blocks[this.blocks.length - 1] += delta;
    this.anchorLength += delta.length;
    this.events.onDelta?.(delta);
  }

  async streamText(text: string, size = DEMO_TEXT_CHUNK, delayMs = DEMO_TEXT_DELAY_MS): Promise<void> {
    for (const chunk of chunks(text, size)) {
      await this.pause(delayMs);
      this.textDelta(chunk);
    }
  }

  async streamThinking(text: string): Promise<void> {
    this.closeText();
    for (const chunk of chunks(text, DEMO_THINKING_CHUNK)) {
      await this.pause(DEMO_THINKING_DELAY_MS);
      this.events.onThinking?.(chunk);
    }
  }

  toolStart(toolUseId: string, name: string, inputSummary?: string): void {
    this.closeText();
    this.events.onToolStart?.({ toolUseId, name, agentId: MAIN_AGENT_ID, ...(inputSummary ? { inputSummary } : {}) });
    const label = sdkToolLabel(name);
    this.events.onStatus?.(label ? `실행 중: ${label}` : "실행 중…");
  }

  toolEnd(toolUseId: string, ok: boolean): void {
    this.closeText();
    this.events.onToolEnd?.({ toolUseId, ok });
  }

  /** Where a card published now sits in the answer (`currentTextAnchor`). */
  anchor(): number {
    return this.anchorLength;
  }

  /** The turn's answer: the last block with a fold sink (the rest is folded), every block joined without one. */
  answerText(): string {
    if (this.foldEnabled) {
      let last = this.blocks.length - 1;
      while (last >= 0 && !this.blocks[last]!.trim()) last -= 1;
      if (last >= 0) this.foldUpTo(last);
    }
    return this.blocks
      .slice(this.foldEnabled ? this.foldIndex : 0)
      .join("\n\n")
      .trim();
  }
}

const quoteSteer = (record: SteerRecord): string => `> ${(record.displayText ?? record.text).trim().replace(/\n/g, "\n> ")}`;

/**
 * Replay a demo script. Mid-turn messages follow the real runner's two paths:
 * one queued at a step boundary is DELIVERED into the running turn (pi's
 * `response.input_consumed` — a block boundary, acknowledged in the stream);
 * one still queued when the turn ends (it arrived too late, or starts with a
 * slash, which is never handed to a running response) becomes ONE follow-up
 * turn on the same run, announced with `onTurnResult({ steerPending: true })`.
 */
async function runDemo(
  request: AgentRequest,
  steps: LocalDemoStep[],
  events: AgentEvents,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<AgentResponse> {
  const steers = events.steers;
  // Ids must not repeat inside a conversation; the turn's position in it is the deterministic part.
  const turnTag = `local-t${request.conversationHistory?.length ?? 0}`;
  const state: LocalDemoState = {
    canvasesShown: 0,
    canvasSinkMissing: false,
    filesShown: 0,
    fileErrors: [],
    fileSinkMissing: false,
  };
  let turn = new LocalDemoTurn(events, signal, sleep);

  const deliverQueuedSteers = async (): Promise<void> => {
    const delivered: SteerRecord[] = [];
    for (const record of steers?.undelivered() ?? []) {
      if (record.text.startsWith("/")) continue;
      steers!.noteLifecycle(record.id, "started");
      turn.closeText();
      delivered.push(record);
    }
    if (delivered.length === 0) return;
    await turn.streamText(
      `**실행 중에 보낸 메시지를 받았습니다.**\n\n${delivered.map(quoteSteer).join("\n\n")}\n\n하던 작업을 이어서 계속합니다.\n\n`,
    );
  };

  const runTools = async (calls: LocalDemoToolCall[]): Promise<void> => {
    for (const call of calls) turn.toolStart(`${turnTag}-${call.id}`, call.name, call.inputSummary);
    // Calls of one model step run at once: the quickest row ends first.
    let elapsed = 0;
    for (const call of [...calls].sort((left, right) => left.ms - right.ms)) {
      await turn.pause(call.ms - elapsed);
      elapsed = call.ms;
      turn.toolEnd(`${turnTag}-${call.id}`, call.ok);
    }
  };

  // The canvas tool's own emit (`canvasTools.ts`): never blocking, controls or a
  // widget `<submit>` make it "async". It goes straight to the events sink, so
  // — unlike the real tool, whose handler refuses `widget` unless the avatar
  // owner turned the experimental `canvasWidget` feature on — a demo widget
  // shows whatever that setting is.
  const showCanvas = async (canvas: LocalDemoCanvas): Promise<void> => {
    if (!events.onCanvas) {
      state.canvasSinkMissing = true;
      return;
    }
    const toolUseId = `${turnTag}-canvas-${canvas.id}`;
    turn.toolStart(toolUseId, CANVAS_TOOL, canvas.title);
    await turn.pause(DEMO_EVENT_TOOL_MS);
    const controls = canvas.controls ?? [];
    const canvasRequest: CanvasRequest = {
      // Scoped to the conversation (the id is a global key): a repeated demo refines the same canvases in place.
      artifactId: `local-demo-${request.conversationId ?? "run"}-${canvas.id}`.slice(0, 128),
      title: canvas.title,
      content: canvas.content,
      contentType: canvas.contentType,
      controls: controls.length > 0 ? controls : undefined,
      awaitInput: false,
      interaction: controls.length > 0 || canvas.submits ? "async" : undefined,
      editable: Boolean(canvas.editable),
      // A widget is drawn inline in the answer where the tool ran: runCapabilities' emit stamps the text anchor.
      ...(canvas.contentType === "widget" ? { anchor: turn.anchor() } : {}),
    };
    const result = await events.onCanvas(canvasRequest);
    turn.checkAbort();
    if (result.behavior !== "cancelled") state.canvasesShown += 1;
    turn.toolEnd(toolUseId, true);
  };

  // show_file: the host publishes an image that already exists in the run's
  // workspace; the returned card is stamped with its place in the answer.
  const showFile = async (filePath: string, caption: string | undefined, index: number): Promise<void> => {
    if (!events.onFile) {
      state.fileSinkMissing = true;
      return;
    }
    const toolUseId = `${turnTag}-file-${index}`;
    turn.toolStart(toolUseId, SHOW_FILE_TOOL, path.basename(filePath));
    await turn.pause(DEMO_EVENT_TOOL_MS);
    const result = await events.onFile({ path: filePath, ...(caption ? { caption } : {}) });
    turn.checkAbort();
    if (result.behavior === "shown") {
      result.attachment.anchor = turn.anchor();
      state.filesShown += 1;
    } else {
      state.fileErrors.push(result.message);
    }
    turn.toolEnd(toolUseId, result.behavior === "shown");
  };

  try {
    turn.checkAbort();
    events.onStatus?.(LOCAL_STATUS);
    let fileIndex = 0;
    for (const [index, step] of steps.entries()) {
      switch (step.kind) {
        case "thinking":
          await turn.streamThinking(step.text);
          break;
        case "text":
          await turn.streamText(typeof step.text === "function" ? step.text(state) : step.text, step.chunk, step.delayMs);
          break;
        case "tools":
          await runTools(step.calls);
          break;
        case "canvas":
          await showCanvas(step.canvas);
          break;
        case "file":
          await showFile(step.path, step.caption, (fileIndex += 1));
          break;
        case "wait":
          await turn.pause(step.ms);
          break;
        case "fail":
          // A pi turn that ends `response.failed`: the runner throws, the host
          // keeps the partial it already showed and appends its own notice.
          throw new PiTurnFailedError(step.code, step.upstream);
      }
      // Every step boundary is a point where pi would put a queued message into
      // the context — except the last: the response is ending, so a message
      // queued by then waits for the follow-up turn below.
      if (index < steps.length - 1) await deliverQueuedSteers();
    }

    let text = turn.answerText();
    for (;;) {
      const pending = signal?.aborted ? [] : (steers?.undelivered() ?? []);
      if (pending.length === 0) {
        steers?.close();
        break;
      }
      steers!.noteResultBoundary();
      events.onTurnResult?.({ text, steerPending: true });
      for (const record of pending) steers!.noteLifecycle(record.id, "started");
      // The follow-up turn is a new response: its text starts a new segment.
      turn = new LocalDemoTurn(events, signal, sleep);
      events.onStatus?.(LOCAL_STATUS);
      await turn.streamText(
        `앞선 답변이 끝난 뒤, 기다리던 메시지 ${pending.length}개를 이어지는 턴으로 받았습니다.\n\n${pending.map(quoteSteer).join("\n\n")}\n\n` +
          "local 스텁은 내용을 해석하지 않고 받은 사실만 알려 드립니다.\n",
      );
      text = turn.answerText();
    }
    turn.checkAbort();
    for (const record of steers?.records() ?? []) {
      if (record.state === "delivered") steers!.noteLifecycle(record.id, "completed");
    }
    events.onTurnResult?.({ text, steerPending: false });
    return localResponse(text);
  } finally {
    // Abort, failure and normal end alike: a message the run never took is dropped.
    steers?.close();
  }
}

/**
 * Streaming entry point of the `local` runtime — what `runAgentStream` runs
 * for `AGENT_RUNTIME=local`. The echo (and any call without an events sink) is
 * synchronous in effect: one status label, the text in 40-codepoint deltas, the
 * response. A demo command streams its scenario with small delays and honours
 * the run's abort signal.
 */
export async function runLocalAgentStream(
  request: AgentRequest,
  events: AgentEvents | undefined,
  abortController?: AbortController,
  deps: LocalRunnerDeps = {},
): Promise<AgentResponse> {
  const sink = events ?? {};
  const signal = abortController?.signal;
  const sleep = deps.sleep ?? timerSleep;
  const submission = parseLocalCanvasSubmission(request.message);
  const command = submission ? null : parseLocalDemoCommand(request.message);
  if (submission) {
    return runDemo(request, [{ kind: "text", text: localSubmissionEcho(submission) }], sink, signal, sleep);
  }
  if (command?.kind === "scenario") {
    return runDemo(request, command.scenario.steps(request), sink, signal, sleep);
  }
  if (command) {
    const text = command.kind === "list" ? localDemoListing() : localDemoUnknown(command.name);
    return runDemo(request, [{ kind: "text", text, chunk: 24, delayMs: 10 }], sink, signal, sleep);
  }
  // The plain echo: exactly what `runAgentStream` did before the demo existed.
  sink.onStatus?.(LOCAL_STATUS);
  const response = runLocalAgent(request);
  for (const chunk of chunks(response.text, ECHO_CHUNK_SIZE)) sink.onDelta?.(chunk);
  return response;
}
