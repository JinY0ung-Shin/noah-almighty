/**
 * The 파일 tab's document previews (`src/server/workspacePreviews.ts`): a pdf,
 * pptx or docx of a user's sandbox workspace as page images. What must hold:
 * the converter only ever gets Noah's own COPY of the bytes, a request never
 * waits out a conversion, conversions are bounded, a failure is not retried by
 * a poll, and the cache is per user and empties itself. The converter is a
 * fake here (the real one needs LibreOffice).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "./helpers.js";
import { piUserKey } from "../src/server/agent/pi/piWorkspace.js";
import { DECK_PREVIEW_FORMAT, DECK_PREVIEW_VERSION } from "../src/server/deckPreview.js";
import type { AppConfig } from "../src/server/types.js";
import { WorkspaceDocumentPreviews, deleteWorkspacePreviewsForUser } from "../src/server/workspacePreviews.js";
import { WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES } from "../src/shared/workspaceFiles.js";

const dir = withTempDir("workspace-previews");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\0\0[Content_Types].xml\0\0ppt/main.xml\0\0")]);
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function config(): AppConfig {
  const workspacesDir = path.join(dir(), "pi-workspaces");
  fs.mkdirSync(workspacesDir, { recursive: true });
  return {
    dataDir: path.join(dir(), "data"),
    agentRuntime: "pi",
    pi: { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false, workspacesDir },
  } as unknown as AppConfig;
}

function put(cfg: AppConfig, userId: string, rel: string, content: Buffer | string): string {
  const target = path.join(cfg.pi!.workspacesDir!, piUserKey(userId), rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

interface Call {
  sourcePath: string;
  ext: string;
  bytes: Buffer;
}

/** A converter that records what it was given and answers with `pages` images once `gate` (if any) opens. */
function fakeRenderer(pages = 2) {
  const calls: Call[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  return {
    calls,
    hold() {
      gate = new Promise<void>((resolve) => (open = resolve));
    },
    release() {
      open();
      gate = null;
    },
    render: async (sourcePath: string, ext: string): Promise<Buffer[]> => {
      calls.push({ sourcePath, ext, bytes: fs.readFileSync(sourcePath) });
      if (gate) await gate;
      return Array.from({ length: pages }, () => PNG);
    },
  };
}

const seg = (rel: string) => rel.split("/");

describe("WorkspaceDocumentPreviews", () => {
  it("renders a document once and serves its pages to the same user only", async () => {
    const cfg = config();
    const fake = fakeRenderer(3);
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render });
    put(cfg, "alice", "c/x/report.pdf", PDF);

    const first = await previews.request("alice", seg("c/x/report.pdf"));
    expect(first).toMatchObject({ status: "ready", pages: 3 });
    const id = (first as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // Asking again is the cache: no second conversion.
    expect(await previews.request("alice", seg("c/x/report.pdf"))).toEqual(first);
    expect(fake.calls).toHaveLength(1);

    const page = previews.page("alice", id, "2")!;
    expect(page.mediaType).toBe("image/png");
    expect(fs.readFileSync(page.path).equals(PNG)).toBe(true);
    expect(page.path.startsWith(path.join(cfg.dataDir, "workspace-previews", piUserKey("alice")))).toBe(true);
    for (const n of ["0", "4", "-1", "1.5", "abc", "", undefined, 1]) expect(previews.page("alice", id, n)).toBeNull();
    for (const bad of ["../x", "x", `${id}/..`, undefined, 3]) expect(previews.page("alice", bad, "1")).toBeNull();
    // Another user holding the id gets nothing.
    expect(previews.page("bob", id, "1")).toBeNull();
  });

  it("hands the converter Noah's own copy under a fixed name, and removes it", async () => {
    const cfg = config();
    const fake = fakeRenderer();
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render });
    const source = put(cfg, "alice", "c/x/이름 --outdir evil.pptx", PPTX);
    expect(await previews.request("alice", seg("c/x/이름 --outdir evil.pptx"))).toMatchObject({ status: "ready" });
    const [call] = fake.calls;
    expect(call.ext).toBe("pptx");
    expect(path.basename(call.sourcePath)).toBe("document.pptx");
    // Noah's own folder (cleared at boot with the cache), never a path in the workspace.
    expect(call.sourcePath.startsWith(path.join(cfg.dataDir, "workspace-previews", ".work"))).toBe(true);
    expect(call.sourcePath.startsWith(cfg.pi!.workspacesDir!)).toBe(false);
    expect(call.bytes.equals(PPTX)).toBe(true);
    expect(fs.existsSync(path.dirname(call.sourcePath))).toBe(false);
    expect(fs.readFileSync(source).equals(PPTX)).toBe(true); // the workspace file is untouched
  });

  it("refuses what is not a document, is too large, or does not hold what its name says", async () => {
    const cfg = config();
    const fake = fakeRenderer();
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render });
    put(cfg, "alice", "a.txt", "text");
    put(cfg, "alice", "fake.pdf", "<html>not a pdf</html>");
    put(cfg, "alice", "fake.docx", "plain");
    const big = put(cfg, "alice", "big.pdf", PDF);
    fs.truncateSync(big, WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES + 1);
    const outside = path.join(dir(), "outside.pdf");
    fs.writeFileSync(outside, PDF);
    fs.symlinkSync(outside, path.join(cfg.pi!.workspacesDir!, piUserKey("alice"), "link.pdf"));

    expect(await previews.request("alice", seg("a.txt"))).toBe("not_document");
    expect(await previews.request("alice", seg("missing.pdf"))).toBe("not_found");
    expect(await previews.request("alice", seg("link.pdf"))).toBe("not_found");
    expect(await previews.request("alice", seg("fake.pdf"))).toEqual({ status: "failed", reason: "BAD_FORMAT" });
    expect(await previews.request("alice", seg("fake.docx"))).toEqual({ status: "failed", reason: "BAD_FORMAT" });
    expect(await previews.request("alice", seg("big.pdf"))).toEqual({ status: "failed", reason: "TOO_LARGE" });
    expect(fake.calls).toHaveLength(0);
  });

  it("says so when this server has no converter, or cannot see the workspaces", async () => {
    const cfg = config();
    put(cfg, "alice", "a.pdf", PDF);
    const none = new WorkspaceDocumentPreviews(cfg, { available: () => false, render: fakeRenderer().render });
    expect(await none.request("alice", seg("a.pdf"))).toEqual({ status: "failed", reason: "UNAVAILABLE" });
    const local = new WorkspaceDocumentPreviews({ ...cfg, agentRuntime: "local" } as AppConfig, { available: () => true });
    expect(await local.request("alice", seg("a.pdf"))).toBe("unavailable");
  });

  it("never holds a request for a slow conversion, and converts once however often it is asked", async () => {
    const cfg = config();
    const fake = fakeRenderer();
    fake.hold();
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render, requestWaitMs: 20 });
    put(cfg, "alice", "slow.pptx", PPTX);

    expect(await previews.request("alice", seg("slow.pptx"))).toEqual({ status: "rendering" });
    expect(await previews.request("alice", seg("slow.pptx"))).toEqual({ status: "rendering" });
    expect(fake.calls).toHaveLength(1);
    fake.release();
    await expect.poll(() => previews.request("alice", seg("slow.pptx"))).toMatchObject({ status: "ready", pages: 2 });
    expect(fake.calls).toHaveLength(1);
  });

  it("runs one conversion per user and two in all; the rest wait their turn", async () => {
    const cfg = config();
    const fake = fakeRenderer();
    fake.hold();
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render, requestWaitMs: 10 });
    for (const user of ["alice", "bob", "carol"]) {
      put(cfg, user, "a.pdf", PDF);
      put(cfg, user, "b.pdf", PDF);
    }
    expect(await previews.request("alice", seg("a.pdf"))).toEqual({ status: "rendering" });
    expect(await previews.request("alice", seg("b.pdf"))).toEqual({ status: "rendering", waiting: true });
    expect(await previews.request("bob", seg("a.pdf"))).toEqual({ status: "rendering" });
    expect(await previews.request("carol", seg("a.pdf"))).toEqual({ status: "rendering", waiting: true });
    expect(fake.calls).toHaveLength(2);

    fake.release();
    await expect.poll(() => previews.request("alice", seg("a.pdf"))).toMatchObject({ status: "ready" });
    await expect.poll(() => previews.request("bob", seg("a.pdf"))).toMatchObject({ status: "ready" });
    // The slots are free again: the ones that waited start on their next ask.
    await expect.poll(() => previews.request("alice", seg("b.pdf"))).toMatchObject({ status: "ready" });
    await expect.poll(() => previews.request("carol", seg("a.pdf"))).toMatchObject({ status: "ready" });
    expect(fake.calls).toHaveLength(4);
  });

  it("remembers a failed conversion until the viewer asks again", async () => {
    const cfg = config();
    let renders = 0;
    let pages = 0;
    let now = 1_000_000;
    const previews = new WorkspaceDocumentPreviews(cfg, {
      available: () => true,
      now: () => now,
      render: async () => {
        renders += 1;
        return Array.from({ length: pages }, () => PNG);
      },
    });
    put(cfg, "alice", "broken.docx", PPTX);

    expect(await previews.request("alice", seg("broken.docx"))).toEqual({ status: "failed", reason: "RENDER_FAILED" });
    // A poll does not start the same doomed job again…
    expect(await previews.request("alice", seg("broken.docx"))).toEqual({ status: "failed", reason: "RENDER_FAILED" });
    expect(renders).toBe(1);
    // …a 새로고침 does, and so does time.
    pages = 1;
    expect(await previews.request("alice", seg("broken.docx"), { retry: true })).toMatchObject({ status: "ready", pages: 1 });
    expect(renders).toBe(2);

    pages = 0;
    put(cfg, "alice", "other.docx", PPTX);
    expect(await previews.request("alice", seg("other.docx"))).toEqual({ status: "failed", reason: "RENDER_FAILED" });
    now += 6 * 60_000;
    pages = 2;
    expect(await previews.request("alice", seg("other.docx"))).toMatchObject({ status: "ready", pages: 2 });
  });

  it("renders a rewritten file again, under a new id", async () => {
    const cfg = config();
    const fake = fakeRenderer(1);
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render });
    const target = put(cfg, "alice", "a.pdf", PDF);
    const before = (await previews.request("alice", seg("a.pdf"))) as { id: string };
    fs.writeFileSync(target, Buffer.concat([PDF, Buffer.from("% more\n")]));
    const after = (await previews.request("alice", seg("a.pdf"))) as { id: string };
    expect(after.id).not.toBe(before.id);
    expect(fake.calls).toHaveLength(2);
  });

  it("uses a deck's own renders when they are bound to these bytes, and LibreOffice when they are not", async () => {
    const cfg = config();
    const fake = fakeRenderer(1);
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render });
    const deck = put(cfg, "alice", "c/x/deck/q3.pptx", PPTX);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const slides = [
      { file: "slide-01.png", bytes: PNG, mediaType: "image/png" },
      { file: "slide-02.jpg", bytes: jpeg, mediaType: "image/jpeg" },
    ];
    const sidecar = path.join(path.dirname(deck), "q3.preview");
    fs.mkdirSync(sidecar);
    for (const slide of slides) fs.writeFileSync(path.join(sidecar, slide.file), slide.bytes);
    const manifest = (pptxSha256: string) =>
      JSON.stringify({
        format: DECK_PREVIEW_FORMAT,
        version: DECK_PREVIEW_VERSION,
        generator: "noah-pptx-converter/1.0.0",
        pptx: "q3.pptx",
        pptxSha256,
        profile: "embedded",
        createdAt: "2026-09-26T03:00:00Z",
        slideCount: slides.length,
        slides: slides.map((slide, offset) => ({
          index: offset + 1,
          file: slide.file,
          mediaType: slide.mediaType,
          sha256: sha256(slide.bytes),
          width: 1920,
          height: 1080,
        })),
      });
    fs.writeFileSync(path.join(sidecar, "manifest.json"), manifest(sha256(PPTX)));

    const exact = (await previews.request("alice", seg("c/x/deck/q3.pptx"))) as { status: string; id: string; pages: number };
    expect(exact).toMatchObject({ status: "ready", pages: 2 });
    expect(fake.calls).toHaveLength(0); // no LibreOffice
    expect(previews.page("alice", exact.id, "2")!.mediaType).toBe("image/jpeg");
    expect(fs.readFileSync(previews.page("alice", exact.id, "2")!.path).equals(jpeg)).toBe(true);

    // The deck was edited after the build: its old renders must not stand in for it.
    fs.writeFileSync(deck, Buffer.concat([PPTX, Buffer.from("edited")]));
    expect(await previews.request("alice", seg("c/x/deck/q3.pptx"))).toMatchObject({ status: "ready", pages: 1 });
    expect(fake.calls).toHaveLength(1);
  });

  it("drops entries that are old or past the per-user cap, and everything of a deleted user", async () => {
    const cfg = config();
    let now = 10_000_000;
    const fake = fakeRenderer(1);
    const previews = new WorkspaceDocumentPreviews(cfg, { available: () => true, render: fake.render, now: () => now });
    put(cfg, "alice", "old.pdf", PDF);
    const old = (await previews.request("alice", seg("old.pdf"))) as { id: string };
    const userDir = path.join(cfg.dataDir, "workspace-previews", piUserKey("alice"));
    expect(fs.readdirSync(userDir)).toEqual([old.id]);
    // Age the entry on disk past the TTL, then let a later request sweep.
    const past = new Date(Date.now() - 7 * 60 * 60_000);
    fs.utimesSync(path.join(userDir, old.id), past, past);
    now = Date.now() + 11 * 60_000;
    put(cfg, "alice", "new.pdf", Buffer.concat([PDF, Buffer.from("%2\n")]));
    const fresh = (await previews.request("alice", seg("new.pdf"))) as { id: string };
    expect(fs.readdirSync(userDir)).toEqual([fresh.id]);
    expect(previews.page("alice", old.id, "1")).toBeNull();

    deleteWorkspacePreviewsForUser(cfg, "alice");
    expect(fs.existsSync(userDir)).toBe(false);
    expect(previews.page("alice", fresh.id, "1")).toBeNull();
  });

  it("starts with an empty cache", async () => {
    const cfg = config();
    const stale = path.join(cfg.dataDir, "workspace-previews", "u-old", "x");
    fs.mkdirSync(stale, { recursive: true });
    new WorkspaceDocumentPreviews(cfg, { available: () => true });
    expect(fs.existsSync(path.join(cfg.dataDir, "workspace-previews"))).toBe(false);
  });
});
