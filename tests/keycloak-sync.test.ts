import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import {
  KeycloakRefusedError,
  KeycloakUnavailableError,
  setKeycloakClientForTests,
  type KeycloakClient,
  type KeycloakUser,
} from "../src/server/keycloak.js";
import {
  reconcileKeycloak,
  runKeycloakReconcile,
  setKeycloakPassword,
  setKeycloakSyncRetryForTests,
  syncRegistrationToKeycloak,
  syncUserToKeycloak,
  whenKeycloakSyncIdle,
} from "../src/server/keycloakSync.js";
import { signup, withTempDir } from "./helpers.js";

// keycloakSync.ts: what Noah decides about a person (approved, suspended, admin, deleted, the password an
// admin sets) written into Keycloak, and the boot pass that makes Keycloak match Noah — over a real SQLite
// store and an in-memory fake behind the `KeycloakClient` interface. Plus the admin routes that call it.

const getTempDir = withTempDir("keycloak-sync");

type Op = keyof KeycloakClient;

interface FakeKeycloak extends KeycloakClient {
  accounts: Map<string, KeycloakUser>;
  teammates: Set<string>;
  admins: Set<string>;
  passwords: Map<string, string>;
  registration: boolean | null;
  /** Every admin call, in the order it STARTED: `op` or `op:id[:value]`. */
  calls: string[];
  /** While true every call fails as unreachable. */
  down: boolean;
  /** Fail these calls as unreachable, the given number of times. */
  failNext: Partial<Record<Op, number>>;
  /** A password the policy refuses (400). */
  refusedPassword: string | null;
  /** Awaited at the start of a call (after it is recorded). */
  gate: ((op: Op, id: string | undefined) => Promise<void>) | null;
  /** How many calls of this op were made. */
  count(op: Op): number;
  add(id: string, username: string): void;
}

function fakeKeycloak(): FakeKeycloak {
  const notUsed = (): never => {
    throw new Error("the login half of the client is not used here");
  };
  async function enter(op: Op, id?: string, value?: string | boolean): Promise<void> {
    fake.calls.push([op, id, value].filter((part) => part !== undefined).join(":"));
    await fake.gate?.(op, id);
    const left = fake.failNext[op] ?? 0;
    if (fake.down || left > 0) {
      if (left > 0) fake.failNext[op] = left - 1;
      throw new KeycloakUnavailableError(`Keycloak did not answer (${op}).`);
    }
  }
  const mustExist = (op: Op, id: string): void => {
    if (!fake.accounts.has(id)) throw new KeycloakRefusedError(404, "", `Keycloak refused (${op}: HTTP 404).`);
  };
  const fake: FakeKeycloak = {
    accounts: new Map(),
    teammates: new Set(),
    admins: new Set(),
    passwords: new Map(),
    registration: null,
    calls: [],
    down: false,
    failNext: {},
    refusedPassword: null,
    gate: null,
    count: (op) => fake.calls.filter((call) => call === op || call.startsWith(`${op}:`)).length,
    add: (id, username) => void fake.accounts.set(id, { id, username }),

    authorizationUrl: notUsed,
    redirectUri: notUsed,
    exchangeCode: notUsed,
    userinfo: notUsed,
    refresh: notUsed,
    endSession: notUsed,

    async getUser(id) {
      await enter("getUser", id);
      return fake.accounts.get(id) ?? null;
    },
    async listUsers() {
      await enter("listUsers");
      return [...fake.accounts.values()];
    },
    async importUsers(users) {
      await enter("importUsers", users.map((user) => user.username).join(","));
      let added = 0;
      for (const user of users) {
        // Keycloak stores usernames in lower case, and one username is one account.
        const username = user.username.toLowerCase();
        if (fake.accounts.has(user.id) || [...fake.accounts.values()].some((account) => account.username === username)) continue;
        fake.accounts.set(user.id, { id: user.id, username });
        added += 1;
      }
      return { added, skipped: users.length - added };
    },
    async setPassword(id, password) {
      // Never the password itself in the call log.
      await enter("setPassword", id);
      mustExist("setPassword", id);
      if (password === fake.refusedPassword) {
        throw new KeycloakRefusedError(400, "invalidPasswordMinLengthMessage", "Keycloak refused (set password: HTTP 400 invalidPasswordMinLengthMessage).");
      }
      fake.passwords.set(id, password);
    },
    async setTeammate(id, teammate) {
      await enter("setTeammate", id, teammate);
      mustExist("setTeammate", id);
      if (teammate) fake.teammates.add(id);
      else fake.teammates.delete(id);
    },
    async setAdmin(id, admin) {
      await enter("setAdmin", id, admin);
      mustExist("setAdmin", id);
      if (admin) fake.admins.add(id);
      else fake.admins.delete(id);
    },
    async listTeammateIds() {
      await enter("listTeammateIds");
      return new Set(fake.teammates);
    },
    async listAdminIds() {
      await enter("listAdminIds");
      return new Set(fake.admins);
    },
    async logoutUser(id) {
      await enter("logoutUser", id);
    },
    async deleteUser(id) {
      await enter("deleteUser", id);
      fake.accounts.delete(id);
      fake.teammates.delete(id);
      fake.admins.delete(id);
      fake.passwords.delete(id);
    },
    async setRegistrationAllowed(allowed) {
      await enter("setRegistrationAllowed", undefined, allowed);
      fake.registration = allowed;
    },
  };
  return fake;
}

