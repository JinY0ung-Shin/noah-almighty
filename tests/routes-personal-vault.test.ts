import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { MemoryRefusedError, MemoryUnavailableError, memoryClientFor, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { memoryVaultFor, withVaultWriteLock } from "../src/server/personalVault.js";
import { cutoverVault, onKnowledgeRepoChanged, whenVaultMigrationIdle } from "../src/server/vaultMigration.js";
import { syncVaultMirror } from "../src/server/vaultMirror.js";
import { createFakeMemoryClient, type FakeMemoryClient } from "./helpers/fakeMemory.js";
import { makeBareRemote, signup, withTempDir } from "./helpers.js";

// src/server/routes/personalVault.ts (the admin migration API + the owner's
// settings view) and the user-delete sweep of routes/admin.ts — HTTP-boundary
// tests over a real store, real clones of local bare remotes and the in-process
// fake of the memory service. The git mirror is stubbed (tests/vault-migration
// covers the migration itself, also against the real mirror).

vi.mock("../src/server/vaultMirror.js", async (importOriginal) => ({
  // Everything else of the module is the real thing (the owner's confirmation lists the clone with its helper).
  ...(await importOriginal<typeof import("../src/server/vaultMirror.js")>()),
  syncVaultMirror: vi.fn(),
  startVaultMirrorLoop: vi.fn(() => ({ stop() {} })),
}));

const mirror = vi.mocked(syncVaultMirror);

// Every test here clones real git repositories: room for a loaded machine (the whole suite in parallel).
vi.setConfig({ testTimeout: 30_000 });

const getTempDir = withTempDir("routes-personal-vault");

beforeEach(() => {
  mirror.mockReset();
  mirror.mockImplementation(async (store, _config, userId) => {
    store.recordVaultMirror(userId, { ok: true });
    return { kind: "synced", changed: 0, seq: 0 };
  });
});

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

/** Sign up through the real auth route (the first account is the admin); every account gets a git token. */
async function mkUser(app: App, store: ReturnType<typeof boot>["store"], username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  const id = res.body.user.id as string;
  store.setGitToken(id, "test-token");
  return { agent, id, username };
}

const VAULT: Record<string, string> = {
  "CLAUDE.md": "# standing memory\n",
  "wiki/index.md": "# Index\n",
  "raw/2026-11-01.md": "captured\n",
};

/** A local bare remote on `main` holding `files`, connected as the user's knowledge repository. */
function connect(store: ReturnType<typeof boot>["store"], userId: string, name: string, files: Record<string, string>): string {
  const remotes = path.join(getTempDir(), "remotes");
  fs.mkdirSync(remotes, { recursive: true });
  const remote = makeBareRemote(path.join(remotes, `${name}.git`));
  const seed = path.join(remotes, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "seed@example.com");
  git("config", "user.name", "Seed");
  git("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries({ "README.md": "# brain\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("branch", "-M", "main");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main");
  store.setKnowledgeRepo(userId, remote, "main");
  return remote;
}

const auditOf = (store: ReturnType<typeof boot>["store"], adminId: string, action: string) =>
  store.listAudit(adminId, true).filter((event) => event.action === action);

const writes = (fake: FakeMemoryClient) => fake.calls.filter((call) => call.op === "put" || call.op === "remove" || call.op === "deleteWiki");

describe("personal-vault routes — who may call them", () => {
  it("anonymous → 401 everywhere; a member → 403 on the admin routes and 200 on their own", async () => {
    const { app, store } = boot();
    const admin = await mkUser(app, store, "admin");
    const member = await mkUser(app, store, "member");

    await request(app).get("/api/admin/personal-vaults").expect(401);
    await request(app).post("/api/admin/personal-vaults/dry-run").expect(401);
    await request(app).post("/api/admin/personal-vaults/mode").send({ mode: "memory" }).expect(401);
    await request(app).post("/api/admin/personal-vaults/run").expect(401);
    await request(app).post(`/api/admin/personal-vaults/${member.id}/rollback`).expect(401);
    await request(app).get("/api/me/personal-vault").expect(401);
    await request(app).post("/api/me/personal-vault/mirror-confirm").expect(401);
    await request(app).post("/api/me/personal-vault/mirror-recheck").expect(401);

    await member.agent.get("/api/admin/personal-vaults").expect(403);
    await member.agent.post("/api/admin/personal-vaults/dry-run").expect(403);
    await member.agent.post("/api/admin/personal-vaults/mode").send({ mode: "memory" }).expect(403);
    await member.agent.post("/api/admin/personal-vaults/run").expect(403);
    await member.agent.post(`/api/admin/personal-vaults/${admin.id}/rollback`).expect(403);
    expect(store.getPersonalVaultMode()).toBe("repo");

    const mine = await member.agent.get("/api/me/personal-vault").expect(200);
    expect(mine.body).toEqual({ home: "repo", mirror: null, serviceConfigured: true, service: null });
  });
});

describe("GET /api/admin/personal-vaults and the dry run", () => {
  it("lists every owner with state, repo, mirror and the last report; a dry run fills the reports and changes nothing", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const onRepo = await mkUser(app, store, "onrepo");
    const moved = await mkUser(app, store, "moved");
    const remote = connect(store, onRepo.id, "onrepo", VAULT);
    const movedRemote = connect(store, moved.id, "moved", { "CLAUDE.md": "moved\n" });
    await cutoverVault(store, config, moved.id);
    const row = store.getPersonalVault(moved.id)!;

    const before = await admin.agent.get("/api/admin/personal-vaults").expect(200);
    expect(before.body).toEqual({
      mode: "repo",
      serviceConfigured: true,
      running: false,
      owners: [
        { userId: admin.id, username: "admin", displayName: "admin", state: "no_repo", repo: null, migratedAt: null, mirror: null, report: null },
        { userId: onRepo.id, username: "onrepo", displayName: "onrepo", state: "repo", repo: remote, migratedAt: null, mirror: null, report: null },
        {
          userId: moved.id,
          username: "moved",
          displayName: "moved",
          state: "memory",
          repo: movedRemote,
          migratedAt: row.migratedAt,
          mirror: { dirty: false, syncedAt: row.mirrorSyncedAt, error: null, hold: null, notice: null },
          report: expect.objectContaining({ userId: moved.id, state: "memory", notes: 1, blockers: [] }),
        },
      ],
    });

    fake.calls.length = 0;
    const dry = await admin.agent.post("/api/admin/personal-vaults/dry-run").expect(200);
    expect(dry.body.reports).toEqual([
      { userId: admin.id, repo: null, sourceCommit: null, notes: 0, bytes: 0, skipped: [], blockers: [], state: "no_repo", at: expect.any(String) },
      expect.objectContaining({ userId: onRepo.id, repo: remote, notes: 3, skipped: [], blockers: [], state: "repo" }),
      expect.objectContaining({ userId: moved.id, repo: movedRemote, notes: 1, blockers: [], state: "memory" }),
    ]);
    expect(dry.body.reports[1].sourceCommit).toMatch(/^[0-9a-f]{40}$/);
    // Each report says when it was made: it is the LAST look, which the admin screen dates.
    for (const report of dry.body.reports) expect(Number.isNaN(Date.parse(report.at))).toBe(false);
    // Nothing changed: the service was only read, nobody moved, and a dry run is not an audited change.
    expect(writes(fake)).toEqual([]);
    expect(store.getPersonalVault(onRepo.id)).toBeNull();
    expect(store.listAudit(admin.id, true).filter((event) => event.action.includes("personal_vault"))).toEqual([]);

    const after = await admin.agent.get("/api/admin/personal-vaults").expect(200);
    expect(after.body.owners.map((owner: { report: unknown }) => owner.report)).toEqual(dry.body.reports);
  });
});

describe("POST /api/admin/personal-vaults/mode and /run", () => {
  it("mode `memory` starts the pass in the background; `repo` stops new cutovers and rolls nobody back", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);

    await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "open" }).expect(400);
    await admin.agent.post("/api/admin/personal-vaults/mode").send({}).expect(400);
    expect(store.getPersonalVaultMode()).toBe("repo");

    const set = await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "memory" }).expect(200);
    expect(set.body).toEqual({ mode: "memory", started: true });
    expect(store.getPersonalVaultMode()).toBe("memory");
    await whenVaultMigrationIdle(store);
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(fake.dump(owner.id)).toEqual(VAULT);
    expect(auditOf(store, admin.id, "set_personal_vault_mode")).toEqual([
      expect.objectContaining({ actorName: "admin", status: "success", detail: "personal vault mode = memory (migration pass started)" }),
    ]);

    const view = await admin.agent.get("/api/admin/personal-vaults").expect(200);
    expect(view.body).toMatchObject({ mode: "memory", running: false });
    expect(view.body.owners[1]).toMatchObject({ userId: owner.id, state: "memory", report: { state: "memory", notes: 3 } });

    const back = await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "repo" }).expect(200);
    expect(back.body).toEqual({ mode: "repo", started: false });
    await whenVaultMigrationIdle(store);
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(fake.dump(owner.id)).toEqual(VAULT);
    expect(auditOf(store, admin.id, "set_personal_vault_mode")).toHaveLength(2);
  });

  it("run: refused while the mode is `repo`; 202 and one pass at a time otherwise", async () => {
    const { app, store } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);

    const refused = await admin.agent.post("/api/admin/personal-vaults/run").expect(409);
    expect(refused.body.error).toContain("메모리 서비스");
    expect(store.getPersonalVault(owner.id)).toBeNull();
    expect(auditOf(store, admin.id, "personal_vault_run")).toEqual([]);

    store.setPersonalVaultMode("memory");
    // Hold the pass open inside the first mirror record.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mirror.mockImplementation(async (s, _config, userId) => {
      await gate;
      s.recordVaultMirror(userId, { ok: true });
      return { kind: "synced", changed: 0, seq: 0 };
    });
    const first = await admin.agent.post("/api/admin/personal-vaults/run").expect(202);
    expect(first.body).toEqual({ started: true });
    const second = await admin.agent.post("/api/admin/personal-vaults/run").expect(202);
    expect(second.body).toEqual({ started: false });
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.running).toBe(true);

    release();
    await whenVaultMigrationIdle(store);
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.running).toBe(false);
    expect(auditOf(store, admin.id, "personal_vault_run")).toEqual([expect.objectContaining({ status: "success" })]);
  });
});

