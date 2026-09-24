import type { AppServices } from "./app.js";
import type { AvatarTask, AvatarTaskStatus } from "../shared/avatarTasks.js";
import { getActiveRunForConversation } from "./agent/runRegistry.js";
import { BACKGROUND_TURN_PLACEHOLDER, executeChatTurn, resolveChatTarget } from "./routes/chat.js";
import { AVATAR_TASK_RESTART_ERROR } from "./store.js";
import logger from "./logger.js";

/** The `response` shape the chat turn puts on `done`/`bg_message` — read only for
 *  its text/summary, the rest rides through to the API result untouched. */
type PhaseResponse = { text?: string; summary?: string } & Record<string, unknown>;

interface DispatcherState {
  owners: Set<string>;
  stopped: boolean;
  /** 409 re-queue backoff, per task id. In memory only: a restart reaps every
   *  running row anyway, so the ladder starting over is the correct reset. */
  retry: Map<string, { at: number; attempts: number }>;
}

/** Stop re-queuing a task the thread keeps refusing. At the 60s backoff ceiling
 *  this is about an hour of trying — past that the conversation is not "briefly
 *  busy", it is held, and the caller deserves the refusal instead of a row that
 *  never settles. */
const MAX_REQUEUE_ATTEMPTS = 60;

const states = new WeakMap<AppServices, DispatcherState>();
function stateFor(services: AppServices): DispatcherState {
  let state = states.get(services);
  if (!state) {
    state = { owners: new Set(), stopped: false, retry: new Map() };
    states.set(services, state);
  }
  return state;
}

/** `attempts` = how many times THIS task has already been re-queued on a 409;
 *  it rides the closure so the dispatcher's map sweep can't lose the ladder. */
