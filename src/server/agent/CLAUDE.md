# src/server/agent — Claude notes

Agent orchestration + in-process MCP tool servers. Read with the **root [`CLAUDE.md`](../../../CLAUDE.md)**
(meta-cognition, language split, permission gate, MCP-only git) and [`../CLAUDE.md`](../CLAUDE.md). The
detailed mechanics live in **[`../../../docs/architecture/`](../../../docs/architecture/)** —
[`agent-core.md`](../../../docs/architecture/agent-core.md) (the split, tool/skill policy, adding an MCP server),
[`chat-sse-media.md`](../../../docs/architecture/chat-sse-media.md) (SSE/session resume, image query mode, canvas, share_file),
[`avatar-collab.md`](../../../docs/architecture/avatar-collab.md) (consultation, skill sharing),
[`browser-bridge.md`](../../../docs/architecture/browser-bridge.md) (own 5-page hub),
[`agent-misc.md`](../../../docs/architecture/agent-misc.md) (hex-ssh, slash commands, offline test setup). Index:
[`../../../docs/ARCHITECTURE-NOTES.md`](../../../docs/ARCHITECTURE-NOTES.md).

Durable principles for this layer:

- **`claudeAgent.ts` is the orchestrator and re-exports the split-out symbols** (`promptBuilder.ts`,
  `sdkMessageHandlers.ts`, `preToolUseHook.ts`, `agentUtils.ts`, `runPlan.ts`) so importer paths stay
  stable. Keep the re-export set minimal to the original public surface.
- **A run has TWO halves and they meet at one line.** `runPlan.ts` derives everything BEFORE the stream
  opens (tool access, MCP servers, model chain, the SDK `options` bag); `claudeAgent.ts` owns the
  streaming loop and every accumulator. The setup half declares **no `let`** — keep it that way, and
  put new run-scoped mutable state in the loop half. The one backward flow is deliberate and typed as
  an accessor (`currentTextAnchor`), because the accumulator it reads is REASSIGNED on the empty-turn
  retry — see `docs/architecture/agent-core.md`.
- **The loop half has exactly ONE inbound channel: `AgentEvents.steers`.** Every other member of
  `AgentEvents` is the run calling OUT (even the parked `onPermission`/`onQuestion` asks originate in the
  loop); a `SteerChannel` (`steerChannel.ts`) is the HOST pushing in — it hands over mid-turn user
  messages, the held-open prompt generator yields them into the CLI's stdin, and the loop feeds the
  CLI's `command_lifecycle` frames back through `noteLifecycle`. The RUN LOOP owns its lifetime: it
  closes the channel at a task-free, steer-free `result` boundary and again in the whole
  attempt loop's `finally` — never the generator, so a self-heal retry can rebuild the generator and keep
  consuming. A run given no channel simply cannot be steered; that is how headless and external runs opt
  out, and `midTurnMessages` reports it on both metacognition surfaces.
- **`ownerState.ts` is the metacognition sync point.** `summarizeOwnerState` returns UNFORMATTED self-state
  DATA consumed by BOTH `buildSystemPromptAppend` (English prompt appended to the SDK default system prompt) and `describe_system` (tool text); gating +
  formatting stay at each call site. Add a self-state fact to `OwnerState` and BOTH consumers together.
- **Every MCP tool MUST self-gate in its handler** — the `mcp__`-prefix auto-allow in the PreToolUse hook
  fires BEFORE any owner check. **Guard conventions differ per file BY DESIGN** (owner-only vs elevated vs
  group-member vs intentionally ungated); don't "normalize" them.
- **A new tool means updating BOTH `mcpServers` AND `allowedTools`** in `claudeAgent.ts` — two hand-synced
  lists. Miss one and the model either sees a tool it can't call or calls one it can't see.
- **A browser op is a bigger commitment than an MCP tool.** Adding one to `browserTools.ts` also means
  `BROWSER_TOOL_NAMES`, `events.ts` (`BrowserRequest`/`BrowserResult`), the `routes/chat.ts` relay +
  audit row, the client `BridgeOperation`/`BridgeReply` (+ its Korean progress label), and
  `extension/background.js` — five layers with no shared types. Raise
  `BROWSER_EXTENSION_MIN_COMPATIBLE` ONLY when the op contract actually breaks (it orders every user to
  reinstall), never merely because the extension folder changed.
- **Don't re-copy shared helpers.** `mcpTools.ts` (`text()`, `decodeRepoFsError`, `decodeExecError`) and
  `repoToolKit.ts` (the guard→resolve→ensureClone→decode skeleton) exist so the ~16 servers
  (`*_SERVER_NAME` consts, plus dynamic per-host ssh servers) don't drift.
- **Prompt assembly is split:** `buildSystemPromptAppend` holds app/tool/self-state standing guidance and is
  appended to the SDK's default Claude Code system prompt; `buildUserPrompt` holds stored history fallback and
  the current user/task instruction. Compatibility `buildPrompt` returns both for older tests/importers.
- **`agent-core.test.ts` checks the prompt with `toContain`/`not.toContain` substrings**, not byte-for-byte
  — adding a section is safe; changing an existing string (or its per-viewer presence) breaks a test.
