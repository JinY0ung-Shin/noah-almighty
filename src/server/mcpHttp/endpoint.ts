/**
 * Noah-hosted streamable-HTTP MCP endpoint (design §6 N2): `POST|GET|DELETE
 * /mcp/:server` with `Authorization: Bearer <run token>`. pi-gateway's MCP
 * broker calls it on behalf of ONE agent run; the run token selects which of
 * Noah's in-process MCP servers that run may reach.
 *
 * Auth is fail-closed and ordered so it leaks nothing: a missing / unknown /
 * revoked token is 401 for EVERY path (pi then skips that server for the
 * session), and only a valid token learns whether a server exists (404).
 *
 * Why STATEFUL transports (one `StreamableHTTPServerTransport` per MCP session)
 * rather than the SDK's stateless mode: an `McpServer` is one `Protocol`, and a
 * Protocol connects to exactly ONE transport ("Already connected" otherwise).
 * Stateless mode needs a fresh transport per HTTP request — so a fresh server per
 * request — but Noah's servers are built per run by `createMcpToolServer` as one
 * instance each, and pi may run tool calls of one session concurrently. A
 * stateful session keeps one long-lived transport per broker connection: it
 * multiplexes concurrent requests, carries progress notifications, honors
 * `notifications/cancelled`, and closing it aborts every in-flight handler's
 * `extra.signal` (that is how revoke stops running tools).
 *   - An INSTANCE source serves one session at a time: a new `initialize` (the
 *     broker reconnecting after its idle TTL) closes the previous session first.
 *   - A FACTORY source builds a server per session, so sessions may coexist.
 *
 * Gates sit at the JSON-RPC layer, wrapped around the connected transport, so
 * they apply to any McpServer unchanged: `allowTool` filters `tools/list` AND
 * refuses `tools/call` (both, or a hidden tool stays callable by name), and
 * `transformResult` post-processes every tool result (redaction) before it
 * leaves Noah. Handlers must still self-gate — the gate is defense in depth.
 *
 * This module only exports the registry and an Express router factory;
 * `createApp` mounts the router at `/mcp` (bearer-only: no session cookie or
 * other app auth applies under it).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { Router, type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type CallToolResult,
  type JSONRPCMessage,
  type RequestId,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import logger from "../logger.js";
import type { McpNetworkAcl } from "./networkAcl.js";

const log = logger.child({ module: "mcp-http" });

/** Run tokens carry this prefix so a leaked one is recognizable in logs/scanners. */
export const RUN_TOKEN_PREFIX = "nrt_";
const RUN_TOKEN_BYTES = 32;
/** Factory-built sessions kept per (run, server); the oldest closes beyond this. */
const MAX_SESSIONS_PER_SERVER = 8;
const BODY_LIMIT = "16mb";

/**
 * What a run exposes per server name: an McpServer, the `{ instance }` shape
 * `createMcpToolServer` returns, or a factory (a fresh server per MCP session).
 */
export type McpServerSource = McpServer | { instance: McpServer } | (() => McpServer);

export interface McpRunGates {
  /** False hides the tool from `tools/list` and refuses `tools/call`. */
  allowTool?: (server: string, tool: string) => boolean;
  /**
   * Answer `tools/list` from this STATIC list instead of asking the server
   * (`undefined` → ask it). pi fetches a session's tool list once, when the
   * session is built, and keeps it while later turns — each with its OWN run
   * token and capabilities — reuse the session. So the pi runner lists every
   * tool of every Noah server and gates per call with `allowCall`.
   */
  listTools?: (server: string) => Tool[] | undefined;
  /** False refuses `tools/call` (the listing is untouched — pair with `listTools`). */
  allowCall?: (server: string, tool: string) => boolean;
  /** Model-facing text of a refused call (default: "not available in this run"). */
  refusalMessage?: (server: string, tool: string) => string;
  /**
   * Check a call's arguments before the server sees them: a string refuses the
   * call with that model-facing text (`isError`), `null` lets it through. The
   * McpServer's own zod objects STRIP unknown keys, so a misnamed argument is
   * otherwise dropped silently (the pi runner uses it — {@link unknownArgumentProblem}).
   */
  checkArguments?: (server: string, tool: string, args: Record<string, unknown>) => string | null;
  /** Post-process a tool result before it is sent (e.g. secret redaction). */
  transformResult?: (server: string, tool: string, result: CallToolResult) => CallToolResult | Promise<CallToolResult>;
}

