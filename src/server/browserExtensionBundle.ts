import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Packages `extension/` as a downloadable zip so an operator can install the
 * browser bridge from the settings page instead of cloning the repo.
 *
 * Hand-rolled rather than pulling in an archiver dependency: this writes a
 * handful of small text files, and the ZIP container for that case is a local
 * header per entry plus a central directory. Deflate comes from node's zlib.
 *
 * Only files that ship in the extension are included, by an explicit ALLOWLIST
 * rather than a directory walk — the folder sits in the repo, and a stray
 * key/note dropped there must never end up in a file we hand to users.
 */

const BUNDLE_FILES = [
  "manifest.json",
  "background.js",
  // background.js imports this at load; omitting it bricks the worker outright.
  "axtree.js",
  // Same: the pure half of secret input, imported at load by background.js.
  "secretInput.js",
  // Same again (0.29.0): per-conversation working tabs + tab leases.
  "tabLeases.js",
  "options.html",
  "options.js",
  "options.css",
  "consent.html",
  "consent.js",
  "consent.css",
  // The uid-map viewer the popup opens (chrome.runtime.getURL("uid-map.html")).
  // Nothing else references it, so a bundle missing these ships a button whose
  // new tab 404s — with the capture already taken and no way to see it.
  "uid-map.html",
  "uid-map.js",
  "uid-map.css",
  // Binary entries — the files list ships these base64 (see BINARY_BUNDLE_FILES);
  // the manifest references them, so an install missing them fails to load.
  "icon-16.png",
  "icon-32.png",
  "icon-48.png",
  "icon-128.png",
  "policy-schema.json",
  "README.md",
] as const;

