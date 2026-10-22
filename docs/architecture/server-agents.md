# Server agents (서버 에이전트)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The owner's registered SSH servers the avatar DELEGATES work to: the Claude Code CLI runs ON the server
> (SDK `spawnClaudeCodeProcess` over an ssh2 exec channel) while every callback stays in Noah. Registry,
> host trust, install, the remote run, the delegate tools and their gating, both metacognition surfaces,
> the settings card, cascades and operations.

## What it is
- **Owner-only delegation to servers, not a shell.** The avatar calls `mcp__server_agents__delegate` with
  `[{server, task}]`; each task becomes ONE slim SDK run whose CLI process lives on that server (cwd = the
  server's workdir, the server account's permissions). Several servers run in PARALLEL; within a
  conversation each server's remote session is resumed, so follow-ups continue where it left off.
- **No daemon, no port, no root on the server.** SSH auth is the agent's auth. Noah copies its OWN pinned CLI
  binary there (the SDK↔CLI control protocol must match exactly), on first use and after every SDK bump.
- **Everything that decides stays in Noah**: the PreToolUse tier gate, the deny-all confirmer, PostToolUse
  redaction, progress events and audit travel over the CLI's stdio control protocol (P0-verified: a deny in
  Noah's hook blocks a remote Bash; in-process MCP tools execute in Noah).
- **Coexists with hex-ssh** (user decision 2026-10-22): one-off reads stay on `mcp__hex-ssh__*`; multi-step
  server work goes to a server agent. hex-ssh is upstream-retired; revisit after this stabilises.
- Design history, decisions D1–D10 and the P0 spikes: `~/.noah-work/ssh-remote-agent-2026-10-21/`
  (`DESIGN.md`, `p0/`, `e2e/`) on the dev box.

## Admin switch (user decision 2026-10-22)
- **OFF by default; a system admin must enable it knowingly.** A check or delegation hands the deployment's
  model credentials (`ANTHROPIC_API_KEY` / the admin subscription token, per `serverAgentBaseEnv`) to the CLI
  on the registrant's own server, where that account can read them. The env-forwarding design stays; the
  switch is the consent point. `app_config.server_agents_enabled` (`isServerAgentsEnabled` /
  `setServerAgentsEnabled`, "on" = enabled — existing deployments start disabled);
  `PUT /api/admin/server-agents {enabled, acknowledged?}` — enabling REQUIRES `acknowledged: true` (400
  otherwise), audited `set_server_agents_enabled` (`server agents = on|off`); `GET /api/admin/system` reports
  `serverAgentsEnabled`. The 관리자 → 시스템 card turns it ON only through a confirm step showing the warning.
- **Enforced** where credentials would leave: runPlan's FIRST unavailable reason `admin_disabled` (no tools,
  both metacognition surfaces say the admin has not enabled it), `POST /api/me/server-agents/:id/check` → 409
  `관리자가 서버 에이전트 기능을 켜지 않았습니다.`, and defensively `checkServerAgent` / `runServerAgentTask`
  (`ADMIN_DISABLED`, not persisted as install state). Registration CRUD, host-key inspect, trust-host and remote
  cleanup stay allowed (no credentials involved). `GET /api/me/server-agents` carries `adminEnabled`; the
  settings card shows a banner and its 점검 explains instead of calling (and skips the automatic first check).

## Data model (`store/serverAgents.ts`, DDL in `store/internal.ts`)
- `server_agents` — per owner, `UNIQUE(owner_user_id, name)`, cap `MAX_SERVER_AGENTS` (30). `access` is
  `read|exec|full` (an unknown stored value reads as `read`); `install_state` is a JSON
  `ServerAgentInstallState` (`ok`, `version`, `error` code, `detail`, `checkedAt`) or NULL.
  A change to host/port/username/workdir clears `install_state` AND that server's session rows. A check/run
  writes its install state and session mapping CONDITIONALLY on the target columns it started with
  (`setServerAgentInstallState`/`setServerAgentSession` with a `target`): a verdict about the OLD server
  never lands on a re-pointed row, and a run that outlived a delete leaves no orphan session row.
- `app_config.server_agent_deployment_id` — a random id minted once (`serverAgentDeploymentId`), written
  into every remote pid file so the sweep never touches another deployment's runs on a shared account
  (unreadable after a `SESSION_SECRET` rotation → a new id; the old files age out by their deadline).
