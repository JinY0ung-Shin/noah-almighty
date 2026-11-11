import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import { hashPassword, hashPasswordSync, verifyPassword } from "../src/server/auth.js";
import { SIGNUP_LIMITS } from "../src/server/routes/auth.js";
import { parseTrustedOrigins } from "../src/server/config.js";
import logger from "../src/server/logger.js";
import { createCrossSiteMutationGuard, CROSS_SITE_REFUSED_MESSAGE } from "../src/server/routes/_shared.js";
import { isReservedUsername } from "../src/server/usernamePolicy.js";
import { signup, withTempDir } from "./helpers.js";

// Server hardening at the HTTP boundary: the same-origin gate on every
// cookie-authenticated state change (routes/_shared.ts `refuseCrossSiteMutation`),
// signup hardening (reserved names, case-insensitive new names, instance-wide
// caps) and asynchronous password hashing that still verifies every stored digest.

let tempDir: string;
const getTempDir = withTempDir("auth-hardening", () => {
  tempDir = getTempDir();
});

type App = ReturnType<typeof createApp>;

function boot(): { services: AppServices; app: App } {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  return { services, app: createApp(services) };
}

/** The raw SQLite handle, for rows that predate a rule (the store API cannot create them any more). */
function dbOf(services: AppServices): Database.Database {
  return (services.store as unknown as { db: Database.Database }).db;
}

const post = (app: App, path: string) => request(app).post(path);

