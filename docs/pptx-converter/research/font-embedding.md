# Embedding a TrueType font in a .pptx for PowerPoint (Microsoft 365, Windows)

> **Historical PoC evidence, preserved for maintainers — not agent-facing.** Written in the HTML→PPTX
> proof of concept before its port into Noah (2026-09) and copied here unchanged below this note. Paths such
> as `scratch/…`, `tools/…`, `out/…`, `fonts/…`, `theme/…`, `slides/…`, `docs/…` and `$POC` refer to that PoC
> tree, and machine paths (`/home/jinyoung/…`, `/mnt/c/Windows/Fonts`) to its dev box — Windows fonts were
> only ever READ in place there, never copied. The shipped converter is `default-skills/skills/pptx/converter/`;
> see [`docs/architecture/pptx-converter.md`](../../architecture/pptx-converter.md) and
> [the index of this directory](../README.md).

Research + the spec implemented in `tools/eot.py` and `tools/embed_fonts.py`. Status: **complete** (2026-09-25).
Experiments, downloaded sources and sample decks: `scratch/font-embed/`.

Nobody on the team can run PowerPoint. Every statement below is marked by where it comes from:
**[spec]** Microsoft/ECMA/W3C text, **[PPT-sample]** bytes of files saved by real PowerPoint, **[field]** third-party
files that went through real PowerPoint, **[code]** source of another implementation, **[local]** something executed
here (LibreOffice renders are evidence about LibreOffice, not about PowerPoint). What only PowerPoint can settle is
listed in §7 with a confidence level.

---

## 0. The implemented spec in one table

| Item | What `embed_fonts` writes | Main evidence |
|---|---|---|
| Part | `/ppt/fonts/fontN.fntdata`, one part per face (lowest free N) | [PPT-sample] every PowerPoint deck; [code] POI `XSLFRelation.FONT` |
| Content type | `<Default Extension="fntdata" ContentType="application/x-fontdata"/>` | [spec] ECMA-376 §15.2.13 + [MS-OI29500] 2.1.32; [PPT-sample]; pandoc #11492 (missing → repair prompt) |
| Relationship | `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"` `Target="fonts/fontN.fntdata"` in `ppt/_rels/presentation.xml.rels` | [spec] ECMA §15.2.13; [PPT-sample] |
| List | `<p:embeddedFontLst>` right after `<p:notesSz>`/`<p:smartTags>`; one `<p:embeddedFont>` per typeface: `<p:font typeface= [panose=] pitchFamily= charset=/>` then `regular`, `bold`, `italic`, `boldItalic` (only those present, in this order) | [spec] pml.xsd `CT_Presentation`, `CT_EmbeddedFontListEntry` |
| Attributes | `embedTrueTypeFonts="1"`; `saveSubsetFonts` **removed** | [spec] ECMA §19.2.1.26; [PPT-sample] correlation of `saveSubsetFonts` with the SUBSET flag; RDP FAQ |
| Font data | **EOT 0x00020002, Flags = 0** (no MicroType Express, no XOR, no subsetting) + the unmodified TTF; header fields from the font; FamilyName = the XML typeface | [spec] W3C EOT; [spec] t2embed `TTEMBED_RAW` is the default; [field] byte-identical to Canva's parts, which went through Windows PowerPoint 16 edit/save cycles (§2.4) |
| Permissions | accept fsType Installable (0) and Editable (0x0008); refuse Restricted (0x0002 only), Bitmap-only (0x0200), and Preview&Print (0x0004, would make the deck read-only) | [spec] OpenType OS/2, W3C EOT §4.1, t2embed; [spec] Microsoft support |
| Fonts accepted | static TrueType-outline (`glyf`) sfnt; TTC, CFF/`OTTO` and variable (`fvar`) rejected | [spec] ECMA §15.2.13 (no collections); tdf#166778 (CFF), tdf#167214 (variable) |
| Usage rule | a typeface the deck never references is skipped with a warning | [spec] [MS-OE376]/[MS-OI29500] embeddedFontLst note b |

