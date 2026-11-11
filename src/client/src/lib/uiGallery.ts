// The 인라인 UI gallery's samples (views/UiGalleryView.tsx, `#/uiGallery`):
// one small ANSWER per thing an avatar can draw in its answer text. Each
// `source` is exactly what an avatar would write — Markdown with component
// tags — and the gallery draws it with the chat's own renderer
// (components/widget/AnswerUi.tsx), so the page cannot show something a real
// answer would not.
//
// The component table (src/shared/widget/spec.ts) is the grammar; this file is
// only examples of it. `tests/client-ui-gallery.test.ts` fails when a component
// or a chart type has no sample here, and when a sample does not pass the
// static check an answer goes through.
import { WIDGET_ICON_NAMES } from "../../../shared/widget/icons.js";
import { COLOR_TOKENS, TONE_TOKENS } from "../../../shared/widget/style.js";

export interface GallerySample {
  id: string;
  title: string;
  /** One line under the title: what to try, or what to notice. */
  note?: string;
  /** The answer text: Markdown with UI tags, as an avatar writes it. */
  source: string;
  /** Shown as source only: it needs something a gallery does not have (an image of a conversation). */
  sourceOnly?: boolean;
}

export interface GallerySection {
  id: string;
  title: string;
  intro: string;
  samples: GallerySample[];
}

const MONTHLY = `[{ month: "7월", sales: 120, cost: 80 }, { month: "8월", sales: 150, cost: 90 }, { month: "9월", sales: 175, cost: 95 }, { month: "10월", sales: 160, cost: 110 }]`;
const SERIES = `[{ key: "sales", label: "매출" }, { key: "cost", label: "비용" }]`;

const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(", ");

const CHARTS: GallerySample[] = [
  {
    id: "chart-bar",
    title: "막대 차트",
    note: "type을 생략하면 막대입니다. 계열이 둘 이상이면 나란히 그려집니다.",
    source: `<chart type="bar" data={${MONTHLY}} xKey="month" series={${SERIES}} unit="만원" title="월별 매출과 비용" />`,
  },
  {
    id: "chart-bar-stacked",
    title: "누적 막대",
    source: `<chart type="bar" stacked data={${MONTHLY}} xKey="month" series={${SERIES}} unit="만원" title="월별 합계" />`,
  },
  {
    id: "chart-bar-horizontal",
    title: "가로 막대",
    source: `<chart type="bar" horizontal data={[{ team: "플랫폼", done: 42 }, { team: "제품", done: 35 }, { team: "디자인", done: 18 }, { team: "운영", done: 27 }]} xKey="team" series={[{ key: "done", label: "완료한 작업" }]} unit="건" title="팀별 완료 작업" />`,
  },
  {
    id: "chart-line",
    title: "선 차트",
    source: `<chart type="line" data={${MONTHLY}} xKey="month" series={${SERIES}} unit="만원" title="월별 추이" />`,
  },
  {
    id: "chart-area",
    title: "영역 차트",
    note: "stacked를 주면 계열이 쌓입니다.",
    source: `<chart type="area" stacked data={${MONTHLY}} xKey="month" series={${SERIES}} unit="만원" title="누적 추이" />`,
  },
  {
    id: "chart-pie",
    title: "원 차트",
    source: `<chart type="pie" data={[{ team: "플랫폼", share: 45 }, { team: "제품", share: 35 }, { team: "디자인", share: 20 }]} xKey="team" series={["share"]} title="팀별 비중" />`,
  },
  {
    id: "chart-donut",
    title: "도넛 차트",
    source: `<chart type="donut" data={[{ kind: "버그", count: 12 }, { kind: "기능", count: 21 }, { kind: "문의", count: 9 }, { kind: "기타", count: 4 }]} xKey="kind" series={["count"]} title="요청 유형" />`,
  },
  {
    id: "chart-spec",
    title: "Vega-Lite 스펙",
    note: "다섯 가지 밖의 차트(산점도, 히트맵, 겹친 마크)는 Vega-Lite 스펙을 통째로 적습니다.",
    source: `{@const points = [{ hours: 2, score: 51, team: "A" }, { hours: 3, score: 58, team: "A" }, { hours: 5, score: 70, team: "A" }, { hours: 7, score: 82, team: "A" }, { hours: 1, score: 40, team: "B" }, { hours: 4, score: 55, team: "B" }, { hours: 6, score: 66, team: "B" }, { hours: 8, score: 74, team: "B" }]}
<chart label="학습 시간과 점수" spec={{ title: "학습 시간과 점수", data: { values: points }, mark: { type: "point", filled: true, size: 80 }, encoding: { x: { field: "hours", type: "quantitative", title: "학습 시간(시간)" }, y: { field: "score", type: "quantitative", title: "점수", scale: { zero: false } }, color: { field: "team", type: "nominal", title: "팀" } } }} />`,
  },
  {
    id: "chart-state",
    title: "상태에 묶인 차트",
    note: "탭을 눌러 차트로 넘어가면 그때 등장 효과가 재생됩니다. 이미 그려진 차트의 값만 바뀔 때는 움직이지 않습니다.",
    source: `{@state view = "table"}
{@state unit = 1}
{@const rows = ${MONTHLY}.map((r) => ({ month: r.month, sales: r.sales * unit }))}
<row gap={3} wrap align="end">
  <tabs label="보기" value={view} onChange={setView} options={[{ label: "표", value: "table" }, { label: "차트", value: "chart" }]} />
  <segmented-control label="단위" value={unit} onChange={setUnit} options={[{ label: "만원", value: 1 }, { label: "천원", value: 10 }]} />
</row>
{#if view === "chart"}
  <chart type="bar" data={rows} xKey="month" series={[{ key: "sales", label: "매출" }]} title="월별 매출" />
{:else}
  <table columns={[{ key: "month", label: "월" }, { key: "sales", label: "매출", align: "end" }]} rows={rows} />
{/if}`,
  },
];

