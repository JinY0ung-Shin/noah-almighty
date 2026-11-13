/**
 * The chat's 파일 tab at the route (`/api/me/workspace*`): a user's OWN pi
 * sandbox workspace, listed and read through pinned descriptors. What must
 * hold: it is self-scoped (no way to name another user's files), nothing below
 * the user root is reached through a link, a path is plain segments, and the
 * bytes never come back as something this origin would render.
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { signup, withTempDir } from "./helpers.js";

// The document converter is LibreOffice: a fake stands in (two pages per document).
const RENDER = vi.hoisted(() => ({
  page: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
  available: true,
  calls: [] as string[],
}));
vi.mock("../src/server/deckRender.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/deckRender.js")>()),
  probeDocumentPreviews: () => RENDER.available,
  renderDocumentPreviews: vi.fn(async (sourcePath: string) => {
    RENDER.calls.push(sourcePath);
    return [RENDER.page, RENDER.page];
  }),
}));

import { createApp, createServices } from "../src/server/app.js";
import { piUserKey } from "../src/server/agent/pi/piWorkspace.js";
import { PinnedDir } from "../src/server/pinnedFs.js";
import {
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  type WorkspaceEntry,
  type WorkspaceListing,
} from "../src/shared/workspaceFiles.js";

const dir = withTempDir("routes-workspace-files");

let boots = 0;
function boot(options: { runtime?: "pi" | "local"; workspaces?: boolean } = {}) {
  const workspacesDir = path.join(dir(), "pi-workspaces");
  fs.mkdirSync(workspacesDir, { recursive: true });
  const services = createServices({
    dataDir: path.join(dir(), `data-${(boots += 1)}`),
    agentRuntime: options.runtime ?? "pi",
    pi: {
      gatewayUrl: "http://pi.invalid",
      apiKey: "test-key",
      deckSandbox: false,
      ...(options.workspaces === false ? {} : { workspacesDir }),
    },
    sessionSecret: "test",
  });
  return { services, app: createApp(services), store: services.store, workspacesDir };
}

/** Write `files` (relative path → content) into `userId`'s sandbox workspace. */
function seed(workspacesDir: string, userId: string, files: Record<string, string | Buffer>): string {
  const root = path.join(workspacesDir, piUserKey(userId));
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

const names = (listing: WorkspaceListing) => listing.entries.map((entry) => entry.name);
const entryOf = (listing: WorkspaceListing, name: string) =>
  listing.entries.find((entry) => entry.name === name) as WorkspaceEntry;

describe("GET /api/me/workspace", () => {
  it("needs a session", async () => {
    const { app } = boot();
    await request(app).get("/api/me/workspace").expect(401);
    await request(app).get("/api/me/workspace/file?path=a.txt").expect(401);
  });

  it("lists the root of a user who never ran anything as an empty, non-existent folder", async () => {
    const { app } = boot();
    const agent = request.agent(app);
    await signup(agent, "alice").expect(201);
    const res = await agent.get("/api/me/workspace").expect(200);
    expect(res.body).toEqual({ path: "", exists: false, entries: [], total: 0, truncated: false });
    expect(res.headers["cache-control"]).toBe("private, no-store");
    await agent.get("/api/me/workspace?path=c").expect(404);
  });

  it("lists a folder: folders first, then names in natural order, with sizes and kinds", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const root = seed(workspacesDir, me, {
      "b10.txt": "0123456789",
      "b2.txt": "x",
      "a/inner.md": "# hi",
      ".noah/skills/x": "s",
    });
    fs.symlinkSync("/etc/passwd", path.join(root, "link"));
    const listing = (await agent.get("/api/me/workspace").expect(200)).body as WorkspaceListing;
    expect(listing.exists).toBe(true);
    expect(names(listing)).toEqual([".noah", "a", "b2.txt", "b10.txt", "link"]);
    expect(entryOf(listing, "a").kind).toBe("dir");
    expect(entryOf(listing, "a").size).toBeUndefined();
    expect(entryOf(listing, "b10.txt")).toMatchObject({ kind: "file", size: 10 });
    expect(Date.parse(entryOf(listing, "b10.txt").modifiedAt ?? "")).toBeGreaterThan(0);
    // A link is a link: its target's kind and size never show.
    expect(entryOf(listing, "link").kind).toBe("link");
    expect(entryOf(listing, "link").size).toBeUndefined();

    const inner = (await agent.get("/api/me/workspace?path=a").expect(200)).body as WorkspaceListing;
    expect(inner.path).toBe("a");
    expect(names(inner)).toEqual(["inner.md"]);
  });

  it("is the caller's own workspace only", async () => {
    const { app, workspacesDir } = boot();
    const alice = request.agent(app);
    const aliceId = (await signup(alice, "alice").expect(201)).body.user.id as string;
    const bob = request.agent(app);
    const bobId = (await signup(bob, "bob").expect(201)).body.user.id as string;
    seed(workspacesDir, aliceId, { "alice.txt": "A" });
    seed(workspacesDir, bobId, { "bob.txt": "B" });
    expect(names((await alice.get("/api/me/workspace").expect(200)).body)).toEqual(["alice.txt"]);
    expect(names((await bob.get("/api/me/workspace").expect(200)).body)).toEqual(["bob.txt"]);
    await bob.get("/api/me/workspace/file?path=alice.txt").expect(404);
    // No spelling of a path leaves the caller's root.
    for (const bad of ["..", `../${piUserKey(aliceId)}`, "a/../..", "/etc", "a//b", "./a", "a\\b", "a/"]) {
      await bob.get("/api/me/workspace").query({ path: bad }).expect(400);
      await bob.get("/api/me/workspace/file").query({ path: bad }).expect(400);
    }
    await bob.get("/api/me/workspace/file").expect(400);
  });

  it("never walks through a link the sandbox planted", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const root = seed(workspacesDir, me, { "real/file.txt": "ok" });
    const outside = path.join(dir(), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET");
    fs.symlinkSync(outside, path.join(root, "out"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "real", "alias.txt"));
    fs.symlinkSync(workspacesDir, path.join(root, "all"));

    await agent.get("/api/me/workspace?path=out").expect(404);
    await agent.get("/api/me/workspace?path=all").expect(404);
    await agent.get("/api/me/workspace/file?path=out/secret.txt").expect(404);
    await agent.get("/api/me/workspace/file?path=real/alias.txt").expect(404);
    await agent.get("/api/me/workspace/file?path=real").expect(404); // a folder is not a file
    const ok = await agent.get("/api/me/workspace/file?path=real/file.txt").expect(200);
    expect(ok.body.toString()).toBe("ok");
  });

  it("refuses a user root that is itself a link", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const elsewhere = path.join(dir(), "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "x.txt"), "X");
    fs.symlinkSync(elsewhere, path.join(workspacesDir, piUserKey(me)));
    const res = await agent.get("/api/me/workspace").expect(200);
    expect(res.body.exists).toBe(false);
    await agent.get("/api/me/workspace/file?path=x.txt").expect(404);
  });

  it("names the user's conversations in c/, most recent first, and marks a folder no conversation owns", async () => {
    const { app, store, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const older = "11111111-1111-4111-8111-111111111111";
    const newer = "22222222-2222-4222-8222-222222222222";
    const gone = "33333333-3333-4333-8333-333333333333";
    store.touchConversation(me, older, me, "첫 번째 대화");
    store.touchConversation(me, newer, me, "두 번째 대화");
    seed(workspacesDir, me, {
      [`c/${older}/a.txt`]: "a",
      [`c/${newer}/b.txt`]: "b",
      [`c/${gone}/c.txt`]: "c",
      "c/run-intro/d.txt": "d",
    });
    const listing = (await agent.get("/api/me/workspace?path=c").query({ conversation: newer }).expect(200))
      .body as WorkspaceListing;
    expect(listing.current).toBe(`c/${newer}`);
    const titled = listing.entries.filter((entry) => entry.conversation).map((entry) => entry.conversation!.title);
    expect(titled.sort()).toEqual(["두 번째 대화", "첫 번째 대화"]);
    // The titled folders lead; the rest follow by name.
    expect(names(listing).slice(2)).toEqual([gone, "run-intro"]);
    expect(entryOf(listing, gone).orphan).toBe(true);
    expect(entryOf(listing, "run-intro").orphan).toBeUndefined();
    expect(entryOf(listing, "run-intro").conversation).toBeUndefined();
    // `current` is only a path: it is named for a conversation that has no folder yet, too.
    const root = (await agent.get("/api/me/workspace").query({ conversation: "not-yet" }).expect(200)).body;
    expect(root.current).toBe("c/not-yet");
    const odd = (await agent.get("/api/me/workspace").query({ conversation: "a/../b" }).expect(200)).body;
    expect(odd.current).toMatch(/^c\/h-[0-9a-f]{32}$/);
  });

  it("cuts a large folder at the cap and says how many it holds", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const files: Record<string, string> = {};
    for (let i = 0; i < WORKSPACE_LIST_MAX_ENTRIES + 5; i += 1) files[`many/f${i}.txt`] = "";
    seed(workspacesDir, me, files);
    const listing = (await agent.get("/api/me/workspace?path=many").expect(200)).body as WorkspaceListing;
    expect(listing.entries).toHaveLength(WORKSPACE_LIST_MAX_ENTRIES);
    expect(listing.total).toBe(WORKSPACE_LIST_MAX_ENTRIES + 5);
    expect(listing.truncated).toBe(true);
  });

  it("reads a bounded number of entries however large the folder is", () => {
    const folder = path.join(dir(), "huge");
    fs.mkdirSync(folder);
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(folder, `f${i}`), "");
    const pinned = PinnedDir.open(folder)!;
    try {
      const cut = pinned.listUpTo(10);
      expect(cut.entries).toHaveLength(10);
      expect(cut.more).toBe(true);
      const all = pinned.listUpTo(30);
      expect(all.entries).toHaveLength(30);
      expect(all.more).toBe(false);
    } finally {
      pinned.close();
    }
  });

  it("lists a FIFO as something that cannot be opened, and never blocks on it", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const root = seed(workspacesDir, me, { "a.txt": "a" });
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    const listing = (await agent.get("/api/me/workspace").expect(200)).body as WorkspaceListing;
    expect(entryOf(listing, "pipe").kind).toBe("other");
    await agent.get("/api/me/workspace/file?path=pipe").expect(404);
  });

  it("is unavailable without the pi runtime or the workspaces mount, and bootstrap says so", async () => {
    for (const options of [{ runtime: "local" as const }, { workspaces: false }]) {
      const { app, services } = boot(options);
      const agent = request.agent(app);
      await signup(agent, "alice").expect(201);
      await agent.get("/api/me/workspace").expect(404);
      await agent.get("/api/me/workspace/file?path=a.txt").expect(404);
      expect((await agent.get("/api/bootstrap").expect(200)).body.workspaceFiles).toBe(false);
      services.store.close();
    }
    const { app } = boot();
    expect((await request(app).get("/api/bootstrap").expect(200)).body.workspaceFiles).toBe(true);
  });
});

