// Session state: per-sid uid + directories, per-run tokens, per-(token, app) child processes.

import fs from "node:fs";
import path from "node:path";
import { AppProcess, buildChildEnv } from "./appProcess.mjs";
import { ensureDirAt, lstatOwner, mirrorTree } from "./mirror.mjs";
import { tokenIdOf, TOKEN_ID_RE } from "./auth.mjs";
import { UID_MAX, UID_MIN } from "./config.mjs";
import { measureTreeAsync, removeTreeAt } from "./fsx.mjs";
import { isValidSid, isValidToken, sessionLayout } from "./paths.mjs";
import { killableUid, killUidProcesses, REAL_PROCS } from "./procs.mjs";
import { KeyedMutex, Semaphore } from "./semaphore.mjs";

/**
 * A refused request (answered `{ok:false, error}`); `extra` fields ride the reply too (e.g. `budget`).
 */
export class RequestError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(message, extra) {
    super(message);
    this.extra = extra ?? null;
  }
}

/** `grant` of a sid that was never opened, or was purged (N8). */
export const NO_SUCH_SESSION = "no such session — open it first";

const MiB = 1024 * 1024;
/** Human-readable byte count for budget messages (agent-facing English). */
export function fmtBytes(n) {
  if (n >= 1024 * MiB) return `${(n / (1024 * MiB)).toFixed(n % (1024 * MiB) === 0 ? 0 : 2)} GiB`;
  if (n >= MiB) return `${(n / MiB).toFixed(n % MiB === 0 ? 0 : 1)} MiB`;
  return `${n} bytes`;
}

/**
 * Budget verdict text (agent-facing English: what happened and what to delete/export). Pure.
 * `phase` names what was refused: an app call (default), opening a NEW session, or copying inputs in.
 * @param {{over: null|"session"|"exchange", outBytes:number, outMaxBytes:number, outUnmeasured:number, exchangeBytes:number, exchangeMaxBytes:number}} b
 * @param {"call"|"open"|"sync_in"} [phase]
 */
export function budgetMessage(b, phase = "call") {
  if (b.over === "exchange" && phase === "open") {
    return (
      `Craft storage budget exceeded: the craft runner's shared storage holds ${fmtBytes(b.exchangeBytes)} of its ` +
      `${fmtBytes(b.exchangeMaxBytes)} budget, so no new Craft session can be opened until space is freed. Ask the ` +
      `user to delete old conversations that used Craft apps (deleting a conversation frees its Craft files), then ` +
      `retry in a new message.`
    );
  }
  if (b.over === "exchange" && phase === "sync_in") {
    return (
      `Craft storage budget exceeded: the craft runner's shared storage holds ${fmtBytes(b.exchangeBytes)} of its ` +
      `${fmtBytes(b.exchangeMaxBytes)} budget, so no new input files were copied in for the Craft apps (files copied ` +
      `in earlier stay readable under in/). Deliver finished results with share_file (they are in the workspace ` +
      `under craft/out/), and ask the user to delete old conversations that used Craft apps (deleting a ` +
      `conversation frees its Craft files) before staging more files.`
    );
  }
  if (b.over === "session") {
    const why =
      b.outUnmeasured > 0
        ? `contains directories nested more than 32 levels deep, which the runner neither measures nor copies`
        : `holds ${fmtBytes(b.outBytes)}, over its ${fmtBytes(b.outMaxBytes)} per-conversation budget`;
    return (
      `Craft storage budget exceeded: this conversation's out/ directory ${why}, so further Craft app calls in this ` +
      `conversation are refused. The results already written are in the workspace under craft/out/ — deliver the ` +
      `ones the user needs with share_file now, then tell the user to continue the edit in a NEW conversation ` +
      `(deleting this conversation frees its Craft files). Do not retry the call here.`
    );
  }
  if (b.over === "exchange") {
    return (
      `Craft storage budget exceeded: the craft runner's shared storage holds ${fmtBytes(b.exchangeBytes)} of its ` +
      `${fmtBytes(b.exchangeMaxBytes)} budget, so Craft app calls are refused until space is freed. Deliver finished ` +
      `results with share_file (they are in the workspace under craft/out/), and ask the user to delete old ` +
      `conversations that used Craft apps (deleting a conversation frees its Craft files) before retrying.`
    );
  }
  return "";
}

