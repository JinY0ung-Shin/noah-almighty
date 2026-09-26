/**
 * Run-plan assembly for a Claude Agent SDK turn.
 *
 * `runClaudeAgent` used to do this inline: ~1000 lines of pure derivation ahead
 * of its ~400-line streaming loop. The two halves share no mutable state — the
 * setup half declares NO `let` at all — so it lives here as one function that
 * returns the plan the loop consumes. Split behind unchanged exports:
 * `claudeAgent.ts` re-exports every helper that moved with it, so existing
 * import paths (app.ts, the agent-core/agent-tools/group-agent/infra/store
 * suites) resolve against that module unchanged.
 *
 * ONE thing flows backwards. File-output and browser-screenshot attachments are
 * stamped with the length of the assistant text accumulated when the tool ran,
 * and that accumulator lives in the run loop AND is REASSIGNED there on the
 * empty-turn retry. So it arrives as `currentTextAnchor()` — an accessor read
 * at call time. Passing the array itself would silently stamp against a stale
 * binding after a retry.
 *
 * `options` is returned as a live object the loop still mutates (systemPrompt,
 * model, resume) — same object identity as before the split, on purpose.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AppConfig,
  AgentRequest,
  AgentOwner,
  PluginRoot,
} from "../types.js";
import type { Store } from "../store.js";
import { CLAUDE_OAUTH_TOKEN_KEY } from "../store.js";
import type { AgentEvents, FileOutputResult } from "./events.js";
import {
  deckAuthoringStatusFor,
  probeDeckRendering,
  probeDeckToolchain,
} from "../deckRender.js";
import { visionForModel } from "../modelVisionPolicy.js";
import { readWorkspaceImage } from "../chatImages.js";
import {
  stageClipboardImage as stageClipboardImageBytes,
  stageClipboardText as stageClipboardTextBytes,
} from "../browserClipboard.js";
import logger from "../logger.js";
import { knownHostsPath } from "../sshTrust.js";
import {
  GIT_CREDENTIAL_ENV_NAMES,
  SSH_MCP_SECRET_ENV_NAMES,
} from "../secretPolicy.js";
import {
  HEX_SSH_SERVER_NAME,
  allowedHexSshToolsForViewer,
  viewerClassForAgentRequest,
  type HexSshViewerClass,
} from "../hexSshPolicy.js";
import {
  isModelTier,
  DEFAULT_MODEL_TIER,
  MODEL_TIER_IDS,
} from "../modelTiers.js";
import { isEffortLevel } from "../effortLevels.js";
import { liftPluginMcpServers } from "../plugins.js";
import { knowledgeClonePath } from "../knowledgeRepo.js";
import { personalAgentMemoryRoot } from "../personalAgents.js";
import {
  emptyOwnerState,
  summarizeGroupAgentState,
  summarizeOwnerState,
  summarizePersonalAgentState,
} from "./ownerState.js";
import {
  buildPreToolUseHook,
  TASK_ORCHESTRATION_TOOLS,
} from "./preToolUseHook.js";
import { buildPostToolUseHook } from "./postToolUseHook.js";
import { PROMPT_TTL_MS } from "./runRegistry.js";
import {
  DEFAULT_MCP_TOOL_GROUPS,
  effectiveMcpToolGroups,
  type McpToolGroupId,
} from "../../shared/mcpToolGroups.js";
import {
  SDK_ELEVATED_BUILTIN_TOOLS,
  UNUSED_SDK_BUILTIN_TOOLS,
} from "../../shared/sdkToolPresentation.js";
import {
  disallowedEntriesForPolicy,
  isAgentTeamsDisabled,
} from "../toolSkillPolicy.js";
import { computeSkillsOption, freshSkillDiscoveryCache } from "./skillDiscovery.js";
import {
  buildFileOutputServer,
  FILE_OUTPUT_SERVER_NAME,
  FILE_OUTPUT_TOOL_NAMES,
} from "./fileOutputTools.js";

// Same `{ module: "agent" }` tag claudeAgent.ts logs under: the plan is one
// half of a single run, so its lines must stay indistinguishable in the log.
const agentLogger = logger.child({ module: "agent" });

export function withoutGitCredentialEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

// App-internal secrets the agent subprocess must NEVER be able to read from its
// environment. SESSION_SECRET is the AES-256-GCM master key for EVERY user's
// at-rest secrets (git tokens, the secret vault, the Claude subscription token):
// a Bash-capable elevated viewer that read it out of the subprocess env (or
// /proc) could decrypt all tenants' secrets straight out of the shared DB. The
// subprocess never opens the app DB, so stripping it costs nothing. (Git
// credentials are stripped separately above — they flow only through the
// app-managed git MCP bridge.)
const SENSITIVE_APP_ENV_NAMES = ["SESSION_SECRET"] as const;

export function agentSubprocessEnv(
  baseEnv: Record<string, string | undefined>,
  agentSessionsDir: string,
  agentTeamsDisabled = false,
): Record<string, string | undefined> {
  const env = withoutGitCredentialEnv(baseEnv);
  for (const name of SENSITIVE_APP_ENV_NAMES) {
    delete env[name];
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: agentSessionsDir,
    // Agent teams (experimental CLI feature): lets the avatar spawn ADDRESSABLE
    // subagents (Agent tool with `name:`) and coordinate them via SendMessage.
    // Default-on. Precedence: the admin's `agent_teams` toggle
    // (isAgentTeamsDisabled — governance) wins over everything; otherwise an
    // operator value set in the deploy environment (e.g. "0") wins over the
    // default.
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: agentTeamsDisabled
      ? "0"
      : (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS ?? "1"),
  };
}

export function sshMcpSecretEnv(
  ownerSecrets: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SSH_MCP_SECRET_ENV_NAMES) {
    const value = ownerSecrets[name];
    if (value !== undefined) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Backstop for the one-shot MCP secret files: the wrapper deletes its file on
 * read, so anything older than an hour is a crash leftover — remove it. Never
 * throws (missing dir on first run is the normal case).
 */
const MCP_SECRET_FILE_MAX_AGE_MS = 60 * 60 * 1000;
function sweepStaleMcpSecretFiles(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > MCP_SECRET_FILE_MAX_AGE_MS) {
        fs.unlinkSync(file);
      }
    } catch {
      /* raced with a wrapper's own unlink */
    }
  }
}

/**
 * The subset of the owner's secret vault that may be injected as env into the
 * owner's OWN plugin-defined MCP servers (see plugins.liftPluginMcpServers).
 * Reserved names with app-dedicated routing are excluded:
 *  - git credentials (GIT_TOKEN/GITHUB_TOKEN/GH_*) are used server-side only —
 *    "git work is MCP-only BY DESIGN" (root CLAUDE.md) must survive this
 *    feature, or a plugin `.mcp.json` could exfiltrate push rights.
 *  - SSH material stays exclusive to the app-pinned hex-ssh subprocess.
 * Everything else (CONFLUENCE_PAT, arbitrary custom names) is injected.
 */
export function mcpInjectableSecretEnv(
  ownerSecrets: Record<string, string>,
): Record<string, string> {
  const reserved = new Set<string>([
    ...GIT_CREDENTIAL_ENV_NAMES,
    ...SSH_MCP_SECRET_ENV_NAMES,
  ]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(ownerSecrets)) {
    if (!reserved.has(name)) {
      out[name] = value;
    }
  }
  return out;
}

export interface AgentToolAccess {
  viewerIsOwner: boolean;
  headless: boolean;
  allowHeadlessTools: boolean;
  /** Owner-level tool access: owner AND (non-headless OR a headless run that opted in). */
  ownerToolAccess: boolean;
  /** Elevated (owner OR trusted) tool access, with the same headless gating. */
  elevatedToolAccess: boolean;
  /** Owner OR trusted, IGNORING headless — gates the auto-approve path. */
  elevated: boolean;
  autoApprove: boolean;
  hexSshViewerClass: HexSshViewerClass;
}

/**
 * Derive a run's tool-permission level from the request. Pure and exported so it
 * can be unit-tested directly: because the PreToolUse hook auto-allows every
 * `mcp__*` tool, these booleans are the REAL gate between a run and the owner-only
 * tools. A regression that, e.g., passed raw `viewerIsOwner` through would
 * silently grant headless intro/hashtag-generation runs full owner repo-write
 * access — so the four viewer classes are pinned in tests.
 */
export function deriveAgentToolAccess(request: AgentRequest): AgentToolAccess {
  const viewerIsOwner = Boolean(request.viewerIsOwner);
  const headless = Boolean(request.headless);
  const allowHeadlessTools = Boolean(request.allowHeadlessTools);
  // A headless run is tool-restricted UNLESS it explicitly opted in (scheduled
  // owner routines do). `!headlessRestricted` === `(!headless || allowHeadlessTools)`.
  const headlessRestricted = headless && !allowHeadlessTools;
  // GROUP SHARED-AGENT class, checked FIRST: there is no owner to compare
  // against, so the run kind itself carries capability. Owner-only tools never
  // unlock; every member gets the elevated built-in class (workspace Bash/Edit
  // work — nothing personal is registered for these runs); hex-ssh stays at the
  // least-privileged viewer class (its servers never register here anyway).
  if (request.groupAgent) {
    return {
      viewerIsOwner: false,
      headless,
      allowHeadlessTools,
      ownerToolAccess: false,
      elevatedToolAccess: !headlessRestricted,
      elevated: true,
      autoApprove: Boolean(request.autoApprove),
      hexSshViewerClass: "colleague",
    };
  }
  const ownerToolAccess = viewerIsOwner && !headlessRestricted;
  const elevatedToolAccess =
    (viewerIsOwner || Boolean(request.elevated)) && !headlessRestricted;
  const elevated = viewerIsOwner || Boolean(request.elevated);
  const autoApprove = Boolean(request.autoApprove);
  const hexSshViewerClass = viewerClassForAgentRequest({
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    headless: headlessRestricted,
  });
  // (planMcpToolFamilies below is this function's sibling for TOOL-GROUP
  // families: pure, exported, unit-pinned for the same regression reason.)
  return {
    viewerIsOwner,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  };
}