export interface McpRunRegistration {
  servers: Record<string, McpServerSource>;
  gates?: McpRunGates;
  /** Aborting it revokes the token (wire the run's AbortSignal). */
  signal?: AbortSignal;
  /** Opaque run context handed to tool handlers as `extra.authInfo.extra.run`. */
  context?: unknown;
  /** Non-secret label for logs (e.g. the conversation id). */
  label?: string;
}

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Inbound requests not answered yet (answered with an error when the session is torn down). */
  inflight: Set<RequestId>;
  /** The transport's own send, bypassing the gate wrapper. */
  sendRaw: (message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }) => Promise<void>;
}

interface ServerSlot {
  name: string;
  source: McpServerSource;
  sessions: Map<string, Session>;
  /** Serializes session creation (an instance must be released before it reconnects). */
  creating: Promise<unknown>;
}

interface RunEntry {
  id: string;
  hash: Buffer;
  servers: Map<string, ServerSlot>;
  gates: McpRunGates;
  context: unknown;
  label?: string;
  revoked: boolean;
  detach?: () => void;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function isFactory(source: McpServerSource): source is () => McpServer {
  return typeof source === "function";
}

function hasInstance(source: McpServerSource): source is { instance: McpServer } {
  return typeof source === "object" && source !== null && "instance" in source && !("server" in source);
}

function instanceOf(source: McpServerSource): McpServer | null {
  if (isFactory(source)) return null;
  return hasInstance(source) ? source.instance : source;
}

/**
 * Run-token registry. Tokens are random 256-bit secrets; only their SHA-256 is
 * held, and lookup compares digests with `timingSafeEqual` (the map key is the
 * digest, so the probe never compares secret bytes directly).
 */
export class McpRunRegistry {
  private readonly runs = new Map<string, RunEntry>();

  register(registration: McpRunRegistration): string {
    const token = `${RUN_TOKEN_PREFIX}${randomBytes(RUN_TOKEN_BYTES).toString("base64url")}`;
    const hash = hashToken(token);
    const servers = new Map<string, ServerSlot>();
    for (const [name, source] of Object.entries(registration.servers)) {
      servers.set(name, { name, source, sessions: new Map(), creating: Promise.resolve() });
    }
    const entry: RunEntry = {
      id: randomUUID(),
      hash,
      servers,
      gates: registration.gates ?? {},
      context: registration.context,
      label: registration.label,
      revoked: false,
    };
    this.runs.set(hash.toString("hex"), entry);
    const signal = registration.signal;
    if (signal) {
      const onAbort = () => void this.revoke(token);
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
    }
    return token;
  }

  /** @internal Router use. Undefined for unknown/revoked tokens. */
  lookup(token: string): RunEntry | undefined {
    const hash = hashToken(token);
    const entry = this.runs.get(hash.toString("hex"));
    if (!entry || entry.revoked || !timingSafeEqual(entry.hash, hash)) return undefined;
    return entry;
  }

  /**
   * Invalidate the token and close every MCP session it opened — in-flight tool
   * handlers see `extra.signal` abort. Idempotent; resolves once sessions closed.
   */
  async revoke(token: string): Promise<void> {
    const key = hashToken(token).toString("hex");
    const entry = this.runs.get(key);
    if (!entry) return;
    this.runs.delete(key);
    entry.revoked = true;
    entry.detach?.();
    const closing: Promise<void>[] = [];
    for (const slot of entry.servers.values()) {
      for (const session of slot.sessions.values()) closing.push(closeSession(slot, session));
    }
    await Promise.allSettled(closing);
  }

  /** Revoke everything (process shutdown). */
  async closeAll(): Promise<void> {
    const entries = [...this.runs.values()];
    this.runs.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        entry.revoked = true;
        entry.detach?.();
        for (const slot of entry.servers.values()) {
          await Promise.allSettled([...slot.sessions.values()].map((s) => closeSession(slot, s)));
        }
      }),
    );
  }

  get size(): number {
    return this.runs.size;
  }
}

