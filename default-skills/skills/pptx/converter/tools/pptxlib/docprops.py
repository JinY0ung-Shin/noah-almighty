"""Package metadata (judge J1-08): core properties, extended properties and the thumbnail.

python-pptx starts from its own template, whose ``docProps`` describe a 2013 4:3 deck by "Steve Canny" with a blank
white thumbnail. The builder writes: core ``title`` (the first slide's title placeholder text, line breaks as
spaces), ``creator``/``lastModifiedBy`` (``--author``, default "Noah Almighty"), ``created``/``modified`` (now, or
``SOURCE_DATE_EPOCH`` for reproducible builds), an empty description; ``app.xml`` with the real slide/notes counts,
"Widescreen", the theme and the slide titles (TitlesOfParts); ``thumbnail.jpeg`` = the first slide's HTML reference
render at 256x144 (Explorer, SharePoint and Teams show it until PowerPoint re-saves the file).
"""
from __future__ import annotations

import datetime as _dt
import io
import os
from xml.sax.saxutils import escape

from PIL import Image

EP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
VT_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
THUMB_SIZE = (256, 144)


def build_time() -> _dt.datetime:
    sde = os.environ.get("SOURCE_DATE_EPOCH")
    if sde and sde.strip().isdigit():
        return _dt.datetime.fromtimestamp(int(sde), _dt.timezone.utc).replace(tzinfo=None)
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0, tzinfo=None)


def _part(prs, partname: str):
    for p in prs.part.package.iter_parts():
        if str(p.partname) == partname:
            return p
    return None


def set_core(prs, *, title: str, author: str, when: _dt.datetime) -> None:
    cp = prs.core_properties
    cp.title = title
    cp.author = author
    cp.last_modified_by = author
    cp.created = when
    cp.modified = when
    cp.revision = 1
    cp.comments = ""            # dc:description ("generated using python-pptx" in the template)
    cp.subject = ""
    cp.keywords = ""
    cp.category = ""


def app_xml(*, slides: int, notes: int, hidden: int, words: int, paragraphs: int, theme: str,
            titles: list[str], application: str) -> bytes:
    heading = ("<HeadingPairs><vt:vector size=\"4\" baseType=\"variant\">"
               "<vt:variant><vt:lpstr>테마</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant>"
               "<vt:variant><vt:lpstr>슬라이드 제목</vt:lpstr></vt:variant>"
               f"<vt:variant><vt:i4>{len(titles)}</vt:i4></vt:variant></vt:vector></HeadingPairs>")
    parts = "".join(f"<vt:lpstr>{escape(t)}</vt:lpstr>" for t in [theme] + titles)
    top = (f"<TitlesOfParts><vt:vector size=\"{1 + len(titles)}\" baseType=\"lpstr\">{parts}</vt:vector>"
           "</TitlesOfParts>")
    xml = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
           f'<Properties xmlns="{EP_NS}" xmlns:vt="{VT_NS}">'
           f"<TotalTime>0</TotalTime><Words>{words}</Words><Application>{escape(application)}</Application>"
           f"<PresentationFormat>Widescreen</PresentationFormat><Paragraphs>{paragraphs}</Paragraphs>"
           f"<Slides>{slides}</Slides><Notes>{notes}</Notes><HiddenSlides>{hidden}</HiddenSlides>"
           f"<MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>{heading}{top}"
           "<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>"
           "<HyperlinksChanged>false</HyperlinksChanged></Properties>")
    return xml.encode("utf-8")


def set_app(prs, **kw) -> bool:
    p = _part(prs, "/docProps/app.xml")
    if p is None:
        return False
    p._blob = app_xml(**kw)
    return True


def set_thumbnail(prs, png_path) -> bool:
    p = _part(prs, "/docProps/thumbnail.jpeg")
    if p is None or png_path is None or not os.path.isfile(png_path):
        return False
    with Image.open(png_path) as im:
        im = im.convert("RGB").resize(THUMB_SIZE, Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=88, optimize=True)
    p._blob = buf.getvalue()
    return True
