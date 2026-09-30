# Personal agents (내 봇)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Per-owner chat-contact bots: id namespace, the owner-only reach gate, the full-owner-capability run
> wiring, the scoped memory/skill lens, and every cascade. Phase 1 is ADMIN-ONLY by design.

## What they are
- **Several chat-contact bots per (admin) user** (`personal_agents`, cap `MAX_PERSONAL_AGENTS = 20`
  in `store/personalAgents.ts` — disabled bots still hold a slot). NOT users rows; public avatar id
  `personal:<ownerUserId>:<agentId>` (`src/server/personalAgents.ts` mirrors `groupAgents.ts`:
  prefix + fail-closed `parsePersonalAgentRef` + wire projections). Row: displayName, alias, bio,
  intro, persona, hashtags, image ext, `enabled`, `default_model` (a `modelTiers.ts` tier id that
  seeds NEW conversations client-side in `makePane`; NULL = owner's remembered default; `""`→clear
  accepted at both writers because the settings `<select>` posts `""`).
- **Reach = the owner ALONE, while they hold the system-admin role** — `findChattablePersonalAgent`
  is the single gate (detail/skills/models/chat/image): ref parse → row exists under THAT owner →
  viewer IS owner → `store.isAdmin(viewer)` → enabled unless `includeDisabled`. Null on every miss
  (no existence probe); role loss / disable fails the NEXT turn closed with history preserved
  (the group-agent membership-loss precedent). The chat turn passes `includeDisabled` solely to
  produce the dedicated Korean disabled-403 ("이 봇은 비활성화되어 있습니다…"). Sysadmins do NOT reach
  other admins' bots; discovery (`GET /api/avatars`) appends `listPersonalAgentAvatarSummaries`
  (enabled only, `[]` for non-admins).

## The A-1 capability model — the load-bearing invariant
A personal-agent run **IS a full owner run**; the bot diverges in IDENTITY plus one scoped
PERSONAL-KNOWLEDGE lens — its own memory folder and the skills the owner granted it (the two
sections below). Everything else stays FULL: secrets, git repos, plugins, group knowledge, the
access algebra itself.
- `AgentRequest.groupAgent` must NEVER be set for one — it is a triple kill-switch
  (`deriveAgentToolAccess` → ownerToolAccess false, `ownerSecrets` → `{}`, `ownerState` → empty).
  The dedicated field is `AgentRequest.personalAgent {agentId, ownerUserId}`, set by the chat route
  and consumed nowhere in the access algebra (`deriveAgentToolAccess` / `planMcpToolFamilies` are
  deliberately untouched — pinned by tests).
