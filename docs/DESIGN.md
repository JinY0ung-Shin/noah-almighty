# 디자인 철학 — Noah Almighty

이 문서는 Svelte 프론트엔드(`src/client/`)의 **시각 언어 기준**이다.
새 UI를 만들거나 기존 UI를 고칠 때 여기 정의된 토큰·규칙을 따른다. 어긋난 곳을
발견하면 이 문서 쪽으로 수렴시킨다(즉석 새 값 도입 금지).

기본 토큰과 구조는 `00-tokens.css`, Apple-inspired 시각·동작 계층은
`80-apple-design.css`가 담당한다. 도메인 레이아웃은 중간 계층 파일에 남기고, 재질·모션·접근성은
마지막 계층으로 수렴시킨다.

---

## 1. 성격 (Personality)

**차분하고 유동적인 에이전트 작업 공간.** Apple의 인터페이스 원칙을 웹에 맞게 적용하되
macOS 화면을 복제하지 않는다. 콘텐츠(대화·지식·작업)가 주인공이고 UI는 맥락과 상태를
명확히 전달한 뒤 뒤로 물러난다.

- **중립톤이 바탕, system blue는 행동과 선택에만.** 넓은 면을 액센트로 채우지 않는다.
- **재질로 위계를 표현한다.** 사이드바·헤더·컴포저·시트는 반투명 material, 읽기 콘텐츠는
  불투명 표면을 기본으로 한다. 유리 표면을 겹쳐 가독성을 떨어뜨리지 않는다.
- **모션은 현재 화면 값에서 이어진다.** 눌림은 pointer-down에 즉시 반응하고, 제스처 기반
  요소는 손가락을 1:1 추적하며 release velocity를 스프링으로 넘긴다.
- **접근성은 동일한 피드백의 다른 표현이다.** reduced motion은 cross-fade,
  reduced transparency는 불투명 표면, increased contrast는 강한 경계로 대체한다.
- **장식보다 위계.** 대비·여백·타이포 weight로 정보 위계를 만든다. 박스·배경색·아이콘을
  덧대서 위계를 만들지 않는다.

이 성격이 색·재질·여백·타이포·동작의 판단 기준이다. 판단이 갈리면 더 예측 가능하고
덜 장식적인 쪽을 택한다.

---

## 2. 토큰 (Tokens) — 단일 진실 공급원

재사용되는 값은 `:root` 토큰을 거친다. 새 시맨틱 색·재질·모션 값은 즉석 도입하지 않는다.
기능적인 단일 크기와 오프셋은 컴포넌트 안에서 의도를 설명한 경우 허용한다.
**토큰 정의는 `00-tokens.css`가 단일 출처다 — 라운드·그림자·이징 포함.** `80-apple-design.css`에서
같은 토큰을 재정의하지 않는다(과거 이중 정의로 00 쪽 값이 전부 죽은 값이 된 사고가 있었고,
2026-08에 단일화했다 — 해당 위치에 "재정의 금지" 주석이 있다). Apple 계층 **전용** 값과
`[data-theme="dark"]` 변형만 `80-apple-design.css`에 둔다.

### 2.1 색 (Color)
- **뉴트럴 램프** `--n-0 … --n-900`: 모든 회색/배경/텍스트의 출처.
- **시맨틱 별칭** `--bg / --panel / --text / --text-soft / --muted / --line / --line-soft`:
  컴포넌트는 `--n-*` 원시값이 아니라 **시맨틱 별칭**을 쓴다(다크모드가 별칭만 스왑하면 되도록).
- **액센트** `--accent / --accent-strong / --accent-soft / --accent-ring`은 system blue 계열이다.
  액센트 면 위 텍스트/아이콘은 **반드시 `--on-accent`**를 사용한다. 색상 모드별 대비를
  확보하기 위해 light는 흰색, 밝은 accent를 쓰는 dark는 검은색으로 전환되므로 `#fff` 직접 사용 금지.
