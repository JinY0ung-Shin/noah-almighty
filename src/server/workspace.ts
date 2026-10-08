import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.js";

function safeSegment(value: string, fallback: string): string {
  const raw = value.trim() || fallback;
  const readable = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return `${readable}-${hash}`;
}

export function workspaceDirFor(config: AppConfig, avatarId: string, conversationId: string): string {
  return path.join(
    config.dataDir,
    "workspaces",
    safeSegment(avatarId, "avatar"),
    safeSegment(conversationId, "conversation"),
  );
}

/**
 * The folders of a conversation's scratch workspace that SERVER writers fill:
 * staged chat attachments (`chatImages.ts`), browser screenshot copies
 * (`chatFiles.ts`) and Confluence attachments saved with `save_to_workspace`
 * (`agent/confluenceTools.ts`).
 */
export const SERVER_WORKSPACE_COPY_DIRS = ["attachments", "captures", "confluence"] as const;

/** A real directory at `target` (never a link to one), or false. */
function isRealDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

/** Remove `target` without following it: a real folder recursively, a link or file by unlink. */
function removeWithoutFollowing(target: string): void {
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return; // nothing there
    if (stat.isDirectory()) {
      // Never follows a link INSIDE the tree either: rm unlinks a symlink entry.
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target);
    }
  } catch {
    // Best effort, like the other per-conversation sweeps.
  }
}

/**
 * Remove the SERVER-WRITTEN copies of deleted conversations — the
 * {@link SERVER_WORKSPACE_COPY_DIRS} folders of each one's scratch workspace —
 * and nothing else: the rest of the workspace (the agent's own work files) stays
 * until its avatar's whole tree is deleted, a separate decision.
 *
 * A workspace lives at `workspaces/<avatarSeg>/<conversationSeg>`, and the
 * avatar segment is the THREAD's avatar: a colleague's conversation with
 * someone else's avatar lives under THAT avatar's tree, as do group-agent
 * threads under their composite ids. The conversation segment is
 * derived from the id alone, so each id is resolved under EVERY avatar folder
 * rather than under the deleter's own. No link is ever followed: a symlinked
 * avatar or workspace folder is skipped, and a symlink (or file) carrying one of
 * the copy folders' names is unlinked, never recursed into. Best-effort like
 * `deleteConversationImages`; it never throws.
 */
export function deleteConversationWorkspaceCopies(
  config: AppConfig,
  conversationIds: readonly string[],
): void {
  if (conversationIds.length === 0) return;
  const root = path.join(config.dataDir, "workspaces");
  let avatarDirs: fs.Dirent[];
  try {
    avatarDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // no workspace tree yet
  }
  const segments = new Set(conversationIds.map((id) => safeSegment(id, "conversation")));
  for (const avatarDir of avatarDirs) {
    // readdir's own entry type: a symlinked avatar folder is not a directory here.
    if (!avatarDir.isDirectory()) continue;
    const avatarPath = path.join(root, avatarDir.name);
    // One probe per avatar folder for a single delete; a bulk or account
    // delete lists each avatar folder once instead of probing every id there.
    let candidates: Iterable<string> = segments;
    if (segments.size > 1) {
      try {
        candidates = fs.readdirSync(avatarPath).filter((name) => segments.has(name));
      } catch {
        continue;
      }
    }
    for (const segment of candidates) {
      const workspace = path.join(avatarPath, segment);
      if (!isRealDirectory(workspace)) continue;
      for (const name of SERVER_WORKSPACE_COPY_DIRS) {
        removeWithoutFollowing(path.join(workspace, name));
      }
    }
  }
}
