import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import {
  KeycloakRefusedError,
  KeycloakUnavailableError,
  setKeycloakClientForTests,
  type KeycloakClient,
  type KeycloakIdentity,
} from "../src/server/keycloak.js";
import {
  runKeycloakReconcile,
  setKeycloakPassword,
  setKeycloakSyncRetryForTests,
  syncUserToKeycloak,
  whenKeycloakSyncIdle,
} from "../src/server/keycloakSync.js";
import { SIGNUP_LIMITS } from "../src/server/routes/auth.js";
import { withTempDir } from "./helpers.js";

// The login of an install with Keycloak (routes/auth.ts): the name-first login
// screen's probe, the one-time move of a built-in password, the authorization
// code flow (start → callback → session), who gets a session and who is
// refused with which notice, and the logout that ends the Keycloak session.
// Keycloak itself is an in-memory fake behind the `KeycloakClient` interface.

let tempDir: string;
const getTempDir = withTempDir("auth-keycloak", () => {
  tempDir = getTempDir();
});

type App = ReturnType<typeof createApp>;

interface FakeKeycloak extends KeycloakClient {
  accounts: Map<string, { username: string; password?: string; teammate: boolean; admin: boolean }>;
  /** code → who it is for. */
  codes: Map<string, KeycloakIdentity>;
  exchanged: { code: string; verifier: string }[];
  ended: string[];
  failSetPassword: Error | null;
}

function fakeKeycloak(): FakeKeycloak {
  const accounts: FakeKeycloak["accounts"] = new Map();
  const codes: FakeKeycloak["codes"] = new Map();
  const tokens = new Map<string, KeycloakIdentity>();
  const fake: FakeKeycloak = {
    accounts,
    codes,
    exchanged: [],
    ended: [],
    failSetPassword: null,
    authorizationUrl: ({ state, codeChallenge, loginHint, register }) =>
      `https://noah.test/sso/${register ? "registrations" : "auth"}?state=${state}&challenge=${codeChallenge}${loginHint ? `&login_hint=${loginHint}` : ""}`,
    redirectUri: () => "https://noah.test/api/auth/oidc/callback",
    async exchangeCode(code, verifier) {
      fake.exchanged.push({ code, verifier });
      const identity = codes.get(code);
      if (!identity) throw new KeycloakRefusedError(400, "invalid_grant", "Keycloak refused (code exchange: HTTP 400 invalid_grant).");
      codes.delete(code);
      tokens.set(`access-${code}`, identity);
      return { accessToken: `access-${code}`, refreshToken: `refresh-${code}` };
    },
    async userinfo(accessToken) {
      const identity = tokens.get(accessToken);
      if (!identity) throw new KeycloakUnavailableError("no such token");
      return identity;
    },
    // Not used by these routes (the pi admin relay's, tests/pi-admin-proxy.test.ts).
    async refresh(refreshToken) {
      return { accessToken: `access-of-${refreshToken}`, refreshToken: null, expiresInSeconds: 300 };
    },
    async endSession(refreshToken) {
      fake.ended.push(refreshToken);
    },
    async getUser(id) {
      const account = accounts.get(id);
      return account ? { id, username: account.username } : null;
    },
    async listUsers() {
      return [...accounts].map(([id, a]) => ({ id, username: a.username }));
    },
    async importUsers(users) {
      let added = 0;
      for (const u of users) {
        if (accounts.has(u.id) || [...accounts.values()].some((a) => a.username === u.username)) continue;
        accounts.set(u.id, { username: u.username, teammate: false, admin: false });
        added += 1;
      }
      return { added, skipped: users.length - added };
    },
    async setPassword(id, password) {
      if (fake.failSetPassword) throw fake.failSetPassword;
      const account = accounts.get(id);
      if (!account) throw new KeycloakRefusedError(404, "", "Keycloak refused (set password: HTTP 404).");
      account.password = password;
    },
    async setTeammate(id, teammate) {
      const account = accounts.get(id);
      if (account) account.teammate = teammate;
    },
    async setAdmin(id, admin) {
      const account = accounts.get(id);
      if (account) account.admin = admin;
    },
    async listTeammateIds() {
      return new Set([...accounts].filter(([, a]) => a.teammate).map(([id]) => id));
    },
    async listAdminIds() {
      return new Set([...accounts].filter(([, a]) => a.admin).map(([id]) => id));
    },
    async logoutUser() {},
    async deleteUser(id) {
      accounts.delete(id);
    },
    async setRegistrationAllowed() {},
  };
  return fake;
}

