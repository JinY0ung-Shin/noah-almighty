import type {
  AgentRewindInfo,
  AppConfig,
  CraftAppRunState,
  CraftRunState,
  CraftUnavailableReason,
  GroupAgentState,
  OwnerServerAgentSummary,
  ServerAgentsUnavailableReason,
  SharedMcpRunState,
  UserGroupMembership,
} from "../types.js";
import { groupAgentCaptureAllowed } from "../groupAgents.js";
import { kstDateString } from "../routineSchedule.js";
import type { BrowserSecretPolicy } from "../secretPolicy.js";
import type { Store } from "../store.js";
import type { TodoSnapshot } from "../../shared/todos.js";
import { craftAppById } from "../../shared/craftApps.js";
import { sanitizeCraftRunnerText } from "../craftRunner.js";

/**
 * Structured, UNFORMATTED snapshot of an avatar owner's current system self-state.
 *
 * The root CLAUDE.md mandates that buildPrompt's owner self-state (claudeAgent.ts)
 * and the `describe_system` tool (systemTools.ts) report the SAME runtime facts.
 * This is the single place that reads those facts from the live `store` + `config`
 * so the two call sites can't drift in WHAT they read; each caller still FORMATS
 * the data its own way (buildPrompt → English prompt paragraphs, gated by
 * ownerToolAccess; describe_system → its tool-result text). Returning raw data
 * only — never formatted strings — keeps both existing outputs byte-identical.
 *
 * NOTE on gating: this returns the ungated facts (e.g. full `secretNames`/
 * `groups`). buildPrompt blanks `secretNames`/`groupMemberships` to `[]` unless
 * `ownerToolAccess`; describe_system always reads them live (it only runs for the
 * owner). That gating stays at the call sites, not here.
 *
 * NOTE on Confluence: the two sites compute `confluencePatConfigured` from
 * DIFFERENT sources (buildPrompt from the actual decrypted secret VALUES it
 * already holds; describe_system from secret-NAME presence). This module exposes
 * `secretNames` only and leaves the Confluence derivation to each caller, so
 * neither output changes.
 *
 * NOTE on model: this exposes the raw resolution inputs (`anthropicModel` env pin,
 * `modelOverride` admin setting) — env pin > admin override > SDK default — not a
 * formatted label, since describe_system renders its own label and buildPrompt
 * does not surface the model at all.
 */
export interface OwnerState {
  /** Active personal keys for the external task API (POST /api/v1/avatar/tasks). */
  avatarApiKeyCount: number;
  /** Whether the owner has connected a personal knowledge repo (repo set). */
  knowledgeRepoConfigured: boolean;
  /** Raw knowledge-repo connection (null when none); describe_system shows `@ branch`. */
  knowledgeRepo: { repo: string | null; branch: string | null };
  /** Whether the internal GIT_TOKEN is stored. */
  gitTokenSet: boolean;
  /** Names of the owner's configured secret-tab env vars (values never included). */
  secretNames: string[];
  /** Subset of `secretNames` opted into agent-shell exposure (per-key toggle). */
  shellExposedSecretNames: string[];
  /**
   * Secrets opted into BROWSER INPUT (per-key 브라우저 입력 toggle), with the
   * hosts each may be typed on and whether it is password-fields-only. Values
   * never included — the model gets the NAME to pass as `secretName`. Only
   * currently-usable policies appear, so both metacognition surfaces can state
   * them as fact.
   */
  browserSecrets: BrowserSecretPolicy[];
  /** Groups the owner belongs to, with role + shared-repo flag per group. */
  groups: UserGroupMembership[];
  /** Number of general (work/code) git repos the owner has registered. */
  gitRepoCount: number;
  /** Pending knowledge (request_info) gaps in the owner's inbox. */
  openRequestCount: number;
  /** Skills shared by visible teammates that this owner could learn (#skill-share). */
  learnableSkillCount: number;
  /** Skills this owner currently shares from their knowledge repo. */
  sharedSkillCount: number;
  /** Total times teammates learned this owner's skills (전수된 횟수, all skills). */
  sharedSkillLearnTotal: number;
  /** Env-pinned model (`ANTHROPIC_MODEL`); wins over the admin override. */
  anthropicModel?: string;
  /** Admin-selected model override; used when no env pin is set. */
  modelOverride: string | null;
  /** Experimental (beta) feature keys the owner enabled for this avatar (#50). */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account flag: trusted same-group teammates may also WRITE
   * to the owner's personal knowledge repo (see repoTools.ts `writeAccess`).
   */
  sharedAccount: boolean;
  /**
   * The owner's LIVE 할 일 counts against TODAY in KST, with that date.
   * describe_system is its ONLY reader, by design — a deliberate exception to
   * "an OwnerState fact feeds BOTH consumers": a per-turn append that changes
   * breaks prompt caching, so the prompt states the capability (`todoState`)
   * plus the list FROZEN at the conversation's first to-do-capable turn
   * (agent/todoSnapshot.ts), never these live numbers.
   */
  todos: TodoSnapshot;
  /**
   * The owner's registered 서버 에이전트 (enabled or not), STABLE fields only —
   * both surfaces list them: the prompt (where the avatar learns what it can
   * delegate to) and describe_system, which adds the LIVE install state and
   * sessions from the store itself.
   */
  serverAgents: OwnerServerAgentSummary[];
}

