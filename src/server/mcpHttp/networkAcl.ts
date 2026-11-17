/**
 * Optional source-address allowlist for the `/mcp` endpoint
 * (`NOAH_MCP_ALLOWED_CIDRS`, docs/architecture/pi-runtime.md "The `/mcp`
 * endpoint"). The per-run bearer token stays the endpoint's auth; this only
 * narrows WHO may present one, for deployments where Noah's listener is
 * reachable from more than the pi-gateway broker's network. Unset = open (the
 * token alone), which is why the operator docs require binding or firewalling
 * the port instead.
 *
 * Matches the TCP PEER address (`req.socket.remoteAddress`), never
 * `X-Forwarded-For` — also not behind a trusted reverse proxy
 * (`NOAH_TRUSTED_PROXY_CIDRS`, trustedProxies.ts): the broker connects to Noah
 * directly, and a forwarded header is caller-controlled.
 */
import { parseCidrAllowlist, type CidrAllowlist } from "../cidrAllowlist.js";

export type McpNetworkAcl = CidrAllowlist;

/**
 * Parse `NOAH_MCP_ALLOWED_CIDRS` (`parseCidrAllowlist`). Null for an empty
 * value; throws on an invalid entry so a typo fails the boot instead of
 * silently opening or closing the endpoint.
 */
export function parseMcpNetworkAcl(raw: string | undefined): McpNetworkAcl | null {
  return parseCidrAllowlist(raw, "NOAH_MCP_ALLOWED_CIDRS");
}
