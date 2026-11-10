#!/usr/bin/env node
// stdio ↔ HTTP relay for app-registered EXTERNAL HTTP MCP servers.
//
// Usage: node --use-system-ca mcp-http-bridge.mjs --config <file.json>
//
// WHY THIS EXISTS: Noah relays a remote HTTP MCP server (an admin 공용 server,
// a plugin `.mcp.json` http/sse entry) to a pi run as an MCP client, and the
// server's auth header must never sit in a child's argv (world-readable via
// /proc/<pid>/cmdline). So Noah spawns THIS script as a stdio server and hands
// it the URL + headers in a mode-0600 file: only the file PATH is in argv. The
// bridge reads the file, deletes it (one-shot handoff), keeps the values in
// memory only (never in its env), and relays JSON-RPC messages unchanged
// between Noah (stdio) and the remote server (Streamable HTTP, or legacy SSE).
//
// Config: { url, transport: "http"|"sse", headers: {name: value}, redact: [..],
// expandEnv?: true }. With `expandEnv` (set only for a plugin `.mcp.json` entry),
// a `${VAR}` / `${VAR:-default}` still left in the URL or a header — a NON-vault
// env name — expands from this process's env, matching the usual shell-style
// expansion. Admin-registered servers never expand env: every
// reference there was resolved from the vault before the file was written.
//
// Errors go to stderr (the relay's log) with every header value and secret
// scrubbed; a failed upstream request is answered with a JSON-RPC error so the
// client never waits on a request the remote never saw.
//
// Origin binding: every request goes to the ORIGIN of the configured URL and
// nowhere else. The headers sent here are the user's bound secrets, often in a
// custom header (`X-Api-Key`), and `fetch` drops only Authorization/Cookie when
// a redirect crosses origins — so redirects are followed BY HAND, inside that
// origin only (at most 5), and one that leaves it is refused with Noah's own
// error. Without this the "secret is bound to the server's origin" rule would
// hold at registration only.
//
// Size cap (`maxMessageBytes`, default 8 MiB — Noah's MCP_RELAY_MESSAGE_MAX_BYTES,
// `src/server/agent/pi/boundedStdioTransport.ts`; a test keeps the two equal):
// the SDK transports buffer a whole HTTP body / SSE event before parsing it, so
// one huge message from the remote would exhaust memory here and then in Noah.
// Every upstream response body (a JSON reply in total, an SSE stream per event)
// is counted while it streams and cut past the cap, and every message written to
// stdout is checked again after serialization. An oversized REPLY is answered
// with Noah's own JSON-RPC error for the request it belonged to (never the
// remote's text); one that cannot be tied to a request (the standalone/legacy
// event stream) answers every pending request that way and ends the bridge.
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const PREFIX = "[mcp-http-bridge]";
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
let redactions = [];

function scrub(text) {
  let out = String(text);
  for (const value of redactions) {
    out = out.split(value).join("[REDACTED]");
  }
  return out;
}

function log(message) {
  process.stderr.write(`${PREFIX} ${scrub(message)}\n`);
}

function fail(message) {
  log(message);
  process.exit(1);
}

function errorText(error) {
  let text = String(error);
  if (error instanceof Error) {
    // StreamableHTTPError / SseError carry the HTTP status as `code`.
    const status = typeof error.code === "number" && error.code > 0 ? `HTTP ${error.code}: ` : "";
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    text = `${status}${error.message}${cause}`;
  }
  // A remote error page can be large; the relay shows this to the model. Scrub
  // BEFORE truncating, so a cut can never leave half a secret behind.
  text = scrub(text);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

const isMessage = (message) => Boolean(message) && typeof message === "object" && !Array.isArray(message);
const isRequest = (message) => isMessage(message) && "method" in message && "id" in message && message.id !== undefined;
const isNotification = (message) => isMessage(message) && "method" in message && !("id" in message);
const isResponse = (message) =>
  isMessage(message) && !("method" in message) && "id" in message && ("result" in message || "error" in message);

const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--config");
const configFile = configIndex === -1 ? null : argv[configIndex + 1];
if (!configFile) fail("missing --config <file>");

let config;
try {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
} catch (error) {
  // A missing file usually means a mid-run server RESPAWN after the one-shot
  // read consumed it. Fail loudly rather than connecting without credentials.
  fail(`cannot read config file (${error?.code ?? error}): ${configFile}`);
}
try {
  fs.unlinkSync(configFile);
} catch {
  /* already gone — the run-level stale sweep is the backstop */
}

// ONE pass over each template: a reference is filled from the owner's vault
// subset when it names one, else from env (only with expandEnv). A filled-in
// value is never scanned again, so a secret containing `${…}` stays literal.
const vault = config && typeof config.vault === "object" && config.vault ? config.vault : {};
function expandEnv(value) {
  if (config.expandEnv !== true && Object.keys(vault).length === 0) return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name, fallback) => {
    if (Object.hasOwn(vault, name) && typeof vault[name] === "string") return vault[name];
    if (config.expandEnv !== true) return whole;
    const envValue = process.env[name];
    return envValue !== undefined && envValue !== "" ? envValue : (fallback ?? "");
  });
}

