import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, MessageAttachment } from "../src/server/types.js";
import {
  chatFilesDir,
  deleteChatFileAttachments,
  deleteConversationFiles,
  publishBrowserScreenshot,
  publishWorkspaceFile,
  resolveStoredFile,
  sanitizeDownloadName,
  saveBrowserCapture,
  withDownloadExtension,
  MAX_CHAT_FILE_BYTES,
  MAX_DOWNLOAD_NAME_LENGTH,
  MAX_SAVED_CAPTURES_PER_TURN,
  MAX_SHARED_SCREENSHOTS_PER_MESSAGE,
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

    it("forces the real extension INSIDE the name cap, so no later cut can remove it", () => {
      const ws = workspace();
      fs.writeFileSync(path.join(ws, "deck.pptx"), PPTX_BYTES);
      const nameFor = (requested: string) => {
        const result = publishWorkspaceFile(config(), "conv-names", "deck.pptx", [ws], requested);
        if (!("attachment" in result)) throw new Error(`publish failed: ${result.error}`);
        return result.attachment.name!;
      };
      // share_file's schema allows 200 characters, so "<196>.jar" used to become a
      // 205-char "<196>.jar.pptx" card that a 200-char re-sanitize cut back to ".jar".
      for (const ext of ["jar", "pptm", "html"]) {
        const requested = `Q3_report_${"x".repeat(189 - ext.length)}.${ext}`;
        expect(requested).toHaveLength(MAX_DOWNLOAD_NAME_LENGTH);
        const name = nameFor(requested);
        expect(name).toHaveLength(MAX_DOWNLOAD_NAME_LENGTH);
        expect(name).toMatch(/^Q3_report_x+\.pptx$/);
        expect(sanitizeDownloadName(name)).toBe(name);
      }
      // A 196-char stem used to end ".ppt" after the cut.
      expect(nameFor(`Q3_report_${"x".repeat(186)}`)).toBe(`Q3_report_${"x".repeat(185)}.pptx`);
      // A bidi override never reaches the card label.
      expect(nameFor(`invoice_${"x".repeat(183)}‮xtpp.jar`)).toBe(`invoice_${"x".repeat(183)}xtpp.pptx`);
      // Short names keep what they asked for, extension appended.
      expect(nameFor("Q3 review.jar")).toBe("Q3 review.jar.pptx");
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

  describe("saveBrowserCapture", () => {
    const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 1)]);
    const PNG_BYTES = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16, 1),
    ]);
    // 09:10:05 UTC is 18:10:05 KST; 20:00 UTC is already the next KST day.
    const AFTERNOON = Date.parse("2026-09-30T09:10:05.000Z");
    const LATE_NIGHT = Date.parse("2026-09-30T20:00:00.000Z");

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("saves the bytes under captures/ named by the KST clock, a random suffix and the sniffed type", () => {
      const ws = workspace("ws-cap");
      const jpeg = saveBrowserCapture(ws, JPEG_BYTES, AFTERNOON);
      expect("path" in jpeg).toBe(true);
      if (!("path" in jpeg)) return;
      expect(path.isAbsolute(jpeg.path)).toBe(true);
      expect(path.dirname(jpeg.path)).toBe(path.join(ws, "captures"));
      expect(path.basename(jpeg.path)).toMatch(/^20260930-181005-[0-9a-f]{6}\.jpg$/);
      expect(fs.readFileSync(jpeg.path).equals(JPEG_BYTES)).toBe(true);

      // The extension follows the BYTES, never a claimed type.
      const png = saveBrowserCapture(ws, PNG_BYTES, LATE_NIGHT);
      expect("path" in png && path.basename(png.path)).toMatch(/^20261001-050000-[0-9a-f]{6}\.png$/);
    });

    it("never overwrites an existing capture: a taken name draws a fresh suffix", () => {
      const ws = workspace("ws-cap-taken");
      fs.mkdirSync(path.join(ws, "captures"));
      const taken = path.join(ws, "captures", "20260930-181005-aaaaaa.jpg");
      fs.writeFileSync(taken, "earlier capture");
      vi.spyOn(crypto, "randomBytes")
        .mockReturnValueOnce(Buffer.from("aaaaaa", "hex") as never)
        .mockReturnValueOnce(Buffer.from("bbbbbb", "hex") as never);

      const result = saveBrowserCapture(ws, JPEG_BYTES, AFTERNOON);
      expect(result).toEqual({ path: path.join(ws, "captures", "20260930-181005-bbbbbb.jpg") });
      expect(fs.readFileSync(taken, "utf8")).toBe("earlier capture");
    });

    it("refuses empty, oversized, and non-image bytes without creating the folder", () => {
      const ws = workspace("ws-cap-bad");
      expect(saveBrowserCapture(ws, Buffer.alloc(0))).toEqual({ error: "EMPTY" });
      expect(saveBrowserCapture(ws, Buffer.alloc(MAX_CHAT_FILE_BYTES + 1, 1))).toEqual({ error: "TOO_LARGE" });
      expect(saveBrowserCapture(ws, Buffer.from("<html>not an image</html>"))).toEqual({ error: "UNSUPPORTED" });
      expect(fs.existsSync(path.join(ws, "captures"))).toBe(false);
    });

    it("never writes through a captures/ the agent replaced with a link or a file", () => {
      // The workspace is agent-writable, so the server must not follow what it
      // finds there: a symlinked folder would redirect the write anywhere.
      const outside = workspace("outside-target");
      const linked = workspace("ws-cap-link");
      fs.symlinkSync(outside, path.join(linked, "captures"));
      expect(saveBrowserCapture(linked, JPEG_BYTES)).toEqual({ error: "WRITE_FAILED" });
      expect(fs.readdirSync(outside)).toEqual([]);

      const blocked = workspace("ws-cap-file");
      fs.writeFileSync(path.join(blocked, "captures"), "not a folder");
      expect(saveBrowserCapture(blocked, JPEG_BYTES)).toEqual({ error: "WRITE_FAILED" });
      expect(fs.readFileSync(path.join(blocked, "captures"), "utf8")).toBe("not a folder");
    });

    it("recreates a workspace the agent deleted, like a fresh folder", () => {
      const ws = path.join(dir(), "ws-cap-missing");
      const result = saveBrowserCapture(ws, PNG_BYTES);
      expect("path" in result && fs.readFileSync(result.path).equals(PNG_BYTES)).toBe(true);
    });

    it("removes a capture that landed outside captures/ after a link was swapped in mid-save", () => {
      const ws = workspace("ws-cap-race");
      const outside = workspace("outside-race");
      const realWrite = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file, data, options) => {
        // The folder was real when checked; the agent swaps it for a link before the write.
        fs.renameSync(path.join(ws, "captures"), path.join(ws, "captures-moved"));
        fs.symlinkSync(outside, path.join(ws, "captures"));
        realWrite(file, data, options);
      });

      expect(saveBrowserCapture(ws, JPEG_BYTES)).toEqual({ error: "WRITE_FAILED" });
      // What the write put through the link is gone again.
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("removes its partial file when the write fails part-way", () => {
      const ws = workspace("ws-cap-partial");
      const realWrite = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file, _data, options) => {
        realWrite(file, JPEG_BYTES.subarray(0, 4), options);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      });

      expect(saveBrowserCapture(ws, JPEG_BYTES)).toEqual({ error: "WRITE_FAILED" });
      expect(fs.readdirSync(path.join(ws, "captures"))).toEqual([]);
    });

    it("keeps its own per-run cap above the share cap", () => {
      expect(MAX_SAVED_CAPTURES_PER_TURN).toBe(30);
      expect(MAX_SAVED_CAPTURES_PER_TURN).toBeGreaterThan(MAX_SHARED_SCREENSHOTS_PER_MESSAGE);
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

    it("strips bidi and other format controls, C1 controls, line separators and lone surrogates", () => {
      // U+202E would make "invoice\u202etpp.jar" DISPLAY as "invoiceraj.ppt\u2026".
      expect(sanitizeDownloadName("invoice\u202etpp.jar.pptx")).toBe("invoicetpp.jar.pptx");
      for (const control of ["\u200e", "\u200f", "\u202a", "\u202d", "\u2066", "\u2069", "\u200b", "\ufeff", "\u0085", "\u2028", "\u2029"]) {
        expect(sanitizeDownloadName(`\ubcf4\uace0${control}\uc11c.pptx`)).toBe("\ubcf4\uace0\uc11c.pptx");
      }
      expect(sanitizeDownloadName("deck\ud83d.pptx")).toBe("deck.pptx");
      expect(sanitizeDownloadName("\u202e")).toBeNull();
      // The joiners stay: they shape Persian/Indic names and emoji sequences, and cannot move an extension.
      expect(sanitizeDownloadName("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.pptx")).toBe("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.pptx");
      expect(sanitizeDownloadName("\ud83d\udc69\u200d\ud83d\udcbb \ud300.pptx")).toBe("\ud83d\udc69\u200d\ud83d\udcbb \ud300.pptx");
    });

    it("shortens an overlong name in its stem, keeping the last extension and whole surrogate pairs", () => {
      // What share_file stored for a 200-char "\u2026.jar" before its own cap: the
      // old 200-char cut dropped exactly the forced ".pptx" and exposed ".jar".
      expect(sanitizeDownloadName(`${"x".repeat(196)}.jar.pptx`)).toBe(`${"x".repeat(195)}.pptx`);
      expect(sanitizeDownloadName("x".repeat(250))).toBe("x".repeat(200));
      // An emoji straddling the cut is dropped whole \u2014 half a pair would make
      // the download's encodeURIComponent throw.
      expect(sanitizeDownloadName(`${"\uac00".repeat(199)}\ud83d\ude00`)).toBe("\uac00".repeat(199));
      expect(sanitizeDownloadName(`${"\uac00".repeat(194)}\ud83d\ude00.pptx`)).toBe(`${"\uac00".repeat(194)}.pptx`);
      // Idempotent: re-sanitizing a stored name changes nothing.
      for (const raw of [`${"x".repeat(196)}.jar.pptx`, "x".repeat(250), `${"\uac00".repeat(199)}\ud83d\ude00`, "\uc8fc\uac04 \ubcf4\uace0.pptx"]) {
        const once = sanitizeDownloadName(raw)!;
        expect(once.length).toBeLessThanOrEqual(MAX_DOWNLOAD_NAME_LENGTH);
        expect(sanitizeDownloadName(once)).toBe(once);
        expect(() => encodeURIComponent(once)).not.toThrow();
      }
    });
  });

  describe("withDownloadExtension", () => {
    it("always ends in the served extension within the cap, shortening the stem to fit", () => {
      expect(withDownloadExtension("\uc8fc\uac04 \ubcf4\uace0.pptx", "pptx")).toBe("\uc8fc\uac04 \ubcf4\uace0.pptx");
      expect(withDownloadExtension("Report.PPTX", "pptx")).toBe("Report.PPTX");
      expect(withDownloadExtension("evil.jar", "pptx")).toBe("evil.jar.pptx");
      // A 200-char name ending ".jar" loses stem characters \u2014 and its ".jar" \u2014 never the extension.
      const long = `Q3_report_${"x".repeat(186)}.jar`;
      expect(withDownloadExtension(long, "pptx")).toBe(`Q3_report_${"x".repeat(185)}.pptx`);
      expect(withDownloadExtension(`${"x".repeat(196)}.jar.pptx`, "pptx")).toBe(`${"x".repeat(195)}.pptx`);
      expect(withDownloadExtension("   ", "pdf")).toBe("file.pdf");
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
