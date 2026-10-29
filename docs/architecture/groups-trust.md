# Groups, visibility, and trust

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Avatar visibility, the `isTrustedFor`/`shareAnyGroup` choke point, and groups.

## Avatar visibility (2-state) — mechanics
- `users.visibility` = `group` | `private` (the `public` state is RETIRED — avatars never reach beyond
  the owner's avatar-sharing groups); `AvatarVisibility` type in types.ts, default `group` for new
  avatars. `migrateVisibility()` folds legacy states (`'public'`, NULL/`''`, the pre-enum `published`
  flag) into `'group'` idempotently on startup; `rowVisibility()` reads anything non-`'private'` as
  `'group'` and no longer consults `published` (the column survives in old DBs, unread). The discovery
  SQL predicate (`VISIBILITY_WHERE`) and `isVisibleTo` (used by `getAvatar`/`resolveChatAvatar`) gate on
  `visibility` over the `SHARING_TEAMMATES` fragment. Owner-self always bypasses the check. Consequence
  of retiring `public`: non-owner reach ⇔ trust — the "visible but read-only stranger" viewer class
  no longer exists (its last carrier, the external avatars, was removed 2026-10-29); the non-elevated
  code paths stay as a fail-closed floor. UI: a 2-option `seg-control` in `SettingsProfileTab.svelte`
  (`PATCH /api/me {visibility}` silently skips invalid values); admin moderation =
  `PUT /api/admin/users/:id/visibility` (400s invalid values incl. the retired `public` — intentional
  asymmetry, both pinned in tests). Admin stats count `groupAvatars` (was `publicAvatars`).

## Trust / elevation — mechanics
- **Trust/elevation is GROUP-ONLY — no per-avatar trust list.** `isTrustedFor` is exactly
  `shareAnyGroup` (symmetric group co-membership); the old directional `avatar_trusted_users` table +
  its store fns (`listTrustedUsers`/`addTrustedUser`/`removeTrustedUser`) + `/api/me/trusted*` routes +
  the 신뢰하는 사용자 settings card are all GONE (table is `DROP`ped in migrate()). To grant elevated tool
  access, add the user to a shared group. `searchUsers`/`GET /api/me/users/search` survive only to
  power the group member-add typeahead. `isTrustedFor` is THE single choke point every elevated/trust
  check flows through (`getAvatar`/`resolveChatAvatar`/`routes/chat.ts` chat `elevated`) — add new trust
  sources THERE, not at call sites.
- **Shared (communal) account (공용 계정)** — `users.shared_account` (per-user settings pattern: column →
  `toUser`/`updateProfile` → `User.sharedAccount` → `PATCH /api/me` → 프로필 탭 공개 설정 카드 토글). When ON,
  trusted same-group teammates chatting with that avatar also get the personal knowledge-repo WRITE
  tools: `buildRunCapabilities` computes `repoWriteAccess = ownerToolAccess || (sharedAccount && elevatedToolAccess)`
  and passes it as `RepoToolsContext.writeAccess` (defaults to `viewerIsOwner`; still headless-gated).
  Scope is DELIBERATELY narrow: `create_repo`, repo connect/disconnect settings (`knowledgeTools`), group
  repo tools, and every other owner-only tool are untouched; a plain (non-group) viewer stays read-only.
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

## Groups
- `groups` + `group_members(role admin|member)` tables (always-run schema). System admin
  creates/deletes groups + assigns group admins (`/api/admin/groups*`); group admins self-serve their
  group's members + repo + policies (`/api/me/groups*`, gated by `canManageGroup` = system admin OR
  group admin). **`isTrustedFor` IS `shareAnyGroup`** → co-members of an AVATAR-SHARING group are
  mutually + SYMMETRICALLY elevated and reach each other's `group`-visible avatars (but NOT each
  other's `private` ones — visibility is a separate axis). Each group has ONE shared **knowledge repo**
  (`groupKnowledgeRepo.ts` mirrors `knowledgeRepo.ts`: full clone at `dataDir/group-knowledge/<groupId>`,
  REUSES its repo-relative file ops; `token` = acting user's `getGitToken`). Members' avatars auto-load
  its skills (`loadGroupKnowledgeRepoRoots`); only group admins edit via the OWNER-ONLY
  `mcp__group_repo__*` server (per-tool role check: member reads, admin
  writes/deletes/moves/commits/`create_repo`). Discovery: `listPublishedAvatars` also returns
  `group`-visible group teammates flagged `sharesGroup`.
- **Per-group avatar-sharing policy** (`groups.avatar_sharing`, `addColumnIfMissing`; NULL/1 = on, 0 =
  off): off makes the group **knowledge-sharing-only** — its co-membership grants NEITHER avatar
  visibility NOR trust/elevation (both ride `SHARING_TEAMMATES`), while the shared repo/brain, tool
  policy (`allowedMcpToolGroupsForUser`), and rosters are untouched. Set via
  `PUT /api/me/groups/:id/avatar-sharing` (`canManageGroup`); echoed on `Group`/`UserGroupMembership`
  (`avatarSharing`). Meta-cognition rides the membership list: groupsSection/describe_system append an
  ", avatar sharing off" marker per group, and the ask_avatar gates (`runCapabilities` `avatarAskActive`,
  promptBuilder, describe_system — 3 hand-synced sites) require `groups.some(g => g.avatarSharing)`.
  Flipping it off fails the NEXT chat turn closed (history preserved), like leaving the group.

## Retired: group shared agents (2026-10-29)
Team avatars that were not users rows (`group_agents`, avatar id `group:<groupId>:<agentId>`) are
removed. A boot purge (`src/server/retireGroupAgents.ts` + `store/retiredGroupAgents.ts`) deletes every
member's thread with one and the files it left, then drops the table; the `group:` avatar-id prefix and
the table names are reserved forever (details in [`server-core.md`](server-core.md)). Groups, their
members, the `avatar_sharing` policy, group knowledge repos and the personal-run
`mcp__group_repo__*` tools are unaffected. `isTrustedFor` is the only elevation
source left — there is no membership-gated carve-out any more.
