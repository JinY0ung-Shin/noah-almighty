"""Photo slots (IR ``kind: "placeholder"``, ``placeholder: "pic"``; docs/CONTRACT.md, converter 1.2.0) -> PowerPoint's
EMPTY picture placeholder: the user clicks its icon in PowerPoint and the photo fills the placeholder's box, cropped to
it.

* **Slide** (``add_pic_placeholder``): a ``p:sp`` with ``a:spLocks noGrp="1"`` and ``p:ph type="pic" idx=13+k`` — k =
  the slot's IR ``slot``, its ordinal among the slide's slots in DOCUMENT order (the extractor's numberPicSlots), so
  the slides of one layout pair their slots by their order in the markup whatever the paint order. 13 stays clear of
  title (0), subTitle (1) and the stock dt / ftr / sldNum (10-12) every PowerPoint layout reserves, so an idx is
  unique on the slide and on its layout (office-rules PH-01). Its spPr is explicit — xfrm = the slot's border box,
  prstGeom rect, noFill, ``a:ln`` noFill, an empty effectLst (shape-table-lint's rules; it paints nothing: the slot's
  own frame is the decorative shape emitted before it, so the slide show still shows where a photo goes) — and it has
  no hasCustomPrompt and no prompt text (PowerPoint copies neither to a slide; python-pptx's own slide placeholders
  agree). The prompt sits on the slot's frame, not on the slide background its part's tx1 is chosen for, so where
  the slide would show it in a colour other than the more legible theme text colour on the frame's opaque fill
  (``legible_colour``: a dark slide with the kit's light frame, a light slide with a dark photo well), the
  placeholder carries a colour-only txBody — bodyPr, an lstStyle whose lvl1 defRPr holds that srgbClr, one empty
  paragraph: no run, no hasCustomPrompt — which colours the layout's prompt on this slide only
  (``colour_slide_prompts``, once the layout placeholders exist: the colour a slide would otherwise show is its
  layout placeholder's, else tx1 on the slide's colour map); otherwise it has no txBody at all.
* **Layout** (``layout_slot_sp``, placed by ``layouts.add_pic_prompt_placeholders`` once every slide exists): one fresh
  picture placeholder per idx the family's slides use (the union — each slide slot links to the layout placeholder with
  its idx, office-rules SLD-02), its box and prompt from the first slide in deck order with that idx,
  ``hasCustomPrompt="1"``, and a txBody whose lstStyle sets marL 0, indent 0, no bullet, centred text and an explicit
  size (a prompt without one inherits the master body style: 32 pt with bullets) around the prompt run
  (``lang="ko-KR"``), as PowerPoint's own "Picture with Caption" layout writes it. The layout prompt keeps the
  layout's default text colour (tx1 on its colour map), legible on the layout's own background — which is where a
  New Slide shows it, since the slot's frame is slide content. Only when that frame was lifted into the layout as
  chrome (identical on every slide of the family) does a New Slide show the prompt on it: then the layout prompt gets
  the colour the frame needs, written only where the LAYOUT's colour map gives another one (``layout_colour``).
* Named ``그림 개체 틀: <prompt>`` in the Selection Pane (``structure.object_name``); never grouped (PowerPoint cannot
  group placeholders: ``structure.contains_ungroupable``).

The XML is parsed with python-pptx's own parser (its element classes, like every shape python-pptx adds), and every
author-supplied value — the name, the prompt — is set as an attribute / text node, never spliced into markup.
"""
from __future__ import annotations

import copy
import re

from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls, qn

from . import shapes, structure
from .core import ang60k, emu, num
from .text import clean_text

PIC_IDX0 = 13                 # the photo slot with IR slot k (document order) is p:ph type="pic" idx=13+k
PROMPT_SZ = 1400              # the layout prompt's size (1/100 pt): 14 pt

_SLIDE_SLOT = (
    f'<p:sp {nsdecls("a", "p")}><p:nvSpPr><p:cNvPr id="1" name=""/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    '<p:nvPr><p:ph type="pic" idx="0"/></p:nvPr></p:nvSpPr>'
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    '<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></p:spPr></p:sp>'
)
_LAYOUT_SLOT = (
    f'<p:sp {nsdecls("a", "p")}><p:nvSpPr><p:cNvPr id="1" name=""/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
    '<p:nvPr><p:ph type="pic" idx="0"/></p:nvPr></p:nvSpPr>'
    '<p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/>'
    f'<a:defRPr sz="{PROMPT_SZ}"/></a:lvl1pPr></a:lstStyle>'
    '<a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p></p:txBody></p:sp>'
)
_COLOUR_ONLY_TXBODY = (       # a slide slot's prompt colour: no run, no prompt text (the layout's shows through)
    f'<p:txBody {nsdecls("a", "p")}><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="000000"/>'
    '</a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p></p:txBody>'
)
_OWN_FILL_ID = re.compile(r"^(.*)::bg\d*$")        # an element's own fill shapes: '<path>::bg', '<path>::bg2' …


def slot_path(e: dict) -> str | None:
    """The DOM path of a photo slot (its IR id is '<path>::placeholder'); None for any other id."""
    i = str(e.get("id") or "")
    return i[: -len("::placeholder")] if i.endswith("::placeholder") else None


def own_fill_path(ir_id) -> str | None:
    """The DOM path of an element whose OWN fill shape this IR id is ('<path>::bg', '<path>::bgN'), else None — for a
    photo slot, its frame (painted before the slot: the fill and dashed border of the kit's .photo-slot)."""
    m = _OWN_FILL_ID.match(str(ir_id or ""))
    return m.group(1) if m else None


