import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { ensureClone, knowledgeRepoContextFor } from "../src/server/knowledgeRepo.js";
import {
  copySkillDir,
  hashSkillDir,
  learnSkillIntoRepo,
  listRepoSkills,
  listSkillFiles,
  normalizeSkillSlug,
  readRepoSkill,
  readSkillOrigin,
  reconcileOwnerSharedSkills,
} from "../src/server/skillTransfer.js";
import { buildRepoTools } from "../src/server/agent/repoTools.js";
import { buildSkillExchangeTools } from "../src/server/agent/skillExchangeTools.js";
import { callTool, makeBareRemote, shareGroup, signup, withTempDir } from "./helpers.js";
import type { SharedSkillListing } from "../src/server/types.js";

// Coverage target: the skill-share (#skill-share) surface —
//  - store/avatars.ts shared_skills CRUD + learnable visibility (mirrors 탐색)
//  - skillTransfer.ts listing/copy/learn plumbing (offline local bare remotes)
//  - routes/skillShare.ts share/unshare/available/preview/learn
//  - agent/skillExchangeTools.ts handler self-gates + redirects

let tempDir: string;
const getTempDir = withTempDir("skill-share", () => {
  tempDir = getTempDir();
});

function bootstrap() {
  const services = createServices({
    dataDir: tempDir,
    agentRuntime: "local",
    sessionSecret: "test",
  });
  return { app: createApp(services), store: services.store, config: services.config };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

const SKILL_MD = `---
name: pptx-report
description: Weekly report deck generator
---

# pptx-report

Make the deck.
`;

/**
 * A committed provenance marker — what a LEARNED copy carries. Seeding it into
 * a remote is the cheap stand-in for a full learn round-trip when the test is
 * about what the marker BLOCKS (re-sharing) rather than how it got there.
 */
const ORIGIN_MARKER = JSON.stringify({
  ownerUserId: "original-user-id",
  ownerUsername: "original",
  skillName: "pptx-report",
  contentHash: "a".repeat(64),
  localHash: "a".repeat(64),
  learnedAt: "2026-01-01T00:00:00.000Z",
});

/** Seed a bare remote on `main` with the given repo-relative files. */
function seedRemote(name: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(tempDir, `${name}.git`));
  const seed = path.join(tempDir, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "seed@example.com");
  g("config", "user.name", "Seed");
  g("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

/** A remote holding one shareable skill plus an empty marketplace manifest. */
function seedSkillRemote(name: string, extra: Record<string, string> = {}): string {
  return seedRemote(name, {
    ".claude-plugin/marketplace.json": JSON.stringify({ name, plugins: [] }),
    "skills/pptx-report/SKILL.md": SKILL_MD,
    "skills/pptx-report/scripts/render.sh": "#!/bin/sh\necho deck\n",
    ...extra,
  });
}

/** Commit + push a file change to a remote seeded by seedRemote (new version). */
function updateRemoteFile(name: string, rel: string, content: string): void {
  const seed = path.join(tempDir, `${name}-seed`);
  const abs = path.join(seed, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("add", "-A");
  g("commit", "-q", "-m", "update");
  g("push", "-q", "origin", "main");
}

/** `git rm -r` a path in a seeded remote and push — a genuine deletion. */
function deleteRemotePath(name: string, rel: string): void {
  const seed = path.join(tempDir, `${name}-seed`);
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("rm", "-r", "-q", rel);
  g("commit", "-q", "-m", `delete ${rel}`);
  g("push", "-q", "origin", "main");
}

/** `git mv` one skill dir in a seeded remote and push — a PURE rename. */
function renameRemoteSkill(name: string, from: string, to: string): void {
  const seed = path.join(tempDir, `${name}-seed`);
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("mv", `skills/${from}`, `skills/${to}`);
  g("commit", "-q", "-m", `rename ${from} -> ${to}`);
  g("push", "-q", "origin", "main");
}

/** SKILL.md text with the given frontmatter — the shape listRepoSkills reads. */
function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Write `skills/<slug>/<rel>` files into a working tree. */
function writeSkills(root: string, skills: Record<string, Record<string, string>>): void {
  for (const [slug, files] of Object.entries(skills)) {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, "skills", slug, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
}

/**
 * A bare working TREE with no git at all — the "clone is being rebuilt" shape.
 * Keys are slugs, values are the files under that slug.
 */
function makeTree(name: string, skills: Record<string, Record<string, string>>): string {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  writeSkills(root, skills);
  return root;
}

/** `git -C <root> …`, quiet — drives the fixture repos below. */
function gitIn(root: string): (...args: string[]) => void {
  return (...args) => {
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  };
}

/**
 * A working tree that is a real git repo (no remote). Reconciliation follows a
 * rename ONLY on git's own evidence, so every fixture that moves a directory
 * has to commit it the way the avatar's repo tools do.
 */
function makeRepo(name: string, skills: Record<string, Record<string, string>>): string {
  const root = path.join(tempDir, name);
  fs.mkdirSync(root, { recursive: true });
  const g = gitIn(root);
  g("init", "-q");
  g("config", "user.email", "tree@example.com");
  g("config", "user.name", "Tree");
  g("config", "commit.gpgsign", "false");
  writeSkills(root, skills);
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  return root;
}

/** Stage and commit everything currently in a makeRepo working tree. */
function commitTree(root: string, message: string): void {
  const g = gitIn(root);
  g("add", "-A");
  g("commit", "-q", "-m", message);
}

/** Rename `skills/<from>` → `skills/<to>` inside a makeTree working tree. */
function moveTreeSkill(root: string, from: string, to: string): void {
  fs.renameSync(path.join(root, "skills", from), path.join(root, "skills", to));
}

/**
 * Simulate the learner CUSTOMIZING a learned copy: edit + commit + push inside
 * their server-side knowledge clone (the flow avatar repo-writes take), so a
 * later ensureClone keeps the change.
 */
function customizeLearnedCopy(userId: string, rel: string, content: string): void {
  const clone = path.join(tempDir, "knowledge", userId);
  fs.writeFileSync(path.join(clone, rel), content);
  const g = (...a: string[]) => execFileSync("git", ["-C", clone, ...a], { stdio: "pipe" });
  g("config", "user.email", "learner@example.com");
  g("config", "user.name", "Learner");
  g("config", "commit.gpgsign", "false");
  g("add", "-A");
  g("commit", "-q", "-m", "customize");
  g("push", "-q", "origin", "main");
}

// ---- store: shared_skills ---------------------------------------------------

describe("shared_skills store", () => {
  it("share upserts (id stable, metadata refreshed), unshare deletes", () => {
    const { store } = bootstrap();
    const first = store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "old",
    });
    const second = store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "new",
    });
    expect(second.id).toBe(first.id);
    expect(second.description).toBe("new");
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(1);
    expect(store.unshareSkill("u1", "pptx-report")).toBe(true);
    expect(store.unshareSkill("u1", "pptx-report")).toBe(false);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(0);
  });

  it("a custom introduction overrides the snapshot for viewers, and outlives a re-share", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });

    // Unset: the effective description IS the frontmatter snapshot.
    const before = store.listSharedSkillsByOwner(sharer.userId)[0];
    expect(before.description).toBe("Weekly report deck generator");
    expect(before.customDescription).toBeNull();
    expect(before.snapshotDescription).toBe("Weekly report deck generator");

    const set = store.setSharedSkillDescription(sharer.userId, "pptx-report", "  주간 보고 덱을 대신 만들어 드려요  ");
    expect(set?.customDescription).toBe("주간 보고 덱을 대신 만들어 드려요"); // trimmed
    // EVERY viewer surface reads the mapper, so none of them can drift.
    expect(store.listLearnableSkills(mate.userId)[0].description).toBe(
      "주간 보고 덱을 대신 만들어 드려요",
    );
    expect(store.getLearnableSkillByName(mate.userId, "sharer", "pptx-report")?.description).toBe(
      "주간 보고 덱을 대신 만들어 드려요",
    );
    // ...while the snapshot column stays exactly what the SKILL.md said.
    expect(store.listLearnableSkills(mate.userId)[0].snapshotDescription).toBe(
      "Weekly report deck generator",
    );
    // Searchable by BOTH texts: what the browser reads and what the skill says.
    expect(store.listLearnableSkills(mate.userId, "주간")).toHaveLength(1);
    expect(store.listLearnableSkills(mate.userId, "Weekly")).toHaveLength(1);

    // A re-share (owner reconciliation, drifted frontmatter) re-snapshots the
    // snapshot column ONLY — the owner's intro is not theirs to overwrite.
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator v2",
    });
    const afterReshare = store.listSharedSkillsByOwner(sharer.userId)[0];
    expect(afterReshare.snapshotDescription).toBe("Weekly report deck generator v2");
    expect(afterReshare.description).toBe("주간 보고 덱을 대신 만들어 드려요");

    // Empty clears it back to the frontmatter text.
    expect(store.setSharedSkillDescription(sharer.userId, "pptx-report", "   ")?.description).toBe(
      "Weekly report deck generator v2",
    );
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].customDescription).toBeNull();
    // A skill that isn't shared has nothing to introduce.
    expect(store.setSharedSkillDescription(sharer.userId, "nope", "hi")).toBeNull();

    // Unshare deletes the intro with the row: a later re-share starts clean.
    store.setSharedSkillDescription(sharer.userId, "pptx-report", "다시 쓴 소개");
    store.unshareSkill(sharer.userId, "pptx-report");
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].customDescription).toBeNull();
  });

  it("learnable visibility mirrors avatar discovery (group teammates only)", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin"); // first signup = system admin
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const outsider = await newUser(app, "outsider");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"]);

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "Weekly report deck generator",
    });

    // Teammate sees it; the sharer's own view and outsiders don't.
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
    expect(store.countLearnableSkills(mate.userId)).toBe(1);
    expect(store.listLearnableSkills(sharer.userId)).toHaveLength(0);
    expect(store.listLearnableSkills(outsider.userId)).toHaveLength(0);
    expect(store.countLearnableSkills(outsider.userId)).toBe(0);

    // Lookup by @username + slug, and by id — visibility-checked both ways.
    const byName = store.getLearnableSkillByName(mate.userId, "sharer", "pptx-report");
    expect(byName?.owner.username).toBe("sharer");
    expect(store.getLearnableSkillByName(outsider.userId, "sharer", "pptx-report")).toBeNull();
    expect(store.getLearnableSkill(mate.userId, byName!.id)?.id).toBe(byName!.id);
    expect(store.getLearnableSkill(outsider.userId, byName!.id)).toBeNull();

    // A private avatar's shares disappear from teammates (visibility axis).
    store.updateProfile(sharer.userId, { visibility: "private" });
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.updateProfile(sharer.userId, { visibility: "group" });

    // A suspended owner's shares disappear.
    store.setSuspended(sharer.userId, true);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.setSuspended(sharer.userId, false);

    // An avatar-sharing-off group grants neither visibility nor learnability.
    store.setGroupAvatarSharing(groupId, false);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.setGroupAvatarSharing(groupId, true);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
  });

  it("filters by query across skill fields and owner names", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    store.shareSkill(sharer.userId, {
      skillName: "code-review",
      displayName: "code-review",
      description: "Review checklists",
    });

    expect(store.listLearnableSkills(mate.userId, "deck")).toHaveLength(1);
    expect(store.listLearnableSkills(mate.userId, "review")).toHaveLength(1);
    expect(store.listLearnableSkills(mate.userId, "sharer")).toHaveLength(2);
    expect(store.listLearnableSkills(mate.userId, "nothing-matches")).toHaveLength(0);
  });

  it("counts learns per (owner, skill) and keeps them across unshare→re-share", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    expect(store.listLearnableSkills(mate.userId)[0].learnCount).toBe(0);
    store.recordSkillLearn(sharer.userId, "pptx-report", mate.userId);
    store.recordSkillLearn(sharer.userId, "pptx-report", mate.userId);
    expect(store.listLearnableSkills(mate.userId)[0].learnCount).toBe(2);
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].learnCount).toBe(2);
    expect(store.skillLearnCounts(sharer.userId)).toEqual({ "pptx-report": 2 });
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(2);

    // Events are keyed by (owner, skill_name), not the share row: an
    // unshare→re-share keeps the history.
    store.unshareSkill(sharer.userId, "pptx-report");
    expect(store.skillLearnCounts(sharer.userId)).toEqual({ "pptx-report": 2 });
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].learnCount).toBe(2);

    // deleteUser cascades the LEARNER axis too (privacy promise).
    store.deleteUser(mate.userId);
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(0);
  });

  it("a group-channel block hides the share from that group's members only", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"], "Alpha");
    const share = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });

    store.blockSharedSkillInGroup(groupId, sharer.userId, "pptx-report", admin.userId);

    // Every learnable read is built on the same fragment, so the listing AND
    // the by-id / by-name lookups that back preview+learn all fail closed.
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    expect(store.countLearnableSkills(mate.userId)).toBe(0);
    expect(store.getLearnableSkill(mate.userId, share.id)).toBeNull();
    expect(store.getLearnableSkillByName(mate.userId, "sharer", "pptx-report")).toBeNull();
    // The owner's own view is untouched — a block is not an unshare.
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(1);
    // And so is avatar visibility: the block scopes to the skill channel.
    expect(store.isTrustedFor(mate.userId, sharer.userId)).toBe(true);
    expect(
      store.listPublishedAvatars(mate.userId).some((a) => a.id === sharer.userId),
    ).toBe(true);

    // A SECOND mutual sharing group with no block keeps it visible: the rule is
    // "at least one unblocked mutual group", not "no block anywhere".
    const otherGroupId = await shareGroup(admin.agent, ["sharer", "mate"], "Beta");
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
    expect(store.getLearnableSkill(mate.userId, share.id)?.id).toBe(share.id);
    store.blockSharedSkillInGroup(otherGroupId, sharer.userId, "pptx-report", admin.userId);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);

    // Blocking one skill never touches the owner's OTHER shares.
    store.shareSkill(sharer.userId, {
      skillName: "code-review",
      displayName: "code-review",
      description: "",
    });
    expect(store.listLearnableSkills(mate.userId).map((s) => s.skillName)).toEqual([
      "code-review",
    ]);

    // Unblocking both restores it.
    expect(store.unblockSharedSkillInGroup(groupId, sharer.userId, "pptx-report")).toBe(true);
    expect(store.unblockSharedSkillInGroup(groupId, sharer.userId, "pptx-report")).toBe(false);
    store.unblockSharedSkillInGroup(otherGroupId, sharer.userId, "pptx-report");
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(2);
  });

  it("a block survives unshare→re-share (keyed by skill name, not row id)", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"]);
    const first = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });
    store.blockSharedSkillInGroup(groupId, sharer.userId, "pptx-report", admin.userId);

    store.unshareSkill(sharer.userId, "pptx-report");
    const second = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });
    expect(second.id).not.toBe(first.id); // a genuinely new row
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    expect(store.getLearnableSkill(mate.userId, second.id)).toBeNull();
  });

  it("lists a group's shares with blocked flags, and cascades blocks on delete", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const outsider = await newUser(app, "outsider");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });
    store.shareSkill(outsider.userId, {
      skillName: "not-in-group",
      displayName: "not-in-group",
      description: "",
    });
    store.recordSkillLearn(sharer.userId, "pptx-report", mate.userId);
    store.blockSharedSkillInGroup(groupId, sharer.userId, "pptx-report", admin.userId);

    // Members' shares only — a non-member's share is outside this admin's reach.
    const listed = store.listGroupSharedSkills(groupId);
    expect(listed.map((s) => s.skillName)).toEqual(["pptx-report"]);
    expect(listed[0].blocked).toBe(true);
    expect(listed[0].learnCount).toBe(1);
    expect(listed[0].owner.username).toBe("sharer");
    // Blocked rows stay listed — that's how an admin lifts the block.
    store.unblockSharedSkillInGroup(groupId, sharer.userId, "pptx-report");
    expect(store.listGroupSharedSkills(groupId)[0].blocked).toBe(false);

    // Deleting the group takes its blocks with it (they only ever meant
    // "not through THIS group"), so a rebuilt group starts clean.
    store.blockSharedSkillInGroup(groupId, sharer.userId, "pptx-report", admin.userId);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
    store.deleteGroup(groupId);
    const rebuilt = await shareGroup(admin.agent, ["sharer", "mate"], "Rebuilt");
    expect(store.listGroupSharedSkills(rebuilt)[0].blocked).toBe(false);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
  });

  it("deleteUser purges blocks on the deleted OWNER's shares", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const groupId = await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });
    store.blockSharedSkillInGroup(groupId, sharer.userId, "pptx-report", admin.userId);
    store.deleteUser(sharer.userId);
    expect(store.listGroupSharedSkills(groupId)).toHaveLength(0);

    // A same-named share from a DIFFERENT owner is unaffected by the purge.
    store.addGroupMember(groupId, mate.userId);
    store.shareSkill(mate.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "",
    });
    expect(store.listGroupSharedSkills(groupId)[0].blocked).toBe(false);
  });

  it("renameSharedSkill moves the row, its history, and its blocks in one step", () => {
    const { store } = bootstrap();
    const share = store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "old",
      contentHash: "h1",
    });
    store.setSharedSkillDescription("u1", "pptx-report", "우리 팀 보고서 덱 스킬");
    store.recordSkillLearn("u1", "pptx-report", "mate-1");
    store.recordSkillLearn("u1", "pptx-report", "mate-2");
    store.blockSharedSkillInGroup("g-1", "u1", "pptx-report", "admin-1");
    // An event orphaned by a DEAD share that once held the target name.
    store.recordSkillLearn("u1", "deck-maker", "mate-3");

    const moved = store.renameSharedSkill("u1", "pptx-report", "deck-maker", {
      displayName: "Deck maker",
      description: "new",
      contentHash: "h2",
      bumpUpdatedAt: true,
    })!;
    // Same share under a new name: id, created_at and the owner's 소개 문구 are
    // the row's identity, not its slug.
    expect(moved.id).toBe(share.id);
    expect(moved.createdAt).toBe(share.createdAt);
    expect(moved.customDescription).toBe("우리 팀 보고서 덱 스킬");
    expect(moved.skillName).toBe("deck-maker");
    expect(moved.snapshotDescription).toBe("new");
    expect(moved.contentHash).toBe("h2");
    expect(moved.previousNames).toEqual(["pptx-report"]);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(1);
    // The 전수 count follows the rename, and the dead share's orphan under the
    // taken name is dropped rather than left to inflate this skill's count.
    expect(store.skillLearnCounts("u1")).toEqual({ "deck-maker": 2 });
    // A group admin's block follows AND stays on the name the rename freed:
    // blocks are name-keyed anti-evasion (they already survive unshare→
    // re-share), so two renames must not clear one.
    expect(store.unblockSharedSkillInGroup("g-1", "u1", "deck-maker")).toBe(true);
    expect(store.unblockSharedSkillInGroup("g-1", "u1", "pptx-report")).toBe(true);
  });

  it("renameSharedSkill refuses a taken target and leaves everything untouched", () => {
    const { store } = bootstrap();
    store.shareSkill("u1", { skillName: "a", displayName: "a", description: "A" });
    const taken = store.shareSkill("u1", { skillName: "b", displayName: "b", description: "B" });
    store.recordSkillLearn("u1", "a", "mate-1");
    store.blockSharedSkillInGroup("g-1", "u1", "a");

    expect(
      store.renameSharedSkill("u1", "a", "b", {
        displayName: "b",
        description: "B2",
        contentHash: "h",
        bumpUpdatedAt: true,
      }),
    ).toBeNull();
    // No half-applied transaction: rows, counts and blocks are exactly as before.
    const rows = store.listSharedSkillsByOwner("u1");
    expect(rows.map((s) => s.skillName)).toEqual(["a", "b"]);
    expect(rows.map((s) => s.snapshotDescription)).toEqual(["A", "B"]);
    expect(rows.find((s) => s.skillName === "b")!.id).toBe(taken.id);
    expect(store.skillLearnCounts("u1")).toEqual({ a: 1 });
    expect(store.unblockSharedSkillInGroup("g-1", "u1", "a")).toBe(true);
    // A row that doesn't exist is refused the same way.
    expect(
      store.renameSharedSkill("u1", "ghost", "c", {
        displayName: "c",
        description: "",
        contentHash: null,
        bumpUpdatedAt: true,
      }),
    ).toBeNull();
  });

  it("keeps the rename trail capped, deduped, and free of the current name", () => {
    const { store } = bootstrap();
    const rename = (owner: string, from: string, to: string) =>
      store.renameSharedSkill(owner, from, to, {
        displayName: to,
        description: "",
        contentHash: null,
        bumpUpdatedAt: true,
      });

    // Seven renames, trail of five: the oldest names fall off the front,
    // most-recent last.
    store.shareSkill("u1", { skillName: "n0", displayName: "n0", description: "" });
    for (let i = 1; i <= 7; i += 1) {
      expect(rename("u1", `n${i - 1}`, `n${i}`)).not.toBeNull();
    }
    expect(store.listSharedSkillsByOwner("u1")[0].previousNames).toEqual([
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
    ]);

    // a → b → a: the trail must never contain the name the row now carries.
    store.shareSkill("u2", { skillName: "a", displayName: "a", description: "" });
    rename("u2", "a", "b");
    rename("u2", "b", "a");
    expect(store.listSharedSkillsByOwner("u2")[0].previousNames).toEqual(["b"]);
  });

  it("deleteUser cascades the owner's share rows", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(1);
    store.deleteUser(sharer.userId);
    expect(store.listLearnableSkills(mate.userId)).toHaveLength(0);
  });
});

