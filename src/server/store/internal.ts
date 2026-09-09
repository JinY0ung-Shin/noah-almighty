import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { INTERNAL_GIT_TOKEN_SECRET_NAME } from "../gitCredentials.js";
import logger from "../logger.js";
// A LEAF module by design (see its header): the memory-dir name is computed both
// here (migrate/backfill) and in the personal-agents mixin's INSERT.
import { personalAgentMemoryDirName } from "../personalAgentSlug.js";
import type { BrowserSecretPolicy } from "../secretPolicy.js";
import type {
  AppConfig,
  AvatarVisibility,
  CanvasArtifact,
  GroupRole,
  User,
  UserGroupMembership,
} from "../types.js";
import type { McpToolGroupId } from "../../shared/mcpToolGroups.js";

const SESSION_DAYS = 14;

/**
 * How recently `users.last_seen_at` must have been stamped for a user to count
 * as present. Every authenticated request refreshes that column, and an open tab
 * polls once a minute while VISIBLE (`startKnowledgeWatch` on the client), so the
 * floor is 2+ minutes: the window must clear one missed tick.
 *
 * At an hour this deliberately reads as "around recently", NOT "at the screen
 * now": someone who closed the tab 59 minutes ago still counts, and the client's
 * visibility gate stops being load-bearing (one visible moment in the hour is
 * enough). That is the intended trade — a 3-minute window made the badge flicker
 * to zero whenever people switched tabs. It still differs from
 * `AdminStats.activeSessions`, which counts 14-DAY login cookies and so never
 * decays within a workday. Callers must surface the window (see
 * `AdminPresence.windowMinutes`) rather than implying live presence.
 */
const PRESENCE_WINDOW_MS = 60 * 60 * 1000;

/** Loosely-typed shape of a legacy persisted canvas, for the one-time backfill. */
type CanvasArtifactBackfill = Partial<CanvasArtifact> & { id?: unknown };

/** PRAGMA user_version reached once the one-time canvas backfill (#50) has run.
 *  SQLite's user_version is 0 on every pre-existing/fresh DB, so gating the
 *  backfill behind it makes its O(messages) LIKE-scan run ONCE per DB, not on
 *  every boot. One-time backfills form a version LADDER: each new wave takes the
 *  next integer, checks `user_version < N`, and stamps N when done. */
const CANVAS_BACKFILL_VERSION = 1;

/** user_version for the second one-time backfill wave (onboarded_at + routine
 *  title tagging). Unlike the value-guarded migrations (git token move,
 *  visibility normalize), these predicates MATCH ROWS THE APP CREATES LATER —
 *  a fresh signup's NULL onboarded_at, a user-typed "[예약 작업] …" title — so
 *  re-running them on a later boot silently corrupts live data. The gate is
 *  what makes them one-time. Next backfill: bump to 3 and gate on it. */
const ONBOARDED_ROUTINE_BACKFILL_VERSION = 2;

function now(): string {
  return new Date().toISOString();
}

/**
 * Parse a stored JSON array of plugin-name strings (used for both a plugin's
 * `selected` subset and a user's `knowledge_selected`). Returns null — meaning
 * "load all" — for null/blank/malformed values.
 */
function parseNameList(raw: string | null): string[] | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** Max capability hashtags stored per avatar, and max length of each tag. */
export const MAX_HASHTAGS = 12;
const MAX_HASHTAG_LEN = 30;
/** Default number of avatars a capability search returns when no limit is given. */
const DEFAULT_SEARCH_LIMIT = 12;

/**
 * Normalize capability hashtags ("역량 해시태그") to a clean, deduped, capped list
 * of BARE tags (no leading "#" — the UI renders that). Shared by the PATCH save
 * path and the auto-generate endpoint so a hand-edited chip list and a parsed
 * agent response produce identical storage. Accepts either an array (chip
 * editor) or a raw string (agent text, split on whitespace/commas).
 */
export function normalizeHashtags(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.filter((s): s is string => typeof s === "string")
    : typeof input === "string"
      ? input.split(/[\s,，、]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // Strip leading list/bullet markers and "#", collapse inner whitespace to a
    // hyphen (a hashtag carries no spaces), and trim trailing punctuation. Only
    // the LEADING "#" is removed, so "C#"/"C++" survive intact.
    let tag = item
      .trim()
      .replace(/^[#*\-•·\s]+/u, "")
      .replace(/\s+/g, "-")
      .replace(/[.,!?。·…、，]+$/u, "")
      .trim();
    if (!tag) continue;
    if (tag.length > MAX_HASHTAG_LEN) tag = tag.slice(0, MAX_HASHTAG_LEN);
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_HASHTAGS) break;
  }
  return out;
}

/** Parse the stored hashtags JSON array, defaulting to an empty list. */
function parseHashtags(raw: string | null): string[] {
  return parseNameList(raw) ?? [];
}

export {
  now,
  parseNameList,
  parseHashtags,
  DEFAULT_SEARCH_LIMIT,
  SESSION_DAYS,
  PRESENCE_WINDOW_MS,
};

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  alias: string;
  bio: string;
  persona: string;
  intro: string;
  avatar_ext: string | null;
  visibility: string | null;
  auto_approve: number;
  suspended: number;
  shared_account: number;
  created_at: string;
  last_seen_at: string | null;
  git_token_enc: string | null;
  git_identity_name: string | null;
  git_identity_email: string | null;
  knowledge_repo: string | null;
  knowledge_branch: string | null;
  knowledge_selected: string | null;
  ssh_public_key: string | null;
  hashtags: string | null;
  group_knowledge_off_default: string | null;
  model_default: string | null;
  effort_default: string | null;
  mcp_tool_groups_default: string | null;
  experimental_features: string | null;
  onboarded_at: string | null;
  last_seen_release: string | null;
}

