# Agent core — orchestration, tool policy, MCP servers

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> How a run is assembled (the one capability plan, the pi runner), the admin tool/skill on-off policy, the retired plan mode/Workflow/agent teams, and the checklist for adding an MCP tool server.

Agent orchestration + in-process MCP tool servers. Companion to the agent-area philosophy in
[`../../src/server/agent/CLAUDE.md`](../../src/server/agent/CLAUDE.md).

## How a run is assembled
pi-gateway is the only agent runtime (`AGENT_RUNTIME=pi`, the default; `local` is the deterministic stub for tests
and the e2e harness, with scripted `demo` runs — [build-run-verify.md](build-run-verify.md); any other value, `claude` included, stops the boot). `runAgentStream` (`agent/index.ts`) sends
every non-local run to `runPiAgent` (`agent/pi/runPiAgent.ts`); the sandbox principal is `piRunPrincipal(request)`
(`viewerUserId ?? avatar.id`). Runner, session, sandbox and endpoint mechanics → [pi-runtime.md](pi-runtime.md).
- `runCapabilities.ts` — **the ONE capability plan** (design N1): `buildRunCapabilities` (tool access
  `deriveAgentToolAccess`, MCP families `planMcpToolFamilies`, the in-process MCP servers, the model and its
  fallback chain over pi's live list (`pi/modelCatalog.ts`), describe_system's ctx, `mcpAllowedTools`) and `stampPromptRequest` (the request as the
  prompt builder sees it). The setup half declares **no run-scoped `let`** — it is pure derivation over
  store/config/plugins; every accumulator lives in the runner.
- `promptBuilder.ts` — `buildSystemPromptAppend` + `buildUserPrompt` + compatibility `buildPrompt` +
  `compactConversationHistory`/`conversationHistoryBlock` + `GIT_MCP_ONLY_GUIDANCE`. The append is rendered ONCE
  per conversation (its first pi turn), frozen in `conversations.pi_instructions` and sent as pi `instructions` on
  top of the deployed pi prompt (`scripts/pi-system-prompt.md`); per-turn facts ride the user input
  (`buildPiTurnPreamble`). Stored history + the current user/task instruction stay in the user prompt.
  **`agent-core.test.ts` checks the prompt with `toContain`/`not.toContain` substrings, NOT byte-for-byte** —
  ADDING a section is safe; only changing an EXISTING string (or its presence per viewer class) breaks a test.
  The append's one PROACTIVE section is `gettingStartedSection` (setup gaps from `ownerState.ts`'s
  `gettingStartedGaps`, mirrored by `describe_system`): interactive-owner branch only — so routines and
  colleagues are excluded structurally — and it drops out past ~6 stored messages
  (`conversationHistory.length`, the free conversation-youth signal) so the offer can only be an early one.
- `pi/eventAdapter.ts` — pi Responses SSE → `AgentEvents` (text fold, tool rows, `mcp_call` unwrapping,
  AskUserQuestion via `requires_action`).
- `mcpServer.ts` — `tool(…)` + `createMcpToolServer({ name, tools, … })`, which returns `{ type: "in_process", name,
  instance }` around an `@modelcontextprotocol/sdk` `McpServer` (`InProcessMcpServer`); the `/mcp` endpoint
  (`mcpHttp/endpoint.ts`) serves that instance.