/**
 * @typedef {object} TokenEntry
 * @property {string} token
 * @property {string} sid
 * @property {boolean} revoked
 * @property {Map<string, {proc: AppProcess|null, starting: Promise<AppProcess>|null, idleTimer: NodeJS.Timeout|null}>} procs
 * @property {Map<string, {close: () => void, notify: (msg: object) => void}>} conns   per app id
 */

export class SessionManager {
  /**
   * @param {object} o
   * @param {string} o.exchangeDir
   * @param {string} o.tmpRoot
   * @param {object} o.limits
   * @param {number} o.maxProcs
   * @param {Map<string, {app: object, status: string, manifest?: object, error?: string}>} o.apps
   * @param {import("./uids.mjs").UidPool} o.uids
   * @param {(kind: "root"|"noah"|"session", uid?: number) => ({uid:number,gid:number}|null)} o.owner
   * @param {boolean} o.spawnAsSessionUid
   * @param {(m: string) => void} o.log
   */
  constructor(o) {
    this.o = o;
    this.limits = o.limits;
    this.log = o.log;
    this.slots = new Semaphore(o.maxProcs);
    this.mutex = new KeyedMutex();
    /** @type {Map<string, TokenEntry>} */
    this.tokens = new Map();
    /** @type {Map<string, string>} sha256(token) hex → token (attach looks tokens up ONLY by this id) */
    this.tokenIds = new Map();
    /** @type {Map<string, string>} sid → token */
    this.sidTokens = new Map();
    this.procs = o.procs ?? REAL_PROCS;
    this.now = o.now ?? (() => Date.now());
    /** @type {Map<string, {bytes:number, unmeasured:number}>} sid → last measured work/<sid>/out usage */
    this.outUsage = new Map();
    /** @type {{bytes:number, at:number}|null} */
    this.exchangeCache = null;
    /** @type {Promise<number>|null} the walk in flight (shared) */
    this.exchangeMeasuring = null;
    this.exchangeGen = 0;
    this.outGrowthSinceMeasure = 0;
    /** @type {Map<string, number>} sid → last activity (ms) */
    this.activity = new Map();
    const boot = Date.now();
    for (const sid of o.uids.sids()) this.activity.set(sid, boot);
  }

  layout(sid) {
    return sessionLayout(this.o.exchangeDir, sid, this.o.tmpRoot);
  }

  requireSid(sid) {
    if (!isValidSid(sid)) throw new RequestError("invalid sid (expected 32 lowercase hex characters)");
  }

  touch(sid) {
    this.activity.set(sid, Date.now());
  }

  /**
   * `open {sid}` — idempotent: uid + directory tree. Opening a NEW session is refused while the exchange
   * is over its budget (N2); an existing session still opens, so its results can be delivered.
   */
  async open(sid) {
    this.requireSid(sid);
    if (this.o.uids.get(sid) === undefined) {
      const b = await this.exchangeBudget();
      if (b.over) {
        const budget = { ...b, message: budgetMessage(b, "open") };
        throw new RequestError(budget.message, { budget });
      }
    }
    return this.mutex.run(sid, () => this.openLocked(sid));
  }

