# External avatar task API (외부 작업 API)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The personal Bearer-key surface that lets an EXTERNAL SYSTEM run the owner's MAIN avatar: schema,
> the auth boundary, the queue/dispatcher, the provenance stamp, and every prune. The integrator-facing
> Korean guide is [`../avatar-task-api.md`](../avatar-task-api.md) — this page is the mechanics behind it.

## What it is
An external system POSTs `{message, conversationId?}` with a personal `noah_…` Bearer key; the server
stores an `avatar_tasks` row and answers **202** immediately. A 1-second dispatcher later runs the
owner's own avatar through the SAME `executeChatTurn` an interactive chat uses. **It creates no
routine and no new run kind** — a task row is bookkeeping over a full owner run, the same shape
`bot_tasks` has for 내 봇.

Files: `src/server/routes/avatarTasks.ts` (HTTP, both halves), `src/server/avatarTaskRunner.ts`
(dispatcher + run), `src/server/store/avatarTasks.ts` (store mixin), `src/shared/avatarTasks.ts`
(the wire types both sides import), `src/client/src/components/SettingsAvatarApiKeys.svelte`
(내 아바타 → 권한·연결 → 외부 작업 API).

## Tables (`store/internal.ts` `migrate()`, plain `CREATE TABLE IF NOT EXISTS`)
```
avatar_api_keys(id PK, owner_user_id, name, prefix, token_hash UNIQUE, created_at, last_used_at)
  INDEX avatar_api_keys_owner (owner_user_id)
avatar_tasks(id PK, owner_user_id, api_key_id, conversation_id, message, status,
             run_id, result_json, error, idempotency_key, fingerprint,
             user_message_persisted INTEGER NOT NULL DEFAULT 0, created_at, updated_at,
             UNIQUE(owner_user_id, idempotency_key))
  INDEX avatar_tasks_queue (status, created_at)   -- the dispatcher's scan
  INDEX avatar_tasks_owner (owner_user_id, created_at)  -- list//:id reads
  INDEX avatar_tasks_owner_status (owner_user_id, status)  -- the accept-time outstanding COUNT
```
- **`UNIQUE(owner_user_id, idempotency_key)` is scoped per OWNER, not per key.** Two of the owner's
  own keys sharing an `Idempotency-Key` collide on purpose — the replay is the OWNER's task, and
  every read/respond/cancel route already accepts any of that owner's live keys.
- `fingerprint = hashToken(JSON.stringify({message, conversationId}))`: an identical replay returns
  the stored row with **200**, a different body under the same key throws `idempotency_conflict`
  → **409**.
- `result_json` holds the turn's final response object; `decode()` parses it and coerces
  `user_message_persisted` to a boolean on every read.
- SQLite `NULL`s are distinct in a UNIQUE index, so a task with no `Idempotency-Key` never collides.

## Key format and hashing
`noah_` + `crypto.randomBytes(32).toString("base64url")` (43 chars) — the auth regex
`/^noah_[A-Za-z0-9_-]{43}$/` rejects a malformed token BEFORE any DB work. Only
`hashToken(token)` (SHA-256, shared with session tokens in `auth.ts`) is stored; the plaintext is
returned exactly once by `POST /api/me/avatar-api-keys` and never again. `prefix = token.slice(0, 13)`
is the display handle in settings ("noah_xxxxxxxx…"). Cap **10 keys per user**, enforced in the store
AND the route (the route answers 409 with the Korean message; the store throw is the backstop).
`last_used_at` is refreshed on authentication **at most once per minute**
(`… WHERE id = ? AND (last_used_at IS NULL OR last_used_at < <now-60s>)`) — status polling is the
normal traffic shape, and an unthrottled stamp would turn every GET into a write transaction on the
shared SQLite file.

## Auth boundary — two routers in one file, on purpose
`createAvatarTasksRouter` mounts BOTH halves so the split is visible in one place:
- **Key management** (`GET/POST /api/me/avatar-api-keys`, `DELETE /api/me/avatar-api-keys/:id`) is
  `requireAuth(store)` — **session cookie only**. A `noah_` key is never accepted here, so a leaked
  key cannot mint more keys or read the roster.
- **Task API** (`/api/v1/avatar/tasks…`) is a child `Router` whose `use()` middleware accepts ONLY
  `Authorization: Bearer <token>` → `store.authenticateAvatarApiKey`. It does not fall back to the
  session, and no session/admin route anywhere else consults an avatar API key. The join in
  `authenticateAvatarApiKey` fails closed on a suspended owner.
