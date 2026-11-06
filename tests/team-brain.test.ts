import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import type { Store } from "../src/server/store.js";
import {
  TeamNoteConflictError,
  applyTeamNote,
  countTeamNotes,
  ensureTeamBrainRepo,
  findSecretInText,
  readTeamNote,
  searchTeamBrain,
  teamBrainInitialized,
  teamBrainRoot,
  teamNoteBlob,
  validateTeamNotePath,
} from "../src/server/teamBrain.js";
import { TEAM_BRAIN_MAX_OPEN_PROPOSALS, type TeamBrainProposal } from "../src/shared/teamBrain.js";
import { withTempDir } from "./helpers.js";

const dir = withTempDir("team-brain");
let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function boot() {
  services = createServices({ dataDir: dir(), agentRuntime: "local", sessionSecret: "test" });
  return services;
}

function rawDb(store: Store): Database.Database {
  return (store as unknown as { db: Database.Database }).db;
}

const NOTE = "---\ntitle: Deploy process\ntags: [deploy]\n---\n\nWe deploy with `docker compose up` after setup-host.sh.\n";
const ADMIN = { name: "Admin", email: "admin@noah-almighty.local" };

function draft(store: Store, proposerUserId: string, extra: Partial<Parameters<Store["createTeamBrainProposal"]>[0]> = {}) {
  const result = store.createTeamBrainProposal({
    kind: "propose",
    proposerUserId,
    conversationId: null,
    path: "wiki/concepts/deploy.md",
    op: "create",
    title: "Deploy process",
    summary: "How we deploy",
    content: NOTE,
    baseBlob: null,
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}

describe("team brain note paths", () => {
  it("accepts a regular wiki note and normalizes it", () => {
    expect(validateTeamNotePath("/wiki/concepts/deploy.md")).toEqual({ ok: true, path: "wiki/concepts/deploy.md" });
    expect(validateTeamNotePath("wiki/용어/배포.md")).toEqual({ ok: true, path: "wiki/용어/배포.md" });
  });

  it.each([
    ["", "required"],
    ["raw/x.md", "under `wiki/`"],
    ["wiki/../CLAUDE.md", "under `wiki/`"],
    ["wiki/index.md", "regular"],
    ["wiki/log.md", "regular"],
    ["wiki/a/_template.md", "regular"],
    ["wiki/notes.txt", "regular"],
    ["wiki/.hidden/x.md", "may only contain"],
    ["wiki/a;rm.md", "may only contain"],
    ["wiki/a\nb.md", "may only contain"],
  ])("refuses %j", (raw, reason) => {
    const checked = validateTeamNotePath(raw);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.reason).toContain(reason);
  });
});

describe("team brain secret check", () => {
  it("finds the proposer's own secret value by NAME and well-known token shapes", () => {
    expect(findSecretInText("token is abcdef123456 here", { MY_TOKEN: "abcdef123456" })).toBe("MY_TOKEN");
    expect(findSecretInText("short ab", { X: "ab" })).toBeNull();
    expect(findSecretInText(`key ghp_${"a".repeat(36)}`, {})).toBe("a credential-like token");
    expect(findSecretInText("-----BEGIN OPENSSH PRIVATE KEY-----", {})).toBe("a credential-like token");
    expect(findSecretInText("plain team fact", {})).toBeNull();
  });
});

describe("team brain vault (local git)", () => {
  it("is created lazily with a seed commit and no remote", async () => {
    const { config } = boot();
    expect(teamBrainInitialized(config)).toBe(false);
    expect(await countTeamNotes(config)).toBe(0);
    expect(await searchTeamBrain(config, "deploy")).toEqual({ kind: "ok", hits: [] });
    const root = await ensureTeamBrainRepo(config);
    expect(root).toBe(path.join(config.dataDir, "team-brain"));
    expect(teamBrainInitialized(config)).toBe(true);
    expect(execFileSync("git", ["-C", root, "remote"]).toString().trim()).toBe("");
    expect(execFileSync("git", ["-C", root, "log", "--format=%s"]).toString().trim()).toBe("team-brain: initialize");
    // The structural index is not a note.
    expect(await countTeamNotes(config)).toBe(0);
  });

  it("applies a create, then an update guarded by the blob, with proposal + co-author trailers", async () => {
    const { config } = boot();
    const sha = await applyTeamNote(config, {
      path: "wiki/concepts/deploy.md",
      op: "create",
      content: NOTE,
      expectedBlob: null,
      title: "Deploy process",
      proposalId: "p1",
      author: ADMIN,
      coAuthor: { name: "Teammate", email: "mate@noah-almighty.local" },
    });
    const root = teamBrainRoot(config);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const message = execFileSync("git", ["-C", root, "log", "-1", "--format=%an|%B"]).toString();
    expect(message).toContain("Admin|team-brain: Deploy process");
    expect(message).toContain("Proposal: p1");
    expect(message).toContain("Co-authored-by: Teammate <mate@noah-almighty.local>");
    expect(await readTeamNote(config, "wiki/concepts/deploy.md")).toBe(NOTE);
    expect(await countTeamNotes(config)).toBe(1);
    const hits = await searchTeamBrain(config, "deploy");
    expect(hits.kind === "ok" && hits.hits.map((h) => h.path)).toEqual(["wiki/concepts/deploy.md"]);

    const blob = await teamNoteBlob(root, "wiki/concepts/deploy.md");
    // A second create of the same path, an update against a stale blob, an update of a missing note.
    const base = { content: "x", title: "t", proposalId: "p2", author: ADMIN } as const;
    await expect(applyTeamNote(config, { ...base, path: "wiki/concepts/deploy.md", op: "create", expectedBlob: null })).rejects.toEqual(
      new TeamNoteConflictError("EXISTS"),
    );
    await expect(
      applyTeamNote(config, { ...base, path: "wiki/concepts/deploy.md", op: "update", expectedBlob: "0".repeat(40) }),
    ).rejects.toEqual(new TeamNoteConflictError("STALE"));
    await expect(applyTeamNote(config, { ...base, path: "wiki/concepts/none.md", op: "update", expectedBlob: null })).rejects.toEqual(
      new TeamNoteConflictError("MISSING"),
    );
    await applyTeamNote(config, { ...base, path: "wiki/concepts/deploy.md", op: "update", expectedBlob: blob, content: "new truth" });
    expect(await readTeamNote(config, "wiki/concepts/deploy.md")).toBe("new truth\n");
    // Identical content is a no-op, not a failure.
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
    const blob2 = await teamNoteBlob(root, "wiki/concepts/deploy.md");
    expect(
      await applyTeamNote(config, { ...base, path: "wiki/concepts/deploy.md", op: "update", expectedBlob: blob2, content: "new truth" }),
    ).toBe(head);
  });

  it("leaves no unapproved note behind when the commit fails", async () => {
    const { config } = boot();
    const root = await ensureTeamBrainRepo(config);
    // A stale index lock makes `git commit` (and add) fail.
    fs.writeFileSync(path.join(root, ".git", "index.lock"), "");
    await expect(
      applyTeamNote(config, { path: "wiki/x.md", op: "create", content: "secret draft", expectedBlob: null, title: "t", proposalId: "p", author: ADMIN }),
    ).rejects.toThrow();
    fs.rmSync(path.join(root, ".git", "index.lock"));
    expect(fs.existsSync(path.join(root, "wiki", "x.md"))).toBe(false);
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"]).toString().trim()).toBe("");
  });

  it("refuses an invalid path at apply time too", async () => {
    const { config } = boot();
    await expect(
      applyTeamNote(config, { path: "wiki/../x.md", op: "create", content: "x", expectedBlob: null, title: "t", proposalId: "p", author: ADMIN }),
    ).rejects.toThrow("INVALID_PATH");
    expect(fs.existsSync(path.join(config.dataDir, "x.md"))).toBe(false);
  });
});

describe("team brain proposals store", () => {
  it("creates drafts, caps open ones per user, and transitions by compare-and-set", () => {
    const { store } = boot();
    const user = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const first = draft(store, user.id);
    expect(first).toMatchObject<Partial<TeamBrainProposal>>({ status: "draft", kind: "propose", proposerName: "Mate", op: "create" });
    for (let i = 1; i < TEAM_BRAIN_MAX_OPEN_PROPOSALS; i += 1) draft(store, user.id);
    expect(
      store.createTeamBrainProposal({
        kind: "propose",
        proposerUserId: user.id,
        conversationId: null,
        path: "wiki/x.md",
        op: "create",
        title: "x",
        summary: "",
        content: "x",
        baseBlob: null,
      }),
    ).toEqual({ ok: false, error: "LIMIT" });

    expect(store.transitionTeamBrainProposal(first.id, ["draft"], "pending")).toBe(true);
    expect(store.countPendingTeamBrainProposals()).toBe(1);
    // A second press of the same transition loses the race.
    expect(store.transitionTeamBrainProposal(first.id, ["draft"], "pending")).toBe(false);
    expect(store.transitionTeamBrainProposal(first.id, ["pending"], "approved", { decidedBy: user.id, decided: true })).toBe(true);
    expect(store.transitionTeamBrainProposal(first.id, ["pending"], "rejected")).toBe(false);
    expect(store.getTeamBrainProposal(first.id)).toMatchObject({ status: "approved", decidedBy: user.id });
    expect(store.countPendingTeamBrainProposals()).toBe(0);
  });

  it("counts unseen results for the proposer and marks them seen", () => {
    const { store } = boot();
    const user = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const a = draft(store, user.id);
    const b = draft(store, user.id);
    store.transitionTeamBrainProposal(a.id, ["draft"], "pending");
    store.transitionTeamBrainProposal(b.id, ["draft"], "pending");
    store.transitionTeamBrainProposal(a.id, ["pending"], "approved", { decided: true });
    store.transitionTeamBrainProposal(b.id, ["pending"], "rejected", { decisionReason: "dup", decided: true });
    expect(store.countUnseenTeamBrainResults(user.id)).toBe(2);
    expect(store.markTeamBrainResultsSeen(user.id, [a.id])).toBe(1);
    expect(store.countUnseenTeamBrainResults(user.id)).toBe(1);
    store.markTeamBrainResultsSeen(user.id);
    expect(store.countUnseenTeamBrainResults(user.id)).toBe(0);
  });

  it("expires stale drafts lazily, withdraws rewound drafts only, and drops a deleted user's rows", () => {
    const { store } = boot();
    const user = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const old = draft(store, user.id);
    rawDb(store).prepare("UPDATE team_brain_proposals SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", old.id);
    const submitted = draft(store, user.id);
    store.transitionTeamBrainProposal(submitted.id, ["draft"], "pending");
    const fresh = draft(store, user.id);
    const direct = draft(store, user.id, { kind: "direct" });
    expect(store.listTeamBrainProposals({ proposerUserId: user.id }).find((p) => p.id === old.id)?.status).toBe("expired");
    expect(store.withdrawTeamBrainDrafts([submitted.id, fresh.id, direct.id])).toBe(2);
    expect(store.getTeamBrainProposal(submitted.id)?.status).toBe("pending");
    expect(store.getTeamBrainProposal(fresh.id)?.status).toBe("withdrawn");
    expect(store.getTeamBrainProposal(direct.id)?.status).toBe("cancelled");
    expect(store.deleteUser(user.id)).toBe(true);
    expect(store.listTeamBrainProposals({})).toEqual([]);
  });

  it("surfaces the source conversation only while it exists, and expires a draft whose conversation is gone", () => {
    const { store } = boot();
    const user = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    store.touchConversation(user.id, "c-live", user.id, "대화");
    const live = draft(store, user.id, { conversationId: "c-live" });
    const gone = draft(store, user.id, { conversationId: "gone-conversation" });
    expect(store.getTeamBrainProposal(gone.id)?.conversationId).toBeNull();
    store.expireTeamBrainDrafts();
    expect(store.getTeamBrainProposal(live.id)).toMatchObject({ status: "draft", conversationId: "c-live" });
    expect(store.getTeamBrainProposal(gone.id)?.status).toBe("expired");
  });
});
