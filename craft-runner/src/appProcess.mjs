// One app CLI child (`<app>-cli mcp …`) speaking newline-delimited JSON-RPC on stdio.
// The runner talks to it with its OWN request ids; relay.mjs maps them back to the client's.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { SELFTEST_UID } from "./config.mjs";
import { createLineSplitter, extractJsonRpcId, writeJson } from "./jsonl.mjs";

/**
 * N9: `ids` given → both must be integers in the app range (the self-test uid 19999 or a session uid
 * ≥ 20000). Node silently IGNORES an undefined uid/gid, which would run the app as root.
 * @param {{uid:unknown,gid:unknown}|null} ids
 */
export function assertAppIds(ids) {
  if (ids === null || ids === undefined) return;
  const ok = (v) => Number.isInteger(v) && v >= SELFTEST_UID;
  if (!ok(ids.uid) || !ok(ids.gid)) throw new Error("refusing to spawn an app without a valid non-root uid/gid");
}

export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export class CallTimeout extends Error {}
export class ProcessExited extends Error {}

/**
 * Build the child's environment from scratch (spec §2): nothing from the daemon's env leaks in.
 * @param {{home: string, tmpDir: string}} dirs
 * @param {Record<string,string>} extra
 */
export function buildChildEnv({ home, tmpDir }, extra = {}) {
  return {
    ...extra,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_CACHE_HOME: `${home}/.cache`,
    TMPDIR: tmpDir,
    FONTCONFIG_FILE: "/etc/fonts/fonts.conf",
  };
}

export class AppProcess extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.app            registry entry
   * @param {string} o.readRoot
   * @param {string} o.writeRoot
   * @param {string} o.cwd
   * @param {Record<string,string>} o.env
   * @param {{uid:number,gid:number}|null} o.ids   null = run as the daemon's own uid (tests)
   * @param {object} o.limits
   * @param {(m: string) => void} [o.log]
   */
  constructor(o) {
    super();
    this.o = o;
    this.log = o.log ?? (() => {});
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout|null, method: string}>} */
    this.pending = new Map();
    this.exited = false;
    this.stderrTail = "";
    this.lastUsed = Date.now();
    this.initializeResult = null;
  }

  get pid() {
    return this.child?.pid;
  }

  get alive() {
    return !!this.child && !this.exited;
  }

  /**
   * Spawn and run the MCP handshake (initialize + notifications/initialized).
   * @param {object} [initParams] the client's own initialize params (replayed verbatim)
   */
  async start(initParams) {
    const { app, readRoot, writeRoot, cwd, env, ids, limits } = this.o;
    assertAppIds(ids);
    const options = { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true };
    if (ids) Object.assign(options, { uid: ids.uid, gid: ids.gid });
    const child = spawn(app.bin, app.args({ readRoot, writeRoot }), options);
    this.child = child;
    const spawned = new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.on("error", (err) => this.onExit(`spawn error: ${err.code ?? err.message}`));
    child.on("exit", (code, signal) => this.onExit(signal ? `signal ${signal}` : `exit code ${code}`));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (b) => {
      this.stderrTail = (this.stderrTail + b.toString("utf8")).slice(-4096);
    });
    child.stdout.on(
      "data",
      createLineSplitter({
        maxBytes: limits.maxResponseLineBytes,
        onLine: (line) => this.onLine(line),
        onOverflow: (o) => this.onOverflow(o),
      }),
    );
    await spawned;
    if (ids) this.raiseOomScore();
    const res = await this.request(
      "initialize",
      initParams ?? {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "craft-runner", version: "1" },
      },
      limits.initTimeoutMs,
    );
    if (res.error || !res.result) throw new Error(`initialize failed: ${JSON.stringify(res.error ?? res).slice(0, 300)}`);
    this.initializeResult = res.result;
    this.notify("notifications/initialized");
    return res.result;
  }

  /** Prefer the app child over the daemon when the container's memory cgroup runs out. */
  raiseOomScore() {
    try {
      fs.writeFileSync(`/proc/${this.child.pid}/oom_score_adj`, "800");
    } catch {
      /* best effort */
    }
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`${this.o.app.id}: unparsable line from child dropped`);
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.method !== undefined && msg.id !== undefined) {
      // Server→client requests (sampling, roots, elicitation…) are never relayed.
      writeJson(this.child.stdin, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by craft-runner" } });
      return;
    }
    if (msg.method !== undefined) {
      this.emit("notification", msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.settle(msg.id).resolve(msg);
  }

  onOverflow({ head, bytes }) {
    let id = extractJsonRpcId(head, "first");
    if (!this.pending.has(id)) {
      const calls = [...this.pending.entries()].filter(([, p]) => p.method === "tools/call");
      id = calls.length === 1 ? calls[0][0] : undefined;
    }
    this.log(`${this.o.app.id}: dropped a ${bytes}-byte line over the response cap`);
    if (id !== undefined && this.pending.has(id)) this.settle(id).resolve({ overflow: true, bytes });
  }

  settle(id) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    return p;
  }

  onExit(why) {
    if (this.exited) return;
    this.exited = true;
    this.exitReason = why;
    for (const id of [...this.pending.keys()]) this.settle(id).reject(new ProcessExited(why));
    this.emit("exit", why);
  }

  /**
   * Send a request with a runner-side id.
   * @returns {Promise<any>} the raw response ({result}|{error}|{overflow:true})
   */
  request(method, params, timeoutMs) {
    return this.send(method, params, timeoutMs).response;
  }

  /**
   * Like `request`, but also returns the runner-side id (relay.mjs maps client cancellations onto it).
   * @returns {{ id: number, response: Promise<any> }}
   */
  send(method, params, timeoutMs) {
    if (!this.alive) return { id: -1, response: Promise.reject(new ProcessExited(this.exitReason ?? "not running")) };
    const id = this.nextId++;
    this.lastUsed = Date.now();
    const response = new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.pending.has(id)) return;
              this.settle(id).reject(new CallTimeout(`${method} timed out after ${timeoutMs} ms`));
              this.kill("call timeout");
            }, timeoutMs)
          : null;
      this.pending.set(id, { resolve, reject, timer, method });
      writeJson(this.child.stdin, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    }).finally(() => {
      this.lastUsed = Date.now();
    });
    return { id, response };
  }

  /** Send a notification (no id, no response). */
  notify(method, params) {
    if (!this.alive) return;
    writeJson(this.child.stdin, { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  get inFlight() {
    return this.pending.size;
  }

  /** SIGKILL the whole process group (the CLI may have spawned fc-list etc.). */
  kill(reason = "killed") {
    if (!this.child || this.exited) return;
    this.log(`${this.o.app.id}: killing pid ${this.child.pid} (${reason})`);
    try {
      process.kill(-this.child.pid, "SIGKILL");
    } catch {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }

  /** Resolves once the child has exited (immediately if it already has). */
  waitExit() {
    if (!this.child || this.exited) return Promise.resolve();
    return new Promise((resolve) => this.once("exit", resolve));
  }
}
