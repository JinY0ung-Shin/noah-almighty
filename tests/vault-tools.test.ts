// The avatar's tools and the personal vault: `mcp__repo__*` (repoTools.ts /
// repoToolKit.ts) and `mcp__brain__*` (brainTools.ts). A vault note — the root
// `CLAUDE.md` and the `.md` notes under `wiki/` and `raw/` — is read and written
// in the memory service, for every owner; every other path is a file of the
// knowledge repository's clone. (The `repo` home, the git mirror and the
// migration between the two were retired on 2026-11-20.)
//
// The memory service is the in-process fake (tests/helpers/fakeMemory.ts); the
// knowledge repo is a local bare remote, so clone/commit/push run offline and a
// commit is checked end to end (what really lands in the remote).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/server/vaultImport.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/vaultImport.js")>();
  return { ...real, onKnowledgeRepoChanged: vi.fn() };
});

import { createServices } from "../src/server/app.js";
import { buildRepoTools } from "../src/server/agent/repoTools.js";
import { buildBrainTools, personalNoteBlobId } from "../src/server/agent/brainTools.js";
import {
  NO_CHANGES,
  VAULT_NOTES_NEED_NO_COMMIT,
  VAULT_NOTE_SAVED,
  mergeVaultTree,
  touchesVault,
  vaultNotePathOf,
} from "../src/server/agent/repoToolKit.js";
import type { TeamBrainToolsContext } from "../src/server/agent/teamBrainTools.js";
import { MemoryRefusedError, MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import { withVaultWriteLock } from "../src/server/personalVault.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { onKnowledgeRepoChanged } from "../src/server/vaultImport.js";
import { callTool, gitInit, makeBareRemote, withTempDir, type ToolResult } from "./helpers.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";
import { seedTeamVault, teamPage } from "./team-brain-fixtures.js";

let tempDir: string;
const getTempDir = withTempDir("vault-tools", () => {
  tempDir = getTempDir();
});

const repoChangedSpy = vi.mocked(onKnowledgeRepoChanged);
beforeEach(() => {
  repoChangedSpy.mockClear();
});

const txt = (res: ToolResult): string => res.content[0].text ?? "";
const down = () => new MemoryUnavailableError("memory service unavailable (read): network error (ECONNREFUSED)", "network");

/** The model must read "the service is down", never "there is nothing". */
function expectUnavailable(res: ToolResult): void {
  expect(res.isError).toBe(true);
  const t = txt(res);
  expect(t).toContain("memory service");
  expect(t).toContain("unavailable right now");
  expect(t).toMatch(/NOT/);
  expect(t).not.toMatch(/not found|does not exist|No notes in your second brain|No such note|Invalid path/i);
  // Agent-facing text may name the memory service, never what runs behind it.
  expect(t).not.toMatch(/pi-gateway/i);
}

/** A store + owner on a local bare remote (seeded with `files`), with the (fake) memory service as the owner's vault. */
function setup(name: string, opts: { repo?: boolean; files?: Record<string, string> } = {}) {
  const base = path.join(tempDir, name);
  const services = createServices({ dataDir: path.join(base, "data"), agentRuntime: "local", sessionSecret: "t" });
  const { store, config } = services;
  const user = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const remote = makeBareRemote(path.join(base, "remote.git"));
  const seed = path.join(base, "seed");
  gitInit(seed);
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  const put = (files: Record<string, string | null>) => {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(seed, rel);
      if (content === null) {
        fs.rmSync(abs, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  };
  if (opts.files) {
    put(opts.files);
    g("add", "-A");
    g("commit", "-q", "-m", "seed files");
  }
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  if (opts.repo !== false) store.setKnowledgeRepo(user.id, remote, "main");
  store.setGitToken(user.id, "tok");
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(store, fake);
  const owner = { id: user.id, username: "owner", displayName: "Owner" };
  const events: Array<{ action: string; path: string }> = [];
  const tools = buildRepoTools(store, {
    avatarUserId: user.id,
    owner,
    viewerIsOwner: true,
    config,
    onMemory: (e) => events.push(e),
  });
  const clonePath = knowledgeClonePath(user.id, config);
  return {
    services,
    store,
    config,
    owner,
    ownerId: user.id,
    fake,
    remote,
    clonePath,
    events,
    tools,
    call: (name: string, args: unknown = {}) => callTool(tools, name, args),
    notes: () => fake.dump(user.id),
    inClone: (rel: string) => fs.existsSync(path.join(clonePath, rel)),
    cloneFile: (rel: string) => fs.readFileSync(path.join(clonePath, rel), "utf8"),
    remoteFiles: () =>
      execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"], { stdio: "pipe" })
        .toString()
        .split("\n")
        .filter(Boolean),
    remoteFile: (rel: string) => execFileSync("git", ["--git-dir", remote, "show", `main:${rel}`], { stdio: "pipe" }).toString(),
    remoteLog: () => execFileSync("git", ["--git-dir", remote, "log", "--format=%an%n%B", "main"], { stdio: "pipe" }).toString(),
    /** A direct git edit of the repository, from outside Noah: pull, change files (null = delete), commit, push. */
    pushOutside: (files: Record<string, string | null>) => {
      g("pull", "-q", "--rebase", "origin", "main");
      put(files);
      g("add", "-A");
      g("commit", "-q", "-m", "direct git edit");
      g("push", "-q", "origin", "main");
    },
  };
}
type Fixture = ReturnType<typeof setup>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Start `call` while the owner's vault write queue is held by something else
 * (the import, another tool), look at the world while it waits (`whileWaiting`),
 * then let it run.
 */
async function whileQueued(s: Fixture, whileWaiting: () => void, call: () => Promise<ToolResult>): Promise<ToolResult> {
  let release!: () => void;
  const held = withVaultWriteLock(s.store, s.ownerId, () => new Promise<void>((resolve) => (release = resolve)));
  const pending = call();
  await tick();
  await tick();
  whileWaiting();
  release();
  await held;
  return pending;
}

/** The service calls that change something. */
const writesOf = (s: Fixture) => s.fake.calls.filter((c) => c.op === "put" || c.op === "remove");

/** A trusted teammate's run on the owner's SHARED account: may write and commit, is not the owner. */
function teammateTools(s: Fixture) {
  const mate = s.store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
  const tools = buildRepoTools(s.store, {
    avatarUserId: s.ownerId,
    owner: s.owner,
    viewerIsOwner: false,
    elevated: true,
    writeAccess: true,
    viewer: { id: mate.id, name: "mate" },
    config: s.config,
  });
  return { mate, tools, call: (name: string, args: unknown = {}) => callTool(tools, name, args) };
}

describe("which paths are vault notes for the tools", () => {
  it("reads a tool path the way the clone ops would resolve it", () => {
    for (const p of ["CLAUDE.md", "./CLAUDE.md", "wiki/a.md", "./wiki//a.md", "wiki/x/../a.md", "wiki/a.md/", "raw/2026/x.md"]) {
      expect(vaultNotePathOf(p), p).not.toBeNull();
    }
    expect(vaultNotePathOf("wiki/x/../a.md")).toBe("wiki/a.md");
    expect(vaultNotePathOf("wiki/a.md/")).toBe("wiki/a.md");
    // Not vault notes: an absolute path (the clone ops refuse it), other folders, non-markdown, what the service cannot hold.
    for (const p of ["/wiki/a.md", "notes/a.md", "wiki/a.txt", "wiki/.gitkeep", "wiki/.obsidian/a.md", "skills/x/SKILL.md", "wiki", "docs/CLAUDE.md", "../wiki/a.md"]) {
      expect(vaultNotePathOf(p), p).toBeNull();
    }
    // A delete/move asks the service only where notes can be.
    expect(touchesVault("wiki")).toBe(true);
    expect(touchesVault("raw/2026")).toBe(true);
    expect(touchesVault("wiki/.gitkeep")).toBe(true);
    expect(touchesVault("CLAUDE.md")).toBe(true);
    expect(touchesVault("skills/x")).toBe(false);
    expect(touchesVault("README.md")).toBe(false);
    expect(touchesVault("wikis/a.md")).toBe(false);
  });

  it("merges the clone tree with the service's notes in listTree's order", () => {
    const merged = mergeVaultTree(
      [
        { type: "dir", path: "skills" },
        { type: "dir", path: "empty" },
        { type: "dir", path: "wiki" },
        { type: "dir", path: "wiki/old" },
        { type: "dir", path: "wiki/sources" },
        { type: "file", path: "README.md" },
        { type: "file", path: "CLAUDE.md" }, // a clone file at a vault path: not the vault's
        { type: "file", path: "wiki/old/gone.md" }, // a clone file of a note the service does not hold
        { type: "file", path: "wiki/sources/.gitkeep" },
      ],
      [{ path: "CLAUDE.md" }, { path: "raw/2026/c.md" }, { path: "wiki/a.md" }],
    );
    expect(merged.map((e) => (e.type === "dir" ? `${e.path}/` : e.path))).toEqual([
      "empty/",
      "raw/",
      "raw/2026/",
      "skills/",
      "wiki/",
      "wiki/sources/",
      "CLAUDE.md",
      "raw/2026/c.md",
      "README.md",
      "wiki/a.md",
      "wiki/sources/.gitkeep",
    ]);
  });
});

describe("mcp__repo__*: vault notes live in the memory service, everything else in the clone", () => {
  it("writes, reads, edits and deletes a vault note in the service — never in the clone", async () => {
    const s = setup("crud");

    const w = await s.call("write_file", { path: "wiki/people/kim.md", content: "# Kim\nalpha\n" });
    expect(w.isError).toBeFalsy();
    expect(txt(w)).toBe(`Saved the file wiki/people/kim.md. ${VAULT_NOTE_SAVED}`);
    expect(txt(w)).toBe(
      "Saved the file wiki/people/kim.md. (Vault note: it is saved now — vault notes live in the memory service, not in the repository. There is nothing to commit for it.)",
    );
    expect(s.notes()).toEqual({ "wiki/people/kim.md": "# Kim\nalpha\n" });
    expect(s.inClone("wiki/people/kim.md")).toBe(false);
    // A vault write never needs the clone.
    expect(fs.existsSync(s.clonePath)).toBe(false);

    // A clone file at a vault path (a copy the retired mirror left) is not the vault's: nobody reads it.
    await s.call("list_files"); // clones
    fs.mkdirSync(path.join(s.clonePath, "wiki/people"), { recursive: true });
    fs.writeFileSync(path.join(s.clonePath, "wiki/people/kim.md"), "STALE MIRROR COPY");
    const r = await s.call("read_file", { path: "wiki/people/kim.md" });
    expect(r.isError).toBeFalsy();
    expect(txt(r)).toBe("# Kim\nalpha\n");

    const e = await s.call("edit_file", { path: "wiki/people/kim.md", old_string: "alpha", new_string: "beta" });
    expect(e.isError).toBeFalsy();
    expect(txt(e)).toBe(`Edited wiki/people/kim.md (1 replacement). ${VAULT_NOTE_SAVED}`);
    expect(s.notes()["wiki/people/kim.md"]).toBe("# Kim\nbeta\n");
    expect(s.cloneFile("wiki/people/kim.md")).toBe("STALE MIRROR COPY");

    // Root CLAUDE.md and raw/ notes are vault notes too; every spelling reaches the same note.
    await s.call("write_file", { path: "CLAUDE.md", content: "standing" });
    await s.call("write_file", { path: "./raw//2026/x.md", content: "raw" });
    expect(txt(await s.call("read_file", { path: "raw/2026/y/../x.md" }))).toBe("raw");
    expect(Object.keys(s.notes())).toEqual(["CLAUDE.md", "raw/2026/x.md", "wiki/people/kim.md"]);
    expect(s.inClone("CLAUDE.md")).toBe(false);

    const d = await s.call("delete_file", { path: "wiki/people/kim.md" });
    expect(d.isError).toBeFalsy();
    expect(txt(d)).toBe("Deleted wiki/people/kim.md. (Vault note: the deletion is saved now — there is nothing to commit for it.)");
    expect(s.notes()["wiki/people/kim.md"]).toBeUndefined();
    expect(s.cloneFile("wiki/people/kim.md")).toBe("STALE MIRROR COPY");
    // Already gone = no-op, as a clone delete is.
    expect((await s.call("delete_file", { path: "wiki/people/kim.md" })).isError).toBeFalsy();

    // The memory notice fires exactly as it always did: a successful write/edit under wiki/.
    expect(s.events).toEqual([
      { action: "add", path: "wiki/people/kim.md" },
      { action: "update", path: "wiki/people/kim.md" },
    ]);
  });

  it("maps the vault's sentinels through the tools' existing decoders", async () => {
    const s = setup("sentinels");
    await s.call("write_file", { path: "wiki/a.md", content: "one two one" });

    const missingRead = await s.call("read_file", { path: "wiki/ghost.md" });
    expect(missingRead.isError).toBe(true);
    expect(txt(missingRead)).toBe("The file does not exist. Check the path with mcp__repo__list_files.");

    const missingEdit = await s.call("edit_file", { path: "wiki/ghost.md", old_string: "a", new_string: "b" });
    expect(txt(missingEdit)).toContain("The file does not exist yet. Use mcp__repo__write_file to create it");
    expect(txt(await s.call("edit_file", { path: "wiki/a.md", old_string: "zzz", new_string: "b" }))).toContain("old_string was not found in the file");
    expect(txt(await s.call("edit_file", { path: "wiki/a.md", old_string: "one", new_string: "b" }))).toContain("matches more than one place");
    expect(txt(await s.call("edit_file", { path: "wiki/a.md", old_string: "one", new_string: "one" }))).toContain("Nothing to change");
    const all = await s.call("edit_file", { path: "wiki/a.md", old_string: "one", new_string: "1", replace_all: true });
    expect(txt(all)).toContain("(2 replacements)");
    // No memory notice for a failed edit.
    expect(s.events.filter((e) => e.action === "update")).toHaveLength(1);

    const big = await s.call("write_file", { path: "wiki/big.md", content: "x".repeat(512 * 1024 + 1) });
    expect(big.isError).toBe(true);
    expect(txt(big)).toBe("The content is too large.");
    expect(s.notes()["wiki/big.md"]).toBeUndefined();

    // An absolute path is refused as it always was — it never reaches a clone file at a vault path either.
    const abs = await s.call("read_file", { path: "/wiki/a.md" });
    expect(abs.isError).toBe(true);
    expect(txt(abs)).toBe("Invalid path.");
  });

  it("keeps every path that is not a vault note in the clone, with the text that says it is not committed yet", async () => {
    const s = setup("repo-paths");

    const w = await s.call("write_file", { path: "notes/misc.md", content: "plain" });
    expect(txt(w)).toBe("Saved the file notes/misc.md. (Not committed yet — push it with mcp__repo__commit.)");
    expect(s.cloneFile("notes/misc.md")).toBe("plain");
    // Under wiki/ but not a note the service can hold: stays a repo file.
    for (const [p, c] of [["wiki/.gitkeep", ""], ["wiki/diagram.txt", "d"], ["wiki/.obsidian/app.md", "o"]] as const) {
      const out = await s.call("write_file", { path: p, content: c });
      expect(txt(out)).toBe(`Saved the file ${p}. (Not committed yet — push it with mcp__repo__commit.)`);
      expect(s.inClone(p)).toBe(true);
    }
    expect(txt(await s.call("read_file", { path: "wiki/.obsidian/app.md" }))).toBe("o");
    const e = await s.call("edit_file", { path: "notes/misc.md", old_string: "plain", new_string: "edited" });
    expect(txt(e)).toBe("Edited notes/misc.md (1 replacement). (Not committed yet — push it with mcp__repo__commit.)");
    const mv = await s.call("move_file", { from: "notes/misc.md", to: "docs/misc.md" });
    expect(txt(mv)).toBe("Moved notes/misc.md → docs/misc.md. (Not committed yet — push it with mcp__repo__commit.)");
    const del = await s.call("delete_file", { path: "docs" });
    expect(txt(del)).toBe("Deleted docs. (Not committed yet — push it with mcp__repo__commit.)");
    const sk = await s.call("scaffold_skill", { name: "Deploy Runbook" });
    expect(txt(sk)).toContain("Created a new skill: skills/deploy-runbook/SKILL.md");
    // A plain repo file inside the vault folders is the clone op alone as well.
    const delKeep = await s.call("delete_file", { path: "wiki/.gitkeep" });
    expect(txt(delKeep)).toBe("Deleted wiki/.gitkeep. (Not committed yet — push it with mcp__repo__commit.)");

    // The service is asked for one thing only: whether a NEW file in the vault folders would take the place
    // of a folder of notes (three writes above). Nothing else of these calls reaches it.
    expect(s.fake.calls.map((c) => c.op)).toEqual(["list", "list", "list"]);
    expect(s.notes()).toEqual({});
    // wiki/ writes that are not notes still raise the notice, as they always did.
    expect(s.events.map((ev) => ev.path)).toEqual(["wiki/.gitkeep", "wiki/diagram.txt", "wiki/.obsidian/app.md"]);
  });

  it("lists the clone tree with vault-note entries replaced by the service's notes", async () => {
    const s = setup("list");
    await s.call("write_file", { path: "skills/s/SKILL.md", content: "skill" });
    await s.call("write_file", { path: "wiki/sources/.gitkeep", content: "" });
    await s.call("write_file", { path: "CLAUDE.md", content: "c" });
    await s.call("write_file", { path: "wiki/a.md", content: "a" });
    await s.call("write_file", { path: "wiki/concepts/b.md", content: "b" });
    await s.call("write_file", { path: "raw/2026/c.md", content: "c" });
    // Clone files at vault paths: one that differs from the note, one of a note the service does not hold (its folder exists only for it).
    fs.writeFileSync(path.join(s.clonePath, "wiki/a.md"), "stale");
    fs.mkdirSync(path.join(s.clonePath, "wiki/old"), { recursive: true });
    fs.writeFileSync(path.join(s.clonePath, "wiki/old/gone.md"), "gone");

    const res = await s.call("list_files");
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toBe(
      [
        "Knowledge repository file list:",
        "raw/",
        "raw/2026/",
        "skills/",
        "skills/s/",
        "wiki/",
        "wiki/concepts/",
        "wiki/sources/",
        "CLAUDE.md",
        "raw/2026/c.md",
        "README.md",
        "skills/s/SKILL.md",
        "wiki/a.md",
        "wiki/concepts/b.md",
        "wiki/sources/.gitkeep",
      ].join("\n"),
    );
  });

  it("deletes a folder on both sides: its notes in the service, the rest in the clone", async () => {
    const s = setup("del-folder");
    await s.call("write_file", { path: "wiki/concepts/a.md", content: "a" });
    await s.call("write_file", { path: "wiki/concepts/deep/b.md", content: "b" });
    await s.call("write_file", { path: "wiki/keep.md", content: "k" });
    await s.call("write_file", { path: "wiki/concepts/.gitkeep", content: "" });
    await s.call("write_file", { path: "wiki/concepts/diagram.txt", content: "d" });

    const res = await s.call("delete_file", { path: "wiki/concepts" });
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toBe(
      "Deleted wiki/concepts. (Its 2 vault note(s) are deleted now, with nothing to commit for them. Any other file under it was deleted in Noah's working copy only: Not committed yet — push that part with mcp__repo__commit.)",
    );
    expect(s.notes()).toEqual({ "wiki/keep.md": "k" });
    expect(s.inClone("wiki/concepts")).toBe(false);

    // A folder under wiki/ that holds no note is the clone op, with a repo path's text.
    await s.call("write_file", { path: "wiki/assets/x.txt", content: "x" });
    expect(txt(await s.call("delete_file", { path: "wiki/assets" }))).toBe(
      "Deleted wiki/assets. (Not committed yet — push it with mcp__repo__commit.)",
    );

    // A folder that exists only in the service (the clone has no such folder) is deleted there.
    await s.call("write_file", { path: "raw/2026/x.md", content: "x" });
    const raw = await s.call("delete_file", { path: "raw" });
    expect(txt(raw)).toContain("Its 1 vault note(s) are deleted now");
    expect(s.notes()).toEqual({ "wiki/keep.md": "k" });
  });

  it("says how far a folder delete got when the service fails half-way, and leaves the clone alone", async () => {
    const s = setup("del-partial");
    await s.call("write_file", { path: "wiki/c/a.md", content: "a" });
    await s.call("write_file", { path: "wiki/c/b.md", content: "b" });
    await s.call("write_file", { path: "wiki/c/keep.txt", content: "t" });
    // list → (read, remove) of a.md → read of b.md fails.
    s.fake.beforeNext("remove", () => s.fake.failNext(down(), { op: "read" }));
    const res = await s.call("delete_file", { path: "wiki/c" });
    expectUnavailable(res);
    expect(txt(res)).toContain("1 of the 2 vault note(s) under wiki/c were deleted before this failed");
    expect(s.notes()).toEqual({ "wiki/c/b.md": "b" });
    expect(s.inClone("wiki/c/keep.txt")).toBe(true);
  });

  it("moves a note inside the vault, and between the vault and the repo in both directions", async () => {
    const s = setup("move-file");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });

    const inVault = await s.call("move_file", { from: "wiki/a.md", to: "wiki/concepts/b.md" });
    expect(inVault.isError).toBeFalsy();
    expect(txt(inVault)).toBe(
      "Moved wiki/a.md → wiki/concepts/b.md. (Vault notes: the move is saved now — there is nothing to commit for it.)",
    );
    expect(s.notes()).toEqual({ "wiki/concepts/b.md": "A" });

    // Onto itself: nothing changes (and nothing is deleted).
    expect((await s.call("move_file", { from: "wiki/concepts/b.md", to: "./wiki/concepts/b.md" })).isError).toBeFalsy();
    expect(s.notes()).toEqual({ "wiki/concepts/b.md": "A" });

    const missing = await s.call("move_file", { from: "wiki/ghost.md", to: "wiki/x.md" });
    expect(missing.isError).toBe(true);
    expect(txt(missing)).toBe("The source path does not exist.");

    // Vault → repo: the note leaves the service and becomes a file of the working tree.
    const out = await s.call("move_file", { from: "wiki/concepts/b.md", to: "archive/b.md" });
    expect(out.isError).toBeFalsy();
    expect(txt(out)).toBe(
      "Moved wiki/concepts/b.md → archive/b.md. (The vault notes of this move are saved now, with nothing to commit for them. The files outside the vault changed in Noah's working copy only: Not committed yet — push that part with mcp__repo__commit.)",
    );
    expect(s.notes()).toEqual({});
    expect(s.cloneFile("archive/b.md")).toBe("A");

    // Repo → vault: the file leaves the working tree and becomes a note.
    const back = await s.call("move_file", { from: "archive/b.md", to: "raw/2026/b.md" });
    expect(back.isError).toBeFalsy();
    expect(txt(back)).toContain("The vault notes of this move are saved now");
    expect(s.notes()).toEqual({ "raw/2026/b.md": "A" });
    expect(s.inClone("archive/b.md")).toBe(false);
    expect(s.inClone("raw/2026/b.md")).toBe(false);

    // A repo file moved inside the vault folders stays a clone move with a repo path's text.
    await s.call("write_file", { path: "wiki/pic.txt", content: "p" });
    const plain = await s.call("move_file", { from: "wiki/pic.txt", to: "wiki/img/pic.txt" });
    expect(txt(plain)).toBe("Moved wiki/pic.txt → wiki/img/pic.txt. (Not committed yet — push it with mcp__repo__commit.)");
    expect(s.cloneFile("wiki/img/pic.txt")).toBe("p");
  });

  it("moves a folder on both sides, file by file", async () => {
    const s = setup("move-folder");
    await s.call("write_file", { path: "wiki/concepts/a.md", content: "A" });
    await s.call("write_file", { path: "wiki/concepts/deep/b.md", content: "B" });
    await s.call("write_file", { path: "wiki/concepts/.gitkeep", content: "" });
    await s.call("write_file", { path: "wiki/concepts/deep/pic.txt", content: "P" });
    // A clone file at a vault path is never moved as if it were the note.
    fs.writeFileSync(path.join(s.clonePath, "wiki/concepts/a.md"), "STALE");

    // Inside the vault: notes move in the service, repo files in the clone.
    const res = await s.call("move_file", { from: "wiki/concepts", to: "wiki/ideas" });
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toContain("The vault notes of this move are saved now, with nothing to commit for them. The files outside the vault changed in Noah's working copy only");
    expect(s.notes()).toEqual({ "wiki/ideas/a.md": "A", "wiki/ideas/deep/b.md": "B" });
    expect(s.cloneFile("wiki/ideas/deep/pic.txt")).toBe("P");
    expect(s.inClone("wiki/ideas/.gitkeep")).toBe(true);
    expect(s.inClone("wiki/ideas/a.md")).toBe(false);
    expect(s.inClone("wiki/concepts/deep")).toBe(false);
    const listed = txt(await s.call("list_files"));
    expect(listed).not.toContain("wiki/concepts");

    // Out of the vault: the notes become files of the working tree (with the service's text).
    const out = await s.call("move_file", { from: "wiki/ideas", to: "archive/ideas" });
    expect(out.isError).toBeFalsy();
    expect(s.notes()).toEqual({});
    expect(s.cloneFile("archive/ideas/a.md")).toBe("A");
    expect(s.cloneFile("archive/ideas/deep/b.md")).toBe("B");
    expect(s.cloneFile("archive/ideas/deep/pic.txt")).toBe("P");

    // Into the vault: markdown becomes notes, the rest stays in the clone under the new folder.
    const into = await s.call("move_file", { from: "archive/ideas", to: "raw/ideas" });
    expect(into.isError).toBeFalsy();
    expect(s.notes()).toEqual({ "raw/ideas/a.md": "A", "raw/ideas/deep/b.md": "B" });
    expect(s.cloneFile("raw/ideas/deep/pic.txt")).toBe("P");
    expect(s.inClone("raw/ideas/a.md")).toBe(false);
    expect(s.inClone("archive/ideas")).toBe(false);
    expect(txt(await s.call("list_files"))).not.toContain("archive/ideas");
  });

  it("refuses a folder move it cannot carry out, before anything moves", async () => {
    const s = setup("move-refuse");
    await s.call("write_file", { path: "wiki/a/x.md", content: "X" });
    await s.call("write_file", { path: "wiki/a/keep.txt", content: "K" });
    await s.call("write_file", { path: "wiki/b/y.md", content: "Y" });
    await s.call("write_file", { path: "wiki/c/x.md", content: "ANOTHER X" });
    await s.call("write_file", { path: "wiki/d/keep.txt", content: "ANOTHER K" });
    const before = s.notes();

    // A folder move never overwrites: a destination file with DIFFERENT text stops it, on either side.
    const noteClash = await s.call("move_file", { from: "wiki/a", to: "wiki/c" });
    expect(noteClash.isError).toBe(true);
    expect(txt(noteClash)).toBe(
      "Nothing was moved: the destination already holds 1 file(s) with different content (wiki/c/x.md). A folder move never overwrites — move to a path that does not exist yet, or move those files one by one.",
    );
    const fileClash = await s.call("move_file", { from: "wiki/a", to: "wiki/d" });
    expect(fileClash.isError).toBe(true);
    expect(txt(fileClash)).toContain("with different content (wiki/d/keep.txt)");

    const ontoNote = await s.call("move_file", { from: "wiki/a", to: "wiki/c.md" });
    expect(ontoNote.isError).toBe(true);
    expect(txt(ontoNote)).toContain("A folder cannot be moved to a note path");
    const underNote = await s.call("move_file", { from: "wiki/a", to: "wiki/b/y.md/sub" });
    expect(underNote.isError).toBe(true);
    expect(txt(underNote)).toContain("wiki/b/y.md is a vault note");
    const ontoFile = await s.call("move_file", { from: "wiki/a", to: "wiki/d/keep.txt" });
    expect(ontoFile.isError).toBe(true);
    expect(txt(ontoFile)).toContain("The destination is an existing file, not a folder");
    const intoItself = await s.call("move_file", { from: "wiki/a", to: "wiki/a/sub" });
    expect(intoItself.isError).toBe(true);
    expect(txt(intoItself)).toBe("Invalid path.");
    const noteOntoFolder = await s.call("move_file", { from: "wiki/a/x.md", to: "wiki/b" });
    expect(noteOntoFolder.isError).toBe(true);
    expect(txt(noteOntoFolder)).toContain("The destination is an existing folder");
    const nothing = await s.call("move_file", { from: "wiki/nope", to: "wiki/z" });
    expect(nothing.isError).toBe(true);
    expect(txt(nothing)).toBe("The source path does not exist.");
    expect(s.notes()).toEqual(before);
    expect(s.cloneFile("wiki/a/keep.txt")).toBe("K");
    expect(s.cloneFile("wiki/d/keep.txt")).toBe("ANOTHER K");

    // A destination that holds other files, none of them in the way, is not a clash: the folders merge.
    const merged = await s.call("move_file", { from: "wiki/a", to: "wiki/b" });
    expect(merged.isError, txt(merged)).toBeFalsy();
    expect(s.notes()).toMatchObject({ "wiki/b/x.md": "X", "wiki/b/y.md": "Y" });
    expect(s.notes()["wiki/a/x.md"]).toBeUndefined();
    expect(s.cloneFile("wiki/b/keep.txt")).toBe("K");
  });

  it("finishes a folder move that failed half-way when the same call is made again, and says what is at both paths", async () => {
    const s = setup("move-resume");
    await s.call("write_file", { path: "wiki/a/x.md", content: "X" });
    await s.call("write_file", { path: "wiki/a/y.md", content: "Y" });
    // The first note is copied, then removing its original fails.
    s.fake.failNext(down(), { op: "remove" });
    const failed = await s.call("move_file", { from: "wiki/a", to: "wiki/b" });
    expectUnavailable(failed);
    expect(txt(failed)).toContain("0 of 2 file(s) were moved completely.");
    expect(txt(failed)).toContain("These exist at BOTH paths now (copied; the original is not removed yet): wiki/a/x.md → wiki/b/x.md.");
    expect(txt(failed)).toContain("Call mcp__repo__move_file again with the same arguments to finish");
    expect(s.notes()).toEqual({ "wiki/a/x.md": "X", "wiki/a/y.md": "Y", "wiki/b/x.md": "X" });

    // The same call again: the copy is recognised (not a "destination not empty"), only the original goes.
    const puts = () => s.fake.calls.filter((c) => c.op === "put" && c.path === "wiki/b/x.md").length;
    const putsBefore = puts();
    const again = await s.call("move_file", { from: "wiki/a", to: "wiki/b" });
    expect(again.isError, txt(again)).toBeFalsy();
    expect(s.notes()).toEqual({ "wiki/b/x.md": "X", "wiki/b/y.md": "Y" });
    expect(puts()).toBe(putsBefore);

    // A second failure later in the list: the count is of files moved completely, and the retry still works
    // although the destination now holds a file that has no source any more.
    await s.call("write_file", { path: "wiki/c/1.md", content: "1" });
    await s.call("write_file", { path: "wiki/c/2.md", content: "2" });
    let removes = 0;
    s.fake.beforeNext("remove", () => {
      removes += 1;
      s.fake.failNext(down(), { op: "put" });
    });
    const late = await s.call("move_file", { from: "wiki/c", to: "wiki/d" });
    expectUnavailable(late);
    expect(removes).toBe(1);
    expect(txt(late)).toContain("1 of 2 file(s) were moved completely.");
    expect(txt(late)).toContain("No file of this move exists at both paths; what was not moved is still under wiki/c.");
    const finish = await s.call("move_file", { from: "wiki/c", to: "wiki/d" });
    expect(finish.isError, txt(finish)).toBeFalsy();
    expect(s.notes()).toMatchObject({ "wiki/d/1.md": "1", "wiki/d/2.md": "2" });
    expect(Object.keys(s.notes()).filter((p) => p.startsWith("wiki/c/"))).toEqual([]);

    // One note, same story: copied, original not removed, named, and finished by the same call.
    await s.call("write_file", { path: "wiki/one.md", content: "ONE" });
    s.fake.failNext(down(), { op: "remove" });
    const single = await s.call("move_file", { from: "wiki/one.md", to: "wiki/two.md" });
    expectUnavailable(single);
    expect(txt(single)).toContain("These exist at BOTH paths now (copied; the original is not removed yet): wiki/one.md → wiki/two.md.");
    expect((await s.call("move_file", { from: "wiki/one.md", to: "wiki/two.md" })).isError).toBeFalsy();
    expect(s.notes()["wiki/one.md"]).toBeUndefined();
    expect(s.notes()["wiki/two.md"]).toBe("ONE");
  });

  it("reports an unavailable memory service as such on every tool — never as an empty or missing result", async () => {
    const s = setup("down");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    await s.call("write_file", { path: "wiki/d/b.md", content: "B" });
    await s.call("write_file", { path: "notes/n.txt", content: "N" });

    const cases: Array<[string, Record<string, unknown>]> = [
      ["list_files", {}],
      ["read_file", { path: "wiki/a.md" }],
      ["write_file", { path: "wiki/new.md", content: "x" }],
      ["edit_file", { path: "wiki/a.md", old_string: "A", new_string: "Z" }],
      ["delete_file", { path: "wiki/a.md" }],
      ["delete_file", { path: "wiki/d" }],
      ["move_file", { from: "wiki/a.md", to: "wiki/z.md" }],
      ["move_file", { from: "wiki/d", to: "wiki/e" }],
      ["move_file", { from: "notes/n.txt", to: "wiki/n.md" }],
    ];
    for (const [name, args] of cases) {
      s.fake.failNext(down());
      const res = await s.call(name, args);
      expectUnavailable(res);
    }
    // Nothing was changed by the failed calls, and nothing in the repo was lost.
    expect(s.notes()).toEqual({ "wiki/a.md": "A", "wiki/d/b.md": "B" });
    expect(s.cloneFile("notes/n.txt")).toBe("N");
    expect(s.events.filter((e) => e.path === "wiki/new.md")).toEqual([]);

    // A write whose answer was lost: the model is told the change may have landed.
    s.fake.failNext(down(), { op: "put", applied: true });
    const lost = await s.call("write_file", { path: "wiki/lost.md", content: "L" });
    expectUnavailable(lost);
    expect(txt(lost)).toContain("may or may not have been saved");

    // A server with no memory service configured at all: there is no other place a vault note could be.
    setMemoryClientForTests(s.store, null);
    expectUnavailable(await s.call("read_file", { path: "wiki/a.md" }));
    expectUnavailable(await s.call("list_files"));
    expectUnavailable(await s.call("write_file", { path: "wiki/a.md", content: "never in the clone instead" }));
    expect(s.inClone("wiki/a.md")).toBe(false);
    // The rest of the repo still works.
    expect(txt(await s.call("read_file", { path: "notes/n.txt" }))).toBe("N");
  });

  it("passes a refusal of the service on as the service worded it", async () => {
    const s = setup("refused");
    s.fake.failNext(new MemoryRefusedError("wiki_full", 507, "this wiki already holds 10000 notes; delete or merge notes first"), { op: "put" });
    const full = await s.call("write_file", { path: "wiki/x.md", content: "x" });
    expect(full.isError).toBe(true);
    expect(txt(full)).toBe("The memory service refused this: this wiki already holds 10000 notes; delete or merge notes first");
    const nul = await s.call("write_file", { path: "wiki/nul.md", content: "a\0b" });
    expect(nul.isError).toBe(true);
    expect(txt(nul)).toContain("The memory service refused this: a note is text");
    expect(s.events).toEqual([]);
  });

  it("keeps the owner gate and the no-repo refusal in front of the vault", async () => {
    const s = setup("gates");
    const visitor = buildRepoTools(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: false, config: s.config });
    for (const [name, args] of [
      ["list_files", {}],
      ["read_file", { path: "wiki/a.md" }],
      ["write_file", { path: "wiki/a.md", content: "x" }],
      ["edit_file", { path: "wiki/a.md", old_string: "a", new_string: "b" }],
      ["delete_file", { path: "wiki" }],
      ["move_file", { from: "wiki/a.md", to: "wiki/b.md" }],
    ] as const) {
      const res = await callTool(visitor, name, args);
      expect(res.isError).toBe(true);
      expect(txt(res)).toBe("This tool can only be used by the avatar owner.");
    }
    // A trusted teammate reads the owner's vault, and cannot write it.
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    const mate = buildRepoTools(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: false, elevated: true, config: s.config });
    expect(txt(await callTool(mate, "read_file", { path: "wiki/a.md" }))).toBe("A");
    expect(txt(await callTool(mate, "list_files", {}))).toContain("wiki/a.md");
    expect((await callTool(mate, "write_file", { path: "wiki/a.md", content: "x" })).isError).toBe(true);
    expect(s.fake.calls.every((c) => c.owner === s.ownerId)).toBe(true);

    // No repository connected: the vault is not reachable through the repo tools (the brain needs a repo).
    s.store.setKnowledgeRepo(s.ownerId, null, null);
    const noRepo = await s.call("read_file", { path: "wiki/a.md" });
    expect(noRepo.isError).toBe(true);
    expect(txt(noRepo)).toContain("No knowledge repository is connected yet");
  });
});

