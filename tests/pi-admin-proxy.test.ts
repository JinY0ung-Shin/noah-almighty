import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { PI_ADMIN_PROXY_TIMEOUTS } from "../src/server/routes/piAdminProxy.js";
import { piPanelUserName } from "../src/server/routes/admin.js";
import { piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { piUserKey } from "../src/server/agent/pi/piWorkspace.js";
import { KeycloakRefusedError, KeycloakUnavailableError, setKeycloakClientForTests, type KeycloakClient } from "../src/server/keycloak.js";
import { personAccessTokenFor } from "../src/server/keycloakPersonToken.js";
import logger from "../src/server/logger.js";
import { signup, withTempDir } from "./helpers.js";

// Covers src/server/routes/piAdminProxy.ts (pi-gateway's admin panel at /admin
// behind Noah's admin session; the bearer pi sees is the admin's own Keycloak
// token when their session began there, pi's admin key otherwise) and the
// PI_GATEWAY_ADMIN_API_KEY_FILE loader in config.ts. pi is a local fake.

let tempDir: string;
const getTempDir = withTempDir("pi-admin-proxy", () => {
  tempDir = getTempDir();
});

const ADMIN_KEY = "pi-admin-key-123";
const PI_CSP = "default-src 'self'; frame-ancestors 'none'";
/** pi's page document, as its build writes it (a head, the app root, one module script). */
const PI_PAGE = `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <title>pi-gateway 관리</title>
    <script type="module" crossorigin src="/admin/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;
/** What Noah adds before pi's `</head>` (routes/piAdminProxy.ts). */
const NOAH_ADDITION = '<link rel="stylesheet" href="/pi-admin-names.css"><script src="/pi-admin-names.js" defer></script>';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

let pi: http.Server;
let piUrl: string;
let seen: Seen[];

beforeEach(async () => {
  seen = [];
  pi = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/admin/" || req.url === "/admin") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": PI_CSP });
        res.end("<!doctype html><title>pi</title>");
        return;
      }
      if (req.url?.startsWith("/admin/api/session")) {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "pi_admin=abc; Path=/admin; HttpOnly",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ authenticated: true }));
        return;
      }
      if (req.url?.split("?")[0] === "/admin/api/echo") {
        res.writeHead(201, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      }
      if (req.url === "/admin/api/llm?ok=1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ configured: true }));
        return;
      }
      if (req.url?.split("?")[0] === "/admin/api/slow") {
        const ms = Number(new URL(req.url, "http://pi").searchParams.get("ms") ?? "0");
        setTimeout(() => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ done: true }));
        }, ms);
        return;
      }
      const typed: Record<string, string> = {
        "/admin/api/typed/js": "text/javascript; charset=utf-8",
        "/admin/api/typed/css": "text/css",
        "/admin/api/typed/html": "text/html",
        "/admin/api/typed/png": "image/png",
        "/admin/api/typed/text": "text/plain; charset=utf-8",
        "/admin/assets/app.js": "text/javascript",
      };
      const type = typed[req.url?.split("?")[0] ?? ""];
      if (type) {
        res.writeHead(200, { "content-type": type });
        res.end("alert(1)");
        return;
      }
      // pi's page document in other shapes (see "adds the names of pi's users…").
      const pages: Record<string, { headers: Record<string, string>; body: string | Buffer }> = {
        "/admin/page": {
          headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": PI_CSP, "cache-control": "no-cache", etag: '"pi-1"' },
          body: PI_PAGE,
        },
        "/admin/page-upper": { headers: { "content-type": "Text/HTML" }, body: "<HTML><HEAD><TITLE>pi</TITLE></HEAD ><BODY>한글</BODY></HTML>" },
        "/admin/page-gzip": { headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" }, body: zlib.gzipSync(PI_PAGE) },
        "/admin/page-latin": { headers: { "content-type": "text/html; charset=iso-8859-1" }, body: PI_PAGE },
        "/admin/page-big": { headers: { "content-type": "text/html; charset=utf-8" }, body: `${"<!-- x -->".repeat(110_000)}${PI_PAGE}` },
        "/admin/api/page": { headers: { "content-type": "text/html; charset=utf-8" }, body: PI_PAGE },
        // Spellings pi's router would still take for the API (case, a doubled slash, an encoded letter).
        "/admin/API/page": { headers: { "content-type": "text/html; charset=utf-8" }, body: PI_PAGE },
        "/admin//api/page": { headers: { "content-type": "text/html; charset=utf-8" }, body: PI_PAGE },
        "/admin/%61pi/page": { headers: { "content-type": "text/html; charset=utf-8" }, body: PI_PAGE },
        // A declared length (pi's own page is sent this way), and bytes that are not valid UTF-8.
        "/admin/page-length": { headers: { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(PI_PAGE)) }, body: PI_PAGE },
        "/admin/page-bytes": { headers: { "content-type": "text/html" }, body: Buffer.concat([Buffer.from("<head>"), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from("</head><body>x")]) },
      };
      const page = pages[req.url?.split("?")[0] ?? ""];
      if (page) {
        res.writeHead(req.url === "/admin/page?status=503" ? 503 : 200, page.headers);
        res.end(page.body);
        return;
      }
      if (req.url === "/admin/api/typed/none") {
        res.writeHead(200);
        res.end("alert(1)");
        return;
      }
      if (req.url === "/admin/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.end("data: two\n\n"), 20);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
    });
  });
  await new Promise<void>((resolve) => pi.listen(0, "127.0.0.1", resolve));
  piUrl = `http://127.0.0.1:${(pi.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => pi.close(() => resolve()));
});

