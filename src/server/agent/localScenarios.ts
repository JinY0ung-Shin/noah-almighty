/**
 * Scripted demo scenarios of the `local` stub runtime (`localRunner.ts`).
 *
 * DATA ONLY: each scenario is a list of steps the runner replays through the
 * run's `AgentEvents`, in the order and shapes the real runner
 * (`pi/runPiAgent.ts` + `pi/eventAdapter.ts`) produces them. Nothing here runs
 * a model, a tool, the network or the disk — a "tool" step only reports the
 * activity a real tool call would have reported.
 *
 * Text a scenario prints is user-facing, so it is Korean; identifiers and
 * comments are English.
 */
import type { AgentRequest, CanvasContentType, CanvasControl } from "../types.js";

/** The word a demo command starts with (`demo`, `demo <name>`). Never `/`-leading: the route expands those. */
export const LOCAL_DEMO_COMMAND = "demo";

/** What happened so far in the run — for answers that refer to it. */
export interface LocalDemoState {
  /** Canvases the events sink accepted. */
  canvasesShown: number;
  /** The run has no `onCanvas` sink (nobody is watching): the real canvas tool would not exist. */
  canvasSinkMissing: boolean;
  /** Images published through `onFile`. */
  filesShown: number;
  /** `onFile` refusals (English, as the real tool would hand them to the model). */
  fileErrors: string[];
  /** The run has no `onFile` sink. */
  fileSinkMissing: boolean;
}

export interface LocalDemoToolCall {
  /** Suffix of the tool-use id (the runner prefixes the turn, so ids never repeat in a conversation). */
  id: string;
  /** Noah-facing tool name, as `ToolEvent.name` carries it (`Read`, `Bash`, `mcp__repo__commit`, …). */
  name: string;
  inputSummary?: string;
  ok: boolean;
  /** How long the row stays `running`. */
  ms: number;
}

export interface LocalDemoCanvas {
  /** Suffix of the artifact id (the runner scopes it to the conversation). */
  id: string;
  title: string;
  content: string;
  contentType: CanvasContentType;
  controls?: CanvasControl[];
  editable?: boolean;
}

export type LocalDemoText = string | ((state: LocalDemoState) => string);

export type LocalDemoStep =
  /** Reasoning, streamed to `onThinking`. */
  | { kind: "thinking"; text: string }
  /** Answer text, streamed to `onDelta` in `chunk`-codepoint slices every `delayMs`. */
  | { kind: "text"; text: LocalDemoText; chunk?: number; delayMs?: number }
  /** Tool calls started together, each ending after its own `ms` (one entry = a plain sequential call). */
  | { kind: "tools"; calls: LocalDemoToolCall[] }
  /** `mcp__canvas__show`: a tool row around the `onCanvas` event. */
  | { kind: "canvas"; canvas: LocalDemoCanvas }
  /** `mcp__file_output__show_file`: a tool row around the `onFile` event. */
  | { kind: "file"; path: string; caption?: string }
  | { kind: "wait"; ms: number }
  /** The turn fails here, the way pi fails one in-band (`response.failed`). */
  | { kind: "fail"; code: string; upstream: string };

export interface LocalDemoScenario {
  name: string;
  /** One line for the `demo` listing. */
  summary: string;
  steps: (request: AgentRequest) => LocalDemoStep[];
}

/* ───────────────────────────── demo text ───────────────────────────── */

const LONG_TOKEN =
  "noah_almighty_local_demo_unbroken_token_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789abcdefghijklmnopqrstuvwxyz";

const TEXT_ANSWER = `# 로컬 시연: Markdown 스트리밍

이 답변은 모델이 아니라 **local 스텁**이 미리 정해진 문장을 조각내어 흘려보내는 것입니다. 실제 실행과 같은 \`delta\` 이벤트로 도착하므로, 말풍선이 글자 단위로 자라는 모습을 그대로 볼 수 있습니다.

## 1. 목록

- 순서 없는 항목 하나 — *기울임*, **굵게**, ~~취소선~~, \`inline code\`
- 한글과 English가 섞인 문장: Noah는 BFF이고 pi-gateway가 agent runtime입니다.
  - 들여쓴 하위 항목
  - 링크: [Noah 문서](https://example.com/docs)
1. 순서 있는 항목
2. 두 번째 항목
3. 세 번째 항목

> 인용문도 한 줄 넣어 둡니다. 긴 문장이 인용 블록 안에서 어떻게 줄바꿈되는지 확인할 수 있도록 일부러 조금 길게 썼습니다.

## 2. 표

| 표면 | 이벤트 | 시연 명령 |
| --- | --- | --- |
| 생각 과정 | \`thinking\` | \`demo thinking\` |
| 도구 활동 | \`tool\` / \`tool_end\` | \`demo tools\` |
| 캔버스 | \`canvas\` | \`demo canvas\` |
| 인라인 UI | \`delta\` (답변 본문) | \`demo ui\` |

## 3. 코드 블록

\`\`\`ts
// 스트리밍 도중 코드 펜스가 열려 있는 상태도 지나갑니다.
export function greet(name: string): string {
  const message = \`안녕하세요, \${name}님\`;
  return message.padEnd(24, "·");
}
\`\`\`

\`\`\`bash
AGENT_RUNTIME=local npm run dev   # server :48787 + client :5173
\`\`\`

## 4. 끊기지 않는 긴 토큰

${LONG_TOKEN}

위 토큰은 공백이 없어서, 말풍선이 가로로 넘치지 않고 줄바꿈되는지 확인하는 용도입니다.

---

끝입니다. 다른 시나리오는 \`demo\`만 입력하면 목록으로 볼 수 있습니다.
`;

