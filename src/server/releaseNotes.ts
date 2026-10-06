/**
 * Registry of user-facing release notes, newest first (#whats-new). When a user
 * first loads the app after a deploy whose latest entry they haven't seen
 * (`users.last_seen_release`), the client shows a one-time "새로운 기능" dialog
 * listing what changed, then marks the latest entry seen via
 * `PUT /api/me/seen-release`.
 *
 * Maintenance: when deploying user-visible changes, PREPEND a new entry with a
 * fresh `id`. Ids are date-based (`YYYY-MM-DD`; suffix `.2` for a same-day
 * second release) and must stay unique — ordering comes from array position,
 * never from parsing the id. Entries may be pruned from the tail; a user whose
 * stored id is unknown (pruned, or a rollback) is treated like a first-timer
 * and sees the latest entries once more, which self-heals on dismiss — the
 * alternative (showing nothing) would silence every future note for them.
 *
 * `items` are shown verbatim to users, so they are KOREAN (language split:
 * user-facing strings are Korean). This module is intentionally dependency-free
 * so it can be imported by BOTH the server and the Svelte client (it is listed
 * in `tsconfig.client.json` includes), mirroring `experimentalFeatures.ts`.
 */
/**
 * In-app deep link a note item can offer (rendered as a button under the
 * item). Resolved by the CLIENT (WhatsNewModal maps the id to a label and a
 * navigation); an id a build doesn't know renders nothing, so an older client
 * showing a newer note degrades gracefully. This module stays dependency-free,
 * hence ids instead of callbacks.
 */
export type ReleaseNoteAction = "browser-guide";

export interface ReleaseNoteItem {
  /** User-facing feature name (Korean). */
  title: string;
  /** User-facing one-line description (Korean). */
  body: string;
  /** Optional usage example (Korean) — rendered as a highlighted hint line. */
  example?: string;
  /** Optional in-app deep link (see ReleaseNoteAction). */
  action?: ReleaseNoteAction;
}

