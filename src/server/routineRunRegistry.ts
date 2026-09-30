import type { RoutineJob } from "./types.js";

/**
 * Routines in flight. A LEAF module on purpose: the scheduler owns claiming and
 * releasing, but other readers must be able to ask "is this routine running?"
 * without importing scheduler.ts — which imports the chat route, so the chat
 * route's own check (a rewind must not cut a thread a routine is about to
 * append to) would otherwise be an import cycle. scheduler.ts re-exports
 * `isRoutineRunning`, so its existing import path keeps working.
 */

/**
 * Jobs currently executing. Module-level on purpose: the scheduler tick and
 * the HTTP "run now" route must share ONE overlap guard, or the same job can
 * run twice concurrently.
 */
const runningJobs = new Set<string>();
/**
 * Routines in flight per owner — the per-owner cap's ledger, kept beside
 * `runningJobs` for the same reason: a "run now" occupies its owner's slot too.
 */
const runningPerOwner = new Map<string, number>();

export function claimRoutineSlot(job: Pick<RoutineJob, "id" | "avatarUserId">): void {
  runningJobs.add(job.id);
  runningPerOwner.set(job.avatarUserId, (runningPerOwner.get(job.avatarUserId) ?? 0) + 1);
}

export function releaseRoutineSlot(job: Pick<RoutineJob, "id" | "avatarUserId">): void {
  runningJobs.delete(job.id);
  const left = (runningPerOwner.get(job.avatarUserId) ?? 1) - 1;
  if (left > 0) runningPerOwner.set(job.avatarUserId, left);
  else runningPerOwner.delete(job.avatarUserId);
}

export function isRoutineRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

/** Routines in flight server-wide (the global cap). */
export function runningRoutineCount(): number {
  return runningJobs.size;
}

/** Routines in flight for one owner (the per-owner cap). */
export function runningRoutineCountForOwner(ownerUserId: string): number {
  return runningPerOwner.get(ownerUserId) ?? 0;
}
