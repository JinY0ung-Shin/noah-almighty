# 할 일 (work to-do list)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> One persistent to-do list per user, edited from the 할 일 tab, the chat overlay, and the owner's own
> avatar (`mcp__todo__*`).

## Shape of the feature
- **ONE store, three editors.** Rows live in `todo_items` (SQLite). The 할 일 tab and the chat overlay
  edit them over `/api/me/todos` (session auth); the owner's avatar edits them with the in-process
  `mcp__todo__*` tools. Both paths validate through the SAME pure module and write through the SAME
  store mixin, so a UI edit and an avatar edit can never disagree about what is valid.
- **Contract layers.** `src/shared/todos.ts` is the import-free client↔server leaf: wire types
  (`TodoItem`, `TodoCounts`, `TodoSnapshot`, `TodoListResponse`), statuses (`TODO_STATUSES`,
  `isOpenTodo`), limits, `isTodoToolName`, `todoDueBucket`, and `compareTodos` — the ONE display order
  (open before closed; open items in progress first, then by due date, dated first so overdue leads,
  then priority high→low, then oldest; closed items — done and dropped together — newest close first),
  used by the server listing AND the client's optimistic inserts. `src/server/todos.ts`
  (`parseNewTodo`/`parseTodoPatch`) turns raw API/MCP input into a normalized value or a
  `TodoInputError` CODE; each caller maps codes to its own channel (`KOREAN_TODO_ERROR` in
  `routes/todos.ts`, an English map in the tools), mirroring `parseRoutineSchedule`.
- **Four statuses in two classes** (user decision 2026-10-10). `todo` (시작 전) and `in_progress`
  (진행 중) are OPEN; `done` (완료) and `dropped` (드랍 — the owner decided not to do it) are CLOSED.
  OPEN is what everything "current" counts: the 500 cap, `counts.open` (in progress included), the
  overdue/today buckets and the rail badge, the chat card and the prompt snapshot. Any status may move
  to any other, and closed → open is a REOPEN (cap-checked like a new item). `closedAt` is when the item
  reached its CURRENT closed status (done → dropped re-stamps it), null while open. `TodoItem` has no
  `done`/`completedAt` on purpose: they were removed so the compiler flagged every former use for its
  open/closed meaning — test open-ness with `isOpenTodo`, never `status !== "done"` (a dropped item
  would leak into every open list).
- **Due dates are KST calendar dates, date only, optional** (user decision 2026-10-09). They are
  validated by `normalizeCalendarDate` and "today" comes from `kstDateString` — both in
  `routineSchedule.ts`, the one home of schedule/date math (it is also in the client tsconfig).

## Storage (`store/todos.ts`, `withTodos`)
- Columns: `title` (one line, ≤200), `note` (markdown, ≤4000), `status`, `done`, `completed_at`, `priority`
  (`high|normal|low`, default `normal`), `due_date` (`YYYY-MM-DD` or NULL), `tags_json` (≤5, ≤30 chars,
  `#` stripped, case-insensitive dedupe — more than 5 distinct tags is an ERROR, not a silent drop),
  `source` (`user|avatar|routine|api`), `source_conversation_id`, `created_at`/`updated_at`.
- **`status` is the source of truth; `done` is a MIRROR every statement writes with it** (1 iff
  closed), so a ROLLBACK to a pre-status build still reads done AND dropped items as done.
  `migrateTodoStatuses` (boot) adds the column to pre-status DBs and RECONCILES: a row whose `done`
  disagrees with its status (or whose status is no known value) takes its status from `done` — the
  upgrade backfill (`done = 1` → `done`) and the roll-forward repair of rows a rolled-back build
  completed or reopened by `done` alone (a reopened dropped row comes back `todo`). It is UNGATED on
  purpose — value-guarded, not a `user_version` ladder backfill — because this build never writes a
  row that disagrees, so the predicate can only match rows a pre-status build wrote. **Keep every
  INSERT/UPDATE writing both columns**, or the next boot would silently "repair" live rows. The
  `(owner_user_id, status, due_date)` index replaced the `(owner, done, due_date)` one (created in the
  migration, after the column exists; a rollback build re-creates the old one harmlessly).
