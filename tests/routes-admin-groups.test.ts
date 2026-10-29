import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import type { McpToolGroupId } from "../src/shared/mcpToolGroups.js";
import { gitInit, makeBareRemote, signup, withTempDir } from "./helpers.js";

// Covers src/server/routes/admin.ts, routes/groups.ts, store/admin.ts,
// store/groups.ts, and the group-repo branches of routes/_shared.ts. These are
// pure HTTP-boundary tests over a real SQLite store; no network (the group-repo
// clone tests point at a LOCAL bare remote, and the failure paths at a
// nonexistent local path so `git clone` fails fast offline).

let tempDir: string;
const getTempDir = withTempDir("admin-groups", () => {
  tempDir = getTempDir();
});

// 1x1 transparent PNG data URL — an avatar image so the delete-user disk
// cleanup loop has a file to remove.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC";

type App = ReturnType<typeof createApp>;

function boot(overrides: Partial<Parameters<typeof createServices>[0]> = {}): {
  services: AppServices;
  app: App;
} {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
    ...overrides,
  });
  return { services, app: createApp(services) };
}

interface TestUser {
  agent: ReturnType<typeof request.agent>;
  id: string;
  username: string;
  roles: string[];
}

/** Sign up a user through the real auth route. First signup becomes admin. */
async function mkUser(app: App, username: string): Promise<TestUser> {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  const u = res.body.user as { id: string; username: string; roles: string[] };
  return { agent, id: u.id, username: u.username, roles: u.roles };
}

/** Create a group via the admin API and return its id. */
async function createGroup(admin: TestUser, name: string): Promise<string> {
  const res = await admin.agent.post("/api/admin/groups").send({ name }).expect(200);
  return res.body.group.id as string;
}

/**
 * A LOCAL bare git remote seeded with a `main` branch, an initial README, and
 * any extra `files`. Returns the remote path — usable as a group knowledge repo
 * so `ensureGroupClone` clones it offline.
 */
function seedRemote(name: string, files: Record<string, string> = {}): string {
  const remote = makeBareRemote(path.join(tempDir, `${name}.git`));
  const seed = path.join(tempDir, `${name}-seed`);
  gitInit(seed); // makes one commit (README.md) on the default branch
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("branch", "-M", "main");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (Object.keys(files).length) {
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
  }
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

// ---- Admin: cross-cutting authz -----------------------------------------

describe("admin routes — authorization gate", () => {
  it("rejects anonymous callers with 401 and non-admin members with 403", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    expect(admin.roles).toContain("admin");
    const member = await mkUser(app, "member");
    expect(member.roles).not.toContain("admin");

    // Anonymous → 401 (requireAuth fires before requireAdmin).
    await request(app).get("/api/admin/stats").expect(401);
    await request(app).get("/api/admin/users").expect(401);
    await request(app).post("/api/admin/groups").send({ name: "x" }).expect(401);

    // Authenticated member → 403 (requireAdmin).
    await member.agent.get("/api/admin/stats").expect(403);
    await member.agent.get("/api/admin/users").expect(403);
    await member.agent.get("/api/admin/groups").expect(403);
    await member.agent.delete(`/api/admin/users/${admin.id}`).expect(403);
    await member.agent.put("/api/admin/model").send({ model: "x" }).expect(403);
  });
});

// ---- Admin: stats + user detail -----------------------------------------

describe("admin: stats and user detail", () => {
  it("reports deployment-wide counts", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    await mkUser(app, "bob");
    await createGroup(admin, "team");

    const res = await admin.agent.get("/api/admin/stats").expect(200);
    const stats = res.body.stats;
    expect(stats.users).toBe(2);
    expect(stats.admins).toBe(1);
    expect(stats.groups).toBe(1);
    expect(stats.suspended).toBe(0);
    // Shape is fully populated (no undefined counters).
    for (const key of [
      "groupAvatars",
      "conversations",
      "messages",
      "openRequests",
      "activeRoutines",
      "activeSessions",
    ]) {
      expect(typeof stats[key]).toBe("number");
    }
    // Both fresh accounts default to `group` visibility.
    expect(stats.groupAvatars).toBe(2);
  });

  it("returns a per-user breakdown and 404s an unknown id", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");

    const res = await admin.agent.get(`/api/admin/users/${bob.id}`).expect(200);
    const detail = res.body.user;
    expect(detail.username).toBe("bob");
    expect(detail.conversationsStarted).toBe(0);
    expect(detail.conversationsReceived).toBe(0);
    expect(detail.pluginCount).toBe(0);
    expect(detail.gitTokenSet).toBe(false);
    expect(detail.knowledgeRepoSet).toBe(false);
    expect(detail.activeSessions).toBeGreaterThanOrEqual(1);

    await admin.agent.get("/api/admin/users/does-not-exist").expect(404);
  });
});

