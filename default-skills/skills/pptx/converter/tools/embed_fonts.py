#!/usr/bin/env python3
"""Embed TrueType fonts into a .pptx the way PowerPoint (Microsoft 365, Windows) stores them.

Contract API (docs/CONTRACT.md "Font embedding API")::

    embed_fonts(pptx_in, pptx_out, faces)   # faces: [{"typeface", "slot", "file"}, ...]

CLI::

    python3 tools/embed_fonts.py IN.pptx OUT.pptx --profile embedded   # faces from fonts/fonts.json
    python3 tools/embed_fonts.py IN.pptx OUT.pptx --face "Pretendard:regular:fonts/Pretendard-Regular.ttf"
    python3 tools/embed_fonts.py --verify DECK.pptx [--profile P]      # structural self-check only (a build gate)

What gets written (evidence: docs/research/font-embedding.md):

* one part per face, ``/ppt/fonts/fontN.fntdata`` = uncompressed EOT 0x00020002 wrapping the unmodified TTF
  (tools/eot.py), targeted by a ``…/officeDocument/2006/relationships/font`` relationship from the presentation
  part;
* ``<Default Extension="fntdata" ContentType="application/x-fontdata"/>`` in ``[Content_Types].xml``;
* ``<p:embeddedFontLst>`` at its schema position (after notesSz/smartTags) holding one ``<p:embeddedFont>`` per
  typeface: ``<p:font typeface panose? pitchFamily charset/>`` then ``regular|bold|italic|boldItalic`` in schema
  order;
* ``embedTrueTypeFonts="1"`` on ``<p:presentation>``; ``saveSubsetFonts`` removed so that a PowerPoint re-save keeps
  "Embed all characters" (full, editable fonts);
* no *implicit* font relationships: a presentation -> font relationship that no ``embeddedFont`` slot references is
  dropped together with its part ([MS-OI29500] 2.1.18 c: Office only allows explicit font relationships).

A typeface counts as "used" when the deck references it case-insensitively (Office matches typefaces that way); a
case-only difference is embedded with a warning rather than silently skipped.

Safe on python-pptx output; IN may equal OUT; idempotent (re-running replaces the entries for the same typefaces,
reusing the same part names and relationship ids).
"""
from __future__ import annotations

import argparse
import html
import json
import os
import posixpath
import re
import sys
import tempfile
import zipfile
from collections import OrderedDict
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import eot  # noqa: E402  (tools/eot.py)
import pdeathsig  # noqa: E402  (tools/pdeathsig.py)

KIT = Path(__file__).resolve().parent.parent   # the converter toolkit (fonts.json paths are relative to it)
POC = KIT                                      # PoC name, kept as an alias

NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships"
REL_OFFICE_DOCUMENT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
REL_FONT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
CT_FONTDATA = "application/x-fontdata"
SLOTS = ("regular", "bold", "italic", "boldItalic")  # CT_EmbeddedFontListEntry child order
# CT_Presentation child sequence (ECMA-376 Part 1/4 pml.xsd)
PRES_CHILDREN = ("sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz",
                 "smartTags", "embeddedFontLst", "custShowLst", "photoAlbum", "custDataLst", "kinsoku",
                 "defaultTextStyle", "modifyVerifier", "extLst")
_TYPEFACE_RE = re.compile(rb"""\btypeface=(?:"([^"]*)"|'([^']*)')""")


class EmbedError(Exception):
    """Invalid input (faces, fonts, or package) — nothing was written."""


def _q(ns: str, tag: str) -> str:
    return f"{{{ns}}}{tag}"


def _log_default(msg: str) -> None:
    print(msg, file=sys.stderr)


