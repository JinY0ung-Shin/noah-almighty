/**
 * In-memory registry of in-flight chat runs that are waiting on the user.
 *
 * The chat stream is one HTTP request (POST /api/chat/stream → SSE response),
 * but interactive tools (permission prompts, AskUserQuestion) need an answer
 * that arrives on a SEPARATE request (POST /api/chat/respond). This registry
 * bridges the two: a blocking SDK callback parks a promise here keyed by
 * (runId, requestId); the respond endpoint resolves it.
 *
 * Single-process only — matches the rest of the app (in-process SQLite). If
 * the server is ever horizontally scaled this must move to a shared store.
 */

import logger from "../logger.js";
import type { Response } from "express";
import {
  MAX_UNDELIVERED_STEERS,
  type SteerChannel,
  type SteerRecord,
} from "./steerChannel.js";

const regLogger = logger.child({ module: "runRegistry" });

/** Returned to a parked caller when the run ends before an answer arrives. */
export const CANCELLED = Symbol("cancelled");

/**
 * How long an interactive prompt waits before auto-cancelling. Without this an
 * abandoned prompt (user closed the tab mid-permission) parks the run, its SDK
 * subprocess, and the conversation lock forever. Generous — the user may simply
 * be away from the tab. Exported because the PreToolUse hook matcher's CLI-side
 * budget (`timeout` in claudeAgent.ts) must stay ABOVE this: the CLI aborts SDK
 * callback hooks after its own timeout, and this registry must always settle a
 * parked prompt (answer / TTL / run end) before the CLI gives up on the hook.
 */
export const PROMPT_TTL_MS = 30 * 60 * 1000;

interface Pending {
  resolve: (value: unknown) => void;
  /** Auto-cancel timer; cleared when the prompt is answered or the run ends. */
  timeout?: NodeJS.Timeout;
}

interface RunEvent {
  id: number;
  event: string;
  data: unknown;
}

interface Client {
  res: Response;
  heartbeat: NodeJS.Timeout;
}

interface Run {
  onEvent?: (event: string, data: unknown) => void;
  userId: string;
  conversationId?: string;
  avatarId?: string;
  abortController?: AbortController;
  pending: Map<string, Pending>;
  events: RunEvent[];
  clients: Set<Client>;
  nextEventId: number;
  ended: boolean;
  cancelled: boolean;
  /**
   * True once the visible turn was finalized (done emitted) while the SDK
   * session keeps running background work. The run stays open and attachable;
   * a new POST for the conversation still 409s, with a background-specific
   * message.
   */
  background: boolean;
  /** Live background task count (from the SDK level signal), for snapshots. */
  backgroundTasks: number;
  /**
   * Mid-turn user messages for this run, when it has one (a local streaming
   * chat turn). `pushRunSteer` writes to it and the run loop drains it; absent
   * on external-gateway runs, which have no CLI stdin to write to.
   */
  steers?: SteerChannel;
}

interface RunMeta {
  onEvent?: (event: string, data: unknown) => void;
  conversationId?: string;
  avatarId?: string;
  abortController?: AbortController;
  /** See `Run.steers`. Omitted by callers whose run cannot take mid-turn messages. */
  steers?: SteerChannel;
}

export interface RunSnapshot {
  runId: string;
  conversationId?: string;
  avatarId?: string;
  eventCount: number;
  pendingCount: number;
  cancelled: boolean;
  /** The visible turn is done but background work keeps the run alive. */
  background: boolean;
  /** Live background task count while `background` is true. */
  backgroundTasks: number;
}

const runs = new Map<string, Run>();
const conversationRuns = new Map<string, string>();

function conversationKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

