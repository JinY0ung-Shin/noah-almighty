import fs from "node:fs";
import { loadAgentPluginRoots, loadKnowledgeRepoMemory } from "./plugins.js";
import { runAgentStream } from "./agent/index.js";
import type { AppServices } from "./app.js";
import logger from "./logger.js";
import type { PluginRoot, RoutineJob } from "./types.js";
import { workspaceDirFor } from "./workspace.js";
import { resolveActiveWorkspaceRepo } from "./activeRepoResolve.js";
import { getActiveRunForConversation } from "./agent/runRegistry.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../shared/mcpToolGroups.js";
import {
  botTaskTitle,
  findChattablePersonalAgent,
  personalAgentAvatarId,
} from "./personalAgents.js";
import { executeChatTurn, resolveChatTarget } from "./routes/chat.js";
import { maybeDispatchNextBotTask } from "./botTaskRunner.js";

const schedLogger = logger.child({ module: "scheduler" });

const DEFAULT_TICK_MS = 30_000;

/**
 * User-facing note stored on a timed-out routine.
 *
 * The SDK labels EVERY abort as "Claude Code process aborted by user" regardless of
 * cause (it just checks `signal.aborted`), so storing its message verbatim told the
 * owner a user cancelled a run that nothing but this deadline touched — routines have
 * no cancel route and are not in the run registry, so `cancelAllRuns()` can't reach
 * them either. Derived from the SAME config value that armed the deadline so the two
 * can't drift.
 */
function routineTimeoutMessage(timeoutMs: number): string {
  return `실행 제한 시간(${Math.round(timeoutMs / 60_000)}분)을 초과해 중단되었습니다. 작업을 더 작은 단계로 나누거나 예약 작업의 프롬프트를 줄여 보세요.`;
}

/**
 * Korean-lead a non-timeout routine failure. The cause is usually a raw English
 * SDK/git error, and this text is persisted BOTH as the assistant message in the
 * routine thread and as `lastError` (rendered verbatim in RoutinesView).
 */
function routineFailureMessage(error: unknown): string {
  const cause = (error instanceof Error ? error.message : String(error)).trim();
  return cause
    ? `예약 작업 실행에 실패했습니다: ${cause}`
    : "예약 작업 실행에 실패했습니다.";
}

/**
 * Jobs currently executing. Module-level on purpose: the scheduler tick and
 * the HTTP "run now" route must share ONE overlap guard, or the same job can
 * run twice concurrently.
 */
const runningJobs = new Set<string>();
/**
 * Routines in flight per owner — the per-owner cap's ledger, kept beside
 * `runningJobs` for the same reason: a "run now" occupies its owner's slot too.
 */
const runningPerOwner = new Map<string, number>();

function claimRoutineSlot(job: RoutineJob): void {
  runningJobs.add(job.id);
  runningPerOwner.set(job.avatarUserId, (runningPerOwner.get(job.avatarUserId) ?? 0) + 1);
}

function releaseRoutineSlot(job: RoutineJob): void {
  runningJobs.delete(job.id);
  const left = (runningPerOwner.get(job.avatarUserId) ?? 1) - 1;
  if (left > 0) runningPerOwner.set(job.avatarUserId, left);
  else runningPerOwner.delete(job.avatarUserId);
}

export function isRoutineRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

/**
 * One firing's outcome. `skipped` means NOTHING ran and no outcome may be
 * recorded — the job stays due and the next tick retries it (see
 * executeRoutineJob).
 */
type RoutineRunResult = { ok: boolean; error?: string; skipped?: boolean };

/** Korean, user-facing: stored as the routine's `lastError` and shown in RoutinesView. */
const BOT_UNAVAILABLE =
  "봇이 비활성화되었거나 삭제되어 예약 작업을 실행할 수 없습니다.";
const BOT_ROUTINE_STILL_QUEUED =
  "이전 예약 실행이 아직 대기열에 있어 이번 회차를 건너뜁니다.";
const ROUTINE_REPO_BUSY =
  "작업 저장소를 다른 대화에서 사용 중이라 예약 작업을 건너뜁니다.";

