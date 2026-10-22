import crypto from "node:crypto";
import {
  MAX_SERVER_AGENTS,
  SERVER_AGENT_ACCESS_LEVELS,
  isServerAgentErrorCode,
  type ServerAgent,
  type ServerAgentAccess,
  type ServerAgentInput,
  type ServerAgentInstallState,
} from "../../shared/serverAgents.js";
import { type Constructor, type StoreBase, now } from "./internal.js";

// 서버 에이전트 storage (see the server_agents table comment in internal.ts).
// Input is validated BEFORE it gets here (shared validateServerAgentInput); this
// mixin enforces the per-owner cap and name uniqueness inside the transaction.

interface ServerAgentRow {
  id: string;
  owner_user_id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  workdir: string;
  role: string;
  notes: string;
  access: string;
  enabled: number;
  install_state: string | null;
  created_at: string;
  updated_at: string;
}

function parseInstallState(raw: string | null): ServerAgentInstallState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ServerAgentInstallState>;
    if (typeof v !== "object" || v === null || typeof v.checkedAt !== "string") return null;
    return {
      ok: v.ok === true,
      version: typeof v.version === "string" ? v.version : null,
      error: isServerAgentErrorCode(v.error) ? v.error : null,
      detail: typeof v.detail === "string" ? v.detail : null,
      checkedAt: v.checkedAt,
    };
  } catch {
    return null;
  }
}

