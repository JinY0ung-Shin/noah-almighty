#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const allowedTools = parseAllowedTools(process.env.HEX_SSH_ALLOWED_TOOLS);
// Refused whatever the allowlist says (even "*"): hex-ssh runs in Noah's
// container, so its local-path tools would read/write Noah's own filesystem
// (src/server/hexSshPolicy.ts HEX_SSH_NEVER_OFFERED_TOOLS — keep in sync).
const NEVER_ALLOWED = new Set(["ssh-upload", "ssh-download"]);
// Arguments that name a file on the machine hex-ssh runs on — Noah's container,
// never the agent's sandbox. hex-ssh 1.9.2 reads `privateKeyPath` (every tool)
// with readFileSync: an existence oracle over Noah's disk, SSH auth with any key
// file on it, and `/dev/zero`/`/dev/stdin` would hang or exhaust the child.
// `localPath` is the transfer tools' (never offered — kept as defense in depth).
// known_hosts and ssh_config paths are env-only (KNOWN_HOSTS_PATH, SSH_CONFIG_PATH).
// Refused on every tools/call and stripped from every tools/list schema: Noah
// supplies the key itself, in SSH_PRIVATE_KEY (see the HEX_SSH_NEVER_OFFERED_TOOLS
// comment in src/server/hexSshPolicy.ts).
const LOCAL_PATH_ARGUMENTS = ["privateKeyPath", "localPath"];
const upstreamCommand = process.env.HEX_SSH_UPSTREAM_COMMAND || "hex-ssh-mcp";

const upstream = spawn(upstreamCommand, {
  env: upstreamEnv(process.env),
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
    const pathArgs = isRecord(message.params?.arguments)
      ? LOCAL_PATH_ARGUMENTS.filter((name) => Object.hasOwn(message.params.arguments, name))
      : [];
    if (pathArgs.length > 0 && isAllowed(toolName)) {
      const named = pathArgs.map((name) => `'${name}'`).join(", ");
      writeMessage(process.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [
            {
              type: "text",
              text:
                `hex-ssh does not accept ${named}: hex-ssh runs on Noah's server, not in your sandbox, so a local path would name a file on Noah's disk. ` +
                `Noah supplies the SSH key itself (the owner's SSH_PRIVATE_KEY secret). Call '${toolName}' again without ${named}.`,
            },
          ],
          isError: true,
        },
      });
      return;
    }
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
        tools: message.result.tools
          .filter((tool) => isAllowed(typeof tool?.name === "string" ? tool.name : ""))
          .map(withoutLocalPathArguments),
      };
    }
  }
  writeMessage(process.stdout, message);
});

/** A tool definition whose input schema no longer offers a local-path argument. */
function withoutLocalPathArguments(tool) {
  const schema = tool?.inputSchema;
  if (!isRecord(schema)) return tool;
  const next = { ...schema };
  if (isRecord(schema.properties)) {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(([name]) => !LOCAL_PATH_ARGUMENTS.includes(name)),
    );
  }
  if (Array.isArray(schema.required)) {
    next.required = schema.required.filter((name) => !LOCAL_PATH_ARGUMENTS.includes(name));
  }
  return { ...tool, inputSchema: next };
}

/**
 * The upstream's env. hex-ssh reads SSH_PRIVATE_KEY as key TEXT only when it
 * starts with "-----"; anything else it treats as a PATH on Noah's disk — the
 * same hole as `privateKeyPath`, reached through a vault value. So the key goes
 * through as PEM/OpenSSH text (leading whitespace trimmed) or not at all.
 */
function upstreamEnv(source) {
  const env = { ...source };
  const key = env.SSH_PRIVATE_KEY;
  if (typeof key === "string") {
    const text = key.trimStart();
    if (text.startsWith("-----")) {
      env.SSH_PRIVATE_KEY = text;
    } else {
      delete env.SSH_PRIVATE_KEY;
      process.stderr.write("[hex-ssh-policy-proxy] SSH_PRIVATE_KEY is not key text (it would be read as a file path); not passed on\n");
    }
  }
  return env;
}

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
  if (NEVER_ALLOWED.has(toolName)) return false;
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
