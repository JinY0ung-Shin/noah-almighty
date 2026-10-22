import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { ServerAgentError } from "../src/server/serverAgents/errors.js";
import { resetServerAgentSlotsForTests, tryAcquireServerAgentSlot } from "../src/server/serverAgents/limits.js";
import type { ServerCleanupResult } from "../src/server/serverAgents/installer.js";
import { MAX_SERVER_AGENTS, SERVER_AGENT_ERROR_KO, type ServerAgentInstallState } from "../src/shared/serverAgents.js";
import { signup, withTempDir } from "./helpers.js";

// Coverage target: src/server/routes/serverAgents.ts. The transport (installer)
// and host-trust (sshTrust) halves are mocked — this file pins the REST
// contract: session auth, owner scoping, validation messages, 409s, the
// best-effort remote cleanup, and the audit rows (never secrets or notes).

const H = vi.hoisted(() => ({
  isHostTrusted: vi.fn(async () => false),
  inspectHostKey: vi.fn(),
  trustHostWithFingerprint: vi.fn(),
  checkServerAgent: vi.fn(),
  cleanupServerRemote: vi.fn(async (..._args: unknown[]): Promise<ServerCleanupResult> => ({ status: "done" })),
}));

vi.mock("../src/server/sshTrust.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/sshTrust.js")>()),
  isHostTrusted: H.isHostTrusted,
  inspectHostKey: H.inspectHostKey,
  trustHostWithFingerprint: H.trustHostWithFingerprint,
}));
vi.mock("../src/server/serverAgents/installer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/serverAgents/installer.js")>()),
  localCliInfo: () => ({ version: "0.3.283", path: "/x/claude", sha256: "abc" }),
  checkServerAgent: H.checkServerAgent,
  cleanupServerRemote: H.cleanupServerRemote,
}));

let tempDir: string;
const getTempDir = withTempDir("app-server-agents", () => {
  tempDir = getTempDir();
});

beforeEach(() => {
  H.isHostTrusted.mockReset().mockResolvedValue(false);
  H.inspectHostKey.mockReset();
  H.trustHostWithFingerprint.mockReset();
  H.checkServerAgent.mockReset();
  H.cleanupServerRemote.mockReset().mockResolvedValue({ status: "done" });
  resetServerAgentSlotsForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetServerAgentSlotsForTests();
});

const FP = `SHA256:${"A".repeat(43)}`;
const BODY = {
  name: "web-01",
  host: "Web-01.corp.example",
  port: 22,
  username: "noah-agent",
  workdir: "/srv/app/",
  role: "주문 API",
  notes: "SECRET-LOOKING NOTE",
  access: "exec",
};

