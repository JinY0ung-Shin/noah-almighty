// mcp.sock connection handler (spec §4 + Addendum A2): mutual attach handshake, then a policy-enforcing
// JSON-RPC relay between Noah's stdio relay script and the session's app child.
//
//   runner → {"op":"challenge","v":1,"nonce":N1}
//   relay  → {"op":"attach","app":A,"tokenId":sha256hex(token),"nonce":N2,
//             "mac":HMAC(token,"noah-craft-mcp|client|"+N1+"|"+A)}
//   runner → {"ok":true,"mac":HMAC(token,"noah-craft-mcp|server|"+N2)}   (or {"ok":false,"error"} + close)
//
// The run token never crosses the socket; an attach carrying a plaintext `token` field is refused.

import { CallTimeout, ProcessExited } from "./appProcess.mjs";
import { challengeLine, isNonce, macMatches, mcpClientMac, mcpServerMac, newNonce } from "./auth.mjs";
import { createLineSplitter, extractJsonRpcId, writeJson } from "./jsonl.mjs";
import { commandIdsOf, errorResult, evaluateToolCall } from "./policy.mjs";
import { Busy } from "./semaphore.mjs";
import { RequestError } from "./sessions.mjs";

const MiB = 1024 * 1024;

/** The initialize result served from the boot manifest (no child is spawned for it). */
export function manifestInitializeResult(state, layout) {
  const m = state.manifest;
  const note =
    `Noah session paths: read inputs from ${layout.inDir}/ (files Noah copied in from the conversation ` +
    `workspace; read-only) and write every result under ${layout.outDir}/ (the only writable root; it is ` +
    `copied back to the conversation workspace after each tool call). Use these absolute paths.`;
  return {
    protocolVersion: m.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: m.serverInfo,
    instructions: m.instructions ? `${m.instructions}\n\n${note}` : note,
  };
}

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** The call pushed a budget over: keep what the app returned, but flag it isError with the budget text. */
export function overBudgetResult(result, message) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return { ...(result && typeof result === "object" ? result : {}), content: [...content, { type: "text", text: message }], isError: true };
}

/**
 * @param {import("node:net").Socket} socket
 * @param {{ sessions: import("./sessions.mjs").SessionManager, limits: object, log: (m: string) => void }} ctx
 */
export function handleMcpConnection(socket, ctx) {
  const { sessions, limits, log } = ctx;
  const nonce = newNonce();
  let conn = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    socket.destroy();
  };
  const helloTimer = setTimeout(() => {
    if (!conn) {
      writeJson(socket, { ok: false, error: "attach timeout" });
      socket.end();
    }
  }, limits.helloTimeoutMs);

  const onAttach = (line) => {
    clearTimeout(helloTimer);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = null;
    }
    try {
      if (!msg || typeof msg !== "object" || msg.op !== "attach") throw new RequestError("first line must be an attach");
      if (Object.prototype.hasOwnProperty.call(msg, "token")) {
        log("mcp: refused an attach carrying a plaintext token");
        throw new RequestError("unauthorized");
      }
      if (typeof msg.app !== "string" || msg.app.length === 0 || msg.app.length > 64) throw new RequestError("unknown app");
      if (!isNonce(msg.nonce) || msg.nonce === nonce) throw new RequestError("unauthorized");
      const entry = sessions.lookupTokenId(msg.tokenId);
      if (!macMatches(msg.mac, mcpClientMac(entry.token, nonce, msg.app))) {
        log(`mcp: attach MAC mismatch (session ${entry.sid})`);
        throw new RequestError("unauthorized");
      }
      const { state } = sessions.attach(entry, msg.app);
      conn = new McpConn(socket, entry, state, ctx, close);
      sessions.addConn(entry, state.app.id, conn);
      writeJson(socket, { ok: true, mac: mcpServerMac(entry.token, msg.nonce) });
    } catch (err) {
      writeJson(socket, { ok: false, error: err instanceof RequestError ? err.message : "attach failed" });
      socket.end();
      closed = true;
    }
  };

  socket.on(
    "data",
    createLineSplitter({
      maxBytes: limits.maxRequestLineBytes,
      onLine: (line) => {
        if (closed) return;
        if (!conn) onAttach(line);
        else conn.onLine(line);
      },
      onOverflow: (o) => {
        if (!conn) {
          writeJson(socket, { ok: false, error: "attach line too long" });
          socket.end();
          closed = true;
          return;
        }
        const id = extractJsonRpcId(o.tail, "last") ?? null;
        writeJson(socket, rpcError(id, -32600, `request exceeds the ${limits.maxRequestLineBytes / MiB} MiB cap`));
      },
    }),
  );
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(helloTimer);
    closed = true;
    conn?.onClose();
    if (!conn) return;
    log(`mcp: connection closed (session ${conn.entry.sid}, ${conn.app.id})`);
  });
  writeJson(socket, challengeLine(nonce));
}

class McpConn {
  constructor(socket, entry, state, ctx, close) {
    this.socket = socket;
    this.entry = entry;
    this.state = state;
    this.app = state.app;
    this.ctx = ctx;
    this.close = close;
    this.served = new Set(state.manifest.tools.map((t) => t.name));
    this.initParams = undefined;
    /** client request id → { proc, rid } for cancellation */
    this.inflight = new Map();
  }

  send(msg) {
    writeJson(this.socket, msg);
  }

  notify(msg) {
    this.send(msg);
  }