describe("same-origin gate on state-changing requests", () => {
  it("refuses cross-site and same-site requests the browser reports, with a Korean 403", async () => {
    const { app } = boot();
    for (const site of ["cross-site", "same-site", "CROSS-SITE", "something-new"]) {
      const res = await post(app, "/api/auth/logout").set("Sec-Fetch-Site", site).expect(403);
      expect(res.body.error).toBe(CROSS_SITE_REFUSED_MESSAGE);
    }
    expect(CROSS_SITE_REFUSED_MESSAGE).toBe("다른 사이트에서 보낸 요청은 처리할 수 없습니다. Noah 화면에서 다시 시도해 주세요.");
  });

  it("covers every mutating method and a body-less POST of a signed-in user", async () => {
    const { app, services } = boot();
    const agent = request.agent(app);
    await signup(agent, "boss").expect(201);
    // The sibling-app case SameSite=Lax does not stop: a body-less POST with the victim's cookie.
    await agent.post("/api/auth/logout").set("Sec-Fetch-Site", "same-site").expect(403);
    // The session is still alive: the refused logout never ran.
    expect((await agent.get("/api/me").expect(200)).body.user?.username).toBe("boss");
    await agent.patch("/api/me").set("Sec-Fetch-Site", "cross-site").send({ displayName: "x" }).expect(403);
    await agent.put("/api/me/chat-defaults").set("Sec-Fetch-Site", "cross-site").send({}).expect(403);
    await agent.delete("/api/me/share-links/nope").set("Sec-Fetch-Site", "cross-site").expect(403);
    expect(services.store.getUserByUsername("boss")?.displayName).toBe("boss");
    // Express matches paths case-insensitively; the gate does too.
    await agent.post("/API/auth/logout").set("Sec-Fetch-Site", "cross-site").expect(403);
  });

  it("allows same-origin, user-initiated (none) and header-less requests", async () => {
    const { app } = boot();
    await post(app, "/api/auth/logout").set("Sec-Fetch-Site", "same-origin").expect(200);
    await post(app, "/api/auth/logout").set("Sec-Fetch-Site", "none").expect(200);
    await post(app, "/api/auth/logout").expect(200); // curl, tests, non-browser clients
  });

  it("falls back to Origin only when fetch metadata is absent (plain-HTTP deployments)", async () => {
    const { app } = boot();
    // The app's own origin, by Host (the scheme is not compared; default ports fold).
    await post(app, "/api/auth/logout").set("Host", "noah.example").set("Origin", "http://noah.example").expect(200);
    await post(app, "/api/auth/logout").set("Host", "noah.example").set("Origin", "https://NOAH.example:443").expect(200);
    await post(app, "/api/auth/logout").set("Host", "noah.example:48787").set("Origin", "http://noah.example:48787").expect(200);
    // …or by the forwarded host, the way requestOrigin reads it behind the proxy.
    await post(app, "/api/auth/logout")
      .set("Host", "noah-internal:48787")
      .set("X-Forwarded-Host", "noah.example")
      .set("X-Forwarded-Proto", "https")
      .set("Origin", "https://noah.example")
      .expect(200);
    // Another origin, a sibling subdomain, another port, an opaque or unparsable origin.
    for (const origin of ["https://evil.example", "https://app.noah.example", "http://noah.example:8080", "null", "not a url", "ftp://noah.example"]) {
      const res = await post(app, "/api/auth/logout").set("Host", "noah.example").set("Origin", origin).expect(403);
      expect(res.body.error).toBe(CROSS_SITE_REFUSED_MESSAGE);
    }
  });

  it("lets Sec-Fetch-Site decide before Origin (vite dev: Origin :5173, Host :48787)", async () => {
    const { app } = boot();
    await post(app, "/api/auth/logout")
      .set("Host", "localhost:48787")
      .set("Origin", "http://localhost:5173")
      .set("Sec-Fetch-Site", "same-origin")
      .expect(200);
    // …and a matching Origin does not rescue a request the browser calls cross-site.
    await post(app, "/api/auth/logout")
      .set("Host", "noah.example")
      .set("Origin", "http://noah.example")
      .set("Sec-Fetch-Site", "cross-site")
      .expect(403);
  });

  it("never checks GET", async () => {
    const { app } = boot();
    await request(app).get("/api/me").set("Sec-Fetch-Site", "cross-site").set("Origin", "https://evil.example").expect(200);
    await request(app).get("/api/bootstrap").set("Sec-Fetch-Site", "same-site").expect(200);
  });

  it("leaves the bearer-only surfaces to their own auth", async () => {
    const { app } = boot();
    // The external task API: personal API keys only — its own 401, never the gate's 403.
    const task = await post(app, "/api/v1/avatar/tasks").set("Sec-Fetch-Site", "cross-site").send({ message: "x" });
    expect(task.status).toBe(401);
    expect(task.body.error).not.toBe(CROSS_SITE_REFUSED_MESSAGE);
    const taskCancel = await post(app, "/api/v1/avatar/tasks/abc/cancel").set("Origin", "https://evil.example");
    expect(taskCancel.status).not.toBe(403);
    // /mcp is mounted ahead of the gate with per-run bearer auth.
    const mcp = await post(app, "/mcp/system").set("Sec-Fetch-Site", "cross-site").send({});
    expect(mcp.status).toBe(401);
  });

  it("skips a bearer request without a session cookie, but not one that also carries the cookie", async () => {
    const { app } = boot();
    // No cookie: nothing ambient rides the request, so the route's own auth answers (401).
    const bare = await post(app, "/api/me/avatar-api-keys")
      .set("Authorization", "Bearer some-token")
      .set("Sec-Fetch-Site", "cross-site")
      .send({});
    expect(bare.status).toBe(401);
    const agent = request.agent(app);
    await signup(agent, "boss").expect(201);
    const withCookie = await agent
      .post("/api/me/avatar-api-keys")
      .set("Authorization", "Bearer some-token")
      .set("Sec-Fetch-Site", "cross-site")
      .send({});
    expect(withCookie.status).toBe(403);
    expect(withCookie.body.error).toBe(CROSS_SITE_REFUSED_MESSAGE);
  });

  it("checks login and signup too (login CSRF)", async () => {
    const { app } = boot();
    await post(app, "/api/auth/signup")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ username: "boss", displayName: "Boss", password: "password123" })
      .expect(403);
    await post(app, "/api/auth/login").set("Sec-Fetch-Site", "same-site").send({ username: "boss", password: "password123" }).expect(403);
  });
});

