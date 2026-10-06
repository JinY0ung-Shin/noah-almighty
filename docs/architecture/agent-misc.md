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
- An APP-registered MCP, not a plugin one. `claudeAgent` adds it to `mcpServers` only when the owner stored
  `SSH_PRIVATE_KEY` AND the current viewer class has at least one allowed hex-ssh tool. The registered
  command is `scripts/hex-ssh-policy-proxy.mjs`, which runs the upstream command from
  `config.hexSshCommand` (`HEX_SSH_COMMAND`, default `hex-ssh-mcp`) and filters `tools/list` by
  `HEX_SSH_ALLOWED_TOOLS` before the model sees the schema. The PreToolUse hook separately blocks
  disallowed `mcp__hex-ssh__*` calls, so the proxy is token/UX optimization and the hook is the final gate.
  The upstream package is installed into the image at build time, not via runtime `npx`.
- **App-managed MCP servers shadow same-named plugin ones.** MCP config is keyed by server name, so a
  plugin's bundled `.mcp.json` declaring `hex-ssh` (keyless) can win over the app's keyed one.
  `stripManagedMcpServers` (plugins.ts, `APP_MANAGED_MCP_SERVERS`) removes those names from each plugin
  `.mcp.json` in `resolvePluginRoots` before the SDK sees them. For the knowledge repo, `commitAndPush`
  restores tracked `.mcp.json` from HEAD before `git add -A`, so the strip is never pushed back.
- **Debugging a launched MCP server:** the SDK spawns it as a subprocess, so failures DON'T appear in the
  app's pino logs. Check `~/.cache/claude-cli-nodejs/<workspace>/mcp-logs-<server>/` — the dir name is the
  server name, so it also reveals WHICH instance won a name collision (`hex-ssh` vs `plugin_<plugin>_hex-ssh`).

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
- **`/compact [what to keep]` is the ONE native command: it reaches the CLI VERBATIM.** A slash command only
  runs when it IS the prompt, so `expandChatSlashCommand` returns `compact: {instructions}` instead of an
  expansion, and `claudeAgent` sends exactly `/compact[ <instructions>]` with no `buildUserPrompt` wrapper,
  history or images. Mechanics and gates → [`chat-sse-media.md`](chat-sse-media.md) (native `/compact`
  bullet). Every other text, including a mid-turn message, must never start a CLI command: the steer route
  refuses a `/compact` steer, and a wrapped prompt never starts with `/`.

## git remote work is MCP-only
- The agent shell has no git credentials (stripped from the subprocess env), so Bash `git clone/push`/`gh`
  can never authenticate. `GIT_MCP_ONLY_GUIDANCE` (claudeAgent.ts) is injected on every tool-capable turn
  telling the avatar to use `mcp__repo__*`/`mcp__git_repo__*`/`mcp__group_repo__*` ONLY and never retry a
  failed MCP git call via Bash; the git tools' failure messages repeat the no-Bash-fallback line with cause
  hints. When adding a git-ish capability, route it through an in-process MCP bridge and keep that line in
  its error text.
- **For the avatar to actually USE a capability, greeting-only prompt text isn't enough.** Give it STANDING
  per-turn guidance (not just the greeting) + an action-trigger in the tool's description + an error that
  redirects (e.g. `NO_REPO` → "use `create_repo`"). Greeting-only text once left it unaware it had
  `create_repo` mid-conversation.

## External agent stream: abort must not trust undici
- `readSseFrames` (`agent/externalAgent.ts`) races every `reader.read()` against the upstream
  abort signal and rejects ITSELF with the abort reason. Relying on undici to reject an in-flight
  body read when the request signal aborts is a race it intermittently loses — observed as the
  idle/total deadline firing while the run hung forever on a quiet socket (and as a ~1/3 flake of
  `tests/external-agent.test.ts`'s "times out when an open SSE stream goes idle" once the 2026-08
  bot-tasks work shifted file timing). The raced rejection flows into the same `timeoutKind`
  mapping, so every user-facing timeout message is unchanged. The never-raced promise pre-attaches
  a `.catch` (unhandled-rejection guard) and the generator's `finally` removes the abort listener.

## Testing git/repo tools offline
- Point the repo at a LOCAL bare remote (`git init --bare`) so clone/commit/push need no network —
  `gitAuthArgs` returns `[]` for non-`https://` URLs. For `create_repo`, inject a fake `createRemoteRepo`
  or fake `gh` runner; to drive the post-create clone/seed/push offline, have it return a local bare-remote
  PATH as `fullName` (`marketplaceCloneUrl` leaves non-`owner/repo` strings as-is).
