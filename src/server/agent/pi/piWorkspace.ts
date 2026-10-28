/**
 * Where a pi run's files live (design §2 / N4).
 *
 * pi-gateway mounts `$PI_GATEWAY_HOME/workspaces/u-<sha256(user)[:24]>` at
 * `/workspace` in the user's sandbox. The principal (`user`) is the Noah user
 * id of whoever the run executes AS — the viewer (design U4) — so one user's
 * conversations share one sandbox and never see anyone else's. Inside it, Noah
 * gives each conversation its own folder, `/workspace/c/<conversation segment>`,
 * which the prompt names as the place to work (pi has no per-session cwd yet).
 *
 * Noah reaches the same bytes through `PI_WORKSPACES_DIR` (same host, same uid
 * 1000 — design D6). This module is the ONE mapping between the two views and
 * the seam lane I2 builds on (attachment staging, captures, Confluence saves,
 * show_file/share_file translation, cascades). It never follows a symlink out
 * of the user's root: a sandbox process can plant one. Every host-side WRITE,
 * listing or removal below the user root goes through a descriptor-pinned
 * folder (`pinnedFs.ts`, {@link piSandboxDir}) — never through a path whose
 * agent-controlled components are resolved by name.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentImageFileInput, AppConfig } from "../../types.js";
import { PinnedDir, withPinnedDir } from "../../pinnedFs.js";

/** The sandbox mount point (pi `SANDBOX_WORKSPACE`). */
export const PI_SANDBOX_ROOT = "/workspace";

