# Editing a converted deck in PowerPoint — what to tell users

A converted .pptx is an ordinary PowerPoint file: every text box, shape, table and chart is a native object the
user can select and edit. A few behaviours follow from matching the HTML design exactly. Tell the user the ones
that matter for what they are about to do — in their language, briefly, not the whole list. Menu names are given
as in English PowerPoint with the Korean PowerPoint names in parentheses.

## Before the first edit

- **PowerPoint version**: desktop PowerPoint shows the embedded Pretendard from build 2411 on (File > Account >
  About PowerPoint / 파일 > 계정 > PowerPoint 정보). Build 2410 had a bug that broke every embedded font.
- **Protected View**: a downloaded file opens read-only; Enable Editing (편집 사용) first.
- **Keeping the font in the file**: the deck comes with "Embed fonts in the file" and "Embed all characters"
  switched on (File > Options > Save / 파일 > 옵션 > 저장 > 파일의 글꼴 포함, 모든 문자 포함 — a per-file setting),
  so saving in PowerPoint keeps Pretendard inside the file for the next person. Tell users to leave it on.

## Text

- **Longer text shrinks instead of wrapping into the next object.** Every box that wraps (titles, labels,
  captions, summaries) has Shrink text on overflow (넘칠 때 텍스트 크기 조정): a much longer text gets smaller
  to stay inside its box. To keep the full size, shorten the text or enlarge the box, or turn it off in Format
  Shape > Text Options > Text Box > Do not Autofit (도형 서식 > 텍스트 옵션 > 텍스트 상자 > 자동 맞춤 안 함).
- **Big numbers, pills, legend labels and footer notes do not wrap**: they grow sideways, as in the design. A KPI
  number has room for two or three more digits before it leaves its card; white text past a dark card's edge is
  invisible. A pill is a rounded rectangle plus a text box in one group: a longer pill text runs past the pill, so
  widen the shape too.
- **Korean line breaking** is set on every paragraph, so changing the Slide Master's Korean word-wrap option does
  not reach existing text; change it per text box (Paragraph > Asian Typography / 단락 > 한글 입력 체계).
- Drawn visuals do not follow edited numbers or dates: KPI comparison bars, cost and target bars, timeline bars
  and milestone dots are shapes. Resize or move them by hand; their names in the Selection Pane (선택 창, Alt+F10)
  state the values or dates they draw.

## Tables

- Add rows with Insert Above / Insert Below (위에 삽입 / 아래에 삽입) on a MIDDLE body row. The thicker rule above
  a total row (합계) is the bottom border of the row above it, so inserting right next to it leaves the rule in
  the wrong place — fix it with Table Design > Borders (테이블 디자인 > 테두리).
- The table grows downward: after adding rows, move the footnote text boxes below it down.

## Charts

- Right-click → Edit Data (데이터 편집) opens the chart's own workbook.
- The value axis is FIXED to the range the design shows (the chart's Selection Pane name says so, e.g.
  "값 축 0~1,600 고정"). After entering larger values, reset it: Format Axis > Axis Options > Bounds > Reset
  (축 서식 > 축 옵션 > 경계 > 다시 설정). A value above the maximum is clipped but keeps its label.
- A new category needs Chart Design > Select Data (차트 디자인 > 데이터 선택): the data range is fixed.
- The legend is ordinary text boxes and shapes next to the chart, and the chart's alt text lists its values:
  update both by hand after renaming a series or changing values. The plot area fills the chart frame, so turning
  on PowerPoint's own legend or axis titles overlaps the bars — shrink the plot area after doing so.

## Footer, page numbers, layouts

- The footer (rule, brand mark, deck name, note, page number) is part of the slide layout (e.g. 본문), not of
  each slide: edit it in View > Slide Master (보기 > 슬라이드 마스터). Insert > Header & Footer
  (삽입 > 머리글/바닥글) does not control it. To hide it on one slide: Format Background > Hide background
  graphics (배경 서식 > 배경 그래픽 숨기기).
- Page numbers are real slide-number fields: they renumber when slides move.
- New Slide (새 슬라이드) offers only the deck's own layouts; one gives the background, footer, page number and a
  title in the deck's style, but no body placeholder — add text boxes.
- Home > Reset (홈 > 원래대로) puts a title back into the layout's title position and style.
- Copying slides into another presentation: Keep Source Formatting (원본 서식 유지) keeps everything. With the
  destination theme, content slides take the other deck's background and lose this deck's footer; a dark slide
  (cover, section divider, closing) keeps its own background so its white text stays readable.

## Fonts

- **Design > Fonts (디자인 > 글꼴) changes nothing**: every text run names its font, because the layout was
  measured with exactly those faces.
- **To get 맑은 고딕, ask for the 맑은 고딕 build** — do not use Home > Replace > Replace Fonts (홈 > 바꾸기 >
  글꼴 바꾸기) on the Pretendard deck: its SemiBold/ExtraBold weights are separate font families, so Replace Fonts
  turns titles and KPI numbers into 맑은 고딕 Regular.
- **Web viewers ignore embedded fonts**: PowerPoint for the web and Teams/SharePoint previews (also PCs that block
  embedded fonts, and LibreOffice before 25.8) show a similar font, and the 600/800 weights may fall back to regular.
  For audiences that mostly view there, the 맑은 고딕 build is the better file.
- Pretendard has no Hanja and lacks `◎ ☞ ㉠ ㉡ ≒ ∴ ∵`: characters typed later come from a fallback font. For
  Hanja-heavy decks use the 맑은 고딕 build.

## Previews in the chat

The chat's side panel shows the converter's exact renders of the file as built. If a user edits the .pptx in
PowerPoint and shares it back, Noah previews that file with LibreOffice, which only approximates PowerPoint
(slightly lower text, wider mixed Korean/Latin text, other wraps). Changes you make for the user are made in the
slide HTML and rebuilt, never in their edited copy — unless they ask you to edit THEIR file, which is the
python-pptx path (`reference/python-pptx.md`).
