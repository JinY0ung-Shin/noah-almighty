import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import type { AppConfig } from "../types.js";
import { addTrustedHost, listTrustedHosts, removeTrustedHost } from "../sshTrust.js";
import { text } from "./mcpTools.js";

/**
 * Per-conversation context for the SSH host-trust tools. They let the avatar
 * register/list/forget the host keys hex-ssh checks before connecting (fail-
 * closed). Host fingerprints are PUBLIC data, not secrets, so — unlike the
 * knowledge-repo tools — these are NOT owner-only: any viewer who can drive the
 * avatar's hex-ssh tools can also manage which hosts it trusts. The trust file
 * is keyed to the avatar OWNER (avatar.id), matching the injected SSH key, so it
 * persists per-user in the data volume.
 */
export interface SshTrustToolsContext {
  /** The avatar (== owner) whose trust store these tools manage. */
  avatarUserId: string;
  config: AppConfig;
}

/** MCP server name; tools surface to the model as `mcp__ssh_trust__<tool>`. */
export const SSH_TRUST_SERVER_NAME = "ssh_trust";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const SSH_TRUST_TOOL_NAMES = [
  "mcp__ssh_trust__add_host",
  "mcp__ssh_trust__list_hosts",
  "mcp__ssh_trust__remove_host",
] as const;

/**
 * Build the SSH host-trust tool definitions bound to a single conversation's
 * context. Exposed separately from the server so handlers can be unit-tested.
 */
export function buildSshTrustTools(ctx: SshTrustToolsContext) {
  return [
    tool(
      "add_host",
      "Fetch a remote host's SSH host key and register it in the trust list (known_hosts). hex-ssh rejects connections to untrusted hosts with 'Host denied (verification failed)', so call this before connecting to a host for the first time. The registration takes effect immediately and persists across container restarts. Host keys are not secrets.",
      {
        host: z.string().describe("Hostname or IP (e.g. 202.20.185.100)"),
        port: z.number().int().optional().describe("SSH port (default 22)"),
      },
      async (args) => {
        const port = args.port ?? 22;
        try {
          const { entry, changed } = await addTrustedHost(ctx.avatarUserId, ctx.config, args.host, port);
          const note = changed ? "Registered the host key" : "Host key is already registered";
          return text(
            `${note}: ${entry.host} (${entry.keyType})\n` +
              `Fingerprint: ${entry.fingerprint}\nYou can now connect to this host.`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // The handshake failure is usually network/firewall, not auth.
          return text(
            `Could not fetch the host key (${args.host}:${port}): ${msg}. ` +
              `Check that the host/port are correct and reachable from the network.`,
            true,
          );
        }
      },
    ),
    tool(
      "list_hosts",
      "Show the list of currently trusted SSH host keys. (host, key type, fingerprint)",
      {},
      async () => {
        const entries = await listTrustedHosts(ctx.avatarUserId, ctx.config);
        if (entries.length === 0) {
          return text("No trusted hosts. Register one with add_host.");
        }
        const body = entries
          .map((e) => `- ${e.host} (${e.keyType}) ${e.fingerprint}`)
          .join("\n");
        return text(`Trusted hosts:\n${body}`);
      },
    ),
    tool(
      "remove_host",
      "Remove a single host's key from the trust list. Use this when a host key has changed or is no longer in use.",
      {
        host: z.string().describe("Hostname or IP to remove"),
        port: z.number().int().optional().describe("SSH port (default 22)"),
      },
      async (args) => {
        const removed = await removeTrustedHost(ctx.avatarUserId, ctx.config, args.host, args.port ?? 22);
        if (removed === 0) {
          return text(`${args.host} is not in the trust list.`);
        }
        return text(`Removed ${removed} host key(s) for ${args.host}.`);
      },
    ),
  ];
}

/**
 * Build the in-process MCP server exposing the SSH host-trust tools, bound to a
 * single conversation's context.
 */
export function buildSshTrustServer(ctx: SshTrustToolsContext) {
  return createMcpToolServer({
    name: SSH_TRUST_SERVER_NAME,
    version: "0.1.0",
    tools: buildSshTrustTools(ctx),
  });
}
