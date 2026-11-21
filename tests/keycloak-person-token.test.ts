import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import {
  createHttpKeycloakClient,
  KeycloakRefusedError,
  KeycloakUnavailableError,
  setKeycloakClientForTests,
  type KeycloakClient,
} from "../src/server/keycloak.js";
import {
  clearPersonTokensForTests,
  PERSON_TOKEN_LIMITS,
  personAccessTokenFor,
  personTokenCountForTests,
} from "../src/server/keycloakPersonToken.js";
import logger from "../src/server/logger.js";
import { withTempDir } from "./helpers.js";

// Covers src/server/keycloakPersonToken.ts (the access token of the person behind a Noah session,
// for the pi admin relay), `KeycloakClient.refresh` of the HTTP client, and the store's
// `setSessionKeycloakToken`. Keycloak is a fake behind the `KeycloakClient` interface; the store is real.

const getTempDir = withTempDir("keycloak-person-token");

interface FakeKeycloak {
  client: KeycloakClient;
  /** Every refresh token a refresh was asked with, in order. */
  asked: string[];
  /** The next refreshes fail with these, in order. */
  failures: Error[];
  /** The refresh token the next answers carry (null = none, like a Keycloak that does not rotate). */
  rotateTo: string | null;
  lifetimeSeconds: number;
  /** Awaited inside a refresh, after it is recorded. */
  gate: Promise<void> | null;
}

function fakeKeycloak(): FakeKeycloak {
  const fake: FakeKeycloak = {
    asked: [],
    failures: [],
    rotateTo: null,
    lifetimeSeconds: 300,
    gate: null,
    // Only `refresh` is used here; any other call is a TypeError the test would show.
    client: {
      async refresh(refreshToken: string) {
        fake.asked.push(refreshToken);
        await fake.gate;
        const failure = fake.failures.shift();
        if (failure) throw failure;
        return { accessToken: `access-${fake.asked.length}-of-${refreshToken}`, refreshToken: fake.rotateTo, expiresInSeconds: fake.lifetimeSeconds };
      },
    } as unknown as KeycloakClient,
  };
  return fake;
}

let instance = 0;
function setup(options: { keycloak?: boolean } = {}) {
  const services = createServices({ dataDir: path.join(getTempDir(), `data-${(instance += 1)}`), agentRuntime: "local", sessionSecret: "t" });
  const { store, config } = services;
  const keycloak = fakeKeycloak();
  if (options.keycloak !== false) setKeycloakClientForTests(store, keycloak.client);
  // No built-in password (as an account born in Keycloak): a digest costs a scrypt run.
  const user = store.createUser({ username: "ada", displayName: "Ada", passwordHash: "" });
  const ssoSession = (refreshToken = "refresh-1") => store.createSession(user.id, { keycloakRefreshToken: refreshToken });
  const tokenFor = (session: string | undefined) => personAccessTokenFor(store, config, session);
  return { store, config, keycloak, user, ssoSession, tokenFor };
}

/** Moves `Date.now()` forward (the store's own clock, `new Date()`, is not touched). */
function clock() {
  let ahead = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + ahead);
  return { advance: (ms: number) => void (ahead += ms) };
}

/** Everything any log call was given, as one string. */
function logLines() {
  const spies = (["debug", "info", "warn", "error"] as const).map((level) => vi.spyOn(logger, level));
  return {
    text: () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls)),
    warnings: () => spies[2].mock.calls.length,
  };
}

const savedLimits = { ...PERSON_TOKEN_LIMITS };
afterEach(() => {
  Object.assign(PERSON_TOKEN_LIMITS, savedLimits);
  vi.restoreAllMocks();
});