Behavioural guarantees of `embed_fonts(pptx_in, pptx_out, faces)`: groups faces by typeface; validates every
face (slot, file readable, typeface is one of the font's own name-ID-1 strings, fsType, font kind); removes
previous entries/relationships/parts for the same typefaces (idempotent: a re-run is byte-identical); keeps other
embedded fonts byte-for-byte; IN may equal OUT (temp file, verified with `verify_pptx` *before* the atomic replace,
so a failure writes nothing); `[Content_Types].xml` written first; problems already present in the input (foreign
fonts) are reported as warnings, only new ones are fatal. CLI: `tools/embed_fonts.py IN OUT --profile embedded`,
`--face TF:SLOT:FILE`, `--verify DECK`, `--allow-unused`, `--allow-preview-print`.

---

## 1. Package level

### 1.1 What PowerPoint itself writes [PPT-sample]

Samples (all `docProps/app.xml` = `Microsoft Office PowerPoint 16.0000` unless noted), decoded with
`scratch/font-embed/eothdr.py` / `tools/eot.py dump`:

- LibreOffice test data `sd/qa/unit/data/BoldonseFontEmbedded.pptx` and `sd/qa/unit/data/pptx/tdf167214.pptx`.
- LibreOffice Bugzilla attachments 201325 / 201405 (tdf#166778) and 202204 (tdf#167826, "created by MS
  PowerPoint 2016").
- A survey of 83 extracted decks on GitHub (`scratch/font-embed/src/other/gh-samples/survey.txt`, 385 font
  parts), including Windows PowerPoint 14/15/16, Mac PowerPoint 16, and a deck saved on **Korean Windows**
  (`kocanory/CSE_homeworks`, 인간컴퓨터상호작용/팀플/7조_Final_PT_0610).

Observed in all 5 LibreOffice/Bugzilla samples and in all 52 surveyed decks whose `app.xml` names PowerPoint and
that carry an `embeddedFontLst` (checked by `ctcheck.py`; some of the 52 are Canva exports, which also claim
PowerPoint in `app.xml`):

- `[Content_Types].xml`: `<Default Extension="fntdata" ContentType="application/x-fontdata"/>`, never an Override.
- Parts `ppt/fonts/font1.fntdata`, `font2.fntdata`, …; relationship type `…/officeDocument/2006/relationships/font`,
  `Target="fonts/fontN.fntdata"`, from the presentation part.
- `<p:presentation … embedTrueTypeFonts="1">`, plus `saveSubsetFonts="1"` in decks saved with "Embed only the
  characters used" (§1.5, including one anomaly).
- `<p:embeddedFontLst>` directly after `<p:notesSz>` (before `<p:defaultTextStyle>`).
- `<p:font>` attributes, e.g. `typeface="Calibri" panose="020F0502020204030204" pitchFamily="34" charset="0"`;
  `typeface="Boldonse" pitchFamily="2" charset="0"` (panose omitted when the font's PANOSE is all zero);
  Korean Windows: `typeface="맑은 고딕" panose="020B0503020000020004" pitchFamily="50" charset="-127"` and
  `typeface="나눔스퀘어OTF" panose="020B0600000101010101" pitchFamily="34" charset="-127"`.

### 1.2 Content type [spec]

- ECMA-376 Part 1 (5th ed. 2016) §15.2.13 Font Part lists three content types: `application/x-fontdata` ("the font
  shall be stored in the Embedded OpenType Format of http://www.w3.org/Submission/2008/SUBM-EOT-20080305"),
  `application/x-font-ttf` (plain OpenType; TrueType Collections cannot be used), and
  `application/vnd.openxmlformats-officedocument.obfuscatedFont` ("Only packages of type WordprocessingML are
  permitted to reference this content type"). A Font part is the target of an explicit relationship from the
  Presentation part and has no relationships of its own.
- [MS-OI29500] 2.1.32 (Part 1 §15.2.13): for `application/x-font-ttf` "PowerPoint does not use this content type";
  for `application/x-fontdata` "PowerPoint stores TrueType and OpenType fonts ([Embed-Open-Type-Format],
  [Micro-Type-Exp-Format]) in parts of this type. Word does not read or write this content type." The same notes
  appear in [MS-OE376] 2.1.34.
- Field failure mode: pandoc copied `.fntdata` parts without registering the content type, and PowerPoint (Windows
  and Mac 16.x) "reports the file is corrupt and offers to repair it" (jgm/pandoc#11492). `embed_fonts` always
  writes the Default and `verify_pptx` checks that every part has a content type.

### 1.3 Part name and relationship [spec] [code]

The part name is not normative (LibreOffice ≥ 25.8 writes `ppt/fonts/Font_1_<Family>_<Style>.fntdata`); what
matters is the relationship type + the content type. We use PowerPoint's own `fontN.fntdata` (also POI's default,
`XSLFRelation.FONT = ("application/x-fontdata", "…/relationships/font", "/ppt/fonts/font#.fntdata")`), taking the
lowest N whose name is free case-insensitively (OPC part names compare case-insensitively). Relationship ids need
not be sequential (OPC); we take max(rIdN)+1.

### 1.4 `<p:embeddedFontLst>` structure and position [spec]

From the ECMA-376 transitional schema `pml.xsd` (Part 4 zip, `OfficeOpenXML-XMLSchema-Transitional.zip`):

```
CT_Presentation sequence: sldMasterIdLst? notesMasterIdLst? handoutMasterIdLst? sldIdLst? sldSz? notesSz
                          smartTags? embeddedFontLst? custShowLst? photoAlbum? custDataLst? kinsoku?
                          defaultTextStyle? modifyVerifier? extLst?
CT_EmbeddedFontList      = embeddedFont*            (CT_EmbeddedFontListEntry)
CT_EmbeddedFontListEntry = font (a:CT_TextFont), regular?, bold?, italic?, boldItalic?   -- in this order
CT_EmbeddedFontDataId    = @r:id (required)
a:CT_TextFont            = @typeface (required, string), @panose (hexBinary, length 10),
                           @pitchFamily (ST_PitchFamily = xsd:byte ∈ {0,1,2,16,17,18,32,33,34,48,49,50,64,65,66,80,81,82}),
                           @charset (xsd:byte — SIGNED, default 1)
@embedTrueTypeFonts, @saveSubsetFonts: xsd:boolean, default false
```

Microsoft's additional requirements ([MS-OI29500] 2.1.1100 = [MS-OE376] 2.1.1134): "PowerPoint further requires
that the typeface of each embeddedFont element shall be unique" and "PowerPoint further requires that all of the
fonts specified in this list shall be used in this presentation." `embed_fonts` rejects case-only duplicates and
skips unreferenced typefaces (it scans every `typeface=` in slides, layouts, masters, notes, themes, charts and
the presentation's defaultTextStyle).

### 1.5 `embedTrueTypeFonts` / `saveSubsetFonts` — effect on open and on re-save

- ECMA §19.2.1.26: `embedTrueTypeFonts` "Specifies whether the generating application should automatically embed
  true type fonts or not"; `saveSubsetFonts` "Specifies to save only the subset of characters used in the
  presentation when a font is embedded". [MS-OI29500] 2.1.1108 (presentation) has no deviation note for either, so
  PowerPoint follows the standard text.
- These are the persisted state of File › Options › Save › "Embed fonts in the file" and "Embed only the characters
  used (best for reducing file size)" vs "Embed all characters (best for editing by other people)" (RDP PPT FAQ
  00076). [PPT-sample] confirms the mapping: in the survey, all 119 PowerPoint-written parts in decks with
  `saveSubsetFonts="1"` carry TTEMBED_SUBSET (flags 0x5), and 49 of 51 PowerPoint-written parts in decks without it
  are full fonts (flags 0x4). The exception: the Korean-Windows deck's two 맑은 고딕 parts are subset (0x5; libeot
  decode shows 28 215 glyph ids but only 276 cmap entries) although the deck has no `saveSubsetFonts` — PowerPoint may
  subset some large CJK fonts regardless (cause unknown).
- **On open**: LibreOffice imports the list only when `embedTrueTypeFonts` is true (`presentationfragmenthandler.cxx`
  → `EmbeddedFontListContext(…, mbEmbedTrueTypeFonts, …)`, commit 248b8267). For PowerPoint, every sample with
  embedded fonts has it; whether PowerPoint loads the list without it is untested — we always set it.
- **On re-save**: with `embedTrueTypeFonts="1"` and no `saveSubsetFonts`, the next PowerPoint save re-embeds the fonts
  **in full** ("Embed all characters"), so the deck stays editable for the next person. python-pptx's default
  template sets `saveSubsetFonts="1"`; `embed_fonts` removes it. [field] A Canva-originated deck edited for 4056
  minutes and re-saved by Windows PowerPoint 16 (`Rishabh-chaurasia/Sandha3`) still holds the original uncompressed
  parts next to PowerPoint's own re-embedded MTX parts, i.e. PowerPoint preserved embedded fonts it did not have
  installed.
- Side effect to know: with embedding on, a PowerPoint re-save embeds *every* font the deck uses, including
  master/theme fonts (python-pptx's default theme uses Calibri) → larger file, and "Some of your fonts can't be
  saved" if any used font is restricted. Builder guidance in §9.

### 1.6 `docProps/app.xml`

PowerPoint lists "Fonts Used" in `HeadingPairs`/`TitlesOfParts`; it is extended-properties metadata, not read to
load fonts (python-pptx decks never list fonts there and open fine). `embed_fonts` does not touch it.

---

## 2. Font data format inside `.fntdata`

### 2.1 The structure [spec]

W3C Member Submission "Embedded OpenType (EOT) File Format" (2008-03-05, https://www.w3.org/submissions/EOT/):
little-endian header, then `FontData[FontDataSize]`. Versions 0x00010000 (ends after FullName), 0x00020001 (+
Padding5, RootString), 0x00020002 (+ RootStringCheckSum, EUDCCodePage, Padding6, SignatureSize/Signature,
EUDCFlags, EUDCFontSize/EUDCFontData). MagicNumber 0x504C. Processing flags: TTEMBED_SUBSET 0x1,
TTEMBED_TTCOMPRESSED 0x4 (MicroType Express, https://www.w3.org/Submission/MTX/), TTEMBED_XORENCRYPTDATA
0x10000000 (XOR 0x50 over FontData after compression); others are creation-time only. RootStringCheckSum = (sum of
RootString bytes) XOR 0x50475342; a mismatch means "tampered". The structure is exactly the output of Windows'
`TTEmbedFont` (t2embed), whose `ulFlags` "TTEMBED_RAW — Return a font structure containing the full character set,
non-compressed. This is the default behavior of the function"; `TTLoadEmbeddedFont` loads such structures.

Other readers treat `.fntdata` as EOT: Apache POI `FontHeader.init` throws "not a EOT font data stream" unless the
version is one of the three and the magic is 0x504C; LibreOffice's import decodes it with libeot
(`EOT2ttf_buffer`) and says in commit faf45f80 "The fonts are usually EOT fonts so this needs libEOT to work".

### 2.2 What PowerPoint writes [PPT-sample]

| Sample | Flags | Charset | Italic byte | Names | EUDCCodePage | Notes |
|---|---|---|---|---|---|---|
| Win PPT 16, Boldonse / Filepile (no saveSubsetFonts) | 0x4 | 0 | 0 | family/style NUL-terminated | 1252 | full font, MTX |
| Win PPT 16, Calibri family (saveSubsetFonts=1) | 0x5 | 0 | 0 / **0xFF** | idem | 1252 | subset keeps glyph count (7042 glyphs) but trims cmap to 156 entries |
| Win PPT 16, Noto Sans Black **CFF** OTF | 0x4 | 0 | 0 | idem | 1252 | CFF not subset; libeot cannot decode it |
| Win PPT 16, Figtree **variable** font | 0x4 | 0 | 0/0xFF | idem | 1252 | the upright and italic VFs (fvar/gvar) each stored twice (4 slots, identical data under Regular/Bold and Italic/Bold Italic headers); MSO then reports the font unavailable (tdf#167214) |
| Win PPT 16 on **Korean Windows**, 맑은 고딕 | 0x5 | **129** | 0 | FamilyName **`맑은 고딕`** (localized), FullName `Malgun Gothic` | **949** | |
| Mac PPT 16, Aptos SemiBold / Gilroy / UCL Sans | 0x4 | 0 | 0/0xFF | no terminator | — | |
| POI `test-data/slideshow/font.fntdata` (Harlow Solid Italic) | 0x5 | 0 | 0xFF | NUL on family/style | 1252 | |

Version is always 0x00020002, never XOR. So **PowerPoint always writes MTX**; the field values it writes come from
GDI (`TEXTMETRIC.tmCharSet`, `tmItalic` = 0xFF, the UI-language family name, the ANSI code page).

### 2.3 What other generators write [code] [field]

| Generator | Version / Flags | Charset / Italic | Names | EUDCCodePage |
|---|---|---|---|---|
| LibreOffice ≥ 25.8 PPTX export (`vcl/source/font/EOTConverter.cxx`, commit d0ee08cf) | 0x00020002 / **0** | 0 / fsSelection&1 | English, NUL-terminated | 1252 |
| sfntly `EOTWriter` (Google; Google Fonts' IE EOTs; POI committer's PPTX exporters `kiwiwings/pptx-shape-exporter`, `kiwiwings/poi-font-mbender` use MTX) | 0x00020002 / 0 or 0x4 | **1** / fsSelection&1 | English (3,1,0x409), no terminator | 0 |
| **Canva** PPTX export (signature: core.xml created `2006-08-16T00:00:00Z`, AppVersion 14.0000, "Canva Sans" parts) | 0x00020002 / **0** | 1 / fsSelection&1 | no terminator | 0 |
| **tools/eot.py** (this PoC) | 0x00020002 / **0** | 1 / fsSelection&1 | no terminator; FamilyName = the XML typeface | 0 |

[local] `ttf_to_eot()` applied to the payloads of two Canva parts reproduces the Canva `.fntdata` files
**byte-for-byte** (`canva-netra-font1.fntdata` 121 212 B, `canva-sandha-font1.fntdata` 39 440 B).

### 2.4 Does Windows PowerPoint read uncompressed EOT (flags 0)? — evidence and verdict

For:
1. [spec] Compression is a per-file flag in the EOT format, and uncompressed (`TTEMBED_RAW`) is t2embed's *default*
   output, which `TTLoadEmbeddedFont` loads. [MS-OI29500] 2.1.32 names both EOT and MTX as the formats of the part;
   [MS-PPT] 2.11.5 `FontEmbedDataBlob` (binary .ppt) likewise only says "as specified in [Embed-Open-Type-Format]".
2. [field] Canva's PPTX export writes uncompressed EOT (385-part survey: 63 flags-0 parts — 60 in the Canva/sfntly
   v0x00020002 layout, 3 v0x00020001 parts from another web generator; none written by PowerPoint; the Canva decks
   were last modified in 2025–2026, the Canva metadata dates themselves are synthetic). A Canva user on Microsoft Q&A
   (thread 5384670, 2024-11-16), about Canva fonts before that date: "When I download my finished
   presentation from Canva to my laptop (as a PPTX) the fonts display exactly as they were in Canva. Up until last
   week." "Last week" is the Windows PowerPoint 2410 regression that broke **all** embedded fonts, including
   PowerPoint's own (Glyphs forum 32030 repro: embed in PPT → uninstall font → reopen → fallback; Q&A 2120886:
   "working on version 2407 … 2410 (build 18129.20116) they no longer work"), fixed in Current Channel **2411
   (Build 18227.20152, 2024-12-05): "We fixed an issue where an embedded font wouldn't render if the file was opened
   offline"** (Semi-Annual Enterprise 2502 Build 18526.20472).
3. [field] Canva decks re-saved by Windows PowerPoint 16 after long edits keep their flags-0 parts alongside
   PowerPoint's own MTX parts (Sandha3: TotalTime 4056 min; ZinaoSU/suzinao-portfolio: 2952 min, four flags-0 parts
   of which three are Chinese fonts; ShubhamGarje99/netra modified 2026-02-19), so PowerPoint opens and saves them
   without repair and does not discard them. (This proves acceptance by the package loader and pass-through on save,
   not by itself that the glyphs were rendered.)
4. [code] LibreOffice ≥ 25.8 exports flags 0 and has shipped that for a year with no bug report of PowerPoint
   rejecting it (Bugzilla searched: "embedded font pptx", "EOT PowerPoint", "embed fonts pptx export").

Against: PowerPoint itself never writes flags 0 (every sample is MTX), and no source shows a Microsoft engineer
stating that raw EOT is read.

**Verdict:** uncompressed, unobfuscated, full-font EOT 0x00020002 with the Canva/sfntly header layout. It is the
simplest format, it keeps the TTF bytes intact, and in the byte-identical Canva form it has field evidence in Windows
PowerPoint. Confidence that current M365 renders it: **~85 %** (§7). Plan B if a real-PowerPoint test fails:
MicroType Express (flags 0x4) — see §2.6.

### 2.5 Header fields `tools/eot.py` writes (and why)

| Field | Value | Source |
|---|---|---|
| EOTSize / FontDataSize | total / TTF length | W3C |
| Version / Flags | 0x00020002 / 0 | §2.4 |
| FontPANOSE | OS/2.panose | W3C; PPT and Canva do the same |
| Charset | 0x01 DEFAULT_CHARSET | W3C ("no preference"); sfntly/Canva. PowerPoint writes GDI's value (0, or 129 on Korean Windows) — informational, t2embed's loader takes no charset |
| Italic | 0x01 if OS/2.fsSelection bit 0 | W3C text; sfntly/Canva/LO (PowerPoint writes 0xFF) |
| Weight, fsType, UnicodeRange1-4, CodePageRange1-2 | OS/2 (CodePage = 1,0 for OS/2 v0, as sfntly) | W3C |
| CheckSumAdjustment | head.checkSumAdjustment | W3C |
| Reserved1-4, paddings | 0 | W3C |
| FamilyName | the deck's typeface; must be one of the font's name-ID-1 strings (English by default) | W3C says English name ID 1; PowerPoint on Korean Windows writes the localized one = its XML typeface; keeping FamilyName == XML typeface mirrors PowerPoint in either locale |
| StyleName / VersionName / FullName | English name IDs 2 / 5 / 4, no terminator | W3C; sfntly/Canva |
| RootString / RootStringCheckSum | empty / 0x50475342 | W3C §4.3.2 (PPT, LO, sfntly, Canva identical) |
| EUDCCodePage, Signature, EUDC | 0, none, none | sfntly/Canva |
| FontData | the TTF, unmodified | — |

`parse_eot()` reads all three versions and every flag combination, validates sizes/magic/root checksum, XOR-decodes
if flagged, and reports MTX. `verify_eot()` cross-checks every header field against the embedded font.

### 2.6 Plan B: MicroType Express

If §7 test 1 fails while the package is accepted, switch Flags to 0x4 and MTX-compress FontData (CTF glyf/cvt/hdmx
transforms + LZCOMP). Reference encoder: sfntly `MtxWriter` (~1.5 kLOC Java, "tested extensively against IE",
repackaged in `kiwiwings/poi-font-mbender/src/de/kiwiwings/sfntly/eot/`); validation: libeot `eot2ttf` (available in
the `pptx-poc-fontembed-lo-fedora` image) must round-trip the outlines, and PowerPoint's own parts can be decoded
with it for comparison. Not implemented (no evidence it is needed).

---

## 3. Embedding permissions (OS/2 fsType) and editability

### 3.1 Semantics [spec]

OpenType spec, OS/2 `fsType` (https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype):
- bits 0-3 usage permission, valid values 0/2/4/8: **0 Installable** ("may be embedded, and may be permanently
  installed"); **2 Restricted License** ("must not be modified, embedded or exchanged"); **4 Preview & Print**
  ("Documents containing Preview & Print fonts must be opened 'read-only'; no edits may be applied"); **8 Editable**
  ("editing is permitted, including ability to format new text using the embedded font, and changes may be saved").
- 0x0100 **No subsetting** ("must not be subsetted prior to embedding"); 0x0200 **Bitmap embedding only** ("No outline
  data may be embedded … otherwise the font is considered unembeddable").
- "applications must not modify the embedding permissions … when embedding a font"; for OS/2 v0-2 with several of bits
  0-3 set, the least restrictive may be assumed (W3C EOT §4.1 says the same).
- t2embed `TTLoadEmbeddedFont` `pulPrivStatus`: EMBED_PREVIEWPRINT → "can only be opened as read-only. The application
  must not allow the user to edit the document"; EMBED_EDITABLE → "may be opened 'read/write,' with editing
  permitted"; EMBED_INSTALLABLE; EMBED_NOEMBEDDING.

### 3.2 What PowerPoint does per level

- Microsoft Support "Some of your fonts can't be saved with the presentation" (PowerPoint M365/2016-2024, Win+Mac):
  Editable/Installable → "can be embedded"; Preview/Print → "can be embedded, but on a computer that doesn't have the
  font installed, the presentation can only be opened for viewing and printing, not editing"; Restricted → cannot be
  embedded; also Type 1 and AAT fonts cannot be embedded.
- Microsoft 365 Blog "Document font embedding demystified" (2015): Print and preview → "the document is locked and
  cannot be edited"; Editable → "allows the document to be edited using that embedded font".
- RDP PPT FAQ 00076 (PowerPoint MVP): with Editable/Installable "you can edit the text, add more text in the same
  font, and save the changes with the font still embedded"; Preview/Print decks can be shown but changes cannot be
  saved with the font re-embedded. User reports quote the prompt "This presentation cannot be edited because it
  contains one or more read-only embedded (restricted) fonts".
- [PPT-sample] PowerPoint on Korean Windows did embed a Preview&Print font (나눔스퀘어OTF, fsType 0x0004; its payload
  makes libeot abort exactly like the CFF Noto Sans Black part, so it is most likely CFF), so such decks exist; they
  open read-only on PCs without the font.

### 3.3 Editable vs read-only; full vs subset

Text is editable with the embedded font when (a) the fsType level is Installable or Editable and (b) the embedded
data covers the characters being typed. Subset embedding ("Embed only the characters used", TTEMBED_SUBSET) keeps
glyph ids but drops unused glyphs and cmap entries [PPT-sample], so new characters fall back ("limits editing of the
file using the same font" — Microsoft Support "Benefits of embedding custom fonts"). We therefore embed the **full**
font and remove `saveSubsetFonts`.

### 3.4 Policy implemented

`eot.check_editable_embedding`: bitmap-only → refuse; level 0 or bit 3 set → accept; bit 2 (without 3) → refuse
unless `allow_preview_print=True`; restricted/unknown → refuse. fsType is copied, never modified. NanumGothic,
Pretendard and Monoton are fsType 0 (OFL, installable).

---

## 4. How PowerPoint maps runs to embedded faces

1. **The string must match.** The run's `<a:latin|ea|cs typeface>` must be the same string as
   `<p:embeddedFont><p:font typeface>` ([MS-OI29500] 2.1.1397 d: Office "uses this typeface attribute for all text when
   a typeface is available, and uses font substitution logic when the typeface is not available"). That string must
   be a family name the loaded font answers to: the **legacy family, OpenType name ID 1** (GDI's family model), not the
   typographic family (ID 16). `embed_fonts` rejects a typeface that is not one of the font's name-ID-1 strings.
2. **Non-RIBBI weights** are their own typeface in the `regular` slot with `b="0"`: [PPT-sample] `Calibri Light`
   (name ID 1 "Calibri Light", weight 300) regular+italic; Mac PowerPoint `Aptos SemiBold` (600) regular+italic.
   fonts.json follows this (`Pretendard SemiBold`, `Pretendard ExtraBold` in `regular`).
3. **Slots follow the requested style**, not the file's weight: runs of typeface T with `b="1"` use T's `bold` slot,
   `i="1"` → `italic`, both → `boldItalic` ([PPT-sample] PowerPoint put the single weight-900 "Noto Sans Black" face
   into `bold` because the runs using it were bold; on Korean Windows it wrote `나눔스퀘어OTF Bold` — its own legacy
   family — with only a `bold` slot, for bold runs in that typeface). If a style's slot is missing, expect PowerPoint
   to synthesize it from the regular face (fake bold/italic).
4. **Localized names**: on Korean Windows PowerPoint wrote `typeface="맑은 고딕"` in the XML *and* as the EOT
   FamilyName (the UI-language name ID 1), with the English name only in FullName. A font with both names
   (NanumGothic: "NanumGothic" / "나눔고딕") should answer to both, since GDI and DirectWrite match localized family
   names (general Windows behaviour, not verified here — risk #7). We use the **English** name ID 1 (portable across
   UI languages; Pretendard has only English names) and write the same string as EOT FamilyName.
5. **charset** = GDI charset from OS/2 code-page bits, written signed: Korean Wansung (bit 19) → HANGUL_CHARSET 0x81 =
   **`-127`** (what Korean-Windows PowerPoint writes); Latin-only → 0. Used only for substitution when the font is
   unavailable ([MS-OI29500] 2.1.1397 b; ECMA §19.2.1.13).
6. **pitchFamily** = GDI lfPitchAndFamily, best effort from PANOSE (family type, serif style, proportion) and
   `post.isFixedPitch`, following Wine's GDI emulation (`dlls/win32u/freetype.c`). Matches the samples for Calibri,
   Arial Black, Noto Sans, Comic Sans, Bernard MT, Boldonse and 나눔스퀘어OTF; real GDI reports 50 (MODERN) for
   Malgun Gothic and Filepile where the rule gives 34 and 2. Substitution-only ([MS-OI29500] 2.1.1397 c).
7. **panose**: "Office does not implement the panose attribute" ([MS-OI29500] 2.1.1397 a). Written from OS/2 when
   non-zero (as PowerPoint does); NanumGothic's PANOSE is all zero, so omitted.
8. [field] Canva does it differently: `<p:font typeface="Canva Sans Bold"/>` + `<p:regular>` holding the Bold face
   (EOT FamilyName "Canva Sans", FullName "Canva Sans Bold"), runs `<a:latin typeface="Canva Sans Bold"/>` with `b="1"`.
   If that renders (Canva users say their fonts display), PowerPoint's matching is more lenient than our scheme
   needs (e.g. by full name, or by renaming each loaded embedded font — `TTLoadEmbeddedFont` lets the client pass a
   new family name). Our scheme (ID-1 family + style slots, FamilyName == typeface) is what PowerPoint itself writes,
   so it does not depend on that leniency.

---

## 5. Known limits

- **Font kinds**: TrueType-outline only. CFF-flavoured OTF: M365 PowerPoint can embed it (flags 0x4) but libeot
  cannot decode it (tdf#166778, "libEOT is missing OTF fix"), and older guidance says PowerPoint embeds TrueType
  data only (RDP FAQ). Variable fonts: PowerPoint embeds the whole VF, then MSO "gives warning that embedded fonts
  are not available" (tdf#167214) → use static instances (fonts.json already does). TTC: not allowed (ECMA
  §15.2.13). Type 1 / AAT: not embeddable (Microsoft Support).
- **Size**: no documented limit. Uncompressed EOT ≈ TTF size: NanumGothic ×2 = 4.1 MB raw → **1.48 MB** after zip
  deflate (deck 1.51 MB); Pretendard ×4 = 10.7 MB raw → **4.73 MB** (deck 4.76 MB). PowerPoint's MTX parts are
  ~40-50 % of the TTF, so our decks are larger than a PowerPoint save of the same fonts.
- **Count**: four slots per typeface; no documented cap on typefaces.
- **Platforms**: Windows desktop PowerPoint; subscription Mac PowerPoint 16.11+ reads/writes embedded fonts (RDP FAQ:
  "As of early 2019 … Version 16.11 and later"; Mac samples in the survey). PowerPoint for the web is not a target (the 2015 Microsoft blog says web/mobile do not support embedding;
  users report "READ ONLY This presentation contains read-only embedded fonts" there).
- **Enterprise policy**: with Windows "Untrusted Font Blocking" enabled (GPO *Mitigation Options › Untrusted Font
  Blocking*), Microsoft documents: "Using desktop Office to look at documents with embedded fonts. In this situation,
  content shows up using a default font picked by Office" (Event 260 example: "WINWORD.EXE attempted loading a font
  that is restricted by font-loading policy. FontType: Memory"). This hits PowerPoint's own embedded fonts too; the
  remedy is installing the font or excluding POWERPNT.EXE.
- **Same-name installed font**: `TTLoadEmbeddedFont` reports E_FONTNAMEALREADYEXISTS / E_FONTALREADYEXISTS; an
  installed font of the same family is used instead of the embedded one. An *organizational* (cloud) font with the
  same name made embedded-font files fail with an install error until Current Channel 2502/2503 (release notes).
- **PowerPoint build regressions**: 2410 (Build 18129.20116) broke embedded-font rendering for all producers; fixed
  in 2411 (Build 18227.20152). Test on an up-to-date build.
- **LibreOffice / Noah preview**: LibreOffice 7.4 (Noah production) does not import PPTX embedded fonts (feature added
  in 25.8, and only with libeot) → the preview server must have the fonts **installed**. LibreOffice ≥ 25.8 built
  with libeot (Fedora 26.2 here) does use them.

---

## 6. Self-tests executed ([local])

All scripts are in `scratch/font-embed/`; fonts downloaded there from google/fonts (NanumGothic Regular/Bold,
Monoton; OFL). Results as actually observed. After analysis, every sample that carried Microsoft fonts (Calibri,
Calibri Light, Harlow Solid Italic, a 맑은 고딕 subset) or Canva's proprietary fonts — including the decoded TTFs and the
two re-zipped foreign decks — was deleted from the PoC tree (spirit of the no-Windows-fonts rule); they can be
re-fetched from the URLs in §10 (`survey.py`/`ctcheck.py` in `src/other/gh-samples/` redo the survey). The OFL /
public-domain samples (Boldonse, Figtree, Filepile, Noto Sans Black, NanumSquare) are kept.

1. `selftest.py` — **60/60 checks pass**: EOT self-check for NanumGothic Regular/Bold; localized FamilyName accepted;
   typeface-not-in-font rejected; parser rejects bad magic / bad EOTSize / bad RootStringCheckSum; fsType policy for
   0x0000, 0x0008, 0x0004, 0x0002, 0x0208, 0x0108, 0x000C, 0x0006; python-pptx decks with Korean text in NanumGothic
   (regular + bold) embedded via the API, and in all four Pretendard faces via the CLI `--profile embedded`; for each:
   `verify_pptx` clean, `zipfile.testzip` clean, `[Content_Types].xml` first, all XML well-formed, **presentation.xml
   valid against the ECMA-376 transitional `pml.xsd`** (negative controls — embeddedFontLst after defaultTextStyle,
   charset="129", regular after bold — are rejected by the same validator), embedTrueTypeFonts=1, saveSubsetFonts
   absent, Default fntdata = application/x-fontdata, every `.fntdata` header version 0x00020002 / flags 0 /
   FamilyName = typeface, **payload byte-identical to the source TTF**, python-pptx re-opens and reads the Korean
   text; idempotency (re-embed IN==OUT → byte-identical file, still 2 parts); unused typefaces skipped with a warning;
   re-embedding fewer faces removes the stale part; error paths (wrong typeface, bad slot, duplicate slot, variable
   font) raise `EmbedError` and write nothing.
2. `tools/eot.py dump` parses all 25 PowerPoint/POI/Canva sample parts; Canva's two pass the full cross-check;
   `ttf_to_eot` reproduces both Canva files byte-for-byte.
3. libeot `eot2ttf` (Fedora image) decodes our NanumGothic `.fntdata` back to **byte-identical** TTFs.
4. Open XML SDK 3.3.0 `OpenXmlValidator(FileFormatVersions.Microsoft365)` (dotnet/sdk:8.0 container,
   `oxval/`): **0 errors** for plain and embedded decks alike; the SDK resolves `FontPart`s as `application/x-fontdata`
   and reads `EmbeddedFont typeface=NanumGothic charset=-127 pitchFamily=2 regular=rId8 bold=rId9`.
5. LibreOffice renders (`lo_render.sh`; `pdffonts` shows which fonts LibreOffice actually used — evidence about
   LibreOffice only):
   - **Fedora LO 26.2.6.3 + libeot, no Korean font installed**: plain deck → NotoSans + Type 3 tofu; embedded deck →
     **NanumGothic + NanumGothicBold**; plain deck with the font installed → the same, **pixel-identical** (max diff 0)
     to the embedded render. Pretendard deck embedded → **Pretendard Regular, SemiBold, Bold, ExtraBold** (non-RIBBI
     typefaces in `regular` slots load too).
   - **Debian LO 7.4.7.2 (= Noah production)**: embedded Pretendard deck renders exactly like the plain one (DejaVu +
     NanumGothic fallback) → 7.4 ignores PPTX embedded fonts; with Pretendard installed → Pretendard.
   - LO 26.2 re-save of our deck keeps NanumGothic embedded (its own uncompressed EOT), plus a quirk: it adds the
     fallback font (Noto Sans) and points the NanumGothic `italic` slot at the bold file.
6. python-pptx open → save of an embedded deck keeps the font parts, the Default and embedTrueTypeFonts (`verify_pptx`
   clean).
7. Foreign decks (re-zipped from the survey, `scratch/font-embed/foreign/`): embedding NanumGothic into a Canva→Windows
   PowerPoint 16 deck (2 Canva parts) and into the Korean-Windows PowerPoint 16 deck (4 PowerPoint parts, 34 MB) keeps
   every existing `.fntdata` byte-identical, adds ours as the next free `fontN`, yields a schema-valid
   presentation.xml; the Canva deck's pre-existing typeface/FamilyName mismatch is reported as a warning, not fatal.
8. CLI smoke tests: `--face`, `--profile embedded`, `--verify`; a wrong typeface ("Nanum Gothic") exits 1 with the
   font's actual family names in the message. A verification failure injected with IN == OUT leaves the input
   byte-identical and no temp file behind.
9. Open XML SDK (Microsoft365) on the final test-kit decks and the foreign decks after embedding: 0 errors for the kit
   and the Canva deck; the Korean PowerPoint deck has 3 errors before and after (all in `chart1.xml` chart extensions,
   unrelated to fonts) — embedding added none.

---

## 7. What only real PowerPoint can confirm (open risks)

| # | Question | Confidence | Basis |
|---|---|---|---|
| 1 | Current Windows PowerPoint M365 **renders** text with our uncompressed EOT on a PC without the font | ~85 % | §2.4: byte-identical to Canva's parts (field-reported working before the 2410 regression, which hit every producer and was fixed in 2411), spec/t2embed default, LibreOffice export |
| 2 | Opens **without a repair prompt** | ~90 % | schema-valid (ECMA pml.xsd), Open XML SDK M365 validation 0 errors, PowerPoint's own package conventions (content-type Default, rel type, part names, position) |
| 3 | Text is **editable** with the font (no read-only prompt; typing new Hangul uses the font) | ~85 % | fsType 0 + full font; Microsoft support/blog, RDP FAQ; contingent on #1 |
| 4 | **Re-save** keeps the fonts, still full (not subset) | ~75 % | embedTrueTypeFonts=1 & no saveSubsetFonts (= "Embed all characters"); Sandha3 shows PowerPoint preserving foreign embedded parts; but a Korean deck shows PowerPoint subsetting 맑은 고딕 without saveSubsetFonts (§1.5); untested whether PowerPoint re-writes our parts as MTX |
| 5 | `b="1"` runs pick the `bold` slot (NanumGothic Bold, Pretendard Bold) rather than synthetic bold | ~85 % | PowerPoint's own slot usage (§4.3) |
| 6 | Non-RIBBI typefaces (`Pretendard SemiBold`, `Pretendard ExtraBold` in `regular`) resolve | ~85 % | PowerPoint's own Calibri Light / Aptos SemiBold entries; LibreOffice loads them |
| 7 | The English typeface ("NanumGothic") works on Korean Windows although PowerPoint itself would write "나눔고딕" | ~80 % | the embedded name table carries both names; GDI/DirectWrite match any localized family name; Pretendard has only English names anyway |
| 8 | Header choices (charset 1, italic 0x01, no NUL terminators, EUDCCodePage 0) are accepted | ~85 % | identical to Canva's field-proven parts; W3C spec values |
| 9 | Protected View (files downloaded from Noah carry Mark-of-the-Web): embedded fonts show before "Enable Editing" | unknown (~50 %) | no source found |
| 10 | Corporate PCs with Untrusted Font Blocking enabled | will fall back (documented by Microsoft) | policy, not format — ask IT whether the GPO is on |
| 11 | Performance / file size acceptable for ~5 MB decks | high | PowerPoint embeds CJK fonts of this size itself |

---

## 8. PowerPoint test protocol (for someone with Windows PowerPoint M365)

Test kit: `scratch/font-embed/ppt-test-kit/` (`\\wsl.localhost\Ubuntu-24.04\home\jinyoung\pptx-poc\scratch\font-embed\ppt-test-kit`),
built by `make_test_kit.py`; slide 2 of each deck shows the expected look (LibreOffice render using only the
embedded font).

1. Use a PC where **Monoton, NanumGothic and Pretendard are NOT installed** (check `C:\Windows\Fonts` and
   `%LOCALAPPDATA%\Microsoft\Windows\Fonts`). Update PowerPoint (≥ 2411). Copy the decks locally (avoid Protected View
   for the first run; test Protected View separately — risk #9).
2. Open `embed-test-monoton.pptx` → no repair prompt (#2); slide 1 in neon-tube letters like slide 2 (#1). A plain
   sans-serif means the embedded font was not used.
3. Click into the text and type → new characters also neon (#3); no read-only bar.
4. `embed-test-nanumgothic.pptx`: Hangul in NanumGothic, bold run in NanumGothic Bold (compare with slide 2) (#1, #5,
   #7); type new Hangul (#3).
5. `embed-test-pretendard.pptx`: four visibly different weights 400/600/700/800 (#5, #6).
6. File › Options › Save: "Embed fonts in the file" checked, "Embed all characters" selected (#4). Save as a new
   file, close, reopen on the same font-less PC → still rendered; optionally send the saved file back so
   `tools/eot.py dump` can show what PowerPoint re-wrote.

---

## 9. Guidance for the PPTX builder

- Runs: `<a:latin>`, `<a:ea>`, `<a:cs>` typeface = the face's `typeface` from fonts.json, **exactly** (case, spaces);
  `b="1"` only for the face in the typeface's `bold` slot; non-RIBBI faces use their own typeface with `b="0"`. Mirror
  `pitchFamily="2" charset="-127"` on run fonts if you like (optional). Put `lang="ko-KR"` on Hangul runs.
- Point the theme's `majorFont`/`minorFont` latin/ea/cs at the profile's regular typeface, so masters/placeholders
  don't reference Calibri or 맑은 고딕 (otherwise a user's re-save embeds those too).
- Call `embed_fonts(...)` after the final python-pptx `save()` (a later python-pptx round trip is also safe, tested).
  Don't set `saveSubsetFonts`; don't subset fonts; don't edit fsType.
- Every embedded typeface must be used somewhere in the deck (unused ones are skipped with a warning).
- `malgun` profile: never embed (`file: null`) — 맑은 고딕 ships with Windows and must not be redistributed.
- Noah's LibreOffice 7.4 preview ignores embedded fonts: install the profile's fonts on the preview server.

---

## 10. Sources

Microsoft (specs and product documentation)
- [MS-OI29500] 2.1.32 Font Part — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d
- [MS-OI29500] 2.1.1100 embeddedFontLst — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/fb2ecab1-17a1-4552-bac3-8df949321ba8
- [MS-OI29500] 2.1.1102 font (Embedded Font Name) — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/2799f9b3-d0b8-4e5f-9494-80ecda8934e7
- [MS-OI29500] 2.1.1397 latin (panose / charset / pitchFamily / typeface notes) — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/e6784cb7-1547-4ee5-addc-730cac8b4d00
- [MS-OI29500] 2.1.1108 presentation — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/5cc61456-aa4e-4c48-a115-3efed3e57d95
- [MS-OE376] 2.1.34 Font Part — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/1663dabc-5d98-463f-889e-bcd9b77c3d34
- [MS-OE376] 2.1.1134 embeddedFontLst — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/e3870782-1f40-4ef1-a3a8-01ee13661283
- [MS-OE376] 2.1.1135 font — https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/3f7627bd-cb99-4b8e-86dc-b3ebce9318da
- [MS-PPT] 2.11.5 FontEmbedDataBlob — https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/09f6010a-4a6d-4ba7-a05a-1acab10322fd ; 2.9.12 FontEmbedFlags10Atom — https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/ec744545-6e72-4d64-8280-d96ac7b28a04
- t2embed TTEmbedFont — https://learn.microsoft.com/en-us/windows/win32/api/t2embapi/nf-t2embapi-ttembedfont ; TTLoadEmbeddedFont — https://learn.microsoft.com/en-us/windows/win32/api/t2embapi/nf-t2embapi-ttloadembeddedfont
- OpenType OS/2 fsType — https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype
- Support: Some of your fonts can't be saved with the presentation — https://support.microsoft.com/en-us/powerpoint/some-of-your-fonts-can-t-be-saved-with-the-presentation
- Support: Benefits of embedding custom fonts — https://support.microsoft.com/en-us/office/benefits-of-embedding-custom-fonts-cb3982aa-ea76-4323-b008-86670f222dbc
- Microsoft 365 Blog, Document font embedding demystified (2015) — https://www.microsoft.com/en-us/microsoft-365/blog/2015/07/06/document-font-embedding-demystified/
- Block untrusted fonts in an enterprise — https://learn.microsoft.com/en-us/windows/security/operating-system-security/device-management/block-untrusted-fonts-in-enterprise
- Release notes, Current Channel (2411 Build 18227.20152; 2502 Build 18526.20144; 2503 Build 18623.20156) — https://learn.microsoft.com/en-us/officeupdates/current-channel ; Semi-Annual Enterprise Channel (2502 Build 18526.20472) — https://learn.microsoft.com/en-us/officeupdates/semi-annual-enterprise-channel
- Microsoft Q&A: 2410 regression — https://learn.microsoft.com/en-us/answers/questions/2120886/embedded-fonts-dont-work-on-windows-powerpoint-aft , https://learn.microsoft.com/en-us/answers/questions/5352171/embedded-fonts-dont-work-on-windows-powerpoint-aft ; Canva fonts — https://learn.microsoft.com/en-us/answers/questions/5384670/fonts-in-powerpoint-are-available-but-not-working

Standards
- ECMA-376 5th edition (2016) Parts 1 and 4 — https://ecma-international.org/publications-and-standards/standards/ecma-376/ (zips: https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip , https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip): §15.2.13, §19.2.1.9/10/13/16/26, `pml.xsd`, `dml-main.xsd`
- W3C EOT submission — https://www.w3.org/submissions/EOT/ ; MicroType Express — https://www.w3.org/Submission/MTX/

Source code
- Apache POI: `FontHeader` https://github.com/apache/poi/blob/trunk/poi/src/main/java/org/apache/poi/common/usermodel/fonts/FontHeader.java ; `XSLFFontInfo` https://github.com/apache/poi/blob/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/XSLFFontInfo.java ; `XSLFFontData` https://github.com/apache/poi/blob/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/XSLFFontData.java ; `XSLFRelation` https://github.com/apache/poi/blob/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/XSLFRelation.java ; test data https://github.com/apache/poi/blob/trunk/test-data/slideshow/font.fntdata
- LibreOffice: `vcl/source/font/EOTConverter.cxx`, `sd/source/filter/eppt/pptx-epptooxml.cxx` (WriteEmbeddedFontList), `oox/source/ppt/EmbeddedFontListContext.cxx`, `oox/source/ppt/presentationfragmenthandler.cxx`, `vcl/source/gdi/embeddedfontsmanager.cxx` — https://github.com/LibreOffice/core ; commits d0ee08cfbf12, faf45f80e196, 248b826786e2, fdd24dabb6f8 ; test decks `sd/qa/unit/data/BoldonseFontEmbedded.pptx`, `sd/qa/unit/data/pptx/tdf167214.pptx`
- LibreOffice Bugzilla: tdf#166778 https://bugs.documentfoundation.org/show_bug.cgi?id=166778 , tdf#167214 https://bugs.documentfoundation.org/show_bug.cgi?id=167214 , tdf#167826 https://bugs.documentfoundation.org/show_bug.cgi?id=167826
- sfntly EOTWriter/MtxWriter (repackaged) — https://github.com/kiwiwings/poi-font-mbender ; original https://github.com/googlefonts/sfntly ; exporter https://github.com/kiwiwings/pptx-shape-exporter
- Wine GDI emulation (tmPitchAndFamily) — https://github.com/wine-mirror/wine/blob/master/dlls/win32u/freetype.c

Field reports and samples
- POI user list, "Font embedding into XSLF" (2013) — https://user.poi.apache.narkive.com/h6NgHJr1/font-embedding-into-xslf
- pandoc #11492 — https://github.com/jgm/pandoc/issues/11492 ; PptxGenJS #176 — https://github.com/gitbrent/PptxGenJS/issues/176
- Glyphs forum "PowerPoint PC embedding bug" — https://forum.glyphsapp.com/t/powerpoint-pc-embedding-bug/32030 ; https://github.com/schriftgestalt/FontTechKnowledge/blob/main/cases/win/ppt/embedding.markdown
- RDP PPT FAQ 00076 — https://www.rdpslides.com/pptfaq/FAQ00076_Embedding_fonts.htm
- Embedding hazards / read-only prompts — https://www.silverfoxprod.com/blog/hazards-of-embedding-fonts-in-powerpoint-templates , https://samuelpinches.com.au/hacking/problems-embedding-fonts-in-powerpoint-mac-pc-and-online/
- GitHub-extracted decks (survey): https://github.com/Rishabh-chaurasia/Sandha3/tree/HEAD/.deck-inspect , https://github.com/ZinaoSU/suzinao-portfolio/tree/HEAD/public/ppt-extracted , https://github.com/ShubhamGarje99/netra/tree/HEAD/ppt_unpacked , https://github.com/kocanory/CSE_homeworks (Korean Windows deck)
- pptxboss PRs #14/#16 (claims only, no PowerPoint testing) — https://github.com/4thel00z/pptxboss/pull/14 , https://github.com/4thel00z/pptxboss/pull/16
- Fonts: https://github.com/google/fonts/tree/main/ofl/nanumgothic , https://github.com/google/fonts/tree/main/ofl/monoton

---

## 11. Verification (independent adversarial review, 2026-09-26)

Reviewer's scope: re-derive, from primary sources only (not from §0-§10), what a `.fntdata` part must contain and how
`presentation.xml` must declare it; then check `tools/eot.py` / `tools/embed_fonts.py` byte by byte, run the
existing self-test, and test with an independently written parser. Scratch: `scratch/font-embed-verify/`.
Status: **complete** (2026-09-26). Result: no byte-level defect in the EOT writer or the package layout; two robustness
bugs in `embed_fonts` fixed (§11.5); new field evidence raises the confidence that PowerPoint renders raw EOT (§11.4, §11.6).

### 11.1 Primary sources re-fetched

All fetched fresh into `scratch/font-embed-verify/src/` on 2026-09-26 (not reused from `scratch/font-embed/`; the two
ECMA zips were re-downloaded and are SHA-256-identical to the implementer's copies).

| Source | What it settles |
|---|---|
| W3C EOT submission https://www.w3.org/submissions/EOT/ (`w3c/EOT-submission.txt`) | Field order/sizes of all three versions; "All values in the EMBEDDEDFONT structure, with the exception of FontData and EUDCFontData are in Intel (little-endian) format"; Charset "DEFAULT_CHARSET (0x01) indicates no preference"; Italic "the value will be 0x01"; names = "Array of UTF-16 characters the length of FamilyNameSize bytes … English language … name ID = 1/2/5/4" (no terminator mentioned); MTX is "should" for authoring tools, while user agents "must implement support for decompressing" (i.e. raw is the base case); RootStringCheckSum = byte sum XOR 0x50475342 |
| ECMA-376 5th ed. Part 1 §15.2.13 (`ecma/p1.txt`) | `application/x-fontdata` = "stored in the Embedded OpenType Format of http://www.w3.org/Submission/2008/SUBM-EOT-20080305"; Font part = target of an explicit relationship from the Presentation part; no relationships of its own; TTC not allowed |
| ECMA-376 Part 1 §19.2.1.1/2/9/10/13/26 | slot elements carry `r:id`; §19.2.1.13: if the run's `latin` properties, the `p:font` properties, or the Font part's properties disagree, "the determination whether to use that embedded font is application-dependent behavior"; `embedTrueTypeFonts` / `saveSubsetFonts` are save-time settings |
| ECMA-376 Part 4 §13.2.13 | Transitional relationship type `http://schemas.openxmlformats.org/officeDocument/2006/relationships/font` |
| ECMA-376 transitional `pml.xsd` / `dml-main.xsd` / `shared-commonSimpleTypes.xsd` | `CT_Presentation` sequence (… `notesSz`, `smartTags?`, `embeddedFontLst?`, `custShowLst?` …); `CT_EmbeddedFontListEntry` = `font`, `regular?`, `bold?`, `italic?`, `boldItalic?`; `CT_TextFont`: `typeface` required, `panose` = hexBinary length 10, `pitchFamily` = `ST_PitchFamily` (xsd:byte enumeration 0,1,2,16,17,18,32,33,34,48,49,50,64,65,66,80,81,82), `charset` = xsd:byte default 1 |
| [MS-OI29500] 2.1.18 c (Presentation Part) | "Office only allows the Presentation part to have an explicit relationship with a Font part" |
| [MS-OI29500] 2.1.32 (Font Part) | x-font-ttf: "PowerPoint does not use this content type"; x-fontdata: "PowerPoint stores TrueType and OpenType fonts ([Embed-Open-Type-Format], [Micro-Type-Exp-Format]) in parts of this type" |
| [MS-OI29500] 2.1.1100 / 2.1.1102 / 2.1.1397 a-d | typeface of each embeddedFont unique; every listed font must be used; `p:font` inherits the `latin` notes: panose not implemented, charset/pitchFamily = substitution hints "determined by querying the font", typeface used for all text when available |
| [MS-OI29500] 2.1.1108 (presentation) | no deviation note for `embedTrueTypeFonts`/`saveSubsetFonts` |
| t2embed `TTEmbedFont` / `TTLoadEmbeddedFont` (learn.microsoft.com) | `TTEMBED_RAW`: "full character set, non-compressed. This is the default behavior"; loader returns `pulPrivStatus` (PREVIEWPRINT → "can only be opened as read-only", EDITABLE → "read/write") and E_FONTNAMEALREADYEXISTS / E_FONTALREADYEXISTS for installed same-name fonts |
| Apache POI trunk `FontHeader.java`, `XSLFFontInfo.java`, `XSLFRelation.java` | reader: same field order, LE, version ∈ {0x00010000, 0x00020001, 0x00020002}, magic 0x504C, names `trim()`med (NUL optional), each name ≤ 1000 bytes (`strictAllocateCheck`); writer: `/ppt/fonts/font#.fntdata`, `application/x-fontdata`, `…/relationships/font`, typeface = EOT FamilyName, sets `embedTrueTypeFonts` **and** `saveSubsetFonts` |
| LibreOffice master `EOTConverter.cxx`, `pptx-epptooxml.cxx` (commit d0ee08cfbf12, 2025-02-27) | writer: v0x00020002, Flags 0, Charset 0, Italic fsSelection&1, English names NUL-terminated, EUDCCodePage 1252; XML: `embedTrueTypeFonts="1"` (no `saveSubsetFonts`), list right after `notesSz`, `<p:font typeface/>` only. Gerrit 184288 review has no statement about testing with PowerPoint |
| libeot `src/EOT.c` (the decoder LibreOffice uses) | reader offsets identical (e.g. `+22` = CheckSumAdjustment + Reserved1-4 + Padding1); strings need even size; header must end exactly where EOTSize − FontDataSize says |
| sfntly `EOTWriter.java` (googlefonts/sfntly) | writer: Charset 1, Italic fsSelection&1, (3,1,0x409) names without terminator, RootStringCheckSum 0x50475342, EUDCCodePage 0, CodePageRange = 1/0 for OS/2 v0 — the layout `ttf_to_eot` reproduces |

### 11.2 EOT header — field-by-field check

Checked with `scratch/font-embed-verify/indep_check.py`, whose parser is a field table transcribed from the W3C
§3.3 table (no code shared with `tools/eot.py`), plus its own sfnt reader (table directory, OS/2, head, name; it
recomputes every table checksum and the whole-font checkSumAdjustment). The parser was first validated on
PowerPoint-written MTX parts (LibreOffice test decks `BoldonseFontEmbedded.pptx`, `tdf167214.pptx`, re-fetched from
GitHub): header end == EOTSize − FontDataSize for all 5 parts.

| Field (W3C order) | `ttf_to_eot` writes | Verdict |
|---|---|---|
| EOTSize, FontDataSize, Version, Flags (4×ULONG LE) | total length; TTF length; 0x00020002; 0 | correct (header + FontDataSize == EOTSize in every part) |
| FontPANOSE[10], Charset, Italic | OS/2.panose; 0x01; 0x01 iff fsSelection bit 0 | correct per W3C ("DEFAULT_CHARSET (0x01) indicates no preference"; "the value will be 0x01") |
| Weight (ULONG), fsType (USHORT), MagicNumber (USHORT) | usWeightClass; OS/2.fsType; 0x504C at offset 34 | correct |
| UnicodeRange1-4, CodePageRange1-2, CheckSumAdjustment | OS/2 / head values | correct (all equal the embedded font's own values) |
| Reserved1-4, Padding1-6 | 0 | correct; Padding1 at offset 80 |
| FamilyName/StyleName/VersionName/FullName (size USHORT + UTF-16LE) | typeface / English IDs 2, 5, 4; even sizes; no terminator | correct. No NUL is required by W3C; and since every name is followed by a zero USHORT (Padding2…5), even a reader that assumes NUL termination reads the right string |
| Padding5, RootStringSize, RootString | 0, 0, empty | correct |
| RootStringCheckSum, EUDCCodePage | 0x50475342 (= 0 XOR key); 0 | correct |
| Padding6, SignatureSize, EUDCFlags, EUDCFontSize | 0, 0, 0, 0 | correct |
| FontData | the TTF, byte-identical | correct; the embedded fonts' table checksums and checkSumAdjustment verify, head magic 0x5F0F3CF5 |

Also confirmed: Apache POI 5.4.1 `FontHeader` (Maven Central jars, `scratch/font-embed-verify/poi/`) parses every
part with familyName == typeface and eotSize == part length; libeot's offsets (read from its source) are the same.

**Charset header vs `p:font charset`.** `ttf_to_eot` writes EOT Charset 1 while `p:font` says -127 (Hangul) or 0.
No producer writes exactly this pair, and ECMA-376 §19.2.1.13 makes disagreement "application-dependent". PowerPoint's
fresh embeds are usually consistent (Boldonse 0/`0`; Korean Windows 129/`-127`), and pure Canva exports write
`charset="1"` over Charset 1. Mismatches are common in PowerPoint's own output, though: its Figtree deck has a bare
`p:font` (default 1) over Charset 0, and its re-saves of Canva decks write `charset="0"` over Charset 1. Windows
PowerPoint M365 also rendered LibreOffice's raw parts, whose Charset 0 disagrees with their bare `p:font` (§11.4,
LibreOffice bug 170931). Not changed; kept as a low risk (§11.6 #7).

### 11.3 Package side — field-by-field check

Checked by `indep_check.py` (own OPC/XML code; the `CT_Presentation` order is read from `pml.xsd` itself, not from
`embed_fonts.PRES_CHILDREN`), by lxml `XMLSchema(pml.xsd)`, by Apache POI 5.4.1 `XMLSlideShow.getFonts()`
(XMLBeans-bound model) and by Open XML SDK 3.3.0 (`FileFormatVersions.Microsoft365`).

| Item | Written | Verdict |
|---|---|---|
| `[Content_Types].xml` | `<Default Extension="fntdata" ContentType="application/x-fontdata"/>`, first zip item | correct (§15.2.13; every part resolves to a content type; no duplicate declarations; no stale Overrides) |
| Relationship | `Type=".../officeDocument/2006/relationships/font"` (ECMA Part 4 §13.2.13), `Target="fonts/fontN.fntdata"`, internal, from `ppt/_rels/presentation.xml.rels` | correct; every font relationship is referenced by a slot (explicit, [MS-OI29500] 2.1.18 c); font parts have no `.rels`; the SDK resolves each slot to a `FontPart` |
| `<p:embeddedFontLst>` position | after `notesSz`/`smartTags`, before `custShowLst` … | correct; tested with `custShowLst`, `kinsoku`, `defaultTextStyle`, `modifyVerifier` present (case 4) |
| `<p:embeddedFont>` | `p:font` first, then `regular`/`bold`/`italic`/`boldItalic` in schema order | correct; schema-valid; typefaces unique (case-insensitive) and referenced by the deck |
| `typeface` | the font's name-ID-1 string (e.g. `Pretendard SemiBold`) | correct (= EOT FamilyName = POI `FontHeader.familyName`) |
| `charset` | signed xsd:byte from OS/2 code pages: `-127` (0x81 HANGUL) for Pretendard/NanumGothic, `0` for Monoton | schema-valid; same values Korean-Windows PowerPoint writes. See the Charset note in §11.2 |
| `pitchFamily` | `2` | in `ST_PitchFamily`; substitution hint only ([MS-OI29500] 2.1.1397 c) |
| `panose` | OS/2 PANOSE of the regular face, 20 hex digits; omitted when all zero | correct; Office ignores it (2.1.1397 a) |
| `embedTrueTypeFonts` / `saveSubsetFonts` | `"1"` / removed | correct (§19.2.1.26; POI and SDK read `true` / unset) |
| ZIP | CRCs OK, names unique case-insensitively, deflate/stored only, no encryption | correct |

### 11.4 Tests executed (all in `scratch/font-embed-verify/`)

1. **Existing self-test** (`selftest_orig_copy.py` = byte-identical copy of `scratch/font-embed/selftest.py`, so its
   outputs land in my scratch): **60/60** before and after my changes.
2. **`run_verify.py`** (own python-pptx decks → `embed_fonts` API/CLI → `indep_check.py`): **25/25** after the fixes.
   Cases: 4 Pretendard faces via `--profile embedded`; NanumGothic regular+bold via the API, re-embedded IN==OUT
   (byte-identical); Latin-only Monoton (charset 0); crowded `p:presentation` siblings plus pre-existing implicit font
   relationships; fonts referenced only through the theme (`+mn-lt`/`+mn-ea`); a real PowerPoint 16 deck
   (`BoldonseFontEmbedded.pptx`, re-fetched from LibreOffice's repo) edited with python-pptx, where its MTX part stays
   byte-identical; typeface spelled with a different case; fsType 0x0000/0x0008/0x0108 accepted and
   0x0004/0x0002/0x0200 refused. Before the fixes: 21/23, and the case-mismatch repro dropped the font.
3. `indep_check.py` on PowerPoint's own decks (Boldonse, tdf167214): 0 ERROR, which also validates the checker.
4. **Apache POI 5.4.1** (`poi/PoiFontCheck.java`, Java 17): every deck, the 3 test-kit decks and the Boldonse sample
   open. Every facet is parsed by POI's `FontHeader` with `familyName == typeface` and `eotSize ==` part length (exit 0).
5. **Open XML SDK 3.3.0**, Microsoft365 (`oxsdk/`): **0 errors** on all 7 generated decks (final code, including
   cases 4 and 8) and on a plain control.
6. **LibreOffice 26.2.6.3 + libeot** (Fedora image, none of the fonts installed; LibreOffice evidence only):
   `pdffonts` shows Pretendard Regular/SemiBold/Bold/ExtraBold, NanumGothic + NanumGothicBold and Monoton-Regular,
   and the Hangul is visibly drawn in 4 weights. The plain control uses NotoSans + Type 3 tofu.
   **LibreOffice 7.4.7.2** (`pptx-poc-lo`, Noah production): the embedded Pretendard deck falls back to DejaVu Sans +
   NanumGothic, i.e. 7.4 ignores embedded fonts (confirms §5).
7. Failure path: a verification failure injected with IN==OUT raises `EmbedError`, leaves the input byte-identical and
   leaves no temp file. `embed_fonts.py --verify` is clean on every output.
8. **Field evidence gathered in this review:**
   - **LibreOffice bug 170931** (https://bugs.documentfoundation.org/show_bug.cgi?id=170931, attachments 205684 and
     205708, Feb 2026). `Font-Embedded.pptx` was written by LibreOffice 25.8.4.2 with raw **flags-0** EOT parts
     (v0x00020002, Charset 0, NUL-terminated names, EUDCCodePage 1252, bare `<p:font typeface="Bebas Neue"/>`).
     A LibreOffice QA member opened it in Windows desktop PowerPoint M365 (Spanish UI) and wrote "I do not have the
     fonts installed". The screenshot shows PowerPoint drawing the **same corrupted glyphs** as Impress. FreeType draws
     the embedded Fira Code payload with that same corruption, and the Bebas Neue payload fails to rasterize (the payloads
     are damaged: their checkSumAdjustment does not verify). A fallback or cloud font would have drawn legible text, so
     **Windows PowerPoint loaded and rendered third-party uncompressed EOT**. This is the first direct PowerPoint
     observation of raw EOT. The deck was examined in a temp dir and deleted; `field/` keeps only XML and EOT header
     bytes (no font data).
   - LibreOffice bug 167826, comment 0 (Mike Kaganski, 2025-08-06): the deck is "created by MS PowerPoint 2016" and
     "Opening it in PowerPoint on a system without the font shows the font OK". PowerPoint's own MTX path works.
   - Own survey (`field/survey/survey2.py`: 80 GitHub-extracted decks, 720 font slots; XML plus the first 1 KiB of each
     part only). **Pure Canva exports** (AppVersion 14.0000) write `p:font charset="1"` plus the font's **real** PANOSE
     (21/21 regular slots), consistent with their EOT Charset 1. After a Windows PowerPoint 16 re-save, `p:font` gets a
     substitute's PANOSE (Arial `020B0604020202020204`; SimSun-like plus GB2312 on a Chinese machine) for 56/57 raw
     parts. PowerPoint does the **same to 15 of its own MTX parts** (Quicksand, Teko, Outfit, Gelasio…), so this
     signature only means "font not installed where the deck was re-saved"; it is no evidence against raw EOT. In
     those `saveSubsetFonts="1"` decks the raw parts were carried through the save in Canva's layout (flags 0,
     Charset 1, no NUL): PowerPoint did not subset or re-encode fonts it had only as embedded data.

### 11.5 Defects found and changes made

Code (API and CLI unchanged; `tools/eot.py` unchanged — no defect found):

1. **`embed_fonts`: case-sensitive "is the typeface used?" test** silently skipped a face when runs spelled the
   typeface with a different case (repro: runs `pretendard`, face `Pretendard` → nothing embedded, only a warning, so
   PowerPoint would fall back). Office matches typefaces case-insensitively (GDI/DirectWrite family lookup; POI's
   `XSLFFontInfo` uses `equalsIgnoreCase`). **Fixed**: a case-only difference now counts as used; the face is embedded
   under its exact name-ID-1 typeface and a warning names the variant spelling (`run_verify.py` case 8).
2. **`embed_fonts`: pre-existing implicit font relationships were shipped.** A `…/relationships/font` relationship that
   no `embeddedFont` slot references (and its part) survived into the output. Office "only allows the Presentation part
   to have an explicit relationship with a Font part" ([MS-OI29500] 2.1.18 c), so this could provoke a repair prompt.
   **Fixed**: such relationships are dropped with a warning, and their parts go when nothing else targets them
   (case 4). Such parts are unusable by any reader, so nothing renderable is lost.

Corrections to §0–§10 (left in place; this section supersedes them):

- §2.3 / §4.8: "Canva … `<p:font typeface="Canva Sans Bold"/>`" is wrong for pure Canva exports: they write
  `charset="1" panose="<the font's own PANOSE>"` (21/21 regular slots, 5 decks). The Arial-PANOSE entries on Canva
  parts come from later PowerPoint re-saves (§11.4 item 8).
- §2.4: the Microsoft Q&A 5384670 quote is one anonymous user. An MVP only replies that Canva "was probably embedding
  the fonts", and nothing proves the fonts were not installed. It is weak evidence. The direct evidence is LibreOffice
  bug 170931 (§11.4 item 8).
- §1.5 (Sandha3): the re-saved deck shows pass-through of foreign raw parts. Its `p:font` values were rewritten to a
  substitute's, which says nothing about whether the glyphs rendered.
- §2.5 Charset row: no sample pairs EOT Charset 1 with `p:font charset="-127"`; see the Charset note in §11.2 for why
  this was left unchanged.

### 11.6 Remaining risks after review (supersedes §7 where they differ)

| # | Question | Confidence now | Why |
|---|---|---|---|
| 1 | Current Windows PowerPoint M365 renders text with our uncompressed EOT on a PC without the font | **~92 %** (was ~85 %) | direct M365 observation of raw EOT in use (LibreOffice bug 170931, Feb 2026). Our header differs from that one only in Charset (1 vs 0), NUL terminators (none; zero padding follows every name) and EUDCCodePage (0 vs 1252, no EUDC data). Not directly observed: large CJK raw fonts (2-2.7 MB each) |
| 2 | Opens without a repair prompt | **~93 %** | schema-valid; Open XML SDK Microsoft365 0 errors; POI reads it; explicit font relationships only (fix 2) |
| 3 | Editable (no read-only bar; newly typed Hangul uses the font) | ~85 % | fsType 0 and full font (t2embed: EDITABLE/INSTALLABLE → "read/write"); not observed in PowerPoint |
| 4 | A PowerPoint re-save keeps the fonts full | ~80 % (was ~75 %) | survey: PowerPoint carried raw parts through saves unchanged even with `saveSubsetFonts="1"`, but rewrote their `p:font` PANOSE/charset to a substitute's. Unknown what it does when the font is also installed on the saving PC |
| 5 | `b="1"` runs pick the `bold` slot; non-RIBBI typefaces resolve | ~85 % | unchanged (PowerPoint's own Calibri Light / Aptos SemiBold usage) |
| 6 | English typeface "NanumGothic" works on Korean Windows | ~80 % | unchanged; irrelevant for Pretendard (English names only) |
| 7 | EOT Charset 1 with `p:font charset="-127"` (a pairing no producer writes) is harmless | ~90 % | ECMA §19.2.1.13 calls disagreement "application-dependent", but PowerPoint writes mismatches itself (bare `p:font` over Charset 0; `charset="0"` over Canva's Charset 1) and used LibreOffice's mismatched parts. If test 1 in §8 fails, first try EOT Charset = the `p:font` value (129), then MTX |
| 8 | Protected View (Mark-of-the-Web) delays or blocks embedded fonts | unknown (~50 %) | unchanged; no source |
| 9 | Untrusted Font Blocking GPO | falls back if the GPO is on | Microsoft, first-hand: "Using desktop Office to look at documents with embedded fonts … content shows up using a default font picked by Office" |
| 10 | Same-name installed, cloud or organizational font takes precedence | medium-low | release notes, first-hand: 2411 (Build 18227.20152) "an embedded font wouldn't render if the file was opened offline"; 2502/2503 organizational-font conflict fix. Test on ≥ 2411 |

Protocol §8 still applies. The kit decks (`scratch/font-embed/ppt-test-kit/`) pass `indep_check.py` (0 ERROR) and POI.