/* ─────────────────────────── demo thinking ─────────────────────────── */

const THINKING_TEXT = `사용자가 생각 과정 카드를 보고 싶어 한다.

먼저 무엇을 보여 줘야 하는지 정리하자.
1. 생각이 스트리밍되는 동안 카드가 열려 있고 글자가 늘어나는지
2. 답변이 시작되면 카드가 접히는지
3. 새로고침 후에도 "생각 과정"이 메시지에 남아 있는지

생각 텍스트는 답변 말풍선에 섞이면 안 된다 — thinking 이벤트로만 나간다.
길이도 어느 정도 있어야 접힘/펼침이 의미가 있으니 몇 줄 더 적는다.
- 가정: 화면 너비는 데스크톱 기준
- 확인: 한글과 English, \`code\`가 섞여도 줄바꿈이 자연스러운가

정리됐다. 이제 답변을 쓴다.`;

const THINKING_ANSWER = `생각 과정을 먼저 흘려보낸 뒤 이 답변을 시작했습니다.

- 위쪽의 **생각 과정** 카드를 펼치면 방금 스트리밍된 추론 텍스트가 그대로 들어 있습니다.
- 추론은 \`thinking\` 이벤트로, 이 문단은 \`delta\` 이벤트로 도착했습니다. 둘은 섞이지 않습니다.
- 새로고침해도 카드가 남아 있어야 합니다(메시지의 \`response.thinking\`).
`;

/* ───────────────────────────── demo tools ───────────────────────────── */

const TOOLS_NARRATION = "요청하신 내용을 확인하기 위해 먼저 작업 폴더를 살펴보겠습니다.";
const TOOLS_NARRATION_2 = "파일 구성을 확인했습니다. 테스트를 돌리고 저장소 상태도 함께 보겠습니다.";

const TOOLS_ANSWER = `도구 호출 일곱 개를 순서대로 흉내 냈습니다. (실제로 실행된 것은 없습니다.)

| # | 도구 | 입력 | 결과 |
| --- | --- | --- | --- |
| 1 | 폴더 보기 | \`.\` | 완료 |
| 2 | 파일 읽기 | \`README.md\` | 완료 |
| 3 | 내용 검색 | \`runAgentStream · src/server\` | 완료 |
| 4 | 명령 실행 | \`npm test -- --run agent-local-runner\` | **실패** |
| 5 | 파일 찾기 | \`**/*.test.ts\` | 완료 (4번과 동시에 시작) |
| 6 | 파일 편집 | \`src/server/agent/localRunner.ts\` | 완료 |
| 7 | 스킬 읽기 | \`deck-builder\` | 완료 |

- 활동 영역에서 각 행이 **실행 중 → 완료**로 바뀌고, 4번만 **실패**로 남아야 합니다.
- 도구 사이에 썼던 중간 안내 문장 두 개는 답변에서 빠지고 **생각 과정**으로 접혀 들어갑니다(실제 실행의 \`text_fold\`와 같은 동작).
`;

/* ───────────────────────────── demo canvas ──────────────────────────── */

const CANVAS_MARKDOWN = `# 분기 회고 초안

**목표**: 배포 주기를 2주에서 1주로 줄인다.

## 잘된 점
- 자동 검증 게이트가 회귀를 세 번 잡아냈다.
- 리뷰 대기 시간이 평균 \`1.8일 → 0.6일\`로 줄었다.

## 아쉬운 점
1. 시각 회귀 테스트가 로컬에서 느리다.
2. 릴리스 노트 작성이 수동이다.

| 지표 | 지난 분기 | 이번 분기 |
| --- | ---: | ---: |
| 배포 횟수 | 6 | 11 |
| 롤백 | 2 | 0 |

> 이 캔버스는 \`editable\`입니다 — 내용을 고쳐서 보내면 수정본이 다음 메시지로 돌아옵니다.
`;