const booted: AppServices[] = [];
// No retry timer unless a test asks for one.
beforeEach(() => setKeycloakSyncRetryForTests({ attempts: 0 }));
afterEach(async () => {
  setKeycloakSyncRetryForTests({ attempts: 0 });
  for (const { store } of booted.splice(0)) await whenKeycloakSyncIdle(store);
});

let instance = 0;
function setup(options: { keycloak?: boolean } = {}) {
  const services = createServices({ dataDir: path.join(getTempDir(), `data-${(instance += 1)}`), agentRuntime: "local", sessionSecret: "t" });
  booted.push(services);
  const { store, config } = services;
  const keycloak = fakeKeycloak();
  if (options.keycloak !== false) setKeycloakClientForTests(store, keycloak);
  const mk = (username: string, opts: { pending?: boolean } = {}) => {
    // No built-in password (as an account born in Keycloak): nothing here logs in, and a digest costs a scrypt run.
    const user = store.createUser({ username, displayName: `${username} 님`, passwordHash: "" });
    if (opts.pending) store.setSuspended(user.id, true);
    return user;
  };
  return { services, store, config, keycloak, mk };
}

describe("syncUserToKeycloak", () => {
  it("creates the account with the Noah id, and writes the group and the role Noah holds", async () => {
    const { store, config, keycloak, mk } = setup();
    const admin = mk("admin"); // the first account is the admin
    const pending = mk("newcomer", { pending: true });

    await syncUserToKeycloak(store, config, admin.id);
    await syncUserToKeycloak(store, config, pending.id);

    expect(keycloak.accounts.get(admin.id)).toEqual({ id: admin.id, username: "admin" });
    expect(keycloak.accounts.get(pending.id)).toEqual({ id: pending.id, username: "newcomer" });
    expect([...keycloak.teammates]).toEqual([admin.id]);
    expect([...keycloak.admins]).toEqual([admin.id]);
    // The import carries no credential.
    expect(keycloak.passwords.size).toBe(0);
    // An account Keycloak already has is not imported again.
    await syncUserToKeycloak(store, config, admin.id);
    expect(keycloak.count("importUsers")).toBe(2);
  });

  it("approve puts the account in the group; suspend takes it out and ends its Keycloak sessions", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob", { pending: true });
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.teammates.has(bob.id)).toBe(false);

    store.setSuspended(bob.id, false);
    keycloak.calls.length = 0;
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.teammates.has(bob.id)).toBe(true);
    expect(keycloak.calls).toEqual([`getUser:${bob.id}`, `setTeammate:${bob.id}:true`, `setAdmin:${bob.id}:false`]);

    store.setSuspended(bob.id, true);
    keycloak.calls.length = 0;
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.teammates.has(bob.id)).toBe(false);
    expect(keycloak.calls).toEqual([`getUser:${bob.id}`, `setTeammate:${bob.id}:false`, `setAdmin:${bob.id}:false`, `logoutUser:${bob.id}`]);
    // The account itself stays (the group is the only gate written).
    expect(keycloak.accounts.has(bob.id)).toBe(true);
  });

  it("grants and revokes the admin role", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob");
    store.setRole(bob.id, "admin", true);
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.admins.has(bob.id)).toBe(true);
    store.setRole(bob.id, "admin", false);
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.admins.has(bob.id)).toBe(false);
    expect(keycloak.teammates.has(bob.id)).toBe(true);
  });

  it("deletes the Keycloak account of a user Noah no longer has", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob");
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.accounts.has(bob.id)).toBe(true);

    store.deleteUser(bob.id);
    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.accounts.has(bob.id)).toBe(false);
    expect(keycloak.teammates.has(bob.id)).toBe(false);
  });

  it("runs the calls about one user one after another, each reading Noah when it runs", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob");
    const carol = mk("carol");
    keycloak.add(bob.id, "bob");
    keycloak.add(carol.id, "carol");

    // The first call about bob hangs in Keycloak until released.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    keycloak.gate = async (op, id) => {
      if (holding && op === "getUser" && id === bob.id) {
        holding = false;
        await held;
      }
    };

    store.setSuspended(bob.id, true);
    const first = syncUserToKeycloak(store, config, bob.id);
    store.setSuspended(bob.id, false);
    const second = syncUserToKeycloak(store, config, bob.id);
    // Another user is not held up by bob's queue.
    await syncUserToKeycloak(store, config, carol.id);
    expect(keycloak.teammates.has(carol.id)).toBe(true);
    // Nothing of the second call has started while the first is in Keycloak.
    expect(keycloak.calls.filter((call) => call.includes(bob.id))).toEqual([`getUser:${bob.id}`]);

    release();
    await Promise.all([first, second]);
    const bobCalls = keycloak.calls.filter((call) => call.includes(bob.id));
    // Both runs read Noah when they ran — after the second press — and never interleaved.
    expect(bobCalls).toEqual([
      `getUser:${bob.id}`,
      `setTeammate:${bob.id}:true`,
      `setAdmin:${bob.id}:false`,
      `getUser:${bob.id}`,
      `setTeammate:${bob.id}:true`,
      `setAdmin:${bob.id}:false`,
    ]);
    expect(keycloak.teammates.has(bob.id)).toBe(true);
  });

  it("never merges into another account that holds the username", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob");
    keycloak.add("someone-else", "bob");
    keycloak.teammates.add("someone-else");

    await syncUserToKeycloak(store, config, bob.id);
    expect(keycloak.accounts.has(bob.id)).toBe(false);
    expect(keycloak.count("setTeammate")).toBe(0);
    expect(keycloak.count("setAdmin")).toBe(0);
    expect(keycloak.accounts.get("someone-else")).toEqual({ id: "someone-else", username: "bob" });
  });

  it("never throws: a Keycloak that is down, and a server without Keycloak", async () => {
    const { store, config, keycloak, mk } = setup();
    const admin = mk("admin");
    keycloak.down = true;
    await expect(syncUserToKeycloak(store, config, admin.id)).resolves.toBeUndefined();
    await expect(syncRegistrationToKeycloak(store, config)).resolves.toBeUndefined();
    expect(keycloak.accounts.size).toBe(0);

    const plain = setup({ keycloak: false });
    const user = plain.mk("admin");
    await expect(syncUserToKeycloak(plain.store, plain.config, user.id)).resolves.toBeUndefined();
    await expect(syncRegistrationToKeycloak(plain.store, plain.config)).resolves.toBeUndefined();
    expect(await setKeycloakPassword(plain.store, plain.config, user.id, "whatever-123")).toEqual({ ok: false, reason: "no_keycloak" });
    expect(plain.keycloak.calls).toEqual([]);
  });
});

