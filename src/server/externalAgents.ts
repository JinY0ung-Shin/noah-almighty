import type {
  AdminExternalAgent,
  AvatarDetail,
  AvatarSummary,
  ExternalAgentConfig,
  ExternalAgentSource,
} from "./types.js";

const EXTERNAL_AVATAR_PREFIX = "external:";
export const MAX_EXTERNAL_AGENTS = 50;
const MAX_VISIBLE_GROUPS = 50;
const MAX_CONNECT_TIMEOUT_SECONDS = 300;
const MAX_IDLE_TIMEOUT_SECONDS = 3_600;
const MAX_TOTAL_TIMEOUT_SECONDS = 86_400;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;
// Gateway model ids a viewer may pick per conversation (e.g. "claude-sonnet-5",
// "us.anthropic.claude-..."). Stricter than the admin-config `model` field: the
// value comes from arbitrary client input and is persisted + echoed to the
// gateway, so keep it to a conservative id charset.
const EXTERNAL_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Whether a client-sent gateway model id is safe to persist and forward. */
export function isSafeExternalModelId(value: string): boolean {
  return EXTERNAL_MODEL_ID_RE.test(value);
}
const EXTERNAL_AGENT_FIELDS = new Set([
  "id",
  "displayName",
  "alias",
  "bio",
  "persona",
  "intro",
  "hashtags",
  "endpoint",
  "baseUrl",
  "agent",
  "enabled",
  "model",
  "system",
  "apiKeyEnv",
  "apiKey",
  "visibleToGroupIds",
  "connectTimeoutSeconds",
  "idleTimeoutSeconds",
  "totalTimeoutSeconds",
]);

const ADMIN_EXTERNAL_AGENT_FIELDS = new Set([
  "id",
  "displayName",
  "alias",
  "bio",
  "persona",
  "intro",
  "hashtags",
  "endpoint",
  "agent",
  "enabled",
  "model",
  "system",
  "visibleToGroupIds",
  "connectTimeoutSeconds",
  "idleTimeoutSeconds",
  "totalTimeoutSeconds",
  "apiKeyMode",
  "apiKey",
]);

/** Encrypted app_config key used for UI-managed external avatars. */
export const MANAGED_EXTERNAL_AGENTS_KEY = "external_agents_registry_v1";

type EnvLookup = (name: string) => string | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(
  value: unknown,
  field: string,
  index: number,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field}은(는) 문자열이어야 합니다.`);
  }
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].${field}은(는) ${max}자를 초과할 수 없습니다.`,
    );
  }
  return text;
}

function requiredText(
  value: unknown,
  field: string,
  index: number,
  max: number,
): string {
  const text = optionalText(value, field, index, max);
  if (!text) {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field}은(는) 필수입니다.`);
  }
  return text;
}

function optionalBoolean(
  value: unknown,
  field: string,
  index: number,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].${field}은(는) true 또는 false여야 합니다.`);
  }
  return value;
}

function optionalDurationMs(
  value: unknown,
  field: string,
  index: number,
  maxSeconds: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > maxSeconds
  ) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].${field}은(는) ${maxSeconds}초 이하의 양수여야 합니다.`,
    );
  }
  return Math.max(1, Math.round(value * 1_000));
}

function endpointFor(raw: Record<string, unknown>, index: number): string {
  const exact = optionalText(raw.endpoint, "endpoint", index, 2_048);
  const base = optionalText(raw.baseUrl, "baseUrl", index, 2_048);
  if (exact && base) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint와 baseUrl 중 하나만 지정해야 합니다. 둘 다 지정할 수 없습니다.`,
    );
  }
  if (!exact && !base) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}] endpoint 또는 baseUrl이 필요합니다.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(exact ?? base!);
  } catch {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].endpoint URL 형식이 올바르지 않습니다.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].endpoint는 http 또는 https여야 합니다.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].endpoint에는 인증 정보를 포함할 수 없습니다.`,
    );
  }
  if (parsed.hash) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].endpoint에는 URL 프래그먼트(#)를 포함할 수 없습니다.`,
    );
  }
  if (parsed.search) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].endpoint에는 쿼리 문자열(?)을 포함할 수 없습니다.`,
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (base) {
    parsed.pathname = normalizedPath.endsWith("/v1/agents/messages")
      ? normalizedPath
      : `${normalizedPath}/v1/agents/messages`;
  } else {
    if (!normalizedPath.endsWith("/v1/agents/messages")) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].endpoint는 /v1/agents/messages로 끝나야 합니다.`,
      );
    }
    parsed.pathname = normalizedPath;
  }
  return parsed.toString();
}

