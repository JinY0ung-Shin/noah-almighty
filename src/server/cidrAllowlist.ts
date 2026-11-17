/**
 * A source-address allowlist parsed from an operator's env value: the `/mcp`
 * peer check (`NOAH_MCP_ALLOWED_CIDRS`, mcpHttp/networkAcl.ts) and the reverse
 * proxies whose forwarded headers are believed (`NOAH_TRUSTED_PROXY_CIDRS`,
 * trustedProxies.ts).
 */
import net from "node:net";

export interface CidrAllowlist {
  /** The CIDRs as configured (for logs). */
  cidrs: string[];
  allows(remoteAddress: string | undefined): boolean;
}

/**
 * Parse a comma/space separated CIDR list (`10.0.0.0/8, fd00::/8`, a bare
 * address = a single host). Null for an empty value; throws on an invalid
 * entry, naming `envName`, so a typo fails the boot instead of silently
 * widening or emptying the list.
 */
export function parseCidrAllowlist(raw: string | undefined, envName: string): CidrAllowlist | null {
  const cidrs = (raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (cidrs.length === 0) return null;
  const list = new net.BlockList();
  for (const cidr of cidrs) {
    const [address = "", prefixText] = cidr.split("/");
    const family = net.isIP(address);
    if (family === 0) throw new Error(`${envName}: '${cidr}' is not an IP address or CIDR.`);
    const max = family === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixText !== undefined && !/^\d+$/.test(prefixText))) {
      throw new Error(`${envName}: '${cidr}' has an invalid prefix length.`);
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
