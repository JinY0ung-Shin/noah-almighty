// Centered create/edit modal for a routine. `routine === null` = create mode.
// Mirrors the old openRoutineModal()/buildScheduleForm(): markdown prompt
// preview, once/daily/weekly/interval schedule builder with validation, plus
// run-now/delete actions in edit mode.
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Modal from "./Modal";
import { RoutineMarkdown } from "./RoutineRunBlock";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { formatRoutineSchedule, WEEKDAY_NAMES } from "../lib/format";
import { cx, useLatest } from "../lib/hooks";
import { loadRoutinesData } from "../lib/loaders";
import { notify } from "../lib/state";
import type { RoutineJob, RoutinePreset } from "../lib/types";

export interface RoutineModalProps {
  routine?: RoutineJob | null;
  /**
   * Create-mode seed (from the empty-state starter cards). Only consulted when
   * `routine` is null — an edit always wins over a preset.
   */
  preset?: RoutinePreset | null;
  onClose?: () => void;
  onSaved?: () => void;
  onRunNow?: (detail: { routine: RoutineJob }) => void;
  onDeleted?: (detail: { routine: RoutineJob }) => void;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function kstDateString(offsetDays = 0): string {
  const shifted = new Date(Date.now() + KST_OFFSET_MS + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
function validWallTime(wallTime: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(wallTime);
  return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
}
function onceRunTimestamp(date: string, wallTime: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validWallTime(wallTime)) return null;
  const timestamp = Date.parse(`${date}T${wallTime}:00+09:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

// How often a routine fires is the decision this modal is really about, so it
// gets a visible segmented control rather than a collapsed <select> whose
// options you have to open to even know exist.
const SCHEDULE_KINDS: { id: RoutineJob["scheduleKind"]; label: string }[] = [
  { id: "once", label: "한 번만" },
  { id: "daily", label: "매일" },
  { id: "weekly", label: "매주" },
  { id: "interval", label: "간격" },
];

const descId = "routine-modal-desc";
const statusId = "routine-modal-status";
const errorId = "routine-modal-error";

export default function RoutineModal({ routine = null, preset = null, onClose, onSaved, onRunNow, onDeleted }: RoutineModalProps) {
  // What the form starts from is read ONCE, when the modal opens: the mode, the
  // seed and the "initial" values the dirty checks compare against never follow
  // a later prop change.
  const [init] = useState(() => {
    const isEdit = Boolean(routine);
    const seed = isEdit ? null : preset;
    const runDate = routine?.runDate || kstDateString(1);
    const initialDays = Array.isArray(routine?.daysOfWeek) ? routine!.daysOfWeek! : seed?.daysOfWeek;
    const days = [...new Set<number>(Array.isArray(initialDays) ? initialDays : [])];

    // Interval: split the stored minutes into a value + unit (hour/minute).
    const initialInterval = Number(routine?.intervalMinutes) || 0;
    let intervalUnit: "hour" | "minute" = "hour";
    let intervalValue = 1;
    if (initialInterval > 0 && initialInterval % 60 === 0) {
      intervalUnit = "hour";
      intervalValue = initialInterval / 60;
    } else if (initialInterval > 0) {
      intervalUnit = "minute";
      intervalValue = initialInterval;
    }

    const initialScheduleKind = routine?.scheduleKind || "daily";
    const initialTime = routine?.time || "09:00";
    const initialRunDate = routine?.runDate || runDate;
    const initialDayKey = [...days].sort((a, b) => a - b).join(",");
    return {
      isEdit,
      name: routine?.name || seed?.name || "",
      prompt: routine?.prompt || seed?.prompt || "",
      scheduleKind: (routine?.scheduleKind || seed?.scheduleKind || "daily") as RoutineJob["scheduleKind"],
      time: routine?.time || seed?.time || "09:00",
      todayKst: kstDateString(),
      runDate,
      days,
      intervalUnit,
      intervalValue,
      initialName: routine?.name || "",
      initialPrompt: routine?.prompt || "",
      initialScheduleKey: [
        initialScheduleKind,
        initialScheduleKind === "interval" ? initialInterval : initialTime,
        initialScheduleKind === "weekly" ? initialDayKey : "",
        initialScheduleKind === "once" ? initialRunDate : "",
      ].join("|"),
    };
  });
  const { isEdit, todayKst, initialName, initialPrompt, initialScheduleKey } = init;

  const [name, setName] = useState(init.name);
  const [prompt, setPrompt] = useState(init.prompt);
  const [scheduleKind, setScheduleKind] = useState<RoutineJob["scheduleKind"]>(init.scheduleKind);
  const [time, setTime] = useState(init.time);
  const [runDate, setRunDate] = useState(init.runDate);
  // The selected weekdays, in the order they were picked.
  const [dayList, setDayList] = useState<number[]>(init.days);
  const [intervalUnit, setIntervalUnit] = useState<"hour" | "minute">(init.intervalUnit);
  // The number field's own text ("" while it is empty or mid-edit, which counts as 0).
  const [intervalValue, setIntervalValue] = useState(String(init.intervalValue));

  const [errorMessage, setErrorMessage] = useState("");
  const [promptInvalid, setPromptInvalid] = useState(false);
  const [daysInvalid, setDaysInvalid] = useState(false);
  const [intervalInvalid, setIntervalInvalid] = useState(false);
  const [dateInvalid, setDateInvalid] = useState(false);
  // Shown (disabled controls, labels) AND read by what runs later, so it is kept twice.
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  function setBusy(next: boolean): void {
    busyRef.current = next;
    setBusyState(next);
  }
  const promptEl = useRef<HTMLTextAreaElement | null>(null);
  const daysWrapEl = useRef<HTMLDivElement | null>(null);
  const intervalEl = useRef<HTMLInputElement | null>(null);
  const dateEl = useRef<HTMLInputElement | null>(null);
  // The parent's handlers as of the latest render, for the calls made after an await.
  const handlers = useLatest({ onClose, onSaved, onRunNow, onDeleted });

  const promptTrimmed = prompt.trim();
  const nameTrimmed = name.trim();
  const intervalMinutes = (intervalUnit === "hour" ? 60 : 1) * Math.floor(Number(intervalValue) || 0);
  const dayKey = [...dayList].sort((a, b) => a - b).join(",");
  const currentScheduleKey = [
    scheduleKind,
    scheduleKind === "interval" ? intervalMinutes : time,
    scheduleKind === "weekly" ? dayKey : "",
    scheduleKind === "once" ? runDate : "",
  ].join("|");
  const scheduleDirty = currentScheduleKey !== initialScheduleKey;
  const onceTimestamp = onceRunTimestamp(runDate, time);
  const timeReady = validWallTime(time);
  const scheduleReady =
    scheduleKind === "weekly"
      ? dayList.length > 0 && timeReady
      : scheduleKind === "interval"
        ? intervalMinutes >= 5
        : scheduleKind === "once"
          ? Boolean(runDate && timeReady && ((onceTimestamp ?? 0) > Date.now() || (isEdit && !scheduleDirty)))
          : timeReady;
  // Plain-language echo of the schedule under construction, so the user can
  // confirm intent ("매주 금 18:00") without mentally re-assembling four inputs.
  const schedulePreview = scheduleReady
    ? formatRoutineSchedule({
        scheduleKind,
        time,
        daysOfWeek: [...dayList].sort((a, b) => a - b),
        intervalMinutes,
        runDate,
      })
    : "";
  const routineDirty = !isEdit || nameTrimmed !== initialName || prompt !== initialPrompt || scheduleDirty;
  const routineCanSave = Boolean(!busy && promptTrimmed && scheduleReady && routineDirty);
  const saveButtonLabel = busy ? "저장 중…" : isEdit ? "저장" : "예약 작업 추가";
  let routineStatus: string;
  if (busy) routineStatus = "저장 중…";
  else if (!promptTrimmed) routineStatus = "작업 프롬프트를 입력해 주세요.";
  else if (scheduleKind === "weekly" && !dayList.length) routineStatus = "매주 반복할 요일을 선택해 주세요.";
  else if (scheduleKind === "interval" && intervalMinutes < 5) routineStatus = "반복 간격은 5분 이상이어야 합니다.";
  else if (scheduleKind === "once" && !runDate) routineStatus = "실행 날짜를 선택해 주세요.";
  else if (!timeReady) routineStatus = "실행 시각을 입력해 주세요.";
  else if (scheduleKind === "once" && (onceTimestamp ?? 0) <= Date.now() && (!isEdit || scheduleDirty))
    routineStatus = "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.";
  else if (isEdit && !routineDirty) routineStatus = "저장됨";
  else routineStatus = "저장할 준비가 됐습니다.";
  const fieldDescribedBy = errorMessage ? `${statusId} ${errorId}` : statusId;

  function toggleDay(idx: number): void {
    setDayList((days) => (days.includes(idx) ? days.filter((day) => day !== idx) : [...days, idx]));
    setDaysInvalid(false);
    setErrorMessage((message) => (message === "매주 반복은 요일을 1개 이상 선택해 주세요." ? "" : message));
  }

  function onScheduleKindChange(): void {
    setDaysInvalid(false);
    setIntervalInvalid(false);
    setDateInvalid(false);
    setErrorMessage("");
  }

  function pickKind(id: RoutineJob["scheduleKind"]): void {
    setScheduleKind(id);
    onScheduleKindChange();
  }

  function onKindKeydown(event: ReactKeyboardEvent, currentId: RoutineJob["scheduleKind"]): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = SCHEDULE_KINDS.findIndex((k) => k.id === currentId);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? SCHEDULE_KINDS.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + SCHEDULE_KINDS.length) % SCHEDULE_KINDS.length;
    const next = SCHEDULE_KINDS[nextIndex].id;
    pickKind(next);
    requestAnimationFrame(() => document.getElementById(`routine-kind-${next}`)?.focus());
  }

  function clearDateError(): void {
    setDateInvalid(false);
    setErrorMessage((message) =>
      message === "실행 날짜를 선택해 주세요." || message === "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다." ? "" : message,
    );
  }

  function clearTimeError(): void {
    if (scheduleKind === "once") setDateInvalid(false);
    setErrorMessage((message) =>
      message === "실행 시각을 입력해 주세요." || message === "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다." ? "" : message,
    );
  }

  function clearIntervalError(): void {
    setIntervalInvalid(false);
    setErrorMessage((message) => (message === "반복 간격은 5분 이상이어야 합니다." ? "" : message));
  }

  function intervalMinutesFromInputs(): number {
    return intervalMinutes;
  }

  function schedulePayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { scheduleKind };
    if (scheduleKind === "once") payload.date = runDate;
    if (scheduleKind === "once" || scheduleKind === "daily" || scheduleKind === "weekly") payload.time = time;
    if (scheduleKind === "weekly") payload.daysOfWeek = [...dayList].sort((a, b) => a - b);
    if (scheduleKind === "interval") payload.intervalMinutes = intervalMinutesFromInputs();
    return payload;
  }

  // Returns null if valid, or the error string + the field it belongs to (whose
  // invalid flag it sets; a missing time has no field of its own).
  function validateSchedule(): { message: string; field: "days" | "interval" | "date" | null } | null {
    setDaysInvalid(false);
    setIntervalInvalid(false);
    setDateInvalid(false);
    if (scheduleKind === "once" && !runDate) {
      setDateInvalid(true);
      return { message: "실행 날짜를 선택해 주세요.", field: "date" };
    }
    if (scheduleKind !== "interval" && !timeReady) {
      return { message: "실행 시각을 입력해 주세요.", field: null };
    }
    if (scheduleKind === "once" && (onceTimestamp ?? 0) <= Date.now() && (!isEdit || scheduleDirty)) {
      setDateInvalid(true);
      return { message: "한 번만 실행할 날짜와 시각은 현재보다 이후여야 합니다.", field: "date" };
    }
    if (scheduleKind === "weekly" && dayList.length === 0) {
      setDaysInvalid(true);
      return { message: "매주 반복은 요일을 1개 이상 선택해 주세요.", field: "days" };
    }
    if (scheduleKind === "interval" && intervalMinutesFromInputs() < 5) {
      setIntervalInvalid(true);
      return { message: "반복 간격은 5분 이상이어야 합니다.", field: "interval" };
    }
    return null;
  }

  function canClose(): boolean {
    return !busyRef.current;
  }

  function requestClose(): void {
    if (canClose()) handlers.current.onClose?.();
  }

  async function submit(): Promise<void> {
    if (busyRef.current) return;
    if (!promptTrimmed) {
      setErrorMessage("작업 프롬프트를 입력해 주세요.");
      setPromptInvalid(true);
      promptEl.current?.focus();
      return;
    }
    setPromptInvalid(false);
    const schedErr = validateSchedule();
    if (schedErr) {
      setErrorMessage(schedErr.message);
      if (schedErr.field === "days") daysWrapEl.current?.querySelector<HTMLButtonElement>("button")?.focus();
      else if (schedErr.field === "interval") intervalEl.current?.focus();
      else if (schedErr.field === "date") dateEl.current?.focus();
      return;
    }
    if (!routineDirty) return;
    setErrorMessage("");
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        name: nameTrimmed || null,
        prompt,
      };
      if (!isEdit || scheduleDirty) Object.assign(payload, schedulePayload());
      // Editing the date of a completed one-time task is an explicit reschedule.
      // Reactivate it in the same save instead of requiring a second toggle.
      if (isEdit && routine?.completedAt && scheduleDirty) payload.enabled = true;
      if (isEdit && routine) {
        await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "PATCH", body: JSON.stringify(payload) });
      } else {
        await api("/api/me/routines", { method: "POST", body: JSON.stringify(payload) });
      }
      try {
        await loadRoutinesData();
      } catch (err) {
        setBusy(false);
        handlers.current.onClose?.();
        notify(`예약 작업은 저장했지만 목록 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
        return;
      }
      setBusy(false);
      handlers.current.onSaved?.();
      handlers.current.onClose?.();
      notify(isEdit ? "예약 작업을 수정했습니다." : "예약 작업을 추가했습니다.", "ok");
    } catch (err) {
      setErrorMessage((err as Error).message || "저장에 실패했습니다.");
      setBusy(false);
    }
  }

