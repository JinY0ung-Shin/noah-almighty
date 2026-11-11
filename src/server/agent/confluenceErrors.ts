/**
 * What a failed Confluence request MEANS, in agent-facing English: the cause,
 * then the ONE thing that fixes it and who can do it — so the avatar tells the
 * user "ask an operator to add the CA" instead of retrying a certificate error
 * or relaying a raw HTML login page.
 *
 * Pure text: nothing here makes a request. Every string that came from the
 * network (a response body, an error message) is cut short and passed through
 * {@link safeDetail}, so the token, an `Authorization` header or a URL's
 * credentials never reach the model.
 */

const TOKEN_FIX =
  "the avatar's owner must create a new Personal Access Token in Confluence and save it as CONFLUENCE_PAT under Settings > Permissions & Connections > Secrets (설정 → 권한·연결 → 시크릿).";
const NOT_IN_CHAT = "Retrying will not help and nothing in this chat can fix it:";
const NETWORK_SIDE = "which the user cannot fix in chat:";

const MAX_DETAIL_CHARS = 300;
const MAX_SNIPPET_CHARS = 200;
const MAX_TITLE_CHARS = 80;

// Certificate verification codes Node's TLS layer reports (undici surfaces them as `cause.code`).
const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REJECTED",
  "CERT_REVOKED",
  "INVALID_CA",
  "UNABLE_TO_GET_CRL",
]);
const TLS_DATE_CODES = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID"]);
const TLS_HOST_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME", "EAI_FAIL"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/**
 * Network text made safe and short: whitespace collapsed, the token itself, any
 * `Authorization` value / `Bearer` / `Basic` credential and a URL's userinfo
 * removed, then cut to `max`.
 */