/** `instance`: a second, separate server inside one test (its own data folder). */
function boot(withKeycloak = true, instance = ""): { services: AppServices; app: App; keycloak: FakeKeycloak } {
  const dataDir = instance ? path.join(tempDir, instance) : tempDir;
  fs.mkdirSync(dataDir, { recursive: true });
  const services = createServices({ dataDir, agentRuntime: "local", sessionSecret: "test" });
  const keycloak = fakeKeycloak();
  if (withKeycloak) setKeycloakClientForTests(services.store, keycloak);
  return { services, app: createApp(services), keycloak };
}

function dbOf(services: AppServices): Database.Database {
  return (services.store as unknown as { db: Database.Database }).db;
}

const digestOf = (services: AppServices, id: string): string =>
  (dbOf(services).prepare("SELECT password_hash AS h FROM users WHERE id = ?").get(id) as { h: string }).h;

/** Background work a route started (`void syncUserToKeycloak`, `void endSession`) settles within a few ticks. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Start a login in `agent`'s browser and come back from Keycloak as `identity`. Resolves with the callback's response. */
async function loginThroughKeycloak(
  agent: ReturnType<typeof request.agent>,
  keycloak: FakeKeycloak,
  identity: KeycloakIdentity,
  code = `code-${identity.sub}-${keycloak.exchanged.length}`,
) {
  const start = await agent.get("/api/auth/oidc/start").expect(302);
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  keycloak.codes.set(code, identity);
  return agent.get(`/api/auth/oidc/callback?code=${code}&state=${state}`);
}

const ADA: KeycloakIdentity = { sub: "11111111-2222-4333-8444-555555555555", username: "ada", name: "Ada L" };
const BOB: KeycloakIdentity = { sub: "22222222-3333-4444-8555-666666666666", username: "bob", name: "" };

describe("the login screen's facts", () => {
  it("says sso only with Keycloak, and login-method answers `password` only for a name with a built-in password", async () => {
    const plain = boot(false);
    plain.services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    expect((await request(plain.app).get("/api/bootstrap")).body.sso).toBe(false);
    expect((await request(plain.app).post("/api/auth/login-method").send({ username: "nobody" })).body).toEqual({ method: "password" });

    const { services, app } = boot(true, "with-keycloak");
    const old = services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    expect((await request(app).get("/api/bootstrap")).body.sso).toBe(true);
    const method = async (username: string) => (await request(app).post("/api/auth/login-method").send({ username }).expect(200)).body.method;
    expect(await method("olduser")).toBe("password");
    expect(await method("nobody")).toBe("sso");
    services.store.clearBuiltInPassword(old.id);
    expect(await method("olduser")).toBe("sso");
  });

  it("has no signup form of its own with Keycloak", async () => {
    const { app } = boot();
    const res = await request(app).post("/api/auth/signup").send({ username: "newbie", displayName: "N", password: "password123" }).expect(400);
    expect(res.body.error).toContain("가입 신청");
  });
});

