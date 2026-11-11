# Chat, SSE, and generated media

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> SSE sessions and history (pi sessions, rewind, steers delivered into the running turn, AskUserQuestion), image attachments, `share_file` / PPTX / draw.io delivery, and the visual canvas.

## Chat / SSE / sessions
- **Chat is SSE, and an owner turn can be driven from anywhere in the client.**
  `POST /api/chat/stream {avatarId, message, conversationId?}` streams events
  `open`(→conversationId,runId)/`delta`/`status`/`tool*`/`text_fold`/`turn_end`/`done`/`error`; omit
  `conversationId` and the server mints one (returned on `open`). Consume with `consumeSse(body, (event,data)=>…)`.
  Interactive prompts are answered out-of-band: `POST /api/chat/respond {runId, requestId, value}` — `value` is
  `{cancelled:true}`/`{result}` for a `question` (AskUserQuestion) and the canvas submission for a `canvas`
  prompt. There is no `permission` prompt any more: nothing on the pi runtime asks for tool approval (see "Tool
  gate" below). The frames `bg_tasks`/`bg_message`/`bg_end`/`permission` and `done.background`/`done.tasks` are
  gone with the SDK runner, and the run snapshot carries no background state.
- **Context across turns = the pi session (`previous_response_id`), not history re-injection.** Every committed
  pi turn reports its response id (`resp_<session>_<n>`) through `onSessionId`, persisted to
  `conversations.agent_session_id` (`get/setAgentSessionId`); the next turn sends it as `previous_response_id`,
  so pi continues the stored session (tool calls and results included). Anything that is not a `resp_…` id — a
  CLI session id from the retired SDK runner — is ignored: the turn starts a new session from the stored text
  history, with the larger first-turn cap (`PI_FIRST_TURN_HISTORY_LIMITS`). The old CLI transcripts
  (`<dataDir>/agent-sessions`) are quarantined at boot behind `retirementGate()` (marker
  `retired:agent_sessions`), never read. `greeting` (ephemeral) starts a fresh session. Sessions, lost-session
  heals, per-turn model/effort switches and stop/cancel continuations → [`pi-runtime.md`](pi-runtime.md)
  "One run".
- **Rewind ("여기서부터 다시") and regenerate share ONE plan → apply path, and cut HISTORY, never the
  world.** Editing an earlier ordinary user message (`POST /api/chat/stream {rewindFromMessageId,
  message}`) REPLACES that row and every row after it; 다시 생성 (`regenerate: true`) re-runs the LAST
  NON-STEER user row in place — its STORED text, slash commands re-expanded — and drops every row after
  it: all answer segments and steers of that run. (The old `dropLastAssistant` removed only the last row, so
  segments resurfaced on reload and the user text reached the model twice.)
  - **Exact context via recorded resume points.** The runner fires `onResumePoint({sessionId, uuid})` with the
    committed response id (both fields carry it). The route keeps the latest per run and stamps it on the
    assistant rows the SUCCESS boundaries persist (`turn_end`, `done`) as `messages.sdk_session_id`/`sdk_uuid`
    (column names kept from the SDK era) — server-only, never on `StoredMessage`. A boundary whose result carried
    an in-band error (`error_max_turns`, …) stamps NOTHING (`resumePointFor`; the `done` row reads the last
    boundary's subtype): its last entry may be a tool call with no result. A rewind whose kept history ends at a
    stamped row continues from THAT response id: pi branches on an older `previous_response_id` (no fork flag),
    and the source session is never rewritten, so every older row's point stays valid.
  - **Fallbacks.** No point (legacy SDK-era, cancelled or errored rows) → a fresh session over the KEPT text
    history (`conversationHistoryForPrompt(plan.keep)`). A point pi no longer has (404/409, or a model the
    operator removed — `isLostPiSession`) self-heals once into a new session from that history.
  - **Plan early, apply late — the race rules are load-bearing.** `planTurnRewind` →
    `planConversationRewind` runs BEFORE the turn's first await (the repo resolution), with the busy checks
    (queued/running `avatar_tasks`, a running routine bound to the conversation —
    `routineRunRegistry.ts`, re-exported by scheduler.ts; the active run is the existing checks' job); every
    refusal before the apply leaves the thread untouched. The APPLY sits after the raced active-run re-check
    and immediately before `openRun`, with no await between: busy checks again, a synchronous RE-PLAN that
    refuses 409 on any drift in the kept or dropped ids (a turn that completed inside the await), then
    `applyConversationRewind` in one transaction — delete exactly the planned rows; the share links of
    dropped deck cards; canvases rolled back to the anchor time; `agent_session_id = NULL` (crash safety —
    the branch's new id lands on success). Then the edit's replacement row (carrying the anchor's image
    attachments) and the disk sweep of the dropped rows' attachments minus the carried ids — their STAGED
    workspace copies included (`deleteStagedAttachmentCopies`: `attachments/<id>.<ext>` only, never following
    a link; captures and saved Confluence files are the dropped turns' tool side effects and stay). Replacing
    the FIRST message moves an auto-derived conversation title to the new text; a renamed title stays.
  - **`kind: "queued"`** marks a user row written while ANOTHER run was active — a routine's row written
    over a live run, and the row a raced 409 refusal already wrote. It sits BEFORE that run's answer in
    rowid order, so it can never anchor (400). Unmarked legacy rows are a known gap.
  - **Metacognition:** `AgentRequest.rewind {kind, discardedMessages}` → ONE text
    (`ownerState.rewindTurnState`) in the turn input (`buildPiTurnPreamble`) and in `describe_system`: the
    context ends at the rewind point, and NOTHING the discarded turns did was undone (files, commits and pushes,
    browser actions, created routines/links). The client's confirm dialog tells the user the same.
  - **`open` carries `userMessageId`** (the new row of a send or edit, the anchor of a regenerate) so the
    client can name a row sent in this very session.
  - Known v1 gaps: side effects are never undone (the discarded messages' own chat attachments and their
    share links ARE deleted — the prompt text and the confirm dialog say both); a canvas submission that
    updated a version in place is not rolled back.
- **A streamed answer must survive completion/reload.** The live bubble shows every main-agent `delta`;
  on `done`/reload it's rebuilt from the PERSISTED `response.text`, NOT `live.text`. So `response.text`
  must be the streamed transcript (the adapter's kept text blocks, `answerText`, not just the last model
  call) — else pre-final-call narration vanishes the instant the run completes. Cancel/error paths persist the
  server-side `streamedText` accumulator (`routes/chat.ts`).
- **Interim narration FOLDS into the reasoning view (`text_fold`), so the answer is the LAST text block.**
  An agentic turn narrates between tool calls, which made the bubble grow enormous. When a NEW main-agent
  text block starts, every earlier block of the turn is demoted: the pi event adapter (`agent/pi/eventAdapter.ts`,
  `foldUpTo`) fires `onTextFold(text)` and advances its fold index. pi keeps ONE `message` item open across
  tool calls, so a block boundary is "a text delta after any tool/reasoning/item event since the last text
  delta"; a keep-last sweep at the end covers the rest, and a retried model attempt's discarded text folds too.
  The chat route's sink appends the folded text to `streamedThinking` (so it persists as `response.thinking`
  and renders in the collapsible 생각 과정 card, which renders markdown), advances `foldedTextOffset` (the
  cancel/error tails slice from `max(persistedTextOffset, foldedTextOffset)` so a stopped run can't resurrect
  folded narration), re-anchors every stamped attachment to 0, and emits an SSE `text_fold` frame. The client
  mirrors it exactly (`liveText` → `liveThinking`, bubble restarts, live cards re-anchored to 0); the frame
  rides the ordered run-event replay buffer, so a reconnect replays it between the two text bursts and lands
  on the same state. **Ordering is part of the contract:** the adapter folds BEFORE dispatching the delta that
  triggered it, so the `text_fold` frame always precedes the new block's first `delta` frame on the wire — a
  fold emitted after that delta lets the sinks sweep the chunk into the reasoning view and clips the head off
  the kept block (live, and permanently on the cancel/error paths). **Gated on the sink:** with no
  `onTextFold` (headless routines, `POST /api/chat`) nothing folds and the final text is every block joined —
  the `AgentEvents` no-sink contract. Attachment anchors are therefore TAIL-relative on both sides
  (`currentTextAnchor` slices from the fold index).
- **Manual `/compact [what to keep]` = ONE pi call, no model turn** (2026-11-10). `ChatTurnContext.compact` →
  `AgentRequest.compact` → `runPiAgent`'s `compactPiSession`: `POST /v1/responses/{id}/compact` on the
  conversation's current response id as the run principal (no capability plan, run token, plugin roots,
  working-repo lock or steer channel). pi summarizes the older history (its recent tail — 20k tokens, a quarter of a small model's
  window — stays verbatim) and commits the summary as a NEW response id; the old ids keep the full history.
  - **Success** → `onSessionId` + `onResumePoint` (the new id), `onCompact({ok: true, trigger: "manual",
    preTokens, postTokens})`, and `usage.inputTokens = postTokens` so the badge drops (`postTokens` is pi's
    ESTIMATE of the kept messages: one not below `preTokens` is dropped — no figure, the badge waits for the
    next turn's usage). The route composes the
    bubble (`compactResultText`) — no text streams. A rewind onto a row AFTER the compaction branches from the
    summary; a rewind onto the `/compact` row or earlier branches from the unsummarized history.
  - **Anything else changes nothing in pi**, so the conversation keeps its session and the row is stamped with
    the point the `/compact` row sat on (`compactKeptPoint`): `reason` = `nothing` (`nothing_to_compact`:
    too short or just compacted — a note in the bubble, NO activity row), `busy` (a 409: response in progress
    or a pending question), `lost` (pi's own 404, or a session on a model pi no longer has — the next turn
    self-heals from the stored history), `failed` (anything else, a 404 without pi's error body included: a
    gateway with no such route). A thrown run and a stop leave the session alone too.
  - **A `/compact` exchange is not a turn for `stoppedAnswer`** (`lastTurnEndRow` skips trailing command +
    bubble pairs): a stopped `/compact` restates nothing, and one sent after a stopped answer does not hide it.
  - **Refused before any write:** no pi session (`compactNoSessionRefusal`), images, as an edit's new text,
    다시 생성 of a `/compact` row (the client hides it, `isCompactCommandText`), and as a mid-turn message.
  - Available in every chat a person types in (own or colleague's avatar); never reachable from the task API
    or a routine (their text is not slash-expanded). The avatar has no tool for it — `describe_system` and the
    manual tell it to suggest the command.
- **pi's automatic compaction is visible.** pi-gateway brackets it with `response.compaction`
  (`status: in_progress` → `completed` | `failed`); the pi event adapter shows the status line `맥락 정리 중…`
  while it runs and fires `onCompact({ ok, trigger: "auto" })` at the end, which the chat route emits as the
  `compact` frame (server-minted id, deduped on replay) → the client's persisted `compact` activity row + chip
  (a manual one rides the same frame with `trigger: "manual"` and its sizes).
  The usage badge's window is pi's `usage.context_window` (`AgentUsage.contextWindow`).
- **Tool gate: built-ins are pi's, MCP tools are gated per call at `/mcp`.** pi's built-ins
  (read/write/edit/bash/ls/find/grep) run in the RUN PRINCIPAL's own sandbox (viewer for a colleague chat, the
  owner otherwise — `piRunPrincipal`; a consultation gets a fresh, empty `consult-<random>` sandbox of its own). pi
  has no per-request built-in allowlist — its only per-request switches are `interactive` and `read_only` — so a
  colleague chat's session is `read_only` (read/ls/find/grep) and every other class has the full set, never over
  the owner's files. Details → [`pi-runtime.md`](pi-runtime.md) "Run classes". Noah's
  tools reach the model only through `mcp_call`, and the `/mcp` endpoint admits exactly this run's
  `mcpAllowedTools` (`allowCall`) — then every handler self-gates again. Nothing prompts for approval: there is no
  permission dialog, no confirmer, no protected-path ask. Details → [`pi-runtime.md`](pi-runtime.md) "One run"
  and [`agent-core.md`](agent-core.md).
- **AskUserQuestion ends the pi turn and resumes it inside the same Noah run.** pi answers it with
  `requires_action` + a `function_call`; `runPiTurn` (`eventAdapter.ts`) parks on `events.onQuestion` (status
  `사용자 답변 대기 중…`, the client's question modal), then sends the answer as the next request's
  `function_call_output` on the same session — the host sees ONE blocking `onQuestion`. A run with no
  `onQuestion` (headless: routines, consultations, generators) starts its session `interactive: false`, so pi
  never asks there; a question anyway fails the run as a `protocol` error. The `requires_action` id is never reported
  via `onSessionId`, so a run that dies while a question waits resumes from the last committed turn. At most 20
  question rounds per run.
- **Background work is gone.** The SDK runner's background phase (Bash `run_in_background`, background subagents,
  wake-up turns) left with it; pi's subagent (`Agent`, from the default-skills plugin) runs inside the turn as its
  own card, and its tool calls (pi tags them `parent_tool_use_id`) nest under that card — `SendMessage`, which
  continues a subagent, is a card too (`agent/pi/eventAdapter.ts`). A run ends at its answer (or its last steer follow-up turn).
- **Mid-turn user messages ("steers") are delivered INTO the running turn of the same run** (user decision
  2026-10-31), with a follow-up turn only as the fallback. `POST /api/chat/runs/:runId/message` queues the text
  in the run's **`SteerChannel`** (`agent/steerChannel.ts`) — the per-run queue + state machine
  (`queued` → `delivered` → `completed`, or → `dropped`): `push`/`noteLifecycle`/`noteResultBoundary`/
  `undelivered`/`close`/`onChange`, bounded by `MAX_UNDELIVERED_STEERS` (10). It rides
  `openRun` meta, `pushRunSteer(runId, userId, text)` is the only writer
  (`not_found|unsupported|closed|too_many`), and `cancelRun`/`cancelAllRuns`/`closeRun` close it so every
  undelivered record reports `dropped` BEFORE the run's terminal frame. **Mid-turn delivery** (`runPiTurn`,
  `agent/pi/eventAdapter.ts`): from the response's `response.created` on, every queued record (and every one
  pushed later) is handed ONCE to that response — `POST /v1/responses/{id}/input {client_id: record.id, text}`
  (`responsesClient.input`); pi puts it into the context at its next tool-call boundary (after the running tool
  calls, or right after the answer being written — pi then keeps the turn going) and streams
  `response.input_consumed {client_id}`, which marks the record `started` (= delivered). That event is also a
  text-block and retry-attempt boundary in the adapter, so text written before it folds like narration before
  a tool call. A refusal (404/409: the response is ending, e.g. on AskUserQuestion) or a failed call leaves the
  record queued; after a question the answer's response takes it. A text starting with `/` is never handed over
  (pi would expand it as a skill/prompt template), so it always takes the fallback. A delivered steer counts as
  shown output: the empty-turn retry never re-sends an attempt pi folded one into (pi rewinds a failed turn,
  the steer with it). **Fallback** (`runPiAgent`): when a pi response completes, every STILL-queued steer (pi
  lists what it took but never delivered in `undelivered_input` and drops it from its queue; Noah needs no
  parse — those records simply stayed `queued`) is taken in the same tick; none → the channel closes and the
  run ends. Otherwise `noteResultBoundary()`, `onTurnResult({steerPending:true})` for the segment just answered,
  each steer marked `started`, and ONE follow-up pi response on the same session carries them all (a fresh turn
  preamble + the texts). Steers carry no images and no canvas, and a queued steer cannot be cancelled. Async
  `ask_avatar` answers ride the same channel and the same two paths (see [`pi-runtime.md`](pi-runtime.md)
  "Asynchronous tools").
  **`turn_end` vs `done`:** on a steer-pending boundary the chat route persists the visible segment (its text,
  or `STEER_TURN_END_PLACEHOLDER` when it was empty) and emits `turn_end {message, response}` — payload shape
  identical to `done`, but the run is kept OPEN, the `persisted*Offset`s advance and `turnFinalized` is
  deliberately NOT set, so the follow-up turn's answer is this run's real `done`. That `done` carries only the
  TAIL (the adapter's text restarts with the follow-up response; reasoning and attachments slice at
  `persistedThinkingOffset`/`persistedAttachmentsOffset`; `persistedTextOffset` feeds only the cancel/error
  tails). A stop pressed while the follow-up turn runs before its own commit clears
  `agent_session_id` (its steer lives only in Noah's rows) — [`pi-runtime.md`](pi-runtime.md) "Stop / failure".
  **Persistence happens at DELIVERY, never at accept:** the `delivered` listener writes the user row with
  `kind:"steer"` (`messages.kind`, `addColumnIfMissing`) and carries it back inside the frame as
  `steer.message`, so a message the model never saw never enters history. A mid-turn steer is therefore
  persisted BEFORE the assistant row of the answer it joined.
  **Endpoint:** `POST /api/chat/runs/:runId/message` — session cookie only (never a personal API key),
  plain text capped at `MAX_STEER_LENGTH` (20k chars); 400 empty/too long, 404 unknown/ended/other-user
  run, 409 `unsupported` (no channel) and `too_many`, 410 `closed`. **Out of scope by design:**
  external-task-API and headless turns get NO channel (`steers` undefined → `midTurnMessages` false on both
  metacognition surfaces, which otherwise say a message arrives DURING the work at the next tool-call boundary
  and may change the task). The `open` frame carries no delivery mode: the composer always says
  "작업 도중에 전달돼 진행 중인 일을 바꿀 수 있어요". Client: pending steers render as dimmed 전달 대기 중 bubbles above
  the live bubble, `delivered` moves them into `pane.messages`, `dropped` returns the text to the composer with a
  toast, and `turn_end` seals the bubble via `finalizeVisibleTurn` while `endLiveTurn` keeps `streaming` true.
  The delivered row's badge is derived from its POSITION (`steerBadgeLabel`): a mid-turn steer sits right after
  the turn opener (or another steer) and reads "응답 중 전달"; a fallback one follows a sealed answer segment and
  reads "답변 뒤 전달". **Both frames must be replay-idempotent** — they ride the ordered run-event
  log, so a reattach re-applies them (see [`client.md`](./client.md) for the wire contract).

### Deletion cascades (rules)
- **A new message-deleting path cascades like `applyConversationRewind`:** the dropped rows' attachments (minus the
  ones a kept row carries), their staged workspace copies, per-card share links, and canvases from the anchor time.
- **A new conversation-deleting path** calls `deleteShareLinksForConversation` next to the canvas cascade
  ([`server-core.md`](server-core.md)) AND `deleteConversationWorkspaceCopies` (the server-written
  `attachments/`/`captures/`/`confluence/` copies in the sandbox folder die with what they mirror).
- **User-attached documents need nothing extra:** their stored copies are `kind:"file"` attachments in the
  chat-files store, so the file sweeps above already take them; the sandbox copy in `/workspace/uploads/` is
  pi's per-user file and is deliberately NOT swept ("Document attachments" below).

## Image attachments
- The user message can carry images. The composer stages images (`ChatPane.pendingImages`, downscaled to
  ≤1568px + base64 in `ChatView.svelte`), POSTs them on `images: [{id, data}]`. `routes/chat.ts`
  validates/decodes up front (`chatImages.ts` → `decodeChatImages`, before SSE), writes bytes to
  `dataDir/chat-images/<conversationId>/<id>.<ext>` (NOT in SQLite — only `MessageAttachment` metadata
  persists via `messages.attachments_json`), and feeds the model `AgentRequest.images` THIS turn. Served
  by owner-scoped `GET /api/conversations/:id/images/:imageId` (`resolveStoredImage` guards traversal).
  Bubbles render from the pane's `localImages` (data URL, instant) then fall back to that serving URL on
  reload. **Client canvas resize loads the source via a `data:` URL (FileReader), NOT
  `URL.createObjectURL` — a `blob:` URL is blocked by the prod CSP, a prod-only trap.** The pi runner sends
  the images as `input_image` data URLs next to the turn text, on a CONTINUED session too (an image turn keeps
  the stored session unless it is a rewind, whose resume point the route already chose). A rewind/regenerate
  re-reads its ANCHOR row's stored attachments from disk (`readChatImages`). `express.json` limit was bumped
  3mb→40mb. Conversation delete sweeps the image dir (`deleteConversationImages`).
- **Vision gating is PER-RUN, per-model** (`agent/pi/modelCatalog.ts` `visionForCatalogModel`): effective vision =
  pi's own image setting ALONE (`input` in pi's `/v1/models`, set on pi's admin LLM page: only a model reported
  without `image` is text-only; unknown reads as vision on). Noah's admin per-model policy and `MODEL_VISION` are
  retired (2026-11-01). Resolution mirrors the run's model (composer pick while pi offers it > pi-gateway's default
  model, looked up by the id pi marks `default` — review #12; [`pi-runtime.md`](pi-runtime.md) "Models"). The chat route (upload mode), the capability plan (both metacognition
  surfaces) and the bootstrap (`models[].vision`, `defaultVision`) make the SAME call. When the RUN's model is text-only, every path that
  would put image bytes in MODEL input is cut off BEFORE the API can 400 the whole turn — but the
  UPLOAD itself is NOT rejected: it becomes **file mode** (`imageFileMode` in routes/chat.ts). The
  bytes are persisted exactly as in vision mode (same bubble/attachment rows), a copy is staged into the
  conversation folder's `attachments/<id>.<ext>` (host view of `/workspace/c/<conv-seg>/`, listed to the model
  by sandbox path — `stagePiAttachmentFiles`) (`stageChatImageFilesFromAttachments`, the ONE staging path
  shared by the fresh turn and regenerate), and the model is told only the PATHS as plain prompt text
  (`AgentRequest.imageFiles` → `buildUserPrompt`), never image content blocks. Regenerate re-stages the
  same way instead of skipping the re-feed. The composer therefore does not hide the attach UI for a
  text-only model — in file mode it sends the ORIGINALS (no downscale, since nothing is fed to the model).
  Confluence tools return a note instead of MCP image blocks (per-run `ctx.visionEnabled`). The standing
  prompt (`noVisionSection`, pointing at the staged files) + describe_system tell the model not to read the
  images themselves (`pdftotext` for PDFs, `show_file` to show the USER). Since the SDK's PreToolUse `Read`
  deny is gone, nothing at a tool gate stops pi's own `read` on a raster path — the instruction is the only
  guard (open item, design §9.3). `show_file`/slide previews are unaffected
  (user-facing only).