export interface PluginRow {
  id: string;
  repo: string;
  ref: string | null;
  label: string | null;
  enabled: number;
  selected: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface KnowledgeRequestRow {
  id: string;
  avatar_user_id: string;
  asker_user_id: string | null;
  asker_name: string | null;
  question: string;
  status: string;
  created_at: string;
}

export interface AvatarNotificationRow {
  id: string;
  owner_user_id: string;
  avatar_user_id: string;
  title: string;
  message: string;
  conversation_id: string | null;
  read_at: string | null;
  created_at: string;
  avatar_display_name?: string | null;
}

export interface GitRepositoryRow {
  user_id: string;
  name: string;
  repo: string;
  branch: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  knowledge_repo: string | null;
  knowledge_branch: string | null;
  knowledge_selected: string | null;
  /** Admin tool policy: JSON array of MCP tool-group ids; NULL = no restriction. */
  allowed_mcp_tool_groups: string | null;
  /** Group policy: member avatars visible/trusted to each other. NULL/1 = on, 0 = off. */
  avatar_sharing: number | null;
  created_by: string | null;
  created_at: string;
}

export interface GroupMemberRow {
  id: string;
  username: string;
  display_name: string;
  avatar_ext: string | null;
  visibility: string | null;
  role: string;
  created_at: string | null;
}

export interface GroupAgentRow {
  id: string;
  group_id: string;
  display_name: string;
  alias: string | null;
  bio: string | null;
  intro: string | null;
  persona: string | null;
  hashtags: string | null;
  avatar_ext: string | null;
  enabled: number;
  capture_scope: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface PersonalAgentRow {
  id: string;
  owner_user_id: string;
  display_name: string;
  alias: string | null;
  bio: string | null;
  intro: string | null;
  persona: string | null;
  hashtags: string | null;
  avatar_ext: string | null;
  enabled: number;
  default_model: string | null;
  memory_dir: string | null;
  selected_skills: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BotTaskRow {
  id: string;
  owner_user_id: string;
  agent_id: string;
  conversation_id: string;
  run_id: string | null;
  title: string;
  request_text: string;
  status: string;
  reported_outcome: string | null;
  result_summary: string | null;
  pending_question: string | null;
  error: string | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seen_at: string | null;
  routine_job_id: string | null;
  delegated_by_agent_id: string | null;
  delegation_depth: number | null;
}

export interface RoutineJobRow {
  id: string;
  avatar_user_id: string;
  conversation_id: string;
  name: string | null;
  prompt: string;
  minute_of_day: number;
  schedule_kind: string | null;
  days_of_week: string | null;
  interval_minutes: number | null;
  run_date: string | null;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  completed_at: string | null;
  created_at: string;
  personal_agent_id: string | null;
}

/**
 * app_config key under which the Claude subscription OAuth token (from
 * `claude setup-token`) is stored. Injected as CLAUDE_CODE_OAUTH_TOKEN into the
 * agent subprocess when no ANTHROPIC_API_KEY is configured (see claudeAgent.ts).
 */
export const CLAUDE_OAUTH_TOKEN_KEY = "claude_oauth_token";

/** app_config key: how self-service signups are gated ("open" | "closed" | "approval"). */
export const SIGNUP_MODE_KEY = "signup_mode";
/** app_config key: admin-selected agent model, overriding nothing when an env
 *  ANTHROPIC_MODEL is set (env wins, mirroring the API-key/subscription rule). */
export const MODEL_OVERRIDE_KEY = "agent_model_override";
/**
 * app_config key: admin-managed speech-to-text endpoint, JSON `{ url, model }`
 * with `model` null meaning "inherit the env default" (`SttOverride`).
 *
 * Precedence is the INVERSE of MODEL_OVERRIDE_KEY above: here the ADMIN value
 * wins and env `STT_URL`/`STT_MODEL` are only the fallback the panel displays.
 * The model override defers to env because a deployment pins its agent model
 * deliberately at boot; an STT endpoint is operational plumbing an operator
 * must be able to re-point at runtime without a redeploy. Env is never seeded
 * into this key — a seed-if-unset write would re-fire every boot and clobber a
 * deliberate clear.
 */
export const STT_OVERRIDE_KEY = "stt_override";

/**
 * Generic constructor type used to compose the per-domain mixins back onto a
 * single Store facade (see store/index.ts). Each domain module is a
 * `(Base) => class extends Base { ... }` factory; they all share `this.db`/
 * `this.secret` and the cross-cutting helpers below via StoreBase.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;

/**
 * Shared base for every Store domain mixin. Owns the single better-sqlite3
 * handle, the at-rest encryption secret, the DB lifecycle (schema/migrations,
 * seedRoles, close), and the cross-cutting row-fetch/count helpers every domain
 * needs. Mixins extend this (via store/index.ts) and access these members as
 * `protected` so cross-mixin calls resolve on the composed prototype.
 */
export class StoreBase {
  protected readonly db: Database.Database;
  /** Key secret for at-rest token encryption (from config.sessionSecret). */
  protected readonly secret: string;

  constructor(config: AppConfig) {
    this.secret = config.sessionSecret;
    fs.mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(config.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.seedRoles();
    logger.info({ dbPath: config.dbPath }, "database opened");
  }

  protected migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL REFERENCES users(id),
        recipient_id TEXT NOT NULL REFERENCES users(id),
        text TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT,
        UNIQUE(sender_id, nonce)
      );
      CREATE INDEX IF NOT EXISTS dm_pair ON direct_messages(sender_id, recipient_id, id);
      CREATE INDEX IF NOT EXISTS dm_unread ON direct_messages(recipient_id, sender_id) WHERE read_at IS NULL;
      CREATE INDEX IF NOT EXISTS dm_rate ON direct_messages(sender_id, created_at);
      CREATE TABLE IF NOT EXISTS avatar_api_keys (
        id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
        prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS avatar_api_keys_owner ON avatar_api_keys(owner_user_id);
      CREATE TABLE IF NOT EXISTS avatar_tasks (
        id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, api_key_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL,
        run_id TEXT, result_json TEXT, error TEXT, idempotency_key TEXT, fingerprint TEXT NOT NULL,
        user_message_persisted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(owner_user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS avatar_tasks_queue ON avatar_tasks(status, created_at);
      CREATE INDEX IF NOT EXISTS avatar_tasks_owner ON avatar_tasks(owner_user_id, created_at);
      CREATE INDEX IF NOT EXISTS avatar_tasks_owner_status ON avatar_tasks(owner_user_id, status);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        alias TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        persona TEXT DEFAULT '',
        avatar_ext TEXT,
        visibility TEXT NOT NULL DEFAULT 'group',
        auto_approve INTEGER DEFAULT 0,
        ssh_public_key TEXT,
        created_at TEXT,
        last_seen_at TEXT
      );
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT,
        role_id INTEGER,
        PRIMARY KEY (user_id, role_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS avatar_plugins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        ref TEXT,
        label TEXT,
        enabled INTEGER DEFAULT 1,
        selected TEXT,
        last_synced_at TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        avatar_user_id TEXT NOT NULL,
        title TEXT,
        working_repo TEXT,
        external_endpoint TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        response_json TEXT,
        attachments_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        actor_name TEXT,
        action TEXT,
        status TEXT,
        detail TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_requests (
        id TEXT PRIMARY KEY,
        avatar_user_id TEXT NOT NULL,
        asker_user_id TEXT,
        asker_name TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS avatar_notifications (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        avatar_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        conversation_id TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_secrets (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        created_at TEXT,
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS git_repositories (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT,
        last_synced_at TEXT,
        created_at TEXT,
        PRIMARY KEY (user_id, name)
      );
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        knowledge_repo TEXT,
        knowledge_branch TEXT,
        knowledge_selected TEXT,
        created_by TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT,
        PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS routine_jobs (
        id TEXT PRIMARY KEY,
        avatar_user_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        minute_of_day INTEGER NOT NULL,
        enabled INTEGER DEFAULT 1,
        next_run_at TEXT,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value_enc TEXT NOT NULL,
        updated_at TEXT
      );
      -- Visual-canvas artifacts (#50) with version history. The CURRENT state of an
      -- artifact lives here; every shown/refined revision is a row in canvas_versions
      -- (refine-in-place appends a version instead of overwriting). owner_user_id is
      -- denormalized (mirrors routine_jobs.avatar_user_id) so deleteUser can cascade
      -- without a join. A brand-new table: CREATE TABLE IF NOT EXISTS IS the
      -- existing-deployment migration (no ALTER needed, unlike columns).
      CREATE TABLE IF NOT EXISTS canvas_artifacts (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        title TEXT,
        content_type TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS canvas_versions (
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT,
        content TEXT,
        content_type TEXT NOT NULL,
        controls_json TEXT,
        submitted_values_json TEXT,
        interaction TEXT,
        editable INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        PRIMARY KEY (artifact_id, version)
      );
      -- Profile images for EXTERNAL avatars (admin-set). External agents have no
      -- users row, so the users.avatar_ext pattern gets its own tiny table keyed
      -- by the public avatar id ("external:<registry id>"). Image bytes live on
      -- disk next to user avatar images; this row only records the extension.
      -- Deliberately NOT inside the encrypted registry: images are not secret,
      -- and env-defined (read-only) agents can carry one too.
      CREATE TABLE IF NOT EXISTS external_avatar_images (
        external_avatar_id TEXT PRIMARY KEY,
        ext TEXT NOT NULL
      );
      -- Shared GROUP AGENTS (several per group allowed, group-admin managed).
      -- NOT users rows: the public avatar id is "group:<group_id>:<id>"
      -- (external:<id> precedent — conversations.avatar_user_id has no FK).
      -- Pre-multi DBs (group_id PK, no id column) are rebuilt by
      -- migrateGroupAgentsMulti(), which also rewrites conversation bindings.
      -- capture_scope: who may write+commit to the shared second brain through
      -- the agent ('members' | 'admins'; normalized on read, default members).
      CREATE TABLE IF NOT EXISTS group_agents (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        alias TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        intro TEXT DEFAULT '',
        persona TEXT DEFAULT '',
        hashtags TEXT,
        avatar_ext TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        capture_scope TEXT NOT NULL DEFAULT 'members',
        created_by TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      -- PERSONAL AGENTS (내 봇): per-owner chat-contact bots, several per owner
      -- (capped by MAX_PERSONAL_AGENTS in store/personalAgents.ts). NOT users
      -- rows: the public avatar id is "personal:<owner_user_id>:<id>" (the
      -- group:<gid>:<aid> precedent — conversations.avatar_user_id has no FK).
      -- default_model is a modelTiers.ts tier id seeding NEW conversations with
      -- the bot; NULL = the owner's own remembered default. A brand-new table:
      -- CREATE TABLE IF NOT EXISTS IS the existing-deployment migration.
      -- memory_dir / selected_skills are also added by addColumnIfMissing below
      -- (they post-date the table), so both halves must stay in sync.
      CREATE TABLE IF NOT EXISTS personal_agents (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        alias TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        intro TEXT DEFAULT '',
        persona TEXT DEFAULT '',
        hashtags TEXT,
        avatar_ext TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        default_model TEXT,
        memory_dir TEXT,
        selected_skills TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_personal_agents_owner ON personal_agents(owner_user_id);
      -- DELEGATED BOT TASKS: one row per executed user turn in a 내 봇 thread —
      -- the unit the 봇 메신저 UI renders as a 작업 카드. BOOKKEEPING ONLY: a task
      -- row never widens or narrows the run's capability (that stays the
      -- full-owner-run contract). run_id is the IN-MEMORY run-registry key, so it
      -- is meaningless across a restart — the boot sweep fails any row left
      -- 'running'. No FKs (conversation_id/agent_id follow the avatar_user_id
      -- precedent); the cascades are manual (store/personalAgents.ts,
      -- store/admin.ts, store/conversations.ts). A brand-new table:
      -- CREATE TABLE IF NOT EXISTS IS the existing-deployment migration.
      CREATE TABLE IF NOT EXISTS bot_tasks (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        run_id TEXT,
        title TEXT NOT NULL,
        request_text TEXT NOT NULL,
        status TEXT NOT NULL,
        reported_outcome TEXT,
        result_summary TEXT,
        pending_question TEXT,
        error TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        seen_at TEXT,
        routine_job_id TEXT,
        delegated_by_agent_id TEXT,
        delegation_depth INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_bot_tasks_owner ON bot_tasks(owner_user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bot_tasks_conversation ON bot_tasks(conversation_id, created_at ASC);
      -- Skills shared from an owner's knowledge repo (#skill-share): one row per
      -- (owner, skills/<slug> dir). METADATA SNAPSHOT ONLY — the content stays in
      -- the owner's repo and is copied into the learner's repo at learn time.
      -- Reach mirrors avatar discovery (avatars.ts VISIBILITY_WHERE): suspended or
      -- private owners and non-teammates never see the row. A brand-new table:
      -- CREATE TABLE IF NOT EXISTS IS the existing-deployment migration.
      CREATE TABLE IF NOT EXISTS shared_skills (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT DEFAULT '',
        custom_description TEXT,
        content_hash TEXT,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE (owner_user_id, skill_name)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_skills_owner ON shared_skills(owner_user_id);
      -- One row per successful learn (전수) of a shared skill. Keyed by
      -- (owner, skill_name) — NOT the shared_skills row id — so the count
      -- survives an unshare→re-share cycle. Learner ids are stored for the
      -- deleteUser cascade (privacy promise); the UI only ever shows COUNTS.
      CREATE TABLE IF NOT EXISTS skill_learn_events (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        learner_user_id TEXT NOT NULL,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skill_learn_events_skill ON skill_learn_events(owner_user_id, skill_name);
      CREATE INDEX IF NOT EXISTS idx_skill_learn_events_learner ON skill_learn_events(learner_user_id);
      -- GROUP-CHANNEL BLOCK on a shared skill (group-admin moderation): this
      -- group's discovery channel no longer carries (owner, skill_name). Keyed
      -- by the skill NAME — not the shared_skills row id — for the same
      -- anti-evasion reason as skill_learn_events: an unshare→re-share mints a
      -- new row but must stay blocked. Scoped to ONE group, which is exactly
      -- the blocking admin's authority: the share stays visible through any
      -- OTHER sharing group the viewer and owner share (see
      -- LEARNABLE_SKILLS_FROM in store/avatars.ts). A brand-new table:
      -- CREATE TABLE IF NOT EXISTS IS the existing-deployment migration.
      CREATE TABLE IF NOT EXISTS shared_skill_group_blocks (
        group_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        blocked_by TEXT,
        created_at TEXT,
        PRIMARY KEY (group_id, owner_user_id, skill_name)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_skill_group_blocks_skill ON shared_skill_group_blocks(owner_user_id, skill_name);
      CREATE INDEX IF NOT EXISTS idx_group_agents_group ON group_agents(group_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_avatar_plugins_user ON avatar_plugins(user_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_requests_avatar ON knowledge_requests(avatar_user_id, status);
      CREATE INDEX IF NOT EXISTS idx_avatar_notifications_owner ON avatar_notifications(owner_user_id, read_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_avatar ON routine_jobs(avatar_user_id);
      CREATE INDEX IF NOT EXISTS idx_routine_jobs_due ON routine_jobs(enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS idx_user_secrets_user ON user_secrets(user_id);
      CREATE INDEX IF NOT EXISTS idx_git_repositories_user ON git_repositories(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
      CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
      CREATE INDEX IF NOT EXISTS idx_canvas_artifacts_conversation ON canvas_artifacts(conversation_id);
      CREATE INDEX IF NOT EXISTS idx_canvas_artifacts_owner ON canvas_artifacts(owner_user_id);
    `);
    // Additive column migrations for pre-existing DBs (CREATE TABLE above only
    // applies to fresh installs). Each is a no-op once the column exists.
    this.addColumnIfMissing("avatar_plugins", "selected", "TEXT");
    this.addColumnIfMissing("avatar_plugins", "last_synced_at", "TEXT");
    // User-message image attachments (metadata only; the bytes live on disk
    // under dataDir/chat-images — see chatImages.ts).
    this.addColumnIfMissing("messages", "attachments_json", "TEXT");
    this.addColumnIfMissing("users", "auto_approve", "INTEGER DEFAULT 0");
    // Account suspension: blocks login and kills active sessions. Also the
    // "pending approval" state for signups created while signup mode = approval.
    this.addColumnIfMissing("users", "suspended", "INTEGER DEFAULT 0");
    // Avatar self-name (별칭): how the avatar refers to ITSELF in chat, distinct
    // from display_name (how humans see it in lists). Injected into the system prompt.
    this.addColumnIfMissing("users", "alias", "TEXT DEFAULT ''");
    // Avatar self-introduction: a longer first-person blurb the avatar writes
    // about what it can do, shown in its explore-page intro dialog. Distinct
    // from bio (one-liner in lists) and persona (system-prompt behavior).
    this.addColumnIfMissing("users", "intro", "TEXT DEFAULT ''");
    // Per-user git credentials/identity + personal knowledge-repo location. The
    // token is stored AES-256-GCM-encrypted (see crypto.ts), never plaintext.
    this.addColumnIfMissing("users", "git_token_enc", "TEXT");
    this.addColumnIfMissing("users", "git_identity_name", "TEXT");
    this.addColumnIfMissing("users", "git_identity_email", "TEXT");
    this.addColumnIfMissing("users", "knowledge_repo", "TEXT");
    this.addColumnIfMissing("users", "knowledge_branch", "TEXT");
    // JSON array of plugin names to load from the knowledge repo; null = all.
    this.addColumnIfMissing("users", "knowledge_selected", "TEXT");
    // The owner's DEFAULT group-knowledge OFF-set, seeding every NEW conversation
    // (including a brand-new conversation before any toggle interaction).
    // JSON array of group ids; NULL/[] = every group on by default. Mirrors the
    // per-conversation `conversations.group_knowledge_off`, but at the user level:
    // the composer toggle writes here so the choice persists across conversations.
    this.addColumnIfMissing("users", "group_knowledge_off_default", "TEXT");
    // The owner's remembered chat-composer defaults, seeding every NEW conversation
    // (the picker's last choice persists across conversations). NULL = never chosen,
    // so a new conversation falls back to the hardcoded server/SDK default. Mirrors
    // the per-conversation `conversations.selected_*` columns, but at the user level:
    // the composer pickers write here so the choice carries to the next conversation.
    this.addColumnIfMissing("users", "model_default", "TEXT");
    this.addColumnIfMissing("users", "effort_default", "TEXT");
    // JSON array of MCP tool group ids; NULL = never chosen (seed every group on),
    // "[]" = explicitly all groups off (a remembered choice, not "unset").
    this.addColumnIfMissing("users", "mcp_tool_groups_default", "TEXT");
    // Public half of an app-generated SSH keypair. The private half is stored
    // only as the encrypted SSH_PRIVATE_KEY user secret.
    this.addColumnIfMissing("users", "ssh_public_key", "TEXT");
    // Experimental (beta) feature keys the owner enabled for their avatar, a JSON
    // array of registry keys (experimentalFeatures.ts); NULL/[] = none. Mirrors
    // the hashtags JSON-array pattern; unknown keys are dropped on read/write.
    this.addColumnIfMissing("users", "experimental_features", "TEXT");
    // Shared (communal) account flag: when 1, trusted same-group teammates
    // chatting with this avatar may also WRITE to the owner's personal knowledge
    // repo (write/delete/move/scaffold/commit). Repo creation/connection settings
    // stay owner-only. Widens ONLY the repo-write tool gate (repoTools.ts).
    this.addColumnIfMissing("users", "shared_account", "INTEGER DEFAULT 0");
    // Per-secret shell exposure opt-in: when 1, this secret is ALSO exported
    // into the agent shell env on elevated runs (values are redacted from tool
    // outputs by the PostToolUse hook). OFF by default; reserved git/SSH names
    // never ship regardless (secretPolicy.ts).
    this.addColumnIfMissing("user_secrets", "shell_expose", "INTEGER DEFAULT 0");
    // Per-secret BROWSER-INPUT opt-in (브라우저 입력): when 1, the avatar may name
    // this secret (`secretName`) in `mcp__browser__type` / `fill_form` and the
    // extension types the value into the owner's own browser — the model never
    // sees it. `browser_hosts` is a JSON array of exact lowercase hostnames the
    // secret may be typed on (NULL/[] = nowhere, so the flag alone grants
    // nothing); `browser_password_only` restricts it to an `<input
    // type=password>`. OFF by default; reserved git/SSH names never qualify
    // (secretPolicy.ts), same line as shell exposure.
    this.addColumnIfMissing("user_secrets", "browser_expose", "INTEGER DEFAULT 0");
    this.addColumnIfMissing("user_secrets", "browser_hosts", "TEXT");
    this.addColumnIfMissing("user_secrets", "browser_password_only", "INTEGER DEFAULT 1");
    // When the user dismissed first-run onboarding (ISO timestamp); NULL = not yet.
    // Server-persisted so the welcome modal shows ONCE per account instead of every
    // login (the old localStorage flag re-fired on each new browser / cleared store).
    // Existing accounts are backfilled to created_at below so only NEW signups see it.
    this.addColumnIfMissing("users", "onboarded_at", "TEXT");
    // Latest release-notes entry (releaseNotes.ts id) the user has SEEN, stamped
    // via POST /api/me/release-seen when the "what's new" dialog is dismissed.
    // NULL = never seen — deliberately NOT backfilled for existing accounts
    // (opposite of onboarded_at): existing users are exactly the audience that
    // should get the one-time notice on their first load after a deploy. New
    // signups are seeded with the current release at creation instead (createUser).
    this.addColumnIfMissing("users", "last_seen_release", "TEXT");
    // SDK session id of the conversation's last turn, used to resume context on
    // the next turn (see claudeAgent resume). Null until the first turn completes.
    this.addColumnIfMissing("conversations", "agent_session_id", "TEXT");
    // The registered git-repo NAME this conversation opened as its working dir via
    // `mcp__git_repo__open_repo` (repoWorkspace.ts); NULL = scratch workspace. Made
    // durable (vs in-memory) so routine runs — spaced out and across restarts — keep
    // their working repo, and so an interactive open in a routine's thread carries to
    // every scheduled run on the same conversation id.
    this.addColumnIfMissing("conversations", "working_repo", "TEXT");
    // Exact stateless Gateway endpoint this external conversation first trusted.
    // Binding prevents an env/config change from silently sending the stored full
    // transcript to a different endpoint on the next turn.
    this.addColumnIfMissing("conversations", "external_endpoint", "TEXT");
    // Capability hashtags (역량 해시태그): a JSON array of short searchable tags the
    // avatar generates from its skills/persona, shown in discovery (탐색) and queried
    // by the cross-avatar `mcp__avatars__search_avatars` tool. Null/[] = none.
    this.addColumnIfMissing("users", "hashtags", "TEXT");
    // Two-state avatar visibility (group / private). Added nullable on existing
    // DBs, then normalized by migrateVisibility() below (NULL/''/legacy 'public'
    // → 'group'). The legacy `published` column survives in old DBs (it is no
    // longer created fresh) and is never read or written.
    this.addColumnIfMissing("users", "visibility", "TEXT");
    // Flexible routine scheduling: an optional human label plus the schedule
    // shape. schedule_kind defaults to "daily" (legacy rows have it NULL → read
    // as "daily"); days_of_week is a JSON array string (weekly only); and
    // interval_minutes drives interval schedules; run_date is the YYYY-MM-DD KST
    // date for a one-time schedule; completed_at distinguishes an automatically
    // finished one-time run from a manually paused routine. The legacy
    // minute_of_day stays the once/daily/weekly time-of-day.
    this.addColumnIfMissing("routine_jobs", "name", "TEXT");
    this.addColumnIfMissing("routine_jobs", "schedule_kind", "TEXT");
    this.addColumnIfMissing("routine_jobs", "days_of_week", "TEXT");
    this.addColumnIfMissing("routine_jobs", "interval_minutes", "INTEGER");
    this.addColumnIfMissing("routine_jobs", "run_date", "TEXT");
    this.addColumnIfMissing("routine_jobs", "completed_at", "TEXT");
    // 봇 루틴: NULL = the owner's main avatar (every pre-existing row), a
    // personal_agents.id = the routine belongs to that bot and fires as a
    // delegated bot task in a composite-bound routine thread.
    this.addColumnIfMissing("routine_jobs", "personal_agent_id", "TEXT");
    // Routine conversations must never show in the normal chat history, even after
    // their routine is deleted (which orphans the conversation). Tag the row itself
    // so classification doesn't depend on the routine_jobs link still existing.
    this.addColumnIfMissing(
      "conversations",
      "is_routine",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // Per-conversation, owner-only toggle for which of the owner's group
    // knowledge repos are DISABLED in this conversation. A JSON array of group
    // ids; NULL/[] means every group is enabled (the default). We store the OFF
    // set (not the ON set) so a newly-joined group is enabled by default without
    // touching existing rows. Only meaningful for the owner's own conversations;
    // colleague conversations always load all groups (no toggle).
    this.addColumnIfMissing("conversations", "group_knowledge_off", "TEXT");
    // Per-conversation model TIER chosen by the user in the chat composer: a Claude
    // model alias (`opus`/`sonnet`/`haiku`) or NULL = use the server default
    // resolution. The alias resolves to a concrete model via the operator's
    // ANTHROPIC_DEFAULT_*_MODEL env (see modelTiers.ts). Ignored when ANTHROPIC_MODEL
    // pins a model (the env pin is a hard lock).
    this.addColumnIfMissing("conversations", "selected_model", "TEXT");
    // Per-conversation reasoning EFFORT level chosen in the composer
    // (`low`/`medium`/`high`/`xhigh`/`max`) or NULL = SDK default (`high`). Passed
    // to the SDK as `options.effort`; independent of the model pin (see
    // effortLevels.ts).
    this.addColumnIfMissing("conversations", "selected_effort", "TEXT");
    // Per-conversation MCP tool group selection from the chat composer. NULL means
    // every default group is enabled; a JSON array (including []) is an explicit
    // subset. The route validates IDs against src/shared/mcpToolGroups.ts.
    this.addColumnIfMissing(
      "conversations",
      "selected_mcp_tool_groups",
      "TEXT",
    );
    // Per-group ADMIN tool policy: which MCP tool groups this group's members
    // may use in chats they drive. NULL = no restriction; a JSON array
    // (including []) is an allowlist validated against src/shared/mcpToolGroups.ts.
    // System-admin-only (PUT /api/admin/groups/:id/tool-policy); a user in
    // several policy-bearing groups gets the INTERSECTION of the allowlists.
    this.addColumnIfMissing("groups", "allowed_mcp_tool_groups", "TEXT");
    // Per-group AVATAR-SHARING policy (group-admin managed): whether this
    // group's co-membership makes members' avatars mutually visible AND
    // mutually trusted (the two ride the same TEAMMATES SQL fragment). NULL
    // (pre-policy rows) and 1 = on; only an explicit 0 turns it off — keep the
    // SQL `!= 0` / TS `!== 0` reads in lockstep. Group repo/brain tools and the
    // admin tool policy are NOT affected by this knob.
    this.addColumnIfMissing("groups", "avatar_sharing", "INTEGER");
    // Shared-skill content fingerprint (#skill-share): sha256 of the sharer's
    // skills/<slug>/ dir, refreshed whenever the server touches their clone.
    // NULL = not yet computed. Added here for DBs that created shared_skills
    // before the update-detection feature.
    this.addColumnIfMissing("shared_skills", "content_hash", "TEXT");
    // Owner-written INTRODUCTION for one share (소개 문구): the human-facing
    // card text, distinct from `description` (the SKILL.md frontmatter snapshot
    // the model reads). NULL = never set / cleared → viewers fall back to the
    // snapshot. Owner reconciliation only ever rewrites `description`, so a
    // custom intro survives it; unsharing deletes it with the row.
    this.addColumnIfMissing("shared_skills", "custom_description", "TEXT");
    // RENAME TRAIL (#skill-share): the skill_name values this row carried before
    // its current one — JSON array, oldest first, capped, never containing the
    // current name. A share FOLLOWS a rename of its `skills/<slug>/` dir, but
    // learners' origin markers still record the name they learned under, so the
    // trail is what keeps those copies matched to the row until their next
    // update rewrites the marker. NULL (and anything unparseable) reads as [].
    this.addColumnIfMissing("shared_skills", "previous_names", "TEXT");
    // UNSEEN badge state (내 봇 작업): when the owner last LOOKED at this task's
    // settled result. NULL = unseen, and only a settled row can be unseen — see
    // store/botTasks.ts for the predicate. The CREATE TABLE already carries the
    // column; this covers DBs that created bot_tasks before it existed.
    this.addColumnIfMissing("bot_tasks", "seen_at", "TEXT");
    // 봇 루틴 provenance: NULL = the owner asked directly; a routine_jobs.id =
    // this task was fired by that schedule (the card shows an 예약 chip, and the
    // scheduler skips re-enqueueing while one is still queued).
    this.addColumnIfMissing("bot_tasks", "routine_job_id", "TEXT");
    // 봇 간 위임 provenance + the hop cap's depth counter (see types.ts BotTask).
    this.addColumnIfMissing("bot_tasks", "delegated_by_agent_id", "TEXT");
    this.addColumnIfMissing("bot_tasks", "delegation_depth", "INTEGER DEFAULT 0");
    // IMMUTABLE per-bot memory folder name under `agents/` in the OWNER's
    // knowledge repo (personalAgentMemoryRoot). Set at INSERT and never patched,
    // so renaming a bot never orphans the tree it already wrote to; pre-existing
    // rows are backfilled by migratePersonalAgentMemoryDirs() below.
    this.addColumnIfMissing("personal_agents", "memory_dir", "TEXT");
    // JSON array of knowledge-repo skill slugs this bot may LOAD (live
    // references into `skills/<slug>/`, never copies). NULL/[] = NONE — the
    // OPPOSITE default of users.knowledge_selected, where NULL means "load all":
    // a bot starts with zero skills until its owner grants them.
    this.addColumnIfMissing("personal_agents", "selected_skills", "TEXT");
    this.migrateGitTokenSecrets();
    this.migrateVisibility();
    this.migrateCanvasArtifacts();
    this.migrateOnboardedAndRoutineFlags();
    this.migrateGroupAgentsMulti();
    this.migratePersonalAgentMemoryDirs();
    // Trust is now derived purely from group co-membership; the old per-(avatar,
    // viewer) trust table is dropped (its grants don't survive the migration).
    this.db.exec("DROP TABLE IF EXISTS avatar_trusted_users");
  }

  /** One-time backfill of canvas artifacts that pre-date the dedicated tables:
   *  scan stored assistant messages for `response.canvases[]` and seed each as a
   *  v1 row. Later messages win (a refined canvas's latest copy), since we iterate
   *  messages in chronological (rowid) order and the per-id INSERT keeps the last.
   *  Idempotent: INSERT OR IGNORE on canvas_artifacts.id makes a re-run (and any
   *  artifact already persisted live through the new path) a no-op.
   *  Guarded by PRAGMA user_version so the expensive LIKE-scan + JSON parse runs
   *  ONCE per DB, not on every boot (see CANVAS_BACKFILL_VERSION). */
  private migrateCanvasArtifacts(): void {
    const schemaVersion =
      Number(this.db.pragma("user_version", { simple: true })) || 0;
    if (schemaVersion >= CANVAS_BACKFILL_VERSION) {
      return;
    }
    const rows = this.db
      .prepare(
        "SELECT m.response_json AS rj, c.id AS cid, c.owner_user_id AS owner, m.created_at AS createdAt " +
          "FROM messages m JOIN conversations c ON c.id = m.conversation_id " +
          "WHERE m.role = 'assistant' AND m.response_json LIKE '%\"canvases\"%' ORDER BY m.rowid ASC",
      )
      .all() as {
      rj: string | null;
      cid: string;
      owner: string;
      createdAt: string | null;
    }[];
    // Collect the LATEST artifact per id (later rows overwrite earlier ones).
    const latest = new Map<
      string,
      {
        conversationId: string;
        owner: string;
        createdAt: string;
        canvas: CanvasArtifactBackfill;
      }
    >();
    for (const row of rows) {
      if (!row.rj) continue;
      let parsed: { canvases?: CanvasArtifactBackfill[] } | null = null;
      try {
        parsed = JSON.parse(row.rj);
      } catch {
        continue;
      }
      const canvases = parsed?.canvases;
      if (!Array.isArray(canvases)) continue;
      for (const canvas of canvases) {
        if (!canvas || typeof canvas.id !== "string") continue;
        latest.set(canvas.id, {
          conversationId: row.cid,
          owner: row.owner,
          createdAt: row.createdAt ?? now(),
          canvas,
        });
      }
    }
    if (latest.size > 0) {
      const insArtifact = this.db.prepare(
        "INSERT OR IGNORE INTO canvas_artifacts (id, conversation_id, owner_user_id, title, content_type, current_version, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
      );
      const insVersion = this.db.prepare(
        "INSERT OR IGNORE INTO canvas_versions (artifact_id, version, title, content, content_type, controls_json, submitted_values_json, interaction, editable, created_at) " +
          "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const tx = this.db.transaction(() => {
        for (const [id, e] of latest) {
          const ct =
            typeof e.canvas.contentType === "string"
              ? e.canvas.contentType
              : "markdown";
          const info = insArtifact.run(
            id,
            e.conversationId,
            e.owner,
            e.canvas.title ?? "",
            ct,
            e.createdAt,
            e.createdAt,
          );
          if (info.changes === 0) continue; // already present (re-run or live-persisted)
          insVersion.run(
            id,
            e.canvas.title ?? "",
            e.canvas.content ?? "",
            ct,
            e.canvas.controls ? JSON.stringify(e.canvas.controls) : null,
            e.canvas.submittedValues
              ? JSON.stringify(e.canvas.submittedValues)
              : null,
            e.canvas.interaction ?? null,
            e.canvas.editable ? 1 : 0,
            e.createdAt,
          );
        }
      });
      tx();
    }
    // Mark the backfill done — even with nothing to migrate — so a fresh or
    // already-migrated DB never repeats the scan on later boots.
    this.db.pragma(`user_version = ${CANVAS_BACKFILL_VERSION}`);
  }

  /** Wave-2 one-time backfills, gated on the user_version ladder. NOT safe to
   *  re-run: createUser deliberately leaves onboarded_at NULL until the user
   *  dismisses the welcome modal, and conversation titles come from user text —
   *  an ungated re-run marks brand-new signups onboarded at the next restart
   *  and hides ordinary chats whose title happens to start with a routine
   *  prefix. (Exactly that happened when these ran per-boot.) */
  private migrateOnboardedAndRoutineFlags(): void {
    const schemaVersion =
      Number(this.db.pragma("user_version", { simple: true })) || 0;
    if (schemaVersion >= ONBOARDED_ROUTINE_BACKFILL_VERSION) {
      return;
    }
    this.migrateOnboarded();
    this.migrateRoutineConversations();
    this.db.pragma(`user_version = ${ONBOARDED_ROUTINE_BACKFILL_VERSION}`);
  }

  /** One-time backfill: treat every account existing at gate time as already
   *  onboarded (set onboarded_at = created_at) so the server-backed welcome
   *  modal doesn't re-fire for current users — only NEW signups (onboarded_at
   *  NULL) see it. Runs once per DB via migrateOnboardedAndRoutineFlags. */
  private migrateOnboarded(): void {
    this.db.exec(
      "UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL",
    );
  }

  /**
   * One-time rebuild for the multi-agent group_agents shape: pre-multi DBs had
   * `group_id` as PRIMARY KEY (one agent per group) and bound conversations to
   * `group:<groupId>`. Detected by the missing `id` column (the big CREATE IF
   * NOT EXISTS above never touches an existing table). Each legacy row gets a
   * fresh uuid and every conversation binding is rewritten to the canonical
   * `group:<groupId>:<agentId>` in the SAME transaction. On-disk artifacts
   * keyed by the old avatar id (profile image file, workspace tree) are
   * renamed by the startup sweep in ../groupAgents.ts — the store has no
   * config/dataDir. The renamed legacy table keeps its index, so the index is
   * dropped and re-created against the rebuilt table.
   */
  private migrateGroupAgentsMulti(): void {
    const cols = this.db
      .prepare("PRAGMA table_info(group_agents)")
      .all() as { name: string }[];
    if (!cols.length || cols.some((c) => c.name === "id")) {
      return;
    }
    const tx = this.db.transaction(() => {
      this.db.exec("ALTER TABLE group_agents RENAME TO group_agents_legacy");
      this.db.exec("DROP INDEX IF EXISTS idx_group_agents_group");
      this.db.exec(`
        CREATE TABLE group_agents (
          id TEXT PRIMARY KEY,
          group_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          alias TEXT DEFAULT '',
          bio TEXT DEFAULT '',
          intro TEXT DEFAULT '',
          persona TEXT DEFAULT '',
          hashtags TEXT,
          avatar_ext TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          capture_scope TEXT NOT NULL DEFAULT 'members',
          created_by TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE INDEX idx_group_agents_group ON group_agents(group_id);
      `);
      const legacyRows = this.db
        .prepare("SELECT * FROM group_agents_legacy")
        .all() as Omit<GroupAgentRow, "id">[];
      const insert = this.db.prepare(
        `INSERT INTO group_agents (id, group_id, display_name, alias, bio, intro, persona, hashtags, avatar_ext, enabled, capture_scope, created_by, created_at, updated_at)
         VALUES (@id, @group_id, @display_name, @alias, @bio, @intro, @persona, @hashtags, @avatar_ext, @enabled, @capture_scope, @created_by, @created_at, @updated_at)`,
      );
      const rewrite = this.db.prepare(
        "UPDATE conversations SET avatar_user_id = ? WHERE avatar_user_id = ?",
      );
      for (const row of legacyRows) {
        const id = crypto.randomUUID();
        insert.run({ ...row, id });
        rewrite.run(
          `group:${row.group_id}:${id}`,
          `group:${row.group_id}`,
        );
      }
      this.db.exec("DROP TABLE group_agents_legacy");
    });
    tx();
  }

  /** One-time backfill of is_routine on pre-column conversations. Linked ones
   *  come from the routine_jobs join; already-orphaned ones (scheduled job since
   *  deleted) are matched by the legacy/current title prefixes. The title match
   *  is why this must not re-run: titles are user text, so a later chat typed as
   *  "[예약 작업] …" would silently vanish from the chat list. New routine
   *  conversations are tagged at creation (touchConversation isRoutine). */
  private migrateRoutineConversations(): void {
    this.db
      .prepare(
        "UPDATE conversations SET is_routine = 1 WHERE is_routine = 0 AND " +
          "(id IN (SELECT conversation_id FROM routine_jobs WHERE conversation_id IS NOT NULL) " +
          "OR title LIKE '[루틴] %' OR title LIKE '[예약 작업] %')",
      )
      .run();
  }

  /** Normalize visibility to the 2-state enum. Idempotent: backfills rows that
   *  predate the column AND folds the retired `public` state into `group` (the
   *  closest surviving reach — group teammates). The legacy `published` flag is
   *  no longer consulted; 'private' rows are never touched. */
  private migrateVisibility(): void {
    this.db
      .prepare(
        "UPDATE users SET visibility = 'group' " +
          "WHERE visibility IS NULL OR visibility = '' OR visibility = 'public'",
      )
      .run();
  }

  /**
   * Backfill `personal_agents.memory_dir` for bots created before the column
   * existed. UNGATED by the user_version ladder on purpose: every INSERT now
   * writes the column, so `memory_dir IS NULL` can only ever match rows that
   * predate this migration — the value-guarded case the ladder rule exempts
   * (like the git-token move above). The name is computed in TS, not SQL, so the
   * backfilled value is byte-identical to what an INSERT would have produced.
   */
  private migratePersonalAgentMemoryDirs(): void {
    const rows = this.db
      .prepare(
        "SELECT id, display_name FROM personal_agents WHERE memory_dir IS NULL OR memory_dir = ''",
      )
      .all() as { id: string; display_name: string }[];
    if (rows.length === 0) {
      return;
    }
    const update = this.db.prepare(
      "UPDATE personal_agents SET memory_dir = ? WHERE id = ?",
    );
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        update.run(
          personalAgentMemoryDirName(row.display_name ?? "", row.id),
          row.id,
        );
      }
    });
    tx();
  }

  private migrateGitTokenSecrets(): void {
    const createdAt = now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO user_secrets (user_id, name, value_enc, created_at) " +
          "SELECT id, ?, git_token_enc, ? FROM users WHERE git_token_enc IS NOT NULL",
      )
      .run(INTERNAL_GIT_TOKEN_SECRET_NAME, createdAt);
    this.db
      .prepare(
        "UPDATE users SET git_token_enc = NULL WHERE git_token_enc IS NOT NULL",
      )
      .run();
  }

  /** Add a column to a table if it isn't already present (idempotent). */
  protected addColumnIfMissing(
    table: string,
    column: string,
    type: string,
  ): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  protected seedRoles(): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO roles (name) VALUES (?)",
    );
    insert.run("admin");
    insert.run("member");
  }

  /** Run a `SELECT COUNT(*) AS c ...` query and return the scalar count. */
  protected count(sql: string, ...params: unknown[]): number {
    return (this.db.prepare(sql).get(...params) as { c: number }).c;
  }

  /** Resolve a row's avatar visibility. Anything other than an explicit
   *  'private' reads as 'group' — migrate() folds legacy states ('public',
   *  NULL/empty, the pre-enum `published` flag) into 'group' on startup, so
   *  this is just a defensive normalization, never a data source. */
  protected rowVisibility(row: { visibility?: string | null }): AvatarVisibility {
    return row.visibility === "private" ? "private" : "group";
  }

  protected getRoleId(name: string): number | null {
    const row = this.db
      .prepare("SELECT id FROM roles WHERE name = ?")
      .get(name) as { id: number } | undefined;
    return row?.id ?? null;
  }

  protected userRowById(id: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
  }

  protected userRowByUsername(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as UserRow | undefined;
  }

  protected groupRowById(id: string): GroupRow | undefined {
    return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as
      | GroupRow
      | undefined;
  }

  protected normalizeRole(role: string | null | undefined): GroupRole {
    return role === "admin" ? "admin" : "member";
  }

  /** Close the underlying SQLite handle. Called on graceful shutdown. */
  close(): void {
    this.db.close();
  }
}

/**
 * Cross-domain method contract. These methods are implemented by sibling mixins
 * (users/secrets/groups/conversations/knowledgeRepo) but are CALLED from
 * base-level and other mixins through `this`. Declaration-merging them onto the
 * StoreBase TYPE (no runtime emit, no implementation requirement, no method-
 * override clash) lets those calls type-check on the composed prototype, where
 * every method exists at runtime.
 */
export interface StoreBase {
  toUser(row: UserRow): User;
  rolesFor(userId: string): string[];
  listUserSecretNames(userId: string): string[];
  listShellExposedSecretNames(userId: string): string[];
  listBrowserSecretPolicies(userId: string): BrowserSecretPolicy[];
  setSecretBrowserPolicy(
    userId: string,
    name: string,
    policy: { enabled: boolean; hosts: string[]; passwordOnly: boolean },
  ): boolean;
  listUserGroups(userId: string): UserGroupMembership[];
  allowedMcpToolGroupsForUser(userId: string): McpToolGroupId[] | null;
  touchConversation(
    ownerId: string,
    conversationId: string,
    avatarUserId: string,
    firstUserText: string,
    opts?: { isRoutine?: boolean; externalEndpoint?: string },
  ): void;
  deleteCanvasArtifactsForConversation(conversationId: string): void;
  countOpenKnowledgeRequests(avatarUserId: string): number;
  getAppSecret(key: string): string | null;
  getAppSecretState(
    key: string,
  ):
    | { status: "missing" }
    | { status: "unreadable" }
    | { status: "ok"; value: string };
  setAppSecret(key: string, value: string): void;
  deleteAppSecret(key: string): void;
}
