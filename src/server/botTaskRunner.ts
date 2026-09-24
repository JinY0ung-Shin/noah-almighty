import type { AppServices } from "./app.js";
import { registerBotTaskDispatcher } from "./botTaskDispatchBroker.js";
import logger from "./logger.js";
import {
  findChattablePersonalAgent,
  personalAgentAvatarId,
} from "./personalAgents.js";
import { executeChatTurn, resolveChatTarget } from "./routes/chat.js";
import { getActiveRunForConversation } from "./agent/runRegistry.js";

/**
 * Server-side dispatcher for DELEGATED bot tasks (내 봇 작업).
 *
 * A message sent to a busy bot is queued rather than refused, which makes the
 * server — not the browser — responsible for starting it once the thread frees
 * up. This module is the only place that happens: it re-resolves the bot LIVE
 * (it may have been deleted, disabled, or its owner demoted while the task sat
 * in the queue), then drives the SAME `executeChatTurn` an HTTP turn uses, with
 * no SSE client attached. The run registry journals every event, so a viewer who
 * opens the thread mid-run attaches through the existing
 * `/api/chat/runs` + `/api/chat/runs/:runId/events` endpoints and sees the turn
 * from its first frame.
 *
 * Mirrors `scheduler.ts` in structure and in its never-throw discipline: it is
 * always called fire-and-forget (from a `finally`, or at boot), so a rejection
 * escaping here would surface as an unhandled rejection with no caller to see it.
 */

const dispatchLogger = logger.child({ module: "botTaskRunner" });

/** Korean, user-facing: stored as the task's `error` and rendered on its card. */
const UNDISPATCHABLE =
  "봇이 삭제/비활성화되었거나 관리자 권한이 해제되어 대기 중이던 작업을 실행할 수 없습니다.";

/** Korean, user-facing: what a restart did to tasks that were mid-run. */
const INTERRUPTED_BY_RESTART = "서버가 재시작되어 작업이 중단되었습니다.";

/**
 * Conversations currently being dispatched. Module-level for the same reason as
 * the scheduler's `runningJobs`: the chat route's settle hook and the boot scan
 * must share ONE guard, or the same queued task starts twice. Entries are held
 * only across the synchronous re-resolve + the start of the turn's own run —
 * `executeChatTurn`'s registry entry takes over as the real lock from there.
 */
const dispatching = new Set<string>();

/**
 * Drain one bot thread's queue, oldest task first, as long as the thread stays
 * free. Never throws; a refused start simply leaves the task queued for the
 * next settle.
 *
 * The DRAIN is a loop here rather than one task per call for a specific reason:
 * `executeChatTurn` fires the settle hook from inside its own `finally`, i.e.
 * while this function is still awaiting it and still holding the `dispatching`
 * guard, so a re-entrant call would no-op and strand everything behind the first
 * queued task.
 */
