# Agent — flags, hex-ssh, slash commands, offline repo tests

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Experimental feature flags, remote SSH, server-expanded slash commands, MCP-only git, and testing repo tools offline.

## Experimental features
- Per-user beta toggles. `canvas` was the first and GRADUATED in 2026-10, so the registry is EMPTY and the
  "실험 기능" card hides itself until the next experiment. Graduating = deleting the registry entry and its
  `includes(key)` gate — the stored key then normalizes away on read, nothing to migrate. Registry in `experimentalFeatures.ts`
  (`{key,name,description}`; name/description KOREAN, shared with the client via `tsconfig.client.json`).
  Wired through the per-user-setting pattern: `users.experimental_features` JSON column →
  `toUser`/`getExperimentalFeatures` → `updateProfile` (normalizes to KNOWN keys) →
  `User.experimentalFeatures` → `PATCH /api/me {experimentalFeatures}` → "실험 기능" card in
  `SettingsAccessTab.svelte`. Self-state in BOTH `buildPrompt` (owner/routine `experimentalFeaturesSection`)
  AND `describe_system` (via `OwnerState.experimentalFeatures`). Gate a feature on
  `ownerState.experimentalFeatures.includes(key)`.

## hex-ssh (remote SSH)
- An APP-managed MCP, not a plugin one. Noah relays it on the `hex-ssh` broker id (`agent/pi/mcpProxies.ts`) only
  when the owner stored `SSH_PRIVATE_KEY` AND the current viewer class has at least one allowed hex-ssh tool
  (`sshActive`). Noah spawns `scripts/hex-ssh-policy-proxy.mjs`, which runs the upstream command from
  `config.hexSshCommand` (`HEX_SSH_COMMAND`, default `hex-ssh-mcp`) and filters `tools/list` by
  `HEX_SSH_ALLOWED_TOOLS`. The per-viewer-class allowlist holds three times: that proxy, the relay pool
  (`allowTool` filters `tools/list` AND refuses `tools/call`), and the `/mcp` endpoint's `allowCall`. Model-facing
  names stay `mcp__hex-ssh__<tool>`. The upstream package is installed into the image at build time, not via
  runtime `npx`.
- **App-managed MCP servers shadow same-named plugin ones.** A plugin's bundled `.mcp.json` declaring `hex-ssh`
  (keyless) must never stand in for the app's keyed one. `stripManagedMcpServers` (plugins.ts,
  `APP_MANAGED_MCP_SERVERS`) removes those names from each plugin `.mcp.json` in `resolvePluginRoots`. For the
  knowledge repo, `commitAndPush` restores tracked `.mcp.json` from HEAD before `git add -A`, so the strip is never
  pushed back.
- **Debugging a relayed MCP server:** Noah spawns it, so a child that fails to start logs
  `pi mcp proxy: upstream failed to start` in the app's pino logs with the first 500 chars of its stderr; the run
  reports that source as not answering on both metacognition surfaces.

## Slash commands (server-expanded)
- **ALL built-in slash commands but one are server-expanded** (`/learn`/`/summarize`/`/remember`/`/routine`/`/find`/`/tour`):
  `src/client/src/lib/slash.ts` carries only metadata (name/title/description/argsLabel/ownerOnly/
  requiresArgs) — no client-side `prompt`, no `serverExpand` flag. The client always sends the literal
  `/command [args]` (chat.ts `submit`); the SERVER `expandChatSlashCommand` (`routes/chat.ts`) swaps in the
  expanded prompt for the model (agent-facing English). The literal stays the bubble + persisted turn; only
  the user-facing `error` strings in `expandChatSlashCommand` stay Korean. The chat handler stores
  `displayMessage` (raw literal) but feeds `agentMessage` (expanded) to `runAgentStream`. `agent-core.test.ts`
  asserts the client bundle carries NO copy of any server expansion. (Skill entries are NOT slash commands —
  the menu sends a Korean natural-language instruction naming the skill, built by `skillToSlashCommand`.)
- **`/tour <slug>` is SPLIT across the boundary on purpose:** `src/shared/tourScenarios.ts` holds the slug
  list + Korean card copy (the client renders the 체험 시나리오 cards from it), while the English walkthrough
  prompts live server-only in `src/server/tourScenarios.ts` — an unknown slug fails with a Korean error
  instead of expanding, and trailing text after the slug rides along as a focus hint like `/learn`'s.
- **The manual `/compact` is retired** (2026-10-29, pi migration): `expandChatSlashCommand` refuses it with a
  Korean `error` exactly like `/new`, and a 다시 생성 of a legacy `/compact` row is refused with that same text (the
  client hides the button via `isCompactCommandText`). Context compaction is pi's own and emits no event Noah can
  show (design P5): no compaction chip. Text reaching pi is plain model input — no slash command runs there.

## git remote work is MCP-only
- The agent shell is the pi sandbox and holds no git credentials, so Bash `git clone/push`/`gh` can never
  authenticate (a sandbox working-repo copy's `.git` is for status/diff/log only; Noah commits and pushes the
  canonical clone, design D1). `GIT_MCP_ONLY_GUIDANCE` (`promptBuilder.ts`) is injected on every tool-capable turn
  telling the avatar to use `mcp__repo__*`/`mcp__git_repo__*`/`mcp__group_repo__*` ONLY and never retry a
  failed MCP git call via Bash; the git tools' failure messages repeat the no-Bash-fallback line with cause
  hints. When adding a git-ish capability, route it through an in-process MCP bridge and keep that line in
  its error text.
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it STANDING
  per-turn guidance (not just the greeting) + an action-trigger in the tool's description + an error that
  redirects (e.g. `NO_REPO` → "use `create_repo`"). Greeting-only text once left it unaware it had
  `create_repo` mid-conversation.

## SSE stream readers: abort must not trust undici
- Lesson from the removed external-avatar runner (`agent/externalAgent.ts`, deleted 2026-10-29), whose
  `readSseFrames` the pi client (`agent/pi/responsesClient.ts`) inherited: race every `reader.read()` against
  the upstream abort signal and reject ITSELF with the abort reason. Relying on undici to reject an
  in-flight body read when the request signal aborts is a race it intermittently loses — observed as
  the idle/total deadline firing while the run hung forever on a quiet socket (a ~1/3 test flake once
  an unrelated 2026-08 change shifted file timing). Map the raced rejection through the same timeout
  classification so user-facing timeout messages stay one set; pre-attach a `.catch` to the never-raced
  promise (unhandled-rejection guard) and remove the abort listener in the generator's `finally`.

## Testing git/repo tools offline
- Point the repo at a LOCAL bare remote (`git init --bare`) so clone/commit/push need no network —
  `gitAuthArgs` returns `[]` for non-`https://` URLs. For `create_repo`, inject a fake `createRemoteRepo`
  or fake `gh` runner; to drive the post-create clone/seed/push offline, have it return a local bare-remote
  PATH as `fullName` (`marketplaceCloneUrl` leaves non-`owner/repo` strings as-is).