export interface ReleaseNote {
  /** Stable release id, e.g. "2026-07-29". Unique; newest entry sits first. */
  id: string;
  /** What changed in this release (Korean, shown as a list). */
  items: ReleaseNoteItem[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "2026-10-06",
    items: [
      {
        title: "비주얼 캔버스가 정식 기능이 됐어요",
        body: "이제 따로 켜지 않아도 아바타가 차트·다이어그램·화면 목업을 대화 오른쪽 패널에 띄우고, 버튼이나 입력으로 함께 다듬을 수 있어요. HTML 목업은 디자인이 그대로 보이면서 앱 화면에는 영향을 주지 않고, 순서도 같은 다이어그램의 글자가 비어 보이던 문제도 고쳤어요. 쓰고 싶지 않은 대화에서는 입력창의 'MCP 도구'에서 캔버스를 끄면 돼요.",
        example: "예: “로그인 화면 목업을 두 가지 버전으로 캔버스에 보여 줘.”",
      },
      {
        title: "앞선 메시지를 고쳐서 거기서부터 다시 이어가요",
        body: "이전에 보낸 메시지의 '편집'을 눌러 내용을 바꿔 보내면, 확인을 거쳐 그 메시지 이후의 대화가 고친 내용과 새 답변으로 바뀌어요. 아바타는 그 시점까지의 맥락을 도구 결과까지 그대로 기억해요. '다시 생성'도 같은 방식으로 동작하고, 이미 만든 파일이나 커밋 같은 작업 결과는 되돌리지 않아요.",
        example: "예: 앞선 질문의 '편집'에서 조건을 바꿔 다시 보내 보세요.",
      },
      {
        title: "/compact로 긴 대화를 요약해 맥락을 정리해요",
        body: "입력창에 /compact를 보내면 지금까지의 대화를 요약해 아바타가 기억하는 맥락을 줄여요. 뒤에 남길 내용을 덧붙일 수 있고, 맥락이 얼마나 줄었는지 답변에서 알려줘요.",
        example: "예: “/compact 결정된 사항과 남은 할 일 위주로”",
      },
      {
        title: "보여 준 이미지를 PPT·문서에 그대로 넣어요",
        body: "첨부한 이미지, 브라우저 스크린샷, Confluence 첨부 이미지를 아바타가 파일로도 받아 PPT나 문서에 직접 넣을 수 있어요. PPT를 만들 때는 슬라이드마다 쓸 그림과 출처를 먼저 정하고, 사진 위에 올린 글자도 읽기 좋게 맞춰요.",
        example: "예: 화면 캡처를 첨부하고 “이 화면으로 사용 안내 PPT 5장 만들어 줘.”",
      },
    ],
  },
  {
    id: "2026-09-29",
    items: [
      {
        title: "PowerPoint에서 바로 고칠 수 있는 PPT를 만들어요",
        body: "아바타가 만든 PPT의 글상자·도형·표·차트가 모두 PowerPoint 개체라 그대로 고칠 수 있어요(차트는 데이터 편집까지). 주제에 맞는 6가지 테마, 화면에 띄우는 발표형 구성, 사진만 끼우면 되는 사진 칸, 회사 색으로 만든 테마도 쓸 수 있어요.",
        example: "예: “우리 팀 3분기 실적을 발표용 PPT 8장으로 만들어 줘. 색은 #0B6E4F로.”",
      },
      {
        title: "PPT를 만들기 전에 한 번만 묻고, 슬라이드별로 고쳐 줘요",
        body: "새 PPT의 테마·분량·용도(보고서형/발표형)가 정해지지 않았으면 한 번만 골라 달라고 물어봐요. 완성본은 바로 받을 수 있고, 슬라이드마다 수정 요청을 적어 보내면 한 번에 반영해 다시 만들어 줘요. 발표자 노트에는 실제로 말할 원고가 들어가요.",
      },
      {
        title: "PPT를 링크로 공유해요",
        body: "PPT 파일 카드 옆 '공유 링크' 버튼을 누르거나 아바타에게 링크를 부탁하세요. 링크를 받은 Noah 사용자는 로그인해서 슬라이드를 넘겨 보거나 전체 화면으로 발표하고, 파일도 내려받을 수 있어요. 유효 기간은 1·7·30일(기본 7일)이고, 내 아바타 → 권한·연결 → 공유 링크에서 언제든 해제할 수 있어요.",
        example: "예: “방금 만든 PPT, 팀원들이 볼 수 있게 공유 링크 만들어 줘.”",
      },
      {
        title: "아바타가 일하는 중에도 메시지를 보낼 수 있어요",
        body: "응답이 끝나기를 기다리지 않고 추가 지시를 보내면 진행 중인 작업에 이어서 반영돼요. 보낸 메시지는 '전달 대기 중'에서 '응답 중 전달'로 바뀌어 보여요.",
        example: "예: 긴 작업 도중에 “표는 빼고 요약만 해 줘”라고 보내 보세요.",
      },
      {
        title: "동료와 바로 메시지를 주고받아요",
        body: "화면 오른쪽 아래 '메시지'에서 다른 사용자에게 바로 메시지를 보낼 수 있어요. 상대가 접속 중인지 보이고, 읽으면 '읽음'으로 알려줘요.",
      },
      {
        title: "다른 시스템이 내 아바타에게 일을 맡겨요 (외부 작업 API)",
        body: "내 아바타 → 권한·연결 → 외부 작업 API에서 개인 API 키를 발급하면, 장애 알림 같은 외부 시스템이 내 메인 아바타에게 작업을 요청하고 결과를 받아갈 수 있어요. 키는 로그인한 나와 같은 권한이라 비밀번호처럼 보관해야 해요.",
      },
      {
        title: "저장한 비밀번호를 이름으로 입력해요 (브라우저 입력)",
        body: "권한·연결에서 시크릿마다 '브라우저 입력'을 켜고 허용 사이트를 정하면, 아바타가 로그인 창에 비밀번호를 이름으로 넣어요. 아바타는 값을 보지 못하고, 브라우저에서 한 번 승인하면 돼요. 새 확장(0.28)으로 업데이트하면 쓸 수 있어요.",
        action: "browser-guide",
      },
      {
        title: "더 똑똑해진 아바타, 여러 일도 동시에",
        body: "Opus 모델이 Opus 5.5로 올라갔어요. 선택지로 묻는 창과 계획 승인 단계가 다시 동작하고, 여러 보조 에이전트가 함께 일하면 카드로 묶여 보여요. 같은 시각의 예약 작업도 이제 동시에 실행돼요.",
      },
    ],
  },
  {
    id: "2026-08-28",
    items: [
      {
        title: "말로 입력할 수 있어요 (음성 입력)",
        body: "입력창의 마이크 버튼(또는 Alt+M)으로 말하면 텍스트로 바뀌어 입력돼요. 말을 멈추면 자동으로 인식을 마치고, 한국어를 우선 인식해요. 서버에 음성 엔진이 연결된 경우에 보여요.",
        example: "예: 입력창에서 Alt+M을 누르고 “오늘 회의록 정리해 줘”라고 말해 보세요.",
      },
      {
        title: "내 봇 — 나만의 보조 봇을 여러 개 만들어요 (관리자 미리보기)",
        body: "메인 아바타와 별도로, 역할을 정한 개인 봇을 여러 개 만들 수 있어요. 봇에게 작업을 맡기면 '봇 오피스'에서 진행 상황과 보고를 확인할 수 있고, 봇별 메모리·스킬·루틴도 따로 관리돼요. 지금은 관리자 계정에 먼저 열려 있어요.",
        example: "예: 아바타에게 “회의록 정리 전용 봇 만들어 줘”라고 말해 보세요.",
      },
      {
        title: "아바타가 로그인 세션이 필요한 작업까지 해요 (사이트별 승인)",
        body: "작업에 꼭 필요할 때 아바타가 현재 탭의 쿠키나 localStorage/sessionStorage를 읽을 수 있어요. 사이트·항목 종류별로 브라우저에 승인 팝업이 뜨고, 허용은 브라우저를 닫으면 사라져요. 확장 설정에서 언제든 취소할 수 있어요.",
        action: "browser-guide",
      },
      {
        title: "긴 글 붙여넣기·대화상자 감지 — 브라우저 작업이 더 안정적이에요",
        body: "아바타가 긴 본문(수 KB)을 편집기에 넣을 때 클립보드 붙여넣기로 통째로 넣어 유실이 없어요. 페이지를 가리는 알림창(alert 등)이 떠 있으면 그 사실을 감지해 안내하고, 반복 요소가 많은 페이지도 화면 요약이 훨씬 깔끔해졌어요. 새 확장(0.24.0) 업데이트로 적용돼요.",
        example: "예: “이 초안 전체를 컨플루언스 본문에 붙여넣어 줘.”",
        action: "browser-guide",
      },
      {
        title: "아바타가 브라우저에서 뭘 만지는지 눈에 보여요",
        body: "아바타가 클릭하거나 입력하는 요소 위에 상자가 그려져 어디를 조작 중인지 실시간으로 볼 수 있어요. 확장 팝업의 'uid 맵'으로는 아바타가 보고 있는 요소 지도를 확인할 수 있어요.",
      },
      {
        title: "처음 오셨나요? 가이드 투어로 시작해요",
        body: "탐색 화면의 '시작하기' 체크리스트가 설정 진행 상황을 보여주고, /tour 명령이나 환영 안내에서 시나리오별 가이드 투어를 실행할 수 있어요. 환영 안내는 설정에서 다시 열 수 있어요.",
        example: "예: 채팅창에 “/tour”라고 입력해 보세요.",
      },
      {
        title: "긴 작업이 더 잘 보이고, 끊겨도 이어져요",
        body: "실행 중인 대화에 배지가 붙고, 네트워크가 끊겨도 진행 중인 작업 화면이 자동으로 다시 연결돼요. 대화가 길어져 요약이 일어나면 그 사실도 알려줘요.",
      },
    ],
  },
  {
    id: "2026-08-10",
    items: [
      {
        title: "아바타가 이미지를 페이지에 직접 붙여넣어요",
        body: "업로드 버튼이 없는 편집기(예: Confluence 본문)에도 이미지를 넣을 수 있어요. 아바타가 이미지를 클립보드로 복사한 뒤 대상 페이지에 붙여넣고, 복사가 정말 됐는지 확인한 다음에만 진행해요. 새 확장(0.19.0)으로 업데이트하면 별도 설정 없이 동작해요.",
        example: "예: “방금 만든 차트 이미지를 컨플루언스 페이지 본문에 붙여넣어 줘.”",
        action: "browser-guide",
      },
      {
        title: "스킬 폴더 이름을 바꿔도 공유가 이어져요",
        body: "공유 중인 스킬의 폴더 이름을 바꾸면 공유 카드·전수 이력·소개 문구가 새 이름을 그대로 따라가요. 전수받은 동료의 '업데이트 받기'도 계속 동작해요. 폴더를 지우면 예전처럼 공유가 즉시 해제돼요.",
      },
      {
        title: "공유 스킬 카드에 파일 목록과 소개 문구가 생겼어요",
        body: "미리보기에서 전수 시 실제로 복사될 파일 목록을 크기와 함께 보여줘요. 공유자는 카드에 사람이 읽기 좋은 소개 문구를 직접 쓸 수 있고, 지우면 스킬 설명으로 돌아가요.",
      },
      {
        title: "브라우저 제어 허용 사이트가 자동으로 채워져요",
        body: "관리자가 서버에 기본 허용 사이트를 정해두면, 아직 허용 목록을 만들지 않은 브라우저에 자동으로 적용돼요. 직접 편집한 목록과 조직 정책은 건드리지 않고, 설정 → 접근/보안에서 언제든 바꿀 수 있어요.",
      },
    ],
  },
  {
    id: "2026-08-09",
    items: [
      {
        title: "아바타끼리 스킬을 전수해요",
        body: "동료 아바타가 공유한 스킬을 '스킬 배우기' 탭에서 구경하고 내 아바타에게 전수받을 수 있어요. 원본이 바뀌면 '업데이트 있음' 배지로 새 버전을 받을 수 있고, 직접 고친 사본은 덮어쓰기 전에 확인을 받아요. 그만 따라가려면 '연결 끊기(구독 해지)'를 하면 돼요.",
        example: "예: 왼쪽 '스킬 배우기' 탭에서 동료의 스킬을 골라 전수받아 보세요.",
      },
      {
        title: "썸네일·타일도 클릭할 수 있어요",
        body: "canvas나 div로만 만들어져 일반 클릭이 닿지 않던 썸네일·카드도 이제 아바타가 찾아서 클릭해요. 페이지 스냅샷이 그런 요소를 따로 모아 보여주고, 이미지를 지원하지 않는 모델에서도 동작해요. 새 확장(0.18.0)으로 업데이트하면 적용돼요.",
        example: "예: “이 페이지에서 두 번째 썸네일 눌러 줘.”",
        action: "browser-guide",
      },
      {
        title: "전수받은 스킬은 재공유가 막혀요",
        body: "다른 아바타에게서 전수받은 스킬은 원본과 연결된 동안 다시 공유할 수 없어요. 내 스킬로 공유하려면 스킬 탭에서 '연결 끊기(구독 해지)'를 한 뒤 공유해 주세요. 이전에 재공유된 항목은 자동으로 정리돼요.",
      },
      {
        title: "그룹 관리자가 공유 스킬을 관리해요",
        body: "그룹 관리자는 설정의 그룹 카드 → 공유 스킬에서 그룹원이 공유한 스킬을 그룹 채널에서 차단하거나 해제할 수 있어요. 다른 공통 그룹과 이미 전수받은 사본에는 영향이 없어요.",
      },
    ],
  },
  {
    id: "2026-08-07.4",
    items: [
      {
        title: "화면을 보고 좌표로 클릭해요",
        body: "캔버스 에디터, 지도, 그려진 차트처럼 일반 클릭이 닿지 않던 화면도 조작해요. 아바타가 스크린샷을 찍어 위치를 눈으로 확인하고 그 지점을 픽셀 좌표로 직접 클릭해요. 클릭 후에는 실제로 무엇에 맞았는지 확인해서 알려주고, 화면이 스크롤되거나 바뀌었으면 잘못 누르는 대신 다시 캡처한 뒤 클릭해요. 이미지를 지원하는 모델에서 동작해요.",
        example: "예: “지도에서 강남역 근처 마커 클릭해서 정보 열어 줘.”",
      },
      {
        title: "Microsoft Edge에서도 브라우저 조작을 써요",
        body: "브라우저 확장이 Edge에서도 동일하게 동작해요. 설치 안내와 확장 관리 페이지 링크도 쓰는 브라우저에 맞춰 표시돼요.",
        action: "browser-guide",
      },
      {
        title: "확장 업데이트 버튼이 제대로 눌려요",
        body: "숨은 단계에 가려 눌리지 않던 확장 업데이트 버튼을 고쳤어요. 새 확장(0.8.6)이 나왔으니 배지가 주황색이면 업데이트해 주세요.",
      },
    ],
  },
  {
    id: "2026-08-07.3",
    items: [
      {
        title: "Confluence는 이제 읽기 전용이에요",
        body: "아바타가 Confluence 페이지를 직접 만들거나 고치지 않아요. 검색·조회·첨부 가져오기는 그대로예요. 페이지를 쓰거나 고쳐야 할 때는 브라우저 조작으로 내 브라우저에서 직접 편집하니까, 편집 이력이 내 계정으로 남고 무엇이 바뀌는지 눈으로 보면서 되돌릴 수 있어요.",
        example: "예: “이 위키 페이지에 회의 결과 추가해 줘.” (브라우저 조작 도구가 켜져 있어야 해요)",
      },
    ],
  },
  {
    id: "2026-08-07.2",
    items: [
      {
        title: "브라우저 확장을 한 번 다시 설치해 주세요",
        body: "확장 서명 키를 정식 키로 바꾸면서 확장 ID가 달라졌어요. 기존 확장은 더 이상 Noah와 연결되지 않으니, 기존 확장을 삭제한 뒤 새 zip을 받아 다시 로드해 주세요. 입력창 아래 배지가 '연결 안 됨'으로 보이면 아직 예전 확장이에요.",
        example: "예: 설정 → 권한·연결에서 zip 내려받기 → chrome://extensions에서 기존 확장 삭제 → '압축해제된 확장 프로그램을 로드'",
        action: "browser-guide",
      },
      {
        title: "아바타가 화면을 눈으로 봐요",
        body: "차트·지도·이미지처럼 글자만으로는 알 수 없는 화면을 아바타가 캡처해서 직접 봐요. 보이는 영역, 페이지 전체, 특정 요소 중에 골라서요. 이미지를 지원하는 모델을 선택했을 때 동작해요.",
        example: "예: “이 대시보드 그래프 보고 이번 주 추세 설명해 줘.”",
      },
      {
        title: "폼 입력과 드롭다운 선택이 빨라졌어요",
        body: "여러 칸을 한 번에 채우고, 드롭다운도 정확히 골라요. 칸마다 따로 입력하던 것보다 훨씬 빠르고 안정적이에요.",
        example: "예: “이 신청서 내 정보로 채워 줘. 부서는 개발팀으로 골라 줘.”",
      },
      {
        title: "긴 문서는 본문만 읽어요",
        body: "위키나 기사처럼 읽기만 하면 되는 페이지는 본문 텍스트만 추려서 나눠 읽어요. 로그인이 필요한 사내 페이지도 내 세션 그대로 읽을 수 있어요.",
        example: "예: “사내 위키 이 페이지 열어서 3줄로 요약해 줘.”",
      },
      {
        title: "확장 아이콘에서 바로 업데이트해요",
        body: "브라우저 툴바의 Noah 확장 아이콘을 누르면 업데이트 페이지가 열려요. 최신 버전 확인과 설치를 거기서 하고, 회사 정책으로 폴더 선택이 막힌 경우에는 파일 선택 창 없이 갱신하는 방법을 안내해요.",
      },
    ],
  },
  {
    id: "2026-08-07",
    items: [
      {
        title: "아바타가 내 브라우저를 직접 조작해요",
        body: "이번 업데이트의 핵심 기능이에요. 브라우저 브릿지 확장을 설치하면 아바타가 내가 로그인해 둔 세션 그대로 탭을 열고 읽고 클릭하고 입력해요. 한글 입력, 스크롤, 대화상자 처리, 탭 관리까지 되고, 허용한 사이트의 Noah 탭 그룹 안에서만 · 내 아바타와의 대화에서만 움직여요.",
        example: "예: 입력창의 도구 선택에서 '브라우저 조작'을 켜고 “사내 위키 열어서 오늘 공지 요약해 줘”라고 해보세요.",
        action: "browser-guide",
      },
      {
        title: "브라우저 확장은 버튼 한 번으로 업데이트돼요",
        body: "압축을 푼 확장 폴더를 한 번 연결해 두면, 새 버전이 나왔을 때 파일 교체부터 확장 리로드까지 버튼 한 번에 끝나요. 입력창의 버전 배지가 업데이트할 시점을 알려줘요.",
        example: "예: 설정 → 권한·연결 → 확장 폴더 연결 (원클릭 업데이트)",
      },
      {
        title: "모델 선택에 Fable 티어가 생겼어요",
        body: "Opus를 넘어서는 최상위 Fable 모델을 대화별로 고를 수 있어요. 가장 까다로운 추론과 긴 작업에 적합해요.",
      },
      {
        title: "두 번째 뇌 저장이 활동 내역에 '기억'으로 보여요",
        body: "아바타가 대화 중에 지식 저장소로 기록한 내용이 활동 트리에 전용 '기억' 줄로 표시돼요. 무엇이 저장됐는지 대화 안에서 바로 확인할 수 있어요.",
      },
    ],
  },
  {
    id: "2026-08-03",
    items: [
      {
        title: "draw.io 다이어그램 그리기와 보기",
        body: "아바타가 draw.io(.drawio) 다이어그램을 직접 그려서 전달할 수 있어요. 파일 카드를 누르면 옆 패널에서 확대/이동, 페이지 전환이 되는 다이어그램으로 바로 보고, 내려받아 draw.io에서 이어서 편집할 수 있어요. Confluence 페이지에 첨부된 .drawio 파일도 같은 방식으로 볼 수 있어요.",
        example: "예: “우리 배포 파이프라인 구성도를 draw.io로 그려 줘.”",
      },
      {
        title: "그룹 메뉴 신설",
        body: "왼쪽 메뉴에 '그룹' 화면이 생겼어요. 내 그룹 확인과 그룹 설정, 관리자의 그룹 관리까지 한곳에서 해요. 설정과 관리자 화면에 나뉘어 있던 그룹 탭은 이곳으로 합쳐졌어요.",
      },
      {
        title: "그룹 에이전트 여러 개 만들기",
        body: "그룹 공유 에이전트를 이제 여러 개 둘 수 있어요. 역할별로 에이전트를 나눠 만들고 각각 따로 설정하거나 비활성화할 수 있어요.",
        example: "예: 그룹 화면 → 그룹 에이전트 추가",
      },
      {
        title: "대화로 그룹 에이전트 역할 바꾸기",
        body: "그룹 관리자는 그룹 에이전트와 대화하면서 역할·페르소나·소개를 바로 바꿀 수 있어요. 바뀐 내용은 다음 턴부터 모든 그룹원의 대화에 적용돼요.",
        example: "예: 그룹 에이전트에게 “지금부터 너는 우리 팀 코드리뷰 담당이야”라고 말해 보세요.",
      },
      {
        title: "에이전트 팀 (실험 기능)",
        body: "아바타가 복잡한 작업을 할 때 이름을 가진 팀원 에이전트들을 만들어 협업시킬 수 있어요. 진행 중 활동 표시에서 팀원별 작업을 볼 수 있어요.",
      },
    ],
  },
  {
    id: "2026-07-31",
    items: [
      {
        title: "그룹 중심 공개로 개편",
        body: "아바타의 '모두 공개' 상태가 사라졌어요. 이제 아바타는 같은 그룹의 동료에게만 보이고(또는 비공개), 그룹에 속하지 않으면 내 아바타와만 대화해요. 기존 '모두 공개' 아바타는 자동으로 '그룹 공개'로 바뀌었어요.",
      },
      {
        title: "그룹별 아바타 공개 정책",
        body: "그룹 관리자가 그룹 설정에서 '그룹원 아바타 상호 공개'를 끌 수 있어요. 끄면 지식 공유 전용 그룹이 되어 서로의 아바타가 보이지 않지만, 공용 지식 저장소는 계속 함께 사용해요.",
      },
      {
        title: "그룹 공유 에이전트",
        body: "그룹마다 그룹 에이전트를 만들 수 있어요. 그룹 지식 저장소를 공유 세컨드브레인으로 사용해서, 그룹원 누구든 대화하며 그룹 지식을 묻고 기록할 수 있어요. 대화는 개인별로 비공개이고, 그룹 공유는 세컨드브레인 기록으로 이뤄져요.",
        example: "예: 그룹 설정 → 그룹 에이전트 만들기 → 탐색에서 팀 에이전트와 대화 → “이 결정을 팀 노트에 기록해 줘.”",
      },
      {
        title: "외부 아바타 그룹 지정 필수",
        body: "관리자가 등록하는 외부 아바타도 이제 공개할 그룹을 반드시 지정해야 해요. 그룹이 지정되지 않은 항목은 아무에게도 표시되지 않아요. (운영자: EXTERNAL_AGENTS_JSON 항목에 visibleToGroupIds를 추가해 주세요.)",
      },
    ],
  },
  {
    id: "2026-07-29",
    items: [
      {
        title: "아바타 간 상담",
        body: "같은 그룹 동료의 아바타에게 필요한 정보를 요청해 보세요. 내 아바타가 대신 질문하고, 받은 답변을 정리해 대화에 활용해요.",
        example: "예: “민수님 아바타에게 이번 배포 체크리스트를 물어봐 줘.”",
      },
      {
        title: "예약 작업 실시간 보기",
        body: "예약 작업의 '지금 실행'이 실시간 대화 화면으로 열려 진행 상황을 지켜볼 수 있어요.",
      },
      {
        title: "문서 만들기와 미리보기",
        body: "아바타가 만든 PPTX 같은 문서를 채팅에서 페이지 미리보기와 함께 바로 내려받을 수 있어요.",
      },
      {
        title: "웹 페이지 읽기",
        body: "사내망을 포함한 웹 페이지를 아바타가 직접 읽어와 요약하고 활용해요.",
      },
      {
        title: "업데이트 소식 알림",
        body: "새 버전이 배포되면 지금처럼 새로워진 기능을 알려드려요.",
      },
    ],
  },
];