- Every response on both halves sets `Cache-Control: no-store`.
- `conversationId` is validated with the shared `isSafePathId` (`routes/_shared.ts`); a BLANK
  `Idempotency-Key` header counts as absent (`||`, not `??`), and `/respond`'s `value` cap is measured in
  UTF-8 bytes like `message`.
- `/:id` resolution is its own `use()` layer: a miss is a plain 404 with **no existence probe**
  (the same shape as the bot-task routes), and the resolved row rides `res.locals.avatarTask`.

## Status machine
Stored (`AvatarTaskStatus`): `queued` → `running` → `succeeded` | `failed` | `cancelled`.
- **`waiting_input` is PRESENTATION ONLY** and never lands in the DB — the wire type is
  `AvatarTaskPresentedStatus` (`src/shared/avatarTasks.ts`), which `present()` returns so a client
  switching on the shared union has the branch. `present()` overlays it when
  `getRunPrompts(runId, ownerUserId)` returns anything, and ships those prompts as `pendingRequests`.
  The journal lives in the in-memory run registry, so prompts die with the process — a restarted
  server reports the row's stored status again.
- `present()` also strips `apiKeyId`, `ownerUserId` and `userMessagePersisted` from the wire shape.
  Keep new internal columns out of it by the same rule: the external caller sees the task, not the
  bookkeeping.
- **`updateAvatarTask` only touches rows still `queued`/`running`** (`AND status IN ('queued','running')`
  in the UPDATE). A terminal row is immutable, so a late finalize racing a cancel is an atomic no-op
  rather than a resurrection. `COALESCE` on `run_id`/`result_json`/`user_message_persisted` means
  omitting an option preserves the stored value; `error` is written unconditionally (passing no error
  CLEARS it).
- The chat turn's own terminal event decides the outcome, not the HTTP acceptance: `executeChatTurn`
  returns `ok` even after persisting an SDK failure, so `runTask` reads `done` / `error` / `cancelled`
  off `hooks.onEvent` and defaults to `failed` ("작업이 결과 없이 종료되었습니다") when nothing terminal arrives.
- **A background phase does NOT end the task.** When the turn hands work to background tasks or
  subagents, `chat.ts` emits `done` EARLY with `background: true` and a placeholder text
  ("백그라운드 작업을 진행 중입니다."), then a `bg_message` per wake-up report, and closes the phase with
  **`bg_end`, not a second `done`**. So the row stays `running` until `bg_end`, and the stored
  `result.text` is the initial reply followed by every background report joined with blank lines,
  with `result.summary` taken from the LAST report. The placeholder itself
  (`BACKGROUND_TURN_PLACEHOLDER`, exported by `routes/chat.ts`) is filtered out of the aggregate, so a
  phase whose visible segment streamed nothing reads as the reports alone. Treating that first `done`
  as terminal is the bug this rule exists to prevent — the placeholder must never be a task's final
  result.

## Dispatcher (`avatarTaskRunner.ts`)
`startAvatarTaskDispatcher(services)` runs `recoverAvatarTasks()` once, then ticks every **1 s**
(`timer.unref()`); `index.ts` starts it beside the routine scheduler and the bot-task dispatcher, and
calls the returned stop function during shutdown. Per-service state (`owners: Set`, `stopped`) hangs
off a `WeakMap` keyed by `AppServices`, so a test's second app never shares a queue with the first.
- **Concurrency: one run per OWNER, four process-wide.** The scan reads `queuedAvatarTasks()` — a
  PROJECTION (`id, ownerUserId, conversationId`, oldest first, `LIMIT 200`); the full row with the
  message is read back only AFTER a successful claim, so a deep queue never loads every instruction
  per tick (a row beyond the 200 is simply picked up on a later tick; its backoff ladder may reset
  meanwhile, which is accepted). It skips an owner already running and any task whose conversation has an active run
  (`getActiveRunForConversation`), then `claimAvatarTask` flips `queued`→`running` with a guarded
  UPDATE — the claim is what makes two ticks safe.
- **Re-validation happens at DISPATCH, not at accept**: owner still exists, key still active
  (`avatarTaskKeyActive`), conversation still the owner's own avatar thread, `resolveChatTarget`
  still resolves. Any miss records `failed` with a Korean reason, and the two misses that leave a
  never-used thread behind (revoked key / unusable account, and a `resolveChatTarget` refusal) also
  call `pruneGhostThread`.
