import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import {
  loadDefaultPluginRoots,
  resolvePluginRoots,
} from "../src/server/plugins.js";
import { piServicesFor } from "../src/server/agent/pi/piRuntime.js";
import { createPiModelCatalog } from "../src/server/agent/pi/modelCatalog.js";
import { parseSse, shareGroup, signup, withTempDir } from "./helpers.js";

let tempDir: string;
const getTempDir = withTempDir("almighty", () => {
  tempDir = getTempDir();
});

function testApp() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return createApp(services);
}

// 1x1 transparent PNG as a data URL, for avatar-image upload tests.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAYHvqzS6AAAAAElFTkSuQmCC";

/** Sign up a user and return their agent + user record. */
async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return {
    agent,
    user: res.body.user as { id: string; username: string; roles: string[] },
  };
}

describe("noah-almighty platform", () => {
  it("reports needsSetup until the first account exists", async () => {
    const app = testApp();
    const fresh = await request(app).get("/api/bootstrap").expect(200);
    expect(fresh.body.needsSetup).toBe(true);
    expect(fresh.body.githubHost).toBe("github.com");

    await signup(request.agent(app), "alice").expect(201);

    const after = await request(app).get("/api/bootstrap").expect(200);
    expect(after.body.needsSetup).toBe(false);
  });

  it("returns a JSON 404 for unknown API paths instead of the SPA index", async () => {
    const app = testApp();
    const get = await request(app)
      .get("/api/does-not-exist")
      .expect("Content-Type", /json/)
      .expect(404);
    expect(get.body.error).toContain("API 엔드포인트");

    await request(app)
      .post("/api/does-not-exist")
      .send({})
      .expect("Content-Type", /json/)
      .expect(404);
  });

  it("serves a same-origin CSP with no script eval or wasm compilation", async () => {
    const app = testApp();
    const res = await request(app).get("/api/bootstrap").expect(200);
    const csp = res.headers["content-security-policy"] as string;

    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");

    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"))!;
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("reports the configured default GitHub host", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      githubHost: "github.enterprise.local",
    });
    const app = createApp(services);
    const res = await request(app).get("/api/bootstrap").expect(200);
    expect(res.body.githubHost).toBe("github.enterprise.local");
  });

  it("offers pi-gateway's live models in the bootstrap model selection, with per-model vision", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "pi",
      sessionSecret: "test",
      pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false },
    });
    piServicesFor(services.store, services.config).models = createPiModelCatalog({
      listModels: async () => [{ id: "m-a", ownedBy: "anthropic" }, { id: "m-b" }],
    });
    services.store.setModelVisionPolicy({ "m-b": false });
    const app = createApp(services);
    let res = await request(app).get("/api/bootstrap").expect(200);
    expect(res.body.visionEnabled).toBe(true);
    expect(res.body.modelSelection).toEqual({
      models: [
        { id: "m-a", server: "anthropic", vision: true },
        { id: "m-b", server: null, vision: false },
      ],
      // Nothing picked, no override → pi-gateway's default model inherits MODEL_VISION.
      defaultVision: true,
    });
    // The admin override pi offers decides the default's vision.
    services.store.setModelOverride("m-b");
    res = await request(app).get("/api/bootstrap").expect(200);
    expect(res.body.modelSelection.defaultVision).toBe(false);
    services.store.close();
  });

  it("offers no models on the local stub (the client hides the picker)", async () => {
    const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
    const res = await request(createApp(services)).get("/api/bootstrap").expect(200);
    expect(res.body.modelSelection).toEqual({ models: [], defaultVision: true });
    services.store.close();
  });

  it("hides the browser-bridge Multimedia notice by default and serves any signed-in user", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "bridge-admin");
    const res = await agent.get("/api/browser-extension").expect(200);
    expect(res.body.multimediaNotice).toBe(false);
    // Sanity: the id the guide renders still comes with it.
    expect(typeof res.body.extensionId).toBe("string");

    // General capability: a plain member gets the same payload. The session
    // floor stays — no login, no bundle.
    const { agent: member } = await newUser(app, "bridge-member");
    await member.get("/api/browser-extension").expect(200);
    await request(app).get("/api/browser-extension").expect(401);
  });

  it("serves the operator's default allowlist minus anything covering Noah's own host", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      browserDefaultAllowedOrigins: [
        "confluence.corp.example",
        "noah.corp.example", // Noah itself — must never ship as a default
        "*.corp.example", // covers noah.corp.example — dropped for the same reason
        "*", // allow-everything can never be a default
        "wiki.other.example",
      ],
    });
    const app = createApp(services);
    const { agent } = await newUser(app, "bridge-defaults");
    const res = await agent
      .get("/api/browser-extension")
      .set("Host", "noah.corp.example")
      .expect(200);
    expect(res.body.defaultAllowedOrigins).toEqual([
      "confluence.corp.example",
      "wiki.other.example",
    ]);

    // No env configured → an empty list, so the client seeds nothing.
    const bare = testApp();
    const { agent: plain } = await newUser(bare, "bridge-defaults-2");
    const none = await plain.get("/api/browser-extension").expect(200);
    expect(none.body.defaultAllowedOrigins).toEqual([]);
  });

  it("publishes a compatibility floor at or below the bundled extension version", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "bridge-floor-admin");
    const res = await agent.get("/api/browser-extension").expect(200);
    const version = res.body.version as string;
    const floor = res.body.minCompatibleVersion as string;
    const nums = (v: string) => v.split(".").map(Number);
    expect(nums(floor).every(Number.isFinite)).toBe(true);
    expect(nums(version).every(Number.isFinite)).toBe(true);
    // floor <= bundled version, or every fresh install reads as outdated forever.
    const [a, b] = [nums(floor), nums(version)];
    let cmp = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && cmp === 0; i += 1) {
      cmp = (a[i] ?? 0) - (b[i] ?? 0);
    }
    expect(cmp).toBeLessThanOrEqual(0);
  });

  it("serves the extension as individual files with the request origin stamped into the manifest", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "bridge-files-admin");
    const res = await agent
      .get("/api/browser-extension.files")
      .set("X-Forwarded-Host", "noah.test.local:8443")
      .set("X-Forwarded-Proto", "https")
      .expect(200);
    const files = res.body.files as { name: string; content: string; encoding?: string }[];
    const names = files.map((f) => f.name);
    // The full unpacked install, not a subset — a partial write would produce
    // an extension that loads and then fails in undiagnosable ways.
    expect(names).toEqual(
      expect.arrayContaining(["manifest.json", "background.js", "options.html", "policy-schema.json"]),
    );

    // Binary entries travel base64 and must decode back to the exact on-disk
    // bytes — pushed through utf8 they corrupt, and the manifest NAMES the
    // icons, so a corrupted one-click write bricks the extension load.
    const icon = files.find((f) => f.name === "icon-128.png")!;
    expect(icon.encoding).toBe("base64");
    expect(
      Buffer.from(icon.content, "base64").equals(
        fs.readFileSync(path.join(process.cwd(), "extension", "icon-128.png")),
      ),
    ).toBe(true);
    const manifest = JSON.parse(files.find((f) => f.name === "manifest.json")!.content) as {
      version: string;
      externally_connectable: { matches: string[] };
    };
    // Same origin stamping as the zip: the address the user downloads from is
    // the address the extension must accept messages from.
    expect(manifest.externally_connectable.matches).toContain("https://noah.test.local:8443/*");
    expect(res.body.version).toBe(manifest.version);

    const { agent: member } = await newUser(app, "bridge-files-member");
    await member.get("/api/browser-extension.files").expect(200);
  });

  it("surfaces the browser-bridge Multimedia notice when the operator enables it", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      browserBridgeMultimediaNotice: true,
    });
    const app = createApp(services);
    const { agent } = await newUser(app, "bridge-admin");
    const res = await agent.get("/api/browser-extension").expect(200);
    expect(res.body.multimediaNotice).toBe(true);
  });

  it("restricts knowledge repos to the configured internal GitHub host", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
      githubHost: "github.enterprise.local",
    });
    const app = createApp(services);
    const { agent } = await newUser(app, "internal-owner");

    await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "owner/knowledge", branch: "main" })
      .expect(200);
    await agent
      .put("/api/me/knowledge-repo")
      .send({
        repo: "https://github.enterprise.local/owner/knowledge.git",
        branch: "main",
      })
      .expect(200);
    const rejected = await agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "https://github.com/owner/knowledge.git", branch: "main" })
      .expect(400);
    expect(rejected.body.error).toContain(
      "사내 GitHub host(github.enterprise.local)",
    );
  });

  it("generates an SSH keypair through the owner settings API without returning the private key", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "ssh-owner");

    const created = await agent.post("/api/me/ssh-key").send({}).expect(200);
    expect(created.body.publicKey).toMatch(/^ssh-ed25519 /);
    expect(created.body.fingerprint).toMatch(/^SHA256:/);
    expect(created.body.user.secretNames).toContain("SSH_PRIVATE_KEY");
    expect(created.body.user.sshPublicKey).toBe(created.body.publicKey);
    expect(JSON.stringify(created.body)).not.toContain(
      "BEGIN OPENSSH PRIVATE KEY",
    );

    await agent.post("/api/me/ssh-key").send({}).expect(409);
  });

  it("makes the first signup an admin and subsequent users members only", async () => {
    const app = testApp();
    const first = request.agent(app);
    const firstRes = await signup(first, "alice").expect(201);
    expect(firstRes.body.user.username).toBe("alice");
    // New avatars default to group visibility.
    expect(firstRes.body.user.visibility).toBe("group");
    expect(firstRes.body.user.roles).toContain("admin");
    expect(firstRes.body.user.roles).toContain("member");

    const second = request.agent(app);
    const secondRes = await signup(second, "bob").expect(201);
    expect(secondRes.body.user.visibility).toBe("group");
    expect(secondRes.body.user.roles).toContain("member");
    expect(secondRes.body.user.roles).not.toContain("admin");
  });

  it("rejects duplicate usernames with 409", async () => {
    const app = testApp();
    await signup(request.agent(app), "carol").expect(201);
    await signup(request.agent(app), "carol").expect(409);
  });

  it("rejects login with wrong password (401)", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "dave", "password123").expect(201);
    await agent
      .post("/api/auth/login")
      .send({ username: "dave", password: "wrong-pass" })
      .expect(401);
    const ok = await agent
      .post("/api/auth/login")
      .send({ username: "dave", password: "password123" })
      .expect(200);
    expect(ok.body.user.username).toBe("dave");
  });

  it("updates profile via PATCH /api/me", async () => {
    const app = testApp();
    const agent = request.agent(app);
    const signupRes = await signup(agent, "erin").expect(201);
    const erinId = signupRes.body.user.id as string;
    const res = await agent
      .patch("/api/me")
      .send({ displayName: "Erin K", alias: "  Aria  ", visibility: "private" })
      .expect(200);
    expect(res.body.user.displayName).toBe("Erin K");
    // alias is trimmed and persisted.
    expect(res.body.user.alias).toBe("Aria");
    expect(res.body.user.visibility).toBe("private");
    // visibility persists: a fresh read reflects the stored value.
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.visibility).toBe("private");
    // …and back to `group`: those are the only two states.
    const regrouped = await agent
      .patch("/api/me")
      .send({ visibility: "group" })
      .expect(200);
    expect(regrouped.body.user.visibility).toBe("group");
    // The retired "public" state is not an error on THIS route — the profile
    // PATCH skips any unrecognized visibility and keeps the stored value.
    const retired = await agent
      .patch("/api/me")
      .send({ visibility: "public" })
      .expect(200);
    expect(retired.body.user.visibility).toBe("group");
    expect((await agent.get("/api/me").expect(200)).body.user.visibility).toBe("group");
    // The admin override route is deliberately stricter: same value, hard 400.
    await agent
      .put(`/api/admin/users/${erinId}/visibility`)
      .send({ visibility: "public" })
      .expect(400);
    // Shared (communal) account flag: off by default, toggles via the same PATCH.
    expect(me.body.user.sharedAccount).toBe(false);
    const shared = await agent
      .patch("/api/me")
      .send({ sharedAccount: true })
      .expect(200);
    expect(shared.body.user.sharedAccount).toBe(true);
    // A non-boolean value is ignored, keeping the stored flag.
    const ignored = await agent
      .patch("/api/me")
      .send({ sharedAccount: "yes" })
      .expect(200);
    expect(ignored.body.user.sharedAccount).toBe(true);
  });

  it("toggles per-secret shell exposure via PATCH /api/me/secrets/:name", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "sally").expect(201);
    await agent.put("/api/me/secrets/MY_API_KEY").send({ value: "v" }).expect(200);

    // Toggle on → reflected in shellExposedSecretNames; off → removed.
    const on = await agent
      .patch("/api/me/secrets/MY_API_KEY")
      .send({ shellExpose: true })
      .expect(200);
    expect(on.body.user.shellExposedSecretNames).toEqual(["MY_API_KEY"]);
    const off = await agent
      .patch("/api/me/secrets/MY_API_KEY")
      .send({ shellExpose: false })
      .expect(200);
    expect(off.body.user.shellExposedSecretNames).toEqual([]);

    // Guards: non-boolean body, reserved names, unknown secrets.
    await agent.patch("/api/me/secrets/MY_API_KEY").send({ shellExpose: "y" }).expect(400);
    await agent.put("/api/me/secrets/SSH_PRIVATE_KEY").send({ value: "k" }).expect(200);
    await agent
      .patch("/api/me/secrets/SSH_PRIVATE_KEY")
      .send({ shellExpose: true })
      .expect(400);
    await agent.patch("/api/me/secrets/UNSET_NAME").send({ shellExpose: true }).expect(404);
    // An empty body no longer means "shellExpose missing" alone — the PATCH now
    // carries two independent toggles, so it asks for either.
    const neither = await agent.patch("/api/me/secrets/MY_API_KEY").send({}).expect(400);
    expect(neither.body.error).toBe("shellExpose(boolean) 또는 browser 설정을 보내 주세요.");
  });

  it("toggles per-secret browser input via PATCH /api/me/secrets/:name", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "bruno").expect(201);
    // Distinctive enough that a leak into the response or the audit feed shows up.
    const SECRET_VALUE = "hunter2-corp-login";
    await agent.put("/api/me/secrets/LOGIN_PW").send({ value: SECRET_VALUE }).expect(200);

    // Enable → the policy (name + hosts + password-only) rides user.browserSecrets.
    const on = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: ["JIRA.corp.com ", "https://login.corp.com:8443/x"] } })
      .expect(200);
    expect(on.body.user.browserSecrets).toEqual([
      { name: "LOGIN_PW", hosts: ["jira.corp.com", "login.corp.com"], passwordOnly: true },
    ]);
    // The response never carries the value, only the policy.
    expect(JSON.stringify(on.body.user)).not.toContain(SECRET_VALUE);

    // passwordOnly is explicit-only when widening.
    const anyField = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com"], passwordOnly: false } })
      .expect(200);
    expect(anyField.body.user.browserSecrets[0].passwordOnly).toBe(false);

    // Disable without hosts → gone from the list, hosts remembered for next time
    // (and a repeated disable must not quietly wipe them).
    const off = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: false } })
      .expect(200);
    expect(off.body.user.browserSecrets).toEqual([]);
    await agent.patch("/api/me/secrets/LOGIN_PW").send({ browser: { enabled: false } }).expect(200);
    const back = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com"] } })
      .expect(200);
    expect(back.body.user.browserSecrets[0].hosts).toEqual(["jira.corp.com"]);

    // Both toggles in one request.
    const both = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ shellExpose: true, browser: { enabled: false } })
      .expect(200);
    expect(both.body.user.shellExposedSecretNames).toEqual(["LOGIN_PW"]);
    expect(both.body.user.browserSecrets).toEqual([]);

    // Guards: non-boolean enabled, missing/invalid hosts, over the cap, reserved
    // names, unknown secrets.
    const notBool = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: "yes", hosts: ["a.corp.com"] } })
      .expect(400);
    expect(notBool.body.error).toBe("browser.enabled(boolean)를 보내 주세요.");
    const noHosts = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true } })
      .expect(400);
    expect(noHosts.body.error).toBe(
      "브라우저 입력을 켜려면 허용 사이트(호스트)를 1개 이상 올바르게 입력해 주세요. (예: jira.corp.com)",
    );
    // An EMPTY array is a different path from an omitted one (the normalizer
    // returns [] rather than null), and it is exactly what the settings form
    // sends for an all-whitespace host box. Same refusal.
    const emptyHosts = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: [] } })
      .expect(400);
    expect(emptyHosts.body.error).toBe(
      "브라우저 입력을 켜려면 허용 사이트(호스트)를 1개 이상 올바르게 입력해 주세요. (예: jira.corp.com)",
    );
    // All-or-nothing: one wildcard poisons the whole list rather than being dropped.
    await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com", "*.corp.com"] } })
      .expect(400);
    const tooMany = await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({
        browser: {
          enabled: true,
          hosts: Array.from({ length: 21 }, (_, i) => `h${i}.corp.com`),
        },
      })
      .expect(400);
    expect(tooMany.body.error).toBe("허용 사이트는 최대 20개입니다.");
    await agent
      .patch("/api/me/secrets/LOGIN_PW")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com"], passwordOnly: "yes" } })
      .expect(400);
    await agent.put("/api/me/secrets/SSH_PRIVATE_KEY").send({ value: "k" }).expect(200);
    const reserved = await agent
      .patch("/api/me/secrets/SSH_PRIVATE_KEY")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com"] } })
      .expect(400);
    expect(reserved.body.error).toBe(
      "이 시크릿은 전용 경로로만 사용되어 브라우저에 입력할 수 없습니다.",
    );
    await agent
      .patch("/api/me/secrets/UNSET_NAME")
      .send({ browser: { enabled: true, hosts: ["jira.corp.com"] } })
      .expect(404);

    // Audit rows carry the NAME and the hosts — never the value.
    const audit = await agent.get("/api/audit").expect(200);
    const details = (audit.body.audit as { action: string; detail: string }[])
      .filter((e) => e.action === "secret_browser_expose")
      .map((e) => e.detail);
    expect(details).toContain(
      "enabled secret LOGIN_PW for browser input on [jira.corp.com, login.corp.com] (password fields only)",
    );
    expect(details).toContain(
      "enabled secret LOGIN_PW for browser input on [jira.corp.com] (any text field)",
    );
    expect(details).toContain("disabled browser input for secret LOGIN_PW");
    // Nothing in the whole audit feed echoes the stored value.
    expect(JSON.stringify(audit.body.audit)).not.toContain(SECRET_VALUE);
  });

  it("supports plugin add / list / delete", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "frank").expect(201);

    const added = await agent
      .post("/api/me/plugins")
      .send({ repo: "owner/repo", label: "My Plugin" })
      .expect(200);
    expect(added.body.plugin.repo).toBe("owner/repo");
    expect(added.body.plugin.enabled).toBe(true);

    await agent
      .post("/api/me/plugins")
      .send({ repo: "not a repo!!" })
      .expect(400);

    const list = await agent.get("/api/me/plugins").expect(200);
    expect(list.body.plugins).toHaveLength(1);

    await agent.delete(`/api/me/plugins/${added.body.plugin.id}`).expect(200);
    const after = await agent.get("/api/me/plugins").expect(200);
    expect(after.body.plugins).toHaveLength(0);
  });

  it("lets an owner create, edit, run, and delete routine jobs", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const agent = request.agent(app);
    await signup(agent, "rita").expect(201);

    // Bad input is rejected before anything is stored.
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", time: "25:00" })
      .expect(400);
    await agent
      .post("/api/me/routines")
      .send({ prompt: "", time: "09:00" })
      .expect(400);
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", time: "09:00", enabled: "true" })
      .expect(400);

    const created = await agent
      .post("/api/me/routines")
      .send({ prompt: "오늘 요약해줘", time: "09:30" })
      .expect(200);
    const routine = created.body.routine;
    expect(routine.time).toBe("09:30");
    expect(routine.enabled).toBe(true);
    expect(routine.nextRunAt).toBeTruthy();

    // The dedicated conversation exists immediately, but is listed under the
    // routine view instead of the normal chat rail.
    const regularConvs = await agent.get("/api/conversations").expect(200);
    expect(
      regularConvs.body.conversations.some(
        (c: { id: string }) => c.id === routine.conversationId,
      ),
    ).toBe(false);
    const convs = await agent
      .get("/api/conversations?kind=routine")
      .expect(200);
    const conv = convs.body.conversations.find(
      (c: { id: string }) => c.id === routine.conversationId,
    );
    expect(conv).toBeTruthy();
    expect(conv.title.startsWith("[예약 작업]")).toBe(true);
    expect(conv.isRoutine).toBe(true);
    expect(conv.routineId).toBe(routine.id);

    // Edit: disable + change time.
    const edited = await agent
      .patch(`/api/me/routines/${routine.id}`)
      .send({ enabled: false, time: "07:00" })
      .expect(200);
    expect(edited.body.routine.enabled).toBe(false);
    expect(edited.body.routine.time).toBe("07:00");
    expect(edited.body.routine.nextRunAt).toBeNull();

    // Run now (local runtime → deterministic) appends to the routine's conversation.
    const ran = await agent
      .post(`/api/me/routines/${routine.id}/run`)
      .expect(200);
    expect(ran.body.ok).toBe(true);
    expect(ran.body.routine.lastStatus).toBe("success");
    const msgs = await agent
      .get(`/api/messages?conversationId=${routine.conversationId}`)
      .expect(200);
    expect(msgs.body.messages.length).toBeGreaterThanOrEqual(2);

    // Avatar/system tools can leave user-facing in-app alerts.
    const notification = await services.store.addAvatarNotification(
      routine.avatarUserId,
      {
        avatarUserId: routine.avatarUserId,
        title: "루틴 알림",
        message: "확인할 결과가 있습니다.",
        conversationId: routine.conversationId,
      },
    );
    const notifications = await agent.get("/api/me/notifications").expect(200);
    expect(notifications.body.notifications[0].id).toBe(notification.id);
    await agent
      .patch(`/api/me/notifications/${notification.id}/read`)
      .expect(200);
    const unread = await agent
      .get("/api/me/notifications?unread=1")
      .expect(200);
    expect(unread.body.notifications).toHaveLength(0);
    await agent.delete(`/api/me/notifications/${notification.id}`).expect(200);
    const emptyNotifications = await agent
      .get("/api/me/notifications")
      .expect(200);
    expect(emptyNotifications.body.notifications).toHaveLength(0);
    services.store.addAvatarNotification(routine.avatarUserId, {
      avatarUserId: routine.avatarUserId,
      title: "첫 번째 알림",
      message: "정리 대상입니다.",
      conversationId: routine.conversationId,
    });
    services.store.addAvatarNotification(routine.avatarUserId, {
      avatarUserId: routine.avatarUserId,
      title: "두 번째 알림",
      message: "함께 삭제됩니다.",
      conversationId: routine.conversationId,
    });
    const cleared = await agent.delete("/api/me/notifications").expect(200);
    expect(cleared.body.deleted).toBe(2);
    const afterClear = await agent.get("/api/me/notifications").expect(200);
    expect(afterClear.body.notifications).toHaveLength(0);

    // Another user cannot touch it.
    const { agent: stranger } = await newUser(app, "sam");
    await stranger
      .patch(`/api/me/routines/${routine.id}`)
      .send({ prompt: "x" })
      .expect(404);
    await stranger.delete(`/api/me/routines/${routine.id}`).expect(404);

    await agent.delete(`/api/me/routines/${routine.id}`).expect(200);
    const list = await agent.get("/api/me/routines").expect(200);
    expect(list.body.routines).toHaveLength(0);
  });

  it("creates weekly and interval routines and rejects invalid schedules", async () => {
    const app = testApp();
    const agent = request.agent(app);
    await signup(agent, "wendy").expect(201);

    // Weekly with weekdays + time persists.
    const weekly = await agent
      .post("/api/me/routines")
      .send({
        name: "주간 회고",
        prompt: "주간 회고를 정리해줘",
        scheduleKind: "weekly",
        time: "09:00",
        daysOfWeek: [1, 3, 5],
      })
      .expect(200);
    expect(weekly.body.routine.name).toBe("주간 회고");
    expect(weekly.body.routine.scheduleKind).toBe("weekly");
    expect(weekly.body.routine.daysOfWeek).toEqual([1, 3, 5]);
    expect(weekly.body.routine.time).toBe("09:00");
    expect(weekly.body.routine.nextRunAt).toBeTruthy();

    // Interval persists.
    const interval = await agent
      .post("/api/me/routines")
      .send({
        prompt: "30분마다 점검",
        scheduleKind: "interval",
        intervalMinutes: 30,
      })
      .expect(200);
    expect(interval.body.routine.scheduleKind).toBe("interval");
    expect(interval.body.routine.intervalMinutes).toBe(30);
    expect(interval.body.routine.nextRunAt).toBeTruthy();

    // One-time schedules preserve their KST calendar date and complete after
    // their single execution attempt.
    const once = await agent
      .post("/api/me/routines")
      .send({
        name: "출시일 점검",
        prompt: "출시 상태를 한 번 점검해줘",
        scheduleKind: "once",
        date: "2099-12-30",
        time: "14:30",
      })
      .expect(200);
    expect(once.body.routine.scheduleKind).toBe("once");
    expect(once.body.routine.runDate).toBe("2099-12-30");
    expect(once.body.routine.nextRunAt).toBe("2099-12-30T05:30:00.000Z");
    expect(once.body.routine.completedAt).toBeNull();

    const ranOnce = await agent
      .post(`/api/me/routines/${once.body.routine.id}/run`)
      .expect(200);
    expect(ranOnce.body.routine.enabled).toBe(false);
    expect(ranOnce.body.routine.nextRunAt).toBeNull();
    expect(ranOnce.body.routine.completedAt).toBeTruthy();

    // Picking a new future slot explicitly reschedules and clears completion.
    const rescheduledOnce = await agent
      .patch(`/api/me/routines/${once.body.routine.id}`)
      .send({ scheduleKind: "once", date: "2099-12-31", time: "10:00", enabled: true })
      .expect(200);
    expect(rescheduledOnce.body.routine.enabled).toBe(true);
    expect(rescheduledOnce.body.routine.runDate).toBe("2099-12-31");
    expect(rescheduledOnce.body.routine.completedAt).toBeNull();

    // Weekly without weekdays → 400.
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "weekly", time: "09:00" })
      .expect(400);
    // Interval with an out-of-range value → 400.
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "interval", intervalMinutes: 4 })
      .expect(400);
    // One-time schedules require a real future KST date.
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "once", time: "09:00" })
      .expect(400);
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "once", date: "2026-02-30", time: "09:00" })
      .expect(400);
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "once", date: "2000-01-01", time: "09:00" })
      .expect(400);
    // Unknown schedule kind → 400.
    await agent
      .post("/api/me/routines")
      .send({ prompt: "p", scheduleKind: "monthly", time: "09:00" })
      .expect(400);

    // PATCH name-only does not reschedule.
    const before = weekly.body.routine.nextRunAt;
    const renamed = await agent
      .patch(`/api/me/routines/${weekly.body.routine.id}`)
      .send({ name: "주간 정리" })
      .expect(200);
    expect(renamed.body.routine.name).toBe("주간 정리");
    expect(renamed.body.routine.nextRunAt).toBe(before);

    // PATCH switching the schedule to interval replaces it as a unit.
    const switched = await agent
      .patch(`/api/me/routines/${weekly.body.routine.id}`)
      .send({ scheduleKind: "interval", intervalMinutes: 60 })
      .expect(200);
    expect(switched.body.routine.scheduleKind).toBe("interval");
    expect(switched.body.routine.intervalMinutes).toBe(60);
    expect(switched.body.routine.daysOfWeek).toBeNull();
  });

  it("shows group avatars to co-members only, and private ones to nobody but the owner", async () => {
    const app = testApp();
    // First signup is the system admin who creates groups + assigns members.
    const admin = request.agent(app);
    await signup(admin, "gina").expect(201);

    // A group-visible avatar (the default) — reachable only through a shared group.
    const grouped = request.agent(app);
    const groupedRes = await signup(grouped, "henry").expect(201);
    expect(groupedRes.body.user.visibility).toBe("group");

    // A private avatar is hidden from everyone but its owner, teammate or not.
    const secret = request.agent(app);
    const secretRes = await signup(secret, "iris").expect(201);
    await secret.patch("/api/me").send({ visibility: "private" }).expect(200);

    // The co-member shares a group with BOTH of them; the stranger shares none.
    const member = request.agent(app);
    await signup(member, "ivy").expect(201);
    const stranger = request.agent(app);
    await signup(stranger, "jack").expect(201);
    await shareGroup(admin, ["henry", "iris", "ivy"], "Platform");

    // Co-member: the group-visible avatar is listed and fetchable…
    const memberIds = (await member.get("/api/avatars").expect(200)).body.avatars.map(
      (a: { id: string }) => a.id,
    );
    expect(memberIds).toContain(groupedRes.body.user.id);
    await member.get(`/api/avatars/${groupedRes.body.user.id}`).expect(200);
    // …but the private one stays invisible even to a co-member.
    expect(memberIds).not.toContain(secretRes.body.user.id);
    await member.get(`/api/avatars/${secretRes.body.user.id}`).expect(404);

    // Stranger: neither avatar is listed, and both direct fetches 404. There is
    // no visibility state that reaches beyond the viewer's groups anymore.
    const strangerIds = (await stranger.get("/api/avatars").expect(200)).body.avatars.map(
      (a: { id: string }) => a.id,
    );
    expect(strangerIds).not.toContain(groupedRes.body.user.id);
    expect(strangerIds).not.toContain(secretRes.body.user.id);
    await stranger.get(`/api/avatars/${groupedRes.body.user.id}`).expect(404);
    await stranger.get(`/api/avatars/${secretRes.body.user.id}`).expect(404);

    // The owner always reaches their own avatar, private or not.
    await secret.get(`/api/avatars/${secretRes.body.user.id}`).expect(200);
  });

  it("grants group co-members reach + elevation to a group-visible avatar", async () => {
    const app = testApp();
    // First signup is the system admin who creates groups + assigns members.
    const admin = request.agent(app);
    await signup(admin, "adam").expect(201);

    const owner = request.agent(app);
    const ownerRes = await signup(owner, "olga").expect(201);
    await owner.patch("/api/me").send({ visibility: "group" }).expect(200);

    const friend = request.agent(app);
    const friendRes = await signup(friend, "fred").expect(201);

    // Before sharing a group: the friend can't see or chat the group-visible avatar.
    await friend.get(`/api/avatars/${ownerRes.body.user.id}`).expect(404);
    await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕" })
      .expect(403);

    // Admin creates a group and adds both as members → they become co-members.
    const grp = await admin
      .post("/api/admin/groups")
      .send({ name: "Platform" })
      .expect(200);
    const groupId = grp.body.group.id;
    await admin
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "olga" })
      .expect(200);
    await admin
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "fred" })
      .expect(200);

    // Now the friend sees the avatar as elevated (group co-membership) and can chat.
    const detail = await friend
      .get(`/api/avatars/${ownerRes.body.user.id}`)
      .expect(200);
    expect(detail.body.avatar.elevated).toBe(true);
    expect(detail.body.avatar.isOwn).toBe(false);
    const chat = await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕" })
      .expect(200);
    expect(parseSse(chat.text).find((f) => f.event === "done")).toBeTruthy();

    // Removing the friend from the group revokes both reach and elevation.
    await admin
      .delete(`/api/admin/groups/${groupId}/members/${friendRes.body.user.id}`)
      .expect(200);
    await friend.get(`/api/avatars/${ownerRes.body.user.id}`).expect(404);
  });

  it("turning a group's avatar sharing off fails the NEXT chat turn closed", async () => {
    const app = testApp();
    const admin = request.agent(app);
    await signup(admin, "adam-sharing").expect(201);
    const owner = request.agent(app);
    const ownerId = (await signup(owner, "olga-sharing").expect(201)).body.user
      .id as string;
    const friend = request.agent(app);
    await signup(friend, "fred-sharing").expect(201);
    const groupId = await shareGroup(admin, ["olga-sharing", "fred-sharing"], "FlipTeam");

    // Mid-conversation baseline: the co-member chats fine.
    await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "flip-conv", message: "안녕" })
      .expect(200);

    // The group admin (here: the system admin via canManageGroup) flips the
    // policy off → the same conversation's NEXT turn is blocked (history kept),
    // mirroring the leave-group / external-revocation fail-closed semantics.
    await admin
      .put(`/api/me/groups/${groupId}/avatar-sharing`)
      .send({ enabled: false })
      .expect(200);
    const blocked = await friend
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: "flip-conv", message: "계속" })
      .expect(403);
    expect(blocked.body.error).toContain("대화할 수 없습니다");
    await friend.get(`/api/avatars/${ownerId}`).expect(404);
  });

  it("searches users for the group member-add picker (by name/@id, self excluded)", async () => {
    const app = testApp();
    const owner = request.agent(app);
    await signup(owner, "olga").expect(201);
    const friend = request.agent(app);
    await signup(friend, "fred").expect(201);

    // Match by substring; the searcher (olga) is never in their own results.
    const hit = await owner.get("/api/me/users/search?q=fre").expect(200);
    expect(hit.body.users.map((u: { username: string }) => u.username)).toEqual(
      ["fred"],
    );
    const self = await owner.get("/api/me/users/search?q=olga").expect(200);
    expect(self.body.users).toEqual([]);
    // Blank query → no results, no error.
    expect(
      (await owner.get("/api/me/users/search?q=").expect(200)).body.users,
    ).toEqual([]);
  });

  it("streams a local-runtime chat and persists conversation + messages", async () => {
    const app = testApp();
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "judy").expect(201);

    const res = await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerRes.body.user.id, message: "안녕하세요" })
      .expect(200);

    const frames = parseSse(res.text);
    const open = frames.find((f) => f.event === "open");
    expect(open).toBeTruthy();
    const done = frames.find((f) => f.event === "done");
    expect(done).toBeTruthy();
    const donePayload = done!.data as {
      message: { content: string };
      response: { text: string; runtime: string };
    };
    expect(donePayload.response.runtime).toBe("local");
    expect(donePayload.response.text).toBe("[local] 안녕하세요");
    expect(donePayload.message.content).toBe("[local] 안녕하세요");

    const convId = (open!.data as { conversationId: string }).conversationId;
    const convs = await owner.get("/api/conversations").expect(200);
    expect(
      convs.body.conversations.some((c: { id: string }) => c.id === convId),
    ).toBe(true);

    const messages = await owner
      .get(`/api/messages?conversationId=${convId}`)
      .expect(200);
    expect(messages.body.messages).toHaveLength(2);
    expect(messages.body.messages[0].role).toBe("user");
    expect(messages.body.messages[1].role).toBe("assistant");
    expect(messages.body.messages[1].content).toBe("[local] 안녕하세요");
  });

  it("lists an avatar's skills from bundled default plugins", async () => {
    // A default-plugins dir with one skill; runtime must be "claude" (the local
    // runtime loads no skills). No avatar plugins, so nothing is cloned.
    const pluginsDir = path.join(tempDir, "default-skills");
    fs.mkdirSync(path.join(pluginsDir, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginsDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "defaults" }),
    );
    const skillDir = path.join(pluginsDir, "skills", "greet");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Greeter\ndescription: Greets colleagues warmly\n---\n# body",
    );

    const app = createApp(
      createServices({
        dataDir: tempDir,
        agentRuntime: "pi", pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false },
        sessionSecret: "test",
        defaultPluginsDir: pluginsDir,
      }),
    );
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "skilluser").expect(201);

    const res = await owner
      .get(`/api/avatars/${ownerRes.body.user.id}/skills`)
      .expect(200);
    expect(res.body.skills).toEqual([
      {
        name: "Greeter",
        description: "Greets colleagues warmly",
        source: "default",
      },
    ]);
  });

  it("returns an empty skill list under the local runtime", async () => {
    const app = testApp(); // agentRuntime: "local"
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "localskill").expect(201);
    const res = await owner
      .get(`/api/avatars/${ownerRes.body.user.id}/skills`)
      .expect(200);
    expect(res.body.skills).toEqual([]);
  });

  it("hides skills of a private, non-own avatar (404)", async () => {
    const app = testApp();
    const hidden = request.agent(app);
    const hiddenRes = await signup(hidden, "kevin").expect(201);
    await hidden.patch("/api/me").send({ visibility: "private" }).expect(200);

    const viewer = request.agent(app);
    await signup(viewer, "laura").expect(201);
    await viewer
      .get(`/api/avatars/${hiddenRes.body.user.id}/skills`)
      .expect(404);
  });

  it("returns 401 for unauthenticated requests", async () => {
    const app = testApp();
    await request(app).get("/api/me/plugins").expect(401);
    const me = await request(app).get("/api/me").expect(200);
    expect(me.body.user).toBeNull();
  });

  it("forbids admin-only endpoints for members (403)", async () => {
    const app = testApp();
    await signup(request.agent(app), "admin-user").expect(201); // first → admin

    const member = request.agent(app);
    await signup(member, "member-user").expect(201);
    await member.get("/api/admin/users").expect(403);
  });

  it("allows admin to list users", async () => {
    const app = testApp();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/users").expect(200);
    expect(res.body.users.length).toBe(1);
    expect(res.body.users[0].username).toBe("boss");
    expect(res.body.users[0].activeSessions).toBe(1);
  });

  it("reports live presence to an admin and 403s a member", async () => {
    const app = testApp();
    const admin = request.agent(app);
    await signup(admin, "boss").expect(201); // first → admin
    const member = request.agent(app);
    await signup(member, "member-user").expect(201);

    await member.get("/api/admin/presence").expect(403);

    // Both agents just authenticated, so both stamps are inside the window.
    const res = await admin.get("/api/admin/presence").expect(200);
    expect(res.body.presence.windowMinutes).toBe(60);
    expect(res.body.presence.users.map((u: { username: string }) => u.username).sort()).toEqual([
      "boss",
      "member-user",
    ]);
  });

  it("no longer serves the removed claude setup-token endpoints", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "boss"); // first → admin
    await admin.put("/api/admin/claude-token").send({ token: "sk-ant-oat01-x" }).expect(404);
    await admin.delete("/api/admin/claude-token").expect(404);
    const sys = (await admin.get("/api/admin/system").expect(200)).body.system;
    for (const gone of ["subscriptionConnected", "apiKeyOverride", "authMode", "readOnlyTools", "configuredModel", "modelEnvLocked"]) {
      expect(sys).not.toHaveProperty(gone);
    }
  });

  it("exposes system/runtime info to admins, gated from members", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);

    const admin = request.agent(app);
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/system").expect(200);
    expect(res.body.system.agentRuntime).toBe("local");
    // The local stub has no pi, so no models, and never reports one.
    expect(res.body.system.piModels).toEqual([]);
    expect(res.body.system.observedModel).toBeNull();
    expect(
      res.body.system.hexSshTools.map((t: { name: string }) => t.name),
    ).toContain("remote-ssh");
    expect(res.body.system.hexSshToolPolicy.owner).toContain("remote-ssh");
    expect(res.body.system.hexSshToolPolicy.trusted).toContain(
      "ssh-read-lines",
    );
    expect(res.body.system.hexSshToolPolicy.trusted).not.toContain(
      "remote-ssh",
    );

    const member = request.agent(app);
    await signup(member, "peon").expect(201);
    await member.get("/api/admin/system").expect(403);
  });

  it("lets admins manage the hex-ssh tool policy and blocks members", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "boss");
    const { agent: member } = await newUser(app, "member1");

    const policy = {
      owner: ["ssh-read-lines", "remote-ssh"],
      trusted: ["ssh-read-lines"],
      colleague: [],
    };
    const saved = await admin
      .put("/api/admin/hex-ssh-policy")
      .send({ policy })
      .expect(200);
    expect(saved.body.policy).toEqual(policy);

    const system = await admin.get("/api/admin/system").expect(200);
    expect(system.body.system.hexSshToolPolicy).toEqual(policy);

    await admin
      .put("/api/admin/hex-ssh-policy")
      .send({ policy: { owner: [] } })
      .expect(400);
    await member.put("/api/admin/hex-ssh-policy").send({ policy }).expect(403);
  });

  it("lets admins manage the builtin tool/skill policy and blocks members", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "boss");
    const { agent: member } = await newUser(app, "member1");

    const before = await admin.get("/api/admin/system").expect(200);
    expect(before.body.system.toolSkillPolicy).toEqual({ disabledTools: [], disabledSkills: [] });
    expect(
      before.body.system.togglableBuiltinTools.flatMap((t: { names: string[] }) => t.names),
    ).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    // The global skill list is read from the bundled default-skills root (no CLI preflight).
    expect(Array.isArray(before.body.system.skillDiscovery.skills)).toBe(true);
    expect(before.body.system.skillDiscovery).not.toHaveProperty("cliVersion");

    const policy = { disabledTools: ["WebFetch", "WebSearch"], disabledSkills: ["code-review"] };
    const saved = await admin.put("/api/admin/tool-skill-policy").send({ policy }).expect(200);
    expect(saved.body.policy).toEqual(policy);

    const system = await admin.get("/api/admin/system").expect(200);
    expect(system.body.system.toolSkillPolicy).toEqual(policy);

    // Strict write path: core tools outside the togglable catalog, missing
    // fields, and malformed skill names are all rejected (never silently dropped).
    await admin
      .put("/api/admin/tool-skill-policy")
      .send({ policy: { disabledTools: ["Bash"], disabledSkills: [] } })
      .expect(400);
    await admin
      .put("/api/admin/tool-skill-policy")
      .send({ policy: { disabledTools: [] } })
      .expect(400);
    await admin
      .put("/api/admin/tool-skill-policy")
      .send({ policy: { disabledTools: [], disabledSkills: ["bad name"] } })
      .expect(400);
    await member.put("/api/admin/tool-skill-policy").send({ policy }).expect(403);
  });

  it("reports pi-gateway's live model list, never the retired PI_MODEL_MAP", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "pi",
      sessionSecret: "test",
      pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false },
    });
    piServicesFor(services.store, services.config).models = createPiModelCatalog({
      listModels: async () => [{ id: "deepseek/v3", ownedBy: "deepseek" }, { id: "qwen/coder" }],
    });
    const admin = request.agent(createApp(services));
    await signup(admin, "boss").expect(201);
    const res = await admin.get("/api/admin/system").expect(200);
    expect(res.body.system.agentRuntime).toBe("pi");
    expect(res.body.system.piModels).toEqual([
      { id: "deepseek/v3", server: "deepseek" },
      { id: "qwen/coder", server: null },
    ]);
    expect(res.body.system.modelOverrideChoices).toEqual(["deepseek/v3", "qwen/coder"]);
    expect(res.body.system).not.toHaveProperty("piModelMap");
    services.store.close();
  });

  // ---- Input validation -------------------------------------------------

  it("rejects invalid signup input (short/invalid username, short password)", async () => {
    const app = testApp();
    await request(app)
      .post("/api/auth/signup")
      .send({ username: "ab", displayName: "x", password: "password123" })
      .expect(400);
    await request(app)
      .post("/api/auth/signup")
      .send({
        username: "has space",
        displayName: "x",
        password: "password123",
      })
      .expect(400);
    await request(app)
      .post("/api/auth/signup")
      .send({ username: "validname", displayName: "x", password: "short" })
      .expect(400);
  });

  it("never returns the password hash to the client", async () => {
    const app = testApp();
    const { user } = await newUser(app, "secure");
    expect(user).not.toHaveProperty("password_hash");
    expect(user).not.toHaveProperty("passwordHash");
  });

  // ---- Session lifecycle ------------------------------------------------

  it("clears the session on logout", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "lori");
    await agent.get("/api/me/plugins").expect(200);
    await agent.post("/api/auth/logout").expect(200);
    await agent.get("/api/me/plugins").expect(401);
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user).toBeNull();
  });

  // ---- Profile + persona ------------------------------------------------

  it("stores bio/persona and exposes persona + plugins on the owner's avatar detail", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "mira");
    await agent
      .patch("/api/me")
      .send({
        bio: "도우미",
        persona: "간결하게",
        alias: "미라봇",
      })
      .expect(200);
    await agent
      .post("/api/me/plugins")
      .send({ repo: "owner/tool", label: "Tool" })
      .expect(200);

    const detail = await agent.get(`/api/avatars/${user.id}`).expect(200);
    expect(detail.body.avatar.isOwn).toBe(true);
    expect(detail.body.avatar.persona).toBe("간결하게");
    expect(detail.body.avatar.alias).toBe("미라봇");
    expect(detail.body.avatar.plugins.length).toBe(1);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.pluginCount).toBe(1);
  });

  it("stores and exposes the avatar self-introduction, and generates one on demand", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "intro");
    await agent
      .patch("/api/me")
      .send({
        alias: "소개봇",
        intro: "안녕하세요, 저는 도와드립니다.",
      })
      .expect(200);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.intro).toBe("안녕하세요, 저는 도와드립니다.");
    const detail = await agent.get(`/api/avatars/${user.id}`).expect(200);
    expect(detail.body.avatar.intro).toBe("안녕하세요, 저는 도와드립니다.");

    // The local runtime returns a deterministic placeholder naming the avatar.
    const gen = await agent.post("/api/me/intro/generate").expect(200);
    expect(typeof gen.body.intro).toBe("string");
    expect(gen.body.intro).toContain("소개봇");
    // Generating does NOT persist — the stored value is unchanged until saved.
    const after = await agent.get("/api/me").expect(200);
    expect(after.body.user.intro).toBe("안녕하세요, 저는 도와드립니다.");
  });

  // ---- Avatar image -----------------------------------------------------

  it("uploads, serves, and deletes an avatar image", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "nina");

    await request(app).get(`/api/users/${user.id}/avatar-image`).expect(404);

    const up = await agent
      .put("/api/me/avatar-image")
      .send({ image: PNG_DATA_URL })
      .expect(200);
    expect(up.body.hasImage).toBe(true);

    const img = await request(app)
      .get(`/api/users/${user.id}/avatar-image`)
      .expect(200);
    expect(img.headers["content-type"]).toContain("image/png");

    await agent.delete("/api/me/avatar-image").expect(200);
    await request(app).get(`/api/users/${user.id}/avatar-image`).expect(404);
  });

  it("rejects a non-image avatar upload and oversized images", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "olga");
    await agent
      .put("/api/me/avatar-image")
      .send({ image: "data:text/plain;base64,aGVsbG8=" })
      .expect(400);
    // > 2MB once base64-decoded, but kept under the 3MB body limit.
    const oversized = `data:image/png;base64,${"A".repeat(2_800_000)}`;
    await agent
      .put("/api/me/avatar-image")
      .send({ image: oversized })
      .expect(400);
  });

  // ---- Plugins ----------------------------------------------------------

  it("toggles a plugin's enabled flag and 404s on unknown plugin", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "pat");
    const added = await agent
      .post("/api/me/plugins")
      .send({ repo: "owner/repo" })
      .expect(200);
    const id = added.body.plugin.id;

    const off = await agent
      .patch(`/api/me/plugins/${id}`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.plugin.enabled).toBe(false);

    await agent.patch(`/api/me/plugins/${id}`).send({}).expect(400);
    await agent.delete("/api/me/plugins/does-not-exist").expect(404);
  });

  // ---- Chat validation + authorization ----------------------------------

  it("validates chat input and forbids chatting with a private avatar", async () => {
    const app = testApp();
    const { agent: ownerAgent, user: owner } = await newUser(app, "quinn");
    await ownerAgent
      .patch("/api/me")
      .send({ visibility: "private" })
      .expect(200);
    const viewer = (await newUser(app, "rex")).agent;

    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, message: "" })
      .expect(400);
    await viewer.post("/api/chat/stream").send({ message: "hi" }).expect(400);
    // owner avatar is private and not the viewer's own → 403.
    await viewer
      .post("/api/chat/stream")
      .send({ avatarId: owner.id, message: "hi" })
      .expect(403);
  });

  it("allows mixed-avatar split sessions and refuses cross-avatar conversation reuse", async () => {
    const app = testApp();
    // split-owner is the first signup, so it is also the system admin that can
    // create the group making split-other's avatar reachable.
    const { agent, user } = await newUser(app, "split-owner");
    const other = request.agent(app);
    const otherRes = await signup(other, "split-other").expect(201);
    await shareGroup(agent, ["split-owner", "split-other"]);

    await agent
      .post("/api/chat/stream")
      .send({
        avatarId: otherRes.body.user.id,
        message: "hi",
        multiSession: true,
      })
      .expect(200);

    const first = await agent
      .post("/api/chat/stream")
      .send({
        avatarId: user.id,
        conversationId: "split-conv-1",
        message: "내 작업",
      })
      .expect(200);
    expect(parseSse(first.text).find((f) => f.event === "done")).toBeTruthy();

    await agent
      .post("/api/chat/stream")
      .send({
        avatarId: otherRes.body.user.id,
        conversationId: "split-conv-1",
        message: "섞기",
      })
      .expect(409);
  });

  it("regenerate replaces the last reply instead of duplicating the turn", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "sam");

    const first = await agent
      .post("/api/chat/stream")
      .send({ avatarId: user.id, message: "처음" })
      .expect(200);
    const convId = (
      parseSse(first.text).find((f) => f.event === "open")!.data as {
        conversationId: string;
      }
    ).conversationId;

    await agent
      .post("/api/chat/stream")
      .send({
        avatarId: user.id,
        message: "처음",
        conversationId: convId,
        regenerate: true,
      })
      .expect(200);

    const messages = await agent
      .get(`/api/messages?conversationId=${convId}`)
      .expect(200);
    expect(messages.body.messages).toHaveLength(2); // not 3 or 4
  });

  it("rejects an empty first turn even when a stale client sends greeting=true", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "gwen").expect(201);
    const ownerId = ownerRes.body.user.id;

    services.store.addKnowledgeRequest(ownerId, {
      question: "출시일?",
      askerName: "동료A",
    });

    const convId = "greet-conv-1";
    await owner
      .post("/api/chat/stream")
      .send({ avatarId: ownerId, conversationId: convId, greeting: true })
      .expect(400);

    const after = await owner
      .get(`/api/messages?conversationId=${convId}`)
      .expect(200);
    expect(after.body.messages).toHaveLength(0);

    const stillOpen = await owner
      .get("/api/me/knowledge/requests?status=open")
      .expect(200);
    expect(stillOpen.body.requests).toHaveLength(1);
  });

  it("exposes a runId on the chat stream and guards the respond endpoint", async () => {
    const app = testApp();
    const { agent, user } = await newUser(app, "ivy");

    const chat = await agent
      .post("/api/chat/stream")
      .send({ avatarId: user.id, message: "hi" })
      .expect(200);
    const open = parseSse(chat.text).find((f) => f.event === "open")!.data as {
      runId?: string;
    };
    expect(typeof open.runId).toBe("string");

    // Auth required.
    await request(app)
      .post("/api/chat/respond")
      .send({ runId: open.runId, requestId: "x" })
      .expect(401);
    // Missing fields → 400.
    await agent
      .post("/api/chat/respond")
      .send({ runId: open.runId })
      .expect(400);
    // Run already finished (local runtime resolves synchronously) → 404.
    await agent
      .post("/api/chat/respond")
      .send({
        runId: open.runId,
        requestId: "nope",
        value: { behavior: "allow" },
      })
      .expect(404);
    // Unknown run → 404.
    await agent
      .post("/api/chat/respond")
      .send({ runId: "ghost", requestId: "x", value: {} })
      .expect(404);
  });

  // ---- Conversation ownership ------------------------------------------

  it("renames and deletes conversations, and isolates them between users", async () => {
    const app = testApp();
    const { agent: a, user: ua } = await newUser(app, "tina");
    const chat = await a
      .post("/api/chat/stream")
      .send({ avatarId: ua.id, message: "hi" })
      .expect(200);
    const convId = (
      parseSse(chat.text).find((f) => f.event === "open")!.data as {
        conversationId: string;
      }
    ).conversationId;

    const renamed = await a
      .patch(`/api/conversations/${convId}`)
      .send({ title: "내 첫 대화" })
      .expect(200);
    expect(renamed.body.conversation.title).toBe("내 첫 대화");

    // Another user cannot read or mutate someone else's conversation.
    const b = (await newUser(app, "uma")).agent;
    const peek = await b
      .get(`/api/messages?conversationId=${convId}`)
      .expect(200);
    expect(peek.body.messages).toHaveLength(0);
    await b
      .patch(`/api/conversations/${convId}`)
      .send({ title: "hijack" })
      .expect(404);
    await b.delete(`/api/conversations/${convId}`).expect(404);

    await a.delete(`/api/conversations/${convId}`).expect(200);
    const convs = await a.get("/api/conversations").expect(200);
    expect(
      convs.body.conversations.some((c: { id: string }) => c.id === convId),
    ).toBe(false);
  });

  it("bulk deletes only the caller's regular chat conversations", async () => {
    const app = testApp();
    const { agent: a, user: ua } = await newUser(app, "bulk-owner");
    const first = await a
      .post("/api/chat/stream")
      .send({ avatarId: ua.id, message: "one" })
      .expect(200);
    const second = await a
      .post("/api/chat/stream")
      .send({ avatarId: ua.id, message: "two" })
      .expect(200);
    const firstId = (
      parseSse(first.text).find((f) => f.event === "open")!.data as {
        conversationId: string;
      }
    ).conversationId;
    const secondId = (
      parseSse(second.text).find((f) => f.event === "open")!.data as {
        conversationId: string;
      }
    ).conversationId;
    const routine = await a
      .post("/api/me/routines")
      .send({ prompt: "매일 정리", time: "09:00" })
      .expect(200);

    const { agent: b, user: ub } = await newUser(app, "bulk-other");
    const otherChat = await b
      .post("/api/chat/stream")
      .send({ avatarId: ub.id, message: "other" })
      .expect(200);
    const otherId = (
      parseSse(otherChat.text).find((f) => f.event === "open")!.data as {
        conversationId: string;
      }
    ).conversationId;

    const cleared = await a.delete("/api/conversations").expect(200);
    expect(new Set(cleared.body.conversationIds)).toEqual(
      new Set([firstId, secondId]),
    );
    expect(cleared.body.deleted).toBe(2);

    const ownerChats = await a.get("/api/conversations").expect(200);
    expect(ownerChats.body.conversations).toHaveLength(0);
    const routines = await a.get("/api/conversations?kind=routine").expect(200);
    expect(
      routines.body.conversations.map((c: { id: string }) => c.id),
    ).toContain(routine.body.routine.conversationId);
    const otherChats = await b.get("/api/conversations").expect(200);
    expect(
      otherChats.body.conversations.map((c: { id: string }) => c.id),
    ).toEqual([otherId]);
  });

  // ---- Admin role management -------------------------------------------

  it("lets an admin grant/revoke the admin role and blocks self-deletion", async () => {
    const app = testApp();
    const { agent: admin, user: adminUser } = await newUser(app, "vera"); // first → admin
    const { user: member } = await newUser(app, "walt");

    const granted = await admin
      .post(`/api/admin/users/${member.id}/roles`)
      .send({ role: "admin", grant: true })
      .expect(200);
    expect(granted.body.user.roles).toContain("admin");

    const revoked = await admin
      .post(`/api/admin/users/${member.id}/roles`)
      .send({ role: "admin", grant: false })
      .expect(200);
    expect(revoked.body.user.roles).not.toContain("admin");

    await admin.delete(`/api/admin/users/${adminUser.id}`).expect(400); // can't delete self
    await admin.delete(`/api/admin/users/${member.id}`).expect(200);
    const users = await admin.get("/api/admin/users").expect(200);
    expect(
      users.body.users.some((u: { id: string }) => u.id === member.id),
    ).toBe(false);
  });

  it("forbids members from admin user-management endpoints", async () => {
    const app = testApp();
    await newUser(app, "admin2"); // first → admin
    const { agent: member, user } = await newUser(app, "mem2");
    await member.delete(`/api/admin/users/${user.id}`).expect(403);
    await member
      .post(`/api/admin/users/${user.id}/roles`)
      .send({ role: "admin", grant: true })
      .expect(403);
  });

  // ---- Audit ------------------------------------------------------------

  it("resolves single-plugin, marketplace, and non-plugin repos correctly", async () => {
    const mkPlugin = (root: string) => {
      fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(root, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "p" }),
      );
    };

    // Single-plugin repo → [root]
    const single = path.join(tempDir, "single");
    mkPlugin(single);
    expect(await resolvePluginRoots(single, "single")).toEqual([single]);

    // Marketplace repo → each listed sub-plugin dir
    const market = path.join(tempDir, "market");
    fs.mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "m",
        plugins: [{ name: "confluence", source: "./plugins/confluence" }],
      }),
    );
    mkPlugin(path.join(market, "plugins", "confluence"));
    expect(await resolvePluginRoots(market, "market")).toEqual([
      path.join(market, "plugins", "confluence"),
    ]);

    // Neither → empty + a warning
    const bare = path.join(tempDir, "bare");
    fs.mkdirSync(bare, { recursive: true });
    const warns: string[] = [];
    expect(
      await resolvePluginRoots(bare, "bare", (m) => warns.push(m)),
    ).toEqual([]);
    expect(warns.length).toBe(1);
  });

  it("backfills knowledge: a colleague's gap is queued and resolved (closed)", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const owner = request.agent(app);
    const ownerRes = await signup(owner, "olga").expect(201);
    const ownerId = ownerRes.body.user.id;

    // The agent's request_info tool records gaps via the store; simulate one.
    services.store.addKnowledgeRequest(ownerId, {
      question: "다음 출시일은 언제인가요?",
      askerName: "동료A",
    });

    const open = await owner
      .get("/api/me/knowledge/requests?status=open")
      .expect(200);
    expect(open.body.requests).toHaveLength(1);
    const reqId = open.body.requests[0].id;
    expect(open.body.requests[0].askerName).toBe("동료A");

    // Resolving takes no body: there is no stored answer (the owner teaches the
    // avatar via plugins). Closing the request is the whole action.
    await owner.delete(`/api/me/knowledge/requests/${reqId}`).expect(200);

    const stillOpen = await owner
      .get("/api/me/knowledge/requests?status=open")
      .expect(200);
    expect(stillOpen.body.requests).toHaveLength(0);
    const resolved = await owner
      .get("/api/me/knowledge/requests?status=resolved")
      .expect(200);
    expect(resolved.body.requests).toHaveLength(1);
    expect(resolved.body.requests[0].status).toBe("resolved");
  });

  it("isolates knowledge between avatars and 404s on cross-owner access", async () => {
    const services = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const app = createApp(services);
    const ann = request.agent(app);
    const annRes = await signup(ann, "ann").expect(201);
    const bob = request.agent(app);
    await signup(bob, "bob").expect(201);

    const req = services.store.addKnowledgeRequest(annRes.body.user.id, {
      question: "ann만의 질문",
    });

    expect(
      (await ann.get("/api/me/knowledge/requests").expect(200)).body.requests,
    ).toHaveLength(1);
    expect(
      (await bob.get("/api/me/knowledge/requests").expect(200)).body.requests,
    ).toHaveLength(0);

    // Bob cannot resolve Ann's request.
    await bob.delete(`/api/me/knowledge/requests/${req.id}`).expect(404);
    // Ann can resolve her own.
    await ann.delete(`/api/me/knowledge/requests/${req.id}`).expect(200);
    // Resolving again (no longer open) → 404.
    await ann.delete(`/api/me/knowledge/requests/${req.id}`).expect(404);
  });

  it("loads the repo-bundled default plugin for every avatar", async () => {
    const { config } = createServices({
      dataDir: tempDir,
      agentRuntime: "local",
      sessionSecret: "test",
    });
    const roots = await loadDefaultPluginRoots(config);
    expect(roots).toHaveLength(1);
    expect(roots[0].path).toContain("default-skills");
  });

  it("scopes the audit log: admin sees all, members see their own", async () => {
    const app = testApp();
    const { agent: admin } = await newUser(app, "xena"); // admin
    const { agent: member } = await newUser(app, "yuki");

    const adminAudit = await admin.get("/api/audit").expect(200);
    const actors = new Set(
      adminAudit.body.audit.map((e: { actorName: string }) => e.actorName),
    );
    expect(actors.has("xena")).toBe(true);
    expect(actors.has("yuki")).toBe(true); // admin sees others

    const memberAudit = await member.get("/api/audit").expect(200);
    const memberActors = new Set(
      memberAudit.body.audit.map((e: { actorName: string }) => e.actorName),
    );
    expect(memberActors.has("xena")).toBe(false); // member sees only own
    expect([...memberActors].every((a) => a === "yuki")).toBe(true);
  });

  it("round-trips capability hashtags through PATCH /api/me and into discovery", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "tagowner");
    const patched = await agent
      .patch("/api/me")
      .send({ hashtags: ["#코드리뷰", "코드리뷰", " 파이썬 ", "데이터 분석"] })
      .expect(200);
    // Normalized server-side: deduped, "#"/whitespace handled, spaces → hyphens.
    expect(patched.body.user.hashtags).toEqual([
      "코드리뷰",
      "파이썬",
      "데이터-분석",
    ]);

    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.hashtags).toEqual([
      "코드리뷰",
      "파이썬",
      "데이터-분석",
    ]);

    const list = await agent.get("/api/avatars").expect(200);
    const mine = list.body.avatars.find(
      (a: { username: string }) => a.username === "tagowner",
    );
    expect(mine.hashtags).toEqual(["코드리뷰", "파이썬", "데이터-분석"]);
  });

  it("auto-generates hashtags (local runtime placeholder) without persisting", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "taggen");
    const res = await agent.post("/api/me/hashtags/generate").expect(200);
    expect(Array.isArray(res.body.hashtags)).toBe(true);
    expect(res.body.hashtags.length).toBeGreaterThan(0);
    // Generation does NOT persist — the profile stays empty until the user saves.
    const me = await agent.get("/api/me").expect(200);
    expect(me.body.user.hashtags).toEqual([]);
  });

  it("adds MORE hashtags excluding the ones already present", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "taggenmore");
    const res = await agent
      .post("/api/me/hashtags/generate")
      .send({ existing: ["업무지원", "질문답변"] })
      .expect(200);
    expect(Array.isArray(res.body.hashtags)).toBe(true);
    expect(res.body.hashtags.length).toBeGreaterThan(0);
    // None of the returned tags may duplicate an existing one (case-insensitive).
    const existingKeys = new Set(["업무지원", "질문답변"]);
    for (const tag of res.body.hashtags)
      expect(existingKeys.has(tag)).toBe(false);
  });

  it("marks onboarding once: a fresh signup is un-onboarded, then stays onboarded", async () => {
    const app = testApp();
    const { agent } = await newUser(app, "onbo");
    // A brand-new account created after boot has never been onboarded.
    const before = await agent.get("/api/me").expect(200);
    expect(before.body.user.onboardedAt).toBeNull();
    // Dismissing the welcome modal persists a timestamp server-side.
    const marked = await agent.post("/api/me/onboarded").expect(200);
    expect(marked.body.user.onboardedAt).not.toBeNull();
    const stamp = marked.body.user.onboardedAt;
    // Idempotent: re-posting keeps the ORIGINAL timestamp (no re-stamp).
    const again = await agent.post("/api/me/onboarded").expect(200);
    expect(again.body.user.onboardedAt).toBe(stamp);
    // A later fetch (≈ a returning login) still reports onboarded → no modal.
    const after = await agent.get("/api/me").expect(200);
    expect(after.body.user.onboardedAt).toBe(stamp);
  });
});

