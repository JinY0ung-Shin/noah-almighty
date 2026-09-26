import type { ScheduleKind } from "./routineSchedule.js";
import type { McpToolGroupId } from "../shared/mcpToolGroups.js";
import type { BrowserSecretPolicy } from "./secretPolicy.js";

export type AgentRuntime = "claude" | "local";

/**
 * A statically registered agent served by an external Noah-compatible gateway.
 * Connection details and credentials are server-only and must never be copied
 * into an AvatarSummary/AvatarDetail response.
 */
export interface ExternalAgentConfig {
  /** Operator-facing slug; the public avatar id is `external:${id}`. */
  id: string;
  displayName: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  hashtags: string[];
  /** Exact POST endpoint for the gateway's `/v1/agents/messages` API. */
  endpoint: string;
  /** Gateway agent implementation. v1 defaults to `claude`. */
  agent: string;
  /** Disabled entries stay in admin/history metadata but cannot be discovered or run. */
  enabled?: boolean;
  model?: string;
  /** Private upstream system instruction; never included in public avatar JSON. */
  system?: string;
  /** Private bearer token; never included in public avatar JSON. */
  apiKey?: string;
  /** Maximum time to receive upstream response headers. Defaults to 15s. */
  connectTimeoutMs?: number;
  /** Maximum silence between upstream SSE bytes. Defaults to 120s. */
  idleTimeoutMs?: number;
  /** Hard cap for one external turn. Defaults to 30 minutes. */
  totalTimeoutMs?: number;
  /**
   * Noah group ACL — REQUIRED for the avatar to be visible: only members of at
   * least one listed group may discover or chat with it. An entry without a
   * list stays parseable (legacy env/registry) but is visible to NO ONE (fail
   * closed); the admin UI requires a non-empty list on create/update. This
   * controls Noah visibility only and never grants Gateway tool privileges.
   */
  visibleToGroupIds?: string[];
}

/** Where an administrator-visible external avatar definition comes from. */
export type ExternalAgentSource = "environment" | "managed";

/**
 * Secret-free external avatar shape returned only from the admin API. Public
 * avatar endpoints expose a much smaller projection and never include these
 * connection/runtime fields.
 */
export interface AdminExternalAgent {
  id: string;
  displayName: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  hashtags: string[];
  endpoint: string;
  agent: string;
  enabled: boolean;
  model?: string;
  system?: string;
  visibleToGroupIds?: string[];
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  totalTimeoutSeconds?: number;
  source: ExternalAgentSource;
  /** The credential itself is write-only; admins receive only this flag. */
  apiKeySet: boolean;
  /** Used to guard destructive delete and endpoint reassignment. */
  conversationCount: number;
  /** Admin-set profile image present (stored outside the registry). */
  hasImage: boolean;
}

export type ExternalAgentApiKeyMode = "keep" | "set" | "clear";

/** Write contract shared by the external-avatar editor and admin API. */
export interface AdminExternalAgentInput {
  id: string;
  displayName: string;
  alias?: string;
  bio?: string;
  persona?: string;
  intro?: string;
  hashtags?: string[];
  endpoint: string;
  agent?: "claude";
  enabled?: boolean;
  model?: string;
  system?: string;
  visibleToGroupIds?: string[];
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  totalTimeoutSeconds?: number;
  apiKeyMode: ExternalAgentApiKeyMode;
  /** Accepted only with apiKeyMode="set" and never returned by the server. */
  apiKey?: string;
}

/**
 * Minimal avatar-owner descriptor the in-process MCP tool servers
 * (`agent/*Tools.ts`) act on behalf of: identity for commit attribution and the
 * username/displayName fallbacks. `alias` is the avatar's self-name (optional).
 */
export interface AgentOwner {
  id: string;
  username: string;
  displayName: string;
  alias?: string;
}

export interface AppConfig {
  /** Operator-configured policy controller, never a user-selected URL. */
  egressControlUrl?: string;
  port: number;
  /**
   * PEM paths (env `TLS_CERT_FILE`/`TLS_KEY_FILE`) that switch the app's OWN
   * listener to HTTPS (`createAppServer`) — TLS ends in the app, no fronting
   * proxy. Set together or the boot refuses (never a silent HTTP fallback).
   * HTTPS is what gives pages a secure context (File System Access → the
   * browser bridge's one-click update). Pair with `SECURE_COOKIES=true`.
   */
  tlsCertFile?: string;
  tlsKeyFile?: string;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  agentRuntime: AgentRuntime;
  anthropicApiKey?: string;
  /** Pins the Claude model the agent runs (SDK `model` option). Unset → SDK default. */
  anthropicModel?: string;
  /**
   * Concrete model id each composer TIER alias maps to, from the operator's
   * `ANTHROPIC_DEFAULT_<TIER>_MODEL` env, keyed by the modelTiers alias
   * (`fable`/`opus`/`sonnet`/`haiku`). A tier with no env mapping is omitted (the
   * SDK then resolves the alias to the account default, which the app can't know).
   * Surfaced to the chat composer + describe_system so the user/avatar sees the
   * real model.
   */
  defaultTierModels: Record<string, string>;
  readOnlyTools: string[];
  /**
   * Whether the ACTIVE model accepts image input (vision). Env `MODEL_VISION`
   * ("off" disables; default on). When false: chat image uploads are rejected,
   * `Read` on image/PDF files is denied by the PreToolUse hook, Confluence
   * tools stop returning MCP image blocks, and the avatar is told via the
   * standing prompt + describe_system (META-COGNITION).
   */
  visionEnabled: boolean;
  /**
   * Show the corporate install-location line in the browser-bridge install
   * guide (env `BROWSER_BRIDGE_MULTIMEDIA_NOTICE`, `true`/`1`/`on` enables;
   * default off). Site policy restricts where users may put files, so the
   * guide's unzip step points at the upload-approved "Multimedia" folder.
   */
  browserBridgeMultimediaNotice: boolean;
  /** Default host used when a repo is entered as owner/repo. */
  githubHost: string;
  /**
   * Deployment-wide Confluence base URL (env `CONFLUENCE_URL`). The PAT itself
   * is user-scoped and stored as a `CONFLUENCE_PAT` secret.
   */
  confluenceUrl?: string;
  /**
   * Base URL of the deployment's OpenAI-compatible speech-to-text service (env
   * `STT_URL`), including the API version segment — e.g. `http://stt:8000/v1`.
   * Unset DISABLES the feature: `POST /api/stt` 503s and the composer hides its
   * mic button (`sttEnabled` in `/api/bootstrap`).
   */
  sttUrl?: string;
  /**
   * Model name sent with each transcription request (env `STT_MODEL`). The
   * service picks what it actually has loaded, so this only has to name it.
   */
  sttModel: string;
  /**
   * ISO-639-1 language biasing every transcription (env `STT_LANGUAGE`, default
   * `ko` for a Korean-speaking fleet), lowercased. The sentinel `auto` sends NO
   * language field at all, leaving the engine to detect it. The admin override's
   * own value wins over this — see `resolveSttTarget` in `stt.ts`.
   */
  sttLanguage: string;
  /**
   * Deployment-wide DEFAULT browser-control allowlist (env
   * `BROWSER_ALLOWED_ORIGINS`, comma-separated hostnames / `*.wildcards`).
   * Served via `GET /api/browser-extension` and applied by the Noah page to a
   * browser whose extension allowlist is still EMPTY — never over a list the
   * user (or managed policy) already holds. Entries that would cover Noah's own
   * host — including a bare `*` — are dropped before serving
   * (shared/originPatterns.ts): a default must not reopen what the staging-page
   * exemption was scoped to prevent.
   */
  browserDefaultAllowedOrigins: string[];
  /**
   * Optional PEM CA file path (env `GITHUB_CA_CERT`) trusted for BOTH TLS stacks
   * the app uses to reach `githubHost`: Node `fetch` and every `git` clone/push.
   * `create_repo` also passes it to gh as `SSL_CERT_FILE`. Applied once at
   * startup by `applyCustomGithubCa`; unset means public/system CAs only.
   */
  githubCaCert?: string;
  /** Repo-bundled plugin dir loaded for EVERY avatar (default skills). */
  defaultPluginsDir: string;
  /**
   * How long an avatar plugin clone may be reused before a chat/routine turn
   * refreshes it from git. 0 disables automatic refresh after the first clone.
   */
  pluginAutoRefreshIntervalMs: number;
  /**
   * Where the SDK persists per-conversation session transcripts (its
   * `CLAUDE_CONFIG_DIR`). Lives under `dataDir` so resumable sessions survive a
   * server/container restart, instead of the SDK's default `~/.claude`.
   */
  agentSessionsDir: string;
  /**
   * Max agent turns (model inferences) per chat reply. Each tool call consumes a
   * turn, so tool/skill/subagent-heavy replies need plenty of headroom — too low
   * and the SDK aborts mid-task with `error_max_turns`. Defaults to 1000 (env
   * `MAX_TURNS`).
   */
  maxTurns: number;
  /**
   * Hard wall-clock deadline for ONE unattended routine run (env
   * `ROUTINE_RUN_TIMEOUT_MINUTES`, default 30 minutes, floor 1 minute — the
   * deadline can't be disabled, or a hung SDK call would wedge the job forever).
   *
   * This is the budget for the WHOLE run, `maxTurns` notwithstanding: every
   * model-fallback attempt and the resume self-heal retry share it. It is also
   * how long `POST /api/me/routines/:id/run` ("지금 실행") can hold its HTTP
   * request open, so raising it past a fronting proxy's read timeout makes the
   * manual-run button fail even while the run itself keeps going.
   */
  routineRunTimeoutMs: number;
  /**
   * How many routine runs the scheduler keeps in flight at once, server-wide
   * (env `ROUTINE_MAX_CONCURRENT_RUNS`, default 10; a non-integer or < 1 falls
   * back to the default). Each run is a full agent process, so this bounds the
   * burst when many routines fall due together or after downtime. A manual
   * "지금 실행" is never refused by it but occupies a slot while it runs.
   */
  routineMaxConcurrentRuns: number;
  /**
   * How many of ONE owner's routines run at once (env
   * `ROUTINE_MAX_CONCURRENT_RUNS_PER_USER`, default 2, same fallback). Kept
   * below {@link AppConfig.routineMaxConcurrentRuns} so one owner with many due
   * routines can't take every slot and delay everyone else's.
   */
  routineMaxConcurrentRunsPerUser: number;
  /**
   * Hard wall-clock deadline for ONE unattended 내 봇 run — a queued delegated
   * task or a bot routine firing (`runBotRoutineJobNow`), a turn the SERVER
   * started with nobody watching the stream (env `BOT_TASK_TIMEOUT_MINUTES`,
   * default 30 minutes, floor 1 minute, same "cannot be disabled" reasoning as
   * {@link AppConfig.routineRunTimeoutMs}).
   *
   * Only those unattended paths arm it: a turn the owner typed themselves stays
   * un-deadlined, because a live viewer already has the stop button.
   */
  botTaskRunTimeoutMs: number;
  /**
   * Hard wall-clock deadline for ONE external task API run (env
   * `AVATAR_TASK_TIMEOUT_MINUTES`, default 300 minutes = 5 hours, floor 1 minute,
   * same "cannot be disabled" reasoning as {@link AppConfig.routineRunTimeoutMs};
   * capped at setTimeout's ~24.8-day maximum). Covers the whole turn, time
   * parked on a question and the background phase included.
   *
   * Deliberately separate from {@link AppConfig.botTaskRunTimeoutMs}, which stays
   * short: a bot routine run holds one of the routine scheduler's slots (and one
   * of its owner's) for its whole duration, and a hung bot turn pins its
   * thread's queue. API runs have their own dispatcher (one per owner, four
   * process-wide), which
   * is their own stall surface: a long or hung run holds its owner's only slot,
   * and one of the four, for up to this budget — the cancel route frees it.
   */
  avatarTaskRunTimeoutMs: number;
  /**
   * Optional override for the autocompact trigger: the working context window
   * (in tokens) the agent compacts near the top of. Maps to the CLI settings key
   * `autoCompactWindow`, carried by the SDK `settings` option as JSON — NOT a
   * top-level SDK option (no such field exists; see `runPlan.ts`). Unset (the
   * default) → the CLI uses the model's full context window. Env
   * `AUTO_COMPACT_WINDOW`; clamped to the CLI's 100K–1M range, non-numeric/≤0
   * ignored. Lower it to compact earlier (keeps each turn cheaper at the cost of
   * more frequent summarization).
   */
  autoCompactWindow?: number;
  /**
   * Command that launches the upstream hex-ssh MCP server behind the app's
   * policy proxy. The image installs the package at build time and exposes it as
   * `hex-ssh-mcp` (the default) — avoiding a runtime `npx` download that fails
   * on a closed network. Override via `HEX_SSH_COMMAND` for local dev.
   */
  hexSshCommand: string;
  /** Server-only static registry loaded from `EXTERNAL_AGENTS_JSON`. */
  externalAgents?: ExternalAgentConfig[];
}

