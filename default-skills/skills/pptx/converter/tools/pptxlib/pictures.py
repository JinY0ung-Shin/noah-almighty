"""IR `image` elements -> p:pic (PNG or JPEG; native SVG + PNG fallback for simple icons).

docs/research/shape-table-mapping.md §4:
* ``add_picture`` with both width and height (the IR PNG is a 4x raster); alt text -> ``cNvPr@descr``;
* transparency: ``a:alphaModFix amt < 100000`` inserted before ``a:blip/a:extLst`` (Office takes amt modulo 100 %);
* the raster may be a JPEG (the extractor's raster policy for opaque photos; ``add_picture`` sniffs the format);
* IR paths resolve against the IR directory (``ctx.ir_dir``);
* SVG: PNG ``r:embed`` + ``a:extLst/a:ext uri={96DAC541-…}/asvg:svgBlip r:embed`` (the structure of Microsoft's
  Open XML SDK sample and Apache POI); only for SELF-CONTAINED simple SVG (no text, filters, masks, scripts,
  foreign objects, external references, CSS classes/variables/currentColor) — anything else ships PNG only.
"""
from __future__ import annotations

import re

from lxml import etree
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.opc.package import Part
from pptx.opc.packuri import PackURI
from pptx.oxml.ns import qn
from pptx.util import Emu

from .core import clamp, el, emu, num, pct1000, resolve_path, sub

SVG_EXT_URI = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
SVG_NS = "http://schemas.microsoft.com/office/drawing/2016/SVG/main"
DECORATIVE_EXT_URI = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}"          # Office "Mark as decorative"
DECORATIVE_NS = "http://schemas.microsoft.com/office/drawing/2017/decorative"
W3_SVG = "http://www.w3.org/2000/svg"

_SVG_ALLOWED = {"svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "title", "desc",
                "defs", "linearGradient", "stop", "metadata"}
_SVG_MAX_BYTES = 256 * 1024
_SVG_MAX_ELEMENTS = 2000


def svg_is_simple(data: bytes) -> tuple[bool, str]:
    """(ok, reason). Conservative test for 'a flat icon PowerPoint's SVG renderer draws like Chromium' (RISK R6)."""
    if len(data) > _SVG_MAX_BYTES:
        return False, f"{len(data)} bytes > {_SVG_MAX_BYTES}"
    try:
        from defusedxml.ElementTree import fromstring as safe_fromstring  # no DTDs/entities/external refs
        root = safe_fromstring(data)
    except Exception as exc:  # noqa: BLE001 — ParseError or a defusedxml refusal
        return False, f"rejected by parser: {exc}"

    def split(tag):
        return (tag[1:].split("}", 1) if tag.startswith("{") else (None, tag))

    ns, local = split(root.tag)
    if local != "svg" or ns != W3_SVG:
        return False, "root is not an SVG element in the SVG namespace"
    if not (root.get("viewBox") or (root.get("width") and root.get("height"))):
        return False, "no viewBox/width/height"
    n = 0
    for e in root.iter():
        if not isinstance(e.tag, str):
            continue
        n += 1
        ns, local = split(e.tag)
        if ns not in (W3_SVG, None) or local not in _SVG_ALLOWED:
            return False, f"element <{local}> not allowed"
        if local == "svg" and e is not root:
            return False, "nested <svg>"
        for k, v in e.attrib.items():
            lk = split(k)[1]
            vl = v.lower()
            if lk.startswith("on"):
                return False, f"event attribute {lk}"
            if lk == "href":
                return False, "linked reference"
            if "currentcolor" in vl or "var(" in vl:
                return False, f"unresolved {v!r} in {lk}"
            for m in re.finditer(r"url\(([^)]*)\)", v):
                if not m.group(1).strip().strip("'\"").startswith("#"):
                    return False, f"non-local url() in {lk}"
    if n > _SVG_MAX_ELEMENTS:
        return False, f"{n} elements"
    return True, "ok"


def _next_media_partname(pkg, ext: str) -> PackURI:
    used = {str(p.partname) for p in pkg.iter_parts()}
    n = 1
    while f"/ppt/media/image{n}.{ext}" in used:
        n += 1
    return PackURI(f"/ppt/media/image{n}.{ext}")


