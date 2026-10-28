// Pure validators for identifiers and relative paths. No I/O.

import path from "node:path";

export const SID_RE = /^[0-9a-f]{32}$/;
export const TOKEN_RE = /^[0-9a-f]{64}$/;
/** Prefix of the runner's own temp files inside mirrored trees; never accepted as a source name. */
export const TMP_PREFIX = ".craft-tmp-";

export const isValidSid = (v) => typeof v === "string" && SID_RE.test(v);
export const isValidToken = (v) => typeof v === "string" && TOKEN_RE.test(v);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validate one path component (a directory entry name). Returns null when acceptable,
 * else an English reason.
 * @param {string} name
 */
export function nameProblem(name) {
  if (typeof name !== "string" || name.length === 0) return "empty name";
  if (name === "." || name === "..") return "dot segment";
  if (name.includes("/") || name.includes("\\")) return "separator in name";
  if (CONTROL_CHARS.test(name)) return "control character in name";
  if (Buffer.byteLength(name, "utf8") > 255) return "name longer than 255 bytes";
  if (name.startsWith(TMP_PREFIX)) return "reserved name";
  return null;
}

/**
 * Normalize a relative path: forward slashes only, `.`/empty components dropped, `..`/absolute/NUL
 * rejected, every component passes `nameProblem`.
 * @param {string} p
 * @param {{ maxDepth?: number }} [opts]
 * @returns {{ ok: true, path: string, parts: string[] } | { ok: false, reason: string }}
 */
export function normalizeRelPath(p, { maxDepth = 32 } = {}) {
  if (typeof p !== "string" || p.length === 0) return { ok: false, reason: "empty path" };
  if (p.includes("\0")) return { ok: false, reason: "NUL in path" };
  if (p.includes("\\")) return { ok: false, reason: "backslash in path" };
  if (p.startsWith("/")) return { ok: false, reason: "absolute path" };
  if (Buffer.byteLength(p, "utf8") > 4096) return { ok: false, reason: "path longer than 4096 bytes" };
  const parts = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return { ok: false, reason: "parent segment" };
    const problem = nameProblem(part);
    if (problem) return { ok: false, reason: problem };
    parts.push(part);
  }
  if (parts.length === 0) return { ok: false, reason: "empty path" };
  if (parts.length > maxDepth) return { ok: false, reason: `deeper than ${maxDepth} levels` };
  return { ok: true, path: parts.join("/"), parts };
}

/**
 * Exchange-volume layout for one session (spec §2). `exchangeDir` is the runner-side mount.
 * @param {string} exchangeDir
 * @param {string} sid
 * @param {string} tmpRoot
 */
export function sessionLayout(exchangeDir, sid, tmpRoot) {
  if (!isValidSid(sid)) throw new Error("invalid sid");
  const work = path.join(exchangeDir, "work", sid);
  const tmp = path.join(tmpRoot, sid);
  return {
    inbox: path.join(exchangeDir, "inbox", sid),
    work,
    inDir: path.join(work, "in"),
    outDir: path.join(work, "out"),
    outbox: path.join(exchangeDir, "outbox", sid),
    tmp,
    home: path.join(tmp, "home"),
    tmpDir: path.join(tmp, "tmp"),
  };
}
