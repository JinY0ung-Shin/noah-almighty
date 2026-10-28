# pi-gateway runtime (`AGENT_RUNTIME=pi`)

Noah as a BFF over a dedicated pi-gateway instance (design: `~/.noah-work/pi-migration-2026-10-29/design.md`).
The agent loop runs in pi (`POST /v1/responses`, service key + `user`); files and commands run in the
viewer's own pi sandbox; Noah's in-process MCP tools are served to pi's broker over HTTP with a per-run token.
The SDK runner stays the default and the fallback; no pi-gateway code is changed — everything pi lacks is a
Noah-side degrade, stated on BOTH metacognition surfaces.

## Which runs go to pi

`runAgentStream` (`agent/index.ts`) → `piRuntimeSupports(request)` (`agent/pi/piRuntime.ts`, unit-pinned):

| Run class | Runtime | Why |
|---|---|---|
| owner chat, owner routine, task-API turn | pi | |
| trusted (group) colleague chat | pi, principal = the colleague (U4) | |
| untrusted colleague, avatar consultation, intro/hashtag generators | **SDK** (one log line with the reason) | must stay read-only; pi has no per-request tool allowlist (P1) |
| any run without a conversation | SDK | prompt + sessions are per conversation |

The sandbox principal is `viewerUserId` (whoever the run executes AS). describe_system's runtime line says
`claude (this read-only run stays on the Claude Agent SDK runner …)` for a fallback run.

## One run (`agent/pi/runPiAgent.ts`)

1. **Capabilities** — `buildRunCapabilities(…, { runtime: "pi", piConversationDir })` (`agent/runCapabilities.ts`),
   the SAME plan the SDK runner wraps into its options bag. `runtime: "pi"` withholds what only exists as a CLI
   subprocess today (hex-ssh → `sshActive=false`, 공용 MCP → `sharedMcpPlan=null`, plugin `.mcp.json` servers are
   never lifted) and stamps `PiRuntimeFacts` onto describe_system's ctx and (via `stampPromptRequest`) the prompt.
2. **Run token** — `McpRunRegistry.register` with EVERY name in `PI_MCP_SERVER_NAMES` (`agent/pi/mcpCatalog.ts`):
   built servers serve calls, unbuilt ones are tool-less stubs. Gates: `listTools` answers `tools/list` from the
   static catalog (all tools of every server, widest form — built once per process from inert contexts), and
   `allowCall` admits only this run's `mcpAllowedTools`; a refusal names `mcp__system__describe_system` and forbids
   workarounds. Why static: pi lists a session's MCP tools ONCE at session build and keeps them while later turns
   (each with its own token and capabilities) reuse the session. Handlers still self-gate. The token rides the
   `x-noah-run-token` request header; revoked in `finally` (in-flight handlers abort).
