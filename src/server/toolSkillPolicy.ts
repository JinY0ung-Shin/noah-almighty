// Admin-managed on/off policy for SKILLS. Enforced by omission: a disabled
// skill is never copied into a pi sandbox, listed or served (`pi/piSkills.ts`).
// Stored as one JSON blob in `app_config` (encrypted like every app secret);
// read fresh on every agent run. The DEFAULT (empty) policy must always be
// safe: a SESSION_SECRET rotation makes the stored blob unreadable, which
// silently falls back to "nothing disabled" — the pre-feature behavior.
//
// The built-in TOOL toggles (WebFetch/WebSearch/NotebookEdit/Task-Agent) are
// RETIRED (issue #78): the first three were Claude Agent SDK tools pi does not
// have, and pi's own `Agent` is switched off for real in pi's admin tool page
// (`/admin`). A stored policy's `disabledTools` is dropped on read and ignored
// on write, so an upgraded deployment adds no prompt text for them.

export const TOOL_SKILL_POLICY_CONFIG_KEY = "builtin_tool_skill_policy";

/**
 * Skill names: SKILL.md `name`, a directory name, or a plugin-qualified
 * `plugin:skill`.
 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DISABLED_SKILLS = 200;

export interface ToolSkillPolicy {
  /** Disabled skill names (discovered or admin-typed; SKILL_NAME_RE shape). */
  disabledSkills: string[];
}

/** Nothing disabled — byte-identical to the pre-feature behavior. */
export const DEFAULT_TOOL_SKILL_POLICY: ToolSkillPolicy = {
  disabledSkills: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueValidSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value.filter(
        (name): name is string =>
          typeof name === "string" && SKILL_NAME_RE.test(name),
      ),
    ),
  ).slice(0, MAX_DISABLED_SKILLS);
}

/**
 * Leniently normalize a stored policy (READ path). Corrupt/older records fall
 * back to the safe default so a bad DB value can never disable more than the
 * admin actually chose; a retired `disabledTools` field is dropped.
 */
export function normalizeToolSkillPolicy(value: unknown): ToolSkillPolicy {
  if (!isRecord(value)) {
    return { disabledSkills: [...DEFAULT_TOOL_SKILL_POLICY.disabledSkills] };
  }
  return { disabledSkills: uniqueValidSkills(value.disabledSkills) };
}

/**
 * Strict parser for the admin API (WRITE path): `disabledSkills` must be an
 * array of shape-valid names — otherwise null (→ HTTP 400), so typos surface
 * to the admin instead of being silently dropped. A retired `disabledTools`
 * field (an admin tab opened before the upgrade) is ignored, not refused.
 */
export function parseToolSkillPolicy(value: unknown): ToolSkillPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  const { disabledSkills } = value;
  if (!Array.isArray(disabledSkills)) {
    return null;
  }
  if (disabledSkills.length > MAX_DISABLED_SKILLS) {
    return null;
  }
  for (const name of disabledSkills) {
    if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
      return null;
    }
  }
  return { disabledSkills: uniqueValidSkills(disabledSkills) };
}

// ---- Global skill list (admin panel) ---------------------------------------

/**
 * `app_config` key of the RETIRED skill-discovery cache (the Claude Agent SDK
 * preflight's `supportedCommands()` result, keyed by the bundled CLI version).
 * Deleted on existing deployments by the store migration; reserved forever.
 */
export const SKILL_DISCOVERY_CACHE_KEY = "skill_discovery_cache";

/** One skill a plugin root ships (`<root>/skills/<dir>/SKILL.md`). */
export interface DiscoveredSkill {
  name: string;
  description: string;
}

/**
 * The global skill list the admin tool/skill policy renders: the bundled
 * default-skills root, listed from disk on each request (`skillCatalog.ts`).
 * Per-avatar plugin skills are not here — they differ per avatar.
 */
export interface SkillCatalog {
  fetchedAt: string;
  skills: DiscoveredSkill[];
}