- **Open cap `MAX_OPEN_TODOS` (500) is checked INSIDE the write transaction**: it counts todo +
  in_progress; a batch that would cross it is refused whole (`LIMIT`), and REOPENING a done or dropped
  item counts like a new one. Closed items are not capped; a listing returns every open item plus the
  newest `MAX_LISTED_CLOSED_TODOS` (200) done AND, separately, the newest 200 dropped (a long
  completion history never hides the dropped ones), and 완료 항목 비우기 / 드랍 항목 비우기
  (`clearClosedTodos(owner, "done" | "dropped")`) removes every row of that status, listed or not.
- `completed_at` (`closedAt`) is stamped on every move INTO a closed status, cleared on a move to an open
  one, untouched while the status stays put. A new item is always open (`NewTodo.status`: todo, or
  in_progress when it is already under way); creating one closed is refused (`INVALID_STATUS`).
- A batch shares one base timestamp, offset 1 ms per item, so the caller's order survives the
  oldest-first tiebreak of the shared order.
- **The source-conversation link needs no cascade.** Every read goes through a `LEFT JOIN conversations`
  on the same owner, so the id is surfaced only while that conversation exists AND belongs to the
  item's owner; deleting a conversation (any of the many deleting paths) silently cuts the link and
  the item stays. `deleteUser` deletes the rows (`store/admin.ts`); there is no on-disk state.

## HTTP (`routes/todos.ts`, mounted after routines)
- `GET /api/me/todos` → `{ todos, todayKst, counts }`; `POST /api/me/todos` → 201 `{ todo, todayKst,
  counts }`; `PATCH /api/me/todos/:id` (`dueDate: null` clears; `status` moves it) → `{ todo, … }`;
  `DELETE /api/me/todos/:id` → `{ ok, … }`; `DELETE /api/me/todos/completed` and
  `DELETE /api/me/todos/dropped` (both registered BEFORE `/:id`) → `{ removed, … }`. Every destructive
  route is a DELETE: a body-less destructive POST would be a
  simple request a same-site intranet form could send under SameSite=Lax cookies (there is no CSRF
  token), while a DELETE needs a CORS preflight.
- Every response carries the snapshot (`todayKst` + `counts`), so the client buckets items by string
  comparison against the server's KST date and never derives the date itself.