  /**
   * uids that still own a process or a directory under work/ or the tmp root (N5): a uid whose session
   * state was lost must not be handed to another conversation while anything of it is left.
   * @returns {Set<number>}
   */
  busyUids() {
    const busy = new Set();
    for (const p of this.procs.list()) for (const u of p.uids) busy.add(u);
    for (const parent of [path.join(this.o.exchangeDir, "work"), this.o.tmpRoot]) {
      let names;
      try {
        names = fs.readdirSync(parent);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          busy.add(fs.lstatSync(path.join(parent, name)).uid);
        } catch {
          /* vanished */
        }
      }
    }
    return busy;
  }

  openLocked(sid) {
    const uid = this.o.uids.allocate(sid, { busy: () => this.busyUids() });
    const L = this.layout(sid);
    const root = this.o.owner("root");
    const session = this.o.owner("session", uid);
    const noah = this.o.owner("noah");
    const workParent = path.dirname(L.work);
    if (session) {
      // A work dir left behind by a different uid (state/uids.json lost or reset) is rebuilt rather
      // than re-owned in place: its content is only mirrors (in/) and results already synced out.
      const have = lstatOwner(L.work);
      if (have && (!have.isDir || have.uid !== session.uid)) {
        this.log(`session ${sid}: work dir owner mismatch; rebuilding`);
        removeTreeAt(workParent, sid);
      }
    }
    ensureDirAt(workParent, sid, { owner: session, mode: 0o700 });
    ensureDirAt(L.work, "in", { owner: root, mode: 0o755 });
    ensureDirAt(L.work, "out", { owner: session, mode: 0o700 });
    ensureDirAt(path.dirname(L.outbox), sid, { owner: noah, mode: 0o700 });
    ensureDirAt(this.o.tmpRoot, sid, { owner: session, mode: 0o700 });
    ensureDirAt(L.tmp, "home", { owner: session, mode: 0o700 });
    ensureDirAt(L.tmp, "tmp", { owner: session, mode: 0o700 });
    this.touch(sid);
    return { sid, inDir: L.inDir, outDir: L.outDir };
  }

  /**
   * `sync_in {sid}` — inbox/<sid> → work/<sid>/in (root-owned, read-only for the app). Needs an opened
   * session (a sync after purge never resurrects it, N8) and refuses new bytes while the exchange is over
   * its budget (N2; what in/ already holds stays).
   */
  async syncIn(sid) {
    this.requireSid(sid);
    if (this.o.uids.get(sid) === undefined) throw new RequestError("unknown session; call open first");
    const b = await this.budgetState(sid);
    if (b.exchangeBytes > b.exchangeMaxBytes) {
      const over = { ...b, over: "exchange" };
      const budget = { ...over, message: budgetMessage(over, "sync_in") };
      throw new RequestError(budget.message, { budget });
    }
    return this.mutex.run(sid, async () => {
      if (this.o.uids.get(sid) === undefined) throw new RequestError("unknown session; call open first");
      this.openLocked(sid);
      const L = this.layout(sid);
      const r = await mirrorTree({
        srcAbs: L.inbox,
        dstAbs: L.inDir,
        limits: this.limits,
        owner: this.o.owner("root"),
        fileMode: 0o644,
        dirMode: 0o755,
        rejectHardlinks: false,
      });
      return {
        copied: r.copied,
        removed: r.removed,
        skipped: r.skipped,
        bytes: r.bytes,
        rejected: r.rejected,
        rejectedTotal: r.rejectedTotal,
      };
    });
  }

  /** `sync_out {sid}` — work/<sid>/out → outbox/<sid> (uid 1000, 0600 files / 0700 dirs). */
  async syncOut(sid) {
    this.requireSid(sid);
    if (this.o.uids.get(sid) === undefined) throw new RequestError("unknown session; call open first");
    return this.mutex.run(sid, async () => {
      const L = this.layout(sid);
      const r = await mirrorTree({
        srcAbs: L.outDir,
        dstAbs: L.outbox,
        limits: this.limits,
        owner: this.o.owner("noah"),
        fileMode: 0o600,
        dirMode: 0o700,
        rejectHardlinks: true,
      });
      this.touch(sid);
      this.recordOutUsage(sid, { bytes: r.srcBytes, unmeasured: r.srcUnmeasured });
      return { files: r.files, rejected: r.rejected, rejectedTotal: r.rejectedTotal, budget: await this.budgetState(sid) };
    });
  }

  // ----- disk budgets (Addendum A4) -----

  recordOutUsage(sid, usage) {
    const prev = this.outUsage.get(sid)?.bytes ?? 0;
    if (usage.bytes > prev) this.outGrowthSinceMeasure += usage.bytes - prev;
    this.outUsage.set(sid, usage);
  }

  /**
   * Bytes on the exchange volume (inbox + work + outbox), re-walked at most every `exchangeMeasureMs`.
   * The walk is ASYNC (it never stalls the relays) and shared by concurrent callers; a purge during a
   * walk invalidates its result.
   * @returns {Promise<number>}
   */
  async exchangeUsage({ force = false } = {}) {
    const stale =
      !this.exchangeCache ||
      this.now() - this.exchangeCache.at >= this.limits.exchangeMeasureMs ||
      this.outGrowthSinceMeasure > this.limits.exchangeRemeasureDeltaBytes;
    if (!force && !stale) return this.exchangeCache.bytes;
    if (!this.exchangeMeasuring) {
      const gen = this.exchangeGen;
      const growthAtStart = this.outGrowthSinceMeasure;
      const at = this.now();
      this.exchangeMeasuring = (async () => {
        let bytes = 0;
        for (const d of ["inbox", "work", "outbox"]) {
          try {
            bytes += (await measureTreeAsync(path.join(this.o.exchangeDir, d), this.limits.maxDepth + 3)).bytes;
          } catch (err) {
            this.log(`exchange measure ${d}: ${err.message}`);
          }
        }
        if (gen === this.exchangeGen) {
          this.exchangeCache = { bytes, at };
          this.outGrowthSinceMeasure = Math.max(0, this.outGrowthSinceMeasure - growthAtStart);
        }
        return bytes;
      })().finally(() => {
        this.exchangeMeasuring = null;
      });
    }
    return this.exchangeMeasuring;
  }

  /** Forget the cached exchange measurement (after a purge freed space). */
  invalidateExchange() {
    this.exchangeCache = null;
    this.exchangeGen += 1;
  }

  /** The exchange-only verdict (no session needed; `open` of a new sid uses it). */
  async exchangeBudget() {
    const exchangeBytes = await this.exchangeUsage();
    return {
      outBytes: 0,
      outMaxBytes: this.limits.sessionOutMaxBytes,
      outUnmeasured: 0,
      exchangeBytes,
      exchangeMaxBytes: this.limits.exchangeMaxBytes,
      over: exchangeBytes > this.limits.exchangeMaxBytes ? "exchange" : null,
    };
  }

  /**
   * The session's budget verdict: its out/ against `sessionOutMaxBytes` (a subtree too deep to measure
   * fails closed) and the whole exchange against `exchangeMaxBytes`.
   */
  async budgetState(sid) {
    let out = this.outUsage.get(sid);
    if (!out) {
      try {
        const m = await measureTreeAsync(this.layout(sid).outDir, this.limits.maxDepth);
        out = { bytes: m.bytes, unmeasured: m.unmeasured };
      } catch {
        out = { bytes: 0, unmeasured: 0 };
      }
      this.outUsage.set(sid, out);
    }
    const exchangeBytes = await this.exchangeUsage();
    const b = {
      outBytes: out.bytes,
      outMaxBytes: this.limits.sessionOutMaxBytes,
      outUnmeasured: out.unmeasured,
      exchangeBytes,
      exchangeMaxBytes: this.limits.exchangeMaxBytes,
      over:
        out.bytes > this.limits.sessionOutMaxBytes || out.unmeasured > 0
          ? "session"
          : exchangeBytes > this.limits.exchangeMaxBytes
            ? "exchange"
            : null,
    };
    return b.over ? { ...b, message: budgetMessage(b) } : b;
  }

  /** `grant {sid, token}` — one live token per sid; a new grant revokes the previous one. */
  async grant(sid, token) {
    this.requireSid(sid);
    if (!isValidToken(token)) throw new RequestError("invalid token (expected 64 lowercase hex characters)");
    const existing = this.tokens.get(token);
    if (existing) {
      if (existing.sid !== sid) throw new RequestError("token is already bound to another session");
      if (this.isExpired(existing)) {
        await this.revoke(token);
        throw new RequestError("token expired");
      }
      return {}; // idempotent; never extends the lifetime
    }
    // Never (re)opens: a grant after purge must not resurrect the session (N8).
    if (this.o.uids.get(sid) === undefined) throw new RequestError(NO_SUCH_SESSION);
    const old = this.sidTokens.get(sid);
    if (old) await this.revoke(old);
    let displaced;
    await this.mutex.run(sid, () => {
      // Re-checked under the session lock: a purge that ran meanwhile freed the sid.
      if (this.o.uids.get(sid) === undefined) throw new RequestError(NO_SUCH_SESSION);
      if (this.tokens.has(token)) return; // a concurrent identical grant won
      displaced = this.sidTokens.get(sid); // a concurrent grant of another token
      const grantedAt = this.now();
      this.tokens.set(token, {
        token,
        sid,
        revoked: false,
        grantedAt,
        expiresAt: grantedAt + this.limits.tokenTtlMs,
        procs: new Map(),
        conns: new Map(),
      });
      this.tokenIds.set(tokenIdOf(token), token);
      this.sidTokens.set(sid, token);
      this.touch(sid);
    });
    if (displaced && displaced !== token) await this.revoke(displaced);
    return {};
  }

  isExpired(entry) {
    return this.now() >= entry.expiresAt;
  }

  /** `revoke_all {}` — revoke every live token (Noah sends it once at boot, best-effort). */
  async revokeAll() {
    const all = [...this.tokens.keys()];
    for (const token of all) await this.revoke(token);
    return { revoked: all.length };
  }

  /** Sweeper: revoke every token past its absolute expiry. Returns the number revoked. */
  async sweepExpired() {
    let n = 0;
    for (const entry of [...this.tokens.values()]) {
      if (!this.isExpired(entry)) continue;
      this.log(`session ${entry.sid}: token expired; revoking`);
      await this.revoke(entry.token);
      n += 1;
    }
    return n;
  }

  /** SIGKILL every process of the session's uid (not just the child's process group) and verify. */
  async killSessionUid(sid) {
    const uid = this.o.uids.get(sid);
    if (uid === undefined) return { ok: true, killed: 0, survivors: [] };
    const r = await killUidProcesses(uid, this.procs, { rounds: this.limits.uidKillRounds, waitMs: this.limits.uidKillWaitMs });
    if (r.killed > 0) this.log(`session ${sid}: killed ${r.killed} stray process(es) of uid ${uid}`);
    if (!r.ok) this.log(`session ${sid}: ${r.survivors.length} process(es) of uid ${uid} survived SIGKILL`);
    return r;
  }

  /** `revoke {token}` — kill the token's processes, close its MCP connections, final out sync. */
  async revoke(token) {
    if (!isValidToken(token)) throw new RequestError("invalid token (expected 64 lowercase hex characters)");
    const entry = this.tokens.get(token);
    if (!entry) return {};
    await this.dropToken(entry);
    try {
      await this.syncOut(entry.sid);
    } catch (err) {
      this.log(`session ${entry.sid}: final sync_out failed: ${err.message}`);
    }
    this.touch(entry.sid);
    return {};
  }

  /** Revoke without the final sync (safe while holding the sid's mutex): unregister, close, kill. */
  async dropToken(entry) {
    entry.revoked = true;
    const { token } = entry;
    this.tokens.delete(token);
    this.tokenIds.delete(tokenIdOf(token));
    if (this.sidTokens.get(entry.sid) === token) this.sidTokens.delete(entry.sid);
    for (const conn of entry.conns.values()) conn.close();
    entry.conns.clear();
    await this.killProcs(entry);
    // Escaped helpers (setsid/setpgid) of this run die with it — unless a newer token already took the sid.
    if (!this.sidTokens.has(entry.sid)) {
      try {
        await this.killSessionUid(entry.sid);
      } catch (err) {
        this.log(`session ${entry.sid}: uid kill failed: ${err.message}`);
      }
    }
  }

  async killProcs(entry) {
    const waits = [];
    for (const pe of entry.procs.values()) {
      if (pe.idleTimer) clearTimeout(pe.idleTimer);
      const proc = pe.proc ?? (pe.starting ? await pe.starting.catch(() => null) : null);
      if (proc) {
        proc.kill("revoked");
        waits.push(proc.waitExit());
      }
    }
    entry.procs.clear();
    await Promise.all(waits);
  }

  /** `purge {sid}` — revoke, delete inbox/work/outbox/tmp, free the uid. */
  async purge(sid) {
    this.requireSid(sid);
    const token = this.sidTokens.get(sid);
    if (token) await this.revoke(token);
    await this.mutex.run(sid, async () => {
      const L = this.layout(sid);
      // A token granted between the revoke above and this lock dies too (no sync: the trees go anyway).
      const late = this.sidTokens.get(sid);
      const lateEntry = late === undefined ? undefined : this.tokens.get(late);
      if (lateEntry) await this.dropToken(lateEntry);
      // Every process of the uid must be gone BEFORE the uid can return to the pool (Addendum A3).
      const killed = await this.killSessionUid(sid);
      // Each tree independently: one that cannot be removed never stops the others.
      const failures = [];
      const trees = [
        ["inbox", path.dirname(L.inbox), sid],
        ["work", path.dirname(L.work), sid],
        ["outbox", path.dirname(L.outbox), sid],
        ["tmp", this.o.tmpRoot, sid],
      ];
      const removeOpts = { maxDepth: this.limits.maxDepth, maxOps: this.limits.removeMaxOps };
      for (const [label, parent, name] of trees) {
        try {
          removeTreeAt(parent, name, removeOpts);
        } catch (err) {
          failures.push(label);
          this.log(`purge ${sid}: could not remove ${label}: ${err.message}`);
        }
      }
      this.outUsage.delete(sid);
      this.invalidateExchange();
      // A uid whose processes survived, or with any tree left behind (work/tmp are owned by that uid),
      // stays RESERVED and tracked — handing it to another conversation would give that session the
      // leftovers — and the GC retries the purge later.
      if (killed.ok && failures.length === 0) {
        this.o.uids.free(sid);
        this.activity.delete(sid);
      } else {
        this.touch(sid); // the GC retries later
      }
      if (!killed.ok) {
        throw new RequestError(`purge incomplete: ${killed.survivors.length} process(es) of the session uid survived; the uid stays reserved`);
      }
      if (failures.length) throw new RequestError(`purge incomplete: could not remove ${failures.join(", ")}`);
    });
    return {};
  }

  /**
   * Find a live token entry by its id (sha256 hex of the token) — the relay never sends the token.
   * Throws a RequestError for a malformed, unknown, revoked or expired id.
   */
  lookupTokenId(tokenId) {
    if (typeof tokenId !== "string" || !TOKEN_ID_RE.test(tokenId)) throw new RequestError("invalid tokenId");
    const token = this.tokenIds.get(tokenId);
    const entry = token === undefined ? undefined : this.tokens.get(token);
    if (!entry || entry.revoked) throw new RequestError("unknown or revoked token");
    if (this.isExpired(entry)) {
      this.revoke(entry.token).catch((err) => this.log(`revoke of an expired token failed: ${err.message}`));
      throw new RequestError("unknown or revoked token");
    }
    return entry;
  }

  /** Resolve the app for an attach whose MAC was verified; throws a RequestError. */
  attach(entry, appId) {
    if (!entry || entry.revoked) throw new RequestError("unknown or revoked token");
    const state = this.o.apps.get(appId);
    if (!state) throw new RequestError("unknown app");
    if (state.status !== "ready") throw new RequestError(`app ${appId} is not available (${state.error ?? state.status})`);
    this.touch(entry.sid);
    return { entry, state };
  }

  /** Register a relay connection for (token, app); an older connection for the same pair is closed. */
  addConn(entry, appId, conn) {
    const prev = entry.conns.get(appId);
    if (prev && prev !== conn) prev.close();
    entry.conns.set(appId, conn);
  }

  removeConn(entry, appId, conn) {
    if (entry.conns.get(appId) === conn) entry.conns.delete(appId);
  }

  /**
   * The live child for (token, app), spawning it (bounded by the global slot cap) when absent.
   * Concurrent callers share one spawn.
   * @returns {Promise<AppProcess>}
   */
  async getProc(entry, appId, initParams) {
    const existing = entry.procs.get(appId);
    if (existing) {
      const proc = existing.proc ?? (await existing.starting);
      if (proc.alive) return proc;
    }
    if (entry.revoked) throw new RequestError("session revoked");
    const state = this.o.apps.get(appId);
    const pe = { proc: null, starting: null, idleTimer: null };
    pe.starting = this.spawn(entry, state, pe, initParams);
    entry.procs.set(appId, pe);
    try {
      pe.proc = await pe.starting;
      return pe.proc;
    } catch (err) {
      if (entry.procs.get(appId) === pe) entry.procs.delete(appId);
      throw err;
    } finally {
      pe.starting = null;
    }
  }

  async spawn(entry, state, pe, initParams) {
    const { app } = state;
    const release = await this.slots.acquire(this.limits.spawnWaitMs);
    if (entry.revoked) {
      release();
      throw new RequestError("session revoked");
    }
    const uid = this.o.uids.get(entry.sid);
    // N9: never spawn without a valid session uid — `uid: undefined` would make Node run the app as root.
    if (this.o.spawnAsSessionUid && !(Number.isInteger(uid) && uid >= UID_MIN && uid <= UID_MAX)) {
      release();
      this.log(`session ${entry.sid}: refusing to spawn ${app.id}: no valid session uid`);
      throw new RequestError("the session has no valid uid (purged?); refusing to start the app");
    }
    const L = this.layout(entry.sid);
    const proc = new AppProcess({
      app,
      readRoot: L.work,
      writeRoot: L.outDir,
      cwd: L.work,
      env: buildChildEnv({ home: L.home, tmpDir: L.tmpDir }, app.env),
      ids: this.o.spawnAsSessionUid ? { uid, gid: uid } : null,
      limits: this.limits,
      log: (m) => this.log(`session ${entry.sid}: ${m}`),
    });
    proc.once("exit", (why) => {
      release();
      if (pe.idleTimer) clearTimeout(pe.idleTimer);
      if (entry.procs.get(app.id) === pe) entry.procs.delete(app.id);
      this.log(`session ${entry.sid}: ${app.id} exited (${why})`);
    });
    proc.on("notification", (msg) => {
      if (msg.method === "notifications/progress") entry.conns.get(app.id)?.notify(msg);
    });
    try {
      await proc.start(initParams);
    } catch (err) {
      proc.kill("start failed");
      if (!proc.child) release();
      throw err;
    }
    this.log(`session ${entry.sid}: ${app.id} started (pid ${proc.pid})`);
    this.armIdle(entry, app.id);
    return proc;
  }

  /** (Re)arm the idle timer: a child without calls for `idleMs` is killed; the next call respawns. */
  armIdle(entry, appId) {
    const pe = entry.procs.get(appId);
    if (!pe) return;
    if (pe.idleTimer) clearTimeout(pe.idleTimer);
    pe.idleTimer = setTimeout(() => {
      const proc = pe.proc;
      if (!proc || !proc.alive) return;
      if (proc.inFlight > 0) {
        this.armIdle(entry, appId);
        return;
      }
      proc.kill("idle");
    }, this.limits.idleMs);
    pe.idleTimer.unref?.();
  }

  async health() {
    return {
      apps: [...this.o.apps.values()].map((s) => ({
        id: s.app.id,
        version: s.app.version,
        status: s.status,
        ...(s.error ? { error: s.error } : {}),
        tools: s.manifest?.tools.length ?? 0,
      })),
      procs: { running: this.slots.running, max: this.slots.max },
      sessions: this.o.uids.size,
      exchange: { bytes: await this.exchangeUsage(), maxBytes: this.limits.exchangeMaxBytes },
    };
  }

  /** Purge sessions idle for `sessionGcMs` without a live token. Returns the purged sids. */
  async gc(now = this.now()) {
    await this.sweepExpired();
    await this.removeOrphans();
    const purged = [];
    for (const sid of this.o.uids.sids()) {
      if (this.sidTokens.has(sid)) continue;
      const last = this.activity.get(sid) ?? now;
      if (now - last < this.limits.sessionGcMs) continue;
      try {
        await this.purge(sid);
        purged.push(sid);
      } catch (err) {
        this.log(`gc ${sid}: ${err.message}`);
      }
    }
    return purged;
  }

  /**
   * Remove session trees (work/<sid>, outbox/<sid>, <tmp>/<sid>) whose sid has NO state entry (N5:
   * uids.json lost or reset, or an allocation that never persisted). Their owner uid's processes are
   * killed first when no tracked session holds that uid. Runs at boot and on every GC pass.
   * @returns {Promise<string[]>} removed `<tree>/<sid>` labels
   */
  async removeOrphans() {
    const removed = [];
    const removeOpts = { maxDepth: this.limits.maxDepth, maxOps: this.limits.removeMaxOps };
    const trees = [
      ["work", path.join(this.o.exchangeDir, "work")],
      ["outbox", path.join(this.o.exchangeDir, "outbox")],
      ["tmp", this.o.tmpRoot],
    ];
    const heldUids = () => new Set(this.o.uids.sids().map((sid) => this.o.uids.get(sid)));
    for (const [label, parent] of trees) {
      let names;
      try {
        names = fs.readdirSync(parent);
      } catch {
        continue;
      }
      for (const sid of names) {
        if (!isValidSid(sid) || this.o.uids.get(sid) !== undefined) continue;
        await this.mutex.run(sid, async () => {
          if (this.o.uids.get(sid) !== undefined) return; // opened meanwhile
          let owner;
          try {
            owner = fs.lstatSync(path.join(parent, sid)).uid;
          } catch {
            return;
          }
          if (owner >= UID_MIN && owner <= UID_MAX && killableUid(owner) && !heldUids().has(owner)) {
            try {
              const k = await killUidProcesses(owner, this.procs, { rounds: this.limits.uidKillRounds, waitMs: this.limits.uidKillWaitMs });
              if (!k.ok) {
                this.log(`orphan ${label}/${sid}: ${k.survivors.length} process(es) of uid ${owner} survived; kept for a retry`);
                return;
              }
            } catch (err) {
              this.log(`orphan ${label}/${sid}: uid kill failed: ${err.message}`);
              return;
            }
          }
          try {
            removeTreeAt(parent, sid, removeOpts);
            removed.push(`${label}/${sid}`);
          } catch (err) {
            this.log(`orphan ${label}/${sid}: could not remove: ${err.message}`);
          }
        });
      }
    }
    if (removed.length) {
      this.log(`removed ${removed.length} orphan session tree(s) without a state entry`);
      this.invalidateExchange();
    }
    return removed;
  }

  async shutdown() {
    for (const token of [...this.tokens.keys()]) {
      const entry = this.tokens.get(token);
      for (const conn of entry.conns.values()) conn.close();
      await this.killProcs(entry);
    }
  }
}