export function openRun(runId: string, userId: string, meta: RunMeta = {}): void {
  runs.set(runId, {
    userId,
    onEvent: meta.onEvent,
    conversationId: meta.conversationId,
    avatarId: meta.avatarId,
    abortController: meta.abortController,
    pending: new Map(),
    events: [],
    clients: new Set(),
    nextEventId: 0,
    ended: false,
    cancelled: false,
    background: false,
    backgroundTasks: 0,
    steers: meta.steers,
  });
  if (meta.conversationId) {
    conversationRuns.set(conversationKey(userId, meta.conversationId), runId);
  }
  // Deadlines abort the controller without marking a user cancellation. They
  // must also release parked hooks, otherwise a question outlives the deadline.
  const releaseAbortedPrompts = () => {
    const run = runs.get(runId);
    if (run) resolvePending(runId, run, { notify: true });
  };
  meta.abortController?.signal.addEventListener("abort", releaseAbortedPrompts, { once: true });
  if (meta.abortController?.signal.aborted) releaseAbortedPrompts();
  regLogger.debug({ runId, userId }, "run opened");
}

function writeSse(res: Response, event: string, data: unknown, id?: number): boolean {
  if (res.writableEnded) {
    return false;
  }
  try {
    if (id !== undefined) {
      res.write(`id: ${id}\n`);
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function detachClient(run: Run, client: Client): void {
  clearInterval(client.heartbeat);
  run.clients.delete(client);
}

/**
 * Resolve every parked prompt with CANCELLED and clear the pending map: clear
 * each auto-cancel timer, optionally tell clients the prompt is resolved
 * (`notify`), then settle the parked promise. `notify` is false on a final close
 * (the SSE is ending anyway, so a prompt_resolved frame is pointless).
 */
function resolvePending(runId: string, run: Run, { notify }: { notify: boolean }): void {
  for (const [requestId, pending] of run.pending) {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (notify) {
      emitRunEvent(runId, "prompt_resolved", { requestId });
    }
    pending.resolve(CANCELLED);
  }
  run.pending.clear();
}

/**
 * Write one SSE frame to every attached client of a run.
 *
 * `replay` defaults to true: the frame is also kept in `run.events` so a client
 * that reconnects (or attaches late) is caught up from `sinceEventId`. Pass
 * `{ replay: false }` for a frame whose payload must NOT survive the moment it
 * is delivered — today that is a `browser` op carrying a stored secret's
 * plaintext (`secretText` / a field's `secretValue`), which would otherwise sit
 * in the run's in-memory replay buffer for the rest of the turn and be re-sent
 * verbatim on every reconnect. It still CONSUMES an event id, so ids stay
 * monotonic and a reconnecting client's `sinceEventId` cursor cannot be made to
 * re-request it.
 */
export function emitRunEvent(
  runId: string,
  event: string,
  data: unknown,
  options?: { replay?: boolean },
): boolean {
  const run = runs.get(runId);
  if (!run || run.ended) {
    return false;
  }
  // Internal task bookkeeping never receives non-replayable secret payloads.
  if (options?.replay !== false && run.onEvent) {
    try { run.onEvent(event, data); }
    catch { regLogger.error({ runId, event }, "run event observer failed"); }
  }
  const frame = { id: ++run.nextEventId, event, data };
  if (options?.replay !== false) {
    run.events.push(frame);
  }
  for (const client of [...run.clients]) {
    if (!writeSse(client.res, frame.event, frame.data, frame.id)) {
      detachClient(run, client);
    }
  }
  return true;
}

export function attachRunClient(
  runId: string,
  userId: string,
  res: Response,
  sinceEventId = 0,
): boolean {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return false;
  }
  for (const frame of run.events) {
    if (frame.id > sinceEventId) {
      writeSse(res, frame.event, frame.data, frame.id);
    }
  }
  const client: Client = {
    res,
    heartbeat: setInterval(() => {
      if (res.writableEnded) {
        detachClient(run, client);
        return;
      }
      try {
        res.write(`: ping\n\n`);
      } catch {
        detachClient(run, client);
      }
    }, 15_000),
  };
  run.clients.add(client);
  res.on("close", () => detachClient(run, client));
  return true;
}

export function getActiveRunForConversation(userId: string, conversationId: string): RunSnapshot | null {
  const runId = conversationRuns.get(conversationKey(userId, conversationId));
  if (!runId) {
    return null;
  }
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    conversationRuns.delete(conversationKey(userId, conversationId));
    return null;
  }
  return snapshotRun(runId, run);
}

export function getActiveRun(runId: string, userId: string): RunSnapshot | null {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return null;
  }
  return snapshotRun(runId, run);
}

