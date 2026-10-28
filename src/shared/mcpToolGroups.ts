export const MCP_TOOL_GROUPS = [
  {
    id: "personal_knowledge",
    labelKo: "개인 지식",
    labelEn: "personal knowledge",
    descriptionKo: "개인 지식 저장소, 세컨드 브레인, 정보 요청",
  },
  {
    id: "group_knowledge",
    labelKo: "그룹 지식",
    labelEn: "group knowledge",
    descriptionKo: "그룹 저장소와 팀 브레인",
  },
  {
    id: "git_repo",
    labelKo: "Git 저장소",
    labelEn: "git repositories",
    descriptionKo: "등록한 작업 저장소 열기, 동기화, 푸시",
  },
  {
    id: "confluence",
    labelKo: "Confluence",
    labelEn: "Confluence",
    descriptionKo: "페이지 검색, 조회, 첨부/자산 가져오기",
  },
  {
    id: "web",
    labelKo: "웹 읽기",
    labelEn: "web fetch",
    descriptionKo: "사내·인터넷 웹 페이지 텍스트 가져오기",
  },
  {
    id: "ssh",
    labelKo: "SSH",
    labelEn: "SSH",
    descriptionKo: "SSH 키, 호스트 신뢰, 원격 서버 도구",
  },
  {
    id: "avatars",
    labelKo: "아바타 찾기",
    labelEn: "avatar discovery & consultation",
    descriptionKo: "다른 아바타 검색·추천, 같은 그룹 아바타에게 질문, 공유된 스킬 배우기",
  },
  {
    id: "canvas",
    labelKo: "캔버스",
    labelEn: "visual canvas",
    descriptionKo: "차트, 다이어그램, 선택 UI 표시",
  },
  {
    id: "browser",
    labelKo: "브라우저 조작",
    labelEn: "browser control",
    descriptionKo: "내 브라우저에서 페이지 열기·클릭·입력·화면 캡처 (확장 프로그램 필요)",
  },
  {
    id: "system",
    labelKo: "시스템",
    labelEn: "system management",
    descriptionKo: "사용 매뉴얼, 상태 확인, 예약 작업, 플러그인, 알림",
  },
  // ArtCraft apps (src/shared/craftApps.ts — the ids are each app's
  // `toolGroupId`). DEFAULT-OFF: their tool lists are large, so a new
  // conversation, a remembered default and every saved selection leave them
  // off; only an explicit pick turns one on. Usable only by system admins on a
  // deployment with the craft-runner (the server gates every run regardless).
  {
    id: "craft_photocraft",
    labelKo: "PhotoCraft",
    labelEn: "PhotoCraft",
    descriptionKo: "관리자 전용 베타 · 포토샵 스타일 이미지 편집 (craft-runner 필요)",
    defaultOff: true,
  },
  {
    id: "craft_vectorcraft",
    labelKo: "VectorCraft",
    labelEn: "VectorCraft",
    descriptionKo: "관리자 전용 베타 · 일러스트레이터 스타일 벡터 편집 (craft-runner 필요)",
    defaultOff: true,
  },
  {
    id: "craft_designcraft",
    labelKo: "DesignCraft",
    labelEn: "DesignCraft",
    descriptionKo: "관리자 전용 베타 · 인디자인 스타일 페이지 레이아웃 (craft-runner 필요)",
    defaultOff: true,
  },
  {
    id: "craft_figcraft",
    labelKo: "FigCraft",
    labelEn: "FigCraft",
    descriptionKo: "관리자 전용 베타 · 피그마 스타일 UI 디자인 (craft-runner 필요)",
    defaultOff: true,
  },
] as const;

export type McpToolGroupId = (typeof MCP_TOOL_GROUPS)[number]["id"];

/**
 * A group that is OFF unless explicitly picked (the Craft apps): never part of
 * {@link DEFAULT_MCP_TOOL_GROUPS}, never re-added by a default or a legacy
 * `null` selection, and stripped from remembered per-user defaults.
 */
export function isDefaultOffMcpToolGroup(id: McpToolGroupId): boolean {
  const group = MCP_TOOL_GROUPS.find((entry) => entry.id === id);
  return Boolean(group && "defaultOff" in group && group.defaultOff);
}

/** The groups a new conversation (or a `null` = "default" selection) gets: every group except the default-off ones. */
export const DEFAULT_MCP_TOOL_GROUPS = MCP_TOOL_GROUPS.map((group) => group.id).filter(
  (id) => !isDefaultOffMcpToolGroup(id),
) as McpToolGroupId[];

const MCP_TOOL_GROUP_SET = new Set<string>(MCP_TOOL_GROUPS.map((group) => group.id));

export function isMcpToolGroupId(value: unknown): value is McpToolGroupId {
  return typeof value === "string" && MCP_TOOL_GROUP_SET.has(value);
}

export function normalizeMcpToolGroups(raw: unknown): McpToolGroupId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: McpToolGroupId[] = [];
  for (const value of raw) {
    if (isMcpToolGroupId(value) && !out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/** System awareness/manual access is mandatory; handlers still enforce roles. */
export function isRequiredMcpToolGroup(id: McpToolGroupId): boolean {
  return id === "system";
}

/** Resolve legacy selections and policy together without mutating saved choices. */
export function effectiveMcpToolGroups(
  raw: unknown,
  allowed?: readonly McpToolGroupId[] | null,
): McpToolGroupId[] {
  const selected = raw == null ? [...DEFAULT_MCP_TOOL_GROUPS] : normalizeMcpToolGroups(raw);
  if (!selected.includes("system")) selected.push("system");
  return selected.filter(id => isRequiredMcpToolGroup(id) || !allowed || allowed.includes(id));
}

/**
 * Whether a selection equals the DEFAULT (so it may be stored as `null`): every
 * default group on and NO default-off group picked — a selection that adds one
 * must stay explicit, or storing it as "default" would silently drop the pick.
 */
export function allMcpToolGroupsSelected(groups: readonly McpToolGroupId[]): boolean {
  return (
    DEFAULT_MCP_TOOL_GROUPS.every((id) => isRequiredMcpToolGroup(id) || groups.includes(id)) &&
    !groups.some((id) => isDefaultOffMcpToolGroup(id))
  );
}

/** `groups` without the default-off ones — for remembered per-user defaults, which never carry them. */
export function withoutDefaultOffMcpToolGroups(groups: readonly McpToolGroupId[]): McpToolGroupId[] {
  return groups.filter((id) => !isDefaultOffMcpToolGroup(id));
}

export function mcpToolGroupLabelEn(id: McpToolGroupId): string {
  return MCP_TOOL_GROUPS.find((group) => group.id === id)?.labelEn ?? id;
}