describe("the one-time move of a built-in password", () => {
  it("puts the verified password into Keycloak, drops Noah's digest, and still logs this login in", async () => {
    const { services, app, keycloak } = boot();
    const user = services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    const agent = request.agent(app);

    const res = await agent.post("/api/auth/login").send({ username: "olduser", password: "password123" }).expect(200);
    expect(res.body.user.id).toBe(user.id);
    await settle();
    // The account was created in Keycloak WITH Noah's id, then given the password.
    expect(keycloak.accounts.get(user.id)).toMatchObject({ username: "olduser", password: "password123", teammate: true, admin: true });
    expect(digestOf(services, user.id)).toBe("");
    expect(services.store.hasBuiltInPassword(user.id)).toBe(false);
    expect((await agent.get("/api/me")).body.user.id).toBe(user.id);
    expect(services.store.listAudit(user.id, true).some((entry) => entry.action === "password_moved")).toBe(true);

    // From now on the built-in form sends this name to Keycloak — with the
    // right password, a wrong one, or for a name that does not exist.
    for (const [username, password] of [["olduser", "password123"], ["olduser", "wrong"], ["nobody", "x"]]) {
      const again = await request(app).post("/api/auth/login").send({ username, password }).expect(409);
      expect(again.body).toMatchObject({ sso: true });
    }
  });

  it("a wrong password moves nothing", async () => {
    const { services, app, keycloak } = boot();
    const user = services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    await request(app).post("/api/auth/login").send({ username: "olduser", password: "nope-nope" }).expect(401);
    expect(keycloak.accounts.size).toBe(0);
    expect(services.store.hasBuiltInPassword(user.id)).toBe(true);
  });

  it("keeps the digest and the login when Keycloak cannot take the password", async () => {
    const failures = [new KeycloakUnavailableError("down"), new KeycloakRefusedError(400, "invalidPasswordMinLengthMessage", "refused")];
    for (const [index, failure] of failures.entries()) {
      const { services, app, keycloak } = boot(true, `case-${index}`);
      const user = services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
      keycloak.failSetPassword = failure;
      await request(app).post("/api/auth/login").send({ username: "olduser", password: "password123" }).expect(200);
      expect(services.store.hasBuiltInPassword(user.id)).toBe(true);
      // The next built-in login tries again.
      keycloak.failSetPassword = null;
      await request(app).post("/api/auth/login").send({ username: "olduser", password: "password123" }).expect(200);
      expect(services.store.hasBuiltInPassword(user.id)).toBe(false);
      expect(keycloak.accounts.get(user.id)?.password).toBe("password123");
    }
  });

  it("a move queued behind an admin's reset does not put the old password back, and that login is refused", async () => {
    const { services, app, keycloak } = boot();
    const { store, config } = services;
    const user = store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    const oldDigest = store.builtInPasswordDigest(user.id);

    // The reset runs first in the account's turn (it also drops Noah's digest)…
    expect(await setKeycloakPassword(store, config, user.id, "set-by-admin-1")).toEqual({ ok: true });
    expect(store.hasBuiltInPassword(user.id)).toBe(false);
    // …so a move that verified against the OLD digest finds it gone and writes nothing.
    expect(await setKeycloakPassword(store, config, user.id, "password123", { whileDigest: oldDigest })).toEqual({ ok: false, reason: "stale" });
    expect(keycloak.accounts.get(user.id)?.password).toBe("set-by-admin-1");

    // Through the route: an account suspended while its move was waiting on Keycloak gets no session.
    const second = store.createUser({ username: "olduser2", displayName: "Old2", password: "password123" });
    const getUser = keycloak.getUser.bind(keycloak);
    keycloak.getUser = async (id) => {
      if (id === second.id) store.setSuspended(second.id, true);
      return getUser(id);
    };
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ username: "olduser2", password: "password123" }).expect(401);
    expect((await agent.get("/api/me")).body.user).toBeNull();
  });

  it("without Keycloak the built-in login is what it was", async () => {
    const { services, app } = boot(false);
    const user = services.store.createUser({ username: "olduser", displayName: "Old", password: "password123" });
    await request(app).post("/api/auth/login").send({ username: "olduser", password: "password123" }).expect(200);
    expect(services.store.hasBuiltInPassword(user.id)).toBe(true);
    await request(app).post("/api/auth/login").send({ username: "nobody", password: "x" }).expect(401);
  });
});