async function closeSession(slot: ServerSlot, session: Session): Promise<void> {
  slot.sessions.delete(session.id);
  // Answer what is still running first: once the transport is closed the
  // Protocol drops the aborted handlers' replies, and the broker would wait for
  // its own timeout instead of seeing the run end.
  const pending = [...session.inflight];
  session.inflight.clear();
  await Promise.allSettled(
    pending.map((id) =>
      session.sendRaw(
        { jsonrpc: "2.0", id, error: { code: -32000, message: "The agent run ended; this MCP session is closed." } },
        { relatedRequestId: id },
      ),
    ),
  );
  // Closing the transport runs Protocol._onclose: in-flight handlers abort and
  // the server is released (an instance can then connect to a new session).
  await session.transport.close().catch(() => undefined);
  if (isFactory(slot.source)) await session.server.close().catch(() => undefined);
}

/**
 * Model-facing text for a broker id Noah no longer serves (the register script
 * deletes these entries, `RETIRED_MCP_SERVER_NAMES`; a pi instance it has not
 * re-run against still routes here). An older conversation's frozen prompt may
 * still name their tools.
 */
const RETIRED_SERVER_MESSAGES: Record<string, string> = {
  group_repo:
    "MCP server 'group_repo' was removed: group knowledge repositories no longer exist. Tell the user group repositories were removed; use the personal repository (mcp__repo__*) or skill sharing (mcp__skill_exchange__*) instead.",
  group_brain:
    "MCP server 'group_brain' was removed: there is no team brain any more. Search the personal second brain (mcp__brain__search) instead.",
};

function refusedToolResult(tool: string, message?: string): CallToolResult {
  return {
    content: [{ type: "text", text: message ?? `Tool '${tool}' is not available in this run.` }],
    isError: true,
  };
}

/**
 * Wrap the CONNECTED transport (Protocol already installed its onmessage) so the
 * gates see every JSON-RPC message in both directions, and the session knows
 * which requests are still unanswered.
 */
function installGates(session: Session, serverName: string, gates: McpRunGates): void {
  const transport = session.transport;
  const inbound = transport.onmessage;
  const listRequests = new Set<RequestId>();
  const callRequests = new Map<RequestId, string>();
  const send = session.sendRaw;

  transport.onmessage = (message, extra) => {
    if (isJSONRPCRequest(message)) {
      session.inflight.add(message.id);
      if (message.method === "tools/list") {
        const listed = gates.listTools?.(serverName);
        if (listed) {
          session.inflight.delete(message.id);
          void send({ jsonrpc: "2.0", id: message.id, result: { tools: listed } }, { relatedRequestId: message.id }).catch(
            (error: unknown) => log.warn({ err: error, server: serverName }, "mcp-http: tool list send failed"),
          );
          return;
        }
        listRequests.add(message.id);
      } else if (message.method === "tools/call") {
        const tool = typeof message.params?.name === "string" ? message.params.name : "";
        if (
          (gates.allowTool && !gates.allowTool(serverName, tool)) ||
          (gates.allowCall && !gates.allowCall(serverName, tool))
        ) {
          session.inflight.delete(message.id);
          const result = refusedToolResult(tool, gates.refusalMessage?.(serverName, tool));
          void send(
            { jsonrpc: "2.0", id: message.id, result: result as Record<string, unknown> },
            { relatedRequestId: message.id },
          ).catch((error: unknown) => log.warn({ err: error, server: serverName }, "mcp-http: refusal send failed"));
          return;
        }
        const args = message.params?.arguments;
        const problem = gates.checkArguments?.(
          serverName,
          tool,
          args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
        );
        if (problem) {
          session.inflight.delete(message.id);
          void send(
            { jsonrpc: "2.0", id: message.id, result: refusedToolResult(tool, problem) as Record<string, unknown> },
            { relatedRequestId: message.id },
          ).catch((error: unknown) => log.warn({ err: error, server: serverName }, "mcp-http: argument refusal send failed"));
          return;
        }
        callRequests.set(message.id, tool);
      }
    } else if ("method" in message && message.method === "notifications/cancelled") {
      // The client gave up on it; the Protocol will not answer, so neither will a teardown.
      const id = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      if (id !== undefined) session.inflight.delete(id);
    }
    inbound?.(message, extra);
  };

  transport.send = async (message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }) => {
    let outgoing = message;
    if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id !== undefined) {
      // Already answered by a teardown: never send a second response.
      if (!session.inflight.delete(message.id)) return;
    }
    if (isJSONRPCResultResponse(message)) {
      if (listRequests.delete(message.id) && gates.allowTool && Array.isArray(message.result.tools)) {
        const tools = (message.result.tools as { name?: unknown }[]).filter(
          (tool) => typeof tool.name === "string" && gates.allowTool!(serverName, tool.name),
        );
        outgoing = { ...message, result: { ...message.result, tools } };
      } else if (callRequests.has(message.id)) {
        const tool = callRequests.get(message.id)!;
        callRequests.delete(message.id);
        if (gates.transformResult) {
          const result = await gates.transformResult(serverName, tool, message.result as CallToolResult);
          outgoing = { ...message, result: result as Record<string, unknown> };
        }
      }
    } else if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
      listRequests.delete(message.id);
      callRequests.delete(message.id);
    }
    return send(outgoing, options);
  };
}