// ---- Admin: user lifecycle (roles / password / suspend / logout / delete) ---

describe("admin: role management", () => {
  it("grants and revokes roles and validates input", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");

    // Invalid role value → 400.
    await admin.agent
      .post(`/api/admin/users/${bob.id}/roles`)
      .send({ role: "superuser", grant: true })
      .expect(400);

    // Grant admin, then confirm it took effect at the store.
    const granted = await admin.agent
      .post(`/api/admin/users/${bob.id}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);
    expect(granted.body.user.roles).toContain("admin");
    expect(services.store.isAdmin(bob.id)).toBe(true);

    // Revoke it again.
    const revoked = await admin.agent
      .post(`/api/admin/users/${bob.id}/roles`)
      .send({ role: "admin", grant: false })
      .expect(200);
    expect(revoked.body.user.roles).not.toContain("admin");
    expect(services.store.isAdmin(bob.id)).toBe(false);

    // Unknown user with an otherwise-valid role → 404.
    await admin.agent
      .post("/api/admin/users/ghost/roles")
      .send({ role: "member", grant: true })
      .expect(404);
  });

  it("refuses to let an admin strip their own admin role", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const res = await admin.agent
      .post(`/api/admin/users/${admin.id}/roles`)
      .send({ role: "admin", grant: false })
      .expect(400);
    expect(res.body.error).toBe("자기 자신의 관리자 권한은 해제할 수 없습니다.");
  });
});

describe("admin: password reset", () => {
  it("rejects short passwords and unknown users", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    await admin.agent
      .post(`/api/admin/users/${bob.id}/password`)
      .send({ password: "short" })
      .expect(400);
    await admin.agent
      .post("/api/admin/users/ghost/password")
      .send({ password: "longenough" })
      .expect(404);
  });

  it("resets the password and force-logs-out the target", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    // bob has a live session.
    await bob.agent.get("/api/me/groups").expect(200);

    await admin.agent
      .post(`/api/admin/users/${bob.id}/password`)
      .send({ password: "brand-new-pass" })
      .expect(200);

    // Old session is revoked...
    await bob.agent.get("/api/me/groups").expect(401);
    // ...the old password no longer logs in...
    await request(app)
      .post("/api/auth/login")
      .send({ username: "bob", password: "password123" })
      .expect(401);
    // ...and the new password does.
    await request(app)
      .post("/api/auth/login")
      .send({ username: "bob", password: "brand-new-pass" })
      .expect(200);
  });
});

describe("admin: suspend / activate", () => {
  it("suspends an account, killing its sessions and blocking login until reactivated", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    await bob.agent.get("/api/me/groups").expect(200);

    const suspended = await admin.agent
      .post(`/api/admin/users/${bob.id}/suspend`)
      .send({ suspended: true })
      .expect(200);
    expect(suspended.body.user.suspended).toBe(true);
    // Session dropped immediately.
    await bob.agent.get("/api/me/groups").expect(401);
    // Login is refused with the suspended-account message.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "bob", password: "password123" })
      .expect(403);
    expect(login.body.error).toBe("비활성화된 계정입니다. 관리자 승인이나 문의가 필요합니다.");

    // Reactivate → login works again.
    const activated = await admin.agent
      .post(`/api/admin/users/${bob.id}/suspend`)
      .send({ suspended: false })
      .expect(200);
    expect(activated.body.user.suspended).toBe(false);
    await request(app)
      .post("/api/auth/login")
      .send({ username: "bob", password: "password123" })
      .expect(200);
  });

  it("refuses self-suspension and 404s an unknown user", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const self = await admin.agent
      .post(`/api/admin/users/${admin.id}/suspend`)
      .send({ suspended: true })
      .expect(400);
    expect(self.body.error).toBe("자기 자신은 정지할 수 없습니다.");
    await admin.agent
      .post("/api/admin/users/ghost/suspend")
      .send({ suspended: true })
      .expect(404);
  });
});

describe("admin: force logout", () => {
  it("revokes every session for a user", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    await bob.agent.get("/api/me/groups").expect(200);

    const res = await admin.agent.post(`/api/admin/users/${bob.id}/logout`).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);
    await bob.agent.get("/api/me/groups").expect(401);
  });

  it("404s an unknown user", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    await admin.agent.post("/api/admin/users/ghost/logout").expect(404);
  });
});

describe("admin: avatar visibility override", () => {
  it("forces an avatar's visibility and validates the value", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");

    await admin.agent
      .put(`/api/admin/users/${bob.id}/visibility`)
      .send({ visibility: "sideways" })
      .expect(400);

    // The retired "public" state is rejected like any invalid value (the
    // owner-facing PATCH /api/me silently skips it instead — asymmetry pinned
    // in routes-profile.test.ts).
    await admin.agent
      .put(`/api/admin/users/${bob.id}/visibility`)
      .send({ visibility: "public" })
      .expect(400);

    const res = await admin.agent
      .put(`/api/admin/users/${bob.id}/visibility`)
      .send({ visibility: "private" })
      .expect(200);
    expect(res.body.user.visibility).toBe("private");
    expect(services.store.getUserById(bob.id)!.visibility).toBe("private");

    await admin.agent
      .put("/api/admin/users/ghost/visibility")
      .send({ visibility: "group" })
      .expect(404);
  });
});

describe("admin: delete user", () => {
  it("refuses self-deletion and 404s an unknown user", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const self = await admin.agent.delete(`/api/admin/users/${admin.id}`).expect(400);
    expect(self.body.error).toBe("자기 자신은 삭제할 수 없습니다.");
    await admin.agent.delete("/api/admin/users/ghost").expect(404);
  });

  it("deletes a user, cascades their rows, and cleans up their avatar image on disk", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    // Give bob an on-disk avatar so the post-delete cleanup loop has work to do.
    await bob.agent.put("/api/me/avatar-image").send({ image: PNG_DATA_URL }).expect(200);
    const avatarFile = path.join(tempDir, "avatars", `${bob.id}.png`);
    expect(fs.existsSync(avatarFile)).toBe(true);

    await admin.agent.delete(`/api/admin/users/${bob.id}`).expect(200);

    expect(services.store.getUserById(bob.id)).toBeNull();
    expect(fs.existsSync(avatarFile)).toBe(false);
    const list = await admin.agent.get("/api/admin/users").expect(200);
    expect(list.body.users.map((u: { id: string }) => u.id)).not.toContain(bob.id);
  });
});

// ---- Admin: app-wide settings (signup mode, model override) --------------

describe("admin: signup mode", () => {
  it("validates the mode and gates self-service signup accordingly", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");

    await admin.agent.put("/api/admin/signup-mode").send({ mode: "nonsense" }).expect(400);

    // closed → subsequent self-service signups are refused (403).
    await admin.agent.put("/api/admin/signup-mode").send({ mode: "closed" }).expect(200);
    expect(services.store.getSignupMode()).toBe("closed");
    await signup(request.agent(app), "blocked").expect(403);

    // approval → the account is created but parked (202, suspended, no session).
    await admin.agent.put("/api/admin/signup-mode").send({ mode: "approval" }).expect(200);
    const pending = await signup(request.agent(app), "waiting").expect(202);
    expect(pending.body.pending).toBe(true);
    // Parked accounts can't log in until an admin activates them...
    await request(app)
      .post("/api/auth/login")
      .send({ username: "waiting", password: "password123" })
      .expect(403);
    // ...and surface as suspended in the admin roster.
    const users = await admin.agent.get("/api/admin/users").expect(200);
    const waiting = users.body.users.find((u: { username: string }) => u.username === "waiting");
    expect(waiting.suspended).toBe(true);

    // open → self-service signup works again.
    await admin.agent.put("/api/admin/signup-mode").send({ mode: "open" }).expect(200);
    await signup(request.agent(app), "welcome").expect(201);

    // The system view mirrors the current mode.
    const sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.signupMode).toBe("open");
  });
});

describe("admin: model override", () => {
  it("sets, surfaces, and clears the model override", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");

    await admin.agent.put("/api/admin/model").send({ model: "  " }).expect(400);
    // Only a tier or a PI_MODEL_MAP key: anything else would silently run on pi's default model.
    const bad = await admin.agent.put("/api/admin/model").send({ model: "claude-test-model" }).expect(400);
    expect(bad.body.error).toContain("PI_MODEL_MAP");
    expect(services.store.getModelOverride()).toBeNull();

    await admin.agent.put("/api/admin/model").send({ model: "sonnet" }).expect(200);
    expect(services.store.getModelOverride()).toBe("sonnet");
    let sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.modelOverride).toBe("sonnet");
    expect(sys.body.system.modelOverrideIgnored).toBe(false);
    expect(sys.body.system.modelOverrideChoices).toEqual(expect.arrayContaining(["opus", "sonnet", "haiku"]));
    // The env hard lock (ANTHROPIC_MODEL) is gone with the SDK runner.
    expect(sys.body.system).not.toHaveProperty("modelEnvLocked");

    await admin.agent.delete("/api/admin/model").expect(200);
    expect(services.store.getModelOverride()).toBeNull();
    sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.modelOverride).toBeNull();
  });
});

describe("admin: model override validation against PI_MODEL_MAP", () => {
  it("accepts a PI_MODEL_MAP key, and flags a stored unmapped override as ignored", async () => {
    const { app, services } = boot({
      agentRuntime: "pi",
      pi: {
        gatewayUrl: "http://pi.invalid",
        apiKey: "k",
        deckSandbox: false,
        modelMap: { fable: { model: "m-f" }, opus: { model: "m-o" }, sonnet: { model: "m-s" }, haiku: { model: "m-h" }, "long-ctx": { model: "m-l" } },
      },
    });
    const admin = await mkUser(app, "admin");
    await admin.agent.put("/api/admin/model").send({ model: "long-ctx" }).expect(200);
    let sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.modelOverrideChoices).toContain("long-ctx");
    expect(sys.body.system.modelOverrideIgnored).toBe(false);
    // An SDK-era deployment's stored Claude id survives the upgrade: reported as ignored.
    services.store.setModelOverride("claude-opus-4-1-20250805");
    sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.modelOverride).toBe("claude-opus-4-1-20250805");
    expect(sys.body.system.modelOverrideIgnored).toBe(true);
  });
});

describe("admin: model vision policy", () => {
  it("validates, saves, and surfaces the per-tier vision policy", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const member = await mkUser(app, "vp-member");

    await member.agent.put("/api/admin/model-vision-policy").send({ policy: { opus: false } }).expect(403);
    await admin.agent.put("/api/admin/model-vision-policy").send({ policy: { gpt: true } }).expect(400);
    await admin.agent.put("/api/admin/model-vision-policy").send({ policy: { opus: "yes" } }).expect(400);

    await admin.agent
      .put("/api/admin/model-vision-policy")
      .send({ policy: { sonnet: false, haiku: false } })
      .expect(200);
    expect(services.store.getModelVisionPolicy()).toEqual({ sonnet: false, haiku: false });

    const sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.modelVisionPolicy).toEqual({ sonnet: false, haiku: false });
    expect(sys.body.system.visionDefault).toBe(true);

    // Explicit empty policy = every tier inherits the deployment default again.
    await admin.agent.put("/api/admin/model-vision-policy").send({ policy: {} }).expect(200);
    expect(services.store.getModelVisionPolicy()).toEqual({});
  });
});

describe("admin: hex-ssh tool policy", () => {
  it("rejects a malformed policy payload", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    // A role that isn't an array → strict parser returns null → 400.
    await admin.agent
      .put("/api/admin/hex-ssh-policy")
      .send({ policy: { owner: "not-an-array", trusted: [], colleague: [] } })
      .expect(400);
    await admin.agent.put("/api/admin/hex-ssh-policy").send({ policy: 42 }).expect(400);
  });
});

// ---- Admin: groups CRUD -------------------------------------------------

describe("admin: groups CRUD", () => {
  it("creates, lists, reads, updates, and deletes a group", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");

    // Missing name → 400.
    await admin.agent.post("/api/admin/groups").send({ description: "no name" }).expect(400);

    const created = await admin.agent
      .post("/api/admin/groups")
      .send({ name: "Platform", description: "core team" })
      .expect(200);
    const groupId = created.body.group.id as string;
    expect(created.body.group.name).toBe("Platform");
    expect(created.body.group.createdBy).toBe(admin.id);

    // List includes member/admin counts.
    const list = await admin.agent.get("/api/admin/groups").expect(200);
    const summary = list.body.groups.find((g: { id: string }) => g.id === groupId);
    expect(summary.memberCount).toBe(0);
    expect(summary.adminCount).toBe(0);

    // Detail with roster.
    const detail = await admin.agent.get(`/api/admin/groups/${groupId}`).expect(200);
    expect(detail.body.group.name).toBe("Platform");
    expect(detail.body.members).toEqual([]);
    await admin.agent.get("/api/admin/groups/ghost").expect(404);

    // Update name + description.
    const patched = await admin.agent
      .patch(`/api/admin/groups/${groupId}`)
      .send({ name: "Platform Team", description: "renamed" })
      .expect(200);
    expect(patched.body.group.name).toBe("Platform Team");
    expect(patched.body.group.description).toBe("renamed");
    await admin.agent.patch("/api/admin/groups/ghost").send({ name: "x" }).expect(404);

    // Delete.
    await admin.agent.delete(`/api/admin/groups/${groupId}`).expect(200);
    expect(services.store.getGroup(groupId)).toBeNull();
    await admin.agent.delete(`/api/admin/groups/${groupId}`).expect(404);
  });

  it("manages group membership through the admin API", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    const groupId = await createGroup(admin, "team");

    // Unknown group → 404.
    await admin.agent
      .post("/api/admin/groups/ghost/members")
      .send({ username: "bob" })
      .expect(404);
    // Missing username → 400.
    await admin.agent.post(`/api/admin/groups/${groupId}/members`).send({}).expect(400);
    // Unknown username → 404.
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "nobody" })
      .expect(404);

    // Add bob as a group admin.
    const added = await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "bob", role: "admin" })
      .expect(200);
    expect(added.body.member.userId).toBe(bob.id);
    expect(added.body.member.role).toBe("admin");

    // Demote to member via PATCH.
    const demoted = await admin.agent
      .patch(`/api/admin/groups/${groupId}/members/${bob.id}`)
      .send({ role: "member" })
      .expect(200);
    expect(demoted.body.member.role).toBe("member");
    // PATCH a non-member → 404.
    await admin.agent
      .patch(`/api/admin/groups/${groupId}/members/ghost`)
      .send({ role: "admin" })
      .expect(404);

    // Remove: real member → ok:true; already-gone → 404 (matches the PATCH-role
    // sibling; a no-op removal writes no audit row and is not a 200).
    const removed = await admin.agent
      .delete(`/api/admin/groups/${groupId}/members/${bob.id}`)
      .expect(200);
    expect(removed.body.ok).toBe(true);
    await admin.agent
      .delete(`/api/admin/groups/${groupId}/members/${bob.id}`)
      .expect(404);
    expect(services.store.groupRoleFor(bob.id, groupId)).toBeNull();
  });
});

// ---- Admin: per-group tool policy ----------------------------------------

describe("admin: group tool policy", () => {
  it("is system-admin-only, validates input, and round-trips the policy", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const lead = await mkUser(app, "lead");
    const groupId = await createGroup(admin, "team");
    // lead is a GROUP admin — still forbidden (the policy is system-admin-only).
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "lead", role: "admin" })
      .expect(200);

    await request(app)
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: null })
      .expect(401);
    await lead.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: null })
      .expect(403);
    // No self-service twin exists — group admins cannot reach it there either.
    await lead.agent
      .put(`/api/me/groups/${groupId}/tool-policy`)
      .send({ allowed: null })
      .expect(404);

    // Unknown id in the list → 400 (strict — never silently dropped).
    await admin.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: ["web", "bogus"] })
      .expect(400);
    // Non-array, non-null → 400 (including an omitted field).
    await admin.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: "web" })
      .expect(400);
    await admin.agent.put(`/api/admin/groups/${groupId}/tool-policy`).send({}).expect(400);
    // Unknown group → 404.
    await admin.agent
      .put("/api/admin/groups/ghost/tool-policy")
      .send({ allowed: null })
      .expect(404);

    // Set an allowlist; duplicates are deduped by normalization.
    const set = await admin.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: ["ssh", "web", "ssh"] })
      .expect(200);
    expect(set.body.group.allowedMcpToolGroups).toEqual(["ssh", "web"]);

    // The admin list and detail expose the stored policy.
    const list = await admin.agent.get("/api/admin/groups").expect(200);
    expect(
      list.body.groups.find((g: { id: string }) => g.id === groupId).allowedMcpToolGroups,
    ).toEqual(["ssh", "web"]);
    const detail = await admin.agent.get(`/api/admin/groups/${groupId}`).expect(200);
    expect(detail.body.group.allowedMcpToolGroups).toEqual(["ssh", "web"]);

    // [] blocks every optional MCP tool group (distinct from null).
    const blockedAll = await admin.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: [] })
      .expect(200);
    expect(blockedAll.body.group.allowedMcpToolGroups).toEqual([]);

    // null clears back to unrestricted.
    const cleared = await admin.agent
      .put(`/api/admin/groups/${groupId}/tool-policy`)
      .send({ allowed: null })
      .expect(200);
    expect(cleared.body.group.allowedMcpToolGroups).toBeNull();
    expect(services.store.getGroup(groupId)!.allowedMcpToolGroups).toBeNull();
  });

  it("surfaces the policy to members and intersects it across their groups", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    const teamId = await createGroup(admin, "team");
    const guestsId = await createGroup(admin, "guests");
    await admin.agent
      .post(`/api/admin/groups/${teamId}/members`)
      .send({ username: "bob" })
      .expect(200);

    // No policy anywhere → unrestricted, on the store AND the user payload.
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toBeNull();
    expect(services.store.getUserById(bob.id)!.allowedMcpToolGroups).toBeNull();

    await admin.agent
      .put(`/api/admin/groups/${teamId}/tool-policy`)
      .send({ allowed: ["web", "ssh", "git_repo"] })
      .expect(200);
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toEqual([
      "web",
      "ssh",
      "git_repo",
      "system",
    ]);
    expect(services.store.getUserById(bob.id)!.allowedMcpToolGroups).toEqual([
      "web",
      "ssh",
      "git_repo",
      "system",
    ]);

    // Members see the group's policy read-only on /api/me/groups.
    const groups = await bob.agent.get("/api/me/groups").expect(200);
    expect(groups.body.groups[0].allowedMcpToolGroups).toEqual(["web", "ssh", "git_repo"]);

    // A second policy-bearing group INTERSECTS (fail closed on conflicts).
    await admin.agent
      .post(`/api/admin/groups/${guestsId}/members`)
      .send({ username: "bob" })
      .expect(200);
    await admin.agent
      .put(`/api/admin/groups/${guestsId}/tool-policy`)
      .send({ allowed: ["web", "canvas"] })
      .expect(200);
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toEqual(["web", "system"]);

    // A policy-LESS third group never narrows the result.
    const miscId = await createGroup(admin, "misc");
    await admin.agent
      .post(`/api/admin/groups/${miscId}/members`)
      .send({ username: "bob" })
      .expect(200);
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toEqual(["web", "system"]);

    // Disjoint policies block every optional group; system stays mandatory.
    await admin.agent
      .put(`/api/admin/groups/${guestsId}/tool-policy`)
      .send({ allowed: ["canvas"] })
      .expect(200);
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toEqual(["system"]);

    // The store setter normalizes unknown ids on WRITE too (defense in depth
    // for non-route callers); the route itself rejects them with 400.
    services.store.setGroupAllowedMcpToolGroups(
      teamId,
      ["web", "bogus"] as unknown as McpToolGroupId[],
    );
    expect(services.store.getGroup(teamId)!.allowedMcpToolGroups).toEqual(["web"]);
  });
});

// ---- Groups self-service: /api/me/groups --------------------------------

describe("groups self-service: roster", () => {
  it("lists the caller's groups with roster and repo fields", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");
    const groupId = await createGroup(admin, "team");
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "bob" })
      .expect(200);

    const res = await bob.agent.get("/api/me/groups").expect(200);
    expect(res.body.groups).toHaveLength(1);
    const g = res.body.groups[0];
    expect(g.id).toBe(groupId);
    expect(g.knowledgeRepo).toBeNull();
    expect(g.knowledgeBranch).toBeNull();
    expect(g.knowledgeSelected).toBeNull();
    expect(g.members.map((m: { userId: string }) => m.userId)).toContain(bob.id);

    // A user in no groups gets an empty list.
    const carol = await mkUser(app, "carol");
    const none = await carol.agent.get("/api/me/groups").expect(200);
    expect(none.body.groups).toEqual([]);
  });
});

describe("groups self-service: avatar-sharing policy", () => {
  it("gates the toggle on canManageGroup, validates the body, and echoes the state", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const lead = await mkUser(app, "lead");
    const plain = await mkUser(app, "plain");
    const groupId = await createGroup(admin, "team");
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "lead", role: "admin" })
      .expect(200);
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "plain", role: "member" })
      .expect(200);

    // Unknown group → 404 before the permission check.
    await lead.agent
      .put("/api/me/groups/ghost/avatar-sharing")
      .send({ enabled: false })
      .expect(404);
    // Plain member → 403.
    await plain.agent
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: false })
      .expect(403);
    // Non-boolean body → 400.
    await lead.agent
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: "off" })
      .expect(400);

    // Group admin turns it off; the Group echo + GET /api/me/groups carry it.
    const off = await lead.agent
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.group.avatarSharing).toBe(false);
    const mine = await plain.agent.get("/api/me/groups").expect(200);
    expect(mine.body.groups[0].avatarSharing).toBe(false);
    // Reach/trust dropped with it (the store matrix covers the full semantics).
    expect(services.store.isTrustedFor(plain.id, lead.id)).toBe(false);

    // A NON-member system admin may also manage it (canManageGroup).
    const on = await admin.agent
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.group.avatarSharing).toBe(true);
    expect(services.store.isTrustedFor(plain.id, lead.id)).toBe(true);
  });
});

describe("groups self-service: membership management", () => {
  it("lets a group admin (not just a system admin) manage members, and blocks plain members", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const lead = await mkUser(app, "lead");
    const plain = await mkUser(app, "plain");
    const newbie = await mkUser(app, "newbie");
    const groupId = await createGroup(admin, "team");
    // lead is a GROUP admin (not a system admin); plain is a regular member.
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "lead", role: "admin" })
      .expect(200);
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "plain", role: "member" })
      .expect(200);

    // Group admin can add a member via the self-service route.
    const added = await lead.agent
      .post(`/api/me/groups/${groupId}/members`)
      .send({ username: "newbie" })
      .expect(200);
    expect(added.body.member.userId).toBe(newbie.id);

    // Group admin can change a member's role.
    await lead.agent
      .patch(`/api/me/groups/${groupId}/members/${newbie.id}`)
      .send({ role: "admin" })
      .expect(200);

    // Group admin can remove a member.
    const removed = await lead.agent
      .delete(`/api/me/groups/${groupId}/members/${newbie.id}`)
      .expect(200);
    expect(removed.body.ok).toBe(true);

    // A plain member cannot manage the roster.
    await plain.agent
      .post(`/api/me/groups/${groupId}/members`)
      .send({ username: "newbie" })
      .expect(403);
    await plain.agent
      .patch(`/api/me/groups/${groupId}/members/${lead.id}`)
      .send({ role: "member" })
      .expect(403);
    await plain.agent.delete(`/api/me/groups/${groupId}/members/${lead.id}`).expect(403);
  });

  it("validates the self-service add-member inputs", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");

    // Unknown group → 404 (checked before the permission gate).
    await admin.agent
      .post("/api/me/groups/ghost/members")
      .send({ username: "admin" })
      .expect(404);
    // System admin passes the permission gate; missing username → 400.
    await admin.agent.post(`/api/me/groups/${groupId}/members`).send({}).expect(400);
    // Unknown username → 404.
    await admin.agent
      .post(`/api/me/groups/${groupId}/members`)
      .send({ username: "nobody" })
      .expect(404);
  });

  it("404s a role change for someone who isn't a member", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");
    // System admin is authorized, but the target isn't in the group → 404.
    await admin.agent
      .patch(`/api/me/groups/${groupId}/members/ghost`)
      .send({ role: "admin" })
      .expect(404);
  });
});

describe("groups self-service: knowledge repo settings", () => {
  it("connects, clears, and validates the group knowledge repo", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");

    // Unknown group → 404.
    await admin.agent
      .put("/api/me/groups/ghost/knowledge-repo")
      .send({ repo: "org/knowledge" })
      .expect(404);

    // Non-manager (plain member) → 403.
    const member = await mkUser(app, "member");
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "member", role: "member" })
      .expect(200);
    await member.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo`)
      .send({ repo: "org/knowledge" })
      .expect(403);

    // Malformed repo string → 400.
    await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo`)
      .send({ repo: "not a repo at all" })
      .expect(400);

    // Valid owner/repo → connected (owner/repo shorthand is always internal).
    const set = await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo`)
      .send({ repo: "org/knowledge", branch: "main" })
      .expect(200);
    expect(set.body.group.knowledgeRepo).toBe("org/knowledge");
    expect(set.body.group.knowledgeBranch).toBe("main");

    // Clear with empty string → repo null.
    const cleared = await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo`)
      .send({ repo: "" })
      .expect(200);
    expect(cleared.body.group.knowledgeRepo).toBeNull();
    expect(services.store.getGroupKnowledgeRepo(groupId).repo).toBeNull();
  });

  it("rejects a group knowledge repo outside the internal GitHub host", async () => {
    const { app } = boot({ githubHost: "github.enterprise.local" });
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");
    const res = await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo`)
      .send({ repo: "https://github.com/org/knowledge.git", branch: "main" })
      .expect(400);
    expect(res.body.error).toContain("사내 GitHub host(github.enterprise.local)");
  });

  // Regression (sec): the internal-host check used to pass anything whose host it
  // could not parse, so a local path (or `scheme::` syntax) ending in `.git` slipped
  // through — pointing a GROUP repo at another user's clone would expose it to every
  // group member. Same root cause as the personal knowledge-repo route.
  it("rejects a local path or remote-helper syntax as a group knowledge repo", async () => {
    const { app, services } = boot({ githubHost: "github.enterprise.local" });
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");

    for (const repo of [
      "/data/knowledge/other-user-id/.git",
      "ext::sh -c evil .git",
    ]) {
      const res = await admin.agent
        .put(`/api/me/groups/${groupId}/knowledge-repo`)
        .send({ repo, branch: "main" })
        .expect(400);
      expect(res.body.error).toContain("사내 GitHub host");
    }
    expect(services.store.getGroupKnowledgeRepo(groupId).repo).toBeNull();
  });

  it("sets and clears the group repo plugin selection", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");

    // No repo connected yet → 404.
    await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo/selected`)
      .send({ selected: ["a"] })
      .expect(404);

    services.store.setGroupKnowledgeRepo(groupId, "org/knowledge", "main");

    // Non-array, non-null → 400.
    await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo/selected`)
      .send({ selected: "alpha" })
      .expect(400);

    // Array of strings → set.
    const set = await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo/selected`)
      .send({ selected: ["alpha", "beta"] })
      .expect(200);
    expect(set.body.group.knowledgeSelected).toEqual(["alpha", "beta"]);

    // null → load all.
    const all = await admin.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo/selected`)
      .send({ selected: null })
      .expect(200);
    expect(all.body.group.knowledgeSelected).toBeNull();

    // Non-member → 403 (permission gate precedes everything).
    const outsider = await mkUser(app, "outsider");
    await outsider.agent
      .put(`/api/me/groups/${groupId}/knowledge-repo/selected`)
      .send({ selected: null })
      .expect(403);
  });
});

