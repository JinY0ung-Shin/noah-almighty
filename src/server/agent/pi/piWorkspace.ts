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
 * of the user's root: a sandbox process can plant one.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentImageFileInput, AppConfig } from "../../types.js";

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
 * Create the conversation folder (0700, like pi's own dirs) when Noah can reach
 * the workspaces. Best effort: a missing mount only means Noah cannot stage
 * files — the model can still `mkdir -p` the folder itself.
 */
export function ensurePiConversationDir(workspace: PiWorkspace): boolean {
  if (!workspace.hostConversationDir || !workspace.hostRoot) return false;
  try {
    fs.mkdirSync(workspace.hostConversationDir, { recursive: true, mode: 0o700 });
    return isInsideRealRoot(workspace.hostRoot, workspace.hostConversationDir);
  } catch {
    return false;
  }
}

/**
 * Copy this turn's staged attachment files into the conversation folder's
 * `attachments/` and return them with their SANDBOX paths (what the prompt
 * lists). Files that cannot be copied are dropped from the listing rather than
 * named at a path the model could not open. Minimal I1 staging: lane I2 moves
 * the route's staging itself into the sandbox folder.
 */
export function stagePiAttachmentFiles(workspace: PiWorkspace, files: AgentImageFileInput[]): AgentImageFileInput[] {
  if (!files.length || !ensurePiConversationDir(workspace)) return [];
  const targetDir = path.join(workspace.hostConversationDir!, "attachments");
  const staged: AgentImageFileInput[] = [];
  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch {
    return [];
  }
  for (const file of files) {
    const name = path.basename(file.path);
    const target = path.join(targetDir, name);
    try {
      const stat = fs.lstatSync(file.path);
      if (!stat.isFile()) continue;
      // Never write THROUGH a link the sandbox may have left at the target.
      fs.rmSync(target, { force: true });
      fs.copyFileSync(file.path, target, fs.constants.COPYFILE_EXCL);
      staged.push({ ...file, path: path.posix.join(workspace.conversationDir, "attachments", name) });
    } catch {
      /* best effort — see above */
    }
  }
  return staged;
}
