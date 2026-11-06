# Team brain (팀 브레인)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The ONE instance-wide shared knowledge vault (back 2026-11-06, after the per-GROUP brain was retired
> 2026-10-30): the local-only git vault, the proposal queue and its confirm cards, the run-class gating,
> both metacognition surfaces, the backup mirror, and the UI.

## Decisions (user, 2026-11-06)
- ONE vault per Noah instance (the instance IS the team). **Local git only** — no `origin`, no user
  tokens, no GitHub permissions involved. Only Noah's own code writes it.
- Teammates **read + propose**; an **admin decides**. An admin's own note skips the queue after one
  consent. Admins decide others' proposals **through their own avatar**.
- Proposals come **only from the avatar** (no UI form). The avatar proactively offers ("팀에 공유할까요?"),
  driven by the four team-knowledge tests; **no frequency limit** (revisit after real-model use).
- Every state change is a **human press on a chat card** (option A — the model only drafts).
- **No delete** op (a wrong note is corrected with an update). **Badges** announce results.
- **Backup** = an admin-set repository on the INTERNAL git host, pushed with THAT admin's own token.
- Design + rejected alternatives: `~/.noah-work/team-brain-2026-11-06/design.md`.

## The vault (`teamBrain.ts`)
- `<dataDir>/team-brain`, branch `main`, created lazily (`ensureTeamBrainRepo`: `git init` + a seed
  `wiki/index.md` commit by the Noah identity). Same note format and **current-truth** rule as the personal
  vault; search (`rankBrainNotes`) and the graph (`buildKnowledgeGraph`) are reused with this root.
- Never handed to a sandbox and never a `.git` the agent can touch: the agent only sees note CONTENT
  through the brain tools. All git runs through `repoGitCore.git()` (serverGitEnv hardening; identity
  via env config, never argv). Every write is under `withRepoLock(teamBrainRoot)` — not reentrant, so
  exported ops take it once.
- `validateTeamNotePath`: a `.md` under `wiki/`, not `wiki/index.md`/`wiki/log.md`/`_template.md`, plain
  path chars only (letters of any script, digits, space, `._-/`), no hidden/empty segment, ≤ 200 chars.
- A failed commit never leaves the note behind: the path is reset and restored from HEAD (or removed for
  a create) under the lock — reads serve the WORKING TREE, so a leftover would publish an unapproved
  note and ride the next approval. The commit itself is path-scoped (`commit -- <path>`).
- `applyTeamNote` re-checks the note's committed blob against the draft's `expectedBlob` UNDER the lock:
  `EXISTS` (create over an existing note), `MISSING` (update of a gone note), `STALE` (changed since) →
  `TeamNoteConflictError`, never an overwrite. Identical content is a no-op (returns HEAD). The commit is
  authored by the presser (`commitIdentityFor`) with `Proposal: <id>` and a `Co-authored-by:` proposer
  trailer.
- `findSecretInText`: the proposer's OWN stored secret values (≥ 6 chars) by name + a few well-known
  token shapes. Accident prevention, not containment.
- `countTeamNotesSync` is describe_system's bounded walk (never follows a link).

## The queue (`team_brain_proposals`, `store/teamBrain.ts`)
- One table: `kind` = `propose` (teammate) | `direct` (admin's own) | `review` (admin's decision on a
  `propose`, `target_id`); `op` = `create` | `update`; `status` per `src/shared/teamBrain.ts`. The
  conversation link is read through a join (todo_items precedent) — no conversation-deleting cascade.
- Caps: 64 KB body, 20 open (draft + pending) rows per user (checked in the insert transaction), drafts
  expire after 7 days OR once their conversation (and so their card) is gone (lazy `expireTeamBrainDrafts`
  before counts/reads/presses — the join stands in for a cascade on every conversation-deleting path). A
  pending proposal whose card is gone is withdrawn from 지식 그래프 → 팀 브레인 → 내 제안.
