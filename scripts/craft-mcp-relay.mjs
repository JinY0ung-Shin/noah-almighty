#!/usr/bin/env node
// stdio ↔ unix-socket relay for ONE Craft app (PhotoCraft, …) of ONE run.
//
// Usage: node craft-mcp-relay.mjs <handoff-file.json>
//
// The Agent SDK registers this script as the stdio MCP server named after the
// app (`mcp__photocraft__*`). The real app runs in the network-less
// craft-runner container; this relay only pipes bytes between the CLI's stdio
// and the runner's `sock/mcp.sock`.
//
// Handoff: `{socket, token, app}` in a mode-0600 file whose PATH is the only
// argv (the SDK serializes mcpServers into the CLI's argv, readable via
// /proc/<pid>/cmdline). Read once and deleted — the same one-shot contract as
// mcp-http-bridge.mjs. The token is the per-RUN token Noah granted for this
// conversation's session; it is the only credential here and dies with the run.
//
// Protocol (Addendum A2 — mutual, the token never crosses the socket):
//  1. the runner speaks first: `{"op":"challenge","v":1,"nonce":<32 hex>}`;
//  2. the relay sends `{"op":"attach","app","tokenId":sha256_hex(token),"nonce":<own 32 hex>,
//     "mac":HMAC_SHA256_hex(token, "noah-craft-mcp|client|" + runnerNonce + "|" + app)}`;
//  3. the runner answers `{"ok":true,"mac":HMAC_SHA256_hex(token, "noah-craft-mcp|server|" + relayNonce)}`
//     (or `{"ok":false,"error"}` and closes); the relay verifies that MAC in
//     constant time BEFORE it forwards a single CLI byte.
// A peer at the socket path that does not hold the run token therefore learns
// nothing replayable and never receives the CLI's JSON-RPC. After the
// handshake newline-delimited JSON-RPC flows both ways UNCHANGED. Input from
// the CLI that arrives before the handshake completes is buffered and flushed
// after it. The relay exits when either side closes.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const PREFIX = "[craft-mcp-relay]";
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

function log(message) {
  process.stderr.write(`${PREFIX} ${message}\n`);
}

function fail(message, code = 1) {
  log(message);
  process.exit(code);
}

function hmacHex(key, message) {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
}

function macMatches(given, expected) {
  if (typeof given !== "string" || !MAC_RE.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

const handoffFile = process.argv[2];
if (!handoffFile) fail("missing <handoff-file> argument");

let handoff;
try {
  handoff = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
} catch (error) {
  // A missing file usually means a mid-run RESPAWN after the one-shot read
  // consumed it; the run's token cannot be recovered, so fail loudly.
  fail(`cannot read handoff file (${error?.code ?? error}): ${handoffFile}`);
}
try {
  fs.unlinkSync(handoffFile);
} catch {
  // Already gone (raced with the run-end cleanup): the values are in memory.
}

const { socket: socketPath, token, app } = handoff ?? {};
if (typeof socketPath !== "string" || !socketPath) fail("handoff has no socket path");
if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) fail("handoff has no valid token");
if (typeof app !== "string" || !/^[a-z0-9]{1,32}$/.test(app)) fail("handoff has no valid app id");

const tokenId = crypto.createHash("sha256").update(token, "utf8").digest("hex");
const relayNonce = crypto.randomBytes(16).toString("hex");

/** "challenge" → (attach sent) "reply" → "attached". */
let stage = "challenge";
let handshakeBuffer = Buffer.alloc(0);
const pending = [];
let stdinEnded = false;

const handshakeTimer = setTimeout(() => fail("the craft-runner handshake timed out"), HANDSHAKE_TIMEOUT_MS);

const socket = net.createConnection(socketPath);

function handshakeLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail("unreadable handshake line from the craft-runner socket");
  }
  if (stage === "challenge") {
    if (!message || message.op !== "challenge" || message.v !== 1 || typeof message.nonce !== "string" || !NONCE_RE.test(message.nonce)) {
      fail("the peer on the craft-runner MCP socket sent no valid challenge");
    }
    stage = "reply";
    const mac = hmacHex(token, `noah-craft-mcp|client|${message.nonce}|${app}`);
    socket.write(`${JSON.stringify({ op: "attach", app, tokenId, nonce: relayNonce, mac })}\n`);
    return;
  }
  if (!message || message.ok !== true) {
    fail(`the craft-runner refused the attach for ${app}: ${String(message?.error ?? "unknown error").slice(0, 300)}`);
  }
  if (!macMatches(message.mac, hmacHex(token, `noah-craft-mcp|server|${relayNonce}`))) {
    // Whatever answered does not hold the run token: never hand it CLI bytes.
    fail("the peer on the craft-runner MCP socket failed to prove the run token; refusing to relay");
  }
  stage = "attached";
  clearTimeout(handshakeTimer);
}

socket.on("data", (chunk) => {
  if (stage === "attached") {
    process.stdout.write(chunk);
    return;
  }
  handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
  for (;;) {
    const newline = handshakeBuffer.indexOf(0x0a);
    if (newline === -1) {
      if (handshakeBuffer.length > MAX_HANDSHAKE_BYTES) fail("handshake line exceeded the size limit");
      return;
    }
    const line = handshakeBuffer.subarray(0, newline).toString("utf8").trim();
    handshakeBuffer = handshakeBuffer.subarray(newline + 1);
    if (!line) continue;
    handshakeLine(line);
    if (stage === "attached") break;
  }
  // Verified: what followed the server's reply is already JSON-RPC.
  const rest = handshakeBuffer;
  handshakeBuffer = Buffer.alloc(0);
  if (rest.length > 0) process.stdout.write(rest);
  for (const buffered of pending.splice(0)) socket.write(buffered);
  if (stdinEnded) socket.end();
});

socket.on("error", (error) => {
  fail(`craft-runner socket error (${error?.code ?? error?.message ?? error})`);
});

socket.on("close", () => {
  // The runner ended the session (revoke, purge, restart): nothing to relay.
  process.exit(stage === "attached" ? 0 : 1);
});

process.stdin.on("data", (chunk) => {
  if (stage === "attached") socket.write(chunk);
  else pending.push(chunk);
});

process.stdin.on("end", () => {
  stdinEnded = true;
  if (stage === "attached") socket.end();
});

// The CLI closing our stdout (it went away) ends the relay too.
process.stdout.on("error", () => process.exit(0));
