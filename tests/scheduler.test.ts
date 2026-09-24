import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, AgentResponse, AppConfig, RoutineJob } from "../src/server/types.js";
import { makeBareRemote, withTempDir } from "./helpers.js";

// Coverage target: src/server/scheduler.ts failure handling — the abort-cause
// substitution and the partial-output persistence. `runAgentStream` is mocked so a
// run can be made to hang until the scheduler's own deadline aborts it; the real
// local runtime returns immediately and can never reach that path.

type RunImpl = (
  request: AgentRequest,
  pluginRoots: unknown,
  config: AppConfig,
  store: unknown,
  events: AgentEvents,
  abortController?: AbortController,
) => Promise<AgentResponse>;

const H = vi.hoisted(() => ({ impl: null as RunImpl | null }));

vi.mock("../src/server/agent/index.js", () => ({
  runAgentStream: vi.fn(
    async (
      request: AgentRequest,
      pluginRoots: unknown,
      config: AppConfig,
      store: unknown,
      events: AgentEvents,
      abortController?: AbortController,
    ): Promise<AgentResponse> => {
      if (H.impl) {
        return H.impl(request, pluginRoots, config, store, events, abortController);
      }
      events.onDelta?.("ok");
      return { kind: "text", runtime: "local", summary: "mock", text: "ok" };
    },
  ),
}));

const { createServices } = await import("../src/server/app.js");
const { executeRoutineJob, isRoutineRunning, startRoutineScheduler } = await import(
  "../src/server/scheduler.js"
);
const { acquireActiveRepo, releaseActiveRepo } = await import("../src/server/activeRepoLock.js");
const { setWorkspaceRepo } = await import("../src/server/repoWorkspace.js");
const { gitRepoClonePath } = await import("../src/server/gitRepos.js");

let tempDir: string;
const getTempDir = withTempDir("scheduler", () => {
  tempDir = getTempDir();
});

/**
 * Deadline these tests configure per run. Deliberately NOT the shipped 30-minute
 * default: the timeout text must be derived from the configured value, so a test
 * that reused the default couldn't tell derivation from a hardcoded number.
 */
const RUN_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Fail the way the SDK does on abort: it labels EVERY abort as user-initiated, and it
 * checks `signal.aborted` up front rather than only listening — the deadline can fire
 * before the run is even entered, so a listen-only mock would hang forever.
 */
function failOnAbort(abortController?: AbortController): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error("Claude Code process aborted by user"));
    if (abortController?.signal.aborted) {
      fail();
      return;
    }
    abortController?.signal.addEventListener("abort", fail);
  });
}

function boot(label: string) {
  const services = createServices({
    dataDir: path.join(tempDir, label),
    agentRuntime: "claude",
    sessionSecret: "t",
    routineRunTimeoutMs: RUN_TIMEOUT_MS,
  });
  const owner = services.store.createUser({
    username: "owner",
    displayName: "Owner",
    password: "password123",
  });
  const job = services.store.createRoutineJob(owner.id, { prompt: "일일 점검", minuteOfDay: 0 });
  return { services, owner, job };
}

beforeEach(() => {
  H.impl = null;
});

