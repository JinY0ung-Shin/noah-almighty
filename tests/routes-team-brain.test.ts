import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import type { Store } from "../src/server/store.js";
import { applyTeamNote, readTeamNote, teamBrainRoot, teamNoteBlob } from "../src/server/teamBrain.js";
import type { TeamBrainCardView } from "../src/shared/teamBrain.js";
import { signup, withTempDir } from "./helpers.js";

const dir = withTempDir("routes-team-brain");
let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.teamBrainBackup?.stop();
  services?.store.close();
  services = undefined;
});

const NOTE = "---\ntitle: 배포\n---\n\n배포는 compose up.\n";

async function boot() {
  services = createServices({ dataDir: dir(), agentRuntime: "local", sessionSecret: "test" });
  const app = createApp(services);
  const admin = request.agent(app);
  const mate = request.agent(app);
  const other = request.agent(app);
  const adminUser = (await signup(admin, "admin").expect(201)).body.user;
  const mateUser = (await signup(mate, "mate").expect(201)).body.user;
  const otherUser = (await signup(other, "other").expect(201)).body.user;
  return { ...services, app, admin, mate, other, adminUser, mateUser, otherUser };
}

function draft(store: Store, proposerUserId: string, extra: Partial<Parameters<Store["createTeamBrainProposal"]>[0]> = {}) {
  const r = store.createTeamBrainProposal({
    kind: "propose",
    proposerUserId,
    conversationId: null,
    path: "wiki/concepts/deploy.md",
    op: "create",
    title: "배포",
    summary: "배포 절차",
    content: NOTE,
    baseBlob: null,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
}

describe("team brain cards", () => {
  it("lets ONLY the drafter see and press their card; submit moves it to the review queue", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    await s.other.get(`/api/team-brain/cards/${p.id}`).expect(404);
    await s.other.post(`/api/team-brain/cards/${p.id}/submit`).expect(404);
    // An admin cannot press a teammate's card either (they decide through their OWN review card).
    await s.admin.post(`/api/team-brain/cards/${p.id}/submit`).expect(404);
    const view = (await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.actions).toEqual({ submit: true, withdraw: true, apply: false, cancel: false });
    // A teammate can never APPLY their own proposal.
    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(403);
    const submitted = (await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(200)).body as TeamBrainCardView;
    expect(submitted.proposal.status).toBe("pending");
    expect(submitted.actions).toEqual({ submit: false, withdraw: true, apply: false, cancel: false });
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(409);
    expect((await s.admin.get("/api/team-brain/status").expect(200)).body).toEqual({ unseenResults: 0, pendingReview: 1 });
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body).toEqual({ unseenResults: 0, pendingReview: 0 });
    await s.mate.get("/api/team-brain/proposals/pending").expect(403);
    const pending = (await s.admin.get("/api/team-brain/proposals/pending").expect(200)).body.proposals;
    expect(pending.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect(pending[0].content).toBeUndefined();
  });

  it("approves through the admin's review card: commits with the proposer as co-author and badges the result", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const review = draft(s.store, s.adminUser.id, { kind: "review", targetId: p.id, decision: "approve" });
    const view = (await s.admin.get(`/api/team-brain/cards/${review.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.actions.apply).toBe(true);
    expect(view.target?.id).toBe(p.id);
    const applied = (await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(200)).body as TeamBrainCardView;
    expect(applied.proposal.status).toBe("applied");
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "approved", decidedBy: s.adminUser.id });
    expect(await readTeamNote(s.config, "wiki/concepts/deploy.md")).toBe(NOTE);
    // Pressing again decides nothing twice.
    await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(409);
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body.unseenResults).toBe(1);
    // Viewing the decided card clears the badge.
    await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200);
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body.unseenResults).toBe(0);
    expect(s.store.listAudit(s.adminUser.id, true, 50).map((a) => a.action)).toContain("team_brain_approve");
  });

  it("rejects with the reason the proposer sees, and never writes the vault", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const review = draft(s.store, s.adminUser.id, { kind: "review", targetId: p.id, decision: "reject", decisionReason: "중복입니다", content: "" });
    await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(200);
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "rejected", decisionReason: "중복입니다" });
    expect(await readTeamNote(s.config, "wiki/concepts/deploy.md")).toBeNull();
    const mine = (await s.mate.get("/api/team-brain/proposals/mine").expect(200)).body.proposals;
    expect(mine[0]).toMatchObject({ status: "rejected", decisionReason: "중복입니다" });
  });

  it("refuses a stale card instead of overwriting, and releases the claim so it can be redone", async () => {
    const s = await boot();
    await applyTeamNote(s.config, {
      path: "wiki/concepts/deploy.md",
      op: "create",
      content: NOTE,
      expectedBlob: null,
      title: "배포",
      proposalId: "seed",
      author: { name: "A", email: "a@x" },
    });
    const base = await teamNoteBlob(teamBrainRoot(s.config), "wiki/concepts/deploy.md");
    const direct = draft(s.store, s.adminUser.id, { kind: "direct", op: "update", baseBlob: base, content: "v2" });
    // Someone else's change lands first.
    await applyTeamNote(s.config, {
      path: "wiki/concepts/deploy.md",
      op: "update",
      content: "other change",
      expectedBlob: base,
      title: "배포",
      proposalId: "other",
      author: { name: "A", email: "a@x" },
    });
    const view = (await s.admin.get(`/api/team-brain/cards/${direct.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.stale).toBe(true);
    expect(view.actions.apply).toBe(false);
    const res = await s.admin.post(`/api/team-brain/cards/${direct.id}/apply`).expect(409);
    expect(res.body.error).toContain("노트가 바뀌었습니다");
    expect(s.store.getTeamBrainProposal(direct.id)?.status).toBe("draft");
    expect(await readTeamNote(s.config, "wiki/concepts/deploy.md")).toBe("other change\n");
  });

  it("decides a proposal once even when two admin review cards race", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const approve = draft(s.store, s.adminUser.id, { kind: "review", targetId: p.id, decision: "approve" });
    const reject = draft(s.store, s.adminUser.id, { kind: "review", targetId: p.id, decision: "reject", decisionReason: "x", content: "" });
    const results = await Promise.all([
      s.admin.post(`/api/team-brain/cards/${approve.id}/apply`),
      s.admin.post(`/api/team-brain/cards/${reject.id}/apply`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const final = s.store.getTeamBrainProposal(p.id)!.status;
    expect(["approved", "rejected"]).toContain(final);
    const note = await readTeamNote(s.config, "wiki/concepts/deploy.md");
    expect(note === null).toBe(final === "rejected");
  });

  it("refuses an apply by an admin who was demoted after drafting", async () => {
    const s = await boot();
    const direct = draft(s.store, s.adminUser.id, { kind: "direct" });
    s.store.setRole(s.adminUser.id, "admin", false);
    expect(s.store.isActiveAdmin(s.adminUser.id)).toBe(false);
    await s.admin.post(`/api/team-brain/cards/${direct.id}/apply`).expect(403);
    expect(s.store.getTeamBrainProposal(direct.id)?.status).toBe("draft");
  });

  it("withdraws a pending proposal and cancels an admin card", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    expect((await s.mate.post(`/api/team-brain/cards/${p.id}/withdraw`).expect(200)).body.proposal.status).toBe("withdrawn");
    const direct = draft(s.store, s.adminUser.id, { kind: "direct" });
    expect((await s.admin.post(`/api/team-brain/cards/${direct.id}/withdraw`).expect(200)).body.proposal.status).toBe("cancelled");
    await s.admin.post(`/api/team-brain/cards/${direct.id}/apply`).expect(409);
  });

  it("serves the read-only graph and notes to any teammate", async () => {
    const s = await boot();
    expect((await s.mate.get("/api/team-brain/graph").expect(200)).body).toEqual({ graph: { nodes: [], edges: [] } });
    await applyTeamNote(s.config, {
      path: "wiki/concepts/deploy.md",
      op: "create",
      content: NOTE,
      expectedBlob: null,
      title: "배포",
      proposalId: "seed",
      author: { name: "A", email: "a@x" },
    });
    const graph = (await s.mate.get("/api/team-brain/graph").expect(200)).body.graph;
    expect(graph.nodes.map((n: { id: string }) => n.id)).toContain("wiki/concepts/deploy.md");
    const note = await s.mate.get("/api/team-brain/note").query({ path: "wiki/concepts/deploy.md" }).expect(200);
    expect(note.body.note.content).toBe(NOTE);
    await s.mate.get("/api/team-brain/note").query({ path: "../../etc/passwd" }).expect(400);
    await request(s.app).get("/api/team-brain/graph").expect(401);
  });
});

describe("team brain cards — rewind cascade", () => {
  it("withdraws a draft card whose message the rewind drops, and keeps a submitted one", async () => {
    const s = await boot();
    const ownerId = s.mateUser.id;
    s.store.touchConversation(ownerId, "c1", ownerId, "질문");
    const keepDraft = draft(s.store, ownerId, { conversationId: "c1" });
    const dropDraft = draft(s.store, ownerId, { conversationId: "c1", path: "wiki/a.md" });
    const dropSubmitted = draft(s.store, ownerId, { conversationId: "c1", path: "wiki/b.md" });
    s.store.transitionTeamBrainProposal(dropSubmitted.id, ["draft"], "pending");
    const card = (id: string) => ({ id, kind: "team_brain" as const, mediaType: "application/vnd.noah.team-brain+json" });
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const add = (role: "user" | "assistant", content: string, at: string, attachments?: ReturnType<typeof card>[]) => {
      const m = s.store.addMessage("c1", { role, content, ...(attachments ? { attachments } : {}) });
      db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, m.id);
      return m;
    };
    add("user", "첫 질문", "2026-11-06T00:00:01.000Z");
    add("assistant", "첫 답", "2026-11-06T00:00:02.000Z", [card(keepDraft.id)]);
    const u2 = add("user", "둘째 질문", "2026-11-06T00:00:03.000Z");
    add("assistant", "둘째 답", "2026-11-06T00:00:04.000Z", [card(dropDraft.id), card(dropSubmitted.id)]);
    const plan = s.store.planConversationRewind(ownerId, "c1", u2.id, "from")!;
    expect(s.store.applyConversationRewind(ownerId, "c1", plan)).toBe(true);
    expect(s.store.getTeamBrainProposal(keepDraft.id)?.status).toBe("draft");
    expect(s.store.getTeamBrainProposal(dropDraft.id)?.status).toBe("withdrawn");
    expect(s.store.getTeamBrainProposal(dropSubmitted.id)?.status).toBe("pending");
  });
});
