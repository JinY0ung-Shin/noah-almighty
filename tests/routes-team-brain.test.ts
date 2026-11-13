import crypto from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import type { Store } from "../src/server/store.js";
import {
  applyTeamChangeset,
  ensureTeamBrainRepo,
  readTeamNote,
  readTeamVaultFile,
  teamBrainRoot,
  teamNoteBlob,
  teamPolicyState,
} from "../src/server/teamBrain.js";
import { parseTeamPolicy, renderTeamPolicy } from "../src/server/teamBrainPolicy.js";
import {
  TEAM_BRAIN_CLOSED_BY_UPGRADE,
  teamRawPath,
  type TeamBrainCardView,
  type TeamBrainChangeset,
} from "../src/shared/teamBrain.js";
import { pressTeamBrainCard, retireTeamBrainReviewQueueOnBoot, sweepTeamBrainAppliesOnBoot } from "../src/server/teamBrainActions.js";
import { ADMIN_IDENTITY, SEED_RAW, gitOut, insertLegacyTeamBrainRow, seedTeamVault, teamPage } from "./team-brain-fixtures.js";
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
const PROVENANCE = { source_kind: "verified", source: "직접 확인", author: "mate", authored_at: "2026-11-05" };
const INTAKE = {
  type: "howto" as const,
  answers: { ...PROVENANCE, scope: "운영", validity: "모름", verified: "예" },
  gaps: ["validity" as const],
};

/** A changeset creating the deploy page, citing `raw`. */
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

type NewCard = Parameters<Store["createTeamBrainProposal"]>[0];

function draft(store: Store, proposerUserId: string, extra: Partial<NewCard> = {}) {
  const r = store.createTeamBrainProposal({
    kind: "direct",
    proposerUserId,
    conversationId: null,
    path: "",
    op: "create",
    title: "배포",
    summary: "배포 절차",
    content: "",
    baseBlob: null,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  return r.proposal;
}

/** A direct card that brings its own source: the changeset cites the row's own raw path (a caller-minted id). */
function draftWithSource(store: Store, proposerUserId: string, extra: Partial<NewCard> = {}) {
  const id = crypto.randomUUID();
  const rawPath = teamRawPath(new Date().toISOString(), id);
  return draft(store, proposerUserId, { id, path: rawPath, content: SOURCE, intake: INTAKE, changeset: changesetFor(rawPath), ...extra });
}

/** A card without a source: an update of the seeded deploy page. */
async function draftUpdate(s: Awaited<ReturnType<typeof boot>>, proposerUserId: string, body = "v2") {
  const base = await teamNoteBlob(teamBrainRoot(s.config), PAGE_PATH);
  return draft(s.store, proposerUserId, {
    changeset: { changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body }), baseBlob: base }], conflicts: [] },
  });
}