if (!config || typeof config !== "object" || typeof config.url !== "string") {
  fail("config has no url");
}
const headers = {};
for (const [name, value] of Object.entries(config.headers ?? {})) {
  if (typeof value === "string") headers[name] = expandEnv(value);
}
const url = expandEnv(config.url);
redactions = [
  ...(Array.isArray(config.redact) ? config.redact : []),
  ...Object.values(headers),
]
  .filter((value) => typeof value === "string" && value.length >= 4)
  // Longest first, so a value containing another is scrubbed whole.
  .sort((a, b) => b.length - a.length);

let upstreamUrl;
try {
  upstreamUrl = new URL(url);
} catch {
  fail("config url is not a valid URL");
}
const maxMessageBytes =
  Number.isSafeInteger(config.maxMessageBytes) && config.maxMessageBytes > 0 ? config.maxMessageBytes : DEFAULT_MAX_MESSAGE_BYTES;
const maxMessageMiB = Math.round((maxMessageBytes / (1024 * 1024)) * 100) / 100;
// Agent-facing (the relay hands it to the model as the tool's error). Noah's own
// words only: nothing of the oversized message is ever echoed.
const OVERSIZE_TEXT =
  `The remote MCP server sent a single message larger than ${maxMessageMiB} MiB, which Noah does not relay. ` +
  "Ask for less at once (a narrower query, a smaller page, range or limit); do not repeat the same call unchanged.";

/** Thrown into a response body cut at the cap (the SDK sees a failed read). */
class OversizeError extends Error {}

/** Request ids carried by a POST body (one message or a batch), as sent by the SDK. */
function requestIdsOf(body) {
  if (typeof body !== "string") return [];
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(isRequest).map((message) => message.id);
  } catch {
    return [];
  }
}

/**
 * A body guard: counts bytes as they stream and errors the stream past the cap —
 * in TOTAL for a JSON body (one message), PER EVENT for an SSE stream (a long
 * stream legitimately carries many messages; an event ends at a blank line).
 */
function sizeGuard(perEvent, onOversize) {
  let total = 0;
  let lineBytes = 0;
  let lastWasCR = false;
  let tripped = false;
  const trip = (controller) => {
    tripped = true;
    onOversize();
    controller.error(new OversizeError(OVERSIZE_TEXT));
  };
  return new TransformStream({
    transform(chunk, controller) {
      if (tripped) return;
      if (!perEvent) {
        total += chunk.byteLength;
        if (total > maxMessageBytes) return trip(controller);
        controller.enqueue(chunk);
        return;
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (byte === 0x0a || byte === 0x0d) {
          const crlf = byte === 0x0a && lastWasCR;
          lastWasCR = byte === 0x0d;
          if (crlf) continue;
          if (lineBytes === 0) total = 0; // a blank line ends the event
          lineBytes = 0;
          continue;
        }
        lastWasCR = false;
        lineBytes += 1;
        total += 1;
        if (total > maxMessageBytes) return trip(controller);
      }
      controller.enqueue(chunk);
    },
  });
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Agent-facing (relayed as the request's JSON-RPC error): where the request would have gone, never a header. */
function offOriginText(origin, redirected) {
  return (
    `${redirected ? "the server redirected to" : "the request targets"} another origin (${origin}), which Noah does not follow: ` +
    `this server's credentials are sent only to ${upstreamUrl.origin}. ` +
    "Do not retry; tell the user an admin has to register the server's final address."
  );
}

/**
 * `fetch` that stays inside the configured origin: redirects are followed by
 * hand (the bound headers ride every hop, so a hop to another origin would hand
 * them over) and a request or redirect that leaves the origin throws.
 */
async function sameOriginFetch(input, init) {
  let target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  let options = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop += 1) {
    if (target.origin !== upstreamUrl.origin) throw new Error(offOriginText(target.origin, hop > 0));
    const response = await fetch(target, options);
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (!location) return { response, redirected: hop > 0 };
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw new Error(`the server redirected more than ${MAX_REDIRECTS} times`);
    try {
      target = new URL(location, target);
    } catch {
      throw new Error("the server sent a redirect without a usable address");
    }
    // fetch's own rule: 303 (and a 301/302 answer to a POST) continues as a body-less GET.
    const method = String(options.method ?? "GET").toUpperCase();
    const toGet =
      response.status === 303 ? method !== "GET" && method !== "HEAD" : response.status !== 307 && response.status !== 308 && method === "POST";
    if (toGet) {
      const nextHeaders = new Headers(options.headers);
      for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
        nextHeaders.delete(name);
      }
      const { body: _body, ...rest } = options;
      options = { ...rest, method: "GET", headers: nextHeaders };
    }
  }
}

