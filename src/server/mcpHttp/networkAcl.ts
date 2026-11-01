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
 * `X-Forwarded-For`: the broker connects to Noah directly, and a forwarded
 * header is caller-controlled.
 */
import net from "node:net";

export interface McpNetworkAcl {
  /** The CIDRs as configured (for logs). */
  cidrs: string[];
  allows(remoteAddress: string | undefined): boolean;
}

/**
 * Parse a comma/space separated CIDR list (`10.0.0.0/8, fd00::/8`, a bare
 * address = a single host). Null for an empty value; throws on an invalid
 * entry so a typo fails the boot instead of silently opening or closing the
 * endpoint.
 */
export function parseMcpNetworkAcl(raw: string | undefined): McpNetworkAcl | null {
  const cidrs = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (cidrs.length === 0) return null;
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address = "", prefixText] = cidr.split("/");
    const family = net.isIP(address);
    if (family === 0) throw new Error(`NOAH_MCP_ALLOWED_CIDRS: '${cidr}' is not an IP address or CIDR.`);
    const max = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixText !== undefined && !/^\d+$/.test(prefixText))) {
      throw new Error(`NOAH_MCP_ALLOWED_CIDRS: '${cidr}' has an invalid prefix length.`);
    }
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return {
    cidrs,
    allows(remoteAddress) {
      if (!remoteAddress) return false;
      // An IPv4 peer on a dual-stack socket arrives as `::ffff:a.b.c.d`.
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(remoteAddress)?.[1];
      const address = mapped ?? remoteAddress;
      const family = net.isIP(address);
      if (family === 0) return false;
      return list.check(address, family === 4 ? "ipv4" : "ipv6");
    },
  };
}