describe("GET /api/me/workspace/file", () => {
  it("serves a file as a sandboxed download, typed only when it is an image", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    seed(workspacesDir, me, {
      "c/x/보고서.html": "<script>alert(1)</script>",
      "pic.png": png,
      "drawing.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
      "empty.txt": "",
    });

    const html = await agent.get("/api/me/workspace/file").query({ path: "c/x/보고서.html" }).expect(200);
    expect(html.headers["content-type"]).toBe("application/octet-stream");
    expect(html.headers["content-disposition"]).toContain("attachment;");
    expect(html.headers["content-disposition"]).toContain(encodeURIComponent("보고서.html"));
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(html.headers["content-security-policy"]).toContain("sandbox");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.headers["cache-control"]).toBe("private, no-store");
    expect(html.body.toString()).toBe("<script>alert(1)</script>");

    const image = await agent.get("/api/me/workspace/file?path=pic.png").expect(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-disposition"]).toContain("attachment;");
    expect(Buffer.compare(image.body, png)).toBe(0);

    const svg = await agent.get("/api/me/workspace/file?path=drawing.svg").expect(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toContain("sandbox");

    const empty = await agent.get("/api/me/workspace/file?path=empty.txt").expect(200);
    expect(empty.headers["content-length"]).toBe("0");
  });

  it("answers HEAD with the headers alone", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    seed(workspacesDir, me, { "a.txt": "0123456789" });
    const res = await agent.head("/api/me/workspace/file?path=a.txt").expect(200);
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["content-disposition"]).toContain("attachment;");
  });

  it("keeps a hostile file name out of the header", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const name = 'a"b\r\nSet-Cookie: x=1.txt';
    seed(workspacesDir, me, { [name]: "x" });
    const res = await agent.get("/api/me/workspace/file").query({ path: name }).expect(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-disposition"]).not.toMatch(/[\r\n]/);
    expect(res.headers["content-disposition"]).toContain(`filename="a'b_Set-Cookie: x=1.txt"`);
  });

  it("refuses a preview read past the cap and still downloads the file", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const root = seed(workspacesDir, me, {});
    const big = path.join(root, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, WORKSPACE_IMAGE_PREVIEW_MAX_BYTES + 1);
    await agent.get("/api/me/workspace/file?path=big.bin&preview=1").expect(413);
    // The download itself is not capped (HEAD: the 10 MiB body is not pulled through the test).
    const res = await agent.head("/api/me/workspace/file?path=big.bin").expect(200);
    expect(res.headers["content-length"]).toBe(String(WORKSPACE_IMAGE_PREVIEW_MAX_BYTES + 1));
  });
});

