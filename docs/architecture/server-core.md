# Server core — HTTP, store, settings

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Router layout, the `Store` mixin split, and the per-user / per-conversation settings pattern.

HTTP glue, store, repo plumbing, secrets. Companion to the server-area philosophy in
[`../../src/server/CLAUDE.md`](../../src/server/CLAUDE.md).

## HTTP layout (after the Tier-1/2 refactor)
- **`app.ts` is thin glue.** `createApp` builds middleware + mounts per-domain routers from
  `routes/`. Handlers live in `routes/*.ts` (e.g. `auth`, `profile`, `chat`, `admin`, `browserExtension`, `avatarTasks`, `piAdminProxy`, `sharedMcp`, `skillShare`, `todos`),
  each a `(deps) => Router` factory. Shared route helpers (`apiError`, `safeString`, `looksLikeRepo`,
  `avatarDir`, MIME/size/password consts, `AppServices`) live in `routes/_shared.ts`.
  **`createApp`/`createServices`/`expandChatSlashCommand`/`AppServices` are still imported from `app.ts`**
  (re-exported) — don't change those import paths. No module-level mutable state in routes or services: thread
  it through `deps`.
- **PPT share links** have their own router (`routes/shareLinks.ts`, `createShareLinksRouter`, mounted right
  after the chat router) and store mixin (`store/shareLinks.ts`, `withShareLinks`, composed outermost); their
  cross-mixin cascade `deleteShareLinksForConversation` is declared on `StoreBase` and must sit next to EVERY
  `deleteCanvasArtifactsForConversation` call. Mechanics → [`share-links.md`](share-links.md).
- **할 일 (to-dos)** have their own router (`routes/todos.ts`, `createTodosRouter`, mounted right after
  routines) and store mixin (`store/todos.ts`, `withTodos`, composed outermost). Input validation is the
  pure `src/server/todos.ts` (error CODES), shared with the avatar's `mcp__todo__*` tools; the wire
  types, limits and display order are the import-free `src/shared/todos.ts`. Mechanics →
  [`todos.md`](todos.md).
