import crypto from "node:crypto";
import { personalAgentAvatarId } from "../personalAgents.js";
import {
  formatMinuteOfDay,
  isFutureOnceSchedule,
  nextRunIso,
  type RoutineSchedule,
  type ScheduleKind,
} from "../routineSchedule.js";
import type { RoutineJob } from "../types.js";
import { type Constructor, type RoutineJobRow, type StoreBase, now } from "./internal.js";

export function withRoutines<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Routines extends Base {
    // ---- Routine jobs (owner-scheduled one-time or recurring runs) -------

    private toRoutineJob(row: RoutineJobRow): RoutineJob {
      const schedule = this.scheduleFromRow(row);
      return {
        id: row.id,
        avatarUserId: row.avatar_user_id,
        conversationId: row.conversation_id,
        name: row.name ?? null,
        prompt: row.prompt,
        scheduleKind: schedule.kind,
        minuteOfDay: schedule.minuteOfDay,
        time: formatMinuteOfDay(schedule.minuteOfDay),
        daysOfWeek: schedule.daysOfWeek,
        intervalMinutes: schedule.intervalMinutes,
        runDate: schedule.runDate,
        enabled: row.enabled === 1,
        nextRunAt: row.next_run_at,
        lastRunAt: row.last_run_at,
        lastStatus: (row.last_status as RoutineJob["lastStatus"]) ?? null,
        lastError: row.last_error,
        completedAt: row.completed_at,
        createdAt: row.created_at,
        personalAgentId: row.personal_agent_id ?? null,
      };
    }

    /** Decode the stored days_of_week JSON, tolerating a corrupt value (→ null)
     *  so one bad row can't throw and abort a scheduler tick. Elements are
     *  validated too — a stray non-int/out-of-range entry must not reach the
     *  next-run math as garbage. */
    private parseDaysOfWeek(raw: string | null): number[] | null {
      if (!raw) {
        return null;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          return null;
        }
        const days = parsed.filter(
          (d): d is number => Number.isInteger(d) && d >= 0 && d <= 6,
        );
        return days.length > 0 ? days : null;
      } catch {
        return null;
      }
    }

    /** Reconstruct a RoutineSchedule from a stored row (legacy NULL / unknown /
     *  blank kind → daily — `??` alone would let "" through). */
    private scheduleFromRow(row: RoutineJobRow): RoutineSchedule {
      const kind: ScheduleKind =
        row.schedule_kind === "weekly" ||
        row.schedule_kind === "interval" ||
        row.schedule_kind === "once"
          ? row.schedule_kind
          : "daily";
      return {
        kind,
        minuteOfDay: row.minute_of_day,
        daysOfWeek: this.parseDaysOfWeek(row.days_of_week),
        intervalMinutes: row.interval_minutes ?? null,
        runDate: row.run_date ?? null,
      };
    }

    private routineJobRow(id: string): RoutineJobRow | undefined {
      return this.db.prepare("SELECT * FROM routine_jobs WHERE id = ?").get(id) as
        | RoutineJobRow
        | undefined;
    }

    /**
     * One owner's routines. `opts.personalAgentId` is TRI-STATE: omitted (or
     * undefined) lists EVERYTHING — the owner's own routines and every bot's —
     * which is what the routines route and RoutinesView keep seeing; a bot id
     * narrows to that bot's; an explicit `null` narrows to the main-avatar ones
     * (`personal_agent_id IS NULL`). The owner guard is the same either way:
     * `avatar_user_id` stays the OWNER's uuid for a bot routine too.
     */
    listRoutineJobs(
      avatarUserId: string,
      opts: { personalAgentId?: string | null } = {},
    ): RoutineJob[] {
      const params: unknown[] = [avatarUserId];
      let where = "avatar_user_id = ?";
      if (opts.personalAgentId === null) {
        where += " AND personal_agent_id IS NULL";
      } else if (opts.personalAgentId !== undefined) {
        where += " AND personal_agent_id = ?";
        params.push(opts.personalAgentId);
      }
      const rows = this.db
        .prepare(`SELECT * FROM routine_jobs WHERE ${where} ORDER BY created_at ASC`)
        .all(...params) as RoutineJobRow[];
      return rows.map((r) => this.toRoutineJob(r));
    }

    /**
     * Every routine that fires into one conversation (the thread id is the key;
     * a routine's thread belongs to its owner). What a rewind of that thread asks
     * the running-routine registry about.
     */
    routineJobIdsForConversation(conversationId: string): string[] {
      const rows = this.db
        .prepare("SELECT id FROM routine_jobs WHERE conversation_id = ?")
        .all(conversationId) as { id: string }[];
      return rows.map((row) => row.id);
    }

    /** Enabled jobs whose next run is at or before `nowIso`. Used by the scheduler. */
    listDueRoutineJobs(nowIso: string): RoutineJob[] {
      // Skip jobs whose owner is suspended: a suspended account's avatar must not
      // keep running headless, elevated routines (with its stored secrets/tokens).
      const rows = this.db
        .prepare(
          `SELECT rj.* FROM routine_jobs rj
           JOIN users u ON u.id = rj.avatar_user_id
           WHERE rj.enabled = 1 AND rj.next_run_at IS NOT NULL AND rj.next_run_at <= ?
             AND u.suspended = 0
           ORDER BY rj.next_run_at ASC`,
        )
        .all(nowIso) as RoutineJobRow[];
      return rows.map((r) => this.toRoutineJob(r));
    }

    getRoutineJob(avatarUserId: string, id: string): RoutineJob | null {
      const row = this.routineJobRow(id);
      if (!row || row.avatar_user_id !== avatarUserId) {
        return null;
      }
      return this.toRoutineJob(row);
    }

    createRoutineJob(
      avatarUserId: string,
      input: {
        name?: string | null;
        prompt: string;
        /** Pre-validated schedule (from parseRoutineSchedule); takes precedence over
         *  the legacy individual schedule fields below when provided. */
        schedule?: RoutineSchedule;
        scheduleKind?: ScheduleKind;
        minuteOfDay?: number;
        daysOfWeek?: number[] | null;
        intervalMinutes?: number | null;
        runDate?: string | null;
        enabled?: boolean;
        /**
         * 봇 루틴: bind this routine to one of the owner's personal agents
         * (personal_agents.id). Absent/null = the owner's main avatar, i.e. every
         * legacy routine. A bound routine fires as a DELEGATED BOT TASK in a
         * thread owned by the owner but bound to the bot's COMPOSITE avatar id;
         * a routine never moves between identities afterwards (updateRoutineJob
         * deliberately takes no such field).
         */
        personalAgentId?: string | null;
      },
    ): RoutineJob {
      const id = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const requestedEnabled = input.enabled !== false;
      const prompt = input.prompt.trim();
      const name = input.name?.trim() || null;
      // A validated RoutineSchedule object fully defines the schedule when present;
      // otherwise fall back to the legacy individual fields (scheduleKind/
      // minuteOfDay/...) for backward-compat callers.
      const schedule = input.schedule;
      const kind: ScheduleKind = schedule?.kind ?? input.scheduleKind ?? "daily";
      const minuteOfDay = schedule ? schedule.minuteOfDay : (input.minuteOfDay ?? 0);
      const daysOfWeek = schedule ? schedule.daysOfWeek : (input.daysOfWeek ?? null);
      const intervalMinutes = schedule ? schedule.intervalMinutes : (input.intervalMinutes ?? null);
      const runDate = kind === "once" ? (schedule ? schedule.runDate : (input.runDate ?? null)) : null;
      const normalizedSchedule: RoutineSchedule = {
        kind,
        minuteOfDay,
        daysOfWeek,
        intervalMinutes,
        runDate,
      };
      // API/MCP callers reject past one-time slots. Keep the store safe for
      // legacy/direct callers too: an expired one-time job is created parked,
      // never as an immediately due job that could run unexpectedly.
      const enabled = requestedEnabled && isFutureOnceSchedule(normalizedSchedule);
      const nextRunAt = enabled ? nextRunIso(normalizedSchedule) : null;
      const personalAgentId = input.personalAgentId || null;
      // A bot routine's thread belongs to the BOT (composite avatar id) while the
      // routine row keeps the OWNER's uuid in avatar_user_id — that is what lets
      // the scheduler's suspended-owner JOIN and deleteUser's sweep stay
      // untouched, and what binds the thread to the 봇 오피스 surfaces.
      const threadAvatarId = personalAgentId
        ? personalAgentAvatarId(avatarUserId, personalAgentId)
        : avatarUserId;
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO routine_jobs (id, avatar_user_id, conversation_id, name, prompt, minute_of_day, schedule_kind, days_of_week, interval_minutes, run_date, enabled, next_run_at, completed_at, created_at, personal_agent_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            avatarUserId,
            conversationId,
            name,
            prompt,
            minuteOfDay,
            kind,
            daysOfWeek ? JSON.stringify(daysOfWeek) : null,
            intervalMinutes,
            runDate,
            enabled ? 1 : 0,
            nextRunAt,
            null,
            now(),
            personalAgentId,
          );
        // Create the dedicated conversation eagerly so the client can always
        // open it (and so its title comes from the name/prompt, not from whatever
        // message lands in it first).
        this.touchConversation(avatarUserId, conversationId, threadAvatarId, `[예약 작업] ${name || prompt}`, { isRoutine: true });
      });
      tx();
      return this.toRoutineJob(this.routineJobRow(id)!);
    }

    /**
     * Patch a routine's label/prompt/schedule. There is deliberately NO
     * `personalAgentId` here: a routine never moves between identities — its
     * thread is already bound to one avatar id and its history would land under
     * the wrong one — so re-binding means deleting and re-creating.
     */
    updateRoutineJob(
      avatarUserId: string,
      id: string,
      patch: {
        name?: string | null;
        prompt?: string;
        /** Pre-validated schedule (from parseRoutineSchedule); when provided it
         *  replaces the whole schedule, equivalent to supplying every individual
         *  schedule field below. */
        schedule?: RoutineSchedule;
        scheduleKind?: ScheduleKind;
        minuteOfDay?: number;
        daysOfWeek?: number[] | null;
        intervalMinutes?: number | null;
        runDate?: string | null;
        enabled?: boolean;
      },
    ): RoutineJob | null {
      const row = this.routineJobRow(id);
      if (!row || row.avatar_user_id !== avatarUserId) {
        return null;
      }
      // name === null clears the label; undefined leaves it as-is.
      const name =
        patch.name !== undefined ? (patch.name?.trim() || null) : (row.name ?? null);
      const prompt = patch.prompt !== undefined ? patch.prompt.trim() : row.prompt;
      // A validated RoutineSchedule replaces the whole schedule; otherwise the
      // legacy per-field patch values apply. Either way `schedule*` below is what
      // the existing diff/recompute logic compares against the stored row.
      const scheduleKind = patch.schedule?.kind ?? patch.scheduleKind;
      const patchMinuteOfDay = patch.schedule ? patch.schedule.minuteOfDay : patch.minuteOfDay;
      const patchDaysOfWeek = patch.schedule ? patch.schedule.daysOfWeek : patch.daysOfWeek;
      const patchIntervalMinutes = patch.schedule
        ? patch.schedule.intervalMinutes
        : patch.intervalMinutes;
      const patchRunDate = patch.schedule ? patch.schedule.runDate : patch.runDate;
      const existing = this.scheduleFromRow(row);
      const kind: ScheduleKind = scheduleKind ?? existing.kind;
      const minuteOfDay = patchMinuteOfDay !== undefined ? patchMinuteOfDay : existing.minuteOfDay;
      const daysOfWeek = patchDaysOfWeek !== undefined ? patchDaysOfWeek : existing.daysOfWeek;
      const intervalMinutes =
        patchIntervalMinutes !== undefined ? patchIntervalMinutes : existing.intervalMinutes;
      const runDate =
        kind === "once"
          ? (patchRunDate !== undefined ? patchRunDate : existing.runDate)
          : null;
      const wasEnabled = row.enabled === 1;
      const enabled = patch.enabled !== undefined ? patch.enabled : wasEnabled;
      // The schedule changed if any schedule field was supplied AND differs from
      // the stored value. A name/prompt-only edit must keep an overdue (missed)
      // run intact — recomputing would silently push it forward.
      const scheduleChanged =
        (scheduleKind !== undefined && scheduleKind !== existing.kind) ||
        (patchMinuteOfDay !== undefined && patchMinuteOfDay !== existing.minuteOfDay) ||
        (patchDaysOfWeek !== undefined &&
          JSON.stringify(patchDaysOfWeek ?? null) !== JSON.stringify(existing.daysOfWeek)) ||
        (patchIntervalMinutes !== undefined && patchIntervalMinutes !== existing.intervalMinutes) ||
        (patchRunDate !== undefined && patchRunDate !== existing.runDate);
      const normalizedSchedule: RoutineSchedule = {
        kind,
        minuteOfDay,
        daysOfWeek,
        intervalMinutes,
        runDate,
      };
      let nextRunAt: string | null;
      if (!enabled) {
        nextRunAt = null;
      } else if (scheduleChanged || !wasEnabled || !row.next_run_at) {
        nextRunAt = isFutureOnceSchedule(normalizedSchedule)
          ? nextRunIso(normalizedSchedule)
          : null;
      } else {
        nextRunAt = row.next_run_at;
      }
      // A past one-time schedule cannot be re-enabled without selecting a new
      // future date. Route/tool layers return a validation error; this is the
      // final invariant for direct store callers.
      const effectiveEnabled = enabled && (kind !== "once" || nextRunAt !== null);
      const completedAt =
        !effectiveEnabled && kind === "once" && !scheduleChanged
          ? row.completed_at
          : null;
      this.db
        .prepare(
          "UPDATE routine_jobs SET name = ?, prompt = ?, schedule_kind = ?, minute_of_day = ?, days_of_week = ?, interval_minutes = ?, run_date = ?, enabled = ?, next_run_at = ?, completed_at = ? WHERE id = ?",
        )
        .run(
          name,
          prompt,
          kind,
          minuteOfDay,
          daysOfWeek ? JSON.stringify(daysOfWeek) : null,
          intervalMinutes,
          runDate,
          effectiveEnabled ? 1 : 0,
          nextRunAt,
          completedAt,
          id,
        );
      return this.toRoutineJob(this.routineJobRow(id)!);
    }

    deleteRoutineJob(avatarUserId: string, id: string): boolean {
      const result = this.db
        .prepare("DELETE FROM routine_jobs WHERE id = ? AND avatar_user_id = ?")
        .run(id, avatarUserId);
      return result.changes > 0;
    }

    /**
     * Record the outcome of a firing and schedule the next one. Recurring jobs
     * roll forward; a one-time job becomes completed after its single attempt.
     * A recurring job disabled mid-run stays parked.
     */
    markRoutineRun(id: string, outcome: { status: "success" | "error"; error?: string | null }): void {
      const row = this.routineJobRow(id);
      if (!row) {
        return;
      }
      const schedule = this.scheduleFromRow(row);
      const runAt = now();
      const oneTimeCompleted = schedule.kind === "once";
      const nextRunAt = row.enabled === 1 && !oneTimeCompleted ? nextRunIso(schedule) : null;
      this.db
        .prepare(
          "UPDATE routine_jobs SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?, enabled = ?, completed_at = ? WHERE id = ?",
        )
        .run(
          runAt,
          outcome.status,
          outcome.error ?? null,
          nextRunAt,
          oneTimeCompleted ? 0 : row.enabled,
          oneTimeCompleted ? runAt : row.completed_at,
          id,
        );
    }
  };
}
