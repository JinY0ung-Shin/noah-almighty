# Team, visibility, and trust

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The single team (2026-11-06), the 2-state avatar visibility, the `isTrustedFor` choke point, signup
> gating as the team gate, the ONE admin MCP tool policy and the admin shared-skill blocks. Groups are
> RETIRED — their conversion and drop are in [`server-core.md`](server-core.md) ("Groups are RETIRED").

## The single team — mechanics
- **ONE Noah instance = ONE team (user decision 2026-11-06).** Every approved user — an existing `users`
  row with `suspended = 0` — is a teammate; all teammates are equal and mutually trusted (no guest tier,
  no per-avatar trust list, no group). A suspended or not-yet-approved account is no one's teammate.
- **The team relation has ONE definition with a SQL and a TS twin** (`store/avatars.ts`):
  `VIEWER_IS_TEAMMATE` = `EXISTS (SELECT 1 FROM users tm WHERE tm.id = ? AND tm.suspended = 0)` (binds
  ONE param, the viewer id) is embedded by `VISIBILITY_WHERE` (discovery list + search) and
  `LEARNABLE_SKILLS_FROM` (every learnable shared-skill read); `isActiveTeammatePair(a, b)` (two
  distinct ids, both existing, neither suspended) backs `isTrustedFor` and `isVisibleTo`. Keep the two in
  lockstep — reach, trust and skill sharing must never drift apart. It replaced `SHARING_TEAMMATES`
  (the group_members self-join + `groups.avatar_sharing` gate), `shareAnyGroup`, `groupTeammateIds` and
  `sharedGroupNames`, all removed.