# --- faces ---------------------------------------------------------------------------------------------------
def _resolve_font_path(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else (KIT / p)


def _prepare_faces(faces: list[dict], *, allow_preview_print: bool, log) -> "OrderedDict[str, dict]":
    """Validate faces, read fonts, build EOT blobs. Returns {typeface: {slot: info}} in input order."""
    if not faces:
        raise EmbedError("no faces given")
    groups: "OrderedDict[str, dict]" = OrderedDict()
    for i, face in enumerate(faces):
        try:
            typeface, slot, file = face["typeface"], face["slot"], face["file"]
        except (KeyError, TypeError) as exc:
            raise EmbedError(f"face #{i} must have typeface, slot and file: {face!r}") from exc
        if not typeface or not isinstance(typeface, str):
            raise EmbedError(f"face #{i}: empty typeface")
        if slot not in SLOTS:
            raise EmbedError(f"face #{i} ({typeface}): slot {slot!r} not one of {SLOTS}")
        if not file:
            raise EmbedError(f"face #{i} ({typeface}/{slot}): file is null — nothing to embed")
        existing = next((t for t in groups if t.lower() == typeface.lower()), None)
        if existing is not None and existing != typeface:
            raise EmbedError(f"typefaces {existing!r} and {typeface!r} differ only by case "
                             "(PowerPoint requires unique embeddedFont typefaces)")
        group = groups.setdefault(typeface, {})
        if slot in group:
            raise EmbedError(f"typeface {typeface!r} has two faces for slot {slot!r}")
        font_path = _resolve_font_path(file)
        try:
            font_bytes = font_path.read_bytes()
        except OSError as exc:
            raise EmbedError(f"cannot read font {font_path}: {exc}") from exc
        try:
            facts = eot.font_facts(font_bytes)
            if not facts.is_truetype:
                raise EmbedError(f"{font_path.name}: not a TrueType-outline (glyf) font — CFF/OTTO fonts are "
                                 "not supported (LibreOffice/libeot cannot read them; see doc §5)")
            if facts.is_variable:
                raise EmbedError(f"{font_path.name}: variable font — embed static instances instead "
                                 "(PowerPoint reports embedded variable fonts as unavailable, tdf#167214)")
            eot.check_editable_embedding(facts, allow_preview_print=allow_preview_print)
            if typeface not in facts.family_names:
                raise EmbedError(
                    f"{font_path.name}: typeface {typeface!r} is not one of the font's family names (name ID 1) "
                    f"{facts.family_names!r}. PowerPoint matches runs to embedded fonts by this name; for a "
                    "non-RIBBI weight use its own legacy family (e.g. 'Pretendard SemiBold') in the regular slot.")
            blob = eot.ttf_to_eot(font_bytes, family_name=typeface)
        except eot.EOTError as exc:
            raise EmbedError(f"{font_path.name}: {exc}") from exc
        problems = eot.verify_eot(blob, font_bytes, expect_family=typeface)
        if problems:
            raise EmbedError(f"{font_path.name}: EOT self-check failed: {problems}")
        want_bold = slot in ("bold", "boldItalic")
        want_italic = slot in ("italic", "boldItalic")
        if facts.italic != want_italic:
            log(f"warning: {font_path.name} italic={facts.italic} placed in slot {slot!r}")
        if want_bold and not (facts.bold or facts.weight >= 600):
            log(f"warning: {font_path.name} (weight {facts.weight}) placed in bold slot {slot!r}")
        if not want_bold and facts.bold:
            log(f"warning: {font_path.name} has the bold style bit but is placed in slot {slot!r}")
        group[slot] = {"file": font_path, "facts": facts, "blob": blob}
    return groups


# --- package helpers -----------------------------------------------------------------------------------------
def _rels_path(part: str) -> str:
    d, f = posixpath.split(part)
    return posixpath.join(d, "_rels", f + ".rels")


def _resolve_target(source_part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target))


def _parse(data: bytes, what: str) -> etree._Element:
    try:
        return etree.fromstring(data, parser=etree.XMLParser(resolve_entities=False, no_network=True,
                                                             remove_blank_text=False))
    except etree.XMLSyntaxError as exc:
        raise EmbedError(f"{what} is not well-formed XML: {exc}") from exc


def _serialize(root: etree._Element) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _main_part(entries: "OrderedDict[str, bytes]") -> str:
    rels = entries.get("_rels/.rels")
    if rels is None:
        raise EmbedError("package has no _rels/.rels")
    root = _parse(rels, "_rels/.rels")
    for rel in root.findall(_q(NS_PR, "Relationship")):
        if rel.get("Type") == REL_OFFICE_DOCUMENT and rel.get("TargetMode") != "External":
            return _resolve_target("", rel.get("Target"))
    raise EmbedError("no officeDocument relationship in _rels/.rels")