/**
 * Which MCP tool-group FAMILIES a run registers, from the composer/admin
 * selection + the run kind. A group shared-agent run forces every
 * personal-scoped family off (capability containment); `registered` — not the
 * raw selection — is what the prompt and describe_system must report, or the
 * avatar advertises tools that don't exist (meta-cognition invariant).
 * `runKindBlocked` joins the admin-blocked prompt exclusion so the "user
 * deselected" note can't misattribute the forcing to the member's own choice.
 * Pure and unit-pinned like deriveAgentToolAccess: the run assembly consumes
 * THESE booleans for server registration, so report and reality can't drift.
 */
export interface McpToolFamilyPlan {
  personalKnowledge: boolean;
  groupKnowledge: boolean;
  gitRepo: boolean;
  confluence: boolean;
  web: boolean;
  ssh: boolean;
  avatars: boolean;
  canvas: boolean;
  browser: boolean;
  system: boolean;
  registered: McpToolGroupId[];
  runKindBlocked: McpToolGroupId[];
}

export function planMcpToolFamilies(
  enabled: McpToolGroupId[],
  groupAgentRun: boolean,
): McpToolFamilyPlan {
  const has = (id: McpToolGroupId) => enabled.includes(id);
  const byId: Record<McpToolGroupId, boolean> = {
    personal_knowledge: has("personal_knowledge") && !groupAgentRun,
    group_knowledge: has("group_knowledge"),
    git_repo: has("git_repo") && !groupAgentRun,
    confluence: has("confluence") && !groupAgentRun,
    web: has("web"),
    ssh: has("ssh") && !groupAgentRun,
    avatars: has("avatars") && !groupAgentRun,
    canvas: has("canvas") && !groupAgentRun,
    // Browser control drives the VIEWER's own logged-in browser. Blocked for a
    // group agent (configured by the team, not by the person whose session
    // would be acted with). Stripping it HERE — rather than only at the
    // handler — keeps `registered` honest, so the avatar never advertises a
    // tool it cannot call.
    browser: has("browser") && !groupAgentRun,
    system: true,
  };
  const registered = effectiveMcpToolGroups(enabled).filter((id) => byId[id]);
  return {
    personalKnowledge: byId.personal_knowledge,
    groupKnowledge: byId.group_knowledge,
    gitRepo: byId.git_repo,
    confluence: byId.confluence,
    web: byId.web,
    ssh: byId.ssh,
    avatars: byId.avatars,
    canvas: byId.canvas,
    browser: byId.browser,
    system: byId.system,
    registered,
    runKindBlocked: enabled.filter((id) => !registered.includes(id)),
  };
}

/**
 * The ordered list of models to try for a run. Walks DOWN the tier order
 * (opus→sonnet→haiku) starting from the resolved model, so a transient failure
 * on the primary falls back to a lighter tier. A concrete (non-tier) primary —
 * e.g. an admin override pinned to a specific model id — is tried first, then
 * the lower tiers. Callers gate this on `modelFallback` + no env pin.
 */
export function buildModelFallbackChain(primary: string): string[] {
  const idx = MODEL_TIER_IDS.indexOf(primary);
  if (idx >= 0) {
    return MODEL_TIER_IDS.slice(idx);
  }
  return [primary, "sonnet", "haiku"].filter(
    (model, i, arr) => arr.indexOf(model) === i,
  );
}

/**
 * Derive everything a run needs before the SDK stream opens: tool access, MCP
 * servers, model chain, prompt/self-state inputs, and the SDK `options` bag.
 * Pure with respect to the run loop — it reads store/config/plugins and builds
 * servers, but touches none of the loop's accumulators.
 */
