// Admin-managed on/off policy for BUILT-IN tools and skills (the built-in
// counterpart of the hex-ssh tool policy). Skills are enforced by omission: a
// disabled skill is never copied into a pi sandbox, listed or served
// (`pi/piSkills.ts`). pi has no per-request built-in tool gate, so a disabled
// built-in is ADVISORY — both metacognition surfaces ask the model not to use
// it (`piAdminDisabledToolsNote`). Stored as one JSON blob in
// `app_config` (encrypted like every app secret); read fresh on every agent
// run. The DEFAULT (empty) policy must always be safe: a SESSION_SECRET
// rotation makes the stored blob unreadable, which silently falls back to
// "nothing disabled" — the pre-feature behavior.

export const TOOL_SKILL_POLICY_CONFIG_KEY = "builtin_tool_skill_policy";

/**
 * One admin-panel toggle for built-in tools. A toggle may map to SEVERAL tool
 * names (Task/Agent are the same capability under two names), so the POLICY
 * stores raw tool names while the UI renders toggles.
 */
export interface TogglableBuiltinTool {
  /** Stable toggle id (UI state key). */
  id: string;
  /** Tool names this toggle disables. */
  names: string[];
  /** Admin UI label (Korean — user-facing). */
  labelKo: string;
  /** Admin UI help text (Korean — user-facing). */
  descriptionKo: string;
}

/**
 * Built-in tools an admin MAY disable. Deliberately EXCLUDES the core tools an
 * avatar cannot function without (Read/Glob/Grep/Bash/Edit/Write/Skill/
 * AskUserQuestion/TodoWrite) — the strict parser rejects anything outside this
 * catalog so a panel bug can never brick every avatar. The retired
 * `agent_teams` (SendMessage) and `workflow` (Workflow) toggles are gone with
 * the features: a stored policy still naming them normalizes them away on read
 * (uniqueKnownTools).
 */
export const TOGGLABLE_BUILTIN_TOOLS: TogglableBuiltinTool[] = [
  {
    id: "web_fetch",
    names: ["WebFetch"],
    labelKo: "웹 페이지 읽기 (WebFetch)",
    descriptionKo: "URL 내용을 가져오는 내장 도구. 사내망에서 동작하지 않으면 끄기 권장.",
  },
  {
    id: "web_search",
    names: ["WebSearch"],
    labelKo: "웹 검색 (WebSearch)",
    descriptionKo: "웹 검색 내장 도구. 사내망에서 동작하지 않으면 끄기 권장.",
  },
  {
    id: "notebook_edit",
    names: ["NotebookEdit"],
    labelKo: "노트북 편집 (NotebookEdit)",
    descriptionKo: "Jupyter 노트북(.ipynb) 편집 도구.",
  },
  {
    id: "subagents",
    names: ["Task", "Agent"],
    labelKo: "하위 에이전트 (Task/Agent)",
    descriptionKo: "아바타가 병렬 하위 에이전트를 띄우는 기능. 토큰 사용량 제어용.",
  },
];

const TOGGLABLE_TOOL_NAME_SET = new Set<string>(
  TOGGLABLE_BUILTIN_TOOLS.flatMap((tool) => tool.names),
);

/**
 * Skill names: SKILL.md `name`, a directory name, or a plugin-qualified
 * `plugin:skill`.
 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DISABLED_SKILLS = 200;

export interface ToolSkillPolicy {
  /** Disabled built-in tool names (each ∈ TOGGLABLE_BUILTIN_TOOLS names). */
  disabledTools: string[];
  /** Disabled skill names (discovered or admin-typed; SKILL_NAME_RE shape). */
  disabledSkills: string[];
}

/** Nothing disabled — byte-identical to the pre-feature behavior. */
export const DEFAULT_TOOL_SKILL_POLICY: ToolSkillPolicy = {
  disabledTools: [],
  disabledSkills: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueKnownTools(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value.filter(
        (name): name is string =>
          typeof name === "string" && TOGGLABLE_TOOL_NAME_SET.has(name),
      ),
    ),
  );
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
 * back per-field to the safe default so a bad DB value can never disable more
 * than the admin actually chose.
 */
export function normalizeToolSkillPolicy(value: unknown): ToolSkillPolicy {
  if (!isRecord(value)) {
    return {
      disabledTools: [...DEFAULT_TOOL_SKILL_POLICY.disabledTools],
      disabledSkills: [...DEFAULT_TOOL_SKILL_POLICY.disabledSkills],
    };
  }
  return {
    disabledTools: uniqueKnownTools(value.disabledTools),
    disabledSkills: uniqueValidSkills(value.disabledSkills),
  };
}

/**
 * Strict parser for the admin API (WRITE path): both fields must be arrays,
 * every tool name must be in the togglable catalog, and every skill name must
 * be shape-valid — otherwise null (→ HTTP 400), so typos surface to the admin
 * instead of being silently dropped.
 */
export function parseToolSkillPolicy(value: unknown): ToolSkillPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  const { disabledTools, disabledSkills } = value;
  if (!Array.isArray(disabledTools) || !Array.isArray(disabledSkills)) {
    return null;
  }
  for (const name of disabledTools) {
    if (typeof name !== "string" || !TOGGLABLE_TOOL_NAME_SET.has(name)) {
      return null;
    }
  }
  if (disabledSkills.length > MAX_DISABLED_SKILLS) {
    return null;
  }
  for (const name of disabledSkills) {
    if (typeof name !== "string" || !SKILL_NAME_RE.test(name)) {
      return null;
    }
  }
  return {
    disabledTools: uniqueKnownTools(disabledTools),
    disabledSkills: uniqueValidSkills(disabledSkills),
  };
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