// ---- skillTransfer.ts --------------------------------------------------------

describe("skillTransfer", () => {
  it("normalizes slugs the way scaffold_skill does", () => {
    expect(normalizeSkillSlug("My Cool Skill!")).toBe("my-cool-skill");
    expect(normalizeSkillSlug("  -weird-  ")).toBe("weird");
  });

  it("hashes a skill dir deterministically, ignoring the origin marker", () => {
    const root = path.join(tempDir, "hash-repo");
    fs.mkdirSync(path.join(root, "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), SKILL_MD);
    const first = hashSkillDir(root, "s");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSkillDir(root, "s")).toBe(first);
    // The marker must be invisible to the fingerprint on BOTH sides of every
    // comparison: source-vs-copy (update detection) and copy-vs-localHash
    // (customization detection).
    fs.writeFileSync(path.join(root, "skills", "s", ".noah-skill-origin.json"), "{}");
    expect(hashSkillDir(root, "s")).toBe(first);
    fs.writeFileSync(path.join(root, "skills", "s", "SKILL.md"), `${SKILL_MD}\nmore`);
    expect(hashSkillDir(root, "s")).not.toBe(first);
    expect(hashSkillDir(root, "missing")).toBeNull();
  });

  it("lists skills/<slug>/SKILL.md with frontmatter metadata", () => {
    const root = path.join(tempDir, "repo");
    fs.mkdirSync(path.join(root, "skills", "b-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "a-skill"), { recursive: true });
    fs.mkdirSync(path.join(root, "skills", "not-a-skill"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "a-skill", "SKILL.md"), SKILL_MD);
    fs.writeFileSync(path.join(root, "skills", "b-skill", "SKILL.md"), "no frontmatter");
    const skills = listRepoSkills(root);
    expect(skills.map((s) => s.slug)).toEqual(["a-skill", "b-skill"]);
    expect(skills[0].name).toBe("pptx-report"); // frontmatter wins
    expect(skills[0].description).toBe("Weekly report deck generator");
    expect(skills[1].name).toBe("b-skill"); // dir-name fallback
  });

  it("never follows a link out of the repo: a linked skills/, skill dir, SKILL.md or origin marker reads as absent (review R8)", async () => {
    // The victim: another user's clone next door, with a private skill and a learned-copy marker.
    const victim = path.join(tempDir, "link-victim");
    writeSkills(victim, {
      "secret-skill": {
        "SKILL.md": skillMd("secret-skill", "TOP SECRET plan"),
        ".noah-skill-origin.json": JSON.stringify({
          ownerUserId: "u-victim",
          ownerUsername: "victim",
          skillName: "private-thing",
          contentHash: null,
          localHash: null,
          learnedAt: "",
        }),
      },
    });
    const dest = path.join(tempDir, "link-dest");
    fs.mkdirSync(dest, { recursive: true });

    // 1. A pushed `skills -> ../link-victim/skills`.
    const whole = path.join(tempDir, "link-whole");
    fs.mkdirSync(whole, { recursive: true });
    fs.symlinkSync("../link-victim/skills", path.join(whole, "skills"));
    expect(fs.readdirSync(path.join(whole, "skills"))).toEqual(["secret-skill"]); // the link is live
    expect(listRepoSkills(whole)).toEqual([]);
    expect(readRepoSkill(whole, "secret-skill")).toBeNull();
    expect(readSkillOrigin(whole, "secret-skill")).toBeNull();
    expect(hashSkillDir(whole, "secret-skill")).toBeNull();
    expect(listSkillFiles(whole, "secret-skill").files).toEqual([]);
    await expect(copySkillDir(whole, "secret-skill", dest, "x")).rejects.toThrow("SKILL_NOT_FOUND");

    // 2. A real skills/ holding a linked skill dir, a linked SKILL.md and a linked marker.
    const parts = path.join(tempDir, "link-parts");
    writeSkills(parts, { own: { "SKILL.md": skillMd("own", "mine") } });
    fs.symlinkSync("../../link-victim/skills/secret-skill", path.join(parts, "skills", "linked-dir"));
    fs.mkdirSync(path.join(parts, "skills", "linked-md"));
    fs.symlinkSync("../../../link-victim/skills/secret-skill/SKILL.md", path.join(parts, "skills", "linked-md", "SKILL.md"));
    fs.symlinkSync(
      "../../../link-victim/skills/secret-skill/.noah-skill-origin.json",
      path.join(parts, "skills", "own", ".noah-skill-origin.json"),
    );
    expect(listRepoSkills(parts)).toEqual([{ slug: "own", name: "own", description: "mine" }]);
    expect(JSON.stringify(listRepoSkills(parts))).not.toContain("TOP SECRET");
    expect(readSkillOrigin(parts, "own")).toBeNull();
    expect(readSkillOrigin(parts, "linked-dir")).toBeNull();
    await expect(copySkillDir(parts, "linked-md", dest, "y")).rejects.toThrow("SKILL_NOT_FOUND");
    // The real skill still reads, hashes and copies.
    expect(hashSkillDir(parts, "own")).toMatch(/^[0-9a-f]{64}$/);
    expect((await copySkillDir(parts, "own", dest, "own")).files).toBe(1);
  });

  it("lists the files a learn would copy (tree, no symlinks, SKILL.md-only)", () => {
    const root = path.join(tempDir, "manifest-repo");
    fs.mkdirSync(path.join(root, "skills", "solo"), { recursive: true });
    fs.writeFileSync(path.join(root, "skills", "solo", "SKILL.md"), SKILL_MD);
    // A one-file skill: the preview has nothing more to say than the summary.
    const solo = listSkillFiles(root, "solo");
    expect(solo.files).toEqual([{ path: "SKILL.md", bytes: Buffer.byteLength(SKILL_MD) }]);
    expect(solo.totalBytes).toBe(Buffer.byteLength(SKILL_MD));
    expect(solo.truncated).toBe(false);

    // A real skill is a TREE — nested aux files ride along on a learn, symlinks
    // never do (copySkillDir skips them), so the manifest must agree.
    const dir = path.join(root, "skills", "full");
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD);
    fs.writeFileSync(path.join(dir, "scripts", "render.sh"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(dir, "templates", "deck.md"), "x".repeat(40));
    fs.symlinkSync("/etc/hostname", path.join(dir, "evil-link"));
    const full = listSkillFiles(root, "full");
    expect(full.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "scripts/render.sh",
      "templates/deck.md",
    ]);
    expect(full.files.find((f) => f.path === "templates/deck.md")?.bytes).toBe(40);
    expect(full.totalBytes).toBe(full.files.reduce((sum, f) => sum + f.bytes, 0));
    expect(full.truncated).toBe(false);
    // A missing dir is an empty manifest, never an error.
    expect(listSkillFiles(root, "nope")).toEqual({ files: [], totalBytes: 0, truncated: false });
  });

  it("flags a manifest cut off at the transfer file cap", () => {
    const root = path.join(tempDir, "many-files-repo");
    const dir = path.join(root, "skills", "many");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), SKILL_MD);
    for (let i = 0; i < 210; i += 1) {
      fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
    }
    const manifest = listSkillFiles(root, "many");
    expect(manifest.files).toHaveLength(200); // MAX_SKILL_FILES
    expect(manifest.truncated).toBe(true);
    // The same tree can't transfer at all — the honest partial listing lines up
    // with the refusal a learn would hit.
    expect(hashSkillDir(root, "many")).toBeNull();
  });

  it("copies a skill dir with guards (exists/missing/symlink/oversize)", async () => {
    const src = path.join(tempDir, "src-repo");
    const dest = path.join(tempDir, "dest-repo");
    fs.mkdirSync(path.join(src, "skills", "s", "nested"), { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, "skills", "s", "SKILL.md"), SKILL_MD);
    fs.writeFileSync(path.join(src, "skills", "s", "nested", "x.txt"), "x");
    fs.symlinkSync("/etc/hostname", path.join(src, "skills", "s", "evil-link"));

    const stats = await copySkillDir(src, "s", dest, "s");
    expect(stats.files).toBe(2);
    expect(stats.skippedSymlinks).toBe(1);
    expect(fs.existsSync(path.join(dest, "skills", "s", "nested", "x.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "skills", "s", "evil-link"))).toBe(false);

    await expect(copySkillDir(src, "s", dest, "s")).rejects.toThrow("SKILL_EXISTS");
    await expect(copySkillDir(src, "missing", dest, "m")).rejects.toThrow("SKILL_NOT_FOUND");
    await expect(copySkillDir(src, "../s", dest, "t")).rejects.toThrow("INVALID_NAME");

    fs.writeFileSync(path.join(src, "skills", "s", "big.bin"), Buffer.alloc(512 * 1024 + 1));
    await expect(copySkillDir(src, "s", dest, "s2")).rejects.toThrow("SKILL_FILE_TOO_LARGE");
  });

  it("learns end-to-end: copy, identity rewrite, manifest, commit+push", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;

    const result = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      sharerUsername: "sharer",
      commitMessage: "Learn skill",
      identity: { name: "Learner", email: "l@example.com" },
    });
    expect(result.slug).toBe("pptx-report");
    expect(result.committed).toBe(true);
    expect(result.needsSelection).toBe(false);

    const learnerRoot = await ensureClone(learnerCtx);
    expect(fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report", "SKILL.md"), "utf8")).toContain(
      "Make the deck.",
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(learnerRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { plugins: { name: string; source: string }[] };
    expect(manifest.plugins).toContainEqual({ name: "pptx-report", source: "./skills/pptx-report" });
    // plugin.json is created when the source skill lacked one (loadability).
    const pluginJson = JSON.parse(
      fs.readFileSync(
        path.join(learnerRoot, "skills", "pptx-report", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { name: string };
    expect(pluginJson.name).toBe("pptx-report");
    // The commit reached the learner's REMOTE (persistence, not just the clone).
    const remoteLog = execFileSync(
      "git",
      ["-C", path.join(tempDir, "learner-repo.git"), "log", "--oneline", "main"],
      { stdio: "pipe" },
    ).toString();
    expect(remoteLog).toContain("Learn skill");

    // Provenance marker: who it came from + the SOURCE hash at learn time.
    const origin = readSkillOrigin(learnerRoot, "pptx-report");
    expect(origin?.ownerUserId).toBe(sharer.userId);
    expect(origin?.ownerUsername).toBe("sharer");
    expect(origin?.skillName).toBe("pptx-report");
    expect(origin?.contentHash).toBe(result.contentHash);

    // Renamed learn rewrites the SKILL.md frontmatter name + plugin.json name.
    const renamed = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      newName: "My Deck Skill",
      sharerUsername: "sharer",
      commitMessage: "Learn skill again",
      identity: { name: "Learner", email: "l@example.com" },
    });
    expect(renamed.slug).toBe("my-deck-skill");
    const renamedMd = fs.readFileSync(
      path.join(learnerRoot, "skills", "my-deck-skill", "SKILL.md"),
      "utf8",
    );
    expect(renamedMd).toContain("name: my-deck-skill");
    const renamedPlugin = JSON.parse(
      fs.readFileSync(
        path.join(learnerRoot, "skills", "my-deck-skill", ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { name: string };
    expect(renamedPlugin.name).toBe("my-deck-skill");
  });

  it("updates a learned copy in place, gated on the origin marker", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
        // A hand-made skill with NO origin marker — update must refuse it.
        "skills/handmade/SKILL.md": "---\nname: handmade\n---\n",
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;
    const identity = { name: "Learner", email: "l@example.com" };

    const first = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      newName: "my-copy",
      sharerUsername: "sharer",
      commitMessage: "Learn",
      identity,
    });
    expect(first.updated).toBe(false);

    // The sharer ships a new version; updating replaces the learner's copy and
    // records the NEW source hash.
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    const updated = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      updateSlug: "my-copy",
      sharerUsername: "sharer",
      commitMessage: "Update",
      identity,
    });
    expect(updated.updated).toBe(true);
    expect(updated.slug).toBe("my-copy");
    expect(updated.contentHash).not.toBe(first.contentHash);
    const learnerRoot = await ensureClone(learnerCtx);
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "my-copy", "SKILL.md"), "utf8"),
    ).toContain("## v2");
    expect(readSkillOrigin(learnerRoot, "my-copy")?.contentHash).toBe(updated.contentHash);

    // No origin marker (or a mismatched one) → fail closed, nothing replaced.
    await expect(
      learnSkillIntoRepo({
        sharerCtx,
        learnerCtx,
        skillName: "pptx-report",
        updateSlug: "handmade",
        sharerUsername: "sharer",
        commitMessage: "Update",
        identity,
      }),
    ).rejects.toThrow("NOT_LEARNED_FROM_SHARE");
    expect(fs.existsSync(path.join(learnerRoot, "skills", "handmade", "SKILL.md"))).toBe(true);
  });

  it("updates a NAMED copy even when two copies carry the share's current name", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;
    const identity = { name: "Learner", email: "l@example.com" };

    // Learn twice — the second under new_name — so BOTH markers carry the
    // share's CURRENT name. An exact marker on the slug the caller named is
    // proof by itself: the caller already picked the copy, so the sibling must
    // not turn a legitimate in-place update into "ambiguous" (only TRAIL
    // matches need the repo-wide unique-answer rule).
    await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      sharerUsername: "sharer",
      commitMessage: "Learn",
      identity,
    });
    await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      newName: "pptx-report-tweaked",
      sharerUsername: "sharer",
      commitMessage: "Learn again",
      identity,
    });

    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    const updated = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      updateSlug: "pptx-report-tweaked",
      sharerUsername: "sharer",
      commitMessage: "Update",
      identity,
    });
    expect(updated.updated).toBe(true);
    expect(updated.slug).toBe("pptx-report-tweaked");
    const learnerRoot = await ensureClone(learnerCtx);
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report-tweaked", "SKILL.md"), "utf8"),
    ).toContain("## v2");
    // The sibling copy is untouched by updating the named one.
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).not.toContain("## v2");
  });

  it("protects a customized copy: update refuses without allowModified", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      learner.userId,
      seedRemote("learner-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "l", plugins: [] }),
      }),
      "main",
    );
    const sharerCtx = knowledgeRepoContextFor(store, sharer.userId, config)!;
    const learnerCtx = knowledgeRepoContextFor(store, learner.userId, config)!;
    const identity = { name: "Learner", email: "l@example.com" };
    await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      sharerUsername: "sharer",
      commitMessage: "Learn",
      identity,
    });

    // The learner customizes their copy; the sharer ships v2.
    customizeLearnedCopy(learner.userId, "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## custom\n`);
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);

    const update = () =>
      learnSkillIntoRepo({
        sharerCtx,
        learnerCtx,
        skillName: "pptx-report",
        updateSlug: "pptx-report",
        sharerUsername: "sharer",
        commitMessage: "Update",
        identity,
      });
    await expect(update()).rejects.toThrow("SKILL_LOCALLY_MODIFIED");
    const learnerRoot = await ensureClone(learnerCtx);
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## custom");

    // Explicit consent replaces the customization with the sharer's version.
    const forced = await learnSkillIntoRepo({
      sharerCtx,
      learnerCtx,
      skillName: "pptx-report",
      updateSlug: "pptx-report",
      allowModified: true,
      sharerUsername: "sharer",
      commitMessage: "Update",
      identity,
    });
    expect(forced.updated).toBe(true);
    expect(
      fs.readFileSync(path.join(learnerRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v2");

    // A legacy marker without localHash cannot prove the copy is pristine —
    // fail safe: consent required there too.
    const markerPath = path.join(learnerRoot, "skills", "pptx-report", ".noah-skill-origin.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    delete marker.localHash;
    fs.writeFileSync(markerPath, JSON.stringify(marker));
    customizeLearnedCopy(learner.userId, "skills/pptx-report/.noah-skill-origin.json", JSON.stringify(marker));
    await expect(update()).rejects.toThrow("SKILL_LOCALLY_MODIFIED");
  });
});

