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
  relaying stale manual steps. `buildSystemPromptAppend` (per viewer/headless) renders this self-state ONCE
  per conversation into the frozen pi `instructions` (on top of the deployed pi prompt
  `scripts/pi-system-prompt.md`), so the prompt is the state AT CONVERSATION START;
  `mcp__system__describe_system` is the LIVE mirror, and the prompt tells the avatar to call it whenever
  state may have changed. **When you add a capability, surface its current state in BOTH.** The structural
  sync point is `agent/ownerState.ts` (`summarizeOwnerState` → unformatted facts shared by both consumers).
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it
  STANDING per-turn guidance + an action-trigger in the tool's description + an error that redirects.
- **Language split: agent-facing text is English, user-facing text is Korean.** Classify a new string by
  *"does the model read it as INPUT?"* → English (prompts, tool descriptions, tool-call refusals and
  errors, server slash-command expansions, bundled `SKILL.md` body + frontmatter); else Korean (UI, `apiError`,
  status/activity labels, conversation titles). The avatar always REPLIES in the user's language (default
  Korean), anchored in `buildSystemPromptAppend`. A string used on BOTH channels is split.
- **Trust/elevation is GROUP-ONLY.** `isTrustedFor` IS `shareAnyGroup` (symmetric co-membership in an
  AVATAR-SHARING group) — the single choke point every elevated/trust check flows through. Add new trust
  sources THERE, not at call sites. There is no per-avatar trust list anymore.
- **Avatar visibility is a 2-state enum** (`group` | `private`) — the `public` state is RETIRED: avatars
  never reach beyond the owner's groups (a group-less user reaches only their own avatar). The per-group
  `avatar_sharing` policy gates visibility AND trust TOGETHER (one SQL fragment, `SHARING_TEAMMATES`);
  off = no visibility, trust or skill sharing through that group (tool policy unaffected). Visibility (`private` opt-out)
  and trust remain separate axes: a teammate reaches your `group` avatar but never your `private` one.
- **Group shared agents are RETIRED (2026-10-29).** Team avatars that were not users rows are gone; a
  boot purge (`retireGroupAgents.ts`) deletes every `group:` thread and quarantines its files, and drops
  `group_agents`. The `group:` avatar-id prefix, the `group-` workspace prefix and the table names are
  reserved FOREVER — never mint an avatar id under them again. Groups themselves stay. Mechanics →
  `docs/architecture/server-core.md`.
