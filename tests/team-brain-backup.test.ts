import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { countTeamNotes, readTeamNote, readTeamVaultFile, teamBrainRoot, teamVaultSchemaVersionSync } from "../src/server/teamBrain.js";
import { seedTeamVault, teamPage } from "./team-brain-fixtures.js";
import { signup, withTempDir } from "./helpers.js";

// The mirror is pushed over https to the INTERNAL host; here git's own
// `url.<local>.insteadOf` (a temp global config) rewrites that URL to a local
// bare repo, so the real push/clone code path runs with no network.
const HOST = "git.internal.test";
const MIRROR_URL = `https://${HOST}/team/brain.git`;
const dir = withTempDir("team-brain-backup");
let services: ReturnType<typeof createServices> | undefined;
let mirrorRoot = "";
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

beforeAll(() => {
  mirrorRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "tb-mirror-"));
  execFileSync("git", ["init", "--bare", "--quiet", path.join(mirrorRoot, "brain.git")]);
  const cfg = path.join(mirrorRoot, "gitconfig");
  fs.writeFileSync(cfg, `[url "file://${path.join(mirrorRoot, "brain.git")}"]\n\tinsteadOf = ${MIRROR_URL}\n`);
  process.env.GIT_CONFIG_GLOBAL = cfg;
});
afterAll(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  fs.rmSync(mirrorRoot, { recursive: true, force: true });
});
afterEach(() => {
  services?.teamBrainBackup?.stop();
  services?.store.close();
  services = undefined;
});

async function boot(dataDir = dir()) {
  services = createServices({ dataDir, agentRuntime: "local", sessionSecret: "test", githubHost: HOST });
  const app = createApp(services);
  const admin = request.agent(app);
  const mate = request.agent(app);
  const adminUser = (await signup(admin, "admin").expect(201)).body.user;
  const mateUser = (await signup(mate, "mate").expect(201)).body.user;
  services.store.setUserSecret(adminUser.id, "GIT_TOKEN", "tok-admin-123456");
  return { ...services, app, admin, mate, adminUser, mateUser };
}

const PAGE_PATH = "wiki/howto/deploy.md";
const NOTE = teamPage({ title: "배포", body: "배포는 compose up." });
const seedNote = (config: { dataDir: string }) => seedTeamVault(config, [{ path: PAGE_PATH, content: NOTE }]);

