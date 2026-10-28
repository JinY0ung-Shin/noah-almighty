# craft-runner

A sidecar service that runs ArtCraft "Craft" app CLIs (P1: **PhotoCraft 0.16.0**) as **headless MCP
servers** for Noah, one isolated unprivileged process per conversation. Noah's avatar reaches it as the
MCP server `photocraft` (`mcp__photocraft__*`) through `scripts/craft-mcp-relay.mjs`; the runner itself
is plain Node 22 ESM with **zero npm dependencies** (`src/*.mjs`).

The Noah-side gate (admin toggle, admin-only interactive runs, tool groups, metacognition) lives in the
main server — see `docs/architecture/craft-apps.md`. This file covers the runner.

## Security model

The apps are young, fast-moving, and confine files with their own denylists. The runner therefore treats
an app process as untrusted and puts the real boundary around it:

| Layer | What it does |
|---|---|
| Container | `network_mode: none` (no interface at all — no internet, no internal network, no Noah API), read-only rootfs, `cap_drop: ALL` + `SETUID SETGID CHOWN FOWNER DAC_OVERRIDE KILL` for the daemon only, `no-new-privileges`, `mem_limit 8g`, `cpus 4`, `pids_limit`, tmpfs `/tmp` mode 0711. Receives only `CRAFT_CONTROL_SECRET`, `CRAFT_MAX_PROCS` and `CRAFT_EXCHANGE_MAX_BYTES` — never Noah's `.env`, never the Noah data volume. |
| Session uid | Every conversation gets its own uid from 20000–29999 (`state/uids.json`), handed out **round-robin** from a persisted cursor, so a just-freed uid is the last to be reused. The app child runs as that uid/gid with no supplementary groups and zero capabilities. Its `work/<sid>/` is 0700; `in/` inside it is root-owned (read-only for the app); inbox/outbox/state/sockets are unreachable for it. Before a uid returns to the pool (purge) — and when a run's token is revoked — the daemon SIGKILLs **every** process whose real/effective/saved/fs uid is that uid, whatever its state (a `/proc/*/status` scan, re-scanned until none is left alive; a zombie leader with `Threads: > 1` — main thread exited, others running — counts as alive), not just the child's process group, so a `setsid()` escapee cannot outlive its session. A new uid is never handed out while any process, or any directory under `work/` or the tmp root, is still owned by it; trees (`work/`, `outbox/`, tmp) whose sid has no state entry (lost `uids.json`) are removed at boot and on every GC pass, after their owner uid's processes are killed. Every spawn asserts a valid session uid/gid (≥ 20000; the self-test uses 19999) — Node would silently ignore `uid: undefined` and run the app as root. A uid whose processes survive, or whose trees could not be removed, stays **reserved** and the purge is retried by the GC. |
| Socket auth | Both sockets start with a **mutual challenge-response** (below): the runner proves it knows the secret/token as much as the client does, and neither the control secret nor a run token is ever written to a socket. Plaintext `secret`/`token` fields are refused. |
| Lifecycle | A run token lives at most **12 h** from `grant` (absolute; a sweeper revokes expired tokens every minute, and attach/calls check the expiry themselves). `revoke_all` revokes every token (Noah sends it at boot). |
| argv / env | Always `mcp --automation-read-root work/<sid> --automation-write-root work/<sid>/out`; never `--bridge/--connect/--attach`, never the trusted-local `run/batch/convert` subcommands (`validateApp` enforces this). The env is built from scratch: `PATH HOME XDG_* TMPDIR FONTCONFIG_FILE` + per-app extras. |
| Relay policy | Bridge-only tools (`ui_*`, `control_call`) are hidden and refused; only manifest tools are callable; engine command ids are checked against the app's deny rules in `command_run` AND every `command_batch` step (including indirection: actions, scripts, droplets, batch, plug-ins); `render_preview.max_side` ≤ 1568; responses > 10 MiB are replaced by an error; 120 s per call (then the child is killed); 3 live processes total; idle children die after 10 min. |
| Boot self-test | Per app, in the network-none container at every boot: tool set must equal `expectedTools`, `serverInfo.version` must equal the pin, a probe image inside the read root must open, and the same (readable) image outside it must be refused by absolute path and by `../`. Any failure ⇒ status `failed`, never served. |
| Mirroring | The daemon (root) copies inbox→`in/` and `out/`→outbox with descriptor-relative I/O (`/proc/self/fd/<dirfd>/<name>` + `O_NOFOLLOW`), regular files only (symlinks, FIFOs, sockets, devices rejected and listed; hard links rejected on the way out), names validated, caps ≤ 200 MiB/file, ≤ 1 GiB total, ≤ 2000 files, temp file + rename so a planted symlink is replaced, never written through. Every walk (mirror source AND destination, budget measurement, purge/remove) is **iterative** with at most 32 directory levels open: deeper source entries are rejected as `too_deep` and never followed; deeper destination entries are removed; removal hoists a subtree found at the cap up into the tree being removed instead of descending, so even a 100 000-level chain neither overflows nor exhausts descriptors, and one tree that cannot be removed never stops purge of the others. |
| Disk budgets | Per session `work/<sid>/out` ≤ **2 GiB**; whole exchange (inbox + work + outbox) ≤ `CRAFT_EXCHANGE_MAX_BYTES` (default **20 GiB**; the volume shares the host disk with Noah's DB). Over budget, a `tools/call` is refused before it reaches the app (isError, English: deliver with `share_file`, continue in a new conversation / delete old Craft conversations); the call that crosses the session budget keeps the app's content but becomes isError with the same text, and `sync_out` reports it in `budget`. An `out/` containing directories deeper than 32 levels (unmeasurable) counts as over budget (fail closed); an entry with a name the runner will not mirror is still **measured** (a bad-named directory is walked for its bytes) and listed as `{path, reason:"bad_name", detail}`, so it never locks a session out. Over the exchange budget, `open` of a NEW sid and every `sync_in` are refused too (`{ok:false, error, budget}`); `open` of an existing session still succeeds so its results can be delivered. The exchange measurement is an async walk shared by concurrent callers (it never blocks the relays). |
| Supply chain | The Dockerfile pins each app's version **and archive sha256**; the release's `SHA256SUMS.txt` must agree. The build only downloads, verifies and extracts — the binary is **never executed during the build** (which has network). Only the `*-cli` binary ships. |

## Layout (exchange volume — `/exchange` here, `/app/craft-exchange` in Noah)

```
sock/      1000:1000 0700   control.sock, mcp.sock (1000, 0600)
inbox/     1000:1000 0711   inbox/<sid>/   written by Noah (0700)          — authoritative inputs
work/      root      0711   work/<sid>/    session uid 0700
                              in/          root 0755 (files 0644)         — mirror of inbox/<sid>
                              out/         session uid 0700               — the app's only write root
outbox/    1000:1000 0711   outbox/<sid>/  1000 0700, files 0600          — mirror of work/<sid>/out
state/     root      0700   uids.json  {"v":2,"next":<uid>,"sessions":{"<sid>":<uid>}}  (v1 = bare map, still loads)
/tmp/craft/<sid>/{home,tmp}  session uid 0700 (tmpfs)                     — HOME / TMPDIR / XDG_*
```

`sid` = first 32 hex chars of `sha256("noah-craft:" + conversationId)`.

## Protocol summary

Both sockets speak one JSON object per line. Full contract: `~/.noah-work/artcraft-2026-10-28/spec-p1.md`
§3–4 + **Addendum A** (binding; supersedes the plaintext hello/attach), mirrored in
`docs/architecture/craft-apps.md`. Crypto helpers: `src/auth.mjs`.

Conventions: `HMAC(k, m)` = HMAC-SHA256 keyed by the **UTF-8 bytes of the secret/token string as
configured** (the 64-hex token is not hex-decoded), lowercase hex; nonces are 16 random bytes as 32
lowercase hex; MACs are compared in constant time. The runner ALWAYS speaks first.

**control.sock** (Noah server only)
```
runner → {"op":"challenge","v":1,"nonce":N1}
Noah   → {"op":"hello","nonce":N2,"mac":HMAC(secret,"noah-craft-control|client|"+N1)}
runner → {"ok":true,"mac":HMAC(secret,"noah-craft-control|server|"+N2)}     # Noah verifies BEFORE any request
       | {"ok":false,"error":"unauthorized"} + close                         # wrong MAC, plaintext secret, timeout
```
Then `{id, op, …}` → `{id, ok, …}`: `health` (+ `exchange:{bytes,maxBytes}`), `open {sid}` (a NEW sid over the
exchange budget → `{ok:false, error, budget}`), `sync_in {sid}` → `{copied, removed, skipped, bytes, rejected,
rejectedTotal}` (needs an opened session → else `unknown session; call open first`; over the exchange budget →
`{ok:false, error, budget}`), `grant {sid, token}` (needs an opened, not purged session → else
`no such session — open it first`; token lives 12 h; re-granting an expired token → `token expired`),
`revoke {token}`, `revoke_all {}` → `{revoked:n}`, `sync_out {sid}` → `{files, rejected, rejectedTotal, budget}`,
`purge {sid}` (→ error `purge incomplete: …` when a process survived or a tree could not be removed; the uid
stays reserved). `rejected` lists are capped at 100 entries, except that EVERY `staged/…` entry is listed first.

`budget` = `{outBytes, outMaxBytes, outUnmeasured, exchangeBytes, exchangeMaxBytes, over: null|"session"|"exchange", message?}`
(`message` = the agent-facing English text the refused/flagged tool results carry; `exchangeBytes` is a
measurement reused for ≤ 30 s).

**mcp.sock** (relay script)
```
runner → {"op":"challenge","v":1,"nonce":N1}
relay  → {"op":"attach","app":A,"tokenId":sha256hex(token),"nonce":N2,"mac":HMAC(token,"noah-craft-mcp|client|"+N1+"|"+A)}
runner → {"ok":true,"mac":HMAC(token,"noah-craft-mcp|server|"+N2)}          # relay verifies before forwarding CLI bytes
       | {"ok":false,"error":"unauthorized"|"unknown or revoked token"|"invalid tokenId"|"unknown app"|…} + close
```
Then JSON-RPC. `initialize` and `tools/list` come from the boot manifest (no process); the first
`tools/call` spawns the child and replays `initialize`. `sync_out` runs **before** each `tools/call`
response is sent, so the outbox is current when Noah sees the result. Only `notifications/progress` is
relayed back; server→client requests are answered by the runner; `resources/*`/`prompts/*` are not offered.

### Residual risk (pre-existing posture — follow-up issue #71)

Every agent Bash in the Noah container runs as **uid 1000, the same uid as the Noah server**: it owns
`sock/`, can read every `inbox/<sid>` and plant files in every `outbox/<sid>`, and can read
`CRAFT_CONTROL_SECRET` from Noah's own `/proc/<pid>/environ`. The handshakes stop a socket squatter from
LEARNING the secret or a token from the wire, and stop a fake runner from passing Noah's check — but a
**transparent same-uid proxy** (rename the real socket, listen in its place, forward bytes both ways) still
reads and can alter the JSON-RPC stream after the handshake, and a process that already holds the secret
(via `/proc/<pid>/environ`) can authenticate itself. "Admin-only" is a product-exposure gate, NOT a security
boundary against other users' agents. Closing this needs Bash-uid separation (agent subprocess under its own
uid, or the exchange behind a separate uid) — tracked in issue #71.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `CRAFT_CONTROL_SECRET` | — | Required, ≥ 32 chars. Missing/short ⇒ the daemon stays up but opens no socket (Noah reports "unreachable"). |
| `CRAFT_MAX_PROCS` | 3 | Global cap on live app processes (1–32). Over-cap spawns wait ≤ 30 s, then the call returns "busy". |
| `CRAFT_CALL_TIMEOUT_MS` | 120000 | Per-call timeout; the child is killed and documents are lost. |
| `CRAFT_IDLE_MS` | 600000 | Idle child lifetime. |
| `CRAFT_SESSION_GC_HOURS` | 24 | Sessions with no live token and no activity for this long are purged (Noah re-creates them on the next run). |
| `CRAFT_EXCHANGE_MAX_BYTES` | 21474836480 (20 GiB) | Budget for the whole exchange volume (inbox + work + outbox; ≥ 64 MiB). The per-session `out/` budget (2 GiB) and the 12 h token lifetime are fixed in `src/config.mjs`. |
| `CRAFT_EXCHANGE_ROOT` / `CRAFT_TMP_ROOT` | `/exchange` / `/tmp/craft` | Set by the image. |