describe("the memory service is not configured on this server", () => {
  it("says so on every route that needs it, in words a teammate can read", async () => {
    const { app, store, config } = boot({ fake: null });
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);

    const view = await admin.agent.get("/api/admin/personal-vaults").expect(200);
    expect(view.body).toMatchObject({ mode: "repo", serviceConfigured: false, running: false });

    const mode = await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "memory" }).expect(409);
    const run = await admin.agent.post("/api/admin/personal-vaults/run").expect(409);
    for (const res of [mode, run]) {
      expect(res.body.error).toContain("메모리 서비스가 설정되어 있지 않습니다");
      expect(res.body.error).not.toMatch(/pi-gateway/i);
    }
    expect(store.getPersonalVaultMode()).toBe("repo");
    expect(store.listAudit(admin.id, true).filter((event) => event.action.includes("personal_vault"))).toEqual([]);

    // Going back to `repo` needs no service.
    await admin.agent.post("/api/admin/personal-vaults/mode").send({ mode: "repo" }).expect(200);

    const dry = await admin.agent.post("/api/admin/personal-vaults/dry-run").expect(200);
    expect(dry.body.reports[1]).toMatchObject({
      userId: owner.id,
      state: "repo",
      notes: 3,
      blockers: ["memory_not_configured: this server has no memory service configured"],
    });

    // An owner whose row says `memory` (moved while the service was configured) cannot be rolled back without it.
    store.setPersonalVaultMemory(owner.id, { sourceRepo: "x", sourceCommit: null });
    const rollback = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "memory" }).expect(409);
    expect(rollback.body.error).toContain("메모리 서비스가 설정되어 있지 않습니다");
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(memoryVaultFor(store, config, owner.id)).not.toBeNull();
  });
});