/** pi's per-user directory name: `u-` + the first 24 hex chars of sha256(user). */
export function piUserKey(principal: string): string {
  return `u-${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * A conversation id as a path segment. Noah's ids are UUIDs and pass through;
 * anything else is hashed so it can never carry `/`, `..` or odd bytes.
 */
export function piConversationSegment(conversationId: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(conversationId)
    ? conversationId
    : `h-${createHash("sha256").update(conversationId, "utf8").digest("hex").slice(0, 32)}`;
}

export interface PiWorkspace {
  principal: string;
  /** `/workspace/c/<seg>` — what the model is told. */
  conversationDir: string;
  /** Host path of the user's `/workspace`, when `PI_WORKSPACES_DIR` is configured. */
  hostRoot?: string;
  /** Host path of the conversation folder, when `PI_WORKSPACES_DIR` is configured. */
  hostConversationDir?: string;
}

export function piWorkspaceFor(config: AppConfig, principal: string, conversationId: string): PiWorkspace {
  const segment = piConversationSegment(conversationId);
  const conversationDir = path.posix.join(PI_SANDBOX_ROOT, "c", segment);
  const workspacesDir = config.pi?.workspacesDir;
  if (!workspacesDir) return { principal, conversationDir };
  const hostRoot = path.join(workspacesDir, piUserKey(principal));
  return { principal, conversationDir, hostRoot, hostConversationDir: path.join(hostRoot, "c", segment) };
}

/**
 * Sandbox path → host path, or null when it leaves the user's workspace. Lexical
 * check plus a realpath check of the deepest EXISTING ancestor, so a symlink the
 * sandbox planted cannot point Noah at a host file outside the user's root.
 */
export function piHostPath(workspace: PiWorkspace, sandboxPath: string): string | null {
  if (!workspace.hostRoot) return null;
  const normalized = path.posix.normalize(sandboxPath);
  if (normalized !== PI_SANDBOX_ROOT && !normalized.startsWith(`${PI_SANDBOX_ROOT}/`)) return null;
  const relative = normalized.slice(PI_SANDBOX_ROOT.length).replace(/^\/+/, "");
  if (relative.split("/").includes("..")) return null;
  const candidate = path.join(workspace.hostRoot, ...relative.split("/").filter(Boolean));
  return isInsideRealRoot(workspace.hostRoot, candidate) ? candidate : null;
}

/** Host path → sandbox path, or null when it is not under the user's workspace. */
export function piSandboxPath(workspace: PiWorkspace, hostPath: string): string | null {
  if (!workspace.hostRoot) return null;
  const relative = path.relative(workspace.hostRoot, path.resolve(hostPath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative ? path.posix.join(PI_SANDBOX_ROOT, ...relative.split(path.sep)) : PI_SANDBOX_ROOT;
}

function isInsideRealRoot(root: string, candidate: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // No root yet: nothing under it can be a planted link either.
    return path.relative(root, candidate).split(path.sep)[0] !== "..";
  }
  let probe = candidate;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const relative = path.relative(realRoot, real);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

/**
 * The user's root (`u-<key>`) pinned, created 0700 when missing. Its PARENT is
 * the operator's `PI_WORKSPACES_DIR` (trusted, followed as configured); the
 * root itself and everything below it are the sandbox's, so they are only
 * ever reached through {@link PinnedDir}.
 */
function pinnedUserRoot(workspace: PiWorkspace, create: boolean): PinnedDir | null {
  if (!workspace.hostRoot) return null;
  const workspacesDir = path.dirname(workspace.hostRoot);
  if (create) {
    try {
      fs.mkdirSync(workspacesDir, { recursive: true });
    } catch {
      return null;
    }
  }
  return PinnedDir.openBelow(workspacesDir, [path.basename(workspace.hostRoot)], { create, mode: 0o700 });
}

/**
 * A folder below the user's sandbox root (`rel`: plain segments, e.g.
 * `["c", seg, "attachments"]`), pinned by descriptor with no link followed
 * anywhere below the root; missing segments are created (`mode`) with
 * `create`. Null when the mount is not configured or any segment is a link or
 * not a folder. The caller closes it.
 */
export function piSandboxDir(
  workspace: PiWorkspace,
  rel: readonly string[],
  options: { create?: boolean; mode?: number } = {},
): PinnedDir | null {
  return withPinnedDir(pinnedUserRoot(workspace, options.create ?? false), (root) => root?.dir(rel, options) ?? null);
}

/** `c/<seg>` of the workspace as segments. */
function conversationSegments(workspace: PiWorkspace): string[] {
  return ["c", path.posix.basename(workspace.conversationDir)];
}

/**
 * Create the conversation folder (0700, like pi's own dirs) when Noah can reach
 * the workspaces, refusing when `c` or the folder itself is a link or a file the
 * sandbox planted. Best effort: a missing mount only means Noah cannot stage
 * files — the model can still `mkdir -p` the folder itself.
 */
export function ensurePiConversationDir(workspace: PiWorkspace): boolean {
  if (!workspace.hostConversationDir || !workspace.hostRoot) return false;
  return withPinnedDir(piSandboxDir(workspace, conversationSegments(workspace), { create: true, mode: 0o700 }), Boolean);
}

/**
 * List this turn's staged attachment files by their SANDBOX paths (what the
 * prompt names). On a pi run the chat route stages straight into the
 * conversation folder's `attachments/` (its workspace dir IS that folder), so
 * each file maps without a copy. A file staged anywhere else (an older caller)
 * is copied in as a fallback; files that can neither map nor copy are dropped
 * from the listing rather than named at a path the model could not open.
 */
export function stagePiAttachmentFiles(workspace: PiWorkspace, files: AgentImageFileInput[]): AgentImageFileInput[] {
  if (!files.length || !ensurePiConversationDir(workspace)) return [];
  const staged: AgentImageFileInput[] = [];
  let targetDir: PinnedDir | null | undefined;
  try {
    for (const file of files) {
      const mapped = piSandboxPath(workspace, file.path);
      if (mapped && piHostPath(workspace, mapped) === path.resolve(file.path)) {
        staged.push({ ...file, path: mapped });
        continue;
      }
      const name = path.basename(file.path);
      targetDir ??= piSandboxDir(workspace, [...conversationSegments(workspace), "attachments"], { create: true, mode: 0o700 });
      if (!targetDir) break;
      try {
        const stat = fs.lstatSync(file.path);
        if (!stat.isFile()) continue;
        // Never write THROUGH a link the sandbox may have left at the target.
        targetDir.remove(name);
        targetDir.copyFileIn(file.path, name);
        staged.push({ ...file, path: path.posix.join(workspace.conversationDir, "attachments", name) });
      } catch {
        /* best effort — see above */
      }
    }
  } finally {
    targetDir?.close();
  }
  return staged;
}

/**
 * A path a MODEL handed a Noah tool (show_file, share_file, copy_image) → the
 * host path Noah reads. The model lives in the sandbox, so a path means what
 * pi's own tools make of it: absolute under `/workspace`, or relative to the
 * shell's start folder `/workspace`. Anything else (`/tmp/x`, a path out of
 * the user's workspace, a planted link) is refused with an English redirect —
 * Noah can only reach the user's `/workspace`. Containment of the final file
 * (realpath) is the publisher's own check on top of this.
 */
export function piToolPathToHost(
  workspace: PiWorkspace,
  inputPath: string,
): { hostPath: string } | { error: string } {
  const raw = inputPath.trim();
  if (!workspace.hostRoot) {
    return { error: "This run cannot reach sandbox files from Noah (the workspace mount is not configured); put the content in your reply instead." };
  }
  const sandboxPath = raw.startsWith("/") ? raw : path.posix.join(PI_SANDBOX_ROOT, raw);
  const hostPath = piHostPath(workspace, sandboxPath);
  if (!hostPath) {
    return {
      error:
        `Noah can only read files under ${PI_SANDBOX_ROOT} in your sandbox, and '${raw}' is not there (or leaves it through a link). ` +
        `Copy the file into this conversation's folder ${workspace.conversationDir}/ with bash, then retry with that absolute path.`,
    };
  }
  return { hostPath };
}

