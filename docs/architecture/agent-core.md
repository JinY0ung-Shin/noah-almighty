# Agent core — orchestration, tool policy, MCP servers

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> How a run is assembled (the one capability plan, the pi runner), the admin tool/skill on-off policy, the retired plan mode/Workflow/agent teams, and the checklist for adding an MCP tool server.

Agent orchestration + in-process MCP tool servers. Companion to the agent-area philosophy in
[`../../src/server/agent/CLAUDE.md`](../../src/server/agent/CLAUDE.md).

## How a run is assembled
pi-gateway is the only agent runtime (`AGENT_RUNTIME=pi`, the default; `local` is the deterministic stub for tests
and the e2e harness; any other value, `claude` included, stops the boot). `runAgentStream` (`agent/index.ts`) sends
every non-local run to `runPiAgent` (`agent/pi/runPiAgent.ts`); the sandbox principal is `piRunPrincipal(request)`
(`viewerUserId ?? avatar.id`). Runner, session, sandbox and endpoint mechanics → [pi-runtime.md](pi-runtime.md).
- `runCapabilities.ts` — **the ONE capability plan** (design N1): `buildRunCapabilities` (tool access
  `deriveAgentToolAccess`, MCP families `planMcpToolFamilies`, the in-process MCP servers, model chain
  `buildModelFallbackChain`, describe_system's ctx, `mcpAllowedTools`) and `stampPromptRequest` (the request as the
  prompt builder sees it). The setup half declares **no `let`** — it is pure derivation over
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

### Official product manual

`agent/systemManual.ts` is the canonical English, agent-facing product manual, compiled into the
server output (no runtime docs-directory/cwd/network dependency). Its short topic index appears in
every local avatar system prompt; full pages are returned only by `mcp__system__read_manual`.
The `system` MCP group is always registered for local avatars, including old conversations/defaults
or admin policies that omit it. `effectiveMcpToolGroups(selection, policy)` applies this invariant
at both the chat preflight and run-plan boundary; the effective store policy and UI reflect it too.
The composer and admin policy editor display system as checked and non-toggleable. Management
handlers still enforce owner/group scope, so tool registration does not grant new privileges.
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
anything reads it. pi's built-ins need no redaction: the sandbox holds no secrets (shell-exposed secrets are not
exported there, P4). Policy/columns → [`secrets-ssh.md`](secrets-ssh.md); wire + guards →
[`browser-bridge/contract.md`](browser-bridge/contract.md) and
[`browser-bridge/actions.md`](browser-bridge/actions.md).

## Admin builtin tool/skill on-off policy (`toolSkillPolicy.ts` + `agent/skillCatalog.ts`)
- **What it is:** the admin panel (system tab → "내장 도구·스킬 정책") stores deployment-wide off-switches for
  BUILT-IN tools (the `TOGGLABLE_BUILTIN_TOOLS` catalog; core tools are deliberately NOT togglable and the strict
  parser rejects them) and individual SKILLS (bare name or `<plugin>:<name>`). Storage mirrors the hex-ssh
  policy: one JSON blob in `app_config` (`getToolSkillPolicy`/`setToolSkillPolicy` in `store/secrets.ts`,
  lenient `normalize*` on read / strict `parse*` at `PUT /api/admin/tool-skill-policy`), read FRESH per
  agent run. Empty policy == pre-feature behavior (safe under `SESSION_SECRET` rotation).
- **Built-in toggles are ADVISORY on pi.** pi's built-ins (read/write/edit/bash/ls/find/grep, plus its own
  `Agent`) are always on — pi has no per-request tool allowlist — and the catalog names tools pi does not have
  (WebFetch/WebSearch/NotebookEdit). describe_system's "Admin-disabled built-in tools" line says so, and when the
  subagent switch is off (`piAdminDisabledToolsNote`) tells the avatar to honor it itself and never spawn one.
- **Skill toggles are ENFORCED by omission.** `materializePiSkills` (`pi/piSkills.ts`) never copies a disabled
  skill into the sandbox, never lists it in the frozen skill index, and `mcp__skills__read` refuses it.
- **Skill listing for the admin panel** comes from the bundled default-skills plugin root
  (`listPluginRootSkills` in `skillCatalog.ts`, which reads each `skills/<dir>/SKILL.md` through `skillMdMeta`):
  `GET /api/admin/system`'s `skillDiscovery` is always `{ fetchedAt, skills: {name, description}[] }`. There is no
  CLI preflight and no cache (the old discovery cache key is retired through `retirementGate()`).