- **Group knowledge repositories are RETIRED too (2026-10-30, user decision).** A group is ONLY the
  avatar-sharing / trust / skill-sharing (+ admin tool policy) unit: no shared repo, no group skills or
  group CLAUDE.md in members' runs, no `mcp__group_repo__*`, no `group_knowledge` tool group or
  per-conversation group-knowledge toggle. `migrate()` drops `groups.knowledge_*`,
  `users.group_knowledge_off_default` and `conversations.group_knowledge_off` behind the gate
  (`RETIRED_COLUMNS`), `retireGroupKnowledgeRepos.ts` quarantines Noah's clones (`<dataDir>/group-knowledge`,
  reserved forever); the remote repos are never touched. `group_repo`/`group_brain` are retired pi broker
  ids (`RETIRED_MCP_SERVER_NAMES` deletes this Noah's stale entries) and reserved names, a saved
  `group_knowledge` selection is silently dropped (`normalizeMcpToolGroups`), and BOTH metacognition surfaces
  say groups have no repository (`GROUP_REPOS_RETIRED_SENTENCE`) because older frozen prompts still name
  the tools. Team knowledge travels as shared skills.
- **A retirement never destroys data without a way back.** Every retirement step (boot purges and the
  ungated retired drops in `migrate()`) runs behind `retirementGate()`: when anything retired is present,
  the whole DB is first copied to `<dataDir>/backups/pre-retire-<stamp>.db` (0600), and if that backup
  fails EVERY destructive step is held until a later boot. Files are never deleted, only renamed
  no-follow into `<dataDir>/retired/<stamp>/` (`quarantineRetired`; EXDEV stays pending, never
  copy+delete). Noah never prunes either folder — cleanup is the operator's (user decision 2026-10-29).
  **A new retirement goes through the same gate and quarantine helpers.**
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
- **A PPT share link is a human-initiated EXPORT of ONE deck card — never reach, trust or conversation access.**
  Login-required (any signed-in, non-suspended user holding it), expiring (1/7/30 d, fixed at creation),
  revocable, PPTX-only: the .pptx card plus the renders STAMPED with its id (`shareSlideAttachments` — strict
  `parentId`, the ONLY selector links use; unstamped hidden images never leave the thread). Deliberately NOT
  group-bounded, yet it never touches `isTrustedFor`, visibility or tool access. Only the SHA-256 of a per-row-salted HMAC token is stored; the token rides the
  URL FRAGMENT and a POST body (never a path), bytes flow through short-lived tickets MACed over the viewer AND
  that salt (a leaked SESSION_SECRET plus a logged link id mints neither), the served name always ends in .pptx, and
  every recipient call re-runs the full validity — every invalid state is ONE 404, never a 401 (the client logs a
  signed-in user out on any 401). The avatar mints one (`mcp__file_output__create_share_link`) only on an explicit
  user request in an interactive own-avatar chat, behind three locks: the chat route supplies `onShareLink` only on
  those turns, the capability plan's `shareLinkToolActive` (`runCapabilities.ts`) admits the tool (gated on BOTH
  `headless` and `externalTaskApi`, never consultations), and the callback re-checks per call; both metacognition surfaces read
  `shareLinksEnabled` and send every other run to the card's 공유 링크 button. **A new conversation-deleting path
  cascades `deleteShareLinksForConversation` next to the canvas cascade.** Mechanics →
  `docs/architecture/share-links.md`.
- **A personal API key IS the owner, and an API-submitted turn is MACHINE-authored.** The external
  task API (`POST /api/v1/avatar/tasks`, Bearer `noah_…` key, SHA-256 hash stored, ≤10 per user,
  issued under 권한·연결) runs the owner's MAIN avatar as a FULL owner run through `executeChatTurn` —
  same tools, the owner's sandbox, repo commits — and the key holder answers the run's `question`/`canvas`
  prompts via `/respond`, so a leaked key is the owner's session. Keys are accepted ONLY under
  `/api/v1/avatar/tasks`, never on session/admin routes, and session cookies are never accepted
  there. The `message` was NOT typed by the owner (incident bodies, log excerpts), so the run is
  provenance-stamped (`ChatTurnContext.externalTaskId` → `AgentRequest.externalTaskApi`): the prompt
  tells the avatar to treat the body as that system's data, `describe_system` reports the origin, and
  interactive-only gates (`mcp__file_output__create_share_link`) exclude it exactly like `headless` — **when you add an
  interactive-only capability, gate it on BOTH `headless` and `externalTaskApi`.** Tasks are a SQLite
  queue (queued → running → succeeded/failed/cancelled; `waiting_input` is presentation-only) drained
  by a 1 s dispatcher (per-owner 1, process-wide 4, waits behind an active run on the same
  conversation, backs off on 409, records a graceful restart as `failed`), independent of routines;
  the run's audit rows keep their own action names (only `chat` becomes `avatar_api_task`). Mechanics →
  `docs/architecture/avatar-task-api.md`.
