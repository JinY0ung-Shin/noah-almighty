# Chat, SSE, and generated media

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> SSE sessions and history (pi sessions, rewind, steers as follow-up turns, AskUserQuestion), image attachments, `share_file` / PPTX / draw.io delivery, and the visual canvas.

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
  heals, the per-session model/effort profile and stop/cancel continuations → [`pi-runtime.md`](pi-runtime.md)
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
- **Manual `/compact` is retired (2026-10-29).** Typing it is refused like `/new`; a legacy `/compact`
  row still renders, can be EDITED into ordinary text (a normal rewind), and refuses 다시 생성. Its old
  assistant bubble (`대화 맥락을 요약해 정리했습니다…`) is plain stored text. pi compacts a long session on its
  own and emits no event for it (design P5), so no new compaction chip appears; stored `compact` activity rows
  still render.
- **Tool gate: built-ins are pi's, MCP tools are gated per call at `/mcp`.** pi's built-ins
  (read/write/edit/bash/ls/find/grep) are always on and run in the RUN PRINCIPAL's own sandbox (viewer for a
  colleague chat, the asker for a consultation, the owner otherwise — `piRunPrincipal`); pi has no per-request
  built-in allowlist, so read-only run classes get them too, in their own sandbox, never the owner's files. Noah's
  tools reach the model only through `mcp_call`, and the `/mcp` endpoint admits exactly this run's
  `mcpAllowedTools` (`allowCall`) — then every handler self-gates again. Nothing prompts for approval: there is no
  permission dialog, no confirmer, no protected-path ask. Details → [`pi-runtime.md`](pi-runtime.md) "One run"
  and [`agent-core.md`](agent-core.md).
- **AskUserQuestion ends the pi turn and resumes it inside the same Noah run.** pi answers it with
  `requires_action` + a `function_call`; `runPiTurn` (`eventAdapter.ts`) parks on `events.onQuestion` (status
  `사용자 답변 대기 중…`, the client's question modal), then sends the answer as the next request's
  `function_call_output` on the same session — the host sees ONE blocking `onQuestion`. A run with no
  `onQuestion` (headless) gets a fixed "cannot ask" answer instead. The `requires_action` id is never reported
  via `onSessionId`, so a run that dies while a question waits resumes from the last committed turn. At most 20
  question rounds per run.
- **Background work is gone.** The SDK runner's background phase (Bash `run_in_background`, background subagents,
  wake-up turns) left with it; pi's subagent (`Agent`, from the default-skills plugin) runs inside the turn and
  shows as ONE flat card (P6). A run ends at its answer (or its last steer follow-up turn).