// ---- skillTransfer: reconciling shares with the working tree ------------------

describe("shared-skill reconciliation", () => {
  /** Share `slug` with the tree's current metadata + fingerprint. */
  function share(
    store: ReturnType<typeof bootstrap>["store"],
    root: string,
    owner: string,
    slug: string,
  ) {
    const skill = readRepoSkill(root, slug)!;
    return store.shareSkill(owner, {
      skillName: skill.slug,
      displayName: skill.name,
      description: skill.description,
      contentHash: hashSkillDir(root, slug),
    });
  }

  it("re-snapshots drift in place and leaves the owner's 소개 문구 alone", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-drift", {
      "pptx-report": { "SKILL.md": skillMd("pptx-report", "v1") },
    });
    const before = share(store, root, "u1", "pptx-report");
    store.setSharedSkillDescription("u1", "pptx-report", "제가 쓰는 보고서 스킬이에요");

    fs.writeFileSync(
      path.join(root, "skills", "pptx-report", "SKILL.md"),
      skillMd("Deck maker", "v2"),
    );
    expect(await reconcileOwnerSharedSkills(store, root, "u1")).toEqual({
      resnapshotted: ["pptx-report"],
      renamed: [],
      unshared: [],
      drained: [],
    });
    const row = store.listSharedSkillsByOwner("u1")[0];
    expect(row.id).toBe(before.id);
    expect(row.displayName).toBe("Deck maker");
    expect(row.snapshotDescription).toBe("v2");
    expect(row.contentHash).toBe(hashSkillDir(root, "pptx-report"));
    // The frontmatter is a snapshot; the human-facing introduction is not.
    expect(row.customDescription).toBe("제가 쓰는 보고서 스킬이에요");
    expect(row.description).toBe("제가 쓰는 보고서 스킬이에요");

    // Settled: a second pass finds nothing to do (no re-sorting on every load).
    expect((await reconcileOwnerSharedSkills(store, root, "u1")).resnapshotted).toEqual([]);
  });

  it("treats an unhashable tree as unknown rather than as drift", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-nullhash", {
      big: { "SKILL.md": skillMd("big", "v1") },
    });
    const before = share(store, root, "u1", "big");
    expect(before.contentHash).not.toBeNull();
    // Past the per-file transfer cap — hashSkillDir can no longer fingerprint it.
    fs.writeFileSync(path.join(root, "skills", "big", "blob.bin"), "x".repeat(600 * 1024));
    expect(hashSkillDir(root, "big")).toBeNull();

    // A null hash is UNKNOWN, not "changed". Re-snapshotting would store nothing
    // (shareSkill COALESCEs it away) and re-fire on every pass — the avatar
    // announcing a share change after every commit, teammates' 탐색 re-sorting.
    expect((await reconcileOwnerSharedSkills(store, root, "u1")).resnapshotted).toEqual([]);
    expect((await reconcileOwnerSharedSkills(store, root, "u1")).resnapshotted).toEqual([]);
    expect(store.listSharedSkillsByOwner("u1")[0].contentHash).toBe(before.contentHash);
  });

  it("unshares a deleted directory and drains one that became a learned copy", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-gone", {
      gone: { "SKILL.md": skillMd("gone", "d") },
      learned: { "SKILL.md": skillMd("learned", "d") },
    });
    share(store, root, "u1", "gone");
    share(store, root, "u1", "learned");
    store.recordSkillLearn("u1", "gone", "mate-1");
    fs.rmSync(path.join(root, "skills", "gone"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "skills", "learned", ".noah-skill-origin.json"),
      ORIGIN_MARKER,
    );

    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.unshared).toEqual(["gone"]);
    expect(result.drained).toEqual(["learned"]);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(0);
    // Learn history is keyed by (owner, skill name) and outlives the row.
    expect(store.skillLearnCounts("u1")).toEqual({ gone: 1 });
  });

  it("follows a committed directory rename, carrying the row along", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-move", {
      "pptx-report": {
        "SKILL.md": skillMd("pptx-report", "v1"),
        "scripts/render.sh": "#!/bin/sh\n",
      },
    });
    const before = share(store, root, "u1", "pptx-report");
    store.setSharedSkillDescription("u1", "pptx-report", "덱 만들어 드려요");
    store.recordSkillLearn("u1", "pptx-report", "mate-1");
    store.blockSharedSkillInGroup("g-1", "u1", "pptx-report");

    moveTreeSkill(root, "pptx-report", "deck-maker");
    commitTree(root, "rename the deck skill");
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([{ from: "pptx-report", to: "deck-maker" }]);
    expect(result.unshared).toEqual([]);

    const row = store.listSharedSkillsByOwner("u1")[0];
    expect(row.id).toBe(before.id);
    expect(row.createdAt).toBe(before.createdAt);
    expect(row.customDescription).toBe("덱 만들어 드려요");
    expect(row.skillName).toBe("deck-maker");
    expect(row.previousNames).toEqual(["pptx-report"]);
    // The hash is unchanged BY DESIGN — hashSkillDir digests relative paths and
    // bytes, never the slug — which is what corroborates git's rename evidence.
    expect(row.contentHash).toBe(before.contentHash);
    expect(store.skillLearnCounts("u1")).toEqual({ "deck-maker": 1 });

    // A group admin's block follows the rename AND stays on the freed old name:
    // re-minting a share there is still blocked, so two `git mv`s are not a way
    // around the block.
    store.shareSkill("u1", {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    expect(store.unblockSharedSkillInGroup("g-1", "u1", "deck-maker")).toBe(true);
    expect(store.unblockSharedSkillInGroup("g-1", "u1", "pptx-report")).toBe(true);
  });

  it("follows a rename of a non-ASCII skill directory", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-hangul", {
      배포가이드: { "SKILL.md": skillMd("배포가이드", "배포 절차") },
    });
    share(store, root, "u1", "배포가이드");
    moveTreeSkill(root, "배포가이드", "배포가이드-v2");
    commitTree(root, "rename the deploy guide");

    // git QUOTES these paths in its default textual output; the evidence is read
    // NUL-delimited precisely so the slug survives the round trip.
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([{ from: "배포가이드", to: "배포가이드-v2" }]);
    expect(store.listSharedSkillsByOwner("u1")[0].skillName).toBe("배포가이드-v2");
  });

  it("follows a rename that also rewrote the skill, onto a fresh directory", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-edited", {
      "pptx-report": {
        "SKILL.md": skillMd("pptx-report", "v1"),
        "scripts/render.sh": "#!/bin/sh\n",
      },
    });
    share(store, root, "u1", "pptx-report");
    moveTreeSkill(root, "pptx-report", "deck-maker");
    fs.writeFileSync(
      path.join(root, "skills", "deck-maker", "SKILL.md"),
      skillMd("deck-maker", "v2"),
    );
    commitTree(root, "rename and rewrite");

    // The fingerprint matches nothing any more; what makes git's evidence safe
    // to follow here is that the target directory did not exist before.
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([{ from: "pptx-report", to: "deck-maker" }]);
    const row = store.listSharedSkillsByOwner("u1")[0];
    expect(row.skillName).toBe("deck-maker");
    expect(row.snapshotDescription).toBe("v2");
    expect(row.contentHash).toBe(hashSkillDir(root, "deck-maker"));
  });

  it("follows a rename the avatar has not committed yet, but not a deletion", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-uncommitted", {
      moved: { "SKILL.md": skillMd("moved", "v1") },
      dropped: { "SKILL.md": skillMd("dropped", "v2") },
    });
    share(store, root, "u1", "moved");
    share(store, root, "u1", "dropped");
    // move_file renames on disk and leaves it UNSTAGED; delete_file just removes.
    moveTreeSkill(root, "moved", "moved-v2");
    fs.rmSync(path.join(root, "skills", "dropped"), { recursive: true });

    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([{ from: "moved", to: "moved-v2" }]);
    expect(result.unshared).toEqual(["dropped"]);
    expect(store.listSharedSkillsByOwner("u1").map((s) => s.skillName)).toEqual(["moved-v2"]);
  });

  it("does not read one auxiliary file moving between two skills as a rename", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-aux", {
      donor: { "SKILL.md": skillMd("donor", "A"), "shared-notes.md": "notes\n" },
      taker: { "SKILL.md": skillMd("taker", "B") },
    });
    const before = share(store, root, "u1", "donor");
    fs.renameSync(
      path.join(root, "skills", "donor", "shared-notes.md"),
      path.join(root, "skills", "taker", "shared-notes.md"),
    );
    commitTree(root, "move the notes over");

    // git reports a rename UNDER skills/donor/, but donor's SKILL.md never
    // moved: the directory is still there, so only its fingerprint changed.
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([]);
    expect(result.unshared).toEqual([]);
    expect(result.resnapshotted).toEqual(["donor"]);
    const row = store.listSharedSkillsByOwner("u1")[0];
    expect(row.id).toBe(before.id);
    expect(row.skillName).toBe("donor");
  });

  it("refuses a rename that consolidates into a pre-existing directory", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-consolidate", {
      shared: { "SKILL.md": skillMd("shared", "published") },
      private: { "SKILL.md": skillMd("private", "mine"), "notes.md": "internal\n" },
    });
    share(store, root, "u1", "shared");
    // git reports this as a rename, but the destination EXISTED and holds
    // content that was never published — following it would share `private`.
    gitIn(root)("mv", "-f", "skills/shared/SKILL.md", "skills/private/SKILL.md");
    commitTree(root, "consolidate the skills");

    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([]);
    expect(result.unshared).toEqual(["shared"]);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(0);
  });

  it("revokes a deleted share even when an identical directory exists", async () => {
    const { store } = bootstrap();
    const twin = { "SKILL.md": skillMd("pptx-report", "v1"), "render.sh": "#!/bin/sh\n" };
    const root = makeRepo("recon-twin", { "pptx-report": { ...twin }, "deck-copy": { ...twin } });
    share(store, root, "u1", "pptx-report");
    gitIn(root)("rm", "-r", "-q", "skills/pptx-report");
    commitTree(root, "delete the shared skill");

    // Deleting is a REVOKE: the byte-identical sibling is not a new home for it.
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.unshared).toEqual(["pptx-report"]);
    expect(result.renamed).toEqual([]);
    expect(store.listSharedSkillsByOwner("u1")).toHaveLength(0);
    expect(listRepoSkills(root).map((s) => s.slug)).toEqual(["deck-copy"]);
  });

  it("resolves a swap committed in one step", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-swap", {
      alpha: { "SKILL.md": skillMd("alpha", "A"), "a.md": "aaa\n" },
      beta: { "SKILL.md": skillMd("beta", "B"), "b.md": "bbb\n" },
    });
    const alpha = share(store, root, "u1", "alpha");
    const beta = share(store, root, "u1", "beta");
    // `alpha` moves aside and `beta` takes over its name in ONE commit, so the
    // old name is still a directory afterwards — holding foreign content.
    moveTreeSkill(root, "alpha", "gamma");
    moveTreeSkill(root, "beta", "alpha");
    commitTree(root, "swap the skills");

    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([
      { from: "alpha", to: "gamma" },
      { from: "beta", to: "alpha" },
    ]);
    expect(result.unshared).toEqual([]);
    const rows = new Map(store.listSharedSkillsByOwner("u1").map((row) => [row.skillName, row]));
    expect(rows.get("gamma")!.id).toBe(alpha.id);
    expect(rows.get("alpha")!.id).toBe(beta.id);
    expect(rows.get("gamma")!.contentHash).toBe(hashSkillDir(root, "gamma"));
    expect(rows.get("alpha")!.contentHash).toBe(hashSkillDir(root, "alpha"));
  });

  it("re-snapshots in place when a swap left both directories standing", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-exchange", {
      alpha: { "SKILL.md": skillMd("alpha", "A") },
      beta: { "SKILL.md": skillMd("beta", "B") },
    });
    const alpha = share(store, root, "u1", "alpha");
    const beta = share(store, root, "u1", "beta");
    moveTreeSkill(root, "alpha", "tmp");
    moveTreeSkill(root, "beta", "alpha");
    moveTreeSkill(root, "tmp", "beta");
    commitTree(root, "exchange the two contents");

    // Both paths survive, so git records EDITS, not renames: with no rename to
    // follow neither row moves, and each simply re-snapshots the directory it
    // still names. Presence alone never carries a row somewhere else.
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([]);
    expect(result.unshared).toEqual([]);
    expect([...result.resnapshotted].sort()).toEqual(["alpha", "beta"]);
    const rows = new Map(store.listSharedSkillsByOwner("u1").map((row) => [row.skillName, row]));
    expect(rows.get("alpha")!.id).toBe(alpha.id);
    expect(rows.get("beta")!.id).toBe(beta.id);
    expect(rows.get("alpha")!.displayName).toBe("beta");
  });

  it("never moves a share onto a name another live share still holds", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-taken", {
      old: { "SKILL.md": skillMd("old", "A"), "a.md": "aaa\n" },
      live: { "SKILL.md": skillMd("live", "B") },
    });
    share(store, root, "u1", "old");
    const live = share(store, root, "u1", "live");
    store.setSharedSkillDescription("u1", "live", "이건 계속 공유 중이에요");
    // One commit drops the shared `live` directory and moves `old` onto its
    // name. Merging the rows would silently pick one row's introduction and
    // learn history over the other's, so the moving row unshares instead.
    fs.rmSync(path.join(root, "skills", "live"), { recursive: true });
    moveTreeSkill(root, "old", "live");
    commitTree(root, "reuse the name");

    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([]);
    expect(result.unshared).toEqual(["old"]);
    const rows = store.listSharedSkillsByOwner("u1");
    expect(rows.map((row) => row.skillName)).toEqual(["live"]);
    expect(rows[0].id).toBe(live.id);
    expect(rows[0].customDescription).toBe("이건 계속 공유 중이에요");
    expect(rows[0].previousNames).toEqual([]);
  });

  it("does nothing when the clone has no .git (a repo mid-rebuild)", async () => {
    const { store } = bootstrap();
    const root = makeTree("recon-nogit", {
      "pptx-report": { "SKILL.md": skillMd("pptx-report", "v1") },
    });
    const before = share(store, root, "u1", "pptx-report");
    // ensureClone removes the whole clone before re-cloning a repointed repo;
    // catching it mid-flight must never read as "every share was deleted".
    fs.rmSync(path.join(root, "skills"), { recursive: true });

    expect(await reconcileOwnerSharedSkills(store, root, "u1")).toEqual({
      resnapshotted: [],
      renamed: [],
      unshared: [],
      drained: [],
    });
    expect(store.listSharedSkillsByOwner("u1")[0].id).toBe(before.id);
  });

  it("drops learn events orphaned under the name a rename takes over", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-orphans", {
      "pptx-report": { "SKILL.md": skillMd("pptx-report", "v1") },
    });
    share(store, root, "u1", "pptx-report");
    store.recordSkillLearn("u1", "pptx-report", "mate-1");
    // A DEAD share once lived under the name this rename is about to take.
    store.recordSkillLearn("u1", "deck-maker", "mate-2");
    store.recordSkillLearn("u1", "deck-maker", "mate-3");

    moveTreeSkill(root, "pptx-report", "deck-maker");
    commitTree(root, "rename onto a retired name");
    expect((await reconcileOwnerSharedSkills(store, root, "u1")).renamed).toEqual([
      { from: "pptx-report", to: "deck-maker" },
    ]);
    // Counted by NAME, so the dead share's events would inflate this skill's
    // 전수 count forever.
    expect(store.skillLearnCounts("u1")).toEqual({ "deck-maker": 1 });
  });

  it("never adopts a learned copy as the new home of a share", async () => {
    const { store } = bootstrap();
    const root = makeRepo("recon-marker", {
      "pptx-report": { "SKILL.md": skillMd("pptx-report", "v1") },
    });
    share(store, root, "u1", "pptx-report");
    moveTreeSkill(root, "pptx-report", "borrowed");
    // The target now claims to have been learned from somebody else.
    fs.writeFileSync(
      path.join(root, "skills", "borrowed", ".noah-skill-origin.json"),
      ORIGIN_MARKER,
    );
    commitTree(root, "rename into a learned copy");
    const result = await reconcileOwnerSharedSkills(store, root, "u1");
    expect(result.renamed).toEqual([]);
    expect(result.unshared).toEqual(["pptx-report"]);
  });

  it("commit reconciles the owner's shares and says so in the tool result", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const owner = await newUser(app, "owner");
    store.setKnowledgeRepo(owner.userId, seedSkillRemote("owner-repo"), "main");
    store.setGitToken(owner.userId, "tok"); // commit gate; a file remote ignores it
    const ctx = knowledgeRepoContextFor(store, owner.userId, config)!;
    const root = await ensureClone(ctx);
    const before = share(store, root, owner.userId, "pptx-report");
    store.setSharedSkillDescription(owner.userId, "pptx-report", "덱 만들어 드려요");
    const tools = buildRepoTools(store, {
      avatarUserId: owner.userId,
      owner: { id: owner.userId, username: "owner", displayName: "Owner" },
      viewerIsOwner: true,
      config,
    });

    // Rename AND edit in one commit — only git's -M detection can see this.
    execFileSync("git", ["-C", root, "mv", "skills/pptx-report", "skills/deck-maker"], {
      stdio: "pipe",
    });
    fs.writeFileSync(
      path.join(root, "skills", "deck-maker", "SKILL.md"),
      skillMd("deck-maker", "v2"),
    );
    const res = await callTool(tools, "commit", { message: "rename the deck skill" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Committed and pushed the changes");
    expect(res.content[0].text).toContain("the share follows the rename pptx-report → deck-maker");

    const row = store.listSharedSkillsByOwner(owner.userId)[0];
    expect(row.id).toBe(before.id);
    expect(row.skillName).toBe("deck-maker");
    expect(row.previousNames).toEqual(["pptx-report"]);
    expect(row.customDescription).toBe("덱 만들어 드려요");
    expect(row.contentHash).toBe(hashSkillDir(root, "deck-maker"));
  });

  it("reports a plain fingerprint refresh, and never fails a commit on reconcile trouble", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const owner = await newUser(app, "owner");
    store.setKnowledgeRepo(owner.userId, seedSkillRemote("owner-repo"), "main");
    store.setGitToken(owner.userId, "tok");
    const ctx = knowledgeRepoContextFor(store, owner.userId, config)!;
    const root = await ensureClone(ctx);
    share(store, root, owner.userId, "pptx-report");
    const tools = buildRepoTools(store, {
      avatarUserId: owner.userId,
      owner: { id: owner.userId, username: "owner", displayName: "Owner" },
      viewerIsOwner: true,
      config,
    });

    fs.writeFileSync(
      path.join(root, "skills", "pptx-report", "SKILL.md"),
      skillMd("pptx-report", "v2"),
    );
    const refreshed = await callTool(tools, "commit", { message: "edit the deck skill" });
    expect(refreshed.content[0].text).toContain("refreshed the shared fingerprint of 1 skill(s)");
    expect(store.listSharedSkillsByOwner(owner.userId)[0].contentHash).toBe(
      hashSkillDir(root, "pptx-report"),
    );

    // The push already happened: a broken reconciliation must never turn a
    // successful commit into a failed tool call.
    const spy = vi.spyOn(store, "listSharedSkillsByOwner").mockImplementation(() => {
      throw new Error("reconcile exploded");
    });
    fs.writeFileSync(
      path.join(root, "skills", "pptx-report", "SKILL.md"),
      skillMd("pptx-report", "v3"),
    );
    const survived = await callTool(tools, "commit", { message: "edit again" });
    expect(survived.isError).toBeFalsy();
    expect(survived.content[0].text).toContain("Committed and pushed the changes");
    expect(survived.content[0].text).not.toContain("Shared skills were reconciled");
    spy.mockRestore();
  });
});

