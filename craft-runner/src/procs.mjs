// Kill EVERY process of a session uid (spec Addendum A3) — not just the app child's process group.
// An app process (or a helper it started) can setsid()/setpgid() out of the group the runner SIGKILLs;
// before the uid goes back to the pool (or a revoked session's slot is considered free) every process
// whose real/effective/saved/fs uid is that uid is SIGKILLed, and the kill is VERIFIED by re-scanning.
// The daemon has CAP_KILL; the container's pid namespace limits the scan to the runner container.
//
// `procs` is injectable ({ list, kill, sleep }) so tests run unprivileged without touching real processes.

import fs from "node:fs";
import { SELFTEST_UID, UID_MAX, UID_MIN } from "./config.mjs";

/**
 * Parse /proc/<pid>/status text into { uids:number[4], state:string } (null when unparsable).
 * @param {string} text
 */
export function parseProcStatus(text) {
  const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(text);
  if (!uid) return null;
  const state = /^State:\s+(\S)/m.exec(text);
  const threads = /^Threads:\s+(\d+)/m.exec(text);
  return { uids: uid.slice(1, 5).map(Number), state: state ? state[1] : "?", threads: threads ? Number(threads[1]) : 1 };
}

/** Real /proc scanner: every numeric /proc entry → { pid, uids, state, threads }. Vanished pids are skipped. */
export function listProcs(procRoot = "/proc") {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let text;
    try {
      text = fs.readFileSync(`${procRoot}/${name}/status`, "utf8");
    } catch {
      continue;
    }
    const st = parseProcStatus(text);
    if (st) out.push({ pid: Number(name), ...st });
  }
  return out;
}

export const REAL_PROCS = Object.freeze({
  list: () => listProcs(),
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ESRCH: already gone */
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Only session-pool uids and the self-test uid may ever be mass-killed (never root, Noah or the daemon). */
export const killableUid = (uid) =>
  Number.isInteger(uid) && ((uid >= UID_MIN && uid <= UID_MAX) || uid === SELFTEST_UID) && uid !== process.getuid?.();

/**
 * Whether a scanned entry still RUNS code. A dead entry (X) and a zombie whose thread group is gone hold
 * nothing an attacker can use (the parent / tini reaps them). A zombie LEADER whose other threads still
 * run (`pthread_exit()` from main: `State: Z`, `Threads: N>1` — "<defunct>" but running) is alive (N1).
 */
export const isLiveProc = (p) => {
  if (p.state === "X" || p.state === "x") return false;
  if (p.state === "Z") return (p.threads ?? 1) > 1;
  return true;
};

/**
 * SIGKILL every process of `uid` — REGARDLESS of its state (a kill sent to a zombie leader reaches its
 * still-running threads; one sent to a plain zombie is a harmless no-op) — until a scan finds none
 * alive (`isLiveProc`).
 * @param {number} uid
 * @param {{list: () => {pid:number, uids:number[], state:string, threads?:number}[], kill: (pid:number) => void, sleep: (ms:number) => Promise<void>}} procs
 * @param {{ rounds?: number, waitMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, killed: number, survivors: number[] }>}
 */
export async function killUidProcesses(uid, procs, { rounds = 50, waitMs = 20 } = {}) {
  if (!killableUid(uid)) throw new Error(`refusing to kill processes of uid ${uid}`);
  const killed = new Set();
  let survivors = [];
  for (let round = 0; round <= rounds; round += 1) {
    const matching = procs.list().filter((p) => p.uids.includes(uid));
    survivors = matching.filter(isLiveProc).map((p) => p.pid);
    if (survivors.length === 0) {
      // Nothing runs any more; zombies that are left get one (no-op) kill so no state is special-cased.
      for (const p of matching) procs.kill(p.pid);
      return { ok: true, killed: killed.size, survivors: [] };
    }
    if (round === rounds) break;
    for (const p of matching) {
      if (isLiveProc(p)) killed.add(p.pid);
      procs.kill(p.pid);
    }
    await procs.sleep(waitMs);
  }
  return { ok: false, killed: killed.size, survivors };
}