/**
 * Read the owner's current system self-state from the live store + config.
 * Pure read — no mutation. `avatarUserId` is the avatar's own user id (== owner).
 */
export function summarizeOwnerState(
  store: Store,
  config: AppConfig,
  avatarUserId: string,
): OwnerState {
  const knowledgeRepo = store.getKnowledgeRepo(avatarUserId);
  return {
    // Eager like every other field here: the key list is capped per owner, so
    // one small read is cheaper than the getter it replaced (which re-queried on
    // every access, and hid the read from `{...state}` spreads).
    avatarApiKeyCount: store.listAvatarApiKeys(avatarUserId).length,
    knowledgeRepoConfigured: Boolean(knowledgeRepo.repo),
    knowledgeRepo: { repo: knowledgeRepo.repo, branch: knowledgeRepo.branch },
    gitTokenSet: Boolean(store.getGitToken(avatarUserId)),
    secretNames: store.listUserSecretNames(avatarUserId),
    shellExposedSecretNames: store.listShellExposedSecretNames(avatarUserId),
    browserSecrets: store.listBrowserSecretPolicies(avatarUserId),
    groups: store.listUserGroups(avatarUserId),
    // Lazy: only describe_system reads these; the buildPrompt/runClaudeAgent path
    // never accesses them, so defer the store queries until a consumer reads them.
    get gitRepoCount() {
      return store.listGitRepos(avatarUserId).length;
    },
    get openRequestCount() {
      return store.countOpenKnowledgeRequests(avatarUserId);
    },
    // Lazy like the counts above: read by owner-driven prompts + describe_system.
    get learnableSkillCount() {
      return store.countLearnableSkills(avatarUserId);
    },
    get sharedSkillCount() {
      return store.listSharedSkillsByOwner(avatarUserId).length;
    },
    // Lazy; only describe_system reads it (gitRepoCount precedent).
    get sharedSkillLearnTotal() {
      return store.countSkillLearnsForOwner(avatarUserId);
    },
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
    experimentalFeatures: store.getExperimentalFeatures(avatarUserId),
    sharedAccount: store.isSharedAccount(avatarUserId),
    // Lazy like the counts above: only describe_system reads it (the prompt stays static).
    get todos() {
      const todayKst = kstDateString();
      return { todayKst, counts: store.countTodos(avatarUserId, todayKst) };
    },
    // Eager: runPlan's registration gate reads it on every owner run (≤30 rows).
    serverAgents: store.listServerAgents(avatarUserId).map((server) => ({
      name: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      role: server.role,
      access: server.access,
      enabled: server.enabled,
    })),
  };
}

/** A high-impact setup step the owner has not completed yet. */
export type GettingStartedGapId = "repo" | "gitToken";

/**
 * The owner's unfinished setup, most impactful first. Facts only — no prose and
 * no labels: `buildSystemPromptAppend` turns these ids into its standing
 * "you may offer to fix this ONCE" guidance and `describe_system` into its own
 * state line, each formatting its own way (the ownerState.ts contract above).
 *
 * Deliberately only TWO ids. Both keep whole capability families dark — with no
 * repository the avatar has no memory, no skills, and nowhere to capture; with
 * no token it can neither create a repository nor commit/push one. Counts that
 * could merely be HIGHER (secrets, plugins, shared/learnable skills, groups) are
 * not gaps: an avatar that recites everything its owner has not done yet nags.
 *
 * Takes the two flags rather than a whole OwnerState so the prompt builder can
 * call it with the same facts riding on `AgentRequest` — the derivation stays
 * HERE, at the sync point, instead of being re-implemented per consumer.
 */