function hashtagsFor(value: unknown, index: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`EXTERNAL_AGENTS_JSON[${index}].hashtags는 배열이어야 합니다.`);
  }
  return [
    ...new Set(
      value.map((tag, tagIndex) => {
        if (typeof tag !== "string") {
          throw new Error(
            `EXTERNAL_AGENTS_JSON[${index}].hashtags[${tagIndex}]은(는) 문자열이어야 합니다.`,
          );
        }
        return tag.trim().replace(/^#+/, "").slice(0, 40);
      }).filter(Boolean),
    ),
  ].slice(0, 20);
}

function visibleToGroupIdsFor(value: unknown, index: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds는 배열이어야 합니다.`,
    );
  }
  if (value.length === 0) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds는 비워 둘 수 없습니다. 외부 아바타는 여기에 지정한 그룹의 그룹원에게만 보입니다.`,
    );
  }
  if (value.length > MAX_VISIBLE_GROUPS) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds는 최대 ${MAX_VISIBLE_GROUPS}개 그룹까지 지정할 수 있습니다.`,
    );
  }
  const groupIds = value.map((groupId, groupIndex) => {
    if (typeof groupId !== "string") {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds[${groupIndex}]은(는) 문자열이어야 합니다.`,
      );
    }
    const normalized = groupId.trim();
    if (!normalized || normalized.length > 128) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].visibleToGroupIds[${groupIndex}]에는 128자 이하의 그룹 ID를 입력해야 합니다.`,
      );
    }
    return normalized;
  });
  return [...new Set(groupIds)];
}

/**
 * Parse the server-only static registry. `apiKeyEnv` is preferred so the JSON
 * contains only a secret variable name; inline `apiKey` remains supported for
 * small deployments. Errors identify the field but never echo secret values.
 */
export function parseExternalAgents(
  value: string | undefined,
  lookupEnv: EnvLookup = (name) => process.env[name],
): ExternalAgentConfig[] {
  if (!value?.trim()) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("EXTERNAL_AGENTS_JSON은 올바른 JSON이어야 합니다.");
  }
  if (!Array.isArray(decoded)) {
    throw new Error("EXTERNAL_AGENTS_JSON은 JSON 배열이어야 합니다.");
  }
  if (decoded.length > MAX_EXTERNAL_AGENTS) {
    throw new Error(
      `EXTERNAL_AGENTS_JSON에는 최대 ${MAX_EXTERNAL_AGENTS}개의 외부 아바타만 등록할 수 있습니다.`,
    );
  }

  const seen = new Set<string>();
  return decoded.map((entry, index) => {
    const raw = record(entry);
    if (!raw) {
      throw new Error(`EXTERNAL_AGENTS_JSON[${index}] 항목은 객체여야 합니다.`);
    }
    const unknownField = Object.keys(raw).find(
      (field) => !EXTERNAL_AGENT_FIELDS.has(field),
    );
    if (unknownField) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}] 지원하지 않는 설정 필드입니다: ${unknownField}`,
      );
    }
    const id = requiredText(raw.id, "id", index, 64);
    if (!ID_RE.test(id)) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].id는 영문/숫자/_/- 만 사용할 수 있습니다.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`EXTERNAL_AGENTS_JSON에 중복된 id가 있습니다: ${id}`);
    }
    seen.add(id);

    const apiKeyEnv = optionalText(raw.apiKeyEnv, "apiKeyEnv", index, 128);
    if (apiKeyEnv && !ENV_NAME_RE.test(apiKeyEnv)) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].apiKeyEnv는 올바른 환경 변수 이름이 아닙니다.`,
      );
    }
    const inlineApiKey = optionalText(raw.apiKey, "apiKey", index, 8_192);
    const apiKey = apiKeyEnv ? lookupEnv(apiKeyEnv)?.trim() : inlineApiKey;
    if (apiKeyEnv && !apiKey) {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].apiKeyEnv가 가리키는 환경 변수가 설정되지 않았습니다.`,
      );
    }

    const displayName = requiredText(raw.displayName, "displayName", index, 120);
    const connectTimeoutMs = optionalDurationMs(
      raw.connectTimeoutSeconds,
      "connectTimeoutSeconds",
      index,
      MAX_CONNECT_TIMEOUT_SECONDS,
    );
    const idleTimeoutMs = optionalDurationMs(
      raw.idleTimeoutSeconds,
      "idleTimeoutSeconds",
      index,
      MAX_IDLE_TIMEOUT_SECONDS,
    );
    const totalTimeoutMs = optionalDurationMs(
      raw.totalTimeoutSeconds,
      "totalTimeoutSeconds",
      index,
      MAX_TOTAL_TIMEOUT_SECONDS,
    );
    const agent = optionalText(raw.agent, "agent", index, 64) ?? "claude";
    if (agent !== "claude") {
      throw new Error(
        `EXTERNAL_AGENTS_JSON[${index}].agent는 claude만 지원합니다.`,
      );
    }
    return {
      id,
      displayName,
      alias: optionalText(raw.alias, "alias", index, 120) ?? "",
      bio: optionalText(raw.bio, "bio", index, 500) ?? "",
      persona: optionalText(raw.persona, "persona", index, 4_000) ?? "",
      intro: optionalText(raw.intro, "intro", index, 2_000) ?? "",
      hashtags: hashtagsFor(raw.hashtags, index),
      endpoint: endpointFor(raw, index),
      agent,
      enabled: optionalBoolean(raw.enabled, "enabled", index) ?? true,
      model: optionalText(raw.model, "model", index, 256),
      system: optionalText(raw.system, "system", index, 100_000),
      visibleToGroupIds: visibleToGroupIdsFor(raw.visibleToGroupIds, index),
      ...(apiKey ? { apiKey } : {}),
      ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(totalTimeoutMs !== undefined ? { totalTimeoutMs } : {}),
    };
  });
}

