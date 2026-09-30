import crypto from "node:crypto";
import type { BotTask, BotTaskStatus } from "../types.js";
import {
  type BotTaskRow,
  type Constructor,
  type StoreBase,
  now,
} from "./internal.js";

/** Newest-first owner/board listing default. */
const DEFAULT_TASK_LIMIT = 100;
/** Oldest-first thread listing default (a bot thread holds more cards than a board page). */
const DEFAULT_CONVERSATION_TASK_LIMIT = 200;

/**
 * The parked state an owner ANSWER resumed a task from — one entry per
 * waiting_input → running move, oldest first, in `bot_tasks.resume_log`. A
 * rewind that discards the answering turn restores the task from it
 * (rewindBotTasks). `at` is the store clock at the resume.
 */
interface BotTaskResumeSnapshot {
  at: string;
  pendingQuestion: string | null;
  reportedOutcome: string | null;
  resultSummary: string | null;
  error: string | null;
  model: string | null;
  seenAt: string | null;
}

/** A task answered more often than this keeps only its newest resumes. */
const MAX_RESUME_SNAPSHOTS = 100;

/** Parse-tolerant read of `resume_log` (a bad value reads as no history). */
function parseResumeLog(raw: string | null): BotTaskResumeSnapshot[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is BotTaskResumeSnapshot =>
            Boolean(entry) && typeof entry === "object" && typeof (entry as { at?: unknown }).at === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * UNSEEN = a task that SETTLED into a state the owner has not looked at yet.
 * The single source of the badge predicate, shared by the count and the stamp
 * so the two can never disagree. 'queued'/'running' rows are deliberately NOT
 * unseen — their motion is its own signal, and badging work still in flight
 * would leave a count nobody can clear — and 'cancelled' never is either: the
 * owner is the one who cancelled it, so they have seen it by construction.
 */
const UNSEEN_WHERE =
  "status IN ('done', 'failed', 'waiting_input') AND seen_at IS NULL";

export function withBotTasks<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class BotTasks extends Base {
    // ---- Delegated bot tasks (내 봇 작업) ------------------------------------
    // One row per executed user turn in a personal-agent thread. BOOKKEEPING
    // ONLY — a row never widens or narrows a run's capability. The status
    // machine is enforced HERE (every transition is a guarded UPDATE returning
    // null on an illegal move, never a throw) so the chat route, the queue
    // dispatcher and the task API decode ONE rule:
    //
    //   queued ──► running ──► done | failed | cancelled   (terminal)
    //                  └────► waiting_input ──► running    (owner answers)
    //   queued | waiting_input ──► cancelled               (owner gives up)
    //   queued ──► failed                                  (undispatchable bot)
    //
    // seen_at rides that same machine (UNSEEN_WHERE is the badge predicate):
    // every finalize CLEARS it, because settling is a fresh result the owner
    // has not read — a task parked on a question, answered, then finished
    // badges a SECOND time — and a dispatch clears it too so a running row
    // never carries a stale stamp. The one transition the owner performs
    // themselves (their own cancel) stamps it instead, alongside the explicit
    // markBotTasksSeen the board sends when they look.
    //
    // Cascades are manual and live at the deletion sites: deletePersonalAgent
    // (store/personalAgents.ts), deleteUser (store/admin.ts), and the
    // conversation deletes (store/conversations.ts).

    private botTaskRow(taskId: string): BotTaskRow | undefined {
      return this.db
        .prepare("SELECT * FROM bot_tasks WHERE id = ?")
        .get(taskId) as BotTaskRow | undefined;
    }

    private toBotTask(row: BotTaskRow): BotTask {
      return {
        id: row.id,
        ownerUserId: row.owner_user_id,
        agentId: row.agent_id,
        conversationId: row.conversation_id,
        runId: row.run_id ?? null,
        title: row.title,
        requestText: row.request_text,
        // This mixin is the only writer of both enum columns, so the stored
        // values are always in-contract; the casts carry no normalization.
        status: row.status as BotTaskStatus,
        reportedOutcome: (row.reported_outcome ?? null) as
          | "done"
          | "need_input"
          | null,
        resultSummary: row.result_summary ?? null,
        pendingQuestion: row.pending_question ?? null,
        error: row.error ?? null,
        model: row.model ?? null,
        createdAt: row.created_at,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
        seenAt: row.seen_at ?? null,
        routineJobId: row.routine_job_id ?? null,
        delegatedByAgentId: row.delegated_by_agent_id ?? null,
        delegationDepth: row.delegation_depth ?? 0,
      };
    }

    /** Re-read after a guarded UPDATE; null when the guard matched nothing. */
    private botTaskIfChanged(taskId: string, changes: number): BotTask | null {
      if (changes === 0) {
        return null;
      }
      const row = this.botTaskRow(taskId);
      return row ? this.toBotTask(row) : null;
    }

    /**
     * Record a delegated turn. `running` is the ATTENDED path (the chat route
     * starts the run immediately, so started_at + run_id are stamped up front);
     * `queued` is the unattended path, where the dispatcher later calls
     * markBotTaskRunning once the conversation's active run frees up.
     */
    createBotTask(input: {
      ownerUserId: string;
      agentId: string;
      conversationId: string;
      title: string;
      requestText: string;
      status: "queued" | "running";
      runId?: string | null;
      /**
       * 봇 루틴 provenance: the routine_jobs.id whose firing produced this task,
       * or null when the owner typed it. Bookkeeping only — it never changes how
       * the task runs; it labels the card and is the scheduler's dedupe key.
       */
      routineJobId?: string | null;
      /**
       * 봇 간 위임 provenance: the bot whose turn handed this off (null for an
       * owner-typed task AND for a main-avatar hand-off — the depth says which).
       */
      delegatedByAgentId?: string | null;
      /** Hop counter for the delegation cap; 0 unless a hand-off created this. */
      delegationDepth?: number;
    }): BotTask {
      const timestamp = now();
      const id = crypto.randomUUID();
      const running = input.status === "running";
      this.db
        .prepare(
          `INSERT INTO bot_tasks (id, owner_user_id, agent_id, conversation_id, run_id, title, request_text, status, created_at, started_at, routine_job_id, delegated_by_agent_id, delegation_depth)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.ownerUserId,
          input.agentId,
          input.conversationId,
          running ? (input.runId ?? null) : null,
          input.title,
          input.requestText,
          input.status,
          timestamp,
          running ? timestamp : null,
          input.routineJobId ?? null,
          input.delegatedByAgentId ?? null,
          input.delegationDepth ?? 0,
        );
      return this.toBotTask(this.botTaskRow(id)!);
    }

    getBotTask(taskId: string): BotTask | null {
      const row = this.botTaskRow(taskId);
      return row ? this.toBotTask(row) : null;
    }

    /**
     * One owner's tasks, NEWEST first (the 작업 보드 order), optionally narrowed
     * to a single bot. created_at is an ISO string that can collide inside one
     * millisecond, so rowid breaks ties into stable insertion order.
     */
    listBotTasks(
      ownerUserId: string,
      opts: { agentId?: string; limit?: number } = {},
    ): BotTask[] {
      const limit =
        opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_TASK_LIMIT;
      const params: unknown[] = [ownerUserId];
      let where = "owner_user_id = ?";
      if (opts.agentId) {
        where += " AND agent_id = ?";
        params.push(opts.agentId);
      }
      const rows = this.db
        .prepare(
          `SELECT * FROM bot_tasks WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params, limit) as BotTaskRow[];
      return rows.map((row) => this.toBotTask(row));
    }

    /**
     * Badge counts for the owner's board: settled tasks they have not looked at
     * yet, split per bot so the rail can dot the individual lane AND show one
     * total. ONE grouped query — total is the sum of the groups, so the two
     * numbers can never disagree the way two separate COUNTs could. A bot with
     * nothing unseen is absent from `agents` rather than present as 0, which is
     * what lets the client replace its whole badge state from one response.
     */
    countUnseenBotTasks(ownerUserId: string): {
      total: number;
      agents: Record<string, number>;
    } {
      const rows = this.db
        .prepare(
          `SELECT agent_id, COUNT(*) AS c FROM bot_tasks
           WHERE owner_user_id = ? AND ${UNSEEN_WHERE}
           GROUP BY agent_id`,
        )
        .all(ownerUserId) as { agent_id: string; c: number }[];
      return {
        total: rows.reduce((sum, row) => sum + row.c, 0),
        agents: Object.fromEntries(rows.map((row) => [row.agent_id, row.c])),
      };
    }

    /**
     * The owner looked: stamp every one of their currently-unseen tasks, or
     * just one bot's lane when `agentId` narrows it. Returns how many rows the
     * stamp actually moved, so an idempotent second call reports 0. Only rows
     * matching UNSEEN_WHERE are touched — an already-stamped row keeps its
     * ORIGINAL timestamp (this is "when it was first read", not "when the board
     * was last open"), and a queued/running row is left alone to be cleared by
     * its own next finalize.
     */
    markBotTasksSeen(
      ownerUserId: string,
      opts: { agentId?: string } = {},
    ): number {
      const params: unknown[] = [now(), ownerUserId];
      let where = `owner_user_id = ? AND ${UNSEEN_WHERE}`;
      if (opts.agentId) {
        where += " AND agent_id = ?";
        params.push(opts.agentId);
      }
      const { changes } = this.db
        .prepare(`UPDATE bot_tasks SET seen_at = ? WHERE ${where}`)
        .run(...params);
      return changes;
    }

    /** One thread's tasks, OLDEST first — the cards render in transcript order. */
    listBotTasksForConversation(
      conversationId: string,
      opts: { limit?: number } = {},
    ): BotTask[] {
      const limit =
        opts.limit && opts.limit > 0
          ? opts.limit
          : DEFAULT_CONVERSATION_TASK_LIMIT;
      const rows = this.db
        .prepare(
          "SELECT * FROM bot_tasks WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
        )
        .all(conversationId, limit) as BotTaskRow[];
      return rows.map((row) => this.toBotTask(row));
    }

    /** Backlog depth for the thread's queue badge — 'queued' only, never 'running'. */
    countQueuedBotTasks(conversationId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM bot_tasks WHERE conversation_id = ? AND status = 'queued'",
        conversationId,
      );
    }

    /**
     * Does one 봇 루틴 still have a firing waiting in a queue? The scheduler's
     * dedupe: a routine whose previous firing never got its turn must not stack
     * a second identical task behind it — it skips this cycle instead and stays
     * due. 'queued' ONLY: a task already RUNNING is this thread's current work,
     * which the busy branch queues behind rather than skipping.
     */
    hasQueuedBotTaskForRoutine(routineJobId: string): boolean {
      return (
        this.count(
          "SELECT COUNT(*) AS c FROM bot_tasks WHERE routine_job_id = ? AND status = 'queued'",
          routineJobId,
        ) > 0
      );
    }

    /**
     * The newest task one routine produced — how a scheduler firing reads its own
     * outcome back (executeChatTurn finalizes the ROW rather than throwing, so
     * "the turn ran" and "the work succeeded" are different questions). Newest
     * first with the rowid tiebreak, like every other ordering here; the caller
     * checks the row's timestamps to be sure it belongs to the firing it just ran.
     */
    latestBotTaskForRoutine(routineJobId: string): BotTask | null {
      const row = this.db
        .prepare(
          "SELECT * FROM bot_tasks WHERE routine_job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
        )
        .get(routineJobId) as BotTaskRow | undefined;
      return row ? this.toBotTask(row) : null;
    }

    /** The task the dispatcher runs next in this thread (FIFO), or null when drained. */
    nextQueuedBotTask(conversationId: string): BotTask | null {
      const row = this.db
        .prepare(
          "SELECT * FROM bot_tasks WHERE conversation_id = ? AND status = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1",
        )
        .get(conversationId) as BotTaskRow | undefined;
      return row ? this.toBotTask(row) : null;
    }

    /**
     * Every thread carrying backlog, the thread with the OLDEST queued task
     * first — the boot-time dispatch scan, which walks this list and pops each
     * thread's queue in turn. Ordered by each conversation's own oldest queued
     * created_at (not by row count), so the longest-waiting owner is served
     * first; MIN(rowid) breaks same-millisecond ties into insertion order.
     */
    listConversationIdsWithQueuedBotTasks(): string[] {
      const rows = this.db
        .prepare(
          `SELECT conversation_id FROM bot_tasks WHERE status = 'queued'
           GROUP BY conversation_id
           ORDER BY MIN(created_at) ASC, MIN(rowid) ASC`,
        )
        .all() as { conversation_id: string }[];
      return rows.map((row) => row.conversation_id);
    }

    /**
     * Hand a task to a live run. Legal ONLY from 'queued' (first dispatch) or
     * 'waiting_input' (the owner answered) — any other status returns null
     * WITHOUT touching the row, which is how a double dispatch is a no-op
     * rather than a resurrection. started_at is insert-once (COALESCE), so a
     * resumed task keeps its original start; result_summary survives a resume
     * while pending_question and reported_outcome are cleared, because the
     * answer just arrived and the bot must report again for this leg. seen_at
     * is cleared with them: a resumed row is back in motion, and leaving the
     * stamp from the answered leg standing would let a crash between here and
     * the next finalize (the boot sweep fails it) land a settled row that the
     * badge counts as already read. A resume from 'waiting_input' first appends
     * the parked state it clears to `resume_log`, so a rewind that discards the
     * answering turn can put the task back exactly there (rewindBotTasks).
     */
    markBotTaskRunning(taskId: string, runId: string): BotTask | null {
      const row = this.botTaskRow(taskId);
      if (!row || (row.status !== "queued" && row.status !== "waiting_input")) {
        return null;
      }
      const timestamp = now();
      const resumeLog =
        row.status === "waiting_input"
          ? JSON.stringify(
              [
                ...parseResumeLog(row.resume_log),
                {
                  at: timestamp,
                  pendingQuestion: row.pending_question,
                  reportedOutcome: row.reported_outcome,
                  resultSummary: row.result_summary,
                  error: row.error,
                  model: row.model,
                  seenAt: row.seen_at,
                } satisfies BotTaskResumeSnapshot,
              ].slice(-MAX_RESUME_SNAPSHOTS),
            )
          : row.resume_log;
      // Guarded on the status just read (a synchronous read-then-write, so
      // nothing can move the row in between): a double dispatch is still a
      // null no-op, never a resurrection.
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET status = 'running', run_id = ?, started_at = COALESCE(started_at, ?),
                 pending_question = NULL, reported_outcome = NULL, seen_at = NULL,
                 resume_log = ?
           WHERE id = ? AND status = ?`,
        )
        .run(runId, timestamp, resumeLog, taskId, row.status);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * The bot-task half of a rewind to `cutoff` (the anchor row's created_at),
     * run inside the rewind transaction. Every turn from the cutoff on is
     * discarded, so a task one of them OPENED is deleted (a leftover
     * 'waiting_input' row would be resumed by the next turn), and a task one of
     * them RESUMED — parked on a question before the cutoff, answered by a
     * discarded turn — goes back to the parked state of its FIRST resume at or
     * after the cutoff: that question pending again and the discarded legs'
     * report, result and finish gone. The re-run then resumes it instead of
     * opening a duplicate card. An owner cancel made after the cutoff is undone
     * with the rest. A resume from before `resume_log` existed left no snapshot
     * and is left as it is.
     */
    rewindBotTasks(conversationId: string, cutoff: string): void {
      this.db
        .prepare("DELETE FROM bot_tasks WHERE conversation_id = ? AND created_at >= ?")
        .run(conversationId, cutoff);
      const resumed = this.db
        .prepare("SELECT * FROM bot_tasks WHERE conversation_id = ? AND resume_log IS NOT NULL")
        .all(conversationId) as BotTaskRow[];
      const restore = this.db.prepare(
        `UPDATE bot_tasks
           SET status = 'waiting_input', run_id = NULL, finished_at = NULL,
               pending_question = ?, reported_outcome = ?, result_summary = ?,
               error = ?, model = ?, seen_at = ?, resume_log = ?
         WHERE id = ?`,
      );
      for (const row of resumed) {
        const log = parseResumeLog(row.resume_log);
        const first = log.findIndex((snapshot) => snapshot.at >= cutoff);
        if (first < 0) {
          continue;
        }
        const parked = log[first];
        const kept = log.slice(0, first);
        restore.run(
          parked.pendingQuestion,
          parked.reportedOutcome,
          parked.resultSummary,
          parked.error,
          parked.model,
          parked.seenAt,
          kept.length ? JSON.stringify(kept) : null,
          row.id,
        );
      }
    }

    /**
     * What the bot itself declared MID-run via mcp__personal_agent__report_task.
     * Legal only while 'running'. Deliberately does NOT move status: the turn
     * finalize owns that, reading reported_outcome to pick done vs
     * waiting_input, so a report that lands without a finalize (crash, abort)
     * never leaves a task falsely terminal.
     */
    setBotTaskReport(
      taskId: string,
      report: { outcome: "done" | "need_input"; summary: string },
    ): BotTask | null {
      const done = report.outcome === "done";
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET reported_outcome = ?,
                 result_summary = CASE WHEN ? = 1 THEN ? ELSE result_summary END,
                 pending_question = CASE WHEN ? = 1 THEN pending_question ELSE ? END
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          report.outcome,
          done ? 1 : 0,
          report.summary,
          done ? 1 : 0,
          report.summary,
          taskId,
        );
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Close out a leg of the run. Legal ONLY from 'running', so a double
     * finalize (stream end racing an abort handler) is a null no-op. Terminal
     * statuses stamp finished_at; 'waiting_input' parks the task with
     * finished_at NULL so the owner's next message can resume it. Either way
     * run_id is cleared — the in-memory registry entry is gone. An `undefined`
     * field KEEPS its stored value (the finalize passes only what it knows,
     * e.g. a report already wrote result_summary); an explicit null clears.
     * seen_at is cleared UNCONDITIONALLY, on every transition this performs:
     * whatever the owner read before, this leg's outcome is new to them.
     */
    finishBotTask(
      taskId: string,
      outcome: {
        status: "done" | "failed" | "cancelled" | "waiting_input";
        resultSummary?: string | null;
        pendingQuestion?: string | null;
        error?: string | null;
        model?: string | null;
      },
    ): BotTask | null {
      const terminal = outcome.status !== "waiting_input";
      const keep = (value: string | null | undefined) =>
        value === undefined ? 1 : 0;
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks
             SET status = ?,
                 run_id = NULL,
                 seen_at = NULL,
                 finished_at = ?,
                 result_summary = CASE WHEN ? = 1 THEN result_summary ELSE ? END,
                 pending_question = CASE WHEN ? = 1 THEN pending_question ELSE ? END,
                 error = CASE WHEN ? = 1 THEN error ELSE ? END,
                 model = CASE WHEN ? = 1 THEN model ELSE ? END
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          outcome.status,
          terminal ? now() : null,
          keep(outcome.resultSummary),
          outcome.resultSummary ?? null,
          keep(outcome.pendingQuestion),
          outcome.pendingQuestion ?? null,
          keep(outcome.error),
          outcome.error ?? null,
          keep(outcome.model),
          outcome.model ?? null,
          taskId,
        );
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Owner-initiated cancel of work that is not CURRENTLY executing: 'queued'
     * (never dispatched) or 'waiting_input' (parked on a question the owner
     * chose to abandon rather than answer). A 'running' task is stopped through
     * the run registry instead, so it does NOT match here — the method name
     * keeps its original queue framing, the contract is the wider one. Guarded
     * on the owner inside the same UPDATE; pendingQuestion is left standing so
     * the abandoned card still shows what was asked. seen_at is STAMPED in the
     * same UPDATE — this is the one transition the owner drives by hand, so
     * they are looking at the card as it lands. Null covers "gone", "not
     * yours" and "wrong status" identically ON PURPOSE: the caller is a route,
     * and distinguishing them would confirm another owner's task id exists.
     */
    cancelQueuedBotTask(taskId: string, ownerUserId: string): BotTask | null {
      const timestamp = now();
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'cancelled', finished_at = ?, seen_at = ?, run_id = NULL
           WHERE id = ? AND owner_user_id = ? AND status IN ('queued', 'waiting_input')`,
        )
        .run(timestamp, timestamp, taskId, ownerUserId);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Kill a task the dispatcher can no longer run: its bot was deleted,
     * disabled or its owner demoted between the enqueue and the dispatch.
     * Legal ONLY from 'queued' — a task that already reached a run fails
     * through finishBotTask instead, so the two paths never race for the same
     * row. run_id is left alone rather than cleared: a queued row never carries
     * one (createBotTask drops the runId unless the task starts running).
     */
    failQueuedBotTask(taskId: string, error: string): BotTask | null {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ? AND status = 'queued'`,
        )
        .run(error, now(), taskId);
      return this.botTaskIfChanged(taskId, changes);
    }

    /**
     * Boot sweep: run_id points into an IN-MEMORY registry that a restart
     * erases, so every row still marked 'running' belongs to a run nothing can
     * finalize any more. Fail them (Korean, user-facing `error`) instead of
     * leaving cards spinning forever. 'queued' rows are untouched — they were
     * never dispatched and the dispatcher can still pick them up.
     */
    sweepInterruptedBotTasks(error: string): number {
      const { changes } = this.db
        .prepare(
          `UPDATE bot_tasks SET status = 'failed', error = ?, finished_at = ?, run_id = NULL
           WHERE status = 'running'`,
        )
        .run(error, now());
      return changes;
    }
  };
}
