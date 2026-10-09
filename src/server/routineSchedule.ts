// Routine schedule math. Routine times are interpreted in Seoul time (KST).
// Korea observes no DST, so KST is a fixed UTC+9 offset — the arithmetic below
// is independent of the server's own timezone. Pure module, no DB access.

export type ScheduleKind = "daily" | "weekly" | "interval" | "once";

export interface RoutineSchedule {
  kind: ScheduleKind;
  /** 0..1439; used by once/daily/weekly; 0 for interval. */
  minuteOfDay: number;
  /** weekly only: sorted unique ints 0(Sun)..6(Sat), length>=1. */
  daysOfWeek: number[] | null;
  /** interval only: integer 5..10080. */
  intervalMinutes: number | null;
  /** once only: YYYY-MM-DD in KST; null for recurring schedules. */
  runDate: string | null;
}

export type ScheduleError =
  | "INVALID_KIND"
  | "TIME_REQUIRED"
  | "INVALID_TIME"
  | "DAYS_REQUIRED"
  | "INVALID_DAYS"
  | "INTERVAL_REQUIRED"
  | "INVALID_INTERVAL"
  | "DATE_REQUIRED"
  | "INVALID_DATE"
  | "DATE_IN_PAST";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
  value: string;
}

/** Strict YYYY-MM-DD parser that rejects normalized dates such as 2026-02-31. */
function parseCalendarDate(value: unknown): CalendarDate | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, value: trimmed };
}

/**
 * The canonical `YYYY-MM-DD` for a real calendar date, or null (`2026-02-31`,
 * `10/9`, a non-string). Shared with to-do due dates so every KST calendar date
 * the app stores is validated by this ONE parser.
 */
export function normalizeCalendarDate(value: unknown): string | null {
  return parseCalendarDate(value)?.value ?? null;
}

/** The KST calendar date (`YYYY-MM-DD`) at `from`. */
export function kstDateString(from: Date = new Date()): string {
  return new Date(from.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Day of week (0=Sun..6=Sat) of a real `YYYY-MM-DD` calendar date, or null. */
export function calendarDateWeekday(value: unknown): number | null {
  const date = parseCalendarDate(value);
  return date ? new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() : null;
}

const WEEKDAY_ABBREVIATIONS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Agent-facing KST "today" with its weekday, e.g. `2026-10-09 (Fri)`. */
export function kstDateWithWeekday(from: Date = new Date()): string {
  const today = kstDateString(from);
  const weekday = calendarDateWeekday(today);
  return weekday === null ? today : `${today} (${WEEKDAY_ABBREVIATIONS[weekday]})`;
}

/** Convert a KST calendar date + minutes-from-midnight to an exact UTC ISO instant. */
function onceRunIso(runDate: string | null, minuteOfDay: number): string | null {
  const date = parseCalendarDate(runDate);
  if (!date || !Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1439) {
    return null;
  }
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const utcMs = Date.UTC(date.year, date.month - 1, date.day, hour, minute) - KST_OFFSET_MS;
  return new Date(utcMs).toISOString();
}

/** "HH:MM" (KST wall-clock) for minutes-from-midnight (0..1439). */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:MM" -> 0..1439 | null. Accepts unknown; only strings can be valid. */
export function parseTimeToMinute(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return null;
  }
  return h * 60 + m;
}

/** Sorted-unique normalization of a weekday array, or null if any entry is invalid. */
function normalizeDaysOfWeek(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const set = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 6) {
      return null;
    }
    set.add(entry);
  }
  return [...set].sort((a, b) => a - b);
}

export function parseRoutineSchedule(raw: {
  scheduleKind?: unknown;
  time?: unknown;
  daysOfWeek?: unknown;
  intervalMinutes?: unknown;
  date?: unknown;
}, from: Date = new Date()): { ok: true; value: RoutineSchedule } | { ok: false; error: ScheduleError } {
  let kind: ScheduleKind;
  if (raw.scheduleKind === undefined || raw.scheduleKind === null) {
    kind = "daily";
  } else if (
    raw.scheduleKind === "daily" ||
    raw.scheduleKind === "weekly" ||
    raw.scheduleKind === "interval" ||
    raw.scheduleKind === "once"
  ) {
    kind = raw.scheduleKind;
  } else {
    return { ok: false, error: "INVALID_KIND" };
  }

  if (kind === "interval") {
    const interval = raw.intervalMinutes;
    if (interval === undefined || interval === null) {
      return { ok: false, error: "INTERVAL_REQUIRED" };
    }
    if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 5 || interval > 10080) {
      return { ok: false, error: "INVALID_INTERVAL" };
    }
    return {
      ok: true,
      value: { kind, minuteOfDay: 0, daysOfWeek: null, intervalMinutes: interval, runDate: null },
    };
  }

  if (kind === "once") {
    if (raw.date === undefined || raw.date === null || raw.date === "") {
      return { ok: false, error: "DATE_REQUIRED" };
    }
    const runDate = parseCalendarDate(raw.date);
    if (!runDate) {
      return { ok: false, error: "INVALID_DATE" };
    }
    if (raw.time === undefined || raw.time === null || raw.time === "") {
      return { ok: false, error: "TIME_REQUIRED" };
    }
    const minuteOfDay = parseTimeToMinute(raw.time);
    if (minuteOfDay === null) {
      return { ok: false, error: "INVALID_TIME" };
    }
    const schedule: RoutineSchedule = {
      kind,
      minuteOfDay,
      daysOfWeek: null,
      intervalMinutes: null,
      runDate: runDate.value,
    };
    if (!isFutureOnceSchedule(schedule, from)) {
      return { ok: false, error: "DATE_IN_PAST" };
    }
    return { ok: true, value: schedule };
  }

  // daily and weekly both need a time.
  if (raw.time === undefined || raw.time === null || raw.time === "") {
    return { ok: false, error: "TIME_REQUIRED" };
  }
  const minuteOfDay = parseTimeToMinute(raw.time);
  if (minuteOfDay === null) {
    return { ok: false, error: "INVALID_TIME" };
  }

  if (kind === "daily") {
    return {
      ok: true,
      value: { kind, minuteOfDay, daysOfWeek: null, intervalMinutes: null, runDate: null },
    };
  }

  // weekly
  if (
    raw.daysOfWeek === undefined ||
    raw.daysOfWeek === null ||
    (Array.isArray(raw.daysOfWeek) && raw.daysOfWeek.length === 0)
  ) {
    return { ok: false, error: "DAYS_REQUIRED" };
  }
  const days = normalizeDaysOfWeek(raw.daysOfWeek);
  if (days === null) {
    return { ok: false, error: "INVALID_DAYS" };
  }
  return {
    ok: true,
    value: { kind, minuteOfDay, daysOfWeek: days, intervalMinutes: null, runDate: null },
  };
}