/** Bundle entries that are bytes, not utf8 text. */
const BINARY_BUNDLE_FILES = new Set(["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]);

export const BROWSER_EXTENSION_DIR = path.join(process.cwd(), "extension");

/**
 * Oldest installed extension build the CURRENT server can still drive
 * correctly. An install at or above this reads as `compatible` in the composer
 * badge — its own non-alarming rung ("업데이트 있음") rather than an update
 * order — even when it differs from the bundled version, so users are only
 * pushed through a re-download when the agent-facing op contract actually
 * broke, not on every extension-folder touch.
 *
 * Bump this ONLY when the server starts emitting a bridge op/field an older
 * build would answer with `Unsupported operation` (or silently mishandle).
 * Do NOT bump for page-facing additions (e.g. `reloadExtension`) or
 * extension-internal fixes old builds merely lack. Deliberately bumping it to
 * the bundled version is also the lever to force a fleet-wide update when an
 * extension-side fix is critical. Must never exceed the bundled manifest
 * version — a test enforces this.
 */
export const BROWSER_EXTENSION_MIN_COMPATIBLE = "0.6.0";

/** Zip entries carry a DOS timestamp; pin it so the bytes are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x2821; // 2020-01-01

let crcTable: Uint32Array | null = null;

function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: Buffer;
  crc: number;
  deflated: Buffer;
  rawSize: number;
  offset: number;
}

function localHeader(entry: Entry): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0); // local file header signature
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(8, 8); // method: deflate
  head.writeUInt16LE(DOS_TIME, 10);
  head.writeUInt16LE(DOS_DATE, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.deflated.length, 18);
  head.writeUInt32LE(entry.rawSize, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28); // extra field length
  return head;
}

function centralHeader(entry: Entry): Buffer {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014b50, 0); // central directory signature
  head.writeUInt16LE(20, 4); // version made by
  head.writeUInt16LE(20, 6); // version needed
  head.writeUInt16LE(0, 8); // flags
  head.writeUInt16LE(8, 10); // method: deflate
  head.writeUInt16LE(DOS_TIME, 12);
  head.writeUInt16LE(DOS_DATE, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.deflated.length, 20);
  head.writeUInt32LE(entry.rawSize, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30); // extra
  head.writeUInt16LE(0, 32); // comment
  head.writeUInt16LE(0, 34); // disk number
  head.writeUInt16LE(0, 36); // internal attrs
  head.writeUInt32LE(0, 38); // external attrs
  head.writeUInt32LE(entry.offset, 42);
  return head;
}

/**
 * A Noah address to add to the manifest's `externally_connectable.matches`.
 * The extension only answers pages whose origin is listed there, and a mismatch
 * fails SILENTLY — `chrome.runtime` is simply undefined on the page, with no
 * error anywhere. Since the download request itself proves which address the
 * operator reaches Noah on, the bundle is stamped with it rather than leaving a
 * manual edit as the last step of every install.
 */
export function matchPatternForOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

/** Manifest bytes with `extraOrigins` merged into externally_connectable. */
function manifestWithOrigins(raw: Buffer, extraOrigins: string[]): Buffer {
  if (!extraOrigins.length) return raw;
  try {
    const manifest = JSON.parse(raw.toString("utf8"));
    const existing: string[] = Array.isArray(manifest?.externally_connectable?.matches)
      ? manifest.externally_connectable.matches
      : [];
    const merged = [...existing];
    for (const pattern of extraOrigins) {
      if (!merged.includes(pattern)) merged.push(pattern);
    }
    manifest.externally_connectable = { ...manifest.externally_connectable, matches: merged };
    return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    // An unparseable manifest is a packaging bug, not a reason to ship a
    // silently unstamped bundle — let the original bytes through and let the
    // install fail visibly in Chrome instead.
    return raw;
  }
}

/**
 * Build the extension zip. Throws when a required file is missing — a partial
 * bundle would install and then fail in ways that are hard to diagnose, so it
 * is better for the download to fail loudly.
 *
 * `prefix` is the in-archive folder. The user-facing download keeps the
 * friendly folder name; a CRX payload passes "" because Chrome requires
 * manifest.json at the archive ROOT.
 */
export function buildBrowserExtensionZip(
  dir: string = BROWSER_EXTENSION_DIR,
  extraOrigins: string[] = [],
  prefix = "noah-browser-bridge/",
): Buffer {
  const chunks: Buffer[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  for (const name of BUNDLE_FILES) {
    const full = path.join(dir, name);
    const onDisk = fs.readFileSync(full);
    const raw = name === "manifest.json" ? manifestWithOrigins(onDisk, extraOrigins) : onDisk;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const entry: Entry = {
      name: Buffer.from(`${prefix}${name}`, "utf8"),
      crc: crc32(raw),
      deflated,
      rawSize: raw.length,
      offset,
    };
    entries.push(entry);
    const head = localHeader(entry);
    chunks.push(head, entry.name, deflated);
    offset += head.length + entry.name.length + deflated.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of entries) {
    const head = centralHeader(entry);
    chunks.push(head, entry.name);
    centralSize += head.length + entry.name.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length
  chunks.push(end);

  return Buffer.concat(chunks);
}

export interface BrowserExtensionFile {
  name: string;
  content: string;
  /** Present on binary entries: `content` is base64, not utf8 text. */
  encoding?: "base64";
}

/**
 * The same bundle as individual files, for the page-driven one-click update:
 * the settings page writes these straight into the user's unpacked-extension
 * folder via File System Access instead of handing over a zip. Same allowlist
 * and origin stamping as the zip. Text files travel as utf8; binary entries
 * (the icons) as base64 with an `encoding` marker — pushing a PNG through a
 * utf8 string corrupts it, and the resulting folder fails to LOAD because the
 * manifest names the icons. Throws on a missing file like the zip does.
 */
export function listBrowserExtensionFiles(
  dir: string = BROWSER_EXTENSION_DIR,
  extraOrigins: string[] = [],
): BrowserExtensionFile[] {
  return BUNDLE_FILES.map((name) => {
    const onDisk = fs.readFileSync(path.join(dir, name));
    if (BINARY_BUNDLE_FILES.has(name)) {
      return { name, content: onDisk.toString("base64"), encoding: "base64" as const };
    }
    const raw = name === "manifest.json" ? manifestWithOrigins(onDisk, extraOrigins) : onDisk;
    return { name, content: raw.toString("utf8") };
  });
}

/**
 * Origins the extension will accept bridge messages from. Shown in the install
 * guide so an operator can tell immediately whether the Noah address they use
 * is covered — a mismatch here is the most likely reason a correct-looking
 * install never connects, and it fails silently.
 */
export function browserExtensionOrigins(dir: string = BROWSER_EXTENSION_DIR): string[] {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const matches = manifest?.externally_connectable?.matches;
    return Array.isArray(matches) ? matches.filter((m: unknown) => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/** The bundled extension's manifest version — the build the server expects installed. */
export function browserExtensionVersion(dir: string = BROWSER_EXTENSION_DIR): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** The pinned extension id, derived from the manifest `key`. Shown in the install guide. */
export function browserExtensionId(dir: string = BROWSER_EXTENSION_DIR): string | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    if (typeof manifest.key !== "string") return null;
    // Chrome derives the id from sha256 of the DER public key: first 16 bytes,
    // each nibble mapped into a-p.
    const der = Buffer.from(manifest.key, "base64");
    const hash = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
    return [...hash].map((c) => String.fromCharCode(parseInt(c, 16) + 97)).join("");
  } catch {
    return null;
  }
}
