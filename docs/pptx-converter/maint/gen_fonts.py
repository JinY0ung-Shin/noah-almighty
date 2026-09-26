#!/usr/bin/env python3
# Historical PoC tool, preserved for maintainers (see README.md next to this file). The paths below
# (POC=/home/jinyoung/pptx-poc, /mnt/c/Windows/Fonts) are the PoC dev box's: point FONTS/THEME at
# default-skills/skills/pptx/converter/{fonts,theme}, CORPUS at corpus_ko_business.txt here, and MALGUN at
# a Malgun Gothic installation that is READ in place (never copied) before running it.
"""Generate fonts/fonts.json, theme/fonts-embedded.css and theme/fonts-malgun.css (fonts lane).

Dev-time only: it reads Malgun Gothic IN PLACE from /mnt/c/Windows/Fonts to derive the malgun-profile CSS numbers
(advance ratios and vertical metrics). Nothing from Malgun is copied; the outputs contain only these numbers.

malgun profile = "PoC Malgun Substitute": unmodified OFL files (Gothic A1 for Hangul/CJK symbols, Selawik for Latin),
split by unicode-range, each @font-face with its own size-adjust so the advances equal Malgun Gothic's, plus
ascent/descent/line-gap overrides so the CSS line metrics equal Malgun Gothic's (hhea 2229/-495/0 @ 2048 upm).
"""
import json
from collections import Counter
from pathlib import Path

from fontTools.ttLib import TTFont

POC = Path("/home/jinyoung/pptx-poc")
FONTS = POC / "fonts"
THEME = POC / "theme"
CORPUS = POC / "scratch/fonts/corpus_ko_business.txt"
MALGUN = {"R": "/mnt/c/Windows/Fonts/malgun.ttf", "B": "/mnt/c/Windows/Fonts/malgunbd.ttf"}
KOREAN = {"R": "GothicA1-Regular.ttf", "B": "GothicA1-Bold.ttf"}
LATIN = {"R": "selawk.ttf", "B": "selawkb.ttf"}
HANJA = {"R": "NotoSansKR-VF.ttf", "B": "NotoSansKR-VF.ttf"}  # google/fonts NotoSansKR[wght].ttf, renamed copy
HANJA_RANGES = [(0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF)]
MALGUN_FAMILY = "PoC Malgun Substitute"
EMBED_FAMILY = "Pretendard"
# builder rule: nearest cssWeight, tie -> heavier. Ranges below reproduce it for every integer weight 1..1000.
MALGUN_WEIGHTS = {"R": (400, "1 549"), "B": (700, "550 1000")}
EMBEDDED = [  # cssWeight, file, weight range, (typeface, bold, slot) taken from the name table below
    (400, "Pretendard-Regular.ttf", "1 499"),
    (600, "Pretendard-SemiBold.ttf", "500 649"),
    (700, "Pretendard-Bold.ttf", "650 749"),
    (800, "Pretendard-ExtraBold.ttf", "750 1000"),
]
SPACE_CPS = [0x20, 0xA0]
DIGIT_CPS = list(range(0x30, 0x3A))
HANGUL_SYLLABLES = (0xAC00, 0xD7A3)


def load(path):
    f = TTFont(str(path), lazy=True)
    upm = f["head"].unitsPerEm
    cmap = f.getBestCmap()
    hm = f["hmtx"]
    adv = {cp: hm[g][0] / upm for cp, g in cmap.items()}
    return f, upm, cmap, adv


def ranges(cps):
    cps = sorted(cps)
    out, start, prev = [], None, None
    for c in cps:
        if start is None:
            start = prev = c
        elif c == prev + 1:
            prev = c
        else:
            out.append((start, prev))
            start = prev = c
    if start is not None:
        out.append((start, prev))
    return ", ".join(f"U+{a:X}" if a == b else f"U+{a:X}-{b:X}" for a, b in out)


def pct(x):
    return f"{x * 100:.4f}%"