export async function maybeDispatchNextBotTask(
  services: AppServices,
  ownerUserId: string,
  conversationId: string,
): Promise<void> {
  if (dispatching.has(conversationId)) {
    return;
  }
  dispatching.add(conversationId);
  const { config, store } = services;
  // Task ids this drain already handed to a turn. A bookkeeping failure could
  // leave a row `queued` after its run, and without this the same task would be
  // popped forever.
  const attempted = new Set<string>();
  try {
    for (;;) {
      // A run for this thread is still up — the settle hook fires before the
      // next turn could start, but an owner-typed turn can also race in. The
      // task keeps its place and this fires again when that run settles.
      if (getActiveRunForConversation(ownerUserId, conversationId)) {
        return;
      }
      const task = store.nextQueuedBotTask(conversationId);
      if (!task || attempted.has(task.id)) {
        return;
      }
      attempted.add(task.id);
      // Re-resolve through the SAME reach gate a typed turn uses, LIVE: the bot
      // may have been deleted or disabled, or its owner demoted, since the
      // enqueue. A task that can never run is failed with a Korean reason
      // rather than left spinning, and the queue moves on to the next one.
      const avatarId = personalAgentAvatarId(task.ownerUserId, task.agentId);
      const owner = store.getUserById(task.ownerUserId);
      const resolved = owner
        ? resolveChatTarget({
            store,
            // A bot avatar id can never resolve to an external or group agent,
            // so neither registry needs consulting.
            externalAgents: [],
            viewerGroupIds: new Set<string>(),
            viewerUserId: task.ownerUserId,
            avatarId,
            hasImages: false,
            ownerOnlyCommand: false,
          })
        : null;
      if (
        !owner ||
        !resolved?.ok ||
        !findChattablePersonalAgent(store, task.ownerUserId, avatarId)
      ) {
        store.failQueuedBotTask(task.id, UNDISPATCHABLE);
        dispatchLogger.warn(
          { taskId: task.id, agentId: task.agentId },
          "queued bot task is no longer dispatchable",
        );
        continue;
      }
      dispatchLogger.info(
        { taskId: task.id, conversationId, agentId: task.agentId },
        "dispatching queued bot task",
      );
      const outcome = await executeChatTurn(
        { config, store, observedModel: services.observedModel },
        {
          ownerUserId: task.ownerUserId,
          ownerDisplayName: owner.displayName,
          target: resolved.target,
          conversationId,
          // The owner's own words, replayed verbatim — this turn is the message
          // they already sent, just started later.
          agentMessage: task.requestText,
          displayMessage: task.requestText,
          images: [],
          regenerate: false,
          // Every composer selection is left unsent, which the turn reads as
          // "use whatever the conversation already stores".
          audit: (entry) =>
            store.audit({
              actorUserId: task.ownerUserId,
              actorName: owner.displayName,
              action: entry.action === "chat" ? "bot_task_run" : entry.action,
              status: entry.status ?? "success",
              detail: entry.detail,
            }),
          existingBotTaskId: task.id,
          // Unattended: nobody can press stop or switch models, so the run gets
          // a hard deadline and falls down the tier chain like a routine.
          unattendedDeadlineMs: config.botTaskRunTimeoutMs,
          modelFallback: true,
          // The enqueue already wrote the user's bubble.
          skipUserMessagePersist: true,
        },
        // No SSE client: the run registry journals every frame for whoever
        // attaches later.
        { onRunOpen: () => true },
      );
      if (outcome.ok) {
        // A 봇 루틴 firing that had to wait in the queue still ran in a ROUTINE
        // thread, so cap it the way the scheduler caps a direct firing —
        // otherwise a routine that keeps landing on a busy bot grows its history
        // without bound. Best-effort: bookkeeping must never break the drain.
        if (task.routineJobId) {
          try {
            store.pruneRoutineMessages(conversationId);
          } catch (err) {
            dispatchLogger.warn(
              { err, taskId: task.id, conversationId },
              "routine thread prune failed after a queued routine task",
            );
          }
        }
        continue;
      }
      if (outcome.refusal.reason === "task_gone") {
        // The owner cancelled it as it was being popped. Nothing to record —
        // the cancel already closed the row — so move to the next item.
        continue;
      }
      // A raced/refused start (another run took the thread, the working repo is
      // locked) leaves the task QUEUED — the next settle picks it up again.
      dispatchLogger.warn(
        { taskId: task.id, refusal: outcome.refusal.status },
        "queued bot task could not start yet",
      );
      return;
    }
  } catch (err) {
    dispatchLogger.error({ err, conversationId }, "bot task dispatch failed");
  } finally {
    dispatching.delete(conversationId);
  }
}

/**
 * Boot-time recovery + backlog drain. `run_id` points into an in-memory
 * registry a restart erased, so anything still marked `running` is failed
 * first; then every thread that still carries backlog gets one dispatch,
 * sequentially (a burst of restarts must not fan out into N concurrent agent
 * runs — the same burst the routine scheduler caps).
 *
 * Returns a stop function for symmetry with `startRoutineScheduler`; there is
 * no ticker to cancel, so it is a no-op.
 */
export function startBotTaskDispatcher(services: AppServices): () => void {
  const { store } = services;
  // Fill the broker's slot FIRST, before the sweep or the backlog drain can
  // await anything: from here on a 봇 간 위임 hand-off queued deep inside an
  // agent run can poke this dispatcher without importing it (that direction is
  // an import cycle — see botTaskDispatchBroker.ts).
  registerBotTaskDispatcher((ownerUserId, conversationId) => {
    void maybeDispatchNextBotTask(services, ownerUserId, conversationId);
  });
  try {
    const swept = store.sweepInterruptedBotTasks(INTERRUPTED_BY_RESTART);
    if (swept > 0) {
      dispatchLogger.warn({ swept }, "failed bot tasks interrupted by restart");
    }
  } catch (err) {
    dispatchLogger.error({ err }, "bot task restart sweep failed");
  }
  void (async () => {
    let conversationIds: string[];
    try {
      conversationIds = store.listConversationIdsWithQueuedBotTasks();
    } catch (err) {
      dispatchLogger.error({ err }, "bot task backlog scan failed");
      return;
    }
    for (const conversationId of conversationIds) {
      // The owner comes off the row itself — the boot scan has no request.
      const task = store.nextQueuedBotTask(conversationId);
      if (!task) continue;
      await maybeDispatchNextBotTask(services, task.ownerUserId, conversationId);
    }
  })();
  return () => {};
}