- **포커스 표시**는 반투명 glow인 `--accent-ring`과 구분해, 인접 표면 대비 3:1 이상인
  불투명 `--focus-ring`을 사용한다. 구현은 **전역 `:focus-visible` 아웃라인 하나**(80 계층)로
  통일한다 — 컴포넌트에서 `outline: none`으로 끄거나 `box-shadow` 링을 새로 만들지 않는다.
  래퍼에 위임하는 입력(컴포저 등)은 래퍼가 같은 아웃라인을 받고, 리사이즈 그립류는
  `:focus-visible`에서 그립을 `--focus-ring`으로 칠한다(`.routine-splitter` 패턴).
- **상태색** `--warn / --danger / --ok / --info` (+ `-soft` / `-line` / `--on-danger`).
- **활성 컨트롤** `--control-on`: 토글처럼 성공 상태가 아니라 켜짐 상태를 나타내는 플랫폼 green.
- **재질** `--material-thin / --material-regular / --material-thick`: 크롬의 깊이에 맞춰 사용한다.
- **레일(rail)** 전용 `--rail*`: 좌측 네비게이션의 반투명 표면. 다른 곳에 쓰지 않는다
  (`.icon-button`은 시맨틱 토큰 기본 + `.rail .icon-button` 오버라이드로 분리돼 있다).
- **고정 표면/전경** (테마 무관 상수 — 각 정의에 이유 주석): `--code-*`(코드블록),
  `--diagram-bg / --diagram-line`(drawio·슬라이드 프리뷰 — 흰 원본 위 고정 테두리),
  `--on-avatar`(생성 그라디언트 위 흰 글자), `--on-scrim`(검정 스크림 위 흰 글리프),
  `--control-knob`(토글 노브 플랫폼 화이트).
- **비활성 상태** `--disabled-opacity`(0.46) 단일 토큰 + cursor는 의미로 구분:
  사용 불가 = `not-allowed`, 진행 중 비활성 = `progress`(의도적 `opacity: 1` busy 상태 3곳은 유지).

허용되는 하드코딩: ① `50%`(원형), ② `rgba(255,255,255,α)`/`rgba(0,0,0,α)` 같은
*반투명 오버레이*(스크림·하이라이트)는 토큰화하기 애매하면 인라인 허용하되 한 곳에 모은다.
**`#4ade80`(→`--ok`), `#f87171`(→`--danger`) 같은 의미색 하드코딩은 금지** — 토큰으로 교체.

### 2.2 간격 (Spacing) — 4px 베이스
8px 엄격 스케일은 실사용에서 거부됨(6/10px이 압도적). **4px 베이스로 재정의**해 현실을 흡수한다.
기존 `--s-1 … --s-8`은 그대로 두고(하위호환) 반-스텝을 신설한다:

```
--s-0-5: 2px    /* 신설: 현 2px×33 흡수 (hairline gap) */
--s-1:   4px
--s-1-5: 6px    /* 신설: 현 6px×27 흡수 */
--s-2:   8px
--s-2-5: 10px   /* 신설: 현 10px×28 흡수 */
--s-3:   12px
--s-4:   16px
--s-5:   24px
--s-6:   32px
--s-7:   48px
--s-8:   64px
```

- 모든 `padding / margin / gap`은 이 토큰만 쓴다. **스텝 밖 값(`5/7/9/11/13/14px` 등)은
  가장 가까운 토큰으로 반올림**(동점은 큰 쪽 — 예: 14px→`--s-4`(16)). 7px→`--s-2`(8),
  9px→`--s-2-5`(10), 11px→`--s-3`(12).
- **예외(토큰화 안 함):** `1px` hairline gap(세그먼트/표 구분선의 픽셀 스냅), 음수 nudge
  (`-1px`/`-4px` 오버랩), 기능적 오프셋(`padding-right: 44px` = 토글 버튼 폭), `clamp()`/`env()`.
  `1px`은 간격이 아니라 보더 두께이기도 하다.

### 2.3 라운드 (Radius)
```
--r-sm: 10px    /* 작은 컨트롤·칩 */
--r-md: 12px    /* 기본 컨트롤·카드 */
--r-lg: 16px    /* 큰 카드·패널 */
--r-xl: 22px    /* 모달·시트 */
--r-pill: 999px /* 토글·세그먼트·칩·배지 */
```
`--r-xs(8px)`는 조밀한 코드/메타 컨트롤에만 사용한다. 일반 입력과 버튼은 `--r-md`,
콘텐츠 패널은 `--r-lg`, 모달·시트는 `--r-xl`을 사용한다.

