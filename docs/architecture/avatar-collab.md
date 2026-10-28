# Avatar collaboration — consultation and skill sharing

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> `mcp__avatars__ask_avatar`, `mcp__skill_exchange__*`, and the shared helpers both reuse.

## Avatar consultation (`mcp__avatars__ask_avatar`, #ask-avatar)

- **What it is:** an OWNER-DRIVEN turn (owner chat or owner routine) may ask a **same-group teammate's
  avatar** one question and get its answer back as tool text. Core in `agent/avatarAsk.ts`
  (`askAvatar`), tool + outcome decoding beside `search_avatars` in `avatarDirectoryTools.ts` (same
  `avatars` server + tool group).
- **Gates (in order):** `store.getUserByUsername` → self-refusal → `resolveChatAvatar` (visibility:
  unknown, `private`, group-invisible, and suspended all return the SAME `not_found` so the tool can't
  probe existence) → `isTrustedFor` (= `shareAnyGroup`, the single trust choke point). So a consult
  grants exactly what the asking USER could already get by chatting with that avatar directly — no new
  trust surface.
- **The inner run is the trusted-colleague viewer class**, constructed only in `avatarAsk.ts`:
  `viewerIsOwner: false, elevated: true, headless: true, allowHeadlessTools: true` — `allowHeadlessTools`
  only lifts the headless read-restriction so the target's second-brain recall registers; owner-only
  tools stay locked because `viewerIsOwner` is false (combo pinned in `deriveAgentToolAccess` tests).
  Plus `mcpToolGroups: ["personal_knowledge"]` (recall + `request_info` — the target can escalate a true
  unknown to ITS owner with the asker attributed), the TARGET's plugin roots + knowledge memory,
  `modelFallback: true`, a 3-min wall clock (`AVATAR_ASK_TIMEOUT_MS`), an 8k-char answer cap
  (`AVATAR_ASK_ANSWER_CAP` — the answer is another user's model output entering the asker's context, so
  it's bounded like the directory bio), and the OUTER run's abort signal propagated in.
- **Machine-initiated ⇒ STRICTLY read-only, beyond what a human teammate turn gets** (`consultationRun`
  in claudeAgent.ts): the shared-account write-widening is withheld (`repoWriteAccess`'s
  `sharedAccount && elevatedToolAccess` arm adds `&& !consultationRun` — no human sees the request, so
  no unattended write+commit into a communal repo), plugin MCP servers are NOT lifted at all
  (third-party servers can't self-gate per viewer; registration is their only gate) and neither
  plugin-secret injection nor shell secret exposure happens. The target keeps skills (prompt-level) but
  answers with recall tools only; the consultation prompt branch states the read-only level and the
  `brainSection` "consultation" mode never invites capture, even on a shared account.
- **Per-turn budget:** the tool closure in `avatarDirectoryTools.ts` counts consultations and refuses
  past `AVATAR_ASK_MAX_PER_TURN` (5) — each consult is a full agent subprocess with its own model calls,
  so an unbounded loop would be a cost amplifier on the shared deployment credentials.
- **In-band error results never masquerade as answers:** `runClaudeAgent` doesn't throw on an error
  *result* — it substitutes a Korean fallback into `response.text` (`resultErrorMessage(subtype)`, or
  `EMPTY_SDK_RESPONSE_MESSAGE` for an empty success). `AgentResponse.resultError` now carries the error
  subtype (set only when nothing real streamed), and `askAvatar` maps it to a `failed` outcome — and the
  exported empty sentinel to `empty` — instead of relaying user-facing Korean as the teammate's claim.
- **Depth guard = `AgentRequest.avatarConsultation`:** set only by `askAvatar`. A consultation run never
  registers `ask_avatar` (no A→B→C chains) and takes a dedicated prompt branch — the headless
  consultation framing in `promptBuilder.ts`, NOT the routine one (which would claim owner-level
  permissions this run doesn't have).
- **Registration:** `avatarAskActive` (= `avatars` group enabled && `ownerToolAccess` &&
  `!avatarConsultation`) drives the `allowedTools` entry AND the ctx executor injection byte-identically;
  the tool joins the server's tool list only when the executor is present, and the handler still
  self-gates on `viewerIsOwner`. Timeout on a busy model returns the PARTIAL streamed text in the error.
- **Nothing persists on the target's side** — deliberate: a teammate chatting with your avatar in the UI
  leaves you no transcript either, and the intro/hashtag headless runs persist nothing. The exchange
  lives in the ASKER's conversation; durable retention is the asker's own `brain-ingest` capture (the
  success text nudges it when the asking run has a connected repo). Revisit as an `is_routine`-style
  tagged conversation if target-side auditability is ever wanted.

## Skill sharing between avatars (`mcp__skill_exchange__*` + 스킬 배우기, #skill-share)
- **What it is:** an owner shares skills FROM their knowledge repo (`skills/<slug>/` dirs); teammates
  browse them in the 스킬 배우기 left tab or via `mcp__skill_exchange__find_shared_skills`, and LEARN one —
  the server copies the directory into the learner's repo, registers it in the learner's
  `.claude-plugin/marketplace.json`, and commits+pushes with the LEARNER's identity. Share rows
  (`shared_skills`, store/avatars.ts) are METADATA SNAPSHOTS only; content is read from the sharer's
  clone at preview/learn time (`ensureClone` refresh), so learners always get the current version.
- **What a browser SEES is the OWNER's text and the WHOLE directory, not the frontmatter and one file.**
  Two independent fixes to the same illusion: (1) `shared_skills.custom_description` is the owner's
  human-facing 소개 문구, and the EFFECTIVE description (`custom_description ?? description`) is resolved
  in `toSharedSkill` — the one mapper every read passes through — so the feed, preview header, group
  management list and `find_shared_skills` cannot drift apart; the raw columns ride along as
  `customDescription` (owner UIs distinguish "custom" from "falling back") and `snapshotDescription`.
  That second field exists because the mine RECONCILIATION must keep comparing and writing the SNAPSHOT
  column only (`shareSkill` leaves `custom_description` out of its upsert): comparing the effective text
  would re-snapshot — and re-sort — the row on every tab load once an intro exists. So a custom intro
  survives frontmatter drift and re-shares; UNSHARE deletes it with the row (a later re-share starts
  clean, unlike learn counts and group blocks, which are keyed by skill NAME on purpose). Write path:
  `PUT /api/skill-share/share/:skillName/description` (owner-only by construction — the row is addressed
  by the authenticated id; empty body = clear) and `share_skill`'s optional `description` param, whose
  contract is OMITTED = leave standing, non-empty = replace, explicit `""` = clear. Both REJECT past
  `MAX_SKILL_INTRO_CHARS` (500) rather than clip. (2) The preview route returns a `manifest` alongside the
  SKILL.md — `listSkillFiles` is `copySkillDir`'s traversal minus the copying (symlinks/specials skipped,
  depth-capped, sizes from lstat, no content read), sharing ONE walker with `hashSkillDir` so the three
  can't disagree about what a skill IS. Past the caps it returns what it saw with `truncated` instead of
  failing: such a tree can't be learned either, and an honest partial listing beats an empty one. Both
  preview paths (learnable + the own-share fallback) get it, since they meet before the response.
- **Version updates (전수 후 원본 변경):** every shared_skills row carries a `content_hash` (sha256 of
  the sharer's skill dir via `hashSkillDir`, origin-marker excluded), refreshed wherever the server
  touches the sharer's clone — share, owner reconciliation (mine tab AND the `mcp__repo__commit` hook;
  both ALSO bump updated_at), and teammate preview/learn (`setSharedSkillContentHash`, hash-only so a
  viewer can't reorder the owner's listing). Each learn writes a provenance marker `skills/<slug>/.noah-skill-origin.json`
  (owner id/@username, source skillName, source hash, learnedAt; written LAST so it overwrites any
  marker that reached the copy — chains can no longer START, since a marker-carrying dir is refused at
  share time). The client joins mine.origin.contentHash × listing.contentHash → "업데이트 있음" +
  업데이트 받기; the update path (`learn {updateSlug}` / `learn_skill {update:true}`) replaces the
  learner's copy IN PLACE and is authorized by the origin marker, NOT the directory name — a mismatch
  fails closed (`NOT_LEARNED_FROM_SHARE`). The MCP update resolves the learner's slug from the markers
  (0 → redirect, >1 → ambiguous, ask the user). The marker ALSO records `localHash` (the copy's own
  post-rewrite hash): an update whose copy no longer matches — i.e. the learner CUSTOMIZED it, or a
  legacy marker can't prove otherwise — throws `SKILL_LOCALLY_MODIFIED` until the caller passes
  explicit consent (`overwriteModified` on the route after a danger confirm; `overwrite_modified` on
  the MCP tool after the model asks the user). Git history retains the overwritten customization.
  UNLINK (구독 해지) is the marker's deletion: `unlinkSkillOrigin` (route `POST /api/skill-share/unlink`,
  mine-row 연결 끊기 action, `mcp__skill_exchange__unlink_skill`) commits the removal — the copy stays,
  tracking/badges stop, and re-learning the same share later is a fresh copy.
- **A RENAMED skill directory is followed, not unshared.** Renaming `skills/<a>/` → `skills/<b>/` used
  to look exactly like "deleted a, added b", so the share row (with its 소개 문구, its 전수 history and
  every group block) was pruned and the owner had to re-share under the new name. Now
  `renameSharedSkill` (store/avatars.ts) moves the row IN PLACE in one transaction: same id, same
  `created_at`, same `custom_description`, new slug + fresh snapshot/hash, the old name appended to
  `previous_names` (JSON array, cap 5, most-recent-last, deduped, and never containing the CURRENT
  name — a→b→a leaves just `b`). The two NAME-keyed tables move with it or the rename would silently
  drop them, but ASYMMETRICALLY. `skill_learn_events` is re-keyed by UPDATE, after a DELETE of any
  event already sitting under the target name: the collision guard below proved no live share holds
  it, so those are orphans of a dead share whose name this one takes over, and leaving them would
  inflate the renamed skill's 전수 count forever (the dead share's own count is forfeited once another
  skill claims its name). `shared_skill_group_blocks` is COPIED by `INSERT OR IGNORE` (merging with a
  block already standing at the new name — never lost, never duplicated) and the OLD name's blocks are
  LEFT IN PLACE: blocks are name-keyed anti-evasion that already survive unshare→re-share, so letting
  two `git mv`s clear one would hand every owner a way around a group admin's decision. Only an
  explicit unblock removes a block. A target slug that is ALREADY shared refuses the rename (returns
  null, no side effects) and the caller falls back to unsharing — merging two shares would silently
  pick one row's intro and history over the other's.
