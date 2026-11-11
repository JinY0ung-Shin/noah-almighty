/**
 * Chat DOCUMENT attachments, below the route: the shared client↔server contract
 * (`src/shared/chatDocuments.ts`), the intake validation and the file store
 * (`src/server/chatDocuments.ts`).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHAT_DOCUMENT_EXTENSIONS,
  CHAT_DOCUMENT_MEDIA_TYPES,
  CHAT_DOCUMENT_MESSAGES,
  MAX_CHAT_ATTACHMENTS_ENCODED_BYTES,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENTS_TOTAL_BYTES,
  MAX_CHAT_DOCUMENT_BYTES,
  base64EncodedLength,
  chatDocumentExtension,
  chatDocumentName,
  chatDocumentNameProblem,
  uniqueChatDocumentNames,
} from "../src/shared/chatDocuments.js";
import {
  chatDocumentContentMatches,
  decodeChatDocuments,
  isUploadedDocument,
  readChatDocuments,
  saveChatDocuments,
} from "../src/server/chatDocuments.js";
import { chatFilesDir, deleteChatFileAttachments, deleteConversationFiles, resolveStoredFile, SHAREABLE_EXTENSIONS } from "../src/server/chatFiles.js";
import { MAX_CHAT_IMAGES_PER_MESSAGE, MAX_CHAT_IMAGE_BYTES } from "../src/server/chatImages.js";
import { PI_MAX_REQUEST_BYTES } from "../src/server/agent/pi/responsesClient.js";
import { isPptxCard, PPTX_MEDIA_TYPE } from "../src/shared/shareLinks.js";
import type { AppConfig } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

const dir = withTempDir("chat-documents");
const config = () => ({ dataDir: dir() }) as AppConfig;

const dataUrl = (buffer: Buffer, mime = "application/octet-stream") => `data:${mime};base64,${buffer.toString("base64")}`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
/** Just enough of a ZIP for the content check: a local header, the content-types part and the kind's folder. */
const ooxml = (folder: string) =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\0\0[Content_Types].xml\0\0${folder}/main.xml\0\0`)]);
const DOCX = ooxml("word");
const XLSX = ooxml("xl");
const PPTX = ooxml("ppt");
const TEXT = Buffer.from("이름,값\n가,1\n", "utf8");
/** "이름,값\r\n가,1\r\n" as Korean Excel saves a CSV: CP949 (EUC-KR), not valid UTF-8. */
const CP949_CSV = Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xb0, 0xaa, 0x0d, 0x0a, 0xb0, 0xa1, 0x2c, 0x31, 0x0d, 0x0a]);

const decode = (files: unknown, options?: { encodedImageBytes?: number }) => decodeChatDocuments(files, options);
const errorOf = (files: unknown, options?: { encodedImageBytes?: number }) => {
  const result = decode(files, options);
  return "error" in result ? result.error : null;
};

describe("the shared document contract", () => {
  it("lists pi's input_file extensions minus the images, each with a stored media type", () => {
    expect([...CHAT_DOCUMENT_EXTENSIONS]).toEqual(["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "json"]);
    expect(Object.keys(CHAT_DOCUMENT_MEDIA_TYPES).sort()).toEqual([...CHAT_DOCUMENT_EXTENSIONS].sort());
    // pi's own list (vendor/pi-gateway apps/gateway/src/api/request.ts FILE_EXTENSIONS) holds every one of them.
    const piSource = fs.readFileSync(path.join(__dirname, "../vendor/pi-gateway/apps/gateway/src/api/request.ts"), "utf8");
    const piList = /const FILE_EXTENSIONS = \[([^\]]+)\]/.exec(piSource)?.[1] ?? "";
    for (const ext of CHAT_DOCUMENT_EXTENSIONS) expect(piList).toContain(`"${ext}"`);
  });

  it("keeps a full message under pi-gateway's body cap and Noah's own JSON limit", () => {
    expect(MAX_CHAT_DOCUMENTS_PER_MESSAGE).toBe(5);
    expect(MAX_CHAT_DOCUMENT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CHAT_DOCUMENTS_TOTAL_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_CHAT_DOCUMENT_BYTES).toBeLessThanOrEqual(MAX_CHAT_DOCUMENTS_TOTAL_BYTES);
    // A full document budget fits the shared attachment budget with room for images…
    expect(base64EncodedLength(MAX_CHAT_DOCUMENTS_TOTAL_BYTES)).toBeLessThan(MAX_CHAT_ATTACHMENTS_ENCODED_BYTES);
    // …and the attachment budget leaves 1 MiB of pi's body for text, instructions and sandbox_env.
    expect(PI_MAX_REQUEST_BYTES - MAX_CHAT_ATTACHMENTS_ENCODED_BYTES).toBe(1024 * 1024);
    // Noah's express.json limit (50mb, app.ts) is above anything the budget lets through.
    const appSource = fs.readFileSync(path.join(__dirname, "../src/server/app.ts"), "utf8");
    expect(appSource).toContain('express.json({ limit: "50mb" })');
    expect(MAX_CHAT_ATTACHMENTS_ENCODED_BYTES + 2 * 1024 * 1024).toBeLessThan(50 * 1024 * 1024);
    // The image caps alone can exceed the budget, so the server measures images and documents together.
    expect(base64EncodedLength(MAX_CHAT_IMAGE_BYTES) * MAX_CHAT_IMAGES_PER_MESSAGE).toBeGreaterThan(MAX_CHAT_ATTACHMENTS_ENCODED_BYTES);
  });

  it("measures base64 the way Buffer encodes it", () => {
    for (const size of [0, 1, 2, 3, 4, 1000, 1001]) {
      expect(base64EncodedLength(size)).toBe(Buffer.alloc(size).toString("base64").length);
    }
  });

  it("accepts a plain name with an allowed extension and returns it as stored", () => {
    expect(chatDocumentName("보고서 2026.pdf")).toBe("보고서 2026.pdf");
    expect(chatDocumentName("  notes.MD  ")).toBe("notes.MD");
    expect(chatDocumentName(".hidden.json")).toBe(".hidden.json");
    // NFD (a decomposed Hangul name) is stored as NFC.
    expect(chatDocumentName("가.txt".normalize("NFD"))).toBe("가.txt");
    expect(chatDocumentExtension("a.b.XLSX")).toBe("xlsx");
  });

  it("refuses what pi would refuse (and a few disguises pi would take)", () => {
    for (const bad of ["", " ", ".", "..", "a/b.pdf", "a\\b.pdf", "a\nb.pdf", "a\u0000.pdf", "a\u007f.pdf", "a\u202e.pdf", "a\u2028b.pdf", ".pdf", "pdf", "a.pdf.exe", "a.png", "a.doc"]) {
      expect(chatDocumentName(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(chatDocumentName(`${"가".repeat(84)}.pdf`)).toBeNull(); // 84 × 3 + 4 = 256 bytes
    expect(chatDocumentName(`${"가".repeat(83)}.pdf`)).toBe(`${"가".repeat(83)}.pdf`); // 253 bytes
    expect(chatDocumentName(`${"a".repeat(252)}.pdf`)).toBeNull(); // 256 bytes
    expect(chatDocumentName(`${"a".repeat(251)}.pdf`)).not.toBeNull(); // 255 bytes
  });

  it("tells a wrong type from a bad name", () => {
    expect(chatDocumentNameProblem("a.pdf")).toBeNull();
    expect(chatDocumentNameProblem("a.exe")).toBe("TYPE");
    expect(chatDocumentNameProblem("noext")).toBe("TYPE");
    expect(chatDocumentNameProblem("a/b.pdf")).toBe("NAME");
    expect(chatDocumentNameProblem(`${"a".repeat(300)}.pdf`)).toBe("NAME");
    expect(chatDocumentNameProblem("")).toBe("NAME");
  });

  it("makes names unique within one message, case-insensitively, inside the byte cap", () => {
    expect(uniqueChatDocumentNames(["a.pdf", "b.pdf", "a.pdf", "A.PDF", "a (2).pdf"])).toEqual([
      "a.pdf",
      "b.pdf",
      "a (2).pdf",
      "A (3).PDF",
      "a (2) (2).pdf",
    ]);
    const long = `${"가".repeat(83)}.pdf`;
    const [first, second] = uniqueChatDocumentNames([long, long]);
    expect(first).toBe(long);
    expect(second).not.toBe(long);
    expect(Buffer.byteLength(second!)).toBeLessThanOrEqual(255);
    expect(chatDocumentName(second!)).toBe(second);
  });

  it("has a Korean message for every problem", () => {
    for (const message of Object.values(CHAT_DOCUMENT_MESSAGES)) expect(message).toMatch(/[가-힣]/);
    expect(CHAT_DOCUMENT_MESSAGES.TOO_LARGE).toContain("8MB");
    expect(CHAT_DOCUMENT_MESSAGES.TOO_MANY).toContain("5개");
  });
});

describe("chatDocumentContentMatches", () => {
  it("checks the bytes against the extension", () => {
    expect(chatDocumentContentMatches("pdf", PDF)).toBe(true);
    expect(chatDocumentContentMatches("pdf", Buffer.concat([Buffer.from("\ufeff\n"), PDF]))).toBe(true);
    expect(chatDocumentContentMatches("pdf", DOCX)).toBe(false);
    expect(chatDocumentContentMatches("pdf", Buffer.concat([Buffer.alloc(2000, 0x20), PDF]))).toBe(false);
    expect(chatDocumentContentMatches("docx", DOCX)).toBe(true);
    expect(chatDocumentContentMatches("xlsx", XLSX)).toBe(true);
    expect(chatDocumentContentMatches("pptx", PPTX)).toBe(true);
    // The right container, the wrong kind.
    expect(chatDocumentContentMatches("docx", XLSX)).toBe(false);
    expect(chatDocumentContentMatches("pptx", DOCX)).toBe(false);
    // A legacy / password-protected Office file is an OLE container, not a ZIP.
    expect(chatDocumentContentMatches("docx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(false);
    // A bare ZIP is not an Office document.
    expect(chatDocumentContentMatches("xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBe(false);
    for (const ext of ["csv", "txt", "md", "json"] as const) {
      expect(chatDocumentContentMatches(ext, TEXT)).toBe(true);
      expect(chatDocumentContentMatches(ext, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), TEXT]))).toBe(true);
      // Any text encoding passes: a CP949/EUC-KR export is an ordinary file on this fleet.
      expect(chatDocumentContentMatches(ext, CP949_CSV)).toBe(true);
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(CP949_CSV)).toThrow();
      // Only what is clearly binary is refused: a NUL byte in the first chunk.
      expect(chatDocumentContentMatches(ext, Buffer.from("a\0b"))).toBe(false);
      expect(chatDocumentContentMatches(ext, Buffer.from("가나", "utf16le"))).toBe(false);
      // UTF-16 text that announces itself with a BOM (Excel's "Unicode text") is text, NULs and all.
      expect(chatDocumentContentMatches(ext, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("가,나\n1,2", "utf16le")]))).toBe(true);
      expect(chatDocumentContentMatches(ext, Buffer.from([0xfe, 0xff, 0x00, 0x61, 0x00, 0x62]))).toBe(true);
      expect(chatDocumentContentMatches(ext, Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])]))).toBe(true);
    }
  });
});

describe("decodeChatDocuments", () => {
  it("returns nothing for an absent or empty list", () => {
    expect(decode(undefined)).toEqual({ documents: [] });
    expect(decode(null)).toEqual({ documents: [] });
    expect(decode([])).toEqual({ documents: [] });
  });

  it("decodes valid documents, never trusting the declared MIME, and de-duplicates names", () => {
    const result = decode([
      { name: "보고서.pdf", data: dataUrl(PDF, "image/png") },
      { name: "보고서.pdf", data: dataUrl(PDF, "") },
      { id: "client-id_1", name: "표.xlsx", data: dataUrl(XLSX) },
      { name: "메모.md", data: dataUrl(TEXT, "text/html") },
    ]);
    if ("error" in result) throw new Error(result.error);
    expect(result.documents.map((d) => [d.name, d.ext, d.mediaType])).toEqual([
      ["보고서.pdf", "pdf", "application/pdf"],
      ["보고서 (2).pdf", "pdf", "application/pdf"],
      ["표.xlsx", "xlsx", CHAT_DOCUMENT_MEDIA_TYPES.xlsx],
      ["메모.md", "md", "text/markdown"],
    ]);
    expect(result.documents[2]!.id).toBe("client-id_1");
    expect(result.documents[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.documents[0]!.buffer).toEqual(PDF);
  });

  it("refuses a malformed payload as BAD_FORMAT", () => {
    expect(errorOf("nope")).toBe("BAD_FORMAT");
    expect(errorOf(["data:application/pdf;base64,AAAA"])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.pdf" }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: 3, data: dataUrl(PDF) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.pdf", data: PDF.toString("base64") }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.pdf", data: `data:application/pdf,${PDF.toString("base64")}` }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.pdf", data: "https://example.invalid/a.pdf" }])).toBe("BAD_FORMAT");
    // Not base64 at all: Buffer.from would quietly skip the junk.
    expect(errorOf([{ name: "a.txt", data: "data:text/plain;base64,한글은 base64가 아니다!!" }])).toBe("BAD_FORMAT");
  });

  it("refuses a bad name (NAME) and a type that is not a document (TYPE)", () => {
    expect(errorOf([{ name: "../a.pdf", data: dataUrl(PDF) }])).toBe("NAME");
    expect(errorOf([{ name: "..", data: dataUrl(PDF) }])).toBe("NAME");
    expect(errorOf([{ name: "a.exe", data: dataUrl(PDF) }])).toBe("TYPE");
    expect(errorOf([{ name: "photo.png", data: dataUrl(PDF) }])).toBe("TYPE");
  });

  it("accepts a CP949 CSV and a json that does not parse, bytes untouched", () => {
    const result = decode([{ name: "매출.csv", data: dataUrl(CP949_CSV, "text/csv") }, { name: "broken.json", data: dataUrl(Buffer.from("{ not json")) }]);
    if ("error" in result) throw new Error(result.error);
    expect(result.documents[0]!.buffer).toEqual(CP949_CSV);
    expect(result.documents[0]!.mediaType).toBe("text/csv");
    expect(result.documents[1]!.buffer.toString()).toBe("{ not json");
    // UTF-16 with a BOM, little- and big-endian: text, kept byte-for-byte.
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("이름\t값\r\n가\t1\r\n", "utf16le")]);
    const utf16be = Buffer.from([0xfe, 0xff, 0xac, 0x00, 0x00, 0x0a]);
    const wide = decode([{ name: "유니코드.txt", data: dataUrl(utf16le) }, { name: "be.csv", data: dataUrl(utf16be) }]);
    if ("error" in wide) throw new Error(wide.error);
    expect(wide.documents.map((d) => d.buffer)).toEqual([utf16le, utf16be]);
  });

  it("refuses an empty file (EMPTY)", () => {
    expect(errorOf([{ name: "a.txt", data: "data:text/plain;base64," }])).toBe("EMPTY");
  });

  it("refuses content that is not what the extension says (BAD_FORMAT)", () => {
    expect(errorOf([{ name: "a.pdf", data: dataUrl(TEXT) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.docx", data: dataUrl(PDF) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.xlsx", data: dataUrl(DOCX) }])).toBe("BAD_FORMAT");
    // A NUL byte and no UTF-16 BOM: binary.
    expect(errorOf([{ name: "a.csv", data: dataUrl(Buffer.from("가,1", "utf16le")) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.txt", data: dataUrl(Buffer.from("abc\0def")) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.txt", data: dataUrl(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])) }])).toBe("BAD_FORMAT");
    expect(errorOf([{ name: "a.json", data: dataUrl(Buffer.from("{\0}")) }])).toBe("BAD_FORMAT");
  });

  it("enforces the count, per-file and total caps", () => {
    const one = { name: "a.txt", data: dataUrl(TEXT) };
    expect(errorOf(Array.from({ length: MAX_CHAT_DOCUMENTS_PER_MESSAGE + 1 }, () => one))).toBe("TOO_MANY");
    expect(errorOf(Array.from({ length: MAX_CHAT_DOCUMENTS_PER_MESSAGE }, () => one))).toBeNull();

    const atCap = Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES, 0x61);
    expect(errorOf([{ name: "big.txt", data: dataUrl(atCap) }])).toBeNull();
    expect(errorOf([{ name: "big.txt", data: dataUrl(Buffer.alloc(MAX_CHAT_DOCUMENT_BYTES + 1, 0x61)) }])).toBe("TOO_LARGE");

    const half = Buffer.alloc(MAX_CHAT_DOCUMENTS_TOTAL_BYTES / 2, 0x61);
    expect(errorOf([{ name: "1.txt", data: dataUrl(half) }, { name: "2.txt", data: dataUrl(half) }])).toBeNull();
    expect(
      errorOf([{ name: "1.txt", data: dataUrl(half) }, { name: "2.txt", data: dataUrl(half) }, { name: "3.txt", data: dataUrl(Buffer.from("x")) }]),
    ).toBe("TOTAL_TOO_LARGE");
  });

  it("counts the same message's images against the shared budget (TOTAL_TOO_LARGE)", () => {
    const document = Buffer.alloc(6 * 1024 * 1024, 0x61);
    const files = [{ name: "big.txt", data: dataUrl(document) }];
    const room = MAX_CHAT_ATTACHMENTS_ENCODED_BYTES - base64EncodedLength(document.length);
    expect(errorOf(files, { encodedImageBytes: room })).toBeNull();
    expect(errorOf(files, { encodedImageBytes: room + 4 })).toBe("TOTAL_TOO_LARGE");
  });
});

describe("the document file store", () => {
  const decoded = (name: string, buffer: Buffer, id?: string) => {
    const result = decode([{ ...(id ? { id } : {}), name, data: dataUrl(buffer) }]);
    if ("error" in result) throw new Error(result.error);
    return result.documents;
  };

  it("stores a copy in the conversation's file store and returns an uploaded file attachment + the model input", () => {
    const saved = saveChatDocuments(config(), "conv-1", [...decoded("보고서.pdf", PDF, "doc-1"), ...decoded("data.json", Buffer.from("{}"))]);
    expect(saved.attachments).toEqual([
      { id: "doc-1", kind: "file", mediaType: "application/pdf", name: "보고서.pdf", size: PDF.length, uploaded: true },
      { id: expect.any(String), kind: "file", mediaType: "application/json", name: "data.json", size: 2, uploaded: true },
    ]);
    expect(saved.documents).toEqual([
      { name: "보고서.pdf", mediaType: "application/pdf", data: PDF.toString("base64"), size: PDF.length },
      { name: "data.json", mediaType: "application/json", data: Buffer.from("{}").toString("base64"), size: 2 },
    ]);
    expect(fs.readFileSync(path.join(chatFilesDir(config(), "conv-1"), "doc-1.pdf"))).toEqual(PDF);
    // The download route's resolver serves both — json included — and share_file's list is unchanged.
    expect(resolveStoredFile(config(), "conv-1", "doc-1")).toMatchObject({ mediaType: "application/pdf", ext: "pdf" });
    expect(resolveStoredFile(config(), "conv-1", saved.attachments[1]!.id)).toMatchObject({ mediaType: "application/json", ext: "json" });
    expect(SHAREABLE_EXTENSIONS).not.toContain("json");
    expect(saved.attachments.every(isUploadedDocument)).toBe(true);
  });

  it("never reuses an id another stored file holds, whatever its extension", () => {
    const first = saveChatDocuments(config(), "conv-1", decoded("a.pdf", PDF, "same"));
    const second = saveChatDocuments(config(), "conv-1", decoded("a.txt", TEXT, "same"));
    const batch = saveChatDocuments(config(), "conv-1", [...decoded("b.txt", TEXT, "twin"), ...decoded("c.txt", TEXT, "twin")]);
    expect(first.attachments[0]!.id).toBe("same");
    expect(second.attachments[0]!.id).not.toBe("same");
    expect(batch.attachments[0]!.id).toBe("twin");
    expect(batch.attachments[1]!.id).not.toBe("twin");
    expect(fs.readFileSync(path.join(chatFilesDir(config(), "conv-1"), "same.pdf"))).toEqual(PDF);
  });

  it("reads stored documents back for a re-send, and only the user's own uploads", () => {
    const saved = saveChatDocuments(config(), "conv-1", [...decoded("a.pdf", PDF), ...decoded("표.xlsx", XLSX)]);
    // An avatar-published card in the same store is never re-sent as a user document.
    fs.writeFileSync(path.join(chatFilesDir(config(), "conv-1"), "card.pptx"), PPTX);
    const card = { id: "card", kind: "file" as const, mediaType: PPTX_MEDIA_TYPE, name: "deck.pptx", size: PPTX.length };
    const image = { id: saved.attachments[0]!.id, kind: "image" as const, mediaType: "image/png" };
    expect(readChatDocuments(config(), "conv-1", [image, card, ...saved.attachments])).toEqual(saved.documents);
    expect(readChatDocuments(config(), "conv-1", undefined)).toEqual([]);
    // Another conversation's store does not hold them.
    expect(readChatDocuments(config(), "conv-2", saved.attachments)).toEqual([]);
    // A stored name that is no longer a document name, or whose file is another type, is skipped.
    expect(readChatDocuments(config(), "conv-1", [{ ...saved.attachments[0]!, name: "../a.pdf" }])).toEqual([]);
    expect(readChatDocuments(config(), "conv-1", [{ ...saved.attachments[0]!, name: "a.txt" }])).toEqual([]);
    // A missing file is skipped, the rest still read.
    fs.rmSync(path.join(chatFilesDir(config(), "conv-1"), `${saved.attachments[0]!.id}.pdf`));
    expect(readChatDocuments(config(), "conv-1", saved.attachments)).toEqual([saved.documents[1]]);
  });

  it("dies with what it mirrors: the per-message sweep and the conversation sweep remove the copies", () => {
    const saved = saveChatDocuments(config(), "conv-1", [...decoded("a.pdf", PDF), ...decoded("b.txt", TEXT)]);
    const file = (index: number, ext: string) => path.join(chatFilesDir(config(), "conv-1"), `${saved.attachments[index]!.id}.${ext}`);
    // The rewind/regenerate sweep (deleteChatFileAttachments) takes exactly the dropped rows' attachments.
    deleteChatFileAttachments(config(), "conv-1", [saved.attachments[0]!]);
    expect(fs.existsSync(file(0, "pdf"))).toBe(false);
    expect(fs.existsSync(file(1, "txt"))).toBe(true);
    // Conversation delete / 비우기 / user delete (deleteConversationFiles) takes the rest.
    deleteConversationFiles(config(), "conv-1");
    expect(fs.existsSync(chatFilesDir(config(), "conv-1"))).toBe(false);
  });

  it("is never a share-link deck: an uploaded .pptx is not a PPTX card", () => {
    const [upload] = saveChatDocuments(config(), "conv-1", decoded("내 발표.pptx", PPTX)).attachments;
    expect(upload!.mediaType).toBe(PPTX_MEDIA_TYPE);
    expect(isPptxCard(upload!)).toBe(false);
    expect(isPptxCard({ ...upload!, uploaded: undefined })).toBe(true);
  });
});