### 2.4 타이포 (Typography)
```
--t-xs: 12px   --t-sm: 13px   --t-base: 14px   --t-md: 15px
--t-lg: 18px   --t-xl: 22px   --t-2xl: 28px
```
- **`font-size`는 토큰만.** 가독성 하한은 **`--t-2xs`(11px)** — 그 아래로 내려가지 않는다
  (`9px/10px` 메타 텍스트는 `--t-2xs`로 흡수). `16px`→`--t-md`(15).
  **예외:** `.md` 산문 스케일(h1~h4·인라인 코드 등)은 읽기 맥락에 상대적인 `em`을 의도적으로
  유지한다(`30-agent-md-composer.css`의 결정 주석 참조).
- **weight는 3단만:** `400`(본문) / `600`(강조·라벨·버튼) / `700`(제목). `500`은 600으로 흡수.
- 본문 `line-height`는 채팅 가독 영역 1.6, UI 라벨 1.2~1.3.

### 2.5 그림자 (Shadow) / 모션
- `--shadow-sm`(살짝 뜬 카드) / `--shadow-md`(팝오버·드롭다운) / `--shadow-lg`(모달·시트) /
  `--shadow-drawer`(레일). **인라인 box-shadow 금지** (리셋용 `none`·키프레임 제외).
  **carve-out:** `80-apple-design.css`의 재질 계층(인셋 엣지 하이라이트·액센트 글로우·노브 섀도)은
  디자인 레이어 자신의 어휘로 인라인을 허용한다 — 컴포넌트와 중간 레이어(10~70)는 여전히 금지.
- 비제스처 전환은 `--ease-out`을 기본으로 120~240ms 범위에서 사용한다. `--ease`는 제스처
  핸드오프 전용으로 예약돼 있다(현재 CSS 사용처 0 — 제스처는 JS 스프링이 담당).
- 드로어·시트·직접 조작 요소는 고정 duration 대신 스프링을 사용한다. 기본은 damping ratio
  `1.0`, response `0.3~0.4s`; 사용자의 flick momentum이 있을 때만 damping `~0.8`을 허용한다.
- transform/opacity 중심으로 합성하고 진행 중인 모션도 다시 잡고 반전할 수 있어야 한다.

---

## 3. 밀도 (Density) — 화면별 차등

밀도는 전역이 아니라 **화면 컨텍스트별**로 다르다. 뷰 컨테이너에 밀도 토큰을 세팅하고
하위 컴포넌트는 그 토큰을 참조한다(같은 컴포넌트가 화면 따라 자연스럽게 조밀/여유 전환).

| 화면 | 성격 | 기본값 |
|---|---|---|
| **채팅** (`.chat-col`) | 촘촘 — 메시지 많이, 시선 흐름 | row gap `--s-2`, 카드 패딩 `--s-3`, line-height 1.6 |
| **탐색** (explore) | 보통 | 카드 패딩 `--s-5`(Apple 계층의 컴포트 사이징을 값 보존으로 기록), 그리드 gap `--s-4` |
| **설정** (settings) | 여유 — 읽기·입력 편함 | 카드 패딩 `--s-5`, 필드 간 `--s-4`, 섹션 간 `--s-6` |
| **관리자** (admin) | 컴팩트 — 표 형태 정보 밀집 | 행 패딩 `--s-2-5`, 행 간 `--s-1-5` |

구현 권장: 뷰 루트에 밀도 변수를 선언.
```css
.chat-col   { --pad-card: var(--s-3); --gap-stack: var(--s-2); }
.settings   { --pad-card: var(--s-5); --gap-stack: var(--s-4); }
.admin-tab  { --pad-card: var(--s-2-5); --gap-stack: var(--s-1-5); }
/* 공용 카드 */
.card { padding: var(--pad-card, var(--s-4)); }
```
밀도는 **간격으로만** 조절한다. 색·라운드·타이포 스케일은 화면 무관하게 동일.