- **An already-open tab running an OLDER bundle keeps working.** Every item a route sends goes through
  `toWireTodo`, which adds the pre-status fields — `done` (true for ANY closed item, so a dropped one
  leaves that tab's open list too) and `completedAt` (= closedAt); they are not part of `TodoItem` and
  nothing current reads them. PATCH still accepts the legacy `done` when `status` is absent (true →
  done, false → todo — that bundle has no other status, so its 되돌리기 after completing an in-progress
  item lands on 시작 전); both present is `INVALID_STATUS`, even when they agree. The client mirrors this
  on INGESTION (`fromWireTodo` / `fromWireCounts` in `lib/todos.ts`, applied to every item and snapshot
  entering the store): a NEW bundle reading a PRE-status server — a rollback, or a dev box whose fresh
  `dist/client` is served by the still-running old process — maps `done`/`completedAt` onto
  `status`/`closedAt` and missing counts to 0, so the list never comes up empty; items are rebuilt in
  one fixed shape (the legacy keys dropped), so an unchanged re-read keeps the list's identity. Its
  writes still fail there (an old server reads `{status}` as an empty patch) with the usual rollback
  toast.
- Session-only (a Bearer `noah_` key is a 401 here, like every route outside `/api/v1/avatar/tasks`),
  `Cache-Control: no-store`, strictly self-scoped (every query is keyed by the caller's id — a foreign id
  is a 404). Errors are Korean: 400 validation, 404 unknown, 409 open cap — a REOPEN refused at the cap
  has its own wording (`TODO_REOPEN_LIMIT_MESSAGE`; the tool says "could not be reopened").

## Avatar tools (`agent/todoTools.ts`, server `todo`)
- `list_todos` (status open|todo|in_progress|done|dropped|all — open = todo + in_progress, the default;
  `dueBefore` exclusive KST date, tag, query, `includeNotes`), `add_todos` (1–`MAX_TODOS_PER_ADD` items,
  all-or-nothing through `parseNewTodo`; an item may start `in_progress`), `update_todo`
  (`parseTodoPatch`; `status` moves it — the tool has no `done`, `dueDate` null/"" clears),
  `delete_todo`. English text; `ENGLISH_TODO_ERROR` maps the shared codes. Lines carry `[ ]` todo /
  `[~]` in progress / `[x]` done / `[-]` dropped (the legend is stated once per listing), closed ones
  with their KST close day. EVERY result starts with
  `Today (KST): YYYY-MM-DD (Ddd) · open N (in progress N), overdue N, due today N` (`kstDateWithWeekday`). The system
  prompt carries no TODAY date — the frozen snapshot's timestamp is worded as not today's (see below) —
  so this header — plus the date the `/todo` expansion
  writes into its own user message — is what lets the model resolve "내일까지"/"다음 주 금요일".
- **Gate (`buildRunCapabilities`, `agent/runCapabilities.ts`):** `todoToolsActive = systemToolsEnabled && ownerToolAccess &&
  !consultationRun` — an interactive own-avatar chat, an owner routine (headless with tools opted in) and
  an external-task-API turn; never a teammate's chat, a consultation or a generic headless
  run (intro/hashtag generation). It rides the always-on `system` family rather than a tool group, so a
  saved tool-group selection (`selected_*` / `*_default` store explicit lists) or a group's
  `allowed_mcp_tool_groups` policy can never silently drop it. `todoDeleteActive = todoToolsActive &&
  !externalTaskApi`: an API-submitted turn is machine-authored, so withholding delete is a SPEED BUMP
  against an injected, irreversible removal of items — not a full boundary: `update_todo` stays
  available (it can still rewrite titles and memos), and per CLAUDE.md a leaked key IS the owner's
  session. `delete_todo` is then left out of the server, has its OWN `mcpAllowedTools` entry on the same boolean
  (the `create_share_link` precedent; the `/mcp` endpoint refuses a call outside that list), and its handler
  refuses anyway. Every handler re-checks `viewerIsOwner` (handlers self-gate whatever the endpoint admits).
- `list_todos` marks titles and memos as stored DATA, never instructions — items a routine or the task
  API added can carry machine-authored text into later, more capable interactive runs.
- **Status changes follow the owner's word** (the update_todo description, the prompt's standing
  sentence and describe_system all say it): in_progress when they say they started, done when they
  finished (or the avatar finished a task they gave it — the 아바타에게 맡기기 seed asks for exactly
  that), dropped when they decide not to do it — never on a guess, and an abandoned item is DROPPED,
  not deleted, unless they explicitly ask to delete. The activity row names the target status
  (`mcpToolInputSummary`: 진행 중으로 표시 / 완료로 표시 / 드랍으로 표시 / 시작 전으로 표시).
- **Server-name collisions are reported, not silent.** A plugin `.mcp.json` server whose name an app
  server takes in a run (e.g. a plugin `todo` server on an owner run) is still overridden by the app
  server, but the run plan reports it — `agentLogger.warn` plus a `플러그인 경고: …` status line; runs where
  that app server is inactive still register the plugin's. This covers every app server name.
- Created items are stamped `source` = `api` (external task API) / `routine` (headless) / `avatar`, and
  linked to the run's conversation. Writes are audited as `todo_tool_add|update|delete` with ids/counts
  only — never titles.
- **Not a private checklist.** pi has no TodoWrite/TaskCreate (its built-ins are
  read/write/edit/ls/find/grep/bash), so the prompt section says a working note the avatar keeps for itself
  is never the owner's list, and every tool description keeps the "never a private per-run checklist"
  wording. TodoWrite's activity label ("작업 체크리스트 갱신") stays only so SDK-era activity rows render.