function boot(opts: { adminEnabled?: boolean } = {}) {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  // The deployment switch is OFF by default; most of this file exercises an enabled deployment.
  if (opts.adminEnabled !== false) services.store.setServerAgentsEnabled(true);
  return { app: createApp(services), store: services.store };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

function auditOf(store: ReturnType<typeof boot>["store"], userId: string, action: string) {
  return store.listAudit(userId, false).filter((row) => row.action === action);
}

describe("server agents REST — auth and listing", () => {
  it("requires a session on every route", async () => {
    const { app } = boot();
    await request(app).get("/api/me/server-agents").expect(401);
    await request(app).post("/api/me/server-agents").send(BODY).expect(401);
    await request(app).patch("/api/me/server-agents/x").send({ role: "r" }).expect(401);
    await request(app).delete("/api/me/server-agents/x").expect(401);
    await request(app).post("/api/me/server-agents/x/host-key").expect(401);
    await request(app).post("/api/me/server-agents/x/trust-host").send({ fingerprint: FP }).expect(401);
    await request(app).post("/api/me/server-agents/x/check").expect(401);
  });

  it("lists the owner's servers with host trust, SSH-key presence, egress and the build's CLI version", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const empty = await agent.get("/api/me/server-agents").expect(200);
    expect(empty.body).toEqual({ servers: [], sshKeySet: false, egressBlocked: false, cliVersion: "0.3.283", adminEnabled: true });

    await agent.post("/api/me/server-agents").send(BODY).expect(201);
    store.setUserSecret(id, "SSH_PRIVATE_KEY", "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----");
    H.isHostTrusted.mockResolvedValue(true);
    vi.stubEnv("NOAH_EGRESS_POLICY", "domain-proxy");
    const listed = await agent.get("/api/me/server-agents").expect(200);
    expect(listed.body.sshKeySet).toBe(true);
    expect(listed.body.egressBlocked).toBe(true);
    expect(listed.body.servers).toHaveLength(1);
    expect(listed.body.servers[0]).toMatchObject({ name: "web-01", host: "web-01.corp.example", workdir: "/srv/app", hostTrusted: true });
    expect(H.isHostTrusted).toHaveBeenCalledWith(id, expect.anything(), "web-01.corp.example", 22);
  });

  it("scopes every route to the owner — another user's id is a 404", async () => {
    const { app } = boot();
    const owner = await newUser(app, "owner");
    const other = await newUser(app, "other");
    const created = await owner.agent.post("/api/me/server-agents").send(BODY).expect(201);
    const id = created.body.id as string;
    expect((await other.agent.get("/api/me/server-agents").expect(200)).body.servers).toEqual([]);
    await other.agent.patch(`/api/me/server-agents/${id}`).send({ role: "x" }).expect(404);
    await other.agent.delete(`/api/me/server-agents/${id}`).expect(404);
    await other.agent.post(`/api/me/server-agents/${id}/host-key`).expect(404);
    await other.agent.post(`/api/me/server-agents/${id}/trust-host`).send({ fingerprint: FP }).expect(404);
    await other.agent.post(`/api/me/server-agents/${id}/check`).expect(404);
    expect(H.inspectHostKey).not.toHaveBeenCalled();
    expect(H.checkServerAgent).not.toHaveBeenCalled();
  });
});

