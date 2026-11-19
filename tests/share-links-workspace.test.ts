/**
 * Workspace-file share links (the 파일 tab's 공유 링크): the owner shares ONE
 * file of their OWN sandbox workspace, Noah takes a COPY at that moment, and
 * the link serves that copy — never the workspace path. What must hold: only
 * the caller's own files can be named, only the types share_file publishes,
 * the workspace is never written, a later change of the file never reaches the
 * recipient, and the copy ends with its link.
 */
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, createServices } from "../src/server/app.js";
import { piUserKey } from "../src/server/agent/pi/piWorkspace.js";
import { LINK_SHAREABLE_EXTENSIONS, SHAREABLE_EXTENSIONS, isShareFileExtension } from "../src/server/chatFiles.js";
import { shareFilesDir } from "../src/server/shareFiles.js";
import type { Store } from "../src/server/store.js";
import {
  isShareableFileCard,
  isShareableFileName,
  isShareableWorkspacePath,
  SHAREABLE_FILE_EXTENSIONS,
  HTML_MEDIA_TYPE,
  isHtmlCard,
  SHARE_LINK_GONE_MESSAGE,
  type ShareLinkSummary,
  type ShareViewPayload,
} from "../src/shared/shareLinks.js";
import { signup, withTempDir } from "./helpers.js";

const dir = withTempDir("share-links-workspace");

let boots = 0;
function boot(options: { runtime?: "pi" | "local"; dataDir?: string } = {}) {
  const workspacesDir = path.join(dir(), "pi-workspaces");
  fs.mkdirSync(workspacesDir, { recursive: true });
  const dataDir = options.dataDir ?? path.join(dir(), `data-${(boots += 1)}`);
  const services = createServices({
    dataDir,
    agentRuntime: options.runtime ?? "pi",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "test-key", deckSandbox: false, workspacesDir },
    sessionSecret: "share-secret",
  });
  return { services, app: createApp(services), store: services.store, config: services.config, workspacesDir, dataDir };
}
type Booted = ReturnType<typeof boot>;
type Agent = ReturnType<typeof request.agent>;

const PDF = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(64, 1)]);
const PDF_V2 = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(64, 2)]);

async function newUser(app: Booted["app"], username: string): Promise<{ agent: Agent; id: string }> {
  const agent = request.agent(app);
  const res = await signup(agent, username).expect(201);
  return { agent, id: res.body.user.id as string };
}

