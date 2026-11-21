import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commitAndPush, ensureClone, knowledgeClonePath, type KnowledgeRepoContext } from "../src/server/knowledgeRepo.js";
import type { AppConfig } from "../src/server/types.js";
import { gitInit, makeBareRemote, withTempDir } from "./helpers.js";

// The knowledge repository's commit/push plumbing on its own (`commitAndPush` →
// `commitAndPushClone`), against a local bare remote: commit, fetch + rebase onto
// what the remote got meanwhile, push. No store and no tools — the context is
// built by hand, so this file needs nothing but git.
const tempDir = withTempDir("knowledge-commit-push");
const identity = { name: "Owner", email: "owner@x.local" };

function setup(dir: string) {
  const root = path.join(tempDir(), dir);
  const remote = makeBareRemote(path.join(root, "remote.git"));
  const seed = path.join(root, "seed");
  gitInit(seed);
  const seedGit = (...args: string[]) => execFileSync("git", ["-C", seed, ...args], { stdio: "pipe" });
  seedGit("branch", "-M", "main");
  seedGit("remote", "add", "origin", remote);
  seedGit("push", "-q", "origin", "main");
  const config = { dataDir: root, githubHost: "github.com" } as AppConfig;
  const ctx: KnowledgeRepoContext = { userId: "owner-1", repo: remote, branch: "main", token: null, config, selected: null };
  const clone = knowledgeClonePath(ctx.userId, config);
  const cloneGit = (...args: string[]) => execFileSync("git", ["-C", clone, ...args], { stdio: "pipe" }).toString();
  /** A commit pushed from OUTSIDE the app (the owner's laptop, CI). */
  const externalPush = (file: string, content: string) => {
    seedGit("pull", "-q", "origin", "main");
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
    seedGit("add", "-A");
    seedGit("commit", "-q", "-m", `external: ${file}`);
    seedGit("push", "-q", "origin", "main");
  };
  const remoteSubjects = () => execFileSync("git", ["-C", remote, "log", "--pretty=%s", "main"]).toString();
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
    fs.writeFileSync(path.join(clone, file), content);
  };
  return { ctx, clone, cloneGit, externalPush, remoteSubjects, write };
}

