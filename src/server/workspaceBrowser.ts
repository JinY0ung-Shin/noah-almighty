/**
 * The host-side reader behind the chat's 파일 tab (`routes/workspaceFiles.ts`):
 * the signed-in user's OWN pi sandbox workspace (`/workspace`), listed one
 * folder at a time and read one file at a time. READ-ONLY by construction —
 * this module creates, writes and removes nothing, so there is no copy to
 * cascade when a conversation or an account goes.
 *
 * Whose workspace: every run of a user's conversation executes as that user
 * (`piRunPrincipal`: the viewer of a chat, the owner of a routine or an API
 * task), so the principal is simply the session's user id. Nothing here takes
 * another id.
 *
 * Everything below the user root is the sandbox's (agent-writable at Noah's
 * uid), so a folder is reached only through a descriptor pinned one segment at
 * a time without following a link, and a file only through that descriptor
 * (`PinnedDir`, docs/architecture/pi-runtime.md "Host-side filesystem
 * discipline"). A link is listed as a link and never opened.
 */
import fs from "node:fs";
import path from "node:path";
import { PI_USER_ID_PATTERN } from "./agent/pi/responsesClient.js";
import { piConversationSegment, piUserSandboxDir } from "./agent/pi/piWorkspace.js";
import type { PinnedDir } from "./pinnedFs.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";
import {
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_SCAN_MAX_ENTRIES,
  parseWorkspacePath,
  type WorkspaceEntry,
  type WorkspaceEntryKind,
  type WorkspaceListing,
} from "../shared/workspaceFiles.js";

/** Whether this deployment can show a user their sandbox workspace (pi runtime with the workspaces mounted). */
export function workspaceBrowserAvailable(config: AppConfig): boolean {
  return config.agentRuntime === "pi" && Boolean(config.pi?.workspacesDir);
}

function usable(config: AppConfig, userId: string): boolean {
  return workspaceBrowserAvailable(config) && PI_USER_ID_PATTERN.test(userId);
}

/**
 * A host file below a user's sandbox root (`hostRoot`) as the path the 파일 tab
 * addresses it by — relative to the root, plain segments — or undefined when
 * it is not below the root or its name is outside the tab's path grammar (a
 * backslash, more than the depth cap). `hostFile` is a REALPATH (what
 * `publishWorkspaceFile` read), so the root is resolved the same way. Only a
 * name: nothing is opened here, and the tab's own routes re-check every
 * segment (pinned, no link followed) when the path is used.
 */
export function workspacePathOfHostFile(hostRoot: string, hostFile: string): string | undefined {
  let root: string;
  try {
    root = fs.realpathSync(hostRoot);
  } catch {
    return undefined;
  }
  const relative = path.relative(root, hostFile);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  const candidate = relative.split(path.sep).join("/");
  return parseWorkspacePath(candidate)?.length ? candidate : undefined;
}

/** The folder of a conversation below the workspace root (`c/<segment>`). */
export function workspaceConversationPath(conversationId: string): string {
  return `c/${piConversationSegment(conversationId)}`;
}

function kindOf(entry: fs.Dirent): WorkspaceEntryKind {
  if (entry.isSymbolicLink()) return "link";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  return "other";
}

const byName = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });

/** What a conversation folder (`c/<segment>`) looks like when Noah named it: a conversation id or its hash. */
const CONVERSATION_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|h-[0-9a-f]{32})$/i;

/**
 * One folder of `userId`'s workspace: folders first, then by name; in `c/` the
 * user's conversations come first, most recently used first, under their
 * titles. The work is bounded whatever the agent put there: at most
 * `WORKSPACE_SCAN_MAX_ENTRIES` entries are read (then `totalIsMinimum`), and
 * only the returned ones are stat'ed. Returns "unavailable" when this deployment has no reachable
 * workspaces, "not_found" when the folder is missing, is not a folder or sits
 * behind a link. The ROOT of a user who never ran anything is an empty listing
 * (`exists: false`), not an error.
 */