describe("TRUSTED_ORIGINS — the operator's recovery for the same-origin gate", () => {
  const original = process.env.TRUSTED_ORIGINS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_ORIGINS;
    else process.env.TRUSTED_ORIGINS = original;
    vi.restoreAllMocks();
  });

  /** A reverse proxy that rewrites Host and sends no X-Forwarded-Host, on plain HTTP (no fetch metadata). */
  const lockedOut = (app: App, path: string) =>
    post(app, path).set("Host", "noah-upstream:48787").set("Origin", "http://noah.corp.example");

  it("parses a comma-separated origin list and ignores anything that is not a plain http(s) origin", () => {
    expect(
      parseTrustedOrigins(" https://Noah.Corp.Example/ , http://10.1.2.3:8080,https://noah.corp.example:443 ,, http://[fd00::5]:8080 "),
    ).toEqual({ origins: ["https://noah.corp.example", "http://10.1.2.3:8080", "http://[fd00::5]:8080"], invalid: [] });
    expect(
      parseTrustedOrigins("*, https://*.corp.example, noah.corp.example, https://noah.corp.example/app, ftp://noah.corp.example, https://u:p@noah.corp.example, https://noah.corp.example?x=1, null, http://ok.example"),
    ).toEqual({
      origins: ["http://ok.example"],
      invalid: [
        "*",
        "https://*.corp.example",
        "noah.corp.example",
        "https://noah.corp.example/app",
        "ftp://noah.corp.example",
        "https://u:p@noah.corp.example",
        "https://noah.corp.example?x=1",
        "null",
      ],
    });
    expect(parseTrustedOrigins("")).toEqual({ origins: [], invalid: [] });
  });

  it("is what gets a locked-out deployment working again: login 403 → listed origin → login works", async () => {
    // Without the list: every state change, login included, is refused.
    const before = boot();
    await post(before.app, "/api/auth/signup").send({ username: "boss", displayName: "Boss", password: "password123" }).expect(201);
    const refused = await lockedOut(before.app, "/api/auth/login").send({ username: "boss", password: "password123" }).expect(403);
    expect(refused.body.error).toBe(CROSS_SITE_REFUSED_MESSAGE);
    before.services.store.close();

    // The operator lists the origin from the log and restarts.
    process.env.TRUSTED_ORIGINS = "http://noah.corp.example";
    const after = boot();
    await lockedOut(after.app, "/api/auth/login").send({ username: "boss", password: "password123" }).expect(200);
    await lockedOut(after.app, "/api/auth/logout").expect(200);
    // Only that origin: another one is still refused, also on the same host with another scheme or port.
    for (const origin of ["http://evil.example", "https://noah.corp.example", "http://noah.corp.example:8080"]) {
      await post(after.app, "/api/auth/logout").set("Host", "noah-upstream:48787").set("Origin", origin).expect(403);
    }
  });

  it("lets a listed origin pass even when the browser calls the request same-site or cross-site", async () => {
    process.env.TRUSTED_ORIGINS = "https://noah.corp.example, not-an-origin";
    const { app } = boot();
    for (const site of ["same-site", "cross-site"]) {
      await post(app, "/api/auth/logout").set("Origin", "https://noah.corp.example").set("Sec-Fetch-Site", site).expect(200);
      await post(app, "/api/auth/logout").set("Origin", "https://NOAH.corp.example:443").set("Sec-Fetch-Site", site).expect(200);
      // An unlisted origin, and a request with no Origin at all, get no such pass.
      await post(app, "/api/auth/logout").set("Origin", "https://other.corp.example").set("Sec-Fetch-Site", site).expect(403);
      await post(app, "/api/auth/logout").set("Sec-Fetch-Site", site).expect(403);
    }
  });

  it("warns once at boot about ignored entries and never widens the gate for them", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    process.env.TRUSTED_ORIGINS = "*, noah.corp.example";
    const { app } = boot();
    const bootWarnings = warn.mock.calls.filter(([, message]) => String(message).startsWith("TRUSTED_ORIGINS:"));
    expect(bootWarnings).toHaveLength(1);
    expect(bootWarnings[0][0]).toEqual({ ignored: ["*", "noah.corp.example"] });
    await lockedOut(app, "/api/auth/logout").expect(403);
  });

  it("logs what differed on a refusal — never a cookie, token, query or body — at most once a minute per combination", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let clock = 1_000_000;
    const app = express();
    app.use(express.json());
    app.use(createCrossSiteMutationGuard({ now: () => clock }));
    app.post("*", (_req, res) => res.json({ ok: true }));
    const refusals = () => warn.mock.calls.filter(([, message]) => String(message).startsWith("refused a state-changing request"));
    const send = (origin: string, path = "/api/auth/login?next=/secret-query") =>
      request(app)
        .post(path)
        .set("Host", "noah-upstream:48787")
        .set("Origin", origin)
        .set("Cookie", "ac_session=secret-session-token")
        .set("Authorization", "Basic c2VjcmV0")
        .send({ username: "boss", password: "secret-password" })
        .expect(403);

    await send("http://noah.corp.example");
    expect(refusals()).toHaveLength(1);
    const [fields, message] = refusals()[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({
      method: "POST",
      path: "/api/auth/login",
      reason: "origin",
      origin: "http://noah.corp.example",
      secFetchSite: null,
      ownOrigin: "http://noah-upstream:48787",
      host: "noah-upstream:48787",
      forwardedHost: null,
    });
    expect(message).toContain("add it to TRUSTED_ORIGINS");
    expect(JSON.stringify(refusals())).not.toMatch(/secret-session-token|c2VjcmV0|secret-password|secret-query/);

    // The same combination is not logged again within the minute — on any path…
    await send("http://noah.corp.example");
    await send("http://noah.corp.example", "/api/me");
    expect(refusals()).toHaveLength(1);
    // …a different origin is…
    await send("http://evil.example");
    expect(refusals()).toHaveLength(2);
    // …and the first one again once a minute has passed.
    clock += 60_000;
    await send("http://noah.corp.example");
    expect(refusals()).toHaveLength(3);
    // Every refusal still answers 403; only the log line is limited.
  });
});