- Non-obvious route homes: git-token/secrets/ssh-key/git-identity/**knowledge gap-inbox**
  (`/api/me/knowledge/requests`)/**notifications** all live in `routes/knowledgeRepo.ts`;
  **discovery** (`/api/avatars*`) + **conversations** + the **chat SSE** endpoint live in
  `routes/chat.ts`; `/api/audit` lives in `routes/admin.ts`.
- **Router mount order reproduces the original relative route order**
  (auth→profile→plugins→knowledgeRepo→routines→chat→admin; the `groups` router was removed 2026-11-06).
  The error middleware + SPA catch-all must stay LAST. Don't reorder mounts.
- The only shared mutable state across routers is the effective model: threaded as an
  `ObservedModelHolder {get,set}` through `deps` (chat router writes via the `onModel` callback;
  `/api/admin/system` reads it). Don't reintroduce a module-level `let`.

## Store (`store.ts` barrel → `store/*.ts`)
- **`store.ts` is a thin barrel; the `Store` facade is COMPOSED from per-domain mixins** (split 2026-06,
  T3.1). `store/index.ts` builds `const ComposedStore = withTodos(…withAdmin(…withUsers(StoreBase)))`
  and `export class Store extends ComposedStore`; the shared base + schema/migrations + cross-cutting
  helpers (`db`, `secret`, `count`, `addColumnIfMissing`) live in `store/internal.ts` (`StoreBase`),
  and each domain is a `(Base) => class extends Base {…}` mixin in
  `store/{users,avatars,conversations,routines,knowledgeRepo,secrets,admin,…}.ts` (the `groups` mixin was
  removed 2026-11-06). The PUBLIC surface is UNCHANGED — every caller still does `new Store(config)` +
  `store.foo()`, and `./store` re-exports `normalizeHashtags`/`MAX_HASHTAGS`/the `*_KEY` consts. Compose order is irrelevant
  (method names disjoint), one shared `this.db`/`this.secret`. New methods go in the matching domain
  mixin (or `StoreBase` if cross-cutting).
- **`count(sql, …)` is the only count path** (in the base). Don't hand-roll `(… .get() as {c:number}).c`.
- **Row mappers each have a named `*Row` interface** (`UserRow`/`PluginRow`/`RoutineJobRow`/…). New mappers follow that — don't use reflective `Parameters<Store["toX"]>[0]`.
- **The team relation lives in ONE fragment + ONE TS twin** (T3.2, rebuilt for the single team
  2026-11-06): `VIEWER_IS_TEAMMATE` in `store/avatars.ts` (the viewer is an existing, not-suspended user)
  is embedded by `VISIBILITY_WHERE` (list + search share it) and `LEARNABLE_SKILLS_FROM`;
  `isActiveTeammatePair` backs `isTrustedFor` and `isVisibleTo` — so reach, elevation and skill sharing can
  never drift apart, and the `search_avatars` MCP scope automatically matches the browse scope. (It
  replaced the group `SHARING_TEAMMATES` self-join and its four consumers.) → [`team-trust.md`](team-trust.md).
- **Schedule decode lives in ONE place:** `scheduleFromRow` (via `parseDaysOfWeek`, which try/catches
  the `JSON.parse` so a corrupt `days_of_week` row can't abort a scheduler tick). `toRoutineJob` reuses
  it. `create/updateRoutineJob` accept either the legacy flat fields OR a full `RoutineSchedule` object
  (additive, backward-compatible with `{prompt, minuteOfDay}` + NULL `schedule_kind`). When you add a
  schedule field, touch `routineSchedule.ts` + `RoutineJobRow` + this decode together.
- **`deleteUser` does cascade-delete MANUALLY** (no `ON DELETE CASCADE` despite `foreign_keys=ON`), in TWO halves
  that must stay in sync. (1) DB rows: a new user-scoped table needs a matching `DELETE` — in BOTH directions where
  the user can be owner AND subject (e.g. `knowledge_requests` by `avatar_user_id` OR `asker_user_id`) — or it
  orphans rows past "permanent deletion". (2) On-disk namespaces: every `dataDir/<ns>/<userId>` tree (`plugins/`,
  `workspaces/`, `pi-repo-copies/`, the knowledge clone, the ssh-trust dir, the avatar image, per-conversation
  media) and the user's pi sandbox workspace (`<PI_WORKSPACES_DIR>/u-<key>`, pi-runtime.md "Cascades") needs a
  best-effort sweep in the `routes/admin.ts` delete handler. Audit rows are RETAINED by design (`actor_*` dangle,
  like `shared_skill_blocks.blocked_by`).
- **`migrate()` runs on EVERY `new Store()`, so a value-guarded backfill is NOT one-time.** An
  `UPDATE … WHERE col IS NULL` re-fires each boot and clobbers rows the APP later creates NULL on purpose (a fresh
  signup's `onboarded_at`; a user-typed `[예약 작업]` title vanishing from chat). A backfill whose predicate can
  match FUTURE rows MUST be gated on the `PRAGMA user_version` ladder in `store/internal.ts`
  (`CANVAS_BACKFILL_VERSION`, `ONBOARDED_ROUTINE_BACKFILL_VERSION`): check `user_version < N`, run, stamp N.
  Value-guarded migrations that can only ever match OLD rows (git-token move, visibility normalize) may stay
  ungated.
- **Cross-mixin `this.foo()` calls type-check ONLY via the hand-maintained `export interface StoreBase`
  declaration merge** (`store/internal.ts`): a method mixin A adds and mixin B calls needs its signature there
  too. A mixin that overrides `close()` to clear a cache MUST call `super.close()` or the SQLite handle leaks
  (`store/secrets.ts` is the example). Use the shared `count()` / `now()` helpers, never a hand-rolled
  `.get() as {n}` or `new Date().toISOString()`.
- **The retired personal-bot feature is purged at boot, outside `migrate()`, until ONE clean pass.**
  `retirePersonalAgents` (`src/server/retirePersonalAgents.ts` + the `store/retiredPersonalAgents.ts` mixin,
  called from `index.ts` right after `createServices()` — before `createApp`, `listen` and the routine
  scheduler, which would otherwise run a bot-bound routine as the owner) clears what an existing deployment
  still holds (files QUARANTINED, not deleted, after a DB backup — see "Retirement backup and quarantine"
  below): every `personal:`-bound conversation (messages, canvases, share links, task rows,
  notifications) and any other row keyed by a bot avatar id, bot-bound `routine_jobs` rows, then `DROP`s
  `bot_tasks` and `personal_agents`. Disk first: bot avatar images, workspace trees and bot-workspace SDK
  project dirs are found by NAME prefix (`avatars/personal:*`, `workspaces/personal-*`, both spellings of the
  workspaces root), never through row fields; files only the rows can name (each bot thread's chat media, and
  its SDK session artifacts under `agentSessionsDir`, matched by session id because a work-repo thread shares
  its project dir with the owner's runs) are swept while the rows exist. A removal blocked by a read-only
  folder is retried once after making the target and every REAL folder below it owner-writable; links are
  never chmodded or followed. Whatever row-keyed item fails is kept PENDING (`retired:personal_agents:pending`
  in `app_config`: exact-shape paths relative to the current roots plus session ids whose folders could not
  be listed — validated entry by entry and with every ancestor folder lstat-checked before anything is
  removed), written in the purge's own transaction, which throws (a failed purge fails the boot loudly) and
  runs on EVERY pass that finds rows, sweep failures or not. A pass with ZERO failures clears the pending row
  and stamps the `retired:personal_agents` marker in one transaction (read by EXISTENCE, so a SESSION_SECRET
  rotation can't un-mark it; a fresh install is stamped silently on its first boot); until then every boot
  retries and warns with the paths it could not remove. A boot returns at once only when the marker exists,
  no pending row is stored and neither retired TABLE exists — an older release booted after the stamp
  re-creates both, so finding one retires again in the same boot (its purge drops the marker in the same
  transaction; a clean finish stamps it again). That re-run deletes everything under the `personal:` /
  `personal-` names, so those prefixes, the two table names and `routine_jobs.personal_agent_id` stay
  reserved FOREVER. It never touches the `agents/<dir>/` folders the bots left in users' knowledge repos (the
  users' own git content); the unused `routine_jobs.personal_agent_id` column stays on old DBs, like other
  retired columns.
- **The retired external avatars (oh-my-gateway, removed 2026-10-29) are purged at boot the same way.**
  `retireExternalAvatars` (`src/server/retireExternalAvatars.ts` + the `store/retiredExternalAvatars.ts`
  mixin, called from `index.ts` right after `retirePersonalAgents`) deletes ALL external-avatar history (rows
  after the DB backup; files are quarantined, see below)
  (user decision D4 — the old "revocation preserves history" promise is void): every conversation whose
  avatar id starts with `external:` gets `deleteConversation`'s cascade (messages, canvases, share links,
  `avatar_tasks`, notifications, routine rows pointing into it), plus any other row keyed by an `external:`
  avatar id; each thread's `chat-images/`/`chat-files/` media and its server-written workspace copies;
  every `avatars/external:*` profile image and `workspaces/external-*` tree (found by NAME prefix); the
  `external_agents_registry_v1`
  `app_config` row; and `DROP TABLE external_avatar_images`. `conversations.external_endpoint` stays as
  a dead column, like other retired columns. Media dirs that fail to delete are kept PENDING
  (`retired:external_avatars:pending`) and retried every boot; a pass with ZERO failures stamps the
  `retired:external_avatars` marker (read by EXISTENCE). A marked boot returns at once unless a pending
  row exists or the `external_avatar_images` table re-appears (an older release booted after the stamp),
  which re-runs the full purge — so the `external:` prefix, that table name and the registry key stay
  reserved FOREVER. A still-set `EXTERNAL_AGENTS_JSON` is ignored with one boot warning. Tests:
  `tests/retire-external-avatars.test.ts`. The no-follow removal / listing / failure-tally primitives every
  retirement uses (now: the no-follow QUARANTINE move) live in `src/server/retiredFiles.ts`.
- **The retired group shared agents (removed 2026-10-29) are purged at boot the same way.**
  `retireGroupAgents` (`src/server/retireGroupAgents.ts` + the `store/retiredGroupAgents.ts` mixin, called
  from `index.ts` right after `retireExternalAvatars`) deletes ALL group-agent history (decision D4; rows
  after the DB backup, files quarantined — see below): every
  conversation whose avatar id starts with `group:` (`group:<groupId>:<agentId>`, or the pre-multi
  `group:<groupId>`) gets `deleteConversation`'s cascade (messages, canvases, share links, `avatar_tasks`,
  notifications, routine rows pointing into it), plus any other row keyed by a `group:` avatar id
  (`routine_jobs`, `avatar_notifications`, `knowledge_requests`); each thread's `chat-images/`/`chat-files/`
  media, its server-written workspace copies and its SDK session artifacts (matched by session id); every
  `avatars/group:*` profile image, `workspaces/group-*` tree and SDK project folder of a
  `<workspaces>/group-…` cwd (both spellings of the workspaces root, found by NAME prefix). The same purge
  transaction `DROP`s `group_agents`, `group_agents_legacy` and `idx_group_agents_group`. Row-keyed failures
  are kept PENDING (`retired:group_agents:pending`, the personal-bot document shape) and retried every boot;
  a pass with ZERO failures stamps `retired:group_agents` (read by EXISTENCE). A marked boot returns at once
  unless a pending row exists or a retired table re-appears (an older release booted after the stamp), which
  re-runs the full purge — so the `group:` avatar-id prefix, the `group-` workspace prefix, the two table
  names, the index name and both marker keys stay reserved FOREVER. Audit rows are untouched; AdminView keeps the `group_agent_create/delete/update/image` labels for retained
  audit rows. The row-keyed helpers (pending document, session-artifact sweep, name-prefix sweep) are shared
  with the personal-bot retirement in `src/server/retiredSessionFiles.ts`. `migrateGroupAgentsMulti` and the
  boot `migrateGroupAgentDiskArtifacts` rename are gone. Tests:
  `tests/retire-group-agents.test.ts`.
- **Group knowledge repositories are RETIRED (2026-10-30, user decision).** (Groups themselves followed on
  2026-11-06, next entry.) Behind `retirementGate()` (DB backup
  first — `retirementDataPresent` counts a `RETIRED_COLUMNS` entry only while it holds a value), `migrate()`
  drops `groups.knowledge_repo`/`knowledge_branch`/`knowledge_selected`, `users.group_knowledge_off_default`
  and `conversations.group_knowledge_off` (`dropColumnIfPresent`); every name is reserved forever.
  `retireGroupKnowledgeRepos.ts` (boot, after the Craft step) quarantines Noah's clones
  `<dataDir>/group-knowledge` (a path reserved forever) whole into `retired/<stamp>/group-knowledge` and stamps
  `retired:group_knowledge_repos`; a refused move (EXDEV included) is retried next boot. The remote
  repositories are never touched. Removed with it: `groupKnowledgeRepo.ts`, `groupRepoTools.ts`
  (`mcp__group_repo__*`), the `/api/me/groups/:id/knowledge-repo*` routes, `PUT /api/me/group-knowledge-default`,
  group skill roots / group CLAUDE.md in `loadAgentPluginRoots`/`loadKnowledgeRepoMemory`, the
  `group_knowledge` MCP tool group (a saved selection or group policy naming it is filtered by
  `normalizeMcpToolGroups`), the composer's 그룹 지식 toggle and the 그룹 카드 repo section. AdminView keeps
  the `group_repo_*` audit labels for retained rows. A `group-<name>` skill root an older build copied into a
  sandbox is pruned like any unused root (`piSkills.ts`). Tests: `tests/retire-group-knowledge-repos.test.ts`.
- **Groups are RETIRED (2026-11-06, user decision): ONE Noah instance = ONE team.** Every approved
  (not suspended) user is a teammate; trust, visibility and skill sharing ride ONE team relation
  ([`team-trust.md`](team-trust.md)). `migrateSingleTeam()` (`store/internal.ts`, called from `migrate()`
  after `migrateTodoStatuses()` and ABOVE the retirement gate) does the conversion. It runs DELIBERATELY even
  while the gate is HELD (a failed backup): it deletes nothing, and waiting would leave every non-member a
  trusted teammate until a backup succeeds.
  - **Once**, while the marker `single_team:migrated` (`SINGLE_TEAM_MARKER_KEY`, an `app_config` row read by
    EXISTENCE, so a `SESSION_SECRET` rotation can't un-mark it) is absent. A DB with no `groups` table (a
    fresh install) is just stamped (in a transaction that also runs the blocks copy below, should an older
    release have left a `shared_skill_group_blocks` table). Otherwise ONE transaction: M = members of a group whose `avatar_sharing`
    is NULL or != 0; every user with `suspended = 0`, NOT holding the `admin` role and NOT in M is
    SUSPENDED (fail closed — they were outside every team, and approval is now the only way in; with NO
    avatar-sharing group that is every non-admin), their `sessions` rows deleted, and one audit row each
    (`single_team_suspend`, actor NULL / `system`, Korean detail naming `@username`). Suspension also stops
    their routines and their personal API keys (an external integration fails until re-approval). The global
    tool policy `mcp_tool_policy` is seeded with the INTERSECTION of the non-null `allowed_mcp_tool_groups` of
    every group with at least one `group_members` row (fail closed; an empty group's policy restricted no one,
    so it does not count; none → key absent); when written, an audit row `set_tool_policy` (actor NULL /
    `system`, detail `단일 팀 전환: 그룹별 MCP 도구 정책을 하나로 합쳐 전체 정책으로 설정했습니다 = …` or
    `(모두 차단)`). Every `shared_skill_group_blocks` row is copied into `shared_skill_blocks` in the same
    transaction (union across groups = fail closed) and the copy cursor is stamped (below). The marker is
    stamped. After commit, ONE `logger.warn` with `{count, usernames, mcpToolPolicy}`. An admin re-approves
    the suspended users who belong. The schema reads are defensive (missing `group_members` / `avatar_sharing` /
    `allowed_mcp_tool_groups` tolerated).
  - **Later boots** while `shared_skill_group_blocks` still exists (the gate held the drop, or an older
    release re-created it): only rows whose `created_at` is later than the copy cursor are copied
    (`INSERT OR IGNORE`, before the gated drop); NULL-`created_at` rows are skipped. The cursor is the
    `app_config` key `single_team:blocks_copied`, read through its plain `updated_at` (fallback: the marker's
    `updated_at`) and moved by every copy. Why: an UNBLOCK — including of a block an older release created
    after the conversion — must never be undone by a re-copy from the old table.
  - **Behind `retirementGate()`** (end of `migrate()`), only once the marker exists: `DROP INDEX IF EXISTS`
    `idx_shared_skill_group_blocks_skill`, `idx_group_members_user`, `idx_group_members_group`, then
    `DROP TABLE IF EXISTS` `shared_skill_group_blocks`, `group_members`, `groups`. All three tables are in
    `RETIRED_TABLES`, so the pre-retirement DB backup is taken first. The CREATE TABLEs and the
    `addColumnIfMissing("groups", …)` calls are gone; the `RETIRED_COLUMNS` `groups.knowledge_*` entries are
    harmless once the table is gone (`dropColumnIfPresent`/`retirementDataPresent` are table-defensive).
  - **Rollback**: an older release booted after the drop re-creates the group tables EMPTY (every user then
    sits outside any group — trust and visibility collapse until this release is back); on the next boot of
    this release the marker is present, so nothing is suspended again — blocks the older build created are
    copied and the tables dropped again. Consequence: an account created during the rollback comes back
    ACTIVE, i.e. a trusted teammate. The operator must never set signup to `open` on the older release and
    must re-check the user list after re-upgrading (README "Upgrade").
  - **Removed with it**: the `store/groups.ts` mixin, `routes/groups.ts` (`/api/me/groups*`), every
    `/api/admin/groups*` route, `GET /api/me/users/search` + `searchUsers`, `shareAnyGroup`/
    `groupTeammateIds`/`sharedGroupNames`/`SHARING_TEAMMATES`, the types `Group`/`GroupMember`/`GroupRole`/
    `UserGroupMembership`/`AdminGroupSummary`, `User.groups`, the Explore membership flag on `AvatarSummary`,
    `AdminStats.groups`, `OwnerState.groups`, the group-admin role, the per-group avatar-sharing switch
    (nothing replaces it), the signup mode `open`, and the client's 그룹 view. Group-admin powers (members,
    shared-skill blocks) went to the SYSTEM admin: approval is membership, blocks live at
    `/api/admin/shared-skills*` ([`avatar-collab.md`](avatar-collab.md)), the tool policy at
    `/api/admin/tool-policy`. AdminView keeps the `group_*` audit labels for retained rows.
  - **Reserved FOREVER**: the three table names and three index names, the `groups.avatar_sharing` /
    `groups.allowed_mcp_tool_groups` columns, the `/api/me/groups*` and `/api/admin/groups*` paths, the marker
    key `single_team:migrated`, the cursor key `single_team:blocks_copied`, and (already) the `group:` / `group-` prefixes. Tests: `tests/retire-groups.test.ts`.
- **The retired Claude Agent SDK runtime (removed 2026-10-29, decision U8) leaves CLI state behind.** Through
  `retirementGate()` (DB backup first): the `claude_oauth_token` app_config key (the old `claude setup-token`
  subscription token) and the skill-discovery cache key (`skill_discovery_cache`) are deleted and both names are
  reserved forever; `<dataDir>/agent-sessions` (the CLI transcripts, `config.agentSessionsDir` — kept only as the
  path this step reads) is QUARANTINED to `<dataDir>/retired/<stamp>/agent-sessions` by a boot step, never
  deleted, and a clean pass stamps `retired:agent_sessions`. Old CLI session ids and resume points in
  `conversations.agent_session_id` / `messages.sdk_*` are left as they are: the pi runner ignores any value that is
  not a `resp_…` id and starts a new session from the text history.
- **Data directory root must be writable — checked FIRST (#79, 2026-11-06).** The `Store` constructor, right
  after `mkdirSync(dataDir)` and BEFORE the DB opens, runs `assertDataDirWritable` (`store/dataDirWritable.ts`):
  one `mkdtemp` + `rmdir` of `.write-probe-*` in the root. `EACCES`/`EPERM`/`EROFS` → one `logger.fatal`
  (dataDir, code, process uid, owner uid:gid, mode) and `DataDirNotWritableError`, so the boot stops and the
  container restarts; any other error propagates. Why: Docker copies the image's `/app/data` owner into a
  named volume only at creation, so a volume from before the non-root `node` user (2026-06-13) keeps a
  root-owned root — existing uid-1000 files (the DB) kept working and healthchecks passed while every NEW
  subfolder (`backups/` → the gate held forever, `team-brain/`, `pi-repo-copies/`) failed. `setup-host.sh`
  detects the same state on the host before `up` (stat of the compose volume's mountpoint; skips what it
  cannot see). The repair is the operator's, documented in README "Upgrade" → "Data volume ownership"
  (tar backup, then `chown 1000:1000` + `chmod 0755` of the root only); Noah never repairs it, and no root
  step in an entrypoint may touch `APP_DATA_DIR`. Tests: `tests/store-data-dir-writable.test.ts`.
- **Retirement backup and quarantine (user decision 2026-10-29): no retirement ever deletes a FILE, and
  none deletes a ROW before the whole DB is backed up.** One per-boot gate in `StoreBase`
  (`retirementGate()`, helpers in `src/server/store/retirementBackup.ts`) carries a UTC stamp
  (`2026-10-29T03-04-05.678Z-<6 hex>`) shared by both halves:
  - **DB backup.** The gate is asked in the `Store` constructor BEFORE `migrate()` and again by every boot
    purge. When `retirementDataPresent` (read-only, schema-defensive, safe pre-migrate) finds anything a
    retirement would delete — a retired table (`server_agents`, `server_agent_sessions`, `group_agents`,
    `group_agents_legacy`, `external_avatar_images`, `personal_agents`, `bot_tasks`,
    `avatar_trusted_users`, `groups`, `group_members`, `shared_skill_group_blocks`, `direct_messages`), a retired `app_config` key (`server_agents_enabled`,
    `server_agent_deployment_id`, `craft_apps_enabled`, `stt_override`, `external_agents_registry_v1`, the
    three `retired:*:pending` documents), a `personal:`/`external:`/`group:` avatar id in
    `conversations`/`routine_jobs`/`avatar_notifications`/`knowledge_requests`, or a bot-bound routine — the
    first ask copies the DB with `VACUUM INTO` (synchronous, WAL included) to
    `<dataDir>/backups/pre-retire-<stamp>.db`: the file is created empty at 0600 first, the folder 0700 and
    never a link, the copy re-opened read-only and its schema count compared. One `warn` line logs path and
    size. A clean DB, and one whose every retirement already finished, is never backed up. **A failed backup
    HOLDS the boot**: `migrate()` skips every retired drop/delete below its gate, and every boot purge
    (`openRetirementSweep` → null) returns without moving, purging or stamping anything; one `error` line
    says so, the app keeps serving, and the next boot retries with a new stamp. Only the failed attempt's
    own partial file is removed. While held, `listDueRoutineJobs` also skips rows with
    `routine_jobs.personal_agent_id` set, so a bot-bound routine can never fire as its owner. Retired
    external/group threads stay visible until a backup succeeds.
  - **Quarantine.** Every file or tree a retirement removed before is now MOVED by `quarantineRetired`
    (`src/server/retiredFiles.ts`) to `<dataDir>/retired/<stamp>/<path relative to dataDir>`, one
    `rename`, parents created 0700: chat media, server-written workspace copies
    (`quarantineConversationWorkspaceCopies`, `retiredSessionFiles.ts`, run AFTER the name-prefix sweep so
    copies travel with their avatar's tree), SDK session artifacts, avatar images, workspace trees, SDK
    project folders and `runtime/craft-purge`. A link is moved AS a link (never followed, its target
    untouched); a quarantine root or folder on the way that is a link, a target outside `dataDir` or inside
    `backups/`/`retired/` are refused. A folder whose destination this boot already filled (a transcript
    moved by session id, then its project folder by name) is merged entry by entry and only the emptied
    folder is removed. A read-only top folder gets u+w for the rename and its mode back after. **EXDEV is
    never copied and deleted**: the item stays, is counted as a failure (pending list as before, marker
    withheld) with a warning, and later boots retry. The pi runtime's sandbox copies of retired threads
    (`PI_WORKSPACES_DIR`, outside `dataDir`) are left in place: no released build ran a retired kind on pi.
    The ONE sandbox-volume retirement, trusted colleagues' repo copies (`retirePiColleagueRepoCopies`, review #11),
    moves within that volume instead — to `<PI_WORKSPACES_DIR>/.noah-retired/<stamp>/`, which no sandbox mounts
    (pi mounts only `u-<24 hex>`), through pinned folders, never followed; same gate, marker and never-delete rule.
    Noah never prunes `.noah-retired/` either.
  - **Manual cleanup only.** Noah never reads, serves, lists, sweeps or prunes `backups/` or `retired/` (no
    static route reaches `dataDir`, no code lists `dataDir` itself, account deletion sweeps only its named
    per-user namespaces — so a deleted user's data in either folder stays until the operator removes it).
    Both hold FULL user data — conversations, encrypted secrets (readable with the deployment's
    SESSION_SECRET), files — so keep the data volume's permissions owner-only (agent shells run in pi
    sandboxes, which never mount `dataDir`). Restore: stop Noah, replace `noah-almighty.db` (and delete its `-wal`/`-shm`) with the
    backup, move the wanted items from `retired/<stamp>/` back to the same relative paths, start an OLDER
    release (this one would retire them again). Delete when satisfied: `rm -rf <dataDir>/retired/<stamp>
    <dataDir>/backups/pre-retire-<stamp>.db` (a read-only tree inside may need `chmod -R u+w` first).
    Operator text: README "Retirement backups and quarantine". Tests: `tests/retire-backup.test.ts` plus
    the quarantine expectations in every `tests/retire-*.test.ts`.
  - **Human-to-human DM retired (2026-11-06, user decision "쓸데없는 기능").** The 메시지 dock, `/api/dm*`,
    `store/directMessages.ts`, `shared/directMessages.ts`, the `DIRECT_MESSAGE_STATE` self-state line and
    manual topic `direct-messages` are gone; behind the gate `migrate()` runs `DROP TABLE IF EXISTS
    direct_messages` (its `dm_pair`/`dm_unread`/`dm_rate` indexes go with it), and the table is in
    `RETIRED_TABLES`, so every stored message survives only in that boot's backup. `PRESENCE_WINDOW_MS` stays
    (the admin presence badge owns it now). The table, index, route (`/api/dm`) and localStorage
    (`dmDockOpen`, `dmDockPeer`) names are reserved forever.

## Per-user / per-conversation settings mechanics
- **Per-user settings pattern:** add a column to the `users` table + an additive `addColumnIfMissing`
  migration, then mirror it end-to-end
  (`UserRow`→`toUser`→`updateProfile`→`User` type→`PATCH /api/me`→Svelte settings control in the matching
  per-tab component (`SettingsProfileTab`/`SettingsAccessTab`/`SettingsKnowledgeTab`;
  `SettingsView.svelte` is just the tab shell)). A NEW table goes in the always-run schema `db.exec()`
  block (`CREATE TABLE IF NOT EXISTS`) — `addColumnIfMissing` is ONLY for adding a column to an existing table.
- **Per-SECRET settings are the exception to that pattern:** they hang off `user_secrets`, not `users`,
  and go through `PATCH /api/me/secrets/:name` rather than `PATCH /api/me` — the value column stays
  write-only, so the toggle rides the same row (`shell_expose`; `browser_expose`/`browser_hosts`/
  `browser_password_only`). They still surface on `User` (`shellExposedSecretNames`, `browserSecrets`)
  via `toUser`, and a security-relevant one gets its own audit action. Detail →
  [`secrets-ssh.md`](secrets-ssh.md).
- **The composer model/effort/MCP-tool-group pickers remember the owner's last choice** via per-user
  defaults (`users.model_default` / `effort_default` / `mcp_tool_groups_default`). (The group-knowledge
  OFF-sets that once sat next to them — `conversations.group_knowledge_off`,
  `users.group_knowledge_off_default`, `PUT /api/me/group-knowledge-default` — were retired with group
  knowledge repos, see below.) The setter `store.setChatDefaults` + `PUT /api/me/chat-defaults` write
  them; `toUser` exposes `modelDefault`/`effortDefault`/`mcpToolGroupsDefault` (null = never chosen →
  fall back to the hardcoded server default; for MCP, `[]` = explicitly all-off as a remembered
  choice). The client seeds new panes from these in `makePane`; the per-conversation `selected_*` value
  still overrides them when resuming an existing thread.
- **What's-new (release notes) notice (#whats-new):** `src/server/releaseNotes.ts` is the shared registry
  (dependency-free leaf in `tsconfig.client.json`, like `experimentalFeatures.ts`) — **PREPEND an entry**
  (Korean `items`, date-based unique `id`, e.g. `2026-07-29` / same-day `2026-07-29.2`) when deploying
  user-visible changes; ordering comes from array position, never id parsing. Tracking:
  `users.last_seen_release` (NULL = never seen — deliberately NOT backfilled, unlike `onboarded_at`:
  existing accounts are exactly the audience for the one-time notice) → `User.lastSeenRelease`;
  `createUser` seeds signups with the then-current id so day-one accounts see nothing. Client: `App.svelte`
  `enterApp` computes `unseenReleases(user.lastSeenRelease)` (≤`MAX_RELEASES_SHOWN`; an UNKNOWN stored id
  — pruned entry / rollback — counts as never-seen, else it would silence every future note) →
  `WhatsNewModal` (root-mounted next to `OnboardingModal`, which takes precedence) → every dismissal path
  fires `POST /api/me/release-seen` (no body; the SERVER stamps its current id via `markReleaseSeen`)
  fire-and-forget, mirroring onboarding. Don't hand-copy the registry client-side.
