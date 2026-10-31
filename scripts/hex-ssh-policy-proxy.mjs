#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const allowedTools = parseAllowedTools(process.env.HEX_SSH_ALLOWED_TOOLS);
const upstreamCommand = process.env.HEX_SSH_UPSTREAM_COMMAND || "hex-ssh-mcp";

const upstream = spawn(upstreamCommand, {
  env: process.env,
  shell: true,
  stdio: ["pipe", "pipe", "pipe"],
});

upstream.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

upstream.on("error", (err) => {
  process.stderr.write(`[hex-ssh-policy-proxy] upstream failed: ${err.message}\n`);
});

upstream.on("exit", (code, signal) => {
  process.stderr.write(`[hex-ssh-policy-proxy] upstream exited code=${code ?? ""} signal=${signal ?? ""}\n`);
  process.exit(code ?? 1);
});

process.on("SIGINT", () => upstream.kill("SIGINT"));
process.on("SIGTERM", () => upstream.kill("SIGTERM"));
// The client hung up (an MCP client closes stdin first): stop the upstream, and
// with it this proxy, instead of waiting for the client's SIGTERM.
process.stdin.on("end", () => upstream.kill("SIGTERM"));

const pending = new Map();

readJsonLines(process.stdin, (message) => {
  if (!isRecord(message)) {
    return;
  }
  if (message.method === "tools/call") {
    const toolName = typeof message.params?.name === "string" ? message.params.name : "";
    if (!isAllowed(toolName)) {
      writeMessage(process.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message: `hex-ssh tool '${toolName}' is not allowed by policy`,
        },
      });
      return;
    }
  }
  if (message.method === "tools/list" && message.id !== undefined) {
    pending.set(message.id, "tools/list");
  }
  writeMessage(upstream.stdin, message);
});

readJsonLines(upstream.stdout, (message) => {
  if (!isRecord(message)) {
    return;
  }
  if (message.id !== undefined && pending.get(message.id) === "tools/list") {
    pending.delete(message.id);
    if (isRecord(message.result) && Array.isArray(message.result.tools)) {
      message.result = {
        ...message.result,
        tools: message.result.tools.filter((tool) => isAllowed(typeof tool?.name === "string" ? tool.name : "")),
      };
    }
  }
  writeMessage(process.stdout, message);
});

function parseAllowedTools(raw) {
  if (raw === undefined) {
    return null;
  }
  const tools = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  if (tools.includes("*")) {
    return null;
  }
  return new Set(tools);
}

function isAllowed(toolName) {
  return allowedTools === null || allowedTools.has(toolName);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeMessage(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function readJsonLines(stream, onMessage) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        onMessage(JSON.parse(line));
      } catch (err) {
        process.stderr.write(`[hex-ssh-policy-proxy] invalid JSON line: ${err.message}\n`);
      }
    }
  });
}
