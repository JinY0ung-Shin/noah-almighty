# Agent prompt & tools anatomy — what reaches the model

How an avatar run's request is composed on pi-gateway, the only agent runtime since the Claude Agent SDK
runner was removed (U8, 2026-10-29). Mechanics live in
[`architecture/pi-runtime.md`](architecture/pi-runtime.md); this page is the size-and-layers view.

## Layers

| Layer | Source | When it is sent | Notes |
|---|---|---|---|
| pi system prompt | `scripts/pi-system-prompt.md`, deployed to the instance as the live prompt `noah` by `scripts/pi-register-mcp.mjs --configure-instance` | pi adds it to every request | ~3.2k chars. Sandbox/environment rules, built-in tool conventions (read/edit/write/grep/find/ls/bash), how to reach Noah tools (`mcp_search`/`mcp_call`), AskUserQuestion, reply language. pi fills `{{WORKSPACE}}`, `{{LANGUAGE}}`, `{{DATETIME}}` |
| Noah `instructions` | `buildSystemPromptAppend` (`agent/promptBuilder.ts`) with `piRuntime` set | rendered at the conversation's FIRST pi turn, frozen in `conversations.pi_instructions`, sent only when a pi session starts (D2) | the standing app guidance + self-state as of conversation start, `piRuntimeSection`, `piSkillsSection`, `piKnownToolsSection` (≈3.4k chars for all Noah tools). A run without a conversation renders it for that run only |
| turn input | `buildPiTurnPreamble` + `buildUserPrompt` | every turn | KST date/time, run kind, rewind provenance, the open repo copy, a new session's reason; then the stored-history fallback (fresh session only, cap `PI_FIRST_TURN_HISTORY_LIMITS`) and the `User message:` / `Task instruction:` |
| tools | pi built-ins + `mcp_search`/`mcp_call` | every request (pi's own) | Noah's ~100 MCP tools are NOT advertised one by one: the model finds them with pi's BM25 `mcp_search` or calls a known name with `mcp_call` ("Tool discovery" in pi-runtime.md) |

Consequences:

- **The `instructions` are D2-stale by design.** Live state is `describe_system`'s job, and the append says so.
  A volatile value in the append is frozen wrong for the rest of the thread — keep per-turn facts in the
  turn input (`src/server/agent/CLAUDE.md`, "Prompt assembly").
- **Tool descriptions cost nothing until searched.** The static catalog's compact descriptions
  (`pi/catalogText.ts`) and the noun-only broker descriptions (`SERVER_DESCRIPTIONS` in
  `scripts/pi-register-mcp.mjs`) are tuned for search recall, not for per-request size.
- **Size guard:** `tests/system-manual.test.ts` keeps the owner + all-groups append under 18 000 characters
  (with and without the vision branch).

## Manual-based prompt reduction (2026-09, still in force)

Local avatars always have the system MCP group. Their append carries a compact manual topic index, live
state, role/secret/security boundaries and action triggers. Full browser/clipboard, canvas and working-Git
procedures are retrieved with `mcp__system__read_manual` before using those capabilities; usage and
integration questions also trigger lookup. See [agent-core](architecture/agent-core.md#official-product-manual).

## History

The 2026-06 measurements on this page described the Claude Code preset + append and the SDK's
per-request `tools` array (72 tools ≈ 18.5k tokens before `disallowedTools` trimming), captured with a
`scripts/capture-agent-prompt.ts` proxy. Both the preset and that script were removed with the SDK runner;
git history keeps the old page.