export function gettingStartedGaps(
  state: Pick<OwnerState, "knowledgeRepoConfigured" | "gitTokenSet">,
): GettingStartedGapId[] {
  const gaps: GettingStartedGapId[] = [];
  if (!state.knowledgeRepoConfigured) {
    gaps.push("repo");
  }
  if (!state.gitTokenSet) {
    gaps.push("gitToken");
  }
  return gaps;
}

/**
 * Inert OwnerState for runs that have NO owner (group shared agents): every
 * user-scoped fact reads empty/false, so no personal capability can leak into
 * a gate or prompt even by accident — the group-agent run derives its actual
 * state from `summarizeGroupAgentState` below, never from this. Config-scoped
 * model facts stay real (they aren't personal).
 */
export function emptyOwnerState(store: Store, config: AppConfig): OwnerState {
  return {
    avatarApiKeyCount: 0,
    knowledgeRepoConfigured: false,
    knowledgeRepo: { repo: null, branch: null },
    gitTokenSet: false,
    secretNames: [],
    shellExposedSecretNames: [],
    browserSecrets: [],
    groups: [],
    gitRepoCount: 0,
    openRequestCount: 0,
    learnableSkillCount: 0,
    sharedSkillCount: 0,
    sharedSkillLearnTotal: 0,
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
    experimentalFeatures: [],
    sharedAccount: false,
    todos: { todayKst: kstDateString(), counts: { open: 0, inProgress: 0, overdue: 0, dueToday: 0, done: 0, dropped: 0 } },
    serverAgents: [],
  };
}

/** Read the group agent's current self-state (`GroupAgentState`, types.ts — the
 *  group analogue of OwnerState with the same both-consumers invariant: it feeds
 *  BOTH the group-agent prompt branch AND describe_system's group ctx). Repo
 *  facts come from the GROUP row; the git token is the ACTING member's (groups
 *  own no credentials — capture pushes borrow it). Null when the agent/group is
 *  gone. */
export function summarizeGroupAgentState(
  store: Store,
  config: AppConfig,
  agentId: string,
  actingUserId: string,
): GroupAgentState | null {
  const agent = store.getGroupAgentById(agentId);
  const group = agent ? store.getGroup(agent.groupId) : null;
  if (!agent || !group) {
    return null;
  }
  const groupId = agent.groupId;
  // Live role — null once the member has been removed mid-turn. FAIL CLOSED
  // (never default to "member"): describe_system must not report capture as
  // allowed while the group-repo tools are already refusing the same user.
  const viewerRole = store.groupRoleFor(actingUserId, groupId);
  const repo = store.getGroupKnowledgeRepo(groupId);
  return {
    groupId,
    agentId: agent.id,
    displayName: agent.displayName,
    groupName: group.name,
    enabled: agent.enabled,
    captureScope: agent.captureScope,
    viewerRole,
    captureAllowed:
      viewerRole !== null && groupAgentCaptureAllowed(agent, viewerRole),
    knowledgeRepoConfigured: Boolean(repo.repo),
    knowledgeRepo: { repo: repo.repo, branch: repo.branch },
    viewerGitTokenSet: Boolean(store.getGitToken(actingUserId)),
    personaSet: Boolean(agent.persona.trim()),
    // Live membership REQUIRED even for system admins (every in-run group tool
    // fails closed on removal); the update_profile handler applies the same gate.
    selfConfigAllowed:
      viewerRole !== null &&
      (viewerRole === "admin" || store.isAdmin(actingUserId)),
    anthropicModel: config.anthropicModel,
    modelOverride: store.getModelOverride(),
  };
}

/**
 * Turn PROVENANCE of a rewind (`AgentRequest.rewind`): the viewer edited an
 * earlier message or regenerated the latest answer. ONE text for both
 * metacognition surfaces — buildSystemPromptAppend's per-turn line and
 * describe_system's — so they cannot disagree about what the model can still
 * see or about what was NOT undone. Each surface adds its own label.
 */