/** Caps of the D3 move of a pre-pi conversation workspace (bytes, entries, depth). */
const LEGACY_MOVE_MAX_BYTES = 256 * 1024 * 1024;
const LEGACY_MOVE_MAX_ENTRIES = 10_000;
const LEGACY_MOVE_MAX_DEPTH = 16;
/** Written into the OLD folder once its files moved, so later turns skip the walk. */
export const LEGACY_MOVED_MARKER = ".noah-moved-to-pi";

export interface LegacyMoveResult {
  moved: number;
  skipped: number;
  /** True when this call did nothing because the marker (or no old folder) said so. */
  alreadyDone: boolean;
}

/**
 * D3: on a conversation's first pi turn, move the files its SDK-era scratch
 * workspace (`dataDir/workspaces/<avatar>/<conv>`) holds into the sandbox
 * conversation folder, so a thread that switched runtimes keeps its work.
 * Best effort and idempotent: links and special files are never followed or
 * moved (left behind and counted), an existing file in the sandbox is never
 * overwritten (the old one stays), the walk stops at a size/entry cap (the
 * rest stays in the old folder), and a marker in the old folder makes later
 * turns skip it. Moved files are removed from the old folder; folders left
 * empty go too. Never throws.
 */
export function moveLegacyConversationWorkspace(legacyDir: string, workspace: PiWorkspace): LegacyMoveResult {
  const result: LegacyMoveResult = { moved: 0, skipped: 0, alreadyDone: true };
  if (!workspace.hostConversationDir) return result;
  try {
    const top = fs.lstatSync(legacyDir, { throwIfNoEntry: false });
    if (!top?.isDirectory()) return result;
    if (fs.existsSync(path.join(legacyDir, LEGACY_MOVED_MARKER))) return result;
  } catch {
    return result;
  }
  const destination = piSandboxDir(workspace, conversationSegments(workspace), { create: true, mode: 0o700 });
  if (!destination) return result;
  result.alreadyDone = false;
  let bytes = 0;
  let entries = 0;
  let capped = false;
  // `to` is the pinned sandbox folder: the legacy side is read by name (Noah's
  // data dir), the sandbox side only ever through descriptors.
  const walk = (from: string, to: PinnedDir, depth: number): void => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      if (capped) return;
      if (depth === 0 && entry.name === LEGACY_MOVED_MARKER) continue;
      entries += 1;
      if (entries > LEGACY_MOVE_MAX_ENTRIES) {
        capped = true;
        return;
      }
      const source = path.join(from, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(source);
      } catch {
        result.skipped += 1;
        continue;
      }
      if (stat.isDirectory()) {
        if (depth + 1 > LEGACY_MOVE_MAX_DEPTH) {
          result.skipped += 1;
          continue;
        }
        const target = to.dir([entry.name], { create: true, mode: 0o700 });
        if (!target) {
          result.skipped += 1; // a file or a link there: never written through
          continue;
        }
        try {
          walk(source, target, depth + 1);
        } finally {
          target.close();
        }
        try {
          fs.rmdirSync(source); // only when now empty
        } catch {
          /* something stayed behind */
        }
        continue;
      }
      if (!stat.isFile()) {
        result.skipped += 1; // links, sockets, devices stay where they are
        continue;
      }
      if (bytes + stat.size > LEGACY_MOVE_MAX_BYTES) {
        capped = true;
        return;
      }
      try {
        to.copyFileIn(source, entry.name, stat.mode & 0o111 ? 0o755 : 0o644);
        fs.unlinkSync(source);
        bytes += stat.size;
        result.moved += 1;
      } catch {
        result.skipped += 1; // EEXIST in the sandbox, or a read/write failure
      }
    }
  };
  try {
    walk(legacyDir, destination, 0);
  } finally {
    destination.close();
  }
  if (!capped) {
    try {
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, LEGACY_MOVED_MARKER), `${new Date().toISOString()}\n`);
    } catch {
      /* the next turn simply walks again */
    }
  }
  return result;
}

