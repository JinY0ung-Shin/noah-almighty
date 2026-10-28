# src/server — Claude notes

Server-area direction. Read with the **root [`CLAUDE.md`](../../CLAUDE.md)** (architecture, env,
language-split, deploy topology) and agent specifics in [`agent/CLAUDE.md`](agent/CLAUDE.md). The
detailed, change-prone mechanics live in **[`../../docs/architecture/`](../../docs/architecture/)** —
[`server-core.md`](../../docs/architecture/server-core.md) (route homes, store mixins, settings pattern),
[`groups-trust.md`](../../docs/architecture/groups-trust.md) (visibility, trust),
[`repo-knowledge.md`](../../docs/architecture/repo-knowledge.md) (repo plumbing, capture),
[`secrets-ssh.md`](../../docs/architecture/secrets-ssh.md) (vault, git credentials, CA wiring),
[`routines.md`](../../docs/architecture/routines.md) (schedule decode). Index:
[`../../docs/ARCHITECTURE-NOTES.md`](../../docs/ARCHITECTURE-NOTES.md).

Durable principles for this layer:

- **`app.ts` is thin glue.** Per-domain `(deps) => Router` factories in `routes/*`, shared helpers in
  `routes/_shared.ts`. Re-exported symbols (`createApp`/`createServices`/`expandChatSlashCommand`/…) keep
  their `app.ts` import paths — don't move them. No module-level mutable state; thread it through `deps`.
- **`store.ts` is a thin barrel composed from per-domain mixins** (`store/*.ts`); the PUBLIC surface is
  unchanged (`new Store(config)` + `store.foo()`). New methods go in the matching domain mixin (or the
  shared `StoreBase` if cross-cutting). Use the shared `count()` helper; never force callers to pick a
  sub-store class.
- **Schedule math lives in ONE place** (`routineSchedule.ts`) — validation + next-run + decode. Add a
  schedule field there + `RoutineJobRow` + the decode together; don't re-derive it elsewhere.
- **Low-level git is shared** (`repoGitCore.ts` + `repoGitGuards.ts`) — the single edit point for
  git-safety. `knowledgeRepo.ts`/`groupKnowledgeRepo.ts`/`gitRepos.ts` are thin resolvers over it; keep
  them from drifting back into line-for-line mirrors.
- **`SESSION_SECRET` keys EVERY at-rest reversible secret.** Rotating it is SILENT data loss
  (`decryptSecret`→`null`, treated as "no secret"), not a crash — a deploy-migration concern.
- **`deleteUser` cascades MANUALLY** (no `ON DELETE CASCADE`), and the cascade has TWO halves that must stay
  in sync. (1) DB rows: a new user-scoped table needs a matching `DELETE` (both directions where the user
  can be owner AND subject — e.g. `knowledge_requests` by `avatar_user_id` OR `asker_user_id`) or it orphans
  rows past "permanent deletion." (2) On-disk namespaces: any new `dataDir/<ns>/<userId>` tree
  (`plugins/`, `workspaces/`, the knowledge clone, ssh-trust dir, avatar image, per-conversation media)
  needs a matching best-effort sweep in the `routes/admin.ts` delete handler. Audit rows are RETAINED by
  design (`actor_*` dangle, like `groups.created_by`).
- **`migrate()` runs on EVERY `new Store()`, so a value-guarded backfill is NOT one-time.** An
  `UPDATE … WHERE col IS NULL` re-fires each boot and clobbers rows the APP later creates NULL on purpose
  (a fresh signup's `onboarded_at`, a user-typed `[예약 작업]` title vanishing from chat). A backfill whose
  predicate can match FUTURE rows MUST be gated on the `PRAGMA user_version` LADDER (`internal.ts` —
  `CANVAS_BACKFILL_VERSION`, `ONBOARDED_ROUTINE_BACKFILL_VERSION`): check `user_version < N`, run, stamp N.
  Value-guarded migrations that can only ever match OLD rows (git-token move, visibility normalize) may stay
  ungated.
- **Cross-mixin `this.foo()` calls type-check ONLY via the hand-maintained `export interface StoreBase`
  declaration merge** (`store/internal.ts`). Adding a method in mixin A that mixin B calls needs its
  signature added there too. A mixin that overrides `close()` to clear a cache MUST call `super.close()`
  (else the SQLite handle leaks) — see `secrets.ts`/`admin.ts`. Use the shared `count()` / `now()` helpers,
  never hand-rolled `.get() as {n}` or `new Date().toISOString()`.