describe("server agents REST — create / update / delete", () => {
  it("creates with normalized fields (201) and audits identity without notes", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const res = await agent.post("/api/me/server-agents").send(BODY).expect(201);
    expect(res.body).toMatchObject({
      name: "web-01",
      host: "web-01.corp.example",
      port: 22,
      workdir: "/srv/app",
      access: "exec",
      enabled: true,
      installState: null,
      hostTrusted: false,
    });
    const audit = auditOf(store, id, "server_agent_create");
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toBe("web-01 noah-agent@web-01.corp.example:22 exec");
    expect(audit[0].detail).not.toContain("SECRET-LOOKING");
  });

  it("rejects invalid or missing fields with a Korean message naming the field", async () => {
    const { app } = boot();
    const { agent } = await newUser(app, "owner");
    const missing = await agent.post("/api/me/server-agents").send({ ...BODY, username: "" }).expect(400);
    expect(missing.body.error).toBe("계정을 입력해 주세요.");
    const badPort = await agent.post("/api/me/server-agents").send({ ...BODY, port: 70000 }).expect(400);
    expect(badPort.body.error).toContain("포트 형식이 올바르지 않습니다");
    const badHost = await agent.post("/api/me/server-agents").send({ ...BODY, host: "-oProxyCommand=x" }).expect(400);
    expect(badHost.body.error).toContain("호스트");
    const relative = await agent.post("/api/me/server-agents").send({ ...BODY, workdir: "srv/app" }).expect(400);
    expect(relative.body.error).toContain("작업 디렉터리");
    const badTier = await agent.post("/api/me/server-agents").send({ ...BODY, access: "root" }).expect(400);
    expect(badTier.body.error).toContain("권한 등급");
  });

  it("409s a duplicate name and the per-owner cap", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    await agent.post("/api/me/server-agents").send(BODY).expect(201);
    const dup = await agent.post("/api/me/server-agents").send(BODY).expect(409);
    expect(dup.body.error).toBe("같은 이름의 서버가 이미 있습니다.");
    for (let i = 1; i < MAX_SERVER_AGENTS; i += 1) {
      store.createServerAgent(id, { ...BODY, name: `s-${i}`, host: "h", workdir: "/w", access: "read", enabled: true });
    }
    const capped = await agent.post("/api/me/server-agents").send({ ...BODY, name: "one-more" }).expect(409);
    expect(capped.body.error).toContain(`최대 ${MAX_SERVER_AGENTS}개`);
  });

  it("patches partially, 400s an empty patch, 409s a rename onto another server, audits the update", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    await agent.post("/api/me/server-agents").send({ ...BODY, name: "db-01" }).expect(201);
    const patched = await agent.patch(`/api/me/server-agents/${web.id}`).send({ access: "full", enabled: false }).expect(200);
    expect(patched.body).toMatchObject({ id: web.id, access: "full", enabled: false, role: "주문 API", hostTrusted: false });
    await agent.patch(`/api/me/server-agents/${web.id}`).send({}).expect(400);
    const bad = await agent.patch(`/api/me/server-agents/${web.id}`).send({ port: "abc" }).expect(400);
    expect(bad.body.error).toContain("포트");
    const dup = await agent.patch(`/api/me/server-agents/${web.id}`).send({ name: "db-01" }).expect(409);
    expect(dup.body.error).toBe("같은 이름의 서버가 이미 있습니다.");
    expect(auditOf(store, id, "server_agent_update").map((row) => row.detail)).toEqual(["web-01 noah-agent@web-01.corp.example:22 full"]);
  });

  it("deletes without touching the server by default; cleanupRemote=1 cleans first and a cleanup failure never blocks the delete", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const a = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    const b = (await agent.post("/api/me/server-agents").send({ ...BODY, name: "db-01" }).expect(201)).body;
    const c = (await agent.post("/api/me/server-agents").send({ ...BODY, name: "batch-01" }).expect(201)).body;

    expect((await agent.delete(`/api/me/server-agents/${a.id}`).expect(200)).body).toEqual({ ok: true, cleanup: "skipped" });
    expect(H.cleanupServerRemote).not.toHaveBeenCalled();

    expect((await agent.delete(`/api/me/server-agents/${b.id}?cleanupRemote=1`).expect(200)).body).toEqual({ ok: true, cleanup: "done" });
    expect(H.cleanupServerRemote).toHaveBeenCalledWith(expect.anything(), id, expect.objectContaining({ id: b.id, name: "db-01" }));

    H.cleanupServerRemote.mockRejectedValueOnce(new ServerAgentError("UNREACHABLE", "connect ECONNREFUSED"));
    const failed = await agent.delete(`/api/me/server-agents/${c.id}?cleanupRemote=1`).expect(200);
    expect(failed.body).toEqual({ ok: true, cleanup: "failed", cleanupError: SERVER_AGENT_ERROR_KO.UNREACHABLE });
    expect(store.listServerAgents(id)).toEqual([]);
    expect(auditOf(store, id, "server_agent_delete").map((row) => row.detail).sort()).toEqual([
      "batch-01 noah-agent@web-01.corp.example:22 exec cleanup=failed",
      "db-01 noah-agent@web-01.corp.example:22 exec cleanup=done",
      "web-01 noah-agent@web-01.corp.example:22 exec cleanup=skipped",
    ]);
    await agent.delete(`/api/me/server-agents/${a.id}`).expect(404);
  });

  it("refuses to delete a server with a live delegation", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    const slot = tryAcquireServerAgentSlot("run-1", id, web.id);
    expect(slot.ok).toBe(true);
    const res = await agent.delete(`/api/me/server-agents/${web.id}?cleanupRemote=1`).expect(409);
    expect(res.body.error).toContain("실행 중인 위임 작업");
    expect(H.cleanupServerRemote).not.toHaveBeenCalled();
    expect(store.getServerAgent(id, web.id)).not.toBeNull();
    if (slot.ok) slot.release();
    await agent.delete(`/api/me/server-agents/${web.id}`).expect(200);
  });

  it("reports a deliberately skipped remote cleanup with a Korean reason, and still deletes the row", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    const db = (await agent.post("/api/me/server-agents").send({ ...BODY, name: "db-01" }).expect(201)).body;
    H.cleanupServerRemote.mockResolvedValueOnce({ status: "skipped", reason: "shared_account" });
    const shared = (await agent.delete(`/api/me/server-agents/${web.id}?cleanupRemote=1`).expect(200)).body;
    expect(shared).toEqual({ ok: true, cleanup: "skipped", cleanupReason: expect.stringContaining("같은 서버 계정") });
    H.cleanupServerRemote.mockResolvedValueOnce({ status: "skipped", reason: "active_runs" });
    const active = (await agent.delete(`/api/me/server-agents/${db.id}?cleanupRemote=1`).expect(200)).body;
    expect(active.cleanupReason).toContain("아직 실행 중인 에이전트 작업");
    expect(store.listServerAgents(id)).toEqual([]);
  });

  it("no delegation can start on the row while its delete (and remote cleanup) is in flight", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    let finishCleanup!: (result: ServerCleanupResult) => void;
    H.cleanupServerRemote.mockImplementationOnce(() => new Promise((resolve) => { finishCleanup = resolve; }));
    const pending = agent.delete(`/api/me/server-agents/${web.id}?cleanupRemote=1`).then((res) => res);
    await vi.waitFor(() => expect(H.cleanupServerRemote).toHaveBeenCalledTimes(1));
    expect(tryAcquireServerAgentSlot("late-run", id, web.id)).toEqual({ ok: false, reason: "deleting" });
    // A second delete of the same row is refused rather than racing the first.
    expect((await agent.delete(`/api/me/server-agents/${web.id}`).expect(409)).body.error).toContain("이미 삭제");
    finishCleanup({ status: "done" });
    expect((await pending).body).toEqual({ ok: true, cleanup: "done" });
    expect(store.getServerAgent(id, web.id)).toBeNull();
    // The mark is released afterwards.
    const after = tryAcquireServerAgentSlot("after", id, web.id);
    expect(after.ok).toBe(true);
  });
});