def used_typefaces(entries: "OrderedDict[str, bytes]", pres_part: str, pres_root: etree._Element) -> set[str]:
    """Every literal typeface referenced by slides, layouts, masters, notes, themes, charts … and the
    presentation's defaultTextStyle (the embeddedFontLst itself is excluded)."""
    found: set[str] = set()
    for name, data in entries.items():
        if not name.endswith(".xml") or name == pres_part or name.startswith(("_rels/", "docProps/")) \
                or "/_rels/" in name or name == "[Content_Types].xml":
            continue
        for m in _TYPEFACE_RE.finditer(data):
            raw = m.group(1) if m.group(1) is not None else m.group(2)
            found.add(html.unescape(raw.decode("utf-8", "replace")))
    dts = pres_root.find(_q(NS_P, "defaultTextStyle"))
    if dts is not None:
        for el in dts.iter():
            tf = el.get("typeface")
            if tf:
                found.add(tf)
    return found


def _insert_in_sequence(parent: etree._Element, child: etree._Element, order: tuple[str, ...], ns: str) -> None:
    """Insert ``child`` so ``parent``'s children stay in schema order (unknown children are left in place)."""
    idx = order.index(etree.QName(child).localname)
    later = {_q(ns, t) for t in order[idx + 1:]}
    for i, existing in enumerate(parent):
        if existing.tag in later:
            parent.insert(i, child)
            return
    parent.append(child)


def _next_rid(rels_root: etree._Element) -> "callable":
    used = {r.get("Id") for r in rels_root}
    nums = [int(m.group(1)) for rid in used if rid and (m := re.fullmatch(r"rId(\d+)", rid))]
    counter = [max(nums, default=0)]

    def take() -> str:
        while True:
            counter[0] += 1
            rid = f"rId{counter[0]}"
            if rid not in used:
                used.add(rid)
                return rid
    return take


def _signed_byte(v: int) -> int:
    return v - 256 if v > 127 else v