- **Detection is GIT EVIDENCE ONLY, and unsharing is always the fallback.** `reconcileOwnerSharedSkills`
  (skillTransfer.ts) is the ONE pass every owner-side path runs — drift → re-snapshot, dir gone →
  unshare, dir now carrying a marker → drain, dir renamed → follow. `resolveSkillDirMoves` reads a
  NEWEST-FIRST timeline of `--name-status -z` diffs (index 0 = the working tree vs HEAD, then
  `git log -n 30`, each diffed against its own parent, parsed lazily) and the first diff carrying an
  event for a directory decides: renamed away → chase the target through NEWER diffs only (chain cap 5;
  a target later created or renamed into yields NOTHING); deleted → deleted; created or renamed-into →
  no evidence, because that incarnation BEGAN there and an older rename of a previous one must never be
  applied to it. Content is corroboration, never the signal: a rename is followed only onto a directory
  that is present, markerless, unclaimed, held by no live row, and either still holding the row's
  `contentHash` or FRESH (absent from the rename commit's parent tree, which is what lets a
  rename-plus-edit follow). Nothing that fails to resolve is guessed at — a rejected rename leaves the
  row on the directory it still names, and unshares only when that directory is gone too. Three cases
  that fall out of this and are pinned by tests: a DELETION is a hard revoke even when a byte-identical
  directory sits elsewhere; `git mv skills/a/SKILL.md` into an existing private directory is refused
  (git calls it a rename, but the target is neither fresh nor hash-matching, and following it would
  publish unshared content); a one-commit swap (a→c, b→a) resolves because renames are applied in
  dependency order, sweeping until nothing more moves. Gotchas: a commit that rewrites SKILL.md enough
  makes git report delete+add, so any renamed file under `skills/<a>/` VOTES for the target (a renamed
  SKILL.md decides alone; scattered files yield nothing) — but only when that directory also LOST its
  SKILL.md (deleted, or taken over by another skill's files), or moving one shared note from `a` to `b`
  would read as renaming `a`;
  `-z` is mandatory, since git QUOTES non-ASCII paths in its textual form and a Korean slug would never
  match the tree; and index 0 stages into a THROWAWAY `GIT_INDEX_FILE` because `move_file` renames with
  `fs.rename` and leaves it unstaged, where a plain `git diff HEAD` would see only the deletion and
  revoke a rename the avatar is about to commit. The pass is a no-op when `repoRoot/.git` is missing
  (a clone mid-rebuild must never read as "every share was deleted") and both owner-side callers hold
  `withRepoLock` around it, since `ensureClone` may be removing the very tree it reads.
- **Learners heal themselves; viewers never reorder.** A learner's origin marker records the source
  name at learn time, so after a rename it names the OLD one. Every place a marker is matched against a
  listing — `learnSkillIntoRepo`'s update authorization, the MCP `learn_skill {update:true}` slug
  resolution, the client's update badge — goes through ONE shared resolver,
  `resolveShareCopy` (`src/shared/skillOriginMatch.ts`): among the copies carrying that OWNER's marker,
  an EXACT match on the share's current name wins outright, and `previousNames` is consulted only when
  there is none. That order is the point — a name a share left behind is free for an unrelated share to
  take, so a trail hit next to an exact hit belongs to that other share. Anything not resolving to
  exactly one copy is ambiguous and fails closed (`NOT_LEARNED_FROM_SHARE`, the MCP "ambiguous"
  redirect, no badge). `learnSkillIntoRepo` rewrites the marker with the CURRENT name, so the trail is
  needed once per learner. The teammate preview/learn paths (route AND
  `mcp__skill_exchange__learn_skill`) run `rescueSharedSkillRename` before pruning — same git evidence
  and corroboration as the owner path, since matching by hash alone could follow a DELETION onto an
  unrelated identical directory — so a stale card serves the renamed skill instead of 404ing; it passes
  `bumpUpdatedAt: false`, the same don't-reorder-the-owner's-listing invariant as
  `setSharedSkillContentHash`.
- **A LEARNED copy is NOT re-shareable while it is linked.** The avatar-discovery boundary must hold for
  CONTENT, not just rows: a learner re-sharing their copy carries the original owner's material to
  teammates the owner never shared it with, duplicates the listing (two cards, one skill), leaves stale
  chains that never see the original's updates, and credits the wrong author. `assertSkillShareable`
  (skillTransfer.ts) is the ONE choke point — throws `SKILL_IS_LEARNED_COPY` (a `SkillIsLearnedCopyError`
  carrying the marker, so callers name the sharer without re-reading it) whenever `skills/<slug>/` still
  has an origin marker — and BOTH share paths call it after the clone is fresh, before the row is
  written: `POST /api/skill-share/share` (409, Korean 연결 끊기 안내) and
  `mcp__skill_exchange__share_skill` (English redirect naming @sharer + both recoveries). UNLINK is the
  deliberate ownership claim that lifts it — 구독 해지 already means "the copy is fully mine" — so the
  recovery is an action the user already has, in the same tab. Rows created BEFORE this rule drain
  WITHOUT an operator or a schema change, through the two hygiene paths that already handle a deleted
  dir: the owner's `mine` reconciliation unshares a row whose dir now carries a marker, and the teammate
  preview/learn path prunes it (`learnSkillIntoRepo` re-applies the same guard to the SOURCE dir, so the
  learn catch prunes on `SKILL_IS_LEARNED_COPY` exactly as on `SKILL_NOT_FOUND`). That guard sits BEFORE
  the `updateSlug` branch, so a pre-existing chain's UPDATE path (업데이트 받기 from a linked source) also
  refuses with `SKILL_IS_LEARNED_COPY` and prunes the row — chains DRAIN rather than keep updating.
  `skill_learn_events` history is keyed by owner+skill_name and survives the unshare, by design.
  A corrupt/unreadable marker reads as NO marker (`readSkillOrigin` → null) and stays shareable: fail
  open, because a copy that makes no provenance claim is the owner's own.
- **The feed includes the viewer's OWN shares** (route merges `listSharedSkillsByOwner` ahead of
  `listLearnableSkills`, mirroring 탐색's "나" card): that's how an owner sees their skill's 전수 count
  in context. The client badges them 나 and drops the learn button; `listLearnableSkills` itself stays
  others-only (it feeds the MCP find tool + the metacognition count). The preview route
  (`available/:id`) falls back to the SAME own-share mapping when `getLearnableSkill` misses, since that
  query excludes self — otherwise 미리보기 on one's own card would 404 (learn stays own-404 by design).
- **Learn counts (전수된 횟수):** every successful learn inserts a `skill_learn_events` row keyed by
  (owner, skill_name) — NOT the share-row id — so counts survive unshare→re-share; recorded at the two
  call sites (route + MCP tool) AFTER copy+commit succeed. Surfaces: `SharedSkill.learnCount`
  (correlated subquery in every shared_skills SELECT), the mine view's per-skill counts
  (`skillLearnCounts` — an unshared skill keeps its history), the tab's "전수 N회" badges, find's
  `learned N×` marker, and describe_system's owner total (`OwnerState.sharedSkillLearnTotal`,
  describe_system-only like gitRepoCount). Learner ids are stored ONLY for the deleteUser cascade
  (both axes purge — product data, not an audit trail); the UI never shows who learned.
