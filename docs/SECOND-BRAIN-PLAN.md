# Second Brain — Implementation Plan (v2)

Evolve the per-user (and per-group) git knowledge repo from a passive skill store into
an active, self-maintaining **second brain** (Karpathy LLM-Wiki + mem0 consolidation +
sleep-time-agent loop): the avatar captures durable knowledge into a structured `wiki/`,
searches it before answering, and (personal only) a nightly pass reflects over the day's
conversations to add/update/prune notes.

Grounded + adversarially verified via multi-agent workflows. Four owner decisions are FINAL:

1. **Group parity** — the group shared repo also becomes a team second brain.
2. **Teammate search = `read_file` read-parity** — trusted same-group teammates may *search* the owner's brain (gate on `elevated`).
3. **Migration via a default bundled `brain-migrate` skill** — brain-* skills are default plugins, not per-repo seeded.
4. **Always-on, no feature flag** — gate on the existing `knowledgeRepoConfigured` (+ `elevatedToolAccess` for reads).

**No DB migrations in any phase.** Confirmed against `knowledgeRepo.ts`, `ownerState.ts`, `types.ts`.

## Guiding principles
- Heavy *procedure* lives in on-demand skills, never in the always-injected `CLAUDE.md`
  (token-capped, rides every turn). `CLAUDE.md` is the map + principles + pointers.
- Reuse existing machinery (`writeRepoTemplate`, the MCP tool template, `repoToolKit`,
  the default-plugin bundle, the routine scheduler) — no parallel systems.
- Ship in phases, each independently mergeable. Phase 2's tool registration and Phase 4's
  prompt trigger must go live **atomically** (a trigger without a tool, or vice-versa, is broken).
- **Group consolidation reads ONLY the group repo's `raw/`+`wiki/`, NEVER conversations**
  (no shared group conversation stream; cross-member reads = privacy violation).

---

## Phase 1 — Vault skeleton + CLAUDE.md kind-param + default brain skills

Zero new MCP servers. Ships via SKILL.md + a `writeRepoTemplate` refactor.

- `src/server/knowledgeRepo.ts`:
  - `writeRepoTemplate(repoRoot, repoName, kind: 'personal'|'group' = 'personal')`.
  - Keep the `marketplace.json` idempotency guard + `{name, plugins: []}` (so existing tests
    `agent-tools.test.ts:1027,1062` stay green — skills are NOT seeded per-repo).
  - Seed vault skeleton in BOTH variants: `raw/.gitkeep`, `wiki/{sources,entities,concepts,synthesis}/.gitkeep`,
    `wiki/index.md`, `wiki/log.md`, `wiki/_template.md`.
  - `repoTemplateClaudeMd(name, kind)`: personal ≤ 6000 (bilingual), group team-framed ≤ 4000.
- `src/server/agent/groupRepoTools.ts:343` → `writeRepoTemplate(repoRoot, result.fullName, 'group')`; brain-vault success message.
- `src/server/agent/repoTools.ts:439` → unchanged (default `'personal'`).
- New default skills (`default-skills/skills/<name>/SKILL.md`, loaded for ALL avatars in chat + routines):
  `brain-ingest`, `brain-reflect` (repo-only in Phase 1), `brain-lint`, `brain-migrate`.

## Phase 2 — Personal brain search (`mcp__brain__*`)

- `src/server/agent/brainSearch.ts` (new): `rankBrainNotes(repoRoot, query, opts?)` — walk
  `wiki/**/*.md`, per-file try/catch (skip `FILE_TOO_LARGE`/unreadable), self-contained
  `parseNoteFrontmatter`, score `title > aliases > tags > body`, stable sort, top-N (default 8, MAX 20).
  Explicit `NO_VAULT` sentinel when neither `wiki/` nor `raw/` exists (distinct from zero matches).
- `src/server/agent/brainTools.ts` (new): `mcp__brain__{search,get_note}`. Resolve repo ONLY
  from `ctx.avatarUserId` (the owner), never the viewer. Gate reads on `ctx.elevated`. No write tool.
