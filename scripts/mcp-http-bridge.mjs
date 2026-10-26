#!/usr/bin/env node
// stdio ↔ HTTP relay for app-registered EXTERNAL HTTP MCP servers.
//
// Usage: node --use-system-ca mcp-http-bridge.mjs --config <file.json>
//
// WHY THIS EXISTS: the Agent SDK passes `options.mcpServers` to the CLI as a
// `--mcp-config <json>` command-line ARGUMENT, world-readable via
// /proc/<pid>/cmdline — and the agent's own Bash is a child of that CLI. An HTTP
// server's auth header registered natively would sit right there. So the app
// registers THIS script as a stdio server instead and hands it the URL + the
// already-resolved headers in a mode-0600 file: only the file PATH is in argv.
// The bridge reads the file, deletes it (one-shot handoff — same contract as
// mcp-secret-wrapper.mjs), keeps the values in memory only (never in its env),
// and relays JSON-RPC messages unchanged between the CLI (stdio) and the remote
// server (Streamable HTTP, or legacy SSE).
//
// Config: { url, transport: "http"|"sse", headers: {name: value}, redact: [..],
// expandEnv?: true }. With `expandEnv` (set only for a plugin `.mcp.json` entry),
// a `${VAR}` / `${VAR:-default}` still left in the URL or a header — a NON-vault
// env name — expands from this process's env, matching the CLI's own
// `--mcp-config` expansion. Admin-registered servers never expand env: every
// reference there was resolved from the vault before the file was written.
//
// Errors go to stderr (the CLI's MCP log) with every header value and secret
// scrubbed; a failed upstream request is answered with a JSON-RPC error so the
// CLI never waits on a request the remote never saw.
import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const PREFIX = "[mcp-http-bridge]";
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
  // A remote error page can be large; the CLI shows this to the model. Scrub
  // BEFORE truncating, so a cut can never leave half a secret behind.
  text = scrub(text);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

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
const transportOptions = { requestInit: { headers } };
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

const isRequest = (message) => message && "method" in message && "id" in message && message.id !== undefined;
const isNotification = (message) => message && "method" in message && !("id" in message);

// initialize request ids → the negotiated protocol version from its response
// must be set on the transport (the SDK's Client does this; a raw relay must).
const initializeIds = new Set();
// Notifications are fire-and-forget on the wire, but `notifications/initialized`
// must reach the server BEFORE the next request — so every message waits for the
// notifications sent before it. Requests themselves stay concurrent (a long tool
// call must not block the next one).
let notificationGate = Promise.resolve();

local.onmessage = (message) => {
  if (isRequest(message) && message.method === "initialize") {
    initializeIds.add(message.id);
  }
  const sent = notificationGate.then(() => upstream.send(message));
  if (isNotification(message)) {
    notificationGate = sent.catch(() => {});
  }
  sent.catch((error) => {
    const text = errorText(error);
    log(`upstream ${message?.method ?? "message"} failed: ${text}`);
    if (isRequest(message)) {
      local
        .send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: scrub(`Remote MCP server request failed: ${text}`) },
        })
        .catch(() => {});
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
  // CLI's initialize simply waits in the pipe until the upstream is ready.
  await upstream.start();
} catch (error) {
  fail(`cannot connect to the remote MCP server: ${errorText(error)}`);
}
await local.start();