- `secretRedaction.ts` — `redactSecretValues` and the redaction-set helpers (see below).
- `skillCatalog.ts` — `skillMdMeta`, `listPluginRootSkills` (the admin skill policy's listing).
- `runErrors.ts` — `isRetryableModelError`, `resultErrorMessage`.
- `pi/mcpProxies.ts` `piProxyBaseEnv()` — the env for the children Noah itself spawns (relayed MCP servers, the
  admin 공용 MCP check), built from the scrubbed `process.env` minus git credentials and server-only secrets.
- `agentUtils.ts` — small shared helpers.

### The loop half has exactly ONE inbound channel
`AgentEvents.steers` (a `SteerChannel`, `steerChannel.ts`) is the HOST pushing in; every other `AgentEvents` member
is the run calling OUT (even a parked `onQuestion` originates in the loop). `runPiTurn` hands queued steers and
async `ask_avatar` answers to the running pi response; whatever pi did not deliver, the run loop drains at the
response boundary as ONE follow-up turn, and it closes the channel at a steer-free boundary and again in
`finally` (chat-sse-media.md). A run given no channel cannot be steered, and `midTurnMessages` says so on both
metacognition surfaces. The setup half (`buildRunCapabilities`) holds no RUN-scoped `let` (a closure-local
one inside a callback, like `startAskAvatar`'s job id, is fine); run-scoped mutable state lives in the loop.

### Official product manual

`agent/systemManual.ts` is the canonical English, agent-facing product manual, compiled into the
server output (no runtime docs-directory/cwd/network dependency). Its short topic index appears in
every local avatar system prompt; full pages are returned only by `mcp__system__read_manual`.
The `system` MCP group is always registered for local avatars, including old conversations/defaults
or admin policies that omit it. `effectiveMcpToolGroups(selection, policy)` applies this invariant
at both the chat preflight and run-plan boundary; the effective store policy and UI reflect it too.
The composer and admin policy editor display system as checked and non-toggleable. Management
handlers still enforce owner/elevated scope, so tool registration does not grant new privileges.
The manual tool is intentionally public: it reads only static allowlisted topics, never user state
or files. An unknown topic returns the valid index with an error instead of resolving a path.
`describe_system` points to the same manual; live state and permissions still come from its existing
scoped readers.

The standing prompt uses a compact topic index. Browser, canvas and working-repository blocks
keep current scope, safety rules and a BEFORE-use manual trigger; long procedures live in
`browser-operations`, `canvas-operations` and `git-repositories`. Do not move identity, actual
permissions, secret policy, untrusted-input rules or task provenance into optional lookup text.

When a product workflow changes, update the relevant manual topic alongside its implementation
and the existing prompt/state surfaces. Keep usage steps, UI labels, required roles, examples and
limitations accurate; verify API examples against route schemas. The external-tasks topic is the
agent-facing companion of `docs/avatar-task-api.md`; update both when the API contract changes.
Do not add account-specific values or runtime availability assertions to the static manual.
`system-manual.test.ts` covers topic lookup and public access without store reads; agent core/run
tests cover prompt/registration gating, and `avatar-tasks.test.ts` exercises the manual's curl
examples against the actual API with a mocked agent.

### The one thing that flows backwards across that seam
`buildRunCapabilities` takes a `currentTextAnchor: () => number` **accessor**, not a value. File-output
(`show_file`/`share_file`) and browser-screenshot attachments are stamped with the length of the answer text
accumulated when the tool ran, and that accumulator lives in the runner (`runPiAgent`'s `anchorText`), which
RESETS it on a text fold and at a steer boundary. The accessor is read at call time, so a stamp always sees the
current segment; passing a snapshot would stamp against a stale value. (An MCP call reaches Noah over a separate
HTTP connection from the SSE stream, so an anchor can trail the streamed text slightly — design §9.7.)

### The answer is the LAST text block; earlier ones fold into the reasoning view
During an agentic turn the model narrates between tool calls; only the LAST text block is the answer.
`pi/eventAdapter.ts` fires `onTextFold` with each earlier block at the first delta of a NEW block (before that
delta reaches `onDelta`) and once more at the end; pi keeps one `message` item open across tool calls, so a block
boundary is "a text delta after any tool/reasoning/item event since the last text delta". A discarded model
attempt (an `incomplete` item not followed by the terminal event) leaves the answer the same way. With **no**
`onTextFold` sink the fold is a no-op and the final text is every block joined (the `AgentEvents` no-sink
contract). Semantics, the SSE frame, and the client mirror → [`chat-sse-media.md`](chat-sse-media.md).

### The redaction set follows the run's EXPOSURE paths, not the vault
The `/mcp` endpoint's `transformResult` runs `redactSecretValues` (`secretRedaction.ts`, `[REDACTED:<NAME>]`,
values under `MIN_REDACT_VALUE_LENGTH` skipped) over EVERY Noah MCP result of the run with
`capabilities.piRedactions`, and that set holds only values the run could actually leak. The BROAD exposures are
the relays (`pi/mcpProxies.ts`): once any of the vault reached a relayed child the whole `injectableSecretEnv` is
in the set, plus credential-looking bridge headers (`mcpBridgeRedactions`) and the SSH key material of a hex-ssh
run. **Browser input is the narrow path**: `browserSecretPolicies` (owner state, empty unless
`browserActive && !consultationRun`) names the individually opted-in secrets, and only those values join — a page
echoing a typed password into its DOM would otherwise print it in the next snapshot — while a vault secret the
owner never opted in stays out (redacting it would shred unrelated output for nothing). The browser tools
additionally redact their OWN reply before `report()`, and the chat route redacts the extension's reply before
anything reads it. **Shell exposure is the third path**: an owner run's `piSandboxEnv` (the 셸 노출 values pi gets
as `sandbox_env`) joins the set, because bash can copy a value into a file a Noah tool later reads; pi redacts the
same values from its OWN built-in results before they leave the gateway (its shared `Redactor`). A non-owner run
sends none, so nothing joins. Policy/columns → [`secrets-ssh.md`](secrets-ssh.md); wire + guards →
[`browser-bridge/contract.md`](browser-bridge/contract.md) and
[`browser-bridge/actions.md`](browser-bridge/actions.md).

## Cross-cutting rules for agent-facing work

- **Metacognition has TWO surfaces that must agree.** The prompt append (`buildSystemPromptAppend`, frozen once
  per conversation) and the live `describe_system` / system manual. A new capability reports its current state on
  BOTH; a self-state fact goes into `OwnerState` (`summarizeOwnerState`, `agent/ownerState.ts`) so both consumers
  get the same unformatted fact (detail in [`avatar-collab.md`](avatar-collab.md)). Never offer a route the run
  does not actually have.
- **Language split: agent-facing English, user-facing Korean.** Classify a new string by *"does the model read it
  as INPUT?"*. English: prompts, tool descriptions, tool-call refusals and errors, server slash-command expansions,
  bundled `SKILL.md` body + frontmatter. Korean: UI, `apiError`, status/activity labels, conversation titles. A
  string used on BOTH channels is split into two. The avatar always REPLIES in the user's language (default
  Korean), anchored in `buildSystemPromptAppend`.