Compose: the service is opt-in — add `COMPOSE_PROFILES=craft` and `CRAFT_CONTROL_SECRET=…`
(`openssl rand -hex 32`) to `.env`, then `docker compose up -d --build`. Corporate builds use the same
`APT_MIRROR_HOST`, `CA_CERT_FILE` and proxy args as the main service, plus `CRAFT_RELEASE_BASE` for a
release mirror (safe: the sha256 pin is checked regardless of origin). Image platform: linux/amd64 only.

## Bumping an app version

1. In `Dockerfile`, set `PHOTOCRAFT_VERSION` and `PHOTOCRAFT_SHA256` (the `linux-x86_64.tar.gz` line of
   that release's `SHA256SUMS.txt`).
2. In `src/apps.mjs`, set `version`.
3. Build, then — **only inside a `--network none` container** — dump the tool list and `command_list` and
   diff them against the previous version:
   - new/removed tools → update `expectedTools` (and `deniedTools` for anything bridge-only);
   - new command families, path-taking params or indirection (anything that runs nested steps or reads/
     writes a path) → add `deniedCommands` rules;
   - changed preview argument names/ceilings → update `clamps`.
4. Run `npx vitest run tests/craft-runner.test.ts tests/craft-runner-infra.test.ts` and
   `craft-runner/e2e/run-e2e.sh`. A tool drift that slipped through makes the boot self-test mark the app
   `failed` (visible in `health` and the runner log) — it is never served half-verified.

Adding a P2 app (VectorCraft, DesignCraft, FigCraft) is a new registry entry (+ its pinned download in the
Dockerfile): its `args`, `env`, `deniedTools`, `expectedTools`, `commandTools`, `deniedCommands`,
`clamps` and `selfTest`. Those apps fail OPEN without root flags and have known bypasses
(`file.recovery.*`, `collab.*`, …) — review their source reports before writing the deny list.

## Development

- Unit/integration tests (no root, no Docker; a fake app in `test/fake-app.mjs`):
  `npx vitest run tests/craft-runner.test.ts tests/craft-runner-infra.test.ts`
- Real E2E with the actual binary (every container `--network none`; cleans up after itself):
  ```
  docker build -f craft-runner/Dockerfile -t noah-craft-runner:e2e .
  craft-runner/e2e/run-e2e.sh noah-craft-runner:e2e
  ```
  It acts as Noah from a second container (uid 1000) speaking both handshakes (wrong-MAC and plaintext
  hello/attach refused, runner MACs verified, secret/token never written), runs open → sync_in → grant →
  attach → doc_open → blur → render_preview → doc_export → sync_out (+ budget) → denials → revoke → purge
  → revoke_all, checks the child's credentials and cross-session file isolation with
  `docker exec --user <session uid>`, plants a `setsid` process of the session uid and verifies purge kills
  it, checks round-robin uid reuse, that grant/sync_in after purge are refused, that a busy cursor uid is
  skipped, that a restart sweeps an orphan work dir, and that a spawn without a valid uid is refused as root.
- Running the daemon as a normal user disables session-uid isolation (it logs a warning); never deploy
  that way.
