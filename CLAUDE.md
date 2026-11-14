# Noah Almighty — Claude notes

The durable **direction and philosophy** of this codebase: each invariant is the rule, why it holds, and
what to do when you add something. **Mechanics** (file/function/column/env names, limits, edge cases,
decision dates, gotchas) live ONLY in **[`docs/ARCHITECTURE-NOTES.md`](docs/ARCHITECTURE-NOTES.md)** — an
index over per-subsystem pages in [`docs/architecture/`](docs/architecture/); open the index, then load
only the page for what you are touching. Keep this file that way: a new invariant gets 2–4 lines here and
its detail goes to the page. See README.md for features, setup, env vars, verification.

## Core design direction

These are the invariants the project is built around. New work should reinforce them, not erode them.

### The avatar knows itself
- **META-COGNITION of its own system state.** The avatar must know what is configured and what it can do
  RIGHT NOW (repo, tokens, secrets, tools, runtime gaps) instead of guessing. Two surfaces: the prompt
  append (`buildSystemPromptAppend`, rendered ONCE per conversation into the frozen pi instructions) and
  the LIVE `mcp__system__describe_system`. **When you add a capability, surface its state in BOTH** —
  shared facts come from `agent/ownerState.ts` (`summarizeOwnerState`). Never offer a route the run does
  not actually have. → `agent-core.md` ("Cross-cutting rules").
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it
  STANDING per-turn guidance + an action-trigger in the tool's description + an error that redirects.
- **Language split: agent-facing text is English, user-facing text is Korean.** Test: *"does the model
  read it as INPUT?"* → English (prompts, tool descriptions, tool errors/refusals, slash-command
  expansions, bundled `SKILL.md`); else Korean (UI, `apiError`, status labels, titles). A string used on
  both channels is split. The avatar replies in the user's language (default Korean).

### Team, trust, sharing
- **ONE Noah instance = ONE team; trust = an approved (not suspended) user.** Every approved user is a
  teammate, all equal and mutually trusted (no guest tier). `isTrustedFor` stays the single choke point
  every trust check flows through — add new trust sources (or restrictions) THERE, never at call sites.
  **Signup approval IS the trust gate**, so an `open` signup mode must never return (`approval` | `closed`).
- **Avatar visibility is `group` (팀 공개) | `private` (비공개)** — `public` is retired; nothing reaches
  beyond the team. Visibility and trust stay separate axes: a private avatar's owner is still a trusted
  teammate. Reach, trust and skill sharing ride ONE team relation, so they never drift apart.
- **Groups are RETIRED (2026-11-06)**, after group shared agents (2026-10-29) and group knowledge repos /
  per-group brain (2026-10-30); team HOW-TO travels as shared skills, team FACTS live in the ONE team brain
  (below), and the admin MCP tool policy is ONE
  global policy that binds admins too. Every group table, column, route (`/api/{me,admin}/groups*`),
  prefix (`group:`, `group-`), dir and MCP name is **reserved forever** — never mint them again (true of
  EVERY retired id, setting key, column, dir or broker name). → `server-core.md`, `team-trust.md`.
- **Skill sharing rides the avatar-discovery boundary — never wider**, for CONTENT as well as rows:
  learning COPIES the skill into the learner's repo; a learned copy is not re-shareable while linked to
  its origin; system-admin blocks fail closed on every learnable read, are never deleted (only
  unblocked) and are copied on rename; a renamed skill is followed only on git's own rename evidence — a
  deletion is always a hard revoke and anything unresolved unshares. `mcp__skill_exchange__*` is
  owner-only end to end. → `avatar-collab.md`.

### Data safety
- **A retirement never destroys data without a way back.** Every destructive retirement step runs behind
  `retirementGate()` (full DB backup first; a failed backup holds every step), and files are only
  quarantined (`quarantineRetired`, renamed, never deleted; Noah never prunes them). **A new retirement
  goes through the same gate and quarantine helpers.** → `server-core.md`.
- **A rewind cuts HISTORY, never the world.** Editing an earlier message and 다시 생성 share ONE
  plan→apply path that continues from the older pi response id (pi branches; no stored turn is
  rewritten). Side effects are never undone, and both surfaces say so. **A new message-deleting path
  cascades like `applyConversationRewind`.** → `chat-sse-media.md`.
- **Server-written copies die with what they mirror.** **A new conversation-deleting path calls
  `deleteShareLinksForConversation` (next to the canvas cascade) and `deleteConversationWorkspaceCopies`.**
  → `chat-sse-media.md` ("Deletion cascades").