- **The prompt append is FROZEN per conversation, so nothing volatile goes in it.** One conversation mixes chat,
  routine and task-API turns on ONE pi session, so a count, a date or a run-kind fact in
  `buildSystemPromptAppend` would be frozen wrong for the rest of the thread. Per-turn facts ride
  `buildPiTurnPreamble` in the turn input; live numbers (the pending knowledge-request count, the 할 일 counts,
  the KST date) belong in `describe_system` or tool results (`/todo` carries its date in the input).
- **Interactive-only capabilities gate on BOTH `headless` and `externalTaskApi`** (and never consultations), the way
  `shareLinkToolActive` does in `runCapabilities.ts` — an API-submitted turn has no human at the keyboard. See
  [`avatar-task-api.md`](avatar-task-api.md) "Provenance".
- **A server-held third-party credential stays READ-ONLY, STRUCTURALLY.** The Confluence client's `requestJson`
  (and `requestBinary`) has no `method`/`body` option, so a future tool cannot quietly reach a mutating endpoint
  with the owner's PAT. **And it goes to the configured Confluence only:** `requestBinary` refuses a download
  link whose origin is not `CONFLUENCE_URL`'s (`offConfluenceOrigin`, 2026-11-10) — the link is server-returned
  text and `resolveConfluenceLink` keeps an absolute one as it is; a cross-origin REDIRECT stays allowed because
  fetch drops `Authorization` there (the PAT is never in a custom header). Page creation/editing is routed to the browser tools (the user's own session —
  attributable, visible, undoable). Both metacognition surfaces branch on `browserEnabled` when they describe
  that write route.

## Admin skill on-off policy (`toolSkillPolicy.ts` + `agent/skillCatalog.ts`)
- **What it is:** the admin panel (system tab → "스킬 정책") stores deployment-wide off-switches for individual
  SKILLS (bare name or `<plugin>:<name>`). Storage mirrors the hex-ssh policy: one JSON blob in `app_config`
  (`getToolSkillPolicy`/`setToolSkillPolicy` in `store/secrets.ts`, lenient `normalize*` on read / strict
  `parse*` at `PUT /api/admin/tool-skill-policy`), read FRESH per agent run. Empty policy == pre-feature
  behavior (safe under `SESSION_SECRET` rotation). The config key `builtin_tool_skill_policy` keeps its name.