const CANVAS_VEGA = JSON.stringify({
  $schema: "https://vega.github.io/schema/vega-lite/v5.json",
  description: "월별 배포 횟수",
  width: "container",
  height: 260,
  data: {
    values: [
      { month: "7월", team: "플랫폼", deploys: 4 },
      { month: "7월", team: "제품", deploys: 2 },
      { month: "8월", team: "플랫폼", deploys: 5 },
      { month: "8월", team: "제품", deploys: 3 },
      { month: "9월", team: "플랫폼", deploys: 7 },
      { month: "9월", team: "제품", deploys: 4 },
      { month: "10월", team: "플랫폼", deploys: 6 },
      { month: "10월", team: "제품", deploys: 6 },
    ],
  },
  mark: { type: "bar", tooltip: true },
  encoding: {
    x: { field: "month", type: "nominal", sort: null, title: "월" },
    y: { field: "deploys", type: "quantitative", title: "배포 횟수" },
    color: { field: "team", type: "nominal", title: "팀" },
    xOffset: { field: "team" },
  },
});

const CANVAS_MERMAID = `flowchart LR
  U["사용자 브라우저"] -->|"POST /api/chat/stream"| N["Noah (BFF)"]
  N -->|"AGENT_RUNTIME=pi"| P["pi-gateway"]
  N -->|"AGENT_RUNTIME=local"| L["local 스텁 (시연)"]
  P -->|"SSE: delta, tool, canvas"| N
  L -->|"같은 AgentEvents"| N
  N -->|"SSE"| U
  P --> S[("사용자 샌드박스")]
`;

const CANVAS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" role="img" aria-label="세 단계 파이프라인">
  <rect x="0" y="0" width="480" height="240" rx="12" fill="#f4f6fb"/>
  <g font-family="sans-serif" font-size="14" text-anchor="middle">
    <rect x="24" y="84" width="120" height="72" rx="10" fill="#4f6bed"/>
    <text x="84" y="125" fill="#ffffff">요청</text>
    <rect x="180" y="84" width="120" height="72" rx="10" fill="#2aa198"/>
    <text x="240" y="125" fill="#ffffff">실행</text>
    <rect x="336" y="84" width="120" height="72" rx="10" fill="#d9822b"/>
    <text x="396" y="125" fill="#ffffff">결과</text>
    <path d="M144 120 H176" stroke="#56607a" stroke-width="2" marker-end="url(#arrow)"/>
    <path d="M300 120 H332" stroke="#56607a" stroke-width="2" marker-end="url(#arrow)"/>
    <text x="240" y="44" fill="#1f2a44" font-size="16" font-weight="bold">SVG 캔버스: 손으로 그린 도식</text>
    <text x="240" y="204" fill="#56607a" font-size="12">vega나 mermaid로 표현하기 어려운 그림에 씁니다</text>
  </g>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#56607a"/>
    </marker>
  </defs>
</svg>`;

const CANVAS_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #94a3b8; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px; }
  .card b { display: block; font-size: 26px; margin-top: 6px; }
  .up { color: #4ade80; } .down { color: #f87171; }
  button { margin-top: 20px; padding: 8px 14px; border-radius: 8px; border: 0; background: #6366f1; color: #fff; }
</style>
</head>
<body>
  <h1>HTML 캔버스: 정적 목업</h1>
  <p class="sub">별도 샌드박스 프레임 안에서 그려집니다. 스타일은 이 프레임에만 적용되고, 스크립트와 링크는 동작하지 않습니다.</p>
  <div class="cards">
    <div class="card">활성 사용자<b>1,284</b><span class="up">▲ 8.2%</span></div>
    <div class="card">평균 응답<b>1.9초</b><span class="up">▲ 0.3초 개선</span></div>
    <div class="card">오류율<b>0.4%</b><span class="down">▼ 0.1%p 악화</span></div>
  </div>
  <button type="button">눌러도 아무 일도 일어나지 않는 버튼</button>
  <script>document.body.textContent = "이 문장이 보이면 스크립트가 실행된 것입니다 (보이면 안 됩니다).";</script>
</body>
</html>`;

const CANVAS_FORM_MARKDOWN = `# 워크숍 일정 정하기

아래 양식은 캔버스 **controls**로 그려진 실제 입력 요소입니다. 값을 고르고 **보내기**를 누르면,
다음 메시지로 값이 전달되고 local 스텁이 받은 값을 그대로 되돌려 보여 줍니다.

| 안 | 장소 | 특징 |
| --- | --- | --- |
| A | 본사 대회의실 | 이동 없음, 30명 |
| B | 판교 세미나실 | 장비 좋음, 20명 |
| C | 온라인 | 준비 간단, 인원 제한 없음 |
`;

