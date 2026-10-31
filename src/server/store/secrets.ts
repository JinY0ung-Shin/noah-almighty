import { decryptSecret, encryptSecret } from "../crypto.js";
import {
  EXTERNAL_GIT_TOKEN_SECRET_NAME,
  INTERNAL_GIT_TOKEN_SECRET_NAME,
  type GitTokenSet,
} from "../gitCredentials.js";
import {
  HEX_SSH_POLICY_CONFIG_KEY,
  normalizeHexSshToolPolicy,
  type HexSshToolPolicy,
} from "../hexSshPolicy.js";
import {
  TOOL_SKILL_POLICY_CONFIG_KEY,
  normalizeToolSkillPolicy,
  type ToolSkillPolicy,
} from "../toolSkillPolicy.js";
import {
  MODEL_VISION_POLICY_CONFIG_KEY,
  normalizeModelVisionPolicy,
  type ModelVisionPolicy,
} from "../modelVisionPolicy.js";
import {
  isBrowserExposableSecret,
  normalizeBrowserSecretHosts,
  type BrowserSecretPolicy,
} from "../secretPolicy.js";
import {
  SHARED_MCP_SERVERS_CONFIG_KEY,
  normalizeStoredSharedMcpServers,
} from "../sharedMcpServers.js";
import type { SharedMcpBinding, SharedMcpServer, User } from "../types.js";
import { now, type Constructor, type StoreBase } from "./internal.js";

/** `user_secrets.browser_hosts` → the raw parsed value, or null when unusable. */
function parseHostsJson(raw: string | null): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export type AppSecretState =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "ok"; value: string };

