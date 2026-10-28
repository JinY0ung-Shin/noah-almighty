// Runner factory: boot layout, uid pool, self-tests, the two sockets. `daemon.mjs` is the process
// entry; tests construct a runner directly with an unprivileged configuration and a fake app.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { validateApp } from "./apps.mjs";
import { DEFAULT_LIMITS, NOAH_GID, NOAH_UID, SELFTEST_UID, UID_MAX, UID_MIN } from "./config.mjs";
import { handleControlConnection } from "./control.mjs";
import { applyOwnerMode, closeQuiet, openDirNoFollow } from "./fsx.mjs";
import { ensureDirAt } from "./mirror.mjs";
import { killUidProcesses, REAL_PROCS } from "./procs.mjs";
import { handleMcpConnection } from "./relay.mjs";
import { sanitizeReportedError, selfTestApp } from "./selftest.mjs";
import { SessionManager } from "./sessions.mjs";
import { UidPool } from "./uids.mjs";

/**
 * Owner resolver. Privileged (production): real uids. Unprivileged (tests): `override` maps every
 * request (e.g. to the test user's own uid so chown paths still run), or null skips chown entirely.
 */
export function makeOwner({ privileged, override }) {
  return (kind, uid) => {
    let want;
    if (kind === "root") want = { uid: 0, gid: 0 };
    else if (kind === "noah") want = { uid: NOAH_UID, gid: NOAH_GID };
    else want = { uid, gid: uid };
    if (privileged) return want;
    return override ? override(want, kind) : null;
  };
}

function removeStaleSocket(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) throw new Error(`${p} is a directory`);
    fs.unlinkSync(p);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

/** Listen on a unix socket created 0600 and owned by `owner` (never following a planted symlink). */
async function listenSocket(server, sockPath, owner) {
  removeStaleSocket(sockPath);
  let prev = null;
  try {
    prev = process.umask(0o177);
  } catch {
    prev = null; // worker threads cannot change the umask (tests); chmod below instead
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    if (prev !== null) process.umask(prev);
  }
  if (prev === null) fs.chmodSync(sockPath, 0o600);
  if (owner) fs.lchownSync(sockPath, owner.uid, owner.gid);
}

/**
 * @param {object} o
 * @param {string} o.exchangeDir
 * @param {string} o.tmpRoot
 * @param {string} o.secret
 * @param {number} [o.maxProcs]
 * @param {object} [o.limits]
 * @param {object[]} o.apps
 * @param {boolean} [o.privileged]      production: chown + session-uid spawns + oom score
 * @param {(want: {uid:number,gid:number}, kind: string) => {uid:number,gid:number}} [o.ownerOverride]
 * @param {{list: Function, kill: Function, sleep: Function}} [o.procs]   process scanner/killer (tests inject a fake)
 * @param {() => number} [o.now]   clock (tests inject one for token expiry)
 * @param {(m: string) => void} [o.log]
 */
