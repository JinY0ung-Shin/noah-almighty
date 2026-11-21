// The personal vault's readers that are not avatar tools: the knowledge-graph
// builder over a note source (knowledgeGraph.ts), the graph / note routes and
// the repo-connect hook (routes/knowledgeRepo.ts), and the standing CLAUDE.md
// memory (plugins.ts). All of them read vault notes from the memory service —
// never from the knowledge repository's clone.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/server/vaultImport.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/vaultImport.js")>();
  return { ...real, onKnowledgeRepoChanged: vi.fn() };
});

import { createApp, createServices } from "../src/server/app.js";
import { buildKnowledgeGraph, buildKnowledgeGraphFromNotes } from "../src/server/knowledgeGraph.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { MemoryRefusedError, MemoryUnavailableError, setMemoryClientForTests } from "../src/server/memory/memoryClient.js";
import {
  STANDING_MEMORY_UNAVAILABLE_NOTICE,
  STANDING_MEMORY_VAULT_DEADLINE_MS,
  loadKnowledgeRepoMemory,
} from "../src/server/plugins.js";
import type { AppConfig } from "../src/server/types.js";
import { onKnowledgeRepoChanged } from "../src/server/vaultImport.js";
import { makeBareRemote, signup, withTempDir } from "./helpers.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";

let tempDir: string;
// Seeded remotes live outside the data root, as a real remote does.
let remotesDir: string;
const getTempDir = withTempDir("vault-readers", () => {
  tempDir = getTempDir();
  remotesDir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-vault-readers-remotes-"));
});
afterEach(() => {
  fs.rmSync(remotesDir, { recursive: true, force: true });
});

const repoChangedSpy = vi.mocked(onKnowledgeRepoChanged);
beforeEach(() => {
  repoChangedSpy.mockClear();
});

const down = () => new MemoryUnavailableError("memory service unavailable (read): network error (ECONNREFUSED)", "network");

function bootstrap() {
  const services = createServices({ dataDir: tempDir, agentRuntime: "local", sessionSecret: "test" });
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(services.store, fake);
  return { app: createApp(services), store: services.store, config: services.config, fake };
}

async function newUser(app: ReturnType<typeof createApp>, username: string) {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, userId: res.body.user.id as string };
}

