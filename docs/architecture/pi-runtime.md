# pi-gateway runtime (the only agent runtime)

Noah as a BFF over a dedicated pi-gateway instance, deployed WITH Noah as one compose stack (see "Deployment"; design:
`~/.noah-work/pi-migration-2026-10-29/design.md`).
The agent loop runs in pi (`POST /v1/responses`, service key + `user`); files and commands run in the run
principal's own pi sandbox; Noah's in-process MCP tools are served to pi's broker over HTTP with a per-run token.
The Claude Agent SDK runner was removed (U8, 2026-10-29); `AGENT_RUNTIME` is `pi` (default) or `local` (the
deterministic stub for tests and the e2e harness), and any other value (`claude` included) stops the boot. No
pi-gateway code is changed — everything pi lacks is a Noah-side degrade, stated on BOTH metacognition surfaces.

## Run classes and the sandbox principal

`runAgentStream` (`agent/index.ts`) sends every non-`local` run to `runPiAgent`. The sandbox principal is
`piRunPrincipal(request)` (`agent/pi/piRuntime.ts`, unit-pinned) = `viewerUserId ?? avatar.id`, whoever the run
executes AS — except an avatar consultation, which `piRunPrincipal` refuses and `runPiAgent` runs in a sandbox of its
own:

| Run class | Principal (sandbox) | Owner data |
|---|---|---|
| owner chat, owner routine, task-API turn | the owner | own |
| trusted (group) colleague chat | the colleague (U4) | owner repo/brain/skills only through Noah MCP tools |
| untrusted colleague chat | the colleague | the read-only MCP set only (`mcpAllowedTools`) |
| avatar consultation (the consulted avatar's run) | NOBODY: a fresh, empty `consult-<random>` sandbox, deleted after the run | read-only MCP toward the consulted owner |
| intro/hashtag generators, any run without a conversation | the owner | own |

Every class runs in its principal's OWN sandbox, never over the owner's files. A COLLEAGUE chat (trusted or not —
`sandboxOwner: "viewer"`) runs someone else's avatar — the owner's persona, skills and recalled notes — in the
colleague's sandbox, so its pi session is `read_only` (pi-gateway P1, user decision 2026-10-31): pi gives it only
`read`/`ls`/`find`/`grep` (+ `present_file`), no `write`/`edit`/`bash` and no sandbox-run MCP server, for the
session's whole life. The capability plan derives `PiRuntimeFacts.readOnlyBuiltins` (= `sandboxOwner === "viewer"`)
and `runPiAgent` sends `read_only: true` on every NEW pi session of that run (like the model and effort; a
continued session already has it). Every other class keeps the full built-ins (read/write/edit/bash/ls/find/grep).
What a run may do to anyone else's data is decided only by the `/mcp` gate (`allowCall` over this run's
`mcpAllowedTools`) and the handlers' self-gates. Both metacognition surfaces say what the run has and whose
sandbox it is: `PiRuntimeFacts.sandboxOwner` (`owner` / `viewer` / `nobody`, set by the capability plan) renders ONE
sentence, `piSandboxOwnerSentence` (`ownerState.ts`), in the prompt's runtime section and describe_system's
runtime line — the `viewer` one says the session is read-only — and `readOnlyBuiltins` switches the built-in tool
list, the deck line's `read-only` tail (`DeckAuthoringStatus`), the image-sources line, the attached-images tails,
the no-vision PDF hint, the draw.io section and the working-repository turn line to their read-only wording.
An admin built-in toggle is advisory on pi (describe_system names it as such); a
disabled SKILL is enforced by omission (see "Skills").

**A run nobody can answer starts its pi session `interactive: false`** (pi removes `AskUserQuestion` from the
session and its subagents, for the session's whole life): a scheduled routine, an avatar consultation and the
intro/hashtag generators. The capability plan derives `PiRuntimeFacts.nonInteractive` (= `headless ||
avatarConsultation`) and `runPiAgent` sends it on every NEW pi session, never on a continuation (pi 400s a
different value on a later turn). These runs never continue a session another class started: routines pass no
resume point and their rows carry none, consultations and generators have no conversation. The external task API
is NOT one of them — its key holder answers `question` prompts through `/respond`, so its sessions stay
interactive. A run without `onQuestion` (exactly these) that gets a `requires_action` anyway fails with a
`protocol` error (`runPiTurn`); the former fixed "cannot ask" answer is gone. Both surfaces state it with
`PI_NO_ASK_USER_SENTENCE` (`ownerState.ts`): the per-turn run-kind note (`piRunKindParagraph`) and describe_system's
runtime line; the prompt's "do not ask questions" instruction stays.

**A run without a conversation** (consultations, the generators) works in a run folder
`/workspace/c/<piEphemeralRunKey>/` (`run-<feature>` — `run-intro`, `run-hashtags` — for a generator, REUSED in the
owner's sandbox and never removed; `run-ask` for a consultation, gone with its sandbox): no stored pi session and no
`pi_instructions` row (the prompt is rendered for that run only).

**A consultation's own sandbox** (user decision 2026-10-30, review-2 H1). The consulted avatar's run is driven by
ANOTHER user's authored text (its persona, knowledge-repo `CLAUDE.md`, recalled notes and captured pages) with full
built-ins and no one watching, so it runs neither in the asker's sandbox (it could read the asker's conversation
files, edit the asker's repo copies that the asker's next `commit` reads back, and `request_info` what it read to the
target) nor the target's. `runPiAgent` mints `consult-<24 random hex>` (`beginPiConsultationSandbox`; pi's user-id
pattern accepts it, no Noah id has that shape), records it under `<dataDir>/pi-consultation-sandboxes/`, and in
`finally` removes its `u-<key>` folder through a pinned descriptor (no link followed), its repo-copy records and the
record (`endPiConsultationSandbox`); the boot sweeps records a crash left (`sweepPiConsultationSandboxes`). The
sandbox CONTAINER is pi's: sandboxd reaps it when idle (`SANDBOX_IDLE_SECONDS`, 15 min default) and no request ever
names that principal again. Cost: each consultation cold-starts a container (~300 ms on the dev box) before its first
model call. Skills there are the bundled ones as files plus the target's via `mcp__skills__read` (a non-owner run);
`viewerUserId` stays the asker, so the MCP gates, `request_info` attribution and trust checks are what they were.

## One run (`agent/pi/runPiAgent.ts`)