- `server_agent_sessions` — `(conversation_id, server_agent_id) → remote_session_id, cli_version`.
- No FKs; cascades are manual and already wired: **every conversation-deleting path calls
  `deleteServerAgentSessionsForConversation` next to `deleteShareLinksForConversation`** (deleteConversation,
  deleteChatConversations, deleteUser loop, deleteGroupAgent, deleteGroup, purgeRetiredPersonalAgents);
  `applyConversationRewind` clears the conversation's mappings (the kept history no longer matches what a
  remote session saw — the remote side effects stay, like every rewind); `deleteUser` →
  `deleteServerAgentsForOwner`. **A new conversation-deleting path must add the same call.**
- Wire types, limits, validator and the KO/EN error tables live in the import-free
  `src/shared/serverAgents.ts` (client + server).

## Access tiers (tool-level; the server's OS account is the final boundary)
| Tier | Built-in tools | Note |
|---|---|---|
| `read` 조회 | Read, Glob, Grep | NO Bash — a read-only shell cannot be enforced |
| `exec` 명령 실행 | + Bash | no edit tools, but Bash CAN still change files |
| `full` 전체 | + Edit, Write, NotebookEdit | |
- Enforced twice: SDK `tools` = the tier set (the built-ins the CLI even offers) and the runner's PreToolUse
  gate `buildServerAgentGate` (allow the tier's tools, deny everything else with an English reason naming the
  tier, `onBlocked` row on the card). **No `allowedTools`** — its bare entries auto-approve ahead of the hook
  and confirmer (the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), so the gate is the only approver.
  `canUseTool` = `buildCanUseToolSafetyNet` with an empty ledger (denies every CLI-side ask).
- **Unattended runs (routine, external task API) use the tier AS-IS** (user decision D6, an accepted
  prompt-injection risk on API bodies): the remote append says an `api` instruction may come from external
  text, and the audit row carries `runKind`.

## Transport (`serverAgents/connection.ts`, `remoteProcess.ts`)
- ssh2 `Client` (pure JS; `cpu-features` optional). Key = vault `SSH_PRIVATE_KEY` + optional
  `SSH_PASSPHRASE` (actually used, unlike hex-ssh). Keepalive 15 s × 3 (a silent partition surfaces in
  ~45 s), handshake 15 s.
- **Host verification is fail-closed against the owner's known_hosts** (`sshTrust.knownHostsPath`, re-read
  per connection): `knownHostKeyStatus` → `trusted` passes; `unknown` → `HOST_NOT_TRUSTED`, a different key
  → `HOST_KEY_MISMATCH`. `serverHostKey` algorithms are limited to the TRUSTED key types so a server offering
  several types cannot produce a false mismatch.
- **Login-shell independence.** sshd hands every exec command to the account's LOGIN shell (bash, tcsh,
  fish, …), so the login shell only ever sees two CONSTANT one-line commands with no `!` (csh history
  expansion) and no newline inside quotes (csh rejects it): every short script (`execText`: probe, verify,
  prune, kill, sweep, cleanup) runs as `sh -c 'eval "$(cat)"'` with the script on stdin
  (`REMOTE_SCRIPT_RUNNER`, read to EOF first so a command in it that reads stdin cannot eat the rest);
  `execText(cmd, {stdin})` runs `cmd` verbatim and is for already shell-neutral commands only. Verified on
  bash, tcsh and fish accounts against a real sshd.
- **Remote run**: the exec command is the constant `REMOTE_RUN_WRAPPER`
  (`sh -c 'IFS= read -r e || exit 97; eval "$(printf %s "$e" | base64 -d)"'`); stdin line 1 carries,
  base64-encoded, the env exports (secrets never in argv / `AcceptEnv`) AND the run script: mkdir config/run
  dirs → `cd <workdir> || exit 98` → write `~/.noah-agent/run/<runId>.pid` = `<pid> <deadline> <deploymentId>
  <instanceId>` (deadline = REMOTE epoch secs after lifetime + kill-after + 30 s; instance = a random id per
  Noah PROCESS, `serverAgentInstanceId`) → `exec timeout --signal=TERM
  --kill-after=10 <lifetime> ~/.noah-agent/bin/claude-<ver> <args>`. The rest of stdin stays the CLI's.