/**
 * 봇 루틴: fire a routine that belongs to one of the owner's personal agents.
 *
 * A bot routine is a SCHEDULED DELEGATED TASK, not a second kind of run: it goes
 * through the very machinery 봇 오피스 uses — `executeChatTurn` and the
 * `bot_tasks` queue — inside the routine's own conversation, which is bound to
 * the bot's COMPOSITE avatar id. Capability is untouched (a personal-agent turn
 * IS a full owner run); this branch only picks the identity and the thread, so
 * the owner-avatar path below never sees a bot routine.
 *
 * Never throws — same contract as `runRoutineJobNow`, whose bot branch this is.
 */
async function runBotRoutineJobNow(
  services: AppServices,
  job: RoutineJob,
  personalAgentId: string,
): Promise<RoutineRunResult> {
  const { config, store } = services;
  const avatarId = personalAgentAvatarId(job.avatarUserId, personalAgentId);
  // Resolve the bot LIVE through the ONE reach gate a typed turn uses: it may
  // have been deleted or disabled, or its owner demoted, since the routine was
  // created. Fail closed but RECOVERABLE — the schedule is left alone, so
  // re-enabling the bot resumes it at the next firing (the dispatcher's
  // undispatchable-task precedent).
  if (!findChattablePersonalAgent(store, job.avatarUserId, avatarId)) {
    return { ok: false, error: BOT_UNAVAILABLE };
  }
  const owner = store.getUserById(job.avatarUserId);
  if (!owner) {
    return { ok: false, error: "아바타를 찾을 수 없습니다." };
  }
  // This routine's PREVIOUS firing is still waiting its turn. Skip the cycle
  // rather than stacking a second identical task behind it: an unattended queue
  // that grows one item per tick is how a slow bot turns into hours of repeated
  // work nobody asked for. A skip records no outcome, so the job stays due and
  // fires the moment the backlog drains.
  if (store.hasQueuedBotTaskForRoutine(job.id)) {
    return { ok: false, skipped: true, error: BOT_ROUTINE_STILL_QUEUED };
  }
  // Carry the routine conventions onto the thread BEFORE the turn. On the row
  // createRoutineJob already minted this only bumps updated_at and (re)stamps
  // is_routine — the title never changes, so an owner-renamed thread keeps its
  // name and the composite binding stays as created.
  store.touchConversation(
    job.avatarUserId,
    job.conversationId,
    avatarId,
    `[예약 작업] ${job.name || job.prompt}`,
    { isRoutine: true },
  );
  /**
   * The thread is busy — the owner is mid-turn with this bot, or an earlier task
   * is still running. ENQUEUE rather than skip: a delegated task IS this
   * firing's output, so handing it to the queue is a SUCCESSFUL outcome and the
   * dispatcher starts it the moment the thread frees up. (No MAX_QUEUED_BOT_TASKS
   * check: the dedupe above already caps a routine at one waiting firing.)
   */
  const enqueue = (userMessagePersisted = false): RoutineRunResult => {
    if (!userMessagePersisted) {
      store.addMessage(job.conversationId, {
        role: "user",
        content: job.prompt,
      });
    }
    store.createBotTask({
      ownerUserId: job.avatarUserId,
      agentId: personalAgentId,
      conversationId: job.conversationId,
      title: botTaskTitle(job.prompt),
      requestText: job.prompt,
      status: "queued",
      routineJobId: job.id,
    });
    // Close the settle race exactly as the chat route's 202 does: the run we
    // deferred to may have finished between the check and this insert, in which
    // case its own settle hook already found an empty queue.
    void maybeDispatchNextBotTask(services, job.avatarUserId, job.conversationId);
    return { ok: true };
  };
  if (getActiveRunForConversation(job.avatarUserId, job.conversationId)) {
    return enqueue();
  }
  // The thread is free: run the turn NOW, the way the dispatcher runs a queued
  // one (same resolve call, same unattended deadline + tier fallback).
  const target = resolveChatTarget({
    store,
    // A bot avatar id can never resolve to an external or group agent.
    externalAgents: [],
    viewerGroupIds: new Set<string>(),
    viewerUserId: job.avatarUserId,
    avatarId,
    hasImages: false,
    ownerOnlyCommand: false,
  });
  if (!target.ok) {
    return { ok: false, error: target.refusal.message };
  }
  // Only a row this firing produced may decide the outcome below: the turn can
  // also RESUME a task the owner parked by hand (whose routine_job_id is NULL),
  // leaving an older firing's row as the newest one for this routine.
  const firedAt = new Date().toISOString();
  const outcome = await executeChatTurn(
    { config, store, observedModel: services.observedModel },
    {
      ownerUserId: job.avatarUserId,
      ownerDisplayName: owner.displayName,
      target: target.target,
      conversationId: job.conversationId,
      agentMessage: job.prompt,
      displayMessage: job.prompt,
      images: [],
      regenerate: false,
      audit: (entry) =>
        store.audit({
          actorUserId: job.avatarUserId,
          actorName: owner.displayName,
          action: entry.action === "chat" ? "routine_run" : entry.action,
          status: entry.status ?? "success",
          detail: `routine ${job.id}: ${entry.detail}`,
        }),
      routineJobId: job.id,
      // Unattended: nobody can press stop or switch models, so the run gets a
      // hard deadline and falls down the tier chain — the delegated-task budget,
      // not routineRunTimeoutMs, because this IS a delegated task.
      unattendedDeadlineMs: config.botTaskRunTimeoutMs,
      modelFallback: true,
    },
    // No SSE client: the run registry journals every frame for a viewer who
    // opens the thread mid-run.
    { onRunOpen: () => true },
  );
  if (!outcome.ok) {
    // The thread went busy between our check and openRun. Queue it — that race
    // is exactly what the busy branch above exists for; the user bubble may
    // already have been written by the refused turn.
    if (outcome.refusal.reason === "active_run") {
      return enqueue(outcome.refusal.userMessagePersisted === true);
    }
    // The thread's working repo is open in ANOTHER conversation. The turn
    // refused before writing any message or task row, so this is a skip like
    // the owner-avatar path's: no outcome recorded, the next tick retries. (The
    // touchConversation above still bumps the thread's updated_at each retry.)
    if (outcome.refusal.reason === "repo_locked") {
      return { ok: false, skipped: true, error: ROUTINE_REPO_BUSY };
    }
    return { ok: false, error: outcome.refusal.message };
  }
  // Cap the routine thread like the legacy path — a long-lived routine must not
  // grow its history without bound.
  store.pruneRoutineMessages(job.conversationId);
  // `ok` only means the turn RAN: executeChatTurn finalizes the task row instead
  // of throwing, so the delegated task carries the real result.
  const task = store.latestBotTaskForRoutine(job.id);
  const settledThisRun = task && (task.finishedAt ?? task.createdAt) >= firedAt;
  if (settledThisRun && task.status === "failed") {
    return { ok: false, error: task.error ?? "예약 작업 실행에 실패했습니다." };
  }
  return { ok: true };
}

