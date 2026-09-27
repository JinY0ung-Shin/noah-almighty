# Agent prompt & tools anatomy — what actually reaches the API

How the avatar's request to the Anthropic API is composed, with **measured** sizes
(captured 2026-06, claude CLI v2.1.185 / claude-agent-sdk 0.3.185). Use the capture
script (`scripts/capture-agent-prompt.ts`) to re-measure after SDK/CLI bumps — the
numbers drift.

The API request body has these top-level keys:
`model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`.
The two that hold all the "instructions" are **`system`** and **`tools`** — and they
are SEPARATE. Tool descriptions are NOT in the system prompt.

## `system` = preset + append

Set in `claudeAgent.ts` (`setSystemPrompt`, ~L824):

```js
options.systemPrompt = {
  type: "preset", preset: "claude_code",
  append: buildSystemPromptAppend(promptRequest),
  excludeDynamicSections: true,   // drops the preset's cwd / memory / git-status sections
  snapshot: false,                // render fresh every request (CLI 2.1.267+ replays the first turn's prompt otherwise)
};
```

Final `system` = **Claude Code preset (minus dynamic sections) + the app's append**, in order.

| part | source | ~chars | ~tokens |
|---|---|---|---|
| preset (`claude_code`, dynamic excluded) | compiled into the native `claude` binary | ~2,960 | ~750 |
| append (`buildSystemPromptAppend`, owner + all MCP groups) | this codebase | ~9,900 | ~2,475 |

- The preset opens `You are Claude Code, ... running within the Claude Agent SDK.`
  then security policy, `# Harness`, `# Environment`, `# Context management`.
  `excludeDynamicSections: true` is why cwd/memory/git-status are absent (the app
  supplies its own self-state in the append instead).
- The preset body lives inside the native binary
  (`~/.local/share/claude/versions/<v>`) as a fragmented string table — `strings`
  shows pieces, but the **capture script is the clean way to see the resolved whole**.
- The append is built from ~17 `\n\n`-joined blocks, almost all **conditional** on
  viewer class (owner / trusted / colleague / headless) and which MCP tool groups
  are enabled. The owner + all-groups branch is the maximum; a colleague/read-only
  turn or fewer groups is much shorter. Biggest single block: the **canvas** block
  (~1,950 chars) — and it **duplicates** the `mcp__canvas__show` tool description.

The **user prompt is a separate layer** (`buildUserPrompt`, NOT in `system`):
stored-history fallback (only when there is no `resume` session) + the turn's
`User message:` / `Task instruction:`.

### Manual-based prompt reduction (2026-09)

The measurements above describe the older capture, not the current append. Local avatars now
always have the system MCP group. Their append carries a compact manual topic index, live state,
role/secret/security boundaries and action triggers. Full browser/clipboard, canvas and working-Git
procedures are retrieved with `mcp__system__read_manual` before using those capabilities; usage
and integration questions also trigger lookup. See [agent-core](architecture/agent-core.md#official-product-manual).
This reduces the standing APP APPEND only: the SDK preset and tool schemas/descriptions remain
separate costs, and a retrieved guide consumes context on the turns that need it.

## `tools` = the real token weight

Every tool (built-in AND `mcp__*`) is advertised as one `{name, description, input_schema}`
entry in the request `tools` array — sent on **every** request, cacheable like `system`.

- **MCP tool descriptions come from the 2nd arg of `tool(name, description, schema, handler)`**
  in `src/server/agent/*Tools.ts`. They appear ONLY when the server is registered via
  `options.mcpServers`, which is gated by the enabled MCP tool groups. No registration
  → the tool is absent from `tools` entirely (verified).
- Real `runClaudeAgent` path, owner + all groups: **72 tools = 31 built-in + 41 `mcp__`**,
  tool-description total **~74,000 chars ≈ ~18,500 tokens** — i.e. `tools` dwarfs
  `system` (preset+append together are ~1/5 of it). `Workflow` alone was ~18,800 chars.
- **`allowedTools` does NOT restrict what is advertised** — it is only an auto-approve
  list for the PreToolUse gate. To drop a tool from the advertised set you need
  **`disallowedTools`** (verified: listed tools vanish from `tools`).

### Applied finding (2026-06)

`UNUSED_SDK_BUILTIN_TOOLS` (`src/shared/sdkToolPresentation.ts`) → `options.disallowedTools`
removes full-CLI harness tools the avatar never uses (Workflow, Monitor, DesignSync,
Cron*, Enter/ExitWorktree, ScheduleWakeup, PushNotification, RemoteTrigger;
they duplicate app features or are interactive-CLI-only). Measured effect (when the list
also included SendMessage): 72→61 tools, ~74k→33k chars (**~10,200 tokens/request saved**).
Built-ins kept: Read/Glob/Grep/Bash/Edit/Write/WebFetch/WebSearch/NotebookEdit/
AskUserQuestion/Skill + Task*/Agent/Enter|ExitPlanMode (the orchestration set).
Update (2026-08): `SendMessage` was taken OFF this list to enable agent teams
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — see [`architecture/agent-core.md`](architecture/agent-core.md)); its
description rides along again, and an admin can re-remove it via the tool policy.

## How to capture the real thing

`scripts/capture-agent-prompt.ts` points `ANTHROPIC_BASE_URL` at a local HTTP server,
runs ONE turn with a dummy key, returns HTTP 529 to end fast, and dumps the outgoing
request's `system` + `tools`. Two gotchas it handles:

1. The SDK fires a **session-title** side request first (different, tiny system:
   `You are a Claude agent...`). Filter for the MAIN turn by requiring the system text
   to contain a marker from the append (`Noah Almighty (avatar-chat)`).
2. `real` mode builds a real `Store` + `AppConfig` and calls `runClaudeAgent` (the true
   option assembly, incl. `mcpServers`/`disallowedTools`); `preset` mode runs a bare
   `query()` with just the preset + a given append (no MCP tools) — faster, for diffing
   the preset/append split.

```
npx tsx scripts/capture-agent-prompt.ts real     # full app path (default)
npx tsx scripts/capture-agent-prompt.ts preset    # preset + append only
```
Outputs are written to a temp dir whose path is printed. No real API call leaves the box.
