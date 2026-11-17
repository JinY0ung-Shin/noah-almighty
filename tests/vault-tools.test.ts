// Personal vault in the memory service (noah-almighty#84), Lane B — the avatar's
// tools: `mcp__repo__*` (repoTools.ts / repoToolKit.ts) and `mcp__brain__*`
// (brainTools.ts) for an owner whose vault home is `memory`, next to a
// regression block proving a repo-home owner gets exactly what they always got.
//
// The memory service is the in-process fake (tests/helpers/fakeMemory.ts); the
// knowledge repo is a local bare remote, so clone/commit/push run offline. The
// mirror (`vaultMirror.ts`) is the real one behind a spy, so a commit is checked
// end to end (the note really lands in the remote) and its failures can be
// scripted.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/server/vaultMirror.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/vaultMirror.js")>();
  return { ...real, syncVaultMirror: vi.fn(real.syncVaultMirror) };
});
vi.mock("../src/server/vaultMigration.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/vaultMigration.js")>();
  return { ...real, onKnowledgeRepoChanged: vi.fn() };
});

import request from "supertest";
import { createApp, createServices } from "../src/server/app.js";
import { buildRepoTools } from "../src/server/agent/repoTools.js";
import { buildBrainTools, personalNoteBlobId } from "../src/server/agent/brainTools.js";
import { buildSkillExchangeTools } from "../src/server/agent/skillExchangeTools.js";
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
import { knowledgeClonePath, listTree } from "../src/server/knowledgeRepo.js";
import { cutoverVault, onKnowledgeRepoChanged } from "../src/server/vaultMigration.js";
import { syncVaultMirror } from "../src/server/vaultMirror.js";
import { callTool, gitInit, makeBareRemote, withTempDir, type ToolResult } from "./helpers.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";
import { seedTeamVault, teamPage } from "./team-brain-fixtures.js";

let tempDir: string;
const getTempDir = withTempDir("vault-tools", () => {
  tempDir = getTempDir();
});