1. **Capabilities** — `buildRunCapabilities(…, { piConversationDir, … })` (`agent/runCapabilities.ts`),
   the ONE capability plan (hex-ssh, 공용 MCP and plugin servers included — Noah relays them, see "Proxied MCP
   servers"), and stamps `PiRuntimeFacts` onto describe_system's ctx and (via
   `stampPromptRequest`) the prompt.
2. **Run token** — `McpRunRegistry.register` with EVERY name in `PI_MCP_SERVER_NAMES` (`agent/pi/mcpCatalog.ts`):
   Noah's own servers (`PI_NOAH_SERVER_NAMES`; built ones serve calls, unbuilt ones are tool-less stubs) and the three
   relay ids (`hex-ssh`, `plugins`, `shared`). Gates: `listTools` answers `tools/list` of Noah's own servers from the
   static catalog (all tools of every server, widest form — built once per process from inert contexts); a relay
   lists THIS run's tools (per token). `allowCall` admits only this run's `mcpAllowedTools` (relays: a tool of a
   source this run relays that passes its filter); a refusal names `mcp__system__describe_system` and forbids
   workarounds. `transformResult` redacts every result (`capabilities.piRedactions`). Why static: pi lists a
   session's MCP tools ONCE at session build and keeps them while later turns (each with its own token and
   capabilities) reuse the session. Handlers still self-gate. The token rides the `x-noah-run-token` request header;
   revoked in `finally` (in-flight handlers abort).