function boot(
  pi: { gatewayUrl: string; adminApiKey?: string } | null,
  label = "app",
): { services: AppServices; app: ReturnType<typeof createApp> } {
  const services = createServices({
    dataDir: path.join(tempDir, label),
    agentRuntime: "local",
    sessionSecret: "test",
    ...(pi ? { pi: { apiKey: "service-key", deckSandbox: false, ...pi } } : {}),
  });
  return { services, app: createApp(services) };
}

/** The admin's ("boss", see users()) session cookie, from a fresh login. */
async function adminCookie(app: ReturnType<typeof createApp>): Promise<string[]> {
  const res = await request(app).post("/api/auth/login").send({ username: "boss", password: "password123" });
  const set = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(";")[0]);
}

/** One request with the target sent byte for byte (HTTP client libraries normalize paths). */
async function rawRequest(
  app: ReturnType<typeof createApp>,
  method: string,
  target: string,
  headers: Record<string, string>,
): Promise<number> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path: target, headers });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** One GET with the target sent byte for byte: the answer's content type and body. */
async function rawBody(app: ReturnType<typeof createApp>, target: string, headers: Record<string, string>): Promise<{ type: string; body: string }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target, headers });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function users(app: ReturnType<typeof createApp>) {
  const admin = request.agent(app);
  await signup(admin, "boss").expect(201); // the first signup is the admin
  const member = request.agent(app);
  await signup(member, "member").expect(201);
  return { admin, member };
}