  onClose() {
    this.ctx.sessions.removeConn(this.entry, this.app.id, this);
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.send(rpcError(null, -32700, "parse error"));
      return;
    }
    if (Array.isArray(msg)) {
      this.send(rpcError(null, -32600, "JSON-RPC batches are not supported"));
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return; // responses: never expected
    const isRequest = msg.id !== undefined && msg.id !== null;
    const { method, params, id } = msg;
    if (!isRequest) {
      if (method === "notifications/cancelled") this.forwardCancel(params);
      return;
    }
    switch (method) {
      case "initialize":
        this.initParams = params && typeof params === "object" ? params : undefined;
        this.send({ jsonrpc: "2.0", id, result: manifestInitializeResult(this.state, this.ctx.sessions.layout(this.entry.sid)) });
        return;
      case "ping":
        this.send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list":
        this.send({ jsonrpc: "2.0", id, result: { tools: this.state.manifest.tools } });
        return;
      case "tools/call":
        this.handleCall(id, params).catch((err) => {
          this.ctx.log(`mcp: tools/call crashed: ${err.stack ?? err}`);
          this.send({ jsonrpc: "2.0", id, result: errorResult("Internal craft-runner error; retry the call.") });
        });
        return;
      default:
        this.send(rpcError(id, -32601, `method ${method} is not supported`));
    }
  }

  forwardCancel(params) {
    const hit = params && this.inflight.get(params.requestId);
    if (hit) hit.proc.notify("notifications/cancelled", { ...params, requestId: hit.rid });
  }

  /** The child's initialize params: the client's own, pinned to the manifest's protocol version. */
  childInitParams() {
    const base = this.initParams ?? { capabilities: {}, clientInfo: { name: "craft-runner", version: "1" } };
    return { ...base, protocolVersion: this.state.manifest.protocolVersion };
  }

  async handleCall(id, params) {
    const { sessions, limits, log } = this.ctx;
    const label = this.app.label;
    const p = params && typeof params === "object" ? params : {};
    const verdict = evaluateToolCall(this.app, this.served, p.name, p.arguments);
    const cmds = commandIdsOf(this.app, p.name, p.arguments);
    log(`call session=${this.entry.sid} app=${this.app.id} tool=${String(p.name).slice(0, 64)}${cmds.length ? ` cmd=${cmds.join(",").slice(0, 200)}` : ""}${verdict.ok ? "" : " DENIED"}`);
    if (!verdict.ok) {
      this.send({ jsonrpc: "2.0", id, result: verdict.result });
      return;
    }
    if (sessions.isExpired(this.entry)) {
      this.send({
        jsonrpc: "2.0",
        id,
        result: errorResult(
          `This ${label} session expired (a run token lives 12 h). Results already written are in the workspace under craft/out/; send a new message to start a fresh run.`,
        ),
      });
      sessions.revoke(this.entry.token).catch((err) => log(`revoke of an expired token failed: ${err.message}`));
      return;
    }
    // Disk budgets (Addendum A4): an over-budget session or exchange runs nothing more.
    const before = await sessions.budgetState(this.entry.sid);
    if (before.over) {
      log(`call session=${this.entry.sid} app=${this.app.id} REFUSED (over ${before.over} budget)`);
      this.send({ jsonrpc: "2.0", id, result: errorResult(before.message) });
      return;
    }
    let result;
    let error;
    try {
      const proc = await sessions.getProc(this.entry, this.app.id, this.childInitParams());
      const { id: rid, response } = proc.send("tools/call", { ...p, arguments: verdict.args }, limits.callTimeoutMs);
      this.inflight.set(id, { proc, rid });
      let resp;
      try {
        resp = await response;
      } finally {
        this.inflight.delete(id);
        sessions.armIdle(this.entry, this.app.id);
      }
      if (resp.overflow) {
        result = errorResult(
          `The ${label} result (${(resp.bytes / MiB).toFixed(1)} MiB) exceeded the ${limits.maxResponseLineBytes / MiB} MiB response cap and was dropped. ` +
            `Request a smaller output (e.g. render_preview with a lower max_side) or write the result to out/ with doc_export.`,
        );
      } else if (resp.error) {
        error = resp.error;
      } else {
        result = resp.result;
      }
    } catch (err) {
      result = errorResult(this.failureText(err));
    }
    if (!this.entry.revoked) {
      try {
        const synced = await sessions.syncOut(this.entry.sid);
        if (synced.budget?.over && !error) result = overBudgetResult(result, synced.budget.message);
      } catch (err) {
        log(`session ${this.entry.sid}: sync_out after call failed: ${err.message}`);
      }
    }
    this.send(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }

  failureText(err) {
    const label = this.app.label;
    const lost = `open documents were lost — reopen from in/ or out/`;
    if (err instanceof CallTimeout) {
      return `The call timed out after ${Math.round(this.ctx.limits.callTimeoutMs / 1000)} s: the ${label} process was restarted; ${lost}.`;
    }
    if (err instanceof ProcessExited) return `The ${label} process exited unexpectedly (${err.message}); ${lost}.`;
    if (err instanceof Busy) {
      return `${label} is busy: every app process slot of the craft runner is in use. Wait a minute and retry the call.`;
    }
    if (err instanceof RequestError) return `${label} is not available: ${err.message}.`;
    return `${label} could not be started (${err.message.slice(0, 200)}). Retry once; if it keeps failing, tell the user the craft runner is unavailable.`;
  }
}
