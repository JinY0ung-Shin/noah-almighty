// Mutual challenge-response handshakes for both sockets (spec Addendum A1/A2).
//
// Neither the control secret nor a run token ever crosses a socket: the runner speaks FIRST with a
// fresh nonce, the client proves the key with an HMAC over that nonce, and the runner answers with its
// own HMAC over the client's nonce — so a process squatting on a socket path (same uid as Noah) can
// neither learn the key nor impersonate the runner to Noah. Labels differ per direction and per socket,
// so no MAC can be replayed or reflected into another slot.
//
// Keys are the UTF-8 bytes of the secret / token STRING as configured (the 64-hex token is NOT
// hex-decoded). Every MAC is lowercase hex SHA-256 HMAC; every nonce 16 random bytes as 32 lowercase hex.

import crypto from "node:crypto";

export const HANDSHAKE_VERSION = 1;
export const NONCE_RE = /^[0-9a-f]{32}$/;
export const MAC_RE = /^[0-9a-f]{64}$/;
export const TOKEN_ID_RE = /^[0-9a-f]{64}$/;

export const isNonce = (v) => typeof v === "string" && NONCE_RE.test(v);

export const newNonce = () => crypto.randomBytes(16).toString("hex");

export const hmacHex = (key, message) => crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");

/** sha256 hex of a run token — the only form of the token the relay sends (`tokenId`). */
export const tokenIdOf = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** Constant-time comparison of a client-supplied MAC against the expected one (both lowercase hex). */
export function macMatches(given, expected) {
  if (typeof given !== "string" || !MAC_RE.test(given) || typeof expected !== "string" || !MAC_RE.test(expected)) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

// control.sock
export const controlClientMac = (secret, runnerNonce) => hmacHex(secret, `noah-craft-control|client|${runnerNonce}`);
export const controlServerMac = (secret, clientNonce) => hmacHex(secret, `noah-craft-control|server|${clientNonce}`);

// mcp.sock
export const mcpClientMac = (token, runnerNonce, app) => hmacHex(token, `noah-craft-mcp|client|${runnerNonce}|${app}`);
export const mcpServerMac = (token, relayNonce) => hmacHex(token, `noah-craft-mcp|server|${relayNonce}`);

/** The runner's first line on every accepted connection. */
export const challengeLine = (nonce) => ({ op: "challenge", v: HANDSHAKE_VERSION, nonce });
