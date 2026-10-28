/**
 * pi runs: Noah as an MCP CLIENT of the servers that exist only as processes or
 * remote endpoints (design N2, docs/architecture/pi-runtime.md "Proxied MCP
 * servers") — hex-ssh, the run's plugin `.mcp.json` servers and the admin 공용
 * MCP servers — re-exported on the run's `/mcp` endpoint.
 *
 * Secrets stay in Noah. The SSH key, the owner's vault and bound slot values
 * reach only the child process Noah spawns (in its env, or for an HTTP server
 * the stdio↔HTTP bridge's one-shot 0600 config file, which keeps the corporate
 * CA handling of `--use-system-ca`); never the sandbox, never pi.
 *
 * pi lists a session's tools ONCE and broker ids are global, so each source
 * kind is ONE stable broker id whose tool list is per run token:
 *   - `hex-ssh` → `mcp__hex-ssh__<tool>` (the SDK name, unchanged)
 *   - `plugins` → `mcp__plugins__<server>__<tool>`
 *   - `shared`  → `mcp__shared__<server>__<tool>`
 * pi's `mcp_call` also resolves the SDK form `mcp__<server>__<tool>` (it matches
 * a tool whose name ends in `__<server>__<tool>`), so skills keep working.
 *
 * A stdio plugin server is a command Noah runs in ITS OWN container, so on pi
 * only the plugins bundled with this Noah build may spawn one
 * ({@link piStdioRootRefusal}); every agent-editable root is refused.
 *
 * Lifecycle: one {@link PiMcpProxyPool} per run. A child starts on the first
 * `tools/list` or `tools/call` that needs it and every child is closed when the
 * run ends (`close`, called from runPiAgent's `finally`).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig, PiProxiedMcpFacts, PluginRoot } from "../../types.js";
import { HEX_SSH_SERVER_NAME } from "../../hexSshPolicy.js";
import { isOwnedPluginRoot, liftPluginMcpServers } from "../../plugins.js";
import { GIT_CREDENTIAL_ENV_NAMES, scrubServerOnlySecretEnv } from "../../secretPolicy.js";
import { sanitizeName } from "../../marketplace.js";
import {
  mcpBridgeRedactions,
  type McpHttpBridgeConfig,
  type SharedMcpRunPlan,
} from "../../sharedMcpServers.js";
import { knownHostsPath } from "../../sshTrust.js";
import { piPluginRootKind } from "./piSkills.js";
import logger from "../../logger.js";

const log = logger.child({ module: "agent", component: "pi-mcp-proxy" });

export const PI_PLUGINS_SERVER_NAME = "plugins";
export const PI_SHARED_SERVER_NAME = "shared";
/** The proxy broker ids, in registration order (all fit pi's id rule). */
export const PI_PROXY_SERVER_NAMES = [HEX_SSH_SERVER_NAME, PI_PLUGINS_SERVER_NAME, PI_SHARED_SERVER_NAME] as const;
export type PiProxyServerName = (typeof PI_PROXY_SERVER_NAMES)[number];

/** `<server>__<tool>` inside an aggregate (`plugins`, `shared`). */
const SEPARATOR = "__";
/** One source's `tools/list` at session build (pi skips a whole server after 15 s). */
const LIST_DEADLINE_MS = 10_000;
/** Upstream call budget; the broker's per-server timeout cuts first and cancels. */
const CALL_TIMEOUT_MS = 600_000;
/** SSH vault names that are credentials (SSH_USER / ALLOWED_HOSTS are not — redacting them would shred output). */
const SSH_CREDENTIAL_NAMES = ["SSH_PRIVATE_KEY", "SSH_PASSPHRASE", "SSH_PASSWORD"] as const;

/** One child process Noah talks MCP to. */
export interface PiMcpUpstream {
  proxy: PiProxyServerName;
  /** Source name: the plugin / shared server name, or `hex-ssh`. */
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Written 0600 right before the child starts (the bridge reads and deletes it). */
  handoff?: { path: string; content: string };
  /** Tool filter on BOTH list and call (hex-ssh's per-viewer-class allowlist). */
  allowTool?: (tool: string) => boolean;
}


export interface PiMcpProxyPlan {
  upstreams: PiMcpUpstream[];
  facts: PiProxiedMcpFacts;
  /** Values the endpoint redacts from EVERY result of the run (name → value). */
  redactions: Record<string, string>;
}