const CANVAS_FORM_CONTROLS: CanvasControl[] = [
  {
    type: "buttons",
    id: "venue",
    label: "장소",
    options: [
      { label: "A · 본사 대회의실", value: "A", description: "이동 없음" },
      { label: "B · 판교 세미나실", value: "B", description: "장비 좋음" },
      { label: "C · 온라인", value: "C", description: "준비 간단" },
    ],
  },
  {
    type: "buttons",
    id: "topics",
    label: "다룰 주제 (여러 개 선택)",
    multiSelect: true,
    options: [{ label: "회고" }, { label: "로드맵" }, { label: "기술 부채" }, { label: "온보딩" }],
  },
  {
    type: "select",
    id: "facilitator",
    label: "진행자",
    options: [{ label: "김하늘" }, { label: "이도윤" }, { label: "박서연" }, { label: "최지호" }, { label: "정유나" }],
    defaultValue: "이도윤",
  },
  { type: "slider", id: "hours", label: "진행 시간(시간)", min: 1, max: 8, step: 0.5, defaultValue: 3 },
  { type: "number", id: "attendees", label: "참석 인원", min: 2, max: 30, step: 1, defaultValue: 12 },
  { type: "date", id: "date", label: "날짜", defaultValue: "2026-12-04" },
  { type: "text", id: "note", label: "메모", placeholder: "준비물이나 요청 사항", multiline: true, required: false },
];

const CANVAS_DEMO: LocalDemoCanvas[] = [
  { id: "markdown", title: "Markdown · 분기 회고 초안", content: CANVAS_MARKDOWN, contentType: "markdown", editable: true },
  { id: "vega", title: "Vega-Lite · 월별 배포 횟수", content: CANVAS_VEGA, contentType: "vega" },
  { id: "mermaid", title: "Mermaid · 요청 흐름", content: CANVAS_MERMAID, contentType: "mermaid" },
  { id: "svg", title: "SVG · 세 단계 파이프라인", content: CANVAS_SVG, contentType: "svg" },
  { id: "html", title: "HTML · 대시보드 목업", content: CANVAS_HTML, contentType: "html" },
  {
    id: "controls",
    title: "Controls · 워크숍 일정 정하기",
    content: CANVAS_FORM_MARKDOWN,
    contentType: "markdown",
    controls: CANVAS_FORM_CONTROLS,
  },
];

const canvasAnswer = (state: LocalDemoState): string =>
  state.canvasSinkMissing
    ? "이 실행에는 캔버스를 받을 화면이 없어(`onCanvas` 없음) 캔버스를 열지 않았습니다. 실제 실행에서도 이런 턴에는 캔버스 도구가 등록되지 않습니다.\n"
    : `캔버스 ${state.canvasesShown}개를 옆 패널에 열었습니다. 탭을 넘기며 확인해 보세요.

1. **Markdown** — 편집 가능(\`editable\`). 내용을 고쳐 보내면 수정본이 다음 메시지로 돌아옵니다.
2. **Vega-Lite** — 묶음 막대 차트.
3. **Mermaid** — 요청 흐름도.
4. **SVG** — 손으로 그린 도식.
5. **HTML** — 샌드박스 프레임 속 정적 목업. 안에 넣어 둔 \`<script>\`는 실행되지 않아야 합니다.
6. **Controls** — 버튼·다중 선택·드롭다운·슬라이더·숫자·날짜·텍스트 입력이 달린 양식.

6번 양식을 채워 **보내기**를 누르면, 제가 받은 값을 그대로 되돌려 드립니다. 같은 대화에서 \`demo canvas\`를 다시 실행하면 새 탭이 쌓이지 않고 같은 캔버스가 갱신됩니다.
`;

/* ─────────────────────────────── demo ui ────────────────────────────── */

/**
 * Inline UI: the avatar writes UI tags in its ANSWER TEXT and the client draws
 * them in place while the text streams — no tool call, no canvas event. So this
 * scenario is nothing but an answer, streamed in small slices like every other
 * demo answer; that is what exercises the client's streaming render.
 *
 * The three UI blocks are separate strings so the test can run each — and the
 * whole answer, which is ONE document with one state scope (hence the unique
 * state names) — through the static checker (`src/shared/widget/check.ts`).
 */
const UI_CALCULATOR = `{@state amount = 3000}
{@state months = 24}
{@state rate = 4.5}
{@const principal = amount * 10000}
{@const interest = principal * (rate / 100) * (months / 12)}
{@const monthly = (principal + interest) / months}
<box border padding={3} gap={3}>
  <title size="md">대출 계산기</title>
  <row gap={3} wrap>
    <slider label="대출 금액" value={amount} onChange={setAmount} min={500} max={10000} step={500} suffix="만원" />
    <slider label="기간" value={months} onChange={setMonths} min={6} max={60} step={6} suffix="개월" />
    <slider label="금리(연)" value={rate} onChange={setRate} min={1} max={12} step={0.5} suffix="%" />
  </row>
  <row gap={3} wrap>
    <stat label="월 납입액" value={\`\${Math.round(monthly).toLocaleString()}원\`} />
    <stat label="총 이자" value={\`\${Math.round(interest).toLocaleString()}원\`} />
    <stat label="총 상환액" value={\`\${Math.round(principal + interest).toLocaleString()}원\`} />
  </row>
  <progress label="원금 비중" value={principal / (principal + interest)} />
  {#if months > 36}
    <callout tone="warning" title="우대 금리 제외">36개월을 넘으면 우대 금리가 적용되지 않습니다.</callout>
  {:else}
    <callout tone="success">우대 금리 적용 구간입니다.</callout>
  {/if}
  <row gap={2} wrap>
    <submit values={{ amount, months, rate, monthly: Math.round(monthly) }}>이 조건으로 진행</submit>
    <button send={\`대출 \${amount}만원을 \${months}개월 동안 갚을 때 금리를 낮추는 방법을 알려줘\`} variant="ghost">금리 낮추는 방법 묻기</button>
  </row>
</box>`;