/** A bare remote on `main` seeded with the given files. */
function seedRemote(name: string, files: Record<string, string>): string {
  const remote = makeBareRemote(path.join(remotesDir, `${name}.git`));
  const seed = path.join(remotesDir, `${name}-seed`);
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

const VAULT: Record<string, string> = {
  "wiki/concepts/foo.md": "---\ntitle: Foo\ntags: [a, b]\naliases: [Fu]\n---\n\nRelated: [[Bar]] and [[Nowhere]] and [[raw-note]].",
  "wiki/concepts/bar.md": "---\ntitle: Bar\n---\n\nBack to [[Fu|the foo]] and [[foo#heading]].",
  "wiki/entities/bar.md": "---\ntitle: Second bar\n---\n\nSame stem as the concept; [[Bar]] is the concept.",
  "wiki/concepts/한글.md": "한글 노트 [[Foo]]",
  "raw/2026/raw-note.md": "raw text [[Foo]]",
  // Structural pages and templates are never nodes.
  "wiki/index.md": "# Index\n\n- [[Foo]]",
  "wiki/log.md": "# Reflection log",
  "wiki/_template.md": "---\ntitle:\n---\n",
  "CLAUDE.md": "standing [[Foo]]",
};

describe("buildKnowledgeGraphFromNotes (a note source that is not a directory)", () => {
  const sourceOf = (notes: Record<string, string>) => ({
    // Service order (code-unit path order), which is not listTree's.
    list: async () => Object.keys(notes).sort().map((p) => ({ path: p })),
    read: async (p: string) => notes[p] ?? null,
  });

  it("builds the same graph buildKnowledgeGraph builds from a directory with the same notes", async () => {
    const root = path.join(tempDir, "tree");
    for (const [rel, content] of Object.entries(VAULT)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const fromDir = await buildKnowledgeGraph(root);
    const fromNotes = await buildKnowledgeGraphFromNotes(sourceOf(VAULT));
    expect(fromNotes).toEqual(fromDir);
    expect(fromNotes.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["wiki/concepts/foo.md", "wiki/concepts/bar.md", "wiki/entities/bar.md", "raw/2026/raw-note.md", "unresolved:nowhere"]),
    );
    expect(fromNotes.nodes.map((n) => n.id)).not.toContain("wiki/index.md");
    expect(fromNotes.edges).toContainEqual({ source: "wiki/concepts/foo.md", target: "wiki/concepts/bar.md" });
    // The team brain's own section function still applies.
    const sectioned = await buildKnowledgeGraphFromNotes(sourceOf(VAULT), { sectionOf: () => "x" });
    expect(sectioned.nodes.filter((n) => !n.dangling).every((n) => n.section === "x")).toBe(true);
  });

  it("answers noVault when the source holds no note under wiki/ or raw/, and an empty graph for structural pages only", async () => {
    expect(await buildKnowledgeGraphFromNotes(sourceOf({}))).toEqual({ nodes: [], edges: [], noVault: true });
    expect(await buildKnowledgeGraphFromNotes(sourceOf({ "CLAUDE.md": "x" }))).toEqual({ nodes: [], edges: [], noVault: true });
    expect(await buildKnowledgeGraphFromNotes(sourceOf({ "wiki/index.md": "# Index" }))).toEqual({ nodes: [], edges: [] });
  });

  it("leaves out a note the source answers null for, and aborts when the source rejects", async () => {
    const skipping = { ...sourceOf(VAULT), read: async (p: string) => (p === "wiki/concepts/bar.md" ? null : VAULT[p]) };
    const graph = await buildKnowledgeGraphFromNotes(skipping);
    expect(graph.nodes.map((n) => n.id)).not.toContain("wiki/concepts/bar.md");
    expect(graph.nodes.map((n) => n.id)).toContain("wiki/concepts/foo.md");

    const failing = { ...sourceOf(VAULT), read: async (p: string) => (p === "wiki/concepts/foo.md" ? Promise.reject(down()) : VAULT[p]) };
    await expect(buildKnowledgeGraphFromNotes(failing)).rejects.toBeInstanceOf(MemoryUnavailableError);
    await expect(buildKnowledgeGraphFromNotes({ list: () => Promise.reject(down()), read: async () => null })).rejects.toBeInstanceOf(
      MemoryUnavailableError,
    );
  });
});

describe("GET /api/me/knowledge-repo/graph and /note read the vault in the memory service", () => {
  async function memoryOwner(name: string) {
    const ctx = bootstrap();
    const { agent, userId } = await newUser(ctx.app, name);
    // The repository holds DIFFERENT notes (copies the retired mirror left): they must not be what the viewer sees.
    const remote = seedRemote(name, {
      ".claude-plugin/marketplace.json": JSON.stringify({ name, plugins: [] }),
      "wiki/concepts/stale.md": "---\ntitle: Stale\n---\nOnly in the repository.",
      "wiki/concepts/foo.md": "---\ntitle: Old Foo\n---\nOld text.",
      "wiki/.obsidian/plugin.md": "a repo file, not a vault note",
    });
    ctx.store.setKnowledgeRepo(userId, remote, "main");
    for (const [p, c] of Object.entries(VAULT)) ctx.fake.seed(userId, p, c);
    return { ...ctx, agent, userId };
  }

  it("builds the graph from the viewer's notes in the service", async () => {
    const s = await memoryOwner("graph");
    const res = await s.agent.get("/api/me/knowledge-repo/graph").expect(200);
    expect(res.body.graph).toEqual(
      await buildKnowledgeGraphFromNotes({
        list: async () => Object.keys(VAULT).map((p) => ({ path: p })),
        read: async (p) => VAULT[p] ?? null,
      }),
    );
    const ids = (res.body.graph.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(ids).toContain("wiki/concepts/foo.md");
    expect(ids).not.toContain("wiki/concepts/stale.md");
    expect(s.fake.calls.every((c) => c.owner === s.userId)).toBe(true);
    // No clone was needed for it.
    expect(fs.existsSync(knowledgeClonePath(s.userId, s.config))).toBe(false);

    // A vault with nothing under wiki/ or raw/ is the "no vault yet" answer.
    const other = await newUser(s.app, "graph-empty");
    s.store.setKnowledgeRepo(other.userId, "owner/brain", "main");
    const none = await other.agent.get("/api/me/knowledge-repo/graph").expect(200);
    expect(none.body.graph).toEqual({ nodes: [], edges: [], noVault: true });
  });

  it("answers 503 with a Korean message when the memory service is unavailable — never an empty graph", async () => {
    const s = await memoryOwner("graph-down");
    for (const op of ["list", "read"] as const) {
      s.fake.failNext(down(), { op });
      const res = await s.agent.get("/api/me/knowledge-repo/graph").expect(503);
      expect(res.body.error).toBe("메모리 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      expect(res.body.error).not.toMatch(/pi|gateway/i);
      expect(res.body.graph).toBeUndefined();
    }
    // The service answering "no" for a note is not an outage, but not a silent hole in the graph either.
    s.fake.failNext(new MemoryRefusedError("invalid_request", 400, "the request does not have the expected fields"), { op: "read" });
    const refused = await s.agent.get("/api/me/knowledge-repo/graph").expect(502);
    expect(refused.body.error).toContain("지식 그래프를 만들지 못했습니다");
    // Server not configured for memory at all: there is no other place the notes could be.
    setMemoryClientForTests(s.store, null);
    await s.agent.get("/api/me/knowledge-repo/graph").expect(503);
    // Without a repository the route still answers 404 first.
    s.store.setKnowledgeRepo(s.userId, null, null);
    await s.agent.get("/api/me/knowledge-repo/graph").expect(404);
  });

  it("reads one note from the service, 404s a missing one and 503s an outage", async () => {
    const s = await memoryOwner("note");
    const note = await s.agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/foo.md" }).expect(200);
    expect(note.body.note).toEqual({ path: "wiki/concepts/foo.md", content: VAULT["wiki/concepts/foo.md"] });
    const korean = await s.agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/한글.md" }).expect(200);
    expect(korean.body.note.content).toBe("한글 노트 [[Foo]]");

    // In the repository but not in the service: not found (the clone's copy is never served).
    const stale = await s.agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/stale.md" }).expect(404);
    expect(stale.body.error).toBe("노트를 찾을 수 없습니다.");
    await s.agent.get("/api/me/knowledge-repo/note").query({ path: "README.md" }).expect(400);

    s.fake.failNext(down(), { op: "read" });
    const outage = await s.agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/foo.md" }).expect(503);
    expect(outage.body.error).toBe("메모리 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");

    // Markdown the service cannot hold is a repo file: still read from the clone.
    const calls = s.fake.calls.length;
    const repoFile = await s.agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/.obsidian/plugin.md" }).expect(200);
    expect(repoFile.body.note.content).toBe("a repo file, not a vault note");
    expect(s.fake.calls.length).toBe(calls);
  });

  it("never serves the clone's files at vault paths: a viewer with an empty vault sees no graph and no note", async () => {
    const ctx = bootstrap();
    const { agent, userId } = await newUser(ctx.app, "cloneonly");
    const remote = seedRemote("cloneonly", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "r", plugins: [] }),
      "wiki/concepts/foo.md": "---\ntitle: Foo\n---\n\nRelated: [[Bar]].",
      "wiki/concepts/bar.md": "---\ntitle: Bar\n---\n\nStandalone.",
      "wiki/index.md": "# Index\n\n- [[Foo]]",
    });
    ctx.store.setKnowledgeRepo(userId, remote, "main");
    await agent.get("/api/me/knowledge-repo/contents").expect(200); // clones
    expect(fs.existsSync(path.join(knowledgeClonePath(userId, ctx.config), "wiki/concepts/foo.md"))).toBe(true);

    const graph = await agent.get("/api/me/knowledge-repo/graph").expect(200);
    expect(graph.body.graph).toEqual({ nodes: [], edges: [], noVault: true });
    const note = await agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/foo.md" }).expect(404);
    expect(note.body.error).toBe("노트를 찾을 수 없습니다.");
    // Another viewer's notes are never this viewer's.
    ctx.fake.seed("someone-else", "wiki/concepts/foo.md", "theirs");
    await agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/concepts/foo.md" }).expect(404);
    expect(ctx.fake.calls.every((c) => c.owner === userId)).toBe(true);
  });
});