3. **Prompt (D2)** — `buildSystemPromptAppend` with `piRuntime` set, rendered at the conversation's FIRST pi turn and
   frozen in `conversations.pi_instructions` (`ensureConversationPiInstructions`, write-once like `todo_snapshot`);
   sent as `instructions` only when a session starts, and re-sent verbatim for every later session (model switch,
   lost session). Per-turn facts ride the user input instead (`buildPiTurnPreamble`): the KST date/time line, the
   turn's RUN KIND (`piRunKindParagraph`: live chat + the mid-turn-message line + background `ask_avatar`, a
   routine's unattended rules, or the external-task provenance paragraph — the same three cases as describe_system's
   origin line), a rewind's provenance, the open working repo's sandbox copy (`piActiveRepoTurnLine` — `open_repo`
   changes it mid-conversation), and a new session's reason. One conversation mixes routine runs, task-API turns and
   live chat on ONE pi session, so the frozen text must not depend on the run kind (review M2): an owner routine
   renders the OWNER branch (`piOwnerRun`), the owner line and the 할 일 policy name both cases, and the
   getting-started pitch is omitted when the first turn is unattended. Capability FACTS that differ by kind (browser,
   file cards) stay D2-stale; the run-kind note says describe_system is authoritative and a missing tool is refused.
   Rows frozen by an earlier build of this branch keep their text (unreleased; only dev/e2e instances have them). The pi variant
   adds `piRuntimeSection` (sandbox, work folder, built-in tools, `mcp_call`/`mcp_search`, what is missing, "these
   instructions were fixed at conversation start — check describe_system").
4. **Input** — preamble + `buildUserPrompt` (history only on a fresh session, cap `PI_FIRST_TURN_HISTORY_LIMITS`
   120 msgs / 60k chars instead of 24 / 12k) + image blocks as `input_image` data URLs. Attachment files are staged
   by the route straight into `/workspace/c/<seg>/attachments/` and listed by sandbox path (`stagePiAttachmentFiles`
   maps host → sandbox; it copies only a file staged elsewhere). Skills are synced first (see "Skills").
5. **Session** — `previous_response_id` = `resumeSessionAt ?? resumeSessionId` when it is a `resp_…` id; anything
   else (a CLI session id from the retired SDK runner) means a new session from the text history. An image turn
   continues the stored session unless it is a rewind. Every committed turn
   reports its response id via `onSessionId` AND `onResumePoint({sessionId: id, uuid: id})`, so the chat route
   persists it as `agent_session_id` and stamps it on the assistant row; a rewind onto that row forks from it
   (pi branches on an older `previous_response_id`; no fork flag).
6. **Errors** — 404/409 on a continued session, or 400 `model_not_configured` (the operator removed the session's
   model from pi; a session's model is fixed, so a rewind onto a row of that session would otherwise fail every time;
   `isLostPiSession`) → once, a new session from history (status-free, the model is told
   in the preamble). 503/429 at stream open → `withPiRetry` backoff (status line `pi-gateway가 바빠서…`). An empty turn —
   pi's `empty_response` (no text, reasoning or tool call; pi does NOT commit it) — is re-sent ONCE as the same
   request (same `previous_response_id`, or the same fresh session; status line `모델이 빈 응답을 보내 한 번 더 시도하는 중…`),
   never once a text delta or a question reached the user, a steer is queued, or for a steer follow-up turn. A model
   fallback chain (routines, task API: `modelFallback`) gives each attempt a fresh session.
7. **Stop / failure** — a stop `cancel`s the live response, so pi COMMITS the partial turn (`incomplete`) and the runner
   reports its id. The chat route's cancel and error paths keep that id as `agent_session_id` (`sessionAfterAbort`):
   the next turn continues it, and the stopped row already shows the same partial. They clear it (history rebuild —
   chat-02) when the run's LATEST input never committed: stopped before pi created the response, a failed
   response, or a steer follow-up turn stopped before its own commit (its steer is in Noah's rows, not in pi).
   pi keeps the stopped turn but does NOT feed its partial text back to the model (seen live in S05: the continued
   request carries the stopped prompt, no assistant message), so the route hands the stopped row's text as
   `AgentRequest.stoppedAnswer` and a CONTINUED turn's input restates it (`Stopped answer: …<stopped_answer>`, tail
   4 000 chars; `buildPiTurnPreamble`). A fresh session needs no note — its text history ends with that row.

## S1 degrades (pi changes P1–P6 are out of scope)

| Gap | Noah-side behavior | Surfaces |
|---|---|---|
| no mid-turn input (P2) | steers queue; when the pi response completes ALL undelivered ones go as ONE follow-up turn on the same run (`onTurnResult({steerPending:true})` → the route's `turn_end` row, then `delivered`/`completed`) | prompt mid-turn line + describe_system say "arrives as the NEXT turn, after your current answer"; the composer always says "지금 답변이 끝난 뒤 이어서 전달됩니다" (the `open` frame carries no delivery mode); the delivered row's badge is position-based (`steerBadgeLabel`: "답변 뒤 전달" after an assistant row — the retired CLI runner's mid-turn rows still read "응답 중 전달") |
| model/effort fixed per session (P3) | per-session profile `model\|effort` in `conversations.pi_session_profiles` (JSON map keyed by the session part of `resp_<session>_<n>`, newest 32); a mismatch starts a new session from history, status line `모델 또는 사고 강도가 바뀌어 새 세션에서 이전 대화 기록으로 이어갑니다…` | runtime line + `Session note` in the turn input |
| no sandbox secrets (P4) | shell-exposed secrets are NOT exported; owner runs still go to pi | secrets section + describe_system's shell-secret line say UNAVAILABLE with the names |
| context window (P5) | unknown (pi's model list carries none): the usage badge shows output tokens only; no compaction chip | — |
| subagents (P6) | flat: pi's `Agent` is one card | — |
| no per-session cwd (P1) | the model is told to work in `/workspace/c/<seg>/` with absolute paths (prompt + describe_system + refusal redirects); Noah creates the folder 0700 | both |
| no WebSearch | not registered; stated | both |
| relayed MCP tool lists are per SESSION | pi reads `tools/list` when it builds the session (first turn, after ~5 idle minutes, a model change); a server/tool connected later appears only in a later session, a removed one is refused at call time | both (runtime line + prompt sentence) |
| broker calls cannot wait minutes | `ask_avatar` in a chat runs in the background, a canvas never waits (see "Asynchronous tools") | both + tool descriptions |
| date fixed at session creation | KST date/time line prepended to every input | turn input |

## Files: the sandbox conversation folder (`agent/pi/piWorkspace.ts`)

The chat route and the scheduler resolve the run's sandbox folder BEFORE building the request (`piRunWorkspace`,
from the same `piRunPrincipal` the runner uses) and then use `preparePiRunWorkspace`: the turn's workspace dir IS
the host view of `/workspace/c/<conv-seg>/` (`<PI_WORKSPACES_DIR>/u-<sha256(principal)[:24]>/c/<seg>`, 0700). So every server-written copy lands there with no
second copy: staged attachments (`attachments/`), browser captures (`captures/`), Confluence `save_to_workspace`
(`confluence/`). The request's `cwd` is that folder (never Noah's repo clone), and the file-output roots are the
user's WHOLE sandbox workspace (the model may build anywhere under `/workspace`, e.g. a working-repo copy).

| Direction | Where | Rule |
|---|---|---|
| model → Noah (`show_file`, `share_file`, `copy_image`) | `runCapabilities` wrappers → `piToolPathToHost` | absolute under `/workspace`, or relative = relative to `/workspace` (pi's shell start); anything else (`/tmp/…`, a planted link out of the root) is refused with an English redirect BEFORE the sink; the publishers' own realpath containment runs on top |
| Noah → model (capture `savedPath`, Confluence `savedPath`) | `toSandboxPath` (`piSandboxPath`) | host path under the user's root → `/workspace/…` |
| deck previews | `share_file` → `loadConverterPreviews(allowedRoots = [user root])` | the hash-bound `<stem>.preview/` sidecar is read through the host path, like today |

- **D3 (first pi turn of an old conversation):** `moveLegacyConversationWorkspace` moves `dataDir/workspaces/<avatar>/<conv>`
  into the sandbox folder — links/specials never followed (left behind), an existing sandbox file never overwritten,
  capped (256 MB / 10 000 entries / depth 16; past the cap the rest stays and the next turn continues), moved files
  removed from the old folder, and a `.noah-moved-to-pi` marker there makes later turns skip it.
- **Cascades:** `deleteConversationWorkspaceCopies` also sweeps `attachments/`, `captures/`, `confluence/` of the
  conversation's folder under EVERY `u-*` (`deletePiConversationCopies`), so every conversation-deleting path stays
  complete; the agent's own files in the folder stay. Rewind's dropped-attachment
  cleanup works unchanged (its workspace dir is the sandbox folder). Account deletion removes the user's whole
  `u-<key>` workspace and Noah's repo-copy records (`routes/admin.ts`).

### Host-side filesystem discipline (`pinnedFs.ts`, review C1)

Everything under `u-<key>` is the sandbox's, at Noah's own uid: the agent can replace ANY folder Noah later walks
into (`.noah`, `.noah/skills`, `c`, `c/<conv>`, `attachments/`, `repos/<owner>`, a copy's `.git`) with a symlink.
`ln -s ../.. /workspace/.noah/skills` once made the skill sync list `PI_WORKSPACES_DIR` and delete every other
user's sandbox. So no host-side write, listing, rename or removal below the user root resolves an agent-owned
component by NAME:

- **Folders are pinned by descriptor** (`PinnedDir`, `piSandboxDir`): opened one segment at a time with
  `O_DIRECTORY|O_NOFOLLOW`, each from the previous folder's descriptor (`/proc/self/fd/<fd>/<name>` — openat
  for Node), missing segments created by `mkdir` under the pinned parent and RE-opened no-follow. A link or a
  file anywhere on the way refuses the operation. Only the user root's parent (the operator's
  `PI_WORKSPACES_DIR`) is trusted as configured.
- **Entries go through the descriptor:** exclusive creates (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode set by `fchmod`),
  no-follow reads, renames inside the pinned folder, and a recursive removal that pins every sub-folder the same
  way and unlinks every link (never `fs.rmSync` on an agent-owned tree).
- **Reads by an already-checked path** (`share_file`/`show_file`/`copy_image` publishers, the deck sidecar
  manifest + renders, the working-copy read-back) verify the OPENED file's kernel path (`fdPathIs`,
  `readFileVerified`, `listDirVerified`) against the realpath they checked, so a folder swapped for a link
  between the check and the open is refused.
- **Users:** skill sync (a planted link → this run lists the skills `via: "mcp"` and says so in `failures`),
  `ensurePiConversationDir`, the D3 move (destination side), attachment staging (`stageChatImageFilesFromAttachments`
  / `stagePiAttachmentFiles`), browser captures, Confluence `save_to_workspace` (`workspaceAnchor` = the user
  root), the rewind cascade (`deleteStagedAttachmentCopies`), repo copies + `.prev` + the commit's `.git` refresh,
  conversation and account deletion. The generic writers take an `anchor` (the deepest folder the agent cannot
  replace) — the pi user root, or the scratch workspace itself when Noah cannot reach the sandbox workspaces (no
  `PI_WORKSPACES_DIR`: the route stages into Noah's own `dataDir/workspaces` folder, which the sandbox cannot see).
- **Residual (documented, not closable from Node):** a missing folder created on the way can be raced only into a
  refusal; and a file's CONTENT is the agent's after Noah wrote it. Without `/proc/self/fd` there is no pinning
  (entries would be addressed by name, check-then-act), so `AGENT_RUNTIME=pi` REFUSES TO BOOT there
  (`assertProcFdPinning` in `loadPiRuntimeConfig`). **A new host-side operation below a sandbox root MUST go through `piSandboxDir` /
  `PinnedDir`** — `removeNoFollow` and by-name `fs.*` calls are only for paths whose every ancestor is Noah's.

## Skills (`agent/pi/piSkills.ts`, `agent/skillsTools.ts`)

pi does not load Claude Code plugin roots. Each pi turn `materializePiSkills` syncs the run's `pluginRoots` into
`/workspace/.noah/skills/<root>/<skill>/` (`<root>` = `default`, `knowledge`, `group-<plugin name>`, `plugin-<plugin name>`) and
returns the index the prompt (`piSkillsSection`, frozen with the instructions — a skill added later loads from the
next conversation) and describe_system (`piRunLines`, live) both state (`PiRuntimeFacts.skills`).

- **Owner runs** (chat, routine, task API, generators — principal = the avatar's owner) copy every root into
  `.noah/skills/`. A **non-owner run** (a colleague in their OWN sandbox, a consultation in its fresh one) gets only the
  bundled default-skills as files, in a SEPARATE folder `.noah/skills-shared/<root>/` (so it can never touch the
  sandbox owner's own copies); the owner's personal/plugin/group skills are listed `via: "mcp"` and read through `mcp__skills__read`
  (`skills` server — registered only on such runs, when such skills exist; files never land in the
  other user's sandbox; links and paths out of the skill are refused).
- **Admin skill policy** by omission: a disabled skill (bare name or `<plugin>:<name>`) is not copied, listed or readable.
- **Rewrites** in copied `.md` files: `${CLAUDE_SKILL_DIR}` → the skill's sandbox path; `timeout: 600000` (Claude
  Code ms) → `timeout: 600` (pi seconds, max 86 400). Served skills read `${CLAUDE_SKILL_DIR}` as `skill:<root>/<dir>`.
- **Re-sync** is a stat-only fingerprint (path, size, mtime) of the source root AND of what was written, kept in
  each folder's `.noah-sync.json`; a root is rewritten only when either side changed (so an edit in the sandbox copy
  heals). Noah owns both folders, never anything outside them.
- **Pruning (review-2 M1).** Runs of one sandbox sync concurrently with DIFFERENT root sets (a chat with group
  knowledge off next to one with it on, a generator, a colleague chat in the viewer's sandbox), and a turn's frozen
  index names its copies for the whole turn. So only OWNER runs prune — non-owner runs only write their own roots and
  merge the manifest — and an owner run removes a root it did not write only once no run used it (manifest `usedAt`
  or the entry's mtime, the newer) for `PRUNE_GRACE_MS` (6 h, past the task API's 5 h budget), or at once when the
  admin policy left that root with no skill. It collects stale `.noah/skills-shared/` leftovers by the same rule. So a
  left group's skill copy can stay in the user's own sandbox up to 6 h. `__pycache__`,
  `.build`, `.git`, `node_modules` and links are skipped; caps 5 000 files / 128 MB per root, 32 MB per file.

## Working repositories (design D1, `agent/pi/piRepoCopy.ts`)

The canonical clone (`dataDir/git-repos/<owner>/<name>`) stays Noah-side and is the ONLY `.git` Noah runs git in
(`serverGitEnv`). A pi run works on a COPY in the viewer's sandbox, `/workspace/repos/<owner-seg>/<name>/` —
tracked + untracked-not-ignored files and `.git`, plain files, links never copied (caps 50 000 files / 512 MB).

| Tool (pi wording in the static catalog) | Behavior |
|---|---|
| `open_repo` | ensures the clone + identity, makes/keeps the copy (`keep`: an existing copy made from the current HEAD stays, edits and all; a stale one moves to `<name>.prev`), returns the sandbox path — usable THIS turn |
| `commit` (pi only, `GIT_REPO_PI_COMMIT_TOOL_NAME`) | reads the copy's WORKING TREE back (lstat walk, `.git` skipped at every level, links/specials skipped and reported, ignore rules from the CANONICAL clone via `git check-ignore`, tracked files under ignored folders still compared; caps 100 000 entries / 20 000 changed files / 256 MB / 64 MB per file), writes changed files into the clone (never through a tracked link or onto a folder), deletes files gone from the copy, `git add -A` + `git commit` there, then replaces the copy's `.git` with a fresh copy of the clone's (sandbox `git status` is clean again) |
| `sync_repo` | refused while the copy has uncommitted changes; else syncs the clone and refreshes the copy |
| `push` | pushes the clone (= what `commit` saved; sandbox-local git commits are never read) and notes uncommitted copy changes |
| `remove_repo` / `close_repo` | remove the viewer's copy + record / keep the copy |

Each copy's BASE commit is recorded Noah-side (`dataDir/pi-repo-copies/<user-key>/<owner-seg>--<name>.json`, never
in the sandbox). `commit` over a moved base (another conversation or a colleague committed, a sync pulled) is
refused with a redirect to re-open (last writer wins, never silently over a newer base). Turn start
(`resolveActiveWorkspaceRepo` with `piWorkspace`) only creates a MISSING copy and takes no per-clone run lock (Noah's
git ops are serialized per operation by `withRepoLock`, so two pi conversations can work on their copies at once).
A trusted colleague gets their own copy in their sandbox. Both surfaces: the prompt's working-repo section and
describe_system's working-repo line name the copy path and the commit → push flow (`PiRuntimeFacts.activeRepoDir`).

## Decks

On pi the deck toolchain is `piSandboxDeckToolchain(config)` (`deckRender.ts`), never the host probe:
`PI_DECK_SANDBOX=true` = converter INSTALLED with the sandbox image's facts (profiles embedded + malgun, one build
slot per sandbox, python-pptx present); off = `converter: NOT INSTALLED` with the operator fix named. The legacy
render path is off (no LibreOffice in the sandbox); `libreOffice` keeps the host value because share_file's approximate
previews still render Noah-side. Both metacognition surfaces and the static catalog's share_file wording read it.

## Proxied MCP servers (`agent/pi/mcpProxies.ts`)

Servers that exist only as a process or a remote endpoint are relayed by Noah as an MCP CLIENT and re-exported
on the run endpoint. Broker ids are global and pi freezes a session's tool list, so each kind is ONE stable id:

| Broker id | Source | Model-facing name | Child Noah spawns | Secrets |
|---|---|---|---|---|
| `hex-ssh` | the owner's SSH key (`sshActive`) | `mcp__hex-ssh__<tool>` (the pre-pi name, unchanged) | `scripts/hex-ssh-policy-proxy.mjs` → `HEX_SSH_UPSTREAM_COMMAND` | SSH material in the child's env (Noah spawns it itself: no argv, no wrapper file) |
| `plugins` | the run's plugin roots' `.mcp.json` (first name wins, load order) | `mcp__plugins__<server>__<tool>` | stdio: the def's command (`${CLAUDE_PLUGIN_ROOT}`/`${VAR}` expanded, cwd = def `cwd` or the root) — **bundled roots only** (see below); http/sse: `mcp-http-bridge.mjs` | NO plugin def gets the vault on pi. An http/sse def outside the bundled roots that names ANY `${…}` placeholder sits out (`piPlaceholderRefusal`); bundled defs keep `${VAR}` expansion from Noah's scrubbed env |
| `shared` | admin 공용 MCP servers (`planSharedMcpRun`, owner bindings) | `mcp__shared__<server>__<tool>` | always the bridge (header-less ones too: keeps `--use-system-ca` + error scrubbing) | slot values only in the bridge config file (written right before spawn, deleted by the bridge, `rm` again after) |

- pi's `mcp_call` resolves the plain form `mcp__<server>__<tool>` by suffix (`resolveAlias` in pi), so skills that
  name a plugin/shared tool without the relay prefix keep working. A plugin server named like a Noah server or an
  enabled shared server sits out and both surfaces list it with the reason; so does an http def with fields the bridge
  cannot carry (`oauth`, `headersHelper`, …).
- hex-ssh's per-viewer-class allowlist holds three times: the policy proxy (env `HEX_SSH_ALLOWED_TOOLS`), the
  pool (`allowTool` filters `tools/list` AND refuses `tools/call`), and the endpoint's `allowCall`.
- **Lifecycle:** one `PiMcpProxyPool` per run; nothing is spawned at plan time — a child starts on the first
  `tools/list`/`tools/call` that needs it (`tools/list` at session build: 10 s per source, a slow one is left out
  rather than failing the whole id within pi's 15 s). `finally` closes every client (stdin EOF → SIGTERM →
  SIGKILL; the policy proxy now also exits on stdin EOF) with a 0.5 s grace before the run returns; the close keeps
  going after. A closed pool refuses calls instead of respawning. Tests prove no process outlives it.
- **Redaction (`piRedactions`)**: the relays' secrets (the whole injectable vault once any of it reached a child,
  credential-looking bridge headers + their bare tokens via `mcpBridgeRedactions`, the
  SSH key/passphrase/password — never `SSH_USER`/`ALLOWED_HOSTS`) plus every browser-typeable secret value. Applied
  by the endpoint's `transformResult` to EVERY Noah MCP result of the run (`redactSecretValues`, `[REDACTED:<NAME>]`).
  pi's built-ins need none: the sandbox holds no secrets.
- **stdio servers spawn only from bundled plugins (`piStdioRootRefusal`).** A stdio def is a command Noah runs in
  ITS OWN container (the data volume, every user's state), so on pi only roots no agent can author qualify: the
  plugins bundled with this Noah build (`DEFAULT_PLUGINS_DIR`, classified by `piPluginRootKind`, `piSkills.ts`).
  Every other root is agent-writable and its stdio servers sit out, listed with the reason on BOTH surfaces (the
  frozen prompt's relay sentence and describe_system's relay line):

  | Root | Why it is agent-writable |
  |---|---|
  | personal knowledge clone (`dataDir/knowledge/<user>`) | `mcp__repo__*` write + commit, directly on that clone |
  | installed plugin repo (`dataDir/plugins/<user>/<repo>`) | at one remove: `mcp__git_repo__open_repo` takes any URL and `push` uses the owner's git token, and the next plugin refresh pulls what was pushed (Noah cannot tell which remotes the token can write, so all are refused) |
  | anything else | unknown provenance, refused (fail closed) |

  http/sse plugin servers are unaffected (the bridge is Noah's own script; the def supplies only a URL and
  headers), and so are admin 공용 MCP servers. A user who needs a stdio tool on pi gets it bundled into
  `default-skills`, as an http server, or as a 공용 MCP server. Moving plugin stdio servers INTO the viewer's
  sandbox would need pi's per-user sandbox MCP (a pi-gateway change, out of scope).
  **Placeholders (hardening 5a):** the same agent-writability decides http/sse defs. Every root but the bundled one
  is agent-editable, so a def there naming a `${NAME}` placeholder (a vault secret, or a value from Noah's own env)
  could send it to a host of its choosing from Noah's network, past the sandbox egress allowlist. On pi such a def
  sits out with a reason (`piPlaceholderRefusal`; both metacognition surfaces list it, and the prompt's secret
  section plus describe_system's secret line say no plugin def receives a secret here); one without placeholders
  relays verbatim. A user's secret reaches an external server only through a 공용 MCP slot binding. (The retired SDK
  runner substituted the vault into OWNED roots' defs through a secret wrapper; with it gone no plugin def anywhere
  receives a vault value.)

## Asynchronous tools (design D8, `agent/pi/asyncJobs.ts`)

pi's broker gives a call at most its server timeout, so a Noah tool that waits on a person or another run no longer
holds it:

- **`mcp__avatars__ask_avatar`, interactive chat** (a run with a steer channel): the handler runs the synchronous
  gates (`preflightAvatarAsk` — unknown/self/untrusted refuse at once) and returns `Consultation ask-<id> … started in
  the background`. The consultation (a pi run in its own fresh sandbox) runs as a `PiAsyncJobs` job; its
  result is pushed into the run's SteerChannel with BOTH texts (`askOutcomeDelivery`: English with provenance for the
  model, a Korean bubble carrying the answer for the chat — `SteerRecord.displayText` — plus WHO answered,
  `SteerRecord.source`). The route persists it as a `kind: "consultation"` user row with that source
  (`messages.consultation_json`), NEVER as a `steer` the owner typed: another avatar's answer is untrusted input, and
  any history rebuild (a fresh session after a cancel, model change, heal or rewind; `read_conversation`) re-feeds
  it framed by `consultationHistoryText` as that avatar's untrusted data, never as the owner's words. It is never a
  rewind/regenerate anchor, the client renders it under the consulted avatar's name (`@x 아바타의 답변`, badge `팀원
  상담 결과`), never shows it as a pending "나" bubble and never hands a dropped one back to the composer
  (`SteerPublic.source`). After the pi response completes, `runPiAgent` keeps the run OPEN while jobs are pending
  (status `팀원 아바타의 답변을 기다리는 중…`, capped at the consultation budget + 30 s; a message the user sends wakes
  it too), then delivers everything queued as ONE follow-up turn (the steer `turn_end` contract). So the answer always
  lands in a live run the client is attached to — no server-started turn the client would only discover on reload. A
  run that ends anyway (cancel, error) aborts its jobs; nothing is delivered later. Stop pressed DURING that wait ends
  the run as cancelled (`PiGatewayError("aborted")`), never as `done`.
- **Unattended pi runs** (routines, task API — no steer channel) keep the waiting call (`avatars` broker timeout
  240 s ≥ the 3 min consultation budget).
- **Canvas**: never waits (`canvasTools.ts` has no blocking mode any more) — controls always render non-blocking
  (`awaitInput: false`, `interaction: "async"`) and the submission arrives as the user's next message. Known edge: while a run is still open (waiting for a consultation)
  the client does not submit an async canvas (`submitCanvas` returns while streaming).
- Tool descriptions (`ask_avatar`'s two-mode sentence and the canvas never-wait sentence, the same text in the static
  catalog and on every run), the prompt (`piAsyncToolsSentence`) and
  describe_system ("Long-running tools on this runtime") state this.

## Tool discovery (usability report §6.5)

On pi the model sees only `mcp_search`/`mcp_call`; every Noah tool is found by pi's BM25 search (tool name, description,
argument names/descriptions and the broker entry's displayName/description; results carry the whole description + schema).
Measured without a model, then mitigated Noah-side:

| Mitigation | Where | Notes |
|---|---|---|
| **Known Noah tool names** in the frozen prompt | `piKnownTools` (`mcpCatalog.ts`) → `PiRuntimeFacts.knownTools` → `piKnownToolsSection` | Built only while the conversation has no `pi_instructions` (its first pi turn): every tool of THIS run (`mcpAllowedTools` ∩ catalog), one line `mcp__<server>__<tool>(<required args>)`, catalog order (servers as `PI_NOAH_SERVER_NAMES`, tools in registration order), then relayed tools read from the run's proxy pool (`listToolsReport`, pi's name sanitizing, sorted; a source that did not answer is flagged). Frozen with the rest (D2): a later tool is found with `mcp_search`, a listed one may be refused (describe_system is authoritative). ≈3.4k chars for all 99 Noah tools |
| Query line | `MCP_SEARCH_QUERY_LINE` (`piRuntimeSection`) | English, service id + action — tool text is English and keyword-matched |
| Callable-now mirror | describe_system `piRunLines` ← `PiRuntimeFacts.callableNoahTools` (set after `mcpAllowedTools`) | live list of exact names |
| Full sibling names | prompt, manual, skills, tool descriptions, errors | a bare `write_file`/`commit`/`get_note` is ambiguous in pi's `mcp_call` (repo vs git_repo) |
| Compact descriptions + discovery sentences | `pi/catalogText.ts`, applied by `piCatalogTool` in the STATIC catalog only (the builders keep the full text) | a compact entry names the sha256 of the builder text it replaces; a changed builder text is served instead (warn) and the test fails until the entry is revisited. Sentences were kept because the held-out query set did not regress |
| Noun-only broker descriptions | `SERVER_DESCRIPTIONS` in `scripts/pi-register-mcp.mjs` | pi shows the first line in the always-visible service list AND appends it to every tool document of that server, so verbs there match every tool (measured: verbs cost held-out recall) |
| Unknown argument names refused | `checkArguments` gate + `unknownArgumentProblem` (`mcpHttp/endpoint.ts`), wired by `runPiAgent` for Noah's own servers | the McpServer's zod objects STRIP unknown keys (MCP SDK 1.29 `z.object`), and the catalog schemas have no `additionalProperties:false`, so `list_todos {state}` used to list everything; now the call is refused with the valid names (nested objects/arrays of objects checked; `anyOf` branches and open objects not). Relayed servers are not judged |

## The `/mcp` endpoint (`mcpHttp/endpoint.ts`)

Mounted by `createApp` at `/mcp/:server` on every runtime (no token exists without a pi run → always 401). Its only
auth is the bearer run token; session cookies and other app auth never apply (`tests/pi-runner.test.ts` pins that a
signed-in cookie alone gets 401). The registry lives per Store (`piServicesFor`), shared by the router and runner.
It is mounted BEFORE the global `express.json({limit: "50mb"})`, so its own 16 MB body cap is the effective one.

**Network exposure (operator requirement):** the router shares Noah's listener, so with no allowlist the run token's
secrecy is the only barrier for an off-network caller. Either bind/firewall the port to the broker's network, or set
`NOAH_MCP_ALLOWED_CIDRS` (`mcpHttp/networkAcl.ts`, `net.BlockList`): only those TCP peers (never `X-Forwarded-For`;
`::ffff:` IPv4 peers are mapped) pass, everyone else gets 403 before the body is parsed or the token is read. Default
open; an invalid entry stops the boot. The bundled compose stack sets it to the broker's pinned `/32` (next section).

## Deployment: the bundled compose stack (U9; the dedicated instance of D5)

Noah and its pi-gateway are ONE `docker compose up -d --build` (operator steps: README "Deployment"; the dind
boot-test recipe: `build-run-verify.md`). No pi-gateway code or compose file is edited or copied:

- **`include:`** — `docker-compose.yml` includes `${PI_GATEWAY_DIR:-./vendor/pi-gateway}/docker-compose.yml`, the
  pi-gateway GIT SUBMODULE (`.gitmodules`, `ignore = untracked` for pi's own `.env`; the gitlink is the pin this
  branch is verified against, excluded from the Noah image by `.dockerignore`),
  together with `docker/pi/compose.override.yml` — Noah's instance configuration merged onto pi's services
  (sandboxd's `SANDBOX_IMAGE=noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG}`, built by the build-only
  `pi-sandbox-image` service FROM pi's own `sandbox-image`; the gateway's `SESSION_IDLE_SECONDS` from
  `NOAH_PI_SESSION_IDLE_SECONDS`, default 1800 — a reloaded idle session re-lists every Noah server, so pi's 300
  turned every 5-minute pause into a session start, see README "Sizing pi-gateway"; the broker's `noah-mcp`
  address). A pi-gateway bump
  moves the submodule (`git -C vendor/pi-gateway checkout <pushed commit>` + commit the gitlink) and re-runs the
  boot test.
- **`pi-setup`** — a one-shot service (`FROM` Noah's image, uid 10001 = the owner of pi's `admin_api_key` secret,
  read-only, caps dropped) that runs `docker/pi/pi-setup.sh` → `scripts/pi-register-mcp.mjs --configure-instance`
  once the gateway is healthy. It is idempotent and re-runs on every `up`; `noah-almighty` starts only after it
  exits 0 (`service_completed_successfully`). The admin key reaches the script through its env, never argv.
- **Networks** — Noah joins pi's `edge` network to call `http://gateway:8080` (`PI_GATEWAY_URL`, fixed by compose).
  pi's broker calls Noah's `/mcp/<server>` over `noah-mcp`, an INTERNAL network only the broker and Noah are on,
  from a pinned address (`NOAH_MCP_BROKER_IP`, default `172.16.248.10` in `NOAH_MCP_SUBNET` `172.16.248.0/24` — outside
  Docker's default auto-allocation pools, so no auto-allocated network, this stack's own included, can overlap it);
  `NOAH_MCP_ALLOWED_CIDRS` defaults to exactly that `/32`, so the network gateway (where published-port traffic can
  appear from) and every other pi service get 403. Sandboxes keep `network_mode: none` and gain no route.
- **Service key** — Noah's OWN 0400 uid-1000 copy of pi's service key (`docker/pi/setup-host.sh` copies it to
  `$PI_GATEWAY_SECRETS/noah/pi_gateway_api_key`), mounted as a compose secret and read through
  `PI_GATEWAY_API_KEY_FILE=/run/secrets/pi_gateway_api_key` (see "Env"); never in `.env` (an inline
  `PI_GATEWAY_API_KEY` there stops the boot). Same-uid caveat (#71): the file is readable by every uid-1000 child
  Noah spawns (hex-ssh, bundled stdio plugin servers, the HTTP bridge, git, LibreOffice) — the env scrub does not
  cover files; see `secrets-ssh.md` ("Same-uid posture (#71)").
- **Workspaces** — `$PI_GATEWAY_HOME/workspaces` is bind-mounted at `/srv/pi-workspaces` (`PI_WORKSPACES_DIR`,
  fixed), uid 1000 on both sides.
- **Shared variables** — Noah's `.env` (and the shell) win inside pi's included file too, so a key both read means
  the same on both sides: `NODE_EXTRA_CA_CERTS` is a HOST path (pi's meaning; compose mounts it read-only into
  Noah at `/etc/noah-almighty/extra-ca.pem` and points Noah's variable there), likewise `LOG_LEVEL`,
  `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PI_GATEWAY_HOME`, `PI_GATEWAY_SECRETS`.
- **Not supported with the bundle:** the egress overlay (`docker-compose.egress.yml`, `docs/egress-policy.md` —
  its firewall admits only its own proxy, so Noah cannot reach pi's gateway), and a second pi-gateway on the same
  Docker daemon (pi's sandboxd adopts and reaps every `pi-gateway.instance=default` sandbox there).

Run the registration by hand only for a native (non-compose) Noah:

```bash
PI_GATEWAY_ADMIN_KEY=… node scripts/pi-register-mcp.mjs --gateway http://pi-gateway:8080 \
  --noah-url http://<host-as-seen-from-the-broker>:48787 --configure-instance   # idempotent; --dry-run / --remove
```

- Each entry carries a noun-only `description` (`SERVER_DESCRIPTIONS`, see "Tool discovery"); re-running the script
  converges it.
- Registers one broker entry per `PI_MCP_SERVER_NAMES` name (ids = Noah server names, so pi's `mcp__<id>__<tool>`
  equals every `mcp__repo__commit`-style name in prompts/skills/manual, plus the relays `hex-ssh`/`plugins`/`shared`),
  header `Authorization: Bearer {{ctx.header:x-noah-run-token}}`. `timeoutSec` 120 by default; longer only where the
  server's own work needs it (`SERVER_TIMEOUT_SEC`: `avatars` 240 — unattended ask_avatar still waits; `repo`/`git_repo`
  300 — clone/sync/push + sandbox copy; `file_output` 240 — Noah-side deck previews; `hex-ssh` 600,
  `plugins`/`shared` 300 — remote/third-party). Browser ops fit easily (the bridge relay times out at 45 s).
  `--timeout-sec N` overrides every id. Every run also deletes this Noah's entries under a RETIRED id
  (`RETIRED_MCP_SERVER_NAMES`: `group_brain`, `group_repo` — retired 2026-10-30), and Noah's `/mcp` answers a
  call that still reaches one with a "was removed" error (`RETIRED_SERVER_MESSAGES`, `mcpHttp/endpoint.ts`). Refuses to take over an id pointing elsewhere without `--force`. The admin
  key is read from the environment only and never stored by Noah.
- `--configure-instance` also disables pi's `request_admin` and `present_file` built-ins (Noah has its own) and deploys
  `scripts/pi-system-prompt.md` as the live prompt `noah` (pi's default hardcodes "Reply in Korean" and request_admin;
  pi enforces no placeholder, the template keeps `{{WORKSPACE}}`, `{{LANGUAGE}}`, `{{DATETIME}}`).
- Other instance config stays in pi's own admin/`.env`: LLM servers, `SANDBOX_EGRESS_ALLOW`, turn concurrency limits
  (pi's defaults fit a small team; README "Sizing pi-gateway" has the measured sizing and the session-start limit).
  (`SANDBOX_IMAGE` and `PI_DECK_SANDBOX=true` are fixed by the bundle; a native setup sets both itself.)
  `SANDBOX_EGRESS_ALLOW` is the sandbox shell's ONLY way out (HTTP(S) via pi's egress proxy; empty = all blocked, a
  refusal is `407`). Noah's `NOAH_EGRESS_POLICY=domain-proxy` (and its 외부 통신 차단 panel) governs only Noah's own
  tools and relays on a pi run, so the prompt's egress line, describe_system's and the `network-policy` manual
  topic say exactly that.

## Models (`agent/pi/modelCatalog.ts`)

pi-gateway's LIVE model list (`GET /v1/models` → `PiResponsesClient.listModels()`, `{id, ownedBy}`) is the ONLY model
source (user decision 2026-10-31): the composer picker, the per-user default, the admin override
(`PUT /api/admin/model`) and the vision policy (`PUT /api/admin/model-vision-policy`, keyed by model id) all name pi
model ids; none = pi-gateway's DEFAULT model (picked on pi's admin LLM page), and then Noah sends no `model` at all.
`piServicesFor(store, config).models` is one catalog per app instance: a 60 s cache, one in-flight fetch for every
caller (5 s timeout), stale-on-error (a failed refresh keeps the last good list; retried after 5 s); never fetched
successfully → empty, and the `local` stub's is always empty (the client then hides the picker).

- **Run resolution** (`runCapabilities.ts`): the conversation's pick if pi offers it, else the admin override if pi
  offers it, else the default. A stored value pi does not offer (a legacy tier alias like `opus`, a model pi dropped,
  an SDK-era Claude id) reads as unset — no migration rewrites old values; a stored override pi does not offer is
  warned once per value (`modelOverride.ts`, review-2 M2) and `GET /api/admin/system` reports `modelOverrideIgnored`.
  describe_system names the id and its source (`… (chosen for this conversation in the composer)` / `(admin setting)`
  / `pi-gateway's default model (default)`, plus the ignored-override note).
- **Fallback** (`request.modelFallback`, unattended runs): `[resolved, default]`, so ONE retry on pi's default model
  in a fresh session; a run already on the default gets one attempt.
- **Writes** validate against the list: an unknown non-empty id → 400, pi never reachable → 503 (`offeredModelIdsOr503`,
  `routes/_shared.ts`). The chat stream's `model` is NOT validated: it is stored as sent ("" clears), so a pick
  survives pi being briefly unreachable, and the run applies it only while pi offers it.
- `GET /api/bootstrap` → `modelSelection: { models: [{id, server, vision}], defaultVision }` (`server` = pi's
  `owned_by`); `GET /api/admin/system` → `piModels`, `modelOverride`, `modelOverrideIgnored`, `modelOverrideChoices`
  (= the ids), `modelVisionPolicy`, `observedModel`.
- **`PI_MODEL_MAP` is RETIRED** with the composer tier registry (`modelTiers.ts`, deleted): no longer read; while it
  is still set every boot logs one warning (`warnRetiredModelMapEnv`).

## Env (config.ts → `AppConfig.pi`)

`AGENT_RUNTIME` (`pi` default, `local` stub; anything else stops the boot), `PI_GATEWAY_URL` + the service key
(required): inline `PI_GATEWAY_API_KEY` (in `SERVER_ONLY_SECRET_ENV_NAMES`) OR `PI_GATEWAY_API_KEY_FILE` (read and
trimmed by `readPiGatewayApiKey`; both set, an unreadable or empty file, or a second line stops the boot; the key never
enters `process.env` — the bundled compose stack sets only the file), `PI_WORKSPACES_DIR`, `NOAH_MCP_PUBLIC_URL`,
`NOAH_MCP_ALLOWED_CIDRS` (optional `/mcp` peer allowlist), `PI_DECK_SANDBOX`.

Removed with the SDK runner: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (the old hard lock), `ANTHROPIC_DEFAULT_*_MODEL`,
`AUTO_COMPACT_WINDOW`, `MAX_TURNS`, `READONLY_TOOLS`. Model credentials live in pi-gateway only (D7). The admin 시스템
panel (`GET /api/admin/system`) shows `piModels` (pi's live list) and a `skillDiscovery` list read from the bundled
default-skills root (`listPluginRootSkills`, `agent/skillCatalog.ts`); `PUT/DELETE /api/admin/claude-token` are gone.

## Existing deployments

New nullable columns `conversations.pi_instructions` / `pi_session_profiles` (NULL = no pi turn yet). Old CLI session
ids and resume points (anything not `resp_…`) are IGNORED by the pi runner, never resumed: the first pi turn of an old
conversation rebuilds context from the text history with the larger cap, and a rewind onto a pre-pi row does the same.

The retired runner's state goes through `retirementGate()` (DB backup first, files quarantined, never deleted): the
`claude_oauth_token` app_config key (the old `claude setup-token` login) and the skill-discovery cache key are deleted
and reserved forever, and `<dataDir>/agent-sessions` (the CLI transcripts) is moved to
`<dataDir>/retired/<stamp>/agent-sessions` by a boot step that stamps `retired:agent_sessions` after a clean pass.
`config.agentSessionsDir` survives only as the path that step reads.

## Presentation

- Korean labels for
  pi built-ins (`LS` 폴더 보기, `McpSearch` 도구 찾기, `PresentFile`, `RequestAdmin`), `mcp__skills__read`, pi
  `mcp__git_repo__commit`, hex-ssh tools and relayed `mcp__plugins|shared__<server>__<tool>` names
  (`sdkToolLabel`, which the client `humanTool` now shares); the admin 시스템 panel shows `pi-gateway`.

## Verify

- `tests/pi-workspace.test.ts` — path mapping, D3 move, cascades, skill sync + `mcp__skills__read`, the repo-copy
  round trip against a local bare remote (incl. a colleague's copy and a moved-base refusal), deck state, catalog.
- `tests/pi-mcp-proxies.test.ts` — the relay plan (secret routing, skips, redaction set), the pool against a real
  stdio fixture (lazy start, names, no leaked process), hex-ssh's allowlist through the real policy proxy, a run
  through the endpoint (shared server via the real bridge, plugin server, redaction incl. a browser secret), async
  ask_avatar as a follow-up turn, the never-waiting canvas, labels.
- `tests/pi-tool-discovery.test.ts` — the known-tools list (only this run's tools, deterministic, relays), the query line,
  describe_system's callable line, compact descriptions (hash-bound, safety rules kept), broker descriptions, unknown
  argument names refused at the endpoint. 
- `tests/pi-runner.test.ts` — runner against a scripted fake client (frozen prompt, continuation, model switch,
  rewind, 404 heal, question, steers, fallback, the endpoint as the broker sees it), `piRunPrincipal`, config,
  the `/mcp` mount, the script's server list.
- `PI_E2E_LIVE=1 PI_E2E_DIR=~/.noah-work/pi-e2e npx vitest run tests/pi-gateway-live.test.ts` — includes
  `runPiAgent` against the real e2e gateway.
- Harness: `~/.noah-work/pi-e2e/noah-harness` (`pi.env` uses the env names above), `AGENT_RUNTIME=pi ./start-noah.sh`.