## Metacognition and guidance
- **The prompt never reads the LIVE list — it states a snapshot FROZEN per conversation.** The pi prompt
  is itself frozen per conversation (`conversations.pi_instructions`, rendered at the first pi turn), and the
  snapshot predates that rule: a count that moved between turns (an add, a checkbox, a routine) or KST
  midnight must never change the stable prompt prefix the model caches. The list therefore rides as
  `conversations.todo_snapshot` (a column, so it dies with the conversation — no cascade): taken ONCE at
  the conversation's first to-do-capable turn (`buildRunCapabilities` → `resolveConversationTodoSnapshot`,
  `agent/todoSnapshot.ts`; `ensureConversationTodoSnapshot` reads first and takes the write lock —
  IMMEDIATE, re-check, `take` inside — only while the column is NULL) and read back verbatim afterwards —
  never refreshed, not after an idle gap, a KST day change or a rewind (user decision 2026-10-10, chosen
  over refresh-when-the-cache-is-cold knowing that a routine's long-lived thread and a thread resumed
  days later keep their first snapshot). So the block is worded in the PAST against its own timestamp,
  never as "today": "as of <KST time>, frozen for this conversation (never refreshed; that is not
  today's date — to-do tool results carry today's): N open, of which N were overdue and N due that
  day", then tells the model to call `list_todos` before saying what is open, due or overdue, or changing
  an item (a pre-existing conversation took its snapshot at its first turn after the column shipped, not
  at its start — "as of" stays true). Content: the first `TODO_SNAPSHOT_ITEM_LIMIT` (20) open items in
  the shared display order (so in-progress ones first, marked `in progress`; the head names
  `(N in progress)` only when there are some) — JSON-quoted titles, due date, non-normal priority, and
  `added by a routine` / `added by the task API` on machine-authored items (this is the most trusted
  prompt position such text can reach); never memos, tags or closed items — then "…and N more". A
  snapshot stored before statuses existed lacks `status`/`inProgress` and parses as `todo`/0 — exact,
  since nothing could be in progress then — so it renders byte-identical to before. Same gate as the tools
  (`todoToolsActive`), so a teammate's or consultation run neither takes nor sees it. No
  block when the row is missing (the chat route and the task-API submit create it before the run and a
  routine's exists from its creation, but a routine whose thread was deleted re-creates it only AFTER
  its next run, so that one run goes without), when the stored value is unreadable (the parse is strict:
  canonical four-digit-year instant, real calendar dates, known priority/source/open status — nothing is re-taken),
  or when the to-do read throws (logged; the turn goes on, nothing is stored, a later turn retries).
  Never refreshing has a privacy edge: a title the owner later deletes or rewrites stays in the prompt of
  every conversation that captured it — like anything said in that conversation's transcript — and
  deleting the conversation is the purge. The LIVE state lives where caching does not care:
  `describe_system` (counts incl. in progress/dropped + date from `summarizeOwnerState`'s lazy `todos`
  snapshot, read once per call, plus the status rule) and every tool result's header. Both surfaces read the SAME `todoToolsEnabled` /
  `todoDeleteEnabled` booleans the server build and `mcpAllowedTools` key on.
- The prompt's `todoSection` (owner + routine branches, only on runs that have the tools) states the
  tools, the private-checklist distinction, delete availability, and the STANDING policy the user asked to be
  situational ("유동적", 2026-10-09): an explicit request or
  `/todo` → add now and confirm in one line; a clear action item the OWNER owns → offer ONCE at the end
  of the reply, batched, add only what is accepted; no offers for ideas, casual mentions or others'
  tasks, none again after a decline; unattended runs add as instructed and report; check for
  near-duplicates first; the status rule above. Colleague/teammate
  runs get one static line: the viewer's 할 일 can only be changed by their OWN avatar — point them to
  the 할 일 tab or a chat with their own avatar (`/todo`), never TodoWrite/TaskCreate,
  never claim it was added.
- `/todo <내용>` is a server slash expansion (owner-only, English) that states today's KST date in the
  user message (cache-neutral); a REGENERATED `/todo` re-expands, so it resolves relative dates against
  the regeneration day. The manual has a `todos` topic, and `sdkToolPresentation.ts` labels the tools
  할 일 조회/추가/수정/삭제.

## Client (`lib/todos.ts`, `views/TodosView.svelte`, `components/TodoOverlay.svelte`)
- **One store slice** (`appState.todos` = items + `todayKst` + counts + `loaded`) feeds the rail badge
  (overdue + due today), the 할 일 tab and the chat card, so a checkbox in one is instantly in the
  others. Writes are optimistic with rollback + a Korean toast; every response's `{todayKst, counts}`
  replaces the snapshot, and inserts land in the shared `compareTodos` order.