/**
 * Admin-panel override of the speech-to-text endpoint, stored in `app_config`.
 * Unlike the model override, THIS wins over the env (`STT_URL`/`STT_MODEL`),
 * which stays the fallback an operator sees in the panel — see
 * `resolveSttTarget` in `stt.ts`. `url` is already normalized (trailing slashes
 * stripped) when stored; `model` null means "inherit `config.sttModel`", and
 * `language` null means "inherit `config.sttLanguage`" — including for a row
 * written before the field existed, whose JSON has no `language` key at all.
 */
export interface SttOverride {
  url: string;
  model: string | null;
  language: string | null;
}

/**
 * Who can discover and chat with an avatar:
 * - `group`   — only the owner's group teammates (also mutually elevated)
 * - `private` — only the owner
 * There is deliberately NO wider state: avatars never reach beyond the owner's
 * groups, so a user in no group sees (and is seen by) no one but themselves.
 * Trust/elevation still derives from group co-membership (`Store.isTrustedFor`),
 * which for non-owners now coincides with reach on native avatars.
 */
export type AvatarVisibility = "group" | "private";

/**
 * Public user shape returned to clients. NEVER includes password_hash or secret
 * values — the internal git token is exposed only as the `gitTokenSet` flag.
 */
export interface User {
  id: string;
  username: string;
  displayName: string;
  /** How the avatar names ITSELF in chat (별칭); empty falls back to displayName. */
  alias: string;
  bio: string;
  persona: string;
  /** First-person self-introduction the avatar generates, shown in its explore-page intro dialog. */
  intro: string;
  /** Capability hashtags (bare, no "#") the avatar declares for discovery/search. */
  hashtags: string[];
  hasImage: boolean;
  /** Who can discover and chat with this avatar — see {@link AvatarVisibility}. */
  visibility: AvatarVisibility;
  roles: string[];
  pluginCount: number;
  /** True when the internal GIT_TOKEN secret is stored (the token itself is never sent). */
  gitTokenSet: boolean;
  /** Git commit author identity for knowledge-repo commits (safe to expose). */
  gitIdentityName: string | null;
  gitIdentityEmail: string | null;
  /** The user's personal knowledge repo (`owner/repo` or git URL) and branch. */
  knowledgeRepo: string | null;
  knowledgeBranch: string | null;
  /**
   * For a knowledge repo that's a marketplace of many plugins: the subset of
   * plugin names the avatar loads. `null` means "load all" (the default) — the
   * repo is the avatar's by default, so all its plugins are used unless the
   * owner deselects some.
   */
  knowledgeSelected: string[] | null;
  /**
   * The owner's DEFAULT group-knowledge OFF-set (group ids whose shared knowledge
   * is off). Seeds every NEW conversation so the toggle choice persists across
   * conversations. `[]` = every group on (the default).
   */
  groupKnowledgeOffDefault: string[];
  /**
   * The owner's remembered chat-composer defaults, seeding every NEW conversation
   * so the picker's last choice persists across conversations. `null` = never
   * chosen → a new conversation falls back to the hardcoded server/SDK default.
   * `modelDefault` is a model-tier alias; `effortDefault` a reasoning-effort level;
   * `mcpToolGroupsDefault` the enabled MCP tool groups (`null` = every group on,
   * `[]` = explicitly all off). The per-conversation `selected_*` value still
   * overrides these for an already-started conversation.
   */
  modelDefault: string | null;
  effortDefault: string | null;
  mcpToolGroupsDefault: McpToolGroupId[] | null;
  /**
   * EFFECTIVE system-admin tool policy for this user: the INTERSECTION of
   * `Group.allowedMcpToolGroups` across every policy-bearing group they belong
   * to (`null` = unrestricted). The composer disables blocked groups from this
   * field; enforcement is server-side (every run is clamped in claudeAgent).
   */
  allowedMcpToolGroups: McpToolGroupId[] | null;
  /**
   * Names of the user's stored secrets (e.g. SSH_PRIVATE_KEY). Only the NAMES
   * are exposed — the encrypted values never leave the server. The avatar's
   * MCP tools receive them as subprocess env (injected by the owner's identity),
   * so they're invisible to the agent itself.
   */
  secretNames: string[];
  /**
   * Subset of `secretNames` the user opted into AGENT-SHELL exposure for
   * (per-secret toggle): those values are exported into the agent's Bash env
   * on elevated runs, with tool outputs redacted. Reserved git/SSH names are
   * excluded by policy regardless (`secretPolicy.ts`).
   */
  shellExposedSecretNames: string[];
  /**
   * Secrets the user opted into BROWSER INPUT for (per-secret 브라우저 입력
   * toggle): the avatar may name one in `mcp__browser__type` / `fill_form` and
   * the extension types the value into the user's own browser. Only ENABLED,
   * currently-usable policies appear (non-reserved name, ≥1 allowed host), so
   * the settings UI reads absence as "off". Values are never included —
   * `hosts`/`passwordOnly` are the policy the bridge enforces.
   */
  browserSecrets: BrowserSecretPolicy[];
  /** Public SSH key generated by the app for this user's avatar, safe to re-display. */
  sshPublicKey: string | null;
  /**
   * Groups the user belongs to. Members of a group auto-trust each other and
   * share the group's knowledge repo; `role` is the user's role within each.
   */
  groups: UserGroupMembership[];
  /**
   * Keys of the experimental (beta) features the owner has enabled for their
   * avatar (e.g. `["canvas"]`). Validated against the server registry
   * (`experimentalFeatures.ts`); unknown keys are dropped. `[]` = none enabled.
   */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account: when true, trusted same-group teammates chatting
   * with this avatar may also UPDATE the owner's personal knowledge repo
   * (write/delete/move/scaffold/commit). Repo creation/connection settings stay
   * owner-only, and plain (non-group) viewers stay read-only. Off by default.
   */
  sharedAccount: boolean;
  /**
   * When the user dismissed first-run onboarding (ISO timestamp), or null if they
   * haven't yet. Server-persisted so the welcome modal shows ONCE per account —
   * across devices and surviving a localStorage clear — instead of every login.
   */
  onboardedAt: string | null;
  /**
   * Id of the latest release-notes entry (`releaseNotes.ts`) the user has seen,
   * or null for never (pre-feature accounts). Drives the one-time "새로운 기능"
   * dialog: the client shows entries newer than this after load, then stamps the
   * server-current id via `POST /api/me/release-seen`. New signups are seeded
   * with the then-current id at creation, so day-one accounts see nothing.
   */
  lastSeenRelease: string | null;
}