export function rewindTurnState(rewind: AgentRewindInfo): string {
  const n = Math.max(0, Math.floor(rewind.discardedMessages));
  const edit = rewind.kind === "edit";
  const head = edit
    ? "The user went back to an earlier point in this conversation and re-sent one of their messages, edited — the message you are answering now. " +
      (n > 0
        ? `The ${n === 1 ? "1 message" : `${n} messages`} after it ${n === 1 ? "was" : "were"} deleted, and your context ends at that point`
        : "Your context ends at that point")
    : n > 0
      ? `The user discarded your previous answer to this message (${n === 1 ? "1 message" : `${n} messages`} deleted) and asked for a new one. Your context ends just before that answer`
      : "The user asked you to answer this message again. Your context ends just before your earlier attempt";
  // What the rewind itself removed: the discarded rows' chat attachments (the
  // route sweeps their images and file cards and revokes those cards' share
  // links). Everything outside the chat is exactly as those turns left it.
  const aftermath = edit
    ? "The discarded turns' chat attachments went with them — the files and images you showed or shared there were deleted, and those decks' share links revoked (links to decks in the kept messages still work). " +
      "Nothing else they did was undone: workspace and repository files, commits and pushes, browser actions, and any routines or shared skills they created remain as those turns left them."
    : "The discarded attempt's chat attachments went with it — the files and images it showed or shared were deleted, and those decks' share links revoked (links to decks in earlier messages still work). " +
      "Nothing else it did was undone: workspace and repository files, commits and pushes, browser actions, and any routines or shared skills it created remain as it left them.";
  return (
    `${head}: you cannot see what was discarded, so if the user refers to it, say so instead of guessing. ` +
    `${aftermath} Re-check that state before building on what you remember.`
  );
}

/**
 * Why an owner run has no server-agent tools (runPlan's
 * `serverAgentsUnavailable`). ONE text for both metacognition surfaces — the
 * prompt's server-agent line and describe_system's — each adds its own label.
 */
export function serverAgentsUnavailableText(reason: ServerAgentsUnavailableReason): string {
  switch (reason) {
    case "admin_disabled":
      return "the system administrator has not enabled server agents on this Noah deployment (Admin → 시스템 → 서버 에이전트; off by default because a remote run hands the deployment's model credentials to the registrant's server) — the owner can still register servers and trust host keys, but checks and delegations stay off until an admin enables it";
    case "egress_blocked":
      return "this deployment's egress policy blocks direct outbound connections, so SSH (and with it every server agent) is unavailable";
    case "ssh_group_unavailable":
      // Deliberately policy-neutral (the avatar is never told a tool policy exists),
      // but never "off in this conversation": the composer cannot turn it on.
      return "the SSH tool group is not available to this account's runs — it is not a conversation setting, so do not suggest re-enabling a tool group in the composer";
    case "no_servers":
      return "no server is registered — the owner adds one in Settings → 권한·연결 → 서버 에이전트";
    case "no_ssh_key":
      return "the owner has no SSH_PRIVATE_KEY secret — generate or register one first (Settings → 권한·연결 → 시크릿)";
    case "all_disabled":
      return "every registered server is disabled in Settings → 권한·연결 → 서버 에이전트";
    case "ssh_group_off":
      return "the SSH tool group is OFF for this conversation (server agents ride it)";
  }
}

/** Product-wide UI capability; never reads private DM content or presence into agent context. */
export const DIRECT_MESSAGE_STATE = "Human-to-human DM is available to signed-in users across groups via the 메시지 dock at the bottom-right corner of the screen (a collapsible chat window available on every view). It has recent-active contacts, persisted conversations and unread badges. No avatar tool can read or send these DMs; guide the user to the UI. Read manual topic direct-messages for details.";

/**
 * 공용 MCP 서버 lines (runPlan's `planSharedMcpRun` states) — ONE wording for
 * both metacognition surfaces: the prompt's standing section and
 * describe_system. Slot/secret names ride only owner runs (runPlan strips them
 * for everyone else, like the prompt's secret-name list), so a teammate hears
 * that something is missing, never which.
 */