- **Built-in tool toggles are RETIRED (issue #78, 2026-11-06).** WebFetch/WebSearch/NotebookEdit were Claude
  Agent SDK tools pi does not have, and the Task/Agent toggle was only advisory. pi's own `Agent`/`SendMessage`
  exist only when an installed pi plugin ships agents, and pi's admin tool page (`/admin`, Noah admin = pi admin)
  switches them off FOR REAL (dropped from every session and subagent) — the Noah panel points there. A stored
  `disabledTools` is dropped on read and ignored on write (an admin tab from before the upgrade still saves), so
  neither surface carries a built-in tool policy any more. Never re-add an advisory tool switch: gate the tool
  where it is built, or don't offer the switch.
- **Skill toggles are ENFORCED by omission.** `materializePiSkills` (`pi/piSkills.ts`) never copies a disabled
  skill into the sandbox, never lists it in the frozen skill index, and `mcp__skills__read` refuses it.
- **Skill listing for the admin panel** comes from the bundled default-skills plugin root
  (`listPluginRootSkills` in `skillCatalog.ts`, which reads each `skills/<dir>/SKILL.md` through `skillMdMeta`):
  `GET /api/admin/system`'s `skillDiscovery` is always `{ fetchedAt, skills: {name, description}[] }`. There is no
  CLI preflight and no cache (the old discovery cache key is retired through `retirementGate()`).
- **Meta-cognition:** `buildSystemPromptAppend` standing note (`adminDisabledSkills` on
  `AgentRequest`) + `describe_system` "Admin-disabled skills" line (via `SystemToolsContext.toolSkillPolicy`)
  — the frozen prompt states the policy at conversation start, describe_system the live one.
- **Beware `*/` in JSDoc:** a glob like `skills/*/SKILL.md` inside a block comment TERMINATES it and the
  rest of the file parses as code (surfaced as bizarre TS1443/TS1160 errors far below). Write
  `skills/<dir>/SKILL.md` in block comments; `//` line comments are safe.

## Retired: plan mode, Workflow, agent teams, background tasks (2026-10-29)
- pi has none of these tools (design §3 G/F). Gone with them: the plan card + approve/reject (`plan`/`plan_review`
  SSE frames, the `plan_review` pending-request kind of the task API's `/respond`), Workflow container nesting in
  the activity tree, the `@name` teammate identity on new spawns, the `agent_teams`/`workflow` admin toggles, and
  the whole background phase. A stored policy naming `SendMessage`/`Workflow` normalizes them away on read.
- Kept read-only for OLD rows: a stored `response.plan` renders as a plain plan card (no buttons) and a
  stored activity snapshot's agent `name` still renders as `@name`.
- Subagents are pi's own `Agent` tool: an agent card whose tool calls (`parent_tool_use_id` on pi's tool events) nest
  under it in the activity tree; `SendMessage` continuing one is a card of its own.

## Adding / changing an MCP tool server
- **One template per `*Tools.ts`:** `buildXTools` (handler-level owner/elevated guards) + `buildXServer`
  + a `SERVER_NAME`/`TOOL_NAMES` const pair.
- **A new tool means updating BOTH `inProcessMcpServers` AND `mcpAllowedTools` in `runCapabilities.ts`**
  (`buildRunCapabilities`) — two hand-synced lists. `mcpAllowedTools` is the `/mcp` endpoint's per-call gate
  (`allowCall`): miss it and the call is refused; miss the server build and the call has nothing to run.
  (Making this data-driven is deferred, T3.5.) A conditionally built tool on an EXISTING server (`create_repo`,
  `create_share_link`) gets its own `mcpAllowedTools` entry keyed on the SAME boolean as its build.
- **A new SERVER also reaches pi's broker:** its name joins `PI_NOAH_SERVER_NAMES` (`pi/mcpCatalog.ts`; a relay
  id: `PI_PROXY_SERVER_NAMES` in `pi/mcpProxies.ts`) + the static catalog build (`pi/mcpCatalog.ts`) AND `NOAH_MCP_SERVER_NAMES` in
  `scripts/pi-register-mcp.mjs`, which mirrors `PI_MCP_SERVER_NAMES` (= both lists; `tests/pi-runner.test.ts`
  keeps them equal), and
  the bundled `pi-setup` service re-runs the script on the next `docker compose up` (a native setup runs it by
  hand). tools/list is answered from that static catalog (pi lists a session's tools
  once), so a tool's registration never hides it from the model — the per-call gate and the handler do the
  refusing. Details → [pi-runtime.md](pi-runtime.md).