- `claudeAgent.ts`: `const brainActive = knowledgeRepoConfigured && elevatedToolAccess;` — same
  boolean in BOTH `allowedTools` and `mcpServers` spreads.
- `promptBuilder.ts`: `brainSection(request)` gated on `knowledgeRepoConfigured !== false`
  (owner + elevated teammate + owner-routine self-state).

## Phase 3 — Personal nightly routine + conversation-read tools (privacy-sensitive server code)

- `src/server/agent/systemTools.ts`: add owner-only `mcp__system__{list_recent_conversations,read_conversation}`
  to `SYSTEM_TOOL_NAMES` + server. Self-gate on `ctx.viewerIsOwner`; scope to `store.listMessages(ctx.avatarUserId, …)`
  (the `ownsConversation` guard returns `[]` for non-owned ids — NEVER add a guard-bypassing variant).
  Register in BOTH lists in `claudeAgent.ts`, gated on `ownerToolAccess`.
- `brain-reflect` SKILL.md: extend the **personal** branch with the conversation-read block;
  GROUP branch keeps "never read conversations".
- Nightly reflection ships as a skill the owner can schedule — NOT an auto-created routine.

## Phase 4 — Group brain search + on-demand reflect + always-on gating + metacognition

- `src/server/agent/groupBrainTools.ts` (new): `mcp__group_brain__{search,get_note}`, mirrors
  `groupRepoTools.ts`. **CRITICAL:** resolve group via `resolveGroup` over `listUserGroups(ctx.avatarUserId)`
  FIRST (→ `NO_SUCH_GROUP`), only THEN `groupKnowledgeRepoContextFor` — calling it directly on a
  model-supplied id = cross-tenant read of another team's repo. Member-read; no admin check for reads.
- `claudeAgent.ts`: `const groupBrainActive = ownerToolAccess && ownerGroups.some(g => g.knowledgeRepoConfigured);`
- `promptBuilder.ts`: extend `groupsSection()` with the team-brain trigger.
- `systemTools.ts` `describe_system`: brain-state lines from existing `state.knowledgeRepoConfigured` + `state.groups`
  (no new OwnerState field — keeps buildPrompt/describe_system parity), checked AFTER the per-conversation
  `personal_knowledge`/`group_knowledge` tool-group toggle so a deselected group reports OFF, like the prompt.

---

## Cross-cutting

- **Language split.** Brain tool descriptions/errors, `CLAUDE.md` structure/principles, SKILL.md
  bodies, `describe_system` brain lines = agent-facing ENGLISH. Korean only for human examples in
  `CLAUDE.md` + the group team README. units/agent-core assert English; app/chat-history assert Korean.
- **`mcpServers` ↔ `allowedTools` byte-identical sync.** One boolean per server, referenced in both lists; pin test per server.
- **Group-consolidation privacy boundary.** Group brain reads only `raw/`+`wiki/`. Membership gate
  (`resolveGroup` over `listUserGroups(ctx.avatarUserId)`) closes the cross-tenant hole.
- **Existing-repo migration safety.** `writeRepoTemplate` never retrofits (manifest guard). `brain-migrate`
  is the only upgrade path: list-before-write, create-if-absent, `<!-- brain:philosophy -->` marker guard for
  the CLAUDE.md read-modify-write append.

## Verification gate
```bash
rtk proxy npx vitest run tests/agent-tools.test.ts
rtk proxy npx vitest run tests/agent-core.test.ts
npx tsc --noEmit
npx svelte-check --tsconfig ./tsconfig.client.json
```

## Resolved open decisions (defaults adopted)
1. No group repo-only nightly routine (routines are single-owner → orphan on leave). On-demand only.
2. Search = keyword/path + frontmatter ranking (no embeddings), default 8 / MAX 20 hits, stable sort.
3. `resolveGroup` copied into `groupBrainTools.ts` (independent testability).
4. Personal `CLAUDE.md` bilingual (English structure + Korean examples).
5. Nightly personal reflection = bundled skill the owner schedules (no auto-created routine).