- **Loads never invalidate each other.** Concurrent callers share ONE in-flight GET (a direct
  `#/todos` open once livelocked when the boot refresh and the tab's own load each invalidated the
  other). Writes bump a sequence at start AND settle, and a GET that overlapped any part of a write is
  dropped: the sequence moved during it, or a write that began BEFORE it is still in flight when it lands
  (the server may have answered the GET before applying that write, so its list could undo the
  optimistic change). So a slow write holds back every load until it settles — bounded by `api()`'s
  120 s timeout, whose abort still reaches the write's `finally` — and `beginWrite` runs right before
  each write's `try`, after the optimistic step, so a throw there can never leave a write counted but
  unsettled (that would freeze every load until logout). A FRESH read (an avatar's `mcp__todo__*` tool_end, a failed write's resync) that joins an in-flight
  GET queues one more read behind it; while writes are in flight it is not started at all (it would
  only be dropped) — the last write to settle starts it, exactly once. The write counter belongs to
  its session: logout zeroes it, and a write settling afterwards no longer counts. At most 4 GETs are chained; the 60 s visible-tab poll covers the rest. A
  write's response that lands after logout or session expiry is dropped.
- `startKnowledgeWatch` only (re)starts the poll; the account reset (to-do slice, selection, search,
  dismissal) lives in `stopKnowledgeWatch` — the logout/expiry/teardown path — so a `#/todos/<id>`
  deep link survives boot.
- **The editor diffs against what it loaded** (`formBase`), never against the live item: a field the
  avatar or another tab changed meanwhile is not written back with the stale form value, and typing
  during an in-flight save is kept (the next save diffs against the saved item). A save that settles
  after the editor moved to another item leaves that item's form, base and dirty flag alone.
