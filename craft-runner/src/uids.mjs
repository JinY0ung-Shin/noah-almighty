// Session uid pool, persisted in state/uids.json as { "v": 2, "next": <uid>, "sessions": { "<sid>": <uid> } }
// (the v1 file was the bare sessions map; it still loads). uids are handed out ROUND-ROBIN from the
// persisted `next` cursor — never "lowest free" — so a just-freed uid is the LAST one to be reused
// (Addendum A3).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isValidSid } from "./paths.mjs";

export class UidPool {
  /**
   * @param {{ file: string, min: number, max: number, log?: (msg: string) => void }} o
   */
  constructor({ file, min, max, log = () => {} }) {
    this.file = file;
    this.min = min;
    this.max = max;
    this.log = log;
    /** @type {Map<string, number>} */
    this.bySid = new Map();
    /** @type {Set<number>} */
    this.used = new Set();
    /** Next uid to try (round-robin cursor, persisted). */
    this.next = min;
  }

  /** Load the persisted map; invalid or duplicate entries are dropped (and logged). */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return this;
      throw err;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      this.log(`uid pool: ${this.file} is not valid JSON; starting empty`);
      return this;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return this;
    const v2 = data.v === 2 && data.sessions && typeof data.sessions === "object" && !Array.isArray(data.sessions);
    const sessions = v2 ? data.sessions : data;
    for (const [sid, uid] of Object.entries(sessions)) {
      if (!isValidSid(sid) || !Number.isInteger(uid) || uid < this.min || uid > this.max || this.used.has(uid)) {
        this.log(`uid pool: dropping invalid entry ${JSON.stringify(sid).slice(0, 40)}`);
        continue;
      }
      this.bySid.set(sid, uid);
      this.used.add(uid);
    }
    if (v2 && Number.isInteger(data.next) && data.next >= this.min && data.next <= this.max) {
      this.next = data.next;
    } else if (this.used.size > 0) {
      // v1 file (or a lost cursor): continue after the highest uid in use.
      const top = Math.max(...this.used);
      this.next = top >= this.max ? this.min : top + 1;
    }
    return this;
  }

  get(sid) {
    return this.bySid.get(sid);
  }

  get size() {
    return this.bySid.size;
  }

  sids() {
    return [...this.bySid.keys()];
  }

  /**
   * Return the sid's uid, allocating the next free one ROUND-ROBIN (and persisting) when absent.
   * `busy()` (called at most once, only when a new uid is needed) returns uids that still own a process
   * or a session directory although no sid holds them (state lost, N5) — those are skipped.
   * A failed persist ROLLS BACK the in-memory allocation (a restart would not know the sid).
   * @param {string} sid
   * @param {{ busy?: () => Set<number> }} [opts]
   */
  allocate(sid, { busy } = {}) {
    if (!isValidSid(sid)) throw new Error("invalid sid");
    const have = this.bySid.get(sid);
    if (have !== undefined) return have;
    const taken = busy ? busy() : new Set();
    const span = this.max - this.min + 1;
    for (let k = 0; k < span; k += 1) {
      const uid = this.min + ((this.next - this.min + k) % span);
      if (this.used.has(uid)) continue;
      if (taken.has(uid)) {
        this.log(`uid pool: skipping uid ${uid} (it still owns a process or a session directory)`);
        continue;
      }
      const prevNext = this.next;
      this.bySid.set(sid, uid);
      this.used.add(uid);
      this.next = uid >= this.max ? this.min : uid + 1;
      try {
        this.persist();
      } catch (err) {
        this.bySid.delete(sid);
        this.used.delete(uid);
        this.next = prevNext;
        throw err;
      }
      return uid;
    }
    throw new Error("session uid pool exhausted");
  }

  free(sid) {
    const uid = this.bySid.get(sid);
    if (uid === undefined) return;
    this.bySid.delete(sid);
    this.used.delete(uid);
    this.persist();
  }

  persist() {
    const tmp = path.join(path.dirname(this.file), `.uids-${crypto.randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      try {
        fs.writeSync(fd, JSON.stringify({ v: 2, next: this.next, sessions: Object.fromEntries(this.bySid) }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* never created / already renamed */
      }
      throw err;
    }
  }
}