describe("POST /api/admin/personal-vaults/:userId/rollback", () => {
  it("moves one owner back, audited; 404 for an unknown user", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await cutoverVault(store, config, owner.id);

    await admin.agent.post("/api/admin/personal-vaults/nobody/rollback").send({ expect: "memory" }).expect(404);

    // The body says which of the two actions the screen offered; without it nothing is done.
    await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).expect(400);
    await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "both" }).expect(400);
    // A stale screen: "남은 사본 비우기" pressed for an owner who is in the memory service by now.
    const stale = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "repo" }).expect(409);
    expect(stale.body.error).toContain("화면에 보이던 것과 다릅니다");
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(fake.dump(owner.id)).toEqual(VAULT);
    expect(mirror).toHaveBeenCalledTimes(1); // the cutover's first mirror record only: no rollback was started

    const ownerReport = async () =>
      ((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.owners as { userId: string; report: unknown }[]).find(
        (entry) => entry.userId === owner.id,
      )!.report;
    // The cutover's report is still shown before the rollback …
    expect(await ownerReport()).toMatchObject({ state: "memory", notes: 3 });

    const res = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "memory" }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(store.getPersonalVault(owner.id)).toBeNull();
    expect(fake.dump(owner.id)).toEqual({});
    // … and dropped by it: it described the vault in the service, which is not this owner's state any more.
    expect(await ownerReport()).toBeNull();
    expect(auditOf(store, admin.id, "personal_vault_rollback").map((event) => [event.status, event.detail])).toEqual([
      ["success", `personal vault of ${owner.id} moved back to the repository`],
      ["error", `rollback of ${owner.id} refused: home_mismatch`],
    ]);
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ home: "repo", mirror: null, serviceConfigured: true, service: null });

    // … and the reverse: a stale "되돌리기" for an owner who is on the repository (a leftover copy is there).
    fake.seed(owner.id, "wiki/left.md", "left\n");
    const reverse = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "memory" }).expect(409);
    expect(reverse.body.error).toContain("화면에 보이던 것과 다릅니다");
    expect(fake.dump(owner.id)).toEqual({ "wiki/left.md": "left\n" });
  });

  it("an owner already on the repository: the leftover copy is discarded, and the audit row carries the counts", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await admin.agent.post("/api/admin/personal-vaults/dry-run").expect(200); // the clone is on disk
    for (const [notePath, content] of Object.entries(VAULT)) fake.seed(owner.id, notePath, content);
    fake.seed(owner.id, "wiki/only-here.md", "only in the service\n");

    // A note that cannot be read: refused, nothing deleted.
    fake.failNext(new MemoryUnavailableError("down", "network"), { op: "read" });
    const refused = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "repo" }).expect(409);
    expect(refused.body.error).toContain("아무것도 지우거나 바꾸지 않았습니다");
    // The report that offers the button is still there after a refusal …
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.owners[1].report).not.toBeNull();
    expect(Object.keys(fake.dump(owner.id))).toHaveLength(4);

    const res = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "repo" }).expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(fake.dump(owner.id)).toEqual({});
    // … and gone once the copy it named is gone (it used to come back, with its button, after a refresh).
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.owners[1].report).toBeNull();
    const stamps = fs.readdirSync(path.join(config.dataDir, "retired"));
    expect(stamps).toHaveLength(1);
    expect(fs.existsSync(path.join(config.dataDir, "retired", stamps[0], "personal-vault-leftover", owner.id))).toBe(true);
    expect(auditOf(store, admin.id, "personal_vault_rollback").map((event) => [event.status, event.detail])).toEqual([
      ["success", `leftover copy of ${owner.id} in the memory service discarded (4 notes; 1 not in the repository were quarantined first)`],
      ["error", `rollback of ${owner.id} refused: leftover_not_saved`],
    ]);
  });

  it("a held retirement gate → 409 that says the server is holding maintenance steps, without promising a backup", async () => {
    const { app, store, config } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await cutoverVault(store, config, owner.id);
    vi.spyOn(store, "retirementGate").mockReturnValue({ allowed: false, stamp: "x", backupPath: null });

    const res = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "memory" }).expect(409);
    expect(res.body.error).toContain("데이터베이스 백업에 실패해, 데이터를 바꾸는 정비 작업을 보류하고 있습니다");
    expect(res.body.error).toContain("서버를 다시 시작하기 전에는 되돌리지 않습니다");
    expect(res.body.error).not.toContain("백업이 되기 전에는");
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(mirror).toHaveBeenCalledTimes(1); // the cutover's first mirror record only
  });

  it.each([
    [{ kind: "failed", error: "push rejected (non-fast-forward)" } as const, "저장소 사본을 최신으로 올리지 못해 되돌릴 수 없습니다", "push rejected (non-fast-forward)"],
    [{ kind: "skipped", reason: "hold" } as const, "저장소 사본이 보류 중이라", ""],
    [{ kind: "skipped", reason: "repo_dirty" } as const, "아바타에게 저장소 커밋을 요청하면", ""],
    [{ kind: "skipped", reason: "no_repo" } as const, "연결된 저장소가 없어", ""],
  ])("a mirror that cannot be brought up to date (%j) → 409 with the reason, audited as an error", async (outcome, sentence, detail) => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await cutoverVault(store, config, owner.id);
    mirror.mockResolvedValue(outcome);

    const res = await admin.agent.post(`/api/admin/personal-vaults/${owner.id}/rollback`).send({ expect: "memory" }).expect(409);
    expect(res.body.error).toContain(sentence);
    expect(res.body.error).toContain(detail);
    expect(res.body.error).not.toMatch(/pi-gateway/i);
    expect(store.getPersonalVault(owner.id)).not.toBeNull();
    expect(fake.dump(owner.id)).toEqual(VAULT);
    expect(auditOf(store, admin.id, "personal_vault_rollback")).toEqual([expect.objectContaining({ status: "error" })]);
  });
});