describe("runKeycloakReconcile", () => {
  it("imports the accounts Keycloak lacks and makes the group and the role match Noah, both ways", async () => {
    const { store, config, keycloak, mk } = setup();
    const admin = mk("admin");
    const bob = mk("bob");
    const carol = mk("carol");
    const pending = mk("newcomer", { pending: true });
    const exAdmin = mk("dave");
    // Keycloak before: bob is there but in no group; carol is suspended in Noah yet still a teammate there;
    // dave holds an admin role Noah never gave him; an account without a Noah user sits in both; a client's
    // service account holds the role.
    store.setSuspended(carol.id, true);
    keycloak.add(bob.id, "bob");
    keycloak.add(carol.id, "carol");
    keycloak.teammates.add(carol.id);
    keycloak.add(exAdmin.id, "dave");
    keycloak.teammates.add(exAdmin.id);
    keycloak.admins.add(exAdmin.id);
    keycloak.add("stranger", "stranger");
    keycloak.teammates.add("stranger");
    keycloak.admins.add("stranger");
    keycloak.add("svc", "service-account-noah");
    keycloak.admins.add("svc");

    const outcome = await runKeycloakReconcile(store, config);

    expect(outcome).toEqual({
      kind: "done",
      users: 5,
      imported: 2, // admin, newcomer
      usernameTaken: [],
      teammatesAdded: 2, // admin, bob
      teammatesRemoved: 2, // carol, stranger
      adminsGranted: 1, // admin
      adminsRevoked: 2, // dave, stranger
      registrationAllowed: true,
    });
    expect(new Set(keycloak.teammates)).toEqual(new Set([admin.id, bob.id, exAdmin.id]));
    expect(new Set(keycloak.admins)).toEqual(new Set([admin.id, "svc"]));
    expect(keycloak.accounts.has(pending.id)).toBe(true);
    expect(keycloak.registration).toBe(true);
    // One import call for everything missing; whoever left the group is logged out of Keycloak.
    expect(keycloak.count("importUsers")).toBe(1);
    expect(keycloak.calls.filter((call) => call.startsWith("logoutUser:")).sort()).toEqual([`logoutUser:${carol.id}`, "logoutUser:stranger"].sort());
    // No account is deleted, disabled or given a password by the pass.
    expect(keycloak.count("deleteUser")).toBe(0);
    expect(keycloak.count("setPassword")).toBe(0);
    expect(keycloak.accounts.has("stranger")).toBe(true);

    // A second pass finds nothing to change: only the lists and the registration switch are touched.
    keycloak.calls.length = 0;
    const again = await runKeycloakReconcile(store, config);
    expect(again).toMatchObject({ kind: "done", imported: 0, teammatesAdded: 0, teammatesRemoved: 0, adminsGranted: 0, adminsRevoked: 0 });
    expect(keycloak.calls).toEqual(["listUsers", "listTeammateIds", "listAdminIds", "setRegistrationAllowed:true"]);
  });

  it("imports in chunks of at most 100", async () => {
    const { store, config, keycloak, mk } = setup();
    for (let i = 0; i < 205; i += 1) mk(`user${i}`, { pending: i > 0 });
    const outcome = await runKeycloakReconcile(store, config);
    expect(outcome).toMatchObject({ kind: "done", users: 205, imported: 205, teammatesAdded: 1 });
    const sizes = keycloak.calls.filter((call) => call.startsWith("importUsers:")).map((call) => call.split(":")[1].split(",").length);
    expect(sizes).toEqual([100, 100, 5]);
  });

  it("leaves out — and names — a Noah user whose username Keycloak holds under another id", async () => {
    const { store, config, keycloak, mk } = setup();
    const admin = mk("admin");
    const bob = mk("Bob");
    keycloak.add("someone-else", "bob");

    const outcome = await runKeycloakReconcile(store, config);

    expect(outcome).toMatchObject({ kind: "done", imported: 1, usernameTaken: ["Bob"], teammatesAdded: 1 });
    expect(keycloak.accounts.has(bob.id)).toBe(false);
    // The other account is neither merged nor promoted: it is not a teammate because Noah's Bob is.
    expect(keycloak.accounts.get("someone-else")).toEqual({ id: "someone-else", username: "bob" });
    expect([...keycloak.teammates]).toEqual([admin.id]);
    expect(keycloak.calls.some((call) => call.includes(bob.id))).toBe(false);
  });

  it("registration follows the signup mode — and is open while Noah has no user at all", async () => {
    const empty = setup();
    empty.store.setSignupMode("closed");
    expect(await runKeycloakReconcile(empty.store, empty.config)).toMatchObject({ kind: "done", users: 0, registrationAllowed: true });
    expect(empty.keycloak.registration).toBe(true);

    const { store, config, keycloak, mk } = setup();
    mk("admin");
    store.setSignupMode("closed");
    expect(await runKeycloakReconcile(store, config)).toMatchObject({ kind: "done", registrationAllowed: false });
    expect(keycloak.registration).toBe(false);
    store.setSignupMode("approval");
    await syncRegistrationToKeycloak(store, config);
    expect(keycloak.registration).toBe(true);
  });

  it("re-reads Noah in the account's own turn: a press made while the pass runs is not undone", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    const bob = mk("bob");
    keycloak.add(bob.id, "bob");
    // The pass saw bob approved and missing from the group; before it writes, an admin suspends him.
    keycloak.gate = async (op) => {
      if (op === "listAdminIds") store.setSuspended(bob.id, true);
    };
    await runKeycloakReconcile(store, config);
    expect(keycloak.teammates.has(bob.id)).toBe(false);
  });

  it("answers `off` without Keycloak and `retry` when Keycloak cannot be used", async () => {
    const plain = setup({ keycloak: false });
    plain.mk("admin");
    expect(await runKeycloakReconcile(plain.store, plain.config)).toEqual({ kind: "off" });

    const { store, config, keycloak, mk } = setup();
    mk("admin");
    keycloak.down = true;
    expect(await runKeycloakReconcile(store, config)).toMatchObject({ kind: "retry" });
    expect(keycloak.accounts.size).toBe(0);
  });
});