- **A mid-turn user message ("steer") is delivered AFTER the current answer, on the SAME run — never a
  second run.** `POST /api/chat/runs/:runId/message` pushes text into the live run's `SteerChannel`; pi has
  no mid-turn input, so when the pi response completes `runPiAgent` drains EVERY queued steer (and every
  async `ask_avatar` answer) as ONE follow-up turn: the run stays OPEN and the segment so far persists as
  its own message (`turn_end`, not `done`). Persist at DELIVERY (= that follow-up turn) only; a run given
  no channel (headless, external-task-API) cannot be steered; `midTurnMessages` says so on BOTH
  metacognition surfaces, and the composer always says the message follows the current answer. Rows from
  the retired CLI runner (which folded steers in mid-turn) keep their position-based badge
  (`steerBadgeLabel`). Mechanics → `docs/architecture/chat-sse-media.md`.
- **A rewind cuts HISTORY, never the world.** Editing an earlier message and 다시 생성 share ONE plan →
  apply path: `planConversationRewind` before the turn's first await, `applyConversationRewind` right
  before `openRun` after a synchronous re-plan that refuses on any drift. Exact context comes from the
  resume point each success boundary stamps on its assistant row (the pi response id; the rewound turn
  continues from that OLDER `previous_response_id`, so pi branches and no stored turn is rewritten); the
  kept text history is the fallback (a pre-pi CLI id is never resumable). Side
  effects are never undone and BOTH metacognition surfaces say so. A user row written while another run
  is active is `kind: "queued"` and never an anchor. **A new message-deleting path cascades like
  `applyConversationRewind`** (attachments minus carried ones, their staged workspace copies included,
  per-card share links and canvases from the anchor time). The manual `/compact` is RETIRED (refused like
  `/new`; pi compacts context on its own). Mechanics →
  `docs/architecture/chat-sse-media.md`.
- **git remote work is MCP-only BY DESIGN.** The agent shell (the run principal's pi sandbox) holds NO git
  credentials, so Bash `git push`/`gh` can never authenticate. Route every git-ish capability through a
  Noah MCP tool (`mcp__repo__*`/`mcp__git_repo__*`) and keep the no-Bash-fallback
  line in its error text. Per-user git tokens are used server-side only, never reach the agent, and Noah
  runs git only in its own canonical clone — never in a `.git` the agent can edit.
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
  run's redaction set, which the `/mcp` endpoint applies to every Noah tool result; audit rows carry the
  NAME only). The degrade is client-side, not a floor
  bump: an extension below `SECRET_INPUT_MIN_EXTENSION_VERSION` never receives the value. One-time codes
  and payment details stay off-limits on every surface. Both metacognition surfaces list the enabled
  names + sites and branch on whether the bridge is connected. Mechanics →
  `docs/architecture/browser-bridge/actions.md`, `secrets-ssh.md`.
- **An external HTTP MCP server gets a user's secret only because THAT USER bound it — and only through the bridge.**
  Admin 공용 MCP 서버 (`sharedMcpServers.ts`) declare credential SLOTS (header + format), never secret names; each
  user binds one of their own secrets per slot, tied to the server ORIGIN (a moved host resets every binding —
  user decision 2026-10-26). Noah relays every such server itself (the `shared` relay id) through
  `scripts/mcp-http-bridge.mjs`, whose config file — the only place a slot value lands — is written right
  before the spawn and deleted by the bridge; values never ride argv and never reach the sandbox. Relaying
  IS the gate (a third-party server cannot self-gate): a slotted server is relayed only on elevated,
  non-consultation runs with every slot bound, else it sits the run out and BOTH metacognition surfaces say
  why. Mechanics → `docs/architecture/secrets-ssh.md`, `pi-runtime.md` ("Proxied MCP servers").
