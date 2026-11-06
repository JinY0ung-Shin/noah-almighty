import crypto from "node:crypto";
import fs from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import type { Store } from "../src/server/store.js";
import { applyTeamChangeset, readTeamNote, readTeamVaultFile, teamBrainRoot, teamNoteBlob } from "../src/server/teamBrain.js";
import { teamRawPath, type TeamBrainCardView, type TeamBrainChangeset, type TeamBrainProposal } from "../src/shared/teamBrain.js";
import { sweepTeamBrainAppliesOnBoot } from "../src/server/teamBrainActions.js";
import { ADMIN_IDENTITY, SEED_RAW, gitOut, seedTeamVault, teamPage } from "./team-brain-fixtures.js";
import { signup, withTempDir } from "./helpers.js";

const dir = withTempDir("routes-team-brain");
let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.teamBrainBackup?.stop();
  services?.store.close();
  services = undefined;
});

const SOURCE = "배포는 compose up 으로 한다.\n";
const PAGE_PATH = "wiki/howto/deploy.md";
const INTAKE = { type: "howto" as const, answers: { source: "직접 확인", scope: "운영", validity: "모름", verified: "예" }, gaps: ["validity" as const], followups: [] };

/** A review/direct changeset creating the deploy page, citing `raw`. */
function changesetFor(raw: string, body = "compose up"): TeamBrainChangeset {
  return { changes: [{ path: PAGE_PATH, op: "create", content: teamPage({ title: "배포", sources: [raw], body }), baseBlob: null }], conflicts: [] };
}

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
    path: (id: string, createdAt: string) => teamRawPath(createdAt, id),
    op: "create",
    title: "배포",
    summary: "배포 절차",
    content: SOURCE,
    baseBlob: null,
    intake: INTAKE,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
}