describe("pi admin panel proxy (/admin)", () => {
  it("never forwards for an anonymous or non-admin caller", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { member } = await users(app);

    const anonPage = await request(app).get("/admin/").expect(302);
    expect(anonPage.headers.location).toBe("/");
    // Never 401: pi's UI would answer it with its own key login form.
    const anonApi = await request(app).get("/admin/api/session").expect(403);
    expect(anonApi.body.error.code).toBe("noah_session_required");

    const memberPage = await member.get("/admin/").expect(302);
    expect(memberPage.headers.location).toBe("/");
    const memberApi = await member.get("/admin/api/session").expect(403);
    expect(memberApi.body.error.code).toBe("forbidden");
    await member.post("/admin/api/echo").set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send("x").expect(403);

    expect(seen).toHaveLength(0);
  });

  it("forwards an admin's GET with pi's admin key, without Noah's cookie, and drops pi's Set-Cookie", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);

    const res = await admin
      .get("/admin/api/session?x=1")
      .set("Authorization", "Bearer client-supplied")
      .set("X-Forwarded-For", "6.6.6.6")
      .expect(200);
    expect(res.body).toEqual({ authenticated: true });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/admin/api/session?x=1");
    expect(seen[0].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers["x-forwarded-for"]).toBeUndefined();
  });

  it("serves pi's UI with pi's own CSP, not Noah's", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const res = await admin.get("/admin/").expect(200);
    expect(res.text).toContain("<title>pi</title>");
    expect(res.headers["content-security-policy"]).toBe(PI_CSP);
    // Noah's pages keep Noah's CSP.
    const noah = await admin.get("/api/me");
    expect(noah.headers["content-security-policy"]).toContain("object-src 'none'");
  });

  it("adds the names of pi's users to pi's page DOCUMENT — two tags before </head>, nothing else changed", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const res = await admin.get("/admin/page").set("accept-encoding", "gzip, br").expect(200);
    // pi's document, byte for byte, with Noah's two tags right before its </head>.
    expect(res.text).toBe(PI_PAGE.replace("  </head>", `  ${NOAH_ADDITION}</head>`));
    expect(res.text.split(NOAH_ADDITION)).toHaveLength(2);
    expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.text, "utf8"));
    // pi's own headers still decide what the page may do; the validator of pi's bytes is gone.
    expect(res.headers["content-security-policy"]).toBe(PI_CSP);
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers.etag).toBeUndefined();
    // A page load (it asks for HTML) is asked for uncompressed, so the document can be read…
    await admin.get("/admin/page").set("accept", "text/html,application/xhtml+xml").set("accept-encoding", "gzip, br").expect(200);
    expect(seen.at(-1)!.headers["accept-encoding"]).toBeUndefined();
    // …an asset and an API call keep the browser's own header.
    await admin.get("/admin/assets/app.js").set("accept", "*/*").set("accept-encoding", "gzip").expect(200);
    expect(seen.at(-1)!.headers["accept-encoding"]).toBe("gzip");
    await admin.get("/admin/api/session").set("accept", "text/html").set("accept-encoding", "gzip").expect(200);
    expect(seen.at(-1)!.headers["accept-encoding"]).toBe("gzip");

    // pi declared a length: the answer carries the new one, whole.
    const sized = await admin.get("/admin/page-length").expect(200);
    expect(sized.text).toBe(PI_PAGE.replace("  </head>", `  ${NOAH_ADDITION}</head>`));
    expect(Number(sized.headers["content-length"])).toBe(Buffer.byteLength(sized.text, "utf8"));
    // pi's bytes are never decoded and re-encoded: what is not valid UTF-8 comes out as it went in.
    const bytes = await admin.get("/admin/page-bytes").buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect((bytes.body as Buffer).equals(Buffer.concat([Buffer.from("<head>"), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from(`${NOAH_ADDITION}</head><body>x`)]))).toBe(true);

    // Any spelling of the closing tag and the content type.
    const upper = await admin.get("/admin/page-upper").expect(200);
    expect(upper.text).toBe(`<HTML><HEAD><TITLE>pi</TITLE>${NOAH_ADDITION}</HEAD ><BODY>한글</BODY></HTML>`);

    // Left exactly as pi sent it: a document without a head, one Noah cannot read as UTF-8 text,
    // one far larger than pi's page, an error page, and everything that is not the page document.
    expect((await admin.get("/admin/").expect(200)).text).toBe("<!doctype html><title>pi</title>");
    for (const untouched of ["/admin/page-latin", "/admin/page-big", "/admin/page?status=503"]) {
      const kept = await admin.get(untouched);
      expect(kept.text, untouched).not.toContain("pi-admin-names");
      expect(kept.text, untouched).toContain("</head>");
    }
    expect((await admin.get("/admin/page-big").expect(200)).text).toHaveLength(110_000 * 10 + PI_PAGE.length);
    // Compressed bytes are relayed as they are (the client inflates them): still pi's page, nothing added.
    const gzip = await admin.get("/admin/page-gzip").expect(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(gzip.text).toBe(PI_PAGE);
    const script = await admin.get("/admin/assets/app.js").expect(200);
    expect(script.text).toBe("alert(1)");
    // An API answer is never a page: not added to, and not relayed as HTML either.
    const api = await admin.get("/admin/api/page").buffer(true).parse((r, done) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(api.headers["content-type"]).toBe("application/octet-stream");
    expect((api.body as Buffer).toString("utf8")).toBe(PI_PAGE);
    // …in every spelling pi's router would take for the API.
    for (const spelling of ["/admin/API/page", "/admin//api/page", "/admin/%61pi/page"]) {
      const status = await rawBody(app, spelling, { cookie: (await adminCookie(app)).join("; ") });
      expect(status.body, spelling).toBe(PI_PAGE);
      expect(status.type, spelling).toBe("application/octet-stream");
    }
    // A HEAD of the page has no body to add to.
    await admin.head("/admin/page").expect(200);
  });

  it("tells pi's page who its user ids are — admins only, the shown name and the login name", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin, member } = await users(app);
    const boss = services.store.getUserByUsername("boss")!;
    const other = services.store.getUserByUsername("member")!;
    services.store.updateProfile(other.id, { displayName: "김민수" });
    const res = await admin.get("/api/admin/pi-user-names").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const byId = new Map((res.body.users as { id: string; name: string }[]).map((user) => [user.id, user]));
    // The login name leads: it is the one part of the label its owner cannot choose.
    expect(byId.get(other.id)).toEqual({ id: other.id, key: piUserKey(other.id), name: "@member 김민수" });
    expect(piUserKey(other.id)).toMatch(/^u-[0-9a-f]{24}$/);
    // Exactly the id, pi's sandbox key for it and the name: nothing else of the account.
    expect(Object.keys(byId.get(boss.id)!).sort()).toEqual(["id", "key", "name"]);
    expect(byId.get(boss.id)!.name.startsWith("@boss")).toBe(true);
    await member.get("/api/admin/pi-user-names").expect(403);
    await request(app).get("/api/admin/pi-user-names").expect(401);

    // A shown name is free text: one written to look like someone else's label stays behind the real login
    // name and is cut, and what could reorder or break the line is dropped.
    expect(piPanelUserName("minsu", "minsu")).toBe("@minsu");
    expect(piPanelUserName("minsu", "")).toBe("@minsu");
    expect(piPanelUserName("minsu", null)).toBe("@minsu");
    const spoof = piPanelUserName("mallory", `김영희 (@younghee) · 1111-2222 ${"x".repeat(200)}`);
    expect(spoof.startsWith("@mallory 김영희 (@younghee)")).toBe(true);
    expect([...spoof]).toHaveLength("@mallory ".length + 40 + 1);
    expect(spoof.endsWith("…")).toBe(true);
    expect(piPanelUserName("minsu", "김\u202e민\u0000수\n\t 님")).toBe("@minsu 김 민 수 님");
    // Cut by code point, never through a surrogate pair.
    expect(piPanelUserName("minsu", "😀".repeat(60))).toBe(`@minsu ${"😀".repeat(40)}…`);
  });

  it("refuses a cross-origin or header-less mutating call, forwards a same-origin one intact and audits it", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);

    await admin.post("/admin/api/echo").set("Sec-Fetch-Site", "cross-site").set("X-Admin-Request", "1").send("x").expect(403);
    await admin.post("/admin/api/echo").set("Host", "noah.test").set("Origin", "http://evil.test").set("X-Admin-Request", "1").send("x").expect(403);
    await admin.post("/admin/api/echo").set("X-Admin-Request", "1").send("x").expect(403); // no Origin, no Sec-Fetch-Site
    await admin.post("/admin/api/echo").set("Sec-Fetch-Site", "same-origin").send("x").expect(403); // no X-Admin-Request
    expect(seen).toHaveLength(0);

    // A body larger than anything the JSON parser would leave intact streams through byte for byte.
    const payload = JSON.stringify({ blob: "a".repeat(1_000_000) });
    const res = await admin
      .post("/admin/api/echo?secret=q")
      .set("Host", "noah.test")
      .set("Origin", "https://noah.test")
      .set("X-Admin-Request", "1")
      .set("Content-Type", "application/json")
      .send(payload)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(201);
    expect((res.body as Buffer).toString()).toBe(payload);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(seen[0].headers["x-admin-request"]).toBe("1");

    const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
    const rows = services.store.listAudit(adminId, true).filter((row) => row.action === "pi_admin_proxy");
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toBe("POST /admin/api/echo");
  });

  it("relays a streamed (SSE) response", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const res = await admin.get("/admin/api/stream").expect(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toBe("data: one\n\ndata: two\n\n");
  });

  it("answers pi's login/logout itself (bearer needs no pi session) and never takes a typed key", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const login = await admin
      .post("/admin/api/login")
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-Admin-Request", "1")
      .send({ apiKey: "typed" })
      .expect(400);
    expect(login.body.error.code).toBe("noah_proxied");
    const logout = await admin.post("/admin/api/logout").set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").expect(200);
    expect(logout.body).toEqual({ ok: true });
    expect(seen).toHaveLength(0);
  });

  it("forwards only pi's /admin tree on pi's own origin (dot segments, encoded slashes, case, absolute-form)", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    await users(app);
    // Raw requests: an HTTP client library would normalize the dot segments away.
    const cookie = (await adminCookie(app)).join("; ");
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const rawGet = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target, headers: { cookie } });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await rawGet("/admin/api/session")).toBe(200); // the control: this one IS forwarded
      expect(seen).toHaveLength(1);
      for (const target of [
        "/admin/../v1/models",
        "/admin/%2e%2e/v1/models",
        "/admin/api/%2E%2E/%2e%2e/v1/models",
        "/admin/api/..%2fv1",
        "/admin/./api/session",
        "/ADMIN/api/session",
        "/Admin/",
        // Absolute-form target: Express routes it by its path, but the key must
        // never follow it to another host.
        "http://evil.example/admin/api/session",
        `${piUrl}/admin/api/session`,
      ]) {
        const status = await rawGet(target);
        if (status !== 404) throw new Error(`${target} was answered ${status}`);
      }
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("audits an admin's reads of one user's pi data (history, sandbox files)", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    await admin.get("/admin/api/history/resp_123");
    await admin.get("/admin/api/chat/file?user=u-alice&path=%2Fworkspace%2Fsecret.txt");
    await admin.get("/admin/api/history/retention");
    await admin.get("/admin/api/session");
    const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
    const details = services.store
      .listAudit(adminId, true)
      .filter((row) => row.action === "pi_admin_proxy")
      .map((row) => row.detail)
      .sort();
    expect(details).toEqual(["GET /admin/api/chat/file (user=u-alice)", "GET /admin/api/history/resp_123"]);
  });

  it("audits every API read except pi's config/global ones, and names the user a call acts as (query or chat body)", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const write = (url: string) => admin.post(url).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1");
    const chatBody = JSON.stringify({ user: "u-alice", input: "ls ~", stream: true });
    await write("/admin/api/chat").set("Content-Type", "application/json").send(chatBody);
    await write("/admin/api/chat/preview").set("Content-Type", "application/json").send({ user: "u-dave" });
    await write("/admin/api/chat/resp_1/cancel?user=u-bob").send();
    await admin.get("/admin/api/history?user=u-carol");
    await admin.get("/admin/api/requests");
    await admin.get("/admin/api/something-pi-adds-later");
    for (const read of ["status", "llm", "tools", "mcp/servers", "prompts", "prompts/noah", "plugins", "chat/options", "session"]) {
      await admin.get(`/admin/api/${read}`);
    }
    // The buffered chat body reaches pi byte for byte, with a correct length.
    const chat = seen.find((r) => r.url === "/admin/api/chat")!;
    expect(chat.body.toString()).toBe(chatBody);
    expect(chat.headers["content-length"]).toBe(String(Buffer.byteLength(chatBody)));

    const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
    const details = services.store
      .listAudit(adminId, true)
      .filter((row) => row.action === "pi_admin_proxy")
      .map((row) => row.detail)
      .sort();
    expect(details).toEqual([
      "GET /admin/api/history (user=u-carol)",
      "GET /admin/api/requests",
      "GET /admin/api/something-pi-adds-later",
      "POST /admin/api/chat (user=u-alice)",
      "POST /admin/api/chat/preview (user=u-dave)",
      "POST /admin/api/chat/resp_1/cancel (user=u-bob)",
    ]);
  });

  it("refuses a buffered chat body over pi's own limit without forwarding it", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const res = await admin
      .post("/admin/api/chat")
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-Admin-Request", "1")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ user: "u-a", input: "x".repeat(16 * 1024 * 1024) }))
      .catch((error: { response?: request.Response }) => error.response!);
    if (res) expect(res.status).toBe(413);
    expect(seen.filter((r) => r.url === "/admin/api/chat")).toHaveLength(0);
  });

  it("drops Noah's cached model list after pi's LLM settings change, and only then", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const invalidate = vi.spyOn(piServicesFor(services.store, services.config).models, "invalidate");
    const write = (method: "put" | "post", url: string) =>
      admin[method](url).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send("{}");
    await write("post", "/admin/api/llm/test"); // a test changes nothing
    await write("put", "/admin/api/llm"); // the fake pi answers 404: nothing was saved
    expect(invalidate).not.toHaveBeenCalled();
    await write("put", "/admin/api/echo-llm");
    expect(invalidate).not.toHaveBeenCalled();
    await write("put", "/admin/api/llm?ok=1");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("says so in Korean when no admin key is configured, or pi is unreachable", async () => {
    const { app } = boot({ gatewayUrl: piUrl });
    const { admin } = await users(app);
    const page = await admin.get("/admin/").expect(503);
    expect(page.text).toContain("관리자 키가 설정되어 있지 않습니다");
    const api = await admin.get("/admin/api/session").expect(503);
    expect(api.body.error.code).toBe("noah_admin_key_missing");
    expect(seen).toHaveLength(0);

    await new Promise<void>((resolve) => pi.close(() => resolve()));
    const down = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY }, "down");
    const { admin: admin2 } = await users(down.app);
    const res = await admin2.get("/admin/api/session").expect(502);
    expect(res.body.error.message).toContain("pi-gateway에 연결할 수 없습니다");
    pi.listen(0); // afterEach closes it again
  });

  it("refuses an API request that did not come from pi's page: cross-site, or rendered in Noah's SPA (an <img> or link)", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    const file = "/admin/api/chat/file?user=u-x1&path=%2Fworkspace%2Fa";
    // A markdown image in an avatar intro: same-origin, but Noah's SPA names itself as the referrer.
    await admin.get(file).set("Host", "noah.test").set("Sec-Fetch-Site", "same-origin").set("Referer", "https://noah.test/").expect(403);
    // Plain HTTP (no fetch metadata): the referrer alone still gives it away.
    await admin.get(file).set("Host", "noah.test").set("Referer", "http://noah.test/#/explore").expect(403);
    // A link or image on another site.
    await admin.get(file).set("Sec-Fetch-Site", "cross-site").expect(403);
    await admin.get(file).set("Sec-Fetch-Site", "same-site").expect(403);
    await admin.get(file).set("Host", "noah.test").set("Referer", "https://evil.test/admin/x").expect(403);
    await admin.get("/admin/api/history/resp_1").set("Sec-Fetch-Site", "cross-site").expect(403);
    // An encoded spelling of /admin/api is still the API.
    const cookie = (await adminCookie(app)).join("; ");
    expect(await rawRequest(app, "GET", "/admin/%61pi/chat/file?user=u-x1", { cookie, referer: "http://127.0.0.1/" })).toBe(403);
    expect(seen).toHaveLength(0);

    // pi's own page: no referrer (no-referrer), same-origin metadata — or none at all.
    await admin.get(file).set("Sec-Fetch-Site", "same-origin");
    await admin.get(file);
    await admin.get(file).set("Host", "noah.test").set("Referer", "https://noah.test/admin/chat");
    expect(seen).toHaveLength(3);
    // The page itself may be opened from anywhere: it only loads pi's UI.
    await admin.get("/admin/").set("Sec-Fetch-Site", "cross-site").expect(200);
  });

  it("decides on the path pi routes: an encoded spelling neither skips the audit nor reaches pi's login", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    await users(app);
    const cookie = (await adminCookie(app)).join("; ");
    await rawRequest(app, "GET", "/admin/api/chat/%66ile?user=u-alice&path=%2Fworkspace%2Fs.txt", { cookie });
    await rawRequest(app, "GET", "/admin/api/%68istory/resp_9", { cookie });
    await rawRequest(app, "HEAD", "/admin/api/history/resp_8", { cookie });
    await rawRequest(app, "GET", "/admin/api//history/resp_7/", { cookie });
    const before = seen.length;
    const write = { cookie, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
    expect(await rawRequest(app, "POST", "/admin/api/%6cogin", write)).toBe(400);
    expect(await rawRequest(app, "POST", "/admin/api/logout/", write)).toBe(200);
    expect(seen.length).toBe(before);

    const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
    const details = services.store
      .listAudit(adminId, true)
      .filter((row) => row.action === "pi_admin_proxy")
      .map((row) => row.detail)
      .sort();
    expect(details).toEqual([
      "GET /admin/api//history/resp_7/",
      "GET /admin/api/chat/file (user=u-alice)",
      "GET /admin/api/history/resp_9",
      "HEAD /admin/api/history/resp_8",
    ]);
  });

  it("relays only inert content types on API responses, always with nosniff; pi's page assets keep theirs", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    for (const kind of ["js", "css", "html", "none"]) {
      const res = await admin.get(`/admin/api/typed/${kind}`).expect(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
    expect((await admin.get("/admin/api/typed/png")).headers["content-type"]).toBe("image/png");
    expect((await admin.get("/admin/api/typed/text")).headers["content-type"]).toBe("text/plain; charset=utf-8");
    const session = await admin.get("/admin/api/session").expect(200);
    expect(session.headers["content-type"]).toBe("application/json");
    expect(session.headers["x-content-type-options"]).toBe("nosniff");
    expect((await admin.get("/admin/assets/app.js")).headers["content-type"]).toBe("text/javascript");
  });

  describe("upstream timeouts", () => {
    const saved = { ...PI_ADMIN_PROXY_TIMEOUTS };
    afterEach(() => Object.assign(PI_ADMIN_PROXY_TIMEOUTS, saved));

    it("gives a write far longer than a read, and records a timed-out write as unknown, not failed", async () => {
      Object.assign(PI_ADMIN_PROXY_TIMEOUTS, { readMs: 100, writeMs: 2_000 });
      const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
      const { admin } = await users(app);
      const write = (ms: number) =>
        admin.post(`/admin/api/slow?ms=${ms}`).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send("{}");

      // A slow write (a plugin install) outlasts the read timeout and reports pi's real outcome.
      expect((await write(300)).status).toBe(201);
      const read = await admin.get("/admin/api/slow?ms=300").expect(504);
      expect(read.body.error.code).toBe("upstream_timeout");

      Object.assign(PI_ADMIN_PROXY_TIMEOUTS, { writeMs: 100 });
      const timedOut = await write(300).expect(504);
      expect(timedOut.body.error.message).toContain("반영됐을 수 있으니");
      const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
      const details = services.store
        .listAudit(adminId, true)
        .filter((row) => row.action === "pi_admin_proxy")
        .map((row) => row.detail);
      expect(details).toContain("POST /admin/api/slow — 응답 시간 초과(반영 여부 미확인)");
    });
  });

  it("keeps serving when the audit write throws (it runs outside Express, where a throw would stop Noah)", async () => {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    services.store.audit = () => {
      throw new Error("SQLITE_BUSY: database is locked");
    };
    await admin.post("/admin/api/echo").set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send("x").expect(201);
    await admin.get("/admin/api/history/resp_1").expect(404);
    await new Promise<void>((resolve) => pi.close(() => resolve()));
    await admin.get("/admin/api/history/resp_1").expect(502);
    pi.listen(0); // afterEach closes it again
  });

  it("redirects /settings/pi to /admin/ and leaves /administrator alone", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const res = await request(app).get("/settings/pi").expect(302);
    expect(res.headers.location).toBe("/admin/");
    await request(app).get("/administrator").expect((r) => expect(r.status).not.toBe(302));
    expect(seen).toHaveLength(0);
  });
});