- **Statuses in the tab** (user decisions 2026-10-10). Seven chips (the `할 일 필터` radiogroup —
  renamed from 할 일 상태 so it never shares a name with the editor's 상태 control): 오늘 · 예정 · 마감
  지남 · 진행 중 · 전체 · 완료 · 드랍. The time chips and 전체 cover OPEN items, 진행 중 the in-progress ones,
  완료/드랍 one closed status each (those two counts come from the server: a listing carries only the
  newest 200 of each). `todoListGroups` puts every in-progress item in a 진행 중 group FIRST, whatever its
  due date (an overdue one keeps its red chip there), then the due buckets of the items not started;
  완료 and 드랍 are one newest-first group each, each with its own confirmed 비우기 and 200-cap note.
  In-progress rows carry a 진행 중 tag with a leading dot (in the light theme the info blue and the 오늘
  chip's accent read alike — the dot tells them apart); dropped rows are muted, never struck through,
  never red; a closed item's due chip is `data-bucket="closed"`. The row checkbox stays one-click
  COMPLETE: checked iff done, checking any other status completes with 되돌리기, unchecking a done item
  makes it 시작 전.
- **The editor's status control** (상태 — it replaced the old 완료 checkbox) is a labelled group of four
  `aria-pressed` segments (`.seg-control`) with MANUAL activation: arrows/Home/End only move focus,
  click/Enter/Space applies. Each pick is a write that re-sorts the list and may toast, so
  selection-following-focus would write — and toast 완료 for — every status the arrows pass. A pick
  applies at once, outside the form's 저장, and a second pick for that item is ignored until its PATCH
  settles. Closing (완료/드랍) from anywhere shows 되돌리기, which restores the status the item HAD
  (`closeTodoWithUndo`: an in-progress item returns to 진행 중, not 시작 전); the stamp reads 완료 … / 드랍
  … from `closedAt`. 아바타에게 맡기기 seeds "시작하면 진행 중으로, 끝나면 완료로 표시…", so the avatar
  moves the item on the owner's word. Real-browser facts are pinned in `tests/visual/todos-tab.spec.ts`
  (geometry only, no screenshots): the control stays one unclipped row in the editor at 1440/1100/1000/
  900/390 px, nothing scrolls sideways, the seven chips stay in their row, dark mode still marks the
  pressed segment, the 진행 중 tag has its dot and the 오늘 chip none, and arrows/Home/End write nothing
  while Enter and Space each send exactly one PATCH (jsdom cannot turn Enter/Space into a click).
- **The chat card** mounts once inside the active pane's `.chat-body`, so it can never cover the
  composer and an open canvas/file panel moves it left with the column. A `ResizeObserver` picks the
  mode (no layout read in `onMount`): pinned from a 1000px chat column — top-right, growing with its list
  down to the composer (`max-height: 100% − 2×12px`, it was a fixed 50% that cut rows mid-line) and then
  scrolling, the list's bottom edge masked to a fade while rows remain below (`.has-more`, read in the
  scroll handler, a list `ResizeObserver`, after a paint plus once more after the motion window whenever
  the sections change, and on `document.fonts.ready` — never in the mount task); while pinned the transcript pads
  its right side by `clamp(24px, 2×328 + 800 + 24 − W, 328px)`, so nothing moves from 1456px, the full
  800px column shifts left down to 1152px, and below that it narrows to W − 352 (648px at the
  threshold) with the card 12px beside it. Narrower columns get a popover above the composer (the
  `.composer-tools-panel` spot), and a ≤860px viewport a full-width sheet. The transient modes use the
  shared frosted material (opaque under `prefers-reduced-transparency`); the pinned card uses an OPAQUE
  elevated surface instead — it stays up beside a scrolling, streaming transcript with nothing behind
  it to frost, and a permanent backdrop blur would re-composite on every transcript repaint.
- **Two ways to close.** The × and the composer toggle switch the per-browser preference
  (`noah.todoOverlayOpen`, default OFF, storage errors tolerated) off; an outside click, Escape or
  leaving for the 할 일 tab only DISMISSES a popover/sheet for now (`todoOverlayDismissed`, never
  persisted). **Only the pinned card shows up on its own:** a mount whose FIRST measured mode is
  transient (a reload on a narrow layout, a pane switch) starts dismissed unless the toggle itself
  opened it, so a popover never lands on the newest messages unasked; the column widening back to
  pinned clears the dismissal. The toggle reads as pressed only while the card is actually shown. Escape
  anywhere, the composer included, dismisses a transient card unless an IME composition is active,
  another handler already called `preventDefault` (slash menu, rewind editor) or kept the key from
  reaching `window` (the DM dock stops propagation at its root), or focus is in a dialog.
- **What the card does** (user decisions 2026-10-10, widened 2026-10-21). A checkbox completes with a
  되돌리기 toast; a title opens the item in the tab. Each row's ACTIONS start it (진행 중으로, ▶) or put an
  in-progress one back (시작 전으로, ⏸), and drop it (드랍, ⊘ — never trash: drop is not delete) with
  `closeTodoWithUndo`'s 되돌리기, which restores the status it had; a start/pause has no toast (the row
  moving into or out of 진행 중 is the feedback), and a second action on a row — its checkbox included —
  is ignored until its PATCH settles (a component-local `busy` set). An action taken from the keyboard
  keeps focus in the card: on the moved row's same button, or after a drop on the next row's title (the
  previous one at the end), else the card itself (the tab's delete precedent). Adding stays the 할 일 tab's form or the viewer's own avatar
  — the card's quick-add was removed 2026-10-10 and stays removed. On a hover-capable pointer the
  actions share the trailing grid cell with the row's meta (`opacity: 0` yet focusable, so
  `:focus-within` reveals them; the meta goes `visibility: hidden`) — the cell is always as wide as the
  wider of the two, so revealing them never re-ellipsizes the title, and the 22px buttons sit in the 16px
  line box with negative margins, so a row stays one checkbox line. That reveal is for a `(hover: hover)
  and (pointer: fine)` pointer only, and the meta hides only on hover or while an ACTION holds focus — a
  focused checkbox or title keeps the due date visible (and in the accessibility tree). Under
  `(hover: none), (pointer: coarse)` the actions get their own always-visible column, and on a coarse
  pointer the actions, chips and section toggles are 44px targets (the component's own sizes would
  otherwise outrank the global rule). An explicit toggle focuses a TRANSIENT card through a temporary
  `tabindex=-1` (dropped on blur) and Escape returns focus to the toggle; a pinned card leaves focus on
  the toggle. The empty state points to the avatar (`/todo`) or the 할 일 tab in the viewer's OWN pane,
  and to the 할 일 tab only in a colleague's pane — a colleague's avatar has no `mcp__todo__*` tools (its
  prompt says so).