def _attach_svg(slide, pic, svg_bytes: bytes) -> None:
    pkg = slide.part.package
    svg_part = Part(_next_media_partname(pkg, "svg"), "image/svg+xml", pkg, svg_bytes)
    rid = slide.part.relate_to(svg_part, RT.IMAGE)
    blip = pic._element.blipFill.find(qn("a:blip"))
    ext_lst = blip.find(qn("a:extLst"))
    if ext_lst is None:                      # an empty lxml element is falsy: never `find(...) or ...`
        ext_lst = sub(blip, "a:extLst")
    ext = sub(ext_lst, "a:ext", uri=SVG_EXT_URI)
    sb = etree.SubElement(ext, f"{{{SVG_NS}}}svgBlip", nsmap={"asvg": SVG_NS})
    sb.set(qn("r:embed"), rid)


def _set_alpha(pic, alpha: float) -> None:
    if alpha >= 0.99999:
        return
    blip = pic._element.blipFill.find(qn("a:blip"))
    amf = el("a:alphaModFix", amt=min(99999, pct1000(max(0.0, alpha))))
    ext_lst = blip.find(qn("a:extLst"))
    if ext_lst is not None:
        ext_lst.addprevious(amf)             # CT_Blip: effects before a:extLst
    else:
        blip.append(amf)


def mark_decorative(cnv) -> None:
    """Empty alt text + Office's decorative flag (the accessibility checker then expects no alt text and screen
    readers skip the object) — python-pptx's default descr is the image file name."""
    cnv.set("descr", "")
    ext_lst = cnv.find(qn("a:extLst"))
    if ext_lst is None:
        ext_lst = sub(cnv, "a:extLst")
    ext = sub(ext_lst, "a:ext", uri=DECORATIVE_EXT_URI)
    d = etree.SubElement(ext, f"{{{DECORATIVE_NS}}}decorative", nsmap={"adec": DECORATIVE_NS})
    d.set("val", "1")


def add_picture_file(slide, png_path, box: dict, *, name: str, alt: str | None = None, rot: float = 0.0,
                     alpha: float = 1.0, svg_bytes: bytes | None = None, decorative: bool = False):
    pic = slide.shapes.add_picture(str(png_path), Emu(emu(num(box.get("x")))), Emu(emu(num(box.get("y")))),
                                   Emu(max(1, emu(num(box.get("w"))))), Emu(max(1, emu(num(box.get("h"))))))
    pic.name = name
    if alt:
        pic._element.nvPicPr.cNvPr.set("descr", alt)
    elif decorative:
        mark_decorative(pic._element.nvPicPr.cNvPr)
    if rot:
        pic.rotation = rot
    _set_alpha(pic, alpha)
    if svg_bytes is not None:
        _attach_svg(slide, pic, svg_bytes)
    return pic


def add_image(slide, e: dict, ctx):
    log = ctx.log
    eid = e.get("id", "image")
    src = e.get("src")
    png = resolve_path(src, ctx.ir_dir) if src else None
    if png is None or not png.is_file():
        log.skip(f"slide {ctx.slide_index}: image {eid!r}: PNG {src!r} not found — skipped")
        return None
    svg_bytes = None
    if e.get("svg"):
        sp = resolve_path(e["svg"], ctx.ir_dir)
        if sp.is_file():
            data = sp.read_bytes()
            ok, why = svg_is_simple(data)
            if ok:
                svg_bytes = data
            else:
                log.info(f"slide {ctx.slide_index}: image {eid!r}: SVG kept as PNG only ({why})")
        else:
            log.warn(f"slide {ctx.slide_index}: image {eid!r}: SVG {e['svg']!r} not found — PNG only")
    alpha = clamp(num(e.get("opacity"), 1.0), 0.0, 1.0)
    nm = ctx.name_for(e) if hasattr(ctx, "name_for") else eid
    alt = str(e.get("alt") or "").strip()
    pic = add_picture_file(slide, png, e.get("box") or {}, name=ctx.namer(nm), alt=alt or None,
                           rot=num(e.get("rotationDeg")), alpha=alpha, svg_bytes=svg_bytes, decorative=not alt)
    ctx.stats["image:svg" if svg_bytes else "image:png"] = ctx.stats.get("image:svg" if svg_bytes else "image:png",
                                                                         0) + 1
    return pic
