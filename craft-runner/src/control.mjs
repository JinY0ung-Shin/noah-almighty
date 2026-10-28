// control.sock connection handler (spec §3 + Addendum A1): mutual challenge-response, then JSON-line ops.
//
//   runner → {"op":"challenge","v":1,"nonce":N1}
//   Noah   → {"op":"hello","nonce":N2,"mac":HMAC(secret,"noah-craft-control|client|"+N1)}
//   runner → {"ok":true,"mac":HMAC(secret,"noah-craft-control|server|"+N2)}   (or {"ok":false,"error":"unauthorized"} + close)
//
// The secret itself never crosses the socket; a plaintext `secret` field is refused outright.

import { challengeLine, controlClientMac, controlServerMac, isNonce, macMatches, newNonce } from "./auth.mjs";
import { createLineSplitter, writeJson } from "./jsonl.mjs";
import { RequestError } from "./sessions.mjs";

/**
 * Verify a control `hello` against the runner nonce. Returns the server MAC to send back, or null.
 * Pure (exported for tests).
 */
export function verifyControlHello(req, secret, runnerNonce) {
  if (typeof secret !== "string" || secret.length === 0) return null;
  if (!req || typeof req !== "object" || Array.isArray(req) || req.op !== "hello") return null;
  if (Object.prototype.hasOwnProperty.call(req, "secret")) return null; // plaintext secrets are never accepted
  if (!isNonce(req.nonce) || req.nonce === runnerNonce) return null;
  if (!macMatches(req.mac, controlClientMac(secret, runnerNonce))) return null;
  return controlServerMac(secret, req.nonce);
}

/** Dispatch one authenticated op. Returns the response payload (without id/ok). */
export async function dispatchControl(sessions, req) {
  switch (req.op) {
    case "health":
      return sessions.health();
    case "open":
      return sessions.open(req.sid);
    case "sync_in":
      return sessions.syncIn(req.sid);
    case "sync_out":
      return sessions.syncOut(req.sid);
    case "grant":
      return sessions.grant(req.sid, req.token);
    case "revoke":
      return sessions.revoke(req.token);
    case "revoke_all":
      return sessions.revokeAll();
    case "purge":
      return sessions.purge(req.sid);
    default:
      throw new RequestError(`unknown op ${JSON.stringify(String(req.op)).slice(0, 40)}`);
  }
}

/**
 * @param {import("node:net").Socket} socket
 * @param {{ secret: string, sessions: object, limits: object, log: (m: string) => void }} ctx
 */
export function handleControlConnection(socket, ctx) {
  let authed = false;
  let dead = false;
  const nonce = newNonce();
  const reject = (error) => {
    writeJson(socket, { ok: false, error });
    socket.end();
    dead = true;
  };
  const timer = setTimeout(() => {
    if (!authed && !dead) reject("unauthorized");
  }, ctx.limits.helloTimeoutMs);

  const onLine = (line) => {
    if (dead) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      req = null;
    }
    if (!authed) {
      clearTimeout(timer);
      const serverMac = verifyControlHello(req, ctx.secret, nonce);
      if (serverMac) {
        authed = true;
        writeJson(socket, { ok: true, mac: serverMac });
      } else {
        const plaintext = req && typeof req === "object" && Object.prototype.hasOwnProperty.call(req, "secret");
        ctx.log(`control: rejected a connection (${plaintext ? "plaintext secret refused" : "bad or missing hello"})`);
        reject("unauthorized");
      }
      return;
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) {
      writeJson(socket, { ok: false, error: "request must be a JSON object" });
      return;
    }
    const id = req.id;
    dispatchControl(ctx.sessions, req).then(
      (payload) => writeJson(socket, { id, ok: true, ...payload }),
      (err) => {
        if (!(err instanceof RequestError)) ctx.log(`control: ${req.op} failed: ${err.stack ?? err}`);
        const extra = err instanceof RequestError && err.extra ? err.extra : {};
        writeJson(socket, { ...extra, id, ok: false, error: err.message || "internal error" });
      },
    );
  };

  socket.on(
    "data",
    createLineSplitter({
      maxBytes: ctx.limits.maxControlLineBytes,
      onLine,
      onOverflow: () => reject("request too large"),
    }),
  );
  socket.on("error", () => {});
  socket.on("close", () => clearTimeout(timer));
  writeJson(socket, challengeLine(nonce));
}