export function safeDetail(value: string, pat: string | undefined, max = MAX_DETAIL_CHARS): string {
  let out = value.replace(/\s+/g, " ").trim();
  if (pat && pat.length >= 4) out = out.split(pat).join("[redacted]");
  out = out
    .replace(/\bauthorization\b["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?[^\s"',}]+/gi, "Authorization: [redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/gi, "$1 [redacted]")
    .replace(/\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@]{0,200}@/gi, "$1");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Codes, messages and whether the request was aborted, gathered down the `cause` / `errors` chain. */
function failureFacts(error: unknown): { codes: string[]; messages: string[]; aborted: boolean } {
  const codes: string[] = [];
  const messages: string[] = [];
  let aborted = false;
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length && seen.size < 12) {
    const item = queue.shift();
    if (typeof item === "string") {
      messages.push(item);
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const record = item as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof record.code === "string") codes.push(record.code);
    if (record.name === "AbortError" || record.name === "TimeoutError") aborted = true;
    if (typeof record.message === "string") messages.push(record.message);
    if (record.cause) queue.push(record.cause);
    if (Array.isArray(record.errors)) queue.push(...record.errors.slice(0, 4));
  }
  // A code that only appears inside a message ("connect ECONNREFUSED 10.0.0.1:443").
  for (const message of messages) {
    for (const token of message.slice(0, 2_000).match(/\b[A-Z][A-Z0-9_]{4,}\b/g) ?? []) codes.push(token);
  }
  return { codes, messages, aborted };
}

/**
 * A request that never produced a response (`fetch` rejected): certificate,
 * DNS, connection, proxy or timeout — each with who has to fix it.
 */
export function describeConfluenceFetchFailure(
  error: unknown,
  options: { pat?: string; timeoutMs: number },
): string {
  const { codes, messages, aborted } = failureFacts(error);
  const find = (known: ReadonlySet<string>) => codes.find((code) => known.has(code));
  const prefix = "Confluence request failed:";

  const trust = find(TLS_TRUST_CODES);
  if (trust) {
    return `${prefix} the Noah server does not trust the Confluence server's TLS certificate (${trust}). ${NOT_IN_CHAT} an operator must add the corporate CA to the Noah server's trusted CA bundle (NODE_EXTRA_CA_CERTS) and restart Noah.`;
  }
  const date = find(TLS_DATE_CODES);
  if (date) {
    return `${prefix} the Confluence server's TLS certificate is expired or not yet valid (${date}). ${NOT_IN_CHAT} the Confluence administrator must renew the certificate (if it is in date, an operator must correct the Noah server's clock).`;
  }
  const host = find(TLS_HOST_CODES);
  if (host) {
    return `${prefix} the Confluence server's TLS certificate does not match the host name in CONFLUENCE_URL (${host}). ${NOT_IN_CHAT} an operator must point CONFLUENCE_URL at the host name the certificate was issued for.`;
  }
  const proxy = /Proxy response \((\d{3})\)/.exec(messages.join(" "));
  if (proxy) {
    return `${prefix} the Noah server's outbound proxy refused the connection to the Confluence host (proxy answered ${proxy[1]}), so the deployment's egress policy does not allow that domain. ${NOT_IN_CHAT} a system administrator must allow the Confluence domain in the outbound policy (관리자 → 가입·접근 → 외부 통신 차단), or an operator must fix the proxy.`;
  }
  const dns = find(DNS_CODES);
  if (dns) {
    return `${prefix} the Noah server could not resolve the Confluence host name (${dns}). The host is unreachable from the Noah server (DNS, VPN or egress policy), ${NETWORK_SIDE} an operator must check CONFLUENCE_URL and the Noah server's DNS and network access to Confluence.`;
  }
  const timeout = find(TIMEOUT_CODES);
  if (timeout || aborted) {
    const label = timeout ?? `no response within ${Math.round(options.timeoutMs / 1000)} s`;
    return `${prefix} Confluence did not answer in time (${label}). Retry once; if it times out again the host is unreachable from the Noah server (network, VPN or egress policy), ${NETWORK_SIDE} an operator must check the Noah server's network path to Confluence.`;
  }
  const connect = find(CONNECT_CODES);
  if (connect) {
    return `${prefix} the Noah server could not reach the Confluence host — the connection was refused, reset or unroutable (${connect}). The host is unreachable from the Noah server (network, VPN, firewall or egress policy), ${NETWORK_SIDE} an operator must open the Noah server's network path to Confluence.`;
  }
  const tls = codes.find((code) => code === "EPROTO" || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_"));
  if (tls) {
    return `${prefix} the TLS handshake with the Confluence server failed (${tls}). ${NOT_IN_CHAT} an operator must check that CONFLUENCE_URL uses the right scheme and port and that the Noah server trusts the server's certificate.`;
  }
  const detail = safeDetail([...new Set(messages)].join(": "), options.pat, MAX_SNIPPET_CHARS) || "unknown error";
  return `${prefix} ${detail}. Retry once; if it fails the same way, an operator must check the Noah server's log and its network access to Confluence.`;
}

/** Whether a response body is an HTML page (by content type, or by how it starts). */
export function looksLikeHtml(body: string, contentType: string | null | undefined): boolean {
  if (/\b(?:text\/html|application\/xhtml)/i.test(contentType ?? "")) return true;
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body.slice(0, 1_000));
}

/** ` titled "…"` for an HTML page that has a title, else "". */
function htmlTitle(body: string, pat: string | undefined): string {
  const match = /<title[^>]{0,200}>([^<]{1,400})/i.exec(body.slice(0, 20_000));
  const title = match ? safeDetail(match[1]!, pat, MAX_TITLE_CHARS) : "";
  return title ? ` titled "${title}"` : "";
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asObject(value);
  if (!record) return "";
  // Confluence's validation errors: { message: { key, translation, args } }.
  return typeof record.translation === "string"
    ? record.translation
    : typeof record.message === "string"
      ? record.message
      : typeof record.key === "string"
        ? record.key
        : "";
}

/**
 * The human-readable part of a JSON error body — Confluence's
 * `{ statusCode, message, reason, data: { errors: [...] } }`, the Jira-style
 * `{ errorMessages: [...] }` and OAuth's `{ error, error_description }` — or ""
 * when the body is not JSON or names nothing.
 */
export function confluenceErrorDetail(body: string, pat: string | undefined): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return "";
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asObject(JSON.parse(trimmed));
  } catch {
    return "";
  }
  if (!parsed) return "";
  const found: string[] = [];
  const add = (value: unknown) => {
    const message = messageText(value).trim();
    if (message && !found.includes(message)) found.push(message);
  };
  add(parsed.message);
  if (Array.isArray(parsed.errorMessages)) parsed.errorMessages.slice(0, 5).forEach(add);
  add(parsed.error_description);
  if (typeof parsed.error === "string") add(parsed.error);
  else add(asObject(parsed.error)?.message);
  const data = asObject(parsed.data);
  if (data && Array.isArray(data.errors)) {
    for (const entry of data.errors.slice(0, 5)) add(asObject(entry)?.message ?? entry);
  }
  if (!found.length) add(parsed.reason);
  return safeDetail(found.join("; "), pat);
}