def malgun_params(w, corpus):
    mf, mupm, mcmap, madv = load(MALGUN[w])
    hhea = mf["hhea"]
    asc, desc, gap = hhea.ascent / mupm, -hhea.descent / mupm, hhea.lineGap / mupm
    assert not (mf["OS/2"].fsSelection & 0x80), "Malgun sets USE_TYPO_METRICS?"  # hhea (== win) metrics apply
    kf, kupm, kcmap, kadv = load(FONTS / KOREAN[w])
    lf, lupm, lcmap, ladv = load(FONTS / LATIN[w])
    # Hangul syllables: every advance is uniform in both fonts -> exact
    hs = {round(madv[c] / kadv[c], 9) for c in range(HANGUL_SYLLABLES[0], HANGUL_SYLLABLES[1] + 1)}
    assert len(hs) == 1, hs
    s_hangul = hs.pop()
    s_space = madv[0x20] / ladv[0x20]
    # Malgun: NBSP == space. Selawik has no U+00A0 glyph; HarfBuzz's space fallback renders NBSP with the space
    # glyph and advance, so U+00A0 stays in the space face (verified in Chromium by scratch/fonts/chrome_check.mjs).
    assert abs(madv[0xA0] - madv[0x20]) < 1e-9 and ladv.get(0xA0, ladv[0x20]) == ladv[0x20]
    dg = {round(madv[c] / ladv[c], 9) for c in DIGIT_CPS}
    assert len(dg) == 1, dg  # both tabular
    s_digit = dg.pop()
    latin_cps = [c for c in lcmap if c > 0x20 and c not in SPACE_CPS and c not in DIGIT_CPS and not (0x7F <= c <= 0x9F)
                 and c in madv and ladv.get(c, 0) > 0]
    cnt = Counter(ord(ch) for ch in corpus if ch != "\n")
    num = sum(cnt[c] * madv[c] for c in latin_cps if cnt[c])
    den = sum(cnt[c] * ladv[c] for c in latin_cps if cnt[c])
    s_latin = num / den
    s_rest = 1.0  # CJK symbols / jamo / fullwidth / enclosed / geometric: Malgun == Gothic A1 advances (1.0 em)
    hf, hupm, hcmap, hadv = load(FONTS / HANJA[w])  # variable font: CJK advances do not vary with wght
    hj = Counter(round(madv[c] / hadv[c], 6) for a, b in HANJA_RANGES for c in range(a, b + 1) if c in madv and c in hadv)
    s_hanja, _ = hj.most_common(1)[0]
    assert s_hanja == 1.0 and hj[1.0] / sum(hj.values()) > 0.999, hj
    return {
        "malgunMetrics": {"ascent": asc, "descent": desc, "lineGap": gap, "upm": mupm,
                          "hheaAscender": hhea.ascent, "hheaDescender": hhea.descent, "hheaLineGap": hhea.lineGap},
        "faces": [  # order matters: the face without unicode-range must come FIRST (later rules win on overlap)
            {"role": "rest (CJK symbols, jamo, fullwidth, everything not listed below)", "file": KOREAN[w],
             "unicodeRange": None, "sizeAdjust": s_rest},
            {"role": "latin (Selawik coverage except space/digits)", "file": LATIN[w],
             "unicodeRange": ranges(latin_cps), "sizeAdjust": s_latin},
            {"role": "digits (tabular in both)", "file": LATIN[w], "unicodeRange": ranges(DIGIT_CPS), "sizeAdjust": s_digit},
            {"role": "space + no-break space", "file": LATIN[w], "unicodeRange": ranges(SPACE_CPS), "sizeAdjust": s_space},
            {"role": "Hanja (CJK ideographs; Gothic A1 has none)", "file": HANJA[w],
             "unicodeRange": ", ".join(f"U+{a:X}-{b:X}" for a, b in HANJA_RANGES), "sizeAdjust": s_hanja},
            {"role": "Hangul syllables", "file": KOREAN[w], "unicodeRange": ranges(range(HANGUL_SYLLABLES[0], HANGUL_SYLLABLES[1] + 1)),
             "sizeAdjust": s_hangul},
        ],
    }


def embedded_faces():
    faces = []
    for css_w, fn, rng in EMBEDDED:
        f = TTFont(str(FONTS / fn), lazy=True)
        n1 = f["name"].getName(1, 3, 1, 0x409).toUnicode()
        n2 = f["name"].getName(2, 3, 1, 0x409).toUnicode()
        assert "glyf" in f and f["OS/2"].fsType == 0, fn
        bold = n2 == "Bold"
        assert n2 in ("Regular", "Bold"), (fn, n2)
        faces.append({"cssWeight": css_w, "typeface": n1, "bold": bold, "italic": False,
                      "slot": "bold" if bold else "regular", "file": f"fonts/{fn}", "_range": rng})
    return faces