type JsonSchemaNode = {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  additionalProperties?: unknown;
  items?: JsonSchemaNode | JsonSchemaNode[];
};

/** Argument names an object schema declares, or null when it accepts any (no `properties`, or extra keys allowed). */
function closedPropertyNames(schema: JsonSchemaNode | undefined): string[] | null {
  if (!schema || typeof schema !== "object" || !schema.properties || typeof schema.properties !== "object") return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;
  return Object.keys(schema.properties);
}

function unknownKeysIn(schema: JsonSchemaNode | undefined, value: unknown, at: string, out: { path: string; valid: string[] }[]): void {
  if (out.length >= 8 || !schema || typeof schema !== "object") return;
  if (Array.isArray(value)) {
    const item = Array.isArray(schema.items) ? undefined : schema.items;
    value.forEach((entry, index) => unknownKeysIn(item, entry, `${at}[${index}]`, out));
    return;
  }
  if (!value || typeof value !== "object") return;
  const valid = closedPropertyNames(schema);
  if (!valid) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = at ? `${at}.${key}` : key;
    if (!valid.includes(key)) out.push({ path, valid });
    else unknownKeysIn(schema.properties![key], child, path, out);
  }
}

/**
 * The model-facing refusal for argument NAMES a tool's JSON schema does not
 * declare (nested objects and arrays of objects included; `anyOf` branches and
 * open objects are not judged), or null when every name is known. Names only:
 * types, enums and required fields stay the client's and the server's checks.
 */
