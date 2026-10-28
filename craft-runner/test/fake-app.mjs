#!/usr/bin/env node
// Fake Craft app CLI for tests: `fake-app.mjs mcp --automation-read-root R --automation-write-root W`.
// Speaks newline-delimited JSON-RPC like photocraft-cli mcp, with test hooks driven by tool calls and
// by env (FAKE_ESCAPE=1 → no confinement; FAKE_EXTRA_TOOL=name → tool-list drift; FAKE_VERSION;
// FAKE_STDERR).

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv[argv.indexOf(n) + 1];
if (argv[0] !== "mcp") {
  process.stderr.write("fake-app: only `mcp` is supported\n");
  process.exit(2);
}
// FAKE_STDERR=text → written to stderr at startup (self-test error sanitizing).
if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR);
const readRoot = path.resolve(flag("--automation-read-root"));
const writeRoot = path.resolve(flag("--automation-write-root"));
let initializeCount = 0;
let initialized = false;

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const inside = (root, p) => {
  const abs = path.resolve(root, p);
  return process.env.FAKE_ESCAPE === "1" || abs === root || abs.startsWith(`${root}/`) ? abs : null;
};

const TOOLS = [
  "command_run",
  "command_batch",
  "doc_open",
  "doc_export",
  "render_preview",
  "whoami",
  "sleep",
  "big",
  "crash",
  "write_file",
  "progress",
  "ui_inspect",
  "control_call",
  ...(process.env.FAKE_EXTRA_TOOL ? [process.env.FAKE_EXTRA_TOOL] : []),
].map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object" } }));

async function call(name, a = {}, meta) {
  switch (name) {
    case "whoami":
      return text(JSON.stringify({ pid: process.pid, initializeCount, initialized, uid: process.getuid(), env: process.env, cwd: process.cwd() }));
    case "doc_open": {
      const abs = inside(readRoot, a.path ?? "");
      if (!abs) return text(`automation path rejected: absolute paths must be inside the automation root: \`${a.path}\``, true);
      try {
        return text(JSON.stringify({ opened: abs, size: fs.readFileSync(abs).length }));
      } catch (err) {
        return text(`I/O: ${err.code}`, true);
      }
    }
    case "write_file":
    case "doc_export": {
      const abs = inside(writeRoot, a.path ?? a.name ?? "");
      if (!abs) return text("automation path rejected", true);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, a.content ?? "exported");
      return text(JSON.stringify({ wrote: abs }));
    }
    case "render_preview":
      return {
        content: [
          { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
          { type: "text", text: JSON.stringify({ max_side: a.max_side ?? null }) },
        ],
        isError: false,
      };
    case "command_run":
      return text(JSON.stringify({ ran: a.id, params: a.params ?? null }));
    case "command_batch":
      return text(JSON.stringify({ completed: (a.steps ?? []).length }));
    case "sleep":
      await new Promise((r) => setTimeout(r, a.ms ?? 1000));
      return text("slept");
    case "big":
      return text("x".repeat(a.bytes ?? 1024));
    case "crash":
      process.exit(3);
      return text("unreachable");
    case "progress":
      send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: meta?.progressToken, progress: 1, total: 2 } });
      // A server→client request the runner must answer itself and never relay.
      send({ jsonrpc: "2.0", id: "srv-1", method: "roots/list", params: {} });
      return text("progressed");
    default:
      return text(`unknown tool ${name}`, true);
  }
}

let buf = "";
process.stdin.on("data", async (b) => {
  buf += b;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === undefined) continue; // response to our server→client request
    if (m.method === "initialize") {
      initializeCount += 1;
      send({
        jsonrpc: "2.0",
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "fakecraft", version: process.env.FAKE_VERSION ?? "9.9.9" },
          instructions: "Fake craft app.",
        },
      });
    } else if (m.method === "notifications/initialized") {
      initialized = true;
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
    } else if (m.method === "tools/call") {
      const res = await call(m.params?.name, m.params?.arguments, m.params?._meta);
      send({ jsonrpc: "2.0", id: m.id, result: res });
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
    }
  }
});