export async function buildAgentRunPlan(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents | undefined,
  abortController: AbortController | undefined,
  currentTextAnchor: () => number,
) {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    // `query()` returns an AsyncIterable PLUS control methods. We use
    // getContextUsage() — the SDK's first-party "current context-window usage"
    // breakdown — to report true occupancy instead of scraping message usage.
    // It only answers while the session is live (streaming I/O), so we call it
    // mid-turn (see the assistant branch in the run loop).
    query: (input: unknown) => AsyncIterable<unknown> & {
      getContextUsage?: () => Promise<
        { totalTokens?: number; maxTokens?: number } | undefined
      >;
    };
  };
  const { buildKnowledgeServer, KNOWLEDGE_SERVER_NAME, KNOWLEDGE_TOOL_NAMES } =
    await import("./knowledgeTools.js");
  const {
    buildRepoServer,
    REPO_SERVER_NAME,
    REPO_TOOL_NAMES,
    REPO_CREATE_TOOL_NAME,
  } = await import("./repoTools.js");
  const { buildSshTrustServer, SSH_TRUST_SERVER_NAME, SSH_TRUST_TOOL_NAMES } =
    await import("./sshTrustTools.js");
  const {
    buildSshIdentityServer,
    SSH_IDENTITY_SERVER_NAME,
    SSH_IDENTITY_TOOL_NAMES,
  } = await import("./sshIdentityTools.js");
  const {
    buildSystemServer,
    SYSTEM_SERVER_NAME,
    SYSTEM_TOOL_NAMES,
  } = await import("./systemTools.js");
  const {
    buildConfluenceServer,
    CONFLUENCE_SERVER_NAME,
    CONFLUENCE_TOOL_NAMES,
  } = await import("./confluenceTools.js");
  const {
    buildWebFetchServer,
    webFetchProxyState,
    WEB_FETCH_SERVER_NAME,
    WEB_FETCH_TOOL_NAMES,
  } = await import("./webFetchTools.js");
  const {
    buildAvatarDirectoryServer,
    AVATAR_DIRECTORY_SERVER_NAME,
    AVATAR_DIRECTORY_TOOL_NAMES,
    AVATAR_ASK_TOOL_NAME,
  } = await import("./avatarDirectoryTools.js");
  const {
    buildSkillExchangeServer,
    SKILL_EXCHANGE_SERVER_NAME,
    SKILL_EXCHANGE_TOOL_NAMES,
  } = await import("./skillExchangeTools.js");
  const { buildGitRepoServer, GIT_REPO_SERVER_NAME, GIT_REPO_TOOL_NAMES } =
    await import("./gitRepoTools.js");
  const {
    buildGroupRepoServer,
    buildGroupAgentRepoServer,
    GROUP_REPO_SERVER_NAME,
    GROUP_REPO_TOOL_NAMES,
    GROUP_AGENT_REPO_TOOL_NAMES,
  } = await import("./groupRepoTools.js");
  const { buildBrowserServer, BROWSER_SERVER_NAME, BROWSER_TOOL_NAMES } =
    await import("./browserTools.js");
  const { buildCanvasServer, CANVAS_SERVER_NAME, CANVAS_TOOL_NAMES } =
    await import("./canvasTools.js");
  const { buildBrainServer, BRAIN_SERVER_NAME, BRAIN_TOOL_NAMES } =
    await import("./brainTools.js");
  const {
    buildGroupBrainServer,
    buildGroupAgentBrainServer,
    GROUP_BRAIN_SERVER_NAME,
    GROUP_BRAIN_TOOL_NAMES,
  } = await import("./groupBrainTools.js");
  const {
    buildGroupAgentProfileServer,
    GROUP_AGENT_PROFILE_SERVER_NAME,
    GROUP_AGENT_PROFILE_TOOL_NAMES,
  } = await import("./groupAgentProfileTools.js");
  const {
    buildPersonalAgentSelfServer,
    buildPersonalAgentOwnerServer,
    PERSONAL_AGENT_SERVER_NAME,
    PERSONAL_AGENT_SELF_TOOL_NAMES,
    PERSONAL_AGENT_OWNER_TOOL_NAMES,
  } = await import("./personalAgentProfileTools.js");

  const streaming = Boolean(events);
  // Tool-access derivation lives in deriveAgentToolAccess (a pure, unit-tested
  // helper): because the PreToolUse hook auto-allows every mcp__* tool, these
  // booleans are the real gate between a headless/colleague run and owner-only
  // tools, so the logic must be testable in isolation.
  const {
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    hexSshViewerClass,
  } = deriveAgentToolAccess(request);
  // Avatar consultation runs (#ask-avatar) are MACHINE-initiated: no human sees
  // the request or its effects, so the widenings a HUMAN teammate turn gets —
  // shared-account repo writes, plugin MCP servers with the owner's secret
  // vault, shell secret exposure — are withheld below. The run stays personal-
  // knowledge READ + request_info (see avatarAsk.ts and docs/architecture/avatar-collab.md).
  const consultationRun = Boolean(request.avatarConsultation);
  const hexSshPolicy = store.getHexSshToolPolicy();
  const hexSshAllowedTools = allowedHexSshToolsForViewer(
    hexSshPolicy,
    hexSshViewerClass,
  );
  // Admin-managed built-in tool/skill on-off policy — read fresh per run like
  // the hex-ssh policy, so a panel change applies from the next turn without a
  // restart. Enforced three ways below: disallowedTools (removes built-ins
  // from context / denies Skill(<name>) at the CLI), the skills allowlist
  // (hides disabled skills from the listing), and the PreToolUse hook (our own
  // gate — the hook otherwise auto-allows every Skill call).
  const toolSkillPolicy = store.getToolSkillPolicy();
  // Admin per-group tool policy (enforcement + META-COGNITION): the driving
  // user's allowed MCP tool groups is the INTERSECTION across their
  // policy-bearing groups (null = unrestricted). Clamped HERE — the single
  // choke point every runAgentStream caller (chat, routines, headless
  // generators) passes through — so a blocked group's MCP servers are never
  // even registered, whatever selection the caller passed. System is the
  // mandatory exception; its handlers still enforce access. Read fresh per run
  // like the other policies, so a panel change applies from the next turn.
  const adminAllowedMcpToolGroups = store.allowedMcpToolGroupsForUser(
    request.viewerUserId ?? request.avatar.id,
  );
  const enabledMcpToolGroups = effectiveMcpToolGroups(
    request.mcpToolGroups,
    adminAllowedMcpToolGroups,
  );
  const adminBlockedMcpToolGroups = adminAllowedMcpToolGroups
    ? DEFAULT_MCP_TOOL_GROUPS.filter(
        (id) => id !== "system" && !adminAllowedMcpToolGroups.includes(id),
      )
    : [];
  // GROUP SHARED-AGENT run: a hard capability boundary on top of the composer's
  // tool-group picks — every PERSONAL-scoped server family is forced off so it
  // never registers (personal repo/brain, inbox, ssh, git repos, confluence,
  // avatars directory, canvas). What remains: system, web, and the OWNING
  // group's repo/brain via the pinned group-agent factories below. The plan is
  // the SINGLE source for the family booleans AND for `registered` — the set
  // the prompt and describe_system report — so report and reality can't drift.
  const groupAgentRun = request.groupAgent ?? null;
  // PERSONAL-AGENT (내 봇) run: identity, plus ONE scoped personal-knowledge
  // lens. Deliberately absent from deriveAgentToolAccess above and from
  // planMcpToolFamilies below — a bot run IS a full owner run (request.avatar is
  // the OWNER's own avatar), so the owner access algebra and every personal tool
  // family must stay exactly as they are for the owner's main avatar. What this
  // flag drives instead: the prompt identity swap, describe_system's bot block,
  // the self-config server, the self-scoped routine tools, and the memory scope
  // (`personalAgentScope` below) that parameterizes the repo/brain servers.
  const personalAgentRun = request.personalAgent ?? null;
  const familyPlan = planMcpToolFamilies(enabledMcpToolGroups, Boolean(groupAgentRun));
  const personalKnowledgeToolsEnabled = familyPlan.personalKnowledge;
  const groupKnowledgeToolsEnabled = familyPlan.groupKnowledge;
  const gitRepoToolsEnabled = familyPlan.gitRepo;
  const confluenceToolsEnabled = familyPlan.confluence;
  const webFetchToolsEnabled = familyPlan.web;
  const sshToolsEnabled = familyPlan.ssh;
  const avatarDirectoryToolsEnabled = familyPlan.avatars;
  const canvasToolsEnabled = familyPlan.canvas;
  const browserToolsEnabled = familyPlan.browser;
  const systemToolsEnabled = familyPlan.system;
  const registeredMcpToolGroups = familyPlan.registered;
  const runKindBlockedMcpToolGroups = familyPlan.runKindBlocked;
  // Effective model: an env-pinned ANTHROPIC_MODEL wins (mirrors the API-key vs.
  // subscription rule) and is a HARD lock; otherwise the user's per-conversation
  // tier pick (a Claude alias, resolved to a concrete model by the operator's
  // ANTHROPIC_DEFAULT_*_MODEL env), otherwise the admin-selected override,
  // otherwise the DEFAULT tier (opus). Unknown tiers are ignored so a stale/garbage
  // value can never reach the SDK as a model id.
  const userModelTier = isModelTier(request.modelTier)
    ? request.modelTier
    : undefined;
  // User-chosen reasoning effort for this conversation. Unknown/unset → leave
  // `options.effort` off so the SDK applies its own default (`high`). Independent
  // of the model pin: effort still applies when ANTHROPIC_MODEL locks the model.
  const userEffort = isEffortLevel(request.effort) ? request.effort : undefined;
  const effectiveModel =
    config.anthropicModel ??
    userModelTier ??
    store.getModelOverride() ??
    DEFAULT_MODEL_TIER;
  // Model fallback chain (scheduled routines only — `request.modelFallback`): on a
  // transient model/server error, retry down the tier order from the resolved
  // model. An env-pinned ANTHROPIC_MODEL is a HARD lock, so it never falls back.
  // Otherwise the chain is just the single resolved model (chat behavior).
  const modelChain =
    request.modelFallback && !config.anthropicModel
      ? buildModelFallbackChain(effectiveModel)
      : [effectiveModel];
  // Effective vision for the model THIS run resolved to: the admin per-tier
  // policy for tier aliases, the deployment default (MODEL_VISION) otherwise.
  // Drives the hook's image-Read block, the no-vision prompt section, the
  // Confluence image-block gate, and describe_system.
  const runVisionEnabled = visionForModel(
    effectiveModel,
    store.getModelVisionPolicy(),
    config.visionEnabled,
  );
  const agentStart = Date.now();

  agentLogger.info(
    {
      avatarId: request.avatar.id,
      viewerUserId: request.viewerUserId,
      headless,
      allowHeadlessTools,
      elevated,
      autoApprove,
      hexSshViewerClass,
      hexSshAllowedToolCount: hexSshAllowedTools.length,
      enabledMcpToolGroups,
      adminBlockedMcpToolGroups,
      model: effectiveModel,
    },
    "agent run started",
  );

  // Knowledge-backfill tools, bound to this conversation's avatar + viewer.
  // Generic headless runs stay at colleague-level access, while scheduled owner
  // routines can opt into owner-level tools through allowHeadlessTools.
  const knowledgeServer = buildKnowledgeServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    askerUserId: request.viewerUserId ?? null,
    askerName: request.viewerName ?? null,
  });
  // Knowledge-repo management tools (list/read/write/scaffold/commit). OWNER-ONLY:
  // a colleague, a trusted user, or a generic headless run gets a refusal from
  // every tool. Scheduled owner routines use ownerToolAccess above. Registered
  // unconditionally — the per-handler `viewerIsOwner` gate is the safety boundary,
  // mirroring the knowledge server above. The owner identity for commits is
  // resolved from the avatar's own user row (viewer == owner here).
  const ownerRow = store.getUserById(request.avatar.id);
  // Owner identity for commits, resolved from the avatar's own user row (viewer
  // == owner here), shared by all owner-scoped MCP servers below.
  const owner: AgentOwner = {
    id: request.avatar.id,
    username: ownerRow?.username ?? "",
    displayName: ownerRow?.displayName ?? request.avatar.displayName,
    alias: ownerRow?.alias ?? request.avatar.alias,
  };
  // The avatar's live system self-state, read once from store+config (the same
  // facts the describe_system tool reports — see ownerState.ts). buildPrompt's
  // owner/routine self-state fields below are sourced from this so the two
  // call sites can't drift in WHAT they read. A group-agent run has NO owner:
  // it gets the inert OwnerState (nothing personal can leak into a gate) and
  // its real self-state comes from summarizeGroupAgentState instead.
  const ownerState = groupAgentRun
    ? emptyOwnerState(store, config)
    : summarizeOwnerState(store, config, request.avatar.id);
  const groupAgentState = groupAgentRun
    ? summarizeGroupAgentState(
        store,
        config,
        groupAgentRun.agentId,
        request.viewerUserId ?? "",
      )
    : null;
  // The bot's own live self-state, alongside (never instead of) the owner state
  // above — a bot run has BOTH. Summarized against the VIEWER, not against
  // request.personalAgent.ownerUserId, so a drifted request fails the owner
  // match instead of confirming itself (avatar.id is the owner uuid by the
  // personal-run contract, and the reach gate proved viewer == owner).
  const personalAgentState = personalAgentRun
    ? summarizePersonalAgentState(
        store,
        personalAgentRun.agentId,
        request.viewerUserId ?? request.avatar.id,
        // Per-THREAD backlog (queuedTaskCount): omitted → 0, so a run without a
        // conversation id never reports another thread's queue.
        request.conversationId,
      )
    : null;
  // The bot's OWN memory namespace inside the owner's single knowledge repo —
  // on a bot run this is the only thing standing between a full owner run and
  // the owner's own vault/skills. Server-CONSTRUCTION parameterization only
  // (exactly like buildGroupAgentBrainServer): the access algebra above never
  // learns about personal agents. Static for the whole run — a bot disabled or
  // deleted mid-run is caught by the NEXT turn's reach gate, not re-read here.
  // A run whose row vanished between the reach gate and here falls back to a
  // namespace keyed by the bot id (a folder no bot writes to), so a degenerate
  // run is never WIDER than a healthy one.
  const personalAgentScope = personalAgentRun
    ? {
        root:
          personalAgentState?.memoryRoot ??
          personalAgentMemoryRoot(personalAgentRun.agentId),
        botName:
          personalAgentState?.alias ||
          personalAgentState?.displayName ||
          request.avatar.displayName,
      }
    : undefined;
  // The ACTING member behind a group-agent run: commit identity, token source,
  // audit actor for the pinned group tools (groups own no credentials).
  const actingMemberRow =
    groupAgentRun && request.viewerUserId
      ? store.getUserById(request.viewerUserId)
      : null;
  const actingMember = {
    id: request.viewerUserId ?? "",
    username: actingMemberRow?.username ?? "",
    displayName: request.viewerName ?? actingMemberRow?.displayName ?? "",
  };
  // Computed once and reused for the prompt (below). The repo-creation tool is
  // exposed ONLY for an owner-driven, non-headless chat with NO repo yet — once
  // one is connected, hiding it keeps the unused tool out of every prompt.
  const knowledgeRepoConfigured = ownerState.knowledgeRepoConfigured;
  const allowRepoCreate =
    personalKnowledgeToolsEnabled &&
    ownerToolAccess &&
    !knowledgeRepoConfigured;
  // Shared (communal) account: the owner opted into letting trusted same-group
  // teammates WRITE to the personal knowledge repo through this avatar. Widens
  // ONLY the repo file-CRUD/commit gate below (still headless-gated via
  // elevatedToolAccess); create_repo, repo connection settings, and every other
  // owner-only tool keep requiring the owner.
  const sharedAccount = ownerState.sharedAccount;
  const repoWriteAccess =
    ownerToolAccess ||
    (sharedAccount && elevatedToolAccess && !consultationRun);
  const repoServer = buildRepoServer(
    store,
    {
      avatarUserId: request.avatar.id,
      owner,
      viewerIsOwner: ownerToolAccess,
      // Trusted same-group teammates may READ (list_files/read_file) the owner's
      // personal repo; write/commit stay owner-only UNLESS the owner marked this
      // a shared account (see repoTools.ts `writeAccess`).
      elevated: elevatedToolAccess,
      writeAccess: repoWriteAccess,
      // The person actually chatting, for commit audit attribution on shared
      // accounts (owner runs audit as the owner regardless).
      viewer: request.viewerUserId
        ? { id: request.viewerUserId, name: request.viewerName ?? "" }
        : null,
      config,
      // A successful wiki/ write is a second-brain capture — surface it as a
      // dedicated "기억" notice in the activity tree (no-op headless).
      onMemory: (e) => events?.onMemory?.({ ...e, scope: "personal" }),
      // Bot runs: confine every path op to the bot's memory folder, stage only
      // that subtree on commit, and refuse scaffold_skill/create_repo.
      pathScope: personalAgentScope,
    },
    { allowCreate: allowRepoCreate },
  );
  // Personal second brain (#second-brain): read-only `wiki/` recall over the
  // owner's knowledge repo. Always-on (no feature flag) — gated on a connected
  // repo + read access (owner OR trusted teammate, like `mcp__repo__read_file`).
  // The repo is resolved from the OWNER (avatar.id) inside the tools, never the
  // viewer, so a teammate's search hits the owner's vault. brainActive is the
  // SINGLE boolean used byte-identically in allowedTools + mcpServers below.
  const brainActive =
    personalKnowledgeToolsEnabled &&
    knowledgeRepoConfigured &&
    elevatedToolAccess;
  // Browser bridge: the tools drive the VIEWER's own browser through the
  // extension, so they need an interactive run carrying a bridge sink. Computed
  // HERE (ahead of the server build below) because describe_system's context is
  // assembled first and must report the same capability as the prompt.
  //
  // The identity half is kept separate because the handler restates it: the
  // `mcp__` auto-allow means the tool callback is the last line of defence if
  // registration ever drifts. Owner-only — anyone chatting with someone else's
  // avatar must not let that owner's instructions drive their own logged-in
  // browser.
  const browserViewerAllowed = ownerToolAccess;
  const browserActive =
    browserToolsEnabled && Boolean(events?.onBrowser) && browserViewerAllowed;
  // Stored secrets the owner opted into BROWSER INPUT. Derived here (next to the
  // bridge gates) because three places downstream need the SAME list: the browser
  // server's ctx, the redaction set below, and — via claudeAgent's request stamp
  // — both metacognition surfaces. Never on a consultation run: that turn is
  // driven by ANOTHER avatar's question, and a credential must not be typed on
  // someone else's prompt. Empty whenever the bridge itself is off, so a run with
  // no browser can never resolve a value.
  const browserSecretPolicies =
    browserActive && !consultationRun ? ownerState.browserSecrets : [];
  const brainServer = buildBrainServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    config,
    // Bot runs recall from the bot's OWN memory vault, never the owner's.
    scope: personalAgentScope,
  });
  const fileOutputActive = Boolean(request.cwd && events?.onFile);
  // Visual canvas (experimental `canvas` feature, #50): registered only when the
  // avatar OWNER enabled it AND this is an interactive turn with a canvas sink
  // (events.onCanvas). Gating on the owner's setting — not the viewer's — means
  // colleagues chatting with that avatar also get canvases (the feature grants no
  // elevation; the handler self-gates nothing because showing UI is harmless).
  // Computed here, before buildSystemServer, so describe_system reports it.
  const canvasActive =
    canvasToolsEnabled &&
    Boolean(events?.onCanvas) &&
    ownerState.experimentalFeatures.includes("canvas");
  // Deployment-level PPTX toolchain probes — memoized per process (boot pays
  // the spawn cost): the legacy LibreOffice/pdftoppm/python-pptx half, and the
  // pptx skill's HTML→PPTX converter (`deck.mjs probe`), whose state rides into
  // describe_system with the `converter: INSTALLED` / `NOT INSTALLED` markers.
  // Deck guidance additionally needs a turn that can publish files (the
  // preview/download path) and a viewer who may author one: deckAuthoring is
  // the admin skill policy (the hook's exact `pptx` / `<plugin>:pptx` rule),
  // then the same elevated-tools gate the PreToolUse hook applies to Bash.
  const deckRenderingAvailable = probeDeckRendering();
  const deckToolchain = probeDeckToolchain(config);
  const deckAuthoring = deckAuthoringStatusFor({
    elevatedToolAccess,
    disabledSkills: toolSkillPolicy.disabledSkills,
    pptxSkillNames: deckToolchain.pptxSkillNames,
  });
  const systemServer = buildSystemServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
    selectedModelTier: userModelTier,
    selectedEffort: userEffort,
    // The REGISTERED set (not the raw selection): a group-agent run's forced-off
    // personal families must not show as "enabled for this conversation".
    enabledMcpToolGroups: registeredMcpToolGroups,
    // Group-agent runs: describe_system answers with the GROUP's self-state
    // (summarizeGroupAgentState) instead of an owner block; management tools
    // keep refusing via viewerIsOwner.
    groupAgent: groupAgentRun
      ? { agentId: groupAgentRun.agentId, actingUserId: actingMember.id }
      : undefined,
    // Personal-agent runs: describe_system prints the BOT block ahead of the
    // owner block, and the four routine tools refuse (same acting-user
    // derivation as personalAgentState above).
    personalAgent: personalAgentRun
      ? {
          agentId: personalAgentRun.agentId,
          actingUserId: request.viewerUserId ?? request.avatar.id,
          // Delegated-task self-state: WHICH card this turn writes to (if any)
          // and the thread whose backlog the state summarizer counts.
          taskId: personalAgentRun.taskId,
          conversationId: request.conversationId,
        }
      : undefined,
    // The working repo opened for this conversation (NAME only — the clone path is
    // never surfaced). Mirrors buildPrompt's activeRepoSection in describe_system.
    activeRepoName: request.activeRepoName,
    fileOutputEnabled: fileOutputActive,
    browserEnabled: browserActive,
    canvasEnabled: canvasActive,
    deckRenderingAvailable,
    deckToolchain,
    deckAuthoring,
    visionEnabled: runVisionEnabled,
    toolSkillPolicy,
    // Turn PROVENANCE (META-COGNITION), mirroring buildSystemPromptAppend's
    // external-task paragraph: an outside system submitted this instruction,
    // so describe_system must not report it as an owner typing in the chat.
    externalTaskApi: request.externalTaskApi,
    // Unattended (routine) runs: the prompt routes them to its own headless
    // branch, so describe_system has to omit the same owner-conversation facts
    // or the two surfaces contradict each other on the same run.
    headless: request.headless,
    // Mid-turn user messages (steers): this run carries a live steer channel,
    // so the viewer can send more messages WHILE it works. Mirrors
    // buildSystemPromptAppend's standing line and `AgentRequest.midTurnMessages`.
    midTurnMessages: Boolean(events?.steers),
  });
  // Cross-avatar discovery (read-only): lets the avatar look up OTHER visible
  // avatars by capability so it can point the user at a teammate avatar for
  // things outside its own expertise. Visibility is from the VIEWER's POV (the
  // person chatting), and the current avatar is excluded from its own results.
  //
  // Avatar consultation (#ask-avatar) rides the same server: OWNER-DRIVEN runs
  // (owner chats + owner routines) may ask a same-group teammate's avatar one
  // question. `avatarConsultation` is the depth guard — a consultation run never
  // re-registers the tool, so ask chains cannot nest. avatarAskActive is the
  // SINGLE boolean used byte-identically in allowedTools + the ctx injection
  // below (the executor's absence unregisters the tool; the handler still
  // self-gates on viewerIsOwner).
  const avatarAskActive =
    avatarDirectoryToolsEnabled &&
    ownerToolAccess &&
    !consultationRun &&
    // No avatar-sharing group → no reachable target (trust = shared membership
    // in a group with avatar sharing ON; sharing-off groups grant neither
    // visibility nor trust), so keep the tool out of the prompt entirely.
    ownerState.groups.some((g) => g.avatarSharing);
  const avatarDirectoryServer = buildAvatarDirectoryServer(store, {
    avatarUserId: request.avatar.id,
    viewerUserId: request.viewerUserId ?? request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    ...(avatarAskActive
      ? {
          askAvatar: async (targetUsername: string, question: string) => {
            // Loaded lazily like the tool modules above: avatarAsk drags in the
            // full agent runner, which only a run that actually consults needs.
            const { askAvatar } = await import("./avatarAsk.js");
            return askAvatar(store, config, {
              // Owner-driven by gate (ownerToolAccess), so the asker IS the owner.
              askerUserId: request.avatar.id,
              askerName: owner.displayName,
              targetUsername,
              question,
              // Cancelling the asking turn cancels the consultation too.
              parentSignal: abortController?.signal,
            });
          },
          askCaptureHint:
            personalKnowledgeToolsEnabled && knowledgeRepoConfigured,
        }
      : {}),
  });
  // Skill exchange (#skill-share): search skills teammates' avatars shared,
  // learn one into the owner's knowledge repo, (un)share own repo skills.
  // Rides the `avatars` tool group (it is cross-avatar discovery) and is
  // OWNER-ONLY end to end: learning writes the owner's repo, and the listing
  // is the OWNER's group view — a trusted teammate driving this avatar must
  // not browse it (their own avatar serves their view). Group-agent runs are
  // excluded via ownerToolAccess=false (no personal repo). skillExchangeActive
  // is the SINGLE boolean used byte-identically in allowedTools + mcpServers.
  const skillExchangeActive = avatarDirectoryToolsEnabled && ownerToolAccess;
  const skillExchangeServer = buildSkillExchangeServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
  });
  const sshIdentityServer = buildSshIdentityServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
  });
  const gitRepoServer = buildGitRepoServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    elevated: elevatedToolAccess,
    config,
    conversationId: request.conversationId,
  });
  // Group knowledge-repo tools (per group the OWNER belongs to). OWNER-ONLY like
  // the personal repo tools — a group admin edits their group repo through their
  // own avatar; each tool then checks the owner's role in the named group (member
  // reads, admin writes). Registered only for an owner-driven turn where the
  // owner actually belongs to ≥1 group, to keep the tools out of other prompts.
  const ownerGroups = ownerState.groups;
  // GROUP-AGENT runs register the same server NAME through the pinned factory
  // (no group argument; read = member, write = the group's capture policy).
  // Native runs keep the owner-only factory. Both stay a single `active`
  // boolean + a single server value so allowedTools/mcpServers can't drift.
  const groupRepoActive =
    groupKnowledgeToolsEnabled &&
    (groupAgentRun
      ? true
      : ownerToolAccess && ownerGroups.length > 0);
  // Group second-brain capture notice, mirroring the personal repo's onMemory.
  const onGroupMemory = (e: { action: "add" | "update"; path: string; groupName: string }) =>
    events?.onMemory?.({ ...e, scope: "group" });
  const groupRepoServer = groupAgentRun
    ? buildGroupAgentRepoServer(store, {
        groupId: groupAgentRun.groupId,
        agentId: groupAgentRun.agentId,
        groupName: groupAgentRun.groupName,
        actingUser: actingMember,
        config,
        onMemory: onGroupMemory,
      })
    : buildGroupRepoServer(store, {
        avatarUserId: request.avatar.id,
        owner,
        viewerIsOwner: ownerToolAccess,
        config,
        onMemory: onGroupMemory,
      });
  // Group (team) second brain: read-only `wiki/` recall over a group's shared
  // repo, scoped per-group to the OWNER's memberships inside the tools. Owner-only
  // at registration (like the group repo tools), active when the owner is in ≥1
  // group with a connected shared repo. groupBrainActive is the SINGLE boolean
  // used byte-identically in allowedTools + mcpServers below.
  const groupBrainActive =
    groupKnowledgeToolsEnabled &&
    (groupAgentRun
      ? Boolean(groupAgentState?.knowledgeRepoConfigured)
      : ownerToolAccess &&
        ownerGroups.some((g) => g.knowledgeRepoConfigured));
  const groupBrainServer = groupAgentRun
    ? buildGroupAgentBrainServer(store, {
        groupId: groupAgentRun.groupId,
        agentId: groupAgentRun.agentId,
        groupName: groupAgentRun.groupName,
        actingUserId: actingMember.id,
        config,
      })
    : buildGroupBrainServer(store, {
        avatarUserId: request.avatar.id,
        viewerIsOwner: ownerToolAccess,
        config,
      });
  // Self-configuration (update_profile): group-agent runs only — the agent
  // edits its OWN persona/profile. Registration is not the boundary (mcp__
  // auto-allow): the handler re-gates per call on the acting member's LIVE
  // group-admin role. Single boolean used byte-identically in allowedTools +
  // mcpServers below.
  const groupAgentProfileActive = Boolean(groupAgentRun);
  const groupAgentProfileServer = groupAgentRun
    ? buildGroupAgentProfileServer(store, {
        groupId: groupAgentRun.groupId,
        agentId: groupAgentRun.agentId,
        groupName: groupAgentRun.groupName,
        actingUser: actingMember,
      })
    : null;
  // Personal agents (내 봇). TWO tool SETS with opposite run kinds behind ONE
  // server name: a bot run gets `update_profile` (it edits ITSELF) + the
  // delegated-task `report_task`, an owner's own run gets `create_agent` (it
  // stands a new bot up). `delegate_to_bot` (봇 간 위임) is the one tool BOTH
  // sets carry. The gates are mutually exclusive by construction, so the name
  // can never collide. No registration is the boundary — every handler
  // re-checks the live owner+admin role (the mcp__ auto-allow fires first).
  const personalAgentSelfActive = Boolean(personalAgentRun);
  const personalAgentCreateActive =
    ownerToolAccess &&
    !groupAgentRun &&
    !personalAgentRun &&
    !consultationRun &&
    // Owner-scheduled routines are excluded on purpose: creating a chat contact
    // is a decision the owner makes in conversation, not unattended work.
    !request.headless &&
    // Same reasoning for a turn an EXTERNAL SYSTEM submitted through the task
    // API: the owner did not type it, so an outside instruction must never
    // stand up a new bot unattended. Not headless (questions still park), so it
    // needs its own exclusion here.
    !request.externalTaskApi &&
    // The phase-1 feature gate (the same fact ownerState.personalAgentsEnabled
    // reports to both metacognition surfaces).
    ownerState.personalAgentsEnabled;
  const personalAgentServer = personalAgentRun
    ? buildPersonalAgentSelfServer(store, {
        agentId: personalAgentRun.agentId,
        owner,
        // The delegated-task card this turn reports against. Absent on an
        // untracked turn — report_task is registered either way and refuses
        // with a redirect, so the tool set never varies per turn.
        taskId: personalAgentRun.taskId ?? null,
        conversationId: request.conversationId ?? null,
        // adopt_skill/drop_skill resolve the owner's knowledge-repo clone to
        // read the skill catalog; without config they fail closed.
        config,
      })
    : personalAgentCreateActive
      ? buildPersonalAgentOwnerServer(store, { owner, config })
      : null;

  // Visual canvas server for this run; `canvasActive` is computed further up
  // (before buildSystemServer) so describe_system reports the same capability.
  const canvasServer = canvasActive
    ? buildCanvasServer({ emitCanvas: events!.onCanvas! })
    : null;
  // The handler self-gates on `allowed` in addition to `browserActive`: the
  // `mcp__` auto-allow in the PreToolUse hook fires before any owner check, and
  // a colleague must never drive their own logged-in session through someone
  // else's avatar prompt.
  // copy_image staging binds the held bytes to a user, and the staging page is
  // opened by the VIEWER's browser (the bridge relays into the browser of the
  // person chatting) — so the viewer, not the avatar owner, is who may read
  // them back. Captured for narrowing: the callback below is deferred.
  const stagingUserId = request.viewerUserId;
  const browserServer = browserActive
    ? buildBrowserServer({
        // Screenshot auto-share: the route publishes the capture as a file
        // card + hidden slide and hands the attachments back — stamp the same
        // text anchor the file-output wrappers stamp (below) so the card
        // renders inline at the point of capture. Hidden slides never render
        // in the bubble, so only the visible card needs one.
        execute: async (request) => {
          const result = await events!.onBrowser!(request);
          if (result.behavior === "ok" && result.sharedAttachments) {
            for (const attachment of result.sharedAttachments) {
              if (!attachment.hidden && attachment.anchor === undefined) {
                attachment.anchor = currentTextAnchor();
              }
            }
          }
          return result;
        },
        allowed: browserViewerAllowed,
        // Screenshot gate: image blocks must never reach a text-only model.
        vision: runVisionEnabled,
        // Noah's own origin, so copy_image can hand the agent an absolute
        // clipboard-staging URL to open with new_tab.
        appOrigin: request.appOrigin,
        // The paste shortcut differs by OS; the wording follows the browser
        // that is actually being driven.
        viewerPlatform: request.viewerPlatform,
        // Browser secret input: the model names a secret, the tools resolve the
        // value HERE and put it on the wire, so the plaintext never enters the
        // model context. `value` is deferred on purpose — injectableSecretEnv is
        // built further down, and the callback only runs at tool-call time.
        browserSecrets:
          browserSecretPolicies.length > 0
            ? {
                policies: browserSecretPolicies,
                value: (name: string) => injectableSecretEnv[name],
              }
            : undefined,
        // copy_image: resolve the path in the SAME working roots show_file uses
        // (shared readWorkspaceImage — one copy of the containment discipline),
        // then hold the bytes for the Noah-served staging page. Wired only when
        // the request carried an origin to build that page's URL from AND a
        // viewer to bind the staged bytes to.
        stageClipboardImage:
          request.appOrigin && stagingUserId
            ? async (workspacePath) => {
                const roots = [request.cwd, ...(request.additionalDirs ?? [])].filter(
                  (dir): dir is string => Boolean(dir),
                );
                const read = readWorkspaceImage(roots, workspacePath);
                if ("error" in read) {
                  const messages = {
                    OUTSIDE_WORKSPACE:
                      "The image must be inside the current working directory or scratch workspace.",
                    NOT_FOUND: "The image file does not exist.",
                    NOT_FILE: "The path is not a regular file.",
                    EMPTY: "The image file is empty.",
                    TOO_LARGE: "The image is larger than the 5 MB limit.",
                    UNSUPPORTED:
                      "Unsupported image format — use a PNG, JPEG, WebP, or GIF whose bytes match the format.",
                    READ_FAILED: "The image file could not be read.",
                  } as const;
                  throw new Error(messages[read.error]);
                }
                return stageClipboardImageBytes(read.buffer, read.mediaType, stagingUserId);
              }
            : undefined,
        // copy_text: the same staging store and the same origin+viewer gate as
        // copy_image, minus the workspace resolution — the payload is a string
        // the model authored, so the only bound is the store's byte cap.
        stageClipboardText:
          request.appOrigin && stagingUserId
            ? async (value) => stageClipboardTextBytes(value, stagingUserId)
            : undefined,
      })
    : null;
  // Local file output is available only for an interactive run with an
  // explicit working directory and a host sink that validates + persists the
  // file. Headless runs have nobody to show a bubble to, so the tools stay out.
  // `shareFile` (download cards) arrives with `onFile` from the chat route; the
  // fallback keeps an onFile-only caller working with an honest tool error.
  //
  // Each published attachment is stamped with its text ANCHOR — the length of
  // the assistant text accumulated when the tool ran (`currentTextAnchor()` reads
  // the run loop's accumulator, which already
  // holds every block preceding this tool call, joined exactly like the final
  // persisted text) — so the bubble can render the card inline at the point it
  // was created instead of below the still-growing text. Stamping mutates the
  // SAME object the route pushed into its attachments list, so the anchor rides
  // into persistence without widening the events contract.
  const stampAttachmentAnchor = (result: FileOutputResult): FileOutputResult => {
    if (result.behavior === "shown" && result.attachment.anchor === undefined) {
      result.attachment.anchor = currentTextAnchor();
    }
    return result;
  };
  const fileOutputServer = fileOutputActive
    ? buildFileOutputServer({
        showFile: async (request) => stampAttachmentAnchor(await events!.onFile!(request)),
        shareFile: events!.onShareFile
          ? async (request) => stampAttachmentAnchor(await events!.onShareFile!(request))
          : async () => ({
              behavior: "error" as const,
              message: "File sharing is unavailable in this run.",
            }),
        // share_file's description names the converter's in-place/exact-render
        // workflow only when the deployment actually has the converter.
        deckConverterInstalled: deckToolchain.converter,
      })
    : null;

  // SSH host-trust tools (add/list/remove the hosts hex-ssh will connect to).
  // NOT owner-only: host fingerprints are public, and a viewer who can drive
  // hex-ssh can manage its trust. The trust file is keyed to the owner
  // (avatar.id) and injected into hex-ssh below as KNOWN_HOSTS_PATH.
  const sshTrustServer = buildSshTrustServer({
    avatarUserId: request.avatar.id,
    config,
  });

  // The avatar acts on its OWNER's behalf, so it uses the OWNER's secrets
  // (avatar.id) regardless of who is chatting — a colleague talking to the
  // owner's avatar still operates with the owner's credentials. The values are
  // decrypted only here and handed to the MCP subprocess as env, so they never
  // surface to the agent (Bash/`env` runs in a different process) nor to `toUser`.
  // A group agent has NO owner and must never carry personal secrets — the
  // empty object is explicit (the synthetic id would yield none anyway).
  const ownerSecrets = groupAgentRun
    ? {}
    : store.getUserSecrets(request.avatar.id);
  const sshSecrets = sshMcpSecretEnv(ownerSecrets);
  // Secret handoff for app-registered EXTERNAL MCP subprocesses. The SDK
  // serializes `mcpServers` into the CLI's `--mcp-config` ARGV — readable via
  // /proc/<pid>/cmdline by the agent's own Bash — so secret VALUES must never
  // sit in a server definition. They ride in per-server one-shot 0600 files
  // that scripts/mcp-secret-wrapper.mjs reads, deletes, and merges into the
  // real server's env; only the file PATH appears in the definition. Stale
  // files (a crash before the wrapper consumed them) are swept after an hour.
  const mcpSecretsDir = path.join(config.dataDir, "runtime", "mcp-secrets");
  const mcpSecretWrapperPath = path.join(
    process.cwd(),
    "scripts",
    "mcp-secret-wrapper.mjs",
  );
  const mcpRunId = randomUUID();
  sweepStaleMcpSecretFiles(mcpSecretsDir);
  const injectableSecretEnv = mcpInjectableSecretEnv(ownerSecrets);
  // Per-key shell exposure: only the secrets the owner individually toggled
  // (`user_secrets.shell_expose`) export into the agent shell env, and only on
  // ELEVATED runs — the same viewer line as the MCP injection, so a plain
  // colleague's Bash stays secret-free. Reserved git/SSH names are already
  // absent from injectableSecretEnv regardless of the flag.
  const shellSecretEnv: Record<string, string> = {};
  if (elevatedToolAccess && !consultationRun) {
    for (const name of ownerState.shellExposedSecretNames) {
      const value = injectableSecretEnv[name];
      if (value !== undefined) {
        shellSecretEnv[name] = value;
      }
    }
  }
  // Browser-typed secrets reach a process too — the user's own browser — so
  // their values join the PostToolUse redaction set. Without this a run whose
  // ONLY secret exposure is browser input would register no hook at all, and a
  // page echoing the password back into its DOM would print it in the next
  // snapshot. The browser tools redact their own reply; this covers every OTHER
  // tool output for the rest of the turn.
  const browserSecretEnv: Record<string, string> = {};
  for (const policy of browserSecretPolicies) {
    const value = injectableSecretEnv[policy.name];
    if (value !== undefined) {
      browserSecretEnv[policy.name] = value;
    }
  }
  // Plugin-defined MCP servers (each root's `.mcp.json`): the APP registers
  // them (strictMcpConfig below stops the CLI from auto-spawning duplicates),
  // so the owner's secret vault — minus the reserved git/SSH names — can reach
  // the OWNED servers while the agent shell env stays clean. Group and default
  // roots load too but never receive secrets.
  const lifted = await liftPluginMcpServers(
    pluginRoots.map((root) => root.path),
    {
      avatarUserId: request.avatar.id,
      config,
      // Secrets ride only on ELEVATED runs (owner or trusted same-group
      // teammate, incl. owner-scheduled routines) — the exact line the
      // Confluence tools draw for the owner's PAT. Plugin servers are
      // third-party processes that cannot self-gate per viewer, and the
      // PreToolUse hook auto-allows every mcp__* call, so REGISTRATION is the
      // gate: a plain colleague or a restricted headless run still gets the
      // servers, but credential-less (the pre-lift CLI behavior).
      secretWrapper:
        elevatedToolAccess &&
        !consultationRun &&
        Object.keys(injectableSecretEnv).length > 0
          ? {
              scriptPath: mcpSecretWrapperPath,
              secretsDir: mcpSecretsDir,
              runId: mcpRunId,
            }
          : null,
      // Shell-exposed values live in the CLI subprocess env (options.env
      // below), which every CLI-spawned server INHERITS — blank them on
      // non-owned (group/default) servers so those never see the vault.
      maskEnvNames: Object.keys(shellSecretEnv),
    },
  );
  const liftedPluginMcpServers = lifted.servers;
  if (lifted.secretFiles.length > 0) {
    fs.mkdirSync(mcpSecretsDir, { recursive: true, mode: 0o700 });
    for (const file of lifted.secretFiles) {
      fs.writeFileSync(file, JSON.stringify(injectableSecretEnv), {
        mode: 0o600,
      });
    }
  }
  if (Object.keys(liftedPluginMcpServers).length > 0) {
    agentLogger.info(
      {
        avatarId: request.avatar.id,
        pluginMcpServers: Object.keys(liftedPluginMcpServers),
        secretInjected: lifted.secretFiles.length,
      },
      "plugin mcp servers lifted",
    );
  }
  const confluenceServer = buildConfluenceServer({
    config,
    ownerSecrets,
    elevated: elevatedToolAccess,
    // Text-only model this run → attachment tools return notes, not image blocks.
    visionEnabled: runVisionEnabled,
  });
  // Generic web fetch (intranet + internet, proxy-aware). Registration follows
  // the tool-group picker; the HANDLER gates on `elevated` — the PreToolUse
  // hook auto-allows every mcp__* call, so registration alone is not the gate.
  const webFetchServer = buildWebFetchServer({ elevated: elevatedToolAccess });
  // hex-ssh (remote-server access MCP, ssh2-based — no system ssh binary needed):
  // registered explicitly (not via a plugin's .mcp.json) so we can inject the
  // owner's per-user SSH identity. The policy proxy filters tools/list before
  // the model sees it, and the PreToolUse hook below enforces the same allowlist
  // again on tools/call.
  const hexSshProxyPath = path.join(
    process.cwd(),
    "scripts",
    "hex-ssh-policy-proxy.mjs",
  );
  const sshActive =
    sshToolsEnabled &&
    Boolean(ownerSecrets.SSH_PRIVATE_KEY && hexSshAllowedTools.length > 0);
  // The SSH key/passphrase ride the same one-shot secret-file handoff as the
  // plugin servers: embedding them in `env` here would serialize them into the
  // CLI's --mcp-config ARGV, world-readable via /proc/<pid>/cmdline (this was
  // a real pre-wrapper exposure). Only non-secret config stays in env.
  const sshSecretsFile = path.join(mcpSecretsDir, `ssh-${mcpRunId}.json`);
  if (sshActive && Object.keys(sshSecrets).length > 0) {
    fs.mkdirSync(mcpSecretsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sshSecretsFile, JSON.stringify(sshSecrets), {
      mode: 0o600,
    });
  }
  const sshServers = sshActive
    ? {
        [HEX_SSH_SERVER_NAME]: {
          type: "stdio" as const,
          command: process.execPath,
          args: [
            mcpSecretWrapperPath,
            "--secrets",
            sshSecretsFile,
            "--",
            process.execPath,
            hexSshProxyPath,
          ],
          // KNOWN_HOSTS_PATH points hex-ssh at the owner's persistent trust file
          // (under the data volume). hex-ssh re-reads it on every connection, so
          // the `mcp__ssh_trust__*` tools can add a host mid-session and it takes
          // effect immediately. SSH-specific secrets arrive via the wrapper's
          // secrets file: git credentials stay inside the app-managed git MCP
          // handlers, and no secret value enters this definition.
          env: {
            REMOTE_SSH_MODE: "safe",
            KNOWN_HOSTS_PATH: knownHostsPath(request.avatar.id, config),
            HEX_SSH_UPSTREAM_COMMAND: config.hexSshCommand,
            HEX_SSH_ALLOWED_TOOLS: hexSshAllowedTools.join(","),
          },
        },
      }
    : {};

  // A personal-agent run carries the FULL system tool set, routines included: a
  // bot schedules its own recurring work, and `routine_jobs.personal_agent_id`
  // binds each schedule to the bot that fires it. The handlers SELF-SCOPE that
  // access (a bot lists/updates/deletes only its own rows — systemTools.ts), and
  // both metacognition surfaces state the capability and its scope.
  const options: Record<string, unknown> = {
    plugins: pluginRoots,
    // The PreToolUse hook (below) is the real gate. `default` mode is required —
    // it's the mode in which the hook's deny decision is honored.
    permissionMode: "default",
    // Auto-approve (no prompt) the read-only + knowledge + meta tools. NOTE: this
    // is only an auto-approve list, NOT a restriction — the hook does enforcement.
    allowedTools: [
      ...config.readOnlyTools,
      ...(personalKnowledgeToolsEnabled ? KNOWLEDGE_TOOL_NAMES : []),
      ...(personalKnowledgeToolsEnabled ? REPO_TOOL_NAMES : []),
      ...(allowRepoCreate ? [REPO_CREATE_TOOL_NAME] : []),
      ...(systemToolsEnabled ? SYSTEM_TOOL_NAMES : []),
      ...(confluenceToolsEnabled ? CONFLUENCE_TOOL_NAMES : []),
      ...(webFetchToolsEnabled ? WEB_FETCH_TOOL_NAMES : []),
      ...(avatarDirectoryToolsEnabled ? AVATAR_DIRECTORY_TOOL_NAMES : []),
      ...(avatarAskActive ? [AVATAR_ASK_TOOL_NAME] : []),
      ...(skillExchangeActive ? SKILL_EXCHANGE_TOOL_NAMES : []),
      ...(sshToolsEnabled ? SSH_IDENTITY_TOOL_NAMES : []),
      ...(gitRepoToolsEnabled ? GIT_REPO_TOOL_NAMES : []),
      // Group-agent runs expose the pinned subset (no list_groups/create_repo).
      ...(groupRepoActive
        ? groupAgentRun
          ? GROUP_AGENT_REPO_TOOL_NAMES
          : GROUP_REPO_TOOL_NAMES
        : []),
      ...(brainActive ? BRAIN_TOOL_NAMES : []),
      ...(groupBrainActive ? GROUP_BRAIN_TOOL_NAMES : []),
      ...(groupAgentProfileActive ? GROUP_AGENT_PROFILE_TOOL_NAMES : []),
      ...(personalAgentSelfActive ? PERSONAL_AGENT_SELF_TOOL_NAMES : []),
      ...(personalAgentCreateActive ? PERSONAL_AGENT_OWNER_TOOL_NAMES : []),
      ...(canvasActive ? CANVAS_TOOL_NAMES : []),
      ...(browserActive ? BROWSER_TOOL_NAMES : []),
      ...(fileOutputActive ? FILE_OUTPUT_TOOL_NAMES : []),
      ...(sshActive ? SSH_TRUST_TOOL_NAMES : []),
      "Skill",
      "TodoWrite",
      ...TASK_ORCHESTRATION_TOOLS,
      // Silent auto-deny workaround: when the hook blanket-allows every tool
      // anyway (elevated + autoApprove — the same condition as its
      // canRunElevatedTools fast path), pre-allow the gated built-ins by RULE
      // so they never enter the CLI's ask path — 2.1.222 cancels that path in
      // turns where queued input (a background task-notification) arrived and
      // words it as a user refusal. Hook denies still override these rules.
      // See SDK_ELEVATED_BUILTIN_TOOLS for the full account.
      ...(elevated && (!headless || allowHeadlessTools) && autoApprove
        ? SDK_ELEVATED_BUILTIN_TOOLS
        : []),
    ],
    // Drop full-CLI harness tools we never use from the advertised tool list.
    // `allowedTools` only auto-approves; it does NOT restrict what the CLI offers,
    // so these (Monitor/Cron*/Worktree/…) would otherwise ride along on every
    // request as unused tool descriptions. Workflow is deliberately NOT dropped
    // here — see UNUSED_SDK_BUILTIN_TOOLS. See the constant.
    disallowedTools: Array.from(
      new Set([
        ...UNUSED_SDK_BUILTIN_TOOLS,
        // Admin policy: bare tool names remove built-ins from the advertised
        // set entirely; `Skill(<name>)` denies that one skill's invocation at
        // the CLI layer (the skill may still be LISTED — the skills allowlist
        // below and the PreToolUse hook cover that side).
        ...disallowedEntriesForPolicy(toolSkillPolicy),
      ]),
    ),
    // Enable bundled + plugin skills (also auto-allows the `Skill` tool).
    // "all" unless the admin disabled skills AND the discovery cache is fresh
    // for the bundled CLI version — then an explicit allowlist hides them from
    // the model's skill listing. Visibility is fail-open (a stale/missing
    // cache must never make skills vanish), execution stays fail-closed (the
    // hook denies disabled skills regardless).
    skills: computeSkillsOption(
      toolSkillPolicy,
      freshSkillDiscoveryCache(store),
      pluginRoots.map((root) => root.path),
    ),
    // Only the servers registered HERE exist: the CLI's own MCP discovery
    // (plugin .mcp.json, cwd project .mcp.json, user settings) is disabled so
    // plugin servers can't double-spawn beside the lifted, secret-injected
    // registrations below — and so an opened work repo's .mcp.json can't
    // register servers behind the app's back.
    strictMcpConfig: true,
    // Register the SSH host-trust server alongside hex-ssh, and only when hex-ssh
    // itself is active (the owner stored a key) — trust management is pointless
    // without a server to connect.
    mcpServers: {
      // Plugin-provided servers first: every app-managed name spread after
      // this wins a collision, so a plugin can't shadow an app server. A
      // consultation run gets NO plugin servers at all — third-party servers
      // can't self-gate per viewer, so registration is their only gate.
      ...(consultationRun ? {} : liftedPluginMcpServers),
      ...(personalKnowledgeToolsEnabled
        ? { [KNOWLEDGE_SERVER_NAME]: knowledgeServer }
        : {}),
      ...(personalKnowledgeToolsEnabled
        ? { [REPO_SERVER_NAME]: repoServer }
        : {}),
      ...(systemToolsEnabled ? { [SYSTEM_SERVER_NAME]: systemServer } : {}),
      ...(confluenceToolsEnabled
        ? { [CONFLUENCE_SERVER_NAME]: confluenceServer }
        : {}),
      ...(webFetchToolsEnabled
        ? { [WEB_FETCH_SERVER_NAME]: webFetchServer }
        : {}),
      ...(avatarDirectoryToolsEnabled
        ? { [AVATAR_DIRECTORY_SERVER_NAME]: avatarDirectoryServer }
        : {}),
      ...(skillExchangeActive
        ? { [SKILL_EXCHANGE_SERVER_NAME]: skillExchangeServer }
        : {}),
      ...(sshToolsEnabled
        ? { [SSH_IDENTITY_SERVER_NAME]: sshIdentityServer }
        : {}),
      ...(gitRepoToolsEnabled ? { [GIT_REPO_SERVER_NAME]: gitRepoServer } : {}),
      ...(groupRepoActive ? { [GROUP_REPO_SERVER_NAME]: groupRepoServer } : {}),
      ...(brainActive ? { [BRAIN_SERVER_NAME]: brainServer } : {}),
      ...(groupBrainActive
        ? { [GROUP_BRAIN_SERVER_NAME]: groupBrainServer }
        : {}),
      ...(groupAgentProfileServer
        ? { [GROUP_AGENT_PROFILE_SERVER_NAME]: groupAgentProfileServer }
        : {}),
      ...(personalAgentServer
        ? { [PERSONAL_AGENT_SERVER_NAME]: personalAgentServer }
        : {}),
      ...(canvasServer ? { [CANVAS_SERVER_NAME]: canvasServer } : {}),
      ...(browserServer ? { [BROWSER_SERVER_NAME]: browserServer } : {}),
      ...(fileOutputServer
        ? { [FILE_OUTPUT_SERVER_NAME]: fileOutputServer }
        : {}),
      ...sshServers,
      ...(sshActive ? { [SSH_TRUST_SERVER_NAME]: sshTrustServer } : {}),
    },
    maxTurns: config.maxTurns,
    // Isolation mode: load NO filesystem settings, so we never leak the operator's
    // machine config (MCP servers, enabled plugins, env, CLAUDE.md) into a chat.
    settingSources: [],
  };
  // Persist session transcripts under dataDir (not the SDK's default ~/.claude)
  // so a conversation's session can be resumed after a server/container restart.
  // `env` REPLACES the subprocess environment. Start from process.env for SDK
  // auth/proxy settings, but strip git credentials: git auth is only available
  // through the app-managed in-process MCP bridge.
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  options.env = {
    ...agentSubprocessEnv(
      process.env,
      config.agentSessionsDir,
      // The admin `agent_teams` toggle turns off the CLI teams runtime too,
      // not just the SendMessage tool (read fresh per run like the rest of
      // the policy).
      isAgentTeamsDisabled(toolSkillPolicy),
    ),
    // Per-key OPT-IN shell exposure (elevated runs only): `$NAME` works in
    // Bash and in anything the CLI spawns. The PostToolUse hook below redacts
    // these values from every tool output before the model sees it, and
    // non-owned lifted MCP servers get them blanked (maskEnvNames above).
    ...shellSecretEnv,
  };
  // Subscription auth: when no ANTHROPIC_API_KEY is configured, fall back to the
  // admin-pasted `claude setup-token` token (stored encrypted in app_config),
  // injecting it as CLAUDE_CODE_OAUTH_TOKEN. Precedence is API key (.env) > stored
  // subscription token, matching the authMode reported by /api/admin/system. The
  // token is decrypted only here into the subprocess env — never exposed to the
  // agent (Bash/`env` run in a separate process), same as the secret vault. We
  // also drop any empty ANTHROPIC_API_KEY left over from `.env` so it can't shadow
  // the OAuth token.
  if (!config.anthropicApiKey) {
    const oauthToken = store.getAppSecret(CLAUDE_OAUTH_TOKEN_KEY);
    if (oauthToken) {
      delete (options.env as Record<string, string | undefined>)
        .ANTHROPIC_API_KEY;
      (
        options.env as Record<string, string | undefined>
      ).CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
  }
  // Resume the conversation's prior session so the model keeps its context.
  if (request.resumeSessionId) {
    options.resume = request.resumeSessionId;
  }
  // Pin the model when configured (env or admin override); otherwise the SDK default.
  if (effectiveModel) {
    options.model = effectiveModel;
  }
  // Apply the user's reasoning effort when they picked one; otherwise omit it so
  // the SDK uses its default. The SDK downgrades unsupported levels per model.
  if (userEffort) {
    options.effort = userEffort;
  }
  // Override the autocompact trigger window when the operator set one (env
  // AUTO_COMPACT_WINDOW). It rides the SDK `settings` option — typed
  // `string | Settings`, where `Settings.autoCompactWindow` is a real field and a
  // bare string means a settings-FILE path, so inline values go as an OBJECT and
  // the SDK serializes it into the CLI `--settings` JSON. It is NOT a top-level
  // SDK option: the pinned Options has no such field and drops unknown keys
  // silently, and `options` is a loose Record so tsc can't catch that.
  // `settingSources: []` above does not suppress it (flag settings always load),
  // and the CLI's settings schema drops out-of-range values, which is why
  // config.ts clamps to 100K–1M. Omitted → the CLI compacts near the model's
  // full context window.
  if (config.autoCompactWindow) {
    options.settings = { autoCompactWindow: config.autoCompactWindow };
  }
  if (streaming) {
    options.includePartialMessages = true;
  }
  if (abortController) {
    options.abortController = abortController;
  }
  // Confine the run to this session's workspace + the avatar's plugin dirs.
  if (request.cwd) {
    options.cwd = request.cwd;
  }
  // Plugin roots are always exposed as additional readable/writable dirs; an
  // active repo workspace (#47) also adds the per-conversation scratch dir here
  // (its clone became the cwd, so the scratch must stay reachable).
  const additionalDirectories = [
    ...pluginRoots.map((root) => root.path),
    ...(request.additionalDirs ?? []),
  ];
  if (additionalDirectories.length > 0) {
    options.additionalDirectories = additionalDirectories;
  }

  // PreToolUse hook: enforcement + interactivity. Runs in-process, so it can call
  // straight into the events sink and await the user.
  if (events) {
    // Redaction set: every injectable value that can actually reach a process
    // this run (shell-exposed env and/or the plugin-MCP wrapper files). Tool
    // outputs echoing one of these come back `[REDACTED:<NAME>]`.
    // The broad exposures (shell env / plugin-MCP wrapper files) hand the WHOLE
    // injectable vault to a process, so everything in it is redactable; browser
    // input exposes only the individually opted-in names, and its set is a
    // subset of the broad one, so this reads as a merge either way.
    const redactSecretEnv =
      Object.keys(shellSecretEnv).length > 0 || lifted.secretFiles.length > 0
        ? injectableSecretEnv
        : browserSecretEnv;
    options.hooks = {
      PreToolUse: [
        {
          hooks: [
            buildPreToolUseHook(
              events,
              elevated,
              config.readOnlyTools,
              headless,
              allowHeadlessTools,
              autoApprove,
              hexSshViewerClass,
              hexSshPolicy,
              // Active repo workspace (#47): block remote/branch/destructive Bash
              // git so sync/push stay app-managed; local add/commit is allowed.
              Boolean(request.activeRepoName),
              toolSkillPolicy,
              // Text-only model this run: deny image/PDF Read before it 400s the turn.
              runVisionEnabled,
              // Personal-bot run: AskUserQuestion is redirected to the
              // turn-boundary protocol (report_task 'need_input' + end the turn)
              // instead of parking on a modal nobody may be there to answer.
              // The scope additionally confines native Write/Edit inside the
              // owner's knowledge clone to this bot's own memory folder — the
              // same root the scoped repo/brain servers enforce.
              personalAgentScope
                ? {
                    clonePath: knowledgeClonePath(request.avatar.id, config),
                    memoryRoot: personalAgentScope.root,
                  }
                : false,
            ),
          ],
          // CLI-side budget for this hook, in SECONDS. The CLI aborts an SDK
          // callback hook after 10 minutes by default, and CLIs before 2.1.218
          // misreport that abort to the model as a USER REJECTION — fatal here,
          // because this hook legitimately parks while the owner answers the
          // permission/question/plan modal. Pin the budget just above the run
          // registry's PROMPT_TTL_MS so the server always settles the prompt
          // first; the CLI timeout remains only a dead-man's switch.
          timeout: Math.ceil(PROMPT_TTL_MS / 1000) + 60,
        },
      ],
      ...(Object.keys(redactSecretEnv).length > 0
        ? {
            PostToolUse: [
              { hooks: [buildPostToolUseHook(redactSecretEnv)] },
            ],
          }
        : {}),
    };
  }

  return {
    sdk,
    streaming,
    options,
    // Consumed by the loop for the usage/prompt branches (ownerToolAccess) and
    // the proxy-state notice (webFetchProxyState); both are bound by
    // destructures up top rather than named consts.
    ownerToolAccess,
    webFetchProxyState,
    owner,
    ownerState,
    ownerGroups,
    ownerSecrets,
    groupAgentState,
    personalAgentState,
    personalAgentCreateActive,
    effectiveModel,
    modelChain,
    runVisionEnabled,
    agentStart,
    knowledgeRepoConfigured,
    sharedAccount,
    toolSkillPolicy,
    registeredMcpToolGroups,
    adminBlockedMcpToolGroups,
    runKindBlockedMcpToolGroups,
    browserActive,
    canvasActive,
    fileOutputActive,
    skillExchangeActive,
    deckRenderingAvailable,
    deckToolchain,
    deckAuthoring,
  };
}

/** Everything `runClaudeAgent`'s streaming loop consumes from the plan. */
export type AgentRunPlan = Awaited<ReturnType<typeof buildAgentRunPlan>>;