describe("team brain backup", () => {
  it("is admin-only and refuses a non-internal host, a local path and a bad branch", async () => {
    const s = await boot();
    await s.mate.get("/api/admin/team-brain").expect(403);
    await s.mate.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL }).expect(403);
    const external = await s.admin.put("/api/admin/team-brain/backup").send({ url: "https://github.com/x/y.git" }).expect(400);
    expect(external.body.error).toContain("사내 git host");
    await s.admin.put("/api/admin/team-brain/backup").send({ url: path.join(mirrorRoot, "brain.git") }).expect(400);
    await s.admin.put("/api/admin/team-brain/backup").send({ url: "ext::sh -c x" }).expect(400);
    await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "--force" }).expect(400);
    await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "a..b" }).expect(400);
  });

  it("pushes the vault with the saving admin's token, records the state, and restores into an empty vault", async () => {
    const s = await boot();
    await seedNote(s.config);
    const saved = await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "backup" }).expect(200);
    expect(saved.body.backup).toMatchObject({ url: MIRROR_URL, branch: "backup", adminName: "admin", lastOkAt: null });
    const pushed = await s.admin.post("/api/admin/team-brain/backup/push").expect(200);
    expect(pushed.body.backup.lastOkAt).toBeTruthy();
    expect(pushed.body.backup.lastError).toBeNull();
    const mirrorLog = execFileSync("git", ["-C", path.join(mirrorRoot, "brain.git"), "log", "--format=%s", "backup"]).toString();
    expect(mirrorLog).toContain("team-brain: seed");
    // The vault keeps no remote: the mirror is push-only, by URL.
    expect(execFileSync("git", ["-C", teamBrainRoot(s.config), "remote"]).toString().trim()).toBe("");
    // The token never lands on disk in the vault's config.
    expect(fs.readFileSync(path.join(teamBrainRoot(s.config), ".git", "config"), "utf8")).not.toContain("tok-admin");

    // A vault with notes refuses a restore.
    const refused = await s.admin.post("/api/admin/team-brain/backup/restore").expect(409);
    expect(refused.body.error).toContain("이미 노트가 있어");

    // A lost volume: a fresh deployment, the URL re-entered, 복원.
    services?.store.close();
    services = undefined;
    const fresh = await boot(dir() + "-fresh");
    await fresh.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "backup" }).expect(200);
    const restored = await fresh.admin.post("/api/admin/team-brain/backup/restore").expect(200);
    expect(restored.body.noteCount).toBe(1);
    expect(await readTeamNote(fresh.config, PAGE_PATH)).toBe(NOTE);
    expect(execFileSync("git", ["-C", teamBrainRoot(fresh.config), "remote"]).toString().trim()).toBe("");
    expect(await countTeamNotes(fresh.config)).toBe(1);
  });

  it("migrates a pre-schema mirror right after restoring it, and treats raw sources as content", async () => {
    // A mirror pushed by an older build: notes straight under wiki/, no SCHEMA.md.
    const scratch = fs.mkdtempSync(path.join(mirrorRoot, "v0-"));
    execFileSync("git", ["-C", scratch, "init", "--quiet", "--initial-branch=v0"]);
    fs.mkdirSync(path.join(scratch, "wiki", "concepts"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "wiki", "index.md"), "# Team brain\n");
    fs.writeFileSync(path.join(scratch, "wiki", "concepts", "deploy.md"), "old note\n");
    execFileSync("git", ["-C", scratch, "add", "-A"]);
    execFileSync("git", ["-C", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "--quiet", "-m", "team-brain: old"]);
    execFileSync("git", ["-C", scratch, "push", "--quiet", path.join(mirrorRoot, "brain.git"), "v0:refs/heads/v0"]);
    const s = await boot();
    await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "v0" }).expect(200);
    const restored = await s.admin.post("/api/admin/team-brain/backup/restore").expect(200);
    expect(restored.body.noteCount).toBe(0);
    expect(teamVaultSchemaVersionSync(s.config)).toBe(1);
    expect(await readTeamVaultFile(s.config, "raw/legacy/concepts/deploy.md")).toBe("old note\n");
    // The admin panel shows how much is waiting to be compiled.
    expect((await s.admin.get("/api/admin/team-brain").expect(200)).body).toMatchObject({ noteCount: 0, rawSources: 1, uncompiledSources: 1 });
    // Only raw sources, no pages — still not an empty vault: a second restore is refused.
    const refused = await s.admin.post("/api/admin/team-brain/backup/restore").expect(409);
    expect(refused.body.error).toContain("이미 노트가 있어");
  });

  it("never force-pushes: a branch with history the vault does not know is refused, not overwritten", async () => {
    const s = await boot();
    await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL, branch: "foreign" }).expect(200);
    // Someone else's history already sits on that branch (a project repo, or a mirror after a lost volume).
    const scratch = fs.mkdtempSync(path.join(mirrorRoot, "foreign-"));
    execFileSync("git", ["-C", scratch, "init", "--quiet", "--initial-branch=foreign"]);
    fs.writeFileSync(path.join(scratch, "README.md"), "project");
    execFileSync("git", ["-C", scratch, "add", "README.md"]);
    execFileSync("git", ["-C", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "--quiet", "-m", "project"]);
    execFileSync("git", ["-C", scratch, "push", "--quiet", path.join(mirrorRoot, "brain.git"), "foreign:refs/heads/foreign"]);
    const before = execFileSync("git", ["-C", path.join(mirrorRoot, "brain.git"), "rev-parse", "foreign"]).toString().trim();
    await seedNote(s.config);
    const r = await s.admin.post("/api/admin/team-brain/backup/push").expect(502);
    expect(r.body.error).toContain("덮어쓰지 않습니다");
    expect(execFileSync("git", ["-C", path.join(mirrorRoot, "brain.git"), "rev-parse", "foreign"]).toString().trim()).toBe(before);
  });

  it("is unavailable on a deployment with no internal git host", async () => {
    services = createServices({ dataDir: dir(), agentRuntime: "local", sessionSecret: "test" });
    const app = createApp(services);
    const admin = request.agent(app);
    await signup(admin, "admin").expect(201);
    const r = await admin.put("/api/admin/team-brain/backup").send({ url: "team/brain" }).expect(400);
    expect(r.body.error).toContain("GITHUB_HOST");
    await admin.put("/api/admin/team-brain/backup").send({ url: "https://github.com/team/brain.git" }).expect(400);
  });

  it("fails visibly when the saving admin is demoted or has no token", async () => {
    const s = await boot();
    await s.admin.put("/api/admin/team-brain/backup").send({ url: MIRROR_URL }).expect(200);
    s.store.deleteUserSecret(s.adminUser.id, "GIT_TOKEN");
    const noToken = await s.admin.post("/api/admin/team-brain/backup/push").expect(502);
    expect(noToken.body.error).toContain("git 토큰이 없습니다");
    s.store.setUserSecret(s.adminUser.id, "GIT_TOKEN", "tok-admin-123456");
    // Another admin keeps the panel; the saving admin loses the role.
    s.store.setRole(s.mateUser.id, "admin", true);
    s.store.setRole(s.adminUser.id, "admin", false);
    const r = await s.mate.post("/api/admin/team-brain/backup/push").expect(502);
    expect(r.body.error).toContain("더 이상 활성 관리자가 아닙니다");
    const state = (await s.mate.get("/api/admin/team-brain").expect(200)).body.backup;
    expect(state.lastError).toContain("더 이상 활성 관리자가 아닙니다");
  });

  it("schedules a debounced push after an approved card is applied", async () => {
    const s = await boot();
    await seedNote(s.config);
    let scheduled = 0;
    const original = s.teamBrainBackup!.schedule.bind(s.teamBrainBackup);
    s.teamBrainBackup!.schedule = () => {
      scheduled += 1;
      original();
    };
    const r = s.store.createTeamBrainProposal({
      kind: "direct",
      proposerUserId: s.adminUser.id,
      conversationId: null,
      path: "",
      op: "create",
      title: "a",
      summary: "",
      content: "",
      baseBlob: null,
      changeset: { changes: [{ path: "wiki/howto/other.md", op: "create", content: teamPage({ title: "Other" }), baseBlob: null }], conflicts: [] },
    });
    if (!r.ok) throw new Error("draft");
    await s.admin.post(`/api/team-brain/cards/${r.proposal.id}/apply`).expect(200);
    expect(scheduled).toBe(1);
  });
});