describe("routine failure handling", () => {
  it("reports the run timeout instead of the SDK's 'aborted by user' text", async () => {
    const { services, owner, job } = boot("timeout");
    // Stream something, then hang until the scheduler's deadline aborts us and fail
    // the way the SDK does: it labels EVERY abort as user-initiated.
    H.impl = async (_req, _roots, _cfg, _store, events, abortController) => {
      events.onDelta?.("점검 1단계 완료");
      return failOnAbort(abortController);
    };

    vi.useFakeTimers();
    try {
      const pending = executeRoutineJob(services, job);
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(result.error).toContain("실행 제한 시간(3분)");
      expect(result.error).not.toContain("aborted by user");

      // The stored lastError (rendered verbatim in RoutinesView) says the same.
      const after = services.store.listRoutineJobs(owner.id)[0];
      expect(after.lastStatus).toBe("error");
      expect(after.lastError).toContain("실행 제한 시간(3분)");
      expect(after.lastError).not.toContain("aborted by user");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the partial output in the routine thread alongside the cause", async () => {
    const { services, owner, job } = boot("partial");
    H.impl = async (_req, _roots, _cfg, _store, events, abortController) => {
      events.onDelta?.("1단계: 저장소 동기화 완료");
      events.onDelta?.("\n2단계: 테스트 실행 중");
      return failOnAbort(abortController);
    };

    vi.useFakeTimers();
    try {
      const pending = executeRoutineJob(services, job);
      await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    // Before this, a failed run wrote NOTHING to its thread — the only trace was a
    // one-line lastError, so there was no way to see how far it got.
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("일일 점검");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toContain("1단계: 저장소 동기화 완료");
    expect(messages[1].content).toContain("2단계: 테스트 실행 중");
    expect(messages[1].content).toContain("실행 제한 시간(3분)");
  });

  it("records a non-timeout failure with its own message, not the timeout text", async () => {
    const { services, owner, job } = boot("othererror");
    H.impl = async (_req, _roots, _cfg, _store, events) => {
      events.onDelta?.("부분 출력");
      throw new Error("Bad Request: model not found");
    };

    const result = await executeRoutineJob(services, job);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "예약 작업 실행에 실패했습니다: Bad Request: model not found",
    );
    expect(result.error).not.toContain("실행 제한 시간");

    // The partial is still kept, with the real cause appended.
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages[1].content).toBe(
      "부분 출력\n\n예약 작업 실행에 실패했습니다: Bad Request: model not found",
    );
    expect(services.store.listRoutineJobs(owner.id)[0].lastError).toBe(
      "예약 작업 실행에 실패했습니다: Bad Request: model not found",
    );
  });

  it("persists the cause alone when the run produced no output", async () => {
    const { services, owner, job } = boot("nopartial");
    H.impl = async () => {
      throw new Error("boom");
    };

    await executeRoutineJob(services, job);

    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("예약 작업 실행에 실패했습니다: boom");
  });

  it("still records a successful run the normal way", async () => {
    const { services, owner, job } = boot("success");

    const result = await executeRoutineJob(services, job);

    expect(result.ok).toBe(true);
    const messages = services.store.listMessages(owner.id, job.conversationId);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toBe("ok");
    expect(services.store.listRoutineJobs(owner.id)[0].lastStatus).toBe("success");
  });
});