### Runtime and execution boundary
- **pi-gateway is the ONLY agent runtime; Noah is the BFF and the gatekeeper.** The Claude Agent SDK
  runner is retired (`AGENT_RUNTIME` = `pi` | `local` stub). Every run executes in ONE pi sandbox
  principal — whoever the run executes AS; a consultation gets a fresh throwaway sandbox (never the
  asker's or target's); a colleague chat's session is `read_only`; a run nobody can answer is
  `interactive: false`. The prompt is FROZEN per conversation; every gap pi has is stated on both
  surfaces. → `pi-runtime.md`.
- **Noah holds NO LLM settings of its own.** Models are pi-gateway's LIVE list (`/v1/models`); a model
  value anywhere is a pi model id, and pi's admin LLM page owns every model's meaning and image input. The
  ONE fixed choice: with no pick Noah sends pi's `falcon` TIER (pi's own default only when pi has none) —
  a name pi resolves, never a model id hard-coded in Noah; pi's behavior is never changed for it. Noah's
  `admin` role IS pi admin (pi's panel is proxied at `/admin`). → `pi-runtime.md`.
- **The agent's code never runs in Noah's container; Noah's own process stays hardened (#71).** Noah
  spawns only its OWN code (never from an agent-editable root, never a relayed tool taking a local path),
  never follows a committed link out of a user clone, keeps secrets off argv and out of child env. **A new
  server-only secret joins `SERVER_ONLY_SECRET_ENV_NAMES`**; a new child env starts from the scrubbed
  `process.env`; server git config/auth goes only through `serverGitEnv`; compose `init:` stays OFF on the
  base service (PID 1 must be the image's execute-only tini). → `secrets-ssh.md`.
- **Tool access has TWO halves.** pi built-ins are bounded by the sandbox. Every Noah MCP tool is gated PER
  CALL at `/mcp` (per-run bearer token only), but tools/list is a static catalog, so **every MCP handler
  MUST self-gate** (owner/elevated/member checks). No tool call ever waits for approval. **A new MCP server
  joins `PI_NOAH_SERVER_NAMES` (`agent/pi/mcpCatalog.ts`; a relay id: `PI_PROXY_SERVER_NAMES` in
  `mcpProxies.ts`) AND `scripts/pi-register-mcp.mjs`** → `agent-core.md`.
- **git remote work is MCP-only BY DESIGN.** The sandbox holds no git credentials; route every git-ish
  capability through `mcp__repo__*`/`mcp__git_repo__*` and keep the no-Bash-fallback line in its errors.
  Tokens stay server-side; Noah runs git only in its own canonical clone, never a `.git` the agent can
  edit, and a working copy goes ONLY into the owner's own sandbox. → `repo-knowledge.md`.

### Run provenance
- **A personal API key IS the owner, and an API-submitted turn is MACHINE-authored.** The external task
  API runs a FULL owner run (a leaked key is the owner's session); keys work only under
  `/api/v1/avatar/tasks`, where session cookies never count; the body is treated as that system's data. **When you add an interactive-only
  capability, gate it on BOTH `headless` and `externalTaskApi`.** → `avatar-task-api.md`.
- **A mid-turn user message ("steer") is delivered INTO the running turn, on the SAME run — never a
  second run.** Undelivered steers (and every `/`-leading one, never handed to pi) fall back to ONE
  follow-up turn on the still-open run; persist at delivery only. → `chat-sse-media.md`.

### Secrets and the user's browser
- **Browser control is a RELAY into the user's own browser.** An `mcp__browser__*` op crosses FIVE
  hand-synced layers (`agent/browserTools.ts` → `agent/events.ts` → `routes/chat.ts` → client
  `lib/browserBridge.ts` → `extension/background.js`) plus both surfaces, and nothing type-checks across
  them. The security boundary is the extension's default-deny `CDP_ALLOWLIST`, not the manifest; the
  extension runs no page JS except the fixed bridge-authored expressions behind `read_storage`. Cookie/
  storage reads need consent IN THE EXTENSION per site (and per storage type) and are audited by key name
  + count, never value. Drive what can't be executed directly the way a PERSON would and re-read the
  result. Screenshot pixel→CSS mapping comes from the MEASURED bitmap and is reported in every pixel-mode
  result. Everything a page returns is UNTRUSTED. → `browser-bridge.md` (hub; start
  with `contract.md`).
- **A server-held third-party credential stays READ-ONLY; the WRITE path is the user's own browser.**
  Read-only is STRUCTURAL (the Confluence `requestJson` has no method/body); writes go through the user's
  own browser, so they stay attributable, visible and undoable. → `agent-core.md` ("Cross-cutting rules").
- **A stored secret reaches a login form by NAME, never by value — and the model never sees it.** Owner
  opt-in per secret with exact hosts, host checks at both ends, password-field-only, a consent popup the
  server cannot bypass, never-quoted/always-redacted. An older extension simply never receives the value —
  never raise the compat floor for it. One-time codes and payment details stay off-limits.
  → `browser-bridge/actions.md`, `secrets-ssh.md`.
- **The upload relay is a PULL from ONE operator-configured address — never a "fetch this link".** On a
  DRM fleet the attach button opens the relay's page (UniBridge) and Noah's server collects the file with a
  ticket bound to its user; no user-supplied URL is ever fetched, the browser-held ticket can upload but
  not read back, the bytes are judged (a non-decrypted file fails) and audited on BOTH sides, and nothing
  is stored on the way. SENT is not RECEIVED: the "received" row and the relay's delete wait for the
  browser's `confirm`. Paste and drop stay direct. → `chat-sse-media.md` ("Upload relay").
- **An external HTTP MCP server gets a user's secret only because THAT USER bound it — and only through
  Noah's bridge.** Admin servers declare slots, users bind their own secrets (origin-bound); relaying IS
  the gate. → `secrets-ssh.md`.
- **셸 노출 secrets reach the shell ONLY on owner runs in the owner's own sandbox**, re-sent per request
  and redacted. → `pi-runtime.md`.

### Features with a fixed shape
- **A PPT share link is a human-initiated EXPORT of ONE deck card — never reach, trust or conversation
  access.** Login-required, expiring, revocable, PPTX-only; only a salted hash is stored, the token never
  rides a URL path, every recipient call re-runs full validity, and every invalid state is ONE 404 (never
  401 — the client logs out on 401). The avatar mints one only on explicit request in an interactive own-avatar
  chat. → `share-links.md`.
- **New decks are HTML converted SHELL-side in the sandbox, bounded by the converter itself** (never an
  MCP tool — Noah's container holds the DB and every secret); share_file previews are hash-bound to the
  .pptx. Toolchain state is the operator's `PI_DECK_SANDBOX` flag, never a host probe, reported with the
  exact `converter: INSTALLED` / `converter: NOT INSTALLED` markers the skill keys on. → `pptx-converter.md`.
- **A `.drawio` diagram is DECLARED by the avatar and laid out by the skill's own tool, SHELL-side in the
  sandbox** (`drawio.sh layout | route | check`; never an MCP tool, never the network) — the model cannot
  see the picture. The engine is vendored whole into the skill (hash-pinned, Node only: no toolchain flag,
  nothing to install). **A fix goes into `engine/lib/`, never into a vendored file.** → `drawio-skill.md`.
- **An image the avatar is SHOWN is also a FILE it can place** (attachments, screenshots, Confluence
  attachments land in the conversation's sandbox folder; host-side writes go through `PinnedDir`). Text
  stays a legitimate slide choice: **never add a check that fires because a slide has no image.**
  → `chat-sse-media.md`, `pptx-converter.md`.
- **Inline UI is WRITTEN IN THE ANSWER TEXT — never a canvas, a tool call or executed code.** The avatar
  mixes component tags into its Markdown (the grammar rides the prompt of every interactive chat run; always
  on, no flag) and the viewer's browser parses and evaluates them in an AST interpreter while the answer
  streams. The answer is already on screen, so rendering is LENIENT and what could not be drawn is told to
  the avatar on its next turn. ONE table is the grammar (`src/shared/widget/spec.ts`). **What a control
  will do is a declared prop the user can see before pressing** (`send`/`<submit>` = their next chat
  message, never a `/` command; `href`) — never a free action, a remote/`data:` load or anything evaluated
  outside the interpreter. A chart the user only looks at goes here too, and a diagram is a ` ```mermaid `
  code block of the answer that the client's Markdown draws in place — never a tag; the canvas is for a
  side-panel artifact. Everything it can draw is on show at `#/uiGallery`, drawn by the SAME renderer:
  **a new component or chart type gets its sample in `lib/uiGallery.ts`** (a test fails without one).
  → `chat-sse-media.md` ("Inline UI").
- **A release note with a control on screen also SHOWS itself there.** The 새로워진 기능 dialog stays; an
  item's `hint` (same registry) rings that control and explains it in a bubble until the user presses
  알겠어요 or uses the control — recorded per account, never for a bubble that merely could not be shown.
  One at a time, never over a dialog. **A hint id is never reused; a new anchor is marked with
  `featureHintAnchor` and gets a side.** → `server-core.md`, `client.md` ("Feature hints").
- **관리자 공지 is ONE plain-text notice for PEOPLE, across the top of every screen.** An admin sets it
  (text + 안내/주의/긴급 + on/off); each account may close it, and every save is a new announcement that
  shows again. It is never markup or a link, never shown before login, and never reaches the avatar (no
  prompt, no `describe_system`). → `server-core.md`, `client.md` ("관리자 공지").
- **The chat's 파일 tab is a READ-ONLY window for PEOPLE onto their OWN sandbox workspace.** It is open by
  default (the viewer's close is remembered in their browser; it never takes the panel from a canvas). It shows the
  workspace root with `c/` replaced by THIS conversation's folder (the shared folders stay; other conversations
  only on request) and says so in the tab, so nobody has to know the layout. Pinned descriptors only (a link is
  shown, never followed), no id that selects another user's files, every byte a sandboxed download, a file drawn
  only as text or through the chat's sanitizers. It never writes or deletes in the workspace and never reaches
  the avatar. A pdf/pptx/docx is rendered from Noah's own COPY of the bytes into an expiring per-user cache —
  never from a workspace path. **A new preview kind goes through a sanitizer, its own script-less frame, or
  that copy-then-convert path.** A `share_file` card records where its file sat, and the VIEWER's press on the
  card (폴더에서 보기) opens the tab there — the card stays the copy, the tab shows the file as it is now; the
  avatar never opens, selects or learns of the tab. → `pi-runtime.md`, `client.md`.
- **할 일 is ONE per-user list behind ONE store** (`store/todos.ts`). `mcp__todo__*` exist only on owner
  runs (always-on `system` group; an API run cannot delete); test open-ness with `isOpenTodo` and keep every
  write setting the `done` mirror. The chat card never ADDS items, and the prompt's list snapshot is frozen
  per conversation, never refreshed. → `todos.md`.
- **Knowledge repo = one per user, agent-managed. Second brain = a CONVENTION (`wiki/`+`raw/`) over that
  SAME repo, NOT a new store**; uncommitted = not persisted. → `repo-knowledge.md`.
- **One fact, one home — and ONE home for the rules about it.** Team knowledge's canonical home is the team
  brain, personal context the personal brain; every personal-vs-team rule lives ONLY in
  `agent/brainPolicy.ts` (skills and templates refer to it, never restate it). An applied team-brain card
  RECORDS the personal notes it came from; nothing writes the personal repo for it — the avatar asks first.
  When the two disagree, show both. → `repo-knowledge.md`, `team-brain.md`.
- **The team brain gets the reusable conclusion, never the working detail — and selecting is not sharing.**
  ONE level rule gates the everyday offer and the `brain-share` selection pass alike; the pass only DRAFTS a
  few cards (a "no" is remembered on the note as `team_share: no`), and each goes into the team brain only
  with the user's own press on that card — one card, one press, never zero. → `repo-knowledge.md`.
- **Team brain = ONE instance-wide LOCAL git vault that only Noah writes; EVERY teammate writes it through
  their own avatar, and their OWN press commits.** It is a Karpathy-style LLM wiki: immutable
  server-rendered `raw/` sources → `wiki/` pages under a FIXED `SCHEMA.md` the SERVER validates (rules are
  enforced, not just prompted); index/log are server-generated; a schema change = version bump (+ a
  migration pass when a page rule changed), never a hand edit. Any teammate may correct any page (a page
  changed since it was read is refused, never overwritten). There is NO reviewer: every state change is a
  human press on the DRAFTER's own chat
  card (the model only drafts), and wiki text is UNTRUSTED input to every avatar that reads it. The review
  queue is RETIRED (2026-11-13: its kinds, statuses, tools and routes are reserved; old cards stay readable,
  rows left open were closed with a notice). Still admin-only, judged on the VIEWER, never the avatar owner:
  `POLICY.md`, the backup, the `raw/legacy/` migration pass. No delete; the backup is a push-only, never-forced
  mirror to the internal git host with the saving admin's token. New team-brain names are `team_brain*`, never `group*`.
  The admins' `POLICY.md` (knobs the server enforces + guidelines) changes only through a card and can never
  override the fixed core or SCHEMA.md; a new adjustable rule becomes a POLICY.md knob, not a constant.
  A press (done or refused — never a cancel) is REPORTED to the drafting avatar at once, in text the SERVER
  composes from the press it recorded; the client names only the card. **A new card button goes through
  `pressTeamBrainCard`.** → `team-brain.md`.

### Code shape
- **Per-user settings follow ONE pattern** (column → migration → `toUser` → `updateProfile` → `User` type
  → `PATCH /api/me` → settings tab); composer pickers persist per-user defaults via
  `PUT /api/me/chat-defaults`, and a conversation's `selected_*` overrides them on resume.
- **Modules are split behind UNCHANGED exports.** Keep import paths stable via re-exports.

## Module map
- **HTTP:** `app.ts` is thin glue (`createApp` mounts per-domain routers in `src/server/routes/*.ts`).
- **Agent:** `agent/index.ts` (`runAgentStream`) → `agent/pi/runPiAgent.ts` (or the `local` stub);
  `agent/runCapabilities.ts` is the ONE capability plan; prompts in `agent/promptBuilder.ts`; shared
  self-state in `agent/ownerState.ts`; MCP tools via `agent/mcpServer.ts`; the `/mcp` endpoint in
  `mcpHttp/endpoint.ts`.
- **Store:** `store.ts` is a thin barrel over per-domain mixins in `store/*.ts`.
- **Client:** React + Vite under `src/client/` (NOT vanilla `public/`); central store `lib/state.ts`.
- **Shared:** `src/shared/*` is the real client↔server layer; new cross-boundary code goes there, not
  into a hand-copy (`tsconfig.client.json` lists the server modules the client may import).
- Module cautions: [`src/server/CLAUDE.md`](src/server/CLAUDE.md),
  [`src/server/agent/CLAUDE.md`](src/server/agent/CLAUDE.md), [`src/client/CLAUDE.md`](src/client/CLAUDE.md).
  Design language: [`docs/DESIGN.md`](docs/DESIGN.md). Deferred work:
  [`docs/REFACTORING-BACKLOG.md`](docs/REFACTORING-BACKLOG.md).

## Verification gate
- `npm run lint && npm test && npm run build`, plus client checks run directly: `npx tsc --noEmit` +
  `npx tsc -p tsconfig.client.json --noEmit`. ⚠️ The rtk hook misrewrites `npm run lint` to
  eslint and fails — don't rely on it.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file.
- `npm run dev` — server (:48787) + client (vite, :5173).
- Detail → [`docs/architecture/build-run-verify.md`](docs/architecture/build-run-verify.md).

## Deploy topology (don't forget)
- **Coding happens on this WSL2 box; deployment is a SEPARATE internal corporate server.** `localhost` is
  not the deploy env and there is no local DB. Schema/UID/volume/`SESSION_SECRET` changes need an
  EXISTING-deployment migration path.
- **Noah ships WITH its pi-gateway as ONE compose stack** (`vendor/pi-gateway` submodule; pi's code and
  compose file are never edited). What `pi-setup` applies is re-applied on every `up`, so the repo stays
  its source. A pi bump moves the submodule to a PUSHED commit and re-runs the dind boot test. Every upgrade
  re-runs `docker/pi/setup-host.sh` before `docker compose up`. → `pi-runtime.md`, `build-run-verify.md`.
- **Project name diverges by layer:** "Noah Almighty" / `noah-almighty` / working dir `avatar-chat` — grep
  both slugs when auditing names.
- **The user fleet is Windows/Linux only — no macOS.** Keep mac handling defensive-only and never
  advertise macOS in user-facing text or release notes.
- **The browser bridge is a SIGNED artifact on users' machines.** Its id and update channel derive from ONE
  release-machine RSA key (losing it orphans every install). Field-only failures: a new `extension/` file
  must join `BUNDLE_FILES` (binary: also `BINARY_BUNDLE_FILES`), and `BROWSER_EXTENSION_MIN_COMPATIBLE`
  must never exceed the bundled manifest version; every release attaches the update assets (`release`
  skill). → `docs/architecture/browser-bridge/extension.md`, `extension/CLAUDE.md`, `extension/README.md`.
