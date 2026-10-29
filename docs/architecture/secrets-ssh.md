# Secrets, SSH, and the on-prem CA

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The encrypted vault, git credentials, SSH identity/trust, sandboxed Python, and on-prem GitHub CA wiring.

## Secrets / SSH (`crypto.ts` / `gitCredentials.ts` / `sshIdentity.ts` / `sshTrust.ts` / `pythonExec.ts`)
- **Secret-at-rest tiers:** passwords → scrypt (`auth.ts`), session tokens → sha256, **reversible**
  secrets (e.g. per-user git tokens) → AES-256-GCM in `crypto.ts` (keyed from `SESSION_SECRET`). Never
  serialize secrets through `toUser`. App-WIDE secrets (not user-scoped) go in the `app_config` KV table
  (`get/set/deleteAppSecret`, same AES-256-GCM).
- **`SESSION_SECRET` keys EVERY at-rest reversible secret** (`user_secrets`, the legacy `git_token_enc`
  fallback, `app_config`). Rotating it makes `decryptSecret` return `null` (treated as "no secret") —
  **silent data loss, not a crash.** Deploy-migration concern (deployment is a separate corporate box).
- **Per-user secret vault (generic, not just SSH):** `user_secrets` table (AES-256-GCM, keyed on
  `avatar.id`=owner), `get/set/delete/listUserSecretNames`/`getUserSecrets`. Exposed to clients as
  `secretNames` ONLY (values never via `toUser`). `PUT/DELETE /api/me/secrets/:name` (env-key-name
  validated). Settings UI "시크릿" card under the 권한·연결 tab. Owner, non-headless chat prompts include
  only those secret NAMES so the avatar knows what is configured; values never enter the prompt or Bash env.
- **Where secret VALUES actually flow (selective injection, never the shell):** the agent's shell is pi's
  sandbox, and it receives NO user secret (pi has no per-run sandbox env, design P4). Known names route to
  dedicated Noah-side consumers: `SSH_*`/`ALLOWED_HOST*` → the hex-ssh relay child only, `CONFLUENCE_PAT` → the
  in-process Confluence tools, git tokens → server-side git only, slot-bound secrets → the 공용 MCP bridge (next
  bullet). **Plugin `.mcp.json` servers get NO vault value.** Noah relays them as an MCP client on the `plugins`
  broker id (`agent/pi/mcpProxies.ts`, parsing through `plugins.liftPluginMcpServers` — both the
  `{"mcpServers":{…}}` wrapper and the legacy flat shape): a stdio def spawns only from the plugins bundled with
  Noah (`piStdioRootRefusal` — every other root is agent-writable), bundled defs keep `${VAR}` expansion from
  Noah's scrubbed env (`${CLAUDE_PLUGIN_ROOT}` expanded app-side), and an http/sse def outside the bundled roots
  that names ANY `${…}` placeholder sits out (`piPlaceholderRefusal`) because an agent-edited def could send the
  value anywhere from Noah's network. First definition of a name wins (load order), and a plugin server named
  like a Noah server or an enabled 공용 MCP server sits out. Both metacognition surfaces list every skip with its
  reason. Mechanics → [`pi-runtime.md`](pi-runtime.md) "Proxied MCP servers".