export interface PiMcpProxyInput {
  config: AppConfig;
  avatarUserId: string;
  pluginRoots: PluginRoot[];
  /** The run may carry the owner's vault (elevated, not a consultation). */
  secretsAllowed: boolean;
  /** The owner's vault minus reserved git/SSH names. */
  injectableSecretEnv: Record<string, string>;
  /** hex-ssh registration (runCapabilities' `sshActive`). */
  sshActive: boolean;
  /** The owner's SSH material (SSH_MCP_SECRET_ENV_NAMES subset). */
  sshSecrets: Record<string, string>;
  hexSshAllowedTools: readonly string[];
  sharedMcpPlan: SharedMcpRunPlan | null;
  /** Names Noah's own servers take this run (a plugin server of that name sits out, as on the SDK path). */
  reservedNames: readonly string[];
  /** Per-run unique id for handoff file names. */
  runId?: string;
}

/** The env a relayed child starts from: Noah's (already scrubbed) env minus git credentials and server-only secrets. */
export function piProxyBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string | undefined> = { ...source };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) delete env[name];
  scrubServerOnlySecretEnv(env);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

const STDIO_ONLY_BUNDLED =
  "; on this runtime Noah never runs agent-editable code in its own container, so stdio plugin servers start only from the plugins bundled with Noah (an http/sse plugin server or an admin-registered shared MCP server still works)";

/**
 * Why a root may NOT spawn stdio servers on a pi run, or null when it may.
 * A stdio def is a command Noah runs in its own container (the data volume,
 * every user's state), so only roots no agent can author qualify: the plugins
 * bundled with this Noah build (`config.defaultPluginsDir`). Every other root
 * is agent-writable, directly or at one remove:
 *   - the personal knowledge clone: `mcp__repo__*` writes and commits it;
 *   - a group knowledge clone: members' agents write it (`mcp__group_repo__*`);
 *   - an installed plugin repo: `mcp__git_repo__*` registers any URL and pushes
 *     with the owner's git token, and the next plugin refresh pulls it;
 *   - anything else: unknown provenance, refused (fail closed).
 * The SDK runner is unchanged: its CLI children (and the agent's Bash) already
 * share Noah's container (#71). Reasons are model-facing English.
 */
export function piStdioRootRefusal(rootPath: string, config: AppConfig): string | null {
  switch (piPluginRootKind(config, rootPath)) {
    case "default":
      return null;
    case "knowledge":
      return `it is defined in the knowledge repository, which the agent edits through mcp__repo__*${STDIO_ONLY_BUNDLED}`;
    case "group":
      return `it is defined in a group knowledge repository, which members' agents edit through mcp__group_repo__*${STDIO_ONLY_BUNDLED}`;
    case "plugin":
      return `it is defined in an installed plugin repository, whose remote an agent can push to with mcp__git_repo__* before the next plugin refresh${STDIO_ONLY_BUNDLED}`;
    default:
      return `it is not defined in a plugin bundled with Noah${STDIO_ONLY_BUNDLED}`;
  }
}

/** `${VAR}` / `${VAR:-default}` from `env`, as the CLI expands its `--mcp-config`. */
function expandEnvRefs(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_whole, name: string, fallback?: string) => {
    const v = env[name];
    return v !== undefined && v !== "" ? v : (fallback ?? "");
  });
}

const ENV_REF_NAMES = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;

function bridgeUpstream(
  proxy: PiProxyServerName,
  name: string,
  config: McpHttpBridgeConfig,
  secretsDir: string,
  runId: string,
  env: Record<string, string>,
): PiMcpUpstream {
  const file = path.join(secretsDir, `pi-${runId}-${proxy}-${sanitizeName(name)}.json`);
  return {
    proxy,
    name,
    command: process.execPath,
    args: ["--use-system-ca", path.join(process.cwd(), "scripts", "mcp-http-bridge.mjs"), "--config", file],
    env,
    handoff: { path: file, content: JSON.stringify(config) },
  };
}

/**
 * Resolve this run's proxied servers. Pure apart from reading the plugin roots'
 * `.mcp.json` files; nothing is spawned here.
 */
