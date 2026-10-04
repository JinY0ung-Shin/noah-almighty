# Agent core — orchestration, tool policy, MCP servers

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> How `claudeAgent.ts` is split, the admin tool/skill on-off policy, agent teams, and the checklist for adding an MCP tool server.

Agent orchestration + in-process MCP tool servers. Companion to the agent-area philosophy in
[`../../src/server/agent/CLAUDE.md`](../../src/server/agent/CLAUDE.md).

## claudeAgent.ts is split (behind unchanged exports)
`claudeAgent.ts` is the orchestrator (`runClaudeAgent` + subprocess-env helpers) and **re-exports** the
moved symbols so importers keep their paths:
- `promptBuilder.ts` — `buildSystemPromptAppend` + `buildUserPrompt` + compatibility `buildPrompt` +
  `compactConversationHistory`/`conversationHistoryBlock` + `GIT_MCP_ONLY_GUIDANCE`.
  `claudeAgent.ts` uses the SDK's default Claude Code system prompt via `systemPrompt: { type: "preset",
  preset: "claude_code", append, excludeDynamicSections: true, snapshot: false }`. **`snapshot: false` is
  load-bearing:** since CLI 2.1.267 the default RECORDS a session's first system prompt (tool descriptions
  included) and replays it on every resume, ignoring a later `append` until compaction. Every turn resumes
  with a freshly built append, so a recorded prompt would freeze the avatar's self-state at turn one
  (live-verified on CLI 2.1.283: a resumed turn answered from the FIRST turn's append without it). App/permission/self-state guidance goes
  in the append, while stored history + the current user/task instruction stay in the user prompt. **`agent-core.test.ts`
  checks the prompt with `toContain`/`not.toContain` substrings, NOT byte-for-byte** — ADDING a section is
  safe; only changing an EXISTING string (or its presence per viewer class) breaks a test.
  The append's one PROACTIVE section is `gettingStartedSection` (setup gaps from `ownerState.ts`'s
  `gettingStartedGaps`, mirrored by `describe_system`): interactive-owner branch only — so routines,
  colleagues, and group agents are excluded structurally — and it drops out past ~6 stored messages
  (`conversationHistory.length`, the free conversation-youth signal) so the offer can only be an early one.
- `sdkMessageHandlers.ts` — SDK-message→`AgentEvents` translation (`handle*` + Task helpers + `LoopState`
  + `interpretResult`/`resultErrorMessage`).
- `preToolUseHook.ts` — `buildPreToolUseHook` + `hookAllow`/`hookDeny`/`isAutoAllowed`/`safeToolInput`.
- `agentUtils.ts` — small shared helpers.
- `runPlan.ts` — **everything a run derives BEFORE the SDK stream opens** (2026-08): `buildAgentRunPlan`
  plus the subprocess-env / tool-access helpers it needs (`withoutGitCredentialEnv`, `agentSubprocessEnv`,
  `sshMcpSecretEnv`, `mcpInjectableSecretEnv`, `deriveAgentToolAccess`, `planMcpToolFamilies`,
  `buildModelFallbackChain`, `AgentToolAccess`, `McpToolFamilyPlan` — all re-exported from
  `claudeAgent.ts`, which is where the test suites import them from). `runClaudeAgent` went 1400 → ~450
  lines; the split point is exact because the setup half declares **no `let` at all** — it is pure
  derivation over store/config/plugins, and the loop half owns every accumulator.
Keep the re-export set in `claudeAgent.ts` minimal to the original public surface.

### Official product manual

`agent/systemManual.ts` is the canonical English, agent-facing product manual, compiled into the
server output (no runtime docs-directory/cwd/network dependency). Its short topic index appears in
every local avatar system prompt; full pages are returned only by `mcp__system__read_manual`.
The `system` MCP group is always registered for local avatars, including old conversations/defaults
or admin policies that omit it. `effectiveMcpToolGroups(selection, policy)` applies this invariant
at both the chat preflight and run-plan boundary; the effective store policy and UI reflect it too.
The composer and admin policy editor display system as checked and non-toggleable. Management
handlers still enforce owner/group/bot scope, so tool registration does not grant new privileges.
The manual tool is intentionally public: it reads only static allowlisted topics, never user state
or files. An unknown topic returns the valid index with an error instead of resolving a path.
`describe_system` points to the same manual; live state and permissions still come from its existing
scoped readers. External gateway avatars do not receive this local prompt/tool set.

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
`buildAgentRunPlan` takes a `currentTextAnchor: () => number` **accessor**, not a value or an array.
File-output (`show_file`/`share_file`) and browser-screenshot attachments are stamped with the length of
the assistant text accumulated when the tool ran — and that accumulator (`assistantChunks`) lives in the
run loop AND is **REASSIGNED there on the empty-turn retry**. Passing the array would stamp against a
stale binding after a retry; the accessor is read at call time, so it always sees the current one.
`assistantChunks` is therefore declared ABOVE the plan call in `runClaudeAgent`, not with the other
loop-state `let`s — and so is `textFold`, for the same reason. The returned `options` is likewise a LIVE
object the loop still mutates (`systemPrompt`, `model`, `resume`) — same object identity as before the
split, deliberately.

### The answer is the LAST text block; earlier ones fold into the reasoning view
The accumulators are never rewritten — `TextFoldState`'s two indexes (`foldPendingText` in
`sdkMessageHandlers.ts`) mark where the KEPT tail starts in `assistantChunks`/`deltaChunks`, and every
consumer slices from there: `currentTextAnchor` (so an attachment stamps an offset into the answer that
will actually persist), the result-boundary `segmentText`, and the final `partialText`. The one deliberate
exception is the empty-turn `producedText` check, which reads the WHOLE arrays: emptiness is a fact about
the ATTEMPT, not about what survived the fold. A fold fires `onTextFold` with the demoted text so the host
can file it under the turn's reasoning; with **no** `onTextFold` sink the fold is a no-op and the run keeps
the legacy full join (the `AgentEvents` no-sink contract). Reset per attempt alongside `assistantChunks`.
Semantics, the SSE frame, and the client mirror → [`chat-sse-media.md`](chat-sse-media.md).

### The PostToolUse redaction set follows the run's EXPOSURE paths, not the vault
`buildAgentRunPlan` registers `buildPostToolUseHook` (`postToolUseHook.ts`) only when the run can
actually leak a secret VALUE into tool output, and the set it registers differs by path. The two BROAD
exposures — per-key shell env (`shellSecretEnv`) and the plugin-MCP wrapper files — hand the whole
`injectableSecretEnv` to a process, so the whole set is redactable. **Browser input is the third path and
the narrow one**: `browserSecretPolicies` (owner state, empty unless `browserActive && !consultationRun`)
names the individually opted-in secrets, and only those values go into the set. So a run whose only
exposure is browser input still registers the hook — without it a page echoing the typed password back
into its DOM would print it in the next snapshot — while a vault secret the owner never opted in stays out
of the redaction set entirely (redacting it would shred unrelated output for nothing). The browser tools
additionally redact their OWN reply before `report()`, and the chat route redacts the extension's reply
before anything reads it; the hook covers every other tool for the rest of the turn.
Policy/columns → [`secrets-ssh.md`](secrets-ssh.md); wire + guards →
[`browser-bridge/contract.md`](browser-bridge/contract.md) and
[`browser-bridge/actions.md`](browser-bridge/actions.md).

### The SDK `options` bag is untyped
`options` is a `Record<string, unknown>`, so a key the pinned SDK's `Options` does not declare compiles
fine and then silently vanishes — the CLI never sees it. Settings-shaped knobs like `autoCompactWindow`
are NOT top-level options: they ride `options.settings` (the CLI `--settings` JSON), a layer
`settingSources: []` does not suppress. Check `sdk.d.ts` before adding an option.

## Admin builtin tool/skill on-off policy (`toolSkillPolicy.ts` + `agent/skillDiscovery.ts`)
- **What it is:** the admin panel (system tab → "내장 도구·스킬 정책") disables SDK BUILT-IN tools
  (WebFetch/WebSearch/NotebookEdit/Task+Agent/SendMessage — the `TOGGLABLE_BUILTIN_TOOLS` catalog; core
  tools are deliberately NOT togglable and the strict parser rejects them) and individual SKILLS (CLI built-ins
  like code-review/deep-research AND app/plugin skills) deployment-wide. Storage mirrors the hex-ssh
  policy: one JSON blob in `app_config` (`getToolSkillPolicy`/`setToolSkillPolicy` in `store/secrets.ts`,
  lenient `normalize*` on read / strict `parse*` at `PUT /api/admin/tool-skill-policy`), read FRESH per
  agent run. Empty policy == pre-feature behavior (safe under `SESSION_SECRET` rotation).
- **Three-layer enforcement (all from ONE `toolSkillPolicy` read in `runClaudeAgent`):**
  1. `disallowedTools` = `UNUSED_SDK_BUILTIN_TOOLS ∪ disallowedEntriesForPolicy(policy)` — bare names
     remove built-ins from the advertised set; `Skill(<name>)` denies that one skill at the CLI (a
     content-carrying deny never strips the whole Skill tool — verified against the bundled CLI matcher).
  2. `options.skills` — `"all"` normally; when skills are disabled AND the discovery cache matches the
     bundled CLI version, an explicit allowlist (`computeSkillsOption`) HIDES them from the skill
     listing. **Visibility fail-open / execution fail-closed:** missing or stale cache → `"all"` (skills
     must never vanish because a preflight failed); the hook still denies.
  3. PreToolUse hook — denies disabled skills (`Skill` is otherwise an auto-allowed meta tool, so this
     branch runs BEFORE the auto-allow; matches bare AND `plugin:name` forms) and disabled tool names.
     English deny reason, Korean `onBlocked`.
- **Skill discovery** (`agent/skillDiscovery.ts`, gateway-proven pattern): one preflight SDK session in
  streaming-input mode that never sends a turn → `query.supportedCommands()` (~0.3s, no API call/auth) →
  cached in `app_config` keyed by the SDK's `claudeCodeVersion`. Runs lazily from
  `GET /api/admin/system` (claude runtime only — the `local` test runtime is cache-only), single-flight
  guarded. Per-avatar plugin skills are NOT in the cache: `listPluginRootSkills` scans each run's plugin
  roots (`skills/<dir>/SKILL.md`) so the allowlist covers them. Over-inclusion in the allowlist is inert;
  omission hides a skill — hence fail-open on any doubt. Known edge: an availability-gated CLI skill
  absent at preflight (e.g. `commit`) stays hidden while any skill is disabled.
- **Meta-cognition:** `buildSystemPromptAppend` standing note (`adminDisabledTools/-Skills` on
  `AgentRequest`) + `describe_system` "Admin-disabled …" lines (via `SystemToolsContext.toolSkillPolicy`)
  — a disabled skill may still be LISTED when the cache is stale, so the note pre-empts wasted attempts.
- **Beware `*/` in JSDoc:** a glob like `skills/*/SKILL.md` inside a block comment TERMINATES it and the
  rest of the file parses as code (surfaced as bizarre TS1443/TS1160 errors far below). Write
  `skills/<dir>/SKILL.md` in block comments; `//` line comments are safe.

## Agent teams (experimental — named subagents + SendMessage)
- **Enablement is three-legged** (2026-08): `agentSubprocessEnv` sets
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; `SendMessage` is exposed via `SDK_TEAM_TOOLS` (removed from
  `UNUSED_SDK_BUILTIN_TOOLS`) and folded into the hook's `TASK_ORCHESTRATION_TOOLS` auto-allow +
  `allowedTools`; and ONE admin toggle (`agent_teams` in the togglable-tool catalog) switches the WHOLE
  feature: it disallows the `SendMessage` tool AND (via `isAgentTeamsDisabled` →
  `agentSubprocessEnv`'s third arg) forces the CLI flag to "0". **Precedence:** admin toggle (off wins
  over everything) > operator-set env value in the deploy environment > default-on. The CLI-side gate
  (`isAgentSwarmsEnabled` in the bundled CLI) also consults a statsig gate that DEFAULTS TRUE offline.
  Keep the tool-name→feature semantic in `isAgentTeamsDisabled` (next to the catalog), never inline
  `includes("SendMessage")` at call sites.
- **Usage shape in CLI ≥2.1.x:** there are NO TeamCreate/TeamDelete tools and `Agent.team_name` is
  deprecated — a session has ONE implicit team; `Agent` with `name:` spawns an addressable teammate and
  `SendMessage({to: name})` messages it. Teammates' own tool calls still hit the PreToolUse hook
  individually, so per-viewer gating is unchanged.
- **Presentation:** `SendMessage` is deliberately NOT in `SDK_HIDDEN_ACTIVITY_TOOLS` — coordination
  renders as a visible tool row ("팀원 메시지 전송", detail = `recipient · summary|content` via the
  `summarizeToolInput` special case; CLI input keys are recipient/content/summary). Teammate lifecycles
  surface through the existing subagent/task event paths (`SUBAGENT_TOOLS`, `task_started` system
  events); the teammate's addressable identity rides on `AgentSpawnEvent.name` (from the spawn's
  `input.name` — `task_started` never carries one; `teammate_name` exists only on hook inputs) and the
  client keeps it as the card's OWN field (`LiveAgentNode.name`, rendered `@<name>` ahead of the label
  via `agentTitle` in `lib/agentCards.ts`). It used to be folded into the label, and the `task_started`
  behind EVERY spawn re-announces the card with no name — and with the `subagent_type` a spawn omitted,
  defaulted to `general-purpose` — so the name was overwritten within milliseconds. The persisted
  snapshot carries `name` as well (whitelisted in `sanitizeActivity`); older snapshots keep it inside
  `label`. Parallel agents fold their tool lists — see `client.md` (Behavior gotchas).
- **Headless caveat:** `teammateMode` ('auto'|'tmux'|'iterm2'|'in-process') comes from settings files,
  which Noah never loads (`settingSources: []`) — runs rely on 'auto' resolving to in-process in a
  TTY-less server. Verified only at the unit level; watch the first live runs on the deploy server.

## Workflow / ultracode (dynamic multi-agent orchestration, enabled 2026-08-30)
- **Enablement mirrors agent teams' pattern, minus the env-var leg:** `Workflow` is exposed via
  `SDK_WORKFLOW_TOOLS` (removed from `UNUSED_SDK_BUILTIN_TOOLS`, which used to drop it purely to save the
  ~4.7k-token tool description) and folded into the hook's `TASK_ORCHESTRATION_TOOLS` auto-allow +
  `allowedTools`, same as `SDK_TEAM_TOOLS`. One admin toggle (`workflow` in the togglable-tool catalog,
  `toolSkillPolicy.ts`) can still disable it — the policy's disabledTools check runs BEFORE the
  auto-allow, so the kill-switch wins regardless. The SDK's own "ultracode" keyword trigger
  (`workflowKeywordTriggerEnabled`, default true) needed no code change — it was always on; only the
  advertised `Workflow` tool was missing for it to switch the turn into.
- **KNOWN LIMITATION — background subagents bypass the permission hook.** A `Workflow` invocation always
  returns `status: "async_launched"` (per `WorkflowOutput` in `sdk-tools.d.ts`) and its `agent()` calls run
  as background tasks — there is no foreground/synchronous mode to fall back on, unlike `Task`/`Agent`
  (which `SUBAGENT_SPAWN_TOOLS` forces foreground specifically to dodge this same gap). The bundled CLI
  consults neither hooks nor `canUseTool` nor `allowedTools` for a background subagent's own tool calls,
  and auto-denies every permission-needing one (upstream-acknowledged, claude-code #34692/#27661). In
  practice: a workflow-spawned agent's read-only work (Read/Grep/WebFetch/…) succeeds and shows normally;
  any Bash/Write/Edit/etc. it attempts silently fails as if the user refused. Owner-accepted tradeoff
  (2026-08-30) — re-verify on SDK bumps and drop this caveat once background subagents inherit the
  parent's permission wiring (same note as `SUBAGENT_SPAWN_TOOLS`). 2026-09-27, CLI 2.1.283: a
  background SUBAGENT's tool call now reaches the PreToolUse hook (direct spike — see
  `chat-sse-media.md`); Workflow `agent()` calls were NOT re-tested, so this caveat stands until they are.
- **Activity-tree nesting:** a workflow's own container `task_started` (system event, `workflow_name` set —
  a more robust signal than its exact `task_type` literal, which is `local_workflow` today) renders as an
  AGENT node, not a task row — only an agent can be a `parentId` target in the client's `liveAgents` tree,
  and a task row can only attach flatly to an `agentId`. `LoopState.activeWorkflowAgentId` tracks the most
  recently started, still-running workflow's node id; a subsequently spawned agent whose `task_started`
  matches `AGENT_TASK_TYPES` (`subagent`/`local_agent`/`remote_agent`, or any `subagent_type` present) nests
  under it instead of flattening to `main`, and the pointer clears when that workflow's own task ends. Last
  workflow wins on concurrent workflows (rare) — a visual grouping aid, not a correctness guarantee. See
  `sdkMessageHandlers.ts`'s `handleTaskSystemEvent`.

## Adding / changing an MCP tool server
- **One template per `*Tools.ts`:** `buildXTools` (handler-level owner/elevated guards) + `buildXServer`
  + a `SERVER_NAME`/`TOOL_NAMES` const pair.
- **A new tool means updating BOTH `mcpServers` AND `allowedTools` in `runPlan.ts`** (`buildAgentRunPlan`;
  both lists moved there with the run-plan split) — two hand-synced lists. Add to one but not the other and
  the model either sees a tool it can't call or can call a tool it can't see. (Making this data-driven is
  deferred, T3.5.) A conditionally built tool on an EXISTING server (`create_repo`, `create_share_link`)
  gets its own `allowedTools` entry keyed on the SAME boolean as its build.
- **`create_share_link` gate (`mcp__file_output__create_share_link`).** It lives on the `file_output` server
  but registers only when runPlan's `shareLinkToolActive` holds: `fileOutputActive && events.onShareLink &&
  ownerToolAccess && !groupAgentRun && !personalAgentRun && !consultationRun && !request.headless &&
  !request.externalTaskApi`, computed right after `fileOutputActive`, before `buildSystemServer`. That one
  boolean drives the tool build (`shareLinkEnabled`/`createShareLink`/`signupOpen` on
  `FileOutputToolsContext`), its own `allowedTools` entry (`FILE_OUTPUT_SHARE_LINK_TOOL_NAME`, deliberately
  NOT in `FILE_OUTPUT_TOOL_NAMES`), `SystemToolsContext.shareLinksEnabled` and `AgentRequest.shareLinksEnabled`
  (stamped in `runClaudeAgent`). The chat route supplies `onShareLink` only on interactive own-avatar owner
  turns and re-checks per call (once the visible turn is finalized it refuses unless the owner steered the
  current segment — a pure wake-up turn still refuses); the handler refuses without the callback. Prompt: one
  short tool line when enabled (the flag-maximal config in `tests/system-manual.test.ts` is budgeted under
  18,000 characters; always-on and data-driven owner sections are not budgeted, so the cap is a tripwire, not a
  bound on real owner prompts), else — on any run with file output — the 공유 링크-button redirect (group-agent
  runs: no button, their threads cannot be link-shared). describe_system mirrors it with an owner line
  (available + facts + live sign-up caveat, or not available + why), a group-agent line and a non-owner line.
  The one-link rule is per delivered CARD on all three agent surfaces (tool description, describe_system, the
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
  fetches from the APP process, NOT the CLI subprocess — that's the whole point: the built-in WebFetch
  force-upgrades `http://`→`https://` (verified on the bundled binary), so plain-HTTP intranet pages only
  work here. Proxy: `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` via undici's `EnvHttpProxyAgent` — must use
  undici's OWN `fetch` (node's global fetch is a different bundled undici and rejects the dispatcher).
  Live-verified: undici tunnels EVERY proxied request via `CONNECT` (even `http://` targets; curl uses
  absolute-form GET instead), so a corporate proxy that only allows `CONNECT :443` refuses proxied
  plain-HTTP to EXTERNAL port-80 sites. Intranet http bypasses the proxy via `NO_PROXY`/direct, so this
  bites rarely — check the proxy's CONNECT port policy before blaming the tool.
  Private CAs: `NODE_EXTRA_CA_CERTS` (node-native) and `GITHUB_CA_CERT` (process-wide
  `tls.setDefaultCACertificates`, tlsCa.ts) both cover it. Guards: handler gates on `ctx.elevated`;
  loopback + link-local/metadata (169.254.x, `::1`, `localhost`, v4-mapped) refused while PRIVATE ranges
  (10.x/172.16-31/192.168) are deliberately allowed; same-host redirects followed (≤5) but cross-host
  redirects REPORTED for an explicit re-fetch (the built-in WebFetch contract, and it re-runs the guard);
  2MB streamed body cap; 20k-char result window with `offset` continuation; charset from the header or a
  `<meta charset>` sniff (KR intranets still serve euc-kr). HTML→text is deliberately dependency-free
  (entities decoded AFTER tag-strip; links kept as `label (abs-url)`). Proxy self-state comes from ONE
  helper, `webFetchProxyState()` (values redacted to scheme://host:port — proxy creds never enter a
  prompt), read by BOTH `buildSystemPromptAppend` (`AgentRequest.webFetchProxy`, set in `runClaudeAgent`)
  and `describe_system` — the Confluence-style deployment-fact sync. The built-in WebFetch stays
  available (its own description tells the model to prefer an MCP web fetch tool); admins can still kill
  it via the builtin-tool policy toggle.
- **Images for documents and decks: ONE describe_system line plus short standing text, on the same run
  flags (2026-09-30).** Every image the avatar is shown can now be a FILE it places into a deck, document
  or commit, all under the conversation scratch workspace: user attachments in `attachments/` (staged on
  every local turn, see [`chat-sse-media.md`](chat-sse-media.md)), browser screenshots in `captures/`
  ([`browser-bridge/contract.md`](browser-bridge/contract.md)), and Confluence attachments saved with
  `save_to_workspace` in `confluence/` (next bullet). describe_system prints `- Images for documents and
  decks: …` from ONE helper, `imageSourcesLine`, in the owner, group-agent and non-owner branches (the
  `deckCapabilityLine` pattern). It names the absolute path when `SystemToolsContext.scratchWorkspaceDir`
  is set. It lists attachments unless the run is `headless`, captures only when `browserEnabled` and vision
  is on (at most 30 per RUN), and Confluence only when `confluenceSaveToWorkspace` holds, and it always
  says `mcp__web__fetch` returns text only. It ends with what the run may DO with those files, from ONE
  flag both surfaces read: `canWriteFiles` (`SystemToolsContext` and `AgentRequest`) = runPlan's
  `elevatedToolAccess`, the class whose Write/Edit/Bash pass the PreToolUse hook. A run that can write is
  told to copy the FILE into the deliverable. A read-only run (a plain colleague, a restricted headless
  run) is told it can read the files but not place them here (the owner or a trusted teammate can, the
  deck line's wording), so it is never steered toward writes its hook denies. The vision user-prompt tail
  in `buildUserPrompt` branches on the same flag. Undefined (an unwired caller) resolves conservatively,
  on both surfaces alike: only the owner's own run or a group-agent run counts as writable. The prompt
  mirrors the same flags in three short places: `imageFilesSection` (vision on AND a deck flag — a
  text-only run is shown no images, and `noVisionSection` already covers its files; the deck flags already
  imply an author, so no read-only branch is needed there), the browser paragraph's screenshot sentence
  (vision branch, "the scratch workspace's `captures/`", since an open working repo makes the clone the
  cwd), and the Confluence paragraph, keyed on `AgentRequest.confluenceSaveToWorkspace`. `runClaudeAgent`
  stamps both booleans from the same runPlan values describe_system's ctx got (the Confluence stamp is
  pinned end to end in `tests/agent-share-link.test.ts`). `tests/system-manual.test.ts` budgets the
  flag-maximal config in BOTH vision states under its 18,000 tripwire: vision OFF sits 4 characters under
  it, vision ON (which carries `imageFilesSection` and the captures sentence) about 80 under. Confluence
  (data-driven) is unmeasured. Keep them short.
- **Confluence `get_attachment` `save_to_workspace` — a LOCAL write, never a Confluence mutation.** With
  `save_to_workspace: true` the handler (after its unchanged `elevated` gate) writes the downloaded bytes
  (any media type, under the existing `max_bytes` cap) to `<scratch>/confluence/<attachmentId>-<safeName>`
  and adds the absolute `savedPath` to the JSON payload. The inline result is unchanged: an image block on
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
  `ConfluenceToolsContext.isConversationLive` (runPlan: the conversation row still exists — ids are never reused) is
  checked after the write. Target = `ConfluenceToolsContext.workspaceDir` = runPlan's pure
  `conversationScratchDir(request)`. Every run with a conversation workspace (chat route `executeChatTurn`
  for own-avatar, teammate, group-agent, bot and task-API turns; the owner-routine scheduler) passes
  `cwd: activeRepoCwd ?? workspaceDir` + `additionalDirs: activeRepoCwd ? [workspaceDir] : undefined` with
  `activeRepoName` set alongside the clone, so an open working repo moves the scratch to
  `additionalDirs[0]` (never the clone). No `conversationId` (profile generators, consultations) →
  undefined → the option refuses before any request ("Saving attachments to the workspace is not
  available in this run."). runPlan derives ONE boolean, `confluenceSaveToWorkspace` = Confluence group
  registered && `elevatedToolAccess` && scratch dir && `confluenceCredentialsConfigured` (the tools' own
  `credentials()` check over the decrypted vault, which is why `ownerSecrets` is now read before
  `buildSystemServer`). It hands that boolean, with `scratchWorkspaceDir` and `canWriteFiles`, to
  `SystemToolsContext`, and returns the two booleans (not the path, which only describe_system names) on
  the plan for the prompt stamps (`AgentRequest.confluenceSaveToWorkspace`, `AgentRequest.canWriteFiles`).
- **The `mcp__`-prefix auto-allow in the PreToolUse hook fires BEFORE the owner check**, so every tool
  MUST self-gate in its handler. Don't rely on the hook.
