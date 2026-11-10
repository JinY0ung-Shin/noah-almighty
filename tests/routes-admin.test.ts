import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices, type AppServices } from "../src/server/app.js";
import { signup, withTempDir } from "./helpers.js";
import { piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";

// Covers src/server/routes/admin.ts and store/admin.ts: pure HTTP-boundary
// tests over a real SQLite store. Groups are retired (single team, 2026-11-06):
// the system admin approves signups (= joining the team), sets the ONE global
// MCP tool policy, and moderates shared skills (tests/skill-share.test.ts).

let tempDir: string;
const getTempDir = withTempDir("admin-team", () => {
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
    await request(app).get("/api/admin/tool-policy").expect(401);
    await request(app).get("/api/admin/shared-skills").expect(401);

    // Authenticated member → 403 (requireAdmin).
    await member.agent.get("/api/admin/stats").expect(403);
    await member.agent.get("/api/admin/users").expect(403);
    await member.agent.get("/api/admin/tool-policy").expect(403);
    await member.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: null }).expect(403);
    await member.agent.get("/api/admin/shared-skills").expect(403);
    await member.agent.delete(`/api/admin/users/${admin.id}`).expect(403);
    await member.agent.put("/api/admin/signup-mode").send({ mode: "approval" }).expect(403);
  });
});

// ---- Admin: stats + user detail -----------------------------------------

describe("admin: stats and user detail", () => {
  it("reports deployment-wide counts", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    await mkUser(app, "bob");

    const res = await admin.agent.get("/api/admin/stats").expect(200);
    const stats = res.body.stats;
    expect(stats.users).toBe(2);
    expect(stats.admins).toBe(1);
    expect(stats).not.toHaveProperty("groups");
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
    await bob.agent.get("/api/audit").expect(200);

    await admin.agent
      .post(`/api/admin/users/${bob.id}/password`)
      .send({ password: "brand-new-pass" })
      .expect(200);

    // Old session is revoked...
    await bob.agent.get("/api/audit").expect(401);
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
    await bob.agent.get("/api/audit").expect(200);

    const suspended = await admin.agent
      .post(`/api/admin/users/${bob.id}/suspend`)
      .send({ suspended: true })
      .expect(200);
    expect(suspended.body.user.suspended).toBe(true);
    // Session dropped immediately.
    await bob.agent.get("/api/audit").expect(401);
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
    await bob.agent.get("/api/audit").expect(200);

    const res = await admin.agent.post(`/api/admin/users/${bob.id}/logout`).expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked).toBeGreaterThanOrEqual(1);
    await bob.agent.get("/api/audit").expect(401);
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

    // Approval IS joining the team: the activated account logs in and is a
    // trusted teammate at once.
    await admin.agent.post(`/api/admin/users/${waiting.id}/suspend`).send({ suspended: false }).expect(200);
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "waiting", password: "password123" })
      .expect(200);
    expect(services.store.isTrustedFor(login.body.user.id, admin.id)).toBe(true);

    // The retired `open` mode is rejected and changes nothing.
    await admin.agent.put("/api/admin/signup-mode").send({ mode: "open" }).expect(400);
    expect(services.store.getSignupMode()).toBe("approval");
    // A legacy stored `open` (an older release) still reads — and gates — as approval.
    services.store.setAppSecret("signup_mode", "open");
    expect(services.store.getSignupMode()).toBe("approval");
    const parked = await signup(request.agent(app), "legacy-open").then((res) => res);
    expect(parked.status).toBe(202);

    // The system view mirrors the current mode.
    const sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.signupMode).toBe("approval");
  });
});

/** A pi deployment whose gateway offers `models` — or cannot be reached at all (`"down"`). */
function bootWithModels(models: string[] | "down") {
  const booted = boot({
    agentRuntime: "pi",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false },
  });
  piServicesFor(booted.services.store, booted.services.config).models = createPiModelCatalog({
    listModels: async () => {
      if (models === "down") throw new Error("connect ECONNREFUSED");
      return models.map((id) => ({ id }));
    },
  });
  return booted;
}

