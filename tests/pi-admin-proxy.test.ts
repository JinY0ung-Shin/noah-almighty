import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { PI_ADMIN_PROXY_TIMEOUTS } from "../src/server/routes/piAdminProxy.js";
import { signup, withTempDir } from "./helpers.js";

// Covers src/server/routes/piAdminProxy.ts (pi-gateway's admin panel at /admin
// behind Noah's admin session, pi's admin key injected) and the
// PI_GATEWAY_ADMIN_API_KEY_FILE loader in config.ts. pi is a local fake.

let tempDir: string;
const getTempDir = withTempDir("pi-admin-proxy", () => {
  tempDir = getTempDir();
});

const ADMIN_KEY = "pi-admin-key-123";
const PI_CSP = "default-src 'self'; frame-ancestors 'none'";

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