// ---- routes/skillShare.ts -----------------------------------------------------

describe("skill-share routes", () => {
  it("mine reports repoConfigured=false without a repo (not an error)", async () => {
    const { app } = bootstrap();
    const { agent } = await newUser(app, "solo");
    const res = await agent.get("/api/skill-share/mine").expect(200);
    expect(res.body).toEqual({ repoConfigured: false, skills: [] });
  });

  // The heaviest test in the suite: two seeded remotes + repeated clone/learn
  // round-trips. Under full-suite parallel load the real git work can exceed
  // vitest's 5s default, so give the END-TO-END flow explicit headroom.
  it("shares, browses, previews, and learns across a group", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const outsider = await newUser(app, "outsider");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );

    // Owner's mine view lists the repo skill, unshared, never learned.
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(mine.body.repoConfigured).toBe(true);
    expect(mine.body.skills).toEqual([
      {
        slug: "pptx-report",
        name: "pptx-report",
        description: "Weekly report deck generator",
        shared: false,
        customDescription: null,
        learnCount: 0,
        origin: null,
      },
    ]);

    // Share validation: unknown skill 404, malformed name 400.
    await sharer.agent.post("/api/skill-share/share").send({ skill: "nope" }).expect(404);
    await sharer.agent.post("/api/skill-share/share").send({ skill: "../etc" }).expect(400);
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);

    // Teammate browses it; outsider sees nothing. The SHARER sees their own
    // share in the same feed (like 탐색 shows one's own avatar) with the count.
    const avail = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(avail.body.skills).toHaveLength(1);
    const listing = avail.body.skills[0];
    expect(listing.owner.username).toBe("sharer");
    expect(listing.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const outsiderAvail = await outsider.agent.get("/api/skill-share/available").expect(200);
    expect(outsiderAvail.body.skills).toHaveLength(0);
    const sharerAvail = await sharer.agent.get("/api/skill-share/available").expect(200);
    expect(sharerAvail.body.skills).toHaveLength(1);
    expect(sharerAvail.body.skills[0].ownerUserId).toBe(sharer.userId);
    expect(sharerAvail.body.skills[0].learnCount).toBe(0);

    // Preview returns the live SKILL.md; outsiders get 404 even with the id.
    const previewRes = await mate.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(previewRes.body.content).toContain("Make the deck.");
    await outsider.agent.get(`/api/skill-share/available/${listing.id}`).expect(404);
    // The SHARER previews their own card: the row is in their feed but excluded
    // from the learnable query, so the route must resolve own shares separately.
    const ownPreview = await sharer.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(ownPreview.body.content).toContain("Make the deck.");
    expect(ownPreview.body.skill.ownerUserId).toBe(sharer.userId);

    // Learn: outsider 404; mate without conflicts 200; second learn 409; rename ok.
    await outsider.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(404);
    const learned = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id })
      .expect(200);
    expect(learned.body.slug).toBe("pptx-report");
    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(409);
    const renamed = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, newName: "deck-two" })
      .expect(200);
    expect(renamed.body.slug).toBe("deck-two");

    // The learned skill shows up in the mate's own mine view (now shareable).
    const mateMine = await mate.agent.get("/api/skill-share/mine").expect(200);
    expect(mateMine.body.skills.map((s: { slug: string }) => s.slug)).toEqual([
      "deck-two",
      "pptx-report",
    ]);

    // Both successful learns were counted: teammates' listing AND the owner's
    // mine view show 전수 2회.
    const availAfterLearns = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(availAfterLearns.body.skills[0].learnCount).toBe(2);
    const sharerMine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(sharerMine.body.skills[0].learnCount).toBe(2);

    // Unshare: 404 for a non-shared name, 200 for the shared one; the listing empties.
    await sharer.agent.delete("/api/skill-share/share/none").expect(404);
    await sharer.agent.delete("/api/skill-share/share/pptx-report").expect(200);
    const after = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(after.body.skills).toHaveLength(0);
  });

  it("previews the whole file manifest, on a teammate's card and my own", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listing = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];

    // A skill is the DIRECTORY: the preview lists everything a learn copies,
    // not just the SKILL.md it renders above it.
    const teammateView = await mate.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(teammateView.body.manifest.files.map((f: { path: string }) => f.path)).toEqual([
      "SKILL.md",
      "scripts/render.sh",
    ]);
    expect(teammateView.body.manifest.totalBytes).toBeGreaterThan(0);
    expect(teammateView.body.manifest.truncated).toBe(false);

    // The own-share fallback path serves the same manifest (it 404s in the
    // learnable query, so it is a SECOND code path through the same handler).
    const ownView = await sharer.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(ownView.body.manifest).toEqual(teammateView.body.manifest);
  });

  it("owner-written 소개 문구 rides every viewer surface and survives reconciliation", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listing = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];
    expect(listing.description).toBe("Weekly report deck generator");

    const intro = "매주 월요일 보고용 덱을 대신 만들어 드려요.";
    const saved = await sharer.agent
      .put("/api/skill-share/share/pptx-report/description")
      .send({ description: `  ${intro}  ` })
      .expect(200);
    expect(saved.body.shared.customDescription).toBe(intro);

    // The feed card and the preview header both read the effective text.
    const feed = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(feed.body.skills[0].description).toBe(intro);
    const preview = await mate.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(preview.body.skill.description).toBe(intro);
    // The owner's own tab distinguishes intro from frontmatter text.
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(mine.body.skills[0].customDescription).toBe(intro);
    expect(mine.body.skills[0].description).toBe("Weekly report deck generator");

    // The owner edits SKILL.md: reconciliation re-snapshots the FRONTMATTER but
    // must not touch the intro (nor keep rewriting the row on every load).
    updateRemoteFile(
      "sharer-repo",
      "skills/pptx-report/SKILL.md",
      "---\nname: pptx-report\ndescription: Rewritten frontmatter\n---\n\n# pptx-report\n",
    );
    const reconciled = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(reconciled.body.skills[0].description).toBe("Rewritten frontmatter");
    expect(reconciled.body.skills[0].customDescription).toBe(intro);
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].snapshotDescription).toBe(
      "Rewritten frontmatter",
    );
    const settled = store.listSharedSkillsByOwner(sharer.userId)[0].updatedAt;
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].updatedAt).toBe(settled);
    expect((await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0].description).toBe(intro);

    // Clearing falls back to the (now rewritten) frontmatter text.
    await sharer.agent
      .put("/api/skill-share/share/pptx-report/description")
      .send({ description: "" })
      .expect(200);
    expect((await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0].description).toBe(
      "Rewritten frontmatter",
    );

    // Cap + ownership: too long is a 400, an unshared skill is a 404, and a
    // teammate cannot introduce someone else's share (it is keyed by ME).
    await sharer.agent
      .put("/api/skill-share/share/pptx-report/description")
      .send({ description: "가".repeat(501) })
      .expect(400);
    await sharer.agent
      .put("/api/skill-share/share/not-shared/description")
      .send({ description: "hi" })
      .expect(404);
    await mate.agent
      .put("/api/skill-share/share/pptx-report/description")
      .send({ description: "hijack" })
      .expect(404);
  });

  it("flags updates via origin markers and overwrites in place", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const avail = await mate.agent.get("/api/skill-share/available").expect(200);
    const listing = avail.body.skills[0];

    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(200);
    // Mine reports the provenance the client joins against the listing hash.
    const mateMine = await mate.agent.get("/api/skill-share/mine").expect(200);
    const learnedRow = mateMine.body.skills.find((s: { slug: string }) => s.slug === "pptx-report");
    expect(learnedRow.origin.ownerUserId).toBe(sharer.userId);
    expect(learnedRow.origin.contentHash).toBe(listing.contentHash);

    // The sharer ships v2; their mine reconciliation refreshes the row hash,
    // which no longer matches the learner's origin hash (= update available).
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    const availAfter = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(availAfter.body.skills[0].contentHash).not.toBe(listing.contentHash);

    // updateSlug + newName together is invalid; wrong slug fails closed.
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report", newName: "x" })
      .expect(400);
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "not-mine" })
      .expect(409);

    const updated = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report" })
      .expect(200);
    expect(updated.body.updated).toBe(true);
    const mineAfter = await mate.agent.get("/api/skill-share/mine").expect(200);
    expect(
      mineAfter.body.skills.find((s: { slug: string }) => s.slug === "pptx-report").origin
        .contentHash,
    ).toBe(availAfter.body.skills[0].contentHash);
    // The refresh did NOT inflate 전수된 횟수 — one learn, one count.
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(1);

    // A CUSTOMIZED copy needs the second-step consent: 409 with the guard
    // message the client string-matches, then overwriteModified succeeds.
    customizeLearnedCopy(mate.userId, "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## custom\n`);
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v3\n`);
    const guarded = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report" })
      .expect(409);
    expect(guarded.body.error).toContain("전수 후 수정");
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report", overwriteModified: true })
      .expect(200);
  });

  it("unlink (구독 해지) drops the origin marker; the copy stays, tracking stops", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const avail = await mate.agent.get("/api/skill-share/available").expect(200);
    const listing = avail.body.skills[0];
    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(200);

    // Not-learned slugs (and repeat unlinks) are a 404, not a crash.
    await mate.agent.post("/api/skill-share/unlink").send({ slug: "nope" }).expect(404);

    const unlinked = await mate.agent
      .post("/api/skill-share/unlink")
      .send({ slug: "pptx-report" })
      .expect(200);
    expect(unlinked.body.origin.ownerUsername).toBe("sharer");
    await mate.agent.post("/api/skill-share/unlink").send({ slug: "pptx-report" }).expect(404);

    // The copy survives with no origin; the update path now refuses it.
    const mine = await mate.agent.get("/api/skill-share/mine").expect(200);
    const row = mine.body.skills.find((s: { slug: string }) => s.slug === "pptx-report");
    expect(row).toBeTruthy();
    expect(row.origin).toBeNull();
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report" })
      .expect(409);
  });

  it("refuses to re-share a linked copy until 연결 끊기 claims it", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(
      learner.userId,
      seedSkillRemote("learner-repo", {
        "skills/pptx-report/.noah-skill-origin.json": ORIGIN_MARKER,
      }),
      "main",
    );

    const blocked = await learner.agent
      .post("/api/skill-share/share")
      .send({ skill: "pptx-report" })
      .expect(409);
    expect(blocked.body.error).toContain("@original");
    expect(blocked.body.error).toContain("연결 끊기");
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(0);

    // Unlinking is the ownership claim that unlocks sharing.
    await learner.agent.post("/api/skill-share/unlink").send({ slug: "pptx-report" }).expect(200);
    await learner.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(1);
  });

  it("treats a corrupt origin marker as no marker (shareable)", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(
      learner.userId,
      seedSkillRemote("learner-repo", {
        "skills/pptx-report/.noah-skill-origin.json": "{ not json at all",
      }),
      "main",
    );
    // Fail OPEN: a copy that makes no readable provenance claim is the owner's.
    await learner.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(1);
  });

  it("mine drains a legacy row whose dir now carries a marker", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const learner = await newUser(app, "learner");
    const mate = await newUser(app, "mate");
    store.setKnowledgeRepo(
      learner.userId,
      seedSkillRemote("learner-repo", {
        "skills/pptx-report/.noah-skill-origin.json": ORIGIN_MARKER,
      }),
      "main",
    );
    // A row created before re-sharing linked copies was refused, plus the
    // 전수 history it accumulated while it was live.
    store.shareSkill(learner.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    store.recordSkillLearn(learner.userId, "pptx-report", mate.userId);

    const mine = await learner.agent.get("/api/skill-share/mine").expect(200);
    const row = mine.body.skills.find((s: { slug: string }) => s.slug === "pptx-report");
    expect(row.shared).toBe(false);
    expect(row.origin.ownerUsername).toBe("original");
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(0);
    // The unshare is the only thing that happened — learn events are keyed by
    // (owner, skill_name) and outlive it by design.
    expect(store.skillLearnCounts(learner.userId)).toEqual({ "pptx-report": 1 });
  });

  it("preview and learn prune a legacy row whose SOURCE is a linked copy", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(
      sharer.userId,
      seedSkillRemote("sharer-repo", {
        "skills/pptx-report/.noah-skill-origin.json": ORIGIN_MARKER,
      }),
      "main",
    );
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    const legacy = () =>
      store.shareSkill(sharer.userId, {
        skillName: "pptx-report",
        displayName: "pptx-report",
        description: "",
      });

    // Preview: pruned instead of served, like a share whose dir was deleted.
    const preview = await mate.agent
      .get(`/api/skill-share/available/${legacy().id}`)
      .expect(404);
    expect(preview.body.error).toContain("전수받은 사본");
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);

    // Same for a learn that never opened the preview — nothing is copied.
    await mate.agent.post("/api/skill-share/learn").send({ id: legacy().id }).expect(404);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(fs.existsSync(path.join(mateRoot, "skills", "pptx-report"))).toBe(false);
  });

  it("learn without a connected learner repo is a 400 with guidance", async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const row = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    const res = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: row.id })
      .expect(400);
    expect(res.body.error).toContain("지식 저장소");
  });

  it("disconnecting or repointing the knowledge repo clears the owner's shares", async () => {
    const { app, store } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    // Repoint to a different repo → the old-repo shares are dropped.
    await sharer.agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);

    // A same-repo re-save (e.g. branch change) keeps shares.
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    await sharer.agent
      .put("/api/me/knowledge-repo")
      .send({ repo: "owner/brain", branch: "dev" })
      .expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(1);

    // Disconnecting clears them too.
    await sharer.agent.put("/api/me/knowledge-repo").send({ repo: "" }).expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
  });

  it("mine follows a renamed skill dir and keeps its response shape", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    await sharer.agent
      .put("/api/skill-share/share/pptx-report/description")
      .send({ description: "덱 만들어 드려요" })
      .expect(200);
    const before = store.listSharedSkillsByOwner(sharer.userId)[0];

    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    // Same keys as before the rename existed — the tab's contract is unchanged.
    // `name` still reads the frontmatter, which a `git mv` does not rewrite.
    expect(mine.body).toEqual({
      repoConfigured: true,
      skills: [
        {
          slug: "deck-maker",
          name: "pptx-report",
          description: "Weekly report deck generator",
          shared: true,
          customDescription: "덱 만들어 드려요",
          learnCount: 0,
          origin: null,
        },
      ],
    });
    const row = store.listSharedSkillsByOwner(sharer.userId)[0];
    expect(row.id).toBe(before.id);
    expect(row.createdAt).toBe(before.createdAt);
    expect(row.skillName).toBe("deck-maker");
    expect(row.previousNames).toEqual(["pptx-report"]);
  });

  it("preview serves a renamed skill on a stale card, without reordering the owner's shares", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listing = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];

    // The owner renames and never opens their own tab: the teammate's card is
    // stale, and the viewer path is what notices.
    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    const before = store.listSharedSkillsByOwner(sharer.userId)[0];

    const preview = await mate.agent
      .get(`/api/skill-share/available/${listing.id}`)
      .expect(200);
    expect(preview.body.skill.id).toBe(listing.id);
    expect(preview.body.skill.skillName).toBe("deck-maker");
    expect(preview.body.skill.previousNames).toEqual(["pptx-report"]);
    expect(preview.body.content).toContain("Make the deck.");
    expect(preview.body.manifest.files.map((f: { path: string }) => f.path)).toContain("SKILL.md");
    // A viewer action must never bump updated_at — the owner's listing order is
    // theirs, exactly as for the preview's fingerprint refresh.
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].updatedAt).toBe(before.updatedAt);
  });

  it("learn rescues a renamed source instead of pruning the share", { timeout: 30_000 }, async () => {
    const { app, store } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listing = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];

    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    const learned = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id })
      .expect(200);
    expect(learned.body.slug).toBe("deck-maker");
    // The share survived: the row moved rather than being pruned as stale.
    const row = store.listSharedSkillsByOwner(sharer.userId)[0];
    expect(row.id).toBe(listing.id);
    expect(row.skillName).toBe("deck-maker");
    expect(store.skillLearnCounts(sharer.userId)).toEqual({ "deck-maker": 1 });
  });

  it("an update is still authorized by a marker naming the share's previous name", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
        // Never learned from anyone — the fail-closed control.
        "skills/handmade/SKILL.md": "---\nname: handmade\n---\n",
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listing = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];
    await mate.agent.post("/api/skill-share/learn").send({ id: listing.id }).expect(200);

    // Rename first (the share follows), then ship a new version.
    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    updateRemoteFile("sharer-repo", "skills/deck-maker/SKILL.md", `${SKILL_MD}\n## v2\n`);
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(store.listSharedSkillsByOwner(sharer.userId)[0].previousNames).toEqual(["pptx-report"]);

    // The learner's copy kept its own slug AND a marker naming the old share.
    const mateCtx = knowledgeRepoContextFor(store, mate.userId, config)!;
    expect(readSkillOrigin(await ensureClone(mateCtx), "pptx-report")?.skillName).toBe(
      "pptx-report",
    );
    const updated = await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "pptx-report" })
      .expect(200);
    expect(updated.body.updated).toBe(true);

    // The marker self-heals to the share's CURRENT name, so the trail is only
    // ever needed once per learner.
    const healed = await ensureClone(mateCtx);
    expect(readSkillOrigin(healed, "pptx-report")?.skillName).toBe("deck-maker");
    expect(
      fs.readFileSync(path.join(healed, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v2");
    // A genuinely foreign copy still fails closed.
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: listing.id, updateSlug: "handmade" })
      .expect(409);
  });

  it("mine reconciles stale rows: a share whose dir vanished is unshared", async () => {
    const { app, store } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.shareSkill(sharer.userId, {
      skillName: "deleted-skill",
      displayName: "deleted-skill",
      description: "",
    });
    const mine = await sharer.agent.get("/api/skill-share/mine").expect(200);
    expect(mine.body.skills.map((s: { slug: string }) => s.slug)).toEqual(["pptx-report"]);
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
  });
});