describe("personAccessTokenFor", () => {
  it("is null without a Keycloak, without a session, and for a built-in-login session — Keycloak is never asked", async () => {
    const plain = setup({ keycloak: false });
    expect(await plain.tokenFor(plain.ssoSession())).toBeNull();
    expect(plain.keycloak.asked).toEqual([]);

    const { store, user, keycloak, tokenFor, ssoSession } = setup();
    expect(await tokenFor(undefined)).toBeNull();
    expect(await tokenFor("")).toBeNull();
    expect(await tokenFor("no-such-session")).toBeNull();
    const builtIn = store.createSession(user.id);
    expect(await tokenFor(builtIn)).toBeNull();
    expect(await tokenFor(builtIn)).toBeNull();
    expect(keycloak.asked).toEqual([]);
    // …while a session of the same person that began at Keycloak has one.
    expect(await tokenFor(ssoSession())).toBe("access-1-of-refresh-1");
  });

  it("reuses a token until 30 s before it expires, then refreshes", async () => {
    const { keycloak, tokenFor, ssoSession } = setup();
    const time = clock();
    const session = ssoSession();
    expect(await tokenFor(session)).toBe("access-1-of-refresh-1");
    time.advance(269_000);
    expect(await tokenFor(session)).toBe("access-1-of-refresh-1");
    expect(keycloak.asked).toHaveLength(1);
    time.advance(2_000); // 271 s of a 300 s token
    expect(await tokenFor(session)).toBe("access-2-of-refresh-1");
    expect(keycloak.asked).toEqual(["refresh-1", "refresh-1"]);
  });

  it("keeps each session's token apart, and each app instance's", async () => {
    const one = setup();
    const a = one.ssoSession("refresh-a");
    const b = one.ssoSession("refresh-b");
    expect(await one.tokenFor(a)).toBe("access-1-of-refresh-a");
    expect(await one.tokenFor(b)).toBe("access-2-of-refresh-b");
    expect(await one.tokenFor(a)).toBe("access-1-of-refresh-a");
    const other = setup();
    expect(await other.tokenFor(a)).toBeNull(); // not a session of that instance
    expect(other.keycloak.asked).toEqual([]);
  });

  it("shares ONE refresh between concurrent calls for a session", async () => {
    const { keycloak, tokenFor, ssoSession } = setup();
    const session = ssoSession();
    let open!: () => void;
    keycloak.gate = new Promise<void>((resolve) => (open = resolve));
    const calls = [tokenFor(session), tokenFor(session), tokenFor(session)];
    await new Promise((resolve) => setImmediate(resolve));
    expect(keycloak.asked).toHaveLength(1);
    open();
    expect(await Promise.all(calls)).toEqual(Array(3).fill("access-1-of-refresh-1"));
    expect(keycloak.asked).toHaveLength(1);
  });

  it("stores the newer refresh token Keycloak hands back, and uses it next", async () => {
    const { store, user, keycloak, tokenFor, ssoSession } = setup();
    const time = clock();
    const session = ssoSession();
    // No new one in the answer: the stored one stays.
    await tokenFor(session);
    expect(store.takeSessionKeycloakToken(session)).toBe("refresh-1");

    keycloak.rotateTo = "refresh-2";
    time.advance(300_000);
    await tokenFor(session);
    expect(store.takeSessionKeycloakToken(session)).toBe("refresh-2"); // what a logout would now end
    time.advance(300_000);
    expect(await tokenFor(session)).toBe("access-3-of-refresh-2");
    expect(keycloak.asked).toEqual(["refresh-1", "refresh-1", "refresh-2"]);

    // The store never gives a Keycloak login to a session that had none, or to one that is gone.
    const builtIn = store.createSession(user.id);
    store.setSessionKeycloakToken(builtIn, "refresh-x");
    expect(store.takeSessionKeycloakToken(builtIn)).toBeNull();
    store.setSessionKeycloakToken("no-such-session", "refresh-x");
    store.setSessionKeycloakToken(undefined, "refresh-x");
    expect(store.takeSessionKeycloakToken("no-such-session")).toBeNull();
  });

  it("is null when Keycloak refuses the refresh, and does not ask again for a while", async () => {
    const { keycloak, tokenFor, ssoSession } = setup();
    const time = clock();
    const logs = logLines();
    const session = ssoSession("refresh-ended");
    keycloak.failures.push(new KeycloakRefusedError(400, "invalid_grant", "Keycloak refused (token refresh: HTTP 400 invalid_grant)."));
    expect(await tokenFor(session)).toBeNull();
    expect(await tokenFor(session)).toBeNull();
    expect(keycloak.asked).toHaveLength(1);
    expect(logs.warnings()).toBe(1);
    expect(logs.text()).toContain("invalid_grant");
    expect(logs.text()).not.toContain("refresh-ended");

    time.advance(PERSON_TOKEN_LIMITS.retryAfterRefusedMs + 1);
    expect(await tokenFor(session)).toBe("access-2-of-refresh-ended");
  });

  it("is null while Keycloak does not answer, and tries again sooner", async () => {
    const { keycloak, tokenFor, ssoSession } = setup();
    const time = clock();
    const logs = logLines();
    const session = ssoSession();
    keycloak.failures.push(new KeycloakUnavailableError("Keycloak did not answer (token refresh: TimeoutError)."));
    expect(await tokenFor(session)).toBeNull();
    expect(await tokenFor(session)).toBeNull();
    expect(keycloak.asked).toHaveLength(1);
    expect(logs.warnings()).toBe(1);

    time.advance(PERSON_TOKEN_LIMITS.retryAfterUnavailableMs + 1);
    expect(await tokenFor(session)).toBe("access-2-of-refresh-1");

    // An error of any other kind is "none" too, and only its kind is logged (its text could carry anything).
    time.advance(300_000);
    keycloak.failures.push(new Error("boom with access-2-of-refresh-1 inside"));
    expect(await tokenFor(session)).toBeNull();
    expect(logs.text()).not.toContain("boom");
  });

  it("never throws: a store that fails is 'none', and nothing is remembered", async () => {
    const { store, keycloak, tokenFor, ssoSession } = setup();
    const session = ssoSession();
    const lookup = vi.spyOn(store, "getUserBySessionToken").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    expect(await tokenFor(session)).toBeNull();
    expect(keycloak.asked).toEqual([]);
    lookup.mockRestore();
    expect(await tokenFor(session)).toBe("access-1-of-refresh-1");
  });

  it("never returns a cached token for a session that logged out, expired or was suspended", async () => {
    const { store, user, keycloak, tokenFor, ssoSession } = setup();
    const session = ssoSession();
    expect(await tokenFor(session)).toBe("access-1-of-refresh-1");
    expect(personTokenCountForTests(store)).toBe(1);
    store.revokeSession(session);
    expect(await tokenFor(session)).toBeNull();
    expect(personTokenCountForTests(store)).toBe(0);
    expect(keycloak.asked).toHaveLength(1); // and Keycloak is not asked for it either

    const second = ssoSession("refresh-2");
    expect(await tokenFor(second)).toBe("access-2-of-refresh-2");
    store.setSuspended(user.id, true);
    expect(await tokenFor(second)).toBeNull();
  });

  it("drops a token that arrives after the session logged out", async () => {
    const { store, keycloak, tokenFor, ssoSession } = setup();
    const session = ssoSession();
    let open!: () => void;
    keycloak.gate = new Promise<void>((resolve) => (open = resolve));
    const pending = tokenFor(session);
    await new Promise((resolve) => setImmediate(resolve));
    store.revokeSession(session);
    open();
    expect(await pending).toBeNull();
    expect(personTokenCountForTests(store)).toBe(0);
  });

  it("bounds what it remembers: expired entries go at the next insert, and the oldest beyond the cap", async () => {
    const { store, tokenFor, ssoSession } = setup();
    const time = clock();
    PERSON_TOKEN_LIMITS.maxEntries = 3;
    const sessions = [1, 2, 3, 4, 5].map((n) => ssoSession(`refresh-${n}`));
    for (const session of sessions) await tokenFor(session);
    expect(personTokenCountForTests(store)).toBe(3);
    // The newest three are still held (no new refresh for them)…
    expect(await tokenFor(sessions[4])).toBe("access-5-of-refresh-5");
    // …the oldest was dropped, so it is refreshed again.
    expect(await tokenFor(sessions[0])).toBe("access-6-of-refresh-1");

    time.advance(300_000);
    await tokenFor(ssoSession("refresh-6"));
    expect(personTokenCountForTests(store)).toBe(1);

    clearPersonTokensForTests(store);
    expect(personTokenCountForTests(store)).toBe(0);
  });

  it("writes no token into any log line", async () => {
    const { keycloak, tokenFor, ssoSession } = setup();
    const time = clock();
    const logs = logLines();
    const session = ssoSession("refresh-SECRET");
    keycloak.rotateTo = "refresh-NEWSECRET";
    const token = await tokenFor(session);
    expect(token).toBe("access-1-of-refresh-SECRET");
    time.advance(300_000);
    keycloak.failures.push(new KeycloakRefusedError(400, "invalid_grant", "Keycloak refused (token refresh: HTTP 400 invalid_grant)."));
    await tokenFor(session);
    expect(logs.warnings()).toBe(1);
    expect(logs.text()).not.toMatch(/SECRET|access-1/);
  });
});

