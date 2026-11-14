// Shared helpers for the boot-test e2e scripts (driven from the host against Noah's published port in the dind).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The run directory is where THIS COPY of the scripts lives — <run-dir>/scripts/, made by ../prepare.sh, which
// also wrote <run-dir>/run.env (the Noah checkout the run was exported from, the throwaway test password).
export const W = dirname(dirname(fileURLToPath(import.meta.url)));
if (!existsSync(`${W}/run.env`)) throw new Error(`no ${W}/run.env — run the copy that prepare.sh put in a run directory, not the skill folder's`);
const RUN_ENV = Object.fromEntries(
  readFileSync(`${W}/run.env`, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
/** The Noah checkout prepare.sh ran from. */
export const REPO_ROOT = RUN_ENV.REPO_ROOT;
/** require() out of that checkout's node_modules — Playwright, for the checks that open a real browser. */
export const repoRequire = createRequire(`${REPO_ROOT}/package.json`);
export const NOAH = "http://10.217.0.2:48787";
export const FAKE = "http://10.217.0.10:18091";
/** Password of the accounts the run creates in its own stack: generated per run by prepare.sh. */
export const PASSWORD = RUN_ENV.E2E_PASSWORD;
const STATE_FILE = `${W}/evidence/state.json`;

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
}
export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(ok);
}
export function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

/** A client with its own cookie jar (one per user). */
export function client(cookie = "") {
  const self = {
    cookie,
    async request(path, init = {}) {
      const headers = { ...(init.body !== undefined && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(self.cookie ? { cookie: self.cookie } : {}), ...(init.headers ?? {}) };
      const res = await fetch(`${NOAH}${path}`, { redirect: "manual", ...init, headers });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) self.cookie = set.map((c) => c.split(";")[0]).join("; ");
      return res;
    },
    get: (path, headers) => self.request(path, { headers }),
    post: (path, body, headers) => self.request(path, { method: "POST", body: JSON.stringify(body ?? {}), headers }),
    put: (path, body, headers) => self.request(path, { method: "PUT", body: JSON.stringify(body ?? {}), headers }),
  };
  return self;
}

export function parseSse(raw) {
  const frames = [];
  for (const block of raw.split("\n\n")) {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      frames.push({ event, data: JSON.parse(data) });
    } catch {
      /* comment / keepalive */
    }
  }
  return frames;
}

/** POST /api/chat/stream; returns the status and either the JSON error body or the SSE frames. */
export async function turn(c, body) {
  const res = await c.post("/api/chat/stream", body);
  const raw = await res.text();
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not json */
    }
    return { status: res.status, json, raw, frames: [], of: () => [] };
  }
  const frames = parseSse(raw);
  return { status: res.status, frames, raw, of: (event) => frames.filter((f) => f.event === event).map((f) => f.data) };
}

export const fake = {
  reset: (key) => fetch(`${FAKE}/_fake/reset`, { method: "POST", body: JSON.stringify(key ? { key } : {}) }),
  enqueue: (key, turns) => fetch(`${FAKE}/_fake/enqueue`, { method: "POST", body: JSON.stringify({ key, turns }) }),
  requests: async (key) => (await (await fetch(`${FAKE}/_fake/requests?limit=200${key ? `&key=${encodeURIComponent(key)}` : ""}`)).json()).requests ?? [],
};

/** Text of one chat-completions message (string or parts). */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
  return "";
}

/** Run a command inside the dind (argv; no shell on the host side). */
export function dind(...argv) {
  return execFileSync("docker", ["exec", "noahcompose-dind", ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
export function dindTry(...argv) {
  try {
    return { ok: true, out: dind(...argv) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}
