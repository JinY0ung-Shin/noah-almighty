import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import { executeRoutineJob, isRoutineRunning } from "../scheduler.js";
import {
  isFutureOnceSchedule,
  parseRoutineSchedule,
  type RoutineSchedule,
  type ScheduleKind,
} from "../routineSchedule.js";
import { apiError, KOREAN_SCHEDULE_ERROR, safeString, type RouterDeps } from "./_shared.js";

// ---- Routine jobs (owner-scheduled one-time or recurring runs) -------
export function createRoutinesRouter({ services, store }: RouterDeps): Router {
  const router = Router();

  router.get("/api/me/routines", requireAuth(store), (req: AuthenticatedRequest, res) => {
    res.json({ routines: store.listRoutineJobs(req.user!.id) });
  });

  router.post("/api/me/routines", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const rawName = safeString(req.body?.name);
    const name = rawName || null;
    const prompt = safeString(req.body?.prompt);
    if (!prompt) {
      apiError(res, 400, "prompt를 입력해 주세요.");
      return;
    }
    // Reject non-boolean `enabled` ("true", 1, …) instead of silently coercing
    // it to a parked routine the caller thinks is active.
    if (req.body?.enabled !== undefined && typeof req.body.enabled !== "boolean") {
      apiError(res, 400, "enabled는 boolean이어야 합니다.");
      return;
    }
    const enabled = req.body?.enabled === undefined ? true : (req.body.enabled as boolean);
    const parsed = parseRoutineSchedule({
      scheduleKind: req.body?.scheduleKind,
      time: req.body?.time,
      daysOfWeek: req.body?.daysOfWeek,
      intervalMinutes: req.body?.intervalMinutes,
      date: req.body?.date,
    });
    if (!parsed.ok) {
      apiError(res, 400, KOREAN_SCHEDULE_ERROR[parsed.error]);
      return;
    }
    const routine = store.createRoutineJob(req.user!.id, {
      name,
      prompt,
      schedule: parsed.value,
      enabled,
    });
    logger.info(
      { userId: req.user!.id, routineId: routine.id, scheduleKind: parsed.value.kind },
      "routine created",
    );
    res.json({ routine });
  });

  router.patch("/api/me/routines/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const patch: {
      name?: string | null;
      prompt?: string;
      scheduleKind?: ScheduleKind;
      minuteOfDay?: number;
      daysOfWeek?: number[] | null;
      intervalMinutes?: number | null;
      runDate?: string | null;
      enabled?: boolean;
    } = {};
    if (typeof req.body?.name === "string") {
      patch.name = safeString(req.body.name) || null;
    } else if (req.body?.name === null) {
      patch.name = null;
    }
    if (typeof req.body?.prompt === "string") {
      const prompt = safeString(req.body.prompt);
      if (!prompt) {
        apiError(res, 400, "prompt를 입력해 주세요.");
        return;
      }
      patch.prompt = prompt;
    }
    if (typeof req.body?.enabled === "boolean") {
      patch.enabled = req.body.enabled;
    }
    const scheduleTouched =
      req.body?.scheduleKind !== undefined ||
      req.body?.time !== undefined ||
      req.body?.daysOfWeek !== undefined ||
      req.body?.intervalMinutes !== undefined ||
      req.body?.date !== undefined;
    if (scheduleTouched) {
      const parsed = parseRoutineSchedule({
        scheduleKind: req.body?.scheduleKind,
        time: req.body?.time,
        daysOfWeek: req.body?.daysOfWeek,
        intervalMinutes: req.body?.intervalMinutes,
        date: req.body?.date,
      });
      if (!parsed.ok) {
        apiError(res, 400, KOREAN_SCHEDULE_ERROR[parsed.error]);
        return;
      }
      patch.scheduleKind = parsed.value.kind;
      patch.minuteOfDay = parsed.value.minuteOfDay;
      patch.daysOfWeek = parsed.value.daysOfWeek;
      patch.intervalMinutes = parsed.value.intervalMinutes;
      patch.runDate = parsed.value.runDate;
    }
    const existing = store.getRoutineJob(req.user!.id, req.params.id);
    if (!existing) {
      apiError(res, 404, "예약 작업을 찾을 수 없습니다.");
      return;
    }
    if (patch.enabled === true) {
      const candidate: RoutineSchedule = {
        kind: patch.scheduleKind ?? existing.scheduleKind,
        minuteOfDay: patch.minuteOfDay ?? existing.minuteOfDay,
        daysOfWeek: patch.daysOfWeek !== undefined ? patch.daysOfWeek : existing.daysOfWeek,
        intervalMinutes:
          patch.intervalMinutes !== undefined
            ? patch.intervalMinutes
            : existing.intervalMinutes,
        runDate: patch.runDate !== undefined ? patch.runDate : existing.runDate,
      };
      if (!isFutureOnceSchedule(candidate)) {
        apiError(res, 400, KOREAN_SCHEDULE_ERROR.DATE_IN_PAST);
        return;
      }
    }
    const routine = store.updateRoutineJob(req.user!.id, req.params.id, patch);
    if (!routine) {
      apiError(res, 404, "예약 작업을 찾을 수 없습니다.");
      return;
    }
    res.json({ routine });
  });

  router.delete("/api/me/routines/:id", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const removed = store.deleteRoutineJob(req.user!.id, req.params.id);
    if (!removed) {
      apiError(res, 404, "예약 작업을 찾을 수 없습니다.");
      return;
    }
    logger.info({ userId: req.user!.id, routineId: req.params.id }, "routine deleted");
    res.json({ ok: true });
  });

  // Fire a routine immediately (a "test run"). Recurring jobs reschedule;
  // one-time jobs consume their single run and become completed.
  // executeRoutineJob owns the shared overlap guard and outcome recording, so a
  // manual run can never overlap a scheduled firing of the same job.
  router.post("/api/me/routines/:id/run", requireAuth(store), async (req: AuthenticatedRequest, res) => {
    const job = store.getRoutineJob(req.user!.id, req.params.id);
    if (!job) {
      apiError(res, 404, "예약 작업을 찾을 수 없습니다.");
      return;
    }
    if (isRoutineRunning(job.id)) {
      apiError(res, 409, "이미 실행 중인 예약 작업입니다.");
      return;
    }
    const result = await executeRoutineJob(services, job);
    if (result.skipped) {
      // The skip carries its own Korean reason (busy conversation, a working
      // repo open in another conversation, or a 봇 루틴 whose previous firing
      // still waits in the queue) — surface it
      // instead of collapsing every skip into the generic already-running text.
      apiError(res, 409, result.error || "이미 실행 중인 예약 작업입니다.");
      return;
    }
    logger.info({ userId: req.user!.id, routineId: job.id, ok: result.ok }, "routine manual run");
    const routine = store.getRoutineJob(req.user!.id, job.id);
    res.json({ ok: result.ok, error: result.error, routine });
  });

  return router;
}
