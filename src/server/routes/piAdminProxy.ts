import http from "node:http";
import https from "node:https";
import { Router, type Request, type Response } from "express";
import { sessionTokenFromRequest, type AuthenticatedRequest } from "../auth.js";
import { piServicesFor } from "../agent/pi/piRuntime.js";
import logger from "../logger.js";
import type { RouterDeps } from "./_shared.js";

/**
 * pi-gateway's own admin panel (LLM servers, models, prompts, MCP, tools,
 * history…), served on Noah's port at `/admin` — the SAME path pi uses (its UI
 * hard-codes `/admin/` and `/admin/api`, and Noah's SPA routes are `#/…` hash
 * routes, so the server path is free). Noah is the gate, and it holds pi's
 * admin key (`PiRuntimeConfig.adminApiKey`, a uid-1000 0400 file):
 *
 * - Every request needs a Noah session of an ADMIN; nothing else is forwarded.
 *   A page load without one goes to `/`; an API call gets pi's error shape.
 * - Noah's cookies and any client `Authorization` are stripped and pi's admin
 *   key is injected as `Authorization: Bearer`, so pi's own login never shows.
 *   pi skips its CSRF header check for bearer callers, so Noah does it instead:
 *   a mutating call must be same-origin (`Sec-Fetch-Site`, else `Origin`) AND
 *   carry pi's `X-Admin-Request: 1`. The ambient key also makes a GET dangerous
 *   (a user's sandbox file, another user's history, pi starting a sandbox for any
 *   id), and pi's UI loads `chat/file` through plain `<img>`/`<a download>`, so
 *   no custom header can gate GETs: EVERY `/admin/api` request must also come
 *   from pi's own UI — not cross-site (`Sec-Fetch-Site`), and no `Referer`
 *   outside `/admin` (pi's UI is `no-referrer`; Noah's SPA sends `same-origin`
 *   referrers, so a markdown image or link rendered in Noah is refused).
 * - pi's `POST /admin/api/login|logout` are answered HERE, never forwarded: a
 *   login attempt would test a typed key against pi from Noah's ONE address
 *   (pi locks an address out after failures), and logout has no pi session to end.
 * - Bodies stream both ways (pi's admin chat is SSE), pi's own security headers
 *   (CSP, X-Frame-Options) pass through — this router is mounted before Noah's
 *   header middleware and the JSON parser — and `Set-Cookie` is dropped.
 * - Only pi's `/admin` tree is reachable, and only pi's own origin: the request
 *   target must be an origin-form path under lowercase `/admin` with no dot
 *   segment (plain or percent-encoded) and no encoded slash, and the resolved
 *   upstream URL is re-checked (same origin as `PI_GATEWAY_URL`, path still under
 *   `/admin`) — an absolute-form target (`GET http://evil/admin/…`) or
 *   `/admin/../v1/…` would otherwise carry the admin key off the tree or off pi.
 * - A Noah admin is pi's admin: pi lets its admin act as ANY pi user (history,
 *   `chat/file`, an admin chat runs bash in that user's sandbox). Every forwarded
 *   mutating call, and every API read EXCEPT pi's known global/config reads
 *   (`UNAUDITED_READS` — so a read pi adds later is audited until it is listed),
 *   is audited as `pi_admin_proxy`: method + path, never the query or body —
 *   except the `user` the call acts as (the query's `user`, or the JSON body's
 *   `user` of an admin chat / preview, which is buffered for it), so the row
 *   names whose sandbox or history was touched. Every
 *   decision about the path (audit, local login/logout, API vs page) reads the
 *   path pi will ROUTE — percent-decoded, as pi's router does — never the raw one.
 * - API responses carry agent-written bytes (`chat/file` serves sandbox files
 *   under Noah's origin), so only inert content types are relayed there (JSON,
 *   SSE, plain text, images); anything else — a `.js` labelled `text/javascript`
 *   above all, which `script-src 'self'` would run — goes out as
 *   `application/octet-stream`, always with `nosniff`.
 *
 * Settings pi-setup re-applies on every `docker compose up` (Noah's prompt
 * `noah`, its MCP registrations, the disabled pi tools) are overwritten there:
 * the repo stays their source of truth.
 */

const PREFIX = "/admin";
const API_PREFIX = "/admin/api";
/**
 * How long to wait for pi's response HEADERS; a started stream (SSE) is never
 * timed out. A write gets far longer than a read: pi's own work bounds it (a
 * plugin install runs several git commands of up to 120 s EACH, an LLM/MCP test
 * waits 60 s plus setup), and cutting it short would report a failure for a
 * change pi then applies. Mutable only so tests can shorten it.
 */
