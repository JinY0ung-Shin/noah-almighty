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
  **`createApp`/`createServices`/`expandChatSlashCommand`/`conversationHistoryForPrompt`/`AppServices`/
  `AgentResponse` are still imported from `app.ts`** (re-exported) — don't change those import paths.
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