- **`create_share_link` gate (`mcp__file_output__create_share_link`).** It lives on the `file_output` server
  but registers only when `shareLinkToolActive` (`runCapabilities.ts`) holds: `fileOutputActive && events.onShareLink &&
  ownerToolAccess && !consultationRun && !request.headless &&
  !request.externalTaskApi`, computed right after `fileOutputActive`, before `buildSystemServer`. That one
  boolean drives the tool build (`shareLinkEnabled`/`createShareLink` on
  `FileOutputToolsContext`; `signupOpen` was removed with the `open` signup mode), its own `mcpAllowedTools` entry (`FILE_OUTPUT_SHARE_LINK_TOOL_NAME`, deliberately
  NOT in `FILE_OUTPUT_TOOL_NAMES`), `SystemToolsContext.shareLinksEnabled` and `AgentRequest.shareLinksEnabled`
  (stamped by `stampPromptRequest`). The chat route supplies `onShareLink` only on interactive own-avatar owner
  turns and re-checks per call (once the visible turn is finalized it refuses unless the owner steered the
  current segment — a pure wake-up turn still refuses); the handler refuses without the callback. Prompt: one
  short tool line when enabled (the flag-maximal config in `tests/system-manual.test.ts` is budgeted under
  18,000 characters; always-on and data-driven owner sections are not budgeted, so the cap is a tripwire, not a
  bound on real owner prompts), else — on any run with file output — the 공유 링크-button redirect. describe_system
  mirrors it with an owner line (available + facts + live sign-up caveat, or not available + why) and a
  non-owner line. The one-link rule is per delivered CARD on all three agent surfaces (tool description, describe_system, the
  `files-canvas` manual topic) — the store's key: a rebuild re-delivered with share_file is a NEW card, so an
  earlier link keeps serving the earlier file — and the result names the conversation's other active links
  (`ShareLinkResult.otherActiveLinks`: names + KST expiry, never their URLs) so the avatar tells the user.
  Mechanics → [`share-links.md`](share-links.md).