3. **Prompt (D2)** — `buildSystemPromptAppend` with `piRuntime` set, rendered at the conversation's FIRST pi turn and
   frozen in `conversations.pi_instructions` (`ensureConversationPiInstructions`, write-once like `todo_snapshot`);
   sent as `instructions` only when a session starts, and re-sent verbatim for every later session (model switch,
   lost session). Per-turn facts ride the user input instead (`buildPiTurnPreamble`): the KST date/time line, a
   rewind's provenance, an external-task turn's provenance paragraph, and a new session's reason. The pi variant
   adds `piRuntimeSection` (sandbox, work folder, built-in tools, `mcp_call`/`mcp_search`, what is missing, "these
   instructions were fixed at conversation start — check describe_system").
4. **Input** — preamble + `buildUserPrompt` (history only on a fresh session, cap `PI_FIRST_TURN_HISTORY_LIMITS`
   120 msgs / 60k chars instead of 24 / 12k) + image blocks as `input_image` data URLs. Attachment files are staged
   by the route straight into `/workspace/c/<seg>/attachments/` and listed by sandbox path (`stagePiAttachmentFiles`
   maps host → sandbox; it copies only a file staged elsewhere). Skills are synced first (see "Skills").
5. **Session** — `previous_response_id` = `resumeSessionAt ?? resumeSessionId` when it is a `resp_…` id; anything
   else (an SDK session id from before the switch) means a new session from the text history. An image turn
   (the route resets resume for the SDK) continues the stored session unless it is a rewind. Every committed turn
   reports its response id via `onSessionId` AND `onResumePoint({sessionId: id, uuid: id})`, so the chat route
   persists it as `agent_session_id` and stamps it on the assistant row; a rewind onto that row forks from it
   (pi branches on an older `previous_response_id`; no fork flag).
6. **Errors** — 404/409 on a continued session → once, a new session from history (status-free, the model is told
   in the preamble). 503/429 at stream open → `withPiRetry` backoff (status line `pi-gateway가 바빠서…`). A model
   fallback chain (routines, task API: `modelFallback`) gives each attempt a fresh session.

## S1 degrades (pi changes P1–P6 are out of scope)

| Gap | Noah-side behavior | Surfaces |
|---|---|---|
| no mid-turn input (P2) | steers queue; when the pi response completes ALL undelivered ones go as ONE follow-up turn on the same run (`onTurnResult({steerPending:true})` → the route's `turn_end` row, then `delivered`/`completed`) | prompt mid-turn line + describe_system say "arrives as the NEXT turn, after your current answer" |
| model/effort fixed per session (P3) | per-session profile `model\|effort` in `conversations.pi_session_profiles` (JSON map keyed by the session part of `resp_<session>_<n>`, newest 32); a mismatch starts a new session from history, status line `모델 또는 사고 강도가 바뀌어 새 세션에서 이전 대화 기록으로 이어갑니다…` | runtime line + `Session note` in the turn input |
| no sandbox secrets (P4) | shell-exposed secrets are NOT exported; owner runs still go to pi | secrets section + describe_system's shell-secret line say UNAVAILABLE with the names |
| context window (P5) | from `PI_MODEL_MAP[tier].contextWindow`; no compaction chip | — |
| subagents (P6) | flat: pi's `Agent` is one card | — |
| no per-session cwd (P1) | the model is told to work in `/workspace/c/<seg>/` with absolute paths (prompt + describe_system + refusal redirects); Noah creates the folder 0700 | both |
| no WebSearch, no hex-ssh / plugin / 공용 MCP on pi | not registered; stated | both |
| date fixed at session creation | KST date/time line prepended to every input | turn input |

## Files: the sandbox conversation folder (`agent/pi/piWorkspace.ts`)

The chat route and the scheduler decide BEFORE building the request whether the turn runs on pi
(`piRunWorkspace` — the same `piRuntimeSupports` decision `runAgentStream` makes) and then use
`preparePiRunWorkspace`: the turn's workspace dir IS the host view of `/workspace/c/<conv-seg>/`
(`<PI_WORKSPACES_DIR>/u-<sha256(viewer)[:24]>/c/<seg>`, 0700). So every server-written copy lands there with no
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
  complete on both runtimes; like the SDK scratch, the agent's own files in the folder stay. Rewind's dropped-attachment
  cleanup works unchanged (its workspace dir is the sandbox folder). Account deletion removes the user's whole
  `u-<key>` workspace and Noah's repo-copy records (`routes/admin.ts`).

## Skills (`agent/pi/piSkills.ts`, `agent/skillsTools.ts`)

pi does not load Claude Code plugin roots. Each pi turn `materializePiSkills` syncs the run's `pluginRoots` into
`/workspace/.noah/skills/<root>/<skill>/` (`<root>` = `default`, `knowledge`, `group-<plugin name>`, `plugin-<plugin name>`) and
returns the index the prompt (`piSkillsSection`, frozen with the instructions — a skill added later loads from the
next conversation) and describe_system (`piRunLines`, live) both state (`PiRuntimeFacts.skills`).

- **Owner runs** (chat, routine, task API) copy every root. A **trusted colleague** runs in their OWN sandbox: only
  the bundled default-skills are copied there; the owner's personal/plugin/group skills are listed `via: "mcp"` and
  read through `mcp__skills__read` (`skills` server — registered only on such runs; files never land in the
  colleague's sandbox; links and paths out of the skill are refused).
- **Admin skill policy** by omission: a disabled skill (bare name or `<plugin>:<name>`) is not copied, listed or readable.
- **Rewrites** in copied `.md` files: `${CLAUDE_SKILL_DIR}` → the skill's sandbox path; `timeout: 600000` (Claude
  Code ms) → `timeout: 600` (pi seconds, max 86 400). Served skills read `${CLAUDE_SKILL_DIR}` as `skill:<root>/<dir>`.
- **Re-sync** is a stat-only fingerprint (path, size, mtime) of the source root AND of what was written, kept in
  `.noah/skills/.noah-sync.json`; a root is rewritten only when either side changed (so an edit in the sandbox copy
  heals). Noah owns `.noah/skills` wholesale (stale roots removed), never anything outside it. `__pycache__`,
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

## The `/mcp` endpoint (`mcpHttp/endpoint.ts`)

Mounted by `createApp` at `/mcp/:server` on every runtime (no token exists without a pi run → always 401). Its only
auth is the bearer run token; session cookies and other app auth never apply (`tests/pi-runner.test.ts` pins that a
signed-in cookie alone gets 401). The registry lives per Store (`piServicesFor`), shared by the router and runner.

## Operator setup (our dedicated instance, D5)

```bash
PI_GATEWAY_ADMIN_KEY=… node scripts/pi-register-mcp.mjs --gateway http://pi-gateway:8080 \
  --noah-url http://<host-as-seen-from-the-broker>:48787 --configure-instance   # idempotent; --dry-run / --remove
```

- Registers one broker entry per `PI_MCP_SERVER_NAMES` name (ids = Noah server names, so pi's `mcp__<id>__<tool>`
  equals every `mcp__repo__commit`-style name in prompts/skills/manual), header
  `Authorization: Bearer {{ctx.header:x-noah-run-token}}`, `timeoutSec` 600 (pi's cap). Refuses to take over an id
  pointing elsewhere without `--force`. The admin key is read from the environment only and never stored by Noah.
- `--configure-instance` also disables pi's `request_admin` and `present_file` built-ins (Noah has its own) and deploys
  `scripts/pi-system-prompt.md` as the live prompt `noah` (pi's default hardcodes "Reply in Korean" and request_admin;
  pi enforces no placeholder, the template keeps `{{WORKSPACE}}`, `{{LANGUAGE}}`, `{{DATETIME}}`).
- Other instance config stays in pi's own admin/`.env`: LLM servers, `SANDBOX_IMAGE` (`docker/pi-sandbox` for decks →
  set `PI_DECK_SANDBOX=true` here), `SANDBOX_EGRESS_ALLOW`, turn concurrency limits.

## Env (config.ts → `AppConfig.pi`)

`AGENT_RUNTIME=pi`, `PI_GATEWAY_URL` + `PI_GATEWAY_API_KEY` (required; the key is in `SERVER_ONLY_SECRET_ENV_NAMES`),
`PI_WORKSPACES_DIR`, `NOAH_MCP_PUBLIC_URL`, `PI_MODEL_MAP` (validated JSON; malformed stops the boot), `PI_DECK_SANDBOX`.

## Existing deployments

New nullable columns `conversations.pi_instructions` / `pi_session_profiles` (NULL = no pi turn yet). Old SDK session
ids and resume points are IGNORED by the pi runner (not nulled — the SDK runner still uses them while both coexist);
the first pi turn of an old conversation rebuilds context from the text history with the larger cap.

## Seams left for later lanes

- **I2 (workspace/files/skills/repos):** done — see "Files", "Skills", "Working repositories", "Decks" above.
- **I3 (proxies/async/presentation):** hex-ssh, plugin `.mcp.json` and 공용 MCP servers are absent on pi
  (`sshActive=false`, `sharedMcpPlan=null` under `runtime: "pi"`); re-export them on the run endpoint (register
  stable names, add them to `PI_MCP_SERVER_NAMES` + the script) and lift those two lines. No `transformResult`
  redaction is wired yet. `ask_avatar`/canvas still block synchronously (broker timeout 600 s).

## Verify

- `tests/pi-workspace.test.ts` — path mapping, D3 move, cascades, skill sync + `mcp__skills__read`, the repo-copy
  round trip against a local bare remote (incl. a colleague's copy and a moved-base refusal), deck state, catalog.
- `tests/pi-runner.test.ts` — runner against a scripted fake client (frozen prompt, continuation, model switch,
  rewind, 404 heal, question, steers, fallback, the endpoint as the broker sees it), `piRuntimeSupports`, config,
  the `/mcp` mount, the script's server list.
- `PI_E2E_LIVE=1 PI_E2E_DIR=~/.noah-work/pi-e2e npx vitest run tests/pi-gateway-live.test.ts` — includes
  `runPiAgent` against the real e2e gateway.
- Harness: `~/.noah-work/pi-e2e/noah-harness` (`pi.env` uses the env names above), `AGENT_RUNTIME=pi ./start-noah.sh`.