/** Write `files` (relative path → content) into `userId`'s sandbox workspace. */
function seed(t: Booted, userId: string, files: Record<string, string | Buffer>): string {
  const root = path.join(t.workspacesDir, piUserKey(userId));
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function share(agent: Agent, filePath: unknown, body: object = {}) {
  return agent.post("/api/me/share-links/workspace").send({ path: filePath, ...body });
}
function open(agent: Agent, token: unknown) {
  return agent.post("/api/share/open").send({ token });
}
function tokenOf(url: string | null): string {
  const match = /#\/share\/([A-Za-z0-9_-]{43})$/.exec(url ?? "");
  if (!match) throw new Error(`not a share url: ${url}`);
  return match[1];
}
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}
function dbOf(store: Store) {
  return (store as unknown as { db: import("better-sqlite3").Database }).db;
}
const copies = (t: Booted): string[] => {
  try {
    return fs.readdirSync(shareFilesDir(t.config));
  } catch {
    return [];
  }
};
/** Every file under a directory, relative, with its content — to prove the workspace was not touched. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else out[child] = fs.readFileSync(path.join(root, child)).toString("base64");
    }
  };
  walk("");
  return out;
}

describe("the shared type list", () => {
  it("is what share_file publishes, minus an HTML page", () => {
    expect([...SHAREABLE_FILE_EXTENSIONS].sort()).toEqual([...LINK_SHAREABLE_EXTENSIONS].sort());
    // share_file delivers a .html page (its owner reads it in the 파일 tab); a link never exports one.
    expect(SHAREABLE_EXTENSIONS).toContain("html");
    expect(LINK_SHAREABLE_EXTENSIONS).not.toContain("html");
    expect([...LINK_SHAREABLE_EXTENSIONS, "html"].sort()).toEqual([...SHAREABLE_EXTENSIONS].sort());
    expect(isShareFileExtension("html")).toBe(false);
    expect(isShareFileExtension("pdf")).toBe(true);
    const page = { id: "h1", kind: "file", mediaType: HTML_MEDIA_TYPE, name: "보고서.html" } as const;
    expect(isHtmlCard(page)).toBe(true);
    expect(isShareableFileCard(page)).toBe(false);
    expect(isHtmlCard({ kind: "file", mediaType: "text/markdown" })).toBe(false);
    expect(isShareableFileName("보고서.PDF")).toBe(true);
    expect(isShareableFileName("notes.md")).toBe(true);
    for (const name of ["script.py", "page.html", "그림.png", "pdf", ".pdf", "archive.tar.gz"]) {
      expect(isShareableFileName(name), name).toBe(false);
    }
    // The 파일 tab's rule: such a type, and never under the folder of the user's attached documents.
    expect(isShareableWorkspacePath("c/conv-1/보고서.pdf")).toBe(true);
    expect(isShareableWorkspacePath("report.pdf")).toBe(true);
    expect(isShareableWorkspacePath("uploads/내 문서.pdf")).toBe(false);
    expect(isShareableWorkspacePath("uploads/sub/x.pdf")).toBe(false);
    expect(isShareableWorkspacePath("c/conv-1/uploads/x.pdf")).toBe(true);
    expect(isShareableWorkspacePath("c/conv-1/script.py")).toBe(false);
    // A stored card is not shape-checked: one without a media type is not linkable, never a throw.
    expect(isShareableFileCard({ kind: "file" } as never)).toBe(false);
  });
});

describe("workspace-file share links", () => {
  it("copies the file as it is NOW: the link keeps serving that copy after the workspace file changes or goes", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    const root = seed(t, owner.id, { "c/conv-1/보고서.pdf": PDF, "c/conv-1/notes.txt": "메모" });
    const before = snapshot(root);

    const res = await share(owner.agent, "c/conv-1/보고서.pdf").expect(201);
    const link = res.body.link as ShareLinkSummary;
    expect(res.body.created).toBe(true);
    expect(link).toMatchObject({
      kind: "workspace_file",
      conversationId: "",
      fileId: "",
      fileName: "보고서.pdf",
      sourcePath: "c/conv-1/보고서.pdf",
      slideCount: 0,
      messageCount: 0,
      includesFiles: false,
    });
    // The workspace is read, never written.
    expect(snapshot(root)).toEqual(before);
    expect(copies(t)).toEqual([link.id]);
    expect(t.store.listAudit(owner.id, true).find((a) => a.action === "share_link_create")?.detail).toBe(
      `link ${link.id} workspace "보고서.pdf" 7d`,
    );

    // The avatar rewrites the file, then removes it: the link is the copy.
    fs.writeFileSync(path.join(root, "c/conv-1/보고서.pdf"), PDF_V2);
    const token = tokenOf(link.url);
    const payload = (await open(viewer.agent, token).expect(200)).body as ShareViewPayload;
    // To a recipient it is a file: a name, a download, nothing about where it sat.
    expect(payload).toMatchObject({ kind: "file", fileName: "보고서.pdf", slides: [], ownerUsername: "owner" });
    expect(JSON.stringify(payload)).not.toContain("conv-1");
    const download = await viewer.agent.get(payload.downloadUrl).buffer(true).parse(binary).expect(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-disposition"]).toContain(encodeURIComponent("보고서.pdf"));
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(download.body as Buffer, PDF)).toBe(0);
    fs.rmSync(path.join(root, "c/conv-1/보고서.pdf"));
    await viewer.agent.get(payload.downloadUrl).expect(200);

    // One active link per file: asking again hands back the copy taken THEN.
    fs.writeFileSync(path.join(root, "c/conv-1/보고서.pdf"), PDF_V2);
    const again = await share(owner.agent, "c/conv-1/보고서.pdf", { expiresInDays: 30 }).expect(200);
    expect(again.body).toMatchObject({ created: false, link: { id: link.id, expiresAt: link.expiresAt } });
    expect(copies(t)).toEqual([link.id]);

    // Listed by its path, and among everything.
    const forFile = (
      await owner.agent.get(`/api/me/share-links?kind=workspace_file&path=${encodeURIComponent("c/conv-1/보고서.pdf")}`).expect(200)
    ).body as ShareLinkSummary[];
    expect(forFile.map((l) => l.id)).toEqual([link.id]);
    expect(
      (await owner.agent.get(`/api/me/share-links?kind=workspace_file&path=${encodeURIComponent("c/conv-1/notes.txt")}`).expect(200)).body,
    ).toEqual([]);
    expect((await owner.agent.get("/api/me/share-links?kind=file").expect(200)).body).toEqual([]);

    // Revoke ends the link AND the copy; a new press takes the file as it is now.
    await owner.agent.delete(`/api/me/share-links/${link.id}`).expect(204);
    expect(copies(t)).toEqual([]);
    expect((await open(viewer.agent, token).expect(404)).body.error).toBe(SHARE_LINK_GONE_MESSAGE);
    expect(t.store.listAudit(owner.id, true).find((a) => a.action === "share_link_revoke")?.detail).toBe(
      `link ${link.id} workspace "보고서.pdf"`,
    );
    const fresh = (await share(owner.agent, "c/conv-1/보고서.pdf").expect(201)).body.link as ShareLinkSummary;
    const freshPayload = (await open(viewer.agent, tokenOf(fresh.url)).expect(200)).body as ShareViewPayload;
    const freshBytes = await viewer.agent.get(freshPayload.downloadUrl).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(freshBytes.body as Buffer, PDF_V2)).toBe(0);
  });

  it("names only the caller's OWN files, by a plain path — and refuses what share_file would not publish", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const other = await newUser(t.app, "other");
    seed(t, owner.id, {
      "report.pdf": PDF,
      "uploads/내가 올린 문서.pdf": PDF,
      "fake.pdf": "not a pdf at all",
      "empty.txt": "",
      "script.py": "print(1)",
      "page.html": "<script>alert(1)</script>",
      "big.txt": Buffer.alloc(30 * 1024 * 1024 + 1, 0x61),
    });
    seed(t, other.id, { "secret.pdf": PDF });
    // A link out of the sandbox is never followed.
    const outside = path.join(dir(), "outside.pdf");
    fs.writeFileSync(outside, PDF);
    fs.symlinkSync(outside, path.join(t.workspacesDir, piUserKey(owner.id), "link.pdf"));

    await request(t.app).post("/api/me/share-links/workspace").send({ path: "report.pdf" }).expect(401);
    for (const bad of ["", "../report.pdf", "/etc/passwd.pdf", "a//b.pdf", "a\\b.pdf", 7, null]) {
      expect((await share(owner.agent, bad).expect(400)).body.error, String(bad)).toBe("경로가 올바르지 않습니다.");
    }
    expect((await share(owner.agent, "report.pdf", { expiresInDays: 3 }).expect(400)).body.error).toBe(
      "유효 기간은 1일, 7일, 30일 중에서 선택해 주세요.",
    );
    // Another user's file has no name here: the path is read in the caller's own workspace.
    expect((await share(owner.agent, "secret.pdf").expect(404)).body.error).toBe("파일을 찾을 수 없습니다.");
    expect((await share(owner.agent, "link.pdf").expect(404)).body.error).toBe("파일을 찾을 수 없습니다.");
    expect((await share(owner.agent, "missing.pdf").expect(404)).body.error).toBe("파일을 찾을 수 없습니다.");
    for (const unsupported of ["script.py", "page.html", "fake.pdf"]) {
      const res = await share(owner.agent, unsupported).expect(400);
      expect(res.body.error, unsupported).toContain("이 형식의 파일은 공유 링크를 만들 수 없습니다.");
    }
    expect((await share(owner.agent, "empty.txt").expect(400)).body.error).toBe("빈 파일은 공유할 수 없습니다.");
    // A document the user ATTACHED (pi writes it to uploads/) is never exported — the rule of an `uploaded` card.
    expect((await share(owner.agent, "uploads/내가 올린 문서.pdf").expect(400)).body.error).toBe(
      "직접 첨부한 파일은 공유 링크를 만들 수 없습니다.",
    );
    expect((await share(owner.agent, "big.txt").expect(413)).body.error).toContain("너무 큰 파일");
    // Nothing was created by any refusal — no row, no copy.
    expect((await owner.agent.get("/api/me/share-links").expect(200)).body).toEqual([]);
    expect(copies(t)).toEqual([]);
  });

  it("never hands back a link whose copy is gone: the file is taken again", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    seed(t, owner.id, { "report.pdf": PDF });
    const first = (await share(owner.agent, "report.pdf").expect(201)).body.link as ShareLinkSummary;
    // The copy store lost it (a restored volume) while the row stayed.
    fs.rmSync(path.join(shareFilesDir(t.config), first.id), { recursive: true });
    await open(viewer.agent, tokenOf(first.url)).expect(404);
    const again = await share(owner.agent, "report.pdf").expect(201);
    expect(again.body.created).toBe(true);
    expect(again.body.link.id).not.toBe(first.id);
    expect(copies(t)).toEqual([again.body.link.id]);
    await open(viewer.agent, tokenOf(again.body.link.url)).expect(200);
    expect(((await owner.agent.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[]).map((l) => l.id)).toEqual([
      again.body.link.id,
    ]);
  });

  it("removes an expired link's copy when the next link is made, not only when the list is opened", async () => {
    const t = boot();
    const owner = await newUser(t.app, "owner");
    seed(t, owner.id, { "a.pdf": PDF, "b.pdf": PDF });
    const a = (await share(owner.agent, "a.pdf").expect(201)).body.link as ShareLinkSummary;
    dbOf(t.store).prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), a.id);
    const b = (await share(owner.agent, "b.pdf").expect(201)).body.link as ShareLinkSummary;
    expect(copies(t)).toEqual([b.id]);
  });

  it("is refused where Noah cannot reach the workspaces", async () => {
    const t = boot({ runtime: "local" });
    const owner = await newUser(t.app, "owner");
    seed(t, owner.id, { "report.pdf": PDF });
    expect((await share(owner.agent, "report.pdf").expect(404)).body.error).toBe("이 서버에서는 작업 폴더를 볼 수 없습니다.");
  });

  it("ends the copy with the link: expiry, a suspended or deleted owner, and whatever a restart finds", async () => {
    const t = boot();
    const admin = await newUser(t.app, "admin");
    const owner = await newUser(t.app, "owner");
    const viewer = await newUser(t.app, "viewer");
    seed(t, owner.id, { "a.pdf": PDF, "b.pdf": PDF, "c.pdf": PDF });
    const a = (await share(owner.agent, "a.pdf").expect(201)).body.link as ShareLinkSummary;
    const b = (await share(owner.agent, "b.pdf").expect(201)).body.link as ShareLinkSummary;
    expect(copies(t).sort()).toEqual([a.id, b.id].sort());

    // A suspended owner's link stops opening; the copy waits for them.
    t.store.setSuspended(owner.id, true);
    await open(viewer.agent, tokenOf(a.url)).expect(404);
    t.store.setSuspended(owner.id, false);
    await open(viewer.agent, tokenOf(a.url)).expect(200);
    // (A suspension ends the owner's sessions.)
    await owner.agent.post("/api/auth/login").send({ username: "owner", password: "password123" }).expect(200);

    // An expired link serves nothing, and its copy goes at the next listing.
    dbOf(t.store).prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), a.id);
    await open(viewer.agent, tokenOf(a.url)).expect(404);
    const listed = (await owner.agent.get("/api/me/share-links").expect(200)).body as ShareLinkSummary[];
    expect(listed.map((l) => [l.id, l.expired])).toEqual([
      [b.id, false],
      [a.id, true],
    ]);
    expect(copies(t)).toEqual([b.id]);

    // A copy with no row (a crash between the two writes, a restored DB) and a
    // stray folder: a restart removes the first and leaves what is not a link's.
    const orphan = path.join(shareFilesDir(t.config), "11111111-2222-4333-8444-555555555555");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "file.pdf"), PDF);
    fs.mkdirSync(path.join(shareFilesDir(t.config), "not-a-link"), { recursive: true });
    t.services.store.close();
    const restarted = boot({ dataDir: t.dataDir });
    expect(copies(restarted).sort()).toEqual([b.id, "not-a-link"].sort());

    // Deleting the owner takes their links and the copies behind them.
    const adminAgent = request.agent(restarted.app);
    await adminAgent.post("/api/auth/login").send({ username: "admin", password: "password123" }).expect(200);
    await adminAgent.delete(`/api/admin/users/${owner.id}`).expect(200);
    expect(copies(restarted)).toEqual(["not-a-link"]);
    void admin;
  });
});
