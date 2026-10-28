/**
 * A FAKE craft-runner for the Craft-apps suites: the control socket
 * (`sock/control.sock`) and the MCP socket (`sock/mcp.sock`) of the exchange
 * layout, speaking the spec's JSON-lines protocol — including Addendum A's
 * mutual HMAC handshakes, written out here INDEPENDENTLY of Noah's code so the
 * formulas are pinned — over real unix sockets in a temp dir. No Docker, no app
 * binaries. Every control request and every raw line is recorded.
 *
 * Session model (Addendum B): `open` registers the sid, `purge` forgets it, and
 * `grant` refuses a sid that is not open (`no such session — open it first`);
 * `revoke` of a live token runs a final out→outbox sync like the real runner.
 * With `exchange` over its `maxBytes`, `open` of a NEW session and every
 * `sync_in` refuse with an English error plus a `budget` object (N2), and
 * `health.exchange` reports the numbers.
 *
 * `controlImpostor` / `mcpImpostor` turn a socket into a peer that does NOT
 * hold the secret/token: it sends a valid challenge, accepts whatever comes,
 * and answers `ok:true` with no MAC or a wrong one — Noah and the relay must
 * refuse to go on.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface FakeRunnerOptions {
  secret: string;
  /** `health.apps` (default: PhotoCraft ready). */
  apps?: { id: string; version: string; status: "ready" | "failed"; error?: string; tools: number }[];
  /** Ops answered `ok:false`. */
  failOps?: Set<string>;
  /** MCP: answer a tools/call with this (default: an image + text result). */
  toolResult?: (name: string, args: unknown) => unknown;
  /** `sync_in`'s `rejected` list (default: none). */
  syncInRejected?: (sid: string) => { path: string; reason: string }[];
  /** Delay the reply to these ops by N ms. */
  delayOps?: Record<string, number>;
  /** The exchange volume's usage vs budget (`health.exchange`; over → open-new/sync_in refuse). Mutable. */
  exchange?: { bytes: number; maxBytes: number };
  /** The control socket is held by a peer that cannot prove the secret. */
  controlImpostor?: "no_mac" | "wrong_mac";
  /** The MCP socket is held by a peer that cannot prove the run token. */
  mcpImpostor?: "no_mac" | "wrong_mac";
}

const hmac = (key: string, message: string) => crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
const sha256 = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const nonce = () => crypto.randomBytes(16).toString("hex");
const sameHex = (a: unknown, b: string) =>
  typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface FakeRunner {
  root: string;
  ops: { op: string; payload: Record<string, unknown> }[];
  tokens: Map<string, string>;
  /** Raw MCP lines received after attach, per connection. */
  mcpLines: string[];
  /** Every raw line received on either socket (handshakes included). */
  rawLines: { socket: "control" | "mcp"; line: string }[];
  attaches: { token: string; app: string; ok: boolean }[];
  /** Sids opened and not purged since. */
  sessions: Set<string>;
  options: FakeRunnerOptions;
  close(): Promise<void>;
}

