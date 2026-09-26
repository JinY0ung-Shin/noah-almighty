"""fonts.json profiles, face resolution, PowerPoint vertical metrics and a per-character advance model.

* Face resolution (CONTRACT): the face with the nearest ``cssWeight``, tie -> heavier. A run gets
  ``latin``/``ea``/``cs`` = ``face.typeface`` (exact spelling) and ``b="1"`` iff ``face.bold``.
* PowerPoint's line model needs the usWinAscent/usWinDescent of the font PowerPoint renders with
  (docs/research/text-mapping.md §2): taken from a face field ``pptWinMetrics`` when present, else from the
  CONTRACT constants (맑은 고딕 = Malgun Gothic 6.69: 2229/495 per 2048 — never read from the Windows file at build
  time), else from the face's own font file.
* The advance model (for ``pptbreak``) reproduces the HTML measurement: it parses ``theme/fonts-<profile>.css``
  (the generated @font-face composite: file, weight range, unicode-range, size-adjust) and returns nominal
  advances. For ``embedded`` those are the advances of the very files PowerPoint gets; for ``malgun`` they are the
  metric-matched substitute's (per-line error vs real Malgun Gothic: mean 0.999-1.001, sd 0.26 %, docs/research/
  fonts.md §2), i.e. the best model of Malgun available on the server.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .core import KIT

# PowerPoint vertical metrics for faces that are not on the server (CONTRACT "PowerPoint vertical metrics")
KNOWN_WIN_METRICS = {
    "맑은 고딕": (2229, 495),
    "malgun gothic": (2229, 495),
}


@dataclass(frozen=True)
class Face:
    css_weight: int
    typeface: str
    bold: bool
    italic: bool
    slot: str
    file: str | None            # font file embedded into the PPTX (None: not embedded)
    measure_file: str | None    # file the HTML is measured with (substitute) — informational
    win_ascent: int
    win_descent: int

    @property
    def unit_line(self) -> tuple[float, float]:
        t = self.win_ascent + self.win_descent
        return self.win_ascent / t, self.win_descent / t


@lru_cache(maxsize=None)
def _win_metrics_of(path: str) -> tuple[int, int]:
    from fontTools.ttLib import TTFont
    f = TTFont(path, lazy=True)
    o = f["OS/2"]
    return int(o.usWinAscent), int(o.usWinDescent)


def _face_win_metrics(fd: dict, log=None) -> tuple[int, int]:
    wm = fd.get("pptWinMetrics")
    if isinstance(wm, (list, tuple)) and len(wm) == 2:
        return int(wm[0]), int(wm[1])
    if isinstance(wm, dict) and "usWinAscent" in wm:
        return int(wm["usWinAscent"]), int(wm["usWinDescent"])
    known = KNOWN_WIN_METRICS.get(str(fd.get("typeface", "")).lower()) or KNOWN_WIN_METRICS.get(fd.get("typeface"))
    if known:
        return known
    if fd.get("file"):
        p = KIT / fd["file"]
        if p.is_file():
            return _win_metrics_of(str(p))
    if log:
        log.warn(f"no PowerPoint vertical metrics for typeface {fd.get('typeface')!r}; assuming Pretendard's 1949/494")
    return 1949, 494


class Profile:
    def __init__(self, name: str, data: dict, log=None):
        self.name = name
        self.data = data
        self.label = data.get("label", name)
        self.css_family = data.get("cssFamily")
        self.embed = bool(data.get("embed"))
        faces = []
        for fd in data.get("faces", []):
            asc, desc = _face_win_metrics(fd, log)
            faces.append(Face(css_weight=int(fd["cssWeight"]), typeface=str(fd["typeface"]),
                              bold=bool(fd.get("bold")), italic=bool(fd.get("italic")),
                              slot=str(fd.get("slot", "regular")), file=fd.get("file"),
                              measure_file=fd.get("measureFile"), win_ascent=asc, win_descent=desc))
        if not faces:
            raise ValueError(f"profile {name!r} has no faces")
        self.faces = faces
        self._advance_model = None
        self._log = log

    # -- CONTRACT: nearest cssWeight, tie -> heavier
    def resolve(self, css_weight) -> Face:
        try:
            w = int(round(float(css_weight)))
        except (TypeError, ValueError):
            w = 400
        return min(self.faces, key=lambda f: (abs(f.css_weight - w), -f.css_weight))

    def resolve_face(self, css_weight) -> dict:
        """The chart lane's ctx.resolve_face(css_weight) -> {"typeface", "bold"}."""
        f = self.resolve(css_weight)
        return {"typeface": f.typeface, "bold": f.bold}

    @property
    def regular(self) -> Face:
        regs = [f for f in self.faces if f.slot == "regular" and not f.bold and not f.italic]
        pool = regs or self.faces
        return min(pool, key=lambda f: (abs(f.css_weight - 400), -f.css_weight))

    def embed_faces(self) -> list[dict]:
        return [{"typeface": f.typeface, "slot": f.slot, "file": f.file} for f in self.faces if f.file]

    @property
    def advance_model(self):
        if self._advance_model is None:
            css = KIT / "theme" / f"fonts-{self.name}.css"
            try:
                self._advance_model = AdvanceModel.from_css(css, self.css_family)
            except Exception as exc:  # noqa: BLE001 — a missing/odd CSS must not break the build
                if self._log:
                    self._log.warn(f"advance model unavailable ({css}: {exc}); wrap widths fall back to 1.02 slack")
                self._advance_model = False
        return self._advance_model or None


