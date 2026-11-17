import { type Constructor, type StoreBase, now } from "./internal.js";

// Where an owner's personal vault lives (see the personal_vaults and
// personal_vault_deletes table comments in internal.ts, and ../personalVault.ts
// for what reads them). Storage only: a row exists ONLY for an owner whose
// vault home is `memory`; the migration creates and deletes it, MemoryVault
// marks the mirror dirty and writes the deletion ledger, the mirror pass
// records its outcome.

/** The instance setting `personalVaultMode` — where vaults SHOULD live (`getPersonalVaultMode`, store/admin.ts). */
export type PersonalVaultMode = "repo" | "memory";

/**
 * Why the mirror may not write into the connected repo yet: `checking` — a
 * repo or branch was just connected or changed and nobody has looked at it;
 * `confirm` — the check found repository vault notes the copy would replace,
 * so the owner must confirm.
 */
export type VaultMirrorHold = "checking" | "confirm";

export interface PersonalVaultRow {
  userId: string;
  /** ISO. */
  migratedAt: string;
  /** The repo the vault was imported from. */
  sourceRepo: string;
  /** HEAD of the clone at cutover. */
  sourceCommit: string | null;
  /** A vault write happened since the last successful mirror. */
  mirrorDirty: boolean;
  /**
   * How many times the mirror was marked dirty. A mirror pass reads it BEFORE
   * it reads the vault and hands it back to `recordVaultMirror`, so a write that
   * arrived while the pass ran keeps the row dirty.
   */
  mirrorSeq: number;
  mirrorSyncedAt: string | null;
  /** Last failure, short English code or message; null when the last attempt worked. */
  mirrorError: string | null;
  /** What the last successful pass has to tell the owner (repository notes the service does not hold); null = nothing. */
  mirrorNotice: string | null;
  /** The mirror must not write into the connected repo while this is set (null = it may). */
  mirrorHold: VaultMirrorHold | null;
}

/**
 * What a mirror pass reports. On `ok`:
 * - `seq` = the row's `mirrorSeq` the pass started from (omit: dirty is cleared unconditionally);
 * - `notice` = this pass's notice — omitted or null clears the stored one.
 */
export type VaultMirrorResult =
  | { ok: true; seq?: number; notice?: string | null }
  | { ok: false; error: string };

/** A stored mirror error or notice is a short code or sentence, never a transcript. */
const MAX_MIRROR_TEXT_CHARS = 300;

interface PersonalVaultDbRow {
  user_id: string;
  migrated_at: string;
  source_repo: string;
  source_commit: string | null;
  mirror_dirty: number;
  mirror_seq: number;
  mirror_synced_at: string | null;
  mirror_error: string | null;
  mirror_notice: string | null;
  mirror_hold_state: string | null;
}

const SELECT =
  "SELECT user_id, migrated_at, source_repo, source_commit, mirror_dirty, mirror_seq, mirror_synced_at, mirror_error, mirror_notice, mirror_hold_state FROM personal_vaults";

function toRow(row: PersonalVaultDbRow): PersonalVaultRow {
  return {
    userId: row.user_id,
    migratedAt: row.migrated_at,
    sourceRepo: row.source_repo,
    sourceCommit: row.source_commit,
    mirrorDirty: row.mirror_dirty === 1,
    mirrorSeq: row.mirror_seq,
    mirrorSyncedAt: row.mirror_synced_at,
    mirrorError: row.mirror_error,
    mirrorNotice: row.mirror_notice,
    // Anything unknown reads as the state that asks the owner — never as "no hold".
    mirrorHold: row.mirror_hold_state === null ? null : row.mirror_hold_state === "checking" ? "checking" : "confirm",
  };
}

