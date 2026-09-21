# Architecture & Operational Notes

Detailed, change-prone reference: file/function/column names, migration mechanics,
refactor history, CSP byte details, test-assertion coupling, and hard-won gotchas.

The `CLAUDE.md` files hold the **durable philosophy and direction**; these pages hold the
**operational detail** behind it. When code moves, update here — the principles in
`CLAUDE.md` should rarely need to change.

**This file is an index, not the content.** Each subsystem lives on its own page under
[`architecture/`](architecture/). Open only the pages whose "read it when" matches what you are
touching — loading all of them at once is the thing this split exists to avoid. The cross-cutting
gotchas at the bottom are the only detail kept inline, because they apply everywhere and are short.

Companion docs: [`DESIGN.md`](DESIGN.md) (design language), [`REFACTORING-BACKLOG.md`](REFACTORING-BACKLOG.md)
(deferred work, `T*` items), [`SECOND-BRAIN-PLAN.md`](SECOND-BRAIN-PLAN.md).

---

## Build, run, verify

| Page | Read it when |
|---|---|
| [build-run-verify.md](architecture/build-run-verify.md) | Running or verifying anything: dev servers and ports, the lint/test/build gate and the rtk caveat, single-test-file runs, Docker + native HTTPS + per-stage CA trust, and the release procedure (including the two browser-extension assets every release must attach). |

## Server (`src/server/`)

Companion to the server-area philosophy in [`../src/server/CLAUDE.md`](../src/server/CLAUDE.md).