const mirrorSpy = vi.mocked(syncVaultMirror);
const repoChangedSpy = vi.mocked(onKnowledgeRepoChanged);
beforeEach(() => {
  mirrorSpy.mockClear();
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

/** A store + owner on a local bare remote; `memory: true` puts the owner's vault home in the (fake) memory service. */
function setup(name: string, opts: { memory?: boolean; repo?: boolean; files?: Record<string, string> } = {}) {
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
  if (opts.memory !== false) store.setPersonalVaultMemory(user.id, { sourceRepo: remote, sourceCommit: null });
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
 * (a cutover, a rollback), let `change` happen while it waits, then let it run.
 */
async function whileQueued(s: Fixture, change: () => void, call: () => Promise<ToolResult>): Promise<ToolResult> {
  let release!: () => void;
  const held = withVaultWriteLock(s.store, s.ownerId, () => new Promise<void>((resolve) => (release = resolve)));
  const pending = call();
  await tick();
  await tick();
  change();
  release();
  await held;
  return pending;
}

/** What a finished cutover leaves: the row, and the given notes in the service. */
function flipToMemory(s: Fixture, notes: Record<string, string> = {}): void {
  for (const [p, c] of Object.entries(notes)) s.fake.seed(s.ownerId, p, c);
  s.store.setPersonalVaultMemory(s.ownerId, { sourceRepo: s.remote, sourceCommit: null });
}

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
        { type: "file", path: "CLAUDE.md" }, // the mirror's copy
        { type: "file", path: "wiki/old/gone.md" }, // a mirror copy of a note the service no longer has
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

describe("mcp__repo__* for an owner whose vault is in the memory service", () => {
  it("writes, reads, edits and deletes a vault note in the service — never in the clone", async () => {
    const s = setup("crud");

    const w = await s.call("write_file", { path: "wiki/people/kim.md", content: "# Kim\nalpha\n" });
    expect(w.isError).toBeFalsy();
    expect(txt(w)).toBe(`Saved the file wiki/people/kim.md. ${VAULT_NOTE_SAVED}`);
    expect(txt(w)).toBe(
      "Saved the file wiki/people/kim.md. (Vault note: it is saved now. It needs no commit to exist; mcp__repo__commit pushes its copy to the repository.)",
    );
    expect(s.notes()).toEqual({ "wiki/people/kim.md": "# Kim\nalpha\n" });
    expect(s.inClone("wiki/people/kim.md")).toBe(false);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(true);

    // The clone's copy is the mirror's and may be behind: nobody reads it.
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
    expect(txt(d)).toBe(
      "Deleted wiki/people/kim.md. (Vault note: the deletion is saved now. It needs no commit to take effect; mcp__repo__commit pushes it to the repository's copy.)",
    );
    expect(s.notes()["wiki/people/kim.md"]).toBeUndefined();
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

    // An absolute path is refused as it always was — it never reaches the clone's mirror copy either.
    const abs = await s.call("read_file", { path: "/wiki/a.md" });
    expect(abs.isError).toBe(true);
    expect(txt(abs)).toBe("Invalid path.");
  });

  it("keeps every path that is not a vault note in the clone, with today's text", async () => {
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
    // Mirror copies in the clone: one behind, one of a note the service no longer holds (its folder exists only for it).
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

  it("renders the same list a repo-home owner gets for the same files", async () => {
    const files: Array<[string, string]> = [
      ["CLAUDE.md", "c"],
      ["wiki/index.md", "i"],
      ["wiki/concepts/한글 노트.md", "k"],
      ["wiki/concepts/b.md", "b"],
      ["wiki/sources/.gitkeep", ""],
      ["raw/.gitkeep", ""],
      ["raw/2026/x.md", "x"],
      ["skills/s/SKILL.md", "s"],
      ["notes/n.md", "n"],
    ];
    const lists: string[] = [];
    for (const memory of [false, true]) {
      const s = setup(`parity-${memory}`, { memory });
      for (const [p, c] of files) expect((await s.call("write_file", { path: p, content: c })).isError).toBeFalsy();
      lists.push(txt(await s.call("list_files")));
      expect(Object.keys(s.notes()).length).toBe(memory ? 5 : 0);
    }
    expect(lists[1]).toBe(lists[0]);
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
      "Deleted wiki/concepts. (Its 2 vault note(s) are deleted now; any other file under it is deleted in the working tree only. mcp__repo__commit pushes both to the repository.)",
    );
    expect(s.notes()).toEqual({ "wiki/keep.md": "k" });
    expect(s.inClone("wiki/concepts")).toBe(false);

    // A folder under wiki/ that holds no note is the clone op, with today's text.
    await s.call("write_file", { path: "wiki/assets/x.txt", content: "x" });
    expect(txt(await s.call("delete_file", { path: "wiki/assets" }))).toBe(
      "Deleted wiki/assets. (Not committed yet — push it with mcp__repo__commit.)",
    );

    // A folder that exists only in the service (not mirrored yet) is deleted there.
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
      "Moved wiki/a.md → wiki/concepts/b.md. (Vault notes: the move is saved now. It needs no commit to take effect; mcp__repo__commit pushes it to the repository's copy.)",
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
      "Moved wiki/concepts/b.md → archive/b.md. (The vault notes of this move are saved now; the files outside the vault changed in the working tree only. mcp__repo__commit pushes both to the repository.)",
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

    // A repo file moved inside the vault folders stays a clone move with today's text.
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
    // A mirror copy in the clone is never moved as if it were the note.
    fs.writeFileSync(path.join(s.clonePath, "wiki/concepts/a.md"), "STALE");

    // Inside the vault: notes move in the service, repo files in the clone.
    const res = await s.call("move_file", { from: "wiki/concepts", to: "wiki/ideas" });
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toContain("The vault notes of this move are saved now; the files outside the vault changed in the working tree only");
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

    // A server with no memory service configured at all, for an owner whose vault lives there.
    setMemoryClientForTests(s.store, null);
    expectUnavailable(await s.call("read_file", { path: "wiki/a.md" }));
    expectUnavailable(await s.call("list_files"));
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

describe("the write tools' descriptions (one static catalog for both vault homes)", () => {
  it("say what is true in both homes: commit pushes to the repository, a vault note in the memory service is saved at once", () => {
    for (const memory of [false, true]) {
      const s = setup(`desc-${memory}`, { memory });
      const description = (name: string) => s.tools.find((t) => t.name === name)!.description ?? "";
      for (const name of ["write_file", "edit_file"]) {
        expect(description(name)).toContain(
          "The change reaches the repository only when you call mcp__repo__commit, so commit after writing. Until then a repository file exists only in Noah's working copy and may disappear on the next sync; a vault note (CLAUDE.md, wiki/, raw/ markdown) of an owner whose vault lives in the memory service is already saved when this returns — the result says which applies.",
        );
      }
      expect(description("delete_file")).toContain(
        "The deletion reaches the repository only when you call mcp__repo__commit, so commit after deleting. Until then a deleted repository file may reappear on the next sync; a vault note of an owner whose vault lives in the memory service is deleted at once — the result says which applies.",
      );
      expect(description("move_file")).toContain(
        "The move reaches the repository only when you call mcp__repo__commit; a vault note of an owner whose vault lives in the memory service is moved at once — the result says which applies.",
      );
      // Nothing a description says depends on the owner's home, and none tells the avatar not to commit.
      for (const name of ["write_file", "edit_file", "delete_file", "move_file"]) {
        expect(description(name)).not.toMatch(/saved only temporarily|no commit needed/);
        expect(description(name)).toContain("(owner only)");
      }
    }
    const repo = setup("desc-a", { memory: false });
    const mem = setup("desc-b", { memory: true });
    expect(mem.tools.map((t) => t.description)).toEqual(repo.tools.map((t) => t.description));
  });
});

describe("mcp__repo__commit for an owner whose vault is in the memory service", () => {
  it("mirrors the vault into the working tree inside the commit, then commits and pushes everything", async () => {
    const s = setup("commit");
    await s.call("write_file", { path: "wiki/a.md", content: "note A" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain" });
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(true);

    const res = await s.call("commit", { message: "work" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain(`Committed and pushed the changes: ${s.remote}`);
    expect(txt(res)).toMatch(/This commit also brought the repository's copy of the vault notes up to date \(\d+ file\(s\)\)\./);
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledWith(s.store, s.config, s.ownerId, { push: false, locked: true });
    expect(s.remoteFiles()).toEqual(expect.arrayContaining(["notes/plain.txt", "wiki/a.md"]));
    expect(s.remoteFile("wiki/a.md")).toBe("note A");
    // Recorded only now that the push went through.
    const row = s.store.getPersonalVault(s.ownerId)!;
    expect(row.mirrorDirty).toBe(false);
    expect(row.mirrorError).toBeNull();
    expect(row.mirrorSyncedAt).not.toBeNull();

    // Nothing else to commit and the mirror has nothing to write: the answer says notes need no commit.
    const noop = await s.call("commit", { message: "again" });
    expect(noop.isError).toBeFalsy();
    expect(txt(noop)).toBe(`${NO_CHANGES} ${VAULT_NOTES_NEED_NO_COMMIT}`);
    expect(txt(noop)).toBe(
      "There are no changes to commit. Vault notes (CLAUDE.md and the .md notes under wiki/ and raw/) are saved the moment they are written — they need no commit to exist; a commit pushes their copy to the repository.",
    );

    // A vault-only change is carried by the next commit too.
    await s.call("edit_file", { path: "wiki/a.md", old_string: "note A", new_string: "note A2" });
    const only = await s.call("commit", { message: "notes" });
    expect(txt(only)).toContain("Committed and pushed the changes");
    expect(s.remoteFile("wiki/a.md")).toBe("note A2");
  });

  it("commits without a clone on disk yet (a vault write never needed one)", async () => {
    const s = setup("commit-noclone");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    expect(fs.existsSync(s.clonePath)).toBe(false);
    const res = await s.call("commit", { message: "first" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(s.remoteFile("wiki/a.md")).toBe("A");
  });

  it("commits the other changes when the mirror fails, is on hold or throws — and says the copy is behind", async () => {
    const s = setup("commit-mirror-fails");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });

    const outcomes = [
      { outcome: { kind: "failed", error: "memory service unavailable (network)" } as const, says: "was NOT updated this time (memory service unavailable (network))" },
      { outcome: { kind: "skipped", reason: "hold" } as const, says: "it is on hold until the owner confirms" },
      { outcome: null, says: "was NOT updated this time (boom)" },
    ];
    for (const [i, c] of outcomes.entries()) {
      await s.call("write_file", { path: `notes/n${i}.txt`, content: String(i) });
      if (c.outcome) mirrorSpy.mockResolvedValueOnce(c.outcome);
      else mirrorSpy.mockRejectedValueOnce(new Error("boom"));
      const res = await s.call("commit", { message: `c${i}` });
      expect(res.isError, txt(res)).toBeFalsy();
      expect(txt(res)).toContain("Committed and pushed the changes");
      expect(txt(res)).toContain(c.says);
      expect(txt(res)).toContain("The notes themselves are saved in the vault; only their copy in the repository is behind.");
      expect(s.remoteFiles()).toContain(`notes/n${i}.txt`);
      expect(s.remoteFiles()).not.toContain("wiki/a.md");
      // Still dirty: the background pass or the next commit retries.
      expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(true);
    }

    // With nothing else to commit, a failed mirror is still reported next to "no changes".
    mirrorSpy.mockResolvedValueOnce({ kind: "failed", error: "memory service unavailable (network)" });
    const noop = await s.call("commit", { message: "noop" });
    expect(noop.isError).toBeFalsy();
    expect(txt(noop)).toContain(NO_CHANGES);
    expect(txt(noop)).toContain(VAULT_NOTES_NEED_NO_COMMIT);
    expect(txt(noop)).toContain("was NOT updated this time");
  });

  it("records the mirror as failed when the push fails after the mirror wrote the working tree", async () => {
    const s = setup("commit-push-fails");
    await s.call("write_file", { path: "notes/x.txt", content: "x" }); // clones
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    fs.renameSync(s.remote, `${s.remote}.gone`);
    const res = await s.call("commit", { message: "offline" });
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain("Commit/push failed");
    const row = s.store.getPersonalVault(s.ownerId)!;
    expect(row.mirrorDirty).toBe(true);
    expect(row.mirrorError).toBeTruthy();
    expect(row.mirrorSyncedAt).toBeNull();
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

  it("tells the migration that a repository was connected (repo-home: the template is committed as always)", async () => {
    const s = setup("create-repo-home", { memory: false, repo: false });
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("initialized it with the default template");
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);
    expect(repoChangedSpy).toHaveBeenCalledWith(s.store, s.config, s.ownerId, null);
    expect(s.remoteFiles()).toEqual(expect.arrayContaining(["CLAUDE.md", "wiki/index.md", "wiki/log.md", "wiki/_template.md", ".claude-plugin/marketplace.json"]));
    expect(s.fake.calls).toEqual([]);
  });

  it("sends the template's vault notes to the service for an owner already in memory, never overwriting a note", async () => {
    const s = setup("create-memory-home", { memory: true, repo: false });
    s.fake.seed(s.ownerId, "CLAUDE.md", "MY OWN STANDING RULES");
    s.fake.seed(s.ownerId, "wiki/concepts/kept.md", "kept");
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("initialized it with the default template");
    expect(txt(res)).not.toContain("could not all be saved");

    const notes = s.notes();
    expect(notes["CLAUDE.md"]).toBe("MY OWN STANDING RULES");
    expect(notes["wiki/concepts/kept.md"]).toBe("kept");
    expect(notes["wiki/index.md"]).toContain("# Index");
    expect(notes["wiki/log.md"]).toContain("# Reflection log");
    expect(notes["wiki/_template.md"]).toContain("title:");
    // The commit carries the repo files of the template only: the repository's copy of a vault note is the mirror's.
    const pushed = s.remoteFiles();
    expect(pushed).toEqual(expect.arrayContaining([".claude-plugin/marketplace.json", "README.md", "raw/.gitkeep", "wiki/sources/.gitkeep"]));
    expect(pushed.filter((p) => p === "CLAUDE.md" || /^(wiki|raw)\/.*\.md$/.test(p))).toEqual([]);
    expect(repoChangedSpy).toHaveBeenCalledWith(s.store, s.config, s.ownerId, null);
  });

  it("still creates the repository when the memory service is down, and says the starter notes are missing", async () => {
    const s = setup("create-memory-down", { memory: true, repo: false });
    s.fake.failNext(down());
    const res = await callTool(createTools(s), "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("could not all be saved: the memory service is unavailable right now");
    expect(s.remoteFiles()).toContain(".claude-plugin/marketplace.json");
    expect(s.remoteFiles()).not.toContain("CLAUDE.md");
    expect(s.notes()).toEqual({});
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);
  });
});

describe("mcp__brain__* for an owner whose vault is in the memory service", () => {
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

  it("searches the service and reads a note from it, with the same result strings as the clone", async () => {
    const results: Array<Record<string, string>> = [];
    for (const memory of [false, true]) {
      const s = setup(`brain-${memory}`, { memory });
      await seedNotes(s);
      const tools = brain(s);
      const out: Record<string, string> = {};
      const hit = await callTool(tools, "search", { query: "setup-host", scope: "personal" });
      expect(hit.isError).toBeFalsy();
      out.hit = txt(hit);
      const miss = await callTool(tools, "search", { query: "zzz-nothing", scope: "personal" });
      expect(miss.isError).toBeFalsy();
      out.miss = txt(miss);
      const note = await callTool(tools, "get_note", { path: "wiki/howto/deploy.md" });
      expect(note.isError).toBeFalsy();
      out.note = txt(note);
      out.outside = txt(await callTool(tools, "get_note", { path: "CLAUDE.md" }));
      results.push(out);
      if (memory) {
        // The search really went to the service, as the owner, under wiki/.
        expect(s.fake.calls.some((c) => c.op === "search" && c.owner === s.ownerId && c.prefix === "wiki")).toBe(true);
        expect(s.inClone("wiki/howto/deploy.md")).toBe(false);
      } else {
        expect(s.fake.calls).toEqual([]);
      }
    }
    const [repo, memory] = results;
    expect(memory).toEqual(repo);
    expect(memory.hit).toContain('Top 1 note(s) from your second brain for "setup-host":');
    expect(memory.hit).toContain("- wiki/howto/deploy.md [deploy, ops]: 배포 절차");
    expect(memory.hit).toContain("Read a full note with get_note or mcp__repo__read_file.");
    expect(memory.miss).toBe(
      'No notes in your second brain matched "zzz-nothing". It may not be captured yet — if it is durable, capture it with the brain-ingest skill.',
    );
    expect(memory.note).toBe(DEPLOY);
    expect(memory.outside).toBe("get_note only reads notes under `wiki/`. Use mcp__repo__read_file for other paths.");
  });

  it("says where an empty vault lives: in the memory service it may be lost data, not a repository to migrate", async () => {
    // Memory home: no note under wiki/ or raw/ in the service. That is either a vault nobody wrote yet or a
    // service that lost its data — the answer must not send the avatar off to recreate notes that existed.
    const m = setup("brain-empty-memory");
    const inService = await callTool(brain(m), "search", { query: "배포", scope: "personal" });
    expect(inService.isError).toBe(true);
    expect(txt(inService)).toBe(
      "Your second brain holds no `wiki/` note (it lives in the memory service, not in the repository). If nothing was ever captured, run the `brain-migrate` skill ONCE to create the vault skeleton, then capture notes with the `brain-ingest` skill and retry. If notes existed before, do NOT recreate them: the memory service may have lost its data — tell the owner to report it to an admin (the knowledge repository still holds the last copy of the notes). Do not use Bash — use the repo tools.",
    );
    expect(txt(inService)).not.toContain("predates the second-brain layout");
    expect(txt(inService)).not.toMatch(/pi-gateway/i);
    // The clone holding copies of notes changes nothing: the vault is the service, and it is empty.
    const copies = setup("brain-empty-memory-copies", { files: { "wiki/concepts/old.md": "---\ntitle: 배포\n---\n배포 메모\n" } });
    await copies.call("list_files"); // clones
    const withCopies = await callTool(brain(copies), "search", { query: "배포", scope: "personal" });
    expect(withCopies.isError).toBe(true);
    expect(txt(withCopies)).toContain("it lives in the memory service, not in the repository");
    expect(txt(withCopies)).toContain("do NOT recreate them");

    // Repo home: the repository itself has no vault folders — the text it always had, and no service call.
    const r = setup("brain-empty-repo", { memory: false });
    const inRepo = await callTool(brain(r), "search", { query: "배포", scope: "personal" });
    expect(inRepo.isError).toBe(true);
    expect(txt(inRepo)).toBe(
      "Your knowledge repository has no `wiki/` vault yet (it predates the second-brain layout). Run the `brain-migrate` skill ONCE to create the vault skeleton (it never overwrites existing files), then capture notes with the `brain-ingest` skill and retry. Do not use Bash — use the repo tools.",
    );
    expect(txt(inRepo)).not.toContain("memory service");
    expect(r.fake.calls).toEqual([]);
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

describe("regression: an owner whose vault home is the repo gets exactly what they always got", () => {
  it("runs every repo tool in the clone with today's strings and never calls the memory service or the mirror", async () => {
    const s = setup("regression", { memory: false });
    expect(txt(await s.call("write_file", { path: "wiki/a.md", content: "one two one" }))).toBe(
      "Saved the file wiki/a.md. (Not committed yet — push it with mcp__repo__commit.)",
    );
    expect(txt(await s.call("write_file", { path: "CLAUDE.md", content: "standing" }))).toBe(
      "Saved the file CLAUDE.md. (Not committed yet — push it with mcp__repo__commit.)",
    );
    expect(s.cloneFile("wiki/a.md")).toBe("one two one");
    expect(txt(await s.call("read_file", { path: "wiki/a.md" }))).toBe("one two one");
    expect(txt(await s.call("edit_file", { path: "wiki/a.md", old_string: "two", new_string: "2" }))).toBe(
      "Edited wiki/a.md (1 replacement). (Not committed yet — push it with mcp__repo__commit.)",
    );
    // A missing file reads as it always did in the clone.
    const ghost = await s.call("read_file", { path: "wiki/ghost.md" });
    expect(ghost.isError).toBe(true);
    expect(txt(ghost)).toBe("Invalid path.");
    expect(txt(await s.call("move_file", { from: "wiki/a.md", to: "wiki/b.md" }))).toBe(
      "Moved wiki/a.md → wiki/b.md. (Not committed yet — push it with mcp__repo__commit.)",
    );
    expect(txt(await s.call("move_file", { from: "wiki/ghost.md", to: "wiki/x.md" }))).toBe("The source path does not exist.");
    await s.call("write_file", { path: "wiki/dir/c.md", content: "c" });
    expect(txt(await s.call("move_file", { from: "wiki/dir", to: "raw/dir" }))).toBe(
      "Moved wiki/dir → raw/dir. (Not committed yet — push it with mcp__repo__commit.)",
    );
    expect(s.cloneFile("raw/dir/c.md")).toBe("c");
    expect(txt(await s.call("list_files"))).toBe(
      ["Knowledge repository file list:", "raw/", "raw/dir/", "wiki/", "CLAUDE.md", "raw/dir/c.md", "README.md", "wiki/b.md"].join("\n"),
    );
    expect(txt(await s.call("delete_file", { path: "raw" }))).toBe("Deleted raw. (Not committed yet — push it with mcp__repo__commit.)");
    expect(txt(await s.call("delete_file", { path: "wiki/b.md" }))).toBe(
      "Deleted wiki/b.md. (Not committed yet — push it with mcp__repo__commit.)",
    );

    const commit = await s.call("commit", { message: "work" });
    expect(commit.isError).toBeFalsy();
    expect(txt(commit)).toBe(`Committed and pushed the changes: ${s.remote}`);
    expect(s.remoteFile("CLAUDE.md")).toBe("standing");
    const noop = await s.call("commit", { message: "again" });
    expect(txt(noop)).toBe("There are no changes to commit.");

    expect(s.events).toEqual([
      { action: "add", path: "wiki/a.md" },
      { action: "update", path: "wiki/a.md" },
      { action: "add", path: "wiki/dir/c.md" },
    ]);
    expect(s.fake.calls).toEqual([]);
    expect(mirrorSpy).not.toHaveBeenCalled();
    expect(s.store.getPersonalVault(s.ownerId)).toBeNull();
  });

  it("matches listTree for a repo-home list (the merge is not on that path)", async () => {
    const s = setup("regression-list", { memory: false });
    await s.call("write_file", { path: "wiki/a.md", content: "a" });
    await s.call("write_file", { path: "skills/s/SKILL.md", content: "s" });
    const entries = await listTree(s.clonePath);
    expect(txt(await s.call("list_files"))).toBe(
      `Knowledge repository file list:\n${entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n")}`,
    );
  });
});

// ---- Addendum 2 ---------------------------------------------------------------------------------------------

describe("D1: a vault write decides its home inside the owner's vault write queue", () => {
  const CLONE_NOTES = { "wiki/a.md": "one", "wiki/t/n.md": "N", "wiki/t/keep.txt": "K", "wiki/m/x.md": "X" };
  const VAULT_NOTES = { "wiki/a.md": "one", "wiki/t/n.md": "N", "wiki/m/x.md": "X" };

  /** A repo-home owner whose clone holds the notes; each case then cuts over while its call waits in the queue. */
  async function repoHome(name: string) {
    const s = setup(name, { memory: false, files: CLONE_NOTES });
    await s.call("list_files"); // clones
    return s;
  }

  it("a write, edit, delete or move that waited through a cutover lands in the service — never in the clone the mirror now owns", async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown>; check: (s: Fixture, res: ToolResult) => void }> = [
      {
        tool: "write_file",
        args: { path: "wiki/new.md", content: "NEW" },
        check: (s, res) => {
          expect(txt(res)).toBe(`Saved the file wiki/new.md. ${VAULT_NOTE_SAVED}`);
          expect(s.notes()["wiki/new.md"]).toBe("NEW");
          expect(s.inClone("wiki/new.md")).toBe(false);
        },
      },
      {
        tool: "edit_file",
        args: { path: "wiki/a.md", old_string: "one", new_string: "two" },
        check: (s, res) => {
          expect(txt(res)).toContain(VAULT_NOTE_SAVED);
          expect(s.notes()["wiki/a.md"]).toBe("two");
          expect(s.cloneFile("wiki/a.md")).toBe("one");
        },
      },
      {
        tool: "delete_file",
        args: { path: "wiki/a.md" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault note: the deletion is saved now");
          expect(s.notes()["wiki/a.md"]).toBeUndefined();
          expect(s.cloneFile("wiki/a.md")).toBe("one");
        },
      },
      {
        tool: "delete_file",
        args: { path: "wiki/t" },
        check: (s, res) => {
          expect(txt(res)).toContain("Its 1 vault note(s) are deleted now");
          expect(s.notes()["wiki/t/n.md"]).toBeUndefined();
          // The clone's file at the vault path is the mirror's; the repo file of the folder is the tool's.
          expect(s.cloneFile("wiki/t/n.md")).toBe("N");
          expect(s.inClone("wiki/t/keep.txt")).toBe(false);
        },
      },
      {
        tool: "move_file",
        args: { from: "wiki/a.md", to: "wiki/b.md" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault notes: the move is saved now");
          expect(s.notes()["wiki/b.md"]).toBe("one");
          expect(s.notes()["wiki/a.md"]).toBeUndefined();
          expect(s.cloneFile("wiki/a.md")).toBe("one");
          expect(s.inClone("wiki/b.md")).toBe(false);
        },
      },
      {
        tool: "move_file",
        args: { from: "wiki/m", to: "wiki/m2" },
        check: (s, res) => {
          expect(txt(res)).toContain("Vault notes: the move is saved now");
          expect(s.notes()["wiki/m2/x.md"]).toBe("X");
          expect(s.notes()["wiki/m/x.md"]).toBeUndefined();
          expect(s.cloneFile("wiki/m/x.md")).toBe("X");
          expect(s.inClone("wiki/m2")).toBe(false);
        },
      },
    ];
    for (const [i, c] of cases.entries()) {
      const s = await repoHome(`d1-${i}`);
      const res = await whileQueued(s, () => flipToMemory(s, VAULT_NOTES), () => s.call(c.tool, c.args));
      expect(res.isError, `${c.tool}: ${txt(res)}`).toBeFalsy();
      c.check(s, res);
    }
  });

  it("the other way round: a write that waited through a rollback lands in the clone, with the clone's text", async () => {
    const s = setup("d1-rollback");
    await s.call("write_file", { path: "wiki/a.md", content: "A" });
    const res = await whileQueued(s, () => s.store.clearPersonalVault(s.ownerId), () => s.call("write_file", { path: "wiki/b.md", content: "B" }));
    expect(res.isError).toBeFalsy();
    expect(txt(res)).toBe("Saved the file wiki/b.md. (Not committed yet — push it with mcp__repo__commit.)");
    expect(s.cloneFile("wiki/b.md")).toBe("B");
    expect(s.notes()["wiki/b.md"]).toBeUndefined();
  });

  it("create_repo's template waits in the queue too: its vault notes go where the vault is when it runs", async () => {
    const s = setup("d1-create", { memory: false, repo: false });
    const tools = buildRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config },
      { allowCreate: true, createRemoteRepo: async () => ({ ok: true as const, fullName: s.remote, defaultBranch: "main", isPrivate: true }) },
    );
    const res = await whileQueued(s, () => flipToMemory(s), () => callTool(tools, "create_repo", { name: "brain" }));
    expect(res.isError, txt(res)).toBeFalsy();
    expect(s.notes()["wiki/index.md"]).toContain("# Index");
    expect(s.notes()["CLAUDE.md"]).toBeTruthy();
    expect(s.remoteFiles()).toContain(".claude-plugin/marketplace.json");
    expect(s.remoteFiles().filter((f) => f === "CLAUDE.md" || /^(wiki|raw)\/.*\.md$/.test(f))).toEqual([]);
  });

  it("does not queue a path that is not a vault path, nor a caller the gate refuses", async () => {
    const s = setup("d1-noqueue");
    let release!: () => void;
    const held = withVaultWriteLock(s.store, s.ownerId, () => new Promise<void>((resolve) => (release = resolve)));
    // While the queue is held, repo paths and reads go through; a refused caller is refused at once.
    expect(txt(await s.call("write_file", { path: "notes/x.txt", content: "x" }))).toContain("Saved the file notes/x.txt");
    expect(txt(await s.call("delete_file", { path: "notes/x.txt" }))).toContain("Deleted notes/x.txt");
    expect((await s.call("list_files")).isError).toBeFalsy();
    const visitor = buildRepoTools(s.store, { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: false, config: s.config });
    expect(txt(await callTool(visitor, "write_file", { path: "wiki/a.md", content: "x" }))).toBe("This tool can only be used by the avatar owner.");
    release();
    await held;
  });

  it("a shared-account teammate's write and edit racing a REAL cutover are not lost (review E1)", async () => {
    const s = setup("d1-cutover", { memory: false, files: { "CLAUDE.md": "# standing\n", "wiki/index.md": "# Index\n", "raw/2026-11-01.md": "captured\n" } });
    await s.call("list_files"); // clones
    const mate = teammateTools(s);
    const cut = cutoverVault(s.store, s.config, s.ownerId);
    await tick();
    const [w, e] = await Promise.all([
      mate.call("write_file", { path: "wiki/new.md", content: "written during the cutover\n" }),
      mate.call("edit_file", { path: "wiki/index.md", old_string: "# Index", new_string: "# Index (edited during the cutover)" }),
    ]);
    const report = await cut;
    expect(report.blockers).toEqual([]);
    expect(report.state).toBe("memory");
    expect(w.isError, txt(w)).toBeFalsy();
    expect(e.isError, txt(e)).toBeFalsy();
    // Whichever side of the flip each call ran on, the vault holds it now …
    expect(s.notes()["wiki/new.md"]).toBe("written during the cutover\n");
    expect(s.notes()["wiki/index.md"]).toBe("# Index (edited during the cutover)\n");
    // … and the next mirror carries it to the repository instead of deleting it.
    s.store.markVaultMirrorDirty(s.ownerId);
    const outcome = await syncVaultMirror(s.store, s.config, s.ownerId, { push: true });
    expect(outcome.kind).toBe("synced");
    expect(s.remoteFile("wiki/new.md")).toBe("written during the cutover\n");
    expect(s.remoteFile("wiki/index.md")).toBe("# Index (edited during the cutover)\n");
  });
});

describe("D4: for a memory-home owner the tools never touch a clone file at a vault path", () => {
  it("a folder delete during a hold leaves the connected repository's own notes alone, and the next commit does not push their deletion (review)", async () => {
    // The newly connected repository holds notes of its own under wiki/topic; the owner has not confirmed yet.
    const s = setup("d4-hold", { files: { "wiki/topic/theirs.md": "the repository's own note\n", "wiki/topic/asset.txt": "asset\n" } });
    s.fake.seed(s.ownerId, "wiki/topic/mine.md", "the vault's note\n");
    s.store.setVaultMirrorHold(s.ownerId, "confirm");

    const del = await s.call("delete_file", { path: "wiki/topic" });
    expect(del.isError, txt(del)).toBeFalsy();
    expect(txt(del)).toContain("Its 1 vault note(s) are deleted now");
    expect(s.notes()).toEqual({});
    expect(s.cloneFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.inClone("wiki/topic/asset.txt")).toBe(false);

    const commit = await s.call("commit", { message: "cleanup" });
    expect(commit.isError, txt(commit)).toBeFalsy();
    expect(txt(commit)).toContain("it is on hold until the owner confirms");
    expect(s.remoteFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.remoteFiles()).not.toContain("wiki/topic/asset.txt");

    // The same for a move: nothing of the repository's own notes moves, in the clone or in the remote.
    s.fake.seed(s.ownerId, "wiki/topic/mine.md", "the vault's note\n");
    const mv = await s.call("move_file", { from: "wiki/topic", to: "archive/topic" });
    expect(mv.isError, txt(mv)).toBeFalsy();
    expect(s.cloneFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
    expect(s.cloneFile("archive/topic/mine.md")).toBe("the vault's note\n");
    expect(s.inClone("archive/topic/theirs.md")).toBe(false);
    // While the check of a just-connected repository is still running, the result says that instead.
    s.store.setVaultMirrorHold(s.ownerId, "checking");
    const checking = await s.call("commit", { message: "moved" });
    expect(txt(checking)).toContain("is still being checked before anything is copied into it");
    expect(s.remoteFile("wiki/topic/theirs.md")).toBe("the repository's own note\n");
  });

  it("a folder that exists only as clone copies of notes does not exist", async () => {
    const s = setup("d4-mirror-only", { files: { "wiki/old/gone.md": "a copy the service no longer has\n" } });
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
    // A repo-home owner's clone cannot collide with itself: no check, no service call.
    const r = setup("d4-collision-repo", { memory: false });
    await r.call("write_file", { path: "wiki/topic", content: "plain file" });
    expect(r.cloneFile("wiki/topic")).toBe("plain file");
    expect(r.fake.calls).toEqual([]);
  });

  it("refuses a path that reaches the clone's vault folders through a link in the repository", async () => {
    for (const memory of [true, false]) {
      const s = setup(`d4-alias-${memory}`, { memory, files: { "wiki/a.md": "THE CLONE'S FILE\n" } });
      await s.call("list_files"); // clones
      fs.symlinkSync("wiki", path.join(s.clonePath, "notes"));
      const read = await s.call("read_file", { path: "notes/a.md" });
      if (!memory) {
        // A repo-home owner's clone IS the vault: the link works as it always did.
        expect(txt(read)).toBe("THE CLONE'S FILE\n");
        continue;
      }
      const refused = [
        read,
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
    }
  });

  it("classifies a path the same way in mcp__brain__get_note: `wiki/a.md/` is the note, not the clone's file (review)", async () => {
    const s = setup("d4-getnote", { files: { "wiki/a.md": "THE CLONE'S COPY (behind)\n" } });
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

  it("create_repo leaves a repository that brings vault notes of its own exactly as it is", async () => {
    const s = setup("d4-create-own", { repo: false, files: { "wiki/index.md": "# Their index\n", "CLAUDE.md": "# Their rules\n" } });
    s.fake.seed(s.ownerId, "wiki/mine.md", "mine");
    const tools = buildRepoTools(
      s.store,
      { avatarUserId: s.ownerId, owner: s.owner, viewerIsOwner: true, config: s.config },
      { allowCreate: true, createRemoteRepo: async () => ({ ok: true as const, fullName: s.remote, defaultBranch: "main", isPrivate: true }) },
    );
    const before = s.remoteFiles();
    const res = await callTool(tools, "create_repo", { name: "brain" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Skipped the default template: this repository already holds vault notes of its own");
    expect(s.remoteFiles()).toEqual(before);
    expect(s.remoteFile("CLAUDE.md")).toBe("# Their rules\n");
    expect(s.cloneFile("wiki/index.md")).toBe("# Their index\n");
    expect(s.notes()).toEqual({ "wiki/mine.md": "mine" });
    expect(repoChangedSpy).toHaveBeenCalledWith(s.store, s.config, s.ownerId, null);
  });
});

describe("D3: mcp__repo__commit and a direct git edit of the repository", () => {
  async function committed(name: string) {
    const s = setup(name);
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await s.call("write_file", { path: "wiki/b.md", content: "b v1\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    mirrorSpy.mockClear();
    return s;
  }

  it("a conflicting edit of a vault note never blocks the commit: the vault's text wins, the rest of the remote is kept", async () => {
    const s = await committed("d3-conflict");
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2 (vault)" });
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    // Pushed after the working tree was last synced: the commit below has to rebase onto it.
    s.pushOutside({ "wiki/a.md": "a edited in git\n", "docs/outside.txt": "pushed from outside\n" });

    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(txt(res)).toContain("brought the repository's copy of the vault notes up to date");
    expect(s.remoteFile("wiki/a.md")).toBe("a v2 (vault)\n");
    expect(s.remoteFile("docs/outside.txt")).toBe("pushed from outside\n");
    expect(s.remoteFile("notes/more.txt")).toBe("more\n");
    // The mirror ran before the commit AND again on the rebased tree.
    expect(mirrorSpy).toHaveBeenCalledTimes(2);
    const row = s.store.getPersonalVault(s.ownerId)!;
    expect(row.mirrorDirty).toBe(false);
    expect(row.mirrorError).toBeNull();
  });

  it("an edit of ANOTHER vault note in git is put back to the vault's text by the pass after the rebase", async () => {
    const s = await committed("d3-noconflict");
    s.pushOutside({ "wiki/b.md": "b edited in git\n" });
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2" });
    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(mirrorSpy).toHaveBeenCalledTimes(2);
    expect(s.remoteFile("wiki/a.md")).toBe("a v2\n");
    expect(s.remoteFile("wiki/b.md")).toBe("b v1\n");
    expect(txt(res)).toContain("brought the repository's copy of the vault notes up to date");
  });

  it("never says the copy is up to date when the pass after the rebase did not succeed", async () => {
    const s = await committed("d3-second-pass-fails");
    s.pushOutside({ "wiki/b.md": "b edited in git\n" });
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2" });
    const real = (await vi.importActual<typeof import("../src/server/vaultMirror.js")>("../src/server/vaultMirror.js")).syncVaultMirror;
    mirrorSpy.mockImplementationOnce(real).mockResolvedValueOnce({ kind: "failed", error: "memory service unavailable (network)" });
    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(txt(res)).not.toContain("up to date");
    expect(txt(res)).toContain("was NOT updated this time (memory service unavailable (network))");
    // What the first pass wrote was pushed; the git edit of the other note is still there, and the row says so.
    expect(s.remoteFile("wiki/a.md")).toBe("a v2\n");
    expect(s.remoteFile("wiki/b.md")).toBe("b edited in git\n");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(true);
  });

  it("a conflict outside the vault still fails the commit as it always did", async () => {
    const s = await committed("d3-repo-conflict");
    await s.call("write_file", { path: "notes/plain.txt", content: "plain edited here\n" });
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2" });
    s.pushOutside({ "notes/plain.txt": "plain edited in git\n" });
    const res = await s.call("commit", { message: "second" });
    expect(res.isError).toBe(true);
    expect(txt(res)).toContain("CONFLICT");
    expect(txt(res)).toContain("notes/plain.txt");
    expect(s.remoteFile("wiki/a.md")).toBe("a v1\n");
    const row = s.store.getPersonalVault(s.ownerId)!;
    expect(row.mirrorDirty).toBe(true);
    expect(row.mirrorError).toBeTruthy();
  });

  it("deleting the last note reaches the repository, and a note written directly in git is left alone and said so", async () => {
    const s = setup("d3-last-note");
    await s.call("write_file", { path: "wiki/only.md", content: "only\n" });
    expect((await s.call("commit", { message: "one note" })).isError).toBeFalsy();
    expect(s.remoteFiles()).toContain("wiki/only.md");
    await s.call("delete_file", { path: "wiki/only.md" });
    const res = await s.call("commit", { message: "delete it" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(s.remoteFiles()).not.toContain("wiki/only.md");

    // Noah did not delete this one: it stays, and the result names what was left alone.
    s.pushOutside({ "wiki/from-git.md": "written directly in git\n" });
    await s.call("write_file", { path: "wiki/next.md", content: "next\n" });
    const next = await s.call("commit", { message: "next" });
    expect(next.isError, txt(next)).toBeFalsy();
    expect(s.remoteFile("wiki/from-git.md")).toBe("written directly in git\n");
    expect(txt(next)).toContain("Left as they are in the repository (repository notes not in the memory service: 1)");
  });
});

/** A branch in the repository with its own line from the first commit and its own files. */
function pushBranch(s: Fixture, name: string, branch: string, files: Record<string, string>) {
  const work = path.join(tempDir, name, `${branch}-work`);
  execFileSync("git", ["clone", "-q", s.remote, work], { stdio: "pipe" });
  const w = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "pipe" }).toString().trim();
  w("config", "user.email", "dev@example.com");
  w("config", "user.name", "Dev");
  w("config", "commit.gpgsign", "false");
  w("checkout", "-q", "-b", branch, w("rev-list", "--max-parents=0", "HEAD"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  w("add", "-A");
  w("commit", "-q", "-m", `${branch}'s own files`);
  w("push", "-q", "origin", branch);
}

// What a tool answers when a push of the knowledge clone is stopped because it would change vault notes of
// the repository while the copy is on hold — its own refusal, not the general failure (no token /
// branch-protection hint). The look comes BEFORE the commit: nothing is committed, the changes stay in the
// working tree.
const HOLD_WAIT = {
  confirm:
    "the connected repository (or branch) holds vault notes of its own, and nothing there is changed until the owner confirms in 설정 → 지식·플러그인 → 지식 저장소 (or connects another repository)",
  checking: "Noah has not finished looking at the newly connected repository (or branch) — `mcp__system__describe_system` shows the state",
} as const;
/**
 * The on-hold refusal. `after`: what gets the kept changes out once the hold has ended — the same call again
 * (`commit`), or a commit of the repository for a tool that wrote files first (learning / unlinking a skill:
 * repeating that call would find its own leftover — "already exists", "nothing to unlink").
 */
const holdRefusal = (files: string, hold: "confirm" | "checking", after: "again" | "commit" = "again") =>
  `Nothing was committed or pushed: this push would change vault notes in the repository (${files}) while the repository's copy of the vault notes is ON HOLD — ${HOLD_WAIT[hold]}. ` +
  (after === "commit"
    ? "What this call changed is kept, uncommitted, in the server's copy of the repository: once the hold has ended, call `mcp__repo__commit` to push it — do NOT repeat this call (it would find its own files there); tell the user that. "
    : "The changes are kept, uncommitted, in the server's copy of the repository: do the same again once the hold has ended; tell the user that, and do not retry in a loop. ") +
  "If the server's copy of the repository is still on a previous branch (the branch was changed while there were uncommitted changes), the look at the new branch cannot finish until that is resolved: the owner sets the branch back, has these changes committed there, and switches again. " +
  "The notes themselves are saved in the vault. Do not work around this with Bash `git` — the shell has no git credentials.";

describe("re-review: a rebase conflict on a vault note is settled for the clone only when this commit's mirror pass just wrote it", () => {
  const remoteHead = (s: Fixture, branch = "main") =>
    execFileSync("git", ["--git-dir", s.remote, "rev-parse", branch], { stdio: "pipe" }).toString().trim();
  const remoteShow = (s: Fixture, branch: string, rel: string) =>
    execFileSync("git", ["--git-dir", s.remote, "show", `${branch}:${rel}`], { stdio: "pipe" }).toString();
  const cloneGit = (s: Fixture, ...a: string[]) => execFileSync("git", ["-C", s.clonePath, ...a], { stdio: "pipe" }).toString().trim();
  /** The refusal every rebase conflict gets (`commitFailureMessage`), for these conflicted files. */
  const conflictRefusal = (files: string) =>
    `Commit/push failed: the remote branch has new commits that CONFLICT with this change (conflicting file(s): ${files}). The local commit is preserved, but it cannot be pushed until the conflict is resolved. Tell the user that the same file(s) were changed outside this conversation (e.g. a direct push, or another chat that already pushed), and that the repository owner/admin needs to reconcile it manually. Do not retry in a loop, and do not work around this with Bash \`git\` — the shell has no git credentials.`;
  const CONFLICT_REFUSAL = conflictRefusal("wiki/a.md");
  // What a memory-home owner's conflict refusal adds when a VAULT note is among the conflicted files. Such a
  // conflict reaches the rebase only when this commit's mirror pass FAILED (a copy on hold is stopped before
  // the rebase; a pass that ran settles the conflict) — and then "reconcile it manually" is the wrong advice.
  // The same line when such a conflict reaches the rebase although the copy is ON HOLD (rare: commits that
  // change a vault note and change it back) — one text for both holds; describe_system says which and why.
  const HOLD_CONFLICT_NOTE =
    "\nFor the vault note(s) among those files this is NOT something to reconcile by hand: the repository's copy of the vault notes is ON HOLD (`mcp__system__describe_system` shows why and what ends it). Commit again once the hold has ended — the vault's text then settles the conflict. The notes themselves are saved in the vault.";
  const FAILED_PASS_NOTE =
    "\nFor the vault note(s) among those files this is NOT something to reconcile by hand: the copy of the vault notes could not be refreshed from the memory service in this commit (`mcp__system__describe_system` shows why). Commit again once it can — the vault's text then settles the conflict. The notes themselves are saved in the vault.";

  /**
   * The clone holds an UNPUSHED commit of `wiki/a.md` with the vault's text (a mirror pass wrote it, the push
   * failed), the repository then got its own, different `wiki/a.md`, and the avatar has another change to
   * commit: the next `commit` has to rebase and meets a conflict on a vault note.
   */
  async function diverged(name: string) {
    const s = setup(name);
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2 (vault)" });
    fs.renameSync(s.remote, `${s.remote}.away`);
    expect((await s.call("commit", { message: "second (its push fails)" })).isError).toBe(true);
    fs.renameSync(`${s.remote}.away`, s.remote);
    expect(cloneGit(s, "show", "HEAD:wiki/a.md")).toBe("a v2 (vault)");
    s.pushOutside({ "wiki/a.md": "the repository's own a\n" });
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    mirrorSpy.mockClear();
    return s;
  }

  /**
   * The commit is refused with exactly `refusal`, before anything is committed: nothing reaches the
   * repository, the clone's commits are what they were, and the pending change is still in the working tree.
   */
  async function expectRefused(s: Fixture, message: string, refusal: string) {
    const head = remoteHead(s);
    const cloneHead = cloneGit(s, "rev-parse", "HEAD");
    const res = await s.call("commit", { message });
    expect(res.isError, txt(res)).toBe(true);
    expect(txt(res)).toBe(refusal);
    expect(txt(res)).not.toMatch(/pi-gateway/i);
    // Nothing was pushed: the repository's note is its own, the other change is not there either.
    expect(remoteHead(s)).toBe(head);
    expect(s.remoteFile("wiki/a.md")).toBe("the repository's own a\n");
    expect(s.remoteFiles()).not.toContain("notes/more.txt");
    // Nothing was committed or rebased: the clone's commits are untouched and the change waits, uncommitted.
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(cloneHead);
    expect(cloneGit(s, "log", "--format=%s")).not.toContain(message);
    expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");
    expect(s.cloneFile("notes/more.txt")).toBe("more\n");
    expect(cloneGit(s, "show", "HEAD:wiki/a.md")).toBe("a v2 (vault)");
    expect(fs.existsSync(path.join(s.clonePath, ".git", "rebase-merge"))).toBe(false);
    expect(fs.existsSync(path.join(s.clonePath, ".git", "rebase-apply"))).toBe(false);
    expect(s.notes()["wiki/a.md"]).toBe("a v2 (vault)\n");
  }

  for (const hold of ["confirm", "checking"] as const) {
    it(`hold ${hold}: commits that would conflict on a vault note are stopped before any rebase — the repository's note is not replaced without the owner's press`, async () => {
      const s = await diverged(`rr-hold-${hold}`);
      s.store.setVaultMirrorHold(s.ownerId, hold);

      // Local commits that conflict on a vault note necessarily CHANGE that note: the look before the push
      // stops them as "on hold" — neither the commit nor the rebase (and its conflict) is ever tried.
      await expectRefused(s, "third", holdRefusal("wiki/a.md", hold));
      // The mirror was asked once and stood back.
      expect(mirrorSpy).toHaveBeenCalledTimes(1);
      await expect(mirrorSpy.mock.results[0].value).resolves.toEqual({ kind: "skipped", reason: "hold" });
      expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe(hold);

      // Refused again for as long as the hold stands …
      await expectRefused(s, "third", holdRefusal("wiki/a.md", hold));
      expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe(hold);

      // … and once the owner lifted it, the same commit goes through with the vault's text (the D3 rule).
      s.store.setVaultMirrorHold(s.ownerId, null);
      const res = await s.call("commit", { message: "after the press" });
      expect(res.isError, txt(res)).toBeFalsy();
      expect(txt(res)).toContain("Committed and pushed the changes");
      expect(s.remoteFile("wiki/a.md")).toBe("a v2 (vault)\n");
      expect(s.remoteFile("notes/more.txt")).toBe("more\n");
    });
  }

  for (const hold of ["confirm", "checking"] as const) {
  it(`hold ${hold}: commits that change a vault note and change it BACK pass the look before the push — the rebase still stops at their conflict`, async () => {
    // Two unpushed mirror commits: a.md v1 → v2, then v2 → v1. Together they change no vault path, so the
    // look before the push has nothing to hold; replayed one by one, the first conflicts with the repository's
    // own edit. With the copy on hold nothing settles that for the clone's side.
    const s = setup(`rr-hold-roundtrip-${hold}`);
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    fs.renameSync(s.remote, `${s.remote}.away`);
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2 (vault)" });
    expect((await s.call("commit", { message: "second (its push fails)" })).isError).toBe(true);
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v2 (vault)", new_string: "a v1" });
    expect((await s.call("commit", { message: "third (its push fails)" })).isError).toBe(true);
    fs.renameSync(`${s.remote}.away`, s.remote);
    expect(cloneGit(s, "show", "HEAD:wiki/a.md")).toBe("a v1");
    s.pushOutside({ "wiki/a.md": "the repository's own a\n" });
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    s.store.setVaultMirrorHold(s.ownerId, hold);
    const head = remoteHead(s);

    const res = await s.call("commit", { message: "fourth" });
    expect(res.isError, txt(res)).toBe(true);
    // The general conflict refusal, then the line that names the real cause: the hold — not a failed pass.
    expect(txt(res)).toBe(`${CONFLICT_REFUSAL}${HOLD_CONFLICT_NOTE}`);
    expect(txt(res)).not.toContain("could not be refreshed from the memory service");
    expect(remoteHead(s)).toBe(head);
    expect(s.remoteFile("wiki/a.md")).toBe("the repository's own a\n");
    expect(s.remoteFiles()).not.toContain("notes/more.txt");
    expect(cloneGit(s, "log", "--format=%s", "-1")).toBe("fourth");
    expect(cloneGit(s, "status", "--porcelain")).toBe("");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe(hold);
  });
  }

  it("the mirror pass FAILED in this commit (memory service down): the conflict stops the commit as well", async () => {
    const s = await diverged("rr-failed");
    const unavailable = () => Promise.reject(down());
    setMemoryClientForTests(s.store, {
      list: unavailable,
      read: unavailable,
      put: unavailable,
      remove: unavailable,
      search: unavailable,
      deleteWiki: unavailable,
    });
    const head = remoteHead(s);
    const res = await s.call("commit", { message: "third" });
    expect(res.isError, txt(res)).toBe(true);
    // No hold: the look before the push lets it by, the rebase meets the conflict, and — the pass having
    // failed — nothing settles it. The added line says why, and what ends it.
    expect(txt(res)).toBe(`${CONFLICT_REFUSAL}${FAILED_PASS_NOTE}`);
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    await expect(mirrorSpy.mock.results[0].value).resolves.toMatchObject({ kind: "failed" });
    expect(remoteHead(s)).toBe(head);
    expect(s.remoteFile("wiki/a.md")).toBe("the repository's own a\n");
    expect(s.remoteFiles()).not.toContain("notes/more.txt");
    expect(cloneGit(s, "log", "--format=%s", "-1")).toBe("third");
    expect(cloneGit(s, "show", "HEAD:wiki/a.md")).toBe("a v2 (vault)");
    expect(cloneGit(s, "status", "--porcelain")).toBe("");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBeNull();

    // The service is back: the pass runs, and now the conflict is settled for what it just wrote.
    setMemoryClientForTests(s.store, s.fake);
    const again = await s.call("commit", { message: "service back" });
    expect(again.isError, txt(again)).toBeFalsy();
    expect(s.remoteFile("wiki/a.md")).toBe("a v2 (vault)\n");
    expect(s.remoteFile("notes/more.txt")).toBe("more\n");
  });

  it("the reviewer's path: the connected branch was switched to one with its own note while the clone stayed behind (hold confirm)", async () => {
    const s = setup("rr-branch");
    await s.call("write_file", { path: "wiki/a.md", content: "the vault's a\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    expect(s.remoteFile("wiki/a.md")).toBe("the vault's a\n");

    // `dev` in the repository: its own line from the first commit, with its own, different wiki/a.md.
    const work = path.join(tempDir, "rr-branch", "dev-work");
    execFileSync("git", ["clone", "-q", s.remote, work], { stdio: "pipe" });
    const w = (...a: string[]) => execFileSync("git", ["-C", work, ...a], { stdio: "pipe" }).toString().trim();
    w("config", "user.email", "dev@example.com");
    w("config", "user.name", "Dev");
    w("config", "commit.gpgsign", "false");
    w("checkout", "-q", "-b", "dev", w("rev-list", "--max-parents=0", "HEAD"));
    fs.mkdirSync(path.join(work, "wiki"), { recursive: true });
    fs.writeFileSync(path.join(work, "wiki", "a.md"), "dev's own a\n");
    w("add", "-A");
    w("commit", "-q", "-m", "dev's own note");
    w("push", "-q", "origin", "dev");

    // The avatar has another change in the working tree; then the owner connects `dev`. The check found
    // notes the copy would replace: the mirror waits for the owner's press.
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "dev");
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    mirrorSpy.mockClear();
    const devHead = remoteHead(s, "dev");
    const mainHead = remoteHead(s, "main");

    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBe(true);
    // Stopped before the rebase: the clone's commits change `wiki/a.md`, and the copy is on hold.
    expect(txt(res)).toBe(holdRefusal("wiki/a.md", "confirm"));
    // Before the fix `dev`'s note was replaced by the vault's text while the tool said "NOT updated: it is on hold".
    expect(remoteHead(s, "dev")).toBe(devHead);
    expect(remoteShow(s, "dev", "wiki/a.md")).toBe("dev's own a\n");
    expect(remoteHead(s, "main")).toBe(mainHead);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("confirm");
    // Nothing was committed: the clone is where it was, the pending change still uncommitted.
    expect(cloneGit(s, "log", "--format=%s")).toBe(["first", "init"].join("\n"));
    expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");
    expect(cloneGit(s, "show", "HEAD:wiki/a.md")).toBe("the vault's a");
  });
  it("the line is there when a vault note is only ONE of the conflicted files", async () => {
    // Memory home, the pass fails, and the conflict is on a vault note AND a repo file (the line speaks of
    // "the vault note(s) among those files").
    const mixed = setup("rr-note-mixed");
    await mixed.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await mixed.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
    expect((await mixed.call("commit", { message: "first" })).isError).toBeFalsy();
    await mixed.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2 (vault)" });
    await mixed.call("write_file", { path: "notes/plain.txt", content: "plain edited here\n" });
    fs.renameSync(mixed.remote, `${mixed.remote}.away`);
    expect((await mixed.call("commit", { message: "second (its push fails)" })).isError).toBe(true);
    fs.renameSync(`${mixed.remote}.away`, mixed.remote);
    mixed.pushOutside({ "wiki/a.md": "the repository's own a\n", "notes/plain.txt": "plain edited in git\n" });
    const unavailable = () => Promise.reject(down());
    setMemoryClientForTests(mixed.store, {
      list: unavailable,
      read: unavailable,
      put: unavailable,
      remove: unavailable,
      search: unavailable,
      deleteWiki: unavailable,
    });
    const both = await mixed.call("commit", { message: "third" });
    expect(both.isError).toBe(true);
    expect(txt(both)).toBe(`${conflictRefusal("notes/plain.txt, wiki/a.md")}${FAILED_PASS_NOTE}`);
  });

  it("no such line for a memory-home owner when no vault note is among the conflicted files, or the failure is not a conflict", async () => {
    // The general refusal alone — also during a hold.
    for (const hold of [null, "confirm"] as const) {
      const m = setup(`rr-note-repo-file-${hold}`);
      await m.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
      await m.call("write_file", { path: "notes/plain.txt", content: "plain v1\n" });
      expect((await m.call("commit", { message: "first" })).isError).toBeFalsy();
      await m.call("write_file", { path: "notes/plain.txt", content: "plain edited here\n" });
      m.pushOutside({ "notes/plain.txt": "plain edited in git\n" });
      m.store.setVaultMirrorHold(m.ownerId, hold);
      const res = await m.call("commit", { message: "second" });
      expect(res.isError).toBe(true);
      expect(txt(res)).toBe(conflictRefusal("notes/plain.txt"));
    }

    // Memory home, a failure that is not a conflict (the push itself fails): no such line either.
    const push = setup("rr-note-push");
    await push.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await push.call("write_file", { path: "notes/x.txt", content: "x\n" });
    fs.renameSync(push.remote, `${push.remote}.away`);
    const offline = await push.call("commit", { message: "offline" });
    expect(offline.isError).toBe(true);
    expect(txt(offline)).toContain("Commit/push failed:");
    expect(txt(offline)).not.toContain("NOT something to reconcile by hand");
  });

  it("a repo-home owner's refusal is unchanged: a conflict on wiki/a.md is an ordinary conflict there", async () => {
    // The clone IS the vault: nothing settles it, and nothing is added to the wording.
    const r = setup("rr-note-repo-home", { memory: false });
    await r.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    expect((await r.call("commit", { message: "first" })).isError).toBeFalsy();
    await r.call("write_file", { path: "wiki/a.md", content: "a edited here\n" });
    r.pushOutside({ "wiki/a.md": "a edited in git\n" });
    const repoHome = await r.call("commit", { message: "second" });
    expect(repoHome.isError).toBe(true);
    expect(txt(repoHome)).toBe(CONFLICT_REFUSAL);
    expect(r.remoteFile("wiki/a.md")).toBe("a edited in git\n");
    expect(r.fake.calls).toEqual([]);
  });
});

describe("re-review: under a hold nothing a commit pushes changes a vault path of the repository — also without a conflict", () => {
  const remoteHead = (s: Fixture, branch: string) =>
    execFileSync("git", ["--git-dir", s.remote, "rev-parse", branch], { stdio: "pipe" }).toString().trim();
  const remoteTree = (s: Fixture, branch: string) =>
    execFileSync("git", ["--git-dir", s.remote, "ls-tree", "-r", "--name-only", branch], { stdio: "pipe" }).toString().split("\n").filter(Boolean);
  const remoteShow = (s: Fixture, branch: string, rel: string) =>
    execFileSync("git", ["--git-dir", s.remote, "show", `${branch}:${rel}`], { stdio: "pipe" }).toString();
  const cloneGit = (s: Fixture, ...a: string[]) => execFileSync("git", ["-C", s.clonePath, ...a], { stdio: "pipe" }).toString().trim();

  /**
   * The clone stayed behind on `main`'s commits — a mirror commit with the vault's notes among them — while
   * the owner connected `dev`, which holds a note of its own at ANOTHER path (so nothing conflicts). The
   * avatar has a change that is not a vault note to commit.
   */
  async function behindOnMain(name: string, notes: string[] = ["wiki/a.md"]) {
    const s = setup(name);
    for (const note of notes) await s.call("write_file", { path: note, content: `the vault's ${note}\n` });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    pushBranch(s, name, "dev", { "wiki/other.md": "dev's own other note\n" });
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "dev");
    mirrorSpy.mockClear();
    return s;
  }

  for (const hold of ["confirm", "checking"] as const) {
    it(`hold ${hold}: the previous branch's vault notes do not reach the newly connected branch (the kept repro)`, async () => {
      const s = await behindOnMain(`hp-${hold}`);
      s.store.setVaultMirrorHold(s.ownerId, hold);
      const devHead = remoteHead(s, "dev");
      const mainHead = remoteHead(s, "main");

      const res = await s.call("commit", { message: "second" });
      expect(res.isError, txt(res)).toBe(true);
      expect(txt(res)).toBe(holdRefusal("wiki/a.md", hold));
      expect(txt(res)).not.toMatch(/Commit\/push failed|GIT_TOKEN|branch protection|pi-gateway/);
      // Nothing was pushed: `dev` is exactly what it was — no vault note of the old branch, none of its files.
      expect(remoteHead(s, "dev")).toBe(devHead);
      expect(remoteTree(s, "dev")).toEqual(["README.md", "wiki/other.md"]);
      expect(remoteHead(s, "main")).toBe(mainHead);
      expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe(hold);
      // Nothing was committed or rebased: the clone still ends at `main`'s commit, and the pending change is
      // in the working tree, uncommitted.
      expect(cloneGit(s, "log", "--format=%s")).toBe(["first", "init"].join("\n"));
      expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");
      expect(s.cloneFile("notes/more.txt")).toBe("more\n");
      expect(mirrorSpy).toHaveBeenCalled();
      await expect(mirrorSpy.mock.results[0].value).resolves.toEqual({ kind: "skipped", reason: "hold" });

      // Asked again while the hold stands: the same answer, still nothing pushed.
      const again = await s.call("commit", { message: "second" });
      expect(again.isError).toBe(true);
      expect(txt(again)).toBe(holdRefusal("wiki/a.md", hold));
      expect(remoteHead(s, "dev")).toBe(devHead);

      // The hold has ended: the same commit goes through — a push that carries vault paths is not refused
      // without a hold — and the branch's own note is left as it is.
      s.store.setVaultMirrorHold(s.ownerId, null);
      const done = await s.call("commit", { message: "after the hold" });
      expect(done.isError, txt(done)).toBeFalsy();
      expect(txt(done)).toContain("Committed and pushed the changes");
      expect(remoteShow(s, "dev", "wiki/a.md")).toBe("the vault's wiki/a.md\n");
      expect(remoteShow(s, "dev", "notes/more.txt")).toBe("more\n");
      expect(remoteShow(s, "dev", "notes/plain.txt")).toBe("plain\n");
      expect(remoteShow(s, "dev", "wiki/other.md")).toBe("dev's own other note\n");
      expect(remoteHead(s, "main")).toBe(mainHead);
    });
  }

  it("a refusal commits nothing and rebases nothing, so the remedy it names works: back on the previous branch only the pending change goes out", async () => {
    const s = await behindOnMain("hp-remedy");
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    const devHead = remoteHead(s, "dev");
    const refused = await s.call("commit", { message: "second" });
    expect(txt(refused)).toBe(holdRefusal("wiki/a.md", "confirm"));
    // The clone's history is `main`'s, untouched — no commit of the refused change, nothing of `dev`.
    expect(cloneGit(s, "log", "--format=%s")).toBe(["first", "init"].join("\n"));
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(remoteHead(s, "main"));
    expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");
    expect(cloneGit(s, "ls-files")).not.toContain("wiki/other.md");

    // The owner sets the branch back (a hold stands there as well while Noah looks at it again).
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "main");
    s.store.setVaultMirrorHold(s.ownerId, "checking");
    const back = await s.call("commit", { message: "second" });
    expect(back.isError, txt(back)).toBeFalsy();
    expect(txt(back)).toContain("Committed and pushed the changes");
    // `main` got the pending change and nothing of `dev`; `dev` is untouched.
    expect(remoteTree(s, "main")).toEqual(["README.md", "notes/more.txt", "notes/plain.txt", "wiki/a.md"]);
    expect(remoteShow(s, "main", "notes/more.txt")).toBe("more\n");
    expect(remoteShow(s, "main", "wiki/a.md")).toBe("the vault's wiki/a.md\n");
    expect(remoteHead(s, "dev")).toBe(devHead);
    expect(remoteTree(s, "dev")).toEqual(["README.md", "wiki/other.md"]);
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(remoteHead(s, "main"));

    // "… and switch again": with nothing left uncommitted the clone follows to `dev` on its next sync.
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "dev");
    expect((await s.call("read_file", { path: "README.md" })).isError).toBeFalsy(); // syncs the clone
    expect(cloneGit(s, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev");
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(devHead);
    expect(cloneGit(s, "status", "--porcelain")).toBe("");
  });

  it("under a hold, vault notes the REPOSITORY changed meanwhile do not stop a commit that does not touch them", async () => {
    const s = setup("hp-remote-ahead");
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    // Pushed after the working tree was last synced: the tip of the branch now differs from the clone in
    // vault paths — but the clone's own commit changes none of them.
    s.pushOutside({ "wiki/a.md": "a edited in git\n", "wiki/from-git.md": "written in git\n" });

    const res = await s.call("commit", { message: "second" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(txt(res)).toContain("was NOT updated: it is on hold until the owner confirms");
    expect(s.remoteFile("notes/more.txt")).toBe("more\n");
    // The repository's notes are what the repository made them.
    expect(s.remoteFile("wiki/a.md")).toBe("a edited in git\n");
    expect(s.remoteFile("wiki/from-git.md")).toBe("written in git\n");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("confirm");
  });

  it("a refused change is not stranded when the clone is synced afterwards: it follows to the connected branch and goes out once the hold has ended", async () => {
    const s = await behindOnMain("hp-not-stranded");
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    expect(txt(await s.call("commit", { message: "second" }))).toBe(holdRefusal("wiki/a.md", "confirm"));
    const mainHead = remoteHead(s, "main");

    // Any tool that syncs the clone. The refused change was never committed onto `main`'s line, so the clone
    // can follow the branch change and carries the change along, still uncommitted.
    expect((await s.call("read_file", { path: "README.md" })).isError).toBeFalsy();
    expect(cloneGit(s, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev");
    expect(cloneGit(s, "log", "--format=%s", "main")).toBe(["first", "init"].join("\n"));
    expect(s.cloneFile("notes/more.txt")).toBe("more\n");
    expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");

    // The hold still stands, but on `dev` this push carries no vault path any more: the change goes out.
    const onDev = await s.call("commit", { message: "second" });
    expect(onDev.isError, txt(onDev)).toBeFalsy();
    expect(txt(onDev)).toContain("was NOT updated: it is on hold until the owner confirms");
    expect(remoteTree(s, "dev")).toEqual(["README.md", "notes/more.txt", "wiki/other.md"]);
    expect(remoteHead(s, "main")).toBe(mainHead);

    // The hold has ended: the copy of the vault notes arrives, `dev`'s own note stays.
    s.store.setVaultMirrorHold(s.ownerId, null);
    await s.call("edit_file", { path: "wiki/a.md", old_string: "the vault's", new_string: "the vault's (edited)" });
    const done = await s.call("commit", { message: "notes" });
    expect(done.isError, txt(done)).toBeFalsy();
    expect(remoteShow(s, "dev", "wiki/a.md")).toBe("the vault's (edited) wiki/a.md\n");
    expect(remoteShow(s, "dev", "wiki/other.md")).toBe("dev's own other note\n");
  });

  it("the same on ONE branch: an unpushed mirror commit does not go out while the copy is on hold", async () => {
    const s = setup("hp-same-branch");
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    // A mirror commit whose push failed stays in the clone.
    await s.call("edit_file", { path: "wiki/a.md", old_string: "a v1", new_string: "a v2 (vault)" });
    fs.renameSync(s.remote, `${s.remote}.away`);
    expect((await s.call("commit", { message: "second (its push fails)" })).isError).toBe(true);
    fs.renameSync(`${s.remote}.away`, s.remote);
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    const head = remoteHead(s, "main");

    const res = await s.call("commit", { message: "third" });
    expect(res.isError).toBe(true);
    expect(txt(res)).toBe(holdRefusal("wiki/a.md", "confirm"));
    expect(remoteHead(s, "main")).toBe(head);
    expect(s.remoteFile("wiki/a.md")).toBe("a v1\n");
    expect(s.remoteFiles()).not.toContain("notes/more.txt");
    expect(cloneGit(s, "log", "--format=%s", "-1")).toBe("second (its push fails)");
    expect(cloneGit(s, "status", "--porcelain")).toBe("A  notes/more.txt");

    s.store.setVaultMirrorHold(s.ownerId, null);
    expect((await s.call("commit", { message: "after the hold" })).isError).toBeFalsy();
    expect(s.remoteFile("wiki/a.md")).toBe("a v2 (vault)\n");
    expect(s.remoteFile("notes/more.txt")).toBe("more\n");
  });

  it("under a hold a commit whose push changes NO vault path goes through, and says the copy is on hold", async () => {
    const s = setup("hp-no-vault-path");
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    // The clone is at the tip. A skill is edited, and a vault note is written (to the service — the copy waits).
    await s.call("scaffold_skill", { name: "Deploy Runbook" });
    await s.call("write_file", { path: "wiki/.gitkeep", content: "" });
    await s.call("write_file", { path: "wiki/new.md", content: "written during the hold\n" });

    const res = await s.call("commit", { message: "a skill" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(txt(res)).toContain("was NOT updated: it is on hold until the owner confirms");
    expect(s.remoteFiles()).toEqual(expect.arrayContaining(["skills/deploy-runbook/SKILL.md", "wiki/.gitkeep"]));
    expect(s.remoteFile("wiki/a.md")).toBe("a v1\n");
    expect(s.remoteFiles()).not.toContain("wiki/new.md");
    expect(s.notes()["wiki/new.md"]).toBe("written during the hold\n");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("confirm");
  });

  it("under a hold with a branch the repository does not have yet: not refused (there is nothing there to change)", async () => {
    const s = setup("hp-new-branch");
    await s.call("write_file", { path: "wiki/a.md", content: "a v1\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    await s.call("write_file", { path: "notes/more.txt", content: "more\n" });
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "fresh");
    s.store.setVaultMirrorHold(s.ownerId, "checking");
    const mainHead = remoteHead(s, "main");

    const res = await s.call("commit", { message: "onto a new branch" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain("Committed and pushed the changes");
    expect(txt(res)).toContain("is still being checked before anything is copied into it");
    expect(remoteShow(s, "fresh", "notes/more.txt")).toBe("more\n");
    expect(remoteShow(s, "fresh", "wiki/a.md")).toBe("a v1\n");
    expect(remoteHead(s, "main")).toBe(mainHead);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
  });

  it("names at most five of the vault notes the push would change, then how many more", async () => {
    const seven = ["wiki/n1.md", "wiki/n2.md", "wiki/n3.md", "wiki/n4.md", "wiki/n5.md", "wiki/n6.md", "CLAUDE.md"];
    const many = await behindOnMain("hp-seven", seven);
    many.store.setVaultMirrorHold(many.ownerId, "confirm");
    const res = await many.call("commit", { message: "second" });
    expect(res.isError).toBe(true);
    // In the order git lists them; the repo files of the same push (notes/…) are not counted.
    expect(txt(res)).toBe(holdRefusal("CLAUDE.md, wiki/n1.md, wiki/n2.md, wiki/n3.md, wiki/n4.md, and 2 more", "confirm"));
    expect(remoteTree(many, "dev")).toEqual(["README.md", "wiki/other.md"]);
  });

  it("names all of them when there are exactly five, with no \"more\"", async () => {
    const five = await behindOnMain("hp-five", ["wiki/n1.md", "wiki/n2.md", "wiki/n3.md", "wiki/n4.md", "wiki/n5.md"]);
    five.store.setVaultMirrorHold(five.ownerId, "checking");
    const all = await five.call("commit", { message: "second" });
    expect(all.isError).toBe(true);
    expect(txt(all)).toBe(holdRefusal("wiki/n1.md, wiki/n2.md, wiki/n3.md, wiki/n4.md, wiki/n5.md", "checking"));
  });
});

describe("re-review: every push of the knowledge clone is held — learning or unlinking a skill does not carry vault notes out either", () => {
  const remoteHead = (s: Fixture, branch: string) =>
    execFileSync("git", ["--git-dir", s.remote, "rev-parse", branch], { stdio: "pipe" }).toString().trim();
  const remoteTree = (s: Fixture, branch: string) =>
    execFileSync("git", ["--git-dir", s.remote, "ls-tree", "-r", "--name-only", branch], { stdio: "pipe" }).toString().split("\n").filter(Boolean);
  const cloneGit = (s: Fixture, ...a: string[]) => execFileSync("git", ["-C", s.clonePath, ...a], { stdio: "pipe" }).toString().trim();
  const SKILL_MD = "---\nname: pptx-report\ndescription: Weekly report deck generator\n---\n\n# pptx-report\n\nMake the deck.\n";
  const MARKER = "skills/pptx-report/.noah-skill-origin.json";

  /** A teammate who shares one skill from their own repository, and the owner's skill-exchange tools. */
  function withSharedSkill(s: Fixture, name: string) {
    const remote = makeBareRemote(path.join(tempDir, name, "sharer.git"));
    const seed = path.join(tempDir, name, "sharer-seed");
    gitInit(seed);
    const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
    for (const [rel, content] of Object.entries({
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "sharer", plugins: [] }),
      "skills/pptx-report/SKILL.md": SKILL_MD,
    })) {
      fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
      fs.writeFileSync(path.join(seed, rel), content);
    }
    g("add", "-A");
    g("commit", "-q", "-m", "a skill");
    g("branch", "-M", "main");
    g("remote", "add", "origin", remote);
    g("push", "-q", "origin", "main");
    const sharer = s.store.createUser({ username: "sharer", displayName: "Sharer", password: "password123" });
    s.store.setKnowledgeRepo(sharer.id, remote, "main");
    const share = s.store.shareSkill(sharer.id, { skillName: "pptx-report", displayName: "pptx-report", description: "" });
    const tools = buildSkillExchangeTools(s.store, {
      avatarUserId: s.ownerId,
      owner: { ...s.owner, alias: "" },
      viewerIsOwner: true,
      config: s.config,
    });
    return { shareId: share.id, exchange: (tool: string, args: unknown) => callTool(tools, tool, args) };
  }

  /**
   * The owner's clone is left on `main` (a mirror commit with `wiki/a.md` among its commits) while `dev` —
   * which holds a note of its own — is connected: an uncommitted edit of a tracked file keeps the clone from
   * switching, also when a tool syncs it. `learned` = the skill was learned (and pushed to `main`) before that.
   */
  async function leftOnMain(name: string, opts: { learned?: boolean } = {}) {
    const s = setup(name);
    const { exchange, shareId } = withSharedSkill(s, name);
    await s.call("write_file", { path: "wiki/a.md", content: "the vault's a\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain\n" });
    expect((await s.call("commit", { message: "first" })).isError).toBeFalsy();
    if (opts.learned) {
      const learned = await exchange("learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
      expect(learned.isError, txt(learned)).toBeFalsy();
      expect(s.remoteFiles()).toContain(MARKER);
    }
    pushBranch(s, name, "dev", { "wiki/other.md": "dev's own other note\n" });
    await s.call("write_file", { path: "notes/plain.txt", content: "plain, edited and not committed\n" });
    s.store.setKnowledgeRepo(s.ownerId, s.remote, "dev");
    return { s, exchange, shareId };
  }

  /** The owner signed in to the app (the 스킬 배우기 tab's routes). */
  async function signedIn(s: Fixture) {
    const agent = request.agent(createApp(s.services));
    await agent.post("/api/auth/login").send({ username: "owner", password: "password123" }).expect(200);
    return agent;
  }
  const ON_HOLD_KO =
    "저장소의 브레인 노트 사본이 보류 중이라 저장소에 올리지 않았습니다. 설정 → 지식·플러그인 → 지식 저장소에서 보류를 확인해 주세요. 변경은 서버 쪽 저장소 사본에 커밋되지 않은 채 남아 있으며, 보류가 끝난 뒤 아바타가 저장소를 커밋하면 함께 올라갑니다.";

  it("learn_skill under a hold: refused as on hold, the branch is unchanged, the skill waits uncommitted in the clone", { timeout: 20_000 }, async () => {
    const { s, exchange } = await leftOnMain("sk-learn-hold");
    s.store.setVaultMirrorHold(s.ownerId, "confirm");
    const devHead = remoteHead(s, "dev");
    const mainHead = remoteHead(s, "main");

    const res = await exchange("learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
    expect(res.isError, txt(res)).toBe(true);
    // The on-hold refusal, not "Learning failed: …".
    expect(txt(res)).toBe(holdRefusal("wiki/a.md", "confirm", "commit"));
    expect(remoteHead(s, "dev")).toBe(devHead);
    expect(remoteTree(s, "dev")).toEqual(["README.md", "wiki/other.md"]);
    expect(remoteHead(s, "main")).toBe(mainHead);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("confirm");
    // Nothing was committed: the clone still ends at `main`'s commit, and the learned skill is in the working
    // tree, uncommitted (with its origin marker).
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(mainHead);
    expect(s.cloneFile("skills/pptx-report/SKILL.md")).toBe(SKILL_MD);
    expect(cloneGit(s, "status", "--porcelain")).toContain("A  skills/pptx-report/SKILL.md");
    expect(cloneGit(s, "status", "--porcelain")).toContain(`A  ${MARKER}`);
    expect(cloneGit(s, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("skills/pptx-report/SKILL.md");

    // Once the hold has ended it goes out with the avatar's next commit of the repository.
    s.store.setVaultMirrorHold(s.ownerId, null);
    const commit = await s.call("commit", { message: "after the hold" });
    expect(commit.isError, txt(commit)).toBeFalsy();
    expect(remoteTree(s, "dev")).toEqual(expect.arrayContaining(["skills/pptx-report/SKILL.md", "wiki/a.md", "wiki/other.md"]));
  });

  it("learn_skill without a hold pushes as it always did", { timeout: 20_000 }, async () => {
    const { s, exchange } = await leftOnMain("sk-learn-free");
    const res = await exchange("learn_skill", { owner_username: "sharer", skill_name: "pptx-report" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain('Learned "pptx-report" from @sharer');
    expect(remoteTree(s, "dev")).toEqual(expect.arrayContaining(["skills/pptx-report/SKILL.md", MARKER, "wiki/a.md", "wiki/other.md"]));
  });

  it("unlink_skill under a hold: refused as on hold, the branch is unchanged, the unlink waits uncommitted in the clone", { timeout: 20_000 }, async () => {
    const { s, exchange } = await leftOnMain("sk-unlink-hold", { learned: true });
    s.store.setVaultMirrorHold(s.ownerId, "checking");
    const devHead = remoteHead(s, "dev");
    const mainHead = remoteHead(s, "main");

    const res = await exchange("unlink_skill", { skill_name: "pptx-report" });
    expect(res.isError, txt(res)).toBe(true);
    // The on-hold refusal, not "Unlinking failed: …".
    expect(txt(res)).toBe(holdRefusal("wiki/a.md", "checking", "commit"));
    expect(remoteHead(s, "dev")).toBe(devHead);
    expect(remoteTree(s, "dev")).toEqual(["README.md", "wiki/other.md"]);
    expect(remoteHead(s, "main")).toBe(mainHead);
    expect(execFileSync("git", ["--git-dir", s.remote, "ls-tree", "-r", "--name-only", "main"], { stdio: "pipe" }).toString()).toContain(MARKER);
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorHold).toBe("checking");
    // Nothing was committed: the marker is gone from the working tree only.
    expect(cloneGit(s, "rev-parse", "HEAD")).toBe(mainHead);
    expect(cloneGit(s, "ls-tree", "-r", "--name-only", "HEAD")).toContain(MARKER);
    expect(cloneGit(s, "status", "--porcelain")).toContain(`D  ${MARKER}`);
    expect(s.inClone(MARKER)).toBe(false);

    // Once the hold has ended it goes out with the avatar's next commit of the repository.
    s.store.setVaultMirrorHold(s.ownerId, null);
    const commit = await s.call("commit", { message: "after the hold" });
    expect(commit.isError, txt(commit)).toBeFalsy();
    const dev = remoteTree(s, "dev");
    expect(dev).toContain("skills/pptx-report/SKILL.md");
    expect(dev).not.toContain(MARKER);
  });

  it("unlink_skill without a hold pushes as it always did", { timeout: 20_000 }, async () => {
    const { s, exchange } = await leftOnMain("sk-unlink-free", { learned: true });
    const res = await exchange("unlink_skill", { skill_name: "pptx-report" });
    expect(res.isError, txt(res)).toBeFalsy();
    expect(txt(res)).toContain('Unlinked "pptx-report" from @sharer\'s share');
    const dev = remoteTree(s, "dev");
    expect(dev).toEqual(expect.arrayContaining(["skills/pptx-report/SKILL.md", "wiki/a.md", "wiki/other.md"]));
    expect(dev).not.toContain(MARKER);
  });
  it("the 스킬 배우기 routes answer 409 with what happened, in Korean, and push nothing", { timeout: 20_000 }, async () => {
    // Learn.
    const learn = await leftOnMain("sk-route-learn");
    learn.s.store.setVaultMirrorHold(learn.s.ownerId, "confirm");
    const learnDev = remoteHead(learn.s, "dev");
    const learned = await (await signedIn(learn.s)).post("/api/skill-share/learn").send({ id: learn.shareId }).expect(409);
    expect(learned.body.error).toBe(ON_HOLD_KO);
    expect(learned.body.error).not.toMatch(/pi-gateway|VAULT_ON_HOLD_PUSH/i);
    expect(remoteHead(learn.s, "dev")).toBe(learnDev);
    expect(cloneGit(learn.s, "status", "--porcelain")).toContain("A  skills/pptx-report/SKILL.md");

    // Unlink.
    const unlink = await leftOnMain("sk-route-unlink", { learned: true });
    unlink.s.store.setVaultMirrorHold(unlink.s.ownerId, "checking");
    const unlinkDev = remoteHead(unlink.s, "dev");
    const unlinked = await (await signedIn(unlink.s)).post("/api/skill-share/unlink").send({ slug: "pptx-report" }).expect(409);
    expect(unlinked.body.error).toBe(ON_HOLD_KO);
    expect(remoteHead(unlink.s, "dev")).toBe(unlinkDev);
    expect(cloneGit(unlink.s, "status", "--porcelain")).toContain(`D  ${MARKER}`);
  });
});

describe("a shared account: a trusted teammate writes as today", () => {
  it("writes, edits, moves and commits a vault note for a memory-home owner", async () => {
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

    const c = await mate.call("commit", { message: "mate: add note" });
    expect(c.isError, txt(c)).toBeFalsy();
    expect(txt(c)).toContain("Committed and pushed the changes");
    expect(s.remoteFile("wiki/team/from-mate.md")).toBe("# from a trusted teammate\n");
    // As today: authored as the owner, the teammate in the trailer and in the audit trail.
    expect(s.remoteLog()).toContain("Co-authored-by: Mate <mate@noah-almighty.local>");
    const push = s.store.listAudit(s.ownerId, true, 50).find((a) => a.action === "knowledge_repo_push");
    expect(push?.actorUserId).toBe(mate.mate.id);
    expect(push?.detail).toContain("shared account");
    expect(s.store.getPersonalVault(s.ownerId)!.mirrorDirty).toBe(false);
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
