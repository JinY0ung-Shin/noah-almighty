import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AvatarDetail,
  AvatarSummary,
  GroupAgent,
  GroupRole,
} from "./types.js";
import { groupKnowledgeClonePath } from "./groupKnowledgeRepo.js";
import { workspaceDirFor } from "./workspace.js";
import type { Store } from "./store.js";

/**
 * Group shared-agent helpers (id namespace, reach gate, wire projections) for
 * the non-users avatar kind. A group agent runs the full local SDK stack; these
 * helpers cover only identity + discovery/reach, never the run itself.
 */

/** Namespaced public avatar id prefix — `group:<groupId>:<agentId>`. */
export const GROUP_AGENT_AVATAR_PREFIX = "group:";

export function groupAgentAvatarId(groupId: string, agentId: string): string {
  return `${GROUP_AGENT_AVATAR_PREFIX}${groupId}:${agentId}`;
}

export interface GroupAgentRef {
  groupId: string;
  agentId: string;
}

/**
 * Parse `group:<groupId>:<agentId>`; null on anything else — including the
 * pre-multi `group:<groupId>` form, which the store migration rewrote out of
 * every conversation (a stale client id simply fails closed as not-found).
 */
export function parseGroupAgentRef(avatarId: string): GroupAgentRef | null {
  if (!avatarId.startsWith(GROUP_AGENT_AVATAR_PREFIX)) return null;
  const rest = avatarId.slice(GROUP_AGENT_AVATAR_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const groupId = rest.slice(0, sep);
  const agentId = rest.slice(sep + 1);
  if (!groupId || !agentId || agentId.includes(":")) return null;
  return { groupId, agentId };
}

/**
 * Whether `role` may CAPTURE (write + commit) to the shared second brain
 * through the group agent — the ONE derivation of the capture_scope policy.
 * Direct `mcp__group_repo__` writes from personal-avatar runs stay admin-only
 * regardless; this governs group-agent runs only.
 */
export function groupAgentCaptureAllowed(
  agent: Pick<GroupAgent, "captureScope">,
  role: GroupRole,
): boolean {
  return agent.captureScope === "members" || role === "admin";
}

export interface ChattableGroupAgent {
  agent: GroupAgent;
  groupId: string;
  groupName: string;
  viewerRole: GroupRole;
}

/**
 * THE single reach gate for group agents, used by detail/skills/chat/
 * image alike: ref parse → agent exists in THAT group → enabled → viewer is a
 * member of the owning group. Fails closed (null) on every miss — non-members
 * get the same not-found/forbidden shape as an unknown avatar (no existence
 * leak). Reach is MEMBERSHIP-only: the group's avatar-sharing policy does not
 * apply (a knowledge-sharing-only group still reaches its shared agents), and
 * system admins do NOT bypass membership.
 *
 * `includeDisabled` lets the chat route distinguish member-visible "disabled"
 * (dedicated 403 message) from not-found; discovery/read surfaces omit it.
 */
export function findChattableGroupAgent(
  store: Store,
  viewerId: string,
  avatarId: string,
  opts: { includeDisabled?: boolean } = {},
): ChattableGroupAgent | null {
  const ref = parseGroupAgentRef(avatarId);
  if (!ref) return null;
  const agent = store.getGroupAgentById(ref.agentId);
  if (!agent || agent.groupId !== ref.groupId) return null;
  if (!agent.enabled && !opts.includeDisabled) return null;
  const viewerRole = store.groupRoleFor(viewerId, ref.groupId);
  if (!viewerRole) return null;
  const group = store.getGroup(ref.groupId);
  if (!group) return null;
  return { agent, groupId: ref.groupId, groupName: group.name, viewerRole };
}

export function groupAgentAvatarSummary(
  agent: GroupAgent,
  groupName: string,
): AvatarSummary {
  return {
    id: groupAgentAvatarId(agent.groupId, agent.id),
    username: `group-agent-${agent.id.slice(0, 8)}`,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    hashtags: [...agent.hashtags],
    hasImage: agent.hasImage,
    pluginCount: 0,
    // Member-only reach — "group" is exact, not a compromise.
    visibility: "group",
    updatedAt: null,
    sharesGroup: false,
    groupAgent: { groupId: agent.groupId, groupName },
  };
}

export function groupAgentAvatarDetail(
  agent: GroupAgent,
  groupName: string,
): AvatarDetail {
  return {
    ...groupAgentAvatarSummary(agent, groupName),
    persona: agent.persona,
    intro: agent.intro,
    isOwn: false,
    // Members run the elevated tool class on group-agent runs (workspace
    // Bash/Edit work); owner-only tools never register. Hides the read-only chip.
    elevated: true,
    plugins: [],
  };
}

export function listGroupAgentAvatarSummaries(
  store: Store,
  viewerId: string,
): AvatarSummary[] {
  return store
    .listGroupAgentsForUser(viewerId)
    .map(({ agent, groupName }) => groupAgentAvatarSummary(agent, groupName))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** The agent's per-conversation workspace parent (safeSegment of its avatar id). */
export function groupAgentWorkspaceParent(
  config: AppConfig,
  avatarId: string,
): string {
  // workspaceDirFor is per-conversation; its parent is the agent's tree.
  return path.dirname(workspaceDirFor(config, avatarId, "x"));
}

/**
 * Best-effort disk cleanup for a DELETED group, called by the admin route
 * AFTER `store.deleteGroup`'s transaction: the group-knowledge clone (a
 * pre-existing leak — possibly a private repo's full clone) and every agent's
 * chat workspaces (avatar ids snapshotted BEFORE the cascade — the rows are
 * gone by now). Profile-image FILES are the route's job (it has the image
 * helpers). A concurrent run holding the repo lock surfaces a tool error and
 * re-clones nothing — the group row is already gone.
 */
export function cleanupGroupDataDirs(
  config: AppConfig,
  groupId: string,
  agentAvatarIds: string[],
): void {
  const targets = [
    groupKnowledgeClonePath(groupId, config),
    ...agentAvatarIds.map((id) => groupAgentWorkspaceParent(config, id)),
  ];
  for (const dir of targets) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Startup sweep for the multi-agent migration's ON-DISK half: the store
 * rebuild renamed every conversation binding to `group:<gid>:<aid>`, but the
 * profile-image file and the workspace tree are keyed by the avatar id in
 * their names and live outside the DB. Rename them once, legacy → canonical.
 * Idempotent: renames only while a legacy-named artifact exists and the
 * canonical one doesn't; after the first boot the legacy names are gone.
 * (Right after migration every group has exactly one agent, so the mapping is
 * unambiguous; agents created later never have legacy artifacts.)
 */
export function migrateGroupAgentDiskArtifacts(
  store: Store,
  config: AppConfig,
  avatarsDir: string,
): void {
  for (const agent of store.listAllGroupAgents()) {
    const legacyId = `${GROUP_AGENT_AVATAR_PREFIX}${agent.groupId}`;
    const canonicalId = groupAgentAvatarId(agent.groupId, agent.id);
    // Workspace tree.
    const legacyDir = groupAgentWorkspaceParent(config, legacyId);
    const canonicalDir = groupAgentWorkspaceParent(config, canonicalId);
    if (fs.existsSync(legacyDir) && !fs.existsSync(canonicalDir)) {
      fs.renameSync(legacyDir, canonicalDir);
    }
    // Profile-image file (bytes on disk, ext on the row).
    const ext = store.getGroupAgentImageExtByAvatarId(canonicalId);
    if (ext) {
      const legacyFile = path.join(avatarsDir, `${legacyId}.${ext}`);
      const canonicalFile = path.join(avatarsDir, `${canonicalId}.${ext}`);
      if (fs.existsSync(legacyFile) && !fs.existsSync(canonicalFile)) {
        fs.renameSync(legacyFile, canonicalFile);
      }
    }
  }
}