function toServerAgent(row: ServerAgentRow): ServerAgent {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    workdir: row.workdir,
    role: row.role,
    notes: row.notes,
    // An unknown stored tier reads as the SAFEST one.
    access: (SERVER_AGENT_ACCESS_LEVELS as readonly string[]).includes(row.access)
      ? (row.access as ServerAgentAccess)
      : "read",
    enabled: row.enabled === 1,
    installState: parseInstallState(row.install_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ServerAgentCreateResult =
  | { ok: true; server: ServerAgent }
  | { ok: false; error: "DUPLICATE_NAME" | "LIMIT" };
export type ServerAgentUpdateResult =
  | { ok: true; server: ServerAgent }
  | { ok: false; error: "NOT_FOUND" | "DUPLICATE_NAME" };

/** The connection columns a check/run started against (see setServerAgentInstallState). */
export interface ServerAgentTarget {
  host: string;
  port: number;
  username: string;
  workdir: string;
}

/**
 * app_config key of this deployment's random server-agent id, written once. Remote
 * pid files carry it so the stale-run sweep never touches another deployment's
 * runs on a shared account. Stored through the encrypted app-secret writer like
 * every app_config row; if it ever becomes unreadable (SESSION_SECRET rotated) a
 * new id is minted and this deployment's old pid files age out by their deadline.
 */
const DEPLOYMENT_ID_KEY = "server_agent_deployment_id";
const DEPLOYMENT_ID_RE = /^[a-f0-9]{16}$/;

const TARGET_MATCH = "host = ? AND port = ? AND username = ? AND workdir = ?";

export interface ServerAgentSessionRef {
  remoteSessionId: string;
  cliVersion: string;
  updatedAt: string;
}

export function withServerAgents<TBase extends Constructor<StoreBase>>(Base: TBase) {
  return class ServerAgents extends Base {
    private serverAgentDeploymentIdCache: string | null = null;

    /** This deployment's stable id for remote pid files (minted once, then read back). */
    serverAgentDeploymentId(): string {
      if (this.serverAgentDeploymentIdCache) return this.serverAgentDeploymentIdCache;
      const state = this.getAppSecretState(DEPLOYMENT_ID_KEY);
      let id = state.status === "ok" && DEPLOYMENT_ID_RE.test(state.value) ? state.value : null;
      if (!id) {
        id = crypto.randomBytes(8).toString("hex");
        this.setAppSecret(DEPLOYMENT_ID_KEY, id);
      }
      this.serverAgentDeploymentIdCache = id;
      return id;
    }

    /**
     * Rows of ANY owner (other than `excludeId`) that log into the same remote
     * account — its `~/.noah-agent` is shared, so a remote cleanup must not remove it.
     */
    countServerAgentsOnAccount(host: string, port: number, username: string, excludeId: string): number {
      return this.count(
        "SELECT COUNT(*) AS c FROM server_agents WHERE host = ? AND port = ? AND username = ? AND id <> ?",
        host.toLowerCase(),
        port,
        username,
        excludeId,
      );
    }

    listServerAgents(ownerUserId: string): ServerAgent[] {
      const rows = this.db
        .prepare("SELECT * FROM server_agents WHERE owner_user_id = ? ORDER BY name")
        .all(ownerUserId) as ServerAgentRow[];
      return rows.map(toServerAgent);
    }

    getServerAgent(ownerUserId: string, id: string): ServerAgent | null {
      const row = this.db
        .prepare("SELECT * FROM server_agents WHERE owner_user_id = ? AND id = ?")
        .get(ownerUserId, id) as ServerAgentRow | undefined;
      return row ? toServerAgent(row) : null;
    }

    getServerAgentByName(ownerUserId: string, name: string): ServerAgent | null {
      const row = this.db
        .prepare("SELECT * FROM server_agents WHERE owner_user_id = ? AND name = ?")
        .get(ownerUserId, name.trim().toLowerCase()) as ServerAgentRow | undefined;
      return row ? toServerAgent(row) : null;
    }

    createServerAgent(ownerUserId: string, input: ServerAgentInput): ServerAgentCreateResult {
      return this.db.transaction((): ServerAgentCreateResult => {
        if (this.count("SELECT COUNT(*) AS c FROM server_agents WHERE owner_user_id = ?", ownerUserId) >= MAX_SERVER_AGENTS) {
          return { ok: false, error: "LIMIT" };
        }
        if (this.count("SELECT COUNT(*) AS c FROM server_agents WHERE owner_user_id = ? AND name = ?", ownerUserId, input.name) > 0) {
          return { ok: false, error: "DUPLICATE_NAME" };
        }
        const id = crypto.randomUUID();
        const stamp = now();
        this.db
          .prepare(
            `INSERT INTO server_agents (id, owner_user_id, name, host, port, username, workdir, role, notes, access,
               enabled, install_state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            id,
            ownerUserId,
            input.name,
            input.host,
            input.port,
            input.username,
            input.workdir,
            input.role,
            input.notes,
            input.access,
            input.enabled ? 1 : 0,
            stamp,
            stamp,
          );
        return { ok: true, server: this.getServerAgent(ownerUserId, id)! };
      })();
    }

    /**
     * A connection-relevant change (host/port/username/workdir) clears the stored
     * install state — the old check says nothing about the new target.
     */
    updateServerAgent(ownerUserId: string, id: string, patch: Partial<ServerAgentInput>): ServerAgentUpdateResult {
      return this.db.transaction((): ServerAgentUpdateResult => {
        const current = this.getServerAgent(ownerUserId, id);
        if (!current) return { ok: false, error: "NOT_FOUND" };
        const next = { ...current, ...patch };
        if (
          next.name !== current.name &&
          this.count("SELECT COUNT(*) AS c FROM server_agents WHERE owner_user_id = ? AND name = ? AND id <> ?", ownerUserId, next.name, id) > 0
        ) {
          return { ok: false, error: "DUPLICATE_NAME" };
        }
        const targetChanged =
          next.host !== current.host ||
          next.port !== current.port ||
          next.username !== current.username ||
          next.workdir !== current.workdir;
        this.db
          .prepare(
            `UPDATE server_agents SET name = ?, host = ?, port = ?, username = ?, workdir = ?, role = ?, notes = ?,
               access = ?, enabled = ?, install_state = CASE WHEN ? THEN NULL ELSE install_state END, updated_at = ?
             WHERE owner_user_id = ? AND id = ?`,
          )
          .run(
            next.name,
            next.host,
            next.port,
            next.username,
            next.workdir,
            next.role,
            next.notes,
            next.access,
            next.enabled ? 1 : 0,
            targetChanged ? 1 : 0,
            now(),
            ownerUserId,
            id,
          );
        if (targetChanged) {
          // Remote sessions live on the OLD target; they cannot be resumed on the new one.
          this.db.prepare("DELETE FROM server_agent_sessions WHERE server_agent_id = ?").run(id);
        }
        return { ok: true, server: this.getServerAgent(ownerUserId, id)! };
      })();
    }

    deleteServerAgent(ownerUserId: string, id: string): boolean {
      return this.db.transaction((): boolean => {
        const changes = this.db.prepare("DELETE FROM server_agents WHERE owner_user_id = ? AND id = ?").run(ownerUserId, id).changes;
        if (changes > 0) {
          this.db.prepare("DELETE FROM server_agent_sessions WHERE server_agent_id = ?").run(id);
        }
        return changes > 0;
      })();
    }

    /** Every server row + session mapping of one owner (deleteUser). */
    deleteServerAgentsForOwner(ownerUserId: string): void {
      this.db
        .prepare(
          "DELETE FROM server_agent_sessions WHERE server_agent_id IN (SELECT id FROM server_agents WHERE owner_user_id = ?)",
        )
        .run(ownerUserId);
      this.db.prepare("DELETE FROM server_agents WHERE owner_user_id = ?").run(ownerUserId);
    }

    /**
     * With `target`, the write lands ONLY while the row still has those connection
     * columns: a check/run that started before the owner re-pointed the row must
     * not record its verdict about the OLD server on the new one. False = not written.
     */
    setServerAgentInstallState(
      ownerUserId: string,
      id: string,
      state: ServerAgentInstallState | null,
      target?: ServerAgentTarget,
    ): boolean {
      const value = state ? JSON.stringify(state) : null;
      if (!target) {
        return this.db.prepare("UPDATE server_agents SET install_state = ? WHERE owner_user_id = ? AND id = ?").run(value, ownerUserId, id).changes > 0;
      }
      return (
        this.db
          .prepare(`UPDATE server_agents SET install_state = ? WHERE owner_user_id = ? AND id = ? AND ${TARGET_MATCH}`)
          .run(value, ownerUserId, id, target.host, target.port, target.username, target.workdir).changes > 0
      );
    }

    getServerAgentSession(conversationId: string, serverAgentId: string): ServerAgentSessionRef | null {
      const row = this.db
        .prepare(
          "SELECT remote_session_id, cli_version, updated_at FROM server_agent_sessions WHERE conversation_id = ? AND server_agent_id = ?",
        )
        .get(conversationId, serverAgentId) as
        | { remote_session_id: string; cli_version: string; updated_at: string }
        | undefined;
      return row ? { remoteSessionId: row.remote_session_id, cliVersion: row.cli_version, updatedAt: row.updated_at } : null;
    }

    /**
     * With `target`, the mapping is written ONLY while the server row still exists
     * with those connection columns: a run that outlived a delete or a re-point
     * must not leave an orphan row or a session of the OLD server. False = not written.
     */
    setServerAgentSession(
      conversationId: string,
      serverAgentId: string,
      remoteSessionId: string,
      cliVersion: string,
      target?: ServerAgentTarget,
    ): boolean {
      const upsert = `ON CONFLICT (conversation_id, server_agent_id)
           DO UPDATE SET remote_session_id = excluded.remote_session_id, cli_version = excluded.cli_version,
             updated_at = excluded.updated_at`;
      if (!target) {
        return (
          this.db
            .prepare(
              `INSERT INTO server_agent_sessions (conversation_id, server_agent_id, remote_session_id, cli_version, updated_at)
               VALUES (?, ?, ?, ?, ?) ${upsert}`,
            )
            .run(conversationId, serverAgentId, remoteSessionId, cliVersion, now()).changes > 0
        );
      }
      return (
        this.db
          .prepare(
            `INSERT INTO server_agent_sessions (conversation_id, server_agent_id, remote_session_id, cli_version, updated_at)
             SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM server_agents WHERE id = ? AND ${TARGET_MATCH}) ${upsert}`,
          )
          .run(conversationId, serverAgentId, remoteSessionId, cliVersion, now(), serverAgentId, target.host, target.port, target.username, target.workdir)
          .changes > 0
      );
    }

    deleteServerAgentSession(conversationId: string, serverAgentId: string): boolean {
      return (
        this.db
          .prepare("DELETE FROM server_agent_sessions WHERE conversation_id = ? AND server_agent_id = ?")
          .run(conversationId, serverAgentId).changes > 0
      );
    }

    /** Server ids that have a resumable session in this conversation. */
    listServerAgentSessionIds(conversationId: string): string[] {
      return (
        this.db
          .prepare("SELECT server_agent_id FROM server_agent_sessions WHERE conversation_id = ?")
          .all(conversationId) as { server_agent_id: string }[]
      ).map((r) => r.server_agent_id);
    }

    deleteServerAgentSessionsForConversation(conversationId: string): void {
      this.db.prepare("DELETE FROM server_agent_sessions WHERE conversation_id = ?").run(conversationId);
    }
  };
}