const DATA: GallerySample[] = [
  {
    id: "stat",
    title: "지표 카드",
    source: `<row gap={3} wrap>
  <box border padding={3}><stat label="매출" value="605만원" delta="+12.4%" trend="up" /></box>
  <box border padding={3}><stat label="미처리 요청" value={7} delta="-2" trend="down" hint="지난주 대비" /></box>
  <box border padding={3}><stat label="응답 시간" value="1.2초" delta="변화 없음" trend="flat" /></box>
</row>`,
  },
  {
    id: "progress",
    title: "진행률",
    source: `<col gap={2}>
  <progress label="전체 진행" value={0.64} />
  <progress label="검수 통과" value={0.9} tone="success" />
  <progress label="예산 소진" value={0.82} tone="warning" />
</col>`,
  },
  {
    id: "table",
    title: "표",
    note: "sortable을 주면 머리글을 눌러 정렬합니다. 정렬은 보는 사람의 화면에서만 바뀝니다.",
    source: `<table sortable caption="팀별 월 매출(만원)" columns={[{ key: "team", label: "팀" }, { key: "month", label: "월" }, { key: "sales", label: "매출", align: "end" }]} rows={[{ team: "플랫폼", month: "8월", sales: 70 }, { team: "플랫폼", month: "9월", sales: 80 }, { team: "제품", month: "8월", sales: 50 }, { team: "제품", month: "9월", sales: 60 }, { team: "디자인", month: "8월", sales: 30 }, { team: "디자인", month: "9월", sales: 35 }]} />`,
  },
  {
    id: "details",
    title: "접는 구역",
    source: `<details title="계산 근거 보기">
  <text>매출 605만원에서 비용 375만원을 뺀 230만원이 이익입니다.</text>
  <text color="muted" size="sm">이익률 = 230 ÷ 605 ≈ 38%</text>
</details>
<details title="처음부터 열려 있는 구역" open>
  <text>open을 주면 펼쳐진 채로 시작합니다.</text>
</details>`,
  },
];