export const PI_ADMIN_PROXY_TIMEOUTS = { readMs: 60_000, writeMs: 15 * 60_000 };
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Request headers never forwarded: hop-by-hop, Noah's credentials, client-claimed proxy facts. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-real-ip",
]);

/** Response headers never relayed: hop-by-hop, and pi's session cookie (bearer makes it moot). */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "trailer",
  "upgrade",
  "set-cookie",
]);

const DISABLED_PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>pi-gateway 관리</title>
<body style="font-family:sans-serif;padding:2rem"><h1>pi-gateway 관리 화면을 열 수 없습니다</h1>
<p>Noah에 pi-gateway 관리자 키가 설정되어 있지 않습니다. 배포 서버에서 <code>sudo docker/pi/setup-host.sh</code>를 다시 실행한 뒤
<code>docker compose up -d</code>로 다시 시작하세요.</p></body></html>`;

function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/**
 * The path pi will ROUTE: its router (find-my-way) percent-decodes before
 * matching, so `/admin/api/chat/%66ile` IS `chat/file` there. Each segment is
 * decoded (safeAdminTarget already proved they all decode, and refused encoded
 * slashes). Used for display (the audit row) and as the base of `matchPath`.
 */
function routedPath(rawPath: string): string {
  return rawPath
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

/**
 * `routedPath` folded for MATCHING, over-inclusively on purpose (a spelling pi
 * would not route only costs an extra audit row or a local answer): case,
 * repeated slashes, a trailing slash and a `;…` suffix are ignored.
 */
function matchPath(routed: string): string {
  const folded = routed.toLowerCase().split(";")[0].replace(/\/{2,}/g, "/");
  return folded.length > 1 && folded.endsWith("/") ? folded.slice(0, -1) : folded;
}

function underAdmin(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/**
 * The raw request target is safe to append to pi's origin: origin-form (one
 * leading `/`, so neither absolute-form nor `//host`), under lowercase `/admin`,
 * no backslash, no encoded slash/backslash, and no `.`/`..` segment in any
 * spelling. Anything else is refused before resolution.
 */
function safeAdminTarget(originalUrl: string): boolean {
  if (!originalUrl.startsWith("/") || originalUrl.startsWith("//") || originalUrl.includes("\\")) return false;
  const rawPath = originalUrl.split("?")[0];
  if (!underAdmin(rawPath)) return false;
  if (/%(2f|5c)/i.test(rawPath)) return false;
  return rawPath.split("/").every((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    return decoded !== "." && decoded !== "..";
  });
}

/**
 * pi admin API reads that show only pi's own configuration or global state, so
 * they are NOT audited (`/status` is also polled every 10 s by pi's UI). Every
 * other API read — `history`, `history/<id>`, `chat/file`, `requests`, and any
 * read pi adds later — is audited like a write: the default is audited.
 */
const UNAUDITED_READS: readonly RegExp[] = [
  /^\/session$/,
  /^\/status$/,
  /^\/llm$/,
  /^\/tools$/,
  /^\/mcp\/servers$/,
  /^\/history\/retention$/,
  /^\/marketplaces(?:\/[^/]+)?$/,
  /^\/plugins$/,
  /^\/plugins\/[^/]+\/skills\/[^/]+$/,
  /^\/plugin-settings$/,
  /^\/chat\/options$/,
  /^\/prompts(?:\/[^/]+)?$/,
  /^\/prompt-deployments$/,
];

/** An API read audited like a write (HEAD runs pi's GET handler). `pathname` is a `matchPath`. */
function auditedRead(method: string, pathname: string): boolean {
  if ((method !== "GET" && method !== "HEAD") || !isApiPath(pathname)) return false;
  const rest = pathname.slice(API_PREFIX.length);
  return !UNAUDITED_READS.some((pattern) => pattern.test(rest));
}

/** Writes whose JSON body names the pi user they act as (`user`): buffered so the audit row can say whose sandbox. */
const BODY_USER_WRITES = new Set([`${API_PREFIX}/chat`, `${API_PREFIX}/chat/preview`]);
/** pi's own body limit; a larger buffered body is refused here exactly as pi would. */
const MAX_BUFFERED_BODY_BYTES = 16 * 1024 * 1024;

function jsonBodyUser(body: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { user?: unknown }).user === "string") {
      return (parsed as { user: string }).user;
    }
  } catch {
    // pi answers the malformed body itself; the row just names no user.
  }
  return "";
}

/** pi's admin error shape, so its UI shows the message (`{ error: { code, message } }`). */
function piError(res: Response, status: number, code: string, message: string): void {
  res.status(status).setHeader("cache-control", "no-store");
  res.json({ error: { code, message } });
}

/**
 * Same-origin proof for a mutating call. `Sec-Fetch-Site` (every current
 * browser sends it) must say `same-origin`; without it, `Origin`'s host must be
 * this request's Host (the scheme is not compared: behind a TLS-terminating
 * proxy Noah sees http). Neither header → refused.
 */
