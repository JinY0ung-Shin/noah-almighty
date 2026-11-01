import http from "node:http";
import https from "node:https";
import { Router, type Request, type Response } from "express";
import { sessionTokenFromRequest, type AuthenticatedRequest } from "../auth.js";
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
 *   carry pi's `X-Admin-Request: 1`.
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
 *   mutating call, and every read of a user's data (`history/<id>`, `chat/file`),
 *   is audited as `pi_admin_proxy` (method + path, never the query values or body —
 *   except `chat/file`'s `user`, which names whose sandbox was read).
 *
 * Settings pi-setup re-applies on every `docker compose up` (Noah's prompt
 * `noah`, its MCP registrations, the disabled pi tools) are overwritten there:
 * the repo stays their source of truth.
 */

const PREFIX = "/admin";
const API_PREFIX = "/admin/api";
/** Wait this long for pi's response headers; a started stream (SSE) is never timed out. */
const UPSTREAM_HEADER_TIMEOUT_MS = 60_000;
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

/** pi admin reads that open ONE user's data — audited like a write. */
function readsUserData(method: string, pathname: string): boolean {
  if (method !== "GET") return false;
  if (pathname === `${API_PREFIX}/chat/file`) return true;
  return /^\/admin\/api\/history\/[^/]+$/.test(pathname) && pathname !== `${API_PREFIX}/history/retention`;
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
    const pathname = req.originalUrl.split("?")[0];
    // Express matches `/admin` case-insensitively and leaves `..` in originalUrl;
    // only a plain lowercase `/admin` tree path goes any further.
    if (!safeAdminTarget(req.originalUrl)) {
      req.resume();
      res.status(404).type("text/plain; charset=utf-8").send("Not found");
      return;
    }
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
    if (mutating && (!sameOrigin(req) || req.get("x-admin-request") !== "1")) {
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
    const audited = mutating || readsUserData(req.method, pathname);
    const userParam = pathname === `${API_PREFIX}/chat/file` ? target.searchParams.get("user") : null;
    const auditDetail = `${req.method} ${pathname}${userParam ? ` (user=${userParam.slice(0, 128)})` : ""}`;
    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(target, {
      method: req.method,
      headers: forwardedRequestHeaders(req, adminKey),
    });
    upstream.setTimeout(UPSTREAM_HEADER_TIMEOUT_MS, () => {
      upstream.destroy(new Error("pi-gateway admin response timed out"));
    });

    upstream.on("response", (piRes) => {
      upstream.setTimeout(0);
      const status = piRes.statusCode ?? 502;
      if (audited) auditAs(req, "pi_admin_proxy", auditDetail, status < 400 ? "success" : "error");
      res.status(status);
      for (const [name, value] of Object.entries(piRes.headers)) {
        if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
        res.setHeader(name, value);
      }
      res.flushHeaders();
      piRes.pipe(res);
      piRes.on("error", () => res.destroy());
    });

    let clientGone = false;
    upstream.on("error", (error) => {
      if (clientGone) {
        // The browser left before pi answered: pi may still have applied a write,
        // so the audit row says the outcome is unknown rather than a plain failure.
        if (audited) auditAs(req, "pi_admin_proxy", `${auditDetail} — 응답 전에 연결 끊김(반영 여부 미확인)`, "error");
        return;
      }
      logger.warn({ err: error.message, path: pathname }, "pi admin proxy: upstream failed");
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (audited) auditAs(req, "pi_admin_proxy", auditDetail, "error");
      if (api) {
        piError(res, 502, "upstream_unreachable", "pi-gateway에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.");
      } else {
        res.status(502).type("text/plain; charset=utf-8").send("pi-gateway에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.");
      }
    });

    // The browser went away (a cancelled chat stream): stop pi's side too.
    res.on("close", () => {
      if (!res.writableFinished) {
        if (!res.headersSent) clientGone = true;
        upstream.destroy();
      }
    });

    req.pipe(upstream);
  });

  return router;
}