describe("the code flow", () => {
  it("does not exist without Keycloak", async () => {
    const { app } = boot(false);
    await request(app).get("/api/auth/oidc/start").expect(404);
    await request(app).get("/api/auth/oidc/callback?code=x&state=y").expect(404);
  });

  it("start sends the browser to Keycloak with a fresh state, the hint, and registration only while signups are open", async () => {
    const { services, app } = boot();
    // No account yet: the first one may register.
    const first = await request(app).get("/api/auth/oidc/start?register=1").expect(302);
    expect(first.headers.location).toContain("/sso/registrations?");
    expect(String(first.headers["set-cookie"])).toMatch(/ac_login_flow=[^;]+; Max-Age=600; Path=\/api\/auth\/oidc; .*HttpOnly; SameSite=Lax/);

    services.store.createUser({ username: "admin1", displayName: "A", password: "password123" });
    const hinted = await request(app).get("/api/auth/oidc/start?hint=ada").expect(302);
    expect(hinted.headers.location).toContain("/sso/auth?");
    expect(hinted.headers.location).toContain("login_hint=ada");
    expect(new URL(hinted.headers.location as string).searchParams.get("state")).not.toBe(
      new URL(first.headers.location as string).searchParams.get("state"),
    );
    // A hint that is not a username is dropped, not passed on.
    expect((await request(app).get("/api/auth/oidc/start?hint=a%20b%3Cscript%3E")).headers.location).not.toContain("login_hint");

    services.store.setSignupMode("closed");
    expect((await request(app).get("/api/auth/oidc/start?register=1")).headers.location).toContain("/sso/auth?");
  });

  it("logs an existing account in by its id, keeps the session, and ends the Keycloak session at logout", async () => {
    const { services, app, keycloak } = boot();
    const user = services.store.createUser({ id: ADA.sub, username: "ada", displayName: "Ada", passwordHash: "" });
    const agent = request.agent(app);

    const back = await loginThroughKeycloak(agent, keycloak, ADA, "c1");
    expect(back.status).toBe(302);
    expect(back.headers.location).toBe("/");
    expect(keycloak.exchanged).toHaveLength(1);
    expect((await agent.get("/api/me")).body.user.id).toBe(user.id);
    await settle();
    // Group and role follow Noah (the first account is the admin); the session is not ended by logging in.
    expect(keycloak.accounts.get(user.id)).toMatchObject({ teammate: true, admin: true });
    expect(keycloak.ended).toEqual([]);

    await agent.post("/api/auth/logout").expect(200);
    await settle();
    expect(keycloak.ended).toEqual(["refresh-c1"]);
    expect((await agent.get("/api/me")).body.user).toBeNull();
  });

  it("a login at Keycloak drops a digest Noah still held (never two passwords)", async () => {
    const { services, app, keycloak } = boot();
    const user = services.store.createUser({ id: ADA.sub, username: "ada", displayName: "Ada", password: "password123" });
    await loginThroughKeycloak(request.agent(app), keycloak, ADA).then((res) => expect(res.headers.location).toBe("/"));
    expect(services.store.hasBuiltInPassword(user.id)).toBe(false);
  });

  it("refuses a callback that is not the login this browser started, without trading the code", async () => {
    const { services, app, keycloak } = boot();
    services.store.createUser({ id: ADA.sub, username: "ada", displayName: "Ada", passwordHash: "" });
    keycloak.codes.set("stolen", ADA);

    // No login in flight in this browser.
    const cold = await request(app).get("/api/auth/oidc/callback?code=stolen&state=whatever-whatever-whatever");
    expect(cold.headers.location).toBe("/?auth=failed");

    // A login in flight, but another state.
    const agent = request.agent(app);
    await agent.get("/api/auth/oidc/start").expect(302);
    const wrong = await agent.get("/api/auth/oidc/callback?code=stolen&state=not-the-state-this-browser-got");
    expect(wrong.headers.location).toBe("/?auth=failed");

    // Cancelled at Keycloak: an error and no code. The flow cookie was used up above, so start again.
    const start = await agent.get("/api/auth/oidc/start").expect(302);
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const cancelled = await agent.get(`/api/auth/oidc/callback?error=access_denied&state=${state}`);
    expect(cancelled.headers.location).toBe("/?auth=failed");

    // A state of the right LENGTH in characters but not in bytes is a mismatch, not a crash.
    const again = await agent.get("/api/auth/oidc/start").expect(302);
    const real = new URL(again.headers.location as string).searchParams.get("state")!;
    const sameLength = encodeURIComponent("가".repeat(real.length));
    const odd = await agent.get(`/api/auth/oidc/callback?code=stolen&state=${sameLength}`);
    expect(odd.status).toBe(302);
    expect(odd.headers.location).toBe("/?auth=failed");

    expect(keycloak.exchanged).toEqual([]);
    expect((await agent.get("/api/me")).body.user).toBeNull();
  });

  it("a state is good for one callback only", async () => {
    const { services, app, keycloak } = boot();
    services.store.createUser({ id: ADA.sub, username: "ada", displayName: "Ada", passwordHash: "" });
    const agent = request.agent(app);
    const start = await agent.get("/api/auth/oidc/start").expect(302);
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    keycloak.codes.set("c1", ADA);
    keycloak.codes.set("c2", ADA);
    expect((await agent.get(`/api/auth/oidc/callback?code=c1&state=${state}`)).headers.location).toBe("/");
    expect((await agent.get(`/api/auth/oidc/callback?code=c2&state=${state}`)).headers.location).toBe("/?auth=failed");
  });

  it("answers `failed` when Keycloak does not honour the code", async () => {
    const { app, keycloak } = boot();
    const agent = request.agent(app);
    const start = await agent.get("/api/auth/oidc/start").expect(302);
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const res = await agent.get(`/api/auth/oidc/callback?code=unknown&state=${state}`);
    expect(res.headers.location).toBe("/?auth=failed");
    expect(keycloak.exchanged).toHaveLength(1);
  });
});