- **The agent's code never runs in Noah's container; Noah's own process stays hardened (#71).** The agent's
  shell and files live in the run principal's pi sandbox, so #71 (every agent Bash reaching the shared data
  volume as Noah's uid) is closed structurally. What Noah still spawns is its OWN code — the hex-ssh policy
  proxy, `mcp-http-bridge.mjs`, stdio MCP servers of the plugins bundled with this build — never a command
  from an agent-editable root. The phase-0 hardening stays: the server process is non-dumpable, server-only
  secrets never reach a child through its ENV, and nothing secret rides argv — a secret FILE is not covered: pi's
  service-key file (`PI_GATEWAY_API_KEY_FILE`, uid 1000, 0400) stays readable to every same-uid child. The image makes node and tini EXECUTE-ONLY
  (`chmod 0711`) so their environ/memory are unreadable to other same-uid processes — PID 1 is that tini,
  started via `docker-entrypoint.sh`'s exec, so compose `init: true` must stay OFF on the base service (a
  runtime-started PID 1 stays readable); `index.ts` drops `SERVER_ONLY_SECRET_ENV_NAMES` (`secretPolicy.ts`)
  from `process.env` right after the config loads — **a new server-only secret joins that list**, and a new
  child-process env starts from the scrubbed `process.env`. Server git passes auth and config only through
  `serverGitEnv` (GIT_CONFIG_* env, hooks + fsmonitor OFF in agent-edited clones), never `-c` in argv
  (cmdline is world-readable). Mechanics → `docs/architecture/secrets-ssh.md` ("Same-uid posture (#71)").
- **Tool access has TWO halves, and the sandbox is the boundary for the first.** Built-ins are pi's
  (read/write/edit/bash/ls/find/grep), on in the run principal's sandbox. pi's only per-request switches are
  `interactive` and `read_only`; a colleague chat's session is `read_only` (read/ls/find/grep), every other
  class has the full set. An admin built-in toggle is advisory there (describe_system says so). Every Noah MCP tool is gated PER CALL: the `/mcp` endpoint admits
  only the run's `mcpAllowedTools` (`allowCall`, bearer run token only), and tools/list is a static catalog,
  so a listed tool proves nothing — **every MCP handler MUST self-gate** (owner/elevated/member checks live
  there). There is no permission prompt (no tool call waits for approval); an AskUserQuestion is pi's
  `requires_action`, answered through `/respond`.
- **New decks are HTML converted SHELL-side in the sandbox, bounded by the converter itself; share_file's exact
  previews are HASH-BOUND.** The bundled `pptx` skill renders agent-authored slide HTML in a network-blocked,
  CSP-locked headless Chromium and converts it into native, editable objects from ONE foreground Bash command
  (`scripts/deck.sh`) in the principal's pi sandbox (the deck image, `docker/pi-sandbox`) — never an MCP tool
  (Noah's container holds the DB and every secret, the wrong place for a Chromium). Nothing prompts before it
  runs, so the converter's own lints, CSP, network block, kernel-held locks and time/size budgets (every run
  ends before the 600 s Bash ceiling) ARE the boundary. The build writes `<stem>.preview/manifest.json` bound to
  the .pptx's sha256; `onShareFile` attaches those renders only when the hash matches the bytes it stored
  (realpath/roots/magic checks like every workspace read), else falls back to a Noah-side LibreOffice preview
  with a redirecting note. Toolchain state = the operator's `PI_DECK_SANDBOX` flag (`piSandboxDeckToolchain`),
  never a host probe, reported on BOTH metacognition surfaces with explicit `converter: INSTALLED` /
  `converter: NOT INSTALLED` markers the skill keys on. Mechanics → `docs/architecture/pptx-converter.md`.
- **An image the avatar is SHOWN is also a FILE it can place.** Vision-turn attachments are staged into the
  conversation's sandbox folder `/workspace/c/<conv-seg>/` (`attachments/`; its host view, made by
  `preparePiRunWorkspace`, is the turn's workspace, so every copy below lands there) exactly like text-only
  turns, every browser screenshot is also saved there (`captures/`, written server-side in the relay —
  `savedPath` never crosses the extension wire), and `mcp__confluence__get_attachment {save_to_workspace}`
  writes into `confluence/` — so a deck or document includes the image instead of describing it. Every
  host-side write below a sandbox root goes through the descriptor-pinned `PinnedDir`/`piSandboxDir` (the
  agent owns those folders and can swap any of them for a link). Both metacognition surfaces list which of
  these the run has. These server-written copies die with what they mirror: **a new
  conversation-deleting path calls `deleteConversationWorkspaceCopies`**, and a rewind's dropped attachments take their
  staged copies along. The pptx skill settles each slide's visual AND its source first, and text stays a legitimate
  choice: **never add a check that fires because a slide has no image** (user decision 2026-09-30). Text over a picture
  must pass the converter's worst-case `text-on-picture` contrast, which holds for ANY photo, incl. one swapped in
  later in PowerPoint.
