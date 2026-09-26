import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/types.js";
import {
  decodeChatImages,
  saveChatImages,
  readChatImages,
  resolveStoredImage,
  deleteConversationImages,
  chatImagesDir,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  publishWorkspaceImage,
  deleteChatImageAttachments,
} from "../src/server/chatImages.js";
import { withTempDir } from "./helpers.js";

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG_B64}`;

describe("chatImages", () => {
  const dir = withTempDir("chat-images");
  const config = () => ({ dataDir: dir() }) as AppConfig;

  describe("decodeChatImages", () => {
    it("treats absent/empty input as no images", () => {
      expect(decodeChatImages(undefined)).toEqual({ images: [] });
      expect(decodeChatImages([])).toEqual({ images: [] });
    });

    it("rejects a non-array payload", () => {
      expect(decodeChatImages("nope")).toEqual({ error: "BAD_FORMAT" });
    });

    it("rejects more than the per-message cap", () => {
      const many = Array.from({ length: MAX_CHAT_IMAGES_PER_MESSAGE + 1 }, () => PNG_URL);
      expect(decodeChatImages(many)).toEqual({ error: "TOO_MANY" });
    });

    it("rejects a non-image / malformed data URL", () => {
      expect(decodeChatImages(["data:text/plain;base64,aGk="])).toEqual({ error: "BAD_FORMAT" });
      expect(decodeChatImages(["not-a-data-url"])).toEqual({ error: "BAD_FORMAT" });
    });

    it("rejects an oversized image", () => {
      const big = Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64");
      expect(decodeChatImages([`data:image/png;base64,${big}`])).toEqual({ error: "TOO_LARGE" });
    });

    it("decodes a valid image and keeps a safe client id", () => {
      const result = decodeChatImages([{ id: "abc-123", name: "shot.png", data: PNG_URL }]);
      expect("images" in result).toBe(true);
      if (!("images" in result)) return;
      expect(result.images).toHaveLength(1);
      expect(result.images[0]).toMatchObject({ id: "abc-123", mediaType: "image/png", ext: "png", name: "shot.png" });
      expect(result.images[0].buffer.length).toBeGreaterThan(0);
    });

    it("replaces an unsafe id with a generated one", () => {
      const result = decodeChatImages([{ id: "../../etc/passwd", data: PNG_URL }]);
      if (!("images" in result)) throw new Error("expected images");
      expect(result.images[0].id).not.toContain("/");
      expect(result.images[0].id.length).toBeGreaterThan(0);
    });
  });

  it("saves images to disk and resolves them back by id", () => {
    const decoded = decodeChatImages([{ id: "img-1", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments, images } = saveChatImages(config(), "conv-1", decoded.images);
    expect(attachments).toEqual([{ id: "img-1", kind: "image", mediaType: "image/png", name: undefined }]);
    expect(images[0]).toEqual({ mediaType: "image/png", data: PNG_B64 });
    // File landed under the conversation's image dir.
    expect(fs.existsSync(path.join(chatImagesDir(config(), "conv-1"), "img-1.png"))).toBe(true);

    const resolved = resolveStoredImage(config(), "conv-1", "img-1");
    expect(resolved?.mediaType).toBe("image/png");
    expect(resolved && fs.existsSync(resolved.path)).toBe(true);
  });

  it("keeps unsafe conversation ids inside the chat-images root", () => {
    const decoded = decodeChatImages([{ id: "img-unsafe", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "../../outside", decoded.images);
    expect(attachments[0].id).toBe("img-unsafe");

    const root = path.join(config().dataDir, "chat-images");
    const resolved = resolveStoredImage(config(), "../../outside", "img-unsafe");
    expect(resolved).toBeTruthy();
    expect(resolved!.path.startsWith(root + path.sep)).toBe(true);
    expect(resolved!.path).not.toContain(`..${path.sep}`);
    expect(fs.existsSync(path.join(config().dataDir, "outside", "img-unsafe.png"))).toBe(false);
  });

  it("rejects a traversal id at resolve time", () => {
    expect(resolveStoredImage(config(), "conv-1", "../../secret")).toBeNull();
    expect(resolveStoredImage(config(), "conv-1", "missing")).toBeNull();
  });

  it("reads stored attachments back into model image blocks", () => {
    const decoded = decodeChatImages([{ id: "img-2", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-2", decoded.images);
    const blocks = readChatImages(config(), "conv-2", attachments);
    expect(blocks).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
    // A missing attachment is skipped, not fatal.
    expect(readChatImages(config(), "conv-2", [{ id: "ghost", kind: "image", mediaType: "image/png" }])).toEqual([]);
  });

  it("reads multiple attachments back as blocks in attachment order", () => {
    const decoded = decodeChatImages([
      { id: "img-a", data: PNG_URL },
      { id: "img-b", data: PNG_URL },
      { id: "img-c", data: PNG_URL },
    ]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-multi", decoded.images);
    expect(attachments.map((a) => a.id)).toEqual(["img-a", "img-b", "img-c"]);

    // Feed the attachments back in a NON-storage order; output must follow the
    // attachment-list order, not the directory listing order.
    const reordered = [attachments[2], attachments[0], attachments[1]];
    const blocks = readChatImages(config(), "conv-multi", reordered);
    expect(blocks).toHaveLength(3);
    expect(blocks).toEqual([
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
    ]);
  });

  it("returns [] when the conversation image directory does not exist", () => {
    expect(fs.existsSync(chatImagesDir(config(), "conv-never"))).toBe(false);
    const blocks = readChatImages(config(), "conv-never", [
      { id: "img-x", kind: "image", mediaType: "image/png" },
    ]);
    expect(blocks).toEqual([]);
  });

  it("skips attachments with no file on disk while returning the rest", () => {
    const decoded = decodeChatImages([
      { id: "img-present-1", data: PNG_URL },
      { id: "img-present-2", data: PNG_URL },
    ]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-gap", decoded.images);

    const blocks = readChatImages(config(), "conv-gap", [
      attachments[0],
      { id: "img-missing", kind: "image", mediaType: "image/png" },
      attachments[1],
    ]);
    // Only the two stored attachments come back; the gap is silently dropped.
    expect(blocks).toEqual([
      { mediaType: "image/png", data: PNG_B64 },
      { mediaType: "image/png", data: PNG_B64 },
    ]);
  });

  it("skips an attachment whose stored file has a disallowed extension", () => {
    const decoded = decodeChatImages([{ id: "img-ok", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-ext", decoded.images);

    // Drop a file with an id that isn't backed by an EXT_MIME-known extension.
    const dir = chatImagesDir(config(), "conv-ext");
    fs.writeFileSync(path.join(dir, "img-bad.bmp"), Buffer.from(PNG_B64, "base64"));

    const blocks = readChatImages(config(), "conv-ext", [
      attachments[0],
      { id: "img-bad", kind: "image", mediaType: "image/png" },
    ]);
    // The .bmp file is not in EXT_MIME, so only the valid png returns.
    expect(blocks).toEqual([{ mediaType: "image/png", data: PNG_B64 }]);
  });

  it("matches the bytes that resolveStoredImage points to (single-readdir equivalence)", () => {
    const decoded = decodeChatImages([{ id: "img-eq", data: PNG_URL }]);
    if (!("images" in decoded)) throw new Error("expected images");
    const { attachments } = saveChatImages(config(), "conv-eq", decoded.images);

    const blocks = readChatImages(config(), "conv-eq", attachments);
    expect(blocks).toHaveLength(1);

    const resolved = resolveStoredImage(config(), "conv-eq", "img-eq");
    expect(resolved).toBeTruthy();
    const onDisk = fs.readFileSync(resolved!.path).toString("base64");
    // The block's base64 + media type equal a direct read of the resolved path.
    expect(blocks[0].data).toBe(onDisk);
    expect(blocks[0].mediaType).toBe(resolved!.mediaType);
  });

  it("deletes a conversation's image directory", () => {
    const decoded = decodeChatImages([PNG_URL]);
    if (!("images" in decoded)) throw new Error("expected images");
    saveChatImages(config(), "conv-3", decoded.images);
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(true);
    deleteConversationImages(config(), "conv-3");
    expect(fs.existsSync(chatImagesDir(config(), "conv-3"))).toBe(false);
  });

  it("publishes a workspace PNG with byte-sniffed metadata and removes it individually", () => {
    const workspace = path.join(dir(), "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "result.bin"), Buffer.from(PNG_B64, "base64"));

    const result = publishWorkspaceImage(config(), "conv-output", "result.bin", [workspace], "결과 이미지");
    expect("attachment" in result).toBe(true);
    if (!("attachment" in result)) return;
    expect(result.attachment).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      name: "result.bin",
      caption: "결과 이미지",
    });
    expect(resolveStoredImage(config(), "conv-output", result.attachment.id)).toBeTruthy();

    deleteChatImageAttachments(config(), "conv-output", [result.attachment]);
    expect(resolveStoredImage(config(), "conv-output", result.attachment.id)).toBeNull();
  });

  it("rejects workspace escapes, unsupported bytes, and oversized files", () => {
    const workspace = path.join(dir(), "safe-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(dir(), "outside.png"), Buffer.from(PNG_B64, "base64"));
    fs.writeFileSync(path.join(workspace, "text.png"), "not an image");
    fs.writeFileSync(path.join(workspace, "huge.png"), Buffer.alloc(5 * 1024 * 1024 + 1));

    expect(publishWorkspaceImage(config(), "conv-safe", "../outside.png", [workspace])).toEqual({ error: "OUTSIDE_WORKSPACE" });
    expect(publishWorkspaceImage(config(), "conv-safe", "text.png", [workspace])).toEqual({ error: "UNSUPPORTED" });
    expect(publishWorkspaceImage(config(), "conv-safe", "huge.png", [workspace])).toEqual({ error: "TOO_LARGE" });
  });
});

// ---- async workspace reads (share_file's deck-preview loader) ----
import { execFileSync } from "node:child_process";
import {
  MAX_CHAT_IMAGE_BYTES,
  readRegularFileAsync,
  readWorkspaceImage,
  readWorkspaceImageAsync,
} from "../src/server/chatImages.js";

describe("readWorkspaceImageAsync", () => {
  let root: string;
  const getTempDir = withTempDir("chat-images-async", () => {
    root = getTempDir();
  });
  const png = () => Buffer.from(PNG_B64, "base64");

  /** Both readers on the same input; the async one must agree with the sync one exactly. */
  async function both(allowedRoots: string[], inputPath: string) {
    const sync = readWorkspaceImage(allowedRoots, inputPath);
    const async = await readWorkspaceImageAsync(allowedRoots, inputPath);
    expect(async).toEqual(sync);
    return async;
  }

  it("reads the same bytes, sniffed type and realpath as the sync reader", async () => {
    const ws = path.join(root, "ws");
    fs.mkdirSync(path.join(ws, "renders"), { recursive: true });
    fs.writeFileSync(path.join(ws, "renders", "slide.bin"), png());
    fs.symlinkSync(path.join(ws, "renders", "slide.bin"), path.join(ws, "link.png"));

    const direct = await both([ws], "renders/slide.bin");
    expect(direct).toMatchObject({ mediaType: "image/png", sourcePath: fs.realpathSync(path.join(ws, "renders", "slide.bin")) });
    expect("buffer" in direct && direct.buffer.equals(png())).toBe(true);
    // Absolute path, a symlink inside the root, and an unresolvable extra root.
    await both([path.join(root, "gone"), ws], path.join(ws, "renders", "slide.bin"));
    expect(await both([ws], "link.png")).toMatchObject({ sourcePath: fs.realpathSync(path.join(ws, "renders", "slide.bin")) });
  });

  it("agrees with the sync reader on every error code", async () => {
    const ws = path.join(root, "ws");
    fs.mkdirSync(path.join(ws, "folder.png"), { recursive: true });
    fs.writeFileSync(path.join(root, "outside.png"), png());
    fs.symlinkSync(path.join(root, "outside.png"), path.join(ws, "escape.png"));
    fs.writeFileSync(path.join(ws, "empty.png"), "");
    fs.writeFileSync(path.join(ws, "huge.png"), Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1));
    fs.writeFileSync(path.join(ws, "text.png"), "not an image");
    fs.symlinkSync(path.join(ws, "loop-b.png"), path.join(ws, "loop-a.png"));
    fs.symlinkSync(path.join(ws, "loop-a.png"), path.join(ws, "loop-b.png"));

    const cases: [string[], string, string][] = [
      [[], "anything.png", "OUTSIDE_WORKSPACE"],
      [[path.join(root, "gone")], "anything.png", "OUTSIDE_WORKSPACE"],
      [[ws], "../outside.png", "OUTSIDE_WORKSPACE"],
      [[ws], path.join(root, "outside.png"), "OUTSIDE_WORKSPACE"],
      [[ws], "escape.png", "OUTSIDE_WORKSPACE"],
      [[ws], "ghost.png", "NOT_FOUND"],
      [[ws], "folder.png", "NOT_FILE"],
      [[ws], "empty.png", "EMPTY"],
      [[ws], "huge.png", "TOO_LARGE"],
      [[ws], "text.png", "UNSUPPORTED"],
      [[ws], "loop-a.png", "READ_FAILED"],
      [[ws], "empty.png/child.png", "READ_FAILED"],
    ];
    for (const [roots, input, code] of cases) {
      expect(await both(roots, input), `${input} under ${roots.join(",")}`).toEqual({ error: code });
    }
  });

  it.runIf(process.platform === "linux")("agrees on a FIFO (NOT_FILE) without blocking on it", async () => {
    const ws = path.join(root, "ws");
    fs.mkdirSync(ws);
    execFileSync("mkfifo", [path.join(ws, "pipe.png")]);
    expect(await both([ws], "pipe.png")).toEqual({ error: "NOT_FILE" });
  });

  it.runIf(typeof process.getuid === "function" && process.getuid() !== 0)(
    "agrees on an unreadable file (READ_FAILED)",
    async () => {
      const ws = path.join(root, "ws");
      fs.mkdirSync(ws);
      const locked = path.join(ws, "locked.png");
      fs.writeFileSync(locked, png());
      fs.chmodSync(locked, 0o000);
      try {
        expect(await both([ws], "locked.png")).toEqual({ error: "READ_FAILED" });
      } finally {
        fs.chmodSync(locked, 0o600);
      }
    },
  );
});

describe("readRegularFileAsync", () => {
  let root: string;
  const getTempDir = withTempDir("chat-images-regular", () => {
    root = getTempDir();
  });

  it("returns the bytes of a regular file within the cap", async () => {
    const file = path.join(root, "manifest.json");
    fs.writeFileSync(file, '{"ok":true}');
    const read = await readRegularFileAsync(file, 64);
    expect("buffer" in read && read.buffer.toString("utf8")).toBe('{"ok":true}');
  });

  it("refuses oversized, empty, missing, directory and final-symlink paths", async () => {
    const file = path.join(root, "big.json");
    fs.writeFileSync(file, "x".repeat(65));
    expect(await readRegularFileAsync(file, 64)).toEqual({ error: "TOO_LARGE" });
    expect(await readRegularFileAsync(file, 65)).toMatchObject({ buffer: expect.any(Buffer) });

    fs.writeFileSync(path.join(root, "empty.json"), "");
    expect(await readRegularFileAsync(path.join(root, "empty.json"), 64)).toEqual({ error: "EMPTY" });
    expect(await readRegularFileAsync(path.join(root, "ghost.json"), 64)).toEqual({ error: "READ_FAILED" });
    fs.mkdirSync(path.join(root, "dir.json"));
    expect(await readRegularFileAsync(path.join(root, "dir.json"), 64)).toEqual({ error: "NOT_FILE" });
    // Callers pass a realpath: a symlink in the final component means it was
    // swapped in after their checks, so it is refused rather than followed.
    fs.symlinkSync(file, path.join(root, "swapped.json"));
    expect(await readRegularFileAsync(path.join(root, "swapped.json"), 1024)).toEqual({ error: "READ_FAILED" });
  });

  it.runIf(process.platform === "linux")("refuses a FIFO without waiting for a writer", async () => {
    const fifo = path.join(root, "manifest.json");
    execFileSync("mkfifo", [fifo]);
    expect(await readRegularFileAsync(fifo, 1024)).toEqual({ error: "NOT_FILE" });
  });

  describe("when the file changes between the descriptor stat and the read", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** Open for real, but run `mutate` right after the handle reports its size. */
    function mutateAfterStat(mutate: () => void, readFails = false) {
      const realOpen = fs.promises.open;
      vi.spyOn(fs.promises, "open").mockImplementationOnce(async (file, flags) => {
        const handle = await realOpen(file, flags);
        const realStat = handle.stat.bind(handle);
        handle.stat = (async () => {
          const stat = await realStat();
          mutate();
          return stat;
        }) as typeof handle.stat;
        if (readFails) {
          handle.read = (async () => {
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          }) as typeof handle.read;
        }
        return handle;
      });
    }

    it("never returns more than the size it checked (growth = READ_FAILED)", async () => {
      const file = path.join(root, "grow.json");
      fs.writeFileSync(file, '{"a":1}');
      mutateAfterStat(() => fs.appendFileSync(file, "x".repeat(4096)));
      expect(await readRegularFileAsync(file, 64)).toEqual({ error: "READ_FAILED" });
    });

    it("returns what is left after a shrink, and EMPTY once nothing is", async () => {
      const file = path.join(root, "shrink.json");
      fs.writeFileSync(file, "abcdef");
      mutateAfterStat(() => fs.truncateSync(file, 3));
      const read = await readRegularFileAsync(file, 64);
      expect("buffer" in read && read.buffer.toString("utf8")).toBe("abc");

      mutateAfterStat(() => fs.truncateSync(file, 0));
      expect(await readRegularFileAsync(file, 64)).toEqual({ error: "EMPTY" });
    });

    it("maps a failing read to READ_FAILED", async () => {
      const file = path.join(root, "eio.json");
      fs.writeFileSync(file, "abc");
      mutateAfterStat(() => {}, true);
      expect(await readRegularFileAsync(file, 64)).toEqual({ error: "READ_FAILED" });
    });

    it("maps a render that vanishes after its realpath to READ_FAILED", async () => {
      const file = path.join(root, "slide.png");
      fs.writeFileSync(file, Buffer.from(PNG_B64, "base64"));
      vi.spyOn(fs.promises, "stat").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
      expect(await readWorkspaceImageAsync([root], "slide.png")).toEqual({ error: "READ_FAILED" });
    });
  });
});

// ---- server-rendered preview attachments (share_file auto previews) ----
import { savePreviewImages } from "../src/server/chatImages.js";

describe("savePreviewImages", () => {
  const dir = withTempDir("chat-preview-images");
  const config = () => ({ dataDir: dir() }) as AppConfig;

  it("stores server-rendered pages as hidden PNG attachments", () => {
    const pages = [Buffer.from("png-1"), Buffer.from("png-2")];
    const attachments = savePreviewImages(config(), "conv-prev", pages);
    expect(attachments).toHaveLength(2);
    for (const [index, att] of attachments.entries()) {
      expect(att).toMatchObject({
        kind: "image",
        mediaType: "image/png",
        hidden: true,
        name: `slide-${index + 1}.png`,
      });
      const resolved = resolveStoredImage(config(), "conv-prev", att.id);
      expect(resolved).not.toBeNull();
    }
    expect(savePreviewImages(config(), "conv-prev", [])).toEqual([]);
  });
});
