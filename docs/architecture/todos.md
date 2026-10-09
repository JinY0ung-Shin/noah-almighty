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
  (`TodoItem`, `TodoCounts`, `TodoSnapshot`, `TodoListResponse`), limits, `isTodoToolName`,
  `todoDueBucket`, and `compareTodos` — the ONE display order (open before done; open by due date,
  dated first so overdue leads, then priority high→low, then oldest; done newest completion first),
  used by the server listing AND the client's optimistic inserts. `src/server/todos.ts`
  (`parseNewTodo`/`parseTodoPatch`) turns raw API/MCP input into a normalized value or a
  `TodoInputError` CODE; each caller maps codes to its own channel (`KOREAN_TODO_ERROR` in
  `routes/todos.ts`, an English map in the tools), mirroring `parseRoutineSchedule`.
- **Due dates are KST calendar dates, date only, optional** (user decision 2026-10-09). They are
  validated by `normalizeCalendarDate` and "today" comes from `kstDateString` — both in
  `routineSchedule.ts`, the one home of schedule/date math (it is also in the client tsconfig).

## Storage (`store/todos.ts`, `withTodos`)
- Columns: `title` (one line, ≤200), `note` (markdown, ≤4000), `done` + `completed_at`, `priority`
  (`high|normal|low`, default `normal`), `due_date` (`YYYY-MM-DD` or NULL), `tags_json` (≤5, ≤30 chars,
  `#` stripped, case-insensitive dedupe — more than 5 distinct tags is an ERROR, not a silent drop),
  `source` (`user|avatar|routine|api`), `source_conversation_id`, `created_at`/`updated_at`.
- **Open cap `MAX_OPEN_TODOS` (500) is checked INSIDE the write transaction**: a batch that would cross
  it is refused whole (`LIMIT`), and REOPENING a done item counts like a new one. Completed items are
  not capped; a listing returns every open item plus the newest `MAX_LISTED_DONE_TODOS` (200) done
  ones, and 완료 항목 비우기 (`clearCompletedTodos`) removes all done rows, listed or not.
- `completed_at` is stamped on open→done, cleared on done→open, untouched by other edits.
- A batch shares one base timestamp, offset 1 ms per item, so the caller's order survives the
  oldest-first tiebreak of the shared order.
- **The source-conversation link needs no cascade.** Every read goes through a `LEFT JOIN conversations`
  on the same owner, so the id is surfaced only while that conversation exists AND belongs to the
  item's owner; deleting a conversation (any of the many deleting paths) silently cuts the link and
  the item stays. `deleteUser` deletes the rows (`store/admin.ts`); there is no on-disk state.

## HTTP (`routes/todos.ts`, mounted after routines)
- `GET /api/me/todos` → `{ todos, todayKst, counts }`; `POST /api/me/todos` → 201 `{ todo, todayKst,
  counts }`; `PATCH /api/me/todos/:id` (`dueDate: null` clears; `done` toggles) → `{ todo, … }`;
  `DELETE /api/me/todos/:id` → `{ ok, … }`; `DELETE /api/me/todos/completed` (registered BEFORE `/:id`)
  → `{ removed, … }`. Every destructive route is a DELETE: a body-less destructive POST would be a
  simple request a same-site intranet form could send under SameSite=Lax cookies (there is no CSRF
  token), while a DELETE needs a CORS preflight.
- Every response carries the snapshot (`todayKst` + `counts`), so the client buckets items by string
  comparison against the server's KST date and never derives the date itself.
- Session-only (a Bearer `noah_` key is a 401 here, like every route outside `/api/v1/avatar/tasks`),
  `Cache-Control: no-store`, strictly self-scoped (every query is keyed by the caller's id — a foreign id
  is a 404). Errors are Korean: 400 validation, 404 unknown, 409 open cap — a REOPEN refused at the cap
  has its own wording (`TODO_REOPEN_LIMIT_MESSAGE`; the tool says "could not be reopened").

## Avatar tools (`agent/todoTools.ts`, server `todo`)
- `list_todos` (status open|done|all, `dueBefore` exclusive KST date, tag, query, `includeNotes`),
  `add_todos` (1–`MAX_TODOS_PER_ADD` items, all-or-nothing through `parseNewTodo`), `update_todo`
  (`parseTodoPatch`; `done` completes/reopens, `dueDate` null/"" clears), `delete_todo`. English text;
  `ENGLISH_TODO_ERROR` maps the shared codes. EVERY result starts with
  `Today (KST): YYYY-MM-DD (Ddd) · open N, overdue N, due today N` (`kstDateWithWeekday`). The system
  prompt deliberately carries no date (see below), so this header — plus the date the `/todo` expansion
  writes into its own user message — is what lets the model resolve "내일까지"/"다음 주 금요일".
