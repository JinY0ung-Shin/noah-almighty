# Noah Almighty — Claude notes

The durable **direction and philosophy** of this codebase. Operational detail (file/function/column
names, migration mechanics, refactor history, CSP byte rules, test coupling, and the long gotcha list)
lives in **[`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md)**, which is an **index** over
per-subsystem pages in [`docs/architecture/`](docs/architecture/) — open the index, then load only the
page for what you are touching. See README.md for features, setup, env vars, verification.

## Core design direction

These are the invariants the project is built around. New work should reinforce them, not erode them.

- **Give the avatar META-COGNITION of its own system state.** The avatar should accurately know what's
  configured and what it can do RIGHT NOW — knowledge repo connected? git token set? which secrets/SSH
  enabled? which tools it currently has — so it acts and explains correctly instead of guessing or
  relaying stale manual steps. `buildSystemPromptAppend` (per viewer/headless) appends this self-state to
  the SDK's default Claude Code system prompt; `mcp__system__describe_system` is the runtime mirror of the
  same info. **When you add a capability, surface its current state in BOTH.** The structural sync point is
  `agent/ownerState.ts` (`summarizeOwnerState` → unformatted facts shared by both consumers).
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it
  STANDING per-turn guidance + an action-trigger in the tool's description + an error that redirects.
- **Language split: agent-facing text is English, user-facing text is Korean.** Classify a new string by
  *"does the model read it as INPUT?"* → English (prompts, tool descriptions, hook-deny reasons, server
  slash-command expansions, bundled `SKILL.md` body + frontmatter); else Korean (UI, `apiError`,
  status/activity labels, conversation titles). The avatar always REPLIES in the user's language (default
  Korean), anchored in `buildSystemPromptAppend`. A string used on BOTH channels is split.
- **Trust/elevation is GROUP-ONLY.** `isTrustedFor` IS `shareAnyGroup` (symmetric co-membership in an
  AVATAR-SHARING group) — the single choke point every elevated/trust check flows through. Add new trust
  sources THERE, not at call sites. There is no per-avatar trust list anymore.
- **Avatar visibility is a 2-state enum** (`group` | `private`) — the `public` state is RETIRED: avatars
  never reach beyond the owner's groups (a group-less user reaches only their own avatar). The per-group
  `avatar_sharing` policy gates visibility AND trust TOGETHER (one SQL fragment, `SHARING_TEAMMATES`);
  off = knowledge-sharing-only group (repo/brain/tool-policy unaffected). Visibility (`private` opt-out)
  and trust remain separate axes: a teammate reaches your `group` avatar but never your `private` one.
- **Group shared agents = team avatars that are NOT users rows** (`group_agents`, several per group
  allowed, avatar id `group:<groupId>:<agentId>` — the pre-multi `group:<groupId>` form was migrated
  away). Reach = owning-group membership only (`findChattableGroupAgent`), independent of
  `avatar_sharing`; per-member threads are private and sharing happens ONLY via the group second brain.
  The run kind (`AgentRequest.groupAgent`) carries capability: group resources only — never personal
  secrets/tokens/repos; capture (write+commit) follows the group's `capture_scope` policy with the
  ACTING member's git token/identity. Group-agent runs grant elevated built-ins to EVERY member BY
  DESIGN — a deliberate membership-gated carve-out OUTSIDE `isTrustedFor` (which stays the choke point
  for PEER trust only); `capture_scope` is enforced at the MCP tool layer, not the filesystem.
  Group agents SELF-CONFIGURE persona/alias/bio/intro mid-chat via `mcp__group_agent__update_profile`
  (live group-admin gate, membership required even for sysadmins, audited as `group_agent_update`,
  applies to every member from the NEXT turn); its state rides `GroupAgentState.personaSet`/
  `selfConfigAllowed` into BOTH the prompt branch and `describe_system`.
- **Personal agents (내 봇) = the owner's OWN bots, and a bot run IS a full owner run.** Several per
  user (`personal_agents`, avatar id `personal:<ownerUserId>:<agentId>`), reachable by the owner
  ALONE through `findChattablePersonalAgent` — phase 1 additionally gates the whole feature on the
  live system-admin role (fail-closed, threads preserved). Capability diverges in IDENTITY plus one
  scoped personal-knowledge LENS: each bot's memory is `agents/<dir>/` inside the OWNER's knowledge
  repo and it loads ONLY the skills the owner granted (empty = none), both enforced at the MCP tool
  layer by server-construction scoping — while `AgentRequest.personalAgent` still never touches the
  access algebra, `request.avatar` stays the OWNER's row (the composite id keys only the
  thread/workspace/client surfaces), and `request.groupAgent` must never be set for one (triple
  kill-switch). The bot's persona reaches the prompt via the chat route's identity overlay; bots
  self-configure via `mcp__personal_agent__update_profile` and the owner's main avatar creates them
  conversationally via `mcp__personal_agent__create_agent` (interactive owner runs only — never
  unattended). Routines DO fire AS a bot (`routine_jobs.personal_agent_id` → `runBotRoutineJobNow`,
  landing as a delegated task on the owner's board) and the in-bot routine tools are SELF-scoped to
  the schedules that fire as that bot; both metacognition surfaces say so. Mechanics →
  `docs/architecture/personal-agents.md`.
- **Skill sharing rides the avatar-discovery boundary — never wider.** A shared skill (metadata row in
  `shared_skills`; content stays in the owner's knowledge repo) is browsable/learnable EXACTLY where the
  owner's avatar is visible in 탐색 (`SHARING_TEAMMATES`; private/suspended owners drop out). Learning
  COPIES `skills/<slug>/` into the learner's own repo and commits as the learner (`skillTransfer.ts` —
  symlinks never followed, size-capped); a learned skill LOADS from the next conversation, and both
  metacognition surfaces + the tool result say so. The boundary holds for CONTENT, not just rows: a
  learned copy is NOT re-shareable while its origin marker links it to the source
  (`assertSkillShareable`; unlink/구독 해지 IS the ownership claim that unlocks sharing, and legacy chain
  rows — including their update path — drain through the hygiene prunes), and a group admin can
  channel-BLOCK an (owner, skill name) pair per group (`shared_skill_group_blocks`, enforced inside
  `LEARNABLE_SKILLS_FROM` so every learnable read fails closed; a skill stays learnable only through an
  unblocked mutual sharing group, blocks survive unshare→re-share AND a rename of the blocked skill —
  they are never deleted, only unblocked — and learned copies stay put). Share rows are a SNAPSHOT of
  the tree, so ONE reconcile helper runs wherever the owner's fresh clone is in hand (mine tab + a
  successful `mcp__repo__commit`, best-effort so it can never fail the commit): drift re-snapshots, a
  deleted/marker-carrying dir unshares, and a RENAMED dir is FOLLOWED in place — but ONLY on git's own
  rename EVIDENCE onto a corroborating target, never by guessing from content, so a DELETION stays a
  hard revoke (even with an identical dir elsewhere) and anything unresolved unshares rather than
  risking a share landing on someone's unpublished content. When a rename is followed the row
  id/intro/learn-count all move, the old slug lands in `previous_names`, and learners' origin markers
  match through that trail — as the sole answer, never over an exact name match — until their next
  update heals them. The
  `mcp__skill_exchange__*` tools are owner-only end
  to end. Mechanics → `docs/architecture/avatar-collab.md`.
- **A personal API key IS the owner, and an API-submitted turn is MACHINE-authored.** The external
  task API (`POST /api/v1/avatar/tasks`, Bearer `noah_…` key, SHA-256 hash stored, ≤10 per user,
  issued under 권한·연결) runs the owner's MAIN avatar as a FULL owner run through `executeChatTurn` —
  same tools, shell-exposed secrets, repo commits — and the key holder answers permission prompts via
  `/respond`, so a leaked key is the owner's session. Keys are accepted ONLY under
  `/api/v1/avatar/tasks`, never on session/admin routes, and session cookies are never accepted
  there. The `message` was NOT typed by the owner (incident bodies, log excerpts), so the run is
  provenance-stamped (`ChatTurnContext.externalTaskId` → `AgentRequest.externalTaskApi`): the prompt
  tells the avatar to treat the body as that system's data, `describe_system` reports the origin, and
  interactive-only gates (`create_agent`) exclude it exactly like `headless` — **when you add an
  interactive-only capability, gate it on BOTH `headless` and `externalTaskApi`.** Tasks are a SQLite
  queue (queued → running → succeeded/failed/cancelled; `waiting_input` is presentation-only) drained
  by a 1 s dispatcher (per-owner 1, process-wide 4, waits behind an active run on the same
  conversation, backs off on 409, records a graceful restart as `failed`), independent of routines;
  the run's audit rows keep their own action names (only `chat` becomes `avatar_api_task`). Mechanics →
  `docs/architecture/avatar-task-api.md`.
- **A mid-turn user message ("steer") rides the SDK streaming input, never a second run.**
  `POST /api/chat/runs/:runId/message` pushes text into the live run's `SteerChannel`; the held-open
  prompt generator writes it to the CLI's stdin and the CLI folds it in after the next `tool_result`.
  `command_lifecycle` is the ONLY delivery signal (`result.queued_turn_count` lies), and an UNDELIVERED
  steer at a result boundary ALWAYS becomes a follow-up turn — the run stays OPEN and the segment so far
  persists as its own message (`turn_end`, not `done`). Persist at DELIVERY only, local SDK runs only
  (never external avatars / external-task-API turns), `midTurnMessages` on BOTH metacognition surfaces.
  Mechanics → `docs/architecture/chat-sse-media.md`.
- **git remote work is MCP-only BY DESIGN.** The agent shell has NO git credentials (stripped from the
  subprocess env), so Bash `git push`/`gh` can never authenticate. Route every git-ish capability through
  an in-process MCP bridge (`mcp__repo__*`/`mcp__git_repo__*`/`mcp__group_repo__*`) and keep the
  no-Bash-fallback line in its error text. Per-user git tokens are used server-side only, never reach the
  agent.
- **Browser control is a RELAY into the user's own browser, and the extension runs no page JS EXCEPT one
  fixed bridge-authored expression for `read_storage`.** An
  `mcp__browser__*` op is a wire contract crossing FIVE hand-synced layers (`agent/browserTools.ts` →
  `agent/events.ts` → `routes/chat.ts` relay+audit → client `lib/browserBridge.ts` →
  `extension/background.js`) plus BOTH metacognition surfaces; nothing type-checks across the gap, so a
  field missed in the middle arrives `undefined`. The security boundary is the extension's default-deny
  `CDP_ALLOWLIST` (no `Storage.*`; of `Runtime.*` ONLY the single `Runtime.evaluate` behind `read_storage`
  — the ONE fixed bridge-authored page-JS exception, NOT `Runtime.enable`; of `Network.*` ONLY the
  consent-gated, current-origin `Network.getCookies` behind `read_cookies`), NOT the permission manifest —
  elements are
  addressed by `backendNodeId` (plus screenshot-pixel `click_at` as the deliberate escape hatch for
  AX-invisible targets), so an op that cannot be executed directly must be driven the way a
  PERSON would AND re-read what it landed on instead of assuming success. A VIEWPORT screenshot is
  PRE-FITTED to the native image size Claude's API resizes to (standard tier: 1568 px per edge / 1568
  visual tokens) and its pixel→CSS mapping is read off the MEASURED bitmap, never the capture formula,
  because Claude answers a pixel question in the space of the image it SEES — and every pixel-mode
  result reports the mapping it used, so a wrong coordinate SPACE stays distinguishable from a wrong
  aim (#66). `read_cookies` returns the
  user's LIVE session cookies (httpOnly included) and `read_storage` the CURRENT tab's localStorage/
  sessionStorage (bearer/JWT tokens included — read via a FIXED `Runtime.evaluate` expression because
  `DOMStorage` is not exposed to `chrome.debugger`; the one page-JS exception, values untrusted), so BOTH
  are gated PER SITE, PER BROWSER SESSION by a popup
  the user must approve IN THE EXTENSION (`read_storage` additionally PER STORAGE TYPE — one unified
  `dataConsentGrants` store keyed `{host:{cookies?,local?,session?}}`, so approving one type never approves
  another; the first read of a site+type prompts; the grant is remembered in `chrome.storage.session`,
  revocable in the extension options, and cleared when the browser closes) — un-bypassable from
  server/headless — and audited by KEY NAME + count only, never value; the tool result carries a
  secret-handling banner. Everything the page returns
  (snapshot text, `read_text` chunks, screenshot pixels, cookie/storage keys) is UNTRUSTED input. Mechanics →
  `docs/architecture/browser-bridge.md` (its own 5-page hub — start with `contract.md`).
- **A server-held third-party credential stays READ-ONLY; the WRITE path is the user's own browser.**
  The Confluence tools read only, enforced STRUCTURALLY — `requestJson` has no `method`/`body` option,
  so a future tool cannot quietly reach a mutating endpoint. Page creation/editing is routed to the
  browser tools instead: it runs in the user's session, so the edit is attributable, visible, and
  undoable, and the owner's PAT never mutates anything unattended. Both metacognition surfaces branch on
  `browserEnabled` — never offer a route the run does not actually have.
- **A stored secret reaches a login form by NAME, never by value — and the model never sees it.** The
  owner opts a vault secret into 브라우저 입력 per secret (`user_secrets.browser_expose` + EXACT allowed
  hosts + `browser_password_only`, `PATCH /api/me/secrets/:name {browser}`); the avatar passes
  `secretName` to `mcp__browser__type`/`fill_form` instead of `value`, the server resolves the value, and
  the extension types it. Five guards are each load-bearing: per-secret opt-in with exact hostnames (no
  wildcards; reserved git/SSH names never qualify), the host check at BOTH ends (server pre-checks the last
  tab URL it saw; the extension re-checks the live tab AND the element's own frame document, failing
  closed), password-field-only enforced in the extension, a once-per-browser-session `secret` consent popup
  (one approval covers every allowed site — the per-site limit is the owner's host allowlist, not the popup)
  the server cannot bypass, and never-quoted/always-redacted handling (LENGTH-only verification because Chromium masks
  a password field's AX value as one `•` per character; the plaintext rides `secretText`/`secretValue` on a
  TRANSIENT SSE frame that is never replayed, never `text`; the reply is redacted and the value joins the
  PostToolUse redaction set; audit rows carry the NAME only). The degrade is client-side, not a floor
  bump: an extension below `SECRET_INPUT_MIN_EXTENSION_VERSION` never receives the value. One-time codes
  and payment details stay off-limits on every surface. Both metacognition surfaces list the enabled
  names + sites and branch on whether the bridge is connected. Mechanics →
  `docs/architecture/browser-bridge/actions.md`, `secrets-ssh.md`.
- **Tool permissions go through ONE gate:** the `PreToolUse` hook (`buildPreToolUseHook`). The SDK's
  `canUseTool`/`onUserDialog` don't fire headlessly. The `mcp__`-prefix auto-allow fires BEFORE the owner
  check, so every in-process MCP server MUST self-gate in its handlers.
- **Knowledge repo = one per user, agent-managed** (the avatar edits its own repo via `mcp__repo__*`).
  **Second brain = a CONVENTION (`wiki/`+`raw/`) over that SAME repo, NOT a new store** — recall is
  read-only MCP search; capture writes through the repo-write tools + commit (uncommitted = not persisted).
- **Per-user settings follow ONE pattern** (column → migration → `toUser` → `updateProfile` → `User` type →
  `PATCH /api/me` → settings tab). Some defaults are written from the composer, not a settings tab: the
  model/effort/MCP-tool-group pickers remember the owner's last choice via per-user defaults
  (`*_default` columns + `setChatDefaults` + `PUT /api/me/chat-defaults`) that seed new conversations,
  mirroring `groupKnowledgeOffDefault`. The per-conversation `selected_*` value still overrides the
  default when resuming an existing thread.
- **Modules are split behind UNCHANGED exports.** When refactoring, keep import paths stable via
  re-exports rather than forcing callers to move.
- **External avatars share one versioned wire contract with oh-my-gateway.**
  `src/server/agent/externalAgent.ts` consumes `claude-agent-sdk-message-v1` from
  `POST /v1/agents/messages`, then sends normalized `sdk_message` payloads through the SAME
  `dispatchSdkMessage` used by local SDK runs. When changing SDK event handling or the external stream
  shape, update and verify both Noah and oh-my-gateway's endpoint mapper; never fork a second handler.
  Preserve stateless semantics: send the complete stored text history each turn, ignore upstream
  `session_id`, and propagate aborts. Run Noah's `tests/external-agent.test.ts` together with the
  gateway endpoint and `/v1/responses` regression tests. `visibleToGroupIds` is a Noah-only visibility
  ACL and group binding is REQUIRED: an entry without a non-empty list is visible to NO ONE (fail
  closed — legacy env/registry entries stay parseable but dark until an operator assigns groups; the
  admin UI refuses to save without one), a non-empty list means membership in any listed group, and
  unknown/deleted group IDs fail closed. Enforce it through the shared external-agent visibility helper
  on list, detail, skills, and every new chat turn; never treat it as trust/elevation or a Gateway tool
  policy, and never let `avatar_sharing` gate it (it is an admin ACL, not peer sharing). System
  admins do not bypass membership. Revocation blocks the next request but preserves user-owned history
  and does not interrupt a run that already passed its start-time authorization check. Admin-managed
  entries live as one versioned, AES-GCM-encrypted registry under `app_config`; environment entries are
  read-only and win same-ID collisions. API keys are write-only (`apiKeySet` only on reads), and admin
  Gateway checks use authenticated `/v1/models` rather than executing an agent/tool turn. Bind a stored
  API key to its exact normalized endpoint: an address change must use key `set` or `clear`, never `keep`.
  Keep external ids immutable: a history-bearing entry may be disabled but not deleted, and changing its
  managed endpoint requires explicit confirmation plus conversation-binding migration. Every external
  conversation stores the exact endpoint it first trusted; an unapproved env/config re-point must fail
  closed before sending history, and a legacy conversation whose binding is `NULL` must start over rather
  than lazily adopting the current address. Commit a confirmed managed rebind and its encrypted registry
  compare-and-swap in one immediate DB transaction. Registry caching may skip scrypt/JSON work only while the exact DB
  ciphertext is unchanged; tamper, wrong secrets, and invalid versions must still become an empty registry.

## Module map
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers); handlers in
  `src/server/routes/{auth,profile,directMessages,plugins,knowledgeRepo,groups,routines,chat,admin,browserExtension}.ts`,
  with external avatar admin CRUD registered from `routes/adminExternalAgents.ts` (+ `_shared.ts`).
- **Agent:** `claudeAgent.ts` re-exports `buildPrompt` / `buildSystemPromptAppend` / `buildUserPrompt`
  (`agent/promptBuilder.ts`), SDK-message handlers (`agent/sdkMessageHandlers.ts`), the PreToolUse hook
  (`agent/preToolUseHook.ts`). Shared self-state in `agent/ownerState.ts`; MCP helpers in
  `agent/mcpTools.ts`; repo-tool skeleton in `agent/repoToolKit.ts`.
- **Store:** `store.ts` is a thin barrel; the `Store` facade is composed from per-domain mixins in
  `store/*.ts`. Public surface unchanged (`new Store(config)` + `store.foo()`).
- **Repo git:** low-level plumbing shared via `repoGitCore.ts` + `repoGitGuards.ts`.
- **Client:** Svelte + Vite under `src/client/` (NOT vanilla `public/`); central store `lib/state.ts`.
- **Shared:** `src/shared/*` is the real client↔server layer (`mcpToolGroups.ts`,
  `sdkToolPresentation.ts`); `tsconfig.client.json`'s `include` lists the extra server modules the
  client may import. New cross-boundary code goes there, not into a hand-copy.
- **Tests:** ~38 vitest files by area — `agent-*`, `client-*`, `svelte-*`, `browser-*`, `store`,
  `infra`, `app`, `chat-history`, `external-agent` (+ `tests/helpers.ts`).
- Module-level cautions: [`src/server/CLAUDE.md`](src/server/CLAUDE.md),
  [`src/server/agent/CLAUDE.md`](src/server/agent/CLAUDE.md), [`src/client/CLAUDE.md`](src/client/CLAUDE.md).
  Operational detail: [`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md) (index →
  [`docs/architecture/`](docs/architecture/)). Design language:
  [`docs/DESIGN.md`](docs/DESIGN.md). Deferred work: [`docs/REFACTORING-BACKLOG.md`](docs/REFACTORING-BACKLOG.md).

## Verification gate
- `npm run lint && npm test && npm run build`. **Client checks: run directly** —
  `npx tsc --noEmit` + `npx svelte-check --tsconfig ./tsconfig.client.json`. ⚠️ The rtk hook misrewrites
  `npm run lint` to eslint and fails — don't rely on it.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file (full suite ~16s).
- `npm run dev` — server (tsx watch, :48787) + client (vite, :5173, proxies `/api`,`/users`,`/fonts`).
- Command/Docker/proxy/Playwright detail → [`docs/architecture/build-run-verify.md`](docs/architecture/build-run-verify.md).

## Deploy topology (don't forget)
- **Coding happens on this WSL2 box; deployment is a SEPARATE internal corporate server** — `localhost`
  here is NOT the deploy env, and there's no local DB. Schema/UID/volume/`SESSION_SECRET` changes need an
  EXISTING-deployment migration path, not just fresh-install behavior.
- **Project name diverges by layer:** display "Noah Almighty", code slug `noah-almighty`, working dir
  `avatar-chat`. Grep both old/new slugs when auditing names.
- **The user fleet is Windows/Linux only — no macOS.** Platform-dependent decisions (browser-bridge
  paste shortcuts, file-dialog/DLP behavior, extension guidance) target Windows/Linux; keep any mac
  handling defensive-only (e.g. `viewerPlatform`'s Meta branch) and never advertise macOS in
  user-facing text or release notes.
- **The browser bridge is a SIGNED artifact living on users' machines, not just server code.** The
  extension id and the policy update channel derive from ONE RSA key that exists only on the release machine
  (`BROWSER_EXTENSION_KEY_FILE`, `BROWSER_BRIDGE_ORIGINS` — release-only `.env` keys the server never
  reads). Losing the key orphans every install; changing it changes the id, which every place naming
  the id must follow. Once a channel is live EVERY release must attach its assets
  (`npm run build:extension-update`, see the `release` skill). Two invariants that fail in the FIELD,
  not in CI: a new file under `extension/` must be added to `BUNDLE_FILES` (`browserExtensionBundle.ts`)
  or the shipped zip silently bricks (a BINARY file additionally needs `BINARY_BUNDLE_FILES`, or the
  one-click updater pushes it through utf8 and corrupts it), and `BROWSER_EXTENSION_MIN_COMPATIBLE`
  must never exceed the bundled manifest version (`tests/infra.test.ts` enforces the ceiling).
  Install/policy detail → `extension/README.md`.