export function withSecrets<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class Secrets extends Base {
    /**
     * Ciphertext-aware cache: DB is still checked on every read so another Store
     * instance or direct recovery write is observed immediately, but expensive
     * synchronous scrypt/AES work only repeats when the ciphertext changes.
     */
    private readonly appSecretStateCache = new Map<
      string,
      { ciphertext: string | null; state: AppSecretState }
    >();

    override close(): void {
      this.appSecretStateCache.clear();
      super.close();
    }

    // ---- Git credentials / personal knowledge repo -----------------------

    /** Store (encrypted) or clear the user's internal GitHub token as GIT_TOKEN. */
    setGitToken(userId: string, token: string | null): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      if (token) {
        this.setUserSecret(userId, INTERNAL_GIT_TOKEN_SECRET_NAME, token);
      } else {
        this.deleteUserSecret(userId, INTERNAL_GIT_TOKEN_SECRET_NAME);
      }
      // Legacy column retained for old DB compatibility; new writes use user_secrets.
      this.db.prepare("UPDATE users SET git_token_enc = NULL WHERE id = ?").run(userId);
      return this.toUser(this.userRowById(userId)!);
    }

    private getUserSecretValue(userId: string, name: string): string | null {
      const row = this.db
        .prepare("SELECT value_enc FROM user_secrets WHERE user_id = ? AND name = ?")
        .get(userId, name) as { value_enc: string } | undefined;
      if (!row?.value_enc) {
        return null;
      }
      return decryptSecret(row.value_enc, this.secret);
    }

    /**
     * Decrypt and return the user's internal GitHub token for server-side git auth.
     * Returns null if unset or undecryptable (e.g. SESSION_SECRET changed). This
     * is the ONLY path the plaintext token leaves the DB — never via `toUser`.
     */
    getGitToken(userId: string): string | null {
      // The legacy users.git_token_enc column is migrated into user_secrets and
      // NULLed at Store construction (migrateGitTokenSecrets), so the vault is
      // the only live source.
      return this.getUserSecretValue(userId, INTERNAL_GIT_TOKEN_SECRET_NAME);
    }

    getExternalGitToken(userId: string): string | null {
      return this.getUserSecretValue(userId, EXTERNAL_GIT_TOKEN_SECRET_NAME);
    }

    getGitTokens(userId: string): GitTokenSet {
      return {
        internal: this.getGitToken(userId),
        external: this.getExternalGitToken(userId),
      };
    }

    // ---- Per-user secrets (encrypted env injected into avatar MCP tools) --

    /**
     * Store (encrypted) a named secret for the user. Values are AES-256-GCM
     * encrypted at rest like git tokens; they're only ever decrypted into the
     * env of an avatar's MCP subprocess (e.g. hex-ssh's SSH_PRIVATE_KEY), never
     * exposed to the agent or serialized via `toUser`.
     */
    setUserSecret(userId: string, name: string, value: string): void {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      const enc = encryptSecret(value, this.secret);
      // Transactional like setSshKeyPair: a failure between the two statements
      // must not leave a stale public key advertised for a replaced private key.
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO user_secrets (user_id, name, value_enc, created_at) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc",
          )
          .run(userId, name, enc, now());
        if (name === "SSH_PRIVATE_KEY") {
          this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
        }
      });
      tx();
    }

    /** Store a generated SSH keypair: private key encrypted, public key visible. */
    setSshKeyPair(userId: string, privateKey: string, publicKey: string): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      const enc = encryptSecret(privateKey, this.secret);
      const createdAt = now();
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            "INSERT INTO user_secrets (user_id, name, value_enc, created_at) VALUES (?, 'SSH_PRIVATE_KEY', ?, ?) " +
              "ON CONFLICT(user_id, name) DO UPDATE SET value_enc = excluded.value_enc",
          )
          .run(userId, enc, createdAt);
        this.db.prepare("UPDATE users SET ssh_public_key = ? WHERE id = ?").run(publicKey, userId);
      });
      tx();
      return this.toUser(this.userRowById(userId)!);
    }

    /**
     * Set (or clear) the stored SSH public key without touching the private-key
     * secret. Used to keep the public half queryable when the owner pastes their
     * own `SSH_PRIVATE_KEY` (the route derives the public key and stores it here).
     */
    setSshPublicKey(userId: string, publicKey: string | null): void {
      this.db.prepare("UPDATE users SET ssh_public_key = ? WHERE id = ?").run(publicKey, userId);
    }

    /** Remove a named secret. Returns whether a row was actually deleted. */
    deleteUserSecret(userId: string, name: string): boolean {
      let removed = false;
      const tx = this.db.transaction(() => {
        const res = this.db
          .prepare("DELETE FROM user_secrets WHERE user_id = ? AND name = ?")
          .run(userId, name);
        removed = res.changes > 0;
        // A deleted secret takes its 공용 MCP bindings with it (re-adding the
        // same name later must not silently re-arm a server).
        this.db
          .prepare("DELETE FROM user_shared_mcp_bindings WHERE user_id = ? AND secret_name = ?")
          .run(userId, name);
        if (name === "SSH_PRIVATE_KEY") {
          this.db.prepare("UPDATE users SET ssh_public_key = NULL WHERE id = ?").run(userId);
        }
      });
      tx();
      return removed;
    }

    /** Names of the user's stored secrets (for the settings UI; values omitted). */
    listUserSecretNames(userId: string): string[] {
      const rows = this.db
        .prepare("SELECT name FROM user_secrets WHERE user_id = ? ORDER BY name")
        .all(userId) as { name: string }[];
      return rows.map((r) => r.name);
    }

    /**
     * Names of the secrets the user opted into AGENT-SHELL exposure for
     * (per-secret `shell_expose` toggle). The injection site additionally
     * filters through `mcpInjectableSecretEnv`, so a reserved git/SSH name
     * never ships even if its flag were somehow set.
     */
    listShellExposedSecretNames(userId: string): string[] {
      const rows = this.db
        .prepare(
          "SELECT name FROM user_secrets WHERE user_id = ? AND shell_expose = 1 ORDER BY name",
        )
        .all(userId) as { name: string }[];
      return rows.map((r) => r.name);
    }

    /**
     * Toggle a stored secret's agent-shell exposure. Returns false when the
     * secret doesn't exist (the flag rides the secret row; value untouched).
     */
    setSecretShellExpose(userId: string, name: string, expose: boolean): boolean {
      const result = this.db
        .prepare(
          "UPDATE user_secrets SET shell_expose = ? WHERE user_id = ? AND name = ?",
        )
        .run(expose ? 1 : 0, userId, name);
      return result.changes > 0;
    }

    /**
     * The owner's BROWSER-INPUT policies (브라우저 입력): the secrets that may be
     * typed into the owner's own browser by NAME, with the exact hosts allowed
     * and whether the target must be a password field.
     *
     * Only rows that are enabled AND actually usable come back, because every
     * consumer (prompt, `describe_system`, the browser tool gate, the settings
     * UI) reads this list as "these can be typed right now":
     *  - `browser_expose = 1`;
     *  - the name is not a reserved git/SSH name (defence in depth — the route
     *    refuses to set one, but a hand-edited DB must not widen the gate);
     *  - at least one parsed host, since an empty allowlist can never match a tab
     *    and would otherwise advertise a secret the bridge always refuses.
     * A malformed `browser_hosts` JSON blob skips the row for the same reason —
     * failing closed beats guessing which sites the owner meant.
     */
    listBrowserSecretPolicies(userId: string): BrowserSecretPolicy[] {
      const rows = this.db
        .prepare(
          "SELECT name, browser_hosts, browser_password_only FROM user_secrets " +
            "WHERE user_id = ? AND browser_expose = 1 ORDER BY name",
        )
        .all(userId) as {
        name: string;
        browser_hosts: string | null;
        browser_password_only: number | null;
      }[];
      const out: BrowserSecretPolicy[] = [];
      for (const row of rows) {
        if (!isBrowserExposableSecret(row.name)) {
          continue;
        }
        const hosts = normalizeBrowserSecretHosts(parseHostsJson(row.browser_hosts));
        if (!hosts?.length) {
          continue;
        }
        out.push({
          name: row.name,
          hosts,
          // Legacy/NULL reads as the SAFE end of the toggle (password fields only).
          passwordOnly: row.browser_password_only !== 0,
        });
      }
      return out;
    }

    /**
     * Set a stored secret's browser-input policy. Returns false when the secret
     * doesn't exist (the policy rides the secret row; the value is untouched).
     *
     * Disabling keeps the hosts and the password-only flag so re-enabling
     * restores what the owner configured — and it does so HERE rather than at the
     * caller, because `listBrowserSecretPolicies` only reports ENABLED rows: a
     * route that re-read the policy to preserve it would find nothing on the
     * second disable and silently wipe the allowlist. So an empty host list on a
     * disable flips `browser_expose` alone; anything else is an explicit edit.
     */
    setSecretBrowserPolicy(
      userId: string,
      name: string,
      policy: { enabled: boolean; hosts: string[]; passwordOnly: boolean },
    ): boolean {
      const result =
        !policy.enabled && !policy.hosts?.length
          ? this.db
              .prepare("UPDATE user_secrets SET browser_expose = 0 WHERE user_id = ? AND name = ?")
              .run(userId, name)
          : this.db
              .prepare(
                "UPDATE user_secrets SET browser_expose = ?, browser_hosts = ?, browser_password_only = ? " +
                  "WHERE user_id = ? AND name = ?",
              )
              .run(
                policy.enabled ? 1 : 0,
                JSON.stringify(policy.hosts),
                policy.passwordOnly ? 1 : 0,
                userId,
                name,
              );
      return result.changes > 0;
    }

    /**
     * Decrypt all of the user's secrets into a name→value map for server-side use
     * (injected as MCP subprocess env). Undecryptable entries (e.g. after a
     * SESSION_SECRET change) are skipped. This is the ONLY path the plaintext
     * values leave the DB — never via `toUser`.
     */
    getUserSecrets(userId: string): Record<string, string> {
      const rows = this.db
        .prepare("SELECT name, value_enc FROM user_secrets WHERE user_id = ?")
        .all(userId) as { name: string; value_enc: string }[];
      const out: Record<string, string> = {};
      for (const r of rows) {
        const value = decryptSecret(r.value_enc, this.secret);
        if (value !== null) {
          out[r.name] = value;
        }
      }
      return out;
    }

    // ---- App-wide config (encrypted, not user-scoped) --------------------

    /**
     * Store (encrypted) an app-wide secret keyed by name. Unlike user_secrets
     * this is global to the deployment — e.g. the signup mode, the admin model
     * override and the boot retirements' markers. AES-256-GCM at rest like every other secret; only
     * decrypted server-side (`getAppSecret`), never returned to clients.
     */
    setAppSecret(key: string, value: string): void {
      const enc = encryptSecret(value, this.secret);
      this.db
        .prepare(
          "INSERT INTO app_config (key, value_enc, updated_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at",
        )
        .run(key, enc, now());
      this.appSecretStateCache.delete(key);
    }

    /** Decrypt an app-wide secret. Null if unset or undecryptable (e.g. SESSION_SECRET changed). */
    getAppSecret(key: string): string | null {
      const state = this.getAppSecretState(key);
      return state.status === "ok" ? state.value : null;
    }

    /** Distinguish an absent app setting from ciphertext that can no longer be decrypted. */
    getAppSecretState(
      key: string,
    ): AppSecretState {
      const row = this.db.prepare("SELECT value_enc FROM app_config WHERE key = ?").get(key) as
        | { value_enc: string }
        | undefined;
      const ciphertext = row?.value_enc ?? null;
      const cached = this.appSecretStateCache.get(key);
      if (cached?.ciphertext === ciphertext) {
        return cached.state;
      }
      let state: AppSecretState;
      if (ciphertext === null) {
        state = Object.freeze({ status: "missing" });
      } else {
        const value = decryptSecret(ciphertext, this.secret);
        state = Object.freeze(
          value === null
            ? { status: "unreadable" as const }
            : { status: "ok" as const, value },
        );
      }
      this.appSecretStateCache.set(key, { ciphertext, state });
      return state;
    }

    /** Remove an app-wide secret. No-op if it doesn't exist. */
    deleteAppSecret(key: string): void {
      this.db.prepare("DELETE FROM app_config WHERE key = ?").run(key);
      this.appSecretStateCache.delete(key);
    }

    /** Deployment-wide hex-ssh tool allowlist, grouped by viewer class. */
    getHexSshToolPolicy(): HexSshToolPolicy {
      const raw = this.getAppSecret(HEX_SSH_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeHexSshToolPolicy(null);
      }
      try {
        return normalizeHexSshToolPolicy(JSON.parse(raw));
      } catch {
        return normalizeHexSshToolPolicy(null);
      }
    }

    setHexSshToolPolicy(policy: HexSshToolPolicy): HexSshToolPolicy {
      const normalized = normalizeHexSshToolPolicy(policy);
      this.setAppSecret(HEX_SSH_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /**
     * Deployment-wide built-in tool/skill on-off policy (admin-managed).
     * Missing/corrupt/unreadable (SESSION_SECRET rotated) → empty policy,
     * i.e. nothing disabled — the safe pre-feature behavior.
     */
    getToolSkillPolicy(): ToolSkillPolicy {
      const raw = this.getAppSecret(TOOL_SKILL_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeToolSkillPolicy(null);
      }
      try {
        return normalizeToolSkillPolicy(JSON.parse(raw));
      } catch {
        return normalizeToolSkillPolicy(null);
      }
    }

    setToolSkillPolicy(policy: ToolSkillPolicy): ToolSkillPolicy {
      const normalized = normalizeToolSkillPolicy(policy);
      this.setAppSecret(TOOL_SKILL_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /**
     * 공용 MCP 서버 list (admin-managed, see sharedMcpServers.ts). Missing/
     * corrupt/unreadable (SESSION_SECRET rotated) → empty list, i.e. nothing
     * registered — fail closed. Read fresh on every run.
     */
    getSharedMcpServers(): SharedMcpServer[] {
      const raw = this.getAppSecret(SHARED_MCP_SERVERS_CONFIG_KEY);
      if (!raw) {
        return [];
      }
      try {
        return normalizeStoredSharedMcpServers(JSON.parse(raw));
      } catch {
        return [];
      }
    }

    /** Replace the whole list (callers validated every entry with parseSharedMcpServer). */
    setSharedMcpServers(servers: SharedMcpServer[]): SharedMcpServer[] {
      const normalized = normalizeStoredSharedMcpServers(servers);
      this.setAppSecret(SHARED_MCP_SERVERS_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /** The user's own 공용 MCP slot bindings (secret NAMES + the origin each was bound for). */
    listSharedMcpBindings(userId: string): SharedMcpBinding[] {
      const rows = this.db
        .prepare(
          "SELECT server_name, slot_id, secret_name, origin FROM user_shared_mcp_bindings WHERE user_id = ? ORDER BY server_name, slot_id",
        )
        .all(userId) as { server_name: string; slot_id: string; secret_name: string; origin: string }[];
      return rows.map((row) => ({
        serverName: row.server_name,
        slotId: row.slot_id,
        secretName: row.secret_name,
        origin: row.origin,
      }));
    }

    setSharedMcpBinding(userId: string, binding: SharedMcpBinding): void {
      this.db
        .prepare(
          `INSERT INTO user_shared_mcp_bindings (user_id, server_name, slot_id, secret_name, origin, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, server_name, slot_id)
           DO UPDATE SET secret_name = excluded.secret_name, origin = excluded.origin, created_at = excluded.created_at`,
        )
        .run(userId, binding.serverName, binding.slotId, binding.secretName, binding.origin, now());
    }

    deleteSharedMcpBinding(userId: string, serverName: string, slotId: string): boolean {
      return (
        this.db
          .prepare("DELETE FROM user_shared_mcp_bindings WHERE user_id = ? AND server_name = ? AND slot_id = ?")
          .run(userId, serverName, slotId).changes > 0
      );
    }

    /**
     * Drop every user's bindings to a server (it was deleted), or to the slots
     * it no longer has (`keepSlotIds`) — a re-created server or slot of the same
     * name/id must start unbound.
     */
    pruneSharedMcpBindings(serverName: string, keepSlotIds: string[] = []): void {
      const keep = keepSlotIds.length
        ? ` AND slot_id NOT IN (${keepSlotIds.map(() => "?").join(", ")})`
        : "";
      this.db
        .prepare(`DELETE FROM user_shared_mcp_bindings WHERE server_name = ?${keep}`)
        .run(serverName, ...keepSlotIds);
    }

    /**
     * Admin-managed per-model vision policy (`{piModelId: boolean}`; an absent
     * model = inherit the MODEL_VISION deployment default). Missing/corrupt/
     * unreadable → empty map, i.e. everything inherits — the safe pre-feature
     * behavior.
     */
    getModelVisionPolicy(): ModelVisionPolicy {
      const raw = this.getAppSecret(MODEL_VISION_POLICY_CONFIG_KEY);
      if (!raw) {
        return normalizeModelVisionPolicy(null);
      }
      try {
        return normalizeModelVisionPolicy(JSON.parse(raw));
      } catch {
        return normalizeModelVisionPolicy(null);
      }
    }

    setModelVisionPolicy(policy: ModelVisionPolicy): ModelVisionPolicy {
      const normalized = normalizeModelVisionPolicy(policy);
      this.setAppSecret(MODEL_VISION_POLICY_CONFIG_KEY, JSON.stringify(normalized));
      return normalized;
    }

    /** Set the commit author identity used for knowledge-repo commits. */
    setGitIdentity(userId: string, name: string | null, email: string | null): User {
      if (!this.userRowById(userId)) {
        throw new Error("USER_NOT_FOUND");
      }
      this.db
        .prepare("UPDATE users SET git_identity_name = ?, git_identity_email = ? WHERE id = ?")
        .run(name?.trim() || null, email?.trim() || null, userId);
      return this.toUser(this.userRowById(userId)!);
    }
  };
}