| Page | Read it when |
|---|---|
| [server-core.md](architecture/server-core.md) | Touching HTTP glue or persistence: which router owns which route after the Tier-1/2 refactor, how the `Store` facade is composed from per-domain mixins, and the one pattern every per-user / per-conversation setting follows (column → migration → `toUser` → `updateProfile` → type → `PATCH /api/me` → settings tab). |
| [groups-trust.md](architecture/groups-trust.md) | Anything about who can reach whom: the 2-state avatar visibility enum, the `isTrustedFor` = `shareAnyGroup` choke point, the `avatar_sharing` policy, group membership, and group shared agents (`group_agents`, `capture_scope`, self-configuration). |
| [personal-agents.md](architecture/personal-agents.md) | Touching 내 봇 (personal agents): the `personal:<owner>:<agent>` id namespace, the owner-only+admin reach gate, the full-owner-capability run wiring (identity overlay, the never-set-`groupAgent` invariant), routine suppression, caps, and both cascade halves. |
| [repo-knowledge.md](architecture/repo-knowledge.md) | Touching the knowledge repo or any git plumbing shared by the repo families: clone/status/commit internals, the arg-safety validator, and the backfill / `request_info` / second-brain capture mechanics. |
| [secrets-ssh.md](architecture/secrets-ssh.md) | Handling anything credential-shaped: the encrypted vault, per-user git tokens and host routing, SSH identity and trust, sandboxed Python execution, and on-prem GitHub CA wiring. |
| [routines.md](architecture/routines.md) | Working on scheduled runs: the scheduler tick, the job model, and how a routine run differs from an interactive chat turn. |
| [avatar-task-api.md](architecture/avatar-task-api.md) | Touching 외부 작업 API (the personal Bearer-key task API an external system drives the owner's main avatar with): the `avatar_api_keys`/`avatar_tasks` schema, the Bearer-only auth boundary, the 1-second dispatcher and its concurrency/backoff/cancel windows, the `externalTaskApi` provenance stamp, and every prune and cascade. |
| [stt.md](architecture/stt.md) | Touching the composer's mic button or `/api/stt`: the JSON-data-URL-in / multipart-out contract, the validator it mirrors from `chatImages.ts`, the limits that make a self-hosted unauthenticated GPU service safe to sit behind, why the client cannot use `blob:`, and the `STT_URL` engine seam. |
| [direct-messages.md](architecture/direct-messages.md) | Touching human-to-human DM (사용자 간 DM): the `/api/dm` routes and their session-only auth, the `direct_messages` schema and idempotent nonce send, the presence window shared with the admin panel, the read-ack scoping, the bottom-right 메시지 dock, and why DM stays outside every avatar tool. |

## Agent & MCP tools (`src/server/agent/`)

Companion to the agent-area philosophy in [`../src/server/agent/CLAUDE.md`](../src/server/agent/CLAUDE.md).

| Page | Read it when |
|---|---|
| [agent-core.md](architecture/agent-core.md) | Changing how a run is assembled: what `claudeAgent.ts` re-exports and why, the admin builtin tool/skill on-off policy, agent teams, and the **checklist for adding or changing an MCP tool server** (every in-process server must self-gate — the `mcp__` auto-allow fires before the owner check). |
| [avatar-collab.md](architecture/avatar-collab.md) | Working on avatar-to-avatar features: `mcp__avatars__ask_avatar` consultation runs, `mcp__skill_exchange__*` sharing and the copy-into-the-learner's-repo transfer, and the helpers both reuse instead of re-copying. |
| [browser-bridge.md](architecture/browser-bridge.md) | **Its own hub** (5 pages) — the largest subsystem here. Any `mcp__browser__*` op, the AX snapshot format, or the shipped Chrome extension. Start with its `contract.md`. |
| [chat-sse-media.md](architecture/chat-sse-media.md) | Touching the chat turn itself or anything the avatar hands back: SSE sessions and stored history, the background phase and mid-turn user messages (steers), image attachments, `share_file` / PPTX / draw.io delivery, and the visual canvas. |
| [agent-misc.md](architecture/agent-misc.md) | Experimental feature flags, hex-ssh remote SSH, server-expanded slash commands, why git remote work is MCP-only, and how to test repo tools offline. |

## Client (`src/client/` — Svelte + Vite)

Companion to the client-area philosophy in [`../src/client/CLAUDE.md`](../src/client/CLAUDE.md);
design language in [`DESIGN.md`](DESIGN.md).

| Page | Read it when |
|---|---|
| [client.md](architecture/client.md) | Any frontend change: module structure and the central store, the strict same-origin CSP, theme single-source, CSS gotchas, **Svelte 5 runtime gotchas that `svelte-check` does NOT catch**, auto-scroll, split chat, the client↔server contracts mirrored by hand, deliberate behavior gotchas, client verification, and the load-bearing UI-consistency invariants. |

---

## Cross-cutting gotchas

### Env loading
- **`.env` loading is in-code, not dotenv/`--env-file`.** `src/server/loadEnv.ts` calls Node's built-in
  `process.loadEnvFile()` and is the **first import in `index.ts`** (so values land before `auth.ts`
  SECURE_COOKIES / `logger.ts` LOG_LEVEL are read at module-eval). Real env (Docker `-e`, compose, shell
  export) WINS — the file only fills unset keys. Auto-load is **skipped when `NODE_ENV==='test'`** so suites
  use explicit `createServices` overrides. `tsx`/`node` do NOT auto-load `.env` and `--env-file` isn't
  forwarded by `tsx` / allowed in `NODE_OPTIONS`, which is why it's done in code.

### Project name divergence
- Display name "Noah Almighty", code slug `noah-almighty` (package name, `noah-almighty.db`,
  `@noah-almighty.local` git identity fallbacks, logs, test temp-dir prefix), git remote `origin` is
  `noah-almighty` (`github.com/JinY0ung-Shin/noah-almighty`) — but the working dir is `avatar-chat`, and the
  older `avatar-square`/`avatar-chat` slugs still surface in history. Grep both old/new slugs when auditing
  names.

### Worktrees / staging
- `.claude/worktrees/` holds full embedded repo checkouts: exclude them from greps
  (`grep -v '\.claude/worktrees'`) and never `git add -A` (stage files explicitly — `-A` also pulls in
  unrelated pre-existing edits like `.env.example`). When the tree has unrelated pre-existing edits and you
  must commit only your hunks, note `git add -p` is unavailable here: diff → filter hunks by
  `@@ -<oldstart>` → `git apply --cached`, then commit with **NO pathspec** (`git commit -- <file>` commits
  the WORKTREE, ignoring the index).

### Dynamically-created elements
- Share the global stylesheet — avoid bare generic class names (e.g. `main`) on them; they collide with
  layout rules. The activity-tree root once used `class="agent-node main"` and inherited
  `.main { height: 100dvh }`, stretching the box to fill the viewport. Use a scoped name (`is-main`,
  `agent-root`).