def write_embedded_css(faces):
    lines = [
        "/* theme/fonts-embedded.css — GENERATED by scratch/fonts/gen_fonts.py (fonts lane). Do not hand-edit.",
        " * Profile `embedded`: Pretendard 1.3.9 static TrueType files (OFL-1.1, unmodified), the SAME files that",
        " * tools/embed_fonts.py embeds into the PPTX. Weight ranges reproduce the builder's face resolution",
        " * (nearest cssWeight, tie -> heavier) for every weight 1..1000, so HTML and PPTX always pick the same face.",
        " * No metric overrides on the Pretendard faces: PowerPoint lays the text out with these fonts' own metrics.",
        " * Pretendard has no Hanja; PowerPoint falls back to a system CJK font for them (1.000 em wide in Malgun Gothic",
        " * and virtually every CJK font). So each Pretendard rule is followed by a Hanja-only rule (Noto Sans KR VF,",
        " * 1.000 em, NOT embedded) with IDENTICAL font-weight/style descriptors (Blink only merges unicode-range faces",
        " * with identical descriptors) and Pretendard's own line metrics as overrides, so a Hanja never changes a line",
        " * box and never renders as server-dependent tofu. Later rules win where unicode-ranges overlap. */",
    ]
    # Hanja fallback with Pretendard's CSS line metrics (typo, because USE_TYPO_METRICS is set). Blink only merges
    # unicode-range faces whose font-weight/style/stretch descriptors are IDENTICAL, so every Pretendard weight range
    # gets its own Hanja rule with the same range (a single `1 1000` Hanja rule would compete as a separate face
    # group and win for some weights, dropping Latin to the system font -- observed in Chromium 149).
    pf = TTFont(str(FONTS / EMBEDDED[0][1]), lazy=True)
    os2, upm = pf["OS/2"], pf["head"].unitsPerEm
    assert os2.fsSelection & 0x80
    asc, desc, gap = os2.sTypoAscender / upm, -os2.sTypoDescender / upm, os2.sTypoLineGap / upm
    for fc in faces:
        lines.append(
            "@font-face {\n"
            f"  font-family: \"{EMBED_FAMILY}\";\n"
            f"  src: url('../{fc['file']}') format('truetype');\n"
            f"  font-weight: {fc['_range']}; /* face cssWeight {fc['cssWeight']} -> PPTX typeface \"{fc['typeface']}\" {'b=1' if fc['bold'] else 'b=0'} */\n"
            "  font-style: normal;\n"
            "  font-display: block;\n"
            "}")
        lines.append(
            f"/* Hanja only for cssWeight {fc['cssWeight']} (Pretendard has none): Noto Sans KR 2.004 VF, 1.000 em, Pretendard's line metrics */\n"
            "@font-face {\n"
            f"  font-family: \"{EMBED_FAMILY}\";\n"
            f"  src: url('../fonts/{HANJA['R']}') format('truetype');\n"
            f"  font-weight: {fc['_range']};\n"
            "  font-style: normal;\n"
            "  font-display: block;\n"
            f"  unicode-range: {', '.join(f'U+{a:X}-{b:X}' for a, b in HANJA_RANGES)};\n"
            f"  ascent-override: {pct(asc)};\n"
            f"  descent-override: {pct(desc)};\n"
            f"  line-gap-override: {pct(gap)};\n"
            "}")
    lines.append(f":root {{ --font-sans: \"{EMBED_FAMILY}\", sans-serif; }}")
    (THEME / "fonts-embedded.css").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_malgun_css(params):
    lines = [
        "/* theme/fonts-malgun.css — GENERATED by scratch/fonts/gen_fonts.py (fonts lane). Do not hand-edit.",
        " * Profile `malgun`: the PPTX declares 맑은 고딕 (not redistributable, not installable on the Linux server).",
        " * The HTML is measured with \"PoC Malgun Substitute\", a composite of two UNMODIFIED OFL fonts:",
        " *   Gothic A1 2.50 (Hangul, jamo, CJK symbols) + Selawik 1.01 (Latin, digits, space; Segoe UI metrics)",
        " *   + Noto Sans KR 2.004 variable (Hanja only; wght follows the CSS weight).",
        " * Each unicode-range face has its own size-adjust so that its advances equal Malgun Gothic's (Hangul syllables,",
        " * space and digits exactly; Latin corpus-fitted), and ascent/descent/line-gap overrides chosen so the",
        " * EFFECTIVE line metrics (override x size-adjust) equal Malgun Gothic's hhea/win metrics: 2229/495/0 per 2048.",
        " * Rule order matters: later rules win where unicode-ranges overlap, so the catch-all face comes first.",
        " * Weight ranges mirror the builder: cssWeight 1-549 -> Regular (b=0), 550-1000 -> Bold (b=1). */",
    ]
    for w, p in params.items():
        m = p["malgunMetrics"]
        css_w, rng = MALGUN_WEIGHTS[w]
        for fc in p["faces"]:
            s = fc["sizeAdjust"]
            ur = f"  unicode-range: {fc['unicodeRange']};\n" if fc["unicodeRange"] else ""
            lines.append(
                f"/* {'Regular' if w == 'R' else 'Bold'} — {fc['role']} */\n"
                "@font-face {\n"
                f"  font-family: \"{MALGUN_FAMILY}\";\n"
                f"  src: url('../fonts/{fc['file']}') format('truetype');\n"
                f"  font-weight: {rng};\n"
                "  font-style: normal;\n"
                "  font-display: block;\n"
                f"{ur}"
                f"  size-adjust: {pct(s)};\n"
                f"  ascent-override: {pct(m['ascent'] / s)};\n"
                f"  descent-override: {pct(m['descent'] / s)};\n"
                f"  line-gap-override: {pct(m['lineGap'] / s)};\n"
                "}")
    lines.append(f":root {{ --font-sans: \"{MALGUN_FAMILY}\", sans-serif; }}")
    (THEME / "fonts-malgun.css").write_text("\n".join(lines) + "\n", encoding="utf-8")