- **pi-gateway is the ONLY agent runtime; Noah stays the BFF and the gatekeeper.** The Claude Agent SDK / Claude
  Code CLI runner is RETIRED (U8, 2026-10-29): `AGENT_RUNTIME` is `pi` (default; `PI_GATEWAY_URL`,
  the service key (`PI_GATEWAY_API_KEY`, or `PI_GATEWAY_API_KEY_FILE` — never both) are required) or `local` (the
  deterministic stub for tests and the e2e harness); anything else stops the
  boot. Every run goes to `runPiAgent` in ONE sandbox principal, `piRunPrincipal` = whoever the run executes AS
  (`viewerUserId ?? avatar.id`: the viewer of a colleague chat, the owner of a routine/task/generator). An avatar
  CONSULTATION is nobody's: it runs in a FRESH, EMPTY sandbox of its own (`consult-<random>`,
  `beginPiConsultationSandbox`), deleted when it ends and swept at boot after a crash — never the asker's (the
  target's authored text would drive a shell over the asker's files, unattended) nor the target's (user decision
  2026-10-30); `viewerUserId` stays the asker for the MCP gates. A COLLEAGUE chat (trusted or not) runs someone
  else's avatar in the colleague's own sandbox, so its pi session is `read_only` (pi P1: only
  read/ls/find/grep — no write/edit/bash, no sandbox-run MCP server; `PiRuntimeFacts.readOnlyBuiltins`, sent on a
  new session; user decision 2026-10-31). The consultation and the intro/hashtag generators keep the FULL
  built-ins, never over the owner's files; every class reaches owner data only through the gated, self-gating MCP
  tools, and both surfaces say exactly that. A run
  without a conversation works in a `/workspace/c/<run-…>/` folder (no stored session, no frozen prompt row; a
  generator's folder is reused in the owner's sandbox, a consultation's goes with its sandbox).
  Noah never executes git or agent-authored code from a sandbox dir: a working repo is a sandbox COPY whose
  working tree `commit` reads back into the canonical clone (git runs there, `serverGitEnv`), and a stdio plugin
  MCP server spawns only from the plugins bundled with Noah — every agent-editable root (knowledge repo, group
  repos, installed plugin repos the agent can push to) is skipped and both surfaces say why. Noah's tools reach
  pi's broker over `/mcp/<server>`, whose ONLY auth is the per-run bearer token (session cookies never count).
  **A new server joins `PI_MCP_SERVER_NAMES` (`agent/pi/mcpCatalog.ts`) AND `scripts/pi-register-mcp.mjs`**; the
  bundled one-shot `pi-setup` service re-runs the script on every `docker compose up`. The prompt is FROZEN per conversation (D2, `conversations.pi_instructions`,
  sent only when a pi session starts; per-turn facts ride the user input). Every gap pi has is stated on BOTH
  metacognition surfaces: a model/effort change starts a new session from history, no WebSearch, relayed tool
  lists are per session, and `ask_avatar` (interactive chat) / canvas never wait — the answer or submission
  arrives as a later message. 셸 노출 secrets reach the shell ONLY on owner runs in the owner's own sandbox (owner
  chat, owner routine, task API — `ownerToolAccess && sandboxOwner === "owner"`): Noah re-sends them on EVERY pi
  request as `sandbox_env` (pi keeps them in memory for that request only, passes them to `bash` alone and redacts
  them from tool results; Noah adds them to the run's redaction set), and both surfaces name them from
  `PiRuntimeFacts.shellSecretNames`. The retired runner's leftovers on existing
  deployments go through `retirementGate()`: the `claude_oauth_token` and skill-discovery cache keys are deleted
  and reserved forever, `<dataDir>/agent-sessions` (CLI transcripts) is quarantined, and old CLI session ids are
  ignored (the next turn continues from the text history). **The models are pi-gateway's LIVE list** (`GET /v1/models`,
  `agent/pi/modelCatalog.ts`, user decision 2026-10-31): a model value anywhere (composer pick, per-user default,
  admin override, vision-policy key) is a pi model id, none = pi-gateway's default model (Noah sends no `model`), and
  a stored value pi does not currently offer (a legacy tier alias like `opus`) reads as that default — never
  migrated. Writes validate against the list (400 unknown, 503 unreachable); the chat stream stores a pick as sent.
  The tier registry and `PI_MODEL_MAP` are RETIRED (a still-set `PI_MODEL_MAP` only logs a boot warning); an
  unattended run's fallback is ONE retry on the default. Mechanics → `docs/architecture/pi-runtime.md`.