def load_profile(name: str, fonts_json: Path | None = None, log=None) -> Profile:
    path = fonts_json or (KIT / "fonts" / "fonts.json")
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    try:
        data = cfg["profiles"][name]
    except KeyError as exc:
        raise ValueError(f"profile {name!r} not in {path} (have {sorted(cfg.get('profiles', {}))})") from exc
    return Profile(name, data, log)


# ---------------------------------------------------------------------------------------------- advance model
_FACE_RE = re.compile(r"@font-face\s*{(.*?)}", re.S)
_DECL_RE = re.compile(r"([a-zA-Z-]+)\s*:\s*([^;]+);")
_URL_RE = re.compile(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)")


def _parse_unicode_range(s: str) -> list[tuple[int, int]]:
    out = []
    for part in s.split(","):
        p = part.strip().upper()
        if not p.startswith("U+"):
            continue
        p = p[2:]
        if "?" in p:
            out.append((int(p.replace("?", "0"), 16), int(p.replace("?", "F"), 16)))
        elif "-" in p:
            a, b = p.split("-", 1)
            out.append((int(a, 16), int(b, 16)))
        else:
            out.append((int(p, 16), int(p, 16)))
    return out


@dataclass
class _FontData:
    upm: int
    cmap: dict
    hmtx: object


@lru_cache(maxsize=None)
def _font_data(path: str) -> _FontData:
    from fontTools.ttLib import TTFont
    f = TTFont(path, lazy=True)
    return _FontData(upm=f["head"].unitsPerEm, cmap=f.getBestCmap() or {}, hmtx=f["hmtx"])


@dataclass
class CssFace:
    family: str
    src: Path
    wmin: int
    wmax: int
    ranges: list[tuple[int, int]] | None
    size_adjust: float = 1.0
    ascent_override: float | None = None
    descent_override: float | None = None
    line_gap_override: float | None = None

    def covers(self, cp: int) -> bool:
        return self.ranges is None or any(a <= cp <= b for a, b in self.ranges)

    def em(self, cp: int) -> float | None:
        fd = _font_data(str(self.src))
        g = fd.cmap.get(cp)
        if g is None:
            return None
        return fd.hmtx[g][0] / fd.upm * self.size_adjust


@lru_cache(maxsize=None)
def _file_line_metrics(path: str) -> tuple[float, float]:
    from fontTools.ttLib import TTFont
    f = TTFont(path, lazy=True)
    upm = f["head"].unitsPerEm
    o, hh = f["OS/2"], f["hhea"]
    if o.fsSelection & (1 << 7):
        return o.sTypoAscender / upm, -o.sTypoDescender / upm
    return hh.ascent / upm, -hh.descent / upm


