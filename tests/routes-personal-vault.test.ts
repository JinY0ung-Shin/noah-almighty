import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { MemoryRefusedError, MemoryUnavailableError, memoryClientFor, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { createFakeMemoryClient, type FakeMemoryClient } from "./helpers/fakeMemory.js";
import { signup, withTempDir } from "./helpers.js";

// src/server/routes/personalVault.ts (the admin usage view + what the owner's
// settings card reads) and the user-delete sweep of routes/admin.ts —
// HTTP-boundary tests over a real store and the in-process fake of the memory
// service. No git: a knowledge repository is only CONNECTED here (the store's
// column), which is what makes a user an owner in the usage view.

const getTempDir = withTempDir("routes-personal-vault");

type App = ReturnType<typeof createApp>;

/** A server with the memory service configured (the in-process fake stands in for it), or — `fake: null` — without one. */
function boot(options: { fake?: FakeMemoryClient | null } = {}) {
  const fake = options.fake === undefined ? createFakeMemoryClient() : options.fake;
  const services = createServices({
    dataDir: path.join(getTempDir(), "data"),
    agentRuntime: "local",
    sessionSecret: "test",
    // What PI_MEMORY_URL + PI_MEMORY_API_KEY_FILE give a real server. Never dialled: the installed fake wins.
    ...(fake ? { memory: { url: "http://memory.invalid:7090", apiKey: "test-key" } } : {}),
  });
  if (fake) setMemoryClientForTests(services.store, fake);
  return { app: createApp(services), store: services.store, config: services.config, fake: fake as FakeMemoryClient };
}

type TestStore = ReturnType<typeof boot>["store"];

/** Sign up through the real auth route (the first account is the admin). */
async function mkUser(app: App, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string, username };
}

const VAULT: Record<string, string> = {
  "CLAUDE.md": "# standing memory\n",
  "wiki/index.md": "# Index\n",
  "raw/2026-11-01.md": "captured\n",
};
const VAULT_BYTES = Object.values(VAULT).reduce((sum, text) => sum + Buffer.byteLength(text), 0);

/** The user has a knowledge repository connected (never cloned here) and these notes in the memory service. */
function setUpBrain(store: TestStore, fake: FakeMemoryClient, userId: string, notes: Record<string, string> = VAULT): void {
  store.setKnowledgeRepo(userId, `team/${userId}-brain`, null);
  for (const [notePath, content] of Object.entries(notes)) fake.seed(userId, notePath, content);
}

const writes = (fake: FakeMemoryClient) => fake.calls.filter((call) => call.op === "put" || call.op === "remove" || call.op === "deleteWiki");

describe("personal-vault routes — who may call them", () => {
  it("anonymous → 401; a member → 403 on the admin route and 200 on their own", async () => {
    const { app } = boot();
    await mkUser(app, "admin");
    const member = await mkUser(app, "member");

    await request(app).get("/api/admin/personal-vaults/usage").expect(401);
    await request(app).get("/api/me/personal-vault").expect(401);

    await member.agent.get("/api/admin/personal-vaults/usage").expect(403);
    const mine = await member.agent.get("/api/me/personal-vault").expect(200);
    expect(mine.body).toEqual({ serviceConfigured: true, service: "ok" });
  });

  it("the retired routes are gone: the list, the dry run, the mode, the pass, the rollback and the two mirror presses", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    setUpBrain(store, fake, admin.id);
    fake.calls.length = 0;

    await admin.agent.get("/api/admin/personal-vaults").expect(404);
    await admin.agent.post("/api/admin/personal-vaults/dry-run").expect(404);
    await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "memory" }).expect(404);
    await admin.agent.post("/api/admin/personal-vaults/run").expect(404);
    await admin.agent.post(`/api/admin/personal-vaults/${admin.id}/rollback`).send({ expect: "memory" }).expect(404);
    await admin.agent.post("/api/me/personal-vault/mirror-recheck").expect(404);
    await admin.agent.post("/api/me/personal-vault/mirror-confirm").send({ repo: "x", branch: null }).expect(404);

    // Nothing was asked of the service, nothing was audited under the retired ids.
    expect(fake.calls).toEqual([]);
    expect(store.listAudit(admin.id, true).filter((event) => event.action.includes("personal_vault"))).toEqual([]);
  });
});