/** `fetch` for both SDK transports: same-origin only, and every response body streams through {@link sizeGuard}. */
async function cappedFetch(input, init) {
  const ids = requestIdsOf(init?.body);
  const { response, redirected } = await sameOriginFetch(input, init);
  if (!response.body) return response;
  const perEvent = (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
  const guarded = new Response(
    response.body.pipeThrough(sizeGuard(perEvent, () => onOversize(ids))),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
  // The SSE client follows a redirect's final URL on reconnect (same origin, see sameOriginFetch).
  Object.defineProperty(guarded, "url", { value: response.url });
  Object.defineProperty(guarded, "redirected", { value: redirected });
  return guarded;
}

const transportOptions = { requestInit: { headers }, fetch: cappedFetch };
const upstream =
  config.transport === "sse"
    ? new SSEClientTransport(upstreamUrl, transportOptions)
    : new StreamableHTTPClientTransport(upstreamUrl, transportOptions);
const local = new StdioServerTransport();

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => process.exit(code), 2000);
  timer.unref();
  try {
    // Streamable HTTP: release the server-side session (405 is fine).
    if (typeof upstream.terminateSession === "function" && upstream.sessionId) {
      await upstream.terminateSession();
    }
  } catch {
    /* best effort */
  }
  try {
    await upstream.close();
  } catch {
    /* best effort */
  }
  process.exit(code);
}


// Requests relayed upstream and not yet answered (key: the JSON of the id), so
// a request is answered exactly once — by the remote, or by the bridge's own
// error when it never got (or could not relay) the remote's reply.
const pending = new Map();
const idKey = (id) => JSON.stringify(id);

function answerError(id, message) {
  if (!pending.delete(idKey(id))) return;
  local.send({ jsonrpc: "2.0", id, error: { code: -32000, message } }).catch(() => {});
}

function onOversize(ids) {
  if (ids.length > 0) {
    log(`dropped an upstream reply larger than ${maxMessageBytes} bytes`);
    for (const id of ids) answerError(id, OVERSIZE_TEXT);
    return;
  }
  // The standalone (or legacy SSE) event stream: no request to tie it to.
  log(`dropped an upstream stream message larger than ${maxMessageBytes} bytes; closing`);
  for (const id of [...pending.values()]) answerError(id, OVERSIZE_TEXT);
  void shutdown(1);
}

// initialize request ids → the negotiated protocol version from its response
// must be set on the transport (the SDK's Client does this; a raw relay must).
const initializeIds = new Set();
// Notifications are fire-and-forget on the wire, but `notifications/initialized`
// must reach the server BEFORE the next request — so every message waits for the
// notifications sent before it. Requests themselves stay concurrent (a long tool
// call must not block the next one).
let notificationGate = Promise.resolve();

local.onmessage = (message) => {
  if (isRequest(message)) {
    pending.set(idKey(message.id), message.id);
    if (message.method === "initialize") initializeIds.add(message.id);
  }
  const sent = notificationGate.then(() => upstream.send(message));
  if (isNotification(message)) {
    notificationGate = sent.catch(() => {});
  }
  sent.catch((error) => {
    const text = errorText(error);
    log(`upstream ${message?.method ?? "message"} failed: ${text}`);
    if (isRequest(message)) {
      answerError(
        message.id,
        error instanceof OversizeError ? OVERSIZE_TEXT : scrub(`Remote MCP server request failed: ${text}`),
      );
    }
  });
};

upstream.onmessage = (message) => {
  if (message && "id" in message && initializeIds.has(message.id)) {
    initializeIds.delete(message.id);
    const version = message.result?.protocolVersion;
    if (typeof version === "string" && typeof upstream.setProtocolVersion === "function") {
      upstream.setProtocolVersion(version);
    }
  }
  // The cap again on what actually goes out: re-serializing can grow a message
  // (`1e20` → 21 digits), and Noah cuts any stdout line past the same cap.
  if (Buffer.byteLength(JSON.stringify(message)) > maxMessageBytes) {
    if (isResponse(message)) answerError(message.id, OVERSIZE_TEXT);
    else log(`dropped an upstream ${message?.method ?? "message"} larger than ${maxMessageBytes} bytes`);
    return;
  }
  // Already answered (by the bridge's own error): never a second reply.
  if (isResponse(message) && !pending.delete(idKey(message.id))) return;
  local.send(message).catch((error) => log(`stdout write failed: ${errorText(error)}`));
};
upstream.onerror = (error) => log(`upstream error: ${errorText(error)}`);
upstream.onclose = () => void shutdown(0);
local.onerror = (error) => log(`stdio error: ${errorText(error)}`);
local.onclose = () => void shutdown(0);
process.stdin.on("end", () => void shutdown(0));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => void shutdown(0));
}
process.on("unhandledRejection", (error) => log(`unhandled: ${errorText(error)}`));

try {
  // SSE opens its event stream and waits for the endpoint here; Streamable
  // HTTP only arms its abort controller. stdin is read only after this, so the
  // client's initialize simply waits in the pipe until the upstream is ready.
  await upstream.start();
} catch (error) {
  fail(`cannot connect to the remote MCP server: ${errorText(error)}`);
}
await local.start();
