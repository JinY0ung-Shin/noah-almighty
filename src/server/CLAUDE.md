# src/server — Claude notes

Server-layer rules. Read with the root [`CLAUDE.md`](../../CLAUDE.md) and [`agent/CLAUDE.md`](agent/CLAUDE.md);
mechanics live in [`docs/architecture/`](../../docs/architecture/) — mainly
[`server-core.md`](../../docs/architecture/server-core.md) (routes, store, settings, migrations),
[`team-trust.md`](../../docs/architecture/team-trust.md), [`repo-knowledge.md`](../../docs/architecture/repo-knowledge.md),
[`secrets-ssh.md`](../../docs/architecture/secrets-ssh.md), [`routines.md`](../../docs/architecture/routines.md).

- **`app.ts` is thin glue.** Per-domain `(deps) => Router` factories in `routes/*`, shared helpers in
  `routes/_shared.ts`. Symbols re-exported from `app.ts` keep that import path. No module-level mutable
  state — thread it through `deps`.
- **`store.ts` is a thin barrel over per-domain mixins** (`store/*.ts`); the public surface stays
  `new Store(config)` + `store.foo()`. New methods go in the matching mixin (cross-cutting: `StoreBase`).
  A cross-mixin `this.foo()` type-checks ONLY via the hand-maintained `StoreBase` interface
  (`store/internal.ts`) — add the signature there. A mixin overriding `close()` MUST call `super.close()`.
  Use the shared `count()`/`now()` helpers.
- **`migrate()` runs on EVERY `new Store()` (every boot), so a value-guarded backfill is NOT one-time.** A backfill whose predicate
  can match rows the app creates LATER must be gated on the `PRAGMA user_version` ladder (`internal.ts`);
  only predicates that can match OLD rows alone may stay ungated.
- **`deleteUser` cascades MANUALLY, in two halves that must stay in sync:** a new user-scoped table needs its
  `DELETE` (both directions where the user is owner AND subject), and a new on-disk per-user namespace
  (incl. the pi sandbox workspace) needs its sweep in the `routes/admin.ts` delete handler. Audit rows are
  retained by design.
- **`SESSION_SECRET` keys EVERY at-rest reversible secret.** Rotating it is SILENT data loss (decrypt →
  "no secret"), not a crash — a deploy-migration concern.
- **One home each:** schedule math lives in `routineSchedule.ts` — a new schedule field touches it +
  `RoutineJobRow` + the decode together, never re-derived elsewhere;
  low-level git safety in `repoGitCore.ts` + `repoGitGuards.ts` (`knowledgeRepo.ts`/`gitRepos.ts` stay thin
  resolvers over it).