describe("GET /api/me/workspace/preview", () => {
  const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

  it("renders a document to page images that only its owner can fetch", async () => {
    RENDER.available = true;
    RENDER.calls.length = 0;
    const { app, workspacesDir } = boot();
    const alice = request.agent(app);
    const aliceId = (await signup(alice, "alice").expect(201)).body.user.id as string;
    const bob = request.agent(app);
    await signup(bob, "bob").expect(201);
    seed(workspacesDir, aliceId, { "c/x/보고서.pdf": PDF, "notes.txt": "text" });

    await request(app).get("/api/me/workspace/preview?path=a.pdf").expect(401);
    const preview = await alice.get("/api/me/workspace/preview").query({ path: "c/x/보고서.pdf" }).expect(200);
    expect(preview.body).toMatchObject({ status: "ready", pages: 2 });
    expect(RENDER.calls).toHaveLength(1);
    expect(RENDER.calls[0].startsWith(workspacesDir)).toBe(false);

    const page = await alice.get("/api/me/workspace/preview/page").query({ id: preview.body.id, n: 2 }).expect(200);
    expect(page.headers["content-type"]).toBe("image/png");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["content-security-policy"]).toContain("sandbox");
    expect(page.headers["cache-control"]).toContain("private");
    expect(Buffer.compare(page.body, RENDER.page)).toBe(0);

    await alice.get("/api/me/workspace/preview/page").query({ id: preview.body.id, n: 3 }).expect(404);
    await alice.get("/api/me/workspace/preview/page").query({ id: "../../x", n: 1 }).expect(404);
    await bob.get("/api/me/workspace/preview/page").query({ id: preview.body.id, n: 1 }).expect(404);
    await bob.get("/api/me/workspace/preview").query({ path: "c/x/보고서.pdf" }).expect(404);

    await alice.get("/api/me/workspace/preview").query({ path: "notes.txt" }).expect(400);
    await alice.get("/api/me/workspace/preview").query({ path: "../x.pdf" }).expect(400);
    await alice.get("/api/me/workspace/preview").expect(400);
    await alice.get("/api/me/workspace/preview").query({ path: "missing.pdf" }).expect(404);
  });

  it("says so when the server has no converter", async () => {
    RENDER.available = false;
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    seed(workspacesDir, me, { "a.pdf": PDF });
    const res = await agent.get("/api/me/workspace/preview?path=a.pdf").expect(200);
    expect(res.body).toEqual({ status: "failed", reason: "UNAVAILABLE" });
    RENDER.available = true;
  });

  it("removes a deleted user's rendered pages", async () => {
    RENDER.available = true;
    const { app, workspacesDir, services } = boot();
    const admin = request.agent(app);
    await signup(admin, "admin").expect(201);
    const bob = request.agent(app);
    const bobId = (await signup(bob, "bob").expect(201)).body.user.id as string;
    seed(workspacesDir, bobId, { "a.pdf": PDF });
    await bob.get("/api/me/workspace/preview?path=a.pdf").expect(200);
    const cache = path.join(services.config.dataDir, "workspace-previews", piUserKey(bobId));
    expect(fs.existsSync(cache)).toBe(true);
    await admin.delete(`/api/admin/users/${bobId}`).expect(200);
    expect(fs.existsSync(cache)).toBe(false);
  });
});