- **Meta-cognition:** `buildSystemPromptAppend` standing note (`adminDisabledTools/-Skills` on
  `AgentRequest`) + `describe_system` "Admin-disabled …" lines (via `SystemToolsContext.toolSkillPolicy`)
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
- Subagents are pi's own `Agent` tool (one flat card; nested events are not relayed, design P6).

## Adding / changing an MCP tool server
- **One template per `*Tools.ts`:** `buildXTools` (handler-level owner/elevated guards) + `buildXServer`
  + a `SERVER_NAME`/`TOOL_NAMES` const pair.
- **A new tool means updating BOTH `inProcessMcpServers` AND `mcpAllowedTools` in `runCapabilities.ts`**
  (`buildRunCapabilities`) — two hand-synced lists. `mcpAllowedTools` is the `/mcp` endpoint's per-call gate
  (`allowCall`): miss it and the call is refused; miss the server build and the call has nothing to run.
  (Making this data-driven is deferred, T3.5.) A conditionally built tool on an EXISTING server (`create_repo`,
  `create_share_link`) gets its own `mcpAllowedTools` entry keyed on the SAME boolean as its build.
- **A new SERVER also reaches pi's broker:** its name joins `PI_NOAH_SERVER_NAMES` + the static catalog build
  (`pi/mcpCatalog.ts`) AND `NOAH_MCP_SERVER_NAMES` in `scripts/pi-register-mcp.mjs` (a test keeps them equal), and
  the bundled `pi-setup` service re-runs the script on the next `docker compose up` (a native setup runs it by
  hand). tools/list is answered from that static catalog (pi lists a session's tools
  once), so a tool's registration never hides it from the model — the per-call gate and the handler do the
  refusing. Details → [pi-runtime.md](pi-runtime.md).