const INPUTS: GallerySample[] = [
  {
    id: "calculator",
    title: "상태와 계산",
    note: "{@state}가 값을 들고, {@const}가 그 값으로 다시 계산합니다. 계산은 브라우저 안에서만 일어납니다.",
    source: `{@state qty = 2}
{@state price = 12000}
{@const total = qty * price}
<box border padding={3} gap={3}>
  <title size="md">주문 계산</title>
  <row gap={3} wrap>
    <slider label="수량" value={qty} onChange={setQty} min={1} max={10} suffix="개" />
    <input label="단가" type="number" value={price} onChange={(v) => setPrice(v === "" ? 0 : v)} min={0} step={1000} />
  </row>
  <stat label="합계" value={\`\${total.toLocaleString()}원\`} />
</box>`,
  },
  {
    id: "choices",
    title: "고르기",
    source: `{@state plan = "team"}
{@state region = "kr"}
{@state tab = "summary"}
<col gap={3}>
  <segmented-control label="요금제" value={plan} onChange={setPlan} options={[{ label: "개인", value: "solo" }, { label: "팀", value: "team" }, { label: "전사", value: "org" }]} />
  <select label="지역" value={region} onChange={setRegion} placeholder="지역 선택" options={[{ label: "한국", value: "kr" }, { label: "일본", value: "jp" }, { label: "미국", value: "us" }]} />
  <tabs label="보기" value={tab} onChange={setTab} options={[{ label: "요약", value: "summary" }, { label: "상세", value: "detail" }]} />
  {#if tab === "summary"}
    <row gap={2} align="center">
      <text>요금제</text>
      <badge tone="accent">{plan}</badge>
      <text>지역</text>
      <badge>{region}</badge>
    </row>
  {:else}
    <text color="muted">탭의 내용은 if 블록으로 직접 나눠 그립니다.</text>
  {/if}
</col>`,
  },
  {
    id: "toggles",
    title: "체크박스와 스위치",
    source: `{@state agreed = false}
{@state notify = true}
<col gap={2}>
  <checkbox checked={agreed} onChange={setAgreed}>약관에 동의합니다</checkbox>
  <switch checked={notify} onChange={setNotify}>완료되면 알림 받기</switch>
  <switch checked={false} onChange={() => 0} disabled>바꿀 수 없는 스위치</switch>
  <text color="muted" size="sm">동의: {agreed ? "예" : "아니오"} · 알림: {notify ? "켬" : "끔"}</text>
</col>`,
  },
  {
    id: "text-input",
    title: "글자 입력",
    source: `{@state name = ""}
<col gap={2}>
  <input label="이름" value={name} onChange={setName} placeholder="이름을 적어 보세요" maxLength={20} />
  <text>{name ? \`안녕하세요, \${name} 님.\` : "아직 입력이 없습니다."}</text>
</col>`,
  },
  {
    id: "buttons",
    title: "버튼",
    note: "버튼은 한 가지 일만 합니다. onClick은 화면의 상태만 바꾸고 아바타에게는 아무것도 보내지 않습니다.",
    source: `{@state count = 0}
<row gap={2} wrap align="center">
  <button onClick={() => setCount((n) => n + 1)} icon="plus">하나 더</button>
  <button onClick={() => setCount(0)} variant="secondary" icon="refresh">초기화</button>
  <button onClick={() => copy(\`현재 값: \${count}\`)} variant="ghost" icon="copy">값 복사</button>
  <button onClick={() => setCount(0)} disabled>누를 수 없음</button>
  <text tabular>현재 값 {count}</text>
</row>`,
  },
  {
    id: "each",
    title: "목록 반복",
    note: "{#each}로 배열을 돌고, {:else}는 비었을 때 보입니다.",
    source: `{@state only = false}
{@const tasks = [{ name: "기획서 검토", done: true }, { name: "API 연동", done: false }, { name: "배포 점검", done: false }]}
{@const shown = tasks.filter((t) => !only || !t.done)}
<col gap={2}>
  <switch checked={only} onChange={setOnly}>남은 일만 보기</switch>
  {#each shown as task, index}
    <row gap={2} align="center">
      <icon name={task.done ? "check-square" : "clock"} color={task.done ? "success" : "muted"} />
      <text>{index + 1}. {task.name}</text>
    </row>
  {:else}
    <text color="muted">보여 줄 일이 없습니다.</text>
  {/each}
</col>`,
  },
];