describe("reconcileKeycloak (boot)", () => {
  it("retries with a pause until Keycloak answers", async () => {
    const { store, config, keycloak, mk } = setup();
    const admin = mk("admin");
    setKeycloakSyncRetryForTests({ delayMs: 5, attempts: 6 });
    keycloak.failNext.listUsers = 3;

    reconcileKeycloak(store, config);
    // A second call while one is under way starts nothing of its own.
    reconcileKeycloak(store, config);
    await vi.waitFor(() => expect(keycloak.registration).toBe(true), { timeout: 5_000, interval: 10 });

    // Three failed tries, then the pass that worked (which lists again after its import).
    expect(keycloak.count("listUsers")).toBe(5);
    expect([...keycloak.teammates]).toEqual([admin.id]);
    expect([...keycloak.admins]).toEqual([admin.id]);
  });

  it("gives up after the bounded number of attempts", async () => {
    const { store, config, keycloak, mk } = setup();
    mk("admin");
    setKeycloakSyncRetryForTests({ delayMs: 1, attempts: 2 });
    keycloak.down = true;

    reconcileKeycloak(store, config);
    await vi.waitFor(() => expect(keycloak.count("listUsers")).toBe(3), { timeout: 5_000, interval: 5 });
    await whenKeycloakSyncIdle(store);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(keycloak.count("listUsers")).toBe(3); // the first try + two retries, then nothing more
  });

  it("does nothing without Keycloak", async () => {
    const { store, config, keycloak, mk } = setup({ keycloak: false });
    mk("admin");
    reconcileKeycloak(store, config);
    await whenKeycloakSyncIdle(store);
    expect(keycloak.calls).toEqual([]);
  });
});