def legible_colour(frame, td: shapes.TextDefaults) -> str | None:
    """The theme text colour ('RRGGBB') a prompt drawn over ``frame`` — the node carrying the slot's own topmost fill —
    should have: the more legible of dk1 / lt1 on its opaque fill (shapes.legible_text_slot, as for text typed into a
    fill shape; a tie keeps ``td.tx1``). None without a frame or for a translucent one: the prompt then sits on
    whatever is behind the slot, and keeps the default."""
    if frame is None:
        return None
    slot = shapes.legible_text_slot(shapes.fill_stops(frame), td)
    return td.colors[slot] if slot is not None else None


def layout_colour(frame, td: shapes.TextDefaults) -> str | None:
    """The explicit prompt colour of a LAYOUT picture placeholder over ``frame`` (the slot's frame lifted into the
    layout; None = not lifted) on a layout whose default text colour is ``td.tx1``: ``legible_colour`` where it differs
    from that default, else None (the prompt inherits tx1 through the layout's colour map)."""
    want = legible_colour(frame, td)
    return want if want is not None and want != td.colors[td.tx1] else None


def colour_slide_prompts(slot_prompts: list, layout_colours: dict) -> int:
    """Each slide photo slot ``(p:sp, idx, frame, slide TextDefaults)`` whose slide would show its prompt in another
    colour than ``legible_colour`` on its frame gets the colour-only txBody. What the slide shows without one: its
    layout placeholder's explicit colour (``layout_colours[idx]``), else tx1 on the slide's colour map. Run once the
    layout placeholders exist. Returns the number coloured."""
    n = 0
    for sp, idx, frame, td in slot_prompts:
        want = legible_colour(frame, td)
        if want is None or want == (layout_colours.get(idx) or td.colors[td.tx1]):
            continue
        tx = parse_xml(_COLOUR_ONLY_TXBODY)          # after spPr (CT_Shape: nvSpPr, spPr, style?, txBody?)
        tx.find(f"{qn('a:lstStyle')}/{qn('a:lvl1pPr')}/{qn('a:defRPr')}/{qn('a:solidFill')}/{qn('a:srgbClr')}").set("val", want)
        sp.append(tx)
        n += 1
    return n


def _solid_fill(colour: str):
    f = parse_xml(f'<a:solidFill {nsdecls("a")}><a:srgbClr val="000000"/></a:solidFill>')
    f[0].set("val", colour)
    return f


def _named(sp, shape_id: int, name: str, idx: int):
    nv = sp.find(qn("p:nvSpPr"))
    cnv = nv.find(qn("p:cNvPr"))
    cnv.set("id", str(int(shape_id)))
    cnv.set("name", name)
    ph = nv.find(f"{qn('p:nvPr')}/{qn('p:ph')}")
    ph.set("idx", str(int(idx)))
    return ph


def add_pic_placeholder(slide, e: dict, ctx, idx: int):
    """IR photo slot -> the slide's empty picture placeholder (idx = 13 + its IR slot); its prompt colour comes later
    (``colour_slide_prompts``)."""
    if e.get("placeholder") != "pic":
        raise ValueError(f"placeholder {e.get('placeholder')!r} is not a photo slot (only \"pic\")")
    tree = slide.shapes._spTree
    b = e.get("box") or {}
    sp = parse_xml(_SLIDE_SLOT)
    _named(sp, structure.next_shape_id(tree), ctx.namer(ctx.name_for(e)), idx)
    xfrm = sp.find(f"{qn('p:spPr')}/{qn('a:xfrm')}")
    xfrm.find(qn("a:off")).set("x", str(emu(num(b.get("x")))))
    xfrm.find(qn("a:off")).set("y", str(emu(num(b.get("y")))))
    xfrm.find(qn("a:ext")).set("cx", str(max(0, emu(num(b.get("w"))))))
    xfrm.find(qn("a:ext")).set("cy", str(max(0, emu(num(b.get("h"))))))
    rot = num(e.get("rotationDeg"))
    if rot:
        xfrm.set("rot", str(ang60k(rot)))
    tree.insert_element_before(sp, "p:extLst")
    ctx.stat("placeholder:pic")
    return sp


def layout_slot_sp(shape_id: int, name: str, idx: int, slide_sp, prompt, typeface: str | None,
                   colour: str | None = None):
    """The layout picture placeholder for idx: the slide slot's xfrm, the prompt (hasCustomPrompt only with one), and
    an explicit prompt colour only when given (the slot's frame lifted into the layout: ``layout_colour``)."""
    sp = parse_xml(_LAYOUT_SLOT)
    ph = _named(sp, shape_id, name, idx)
    text = clean_text(" ".join(str(prompt or "").split()))
    if text:
        ph.set("hasCustomPrompt", "1")
    src = slide_sp.find(f"{qn('p:spPr')}/{qn('a:xfrm')}")
    sp.find(qn("p:spPr")).insert(0, copy.deepcopy(src))
    tx = sp.find(qn("p:txBody"))
    d = tx.find(f"{qn('a:lstStyle')}/{qn('a:lvl1pPr')}/{qn('a:defRPr')}")
    if colour:                                    # CT_TextCharacterProperties: the fill before latin / ea / cs
        d.insert(0, _solid_fill(colour))
    if typeface:
        for slot in ("a:latin", "a:ea", "a:cs"):
            d.append(parse_xml(f'<{slot} {nsdecls("a")} typeface=""/>'))
            d[-1].set("typeface", typeface)
    if text:
        ap = tx.find(qn("a:p"))
        r = parse_xml(f'<a:r {nsdecls("a")}><a:rPr lang="ko-KR" altLang="en-US"/><a:t/></a:r>')
        r.find(qn("a:t")).text = text
        ap.insert(0, r)
    return sp