- **Every image turn stages its images as workspace FILES, vision turns included (2026-09-30).**
  A vision turn used to get image blocks only, so no image the avatar SAW could reach a deliverable
  (the pptx skill's "use the user's photo" was impossible on exactly the turns that carry one). Now the
  fresh send AND the rewind/regenerate re-feed run `stageChatImageFilesFromAttachments` on every
  turn: a vision turn carries BOTH `AgentRequest.images` (blocks, unchanged) and
  `imageFiles` (the same attachments, same order), and `buildUserPrompt` words the listing per case. A
  text-only turn keeps its "cannot view" text. A vision turn says the images shown are ALSO files, claims
  "in the same order" only while both lists have the same length, and ends by telling the run to place the
  FILE (a deck's `assets/`, a document, a commit) instead of describing or redrawing it — or, on a read-only
  colleague session (`PiRuntimeFacts.readOnlyBuiltins`), that it can read the files but not place them
  (describe_system's image-sources line says the same, see [`agent-core.md`](agent-core.md)). A vision turn whose staging produced nothing keeps its
  image blocks and gets no listing. Because the folder is AGENT-WRITABLE (it is the sandbox's), the staging
  opens every segment from the sandbox user root down to `attachments/` by descriptor without following links
  (`workspaceSubdirForWrite` → `PinnedDir`; a planted symlink or file on the way stages nothing); each copy
  first unlinks whatever holds its name, then is created exclusively through that descriptor, so a re-stage
  never writes through a link; and if the pinned folder's real path moved meanwhile, nothing is listed. A copy
  that fails part-way (ENOSPC) is removed, while a file that reappeared at the name (EEXIST) is the agent's and
  stays. Host-side discipline → [`pi-runtime.md`](pi-runtime.md) "Host-side filesystem discipline". Browser captures land beside them in
  `captures/` ([`browser-bridge/contract.md`](browser-bridge/contract.md)), and Confluence saves in
  `confluence/`. Both metacognition surfaces name the folders ([`agent-core.md`](agent-core.md)).
- **Conversation delete removes the SERVER-WRITTEN workspace copies, and only those (2026-09-30).** Every
  conversation-delete path (single and bulk delete in `routes/chat.ts`, the admin user cascade in
  `routes/admin.ts`) calls `deleteConversationWorkspaceCopies` (`workspace.ts`) next to the chat-image/file
  sweeps. It removes `attachments/`, `captures/` and `confluence/` (`SERVER_WORKSPACE_COPY_DIRS`) from the
  deleted conversation's sandbox folder under EVERY `u-*` user root (`deletePiConversationCopies`) and from its
  legacy SDK-era scratch workspace (`dataDir/workspaces/…`, which D3 empties on the first pi turn but may still
  hold copies). A legacy workspace lives under its THREAD's avatar
  (`workspaces/<avatarSeg>/<conversationSeg>`), so a colleague's thread sits in the OTHER user's avatar tree,
  and a deleted user's threads with other avatars outlive their own tree. The conversation segment derives
  from the id alone, so the helper looks for each id under EVERY avatar folder, never only the deleter's
  (one probe per folder for a single delete, one listing per folder for a bulk one). It never follows a
  link: a symlinked avatar or workspace folder is skipped, and a link or file named like a copy folder is
  unlinked, never recursed into. Best-effort, like `deleteConversationImages`. The rest of the workspace
  (the agent's own work files) stays until its avatar's whole tree is removed (user deletion).
  Sweeping it with the conversation is a separate decision for the user.

## Document attachments (`files` → pi `input_file`, 2026-11-11)
- **A user message can carry DOCUMENTS the avatar reads in its sandbox** — pdf/docx/xlsx/pptx/csv/txt/md/json
  (pi's `input_file` list minus the images, which stay images). The client↔server contract is ONE shared
  module, `src/shared/chatDocuments.ts`: the extension list, the limits, the name rule (`chatDocumentName` —
  pi's FILENAME rule plus C1/line-separator/bidi controls; NFC + trim is the only normalization),
  `uniqueChatDocumentNames` ("a.pdf", "a (2).pdf", case-insensitive) and the Korean refusals
  (`CHAT_DOCUMENT_MESSAGES`) both sides show. `POST /api/chat/stream` takes
  `files: [{ id?, name, data }]` (`data` = a base64 `data:` URL; its MIME is ignored).
- **Limits and the arithmetic behind them:** 5 documents per message, 8 MiB each, 8 MiB together. The binding
  cap is pi-gateway's request body (16 MiB for the WHOLE `/v1/responses` JSON, `PI_MAX_REQUEST_BYTES`): 1 MiB is
  left for everything that is not an attachment (instructions on a first turn, text + preamble, `sandbox_env`
  ≤ 256 KiB), so images + documents share 15 MiB of base64 (`MAX_CHAT_ATTACHMENTS_ENCODED_BYTES`); 8 MiB of
  documents is 10.67 MiB of base64 and leaves ≈ 3.25 MiB raw for the same message's images. The server measures
  the two TOGETHER at intake (`TOTAL_TOO_LARGE`), so an oversized message is a 400 before the turn, never a late
  413. Noah's own `express.json` limit (50 MB) is far above anything that passes.
- **Intake (`chatDocuments.ts` `decodeChatDocuments`, before SSE — a bad one is a Korean 400 like images):**
  count → shape → name/extension (`NAME` / `TYPE`) → data URL → size (`EMPTY` / `TOO_LARGE` /
  `TOTAL_TOO_LARGE`) → CONTENT (`BAD_FORMAT`): `%PDF-` in the first 1024 bytes; a ZIP local header plus
  `[Content_Types].xml` and the kind's part folder (`word/`, `xl/`, `ppt/`) for docx/xlsx/pptx — a renamed
  .doc, a password-protected file (an OLE container) or an .xlsx named .docx fails; for csv/txt/md/json **any text
  encoding passes** (the fleet's Excel exports are often CP949/EUC-KR; user decision 2026-11-11) — only a NUL
  byte in the first 8 KiB (a binary file) is refused — except UTF-16 text that starts with a byte-order mark
  (Excel's "Unicode text") — and json need not parse; the bytes are stored and sent to pi unchanged (nothing
  is converted). Every place that
  tells the avatar to read an attachment carries `DOCUMENT_ENCODING_CLAUSE` (try `encoding="cp949"` when UTF-8
  decoding fails). The client's
  MIME is never used: the stored media type derives from the extension after the bytes passed.
- **Where it is allowed: ONE decision, `documentAttachmentsAllowed` (`agent/runCapabilities.ts`)** — the run's
  sandbox owner is the avatar owner (`piSandboxOwnerOf`, the same value behind the pi session's `read_only`)
  AND the turn is neither `headless` nor `externalTaskApi`. `executeChatTurn` refuses anything else with
  `NOT_ALLOWED_HERE` (400) before any write; the capability plan stamps the same function's result as
  `PiRuntimeFacts.documentAttachments` (describe_system), and the pi runner throws rather than send a file on
  a run whose plan says no. So: the owner chatting with their own avatar — never a colleague's chat (a
  `read_only` pi session, where pi 400s `input_file`), a consultation, a routine or the external task API
  (its body is not extended). A mid-turn message carries none (`POST …/runs/:id/message` with `files` is a
  400, not a silent drop), nor does `/compact`; a rewind/regenerate brings no NEW document (400).
- **Two copies, two lifecycles.** NOAH's copy goes into the conversation's chat-files store
  (`chat-files/<conversation>/<id>.<ext>`, `saveChatDocuments`) with a `kind:"file"` attachment marked
  **`uploaded: true`** on the USER message — `{ id, kind: "file", mediaType, name, size, uploaded: true }`.
  It rides every existing cascade of that store unchanged: the rewind/regenerate sweep
  (`deleteChatFileAttachments`, minus what an edit's replacement row carries), single and bulk conversation
  delete, user delete (`deleteConversationFiles`). The bubble re-downloads it through the existing file route
  (`GET /api/conversations/:id/files/:fileId?name=…`: owner-scoped, `Content-Disposition: attachment`,
  `nosniff`, never inline; `json` is a serve-only type there, not a share_file type). The SANDBOX copy,
  `/workspace/uploads/<name>`, is **pi's write** in the per-USER workspace (user decision 2026-11-11: pi's
  folder, not a per-conversation one): kept between conversations, replaced by a later upload of the same
  name, and never written or deleted by Noah — deleting the message or the conversation leaves it (a rewind
  cuts history, never the world), and user delete removes it with the whole sandbox workspace.
- **A share link never picks an upload:** `isPptxCard` (`src/shared/shareLinks.ts`) excludes
  `uploaded` cards, so neither the 공유 링크 button, the route nor `create_share_link` exports a .pptx the
  user sent in.
- **Regenerate / edit re-send the anchor row's documents** (`readChatDocuments` — only `uploaded` file
  attachments whose stored name and extension still match), so pi writes `/workspace/uploads/<name>` again
  with the stored bytes; a missing stored copy is skipped and logged, like `readChatImages`. A document-only
  message (no text) is a valid message and a valid rewind anchor.
- **To the model:** `AgentRequest.documents` → `input_file` parts after the text and images
  ([`pi-runtime.md`](pi-runtime.md) "Document input"), and `buildPiTurnPreamble` adds ONE line naming each
  path, type and size — the per-turn fact that also reaches a conversation whose frozen prompt predates the
  feature. Standing text: the frozen append's **Attached documents** note (owner conversation: how they
  arrive; colleague: this viewer cannot attach one), describe_system's `Document attachments` line (the live
  per-run fact with its reason), pi's system prompt (`scripts/pi-system-prompt.md`) and the manual's `chat`
  topic. The shared sentences live in `agent/ownerState.ts` (`DOCUMENT_UPLOADS_SENTENCE` and friends).

- **Client: three ways in, one staging path.** `ChatView.addFiles` is the single entrance for the attach button
  (its `accept` widened; the input is `sr-only`, so it is keyboard reachable), a PASTE of files copied in the OS
  file manager, and a DROP on the pane (file drags are told apart from the conversation drag by
  `dataTransfer.types`; while the chat view is mounted a file dropped outside the target no longer navigates
  the browser away). The picker cannot be the only path: on the fleet a security agent may refuse the browser's
  file dialog. `lib/composerDocuments.ts` judges name/type/size/count/total from the shared module BEFORE reading
  bytes (a refused file never blocks the others, each refusal names the file), stages a chip in a "읽는 중…"
  state and reads asynchronously; a send is held while a read is in flight and when images + documents exceed
  `MAX_CHAT_ATTACHMENTS_ENCODED_BYTES`. `pane.pendingDocuments` is per pane; a failed send restores them with
  the draft (`unsentDocumentIds`). Offered only in a pane of the viewer's OWN avatar — in a colleague's pane the
  button attaches images only and a dropped/pasted document is refused with `NOT_ALLOWED_HERE`. While the
  avatar answers, documents can be staged but ride the next ordinary message (a mid-turn message carries none).
  The bubble's card is a DOWNLOAD of the viewer's own file through the existing file route (`<a download>`),
  never an inline render or a side-panel preview; a regenerate/edit sends no `files` — the server re-sends its
  stored copy.
## Generated-file delivery + PPTX deck pipeline (`share_file`, hidden publishes)
- **`chatFiles.ts` mirrors `chatImages.ts` for agent-GENERATED documents** (the only way IN is a user's
  document attachment, above): `mcp__file_output__share_file` → `onShareFile` (routes/chat.ts) → `publishWorkspaceFile`
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
  `pptx` skill's HTML→PPTX converter, a foreground `deck.sh build` in the run's sandbox shell (deck CLI, budgets,
  locks, isolation, the sandbox image → [`pptx-converter.md`](pptx-converter.md)); existing decks and user templates
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
  `show_file` + ONE canvas markdown) only for mid-work review. **Availability:** the
  converter runs in the SANDBOX, so its state is the operator's `PI_DECK_SANDBOX` flag
  (`piSandboxDeckToolchain(config)`, `deckRender.ts` — never a host probe; off = `converter: NOT INSTALLED` with
  the operator fix named, see [`pi-runtime.md`](pi-runtime.md) "Decks"), while the LibreOffice previews keep the
  boot-time host probe (`probeDocumentPreviews`), because they render Noah-side. Threaded per run like
  `fileOutputEnabled`: `AgentRequest.deckConverterEnabled` / `deckRenderingEnabled` (toolchain && fileOutput
  && authoring `allowed`) pick the promptBuilder `deckSection` branch, and `SystemToolsContext.deckToolchain`
  + `deckAuthoring` drive the describe_system line with its `converter: INSTALLED` / `converter: NOT
  INSTALLED` markers. Noah's own image keeps `libreoffice-impress` + `fonts-nanum` + `poppler-utils` for those
  previews; the converter's Chromium, fonts and pinned Python set live in the sandbox image
  (`docker/pi-sandbox`, [`pptx-converter.md`](pptx-converter.md)).
- **draw.io viewer (.drawio share): preview is CLIENT-side, not a deckRender format.** `drawio` sits in
  the `chatFiles.ts` allowlist (mediaType `application/vnd.jgraph.mxfile`, no magic — text like csv/md/txt)
  but deliberately NOT in `PREVIEWABLE_EXTENSIONS`: `FileTab.svelte` (a tab of the side panel) fetches the file and renders
  it with the **vendored draw.io viewer** (`src/client/public/drawio/`, pinned upstream tag — see its
  README for provenance/upgrade). The ~4 MB global script is NOT in the Vite bundle; `lib/drawioViewer.ts`
  injects a same-origin `<script>` on first use. **Verified under the app CSP: no `unsafe-eval`, no
  iframe.** Gotchas: (1) the `window.*_PATH` asset globals MUST be set before the script evaluates (the
  loader does) or they default to diagrams.net URLs; (2) only the basic/arrows/flowchart/bpmn stencil sets
  are vendored — other `shape=mxgraph.*` sets render as labeled placeholder boxes; drop more XMLs from the
  SAME upstream tag into `stencils/` to extend (no code change); (3) expected noise: one
  `/drawio/math/startup.js` request that 404s/nosniff-blocks per session (MathJax intentionally not
  vendored); (4) the render target div must NOT have the `mxgraph` class (the script's load-time auto-scan
  would double-process it); (5) the viewer lays out for the width it was created at — the tab paints only
  into a body that has a width (a hidden tab or collapsed panel measures 0) and its ResizeObserver repaints
  (debounced) when that width changes; (6) compressed `<diagram>` payloads render fine (the viewer inflates them), but
  the `drawio` skill tells the agent to AUTHOR uncompressed so later turns can edit the XML.
- **Rewind/regenerate caveat:** the dropped rows' attachments (images AND files) and the share links of
  their file cards are deleted, so a canvas that embedded their slide images loses them — accepted (the new
  run re-renders and re-shows); the canvases themselves roll back to the anchor time.
- **`create_share_link` (the agent path):** on interactive own-avatar owner turns only, the chat route's
  `onShareLink` makes or reuses a login-required share link for a PPTX card (this turn's `shownAttachments`
  first, then persisted messages). Its refusal for a segment no owner message started keyed on a
  finalized visible turn, which only the retired background phase produced (a steer follow-up turn is never
  finalized early), and every ok result names the conversation's other active links (`otherActiveLinks` — a link never follows a rebuild).
  The tool text lives in `agent/fileOutputTools.ts`; gates, validity and the viewer in
  [`share-links.md`](share-links.md).

## Visual canvas (`mcp__canvas__show`)
- CSP-SAFE port of Superpowers' visual companion: the avatar DECLARES content
  (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional
  `controls` (buttons/text); the CLIENT renders
  sanitized content (DOMPurify; mermaid `securityLevel: strict`; **`vega` = a compact Vega-Lite spec
  compiled+rendered to an SVG STRING via the CSP-safe `vega-interpreter` AST evaluator — no `Function`
  ctor, so `script-src` needs no widening**; all lazy-loaded with a source-`<pre>` fallback) + real form
  controls — no avatar JS runs, CSP unchanged. `canvasTools.ts` (NOT self-gated — registration is the
  boundary) is registered (runCapabilities' `canvasActive`) whenever the conversation's canvas tool group is on AND
  `events.onCanvas` exists — always-on since 2026-10, when it graduated from the experimental `canvas` flag
  (a stored `canvas` key just normalizes away). **A canvas never waits** (design D8 — pi's
  broker cannot hold a call for a person; the builder has no blocking mode): controls always render NON-blocking (the `wait:false` path), the
  tool returns at once, and the submission arrives as the user's next message. Known edge: while a run is still
  open the client does not submit an async canvas (`submitCanvas` returns while streaming). The BLOCKING path —
  controls parked on the SAME `awaitResponse`/`/api/chat/respond` path as `onQuestion`, the `canvas` prompt kind
  — stays in the route and client but no pi run takes it; its rules, kept for that path: **a parked form must
  stay ENABLED while `pane.streaming` is true** (`CanvasTab` locks on `streaming` only for the new-turn paths —
  async submit, re-submit, content edit; locking the blocking form deadlocked the question, 8aed88d), and while
  parked the frame handler pins the status line to `캔버스 응답을 기다리는 중…`. The curated MCP tool labels live in `shared/sdkToolPresentation.ts`
  (`MCP_TOOL_LABELS`) so server status line and client activity rows agree.
  Artifacts persist on `AgentResponse.canvases` and rebuild
  on reload (`canvasesFromMessages`); live via SSE `canvas` event → a `CanvasTab.svelte` tab of the side
  panel (`SidePanel.svelte`, shared with opened files — [client.md](client.md) § Side panel). **Refine-in-place:**
  `show` takes an optional `canvasId`; reusing it UPDATES that artifact (client `handleCanvas` +
  `canvasesFromMessages` AND server `record()` all upsert by id, latest-wins). **Size-cap:** `canvasTools.ts`
  rejects over-`MAX_CANVAS_CONTENT_CHARS` content (it rides the session's context on every later turn).
- **`html` is a PAGE in its own sandboxed document, never `{@html}`.** `CanvasHtmlFrame` renders
  `canvasHtmlDocument` (`lib/canvasHtml.ts`: DOMPurify `WHOLE_DOCUMENT`, a theme base sheet first in `<head>`)
  as `<iframe sandbox="allow-same-origin" srcdoc>` — NEVER `allow-scripts`; same-origin alone lets the panel
  measure the page and load same-origin images, and the inherited CSP still blocks remote loads. Why: the
  body-only default sanitize silently DROPPED every `<style>` ahead of the content (the parser hoists it into
  `<head>`) while a later one restyled the WHOLE app. Three traps, each hit in Chromium
  (`tests/visual/canvas-isolation.spec.ts` pins them): (1) nothing in the srcdoc may be FETCHED as a stylesheet —
  a font-CSS `@import` hung behind a dead proxy and render-blocked the page blank — so the app's `@font-face`
  rules are copied inline; (2) the page is hooked once PARSED (rAF poll for a new `about:srcdoc` document past
  `loading`), not on `load`, which waits for every subresource; (3) no ResizeObserver on the page's own root —
  observing another document's element tripped the observer's loop error — so the page refits on its own
  `load`/`toggle`/`change` (capture) and `fonts` `loadingdone` events, and the observer watches only the
  frame's width. `fitCanvasFrame`: the frame's CSS height (panel `60vh`, fullscreen the whole stage) is the
  viewport a viewport-filling page keeps; a shorter page shrinks the frame, a longer one grows it, and growth
  that only chases the viewport (`min-height: 100vh` + padding) stops. Fullscreen forwards the page's wheel
  (zoom) and keydown (Escape) — events inside the frame never reach the app's DOM. Links inside don't open.
- **A drawing (`svg`/`vega`/`mermaid`) renders in its own SHADOW ROOT, never `{@html}`.** An `<svg><style>` is
  a stylesheet for the whole document, so in the app's DOM an avatar's drawing restyled the app (in Chromium a
  `.canvas-panel {…}` rule inside an svg hid the panel). `shadowSvg` (CanvasTab) keeps the drawing's own
  sheet — mermaid's id-scoped one included — inside the drawing, gives each copy (panel/fullscreen) its own id
  scope, and carries the two app rules that sized it (`:host([data-fit]) svg { max-width: 100%; height: auto }`
  in the panel, natural size in fullscreen). The root is OPEN so export (`getSvgEl`) reads the `<svg>` out of
  it. A shadow root rather than the html frame: the same containment for a drawing, while sizing, zoom and
  export stay as they were. Only markdown and the source `<pre>` fallback still parse into the app's DOM
  (`showRendered` keeps exactly one surface up; async renders swap only when they land).
- **mermaid runs with `htmlLabels: false`** (labels as SVG `<text>`). Its default HTML labels ride
  `<foreignObject>`, which the svg-profile sanitize strips, so flowchart/class/state/ER/mindmap/kanban drew every
  node as an empty box; sequence/gantt/pie/timeline/journey/quadrant/xychart/gitGraph already used `<text>`. Use
  the ROOT `htmlLabels` key — `flowchart.htmlLabels` is deprecated and loses to it. The visual spec renders all
  six affected types and fails if a label goes missing (e.g. after a mermaid upgrade).
- **mermaid is PARSED server-side before display (#69)** — the client-side render error was a banner only
  the user saw, so the avatar never learned its diagram broke. `show` runs `checkMermaidSyntax`
  (`agent/mermaidCheck.ts`) with the SAME `mermaid` package the client bundles; a parse error returns as an
  agent-facing tool error (parser detail + the quote-the-label fix) and NOTHING is shown. It runs in an
  `eval` worker thread, not in-process: under Node DOMPurify loads as an empty shell, and the worker's
  pass-through stub (it only parses, never renders) must stay out of the server's module graph; a hung parse
  is cut at 5 s and the idle worker exits after 60 s. **FAIL-OPEN by contract** — boot failure, a failed
  self-test (a quoted-label flowchart that exercises the stub), a timeout or a TypeError/ReferenceError is
  `unverified` and the canvas shows as before; only a real parse verdict rejects. A self-test failure the
  WORKER reports switches the check off for the process; a timeout or crashed worker just retries next call.
  Known blind spot: a parse that hangs here (mermaid's entity regex on a pathological source) is shown anyway
  and can freeze the user's tab the same way — rejecting on timeout would break fail-open.
  `tests/agent-mermaid-check.test.ts` asserts `{ ok: true }` (not merely "not rejected") for 16 diagram
  types, so a mermaid upgrade that silently darkens the check fails there. A parse-clean source can still fail
  in the client's layout/render step — that case stays user-only.
- **A PARKED canvas (the blocking path above) survives a conversation switch ONLY through the run-event
  replay.** `record()` runs at
  resolve time, so a parked ask is NOT in the canvas tables yet; returning to the conversation rebuilds the
  form purely from the journal's `canvas` frame (`tests/routes-chat-canvas-park.test.ts` +
  `tests/client-canvas-park.test.ts` pin both halves). To keep that return possible at all,
  `selectConversation`/`addConversationToSplit`/ChatView-onMount fire `attachActiveRun` WITHOUT awaiting it —
  it resolves only at RUN end, and awaiting it held the sidebar's per-conversation busy lock (disabled
  button) for the whole park; pane-REPLACING navigations abort the dropped panes' reader loops
  (client-side only — the run stays reattachable). Split view mounts the SAME side panel (`SidePanel`
  for the ACTIVE pane) inside a `.chat-layout` wrapper — before, a canvas created while split was invisible
  entirely. The replay that rebuilds the form is HISTORY to the returning pane (`lastEventId` →
  `seenThrough`): it selects nothing, and with no tab picked the panel's default prefers the latest canvas
  still pending — so the parked ask shows, a refinement in place included, and the default moves on once
  the replayed `prompt_resolved` clears it. E2E pin: `tests/visual/canvas-park-return.spec.ts`.
- **Interactive UI is NOT a canvas type (2026-11-11).** The experimental `widget` content type lived here for
  a day; it became inline UI, which the avatar writes in its answer text — "Inline UI" below. `show` answers a
  call that still passes `contentType: 'widget'` (an older conversation's frozen prompt) with an error that
  redirects there, the manual topic id `canvas-widget` redirects to `inline-ui`, and both names plus the
  experimental key `canvasWidget` are retired and reserved. Rows an unreleased build stored are left alone: a
  `widget` canvas is an ordinary panel tab that shows its source with a notice, and a `kind: "widget"` message
  attachment draws nothing.
- **A render failure in the browser reaches the avatar on the NEXT turn** (`lib/canvasReport.ts` →
  `POST /api/canvases/:canvasId/render-report` → `CanvasRenderReportQueue`, in memory on the store →
  `buildPiTurnPreamble`, once): vega/mermaid render errors. Reports are tied to the canvas version, merged
  per version, dropped when a new version is shown or the canvas/conversation is deleted, kept for a turn
  whose canvas is off; every miss is ONE 404. (Inline UI has the same loop over its own route.)
- **Questions default to AskUserQuestion, not canvas controls** — controls are for decisions ANCHORED to
  the artifact on screen (stated in the standing canvas guidance + the `show` description). `describe_system`
  reports canvas availability via runCapabilities' `canvasActive` → `ctx.canvasEnabled`, carrying the same redirect.

## Inline UI (UI the avatar writes in its answer)
- **The avatar writes component tags straight into its ANSWER TEXT; the chat draws them in place
  (2026-11-11, the user's call: behave like ChatGPT's Intelligent UI and the repo it was ported from).**
  Markdown and UI are one text: `{@state}`/`{@const}` directives, `{#each}`/`{#if}` blocks and JSX-like tags
  with a JavaScript-subset expression language, between ordinary Markdown. There is NO tool call, NO canvas,
  NO side panel, NO experimental flag and NO server step: the text streams as any answer does, is stored as
  the message's text, and the viewer's browser detects, parses and evaluates it. The parser and interpreter
  are ported from `mireiffe/mirineereum` (`src/lib/genui` @ `0e469c4`, with the owner's permission; each
  file's header says so) and live in `src/shared/widget/` — the directory keeps the name from the canvas
  type it started as.
- **What makes the model write it: a standing brief in the prompt.** `inlineUiPromptSpec()`
  (`src/shared/widget/guide.ts`, ~5.6k chars, generated from the spec table) is appended for a run where
  `AgentRequest.inlineUiEnabled` is true — an interactive chat turn a person watches in the app: never
  `headless`, never `externalTaskApi`, never a consultation (their text is read by a machine or another avatar,
  where tags would be noise). ONE predicate decides it, `inlineUiAllowed` (`agent/ownerState.ts`), computed
  once in `runCapabilities`; it depends on no tool group, flag or events sink, and every viewer class gets it.
  `describe_system` reports the same state live (`- Inline UI: AVAILABLE in this run …` / `NOT available …`
  with the reason), and the manual topic `inline-ui` holds the full reference (its page sits ~200 characters
  under the 16 000 cap — the next component means splitting the topic). The prompt is frozen per conversation,
  so two things cover the edges: a routine or task-API turn of a conversation that began as a chat hears
  `Answer format (this turn): plain Markdown only …` in its turn preamble (`inlineUiOffTurnNote`), and a
  conversation that predates this has no brief at all — it learns inline UI only from `describe_system`, the
  manual and the redirecting errors. The brief is NOT in the 18 000-char standing-prompt tripwire
  (`tests/system-manual.test.ts`); its own size is pinned in `tests/widget-guide.test.ts`. The brief also says where: the FINAL answer text —
  text written before a tool call is folded into the reasoning view (`text_fold`), where tags are not drawn.
  A chart the user only needs to SEE goes here too (`<chart>`), not on a `vega` canvas; the canvas is for a
  side-panel artifact worked on together.
- **Never executed code.** The browser walks an AST (`interp.ts` — no `eval`/`Function`, `script-src`
  unchanged); every native call is CHARGED (a callback wrapper ticks per call, array/string methods spend
  steps proportional to the receiver, every string a coercion builds is charged, `JSON.stringify` serializes
  a sanitized copy) and one render has an OUTPUT budget (`beginRender`: 20 000 elements / 2 000 000
  characters / 1 000 000 steps) on top of the per-block window. **A new method or global in `interp.ts`
  charges its work before it runs** — the red-team probes that found the uncharged paths are regressions in
  `tests/widget-runtime.test.ts`. Model text reaches the DOM as text nodes only; colours and backgrounds are
  token names; nothing a model writes becomes a `style`, `class`, `href` or `src`.
- **ONE table is the grammar's home: `src/shared/widget/spec.ts`** (`WIDGET_COMPONENTS`). The static check,
  the renderer's prop handling, the manual's reference (`widgetComponentReference()`) and the prompt's
  component list (`widgetComponentBrief()`) all read it — add a component or prop THERE. The one hand copy
  is `detect.ts`'s tag-name list (it must import nothing); `tests/widget-detect.test.ts` fails on drift.
- **`parseAnswer(source, { streaming })` (`template.ts`) is the answer's parser; `parseWidget` stays the
  strict whole-source one** (server examples, tests). An answer differs from a UI-only source in four ways:
  (1) at the top level only a KNOWN component name opens an element — any other `<name>`, a stray closing
  tag, an HTML comment, an unknown `{@…}` is the answer's own Markdown/HTML, and a BLOCK-level HTML tag
  there (`HTML_BLOCK_TAGS`: `table`, `div`, `form`, `details`…) is an HTML block as it is to Markdown: it
  runs to the next blank line and nothing inside it is ours (a `<col>` of its `<table>`); (2) component
  names that are also HTML (`details`, `table`, `select`, `input`, `button`, `link`, `progress`) are judged
  by `isHtmlLookalike` at the top level — ours with a prop the component cannot do without, any
  `{expression}` value or a prop only the component has (`variant`, `tone`), HTML with an HTML-only
  attribute (`rel`, `max`) or nothing that tells: `<details><summary>`, a task list's
  `<input type="checkbox">` and `<link rel="stylesheet">` stay HTML; (3) a construct the text ENDS inside of
  (a tag whose `>` has not come, an open `{`, half a keyword) is cut: the parse starts over on the text
  before it (`StreamCut`), `end` says where, `pending` names the component being written, and an element or
  block that is merely still open keeps its children so far and is `partial`; (4) `problems` are advice,
  the tree is drawn anyway — so **a mistake costs its own LINE, never the rest of the answer** (`resume`): a
  `}` or a closing quote that was left out ends the construct at its line end instead of at some later `}`
  (the strict parser's recovery swallowed every paragraph after it, which nobody saw while a document with
  problems was not drawn at all). While streaming, a syntax error counts as "still being written" only
  within the last ~40 characters of the text; further back it is a real one and the answer goes on being
  drawn. A lone backtick in prose does not run into the fence after it, and a backtick run with a backtick
  later on its line is inline code (as `detect.ts` reads it). `tests/widget-template.test.ts` parses EVERY
  prefix of a sample answer and requires zero problems, and pins each of these.
- **`containsInlineUi` (`detect.ts`) decides per answer, cheaply** — a line scan for a component tag or a
  directive at the start of a line, outside fenced code. ChatView runs it on every answer (verdict cached
  for long texts) and lazy-loads `components/widget/AnswerUi.svelte` (the parser, interpreter and
  components) on the first yes; until the chunk arrives the answer's place shows a placeholder, never raw
  tags, and a failed load falls back to plain Markdown. A false "maybe" costs nothing: `AnswerUi` draws an
  answer without UI through the same block renderer as any answer.
- **`AnswerUi` draws the WHOLE answer** — one instance for the live bubble and one for the stored message
  (the same instance while its end drains in and after, so it is not remounted): `parseAnswer` →
  `buildAnswerItems` (`lib/widgetView.ts`: top-level Markdown runs + evaluated UI blocks, with source
  offsets) → `answerPieces` (`lib/answerLayout.ts`: interleaves the anchored cards the way
  `bubbleSegments.ts` does; a card anchored inside a UI block comes right after it; adjacent UI blocks are
  one layout). Markdown runs go through `lib/streamMarkdown.ts` exactly like a plain answer; UI blocks
  through `WidgetNode`. **A block whose source, the state values and the document's declarations are
  unchanged is not evaluated again and keeps its nodes** (`AnswerViewCache`), so while an answer streams
  only the block being written changes and the charts above it do not redraw per token; `values` keeps its
  identity until a declaration changes. A component whose tag is still arriving at the top level gets a
  placeholder (`widget-slot-pending`); inside an open container nothing is shown for it.
- **Lenient on purpose — the answer is already on screen and cannot be retried in that turn.** A tag that
  does not exist is dropped where it stands and its children are still drawn; an unknown prop is ignored; a
  required prop that was left out draws as its empty value (`emptyValue` — an unlabelled slider, a control
  that does nothing) and only one with no empty value (an icon name, a `send` text) is an error node; a node
  that throws is ONE error node and its siblings still render. The strictness moved to the advice:
  `widgetProblems(doc)` (the static checker in answer mode) + `collectWidgetProblems` + failed handlers and
  charts are posted by `lib/canvasReport.ts` (`queueInlineUiReport`) to
  `POST /api/conversations/:conversationId/ui-report {messageId, errors}` — only for the conversation's
  LATEST stored answer, never while it streams (the report goes out on the update where `streaming` turns
  false: a turn's end almost always drains in first) — and reach the avatar once, at the start of its next turn,
  under "Inline UI render report". Server side (`store.reportInlineUiRenderErrors` /
  `takeInlineUiRenderErrors`, a second `CanvasRenderReportQueue` keyed by message id — same merging, caps
  and TTL): 204 when queued OR ignored (not the conversation's latest assistant message), 400 for a missing
  `messageId` or a non-array `errors`, 404 for a conversation that is not the caller's, session auth only;
  `errors: []` clears a waiting report; a report whose message is no longer the latest answer when the turn
  takes it (regenerate, rewind) is dropped; consumed only by a run where inline UI is on, never a compaction
  or a steer's follow-up turn.
- **What a control will do is DECLARED as a prop, so the user sees it before pressing** — there is no free
  `send()`/`open()` action (the original's are deliberately not ported). `<button>` takes EXACTLY ONE of
  `onClick` (local state), `send` (the text becomes the viewer's next chat message through the pane's
  ordinary send — tooltip "보낼 메시지: …", locked while the avatar answers, ≤ `MAX_SEND_CHARS`, the
  composer's draft and staged files untouched) or `href`; `<link href>` and inline `[text](https://…)` open
  http(s) only (`safeLinkUrl`) in a new tab; `<image src alt>` takes only an image of THIS conversation
  (`conversationImageRef`; the client checks the conversation id). **A `send` text may never start with `/`**
  (it arrives exactly like a typed message, where a leading slash is a chat command): refused statically for
  a literal, at render for a computed text, and again in `sendWidgetMessage`. `<submit values={…}>Label</submit>`
  is the structured way back: it posts the label followed by `- key: value` lines as the viewer's next
  message through the same path (`normalizeSubmitValues` caps it) — it no longer rides `canvasSubmission`.
  Still absent on purpose: remote or `data:` images, `Math.random`, anything that loads.
- **`<chart>` has two forms and ONE pipeline.** `type` + `data` (+ `xKey`, `series`, `stacked`,
  `horizontal`, `unit`, `title`) is the short form for bar/line/area/pie/donut — `simpleChartSpec`
  (`src/shared/widget/chart.ts`) turns it into a Vega-Lite spec; `spec` takes a whole Vega-Lite spec for
  anything else; exactly one of the two (`oneOf`). Both go through `renderVegaSvg` (inline data only, AST
  evaluator, sanitized SVG in a shadow root), re-rendered per animation frame behind a token guard and
  skipped when the spec is unchanged.
- **A DIAGRAM is a ` ```mermaid ` code block of the answer, not a tag (2026-11-11, the user's pick over a
  `<mermaid>` component).** It is the form a model writes anyway, so it also works in a conversation whose
  frozen prompt predates it, and the component table and the `inline-ui` manual page are untouched (mermaid's
  `{ }` and `-->` would have needed a raw-text child kind in the parser). It is a property of the client's
  Markdown, not of inline UI: `lib/dom.ts` calls `syncMermaidBlocks` (`lib/mermaidBlock.ts`) after it wraps a
  `<pre>` — in `enhanceMarkdown` (a whole render: every block is final) and in `markdownBlocks` (a live
  answer) — so every surface that renders Markdown through them draws it (answers with or without UI tags,
  the thinking and plan cards, routine results and prompts). **A block that is still being written stays
  code**: `StreamBlock.open` (`lib/streamMarkdown.ts`) marks the last block of a healed text unless it is a
  fence whose closing line has come (judged on the text as written — the healing closes an open fence for
  display), and `markdownBlocks` re-syncs a block whose html is the same but whose `open` changed. Everything
  is kept ON the wrapper element (`data-diagram` = `code` | `drawing` | `drawn` | `failed`, a `.code-view`
  소스 toggle, a `.code-diagram` shadow host, a note), never in the html, so the "same html as a whole
  render" bar holds. Results are cached by (theme, source) — an answer is mounted up to three times (live
  bubble → drain → stored message) and a hit draws in the same task; a failed parse is cached too. Drawn, the
  block takes the page's surface (mermaid draws for the app's light/dark background, not the fixed dark code
  surface — the `--code-*` set is re-pointed for that state only); 소스 on, or a failure, is an ordinary code
  block. One renderer serves this and the `mermaid` canvas (`lib/mermaidRender.ts`: `securityLevel: strict`,
  SVG-text labels, DOMPurify, `suppressErrorRendering` — without it a failed parse leaves mermaid's "Syntax
  error" picture under `<body>`); a theme flip redraws every diagram through ONE store subscription.
  **Nothing checks the source before it is on screen** (the canvas's server-side `mermaidCheck` has no tool
  call to ride), so a diagram that cannot be drawn keeps its source with one line saying why and bubbles a
  `diagramerror` event; the `diagramProblems` action hands its ENGLISH line to the inline-UI render report
  (`AnswerUi` keeps a failure that lands while the answer still drains in; ChatView reports for the plain
  stored answer) — latest answer only, to the avatar's next turn. A library that did not LOAD
  (`MermaidLoadError`) is not the avatar's mistake: nothing is reported, nothing is cached, and the note
  carries 다시 그리기. The avatar hears of the form from the inline UI brief ("Diagrams"), the canvas section,
  both describe_system lines and the `canvas-operations` page; the `mermaid` CANVAS stays for a side-panel
  diagram worked on with the user. Pinned by `tests/client-mermaid-block.test.ts` and, in a real browser
  under the app's CSP, `tests/visual/inline-ui.spec.ts`.
- **`<svg>` is a drawing bound to state, checked THREE times.** `src/shared/widget/svg.ts` is its grammar: an
  allowlist of 20 elements and of attributes per element, every VALUE validated by SHAPE and re-emitted from
  the parsed form — never a blocklist. (1) the static check, (2) `svgRender.ts` re-validates the EVALUATED
  values and builds the markup, (3) the client still runs DOMPurify's svg profile and draws into a shadow
  root updated in place (`lib/widgetSvg.ts`, `shadowSvg`). Ids are namespaced per view and node. ≤ 500
  elements and 60 000 characters per `<svg>`, charged to the render's output budget. Left out on purpose:
  `use`, `marker-mid`, filters, animation, `image`, `a`, `style`/`class`/`href`/`on*`, nested `svg`,
  `font-family`. Icons are an enum of the names `Icon.svelte` draws (`icons.ts`; a test fails on drift).
- **State is per ANSWER and stays in the viewer's browser.** A stored message's values are mirrored to
  `localStorage` under `noah:inline-ui:<userId>:<conversationId>:<messageId>` (`lib/widgetState.ts`: only
  setter-changed values, 300 ms debounce flushed on `pagehide`/hidden, a 200 000-char cap measured with
  `dataSize` BEFORE serializing, the 50 most recent answers, removed with the conversation, every access
  guarded; a conversation deleted in this page load is never written to again, so a pending save cannot
  bring its key back; a client-made message id that is replaced by the server's moves its key). A live
  answer has no message id yet: its changes stay in memory and are handed to the stored message when the
  turn ends (the live handover in the same file), so a slider moved mid-answer does not jump back. The entry
  is bound to the run and to the answer text it was written in: only the same run's live bubble (the chat
  view was reopened mid-stream) or the stored answer whose text continues that text takes it — an older
  answer with the same declaration, mounted first on the way back, does not. The focused control's key rides
  along (`data-wg-key`), so a field the viewer was typing in keeps the focus across the remount at turn end. A value applies only while its declaration text (`sig`) is unchanged. Never sent to the server
  — the avatar cannot read it; only a pressed `send`/`<submit>` reaches the conversation. Keys of the retired
  canvas type (`noah:canvas-widget…`) are swept once per page load.
- **Evaluation is one pass, in one place** (`lib/widgetView.ts`), and the `components/widget/*` components
  only draw the view model — no component reads state inside a helper, which is what keeps Svelte's
  legacy-mode stale reads out. Re-evaluation is deferred until a running handler returns (evaluating puts
  the runtime back in its render phase, where setters do nothing). A control whose handler refuses or clamps
  the value is written back to the STATE value after the handler, so what the user sees is what is sent.
- **A snippet of an answer that cannot draw UI uses `inlineUiPlainText`** (`detect.ts`: the prose with the UI
  source lines left out) — the OS notification body does (`notifyTurnComplete`). A new place that shows part
  of an answer as plain text takes the same helper.
- **A chart ENTERS when it appears now; a redraw is at rest (2026-11-11, the user's pick over a second
  chart engine).** Vega draws ONE static SVG string that is written whole into the shadow root, so there is
  no previous value to tween from: only a chart's first appearance moves (`lib/chartEntrance.ts`). Bars grow
  from the line they stand on (which way they stand is read from their THICKNESS — bars of one band are
  equally wide or equally high, whatever is stacked; the line is the edge every category has — the zero
  line, also for negative and stacked bars; ranged bars with no common line each grow from their own
  start; one category after the other), a line or an area is wiped in from the left with its points, the
  slices of a pie arrive in turn while the circle settles, anything else fades; axes, legends and titles
  stay still. The plan is read off Vega's OUTPUT (`g.role-mark` + `mark-<type>` classes,
  `aria-roledescription="bar"`, a rectangle's box from its path `d` — no layout read), so a Vega bump that
  renames one of those draws charts at rest and fails `tests/client-chart-entrance.test.ts`, which plans
  against real Vega output. Every step is a Web Animations keyframe with `fill: backwards` — the sanitized
  markup is never edited — created PAUSED in the task that wrote the SVG (no frame of the finished chart
  first) and released by an IntersectionObserver when ANY part of the chart is on screen (never a share of
  its height: a faceted chart taller than the window would stay held for good). **When it plays** is
  shared with every other entrance (`lib/uiEntrance.ts`; `WidgetCtx.entrance`, built by `AnswerUi`): in an instance that showed the answer while it was written (the live
  bubble, a stored message whose end drained in — latched, because Vega draws a moment after the tag
  arrived) and in the stored message that continues the live text (`continuesEntranceText` — a turn
  can end before a chart of its last lines was drawn) a chart enters ONCE per pane and run, however often the answer is mounted
  (`claimEntrance`: the stored message gets nothing, or the REST of an entrance that is still
  running — a step that is already over is not created again, since `play()` would rewind it); after the viewer changed something in the answer, every chart they bring up enters (a tab);
  an answer opened from the history, a state change of a chart that is already there and a theme flip are
  at rest. 움직임 줄이기 (`prefersReducedMotion()`, read when it starts) draws at rest. The `vega` CANVAS is
  untouched. No chart library with transitions was adopted for this: a second engine would have split the
  `spec` form, the theme and the "sanitized SVG in a shadow root" boundary.
- **The rest of the UI enters by the same rule (2026-11-11, the user's pick of all four).** Each top-level
  component of a UI block rises in as it appears (`enterChildren` on `.answer-ui`: a MutationObserver names
  a component by its PLACE in the block, which the live bubble and the stored message share); a `<stat>`
  value that is ONE number counts up from zero in its own format (`WidgetStatValue` + `countUpFormat` —
  the final text stays in the layout, hidden, so the card keeps its size; a date, a ratio or a word rises
  instead); a `<progress>` bar fills (and a CHANGED value glides on a 160 ms CSS transition); the first 12
  rows of a `<table>` arrive in turn (a sort moves none). A value the viewer changes is simply the new
  value. Keys are places (`stat:<node key>`), a chart's key is its spec. jsdom has neither Web Animations
  nor an IntersectionObserver, so component tests see everything at rest; the motion is pinned by
  `tests/client-ui-entrance.test.ts` and, in a real browser, `tests/visual/ui-gallery.spec.ts`.
- **A ```mermaid diagram arrives in order (2026-11-12, the user's pick: tailored to the common kinds).**
  `lib/mermaidEntrance.ts` plans it off mermaid's own SVG, like the chart's: a GRAPH (flowchart, state, ER,
  class, mindmap share one renderer — `g.clusters`, `g.nodes > g.node`, `g.edgePaths > path`,
  `g.edgeLabels`) shows its frames, then the nodes one after the other (opacity only — a node is placed by
  its `transform` attribute), then each edge WIPED from its first point to its arrowhead (a clip along the
  axis it mostly runs on, so the marker is uncovered last and a dotted edge keeps its dashes) with its label
  behind it; a SEQUENCE diagram is read top to bottom by each part's smallest `y`/`y1` (participants, each
  message drawn the way it is sent, notes and loops, the bottom row last); anything else fades its parts in
  in document order, and more than 160 parts fade as one. The order of a graph is the order mermaid WROTE
  it, not a walk of the graph. **When**: `lib/mermaidBlock.ts` has no `WidgetCtx` (it is the Markdown's), so
  its rule is its own — a block that was seen OPEN and then closed notes its source (`written`), and
  whichever mount of the answer draws that source first claims the entrance (`claimEntrance`, scope
  `mermaid`, key = the source; `renewEntrance` lets the same diagram enter again in a later answer); under
  `[data-entrance="always"]` (the gallery's stage) it enters at every mount. History, a theme flip and the 소스
  toggle are at rest. jsdom cannot lay a diagram out, so the unit test plans against cut-down real output
  and the real structure is pinned in `tests/visual/ui-gallery.spec.ts`.
- **A lone Web Animations keyframe is the END, not the start.** `[{ opacity: 0 }]` animates FROM the
  element's own value TO 0 and then snaps back — a fade-out. Every "from nothing to what it is" step pins
  its one keyframe with `offset: 0`; the visual spec reads the HELD value (a slice, a node, a progress bar
  below the fold is at 0) because a keyframe-shape assertion cannot tell the two apart.
- **The gallery (`#/uiGallery`, `views/UiGalleryView.svelte`) is a client view of SAMPLES, not an endpoint
  and not a second renderer.** `lib/uiGallery.ts` holds one small answer per thing an avatar can draw and
  each is drawn by `AnswerUi` itself in its PREVIEW mode (the `outbox` prop): what a `send` button or a
  `<submit>` would post is handed to the host and shown under the sample, nothing is kept in
  `localStorage`, nothing is reported, and its charts enter each time it is opened. Every approved user may
  open it; it is not in the rail (opened by its address). `<image>` is source only — an image belongs to a
  conversation. `tests/client-ui-gallery.test.ts` fails when a component of the table or a chart type has
  no sample, or a sample does not pass the static check and the evaluator; **a new component or chart type
  gets its sample there.** In a real browser: `tests/visual/ui-gallery.spec.ts`.
- Verified in a real browser by `tests/visual/inline-ui.spec.ts` (the app's CSP on the document, a negative
  control, Vega under it, a reload, and a streaming answer that must never show a tag as text) and in jsdom
  by `tests/svelte-chat-inline-ui.test.ts`; the `local` demo runtime's `demo ui` streams such an answer.