describe("pi admin panel proxy: whose bearer pi sees", () => {
  interface FakeKeycloak {
    client: KeycloakClient;
    /** Every refresh token a refresh was asked with / a logout ended, in order. */
    asked: string[];
    ended: string[];
    /** The next refreshes fail with these, in order. */
    failures: Error[];
    /** The refresh token the next answers carry (null = Keycloak keeps the old one). */
    rotateTo: string | null;
    /** Awaited inside a refresh, after it is recorded. */
    gate: Promise<void> | null;
  }

  /** Only what the relay and the logout route use; any other call is a TypeError the test would show. */
  function fakeKeycloak(): FakeKeycloak {
    const fake: FakeKeycloak = {
      asked: [],
      ended: [],
      failures: [],
      rotateTo: null,
      gate: null,
      client: {
        async refresh(refreshToken: string) {
          fake.asked.push(refreshToken);
          await fake.gate;
          const failure = fake.failures.shift();
          if (failure) throw failure;
          return { accessToken: `kc-access-${fake.asked.length}`, refreshToken: fake.rotateTo, expiresInSeconds: 300 };
        },
        async endSession(refreshToken: string) {
          fake.ended.push(refreshToken);
        },
      } as unknown as KeycloakClient,
    };
    return fake;
  }

  /**
   * An app whose accounts exist (built-in signup), THEN gets a Keycloak — like an
   * install that turned the overlay on. `sso(...)`: a session of the admin that
   * began at Keycloak, as the callback route creates it.
   */
  async function bootWithKeycloak(label = "app") {
    const { app, services } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY }, label);
    const { admin } = await users(app);
    const keycloak = fakeKeycloak();
    setKeycloakClientForTests(services.store, keycloak.client);
    const adminId = services.store.listUsers().find((u) => u.username === "boss")!.id;
    const sso = (refreshToken = "kc-refresh-1") => {
      const token = services.store.createSession(adminId, { keycloakRefreshToken: refreshToken });
      return { token, cookie: `ac_session=${token}` };
    };
    return { app, services, admin, keycloak, adminId, sso };
  }

  /** Moves `Date.now()` forward (the store's own clock, `new Date()`, is not touched). */
  function clock() {
    let ahead = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + ahead);
    return { advance: (ms: number) => void (ahead += ms) };
  }

  /** Everything any log call was given, as one string. */
  function logLines(): () => string {
    const spies = (["debug", "info", "warn", "error"] as const).map((level) => vi.spyOn(logger, level));
    return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the admin's OWN Keycloak token when the session began at Keycloak, pi's key for a built-in session", async () => {
    const { app, services, admin, keycloak, adminId, sso } = await bootWithKeycloak();
    const { cookie } = sso();

    const res = await request(app).get("/admin/api/session?x=1").set("Cookie", cookie).set("Authorization", "Bearer client-supplied").expect(200);
    expect(res.body).toEqual({ authenticated: true });
    expect(seen[0].headers.authorization).toBe("Bearer kc-access-1");
    expect(seen[0].headers.cookie).toBeUndefined();
    // The page and its assets too: every forwarded request carries the same bearer.
    await request(app).get("/admin/").set("Cookie", cookie).expect(200);
    await request(app).get("/admin/assets/app.js").set("Cookie", cookie).expect(200);
    expect(seen.map((s) => s.headers.authorization)).toEqual(Array(3).fill("Bearer kc-access-1"));

    // The same admin on a session from the built-in login has no Keycloak token: the key, and Keycloak is not asked.
    await admin.get("/admin/api/session").expect(200);
    expect(seen[3].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
    expect(keycloak.asked).toEqual(["kc-refresh-1"]);

    // A write streams through intact after the bearer was looked up…
    const payload = JSON.stringify({ blob: "a".repeat(1_000_000) });
    const echoed = await request(app)
      .post("/admin/api/echo")
      .set("Cookie", cookie)
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-Admin-Request", "1")
      .set("Content-Type", "application/json")
      .send(payload)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => done(null, Buffer.concat(chunks)));
      })
      .expect(201);
    expect((echoed.body as Buffer).toString()).toBe(payload);
    expect(seen[4].headers.authorization).toBe("Bearer kc-access-1");
    // …and so does a buffered one (an admin chat), audited with the user it acts as.
    const chat = JSON.stringify({ user: "u-1", input: "hi" });
    await request(app)
      .post("/admin/api/chat")
      .set("Cookie", cookie)
      .set("Sec-Fetch-Site", "same-origin")
      .set("X-Admin-Request", "1")
      .set("Content-Type", "application/json")
      .send(chat)
      .expect(404);
    expect(seen[5].headers.authorization).toBe("Bearer kc-access-1");
    expect(seen[5].body.toString()).toBe(chat);
    const rows = services.store.listAudit(adminId, true).filter((row) => row.action === "pi_admin_proxy");
    expect(rows.map((row) => row.detail).sort()).toEqual(["POST /admin/api/chat (user=u-1)", "POST /admin/api/echo"]);
    expect(JSON.stringify(rows)).not.toMatch(/kc-access|kc-refresh/);
  });

  it("the gate stays Noah's: a non-admin's Keycloak session forwards nothing, and Keycloak is not asked", async () => {
    const { app, services, keycloak } = await bootWithKeycloak();
    const memberId = services.store.listUsers().find((u) => u.username === "member")!.id;
    const cookie = `ac_session=${services.store.createSession(memberId, { keycloakRefreshToken: "kc-refresh-member" })}`;
    const res = await request(app).get("/admin/api/session").set("Cookie", cookie).expect(403);
    expect(res.body.error.code).toBe("forbidden");
    expect(seen).toHaveLength(0);
    expect(keycloak.asked).toEqual([]);
  });

  it("asks Keycloak only for a request it forwards", async () => {
    const { app, keycloak, sso } = await bootWithKeycloak();
    const { cookie } = sso();
    await request(app).get("/admin/api/session").set("Cookie", cookie).set("Sec-Fetch-Site", "cross-site").expect(403);
    await request(app).post("/admin/api/login").set("Cookie", cookie).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send({}).expect(400);
    await request(app).post("/admin/api/logout").set("Cookie", cookie).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send({}).expect(200);
    expect(seen).toHaveLength(0);
    expect(keycloak.asked).toEqual([]);
  });

  it("reuses the token, refreshes it after it expires, and a logged-out session's token is never used", async () => {
    const { app, services, keycloak, sso } = await bootWithKeycloak();
    const time = clock();
    const { token, cookie } = sso();

    for (let i = 0; i < 3; i += 1) await request(app).get("/admin/api/session").set("Cookie", cookie).expect(200);
    expect(keycloak.asked).toHaveLength(1);
    expect(seen.map((s) => s.headers.authorization)).toEqual(Array(3).fill("Bearer kc-access-1"));

    // Past the token's 300 s: a new one, and the newer refresh token Keycloak handed back is the stored one.
    keycloak.rotateTo = "kc-refresh-2";
    time.advance(300_000);
    await request(app).get("/admin/api/session").set("Cookie", cookie).expect(200);
    expect(seen[3].headers.authorization).toBe("Bearer kc-access-2");
    expect(keycloak.asked).toEqual(["kc-refresh-1", "kc-refresh-1"]);
    time.advance(300_000);
    await request(app).get("/admin/api/session").set("Cookie", cookie).expect(200);
    expect(seen[4].headers.authorization).toBe("Bearer kc-access-3");
    expect(keycloak.asked[2]).toBe("kc-refresh-2");

    // Logout ends the Keycloak session with the CURRENT refresh token…
    await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(200);
    expect(keycloak.ended).toEqual(["kc-refresh-2"]);
    // …and the token still in memory (good for minutes yet) goes nowhere: not to pi, not to a caller.
    const after = await request(app).get("/admin/api/session").set("Cookie", cookie).expect(403);
    expect(after.body.error.code).toBe("noah_session_required");
    expect(seen).toHaveLength(5);
    expect(await personAccessTokenFor(services.store, services.config, token)).toBeNull();
    expect(keycloak.asked).toHaveLength(3);
  });

  it("falls back to pi's key when Keycloak refuses the refresh or does not answer", async () => {
    const { app, keycloak, sso } = await bootWithKeycloak();
    const logs = logLines();

    // The Keycloak session ended (idle too long, ended in Keycloak): 400 invalid_grant.
    const ended = sso("kc-refresh-ended");
    keycloak.failures.push(new KeycloakRefusedError(400, "invalid_grant", "Keycloak refused (token refresh: HTTP 400 invalid_grant)."));
    await request(app).get("/admin/api/session").set("Cookie", ended.cookie).expect(200);
    await request(app).get("/admin/api/session").set("Cookie", ended.cookie).expect(200);
    expect(seen.map((s) => s.headers.authorization)).toEqual(Array(2).fill(`Bearer ${ADMIN_KEY}`));
    expect(keycloak.asked).toEqual(["kc-refresh-ended"]); // not asked again per request

    const down = sso("kc-refresh-down");
    keycloak.failures.push(new KeycloakUnavailableError("Keycloak did not answer (token refresh: TimeoutError)."));
    await request(app).get("/admin/api/session").set("Cookie", down.cookie).expect(200);
    expect(seen[2].headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);

    // Both are said in the server log — without a token or the key.
    expect(logs()).toContain("invalid_grant");
    expect(logs()).toContain("Keycloak did not answer");
    expect(logs()).not.toMatch(/kc-refresh|kc-access|pi-admin-key/);
  });

  it("forwards nothing when the browser left while Keycloak was asked", async () => {
    const { app, keycloak, sso } = await bootWithKeycloak();
    const { cookie } = sso();
    let open!: () => void;
    keycloak.gate = new Promise<void>((resolve) => (open = resolve));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    try {
      const req = http.request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/admin/api/session", headers: { cookie } });
      req.on("error", () => {});
      req.end();
      await vi.waitFor(() => expect(keycloak.asked).toHaveLength(1));
      req.destroy();
      // Let the server see the closed socket before Keycloak answers.
      await new Promise((resolve) => setTimeout(resolve, 50));
      open();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(seen).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("never puts a token or the key into an error body or a log line", async () => {
    const { app, keycloak, sso } = await bootWithKeycloak();
    const logs = logLines();
    const { cookie } = sso("kc-refresh-quiet");
    keycloak.rotateTo = "kc-refresh-quiet-2";
    const bodies: string[] = [];

    // A refused request (logged), an unknown path, then pi down and pi too slow — with the person's token as the bearer.
    bodies.push((await request(app).get("/admin/api/session").set("Cookie", cookie).set("Sec-Fetch-Site", "cross-site").expect(403)).text);
    bodies.push((await request(app).get("/admin/api/nope").set("Cookie", cookie).expect(404)).text);
    expect(seen[0].headers.authorization).toBe("Bearer kc-access-1");
    const saved = { ...PI_ADMIN_PROXY_TIMEOUTS };
    try {
      PI_ADMIN_PROXY_TIMEOUTS.readMs = 30;
      const slow = await request(app).get("/admin/api/slow?ms=200").set("Cookie", cookie).expect(504);
      bodies.push(slow.text);
    } finally {
      Object.assign(PI_ADMIN_PROXY_TIMEOUTS, saved);
    }
    await new Promise<void>((resolve) => pi.close(() => resolve()));
    bodies.push((await request(app).get("/admin/api/session").set("Cookie", cookie).expect(502)).text);
    bodies.push((await request(app).get("/admin/").set("Cookie", cookie).expect(502)).text);
    pi.listen(0); // afterEach closes it again

    expect(logs()).toContain("upstream failed");
    for (const text of [...bodies, logs()]) expect(text).not.toMatch(/kc-refresh|kc-access|pi-admin-key/);
  });
});

describe("PI_GATEWAY_ADMIN_API_KEY_FILE", () => {
  function withPiEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const saved = { ...process.env };
    try {
      process.env.AGENT_RUNTIME = "pi";
      process.env.PI_GATEWAY_URL = "http://gateway:8080";
      process.env.PI_GATEWAY_API_KEY = "service";
      delete process.env.PI_GATEWAY_API_KEY_FILE;
      delete process.env.PI_GATEWAY_ADMIN_API_KEY;
      delete process.env.PI_GATEWAY_ADMIN_API_KEY_FILE;
      for (const [name, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fn();
    } finally {
      process.env = saved;
    }
  }

  it("reads the key from the file only; unset leaves the proxy off", () => {
    const keyFile = path.join(tempDir, "admin_key");
    fs.writeFileSync(keyFile, "  admin-from-file\n", { mode: 0o400 });
    withPiEnv({ PI_GATEWAY_ADMIN_API_KEY_FILE: keyFile }, () => {
      const config = loadConfig({ dataDir: tempDir });
      expect(config.pi?.adminApiKey).toBe("admin-from-file");
      expect(Object.values(process.env)).not.toContain("admin-from-file");
    });
    withPiEnv({}, () => {
      expect(loadConfig({ dataDir: tempDir }).pi?.adminApiKey).toBeUndefined();
    });
  });

  it("stops the boot on an inline key, or an unreadable, empty or multi-line file — without the key in the message", () => {
    withPiEnv({ PI_GATEWAY_ADMIN_API_KEY: "inline-secret" }, () => {
      let message = "";
      try {
        loadConfig({ dataDir: tempDir });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/PI_GATEWAY_ADMIN_API_KEY is not read.*PI_GATEWAY_ADMIN_API_KEY_FILE/);
      expect(message).not.toContain("inline-secret");
    });
    withPiEnv({ PI_GATEWAY_ADMIN_API_KEY_FILE: path.join(tempDir, "nope") }, () => {
      expect(() => loadConfig({ dataDir: tempDir })).toThrow(/cannot be read \(ENOENT\)/);
    });
    const empty = path.join(tempDir, "empty");
    fs.writeFileSync(empty, "\n");
    withPiEnv({ PI_GATEWAY_ADMIN_API_KEY_FILE: empty }, () => {
      expect(() => loadConfig({ dataDir: tempDir })).toThrow(/is empty/);
    });
    const two = path.join(tempDir, "two");
    fs.writeFileSync(two, "admin-secret\nmore\n");
    withPiEnv({ PI_GATEWAY_ADMIN_API_KEY_FILE: two }, () => {
      let message = "";
      try {
        loadConfig({ dataDir: tempDir });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/alone on one line/);
      expect(message).not.toContain("admin-secret");
    });
  });
});