/**
 * Run a single routine job headlessly and append the result to its dedicated
 * conversation. The request is marked `headless`, so questions and permission
 * prompts are still auto-denied. Owner-scheduled routines opt into owner-level
 * tool access explicitly so they can perform the same work an owner chat can.
 *
 * Never throws: every failure (including avatar/plugin/workspace setup) is
 * returned as `{ ok: false }` so async callers can't leak a rejection.
 */
async function runRoutineJobNow(
  services: AppServices,
  job: RoutineJob,
): Promise<RoutineRunResult> {
  // 봇 루틴 fires as a delegated task in the bot's own thread and shares nothing
  // below this line. Early-return keeps the owner-avatar path (personalAgentId
  // NULL — every legacy routine) exactly as it was.
  if (job.personalAgentId) {
    return runBotRoutineJobNow(services, job, job.personalAgentId);
  }
  const { config, store } = services;
  const abortController = new AbortController();
  // Hard deadline per unattended run: a hung SDK call must not wedge the job forever
  // (nothing else can reach it — routines have no cancel route).
  //
  // NOTE this is a budget for the WHOLE run, including every model-fallback attempt
  // (`modelFallback: true` retries opus→sonnet→haiku INSIDE runClaudeAgent) and the
  // resume self-heal retry — the controller is created here, outside that loop. A
  // slow first attempt therefore starves the rest of the chain.
  const timeoutMs = config.routineRunTimeoutMs;
  // Distinguishes OUR deadline from any other abort, so the catch below can replace
  // the SDK's misleading "aborted by user" with the real cause.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  // Text streamed before a failure. Routines have no live view, but persisting the
  // partial is what makes an interrupted run diagnosable at all — otherwise the only
  // trace is a one-line lastError. Mirrors the chat route's cancel/error paths.
  let streamedText = "";
  // Frees the per-clone serialization lock if this run opened a working repo.
  let releaseActiveRepoLock: (() => void) | null = null;
  try {
    const avatar = store.resolveChatAvatar(job.avatarUserId, job.avatarUserId);
    if (!avatar) {
      return { ok: false, error: "아바타를 찾을 수 없습니다." };
    }

    // Working repository: a routine may open one registered git repo as its cwd
    // via `mcp__git_repo__open_repo`. The selection persists on the conversation
    // (conversations.working_repo), so it survives between spaced-out scheduled
    // runs and restarts — and an interactive open in the routine's thread carries
    // here. Resolve it the SAME way the chat route does (shared resolver).
    // Resolved FIRST, before any plugin or knowledge loading, so a job waiting
    // on a locked repo costs one lock lookup per tick rather than a git fetch.
    const repoResolution = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias },
      conversationId: job.conversationId,
      elevated: true,
      // Routines have no composer, so every tool group is on — capped by the
      // admin per-group tool policy for the owner (claudeAgent clamps the run
      // itself the same way; this gate mirrors the chat route's repo gating).
      gitRepoToolsEnabled: (
        store.allowedMcpToolGroupsForUser(avatar.id) ?? DEFAULT_MCP_TOOL_GROUPS
      ).includes("git_repo"),
    });
    let activeRepoCwd: string | null = null;
    let activeRepoName: string | null = null;
    if (repoResolution.kind === "ok") {
      activeRepoCwd = repoResolution.cwd;
      activeRepoName = repoResolution.repoName;
      releaseActiveRepoLock = repoResolution.release;
    } else if (repoResolution.kind === "error" && repoResolution.reason === "locked") {
      // Another conversation is working in this repo's clone right now.
      // Running anyway would do the routine's work WITHOUT the repo it was set
      // up for — and record success. Skip instead: nothing has been written,
      // no outcome is recorded, and the next tick retries.
      return { ok: false, skipped: true, error: ROUTINE_REPO_BUSY };
    } else if (repoResolution.kind === "error") {
      // Any other failure (repo gone, clone failed): log and fall back to the
      // scratch workspace — the routine still runs.
      schedLogger.warn(
        { jobId: job.id, reason: repoResolution.reason, detail: repoResolution.detail },
        "routine working repo unavailable; running in scratch workspace",
      );
    }

    // Mirror the chat endpoint's plugin loading via the shared helper (default +
    // avatar plugins + personal & group knowledge-repo skill roots) so routines
    // can USE the same skills an owner chat would; tolerate clone/resolve fails
    // but leave a trace — there is no client to stream the warnings to.
    const pluginWarnings: string[] = [];
    const pluginRoots: PluginRoot[] = await loadAgentPluginRoots(store, avatar.id, config, (w) =>
      pluginWarnings.push(w),
    );
    if (pluginWarnings.length > 0) {
      schedLogger.warn({ jobId: job.id, warnings: pluginWarnings }, "routine plugin warnings");
    }

    // Standing CLAUDE.md memory, same as an owner chat. Routines have no
    // per-conversation toggle UI, so every group is included (no disabled set).
    const knowledgeMemory = await loadKnowledgeRepoMemory(store, avatar.id, config);

    const workspaceDir = workspaceDirFor(config, avatar.id, job.conversationId);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const response = await runAgentStream(
      {
        message: job.prompt,
        avatar: { id: avatar.id, displayName: avatar.displayName, alias: avatar.alias, persona: avatar.persona },
        // Lets in-process tools (open_repo/close_repo) key the working-repo
        // selection to this routine's conversation, persisted for the next run.
        conversationId: job.conversationId,
        // Working repository: the opened repo's clone becomes the cwd; the scratch
        // dir stays exposed as an additional writable dir (mirrors the chat route).
        cwd: activeRepoCwd ?? workspaceDir,
        additionalDirs: activeRepoCwd ? [workspaceDir] : undefined,
        activeRepoName: activeRepoName ?? undefined,
        viewerUserId: avatar.id,
        viewerName: avatar.displayName,
        viewerIsOwner: true,
        elevated: true,
        headless: true,
        allowHeadlessTools: true,
        autoApprove: true,
        // Routines run unattended on a schedule: if the chosen model is
        // overloaded/erroring server-side, fall back down the tier chain
        // (opus→sonnet→haiku) rather than failing the whole run.
        modelFallback: true,
        knowledgeMemory,
      },
      pluginRoots,
      config,
      store,
      // Headless runs cannot ask questions or wait for approvals, so there is no
      // onQuestion/onPermission here. onDelta is purely an accumulator: it keeps the
      // partial answer so a timed-out/failed run can still persist what it produced
      // (the success path uses `response.text`, which never arrives on abort).
      {
        onDelta: (text) => {
          streamedText += text;
        },
      },
      abortController,
    );

    store.touchConversation(avatar.id, job.conversationId, avatar.id, `[예약 작업] ${job.prompt}`, { isRoutine: true });
    store.addMessage(job.conversationId, { role: "user", content: job.prompt });
    store.addMessage(job.conversationId, {
      role: "assistant",
      content: response.text || response.summary,
      response,
    });
    // Cap the routine thread so long-lived routines don't grow their history without bound.
    store.pruneRoutineMessages(job.conversationId);
    store.audit({
      actorUserId: avatar.id,
      actorName: avatar.displayName,
      action: "routine_run",
      status: "success",
      detail: `routine ${job.id} (${response.runtime})`,
    });
    return { ok: true };
  } catch (error) {
    // Our deadline wins the message: the SDK's abort text names a "user" that was
    // never involved in an unattended run.
    const detail = timedOut
      ? routineTimeoutMessage(timeoutMs)
      : routineFailureMessage(error);
    // Keep whatever the run produced before dying, alongside the cause — otherwise an
    // interrupted routine leaves NOTHING in its thread (this path never wrote a
    // message at all) and the owner can't tell how far it got. Best-effort: a failure
    // here must not mask the original error.
    try {
      const content = streamedText ? `${streamedText}\n\n${detail}` : detail;
      store.touchConversation(
        job.avatarUserId,
        job.conversationId,
        job.avatarUserId,
        `[예약 작업] ${job.prompt}`,
        { isRoutine: true },
      );
      store.addMessage(job.conversationId, { role: "user", content: job.prompt });
      store.addMessage(job.conversationId, { role: "assistant", content });
      store.pruneRoutineMessages(job.conversationId);
    } catch (persistError) {
      schedLogger.error(
        { jobId: job.id, err: persistError },
        "routine failed to persist partial output",
      );
    }
    try {
      store.audit({
        actorUserId: job.avatarUserId,
        actorName: null,
        action: "routine_run",
        status: "error",
        detail: `routine ${job.id}: ${detail}`,
      });
    } catch {
      /* audit must never mask the original failure */
    }
    return { ok: false, error: detail };
  } finally {
    releaseActiveRepoLock?.();
    clearTimeout(deadline);
  }
}