describe("server agents REST — admin switch", () => {
  it("is OFF by default: listing says so, check is refused (409), registration and trust still work", async () => {
    const { app, store } = boot({ adminEnabled: false });
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    expect((await agent.get("/api/me/server-agents").expect(200)).body.adminEnabled).toBe(false);
    const refused = await agent.post(`/api/me/server-agents/${web.id}/check`).expect(409);
    expect(refused.body.error).toBe("관리자가 서버 에이전트 기능을 켜지 않았습니다.");
    expect(H.checkServerAgent).not.toHaveBeenCalled();
    H.trustHostWithFingerprint.mockResolvedValueOnce({ entry: { fingerprint: FP, keyType: "ssh-ed25519" }, changed: false });
    await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({ fingerprint: FP }).expect(200);
    await agent.delete(`/api/me/server-agents/${web.id}`).expect(200);
    expect(store.listServerAgents(id)).toEqual([]);
  });

  it("PUT /api/admin/server-agents: admin only, enabling REQUIRES the acknowledgement, audited, reported by /api/admin/system", async () => {
    const { app, store } = boot({ adminEnabled: false });
    const admin = await newUser(app, "root");
    const member = await newUser(app, "member");
    await member.agent.put("/api/admin/server-agents").send({ enabled: true, acknowledged: true }).expect(403);
    const noAck = await admin.agent.put("/api/admin/server-agents").send({ enabled: true }).expect(400);
    expect(noAck.body.error).toContain("경고를 확인해야 합니다");
    await admin.agent.put("/api/admin/server-agents").send({ enabled: "yes" }).expect(400);
    expect(store.isServerAgentsEnabled()).toBe(false);
    expect((await admin.agent.get("/api/admin/system").expect(200)).body.system.serverAgentsEnabled).toBe(false);

    expect((await admin.agent.put("/api/admin/server-agents").send({ enabled: true, acknowledged: true }).expect(200)).body).toEqual({
      serverAgentsEnabled: true,
    });
    expect(store.isServerAgentsEnabled()).toBe(true);
    expect((await admin.agent.get("/api/admin/system").expect(200)).body.system.serverAgentsEnabled).toBe(true);
    expect((await member.agent.get("/api/me/server-agents").expect(200)).body.adminEnabled).toBe(true);
    // Turning it off needs no acknowledgement.
    await admin.agent.put("/api/admin/server-agents").send({ enabled: false }).expect(200);
    expect(store.isServerAgentsEnabled()).toBe(false);
    expect(auditOf(store, admin.id, "set_server_agents_enabled").map((row) => row.detail).sort()).toEqual([
      "server agents = off",
      "server agents = on",
    ]);
  });
});