describe("PUT /api/me/knowledge-repo tells the vault import about a new connection", () => {
  it("fires on a first connection, a different repository and a different branch — not on a re-save or a disconnect", async () => {
    const { app, store, config } = bootstrap();
    const { agent, userId } = await newUser(app, "connect");

    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);
    expect(repoChangedSpy.mock.lastCall).toEqual([store, config, userId]);

    // The same repository and branch saved again: not a change.
    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(1);

    // Only the branch changed: another branch holds its own files, so the hook runs.
    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain", branch: "dev" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(2);
    expect(repoChangedSpy.mock.lastCall).toEqual([store, config, userId]);
    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain", branch: "dev" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(2);
    // Back to the default branch (no branch given) is a branch change too.
    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/brain" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(3);
    expect(repoChangedSpy.mock.lastCall).toEqual([store, config, userId]);

    await agent.put("/api/me/knowledge-repo").send({ repo: "owner/other" }).expect(200);
    expect(repoChangedSpy).toHaveBeenCalledTimes(4);
    expect(repoChangedSpy.mock.lastCall).toEqual([store, config, userId]);

    await agent.put("/api/me/knowledge-repo").send({ repo: null }).expect(200);
    await agent.put("/api/me/knowledge-repo").send({ repo: "not a repo!" }).expect(400);
    expect(repoChangedSpy).toHaveBeenCalledTimes(4);

    // A hook that throws never fails the save.
    repoChangedSpy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const saved = await agent.put("/api/me/knowledge-repo").send({ repo: "owner/third" }).expect(200);
    expect(saved.body.user.knowledgeRepo).toBe("owner/third");
  });
});