- **공용 MCP 서버 (admin-registered external HTTP MCP, `sharedMcpServers.ts` + `routes/sharedMcp.ts`):** ONE
  `app_config` blob (`shared_mcp_servers`, encrypted; unreadable/corrupt → empty list, entries that fail
  `parseSharedMcpServer` — or stored slots without an id — are DROPPED: fail closed), admin CRUD under
  `/api/admin/shared-mcp-servers` (name = id, immutable; app server names/`hex-ssh` reserved; audit `shared_mcp_*`).
  **The admin never names a user's secret** (user decision 2026-10-26, after review): a server declares
  `secretSlots` (`{id, label, header, format}` with exactly one `{secret}`) plus fixed `headers`; neither the URL
  nor a fixed header may carry `${…}`/`{secret}`. Each user BINDS one of their own non-reserved vault secrets to
  each slot (`user_shared_mcp_bindings`, names only, `PUT|DELETE /api/me/shared-mcp-servers/:name/slots/:slotId`,
  audit `shared_mcp_bind`/`unbind`) — the bind IS the consent, and it stores the server ORIGIN: an admin who
  moves the server to another host turns every binding stale (never applied to the new host; the card says
  "다시 연결"). Slot ids are SERVER-minted: a create ignores client ids and an update keeps only ids the stored
  server already has (anything else is a new slot), so no path can revive an orphaned binding; a create also
  prunes leftovers for the name. Bindings are pruned when the slot or server is removed, when the bound secret is deleted, and in
  `deleteUser`. `GET /api/me/shared-mcp-servers` returns label/description/origin and the caller's own bindings.
  The admin connection check spawns the SAME bridge with the CHECKING admin's own bindings. **Per run**
  `planSharedMcpRun` (in `buildRunCapabilities`, before describe_system's ctx) resolves each enabled server from the OWNER's
  bindings + injectable vault: `active` / `needs_binding` (+`hostChanged`) / `missing_secrets` /
  `secrets_unavailable` — a slotted server registers ONLY on `elevatedToolAccess` runs with every
  slot bound for the current origin to a secret that still exists (trimmed; a value with a line break counts
  as missing); consultation and restricted headless (intro/hashtag) runs get none. Slot/secret names
  ride owner runs only. Every server — a header-less one too, so the corporate CA and error scrubbing always
  apply — is relayed on the `shared` broker id through **`scripts/mcp-http-bridge.mjs`**
  (`node --use-system-ca … --config <0600 file>`): the file holds the RESOLVED url/headers + a redact list, is
  written right before the child starts, consumed (deleted) on read (and removed again if the child never read
  it), and the bridge keeps values in memory, not in its env, so neither argv nor `/proc/<pid>/environ` carries
  them. It relays
  JSON-RPC transport-to-transport (sets the negotiated protocol version from the initialize response, orders
  notifications before later sends, answers a failed upstream request with a scrubbed JSON-RPC error, scrubbing
  BEFORE truncating). Bound vault values join the run's redaction set (`piRedactions`), and so does every credential-looking
  bridged header value (`<server>:<header>` — a narrow name match, never an unresolved `${…}` template — plus the
  bare token after a `Bearer`/`Basic`/`Token` scheme word, and each slot's trimmed value as sent). Every ENABLED admin
  server reserves its name for the run, mounted or not: a same-named plugin server is dropped (status-line
  warning), so `mcp__<name>__*` never points at something the metacognition says is unavailable; app servers win
  over both. Shared servers ignore the composer's tool-group picker and group tool policy, like plugin servers.
- **Per-secret AGENT-SHELL exposure (opt-in, currently UNAVAILABLE):** `user_secrets.shell_expose` (0 default) —
  toggled per key via `PATCH /api/me/secrets/:name {shellExpose}` (셸 노출 checkbox in the 시크릿 card; hidden for
  reserved names via the client-imported `secretPolicy.isShellExposableSecret`). The pi sandbox has no per-run env
  (P4), so flagged values are NOT exported; the toggle and column stay so the owner's choice survives until the
  runtime can honor it. Both metacognition surfaces name the flagged secrets as unavailable
  (`PiRuntimeFacts.shellSecretsUnavailable`). Reserved git/SSH names live in `secretPolicy.ts` (leaf module,
  shared with the client; a unit test pins it to the gitCredentials constants).
- **Per-secret BROWSER INPUT (브라우저 입력, opt-in):** the second per-secret exposure toggle, and the only
  one whose value leaves the server — the avatar names a secret and the extension types it into the
  owner's OWN browser, so the MODEL never sees the value. Storage rides the secret row:
  `user_secrets.browser_expose` (0 default), `browser_hosts` (JSON array of exact lowercase hostnames,
  NULL when unset) and `browser_password_only` (1 default) — all three added by `addColumnIfMissing`
  next to `shell_expose`, so an EXISTING deployment picks them up on the next boot. Read back through
  `store.listBrowserSecretPolicies` → `User.browserSecrets` (a REQUIRED `BrowserSecretPolicy[]`, filled
  in `toUser`) and `OwnerState.browserSecrets` (the metacognition sync point — both surfaces branch on
  it). **The read FAILS CLOSED**: a row is listed only when it is enabled, its name is not reserved
  (`isBrowserExposableSecret` — same line shell exposure draws, and defence in depth against a
  hand-edited DB), and its hosts parse to a non-empty list; malformed JSON, a wildcard, or an empty
  allowlist skips the row rather than advertising a secret the bridge would always refuse. Legacy/NULL
  `browser_password_only` reads as the SAFE end (password fields only).
- **Browser-input policy writes:** `PATCH /api/me/secrets/:name` now carries `{shellExpose?, browser?}`
  and needs at least one; `browser` is `{enabled, hosts?, passwordOnly?}`. Hosts normalize
  all-or-nothing through `normalizeBrowserSecretHosts` (a silently dropped typo would leave the owner
  believing a site is allowed), enabling requires ≥1 valid host, `MAX_BROWSER_SECRET_HOSTS` = 20, and
  `passwordOnly` defaults to true. Disabling KEEPS the stored hosts/flag (`setSecretBrowserPolicy` only
  flips `browser_expose`) so re-enabling restores the owner's configuration. The whole body validates
  before either toggle is written — a half-applied request would leave the two exposures in a state
  nobody asked for. Audited as `secret_browser_expose` by NAME + hosts only
  (`enabled secret LOGIN_PW for browser input on [jira.corp.com] (password fields only)` /
  `disabled browser input for secret LOGIN_PW`), never a value.
- **Where a browser-input VALUE actually flows:** server-resolved from the vault → a TRANSIENT SSE
  `browser` frame (written to live clients, never pushed into the run's replay buffer) on a NEW field
  (`secretText` / per-field `secretValue`, never `text`/`value`, so a pre-0.28.0 extension types
  nothing) → the client relay → the extension's `Input.insertText`. The host allowlist is re-checked at
  BOTH ends and the extension additionally enforces the password-field shape plus a
  once-per-browser-session `secret` consent popup the server cannot bypass (one approval covers every
  allowed site — the per-site limit is the owner's own host allowlist, re-checked at the keyboard on
  every write, not the popup); the reply is redacted server-side and the value joins the
  run's redaction set (`piRedactions`, applied by the `/mcp` endpoint to every Noah MCP result), so any later
  echo comes back `[REDACTED:<NAME>]`. Wire/extension mechanics
  → [`browser-bridge/contract.md`](browser-bridge/contract.md) + [`actions.md`](browser-bridge/actions.md).
- **MCP secret TRANSPORT never rides argv.** Noah spawns every relayed child itself (`pi/mcpProxies.ts`), so no
  server definition is serialized into anyone's command line: hex-ssh's SSH material sits in its child's env
  (behind the node policy proxy, which is non-dumpable — next bullet), and bridge configs are one-shot 0600 files
  under `dataDir/runtime/mcp-secrets/`.
- **Same-uid posture (#71).** The agent's shell no longer runs in Noah's container at all — it is the run
  principal's pi sandbox — so the old hole (any agent Bash reading the shared data volume and other runs'
  environ) is gone structurally. What still runs as Noah's `node` uid is Noah itself and the children it spawns:
  the hex-ssh policy proxy + upstream, stdio servers of the BUNDLED plugins, and `mcp-http-bridge.mjs`. None of
  them is agent-authored. Phase 0 hardening (2026-10-28) still applies to them:
  - **node and tini are execute-only** (`chmod 0711` in the Dockerfile), so every process running node —
    the server, the relays/bridges — is non-dumpable: its `/proc/<pid>/environ` and memory are unreadable to
    other processes of the same uid. PID 1 holds the container's full environment, so it is the image's own tini,
    started through `docker-entrypoint.sh`'s `exec` (`ENTRYPOINT ["docker-entrypoint.sh", "/usr/bin/tini", "--"]`)
    with compose `init: false` — verified on the built image: Docker's `init: true` (readable docker-init) and a
    tini started directly by the runtime both kept a READABLE environment. The egress overlay keeps
    `init: true`: its image runs that init as root. The HEALTHCHECK runs behind `env -u` so its short-lived
    shell/curl never carry the server-only secrets.
  - **The server drops `SERVER_ONLY_SECRET_ENV_NAMES`** (`SESSION_SECRET`, `PI_GATEWAY_API_KEY`, …;
    `secretPolicy.ts`) from `process.env` right after the config reads them (`index.ts`), so no process it
    starts later inherits them; `piProxyBaseEnv()` (`agent/pi/mcpProxies.ts`) builds a relayed child's env
    from that scrubbed env minus git credentials.
  - **Server git never carries a token in argv** (argv is world-readable under `/proc/<pid>/cmdline`): the
    `http.extraHeader` rides `GIT_CONFIG_COUNT/KEY/VALUE` env via `serverGitEnv` (`marketplace.ts`), and
    every server git command also runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` — the
    clones are agent-edited, so their own hooks must never run in the server's git. Noah never runs git in a
    sandbox copy's `.git` (design D1, [`pi-runtime.md`](pi-runtime.md) "Working repositories").
  - **Still open:** a server git child's environ (one call's auth header) is readable by same-uid processes
    while it runs, and non-node children keep a readable environ — both only matter if something agent-authored
    ran in the container, which the bundled-only stdio rule exists to prevent.
  - **Not covered: secret FILES.** "Server-only secrets never reach a child" holds for the ENVIRONMENT only. pi's
    service-key file (`PI_GATEWAY_API_KEY_FILE` → `/run/secrets/pi_gateway_api_key`, uid 1000, 0400 — see "Model
    credentials live in pi-gateway only" below) is readable by EVERY uid-1000 process in Noah's container: hex-ssh, the bundled
    stdio plugin servers, `mcp-http-bridge.mjs`, git, LibreOffice. That key runs turns AS ANY user, so a child
    that read it is the whole deployment. Marginal today (the same children already reach the rw workspaces bind
    mount and the data volume — this is not uid isolation), and closed only by #71's uid separation.
- **Two git tokens, vault-backed, host-routed.** Each user can store TWO git tokens as named
  `user_secrets`: `GIT_TOKEN` (`INTERNAL_GIT_TOKEN_SECRET_NAME`) for the internal `GITHUB_HOST`, and
  `GITHUB_TOKEN` (`EXTERNAL_GIT_TOKEN_SECRET_NAME`) for github.com. `tokenForGitUrl` in
  `gitCredentials.ts` selects by matching the clone URL's host against `config.githubHost` (internal) or
  `DEFAULT_GITHUB_HOST`/github.com (external); unknown hosts get no token. Both are supplied as
  `http.extraHeader` per git call (`gitAuthArgs`) — never written into `.git/config`, never in a URL. The
  legacy `git_token_enc` column in `users` is only a migration fallback (`setGitToken` writes to the
  vault and NULLs the column; `getGitToken` reads the vault first).
- Git auth for clones uses `http.extraHeader`, never a token-in-URL — keeps the token out of
  `.git/config`. Scrub it from git error text before logging/returning (`scrubGitError`).
- **The per-user git tokens NEVER reach the agent's shell.** Used only server-side: as a per-invocation
  `http.extraHeader` on the app's OWN clone/push (`knowledgeRepo.ts`, `syncPluginRepo`, `gitRepos.ts`) and
  by the server-side `mcp__repo__create_repo` bridge (invokes `gh repo create` with the token in
  child-process env). The sandbox never holds one, and `piProxyBaseEnv` strips `GIT_TOKEN`/
  `GITHUB_TOKEN`/`GH_TOKEN`-style names from every child Noah spawns (hex-ssh gets only its SSH-specific
  secrets). So the avatar can't `gh repo create`; `create_repo` is the only bridge. The prompt surfaces `gitTokenSet` (not the value).
- **The prompt tells the owner how to enable SSH when it's off.** `buildPrompt` adds an SSH enablement
  note on owner, non-headless turns whenever `SSH_PRIVATE_KEY` isn't in `secretNames`. Drops off once
  the key is stored.
- **`sshIdentity`/`sshTrust` shell out to python3** (`pythonExec.ts` centralizes the spawn + timeout).
  They silently depend on the **image carrying python3 + `cryptography` + `paramiko`** (no
  `ssh-keygen`/`ssh-keyscan`). A base-image change breaks them at RUNTIME, not build. A unit test asserts
  the TS `fingerprintOf` and the python SHA256 format agree — keep it green.
- **SSH host-key trust is agent-managed + volume-persistent.** `mcp__ssh_trust__{add,list,remove}_host`
  (sshTrustTools.ts) write a per-owner `known_hosts` under `${dataDir}/ssh/<userId>` (data volume →
  survives restarts), injected into hex-ssh as `KNOWN_HOSTS_PATH` (re-read per connection, so `add_host`
  takes effect mid-session). Fingerprints aren't secrets, so these tools are NOT owner-only.
  `fetchHostKey` uses paramiko (image has no `ssh-keyscan`).
- **Model credentials live in pi-gateway only** (design D7). Noah holds no LLM key: `ANTHROPIC_API_KEY` and the
  admin-pasted `claude setup-token` subscription token are gone (`PUT/DELETE /api/admin/claude-token` → 404). The
  stored `claude_oauth_token` app_config key is deleted on existing deployments through `retirementGate()` (DB
  backup first) and the name stays reserved forever. Noah's only gateway secret is pi's service key (a
  server-only secret): inline `PI_GATEWAY_API_KEY`, or the file `PI_GATEWAY_API_KEY_FILE` names
  (`readPiGatewayApiKey`, `config.ts` — both set, unreadable or empty stops the boot; a file's key never enters
  `process.env`). The bundled compose stack uses ONLY the file: Noah's own uid-1000 0400 copy
  (`docker/pi/setup-host.sh`) mounted as the compose secret `/run/secrets/pi_gateway_api_key`. Same-uid caveat
  (#71): unlike the scrubbed env, that file stays readable to every uid-1000 process in Noah's container, the
  relayed MCP children (owner plugins, 공용 MCP stdio side, hex-ssh) included — until uid separation lands.

## On-prem GitHub CA
- **One var `GITHUB_CA_CERT`** (PEM path, `applyCustomGithubCa` in `tlsCa.ts`, called from `index.ts`).
  Covers Node `fetch` via runtime `tls.setDefaultCACertificates` (appends to system roots), `git`
  clone/push via `GIT_SSL_CAINFO`, and `create_repo` via `SSL_CERT_FILE` passed to `gh` in `repoTools.ts`.
  `GITHUB_HOST` becomes `GH_HOST` for `gh repo create` on GHES.
- Repo shorthand (`owner/repo`) resolves through `config.githubHost` (`GITHUB_HOST`, default
  `github.com`) for both plugin and knowledge-repo clones/pushes. Full `https://...` and `git@...` repo
  values bypass that default and are used as-is.
- GHES/older `gh` compatibility: do not depend on `gh repo view --json visibility`; use `isPrivate` with
  `nameWithOwner,defaultBranchRef,isPrivate`.