/** A 1×1 PNG. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function copyTree(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function lines(socket: net.Socket, onLine: (line: string) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf("\n");
    }
  });
  socket.on("error", () => {});
}

export async function startFakeRunner(root: string, options: FakeRunnerOptions): Promise<FakeRunner> {
  for (const dir of ["sock", "inbox", "outbox", "work", "state"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  const runner: FakeRunner = {
    root,
    ops: [],
    tokens: new Map(),
    mcpLines: [],
    rawLines: [],
    attaches: [],
    sessions: new Set(),
    options,
    close: async () => {},
  };
  const open = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
  };
  const control = net.createServer((socket) => {
    track(socket);
    let authed = false;
    const challenge = nonce();
    socket.write(`${JSON.stringify({ op: "challenge", v: 1, nonce: challenge })}\n`);
    lines(socket, (line) => {
      runner.rawLines.push({ socket: "control", line });
      const message = JSON.parse(line) as Record<string, unknown>;
      if (!authed) {
        if (options.controlImpostor) {
          authed = true;
          const mac = options.controlImpostor === "wrong_mac" ? hmac("not-the-secret", `noah-craft-control|server|${String(message.nonce)}`) : undefined;
          socket.write(`${JSON.stringify({ ok: true, ...(mac ? { mac } : {}) })}\n`);
          return;
        }
        const expected = hmac(options.secret, `noah-craft-control|client|${challenge}`);
        if (message.op === "hello" && typeof message.nonce === "string" && /^[0-9a-f]{32}$/.test(message.nonce) && sameHex(message.mac, expected)) {
          authed = true;
          socket.write(`${JSON.stringify({ ok: true, mac: hmac(options.secret, `noah-craft-control|server|${message.nonce}`) })}\n`);
        } else {
          socket.end(`${JSON.stringify({ ok: false, error: "unauthorized" })}\n`);
        }
        return;
      }
      const { id, op, ...payload } = message as { id: string; op: string } & Record<string, unknown>;
      runner.ops.push({ op, payload });
      const delay = options.delayOps?.[op] ?? 0;
      const reply = (body: Record<string, unknown>) => {
        const send = () => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id, ...body })}\n`);
        };
        if (delay > 0) setTimeout(send, delay);
        else send();
      };
      if (options.failOps?.has(op)) {
        reply({ ok: false, error: `${op} refused by the fake runner` });
        return;
      }
      const sid = String(payload.sid ?? "");
      const exchange = options.exchange ?? { bytes: 0, maxBytes: 20 * 1024 ** 3 };
      const overBudget = exchange.bytes > exchange.maxBytes;
      const budgetRefusal = () =>
        reply({
          ok: false,
          error: "Craft storage budget exceeded: the craft runner's shared storage is over its budget.",
          budget: { over: "exchange", exchangeBytes: exchange.bytes, exchangeMaxBytes: exchange.maxBytes },
        });
      switch (op) {
        case "health":
          reply({
            ok: true,
            apps: options.apps ?? [{ id: "photocraft", version: "0.16.0", status: "ready", tools: 20 }],
            procs: { running: 0, max: 3 },
            sessions: runner.tokens.size,
            exchange,
          });
          return;
        case "open":
          if (overBudget && !runner.sessions.has(sid)) {
            budgetRefusal();
            return;
          }
          fs.mkdirSync(path.join(root, "work", sid, "in"), { recursive: true });
          fs.mkdirSync(path.join(root, "work", sid, "out"), { recursive: true });
          runner.sessions.add(sid);
          reply({ ok: true, sid, inDir: `/exchange/work/${sid}/in`, outDir: `/exchange/work/${sid}/out` });
          return;
        case "sync_in":
          if (overBudget) {
            budgetRefusal();
            return;
          }
          copyTree(path.join(root, "inbox", sid), path.join(root, "work", sid, "in"));
          reply({ ok: true, copied: 0, removed: 0, skipped: 0, bytes: 0, rejected: options.syncInRejected?.(sid) ?? [] });
          return;
        case "grant":
          if (!runner.sessions.has(sid)) {
            reply({ ok: false, error: "no such session — open it first" });
            return;
          }
          runner.tokens.set(String(payload.token), sid);
          reply({ ok: true });
          return;
        case "revoke": {
          const tokenSid = runner.tokens.get(String(payload.token));
          runner.tokens.delete(String(payload.token));
          // Like the real runner: a live token's revoke ends with a final sync_out.
          if (tokenSid) copyTree(path.join(root, "work", tokenSid, "out"), path.join(root, "outbox", tokenSid));
          reply({ ok: true });
          return;
        }
        case "revoke_all":
          runner.tokens.clear();
          reply({ ok: true });
          return;
        case "sync_out":
          copyTree(path.join(root, "work", sid, "out"), path.join(root, "outbox", sid));
          reply({ ok: true, files: [] });
          return;
        case "purge":
          runner.sessions.delete(sid);
          for (const [token, tokenSid] of runner.tokens) if (tokenSid === sid) runner.tokens.delete(token);
          for (const dir of ["inbox", "work", "outbox"]) fs.rmSync(path.join(root, dir, sid), { recursive: true, force: true });
          reply({ ok: true });
          return;
        default:
          reply({ ok: false, error: `unknown op ${op}` });
      }
    });
  });
  const mcp = net.createServer((socket) => {
    track(socket);
    let attached = false;
    const challenge = nonce();
    socket.write(`${JSON.stringify({ op: "challenge", v: 1, nonce: challenge })}\n`);
    lines(socket, (line) => {
      runner.rawLines.push({ socket: "mcp", line });
      if (!attached) {
        const message = JSON.parse(line) as { op?: string; tokenId?: string; app?: string; nonce?: string; mac?: string };
        if (options.mcpImpostor) {
          attached = true;
          runner.attaches.push({ token: "", app: String(message.app), ok: true });
          const mac = options.mcpImpostor === "wrong_mac" ? hmac("f".repeat(64), `noah-craft-mcp|server|${String(message.nonce)}`) : undefined;
          socket.write(`${JSON.stringify({ ok: true, ...(mac ? { mac } : {}) })}\n`);
          return;
        }
        const token = [...runner.tokens.keys()].find((candidate) => sha256(candidate) === message.tokenId);
        const ok =
          message.op === "attach" &&
          token !== undefined &&
          typeof message.nonce === "string" &&
          /^[0-9a-f]{32}$/.test(message.nonce) &&
          sameHex(message.mac, hmac(token, `noah-craft-mcp|client|${challenge}|${String(message.app)}`));
        runner.attaches.push({ token: token ?? "", app: String(message.app), ok });
        if (!ok) {
          socket.end(`${JSON.stringify({ ok: false, error: "unknown token" })}\n`);
          return;
        }
        attached = true;
        socket.write(`${JSON.stringify({ ok: true, mac: hmac(token!, `noah-craft-mcp|server|${message.nonce}`) })}\n`);
        return;
      }
      runner.mcpLines.push(line);
      const request = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
      if (request.id === undefined) return; // notification
      const result =
        request.method === "tools/call"
          ? (options.toolResult?.(String(request.params?.name), request.params?.arguments) ?? {
              content: [
                { type: "image", mimeType: "image/png", data: TINY_PNG.toString("base64") },
                { type: "text", text: "preview" },
              ],
            })
          : { echo: request.method };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
  });
  const listen = (server: net.Server, file: string) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => resolve());
    });
  await listen(control, path.join(root, "sock", "control.sock"));
  await listen(mcp, path.join(root, "sock", "mcp.sock"));
  runner.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of open) socket.destroy();
      control.close(() => mcp.close(() => resolve()));
    });
  return runner;
}