describe("team brain cards", () => {
  it("every teammate applies their OWN card: only the drafter sees and presses it, and the press commits in their name", async () => {
    const s = await boot();
    const p = draftWithSource(s.store, s.mateUser.id);
    // Nobody else — not even an admin — sees or presses a teammate's card.
    for (const outsider of [s.other, s.admin]) {
      await outsider.get(`/api/team-brain/cards/${p.id}`).expect(404);
      await outsider.post(`/api/team-brain/cards/${p.id}/apply`).expect(404);
      await outsider.post(`/api/team-brain/cards/${p.id}/cancel`).expect(404);
    }
    const view = (await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.actions).toEqual({ apply: true, cancel: true });
    expect(view.legacy).toBeNull();
    expect(view.provenance).toEqual({ editable: true, issues: [] });
    expect(view.pages).toEqual([
      { path: PAGE_PATH, op: "create", title: "배포", type: "howto", before: null, after: p.changeset!.changes[0].content, stale: false },
    ]);

    const applied = (await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(200)).body as TeamBrainCardView;
    expect(applied.proposal).toMatchObject({ status: "applied", decidedBy: s.mateUser.id });
    expect(applied.actions).toEqual({ apply: false, cancel: false });
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("compose up");
    // The raw source is server-rendered at the card's own path, committed with the pages: both stamps are the presser.
    const raw = (await readTeamVaultFile(s.config, p.path))!;
    expect(raw).toContain(`id: ${p.id}`);
    expect(raw).toContain("submitted_by: mate (mate)");
    expect(raw).toContain("approved_by: mate (mate)");
    expect(raw).toContain("source_kind: verified\nsource: 직접 확인\nauthor: mate\nauthored_at: 2026-11-05\n---");
    expect(raw).toContain(`## Source\n\n${SOURCE}`);
    expect(raw).toContain("- gaps: validity");
    const root = teamBrainRoot(s.config);
    const commit = gitOut(root, ["log", "-1", "--format=%an|%B"]);
    expect(commit.startsWith("mate|")).toBe(true);
    expect(commit).toContain(`Proposal: ${p.id}`);
    expect(await readTeamVaultFile(s.config, "wiki/log.md")).toContain("direct | 배포 | approved by mate");
    expect(s.store.listAudit(s.mateUser.id, false, 50).map((a) => a.action)).toContain("team_brain_direct");
    // Pressing again applies nothing twice.
    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(409);
  });

  it("the review queue's routes are gone", async () => {
    const s = await boot();
    const p = draftWithSource(s.store, s.mateUser.id);
    for (const agent of [s.mate, s.admin]) {
      await agent.get("/api/team-brain/status").expect(404);
      await agent.get("/api/team-brain/proposals/mine").expect(404);
      await agent.get("/api/team-brain/proposals/pending").expect(404);
    }
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit`).expect(404);
    await s.mate.post(`/api/team-brain/cards/${p.id}/submit-all`).send({ count: 1 }).expect(404);
    await s.mate.post(`/api/team-brain/cards/${p.id}/withdraw`).expect(404);
    expect(s.store.getTeamBrainProposal(p.id)?.status).toBe("draft");
    // The admin panel carries no queue count either.
    const panel = (await s.admin.get("/api/admin/team-brain").expect(200)).body;
    expect(Object.keys(panel).sort()).toEqual(["backup", "githubHost", "noteCount", "rawSources", "uncompiledSources"]);
  });

  it("출처 정보: the drafter fills missing provenance on the card before the apply; every save is re-validated", async () => {
    const s = await boot();
    // A draft whose source lacks its kind / source / author / date.
    const p = draftWithSource(s.store, s.mateUser.id, {
      intake: { type: "howto", answers: { scope: "운영", validity: "모름", verified: "예" }, gaps: ["validity"] },
    });
    const view = (await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.provenance).toEqual({ editable: true, issues: ["source_kind", "source", "author", "authored_at"] });
    const blocked = await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(409);
    expect(blocked.body.error).toContain("출처 정보");
    expect(s.store.getTeamBrainProposal(p.id)?.status).toBe("draft");
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();

    const body = { sourceKind: "link", source: "사내 위키", author: "인프라팀", authoredAt: "2026-02-30" };
    await s.other.put(`/api/team-brain/cards/${p.id}/provenance`).send(body).expect(404);
    await s.admin.put(`/api/team-brain/cards/${p.id}/provenance`).send(body).expect(404);
    const invalid = await s.mate.put(`/api/team-brain/cards/${p.id}/provenance`).send(body).expect(400);
    expect(invalid.body.error).toContain("http:// 또는 https://");
    expect(invalid.body.error).toContain("작성일은 YYYY-MM-DD");
    const unknownSource = await s.mate.put(`/api/team-brain/cards/${p.id}/provenance`).send({ ...body, source: "모름" }).expect(400);
    expect(unknownSource.body.error).toContain("출처는 '모름'으로 둘 수 없습니다.");
    const secret = await s.mate
      .put(`/api/team-brain/cards/${p.id}/provenance`)
      .send({ ...body, source: `https://wiki.internal/?t=ghp_${"a".repeat(36)}`, authoredAt: "2026-10" })
      .expect(400);
    expect(secret.body.error).toContain("비밀 값");

    const saved = (
      await s.mate
        .put(`/api/team-brain/cards/${p.id}/provenance`)
        .send({ ...body, source: "https://wiki.internal/deploy", author: "모름", authoredAt: "2026-10" })
        .expect(200)
    ).body as TeamBrainCardView;
    expect(saved.provenance).toEqual({ editable: true, issues: [] });
    expect(saved.proposal.intake).toMatchObject({
      answers: { source_kind: "link", source: "https://wiki.internal/deploy", author: "모름", authored_at: "2026-10", scope: "운영" },
      gaps: ["author", "validity"],
    });
    expect(s.store.listAudit(s.mateUser.id, false, 20).map((a) => a.action)).toContain("team_brain_edit_provenance");

    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(200);
    expect(await readTeamVaultFile(s.config, p.path)).toContain("source: https://wiki.internal/deploy");
    // Once applied the source is committed: no more edits.
    const after = (await s.mate.get(`/api/team-brain/cards/${p.id}`).expect(200)).body as TeamBrainCardView;
    expect(after.provenance).toEqual({ editable: false, issues: [] });
    await s.mate.put(`/api/team-brain/cards/${p.id}/provenance`).send(body).expect(409);
    // A card without a source has none to edit.
    const plain = await draftUpdate(s, s.mateUser.id);
    expect(((await s.mate.get(`/api/team-brain/cards/${plain.id}`).expect(200)).body as TeamBrainCardView).provenance).toBeNull();
    await s.mate.put(`/api/team-brain/cards/${plain.id}/provenance`).send(body).expect(409);
  });

  it("anyone may edit any page — but a stale card is refused instead of overwriting, and the claim is released", async () => {
    const s = await boot();
    // The page was written by someone else (the seed commit is the admin identity's).
    await seedTeamVault(s.config, [{ path: PAGE_PATH, content: teamPage({ title: "배포" }) }]);
    const base = await teamNoteBlob(teamBrainRoot(s.config), PAGE_PATH);
    const card = await draftUpdate(s, s.mateUser.id);
    const fresh = (await s.mate.get(`/api/team-brain/cards/${card.id}`).expect(200)).body as TeamBrainCardView;
    expect(fresh.pages[0]).toMatchObject({ op: "update", stale: false, before: expect.stringContaining("배포 body.") });
    expect(fresh.actions.apply).toBe(true);
    // Another teammate's change lands first.
    await applyTeamChangeset(s.config, {
      raw: null,
      changes: [{ path: PAGE_PATH, op: "update", content: teamPage({ title: "배포", body: "other change" }), baseBlob: base }],
      title: "배포",
      proposalId: "other",
      logOp: "maintain",
      author: ADMIN_IDENTITY,
    });
    const view = (await s.mate.get(`/api/team-brain/cards/${card.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.stale).toBe(true);
    expect(view.pages[0].stale).toBe(true);
    expect(view.actions).toEqual({ apply: false, cancel: true });
    const res = await s.mate.post(`/api/team-brain/cards/${card.id}/apply`).expect(409);
    expect(res.body.error).toContain("그 사이 팀 브레인이 바뀌었습니다");
    expect(s.store.getTeamBrainProposal(card.id)).toMatchObject({ status: "draft", decidedBy: null, decidedAt: null });
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("other change");
    // Drafted again on the current page, the same teammate's change lands.
    const again = await draftUpdate(s, s.mateUser.id, "mate's change");
    await s.mate.post(`/api/team-brain/cards/${again.id}/apply`).expect(200);
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("mate's change");
    expect(await readTeamVaultFile(s.config, "wiki/log.md")).toContain("maintain | 배포 | approved by mate");
  });

  it("refuses a changeset the schema rejects NOW with a Korean count, and releases the claim", async () => {
    const s = await boot();
    await seedTeamVault(s.config, [{ path: "wiki/systems/ci.md", content: teamPage({ title: "CI", type: "system" }) }]);
    // The page cites the seed source but not the card's own raw path.
    const p = draftWithSource(s.store, s.mateUser.id, { changeset: changesetFor(SEED_RAW) });
    const res = await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(409);
    expect(res.body.error).toMatch(/팀 브레인 규칙에 맞지 않습니다 \(문제 \d+건\)/);
    expect(res.body.error).not.toContain("sources");
    expect(s.store.getTeamBrainProposal(p.id)).toMatchObject({ status: "draft", decidedBy: null, decidedAt: null });
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
    // A card without page changes is never applied.
    const empty = draft(s.store, s.mateUser.id, { changeset: null });
    expect((await s.mate.post(`/api/team-brain/cards/${empty.id}/apply`).expect(409)).body.error).toContain("반영할 변경 내용이 없습니다");
    expect(s.store.getTeamBrainProposal(empty.id)?.status).toBe("draft");
  });

  it("a suspended teammate cannot write: the route has no session for them and the press itself refuses", async () => {
    const s = await boot();
    const p = draftWithSource(s.store, s.mateUser.id);
    s.store.setSuspended(s.mateUser.id, true);
    expect(s.store.isActiveUser(s.mateUser.id)).toBe(false);
    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(401);
    // The live check does not lean on the session: the action refuses a suspended presser by itself.
    const actor = { id: s.mateUser.id, username: "mate", displayName: "mate" };
    const refused = await pressTeamBrainCard({ store: s.store, config: s.config }, actor, p.id, "apply");
    expect(refused).toMatchObject({ ok: false, status: 403, message: "정지된 계정은 팀 브레인 카드를 처리할 수 없습니다." });
    expect(s.store.getTeamBrainProposal(p.id)?.status).toBe("draft");
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
    expect(s.store.peekTeamBrainCardPress(s.mateUser.id, p.id)?.agentText).toContain("FAILED — this press changed nothing. The user's account is suspended");
    // Approved again, the same card goes through.
    s.store.setSuspended(s.mateUser.id, false);
    expect(await pressTeamBrainCard({ store: s.store, config: s.config }, actor, p.id, "apply")).toMatchObject({ ok: true });
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("compose up");
  });

  it("POLICY.md stays the admins': a teammate's policy card is refused, a demoted admin's too, an admin's commits", async () => {
    const s = await boot();
    await ensureTeamBrainRepo(s.config);
    const state = await teamPolicyState(s.config);
    const knobs = parseTeamPolicy(state.content).knobs;
    const policyCard = (userId: string, draftTtlDays: number) =>
      draft(s.store, userId, {
        kind: "policy",
        path: "POLICY.md",
        title: `초안 만료 ${draftTtlDays}일`,
        content: renderTeamPolicy({ ...knobs, draftTtlDays }, ""),
        baseBlob: state.blob,
      });
    // A teammate holds a policy row (however it got there): the button is off and the press is refused.
    const mates = policyCard(s.mateUser.id, 3);
    expect(((await s.mate.get(`/api/team-brain/cards/${mates.id}`).expect(200)).body as TeamBrainCardView).actions).toEqual({ apply: false, cancel: true });
    const refused = await s.mate.post(`/api/team-brain/cards/${mates.id}/apply`).expect(403);
    expect(refused.body.error).toBe("관리자만 팀 정책을 바꿀 수 있습니다.");
    expect(s.store.getTeamBrainProposal(mates.id)?.status).toBe("draft");

    const admins = policyCard(s.adminUser.id, 10);
    const view = (await s.admin.get(`/api/team-brain/cards/${admins.id}`).expect(200)).body as TeamBrainCardView;
    expect(view.actions).toEqual({ apply: true, cancel: true });
    expect(view.pages.map((p) => [p.path, p.op, p.stale])).toEqual([["POLICY.md", "update", false]]);
    // Demoted after drafting: refused, live.
    s.store.setRole(s.adminUser.id, "admin", false);
    await s.admin.post(`/api/team-brain/cards/${admins.id}/apply`).expect(403);
    expect(s.store.getTeamBrainProposal(admins.id)?.status).toBe("draft");
    // …but the demoted admin is still a teammate: their own page change goes through.
    await seedTeamVault(s.config, [{ path: PAGE_PATH, content: teamPage({ title: "배포" }) }]);
    const page = await draftUpdate(s, s.adminUser.id);
    await s.admin.post(`/api/team-brain/cards/${page.id}/apply`).expect(200);

    s.store.setRole(s.adminUser.id, "admin", true);
    await s.admin.post(`/api/team-brain/cards/${admins.id}/apply`).expect(200);
    expect(parseTeamPolicy(await readTeamVaultFile(s.config, "POLICY.md")).knobs.draftTtlDays).toBe(10);
    expect(s.store.listAudit(s.adminUser.id, true, 50).map((a) => a.action)).toContain("team_brain_policy");
    expect(s.store.getTeamBrainProposal(mates.id)?.status).toBe("draft");
  });

  it("취소: the drafter takes a draft back; nothing else can be cancelled", async () => {
    const s = await boot();
    const p = draftWithSource(s.store, s.mateUser.id);
    await s.other.post(`/api/team-brain/cards/${p.id}/cancel`).expect(404);
    const cancelled = (await s.mate.post(`/api/team-brain/cards/${p.id}/cancel`).expect(200)).body as TeamBrainCardView;
    expect(cancelled.proposal.status).toBe("cancelled");
    expect(cancelled.actions).toEqual({ apply: false, cancel: false });
    await s.mate.post(`/api/team-brain/cards/${p.id}/cancel`).expect(409);
    await s.mate.post(`/api/team-brain/cards/${p.id}/apply`).expect(409);
    expect(await readTeamVaultFile(s.config, p.path)).toBeNull();
    expect(s.store.listAudit(s.mateUser.id, false, 20).map((a) => a.action)).toContain("team_brain_cancel");
    // An applied card is the world now: it cannot be cancelled.
    const applied = draftWithSource(s.store, s.mateUser.id);
    await s.mate.post(`/api/team-brain/cards/${applied.id}/apply`).expect(200);
    await s.mate.post(`/api/team-brain/cards/${applied.id}/cancel`).expect(409);
    expect(s.store.getTeamBrainProposal(applied.id)?.status).toBe("applied");
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

describe("team brain cards — the retired review queue is history", () => {
  const UPGRADE_NOTICE =
    "팀 브레인 작성 방식이 바뀌어 이 제안은 종료되었습니다. 이제 누구나 팀 브레인에 직접 반영할 수 있으니, 아바타에게 이 내용을 팀 브레인에 다시 반영해 달라고 요청하세요.";

  it("an old card renders as its title and ONE final-state line: no buttons, no pages, no provenance form", async () => {
    const s = await boot();
    const submission = (status: Parameters<typeof insertLegacyTeamBrainRow>[1]["status"], extra = {}) =>
      insertLegacyTeamBrainRow(s.store, { kind: "propose", status, proposerUserId: s.mateUser.id, intake: INTAKE, title: "옛 제안", ...extra });
    const review = (status: Parameters<typeof insertLegacyTeamBrainRow>[1]["status"], decision: "approve" | "reject" | "ask", targetId: string) =>
      insertLegacyTeamBrainRow(s.store, {
        kind: "review",
        status,
        proposerUserId: s.adminUser.id,
        targetId,
        decision,
        changeset: decision === "approve" ? changesetFor(SEED_RAW) : null,
      });
    const view = async (agent: typeof s.mate, id: string) => (await agent.get(`/api/team-brain/cards/${id}`).expect(200)).body as TeamBrainCardView;
    const legacyOf = async (agent: typeof s.mate, id: string) => {
      const v = await view(agent, id);
      // The whole legacy shape: nothing to press, nothing to diff, nothing to edit.
      expect(v).toMatchObject({ stale: false, pages: [], actions: { apply: false, cancel: false }, provenance: null });
      return v.legacy;
    };

    const approved = submission("approved");
    expect(await legacyOf(s.mate, approved)).toEqual({ closedByUpgrade: false, notice: "승인되어 팀 브레인에 반영된 제안입니다." });
    expect((await view(s.mate, approved)).proposal).toMatchObject({ id: approved, kind: "propose", title: "옛 제안", content: SOURCE });
    expect(await legacyOf(s.mate, submission("rejected", { decisionReason: "중복입니다" }))).toEqual({ closedByUpgrade: false, notice: "반려된 제안입니다." });
    expect(await legacyOf(s.mate, submission("withdrawn"))).toEqual({ closedByUpgrade: false, notice: "철회한 제안입니다." });
    expect(await legacyOf(s.mate, submission("expired"))).toEqual({ closedByUpgrade: false, notice: "제출하지 않아 만료된 제안입니다." });
    expect(await legacyOf(s.admin, review("applied", "approve", approved))).toEqual({
      closedByUpgrade: false,
      notice: "제안을 승인해 팀 브레인에 반영한 검토 카드입니다.",
    });
    expect(await legacyOf(s.admin, review("applied", "ask", approved))).toEqual({ closedByUpgrade: false, notice: "제안자에게 보완 요청을 보낸 검토 카드입니다." });
    expect(await legacyOf(s.admin, review("applied", "reject", approved))).toEqual({ closedByUpgrade: false, notice: "제안을 반려한 검토 카드입니다." });
    expect(await legacyOf(s.admin, review("cancelled", "reject", approved))).toEqual({ closedByUpgrade: false, notice: "취소된 검토 카드입니다." });

    // Still the drafter's alone.
    await s.other.get(`/api/team-brain/cards/${approved}`).expect(404);
    await s.admin.get(`/api/team-brain/cards/${approved}`).expect(404);
  });

  it("a submission the upgrade closed says the way changed — before the closing step ran, and after", async () => {
    const s = await boot();
    const pending = insertLegacyTeamBrainRow(s.store, { kind: "propose", status: "pending", proposerUserId: s.mateUser.id, intake: INTAKE });
    const needsInfo = insertLegacyTeamBrainRow(s.store, { kind: "propose", status: "needs_info", proposerUserId: s.mateUser.id, decisionReason: "어느 서버?" });
    const reviewDraft = insertLegacyTeamBrainRow(s.store, { kind: "review", status: "draft", proposerUserId: s.adminUser.id, targetId: pending, decision: "reject" });
    const view = async (agent: typeof s.mate, id: string) => (await agent.get(`/api/team-brain/cards/${id}`).expect(200)).body as TeamBrainCardView;

    // The step has not run (a held backup, or the moment before it): the card already says so, and nothing is pressable.
    for (const id of [pending, needsInfo]) {
      expect(await view(s.mate, id)).toMatchObject({ actions: { apply: false, cancel: false }, legacy: { closedByUpgrade: true, notice: UPGRADE_NOTICE } });
    }
    for (const [agent, id] of [[s.mate, pending], [s.mate, needsInfo], [s.admin, reviewDraft]] as const) {
      expect((await agent.post(`/api/team-brain/cards/${id}/apply`).expect(409)).body.error).toContain("더 이상 처리할 수 없습니다");
      await agent.post(`/api/team-brain/cards/${id}/cancel`).expect(409);
      await agent.put(`/api/team-brain/cards/${id}/provenance`).send({ sourceKind: "other", source: "x", author: "x", authoredAt: "2026" }).expect(409);
      // A card with no button has no press to report.
      expect(s.store.peekTeamBrainCardPress(agent === s.mate ? s.mateUser.id : s.adminUser.id, id)).toBeNull();
    }
    expect(s.store.getTeamBrainProposal(pending)?.status).toBe("pending");

    expect(await retireTeamBrainReviewQueueOnBoot(s)).toEqual({ approved: 0, closed: 3 });
    const closed = await view(s.mate, pending);
    expect(closed.proposal).toMatchObject({ status: "cancelled", decisionReason: TEAM_BRAIN_CLOSED_BY_UPGRADE, content: SOURCE });
    expect(closed.legacy).toEqual({ closedByUpgrade: true, notice: UPGRADE_NOTICE });
    expect((await view(s.mate, needsInfo)).legacy).toEqual({ closedByUpgrade: true, notice: UPGRADE_NOTICE });
    expect((await view(s.admin, reviewDraft)).legacy).toEqual({
      closedByUpgrade: true,
      notice: "팀 브레인 작성 방식이 바뀌어(검토 절차가 없어졌습니다) 이 검토 카드는 종료되었습니다.",
    });
    // A card a person cancelled before the upgrade is not the upgrade's doing.
    const own = insertLegacyTeamBrainRow(s.store, { kind: "propose", status: "cancelled", proposerUserId: s.mateUser.id });
    expect((await view(s.mate, own)).legacy).toEqual({ closedByUpgrade: false, notice: "종료된 제안입니다." });
  });
});

describe("team brain cards — boot sweep and rewind", () => {
  it("boot sweep: an applied card with no commit goes back to draft; a landed one and this process's own claims are untouched", async () => {
    const s = await boot();
    const db = (s.store as unknown as { db: import("better-sqlite3").Database }).db;
    const past = new Date(Date.now() - 60_000).toISOString();
    // A: claimed, then the process died before the commit.
    const a = draftWithSource(s.store, s.mateUser.id);
    s.store.transitionTeamBrainProposal(a.id, ["draft"], "applied", { decidedBy: s.mateUser.id, decided: true });
    // B: really applied.
    const b = draftWithSource(s.store, s.mateUser.id, { title: "B" });
    await s.mate.post(`/api/team-brain/cards/${b.id}/apply`).expect(200);
    // L: a review card of the retired queue is history — never swept.
    const legacy = insertLegacyTeamBrainRow(s.store, { kind: "review", status: "applied", proposerUserId: s.adminUser.id, decision: "approve", decidedAt: past });
    db.prepare("UPDATE team_brain_proposals SET decided_at = ? WHERE id IN (?, ?)").run(past, a.id, b.id);
    const startedAt = new Date().toISOString();
    // C: claimed after boot (this process's own, maybe in flight).
    const c = draftWithSource(s.store, s.otherUser.id, { title: "C" });
    s.store.transitionTeamBrainProposal(c.id, ["draft"], "applied", { decidedBy: s.otherUser.id, decided: true });
    db.prepare("UPDATE team_brain_proposals SET decided_at = ? WHERE id = ?").run(new Date(Date.now() + 1000).toISOString(), c.id);

    expect(await sweepTeamBrainAppliesOnBoot(s, startedAt)).toBe(1);
    expect(s.store.getTeamBrainProposal(a.id)).toMatchObject({ status: "draft", decidedBy: null, decidedAt: null });
    expect(s.store.getTeamBrainProposal(b.id)?.status).toBe("applied");
    expect(s.store.getTeamBrainProposal(c.id)?.status).toBe("applied");
    expect(s.store.getTeamBrainProposal(legacy)?.status).toBe("applied");
    // The card that fell back can be pressed again.
    await s.mate.post(`/api/team-brain/cards/${a.id}/apply`).expect(409); // B already created the same page
    expect(s.store.getTeamBrainProposal(a.id)?.status).toBe("draft");
  });

  it("a rewind cancels a draft card whose message it drops, and keeps an applied one", async () => {
    const s = await boot();
    const ownerId = s.mateUser.id;
    s.store.touchConversation(ownerId, "c1", ownerId, "질문");
    const keepDraft = draftWithSource(s.store, ownerId, { conversationId: "c1" });
    const dropDraft = draftWithSource(s.store, ownerId, { conversationId: "c1" });
    const dropApplied = draftWithSource(s.store, ownerId, { conversationId: "c1" });
    await s.mate.post(`/api/team-brain/cards/${dropApplied.id}/apply`).expect(200);
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
    add("assistant", "둘째 답", "2026-11-06T00:00:04.000Z", [card(dropDraft.id), card(dropApplied.id)]);
    const plan = s.store.planConversationRewind(ownerId, "c1", u2.id, "from")!;
    expect(s.store.applyConversationRewind(ownerId, "c1", plan)).toBe(true);
    expect(s.store.getTeamBrainProposal(keepDraft.id)?.status).toBe("draft");
    expect(s.store.getTeamBrainProposal(dropDraft.id)?.status).toBe("cancelled");
    // The committed page stays in the vault: a rewind cuts history, never the world.
    expect(s.store.getTeamBrainProposal(dropApplied.id)?.status).toBe("applied");
    expect(await readTeamNote(s.config, PAGE_PATH)).toContain("compose up");
  });
});