- **`request.avatar` is the OWNER's own avatar (`avatar.id` = owner uuid)**: every capability key
  (ownerState, secrets, plugin roots, knowledge memory, work repos, `AgentOwner` commit identity)
  works untouched — the lens rides as loader/server OPTIONS keyed on that SAME owner id, never as a
  different avatar. The composite id lives ONLY in `threadAvatarId` inside `routes/chat.ts` — the
  conversation binding (`conversations.avatar_user_id`), `workspaceDirFor` cwd, the run registry /
  SSE `open` frame, logs/audit — and in client-facing summaries. The chat route OVERLAYS the
  conversational identity onto `request.avatar` (displayName/alias/persona = the bot's, `??` so an
  empty bot persona stays empty and never inherits the owner's); that overlay is the ONLY channel
  the persona TEXT reaches the prompt on (`PersonalAgentState` carries `personaSet`, not the text).
- Conversation summaries resolve the display name via a third LEFT JOIN in `store/conversations.ts`
  (BOTH sql sites) whose string concat mirrors `personalAgentAvatarId()` — keep in lockstep, same as
  the group_agents join.

## Per-bot memory — `agents/<dir>/` inside the OWNER's repo
A bot's memory is a NAMESPACE in the owner's single knowledge repo — the same "convention over that
one store" the second brain is, not a new store.
- **The folder name is IMMUTABLE.** `personal_agents.memory_dir` is stamped at INSERT from
  `personalAgentMemoryDirName(displayName, agentId)` (`personalAgentSlug.ts`, a deliberate LEAF
  module — nothing there may import the store; `personalAgents.ts` re-exports it so route/agent
  callers keep one import path): the lowercased display name reduced to `[a-z0-9._-]` (cap 24, cut
  BEFORE trimming separators, fallback `bot` — a Korean name reduces to nothing) + `-` + the first 8
  hex chars of the row uuid, which is what actually makes the segment unique (and can never be `.`
  or `..`). `updatePersonalAgent` never writes the column, so a RENAME leaves the tree exactly where
  it is; rows predating the column are backfilled in `migrate()` through the same TS function
  (value-guarded and deliberately UNGATED by the `user_version` ladder — every INSERT writes the
  column, so `memory_dir IS NULL` can only ever match older rows).
  `personalAgentMemoryRoot(memoryDir)` is the SINGLE place that spells `agents/<dir>` (POSIX, no
  trailing slash); the parent is `PERSONAL_AGENT_MEMORY_PARENT = "agents"`.
- **Layout inside it:** `<root>/wiki/` for curated notes, `<root>/raw/` for captures, and
  `<root>/CLAUDE.md` — the bot's STANDING memory, injected into every one of its turns.
- **Enforcement is at the MCP TOOL layer, not the filesystem** — the same shape as a group agent's
  `capture_scope`:
  - `runPlan` derives `personalAgentScope` (`{root, botName}`) from `personalAgentState.memoryRoot`
    and hands it to the repo server as `pathScope` and to the brain server as `scope`. That is
    server-CONSTRUCTION parameterization only (exactly like `buildGroupAgentBrainServer`):
    `deriveAgentToolAccess`/`planMcpToolFamilies` stay UNTOUCHED, so `mcpServers`/`allowedTools`
    need no bot branch.
  - Every path-taking `mcp__repo__*` op runs `normalizeScopedPath` (`brainSearch.ts` — the guard
    shape the wiki vault already uses) BEFORE the file op, so `<root>/../../CLAUDE.md` gets the
    English redirect; `list_files` filters the tree through the same check, and every manage tool's
    DESCRIPTION carries the scope note (a tool still advertising the whole repo makes the model
    spend turns on refused paths). `knowledgeRepo`'s `resolveInRepo`/`realpathContained` remain the
    second layer.
  - `scaffold_skill` / `create_repo` stay REGISTERED but REFUSE under a scope — both are the owner's
    job from their main avatar chat, which is what every scoped refusal names instead of pointing at
    a tool this run would also refuse.
  - `commit` stages with a pathspec (`git add -A -- <root>`, threaded as `commitAndPush(…,
    {pathspec})` → `repoGitCore`): the clone is SHARED with the owner's own runs, so a bare
    `git add -A` would push their unrelated work-in-progress under the bot's commit. It also SKIPS
    the shared-skill reconcile — a bot never touches `skills/`.
  - `isBrainNotePath(path, root)` fires the 기억 activity notice for `<root>/wiki/**`.
  - Root validation fails CLOSED (`scopeBase`): an empty root, or one carrying a blank/`.`/`..`
    segment, refuses every path — and reports the vault as absent — rather than widening back to the
    whole repo.
  - The scope is STATIC per run — a bot deleted or disabled mid-run is caught by the NEXT turn's
    reach gate, not re-read here. A run whose row vanished between the reach gate and plan assembly
    falls back to a namespace keyed by the bot ID (a folder no bot writes to), so a degenerate run
    is never WIDER than a healthy one.
  - `preToolUseHook` adds an INTEGRITY guard, not a security boundary (the `activeRepoMode`
    precedent): a native `Write`/`Edit`/`MultiEdit`/`FileWrite`/`FileEdit`/`NotebookEdit`
    (`NATIVE_FILE_WRITE_TOOLS`) whose absolute path resolves INSIDE the owner's knowledge clone but
    OUTSIDE `<clone>/<memoryRoot>/` is DENIED — English reason redirecting to
    `mcp__repo__write_file`/`edit_file` + `commit` (a native write there would be neither staged nor
    committed), Korean `uiReason`. Bash is deliberately NOT parsed. The hook's existing
    `personalAgentRun` parameter is WIDENED to `boolean | PersonalAgentWriteScope`, so ONE parameter
    carries the run kind and the two bot behaviours (AskUserQuestion denial, write confinement) can
    never disagree about whether this is a bot run.
  - **Standing memory:** `loadKnowledgeRepoMemory(store, avatarId, config,
    { personalAgentMemoryRoot })` reads `<clone>/<root>/CLAUDE.md` INSTEAD of the repo-root one
    (same reader, same `PERSONAL_CLAUDE_MD_CAP`) — a bot never inherits the owner's standing memory.
    Group memory is unaffected (a bot run is a full owner run for groups).
- **Deleting a bot PRESERVES its memory folder BY DESIGN.** The cascade takes the conversations,
  tasks, routines, avatar image and workspace tree; nothing prunes `agents/<dir>/` — that content
  lives in the OWNER's repo and is theirs to keep, or to remove from their own avatar chat.

## Granted skills — `selected_skills`, an ALLOWLIST where EMPTY MEANS NONE
- **`personal_agents.selected_skills`** (JSON TEXT; the domain type is ALWAYS `string[]` —
  `parseNameList(…) ?? []`). **Empty = no knowledge-repo skills at all**, the OPPOSITE of the
  owner's own `users.knowledge_selected` where `null` = load ALL. Caps:
  `MAX_PERSONAL_AGENT_SKILLS = 64` and per-slug `PERSONAL_AGENT_SKILL_SLUG_CAP = 100`, validated in
  ONE place — `normalizePersonalAgentSkills` (shape → per-slug `[A-Za-z0-9._-]` with `.`/`..`
  refused → dedupe → count, so the count is checked against what would actually be stored), shared
  by the HTTP route and the MCP tools so neither surface becomes a cap bypass; the store's own write
  path only trims/dedupes on top. A patch is a FULL REPLACE.
- **A grant is a LIVE REFERENCE into the owner's repo** (`skills/<slug>/`), never a copy: the
  owner's later edits reach the bot with no transfer step. Contrast skill SHARING between users,
  which COPIES the directory into the learner's own repo (`skillTransfer.ts`).
- **Loading:** `loadAgentPluginRoots(store, avatarId, config, onWarn,
  { personalAgent: { selectedSkills } })` overrides the personal knowledge-repo context's `selected`
  with the allowlist (`loadPersonalAgentKnowledgeRepoRoots`). Bundled defaults, the owner's plugin
  repos and every group repo are UNCHANGED — a bot run is a full owner run everywhere else. An EMPTY
  list contributes zero personal-knowledge roots and stays SILENT (no
  `마켓플레이스에 불러올 수 있는 플러그인이 없습니다` warning: an ungranted bot is the normal state, not
  a fault), but it STILL runs `ensureClone` best-effort, because that same working tree feeds the
  standing-memory read and the scoped brain/repo tools.
- **The bot manages its own allowlist in conversation:** `mcp__personal_agent__adopt_skill` /
  `drop_skill`, on the same live gate as the other self tools (row exists, viewer IS the owner, bot
  enabled, owner still admin), audited as `personal_agent_update`. `adopt_skill` validates the slug
  against the owner's REAL `skills/` tree and re-reads the row after that clone (long enough for the
  owner to have changed the grants in settings); `create_agent` takes an optional `skills` list
  checked the same way. A grant applies from the bot's NEXT conversation — skills load at run start
  — and both metacognition surfaces plus every tool result say so. The owner grants and revokes the
  same list in 설정 → 내 봇, fed by `GET /api/me/agents/skill-catalog` (their own `skills/` tree with
  each SKILL.md description; no repo is a NORMAL empty answer, only a clone FAILURE is an error —
  registered ahead of every `/:agentId` route so the literal path is never read as a bot id).
