# Server core — HTTP, store, settings

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Router layout, the `Store` mixin split, and the per-user / per-conversation settings pattern.

HTTP glue, store, repo plumbing, secrets. Companion to the server-area philosophy in
[`../../src/server/CLAUDE.md`](../../src/server/CLAUDE.md).

## HTTP layout (after the Tier-1/2 refactor)
- **`app.ts` is thin glue.** `createApp` builds middleware + mounts per-domain routers from
  `routes/`. Handlers live in `routes/{auth,profile,directMessages,plugins,knowledgeRepo,groups,routines,chat,admin}.ts`,
  each a `(deps) => Router` factory. Shared route helpers (`apiError`, `safeString`, `looksLikeRepo`,
  `avatarDir`, MIME/size/password consts, `AppServices`) live in `routes/_shared.ts`.
  **`createApp`/`createServices`/`expandChatSlashCommand`/`AppServices` are still imported from `app.ts`**
  (re-exported) — don't change those import paths.
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
  (auth→profile→plugins→knowledgeRepo→groups→routines→chat→admin). The error middleware + SPA
  catch-all must stay LAST. Don't reorder mounts.
- The only shared mutable state across routers is the effective model: threaded as an
  `ObservedModelHolder {get,set}` through `deps` (chat router writes via the `onModel` callback;
  `/api/admin/system` reads it). Don't reintroduce a module-level `let`.

## Store (`store.ts` barrel → `store/*.ts`)
- **`store.ts` is a thin barrel; the `Store` facade is COMPOSED from per-domain mixins** (split 2026-06,
  T3.1). `store/index.ts` builds `const ComposedStore = withGroups(withAdmin(…withUsers(StoreBase)))`
  and `export class Store extends ComposedStore`; the shared base + schema/migrations + cross-cutting
  helpers (`db`, `secret`, `count`, `addColumnIfMissing`) live in `store/internal.ts` (`StoreBase`),
  and each domain is a `(Base) => class extends Base {…}` mixin in
  `store/{users,avatars,conversations,groups,routines,knowledgeRepo,secrets,admin}.ts`. The PUBLIC
  surface is UNCHANGED — every caller still does `new Store(config)` + `store.foo()`, and `./store`
  re-exports `normalizeHashtags`/`MAX_HASHTAGS`/the `*_KEY` consts. Compose order is irrelevant
  (method names disjoint), one shared `this.db`/`this.secret`. New methods go in the matching domain
  mixin (or `StoreBase` if cross-cutting).
- **`count(sql, …)` is the only count path** (in the base). Don't hand-roll `(… .get() as {c:number}).c`.
- **Row mappers each have a named `*Row` interface** (`UserRow`/`GroupRow`/`PluginRow`/`GroupMemberRow`/
  `RoutineJobRow`). New mappers follow that — don't use reflective `Parameters<Store["toX"]>[0]`.
- **The co-membership SQL lives in ONE fragment** (T3.2 done): `SHARING_TEAMMATES` in
  `store/avatars.ts` (group_members self-join + `groups.avatar_sharing` gate: NULL/1 = on, only an
  explicit 0 is off — keep the TS `!== 0` reads in lockstep). ALL four consumers build on it —
  `VISIBILITY_WHERE` (list + search share it), `groupTeammateIds`, `shareAnyGroup` (= `isTrustedFor`),
  `sharedGroupNames` — so reach and elevation can never drift apart, and the `search_avatars` MCP
  scope automatically matches the browse scope.