- `countTeammates(userId)` = active users other than `userId`. It feeds `OwnerState.teammateCount`
  (`agent/ownerState.ts`, replaced `OwnerState.groups`) and with it the team line on BOTH metacognition
  surfaces: `TEAM_SENTENCE` (one English wording) + `teammateCountPhrase` — the frozen prompt states the
  size as of the conversation's start (and points at describe_system), `describe_system` the live count
  (`- Team: …`). The ask_avatar gate is NOT the team size but `countReachableTeammates(userId)` (active,
  not self, `visibility = 'group'` — a private avatar can't be consulted) → `OwnerState.reachableTeammateCount`
  → `AgentRequest.reachableTeammateCount` (stamped on owner-tool-access runs only); `> 0` at its THREE
  hand-synced sites (`runCapabilities` `avatarAskActive`, promptBuilder `avatarAskEnabled`, the
  describe_system consultation line, which at 0 reads "enabled, but no teammate avatar is reachable (there
  are no other approved teammates, or every teammate's avatar is private)"). `buildPrompt` leaves
  `teammateCount` unset unless `ownerToolAccess` (`AgentRequest.teammateCount` replaced
  `groupMemberships`/`trustedViaGroups`).
- The manual guide is `team` ("Team and avatar collaboration"; renamed from `groups-avatars` in
  `agent/systemManual.ts`); no agent-facing text names groups as a trust/sharing unit any more, except
  the "groups were removed" sentences that answer older frozen prompts (`GROUP_REPOS_RETIRED_SENTENCE`).

## Signup gating — the team gate
- **Signup approval IS joining the team (and with it, trust).** `SignupMode` = `approval` | `closed`
  (`open` is RETIRED 2026-11-06). `getSignupMode()` fails CLOSED to `approval`: only a stored `closed`
  reads as closed; absent, unreadable, or the `open` an older release stored all read as `approval`.
  `PUT /api/admin/signup-mode` rejects `open` (400). The FIRST account is still auto-admin and active;
  every later self-service signup is created suspended with no session (202, the client shows the
  pending-approval notice) until an admin activates it. Never reintroduce a mode that skips approval —
  it would hand trust (`isTrustedFor`) to anyone who can reach Noah.
- Because every signed-in user is now an approved teammate, the share-link "signup is OPEN" audience
  caveat is gone everywhere (`FileOutputToolsContext.signupOpen` removed) — see
  [`share-links.md`](share-links.md).

## Avatar visibility (2-state) — mechanics
- `users.visibility` = `group` | `private` — stored values unchanged (no data migration); `group` now
  means **팀 공개** (every active teammate) and `private` **비공개** (the owner only). The `public` state
  is RETIRED — avatars never reach beyond the team. `AvatarVisibility` type in types.ts, default `group`
  for new avatars. `migrateVisibility()` folds legacy states (`'public'`, NULL/`''`, the pre-enum
  `published` flag) into `'group'` idempotently on startup; `rowVisibility()` reads anything
  non-`'private'` as `'group'` and no longer consults `published` (the column survives in old DBs,
  unread). `VISIBILITY_WHERE` (`suspended = 0 AND (id = ? OR (visibility = 'group' AND
  VIEWER_IS_TEAMMATE))`, binds the viewer id twice) and `isVisibleTo` (used by
  `getAvatar`/`resolveChatAvatar`) are the SQL/TS pair. Owner-self always bypasses the check.
  Consequence: non-owner reach ⇔ trust — the "visible but read-only stranger" viewer class no longer
  exists; the non-elevated code paths stay as a fail-closed floor. A `private` avatar's owner is still a
  trusted teammate (visibility and trust are separate axes) — their avatar just isn't reachable.
- `listPublishedAvatars`/`searchAvatars` return plain `AvatarSummary` rows: every visible non-own avatar
  is a teammate's, so there is no membership flag. UI: a 2-option `seg-control` (팀 공개 / 비공개) in
  `SettingsProfileTab.svelte` (`PATCH /api/me {visibility}` silently skips invalid values); admin
  moderation = `PUT /api/admin/users/:id/visibility` (400s invalid values incl. the retired `public` —
  intentional asymmetry, both pinned in tests). Admin stats count `groupAvatars` (was `publicAvatars`);
  `AdminStats.groups` is gone.

## Trust / elevation — mechanics
- **`isTrustedFor(viewerId, avatarId)` = `isActiveTeammatePair`** (both non-empty, distinct, existing,
  not suspended). It is THE single choke point every elevated/trust check flows through
  (`getAvatar`/`resolveChatAvatar`/`routes/chat.ts` chat `elevated`) — add new trust sources (or
  restrictions) THERE, never at call sites. A trusted viewer chats with a teammate's avatar at the
  OWNER's MCP tool level (pi built-ins still run in the viewer's own sandbox) but never gets the
  owner-only knowledge inbox. The old directional `avatar_trusted_users` table + `/api/me/trusted*` routes
  are long gone (table `DROP`ped in migrate()); `searchUsers` / `GET /api/me/users/search` were removed
  with groups (their only user was the group member-add typeahead).
- **Shared (communal) account (공용 계정)** — `users.shared_account` (per-user settings pattern: column →
  `toUser`/`updateProfile` → `User.sharedAccount` → `PATCH /api/me` → 프로필 탭 공개 설정 카드 토글). When ON,
  trusted teammates chatting with that avatar also get the personal knowledge-repo WRITE tools:
  `buildRunCapabilities` computes `repoWriteAccess = ownerToolAccess || (sharedAccount && elevatedToolAccess)`
  and passes it as `RepoToolsContext.writeAccess` (defaults to `viewerIsOwner`; still headless-gated).
  Scope is DELIBERATELY narrow: `create_repo`, repo connect/disconnect settings (`knowledgeTools`) and
  every other owner-only tool are untouched; a non-elevated viewer stays read-only.
  The write tools' `(owner only)` description suffix is computed per run (`writeGate`) so a shared-account
  teammate turn doesn't self-refuse; `commit` audits the ACTUAL actor (`ctx.viewer`) with a
  `(shared account, owner <username>)` detail when a teammate pushes AND appends a
  `Co-authored-by: <viewer> <username@noah-almighty.local>` trailer (via `commitIdentityFor` on the viewer)
  so git history records the person too — the commit stays authored as the owner. Self-state rides
  `ownerState.sharedAccount` → owner prompt note + teammate-branch writable guidance
  (`promptBuilder`) + a `describe_system` line. Flag lives on the OWNER; toggling it is self-service
  (grants others access to YOUR repo only — no escalation).
- `users.hashtags` is a JSON array of bare tags (`normalizeHashtags`/`parseHashtags` in store.ts) wired
  through the per-user settings pattern, surfaced on BOTH `User` and `AvatarSummary`, edited via
  `HashtagChipEditor.svelte`. Auto-generated like the intro: `POST /api/me/hashtags/generate` mirrors
  `/api/me/intro/generate` (headless, read-only, NOT persisted — parses `#tags` out of the agent reply,
  then `normalizeHashtags`). Searchable in 탐색 (client-side filter in `renderExplore`/`matchesAvatarQuery`)
  AND by the all-viewer read-only `mcp__avatars__search_avatars` MCP (`agent/avatarDirectoryTools.ts`,
  backed by `store.searchAvatars`) — only avatars visible to the viewer, excludes the current avatar.

## Admin MCP tool policy — ONE global policy
- `app_config` key `mcp_tool_policy` (`MCP_TOOL_POLICY_KEY`, encrypted like every app_config value): a
  JSON allowlist of `McpToolGroupId`; ABSENT = no restriction. `getMcpToolPolicy()` normalizes through
  `normalizeMcpToolGroups` (unknown/retired ids dropped, so a policy of only retired ids degrades to `[]`
  — blocking, not failing open); blank or malformed JSON reads as no restriction, as the old per-group
  column did; a value that can no longer be DECRYPTED (rotated `SESSION_SECRET`) fails CLOSED to `[]`
  with a warning (logged once per distinct unreadable stored value — an instance field, not module state),
  so a restriction never silently lifts itself. `setMcpToolPolicy(allowed | null)` stores
  the normalized list or deletes the key.
- `allowedMcpToolGroupsForUser(userId)` keeps its name and signature (callers — `runCapabilities` run
  clamp, `toUser` composer state, the chat/scheduler git-repo gating — never changed) and now returns the
  global policy for EVERY user, run through `effectiveMcpToolGroups` so `system` is always included.
- **Behavior change:** the per-group policy (`groups.allowed_mcp_tool_groups`, a user in several
  policy-bearing groups got the intersection) applied only to members of a policy-bearing group — a user
  in none, including an admin outside every group, was unrestricted. The global policy applies to ALL
  users, admins included. The conversion seeded it with the INTERSECTION of the non-null policies of every
  group with at least one member (fail closed); none → the key stays absent.
- Routes (`requireAdmin`, `routes/admin.ts`): `GET /api/admin/tool-policy` →
  `{ allowedMcpToolGroups: McpToolGroupId[] | null }`; `PUT /api/admin/tool-policy` body
  `{ allowedMcpToolGroups: string[] | null }` — `null` clears, `[]` blocks every optional MCP tool group;
  unknown ids are REJECTED (400, not silently dropped) so an admin typo can't change the policy's meaning;
  audited `set_tool_policy` plus a warn log. UI: 관리자 ▸ 도구·스킬 ▸ MCP 도구 정책
  (`AdminToolPolicyPanel.svelte`, [`client.md`](client.md)). Tests: `tests/routes-admin.test.ts`, `tests/agent-tools.test.ts`.
- Shared (공용) HTTP MCP servers and plugin servers ignore both the composer picker and this policy
  ([`secrets-ssh.md`](secrets-ssh.md)).

## Admin shared-skill blocks
- `shared_skill_blocks (owner_user_id, skill_name, blocked_by, created_at, PRIMARY KEY (owner_user_id,
  skill_name))` — a block removes (owner, skill NAME) from EVERY teammate's learnable reads
  (`LEARNABLE_SKILLS_FROM`'s `NOT EXISTS`); it replaced the per-group `shared_skill_group_blocks`, whose
  rows the conversion copies in (union across groups = fail closed). Name-keyed anti-evasion: never
  deleted except by an explicit unblock, copied (INSERT OR IGNORE) on rename with the old name's block
  left in place. Moderation is SYSTEM-admin only (group admins are retired); UI: 관리자 ▸ 도구·스킬 ▸
  공유 스킬 관리 (`AdminSharedSkillsPanel.svelte`). Mechanics, routes
  (`/api/admin/shared-skills*`, incl. `otherBlocks` for blocks with no live listing) and cascades → [`avatar-collab.md`](avatar-collab.md) ("Admin blocks").
  Tests: `tests/skill-share.test.ts`, `tests/routes-admin.test.ts`.

## Retired
- **Groups (2026-11-06)** — tables `groups`, `group_members`, `shared_skill_group_blocks` (+ indexes),
  the `avatar_sharing`/`allowed_mcp_tool_groups` columns, the group-admin role, every
  `/api/me/groups*` and `/api/admin/groups*` route, `GET /api/me/users/search`, the 그룹 view and the
  per-group avatar-sharing switch (nothing replaces it). One-time conversion (suspend active non-admin
  users outside an avatar-sharing group, policy intersection, blocks copy) and the gated drop →
  [`server-core.md`](server-core.md). Every name is reserved forever.
- **Group shared agents (2026-10-29)** and **group knowledge repositories / team brain (2026-10-30)** were
  retired before groups themselves; the `group:` avatar-id and `group-` workspace prefixes stay reserved
  ([`server-core.md`](server-core.md)).