describe("signup hardening", () => {
  const limits = { ...SIGNUP_LIMITS };
  afterEach(() => {
    Object.assign(SIGNUP_LIMITS, limits);
  });

  const send = (app: App, username: string, password = "password123") =>
    post(app, "/api/auth/signup").send({ username, displayName: username, password });

  it("judges reserved names case-insensitively and across close variants", () => {
    for (const name of [
      "admin", "Admin", "ADMIN", "administrator", "root", "system", "noah", "support", "security",
      "null", "undefined", "me", "api", "API", "ad.min", "a_d-m.i.n", "admin2", "root_01", "adm1n", "r00t", "N0AH",
      "sys-admin", "superuser", "noah-almighty", "Me_1",
    ]) {
      expect(isReservedUsername(name), name).toBe(true);
    }
    for (const name of ["noah.kim", "adminton", "rooter", "alice", "api-team", "mei", "systematic", "boss", "owner", "user1"]) {
      expect(isReservedUsername(name), name).toBe(false);
    }
  });

  it("lets the FIRST account (the admin bootstrap) take a reserved name, then refuses self-service signups of one", async () => {
    const { app, services } = boot();
    const first = await send(app, "admin").expect(201);
    expect(first.body.user.roles).toContain("admin");
    for (const name of ["root", "Administrator", "noah", "sys.admin", "r00t", "api", "null"]) {
      const res = await send(app, name).expect(400);
      expect(res.body.error).toBe("사용할 수 없는 사용자명입니다. 다른 사용자명을 입력해 주세요.");
      expect(services.store.getUserByUsername(name)).toBeNull();
    }
    // A reserved word inside a longer name is an ordinary name.
    await send(app, "noah.kim").expect(202);
    // The refusal is the same whether or not an account has the name (admin exists, root does not).
    expect((await send(app, "Admin").expect(400)).body.error).toBe((await send(app, "root").expect(400)).body.error);
  });

  it("refuses a NEW username that differs from an existing one only by case", async () => {
    const { app, services } = boot();
    await send(app, "boss").expect(201);
    await send(app, "alice").expect(202);
    for (const name of ["Alice", "ALICE", "aLiCe", "Boss"]) {
      const res = await send(app, name).expect(409);
      expect(res.body.error).toBe("이미 사용 중인 사용자명입니다.");
    }
    // The store refuses it on every creating path, not only the route.
    expect(() => services.store.createUser({ username: "ALICE", displayName: "A", password: "password123" })).toThrow("DUPLICATE_USERNAME");
    expect(services.store.listUsers().map((user) => user.username).sort()).toEqual(["alice", "boss"]);
  });

  it("keeps two EXISTING accounts that differ only by case working exactly as before", async () => {
    const { app, services } = boot();
    await send(app, "boss").expect(201);
    services.store.createUser({ username: "carol", displayName: "lower", password: "lower-password" });
    // A row from before the rule: the store would refuse to create it today.
    const db = dbOf(services);
    const lower = db.prepare("SELECT * FROM users WHERE username = 'carol'").get() as Record<string, unknown>;
    db.prepare(
      "INSERT INTO users (id, username, password_hash, display_name, visibility, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'group', ?, ?)",
    ).run("legacy-upper", "Carol", hashPasswordSync("upper-password"), "upper", lower.created_at, lower.created_at);

    // Login resolves the name EXACTLY as stored: each account answers only to its own spelling and password.
    const asLower = await post(app, "/api/auth/login").send({ username: "carol", password: "lower-password" }).expect(200);
    expect(asLower.body.user.displayName).toBe("lower");
    const asUpper = await post(app, "/api/auth/login").send({ username: "Carol", password: "upper-password" }).expect(200);
    expect(asUpper.body.user.id).toBe("legacy-upper");
    await post(app, "/api/auth/login").send({ username: "Carol", password: "lower-password" }).expect(401);
    await post(app, "/api/auth/login").send({ username: "CAROL", password: "upper-password" }).expect(401);
    // Nothing was rewritten.
    expect(
      (db.prepare("SELECT username FROM users WHERE username = 'carol' COLLATE NOCASE ORDER BY username").all() as { username: string }[]).map(
        (row) => row.username,
      ),
    ).toEqual(["Carol", "carol"]);
  });

  it("caps pending signups instance-wide and frees room when an admin approves one", async () => {
    const { app, services } = boot();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    SIGNUP_LIMITS.pending = 2;
    await send(app, "pend1").expect(202);
    await send(app, "pend2").expect(202);
    expect(services.store.countPendingSignups()).toBe(2);
    const refused = await send(app, "pend3").expect(429);
    expect(refused.body.error).toBe("승인을 기다리는 가입 신청이 너무 많아 새 신청을 받을 수 없습니다. 관리자에게 문의해 주세요.");
    expect(services.store.getUserByUsername("pend3")).toBeNull();
    // The cap answers before the name is looked at: a taken name gets the same 429.
    await send(app, "pend1").expect(429);

    const pending = services.store.getUserByUsername("pend1")!;
    await admin.post(`/api/admin/users/${pending.id}/suspend`).send({ suspended: false }).expect(200);
    expect(services.store.countPendingSignups()).toBe(1);
    await send(app, "pend3").expect(202);
  });

  it("does not count an account an admin suspended after it was in use as a pending signup", async () => {
    const { app, services } = boot();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const member = request.agent(app);
    const joined = await signup(member, "worker").expect(201); // approved + logged in
    await new Promise((resolve) => setTimeout(resolve, 5));
    await member.get("/api/me").expect(200); // an authenticated request moves last_seen_at
    await admin.post(`/api/admin/users/${joined.body.user.id}/suspend`).send({ suspended: true }).expect(200);
    expect(services.store.countPendingSignups()).toBe(0);
  });

  it("caps signups per hour instance-wide, never the first account", async () => {
    const { app, services } = boot();
    SIGNUP_LIMITS.perHour = 0;
    await send(app, "boss").expect(201); // the bootstrap admin is never refused
    SIGNUP_LIMITS.perHour = 3;
    await send(app, "hour1").expect(202);
    await send(app, "hour2").expect(202);
    const refused = await send(app, "hour3").expect(429);
    expect(refused.body.error).toBe("지금은 가입 신청이 많아 새 신청을 받을 수 없습니다. 잠시 후 다시 시도해 주세요.");
    // Accounts older than an hour no longer count.
    dbOf(services).prepare("UPDATE users SET created_at = ?").run(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    await send(app, "hour3").expect(202);
  });

  it("keeps the signup mode at approval | closed", async () => {
    const { app } = boot();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    await admin.put("/api/admin/signup-mode").send({ mode: "open" }).expect(400);
    await admin.put("/api/admin/signup-mode").send({ mode: "closed" }).expect(200);
    await send(app, "late").expect(403);
  });
});

describe("asynchronous password hashing", () => {
  it("hashes and verifies off the event loop in the stored saltHex:hashHex format", async () => {
    const pending = hashPassword("password123");
    expect(pending).toBeInstanceOf(Promise);
    const digest = await pending;
    expect(digest).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(await verifyPassword("password123", digest)).toBe(true);
    expect(await verifyPassword("password124", digest)).toBe(false);
    // The blocking variant (fixtures) writes the same format.
    expect(await verifyPassword("password123", hashPasswordSync("password123"))).toBe(true);
  });

  it("verifies a digest written by the old synchronous code byte for byte", async () => {
    // Exactly what auth.ts did before: scryptSync(password, 16 random bytes, 64).
    const salt = crypto.randomBytes(16);
    const legacy = `${salt.toString("hex")}:${crypto.scryptSync("old-password", salt, 64).toString("hex")}`;
    expect(await verifyPassword("old-password", legacy)).toBe(true);
    expect(await verifyPassword("old-passworD", legacy)).toBe(false);
    // The derived length follows the stored hash, as before.
    const short = `${salt.toString("hex")}:${crypto.scryptSync("old-password", salt, 32).toString("hex")}`;
    expect(await verifyPassword("old-password", short)).toBe(true);
    // Malformed digests never verify.
    for (const bad of ["", "nocolon", ":abcd", "abcd:", "abcd:zz"]) {
      expect(await verifyPassword("old-password", bad), bad).toBe(false);
    }
  });

  it("logs an existing account in with a pre-change digest, and an admin reset replaces it", async () => {
    const { app, services } = boot();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const user = services.store.createUser({ username: "veteran", displayName: "V", password: "ignored-pass" });
    const salt = crypto.randomBytes(16);
    const legacy = `${salt.toString("hex")}:${crypto.scryptSync("old-password", salt, 64).toString("hex")}`;
    dbOf(services).prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(legacy, user.id);

    await post(app, "/api/auth/login").send({ username: "veteran", password: "old-password" }).expect(200);
    await post(app, "/api/auth/login").send({ username: "veteran", password: "wrong-password" }).expect(401);

    await admin.post(`/api/admin/users/${user.id}/password`).send({ password: "new-password" }).expect(200);
    await post(app, "/api/auth/login").send({ username: "veteran", password: "old-password" }).expect(401);
    await post(app, "/api/auth/login").send({ username: "veteran", password: "new-password" }).expect(200);
    await admin.post("/api/admin/users/no-such-user/password").send({ password: "new-password" }).expect(404);
    const stored = (dbOf(services).prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(user.id) as { h: string }).h;
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it("honours a suspension that lands while the password is being verified", async () => {
    const { services } = boot();
    const user = services.store.createUser({ username: "racer", displayName: "R", password: "password123" });
    services.store.createUser({ username: "second", displayName: "S", password: "password123" });
    const login = services.store.verifyLogin("racer", "password123");
    services.store.setSuspended(user.id, true); // before the scrypt callback runs
    expect(await login).toBe("suspended");
  });

  it("keeps concurrent logins and the event loop moving", async () => {
    const { app } = boot();
    await post(app, "/api/auth/signup").send({ username: "boss", displayName: "Boss", password: "password123" }).expect(201);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => post(app, "/api/auth/login").send({ username: "boss", password: "password123" })),
    );
    clearInterval(timer);
    expect(results.every((res) => res.status === 200)).toBe(true);
    // With scryptSync the loop was blocked for each derivation in turn and a 1 ms
    // timer barely fired; on the threadpool it keeps ticking between them.
    expect(ticks).toBeGreaterThan(3);
  });
});
