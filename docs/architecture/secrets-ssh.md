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
- **Where secret VALUES actually flow (selective injection, never the shell):** the SDK subprocess env
  (`agentSubprocessEnv`) gets NO user secrets — Bash/`env` stays clean. Known names route to dedicated
  consumers: `SSH_*`/`ALLOWED_HOST*` → the hex-ssh subprocess only (`sshMcpSecretEnv`), `CONFLUENCE_PAT`
  → the in-process Confluence tools, git tokens → server-side git only. **Custom secrets reach plugin MCP
  servers via the lift**: `runClaudeAgent` sets `strictMcpConfig: true` (CLI MCP discovery — plugin
  `.mcp.json`, cwd project `.mcp.json`, user settings — is OFF) and registers every plugin root's
  `.mcp.json` servers itself through `plugins.liftPluginMcpServers` (both the `{"mcpServers":{…}}` wrapper
  and the legacy flat shape parse). OWNED roots (the avatar's own plugin clones + personal knowledge repo)
  get `mcpInjectableSecretEnv` (vault minus git-credential + SSH names); group/default roots are lifted
  verbatim with NO secrets (a group teammate's `.mcp.json` must not read your vault). **Injection is
  additionally gated on `elevatedToolAccess`** (owner or trusted teammate; same line Confluence draws for
  the owner's PAT): plugin servers can't self-gate per viewer and the PreToolUse hook auto-allows every
  `mcp__*`, so REGISTRATION is the gate — plain-colleague and restricted-headless runs get the servers
  credential-less (pre-lift parity), never with the vault.
  `${CLAUDE_PLUGIN_ROOT}` is expanded app-side (the CLI no longer sees the plugin origin); first
  definition of a name wins (load order default → avatar plugins → knowledge repo → group), and app
  in-process servers spread after the lifted map so app names always win.
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
  `planSharedMcpRun` (in runPlan, before describe_system's ctx) resolves each enabled server from the OWNER's
  bindings + injectable vault: `active` / `needs_binding` (+`hostChanged`) / `missing_secrets` /
  `secrets_unavailable` — a slotted server registers ONLY on `elevatedToolAccess && !groupAgent` runs with every
  slot bound for the current origin to a secret that still exists (trimmed; a value with a line break counts
  as missing); consultation and restricted headless (intro/hashtag) runs get none. Slot/secret names
  ride owner runs only. A server with no headers at all registers natively (`{type, url}`); anything else runs
  through **`scripts/mcp-http-bridge.mjs`** (`node --use-system-ca … --config <0600 file>`): the file holds the
  RESOLVED url/headers + a redact list, is consumed (deleted) on read, and the bridge keeps values in memory — not
  in its env, unlike the stdio wrapper — so neither argv nor `/proc/<pid>/environ` carries them. It relays
  JSON-RPC transport-to-transport (sets the negotiated protocol version from the initialize response, orders
  notifications before later sends, answers a failed upstream request with a scrubbed JSON-RPC error, scrubbing
  BEFORE truncating). Bound vault values join the PostToolUse redaction set, and so does every credential-looking
  bridged header value (`<server>:<header>` — a narrow name match, never an unresolved `${…}` template — plus the
  bare token after a `Bearer`/`Basic`/`Token` scheme word, and each slot's trimmed value as sent). Every ENABLED admin
  server reserves its name for the run, mounted or not: a same-named plugin server is dropped (status-line
  warning), so `mcp__<name>__*` never points at something the metacognition says is unavailable; app servers win
  over both. Shared servers ignore the composer's tool-group picker and group tool policy, like plugin servers.
- **One-shot MCP handoff files are written per ATTEMPT** (`plan.writeMcpHandoffFiles`, called right before every
  `query()`): the plugin secret-wrapper env, hex-ssh secrets and bridge configs are consumed by the first spawn, and
  a model fallback / self-heal retry respawns the CLI on the same options. `plan.removeMcpHandoffFiles` deletes
  any left unconsumed when the run ends (abort right after `query()`, a CLI dying before a server spawned). Only files a REGISTERED server's argv
  names are written, so a shadowed server leaves no plaintext behind. The SAME bridge serves OWNED plugin
  `.mcp.json` http/sse entries whose url/headers reference vault names as `${NAME}` (`expandEnv: true` keeps the
  CLI's `${VAR}` env expansion for the rest — templates stay unresolved in the file and the bridge fills vault + env
  refs in ONE pass, so a vault value containing `${…}` is never expanded again; a def with fields the bridge cannot
  carry, e.g. `oauth`/`headersHelper`, stays native), and NON-owned http/sse entries get references to shell-exposed names
  blanked — the CLI would otherwise expand them from its own env into a group repo's URL.
- **Per-secret AGENT-SHELL exposure (opt-in):** `user_secrets.shell_expose` (0 default) — toggled per key
  via `PATCH /api/me/secrets/:name {shellExpose}` (셸 노출 checkbox in the 시크릿 card; hidden for reserved
  names via the client-imported `secretPolicy.isShellExposableSecret`). Flagged values merge into
  `options.env` on ELEVATED runs only, so `$NAME` works in Bash; the **PostToolUse hook
  (`postToolUseHook.ts`, SDK `updatedToolOutput`) redacts every injectable value from every tool output**
  (`[REDACTED:<NAME>]`, values ≥6 chars) before the model sees it — accident prevention, not containment
  (a prompted model could re-encode a value it can use). Because the CLI env is inherited by every
  CLI-spawned server, non-owned lifted MCP servers get the shell-exposed names BLANKED
  (`liftPluginMcpServers` `maskEnvNames`). Reserved git/SSH names live in `secretPolicy.ts` (leaf module,
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
  PostToolUse redaction set, so any later echo comes back `[REDACTED:<NAME>]`. Wire/extension mechanics
  → [`browser-bridge/contract.md`](browser-bridge/contract.md) + [`actions.md`](browser-bridge/actions.md).
- **⚠️ MCP secret TRANSPORT is a one-shot file + wrapper, NEVER the server definition.** The SDK
  serializes `options.mcpServers` into the CLI's `--mcp-config` ARGV, and argv is world-readable via
  `/proc/<pid>/cmdline` — the agent's own Bash is a child of that CLI (`cat /proc/$PPID/cmdline`). So
  injected env values (and hex-ssh's `SSH_PRIVATE_KEY`, which used to sit in the def env — a real
  pre-wrapper exposure) ride in per-server mode-0600 files under `dataDir/runtime/mcp-secrets/`, and the
  def becomes `node scripts/mcp-secret-wrapper.mjs --secrets <file> -- <real command…>`. The wrapper
  reads the file, DELETES it (one-shot), and execs the real server with secrets merged over its env;
  `sweepStaleMcpSecretFiles` removes >1h crash leftovers at the next run. Residual (accepted) exposure:
  everything runs as ONE container uid (see "Same-uid posture (#71)" below) — the wrapper closes the casual
  `env`-dump and world-readable-argv tiers, not uid isolation.
- **Same-uid posture (#71) — what phase 0 closes and what it doesn't.** The server, every agent CLI and
  every agent Bash run as the image's `node` uid. Phase 0 (2026-10-28):
  - **node and tini are execute-only** (`chmod 0711` in the Dockerfile), so every process running node —
    the server, the MCP secret wrapper and the node MCP servers it execs, the relays/bridges — is
    non-dumpable: its `/proc/<pid>/environ` and memory are unreadable to other processes of the same uid.
    PID 1 holds the container's full environment, so it is the image's own tini, started through
    `docker-entrypoint.sh`'s `exec` (`ENTRYPOINT ["docker-entrypoint.sh", "/usr/bin/tini", "--"]`) with
    compose `init: false` — verified on the built image: Docker's `init: true` (readable docker-init) and a
    tini started directly by the runtime both kept a READABLE environment. The egress overlay keeps
    `init: true`: its image runs that init as root. The HEALTHCHECK runs behind `env -u` so its short-lived
    shell/curl never carry the server-only secrets.
  - **The server drops `SERVER_ONLY_SECRET_ENV_NAMES`** (`SESSION_SECRET`, `CRAFT_CONTROL_SECRET`,
    `secretPolicy.ts`) from `process.env` right after the config reads them (`index.ts`), so no process it
    starts later inherits them; `agentSubprocessEnv`, the skill-discovery preflight and the server-agent base
    env strip the same list again.
  - **Server git never carries a token in argv** (argv is world-readable under `/proc/<pid>/cmdline`): the
    `http.extraHeader` rides `GIT_CONFIG_COUNT/KEY/VALUE` env via `serverGitEnv` (`marketplace.ts`), and
    every server git command also runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` — the
    clones are agent-edited, so their own hooks must never run in the server's git.
  - **No cross-session messages (2026-10-28).** Every live CLI registers in
    `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` and listens on `<TMPDIR>/cc-socks/<pid>.sock`, so with the shared
    config dir `ListAgents` listed other users' runs and `SendMessage{to}` (by name or `uds:<path>`) injected a
    turn into them, unprompted (permission-mode parity) and without Bash. Every Noah-spawned CLI — chat runs,
    the skill-discovery preflight, server-agent runs and their install check — now passes
    `settings: CROSS_SESSION_SETTINGS` (`crossSessionInbound: "refuse"`, `agent/sessionIsolation.ts`), and
    `ListAgents` is in `UNUSED_SDK_BUILTIN_TOOLS`. Splitting config dirs alone would NOT close it (the socket path
    is predictable); in-run agent teams are unaffected (same CLI process, mailbox, not a peer socket). **A new
    `query()` call site passes the same settings.**
  - **Still open (needs uid separation, #71):** the shared data volume (SQLite DB, every user's
    workspaces/clones/transcripts) is readable and writable by any agent Bash; the native CLI binary is
    readable, so a CLI process's environ (its run's shell-exposed vault secrets and model credentials) is
    readable by other agents; a server git child's environ (one call's auth header) is readable while it
    runs; non-node MCP servers keep a readable environ. No hook rule can be the boundary.
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
  child-process env). NOT injected into the SDK subprocess env; `claudeAgent.ts` strips `GIT_TOKEN`/
  `GITHUB_TOKEN`/`GH_TOKEN`-style names from `process.env` before launch and only forwards SSH-specific
  secrets to the hex-ssh subprocess. So the avatar can't `gh repo create`; `create_repo` is the only
  bridge. The prompt surfaces `gitTokenSet` (not the value).
- **The prompt tells the owner how to enable SSH when it's off.** `buildPrompt` adds an SSH enablement
  note on owner, non-headless turns whenever `SSH_PRIVATE_KEY` isn't in `secretNames`. Drops off once
  the key is stored.
- **`sshIdentity`/`sshTrust` shell out to python3** (`pythonExec.ts` centralizes the spawn + timeout).
  They silently depend on the **image carrying python3 + `cryptography` + `paramiko`** (no
  `ssh-keygen`/`ssh-keyscan`). A base-image change breaks them at RUNTIME, not build. A unit test asserts
  the TS `fingerprintOf` and the python SHA256 format agree — keep it green.
- **Server agents (서버 에이전트) reuse the same vault key + per-owner known_hosts** but connect with Noah's own
  ssh2 client (passphrase supported, fail-closed host check, TOCTOU-safe `trustHostWithFingerprint` for the
  settings card) — see [`server-agents.md`](server-agents.md).
- **SSH host-key trust is agent-managed + volume-persistent.** `mcp__ssh_trust__{add,list,remove}_host`
  (sshTrustTools.ts) write a per-owner `known_hosts` under `${dataDir}/ssh/<userId>` (data volume →
  survives restarts), injected into hex-ssh as `KNOWN_HOSTS_PATH` (re-read per connection, so `add_host`
  takes effect mid-session). Fingerprints aren't secrets, so these tools are NOT owner-only.
  `fetchHostKey` uses paramiko (image has no `ssh-keyscan`).
- **Subscription auth is app-wide and admin-managed.** Auth precedence: `.env` `ANTHROPIC_API_KEY` >
  stored subscription token > none. When no API key is set, `claudeAgent.ts` injects the admin-pasted
  `claude setup-token` token (stored under `app_config[CLAUDE_OAUTH_TOKEN_KEY]`) as
  `CLAUDE_CODE_OAUTH_TOKEN` into the SDK subprocess env — decrypted only there, never shown to the agent.
  Managed via `PUT/DELETE /api/admin/claude-token` + the 관리자 ▸ 구독 로그인 card; status surfaces through
  `GET /api/admin/system` (`subscriptionConnected`, `apiKeyOverride`). setup-token tokens are long-lived,
  so there's no refresh logic.
- **External-avatar registry is app-wide and admin-managed.** UI entries are stored as one versioned
  JSON value under encrypted `app_config[external_agents_registry_v1]`; no schema migration is needed.
  `EXTERNAL_AGENTS_JSON` entries remain read-only and take precedence on an ID collision, while the
  remaining managed entries are merged into the live registry on every request. The admin DTO returns
  only `apiKeySet`, never the bearer value. A corrupt/undecryptable registry fails closed. Ciphertext
  identity and the parsed registry are cached per Store instance, so steady-state reads avoid repeating
  synchronous scrypt while a DB change/tamper is still detected on the next request. External IDs are
  immutable: history-bearing entries can be disabled but not deleted, and an endpoint change needs
  explicit confirmation because the next stateless turn sends the complete stored transcript. Existing
  bearer keys are bound to the exact endpoint and cannot be kept across an address change. Each external
  conversation also stores its trusted endpoint; an unapproved env/config re-point fails closed and asks
  the user to start a new conversation instead of forwarding history to the new address. Pre-binding
  legacy rows with `NULL` fail closed instead of adopting the current endpoint. Confirmed managed
  endpoint changes compare-and-swap the encrypted registry and rebind eligible conversation rows in one
  immediate SQLite transaction, so write failure or a concurrent admin update cannot split the two. The
  admin "인증·모델 확인" calls authenticated `/v1/models`, requires at least one Claude model, and
  deliberately does not execute an agent turn or tools. The configured endpoint is separately
  constrained to the exact `/v1/agents/messages` path contract; its SSE stream is validated on the
  first real chat turn.
- **External avatar profile images live OUTSIDE the registry.** Bytes on disk in the same `avatarDir`
  as user photos (stem = the public `external:<id>` avatar id), extension in the
  `external_avatar_images` table (CREATE TABLE IF NOT EXISTS = the migration). Admin-only
  `PUT/DELETE /api/admin/external-agents/:id/image` (works for env entries too — the registry is
  untouched); the public `GET /api/users/:id/avatar-image` route falls back to the external ext
  lookup. `externalAvatarSummary`/`adminExternalAgent` stay pure (`hasImage: false`) — route code
  overlays the stored state (avatars list, avatar detail, admin DTOs). Agent delete manually
  cascades the image row + file. Shared upload validation lives in `_shared.ts`
  (`decodeAvatarImage`/`saveAvatarImageFile`/`deleteAvatarImageFile`, also used by profile photos).
- **`conversations.selected_model` is dual-semantic.** Native conversations store a model TIER alias;
  external conversations store a GATEWAY model id (viewer-picked per conversation, `isSafeExternalModelId`
  charset, cleared→admin default). One column is safe because a conversation is bound to a single avatar
  for life; the chat route branches validation on `externalAgent`. The composer picker's catalog comes
  from viewer-facing `GET /api/avatars/:id/models` (shared visibility helper, `probeExternalAgentGateway`
  behind a 60s per-agent cache in the chat-router closure; native avatars answer `{ models: [] }`). The
  client fetches it EAGERLY per external pane (ChatView reactive loop) because desktop shows composer
  controls inline — the mobile-only settings toggle can't be the fetch trigger. External panes also skip
  the native model/effort default seeding in `makePane` so a tier alias never leaks to the gateway.

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
