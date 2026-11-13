// The 파일 tab of the chat side panel: a READ-ONLY window for the signed-in user
// onto their own pi sandbox workspace (`/workspace`) — a folder tree, downloads
// and a preview of simple files. This module is the contract the routes
// (`routes/workspaceFiles.ts`), the host-side reader (`workspaceBrowser.ts`) and
// the tab (`components/WorkspaceTab.tsx`) share: the listing shape, the path
// grammar, the caps and what may be previewed how. Import-free leaf: it is
// bundled into the browser, so it must not import anything.
//
// Everything a listing or a file holds is the AGENT's (or a third party's the
// agent copied): names and contents are untrusted text, drawn as text or
// through a sanitizer, never executed.

/** Entries one folder listing returns (the rest is counted in `total`). */
export const WORKSPACE_LIST_MAX_ENTRIES: number = 1000;
/**
 * Entries of one folder the server reads at all. Past it the listing is the
 * first ones the filesystem handed out (still sorted among themselves) and
 * `total` is a floor (`totalIsMinimum`).
 */
export const WORKSPACE_SCAN_MAX_ENTRIES: number = 20000;
/** Folder nesting a path may name. */
export const WORKSPACE_PATH_MAX_DEPTH: number = 64;
/** Characters a `path` query may hold. */
export const WORKSPACE_PATH_MAX_LENGTH: number = 4096;
/** Bytes of a text-like file the tab reads for a preview. */
export const WORKSPACE_TEXT_PREVIEW_MAX_BYTES: number = 1024 * 1024;
/** Bytes of an image the tab shows (also the server's cap for any `preview=1` read). */
export const WORKSPACE_IMAGE_PREVIEW_MAX_BYTES: number = 10 * 1024 * 1024;
/** Rows / columns a CSV preview draws. */
export const WORKSPACE_TABLE_MAX_ROWS: number = 500;
export const WORKSPACE_TABLE_MAX_COLUMNS: number = 50;

/** `link` and `other` (a socket, a device) are listed and never opened. */
export type WorkspaceEntryKind = "dir" | "file" | "link" | "other";

export interface WorkspaceEntry {
  /** The entry's own name (one path segment), exactly as the sandbox wrote it. */
  name: string;
  kind: WorkspaceEntryKind;
  /** Bytes, for a file. */
  size?: number;
  /** ISO time of the last change, when it could be read. */
  modifiedAt?: string;
  /** A folder of `c/` that is one of the user's conversations. */
  conversation?: { id: string; title: string };
  /** A folder of `c/` that looks like a conversation's and belongs to none the user still has. */
  orphan?: boolean;
}

export interface WorkspaceListing {
  /** The listed folder, relative to the workspace root (`""` = the root). */
  path: string;
  /** False only for the ROOT of a user whose sandbox was never created. */
  exists: boolean;
  entries: WorkspaceEntry[];
  /** Entries the folder holds (`entries` is cut at {@link WORKSPACE_LIST_MAX_ENTRIES}). */
  total: number;
  /** The folder holds MORE than `total`: the server stopped reading at {@link WORKSPACE_SCAN_MAX_ENTRIES}. */
  totalIsMinimum?: boolean;
  truncated: boolean;
  /** The folder of the conversation the request named (`c/<segment>`), whether or not it exists yet. */
  current?: string;
}

function isPlainSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

/**
 * A `path` query as folder segments, or null when it is not a relative path of
 * plain names (no `..`, no empty or dot segment, no backslash, no NUL). `""`
 * and a missing value are the workspace root.
 */
export function parseWorkspacePath(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw !== "string" || raw.length > WORKSPACE_PATH_MAX_LENGTH) return null;
  const parts = raw.split("/");
  if (parts.length > WORKSPACE_PATH_MAX_DEPTH || !parts.every(isPlainSegment)) return null;
  return parts;
}

/** A child's path below `parent` (`""` = the root). */
export function joinWorkspacePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The lowercase extension of a file name (`""` when it has none; a dotfile has none). */
export function workspaceExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/** The media type the file route serves an image under (by extension), else null. */
export function workspaceImageMediaType(name: string): string | null {
  return IMAGE_MEDIA_TYPES[workspaceExtension(name)] ?? null;
}