export async function planPiMcpProxies(input: PiMcpProxyInput): Promise<PiMcpProxyPlan> {
  const runId = input.runId ?? randomUUID();
  const secretsDir = path.join(input.config.dataDir, "runtime", "mcp-secrets");
  const baseEnv = piProxyBaseEnv();
  const upstreams: PiMcpUpstream[] = [];
  const facts: PiProxiedMcpFacts = { hexSsh: false, pluginServers: [], skippedPluginServers: [] };
  const vault = input.secretsAllowed ? input.injectableSecretEnv : {};
  let vaultExposed = false;
  const bridges: { name: string; config: McpHttpBridgeConfig }[] = [];

  // hex-ssh: the same policy proxy + env the SDK path registers; the SSH
  // material goes straight into the child's env (no argv, no file — Noah spawns
  // it itself, so the CLI's `--mcp-config` exposure that needed the wrapper is gone).
  if (input.sshActive) {
    const allowed = new Set(input.hexSshAllowedTools);
    upstreams.push({
      proxy: HEX_SSH_SERVER_NAME,
      name: HEX_SSH_SERVER_NAME,
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts", "hex-ssh-policy-proxy.mjs")],
      env: {
        ...baseEnv,
        REMOTE_SSH_MODE: "safe",
        KNOWN_HOSTS_PATH: knownHostsPath(input.avatarUserId, input.config),
        HEX_SSH_UPSTREAM_COMMAND: input.config.hexSshCommand,
        HEX_SSH_ALLOWED_TOOLS: input.hexSshAllowedTools.join(","),
        ...input.sshSecrets,
      },
      allowTool: (tool) => allowed.has(tool),
    });
    facts.hexSsh = true;
  }

  // 공용 MCP servers: always through the bridge (a header-less one too), so the
  // corporate CA and the bridge's error scrubbing apply exactly as on the SDK path.
  const sharedNames = new Set<string>();
  for (const registration of input.sharedMcpPlan?.registrations ?? []) {
    sharedNames.add(registration.name);
    const config: McpHttpBridgeConfig =
      registration.kind === "bridge"
        ? registration.config
        : { url: registration.def.url, transport: registration.def.type, headers: {}, redact: [] };
    if (config.redact.length > 0) vaultExposed = true;
    bridges.push({ name: registration.name, config });
    upstreams.push(bridgeUpstream(PI_SHARED_SERVER_NAME, registration.name, config, secretsDir, runId, baseEnv));
  }
  // Every ENABLED admin server reserves its name, mounted or not (SDK parity).
  for (const state of input.sharedMcpPlan?.states ?? []) sharedNames.add(state.name);

  // Plugin `.mcp.json` servers: first definition of a name wins (load order).
  // An http/sse def from an OWNED root may reference the vault; a stdio def
  // spawns only from a bundled root (piStdioRootRefusal), which never gets it.
  const reserved = new Set(input.reservedNames);
  const seen = new Set<string>();
  for (const root of input.pluginRoots) {
    const owned = isOwnedPluginRoot(root.path, input.avatarUserId, input.config);
    const { servers } = await liftPluginMcpServers([root.path], {
      avatarUserId: input.avatarUserId,
      config: input.config,
      secretWrapper: null,
    });
    for (const [name, def] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const skip = (reason: string) => facts.skippedPluginServers.push({ name, reason });
      if (sharedNames.has(name)) {
        skip("an admin-registered shared MCP server has the same name");
        continue;
      }
      if (reserved.has(name)) {
        skip("one of Noah's own tool servers has the same name");
        continue;
      }
      const type = typeof def.type === "string" ? def.type : "stdio";
      if (type === "http" || type === "sse") {
        const unbridgeable = Object.keys(def).filter((key) => !["type", "url", "headers"].includes(key));
        if (typeof def.url !== "string" || unbridgeable.length > 0) {
          skip(`its definition uses fields Noah cannot relay on this runtime (${unbridgeable.join(", ") || "no url"})`);
          continue;
        }
        const headers: Record<string, string> = {};
        for (const [header, value] of Object.entries((def.headers ?? {}) as Record<string, unknown>)) {
          if (typeof value === "string") headers[header] = value;
        }
        const refs = owned
          ? [...new Set([def.url, ...Object.values(headers)].flatMap((v) => [...v.matchAll(ENV_REF_NAMES)].map((m) => m[1]!)))]
              .filter((ref) => Object.hasOwn(vault, ref))
          : [];
        const config: McpHttpBridgeConfig = {
          url: def.url,
          transport: type,
          headers,
          redact: refs.map((ref) => vault[ref]!).filter((value) => value.length > 0),
          ...(refs.length ? { vault: Object.fromEntries(refs.map((ref) => [ref, vault[ref]!])) } : {}),
          expandEnv: true,
        };
        if (refs.length) vaultExposed = true;
        bridges.push({ name, config });
        upstreams.push(bridgeUpstream(PI_PLUGINS_SERVER_NAME, name, config, secretsDir, runId, baseEnv));
        facts.pluginServers.push(name);
        continue;
      }
      if (type !== "stdio" || typeof def.command !== "string") {
        skip(`unsupported server type '${type}'`);
        continue;
      }
      const refusal = piStdioRootRefusal(root.path, input.config);
      if (refusal) {
        skip(refusal);
        continue;
      }
      const defEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries((def.env ?? {}) as Record<string, unknown>)) {
        if (typeof value === "string") defEnv[key] = expandEnvRefs(value, baseEnv);
      }
      upstreams.push({
        proxy: PI_PLUGINS_SERVER_NAME,
        name,
        command: expandEnvRefs(def.command, baseEnv),
        args: (Array.isArray(def.args) ? def.args : [])
          .filter((arg): arg is string => typeof arg === "string")
          .map((arg) => expandEnvRefs(arg, baseEnv)),
        env: { ...baseEnv, ...defEnv },
        cwd: typeof def.cwd === "string" ? def.cwd : root.path,
      });
      facts.pluginServers.push(name);
    }
  }

  const redactions: Record<string, string> = {
    ...(vaultExposed ? input.injectableSecretEnv : {}),
    ...mcpBridgeRedactions(bridges),
  };
  if (input.sshActive) {
    for (const name of SSH_CREDENTIAL_NAMES) {
      const value = input.sshSecrets[name];
      if (value) redactions[name] = value;
    }
  }
  return { upstreams, facts, redactions };
}