export function withPersonalVault<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class extends Base {
    /** The owner's row, or null when their vault home is `repo`. */
    getPersonalVault(userId: string): PersonalVaultRow | null {
      const row = this.db.prepare(`${SELECT} WHERE user_id = ?`).get(userId) as PersonalVaultDbRow | undefined;
      return row ? toRow(row) : null;
    }

    /**
     * Home → `memory`: create the owner's row (clean mirror, no hold, an empty
     * deletion ledger). On a row that already exists only the provenance is
     * replaced (`sourceRepo`, `sourceCommit`, `migratedAt`) — the mirror state
     * and the ledger are kept, so a repeated cutover never forgets a pending
     * mirror, a hold or a deletion.
     */
    setPersonalVaultMemory(userId: string, source: { sourceRepo: string; sourceCommit: string | null }): void {
      this.db.transaction(() => {
        const exists = this.db.prepare("SELECT 1 FROM personal_vaults WHERE user_id = ?").get(userId) !== undefined;
        if (!exists) this.db.prepare("DELETE FROM personal_vault_deletes WHERE user_id = ?").run(userId);
        this.db
          .prepare(
            `INSERT INTO personal_vaults (user_id, migrated_at, source_repo, source_commit)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               migrated_at = excluded.migrated_at,
               source_repo = excluded.source_repo,
               source_commit = excluded.source_commit`,
          )
          .run(userId, now(), source.sourceRepo, source.sourceCommit);
      })();
    }

    /** Home → `repo`: delete the owner's row and their deletion ledger (no-op when there is none). */
    clearPersonalVault(userId: string): void {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM personal_vaults WHERE user_id = ?").run(userId);
        this.db.prepare("DELETE FROM personal_vault_deletes WHERE user_id = ?").run(userId);
      })();
    }

    /** A vault write happened: the mirror is behind. No-op for an owner without a row. */
    markVaultMirrorDirty(userId: string): void {
      this.db
        .prepare("UPDATE personal_vaults SET mirror_dirty = 1, mirror_seq = mirror_seq + 1 WHERE user_id = ?")
        .run(userId);
    }

    /**
     * The outcome of a mirror pass. `ok` stamps `mirrorSyncedAt`, clears the
     * error, stores the pass's notice (none = cleared) and clears dirty —
     * unless the pass says which `seq` it started from and a write was marked
     * since (then the row stays dirty for the next pass). A failure stores the
     * error and leaves everything else (dirty, notice) as it is.
     */
    recordVaultMirror(userId: string, result: VaultMirrorResult): void {
      if (result.ok) {
        const notice = result.notice ? result.notice.slice(0, MAX_MIRROR_TEXT_CHARS) : null;
        this.db
          .prepare(
            `UPDATE personal_vaults
             SET mirror_synced_at = ?, mirror_error = NULL, mirror_notice = ?,
                 mirror_dirty = CASE WHEN ? IS NULL OR mirror_seq = ? THEN 0 ELSE mirror_dirty END
             WHERE user_id = ?`,
          )
          .run(now(), notice, result.seq ?? null, result.seq ?? null, userId);
        return;
      }
      this.db
        .prepare("UPDATE personal_vaults SET mirror_error = ? WHERE user_id = ?")
        .run(result.error.slice(0, MAX_MIRROR_TEXT_CHARS), userId);
    }

    /**
     * Set the hold (`checking` | `confirm`) or lift it (null). No-op for an
     * owner without a row. Whatever else arrives at runtime is read the safe
     * way round: nothing/false lifts, anything else asks the owner (`confirm`)
     * — so a caller still passing the old boolean does what it meant.
     */
    setVaultMirrorHold(userId: string, state: VaultMirrorHold | null): void {
      const stored = !state ? null : state === "checking" ? "checking" : "confirm";
      this.db.prepare("UPDATE personal_vaults SET mirror_hold_state = ? WHERE user_id = ?").run(stored, userId);
    }

    /** Every owner whose vault home is `memory`, by user id. */
    listPersonalVaults(): PersonalVaultRow[] {
      return (this.db.prepare(`${SELECT} ORDER BY user_id`).all() as PersonalVaultDbRow[]).map(toRow);
    }

    // ---- Deletion ledger ---------------------------------------------------

    /**
     * Noah is about to delete this vault note from the service (called BEFORE
     * the service is asked). An entry for a note that then still exists is
     * harmless: the mirror acts on an entry only when the service no longer
     * holds the path. No-op for an owner without a row (home `repo` has no
     * mirror); recording a path twice keeps one entry.
     */
    recordVaultDelete(userId: string, path: string): void {
      this.db
        .prepare(
          `INSERT INTO personal_vault_deletes (user_id, path, created_at)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM personal_vaults WHERE user_id = ?)
           ON CONFLICT(user_id, path) DO NOTHING`,
        )
        .run(userId, path, now(), userId);
    }

    /**
     * {@link recordVaultDelete} for many paths in one transaction: the owner's
     * confirmation that the repository's own vault notes — the ones the service
     * does not hold, as they were when they pressed — may be removed from it.
     */
    recordVaultDeletes(userId: string, paths: string[]): void {
      if (paths.length === 0) return;
      this.db.transaction(() => {
        for (const path of paths) this.recordVaultDelete(userId, path);
      })();
    }

    /** The owner's ledger: the paths Noah deleted and the mirror has not settled yet, in path order. */
    listVaultDeletes(userId: string): string[] {
      const rows = this.db.prepare("SELECT path FROM personal_vault_deletes WHERE user_id = ?").all(userId) as { path: string }[];
      return rows.map((row) => row.path).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    /**
     * Drop these paths from the owner's ledger. The mirror passes ONLY the
     * paths it settled — those its own listing of the service did not hold —
     * once the pass is recorded ok: an entry whose note the pass still saw in
     * the service must stay (it may be deleted again while the pass runs).
     */
    clearVaultDeletes(userId: string, paths: string[]): void {
      if (paths.length === 0) return;
      const remove = this.db.prepare("DELETE FROM personal_vault_deletes WHERE user_id = ? AND path = ?");
      this.db.transaction(() => {
        for (const path of paths) remove.run(userId, path);
      })();
    }
  };
}