실제 배선(2026-08 완료): `.chat-col`(20-shell-chat), `.avatar-grid`(50-platform-views),
`.settings-body`·`.admin-list`(60-settings-admin), `.routines-body`(50). 소비자:
`.settings-card` / `.admin-row` / `.routine-pane` / `.avatar-card`.

---

## 4. 컴포넌트 규칙 (통합 대상)

현재 가장 일관성이 낮은 4영역. 신규는 아래 규칙으로 만들고, 기존은 점진 수렴.

### 4.1 버튼 — 하나의 패밀리 (✅ 2026-08 구축 완료)
`.btn` 베이스 + variant + size가 `30-agent-md-composer.css`에 실존하고, 레거시 이름은
**같은 규칙 집합을 공유하는 진짜 alias**다(복사본이 아니라 그룹 셀렉터).

```
.btn                      /* 베이스(md) — 단독 사용 가능: 정렬·패딩·라운드 포함 */
.btn.primary              /* ≡ .primary ≡ .btn-primary — accent 채움 (+ --on-accent), 화면당 1개 권장 */
.btn.secondary            /* panel + 1px line */
.btn.ghost                /* ≡ .btn-ghost — 투명, hover는 80 계층 공용 목록 */
.btn.danger               /* danger 토큰 (.ghost-sm.danger 계열과 병합) */
.btn.link                 /* ≡ .linkish — 텍스트 링크형(패딩 0) */
  + size: .btn.sm (≡ .btn-sm; .ghost-sm은 ghost+sm 결합 alias) / (기본=md) / .btn.lg
  + .btn.icon(40px) / .btn.icon.sm(28px)
```
- **아이콘 버튼 3계층: 40(크롬) / 32(필드 내장 — `.password-toggle` 등, 주석 참조) / 28(인라인
  컴팩트 — `.msg-act` 등).** 38px는 퇴역(38→40 통일 완료), 26/30px은 28로 수렴.
- `.small`은 텍스트 span에도 쓰이는 클래스라 사이즈 alias 그룹에 넣지 않았다(전용 규칙 유지).
- `.btn` 패밀리는 `<a>`(다운로드 링크)에도 쓴다 — 베이스가 UA 밑줄을 지우므로(`text-decoration: none`)
  `a.btn`과 `button.btn`은 같게 보인다.
- 세그먼트 컨트롤(`.seg-control`/`.seg-btn`)은 버튼이 아니라 **선택 컨트롤**로 별도 유지(아래 4.3).
- 마크업의 레거시 클래스명은 alias 덕에 시각적으로 이미 통일 — **개명은 해당 파일을 만질 때
  점진적으로**(`.primary`→`.btn.primary` 등, 백로그 참조). 신규 코드는 `.btn` 계열로 작성.

### 4.2 카드 — 의도로 네이밍
맥락 네이밍(`.prompt-card`/`.admin-row`/`.avatar-card`)을 **의도 네이밍 베이스 + 도메인 모디파이어**로.

```
.card             /* 베이스: var(--panel) + 1px var(--line-soft) + var(--r-lg) + padding(밀도토큰) */
.card.elevated    /* + var(--shadow-sm) — "떠 있는" 카드만 */
.card.flat        /* 보더 없음, 배경만 */
```
(✅ 2026-08) `.card`/`.elevated`/`.flat`이 `80-apple-design.css`에 **독립 베이스**로 실존한다 —
베이스는 그림자 없는 FLAT이고 elevation은 `.elevated` 옵트인. 베이스 라운드는 **`--r-lg`**
(초기 스펙의 `--r-sm`은 기존 카드 0개와 일치해 정정). 기존 도메인 카드 목록(surface list)은
호환용으로 유지하되, **신규 카드는 명단을 편집하지 말고 `class="card …"`로 베이스를 조합**한다.
도메인 카드는 `.card.avatar-card`처럼 베이스를 붙여 표면 처리를 상속. **elevation은 의도가
"떠 있음"일 때만** 부여. (참고: `.admin-row`는 이미 떠 있는 `.admin-user` 카드 안의 평평한
행이라 목록에 넣지 않는다.)

