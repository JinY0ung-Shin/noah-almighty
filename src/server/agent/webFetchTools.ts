import { createMcpToolServer, tool } from "./mcpServer.js";
import { z } from "zod";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { WebFetchProxyState } from "../types.js";
import { text } from "./mcpTools.js";

export const WEB_FETCH_SERVER_NAME = "web";

/** Tool names the model may call, in `mcpAllowedTools` form. */
export const WEB_FETCH_TOOL_NAMES = ["mcp__web__fetch"] as const;

/**
 * Why this exists: pi has no web-fetch built-in and the sandbox has no network
 * beyond the pi operator's allowlist. This tool fetches from the APP process
 * instead: `http://` is fetched as-is (plain-HTTP intranet pages work),
 * corporate proxy env (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`) applies via
 * undici's `EnvHttpProxyAgent`, and `NODE_EXTRA_CA_CERTS` (private corporate CA)
 * is honored natively by node.
 */
export interface WebFetchToolsContext {
  /**
   * True for owner/trusted-user turns. Gates the fetch: the handler is the
   * check that sees the live caller (MCP calls never prompt), and this tool
   * can reach arbitrary intranet hosts from inside the corporate network, so a
   * non-trusted colleague must not drive it — the same line Confluence draws.
   */
  elevated: boolean;
  /** Test seam; defaults to undici fetch with the env-proxy dispatcher. */
  fetchImpl?: WebFetchImpl;
}

/** Minimal structural response shape so tests can pass plain `Response` objects. */
export interface WebFetchResponse {
  status: number;
  statusText: string;
  url?: string;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type WebFetchImpl = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<WebFetchResponse>;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
/** Byte cap on the raw response body (stream is cancelled past this). */
export const WEB_FETCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Character window per tool result; `offset` continues a longer page. */
export const WEB_FETCH_MAX_RESULT_CHARS = 20_000;
const HTTP_ERROR_RESULT_CHARS = 2_000;

const FETCH_DENIED =
  "The web fetch tool can only be used in avatar owner or trusted user conversations. " +
  "It performs network requests from inside the corporate network on the owner's behalf, so a non-trusted colleague cannot use it.";

// ---------------------------------------------------------------------------
// Proxy self-state
// ---------------------------------------------------------------------------

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
 * Deployment proxy self-state for web fetch (META-COGNITION). Single source read
 * by BOTH prompt-append (`AgentRequest.webFetchProxy`, set in `stampPromptRequest`)
 * and `describe_system` — the Confluence-style sync where a deployment-env fact
 * is derived by one helper instead of the ownerState module. Values are redacted
 * to scheme://host:port so proxy credentials never enter a prompt.
 */
export function webFetchProxyState(
  env: Record<string, string | undefined> = process.env,
): WebFetchProxyState {
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

// One process-wide dispatcher: EnvHttpProxyAgent routes each request per
// HTTP_PROXY/HTTPS_PROXY/NO_PROXY (boot-time config) and dispatches directly
// when none are set. undici's OWN fetch is required — node's global fetch is a
// different bundled undici and does not accept this dispatcher.
let envProxyDispatcher: EnvHttpProxyAgent | undefined;
const defaultFetchImpl: WebFetchImpl = (url, init) => {
  envProxyDispatcher ??= new EnvHttpProxyAgent();
  return undiciFetch(url, {
    ...init,
    dispatcher: envProxyDispatcher,
  }) as unknown as Promise<WebFetchResponse>;
};

// ---------------------------------------------------------------------------
// URL guard
// ---------------------------------------------------------------------------

function ipv4Octets(hostname: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((value) => value <= 255) ? octets : null;
}

/**
 * Loopback/link-local(cloud-metadata) addresses are refused; PRIVATE ranges
 * (10.x/172.16-31/192.168) are deliberately allowed — reaching the intranet is
 * this tool's purpose. The WHATWG URL parser already canonicalizes numeric
 * hosts (`0x7f000001`/`2130706433` → `127.0.0.1`), so the dotted-quad check
 * sees the normalized form. Hostname-that-resolves-to-loopback is NOT resolved
 * here, so this guard is defense-in-depth, not a hard boundary.
 */
function blockedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
  const v4 = ipv4Octets(host);
  if (v4) {
    if (v4[0] === 127) return "loopback";
    if (v4[0] === 0) return "unspecified";
    if (v4[0] === 169 && v4[1] === 254) return "link-local / cloud metadata";
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) {
    if (bare === "::" || bare === "::1") return "loopback";
    if (/^fe[89ab]/.test(bare)) return "link-local";
    const v4mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (v4mapped) return blockedHostReason(v4mapped[1]);
  }
  return null;
}

function guardWebFetchUrl(raw: string): { ok: true; url: URL } | { ok: false; message: string } {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: `Invalid URL: ${trimmed || "(empty)"}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: `Unsupported URL scheme '${url.protocol.replace(/:$/, "")}' — only http:// and https:// can be fetched.`,
    };
  }
  const reason = blockedHostReason(url.hostname);
  if (reason) {
    return {
      ok: false,
      message:
        `The address ${url.hostname} is blocked for web fetch (${reason} address). ` +
        "Loopback and link-local/metadata addresses cannot be fetched; other intranet hosts are allowed.",
    };
  }
  return { ok: true, url };
}