export function listWorkspaceFolder(
  config: AppConfig,
  store: Store,
  userId: string,
  segments: readonly string[],
): WorkspaceListing | "unavailable" | "not_found" {
  if (!usable(config, userId)) return "unavailable";
  const path = segments.join("/");
  const dir = piUserSandboxDir(config, userId, segments);
  if (!dir) {
    return segments.length === 0 ? { path, exists: false, entries: [], total: 0, truncated: false } : "not_found";
  }
  try {
    let dirents: fs.Dirent[];
    let more: boolean;
    try {
      ({ entries: dirents, more } = dir.listUpTo(WORKSPACE_SCAN_MAX_ENTRIES));
    } catch {
      return "not_found";
    }
    const conversations = path === "c" ? conversationFolders(store, userId) : null;
    const rank = (name: string): number => conversations?.get(name)?.rank ?? Number.MAX_SAFE_INTEGER;
    const sorted = dirents
      .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
      .sort(
        (a, b) =>
          Number(b.kind === "dir") - Number(a.kind === "dir") ||
          rank(a.name) - rank(b.name) ||
          byName.compare(a.name, b.name),
      );
    const entries = sorted.slice(0, WORKSPACE_LIST_MAX_ENTRIES).map((entry) => describe(dir, entry, conversations));
    return {
      path,
      exists: true,
      entries,
      total: sorted.length,
      ...(more ? { totalIsMinimum: true } : {}),
      truncated: more || sorted.length > entries.length,
    };
  } finally {
    dir.close();
  }
}

interface ConversationFolder {
  id: string;
  title: string;
  rank: number;
}

/** The user's conversations by folder name, ranked most recently used first. */
function conversationFolders(store: Store, userId: string): Map<string, ConversationFolder> {
  const folders = new Map<string, ConversationFolder>();
  store.listConversations(userId, undefined, "all").forEach((conversation, rank) => {
    folders.set(piConversationSegment(conversation.id), { id: conversation.id, title: conversation.title, rank });
  });
  return folders;
}

function describe(
  dir: PinnedDir,
  entry: { name: string; kind: WorkspaceEntryKind },
  conversations: Map<string, ConversationFolder> | null,
): WorkspaceEntry {
  const described: WorkspaceEntry = { name: entry.name, kind: entry.kind };
  // lstat through the pinned folder: a link reports itself, never its target.
  let stat: fs.Stats | undefined;
  try {
    stat = dir.lstat(entry.name);
  } catch {
    stat = undefined; // a name that is not a plain segment once decoded
  }
  if (stat) {
    if (entry.kind === "file") described.size = stat.size;
    if (Number.isFinite(stat.mtimeMs)) described.modifiedAt = new Date(stat.mtimeMs).toISOString();
  }
  if (conversations && entry.kind === "dir") {
    const conversation = conversations.get(entry.name);
    if (conversation) described.conversation = { id: conversation.id, title: conversation.title };
    else if (CONVERSATION_SEGMENT.test(entry.name)) described.orphan = true;
  }
  return described;
}

export interface OpenWorkspaceFile {
  /** Open for reading; the CALLER closes it (a read stream with `autoClose` does). */
  fd: number;
  /** Bytes at the open. */
  size: number;
  name: string;
}

/**
 * A regular file of `userId`'s workspace, opened through its pinned folder
 * (never through a link, at any depth). "unavailable" as in
 * {@link listWorkspaceFolder}; "not_found" for anything that is not a regular
 * file reached by real folders.
 */
export function openWorkspaceFile(
  config: AppConfig,
  userId: string,
  segments: readonly string[],
): OpenWorkspaceFile | "unavailable" | "not_found" {
  if (!usable(config, userId)) return "unavailable";
  const name = segments[segments.length - 1];
  if (!name) return "not_found";
  const dir = piUserSandboxDir(config, userId, segments.slice(0, -1));
  if (!dir) return "not_found";
  try {
    const opened = dir.openFile(name);
    return opened ? { ...opened, name } : "not_found";
  } catch {
    return "not_found";
  } finally {
    dir.close();
  }
}