const UI_DASHBOARD = `{@const monthly3q = [{ month: "7월", sales: 120, cost: 80 }, { month: "8월", sales: 150, cost: 90 }, { month: "9월", sales: 175, cost: 95 }, { month: "10월", sales: 160, cost: 110 }]}
{@const teamShare = [{ team: "플랫폼", share: 45 }, { team: "제품", share: 35 }, { team: "디자인", share: 20 }]}
<grid columns={4} gap={2}>
  <grid-item><box border padding={3}><stat label="매출" value="605만원" delta="+12.4%" trend="up" /></box></grid-item>
  <grid-item><box border padding={3}><stat label="비용" value="375만원" delta="+6.1%" trend="up" hint="전 분기 대비" /></box></grid-item>
  <grid-item><box border padding={3}><stat label="이익률" value="38%" delta="+3.8%p" trend="up" /></box></grid-item>
  <grid-item><box border padding={3}><stat label="미처리 요청" value={7} delta="-2" trend="down" /></box></grid-item>
</grid>
<grid columns={2} gap={2}>
  <grid-item>
    <chart type="bar" data={monthly3q} xKey="month" series={[{ key: "sales", label: "매출" }, { key: "cost", label: "비용" }]} unit="만원" title="월별 매출과 비용" />
  </grid-item>
  <grid-item>
    <chart type="donut" data={teamShare} xKey="team" series={["share"]} unit="%" title="팀별 매출 비중" />
  </grid-item>
</grid>`;

const UI_TABLE = `{@state team = "all"}
{@state view = "table"}
{@const records = [{ team: "플랫폼", month: "7월", sales: 55 }, { team: "플랫폼", month: "8월", sales: 70 }, { team: "플랫폼", month: "9월", sales: 80 }, { team: "제품", month: "7월", sales: 45 }, { team: "제품", month: "8월", sales: 50 }, { team: "제품", month: "9월", sales: 60 }, { team: "디자인", month: "7월", sales: 20 }, { team: "디자인", month: "8월", sales: 30 }, { team: "디자인", month: "9월", sales: 35 }]}
{@const shown = records.filter((r) => team === "all" || r.team === team)}
{@const total = shown.reduce((sum, r) => sum + r.sales, 0)}
<row gap={3} wrap align="end">
  <select label="팀" value={team} onChange={setTeam} options={[{ label: "전체", value: "all" }, { label: "플랫폼", value: "플랫폼" }, { label: "제품", value: "제품" }, { label: "디자인", value: "디자인" }]} />
  <tabs label="보기" value={view} onChange={setView} options={[{ label: "표", value: "table" }, { label: "요약", value: "summary" }]} />
</row>
{#if view === "table"}
  <table sortable caption="팀별 월 매출(만원)" columns={[{ key: "team", label: "팀" }, { key: "month", label: "월" }, { key: "sales", label: "매출", align: "end" }]} rows={shown} />
{:else}
  <row gap={3} wrap>
    <stat label="행 수" value={shown.length} />
    <stat label="합계" value={\`\${total}만원\`} />
    <stat label="평균" value={\`\${Math.round(total / shown.length)}만원\`} />
  </row>
{/if}`;

/** The UI blocks of `demo ui`, in answer order (the test checks each, and the whole answer). */
export const LOCAL_DEMO_UI_BLOCKS: Readonly<Record<"calculator" | "dashboard" | "table", string>> = {
  calculator: UI_CALCULATOR,
  dashboard: UI_DASHBOARD,
  table: UI_TABLE,
};

/** A tag shown AS SOURCE inside a code fence: the client must not draw it. */
export const LOCAL_DEMO_UI_FENCED_SOURCE = '<stat label="이 태그는" value="그려지지 않습니다" />';