function snapshotRun(runId: string, run: Run): RunSnapshot {
  return {
    runId,
    conversationId: run.conversationId,
    avatarId: run.avatarId,
    eventCount: run.events.length,
    pendingCount: run.pending.size,
    cancelled: run.cancelled,
    background: run.background,
    backgroundTasks: run.backgroundTasks,
  };
}

/**
 * Mark a run as having entered (or progressed through) its background phase:
 * the visible turn is finalized but the SDK session keeps running background
 * tasks. Called by the chat route at the first result boundary and on every
 * background-task level update.
 */
export function markRunBackground(runId: string, taskCount: number): void {
  const run = runs.get(runId);
  if (!run || run.ended) {
    return;
  }
  run.background = true;
  run.backgroundTasks = Math.max(0, taskCount);
}

export function cancelRun(runId: string, userId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return false;
  }
  run.cancelled = true;
  run.abortController?.abort();
  // Drop every mid-turn message that never reached the model, NOW: the SDK call
  // may take a moment to unwind, and the viewer's `dropped` notices have to
  // precede the `cancelled` frame the chat route emits when it does.
  run.steers?.close();
  resolvePending(runId, run, { notify: true });
  emitRunEvent(runId, "status", { label: "응답을 중지하는 중…" });
  regLogger.debug({ runId }, "run cancellation requested");
  return true;
}

/**
 * Abort EVERY active run (graceful shutdown). Aborts each SDK call so the chat
 * handler's cancel path persists its streamed partial, then resolves parked
 * prompts so the runs can finish and the SSE responses end. No user scoping —
 * shutdown is global.
 */
export function cancelAllRuns(): void {
  for (const [runId, run] of runs) {
    run.cancelled = true;
    run.abortController?.abort();
    run.steers?.close();
    resolvePending(runId, run, { notify: true });
  }
}

export function isRunCancelled(runId: string): boolean {
  return runs.get(runId)?.cancelled === true;
}

/**
 * Park until the user answers `requestId` (or the run ends → resolves with
 * CANCELLED). Safe to call even if the run was already closed (resolves
 * CANCELLED immediately).
 *
 * `ttlMs` defaults to the interactive PROMPT_TTL_MS. Pass a SHORT ttl when the
 * responder is software rather than a person (the browser bridge): a machine
 * that hasn't answered in seconds is gone, and parking such a request for half
 * an hour would pin the run, its subprocess, and the conversation lock.
 */
export function awaitResponse(
  runId: string,
  requestId: string,
  ttlMs: number = PROMPT_TTL_MS,
): Promise<unknown> {
  const run = runs.get(runId);
  if (!run || run.ended) {
    return Promise.resolve(CANCELLED);
  }
  if (run.cancelled || run.abortController?.signal.aborted) {
    // The deadline/cancel already released every parked prompt, and a prompt
    // that arrives AFTER the abort (the SDK's last hook before teardown) must
    // not park until closeRun — but its frame is already in the replay buffer,
    // so resolve it VISIBLY: without this a viewer who is attached or replays
    // the journal renders a modal no later frame dismisses.
    emitRunEvent(runId, "prompt_resolved", { requestId });
    return Promise.resolve(CANCELLED);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const current = runs.get(runId);
      const pending = current?.pending.get(requestId);
      if (!current || !pending) {
        return;
      }
      current.pending.delete(requestId);
      regLogger.warn({ runId, requestId }, "interactive prompt timed out — auto-cancelling");
      emitRunEvent(runId, "prompt_resolved", { requestId });
      pending.resolve(CANCELLED);
    }, ttlMs);
    timeout.unref?.();
    run.pending.set(requestId, { resolve, timeout });
  });
}