/** The admin's review card on a pending proposal `p`. */
function reviewOf(store: Store, adminId: string, p: TeamBrainProposal, decision: "approve" | "reject" | "ask", extra: Partial<Parameters<Store["createTeamBrainProposal"]>[0]> = {}) {
  return draft(store, adminId, {
    kind: "review",
    path: p.path,
    content: "",
    intake: null,
    targetId: p.id,
    decision,
    changeset: decision === "approve" ? changesetFor(p.path) : null,
    ...extra,
  });
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
    const review = reviewOf(s.store, s.adminUser.id, p, "approve");
    const view = (await s.admin.get(`/api/team-brain/cards/${review.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.actions.apply).toBe(true);
    expect(view.target?.id).toBe(p.id);
    expect(view.pages).toEqual([
      { path: PAGE_PATH, op: "create", title: "배포", type: "howto", before: null, after: review.changeset!.changes[0].content, stale: false },
    ]);
    const applied = (await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(200)).body as TeamBrainCardView;
    expect(applied.proposal.status).toBe("applied");
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "approved", decidedBy: s.adminUser.id });
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("compose up");
    // The raw source is server-rendered at the proposal's own path, committed with the pages.
    const raw = (await readTeamVaultFile(s.config, p.path))!;
    expect(raw).toContain(`id: ${p.id}`);
    expect(raw).toContain("submitted_by: mate (mate)");
    expect(raw).toContain("approved_by: admin (admin)");
    expect(raw).toContain(`## Source\n\n${SOURCE}`);
    expect(raw).toContain("- gaps: validity");
    const root = teamBrainRoot(s.config);
    expect(gitOut(root, ["log", "-1", "--format=%B"])).toContain(`Proposal: ${p.id}`);
    expect(await readTeamVaultFile(s.config, "wiki/log.md")).toContain("ingest | 배포 | by mate · approved by admin");
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
    const review = reviewOf(s.store, s.adminUser.id, p, "reject", { decisionReason: "중복입니다" });
    await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(200);
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "rejected", decisionReason: "중복입니다" });
    expect(await readTeamNote(s.config, PAGE_PATH)).toBeNull();
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
    const mine = (await s.mate.get("/api/team-brain/proposals/mine").expect(200)).body.proposals;
    expect(mine[0]).toMatchObject({ status: "rejected", decisionReason: "중복입니다" });
  });

  it("refuses a stale card instead of overwriting, and releases the claim so it can be redone", async () => {
    const s = await boot();
    await seedTeamVault(s.config, [{ path: PAGE_PATH, content: teamPage({ title: "배포" }) }]);
    const base = await teamNoteBlob(teamBrainRoot(s.config), PAGE_PATH);
    const direct = draft(s.store, s.adminUser.id, {
      kind: "direct",
      path: "",
      content: "",
      intake: null,
      changeset: { changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body: "v2" }), baseBlob: base }], conflicts: [] },
    });
    const fresh = (await s.admin.get(`/api/team-brain/cards/${direct.id}`).expect(200)).body as TeamBrainCardView;
    expect(fresh.pages[0]).toMatchObject({ op: "update", stale: false, before: expect.stringContaining("배포 body.") });
    // Someone else's change lands first.
    await applyTeamChangeset(s.config, {
      raw: null,
      changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body: "other change" }), baseBlob: base }],
      title: "배포",
      proposalId: "other",
      logOp: "maintain",
      author: ADMIN_IDENTITY,
    });
    const view = (await s.admin.get(`/api/team-brain/cards/${direct.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.stale).toBe(true);
    expect(view.pages[0].stale).toBe(true);
    expect(view.actions.apply).toBe(false);
    const res = await s.admin.post(`/api/team-brain/cards/${direct.id}/apply`).expect(409);
    expect(res.body.error).toContain("그 사이 팀 브레인이 바뀌었습니다");
    expect(s.store.getTeamBrainProposal(direct.id)?.status).toBe("draft");
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("other change");
  });

  it("refuses a changeset the schema rejects NOW with a Korean count, and releases the claim", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    // The page cites the seed source but not the proposal's own raw path.
    const review = reviewOf(s.store, s.adminUser.id, p, "approve", { changeset: changesetFor(SEED_RAW) });
    const res = await s.admin.post(`/api/team-brain/cards/${review.id}/apply`).expect(409);
    expect(res.body.error).toMatch(/팀 브레인 규칙에 맞지 않습니다 \(문제 \d+건\)/);
    expect(res.body.error).not.toContain("sources");
    expect(s.store.getTeamBrainProposal(review.id)?.status).toBe("draft");
    expect(s.store.getTeamBrainProposal(p.id)?.status).toBe("pending");
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
  });

  it("direct with a source commits the admin's own raw; a maintenance direct commits pages only", async () => {
    const s = await boot();
    // A caller-minted id lets the changeset cite the row's own raw path up front.
    const id = crypto.randomUUID();
    const rawPath = teamRawPath(new Date().toISOString(), id);
    const fixed = draft(s.store, s.adminUser.id, { id, kind: "direct", path: rawPath, changeset: changesetFor(rawPath) });
    await s.admin.post(`/api/team-brain/cards/${fixed.id}/apply`).expect(200);
    const raw = (await readTeamVaultFile(s.config, fixed.path))!;
    expect(raw).toContain("submitted_by: admin (admin)");
    expect(await readTeamVaultFile(s.config, "wiki/log.md")).toContain("direct | 배포 | approved by admin");
    expect(s.store.listAudit(s.adminUser.id, true, 50).map((a) => a.action)).toContain("team_brain_direct");
    // A direct card without a changeset is never applied.
    const empty = draft(s.store, s.adminUser.id, { kind: "direct", changeset: null });
    await s.admin.post(`/api/team-brain/cards/${empty.id}/apply`).expect(409);
    expect(s.store.getTeamBrainProposal(empty.id)?.status).toBe("draft");
    const blob = await teamNoteBlob(teamBrainRoot(s.config), PAGE_PATH);
    const maintain = draft(s.store, s.adminUser.id, {
      kind: "direct",
      path: "",
      content: "",
      intake: null,
      changeset: { changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", sources: [fixed.path], body: "fixed typo" }), baseBlob: blob }], conflicts: [] },
    });
    await s.admin.post(`/api/team-brain/cards/${maintain.id}/apply`).expect(200);
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("fixed typo");
    expect(await readTeamVaultFile(s.config, "wiki/log.md")).toContain("maintain | 배포");
  });

  it("보완 요청: ask moves the target to needs_info with the questions, the proposer answers and resubmits", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(200);
    const ask = reviewOf(s.store, s.adminUser.id, p, "ask", { decisionReason: "어느 서버인가요?" });
    await s.admin.post(`/api/team-brain/cards/${ask.id}/apply`).expect(200);
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "needs_info", decisionReason: "어느 서버인가요?" });
    expect(s.store.listAudit(s.adminUser.id, true, 50).map((a) => a.action)).toContain("team_brain_ask");
    expect(fs.existsSync(teamBrainRoot(s.config))).toBe(false); // an ask never touches the vault
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body.unseenResults).toBe(1);
    const card = (await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200)).body as TeamBrainCardView;
    expect(card.actions).toEqual({ submit: false, withdraw: true, apply: false, cancel: false });
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body.unseenResults).toBe(0);
    const mine = (await s.mate.get("/api/team-brain/proposals/mine").expect(200)).body.proposals;
    expect(mine[0]).toMatchObject({ status: "needs_info", decisionReason: "어느 서버인가요?" });
    // The avatar records the answer (answer_team_questions) → draft again → 관리자에게 제출.
    const followup = { questions: "어느 서버인가요?", answer: "prod-1", askedAt: "a", answeredAt: "b" };
    expect(s.store.answerTeamBrainQuestions(p.id, s.mateUser.id, { ...INTAKE, followups: [followup] }, null)).toBe(true);
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(200);
    const approve = reviewOf(s.store, s.adminUser.id, s.store.getTeamBrainProposal(p.id)!, "approve");
    await s.admin.post(`/api/team-brain/cards/${approve.id}/apply`).expect(200);
    expect(await readTeamVaultFile(s.config, p.path)).toContain("## Follow-up 1 (a)\n### Questions\n어느 서버인가요?\n### Answer (b)\nprod-1");
  });

  it("decides a proposal once even when two admin review cards race", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const approve = reviewOf(s.store, s.adminUser.id, p, "approve");
    const reject = reviewOf(s.store, s.adminUser.id, p, "reject", { decisionReason: "x" });
    const results = await Promise.all([
      s.admin.post(`/api/team-brain/cards/${approve.id}/apply`),
      s.admin.post(`/api/team-brain/cards/${reject.id}/apply`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const final = s.store.getTeamBrainProposal(p.id)!.status;
    expect(["approved", "rejected"]).toContain(final);
    const note = await readTeamNote(s.config, PAGE_PATH);
    expect(note === null).toBe(final === "rejected");
  });

  it("refuses an apply by an admin who was demoted after drafting", async () => {
    const s = await boot();
    const direct = draft(s.store, s.adminUser.id, { kind: "direct", changeset: changesetFor("") });
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

  it("serves the read-only graph, pages, raw sources and SCHEMA.md to any teammate", async () => {
    const s = await boot();
    expect((await s.mate.get("/api/team-brain/graph").expect(200)).body).toEqual({ graph: { nodes: [], edges: [] } });
    await seedTeamVault(s.config, [{ path: PAGE_PATH, content: teamPage({ title: "배포" }) }]);
    const graph = (await s.mate.get("/api/team-brain/graph").expect(200)).body.graph;
    expect(graph.nodes.map((n: { id: string }) => n.id)).toContain(PAGE_PATH);
    const note = await s.mate.get("/api/team-brain/note").query({ path: PAGE_PATH }).expect(200);
    expect(note.body.note.content).toContain("title: 배포");
    expect((await s.mate.get("/api/team-brain/note").query({ path: SEED_RAW }).expect(200)).body.note.content).toContain("Seed source");
    expect((await s.mate.get("/api/team-brain/note").query({ path: "SCHEMA.md" }).expect(200)).body.note.content).toContain("noah-team-brain-schema");
    await s.mate.get("/api/team-brain/note").query({ path: "wiki/index.md" }).expect(200);
    await s.mate.get("/api/team-brain/note").query({ path: "../../etc/passwd" }).expect(400);
    await s.mate.get("/api/team-brain/note").query({ path: ".git/config" }).expect(400);
    await s.mate.get("/api/team-brain/note").query({ path: "raw/none.md" }).expect(404);
    await request(s.app).get("/api/team-brain/graph").expect(401);
  });
});

describe("team brain cards — review fixes", () => {
  it("#3 applying any review card voids the other drafted decisions on that target; a withdraw voids them all", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const staleApprove = reviewOf(s.store, s.adminUser.id, p, "approve");
    const ask = reviewOf(s.store, s.adminUser.id, p, "ask", { decisionReason: "어느 서버?" });
    await s.admin.post(`/api/team-brain/cards/${ask.id}/apply`).expect(200);
    expect(s.store.getTeamBrainProposal(staleApprove.id)?.status).toBe("cancelled");
    // The proposer answers and resubmits; the approve compiled BEFORE the answer can never commit.
    s.store.answerTeamBrainQuestions(p.id, s.mateUser.id, { ...INTAKE, followups: [{ questions: "q", answer: "a", askedAt: "x", answeredAt: "y" }] }, null);
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(200);
    await s.admin.post(`/api/team-brain/cards/${staleApprove.id}/apply`).expect(409);
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
    const pending = reviewOf(s.store, s.adminUser.id, p, "reject", { decisionReason: "x" });
    await s.mate.post(`/api/team-brain/cards/${p.id}/withdraw`).expect(200);
    expect(s.store.getTeamBrainProposal(pending.id)?.status).toBe("cancelled");
  });

  it("#7 an approve turns the target approved only after the commit; a failed one leaves no decision stamps and restores voided drafts", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    // Invalid now (cites the seed source, not the proposal's raw) → 409 after the claim.
    const bad = reviewOf(s.store, s.adminUser.id, p, "approve", { changeset: changesetFor(SEED_RAW) });
    const sibling = reviewOf(s.store, s.adminUser.id, p, "reject", { decisionReason: "x" });
    await s.admin.post(`/api/team-brain/cards/${bad.id}/apply`).expect(409);
    expect(s.store.getTeamBrainProposal(bad.id)).toMatchObject({ status: "draft", decidedBy: null, decidedAt: null });
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "pending", decidedBy: null, decidedAt: null });
    expect(s.store.getTeamBrainProposal(sibling.id)?.status).toBe("draft");
    expect((await s.mate.get("/api/team-brain/status").expect(200)).body.unseenResults).toBe(0);
  });

  it("#7 while an approve is in flight, the withdraw and every other press on that target are refused", async () => {
    const s = await boot();
    const p = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(p.id, ["draft"], "pending");
    const approve = reviewOf(s.store, s.adminUser.id, p, "approve");
    s.store.transitionTeamBrainProposal(approve.id, ["draft"], "applied", { decidedBy: s.adminUser.id, decided: true }); // the claim, commit pending
    const reject = reviewOf(s.store, s.adminUser.id, p, "reject", { decisionReason: "x" });
    const res = await s.mate.post(`/api/team-brain/cards/${p.id}/withdraw`).expect(409);
    expect(res.body.error).toContain("반영하고 있습니다");
    await s.admin.post(`/api/team-brain/cards/${reject.id}/apply`).expect(409);
    expect(s.store.getTeamBrainProposal(p.id)?.status).toBe("pending");
  });

  it("#2 boot sweep: an applied card with no commit goes back to draft; a landed one gets its target approved; new claims are untouched", async () => {
    const s = await boot();
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const past = new Date(Date.now() - 60_000).toISOString();
    // A died mid-apply (old build: target already approved).
    const a = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(a.id, ["draft"], "approved", { decidedBy: s.adminUser.id, decided: true });
    const ra = reviewOf(s.store, s.adminUser.id, { ...a, status: "pending" }, "approve");
    s.store.transitionTeamBrainProposal(ra.id, ["draft"], "applied", { decidedBy: s.adminUser.id, decided: true });
    // B committed, then the process died before the target moved.
    const b = draft(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(b.id, ["draft"], "pending");
    const rb = reviewOf(s.store, s.adminUser.id, b, "approve");
    await s.admin.post(`/api/team-brain/cards/${rb.id}/apply`).expect(200);
    s.store.transitionTeamBrainProposal(b.id, ["approved"], "pending", { clearDecision: true });
    // C: a direct claimed after boot (this process's own, maybe in flight).
    const c = draft(s.store, s.adminUser.id, { kind: "direct", changeset: changesetFor("") });
    db.prepare("UPDATE team_brain_proposals SET decided_at = ? WHERE id IN (?, ?)").run(past, ra.id, rb.id);
    const startedAt = new Date().toISOString();
    s.store.transitionTeamBrainProposal(c.id, ["draft"], "applied", { decidedBy: s.adminUser.id, decided: true });
    db.prepare("UPDATE team_brain_proposals SET decided_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), c.id);

    expect(await sweepTeamBrainAppliesOnBoot(s, startedAt)).toBe(2);
    expect(s.store.getTeamBrainProposal(ra.id)).toMatchObject({ status: "draft", decidedAt: null });
    expect(s.store.getTeamBrainProposal(a.id)).toMatchObject({ status: "pending", decidedBy: null });
    expect(s.store.getTeamBrainProposal(b.id)?.status).toBe("approved");
    expect(s.store.getTeamBrainProposal(rb.id)?.status).toBe("applied");
    expect(s.store.getTeamBrainProposal(c.id)?.status).toBe("applied");
  });
});

describe("team brain cards — rewind cascade", () => {
  it("withdraws a draft card whose message the rewind drops, and keeps a submitted one", async () => {
    const s = await boot();
    const ownerId = s.mateUser.id;
    s.store.touchConversation(ownerId, "c1", ownerId, "질문");
    const keepDraft = draft(s.store, ownerId, { conversationId: "c1" });
    const dropDraft = draft(s.store, ownerId, { conversationId: "c1" });
    const dropSubmitted = draft(s.store, ownerId, { conversationId: "c1" });
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
