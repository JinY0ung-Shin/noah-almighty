import { randomBytes } from "node:crypto";
import {
  SERVER_AGENT_MAX_RUNS_PER_OWNER,
  SERVER_AGENT_MAX_RUNS_PER_SERVER,
  SERVER_AGENT_MAX_RUNS_TOTAL,
} from "../../shared/serverAgents.js";

// In-memory ledger of live remote runs (process-local, like routineRunRegistry).
// A slot is claimed BEFORE connecting and released exactly once by the returned
// function; the run ids double as the "active" set the stale-pid sweep spares.

interface LiveRun {
  ownerUserId: string;
  serverId: string;
}

const live = new Map<string, LiveRun>();
// This PROCESS's id, minted at start. The deployment id is per database, but the
// live ledger above is per process: two processes on one DB (a rolling-deploy
// overlap, replicas) must never treat each other's running runs as stale.
const INSTANCE_ID = randomBytes(6).toString("hex");

/** This process's random instance id (recorded in remote pid files next to the deployment id). */
export function serverAgentInstanceId(): string {
  return INSTANCE_ID;
}
// Server ids whose DELETE is in flight: no run may start on a row that is being
// removed (its remote cleanup could `rm -rf` under a fresh CLI).
const deleting = new Set<string>();
// (conversation, server) pairs with a delegation in flight: two runs resuming
// ONE remote session would write one transcript concurrently.
const sessionLocks = new Set<string>();

export type ServerAgentSlotRefusal = "server" | "owner" | "total" | "deleting";

export function tryAcquireServerAgentSlot(
  runId: string,
  ownerUserId: string,
  serverId: string,
): { ok: true; release: () => void } | { ok: false; reason: ServerAgentSlotRefusal } {
  if (deleting.has(serverId)) return { ok: false, reason: "deleting" };
  let perServer = 0;
  let perOwner = 0;
  for (const run of live.values()) {
    if (run.serverId === serverId) perServer += 1;
    if (run.ownerUserId === ownerUserId) perOwner += 1;
  }
  if (perServer >= SERVER_AGENT_MAX_RUNS_PER_SERVER) return { ok: false, reason: "server" };
  if (perOwner >= SERVER_AGENT_MAX_RUNS_PER_OWNER) return { ok: false, reason: "owner" };
  if (live.size >= SERVER_AGENT_MAX_RUNS_TOTAL) return { ok: false, reason: "total" };
  live.set(runId, { ownerUserId, serverId });
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      live.delete(runId);
    },
  };
}

/** Run ids currently live on one server row (the delete route refuses while any exist). */
export function activeServerAgentRunIds(serverId: string): Set<string> {
  const out = new Set<string>();
  for (const [runId, run] of live) if (run.serverId === serverId) out.add(runId);
  return out;
}

/**
 * EVERY live run id of this process. The stale-pid sweep spares these: remote
 * state is per ACCOUNT, and two rows (or two owners) can target the same one.
 */
export function allActiveServerAgentRunIds(): Set<string> {
  return new Set(live.keys());
}

/**
 * Claim a server row for deletion: slots on it are refused until the returned
 * release runs. Null when another delete of the same row is already in flight.
 */
export function markServerAgentDeleting(serverId: string): (() => void) | null {
  if (deleting.has(serverId)) return null;
  deleting.add(serverId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    deleting.delete(serverId);
  };
}

/** The (conversation, server) remote-session lock; null when a delegation already holds it. */
export function tryLockServerAgentSession(conversationId: string, serverId: string): (() => void) | null {
  const key = `${conversationId}\u0000${serverId}`;
  if (sessionLocks.has(key)) return null;
  sessionLocks.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    sessionLocks.delete(key);
  };
}

/** Test seam. */
export function resetServerAgentSlotsForTests(): void {
  live.clear();
  deleting.clear();
  sessionLocks.clear();
}