describe("server agents REST — host key trust", () => {
  it("returns the live key without trusting it; a fetch failure is a 502 UNREACHABLE", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send({ ...BODY, port: 2222 }).expect(201)).body;
    H.inspectHostKey.mockResolvedValueOnce({ fingerprint: FP, keyType: "ssh-ed25519", trusted: false, mismatch: true });
    const seen = await agent.post(`/api/me/server-agents/${web.id}/host-key`).expect(200);
    expect(seen.body).toEqual({ fingerprint: FP, keyType: "ssh-ed25519", trusted: false, mismatch: true });
    expect(H.inspectHostKey).toHaveBeenCalledWith(id, expect.anything(), "web-01.corp.example", 2222);
    expect(H.trustHostWithFingerprint).not.toHaveBeenCalled();

    H.inspectHostKey.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    const down = await agent.post(`/api/me/server-agents/${web.id}/host-key`).expect(502);
    expect(down.body.error).toBe(SERVER_AGENT_ERROR_KO.UNREACHABLE);
    expect(auditOf(store, id, "server_agent_trust_host")).toEqual([]);
  });

  it("trusts only the shown fingerprint: 400 on a malformed one, 409 when the key changed, audit on success", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send({ ...BODY, port: 2222 }).expect(201)).body;
    await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({ fingerprint: "SHA256:short" }).expect(400);
    await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({}).expect(400);
    expect(H.trustHostWithFingerprint).not.toHaveBeenCalled();

    H.trustHostWithFingerprint.mockRejectedValueOnce(new ServerAgentError("HOST_KEY_MISMATCH", "fingerprint changed since it was shown"));
    const changed = await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({ fingerprint: FP }).expect(409);
    expect(changed.body.error).toContain(SERVER_AGENT_ERROR_KO.HOST_KEY_MISMATCH);

    H.trustHostWithFingerprint.mockResolvedValueOnce({
      entry: { host: "[web-01.corp.example]:2222", keyType: "ssh-ed25519", fingerprint: FP },
      changed: true,
    });
    H.isHostTrusted.mockResolvedValue(true);
    const ok = await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({ fingerprint: FP }).expect(200);
    expect(ok.body).toMatchObject({ fingerprint: FP, keyType: "ssh-ed25519", changed: true, server: { id: web.id, hostTrusted: true } });
    expect(H.trustHostWithFingerprint).toHaveBeenLastCalledWith(id, expect.anything(), "web-01.corp.example", 2222, FP);
    const audit = auditOf(store, id, "server_agent_trust_host");
    expect(audit.map((row) => [row.status, row.detail]).sort()).toEqual([
      ["error", `web-01 [web-01.corp.example]:2222 ${FP} mismatch`],
      ["success", `web-01 [web-01.corp.example]:2222 ${FP}`],
    ]);
  });

  it("refuses host-key work outright when egress blocks direct connections", async () => {
    const { app } = boot();
    const { agent } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    vi.stubEnv("NOAH_EGRESS_POLICY", "domain-proxy");
    const res = await agent.post(`/api/me/server-agents/${web.id}/host-key`).expect(409);
    expect(res.body.error).toBe(SERVER_AGENT_ERROR_KO.EGRESS_BLOCKED);
    await agent.post(`/api/me/server-agents/${web.id}/trust-host`).send({ fingerprint: FP }).expect(409);
    expect(H.inspectHostKey).not.toHaveBeenCalled();
  });
});