def _is_cjk_wide(cp: int) -> bool:
    return (0x1100 <= cp <= 0x11FF or 0x2E80 <= cp <= 0x303F or 0x3130 <= cp <= 0x318F or 0x3200 <= cp <= 0x9FFF
            or 0xAC00 <= cp <= 0xD7A3 or 0xF900 <= cp <= 0xFAFF or 0xFF01 <= cp <= 0xFF60)


class AdvanceModel:
    """Nominal advances (em) of the HTML's font composite, per CSS weight."""

    def __init__(self, faces: list[CssFace]):
        if not faces:
            raise ValueError("no @font-face rules")
        self.faces = faces
        self._cache: dict[tuple[int, int], float] = {}

    @classmethod
    def from_css(cls, css_path: Path, family: str | None) -> "AdvanceModel":
        text = Path(css_path).read_text(encoding="utf-8")
        text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
        faces = []
        for body in _FACE_RE.findall(text):
            decl = {k.strip().lower(): v.strip() for k, v in _DECL_RE.findall(body)}
            fam = decl.get("font-family", "").strip().strip("'\"")
            if family and fam != family:
                continue
            m = _URL_RE.search(decl.get("src", ""))
            if not m:
                continue
            src = (Path(css_path).parent / m.group(1)).resolve()
            if not src.is_file():
                raise FileNotFoundError(src)
            w = [int(float(x)) for x in decl.get("font-weight", "400").split()] or [400]
            wmin, wmax = (w[0], w[-1]) if len(w) > 1 else (w[0], w[0])
            ur = decl.get("unicode-range")
            sa = decl.get("size-adjust", "100%").strip()
            size_adjust = float(sa[:-1]) / 100.0 if sa.endswith("%") else float(sa)

            def pct(key):
                v = decl.get(key)
                return float(v.strip()[:-1]) / 100.0 if v and v.strip().endswith("%") else None
            faces.append(CssFace(fam, src, wmin, wmax, _parse_unicode_range(ur) if ur else None, size_adjust,
                                 pct("ascent-override"), pct("descent-override"), pct("line-gap-override")))
        return cls(faces)

    def css_line_metrics(self, weight: int) -> tuple[float, float]:
        """(ascent, descent) in em of the primary font Chromium uses for the line box at this weight: the face
        covering U+0020 (later rules win), overrides x size-adjust, else the file's typo (USE_TYPO_METRICS) or
        hhea metrics x size-adjust."""
        cand = [f for f in reversed(self._group(weight)) if f.covers(0x20) and f.em(0x20) is not None]
        f = cand[0] if cand else self._group(weight)[0]
        if f.ascent_override is not None and f.descent_override is not None:
            return f.ascent_override * f.size_adjust, f.descent_override * f.size_adjust
        asc, desc = _file_line_metrics(str(f.src))
        return asc * f.size_adjust, desc * f.size_adjust

    def _group(self, weight: int) -> list[CssFace]:
        g = [f for f in self.faces if f.wmin <= weight <= f.wmax]
        if g:
            return g
        # CSS font matching outside every range: nearest range (not expected: the generated ranges tile 1..1000)
        best = min(self.faces, key=lambda f: min(abs(weight - f.wmin), abs(weight - f.wmax)))
        return [f for f in self.faces if (f.wmin, f.wmax) == (best.wmin, best.wmax)]

    def em(self, ch: str, weight: int) -> float:
        cp = ord(ch)
        key = (cp, weight)
        v = self._cache.get(key)
        if v is not None:
            return v
        v = None
        for f in reversed(self._group(weight)):          # later rules win where unicode-ranges overlap
            if f.covers(cp):
                v = f.em(cp)
                if v is not None:
                    break
        if v is None:
            v = 1.0 if _is_cjk_wide(cp) else (0.0 if cp in (0x200B, 0x200C, 0x200D, 0xFEFF) else 0.55)
        self._cache[key] = v
        return v

    def advances_pt(self, text: str, size_pt: float, weight: int, letter_spacing_pt: float = 0.0) -> list[float]:
        return [self.em(ch, weight) * size_pt + letter_spacing_pt for ch in text]