/**
 * Accept a MID-TURN user message ("steer") for a live run: the viewer typed
 * something while the avatar was still answering. The run's held-open prompt
 * generator picks it up and writes it to the CLI's stdin, which folds it into
 * the running turn after the next tool call (or starts it as the next turn).
 *
 * Scoped exactly like the other run endpoints — an unknown, ended, or
 * other-user run is `not_found` and says nothing more. The refusals map 1:1 to
 * the route's statuses:
 *  - `unsupported` the run has no channel at all (an external gateway avatar).
 *  - `closed`      the turn is wrapping up (or was stopped), so nothing more
 *                  can reach the model.
 *  - `too_many`    MAX_UNDELIVERED_STEERS are already waiting.
 */
export function pushRunSteer(
  runId: string,
  userId: string,
  text: string,
): { ok: true; steer: SteerRecord } | { ok: false; reason: "not_found" | "unsupported" | "closed" | "too_many" } {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return { ok: false, reason: "not_found" };
  }
  const channel = run.steers;
  if (!channel) {
    return { ok: false, reason: "unsupported" };
  }
  if (run.cancelled || channel.closed) {
    return { ok: false, reason: "closed" };
  }
  if (channel.undelivered().length >= MAX_UNDELIVERED_STEERS) {
    return { ok: false, reason: "too_many" };
  }
  const steer = channel.push(text);
  if (!steer) {
    // Closed between the check and the push (the run loop reached its result
    // boundary on another tick) — same answer as a closed channel.
    return { ok: false, reason: "closed" };
  }
  regLogger.debug({ runId, steerId: steer.id }, "mid-turn message accepted");
  return { ok: true, steer };
}

/**
 * Deliver a user's answer. Returns false if the run is unknown, owned by
 * another user, or the request id isn't outstanding.
 */
export function submitResponse(
  runId: string,
  requestId: string,
  userId: string,
  value: unknown,
): boolean {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) {
    return false;
  }
  const pending = run.pending.get(requestId);
  if (!pending) {
    return false;
  }
  run.pending.delete(requestId);
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  // Tell every (re)connected client this prompt is answered, so a reconnect that
  // replays the original permission/question event can dismiss the stale modal
  // instead of leaving it blocking (re-answering it would 404).
  emitRunEvent(runId, "prompt_resolved", { requestId });
  pending.resolve(value);
  regLogger.debug({ runId, requestId }, "response submitted");
  return true;
}

/** End a run: resolve every outstanding request with CANCELLED, then forget it. */
export function closeRun(runId: string): void {
  const run = runs.get(runId);
  if (!run) {
    return;
  }
  // BEFORE `ended`: closing drops the still-undelivered steers, and their
  // listeners report each one through emitRunEvent, which refuses an ended run.
  run.steers?.close();
  run.ended = true;
  const pendingCount = run.pending.size;
  resolvePending(runId, run, { notify: false });
  for (const client of [...run.clients]) {
    detachClient(run, client);
    if (!client.res.writableEnded) {
      client.res.end();
    }
  }
  if (run.conversationId) {
    conversationRuns.delete(conversationKey(run.userId, run.conversationId));
  }
  runs.delete(runId);
  regLogger.debug({ runId, pendingCount }, "run closed");
}

/** Only outstanding human prompts, scoped exactly like the SSE attachment. */
export function getRunPrompts(runId: string, userId: string): { event: string; data: unknown }[] {
  const run = runs.get(runId);
  if (!run || run.ended || run.userId !== userId) return [];
  return run.events.filter(frame => {
    if (!["permission", "question", "plan_review", "canvas"].includes(frame.event)) return false;
    const data = frame.data as { requestId?: string };
    return typeof data?.requestId === "string" && run.pending.has(data.requestId);
  }).map(({ event, data }) => ({ event, data }));
}