export function createRunner(o) {
  const limits = { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
  const log = o.log ?? ((m) => process.stderr.write(`${new Date().toISOString()} craft-runner ${m}\n`));
  const privileged = !!o.privileged;
  const owner = makeOwner({ privileged, override: o.ownerOverride });
  const sockDir = path.join(o.exchangeDir, "sock");
  const controlPath = path.join(sockDir, "control.sock");
  const mcpPath = path.join(sockDir, "mcp.sock");
  const servers = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  const track = (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    return s;
  };
  let gcTimer = null;
  let sweepTimer = null;
  const procs = o.procs ?? REAL_PROCS;
  let sessions = null;
  /** @type {Map<string, {app: object, status: string, manifest?: object, error?: string}>} */
  const apps = new Map();

  function ensureLayout() {
    const fd = openDirNoFollow(o.exchangeDir);
    try {
      applyOwnerMode(fd, owner("root"), 0o711);
    } finally {
      closeQuiet(fd);
    }
    ensureDirAt(o.exchangeDir, "sock", { owner: owner("noah"), mode: 0o700 });
    ensureDirAt(o.exchangeDir, "inbox", { owner: owner("noah"), mode: 0o711 });
    ensureDirAt(o.exchangeDir, "outbox", { owner: owner("noah"), mode: 0o711 });
    ensureDirAt(o.exchangeDir, "work", { owner: owner("root"), mode: 0o711 });
    ensureDirAt(o.exchangeDir, "state", { owner: owner("root"), mode: 0o700 });
    fs.mkdirSync(path.dirname(o.tmpRoot), { recursive: true });
    ensureDirAt(path.dirname(o.tmpRoot), path.basename(o.tmpRoot), { owner: owner("root"), mode: 0o711 });
  }

  async function runSelfTests() {
    for (const app of o.apps) {
      try {
        validateApp(app);
      } catch (err) {
        apps.set(app.id, { app, status: "failed", error: sanitizeReportedError(err.message) });
        continue;
      }
      const r = await selfTestApp(app, {
        tmpRoot: o.tmpRoot,
        ids: privileged ? { uid: SELFTEST_UID, gid: SELFTEST_UID } : null,
        owner,
        limits,
        log,
      });
      apps.set(app.id, { app, ...r });
      if (privileged) {
        // Nothing the probe started may outlive the self-test under its uid.
        const k = await killUidProcesses(SELFTEST_UID, procs, { rounds: limits.uidKillRounds, waitMs: limits.uidKillWaitMs });
        if (!k.ok) log(`self-test ${app.id}: ${k.survivors.length} process(es) of uid ${SELFTEST_UID} survived SIGKILL`);
      }
      log(`self-test ${app.id} ${app.version}: ${r.status}${r.status === "failed" ? ` — ${r.error}` : ` (${r.manifest.tools.length} tools)`}`);
    }
  }

  return {
    controlPath,
    mcpPath,
    apps,
    get sessions() {
      return sessions;
    },
    async start() {
      ensureLayout();
      const uids = new UidPool({ file: path.join(o.exchangeDir, "state", "uids.json"), min: UID_MIN, max: UID_MAX, log }).load();
      await runSelfTests();
      sessions = new SessionManager({
        exchangeDir: o.exchangeDir,
        tmpRoot: o.tmpRoot,
        limits,
        maxProcs: o.maxProcs ?? 3,
        apps,
        uids,
        owner,
        spawnAsSessionUid: privileged,
        procs,
        now: o.now,
        log,
      });
      // Trees whose sid lost its state entry never return (N5) — before any session can be opened.
      await sessions.removeOrphans().catch((err) => log(`orphan sweep: ${err.message}`));
      const ctx = { secret: o.secret, sessions, limits, log };
      const control = net.createServer((s) => handleControlConnection(track(s), ctx));
      const mcp = net.createServer((s) => handleMcpConnection(track(s), ctx));
      servers.push(control, mcp);
      await listenSocket(control, controlPath, owner("noah"));
      await listenSocket(mcp, mcpPath, owner("noah"));
      gcTimer = setInterval(() => {
        sessions.gc().catch((err) => log(`gc: ${err.message}`));
      }, limits.gcIntervalMs);
      gcTimer.unref?.();
      sweepTimer = setInterval(() => {
        sessions.sweepExpired().catch((err) => log(`token sweep: ${err.message}`));
      }, limits.sweepIntervalMs);
      sweepTimer.unref?.();
      log(`listening on ${controlPath} and ${mcpPath} (max ${o.maxProcs ?? 3} app processes)`);
    },
    async stop() {
      if (gcTimer) clearInterval(gcTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      const closing = servers.map((s) => new Promise((r) => s.close(() => r())));
      if (sessions) await sessions.shutdown();
      for (const s of sockets) s.destroy();
      await Promise.all(closing);
      for (const p of [controlPath, mcpPath]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* already gone */
        }
      }
    },
  };
}