/**
 * Validate one UI-managed definition with explicit write-only credential
 * semantics. The stateless v1 contract deliberately supports only the Claude
 * agent in both managed and environment-backed entries.
 */
export function parseAdminExternalAgentInput(
  value: unknown,
  existing?: ExternalAgentConfig,
): ExternalAgentConfig {
  const raw = record(value);
  if (!raw) {
    throw new Error("외부 아바타 설정은 객체여야 합니다.");
  }
  const unknownField = Object.keys(raw).find(
    (field) => !ADMIN_EXTERNAL_AGENT_FIELDS.has(field),
  );
  if (unknownField) {
    throw new Error(`지원하지 않는 설정 필드입니다: ${unknownField}`);
  }
  if (raw.agent !== undefined && raw.agent !== "claude") {
    throw new Error("외부 아바타는 현재 Claude만 지원합니다. (agent: claude)");
  }
  const apiKeyMode = raw.apiKeyMode;
  if (
    apiKeyMode !== "keep" &&
    apiKeyMode !== "set" &&
    apiKeyMode !== "clear"
  ) {
    throw new Error("API 키 처리 방식이 올바르지 않습니다.");
  }
  if (apiKeyMode !== "set" && raw.apiKey !== undefined) {
    throw new Error("API 키 값은 교체 모드에서만 보낼 수 있습니다.");
  }
  const nextApiKey =
    apiKeyMode === "set"
      ? typeof raw.apiKey === "string"
        ? raw.apiKey.trim().replace(/^Bearer\s+/i, "")
        : ""
      : apiKeyMode === "keep"
        ? existing?.apiKey
        : undefined;
  if (apiKeyMode === "set" && !nextApiKey) {
    throw new Error("교체할 Gateway API 키를 입력해 주세요.");
  }

  const candidate: Record<string, unknown> = {};
  for (const field of ADMIN_EXTERNAL_AGENT_FIELDS) {
    if (field === "apiKeyMode" || field === "apiKey") continue;
    if (raw[field] !== undefined) candidate[field] = raw[field];
  }
  candidate.agent = "claude";
  if (nextApiKey) candidate.apiKey = nextApiKey;
  const [parsed] = parseExternalAgents(JSON.stringify([candidate]));
  if (
    apiKeyMode === "keep" &&
    existing?.apiKey &&
    parsed.endpoint !== existing.endpoint
  ) {
    throw new Error(
      "Gateway 주소를 변경할 때는 새 API 키를 등록하거나 저장된 키를 삭제해야 합니다.",
    );
  }
  return parsed;
}

function storageEntry(agent: ExternalAgentConfig): Record<string, unknown> {
  return {
    id: agent.id,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    persona: agent.persona,
    intro: agent.intro,
    hashtags: agent.hashtags,
    endpoint: agent.endpoint,
    agent: agent.agent,
    enabled: agent.enabled !== false,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.system ? { system: agent.system } : {}),
    ...(agent.apiKey ? { apiKey: agent.apiKey } : {}),
    ...(agent.visibleToGroupIds
      ? { visibleToGroupIds: agent.visibleToGroupIds }
      : {}),
    ...(agent.connectTimeoutMs
      ? { connectTimeoutSeconds: agent.connectTimeoutMs / 1_000 }
      : {}),
    ...(agent.idleTimeoutMs
      ? { idleTimeoutSeconds: agent.idleTimeoutMs / 1_000 }
      : {}),
    ...(agent.totalTimeoutMs
      ? { totalTimeoutSeconds: agent.totalTimeoutMs / 1_000 }
      : {}),
  };
}

/** Serialize the encrypted registry with an explicit format version. */
export function serializeManagedExternalAgents(
  agents: readonly ExternalAgentConfig[],
): string {
  return JSON.stringify({
    version: 1,
    agents: agents.map(storageEntry),
  });
}