describe("knowledge repository commit and push", () => {
  it("throws NOT_CLONED before there is a clone", async () => {
    const s = setup("not-cloned");
    await expect(commitAndPush(s.ctx, "nothing", identity)).rejects.toThrow("NOT_CLONED");
  });

  it("commits and pushes a change; a clean tree with nothing unpushed is false", async () => {
    const s = setup("plain");
    await ensureClone(s.ctx);
    expect(await commitAndPush(s.ctx, "nothing", identity)).toBe(false);

    s.write("skills/demo/SKILL.md", "# demo");
    expect(await commitAndPush(s.ctx, "add demo skill", identity)).toBe(true);
    expect(s.remoteSubjects()).toContain("add demo skill");
    expect(s.cloneGit("log", "-1", "--format=%an <%ae>").trim()).toBe("Owner <owner@x.local>");
    expect(await commitAndPush(s.ctx, "again", identity)).toBe(false);
  });

  it("an empty message falls back to the default one", async () => {
    const s = setup("default-message");
    await ensureClone(s.ctx);
    s.write("a.md", "A");
    expect(await commitAndPush(s.ctx, "   ", identity)).toBe(true);
    expect(s.remoteSubjects()).toContain("Update knowledge repo");
  });

  it("rebases onto what the remote got meanwhile, then pushes", async () => {
    const s = setup("rebase");
    await ensureClone(s.ctx);
    s.write("b.md", "B");
    s.externalPush("external.md", "E");

    expect(await commitAndPush(s.ctx, "add b", identity)).toBe(true);
    const subjects = s.remoteSubjects().trim().split("\n");
    expect(subjects[0]).toBe("add b");
    expect(subjects).toContain("external: external.md");
    // The remote's file arrived in the clone, and nothing is left to push.
    expect(fs.readFileSync(path.join(s.clone, "external.md"), "utf8")).toBe("E");
    expect(s.cloneGit("status", "--porcelain")).toBe("");
  });

  it("a conflicting remote change aborts the rebase, names the file as it is on disk, and keeps the local commit", async () => {
    const s = setup("conflict");
    await ensureClone(s.ctx);
    // A non-ASCII name: git would quote it (`"notes/\355…"`) without `-z`.
    const file = "notes/회의록.md";
    s.write(file, "v1");
    expect(await commitAndPush(s.ctx, "v1", identity)).toBe(true);

    s.write(file, "local edit");
    s.externalPush(file, "external edit");
    await expect(commitAndPush(s.ctx, "local", identity)).rejects.toThrow(`REBASE_CONFLICT:${file}`);

    // Aborted: the local commit is intact on top of v1, the remote was not pushed to, no rebase is left open.
    expect(s.cloneGit("log", "-1", "--pretty=%s").trim()).toBe("local");
    expect(fs.readFileSync(path.join(s.clone, file), "utf8")).toBe("local edit");
    expect(s.remoteSubjects()).not.toContain("local");
    expect(fs.existsSync(path.join(s.clone, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(s.clone, ".git", "rebase-apply"))).toBe(false);
  });

  it("never carries a change at a vault-note path: those notes live in the memory service", async () => {
    const s = setup("vault-paths-left-out");
    await ensureClone(s.ctx);
    // What the retired mirror may have left in a clone, or a repository's own notes: changes at vault paths.
    s.externalPush("wiki/concepts/deploy.md", "the repository's own note");
    await ensureClone(s.ctx);
    s.write("wiki/concepts/deploy.md", "an uncommitted copy");
    s.write("raw/2026-11-01.md", "an untracked copy");
    s.write("CLAUDE.md", "an untracked copy");

    // Alone, they are nothing to commit…
    expect(await commitAndPush(s.ctx, "nothing of mine", identity)).toBe(false);
    expect(s.remoteSubjects()).not.toContain("nothing of mine");

    // …and next to a real change they stay out of the commit, in the tree as they were.
    s.write("skills/demo/SKILL.md", "# demo");
    s.write("wiki/diagram.png", "a repository file under wiki/");
    expect(await commitAndPush(s.ctx, "add demo skill", identity)).toBe(true);
    const pushed = execFileSync("git", ["-C", s.ctx.repo, "show", "--name-only", "--pretty=", "main"]).toString().trim().split("\n").sort();
    expect(pushed).toEqual(["skills/demo/SKILL.md", "wiki/diagram.png"]);
    expect(execFileSync("git", ["-C", s.ctx.repo, "show", "main:wiki/concepts/deploy.md"]).toString()).toBe("the repository's own note");
    expect(fs.readFileSync(path.join(s.clone, "wiki/concepts/deploy.md"), "utf8")).toBe("an uncommitted copy");
    expect(fs.readFileSync(path.join(s.clone, "raw/2026-11-01.md"), "utf8")).toBe("an untracked copy");
    expect(s.cloneGit("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((line) => line.slice(3)).sort()).toEqual([
      "CLAUDE.md",
      "raw/2026-11-01.md",
      "wiki/concepts/deploy.md",
    ]);
  });

  it("pushes commits stacked by an earlier failed push, on a clean tree", async () => {
    const s = setup("stacked");
    await ensureClone(s.ctx);
    s.write("stacked.md", "S");
    s.cloneGit("add", "-A");
    s.cloneGit("-c", "user.name=Owner", "-c", "user.email=owner@x.local", "commit", "-q", "-m", "stacked");

    expect(await commitAndPush(s.ctx, "retry", identity)).toBe(true);
    const subjects = s.remoteSubjects();
    expect(subjects).toContain("stacked");
    expect(subjects).not.toContain("retry");
  });
});