describe("GET /api/admin/personal-vaults/usage", () => {
  it("per owner the note count and bytes against the service's limits — never a path or content", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    setUpBrain(store, fake, owner.id);

    fake.calls.length = 0;
    const res = await admin.agent.get("/api/admin/personal-vaults/usage").expect(200);
    expect(res.body).toEqual({
      serviceConfigured: true,
      limits: { notes: 10_000, bytes: 256 * 1024 * 1024 },
      owners: [{ userId: owner.id, notes: Object.keys(VAULT).length, bytes: VAULT_BYTES }],
    });
    // Counts only: no note path or text of the owner's brain leaves the server here.
    for (const [notePath, text] of Object.entries(VAULT)) {
      expect(JSON.stringify(res.body)).not.toContain(notePath);
      expect(JSON.stringify(res.body)).not.toContain(text.trim());
    }
    // ONE listing of the owner's whole wiki; nothing was written or deleted.
    expect(writes(fake)).toEqual([]);
    expect(fake.calls).toEqual([expect.objectContaining({ op: "list", owner: owner.id })]);
    expect(fake.calls[0].prefix).toBeUndefined();
  });

  it("an owner is a user with a knowledge repository connected: one without is not listed, whatever the service holds", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const withRepo = await mkUser(app, "withrepo");
    const empty = await mkUser(app, "empty");
    const noRepo = await mkUser(app, "norepo");
    setUpBrain(store, fake, withRepo.id);
    // Connected, nothing written yet: listed, with zeros.
    setUpBrain(store, fake, empty.id, {});
    // Notes in the service but no repository (it was disconnected): not an owner here, and not asked about.
    fake.seed(noRepo.id, "wiki/left.md", "left\n");

    fake.calls.length = 0;
    const first = await admin.agent.get("/api/admin/personal-vaults/usage").expect(200);
    expect(first.body.owners).toEqual([
      { userId: withRepo.id, notes: 3, bytes: VAULT_BYTES },
      { userId: empty.id, notes: 0, bytes: 0 },
    ]);
    expect(fake.calls.map((call) => call.owner).sort()).toEqual([withRepo.id, empty.id].sort());

    // Connecting a repository makes the user an owner; disconnecting takes them off the list.
    store.setKnowledgeRepo(noRepo.id, "team/late-brain", null);
    store.setKnowledgeRepo(withRepo.id, null, null);
    const second = await admin.agent.get("/api/admin/personal-vaults/usage").expect(200);
    expect(second.body.owners).toEqual([
      { userId: empty.id, notes: 0, bytes: 0 },
      { userId: noRepo.id, notes: 1, bytes: Buffer.byteLength("left\n") },
    ]);
  });

  it("an owner whose wiki cannot be listed says why; the others are still counted", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    setUpBrain(store, fake, admin.id, { "CLAUDE.md": "mine\n" });
    setUpBrain(store, fake, owner.id);
    const usage = async () => (await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body.owners;

    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });
    const down = await usage();
    expect(down.filter((entry: { error?: string }) => entry.error === "unavailable")).toHaveLength(1);
    expect(down.filter((entry: { notes?: number }) => typeof entry.notes === "number")).toHaveLength(1);

    fake.failNext(new MemoryRefusedError("forbidden", 403), { op: "list" });
    const refused = await usage();
    expect(refused.filter((entry: { error?: string }) => entry.error === "refused")).toHaveLength(1);
    expect(refused.filter((entry: { notes?: number }) => typeof entry.notes === "number")).toHaveLength(1);

    expect(await usage()).toEqual([
      { userId: admin.id, notes: 1, bytes: Buffer.byteLength("mine\n") },
      { userId: owner.id, notes: 3, bytes: VAULT_BYTES },
    ]);
  });

  it("a listing that never answers is given up after 10 s (`timeout`), without holding the others", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    setUpBrain(store, fake, admin.id, { "CLAUDE.md": "mine\n" });
    setUpBrain(store, fake, owner.id);

    const realList = fake.list.bind(fake);
    const list = vi.spyOn(fake, "list").mockImplementation((userId, prefix) => (userId === owner.id ? new Promise(() => {}) : realList(userId, prefix)));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = admin.agent.get("/api/admin/personal-vaults/usage").then((res) => res);
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2), { timeout: 5000, interval: 5 });
      await vi.advanceTimersByTimeAsync(10_000);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.owners).toEqual([
        { userId: admin.id, notes: 1, bytes: Buffer.byteLength("mine\n") },
        { userId: owner.id, error: "timeout" },
      ]);
    } finally {
      vi.useRealTimers();
      list.mockRestore();
    }
  });

  it("a server without a memory service answers with no owners", async () => {
    const bare = boot({ fake: null });
    const admin = await mkUser(bare.app, "admin");
    const owner = await mkUser(bare.app, "owner");
    bare.store.setKnowledgeRepo(owner.id, "team/brain", null);
    expect((await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body).toEqual({
      serviceConfigured: false,
      limits: { notes: 10_000, bytes: 256 * 1024 * 1024 },
      owners: [],
    });
  });
});

