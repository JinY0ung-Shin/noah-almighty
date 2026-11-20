/**
 * The chat's 파일 tab at the route (`/api/me/workspace*`): a user's OWN pi
 * sandbox workspace, listed and read through pinned descriptors. What must
 * hold: it is self-scoped (no way to name another user's files), nothing below
 * the user root is reached through a link, a path is plain segments, and the
 * bytes never come back as something this origin would render — an .html file
 * runs, but only as a frame's document in an origin of its own, under a policy
 * that lets it load nothing.
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
import { workspacePathOfHostFile } from "../src/server/workspaceBrowser.js";
import {
  WORKSPACE_HTML_PAGE_CSP,
  WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER,
  WORKSPACE_HTML_PAGE_TICKET_TTL_MS,
  WorkspaceHtmlPageTickets,
} from "../src/server/routes/workspaceFiles.js";
import {
  WORKSPACE_HTML_PAGE_SANDBOX,
  WORKSPACE_IMAGE_PREVIEW_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_TEXT_PREVIEW_MAX_BYTES,
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

describe("workspacePathOfHostFile (where a shared file's card points)", () => {
  it("names a file below the root by the tab's own path grammar, and nothing else", () => {
    const root = path.join(dir(), "u-root");
    fs.mkdirSync(path.join(root, "c", "abc", "deck"), { recursive: true });
    const real = fs.realpathSync(root);
    expect(workspacePathOfHostFile(root, path.join(real, "c", "abc", "deck", "분기 보고.pptx"))).toBe("c/abc/deck/분기 보고.pptx");
    expect(workspacePathOfHostFile(root, path.join(real, "..notes.md"))).toBe("..notes.md");
    // The root itself, a file outside it, a sibling whose name only starts like the root.
    expect(workspacePathOfHostFile(root, real)).toBeUndefined();
    expect(workspacePathOfHostFile(root, path.join(real, "..", "other", "a.md"))).toBeUndefined();
    expect(workspacePathOfHostFile(root, `${real}-2/a.md`)).toBeUndefined();
    // A name the tab's routes would refuse is never recorded.
    expect(workspacePathOfHostFile(root, path.join(real, "a\\b.md"))).toBeUndefined();
    expect(workspacePathOfHostFile(root, path.join(real, ...Array(65).fill("d"), "a.md"))).toBeUndefined();
    // A root that does not exist names nothing.
    expect(workspacePathOfHostFile(path.join(dir(), "missing"), path.join(real, "a.md"))).toBeUndefined();
  });

  it("resolves the root the way the shared file's path was resolved (a linked mount)", () => {
    const root = path.join(dir(), "u-real");
    fs.mkdirSync(root, { recursive: true });
    const linked = path.join(dir(), "u-linked");
    fs.symlinkSync(root, linked);
    expect(workspacePathOfHostFile(linked, path.join(fs.realpathSync(root), "uploads", "a.pdf"))).toBe("uploads/a.pdf");
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

describe("GET /api/me/workspace/html (an .html file as a page that runs)", () => {
  /** The request a browser makes for a frame's document. */
  const asFrame = { "Sec-Fetch-Dest": "iframe" };
  type Agent = ReturnType<typeof request.agent>;
  const directives = (header: string): Record<string, string> =>
    Object.fromEntries(
      header.split(";").map((part) => {
        const [name, ...rest] = part.trim().split(/\s+/);
        return [name, rest.join(" ")];
      }),
    );
  /** What the app does before it mounts the frame: one ticket for one load of `file`. */
  const ticketFor = async (agent: Agent, file: string): Promise<string> =>
    (await agent.post("/api/me/workspace/html-ticket").send({ path: file }).expect(200)).body.ticket as string;
  /** The frame's request for `file`, with a fresh ticket; the answer must have `status`. */
  const page = async (agent: Agent, file: string, status: number): Promise<request.Response> =>
    agent
      .get("/api/me/workspace/html")
      .query({ path: file, ticket: await ticketFor(agent, file) })
      .set(asFrame)
      .expect(status);

  it("serves the page with scripts on, an opaque origin and nothing loadable — to its owner's frame only", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const html = "<!doctype html><h1>보고서</h1><script>document.title = 'ran'</script>";
    seed(workspacesDir, me, { "c/x/보고서.html": html });

    const res = await page(agent, "c/x/보고서.html", 200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.text).toBe(html);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-disposition"]).toBeUndefined();

    // The whole policy, directive by directive: anything added or widened fails here.
    expect(res.headers["content-security-policy"]).toBe(WORKSPACE_HTML_PAGE_CSP);
    expect(directives(res.headers["content-security-policy"])).toEqual({
      // An origin of its own, whoever loads the response: scripts and form events, nothing else.
      sandbox: "allow-scripts allow-forms",
      // Nothing from the network: only what the file itself carries.
      "default-src": "'none'",
      "script-src": "'unsafe-inline' 'unsafe-eval'",
      "style-src": "'unsafe-inline'",
      "img-src": "data: blob:",
      "media-src": "data: blob:",
      "font-src": "data:",
      "form-action": "'none'",
      "base-uri": "'none'",
      // Framed by Noah's own pages only (the app-wide DENY / 'none' is replaced for this answer).
      "frame-ancestors": "'self'",
    });
    expect(WORKSPACE_HTML_PAGE_SANDBOX).toBe("allow-scripts allow-forms");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");

    // Another user's session reads another workspace: the same path is not there.
    const other = request.agent(app);
    await signup(other, "bob").expect(201);
    const missing = await page(other, "c/x/보고서.html", 404);
    expect(missing.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // No session: the app-wide JSON refusal, which no frame may show.
    const anonymous = await request(app).get("/api/me/workspace/html").query({ path: "c/x/보고서.html" }).set(asFrame).expect(401);
    expect(anonymous.headers["content-type"]).toContain("application/json");
    expect(anonymous.headers["x-frame-options"]).toBe("DENY");
    await request(app).post("/api/me/workspace/html-ticket").send({ path: "c/x/보고서.html" }).expect(401);
  });

  it("serves nothing for the address alone: a page runs for a one-use ticket of this user for this file", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    seed(workspacesDir, me, { "a.html": "<script>1</script>", "b.html": "<script>2</script>" });
    const other = request.agent(app);
    const bob = (await signup(other, "bob").expect(201)).body.user.id as string;
    seed(workspacesDir, bob, { "a.html": "<script>bob</script>" });
    const get = (who: Agent, query: Record<string, string>) => who.get("/api/me/workspace/html").query(query).set(asFrame);
    const refused = async (res: request.Response): Promise<void> => {
      expect(res.status).toBe(403);
      // A refusal the frame can show: text, with nothing of the file in it.
      expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(res.text).not.toContain("script");
      expect(directives(res.headers["content-security-policy"]).sandbox).toBe("");
    };

    // No ticket (a link, a typed address, the page reloading itself), or one never issued.
    await refused(await get(agent, { path: "a.html" }));
    await refused(await get(agent, { path: "a.html", ticket: "" }));
    await refused(await get(agent, { path: "a.html", ticket: "x".repeat(43) }));

    // One load, then it is spent.
    const ticket = await ticketFor(agent, "a.html");
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await get(agent, { path: "a.html", ticket }).expect(200)).text).toBe("<script>1</script>");
    await refused(await get(agent, { path: "a.html", ticket }));

    // For this file only — and a wrong use spends it too.
    const forA = await ticketFor(agent, "a.html");
    await refused(await get(agent, { path: "b.html", ticket: forA }));
    await refused(await get(agent, { path: "a.html", ticket: forA }));

    // For this user only.
    const alices = await ticketFor(agent, "a.html");
    await refused(await get(other, { path: "a.html", ticket: alices }));
    await refused(await get(agent, { path: "a.html", ticket: alices }));

    // A ticket is for an .html file by a plain path; what is there is the page route's answer.
    await agent.post("/api/me/workspace/html-ticket").send({ path: "notes.txt" }).expect(400);
    await agent.post("/api/me/workspace/html-ticket").send({ path: "../a.html" }).expect(400);
    await agent.post("/api/me/workspace/html-ticket").send({ path: "" }).expect(400);
    await agent.post("/api/me/workspace/html-ticket").send({}).expect(400);
    await agent.post("/api/me/workspace/html-ticket").send({ path: ["a.html"] }).expect(400);
    await page(agent, "gone.html", 404);

    // Another site cannot ask for one with the user's session.
    await agent
      .post("/api/me/workspace/html-ticket")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ path: "a.html" })
      .expect(403);
  });

  it("keeps a ticket for a minute, and a bounded number per user", () => {
    const tickets = new WorkspaceHtmlPageTickets();
    const fresh = tickets.issue("u1", "a.html", 1_000);
    expect(tickets.redeem(fresh, "u1", "a.html", 1_000 + WORKSPACE_HTML_PAGE_TICKET_TTL_MS - 1)).toBe(true);
    const late = tickets.issue("u1", "a.html", 1_000);
    expect(tickets.redeem(late, "u1", "a.html", 1_000 + WORKSPACE_HTML_PAGE_TICKET_TTL_MS)).toBe(false);
    expect(tickets.redeem(undefined, "u1", "a.html")).toBe(false);
    expect(tickets.redeem(["x"], "u1", "a.html")).toBe(false);

    // A user's own oldest go first once they hold the cap; nobody else's are touched.
    const others = tickets.issue("u1", "a.html", 5_000);
    const mine: string[] = [];
    for (let i = 0; i < WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER + 5; i += 1) mine.push(tickets.issue("u2", "b.html", 5_000));
    expect(mine.slice(0, 5).map((id) => tickets.redeem(id, "u2", "b.html", 5_000))).toEqual([false, false, false, false, false]);
    expect(mine.slice(5).every((id) => tickets.redeem(id, "u2", "b.html", 5_000))).toBe(true);
    expect(tickets.redeem(others, "u1", "a.html", 5_000)).toBe(true);
    // Expired tickets do not count against the cap.
    for (let i = 0; i < WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER; i += 1) tickets.issue("u3", "c.html", 10_000);
    const afterExpiry = Array.from({ length: WORKSPACE_HTML_PAGE_TICKET_MAX_PER_USER }, () =>
      tickets.issue("u3", "c.html", 10_000 + WORKSPACE_HTML_PAGE_TICKET_TTL_MS),
    );
    expect(afterExpiry.every((id) => tickets.redeem(id, "u3", "c.html", 10_000 + WORKSPACE_HTML_PAGE_TICKET_TTL_MS))).toBe(true);
  });

  it("is not a page of its own: a request the browser marks as anything but a frame's document is refused", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    seed(workspacesDir, me, { "page.html": "<script>top.location = 'https://elsewhere.example/'</script>" });
    for (const dest of ["document", "empty", "image", "script", "embed", "object", "frame", ""]) {
      const res = await agent
        .get("/api/me/workspace/html")
        .query({ path: "page.html", ticket: await ticketFor(agent, "page.html") })
        .set("Sec-Fetch-Dest", dest)
        .expect(400);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.text).not.toContain("elsewhere");
      // The app-wide framing refusal still stands on a refusal.
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
    // No mark at all is a plain-HTTP deployment (browsers send fetch metadata only to https and
    // localhost): the frame's request looks like this there, so it is served — for a ticket, under the same policy.
    const ticket = await ticketFor(agent, "page.html");
    const unmarked = await agent.get("/api/me/workspace/html").query({ path: "page.html", ticket }).expect(200);
    expect(unmarked.headers["content-security-policy"]).toBe(WORKSPACE_HTML_PAGE_CSP);
    // HEAD answers like GET, without the page.
    const head = await agent
      .head("/api/me/workspace/html")
      .query({ path: "page.html", ticket: await ticketFor(agent, "page.html") })
      .set(asFrame)
      .expect(200);
    expect(head.headers["content-security-policy"]).toBe(WORKSPACE_HTML_PAGE_CSP);
    expect(head.text ?? "").toBe("");
  });

  it("runs only an .html file within the text preview cap, and shows the frame a plain-text notice otherwise", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    const root = seed(workspacesDir, me, {
      "binary.html": Buffer.from([0x3c, 0x00, 0x68, 0x00]),
      "dir/x.html": "<p>x</p>",
      "folder.html/inner.txt": "x",
    });
    fs.writeFileSync(path.join(root, "big.html"), "");
    fs.truncateSync(path.join(root, "big.html"), WORKSPACE_TEXT_PREVIEW_MAX_BYTES + 1);
    fs.symlinkSync(path.join(root, "dir", "x.html"), path.join(root, "alias.html"));

    const refused: [string, number][] = [
      ["binary.html", 400],
      ["big.html", 400],
      ["folder.html", 404], // a folder is not a file
      ["alias.html", 404], // a link is never followed
      ["nope.html", 404],
    ];
    for (const [file, status] of refused) {
      const res = await page(agent, file, status);
      // What the frame shows is text: nothing in the answer runs or loads.
      expect(res.headers["content-type"], file).toBe("text/plain; charset=utf-8");
      expect(directives(res.headers["content-security-policy"]), file).toEqual({
        sandbox: "",
        "default-src": "'none'",
        "frame-ancestors": "'self'",
      });
      expect(res.headers["x-frame-options"], file).toBe("SAMEORIGIN");
      expect(res.text, file).not.toContain("<");
    }
    // A bad path is refused before any ticket is looked at.
    const bad = await agent.get("/api/me/workspace/html").query({ path: "../x.html", ticket: "t" }).set(asFrame).expect(400);
    expect(bad.headers["content-type"]).toBe("text/plain; charset=utf-8");
    await page(agent, "dir/x.html", 200);
  });

  it("sends the page as the text the tab reads: UTF-8 whatever the file was saved in", async () => {
    const { app, workspacesDir } = boot();
    const agent = request.agent(app);
    const me = (await signup(agent, "alice").expect(201)).body.user.id as string;
    seed(workspacesDir, me, {
      // "<p>한글</p>" in CP949, with a meta that names it (the header's charset wins).
      "cp949.html": Buffer.concat([
        Buffer.from('<meta charset="euc-kr"><p>'),
        Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]),
        Buffer.from("</p>"),
      ]),
      "bom.html": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<p>한글</p>")]),
      "empty.html": "",
      "PAGE.HTM": "<p>htm</p>",
    });
    const cp949 = await page(agent, "cp949.html", 200);
    expect(cp949.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(cp949.text).toBe('<meta charset="euc-kr"><p>한글</p>');
    expect((await page(agent, "bom.html", 200)).text).toBe("<p>한글</p>");
    expect((await page(agent, "empty.html", 200)).text).toBe("");
    expect((await page(agent, "PAGE.HTM", 200)).text).toBe("<p>htm</p>");
  });

  it("is unavailable where the 파일 tab is", async () => {
    const { app } = boot({ workspaces: false });
    const agent = request.agent(app);
    await signup(agent, "alice").expect(201);
    await page(agent, "a.html", 404);
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
