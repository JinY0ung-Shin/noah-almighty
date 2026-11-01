import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
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
    const anonApi = await request(app).get("/admin/api/session").expect(401);
    expect(anonApi.body.error.code).toBe("unauthorized");

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

  it("answers pi's login/logout itself (bearer needs no pi session)", async () => {
    const { app } = boot({ gatewayUrl: piUrl, adminApiKey: ADMIN_KEY });
    const { admin } = await users(app);
    for (const p of ["/admin/api/login", "/admin/api/logout"]) {
      const res = await admin.post(p).set("Sec-Fetch-Site", "same-origin").set("X-Admin-Request", "1").send({ apiKey: "typed" }).expect(200);
      expect(res.body).toEqual({ ok: true });
    }
    expect(seen).toHaveLength(0);
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