/** The whole `demo ui` answer: Markdown with the UI blocks written in it. */
export const LOCAL_DEMO_UI_ANSWER = `# 로컬 시연: 인라인 UI

이 답변은 **본문 안에** UI 태그를 그대로 적은 것입니다. 도구 호출도, 옆 패널도 없습니다. 글자가 흘러오는 동안 태그가 완성되는 대로 그 자리에 그려져야 합니다.

## 1. 계산기

값을 바꾸면 숫자가 **바로** 다시 계산됩니다. 계산은 브라우저 안에서만 일어나고, 그동안 아바타는 호출되지 않습니다.

${UI_CALCULATOR}

- **이 조건으로 진행**(\`<submit>\`)을 누르면 버튼 이름과 값이 다음 메시지로 전송됩니다.
- **금리 낮추는 방법 묻기**(\`<button send>\`)는 버튼에 적어 둔 문장을 다음 메시지로 보냅니다.

## 2. 대시보드

지표 카드 네 개와 차트 두 개입니다. 막대 차트와 도넛 차트 모두 \`data\`만 넘기는 간단한 형식으로 적었습니다.

${UI_DASHBOARD}

차트 아래의 이 문단은 다시 평범한 Markdown입니다. *기울임*과 \`inline code\`, [링크](https://example.com/docs)가 그대로 보여야 합니다.

## 3. 탭과 정렬되는 표

팀을 고르고 탭으로 표와 요약을 오갑니다. 표의 머리글을 누르면 정렬됩니다.

${UI_TABLE}

## 4. 소스로 보여 주기

코드 블록 안에 적은 태그는 **그려지지 않고** 소스 그대로 보여야 합니다.

\`\`\`
${LOCAL_DEMO_UI_FENCED_SOURCE}
\`\`\`

끝입니다. 1번의 버튼을 누르면 local 스텁이 받은 메시지를 \`[local] …\`로 되돌려 줍니다.
`;

/* ────────────────────────── demo error / long ───────────────────────── */

const ERROR_PARTIAL = `요청하신 내용을 정리하고 있습니다.

1. 먼저 현재 상태를 확인했습니다.
2. 다음 단계로 넘어가려는 순간 `;

/** How many lines `demo long` streams, and how long each takes. */
export const LOCAL_DEMO_LONG_STEPS = 30;
export const LOCAL_DEMO_LONG_STEP_MS = 600;

function longSteps(): LocalDemoStep[] {
  const steps: LocalDemoStep[] = [
    {
      kind: "text",
      text: `천천히 ${LOCAL_DEMO_LONG_STEPS}단계를 진행합니다(약 ${Math.round((LOCAL_DEMO_LONG_STEPS * LOCAL_DEMO_LONG_STEP_MS) / 1000)}초). 도중에 **중지**를 누르거나 메시지를 하나 더 보내 보세요.\n\n`,
    },
  ];
  for (let index = 1; index <= LOCAL_DEMO_LONG_STEPS; index++) {
    steps.push({ kind: "wait", ms: LOCAL_DEMO_LONG_STEP_MS });
    steps.push({
      kind: "text",
      text: `- 단계 ${index}/${LOCAL_DEMO_LONG_STEPS} 완료 — ${"█".repeat(Math.ceil((index / LOCAL_DEMO_LONG_STEPS) * 20)).padEnd(20, "░")}\n`,
      chunk: 64,
      delayMs: 0,
    });
  }
  steps.push({ kind: "text", text: `\n${LOCAL_DEMO_LONG_STEPS}단계를 모두 마쳤습니다.\n` });
  return steps;
}

/* ─────────────────────────── demo attachments ───────────────────────── */

function attachmentSteps(request: AgentRequest): LocalDemoStep[] {
  const files = request.imageFiles ?? [];
  if (files.length === 0) {
    return [
      {
        kind: "text",
        text:
          "첨부할 이미지가 없습니다. **이미지를 하나 이상 붙여서** `demo attachments`를 다시 보내 주세요.\n\n" +
          "local 스텁은 디스크에 파일을 만들지 않습니다. 그래서 방금 메시지에 붙인 이미지(대화 작업 폴더에 저장된 사본)를 " +
          "실제 실행의 `show_file`과 같은 경로로 답변 말풍선에 다시 게시하는 방식으로만 시연합니다.\n",
      },
    ];
  }
  return [
    { kind: "text", text: "붙여 주신 이미지를 답변에 다시 게시하겠습니다." },
    ...files.map(
      (file, index): LocalDemoStep => ({
        kind: "file",
        path: file.path,
        caption: `시연 이미지 ${index + 1}/${files.length}${file.name ? ` · ${file.name}` : ""}`,
      }),
    ),
    {
      kind: "text",
      text: (state) =>
        state.fileSinkMissing
          ? "이 실행에는 파일을 받을 화면이 없어(`onFile` 없음) 이미지를 게시하지 않았습니다.\n"
          : `이미지 ${state.filesShown}개를 이 답변에 게시했습니다(\`file\` 이벤트).` +
            (state.fileErrors.length ? `\n\n게시하지 못한 항목:\n${state.fileErrors.map((error) => `- ${error}`).join("\n")}` : "") +
            "\n\n- 이미지는 이 문단 **위**, 게시 시점의 위치에 붙어 있어야 합니다.\n- 새로고침해도 메시지에 남아 있어야 합니다.\n- 내려받기 카드(`share_file`)는 스텁이 문서 파일을 만들지 않으므로 시연하지 않습니다.\n",
    },
  ];
}

/* ───────────────────────────── the registry ─────────────────────────── */