- **`GET /api/avatars/:id/skills` reports what the bot RUN actually loads:** bundled defaults + the
  owner's plugin repos unchanged, with the personal knowledge repo RE-RESOLVED under the bot's
  allowlist (`selected`) instead of filtering resolved roots by name — so the panel can never
  advertise a skill the bot would not load. Resolved against the owner's OWN avatar row: the
  composite `personal:` id is nothing a skill/plugin loader can key on.
- **Both metacognition surfaces carry the lens from the SAME live row read**
  (`summarizePersonalAgentState` → `PersonalAgentState.memoryRoot` + `adoptedSkills`, so neither can
  describe a scope the tools do not have): `promptBuilder`'s `personalAgentSection` (memory paths,
  the standing-memory file, the word SCOPED, the granted-skill roster, the adopt/drop action
  triggers — the memory half gated on a connected repo + the `personal_knowledge` tool group, never
  pointing at a tree this run cannot write), a scope-aware `brainSection` branch (it names
  `<root>/wiki`/`<root>/raw` and DROPS the brain-migrate/brain-ingest pointers, whose skills seed
  the ROOT vault outside this run's scope), `personalBotsSection` on the owner's side, and
  `describe_system`'s bot block (a memory line + a skills line) plus per-bot granted-skill counts on
  the owner's roster line.

## Run wiring (`runPlan.ts` / `claudeAgent.ts`)
- `personalAgentRun = Boolean(request.personalAgent)` drives ONLY: `summarizePersonalAgentState`
  (stamped as `request.personalAgentState`), the `personal_agent` MCP server, the SELF-scoping of the
  routine tools, `describe_system` ctx, and `personalAgentScope` — the memory root that
  parameterizes the repo/brain servers and the `preToolUseHook` write guard.
- **One server name, two mutually exclusive tool sets** (`agent/personalAgentProfileTools.ts`):
  a bot run registers `mcp__personal_agent__update_profile` (self-config: persona/alias/bio/intro,
  never displayName/enabled — the owner manages those); a NON-bot owner run registers
  `mcp__personal_agent__create_agent` when `ownerToolAccess && !groupAgentRun && !personalAgentRun
  && !consultationRun && !request.headless && ownerState.personalAgentsEnabled` (interactive only —
  a routine must not mint chat contacts unattended). Both handlers re-check the LIVE owner + admin
  role + enabled per call (the `mcp__` auto-allow fires first). Field caps are defined ONCE in
  `src/server/personalAgents.ts` (`PERSONAL_AGENT_FIELD_CAPS` {persona 8000, alias 64, bio 200,
  intro 2000} + `PERSONAL_AGENT_DISPLAY_NAME_CAP` 64) and imported by the HTTP route AND the tools.
  Audits: `personal_agent_create/update/delete/image`.
- **Metacognition rides both surfaces** from the same facts: `OwnerState.personalAgentsEnabled`
  (= `store.isAdmin`, eager — the registration gate reads it) + lazy count/names/max feed the
  owner-branch standing guidance (`personalBotsSection`) and describe_system's roster line;
  `PersonalAgentState` feeds the bot-identity prompt block (`personalAgentSection`) and
  describe_system's bot block (fail-closed UNAVAILABLE on deleted/disabled/demoted, then fall
  THROUGH to owner state — a bot run's owner state is its real capability). `claudeAgent` stamps
  `personalAgentsEnabled`/`personalAgentNames` onto the request from `personalAgentCreateActive`,
  so the prompt can never advertise a tool the run didn't register. Getting-started nagging is
  suppressed on bot runs (`&& !request.personalAgentState` at the call site).

## 봇 루틴 — a bot routine IS a scheduled delegated task (3단계)
`routine_jobs.personal_agent_id` (NULL = the owner's main avatar, i.e. every legacy row) binds a
routine to one bot WITHOUT touching the legacy plumbing: `avatar_user_id` stays the OWNER uuid, so
`listDueRoutineJobs`' suspended-owner JOIN and `deleteUser`'s sweep work unchanged. What differs is
the FIRING: `runRoutineJobNow` early-returns into `runBotRoutineJobNow` (scheduler.ts), which
resolves the bot LIVE (`findChattablePersonalAgent`; miss → Korean error recorded, schedule kept —
re-enabling the bot resumes it), dedupes on `hasQueuedBotTaskForRoutine` (skip records NO outcome so
the tick retries; one waiting firing per routine, which is why the enqueue path skips the
MAX_QUEUED_BOT_TASKS check), re-stamps the thread conventions (`touchConversation` with the
COMPOSITE id + `[예약 작업]` title + isRoutine — the eager mint in `createRoutineJob` binds the
composite at creation), then ENQUEUES a `bot_tasks` row when the thread is busy (that IS the
firing's outcome — markRoutineRun success) or runs `executeChatTurn` DIRECTLY when free
(unattendedDeadlineMs = `botTaskRunTimeoutMs`, modelFallback, `ctx.routineJobId` provenance; an
active_run race falls back to the enqueue carrying `userMessagePersisted`). The outcome maps from
`latestBotTaskForRoutine` guarded by a firedAt stamp — NOT the conversation listing, whose
oldest-first LIMIT could drop the fresh row, and not an owner-parked task the turn may have resumed
(its routine_job_id is NULL). The dispatcher prunes routine threads after a queued routine task
settles. `bot_tasks.routine_job_id` is the provenance/dedupe key and the card's 예약 chip.
- **Routine tools in bot threads are SELF-SCOPED** (systemTools.ts; the runPlan filter and
  `ROUTINE_TOOL_NAMES` are retired): list/update/delete reach only rows whose `personalAgentId`
  matches the running bot; create binds it automatically. The owner's MAIN avatar still manages
  EVERY routine (bot-bound included, rendered with a bot marker), as does the 예약 작업 tab —
  RoutinesView shows a bot chip on bound rows and its manual 지금 실행 surfaces skip reasons
  verbatim. `deletePersonalAgent` sweeps the bot's routine ROWS by personal_agent_id (their threads
  already die via the composite conversations arm).

## Delegated tasks (봇 오피스, `bot_tasks`) — the Grok-Bot-style work model
Every EXECUTED user turn in a bot thread is tracked as a `bot_tasks` row (store mixin
`store/botTasks.ts`; the status machine lives in its header comment and is enforced by guarded
UPDATEs — illegal transitions are atomic null no-ops, so double finalizes can't race). Capability is
UNTOUCHED: a task row is bookkeeping over the same A-1 full-owner run.
- **Chat-route seams:** `routes/chat.ts` exports `resolveChatTarget` (avatar/bot resolution with
  typed refusals) and `executeChatTurn(deps, ctx, hooks)` — the ENTIRE former turn body as one
  function, HTTP-free after `hooks.onRunOpen(runId)` (the route's SSE handshake lives in that hook;
  a server-started turn returns `true` and relies on the registry journal). Refusals are typed
  (`ChatTurnRefusal.reason: "active_run" | "task_gone"`, plus `userMessagePersisted` so the queue
  fallback never double-writes the user bubble). The pre-persist active-run check lives INSIDE
  `executeChatTurn` (before any DB write/clone), preserving the old 409-before-persist behavior for
  non-bot threads.
- **Queue instead of 409:** a message to a busy BOT thread is persisted immediately, becomes a
  `queued` task (cap `MAX_QUEUED_BOT_TASKS` 20/thread → 429), and answers **202 `{queued, task}`**
  (plain JSON, never SSE). Regenerate and rewind keep the 409 (and the 202 row is `kind: "queued"`, never a rewind anchor); images-while-busy 400 (a queued replay is
  text-only). The enqueue pokes the dispatcher afterwards to close the settle race.
- **Dispatcher** (`botTaskRunner.ts`, scheduler.ts's never-throw style): `maybeDispatchNextBotTask`
  DRAINS a thread's queue in a loop (the settle hook fires inside `executeChatTurn`'s finally while
  the dispatcher still holds its `dispatching` guard, so a re-entrant call would strand the 3rd+
  item — the loop is the fix), re-resolves the bot LIVE per item (deleted/disabled/demoted →
  `failQueuedBotTask`, Korean reason), and runs the turn with `existingBotTaskId` +
  `unattendedDeadlineMs` (`config.botTaskRunTimeoutMs`, env `BOT_TASK_TIMEOUT_MINUTES`, 30-min
  default/1-min floor; timeout substitutes the SDK's "aborted by user" like routines) +
  `modelFallback` + `skipUserMessagePersist`. Dispatched turns stay **headless:false** ON PURPOSE —
  same prompt shape as "the owner stepped away"; unattended-ness rides the deadline + the standing
  guidance, not the routine prompt branch. Boot: `startBotTaskDispatcher` =
  `sweepInterruptedBotTasks` (in-memory run ids die with the process) + sequential backlog drain.
  `index.ts` starts it next to the routine scheduler; `app.ts` injects `onBotTurnSettled` into the
  chat router (chat.ts must NOT import botTaskRunner — the runner imports `executeChatTurn` back).
- **Turn-boundary approvals:** the run registers `mcp__personal_agent__report_task`
  (`done`/`need_input` + summary → `setBotTaskReport`, mid-run, status untouched); the DONE finalize
  reads `reportedOutcome` to park the task as `waiting_input` instead of done, and the owner's next
  message in that thread RESUMES the row (`markBotTaskRunning` from waiting_input clears
  question/outcome, keeps startedAt). AskUserQuestion is DENIED on every bot run
  (`buildPreToolUseHook`'s `personalAgentRun` last-param, redirect: report need_input + end the turn
  with the question). Both metacognition surfaces carry the task/queue/protocol lines
  (`PersonalAgentState.queuedTaskCount` via `summarizePersonalAgentState`'s conversationId param).
- **SSE naming trap:** the task frame is **`bot_task`** `{task: <full row>}` — `task`/`task_update`/
  `task_end` already belong to the SDK activity relay whose client handler keys on `data.taskId`
  and silently drops anything else. Pinned on both sides (route tests assert the event name; the
  client test proves SDK rows never enter the board).
- **Task API:** `routes/botTasks.ts` — `GET /api/me/bot-tasks?agentId&limit` (admin-gated like
  /api/me/agents, owner-scoped) and `POST /api/me/bot-tasks/:id/cancel` (queued/waiting_input →
  row-cancel via `cancelQueuedBotTask`, which preserves `pendingQuestion` on an abandoned card;
  running → registry `cancelRun` + `{task, stopping:true}`; terminal → 409; misses are 404 with no
  existence probe).
- **Client (`#/bots` 봇 오피스):** rail-less third arm in `App.svelte`; roster (with 입력 대기
  inbox + latest-task line + per-bot unseen chips) + a one-line status summary bar + the EXISTING
  ChatView mounted for the thread (pane must live in `state.chatPanes` —
  `lib/chat.ts`'s private updatePane resolves by id there; `loadPaneForConversation` is the
  extraction that lets `openBotThreadPane` place a pane without navigating to #/bots). Task cards
  render INLINE in the transcript (`components/BotTaskCard.svelte`): ChatView derives ONE
  pane→anchor→tasks map (`anchorBotTasksToMessages`, time-anchored after the last user message ≤
  task.createdAt, -1 = above the first bubble) whose first line returns a shared empty Map outside
  the bots view — the {#each} only ever does Map lookups, so ordinary chat has ZERO DOM/alloc
  difference at token rate (pinned by `tests/svelte-bots-thread.test.ts`). Inline cards filter by
  agentId (not conversation) so the summary bar and cards agree. `bot_task`
  frames + a 10s/focus/streaming-edge poll of the task API feed `state.botTasks` (terminal-wins
  merge prevents 완료→실행 중 flicker); 202 handling in `sendMessage` branches BEFORE the SSE
  reader. `PromptModal`'s visible-pane set covers both "chat" and "bots" or prompts double-render;
  `currentRoute()` needs the bots branch or `syncHash` on send strips the agent id from the URL.
- **봇 간 위임 (`mcp__personal_agent__delegate_to_bot`) — an ASYNC hand-off, never a question.**
  The one tool BOTH personal-agent tool sets carry (bot runs AND the owner's main-avatar runs; one
  shared factory in personalAgentProfileTools.ts, live-gated per run kind). It queues a
  self-contained request as a `bot_tasks` row on the TARGET bot's latest non-routine thread
  (`latestChatConversationIdForAvatar`, minting one when none exists), persists the user turn as
  `[<source> 위임] <request>` (Korean — the owner reads it in that thread), stamps provenance
  (`delegatedByAgentId` = the source bot, NULL for a main-avatar hand-off; `delegationDepth` =
  hop count), audits `personal_agent_delegate`, and pokes the dispatcher through
  `botTaskDispatchBroker.ts` — a one-slot module that exists ONLY to break the import cycle
  (agent/* must never import routes/chat.js or botTaskRunner.js; `startBotTaskDispatcher`
  registers the real dispatcher at boot, unregistered = silent no-op and the boot/settle drains
  recover). Nothing flows back into the delegating turn — the result lands on the board. Guards:
  chain cap `MAX_DELEGATION_DEPTH` 2 read off the CURRENT task's depth (main avatar always opens
  at hop 1), per-turn fan-out cap `MAX_DELEGATIONS_PER_TURN` 3 (successful hand-offs only),
  target resolution id-exact → name/alias exact among ENABLED bots (ambiguous lists ids; misses
  list the roster), self-delegation refused, the live reach gate re-checked, and the target
  thread's `MAX_QUEUED_BOT_TASKS` honored. `botTaskTitle` + `MAX_QUEUED_BOT_TASKS` moved to
  `personalAgents.ts` for the same cycle reason (chat.ts re-exports). describe_system carries the
  ONE fact the prompt cannot: the live sibling-bot roster, plus the current chain depth; the card
  shows a 위임 chip naming the source.
- **Seen/unseen (the rail badge):** UNSEEN = settled (`done`/`failed`/`waiting_input`) AND
  `seen_at IS NULL` — ONE predicate (`UNSEEN_WHERE` in store/botTasks.ts) shared by
  `countUnseenBotTasks` (single GROUP BY; a bot with none is ABSENT from `agents`) and
  `markBotTasksSeen`. Every finalize + dispatch CLEARS the stamp (a resumed-then-finished task
  badges again); the owner's own row-cancel STAMPS it. Endpoints (admin-gated like the rest):
  `GET /api/me/bot-tasks/unseen` and `POST /api/me/bot-tasks/seen {agentId?}` — the POST answers
  the FRESH counts and the client REPLACES `state.botTaskUnseen` from responses, never decrements
  locally. `lib/loaders.ts` `refreshBotTaskUnseen`/`markBotTasksSeen` are admin-guarded no-ops for
  everyone else and piggyback the startKnowledgeWatch minute tick; 봇 오피스 marks a lane seen on
  selection + debounced when a settled row lands while visible. Clearing a badge is always the
  client saying "I looked" — an attended turn still badges until then.
- **Legacy UX migrated (2단계):** the rail 내 봇 section is REMOVED (its dead `.rail-bot*` CSS
  too); the rail nav's 봇 오피스 entry carries the unseen badge (inbox-badge pattern, 99+ cap,
  sr-only text), the 첫 봇/대화로 봇 만들기 seeded-chat CTA lives in BotsView's empty state, and a
  탐색 personal-agent card opens 봇 오피스 (`openBotOffice` falls back to a plain chat pane when
  the view gate refuses, so a widened gate never leaves a dead click). Shell no longer eager-loads
  avatars (that load belonged to the removed section; 봇 오피스/탐색 load their own).
- **Per-bot DELETE** (`DELETE /api/me/agents/:agentId`): store cascade in one transaction
  (`deletePersonalAgent` — per-conversation canvas artifacts + messages + conversations + the bot's
  `bot_tasks` swept BY agent_id, so a task whose thread already died still goes, then the
  row) with the route snapshotting `conversationIds` + `imageExt` BEFORE the delete, then
  best-effort disk sweep (avatar image by composite id, `personalAgentWorkspaceParent` tree,
  per-conversation image/file dirs). Disable (`enabled=false`) is the thread-preserving alternative.
- **deleteUser**: `store/admin.ts` drops `personal_agents WHERE owner_user_id` AND
  `bot_tasks WHERE owner_user_id` (bot conversations
  already cascade via the `owner_user_id` arm); single/bulk conversation deletes in
  `store/conversations.ts` also sweep `bot_tasks WHERE conversation_id`; `routes/admin.ts` snapshots each bot's
  {compositeId, imageExt, workspaceParent} pre-delete and sweeps them (the `<userId>.`-prefixed
  avatar-image sweep cannot match composite-named files).
- The avatar-image GET (`routes/profile.ts`) resolves ext through the third namespaced lookup
  (`getPersonalAgentImageExtByAvatarId`); ids contain no `/`, preserving the raw-filename invariant.

## Client
- 탐색: `내 봇` badge (`tag accent`), ranked right after the own avatar. Rail: "내 봇" section in
  `Shell.svelte` from a top-level `$: personalBots = $appState.avatars.filter(...)` (legacy-mode
  compile-time dep rule — the template names the derived array); `Shell` also calls `loadAvatars()`
  on mount so a `#/settings` boot still populates it. The section shows on `isAdmin ||
  personalBots.length` — an admin with ZERO bots still gets it, or the admin-only feature would have
  no entry point; its empty state is a `첫 봇 만들기` CTA (`.rail-bot-create`) that calls
  `openSeededChat` to open a fresh thread with the OWNER's own avatar and SEED (never send) a
  bot-creation request, which the avatar then fulfils via `mcp__personal_agent__create_agent`.
  Management = 설정 4th tab `내 봇`
  (`SettingsPersonalAgentsCard.svelte`, admin-gated three ways: tab filter + `{#if isAdmin}` mount +
  reactive tab-guard back to 프로필; ALWAYS-MOUNT `active`-prop rule inside). `makePane` seeds
  `modelTier` from `personalAgent.defaultModel` when the tier exists in this deployment's
  `bootstrap.modelSelection`; when the deployment pins the model (`locked`) the select is replaced
  by a note and `defaultModel` is omitted from save bodies.

## Tests
`tests/personal-agent-store.test.ts` (CRUD/cap/cascades/parse/reach, `memory_dir` insert-stamp +
rename immutability + backfill, grant normalization),
`-memory.test.ts` (the fail-closed scope guards, scoped brain search/read, repo-tool path
confinement + the scoped scaffold/create refusals, and a scoped commit staging ONLY the memory
folder while the owner's in-flight work stays untouched — plus the WIRING: `buildAgentRunPlan`
handing the repo/brain servers the row's immutable root with an unscoped owner run as the control,
the vanished-row fallback, the granted-skill allowlist and subtree standing memory through
`plugins.ts`, and the native-write guard's deny/allow matrix),
`-tasks-store.test.ts` (bot_tasks status machine/orderings/sweeps/cascades),
`-tasks-routes.test.ts` (queue 202/caps, dispatcher drain + undispatchable-fail, resume,
finalize transitions incl. reportedOutcome→waiting_input, `bot_task` frame-name pins, task API +
cancel matrix, boot sweep/dispatch), `tests/svelte-bots-view.test.ts` (봇 오피스 roster/cards/
cancel-vs-stop/frame routing), `-routes.test.ts` (admin
gates, ownership 404s, AgentRequest shape incl. identity overlay + never-inherit pin, disabled 403,
role-revoked fail-closed, image round-trip, delete sweeps, the skill-catalog gate + grant validation
matrix, and `/api/avatars/:id/skills` + the turn's plugin roots/standing memory reflecting the
allowlist), `-tools.test.ts` (access-algebra
baseline, both tool gate matrices, describe_system, prompt pins, routine-name filtering,
adopt/drop_skill incl. the unknown-slug roster and the audit detail),
`tests/svelte-personal-agents.test.ts` (badge/rail incl. the admin-only empty-state CTA and the
owner-avatar seeded pane it opens/management fetches/seeding, the 스킬 grant list and its
no-repo/no-skill states). Getting-started
exclusion extended in `tests/agent-core.test.ts`; `tests/agent-run.test.ts:377`'s system-only
mcpServers pin now includes `personal_agent` (admin owner).