- **`create_share_link` gate (`mcp__file_output__create_share_link`).** It lives on the `file_output` server
  but registers only when `shareLinkToolActive` (`runCapabilities.ts`) holds: `fileOutputActive && events.onShareLink &&
  ownerToolAccess && !consultationRun && !request.headless &&
  !request.externalTaskApi`, computed right after `fileOutputActive`, before `buildSystemServer`. That one
  boolean drives the tool build (`shareLinkEnabled`/`createShareLink`/`signupOpen` on
  `FileOutputToolsContext`), its own `mcpAllowedTools` entry (`FILE_OUTPUT_SHARE_LINK_TOOL_NAME`, deliberately
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
- **Guard convention differs per file BY DESIGN:** groupRepo/system/sshIdentity/knowledge-write gate on
  `ctx.viewerIsOwner` (= `ownerToolAccess` = owner chat OR owner routine); `repoTools` (personal knowledge
  repo) splits READ (`list_files`/`read_file`, gated on `ctx.elevated` = owner OR trusted same-group
  teammate) vs WRITE/commit/create (owner-only); `gitRepoTools` splits owner vs elevated; `confluenceTools`
  and `webFetchTools` gate on `ctx.elevated`; `sshTrustTools` and `search_avatars` are intentionally
  UNGATED (fingerprints aren't secrets; directory search is all-viewer read-only) while its sibling
  `ask_avatar` in the SAME file is owner-driven (see the consultation section below). Don't "normalize"
  these.
- **Second-brain read tools (`brainTools`/`groupBrainTools`):** read-only RECALL servers
  (`search`/`get_note`) over the same knowledge-repo clones. `brainTools` (personal) gates reads on
  `ctx.elevated`; `groupBrainTools` gates reads on group-MEMBERship. There is NO brain WRITE tool — route
  writes through `mcp__repo__write_file`/`mcp__group_repo__write_file` + `commit`.
- **Web fetch (`webFetchTools.ts`, server `web`, tool-group id `web`):** one `mcp__web__fetch` tool that
  fetches from Noah's process, NOT the sandbox — pi has no WebFetch/WebSearch built-in, and the sandbox's only
  way out is pi's egress allowlist, so this is the avatar's one web reader (plain-HTTP intranet pages included).
  Proxy: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` via undici's `EnvHttpProxyAgent` — must use
  undici's OWN `fetch` (node's global fetch is a different bundled undici and rejects the dispatcher).
  Live-verified: undici tunnels EVERY proxied request via `CONNECT` (even `http://` targets; curl uses
  absolute-form GET instead), so a corporate proxy that only allows `CONNECT :443` refuses proxied
  plain-HTTP to EXTERNAL port-80 sites. Intranet http bypasses the proxy via `NO_PROXY`/direct, so this
  bites rarely — check the proxy's CONNECT port policy before blaming the tool.
  Private CAs: `NODE_EXTRA_CA_CERTS` (node-native) and `GITHUB_CA_CERT` (process-wide
  `tls.setDefaultCACertificates`, tlsCa.ts) both cover it. Guards: handler gates on `ctx.elevated`;
  loopback + link-local/metadata (169.254.x, `::1`, `localhost`, v4-mapped) refused while PRIVATE ranges
  (10.x/172.16-31/192.168) are deliberately allowed; same-host redirects followed (≤5) but cross-host
  redirects REPORTED for an explicit re-fetch (it re-runs the guard);
  2MB streamed body cap; 20k-char result window with `offset` continuation; charset from the header or a
  `<meta charset>` sniff (KR intranets still serve euc-kr). HTML→text is deliberately dependency-free
  (entities decoded AFTER tag-strip; links kept as `label (abs-url)`). Proxy self-state comes from ONE
  helper, `webFetchProxyState()` (values redacted to scheme://host:port — proxy creds never enter a
  prompt), read by BOTH `buildSystemPromptAppend` (`AgentRequest.webFetchProxy`, stamped by `stampPromptRequest`)
  and `describe_system` — the Confluence-style deployment-fact sync.
- **Images for documents and decks: ONE describe_system line plus short standing text, on the same run
  flags (2026-09-30).** Every image the avatar is shown can now be a FILE it places into a deck, document
  or commit, all under the conversation's sandbox folder `/workspace/c/<conv-seg>/` (its host view is the turn's
  workspace, `preparePiRunWorkspace`): user attachments in `attachments/` (staged on every turn, see [`chat-sse-media.md`](chat-sse-media.md)), browser screenshots in `captures/`
  ([`browser-bridge/contract.md`](browser-bridge/contract.md)), and Confluence attachments saved with
  `save_to_workspace` in `confluence/` (next bullet). describe_system prints `- Images for documents and
  decks: …` from ONE helper, `imageSourcesLine`, in the owner and non-owner branches (the
  `deckCapabilityLine` pattern). It names the folder's sandbox path when `SystemToolsContext.scratchWorkspaceDir`
  is set. It lists attachments unless the run is `headless`, captures only when `browserEnabled` and vision
  is on (at most 30 per RUN), and Confluence only when `confluenceSaveToWorkspace` holds, and it always
  says `mcp__web__fetch` returns text only. It ends with what the run may DO with those files, from ONE
  flag both surfaces read: `canWriteFiles` (`SystemToolsContext` and `AgentRequest`) = `elevatedToolAccess`
  (owner or trusted teammate). A run in that class is told to copy the FILE into the deliverable. Any other run
  (a plain colleague, a restricted headless run) is told it can read the files but not place them for the owner
  (the deck line's wording): its pi built-ins write only into its OWN principal's sandbox, and the owner-side
  write tools refuse it. The vision user-prompt tail
  in `buildUserPrompt` branches on the same flag. Undefined (an unwired caller) resolves conservatively,
  on both surfaces alike: only the owner's own run counts as writable. The prompt
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
  No `conversationId` (profile generators, consultations — their ephemeral work folder is not a conversation
  workspace) → undefined → the option refuses before any request ("Saving attachments to the workspace is not
  available in this run."). `buildRunCapabilities` derives ONE boolean, `confluenceSaveToWorkspace` = Confluence group
  registered && `elevatedToolAccess` && scratch dir && `confluenceCredentialsConfigured` (the tools' own
  `credentials()` check over the decrypted vault, which is why `ownerSecrets` is now read before
  `buildSystemServer`). It hands that boolean, with `scratchWorkspaceDir` and `canWriteFiles`, to
  `SystemToolsContext`, and returns the two booleans (not the path, which only describe_system names) on
  the capabilities for the prompt stamps (`AgentRequest.confluenceSaveToWorkspace`, `AgentRequest.canWriteFiles`).
- **The `/mcp` gate is per CALL, not per viewer**, so every tool MUST self-gate in its handler. The endpoint's
  `allowCall` admits only this run's `mcpAllowedTools`, but pi lists a session's tools once from the static
  catalog and one conversation can carry runs of different classes (and live state changes mid-session); the
  handler's own owner/elevated/member check is the guard that always runs against the CURRENT run.
