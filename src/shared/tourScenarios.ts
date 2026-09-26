/**
 * 체험 시나리오 (guided tours) — single source of truth for tour slugs and the
 * Korean card copy shown in the chat empty state and the slash menu.
 *
 * Imported by BOTH sides: the client renders scenario cards / the `/tour` menu
 * entry from this list, and the server validates `/tour <slug>` and maps each
 * slug to its agent-facing prompt. The English prompt text itself lives
 * SERVER-SIDE ONLY (src/server/tourScenarios.ts) — it must never ship in the
 * client bundle (guarded by "client frontend carries no copy of the server
 * slash prompts" in tests/agent-core.test.ts).
 */
export type TourSlug = "browser" | "capture" | "pptx" | "skill";

export interface TourScenario {
  slug: TourSlug;
  /** Card title (user-facing Korean). */
  titleKo: string;
  /** One-line card description (user-facing Korean). */
  descriptionKo: string;
  /** Rough duration label, e.g. "약 3분". */
  durationKo: string;
  /**
   * Client hint: this tour drives the user's own browser, so the card click
   * must first ensure the `browser` MCP tool group is enabled on the pane, and
   * the card is hidden entirely when an admin policy blocks that group.
   */
  needsBrowser?: boolean;
}

/** Display order = array order (browser first: the flagship scenario). */
export const TOUR_SCENARIOS: readonly TourScenario[] = [
  {
    slug: "browser",
    titleKo: "브라우저로 일 시키기",
    descriptionKo: "아바타가 내 브라우저의 페이지를 직접 읽고 요약해 드려요.",
    durationKo: "약 3분",
    needsBrowser: true,
  },
  {
    slug: "capture",
    titleKo: "업무 지식 기억시키기",
    descriptionKo: "한 줄을 기억시키고 바로 다시 꺼내 봐요. 아바타가 성장하는 방식이에요.",
    durationKo: "약 3분",
  },
  {
    slug: "pptx",
    titleKo: "PPT 초안 만들기",
    descriptionKo: "주제만 말하면 바로 고쳐 쓸 수 있는 디자인 슬라이드를 만들어 드려요.",
    durationKo: "약 2분",
  },
  {
    slug: "skill",
    titleKo: "반복 업무를 스킬로 만들기",
    descriptionKo: "자주 하는 일을 스킬로 저장하면 다음 대화부터 그대로 해내요.",
    durationKo: "약 5분",
  },
];

export function findTourScenario(slug: string): TourScenario | undefined {
  return TOUR_SCENARIOS.find((scenario) => scenario.slug === slug);
}

/** "browser, capture, pptx, skill" — for error/help text that lists the slugs. */
export const TOUR_SLUG_LIST = TOUR_SCENARIOS.map((scenario) => scenario.slug).join(", ");