/** `Retry-After` as written by the server: seconds, or an HTTP date. */
function retryAfterText(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  if (/^\d{1,7}$/.test(raw)) return `${Number(raw)} seconds`;
  return /^[A-Za-z0-9 ,:+-]{1,40}$/.test(raw) ? raw : "";
}

/**
 * A non-2xx response. The status decides the meaning; the body only adds a
 * short quote (its JSON message, or the title of an HTML page) — never the raw
 * dump. Always starts `Confluence HTTP <status>:`.
 */
export function describeConfluenceHttpFailure(
  status: number,
  body: string,
  options: { contentType?: string | null; retryAfter?: string | null; pat?: string } = {},
): string {
  const { pat } = options;
  const html = looksLikeHtml(body, options.contentType);
  const detail = html ? "" : confluenceErrorDetail(body, pat);
  const said = detail ? ` Confluence said: "${detail}".` : "";
  const loginPage = html
    ? ` (The answer was an HTML page${htmlTitle(body, pat)}, so an SSO/login proxy may have answered instead of Confluence.)`
    : "";
  const prefix = `Confluence HTTP ${status}:`;

  if (status === 401) {
    return `${prefix} the stored Confluence token (CONFLUENCE_PAT) was not accepted — it is missing, expired or revoked.${said}${loginPage} Retrying will not help: ${TOKEN_FIX}`;
  }
  if (status === 403) {
    return `${prefix} the account behind the stored token is not allowed to do this — it lacks permission for that space or page.${said}${loginPage} Retrying will not help: a Confluence space administrator must grant that account access, or the avatar's owner must store a token of an account that has it.`;
  }
  if (status === 404) {
    return `${prefix} nothing was found there — the id or space key is wrong, or the token's account is not allowed to see it (Confluence answers 404 for both).${said}${loginPage} Check the id (mcp__confluence__search for a page, mcp__confluence__list_attachments for an attachment); if it is right, the token's account needs view permission from a Confluence space administrator. (If EVERY Confluence call answers 404, CONFLUENCE_URL is wrong and an operator must fix it.)`;
  }
  if (status === 429) {
    const wait = retryAfterText(options.retryAfter);
    return `${prefix} Confluence is rate limiting this token.${said} ${wait ? `Retry after ${wait} (Retry-After)` : "Wait about a minute before retrying"}, once — do not loop; if it is still limited, tell the user to try again later.`;
  }
  if (status === 400) {
    return `${prefix} Confluence rejected the request as invalid${detail ? `: "${detail}"` : ""}. Fix the arguments (for search: the CQL syntax, field names and quoting) and call again.`;
  }
  if (status >= 500) {
    const snippet = !detail && !html && body.trim() ? ` It answered: "${safeDetail(body, pat, MAX_SNIPPET_CHARS)}".` : "";
    const page = html ? ` It answered with an HTML error page${htmlTitle(body, pat)}.` : "";
    return `${prefix} the Confluence server (or a proxy in front of it) failed.${said}${snippet}${page} Retry once later; if it keeps failing, a Confluence administrator has to look at the server.`;
  }
  const snippet = !detail && !html && body.trim() ? ` It answered: "${safeDetail(body, pat, MAX_SNIPPET_CHARS)}".` : "";
  return `${prefix} Confluence refused the request.${said}${snippet}${loginPage} Do not retry the same call; if the arguments are right, an operator must check CONFLUENCE_URL and the Confluence server.`;
}

/**
 * A 2xx response whose body is not the JSON the REST API returns. An HTML page
 * is almost always a login page — the token was not accepted, or the base URL
 * is a login proxy — and must never be read as "no results".
 */
export function describeConfluenceNonJson(
  body: string,
  options: { contentType?: string | null; pat?: string } = {},
): string {
  if (looksLikeHtml(body, options.contentType)) {
    return `Confluence request failed: Confluence answered with an HTML page${htmlTitle(body, options.pat)} where JSON was expected — almost certainly an SSO/login page, so the token was not accepted or CONFLUENCE_URL points at a login proxy instead of the Confluence REST API. Retrying will not help: ${TOKEN_FIX} If a fresh token gets the same page, an operator must point CONFLUENCE_URL at an address that accepts token (Bearer) authentication.`;
  }
  return `Confluence request failed: the answer was not JSON (it starts "${safeDetail(body, options.pat, 80)}"), so CONFLUENCE_URL probably does not point at the Confluence REST API. Retrying will not help: an operator must check CONFLUENCE_URL.`;
}
