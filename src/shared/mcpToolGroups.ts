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
] as const;

export type McpToolGroupId = (typeof MCP_TOOL_GROUPS)[number]["id"];

export const DEFAULT_MCP_TOOL_GROUPS = MCP_TOOL_GROUPS.map((group) => group.id) as McpToolGroupId[];

const MCP_TOOL_GROUP_SET = new Set<string>(DEFAULT_MCP_TOOL_GROUPS);

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

export function allMcpToolGroupsSelected(groups: readonly McpToolGroupId[]): boolean {
  return DEFAULT_MCP_TOOL_GROUPS.every((id) => isRequiredMcpToolGroup(id) || groups.includes(id));
}