/**
 * The single entry point for firing a routine (used by both the scheduler tick
 * and the "run now" route): takes the shared overlap guard, runs the job, and
 * records the outcome. Never throws.
 */
export async function executeRoutineJob(
  services: AppServices,
  job: RoutineJob,
): Promise<RoutineRunResult> {
  if (runningJobs.has(job.id)) {
    return { ok: false, skipped: true, error: "이미 실행 중인 예약 작업입니다." };
  }
  // A routine and an interactive chat share ONE conversation id (a routine's thread
  // is openable in the client). If the owner is mid-turn there, skip this tick: both
  // runs would point the SDK cwd at the SAME working-repo clone / scratch dir and
  // stomp each other (activeRepoLock is re-entrant by conversation id, so it won't
  // catch this). It retries on the next tick once the chat turn is done.
  //
  // A 봇 루틴 is exempt: its firing is a delegated task, so a busy thread makes it
  // QUEUE behind the running turn (runBotRoutineJobNow) instead of losing the slot.
  if (
    !job.personalAgentId &&
    getActiveRunForConversation(job.avatarUserId, job.conversationId)
  ) {
    return { ok: false, skipped: true, error: "대화에서 응답을 생성 중이라 예약 작업을 건너뜁니다." };
  }
  // Synchronous, before the first await: the scheduler tick starts jobs without
  // awaiting them and reads these counts on its very next iteration.
  claimRoutineSlot(job);
  schedLogger.info({ jobId: job.id, avatarUserId: job.avatarUserId }, "routine job started");
  const jobStart = Date.now();
  try {
    const result = await runRoutineJobNow(services, job);
    if (result.skipped) {
      // Same contract as the two skips above: a firing that never ran records NO
      // outcome, so next_run_at stays put and the next tick retries it.
      schedLogger.info({ jobId: job.id, reason: result.error }, "routine job skipped");
      return result;
    }
    services.store.markRoutineRun(job.id, {
      status: result.ok ? "success" : "error",
      error: result.error ?? null,
    });
    if (result.ok) {
      schedLogger.info({ jobId: job.id, durationMs: Date.now() - jobStart }, "routine job completed");
    } else {
      schedLogger.error({ jobId: job.id, error: result.error, durationMs: Date.now() - jobStart }, "routine job failed");
    }
    return result;
  } catch (error) {
    // runRoutineJobNow handles its own errors; reaching here means RECORDING
    // the outcome failed (e.g. DB write error). Log it — never let it escape,
    // and don't retry the write that just failed.
    const detail = error instanceof Error ? error.message : String(error);
    schedLogger.error({ jobId: job.id, err: error }, "routine failed to record outcome");
    return { ok: false, error: detail };
  } finally {
    releaseRoutineSlot(job);
  }
}

