# Groups, visibility, and trust

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Avatar visibility, the `isTrustedFor`/`shareAnyGroup` choke point, groups, and group shared agents.

## Avatar visibility (2-state) — mechanics
- `users.visibility` = `group` | `private` (the `public` state is RETIRED — avatars never reach beyond
  the owner's avatar-sharing groups); `AvatarVisibility` type in types.ts, default `group` for new
  avatars. `migrateVisibility()` folds legacy states (`'public'`, NULL/`''`, the pre-enum `published`
  flag) into `'group'` idempotently on startup; `rowVisibility()` reads anything non-`'private'` as
  `'group'` and no longer consults `published` (the column survives in old DBs, unread). The discovery
  SQL predicate (`VISIBILITY_WHERE`) and `isVisibleTo` (used by `getAvatar`/`resolveChatAvatar`) gate on
  `visibility` over the `SHARING_TEAMMATES` fragment. Owner-self always bypasses the check. Consequence
  of retiring `public`: for native avatars non-owner reach ⇔ trust — the "visible but read-only
  stranger" viewer class survives only for external avatars; the non-elevated code paths stay as a
  fail-closed floor. UI: a 2-option `seg-control` in `SettingsProfileTab.svelte`
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
  tools: claudeAgent computes `repoWriteAccess = ownerToolAccess || (sharedAccount && elevatedToolAccess)`
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
  ", avatar sharing off" marker per group, and the ask_avatar gates (`claudeAgent` `avatarAskActive`,
  promptBuilder, describe_system — 3 hand-synced sites) require `groups.some(g => g.avatarSharing)`.
  Flipping it off fails the NEXT chat turn closed (history preserved), like leaving the group.

## Group shared agents (그룹 에이전트)
- **Several per group** (`group_agents`, uuid `id` PK + `group_id` index), team avatars that are NOT
  users rows: public avatar id `group:<groupId>:<agentId>` (`external:<id>` precedent —
  `conversations.avatar_user_id` has no FK; conversation summaries COALESCE the display name via a
  `group_agents` LEFT JOIN on the composite id). Pre-multi DBs (`group_id` PK, one agent, avatar id
  `group:<groupId>`) are rebuilt by `migrateGroupAgentsMulti` (store/internal.ts — fresh uuid per row +
  conversation-binding rewrite in one transaction) plus `migrateGroupAgentDiskArtifacts` at boot
  (renames the legacy-named image file/workspace tree; idempotent). Managed by `canManageGroup` via
  `POST/PATCH/DELETE /api/me/groups/:id/agents(/:agentId)` (+`/image`); GET `/api/me/groups` carries
  `agents` (disabled included); discovery concatenates `listGroupAgentsForUser` (enabled only) into
  `GET /api/avatars` with the `AvatarSummary.groupAgent` kind tag (`runtime` stays `"native"` — the
  full local SDK stack). Per-agent DELETE cascades THAT agent's conversations (+ disk sweep: image,
  workspace tree, chat image/file dirs from a pre-cascade snapshot); disable stays the
  thread-preserving alternative. `deleteGroup` cascades every agent the same way.
- **Reach = owning-group membership ONLY** through `findChattableGroupAgent` (the single gate used by
  detail/skills/models/chat): independent of `avatar_sharing` (a knowledge-only group still reaches its
  agent), no sysadmin bypass, fail-closed 403/404 shapes; a member-visible DISABLED agent gets a
  dedicated 403. Each member's threads are PRIVATE (`owner_user_id` = viewer) — the team shares via the
  SECOND BRAIN, never the conversation stream. For the same reason **group-agent threads cannot be
  link-shared** (PPT share links, phase 1): the share route 404s them, `shareableThread` fails any row
  that points into one, the client shows no 공유 링크 control in a group-agent pane, and
  `create_share_link` never registers on a group-agent run ([`share-links.md`](share-links.md)). A share
  link is an export, never a trust source — it does not touch `isTrustedFor`.
- **Run kind carries capability** (`AgentRequest.groupAgent {groupId, agentId, groupName, viewerRole,
  captureAllowed}`): `deriveAgentToolAccess` returns the pinned class (ownerToolAccess false, elevated
  built-ins, hex-ssh `colleague`); `claudeAgent` forces every personal-scoped family off
  (`&& !groupAgentRun` on the tool-group booleans), swaps `ownerState` for `emptyOwnerState` +
  `summarizeGroupAgentState` (BOTH consumers: the group-agent prompt branch AND `describe_system`'s
  `groupAgent` ctx — the metacognition invariant), empties `ownerSecrets` explicitly, and loads only
  default + owning-group plugin roots/memory (`loadGroupAgentPluginRoots`/`loadGroupAgentKnowledgeMemory`).
- **Group tools come from SEPARATE pinned factories** (`buildGroupAgentRepoServer/BrainServer`, same
  server names, no `group` arg, no `list_groups`/`create_repo`; allowedTools uses
  `GROUP_AGENT_REPO_TOOL_NAMES`). Handlers re-check LIVE per call: agent enabled → acting member's
  membership → (writes) `groupAgentCaptureAllowed` = `capture_scope` (`'members'` default | `'admins'`)
  vs role → repo exists. Commits push with the ACTING member's token and identity, audited with a
  `(via group agent)` marker — direct `mcp__group_repo__` writes from personal runs stay admin-only,
  unchanged. The personal-avatar factories are byte-untouched (test-pinned strings).
- **Self-configuration tool** (`agent/groupAgentProfileTools.ts`, server `group_agent`): group-agent
  runs also register `mcp__group_agent__update_profile` — the agent patches its OWN
  persona/alias/bio/intro through `store.updateGroupAgent` (never displayName/enabled/captureScope;
  caps alias 64 / bio 200 / intro 2k / persona 8k). Live per-call gate mirrors the settings route's
  `canManageGroup` (group-admin role OR system admin) **but membership stays REQUIRED even for
  sysadmins** (every in-run group tool fails closed on removal); audited as `group_agent_update`
  (`self-config via update_profile`). Changes bind at the NEXT turn (the prompt is assembled at run
  start) and hit EVERY member's conversations — the prompt branch instructs the agent to confirm that
  before calling. State facts (`GroupAgentState.personaSet`/`selfConfigAllowed`, ownerState.ts) feed
  BOTH the prompt branch and `describe_system` (the metacognition invariant).
- **`capture_scope` is an MCP-LAYER policy, not a filesystem boundary.** The group-knowledge clone is
  one shared tree (`dataDir/group-knowledge/<groupId>`) that any elevated run's Bash/file tools can
  touch, `ensureGroupClone` fast-forwards without hard-reset, and `commitAndPushClone` does
  `git add -A` (locally planted changes can ride along on the next authorized capture). Remote push
  still requires an MCP commit + a member token — but don't describe the capture policy as airtight
  below the tool layer.
- **Group-agent elevation is a DELIBERATE carve-out outside `isTrustedFor`.** Every member of the
  owning group runs the elevated built-in class (auto-approved workspace Bash/Edit) regardless of the
  group's `avatar_sharing` policy — membership itself is the gate (`findChattableGroupAgent`), and the
  practical delta over the member's own always-elevated avatar is small. Keep it justified here rather
  than routed through `isTrustedFor` (which stays the single choke point for PEER trust).