/** Decode a registry written by serializeManagedExternalAgents. */
export function parseManagedExternalAgents(value: string): ExternalAgentConfig[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("저장된 외부 아바타 설정이 올바른 JSON이 아닙니다.");
  }
  const root = record(decoded);
  if (root?.version !== 1 || !Array.isArray(root.agents)) {
    throw new Error("지원하지 않는 외부 아바타 설정 버전입니다.");
  }
  return parseExternalAgents(JSON.stringify(root.agents));
}

/**
 * Environment entries retain precedence for matching ids while managed entries
 * can be added alongside them. This keeps deployments using
 * EXTERNAL_AGENTS_JSON unchanged and makes those rows read-only in the UI.
 */
export function mergeExternalAgentRegistries(
  environment: readonly ExternalAgentConfig[] | undefined,
  managed: readonly ExternalAgentConfig[] | undefined,
): ExternalAgentConfig[] {
  const environmentIds = new Set((environment ?? []).map((agent) => agent.id));
  return [
    ...(environment ?? []),
    ...(managed ?? []).filter((agent) => !environmentIds.has(agent.id)),
  ];
}

export function adminExternalAgent(
  agent: ExternalAgentConfig,
  source: ExternalAgentSource,
  conversationCount: number,
): AdminExternalAgent {
  return {
    id: agent.id,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    persona: agent.persona,
    intro: agent.intro,
    hashtags: [...agent.hashtags],
    endpoint: agent.endpoint,
    agent: agent.agent,
    enabled: agent.enabled !== false,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.system ? { system: agent.system } : {}),
    ...(agent.visibleToGroupIds
      ? { visibleToGroupIds: [...agent.visibleToGroupIds] }
      : {}),
    ...(agent.connectTimeoutMs
      ? { connectTimeoutSeconds: agent.connectTimeoutMs / 1_000 }
      : {}),
    ...(agent.idleTimeoutMs
      ? { idleTimeoutSeconds: agent.idleTimeoutMs / 1_000 }
      : {}),
    ...(agent.totalTimeoutMs
      ? { totalTimeoutSeconds: agent.totalTimeoutMs / 1_000 }
      : {}),
    source,
    apiKeySet: Boolean(agent.apiKey),
    conversationCount,
    // Images live outside the registry; route code overlays the stored state.
    hasImage: false,
  };
}

export function externalAvatarId(agent: Pick<ExternalAgentConfig, "id">): string {
  return `${EXTERNAL_AVATAR_PREFIX}${agent.id}`;
}

export function findExternalAgent(
  agents: readonly ExternalAgentConfig[] | undefined,
  avatarId: string,
): ExternalAgentConfig | null {
  if (!avatarId.startsWith(EXTERNAL_AVATAR_PREFIX)) return null;
  const id = avatarId.slice(EXTERNAL_AVATAR_PREFIX.length);
  return agents?.find((agent) => agent.id === id) ?? null;
}

export function externalAgentVisibleTo(
  agent: ExternalAgentConfig,
  viewerGroupIds: ReadonlySet<string>,
): boolean {
  if (agent.enabled === false) return false;
  // Group binding is REQUIRED: an entry without a group ACL is visible to no
  // one (fail closed) — there is no "public to all users" state. Legacy env/
  // registry entries stay parseable but dark until an operator adds groups.
  const restrictedTo = agent.visibleToGroupIds;
  return Boolean(
    restrictedTo?.some((groupId) => viewerGroupIds.has(groupId)),
  );
}

export function findVisibleExternalAgent(
  agents: readonly ExternalAgentConfig[] | undefined,
  avatarId: string,
  viewerGroupIds: ReadonlySet<string>,
): ExternalAgentConfig | null {
  const agent = findExternalAgent(agents, avatarId);
  return agent && externalAgentVisibleTo(agent, viewerGroupIds) ? agent : null;
}

export function externalAvatarSummary(agent: ExternalAgentConfig): AvatarSummary {
  return {
    id: externalAvatarId(agent),
    username: `external-${agent.id}`,
    displayName: agent.displayName,
    alias: agent.alias,
    bio: agent.bio,
    hashtags: [...agent.hashtags],
    hasImage: false,
    pluginCount: 0,
    visibility: "group",
    updatedAt: null,
    runtime: "external",
    sharesGroup: false,
  };
}

export function externalAvatarDetail(agent: ExternalAgentConfig): AvatarDetail {
  return {
    ...externalAvatarSummary(agent),
    persona: agent.persona,
    intro: agent.intro,
    isOwn: false,
    elevated: false,
    plugins: [],
  };
}

export function listExternalAvatarSummaries(
  agents: readonly ExternalAgentConfig[] | undefined,
  viewerGroupIds: ReadonlySet<string>,
): AvatarSummary[] {
  return (agents ?? [])
    .filter((agent) => externalAgentVisibleTo(agent, viewerGroupIds))
    .map(externalAvatarSummary)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