- **Schedule decode lives in ONE place:** `scheduleFromRow` (via `parseDaysOfWeek`, which try/catches
  the `JSON.parse` so a corrupt `days_of_week` row can't abort a scheduler tick). `toRoutineJob` reuses
  it. `create/updateRoutineJob` accept either the legacy flat fields OR a full `RoutineSchedule` object
  (additive, backward-compatible with `{prompt, minuteOfDay}` + NULL `schedule_kind`). When you add a
  schedule field, touch `routineSchedule.ts` + `RoutineJobRow` + this decode together.
- **`deleteUser` does cascade-delete MANUALLY** (no `ON DELETE CASCADE` despite `foreign_keys=ON`). A
  new user-scoped table needs a matching `DELETE` added there or it orphans rows past "permanent deletion."
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
  names, the index name and both marker keys stay reserved FOREVER. Groups, members, knowledge repos and
  audit rows are untouched; AdminView keeps the `group_agent_create/delete/update/image` labels for retained
  audit rows. The row-keyed helpers (pending document, session-artifact sweep, name-prefix sweep) are shared
  with the personal-bot retirement in `src/server/retiredSessionFiles.ts`. `migrateGroupAgentsMulti` and the
  boot `migrateGroupAgentDiskArtifacts` rename are gone; deleting a group now removes only its
  group-knowledge clone (`removeGroupKnowledgeClone`, `groupKnowledgeRepo.ts`). Tests:
  `tests/retire-group-agents.test.ts`.
- **Retirement backup and quarantine (user decision 2026-10-29): no retirement ever deletes a FILE, and
  none deletes a ROW before the whole DB is backed up.** One per-boot gate in `StoreBase`
  (`retirementGate()`, helpers in `src/server/store/retirementBackup.ts`) carries a UTC stamp
  (`2026-10-29T03-04-05.678Z-<6 hex>`) shared by both halves:
  - **DB backup.** The gate is asked in the `Store` constructor BEFORE `migrate()` and again by every boot
    purge. When `retirementDataPresent` (read-only, schema-defensive, safe pre-migrate) finds anything a
    retirement would delete — a retired table (`server_agents`, `server_agent_sessions`, `group_agents`,
    `group_agents_legacy`, `external_avatar_images`, `personal_agents`, `bot_tasks`,
    `avatar_trusted_users`), a retired `app_config` key (`server_agents_enabled`,
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
  - **Manual cleanup only.** Noah never reads, serves, lists, sweeps or prunes `backups/` or `retired/` (no
    static route reaches `dataDir`, no code lists `dataDir` itself, account deletion sweeps only its named
    per-user namespaces — so a deleted user's data in either folder stays until the operator removes it).
    Both hold FULL user data — conversations, encrypted secrets (readable with the deployment's
    SESSION_SECRET), files — and, like the live DB, are reachable by same-uid agent Bash until #71's uid
    separation lands. Restore: stop Noah, replace `noah-almighty.db` (and delete its `-wal`/`-shm`) with the
    backup, move the wanted items from `retired/<stamp>/` back to the same relative paths, start an OLDER
    release (this one would retire them again). Delete when satisfied: `rm -rf <dataDir>/retired/<stamp>
    <dataDir>/backups/pre-retire-<stamp>.db` (a read-only tree inside may need `chmod -R u+w` first).
    Operator text: README "Retirement backups and quarantine". Tests: `tests/retire-backup.test.ts` plus
    the quarantine expectations in every `tests/retire-*.test.ts`.

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
- **Per-conversation group-knowledge toggle (owner-only):** `conversations.group_knowledge_off` (JSON
  OFF-set; NULL/`[]` = every group ON) + `get/setConversationGroupKnowledgeOff`. The CLIENT owns the
  selection and sends it on each chat POST (`groupKnowledgeOff`) — there is NO per-conversation PATCH
  endpoint, so it works from a brand-new chat with no row. The chat route turns it into ONE
  `disabledGroupIds` set that filters BOTH `loadAgentPluginRoots` group skill roots AND
  `loadKnowledgeRepoMemory` group CLAUDE.md, and persists it on the row. Colleague turns ignore it
  (always all-on); routines pass no filter.
- **Per-USER default group-knowledge OFF-set:** `users.group_knowledge_off_default` (JSON OFF-set,
  `[]`=all on) + `setGroupKnowledgeOffDefault`, on `User.groupKnowledgeOffDefault`, written by
  `PUT /api/me/group-knowledge-default`. The composer toggle saves here so the choice SEEDS every NEW
  conversation — crucially the **auto-greeting**, which fires before any toggle interaction. Client seeds
  new panes via `defaultGroupKnowledgeOff(avatar)` (own avatar only). Existing conversations still load
  their persisted per-conversation value, which overrides the default for that chat.
- **The composer model/effort/MCP-tool-group pickers remember the owner's last choice** via per-user
  defaults (`users.model_default` / `effort_default` / `mcp_tool_groups_default`), mirroring
  `group_knowledge_off_default`. The setter `store.setChatDefaults` + `PUT /api/me/chat-defaults` write
  them; `toUser` exposes `modelDefault`/`effortDefault`/`mcpToolGroupsDefault` (null = never chosen →
  fall back to the hardcoded server/SDK default; for MCP, `[]` = explicitly all-off as a remembered
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