describe("GET /api/me/personal-vault", () => {
  it("serviceConfigured: true with a memory service, and the criterion is a memory client for this server — not the config block by itself", async () => {
    const configured = boot();
    expect(configured.config.memory).toBeDefined();
    const admin = await mkUser(configured.app, "admin");
    expect((await admin.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: true, service: "ok" });

    // A client is installed (as a test double is), but the config carries no `memory` block.
    const services = createServices({ dataDir: path.join(getTempDir(), "data2"), agentRuntime: "local", sessionSecret: "test" });
    expect(services.config.memory).toBeUndefined();
    setMemoryClientForTests(services.store, createFakeMemoryClient());
    const other = await mkUser(createApp(services), "admin");
    expect((await other.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: true, service: "ok" });
  });

  it("false on a server without one: nobody to ask, so `service` is null — with or without a repository", async () => {
    const bare = boot({ fake: null });
    expect(bare.config.memory).toBeUndefined();
    expect(memoryClientFor(bare.store, bare.config)).toBeNull(); // really no client: neither configured nor installed
    await mkUser(bare.app, "admin");
    const owner = await mkUser(bare.app, "owner");
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: false, service: null });
    bare.store.setKnowledgeRepo(owner.id, "team/brain", null);
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: false, service: null });
  });

  it("service: ok when it answers, unavailable when it cannot be used, refused when it answers no — one cheap check of the caller's own wiki", async () => {
    const { app, store, fake } = boot();
    await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    setUpBrain(store, fake, owner.id);

    fake.calls.length = 0;
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: true, service: "ok" });
    // The probe: one listing of the caller's `raw/` folder, nothing else — and never another owner's wiki.
    expect(fake.calls).toEqual([expect.objectContaining({ op: "list", owner: owner.id, prefix: "raw" })]);

    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: true, service: "unavailable" });

    fake.failNext(new MemoryRefusedError("forbidden", 403), { op: "list" });
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ serviceConfigured: true, service: "refused" });

    // Back up: the next read says so. Nothing in the answer says where notes "live" or names a copy.
    const back = await owner.agent.get("/api/me/personal-vault").expect(200);
    expect(back.body).toEqual({ serviceConfigured: true, service: "ok" });
    expect(back.body).not.toHaveProperty("home");
    expect(back.body).not.toHaveProperty("mirror");
    expect(writes(fake)).toEqual([]);
  });
});

describe("deleting a user", () => {
  it("deletes that owner's wiki in the memory service", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    const other = await mkUser(app, "other");
    setUpBrain(store, fake, owner.id);
    setUpBrain(store, fake, other.id, { "CLAUDE.md": "other\n" });

    await admin.agent.delete(`/api/admin/users/${owner.id}`).expect(200);

    await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: owner.id }), { timeout: 10_000 });
    await vi.waitFor(() => expect(fake.dump(owner.id)).toEqual({}), { timeout: 10_000 });
    // Nobody else's wiki is touched, and the usage view no longer lists the deleted owner.
    expect(fake.dump(other.id)).toEqual({ "CLAUDE.md": "other\n" });
    const usage = await admin.agent.get("/api/admin/personal-vaults/usage").expect(200);
    expect(usage.body.owners).toEqual([{ userId: other.id, notes: 1, bytes: Buffer.byteLength("other\n") }]);
  });

  it("is best effort: a service that is down never fails the deletion", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, "admin");
    const owner = await mkUser(app, "owner");
    fake.seed(owner.id, "wiki/a.md", "left behind\n");
    fake.failNext(new MemoryUnavailableError("down", "network"), { op: "deleteWiki" });
    await admin.agent.delete(`/api/admin/users/${owner.id}`).expect(200);
    await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: owner.id }), { timeout: 10_000 });
    expect(store.getUserById(owner.id)).toBeNull();
  });

  it("without a memory service on this server the deletion works as before", async () => {
    const bare = boot({ fake: null });
    const admin2 = await mkUser(bare.app, "admin");
    const gone = await mkUser(bare.app, "gone");
    await admin2.agent.delete(`/api/admin/users/${gone.id}`).expect(200);
    expect(bare.store.getUserById(gone.id)).toBeNull();
  });
});
