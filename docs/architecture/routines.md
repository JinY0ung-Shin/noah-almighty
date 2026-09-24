# Routines (scheduled runs)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The scheduler tick, job model, and how a routine run differs from a chat turn.
> 봇 루틴 (`personal_agent_id` set) does NOT take the headless path below — it fires as a
> scheduled DELEGATED TASK through `executeChatTurn`/the bot-task queue; mechanics live in
> [personal-agents.md](personal-agents.md) §봇 루틴. Everything on this page describes the
> legacy main-avatar path, which a NULL `personal_agent_id` keeps byte-identical.

## Routines
- A routine (`routine_jobs` table, `get/list/create/update/deleteRoutineJob`, `markRoutineRun`) runs its
  `prompt` headlessly with owner-level tools and appends results to a dedicated conversation
  (`[예약 작업] <name|prompt>` title; legacy rows may retain `[루틴]`). Schedule kinds (`src/server/routineSchedule.ts`, the ONE place for all
  schedule math + validation): **once** (`runDate` YYYY-MM-DD KST + `minuteOfDay`; disabled with
  `completedAt` after its single attempt), **daily** (`minuteOfDay` KST), **weekly** (`daysOfWeek`
  0=Sun..6=Sat at `minuteOfDay`), **interval** (`intervalMinutes`, 5..10080).
  `parseRoutineSchedule` validates raw
  API/MCP input → a `RoutineSchedule` or a `ScheduleError` CODE; each caller maps the code to its own
  channel (`routes/_shared.ts` `KOREAN_SCHEDULE_ERROR`, `systemTools.ts` `ENGLISH_SCHEDULE_ERROR`).
  One-time schedules retain `run_date` separately from `next_run_at`, so disabling/completing does not
  lose the configured date; `completed_at` distinguishes completion from a manual pause.
  `nextRunIso` computes the next firing in fixed UTC+9 (no DST); a name/prompt-only `updateRoutineJob`
  edit preserves an overdue `next_run_at`, only a schedule change recomputes. `store.create/updateRoutineJob`
  stay backward-compatible with `{prompt, minuteOfDay}`. Editable by owner (UI modal: clickable title →
  name/prompt/schedule builder, `PUT/PATCH /api/me/routines`) AND by the avatar
  (`mcp__system__{create,update}_routine`). New schedule fields go in `routineSchedule.ts` + the two
  error maps + `RoutineJob` (types.ts) + the `addColumnIfMissing` migration.
- **Routines load the same skills as chat** via the shared `loadAgentPluginRoots` (plugins.ts): default
  + avatar plugins + personal & group knowledge-repo roots. Both `routes/chat.ts` and `scheduler.ts` call
  it, so they can't drift; `local` runtime returns `[]`.
- **Routines fall back down the model tier chain on transient failures.** The scheduler sets
  `AgentRequest.modelFallback: true` (routines ONLY — headless, no live stream; chat never sets it).
  `runClaudeAgent` builds a chain from the resolved model DOWN the tier order (`buildModelFallbackChain`:
  opus→sonnet→haiku; a concrete admin-override id → [id, sonnet, haiku]) and retries the next model when
  the attempt THROWS a transient model/server error (`isRetryableModelError`: overload/429/5xx/network —
  NOT `error_max_turns`/auth/bad-request, NOT on abort). An env-pinned `ANTHROPIC_MODEL` is a hard lock →
  no fallback. In-band error *results* (e.g. max_turns) don't fall back. The completed-run log carries
  `model` + `modelFellBack`.
- **A routine has a HARD wall-clock deadline (default 30 min), and it is the budget for the WHOLE run** —
  `config.routineRunTimeoutMs` (env `ROUTINE_RUN_TIMEOUT_MINUTES`, clamped to a 1-minute floor; `0` does
  NOT disable it, unlike `PLUGIN_AUTO_REFRESH_MINUTES`), armed by one `AbortController` created per run
  OUTSIDE `runClaudeAgent`. So all model-fallback attempts (opus→sonnet→haiku) plus the resume self-heal
  retry SHARE that budget; a slow first attempt starves the rest of the chain. Note the mismatch with
  `maxTurns` (default 1000) — the turn budget is far larger than the wall-clock one, so a work-heavy
  routine hits the deadline, not max_turns.
