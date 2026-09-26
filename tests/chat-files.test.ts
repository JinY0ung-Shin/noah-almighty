import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig, MessageAttachment } from "../src/server/types.js";
import {
  chatFilesDir,
  deleteChatFileAttachments,
  deleteConversationFiles,
  publishBrowserScreenshot,
  publishWorkspaceFile,
  resolveStoredFile,
  sanitizeDownloadName,
  MAX_CHAT_FILE_BYTES,
} from "../src/server/chatFiles.js";
import { resolveStoredImage } from "../src/server/chatImages.js";
import { withTempDir } from "./helpers.js";

// Minimal OOXML-ish container: the zip local-file-header magic + padding.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PPTX_BYTES = Buffer.concat([ZIP_MAGIC, Buffer.alloc(64, 1)]);

describe("chatFiles", () => {
  const dir = withTempDir("chat-files");
  const config = () => ({ dataDir: dir() }) as AppConfig;
  const workspace = (name = "ws") => {
    const p = path.join(dir(), name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  describe("publishWorkspaceFile", () => {
    it("copies a workspace pptx into the conversation store with download metadata", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);

      const result = publishWorkspaceFile(config(), "conv1", "deck.pptx", [ws]);
      expect("attachment" in result).toBe(true);
      if (!("attachment" in result)) return;
      expect(result.attachment).toMatchObject({
        kind: "file",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        name: "deck.pptx",
        size: PPTX_BYTES.length,
      });

      const resolved = resolveStoredFile(config(), "conv1", result.attachment.id);
      expect(resolved).not.toBeNull();
      expect(resolved!.mediaType).toContain("presentationml");
      expect(fs.readFileSync(resolved!.path).equals(PPTX_BYTES)).toBe(true);
    });

    it("returns the realpath it read and the SHA-256 of the stored bytes", () => {
      const ws = workspace();
      fs.mkdirSync(path.join(ws, "q3-review"));
      fs.writeFileSync(path.join(ws, "q3-review", "q3-review.pptx"), PPTX_BYTES);
      // Shared through a symlink: the source is the REAL file (the deck-preview
      // sidecar lives next to it), never the link.
      fs.symlinkSync(path.join(ws, "q3-review", "q3-review.pptx"), path.join(ws, "final.pptx"));

      for (const input of ["q3-review/q3-review.pptx", "final.pptx", path.join(ws, "final.pptx")]) {
        const result = publishWorkspaceFile(config(), "conv-sha", input, [ws]);
        expect("attachment" in result).toBe(true);
        if (!("attachment" in result)) return;
        expect(result.sourcePath).toBe(fs.realpathSync(path.join(ws, "q3-review", "q3-review.pptx")));
        const stored = resolveStoredFile(config(), "conv-sha", result.attachment.id)!;
        const storedSha = crypto.createHash("sha256").update(fs.readFileSync(stored.path)).digest("hex");
        expect(result.sha256).toBe(storedSha);
        expect(result.sha256).toBe(crypto.createHash("sha256").update(PPTX_BYTES).digest("hex"));
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("honors a requested download name and keeps the real extension", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      const result = publishWorkspaceFile(config(), "conv1", "deck.pptx", [ws], "주간 보고");
      expect("attachment" in result && result.attachment.name).toBe("주간 보고.pptx");
    });

    it("rejects extensions outside the allowlist", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "tool.exe"), ZIP_MAGIC);
      expect(publishWorkspaceFile(config(), "conv1", "tool.exe", [ws])).toEqual({ error: "UNSUPPORTED" });
    });

    it("rejects a container format whose bytes don't match the extension", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "fake.pptx"), Buffer.from("just text"));
      expect(publishWorkspaceFile(config(), "conv1", "fake.pptx", [ws])).toEqual({ error: "UNSUPPORTED" });
    });

    it("accepts plain-text formats without a magic check", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "notes.md"), "# 회의록");
      const result = publishWorkspaceFile(config(), "conv1", "notes.md", [ws]);
      expect("attachment" in result && result.attachment.mediaType).toBe("text/markdown");
    });

    it("publishes a .drawio diagram with the mxfile media type", () => {
      const ws = workspace();
      const xml = `<mxfile host="test"><diagram id="d1" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>`;
      fs.writeFileSync(path.join(ws, "flow.drawio"), xml);
      const result = publishWorkspaceFile(config(), "conv1", "flow.drawio", [ws]);
      expect("attachment" in result).toBe(true);
      if (!("attachment" in result)) return;
      expect(result.attachment).toMatchObject({
        kind: "file",
        mediaType: "application/vnd.jgraph.mxfile",
        name: "flow.drawio",
      });
    });

    it("refuses paths that escape the allowed roots", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(dir(), "outside.pptx"), PPTX_BYTES);
      expect(publishWorkspaceFile(config(), "conv1", "../outside.pptx", [ws])).toEqual({
        error: "OUTSIDE_WORKSPACE",
      });
      expect(publishWorkspaceFile(config(), "conv1", "deck.pptx", [])).toEqual({ error: "OUTSIDE_WORKSPACE" });
    });

    it("maps missing/empty/oversized files to their errors", () => {
      const ws = workspace();
      expect(publishWorkspaceFile(config(), "conv1", "ghost.pptx", [ws])).toEqual({ error: "NOT_FOUND" });

      fs.writeFileSync(path.join(ws, "empty.pdf"), "");
      expect(publishWorkspaceFile(config(), "conv1", "empty.pdf", [ws])).toEqual({ error: "EMPTY" });

      fs.writeFileSync(
        path.join(ws, "big.pdf"),
        Buffer.concat([Buffer.from("%PDF"), Buffer.alloc(MAX_CHAT_FILE_BYTES, 0)]),
      );
      expect(publishWorkspaceFile(config(), "conv1", "big.pdf", [ws])).toEqual({ error: "TOO_LARGE" });
    });
  });

  describe("publishBrowserScreenshot", () => {
    const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 1)]);
    const PNG_BYTES = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 1),
    ]);

    it("stores the capture as a download card plus a hidden preview slide linked to it", () => {
      const result = publishBrowserScreenshot(config(), "conv-shot", JPEG_BYTES, "사내 포털 대시보드");
      expect("file" in result).toBe(true);
      if (!("file" in result)) return;
      expect(result.file).toMatchObject({
        kind: "file",
        mediaType: "image/jpeg",
        name: "스크린샷 - 사내 포털 대시보드.jpg",
        size: JPEG_BYTES.length,
      });
      expect(result.slide).toMatchObject({
        kind: "image",
        mediaType: "image/jpeg",
        hidden: true,
        parentId: result.file.id,
      });

      // Download route serves the card; image route serves the panel slide.
      const storedFile = resolveStoredFile(config(), "conv-shot", result.file.id);
      expect(storedFile?.mediaType).toBe("image/jpeg");
      expect(fs.readFileSync(storedFile!.path).equals(JPEG_BYTES)).toBe(true);
      expect(resolveStoredImage(config(), "conv-shot", result.slide.id)).not.toBeNull();
    });

    it("derives extension and media type from the bytes, and sanitizes the page title", () => {
      const png = publishBrowserScreenshot(config(), "conv-shot2", PNG_BYTES);
      expect("file" in png && png.file.name).toBe("스크린샷.png");
      const titled = publishBrowserScreenshot(config(), "conv-shot2", JPEG_BYTES, "a/b:c");
      expect("file" in titled && titled.file.name).toBe("스크린샷 - a b c.jpg");
    });

    it("refuses empty, oversized, and non-image bytes", () => {
      expect(publishBrowserScreenshot(config(), "conv-shot3", Buffer.alloc(0))).toEqual({
        error: "EMPTY",
      });
      expect(
        publishBrowserScreenshot(config(), "conv-shot3", Buffer.alloc(MAX_CHAT_FILE_BYTES + 1, 1)),
      ).toEqual({ error: "TOO_LARGE" });
      expect(
        publishBrowserScreenshot(config(), "conv-shot3", Buffer.from("<html>not an image</html>")),
      ).toEqual({ error: "UNSUPPORTED" });
    });

    it("sweeps with deleteChatFileAttachments like any download card", () => {
      const result = publishBrowserScreenshot(config(), "conv-shot4", JPEG_BYTES);
      if (!("file" in result)) throw new Error("publish failed");
      deleteChatFileAttachments(config(), "conv-shot4", [result.file]);
      expect(resolveStoredFile(config(), "conv-shot4", result.file.id)).toBeNull();
    });
  });

  describe("resolveStoredFile", () => {
    it("rejects unsafe ids and unknown extensions", () => {
      const stored = chatFilesDir(config(), "conv2");
      fs.mkdirSync(stored, { recursive: true });
      fs.writeFileSync(path.join(stored, "abc.pptx"), PPTX_BYTES);
      fs.writeFileSync(path.join(stored, "odd.exe"), ZIP_MAGIC);

      expect(resolveStoredFile(config(), "conv2", "../abc")).toBeNull();
      expect(resolveStoredFile(config(), "conv2", "odd")).toBeNull();
      expect(resolveStoredFile(config(), "conv2", "abc")).not.toBeNull();
    });
  });

  describe("sweeps", () => {
    it("deleteChatFileAttachments removes only kind:'file' entries", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      const published = publishWorkspaceFile(config(), "conv3", "deck.pptx", [ws]);
      if (!("attachment" in published)) throw new Error("publish failed");
      const attachments: MessageAttachment[] = [
        published.attachment,
        { id: "img-1", kind: "image", mediaType: "image/png" },
      ];

      deleteChatFileAttachments(config(), "conv3", attachments);
      expect(resolveStoredFile(config(), "conv3", published.attachment.id)).toBeNull();
    });

    it("deleteConversationFiles removes the whole directory", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      publishWorkspaceFile(config(), "conv4", "deck.pptx", [ws]);
      expect(fs.existsSync(chatFilesDir(config(), "conv4"))).toBe(true);
      deleteConversationFiles(config(), "conv4");
      expect(fs.existsSync(chatFilesDir(config(), "conv4"))).toBe(false);
    });
  });

  describe("sanitizeDownloadName", () => {
    it("strips separators, control chars, and leading dots but keeps Hangul", () => {
      expect(sanitizeDownloadName("weekly/report.pptx")).toBe("weekly report.pptx");
      expect(sanitizeDownloadName("\uc8fc\uac04\u0000\ubcf4\uace0.pptx")).toBe("\uc8fc\uac04\ubcf4\uace0.pptx");
      expect(sanitizeDownloadName(".hidden")).toBe("hidden");
      expect(sanitizeDownloadName("///")).toBeNull();
      expect(sanitizeDownloadName("  ")).toBeNull();
      expect(sanitizeDownloadName(undefined)).toBeNull();
      // No separator survives, whatever the input shape.
      expect(sanitizeDownloadName("..\\..\\evil.txt")).not.toMatch(/[\\/]/);
    });
  });
});

// ---- server-side auto preview helpers (deckRender.ts) ----
import {
  isPreviewableExtension,
  sortSlideFiles,
  MAX_PREVIEW_PAGES,
} from "../src/server/deckRender.js";

describe("deck preview helpers", () => {
  it("classifies previewable document extensions", () => {
    expect(isPreviewableExtension("pptx")).toBe(true);
    expect(isPreviewableExtension("PDF")).toBe(true);
    expect(isPreviewableExtension("docx")).toBe(true);
    expect(isPreviewableExtension("zip")).toBe(false);
    expect(isPreviewableExtension("md")).toBe(false);
  });

  it("sorts pdftoppm outputs numerically across padded and unpadded names", () => {
    expect(sortSlideFiles(["slide-10.png", "slide-2.png", "slide-1.png"])).toEqual([
      "slide-1.png",
      "slide-2.png",
      "slide-10.png",
    ]);
    expect(sortSlideFiles(["slide-02.png", "slide-01.png", "slide-10.png"])).toEqual([
      "slide-01.png",
      "slide-02.png",
      "slide-10.png",
    ]);
    expect(MAX_PREVIEW_PAGES).toBeGreaterThan(0);
  });
});