# --- main operation ------------------------------------------------------------------------------------------
def embed_fonts(pptx_in: str, pptx_out: str, faces: list[dict], *, allow_preview_print: bool = False,
                require_used: bool = True, log=_log_default) -> None:
    """Embed ``faces`` into ``pptx_in`` and write ``pptx_out`` (may be the same path).

    ``faces``: ``[{"typeface": str, "slot": "regular"|"bold"|"italic"|"boldItalic", "file": path}, ...]``; paths
    are relative to the PoC root unless absolute. Faces sharing a typeface become one ``<p:embeddedFont>``.
    ``require_used``: skip (with a warning) typefaces the deck never references — [MS-OE376] 2.1.1134 says
    "PowerPoint further requires that all of the fonts specified in this list shall be used in this presentation".
    The reference test is case-insensitive, like Office's typeface matching.
    """
    groups = _prepare_faces(faces, allow_preview_print=allow_preview_print, log=log)
    inherited = set(verify_pptx(pptx_in, strict_typefaces=set(groups)))  # problems already in the input

    with zipfile.ZipFile(pptx_in) as zin:
        infos = zin.infolist()
        names = [i.filename for i in infos]
        if len(set(names)) != len(names):
            raise EmbedError(f"{pptx_in}: duplicate zip entry names")
        entries: "OrderedDict[str, bytes]" = OrderedDict((i.filename, zin.read(i)) for i in infos)
        compress = {i.filename: i.compress_type for i in infos}

    pres_part = _main_part(entries)
    pres_rels_part = _rels_path(pres_part)
    if pres_part not in entries:
        raise EmbedError(f"main part {pres_part} missing")
    pres = _parse(entries[pres_part], pres_part)
    if pres.tag != _q(NS_P, "presentation"):
        raise EmbedError(f"{pres_part} is not a PresentationML presentation ({pres.tag})")
    rels = _parse(entries[pres_rels_part], pres_rels_part) if pres_rels_part in entries \
        else etree.Element(_q(NS_PR, "Relationships"), nsmap={None: NS_PR})
    ct = _parse(entries["[Content_Types].xml"], "[Content_Types].xml")

    # 1. which typefaces does the deck use? Office resolves typefaces case-insensitively (GDI/DirectWrite family
    #    lookup; POI's XSLFFontInfo also uses equalsIgnoreCase), so a case-only difference still counts as "used" —
    #    skipping it would silently leave those runs on a fallback font.
    used = used_typefaces(entries, pres_part, pres)
    used_lower = {t.lower() for t in used}
    selected: "OrderedDict[str, dict]" = OrderedDict()
    for typeface, group in groups.items():
        if typeface in used or not require_used:
            selected[typeface] = group
        elif typeface.lower() in used_lower:
            variants = sorted(t for t in used if t.lower() == typeface.lower())
            log(f"warning: the deck spells typeface {typeface!r} as {variants!r} (case differs); embedding it anyway "
                "(Office matches typefaces case-insensitively) — builders should use the exact name")
            selected[typeface] = group
        else:
            log(f"warning: typeface {typeface!r} is not referenced by the deck — not embedded "
                "([MS-OE376] 2.1.1134: every embedded font must be used)")

    # 2. drop existing entries for the typefaces we (re)embed, with their relationships and parts
    rel_by_id = {r.get("Id"): r for r in rels.findall(_q(NS_PR, "Relationship"))}
    font_list = pres.find(_q(NS_P, "embeddedFontLst"))
    removed_parts: set[str] = set()
    if font_list is not None:
        lowered = {t.lower() for t in selected}
        for ef in list(font_list.findall(_q(NS_P, "embeddedFont"))):
            font_el = ef.find(_q(NS_P, "font"))
            tf = font_el.get("typeface") if font_el is not None else None
            if tf is None or tf.lower() not in lowered:
                continue
            for slot_el in ef:
                rid = slot_el.get(_q(NS_R, "id"))
                rel = rel_by_id.pop(rid, None) if rid else None
                if rel is not None and rel.get("Type") == REL_FONT:
                    removed_parts.add(_resolve_target(pres_part, rel.get("Target")))
                    rels.remove(rel)
            font_list.remove(ef)
    # 2b. Office only allows an *explicit* Presentation -> Font relationship ([MS-OI29500] 2.1.18 c; ECMA-376 Part 1
    #     §15.2.13 "shall be the target of an explicit relationship"). A font relationship that no embeddedFont slot
    #     references is unusable by any reader, so drop it (and, below, its part) instead of shipping it.
    slot_rids: set[str] = set()
    if font_list is not None:
        for ef in font_list.findall(_q(NS_P, "embeddedFont")):
            slot_rids.update(rid for slot_el in ef if (rid := slot_el.get(_q(NS_R, "id"))))
    for rel in list(rels.findall(_q(NS_PR, "Relationship"))):
        if rel.get("Type") == REL_FONT and rel.get("Id") not in slot_rids:
            log(f"warning: dropping font relationship {rel.get('Id')} -> {rel.get('Target')}: no embeddedFont "
                "references it (Office allows only explicit font relationships, [MS-OI29500] 2.1.18 c)")
            if rel.get("TargetMode") != "External":
                removed_parts.add(_resolve_target(pres_part, rel.get("Target")))
            rels.remove(rel)
    # a part may only go if no remaining relationship (anywhere) still targets it
    still_targeted: set[str] = set()
    for name, data in entries.items():
        if name.endswith(".rels") and name != pres_rels_part:
            src_dir = posixpath.dirname(posixpath.dirname(name))
            src_part = posixpath.join(src_dir, posixpath.basename(name)[:-5])
            for r in _parse(data, name).findall(_q(NS_PR, "Relationship")):
                if r.get("TargetMode") != "External":
                    still_targeted.add(_resolve_target(src_part, r.get("Target")))
    for r in rels.findall(_q(NS_PR, "Relationship")):
        if r.get("TargetMode") != "External":
            still_targeted.add(_resolve_target(pres_part, r.get("Target")))
    for part in removed_parts - still_targeted:
        entries.pop(part, None)
        compress.pop(part, None)

    # 3. new parts + relationships + list entries
    if selected:
        if font_list is None:
            font_list = etree.Element(_q(NS_P, "embeddedFontLst"))
            _insert_in_sequence(pres, font_list, PRES_CHILDREN, NS_P)
        take_rid = _next_rid(rels)
        pres_dir = posixpath.dirname(pres_part)
        taken = {k.lower() for k in entries}  # OPC part names compare case-insensitively
        n = 0
        for typeface, group in selected.items():
            ef = etree.SubElement(font_list, _q(NS_P, "embeddedFont"))
            first = group.get("regular") or next(iter(group.values()))
            facts: eot.FontFacts = first["facts"]
            font_el = etree.SubElement(ef, _q(NS_P, "font"))
            font_el.set("typeface", typeface)
            if any(facts.panose):
                font_el.set("panose", facts.panose_hex)
            font_el.set("pitchFamily", str(facts.gdi_pitch_family()))
            font_el.set("charset", str(_signed_byte(facts.gdi_charset())))
            for slot in SLOTS:
                if slot not in group:
                    continue
                while True:
                    n += 1
                    part = posixpath.join(pres_dir, "fonts", f"font{n}.fntdata")
                    if part.lower() not in taken:
                        break
                taken.add(part.lower())
                entries[part] = group[slot]["blob"]
                compress[part] = zipfile.ZIP_DEFLATED
                rid = take_rid()
                rel = etree.SubElement(rels, _q(NS_PR, "Relationship"))
                rel.set("Id", rid)
                rel.set("Type", REL_FONT)
                rel.set("Target", posixpath.relpath(part, pres_dir))
                slot_el = etree.SubElement(ef, _q(NS_P, slot))
                slot_el.set(_q(NS_R, "id"), rid)
                log(f"embedded {typeface!r} {slot} <- {group[slot]['file'].name} as /{part} ({rid}, "
                    f"{len(group[slot]['blob'])} bytes EOT)")
    if font_list is not None and len(font_list) == 0:
        pres.remove(font_list)  # never leave an empty list behind
        font_list = None

    # 4. presentation attributes
    if font_list is not None:
        pres.set("embedTrueTypeFonts", "1")
        if "saveSubsetFonts" in pres.attrib:
            del pres.attrib["saveSubsetFonts"]

    # 5. content types: Default for .fntdata, and no stale Overrides for removed/new font parts
    has_fonts = any(name.lower().endswith(".fntdata") for name in entries)
    defaults = ct.findall(_q(NS_CT, "Default"))
    fnt_default = next((d for d in defaults if (d.get("Extension") or "").lower() == "fntdata"), None)
    if has_fonts:
        if fnt_default is None:
            fnt_default = etree.Element(_q(NS_CT, "Default"))
            fnt_default.set("Extension", "fntdata")
            if defaults:
                defaults[-1].addnext(fnt_default)
            else:
                ct.insert(0, fnt_default)
        fnt_default.set("ContentType", CT_FONTDATA)
    for ov in ct.findall(_q(NS_CT, "Override")):
        pn = (ov.get("PartName") or "").lstrip("/")
        if pn.lower().endswith(".fntdata") and (pn in removed_parts or pn not in entries
                                                 or ov.get("ContentType") != CT_FONTDATA):
            ct.remove(ov)

    entries["[Content_Types].xml"] = _serialize(ct)
    entries[pres_part] = _serialize(pres)
    entries[pres_rels_part] = _serialize(rels)
    compress.setdefault(pres_rels_part, zipfile.ZIP_DEFLATED)

    # 6. write (atomically; IN may equal OUT). [Content_Types].xml first, original order otherwise.
    out_path = Path(pptx_out)
    order = ["[Content_Types].xml"] + [k for k in entries if k != "[Content_Types].xml"]
    fd, tmp = tempfile.mkstemp(prefix=".embed-", suffix=".pptx", dir=str(out_path.resolve().parent))
    os.close(fd)
    if out_path.exists():
        mode = out_path.stat().st_mode & 0o777
    else:
        umask = os.umask(0)
        os.umask(umask)
        mode = 0o666 & ~umask
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED) as zout:
            for name in order:
                zi = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                zi.compress_type = compress.get(name, zipfile.ZIP_DEFLATED)
                zi.external_attr = 0o644 << 16
                zout.writestr(zi, entries[name])
        # Verify BEFORE replacing OUT (so a failure never clobbers IN==OUT). Fail only on problems we introduced:
        # pre-existing foreign issues (e.g. a Canva part whose EOT FamilyName is "Canva Sans" under typeface
        # "Canva Sans Bold") are reported, not fatal.
        problems = verify_pptx(tmp, strict_typefaces=set(groups))
        new = [p for p in problems if p not in inherited]
        for p in problems:
            if p in inherited:
                log(f"warning: pre-existing problem kept as-is: {p}")
        if new:
            raise EmbedError(f"verification of the written package failed (nothing written): {new}")
        os.chmod(tmp, mode)  # mkstemp creates 0600; give OUT normal permissions
        os.replace(tmp, out_path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# --- verification --------------------------------------------------------------------------------------------
SFNT_CHECKSUM_MAGIC = 0xB1B0AFBA        # OpenType: the uint32 sum of a whole font file with a correct head
                                        # checkSumAdjustment (every face in fonts/ satisfies it)
FS_BOLD, FS_ITALIC = 0x20, 0x01          # OS/2.fsSelection bits Windows style-links RIBBI faces by
SLOT_STYLE = {"regular": (False, False), "bold": (True, False), "italic": (False, True), "boldItalic": (True, True)}


def _sfnt_checksum(font: bytes) -> int:
    import struct
    pad = font + b"\0" * (-len(font) % 4)
    return sum(struct.unpack(f">{len(pad) // 4}I", pad)) & 0xFFFFFFFF


def payload_problems(data: bytes, typeface: str, slot: str, expect_file: str | None = None) -> list[str]:
    """What the EOT header cross-check cannot see (fixer round 3, VR-11): the payload's own integrity (a corrupted glyph
    region keeps every header field and name-table fact intact — the whole-file sfnt checksum does not), its style
    against the slot it is bound to (a regular / bold swap renders every regular run bold: OS/2 fsSelection BOLD /
    ITALIC must be the slot's), and — when fonts.json names the face — byte identity with that file."""
    import hashlib
    import io
    try:
        hdr, payload = eot.parse_eot(data)
    except eot.EOTError as exc:
        return [f"parse: {exc}"]
    if hdr.flags & eot.TTEMBED_TTCOMPRESSED:
        return []                                   # MTX payload: not decoded here (the builder never writes one)
    out = []
    if _sfnt_checksum(payload) != SFNT_CHECKSUM_MAGIC:
        out.append(f"{typeface}/{slot}: font payload checksum {_sfnt_checksum(payload):#010x} != "
                   f"{SFNT_CHECKSUM_MAGIC:#010x} (the embedded font file is damaged)")
    try:
        from fontTools.ttLib import TTFont
        fs = TTFont(io.BytesIO(payload), lazy=True)["OS/2"].fsSelection
        got = (bool(fs & FS_BOLD), bool(fs & FS_ITALIC))
        if slot in SLOT_STYLE and got != SLOT_STYLE[slot]:
            out.append(f"{typeface}/{slot}: the {slot} slot holds a font with bold={got[0]} italic={got[1]} "
                       "(fsSelection): runs of that style would render with the wrong face")
    except Exception as exc:  # noqa: BLE001 — fontTools raises a variety of errors on corrupt input
        out.append(f"{typeface}/{slot}: payload not readable by fontTools: {exc}")
    if expect_file:
        want = _resolve_font_path(expect_file).read_bytes()
        if hashlib.sha256(payload).digest() != hashlib.sha256(want).digest():
            out.append(f"{typeface}/{slot}: payload is not {expect_file} (fonts.json face for this slot)")
    return out


def verify_pptx(path: str, strict_typefaces: set[str] | None = None, faces: list[dict] | None = None) -> list[str]:
    """Structural checks of the font embedding in a written deck (empty list = OK).

    Every ``.fntdata`` must parse as EOT; for typefaces in ``strict_typefaces`` (all when None) the EOT header must
    also agree with its payload and carry FamilyName == typeface (the invariant ``embed_fonts`` writes), the payload
    must be intact and of its slot's style (``payload_problems``); with ``faces`` (fonts.json faces with a file) every
    embedded (typeface, slot) that fonts.json names must hold exactly that file. Which faces a deck must embed (the ones
    its runs use) is the font-coverage gate's (tools/inspect_pptx.py --fonts-only): embed_fonts skips unused typefaces.
    """
    face_file = {(f["typeface"], f["slot"]): f["file"] for f in faces or [] if f.get("file")}
    problems: list[str] = []
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        return [f"not a zip: {exc}"]
    with z:
        bad = z.testzip()
        if bad:
            problems.append(f"CRC error in {bad}")
        names = z.namelist()
        if len(set(names)) != len(names):
            problems.append("duplicate zip entries")
        entries = {n: z.read(n) for n in names}
    for n, data in entries.items():
        if n.endswith((".xml", ".rels")):
            try:
                etree.fromstring(data)
            except etree.XMLSyntaxError as exc:
                problems.append(f"{n}: not well-formed: {exc}")
    if problems:
        return problems
    ct = etree.fromstring(entries["[Content_Types].xml"])
    defaults = {(d.get("Extension") or "").lower(): d.get("ContentType") for d in ct.findall(_q(NS_CT, "Default"))}
    overrides = {(o.get("PartName") or "").lstrip("/"): o.get("ContentType") for o in ct.findall(_q(NS_CT, "Override"))}
    for n in names:
        if n.endswith("/") or n == "[Content_Types].xml":
            continue
        ext = n.rsplit(".", 1)[-1].lower() if "." in posixpath.basename(n) else ""
        if n not in overrides and ext not in defaults:
            problems.append(f"no content type for /{n}")
    try:
        pres_part = _main_part(OrderedDict(entries))
    except EmbedError as exc:
        return problems + [str(exc)]
    pres = etree.fromstring(entries[pres_part])
    rels_part = _rels_path(pres_part)
    rels = {r.get("Id"): r for r in etree.fromstring(entries[rels_part]).findall(_q(NS_PR, "Relationship"))} \
        if rels_part in entries else {}
    # child order
    positions = [PRES_CHILDREN.index(etree.QName(c).localname) for c in pres
                 if isinstance(c.tag, str) and etree.QName(c).namespace == NS_P
                 and etree.QName(c).localname in PRES_CHILDREN]
    if positions != sorted(positions):
        problems.append("presentation children out of schema order")
    fl = pres.find(_q(NS_P, "embeddedFontLst"))
    font_parts = {n for n in names if n.lower().endswith(".fntdata")}
    referenced: set[str] = set()
    if fl is not None:
        if pres.get("embedTrueTypeFonts") not in ("1", "true"):
            problems.append("embeddedFontLst present but embedTrueTypeFonts is not true")
        seen: set[str] = set()
        for ef in fl.findall(_q(NS_P, "embeddedFont")):
            kids = [etree.QName(c).localname for c in ef]
            if not kids or kids[0] != "font":
                problems.append("embeddedFont without leading p:font")
                continue
            order = [SLOTS.index(k) for k in kids[1:] if k in SLOTS]
            if order != sorted(order) or len(order) != len(set(order)) or len(order) != len(kids) - 1:
                problems.append(f"embeddedFont children invalid/out of order: {kids}")
            tf = ef[0].get("typeface")
            if not tf:
                problems.append("p:font without typeface")
                continue
            if tf.lower() in seen:
                problems.append(f"duplicate embeddedFont typeface {tf!r}")
            seen.add(tf.lower())
            cs = ef[0].get("charset")
            if cs is not None and not -128 <= int(cs) <= 127:
                problems.append(f"{tf}: charset {cs} is not an xsd:byte")
            for slot_el in list(ef)[1:]:
                rid = slot_el.get(_q(NS_R, "id"))
                rel = rels.get(rid)
                if rel is None:
                    problems.append(f"{tf}/{etree.QName(slot_el).localname}: r:id {rid} has no relationship")
                    continue
                if rel.get("Type") != REL_FONT:
                    problems.append(f"{tf}: {rid} is not a font relationship")
                target = _resolve_target(pres_part, rel.get("Target"))
                referenced.add(target)
                if target not in entries:
                    problems.append(f"{tf}: {rid} -> missing part /{target}")
                    continue
                ext = target.rsplit(".", 1)[-1].lower()
                ctype = overrides.get(target) or defaults.get(ext)
                if ctype != CT_FONTDATA:
                    problems.append(f"/{target}: content type {ctype!r}, expected {CT_FONTDATA}")
                strict = strict_typefaces is None or tf in strict_typefaces
                if strict:
                    check = eot.verify_eot(entries[target], expect_family=tf)
                    check = [c for c in check if not c.startswith("note:")]
                    check += payload_problems(entries[target], tf, etree.QName(slot_el).localname,
                                              face_file.get((tf, etree.QName(slot_el).localname)))
                else:
                    try:
                        eot.parse_eot(entries[target])
                        check = []
                    except eot.EOTError as exc:
                        check = [f"parse: {exc}"]
                if check:
                    problems.append(f"/{target}: {check}")
    for part in sorted(font_parts - referenced):
        problems.append(f"orphan font part /{part}")
    return problems


# --- CLI -----------------------------------------------------------------------------------------------------
def faces_from_profile(profile: str, fonts_json: str | None = None) -> list[dict]:
    path = Path(fonts_json) if fonts_json else KIT / "fonts" / "fonts.json"
    cfg = json.loads(path.read_text(encoding="utf-8"))
    try:
        prof = cfg["profiles"][profile]
    except KeyError as exc:
        raise EmbedError(f"profile {profile!r} not in {path}") from exc
    return [{"typeface": f["typeface"], "slot": f["slot"], "file": f["file"]}
            for f in prof.get("faces", []) if f.get("file")]


def main(argv: list[str] | None = None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="Embed TrueType fonts into a .pptx (PowerPoint-compatible EOT parts).")
    ap.add_argument("pptx_in", nargs="?")
    ap.add_argument("pptx_out", nargs="?")
    ap.add_argument("--profile", help="fonts.json profile whose faces (with a non-null file) are embedded")
    ap.add_argument("--fonts-json", help="default: <KIT>/fonts/fonts.json")
    ap.add_argument("--face", action="append", default=[], metavar="TYPEFACE:SLOT:FILE",
                    help="ad-hoc face (repeatable); combined with --profile if both are given")
    ap.add_argument("--allow-unused", action="store_true", help="embed typefaces the deck does not reference")
    ap.add_argument("--allow-preview-print", action="store_true",
                    help="accept fsType preview&print fonts (deck opens read-only where the font is missing)")
    ap.add_argument("--verify", metavar="PPTX", help="only run the structural self-check on PPTX (with --profile: "
                    "also every fonts.json face's file in its slot, byte for byte)")
    args = ap.parse_args(argv)
    try:
        if args.verify:
            faces = faces_from_profile(args.profile, args.fonts_json) if args.profile else None
            problems = verify_pptx(args.verify, faces=faces)
            print(json.dumps({"pptx": args.verify, "problems": problems}, ensure_ascii=False, indent=1))
            return 0 if not problems else 1
        if not (args.pptx_in and args.pptx_out):
            ap.error("IN.pptx and OUT.pptx are required")
        faces = faces_from_profile(args.profile, args.fonts_json) if args.profile else []
        for spec in args.face:
            parts = spec.rsplit(":", 2)
            if len(parts) != 3:
                ap.error(f"--face {spec!r}: expected TYPEFACE:SLOT:FILE")
            faces.append({"typeface": parts[0], "slot": parts[1], "file": parts[2]})
        if not faces:
            ap.error("no faces: give --profile and/or --face")
        embed_fonts(args.pptx_in, args.pptx_out, faces, allow_preview_print=args.allow_preview_print,
                    require_used=not args.allow_unused)
    except EmbedError as exc:
        print(f"embed_fonts: error: {exc}", file=sys.stderr)
        return 1
    print(f"wrote {args.pptx_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