// ---- Group knowledge-repo views (clone-backed) --------------------------

describe("group knowledge repo views", () => {
  it("enforces membership and requires a connected repo", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const outsider = await mkUser(app, "outsider");
    const groupId = await createGroup(admin, "team");

    // Non-member, non-admin → 403 on every view.
    await outsider.agent.get(`/api/me/groups/${groupId}/knowledge-repo/contents`).expect(403);
    await outsider.agent.post(`/api/me/groups/${groupId}/knowledge-repo/refresh`).expect(403);

    // System admin passes membership, but with no repo connected → 404.
    await admin.agent.get(`/api/me/groups/${groupId}/knowledge-repo/contents`).expect(404);
    await admin.agent.post(`/api/me/groups/${groupId}/knowledge-repo/refresh`).expect(404);
    // Sanity: the store still reports no repo.
    expect(services.store.getGroupKnowledgeRepo(groupId).repo).toBeNull();
  });

  it("clones a connected repo and serves contents; the team-brain graph/note routes are gone", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");
    const remote = seedRemote("group-ok", {
      "wiki/foo.md": "# Foo\n\nLinks to [[bar]].\n",
    });
    // Point the group at the local remote (bypasses the PUT host validation,
    // which is exercised separately).
    services.store.setGroupKnowledgeRepo(groupId, remote, "main");

    // contents: the seed has no `.claude-plugin`, so it's a "none" layout.
    const contents = await admin.agent
      .get(`/api/me/groups/${groupId}/knowledge-repo/contents`)
      .expect(200);
    expect(contents.body.contents.kind).toBe("none");

    // The team brain was removed 2026-10-30: no group graph or note route (unmatched → 404).
    await admin.agent.get(`/api/me/groups/${groupId}/knowledge-repo/graph`).expect(404);
    await admin.agent.get(`/api/me/groups/${groupId}/knowledge-repo/note?path=wiki/foo.md`).expect(404);

    // refresh: re-fetches the existing clone and returns contents.
    const refreshed = await admin.agent
      .post(`/api/me/groups/${groupId}/knowledge-repo/refresh`)
      .expect(200);
    expect(refreshed.body.contents.kind).toBe("none");
  });

  it("returns 502 when the configured repo cannot be cloned", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const groupId = await createGroup(admin, "team");
    // A local path that does not exist → `git clone` fails fast, offline.
    services.store.setGroupKnowledgeRepo(
      groupId,
      path.join(tempDir, "nonexistent-remote.git"),
      "main",
    );

    await admin.agent.get(`/api/me/groups/${groupId}/knowledge-repo/contents`).expect(502);
    await admin.agent.post(`/api/me/groups/${groupId}/knowledge-repo/refresh`).expect(502);
  });
});