/** Latest release id (null only if the registry is ever emptied). */
export const CURRENT_RELEASE_ID: string | null = RELEASE_NOTES[0]?.id ?? null;

/** How many releases the dialog shows at most (long-away users aren't walled). */
export const MAX_RELEASES_SHOWN = 3;

/** Whether `id` is a registered release id (validation for the seen endpoint). */
export function isKnownReleaseId(id: unknown): id is string {
  return typeof id === "string" && RELEASE_NOTES.some((note) => note.id === id);
}

/**
 * Releases the user hasn't seen yet, newest first, capped. `lastSeen` null or
 * unknown (pruned id / rollback) counts as "never seen" — see the module note.
 */
export function unseenReleases(lastSeen: string | null | undefined): ReleaseNote[] {
  const seenIndex = lastSeen ? RELEASE_NOTES.findIndex((note) => note.id === lastSeen) : -1;
  const fresh = seenIndex >= 0 ? RELEASE_NOTES.slice(0, seenIndex) : RELEASE_NOTES;
  return fresh.slice(0, MAX_RELEASES_SHOWN);
}

/** "2026-07-29" → "2026년 7월 29일" (unparseable ids fall back to the raw id). */
export function releaseDateLabel(id: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(id);
  if (!match) {
    return id;
  }
  return `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`;
}
