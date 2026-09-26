// Child processes, deadlines, cancellation and the per-run temp dir (docs/CONTRACT.md "Cancellation").
//
// Every child is registered; cancelAll() sends SIGTERM, then SIGKILL after 3 s, and no child starts after it (the
// pipeline then reports the run as `cancelled`, exit 130/143). Python children arm PDEATHSIG (tools/pdeathsig.py),
// Chromium exits when its CDP pipe closes, and the extractor child runs its own orphan watchdog — so a SIGKILLed
// deck.mjs leaves nothing running. All temp state of a run lives in
// $TMPDIR/noah-pptx-run-<pid>-<rand>/ (Chromium profile, HOME and TMPDIR of every child), removed on exit; stale
// ones (dead pid, or older than 1 h) are swept at startup. Nothing else under $TMPDIR is ever touched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const RUN_PREFIX = 'noah-pptx-run-';
const STALE_MS = 60 * 60 * 1000;
const KILL_GRACE_MS = 3000;
/** Signals that mean "stop" (a supervisor, Ctrl-C, a hang-up) — never a crash of the child itself. */
const TERM_SIGNALS = new Set(['SIGTERM', 'SIGINT', 'SIGHUP']);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Remove $TMPDIR/noah-pptx-run-<pid>-* whose pid is dead or that are older than 1 h. */
export function sweepStaleRunDirs(tmp = os.tmpdir()) {
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const m = /^noah-pptx-run-(\d+)-[0-9a-f]+$/.exec(name);
    if (!m) continue;
    const p = path.join(tmp, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const pid = Number(m[1]);
    const stale = pid !== process.pid && (!pidAlive(pid) || Date.now() - st.mtimeMs > STALE_MS);
    if (!stale) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
      n++;
    } catch {
      /* not ours to remove */
    }
  }
  return n;
}

/**
 * The base directory of run dirs: $TMPDIR, unless it is so long that Chromium's singleton socket
 * <TMPDIR>/noah-pptx-run-<pid:7>-<8 hex>/org.chromium.Chromium.XXXXXX/SingletonSocket (TMPDIR + 76 bytes) would exceed
 * the 108-byte UNIX socket path limit: the full Chromium build then aborts at startup ("Socket path too long", measured;
 * the headless shell does not bind that socket). Such a TMPDIR (> 30 characters) falls back to /tmp.
 */
export function runBase(tmp = os.tmpdir()) {
  if (tmp.length <= 30) return tmp;
  try {
    fs.accessSync('/tmp', fs.constants.W_OK);
    return '/tmp';
  } catch {
    return tmp;
  }
}

export function makeRunDir(tmp = os.tmpdir()) {
  const dir = path.join(runBase(tmp), `${RUN_PREFIX}${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  return dir;
}

export class Children {
  constructor() {
    this.set = new Set();
    /** cancelAll() ran: every child was told to stop, and no new child starts. */
    this.cancelled = false;
    /**
     * The first SIGTERM/SIGINT/SIGHUP a child died of that this object did not send (a signal to the whole process
     * group — a supervisor, Ctrl-C — reaches the children too, possibly before the parent's own handler runs).
     */
    this.interrupted = null;
  }

  /**
   * Run one child to completion. Options: env, cwd, deadlineMs (kill + {timedOut:true}), log (file path; stdout and
   * stderr are appended), capture (keep stdout in memory). After cancelAll() nothing starts: the result is
   * {cancelled: true} at once.
   * -> {code, signal, timedOut, cancelled, interrupted, stdout, stderr, ms}
   */
  run(cmd, args, { env = process.env, cwd = process.cwd(), deadlineMs = null, log = null, capture = true } = {}) {
    return new Promise((resolve) => {
      if (this.cancelled) {
        resolve({ code: null, signal: null, timedOut: false, cancelled: true, interrupted: null, spawnError: null, stdout: '', stderr: '', ms: 0 });
        return;
      }
      const t0 = Date.now();
      let out = '';
      let err = '';
      let logFd = null;
      if (log) {
        try {
          fs.mkdirSync(path.dirname(log), { recursive: true });
          logFd = fs.openSync(log, 'a');
          fs.writeSync(logFd, `$ ${[cmd, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
        } catch {
          logFd = null;
        }
      }
      let child;
      try {
        child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        if (logFd !== null) fs.closeSync(logFd);
        resolve({ code: null, signal: null, timedOut: false, cancelled: false, interrupted: null, spawnError: e.message, stdout: '', stderr: String(e.message), ms: 0 });
        return;
      }
      this.set.add(child);
      let timedOut = false;
      let timer = null;
      let killTimer = null;
      if (deadlineMs !== null) {
        const ms = Math.max(0, deadlineMs);
        timer = setTimeout(() => {
          timedOut = true;
          this._kill(child);
        }, ms);
      }
      const onData = (which) => (d) => {
        const s = d.toString('utf8');
        if (capture) {
          if (which === 'out') out += s;
          else err += s;
          if (out.length > 32 * 1024 * 1024) out = out.slice(-16 * 1024 * 1024);
          if (err.length > 8 * 1024 * 1024) err = err.slice(-4 * 1024 * 1024);
        }
        if (logFd !== null) {
          try {
            fs.writeSync(logFd, s);
          } catch {
            /* log is best effort */
          }
        }
      };
      child.stdout.on('data', onData('out'));
      child.stderr.on('data', onData('err'));
      let spawnError = null;
      child.on('error', (e) => { spawnError = e.message; });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        this.set.delete(child);
        if (logFd !== null) {
          try {
            fs.writeSync(logFd, `\n[exit ${code === null ? `signal ${signal}` : code}${timedOut ? ', killed at the stage deadline' : ''}]\n`);
            fs.closeSync(logFd);
          } catch {
            /* ignore */
          }
        }
        const interrupted = !timedOut && !this.cancelled && TERM_SIGNALS.has(signal) ? signal : null;
        if (interrupted && !this.interrupted) this.interrupted = interrupted;
        resolve({ code, signal, timedOut, cancelled: this.cancelled, interrupted, spawnError, stdout: out, stderr: err, ms: Date.now() - t0 });
      });
    });
  }

  _kill(child) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* gone */
    }
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, KILL_GRACE_MS);
    t.unref();
  }

  /** SIGTERM every child, SIGKILL after 3 s; resolves when all are gone (or after 4 s). */
  async cancelAll() {
    this.cancelled = true;
    const kids = [...this.set];
    for (const c of kids) {
      try {
        c.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    const t0 = Date.now();
    while (this.set.size && Date.now() - t0 < KILL_GRACE_MS) await new Promise((r) => setTimeout(r, 50));
    for (const c of this.set) {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    const t1 = Date.now();
    while (this.set.size && Date.now() - t1 < 1000) await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Orphan watchdog: poll process.ppid every `intervalMs` and call onOrphan() once it changes (the parent died and
 * the process was reparented). The timer never keeps the process alive.
 */
export function watchParent(onOrphan, intervalMs = 2000) {
  const ppid0 = process.ppid;
  const t = setInterval(() => {
    if (process.ppid !== ppid0) {
      clearInterval(t);
      onOrphan();
    }
  }, intervalMs);
  t.unref();
  return () => clearInterval(t);
}