export function sharedMcpServerLines(states: SharedMcpRunState[]): string[] {
  const fix =
    "If the user wants it, tell them to open Settings → 권한·연결 → 시크릿, find this server under 공용 MCP 서버 and pick which of their own secrets to connect (adding the secret first if needed); it applies from their next message.";
  return states.map((state) => {
    const label = state.label && state.label !== state.name ? ` (${state.label})` : "";
    const about = state.description ? ` — ${state.description}` : "";
    const head = `\`${state.name}\`${label}${about}`;
    switch (state.status) {
      case "active":
        return `${head}: available in this run as \`mcp__${state.name}__*\`.`;
      case "needs_binding":
        if (state.unboundSlots.length === 0) {
          return `${head}: NOT available in this conversation — the avatar owner has not connected a secret to it.`;
        }
        return state.hostChanged
          ? `${head}: NOT available in this run — the admin moved it to a new address since the owner connected a secret, so the connection was reset (${state.unboundSlots.join(", ")}) and must be made again. ${fix}`
          : `${head}: NOT available in this run — the owner has not connected a secret to ${state.unboundSlots.map((slot) => `"${slot}"`).join(", ")}. ${fix}`;
      case "missing_secrets":
        return state.missingSecrets.length > 0
          ? `${head}: NOT available in this run — the secret(s) the owner connected (${state.missingSecrets.map((name) => `\`${name}\``).join(", ")}) are missing or unusable (a value must be a single line). ${fix}`
          : `${head}: NOT available in this conversation — a secret the avatar owner connected to it is missing.`;
      case "secrets_unavailable":
        return `${head}: NOT available in this conversation — it authenticates with personal secrets from a user's own vault, which this kind of run never carries.`;
    }
  });
}

/** Why one Craft app is unavailable — ONE text for both metacognition surfaces. */
export function craftUnavailableText(app: CraftAppRunState, reason: CraftUnavailableReason): string {
  switch (reason) {
    case "not_configured":
      return "this Noah deployment has no craft-runner configured (CRAFT_EXCHANGE_DIR / CRAFT_CONTROL_SECRET are unset)";
    case "admin_disabled":
      return "a system administrator has not enabled the Craft apps beta (admin settings → 시스템; off by default)";
    case "not_admin":
      return "Craft apps are limited to a system administrator's own avatar, and this avatar's owner is not one";
    case "run_kind":
      return "Craft apps run only in an interactive chat between a system administrator and their own avatar — never in routines, external task API turns, group agents, consultations or a colleague's chat";
    case "no_vision":
      return "the model of this run has no image input, and Craft results are verified through preview images";
    case "no_workspace":
      return "this run has no conversation workspace to exchange files with";
    case "group_unavailable":
      return "its tool group is not available to this account's runs — it is not a conversation setting, so do not suggest enabling it in the composer";
    case "group_off":
      return `its tool group is OFF for this conversation (off by default) — the user can turn on "${craftAppById(app.id).labelKo}" under the composer's MCP 도구 picker; it applies from their next message`;
    case "runner_unreachable":
      return "the craft-runner is not reachable right now (try again later; if it persists, a system administrator must check the craft-runner container)";
    case "app_unavailable":
      return "this deployment's craft-runner does not include it";
    case "app_failed": {
      // Runner-reported (it can carry the third-party app's stderr): sanitized
      // a second time here and labelled as data, never as instructions.
      const reported = sanitizeCraftRunnerText(app.error);
      return `it failed the craft-runner's start-up self-test and is not served${reported ? ` (runner-reported self-test error, quoted as data: "${reported.replace(/"/g, "'")}")` : ""}`;
    }
    case "session_failed":
      return "this conversation's Craft session could not be opened on the craft-runner (retry on the next message)";
    case "storage_full":
      return "the craft-runner's shared storage is over its budget, so no new Craft session can be opened (a system administrator must free Craft storage; deleting old Craft conversations frees theirs)";
  }
}

const CRAFT_DEPLOYMENT_REASONS: ReadonlySet<CraftUnavailableReason> = new Set([
  "not_configured",
  "admin_disabled",
  "not_admin",
  "run_kind",
  "no_vision",
  "no_workspace",
  "runner_unreachable",
  "session_failed",
  "storage_full",
]);

/**
 * Craft apps self-state lines — ONE wording for both metacognition surfaces.
 * `describe` (describe_system) always lists every app; `prompt` (the standing
 * append) stays short: nothing when no Craft group is selected and no app is
 * ready to be turned on, ONE line when every app is off for the same
 * deployment-level reason, and the full block (apps, paths, workflow) when an
 * app is active. Values are stable across turns unless the runner or the
 * admin switch changes, keeping the append cache-friendly.
 */