- **Mid-turn user messages ("steers") are delivered AFTER the current answer, as ONE follow-up turn of the same
  run.** pi takes no input while a response streams (design P2), so `POST /api/chat/runs/:runId/message`
  queues the text in the run's **`SteerChannel`** (`agent/steerChannel.ts`) — the per-run queue + state machine
  (`queued` → `delivered` → `completed`, or → `dropped`): `push`/`noteLifecycle`/`noteResultBoundary`/
  `undelivered`/`close`/`onChange`, bounded by `MAX_UNDELIVERED_STEERS` (10). It rides
  `openRun` meta, `pushRunSteer(runId, userId, text)` is the only writer
  (`not_found|unsupported|closed|too_many`), and `cancelRun`/`cancelAllRuns`/`closeRun` close it so every
  undelivered record reports `dropped` BEFORE the run's terminal frame. **Delivery** (`runPiAgent`): when a pi
  response completes, every undelivered steer is taken in the same tick; none → the channel closes and the run
  ends. Otherwise `noteResultBoundary()`, `onTurnResult({steerPending:true})` for the segment just answered,
  each steer marked `started` (= delivered), and ONE follow-up pi response on the same session carries them all
  (a fresh turn preamble + the texts). A steer is plain text to pi — no slash dispatch exists there, so a
  `/new …` steer is just words; steers carry no images, no slash expansion and no canvas, and a queued steer
  cannot be cancelled. Async `ask_avatar` answers ride the same channel (see
  [`pi-runtime.md`](pi-runtime.md) "Asynchronous tools").
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
  `steer.message`, so a message the model never saw never enters history.
  **Endpoint:** `POST /api/chat/runs/:runId/message` — session cookie only (never a personal API key),
  plain text capped at `MAX_STEER_LENGTH` (20k chars); 400 empty/too long, 404 unknown/ended/other-user
  run, 409 `unsupported` (no channel) and `too_many`, 410 `closed`. **Out of scope by design:**
  external-task-API and headless turns get NO channel (`steers` undefined → `midTurnMessages` false on both
  metacognition surfaces). The `open` frame carries no delivery mode any more: the composer always says
  "지금 답변이 끝난 뒤 이어서 전달됩니다". Client: pending steers render as dimmed 전달 대기 중 bubbles above the live
  bubble, `delivered` moves them into `pane.messages`, `dropped` returns the text to the composer with a toast,
  and `turn_end` seals the bubble via `finalizeVisibleTurn` while `endLiveTurn` keeps `streaming` true. The
  delivered row's badge is derived from its POSITION (`steerBadgeLabel`): after a sealed answer segment it reads
  "답변 뒤 전달" (every steer today); rows the retired SDK runner folded between tool calls sit right after the
  turn opener and keep "응답 중 전달". **Both frames must be replay-idempotent** — they ride the ordered run-event
  log, so a reattach re-applies them (see [`client.md`](./client.md) for the wire contract).

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
- **Vision gating is PER-RUN, per-model-tier** (`modelVisionPolicy.ts`): effective vision =
  admin per-tier policy (`app_config` row `model_vision_policy`, admin panel "모델별 이미지 입력";
  `{tierId: boolean}`, absent tier inherits) ∘ deployment default (`MODEL_VISION=off` env). Resolution
  mirrors the model chain (user tier > admin override > default; a concrete model id can't consult the tier
  policy → deployment default). When the RUN's model is text-only, every path that
  would put image bytes in MODEL input is cut off BEFORE the API can 400 the whole turn — but the
  UPLOAD itself is NOT rejected: it becomes **file mode** (`imageFileMode` in routes/chat.ts). The
  bytes are persisted exactly as in vision mode (same bubble/attachment rows), a copy is staged into the
  conversation folder's `attachments/<id>.<ext>` (host view of `/workspace/c/<conv-seg>/`, listed to the model
  by sandbox path — `stagePiAttachmentFiles`) (`stageChatImageFilesFromAttachments`, the ONE staging path
  shared by the fresh turn and regenerate), and the model is told only the PATHS as plain prompt text
  (`AgentRequest.imageFiles` → `buildUserPrompt`), never image content blocks. Regenerate re-stages the
  same way instead of skipping the re-feed. The composer therefore does not hide the attach UI for a
  text-only tier — in file mode it sends the ORIGINALS (no downscale, since nothing is fed to the model).
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
  FILE (a deck's `assets/`, a document, a commit) instead of describing or redrawing it — every pi run writes
  files in its own sandbox, so there is no read-only variant (describe_system's image-sources line says the
  same, see [`agent-core.md`](agent-core.md)). A vision turn whose staging produced nothing keeps its
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
  conversation-delete path (single and bulk delete in `routes/chat.ts`, the admin user and group cascades in
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
  (`markdown`/`vega`/`mermaid`/`svg`/`html`) + optional `controls` (buttons/text); the CLIENT renders
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
- **Questions default to AskUserQuestion, not canvas controls** — controls are for decisions ANCHORED to
  the artifact on screen (stated in the standing canvas guidance + the `show` description). `describe_system`
  reports canvas availability via runCapabilities' `canvasActive` → `ctx.canvasEnabled`, carrying the same redirect.
