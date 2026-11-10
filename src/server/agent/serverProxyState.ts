import type { ServerProxyState } from "../types.js";

/** Strip proxy credentials: `http://user:pass@host:port` → `http://host:port`. */
function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return raw.replace(/\/\/[^@/]+@/, "//");
  }
}

/**
 * Deployment proxy self-state of Noah's OWN process (META-COGNITION): the
 * proxy env its outbound tools use (repo/git, Confluence, the MCP relays) and
 * the bootstrap-reported egress policy. Single source read by BOTH
 * prompt-append (`AgentRequest.serverProxy`, set in `stampPromptRequest`) and
 * `describe_system`. Values are redacted to scheme://host:port so proxy
 * credentials never enter a prompt. (Lived in webFetchTools.ts until the web
 * fetch tool was removed, 2026-11-10.)
 */
export function serverProxyState(
  env: Record<string, string | undefined> = process.env,
): ServerProxyState {
  const pick = (...names: string[]): string | null => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return value;
    }
    return null;
  };
  const httpProxy = pick("HTTP_PROXY", "http_proxy");
  const httpsProxy = pick("HTTPS_PROXY", "https_proxy");
  return {
    httpProxy: httpProxy ? redactProxyUrl(httpProxy) : null,
    httpsProxy: httpsProxy ? redactProxyUrl(httpsProxy) : null,
    noProxy: pick("NO_PROXY", "no_proxy"),
    ...(env.NOAH_EGRESS_POLICY === "domain-proxy"
      ? { egressPolicy: "domain-proxy" as const }
      : {}),
  };
}