- **할 일 is ONE per-user list behind ONE store.** The 할 일 tab, the chat overlay (toggled under the
  composer) and the owner's avatar all write `todo_items` through `store/todos.ts`, validated by the pure
  `src/server/todos.ts` (error CODES, Korean/English maps per channel); wire types, limits and the ONE
  display order are the import-free `src/shared/todos.ts`, and due dates are optional KST calendar
  dates (date only) from `routineSchedule.ts`. The `mcp__todo__*` tools exist ONLY on owner runs
  (interactive own-avatar chat, owner routine, external task API — never colleague or
  consultation runs), ride the always-on `system` group so no saved tool selection or group policy can
  drop them, and an API-submitted run cannot delete. They edit the owner's PERSISTENT list — pi has no
  private checklist tool, and the tool text plus the prompt keep a working note from ever passing for the
  owner's list. An item's `status` is `todo`/`in_progress` (OPEN — the cap, counts, badge, card and
  prompt) or `done`/`dropped` (CLOSED; user decision 2026-10-10): test open-ness with `isOpenTodo`, never
  `!== "done"`, and keep EVERY write setting the `done` column with it — it is a rollback mirror, and the
  ungated boot reconcile rewrites any row whose mirror disagrees. The chat card reviews, completes,
  starts/pauses and drops (row actions, user decision 2026-10-21) — ADDING stays the tab's or the
  avatar's (user decision 2026-10-10) — and animates only the avatar's own changes. The prompt states the list FROZEN
  at a conversation's first to-do-capable turn (`conversations.todo_snapshot`, written once and never
  refreshed so the append stays prompt-cache stable — user decision 2026-10-10); the live counts ride
  `describe_system` and the tool headers.
  Mechanics → `docs/architecture/todos.md`.
- **Knowledge repo = one per user, agent-managed** (the avatar edits its own repo via `mcp__repo__*`).
  **Second brain = a CONVENTION (`wiki/`+`raw/`) over that SAME repo, NOT a new store** — recall is
  read-only MCP search; capture writes through the repo-write tools + commit (uncommitted = not persisted).
  The second brain is PERSONAL only: the team brain (`mcp__group_brain__*`, group vault, group graph) was
  removed 2026-10-30 with the group repos it lived in (user decision).
- **Per-user settings follow ONE pattern** (column → migration → `toUser` → `updateProfile` → `User` type →
  `PATCH /api/me` → settings tab). Some defaults are written from the composer, not a settings tab: the
  model/effort/MCP-tool-group pickers remember the owner's last choice via per-user defaults
  (`*_default` columns + `setChatDefaults` + `PUT /api/me/chat-defaults`) that seed new conversations.
  The per-conversation `selected_*` value still overrides the
  default when resuming an existing thread.