describe("the owner's own view and the mirror confirmation", () => {
  it("shows the home and the mirror: hold state and notice included", async () => {
    const { app, store, config } = boot();
    await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);

    // Home `repo`: no mirror.
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ home: "repo", mirror: null, serviceConfigured: true, service: null });

    await cutoverVault(store, config, owner.id);
    store.recordVaultMirror(owner.id, { ok: true, notice: "2 repository notes are not in the memory service" });
    store.setVaultMirrorHold(owner.id, "checking");
    store.recordVaultMirror(owner.id, { ok: false, error: "no git token" });
    const row = store.getPersonalVault(owner.id)!;
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({
      home: "memory",
      serviceConfigured: true,
      service: "ok",
      mirror: {
        dirty: false,
        syncedAt: row.mirrorSyncedAt,
        error: "no git token",
        hold: "checking",
        notice: "2 repository notes are not in the memory service",
      },
    });
    store.setVaultMirrorHold(owner.id, "confirm");
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body.mirror.hold).toBe("confirm");

    // An owner in `memory` with no repository connected still gets the mirror object.
    store.setVaultMirrorHold(owner.id, null);
    store.setKnowledgeRepo(owner.id, null, null);
    const noRepo = await owner.agent.get("/api/me/personal-vault").expect(200);
    expect(noRepo.body).toMatchObject({ home: "memory", mirror: { hold: null } });
  });

  describe("POST /api/me/personal-vault/mirror-confirm", () => {
    /** An owner in `memory` who connected a repository with two vault notes of its own; the look ended in `confirm`. */
    async function asked() {
      const b = boot();
      await mkUser(b.app, b.store, "admin");
      const owner = await mkUser(b.app, b.store, "owner");
      const first = connect(b.store, owner.id, "brain", VAULT);
      await cutoverVault(b.store, b.config, owner.id);
      const repo = connect(b.store, owner.id, "second", {
        "CLAUDE.md": "another memory\n",
        "wiki/theirs.md": "theirs\n",
        "raw/theirs-too.md": "theirs too\n",
        "skills/x/SKILL.md": "---\nname: x\n---\n",
      });
      onKnowledgeRepoChanged(b.store, b.config, owner.id, first);
      await whenVaultMigrationIdle(b.store);
      expect(b.store.getPersonalVault(owner.id)).toMatchObject({ mirrorHold: "confirm", mirrorDirty: false });
      const confirm = (body?: Record<string, unknown>) => owner.agent.post("/api/me/personal-vault/mirror-confirm").send(body);
      const unchanged = (hold: "checking" | "confirm" | null) => {
        expect(b.store.getPersonalVault(owner.id)).toMatchObject({ mirrorHold: hold, mirrorDirty: false });
        expect(b.store.listVaultDeletes(owner.id)).toEqual([]);
        expect(auditOf(b.store, owner.id, "personal_vault_mirror_confirm")).toEqual([]);
      };
      return { ...b, owner, first, repo, confirm, unchanged };
    }

    it("200: the repository-only notes go into the deletion ledger, the hold is lifted, and the audit row carries the count", async () => {
      const s = await asked();
      const confirmed = await s.confirm({ repo: s.repo, branch: "main" }).expect(200);
      expect(confirmed.body).toEqual({ ok: true });
      expect(s.store.getPersonalVault(s.owner.id)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
      expect(s.store.listVaultDeletes(s.owner.id)).toEqual(["raw/theirs-too.md", "wiki/theirs.md"]);
      expect(auditOf(s.store, s.owner.id, "personal_vault_mirror_confirm")).toEqual([
        expect.objectContaining({
          actorUserId: s.owner.id,
          actorName: "owner",
          status: "success",
          detail: `confirmed: the memory service's vault replaces the vault notes of ${s.repo} (main) (2 repository-only notes will be removed)`,
        }),
      ]);
      expect((await s.owner.agent.get("/api/me/personal-vault").expect(200)).body).toMatchObject({ home: "memory", mirror: { hold: null, dirty: true } });

      // Pressed twice: the second one has nothing to confirm, and records nothing more.
      expect((await s.confirm({ repo: s.repo, branch: "main" }).expect(409)).body.error).toContain("확인할 것이 없습니다");
      expect(auditOf(s.store, s.owner.id, "personal_vault_mirror_confirm")).toHaveLength(1);
    });

    it("a repository connected without a branch is confirmed with a null branch", async () => {
      const s = await asked();
      s.store.setKnowledgeRepo(s.owner.id, s.repo, null);
      await s.confirm({ repo: s.repo, branch: "main" }).expect(409);
      s.unchanged("confirm");
      await s.confirm({ repo: s.repo, branch: null }).expect(200);
      expect(auditOf(s.store, s.owner.id, "personal_vault_mirror_confirm")[0].detail).toBe(
        `confirmed: the memory service's vault replaces the vault notes of ${s.repo} (2 repository-only notes will be removed)`,
      );
    });

    it("409: home `repo`, `checking`, no hold, and a repository or branch that is not the one the screen showed", async () => {
      // Home `repo`: nothing to confirm.
      const bare = boot();
      await mkUser(bare.app, bare.store, "admin");
      const onRepo = await mkUser(bare.app, bare.store, "owner");
      const remote = connect(bare.store, onRepo.id, "brain", VAULT);
      const refused = await onRepo.agent.post("/api/me/personal-vault/mirror-confirm").send({ repo: remote, branch: "main" }).expect(409);
      expect(refused.body.error).toBe("개인 브레인이 저장소에 있어 확인할 사본이 없습니다.");
    });

    it("409 (continued): the three refusals of an owner in `memory` change nothing", async () => {
      const s = await asked();
      // The screen showed another repository, another branch, or sent nothing.
      for (const body of [{ repo: `${s.repo}-other`, branch: "main" }, { repo: s.repo, branch: "dev" }, { repo: s.repo }, {}, undefined]) {
        expect((await s.confirm(body).expect(409)).body.error).toBe(
          "연결된 저장소나 브랜치가 화면에 보이던 것과 다릅니다. 아무것도 바꾸지 않았습니다. 화면을 새로 고친 뒤 다시 확인해 주세요.",
        );
        s.unchanged("confirm");
      }
      // `checking`: nobody has looked at the repository yet — there is nothing the owner could be confirming.
      s.store.setVaultMirrorHold(s.owner.id, "checking");
      expect((await s.confirm({ repo: s.repo, branch: "main" }).expect(409)).body.error).toBe(
        "새로 연결한 저장소를 아직 확인하는 중입니다. 확인이 끝난 뒤, 필요할 때만 다시 물어봅니다.",
      );
      s.unchanged("checking");
      // No hold.
      s.store.setVaultMirrorHold(s.owner.id, null);
      expect((await s.confirm({ repo: s.repo, branch: "main" }).expect(409)).body.error).toBe("지금은 확인할 것이 없습니다. 화면을 새로 고쳐 주세요.");
      s.unchanged(null);
    });

    it("503: the repository or the memory service cannot be read now — nothing is changed, and the same press works later", async () => {
      const s = await asked();
      const sentence = "지금 저장소나 메모리 서비스를 읽지 못해 확인을 적용하지 못했습니다. 아무것도 바꾸지 않았습니다. 잠시 후 다시 눌러 주세요.";

      // The memory service does not answer.
      s.fake.failNext(new MemoryUnavailableError("down", "network"), { op: "list" });
      const down = await s.confirm({ repo: s.repo, branch: "main" }).expect(503);
      expect(down.body.error).toBe(sentence);
      expect(down.body.error).not.toMatch(/pi-gateway/i);
      s.unchanged("confirm");

      // No git token: the repository cannot be synced.
      s.store.setGitToken(s.owner.id, null);
      expect((await s.confirm({ repo: s.repo, branch: "main" }).expect(503)).body.error).toBe(sentence);
      s.unchanged("confirm");

      s.store.setGitToken(s.owner.id, "test-token");
      await s.confirm({ repo: s.repo, branch: "main" }).expect(200);
      expect(s.store.listVaultDeletes(s.owner.id)).toEqual(["raw/theirs-too.md", "wiki/theirs.md"]);
    });

    it("a press while something else holds the owner's write queue waits, then applies", async () => {
      const s = await asked();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const busy = withVaultWriteLock(s.store, s.owner.id, () => gate); // a tool call, a cutover, a rollback
      let status: number | null = null;
      const pressed = s.confirm({ repo: s.repo, branch: "main" }).then((res) => {
        status = res.status;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(status).toBeNull();
      s.unchanged("confirm");

      open();
      await busy;
      const res = await pressed;
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(s.store.getPersonalVault(s.owner.id)).toMatchObject({ mirrorHold: null, mirrorDirty: true });
      expect(s.store.listVaultDeletes(s.owner.id)).toEqual(["raw/theirs-too.md", "wiki/theirs.md"]);
    });
  });
});

describe("GET /api/me/personal-vault says whether this server has a memory service at all", () => {
  it("serviceConfigured: true with a memory config, false without — whatever the owner's home is", async () => {
    const configured = boot();
    expect(configured.config.memory).toBeDefined();
    await mkUser(configured.app, configured.store, "admin");
    const owner = await mkUser(configured.app, configured.store, "owner");
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ home: "repo", mirror: null, serviceConfigured: true, service: null });
    connect(configured.store, owner.id, "brain", VAULT);
    await cutoverVault(configured.store, configured.config, owner.id);
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toMatchObject({ home: "memory", serviceConfigured: true });
    // The same answer as the admin view's.
    const admin = request.agent(configured.app);
    await admin.post("/api/auth/login").send({ username: "admin", password: "password123" }).expect(200);
    expect((await admin.get("/api/admin/personal-vaults").expect(200)).body.serviceConfigured).toBe(true);
  });

  it("the criterion is the admin view's — a memory client for this server — not the config block by itself", async () => {
    // A client is installed (as a test double is), but the config carries no `memory` block.
    const services = createServices({ dataDir: path.join(getTempDir(), "data"), agentRuntime: "local", sessionSecret: "test" });
    expect(services.config.memory).toBeUndefined();
    setMemoryClientForTests(services.store, createFakeMemoryClient());
    const app = createApp(services);
    const admin = await mkUser(app, services.store, "admin");
    expect((await admin.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ home: "repo", mirror: null, serviceConfigured: true, service: null });
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.serviceConfigured).toBe(true);
  });

  it("false on a server without one — also for an owner whose row still says `memory`", async () => {
    const bare = boot({ fake: null });
    expect(bare.config.memory).toBeUndefined();
    expect(memoryClientFor(bare.store, bare.config)).toBeNull(); // really no client: neither configured nor installed
    const admin = await mkUser(bare.app, bare.store, "admin");
    const owner = await mkUser(bare.app, bare.store, "owner");
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body).toEqual({ home: "repo", mirror: null, serviceConfigured: false, service: null });
    // Moved while the service was configured; this server was then started without it.
    bare.store.setPersonalVaultMemory(owner.id, { sourceRepo: "x", sourceCommit: null });
    const mine = await owner.agent.get("/api/me/personal-vault").expect(200);
    // No client to ask: `service` is null, and the card's "not configured" line is what speaks.
    expect(mine.body).toMatchObject({ home: "memory", serviceConfigured: false, service: null, mirror: { hold: null } });
    expect((await admin.agent.get("/api/admin/personal-vaults").expect(200)).body.serviceConfigured).toBe(false);
  });
});