- **Gate (runPlan):** `todoToolsActive = systemToolsEnabled && ownerToolAccess && !groupAgentRun &&
  !consultationRun` — an interactive own-avatar chat, an owner routine (headless with tools opted in) and
  an external-task-API turn; never a teammate's chat, a group agent, a consultation or a generic headless
  run (intro/hashtag generation). It rides the always-on `system` family rather than a tool group, so a
  saved tool-group selection (`selected_*` / `*_default` store explicit lists) or a group's
  `allowed_mcp_tool_groups` policy can never silently drop it. `todoDeleteActive = todoToolsActive &&
  !externalTaskApi`: an API-submitted turn is machine-authored, so withholding delete is a SPEED BUMP
  against an injected, irreversible removal of items — not a full boundary: `update_todo` stays
  available (it can still rewrite titles and memos), and per CLAUDE.md a leaked key IS the owner's
  session. `delete_todo` is then left out of the server, has its OWN `allowedTools` entry on the same boolean
  (the `create_share_link` precedent), and its handler refuses anyway. Every handler re-checks
  `viewerIsOwner` (the `mcp__` auto-allow fires before any owner check).
- `list_todos` marks titles and memos as stored DATA, never instructions — items a routine or the task
  API added can carry machine-authored text into later, more capable interactive runs.
- **Server-name collisions are reported, not silent.** A plugin `.mcp.json` server whose name an app
  server takes in a run (e.g. a plugin `todo` server on an owner run) is still overridden by the app
  server, but runPlan reports it — `agentLogger.warn` plus a `플러그인 경고: …` status line; runs where
  that app server is inactive still register the plugin's. This covers every app server name.
- Created items are stamped `source` = `api` (external task API) / `routine` (headless) / `avatar`, and
  linked to the run's conversation. Writes are audited as `todo_tool_add|update|delete` with ids/counts
  only — never titles.
- **Not TodoWrite.** The built-in TodoWrite/TaskCreate are the avatar's private per-run checklist that
  vanishes after the turn; every tool description and the prompt section say so, and TodoWrite's
  activity label is "작업 체크리스트 갱신" so the status line never reads as the user's 할 일.

## Metacognition and guidance
- **The prompt section is STATIC — no counts, no date.** The append is re-rendered every turn
  (`snapshot: false`) and any change to it invalidates the cached prompt prefix, so a count that moved
  between turns (an add, a checkbox, a routine) or KST midnight would re-bill the whole history at
  cache-write rates. The live state lives where caching does not care: `describe_system` (counts +
  date from `summarizeOwnerState`'s lazy `todos` snapshot, read once per call) and every tool result's
  header. `AgentRequest.todoState` therefore carries only `deleteEnabled`. Both surfaces read the SAME
  `todoToolsEnabled` / `todoDeleteEnabled` booleans the server build and `allowedTools` key on.
- The prompt's `todoSection` (owner + routine branches, only on runs that have the tools) states the
  tools, the TodoWrite distinction, delete availability, and the STANDING policy the user asked to be
  situational ("유동적", 2026-10-09): an explicit request or
  `/todo` → add now and confirm in one line; a clear action item the OWNER owns → offer ONCE at the end
  of the reply, batched, add only what is accepted; no offers for ideas, casual mentions or others'
  tasks, none again after a decline; unattended runs add as instructed and report; check for
  near-duplicates first. The group-agent branch states it has no to-do list, and colleague/teammate
  runs get one static line: the viewer's 할 일 can only be changed by their OWN avatar — point them to
  the 할 일 tab, the card's quick add or a chat with their own avatar (`/todo`), never TodoWrite/TaskCreate,
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
  other). Writes bump a sequence at start AND settle, and a GET that overlapped a write is dropped. A
  FRESH read (an avatar's `mcp__todo__*` tool_end, a failed write's resync) that joins an in-flight
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
- **The chat card** mounts once inside the active pane's `.chat-body`, so it can never cover the
  composer and an open canvas/file panel moves it left with the column. A `ResizeObserver` picks the
  mode (no layout read in `onMount`): pinned from a 1000px chat column; while pinned the transcript pads
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
- The card's empty-state hint only suggests asking the avatar in the viewer's OWN avatar pane — a
  colleague's avatar has no `mcp__todo__*` tools (its prompt says so).
