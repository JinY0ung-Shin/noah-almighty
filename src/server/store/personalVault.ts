import { type Constructor, type StoreBase, PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY } from "./internal.js";

// The personal vault lives in the memory service for every owner (see
// ../personalVault.ts), so the store holds nothing about WHERE it lives. What
// is kept here is only the one-time import of a newly connected repository's
// own notes (../vaultImport.ts): which owners still have one to look at.

/**
 * How far an owner's repository import is:
 * - `check` — the repository has not been looked at yet (it is imported only
 *   when the owner's wiki in the service holds no vault note);
 * - `import` — the look said yes and the import began: every repository note
 *   the service does not hold yet is still to be created.
 */
export type VaultImportStage = "check" | "import";

/** app_config key: the pending repository imports, JSON `{ [userId]: VaultImportStage }`. */
export const PERSONAL_VAULT_IMPORTS_KEY = "personal_vault_imports";

function parseImports(raw: string | null): Record<string, VaultImportStage> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, VaultImportStage> = {};
    for (const [userId, stage] of Object.entries(parsed)) {
      if (stage === "check" || stage === "import") out[userId] = stage;
    }
    return out;
  } catch {
    return {};
  }
}

export function withPersonalVault<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class extends Base {
    /** Every pending repository import, by user id. */
    listVaultImports(): Record<string, VaultImportStage> {
      return parseImports(this.getAppSecret(PERSONAL_VAULT_IMPORTS_KEY));
    }

    /** Record (or advance) an owner's pending repository import. */
    setVaultImport(userId: string, stage: VaultImportStage): void {
      const imports = this.listVaultImports();
      imports[userId] = stage;
      this.setAppSecret(PERSONAL_VAULT_IMPORTS_KEY, JSON.stringify(imports));
    }

    /** The owner's import is over (done, or there was nothing to import). No-op when none was pending. */
    clearVaultImport(userId: string): void {
      const imports = this.listVaultImports();
      if (!(userId in imports)) return;
      delete imports[userId];
      if (Object.keys(imports).length === 0) this.deleteAppSecret(PERSONAL_VAULT_IMPORTS_KEY);
      else this.setAppSecret(PERSONAL_VAULT_IMPORTS_KEY, JSON.stringify(imports));
    }

    /**
     * The owners migrate() found with a repository but no vault row when it
     * retired the vault tables — handed over ONCE: the list is returned and its
     * key deleted, each owner recorded as a pending `check` first (an import
     * that already began is left as it is).
     */
    takeVaultImportStragglers(): string[] {
      const raw = this.getAppSecret(PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY);
      if (raw === null) return [];
      let ids: string[] = [];
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === "string" && id !== "");
      } catch {
        ids = [];
      }
      const imports = this.listVaultImports();
      for (const id of ids) imports[id] ??= "check";
      if (ids.length > 0) this.setAppSecret(PERSONAL_VAULT_IMPORTS_KEY, JSON.stringify(imports));
      this.deleteAppSecret(PERSONAL_VAULT_IMPORT_STRAGGLERS_KEY);
      return ids;
    }
  };
}
