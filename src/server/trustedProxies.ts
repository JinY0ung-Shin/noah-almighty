/**
 * `NOAH_TRUSTED_PROXY_CIDRS`: the reverse proxies in front of Noah whose
 * `X-Forwarded-For` / `X-Forwarded-Proto` Express may believe (its
 * `trust proxy` setting). Unset — the default — Noah believes none, and
 * `req.ip` is the TCP peer.
 *
 * Why it exists: behind a proxy every request's TCP peer is the proxy, so the
 * per-address login and signup limiters (routes/auth.ts) would count the whole
 * team as ONE address. With the proxy's address listed here `req.ip` is the
 * address the proxy saw.
 *
 * Trust is by PEER ADDRESS, never a hop count or `true`: a forwarded header is
 * caller-controlled, so it counts only when the connection itself comes from a
 * listed address. Anyone else's `X-Forwarded-For` is ignored — otherwise a
 * client could pick a fresh "address" per request and never be limited.
 * docker-compose.nginx.yml pins its nginx to one address and lists exactly
 * that one.
 *
 * NOT covered, on purpose: the `/mcp` source check keeps matching the TCP peer
 * (mcpHttp/networkAcl.ts) — pi's broker reaches Noah directly, never through
 * the proxy. The key is not `TRUST_PROXY`: that name is pi-gateway's, and
 * Noah's `.env` wins inside pi's compose file.
 */
import type { Express } from "express";
import { parseCidrAllowlist } from "./cidrAllowlist.js";

export const TRUSTED_PROXY_CIDRS_ENV = "NOAH_TRUSTED_PROXY_CIDRS";

/** The configured CIDRs (empty = trust no proxy). Throws on an invalid entry: a typo fails the boot. */
export function parseTrustedProxyCidrs(raw: string | undefined): string[] {
  return parseCidrAllowlist(raw, TRUSTED_PROXY_CIDRS_ENV)?.cidrs ?? [];
}

/** Make `app` believe forwarded headers from `cidrs` only; a no-op for an empty list. */
export function applyTrustedProxies(app: Express, cidrs: readonly string[] | undefined): void {
  const allowlist = parseCidrAllowlist((cidrs ?? []).join(","), TRUSTED_PROXY_CIDRS_ENV);
  if (!allowlist) return;
  app.set("trust proxy", (address: string) => allowlist.allows(address));
}