describe("the HTTP client's refresh", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answers: (() => Response)[] = [];
  const fetchStub = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return (answers.shift() ?? (() => new Response("{}", { status: 200 })))();
  }) as typeof fetch;
  const client = createHttpKeycloakClient(
    { publicUrl: "https://noah.corp.example/sso", internalUrl: "http://keycloak:8080/sso", clientSecret: "s3cret" },
    fetchStub,
  );
  afterEach(() => {
    calls.length = 0;
    answers.length = 0;
  });

  it("trades the refresh token on the INTERNAL token endpoint, as the noah client", async () => {
    answers.push(() => new Response(JSON.stringify({ access_token: "at-2", refresh_token: "rt-2", expires_in: 300 }), { status: 200 }));
    expect(await client.refresh("rt-1")).toEqual({ accessToken: "at-2", refreshToken: "rt-2", expiresInSeconds: 300 });
    expect(calls[0].url).toBe("http://keycloak:8080/sso/realms/noah/protocol/openid-connect/token");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("error");
    expect(Object.fromEntries(calls[0].init.body as URLSearchParams)).toEqual({
      client_id: "noah",
      client_secret: "s3cret",
      grant_type: "refresh_token",
      refresh_token: "rt-1",
    });

    // No new refresh token and no lifetime in the answer: keep the old one, treat the token as short-lived.
    answers.push(() => new Response(JSON.stringify({ access_token: "at-3" }), { status: 200 }));
    expect(await client.refresh("rt-2")).toEqual({ accessToken: "at-3", refreshToken: null, expiresInSeconds: 60 });
  });

  it("throws KeycloakRefusedError for an ended session — without the token or Keycloak's description", async () => {
    answers.push(() => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token is not active rt-ended" }), { status: 400 }));
    const error = await client.refresh("rt-ended").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeycloakRefusedError);
    expect((error as KeycloakRefusedError).status).toBe(400);
    expect((error as KeycloakRefusedError).code).toBe("invalid_grant");
    expect((error as Error).message).not.toMatch(/rt-ended|s3cret|not active/);
  });

  it("throws KeycloakUnavailableError when Keycloak fails or answers without a token", async () => {
    answers.push(() => new Response("oops", { status: 503 }));
    await expect(client.refresh("rt-1")).rejects.toBeInstanceOf(KeycloakUnavailableError);
    answers.push(() => new Response(JSON.stringify({ refresh_token: "rt-2" }), { status: 200 }));
    const error = await client.refresh("rt-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeycloakUnavailableError);
    expect((error as Error).message).not.toMatch(/rt-/);
  });
});