- **409 re-queue with backoff.** `executeChatTurn` refusing with status 409 (the thread or the
  knowledge repo is busy) puts the row back to `queued` rather than failing it, carrying
  `userMessagePersisted` forward so the retry never double-writes the user bubble. The next attempt
  waits `Math.min(60_000, 5_000 * 2 ** attempts)` — **5 s doubling to a 60 s ceiling** — held in
  `state.retry` (a per-task-id `Map`, in memory only: a restart reaps every running row, so the ladder
  resetting is correct). The tick sweeps entries whose id left the queue, and an in-flight task's
  attempt count rides its `runTask` closure so the sweep cannot lose it. `dispatchAvatarTasks(services,
  now)` takes the clock as a TEST SEAM — the backoff is wall-clock, so tests advance `now` instead of
  sleeping. The ladder is bounded: after **60 re-queues** the task stops retrying and is recorded
  `failed` with the busy reason, so a permanently occupied thread cannot leave a row queued forever.
- The tick short-circuits before the queue query when the dispatcher is stopped or already saturated
  (`state.owners.size >= 4`).
- **The claimed-but-unopened window is cancellable.** Between `claimAvatarTask` and
  `hooks.onRunOpen`, the row reads `running` with `runId` null and there is no registry run to
  `cancelRun`. The cancel route writes the terminal row anyway (its `task.status === "running" &&
  !task.runId` branch), and `onRunOpen` RE-READS the row: anything other than `running` sets
  `abandoned` and returns false, which closes the run and makes the runner touch nothing afterwards.
  In that window the instruction bubble is already in the conversation with no reply — accepted, and
  the same shape an interactive stop before the first token leaves behind.
- **Owner composer defaults seed a server-minted thread.** A conversation the API created has no
  `selected_*`, so `runTask` passes `requestedModel`/`requestedEffort`/`requestedMcpToolGroups` from the
  owner's `model_default`/`effort_default`/`mcp_tool_groups_default` columns — but ONLY for a selection
  the conversation does not already store (a per-conversation choice always wins). `executeChatTurn`
  persists a non-null request onto the conversation, so this fires once per thread, exactly like a
  first interactive turn.
- **Unattended-run behavior**: `unattendedDeadlineMs = config.avatarTaskRunTimeoutMs`
  (`AVATAR_TASK_TIMEOUT_MINUTES`, default 300 = 5 hours, 1-minute floor, capped at setTimeout's
  ~24.8-day maximum) covers the WHOLE turn including time parked on a question and the background
  phase up to `bg_end`. It is the API's OWN knob, split from `BOT_TASK_TIMEOUT_MINUTES` (still 30) on
  purpose: a bot routine run holds one of the routine scheduler's slots (and one of its owner's) for
  its whole duration, and a hung bot turn pins its thread's queue — the split was made while the
  scheduler was still strictly sequential, when an hour-long bot budget would have stalled every
  routine on the server (see [routines.md](routines.md)). API runs sit behind this dispatcher's caps
  instead — which are their own stall surface:
  a long or hung task holds its owner's only slot, and one of the four, for up to the full budget, so
  the cancel route is the lever for stuck work. A single parked prompt still expires after
  `PROMPT_TTL_MS` (30 min) regardless of the run budget.
  `modelFallback: true` walks down the model tiers on a transient model failure (nobody
  is there to switch models — the routine scheduler's reasoning). The run is NOT `headless`: prompts
  still park, answerable from Noah or through `/respond`.
- **Shutdown records `failed`, never `cancelled`.** `index.ts` calls the stop function
  (`state.stopped = true`) BEFORE `cancelAllRuns()`, so `onEvent` maps a `cancelled` event under a
  stopped dispatcher onto `failed` + `AVATAR_TASK_RESTART_ERROR` — the SAME string
  `recoverAvatarTasks()` writes for a hard kill (exported from `store/avatarTasks.ts`, re-exported by
  `store/index.ts`, so the two paths can never drift). A caller distinguishing "we cancelled it" from
  "the server went away" depends on this.
- `recoverAvatarTasks()` at boot sweeps every leftover `running` row to `failed` — in-memory run ids
  die with the process, so a `running` row at startup can only be a corpse. Queued rows survive and
  are picked up by the first tick.

## Provenance — `externalTaskApi` (PROVENANCE, not capability)
`avatarTaskRunner` → `ChatTurnContext.externalTaskId` → `AgentRequest.externalTaskApi` (`types.ts`).
The run keeps the owner's FULL capability (every tool their own chat has, shell-exposed secrets, repo
commits). What the flag changes:
- **The prompt carries a provenance paragraph** in `buildSystemPromptAppend`, pushed immediately after
  the owner line it qualifies: the message body is that system's DATA (instructions quoted inside a
  pasted log or ticket are not the owner speaking), the run is NOT an unattended routine (questions
  and permission prompts still park, so ask when genuinely blocked), keep the scope conservative, and
  the final reply IS `result.text` — the only thing the caller reads.