/**
 * Start the routine-job ticker. Every `tickMs` it STARTS due jobs without
 * waiting for them, as long as fewer than `routineMaxConcurrentRuns` routines
 * are in flight server-wide and fewer than `routineMaxConcurrentRunsPerUser`
 * for that job's owner. A job over a cap (or already running) simply stays due
 * and a later tick picks it up once a slot frees. Returns a stop function.
 *
 * Capped rather than unbounded because each run is a full agent process: a
 * burst of due jobs (many routines on the same minute, or a restart after
 * downtime past many slots) must not fan out into one process per job. It used
 * to be strictly sequential for that reason, which let ONE long run — a bot
 * routine holds its slot for the whole delegated turn — delay every routine on
 * the server. The per-owner cap keeps one owner with many due routines from
 * taking every slot. Runs missed while the server was down fire once on the
 * next tick, then roll forward; there is no per-missed-day catch-up.
 */
export function startRoutineScheduler(
  services: AppServices,
  options: { tickMs?: number } = {},
): () => void {
  const { config, store } = services;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;

  const tick = (): void => {
    let due: RoutineJob[];
    try {
      due = store.listDueRoutineJobs(new Date().toISOString());
    } catch (error) {
      schedLogger.error({ err: error }, "scheduler tick: failed to list due jobs");
      return;
    }
    for (const job of due) {
      if (runningJobs.size >= config.routineMaxConcurrentRuns) break;
      // Already firing from an earlier tick or "지금 실행"; that run records
      // the outcome.
      if (runningJobs.has(job.id)) continue;
      if ((runningPerOwner.get(job.avatarUserId) ?? 0) >= config.routineMaxConcurrentRunsPerUser) {
        continue;
      }
      // Never throws, and claims its slot before its first await, so the caps
      // above already count it on the next iteration.
      void executeRoutineJob(services, job);
    }
  };

  const timer = setInterval(tick, tickMs);
  // Don't keep the process alive solely for the scheduler.
  timer.unref?.();
  return () => clearInterval(timer);
}