export const LOCAL_DEMO_SCENARIOS: readonly LocalDemoScenario[] = [
  {
    name: "text",
    summary: "긴 Markdown 답변 스트리밍 (제목·목록·표·코드·긴 토큰·한영 혼용)",
    steps: () => [{ kind: "text", text: TEXT_ANSWER }],
  },
  {
    name: "thinking",
    summary: "생각 과정을 먼저 스트리밍한 뒤 답변",
    steps: () => [
      { kind: "thinking", text: THINKING_TEXT },
      { kind: "text", text: THINKING_ANSWER },
    ],
  },
  {
    name: "tools",
    summary: "도구 호출 여러 개 (실행 중 → 완료, 하나는 실패) 뒤 답변",
    steps: () => [
      { kind: "thinking", text: "작업 폴더를 먼저 보고, 관련 파일을 읽은 다음 테스트를 돌려 보자." },
      { kind: "text", text: TOOLS_NARRATION },
      { kind: "tools", calls: [{ id: "ls", name: "LS", inputSummary: ".", ok: true, ms: 500 }] },
      { kind: "tools", calls: [{ id: "read", name: "Read", inputSummary: "README.md", ok: true, ms: 700 }] },
      { kind: "tools", calls: [{ id: "grep", name: "Grep", inputSummary: "runAgentStream · src/server", ok: true, ms: 900 }] },
      { kind: "text", text: TOOLS_NARRATION_2 },
      {
        // Two calls of one model step: both rows run at once, the shell fails.
        kind: "tools",
        calls: [
          { id: "bash", name: "Bash", inputSummary: "npm test -- --run agent-local-runner", ok: false, ms: 1600 },
          { id: "glob", name: "Glob", inputSummary: "**/*.test.ts", ok: true, ms: 400 },
        ],
      },
      { kind: "tools", calls: [{ id: "edit", name: "Edit", inputSummary: "src/server/agent/localRunner.ts", ok: true, ms: 600 }] },
      { kind: "tools", calls: [{ id: "skill", name: "mcp__skills__read", inputSummary: "deck-builder", ok: true, ms: 500 }] },
      { kind: "text", text: TOOLS_ANSWER },
    ],
  },
  {
    name: "canvas",
    summary: "캔버스 6종: markdown(편집 가능)·vega·mermaid·svg·html + controls 양식",
    steps: () => [
      { kind: "text", text: "콘텐츠 유형별 캔버스를 차례로 열겠습니다." },
      ...CANVAS_DEMO.map((canvas): LocalDemoStep => ({ kind: "canvas", canvas })),
      { kind: "text", text: canvasAnswer },
    ],
  },
  {
    name: "ui",
    summary: "인라인 UI: 답변 본문 속 계산기(+보내기 버튼)·대시보드(지표, 막대·도넛 차트)·탭과 정렬 표, 코드 블록 속 소스",
    steps: () => [
      { kind: "thinking", text: "UI는 도구가 아니라 답변 본문에 직접 적는다. 계산기, 대시보드, 표 순서로 쓰자." },
      // Slices small enough that a tag is cut mid-way many times over.
      { kind: "text", text: LOCAL_DEMO_UI_ANSWER, chunk: 9, delayMs: 12 },
    ],
  },
  {
    name: "error",
    summary: "답변 도중 실패하는 실행 (일부 스트리밍 뒤 오류)",
    steps: () => [
      { kind: "thinking", text: "여기서는 일부만 답한 뒤 실패하는 실행을 보여 준다." },
      { kind: "text", text: ERROR_PARTIAL },
      { kind: "wait", ms: 600 },
      { kind: "fail", code: "server_error", upstream: "local demo: simulated upstream failure (demo error)" },
    ],
  },
  {
    name: "long",
    summary: `느린 스트림 (약 ${Math.round((LOCAL_DEMO_LONG_STEPS * LOCAL_DEMO_LONG_STEP_MS) / 1000)}초) — 중지와 실행 중 메시지 보내기 시험용`,
    steps: longSteps,
  },
  {
    name: "attachments",
    summary: "메시지에 붙인 이미지를 답변 말풍선에 다시 게시 (이미지를 첨부해서 보내세요)",
    steps: attachmentSteps,
  },
];

/** `demo` alone: the scenario listing (Korean, user-facing). */
export function localDemoListing(): string {
  return [
    "## local 런타임 시연 명령",
    "",
    "`AGENT_RUNTIME=local`에서만 동작하는 스크립트 시연입니다. 모델·도구·네트워크는 쓰지 않고, 실제 실행과 같은 이벤트만 흘려보냅니다.",
    "",
    "| 명령 | 내용 |",
    "| --- | --- |",
    ...LOCAL_DEMO_SCENARIOS.map((scenario) => `| \`${LOCAL_DEMO_COMMAND} ${scenario.name}\` | ${scenario.summary} |`),
    "",
    "- 캔버스 양식에서 **보내기**를 누르면, 받은 값을 그대로 되돌려 보여 줍니다(제출 왕복 확인).",
    "- 인라인 UI의 버튼(`<submit>`, `<button send>`)은 평범한 다음 메시지를 보내므로, 그 문장이 `[local] <메시지>`로 되돌아옵니다.",
    "- 실행 중에 메시지를 더 보내면 흐름에 끼워 넣고 받았다고 알려 줍니다.",
    "- 그 밖의 메시지는 이전과 같이 `[local] <메시지>`로 되돌려 줍니다.",
    "",
  ].join("\n");
}