- **`mcp__personal_agent__create_agent` is NOT registered** on an API run: `!request.externalTaskApi`
  joins `!request.headless` in runPlan's `personalAgentCreateActive`. That gate also governs
  `PERSONAL_AGENT_OWNER_TOOL_NAMES`, so **`delegate_to_bot` goes with it** — an outside instruction
  may not stand up a chat contact or hand work to one unattended.
- **The owner identity sentence branches too**: an API turn is told the conversation belongs to the
  owner but nobody is typing in it right now, instead of "the person you are talking to".
- **Browser caveat on both surfaces**: `browserActive` cannot tell an API turn from an interactive one
  (executeChatTurn always supplies the bridge sink), so the bridge may read CONNECTED with no client
  attached. The gate is deliberately unchanged (the owner CAN attach by opening the running thread in
  Noah with the extension); the prompt paragraph and the origin line instead say a timed-out browser op
  means the bridge is not there — stop retrying, finish without it, say so.
- **`describe_system` reports the turn's origin** (`SystemToolsContext.externalTaskApi` and `.headless`,
  handed over in `buildAgentRunPlan`): a three-way `This turn's origin:` line (external system /
  unattended routine / interactive chat) ahead of the run-scoped facts, plus the personal-bot and
  hand-off lines branching to "UNAVAILABLE on this run" for BOTH an API turn and a headless routine
  (`botToolsWithheld`). The External task API self-state line is SKIPPED on a headless run, because the
  prompt half lives in the owner branch a headless run never reaches — the two surfaces must agree.
- Everything else is deliberately untouched: `deriveAgentToolAccess` / `planMcpToolFamilies` never
  read the flag, and `request.avatar` is the owner's own row (this is not a new avatar kind).

## Metacognition (both surfaces, from one fact)
`OwnerState.avatarApiKeyCount` (`agent/ownerState.ts`, eager like its neighbours — the list is capped
per owner, so one read beats a getter that re-queried on every access and hid itself from `{...state}`
spreads) is stamped onto the request in `claudeAgent.ts` for owner, non-group-agent runs only, and
read by BOTH `promptBuilder.ts`'s standing paragraph and `systemTools.ts`'s `describe_system` line
(the per-turn half — whether THIS turn arrived that way — is the provenance section above). Both name
the settings path (내 아바타 → 권한·연결 → 외부 작업 API), state that the API is independent of scheduled
routines, and end with **never ask the owner to paste an API key into chat**. Add a new fact to both
or neither.