describe("the write tools' descriptions (one static catalog)", () => {
  it("say which change needs a commit: a repository file does, a vault note is saved in the memory service at once", () => {
    const s = setup("desc");
    const description = (name: string) => s.tools.find((t) => t.name === name)!.description ?? "";
    const twoKinds =
      "A vault note (CLAUDE.md and the .md notes under wiki/ and raw/) lives in the memory service: the change is saved when this returns and needs no commit. Any other path is a repository file: the change reaches the repository only when you call mcp__repo__commit, so commit after it — until then it exists only in Noah's working copy and may be lost on the next sync. The result says which applies.";
    for (const name of ["write_file", "edit_file", "delete_file", "move_file"]) {
      expect(description(name), name).toContain(twoKinds);
      expect(description(name), name).toContain("(owner only)");
      // Nothing of the retired copy in the repository is promised any more.
      expect(description(name), name).not.toMatch(/mirror|whose vault lives|its copy|repository's copy/i);
    }
    expect(description("commit")).toContain(
      "Vault notes (CLAUDE.md and the .md notes under wiki/ and raw/) are not part of a commit: they are saved in the memory service when written.",
    );
    // A shared-account teammate's run must not read "(owner only)" on the tools it may use.
    const mate = teammateTools(s);
    for (const name of ["write_file", "edit_file", "delete_file", "move_file", "commit"]) {
      const text = mate.tools.find((t) => t.name === name)!.description ?? "";
      expect(text, name).toContain("(shared account: the owner and trusted teammates may write)");
      expect(text, name).not.toContain("(owner only)");
    }
  });
});

describe("mcp__repo__commit: the repository's own files, never a vault note", () => {
  it("commits and pushes the repo paths; a vault note is not in the commit and needs none", async () => {
    const s = setup("commit");
    await s.call("write_file", { path: "wiki/a.md", content: "note A" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain" });

    const res = await s.call("commit", { message: "work" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toBe(`Committed and pushed the changes: ${s.remote}`);
    expect(s.remoteFiles()).toContain("notes/plain.txt");
    expect(s.remoteFiles()).not.toContain("wiki/a.md");
    expect(s.inClone("wiki/a.md")).toBe(false);
    expect(s.notes()).toEqual({ "wiki/a.md": "note A" });

    // Nothing else to commit: the answer says notes need no commit.
    const noop = await s.call("commit", { message: "again" });
    expect(noop.isError).toBeFalsy();
    expect(txt(noop)).toBe(`${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}`);
    expect(txt(noop)).toBe(
      "There are no changes to commit. Vault notes (CLAUDE.md and the .md notes under wiki/ and raw/) are saved in the memory service the moment they are written — there is nothing to commit for them, and they are not copied to the repository.",
    );

    // A vault-only change leaves nothing to commit either — and it is saved all the same.
    await s.call("edit_file", { path: "wiki/a.md", old_string: "note A", new_string: "note A2" });
    await s.call("delete_file", { path: "wiki/a.md" });
    await s.call("write_file", { path: "raw/2026/x.md", content: "raw" });
    const only = await s.call("commit", { message: "notes" });
    expect(only.isError).toBeFalsy();
    expect(txt(only)).toBe(`${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}`);
    expect(s.notes()).toEqual({ "raw/2026/x.md": "raw" });
    expect(s.remoteFiles().filter((f) => f === "CLAUDE.md" || /^(wiki|raw)\/.*\.md$/.test(f))).toEqual([]);
    // The commit never asked the service for anything.
    const before = s.fake.calls.length;
    await s.call("commit", { message: "once more" });
    expect(s.fake.calls.length).toBe(before);
  });

  it("with no clone on disk yet (a vault write never needed one) there is nothing to commit — not a failure", async () => {
    const s = setup("commit-noclone");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    expect(fs.existsSync(s.clonePath)).toBe(false);
    const res = await s.call("commit", { message: "first" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toBe(`${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}`);
    expect(s.remoteFiles()).not.toContain("wiki/a.md");
  });

  it("leaves a repository file at a vault path (a copy the retired mirror left) exactly as it is", async () => {
    const s = setup("commit-old-copy", { files: { "wiki/a.md": "the copy the mirror left\n", "CLAUDE.md": "old standing copy\n" } });
    await s.call("write_file", { path: "wiki/a.md", content: "the vault's text\n" });
    await s.call("write_file", { path: "CLAUDE.md", content: "the vault's standing text\n" });
    await s.call("delete_file", { path: "wiki/a.md" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain" });
    const res = await s.call("commit", { message: "work" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(s.remoteFiles()).toContain("notes/plain.txt");
    expect(s.remoteFile("wiki/a.md")).toBe("the copy the mirror left\n");
    expect(s.remoteFile("CLAUDE.md")).toBe("old standing copy\n");
    expect(s.notes()).toEqual({ "CLAUDE.md": "the vault's standing text\n" });
  });

  it("a conflicting direct git edit of a repository file fails the commit as it always did", async () => {
    const s = setup("commit-conflict");
    await s.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    await s.call("write_file", { path: "notes/plain.txt", content: "plain edited here\n" });
    await s.call("write_file", { path: "wiki/a.md", content: "a note written meanwhile\n" });
    s.pushOutside({ "notes/plain.txt": "plain edited in git\n" });
    const res = await s.call("commit", { message: "second" });
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain("CONFLICT");
    expect(txt(res)).toContain("notes/plain.txt");
    expect(txt(res)).toContain("the shell has no git credentials");
    // Nothing about vault notes is said: they have no part in a commit.
    expect(txt(res)).not.toMatch(/vault/i);
    expect(s.remoteFile("notes/plain.txt")).toBe("plain edited in git\n");
    expect(s.notes()).toEqual({ "wiki/a.md": "a note written meanwhile\n" });
  });

  it("a direct git edit of a vault path in the repository never stops a commit, and is never read back", async () => {
    const s = setup("commit-git-note");
    await s.call("write_file", { path: "wiki/a.md", content: "the vault's text\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    s.pushOutside({ "wiki/a.md": "written directly in git\n" });
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(s.remoteFile("wiki/a.md")).toBe("written directly in git\n");
    expect(txt(await s.call("read_file", { path: "wiki/a.md" }))).toBe("the vault's text\n");
  });

  it("reports a failed push as a failure", async () => {
    const s = setup("commit-push-fails");
    await s.call("write_file", { path: "notes/x.txt", content: "x" }); // clones
    fs.renameSync(s.remote, `${s.remote}.gone`);
    const res = await s.call("commit", { message: "offline" });
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain("Commit/push failed");
  });
});

describe("mcp__repo__create_repo and the vault", () => {
  function createTools(s: Fixture) {
    return buildRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config },
      {
        allowCreate: true,
        createRemoteRepo: async () => ({ ok: true as const, fullName: s.remote, defaultBranch: "main", isPrivate: true }),
      },
    );
  }
  const vaultPathsOf = (files: string[]) => files.filter((p) => p === "CLAUDE.md" || /^(wiki|raw)\/.*\.md$/.test(p));

  it("puts the template's vault notes into the vault and the rest into the first commit, then starts the import", async () => {
    const s = setup("create-fresh", { repo: false });
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("initialized it with the default template");
    expect(txt(res)).toContain("are saved in the owner's vault (the memory service), not in the repository");
    expect(txt(res)).not.toContain("could not all be saved");

    const notes = s.notes();
    expect(Object.keys(notes)).toEqual(["CLAUDE.md", "wiki/_template.md", "wiki/index.md", "wiki/log.md"]);
    expect(notes["wiki/index.md"]).toContain("# Index");
    expect(notes["wiki/log.md"]).toContain("# Reflection log");
    expect(notes["wiki/_template.md"]).toContain("title:");
    // The commit carries the repo files of the template only.
    const pushed = s.remoteFiles();
    expect(pushed).toEqual(expect.arrayContaining([".claude-plugin/marketplace.json", "README.md", "raw/.gitkeep", "wiki/sources/.gitkeep"]));
    expect(vaultPathsOf(pushed)).toEqual([]);
    expect(vaultPathsOf(fs.readdirSync(s.clonePath, { recursive: true }).map((p) => String(p).split(path.sep).join("/")))).toEqual([]);
    // The vault's side of a new connection: store, config, owner — nothing else.
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);
    expect(repoChangedSpy.mock.calls[0]).toEqual([s.store, s.config, s.ownerId]);
  });

  it("never overwrites a note the vault already holds (the vault outlives a disconnected repository)", async () => {
    const s = setup("create-kept", { repo: false });
    s.fake.seed(s.ownerId, "CLAUDE.md", "MY OWN STANDING RULES");
    s.fake.seed(s.ownerId, "wiki/concepts/kept.md", "kept");
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("initialized it with the default template");

    const notes = s.notes();
    expect(notes["CLAUDE.md"]).toBe("MY OWN STANDING RULES");
    expect(notes["wiki/concepts/kept.md"]).toBe("kept");
    expect(notes["wiki/index.md"]).toContain("# Index");
    expect(vaultPathsOf(s.remoteFiles())).toEqual([]);
    expect(repoChangedSpy.mock.calls[0]).toEqual([s.store, s.config, s.ownerId]);
  });

  it("still creates the repository when the memory service is down, and says the starter notes are missing", async () => {
    const s = setup("create-memory-down", { repo: false });
    s.fake.failNext(down());
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("could not all be saved: the memory service is unavailable right now");
    expect(s.remoteFiles()).toContain(".claude-plugin/marketplace.json");
    expect(s.remoteFiles()).not.toContain("CLAUDE.md");
    expect(s.notes()).toEqual({});
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves a repository that brings vault notes of its own exactly as it is (the import judges them)", async () => {
    const s = setup("create-own", { repo: false, files: { "wiki/index.md": "# Their index\n", "CLAUDE.md": "# Their rules\n" } });
    s.fake.seed(s.ownerId, "wiki/mine.md", "mine");
    const before = s.remoteFiles();
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Skipped the default template: this repository already holds vault notes of its own");
    expect(txt(res)).toContain("imported into the owner's vault in the background only if that vault is still empty");
    expect(s.remoteFiles()).toEqual(before);
    expect(s.remoteFile("CLAUDE.md")).toBe("# Their rules\n");
    expect(s.cloneFile("wiki/index.md")).toBe("# Their index\n");
    expect(s.notes()).toEqual({ "wiki/mine.md": "mine" });
    expect(repoChangedSpy.mock.calls[0]).toEqual([s.store, s.config, s.ownerId]);
  });

  it("writes the template inside the owner's vault write queue, like every other vault write", async () => {
    const s = setup("create-queued", { repo: false });
    const res = await whileQueued(
      s,
      () => {
        expect(writesOf(s)).toEqual([]);
        expect(s.remoteFiles()).not.toContain(".claude-plugin/marketplace.json");
      },
      () => callTool(createTools(s), "create_repo", { name: "brain" }),
    );
    expect(res.isError, txt(res)).toBeFalsy();
    expect(s.notes()["wiki/index.md"]).toContain("# Index");
    expect(s.notes()["CLAUDE.md"]).toBeTruthy();
    expect(s.remoteFiles()).toContain(".claude-plugin/marketplace.json");
  });
});

describe("mcp__brain__*: the personal brain is read from the memory service", () => {
  const DEPLOY = "---\ntitle: 배포 절차\ntags: [deploy, ops]\n---\n배포는 setup-host.sh 후 compose up 으로 한다.\n";
  const LINK = "---\ntitle: 링크 노트\nteam_page: wiki/howto/deploy.md\n---\n팀 브레인 참조.\n";
  const KEPT = "---\ntitle: 연봉 메모\nteam_share: no\n---\n내 메모\n";

  function teamCtx(s: Fixture, over: Partial<TeamBrainToolsContext> = {}): TeamBrainToolsContext {
    s.store.touchConversation(s.ownerId, "conv-o", s.ownerId, "대화");
    return { read: true, write: true, admin: false, viewerUserId: s.ownerId, conversationId: "conv-o", onCard: vi.fn(), config: s.config, ...over };
  }
  const brain = (s: Fixture, team?: TeamBrainToolsContext) =>
    buildBrainTools(s.store, { avatarUserId: s.ownerId, viewerIsOwner: true, elevated: true, personalActive: true, team, config: s.config });

  async function seedNotes(s: Fixture) {
    for (const [p, c] of [
      ["wiki/howto/deploy.md", DEPLOY],
      ["wiki/concepts/link.md", LINK],
      ["wiki/concepts/pay.md", KEPT],
      ["wiki/index.md", "# Index\n배포 절차\n"],
      ["wiki/log.md", "# log 배포\n"],
    ] as const) {
      expect((await s.call("write_file", { path: p, content: c })).isError).toBeFalsy();
    }
  }

  it("searches the service and reads a note from it", async () => {
    const s = setup("brain");
    await seedNotes(s);
    const tools = brain(s);
    const hit = await callTool(tools, "search", { query: "setup-host", scope: "personal" });
    expect(hit.isError).toBeFalsy();
    expect(txt(hit)).toContain('Top 1 note(s) from your second brain for "setup-host":');
    expect(txt(hit)).toContain("- wiki/howto/deploy.md [deploy, ops]: 배포 절차");
    expect(txt(hit)).toContain("Read a full note with get_note or mcp__repo__read_file.");
    // The search really went to the service, as the owner, under wiki/ — and nothing was put in the clone.
    expect(s.fake.calls.some((c) => c.op === "search" && c.owner === s.ownerId && c.prefix === "wiki")).toBe(true);
    expect(s.inClone("wiki/howto/deploy.md")).toBe(false);

    const miss = await callTool(tools, "search", { query: "zzz-nothing", scope: "personal" });
    expect(miss.isError).toBeFalsy();
    expect(txt(miss)).toBe(
      'No notes in your second brain matched "zzz-nothing". It may not be captured yet — if it is durable, capture it with the brain-ingest skill.',
    );
    const note = await callTool(tools, "get_note", { path: "wiki/howto/deploy.md" });
    expect(note.isError).toBeFalsy();
    expect(txt(note)).toBe(DEPLOY);
    const outside = await callTool(tools, "get_note", { path: "CLAUDE.md" });
    expect(outside.isError).toBe(true);
    expect(txt(outside)).toBe("get_note only reads notes under `wiki/`. Use mcp__repo__read_file for other paths.");
  });

  it("an empty vault whose repository import is still pending says so, and never sends the avatar to build a skeleton", async () => {
    const m = setup("brain-import-pending");
    m.store.setVaultImport(m.ownerId, "import");
    const pending = await callTool(brain(m), "search", { query: "배포", scope: "personal" });
    expect(pending.isError).toBe(true);
    expect(txt(pending)).toContain("Noah is still importing the notes of the connected knowledge repository");
    expect(txt(pending)).toContain("Do NOT run `brain-migrate`");
    expect(txt(pending)).not.toContain("run the `brain-migrate` skill ONCE");
    // Once the import is over, an empty vault is the ordinary empty vault again.
    m.store.clearVaultImport(m.ownerId);
    expect(txt(await callTool(brain(m), "search", { query: "배포", scope: "personal" }))).toContain("run the `brain-migrate` skill ONCE");
  });

  it("an empty vault may be lost data, not a repository to migrate — and the clone's files never stand in for it", async () => {
    // No note under wiki/ or raw/ in the service. That is either a vault nobody wrote yet or a service that
    // lost its data — the answer must not send the avatar off to recreate notes that existed.
    const m = setup("brain-empty");
    const inService = await callTool(brain(m), "search", { query: "배포", scope: "personal" });
    expect(inService.isError).toBe(true);
    expect(txt(inService)).toBe(
      "Your second brain holds no `wiki/` note (it lives in the memory service, not in the repository). If nothing was ever captured, run the `brain-migrate` skill ONCE to create the vault skeleton (it never overwrites existing notes), then capture notes with the `brain-ingest` skill and retry. If notes existed before, do NOT recreate them: the memory service may have lost its data — tell the owner to report it to an admin. Do not use Bash — use the repo tools.",
    );
    expect(txt(inService)).not.toMatch(/pi-gateway/i);
    // The clone holding files at vault paths changes nothing: the vault is the service, and it is empty.
    const copies = setup("brain-empty-copies", { files: { "wiki/concepts/old.md": "---\ntitle: 배포\n---\n배포 메모\n" } });
    await copies.call("list_files"); // clones
    const withCopies = await callTool(brain(copies), "search", { query: "배포", scope: "personal" });
    expect(withCopies.isError).toBe(true);
    expect(txt(withCopies)).toContain("it lives in the memory service, not in the repository");
    expect(txt(withCopies)).toContain("do NOT recreate them");
    const fromClone = await callTool(brain(copies), "get_note", { path: "wiki/concepts/old.md" });
    expect(fromClone.isError).toBe(true);
    expect(txt(fromClone)).toBe("No such note in your second brain. Check the path with mcp__brain__search or mcp__repo__list_files.");

    // No repository connected: the brain needs one, and the service is not asked.
    const none = setup("brain-no-repo", { repo: false });
    const noRepo = await callTool(brain(none), "search", { query: "배포", scope: "personal" });
    expect(noRepo.isError).toBe(true);
    expect(txt(noRepo)).toContain("No knowledge repository is connected yet");
    expect(none.fake.calls).toEqual([]);
  });

  it("drops the structural pages from a search", async () => {
    const s = setup("brain-structural");
    const tools = brain(s);
    await seedNotes(s);
    const res = txt(await callTool(tools, "search", { query: "배포", scope: "personal" }));
    expect(res).toContain("wiki/howto/deploy.md");
    expect(res).not.toContain("wiki/index.md");
    expect(res).not.toContain("wiki/log.md");
  });

  it("computes the team marks from the note the service returned", async () => {
    const s = setup("brain-marks");
    await seedNotes(s);
    const tools = brain(s, teamCtx(s, { write: false }));
    const link = await callTool(tools, "get_note", { path: "wiki/concepts/link.md" });
    expect(link.isError).toBeFalsy();
    expect(txt(link)).toContain("wiki/concepts/link.md is a LINK note");
    expect(txt(link)).toContain("the canonical version is wiki/howto/deploy.md (not in the team brain any more)");
    expect(txt(link)).toContain(LINK);
    const found = await callTool(tools, "search", { query: "링크 노트", scope: "personal" });
    expect(txt(found)).toContain("Team-brain links of these notes");
    expect(txt(found)).toContain("wiki/concepts/link.md is a LINK note");
  });

  it("resolves personalNotes against the service: the blob is git's id of the note, link and kept notes are refused", async () => {
    const s = setup("brain-personal-notes");
    await seedNotes(s);
    await seedTeamVault(s.config, [{ path: "wiki/howto/seed.md", content: teamPage({ title: "Seed" }) }]);
    const ctx = teamCtx(s);
    const tools = brain(s, ctx);
    const share = (personalNotes: string[]) => ({
      title: "배포 절차 정리",
      summary: "s",
      changes: [{ path: "wiki/howto/deploy.md", op: "create", content: teamPage({ title: "배포 절차" }) }],
      personalNotes,
    });

    const ok = await callTool(tools, "prepare_team_changes", share(["wiki/howto/deploy.md"]));
    expect(ok.isError, txt(ok)).toBeFalsy();
    expect(txt(ok)).toContain("Linked personal note(s): wiki/howto/deploy.md");
    const id = (ctx.onCard as ReturnType<typeof vi.fn>).mock.calls[0][0].proposalId as string;
    const row = s.store.getTeamBrainProposal(id)!;
    const gitBlob = execFileSync("git", ["hash-object", "--stdin"], { input: DEPLOY }).toString().trim();
    expect(row.personalNotes).toEqual([{ path: "wiki/howto/deploy.md", blob: gitBlob }]);
    expect(personalNoteBlobId(DEPLOY)).toBe(gitBlob);

    const refused = async (p: string) => {
      const res = await callTool(tools, "prepare_team_changes", share([p]));
      expect(res.isError).toBe(true);
      expect(txt(res)).toContain("cannot be linked");
      return txt(res);
    };
    expect(await refused("wiki/concepts/link.md")).toContain("already a link note to the team brain");
    expect(await refused("wiki/concepts/pay.md")).toContain("marked `team_share: no`");
    expect(await refused("wiki/howto/ghost.md")).toContain("no such note in the personal brain");
    // The service being down is not "no such note".
    s.fake.failNext(down(), { op: "read" });
    const outage = await refused("wiki/howto/deploy.md");
    expect(outage).toContain("the memory service is unavailable right now");
    expect(outage).toContain("does NOT mean the note is missing");
    expect(outage).not.toContain("no such note");
  });

  it("reports an unavailable memory service as such — also next to team hits", async () => {
    const s = setup("brain-down");
    await seedNotes(s);
    await seedTeamVault(s.config, [{ path: "wiki/howto/deploy.md", content: teamPage({ title: "배포 절차" }) }]);
    const tools = brain(s, teamCtx(s, { write: false }));

    s.fake.failNext(down(), { op: "search" });
    expectUnavailable(await callTool(tools, "search", { query: "배포", scope: "personal" }));

    // Both brains: the team hits are shown, and the personal half still says it could not be searched.
    s.fake.failNext(down(), { op: "search" });
    const both = await callTool(tools, "search", { query: "배포" });
    expect(both.isError).toBe(true);
    expect(txt(both)).toContain("wiki/howto/deploy.md");
    expect(txt(both)).toContain("unavailable right now");
    expect(txt(both)).toContain("This is NOT an empty result");

    // A mark that cannot be computed fails the search instead of silently dropping the mark.
    s.fake.failNext(down(), { op: "read" });
    expectUnavailable(await callTool(tools, "search", { query: "링크 노트", scope: "personal" }));

    s.fake.failNext(down(), { op: "read" });
    expectUnavailable(await callTool(tools, "get_note", { path: "wiki/howto/deploy.md" }));

    const missing = await callTool(tools, "get_note", { path: "wiki/howto/ghost.md" });
    expect(missing.isError).toBe(true);
    expect(txt(missing)).toBe("No such note in your second brain. Check the path with mcp__brain__search or mcp__repo__list_files.");
  });

  it("still reads a wiki/ file that is not a vault note from the clone", async () => {
    const s = setup("brain-nonnote");
    await s.call("write_file", { path: "wiki/diagram.txt", content: "DIAGRAM" });
    const before = s.fake.calls.length;
    const res = await callTool(brain(s), "get_note", { path: "wiki/diagram.txt" });
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toBe("DIAGRAM");
    expect(s.fake.calls.length).toBe(before);
  });
});

describe("a tool that changes a vault note runs inside the owner's vault write queue", () => {
  const NOTES = { "wiki/a.md": "one", "wiki/t/n.md": "N", "wiki/m/x.md": "X" };

  it("a write, edit, delete or move waits for whatever holds the queue, then runs", async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown>; check: (s: Fixture, res: ToolResult) => void }> = [
      {
        tool: "write_file",
        args: { path: "wiki/new.md", content: "NEW" },
        check: (s, res) => {
          expect(txt(res)).toBe(`Saved the file wiki/new.md. ${VAULT_NOTE_SAVED}`);
          expect(s.notes()["wiki/new.md"]).toBe("NEW");
        },
      },
      {
        tool: "edit_file",
        args: { path: "wiki/a.md", old_string: "one", new_string: "two" },
        check: (s, res) => {
          expect(txt(res)).toContain(VAULT_NOTE_SAVED);
          expect(s.notes()["wiki/a.md"]).toBe("two");
        },
      },
      {
        tool: "delete_file",
        args: { path: "wiki/a.md" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault note: the deletion is saved now");
          expect(s.notes()["wiki/a.md"]).toBeUndefined();
        },
      },
      {
        tool: "delete_file",
        args: { path: "wiki/t" },
        check: (s, res) => {
          expect(txt(res)).toContain("Its 1 vault note(s) are deleted now");
          expect(s.notes()["wiki/t/n.md"]).toBeUndefined();
        },
      },
      {
        tool: "move_file",
        args: { from: "wiki/a.md", to: "wiki/b.md" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault notes: the move is saved now");
          expect(s.notes()["wiki/b.md"]).toBe("one");
          expect(s.notes()["wiki/a.md"]).toBeUndefined();
        },
      },
      {
        tool: "move_file",
        args: { from: "wiki/m", to: "wiki/m2" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault notes: the move is saved now");
          expect(s.notes()["wiki/m2/x.md"]).toBe("X");
          expect(s.notes()["wiki/m/x.md"]).toBeUndefined();
        },
      },
    ];
    for (const [i, c] of cases.entries()) {
      const s = setup(`queue-${i}`);
      for (const [p, content] of Object.entries(NOTES)) s.fake.seed(s.ownerId, p, content);
      const res = await whileQueued(
        s,
        () => {
          // Still waiting: nothing was written, and what was there is untouched.
          expect(writesOf(s), c.tool).toEqual([]);
          expect(s.notes()).toEqual(NOTES);
        },
        () => s.call(c.tool, c.args),
      );
      expect(res.isError, `${c.tool}: ${txt(res)}`).toBeFalsy();
      c.check(s, res);
      // Nothing of a vault change lands in the clone.
      expect(fs.existsSync(path.join(s.clonePath, "wiki"))).toBe(false);
    }
  });

  it("two edits of one note that race both land (the second reads what the first wrote)", async () => {
    const s = setup("queue-race");
    await s.call("write_file", { path: "wiki/a.md", content: "one two" });
    const [a, b] = await Promise.all([
      s.call("edit_file", { path: "wiki/a.md", old_string: "one", new_string: "1" }),
      s.call("edit_file", { path: "wiki/a.md", old_string: "two", new_string: "2" }),
    ]);
    expect(a.isError, txt(a)).toBeFalsy();
    expect(b.isError, txt(b)).toBeFalsy();
    expect(s.notes()["wiki/a.md"]).toBe("1 2");
  });

  it("does not queue a path that is not a vault path, nor a caller the gate refuses", async () => {
    const s = setup("queue-not");
    let release!: () => void;
    const held = withVaultWriteLock(s.store, s.ownerId, () => new Promise<void>((resolve) => (release = resolve)));
    // While the queue is held, repo paths and reads go through; a refused caller is refused at once.
    expect(txt(await s.call("write_file", { path: "notes/x.txt", content: "x" }))).toContain("Saved the file notes/x.txt");
    expect(txt(await s.call("delete_file", { path: "notes/x.txt" }))).toContain("Deleted notes/x.txt");
    expect((await s.call("list_files")).isError).toBeFalsy();
    expect((await s.call("read_file", { path: "wiki/ghost.md" })).isError).toBe(true);
    const visitor = buildRepoTools(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: false, config: s.config });
    expect(txt(await callTool(visitor, "write_file", { path: "wiki/a.md", content: "x" }))).toBe("This tool can only be used by the avatar owner.");
    release();
    await held;
  });
});

describe("D4: the tools never touch a clone file at a vault path", () => {
  it("a folder delete or move leaves the repository's own files at vault paths alone, and the next commit does not push their deletion", async () => {
    // The connected repository holds markdown of its own under wiki/topic (never imported: the vault was not empty).
    const s = setup("d4-own", { files: { "wiki/topic/theirs.md": "the repository's own note\n", "wiki/topic/asset.txt": "asset\n" } });
    s.fake.seed(s.ownerId, "wiki/topic/mine.md", "the vault's note\n");

    const del = await s.call("delete_file", { path: "wiki/topic" });
    expect(del.isError, txt(del)).toBeFalsy();
    expect(txt(del)).toContain("Its 1 vault note(s) are deleted now");
    expect(s.notes()).toEqual({});
    expect(s.cloneFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.inClone("wiki/topic/asset.txt")).toBe(false);

    const commit = await s.call("commit", { message: "cleanup" });
    expect(commit.isError, txt(commit)).toBeFalsy();
    expect(s.remoteFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.remoteFiles()).not.toContain("wiki/topic/asset.txt");

    // The same for a move: nothing of the repository's own notes moves, in the clone or in the remote.
    s.fake.seed(s.ownerId, "wiki/topic/mine.md", "the vault's note\n");
    const mv = await s.call("move_file", { from: "wiki/topic", to: "archive/topic" });
    expect(mv.isError, txt(mv)).toBeFalsy();
    expect(s.cloneFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.cloneFile("archive/topic/mine.md")).toBe("the vault's note\n");
    expect(s.inClone("archive/topic/theirs.md")).toBe(false);
    const moved = await s.call("commit", { message: "moved" });
    expect(moved.isError, txt(moved)).toBeFalsy();
    expect(s.remoteFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.remoteFile("archive/topic/mine.md")).toBe("the vault's note\n");
  });

  it("a folder that exists only as clone copies of notes does not exist", async () => {
    const s = setup("d4-clone-only", { files: { "wiki/old/gone.md": "a copy the service no longer has\n" } });
    await s.call("list_files"); // clones
    const mv = await s.call("move_file", { from: "wiki/old", to: "wiki/new" });
    expect(mv.isError).toBe(true);
    expect(txt(mv)).toBe("The source path does not exist.");
    const del = await s.call("delete_file", { path: "wiki/old" });
    expect(del.isError).toBeFalsy();
    expect(s.cloneFile("wiki/old/gone.md")).toBe("a copy the service no longer has\n");
    expect(s.inClone("wiki/new")).toBe(false);
    expect(txt(await s.call("list_files"))).not.toContain("wiki/old");
  });

  it("refuses a repo path that would take the place of the vault's notes, or sit under one", async () => {
    const s = setup("d4-collision");
    await s.call("write_file", { path: "wiki/topic/a.md", content: "A" });
    const file = await s.call("write_file", { path: "wiki/topic", content: "a file where a folder of notes is" });
    expect(file.isError).toBe(true);
    expect(txt(file)).toBe(
      "wiki/topic cannot be a file: the vault holds notes in a folder of that name (e.g. wiki/topic/a.md). Choose another path, or a note path ending in .md inside that folder.",
    );
    const under = await s.call("write_file", { path: "wiki/topic/a.md/x.txt", content: "x" });
    expect(under.isError).toBe(true);
    expect(txt(under)).toBe("wiki/topic/a.md/x.txt cannot be created: wiki/topic/a.md is a vault note, not a folder. Choose another path.");
    await s.call("write_file", { path: "notes/n.txt", content: "N" });
    const moved = await s.call("move_file", { from: "notes/n.txt", to: "wiki/topic" });
    expect(moved.isError).toBe(true);
    expect(txt(moved)).toContain("The destination is an existing folder");
    const movedUnder = await s.call("move_file", { from: "notes/n.txt", to: "wiki/topic/a.md/n.txt" });
    expect(movedUnder.isError).toBe(true);
    expect(txt(movedUnder)).toContain("wiki/topic/a.md is a vault note, not a folder");
    expect(s.inClone("wiki/topic")).toBe(false);
    expect(s.cloneFile("notes/n.txt")).toBe("N");
    expect(s.events.filter((e) => e.path === "wiki/topic")).toEqual([]);
    // The service being down is not "no collision".
    s.fake.failNext(down());
    expectUnavailable(await s.call("write_file", { path: "wiki/other", content: "x" }));
    expect(s.inClone("wiki/other")).toBe(false);
  });

  it("refuses a path that reaches the clone's vault folders through a link in the repository", async () => {
    const s = setup("d4-alias", { files: { "wiki/a.md": "THE CLONE'S FILE\n" } });
    await s.call("list_files"); // clones
    fs.symlinkSync("wiki", path.join(s.clonePath, "notes"));
    const refused = [
      await s.call("read_file", { path: "notes/a.md" }),
      await s.call("write_file", { path: "notes/a.md", content: "through the link" }),
      await s.call("write_file", { path: "notes/new.md", content: "through the link" }),
      await s.call("edit_file", { path: "notes/a.md", old_string: "CLONE", new_string: "X" }),
      await s.call("delete_file", { path: "notes/a.md" }),
      await s.call("move_file", { from: "notes/a.md", to: "elsewhere.md" }),
      await s.call("move_file", { from: "README.md", to: "notes/readme.md" }),
    ];
    for (const res of refused) {
      expect(res.isError).toBe(true);
      expect(txt(res)).toBe("Invalid path.");
    }
    expect(s.cloneFile("wiki/a.md")).toBe("THE CLONE'S FILE\n");
    expect(s.inClone("wiki/new.md")).toBe(false);
    expect(s.inClone("README.md")).toBe(true);
    // The link itself can be removed (that touches no vault file).
    const unlink = await s.call("delete_file", { path: "notes" });
    expect(unlink.isError, txt(unlink)).toBeFalsy();
    expect(s.inClone("notes")).toBe(false);
    expect(s.cloneFile("wiki/a.md")).toBe("THE CLONE'S FILE\n");
  });

  it("classifies a path the same way in mcp__brain__get_note: `wiki/a.md/` is the note, not the clone's file (review)", async () => {
    const s = setup("d4-getnote", { files: { "wiki/a.md": "THE CLONE'S FILE (not the vault's)\n" } });
    await s.call("list_files"); // clones
    s.fake.seed(s.ownerId, "wiki/a.md", "the vault's text\n");
    const tools = buildBrainTools(s.store, { avatarUserId: s.ownerId, viewerIsOwner: true, config: s.config });
    for (const p of ["wiki/a.md/", "wiki//a.md", "/wiki/x/../a.md", "wiki/a.md"]) {
      const res = await callTool(tools, "get_note", { path: p });
      expect(res.isError, `${p}: ${txt(res)}`).toBeFalsy();
      expect(txt(res), p).toBe("the vault's text\n");
    }
    expect(txt(await s.call("read_file", { path: "wiki/a.md/" }))).toBe("the vault's text\n");
  });
});


describe("a shared account: a trusted teammate writes as today", () => {
  it("writes, edits and moves a vault note of the owner's vault, and commits a repository file", async () => {
    const s = setup("shared");
    const mate = teammateTools(s);
    const w = await mate.call("write_file", { path: "wiki/from-mate.md", content: "# from a teammate\n" });
    expect(w.isError, txt(w)).toBeFalsy();
    expect(txt(w)).toBe(`Saved the file wiki/from-mate.md. ${VAULT_NOTE_SAVED}`);
    const e = await mate.call("edit_file", { path: "wiki/from-mate.md", old_string: "teammate", new_string: "trusted teammate" });
    expect(e.isError, txt(e)).toBeFalsy();
    const mv = await mate.call("move_file", { from: "wiki/from-mate.md", to: "wiki/team/from-mate.md" });
    expect(mv.isError, txt(mv)).toBeFalsy();
    // The vault is the OWNER's: every service call is made as the owner, never as the teammate.
    expect(s.fake.calls.every((c) => c.owner === s.ownerId)).toBe(true);
    expect(s.notes()).toEqual({ "wiki/team/from-mate.md": "# from a trusted teammate\n" });
    expect(txt(await mate.call("read_file", { path: "wiki/team/from-mate.md" }))).toBe("# from a trusted teammate\n");

    // Only vault notes changed so far: nothing to commit.
    const nothing = await mate.call("commit", { message: "mate: add note" });
    expect(txt(nothing)).toBe(`${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}`);
    const f = await mate.call("write_file", { path: "notes/from-mate.txt", content: "a repository file\n" });
    expect(txt(f)).toBe("Saved the file notes/from-mate.txt. (Not committed yet — push it with mcp__repo__commit.)");
    const c = await mate.call("commit", { message: "mate: add file" });
    expect(c.isError, txt(c)).toBeFalsy();
    expect(txt(c)).toContain("Committed and pushed the changes");
    expect(s.remoteFile("notes/from-mate.txt")).toBe("a repository file\n");
    expect(s.remoteFiles()).not.toContain("wiki/team/from-mate.md");
    // As today: authored as the owner, the teammate in the trailer and in the audit trail.
    expect(s.remoteLog()).toContain("Co-authored-by: Mate <mate@noah-almighty.local>");
    const push = s.store.listAudit(s.ownerId, true, 50).find((a) => a.action === "knowledge_repo_push");
    expect(push?.actorUserId).toBe(mate.mate.id);
    expect(push?.detail).toContain("shared account");
  });
});

describe("mcp__brain__search scope all: a personal side that could not be searched is said, next to the team hits", () => {
  it("reports a refusal of the memory service as an error, like an outage", async () => {
    const s = setup("brain-refused");
    await s.call("write_file", { path: "wiki/howto/deploy.md", content: "---\ntitle: 배포 절차\n---\n배포는 compose up.\n" });
    await seedTeamVault(s.config, [{ path: "wiki/howto/deploy.md", content: teamPage({ title: "배포 절차" }) }]);
    s.store.touchConversation(s.ownerId, "conv-o", s.ownerId, "대화");
    const tools = buildBrainTools(s.store, {
      avatarUserId: s.ownerId,
      viewerIsOwner: true,
      elevated: true,
      personalActive: true,
      team: { read: true, write: false, admin: false, viewerUserId: s.ownerId, conversationId: "conv-o", config: s.config },
      config: s.config,
    });
    s.fake.failNext(new MemoryRefusedError("invalid_query", 400, "the query has more than 500 characters"), { op: "search" });
    const both = await callTool(tools, "search", { query: "배포" });
    expect(both.isError).toBe(true);
    expect(txt(both)).toContain("wiki/howto/deploy.md");
    expect(txt(both)).toContain(
      "Your second brain could not be searched: The memory service refused this: the query has more than 500 characters This is NOT an empty result.",
    );
    s.fake.failNext(new MemoryRefusedError("invalid_query", 400, "the query has more than 500 characters"), { op: "search" });
    const personal = await callTool(tools, "search", { query: "배포", scope: "personal" });
    expect(personal.isError).toBe(true);
    expect(txt(personal)).toContain("could not be searched");
    // An ordinary personal error (an empty vault) still gives way to the team hits, as before.
    const empty = setup("brain-refused-empty");
    await seedTeamVault(empty.config, [{ path: "wiki/howto/deploy.md", content: teamPage({ title: "배포 절차" }) }]);
    empty.store.touchConversation(empty.ownerId, "conv-o", empty.ownerId, "대화");
    const emptyTools = buildBrainTools(empty.store, {
      avatarUserId: empty.ownerId,
      viewerIsOwner: true,
      elevated: true,
      personalActive: true,
      team: { read: true, write: false, admin: false, viewerUserId: empty.ownerId, conversationId: "conv-o", config: empty.config },
      config: empty.config,
    });
    const teamOnly = await callTool(emptyTools, "search", { query: "배포" });
    expect(teamOnly.isError).toBeFalsy();
    expect(txt(teamOnly)).toContain("wiki/howto/deploy.md");
  });
});