// ---- The admin routes -----------------------------------------------------------------

type App = ReturnType<typeof createApp>;

/**
 * An app with an admin and bob, both signed up through the BUILT-IN login (before Keycloak is installed), so
 * both still hold a built-in password. `keycloak: true` then installs the fake — holding nothing yet.
 */
async function bootApp(options: { keycloak: boolean }) {
  const services = createServices({ dataDir: path.join(getTempDir(), `app-${(instance += 1)}`), agentRuntime: "local", sessionSecret: "t" });
  booted.push(services);
  const app: App = createApp(services);
  const adminAgent = request.agent(app);
  const adminId = (await signup(adminAgent, "admin").expect(201)).body.user.id as string;
  const bobAgent = request.agent(app);
  const bobId = (await signup(bobAgent, "bob").expect(201)).body.user.id as string;
  const keycloak = fakeKeycloak();
  if (options.keycloak) setKeycloakClientForTests(services.store, keycloak);
  const idle = () => whenKeycloakSyncIdle(services.store);
  return { services, store: services.store, app, adminAgent, adminId, bobAgent, bobId, keycloak, idle };
}

const auditActions = (store: AppServices["store"], adminId: string) => store.listAudit(adminId, true).map((entry) => entry.action);

describe("admin routes write into Keycloak", () => {
  it("suspend / activate / role / force-logout / delete", async () => {
    const { store, adminAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });

    await adminAgent.post(`/api/admin/users/${bobId}/suspend`).send({ suspended: false }).expect(200);
    await idle();
    expect(keycloak.accounts.get(bobId)).toEqual({ id: bobId, username: "bob" });
    expect(keycloak.teammates.has(bobId)).toBe(true);

    await adminAgent.post(`/api/admin/users/${bobId}/roles`).send({ role: "admin", grant: true }).expect(200);
    await idle();
    expect(keycloak.admins.has(bobId)).toBe(true);
    await adminAgent.post(`/api/admin/users/${bobId}/roles`).send({ role: "admin", grant: false }).expect(200);
    await idle();
    expect(keycloak.admins.has(bobId)).toBe(false);

    keycloak.calls.length = 0;
    const logout = await adminAgent.post(`/api/admin/users/${bobId}/logout`).expect(200);
    expect(logout.body.ok).toBe(true);
    await idle();
    expect(keycloak.calls).toEqual([`logoutUser:${bobId}`]);

    await adminAgent.post(`/api/admin/users/${bobId}/suspend`).send({ suspended: true }).expect(200);
    await idle();
    expect(keycloak.teammates.has(bobId)).toBe(false);
    expect(keycloak.calls).toContain(`logoutUser:${bobId}`);
    expect(keycloak.accounts.has(bobId)).toBe(true);

    await adminAgent.delete(`/api/admin/users/${bobId}`).expect(200);
    await idle();
    expect(store.getUserById(bobId)).toBeNull();
    expect(keycloak.accounts.has(bobId)).toBe(false);
  });

  it("a Keycloak that is down never fails the admin's press", async () => {
    const { store, adminAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });
    keycloak.down = true;
    await adminAgent.post(`/api/admin/users/${bobId}/suspend`).send({ suspended: true }).expect(200);
    await adminAgent.post(`/api/admin/users/${bobId}/roles`).send({ role: "admin", grant: true }).expect(200);
    await adminAgent.post(`/api/admin/users/${bobId}/logout`).expect(200);
    await adminAgent.put("/api/admin/signup-mode").send({ mode: "closed" }).expect(200);
    await adminAgent.delete(`/api/admin/users/${bobId}`).expect(200);
    await idle();
    expect(store.getUserById(bobId)).toBeNull();
    expect(store.getSignupMode()).toBe("closed");
  });

  it("the signup mode sets Keycloak's registration switch", async () => {
    const { adminAgent, keycloak, idle } = await bootApp({ keycloak: true });
    await adminAgent.put("/api/admin/signup-mode").send({ mode: "closed" }).expect(200);
    await idle();
    expect(keycloak.registration).toBe(false);
    await adminAgent.put("/api/admin/signup-mode").send({ mode: "approval" }).expect(200);
    await idle();
    expect(keycloak.registration).toBe(true);
  });

  it("without Keycloak nothing is called and the routes answer as before", async () => {
    const { adminAgent, bobId, keycloak, idle } = await bootApp({ keycloak: false });
    await adminAgent.post(`/api/admin/users/${bobId}/suspend`).send({ suspended: true }).expect(200);
    await adminAgent.post(`/api/admin/users/${bobId}/roles`).send({ role: "admin", grant: true }).expect(200);
    await adminAgent.post(`/api/admin/users/${bobId}/logout`).expect(200);
    await adminAgent.put("/api/admin/signup-mode").send({ mode: "closed" }).expect(200);
    await adminAgent.delete(`/api/admin/users/${bobId}`).expect(200);
    await idle();
    expect(keycloak.calls).toEqual([]);
  });
});