The run budget is the second fact, and it is CONFIG, not store: `runClaudeAgent` stamps
`config.avatarTaskRunTimeoutMs` as `AgentRequest.avatarTaskRunTimeoutMs` under the same owner,
non-group-agent gate, and `describe_system` reads `ctx.config.avatarTaskRunTimeoutMs` directly, so
both state the operator's `AVATAR_TASK_TIMEOUT_MINUTES`, never the default. The standing line says how
long ANY task may run (inserted before the routines sentence, so it still ends on the key warning); an
API run additionally hears THIS run's budget in the provenance paragraph / the `This turn's origin:`
line: overrun fails the task (the caller gets an error, not `result.text`, and only the partial output
stays in the thread), so scope the work to fit and say what remains. Both also state the separate
per-prompt expiry, from the imported `PROMPT_TTL_MS`, never a literal. The `external-tasks` manual
keeps only the default plus a pointer to describe_system: `read_manual` must never read config
(`tests/system-manual.test.ts` proxies it to throw).

## Audit
`avatar_api_key_create` / `avatar_api_key_revoke` (session routes, via `auditAs`),
`avatar_api_task_accept` (written once at accept, skipped on an idempotent replay, detail
`task <id>, key <id>`), and `avatar_api_task` (the run itself). The runner's `audit` hook RENAMES only
the turn's own `chat` action (`entry.action === "chat" ? "avatar_api_task" : entry.action`) and
prefixes every detail with `task <id>: `, so a tool the run uses keeps its OWN action name
(`browser_<op>` and friends) — the task action never swallows them. `AUDIT_ACTION_LABELS` in
`views/AdminView.svelte` carries the Korean labels; an unlabeled id still renders as its raw string.

## Prunes and cascades
- **Deleting the conversation deletes its tasks** (`store/conversations.ts`, both the single and bulk
  paths, same arm as `bot_tasks` — neither table has an FK onto `conversations`): finished tasks
  disappear from `GET /api/v1/avatar/tasks` and queued ones are dropped instead of running. The delete
  is NOT refused mid-run: the route cancels the thread's active run FIRST (lifecycle-03), so the
  cancel path skips a now-impossible message persist instead of racing the row deletion, and the
  runner's own late `update` lands on a vanished row as a no-op.
- **A task that never reaches a chat turn takes its empty conversation with it** —
  `deleteConversationIfEmpty(ownerId, conversationId)` deletes only a thread with NO messages, and is
  called from the cancel route's `queued` branch and from the runner's pre-turn refusals (revoked key
  / unusable account, `resolveChatTarget` refusal). It ALSO refuses while another `avatar_tasks` row for
  that conversation is still `queued`/`running` (the caller's own row is already terminal), so
  cancelling one of two tasks queued on the same fresh thread never strands the other. It must never
  be called once `executeChatTurn` is
  entered: the prelude writes the instruction bubble, which is exactly why the cancel route's
  CLAIMED-window branch does not prune. A task that continued an existing `conversationId` is
  unaffected — that thread has messages.
- `deleteUser` (`store/admin.ts`) drops `avatar_tasks` then `avatar_api_keys` by `owner_user_id`.
- **No retention sweep exists yet** for finished `avatar_tasks` rows (follow-up). While a row lives,
  its `Idempotency-Key` stays reserved for that owner.

## Gotchas
- **The conversation is created at ACCEPT, not at run** (`touchConversation` inside the accept
  transaction), so a queued task is already visible in the owner's Noah conversation list with an
  empty thread. That is what the empty-conversation prune above exists to clean up.
- **The user bubble is persisted inside `executeChatTurn`, BEFORE `onRunOpen`.** `userMessagePersisted`
  is the flag that keeps a re-queue or an abandoned claim from writing it twice; anything that puts a
  row back to `queued` must carry it forward. It is also why a cancelled claim leaves an instruction
  with no reply, and why the ghost-thread prune is pre-turn only.
- `pendingRequests`/`respond`/`cancel` all go through the run registry (`getRunPrompts`,
  `submitResponse`, `cancelRun`), each scoped by `ownerUserId` — the task id alone never reaches
  another user's run.
- `respond` is a 409 for an unknown/expired `requestId`, matching the UI's own re-submit behavior.
- **Run registry changes this feature made** (`agent/runRegistry.ts`, shared by EVERY run): `openRun`
  releases parked prompts when the run's `abortController` fires (so the unattended deadline unparks a
  question), and `awaitResponse` on an already-aborted or cancelled run resolves `CANCELLED` at once
  AND emits `prompt_resolved` for that `requestId` — the frame is already in the replay journal, and
  without the resolution a viewer who attaches or replays would render a modal nothing dismisses
  (`tests/agent-run-registry.test.ts`).
- The 202 body already carries `pendingRequests: []`; callers should treat 202 as "accepted", never
  as "started".

## Tests
`tests/avatar-tasks.test.ts` (key CRUD + cap, the auth boundary both ways, accept/idempotency/rate
limits, the dispatcher's claim/concurrency/re-validation matrix, cancel incl. the claimed-window case,
respond, restart recovery, the 409 backoff/cap, the background-phase aggregate, owner defaults, and the
prune/cascade rules), `tests/agent-run-registry.test.ts` (post-abort prompts), the provenance cases in
`tests/agent-core.test.ts` / `tests/agent-run.test.ts` / `tests/agent-tools.test.ts`, and
`tests/svelte-avatar-api-keys.test.ts` (the settings card: issue, the one-time secret, the refetch on
tab re-entry, revoke).
