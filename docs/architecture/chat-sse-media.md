# Chat, SSE, and generated media

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> SSE sessions and history, image attachments, `share_file` / PPTX / draw.io delivery, and the visual canvas.

## Chat / SSE / sessions
- **Chat is SSE, and an owner turn can be driven from anywhere in the client.**
  `POST /api/chat/stream {avatarId, message, conversationId?}` streams events
  `open`(→conversationId,runId)/`delta`/`status`/`tool*`/`done`/`error`; omit `conversationId` and the
  server mints one (returned on `open`). Consume with `consumeSse(body, (event,data)=>…)`. Interactive
  prompts are answered out-of-band: `POST /api/chat/respond {runId, requestId, value}` — `value` is
  `{behavior:"allow"|"deny"}` (permission) or `{cancelled:true}`/`{result}` (question). An owner messaging
  their OWN avatar is viewerIsOwner+elevated+autoApprove, so `mcp__*` tools auto-approve with no prompt.
- **Chat keeps context across turns via SDK session *resume*, not history re-injection.** Each
  `sdk.query()` is stateless: `runClaudeAgent` passes `resume: <sessionId>` and the `init` event's
  `session_id` is persisted to `conversations.agent_session_id` (`get/setAgentSessionId`). SDK transcripts
  live under `config.agentSessionsDir` (`dataDir/agent-sessions`, pinned via `CLAUDE_CONFIG_DIR` in the SDK
  `env` option) so resume survives a restart. `greeting` (ephemeral) starts a fresh session; a rewind or
  regenerate resumes the KEPT history's recorded point instead (next bullet). SDK `cleanupPeriodDays`
  (default 30) sweeps old transcripts — conversations idle >30d resume as new.