NOTES = None  # filled from docs/research/fonts.md numbers by main()


def main():
    corpus = CORPUS.read_text(encoding="utf-8")
    params = {w: malgun_params(w, corpus) for w in ("R", "B")}
    emb = embedded_faces()
    write_embedded_css(emb)
    write_malgun_css(params)
    notes_path = POC / "scratch/fonts/malgun-notes.txt"
    notes = notes_path.read_text(encoding="utf-8").strip() if notes_path.exists() else "(pending)"
    doc = {
        "profiles": {
            "embedded": {
                "label": "무료 글꼴 임베딩",
                "cssFamily": EMBED_FAMILY,
                "embed": True,
                "faces": [{k: v for k, v in fc.items() if not k.startswith("_")} for fc in emb],
            },
            "malgun": {
                "label": "맑은 고딕 지정",
                "cssFamily": MALGUN_FAMILY,
                "embed": False,
                "faces": [
                    {"cssWeight": 400, "typeface": "맑은 고딕", "bold": False, "italic": False, "slot": "regular",
                     "file": None, "measureFile": f"fonts/{KOREAN['R']}"},
                    {"cssWeight": 700, "typeface": "맑은 고딕", "bold": True, "italic": False, "slot": "bold",
                     "file": None, "measureFile": f"fonts/{KOREAN['B']}"},
                ],
                "notes": notes,
            },
        }
    }
    (FONTS / "fonts.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (POC / "scratch/fonts/malgun-css-params.json").write_text(json.dumps(params, ensure_ascii=False, indent=1))
    for w, p in params.items():
        print(w, {k: round(v, 6) if isinstance(v, float) else v for k, v in p["malgunMetrics"].items()})
        for fc in p["faces"]:
            print("   ", fc["role"][:40].ljust(40), fc["file"].ljust(22), f"size-adjust {fc['sizeAdjust']:.6f}",
                  (fc["unicodeRange"] or "(all)")[:70])
    for fc in emb:
        print("embedded", fc)


if __name__ == "__main__":
    main()
