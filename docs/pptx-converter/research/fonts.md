# Fonts for the HTML → editable PPTX PoC — research, measurements, decisions

> **Historical PoC evidence, preserved for maintainers — not agent-facing.** Written in the HTML→PPTX
> proof of concept before its port into Noah (2026-09) and copied here unchanged below this note. Paths such
> as `scratch/…`, `tools/…`, `out/…`, `fonts/…`, `theme/…`, `slides/…`, `docs/…` and `$POC` refer to that PoC
> tree, and machine paths (`/home/jinyoung/…`, `/mnt/c/Windows/Fonts`) to its dev box — Windows fonts were
> only ever READ in place there, never copied. The shipped converter is `default-skills/skills/pptx/converter/`;
> see [`docs/architecture/pptx-converter.md`](../../architecture/pptx-converter.md) and
> [the index of this directory](../README.md).

Status: COMPLETE for the fonts lane (2026-09-25). Everything below was re-measured in this run. The
first attempt's notes (`scratch/prior-run/`) were used only as leads.

Owner: fonts lane. Owned files: `fonts/` (font files, license texts, `fonts.json`),
`theme/fonts-embedded.css`, `theme/fonts-malgun.css`, this doc, `scratch/fonts/`.

Confidence legend: **H** = stated by a primary source, or measured locally on exactly that file or behaviour;
**M** = consistent secondary evidence; **L** = inference / unverified. Anything about *PowerPoint* itself is at
most M unless a Microsoft document states it. Nobody on the team can run PowerPoint. LibreOffice renders are
evidence about LibreOffice 7.4.7.2 (= Noah's preview), not about PowerPoint.

## 0. Decisions (summary)

| | `embedded` profile | `malgun` profile |
|---|---|---|
| CSS family (`cssFamily`) | `Pretendard` | `PoC Malgun Substitute` |
| Font files | Pretendard 1.3.9 static TrueType (glyf): Regular, SemiBold, Bold, ExtraBold | Gothic A1 2.50 R/B (Hangul, jamo, CJK symbols) + Selawik 1.01 R/B (Latin, digits, space) + Noto Sans KR 2.004 VF (Hanja) |
| PPTX typeface | `Pretendard` (400 regular, 700 bold), `Pretendard SemiBold` (600), `Pretendard ExtraBold` (800) | `맑은 고딕`, regular (b=0) / bold (b=1) |
| Embedded into the PPTX | the 4 Pretendard files, unmodified: **10,728,696 B raw, 4,721,252 B deflated** | nothing |
| HTML-only helper | Hanja drawn from Noto Sans KR VF with Pretendard's line metrics (Pretendard has no Hanja; PowerPoint falls back to a system CJK font there) | — |
| Width error vs the font PowerPoint uses | none (same files); shaping/kerning differences only (§1.6) | vs REAL Malgun Gothic in Chromium, 77 lines × 6 sizes: mean 0.999–1.001, sd 0.26%, max slack 1.006 (R) / 1.019 (B) |
| Line metrics in CSS | Pretendard's own (1.1929 em) | forced to Malgun Gothic's (1.0884 + 0.2417 em); line boxes and baselines pixel-identical to real Malgun at 13–100 px |
| Recommended builder slack (wrapped boxes) | 1.02 until PowerPoint's GPOS-kerning behaviour is known; 1.005 if it kerns like Chromium | **1.02** |

Findings the other lanes must act on (all measured, **H**):

1. **Extractor: launch Chromium with `--font-render-hinting=none`.** By default, headless Chromium 149 rounds
   every glyph advance to whole CSS px at *every* DSF (1, 1.5, 2, 3). That gives −6.6%…+4.2% width error
   per run. Hinted fonts also get hinted/VDMX line heights: Malgun at 20 px → 28 px line box instead of the
   linear 27 px. With the flag, advances equal the font's ideal widths to 1/64 px (§3).
2. **No free font has Malgun Gothic's advances.** Malgun's Hangul is exactly 1.000 em for all 11,172
   syllables; its space is 0.3516 em. All 16 OFL Korean fonts tested are narrower (plain best: Gothic A1
   Bold −2.2%, NanumGothic −4.1%, Noto Sans KR −7.6%, Pretendard −12.3%).
   The malgun profile therefore uses a CSS composite of unmodified OFL files:
   - per-`unicode-range` `size-adjust` factors;
   - `ascent/descent/line-gap-override` so every face's effective metrics equal Malgun's.
3. **Blink merges `unicode-range` faces only when their `font-weight`/style/stretch descriptors are
   identical.** CSS Fonts 4 says the same: overlap ordering applies to "rules with the same family and
   style descriptor values". A face with a different weight range forms a competing group. Observed: a
   single `1 1000` Hanja face stole weights 650–900 and dropped Latin to DejaVu Sans. Anyone editing the
   theme CSS must keep descriptors identical within a composite. The generator does.

## 1. Embedded profile: Pretendard

### 1.1 Source, version, license

- The latest release is **v1.3.9**, published 2023-11-05 (GitHub releases API). The asset
  `Pretendard-1.3.9.zip` (47,304,526 B) contains:
  - static CFF (`public/static/*.otf`);
  - **static TrueType (`public/static/alternative/*.ttf`)**;
  - one variable TTF;
  - `LICENSE.txt`. **H**
- We ship the four static TTFs **byte-identical** (SHA-256 in §6).
- Pretendard Std is ruled out: `PretendardStd-1.3.9.zip` is the "라틴 환경" (Latin-environment) build, and
  its TTF has **0 Hangul syllables**. Pretendard GOV/JP are the same design in larger packages (112/106 MB
  zips). **H**
- License: SIL OFL 1.1, "Copyright (c) 2021, Kil Hyung-jin … with Reserved Font Name Pretendard". The
  release's `LICENSE.txt` is saved as `fonts/Pretendard-OFL.txt`. The repository's main-branch LICENSE
  also lists the upstream Source Han Sans (Adobe, RFN "Source"), Inter and M PLUS 1 copyrights.
- Files are unmodified (no subsetting, renaming or instancing), so the Reserved-Font-Name clause is not
  triggered. The OFL allows embedding in documents.

### 1.2 Why static TrueType with fsType 0x0000

- Microsoft Support ("Some of your fonts can't be saved with the presentation") on what can be embedded
  (**H**):
  - supported: TrueType and OpenType fonts whose creator grants permission;
  - unsupported: Adobe PostScript Type 1 and AAT;
  - status levels: *Editable*/*Installable* embed; *Preview/Print* for viewing/printing only;
    *Restricted* does not embed.
- The RDP PowerPoint FAQ says only TrueType outlines embed; OTF with PostScript/CFF data does not (**M**).
  Shipping `glyf` outlines sidesteps that question.
- OpenType OS/2 `fsType` values (**H**):
  - 0 = Installable;
  - 4 = Preview & Print ("documents … must be opened 'read-only'");
  - 8 = Editable ("editing is permitted, including ability to format new text using the embedded font");
  - bit 8 = no subsetting; bit 9 = bitmap only.
- All four Pretendard files have **fsType 0x0000**, the least restrictive value (measured).
- A variable font would give PowerPoint only its default instance per family name, so we ship static files.

### 1.3 Per-face facts (fontTools, on the shipped files) **H**

Name records are Windows (3,1,0x409) only: there are **no Korean-language records** (only name ID 0,
copyright, has a ko-KR record). PowerPoint therefore shows "Pretendard…" in every UI language.

None of the files has TrueType hinting (`fpgm`/`prep`/`cvt` absent), VDMX or a legacy `kern` table; kerning
is GPOS only. Metric columns are in font units.

| file | outline | fsType | name ID 1 / 2 | ID 4 | ID 6 | ID 16 / 17 | typo asc/desc/gap | win asc/desc | hhea asc/desc/gap | USE_TYPO_METRICS | upm | glyphs | bytes | deflate-9 | usWeightClass | version |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `fonts/Pretendard-Regular.ttf` | glyf | 0x0000 | Pretendard / Regular | Pretendard Regular | Pretendard-Regular | Pretendard / Regular | 1949/-494/0 | 1949/494 | 1950/-494/0 | yes | 2048 | 14716 | 2,725,828 | 1,169,073 | 400 | 1.309 |
| `fonts/Pretendard-SemiBold.ttf` | glyf | 0x0000 | Pretendard SemiBold / Regular | Pretendard SemiBold | Pretendard-SemiBold | Pretendard / SemiBold | 1949/-494/0 | 1949/494 | 1950/-494/0 | yes | 2048 | 14716 | 2,671,468 | 1,180,047 | 600 | 1.309 |
| `fonts/Pretendard-Bold.ttf` | glyf | 0x0000 | Pretendard / Bold | Pretendard Bold | Pretendard-Bold | Pretendard / Bold | 1949/-494/0 | 1949/494 | 1950/-494/0 | yes | 2048 | 14716 | 2,661,752 | 1,183,804 | 700 | 1.309 |
| `fonts/Pretendard-ExtraBold.ttf` | glyf | 0x0000 | Pretendard ExtraBold / Regular | Pretendard ExtraBold | Pretendard-ExtraBold | Pretendard / ExtraBold | 1949/-494/0 | 1949/494 | 1950/-494/0 | yes | 2048 | 14716 | 2,669,648 | 1,188,328 | 800 | 1.309 |

Coverage (all four faces):

- 11,172 Hangul syllables (all of KS X 1001's 2,350 and more).
- 53 compatibility jamo; **0 Hanja**; 14,336 cmap code points.

Line metrics:

- Line = 1.1929 em (typo = win; hhea is 1 unit taller).
- Ascent 0.9517 em, descent 0.2412 em.

### 1.4 PowerPoint typeface / slot assignment (from the real name tables) **H**

| cssWeight | file | typeface (name ID 1) | name ID 2 | `bold` | slot | CSS `font-weight` range |
|---|---|---|---|---|---|---|
| 400 | Pretendard-Regular.ttf | `Pretendard` | Regular | false | regular | `1 499` |
| 600 | Pretendard-SemiBold.ttf | `Pretendard SemiBold` | Regular | false | regular | `500 649` |
| 700 | Pretendard-Bold.ttf | `Pretendard` | Bold | true | bold | `650 749` |
| 800 | Pretendard-ExtraBold.ttf | `Pretendard ExtraBold` | Regular | false | regular | `750 1000` |

`embed_fonts` therefore creates three `<p:embeddedFont>` entries:

- `Pretendard`: regular + bold;
- `Pretendard SemiBold`: regular;
- `Pretendard ExtraBold`: regular.

The CSS ranges reproduce the builder rule (nearest `cssWeight`, tie → heavier) for every integer weight.
Verified in Chromium for 100–900 in steps of 50 with CDP `CSS.getPlatformFontsForNode`: 0 mismatches (§6).

No face's range tops out below 600 while receiving a ≥600 request, so Chromium never synthesizes bold.

### 1.5 Payload

Size is **10,728,696 B raw** (10.23 MiB) for 4 faces. Each deflates to 42.9–44.5%, so **4,721,252 B**
(~4.7 MB) inside the PPTX zip, assuming `.fntdata` is deflated.

- The EOT/obfuscation wrappers change this by ≈1 KB per face at most.
- Each weight costs ≈1.2 MB of PPTX.

Subsetting ("embed only the characters used") would shrink it a lot, but it breaks editing with new
characters; Microsoft Support advises against it for files others will edit. It is also an OFL Modified
Version, which would require a rename (RFN). Not done.

### 1.6 Kerning — relevant to the builder's `kern` attribute (measured **H**; PowerPoint behaviour **L**)

Pretendard's kerning is GPOS-only and has **no Hangul pairs** ("가나다라마바사" kerned = unkerned). It does
kern Latin, digits and punctuation:

| text | kerning change |
|---|---|
| `AVATAR` | −0.295 em |
| `(YoY +27%)` | −0.193 em |
| `1,284억` | −0.042 em |

On the corpus, kerned/unkerned per line is mean 0.9977 (R) / 0.9965 (B), min 0.9820. An unkerned rendering
is therefore up to **1.83%** wider than Chromium's (Chromium kerns by default). Whether PowerPoint applies
GPOS kerning, and at which `kern` threshold, is open (§7).

### 1.7 Hanja in the embedded profile (HTML side only) **H**

Pretendard has no Hanja, so a slide containing 社 would render tofu (no glyph) on a server without CJK
fonts. PowerPoint would substitute a system CJK font there (not verifiable here). Malgun Gothic's and Noto
Sans KR's Hanja are 1.000 em, which is the norm for CJK fonts.

`theme/fonts-embedded.css` therefore adds, per Pretendard weight range (identical descriptors, §0 item 3),
a Hanja-only face:

- file: `fonts/NotoSansKR-VF.ttf`;
- `unicode-range: U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF`;
- Pretendard's line metrics as overrides: 95.1660% / 24.1211% / 0%.

Measured in Chromium: line boxes with and without Hanja are identical (19/29/48 px at 16/24/40 px), 社
advances 1.000 em, and the VF follows the CSS weight (ink 8,361 → 11,346 → 12,484 → 13,555 at
400/600/700/800). Noto Sans KR is **not** in fonts.json faces, so it is never embedded.

### 1.8 Alternatives considered for `embedded` (measured **H**)

| option | why not |
|---|---|
| Noto Sans KR (google/fonts ships only `NotoSansKR[wght].ttf`, 10.4 MB VF, fsType 0) | needs instancing (a modified version; 6.2 MB per static instance, ~2.3× Pretendard); ~20% heavier and taller glyphs |
| NanumSquare Neo (Naver, OFL, 2.1–2.2 MB TTF) | weights 300/400/700/800/900; **no 600** |
| NanumGothic (google/fonts 3.020, ~2.1 MB) | no 600. Vertical metrics inconsistent: Regular has USE_TYPO_METRICS (1.25 em line), Bold does not (0.99 em) |
| NanumGothic (Naver zip 3.021 = Debian `fonts-nanum`, 4.6 MB) | no 600. **All outlines sit 0.044 em below the baseline** (`H` yMin = −0.043 em); fsType 8 |
| Pretendard Std / GOV / JP | no Hangul / same design, larger packages |

## 2. Malgun profile: measurement substitute

### 2.1 Malgun Gothic facts (read in place from `C:\Windows\Fonts`, never copied) **H**

| | malgun.ttf | malgunbd.ttf |
|---|---|---|
| version / outline / upm / glyphs / bytes | 6.69 / glyf / 2048 / 28,215 / 13,459,196 | 6.69 / glyf / 2048 / 28,215 / 12,600,392 |
| fsType | 0x0008 Editable | 0x0008 |
| name ID 1 | en `Malgun Gothic`, ko `맑은 고딕` | same |
| name ID 2 / 4 | Regular / `Malgun Gothic` (ko `맑은 고딕`) | Bold / `Malgun Gothic Bold` (ko `맑은 고딕 Bold`) |
| typo asc/desc/gap | 1638/-410/0 (1.000 em) | same |
| win asc/desc | 2229/495 (1.3301 em) | same |
| hhea asc/desc/gap | 2229/-495/0 (1.3301 em) | same |
| USE_TYPO_METRICS | off, so line metrics = hhea = win (Chromium on Linux and Windows GDI agree) | off |
| hinting / VDMX / legacy `kern` / GPOS | yes / yes / yes / none | same |
| Hangul advance | **1.000 em for all 11,172 syllables** | same |
| space = NBSP | 0.3516 em (720 u) | 0.3516 em |
| digits (tabular) | 0.5508 em | 0.5796 em |
| Hanja | 7,476 URO + 6,582 Ext-A + 268 compat, all 1.000 em | same (1 exception 0.986) |
| Latin vs Segoe UI 5.71 (read in place) | ASCII = Segoe UI × **1.0216** (median; punctuation ×1.009; `\` 0.7637 em) | ≈ Segoe UI Bold × 1.0076 (median; −5…+6% per glyph) |

Malgun's legacy `kern` table changes corpus line widths by a mean of −0.03%, and by at most −0.97% (R) /
−0.81% (B).

### 2.2 Corpus

`scratch/fonts/corpus_ko_business.txt` was recovered from the first attempt and reviewed; it is sound and
reused. It is realistic quarterly-report slide text:

- title, Roman-numeral agenda, KPI bullets;
- a risk table, a schedule, financials;
- a glossary and footnotes.

Size: **77 lines, 2,416 chars**.

| class | share |
|---|---|
| Hangul | 48.5% |
| space | 23.0% |
| digits | 10.6% |
| punctuation/symbols | 10.6% |
| Latin | 7.3% |

Symbols present: `, . % ( ) : | · / → • & + ' ~ ※ ▶ “ ” @ ₩ [ ]`, Ⅰ–Ⅹ, and `社`. All statistics are
occurrence-weighted.

### 2.3 Method

- Widths are in em (advance / unitsPerEm).
- Candidates are shaped with HarfBuzz using default features, as Chromium does. The reference is Malgun's
  unkerned `hmtx` advances.
- `ratio = candidate / Malgun`; `slack = Malgun / candidate` per line.
- Missing glyphs are charged Malgun's width and listed.

Scripts in `scratch/fonts/`:

| script | purpose |
|---|---|
| `measure2.py` | plain candidates |
| `measure3.py` | CSS strategies |
| `visual_similarity.py` | glyph likeness |
| `chrome_check.mjs` + `analyze_chrome.py` | Chromium vs real Malgun |
| `chrome_subpixel.mjs` | advance rounding |
| `chrome_weights_and_sample.mjs` | weight resolution + comparison image |
| `chrome_hanja_linebox.mjs`, `chrome_vf_weight.mjs` | Hanja faces |
| `gen_fonts.py` | generates fonts.json and the CSS |
| `validate_fonts_json.py` | CONTRACT check |

### 2.4 Plain candidates vs Malgun Gothic (Regular vs malgun.ttf, Bold vs malgunbd.ttf) **H**

Columns:

- Per-glyph ratio mean (sd) per class; space is the aggregate ratio; line ratio is the per-line mean (sd).
- Slack is p99 / max over lines.
- "CSS normal LH" is Chromium-on-Linux `line-height: normal` in em (typo if USE_TYPO_METRICS, else hhea),
  with the ratio to Malgun's 1.3301 in brackets.
- "win" is usWinAscent + usWinDescent in em.

| font | w | Hangul | digits | Latin | space | line ratio | slack p99 / max | CSS normal LH (ratio) | win | missing |
|---|---|---|---|---|---|---|---|---|---|---|
| NanumGothic 3.021 (Naver zip) | R | 0.9400 (0.0000) | 1.1003 (0.0000) | 1.0311 (0.0512) | 0.7964 | 0.9589 (0.0259) | 1.085 / 1.087 | 1.1500 (0.865) | 1.1500 |  |
| NanumGothic 3.021 (Naver zip) | B | 0.9400 (0.0000) | 1.0456 (0.0000) | 0.9709 (0.0647) | 0.7964 | 0.9448 (0.0178) | 1.094 / 1.100 | 1.1500 (0.865) | 1.1500 |  |
| NanumGothic 3.020 (google/fonts) | R | 0.9400 (0.0000) | 1.1003 (0.0000) | 1.0311 (0.0512) | 0.7964 | 0.9594 (0.0260) | 1.085 / 1.087 | 1.2500 (0.940) | 1.0830 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ社 |
| NanumGothic 3.020 (google/fonts) | B | 0.9400 (0.0000) | 1.0456 (0.0000) | 0.9709 (0.0647) | 0.7964 | 0.9460 (0.0173) | 1.094 / 1.100 | 0.9900 (0.744) | 1.0830 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ社 |
| NanumBarunGothic (Naver zip) | R | 0.8920 (0.0000) | 1.0585 (0.0000) | 1.0271 (0.0595) | 0.6372 | 0.9052 (0.0335) | 1.152 / 1.152 | 1.1490 (0.864) | 1.1500 |  |
| NanumBarunGothic (Naver zip) | B | 0.8920 (0.0000) | 1.0059 (0.0000) | 0.9666 (0.0631) | 0.6372 | 0.8917 (0.0242) | 1.157 / 1.157 | 1.1490 (0.864) | 1.1500 |  |
| NanumSquare Neo (Naver zip) | R | 0.9480 (0.0000) | 1.1698 (0.1734) | 1.1335 (0.1007) | 0.6912 | 0.9580 (0.0352) | 1.095 / 1.096 | 1.1050 (0.831) | 1.1050 | 社 |
| NanumSquare Neo (Naver zip) | B | 0.9480 (0.0000) | 1.1290 (0.1575) | 1.0919 (0.0917) | 0.6969 | 0.9496 (0.0294) | 1.101 / 1.103 | 1.1050 (0.831) | 1.1050 | 社 |
| Noto Sans KR 2.004 (google/fonts VF) | R | 0.9200 (0.0000) | 1.0077 (0.0000) | 1.0440 (0.0664) | 0.6372 | 0.9240 (0.0197) | 1.118 / 1.124 | 1.4480 (1.089) | 1.4480 |  |
| Noto Sans KR 2.004 (google/fonts VF) | B | 0.9200 (0.0000) | 1.0180 (0.0000) | 1.0435 (0.0627) | 0.6457 | 0.9252 (0.0204) | 1.122 / 1.131 | 1.4480 (1.089) | 1.4480 |  |
| Pretendard 1.3.9 | R | 0.8643 (0.0000) | 1.0304 (0.1208) | 1.0079 (0.0695) | 0.7139 | 0.8771 (0.0294) | 1.229 / 1.244 | 1.1929 (0.897) | 1.1929 | 社 |
| Pretendard 1.3.9 | B | 0.8643 (0.0000) | 1.0364 (0.1196) | 1.0079 (0.0707) | 0.6556 | 0.8719 (0.0320) | 1.245 / 1.265 | 1.1929 (0.897) | 1.1929 | 社 |
| Gothic A1 2.50 (google/fonts) | R | 0.9609 (0.0000) | 1.0089 (0.0000) | 1.0210 (0.0642) | 0.6944 | 0.9555 (0.0194) | 1.092 / 1.126 | 1.2500 (0.940) | 1.5781 | 社 |
| Gothic A1 2.50 (google/fonts) | B | 0.9961 (0.0000) | 1.0110 (0.0000) | 1.0233 (0.0614) | 0.6944 | 0.9782 (0.0155) | 1.062 / 1.084 | 1.2500 (0.940) | 1.5781 | 社 |
| IBM Plex Sans KR (google/fonts) | R | 0.8920 (0.0000) | 1.0894 (0.0000) | 1.0349 (0.1186) | 0.6713 | 0.9040 (0.0304) | 1.194 / 1.197 | 1.5000 (1.128) | 1.5000 | 社 |
| IBM Plex Sans KR (google/fonts) | B | 0.8920 (0.0000) | 1.0352 (0.0000) | 1.0262 (0.1034) | 0.6713 | 0.8998 (0.0275) | 1.192 / 1.202 | 1.5000 (1.128) | 1.5000 | 社 |
| Spoqa Han Sans Neo 3.3.0 (subset) | R | 0.9200 (0.0000) | 1.0821 (0.0000) | 1.0413 (0.0651) | 0.6372 | 0.9166 (0.0255) | 1.133 / 1.136 | 1.2520 (0.941) | 1.4100 | •社 |
| Spoqa Han Sans Neo 3.3.0 (subset) | B | 0.9200 (0.0000) | 1.0283 (0.0000) | 1.0422 (0.0621) | 0.6457 | 0.9124 (0.0233) | 1.138 / 1.138 | 1.2520 (0.941) | 1.4100 | •社 |
| SUIT 2.0.5 | R | 0.8740 (0.0000) | 0.9848 (0.1590) | 1.0582 (0.1045) | 0.6542 | 0.8879 (0.0326) | 1.176 / 1.178 | 1.2480 (0.938) | 1.2480 | •ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ社 |
| SUIT 2.0.5 | B | 0.8740 (0.0000) | 0.9727 (0.1315) | 1.0348 (0.0981) | 0.6542 | 0.8838 (0.0307) | 1.180 / 1.181 | 1.2480 (0.938) | 1.2480 | •ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ社 |
| Wanted Sans 1.0.3 | R | 0.8643 (0.0000) | 1.0331 (0.1296) | 1.0345 (0.0907) | 0.7111 | 0.8828 (0.0310) | 1.186 / 1.188 | 1.1934 (0.897) | 1.1934 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ▶社 |
| Wanted Sans 1.0.3 | B | 0.8643 (0.0000) | 1.0414 (0.1168) | 1.0331 (0.0761) | 0.6889 | 0.8822 (0.0320) | 1.195 / 1.199 | 1.1934 (0.897) | 1.1934 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ▶社 |
| Paperlogy 1.001 | R | 0.8800 (0.0000) | 1.2104 (0.0000) | 1.1394 (0.0525) | 0.6258 | 0.9017 (0.0504) | 1.210 / 1.225 | 1.1778 (0.885) | 1.1778 |  |
| Paperlogy 1.001 | B | 0.8800 (0.0000) | 1.1502 (0.0000) | 1.1136 (0.0562) | 0.6258 | 0.8965 (0.0458) | 1.211 / 1.231 | 1.1778 (0.885) | 1.1778 |  |
| Min Sans 1.4.2 (VF) | R | 0.8984 (0.0000) | 1.0833 (0.0000) | 1.0724 (0.0696) | 0.6361 | 0.9012 (0.0301) | 1.157 / 1.158 | 1.3340 (1.003) | 1.3340 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ |
| Min Sans 1.4.2 (VF) | B | 0.8984 (0.0000) | 1.0463 (0.0000) | 1.0555 (0.0644) | 0.6472 | 0.8978 (0.0274) | 1.160 / 1.161 | 1.3340 (1.003) | 1.3340 | ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ |
| Asta Sans (google/fonts VF) | R | 0.8560 (0.0000) | 1.0338 (0.0834) | 1.0477 (0.1320) | 0.6997 | 0.8777 (0.0323) | 1.224 / 1.224 | 1.1930 (0.897) | 1.1930 | 社 |
| Asta Sans (google/fonts VF) | B | 0.8560 (0.0000) | 0.9969 (0.0853) | 1.0199 (0.1047) | 0.6997 | 0.8710 (0.0280) | 1.228 / 1.233 | 1.1930 (0.897) | 1.1930 | 社 |
| Gowun Dodum (google/fonts, 1 weight) | R | 0.9053 (0.0331) | 0.9477 (0.0654) | 0.9750 (0.0692) | 0.8818 | 0.9248 (0.0229) | 1.155 / 1.182 | 1.4480 (1.089) | 1.4480 | 社 |
| Sunflower Medium/Bold (google/fonts) | R | 0.9000 (0.0000) | 1.0167 (0.0000) | 0.9603 (0.0639) | 0.6258 | 0.8838 (0.0150) | 1.164 / 1.179 | 1.2500 (0.940) | 1.0450 | ·•※ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ→ |
| Sunflower Medium/Bold (google/fonts) | B | 0.9000 (0.0000) | 0.9662 (0.0000) | 0.9131 (0.0477) | 0.6258 | 0.8744 (0.0120) | 1.196 / 1.196 | 1.2500 (0.940) | 1.0450 | ·•※ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ→ |
| NanumGothicCoding (mono) | R | 1.0000 (0.0000) | 0.9078 (0.0000) | 1.0001 (0.3517) | 1.4222 | 1.0611 (0.0529) | 1.118 / 1.500 | 1.0000 (0.752) | 1.0000 | 社 |
| Selawik 1.01 (Latin only, Segoe UI metrics) | R | – | 0.9787 (0.0000) | 0.9798 (0.0029) | 0.7792 | (Latin only) | – | 1.2002 (0.902) | 1.3301 | Hangul |
| Selawik 1.01 (Latin only, Segoe UI metrics) | B | – | 0.9924 (0.0000) | 0.9964 (0.0151) | 0.7847 | (Latin only) | – | 1.2002 (0.902) | 1.3301 | Hangul |

Reading:

- Every Korean font's Hangul is monospaced (sd 0.0000), so one scale factor fixes Hangul exactly.
- Every candidate's space is 12–36% narrower than Malgun's, and spaces are 23% of Korean text.
- No plain font gets within 2% on average; the best plain choices would need a 6–13% (p99) slack.

### 2.5 CSS-level strategies (unmodified files; only `@font-face` descriptors differ) **H** (HarfBuzz simulation)

Strategies:

- **S0**: plain font.
- **S1**: one uniform `size-adjust` fitted to the corpus.
- **S2**: one font split by `unicode-range` (Hangul / space / digits / rest), each range with its own
  `size-adjust`.
- **S3**: Korean font for Hangul and symbols + **Selawik** for Latin and space.
- **S4 (shipped)**: S3 + an exact tabular-digit face from Selawik.

Table cells: line ratio mean (sd); slack p99 / max.

| Hangul carrier | w | S0 | S1 | S2 | S3 |
|---|---|---|---|---|---|
| Gothic A1 | R | 0.9555 (0.0194); 1.092 / 1.126 | 1.0004 (0.0203); 1.043 / 1.075 | 0.9976 (0.0289); 1.127 / 1.289 | 0.9998 (0.0009); 1.0033 / 1.0037 |
| Gothic A1 | B | 0.9782 (0.0155); 1.062 / 1.084 | 0.9997 (0.0159); 1.039 / 1.061 | 0.9978 (0.0235); 1.099 / 1.217 | 0.9997 (0.0020); 1.0058 / 1.0114 |
| NanumGothic (gf) | R | 0.9594 (0.0260); 1.085 / 1.087 | 1.0002 (0.0276); 1.040 / 1.042 | 0.9994 (0.0191); 1.076 / 1.142 | 0.9999 (0.0013); 1.0037 / 1.0055 |
| NanumGothic (gf) | B | 0.9460 (0.0173); 1.094 / 1.100 | 0.9999 (0.0189); 1.034 / 1.040 | 0.9999 (0.0147); 1.052 / 1.088 | 0.9999 (0.0021); 1.0058 / 1.0114 |
| Noto Sans KR | R | 0.9240 (0.0197); 1.118 / 1.124 | 1.0009 (0.0213); 1.032 / 1.038 | 0.9979 (0.0219); 1.076 / 1.207 | 1.0001 (0.0015); 1.0045 / 1.0087 |
| Noto Sans KR | B | 0.9252 (0.0204); 1.122 / 1.131 | 1.0006 (0.0221); 1.038 / 1.045 | 0.9979 (0.0187); 1.063 / 1.169 | 0.9999 (0.0021); 1.0092 / 1.0114 |
| Pretendard | R | 0.8771 (0.0294); 1.229 / 1.244 | 0.9990 (0.0336); 1.079 / 1.092 | 0.9964 (0.0229); 1.101 / 1.171 | 0.9993 (0.0147); 1.060 / 1.083 |
| Pretendard | B | 0.8719 (0.0320); 1.245 / 1.265 | 0.9992 (0.0367); 1.086 / 1.104 | 0.9970 (0.0212); 1.096 / 1.131 | 0.9995 (0.0156); 1.061 / 1.086 |

S4 (Gothic A1 + Selawik incl. exact digits):

- R: mean 0.99983, sd 0.00104, slack p99 1.0040, max 1.0048.
- B: mean 0.99963, sd 0.00266, p99 1.0103, max 1.0173. The worst line is the Latin-only `Q&A`: Malgun
  Bold's Latin is not a uniform scale of Segoe UI Bold.

Why the other strategies fall short:

- S2 is worse than S1, because a Korean font's own Latin and punctuation don't scale with one factor.
- Selawik is what makes Latin/punctuation track Malgun: its ASCII advances equal Segoe UI's exactly (sd
  0), and Malgun's Latin ≈ Segoe UI × 1.02.
- Pretendard and IBM Plex stay worse under S3 because their GPOS kerning touches digits and punctuation.

### 2.6 Choosing the Hangul carrier: visual likeness at matched advance **H** (`visual_similarity.py`)

Method: the 286 distinct corpus syllables are rasterized at the size that gives each candidate Malgun's
advance (200 px nominal). Columns are the ink bbox relative to pen origin/baseline (em), ink ratio (stroke
weight) and IoU of the binarized glyphs. The Pillow numbers were cross-checked against raw `glyf` bounds.

| font | w | size-adjust | left | right | top | bottom | ink ratio | IoU |
|---|---|---|---|---|---|---|---|---|
| **Malgun Gothic** | R | 1 | 0.088 | 0.904 | 0.843 | −0.064 | 1 | 1 |
| **Gothic A1** | R | 1.0407 | 0.072 | 0.919 | 0.824 | −0.075 | 1.071 | 0.510 |
| NanumGothic (gf) | R | 1.0638 | 0.064 | 0.930 | 0.872 | −0.085 | 1.047 | 0.542 |
| NanumGothic (Naver) | R | 1.0638 | 0.064 | 0.930 | 0.826 | −0.132 | 1.048 | 0.345 |
| Noto Sans KR | R | 1.0870 | 0.066 | 0.916 | 0.883 | −0.067 | 1.212 | 0.619 |
| Spoqa Han Sans Neo | R | 1.0870 | 0.069 | 0.913 | 0.879 | −0.063 | 1.186 | 0.636 |
| NanumSquare Neo | R | 1.0549 | 0.059 | 0.926 | 0.805 | −0.156 | 1.106 | 0.246 |
| Pretendard | R | 1.1571 | 0.053 | 0.929 | 0.897 | −0.073 | 1.234 | 0.537 |
| **Malgun Gothic** | B | 1 | 0.073 | 0.915 | 0.844 | −0.069 | 1 | 1 |
| **Gothic A1** | B | 1.0039 | 0.067 | 0.928 | 0.837 | −0.076 | 1.051 | 0.698 |
| NanumGothic (gf) | B | 1.0638 | 0.050 | 0.947 | 0.888 | −0.093 | 1.045 | 0.645 |
| Noto Sans KR | B | 1.0870 | 0.052 | 0.931 | 0.897 | −0.082 | 1.204 | 0.696 |
| Spoqa Han Sans Neo | B | 1.0870 | 0.054 | 0.928 | 0.894 | −0.079 | 1.187 | 0.709 |

**Gothic A1** is chosen:

- smallest scaling (+4.1% R, +0.4% B);
- glyph box within ≈0.02 em of Malgun's on every side;
- stroke weight +5–7%;
- its full-width symbols, jamo and fullwidth forms already have Malgun's 1.000 em advance;
- OFL 1.1, "(C) Copyright HanYang I&C Co.,Ltd.", no Reserved Font Name.

Its one gap is Hanja (0), which is covered by Noto Sans KR. The side-by-side check
`scratch/fonts/compare-malgun-substitute.png` (Chromium, real Malgun vs substitute vs Pretendard) shows
near-identical line widths, e.g. 638.3 vs 639.7 px, 707.2 vs 706.5 px, 450.3 vs 449.8 px.

### 2.7 The shipped composite `PoC Malgun Substitute` (`theme/fonts-malgun.css`)

The CSS is generated by `scratch/fonts/gen_fonts.py`: 6 rules per weight, 12 in total. All rules in a set
share identical descriptors: `font-weight: 1 549` (Regular) or `550 1000` (Bold), `font-style: normal`,
`font-display: block`. The weight ranges reproduce the builder rule (nearest of 400/700, ties → 700) for
every weight, and contain the requested mapping (100–500 → Regular, 600–900 → Bold).

Every face overrides `ascent = 108.8379% / s`, `descent = 24.1699% / s`, `line-gap = 0`, where `s` is its
`size-adjust`. CSS Fonts 5 scales overrides by `size-adjust`, so every face's effective metrics equal
Malgun's 2229/495/0 per 2048.

| order | role | file (R / B) | unicode-range | size-adjust R | size-adjust B | basis |
|---|---|---|---|---|---|---|
| 1 | catch-all: jamo, CJK symbols, fullwidth, enclosed, geometric, … | GothicA1-Regular / -Bold | (all) | 100% | 100% | Malgun = Gothic A1 = 1.000 em for ①■○▶ㆍ, jamo, fullwidth |
| 2 | Latin + punctuation (Selawik coverage minus space/digits) | selawk / selawkb | U+21-2F, U+3A-7E, U+A1-FF (partial), Latin Ext-A subset, U+2013-2014, U+2018-201A, U+201C-201E, U+2020-2022, U+2026, U+2030, U+2039-203A, U+20AC, U+2122 | 101.7949% | 99.3958% | corpus fit |
| 3 | digits | selawk / selawkb | U+30-39 | 102.1739% | 100.7640% | exact (both tabular) |
| 4 | space + NBSP | selawk / selawkb | U+20, U+A0 | 128.3422% | 127.4336% | exact |
| 5 | Hanja | NotoSansKR-VF (wght follows the CSS weight) | U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF | 100% | 100% | exact: 7,475/7,476 URO Hanja present, all 1.000 em |
| 6 | Hangul syllables | GothicA1-Regular / -Bold | U+AC00-D7A3 | 104.0650% | 100.3922% | exact |

Rule-order and descriptor mechanics:

- The catch-all comes first. CSS Fonts 4: "If the unicode ranges overlap for a set of @font-face rules with
  the same family and style descriptor values, the rules are ordered in the reverse order they were
  defined; the last rule defined is the first to be checked for a given character."
- CDP `CSS.getPlatformFontsForNode` on the 40-glyph mixed sample `매출액 1,284억 원 (YoY +12.4%) Q&A · 社 ①→ ㈜
  끝` (with an NBSP) reports: Gothic A1 for 9 glyphs (Hangul, ①, →, ㈜), Selawik for 30 (Latin, digits,
  punctuation, space, NBSP), and Noto Sans KR for 1 (社). In the embedded profile the same sample is
  Pretendard 39 + Noto Sans KR 1.
- CSS Fonts 4 defines the "first available font" (it drives `line-height: normal`) as the first font not
  excluding U+0020. Here that is the Selawik space face, whose overrides equal Malgun's.
- Selawik has no U+00A0 glyph. HarfBuzz's space fallback renders NBSP at the space advance: "가\u00a0가" =
  "가 가" = 235.125 px vs 235.156 px for real Malgun.

### 2.8 Chromium verification against REAL Malgun Gothic (`chrome_check.mjs`; Chromium 149.0.7827.55 headless, DSF 1) **H**

Setup: Malgun's bytes were read in place and served from memory with `Cache-Control: no-store`. Every
corpus line was laid out as `white-space: pre` inline-block at 13/16/20/24/32/100 px, weights 400/700,
with `--font-render-hinting=none`.

Ratio = substitute/Malgun; slack = Malgun/substitute. Line box and baselines are in px, substitute /
Malgun.

| family | w | px | ratio mean | sd | min .. max | slack p95 / p99 / max | line box (normal) | baseline (normal) | baseline (1.5) |
|---|---|---|---|---|---|---|---|---|---|
| PoC Malgun Substitute | 400 | 13 | 1.0004 | 0.0026 | 0.9941 .. 1.0080 | 1.0014 / 1.0030 / 1.0059 | 17 / 17 | 14 / 14 | 15 / 15 |
| PoC Malgun Substitute | 400 | 16 | 1.0006 | 0.0026 | 0.9939 .. 1.0083 | 1.0012 / 1.0030 / 1.0061 | 21 / 21 | 17 / 17 | 18 / 18 |
| PoC Malgun Substitute | 400 | 20 | 1.0006 | 0.0026 | 0.9944 .. 1.0081 | 1.0011 / 1.0027 / 1.0056 | 27 / 27 | 22 / 22 | 23 / 23 |
| PoC Malgun Substitute | 400 | 24 | 1.0011 | 0.0026 | 0.9948 .. 1.0085 | 1.0006 / 1.0023 / 1.0052 | 32 / 32 | 26 / 26 | 28 / 28 |
| PoC Malgun Substitute | 400 | 32 | 1.0011 | 0.0026 | 0.9950 .. 1.0087 | 1.0006 / 1.0022 / 1.0050 | 43 / 43 | 35 / 35 | 37 / 37 |
| PoC Malgun Substitute | 400 | 100 | 1.0012 | 0.0026 | 0.9951 .. 1.0087 | 1.0005 / 1.0021 / 1.0050 | 133 / 133 | 109 / 109 | 117 / 117 |
| PoC Malgun Substitute | 700 | 13 | 0.9997 | 0.0026 | 0.9815 .. 1.0068 | 1.0031 / 1.0089 / 1.0189 | 17 / 17 | 14 / 14 | 15 / 15 |
| PoC Malgun Substitute | 700 | 16 | 0.9994 | 0.0025 | 0.9824 .. 1.0063 | 1.0030 / 1.0086 / 1.0179 | 21 / 21 | 17 / 17 | 18 / 18 |
| PoC Malgun Substitute | 700 | 20 | 0.9995 | 0.0026 | 0.9820 .. 1.0064 | 1.0031 / 1.0087 / 1.0184 | 27 / 27 | 22 / 22 | 23 / 23 |
| PoC Malgun Substitute | 700 | 24 | 0.9998 | 0.0025 | 0.9825 .. 1.0066 | 1.0027 / 1.0083 / 1.0179 | 32 / 32 | 26 / 26 | 28 / 28 |
| PoC Malgun Substitute | 700 | 32 | 0.9999 | 0.0025 | 0.9827 .. 1.0068 | 1.0025 / 1.0081 / 1.0176 | 43 / 43 | 35 / 35 | 37 / 37 |
| PoC Malgun Substitute | 700 | 100 | 1.0002 | 0.0025 | 0.9828 .. 1.0070 | 1.0024 / 1.0080 / 1.0176 | 133 / 133 | 109 / 109 | 117 / 117 |
| Gothic A1 plain (reference) | 400 | 16 | 0.9553 | 0.0207 | 0.8880 .. 1.0049 | 1.0758 / 1.1166 / 1.1261 | 20 / 21 | 15 / 17 | 17 / 18 |
| Gothic A1 plain (reference) | 700 | 16 | 0.9780 | 0.0169 | 0.9223 .. 1.0169 | 1.0462 / 1.0834 / 1.0843 | 20 / 21 | 15 / 17 | 17 / 18 |

Where the residual comes from:

- In Chromium, the reference Malgun is kerned: its legacy table applies by default, worth ≤1%. Selawik has
  no kerning, and Gothic A1's GPOS kerning is ≤0.4%.
- The worst lines are Latin-heavy Bold lines (`Q&A` 1.0176) and `TCO(Total Cost of Ownership)…`.

Without the flag (default hinting), the same comparison is noisier (sd 0.24–0.9%, max slack 1.047 at
13 px), and line boxes differ by 1–2 px at 20/32 px because Malgun's hinted/VDMX metrics apply.

### 2.9 Slack factor recommendation (builder)

Measured worst cases for "Malgun line wider than what Chromium measured with the substitute":

- max **1.0189** (Bold 13 px, Latin-heavy line);
- p99 **1.009** (B) and **1.003** (R).

If PowerPoint does **not** kern Malgun while the Chromium reference did, PowerPoint lines get up to 1.0098
(R) / 1.0082 (B) wider on the worst line. That is usually a different line from the Latin worst case. If
PowerPoint kerns, lines only get narrower.

Recommendations:

- **malgun: widen wrapped (`wrap=true`) text boxes by 2% (factor 1.02).**
  - left-aligned text: widen to the right;
  - right-aligned text: widen to the left;
  - centered text: widen symmetrically.
- Single-line boxes (`wrap="none"`) never reflow; their visual drift is ≤ (slack − 1) × line width.
- **embedded: 1.02 while PowerPoint's GPOS-kerning behaviour is unknown** (unkerned Pretendard is up to
  1.83% wider, §1.6). If PowerPoint kerns like Chromium, 1.005 suffices.
- Both numbers assume `--font-render-hinting=none` (§3). With default hinting, the Chromium-vs-ideal error
  alone reaches −6.6…+4.2%, and no small slack is safe.

### 2.10 Known residual outliers (measured; all rare in business text)

| char | Malgun R | substitute R | effect |
|---|---|---|---|
| `\` U+005C | 0.7637 em (₩-width) | 0.386 | HTML narrower by 0.38 em each |
| `↑` `↓` | 0.9502 | 0.5957 | HTML narrower by 0.35 em each (`▲▼` exact) |
| `《》` / `「」` / `【】` | 0.596 / 0.571 / 0.518 | 0.538 / 0.538 / 0.567 | −10% / −6% / +9% |
| `※` / `→` / `Ⅰ–Ⅹ` / `₩` U+20A9 | 0.800 / 0.950 / 0.950 / 0.764 | 1.000 / 1.000 / 1.000 / 0.875 | HTML wider (safe direction) |
| CJK Ext-A Hanja | 1.000 | Noto has only 93 of Malgun's 6,582 | the rest fall back to the system font |
| Bold Latin | not a uniform scale of Segoe UI Bold | | per-glyph −5%…+5.7% |

## 3. Headless Chromium rounds glyph advances unless hinting is off (cross-team) **H**

`scratch/fonts/chrome_subpixel.mjs` renders Pretendard runs and compares Chromium's box, range and canvas
widths with the ideal HarfBuzz width:

| condition | `a`×100 at 16 px (ideal 856.25) | Hangul×50 at 17 px (ideal 734.62) | mixed line at 20 px (ideal 508.24) |
|---|---|---|---|
| default launch, DSF 1 / 1.5 / 2 / 3 | 800.000 (−6.57%) | 750.000 (+2.09%) | 500.000 (−1.62%) |
| CSS `text-rendering: geometricPrecision` | layout 856.250 exact; canvas still rounded | 734.625 | 508.250 |
| `--font-render-hinting=none` | 856.250 exact (layout, Range and canvas) | 734.625 | 508.250 |

Details:

- Default behaviour: each glyph advance is rounded to a whole CSS px, independent of DSF. A per-glyph
  rounding model (`round(advance × px)` summed) reproduces Chromium's corpus-line widths:
  - mean within 0.1% at 16–100 px, for both Malgun and Pretendard;
  - 0.6% at 13 px, where hinting changes some advances further.
- Chromium's own source (`headless/public/switches.h`) documents `--font-render-hinting`: "Sets font render
  hinting when running headless, affects Skia rendering and whether glyph subpixel positioning is enabled.
  Possible values: none|slight|medium|full|max. Default: full." **H**
- `--disable-font-subpixel-positioning` happened to give the same fractional result in this build (**L**
  as to why).
- Hinting also changes vertical metrics: hinted Malgun gives a 28 px line box at 20 px (linear 27) and 45 px
  at 32 px (linear 43).
- PowerPoint's layout is zoom-independent and therefore unhinted, so fractional advances are the right
  model (**M**).
- **Extractor: `chromium.launch({ args: ['--font-render-hinting=none'] })`.** The CSS alternative
  (`text-rendering: geometricPrecision` in `base.css`) fixes DOM layout only.

## 4. CSS files and `fonts.json`

- `theme/fonts-embedded.css`: 8 `@font-face` rules. For each weight range there is the Pretendard face,
  then a Hanja-only Noto Sans KR face with identical descriptors. `font-display: block`; the Pretendard
  faces have no overrides. Ends with `:root { --font-sans: "Pretendard", sans-serif; }`.
- `theme/fonts-malgun.css`: 12 `@font-face` rules (§2.7). Ends with
  `:root { --font-sans: "PoC Malgun Substitute", sans-serif; }`.
- URLs are relative to `theme/` (`url('../fonts/X.ttf')`). Both CSS files and `fonts/fonts.json` are
  generated by `scratch/fonts/gen_fonts.py`: edit the generator, not the output.
- `unicode-range` faces load lazily, so the extractor must `await document.fonts.ready` before measuring.
  Otherwise, with `font-display: block`, text inside a still-loading face is invisible and may mis-measure.
- `fonts/fonts.json` follows the CONTRACT schema exactly; `scratch/fonts/validate_fonts_json.py` → PASS.
  - Embedded `typeface` values come from name ID 1; `bold` iff name ID 2 = Bold.
  - malgun `measureFile` = the Gothic A1 file of that weight (the Hangul carrier). The companion files and
    every factor are in `notes`. A server-side width computation from `measureFile` alone would be wrong
    for Latin/space: apply the per-range factors, or better, rely on Chromium's layout.

Contents of `fonts/`, 25,835,646 B total. Only the Pretendard files are ever embedded:

| file | bytes | role | license |
|---|---|---|---|
| Pretendard-Regular/SemiBold/Bold/ExtraBold.ttf | 2,725,828 / 2,671,468 / 2,661,752 / 2,669,648 | embedded profile (embedded into PPTX) | `Pretendard-OFL.txt` |
| GothicA1-Regular/Bold.ttf | 2,295,400 / 2,287,068 | malgun substitute: Hangul, symbols | `GothicA1-OFL.txt` |
| selawk.ttf / selawkb.ttf | 44,224 / 44,068 | malgun substitute: Latin, digits, space | `Selawik-OFL.txt` (OFL-1.1, RFN "Selawik") |
| NotoSansKR-VF.ttf (= google/fonts `NotoSansKR[wght].ttf`, renamed file only) | 10,414,588 | Hanja in both profiles' CSS (never embedded) | `NotoSansKR-OFL.txt` (OFL-1.1, RFN "Source") |
| fonts.json | 3,927 | CONTRACT data | — |

## 5. LibreOffice 7.4.7.2 notes (Noah's preview; evidence about LibreOffice only) **H**

Test deck: `scratch/fonts/lo_test/lo_fonts.pptx` (python-pptx, latin/ea/cs typefaces), converted to PDF;
fonts listed with `pdffonts`.

| setup | 맑은 고딕 runs | Pretendard runs |
|---|---|---|
| stock image (`fonts-nanum` only) | DejaVu Sans (Latin) + NanumGothic (Hangul) | DejaVu Sans + NanumGothic |
| `fonts/` mounted into `/home/lo/.fonts` | DejaVu Sans + Gothic A1 (Hangul) + **NotoSansKR-Thin** (Hanja) | Pretendard-Regular/-Bold/-SemiBold/-ExtraBold, all 4 typefaces resolved |
| + fontconfig alias `scratch/fonts/lo_test/fc/fonts.conf` (맑은 고딕/Malgun Gothic → Selawik, Gothic A1), Noto not mounted | **Selawik (Latin) + Gothic A1 (Hangul)** + NanumGothic (Hanja) | (Pretendard not mounted in that run) |

What this means:

- `fc-match "맑은 고딕"` and `fc-match "Malgun Gothic"` → DejaVu Sans. There is no alias in the stock
  image. The "Malgun Gothic" strings in LibreOffice's `main.xcd` are per-language default-font lists, not
  replacements.
- **Do not install `NotoSansKR-VF.ttf` for LibreOffice.** LibreOffice 7.4 draws the variable font's
  default instance, which is *Thin*. For previews, mount only the four Pretendard files (embedded profile),
  or Gothic A1 + Selawik plus the alias above (malgun profile).
- Debian `fonts-nanum` 20200506-1 `NanumGothic.ttf` is byte-identical to Naver's 3.021 zip (SHA-256
  `48a28e97…e733`). Its outlines sit 0.044 em below the baseline (§1.8).
- The render shows LibreOffice widening the gap at every Hangul↔Latin/digit boundary ("1,284 억" gets a
  gap that is absent from the text). This is likely LibreOffice's Asian/non-Asian autospacing and is for
  the text-mapping lane to confirm and handle; it is a LibreOffice-only effect as far as known (**M**).

## 6. Self-tests executed (all on this machine, 2026-09-25)

1. `font_info.py` on every shipped file and on Malgun/Segoe UI in place: outline, fsType, names,
   metrics, coverage. Results in `scratch/fonts/info-*.json`.
2. `measure2.py`: 34 face comparisons vs Malgun (16 families × R/B + Selawik) → `measure2-results.json`.
3. `measure3.py` + inline S4 run: S0–S4 strategies → `measure3-results.json`.
4. `visual_similarity.py`: 286 syllables × 9 fonts × 2 weights → `visual-similarity.json`.
   Cross-checked against `glyf` bounds.
5. `chrome_check.mjs default|nohint` + `analyze_chrome.py`: Chromium 149 widths of 77 lines × 6 sizes × 2
   weights for real Malgun (in-memory, `no-store`), the substitute, Gothic A1 and Pretendard; line boxes;
   baselines; CDP platform fonts; NBSP → `chrome-results-*.json`, `chrome-analysis.json`.
6. `chrome_subpixel.mjs`: 7 launch/DSF/CSS conditions × 16 probes → `subpixel-results.json`.
7. `chrome_weights_and_sample.mjs`: 102 checks (17 weights × Hangul/Latin/Hanja × 2 profiles), CDP font per
   weight vs the builder rule → **0 mismatches** (`weight-resolution.json`); comparison PNG.
   The first version of the embedded Hanja face produced 12 mismatches; this led to the per-range fix
   (§0 item 3).
8. `chrome_hanja_linebox.mjs` / `chrome_vf_weight.mjs`: Hanja faces keep line boxes identical and follow
   the weight.
9. `validate_fonts_json.py` → PASS.
10. LibreOffice 7.4.7.2 conversions (stock, fonts mounted, alias) + `pdffonts` (§5).
11. Hygiene: no Windows font file exists under `$POC`; `git status` in `/home/jinyoung/noah-almighty` is
    clean.

SHA-256 of the shipped font files:

- `Pretendard-Regular.ttf` 6d0af5258997aec7354a6e340fc2325ba321c410ca48b3af858c8c3d6e92a324
- `Pretendard-SemiBold.ttf` 5e1c548732af70873103066c16e1369b9a8a871f0b38c321a1d5bc73e43cea2d
- `Pretendard-Bold.ttf` c16b88c670d23e83fa1170c954cbc4822d3b8dad3c3cde15d798a94b43d97985
- `Pretendard-ExtraBold.ttf` eedbd2877218242323bdff816684f7f5c325e54ae820d5b78eec9a5e5c7edef6
- `GothicA1-Regular.ttf` 211151bea98098c579610ab1114bb1bfe909057207db561f357b896d076c21ac
- `GothicA1-Bold.ttf` 2e883fa0ae548000996258b4101f2bb732a28b197264f49621a2cb16d6e9f126
- `selawk.ttf` e9d98518d8ac2817782a9a382430463a2e0793ea68350b695bb727d9a830ee1c
- `selawkb.ttf` f0db5e174a90e0956ad7d2844bdca1d5e6da92ec65b2c04e57ba9b180668c904
- `NotoSansKR-VF.ttf` 194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252

## 7. Open risks (only real PowerPoint can settle these)

| risk | confidence it is fine | notes |
|---|---|---|
| PowerPoint embeds and renders the 4 static TTFs with editing enabled (fsType 0) | **H** for eligibility (Microsoft Support + OS/2 spec); **M** for rendering | embedding mechanics belong to the font-embedding lane |
| PowerPoint resolves `Pretendard SemiBold` / `Pretendard ExtraBold` (name ID 1 families with only a regular slot) | **M** | LibreOffice/fontconfig resolves all four; GDI family = name ID 1 |
| PowerPoint's Malgun Gothic advances equal the `hmtx` advances (unhinted, fractional layout) | **M** | Office layout is zoom-independent; not measurable here |
| PowerPoint kerning: whether/when it applies Malgun's legacy `kern` table and Pretendard's GPOS kerning (`kern` attr threshold) | **L** | effect ≤1.0% (Malgun) and ≤1.83% (Pretendard) per line; covered by slack 1.02 |
| PowerPoint's fallback font for Hanja in Pretendard runs is 1.000 em wide | **M** | Malgun Gothic and virtually every CJK font use 1.000 em Hanja |
| The malgun substitute's residual (max 1.9% on Latin-heavy Bold lines) is below the slack | **H** in Chromium; PowerPoint **M** | |
| Hanja outside Noto Sans KR (most of CJK Ext-A) and emoji fall back to server fonts | **H** that it happens | rare in business slides |
| Blink behaviour relied on (unicode-range order, per-descriptor grouping, size-adjust × overrides) may change in future Chromium versions | **M** | verified on Chromium 149.0.7827.55; the generator's self-tests re-check it |
| Selawik's RFN/trademark | **H** fine as shipped | unmodified, used only for HTML measurement, never embedded |

## 8. Sources

- Pretendard releases API: https://api.github.com/repos/orioncactus/pretendard/releases
- Pretendard 1.3.9 zip: https://github.com/orioncactus/pretendard/releases/download/v1.3.9/Pretendard-1.3.9.zip
- Pretendard Std zip: https://github.com/orioncactus/pretendard/releases/download/v1.3.9/PretendardStd-1.3.9.zip ; README https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard-std/README.md
- Pretendard LICENSE (main): https://raw.githubusercontent.com/orioncactus/pretendard/main/LICENSE
- OpenType OS/2 (fsType, USE_TYPO_METRICS, usWin*): https://learn.microsoft.com/en-us/typography/opentype/spec/os2
- Microsoft Support, "Some of your fonts can't be saved with the presentation": https://support.microsoft.com/en-us/powerpoint/some-of-your-fonts-can-t-be-saved-with-the-presentation
- Microsoft Support, "Benefits of embedding custom fonts": https://support.microsoft.com/en-us/office/benefits-of-embedding-custom-fonts-cb3982aa-ea76-4323-b008-86670f222dbc
- TTEmbedFont (t2embed): https://learn.microsoft.com/en-us/windows/win32/api/t2embapi/nf-t2embapi-ttembedfont
- RDP PowerPoint FAQ, embedding fonts: https://www.rdpslides.com/pptfaq/FAQ00076_Embedding_fonts.htm
- CSS Fonts 4 (unicode-range overlap order, first available font, weight matching): https://www.w3.org/TR/css-fonts-4/
- CSS Fonts 5 (size-adjust scales overrides; ascent/descent/line-gap-override): https://www.w3.org/TR/css-fonts-5/
- Chromium headless switch `--font-render-hinting`: https://raw.githubusercontent.com/chromium/chromium/main/headless/public/switches.h
- google/fonts: https://github.com/google/fonts/tree/main/ofl/gothica1 , /ofl/nanumgothic , /ofl/notosanskr (upstream: https://github.com/notofonts/noto-cjk Sans2.004) , /ofl/ibmplexsanskr , /ofl/gowundodum , /ofl/sunflower , /ofl/astasans , /ofl/nanumgothiccoding
- Naver Hangeul fonts: https://hangeul.pstatic.net/hangeul_static/webfont/zips/nanum-gothic.zip , …/nanum-barun-gothic.zip , …/nanum-square-neo.zip
- Selawik: https://github.com/microsoft/Selawik (README: "open source replacement for Segoe UI"); release 1.01 https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip ; https://raw.githubusercontent.com/microsoft/Selawik/master/LICENSE.txt
- Other candidates (GitHub releases): spoqa/spoqa-han-sans v3.3.0, sun-typeface/SUIT v2.0.5, wanteddev/wanted-sans v1.0.3, poposnail61/min-sans v1.4.2, Freesentation/paperlogy 1.001

## 9. Reproduce

```sh
# regenerate fonts.json + both CSS files (reads Malgun in place; needs the Windows mount)
/home/jinyoung/pptx-poc/.venv/bin/python scratch/fonts/gen_fonts.py
/home/jinyoung/pptx-poc/.venv/bin/python scratch/fonts/validate_fonts_json.py
# measurements
/home/jinyoung/pptx-poc/.venv/bin/python scratch/fonts/measure2.py
/home/jinyoung/pptx-poc/.venv/bin/python scratch/fonts/measure3.py
node scratch/fonts/chrome_check.mjs nohint && /home/jinyoung/pptx-poc/.venv/bin/python scratch/fonts/analyze_chrome.py
node scratch/fonts/chrome_weights_and_sample.mjs
```