- `transitionTeamBrainProposal` is compare-and-set on the current status; a review press claims the card
  AND its target in ONE transaction (`teamBrainTransaction`), so two admins pressing at once decide once.
- `isActiveAdmin` / `isActiveUser` judge a PERSON live (exists, not suspended, `admin` role).
- Cascades: `deleteUser` → `deleteTeamBrainProposalsForUser` (approved notes stay in git);
  `applyConversationRewind` → `withdrawTeamBrainDrafts` for the `team_brain` attachments of dropped
  messages (a submitted/applied one stays — a rewind never undoes the world).

## Tools (`agent/teamBrainTools.ts`, on the `brain` server)
- No new MCP server (the 2026-10-29 usability study measured `brain`/`group_brain` confusion): `search`
  and `get_note` take `scope` (`personal`/`team`/`all`, default `all`; a personal ERROR gives way to team
  hits), plus `propose_team_note`, `list_team_proposals`, `get_team_proposal`, `prepare_team_review`.
- No tool changes the vault or a row's status: each one at most creates a `draft` row and calls
  `onCard` (→ `AgentEvents.onTeamBrainCard`, stamped with `currentTextAnchor()`), then returns at once
  ("NOTHING is shared yet") — "no tool call ever waits for approval" holds.
- Admin tools re-check `isActiveAdmin(viewer)` per call. Every teammate-written string an admin's agent
  sees (pending-list titles; a proposal's title, summary and content; the current note) sits inside ONE
  `<untrusted_teammate_text>` wrapper whose closing tag the text cannot forge (`untrusted()` defuses any
  inside). `get_team_proposal` opens only SUBMITTED proposals (pending/approved/rejected) — a draft was
  never shared. Every team read carries `TEAM_NOTE_TRUST_NOTE`.
- `prepare_team_review` with `revisedContent` re-bases on the note AS IT IS NOW (op/blob from the current
  state) — that is how a stale proposal is merged; without it a stale proposal is refused.

## Gating (`runCapabilities.ts`)
| Booleans | Rule |
|---|---|
| `teamBrainReadActive` | `elevatedToolAccess \|\| consultationRun` — every run with a known approved principal |
| `teamBrainProposeActive` | `onTeamBrainCard` sink && `ownerToolAccess` && !consultation && !headless && !externalTaskApi (the share-link shape) |
| `teamBrainAdminActive` | propose && `isActiveAdmin(avatar.id)` — on a propose run the viewer IS the owner, so a teammate chatting with an admin's avatar never gets it |
| `brainServerActive` | `brainActive` (personal) \|\| team read — the server also rides runs with no personal repo; `personalActive` makes personal scope refuse there |
- **No MCP tool group**: a new group would be silently OFF for every user with a saved composer selection
  (`selected_mcp_tool_groups` is an explicit list). Consequence: `brain` is now in every owner run's
  servers (`tests/agent-run.test.ts` pins it).
- The pi catalog builds the widest `brain` (team propose + admin tools); `catalogText.ts` adds discovery
  sentences for `propose_team_note`/`list_team_proposals`.

## Metacognition
- Prompt (`teamBrainSection`, frozen, no counts) on the owner, teammate and consultation branches, keyed on
  `request.teamBrain` (stamped from `caps.teamBrainState`): the read line + trust note always; on a
  propose run also `TEAM_KNOWLEDGE_DEFINITION`, `TEAM_OFFER_TO_SHARE` and the member or `TEAM_ADMIN_FLOW`;
  otherwise "not available in this run".
- The prompt is FROZEN per conversation, so the propose/admin wording is the first turn's: a later routine
  or API turn on the same session, or a role change, can make it overstate. The tool errors and the live
  `describe_system` line stay exact — that is the accepted trade (no volatile text in the frozen part).
- `describe_system` (live): `teamBrainStatusLine` (note count; read-only / can propose + my unseen results
  / ADMIN + pending count) and, for admins, `teamBrainBackupLine`. The old-group line now redirects to the
  team brain (`GROUP_REPOS_RETIRED_SENTENCE`, still needed for older frozen prompts).
- The `team` manual guide has a "The team brain" section; `brain-*` default skills say the team vault is
  separate (ingest may OFFER it; reflect/migrate never touch it).

## Cards and routes (`teamBrainActions.ts`, `routes/teamBrain.ts`)
- A card is a `kind:"team_brain"` `MessageAttachment` (id = proposal id; no file behind it), emitted on the
  `file` SSE event and persisted with the message. `TeamBrainCard.svelte` reads its live state from
  `GET /api/team-brain/cards/:id` — visible ONLY to the row's drafter (an admin decides through their own
  review card, never by pressing a teammate's). Viewing a decided card marks the result seen.
- Presses: `POST …/submit` (propose draft → pending), `…/withdraw` (propose draft/pending → withdrawn;
  direct/review draft → cancelled), `…/apply` (admin; direct → commit; review → target approved/rejected
  + commit on approve). Apply claims first, writes, and RELEASES the claim on a failed write (409 stale /
  500), so the card can be pressed again. Each press is audited (`team_brain_submit|withdraw|direct|
  approve|reject`).
- Reads: `GET /api/team-brain/status` (badge), `/proposals/mine` (marks seen), `/proposals/pending`
  (admin, read-only), `/graph` (`{graph}`), `/note?path=` (`{note}`).

## Backup (`teamBrainBackup.ts`, `AppServices.teamBrainBackup`)
- Settings + status in `app_config` (encrypted): `team_brain_backup` `{url, branch, adminId}` and
  `team_brain_backup_status`. `configure` (PUT `/api/admin/team-brain/backup`) requires `owner/repo` or an
  `https` URL that passes `isInternalGitSource` (fail closed) and `assertSafeGitValue`; the SAVING admin's
  token pushes from then on.
- **Unavailable without an internal host**: `GITHUB_HOST` unset (→ `github.com`) makes `isInternalGitSource`
  accept public github.com and the `owner/repo` shorthand, so `configure` and every push refuse outright.
- Push: debounced 30 s after each commit (`schedule`, timer unref'd) + `POST …/backup/push`;
  `git push -- <url> main:refs/heads/<branch>` under the vault lock — **never `--force`**: only a
  fast-forward lands, so a branch holding history the vault does not know (the mirror after a lost volume,
  a mistyped project repo) is refused with an explanation instead of overwritten. Auth via `gitAuthConfig`
  (env, never argv/disk). Policy, admin status and token are re-checked at PUSH time; failures land in
  `lastError` (admin panel + the admin's describe_system).
- Restore (`POST …/backup/restore`): only into a vault with no notes (re-checked under the lock); clones to a temp dir, drops
  `origin`, refuses symlinks/submodules (`120000`/`160000`) and a mirror without `wiki/`, renames the old
  vault aside (never deleted). The DB is on the same volume — after a lost volume the queue and settings are
  gone too: re-enter the URL, then 복원.
- Tests drive the real push/clone through a temp `GIT_CONFIG_GLOBAL` `url.<file>.insteadOf` rewrite of the
  internal https URL (`tests/team-brain-backup.test.ts`).

## UI
- Team notes render through `renderMarkdown(…, { forbidInlineStyle: true })` — teammate-written HTML must
  not position itself over the app (fake UI); the card shows raw text in `<pre>`.
- 지식 그래프: 내 브레인 / 팀 브레인 tabs; the team tab's side panel (no node selected) lists 내 제안
  (status + rejection reason) and, for admins, 검토 대기 (read-only). The rail badge =
  `unseenResults + pendingReview`, polled with the knowledge watch (`lib/teamBrain.ts`); a toast on growth
  deep-links via the one-shot `brainOpenTeamTab` flag.
- 관리자 → 팀 브레인 (`AdminTeamBrainPanel.svelte`): counts + backup address/branch/status, 지금 백업, 백업에서 복원.
