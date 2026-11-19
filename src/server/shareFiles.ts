import fs from "node:fs";
import path from "node:path";
import { MAX_CHAT_FILE_BYTES, isShareFileExtension, shareFileMediaType } from "./chatFiles.js";
import { openWorkspaceFile } from "./workspaceBrowser.js";
import { WORKSPACE_UPLOADS_FOLDER } from "../shared/shareLinks.js";
import type { AppConfig } from "./types.js";

/**
 * The copy store of WORKSPACE-FILE share links (`shareLinks.ts`): when the
 * owner shares a file from the chat's 파일 tab, Noah copies its bytes here —
 * `<dataDir>/share-files/<link id>/file.<ext>` — and the link serves that copy,
 * never the workspace path (the agent keeps rewriting its workspace; what was
 * shared must not change under the recipient, and a link must never become a
 * window into a sandbox).
 *
 * A copy lives exactly as long as its link is live: {@link sweepShareFileCopies}
 * removes every folder whose link id is not an unexpired row, so a revoke, an
 * expiry, the global prune and a deleted owner all end the bytes without each
 * needing its own delete. The ROW is written before its copy (a row without
 * bytes simply does not open), so the sweep can never take a copy that is
 * about to get its row.
 */

/** A link id as a folder name: the lowercase uuid the service mints. */
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function shareFilesDir(config: AppConfig): string {
  return path.join(config.dataDir, "share-files");
}

export type WorkspaceShareRefusal =
  | "UNAVAILABLE"
  | "NOT_FOUND"
  | "EMPTY"
  | "TOO_LARGE"
  | "UNSUPPORTED"
  | "UPLOADED"
  | "READ_FAILED";

export type WorkspaceShareSource =
  | { buffer: Buffer; ext: string; mediaType: string; name: string }
  | { error: WorkspaceShareRefusal };

/**
 * Read one file of `userId`'s OWN workspace for sharing: opened through its
 * pinned folders (`openWorkspaceFile` — never through a link, at any depth),
 * judged like share_file judges a file it publishes — a type share_file takes,
 * within the same size cap, its content matching its extension. A document the
 * user ATTACHED (`uploads/`, where pi writes it — on a DRM fleet a decrypted
 * copy) is refused like an `uploaded` card is: a link exports what the avatar
 * made, never what the user sent in. Read-only: the workspace is never written.
 */
export function readWorkspaceShareSource(
  config: AppConfig,
  userId: string,
  segments: readonly string[],
): WorkspaceShareSource {
  const name = segments[segments.length - 1] ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  // Before anything is opened: what no link serves is refused by where it sits and by its name.
  if (segments[0] === WORKSPACE_UPLOADS_FOLDER) return { error: "UPLOADED" };
  if (!isShareFileExtension(ext)) return { error: "UNSUPPORTED" };
  const opened = openWorkspaceFile(config, userId, segments);
  if (opened === "unavailable") return { error: "UNAVAILABLE" };
  if (opened === "not_found") return { error: "NOT_FOUND" };
  try {
    if (opened.size === 0) return { error: "EMPTY" };
    if (opened.size > MAX_CHAT_FILE_BYTES) return { error: "TOO_LARGE" };
    // Exactly the bytes counted at the open: a file the agent is appending to
    // ends there, and one it cut short is not shared half-read.
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < opened.size) {
      const n = fs.readSync(opened.fd, buffer, read, opened.size - read, read);
      if (n <= 0) return { error: "READ_FAILED" };
      read += n;
    }
    const mediaType = shareFileMediaType(ext, buffer);
    return mediaType ? { buffer, ext, mediaType, name } : { error: "UNSUPPORTED" };
  } catch {
    return { error: "READ_FAILED" };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Write a link's copy. False when it could not be written (the caller then drops the row). */
export function writeShareFileCopy(config: AppConfig, linkId: string, ext: string, buffer: Buffer): boolean {
  if (!LINK_ID.test(linkId) || !isShareFileExtension(ext)) return false;
  const dir = path.join(shareFilesDir(config), linkId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `file.${ext}`), buffer, { flag: "wx" });
    return true;
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return false;
  }
}

/** A link's copy on disk, or null: no such link folder, or nothing in it a link serves. */
export function resolveShareFileCopy(
  config: AppConfig,
  linkId: string,
): { path: string; mediaType: string; ext: string } | null {
  if (!LINK_ID.test(linkId)) return null;
  const dir = path.join(shareFilesDir(config), linkId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.startsWith("file.")) continue;
    const ext = entry.slice("file.".length).toLowerCase();
    if (!isShareFileExtension(ext)) continue;
    const filePath = path.join(dir, entry);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile()) continue;
      // Its extension's media type: the content was checked when the copy was taken.
      const mediaType = shareFileMediaType(ext);
      if (mediaType) return { path: filePath, mediaType, ext };
    } catch {
      continue;
    }
  }
  return null;
}

/** Remove one link's copy (a revoke). Missing is fine. */
export function removeShareFileCopy(config: AppConfig, linkId: string): void {
  if (!LINK_ID.test(linkId)) return;
  fs.rmSync(path.join(shareFilesDir(config), linkId), { recursive: true, force: true });
}

/**
 * Remove every copy whose link is not live — `liveLinkIds` are the unexpired
 * workspace-file rows (`store.listLiveWorkspaceShareLinkIds`). Only folders
 * named like a link id are touched; anything else in the store is left alone.
 * Returns how many were removed.
 */
export function sweepShareFileCopies(config: AppConfig, liveLinkIds: readonly string[]): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(shareFilesDir(config));
  } catch {
    return 0;
  }
  const live = new Set(liveLinkIds);
  let removed = 0;
  for (const entry of entries) {
    if (!LINK_ID.test(entry) || live.has(entry)) continue;
    try {
      fs.rmSync(path.join(shareFilesDir(config), entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left for the next sweep.
    }
  }
  return removed;
}