describe("admin: retired LLM settings (pi-gateway's admin page owns them)", () => {
  it("no longer serves the model override or the vision policy routes", async () => {
    const { app, services } = bootWithModels(["deepseek/v3", "qwen/coder"]);
    const admin = await mkUser(app, "admin");
    await admin.agent.put("/api/admin/model").send({ model: "qwen/coder" }).expect(404);
    await admin.agent.delete("/api/admin/model").expect(404);
    await admin.agent.put("/api/admin/model-vision-policy").send({ policy: { "qwen/coder": false } }).expect(404);
    expect(services.store.getAppSecret("agent_model_override")).toBeNull();
    expect(services.store.getAppSecret("model_vision_policy")).toBeNull();
    // The system view lists pi's models read-only, with nothing to set.
    const sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.piModels).toEqual([
      { id: "deepseek/v3", server: null },
      { id: "qwen/coder", server: null },
    ]);
    expect(sys.body.system).not.toHaveProperty("modelOverride");
    expect(sys.body.system).not.toHaveProperty("modelVisionPolicy");
  });

  it("still answers the system view while pi-gateway's list cannot be read; a model write answers 503", async () => {
    const { app } = bootWithModels("down");
    const admin = await mkUser(app, "admin");
    const res = await admin.agent.put("/api/me/chat-defaults").send({ model: "deepseek/v3" }).expect(503);
    expect(res.body.error).toBe("pi-gateway 모델 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
    // Clearing names no model, so it needs no list.
    await admin.agent.put("/api/me/chat-defaults").send({ model: null }).expect(200);
    const sys = await admin.agent.get("/api/admin/system").expect(200);
    expect(sys.body.system.piModels).toEqual([]);
  });
});

describe("composer default model", () => {
  it("stores only a model pi-gateway offers, and clears with null/\"\"", async () => {
    const { app, services } = bootWithModels(["deepseek/v3"]);
    const user = await mkUser(app, "picker");
    const bad = await user.agent.put("/api/me/chat-defaults").send({ model: "opus" }).expect(400);
    expect(bad.body.error).toBe("알 수 없는 모델입니다.");
    await user.agent.put("/api/me/chat-defaults").send({ model: 42 }).expect(400);
    const ok = await user.agent.put("/api/me/chat-defaults").send({ model: "deepseek/v3" }).expect(200);
    expect(ok.body.user.modelDefault).toBe("deepseek/v3");
    await user.agent.put("/api/me/chat-defaults").send({ model: "" }).expect(200);
    expect(services.store.getUserById(user.id)?.modelDefault).toBeNull();
  });
});

describe("admin: hex-ssh tool policy", () => {
  it("rejects a malformed policy payload", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    // A role that isn't an array → strict parser returns null → 400.
    await admin.agent
      .put("/api/admin/hex-ssh-policy")
      .send({ policy: { owner: "not-an-array", trusted: [] } })
      .expect(400);
    await admin.agent.put("/api/admin/hex-ssh-policy").send({ policy: 42 }).expect(400);
  });
});

// ---- Admin: global MCP tool policy ---------------------------------------