- **Env allowlist** (`isForwardableRemoteEnv`): Anthropic auth/base-URL/model vars
  (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_CUSTOM_HEADERS`,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `MAX_THINKING_TOKENS`), `CLAUDE_CODE_OAUTH_TOKEN`, the SDK markers. Never
  proxies, `NODE_OPTIONS`, `NOAH_*`, shell-exposed vault secrets. Always added: `CLAUDE_CONFIG_DIR="$HOME/.claude-noah"`
  (never `~/.claude`) and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (a backgrounded Bash ends the turn early
  and bypasses permission callbacks). The base env is `serverAgentBaseEnv` (same auth precedence as runPlan:
  `.env` `ANTHROPIC_API_KEY` > admin subscription token).
- **Exit codes**: 97 env line missing, 98 workdir, 255 transport (a channel that closes without the CLI's exit
  status is a FAILURE, never a silent success). `kill()`/abort runs the kill script: it collects the run's
  descendants, TERMs the pid file's process group AND those descendants (the CLI's Bash commands sit in
  their OWN groups; an sshd `signal` does not reach `timeout` when the login shell did not exec), waits
  ~3 s, KILLs surviving descendants, and drops the pid file. **The kill travels over the run's own
  connection**, and an abort makes the SDK kill + the consumer's for-await throw in the same tick, so the
  spawner exposes `settled()` (every process exited, kill script + pid cleanup done) and the runner and the
  check's ping `waitRemoteSettled` (≤12 s) BEFORE `conn.end()`.
- **Leftovers**: a FIN-less partition leaves the remote CLI running (P0-verified). Bounded by `timeout`
  (task timeout + 120 s) and swept on every next connection. Remote state is per ACCOUNT while Noah's
  ledger is per process (two rows, two owners or two deployments can share one account), so
  `sweepStaleRemoteRuns` sweeps a pid file only when it is past its deadline, OR this deployment's AND this
  process instance's and not live anywhere in this PROCESS (`allActiveServerAgentRunIds` — never just the
  connecting row's), OR a deadline-less legacy file older than 40 min. The deployment id is per DATABASE but
  the live ledger is per process, so another deployment's — or another process instance's on the same DB (a
  rolling-deploy overlap, replicas) — unexpired run is never touched. A swept
  run gets its group TERMed and, after a grace, its descendants KILLed (only while the pid still runs a
  `.noah-agent/bin/claude-` command line — a recycled pid is never signalled).

## Install (`serverAgents/installer.ts`)
- Remote layout under the account's `$HOME`: `.noah-agent/bin/claude-<ver>` (240 MB, the platform package
  binary of THIS Noah build), `.noah-agent/ca.pem` (0600, when Noah has a corporate CA:
  `NODE_EXTRA_CA_CERTS` file, else the image's `extra-proxy-ca.crt`; the remote run gets
  `NODE_EXTRA_CA_CERTS="$HOME/.noah-agent/ca.pem"`), `.noah-agent/run/*.pid`, `.claude-noah/` (transcripts).
- `prepareServer`: one probe (x86_64, sh/base64/timeout/sha256sum, writable + exec-capable home, ≥600 MB free
  only when an upload is needed) → sha compare → upload to a unique `.tmp` → remote sha check → `mv -f` →
  `--version` smoke (failure = `UNSUPPORTED_ARCH`) → prune to current + newest previous (never a NEWER
  version: another Noah deployment may share the account; stale `.tmp` > 1 h removed) → CA. A binary that fails
  its smoke is DELETED (its matching sha would otherwise skip both the upload and the smoke next time).
- `localCliInfo()` returns the version immediately; the 240 MB sha256 is computed ONCE in the background
  (`localCliSha256()` single-flight) so no request path blocks the event loop.
- `checkServerAgent` (settings card + `check_server`): egress → vault → connect → sweep → prepare → workdir →
  1-turn model ping (`tools: []`, `persistSession: false`) → persist the install state (conditional on the
  target it checked). Classified failures never throw; holds a `check-<uuid>` run slot (a full server, or a
  row whose delete is in flight, returns `BUSY` WITHOUT persisting).
  `classifyRemoteApiFailure` maps remote API text to `TLS_CA` / `MODEL_UNREACHABLE`.

## The remote run (`serverAgents/runner.ts` — `runServerAgentTask`)
- Deliberately NOT `runClaudeAgent`/`runPlan` (local plugin roots, skills, workspace and stdio MCP wrappers
  must never reach a remote CLI): no plugins/skills/mcpServers, `settingSources: []` (never `project` — a
  server-side `.claude/settings.json` could re-point `ANTHROPIC_BASE_URL` and exfiltrate the token),
  `strictMcpConfig`, `maxTurns` 40, preset system prompt + English append (server identity, role, owner
  notes, tier, "do only the delegated task, report what you did and every side effect, never print
  secrets", the `api` provenance line) with `snapshot: false`; dynamic sections kept (they describe the
  REMOTE machine).
- Model/effort = the delegating run's (`options.model` read per call, so a fallback switch is followed).
- Slots (`limits.ts`): per server 2 (~250 MB each there), per owner 4, process 8 → refusal = `busy`; a row
  whose DELETE is in flight (`markServerAgentDeleting`) refuses every slot.
- **One delegation per (conversation, server)** (`tryLockServerAgentSession`, taken before the slot): two
  parallel delegates — parallel tool calls, or main + a subagent — would `--resume` ONE remote session and
  write its transcript concurrently, so the second gets an immediate `busy` with an English explanation.
- Session: `resume` the stored id unless `fresh`; a missing remote session (CLI version change, cleaned
  home) retries ONCE fresh; the id is stored even after a timeout/abort so the next delegate continues.
- Outcomes `succeeded|failed|timeout|aborted|busy`, text capped at 8 000 chars (capped WHILE accumulating —
  a chatty remote cannot grow Noah's memory); failures carry the EN table text (+ a ≤300-char stderr tail for
  unclassified/transport failures). Text AND error are redacted (`serverAgentRedactions`: the forwarded auth
  env plus `ANTHROPIC_CUSTOM_HEADERS` — whole value and each header value) before they reach the model; the
  remote PostToolUse hook redacts the same set. **Redaction always runs BEFORE any cut** (a secret straddling
  a cut would leak its prefix): streamed text accumulates up to the cap + two secret lengths of headroom,
  `scrubThenCap` scrubs the whole buffer, drops a possibly-partial secret at a hard accumulation cut, then
  caps; failure details are scrubbed before `classifiedError`/the install state truncate them to 300 chars;
  a stderr tail trimmed at its start drops that edge after scrubbing.
- Audit `server_agent_delegate`: `{server, access, runKind, status, durationMs, costUsd, turns}` — never
  the task text.
- **Progress nesting**: a synthetic agent `server-agent:<runId>` (`onAgentStart`, `parentId` = the delegate
  call's tool_use id from `extra._meta["claudecode/toolUseId"]`, label `<name> · 서버 에이전트`); remote SDK
  messages are re-parented onto it and fed to the SAME `dispatchSdkMessage` through a wrapper that passes
  only activity-tree callbacks — remote deltas, session ids, model and results never reach the main run.
  **Every remote-originated id is namespaced** `<cardId>:<id>` (`remoteActivityId`: tool, task, agent and
  parent ids, the gate's blocked-row `toolUseId`), so nothing a remote emits — even a compromised binary
  copying a main-run tool id — can collide with, close or overwrite a main row; the card id is the only link
  to the delegate row (runner-owned rows use `#`, e.g. the install row `<cardId>#install`). On top, a parent
  id this run did not produce maps to the card (no rows under an agent the client never saw) and an end for
  an id it never started is dropped. The client treats ids as opaque strings.
  The client (`lib/chat.ts` `ensureAgent`) nests a card whose parent is a TOOL row under the agent that made
  that call, so cards render as siblings of the delegate row and the ≥2 fold rule applies. Upload shows an
  "에이전트 업데이트 중 (CLI <ver>)" task row.

## Tools and gating (`agent/serverAgentTools.ts`, `runPlan.ts`)
- `delegate {tasks:[{server, task, fresh?}], timeoutMinutes?}` (≤8 distinct servers, task ≤8 000 chars,
  timeout 10 default / 30 max; results marked UNTRUSTED server output inside `<server_output>`, whose tags
  are defanged inside the remote text). A call's tasks run through a local pool of
  `SERVER_AGENT_MAX_RUNS_PER_OWNER` (4): the rest wait, and ONE per-call deadline means the wait counts
  against their time limit (a task whose limit ran out while queued is reported NOT STARTED) so the call
  stays within the MCP ceiling; slots already held elsewhere (other conversations, routines, checks) still
  make a task come back busy immediately; the tool description states every limit. `list_servers`, `reset_session`,
  `check_server` (interactive owner chat ONLY: not headless, not `externalTaskApi`). `createSdkMcpServer`
  `timeout` = 35 min (in-process tool calls are otherwise unbounded — P0-verified with a 480 s call);
  `extra.signal` cancels the remote runs.
- Active when: the admin switch is on, `ssh` tool group on, owner run (interactive / owner routine / external task API), not a group
  agent or consultation, `SSH_PRIVATE_KEY` in the vault, egress not `domain-proxy`, ≥1 enabled server.
  Otherwise an `unavailable` reason (first match wins: `admin_disabled` > `egress_blocked` > `ssh_group_unavailable` (the admin
  tool policy removed the ssh group — worded policy-neutrally, but never as a conversation setting) >
  `no_servers` > `no_ssh_key` > `all_disabled` > `ssh_group_off`) rendered by
  `ownerState.serverAgentsUnavailableText` on BOTH surfaces. Registered in
  `mcpServers` and `allowedTools` from the same boolean. Colleague/trusted runs never get them (D10 — owner's
  key, owner's servers); their prompt carries one "owner-only" line, no server list.

## Metacognition
- `OwnerState.serverAgents` (stable registry facts). The prompt append lists servers (name, user@host, role,
  tier) + when to delegate vs hex-ssh, parallel use, confirm destructive work on exec/full servers before
  delegating in interactive chat, results untrusted, rewind does not undo remote effects, tier meanings.
  Live state (installed version vs local CLI, last check/error, sessions in this conversation, egress) rides
  ONLY `describe_system` and `list_servers` (prompt-cache rule). `describe_system`'s SSH line now reports
  runPlan's real `sshActive` and warns under egress.
- Manual topic `server-agents` (`mcp__system__read_manual`).

## REST + settings card (`routes/serverAgents.ts`, `SettingsServerAgents.svelte`)
- Session auth; owner = the logged-in user (their own avatar). `GET /api/me/server-agents` →
  `{servers: ServerAgentView[] (+hostTrusted), sshKeySet, egressBlocked, cliVersion}`; `POST` (201, the view
  unwrapped), `PATCH /:id`, `DELETE /:id?cleanupRemote=1` → `{ok, cleanup: skipped|done|failed, cleanupError?,
  cleanupReason?}` (remote cleanup failure never blocks the delete). The delete claims the row FIRST
  (`markServerAgentDeleting`: no run/check can start during the awaited cleanup). The cleanup is SKIPPED
  with a Korean `cleanupReason` — never forced — when another row of this deployment (any owner) targets
  the same host:port:username, or a pid file in the account's run dir is still live/unexpired after the
  sweep (`cleanupServerRemote` → `{status: "skipped", reason: shared_account|active_runs}`), `POST /:id/host-key` → `{fingerprint, keyType, trusted,
  mismatch}` (502 when unreachable), `POST /:id/trust-host {fingerprint}` → `{server, fingerprint, keyType,
  changed}` — **TOCTOU-safe**: re-fetches and refuses (409) if the key changed since it was shown
  (`trustHostWithFingerprint`; the old `addTrustedHost` has no such check), `POST /:id/check` → install state.
- 409s: duplicate name, cap, check while the admin switch is off, concurrent check of the same server, delete while a delegation/check runs, a second delete of the same row,
  fingerprint changed, egress blocked (host-key/trust-host never dial under `domain-proxy`). An unexpected
  check exception persists a generic `UNKNOWN` (the raw message only goes to the log).
- Audit: `server_agent_create|update|delete` (`<name> <user>@<host>:<port> <tier>`, delete adds
  `cleanup=`), `server_agent_trust_host` (`<name> <token> <fingerprint>`, a mismatch attempt is an error row),
  `server_agent_check` (`<name> ok= code= version=`). Never secrets or notes.
- The card sits right under the 시크릿 card (the SSH key it depends on); banners for egress / no SSH key
  (read live from `user.secretNames`); register → fingerprint shown → "이 지문을 신뢰" → first check runs
  automatically; 점검 on an untrusted host opens the trust step first (the prerequisite is the first step).

## Operations
- **First check uploads 240 MB over SFTP** and can exceed a minute: a reverse proxy with a 60 s read timeout
  answers 504 while the check still completes server-side (reload the list to see it). Async check is P2.
- Egress `domain-proxy` deployments: no SSH at all (squid allows only CONNECT 80/443) — the feature reports
  `EGRESS_BLOCKED` everywhere instead of registering tools.
- Remote transcripts accumulate in `~/.claude-noah` (the CLI's own cleanup period applies); deleting a
  conversation does not delete them (P2).
- Bastion/ProxyJump, a pre-deploy push at boot, server `CLAUDE.md` import, noexec install dirs, per-server
  proxy/CA, async delegate and avatar-side registration are P2 (DESIGN §15).
- ssh2's own `utils.generateKeyPairSync("ed25519")` emits a key its parser rejects ~0.4% of the time
  (tests regenerate until it round-trips); keys from `ssh-keygen` and from Noah's python-cryptography
  generator parse fine.