interface Connected {
  client: Client;
  transport: StdioClientTransport;
  tools?: Tool[];
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The run's live MCP clients. Every method is safe after `close` (it refuses).
 */
export class PiMcpProxyPool {
  private readonly connections = new Map<PiMcpUpstream, Promise<Connected>>();
  private readonly transports = new Set<StdioClientTransport>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly upstreams: readonly PiMcpUpstream[]) {}

  private sources(proxy: PiProxyServerName): PiMcpUpstream[] {
    return this.upstreams.filter((upstream) => upstream.proxy === proxy);
  }

  /** The source and its tool name for an exposed tool name (longest server-name prefix wins). */
  resolve(proxy: PiProxyServerName, exposed: string): { upstream: PiMcpUpstream; tool: string } | null {
    if (proxy === HEX_SSH_SERVER_NAME) {
      const upstream = this.sources(proxy)[0];
      return upstream ? { upstream, tool: exposed } : null;
    }
    const match = this.sources(proxy)
      .filter((upstream) => exposed.startsWith(`${upstream.name}${SEPARATOR}`))
      .sort((a, b) => b.name.length - a.name.length)[0];
    return match ? { upstream: match, tool: exposed.slice(match.name.length + SEPARATOR.length) } : null;
  }

  /** The endpoint's per-call gate: the tool belongs to a source of THIS run and passes its filter. */
  allowsCall(proxy: string, exposed: string): boolean {
    if (!(PI_PROXY_SERVER_NAMES as readonly string[]).includes(proxy)) return false;
    const hit = this.resolve(proxy as PiProxyServerName, exposed);
    return Boolean(hit && hit.tool && (hit.upstream.allowTool?.(hit.tool) ?? true));
  }

  /** Children currently started (tests: no leak after close). */
  get childPids(): number[] {
    return [...this.transports].map((t) => t.pid).filter((pid): pid is number => typeof pid === "number");
  }

  private connect(upstream: PiMcpUpstream): Promise<Connected> {
    if (this.closed) return Promise.reject(new Error("the run's MCP proxies are closed"));
    let pending = this.connections.get(upstream);
    if (!pending) {
      pending = this.start(upstream);
      // A failed start is retried by the next call (a crashed plugin server may come back).
      pending.catch(() => {
        if (this.connections.get(upstream) === pending) this.connections.delete(upstream);
      });
      this.connections.set(upstream, pending);
    }
    return pending;
  }

