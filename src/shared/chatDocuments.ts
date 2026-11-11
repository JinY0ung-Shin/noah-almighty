// Chat DOCUMENT attachments: files the user attaches to a chat message so the
// avatar can read them in its sandbox (pi-gateway's `input_file`, written to
// `/workspace/uploads/<filename>`). This module is the contract the composer
// (client) and the turn intake (`routes/chat.ts` → `chatDocuments.ts`) share:
// what may be attached, how a name is judged, and the Korean refusals both
// sides show. Import-free leaf: it is bundled into the browser, so it must not
// import anything. Images are NOT documents — they keep their own path
// (`images`, `chatImages.ts`).

/** Extensions a chat message may carry as a DOCUMENT (pi's input_file list minus images, which stay images). */
export const CHAT_DOCUMENT_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "md", "json"] as const;
export type ChatDocumentExtension = (typeof CHAT_DOCUMENT_EXTENSIONS)[number];

/**
 * The media type STORED for each extension (the server derives it from the
 * extension after checking the bytes — a client-declared MIME is never used).
 */
export const CHAT_DOCUMENT_MEDIA_TYPES: Record<ChatDocumentExtension, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

// ---- Limits -------------------------------------------------------------------
//
// The binding cap is pi-gateway's request body: 16 MiB (16,777,216 bytes) for
// the WHOLE `/v1/responses` JSON — text, instructions, sandbox_env and every
// attachment as base64 (4 bytes per 3 raw bytes). Budget:
//
//   16 MiB  pi body cap
//  − 1 MiB  everything that is not an attachment (the frozen instructions on a
//           first turn, the message text + per-turn preamble, sandbox_env
//           ≤ 256 KiB, JSON framing)
//  = 15 MiB of base64 for images + documents together
//           (MAX_CHAT_ATTACHMENTS_ENCODED_BYTES)
//
//   documents: 8 MiB raw in total → base64 10.67 MiB
//   leaves 4.33 MiB of base64 (≈ 3.25 MiB raw) for the same message's images
//
// So a message that fills the document budget can still carry a few downscaled
// images, and the SERVER checks the combined base64 size (a message whose
// images + documents exceed it is refused as TOTAL_TOO_LARGE before the turn
// starts — never a late failure at pi). Noah's own JSON body limit
// (`express.json`, 50 MB) is far above any request that passes that check:
// 15 MiB of attachments + the text is < 17 MiB.

/** Documents one message may carry. */
export const MAX_CHAT_DOCUMENTS_PER_MESSAGE: number = 5;
/** Per-document byte cap (decoded bytes). */
export const MAX_CHAT_DOCUMENT_BYTES: number = 8 * 1024 * 1024;
/** Byte cap of ALL documents of one message together (decoded bytes). */
export const MAX_CHAT_DOCUMENTS_TOTAL_BYTES: number = 8 * 1024 * 1024;
/**
 * Base64 size one message's images AND documents may reach together (see the
 * arithmetic above). Measure each attachment with {@link base64EncodedLength}.
 */
export const MAX_CHAT_ATTACHMENTS_ENCODED_BYTES: number = 15 * 1024 * 1024;

/** Length of the base64 text of `bytes` raw bytes (padding included). */
export function base64EncodedLength(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 3) * 4;
}

export type ChatDocumentProblem =
  | "TYPE"
  | "NAME"
  | "EMPTY"
  | "TOO_LARGE"
  | "TOO_MANY"
  | "TOTAL_TOO_LARGE"
  | "BAD_FORMAT"
  | "NOT_ALLOWED_HERE";

const MB = 1024 * 1024;

