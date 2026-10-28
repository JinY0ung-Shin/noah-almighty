# Craft apps (admin-only beta)

ArtCraft's desktop-class editors — PhotoCraft now; VectorCraft, DesignCraft and FigCraft are
defined but served only once the runner registers them (P2) — driven **headless** through their
own MCP servers. The binaries never run in the Noah container: a separate `craft-runner`
container with **no network interface** (`network_mode: none`, read-only rootfs, reduced caps)
runs each app as a per-session uid. Noah and the runner share exactly one volume,
`craft-exchange`, and talk over two unix sockets on it.

Scope (user decision 2026-10-28): **a system admin's interactive chat with their own avatar
only** — never routines, external task API turns, group agents, consultations or a colleague's
chat. Tool groups per app, **off by default**.

> **"Admin-only" is a PRODUCT-EXPOSURE gate, not a security boundary against other users'
> agents.** Every agent Bash in the Noah container — every user's, admin or not — runs as Noah's
> own uid 1000. That uid owns the exchange volume and its sockets, can read every session's
> `inbox/`/`outbox/` and the one-shot relay handoff files, and can read Noah's own process
> environment (`/proc/<pid>/environ`, which holds `CRAFT_CONTROL_SECRET`). This is the
> PRE-EXISTING same-uid posture (`secrets-ssh.md`), kept by user decision 2026-10-28; what the
> handshakes below add and what remains is under [Security posture](#security-posture).
> Separating the agent's Bash uid is tracked in issue
> [#71](https://github.com/JinY0ung-Shin/noah-almighty/issues/71).

Source map: `src/shared/craftApps.ts` (the app list), `src/server/craftRunner.ts` (control
client, health memo, purge), `src/server/craftExchange.ts` (file mirroring),
`src/server/agent/craftTools.ts` (gate, session lifecycle, stage tool, result tracker),
`scripts/craft-mcp-relay.mjs` (stdio ↔ socket relay), `default-skills/skills/craft-apps/`
(the avatar's workflow). The runner itself lives in `craft-runner/` (its own README).

## Exchange layout

| Path (Noah: `CRAFT_EXCHANGE_DIR`, runner: `/exchange`) | Owner / mode | Written by |
|---|---|---|
| `sock/control.sock`, `sock/mcp.sock` | 1000, 0600 (dir 0700) | runner |
| `inbox/<sid>/` | 1000, 0700 | **Noah** — authoritative input tree |
| `work/<sid>/in/`, `work/<sid>/out/` | session uid, 0700 | runner (`sync_in`) / the app (`out/`) |
| `outbox/<sid>/` | 1000, 0700 | runner (`sync_out`) |

- `sid` = first 32 hex of `sha256("noah-craft:" + conversationId)` (`craftSessionId`). ONE
  session per conversation, shared by every app of that conversation, kept across turns.
- The app's read root is `work/<sid>` (so `in/` AND `out/`), its write root `work/<sid>/out`.
  The avatar is told these as `/exchange/work/<sid>/in|out` — the paths the APP sees.

## Protocols

Both sockets open with a MUTUAL challenge/response (spec Addendum A1/A2): the runner speaks
first, each side proves knowledge of the shared key with an HMAC over the OTHER side's fresh
nonce, and neither the control secret nor a run token ever crosses a socket. All MACs are
`HMAC-SHA256` keyed by the UTF-8 bytes of the key, hex, compared in constant time; nonces are 16
random bytes as 32 lowercase hex.

**Control** (`sock/control.sock`, one request per connection, JSON lines):

1. runner → `{"op":"challenge","v":1,"nonce":R}`
2. Noah → `{"op":"hello","nonce":N,"mac":HMAC(secret, "noah-craft-control|client|" + R)}`
3. runner → `{"ok":true,"mac":HMAC(secret, "noah-craft-control|server|" + N)}` (or
   `{"ok":false,"error":"unauthorized"}` + close). Noah verifies this MAC BEFORE it sends any request.

Then `{id, op, …}` → the reply echoing `id`. Ops: `health`, `open {sid}`, `sync_in {sid}`,
`grant {sid, token}`, `revoke {token}`, `revoke_all {}`, `sync_out {sid}`, `purge {sid}`.
`craftControlRequest` maps a connect failure/timeout to `CraftRunnerError("unreachable")`, an
`ok:false` to a request to `"rejected"` (the runner's English text is the message), and every
handshake failure — a missing/invalid challenge, the runner refusing Noah's MAC, or a peer whose
MAC does not verify — to `"unauthenticated"` (a run treats it as a failed session, never as the
tolerated `rejected` of a capped `sync_in`). A refusal over the exchange budget carries the runner's
verdict, `{ok:false, error, budget:{over:"exchange"|"session", …}}`, kept as `CraftRunnerError.budget`
(`parseCraftBudget`); `health` reports `exchange:{bytes, maxBytes}` (`CraftRunnerHealth.exchange`), and
`grant` of a sid that is not open answers `no such session — open it first`. 5 s default timeout;
60 s for `grant`, the syncs, `revoke_all` and `purge`; 10 s for a release's `revoke` and its
fallback `sync_out`.

**MCP** (`sock/mcp.sock`), per relay:

1. runner → `{"op":"challenge","v":1,"nonce":R}`
2. relay → `{"op":"attach","app":A,"tokenId":sha256_hex(token),"nonce":N,"mac":HMAC(token, "noah-craft-mcp|client|" + R + "|" + A)}`
3. runner (looks the session up by `tokenId`) → `{"ok":true,"mac":HMAC(token, "noah-craft-mcp|server|" + N)}`

The relay buffers every CLI byte until it has verified step 3 (15 s handshake budget), then the
stream is raw newline-delimited JSON-RPC to that session's app process. The runner answers
`initialize`/`tools/list` from its boot manifest, spawns the app on the first `tools/call`,
enforces deny lists, clamps and byte budgets, and runs `sync_out` after each call.

## The gate — registration IS the gate

The relay servers are byte pipes: they cannot self-gate per call, and the PreToolUse hook
auto-allows every `mcp__*` call. So the run either registers an app's relay or it does not.
`planCraftApps` (pure, unit-pinned in `tests/agent-craft-apps.test.ts`) decides per app, in
order, the first failing reason:

`not_configured` (exchange env unset) → `admin_disabled` (`craft_apps_enabled`) → `not_admin`
(`store.isAdmin(owner)`) → `run_kind` (not an interactive own-avatar chat: headless,
`externalTaskApi`, group agent, consultation, viewer ≠ owner, or no `events.onCraftPreview` —
the chat route supplies it only on `shareLinkTurn` turns) → `no_vision` (previews are images)
→ `no_workspace` → `group_unavailable` (admin group tool policy) → `app_unavailable` / `app_failed`
(a reachable runner does not serve it / it failed the boot self-test) → `group_off` (not
selected in the composer) → `runner_unreachable`.

`prepareCraftRun` returns NO state (no metacognition at all) for non-owner-driven runs and for an
owner who is neither an admin nor has a Craft group selected — ordinary users' prompts never
mention the beta. A live `health` call is made only when some selected app passes every
runner-independent gate; otherwise the memoized probe supplies versions.

## Run lifecycle

1. **Plan** (`runPlan.ts`, before the system server is built): `prepareCraftRun` — `open`, ensure
   `inbox/<sid>/` (a real 0700 dir; a planted link is replaced), wait for the previous run's
   background final mirror (`craftFinalCollectSettled`, step 5), mirror the workspace inputs, `sync_in`,
   then one `collectOutputs` so earlier results are in `craft/out/`. Any failure → every app
   `session_failed`. The resulting `CraftRunState` object is what BOTH metacognition surfaces read.
   **Exchange budget** (Addendum B N2): when the fresh health probe's `exchange.bytes` exceeds its
   `maxBytes` (`craftExchangeOverBudget`), the inbox mirror and `sync_in` are SKIPPED and
   `state.storage.exchangeFull` is set — the session still opens (an existing one; results already
   in `craft/out/` stay deliverable), the stage tool refuses, and both surfaces say why. A runner
   refusal carrying a `budget` object (`CraftRunnerError.budget`) means the same: on `open` of a NEW
   session every app becomes `storage_full`; on `sync_in` it sets `exchangeFull`.
2. **Register**: one stdio relay per active app (`{type:"stdio", command: node, args:[relay, handoff]}`,
   server name = app id), plus the in-process `mcp__craft_files__stage`; `allowedTools` gets the
   server-level rule `mcp__<app>` (tool names come from the runner's manifest) and the stage tool.
   The handoff `{socket, token, app}` is a one-shot 0600 file in `runtime/mcp-secrets/`, written by
   `writeMcpHandoffFiles` before EVERY query attempt and removed at run end — the same contract as
   the HTTP bridge files. The token (64 hex, per RUN) is the only credential the relay holds.
3. **Grant LAST**: `session.grant()` is the plan's final await (refused without a call when the
   conversation is already gone; 60 s budget — the runner's grant
   waits on the session mutex and may first revoke an older token; it also waits for the boot
   `revoke_all` to settle, so that sweep can never kill a fresh token). A refused or timed-out
   grant unregisters the relays and the stage tool, drops their handoff files, rebuilds
   `share_file` without the Craft types, moves the Craft groups to `runKindBlocked`, flips the
   shared state to `session_failed` in place and emits a Korean status line — neither surface
   advertises what is gone.
4. **Loop** (`claudeAgent.ts`): `createCraftToolTracker` follows `tool_use` → `tool_result` for the
   active apps (main agent and subagents). Each completion is awaited in the loop:
   `craft_tool` audit (app, tool, command ids from `command_run.id` / `command_batch.steps[].id` —
   never params), `collectOutputs` (`sync_out` + outbox → `<workspace>/craft/out/`), then
   `events.onCraftPreview` with every image block (MIME sniffed from the bytes).
5. **Release** (the run loop's outer `finally`, every exit path): `revoke {token}` — ALWAYS, also
   when `grant` errored or timed out (the runner may have committed it before answering) — with a
   10 s budget (`CRAFT_RELEASE_TIMEOUT_MS`, Addendum B N3): it is the ONLY Craft step on the
   response path, so a slow or hung runner holds a finished turn ≤ 10 s, never minutes. The last
   output mirror (outbox → `craft/out/`) then runs in the BACKGROUND, after `runAgentStream`
   returned: a successful revoke already ran the runner's own final `sync_out`, so only a failed
   revoke of a granted token asks for `sync_out` again (also ≤ 10 s). It is tracked per sid
   (`craftFinalCollectSettled`) and the next run of the conversation waits for it before mirroring
   `craft/out/` into `in/craft-out/`. Never throws. Backstops for a token Noah never got to revoke
   (a crash, a throw between the plan and the loop's `try`, a revoke that timed out): the runner
   expires every token 12 h after its grant, and Noah sends `revoke_all` once at boot
   (`revokeAllCraftTokensAtBoot`, best-effort, started next to the health probe in `index.ts`).

**A deleted conversation** (Addendum B N8): every mirror INTO the workspace (`collectOutputs` —
run start, after each Craft call, `share_file`, the final one) and the stage tool re-check that the
conversation row still exists (`store.conversationOwner`, the same test as the Confluence save
path; runPlan passes it as `isConversationLive`). Once it is gone they skip, a mirror that raced
the deletion removes the `craft/` folder it wrote, and the session is purged again
(`purgeCraftSessions`, idempotent) — so a cancelled run's release never recreates `craft/out/` in
a deleted conversation. The runner itself refuses a `grant` for a sid that is not open (purged).

`share_file` re-runs `collectOutputs` before resolving its path on a Craft run — it can execute
before the loop has processed the Craft call that produced the file.

## File rules (`craftExchange.ts`)

Both ends of every Noah-side copy are writable by the agent's own shell (the workspace, and the
exchange volume, which is mounted here and owned by the same uid). So: `lstat` every entry and
copy REGULAR files only (links, FIFOs, sockets, devices are rejected and reported, never
opened); open sources `O_NOFOLLOW|O_NONBLOCK` and re-check with `fstat`; create destinations
`O_EXCL|O_NOFOLLOW` under a temp name and rename into place; and require the kernel's own path of
every opened descriptor (`/proc/self/fd/N`) to lie inside the root it was resolved under — a
parent directory swapped for a link between the check and the open lands there. Caps per mirror:
200 MiB per file, 1 GiB total, 2000 files (the runner applies the same on its side). Incremental
by size + mtime (the copy carries the source mtime).

- **All I/O is async** (`fs.promises`, 1 MiB chunks): a mirror moves up to 1 GiB on a chat turn's
  path and must never block Noah's event loop (every other user's SSE stream).
- **Every walk is iterative and depth-capped at 32** (`CRAFT_MAX_DEPTH`): deeper entries are
  rejected `too_deep`, never followed, and never fail the rest of the walk or a removal
  (`removeTreeNoFollow` reports what it had to leave).
- **workspace → inbox** prunes: files absent from the source are removed from the mirrored
  subtrees (never from `staged/`).
- **outbox → workspace `craft/out/` is ADDITIVE** — copy and overwrite only, never delete. The
  runner's 24 h idle GC, a rebuilt session or a recreated volume leaves an EMPTY outbox; that must
  not wipe the results the user already has. Because `craft/out/` keeps them, the next run mirrors
  them back into `inbox/<sid>/craft-out/`, so a fresh session sees them too. Because nothing is
  ever pruned there, the WHOLE `craft/out/` is capped at 2 GiB (`CRAFT_WORKSPACE_OUT_MAX_BYTES`,
  Addendum B N2): each mirror first measures what it holds, an overwrite counts only its growth,
  and a file that would cross the cap is skipped and reported `workspace_cap`; the latest mirror's
  verdict is `state.storage.workspaceOutFull`, which both surfaces report.
- **`staged/` is per run**: cleared at the start of every run (`clearCraftStaged`) and counted, with
  the whole inbox, against the 1 GiB / 2000-file cap — the stage tool answers `INBOX_FULL` instead
  of letting the inbox grow. A staged name is unique per SOURCE (Addendum B N6):
  `<stem>-<8 hex of sha256(resolved source path)><ext>`, so `a/logo.png` and `b/logo.png` never
  overwrite each other while re-staging the same file replaces its own copy; the whole name is cut
  to 200 UTF-8 BYTES on a code-point boundary (stem shortened, tag + extension kept — the runner
  rejects names over 255 bytes, ~86 Hangul characters). The stage tool reports a failure when
  `sync_in` lists the staged file in `rejected`, and refuses up front while the exchange is over
  budget (a budget refusal of its `sync_in` also deletes the staged copy).

| Workspace | Inbox / app path |
|---|---|
| `attachments/` | `attachments/` → `in/attachments/` |
| `captures/` | `captures/` → `in/captures/` |
| `confluence/` | `confluence/` → `in/confluence/` |
| `craft/out/` | `craft-out/` → `in/craft-out/` |
| any file via `mcp__craft_files__stage` | `staged/<stem>-<tag><ext>` → `in/staged/…` |
| `craft/out/**` ← | `outbox/<sid>/**` ← `out/**` |

`craft/` joined `SERVER_WORKSPACE_COPY_DIRS`: it is server-managed and goes with the
conversation like the other copy folders.

## Previews, delivery, audit

- Previews: the chat route's `onCraftPreview` publishes each image like a browser screenshot
  (`publishCraftPreview` → visible file card "포토크래프트 미리보기.png" + hidden slide with
  `parentId`), at most `MAX_CRAFT_PREVIEWS_PER_MESSAGE` (12) per run, then emits
  `craft_preview {runId, app, attachmentId}` after the `file` events. The client follows it in the
  side panel.
- Delivery: on a run with **at least one ACTIVE Craft app**, `share_file` also accepts
  `.png .jpg/.jpeg .webp .svg .psd .pcraft` with content checks (PNG/JPEG/PSD/zip magic, WebP RIFF
  form, SVG = UTF-8 text with an `<svg` element). Every other run keeps the document list, in the
  tool description AND the host check: runPlan builds the description from the plan-time fact and
  stamps the LIVE fact on each request (`ShareFileRequest.craftFileTypes`), and a refused grant
  rebuilds the server without them. Stored cards of every type are still served. A raster image
  card also gets one hidden preview slide. SVG downloads carry `Content-Security-Policy: sandbox`.
- Audit: `craft_tool` per finished call; `set_craft_apps_enabled` for the switch.

## Tool groups (default-off)

`craft_photocraft`, `craft_vectorcraft`, `craft_designcraft`, `craft_figcraft` carry
`defaultOff: true` in `MCP_TOOL_GROUPS`: never in `DEFAULT_MCP_TOOL_GROUPS` (so a new
conversation, a `null` "default" selection and every existing saved selection leave them off),
`allMcpToolGroupsSelected` is false for a selection that adds one (it stays explicit in
`selected_mcp_tool_groups`), and remembered per-user defaults strip them on write AND read
(`withoutDefaultOffMcpToolGroups`). `planMcpToolFamilies` registers a Craft group only for an
ACTIVE app; the "user deselected these groups" prompt note skips default-off groups (the Craft
section covers them). An existing admin group tool policy that predates the groups blocks them
(`group_unavailable`) until an admin allows them.

## Metacognition

`craftAppsLines(state, "prompt" | "describe")` in `ownerState.ts` is the ONE wording.
describe_system always lists every app (versions, tool counts, reasons). The prompt stays short:
nothing when no Craft group is selected and nothing is ready to switch on; one line offering the
composer switch when an app is ready but unselected; one line when every app is off for the same
deployment-level reason; the full block (apps, in/out paths and their workspace mapping, staging,
`share_file` delivery, "verify with render_preview before claiming success") when an app is
active. All values are stable across turns unless the runner or the switch changes — or a storage
budget is hit: the active block then adds a `Storage:` line for a full exchange (inputs not
mirrored, staging and app calls refused) and/or a full `craft/out/` (newer results not copied, not
deliverable). `storage` is updated in place by the session, so describe_system shows the latest
verdict while the prompt keeps the run-start one.

An app's self-test error (`app_failed`) is RUNNER-REPORTED text that can carry the third-party
app's stderr: the runner truncates it to 300 characters and strips control characters, and Noah
sanitizes it again (`sanitizeCraftRunnerText` — control/format/separator characters, backticks,
300 code points) and quotes it as "runner-reported self-test error, quoted as data" on both
surfaces.

## Client contract

- `GET /api/me` (admins only) adds `craftApps: {enabled, configured, runnerReachable, apps:[{id,
  status: "ready"|"failed"|"unavailable", version?}]}` from the memoized probe (no I/O on the
  request path).
- `GET /api/admin/system` adds `craftAppsEnabled` and the same `craftApps`.
- `PUT /api/admin/craft-apps {enabled: boolean}` → `{craftAppsEnabled, craftApps}`.
- SSE `craft_preview {runId, app, attachmentId}`.

## Purge cascade

`purgeCraftSessions(config, conversationIds)` sits next to EVERY
`deleteConversationWorkspaceCopies` call (single + bulk chat delete, user delete, group delete,
group-agent delete, the personal-agent retirement). It purges only conversations whose
`inbox/<sid>/` exists (Noah created it on the first Craft run), removes that inbox right away,
and leaves a marker under `dataDir/runtime/craft-purge/<sid>` that is cleared on success and
retried after the next good health probe. **A new conversation-deleting path calls it too.**

## Security posture

What "admin-only" means today, accurately: the Craft tools are REGISTERED only on an admin's
interactive own-avatar runs, so nobody else is OFFERED them. It is not an isolation boundary
between users' agents, because every agent Bash runs as uid 1000 — the uid that owns the
exchange volume and its sockets — and the agent can read Noah's own process environment
(`/proc/<pid>/environ`) like every other server secret (pre-existing, `secrets-ssh.md`). Bash uid
separation is issue [#71](https://github.com/JinY0ung-Shin/noah-almighty/issues/71).

What the handshakes close: a uid-1000 process that swaps a socket path for its own listener (a
hard link of the real socket + its own `control.sock`/`mcp.sock`) no longer receives the control
secret or a run token — it sees only nonces and MACs over them — and it cannot pose as the runner,
because Noah and the relay refuse any peer that cannot produce the server MAC (no request is sent,
no CLI byte is forwarded).

Residual risks (documented, accepted for the admin-only beta):

- **Secret theft from the environment.** Any agent Bash can read `CRAFT_CONTROL_SECRET` from
  Noah's `/proc/<pid>/environ` and then speak the control protocol itself (grant a token for any
  sid it can list under `inbox/`, attach to that session). Stripping the secret from the agent's
  OWN env does not stop this.
- **Transparent same-uid proxy.** A proxy that relays the handshake to the real socket unchanged
  can read and alter the JSON-RPC stream AFTER it (forged tool results or preview images). The MAC
  authenticates the peer, not the bytes that follow.
- **Direct file access.** uid 1000 can read every `inbox/<sid>/` (mirrored attachments, captures,
  Confluence downloads), plant files in an `outbox/<sid>/` that Noah then mirrors into that
  conversation's workspace `craft/out/` (additively), and read a run token from its one-shot
  0600 handoff file in the moment it exists.
- **Disk.** The runner bounds `work/<sid>/out` (2 GiB) and the whole exchange
  (`CRAFT_EXCHANGE_MAX_BYTES`, default 20 GiB — over it, `open` of a new session, `sync_in` and app
  calls refuse and Noah copies nothing more into the inbox), Noah bounds the inbox (1 GiB / 2000
  files per conversation) and each workspace `craft/out/` (2 GiB); a uid-1000 process can still
  write to the volume directly.

## Operations

- Env: `CRAFT_EXCHANGE_DIR` (compose: `/app/craft-exchange`), `CRAFT_CONTROL_SECRET` (the same value
  in both services; stripped from the agent subprocess env next to `SESSION_SECRET`). Both unset
  → not configured. No DB migration: the switch defaults off.
- Boot (`startCraftRunnerProbe`): `revoke_all` once (best-effort), then the health probe;
  re-probed every 60 s while unreachable, refreshed on demand when a run wants an app and the memo
  is older than 30 s. A runner that cannot prove the secret reads as unreachable.
- Before opening Craft apps to non-admins (or treating "admin-only" as a boundary), resolve issue
  [#71](https://github.com/JinY0ung-Shin/noah-almighty/issues/71) — see
  [Security posture](#security-posture).