// ---- Trust is group-only (the invariant the groups routes create) -------

describe("trust is derived purely from group co-membership", () => {
  it("makes two users mutually trusted once they share a group, and not before", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const alice = await mkUser(app, "alice");
    const bob = await mkUser(app, "bob");
    const carol = await mkUser(app, "carol");

    // No shared group yet → not trusted, in either direction.
    expect(services.store.isTrustedFor(alice.id, bob.id)).toBe(false);
    expect(services.store.isTrustedFor(bob.id, alice.id)).toBe(false);

    const groupId = await createGroup(admin, "team");
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "alice" })
      .expect(200);
    await admin.agent
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "bob" })
      .expect(200);

    // Now symmetrically trusted...
    expect(services.store.isTrustedFor(alice.id, bob.id)).toBe(true);
    expect(services.store.isTrustedFor(bob.id, alice.id)).toBe(true);
    // ...but carol (not in the group) is trusted by no one.
    expect(services.store.isTrustedFor(alice.id, carol.id)).toBe(false);
    expect(services.store.isTrustedFor(carol.id, bob.id)).toBe(false);

    // Removing bob dissolves the trust again.
    await admin.agent
      .delete(`/api/admin/groups/${groupId}/members/${bob.id}`)
      .expect(200);
    expect(services.store.isTrustedFor(alice.id, bob.id)).toBe(false);
  });
});

// ---- Audit feed ----------------------------------------------------------

describe("audit feed", () => {
  it("requires auth and scopes non-admins to their own events", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");

    await request(app).get("/api/audit").expect(401);

    // Admin action that writes an audit row.
    await createGroup(admin, "team");

    const adminFeed = await admin.agent.get("/api/audit").expect(200);
    const adminActions = adminFeed.body.audit.map((e: { action: string }) => e.action);
    expect(adminActions).toContain("group_create");

    // bob sees only his own events (his signup), never the admin's group_create.
    const bobFeed = await bob.agent.get("/api/audit").expect(200);
    const bobActorIds = new Set(
      bobFeed.body.audit.map((e: { actorUserId: string | null }) => e.actorUserId),
    );
    expect(bobActorIds.size).toBeLessThanOrEqual(1);
    if (bobActorIds.size === 1) {
      expect(bobActorIds.has(bob.id)).toBe(true);
    }
    expect(bobFeed.body.audit.map((e: { action: string }) => e.action)).not.toContain(
      "group_create",
    );
  });
});