export function unknownArgumentProblem(
  fullName: string,
  inputSchema: Tool["inputSchema"] | undefined,
  args: Record<string, unknown>,
): string | null {
  const found: { path: string; valid: string[] }[] = [];
  unknownKeysIn(inputSchema as JsonSchemaNode | undefined, args, "", found);
  if (found.length === 0) return null;
  const required = new Set(((inputSchema as { required?: unknown })?.required as string[] | undefined) ?? []);
  const groups = new Map<string, { paths: string[]; valid: string[] }>();
  for (const hit of found) {
    const parent = hit.path.includes(".") ? hit.path.slice(0, hit.path.lastIndexOf(".")) : "";
    const group = groups.get(parent) ?? { paths: [], valid: hit.valid };
    group.paths.push(hit.path);
    groups.set(parent, group);
  }
  const parts = [...groups.entries()].map(([parent, group]) => {
    const names = group.valid.length
      ? group.valid.map((name) => (parent === "" && required.has(name) ? `${name} (required)` : name)).join(", ")
      : "none (call it with {})";
    return `${group.paths.map((p) => `\`${p}\``).join(", ")} ${group.paths.length === 1 ? "is" : "are"} not ${parent ? `a field of \`${parent}\`` : "an argument of this tool"}; valid: ${names}`;
  });
  return (
    `Unknown argument name for ${fullName}: ${parts.join(". ")}. ` +
    "Nothing was run. Call it again using only these names (unknown names are never ignored silently); check the full schema with mcp_search if unsure."
  );
}

function jsonRpcError(res: Response, status: number, code: number, message: string, headers: Record<string, string> = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1]! : null;
}

function bodyHasInitialize(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

async function createSession(run: RunEntry, slot: ServerSlot): Promise<Session> {
  const previous = slot.creating;
  let release!: () => void;
  slot.creating = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    const shared = instanceOf(slot.source);
    if (shared) {
      // One Protocol, one transport: release the previous session first.
      await Promise.allSettled([...slot.sessions.values()].map((s) => closeSession(slot, s)));
    } else if (slot.sessions.size >= MAX_SESSIONS_PER_SERVER) {
      const oldest = slot.sessions.values().next().value;
      if (oldest) await closeSession(slot, oldest);
    }
    const server = shared ?? (slot.source as () => McpServer)();
    const session: Session = {
      id: "",
      transport: undefined as unknown as StreamableHTTPServerTransport,
      server,
      inflight: new Set(),
      sendRaw: async () => undefined,
    };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        slot.sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        slot.sessions.delete(sessionId);
      },
    });
    session.transport = transport;
    session.sendRaw = transport.send.bind(transport);
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      previousOnClose?.();
      if (session.id && slot.sessions.get(session.id) === session) slot.sessions.delete(session.id);
    };
    await server.connect(transport);
    installGates(session, slot.name, run.gates);
    return session;
  } finally {
    release();
  }
}

export interface McpHttpRouterOptions {
  registry: McpRunRegistry;
  /** Mount prefix; the route is `<basePath>/:server`. Default `/mcp`. */
  basePath?: string;
  /** Optional peer-address allowlist (`NOAH_MCP_ALLOWED_CIDRS`); unset = the token alone. */
  networkAcl?: McpNetworkAcl | null;
}

/**
 * Express router for the endpoint, mounted by `createApp` at `/mcp` (the broker
 * reaches Noah over the internal network; the run token is the only auth).
 */
export function createMcpHttpRouter(options: McpHttpRouterOptions): Router {
  const { registry } = options;
  const basePath = (options.basePath ?? "/mcp").replace(/\/+$/, "");
  const router = Router();
  const acl = options.networkAcl ?? null;

  // Before the body parser: a peer outside the allowlist costs no parse.
  // The router sits ahead of createApp's security-header middleware, so it
  // sets nosniff itself on every response (JSON, SSE and errors alike).
  router.all(`${basePath}/:server`, (req: Request, res: Response, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (acl && !acl.allows(req.socket.remoteAddress)) {
      jsonRpcError(res, 403, -32001, "Forbidden: this address may not reach the MCP endpoint");
      return;
    }
    next();
  });
  router.all(`${basePath}/:server`, express.json({ limit: BODY_LIMIT }), async (req: Request, res: Response) => {
    try {
      const token = bearerToken(req);
      const run = token ? registry.lookup(token) : undefined;
      if (!run) {
        jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid run token", { "WWW-Authenticate": "Bearer" });
        return;
      }
      const serverName = String(req.params.server ?? "");
      const slot = run.servers.get(serverName);
      if (!slot) {
        jsonRpcError(res, 404, -32601, RETIRED_SERVER_MESSAGES[serverName] ?? `MCP server '${serverName.slice(0, 80)}' is not available to this run`);
        return;
      }
      const authed = req as Request & { auth?: AuthInfo };
      authed.auth = {
        token: run.id,
        clientId: "noah-run",
        scopes: [],
        extra: { run: run.context, server: serverName },
      };
      const body: unknown = req.body;
      const sessionId = req.header("mcp-session-id");
      if (sessionId) {
        const session = slot.sessions.get(sessionId);
        if (!session) {
          // Spec: an unknown session id is 404 → the client re-initializes.
          jsonRpcError(res, 404, -32001, "Session not found");
          return;
        }
        await session.transport.handleRequest(authed, res, body);
        return;
      }
      if (req.method !== "POST" || !bodyHasInitialize(body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
        return;
      }
      const session = await createSession(run, slot);
      if (run.revoked) {
        await closeSession(slot, session);
        jsonRpcError(res, 401, -32001, "Unauthorized: missing or invalid run token", { "WWW-Authenticate": "Bearer" });
        return;
      }
      await session.transport.handleRequest(authed, res, body);
      if (!session.id) await closeSession(slot, session); // initialize was rejected
    } catch (error) {
      log.error({ err: error, path: req.path }, "mcp-http: request failed");
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal error");
      else res.end();
    }
  });

  return router;
}