/**
 * Extensions that are never text: the tab does not fetch them to find out.
 * (Anything else is read and judged by its bytes — {@link decodeWorkspaceText}.)
 */
const BINARY_EXTENSIONS = new Set([
  "pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls", "hwp", "hwpx",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "whl",
  "ico", "tif", "tiff", "heic", "avif", "psd",
  "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  "woff", "woff2", "ttf", "otf", "eot",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "class", "pyc", "wasm",
  "sqlite", "sqlite3", "db", "parquet", "npy", "npz", "pkl", "pt", "onnx",
]);

/** How the tab draws a file. */
export type WorkspacePreviewKind = "image" | "markdown" | "html" | "csv" | "json" | "drawio" | "text";

/** Why a file has no preview (the tab says so and offers the download). */
export type WorkspacePreviewRefusal = "TOO_LARGE" | "BINARY";

/**
 * What the tab does with a file, from its name and size alone: a preview kind,
 * or the reason there is none. `text` is still judged by the bytes once read.
 */
export function workspacePreviewKind(name: string, size: number): WorkspacePreviewKind | WorkspacePreviewRefusal {
  const ext = workspaceExtension(name);
  if (IMAGE_MEDIA_TYPES[ext]) return size > WORKSPACE_IMAGE_PREVIEW_MAX_BYTES ? "TOO_LARGE" : "image";
  if (BINARY_EXTENSIONS.has(ext)) return "BINARY";
  if (size > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) return "TOO_LARGE";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (ext === "drawio") return "drawio";
  return "text";
}

function decodeStrict(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * A file's bytes as text, or null when they are not text: UTF-8 / UTF-16 by
 * BOM, else UTF-8, else CP949 (what Korean Excel and Windows tools save). A
 * NUL byte without a UTF-16 BOM means binary.
 */
export function decodeWorkspaceText(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeStrict(bytes.subarray(3), "utf-8");
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decodeStrict(bytes.subarray(2), "utf-16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decodeStrict(bytes.subarray(2), "utf-16be");
  if (bytes.includes(0)) return null;
  return decodeStrict(bytes, "utf-8") ?? decodeStrict(bytes, "euc-kr");
}

export interface WorkspaceTable {
  rows: string[][];
  /** Rows or columns were left out ({@link WORKSPACE_TABLE_MAX_ROWS} / {@link WORKSPACE_TABLE_MAX_COLUMNS}). */
  truncated: boolean;
}

/**
 * CSV/TSV text as rows of cells (RFC 4180 quoting: `"a ""b"" c"`, a quoted
 * cell may hold the delimiter and line breaks). Lenient: a quote inside an
 * unquoted cell is kept as text, and an unclosed quote runs to the end.
 */
export function parseDelimitedText(
  text: string,
  delimiter: "," | "\t",
  maxRows: number = WORKSPACE_TABLE_MAX_ROWS,
  maxColumns: number = WORKSPACE_TABLE_MAX_COLUMNS,
): WorkspaceTable {
  const rows: string[][] = [];
  let truncated = false;
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;
  const endCell = (): void => {
    if (row.length < maxColumns) row.push(cell);
    else truncated = true;
    cell = "";
    cellStarted = false;
  };
  const endRow = (): boolean => {
    endCell();
    // A blank line is not a row.
    if (row.length > 1 || row[0] !== "") {
      if (rows.length >= maxRows) {
        truncated = true;
        return false;
      }
      rows.push(row);
    }
    row = [];
    return true;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      if (!endRow()) return { rows, truncated };
    } else {
      cell += ch;
      cellStarted = true;
    }
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, truncated };
}

/**
 * A name as the tab shows it: control characters and the bidirectional
 * overrides (which can make `gpj.exe` read as `exe.jpg`) become a visible
 * mark. The real name still rides the request.
 */
export function workspaceDisplayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "□");
}