- **The deadline doubles as the max hang of the manual-run HTTP request.** `POST /api/me/routines/:id/run`
  (`routes/routines.ts`) `await`s the entire run and the "지금 실행" button awaits that fetch
  (`RoutinesView.svelte`), so the practical ceiling on `ROUTINE_RUN_TIMEOUT_MINUTES` is whatever read
  timeout a fronting reverse proxy allows — past it the button reports a network failure while the run
  keeps going server-side. Making run-now return 202 + poll is the prerequisite for a much larger value.
  Two more costs scale with the deadline: a wedged job stays un-runnable for the whole window (the
  `runningJobs` overlap guard makes the scheduler skip its ticks) while holding one of the scheduler's
  slots, and it holds the active-repo lock, which REFUSES (409) any chat opening the same clone (another
  routine skips and retries — see below).
- **The scheduler runs routines in parallel, capped** (`startRoutineScheduler`). Each 30 s tick STARTS
  due jobs without awaiting them while fewer than `config.routineMaxConcurrentRuns` (env
  `ROUTINE_MAX_CONCURRENT_RUNS`, default 10) are in flight server-wide and fewer than
  `config.routineMaxConcurrentRunsPerUser` (`ROUTINE_MAX_CONCURRENT_RUNS_PER_USER`, default 2) for the
  job's owner; a job over a cap stays due and a later tick starts it. The ledger (`runningJobs` +
  `runningPerOwner`, module-level like the overlap guard) is claimed inside `executeRoutineJob` BEFORE
  its first await — that is what lets the tick count a job it just started on its next iteration — and
  it is shared with "지금 실행": a manual run is never refused by the caps but occupies its owner's slot.
  Bot routines count too. It was strictly sequential until 2026-09 for the burst reason, which let ONE
  long run (a bot routine holds its slot for the whole delegated turn) stall every routine on the
  server; the per-owner cap is what keeps one owner with many due routines from taking every slot.
- **A routine whose working repo is locked SKIPS rather than running without it.** The owner-avatar
  path resolves the working repo FIRST (before plugin/knowledge loading, so a waiting job costs one lock
  lookup per tick, not a git fetch) and returns `skipped` on `locked`: no outcome recorded, the next
  tick retries. Other open failures still fall back to the scratch workspace. A bot routine gets the
  same skip from `executeChatTurn`'s `repo_locked` refusal reason — the turn refuses before writing any
  message or task row (the firing's `touchConversation` still bumps the thread's `updated_at` on each
  retry). The chat route itself still answers that refusal with 409.
- **A restart re-runs every routine that was mid-run — at-least-once, not exactly-once.** Owner-avatar
  routine runs are not in the run registry, so shutdown's `cancelAllRuns()` cannot reach them: the
  process exit kills them before `markRoutineRun`, `next_run_at` never advances, and each fires again
  from the start on the first tick after boot, repeating any external side effect it had already done.
  With the parallel scheduler that is up to `routineMaxConcurrentRuns` (plus manual runs) per restart
  instead of one. Recording them as failed on shutdown (the task API's `AVATAR_TASK_RESTART_ERROR`
  precedent) would make it at-most-once instead; that is a product decision, not yet taken.
- **Never surface the SDK's abort message to the owner.** The SDK labels EVERY abort
  `"Claude Code process aborted by user"` (it only checks `signal.aborted`), so storing it verbatim blamed
  a user for a run nothing but the deadline touched — routines have no cancel route and are NOT in the run
  registry, so `cancelAllRuns()` on shutdown can't reach them either; that message could ONLY have meant a
  timeout. The scheduler now tracks its own `timedOut` flag and substitutes a Korean
  `routineTimeoutMessage()` (derived from `RUN_TIMEOUT_MS` so they can't drift). When adding another abort
  trigger, give it its own flag + message rather than letting the SDK text through.
- **A failed routine persists its PARTIAL output into the thread.** The catch path accumulates `onDelta`
  into `streamedText` (the only reason routines pass an events sink at all — they still take no
  `onQuestion`/`onPermission`) and writes `partial + "\n\n" + cause` as the assistant turn, mirroring the
  chat route's cancel/error paths. Before this, a failed run wrote NOTHING to its conversation and the
  sole trace was the one-line `last_error` in the routines list. The persist is best-effort and wrapped so
  it can never mask the original failure. `response.text` is NOT usable here — it never arrives on abort.