async function runTask(services: AppServices, task: AvatarTask, attempts: number): Promise<void> {
  const { store, config, observedModel } = services;
  const state = stateFor(services);
  const update = (status: AvatarTaskStatus, options: Parameters<typeof store.updateAvatarTask>[3] = {}) =>
    store.updateAvatarTask(task.ownerUserId, task.id, status, options);
  // No chat turn ran, so the thread this task auto-created is a ghost. Safe only
  // BEFORE executeChatTurn — its prelude writes the instruction bubble.
  const pruneGhostThread = () => store.deleteConversationIfEmpty(task.ownerUserId, task.conversationId);
  let requeued = false;
  try {
    // Revalidate the authorization and thread at dispatch, after any queue delay.
    const owner = store.getUserById(task.ownerUserId);
    if (!owner || !store.avatarTaskKeyActive(task.ownerUserId, task.apiKeyId)) {
      update("failed", { error: "API 키가 폐기되었거나 계정을 사용할 수 없습니다." });
      pruneGhostThread();
      return;
    }
    if (store.getConversationAvatarId(owner.id, task.conversationId) !== owner.id) {
      update("failed", { error: "대화가 삭제되었거나 자신의 아바타 대화가 아닙니다." });
      return;
    }
    const target = resolveChatTarget({ store, externalAgents: [], viewerGroupIds: new Set(),
      viewerUserId: owner.id, avatarId: owner.id, hasImages: false, ownerOnlyCommand: false });
    if (!target.ok) {
      update("failed", { error: target.refusal.message });
      pruneGhostThread();
      return;
    }
    // A server-minted thread carries no selection, so seed the run from the
    // owner's remembered composer defaults — the same values a first interactive
    // turn would send. executeChatTurn PERSISTS a non-null request onto the
    // conversation, so this fires once per thread and a per-conversation choice
    // made later always wins.
    const storedGroups = store.getConversationMcpToolGroups(owner.id, task.conversationId);
    const requested = {
      requestedModel: store.getConversationModel(owner.id, task.conversationId) === null ? owner.modelDefault : null,
      requestedEffort: store.getConversationEffort(owner.id, task.conversationId) === null ? owner.effortDefault : null,
      requestedMcpToolGroups: storedGroups === null ? owner.mcpToolGroupsDefault : null,
    };
    // Keep completion separate from HTTP acceptance: executeChatTurn also returns
    // ok after persisting an SDK failure/cancellation. Its terminal events decide.
    const terminal: { status: AvatarTaskStatus; result?: unknown; error?: string } = { status: "failed", error: "작업이 결과 없이 종료되었습니다." };
    // A turn that hands work to background tasks/subagents finalizes the VISIBLE
    // reply early: `done` carries `background: true` and usually a placeholder
    // text, each wake-up report arrives as `bg_message`, and `bg_end` closes the
    // phase (executeChatTurn resolves only then). Collect the whole phase so the
    // API's `result.text` is the real output rather than the placeholder.
    let firstResponse: PhaseResponse | undefined;
    let latestResponse: PhaseResponse | undefined;
    const phaseTexts: string[] = [];
    // The early `done` carries a PLACEHOLDER when the visible segment streamed no
    // text of its own; it must never lead (or be) the stored result.
    const pushPhaseText = (text: string | undefined) => {
      if (text && text !== BACKGROUND_TURN_PLACEHOLDER) phaseTexts.push(text);
    };
    // A cancel that lands in the claimed-but-not-opened window (status already
    // `running`, run_id still NULL, so the route has no run to cancel) writes the
    // terminal status itself; onRunOpen below is where the turn notices.
    let abandoned = false;
    const outcome = await executeChatTurn({ config, store, observedModel }, {
      ownerUserId: owner.id, ownerDisplayName: owner.displayName, target: target.target,
      conversationId: task.conversationId, agentMessage: task.message, displayMessage: task.message,
      images: [], regenerate: false, skipUserMessagePersist: task.userMessagePersisted, ...requested,
      unattendedDeadlineMs: config.avatarTaskRunTimeoutMs,
      // Unattended: nobody can switch models, so fall down the tier chain on a
      // transient model failure (same reasoning as the routine scheduler).
      modelFallback: true,
      // Provenance stamp — never capability; the run stays a full owner run.
      externalTaskId: task.id,
      audit: entry => store.audit({ actorUserId: owner.id, actorName: owner.displayName,
        action: entry.action === "chat" ? "avatar_api_task" : entry.action,
        status: entry.status ?? "success", detail: `task ${task.id}: ${entry.detail}` }),
    }, {
      onRunOpen: runId => {
        const live = store.getAvatarTask(task.ownerUserId, task.id);
        if (!live || live.status !== "running") { abandoned = true; return false; }
        update("running", { runId, userMessagePersisted: true });
        return true;
      },
      onEvent: (event, data) => {
        const payload = data as { response?: PhaseResponse; error?: string; background?: boolean;
          message?: { content?: string; response?: PhaseResponse | null } };
        if (event === "done") {
          terminal.status = "succeeded"; terminal.result = payload.response; terminal.error = undefined;
          // Provisional: the reply is on screen but the SDK is still working.
          if (payload.background === true) {
            firstResponse = payload.response;
            pushPhaseText(payload.response?.text);
          }
        } else if (event === "bg_message") {
          if (payload.message?.response) latestResponse = payload.message.response;
          pushPhaseText(payload.message?.content ?? payload.message?.response?.text);
        } else if (event === "bg_end") {
          // `text` is the whole phase; the rest (summary, usage, …) comes from the
          // LAST report, which is what actually answered the instruction.
          const base = latestResponse ?? firstResponse;
          terminal.result = { ...base, text: phaseTexts.join("\n\n") || base?.text || "" };
        } else if (event === "error" || event === "cancelled") {
          // A shutdown cancel is a RESTART, not an operator cancel: the API
          // contract promises `failed` for an interrupted run, exactly like the
          // reap in recoverAvatarTasks.
          const restarting = event === "cancelled" && state.stopped;
          terminal.status = event === "error" || restarting ? "failed" : "cancelled";
          terminal.error = restarting ? AVATAR_TASK_RESTART_ERROR : payload.error;
          terminal.result = payload.response;
        }
      },
    });
    // Abandoned: the cancel already wrote the terminal row, so touch nothing. The
    // turn persisted the instruction bubble BEFORE onRunOpen, so the conversation
    // can keep it with no reply — accepted, and the same shape an interactive stop
    // pressed before the first token leaves behind.
    if (abandoned) return;
    if (!outcome.ok) {
      // A chat may have acquired the thread/repo during asynchronous setup.
      // Preserve the prelude's already-written user bubble before retrying.
      // Past the cap the refusal becomes the task's own outcome: the thread is
      // held, not momentarily busy, and the caller must be told rather than left
      // polling a `queued` row forever.
      requeued = outcome.refusal.status === 409 && attempts < MAX_REQUEUE_ATTEMPTS;
      if (requeued) {
        // Back off exponentially, capped at a minute: a long interactive turn on
        // this thread would otherwise make the 1s tick a claim/refuse loop.
        state.retry.set(task.id, { at: Date.now() + Math.min(60_000, 5_000 * 2 ** attempts), attempts: attempts + 1 });
      }
      update(requeued ? "queued" : "failed", {
        error: requeued ? null : outcome.refusal.message,
        userMessagePersisted: task.userMessagePersisted || outcome.refusal.userMessagePersisted === true,
      });
      return;
    }
    update(terminal.status, { result: terminal.result, error: terminal.error });
  } catch (err) {
    logger.error({ err, taskId: task.id }, "avatar API task failed");
    try {
      // Do not persist raw setup errors: these may include credentials in argv.
      update("failed", { error: "작업 실행을 시작하지 못했습니다. 연결 설정과 대화를 확인해 주세요." });
    } catch (updateErr) {
      // Losing this write would strand the row at `running` until the next
      // restart reaps it, so it gets its own line rather than the outer catch.
      logger.error({ err: updateErr, taskId: task.id }, "avatar API task failure status write failed");
    }
  } finally {
    // Terminal (or abandoned): drop the ladder. A re-queue keeps the entry the
    // branch above just wrote — that IS the backoff the next tick reads.
    if (!requeued) state.retry.delete(task.id);
  }
}