function sameOrigin(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.get("origin");
  const host = req.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * An `/admin/api` request comes from pi's own UI page, not from another site or
 * from something rendered in Noah's SPA. pi's UI sends no `Referer`
 * (`no-referrer`, both its meta tag and its header) and same-origin fetch
 * metadata; Noah's SPA sends a `same-origin` referrer on every subresource, and
 * its sanitizer drops `referrerpolicy`, so an `<img>` there always names `/`.
 * Without fetch metadata (plain HTTP to a non-localhost host) only the
 * `Referer` rule applies.
 */
function fromPanel(req: Request): boolean {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const referer = req.get("referer");
  if (referer === undefined) return true;
  try {
    const url = new URL(referer);
    return url.host === req.get("host") && underAdmin(url.pathname);
  } catch {
    return false;
  }
}

/** Content types relayed as-is on an API response; anything else is `application/octet-stream`. */
const INERT_API_CONTENT_TYPE = /^\s*(?:application\/json|text\/event-stream|text\/plain|image\/[a-z0-9.+-]+)\s*(?:;|$)/i;

function forwardedRequestHeaders(req: Request, adminKey: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) continue;
    headers[lower] = value;
  }
  headers.authorization = `Bearer ${adminKey}`;
  return headers;
}

export function createPiAdminProxyRouter(deps: RouterDeps): Router {
  const { store, config, auditAs } = deps;
  const router = Router();

  // A memorable alias for the panel.
  router.get("/settings/pi", (_req, res) => {
    res.redirect(302, `${PREFIX}/`);
  });

  router.use(PREFIX, (req: AuthenticatedRequest, res) => {
    // Express matches `/admin` case-insensitively and leaves `..` in originalUrl;
    // only a plain lowercase `/admin` tree path goes any further.
    if (!safeAdminTarget(req.originalUrl)) {
      req.resume();
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }
    // What pi routes (decoded), never the raw spelling: `%66ile` must not dodge the audit.
    const routed = routedPath(req.originalUrl.split("?")[0]);
    const pathname = matchPath(routed);
    const api = isApiPath(pathname);

    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    if (!user || !user.roles.includes("admin")) {
      if (api) {
        // Never 401: pi's UI answers a 401 with its OWN key login form, which
        // cannot help here (Noah's session is what is missing) and would invite
        // pasting pi's admin key into it.
        if (user) piError(res, 403, "forbidden", "Noah 관리자만 사용할 수 있습니다.");
        else piError(res, 403, "noah_session_required", "Noah 로그인이 만료되었습니다. Noah에 관리자로 다시 로그인한 뒤 이 화면을 새로고침해 주세요.");
      } else {
        res.redirect(302, "/");
      }
      return;
    }
    req.user = user;

    const adminKey = config.pi?.adminApiKey;
    if (!config.pi || !adminKey) {
      if (api) {
        piError(res, 503, "noah_admin_key_missing", "Noah에 pi-gateway 관리자 키가 설정되어 있지 않습니다.");
      } else {
        res.status(503).type("text/html; charset=utf-8").setHeader("cache-control", "no-store");
        res.send(DISABLED_PAGE);
      }
      return;
    }

    const mutating = !SAFE_METHODS.has(req.method);
    if ((mutating && (!sameOrigin(req) || req.get("x-admin-request") !== "1")) || (api && !fromPanel(req))) {
      req.resume();
      logger.warn(
        { method: req.method, path: routed, site: req.get("sec-fetch-site") ?? null, referer: req.get("referer") !== undefined },
        "pi admin proxy: refused a request that did not come from pi's admin page",
      );
      piError(res, 403, "csrf", "다른 출처에서 온 요청은 받을 수 없습니다.");
      return;
    }

    // Answered locally (see the module comment): bearer auth needs no pi session.
    // A login form only shows when something else failed, so a typed key is
    // never accepted as if it fixed anything.
    if (req.method === "POST" && pathname === `${API_PREFIX}/login`) {
      req.resume();
      piError(
        res,
        400,
        "noah_proxied",
        "여기서는 pi 관리자 키를 입력하지 않습니다. Noah가 관리자 세션으로 대신 인증하니, Noah에 관리자로 로그인한 뒤 이 화면을 새로고침해 주세요.",
      );
      return;
    }
    if (req.method === "POST" && pathname === `${API_PREFIX}/logout`) {
      req.resume();
      res.setHeader("cache-control", "no-store");
      res.json({ ok: true });
      return;
    }

    const gatewayOrigin = new URL(config.pi.gatewayUrl).origin;
    const target = new URL(req.originalUrl, gatewayOrigin);
    if (target.origin !== gatewayOrigin || !underAdmin(target.pathname)) {
      req.resume();
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }
    const audited = mutating || auditedRead(req.method, pathname);
    // Runs inside socket listeners, outside Express: a throw here (SQLITE_BUSY
    // under a long write lock) would be an uncaughtException that stops Noah.
    const audit = (detail: string, status: "success" | "error") => {
      if (!audited) return;
      try {
        auditAs(req, "pi_admin_proxy", detail, status);
      } catch (error) {
        logger.error({ err: (error as Error).message, detail }, "pi admin proxy: audit row not written");
      }
    };

    let upstream: http.ClientRequest | null = null;
    let clientGone = false;
    // The browser went away (a cancelled chat stream): stop pi's side too.
    res.on("close", () => {
      if (!res.writableFinished) {
        if (!res.headersSent) clientGone = true;
        upstream?.destroy();
      }
    });

    /** Sends the request on to pi: the buffered `body`, or the live request stream when null. */
    const forward = (body: Buffer | null, bodyUser: string) => {
      const users = [...target.searchParams.getAll("user"), ...(bodyUser ? [bodyUser] : [])].join(",");
      const auditDetail = `${req.method} ${routed.slice(0, 256)}${users ? ` (user=${users.slice(0, 128)})` : ""}`;
      const headers = forwardedRequestHeaders(req, adminKey);
      if (body) headers["content-length"] = String(body.length);
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(target, { method: req.method, headers });
      upstream = request;
      let timedOut = false;
      request.setTimeout(mutating ? PI_ADMIN_PROXY_TIMEOUTS.writeMs : PI_ADMIN_PROXY_TIMEOUTS.readMs, () => {
        timedOut = true;
        request.destroy(new Error("pi-gateway admin response timed out"));
      });

      request.on("response", (piRes) => {
        request.setTimeout(0);
        const status = piRes.statusCode ?? 502;
        audit(auditDetail, status < 400 ? "success" : "error");
        // pi's LLM page changed the default model or a model's image input: the
        // next turn must not run on Noah's cached list for up to a minute.
        if (mutating && status < 400 && pathname === `${API_PREFIX}/llm`) piServicesFor(store, config).models.invalidate();
        res.status(status);
        for (const [name, value] of Object.entries(piRes.headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          res.setHeader(name, value);
        }
        if (api) {
          // Agent-written bytes under Noah's origin: never as script, stylesheet or page.
          const type = piRes.headers["content-type"];
          if (!type || !INERT_API_CONTENT_TYPE.test(type)) res.setHeader("content-type", "application/octet-stream");
          res.setHeader("x-content-type-options", "nosniff");
        }
        res.flushHeaders();
        piRes.pipe(res);
        piRes.on("error", () => res.destroy());
      });

      request.on("error", (error) => {
        if (clientGone) {
          // The browser left before pi answered: pi may still have applied a write,
          // so the audit row says the outcome is unknown rather than a plain failure.
          audit(`${auditDetail} — 응답 전에 연결 끊김(반영 여부 미확인)`, "error");
          return;
        }
        logger.warn({ err: error.message, path: routed }, "pi admin proxy: upstream failed");
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (timedOut) {
          // pi may still finish the work: say the outcome is unknown, not that it failed.
          audit(`${auditDetail} — 응답 시간 초과(반영 여부 미확인)`, "error");
          const message = mutating
            ? "pi-gateway가 제한 시간 안에 응답하지 않았습니다. 요청이 반영됐을 수 있으니 화면을 새로고침해 결과를 확인한 뒤 다시 시도해 주세요."
            : "pi-gateway가 제한 시간 안에 응답하지 않았습니다. 잠시 뒤 다시 시도해 주세요.";
          if (api) piError(res, 504, "upstream_timeout", message);
          else res.status(504).type("text/plain; charset=utf-8").send(message);
          return;
        }
        audit(auditDetail, "error");
        if (api) {
          piError(res, 502, "upstream_unreachable", "pi-gateway에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.");
        } else {
          res.status(502).type("text/plain; charset=utf-8").send("pi-gateway에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.");
        }
      });

      if (body) request.end(body);
      else req.pipe(request);
    };

    if (!(mutating && BODY_USER_WRITES.has(pathname))) {
      forward(null, "");
      return;
    }
    // An admin chat names the pi user it runs as in its JSON body: read it whole
    // (pi's own 16 MiB limit) so the audit row says whose sandbox ran it.
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BUFFERED_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        piError(res, 413, "request_too_large", "요청 본문이 너무 큽니다.");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge || clientGone) return;
      const body = Buffer.concat(chunks);
      forward(body, jsonBodyUser(body));
    });
    req.on("error", () => {
      // The browser went away mid-body: nothing was forwarded, so there is nothing to audit.
    });
  });

  return router;
}