  private async start(upstream: PiMcpUpstream): Promise<Connected> {
    if (upstream.handoff) {
      fs.mkdirSync(path.dirname(upstream.handoff.path), { recursive: true, mode: 0o700 });
      fs.writeFileSync(upstream.handoff.path, upstream.handoff.content, { mode: 0o600 });
    }
    const transport = new StdioClientTransport({
      command: upstream.command,
      args: upstream.args,
      env: upstream.env,
      ...(upstream.cwd ? { cwd: upstream.cwd } : {}),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += String(chunk);
    });
    this.transports.add(transport);
    transport.onclose = () => {
      this.transports.delete(transport);
      this.connections.delete(upstream);
    };
    const client = new Client({ name: "noah-pi-proxy", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: LIST_DEADLINE_MS });
    } catch (error) {
      this.transports.delete(transport);
      await transport.close().catch(() => undefined);
      log.warn(
        { proxy: upstream.proxy, server: upstream.name, err: String(error), stderr: stderr.slice(0, 500) },
        "pi mcp proxy: upstream failed to start",
      );
      throw new Error(`MCP server '${upstream.name}' did not start`, { cause: error });
    } finally {
      // The bridge consumed it on start; a child that never read it must not leave plaintext behind.
      if (upstream.handoff) fs.rmSync(upstream.handoff.path, { force: true });
    }
    if (this.closed) {
      await client.close().catch(() => undefined);
      throw new Error("the run's MCP proxies are closed");
    }
    return { client, transport };
  }

  private async toolsOf(upstream: PiMcpUpstream): Promise<Tool[]> {
    const connected = await this.connect(upstream);
    if (!connected.tools) {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await connected.client.listTools(cursor ? { cursor } : undefined, { timeout: LIST_DEADLINE_MS });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      connected.tools = tools.filter((tool) => upstream.allowTool?.(tool.name) ?? true);
    }
    return connected.tools;
  }

  /** `tools/list` of one proxy server: every source in parallel, a slow or failed one left out. */
  async listTools(proxy: PiProxyServerName): Promise<Tool[]> {
    const sources = this.sources(proxy);
    const listed = await Promise.allSettled(
      sources.map((upstream) =>
        Promise.race([
          this.toolsOf(upstream),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tools/list timed out")), LIST_DEADLINE_MS).unref()),
        ]),
      ),
    );
    const out: Tool[] = [];
    listed.forEach((result, index) => {
      const upstream = sources[index]!;
      if (result.status === "rejected") {
        log.warn({ proxy, server: upstream.name, err: String(result.reason) }, "pi mcp proxy: tools/list failed; source skipped");
        return;
      }
      for (const tool of result.value) {
        out.push(proxy === HEX_SSH_SERVER_NAME ? tool : { ...tool, name: `${upstream.name}${SEPARATOR}${tool.name}` });
      }
    });
    return out;
  }

  async callTool(
    proxy: PiProxyServerName,
    exposed: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (p: { progress: number; total?: number; message?: string }) => void } = {},
  ): Promise<CallToolResult> {
    const hit = this.resolve(proxy, exposed);
    if (!hit || !hit.tool) {
      return errorResult(
        `Tool '${exposed}' belongs to no MCP server relayed in this run. Check mcp__system__describe_system for the servers this run has; do not retry it.`,
      );
    }
    if (hit.upstream.allowTool && !hit.upstream.allowTool(hit.tool)) {
      return errorResult(`Tool '${hit.tool}' is not allowed by the deployment's policy for this conversation. Do not retry it.`);
    }
    let connected: Connected;
    try {
      connected = await this.connect(hit.upstream);
    } catch {
      return errorResult(`MCP server '${hit.upstream.name}' could not be started for this run. Tell the user; do not retry in a loop.`);
    }
    try {
      const result = await connected.client.callTool({ name: hit.tool, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onProgress ? { onprogress: options.onProgress } : {}),
      });
      if ("content" in result && Array.isArray(result.content)) return result as CallToolResult;
      // A legacy `toolResult` reply: hand it over as text.
      return { content: [{ type: "text", text: JSON.stringify((result as { toolResult?: unknown }).toolResult ?? result) }] };
    } catch (error) {
      return errorResult(`MCP server '${hit.upstream.name}' failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 800));
    }
  }

  /** One McpServer per endpoint session, answering from this pool. */
  serverFor(proxy: PiProxyServerName): () => McpServer {
    return () => {
      const server = new McpServer({ name: proxy, version: "1.0.0" }, { capabilities: { tools: {} } });
      server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools(proxy) }));
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const token = request.params._meta?.progressToken;
        return this.callTool(proxy, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>, {
          signal: extra.signal,
          ...(token !== undefined
            ? {
                onProgress: (p) =>
                  void extra
                    .sendNotification({ method: "notifications/progress", params: { progressToken: token, ...p } })
                    .catch(() => undefined),
              }
            : {}),
        });
      });
      return server;
    };
  }

  /** Close every client (its child gets stdin EOF, then SIGTERM, then SIGKILL). Idempotent. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const pending = [...this.connections.values()];
      this.connections.clear();
      this.closing = Promise.allSettled(
        pending.map(async (connection) => {
          const { client } = await connection;
          await client.close();
        }),
      ).then(async () => {
        // Anything that raced the close (a start still connecting) is stopped too.
        await Promise.allSettled([...this.transports].map((t) => t.close()));
        for (const upstream of this.upstreams) if (upstream.handoff) fs.rmSync(upstream.handoff.path, { force: true });
      });
    }
    return this.closing;
  }
}