describe("GET /api/admin/personal-vaults/usage", () => {
  it("admin only; per MOVED owner the note count and bytes against the service's limits — never a path or content", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const moved = await mkUser(app, store, "moved");
    const onRepo = await mkUser(app, store, "onrepo");
    connect(store, moved.id, "moved", VAULT);
    connect(store, onRepo.id, "onrepo", VAULT);
    await cutoverVault(store, config, moved.id);

    await request(app).get("/api/admin/personal-vaults/usage").expect(401);
    await moved.agent.get("/api/admin/personal-vaults/usage").expect(403);

    fake.calls.length = 0;
    const res = await admin.agent.get("/api/admin/personal-vaults/usage").expect(200);
    const bytes = Object.values(VAULT).reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    expect(res.body).toEqual({
      serviceConfigured: true,
      limits: { notes: 10_000, bytes: 256 * 1024 * 1024 },
      // Only the owner whose vault lives in the service; the one on the repository is not listed.
      owners: [{ userId: moved.id, notes: Object.keys(VAULT).length, bytes }],
    });
    // Counts only: no note path or text of the owner's brain leaves the server here.
    for (const [path, text] of Object.entries(VAULT)) {
      expect(JSON.stringify(res.body)).not.toContain(path);
      expect(JSON.stringify(res.body)).not.toContain(text.trim());
    }
    // It only lists: nothing was written or deleted.
    expect(writes(fake)).toEqual([]);
    expect(fake.calls.map((call) => call.op)).toEqual(["list"]);
  });

  it("an owner whose wiki cannot be listed says why; the others are still counted", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await cutoverVault(store, config, owner.id);

    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });
    expect((await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body.owners).toEqual([{ userId: owner.id, error: "unavailable" }]);
    fake.failNext(new MemoryRefusedError("forbidden", 403), { op: "list" });
    expect((await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body.owners).toEqual([{ userId: owner.id, error: "refused" }]);
    expect((await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body.owners[0]).toMatchObject({ userId: owner.id, notes: 3 });
  });

  it("a server without a memory service answers with no owners", async () => {
    const bare = boot({ fake: null });
    const admin = await mkUser(bare.app, bare.store, "admin");
    const owner = await mkUser(bare.app, bare.store, "owner");
    bare.store.setPersonalVaultMemory(owner.id, { sourceRepo: "x", sourceCommit: null });
    expect((await admin.agent.get("/api/admin/personal-vaults/usage").expect(200)).body).toMatchObject({ serviceConfigured: false, owners: [] });
  });
});