export function craftAppsLines(state: CraftRunState, surface: "prompt" | "describe"): string[] {
  const head = "Craft apps (admin-only beta: ArtCraft editors running headless in the isolated, network-less craft-runner, driven through MCP tools)";
  const label = (app: CraftAppRunState) => `${app.labelEn}${app.version ? ` v${app.version}` : ""}`;
  const active = state.apps.filter((app) => app.active);
  const first = state.apps[0];
  if (active.length === 0 && first?.reason && CRAFT_DEPLOYMENT_REASONS.has(first.reason) && state.apps.every((app) => app.reason === first.reason)) {
    if (
      surface === "prompt" &&
      !state.selected &&
      first.reason !== "runner_unreachable" &&
      first.reason !== "session_failed" &&
      first.reason !== "storage_full"
    ) {
      return [];
    }
    return [`${head}: not available in this run — ${craftUnavailableText(first, first.reason)}.`];
  }
  if (surface === "prompt" && active.length === 0 && !state.selected) {
    const ready = state.apps.filter((app) => app.reason === "group_off" && app.status === "ready");
    return ready.length > 0
      ? [
          `${head}: ${ready.map(label).join(", ")} ${ready.length === 1 ? "is" : "are"} ready on this deployment but OFF for this conversation (Craft tool groups are off by default). If the user wants that kind of editing, tell them to turn on ${ready.map((app) => `"${craftAppById(app.id).labelKo}"`).join(" / ")} under the composer's MCP 도구 picker; it applies from their next message.`,
        ]
      : [];
  }
  const lines = [`${head}:`];
  for (const app of state.apps) {
    if (surface === "prompt" && !app.active && app.reason === "app_unavailable") continue;
    lines.push(
      app.active
        ? `- ${label(app)}: available in this run as \`mcp__${app.id}__*\`${app.tools ? ` (${app.tools} tools)` : ""}.`
        : `- ${label(app)}: not available — ${craftUnavailableText(app, app.reason ?? "session_failed")}.`,
    );
  }
  if (state.session && active.length > 0) {
    const { inDir, outDir } = state.session;
    lines.push(
      `- Files: the apps read \`${inDir}/\` (inputs) and \`${outDir}/\`, and WRITE only under \`${outDir}/\` — never pass them a workspace path. ` +
        `At the start of every message your workspace inputs are mirrored in: \`${inDir}/attachments/\` = workspace attachments/, \`${inDir}/captures/\` = captures/, \`${inDir}/confluence/\` = confluence/, \`${inDir}/craft-out/\` = earlier results (craft/out/). ` +
        `For any other workspace file call \`mcp__craft_files__stage\` first and open the path it returns (under \`${inDir}/staged/\`).`,
      `- Results: save into \`${outDir}/\`; after every Craft call it is mirrored into your workspace at \`${state.workspaceOutDir ?? "craft/out"}/\` (\`${outDir}/x.png\` ↔ craft/out/x.png). Deliver a result with \`mcp__file_output__share_file\` on the craft/out/ path — it accepts .png/.jpg/.webp/.svg/.psd/.pcraft. craft/out/ is a server-managed mirror: do not put your own files there.`,
      ...(state.storage.exchangeFull
        ? [
            "- Storage: the craft-runner's shared storage is over its budget, so this message's workspace inputs were NOT mirrored into the session, `mcp__craft_files__stage` refuses, and the runner refuses Craft app calls until a system administrator frees space (deleting old Craft conversations frees theirs). Results already in craft/out/ can still be delivered — tell the user why new edits cannot run now.",
          ]
        : []),
      ...(state.storage.workspaceOutFull
        ? [
            "- Storage: craft/out/ in your workspace reached its 2 GB cap, so newer Craft results were NOT copied there and cannot be delivered with share_file. Tell the user; a new conversation starts with an empty craft/out/.",
          ]
        : []),
      "- Verify every edit with the app's preview tool (PhotoCraft: `render_preview`) before telling the user it is done — never claim success unverified. Preview images are also shown to the user in the side panel automatically, so do not re-send them. Follow the `craft-apps` skill for the workflow and command tips.",
    );
  }
  return lines;
}