/** `demo <unknown>`: say so and list what exists. */
export function localDemoUnknown(name: string): string {
  return `\`${name}\` 시나리오는 없습니다.\n\n${localDemoListing()}`;
}

export type LocalDemoCommand =
  | { kind: "list" }
  | { kind: "scenario"; scenario: LocalDemoScenario }
  | { kind: "unknown"; name: string };

/**
 * `demo` / `demo <name>` (case-insensitive, surrounding whitespace ignored), else
 * null — every other message keeps the plain echo. Only a message that is the
 * command and nothing else matches: "demo를 보여줘" or a multi-line message is
 * an ordinary message.
 */
export function parseLocalDemoCommand(message: string): LocalDemoCommand | null {
  const match = /^demo(?:[ \t]+([A-Za-z][A-Za-z0-9-]*))?$/i.exec(message.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  if (!name || name === "list" || name === "help") return { kind: "list" };
  const scenario = LOCAL_DEMO_SCENARIOS.find((entry) => entry.name === name);
  return scenario ? { kind: "scenario", scenario } : { kind: "unknown", name };
}

/* ───────────────────────────── submit echo ──────────────────────────── */

export interface LocalCanvasSubmission {
  canvasId: string;
  title?: string;
  /** Submitted values as the route rendered them (`formatSubmission`): `[key, text]` in order. */
  values?: [string, string][];
  /** The edited content of an `editable` canvas. */
  editedContent?: string;
}

const SUBMISSION_REF = /the canvas (?:"([\s\S]*?)" )?\(id: ([^)\s]+)\)/;

/**
 * Recognize the agent message the chat route builds for a canvas submission
 * (`routes/chat.ts`: `On the canvas "<title>" (id: <id>), The user responded on
 * the canvas:` + one `- key: value` line each, and/or `The user edited the
 * canvas … content to:`). Null for anything else.
 */
export function parseLocalCanvasSubmission(message: string): LocalCanvasSubmission | null {
  const responded = message.startsWith("On the canvas ");
  if (!responded && !message.startsWith("The user edited the canvas ")) return null;
  const ref = SUBMISSION_REF.exec(message);
  if (!ref) return null;
  const submission: LocalCanvasSubmission = { canvasId: ref[2]!, ...(ref[1] ? { title: ref[1] } : {}) };
  const editMarker = /(?:^|\n\n)The user edited the canvas [\s\S]*?\) content to:\n/.exec(message);
  const head = editMarker ? message.slice(0, editMarker.index) : message;
  if (editMarker) submission.editedContent = message.slice(editMarker.index + editMarker[0].length);
  if (responded) {
    const marker = "The user responded on the canvas:\n";
    const at = head.indexOf(marker);
    if (at >= 0) {
      const values: [string, string][] = [];
      for (const line of head.slice(at + marker.length).split("\n")) {
        const entry = /^- ([^:]+): ?([\s\S]*)$/.exec(line);
        // A value that itself spans lines continues the previous entry.
        if (entry) values.push([entry[1]!, entry[2]!]);
        else if (values.length) values[values.length - 1]![1] += `\n${line}`;
      }
      submission.values = values;
    } else if (head.includes("The user submitted the canvas with no values.")) {
      submission.values = [];
    } else if (!editMarker) {
      return null;
    }
  }
  return submission;
}

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\n/g, "<br>") || "(빈 값)";

/** The Korean answer that echoes a canvas submission back, so the controls round trip is visible. */
export function localSubmissionEcho(submission: LocalCanvasSubmission): string {
  const name = submission.title ? `**${submission.title}** 캔버스` : "캔버스";
  const lines = [`${name}에서 보낸 내용을 받았습니다. (canvas id: \`${submission.canvasId}\`)`, ""];
  if (submission.values) {
    if (submission.values.length === 0) {
      lines.push("값 없이 제출되었습니다.", "");
    } else {
      lines.push("| 키 | 받은 값 |", "| --- | --- |");
      for (const [key, value] of submission.values) lines.push(`| \`${cell(key)}\` | ${cell(value)} |`);
      lines.push("");
    }
  }
  if (submission.editedContent !== undefined) {
    lines.push("수정해서 보낸 내용:", "", "```", submission.editedContent.replace(/```/g, "'''"), "```", "");
  }
  lines.push("실제 실행에서는 아바타가 이 값을 다음 턴의 입력으로 받아 이어서 답합니다.", "");
  return lines.join("\n");
}