describe("GET /api/me/personal-vault checks the memory service for an owner on home `memory`", () => {
  it("service: ok when it answers, unavailable when it cannot be used, refused when it answers no — null on home `repo`", async () => {
    const { app, store, config, fake } = boot();
    await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    // Home `repo`: nothing is asked of the service.
    fake.calls.length = 0;
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body.service).toBeNull();
    expect(fake.calls).toEqual([]);

    connect(store, owner.id, "brain", VAULT);
    await cutoverVault(store, config, owner.id);
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body.service).toBe("ok");

    // An outage: the copy's state is still reported, and the card is told the brain cannot be used now.
    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error", "network"), { op: "list" });
    const down = await owner.agent.get("/api/me/personal-vault").expect(200);
    expect(down.body).toMatchObject({ home: "memory", serviceConfigured: true, service: "unavailable", mirror: { hold: null } });

    fake.failNext(new MemoryRefusedError("forbidden", 403), { op: "list" });
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body.service).toBe("refused");

    // Back up: the next read says so.
    expect((await owner.agent.get("/api/me/personal-vault").expect(200)).body.service).toBe("ok");
  });
});

describe("POST /api/me/personal-vault/mirror-recheck", () => {
  it("runs the look at a newly connected repository again — only while the hold is `checking`", async () => {
    const { app, store, config } = boot();
    await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    await request(app).post("/api/me/personal-vault/mirror-recheck").expect(401);

    // Home `repo`, and no hold: nothing to look at again.
    expect((await owner.agent.post("/api/me/personal-vault/mirror-recheck").expect(202)).body).toEqual({ started: false });
    await cutoverVault(store, config, owner.id);
    expect((await owner.agent.post("/api/me/personal-vault/mirror-recheck").expect(202)).body).toEqual({ started: false });

    // The owner connects a repository with vault notes of its own, but has no git token: it cannot be looked at.
    store.setGitToken(owner.id, null);
    connect(store, owner.id, "second", { "wiki/theirs.md": "theirs\n" });
    onKnowledgeRepoChanged(store, config, owner.id, null);
    await whenVaultMigrationIdle(store);
    expect(store.getPersonalVault(owner.id)).toMatchObject({ mirrorHold: "checking" });

    // They store a token and ask again: the look runs now and settles it.
    store.setGitToken(owner.id, "test-token");
    expect((await owner.agent.post("/api/me/personal-vault/mirror-recheck").expect(202)).body).toEqual({ started: true });
    await whenVaultMigrationIdle(store);
    expect(store.getPersonalVault(owner.id)).toMatchObject({ mirrorHold: "confirm" });

    // `confirm` is the owner's decision, not something to look at again.
    expect((await owner.agent.post("/api/me/personal-vault/mirror-recheck").expect(202)).body).toEqual({ started: false });
    expect(store.getPersonalVault(owner.id)).toMatchObject({ mirrorHold: "confirm" });
  });
});

