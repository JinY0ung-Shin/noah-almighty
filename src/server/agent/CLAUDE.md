# src/server/agent — Claude notes

Agent orchestration + Noah's MCP tool servers. Read with the root [`CLAUDE.md`](../../../CLAUDE.md) and
[`../CLAUDE.md`](../CLAUDE.md); mechanics live in [`docs/architecture/`](../../../docs/architecture/) — mainly
[`agent-core.md`](../../../docs/architecture/agent-core.md) (run assembly, tool policy, adding a server),
[`pi-runtime.md`](../../../docs/architecture/pi-runtime.md) (runner, `/mcp`, sandbox, relays),
[`chat-sse-media.md`](../../../docs/architecture/chat-sse-media.md) (SSE, steers, media),
[`avatar-collab.md`](../../../docs/architecture/avatar-collab.md), [`browser-bridge.md`](../../../docs/architecture/browser-bridge.md),
[`agent-misc.md`](../../../docs/architecture/agent-misc.md).

- **One runtime, one entry point.** `runAgentStream` sends every non-`local` run to `pi/runPiAgent.ts`
  (`local` = the deterministic stub, `localRunner.ts`). A new run class is a pi run in `piRunPrincipal`'s sandbox, restricted through MCP gates and both
  metacognition surfaces — never "this class goes somewhere else".
- **A run has TWO halves.** `runCapabilities.ts` (`buildRunCapabilities`) derives everything before the
  request (tool access, MCP families, `*Active` flags, `mcpAllowedTools`, model chain, prompt stamps) and
  declares **no run-scoped `let`** — keep it so; run-scoped mutable state belongs in `runPiAgent`'s loop. The one
  backward flow is a typed accessor (`currentTextAnchor`) because the accumulator resets at every fold.
- **The loop has exactly ONE inbound channel: `AgentEvents.steers`** (`SteerChannel`); every other
  `AgentEvents` member is the run calling OUT. A run given no channel cannot be steered — that is how
  headless and task-API runs opt out, and `midTurnMessages` says so on both metacognition surfaces.
- **Adding a self-state fact:** put it in `OwnerState` (`summarizeOwnerState`, `ownerState.ts`) and render it in
  BOTH `buildSystemPromptAppend` and `describe_system`; gating and formatting stay at each call site.
- **Adding a tool:** update BOTH `inProcessMcpServers` AND `mcpAllowedTools` in `runCapabilities.ts` (miss one
  and the model sees a tool it can't call, or calls one that isn't built); a conditionally built tool keys
  both on the same boolean. The handler MUST self-gate (tools/list is a static catalog pi freezes per
  session — only the handler sees the live caller); guard conventions differ per file BY DESIGN
  (owner / elevated / member / ungated) — don't "normalize" them.
- **Adding a server:** also `PI_NOAH_SERVER_NAMES` + the catalog (`pi/mcpCatalog.ts`) AND
  `scripts/pi-register-mcp.mjs` (a test keeps them equal; broker ids are global per pi instance, `pi-setup`
  re-registers on every `up`). A third-party/process server is never its own id — it rides Noah's relays
  (`pi/mcpProxies.ts`), and a relay child's env starts from `piProxyBaseEnv`. → `agent-core.md`.
- **Adding a browser op is a five-layer change** (`browserTools.ts` + `BROWSER_TOOL_NAMES`, `events.ts`,
  `routes/chat.ts` relay + audit, client bridge + Korean label, `extension/background.js`). Raise
  `BROWSER_EXTENSION_MIN_COMPATIBLE` ONLY when the op contract actually breaks (it orders a fleet reinstall).
- **Don't re-copy shared helpers** — `mcpTools.ts` and `repoToolKit.ts` exist so the servers don't drift.
- **The prompt append is FROZEN per conversation, so nothing volatile goes in it.** `buildSystemPromptAppend`
  (standing guidance + self-state, stored once in `conversations.pi_instructions`) is reused across chat,
  routine and task-API turns on one session. Per-turn facts ride the turn input (`buildPiTurnPreamble`);
  live numbers belong in `describe_system` or tool results. The 할 일 snapshot follows the same write-once
  rule.
- **Prompt tests pin substrings** (`agent-core.test.ts` `toContain`): adding a section is safe; changing an
  existing string or its per-viewer presence breaks a pin.