describe("admin: MCP tool policy (one global policy)", () => {
  it("is system-admin-only, validates input, round-trips, audits, and applies to every user", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const bob = await mkUser(app, "bob");

    await request(app).put("/api/admin/tool-policy").send({ allowedMcpToolGroups: null }).expect(401);
    await bob.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: null }).expect(403);

    const initial = await admin.agent.get("/api/admin/tool-policy").expect(200);
    expect(initial.body).toEqual({ allowedMcpToolGroups: null });

    // Unknown id → 400 (strict — never silently dropped); non-array/omitted → 400.
    await admin.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: ["canvas", "bogus"] }).expect(400);
    await admin.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: "canvas" }).expect(400);
    const bad = await admin.agent.put("/api/admin/tool-policy").send({}).expect(400);
    expect(bad.body.error).toContain("allowedMcpToolGroups");
    // The retired per-group route is gone.
    await admin.agent.put("/api/admin/groups/x/tool-policy").send({ allowed: null }).expect(404);

    // Set an allowlist; duplicates are deduped by normalization.
    const set = await admin.agent
      .put("/api/admin/tool-policy")
      .send({ allowedMcpToolGroups: ["ssh", "canvas", "ssh"] })
      .expect(200);
    expect(set.body).toEqual({ allowedMcpToolGroups: ["ssh", "canvas"] });
    expect((await admin.agent.get("/api/admin/tool-policy").expect(200)).body.allowedMcpToolGroups).toEqual(["ssh", "canvas"]);
    // Every user gets the same clamp (system always kept), on the store AND /api/me.
    for (const id of [admin.id, bob.id]) {
      expect(services.store.allowedMcpToolGroupsForUser(id)).toEqual(["ssh", "canvas", "system"]);
    }
    const me = await bob.agent.get("/api/me").expect(200);
    expect(me.body.user.allowedMcpToolGroups).toEqual(["ssh", "canvas", "system"]);
    expect(me.body.user).not.toHaveProperty("groups");

    // [] blocks every optional group (distinct from null).
    const blockedAll = await admin.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: [] }).expect(200);
    expect(blockedAll.body.allowedMcpToolGroups).toEqual([]);
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toEqual(["system"]);

    // null clears back to unrestricted.
    const cleared = await admin.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: null }).expect(200);
    expect(cleared.body.allowedMcpToolGroups).toBeNull();
    expect(services.store.allowedMcpToolGroupsForUser(bob.id)).toBeNull();

    // Each change is audited in Korean.
    const audit = await admin.agent.get("/api/audit").expect(200);
    const details = audit.body.audit
      .filter((e: { action: string }) => e.action === "set_tool_policy")
      .map((e: { detail: string }) => e.detail);
    expect(details).toEqual(
      expect.arrayContaining(["MCP 도구 정책 = ssh,canvas", "MCP 도구 정책 = (모두 차단)", "MCP 도구 정책 = (제한 없음)"]),
    );
  });
});

// ---- Admin: shared-skill blocks without a live listing -------------------