describe("deleting a user", () => {
  it("deletes that owner's wiki in the memory service", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    const other = await mkUser(app, store, "other");
    connect(store, owner.id, "brain", VAULT);
    connect(store, other.id, "other", { "CLAUDE.md": "other\n" });
    await cutoverVault(store, config, owner.id);
    await cutoverVault(store, config, other.id);

    await admin.agent.delete(`/api/admin/users/${owner.id}`).expect(200);

    await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: owner.id }), { timeout: 10_000 });
    await vi.waitFor(() => expect(fake.dump(owner.id)).toEqual({}), { timeout: 10_000 });
    expect(store.getPersonalVault(owner.id)).toBeNull();
    // Nobody else's wiki is touched.
    expect(fake.dump(other.id)).toEqual({ "CLAUDE.md": "other\n" });
    expect(store.getPersonalVault(other.id)).not.toBeNull();
  });

  it("a user deleted in the middle of their cutover: the wiki is not left behind and no row comes back", async () => {
    const { app, store, config, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    connect(store, owner.id, "brain", VAULT);
    // The cutover is in the middle of its import when the admin deletes the account.
    fake.beforeNext("put", async () => {
      await admin.agent.delete(`/api/admin/users/${owner.id}`).expect(200);
    });
    const report = await cutoverVault(store, config, owner.id);

    // The delete handler also removes the clone, so the import stops at the next file it reads; had every
    // file been read already, the last look before the flip finds the user gone. Either way: no flip.
    expect(report.state).not.toBe("memory");
    expect(["no_user", "source_changed"]).toContain(report.blockers[0].split(":")[0]);
    expect(store.getPersonalVault(owner.id)).toBeNull();
    expect(store.listPersonalVaults()).toEqual([]);
    // The sweep's delete ran BEHIND the cutover in the owner's write queue: it is the last word.
    await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: owner.id }), { timeout: 10_000 });
    expect(fake.dump(owner.id)).toEqual({});
  });

  it("is best effort: a service that is down never fails the deletion", async () => {
    const { app, store, fake } = boot();
    const admin = await mkUser(app, store, "admin");
    const owner = await mkUser(app, store, "owner");
    fake.seed(owner.id, "wiki/a.md", "left behind\n");
    fake.failNext(new MemoryUnavailableError("down", "network"), { op: "deleteWiki" });
    await admin.agent.delete(`/api/admin/users/${owner.id}`).expect(200);
    await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ op: "deleteWiki", owner: owner.id }), { timeout: 10_000 });
    expect(store.getUserById(owner.id)).toBeNull();
  });

  it("without a memory service on this server the deletion works as before", async () => {
    const bare = boot({ fake: null });
    const admin2 = await mkUser(bare.app, bare.store, "admin");
    const gone = await mkUser(bare.app, bare.store, "gone");
    await admin2.agent.delete(`/api/admin/users/${gone.id}`).expect(200);
    expect(bare.store.getUserById(gone.id)).toBeNull();
  });
});