describe("standing memory (CLAUDE.md) is the vault's note in the memory service", () => {
  function owner(name: string) {
    const { store, config } = createServices({ dataDir: path.join(tempDir, name), agentRuntime: "local", sessionSecret: "t" });
    const user = store.createUser({ username: name, displayName: name, password: "password123" });
    store.setKnowledgeRepo(user.id, "owner/brain", "main");
    const fake = createFakeMemoryClient();
    setMemoryClientForTests(store, fake);
    // The runs that load standing memory are pi runs (the local stub loads none).
    const piConfig = { ...config, agentRuntime: "pi" } as AppConfig;
    const clone = knowledgeClonePath(user.id, piConfig);
    const writeCloneClaudeMd = (content: string) => {
      fs.mkdirSync(clone, { recursive: true });
      fs.writeFileSync(path.join(clone, "CLAUDE.md"), content);
    };
    return { store, config: piConfig, localConfig: config, userId: user.id, fake, writeCloneClaudeMd };
  }

  it("reads CLAUDE.md from the service, trimmed, capped and with a truncation mark", async () => {
    const m = owner("mem");
    m.fake.seed(m.userId, "CLAUDE.md", "  standing rules\n\n");
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).toEqual({ personal: "standing rules" });
    m.fake.seed(m.userId, "CLAUDE.md", `  # Rules\n${"가".repeat(7000)}\n  `);
    const capped = (await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).personal!;
    expect(capped.startsWith("# Rules\n가")).toBe(true);
    expect(capped.length).toBe(6000 + "\n…(truncated)".length);
    expect(capped.endsWith("\n…(truncated)")).toBe(true);
    expect(m.fake.calls.every((c) => c.op === "read" && c.owner === m.userId && c.path === "CLAUDE.md")).toBe(true);
  });

  it("is null for a missing or empty note, and never falls back to the clone's file", async () => {
    const m = owner("missing");
    m.writeCloneClaudeMd("THE CLONE'S FILE — must not be read");
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).toEqual({ personal: null });
    m.fake.seed(m.userId, "CLAUDE.md", "  \n ");
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).toEqual({ personal: null });
    m.fake.seed(m.userId, "CLAUDE.md", "from the service");
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).toEqual({ personal: "from the service" });

    // No repository connected: nothing is loaded and the service is not asked.
    const calls = m.fake.calls.length;
    m.store.setKnowledgeRepo(m.userId, null, null);
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).toEqual({ personal: null });
    // The local stub runtime loads no standing memory, as before.
    m.store.setKnowledgeRepo(m.userId, "owner/brain", "main");
    expect(await loadKnowledgeRepoMemory(m.store, m.userId, m.localConfig)).toEqual({ personal: null });
    expect(m.fake.calls.length).toBe(calls);
  });

  it("puts a notice in the memory's place when the service is unavailable — never a silent 'no memory'", async () => {
    const m = owner("outage");
    m.fake.seed(m.userId, "CLAUDE.md", "the owner's rules");
    m.writeCloneClaudeMd("THE CLONE'S FILE");
    m.fake.failNext(down());
    const memory = await loadKnowledgeRepoMemory(m.store, m.userId, m.config);
    expect(memory.personal).toBe(STANDING_MEMORY_UNAVAILABLE_NOTICE);
    expect(memory.personal).toContain("could NOT be loaded");
    expect(memory.personal).toContain("memory service");
    expect(memory.personal).toContain("mcp__repo__read_file");
    expect(memory.personal).not.toMatch(/pi-gateway/i);
    expect(memory.personal).not.toContain("the owner's rules");
    expect(memory.personal!.length).toBeLessThan(6000);
    // The server has no memory service configured at all: the same notice (never the clone's file).
    setMemoryClientForTests(m.store, null);
    expect((await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).personal).toBe(STANDING_MEMORY_UNAVAILABLE_NOTICE);
    // The next conversation, with the service back, gets the real text.
    setMemoryClientForTests(m.store, m.fake);
    expect((await loadKnowledgeRepoMemory(m.store, m.userId, m.config)).personal).toBe("the owner's rules");
  });

  it("does not hold a turn for a memory service that hangs: past the deadline the notice takes the memory's place", async () => {
    // The read is awaited at the start of every turn; the client's own timeout is 15 s.
    expect(STANDING_MEMORY_VAULT_DEADLINE_MS).toBe(3000);
    const m = owner("slow");
    m.fake.seed(m.userId, "CLAUDE.md", "the owner's rules");
    m.fake.beforeNext("read", () => new Promise<void>((resolve) => setTimeout(resolve, 500)));
    const started = Date.now();
    const memory = await loadKnowledgeRepoMemory(m.store, m.userId, m.config, { vaultDeadlineMs: 40 });
    expect(memory.personal).toBe(STANDING_MEMORY_UNAVAILABLE_NOTICE);
    expect(Date.now() - started).toBeLessThan(400);
    // The slow read ends by itself and bothers nobody; an answer inside the deadline is the memory.
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect((await loadKnowledgeRepoMemory(m.store, m.userId, m.config, { vaultDeadlineMs: 2000 })).personal).toBe("the owner's rules");
    // A missing note inside the deadline is still "no standing memory", not the notice.
    const none = owner("slow-none");
    expect(await loadKnowledgeRepoMemory(none.store, none.userId, none.config, { vaultDeadlineMs: 2000 })).toEqual({ personal: null });
  });

  it("the note route never serves a clone file reached through a link into the vault folders", async () => {
    const ctx = bootstrap();
    const { agent, userId } = await newUser(ctx.app, "alias");
    const remote = seedRemote("alias", {
      ".claude-plugin/marketplace.json": JSON.stringify({ name: "a", plugins: [] }),
      "wiki/concepts/a.md": "the clone's copy\n",
    });
    ctx.store.setKnowledgeRepo(userId, remote, "main");
    await agent.get("/api/me/knowledge-repo/contents").expect(200); // clones
    fs.symlinkSync("concepts", path.join(knowledgeClonePath(userId, ctx.config), "wiki", ".link"));
    // That file is not served; the note itself comes from the service.
    ctx.fake.seed(userId, "wiki/concepts/a.md", "the vault's text\n");
    await agent.get("/api/me/knowledge-repo/note").query({ path: "wiki/.link/a.md" }).expect(404);
    const note = await agent.get("/api/me/knowledge-repo/note").query({ path: "wiki//concepts/a.md" }).expect(200);
    expect(note.body.note.content).toBe("the vault's text\n");
  });
});