  async function runNowClick(): Promise<void> {
    if (!routine) return;
    setBusy(true);
    try {
      handlers.current.onRunNow?.({ routine });
      setBusy(false);
      handlers.current.onClose?.();
    } catch (err) {
      notify(`예약 작업 실행 실패: ${(err as Error).message}`);
      setBusy(false);
    }
  }

  async function deleteClick(): Promise<void> {
    if (!routine) return;
    if (!(await confirmAction("이 예약 작업을 삭제할까요? 지난 실행 결과 기록은 더 이상 표시되지 않습니다."))) return;
    setBusy(true);
    try {
      await api(`/api/me/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
      setBusy(false);
      handlers.current.onDeleted?.({ routine });
      handlers.current.onClose?.();
      notify("예약 작업을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`삭제 실패: ${(err as Error).message}`);
      setBusy(false);
    }
  }

  return (
    <Modal
      cardClass="routine-modal-card"
      ariaLabelledby="routine-modal-title"
      ariaDescribedby={descId}
      closeOnBackdrop={false}
      closeDisabled={busy}
      onClose={requestClose}
    >
      <h2 id="routine-modal-title">{isEdit ? "예약 작업 편집" : "예약 작업 추가"}</h2>
      <p className="sr-only" id={descId}>
        예약 작업 이름, 작업 프롬프트, 실행 날짜 또는 반복 주기를 설정합니다. 저장 중에는 닫을 수 없습니다.
      </p>
      <form
        className="routine-modal-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>이름 (선택)</span>{" "}
          <input
            type="text"
            placeholder="예: 아침 서비스 점검"
            aria-label="예약 작업 이름"
            disabled={busy}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>

        <label className="field">
          <span>작업 프롬프트</span>{" "}
          <textarea
            rows={4}
            placeholder="예: 오늘의 서비스 상태를 요약해줘"
            aria-label="작업 프롬프트"
            aria-describedby={fieldDescribedBy}
            aria-invalid={promptInvalid ? "true" : undefined}
            disabled={busy}
            ref={promptEl}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              setPromptInvalid(false);
              setErrorMessage((message) => (message === "작업 프롬프트를 입력해 주세요." ? "" : message));
            }}
          ></textarea>
        </label>

        {/* Markdown preview only exists once there's markdown to preview, and stays
            folded: an always-open empty box doubled the modal's height for nothing. */}
        {promptTrimmed ? (
          <details className="routine-preview-wrap">
            <summary className="routine-preview-head">미리보기</summary>
            <RoutineMarkdown className="routine-prompt-preview md" source={prompt} />
          </details>
        ) : null}

        <div className="schedule-builder">
          <div className="schedule-row kinds">
            <span className="schedule-label" id="routine-kind-label">
              실행 방식
            </span>{" "}
            <div className="schedule-kinds seg-control" role="radiogroup" aria-labelledby="routine-kind-label">
              {SCHEDULE_KINDS.map((k, index) => {
                const on = scheduleKind === k.id;
                return (
                  <button
                    key={index}
                    id={`routine-kind-${k.id}`}
                    className={cx("seg-btn", on && "active")}
                    type="button"
                    role="radio"
                    aria-checked={on ? "true" : "false"}
                    tabIndex={on ? 0 : -1}
                    disabled={busy}
                    onClick={() => pickKind(k.id)}
                    onKeyDown={(event) => onKindKeydown(event, k.id)}
                  >
                    {k.label}
                  </button>
                );
              })}
            </div>
          </div>

          {scheduleKind === "once" && (
            <div className="schedule-row">
              <span className="schedule-label">실행 날짜</span>{" "}
              <input
                type="date"
                min={todayKst}
                aria-label="실행 날짜"
                aria-describedby={fieldDescribedBy}
                aria-invalid={dateInvalid ? "true" : undefined}
                disabled={busy}
                ref={dateEl}
                value={runDate}
                onChange={(event) => {
                  setRunDate(event.currentTarget.value);
                  clearDateError();
                }}
              />
            </div>
          )}

          {scheduleKind !== "interval" && (
            <div className="schedule-row">
              <span className="schedule-label">시각</span>{" "}
              <input
                type="time"
                aria-label="실행 시각"
                disabled={busy}
                value={time}
                onChange={(event) => {
                  setTime(event.currentTarget.value);
                  clearTimeError();
                }}
              />
            </div>
          )}

          {scheduleKind === "weekly" && (
            <div className="schedule-row">
              <span className="schedule-label">요일</span>{" "}
              {/* The carried-over CSS keys its error border off [aria-invalid="true"]. */}
              <div
                className="weekday-chips"
                role="group"
                aria-label="반복 요일"
                aria-describedby={fieldDescribedBy}
                aria-invalid={daysInvalid ? "true" : undefined}
                ref={daysWrapEl}
              >
                {WEEKDAY_NAMES.map((label, idx) => {
                  const on = dayList.includes(idx);
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`weekday-chip ${on ? "selected" : ""}`}
                      aria-label={label}
                      aria-pressed={on ? "true" : "false"}
                      disabled={busy}
                      onClick={() => toggleDay(idx)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {scheduleKind === "interval" && (
            <div className="schedule-row">
              <span className="schedule-label">반복 간격</span>{" "}
              <div className="interval-inputs">
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="narrow"
                  aria-label="반복 간격 값"
                  aria-describedby={fieldDescribedBy}
                  aria-invalid={intervalInvalid ? "true" : undefined}
                  disabled={busy}
                  ref={intervalEl}
                  value={intervalValue}
                  onChange={(event) => {
                    setIntervalValue(event.currentTarget.value);
                    clearIntervalError();
                  }}
                />{" "}
                <select
                  className="narrow"
                  aria-label="반복 간격 단위"
                  disabled={busy}
                  value={intervalUnit}
                  onChange={(event) => {
                    setIntervalUnit(event.currentTarget.value as "hour" | "minute");
                    clearIntervalError();
                  }}
                >
                  <option value="hour">시간</option>
                  <option value="minute">분</option>
                </select>
              </div>
            </div>
          )}

          {schedulePreview ? (
            <p className="schedule-echo">
              이렇게 실행돼요 — <strong>{schedulePreview}</strong>
            </p>
          ) : null}
        </div>

        {errorMessage ? (
          <div className="error" id={errorId} role="alert">
            {errorMessage}
          </div>
        ) : null}

        <div
          className={cx(
            "routine-form-status",
            !busy && (!promptTrimmed || !scheduleReady) && "invalid",
            !busy && routineDirty && Boolean(promptTrimmed) && scheduleReady && "dirty",
          )}
          id={statusId}
          role="status"
        >
          {routineStatus}
        </div>

        <div className="routine-modal-actions">
          <div className="routine-modal-actions-left">
            {isEdit && (
              <>
                {!routine?.completedAt && (
                  <button className="ghost-sm" type="button" disabled={busy} onClick={() => void runNowClick()}>
                    지금 실행
                  </button>
                )}{" "}
                <button className="ghost-sm danger" type="button" disabled={busy} onClick={() => void deleteClick()}>
                  삭제
                </button>
              </>
            )}
          </div>
          <div className="routine-modal-actions-right">
            <button className="ghost-sm" type="button" disabled={busy} onClick={requestClose}>
              닫기
            </button>{" "}
            <button className="primary" type="submit" disabled={!routineCanSave}>
              {saveButtonLabel}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