// ---- routes/groups.ts: group-channel skill blocks -----------------------------

describe("group-channel skill blocks (routes)", () => {
  /** A group with a sharer, a plain member, and a promoted GROUP admin. */
  async function channel() {
    const { app, store, config } = bootstrap();
    const sysAdmin = await newUser(app, "sysadmin"); // first signup = system admin
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    const boss = await newUser(app, "boss");
    const groupId = await shareGroup(sysAdmin.agent, ["sharer", "mate", "boss"]);
    store.setGroupMemberRole(groupId, boss.userId, "admin");
    const share = store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    return { app, store, config, sysAdmin, sharer, mate, boss, groupId, share };
  }
  const blocksPath = (groupId: string) =>
    `/api/me/groups/${groupId}/shared-skills/blocks`;

  it("gates the management listing on canManage (member 403, group + system admin ok)", async () => {
    const { sysAdmin, mate, boss, groupId } = await channel();

    await mate.agent.get(`/api/me/groups/${groupId}/shared-skills`).expect(403);
    const asGroupAdmin = await boss.agent
      .get(`/api/me/groups/${groupId}/shared-skills`)
      .expect(200);
    expect(asGroupAdmin.body.skills).toHaveLength(1);
    expect(asGroupAdmin.body.skills[0]).toMatchObject({
      skillName: "pptx-report",
      blocked: false,
      owner: { username: "sharer" },
    });
    // The system admin manages every group without being a member.
    await sysAdmin.agent.get(`/api/me/groups/${groupId}/shared-skills`).expect(200);
    await boss.agent.get("/api/me/groups/no-such-group/shared-skills").expect(404);
  });

  it("blocks + unblocks through the group channel, with audit rows", async () => {
    const { sysAdmin, sharer, mate, boss, groupId, share } = await channel();
    const body = { ownerUserId: sharer.userId, skillName: "pptx-report" };

    // A plain member cannot moderate the channel.
    await mate.agent.post(blocksPath(groupId)).send(body).expect(403);
    await mate.agent
      .delete(`${blocksPath(groupId)}/${sharer.userId}/pptx-report`)
      .expect(403);

    await boss.agent.post(blocksPath(groupId)).send(body).expect(200);

    // The teammate's whole learner surface fails closed on the store queries:
    // the feed drops it, and both single-row lookups 404 (preview would be 410
    // "no repo" and learn 400 "connect your repo" if the row resolved).
    const feed = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(feed.body.skills).toHaveLength(0);
    await mate.agent.get(`/api/skill-share/available/${share.id}`).expect(404);
    await mate.agent.post("/api/skill-share/learn").send({ id: share.id }).expect(404);
    // The owner still sees their own share — a block is not an unshare.
    const mine = await sharer.agent.get("/api/skill-share/available").expect(200);
    expect(mine.body.skills.map((s: { id: string }) => s.id)).toEqual([share.id]);

    const blockedList = await boss.agent
      .get(`/api/me/groups/${groupId}/shared-skills`)
      .expect(200);
    expect(blockedList.body.skills[0].blocked).toBe(true);

    // Re-blocking is idempotent, not an error.
    await boss.agent.post(blocksPath(groupId)).send(body).expect(200);

    // The system admin lifts it; the second delete 404s (no no-op audit row).
    await sysAdmin.agent
      .delete(`${blocksPath(groupId)}/${sharer.userId}/pptx-report`)
      .expect(200);
    await sysAdmin.agent
      .delete(`${blocksPath(groupId)}/${sharer.userId}/pptx-report`)
      .expect(404);
    const restored = await mate.agent.get("/api/skill-share/available").expect(200);
    expect(restored.body.skills.map((s: { id: string }) => s.id)).toEqual([share.id]);
    await mate.agent.get(`/api/skill-share/available/${share.id}`).expect(410);

    const audit = await sysAdmin.agent.get("/api/audit").expect(200);
    const rows = audit.body.audit as { action: string; detail: string }[];
    const blocked = rows.find((e) => e.action === "group_skill_block");
    const unblocked = rows.find((e) => e.action === "group_skill_unblock");
    expect(blocked?.detail).toContain('@sharer의 "pptx-report" 공유를 그룹 채널에서 차단');
    expect(unblocked?.detail).toContain('@sharer의 "pptx-report" 공유 차단을 그룹 채널에서 해제');
  });

  it("refuses a non-member owner and a malformed skill name", async () => {
    const { app, boss, sharer, groupId } = await channel();
    const outsider = await newUser(app, "outsider");

    await boss.agent
      .post(blocksPath(groupId))
      .send({ ownerUserId: outsider.userId, skillName: "pptx-report" })
      .expect(404);
    await boss.agent
      .post(blocksPath(groupId))
      .send({ ownerUserId: sharer.userId, skillName: "Not A Slug" })
      .expect(400);
    await boss.agent
      .post(blocksPath(groupId))
      .send({ skillName: "pptx-report" })
      .expect(400);
  });
});