describe("admin password reset", () => {
  const login = (app: App, password: string) => request(app).post("/api/auth/login").send({ username: "bob", password });

  it("without Keycloak: the password is Noah's own, as before", async () => {
    const { store, app, adminAgent, adminId, bobAgent, bobId, keycloak } = await bootApp({ keycloak: false });
    await bobAgent.get("/api/audit").expect(200);

    await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "brand-new-pass" }).expect(200, { ok: true });

    await bobAgent.get("/api/audit").expect(401);
    expect(store.hasBuiltInPassword(bobId)).toBe(true);
    await login(app, "password123").expect(401);
    await login(app, "brand-new-pass").expect(200);
    expect(auditActions(store, adminId)).toContain("reset_password");
    expect(keycloak.calls).toEqual([]);
  });

  it("with Keycloak: the password goes to Keycloak and Noah's own is dropped", async () => {
    const { store, adminAgent, adminId, bobAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });
    await bobAgent.get("/api/audit").expect(200);
    expect(store.hasBuiltInPassword(bobId)).toBe(true);

    // Keycloak has no account for bob yet: it is created with his id first, and joins the group Noah says.
    await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "brand-new-pass" }).expect(200, { ok: true });
    await idle();

    expect(keycloak.accounts.get(bobId)).toEqual({ id: bobId, username: "bob" });
    expect(keycloak.passwords.get(bobId)).toBe("brand-new-pass");
    expect(keycloak.teammates.has(bobId)).toBe(true);
    expect(store.hasBuiltInPassword(bobId)).toBe(false);
    // Noah's sessions are revoked as before, and the Keycloak sessions end too.
    await bobAgent.get("/api/audit").expect(401);
    expect(keycloak.calls).toContain(`logoutUser:${bobId}`);
    // The call order: the account, then the password, before anything in Noah changed.
    expect(keycloak.calls.slice(0, 4)).toEqual([`getUser:${bobId}`, "importUsers:bob", `setPassword:${bobId}`, `setTeammate:${bobId}:true`]);
    expect(auditActions(store, adminId)).toContain("reset_password");
    // No password in the audit trail.
    expect(JSON.stringify(store.listAudit(adminId, true))).not.toContain("brand-new-pass");

    // A second reset finds the account and only sets the password.
    keycloak.calls.length = 0;
    await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "another-pass-1" }).expect(200);
    await idle();
    expect(keycloak.calls).toEqual([`getUser:${bobId}`, `setPassword:${bobId}`, `logoutUser:${bobId}`]);
    expect(keycloak.passwords.get(bobId)).toBe("another-pass-1");
  });

  it("with Keycloak: a password its policy refuses is a 400 and changes nothing", async () => {
    const { store, app, adminAgent, adminId, bobAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });
    keycloak.add(bobId, "bob");
    keycloak.refusedPassword = "too-simple-pass";
    await bobAgent.get("/api/audit").expect(200);
    const auditBefore = auditActions(store, adminId).length;

    const res = await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "too-simple-pass" }).expect(400);
    await idle();

    expect(res.body.error).toBe("로그인 서버의 비밀번호 규칙에 맞지 않습니다. 다른 비밀번호를 입력해 주세요.");
    expect(res.body.error).not.toMatch(/keycloak/i);
    expect(keycloak.passwords.has(bobId)).toBe(false);
    expect(keycloak.count("logoutUser")).toBe(0);
    // Noah: the built-in password still works, the session lives, nothing was audited.
    expect(store.hasBuiltInPassword(bobId)).toBe(true);
    await bobAgent.get("/api/audit").expect(200);
    expect(auditActions(store, adminId).length).toBe(auditBefore);
    setKeycloakClientForTests(store, null);
    await login(app, "password123").expect(200);
  });

  it("with Keycloak: an unreachable Keycloak is a 502 and changes nothing", async () => {
    const { store, adminAgent, adminId, bobAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });
    keycloak.down = true;
    await bobAgent.get("/api/audit").expect(200);
    const auditBefore = auditActions(store, adminId).length;

    const res = await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "brand-new-pass" }).expect(502);
    await idle();

    expect(res.body.error).toBe("로그인 서버에 연결하지 못했습니다. 비밀번호는 바뀌지 않았습니다. 잠시 후 다시 시도해 주세요.");
    expect(res.body.error).not.toMatch(/keycloak/i);
    expect(store.hasBuiltInPassword(bobId)).toBe(true);
    await bobAgent.get("/api/audit").expect(200);
    expect(auditActions(store, adminId).length).toBe(auditBefore);
    expect(keycloak.passwords.size).toBe(0);
  });

  it("with Keycloak: an account Keycloak cannot hold (its username is another account's there) is reset in Noah, where its login is", async () => {
    const { store, app, adminAgent, bobAgent, bobId, keycloak, idle } = await bootApp({ keycloak: true });
    keycloak.add("someone-else", "bob");
    await bobAgent.get("/api/audit").expect(200);

    await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "brand-new-pass" }).expect(200);
    await idle();

    // Nothing was written to (or merged into) the other account; the built-in login takes the new password.
    expect(keycloak.passwords.size).toBe(0);
    expect(keycloak.accounts.has(bobId)).toBe(false);
    expect(store.hasBuiltInPassword(bobId)).toBe(true);
    await bobAgent.get("/api/audit").expect(401);
    await request(app).post("/api/auth/login").send({ username: "bob", password: "brand-new-pass" }).expect(200);
  });

  it("with Keycloak: the length rule and the unknown user are answered before Keycloak is asked", async () => {
    const { adminAgent, bobId, keycloak } = await bootApp({ keycloak: true });
    await adminAgent.post(`/api/admin/users/${bobId}/password`).send({ password: "short" }).expect(400);
    await adminAgent.post("/api/admin/users/ghost/password").send({ password: "longenough" }).expect(404);
    expect(keycloak.calls).toEqual([]);
  });
});