describe("groups", () => {
  it("admin creates a group + adds members; co-members auto-trust; non-admin is blocked", async () => {
    const app = testApp();
    const { agent: adminA } = await newUser(app, "admin"); // first signup → admin
    const { agent: agentB, user: bob } = await newUser(app, "bob");
    const { agent: agentC } = await newUser(app, "carol");

    // A non-admin cannot create a group.
    await agentB.post("/api/admin/groups").send({ name: "X" }).expect(403);

    const created = await adminA
      .post("/api/admin/groups")
      .send({ name: "Team", description: "d" })
      .expect(200);
    const groupId = created.body.group.id;
    await adminA
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "bob", role: "admin" })
      .expect(200);
    await adminA
      .post(`/api/admin/groups/${groupId}/members`)
      .send({ username: "carol" })
      .expect(200);

    const list = await adminA.get("/api/admin/groups").expect(200);
    expect(list.body.groups[0].memberCount).toBe(2);
    expect(list.body.groups[0].adminCount).toBe(1);

    // bob sets group visibility; carol (same group) still reaches his avatar at elevated level.
    await agentB.patch("/api/me").send({ visibility: "group" }).expect(200);
    const seen = await agentC.get(`/api/avatars/${bob.id}`).expect(200);
    expect(seen.body.avatar.elevated).toBe(true);

    // A stranger outside the group gets 404 on the group-only avatar.
    const { agent: agentD } = await newUser(app, "dave");
    await agentD.get(`/api/avatars/${bob.id}`).expect(404);

    // Roster: carol sees all teammates and her own role.
    const mine = await agentC.get("/api/me/groups").expect(200);
    // Creating a group doesn't auto-add the system admin; only explicit members appear.
    expect(
      mine.body.groups[0].members
        .map((m: { username: string }) => m.username)
        .sort(),
    ).toEqual(["bob", "carol"]);
    expect(mine.body.groups[0].role).toBe("member");

    // bob (group admin) can self-serve member adds; carol (plain member) cannot.
    await agentB
      .post(`/api/me/groups/${groupId}/members`)
      .send({ username: "dave" })
      .expect(200);
    await agentC
      .post(`/api/me/groups/${groupId}/members`)
      .send({ username: "dave" })
      .expect(403);
  });
});