### 4.3 칩/배지/태그
베이스 `.tag`는 이미 정의돼 있다(border + `--r-pill` + `--s-0-5 --s-2-5` 패딩 + `--t-2xs` +
`--muted`). 변주는 `.tag.accent / .read / .write / .mono`. **bare `.tag`만 써도 읽히는 기본
모양이 나온다** — 이 성질을 유지한다.

- 새 칩/배지는 반드시 `.tag` 베이스를 깔고 색/형태 모디파이어만 추가(독자 패딩·라운드 재정의 금지).
- 인풋형 칩(해시태그·플러그인·요일 선택 등)도 `.tag` 위에 인터랙션(삭제·토글)만 얹는다.

### 4.4 오버레이 — 공유 베이스
모달/드로어/팝오버/토스트가 각자 z-index·backdrop·블러를 구현 중 → **z-index 스케일과
backdrop을 토큰·베이스로 통일.**

```
--z-rail: 30   --z-popover: 40   --z-toast: 90   --z-modal: 100   --z-prompt: 110
.overlay            /* fixed inset 0 + var(--scrim) backdrop — .modal-overlay와 동일 규칙 공유 */
.popover            /* absolute, --shadow-md, 트리거 기준 */
```
신규 오버레이는 위 z-index 토큰을 쓴다(즉석 숫자 금지). `--z-prompt`는 권한/질문 프롬프트가
모달·토스트 위에서 응답 가능해야 해서 최상위다.

- **같은 `--z-modal` 층의 우선순위는 `App.svelte`의 DOM 순서가 결정한다(load-bearing):**
  `Shell → OnboardingModal → WhatsNewModal → PromptModal → Toasts → ConfirmationDialog`.
  ConfirmationDialog가 마지막이어야 다른 모달 위에서 확인창이 그려진다 — 순서를 바꾸지 말 것.
- **닫기 관례:** 모달은 푸터 액션(확인/취소)으로 닫는 것이 기본이고 Escape/백드롭은
  `Modal.svelte` 베이스가 처리한다. 전체화면 뷰어(그래프·캔버스)는 명시적 닫기 컨트롤을 둔다.
  권한 게이트(PromptModal)는 **Escape=거부**, 백드롭 닫기 없음(의도적 — 묵시 해제 금지).

---

## 5. 적용 현황 (Migration status)

**프론트는 런타임 검증이 약하니**(브라우저 없음, `node --check`만) 한 묶음씩 작게,
사람이 브라우저로 스모크 테스트하며 진행한다.

**✅ 완료:**
1. **토큰 추가** — `--s-0-5/--s-1-5/--s-2-5`, `--t-2xs`, z-index(`--z-*`), 코드블록(`--code-*`),
   `--mono`, 미정의였던 `--bg-subtle/--surface-2`를 `:root`에 정의.
2. **의미색·하드코딩 정리** — 코드블록 색을 `--code-*`로 토큰화(다크/라이트 고정 표면이라
   `--ok/--danger`로 매핑하지 **않음**). 미정의 토큰 버그 수정: `--text-muted`→`--muted`,
   `--focus`→`--accent`.
3. **px 토큰화** — 간격/라운드/폰트 187곳을 토큰으로. 값-보존 치환이 대부분이고,
   스텝 밖 ~50곳만 가장 가까운 토큰으로 반올림(±1–2px). hairline `1px`·`44px` 오프셋·
   `clamp`/`env`는 예외로 보존.
4. **밀도 토큰** — `--pad-card/--gap-stack`을 `:root`(comfortable)에 정의하고 `.admin-list`
   (compact)에서 override. `.settings-card`/`.admin-row`가 이를 소비. **현 시각 결과는 동일**
   (override 값=기존 값)이라, 화면별 밀도를 더 벌리고 싶으면 이 토큰만 조정하면 된다.

5. **Apple-inspired 계층** — system blue, platform typography, material hierarchy, 전체 화면 surface,
   press feedback, modal/popover materialization을 `80-apple-design.css`에서 제공한다.