// ---- agent/skillExchangeTools.ts ----------------------------------------------

describe("mcp skill_exchange tools", () => {
  function toolsFor(
    store: ReturnType<typeof bootstrap>["store"],
    config: ReturnType<typeof bootstrap>["config"],
    userId: string,
    username: string,
    viewerIsOwner = true,
  ) {
    return buildSkillExchangeTools(store, {
      avatarUserId: userId,
      owner: { id: userId, username, displayName: username, alias: "" },
      viewerIsOwner,
      config,
    });
  }

  it("every tool self-gates on viewerIsOwner", async () => {
    const { store, config } = bootstrap();
    const tools = toolsFor(store, config, "u1", "u1", false);
    for (const name of [
      "find_shared_skills",
      "learn_skill",
      "share_skill",
      "unshare_skill",
      "unlink_skill",
    ]) {
      const result = await callTool(tools, name, {
        owner_username: "x",
        skill_name: "y",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("avatar owner");
    }
  });

  it("find lists teammate shares with the learn address; empty state guides", async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    const tools = toolsFor(store, config, mate.userId, "mate");

    const empty = await callTool(tools, "find_shared_skills", {});
    expect(empty.content[0].text).toContain("No teammate has shared a skill yet");

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "Deck maker",
      description: "Weekly report deck generator",
    });
    const found = await callTool(tools, "find_shared_skills", { query: "deck" });
    expect(found.content[0].text).toContain("pptx-report");
    expect(found.content[0].text).toContain("@sharer");

    const miss = await callTool(tools, "find_shared_skills", { query: "zzz" });
    expect(miss.content[0].text).toContain('No shared skill matches "zzz"');
  });

  it("learn_skill copies into the owner's repo and redirects on failures", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const tools = toolsFor(store, config, mate.userId, "mate");

    // Unknown share → redirect to find_shared_skills.
    const unknown = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "nope",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("find_shared_skills");

    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });

    // No learner repo yet → NO_REPO guidance.
    const noRepo = await callTool(tools, "learn_skill", {
      owner_username: "@sharer",
      skill_name: "pptx-report",
    });
    expect(noRepo.isError).toBe(true);
    expect(noRepo.content[0].text).toContain("knowledge repository");

    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    const ok = await callTool(tools, "learn_skill", {
      owner_username: "@sharer",
      skill_name: "pptx-report",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('Learned "pptx-report" from @sharer');
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(fs.existsSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"))).toBe(true);
    // The learn was recorded, and find surfaces the adoption count.
    expect(store.countSkillLearnsForOwner(sharer.userId)).toBe(1);
    const foundAfter = await callTool(tools, "find_shared_skills", {});
    expect(foundAfter.content[0].text).toContain("learned 1×");

    // Second learn collides → suggests new_name.
    const dup = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
    });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("new_name");
  });

  it("learn_skill update:true resolves the learner's copy and refuses ambiguity", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    const tools = toolsFor(store, config, mate.userId, "mate");

    // Nothing learned yet → update has no target.
    const none = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("nothing to update");

    await callTool(tools, "learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v2\n`);
    const ok = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain('Updated "pptx-report"');
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(
      fs.readFileSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v2");

    // A customized copy: refuse without explicit consent, then honor it.
    customizeLearnedCopy(mate.userId, "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## custom\n`);
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", `${SKILL_MD}\n## v3\n`);
    const guarded = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(guarded.isError).toBe(true);
    expect(guarded.content[0].text).toContain("overwrite_modified");
    const consented = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
      overwrite_modified: true,
    });
    expect(consented.isError).toBeFalsy();
    expect(
      fs.readFileSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v3");

    // A second copy makes the update target ambiguous → redirect, no change.
    await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      new_name: "second-copy",
    });
    const ambiguous = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("ambiguous");

    // update + new_name is contradictory input.
    const both = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
      update: true,
      new_name: "x",
    });
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toContain("mutually exclusive");
  });

  it("learn_skill update:true finds a copy learned under the share's previous name", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const tools = toolsFor(store, config, mate.userId, "mate");
    await callTool(tools, "learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });

    // The share follows a rename; the learner's marker still names the old one.
    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    updateRemoteFile("sharer-repo", "skills/deck-maker/SKILL.md", `${SKILL_MD}\n## v2\n`);
    await sharer.agent.get("/api/skill-share/mine").expect(200);

    const updated = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "deck-maker",
      update: true,
    });
    expect(updated.isError).toBeFalsy();
    expect(updated.content[0].text).toContain('Updated "pptx-report"');
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(
      fs.readFileSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"), "utf8"),
    ).toContain("## v2");
    expect(readSkillOrigin(mateRoot, "pptx-report")?.skillName).toBe("deck-maker");
  });

  // The rename trail is how a copy learned under an old name stays matched to
  // its share — but a name a share LEFT is free for an unrelated share to take,
  // and then two copies carry markers naming it. Resolving that by the trail
  // would let the renamed share overwrite the OTHER share's copy.
  it("refuses an update when the rename trail matches two copies", { timeout: 60_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const first = (await mate.agent.get("/api/skill-share/available").expect(200)).body.skills[0];
    await mate.agent.post("/api/skill-share/learn").send({ id: first.id }).expect(200);

    // The share is renamed (its trail now names "pptx-report"), and a BRAND NEW
    // skill takes the freed name and is shared in turn.
    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    await sharer.agent.get("/api/skill-share/mine").expect(200);
    updateRemoteFile("sharer-repo", "skills/pptx-report/SKILL.md", skillMd("pptx-report", "unrelated"));
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const listings = (await mate.agent.get("/api/skill-share/available").expect(200)).body
      .skills as SharedSkillListing[];
    const renamed = listings.find((s) => s.skillName === "deck-maker")!;
    const fresh = listings.find((s) => s.skillName === "pptx-report")!;
    expect(renamed.previousNames).toEqual(["pptx-report"]);
    // The learner now holds TWO copies whose markers both say "pptx-report".
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: fresh.id, newName: "pptx-report-2" })
      .expect(200);

    // Overwriting the NEW share's copy with the renamed share's content is
    // refused — the trail only counts while it is the sole answer.
    await mate.agent
      .post("/api/skill-share/learn")
      .send({ id: renamed.id, updateSlug: "pptx-report-2" })
      .expect(409);
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(
      fs.readFileSync(path.join(mateRoot, "skills", "pptx-report-2", "SKILL.md"), "utf8"),
    ).toContain("unrelated");

    // The agent surface reports the same ambiguity instead of picking one.
    const tools = toolsFor(store, config, mate.userId, "mate");
    const ambiguous = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "deck-maker",
      update: true,
    });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("ambiguous");
    expect(ambiguous.content[0].text).toContain("pptx-report-2");
  });

  it("learn_skill rescues a renamed source and prunes a dead one", { timeout: 60_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    await sharer.agent.post("/api/skill-share/share").send({ skill: "pptx-report" }).expect(200);
    const tools = toolsFor(store, config, mate.userId, "mate");

    // The owner renames out of band and never opens their own tab: the agent
    // path rescues the row on git evidence rather than pruning a live share.
    renameRemoteSkill("sharer-repo", "pptx-report", "deck-maker");
    const rescued = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "pptx-report",
    });
    expect(rescued.isError).toBeFalsy();
    expect(rescued.content[0].text).toContain('Learned "deck-maker"');
    const row = store.listSharedSkillsByOwner(sharer.userId)[0];
    expect(row.skillName).toBe("deck-maker");
    expect(row.previousNames).toEqual(["pptx-report"]);

    // A genuine deletion is not rescuable, and the dead row is pruned here too
    // — the tab and the agent must tell the same story about a dead share.
    deleteRemotePath("sharer-repo", "skills/deck-maker");
    const gone = await callTool(tools, "learn_skill", {
      owner_username: "sharer",
      skill_name: "deck-maker",
      new_name: "deck-maker-2",
    });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain("is gone from @sharer's repository");
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);
  });

  it("unlink_skill stops tracking mid-conversation", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    store.setKnowledgeRepo(
      mate.userId,
      seedRemote("mate-repo", {
        ".claude-plugin/marketplace.json": JSON.stringify({ name: "m", plugins: [] }),
      }),
      "main",
    );
    store.shareSkill(sharer.userId, {
      skillName: "pptx-report",
      displayName: "pptx-report",
      description: "",
    });
    const tools = toolsFor(store, config, mate.userId, "mate");

    const nothing = await callTool(tools, "unlink_skill", { skill_name: "pptx-report" });
    expect(nothing.isError).toBe(true);
    expect(nothing.content[0].text).toContain("nothing to unlink");

    await callTool(tools, "learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
    const ok = await callTool(tools, "unlink_skill", { skill_name: "pptx-report" });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("Unlinked");
    const mateRoot = await ensureClone(knowledgeRepoContextFor(store, mate.userId, config)!);
    expect(fs.existsSync(path.join(mateRoot, "skills", "pptx-report", "SKILL.md"))).toBe(true);
    expect(
      fs.existsSync(path.join(mateRoot, "skills", "pptx-report", ".noah-skill-origin.json")),
    ).toBe(false);
  });

  it("share_skill/unshare_skill manage the owner's own listings", async () => {
    const { app, store, config } = bootstrap();
    const sharer = await newUser(app, "sharer");
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const tools = toolsFor(store, config, sharer.userId, "sharer");

    const missing = await callTool(tools, "share_skill", { skill_name: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("scaffold_skill");

    const shared = await callTool(tools, "share_skill", { skill_name: "pptx-report" });
    expect(shared.isError).toBeFalsy();
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(1);

    const unshared = await callTool(tools, "unshare_skill", { skill_name: "pptx-report" });
    expect(unshared.isError).toBeFalsy();
    expect(store.listSharedSkillsByOwner(sharer.userId)).toHaveLength(0);

    const again = await callTool(tools, "unshare_skill", { skill_name: "pptx-report" });
    expect(again.isError).toBe(true);
  });

  it("share_skill's description sets the card introduction; omitting it preserves one", async () => {
    const { app, store, config } = bootstrap();
    const admin = await newUser(app, "admin");
    const sharer = await newUser(app, "sharer");
    const mate = await newUser(app, "mate");
    await shareGroup(admin.agent, ["sharer", "mate"]);
    store.setKnowledgeRepo(sharer.userId, seedSkillRemote("sharer-repo"), "main");
    const tools = toolsFor(store, config, sharer.userId, "sharer");
    const share = (args: Record<string, unknown>) => callTool(tools, "share_skill", args);
    const row = () => store.listSharedSkillsByOwner(sharer.userId)[0];

    // Sharing without the param leaves the card on the frontmatter text.
    await share({ skill_name: "pptx-report" });
    expect(row().customDescription).toBeNull();
    expect(row().description).toBe("Weekly report deck generator");

    const withIntro = await share({
      skill_name: "pptx-report",
      description: "  주간 보고 덱을 대신 만들어 드려요  ",
    });
    expect(withIntro.isError).toBeFalsy();
    expect(withIntro.content[0].text).toContain("주간 보고 덱을 대신 만들어 드려요");
    expect(row().customDescription).toBe("주간 보고 덱을 대신 만들어 드려요");

    // A later re-share WITHOUT the param must not wipe what the owner wrote.
    await share({ skill_name: "pptx-report" });
    expect(row().customDescription).toBe("주간 보고 덱을 대신 만들어 드려요");
    // The find tool prints the effective text to the teammate's model.
    const found = await callTool(toolsFor(store, config, mate.userId, "mate"), "find_shared_skills", {});
    expect(found.content[0].text).toContain("주간 보고 덱을 대신 만들어 드려요");

    // An EXPLICIT empty string is the clear (the tool description says so).
    await share({ skill_name: "pptx-report", description: "" });
    expect(row().customDescription).toBeNull();
    expect(row().description).toBe("Weekly report deck generator");

    // Over the cap: refuse and say so rather than silently truncating.
    const tooLong = await share({ skill_name: "pptx-report", description: "가".repeat(501) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content[0].text).toContain("500");
  });

  it("share_skill refuses a still-linked copy and redirects to unlink", { timeout: 30_000 }, async () => {
    const { app, store, config } = bootstrap();
    const learner = await newUser(app, "learner");
    store.setKnowledgeRepo(
      learner.userId,
      seedSkillRemote("learner-repo", {
        "skills/pptx-report/.noah-skill-origin.json": ORIGIN_MARKER,
      }),
      "main",
    );
    const tools = toolsFor(store, config, learner.userId, "learner");

    const blocked = await callTool(tools, "share_skill", { skill_name: "pptx-report" });
    expect(blocked.isError).toBe(true);
    // Names the sharer the copy is still linked to, and BOTH recoveries:
    // teammates learn from the original share, or the owner unlinks first.
    expect(blocked.content[0].text).toContain("@original");
    expect(blocked.content[0].text).toContain("find_shared_skills");
    expect(blocked.content[0].text).toContain("unlink_skill");
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(0);

    const unlinked = await callTool(tools, "unlink_skill", { skill_name: "pptx-report" });
    expect(unlinked.isError).toBeFalsy();
    const shared = await callTool(tools, "share_skill", { skill_name: "pptx-report" });
    expect(shared.isError).toBeFalsy();
    expect(store.listSharedSkillsByOwner(learner.userId)).toHaveLength(1);
  });
});