/**
 * Remove the SERVER-WRITTEN copies (`copyDirs`) of deleted conversations from
 * every user's sandbox workspace — the pi half of
 * `deleteConversationWorkspaceCopies`. A conversation's sandbox principal is
 * whoever ran it, so each id is resolved under EVERY `u-*` folder (like the SDK
 * half resolves it under every avatar folder). No link is ever followed: a
 * linked user/`c`/conversation folder is skipped and a link named like a copy
 * folder is unlinked — every step through a pinned descriptor, so a link
 * swapped in mid-sweep is never descended. Best effort; never throws.
 */
export function deletePiConversationCopies(
  workspacesDir: string | undefined,
  conversationIds: readonly string[],
  copyDirs: readonly string[],
): void {
  if (!workspacesDir || conversationIds.length === 0) return;
  withPinnedDir(PinnedDir.open(workspacesDir), (top) => {
    if (!top) return;
    let users: fs.Dirent[];
    try {
      users = top.list();
    } catch {
      return;
    }
    const segments = conversationIds.map(piConversationSegment);
    for (const user of users) {
      if (!user.isDirectory() || !user.name.startsWith("u-")) continue;
      withPinnedDir(top.dir([user.name, "c"]), (conversations) => {
        if (!conversations) return;
        for (const segment of segments) {
          withPinnedDir(conversations.dir([segment]), (folder) => {
            for (const name of copyDirs) folder?.remove(name);
          });
        }
      });
    }
  });
}

/** Remove a deleted user's WHOLE sandbox workspace (account deletion), never following a link inside it. Best effort. */
export function deletePiUserWorkspace(config: AppConfig, userId: string): void {
  const workspacesDir = config.pi?.workspacesDir;
  if (!workspacesDir) return;
  withPinnedDir(PinnedDir.open(workspacesDir), (top) => top?.remove(piUserKey(userId)));
}

/**
 * Remove `target` without following its LAST component: a real folder
 * recursively, anything else by unlink. Only for paths whose every ancestor is
 * Noah's own (data dir records); anything below a sandbox root goes through
 * {@link piSandboxDir} / `PinnedDir.remove` instead.
 */
export function removeNoFollow(target: string): void {
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
  } catch {
    /* best effort */
  }
}