describe("who a Keycloak identity is in Noah", () => {
  it("the first account ever becomes the admin with Keycloak's id; the next one waits for approval and gets no session", async () => {
    const { services, app, keycloak } = boot();
    keycloak.accounts.set(ADA.sub, { username: "ada", teammate: false, admin: false });
    keycloak.accounts.set(BOB.sub, { username: "bob", teammate: false, admin: false });

    const adaAgent = request.agent(app);
    expect((await loginThroughKeycloak(adaAgent, keycloak, ADA)).headers.location).toBe("/");
    const ada = (await adaAgent.get("/api/me")).body.user;
    expect(ada).toMatchObject({ id: ADA.sub, username: "ada", displayName: "Ada L" });
    expect(ada.roles).toContain("admin");
    expect(services.store.hasBuiltInPassword(ADA.sub)).toBe(false);
    await settle();
    expect(keycloak.accounts.get(ADA.sub)).toMatchObject({ teammate: true, admin: true });

    const bobAgent = request.agent(app);
    const bobBack = await loginThroughKeycloak(bobAgent, keycloak, BOB, "bob-1");
    expect(bobBack.headers.location).toBe("/?auth=pending");
    expect((await bobAgent.get("/api/me")).body.user).toBeNull();
    expect(services.store.accountGate(BOB.sub)).toBe("pending");
    // No display name from Keycloak: the username stands in.
    expect(services.store.getUserById(BOB.sub)?.displayName).toBe("bob");
    await settle();
    // No Noah session → the Keycloak session ended too; not a teammate there.
    expect(keycloak.ended).toContain("refresh-bob-1");
    expect(keycloak.accounts.get(BOB.sub)?.teammate).toBe(false);

    // Still pending on the next try — and never a second row.
    expect((await loginThroughKeycloak(bobAgent, keycloak, BOB, "bob-2")).headers.location).toBe("/?auth=pending");
    expect(services.store.listUsers().filter((u) => u.username === "bob")).toHaveLength(1);

    // Approved: the same identity now gets a session.
    services.store.setSuspended(BOB.sub, false);
    expect((await loginThroughKeycloak(bobAgent, keycloak, BOB, "bob-3")).headers.location).toBe("/");
    expect((await bobAgent.get("/api/me")).body.user.id).toBe(BOB.sub);
  });

  it("a suspended account is told so and gets no session", async () => {
    const { services, app, keycloak } = boot();
    services.store.createUser({ username: "admin1", displayName: "A", password: "password123" });
    const bob = services.store.createUser({ id: BOB.sub, username: "bob", displayName: "Bob", passwordHash: "" });
    // In use, then suspended (a pending signup has never been seen).
    dbOf(services).prepare("UPDATE users SET last_seen_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(bob.id);
    services.store.setSuspended(bob.id, true);
    const agent = request.agent(app);
    expect((await loginThroughKeycloak(agent, keycloak, BOB)).headers.location).toBe("/?auth=suspended");
    expect((await agent.get("/api/me")).body.user).toBeNull();
  });

  it("creates nobody while signup is closed, over the caps, or for a name Noah does not take", async () => {
    const { services, app, keycloak } = boot();
    services.store.createUser({ username: "admin1", displayName: "A", password: "password123" });
    const users = () => services.store.listUsers().length;

    // A name that is another account's (different id) is never merged — any case.
    for (const username of ["admin1", "ADMIN1"]) {
      const res = await loginThroughKeycloak(request.agent(app), keycloak, { sub: BOB.sub, username, name: "" });
      expect(res.headers.location).toBe("/?auth=name");
    }
    // Not a Noah username; a reserved one.
    for (const username of ["a", "has space", "system"]) {
      const res = await loginThroughKeycloak(request.agent(app), keycloak, { sub: BOB.sub, username, name: "" });
      expect(res.headers.location).toBe("/?auth=name");
    }
    expect(users()).toBe(1);

    // Over the instance-wide caps (the same ones as the built-in signup).
    const limits = { ...SIGNUP_LIMITS };
    try {
      SIGNUP_LIMITS.perHour = 1;
      expect((await loginThroughKeycloak(request.agent(app), keycloak, BOB, "over-cap")).headers.location).toBe("/?auth=full");
    } finally {
      Object.assign(SIGNUP_LIMITS, limits);
    }
    expect(users()).toBe(1);

    services.store.setSignupMode("closed");
    expect((await loginThroughKeycloak(request.agent(app), keycloak, BOB, "while-closed")).headers.location).toBe("/?auth=closed");
    expect(users()).toBe(1);
    // Every refused login ended its Keycloak session (awaited before the redirect).
    expect(keycloak.ended).toContain("refresh-over-cap");
    expect(keycloak.ended).toContain("refresh-while-closed");
  });
});

describe("what Keycloak holds for a suspended admin", () => {
  it("neither the teammates group nor the admin role — and both again once reactivated", async () => {
    const { services, keycloak } = boot();
    const { store, config } = services;
    store.createUser({ username: "admin1", displayName: "A", password: "password123" });
    const second = store.createUser({ id: BOB.sub, username: "bob", displayName: "Bob", passwordHash: "" });
    store.setRole(second.id, "admin", true);
    const state = async () => {
      await syncUserToKeycloak(store, config, second.id);
      await whenKeycloakSyncIdle(store);
      const account = keycloak.accounts.get(second.id)!;
      return { teammate: account.teammate, admin: account.admin };
    };
    expect(await state()).toEqual({ teammate: true, admin: true });
    // Whoever trusts this Keycloak without asking Noah must not see a suspended admin as an admin.
    store.setSuspended(second.id, true);
    expect(await state()).toEqual({ teammate: false, admin: false });
    expect(store.isAdmin(second.id)).toBe(true);
    store.setSuspended(second.id, false);
    expect(await state()).toEqual({ teammate: true, admin: true });
  });
});

describe("a write Keycloak missed", () => {
  it("is written again by the next pass — a suspension, and the delete of an account", async () => {
    // No timers in this test: the pass is run by hand.
    setKeycloakSyncRetryForTests({ attempts: 0 });
    try {
      const { services, keycloak } = boot();
      const { store, config } = services;
      store.createUser({ username: "admin1", displayName: "A", password: "password123" });
      const bob = store.createUser({ id: BOB.sub, username: "bob", displayName: "Bob", passwordHash: "" });
      const gone = store.createUser({ id: ADA.sub, username: "ada", displayName: "Ada", passwordHash: "" });
      await runKeycloakReconcile(store, config);
      expect(keycloak.accounts.get(bob.id)?.teammate).toBe(true);
      expect(keycloak.accounts.has(gone.id)).toBe(true);

      // Keycloak is down while an admin suspends one account and deletes another.
      const down = new KeycloakUnavailableError("down");
      const { getUser, deleteUser } = keycloak;
      keycloak.getUser = async () => Promise.reject(down);
      keycloak.deleteUser = async () => Promise.reject(down);
      store.setSuspended(bob.id, true);
      store.deleteUser(gone.id);
      await syncUserToKeycloak(store, config, bob.id);
      await syncUserToKeycloak(store, config, gone.id);
      await whenKeycloakSyncIdle(store);
      expect(keycloak.accounts.get(bob.id)?.teammate).toBe(true);
      expect(keycloak.accounts.has(gone.id)).toBe(true);

      // Back up: one pass repairs both. (Without the repair list the pass would never delete an account.)
      keycloak.getUser = getUser;
      keycloak.deleteUser = deleteUser;
      expect((await runKeycloakReconcile(store, config)).kind).toBe("done");
      expect(keycloak.accounts.get(bob.id)?.teammate).toBe(false);
      expect(keycloak.accounts.has(gone.id)).toBe(false);
    } finally {
      setKeycloakSyncRetryForTests();
    }
  });

  it("one account Keycloak refuses to create does not hold back the others, nor the group and role work", async () => {
    setKeycloakSyncRetryForTests({ attempts: 0 });
    try {
      const { services, keycloak } = boot();
      const { store, config } = services;
      const admin = store.createUser({ username: "admin1", displayName: "A", password: "password123" });
      const bad = store.createUser({ username: "refused", displayName: "R", password: "password123" });
      const importUsers = keycloak.importUsers.bind(keycloak);
      keycloak.importUsers = async (users) => {
        if (users.some((u) => u.id === bad.id)) throw new KeycloakRefusedError(400, "invalid", "Keycloak refused (import users: HTTP 400 invalid).");
        return importUsers(users);
      };
      expect((await runKeycloakReconcile(store, config)).kind).toBe("done");
      expect(keycloak.accounts.get(admin.id)).toMatchObject({ teammate: true, admin: true });
      expect(keycloak.accounts.has(bad.id)).toBe(false);
    } finally {
      setKeycloakSyncRetryForTests();
    }
  });
});