/**
 * One run per API owner, at most four API runs process-wide per service.
 * `now` is a TEST SEAM: the 409 backoff is wall-clock, so a test advances the
 * clock instead of sleeping through it.
 */
export function dispatchAvatarTasks(services: AppServices, now = Date.now()): void {
  const state = stateFor(services);
  // Saturated — skip the queue query entirely; the tick comes back in a second.
  if (state.stopped || state.owners.size >= 4) return;
  const queued = services.store.queuedAvatarTasks();
  const queuedIds = new Set(queued.map(t => t.id));
  // Keep the backoff map bounded: an id that left the queue (claimed, terminal,
  // cancelled, cascaded away) no longer needs a ladder, and an in-flight task's
  // attempt count rides its runTask closure.
  for (const id of state.retry.keys()) if (!queuedIds.has(id)) state.retry.delete(id);
  for (const row of queued) {
    if (state.owners.size >= 4) break;
    const backoff = state.retry.get(row.id);
    if (backoff && backoff.at > now) continue;
    if (state.owners.has(row.ownerUserId) || getActiveRunForConversation(row.ownerUserId, row.conversationId)) continue;
    if (!services.store.claimAvatarTask(row.ownerUserId, row.id)) continue;
    // The queue query is a projection, so the message/flags arrive only now —
    // after the claim, which is also what makes the read a no-op for a task the
    // conversation cascade removed in between.
    const task = services.store.getAvatarTask(row.ownerUserId, row.id);
    if (!task) { logger.warn({ taskId: row.id }, "avatar API task vanished after claim"); continue; }
    state.owners.add(task.ownerUserId);
    void runTask(services, task, backoff?.attempts ?? 0).catch(err => {
      logger.error({ err, taskId: task.id }, "avatar API task bookkeeping failed");
    }).finally(() => { state.owners.delete(task.ownerUserId); });
  }
}

/** TEST SEAM: the live 409 backoff ladder, so a test can pre-seed an attempt
 *  count instead of sitting through an hour of refusals. Never called in
 *  production — runTask is the only writer. */
export function __avatarTaskRetryStateForTests(services: AppServices): Map<string, { at: number; attempts: number }> {
  return stateFor(services).retry;
}

export function startAvatarTaskDispatcher(services: AppServices): () => void {
  const state = stateFor(services);
  state.stopped = false;
  services.store.recoverAvatarTasks();
  const tick = () => {
    try { dispatchAvatarTasks(services); }
    catch { logger.error("avatar API task dispatcher failed"); }
  };
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();
  return () => { state.stopped = true; clearInterval(timer); };
}