- **Guard convention differs per file BY DESIGN:** system/sshIdentity/knowledge-write gate on
  `ctx.viewerIsOwner` (= `ownerToolAccess` = owner chat OR owner routine); `repoTools` (personal knowledge
  repo) splits READ (`list_files`/`read_file`, gated on `ctx.elevated` = owner OR trusted
  teammate) vs WRITE/commit/create (owner-only); `gitRepoTools` splits owner vs elevated; `confluenceTools`
  gates on `ctx.elevated`; `sshTrustTools` and `search_avatars` are intentionally
  UNGATED (fingerprints aren't secrets; directory search is all-viewer read-only) while its sibling
  `ask_avatar` in the SAME file is owner-driven (see the consultation section below). Don't "normalize"
  these.
- **Second-brain read tools (`brainTools`):** a read-only RECALL server (`search`/`get_note`) over the
  personal knowledge-repo clone, gating reads on `ctx.elevated`. The team brain (`groupBrainTools`) was
  removed 2026-10-30. There is NO brain WRITE tool for the PERSONAL brain — route writes through
  `mcp__repo__write_file` + `commit`. The instance-wide team brain (back 2026-11-06) rides the same `brain`
  server: every teammate's own interactive run gets `prepare_team_changes` + `team_brain_health`, an admin's
  also `prepare_team_policy`; they only DRAFT a card (the user's own press commits), self-gate per call
  (`isActiveUser` / `isActiveAdmin`, live), and a call to one of the five review-queue tools removed
  2026-11-13 is answered at `/mcp` by `RETIRED_TOOL_MESSAGES` → [`team-brain.md`](team-brain.md).
- **Web fetch is REMOVED (user, 2026-11-10).** The `mcp__web__fetch` tool (`webFetchTools.ts`, server `web`,
  tool-group id `web`) fetched URLs from Noah's own process: it was the one tool that let page-derived text
  drive requests from inside Noah's container (loopback guard bypassable through `[::ffff:127.0.0.1]`, no
  DNS-resolved check). Nothing replaces it server-side — a page is read in the user's own browser
  (`mcp__browser__*`) or from the sandbox shell where pi's `SANDBOX_EGRESS_ALLOW` permits, and both
  metacognition surfaces say there is no web-search AND no web-fetch tool. The broker id `web` is in
  `RETIRED_MCP_SERVER_NAMES` (`pi-register-mcp.mjs` deletes it on the next `up`), `/mcp` answers a call from
  an older frozen conversation with a "was removed" redirect (`RETIRED_SERVER_MESSAGES`), the tool-group id
  is dropped from saved selections/policies on read (`normalizeMcpToolGroups`; a policy that allowed only
  `web` stays restrictive), and `web` stays a reserved shared-MCP name. The `mcp__web__fetch` activity label
  stays in `sdkToolPresentation.ts` so older transcripts render. `undici` STAYS a direct dependency: the egress
  bootstrap (`docker/egress/proxy-bootstrap.cjs`) loads the app's pinned copy.
  **Never mint `web` / `mcp__web__*` again.** What survived is the proxy self-state: ONE helper,
  `serverProxyState()` (`agent/serverProxyState.ts`, values redacted to scheme://host:port — proxy creds
  never enter a prompt), read by BOTH `buildSystemPromptAppend` (`AgentRequest.serverProxy`, stamped by
  `stampPromptRequest`; only the `domain-proxy` egress policy is stated) and `describe_system` (the egress
  line + a `Server proxy env` line for the MCP relays).
- **Images for documents and decks: ONE describe_system line plus short standing text, on the same run
  flags (2026-09-30).** Every image the avatar is shown can now be a FILE it places into a deck, document
  or commit, all under the conversation's sandbox folder `/workspace/c/<conv-seg>/` (its host view is the turn's
  workspace, `preparePiRunWorkspace`): user attachments in `attachments/` (staged on every turn, see [`chat-sse-media.md`](chat-sse-media.md)), browser screenshots in `captures/`
  ([`browser-bridge/contract.md`](browser-bridge/contract.md)), and Confluence attachments saved with
  `save_to_workspace` in `confluence/` (next bullet). describe_system prints `- Images for documents and
  decks: …` from ONE helper, `imageSourcesLine`, in the owner and non-owner branches (the
  `deckCapabilityLine` pattern). It names the folder's sandbox path when `SystemToolsContext.scratchWorkspaceDir`
  is set. It lists attachments unless the run is `headless`, captures only when `browserEnabled` and vision
  is on (at most 30 per RUN), and Confluence only when `confluenceSaveToWorkspace` holds. It ends by telling the run to copy the FILE into the deliverable —
  unless the run's pi session is read-only (`PiRuntimeFacts.readOnlyBuiltins`, a colleague chat, see
  [`pi-runtime.md`](pi-runtime.md)), which is told it can read the files but not place them (the owner-side write
  tools refuse a non-owner either way). The deck line's `read-only` tail (`DeckAuthoringStatus`) and the vision
  user-prompt tail in `buildUserPrompt` key on the same fact. The prompt
  mirrors the same flags in three short places: `imageFilesSection` (vision on AND a deck flag — a
  text-only run is shown no images, and `noVisionSection` already covers its files; the deck flags already
  imply an author, so no read-only branch is needed there), the browser paragraph's screenshot sentence
  (vision branch, "the scratch workspace's `captures/`", since an open working repo makes the clone the
  cwd), and the Confluence paragraph, keyed on `AgentRequest.confluenceSaveToWorkspace`. `stampPromptRequest`
  stamps both booleans from the same capability values describe_system's ctx got (the Confluence stamp is
  pinned end to end in `tests/agent-share-link.test.ts`). `tests/system-manual.test.ts` budgets the
  flag-maximal config in BOTH vision states under its 18,000 tripwire: vision OFF sits 4 characters under
  it, vision ON (which carries `imageFilesSection` and the captures sentence) about 80 under. Confluence
  (data-driven) is unmeasured. Keep them short.