- **Rows carry their meta in one line**: a high-priority `!` badge (`role="img"`, outside the title
  button so its name stays the title), the first tag (`#tag +N`, ≤84px), and in the trailing cell a memo
  icon, a ✦ for an item the avatar/routine/API added (`todoSourceTitle`) and the due label. In-progress
  items get no per-row badge: they lead the card in their own 진행 중 section.
- **Sections** (`overlaySections(items, today, limit, collapsed)`): 진행 중 · 마감 지남 · 오늘 · 다음 over ALL
  open items in the shared order (an in-progress item sits ONLY in 진행 중). The first
  `TODO_OVERLAY_LIMIT` (8) items of the EXPANDED sections get rows; each heading is a fold button
  (chevron, label, `members.length`) and a COLLAPSED section shows only that, spending none of the row
  budget — so folding 진행 중 lets more of 다음 show. An expanded section left with no rows is omitted and
  counts into `hidden` (the footer's "외 N개"). The folded ids persist per browser
  (`noah.todoOverlayCollapsed`, `lib/layout.ts`, unknown ids and junk read as none). An avatar's
  addition inside a folded section pops that heading's count (`todoSectionArrivalSeq`), not the footer.
  Both pops play only while `avatarChangeFlushing()` (read when the `{#key}` remounts): the viewer's own
  fold or start that moves a still-marked row past the budget never pops anything.
- **The header sums up the day.** Below the title row, `todoTodayProgress`: 오늘 완료 N (done items whose
  `closedAt` falls on the server's KST day — a listing carries the newest 200 done, so today's are in it)
  · 남음 M (open items overdue or due today, in progress included), with a progress bar (`--ok` once
  nothing is left, and NOT animated — only the avatar's changes move); the text is a button into the tab's
  오늘 filter, the `role="progressbar"` beside it (a button's children are presentational). 오늘 완료
  counts anything closed today, undated items included, while 남음 counts only overdue/due-today ones, so
  the bar can read full after a day of other work — by design, not a due-work tracker. Then chips — 진행 중 / 마감 지남 / 예정,
  only the non-empty ones, counted by the tab's own `todoFilterCounts` — each opening the tab on that
  filter (`openTodosFiltered` also clears the tab's search, so the list matches the chip's count; a
  transient card is dismissed first). Their accessible names
  (`마감 지남 1개, 할 일 탭에서 보기`) differ from the section headings' on purpose. No progress line when
  N + M is 0; no summary block when there is also no chip.
- **Minimize is the PINNED card's** (`noah.todoOverlayMinimized`, per browser; one fixed name, 할 일
  최소화, with `aria-pressed`): the header's − folds
  everything under it (`.todo-overlay-content[hidden]`) and the counts line adds `· 마감 지남 N · 오늘
  N/M`; the transcript's reserve stays, so minimizing never reflows the conversation. A popover/sheet is
  transient already: the button is absent there and the preference is kept but not applied.
- **Only the avatar's OWN changes animate** (user decision 2026-10-10: motion on avatar add/delete plus
  a count pop; never auto-open the card). A successful to-do tool end other than `list_todos`
  (`noteTodoToolEnd`) bumps a counter and stamps the time; every GET covers the ends counted at its
  START, whether it applies or fails. An applied load runs `diffAvatarChange` only while that claim is
  uncovered and its GET STARTED within `TODO_CLAIM_MAX_AGE_MS` (5 s) of the last tool end (so a slow
  read still animates, while a poll a minute later never does), and the list was already loaded (an
  applied load never overlaps a viewer write — it would be stale) — so the first load, the 60 s poll,
  failed-write resyncs, pending-row swaps and the viewer's own edits never animate; an avatar change
  whose read overlapped a viewer write is re-read once the last write settles, and animates only if that
  read starts within the 5 s window. `added` = brand-new rows with `source: "avatar"` or reopened rows
  (closed → open); `changed` = edited and still open (a todo ↔ in_progress move included — the row
  changes section and arrives in the new one like any row entering with the change); `departed` =
  deleted or closed (done or dropped). `noteAvatarChange` then (1)
  calls the
  `onBeforeAvatarChange` listeners while the old rows are still on screen (each in its own try/catch, so
  a throwing listener never blocks the list update), (2) records departures in a
  NON-reactive one-shot registry (`takeAvatarDeparture`; the viewer's own `writeTodo`/`deleteTodo` drop
  the id), (3) opens the flush flag (`avatarChangeFlushing()`, closed by a 0 ms timer and by
  `beginWrite`/`mutate`), and (4) updates the `todoActivity` store (`seq`, per-row `marks`, `pop`);
  everything expires after `TODO_ACTIVITY_MS` (1.6 s), so opening the card later replays nothing, and
  `resetTodoClientState` clears it.
- **Card motion** (`TodoOverlay.svelte`): one keyed list of sections and rows stays mounted once loaded
  (the empty state is a sibling), rebuilt only when the items, `todayKst` or folded-sections references change — every
  reconcile of an `animate:` list measures every row, and the store is written per streamed token.
  Added rows rise 6px over 240 ms with a 1.2 s `--accent-soft` wash, staggered 40 ms (cap 7 steps; an
  arrival hidden by the 8-row cap pops the footer's "(외 N개)" instead); edited rows get the wash only;
  other rows entering during the change fade in (`rowIn`). Departed rows slide 12px and fade over 200 ms
  through a DEFERRED `out:rowOut|global`; siblings and sections glide with a TRANSLATE-ONLY
  `animate:glide` (200 ms — Svelte's `flip` would also SCALE a section whose height changed, squashing
  its text), and an emptied section fades. Exits and row glides start from a PRE-CHANGE snapshot: the
  `onBeforeAvatarChange` hook records each row's screen top (rows carry `data-todo-id`) before the
  list is applied, because Svelte measures a section's rows only after the sections above have already
  moved (under an addition the rows' own `from` rect is a row off). A leaving row's vertical offset is
  `(snapshot − current) + S·u`, where S is its section's glide offset — counted ONLY for a section that
  is actually gliding (`glideShift` is 0 for a leaving, `inert`/absolutely-held section, whose static
  hold offset is no glide) — so the row fades exactly where it was, in the bottom-anchored popover/sheet
  too and when parallel tool calls land in one re-read. A re-read that changed nothing keeps
  `todos.items`' identity (`sameTodoItems` in `loadOnce`): any reconcile aborts running glides without
  restarting them, and an unchanged 60 s poll no longer re-renders anything. Every gate reads non-reactive state when the transition starts, so the
  viewer's own checkbox stays instant. A PINNED card's list holds its `min-height` for 240 ms per avatar change (pinned is
  top-anchored; the bottom-anchored popover/sheet shrink from the top and need no hold — holding them
  made the rows glide up, then snap back — and nothing is held under reduced motion), and
  `.todo-overlay-body` is positioned with `overflow-x: hidden`, `scrollbar-gutter: stable` and 8px bottom
  padding, so leaving/gliding rows never overflow it (a classic scrollbar would flash and re-ellipsize
  every title). The composer's `할 일 N` pops via `{#key $todoActivity.pop}` with `todo-count-pop`
  (`30-agent-md-composer.css`; the DM badge's `dm-badge-pop` stays separate). The 1.2 s wash and the
  360 ms overshooting pop sit outside DESIGN §2.5 on purpose (the user's choice). Reduced motion: exits
  instant, glide off, arrivals fade + wash, no pops. Real-browser geometry is pinned by the motion cases in
  `tests/visual/todo-overlay.spec.ts` — pinned at 1680×1000 and the bottom-anchored popover at
  1024×768, including a section's lone row leaving and a parallel add-above + complete-below in one
  re-read (mocked SSE tool frames + a per-frame sampler measuring rows from the card's anchored edge;
  leaving rows identified by `inert`: the leaving row stays within ±2px, no row moves more than 1px
  after settling, the card resizes at most once and in the landing frame, nothing overflows, the
  viewer's own checkbox never animates or pops) — jsdom rects are all zero, so the component tests
  cannot see glide or overflow.