const LAYOUT: GallerySample[] = [
  {
    id: "box",
    title: "상자",
    note: "border나 background를 주면 카드처럼 보입니다.",
    source: `<row gap={3} wrap>
  <box border padding={3} radius="md"><text>테두리</text></box>
  <box background="subtle" padding={3} radius="md"><text>옅은 바탕</text></box>
  <box background="accent" padding={3} radius="lg"><text>강조 바탕</text></box>
  <box background="success" padding={3}><text>성공</text></box>
  <box background="warning" padding={3}><text>주의</text></box>
  <box background="danger" padding={3}><text>위험</text></box>
</row>`,
  },
  {
    id: "row-col",
    title: "가로와 세로",
    source: `<row gap={3} align="center" justify="between">
  <col gap={1}>
    <text weight="bold">왼쪽 묶음</text>
    <text color="muted" size="sm">세로로 쌓입니다</text>
  </col>
  <badge tone="info">오른쪽 끝</badge>
</row>
<divider />
<row gap={2} align="center">
  <text>앞</text>
  <spacer />
  <text>spacer가 사이를 밀어냅니다</text>
</row>`,
  },
  {
    id: "grid",
    title: "격자",
    source: `<grid columns={3} gap={2}>
  <grid-item span={2}><box border padding={3}><text>두 칸을 차지</text></box></grid-item>
  <grid-item><box border padding={3}><text>한 칸</text></box></grid-item>
  <grid-item><box border padding={3}><text>한 칸</text></box></grid-item>
  <grid-item><box border padding={3}><text>한 칸</text></box></grid-item>
  <grid-item><box border padding={3}><text>한 칸</text></box></grid-item>
</grid>`,
  },
];

const TEXT: GallerySample[] = [
  {
    id: "title-text",
    title: "제목과 본문",
    source: `<col gap={1}>
  <title size="xl">아주 큰 제목</title>
  <title size="lg">큰 제목</title>
  <title size="md">보통 제목</title>
  <title size="sm">작은 제목</title>
  <text size="lg">큰 본문</text>
  <text>보통 본문 — **굵게**, *기울임*, \`코드\`를 섞을 수 있습니다.</text>
  <text size="sm" color="muted">작고 옅은 본문</text>
  <text size="xs" weight="bold" align="end" tabular>오른쪽 정렬 1,234,567</text>
</col>`,
  },
  {
    id: "colors",
    title: "글자색",
    source: `<row gap={3} wrap>
  {#each [${quoted(COLOR_TOKENS)}] as color}
    <text color={color} weight="medium">{color}</text>
  {/each}
</row>`,
  },
  {
    id: "badge",
    title: "배지",
    source: `<row gap={2} wrap>
  {#each [${quoted(TONE_TOKENS)}] as tone}
    <badge tone={tone}>{tone}</badge>
  {/each}
</row>`,
  },
  {
    id: "callout",
    title: "알림 상자",
    source: `<col gap={2}>
  <callout tone="info" title="안내">기본은 info 톤입니다.</callout>
  <callout tone="success" icon="check">검수를 통과했습니다.</callout>
  <callout tone="warning" title="확인 필요" icon="bell">마감이 이틀 남았습니다.</callout>
  <callout tone="danger" title="실패">배포가 중단됐습니다. <link href="https://example.com/status">상태 페이지</link>를 확인하세요.</callout>
</col>`,
  },
  {
    id: "link",
    title: "링크",
    note: "http(s) 주소만 새 탭으로 열립니다.",
    source: `<text>문서는 <link href="https://example.com/docs">여기</link>에 있습니다.</text>
<link href="https://example.com/changelog">변경 내역 보기</link>`,
  },
];

const MEDIA: GallerySample[] = [
  {
    id: "icons",
    title: "아이콘",
    note: "앱이 쓰는 선 아이콘을 이름으로 부릅니다.",
    source: `<grid columns={6} gap={3}>
  {#each [${quoted(WIDGET_ICON_NAMES)}] as name}
    <grid-item>
      <col gap={1} align="center">
        <icon name={name} size="lg" />
        <text size="xs" color="muted" align="center">{name}</text>
      </col>
    </grid-item>
  {/each}
</grid>`,
  },
  {
    id: "svg",
    title: "상태를 따르는 그림",
    note: "<svg>는 값에 묶인 그림(게이지, 간단한 도식)을 그립니다.",
    source: `{@state level = 62}
{@const sweep = 251.3 * (level / 100)}
<row gap={4} wrap align="center">
  <svg viewBox="0 0 100 100" width={140} label={\`게이지 \${level}%\`}>
    <circle cx="50" cy="50" r="40" fill="none" stroke="line" stroke-width="10" />
    <circle cx="50" cy="50" r="40" fill="none" stroke={level > 80 ? "danger" : "accent"} stroke-width="10" stroke-linecap="round" stroke-dasharray={\`\${sweep} 251.3\`} transform="rotate(-90 50 50)" />
    <text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-size="20" font-weight="700">{level}%</text>
  </svg>
  <slider label="사용률" value={level} onChange={setLevel} min={0} max={100} suffix="%" />
</row>`,
  },
  {
    id: "image",
    title: "이미지",
    note: "그 대화에 있는 이미지만 그릴 수 있어서, 갤러리에서는 적는 방법만 보여 줍니다.",
    sourceOnly: true,
    source: `<image src="/api/conversations/CONVERSATION_ID/images/IMAGE_ID" alt="배포 대시보드 화면" width={480} radius="md" />`,
  },
];