export interface Plugin {
  id: string;
  repo: string;
  ref: string | null;
  label: string | null;
  enabled: boolean;
  // For marketplace repos (many plugins in one repo): names of the plugins to
  // load. `null` means "load all" (the default, backward-compatible).
  selected: string[] | null;
  // ISO timestamp of the last successful git sync, or null if never synced.
  lastSyncedAt: string | null;
  createdAt: string;
}

/** A user-registered general-purpose git repository managed by MCP tools. */
export interface GitRepository {
  userId: string;
  name: string;
  repo: string;
  branch: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

/** A member's role within a group. A group `admin` manages members + the shared repo. */
export type GroupRole = "admin" | "member";

/**
 * A group created by a system admin. Members of the same group automatically
 * trust each other (mutual `elevated` access — see `isTrustedFor`), and the
 * group has one shared knowledge repo that only group admins may edit.
 */
export interface Group {
  id: string;
  name: string;
  description: string;
  /** The group's shared knowledge repo (`owner/repo` or git URL) + branch. */
  knowledgeRepo: string | null;
  knowledgeBranch: string | null;
  /** Subset of the group repo's plugins to load; `null` = load all. */
  knowledgeSelected: string[] | null;
  /**
   * SYSTEM-ADMIN tool policy for this group's members: the MCP tool groups
   * (src/shared/mcpToolGroups.ts ids) members may use in chats THEY drive.
   * `null` = no restriction; `[]` = every optional MCP tool group blocked. A
   * user in several policy-bearing groups gets the INTERSECTION — see
   * `Store.allowedMcpToolGroupsForUser`. Group admins can read but not set it.
   */
  allowedMcpToolGroups: McpToolGroupId[] | null;
  /**
   * GROUP-ADMIN policy: whether co-membership in THIS group shares avatars —
   * mutual visibility and mutual trust/elevation together (they ride the same
   * SQL fragment). `false` makes the group knowledge-sharing-only; group
   * repo/brain access and `allowedMcpToolGroups` are unaffected. Default on.
   */
  avatarSharing: boolean;
  /** User id of the system admin who created the group (may be gone). */
  createdBy: string | null;
  createdAt: string;
}

/** A member of a group, with their role within it (for the management/roster UI). */
export interface GroupMember {
  userId: string;
  username: string;
  displayName: string;
  hasImage: boolean;
  role: GroupRole;
  /** This member's avatar visibility (the roster chat link is shown unless `private`). */
  visibility: AvatarVisibility;
  joinedAt: string | null;
}

/** Admin-dashboard summary of a group, with member counts. */
export interface AdminGroupSummary extends Group {
  memberCount: number;
  adminCount: number;
  /** Shared group agents (a group may have several). */
  agentCount: number;
  enabledAgentCount: number;
}

/** Who may CAPTURE (write + commit) to the shared second brain through the group agent. */
export type GroupAgentCaptureScope = "members" | "admins";

/**
 * Structured, UNFORMATTED self-state for a GROUP SHARED-AGENT run — the group
 * analogue of `OwnerState` (agent/ownerState.ts builds it), with the same
 * metacognition invariant: consumed by BOTH `buildSystemPromptAppend` (group-
 * agent prompt branch) AND `describe_system` (group-agent ctx). Add a fact
 * here and to both consumers together.
 */
export interface GroupAgentState {
  groupId: string;
  agentId: string;
  /** The agent's display name — with several agents per group, state names WHICH. */
  displayName: string;
  groupName: string;
  enabled: boolean;
  captureScope: GroupAgentCaptureScope;
  /**
   * The acting member's role in the owning group (live, this turn). Null when
   * they were removed after the turn started — FAIL CLOSED: the state report
   * must never claim more than the tool gates that re-check membership allow.
   */
  viewerRole: GroupRole | null;
  /** capture_scope resolved against viewerRole — may THIS member capture. */
  captureAllowed: boolean;
  knowledgeRepoConfigured: boolean;
  knowledgeRepo: { repo: string | null; branch: string | null };
  /** ACTING member's internal git token — capture's commit/push depends on it. */
  viewerGitTokenSet: boolean;
  /** Whether a persona/instructions text is currently set on the agent. */
  personaSet: boolean;
  /**
   * May the ACTING member reconfigure this agent (persona/alias/bio/intro) via
   * `mcp__group_agent__update_profile` — live group-admin role (or system
   * admin), membership REQUIRED. Fails closed with viewerRole once removed.
   */
  selfConfigAllowed: boolean;
  anthropicModel?: string;
  modelOverride: string | null;
}

/**
 * A group's SHARED AGENT (several per group allowed, group-admin managed): a
 * team avatar whose second brain is the group's shared knowledge repository. It
 * is NOT a users row — its public avatar id is `group:<groupId>:<id>` — and it
 * uses group resources only (never personal secrets/tokens/repos). Reachable
 * solely by members of the owning group, independent of the avatar-sharing
 * policy.
 */
export interface GroupAgent {
  /** Row id — the agent's identity; its public avatar id is `group:<groupId>:<id>`. */
  id: string;
  groupId: string;
  displayName: string;
  /** How the agent names itself in chat; empty falls back to displayName. */
  alias: string;
  bio: string;
  intro: string;
  persona: string;
  hashtags: string[];
  hasImage: boolean;
  /** Disabled blocks the NEXT turn but preserves every member's threads. */
  enabled: boolean;
  captureScope: GroupAgentCaptureScope;
  /** Acting manager who created it (may dangle, like groups.createdBy). */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/**
 * Structured, UNFORMATTED self-state for a PERSONAL-AGENT run — the 내 봇
 * analogue of `GroupAgentState` (agent/ownerState.ts builds it), with the same
 * metacognition invariant: consumed by BOTH `buildSystemPromptAppend` (the
 * personal-agent prompt branch) AND `describe_system`. Add a fact here and to
 * both consumers together.
 */
export interface PersonalAgentState {
  agentId: string;
  ownerUserId: string;
  /** The bot's display name — an owner has several, so state names WHICH. */
  displayName: string;
  alias: string;
  /** Whether a persona/instructions text is currently set on the bot. */
  personaSet: boolean;
  enabled: boolean;
  /**
   * The owner still holds the admin role right now (the phase-1 feature gate,
   * re-read LIVE). FAIL CLOSED once revoked: the state report must never claim
   * more than the reach gate (findChattablePersonalAgent) still allows.
   */
  ownerIsAdmin: boolean;
  /** Roster context: bots the owner holds against the cap (disabled ones included). */
  agentCount: number;
  maxAgents: number;
  /**
   * Delegated requests still QUEUED behind the current turn in THIS
   * conversation (0 when the summarizer got no conversation id). Standing
   * awareness only — the queue drains server-side, never by the bot.
   */
  queuedTaskCount: number;
  /**
   * Repo-relative root of this bot's OWN memory inside the owner's knowledge
   * repo (`agents/<memoryDir>`, no trailing slash) — the same value that
   * parameterizes the run's scoped repo/brain servers, so what the bot is TOLD
   * about its memory is what the tools actually enforce.
   */
  memoryRoot: string;
  /**
   * Knowledge-repo skill slugs the owner granted this bot (live references, not
   * copies). EMPTY MEANS NONE — a bot loads only what was granted, so both
   * metacognition surfaces report the roster rather than implying the owner's
   * whole skill set.
   */
  adoptedSkills: string[];
}

/**
 * A user's PERSONAL AGENT (내 봇): a chat-contact bot owned by ONE user, not a
 * users row — its public avatar id is `personal:<ownerUserId>:<id>`. Reachable
 * by its owner ALONE, and only while that owner still holds the admin role (the
 * phase-1 feature gate). Unlike a group agent it runs with the OWNER's full
 * capability, so `AgentRequest.groupAgent` must never be set for one.
 */
export interface PersonalAgent {
  /** Row id — the bot's identity; its public avatar id is `personal:<ownerUserId>:<id>`. */
  id: string;
  ownerUserId: string;
  displayName: string;
  /** How the bot names itself in chat; empty falls back to displayName. */
  alias: string;
  bio: string;
  intro: string;
  persona: string;
  hashtags: string[];
  hasImage: boolean;
  /** Disabled blocks the NEXT turn but preserves the owner's threads. */
  enabled: boolean;
  /**
   * Model TIER id (modelTiers.ts) seeding NEW conversations with this bot;
   * null = fall back to the owner's own remembered default. Both writers
   * validate it against the deployment's tiers.
   */
  defaultModel: string | null;
  /**
   * IMMUTABLE folder name for this bot's own memory, one path segment set at
   * INSERT and never patched: the memory lives at `agents/<memoryDir>/` inside
   * the OWNER's knowledge repo (`personalAgentMemoryRoot`). Derived from the
   * display name plus the row id, so renaming a bot never orphans the tree it
   * has been writing to.
   */
  memoryDir: string;
  /**
   * Knowledge-repo skill slugs (`skills/<slug>/`) this bot may LOAD — live
   * references into the owner's repo, never copies, so the owner's edits reach
   * the bot without a transfer step. EMPTY MEANS NONE, the opposite default of
   * `User.knowledgeSelected` (null = load all): a bot starts with zero skills
   * and the owner grants them one at a time.
   */
  selectedSkills: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Write shape for creating/patching a personal agent (omitted field = keep). */
export interface PersonalAgentInput {
  displayName: string;
  alias?: string;
  bio?: string;
  intro?: string;
  persona?: string;
  hashtags?: string[];
  enabled?: boolean;
  /** undefined = keep the stored tier, null = clear it back to the owner default. */
  defaultModel?: string | null;
  /**
   * FULL-REPLACE allowlist of knowledge-repo skill slugs (undefined = keep).
   * `memoryDir` is deliberately absent from this shape: it is insert-only.
   */
  selectedSkills?: string[];
}

/**
 * Lifecycle of one delegated bot task (`bot_tasks` row). `queued` waits for the
 * conversation's active run to finish (the server dispatches it unattended);
 * `waiting_input` means the bot ENDED its turn asking the owner something — the
 * owner's next message in that thread RESUMES the same task. `done`/`failed`/
 * `cancelled` are terminal.
 */
export type BotTaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "done"
  | "failed"
  | "cancelled";

/**
 * One delegated unit of work in a PERSONAL-AGENT (내 봇) thread — every executed
 * user turn in a bot conversation is tracked as a task, which is what the 봇
 * 메신저 UI renders as 작업 카드/보드. Bookkeeping ONLY: capability stays the
 * A-1 full-owner-run contract; a task row never widens or narrows a run.
 */
export interface BotTask {
  id: string;
  ownerUserId: string;
  /** personal_agents.id — which bot the work belongs to. */
  agentId: string;
  conversationId: string;
  /**
   * In-memory run registry id while the task is running (live attach/cancel).
   * NOT durable: a server restart loses the registry, and the boot sweep marks
   * such tasks failed.
   */
  runId: string | null;
  /** Short label derived from the request (first line, capped) for cards/boards. */
  title: string;
  /** The owner's full request text (the queued dispatcher replays it verbatim). */
  requestText: string;
  status: BotTaskStatus;
  /**
   * What the bot itself declared via mcp__personal_agent__report_task, written
   * MID-run; the turn-finalize path reads it to pick done vs waiting_input.
   * Null when the bot never reported (finalize treats a clean turn as done).
   */
  reportedOutcome: "done" | "need_input" | null;
  /** The bot's own completion summary via mcp__personal_agent__report_task. */
  resultSummary: string | null;
  /** The question the bot is waiting on while status = waiting_input. */
  pendingQuestion: string | null;
  /** Failure cause (Korean, user-facing) for status = failed. */
  error: string | null;
  /** Resolved model of the last run (fallback-aware), for the task card. */
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * When the owner SAW this task's settled state (done/failed/waiting_input).
   * NULL on a settled row = unseen → counted into the 봇 오피스 rail badge.
   * Running/queued rows are never "unseen" (their motion is its own signal);
   * an owner-initiated row-cancel stamps it immediately (they did it looking).
   */
  seenAt: string | null;
  /**
   * The routine (routine_jobs.id) that FIRED this task, when it came from a
   * bot's schedule rather than the owner typing — the card's 예약 provenance,
   * and the scheduler's re-enqueue dedupe key. NULL = owner-direct.
   */
  routineJobId: string | null;
  /**
   * 봇 간 위임: the personal_agents.id of the BOT whose turn handed this task
   * off via mcp__personal_agent__delegate_to_bot. NULL when the owner asked
   * directly OR when the owner's MAIN avatar delegated (then only
   * `delegationDepth` says so). Provenance only — capability never changes.
   */
  delegatedByAgentId: string | null;
  /**
   * How many hand-offs deep this task sits: 0 = the owner typed it (or a
   * routine fired it), 1 = delegated by the main avatar or by a depth-0 bot
   * turn, 2 = delegated by a depth-1 turn — the CAP: a depth-2 turn may not
   * delegate further (unbounded bot→bot chains are a cost amplifier).
   */
  delegationDepth: number;
}

/** A group the current user belongs to — surfaced on `User` and the roster. */
export interface UserGroupMembership {
  id: string;
  name: string;
  role: GroupRole;
  /** True when the group has a shared knowledge repo connected. */
  knowledgeRepoConfigured: boolean;
  /** This group's admin tool policy (see {@link Group.allowedMcpToolGroups}); `null` = none. */
  allowedMcpToolGroups: McpToolGroupId[] | null;
  /** This group's avatar-sharing policy (see {@link Group.avatarSharing}). */
  avatarSharing: boolean;
}

/** A plugin found inside a cloned repo, surfaced to the UI for selection. */
export interface RepoPluginEntry {
  name: string;
  // false → listed in the marketplace manifest but missing a valid
  // `.claude-plugin/plugin.json`, so it can't actually be loaded.
  loadable: boolean;
}

/** What a cloned repo contains, for the plugin-selection UI. */
export interface RepoPluginContents {
  // "single": one plugin at the repo root; selection doesn't apply.
  // "marketplace": many plugins; the UI lets the owner pick a subset.
  // "none": not a Claude plugin repo.
  kind: "single" | "marketplace" | "none";
  plugins: RepoPluginEntry[];
}

/**
 * A skill the avatar can invoke, surfaced to colleagues (and the owner) on the
 * chat screen so they can see what the avatar is equipped to do. Read from a
 * plugin's `skills/<name>/SKILL.md` frontmatter.
 */
export interface SkillInfo {
  name: string;
  description: string;
  /** Where the skill came from: "default" (bundled) or the plugin repo slug. */
  source: string;
}

/**
 * One skill an owner shares from their avatar's knowledge repo (#skill-share).
 * Metadata snapshot only — the skill CONTENT stays in the owner's repo and is
 * copied into the learner's repo at learn time (skillTransfer.ts).
 */
export interface SharedSkill {
  id: string;
  ownerUserId: string;
  /** The `skills/<slug>` directory name in the owner's knowledge repo. */
  skillName: string;
  /** SKILL.md frontmatter name at share time (falls back to the dir name). */
  displayName: string;
  /**
   * The EFFECTIVE description every viewer surface shows: the owner's custom
   * introduction when they wrote one, else the frontmatter snapshot. Resolved
   * in the store's row mappers so no consumer has to choose (and none can drift).
   */
  description: string;
  /**
   * The owner's custom, human-facing introduction (소개 문구) — null when never
   * set or cleared back to the frontmatter text. Owner UIs need it separately to
   * tell "custom" from "falling back"; viewers only ever read `description`.
   */
  customDescription: string | null;
  /**
   * The SKILL.md frontmatter description snapshotted at (re-)share time. Kept
   * as its own field because the owner's mine reconciliation compares THIS
   * against the repo to detect drift — comparing the effective text would
   * re-snapshot on every load once a custom intro exists.
   */
  snapshotDescription: string;
  /**
   * How many times this skill has been learned (전수) — total successful learn
   * events for (owner, skillName), surviving unshare→re-share cycles.
   */
  learnCount: number;
  /**
   * Content hash of the sharer's `skills/<slug>/` directory, refreshed
   * whenever the server touches the sharer's clone (share, owner mine
   * reconciliation, preview, learn). Learners compare it against the hash in
   * their copy's origin marker to detect an available update. Null = unknown.
   */
  contentHash: string | null;
  /**
   * Names this share carried BEFORE its current one, oldest first (capped, and
   * never containing the current name). A share FOLLOWS a rename of its
   * `skills/<slug>/` directory, so a learner whose origin marker still records
   * the old name is matched through this trail until their next update rewrites
   * the marker. Empty for a share that was never renamed.
   */
  previousNames: string[];
  createdAt: string;
  updatedAt: string;
}

/** One file inside a shared skill directory, as the preview manifest lists it. */
export interface SharedSkillFile {
  /** Path relative to `skills/<slug>/`, POSIX-separated (SKILL.md included). */
  path: string;
  bytes: number;
}

/**
 * What learning a shared skill would ACTUALLY copy: every file under the
 * sharer's `skills/<slug>/`, not just its SKILL.md. Built by
 * `listSkillFiles` — copySkillDir's traversal minus the copying — so a preview
 * can promise exactly what transfers.
 */
export interface SharedSkillManifest {
  files: SharedSkillFile[];
  totalBytes: number;
  /**
   * The walk could not see the whole tree (transfer caps: 200 files / depth 8),
   * so the listing is partial. Such a skill would fail to learn as well.
   */
  truncated: boolean;
}

/** A shared skill as browsed by a viewer, with owner attribution for cards. */
export interface SharedSkillListing extends SharedSkill {
  owner: {
    id: string;
    username: string;
    displayName: string;
    alias: string;
    hasImage: boolean;
  };
}

/**
 * A member's share as ONE group's admin sees it, for the group-channel
 * moderation list. `blocked` is per-group state, not a property of the share:
 * the same row can be blocked in one group and still learnable through another.
 */
export interface GroupSharedSkill extends SharedSkillListing {
  blocked: boolean;
}

export interface AvatarSummary {
  id: string;
  username: string;
  displayName: string;
  /** The avatar's self-name (별칭); empty falls back to displayName. */
  alias: string;
  bio: string;
  /** Capability hashtags (bare, no "#") for discovery cards + cross-avatar search. */
  hashtags: string[];
  hasImage: boolean;
  pluginCount: number;
  /** Who can discover and chat with this avatar — see {@link AvatarVisibility}. */
  visibility: AvatarVisibility;
  updatedAt: string | null;
  /** External avatars bypass Noah's local Claude/local runtime and tool stack. */
  runtime?: "native" | "external";
  /**
   * True when the viewer shares a group with this avatar's owner (so they
   * auto-trust each other). Set by `listPublishedAvatars`; drives the 탐색
   * "같은 그룹" badge + group-priority ordering. Undefined where not computed.
   */
  sharesGroup?: boolean;
  /**
   * Set ONLY for group shared agents (avatar id `group:<groupId>`): the kind
   * tag plus the owning group's name for badges/labels. Runtime stays "native"
   * — a group agent runs the full local SDK stack, unlike external avatars.
   */
  groupAgent?: { groupId: string; groupName: string };
  /**
   * Set ONLY for the OWNER's own personal agents (avatar id
   * `personal:<ownerUserId>:<agentId>`): the kind tag for the 내 봇 badge plus
   * the bot's model-tier default, which seeds a NEW conversation with it
   * (client makePane). Runtime stays "native" — a bot runs the full local SDK
   * stack, unlike external avatars.
   */
  personalAgent?: { agentId: string; defaultModel: string | null };
}

export interface AvatarDetail extends AvatarSummary {
  persona: string;
  /** First-person self-introduction shown in the explore-page intro dialog. */
  intro: string;
  isOwn: boolean;
  /**
   * True when the viewer may use tools at the owner's level — they're the owner
   * (isOwn) OR a trusted user. Drives the chat UI (hide the "read-only" label).
   */
  elevated: boolean;
  plugins: { repo: string; label: string | null }[];
}

export interface ConversationSummary {
  id: string;
  avatarUserId: string;
  avatarDisplayName: string;
  title: string;
  updatedAt: string;
  isRoutine: boolean;
  routineId: string | null;
  routinePrompt: string | null;
  /**
   * Live run for this conversation, attached per request by GET /api/conversations
   * from the in-memory run registry — never a stored column, so the store's own
   * summaries omit it. null = idle; `background` true means the visible turn is
   * finalized while SDK background work keeps the session alive.
   */
  activeRun?: { background: boolean } | null;
}

/**
 * Supported chat image-attachment media types. Mirrors what the Claude API
 * accepts as an `ImageBlockParam` base64 source, intersected with the formats a
 * browser can produce/preview. GIF is allowed in (the model reads it) but the
 * client downsizes to PNG/JPEG/WEBP, so it mostly appears on pasted/dropped GIFs.
 */
export type ImageMediaType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/**
 * A file attached to a user or assistant chat message. Images live on disk under
 * `dataDir/chat-images/<conversationId>/<id>.<ext>` (see `chatImages.ts`) and are
 * served by `GET /api/conversations/:id/images/:imageId`; generated documents
 * (`kind:"file"`, see `chatFiles.ts`) live under `dataDir/chat-files/…` and are
 * served as downloads by `GET /api/conversations/:id/files/:fileId`. This is the
 * metadata persisted on the message so the bubble can rebuild after reload. The
 * model is fed image bytes as content blocks on the turn — see {@link AgentImageInput}.
 */
export interface MessageAttachment {
  /** Stable id; also the on-disk filename stem and the serving-URL segment. */
  id: string;
  kind: "image" | "file";
  /** MIME type: one of {@link ImageMediaType} for images; document MIME for files. */
  mediaType: string;
  /** Original filename, for the alt text / download name (optional). */
  name?: string;
  /** Optional agent-provided description shown below the image. */
  caption?: string;
  /** File size in bytes (`kind:"file"` only) — shown on the download card. */
  size?: number;
  /**
   * Published for URL use only (e.g. slide PNGs embedded in a canvas): the
   * serving route works, but the bubble does not render it.
   */
  hidden?: boolean;
  /**
   * Hidden preview slides only: id of the visible `kind:"file"` card (same
   * message) they preview, so the file-preview panel shows ONLY that card's
   * slides. Absent on legacy slides → they belong to whichever card is clicked.
   */
  parentId?: string;
  /**
   * Character offset into the message text at the moment the attachment was
   * shown/shared, so the bubble renders the card inline AT that point instead
   * of below the text (where later streaming would keep pushing it down).
   * Absent (legacy rows, user uploads) → the card renders after the text.
   */
  anchor?: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Images attached to this message; absent/[] when none. */
  attachments?: MessageAttachment[];
  /**
   * `"steer"` marks a USER message the viewer sent WHILE the avatar's previous
   * turn was still running (a mid-turn message, delivered to the model between
   * tool calls or as the head of the follow-up turn). Absent on ordinary rows.
   * Persisted in `messages.kind`; the client renders these with a small
   * "응답 중 전달" badge. Only ever set on `role: "user"` rows.
   */
  kind?: "steer";
  response: AgentResponse | null;
  createdAt: string;
}

/**
 * One image fed to the model as an `ImageBlockParam` on a chat turn (base64,
 * no `data:` prefix). The server decodes the uploaded data URL / reads the
 * stored file into this shape; {@link runClaudeAgent} turns it into a
 * structured SDK user message (text + image blocks) instead of a plain string.
 */
export interface AgentImageInput {
  mediaType: ImageMediaType;
  data: string;
}

/** A vision-off image attachment staged as a FILE in the run's scratch workspace (never fed to the model as content blocks — only its path is mentioned in the user prompt). */
export interface AgentImageFileInput {
  /** Absolute path of the staged copy inside the conversation scratch workspace. */
  path: string;
  mediaType: ImageMediaType;
  /** Original upload filename, when the client sent one. */
  name?: string;
}

export interface AgentConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  status: string;
  detail: string;
  createdAt: string;
}

export interface AdminUserSummary {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  visibility: AvatarVisibility;
  /** True when the account is suspended (blocked from logging in / pending approval). */
  suspended: boolean;
  hasImage: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  activeSessions: number;
}

/** How new self-service signups are handled. Always allows the very first
 *  (admin-bootstrap) account regardless of mode. */
export type SignupMode = "open" | "closed" | "approval";

/** Deployment-wide counts for the admin dashboard. */
export interface AdminStats {
  users: number;
  admins: number;
  suspended: number;
  /** Count of avatars with `group` visibility (discoverable by group teammates). */
  groupAvatars: number;
  conversations: number;
  messages: number;
  openRequests: number;
  activeRoutines: number;
  activeSessions: number;
  groups: number;
}

/** One user counted as "here right now" by the admin presence badge. */
export interface AdminPresenceUser {
  id: string;
  username: string;
  displayName: string;
  hasImage: boolean;
  lastSeenAt: string;
}

/**
 * Who is actually using the deployment at this moment (admin-only). Distinct
 * from `AdminStats.activeSessions`, which counts 14-day login cookies and so
 * says nothing about whether anyone is at the screen.
 */
export interface AdminPresence {
  /** Freshness window the list was computed with, so the UI can label it. */
  windowMinutes: number;
  users: AdminPresenceUser[];
}

/** Per-user breakdown shown when an admin expands a row. */
export interface AdminUserDetail extends AdminUserSummary {
  /** Conversations this user started (as an owner talking to avatars). */
  conversationsStarted: number;
  /** Conversations other people had with THIS user's avatar. */
  conversationsReceived: number;
  pluginCount: number;
  secretCount: number;
  routinesTotal: number;
  routinesActive: number;
  openRequests: number;
  activeSessions: number;
  gitTokenSet: boolean;
  knowledgeRepoSet: boolean;
}

/** Token usage for a single chat turn, surfaced to the client for display. */
export interface AgentUsage {
  /**
   * Live context-window occupancy at the end of the turn — the SDK's
   * authoritative `getContextUsage().totalTokens` when available, else the final
   * request's prompt-size snapshot (input + cache read + cache creation, see
   * `mainAssistantContextTokens`). A snapshot, NOT the cumulative sum across the
   * turn's requests, so `inputTokens / contextWindow` is a meaningful fill %.
   * 0 marks a turn with no honest occupancy figure (the badge then shows
   * output-only).
   */
  inputTokens: number;
  /** Tokens the model generated this turn (cumulative across all requests). */
  outputTokens: number;
  /**
   * Of `outputTokens`, the portion spent on internal reasoning (extended
   * thinking), when the SDK reports it. Lets the badge separate reasoning from
   * the visible reply so a short answer with heavy thinking doesn't read as a
   * bogus "출력" count. Omitted/0 when the turn did no reasoning.
   */
  thinkingTokens?: number;
  /** The model's context-window size, if known (getContextUsage/modelUsage). */
  contextWindow?: number;
}

/**
 * One interactive control the avatar declares on a visual-canvas artifact. The
 * AVATAR only DECLARES these (it never emits executable JS — CSP-safe); the
 * client renders real form controls and posts the submitted value back through
 * the existing `/api/chat/respond` interactive-prompt path. Part of the
 * `canvas` experimental feature (#50).
 */
export interface CanvasControl {
  /**
   * The control kind. All render as native HTML form elements (CSP-safe):
   * - "buttons" → single/multi choice shown as option cards
   * - "text"    → a one-line or multiline freeform input
   * - "select"  → a dropdown (for many options where buttons get unwieldy)
   * - "slider"  → a numeric range (<input type=range>) with min/max/step
   * - "number"  → a precise numeric input (<input type=number>)
   * - "date"    → a calendar date picker, submitted as a "YYYY-MM-DD" string
   */
  type: "buttons" | "text" | "select" | "slider" | "number" | "date";
  /** Stable id used as the key in the submitted-values object. */
  id: string;
  /** Optional label shown above the control. */
  label?: string;
  /** buttons | select: the selectable options. */
  options?: { label: string; value?: string; description?: string }[];
  /** buttons: allow selecting more than one option. */
  multiSelect?: boolean;
  /** text: placeholder shown in the empty input. */
  placeholder?: string;
  /** text: render a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  /** slider | number: lower numeric bound. */
  min?: number;
  /** slider | number: upper numeric bound. */
  max?: number;
  /** slider | number: increment step. */
  step?: number;
  /**
   * Whether the user must provide a value before submitting. Defaults to TRUE
   * (preserving the original block-until-filled behavior); set false to let the
   * user skip this control.
   */
  required?: boolean;
  /** Initial value: slider/number start, select preselection, date initial. */
  defaultValue?: string | number;
}

/**
 * Supported visual-canvas content kinds. All are rendered client-side WITHOUT
 * executing avatar-authored JS: markdown/svg/html are sanitized (DOMPurify),
 * mermaid is rendered from text by the bundled mermaid library, and `vega` is a
 * compact Vega-Lite JSON spec rendered to SVG via the CSP-safe Vega expression
 * interpreter (no `Function` constructor) — so the strict same-origin CSP stays
 * unchanged (#50). `vega` lets the avatar declare a chart in a tiny spec instead
 * of hand-authoring verbose SVG, which is far cheaper in tokens.
 */
export type CanvasContentType =
  | "markdown"
  | "svg"
  | "html"
  | "mermaid"
  | "vega";

/**
 * A visual-canvas artifact the avatar showed in the side panel during a turn,
 * persisted on the assistant message's {@link AgentResponse} so the panel can be
 * rebuilt on reload and the conversation continued from it (#50).
 */
export interface CanvasArtifact {
  id: string;
  title: string;
  content: string;
  contentType: CanvasContentType;
  /** Declared interactive controls, if the avatar requested input. */
  controls?: CanvasControl[];
  /** The values the user submitted for `controls` (when they did). */
  submittedValues?: Record<string, unknown>;
  /**
   * How this canvas collects input (experimental interaction model):
   * - "blocking" → the run parks until the user submits (via /api/chat/respond)
   * - "async"    → the run completes; the user's later submission arrives as a NEW
   *   chat turn (via /api/chat/stream)
   * undefined = display-only (no controls).
   */
  interaction?: "blocking" | "async";
  /** The user may edit/annotate the content and send the edited version back as a new turn. */
  editable?: boolean;
  /** Current version number of this artifact (1-based; canvas version history). */
  currentVersion?: number;
  /** Total number of stored versions for this artifact. */
  versionCount?: number;
}

/** One entry in a canvas artifact's version history (canvas version history). */
export interface CanvasVersion {
  version: number;
  createdAt: string;
}

/**
 * A snapshot of the activity tree (sub-agents + tool/task/blocked rows) that ran
 * during a turn, kept on the assistant message so the COMPLETED bubble still shows
 * what the avatar did — otherwise the live activity tree vanishes the instant the
 * run finishes. Structurally mirrors the client's activity rows. `tools.kind ===
 * "task"` is kept for old stored snapshots; new clients store SDK tasks in
 * `tasks` instead.
 */
export interface AgentActivity {
  agents: {
    id: string;
    parentId: string;
    label: string;
    status: "running" | "done" | "failed";
    isMain: boolean;
  }[];
  tools: {
    id: string;
    agentId: string;
    kind: "tool" | "task" | "blocked" | "memory" | "compact";
    label: string;
    detail?: string;
    status: "running" | "done" | "failed" | "blocked";
  }[];
  tasks?: {
    id: string;
    agentId: string;
    label: string;
    detail?: string;
    status: "running" | "done" | "failed";
  }[];
}

export interface AgentResponse {
  kind: "text";
  runtime: "local" | "claude" | "external";
  summary: string;
  text: string;
  /**
   * SDK result error subtype (e.g. `error_max_turns`) when the run ended in an
   * in-band error instead of throwing — `text` then carries a Korean fallback
   * message, NOT model output. Programmatic consumers (avatar consultation)
   * check this to fail instead of relaying the fallback as an answer; the chat
   * route keeps rendering `text` unchanged.
   */
  resultError?: string;
  /** Per-turn token usage (Claude runtime only; omitted for local runs). */
  usage?: AgentUsage;
  /**
   * LEGACY: visual-canvas artifacts shown this turn. Canvas artifacts now persist
   * in the dedicated `canvas_artifacts`/`canvas_versions` tables (see store), so
   * new turns no longer write this field. Kept ONLY so pre-migration stored
   * `response_json` still parses and the one-time backfill can read it.
   */
  canvases?: CanvasArtifact[];
  /**
   * The plan the avatar submitted via ExitPlanMode this turn (plan mode), kept on
   * the assistant message so the dedicated plan card rebuilds on reload. The
   * latest plan of the turn wins. Display-only — autoApprove turns continue
   * automatically, so there is no accept/reject state to persist.
   */
  plan?: string;
  /**
   * The model's reasoning (extended-thinking) text for this turn, kept on the
   * assistant message so a collapsible "생각 과정" view rebuilds on reload.
   * Only captured on the streaming chat path (no viewer → not persisted).
   */
  thinking?: string;
  /** Activity-tree snapshot so the completed bubble keeps showing tool/agent runs. */
  activity?: AgentActivity;
  raw?: unknown;
}

export interface AgentAvatar {
  id: string;
  displayName: string;
  /** The avatar's self-name (별칭); empty falls back to displayName. */
  alias: string;
  persona: string;
}

/**
 * Deployment proxy env self-state for the web fetch tool (META-COGNITION).
 * Derived by `webFetchProxyState()` (webFetchTools.ts) with proxy URLs REDACTED
 * to scheme://host:port — credentials never enter a prompt. `null` = unset.
 */
export interface WebFetchProxyState {
  httpProxy: string | null;
  httpsProxy: string | null;
  noProxy: string | null;
  /** Bootstrap-reported deployment policy; not an independent firewall audit. */
  egressPolicy?: "domain-proxy";
}

export interface EgressPolicyState {
  configured: boolean;
  proxyReady: boolean;
  domains: string[];
  revision: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
}

export interface AgentRequest {
  message: string;
  avatar: AgentAvatar;
  /**
   * The conversation this turn belongs to. Lets in-process MCP tools key
   * per-conversation state — e.g. `mcp__git_repo__open_repo` records the working
   * repo selection (repoWorkspace.ts) the chat route reads on the next turn.
   */
  conversationId?: string;
  /** Per-avatar working directory the SDK runs in (filesystem isolation). */
  cwd?: string;
  /**
   * SDK session id to resume (the prior turn's session for THIS conversation).
   * When set, the SDK reloads that session's transcript so the model keeps the
   * conversation's context instead of starting fresh. Unset → a new session.
   */
  resumeSessionId?: string;
  /**
   * Stored transcript fallback used only when no SDK session id is available.
   * Normal conversations continue through SDK `resume`; this keeps first-turn
   * cancellations or expired SDK transcripts from losing the visible context.
   */
  conversationHistory?: AgentConversationMessage[];
  /** The user currently chatting (may differ from the avatar's owner). */
  viewerUserId?: string;
  viewerName?: string;
  /** True when the viewer IS the avatar's owner (viewer.id === avatar.id). */
  viewerIsOwner?: boolean;
  /**
   * Set ONLY for group shared-agent runs (avatar id `group:<groupId>:<agentId>`):
   * pins the run to ONE group's resources. The run kind carries capability —
   * owner-only tools never unlock (there is no owner), built-in access is
   * elevated-class, and only the group repo/brain servers register, gated per
   * call on the ACTING member's live membership/role. `captureAllowed` is the
   * AGENT's capture_scope policy resolved against `viewerRole` at request time.
   */
  groupAgent?: {
    groupId: string;
    agentId: string;
    groupName: string;
    viewerRole: GroupRole;
    captureAllowed: boolean;
  };
  /**
   * Set ONLY for PERSONAL-AGENT (내 봇) runs, by the chat route and nothing
   * else. A personal-agent run stays a FULL OWNER run: `avatar` above is the
   * OWNER's own avatar (`avatar.id` = the owner's uuid) and the composite
   * `personal:<owner>:<agent>` id lives only in the conversation binding /
   * workspace keying / client-facing summaries. This field carries IDENTITY,
   * not capability — it must NEVER flow into `deriveAgentToolAccess` /
   * `planMcpToolFamilies` (that is what `groupAgent` above does, and it is a
   * kill-switch). It drives the prompt identity swap, the `describe_system`
   * block, self-config tool registration, and routine-tool suppression.
   */
  personalAgent?: {
    agentId: string;
    ownerUserId: string;
    /**
     * The `bot_tasks` row tracking THIS turn as a delegated task (set by the
     * chat route / the queued-task dispatcher alongside the row transition).
     * Identity/bookkeeping only — capability must stay untouched, exactly like
     * the parent field. Absent on turns that track no task (e.g. greetings).
     */
    taskId?: string;
  };
  /**
   * True when the viewer may use tools at the OWNER's permission level — i.e. the
   * owner themselves OR a designated trusted user. Gates the tool hook (write/Bash
   * run instead of read-only). DISTINCT from viewerIsOwner: the owner-only knowledge
   * inbox (pending_requests) still keys off viewerIsOwner, so a trusted user gets
   * elevated tools WITHOUT the owner's gap inbox.
   * Headless runs normally stay read-only; owner-scheduled routines opt into
   * owner-level tools through `allowHeadlessTools`.
   */
  elevated?: boolean;
  /**
   * Internal safety valve for owner-scheduled routines. `headless` still means
   * no questions/prompts are possible, but this lets the routine run with the
   * same owner tool permissions as a normal owner chat.
   */
  allowHeadlessTools?: boolean;
  /**
   * True for unattended runs (scheduled routines): no human is present, so the
   * agent must not ask questions, interactive permission prompts are denied,
   * and knowledge writes are blocked — the run is strictly read-only.
   */
  headless?: boolean;
  /**
   * True when this turn was submitted by an EXTERNAL SYSTEM through the owner's
   * personal task API (`ChatTurnContext.externalTaskId`), not typed by the
   * owner. Provenance for the prompt/describe_system and for the
   * interactive-only gates (`create_agent` is registered only for turns a person
   * is having with their own avatar): the run itself keeps the owner's full
   * capability, and questions/permission prompts still park for an answer
   * through the task API or the Noah UI.
   */
  externalTaskApi?: boolean;
  /**
   * True when the viewer can send ADDITIONAL user messages while this turn is
   * still running (an interactive streaming chat with a live steer channel —
   * see `agent/steerChannel.ts`). Such a message reaches the model between
   * tool calls of the current turn, or starts the next turn if the current one
   * has already finished. META-COGNITION only: surfaced in
   * `buildSystemPromptAppend` and `describe_system` so the avatar expects
   * late-arriving instructions instead of treating them as noise. Never set on
   * headless / external-task-API runs.
   */
  midTurnMessages?: boolean;
  /**
   * Auto-approve tool use: skip the interactive permission prompt and run
   * non-read-only tools without asking. Honored on the elevated, non-headless
   * path (`elevated && !headless`) for owner AND trusted users alike — the tool
   * gate (read-only deny for non-elevated viewers) is the real safety boundary,
   * so auto-approve is safe to apply broadly. A headless routine or a plain
   * colleague chat stays read-only regardless.
   */
  autoApprove?: boolean;
  /**
   * User-chosen model TIER (alias `opus`/`sonnet`/`haiku`) for this conversation,
   * from the chat composer. Resolved against env pin / admin override in
   * claudeAgent (env pin wins, then this tier, then the admin override). The alias
   * is passed straight to the SDK; the concrete model is the operator's call via
   * ANTHROPIC_DEFAULT_*_MODEL. Unset → server default resolution. (See modelTiers.ts.)
   */
  modelTier?: string;
  /**
   * User-chosen reasoning EFFORT level (`low`/`medium`/`high`/`xhigh`/`max`) for
   * this conversation, from the chat composer. Passed straight to the SDK as
   * `options.effort`; the SDK silently downgrades levels the selected model does
   * not support. Independent of the model pin. Unknown/unset → SDK default
   * (`high`). (See effortLevels.ts.)
   */
  effort?: string;
  /**
   * MCP tool groups enabled for this conversation/run. Undefined means the
   * server default (all groups) for backward compatibility with older clients.
   * The chat route validates and persists these IDs per conversation.
   */
  mcpToolGroups?: McpToolGroupId[];
  /**
   * MCP tool groups BLOCKED for this run by the system admin's per-group tool
   * policy (`groups.allowed_mcp_tool_groups`, intersected across the driving
   * user's groups). Set BY runAgentStream itself; the prompt build uses it
   * ONLY to exclude these groups from the "user deselected" standing note —
   * the avatar is deliberately NOT told that a policy exists or which groups
   * it blocks (it only knows its enabled set). Callers never set it.
   */
  adminBlockedMcpToolGroups?: McpToolGroupId[];
  /**
   * Opt into model fallback: when the run fails on a transient model/server-side
   * error (overload/5xx/429/network), retry on the next-lower tier down the chain
   * (resolved model → … → haiku). Set ONLY for scheduled routines — headless runs
   * have no live stream, so re-running is clean. An env-pinned `ANTHROPIC_MODEL`
   * is a hard lock and disables fallback. Unset → single attempt (chat behavior).
   */
  modelFallback?: boolean;
  /**
   * Names of the avatar owner's configured secret-tab environment variables.
   * Values are never included. Set only for owner-driven turns: owner chats
   * AND owner-scheduled routines running with owner tool access.
   */
  secretNames?: string[];
  /**
   * Subset of `secretNames` the owner opted into agent-shell exposure for
   * (per-key toggle). Drives the standing prompt note that these are usable as
   * `$NAME` in Bash on elevated runs, with tool outputs redacted. Same gating
   * as `secretNames`.
   */
  shellExposedSecretNames?: string[];
  /**
   * Secrets the owner enabled for BROWSER INPUT (설정 → 시크릿 → 브라우저 입력):
   * name + allowed hosts + password-field-only flag, values never included.
   * Drives the standing browser-paragraph guidance that a login uses
   * `type`/`fill_form`'s `secretName` instead of a literal credential. Same
   * gating as `secretNames`; meaningful only when the browser bridge is on.
   */
  browserSecrets?: BrowserSecretPolicy[];
  /**
   * Whether the avatar owner has connected a personal knowledge repo. Filled by
   * the server before building the Claude prompt; undefined means "unknown" for
   * direct unit calls.
   */
  knowledgeRepoConfigured?: boolean;
  /**
   * Whether the avatar owner has stored the internal GIT_TOKEN. Lets the
   * prompt guide direct knowledge-repo creation (via the repo tool) vs. asking
   * the owner to set a token first. Set only for owner, non-headless chat prompts.
   */
  gitTokenSet?: boolean;
  /**
   * How many skills teammates' avatars currently share with this owner
   * (#skill-share). Owner-driven turns only (same gate as the
   * `mcp__skill_exchange__*` registration); drives the standing skill-exchange
   * prompt note. Undefined means "unknown" for direct unit calls.
   */
  learnableSkillCount?: number;
  /** How many skills this owner currently shares. Same gating as above. */
  sharedSkillCount?: number;
  /**
   * GitHub host the server is currently configured to use for shorthand repos
   * and repo creation. Safe to show in prompts/tool descriptions; it is not a
   * credential.
   */
  githubHost?: string;
  /** Whether the deployment has a Confluence host configured. */
  confluenceUrlConfigured?: boolean;
  /** Whether the avatar owner has stored a Confluence PAT secret. */
  confluencePatConfigured?: boolean;
  /**
   * Redacted proxy env self-state for `mcp__web__fetch` guidance (set by
   * `runClaudeAgent` from the live env). Undefined means "unknown" for direct
   * unit calls — the prompt then omits the proxy detail sentence.
   */
  webFetchProxy?: WebFetchProxyState;
  /**
   * Groups the avatar owner belongs to, with role + whether each has a shared
   * knowledge repo. Injected into the prompt so the avatar knows its group
   * context (META-COGNITION). Set only for owner-driven turns (owner chats and
   * owner-scheduled routines) — group repo tools register on the same gate.
   */
  groupMemberships?: UserGroupMembership[];
  /**
   * Whether the avatar owner marked their account as a shared (communal)
   * account (`User.sharedAccount`). Filled by the server from the owner's row
   * before building the prompt (like `knowledgeRepoConfigured`); drives the
   * teammate-branch guidance that repo WRITES are allowed here, and the owner
   * self-state note (META-COGNITION). Undefined means "unknown"/false for
   * direct unit calls.
   */
  sharedAccount?: boolean;
  /**
   * Group names the (non-owner) viewer shares with the avatar owner — i.e. the
   * REASON this viewer is auto-trusted, when group co-membership is the source.
   * Lets the prompt explain why the current colleague is elevated
   * (META-COGNITION) instead of presenting trust as unexplained. Group
   * co-membership is the ONLY trust source, so this is empty for the owner and
   * for plain colleagues (a non-owner sharing no group).
   */
  trustedViaGroups?: string[];
  /**
   * Standing CLAUDE.md memory read from the avatar's knowledge repos and injected
   * into the prompt every turn (push, unlike on-demand skills). `personal` is the
   * owner's personal repo root CLAUDE.md; `groups` are the enabled group repos'.
   * The server (chat route / scheduler) loads + caps it; intro/hashtag generation
   * leaves it unset. Group filtering reflects the owner-only per-conversation
   * group-knowledge toggle.
   */
  knowledgeMemory?: {
    personal?: string | null;
    groups?: { name: string; content: string }[];
  };
  /**
   * Whether the avatar owner enabled the experimental `canvas` feature AND this
   * is an interactive (non-headless) turn where the canvas tool is registered.
   * Drives standing prompt guidance telling the avatar it can show visual
   * canvases via `mcp__canvas__show` (#50). Set for ALL viewer classes of such a
   * turn — colleagues see canvases too; it grants no elevation.
   */
  canvasEnabled?: boolean;
  /**
   * This interactive turn can drive the VIEWER's own browser through the
   * extension bridge (`mcp__browser__*`). Requires a system admin talking to
   * their OWN avatar in an interactive turn — so unlike `canvasEnabled` this is
   * never set for a colleague, a routine, or a group agent.
   * Mirrored by describe_system (META-COGNITION).
   */
  browserEnabled?: boolean;
  /**
   * The Noah app's OWN public origin (scheme + host) as the user's browser
   * reaches it, derived from the chat request (honouring the reverse proxy).
   * Lets browser-driving tools build an absolute URL to a Noah-served page — the
   * clipboard-staging page `copy_image` returns — that the agent opens with
   * `new_tab`. Owner/interactive turns only; undefined when it can't be derived.
   */
  appOrigin?: string;
  /**
   * The OS of the browser this turn drives, derived from the chat request's
   * User-Agent (the bridge relays into the browser that is making the request).
   * Drives the paste-shortcut wording in the browser tool text and prompt
   * guidance — Cmd+V on macOS, Ctrl+V elsewhere. Undefined when the UA says
   * nothing usable; the wording then mentions both.
   */
  viewerPlatform?: "mac" | "windows" | "linux";
  /**
   * This interactive turn can publish PNG/JPEG/WebP/GIF files from its allowed
   * working directories into the assistant bubble with `show_file`, and share
   * generated documents as download cards with `share_file`.
   */
  fileOutputEnabled?: boolean;
  /**
   * The deployment image carries the LEGACY PPTX toolchain (LibreOffice +
   * pdftoppm + python-pptx) AND this turn can publish files AND its viewer may
   * author a deck (`deckAuthoring === "allowed"`: Bash/Write access, `pptx`
   * skill not admin-disabled). Drives the legacy deck standing guidance
   * (python-pptx → share_file). Mirrored by describe_system (META-COGNITION).
   */
  deckRenderingEnabled?: boolean;
  /**
   * The pptx skill's HTML→editable-PPTX converter is installed (boot probe,
   * `deckToolchain.converter`) AND the same file-output + authoring conditions
   * as `deckRenderingEnabled` hold. Selects the CONVERTER branch of the deck
   * standing guidance, which wins when both flags are set. Mirrored by
   * describe_system's `converter: INSTALLED` deck line (META-COGNITION).
   */
  deckConverterEnabled?: boolean;
  /**
   * Whether the active model accepts image input. `false` injects the
   * no-vision standing warning (image/PDF Read blocked, uploads disabled);
   * undefined/true adds nothing. Mirrors `AppConfig.visionEnabled`.
   */
  visionEnabled?: boolean;
  /**
   * Experimental (beta) feature keys enabled for the avatar owner. Surfaced in
   * the owner/routine self-state (META-COGNITION) so the avatar knows which beta
   * behaviors are active. Set only for owner-driven turns. (#50)
   */
  experimentalFeatures?: string[];
  /**
   * Admin tool/skill policy self-state (META-COGNITION): built-in tools /
   * skills the system administrator disabled deployment-wide. Set by
   * `runClaudeAgent` for every viewer class — a disabled skill can still
   * appear in the CLI's skill listing (stale discovery cache), so the standing
   * prompt note keeps the avatar from attempting or suggesting it.
   */
  adminDisabledTools?: string[];
  adminDisabledSkills?: string[];
  /**
   * GROUP-AGENT self-state (META-COGNITION), set by `runClaudeAgent` for
   * group-agent runs only: feeds the group-agent prompt branch the same facts
   * `describe_system` reports (see {@link GroupAgentState}). Null when the
   * agent/group vanished mid-run (the branch then renders a minimal identity).
   */
  groupAgentState?: GroupAgentState | null;
  /**
   * PERSONAL-AGENT self-state (META-COGNITION), set by `runClaudeAgent` for
   * personal-agent runs only: feeds the 내 봇 prompt branch the same facts
   * `describe_system` reports (see {@link PersonalAgentState}). Null when the
   * bot vanished mid-run (the branch then renders a minimal identity).
   */
  personalAgentState?: PersonalAgentState | null;
  /**
   * OWNER self-state (META-COGNITION) read from `OwnerState.personalAgentsEnabled`
   * and stamped onto the request by `runClaudeAgent`, alongside `secretNames` /
   * `groupMemberships` / `learnableSkillCount` — the prompt builder takes every
   * store-derived fact from that one stamp site.
   *
   * True only when THIS run actually registered
   * `mcp__personal_agent__create_agent`: an owner-driven, interactive, non-bot
   * run whose owner still holds the admin role (runPlan's
   * `personalAgentCreateActive`). Blanked like the other owner facts for
   * colleague/teammate/consultation/headless runs, so the standing 내 봇 creation
   * guidance can never offer a tool the run lacks. False on a bot run too, which
   * carries `update_profile` instead.
   */
  avatarApiKeyCount?: number;
  /**
   * The configured wall-clock budget for ONE external task API run
   * (`config.avatarTaskRunTimeoutMs`, META-COGNITION), stamped by
   * `runClaudeAgent` so the prompt can state it: on an API run
   * (`externalTaskApi`) it is THIS run's budget, and the standing External task
   * API line tells the owner how long a task may run. describe_system reads
   * the same config value directly.
   */
  avatarTaskRunTimeoutMs?: number;
  personalAgentsEnabled?: boolean;
  /**
   * Display names of the owner's ENABLED bots only (a disabled bot is not
   * chattable, so naming it would be misleading) — the roster for that same
   * standing guidance, stamped from `OwnerState.personalAgentNames` and blanked
   * on the same runs.
   */
  personalAgentNames?: string[];
  /**
   * The registered git repo the avatar opened as this conversation's **working
   * repository** (`mcp__git_repo__open_repo`): the repo's registered name. Its
   * clone is the SDK cwd, so the avatar edits/tests and commits locally with
   * native tools while remote git (push/sync) still flows through
   * `mcp__git_repo__*`. Drives the working-repo prompt guidance + the Bash-git
   * integrity policy.
   */
  activeRepoName?: string;
  /**
   * Extra writable directories to expose to the SDK beyond the plugin roots —
   * e.g. the per-conversation scratch workspace when the cwd has been repointed
   * at the opened working-repo clone.
   */
  additionalDirs?: string[];
  /**
   * Images attached to THIS turn's user message, fed to the model as image
   * content blocks. When present (and non-empty), `runClaudeAgent` sends a
   * structured SDK user message (the prompt text + these image blocks) instead
   * of a plain string prompt; empty/unset keeps the plain-string path unchanged.
   * Unused for headless turns.
   */
  images?: AgentImageInput[];
  /**
   * Images attached to THIS turn's user message when the turn's model is
   * TEXT-ONLY: staged as copies inside the conversation scratch workspace so the
   * agent can act on them as files. `buildUserPrompt` lists their paths as plain
   * text — the bytes never enter model input. Mutually exclusive with
   * {@link AgentRequest.images}; unused for headless/external turns.
   */
  imageFiles?: AgentImageFileInput[];
  /**
   * True when this run IS an avatar-to-avatar consultation (#ask-avatar): a
   * headless one-shot turn another avatar started via `mcp__avatars__ask_avatar`.
   * Doubles as the DEPTH GUARD (a consultation run never registers the ask tool,
   * so chains like A→B→C are impossible) and as the prompt discriminator (the
   * headless branch frames the turn as a teammate consultation, not a routine).
   * Set only by `askAvatar` (avatarAsk.ts); callers never set it.
   */
  avatarConsultation?: boolean;
}

/**
 * A gap in the avatar's knowledge: something a colleague asked that the avatar
 * didn't know, queued in the owner's inbox. The owner clears it once handled
 * (e.g. after teaching the avatar via a plugin) — there is no stored answer.
 */
export interface KnowledgeRequest {
  id: string;
  avatarUserId: string;
  askerUserId: string | null;
  askerName: string | null;
  question: string;
  status: "open" | "resolved";
  createdAt: string;
}

/** In-app message an avatar leaves for its owner to notice later. */
export interface AvatarNotification {
  id: string;
  ownerUserId: string;
  avatarUserId: string;
  avatarDisplayName: string;
  title: string;
  message: string;
  conversationId: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * A scheduled task the avatar's owner creates: a prompt the avatar runs by
 * itself once, daily, weekly, or at a fixed interval (KST wall-clock for
 * once/daily/weekly). Results are appended to a dedicated routine conversation
 * the owner can inspect from the routine view.
 */
export interface RoutineJob {
  id: string;
  /** The avatar (and owner — owner chats with their own avatar). */
  avatarUserId: string;
  /** The dedicated conversation routine results are appended to. */
  conversationId: string;
  /** Optional human label for the routine; null when unset. */
  name: string | null;
  /** The message the avatar runs on each firing. */
  prompt: string;
  /** Whether the schedule runs once, daily, weekly, or at a fixed interval. */
  scheduleKind: ScheduleKind;
  /** Minutes from midnight **in Seoul time (KST)** (0..1439) the job fires at. */
  minuteOfDay: number;
  /** "HH:MM" rendering of minuteOfDay, for convenience on the client. */
  time: string;
  /** weekly only: sorted unique ints 0(Sun)..6(Sat); null otherwise. */
  daysOfWeek: number[] | null;
  /** interval only: minutes between firings (5..10080); null otherwise. */
  intervalMinutes: number | null;
  /** once only: YYYY-MM-DD in KST; null for recurring schedules. */
  runDate: string | null;
  enabled: boolean;
  /** Next scheduled firing (ISO, UTC); null while disabled or completed. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  /** Set after a one-time schedule has made its single execution attempt. */
  completedAt: string | null;
  createdAt: string;
  /**
   * 봇 루틴: the personal_agents.id this routine belongs to, or NULL for the
   * owner's main avatar (every legacy row). A bot routine fires as a DELEGATED
   * BOT TASK in a composite-bound routine thread — capability stays the A-1
   * full-owner run either way; this field only picks the identity/thread.
   */
  personalAgentId: string | null;
}

/**
 * The optional schedule-field patch shared by `createRoutineJob`/
 * `updateRoutineJob`: every schedule field is optional, and callers supplying a
 * subset leave the rest at their default (create) or current value (update).
 */
export interface RoutineSchedulePatch {
  scheduleKind?: ScheduleKind;
  minuteOfDay?: number;
  daysOfWeek?: number[] | null;
  intervalMinutes?: number | null;
  runDate?: string | null;
}

export interface PluginRoot {
  type: "local";
  path: string;
}

/** A file or directory entry in a user's knowledge-repo working tree. */
export interface KnowledgeRepoTreeEntry {
  /** Path relative to the repo root, POSIX-separated (e.g. "skills/foo/SKILL.md"). */
  path: string;
  type: "file" | "dir";
}

/**
 * A node in the second-brain knowledge graph: one markdown note in the vault,
 * or a `[[dangling]]` link target with no matching note file.
 */
export interface KnowledgeGraphNode {
  /** Repo-relative path for a real note (e.g. "wiki/concepts/deploy.md"); `unresolved:<target>` for a dangling link. */
  id: string;
  /** Display label — the note's frontmatter `title`, its filename stem, or the raw link target when dangling. */
  label: string;
  /** Vault section for coloring: raw | sources | entities | concepts | synthesis | wiki | other | unresolved. */
  section: string;
  tags: string[];
  /** True when this node is only a `[[link]]` target with no backing note file. */
  dangling?: boolean;
}

/** A directed `[[wikilink]]` from one note to another (or to a dangling target). */
export interface KnowledgeGraphEdge {
  /** Source node id (the linking note's path). */
  source: string;
  /** Target node id (the linked note's path, or `unresolved:<target>`). */
  target: string;
}

/** The `[[wikilink]]` graph over a knowledge repo's `raw/`+`wiki/` notes. */
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  /** True when the repo predates the vault layout (no `wiki/`/`raw/`) — client points at brain-migrate. */
  noVault?: boolean;
}

/** A single vault note's raw markdown, served to the graph view's content panel. */
export interface KnowledgeNote {
  /** Repo-relative path (a graph node id for a real note). */
  path: string;
  /** Raw markdown body (frontmatter included); the client renders + sanitizes it. */
  content: string;
}