- **A GROUP ADMIN can take a member's share out of THEIR group's channel — moderation, not global
  unshare.** An admin owns what circulates in their group, but nothing outside it: they must not be able
  to revoke someone's sharing everywhere, and the owner's own listing is not theirs to edit. So a block is
  a row in `shared_skill_group_blocks` keyed by **(group_id, owner_user_id, skill_name)** — the skill
  NAME, not the share-row id, the same anti-evasion key as `skill_learn_events`: unshare→re-share mints a
  new row that lands ALREADY blocked. The visibility rule is **"at least one mutual sharing group with no
  block"**: `LEARNABLE_SKILLS_FROM`'s teammate test became an `EXISTS` over the shared groups with a
  correlated `NOT EXISTS` block check, so a block subtracts exactly ONE group for exactly ONE
  (owner, skill) — that is the admin's authority radius, and it's why the fragment now diverges from
  `VISIBILITY_WHERE`'s `IN (…)` (the suspended/`group`/SHARING_TEAMMATES half still moves in lockstep;
  avatar visibility itself is never touched). Enforcement is at the STORE QUERY level and so fails closed:
  the learnable listing AND the single-row lookups (`getLearnableSkill`/`getLearnableSkillByName`) are all
  built on that one fragment, so preview/learn by id can't route around a block, and
  `mcp__skill_exchange__find_shared_skills` + the metacognition `learnableSkillCount` follow for free —
  no route logic changed. What a block does NOT do: learned copies stay in learners' repos (the same
  "what crossed the boundary belongs to the receiver" line as `ask_avatar`), the owner's `mine` view and
  their share row are untouched (they are never told which group blocked them), and other groups keep
  carrying the skill. Managed by `canManageGroup` (system admin OR that group's admin) at
  `GET/POST/DELETE /api/me/groups/:id/shared-skills[/blocks…]` in routes/groups.ts, audited as
  `group_skill_block`/`group_skill_unblock`. Cascades: `deleteGroup` drops its blocks (a surviving row
  would also match a recycled group id); `deleteUser` purges blocks where the deleted user is the OWNER
  (their shares vanish anyway) while `blocked_by` DANGLES like `groups.created_by` — a block outlives the
  admin who set it, since dropping it would silently un-moderate a live channel.
- **Reach = avatar discovery, exactly.** `LEARNABLE_SKILLS_FROM` (store/avatars.ts) mirrors
  `VISIBILITY_WHERE` minus the self-exception: not suspended + `visibility='group'` + SHARING_TEAMMATES
  co-membership. A `private` avatar's shares vanish; an `avatar_sharing`-off group grants nothing; your
  own shares are never "learnable" (managed via `listSharedSkillsByOwner`). Keep the two SQL fragments in
  lockstep — the ONLY sanctioned divergence is the per-skill group-channel block above, which narrows the
  teammate relation for one (owner, skill) without touching avatar visibility.
- **Transfer plumbing lives in `skillTransfer.ts`** (server root, NOT knowledgeRepo.ts — it imports both
  knowledgeRepo and agent/skillDiscovery without cycles): `listRepoSkills` (scan `skills/<dir>/SKILL.md`),
  `copySkillDir` (lstat walk — symlinks SKIPPED never followed, 512KB/file + 4MB + 200 files + depth 8
  caps, containment via the exported `resolveInRepo`/`realpathContained`), `learnSkillIntoRepo`
  (ensureClone both → copy → rewrite identity → `ensureMarketplaceManifest` → `commitAndPush`).
  On rename the SKILL.md frontmatter `name:` AND `.claude-plugin/plugin.json` `name` are rewritten (a
  stale frontmatter name would load the skill under the OLD name and collide); a missing plugin.json is
  created (the marketplace entry is unloadable without one).
- **Message-coded errors** in the knowledgeRepo style: `SKILL_NOT_FOUND`/`SKILL_EXISTS`/`INVALID_NAME`/
  `SKILL_FILE_TOO_LARGE`/`SKILL_TOO_LARGE`/`TOO_MANY_FILES`/`SKILL_IS_LEARNED_COPY`. Decoded to Korean in `routes/skillShare.ts`
  (`LEARN_ERROR_KO`, 409 drives the client's rename flow) and to English redirects in
  `skillExchangeTools.decodeLearnError`.
- **Registration:** `skillExchangeActive` (= `avatars` group enabled && `ownerToolAccess`) drives
  `allowedTools` + `mcpServers` byte-identically; every handler ALSO self-gates on `viewerIsOwner`
  (find included — the listing is the OWNER's group view, and a trusted teammate driving this avatar has
  their own avatar for their view). Owner routines keep the tools.
- **Metacognition:** `OwnerState.learnableSkillCount`/`sharedSkillCount` (lazy getters) feed BOTH the
  standing prompt section (promptBuilder, inside the avatars-group block, re-deriving the registration
  gate) and `describe_system`'s "Skill exchange" line. A LEARNED skill only LOADS on the NEXT
  conversation (plugin roots mount at run start), so both surfaces + the learn tool result tell the model
  to `mcp__repo__read_file` the new SKILL.md to apply it immediately.
- **Hygiene:** the owner-side paths share ONE helper — `GET /api/skill-share/mine` and the
  `mcp__repo__commit` hook both call `reconcileOwnerSharedSkills` (dir gone → unshare; marker → drain;
  drifted name/description/hash → re-snapshot; moved → rename), so they cannot drift apart and a
  commit no longer waits for the owner to open the tab. A learn/preview that finds the dir gone first
  tries `rescueSharedSkillRename` and only prunes the stale row when no git evidence explains the move
  (a dir that now carries an origin marker still drains through those SAME paths — see the no-re-share
  bullet). BOTH learn surfaces do the whole dance identically — the HTTP route and
  `mcp__skill_exchange__learn_skill` rescue, refetch by row id, retry once, and prune on a final
  `SKILL_NOT_FOUND`/`SKILL_IS_LEARNED_COPY` — so the tab and the agent never tell different stories
  about a dead share. The commit hook is best-effort and wrapped so a reconcile failure can never fail
  a commit that already pushed. The knowledge-repo PUT clears ALL of the owner's shares on disconnect or repoint
  (`clearSharedSkills` — a same-repo re-save keeps them). `deleteUser` cascades `shared_skills` by owner
  (learned copies are FILES in learners' repos, intentionally untouched — like ask_avatar, what crossed
  the boundary belongs to the receiver).
- **Bundled/plugin skills are deliberately NOT shareable** — everyone already has the default bundle, and
  plugin skills are shared by installing the same plugin; only knowledge-repo skills (what the avatar
  authored/accumulated, incl. `scaffold_skill` output) are listed by `mine`/`share_skill`.

## Shared helpers (don't re-copy)
- **`mcpTools.ts`** — `text(message, isError?)` (the MCP result wrapper), `decodeRepoFsError`
  (INVALID_PATH/FILE_TOO_LARGE/NOT_A_FILE/SKILL_EXISTS sentinels), `decodeExecError(err, {redactToken?,
  fallback?})` (git/gh stderr + `scrubGitError`). Use these; don't reintroduce a local `text()`.
- **`repoToolKit.ts`** — the shared guard→resolve→ensureClone→decode skeleton for skill/file CRUD used by
  `repoTools` (owner-only) and `groupRepoTools` (owner + group + admin-role write gate). `commit` handlers
  and `create_repo` are intentionally NOT folded in. `OWNER_ONLY` here =
  `'This tool can only be used by the avatar owner.'`; **`systemTools` has a DIFFERENT `OWNER_ONLY` string**
  (`…in a conversation the avatar owner is participating in.`).
- **`ownerState.ts`** — `summarizeOwnerState(store, config, avatarUserId): OwnerState` returns UNFORMATTED
  self-state DATA shared by `buildPrompt` (English prompt paragraphs) and
  `systemTools.describe_system` (tool text). This module is the structural sync point for the
  metacognition principle. It returns ungated facts; gating + formatting stay at each call site (e.g.
  `buildPrompt` blanks secrets/groups to `[]` unless `ownerToolAccess`). When you add a self-state fact to
  one consumer, add it to `OwnerState` and the other.
- **Owner identity:** the `AgentOwner` type (`{id, username, displayName, alias?}`) lives in `../types.ts`
  and the descriptor is built ONCE in `runClaudeAgent` and passed to all tool servers. Don't re-declare
  the shape or rebuild the literal per server.