describe("admin: shared-skill moderation lists every block (otherBlocks)", () => {
  it("lists blocks no active listing carries, skips orphans, and they unblock through the same route", async () => {
    const { app, services } = boot();
    const store = services.store;
    const admin = await mkUser(app, "admin");
    const alice = await mkUser(app, "alice");
    const bob = await mkUser(app, "bob");
    const skill = (name: string) => ({ skillName: name, displayName: name, description: `${name} desc` });
    store.shareSkill(alice.id, skill("live-skill"));
    store.shareSkill(bob.id, skill("bob-skill"));
    store.blockSharedSkill(alice.id, "live-skill", admin.id); // has an active listing → in `skills` only
    store.blockSharedSkill(alice.id, "never-shared", admin.id); // no share row → otherBlocks
    store.blockSharedSkill(bob.id, "bob-skill", admin.id); // owner suspended below → otherBlocks
    await admin.agent.post(`/api/admin/users/${bob.id}/suspend`).send({ suspended: true }).expect(200);
    // A row whose owner no longer exists (deleteUser cascades; this is a stray) is skipped.
    (store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("INSERT INTO shared_skill_blocks (owner_user_id, skill_name, blocked_by, created_at) VALUES ('ghost-user', 'ghost', NULL, NULL)")
      .run();

    const res = await admin.agent.get("/api/admin/shared-skills").expect(200);
    const skills = res.body.skills as { ownerUserId: string; skillName: string; blocked: boolean }[];
    expect(skills.map((s) => [s.skillName, s.blocked])).toEqual([["live-skill", true]]);
    const other = res.body.otherBlocks as Record<string, unknown>[];
    expect(other).toHaveLength(2);
    expect(other).toEqual(
      expect.arrayContaining([
        {
          ownerUserId: alice.id,
          ownerUsername: "alice",
          ownerDisplayName: "alice",
          ownerSuspended: false,
          skillName: "never-shared",
          blockedAt: expect.any(String),
        },
        {
          ownerUserId: bob.id,
          ownerUsername: "bob",
          ownerDisplayName: "bob",
          ownerSuspended: true,
          skillName: "bob-skill",
          blockedAt: expect.any(String),
        },
      ]),
    );
    expect(other.some((b) => b.skillName === "live-skill" || b.skillName === "ghost")).toBe(false);

    // A suspended owner's block lifts through the existing route.
    await admin.agent.delete(`/api/admin/shared-skills/blocks/${bob.id}/bob-skill`).expect(200);
    const after = await admin.agent.get("/api/admin/shared-skills").expect(200);
    expect((after.body.otherBlocks as { skillName: string }[]).map((b) => b.skillName)).toEqual(["never-shared"]);

    // Reinstating an owner moves a live share's block back into `skills`.
    store.blockSharedSkill(bob.id, "bob-skill", admin.id);
    await admin.agent.post(`/api/admin/users/${bob.id}/suspend`).send({ suspended: false }).expect(200);
    const reinstated = await admin.agent.get("/api/admin/shared-skills").expect(200);
    expect((reinstated.body.otherBlocks as { skillName: string }[]).map((b) => b.skillName)).toEqual(["never-shared"]);
    expect(
      (reinstated.body.skills as { skillName: string; blocked: boolean }[]).find((s) => s.skillName === "bob-skill")?.blocked,
    ).toBe(true);
  });
});

// ---- Groups are retired --------------------------------------------------

describe("groups are retired (single team)", () => {
  it("serves none of the group routes (each unmatched → 404)", async () => {
    const { app } = boot();
    const admin = await mkUser(app, "admin");
    await admin.agent.get("/api/admin/groups").expect(404);
    await admin.agent.post("/api/admin/groups").send({ name: "team" }).expect(404);
    await admin.agent.get("/api/admin/groups/x").expect(404);
    await admin.agent.post("/api/admin/groups/x/members").send({ username: "admin" }).expect(404);
    await admin.agent.get("/api/me/groups").expect(404);
    await admin.agent.put("/api/me/groups/x/avatar-sharing").send({ enabled: true }).expect(404);
    await admin.agent.get("/api/me/groups/x/shared-skills").expect(404);
    await admin.agent.put("/api/me/groups/x/knowledge-repo").send({ repo: "acme/kb" }).expect(404);
    await admin.agent.put("/api/me/group-knowledge-default").send({ off: [] }).expect(404);
    await admin.agent.get("/api/me/users/search?q=adm").expect(404);
  });

  it("makes every approved user a trusted teammate, and a suspended one no one's", async () => {
    const { app, services } = boot();
    const admin = await mkUser(app, "admin");
    const alice = await mkUser(app, "alice");
    const bob = await mkUser(app, "bob");
    expect(services.store.isTrustedFor(alice.id, bob.id)).toBe(true);
    expect(services.store.isTrustedFor(bob.id, alice.id)).toBe(true);
    await alice.agent.get(`/api/avatars/${bob.id}`).expect(200);

    await admin.agent.post(`/api/admin/users/${bob.id}/suspend`).send({ suspended: true }).expect(200);
    expect(services.store.isTrustedFor(alice.id, bob.id)).toBe(false);
    await alice.agent.get(`/api/avatars/${bob.id}`).expect(404);
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
    await admin.agent.put("/api/admin/tool-policy").send({ allowedMcpToolGroups: ["canvas"] }).expect(200);

    const adminFeed = await admin.agent.get("/api/audit").expect(200);
    const adminActions = adminFeed.body.audit.map((e: { action: string }) => e.action);
    expect(adminActions).toContain("set_tool_policy");

    // bob sees only his own events (his signup), never the admin's set_tool_policy.
    const bobFeed = await bob.agent.get("/api/audit").expect(200);
    const bobActorIds = new Set(
      bobFeed.body.audit.map((e: { actorUserId: string | null }) => e.actorUserId),
    );
    expect(bobActorIds.size).toBeLessThanOrEqual(1);
    if (bobActorIds.size === 1) {
      expect(bobActorIds.has(bob.id)).toBe(true);
    }
    expect(bobFeed.body.audit.map((e: { action: string }) => e.action)).not.toContain(
      "set_tool_policy",
    );
  });
});
