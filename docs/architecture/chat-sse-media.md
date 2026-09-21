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
  `env` option) so resume survives a restart. `greeting` (ephemeral) and `regenerate` (re-runs a turn)
  start a fresh session. SDK `cleanupPeriodDays` (default 30) sweeps old transcripts — conversations idle
  >30d resume as new.
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
- **Tool permissions go through one gate:** the `PreToolUse` hook (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` are unused (don't fire headlessly). Auto-approve applies on the
  `!headless && elevated && autoApprove` path — **`elevated` = owner OR trusted user**, not owner-only;
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
  foreground** (`run_in_background:true` rewritten to `false` via `updatedInput`).
  Verified on the bundled CLI 2.1.222 (subagents background-by-default since ~2.1.198): a background
  subagent's tool calls consult NEITHER SDK-callback hooks NOR `canUseTool` NOR even bare `allowedTools`
  entries, and every permission-needing call is auto-denied with user-refusal wording ("The user doesn't
  want to take this action right now"), which the avatar relays as the user having refused. Upstream
  treats the subagent-hook gap as known/unplanned (claude-code #34692, #27661). Bash KEEPS
  `run_in_background` (a running shell makes no further tool calls, and timeout auto-backgrounding is
  Bash-only), so the background phase below still exists — it is just Bash-fed now. Re-verify on every
  SDK bump and drop the rewrite once bg subagents inherit the session's permission wiring.
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
  chip from `pane.backgroundTasks`, keeps the live tree mounted until `bg_end`, then re-PUTs the sealed
  snapshot onto the first message (`backgroundMessageId`). Replay-safety: every message push dedupes by
  id (a reattach replays the whole event log). Known v1 limits (deliberate): a new `POST
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
  the SDK-BUNDLED CLI 2.1.251 (the SDK spawns its own binary, never the machine's `claude`):
  (1) `command_lifecycle {command_uuid, state: queued|started|completed|cancelled}` keyed by OUR uuid is
  the ONLY delivery signal — a folded steer is never echoed back as a stream `user` message, `started`
  is the moment the text reached the model, and `result.queued_turn_count` LIES (0 with a steer still
  queued), so never read it; (2) with no tool boundary left a queued message runs as a SECOND turn right
  after the first `result`, even if stdin was closed at that result, and the public `Query` interface
  has no way to cancel a queued message — so an undelivered steer at a boundary ALWAYS means a follow-up
  turn; (3) the wire shape is the verified DEFAULT one (`steerToSdkUserMessage`) — no `origin`,
  `priority` or `shouldQuery`, and `priority:"now"` stays unused BY DESIGN because it ABORTS the running
  turn. **`SteerChannel`** (`agent/steerChannel.ts`) is the per-run queue + state machine between those
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
  steer is simply another wake-up turn and its answer rides the existing `bg_message` path.
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
  every mode.** Regenerate re-reads the
  prior user turn's stored attachments from disk (`readChatImages`). `express.json` limit was bumped
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

## Generated-file delivery + PPTX deck pipeline (`share_file`, hidden publishes)
- **`chatFiles.ts` mirrors `chatImages.ts` for agent-GENERATED documents** (there is deliberately NO
  upload path): `mcp__file_output__share_file` → `onShareFile` (routes/chat.ts) → `publishWorkspaceFile`
  (same realpath+roots containment; extension allowlist pptx/docx/xlsx/zip/pdf/csv/md/txt/drawio with
  magic-byte checks for the container formats; 30 MB cap) → bytes at
  `dataDir/chat-files/<conversationId>/<id>.<ext>`, metadata on `messages.attachments_json` as
  `kind:"file"` (+`size`). Download route `GET /api/conversations/:id/files/:fileId` is owner-scoped and
  ALWAYS `Content-Disposition: attachment` (never inline; `?name=` only picks the sanitized save-dialog
  name — the client card passes it). Sweeps: conversation bulk/single delete + regenerate mirror the
  image sweeps, and **user-delete (routes/admin.ts) snapshots the owner's conversation ids BEFORE
  `store.deleteUser`** to rm both chat-images and chat-files dirs (the rows are gone afterwards).
- **`MessageAttachment.hidden`** = published for URL use only: `show_file` with `hidden:true` stores the
  image + returns its serving URL to the model (for canvas markdown embeds), but every ChatView render
  loop filters hidden entries. Per-turn caps: 6 visible images (unchanged), 30 hidden, 3 files —
  enforced in the `onFile`/`onShareFile` handlers, counted per kind off `shownAttachments`.
- **Deck (PPTX) pipeline**: bundled `pptx` skill = python-pptx authoring (NanumGothic — 맑은 고딕 is not
  in the image, LibreOffice would silently substitute) → `share_file`. **Delivery previews are
  SERVER-AUTOMATIC**: the `onShareFile` handler calls `renderDocumentPreviews` (deckRender.ts —
  async execFile soffice→pdf with an isolated profile, then `pdftoppm -l 30`; **direct pptx→png
  converts only the FIRST slide**; pdf skips soffice; also docx/xlsx) and attaches the pages via
  `savePreviewImages` (chatImages.ts, trusted-input hidden PNGs) — best-effort, a render failure
  still delivers the file. The agent renders manually (scripts/render_deck.sh + hidden `show_file`
  + ONE canvas markdown) only for mid-work review/self-check. **Availability = boot-time probe**
  (`deckRender.ts`, memoized `spawnSync` soffice/pdftoppm/python-pptx — a NEW pattern, nothing else
  probes at boot), threaded per-run like `fileOutputEnabled`: `AgentRequest.deckRenderingEnabled`
  (probe && fileOutput) drives the promptBuilder `deckSection`, `SystemToolsContext.deckRenderingAvailable`
  the describe_system line (UNAVAILABLE → "admin must rebuild the image"). Docker: `libreoffice-impress` +
  `fonts-nanum` + `poppler-utils` via apt mirror; `python-pptx` is NOT in Debian → pip at build with
  `PIP_INDEX_URL`/`PIP_TRUSTED_HOST` build-args (compose passthrough).
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
- **Regenerate caveat:** replacing the last assistant turn deletes its attachments (images AND files),
  so a canvas from the REPLACED turn loses its embedded slide images — accepted (regenerate means
  "redo the turn"; the new run re-renders and re-shows).

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