// Above the 5 s default test timeout, so a slow WAIT never outlives its test.
describe("routine scheduler concurrency", { timeout: 20_000 }, () => {
  type Services = ReturnType<typeof boot>["services"];
  const OK: AgentResponse = { kind: "text", runtime: "local", summary: "mock", text: "ok" };
  // Runs go through real plugin loading, which can outlast waitFor's 1 s default
  // while the full suite is running.
  const WAIT = { timeout: 5_000 };

  /** Hold every run open until released, recording which routine thread it serves. */
  function holdRuns() {
    const started: string[] = [];
    const waiting: Array<() => void> = [];
    H.impl = async (request) => {
      started.push(request.conversationId ?? "");
      await new Promise<void>((resolve) => waiting.push(resolve));
      return OK;
    };
    return {
      started,
      releaseOne: () => waiting.shift()?.(),
      releaseAll: () => waiting.splice(0).forEach((release) => release()),
    };
  }

  /**
   * Serve `jobs` as due until each has recorded an outcome — a fresh job's real
   * next_run_at is in the future, and a finished one must stop being due.
   */
  function dueUntilRun(services: Services, jobs: RoutineJob[]) {
    vi.spyOn(services.store, "listDueRoutineJobs").mockImplementation(() =>
      jobs.filter((job) => !services.store.getRoutineJob(job.avatarUserId, job.id)?.lastRunAt),
    );
  }

  function addOwner(services: Services, username: string) {
    const user = services.store.createUser({ username, displayName: username, password: "password123" });
    return services.store.createRoutineJob(user.id, { prompt: `${username} 점검`, minuteOfDay: 0 });
  }

  /** Several scheduler ticks (tickMs 20) — long enough for a job over a cap to have started if it could. */
  const severalTicks = () => new Promise((resolve) => setTimeout(resolve, 150));

  async function drain(stop: () => void, hold: ReturnType<typeof holdRuns>, jobs: RoutineJob[]) {
    stop();
    hold.releaseAll();
    await vi.waitFor(() => expect(jobs.some((job) => isRoutineRunning(job.id))).toBe(false), WAIT);
  }

  it("starts due routines of different owners in parallel", async () => {
    const { services, job } = boot("par-owners");
    const jobs = [job, addOwner(services, "owner2")];
    dueUntilRun(services, jobs);
    const hold = holdRuns();
    const stop = startRoutineScheduler(services, { tickMs: 20 });
    try {
      // The old one-at-a-time loop would not start the second until the first ended.
      await vi.waitFor(() => expect(hold.started).toHaveLength(2), WAIT);
      hold.releaseAll();
      await vi.waitFor(() => {
        for (const j of jobs) {
          expect(services.store.getRoutineJob(j.avatarUserId, j.id)?.lastStatus).toBe("success");
        }
      }, WAIT);
    } finally {
      await drain(stop, hold, jobs);
    }
  });

  it("holds one owner to the per-owner cap", async () => {
    const { services, owner, job } = boot("per-owner-cap");
    const jobs = [
      job,
      ...[1, 2].map((n) => services.store.createRoutineJob(owner.id, { prompt: `추가 점검 ${n}`, minuteOfDay: 0 })),
    ];
    dueUntilRun(services, jobs);
    const hold = holdRuns();
    const stop = startRoutineScheduler(services, { tickMs: 20 });
    try {
      await vi.waitFor(() => expect(hold.started).toHaveLength(2), WAIT); // the default per-owner cap
      await severalTicks();
      expect(hold.started).toHaveLength(2); // the third stays due instead of starting
      hold.releaseOne();
      await vi.waitFor(() => expect(hold.started).toHaveLength(3), WAIT);
    } finally {
      await drain(stop, hold, jobs);
    }
  });

  it("holds the server to the global cap", async () => {
    const { services, job } = boot("global-cap");
    services.config.routineMaxConcurrentRuns = 2;
    const jobs = [job, addOwner(services, "owner2"), addOwner(services, "owner3")];
    dueUntilRun(services, jobs);
    const hold = holdRuns();
    const stop = startRoutineScheduler(services, { tickMs: 20 });
    try {
      await vi.waitFor(() => expect(hold.started).toHaveLength(2), WAIT);
      await severalTicks();
      expect(hold.started).toHaveLength(2);
      hold.releaseOne();
      await vi.waitFor(() => expect(hold.started).toHaveLength(3), WAIT);
    } finally {
      await drain(stop, hold, jobs);
    }
  });

  it("never refuses a manual run over the caps, but counts it against its owner", async () => {
    const { services, owner, job } = boot("manual-slot");
    services.config.routineMaxConcurrentRunsPerUser = 1;
    const scheduled = services.store.createRoutineJob(owner.id, { prompt: "예약된 점검", minuteOfDay: 0 });
    const jobs = [job, scheduled];
    dueUntilRun(services, [scheduled]);
    const hold = holdRuns();
    // "지금 실행" takes the owner's only slot...
    const manual = executeRoutineJob(services, job);
    await vi.waitFor(() => expect(hold.started).toEqual([job.conversationId]), WAIT);
    const stop = startRoutineScheduler(services, { tickMs: 20 });
    try {
      // ...so the due routine waits instead of joining it.
      await severalTicks();
      expect(hold.started).toEqual([job.conversationId]);
      // A second manual run is not refused by the full cap either.
      const manualScheduled = executeRoutineJob(services, scheduled);
      await vi.waitFor(() => expect(hold.started).toEqual([job.conversationId, scheduled.conversationId]), WAIT);
      hold.releaseAll();
      await expect(manual).resolves.toEqual({ ok: true });
      await expect(manualScheduled).resolves.toEqual({ ok: true });
    } finally {
      await drain(stop, hold, jobs);
    }
  });

  it("skips a routine whose working repo is open elsewhere, then runs it once the repo frees", async () => {
    const { services, owner, job } = boot("repo-locked");
    const remote = makeBareRemote(path.join(tempDir, "repo-locked-remote.git"));
    services.store.upsertGitRepo(owner.id, "app", remote, "main");
    setWorkspaceRepo(services.store, job.conversationId, "app");
    const clonePath = gitRepoClonePath(owner.id, "app", services.config);
    expect(acquireActiveRepo(clonePath, "another-conversation")).toBe(true);
    const started: string[] = [];
    H.impl = async (request) => {
      started.push(request.conversationId ?? "");
      return OK;
    };
    try {
      const skipped = await executeRoutineJob(services, job);
      expect(skipped).toMatchObject({ ok: false, skipped: true });
      expect(skipped.error).toContain("작업 저장소");
      // It did NOT run in the scratch dir instead, and recorded nothing, so the
      // job stays due and the next tick retries it.
      expect(started).toHaveLength(0);
      expect(services.store.listMessages(owner.id, job.conversationId)).toHaveLength(0);
      expect(services.store.getRoutineJob(owner.id, job.id)?.lastRunAt).toBeNull();
    } finally {
      releaseActiveRepo(clonePath, "another-conversation");
    }
    await expect(executeRoutineJob(services, job)).resolves.toEqual({ ok: true });
    expect(started).toEqual([job.conversationId]);
  });
});