const DIAGRAMS: GallerySample[] = [
  {
    id: "mermaid-flow",
    title: "흐름도",
    note: "다이어그램은 태그가 아니라 답변의 mermaid 코드 블록입니다. 소스 버튼으로 원문을 볼 수 있습니다.",
    source: `\`\`\`mermaid
flowchart LR
  A["질문 (채팅)"] --> B{"그림이 더 나은가?"}
  B -->|"예"| C["답변 본문에 다이어그램"]
  B -->|"아니오"| D["평범한 Markdown"]
\`\`\``,
  },
  {
    id: "mermaid-sequence",
    title: "순서도",
    source: `\`\`\`mermaid
sequenceDiagram
  participant U as 사용자
  participant A as 아바타
  participant T as 도구
  U->>A: 질문
  A->>T: 자료 조회
  T-->>A: 결과
  A-->>U: 본문과 UI로 답변
\`\`\``,
  },
];

const SENDING: GallerySample[] = [
  {
    id: "send",
    title: "문장 보내기",
    note: "send가 있는 버튼은 적어 둔 문장을 다음 채팅 메시지로 보냅니다. 갤러리에서는 보내지 않고 내용만 보여 줍니다.",
    source: `{@state qty = 3}
<row gap={3} wrap align="end">
  <slider label="수량" value={qty} onChange={setQty} min={1} max={10} suffix="개" />
  <button send={\`수량 \${qty}개로 주문해 줘\`} icon="send">이대로 주문</button>
</row>`,
  },
  {
    id: "submit",
    title: "값 묶어 보내기",
    note: "<submit>은 버튼 이름과 값을 구조화해서 다음 메시지로 보냅니다.",
    source: `{@state amount = 3000}
{@state months = 24}
<box border padding={3} gap={3}>
  <row gap={3} wrap>
    <slider label="금액" value={amount} onChange={setAmount} min={500} max={10000} step={500} suffix="만원" />
    <slider label="기간" value={months} onChange={setMonths} min={6} max={60} step={6} suffix="개월" />
  </row>
  <submit values={{ amount, months }}>이 조건으로 진행</submit>
</box>`,
  },
  {
    id: "href",
    title: "주소 열기",
    source: `<button href="https://example.com/docs" variant="secondary" icon="globe">문서 열기</button>`,
  },
];

export const UI_GALLERY: readonly GallerySection[] = Object.freeze([
  { id: "charts", title: "차트", intro: "data만 넘기는 간단한 형식 다섯 가지와 Vega-Lite 스펙. 차트가 처음 나타날 때 등장 효과가 재생됩니다.", samples: CHARTS },
  { id: "data", title: "지표와 데이터", intro: "숫자와 표를 보여 주는 컴포넌트입니다.", samples: DATA },
  { id: "inputs", title: "입력과 상태", intro: "보는 사람이 값을 바꾸면 그 자리에서 다시 계산됩니다. 아바타는 호출되지 않습니다.", samples: INPUTS },
  { id: "layout", title: "레이아웃", intro: "다른 컴포넌트를 담고 배치합니다.", samples: LAYOUT },
  { id: "text", title: "글자", intro: "제목, 본문, 배지, 알림 상자, 링크.", samples: TEXT },
  { id: "media", title: "아이콘과 그림", intro: "앱의 아이콘, 직접 그리는 SVG, 대화의 이미지.", samples: MEDIA },
  { id: "diagrams", title: "다이어그램", intro: "mermaid 코드 블록은 답변 안에서 그림으로 그려집니다.", samples: DIAGRAMS },
  { id: "sending", title: "아바타에게 보내기", intro: "누르기 전에 무엇을 할지 보이는 버튼만 아바타에게 닿습니다.", samples: SENDING },
]);

/** A sample's source as a Markdown code block (a fence longer than any the source holds). */
export function gallerySourceMarkdown(source: string): string {
  let fence = "```";
  while (source.includes(fence)) fence += "`";
  return `${fence}text\n${source}\n${fence}`;
}