- **Modules are split behind UNCHANGED exports.** When refactoring, keep import paths stable via
  re-exports rather than forcing callers to move.

## Module map
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers); handlers in
  `src/server/routes/{auth,profile,directMessages,plugins,knowledgeRepo,groups,routines,chat,admin,browserExtension}.ts`
  (+ `_shared.ts`).
- **Agent:** `agent/index.ts` (`runAgentStream`) → `agent/pi/runPiAgent.ts` (or the `local` stub);
  `agent/runCapabilities.ts` is the ONE capability plan; `buildSystemPromptAppend` / `buildUserPrompt` in
  `agent/promptBuilder.ts`; shared self-state in `agent/ownerState.ts`; MCP server shim in
  `agent/mcpServer.ts` (`createMcpToolServer`), helpers in `agent/mcpTools.ts`, repo-tool skeleton in
  `agent/repoToolKit.ts`; the `/mcp` endpoint in `mcpHttp/endpoint.ts`.
- **Store:** `store.ts` is a thin barrel; the `Store` facade is composed from per-domain mixins in
  `store/*.ts`. Public surface unchanged (`new Store(config)` + `store.foo()`).
- **Repo git:** low-level plumbing shared via `repoGitCore.ts` + `repoGitGuards.ts`.
- **Client:** Svelte + Vite under `src/client/` (NOT vanilla `public/`); central store `lib/state.ts`.
- **Shared:** `src/shared/*` is the real client↔server layer (`mcpToolGroups.ts`,
  `sdkToolPresentation.ts`); `tsconfig.client.json`'s `include` lists the extra server modules the
  client may import. New cross-boundary code goes there, not into a hand-copy.
- **Tests:** ~38 vitest files by area — `agent-*`, `client-*`, `svelte-*`, `browser-*`, `store`,
  `infra`, `app`, `chat-history` (+ `tests/helpers.ts`).
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
- **Noah ships WITH its pi-gateway as ONE compose stack (U9).** `docker-compose.yml` `include:`s pi-gateway's
  own compose file from the `vendor/pi-gateway` git submodule (`${PI_GATEWAY_DIR:-./vendor/pi-gateway}`; the
  gitlink IS the pin, kept out of the Noah image by `.dockerignore`; pi's code and compose file are never edited) plus `docker/pi/compose.override.yml` (Noah's
  instance config: sandboxd runs `noah-almighty/pi-sandbox`, the broker's pinned address). Facts that fail in
  the field, not in CI: a one-shot `pi-setup` service (uid 10001, pi's admin-key secret) registers Noah's MCP
  servers and Noah's prompt on every `up`, and Noah starts only after it exits 0; pi's broker reaches `/mcp` over
  the internal `noah-mcp` network from `172.16.248.10` (`NOAH_MCP_BROKER_IP`; the subnet stays OUTSIDE Docker's
  default address pools), and `NOAH_MCP_ALLOWED_CIDRS`
  defaults to exactly that /32; Noah gets pi's service key ONLY as its own compose secret
  (`PI_GATEWAY_API_KEY_FILE=/run/secrets/pi_gateway_api_key`, uid 1000 0400 copy by `docker/pi/setup-host.sh`
  — a `PI_GATEWAY_API_KEY` in `.env` next to it stops the boot); `.env` wins inside pi's compose file too, so a
  shared key means the same on both sides — `NODE_EXTRA_CA_CERTS` is a HOST path (mounted read-only into
  Noah); ONE pi-gateway per Docker daemon (sandboxd reaps every `pi-gateway.instance=default` sandbox); the
  egress overlay (`docker-compose.egress.yml`) is NOT supported with the bundle (its firewall blocks pi's
  gateway). A pi-gateway bump moves the submodule to a PUSHED commit and re-runs the dind boot test (`build-run-verify.md`).
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