- **Rewind ("여기서부터 다시") and regenerate share ONE plan → apply path, and cut HISTORY, never the
  world.** Editing an earlier ordinary user message (`POST /api/chat/stream {rewindFromMessageId,
  message}`) REPLACES that row and every row after it; 다시 생성 (`regenerate: true`) re-runs the LAST
  NON-STEER user row in place — its STORED text, slash commands re-expanded — and drops every row after
  it: all answer segments, steers and `bg_message` reports of that run. (The old `dropLastAssistant`
  removed only the last row, so segments resurfaced on reload and the user text reached the model twice.)
  - **Exact context via recorded resume points.** `claudeAgent.ts` fires `onResumePoint({sessionId,
    uuid})` for every MAIN-chain assistant message (local loop only — the gateway never emits one). The
    route keeps the latest per run (reset on every `onSessionId`, i.e. per attempt) and stamps it on the
    assistant rows the four SUCCESS boundaries persist (`turn_end`, background finalize, `bg_message`,
    `done`) as `messages.sdk_session_id`/`sdk_uuid` — server-only, never on `StoredMessage`. A boundary
    whose result carried an in-band error (`error_max_turns`, …) stamps NOTHING (`resumePointFor`; the
    `done` row reads the last boundary's subtype): its last assistant entry may be a tool_use with no
    result. A rewind whose
    kept history ends at such a row runs `resume` + `resumeSessionAt` + `forkSession: true` (runPlan): the
    model keeps tool calls and results up to that point, and the source transcript is never rewritten (a
    fork copies the chain with the SAME uuids into a NEW session, so every older row's point stays valid).
  - **Fallbacks.** No point (legacy, cancelled, errored or external rows; a vision re-feed — image turns
    start fresh as before) → a fresh session over the KEPT text history (`conversationHistoryForPrompt(
    plan.keep)`). A point the CLI can no longer find (`No message found with message.uuid of: …` — a deep
    pre-compaction target; one inside compaction's preserved tail still resolves) or a swept transcript
    (`No conversation found …`) self-heals like a missing session: one retry without the three options,
    history injected. `resumeDropsTurn` is never used — it validates ONE dropped turn. **A result the
    attempt loop will RETRY is not a turn boundary** (`resumeSelfHealDue` / `emptyTurnRetryDue` in
    `claudeAgent.ts`): the failed-resume error result skips the whole boundary, and an empty-turn
    retry releases the held input but keeps the steer channel open — closing it there left the retry
    with 410 on every mid-turn message and no background phase. Live-verified
    2026-09-30 on CLI 2.1.283 (spike, then in-app: a value that existed only in turn 1's tool_result was
    recalled after rewinding turn 2; a corrupted point degraded to the text history).
  - **Plan early, apply late — the race rules are load-bearing.** `planTurnRewind` →
    `planConversationRewind` runs BEFORE the turn's first await (the repo resolution), with the busy checks
    (queued bot tasks, queued/running `avatar_tasks`, a running routine bound to the conversation —
    `routineRunRegistry.ts`, re-exported by scheduler.ts; the active run is the existing checks' job); every
    refusal before the apply leaves the thread untouched. The APPLY sits after the raced active-run re-check
    and immediately before `openRun`, with no await between: busy checks again, a synchronous RE-PLAN that
    refuses 409 on any drift in the kept or dropped ids (a turn that completed inside the await), then
    `applyConversationRewind` in one transaction — delete exactly the planned rows; the share links of
    dropped deck cards; `bot_tasks` created at/after the ANCHOR's created_at deleted (the anchor's run
    opened them before its first answer row existed, and a leftover `waiting_input` one would be resumed),
    and an older task a discarded turn RESUMED put back to its parked question from `bot_tasks.resume_log`
    (`rewindBotTasks`; `markBotTaskRunning` snapshots the parked state before clearing it); canvases
    rolled back to the anchor time; `agent_session_id = NULL` (crash safety — the fork's new id lands on
    success). Then the edit's replacement row (carrying the anchor's image attachments) and the disk sweep
    of the dropped rows' attachments minus the carried ids — their STAGED workspace copies included
    (`deleteStagedAttachmentCopies`: `attachments/<id>.<ext>` only, never following a link; captures and saved
    Confluence files are the dropped turns' tool side effects and stay). Replacing the FIRST message moves an
    auto-derived conversation title to the new text; a renamed title stays.
  - **`kind: "queued"`** marks a user row written while ANOTHER run was active — `queueBotTurn`'s 202
    row, a bot routine's enqueue, a bot hand-off, a plain routine's row written over a live run, and the
    row a raced 409 refusal already wrote. It sits
    BEFORE that run's answer in rowid order, so it can never anchor (400). Unmarked legacy rows are a known
    gap.
  - **Metacognition:** `AgentRequest.rewind {kind, discardedMessages}` → ONE text
    (`ownerState.rewindTurnState`) in the prompt's per-turn line and in `describe_system`: the context ends
    at the rewind point, and NOTHING the discarded turns did was undone (files, commits and pushes, browser
    actions, created routines/bots/links). The client's confirm dialog tells the user the same.
  - **`open` carries `userMessageId`** (the new row of a send or edit, the anchor of a regenerate) so the
    client can name a row sent in this very session.
  - Known v1 gaps: side effects are never undone (the discarded messages' own chat attachments and their
    share links ARE deleted — the prompt text and the confirm dialog say both); a bot task resumed before
    `resume_log` existed keeps its later status; a canvas submission that updated a version in place is not
    rolled back.
- **A streamed answer must survive completion/reload.** The live bubble shows every main-agent `delta`;
  on `done`/reload it's rebuilt from the PERSISTED `response.text`, NOT `live.text`. So `response.text`
  must be the streamed transcript (`partialText` in `claudeAgent.ts`, preferred over the SDK terminal
  `result` which is the LAST turn only) — else pre-final-turn narration vanishes the instant the run
  completes. Cancel/error paths persist the server-side `streamedText` accumulator (`routes/chat.ts`).
- **Interim narration FOLDS into the reasoning view (`text_fold`), so the answer is the LAST text block.**
  An agentic turn narrates between tool calls, which made the bubble grow enormous. When a NEW main-agent
  text block starts, every earlier block of the turn is demoted: `foldPendingText`
  (`sdkMessageHandlers.ts`, shared by `claudeAgent.ts` AND `externalAgent.ts`) fires `onTextFold(text)`
  and advances the `TextFoldState` indexes that mark where the kept tail begins. Trigger = a text delta
  arriving while completed `assistantChunks` are still unfolded (block *k*'s deltas stream BEFORE block
  *k*'s assembled text is recorded); a `keepLast` sweep at each result boundary and at run end covers
  backends that emit no deltas. The chat route's sink appends the folded text to `streamedThinking` (so it
  persists as `response.thinking` and renders in the collapsible 생각 과정 card, which renders markdown),
  advances `foldedTextOffset` (the cancel/error tails slice from `max(persistedTextOffset,
  foldedTextOffset)` so a stopped run can't resurrect folded narration), re-anchors every stamped
  attachment to 0, and emits an SSE `text_fold` frame. The client mirrors it exactly (`liveText` →
  `liveThinking`, bubble restarts, live cards re-anchored to 0); the frame rides the ordered run-event
  replay buffer, so a reconnect replays it between the two text bursts and lands on the same state.
  **Ordering is part of the contract:** both runners fold BEFORE dispatching the delta that triggered it
  (`peekMainTextDelta`), so the `text_fold` frame always precedes the new block's first `delta` frame on
  the wire — a fold emitted after that delta lets the sinks sweep the chunk into the reasoning view and
  clips the head off the kept block (live, and permanently on the cancel/error paths).
  **Gated on the sink:** with no `onTextFold` (headless routines, `POST /api/chat`) the runners fold
  nothing and keep the legacy full join — the `AgentEvents` no-sink contract. Attachment anchors are
  therefore TAIL-relative on both sides (`currentTextAnchor` slices from the fold index).
- **Native `/compact` compacts a FORK, never the conversation's own transcript.** The literal
  `/compact [what to keep]` is the whole SDK prompt (see [`agent-misc.md`](agent-misc.md) — the one native
  slash command). The run resumes the stored session with `forkSession: true` (runPlan), so the source file
  stays byte-identical and every older row's rewind point in it stays reachable: rewinding past a manual
  compaction is still exact. Live-verified 2026-09-30 on CLI 2.1.283 — a tool-only value was recalled after
  rewinding to before the compaction.
  - **The stream:** `init` → `compact_boundary` (`compact_metadata {trigger:"manual", pre_tokens,
    post_tokens}` → `CompactEvent.preTokens`/`postTokens`) → a `user` summary → a `user`
    `<local-command-stdout>` → `result:success` with NO assistant text.
  - **What the run does with it:** the chat route composes the Korean bubble from the compact event
    (`대화 맥락을 요약해 정리했습니다 (약 A → B 토큰)…` / `맥락 정리에 실패했습니다…`). Compact mode emits resume
    points for those chain entries (the last wins), because the run has no assistant message. Usage comes from
    `getContextUsage` taken after them, so the badge drops.
  - **Only a SUCCESSFUL compaction moves the conversation:** fork session id + resume point persisted, and
    cancel/error paths keep the old session.
  - **Gates:**
    - no empty-turn retry and no self-heal (a fresh session has nothing to compact);
    - no steer channel, and a `/compact` steer is refused (it would run mid-turn in the CLI);
    - refused with no SDK session yet, for external avatars, with images, as an edit's new text, on
      regenerate of a `/compact` row, and in a busy bot thread (never queued);
    - bot threads skip the bot-task bookkeeping.
  - **Rewind interplay:** an edit OF a `/compact` row into ordinary text is a normal rewind — its kept history
    ends before the compaction, in the untouched source.
- **Tool permissions go through one gate:** the `PreToolUse` hook (`buildPreToolUseHook`). `onUserDialog`
  is unused. **`canUseTool` is wired as a CONFIRMER only (`buildCanUseToolSafetyNet` + the run's
  `HookApprovalLedger`).** Measured 2026-09-27 on CLIs 2.1.185–2.1.283:
  - Without ANY permission-prompt route (the SDK adds `--permission-prompt-tool stdio` only when
    `canUseTool` is set), CLIs from 2.1.220 on (2.1.185 still offered them; no changelog entry) hide
    AskUserQuestion, EnterPlanMode and ExitPlanMode from a non-interactive session. So the question modal
    and the plan review were DEAD from v1.1.0 (SDK 0.3.220) until this confirmer existed, and the avatar
    fell back to canvas controls to ask things.
  - The CLI calls `canUseTool` only when its OWN policy still asks after the hook allowed:
    - ExitPlanMode always asks; unconfirmed, the model stays stuck in plan mode. The confirmer allows
      exactly the `tool_use_id` the hook allowed, once, recorded at the hook's single `trace()` exit.
    - CLI safety checks such as a Write to `.claude/settings.json` also ask. Approving one would really
      write the file, so the confirmer denies them, which is the pre-route outcome.
  - AskUserQuestion does not ask either: the hook ALLOWS it with the modal's answers in
    `updatedInput.answers` (question → answer, multi-select comma-joined), and the tool returns them
    as its own ordinary result ("Your questions have been answered: …"). Measured on 2.1.283: a call
    that already carries `answers` runs without consulting `canUseTool`; it is in the confirmer's set
    anyway, so a CLI that does ask gets the same answers back. The earlier carrier, a deny whose reason
    held the answer, reached the model as `PreToolUse:AskUserQuestion hook error` with `is_error` set;
    it survives only for a payload without usable answers (and a skipped question is still a deny).
    Ordinary Bash/Write and EnterPlanMode never ask.
  - SDK 0.3.283+ prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` process warning on EVERY run for this
    `canUseTool` + bare-`allowedTools` setup. It recommends a PreToolUse hook, which is already the
    gate, and its tool list is not even accurate: the ExitPlanMode and protected-path asks above still
    arrive. `processWarnings.ts` drops exactly that code at server start, and every other warning
    still prints.

  Auto-approve applies on the `!headless && elevated && autoApprove` path — **`elevated` = owner OR
  trusted user**, not owner-only;
  headless routines and plain colleague chats stay read-only. But `isAutoAllowed` auto-allows EVERY
  `mcp__*` tool at the hook BEFORE that check, so any in-process MCP server MUST self-gate in its handlers.
- **The CLI bounds SDK callback hooks with a per-hook abort (10 min default, `hh=600000` in the CLI;
  CLIs before 2.1.218 misreport the abort to the model as a USER REJECTION).** Our gate legitimately
  parks awaiting the owner's modal answer, so the PreToolUse matcher pins `timeout` (SECONDS) to
  `PROMPT_TTL_MS/1000 + 60` — the run registry always settles a parked prompt (answer / 30-min TTL /
  run end) BEFORE the CLI gives up. This bit since CLI 2.1.212 made subagents background-by-default:
  their prompts now arrive after the visible turn, i.e. typically unattended. When the prompt resolves
  with NO answer (TTL/stop), `onPermission` returns `{behavior:"deny", unanswered:true}` and the hook
  words the deny as "went unanswered — not a refusal" (+ an `onBlocked` notice), never as a user refusal.
- **Background SUBAGENTS bypass the permission gate entirely — the hook forces every Task/Agent spawn
  foreground** (`run_in_background` rewritten to `false` via `updatedInput` when it is `true` OR
  OMITTED: the CLI's default for an omitted flag is background, and the original `=== true` check let
  every flagless spawn run async from 2.1.222 through 2.1.283 — found 2026-09-27 in the transcripts).
  Verified on the bundled CLI 2.1.222 (subagents background-by-default since ~2.1.198): a background
  subagent's tool calls consult NEITHER SDK-callback hooks NOR `canUseTool` NOR even bare `allowedTools`
  entries, and every permission-needing call is auto-denied with user-refusal wording ("The user doesn't
  want to take this action right now"), which the avatar relays as the user having refused. Upstream
  treats the subagent-hook gap as known/unplanned (claude-code #34692, #27661). Bash KEEPS
  `run_in_background` (a running shell makes no further tool calls, and timeout auto-backgrounding is
  Bash-only), so the background phase below still exists — it is just Bash-fed now. Re-verify on every
  SDK bump and drop the rewrite once bg subagents inherit the session's permission wiring.
  **Re-checked 2026-09-27 on the bundled CLI 2.1.283 (SDK 0.3.283):** the gap looks CLOSED upstream,
  though no changelog entry says so. In a direct SDK spike WITHOUT the rewrite, an allow-all PreToolUse
  hook received the background subagent's own Bash call (`agent_id` set), and the call ran. A second
  spike verified DENY: a hook deny on a background subagent's Bash reached it as `PreToolUse:Bash hook
  error`. The rewrite STAYS until parked-prompt answers (a question or permission raised after the
  visible turn ended) are verified for background subagents too, then goes deliberately. Agents that
  run in the background regardless (a SendMessage resume, teammates, remote agents) render correctly:
  the spawn's `async_launched`/`remote_launched` tool_result (`tool_use_result.status`) is only a
  LAUNCH RECEIPT, so `handleUserMessage` does not end the card on it, and the agent's
  `task_notification` does. A card gets its 백그라운드 badge (`agent{background:true}`, once per card
  per run via `flagBackgroundAgent`) from any of three signals: that receipt, a mid-run
  `task_updated{is_backgrounded}`, or the agent's task id in the live `background_tasks_changed` set.
  The last is the only one a SendMessage resume sends, and since spawns are forced foreground it is the
  usual way an agent runs in the background (measured 2.1.283: the resume re-announces the SAME task
  id, so the existing card reactivates, and the agent's own messages keep the original spawn's
  `parent_tool_use_id`). A resume works only inside the run that spawned the agent: in a later run the
  CLI knows neither the name (`success:false`) nor the id (no task starts). A task the CLI starts for
  a sub-agent's own tool call (a shell past ~3 s, or backgrounded) nests under that agent's card: the
  handler maps tool_use id → issuing agent (`LoopState.toolAgentIds`), and every task frame carries
  that `agentId`. Such rows used to render at the root, away from the agent that ran them.
  (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` is the blunt alternative — strips `run_in_background` from
  tool schemas entirely, but kills Bash background tasks too.)
- **Background phase (`run_in_background` tasks outliving the visible reply).** A `query()` is NOT one
  model turn: with live background tasks (Bash `run_in_background` — subagent spawns are forced
  foreground, see above) the CLI can emit the first
  `result`, wake the model when a task settles (`task_notification`), and stream follow-up turns, each
  ending in another `result` — **but ONLY while its stdin is open.** A prompt that ends — a plain
  string (`isSingleUserTurn`), or a generator that returns when the run has hooks/MCP servers (the
  bidirectional-needs wait) — makes SDK 0.3.222 call `endInput()` at the turn's FIRST result, and the
  CLI exits with it, killing still-running tasks (a task "survived" only when it settled BEFORE that
  result: the queued `task_notification` is drained even after stdin EOF — the root cause behind
  2026-08-30's flaky wake-ups). So STREAMING turns feed the prompt through a HELD-OPEN generator
  (`buildHeldOpenQueryPrompt`: yield the one user message, park on a gate; same wire format as a
  string), and `runClaudeAgent` resolves the gate at a result boundary whose `LoopState.backgroundTasks`
  is empty (plus in the attempt's `finally`, so aborts/errors never leak it); headless runs keep the
  single-turn prompts. Background-task state is **per-process** — a `resume`
  in a new process cannot recover it, which is why the phase must ride the ORIGINAL run. Wiring:
  `background_tasks_changed` (level signal, REPLACE semantics) → `LoopState.backgroundTasks` +
  `onBackgroundTasks` → SSE `bg_tasks`; every `result` fires `onTurnResult` with the text SINCE the last
  boundary (`segment*Start` indexes in `claudeAgent.ts`). The chat route finalizes the visible turn at
  the FIRST boundary that has live tasks (persist + `done{background:true}`, run kept open,
  `markRunBackground` → 409s get a background-specific message), persists each wake-up turn as a NEW
  assistant message (`bg_message`, tail-sliced via `persisted*Offset`), and emits `bg_end` when the
  iterator drains. Cancel during the phase KILLS the tasks (abort → subprocess dies): the cancel/error
  paths persist only the tail past the last boundary, and the client seals still-running activity rows
  as **failed** (not "done") via `snapshotActivity(pane, terminal)` before the stopped bubble. Client
  keeps `streaming=true` through the phase (stop button = the kill switch), renders the `bg-task-note`
  chip from `pane.backgroundTasks`, and keeps ONE live tree until `bg_end` — but renders and seals it
  PER BUBBLE (`lib/activitySegments.ts`). Every row is stamped at creation with its segment (0 = the
  visible turn, k = the k-th wake-up turn; a sub-agent's rows inherit the agent's segment, so a
  background agent's late calls stay with the turn that spawned it), `pane.segmentMessageIds[k]` is the
  bubble segment k became, each finished bubble shows its own rows live, and `bg_end` PUTs one snapshot
  per bubble. Wake-up turns' tools used to seal onto the first message (`backgroundMessageId`) while
  their own bubbles showed none. A kill folds the in-flight segment into the newest bubble.
  Replay-safety: every message push dedupes by id (a reattach replays the whole event log), and the
  segment bookkeeping runs BEFORE that dedupe so a replay closes the same segments. Known v1 limits (deliberate): a new `POST
  /api/chat/stream` still 409s during the phase — but the composer no longer strands the viewer there,
  it delivers the text as a MID-TURN message (next bullet) whose answer arrives as a `bg_message`
  wake-up turn — and a server restart kills pending background work; both are stated in the standing
  prompt guidance (`promptBuilder.ts`) and `describe_system`.
- **Mid-turn user messages ("steers") ride the held-open input, and the CLI's own queue does the
  folding.** Someone watching an agentic turn wants to correct it, not wait it out — the same thing
  typing into Claude Code mid-run does. Streaming turns already pass an async generator as the SDK
  `prompt` (`buildHeldOpenQueryPrompt`, the background-phase keepalive above), so with a channel
  attached its park becomes a LOOP: each accepted message is yielded as another
  `{type:"user", uuid, message}`, the SDK's `Query.streamInput` writes it to the CLI's stdin at once,
  and the CLI folds it into the running turn after the next `tool_result`. Verified by a live spike on
  the SDK-BUNDLED CLI 2.1.251 (the SDK spawns its own binary, never the machine's `claude`), and
  re-verified in-app on 2.1.283 on 2026-09-27 (queued → delivered after the Bash `tool_result` →
  completed, folded into the same turn):
  (1) `command_lifecycle {command_uuid, state: queued|started|completed|cancelled}` keyed by OUR uuid is
  the ONLY delivery signal — a folded steer is never echoed back as a stream `user` message, `started`
  is the moment the text reached the model, and `result.queued_turn_count` LIES (0 with a steer still
  queued), so never read it; (2) with no tool boundary left a queued message runs as a SECOND turn right
  after the first `result`, even if stdin was closed at that result, and the public `Query` interface
  has no way to cancel a queued message — so an undelivered steer at a boundary ALWAYS means a follow-up
  turn; (3) the wire shape is the verified DEFAULT one (`steerToSdkUserMessage`) — no `origin`,
  `priority` or `shouldQuery`, and `priority:"now"` stays unused BY DESIGN because it ABORTS the running
  turn. The ONE exception is a steer whose text starts with `/`: it rides `client_composed: true`, the
  SDK's per-message opt-out of CLI slash-command dispatch (and `@path` expansion). A plain stdin user
  message IS dispatched: live on 2026-09-30, a mid-run `/new …` steer ran the CLI's `/clear`, the run
  adopted the new EMPTY session and every later turn resumed nothing. The flag also skips the CLI's
  turn-start attachment pass when such a steer becomes a follow-up turn, which is why it is not set on
  every steer; a `/compact` steer is refused outright (400). **`SteerChannel`** (`agent/steerChannel.ts`) is the per-run queue + state machine between those
  halves (`queued` → `delivered` → `completed`, or → `dropped`): `push`/`next(until)`/`noteLifecycle`/
  `noteResultBoundary`/`hasUndelivered`/`close`/`onChange`, bounded by `MAX_UNDELIVERED_STEERS` (10). It
  rides `openRun` meta, `pushRunSteer(runId, userId, text)` is the only writer
  (`not_found|unsupported|closed|too_many`), and `cancelRun`/`cancelAllRuns`/`closeRun` close it so every
  undelivered record reports `dropped` BEFORE the run's terminal frame.
  **Release rule at a `result` boundary** (`claudeAgent.ts`): `noteResultBoundary()` runs first (every
  still-queued record is flagged `followUp`), and the held input is released + the channel closed ONLY
  when there are neither live background tasks NOR undelivered steers — the CLI is about to run that
  steer, and closing here would drop a message the viewer already sent. `onTurnResult` carries
  `steerPending`; on a steer-pending, task-free boundary the fold anchors (`textFold.chunkIndex`/
  `deltaIndex`) jump past the segment just persisted, so the follow-up turn neither folds the previous
  answer into 생각 과정 nor repeats it in the run's final text. The empty-turn self-heal retry is SKIPPED
  once any steer was accepted (a re-run replays only the FIRST prompt and the CLI ignores a re-sent
  uuid), and the attempt loop's `finally` closes the channel on every other exit. **`turn_end` vs `done`
  vs `bg_message`:** with a pending steer and no background tasks the chat route persists the visible
  segment (its text, or `STEER_TURN_END_PLACEHOLDER` when the steer cut it short) and emits `turn_end
  {message, response}` — payload shape identical to `done`, but the run is kept OPEN, the
  `persisted*Offset`s advance and `turnFinalized` is deliberately NOT set, so the follow-up turn's answer
  is this run's real `done`. That `done` carries only the TAIL, by two different mechanisms: the text
  because the fold anchors moved (`partialText` is `assistantChunks.slice(textFold.chunkIndex)`), the
  reasoning and attachments because it slices at `persistedThinkingOffset`/`persistedAttachmentsOffset`
  (`persistedTextOffset` feeds only the cancel/error tails). Once the BACKGROUND phase has started, a
  steer is simply another wake-up turn and its answer rides the existing `bg_message` path — and its
  DELIVERY marks the owner present for that segment (`ownerSteeredSinceBoundary`, set only after
  finalization, cleared at the next result boundary), which is what `create_share_link`'s background
  refusal keys on.
  **Persistence happens at DELIVERY, never at accept:** the `delivered` listener
  writes the user row with `kind:"steer"` (`messages.kind`, `addColumnIfMissing`) and carries it back
  inside the frame as `steer.message`, so a message the model never saw never enters history.
  **Endpoint:** `POST /api/chat/runs/:runId/message` — session cookie only (never a personal API key),
  plain text capped at `MAX_STEER_LENGTH` (20k chars); 400 empty/too long, 404 unknown/ended/other-user
  run, 409 `unsupported` (no channel) and `too_many`, 410 `closed`. **Out of scope by design:** external
  gateway avatars and external-task-API turns get NO channel (`steers` undefined → `midTurnMessages`
  false on both metacognition surfaces), a steer carries no images, no slash expansion and no canvas, and
  a queued steer cannot be cancelled. Client: pending steers render as dimmed 전달 대기 중 bubbles above
  the live bubble, `delivered` moves them into `pane.messages` (응답 중 전달 badge), `dropped` returns the
  text to the composer with a toast, and `turn_end` seals the bubble via `finalizeVisibleTurn` while
  `endLiveTurn` keeps `streaming` true. **Both frames must be replay-idempotent** — they ride the ordered
  run-event log, so a reattach re-applies them (see [`client.md`](./client.md) for the wire contract).

## Image attachments
- The user message can carry images. The composer stages images (`ChatPane.pendingImages`, downscaled to
  ≤1568px + base64 in `ChatView.svelte`), POSTs them on `images: [{id, data}]`. `routes/chat.ts`
  validates/decodes up front (`chatImages.ts` → `decodeChatImages`, before SSE), writes bytes to
  `dataDir/chat-images/<conversationId>/<id>.<ext>` (NOT in SQLite — only `MessageAttachment` metadata
  persists via `messages.attachments_json`), and feeds the model `AgentRequest.images` THIS turn. Served
  by owner-scoped `GET /api/conversations/:id/images/:imageId` (`resolveStoredImage` guards traversal).
  Bubbles render from the pane's `localImages` (data URL, instant) then fall back to that serving URL on
  reload. **Client canvas resize loads the source via a `data:` URL (FileReader), NOT
  `URL.createObjectURL` — a `blob:` URL is blocked by the prod CSP, a prod-only trap.** **Feeding images
  REQUIRES an `AsyncIterable<SDKUserMessage>` prompt (text block + image blocks). Streaming turns pass
  an async-iterable ALWAYS (`buildHeldOpenQueryPrompt` — the background-phase keepalive above — which
  simply includes the image blocks when `request.images?.length`); headless image turns use the
  single-turn `buildImageQueryPrompt`, and headless text turns keep the plain string. `resume` works in
  every mode.** A rewind/regenerate re-reads its
  ANCHOR row's stored attachments from disk (`readChatImages`). `express.json` limit was bumped
  3mb→40mb. Conversation delete sweeps the image dir (`deleteConversationImages`).
- **Vision gating is PER-RUN, per-model-tier** (`modelVisionPolicy.ts`): effective vision =
  admin per-tier policy (`app_config` row `model_vision_policy`, admin panel "모델별 이미지 입력";
  `{tierId: boolean}`, absent tier inherits) ∘ deployment default (`MODEL_VISION=off` env). Resolution
  mirrors the model chain (`env pin > user tier > admin override > default`; a concrete model id can't
  consult the tier policy → deployment default). When the RUN's model is text-only, every path that
  would put image bytes in MODEL input is cut off BEFORE the API can 400 the whole turn — but the
  UPLOAD itself is NOT rejected: it becomes **file mode** (`imageFileMode` in routes/chat.ts). The
  bytes are persisted exactly as in vision mode (same bubble/attachment rows), a copy is staged into
  `<workspaceDir>/attachments/<id>.<ext>` (`stageChatImageFilesFromAttachments`, the ONE staging path
  shared by the fresh turn and regenerate), and the model is told only the PATHS as plain prompt text
  (`AgentRequest.imageFiles` → `buildUserPrompt`), never image content blocks. Regenerate re-stages the
  same way instead of skipping the re-feed. `imageTurn` (the fresh-SDK-session-on-images rule) now
  applies only to VISION-ON turns, so a file-mode turn keeps its plain-string prompt and its session
  resume. The composer therefore no longer hides the attach UI for a text-only tier — in file mode it
  sends the ORIGINALS (no downscale, since nothing is fed to the model). EXTERNAL avatars keep the
  plain 400 (their gateway runs no local workspace). Unchanged: the PreToolUse hook denies `Read` on
  raster/PDF paths (must fire BEFORE the read-only auto-allow; SVG stays readable; redirect:
  `pdftotext` for PDFs, `show_file` to show the USER), and Confluence tools return a note instead of
  MCP image blocks (per-run `ctx.visionEnabled`). Surfaced in the standing prompt (`noVisionSection`,
  which now points at the staged files) + describe_system. `show_file`/slide previews are unaffected
  (user-facing only).
- **Every LOCAL image turn stages its images as workspace FILES, vision turns included (2026-09-30).**
  A vision turn used to get image blocks only, so no image the avatar SAW could reach a deliverable
  (the pptx skill's "use the user's photo" was impossible on exactly the turns that carry one). Now the
  fresh send AND the rewind/regenerate re-feed run `stageChatImageFilesFromAttachments` on every
  non-external turn: a vision turn carries BOTH `AgentRequest.images` (blocks, unchanged) and
  `imageFiles` (the same attachments, same order), and `buildUserPrompt` words the listing per case. A
  text-only turn keeps its "cannot view" text. A vision turn says the images shown are ALSO files, claims
  "in the same order" only while both lists have the same length, and ends by run capability: a run that
  can write files (`AgentRequest.canWriteFiles` = runPlan's `elevatedToolAccess`, the flag describe_system's
  image-sources line reads, see [`agent-core.md`](agent-core.md)) is told to place the FILE (a deck's
  `assets/`, a document, a commit) instead of describing or redrawing it; a read-only run, that it can read
  the files but not place them in this conversation. A vision turn whose staging produced nothing keeps its
  image blocks and gets no listing. `imageTurn` still keys on vision and images, so the extra files change
  neither the fresh-session rule nor resume. Because the workspace is AGENT-WRITABLE, the staging refuses an
  `attachments/` that is not a real directory (`workspaceSubdirForWrite`: a planted symlink or file there
  stages nothing); each copy first unlinks whatever holds its name, then is created with `COPYFILE_EXCL`,
  so a re-stage never writes through a link; and a finished copy must realpath to exactly
  `realpath(workspace)/attachments/<name>` (`keepIfContained`, shared with the capture save) or it is
  removed and left out of the listing. A copy that fails part-way (ENOSPC) is removed, while a file that
  reappeared at the name (EEXIST) is the agent's and stays. Browser captures land beside them in
  `captures/` ([`browser-bridge/contract.md`](browser-bridge/contract.md)), and Confluence saves in
  `confluence/`. Both metacognition surfaces name the folders ([`agent-core.md`](agent-core.md)).
- **Conversation delete removes the SERVER-WRITTEN workspace copies, and only those (2026-09-30).** Every
  conversation-delete path (single and bulk delete in `routes/chat.ts`, the admin user and group cascades in
  `routes/admin.ts`) calls `deleteConversationWorkspaceCopies` (`workspace.ts`) next to the chat-image/file
  sweeps. It removes `attachments/`, `captures/` and `confluence/` (`SERVER_WORKSPACE_COPY_DIRS`) from the
  deleted conversation's scratch workspace. A workspace lives under its THREAD's avatar
  (`workspaces/<avatarSeg>/<conversationSeg>`), so a colleague's thread sits in the OTHER user's avatar tree,
  and a deleted user's threads with other avatars outlive their own tree. The conversation segment derives
  from the id alone, so the helper looks for each id under EVERY avatar folder, never only the deleter's
  (one probe per folder for a single delete, one listing per folder for a bulk one). It never follows a
  link: a symlinked avatar or workspace folder is skipped, and a link or file named like a copy folder is
  unlinked, never recursed into. Best-effort, like `deleteConversationImages`. The rest of the workspace
  (the agent's own work files) stays until its avatar's whole tree is removed (user, bot or group-agent
  deletion). Sweeping it with the conversation is a separate decision for the user. A bot or group-agent
  delete already removes that agent's whole tree.

## Generated-file delivery + PPTX deck pipeline (`share_file`, hidden publishes)
- **`chatFiles.ts` mirrors `chatImages.ts` for agent-GENERATED documents** (there is deliberately NO
  upload path): `mcp__file_output__share_file` → `onShareFile` (routes/chat.ts) → `publishWorkspaceFile`
  (same realpath+roots containment; extension allowlist pptx/docx/xlsx/zip/pdf/csv/md/txt/drawio with
  magic-byte checks for the container formats; 30 MB cap) → bytes at
  `dataDir/chat-files/<conversationId>/<id>.<ext>`, metadata on `messages.attachments_json` as
  `kind:"file"` (+`size`). Download route `GET /api/conversations/:id/files/:fileId` is owner-scoped and
  ALWAYS `Content-Disposition: attachment` (never inline; `?name=` only picks the sanitized save-dialog
  name — the client card passes it — and never its extension: `withDownloadExtension` forces the stored
  file's own). Download names follow ONE rule (`chatFiles.ts`): `sanitizeDownloadName` strips control,
  Unicode format (bidi overrides such as U+202E) and line-separator characters and lone surrogates, and
  shortens an overlong name in its STEM, keeping the last extension; `publishWorkspaceFile` forces the real
  extension INSIDE the 200-character cap, so no later re-sanitize can cut it off. **The one exception to owner-only reads is a PPT share link**: a
  signed-in holder of a valid link reads ONE pptx card's bytes and its stamped renders through viewer-bound
  tickets (`/api/share/t/…`, validity re-run per call) — [`share-links.md`](share-links.md). Sweeps: conversation bulk/single delete + rewind/regenerate mirror the
  image sweeps, and **user-delete (routes/admin.ts) snapshots the owner's conversation ids BEFORE
  `store.deleteUser`** to rm both chat-images and chat-files dirs (the rows are gone afterwards).
- **`MessageAttachment.hidden`** = published for URL use only: `show_file` with `hidden:true` stores the
  image + returns its serving URL to the model (for canvas markdown embeds), but every ChatView render
  loop filters hidden entries. Per-turn caps: 6 visible images (unchanged), 30 hidden, 3 files —
  enforced in the `onFile`/`onShareFile` handlers, counted per kind off `shownAttachments`. The hidden cap
  counts only UNSTAMPED hidden images (`kind==="image" && hidden && !parentId`): share_file's stamped
  previews (and a screenshot card's copy) are bounded per card already, so delivering a deck leaves the
  review canvas its full 30 renders in the same turn.
- **Deck (PPTX) pipeline — TWO preview sources, tried in a fixed order.** New decks come from the bundled
  `pptx` skill's HTML→PPTX converter, a foreground `deck.sh build` in the agent shell (CLI, budgets, locks,
  isolation, probe and Docker → [`pptx-converter.md`](pptx-converter.md)); existing decks and user templates
  are still edited with python-pptx. **Delivery previews stay SERVER-AUTOMATIC** in `onShareFile`:
  1. **The converter's renders, pptx only.** `publishWorkspaceFile` also returns `sourcePath` (the realpath
     it read) and `sha256` (of the SAME buffer it stored — no TOCTOU gap); `await loadConverterPreviews(…)`
     (`deckPreview.ts`, async, pure fs, no shell) reads `<stem>.preview/manifest.json` next to the REAL file
     (sharing through a symlink still finds it) and accepts it only when its `pptxSha256` equals that hash —
     checked BEFORE any image is read — and every image passes `readWorkspaceImageAsync` (the same
     realpath/roots/5 MB/magic containment as `readWorkspaceImage`, sharing its pure checks) with the declared
     media type and sha256: ≤ 30 attached (`MAX_PREVIEW_PAGES`), ≤ 32 MiB, all or nothing. Loaded slides go
     through `saveHiddenChatImage(…, card.id)` — hidden, `parentId` = the card, alt text
     `슬라이드 N – <title>`, never spending `show_file`'s per-turn hidden budget — and LibreOffice is skipped. They are
     all saved first, then pushed and emitted in slide order; if a save fails midway, the saved ones are
     deleted and the card falls back to LibreOffice.
  2. **LibreOffice otherwise** — no sidecar (`none`), `stale` (the .pptx changed after the build: a copy, a
     rename, a python-pptx edit), `invalid`, and every docx/xlsx/pdf: `renderDocumentPreviews` (deckRender.ts
     — async execFile soffice→pdf with an isolated profile, then `pdftoppm -l 30`; **direct pptx→png
     converts only the FIRST slide**; pdf skips soffice) attaches the pages via `savePreviewImages`
     (chatImages.ts, trusted-input hidden PNGs) — best-effort, a render failure still delivers the file.
     It is gated on `probeDocumentPreviews` (soffice + pdftoppm) ONLY: python-pptx gates the legacy
     authoring state (`probeDeckRendering`), never previews, so a host with LibreOffice but no
     system-python python-pptx (a non-Docker install) still gets them.
     Agent-made images NEVER take the `savePreviewImages` path.

  The tool result carries facts only (`previews`, `previewSource`, `previewTotal`, `deckSidecar`) and
  `fileOutputTools.ts` composes the English notes from them (first 30 of N, the malgun stand-in font, a
  redirect to rebuild / share in place for stale / invalid / none). The agent renders manually (hidden
  `show_file` + ONE canvas markdown) only for mid-work review. **Availability = ONE boot-time probe**
  (`deckRender.ts`: the legacy soffice/pdftoppm/python-pptx checks + `deck.mjs probe --json` for the
  converter, memoized only when definitive — still the only thing that probes at boot), threaded per-run like
  `fileOutputEnabled`: `AgentRequest.deckConverterEnabled` / `deckRenderingEnabled` (toolchain && fileOutput
  && authoring `allowed`) pick the promptBuilder `deckSection` branch, and `SystemToolsContext.deckToolchain`
  + `deckAuthoring` drive the describe_system line with its `converter: INSTALLED` / `converter: NOT
  INSTALLED` markers (UNAVAILABLE → "an administrator must rebuild the server image"). Docker:
  `libreoffice-impress` + `fonts-nanum` + `poppler-utils` as before, plus `chromium-headless-shell`,
  `fontconfig` and the pinned Python set ([`pptx-converter.md`](pptx-converter.md#docker-packaging)).
- **draw.io viewer (.drawio share): preview is CLIENT-side, not a deckRender format.** `drawio` sits in
  the `chatFiles.ts` allowlist (mediaType `application/vnd.jgraph.mxfile`, no magic — text like csv/md/txt)
  but deliberately NOT in `PREVIEWABLE_EXTENSIONS`: `FilePreviewPanel.svelte` fetches the file and renders
  it with the **vendored draw.io viewer** (`src/client/public/drawio/`, pinned upstream tag — see its
  README for provenance/upgrade). The ~4 MB global script is NOT in the Vite bundle; `lib/drawioViewer.ts`
  injects a same-origin `<script>` on first use. **Verified under the app CSP: no `unsafe-eval`, no
  iframe.** Gotchas: (1) the `window.*_PATH` asset globals MUST be set before the script evaluates (the
  loader does) or they default to diagrams.net URLs; (2) only the basic/arrows/flowchart/bpmn stencil sets
  are vendored — other `shape=mxgraph.*` sets render as labeled placeholder boxes; drop more XMLs from the
  SAME upstream tag into `stencils/` to extend (no code change); (3) expected noise: one
  `/drawio/math/startup.js` request that 404s/nosniff-blocks per session (MathJax intentionally not
  vendored); (4) the render target div must NOT have the `mxgraph` class (the script's load-time auto-scan
  would double-process it); (5) the viewer lays out for the width it was created at — the panel repaints
  (debounced) on resize; (6) compressed `<diagram>` payloads render fine (the viewer inflates them), but
  the `drawio` skill tells the agent to AUTHOR uncompressed so later turns can edit the XML.
- **Rewind/regenerate caveat:** the dropped rows' attachments (images AND files) and the share links of
  their file cards are deleted, so a canvas that embedded their slide images loses them — accepted (the new
  run re-renders and re-shows); the canvases themselves roll back to the anchor time.
- **`create_share_link` (the agent path):** on interactive own-avatar owner turns only, the chat route's
  `onShareLink` makes or reuses a login-required share link for a PPTX card (this turn's `shownAttachments`
  first, then persisted messages). Once the visible turn is finalized it refuses unless a steer the owner
  typed was delivered since the last result boundary (a pure wake-up turn still refuses), and every ok
  result names the conversation's other active links (`otherActiveLinks` — a link never follows a rebuild).
  The tool text lives in `agent/fileOutputTools.ts`; gates, validity and the viewer in
  [`share-links.md`](share-links.md).

## Visual canvas (`mcp__canvas__show`, experimental `canvas` feature)
- CSP-SAFE port of Superpowers' visual companion: the avatar DECLARES content
  (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional `controls` (buttons/text); the CLIENT renders
  sanitized content (DOMPurify; mermaid `securityLevel: strict`; **`vega` = a compact Vega-Lite spec
  compiled+rendered to an SVG STRING via the CSP-safe `vega-interpreter` AST evaluator — no `Function`
  ctor, so `script-src` needs no widening**; all lazy-loaded with a source-`<pre>` fallback) + real form
  controls — no avatar JS runs, CSP unchanged. `canvasTools.ts` (NOT self-gated — registration is the
  boundary) registered in `claudeAgent.ts` ONLY when the avatar OWNER enabled `canvas` AND
  `events.onCanvas` exists. Controls park the run via the SAME `awaitResponse`/`/api/chat/respond` path as
  `onQuestion`; display-only returns immediately. **A parked (blocking) form must stay ENABLED while
  `pane.streaming` is true** — the answer posts to `/api/chat/respond` MID-run and the run resumes only on
  submit/skip, so `CanvasPanel` locks on `streaming` only for the new-turn paths (async submit, re-submit,
  content edit); locking the blocking form deadlocks the question (8aed88d regression). While parked the
  frame handler pins the status line to `캔버스 응답을 기다리는 중…`, suppressing the periodic `tool_progress`
  status ticks (`실행 중: 캔버스 표시`) until the park resolves; the curated MCP tool labels live in
  `shared/sdkToolPresentation.ts` (`MCP_TOOL_LABELS`) so server status line and client activity rows agree.
  Artifacts persist on `AgentResponse.canvases` and rebuild
  on reload (`canvasesFromMessages`); live via SSE `canvas` event → `CanvasPanel.svelte`. **Refine-in-place:**
  `show` takes an optional `canvasId`; reusing it UPDATES that artifact (client `handleCanvas` +
  `canvasesFromMessages` AND server `record()` all upsert by id, latest-wins). **Size-cap:** `canvasTools.ts`
  rejects over-`MAX_CANVAS_CONTENT_CHARS` content (it rides every `resume` turn's transcript).
- **A PARKED canvas survives a conversation switch ONLY through the run-event replay.** `record()` runs at
  resolve time, so a parked ask is NOT in the canvas tables yet; returning to the conversation rebuilds the
  form purely from the journal's `canvas` frame (`tests/routes-chat-canvas-park.test.ts` +
  `tests/client-canvas-park.test.ts` pin both halves). To keep that return possible at all,
  `selectConversation`/`addConversationToSplit`/ChatView-onMount fire `attachActiveRun` WITHOUT awaiting it —
  it resolves only at RUN end, and awaiting it held the sidebar's per-conversation busy lock (disabled
  button) for the whole park; pane-REPLACING navigations abort the dropped panes' reader loops
  (client-side only — the run stays reattachable). Split view mounts the SAME side-panel slot
  (`FilePreviewPanel`/`CanvasPanel` for the ACTIVE pane) inside a `.chat-layout` wrapper — before, a canvas
  created while split was invisible entirely. E2E pin: `tests/visual/canvas-park-return.spec.ts`.
- **Questions default to AskUserQuestion, not canvas controls** — controls are for decisions ANCHORED to
  the artifact on screen (stated in the standing canvas guidance + the `show` description). `describe_system`
  reports canvas availability via runPlan's `canvasActive` → `ctx.canvasEnabled`, carrying the same redirect.