- **Confluence `get_attachment` `save_to_workspace` — a LOCAL write, never a Confluence mutation.** With
  `save_to_workspace: true` the handler (after its unchanged `elevated` gate) writes the downloaded bytes
  (any media type, under the existing `max_bytes` cap) to `<scratch>/confluence/<attachmentId>-<safeName>`
  and adds `savedPath` (mapped to the sandbox view, `toSandboxPath`) to the JSON payload. The inline result is unchanged: an image block on
  vision runs, and the text-only/non-inline notes gain one sentence pointing at `savedPath`.
  `requestJson`/`requestBinary` are untouched, so the tools stay GET-only by construction. safeName = the
  title's stem mapped to `[A-Za-z0-9._-]` (else `-`), `-` runs collapsed, `-`/`.` trimmed, ≤ 80 chars
  including the lowercased original extension; an empty stem becomes `attachment` + (title extension |
  media-type extension | `.bin`); the metadata id is sanitized the same way (≤ 64). Containment: the
  workspace's realpath is the anchor; `confluence/` must be a plain folder (lstat, so a symlink or file
  there is refused, never followed); files are created O_EXCL (`wx`, which never overwrites and never
  writes through a planted symlink); an existing file with identical bytes (size first, then read
  O_NOFOLLOW via `readRegularFileAsync`) is reused, else `-2` … `-100`, then
  `-<KST YYYYMMDD-HHMMSS>-<6 hex>` names (the capture stamp), so a routine re-saving a changing attachment
  into one workspace never runs out of names; a saved path must realpath to itself, or the file is
  removed. Cheap checks run BEFORE the download (`checkSaveFolder`: the workspace exists, `confluence/` is
  absent or a plain folder, and that folder, or before it exists the workspace, is writable) and refuse
  with a hint to call again without `save_to_workspace`. They run again after the download for the race,
  and a save that fails THERE costs only the copy: the normal inline result comes back plus a `saveError`
  field, and the note never claims a save. A save that lands AFTER its conversation was deleted (a delete cannot stop
  a download in flight, and its copy sweep already ran) is unlinked again and reported as `saveError`:
  `ConfluenceToolsContext.isConversationLive` (the conversation row still exists — ids are never reused) is
  checked after the write. Target = `ConfluenceToolsContext.workspaceDir` = the host view of the run's sandbox
  conversation folder (`piWorkspace.hostConversationDir`, falling back to the pure `conversationScratchDir(request)`).
  No `conversationId` (profile generators, consultations — their run folder is not a conversation
  workspace) → undefined → the option refuses before any request ("Saving attachments to the workspace is not
  available in this run."). `buildRunCapabilities` derives ONE boolean, `confluenceSaveToWorkspace` = Confluence group
  registered && `elevatedToolAccess` && scratch dir && `confluenceCredentialsConfigured` (the tools' own
  `credentials()` check over the decrypted vault, which is why `ownerSecrets` is now read before
  `buildSystemServer`). It hands that boolean, with `scratchWorkspaceDir`, to `SystemToolsContext`, and returns
  the boolean (not the path, which only describe_system names) on the capabilities for the prompt stamp
  (`AgentRequest.confluenceSaveToWorkspace`).
- **Confluence `get_page` returns the body as TEXT by default (2026-11-11).** The raw `body.storage` XML spent
  the 20,000-character cap on markup and lost the tail of long pages, so `get_page` now takes
  `format: "text" | "storage"` (default `"text"`) and `offset` (0 … 10,000,000, a character offset in the
  chosen format). `confluenceStorageText.ts` (`confluenceStorageToText`) converts storage format to compact
  Markdown-like text: ONE tolerant tokenizer builds a small tree, one walker renders it (mixed content →
  blocks, so "a list in a table cell in a panel" needs no special case) — no parser dependency (`jsdom` is
  test-only; `parse5`/`saxes` are only transitive). Conventions the tool description names: `[image: file.png]`
  / `[attachment: file.pdf]` (the filename `get_attachment` takes with `page_id`), `[page: Title (space KEY)]`,
  `[user mention]` (a `ri:userkey`/`ri:account-id` is NEVER printed; only an explicit `ri:username` becomes
  `@name`), `[status: …]`, `[jira: KEY]`, `[drawio diagram: name]`, `[macro name: k=v, …]` for a body-less
  macro (≤ 8 parameters × 120 chars), `> **Info: title**` quote blocks for body macros (info/note/warning/tip/
  panel/expand/details; an unknown one is `> **Macro name** (params)` with its plain-text body fenced), fenced
  blocks for `code`/`noformat`/`<pre>` (fence longer than any backtick run), Markdown tables (cell content on
  one line with ` ⏎ ` for breaks and `\|` for pipes; merged cells become `(←)`/`(↑)` markers plus a one-line
  legend; a header-less table gets an empty header; ≤ 60 columns). `section`/`column`/`excerpt` are
  transparent; `<script>`/`<style>`/comments are dropped; an unknown element keeps its children. Contract:
  NEVER throws (a failed walk falls back to a tag strip), linear in the input (a tag scan stops at the next
  `<`; nesting deeper than 64 is flattened into its ancestor), entities and CDATA decoded exactly once
  (`decodeXmlEntities`, the full XHTML set; `&#x110000;` → U+FFFD — `extractAssetReferences` now uses it too,
  the old decoder threw there), no markup passes through. The cap (`max_body_chars`, default 20,000, `0` =
  metadata only) is applied AFTER the conversion; the payload carries `body_format`, `body_chars` (the whole
  body's length in that format), `body_text` | `body_storage` (never both) and, when not everything is shown,
  `body_note` ("Showing N of M characters … Call get_page again with offset: X …"). A text cut snaps back to
  the last line break in the second half of the window and never splits a surrogate pair; the offset is into
  the CONVERTED text, stable for one page version. `extract_page_assets` still reads the storage form
  (`pageBody`) untouched. Not converted, by choice: user keys are not resolved to names (one more GET per
  mention), a draw.io macro is only named (`extract_page_assets` matches it to attachments), cell colours /
  alignment / indentation / `ac:layout` columns are dropped, and Cloud's `ac:adf-extension` is rendered from
  its node content (unverified against a live Cloud page).
- **Confluence request failures say what to do (`confluenceErrors.ts`, 2026-11-11).** `requestJson` /
  `requestBinary` no longer return `Confluence HTTP <status>: <raw 500 chars>` / `Confluence request failed:
  fetch failed`. A rejected `fetch` is classified from the codes down its `cause`/`errors` chain (or named in
  a message): certificate not trusted → an operator adds the corporate CA (`NODE_EXTRA_CA_CERTS`) and
  restarts; expired / host-name mismatch / other TLS; undici's `Proxy response (403) !== 200 when HTTP
  Tunneling` → the egress policy (관리자 → 가입·접근 → 외부 통신 차단); DNS, refused/reset, timeout (our own
  30 s abort included) → the Noah server's network, not the chat. A non-2xx keeps the `Confluence HTTP
  <status>:` prefix and is read by status: 401 token (owner replaces `CONFLUENCE_PAT`), 403 account
  permission, 404 wrong id OR no permission, 429 with `Retry-After`, 400 with the parser's message, 5xx. The
  body only adds a short quote: the message fields of a JSON error (`message`, `errorMessages`,
  `error_description`, `data.errors[].message`, else `reason`; ≤ 300 chars), the `<title>` of an HTML page, or
  the first 200 chars of plain text. **A 2xx that is not JSON is now a FAILURE** (it used to become an empty
  result — "No Confluence spaces found" on an SSO login page): HTML → "almost certainly an SSO/login page".
  Every network-sourced string passes `safeDetail` (the PAT itself, `Authorization`/`Bearer`/`Basic` values
  and URL userinfo removed). Each message ends with the fix and who can apply it; none offers a route (the
  tools cannot know whether the browser relay is on). `requestBinary` cannot tell a login page from a real
  `.html` attachment on a 2xx, so a download is classified only when it is non-2xx.
- **Confluence `search`: `since_days`, literal escaping, trimming (2026-11-11).** `since_days` (1 … 3650) adds
  `lastmodified >= now("-Nd")`: alone, with the field conditions, or on top of raw `cql` as
  `(<cql>) AND lastmodified >= … [ORDER BY …]` (`orderByIndex` finds the clause quote-aware). `cqlQuote`
  escapes `\` and `"` — the only characters that can end a CQL string literal — and turns control characters
  into a space; `tests/agent-confluence-read.test.ts` strips the literals back out and asserts the query
  STRUCTURE is unchanged for a list of break-out attempts. Lucene operators inside a `~` value (`*`, `?`, `~`)
  are deliberately NOT escaped: `text`/`title` are documented as fuzzy search and escaping would change what
  they mean. Results carry `lastModified` (`version.when`), `totalSize` when the server reports it, and a
  `note` naming the next `start`; a list over 20,000 characters loses whole results from the END (the note
  says "Showing N of M results fetched by this call").
- **The `/mcp` gate is per CALL, not per viewer**, so every tool MUST self-gate in its handler. The endpoint's
  `allowCall` admits only this run's `mcpAllowedTools`, but pi lists a session's tools once from the static
  catalog and one conversation can carry runs of different classes (and live state changes mid-session); the
  handler's own owner/elevated/member check is the guard that always runs against the CURRENT run.
- **A third-party or process server is never its own broker id.** It rides one of Noah's relays
  (`pi/mcpProxies.ts`: `hex-ssh`, `plugins`, `shared`), so pi's broker only ever sees Noah's fixed id list.