describe("server agents REST — check", () => {
  it("returns the install state and audits ok/code/version", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    const ok: ServerAgentInstallState = { ok: true, version: "0.3.283", error: null, detail: null, checkedAt: "2026-10-22T00:00:00.000Z" };
    H.checkServerAgent.mockResolvedValueOnce(ok);
    expect((await agent.post(`/api/me/server-agents/${web.id}/check`).expect(200)).body).toEqual(ok);
    expect(H.checkServerAgent).toHaveBeenCalledWith(expect.objectContaining({ store }), id, expect.objectContaining({ id: web.id }));

    const failed: ServerAgentInstallState = { ok: false, version: null, error: "AUTH_FAILED", detail: "All configured authentication methods failed", checkedAt: "2026-10-22T00:01:00.000Z" };
    H.checkServerAgent.mockResolvedValueOnce(failed);
    expect((await agent.post(`/api/me/server-agents/${web.id}/check`).expect(200)).body).toEqual(failed);
    expect(auditOf(store, id, "server_agent_check").map((row) => [row.status, row.detail]).sort()).toEqual([
      ["error", "web-01 ok=false code=AUTH_FAILED version=-"],
      ["success", "web-01 ok=true code=- version=0.3.283"],
    ]);
  });

  it("409s a concurrent check of the same server (and a delete during it)", async () => {
    const { app } = boot();
    const { agent } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    let finish!: (state: ServerAgentInstallState) => void;
    H.checkServerAgent.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = agent.post(`/api/me/server-agents/${web.id}/check`).then((res) => res);
    await vi.waitFor(() => expect(H.checkServerAgent).toHaveBeenCalledTimes(1));
    const second = await agent.post(`/api/me/server-agents/${web.id}/check`).expect(409);
    expect(second.body.error).toContain("이미 점검");
    await agent.delete(`/api/me/server-agents/${web.id}`).expect(409);
    finish({ ok: true, version: "0.3.283", error: null, detail: null, checkedAt: "2026-10-22T00:00:00.000Z" });
    expect((await first).status).toBe(200);
    // The lock is released afterwards.
    H.checkServerAgent.mockResolvedValueOnce({ ok: true, version: "0.3.283", error: null, detail: null, checkedAt: "2026-10-22T00:02:00.000Z" });
    await agent.post(`/api/me/server-agents/${web.id}/check`).expect(200);
  });

  it("an unexpected throw persists a generic UNKNOWN state instead of a raw message", async () => {
    const { app, store } = boot();
    const { agent, id } = await newUser(app, "owner");
    const web = (await agent.post("/api/me/server-agents").send(BODY).expect(201)).body;
    H.checkServerAgent.mockRejectedValueOnce(new Error("boom with token=abc"));
    const res = await agent.post(`/api/me/server-agents/${web.id}/check`).expect(200);
    expect(res.body).toMatchObject({ ok: false, error: "UNKNOWN" });
    expect(JSON.stringify(res.body)).not.toContain("token=abc");
    expect(store.getServerAgent(id, web.id)?.installState?.error).toBe("UNKNOWN");
  });
});