// ---------------------------------------------------------------------------
// Body reading / decoding / extraction
// ---------------------------------------------------------------------------

async function readBodyCapped(
  res: WebFetchResponse,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      bytes: buf.slice(0, WEB_FETCH_MAX_RESPONSE_BYTES),
      truncated: buf.length > WEB_FETCH_MAX_RESPONSE_BYTES,
    };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let sawCap = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
    if (total >= WEB_FETCH_MAX_RESPONSE_BYTES) {
      sawCap = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const size = Math.min(total, WEB_FETCH_MAX_RESPONSE_BYTES);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const slice = chunk.subarray(0, Math.min(chunk.length, size - offset));
    joined.set(slice, offset);
    offset += slice.length;
  }
  return { bytes: joined, truncated: sawCap };
}

/** Charset from Content-Type, else an HTML `<meta charset>` sniff (KR intranets still serve euc-kr). */
function charsetOf(contentType: string, bodyPrefix: Uint8Array): string {
  const header = /charset=["']?([\w.-]+)/i.exec(contentType);
  if (header) return header[1];
  const ascii = new TextDecoder("latin1").decode(bodyPrefix.subarray(0, 2048));
  const meta = /<meta[^>]+charset=["']?([\w.-]+)/i.exec(ascii);
  return meta ? meta[1] : "utf-8";
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = charsetOf(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function mediaCategory(contentType: string): "html" | "json" | "text" | "binary" {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!mediaType) return "text";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/xml" ||
    mediaType.endsWith("+xml") ||
    mediaType === "application/javascript"
  ) {
    return "text";
  }
  return "binary";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  larr: "←",
  rarr: "→",
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Deliberately dependency-free HTML→text: the model does the comprehension, we
 * only need readable text plus navigable links (`label (absolute-url)`).
 * Entities are decoded AFTER tag-stripping so `&lt;script&gt;` can't smuggle
 * markup back in.
 */
export function extractHtmlText(html: string, baseUrl: string): { title: string; text: string } {
  let work = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(work);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";
  work = work.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
  work = work.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, hrefDouble: string | undefined, hrefSingle: string | undefined, inner: string) => {
      const href = (hrefDouble ?? hrefSingle ?? "").trim();
      if (!href || href.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(href)) {
        return inner;
      }
      let absolute: string;
      try {
        absolute = new URL(href, baseUrl).toString();
      } catch {
        return inner;
      }
      if (!/^https?:/i.test(absolute)) return inner;
      return `${inner} (${absolute})`;
    },
  );
  work = work
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(?:td|th)>/gi, "\t")
    .replace(
      /<\/?(?:p|div|section|article|main|aside|header|footer|nav|table|thead|tbody|tr|ul|ol|dl|dd|dt|blockquote|pre|h[1-6]|form|figure|figcaption)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  const textOut = decodeEntities(work)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: textOut };
}

function renderJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** undici wraps network errors as `fetch failed` with the real error in `cause`. */
function describeFetchError(error: unknown, timedOut: boolean): string {
  if (timedOut) return `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  if (error instanceof Error) {
    return error.cause instanceof Error && error.cause.message
      ? `${error.message}: ${error.cause.message}`
      : error.message;
  }
  return String(error);
}

export function buildWebFetchTools(ctx: WebFetchToolsContext) {
  const doFetch = ctx.fetchImpl ?? defaultFetchImpl;

  return [
    tool(
      "fetch",
      "Fetches a web page or resource (intranet or internet) by URL from the app server and returns its readable text. " +
        "Use it whenever the user shares a URL or asks about the content of an intranet/internet page. " +
        "Prefer this over the built-in WebFetch tool: plain http:// intranet URLs are fetched as-is (no forced HTTPS upgrade), " +
        "corporate HTTP_PROXY/HTTPS_PROXY/NO_PROXY settings apply, and the deployment's trusted CA bundle is used. " +
        "HTML is converted to text with links kept as `label (url)`; JSON is pretty-printed. " +
        `Output is windowed to ${WEB_FETCH_MAX_RESULT_CHARS} chars — pass \`offset\` to continue reading a long page. ` +
        "Loopback and link-local/metadata addresses are blocked, and a redirect to a different host is reported instead of followed. " +
        "(owner / trusted-user conversations only)",
      {
        url: z.string().describe("Absolute http:// or https:// URL to fetch (intranet or internet)."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Character offset into the extracted text, for continuing a previously truncated result (default 0).",
          ),
      },
      async (args) => {
        if (!ctx.elevated) {
          return text(FETCH_DENIED, true);
        }
        const guard = guardWebFetchUrl(args.url);
        if (!guard.ok) return text(guard.message, true);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          let current = guard.url;
          let res: WebFetchResponse | null = null;
          for (let hop = 0; ; hop++) {
            res = await doFetch(current.toString(), {
              method: "GET",
              headers: {
                Accept:
                  "text/html, application/xhtml+xml, application/json;q=0.9, text/*;q=0.8, */*;q=0.5",
                "Accept-Language": "ko, en;q=0.8",
                "User-Agent": "noah-almighty-web-fetch/1.0",
              },
              redirect: "manual",
              signal: controller.signal,
            });
            const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
            if (!location) break;
            let next: URL;
            try {
              next = new URL(location, current);
            } catch {
              return text(`The server redirected to an invalid URL: ${location}`, true);
            }
            const nextGuard = guardWebFetchUrl(next.toString());
            if (!nextGuard.ok) return text(`Redirect blocked: ${nextGuard.message}`, true);
            if (next.hostname !== current.hostname) {
              // Mirror the built-in WebFetch contract: report a cross-host hop so
              // the model re-fetches deliberately (and the guard re-runs on it).
              return text(
                `REDIRECT DETECTED: ${current} redirects to a different host: ${next}\n` +
                  "Call mcp__web__fetch again with that URL if following the redirect is expected.",
              );
            }
            await res.body?.cancel().catch(() => {});
            if (hop >= MAX_REDIRECTS) {
              return text(`Too many redirects (more than ${MAX_REDIRECTS}) fetching ${guard.url}.`, true);
            }
            current = next;
          }

          const contentType = res.headers.get("content-type") ?? "";
          const category = mediaCategory(contentType);
          const { bytes, truncated: bodyTruncated } = await readBodyCapped(res);
          if (category === "binary") {
            return text(
              `Unsupported content type '${contentType.split(";")[0].trim() || "(unknown)"}' (${bytes.length} bytes) — only HTML/JSON/text responses can be returned as text.`,
              true,
            );
          }
          const raw = decodeBody(bytes, contentType);
          let title = "";
          let bodyText: string;
          if (category === "html") {
            const extracted = extractHtmlText(raw, current.toString());
            title = extracted.title;
            bodyText = extracted.text;
          } else if (category === "json") {
            bodyText = renderJson(raw);
          } else {
            bodyText = raw;
          }

          const offset = Math.max(0, Math.floor(args.offset ?? 0));
          const slice = bodyText.slice(offset, offset + WEB_FETCH_MAX_RESULT_CHARS);
          const end = offset + slice.length;
          const finalUrl = res.url && res.url.length > 0 ? res.url : current.toString();
          const header = [
            `URL: ${finalUrl}`,
            `Status: ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
            `Content-Type: ${contentType || "(none)"}`,
            ...(title ? [`Title: ${title}`] : []),
            ...(bodyTruncated
              ? [
                  `Note: the response body exceeded ${WEB_FETCH_MAX_RESPONSE_BYTES} bytes and was cut before text extraction.`,
                ]
              : []),
            "---",
          ].join("\n");
          const tail =
            end < bodyText.length
              ? `\n\n[showing chars ${offset}–${end} of ${bodyText.length} — call again with offset=${end} to continue]`
              : offset > 0
                ? `\n\n[showing chars ${offset}–${end} of ${bodyText.length} — end of content]`
                : "";
          const rendered = `${header}\n${slice || "(empty body)"}${tail}`;
          if (res.status >= 400) {
            return text(
              `HTTP ${res.status} error response:\n${rendered.length > HTTP_ERROR_RESULT_CHARS ? `${rendered.slice(0, HTTP_ERROR_RESULT_CHARS)}\n[truncated]` : rendered}`,
              true,
            );
          }
          return text(rendered);
        } catch (error) {
          const proxy = webFetchProxyState();
          const proxyHint =
            proxy.httpProxy || proxy.httpsProxy
              ? ""
              : " (No HTTP_PROXY/HTTPS_PROXY is configured for this deployment; external internet sites may require the corporate proxy while intranet URLs are fetched directly.)";
          return text(
            `Web fetch failed for ${args.url.trim()}: ${describeFetchError(error, controller.signal.aborted)}.${proxyHint}`,
            true,
          );
        } finally {
          clearTimeout(timer);
        }
      },
    ),
  ];
}

export function buildWebFetchServer(ctx: WebFetchToolsContext) {
  return createMcpToolServer({
    name: WEB_FETCH_SERVER_NAME,
    version: "0.1.0",
    tools: buildWebFetchTools(ctx),
  });
}
