/**
 * The backend-agnostic half of a run plan (design N1): who may do what, which
 * in-process MCP servers this run builds, the model chain, and the self-state
 * BOTH metacognition surfaces report. The Claude Agent SDK runner wraps it into
 * its `options` bag (`runPlan.ts` → `buildAgentRunPlan`); the pi runner
 * (`pi/runPiAgent.ts`) serves the same servers over the HTTP MCP endpoint. One
 * derivation for both runners keeps their gates from drifting.
 *
 * ONE thing flows backwards. File-output and browser-screenshot attachments are
 * stamped with the length of the assistant text accumulated when the tool ran,
 * and that accumulator lives in the run loop AND is REASSIGNED there on the
 * empty-turn retry. So it arrives as `currentTextAnchor()` — an accessor read
 * at call time. Passing the array itself would silently stamp against a stale
 * binding after a retry.
 *
 * The setup half declares NO `let` (agent/CLAUDE.md) — keep it that way.
 */
import type {
  AppConfig,
  AgentRequest,
  AgentOwner,
  AgentRuntime,
  PiRuntimeFacts,
  PluginRoot,
} from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents, FileOutputResult } from "./events.js";
import {
  deckAuthoringStatusFor,
  deckGuidanceFlags,
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
import {
  GIT_CREDENTIAL_ENV_NAMES,
  SSH_MCP_SECRET_ENV_NAMES,
} from "../secretPolicy.js";
import {
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
import { planSharedMcpRun } from "../sharedMcpServers.js";
import { summarizeOwnerState } from "./ownerState.js";
import { resolveConversationTodoSnapshot } from "./todoSnapshot.js";
import {
  DEFAULT_MCP_TOOL_GROUPS,
  effectiveMcpToolGroups,
  type McpToolGroupId,
} from "../../shared/mcpToolGroups.js";
import {
  buildFileOutputServer,
  FILE_OUTPUT_SERVER_NAME,
  FILE_OUTPUT_SHARE_LINK_TOOL_NAME,
  FILE_OUTPUT_TOOL_NAMES,
} from "./fileOutputTools.js";

// Same `{ module: "agent" }` tag claudeAgent.ts logs under: the plan is one
// half of a single run, so its lines must stay indistinguishable in the log.
const agentLogger = logger.child({ module: "agent" });

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
 * selection; `registered` — not the raw selection — is what the prompt and
 * describe_system must report, or the avatar advertises tools that don't exist
 * (meta-cognition invariant). Pure like deriveAgentToolAccess: the run
 * assembly consumes THESE booleans for server registration, so report and
 * reality can't drift.
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
}

export function planMcpToolFamilies(enabled: McpToolGroupId[]): McpToolFamilyPlan {
  const has = (id: McpToolGroupId) => enabled.includes(id);
  const byId: Record<McpToolGroupId, boolean> = {
    personal_knowledge: has("personal_knowledge"),
    group_knowledge: has("group_knowledge"),
    git_repo: has("git_repo"),
    confluence: has("confluence"),
    web: has("web"),
    ssh: has("ssh"),
    avatars: has("avatars"),
    canvas: has("canvas"),
    browser: has("browser"),
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
  };
}

/**
 * The run's CONVERSATION scratch workspace: where tools that hand the model a
 * file of its own (get_attachment's `save_to_workspace`) write, and the path
 * describe_system names. Every run kind that has one sets it the same way —
 * the chat route's executeChatTurn (own-avatar, teammate and
 * external-task-API turns) and the owner-routine scheduler both pass
 * `cwd: activeRepoCwd ?? workspaceDir` with
 * `additionalDirs: activeRepoCwd ? [workspaceDir] : undefined`, and set
 * `activeRepoName` together with that clone cwd. So an open working repo (#47)
 * moved the scratch into `additionalDirs` — the clone is the cwd, never the
 * scratch — and otherwise the scratch IS the cwd. A run with no conversation
 * (profile generators, avatar consultations) has a per-feature cwd, not a
 * conversation workspace: undefined. Pure and exported so the rule is pinned.
 */
export function conversationScratchDir(
  request: Pick<AgentRequest, "conversationId" | "cwd" | "additionalDirs" | "activeRepoName">,
): string | undefined {
  if (!request.conversationId) return undefined;
  return request.activeRepoName ? request.additionalDirs?.[0] : request.cwd;
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

/** Which runner consumes the plan — it decides what the run REALLY has. */
export interface RunCapabilityOptions {
  /**
   * `pi`: the run executes on pi-gateway (docs/architecture/pi-runtime.md).
   * Servers that only exist as CLI subprocesses (hex-ssh, plugin `.mcp.json`,
   * admin 공용 MCP) are not proxied onto the HTTP MCP endpoint yet, so they are
   * withheld here and BOTH metacognition surfaces report them absent.
   */
  runtime?: Extract<AgentRuntime, "claude" | "pi">;
  /** pi runs: the sandbox path of this conversation's work folder (`/workspace/c/<seg>`). */
  piConversationDir?: string;
}

/**
 * Derive everything a run needs before its stream opens, for either runner:
 * tool access, the in-process MCP servers, the model chain and the
 * prompt/self-state inputs. Pure with respect to the run loop — it reads
 * store/config and builds servers, but touches none of the loop's accumulators.
 */
export async function buildRunCapabilities(
  request: AgentRequest,
  pluginRoots: PluginRoot[],
  config: AppConfig,
  store: Store,
  events: AgentEvents | undefined,
  abortController: AbortController | undefined,
  currentTextAnchor: () => number,
  runOptions: RunCapabilityOptions = {},
) {
  const runtime = runOptions.runtime ?? "claude";
  const piRun = runtime === "pi";
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
    confluenceCredentialsConfigured,
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
  const { buildGroupRepoServer, GROUP_REPO_SERVER_NAME, GROUP_REPO_TOOL_NAMES } =
    await import("./groupRepoTools.js");
  const { buildBrowserServer, BROWSER_SERVER_NAME, BROWSER_TOOL_NAMES } =
    await import("./browserTools.js");
  const { buildCanvasServer, CANVAS_SERVER_NAME, CANVAS_TOOL_NAMES } =
    await import("./canvasTools.js");
  const { buildBrainServer, BRAIN_SERVER_NAME, BRAIN_TOOL_NAMES } =
    await import("./brainTools.js");
  const { buildGroupBrainServer, GROUP_BRAIN_SERVER_NAME, GROUP_BRAIN_TOOL_NAMES } =
    await import("./groupBrainTools.js");
  const {
    buildTodoServer,
    TODO_SERVER_NAME,
    TODO_TOOL_NAMES,
    TODO_DELETE_TOOL_NAME,
  } = await import("./todoTools.js");

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
  // The plan is the SINGLE source for the family booleans AND for `registered`
  // — the set the prompt and describe_system report — so report and reality
  // can't drift.
  const familyPlan = planMcpToolFamilies(enabledMcpToolGroups);
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
      runtime,
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
  // call sites can't drift in WHAT they read.
  const ownerState = summarizeOwnerState(store, config, request.avatar.id);
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
  });
  const fileOutputActive = Boolean(request.cwd && events?.onFile);
  // PPTX share links (create_share_link on the file_output server): a bearer
  // URL that reaches OUTSIDE this conversation, so unlike show_file/share_file
  // it needs a PERSON who asked for it in a chat with their OWN avatar. Every
  // run kind that can execute with nobody watching — or on someone else's
  // instructions — is excluded: consultations, routines and external-task API
  // turns (not headless, so they need their own exclusion).
  // The chat route supplies `onShareLink` only on those same interactive
  // own-avatar turns and re-checks that per call. Computed HERE, before
  // buildSystemServer, so describe_system reports the same boolean the tool,
  // allowedTools and the prompt stamp all key on.
  const shareLinkToolActive =
    fileOutputActive &&
    Boolean(events?.onShareLink) &&
    ownerToolAccess &&
    !consultationRun &&
    !request.headless &&
    !request.externalTaskApi;
  // Visual canvas (#50; graduated from the experimental `canvas` flag): registered
  // on every turn whose canvas tool group is on AND that has a canvas sink
  // (events.onCanvas, the interactive chat route) — colleagues chatting with an
  // avatar get canvases too (the feature grants no elevation; the handler
  // self-gates nothing because showing UI is harmless). Computed here, before
  // buildSystemServer, so describe_system reports it.
  const canvasActive = canvasToolsEnabled && Boolean(events?.onCanvas);
  // 할 일 (the owner's persistent work to-do list, `mcp__todo__*`): OWNER-DRIVEN
  // runs only — an interactive own-avatar chat, an owner routine, an
  // external-task-API turn. Never a teammate's chat or a consultation
  // (another avatar's question). It rides the always-on
  // system family rather than a tool group of its own, so a saved tool-group
  // selection or a group's MCP policy can never silently drop it. delete_todo
  // is withheld from API turns: their message is machine-authored, so this is a
  // speed bump against an injected, irreversible removal of items — not a full
  // boundary (update_todo stays, and a leaked key IS the owner's session per
  // CLAUDE.md). Computed before buildSystemServer so
  // describe_system reports the SAME booleans the server build, allowedTools
  // and the prompt stamp key on.
  const todoToolsActive =
    systemToolsEnabled && ownerToolAccess && !consultationRun;
  const todoDeleteActive = todoToolsActive && !request.externalTaskApi;
  // The 할 일 list as the prompt states it: FROZEN per conversation at its first
  // to-do-capable turn and only read back afterwards (agent/todoSnapshot.ts —
  // a write-once store call, so a re-plan or retry reads the same snapshot).
  // Same gate as the tools: a teammate's or consultation run never
  // takes or sees the owner's list.
  const todoSnapshot =
    todoToolsActive && request.conversationId
      ? resolveConversationTodoSnapshot(store, request.avatar.id, request.conversationId)
      : null;
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
  // The avatar acts on its OWNER's behalf, so it uses the OWNER's secrets
  // (avatar.id) regardless of who is chatting — a colleague talking to the
  // owner's avatar still operates with the owner's credentials. The values are
  // decrypted only here and handed to the MCP subprocess as env, so they never
  // surface to the agent (Bash/`env` runs in a different process) nor to `toUser`.
  // Read ahead of describe_system's ctx, which reports what the Confluence PAT
  // allows.
  const ownerSecrets = store.getUserSecrets(request.avatar.id);
  // The run's conversation scratch workspace (conversationScratchDir) — where
  // get_attachment's save_to_workspace writes, and the path describe_system names.
  const scratchWorkspaceDir = conversationScratchDir(request);
  // save_to_workspace can LAND this run: the Confluence family is registered,
  // the viewer passes the tools' own `elevated` gate, the run has a scratch
  // workspace, and URL + owner PAT pass the tools' own credential check. ONE
  // derivation for both metacognition surfaces: describe_system's ctx below,
  // and the prompt through the returned plan.
  const confluenceSaveToWorkspace =
    confluenceToolsEnabled &&
    elevatedToolAccess &&
    Boolean(scratchWorkspaceDir) &&
    confluenceCredentialsConfigured(config, ownerSecrets);
  // Whether this run can write files at all: the elevated built-in class
  // (Write/Edit/Bash) the PreToolUse hook gates — the same gate deckAuthoring
  // uses. A read-only run is told the conversation's files exist and can be
  // read, but cannot be placed into anything it produces. ONE flag for both
  // metacognition surfaces: describe_system's ctx below, and the prompt
  // through the returned plan.
  const canWriteFiles = elevatedToolAccess;
  // hex-ssh registration (the server itself is built further down). Computed
  // HERE so describe_system's SSH line reports this boolean, not secret names.
  // hex-ssh is a CLI-spawned stdio server: a pi run has no route to it until
  // Noah proxies it onto the HTTP MCP endpoint (docs/architecture/pi-runtime.md).
  const sshActive =
    !piRun &&
    sshToolsEnabled &&
    Boolean(ownerSecrets.SSH_PRIVATE_KEY && hexSshAllowedTools.length > 0);
  // 공용 MCP 서버 (admin-registered external HTTP MCP servers,
  // sharedMcpServers.ts): resolved HERE so describe_system's ctx, the
  // registration below and the prompt stamp read ONE derivation. A server's
  // credential slots fill from the secrets the OWNER bound to them (for the
  // server's current origin) — only on runs that may carry the vault, the
  // plugin-MCP injection line (elevated); otherwise, or
  // with a slot unbound, the server sits this run out (user decision
  // 2026-10-26). A consultation run gets no external servers at all, exactly
  // like plugin servers, and neither does a restricted headless run (intro /
  // hashtag generation) — it has no use for third-party tools.
  // A pi run gets none either, for now: admin servers are CLI-registered
  // (natively or through the stdio bridge) and not yet proxied onto the HTTP
  // MCP endpoint (docs/architecture/pi-runtime.md).
  const sharedMcpPlan = consultationRun || (headless && !allowHeadlessTools) || piRun
    ? null
    : planSharedMcpRun(store.getSharedMcpServers(), {
        bindings: store.listSharedMcpBindings(request.avatar.id),
        secrets: mcpInjectableSecretEnv(ownerSecrets),
        secretsAllowed: elevatedToolAccess,
      });
  // Slot and secret NAMES are owner self-state (the prompt's secret-name list
  // rides owner runs only): any other viewer hears THAT one is missing.
  const sharedMcpStates = sharedMcpPlan?.states.map((state) =>
    ownerToolAccess ? state : { ...state, unboundSlots: [], missingSecrets: [] },
  );
  // pi self-state, ONE value for both metacognition surfaces (describe_system
  // here, the prompt through stampPromptRequest).
  const piRuntimeFacts: PiRuntimeFacts | undefined = piRun
    ? {
        ...(runOptions.piConversationDir ? { conversationDir: runOptions.piConversationDir } : {}),
        // Owner self-state (the names), like the prompt's secret list.
        shellSecretsUnavailable: ownerToolAccess ? ownerState.shellExposedSecretNames : [],
      }
    : undefined;
  const systemServer = buildSystemServer(store, {
    avatarUserId: request.avatar.id,
    owner,
    viewerIsOwner: ownerToolAccess,
    config,
    selectedModelTier: userModelTier,
    selectedEffort: userEffort,
    // The REGISTERED set (not the raw selection).
    enabledMcpToolGroups: registeredMcpToolGroups,
    // The working repo opened for this conversation (NAME only — the clone path is
    // never surfaced). Mirrors buildPrompt's activeRepoSection in describe_system.
    activeRepoName: request.activeRepoName,
    fileOutputEnabled: fileOutputActive,
    // create_share_link registration (shareLinkToolActive above): describe_system
    // states it as available, or names why not and points at the 공유 링크 button.
    shareLinksEnabled: shareLinkToolActive,
    // The to-do tools' registration (todoToolsActive / todoDeleteActive above).
    todoToolsEnabled: todoToolsActive,
    todoDeleteEnabled: todoDeleteActive,
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
    // Rewind provenance: the SAME gate as the prompt's per-turn line (never on
    // an unattended run), so the two surfaces report the same turn.
    rewind: request.headless ? undefined : request.rewind,
    // Images for documents and decks: the scratch workspace path to name,
    // whether get_attachment's save_to_workspace may be offered, and whether
    // this run may place those files at all.
    // A pi run names its SANDBOX folder (the host scratch path means nothing
    // to a model in the sandbox; lane I2 moves the staged copies there too).
    scratchWorkspaceDir: piRun ? (runOptions.piConversationDir ?? scratchWorkspaceDir) : scratchWorkspaceDir,
    confluenceSaveToWorkspace,
    canWriteFiles,
    // SSH self-state from the SAME boolean the registration below uses.
    sshEnabled: sshActive,
    sharedMcpServers: sharedMcpStates,
    // pi-gateway runs: what this runtime really has (sandbox folder, steer
    // timing, shell secrets, model switches) — mirrored by the prompt's pi
    // section (promptBuilder piRuntimeSection).
    ...(piRuntimeFacts ? { piRuntime: piRuntimeFacts } : {}),
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
  // not browse it (their own avatar serves their view). skillExchangeActive is
  // the SINGLE boolean used byte-identically in allowedTools + mcpServers.
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
  // A single `active` boolean + a single server value so allowedTools/mcpServers
  // can't drift.
  const groupRepoActive =
    groupKnowledgeToolsEnabled && ownerToolAccess && ownerGroups.length > 0;
  // Group second-brain capture notice, mirroring the personal repo's onMemory.
  const onGroupMemory = (e: { action: "add" | "update"; path: string; groupName: string }) =>
    events?.onMemory?.({ ...e, scope: "group" });
  const groupRepoServer = buildGroupRepoServer(store, {
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
    ownerToolAccess &&
    ownerGroups.some((g) => g.knowledgeRepoConfigured);
  const groupBrainServer = buildGroupBrainServer(store, {
    avatarUserId: request.avatar.id,
    viewerIsOwner: ownerToolAccess,
    config,
  });
  // To-do server (todoToolsActive above). The handlers re-check viewerIsOwner
  // — registration is not the boundary under the mcp__ auto-allow — and stamp
  // each new item with WHO added it and the conversation it came from.
  const todoServer = todoToolsActive
    ? buildTodoServer(store, {
        avatarUserId: request.avatar.id,
        owner,
        viewerIsOwner: ownerToolAccess,
        source: request.externalTaskApi ? "api" : request.headless ? "routine" : "avatar",
        conversationId: request.conversationId,
        deleteEnabled: todoDeleteActive,
      })
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
        // create_share_link is built from the SAME boolean as its allowedTools
        // entry below, describe_system's ctx above and claudeAgent's prompt
        // stamp, so the four can't drift. The handler still refuses without
        // the host callback.
        ...(shareLinkToolActive
          ? {
              shareLinkEnabled: true,
              createShareLink: events!.onShareLink,
              // Read live per call (an app_config value, cached per
              // ciphertext): whether "anyone signed in" really means anyone
              // who can reach Noah, for the result's audience caveat.
              signupOpen: () => store.getSignupMode() === "open",
            }
          : {}),
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

  // The owner's vault minus the reserved git/SSH names: what the browser
  // server's secret input resolves from, and what the SDK half hands its
  // MCP subprocesses / redaction set.
  const injectableSecretEnv = mcpInjectableSecretEnv(ownerSecrets);
  // Conversation ids are never reused, so "the row still exists" is the whole
  // liveness test of the Confluence save path.
  const conversationIdForLiveness = request.conversationId;
  const confluenceServer = buildConfluenceServer({
    config,
    ownerSecrets,
    elevated: elevatedToolAccess,
    // Text-only model this run → attachment tools return notes, not image blocks.
    visionEnabled: runVisionEnabled,
    // get_attachment's save_to_workspace target: the conversation scratch
    // workspace, never an open repo clone (undefined → the option refuses).
    workspaceDir: scratchWorkspaceDir,
    // A save that lands after the conversation was deleted (its copy sweep
    // already ran) is undone: conversation ids are never reused, so "the row
    // still exists" is the whole liveness test.
    isConversationLive: conversationIdForLiveness
      ? () => store.conversationOwner(conversationIdForLiveness) !== null
      : undefined,
  });
  // Generic web fetch (intranet + internet, proxy-aware). Registration follows
  // the tool-group picker; the HANDLER gates on `elevated` — the PreToolUse
  // hook auto-allows every mcp__* call, so registration alone is not the gate.
  const webFetchServer = buildWebFetchServer({ elevated: elevatedToolAccess });
  // App in-process MCP servers this run registers (the SDK half adds hex-ssh
  // and reports any plugin server of the same name — these always override it).
  const inProcessMcpServers: Record<string, unknown> = {
    ...(personalKnowledgeToolsEnabled
      ? { [KNOWLEDGE_SERVER_NAME]: knowledgeServer }
      : {}),
    ...(personalKnowledgeToolsEnabled
      ? { [REPO_SERVER_NAME]: repoServer }
      : {}),
    ...(systemToolsEnabled ? { [SYSTEM_SERVER_NAME]: systemServer } : {}),
    ...(todoServer ? { [TODO_SERVER_NAME]: todoServer } : {}),
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
    ...(canvasServer ? { [CANVAS_SERVER_NAME]: canvasServer } : {}),
    ...(browserServer ? { [BROWSER_SERVER_NAME]: browserServer } : {}),
    ...(fileOutputServer
      ? { [FILE_OUTPUT_SERVER_NAME]: fileOutputServer }
      : {}),
    // The SSH host-trust server rides alongside hex-ssh, and only when hex-ssh
    // itself is active (the owner stored a key) — trust management is pointless
    // without a server to connect.
    ...(sshActive ? { [SSH_TRUST_SERVER_NAME]: sshTrustServer } : {}),
  };

  // The MCP half of the SDK's `allowedTools`, and the pi endpoint's per-call
  // gate: exactly the tools the servers above register for THIS run.
  const mcpAllowedTools: string[] = [
      ...(personalKnowledgeToolsEnabled ? KNOWLEDGE_TOOL_NAMES : []),
      ...(personalKnowledgeToolsEnabled ? REPO_TOOL_NAMES : []),
      ...(allowRepoCreate ? [REPO_CREATE_TOOL_NAME] : []),
      ...(systemToolsEnabled ? SYSTEM_TOOL_NAMES : []),
      ...(todoToolsActive ? TODO_TOOL_NAMES : []),
      // Its own entry on the SAME boolean as its registration (not in TODO_TOOL_NAMES).
      ...(todoDeleteActive ? [TODO_DELETE_TOOL_NAME] : []),
      ...(confluenceToolsEnabled ? CONFLUENCE_TOOL_NAMES : []),
      ...(webFetchToolsEnabled ? WEB_FETCH_TOOL_NAMES : []),
      ...(avatarDirectoryToolsEnabled ? AVATAR_DIRECTORY_TOOL_NAMES : []),
      ...(avatarAskActive ? [AVATAR_ASK_TOOL_NAME] : []),
      ...(skillExchangeActive ? SKILL_EXCHANGE_TOOL_NAMES : []),
      ...(sshToolsEnabled ? SSH_IDENTITY_TOOL_NAMES : []),
      ...(gitRepoToolsEnabled ? GIT_REPO_TOOL_NAMES : []),
      ...(groupRepoActive ? GROUP_REPO_TOOL_NAMES : []),
      ...(brainActive ? BRAIN_TOOL_NAMES : []),
      ...(groupBrainActive ? GROUP_BRAIN_TOOL_NAMES : []),
      ...(canvasActive ? CANVAS_TOOL_NAMES : []),
      ...(browserActive ? BROWSER_TOOL_NAMES : []),
      ...(fileOutputActive ? FILE_OUTPUT_TOOL_NAMES : []),
      // Nested in the file_output server below; built only on this boolean.
      ...(shareLinkToolActive ? [FILE_OUTPUT_SHARE_LINK_TOOL_NAME] : []),
      ...(sshActive ? SSH_TRUST_TOOL_NAMES : []),
  ];

  return {
    runtime,
    streaming,
    headless,
    allowHeadlessTools,
    ownerToolAccess,
    elevatedToolAccess,
    elevated,
    autoApprove,
    consultationRun,
    hexSshViewerClass,
    hexSshPolicy,
    hexSshAllowedTools,
    webFetchProxyState,
    ownerState,
    ownerGroups,
    ownerSecrets,
    injectableSecretEnv,
    browserSecretPolicies,
    effectiveModel,
    userModelTier,
    userEffort,
    modelChain,
    runVisionEnabled,
    agentStart,
    knowledgeRepoConfigured,
    sharedAccount,
    toolSkillPolicy,
    registeredMcpToolGroups,
    adminBlockedMcpToolGroups,
    browserActive,
    canvasActive,
    fileOutputActive,
    shareLinkToolActive,
    skillExchangeActive,
    todoToolsActive,
    todoDeleteActive,
    todoSnapshot,
    deckRenderingAvailable,
    deckToolchain,
    deckAuthoring,
    // For the prompt's matching standing guidance: the same booleans
    // describe_system's ctx got above. (The scratch path itself rides
    // describe_system's ctx only.)
    confluenceSaveToWorkspace,
    canWriteFiles,
    sshActive,
    sharedMcpPlan,
    // 공용 MCP self-state for the prompt stamp (the SAME states describe_system
    // got; undefined on a consultation run).
    sharedMcpStates,
    inProcessMcpServers,
    mcpAllowedTools,
    piRuntimeFacts,
  };
}

export type RunCapabilities = Awaited<ReturnType<typeof buildRunCapabilities>>;

/**
 * The request as BOTH prompt builders see it: the run's capability booleans
 * and self-state stamped on, each through the SAME gate as its tool
 * registration (so the prompt never advertises a tool the run lacks, and
 * describe_system — built from the same plan — agrees). Shared by the SDK and
 * pi runners.
 */
export function stampPromptRequest(
  request: AgentRequest,
  capabilities: RunCapabilities,
  config: AppConfig,
  events: AgentEvents | undefined,
): AgentRequest {
  const {
    ownerToolAccess,
    webFetchProxyState,
    ownerState,
    ownerGroups,
    ownerSecrets,
    runVisionEnabled,
    knowledgeRepoConfigured,
    sharedAccount,
    toolSkillPolicy,
    registeredMcpToolGroups,
    adminBlockedMcpToolGroups,
    browserActive,
    canvasActive,
    fileOutputActive,
    shareLinkToolActive,
    skillExchangeActive,
    todoToolsActive,
    todoDeleteActive,
    todoSnapshot,
    deckRenderingAvailable,
    deckToolchain,
    deckAuthoring,
    confluenceSaveToWorkspace,
    canWriteFiles,
    sharedMcpStates,
  } = capabilities;
  // Deck standing guidance: the deployment toolchain (legacy and/or the pptx
  // skill's converter) AND a turn that can publish files (preview embeds + the
  // download card) AND a viewer allowed to author — deckAuthoring, the SAME
  // status describe_system's deck line branches on, so a read-only colleague or
  // an admin-disabled `pptx` skill gets no deck guidance on either surface.
  const deckGuidance = deckGuidanceFlags({
    deckRenderingAvailable,
    deckConverterInstalled: deckToolchain.converter,
    fileOutputActive,
    deckAuthoring,
  });

  // Owner self-state (secret names, group memberships) flows to every
  // OWNER-DRIVEN turn: interactive owner chats AND owner-scheduled routines
  // (ownerToolAccess) — the same gate that registers the owner-level tools, so
  // prompt awareness and tool availability never diverge. Restricted headless
  // runs (intro/hashtag generation) and colleague/trusted chats keep them empty.
  return {
    ...request,
    secretNames: ownerToolAccess ? ownerState.secretNames : [],
    shellExposedSecretNames: ownerToolAccess
      ? ownerState.shellExposedSecretNames
      : [],
    // Secrets the owner enabled for BROWSER INPUT. Same owner gate as the two
    // above; the browser paragraph only renders when the bridge is actually on,
    // so a run without it never advertises names it could not type.
    browserSecrets: ownerToolAccess ? ownerState.browserSecrets : [],
    knowledgeRepoConfigured,
    // Shared-account self-state rides on EVERY viewer class (it is not a secret):
    // the teammate branch switches its repo guidance to "writes allowed" on it,
    // and the owner branch surfaces it as META-COGNITION.
    sharedAccount,
    gitTokenSet: ownerState.gitTokenSet,
    githubHost: config.githubHost,
    confluenceUrlConfigured: Boolean(config.confluenceUrl),
    confluencePatConfigured: Boolean(
      ownerSecrets.CONFLUENCE_PAT ||
      ownerSecrets.CONFLUENCE_PERSONAL_ACCESS_TOKEN,
    ),
    // get_attachment's save_to_workspace can land this run — runPlan's ONE
    // derivation, the same boolean describe_system's ctx got.
    confluenceSaveToWorkspace,
    // This run's tools may write files (runPlan's elevatedToolAccess) — the
    // same boolean describe_system's ctx got, so the vision listing's "place the
    // file" tail and the image-sources line agree for every viewer class.
    canWriteFiles,
    // Web-fetch proxy self-state (META-COGNITION): redacted HTTP(S)_PROXY/
    // NO_PROXY snapshot so the avatar knows whether external sites are
    // reachable through the corporate proxy. Mirrored by describe_system.
    webFetchProxy: webFetchProxyState(),
    groupMemberships: ownerToolAccess ? ownerGroups : [],
    // Skill-exchange self-state (#skill-share): counts ride ONLY runs that
    // registered the tools (skillExchangeActive), so the standing note and
    // tool availability can't diverge.
    learnableSkillCount: skillExchangeActive
      ? ownerState.learnableSkillCount
      : 0,
    sharedSkillCount: skillExchangeActive ? ownerState.sharedSkillCount : 0,
    // The REGISTERED set (see registeredMcpToolGroups): standing tool guidance
    // must match the servers this run actually mounts.
    mcpToolGroups: registeredMcpToolGroups,
    // Rides to the prompt ONLY so admin-blocked groups are excluded from the
    // "user deselected" standing note — the avatar is deliberately NOT told
    // that a policy exists or what it blocks (it only knows its enabled set).
    adminBlockedMcpToolGroups,
    // Canvas standing guidance fires for ALL viewer classes of a canvas-enabled
    // turn (colleagues see canvases too). Experimental-feature self-state is
    // owner-driven only (META-COGNITION), matching describe_system's gating.
    canvasEnabled: canvasActive,
    browserEnabled: browserActive,
    fileOutputEnabled: fileOutputActive,
    // Share links: rides ONLY runs that registered create_share_link (the
    // skillExchangeActive precedent), so the standing line never offers a
    // tool the run lacks; any other run with file output hears the 공유 링크
    // button redirect instead. Same boolean describe_system reports.
    shareLinksEnabled: shareLinkToolActive,
    // 할 일 capability: rides ONLY runs that registered the to-do tools
    // (runPlan's todoToolsActive — the skillExchangeActive precedent), with the
    // list FROZEN at this conversation's first such turn. No live counts: they
    // would change the per-turn append and break prompt caching.
    todoState: todoToolsActive ? { deleteEnabled: todoDeleteActive, snapshot: todoSnapshot } : undefined,
    // Deck standing guidance (see deckGuidance above): the converter branch
    // wins in promptBuilder's deckSection when both flags are set.
    deckRenderingEnabled: deckGuidance.deckRenderingEnabled,
    deckConverterEnabled: deckGuidance.deckConverterEnabled,
    visionEnabled: runVisionEnabled,
    experimentalFeatures: ownerToolAccess
      ? ownerState.experimentalFeatures
      : [],
    // Admin tool/skill policy self-state (META-COGNITION): all viewer classes —
    // a disabled skill may still show in the CLI's listing (stale discovery
    // cache), so the standing note stops the avatar from attempting/suggesting
    // it. Mirrored by describe_system.
    adminDisabledTools: toolSkillPolicy.disabledTools,
    adminDisabledSkills: toolSkillPolicy.disabledSkills,
    // External task API self-state, owner runs only: the live
    // key count, plus the CONFIGURED per-run budget — config, not store, so an
    // operator's AVATAR_TASK_TIMEOUT_MINUTES is what the avatar states, never
    // the manual's default. An API run is an owner run, so the same gate covers
    // its provenance paragraph; describe_system reads the same config value.
    avatarApiKeyCount: request.viewerIsOwner ? ownerState.avatarApiKeyCount : undefined,
    avatarTaskRunTimeoutMs: request.viewerIsOwner ? config.avatarTaskRunTimeoutMs : undefined,
    // Mid-turn messages (steers) — META-COGNITION only, no capability change:
    // this run has a live steer channel, so the viewer can keep typing while it
    // works. Same boolean describe_system reports (runPlan's system ctx).
    midTurnMessages: Boolean(events?.steers),
    // 공용 MCP 서버: runPlan's ONE derivation (the states describe_system got).
    // Every viewer class hears which servers are mounted; only the owner's
    // branches name missing secrets (the prompt section gates that).
    sharedMcpServers: sharedMcpStates,
    // pi runs: the runtime's real shape (both surfaces; see piRuntimeFacts).
    ...(capabilities.piRuntimeFacts ? { piRuntime: capabilities.piRuntimeFacts } : {}),
  };
}
