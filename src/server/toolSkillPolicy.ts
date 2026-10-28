// Admin-managed on/off policy for SDK BUILT-IN tools and skills (the built-in
// counterpart of the hex-ssh tool policy). Stored as one JSON blob in
// `app_config` (encrypted like every app secret); read fresh on every agent
// run. The DEFAULT (empty) policy must always be safe: a SESSION_SECRET
// rotation makes the stored blob unreadable, which silently falls back to
// "nothing disabled" — the pre-feature behavior.

export const TOOL_SKILL_POLICY_CONFIG_KEY = "builtin_tool_skill_policy";

/**
 * One admin-panel toggle for built-in SDK tools. A toggle may map to SEVERAL
 * tool names (Task/Agent are the same capability under two names across CLI
 * versions), so the POLICY stores raw tool names while the UI renders toggles.
 */
export interface TogglableBuiltinTool {
  /** Stable toggle id (UI state key). */
  id: string;
  /** SDK tool names this toggle disables (fed to `disallowedTools` verbatim). */
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
 * catalog so a panel bug can never brick every avatar.
 * `UNUSED_SDK_BUILTIN_TOOLS` (always disallowed) is separate from and additive
 * to this policy. The retired `agent_teams` (SendMessage) and `workflow`
 * (Workflow) toggles are gone with the features: those tools are now always
 * disallowed, and a stored policy still naming them normalizes them away on
 * read (uniqueKnownTools).
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
 * Skill names as the CLI accepts them: SKILL.md `name`, a directory name, or a
 * plugin-qualified `plugin:skill`. The shape also guards the `Skill(<name>)`
 * disallow specifier this policy is compiled into — parentheses/commas would
 * corrupt the specifier list, so the charset excludes them.
 */
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_DISABLED_SKILLS = 200;

export interface ToolSkillPolicy {
  /** Disabled SDK built-in tool names (each ∈ TOGGLABLE_BUILTIN_TOOLS names). */
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

/**
 * Compile the policy into `disallowedTools` entries: bare tool names remove
 * the tool from the model's context entirely; `Skill(<name>)` specifiers deny
 * that one skill's invocation without removing the Skill tool or other skills
 * (verified against the bundled CLI's permission matcher — a content-carrying
 * deny never strips the tool itself).
 */
export function disallowedEntriesForPolicy(policy: ToolSkillPolicy): string[] {
  return [
    ...policy.disabledTools,
    ...policy.disabledSkills.map((name) => `Skill(${name})`),
  ];
}

// ---- Skill discovery cache (preflight supportedCommands result) ------------

export const SKILL_DISCOVERY_CACHE_KEY = "skill_discovery_cache";

/** One skill/command the CLI reported via `supportedCommands()`. */
export interface DiscoveredSkill {
  name: string;
  description: string;
}

/**
 * Cached global skill/command list from ONE preflight SDK session (CLI
 * built-in plugin skills + the app's default-skills). Keyed by the bundled
 * CLI version so an SDK upgrade invalidates it; per-avatar plugin skills are
 * NOT here — they are enumerated per run from the avatar's plugin roots.
 */
export interface SkillDiscoveryCache {
  cliVersion: string;
  fetchedAt: string;
  skills: DiscoveredSkill[];
}

/** Lenient reader for the stored cache: anything malformed → null (re-discover). */
export function normalizeSkillDiscoveryCache(value: unknown): SkillDiscoveryCache | null {
  if (!isRecord(value) || typeof value.cliVersion !== "string" || !value.cliVersion) {
    return null;
  }
  if (!Array.isArray(value.skills)) {
    return null;
  }
  const skills: DiscoveredSkill[] = [];
  for (const entry of value.skills) {
    if (isRecord(entry) && typeof entry.name === "string" && entry.name) {
      skills.push({
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : "",
      });
    }
  }
  return {
    cliVersion: value.cliVersion,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
    skills,
  };
}