/** KOREAN, user-facing: the composer and the server's 400 show the same sentence. */
export const CHAT_DOCUMENT_MESSAGES: Record<ChatDocumentProblem, string> = {
  TYPE: "지원하지 않는 파일 형식입니다. PDF, Word(docx), Excel(xlsx), PowerPoint(pptx), CSV, TXT, MD, JSON 파일만 첨부할 수 있습니다.",
  NAME: "파일 이름을 사용할 수 없습니다. 경로 구분자(/, \\)나 제어 문자가 없는 255바이트 이하의 이름이어야 합니다.",
  EMPTY: "빈 파일은 첨부할 수 없습니다.",
  TOO_LARGE: `문서는 파일 하나에 ${MAX_CHAT_DOCUMENT_BYTES / MB}MB까지 첨부할 수 있습니다.`,
  TOO_MANY: `문서는 한 메시지에 ${MAX_CHAT_DOCUMENTS_PER_MESSAGE}개까지 첨부할 수 있습니다.`,
  TOTAL_TOO_LARGE: `첨부 용량이 너무 큽니다. 한 메시지의 문서는 합쳐서 ${MAX_CHAT_DOCUMENTS_TOTAL_BYTES / MB}MB까지이고, 이미지와 함께 보내면 그보다 적게 담을 수 있습니다.`,
  BAD_FORMAT: "파일 내용이 확장자와 맞지 않거나 손상되어 첨부할 수 없습니다.",
  NOT_ALLOWED_HERE: "문서는 내 아바타와의 대화에서만 첨부할 수 있습니다.",
};

const MAX_NAME_BYTES = 255;

// pi's FILENAME rule (no `/`, `\`, C0 controls or DEL), plus the characters
// that would break the one-line `[Attached file: …]` note or disguise the
// name: C1 controls, the Unicode line/paragraph separators and the bidi
// embedding/override/isolate controls. Stricter than pi, never looser.
const FORBIDDEN_NAME_CHARS = /[/\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** UTF-8 byte length without TextEncoder/Buffer (this module runs on both sides). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** The lower-cased extension of `name` when it is one a document may have, else null. */
export function chatDocumentExtension(name: string): ChatDocumentExtension | null {
  const dot = name.lastIndexOf(".");
  if (dot < 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return (CHAT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ChatDocumentExtension) : null;
}

/**
 * The file name as it will be stored and sent, or null when it cannot be one
 * (pi's rule: a plain name, no path separators or control characters, not "." /
 * "..", ≤ 255 bytes, an allowed extension). The only normalization is Unicode
 * NFC and trimming surrounding whitespace — a name is never silently rewritten
 * into a different file.
 */
export function chatDocumentName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFC").trim();
  if (!name || name === "." || name === "..") return null;
  if (FORBIDDEN_NAME_CHARS.test(name)) return null;
  if (utf8Length(name) > MAX_NAME_BYTES) return null;
  if (!chatDocumentExtension(name)) return null;
  return name;
}

/** Why `raw` is not a usable document name ("TYPE" = the extension, "NAME" = the rest), or null when it is one. */
export function chatDocumentNameProblem(raw: string): "TYPE" | "NAME" | null {
  if (chatDocumentName(raw) !== null) return null;
  const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  if (!name || name === "." || name === ".." || FORBIDDEN_NAME_CHARS.test(name)) return "NAME";
  return chatDocumentExtension(name) ? "NAME" : "TYPE";
}

/** `stem` cut (on a code-point boundary) so that it fits in `maxBytes` of UTF-8. */
function fitStem(stem: string, maxBytes: number): string {
  if (utf8Length(stem) <= maxBytes) return stem;
  let out = "";
  let bytes = 0;
  for (const char of stem) {
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out.trimEnd() || "file";
}

/**
 * Names made unique within one message: "a.pdf", "a (2).pdf". Two names that
 * differ only in letter case count as the same file (pi overwrites a same-named
 * upload, and the fleet's own file systems are case-insensitive). The stem is
 * shortened when the suffix would push a name past 255 bytes. Order is kept.
 */
export function uniqueChatDocumentNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      candidate = `${fitStem(stem, MAX_NAME_BYTES - utf8Length(suffix) - utf8Length(ext))}${suffix}${ext}`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

/** `/workspace/uploads/` — where pi writes a document in the sandbox of the run's principal. */
export const CHAT_DOCUMENT_SANDBOX_DIR = "/workspace/uploads";