6. **접근성 재질 변형** — reduced motion/transparency와 increased contrast를 지원한다.
7. **확인 흐름 통합** — 브라우저 기본 confirm 대신 공용 `ConfirmationDialog`를 사용한다.
8. **직접 조작** — 모바일 레일은 pointer capture, rubber-banding, velocity projection, spring settle을 사용한다.
9. **일관성 일제 수정(2026-08-04)** — 5축 감사(색·토큰 / 간격·타이포 / 컴포넌트 / 언어 / 인터랙션)
   전 항목 반영: 미정의 토큰 해소(`--ok-soft`/`--ok-line` 신설, `--mono`→`--font-mono`,
   `--text-muted`→`--muted` 재수정), **라운드·그림자·이징 단일 출처화**(00-tokens.css 캐노니컬,
   80 재정의 삭제), **포커스 링 일원화**(전역 `:focus-visible` + `--focus-ring`, 레거시
   `--accent-ring` box-shadow 링 전량 제거, `prefers-contrast`에 `--focus-ring` 부스트),
   **§4.1 버튼 패밀리 구축 + 레거시 alias**, `.card`/`.overlay` 베이스, `.tag` alias
   (`.meta-badge`/`.plugin-chip`), 밀도 토큰 4개 화면 배선, 모션 수렴(120–240ms·`--ease-out`,
   토글 노브 180ms), disabled `--disabled-opacity` 토큰화, 라이트 레일 hover 복구(흰 오버레이
   3곳 → `--rail-active`), drawio/슬라이드 고정 표면 토큰, GraphCanvas/Vega **테마 토글 반응성**,
   **PromptModal·canvas-fs 포커스 관리**(트랩·inert·Escape=거부, `lib/modalBehavior.ts` 공유),
   에러 경로 한국어화(`uiReason` 채널, 검증 메시지 ~30건, SDK 도구명 라벨 매핑),
   용어 통일(그룹 에이전트·그룹원·외부 아바타·공개 범위·주소 등)과 어조 outlier 정리.

레거시 버튼/칩 클래스는 §4 베이스와 **같은 규칙을 공유하는 alias**다(2026-08부터 실제로 그렇다).
새 컴포넌트는 §4 베이스 패밀리를 사용하고, 기존 화면의 클래스명 개명은 기능 변경 시 점진 수렴.

> ⚠️ 1차 패스의 반올림(~50곳)은 픽셀이 ±1–2px 바뀐다(라운드 일부는 더). 브라우저에서
> 채팅/탐색/설정/관리자를 라이트·다크 양쪽으로 한 번 훑어 확인 권장.

---

## 6. 체크리스트 (PR 셀프리뷰)

- [ ] 새 hex/rgba 없음 (시맨틱 토큰 또는 `--n-*` 사용, 액센트 면엔 `--on-accent`, 고정
  표면엔 `--code-*`/`--diagram-*`/`--on-avatar`/`--on-scrim` 계열)
- [ ] 새 px 간격/라운드/폰트 없음 (`--s-*` / `--r-*` / `--t-*`)
- [ ] 인라인 box-shadow 없음 (`--shadow-*`; 80 계층 재질만 예외)
- [ ] `outline: none` 없음 — 전역 `:focus-visible`이 유일한 포커스 링(래퍼 위임 시 래퍼에 아웃라인)
- [ ] disabled는 `--disabled-opacity` + 의미에 맞는 cursor (`not-allowed`/`progress`)
- [ ] system blue 면을 크게 칠하지 않음 (액센트는 행동·상태에만)
- [ ] material을 중첩하지 않고 크기·역할에 맞는 blur/shadow를 사용
- [ ] 버튼/칩/카드/오버레이는 §4 베이스 패밀리 사용 (새 일회성 클래스 지양)
- [ ] 밀도는 화면 컨텍스트 토큰으로 (하드코딩 패딩 금지)
- [ ] `prefers-color-scheme: dark`에서 확인 (별칭 스왑만으로 동작하는지)
- [ ] reduced motion/transparency와 increased contrast에서 의미와 조작성이 유지되는지 확인
