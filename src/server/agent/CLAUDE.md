# src/server/agent — Claude notes

Agent orchestration + in-process MCP tool servers. Read with the **root [`CLAUDE.md`](../../../CLAUDE.md)**
(meta-cognition, language split, tool-access gate, pi runtime, MCP-only git) and [`../CLAUDE.md`](../CLAUDE.md). The
detailed mechanics live in **[`../../../docs/architecture/`](../../../docs/architecture/)** —
[`pi-runtime.md`](../../../docs/architecture/pi-runtime.md) (the runner, `/mcp` endpoint, sandbox, relays, sessions),
[`agent-core.md`](../../../docs/architecture/agent-core.md) (run assembly, tool/skill policy, adding an MCP server),
[`chat-sse-media.md`](../../../docs/architecture/chat-sse-media.md) (SSE/sessions, steers, image turns, canvas, share_file),
[`avatar-collab.md`](../../../docs/architecture/avatar-collab.md) (consultation, skill sharing),
[`browser-bridge.md`](../../../docs/architecture/browser-bridge.md) (own 5-page hub),
[`agent-misc.md`](../../../docs/architecture/agent-misc.md) (hex-ssh, slash commands, offline test setup). Index:
[`../../../docs/ARCHITECTURE-NOTES.md`](../../../docs/ARCHITECTURE-NOTES.md).

Durable principles for this layer:

- **One runtime, one entry point.** `index.ts` `runAgentStream` sends every non-`local` run to
  `pi/runPiAgent.ts` (`local` = the deterministic stub, `localRunner.ts`). There is no second runner and no
  fallback: a new run class is a pi run in `piRunPrincipal`'s sandbox, with its restrictions expressed as MCP
  gates and both metacognition surfaces — never as "this class goes somewhere else".
- **A run has TWO halves and they meet at one line.** `runCapabilities.ts` (`buildRunCapabilities`) derives
  everything BEFORE the request is sent — tool access (`deriveAgentToolAccess`), MCP families, the `*Active`
  flags, server builders, `mcpAllowedTools`, the model chain and the prompt stamps (`stampPromptRequest`);
  `runPiAgent` owns the streaming loop and every accumulator. The setup half declares **no `let`** — keep it
  that way, and put new run-scoped mutable state in the loop half. The one backward flow is deliberate and
  typed as an accessor (`currentTextAnchor`, fed by the loop's `anchorText`), because the accumulator it reads
  is RESET at every fold and follow-up turn.
- **The loop half has exactly ONE inbound channel: `AgentEvents.steers`.** Every other member of
  `AgentEvents` is the run calling OUT (even a parked `onQuestion` originates in the loop); a `SteerChannel`
  (`steerChannel.ts`) is the HOST pushing in. pi has no mid-turn input, so the RUN LOOP drains every queued
  steer (and every async `ask_avatar` answer, `pi/asyncJobs.ts`) at the response boundary as ONE follow-up
  turn, and closes the channel at a steer-free boundary and again in `finally`. A run given no channel simply
  cannot be steered; that is how headless and external-task-API runs opt out, and `midTurnMessages` reports it
  on both metacognition surfaces.
- **`ownerState.ts` is the metacognition sync point.** `summarizeOwnerState` returns UNFORMATTED self-state
  DATA consumed by BOTH `buildSystemPromptAppend` (English, frozen per conversation as pi `instructions`) and
  `describe_system` (live tool text); gating + formatting stay at each call site. Add a self-state fact to
  `OwnerState` and BOTH consumers together.
- **Every MCP tool MUST self-gate in its handler.** The `/mcp` endpoint's `allowCall` admits only the run's
  `mcpAllowedTools`, but tools/list is a STATIC catalog (pi freezes a session's tool list while later turns
  carry other capabilities), so the handler is the check that sees the live caller. **Guard conventions
  differ per file BY DESIGN** (owner-only vs elevated vs group-member vs intentionally ungated); don't
  "normalize" them. A formerly read-only run class (untrusted colleague, consultation, generator) has full
  built-ins in its OWN sandbox — the owner's data is protected only here.
- **A new tool means updating BOTH `inProcessMcpServers` AND `mcpAllowedTools`** in `runCapabilities.ts` — two
  hand-synced lists. `mcpAllowedTools` is the endpoint's per-call gate and the "callable now" list
  describe_system reports. Miss one and the model either sees a tool it can't call or calls one that isn't built.
- **A new SERVER also reaches pi's broker** (`docs/architecture/pi-runtime.md`): add its name to
  `PI_NOAH_SERVER_NAMES` + the static catalog build (`pi/mcpCatalog.ts`) AND to `NOAH_MCP_SERVER_NAMES` in
  `scripts/pi-register-mcp.mjs` (a test keeps the two equal); broker ids are GLOBAL per pi instance, so the
  operator re-runs the script. A third-party/process server is never its own id — it rides Noah's relays
  (`pi/mcpProxies.ts`: `hex-ssh`, `plugins`, `shared`). Servers are built with `createMcpToolServer`
  (`mcpServer.ts`), and a child Noah spawns for a relay starts from `piProxyBaseEnv` (`pi/mcpProxies.ts`).
- **A browser op is a bigger commitment than an MCP tool.** Adding one to `browserTools.ts` also means
  `BROWSER_TOOL_NAMES`, `events.ts` (`BrowserRequest`/`BrowserResult`), the `routes/chat.ts` relay +
  audit row, the client `BridgeOperation`/`BridgeReply` (+ its Korean progress label), and
  `extension/background.js` — five layers with no shared types. Raise
  `BROWSER_EXTENSION_MIN_COMPATIBLE` ONLY when the op contract actually breaks (it orders every user to
  reinstall), never merely because the extension folder changed.
- **Don't re-copy shared helpers.** `mcpTools.ts` (`text()`, `decodeRepoFsError`, `decodeExecError`) and
  `repoToolKit.ts` (the guard→resolve→ensureClone→decode skeleton) exist so the ~16 servers
  (`*_SERVER_NAME` consts, plus dynamic per-host ssh servers) don't drift.
- **Prompt assembly is split, and the standing half is FROZEN per conversation.** `buildSystemPromptAppend`
  holds app/tool/self-state standing guidance; it is rendered at the conversation's first pi turn, stored in
  `conversations.pi_instructions` and sent as `instructions` on top of the deployed pi prompt
  (`scripts/pi-system-prompt.md`) whenever a pi session starts. `buildUserPrompt` holds the stored-history
  fallback and the current user/task instruction; per-turn facts (date, run kind, rewind, active repo copy)
  ride `buildPiTurnPreamble` in the turn INPUT. So nothing volatile (a count, a date, a run-kind-specific fact)
  belongs in the append: it would be frozen wrong for the rest of the thread, and one conversation mixes chat,
  routine and task-API turns on ONE session. Live numbers belong in `describe_system` or tool results (the
  pending-request count, the 할 일 counts and KST date), or in the turn input (`/todo` carries its date). The
  할 일 list rides the same write-once pattern (`conversations.todo_snapshot`); never make it refresh mid-thread.
- **`agent-core.test.ts` checks the prompt with `toContain`/`not.toContain` substrings**, not byte-for-byte
  — adding a section is safe; changing an existing string (or its per-viewer presence) breaks a test.