/** True unless this is a one-time schedule whose exact KST slot is no longer future. */
export function isFutureOnceSchedule(schedule: RoutineSchedule, from: Date = new Date()): boolean {
  if (schedule.kind !== "once") {
    return true;
  }
  const iso = onceRunIso(schedule.runDate, schedule.minuteOfDay);
  return Boolean(iso && new Date(iso).getTime() > from.getTime());
}

/**
 * The next instant (ISO, UTC) a daily job fires after `from`, where
 * `minuteOfDay` is minutes from midnight in **Seoul time (KST)**. If today's
 * KST slot has already passed, returns tomorrow's.
 */
function nextDailyRunIso(minuteOfDay: number, from: Date): string {
  const fromMs = from.getTime();
  // Shift into "KST space" where flooring to a day boundary yields KST midnight.
  const kstMs = fromMs + KST_OFFSET_MS;
  const kstMidnight = Math.floor(kstMs / DAY_MS) * DAY_MS;
  let candidate = kstMidnight + minuteOfDay * 60_000;
  if (candidate <= kstMs) {
    candidate += DAY_MS;
  }
  // Shift back to the real UTC instant.
  return new Date(candidate - KST_OFFSET_MS).toISOString();
}

/**
 * The soonest instant (ISO, UTC) at `minuteOfDay` (KST) on one of `daysOfWeek`,
 * strictly after `from`. Scans up to 8 day-slots forward.
 */
function nextWeeklyRunIso(minuteOfDay: number, daysOfWeek: number[], from: Date): string {
  const fromMs = from.getTime();
  const kstMs = fromMs + KST_OFFSET_MS;
  const kstMidnight = Math.floor(kstMs / DAY_MS) * DAY_MS;
  for (let offset = 0; offset < 8; offset += 1) {
    const dayStart = kstMidnight + offset * DAY_MS;
    // Weekday of this KST day. The Unix epoch (1970-01-01) was a Thursday (4),
    // and dayStart here is a KST-midnight measured in "KST space", so dividing
    // by DAY_MS yields whole KST days since epoch.
    const weekday = (((Math.floor(dayStart / DAY_MS) + 4) % 7) + 7) % 7;
    if (!daysOfWeek.includes(weekday)) {
      continue;
    }
    const candidate = dayStart + minuteOfDay * 60_000;
    if (candidate > kstMs) {
      return new Date(candidate - KST_OFFSET_MS).toISOString();
    }
  }
  // Defensive fallback: should never hit given a non-empty daysOfWeek.
  return new Date(kstMidnight + 7 * DAY_MS + minuteOfDay * 60_000 - KST_OFFSET_MS).toISOString();
}

/**
 * The next firing as a UTC ISO string. Recurring schedules return a slot
 * strictly after `from`; a one-time schedule returns its exact configured slot
 * (callers validate that it is future before enabling it).
 */
export function nextRunIso(schedule: RoutineSchedule, from: Date = new Date()): string {
  switch (schedule.kind) {
    case "once": {
      const iso = onceRunIso(schedule.runDate, schedule.minuteOfDay);
      if (!iso) {
        throw new Error("INVALID_ONCE_SCHEDULE");
      }
      return iso;
    }
    case "interval":
      return new Date(from.getTime() + (schedule.intervalMinutes ?? 0) * 60_000).toISOString();
    case "weekly":
      return nextWeeklyRunIso(schedule.minuteOfDay, schedule.daysOfWeek ?? [], from);
    case "daily":
    default:
      return nextDailyRunIso(schedule.minuteOfDay, from);
  }
}
