// Boot check of the data directory ROOT (#79). Docker copies the image's
// `/app/data` owner into a named volume only when it CREATES the volume, so a
// volume made by an image from before the non-root `node` user (2026-06-13)
// keeps a root-owned root. Files already in it stay usable (the DB is uid 1000),
// so the server answered healthchecks while every NEW subdirectory — backups/
// (the retirement gate), team-brain/, pi-repo-copies/ — failed with EACCES.
// The boot now stops instead, naming the problem and the operator's repair
// (README "Upgrade" → "Data volume ownership"); Noah never repairs it itself.
import fs from "node:fs";
import path from "node:path";

/** The fields of an unwritable data directory root, for the boot's fatal log. */
export interface DataDirNotWritable {
  dataDir: string;
  code: string;
  processUid: number | null;
  ownerUid: number | null;
  ownerGid: number | null;
  mode: string | null;
}

export class DataDirNotWritableError extends Error {
  readonly detail: DataDirNotWritable;

  constructor(detail: DataDirNotWritable) {
    const owner = detail.ownerUid === null ? "unknown owner" : `owner ${detail.ownerUid}:${detail.ownerGid}`;
    super(
      `data directory ${detail.dataDir} is not writable by uid ${detail.processUid ?? "?"} ` +
        `(${owner}, mode ${detail.mode ?? "?"}, ${detail.code}): Noah could not create any new ` +
        `folder in it (backups/, team-brain/, pi-repo-copies/). A data volume created by an image older than ` +
        `the non-root node user keeps a root-owned root — back the volume up, then give its root to uid 1000 ` +
        `as the operator (README.md "Upgrade" → "Data volume ownership").`,
    );
    this.name = "DataDirNotWritableError";
    this.detail = detail;
  }
}

/** Codes that mean "this uid may not create entries here" (not a transient I/O error). */
const NOT_WRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Creates and removes one probe folder in `dataDir` — exactly what every
 * feature that adds a subdirectory does — and throws DataDirNotWritableError
 * when that is refused. Any other error propagates unchanged.
 */
export function assertDataDirWritable(dataDir: string): void {
  let probe: string;
  try {
    probe = fs.mkdtempSync(path.join(dataDir, ".write-probe-"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (!NOT_WRITABLE_CODES.has(code)) {
      throw err;
    }
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dataDir);
    } catch {
      // Unreadable metadata: report what is known.
    }
    throw new DataDirNotWritableError({
      dataDir,
      code,
      processUid: typeof process.getuid === "function" ? process.getuid() : null,
      ownerUid: stat?.uid ?? null,
      ownerGid: stat?.gid ?? null,
      mode: stat ? (stat.mode & 0o7777).toString(8).padStart(4, "0") : null,
    });
  }
  fs.rmdirSync(probe);
}
