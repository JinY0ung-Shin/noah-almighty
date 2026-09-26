#!/usr/bin/env python3
"""Independent PowerPoint repair-risk checker — the `office-rules` gate of tools/deck.mjs (PoC fixer round 3, VO-06).

Adopted from the PoC's verify-office review lane (calibrated on 16 PowerPoint-saved / LibreOffice test decks,
60/60 single-defect negative controls), plus PKG-19 (every
r:embed / r:id / r:link names a relationship of the type its element needs, VR-07). It deliberately shares NO code with
the builder or the other gates.

Reads each .pptx with zipfile + lxml only (no python-pptx, no PoC code) and tests the Office-only rules that the
Open XML SDK schema validation does not model. Every check cites its source:

  OI  = [MS-OI29500] note number (learn.microsoft.com/openspecs/office_standards/ms-oi29500, copies in spec/oi-md/)
  E1  = ECMA-376 Part 1 (5th ed.) section, E2 = Part 2 (OPC)
  FLD = field report (issue tracker / other implementation), cited inline

Usage:  office_check.py DECK.pptx [...] [--json OUT.json] [--quiet] [--no-info] [--strict]
Severity: FAIL (Office rule violated / known repair trigger), WARN (deviation from what PowerPoint writes, or a
rule whose violation has a known non-repair consequence), INFO (fact worth recording), PASS (check ran, clean).
Exit 1 on any FAIL (--strict: any FAIL or WARN — the pipeline's setting: the deliverables carry no WARN).
"""
from __future__ import annotations

import collections
import io
import json
import math
import posixpath
import re
import struct
import sys
import zipfile
from dataclasses import dataclass, field

from lxml import etree

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "ep": "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "vt": "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "svg": "http://www.w3.org/2000/svg",
    "asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
    "adec": "http://schemas.microsoft.com/office/drawing/2017/decorative",
}
R_NS = NS["r"]
RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
RT_PKG = "http://schemas.openxmlformats.org/package/2006/relationships/"
CT_PML = "application/vnd.openxmlformats-officedocument.presentationml."

EXPECTED_CT = {
    RT + "officeDocument": {CT_PML + "presentation.main+xml", CT_PML + "slideshow.main+xml",
                            CT_PML + "template.main+xml",
                            "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml"},
    RT_PKG + "metadata/core-properties": {"application/vnd.openxmlformats-package.core-properties+xml"},
    RT + "extended-properties": {"application/vnd.openxmlformats-officedocument.extended-properties+xml"},
    RT_PKG + "metadata/thumbnail": {"image/jpeg", "image/png", "image/x-wmf", "image/x-emf"},
    RT + "slideMaster": {CT_PML + "slideMaster+xml"},
    RT + "slide": {CT_PML + "slide+xml"},
    RT + "slideLayout": {CT_PML + "slideLayout+xml"},
    RT + "notesMaster": {CT_PML + "notesMaster+xml"},
    RT + "notesSlide": {CT_PML + "notesSlide+xml"},
    RT + "handoutMaster": {CT_PML + "handoutMaster+xml"},
    RT + "theme": {"application/vnd.openxmlformats-officedocument.theme+xml"},
    RT + "presProps": {CT_PML + "presProps+xml"},
    RT + "viewProps": {CT_PML + "viewProps+xml"},
    RT + "tableStyles": {CT_PML + "tableStyles+xml"},
    RT + "chart": {"application/vnd.openxmlformats-officedocument.drawingml.chart+xml"},
    RT + "package": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    RT + "font": {"application/x-fontdata"},
    RT + "printerSettings": {"application/vnd.openxmlformats-officedocument.presentationml.printerSettings"},
    "http://schemas.microsoft.com/office/2011/relationships/chartStyle": {"application/vnd.ms-office.chartstyle+xml"},
    "http://schemas.microsoft.com/office/2011/relationships/chartColorStyle": {
        "application/vnd.ms-office.chartcolorstyle+xml"},
}
# PKG-19 (fixer round 3, VR-07): the relationship an r:* attribute names must be of the type its element consumes —
# a blip whose r:embed names a hyperlink relationship draws nothing (E1 §20.1.8.13 blip: "embed ... image part")
REL_TYPES_OF = {
    ("blip", "embed"): {"image"}, ("blip", "link"): {"image"}, ("svgBlip", "embed"): {"image"},
    ("svgBlip", "link"): {"image"}, ("chart", "id"): {"chart"}, ("externalData", "id"): {"package", "oleObject"},
    ("sldId", "id"): {"slide"}, ("sldMasterId", "id"): {"slideMaster"}, ("sldLayoutId", "id"): {"slideLayout"},
    ("notesMasterId", "id"): {"notesMaster"}, ("handoutMasterId", "id"): {"handoutMaster"},
    ("regular", "id"): {"font"}, ("bold", "id"): {"font"}, ("italic", "id"): {"font"}, ("boldItalic", "id"): {"font"},
    ("hlinkClick", "id"): {"hyperlink", "slide"}, ("hlinkHover", "id"): {"hyperlink", "slide"},
    ("userShapes", "id"): {"chartUserShapes"}, ("custData", "id"): {"customXml", "tags"}, ("tags", "id"): {"tags"},
}
# relationship type -> the r:* attribute must be referenced explicitly (Office: explicit only) [OI 2.1.18c, 2.1.22a/b]
EXPLICIT_ONLY = {RT + "font", RT + "slideLayout", RT + "slide", RT + "slideMaster", RT + "image", RT + "chart",
                 RT + "package"}
GUID_RE = re.compile(r"^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$")
LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$")
NCNAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.\-]*$")
MAX_ID = 2147483647                      # [OI 2.1.1321] ST_DrawingElementId is treated as signed int32
PH_NO_LINK = 0xFFFFFFFF
MASTER_PH_ALLOWED = {"title", "body", "dt", "ftr", "sldNum"}   # FLD: LibreOffice pptx-epptooxml.cxx (master, 2026):
# "A slide master takes only these; PowerPoint refuses to open a file whose master carries any other placeholder type"
GRAPHIC_URIS = {                         # [OI 2.1.1207b] Office's finite set of graphicData servers
    "http://schemas.openxmlformats.org/drawingml/2006/table",
    "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "http://schemas.openxmlformats.org/drawingml/2006/compatibility",
    "http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas",
    "http://schemas.openxmlformats.org/presentationml/2006/ole",
    "http://schemas.microsoft.com/office/drawing/2014/chartex",   # [MS-ODRAWXML] (Office 2016 charts)
}
BUILTIN_TABLE_STYLES = {                 # well-known built-in GUIDs used by generators (subset)
    "{2D5ABB26-0587-4C30-8999-92F81FD0307C}": "No Style, No Grid",
    "{5940675A-B579-460E-94D1-54222C63F5DA}": "No Style, Table Grid",
    "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}": "Medium Style 2 - Accent 1",
}
PT = 12700
EXT_URI_SVG = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"
EXT_URI_DECORATIVE = "{C183D7F6-B498-43B3-948B-1728B52AA6E4}"


def q(tag: str) -> str:
    p, l = tag.split(":")
    return f"{{{NS[p]}}}{l}"


def ln(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


@dataclass
class Finding:
    check: str
    severity: str
    part: str
    detail: str
    source: str = ""


@dataclass
class Rel:
    rid: str
    rtype: str
    target: str            # resolved absolute part name (internal) or raw (external)
    mode: str
    raw: str


@dataclass
class Pkg:
    path: str
    z: zipfile.ZipFile
    infos: list
    names: list
    parts: dict = field(default_factory=dict)        # "/ppt/x.xml" -> bytes
    ct_default: dict = field(default_factory=dict)   # ext(lower) -> ct
    ct_override: dict = field(default_factory=dict)  # partname(lower) -> (partname, ct)
    rels: dict = field(default_factory=dict)         # source part ("/" = package) -> [Rel]
    xml: dict = field(default_factory=dict)          # parsed XML parts


class Checker:
    def __init__(self, path: str):
        self.path = path
        self.findings: list[Finding] = []
        self.ran: collections.Counter = collections.Counter()
        self.facts: dict = {}

    # ------------------------------------------------------------------ reporting
    def add(self, check, severity, part, detail, source=""):
        self.findings.append(Finding(check, severity, part, detail, source))

    def ok(self, check):
        self.ran[check] += 1

    # ------------------------------------------------------------------ package loading
    def load(self) -> Pkg:
        z = zipfile.ZipFile(self.path)
        infos = z.infolist()
        names = [i.filename for i in infos]
        pkg = Pkg(self.path, z, infos, names)
        for i in infos:
            if i.filename.endswith("/"):
                continue
            pkg.parts["/" + i.filename] = z.read(i)
        ctx = pkg.parts.get("/[Content_Types].xml")
        if ctx is not None:
            t = etree.fromstring(ctx)
            for d in t.findall(q("ct:Default")):
                pkg.ct_default[d.get("Extension", "").lower()] = d.get("ContentType")
            for o in t.findall(q("ct:Override")):
                pkg.ct_override[o.get("PartName", "").lower()] = (o.get("PartName"), o.get("ContentType"))
        for name, data in pkg.parts.items():
            if name.endswith(".rels"):
                d, b = posixpath.split(name)
                if posixpath.basename(d) != "_rels":
                    continue
                src_dir = posixpath.dirname(d)
                src = posixpath.join(src_dir, b[: -len(".rels")]) if b != ".rels" else "/"
                rels = []
                t = etree.fromstring(data)
                for r in t.findall(q("pr:Relationship")):
                    mode = r.get("TargetMode") or "Internal"
                    raw = r.get("Target") or ""
                    if mode == "External":
                        tgt = raw
                    else:
                        base = src_dir if src != "/" else "/"
                        tgt = raw if raw.startswith("/") else posixpath.normpath(posixpath.join(base or "/", raw))
                        if not tgt.startswith("/"):
                            tgt = "/" + tgt
                    rels.append(Rel(r.get("Id") or "", r.get("Type") or "", tgt, mode, raw))
                pkg.rels[src] = rels
        for name, data in pkg.parts.items():
            if name.endswith((".xml", ".rels")):
                try:
                    pkg.xml[name] = etree.fromstring(data)
                except etree.XMLSyntaxError as e:
                    self.add("PKG-16", "FAIL", name, f"not well-formed XML: {e}", "E2 §8 (XML usage)")
        return pkg

    def ct_of(self, pkg: Pkg, part: str):
        o = pkg.ct_override.get(part.lower())
        if o:
            return o[1]
        ext = part.rsplit(".", 1)[-1].lower() if "." in posixpath.basename(part) else ""
        return pkg.ct_default.get(ext)

    def rels_of(self, pkg, part):
        return pkg.rels.get(part, [])

    def rel_by_id(self, pkg, part, rid):
        for r in self.rels_of(pkg, part):
            if r.rid == rid:
                return r
        return None

    # ------------------------------------------------------------------ PKG
    def check_zip(self, pkg: Pkg):
        names = pkg.names
        # PKG-01 duplicate entries
        dup = [n for n, c in collections.Counter(names).items() if c > 1]
        if dup:
            self.add("PKG-01", "FAIL", "zip", f"duplicate zip entries: {dup}", "FLD python-pptx #396 (repair)")
        self.ok("PKG-01")
        # PKG-02 case-insensitive collisions
        low = collections.Counter(n.lower() for n in names)
        coll = [n for n in names if low[n.lower()] > 1 and n not in dup]
        if coll:
            self.add("PKG-02", "FAIL", "zip", f"part names equal ignoring case: {coll}",
                     "E2 §6.3.5 part name equivalence is case-insensitive")
        self.ok("PKG-02")
        # PKG-03 [Content_Types].xml present + first
        if "[Content_Types].xml" not in names:
            self.add("PKG-03", "FAIL", "zip", "no [Content_Types].xml", "E2 §10.1")
        elif names[0] != "[Content_Types].xml":
            self.add("PKG-03", "WARN", "zip", f"first zip entry is {names[0]!r}, not [Content_Types].xml "
                     "(PowerPoint always writes it first)", "PowerPoint-saved samples; streaming readers")
        self.ok("PKG-03")
        # PKG-04/05 compression, flags, zip64, comment
        for i in pkg.infos:
            if i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                self.add("PKG-04", "FAIL", i.filename, f"compression method {i.compress_type}",
                         "OI 2.1.1751 (only STORE/DEFLATE)")
            if i.flag_bits & 0x1:
                self.add("PKG-05", "FAIL", i.filename, "encrypted entry", "E2 §7.3.? (no encryption)")
            if i.flag_bits & 0x8:
                self.add("PKG-05", "INFO", i.filename, "entry uses a data descriptor (bit 3)", "zip")
            if any(True for _ in _zip64_extra(i.extra)):
                self.add("PKG-05", "WARN", i.filename, "ZIP64 extra field present", "E2 §7.3.? ZIP64 only if needed")
        if pkg.z.comment:
            self.add("PKG-05", "INFO", "zip", f"zip comment {pkg.z.comment[:40]!r}", "zip")
        self.ok("PKG-04"); self.ok("PKG-05")
        # raw scan: local headers match central directory, no trailing garbage
        self._raw_zip_scan(pkg)
        # PKG-06 part names ASCII + OPC syntax
        for n in names:
            if any(ord(ch) > 127 for ch in n):
                self.add("PKG-06", "FAIL", n, "non-ASCII part name", "OI 2.1.1749: Office will not load the package")
            segs = n.rstrip("/").split("/")
            if any(s == "" or s.endswith(".") or s in (".", "..") for s in segs):
                self.add("PKG-06", "FAIL", n, "invalid OPC segment (empty / trailing dot)", "E2 §6.2.2.2")
            if "%" in n or "\\" in n:
                self.add("PKG-06", "WARN", n, "percent-encoded or backslash in part name", "E2 §6.2.2.2")
        self.ok("PKG-06")
        # PKG-07 directory entries
        dirs = [n for n in names if n.endswith("/")]
        if dirs:
            self.add("PKG-07", "WARN", "zip", f"directory entries {dirs}", "FLD PptxGenJS #1449 defect 6 (removed on repair)")
        self.ok("PKG-07")

    def _raw_zip_scan(self, pkg: Pkg):
        data = open(pkg.path, "rb").read()
        for i in pkg.infos:
            off = i.header_offset
            if data[off:off + 4] != b"PK\x03\x04":
                self.add("PKG-05", "FAIL", i.filename, "central directory offset does not point at a local header", "zip")
                continue
            nlen, xlen = struct.unpack("<HH", data[off + 26: off + 30])
            lname = data[off + 30: off + 30 + nlen]
            enc = "utf-8" if i.flag_bits & 0x800 else "cp437"
            if lname.decode(enc, "replace") != i.filename:
                self.add("PKG-05", "FAIL", i.filename, f"local header name {lname!r} != central name", "zip")
        # overlapping entries (two central records pointing at one local header)
        offs = collections.Counter(i.header_offset for i in pkg.infos)
        if any(c > 1 for c in offs.values()):
            self.add("PKG-05", "FAIL", "zip", "two central directory records share a local header", "zip")
        self.facts["zip_bytes"] = len(data)

    def check_content_types(self, pkg: Pkg):
        # PKG-08 every part has a content type
        for name in pkg.parts:
            if name == "/[Content_Types].xml":
                continue
            ct = self.ct_of(pkg, name)
            if not ct:
                self.add("PKG-08", "FAIL", name, "no content type (no Override, no Default for its extension)",
                         "E2 §10.1.2.4; FLD pandoc #11492 (missing fntdata type -> repair prompt)")
        self.ok("PKG-08")
        # PKG-09 Override for a part that does not exist
        existing = {n.lower() for n in pkg.parts}
        for low, (pn, ct) in pkg.ct_override.items():
            if low not in existing:
                self.add("PKG-09", "FAIL", pn, f"Override for a missing part ({ct})",
                         "FLD PptxGenJS #1449 defect 3 (phantom Overrides -> repair)")
        self.ok("PKG-09")
        # PKG-10 Default for an unused extension
        used = collections.Counter(n.rsplit(".", 1)[-1].lower() for n in pkg.parts if "." in posixpath.basename(n))
        for ext in pkg.ct_default:
            if not used.get(ext):
                self.add("PKG-10", "WARN", "[Content_Types].xml", f"Default for unused extension {ext!r}",
                         "FLD PptxGenJS #1449 defect 4 (low: dropped on repair)")
        self.ok("PKG-10")
        # PKG-15 no MCE in docProps parts
        for name in ("/docProps/core.xml", "/docProps/app.xml", "/docProps/custom.xml"):
            t = pkg.xml.get(name)
            if t is None:
                continue
            s = pkg.parts[name].decode("utf-8", "replace")
            if NS["mc"] in s:
                self.add("PKG-15", "FAIL", name, "markup-compatibility namespace in a document property part",
                         "OI 2.1.1753")
        self.ok("PKG-15")
        # PKG-16 no DTD in XML parts (incl. SVG image parts)
        for name, data in pkg.parts.items():
            if name.endswith((".xml", ".rels", ".svg")) and b"<!DOCTYPE" in data[:4096]:
                self.add("PKG-16", "FAIL", name, "DOCTYPE declaration", "E2 §8.1.4 (DTD forbidden)")
        self.ok("PKG-16")

    def check_rels(self, pkg: Pkg):
        existing = set(pkg.parts)
        existing_low = {p.lower(): p for p in pkg.parts}
        for src, rels in pkg.rels.items():
            relpart = "/_rels/.rels" if src == "/" else posixpath.join(posixpath.dirname(src), "_rels",
                                                                       posixpath.basename(src) + ".rels")
            # PKG-12 orphan .rels
            if src != "/" and src not in existing:
                self.add("PKG-12", "FAIL", relpart, f"relationships part for missing source part {src}", "E2 §9.3")
            ids = collections.Counter(r.rid for r in rels)
            for rid, c in ids.items():
                if c > 1:
                    self.add("PKG-13", "FAIL", relpart, f"duplicate relationship Id {rid}", "E2 §9.3.2.2 (Id unique)")
                if not NCNAME_RE.match(rid):
                    self.add("PKG-13", "FAIL", relpart, f"relationship Id {rid!r} is not an xsd:ID", "E2 §9.3.2.2")
            pairs = collections.Counter((r.rtype, r.target) for r in rels if r.mode == "Internal")
            for (t, tg), c in pairs.items():
                if c > 1 and not t.endswith("/image"):
                    self.add("PKG-13", "WARN", relpart, f"{c} relationships of type {t.rsplit('/', 1)[-1]} to {tg}",
                             "duplicate relationship to one part")
            for r in rels:
                if r.mode == "External":
                    if r.rtype in EXPECTED_CT and r.rtype not in (RT + "hyperlink",):
                        self.add("PKG-13", "WARN", relpart, f"{r.rid}: external {r.rtype}", "E2")
                    continue
                if r.target not in existing:
                    alt = existing_low.get(r.target.lower())
                    self.add("PKG-13", "FAIL", relpart, f"{r.rid} -> {r.target} does not exist"
                             + (f" (case differs: {alt})" if alt else ""), "E2 §9.3 (dangling relationship)")
                    continue
                exp = EXPECTED_CT.get(r.rtype)
                ct = self.ct_of(pkg, r.target)
                if exp and ct not in exp:
                    self.add("PKG-11", "FAIL", r.target, f"content type {ct!r} for a {r.rtype.rsplit('/', 1)[-1]} "
                             f"relationship (expected {sorted(exp)})", "E1 §13/§15 part definitions")
                if r.rtype == RT + "image" and not (ct or "").startswith("image/"):
                    self.add("PKG-11", "FAIL", r.target, f"image relationship to {ct!r}", "E1 §15.2.14")
        self.ok("PKG-11"); self.ok("PKG-12"); self.ok("PKG-13")
        # PKG-14 reachability from the package root
        seen, todo = set(), ["/"]
        while todo:
            s = todo.pop()
            for r in pkg.rels.get(s, []):
                if r.mode == "Internal" and r.target in pkg.parts and r.target not in seen:
                    seen.add(r.target)
                    todo.append(r.target)
        for p in pkg.parts:
            if p.endswith(".rels") or p == "/[Content_Types].xml":
                continue
            if p not in seen:
                self.add("PKG-14", "WARN", p, "part not reachable from the package relationships (orphan)",
                         "E2 §8.3; Office drops unreferenced parts")
        self.ok("PKG-14")
        # PKG-17 thumbnail only from the package root; [OI 2.1.18d, 2.1.20a, 2.1.21a, 2.1.22c]
        for src, rels in pkg.rels.items():
            for r in rels:
                if r.rtype == RT_PKG + "metadata/thumbnail" and src != "/":
                    self.add("PKG-17", "FAIL", src, "thumbnail relationship from a non-root part",
                             "OI 2.1.18d/2.1.20a/2.1.21a/2.1.22c")
                if src == "/ppt/presentation.xml" and r.rtype == RT + "slideLayout":
                    self.add("PKG-17", "FAIL", src, "presentation part relates to a slide layout", "OI 2.1.18b")
        self.ok("PKG-17")
        # PKG-18 every r:* attribute resolves; every explicit-only rel is referenced
        for part, t in pkg.xml.items():
            if part.endswith(".rels") or part == "/[Content_Types].xml":
                continue
            referenced = set()
            for e in t.iter():
                if not isinstance(e.tag, str):
                    continue
                for k, v in e.attrib.items():
                    if k.startswith("{" + R_NS + "}"):
                        referenced.add(v)
                        rel = self.rel_by_id(pkg, part, v)
                        if rel is None:
                            self.add("PKG-18", "FAIL", part, f"{ln(e)}@r:{k.split('}')[1]}={v} has no relationship",
                                     "E2 §9.3 (explicit relationship must exist)")
                            continue
                        want = REL_TYPES_OF.get((ln(e), k.split("}")[1]))
                        got = rel.rtype.rsplit("/", 1)[-1]
                        if want and got not in want:
                            self.add("PKG-19", "FAIL", part, f"{ln(e)}@r:{k.split('}')[1]}={v} names a {got!r} "
                                     f"relationship (expected {sorted(want)})",
                                     "E1 part relationships (e.g. §20.1.8.13 blip -> image part)")
            src_kind = ("presentation" if part == self.facts.get("presentation") or part.endswith("/presentation.xml")
                        else "master" if "/slideMasters/" in part else "other")
            for r in self.rels_of(pkg, part):
                need = (r.rtype in (RT + "image", RT + "chart", RT + "package")
                        or (src_kind == "presentation" and r.rtype in (RT + "font", RT + "slide", RT + "slideMaster",
                                                                       RT + "notesMaster", RT + "handoutMaster"))
                        or (src_kind == "master" and r.rtype == RT + "slideLayout"))
                if need and r.rid not in referenced:
                    self.add("PKG-18", "WARN", part, f"relationship {r.rid} ({r.rtype.rsplit('/', 1)[-1]} -> {r.target}) "
                             "is never referenced from the part's XML", "OI 2.1.18c / 2.1.22a (explicit only)")
        self.ok("PKG-18"); self.ok("PKG-19")

    # ------------------------------------------------------------------ presentation
    def rel_targets(self, pkg, part, rtype):
        return [r for r in self.rels_of(pkg, part) if r.rtype == rtype and r.mode == "Internal"]

    def check_presentation(self, pkg: Pkg):
        root_docs = self.rel_targets(pkg, "/", RT + "officeDocument")
        if len(root_docs) != 1:
            self.add("PRS-01", "FAIL", "/_rels/.rels", f"{len(root_docs)} officeDocument relationships", "E2/E1 §13")
            return None
        pres = root_docs[0].target
        t = pkg.xml.get(pres)
        self.ok("PRS-01")
        self.facts["presentation"] = pres
        # masters
        mids = []
        for m in t.findall(f"{q('p:sldMasterIdLst')}/{q('p:sldMasterId')}"):
            mid = int(m.get("id", "0"))
            rid = m.get(f"{{{R_NS}}}id")
            r = self.rel_by_id(pkg, pres, rid)
            if r is None or r.rtype != RT + "slideMaster":
                self.add("PRS-02", "FAIL", pres, f"sldMasterId r:id={rid} is not a slideMaster relationship", "E1 §19.2.1.36")
            if mid < 2147483648:
                self.add("PRS-02", "FAIL", pres, f"sldMasterId id {mid} < 2147483648", "E1 §19.7.16")
            mids.append((mid, r.target if r else None))
        self.ok("PRS-02")
        listed_masters = {m for _, m in mids}
        for r in self.rel_targets(pkg, pres, RT + "slideMaster"):
            if r.target not in listed_masters:
                self.add("PRS-02", "FAIL", pres, f"slideMaster relationship {r.rid} not in sldMasterIdLst", "E1 §19.2.1.37")
        # slides
        sids, slides = [], []
        for s in t.findall(f"{q('p:sldIdLst')}/{q('p:sldId')}"):
            sid = int(s.get("id", "0"))
            rid = s.get(f"{{{R_NS}}}id")
            r = self.rel_by_id(pkg, pres, rid)
            if r is None or r.rtype != RT + "slide":
                self.add("PRS-03", "FAIL", pres, f"sldId r:id={rid} is not a slide relationship", "E1 §19.2.1.34")
                continue
            if not (256 <= sid < 2147483648):
                self.add("PRS-03", "FAIL", pres, f"sldId id {sid} outside 256..2147483647", "E1 §19.7.13")
            sids.append(sid)
            slides.append(r.target)
        if len(set(sids)) != len(sids):
            self.add("PRS-03", "FAIL", pres, f"duplicate sldId ids {sids}", "E1 §19.2.1.34")
        if len(set(slides)) != len(slides):
            self.add("PRS-03", "FAIL", pres, "one slide part listed twice in sldIdLst", "E1 §19.2.1.34")
        for r in self.rel_targets(pkg, pres, RT + "slide"):
            if r.target not in slides:
                self.add("PRS-03", "FAIL", pres, f"slide relationship {r.rid} ({r.target}) not in sldIdLst",
                         "E1 §19.2.1.35 (unlisted slide)")
        self.ok("PRS-03")
        # layout + master id space
        all_ids = [m for m, _ in mids]
        for _, mpart in mids:
            mt = pkg.xml.get(mpart) if mpart else None
            if mt is None:
                continue
            for li in mt.findall(f"{q('p:sldLayoutIdLst')}/{q('p:sldLayoutId')}"):
                lid = int(li.get("id", "0"))
                if lid < 2147483648:
                    self.add("PRS-04", "FAIL", mpart, f"sldLayoutId id {lid} < 2147483648", "E1 §19.7.14")
                all_ids.append(lid)
        dup = [i for i, c in collections.Counter(all_ids).items() if c > 1]
        if dup:
            self.add("PRS-04", "FAIL", pres, f"master/layout ids not unique across the presentation: {dup}",
                     "E1 §19.2.1.36 / §19.3.1.40 (unique within the presentation)")
        self.ok("PRS-04")
        self.facts["master_layout_ids"] = sorted(all_ids)
        # notes / handout masters
        nm_list = t.findall(f"{q('p:notesMasterIdLst')}/{q('p:notesMasterId')}")
        nm_parts = [p for p in pkg.parts if re.match(r"^/ppt/notesMasters/notesMaster\d+\.xml$", p)]
        notes = [p for p in pkg.parts if re.match(r"^/ppt/notesSlides/notesSlide\d+\.xml$", p)]
        if notes and not nm_list:
            self.add("PRS-05", "FAIL", pres, "notes slides without a notesMasterIdLst", "E1 §13.3.5")
        if len(nm_list) > 1:
            self.add("PRS-05", "FAIL", pres, "more than one notes master", "E1 §19.2.1.21")
        for nm in nm_list:
            r = self.rel_by_id(pkg, pres, nm.get(f"{{{R_NS}}}id"))
            if r is None or r.rtype != RT + "notesMaster":
                self.add("PRS-05", "FAIL", pres, "notesMasterId does not resolve", "E1 §19.2.1.20")
            else:
                th = self.rel_targets(pkg, r.target, RT + "theme")
                sm_themes = {x.target for m in listed_masters if m for x in self.rel_targets(pkg, m, RT + "theme")}
                if th and th[0].target in sm_themes:
                    self.add("PRS-05", "FAIL", r.target, "notes master shares the slide master's theme part",
                             "FLD PptxGenJS #1449 defect 5 (notes master stripped on repair)")
        self.facts["notes_master"] = len(nm_list)
        self.facts["notes_slides"] = len(notes)
        self.facts["handout_master"] = len(t.findall(f"{q('p:handoutMasterIdLst')}/{q('p:handoutMasterId')}"))
        if nm_parts and not nm_list:
            self.add("PRS-05", "WARN", pres, f"notes master part(s) {nm_parts} not listed", "E1 §19.2.1.21")
        self.ok("PRS-05")
        fsn = t.get("firstSlideNum")
        if fsn is not None and not (0 <= int(fsn) <= 9999):
            self.add("PRS-06", "FAIL", pres, f"firstSlideNum {fsn}", "OI 2.1.1108a (0..9999)")
        # slide size
        sz = t.find(q("p:sldSz"))
        if sz is not None:
            cx, cy = int(sz.get("cx")), int(sz.get("cy"))
            for v in (cx, cy):
                if not (914400 <= v <= 51206400):
                    self.add("PRS-06", "FAIL", pres, f"sldSz {cx}x{cy} outside 914400..51206400", "E1 §19.7.17")
            self.facts["sldSz"] = (cx, cy)
        else:
            self.add("PRS-06", "WARN", pres, "no sldSz (PowerPoint assumes 9144000x6858000)", "OI 2.1.1110d")
        if t.find(q("p:notesSz")) is None:
            self.add("PRS-06", "FAIL", pres, "no notesSz (required)", "E1 §19.2.1.26 schema")
        self.ok("PRS-06")
        # PRS-07 embedded fonts
        self.check_embedded_fonts(pkg, pres, t)
        # PRS-09 standard parts
        for rt in ("presProps", "viewProps", "theme", "tableStyles"):
            if not self.rel_targets(pkg, pres, RT + rt):
                self.add("PRS-09", "WARN", pres, f"no {rt} part (PowerPoint always writes one)", "PowerPoint-saved samples")
        self.ok("PRS-09")
        return pres, [m for _, m in mids if m], slides

    # ------------------------------------------------------------------ embedded fonts
    def check_embedded_fonts(self, pkg, pres, t):
        lst = t.find(q("p:embeddedFontLst"))
        font_parts = {p for p in pkg.parts if self.ct_of(pkg, p) == "application/x-fontdata"}
        referenced = set()
        if lst is None:
            if font_parts:
                self.add("PRS-07", "FAIL", pres, f"font parts {sorted(font_parts)} without embeddedFontLst", "OI 2.1.18c")
            self.ok("PRS-07")
            return
        if t.get("embedTrueTypeFonts") not in ("1", "true"):
            self.add("PRS-07", "WARN", pres, "embeddedFontLst without embedTrueTypeFonts=1 (every PowerPoint sample "
                     "with embedded fonts sets it)", "font-embedding.md §1.1 [PPT-sample]")
        typefaces = []
        used = self.used_typefaces(pkg)
        self.facts["used_typefaces"] = sorted(used)
        for ef in lst.findall(q("p:embeddedFont")):
            f = ef.find(q("p:font"))
            tf = f.get("typeface") if f is not None else None
            typefaces.append(tf)
            if tf not in used:
                self.add("PRS-07", "FAIL", pres, f"embedded typeface {tf!r} is not used in the presentation",
                         "OI 2.1.1100b (PowerPoint requires every listed font to be used)")
            for slot in ("regular", "bold", "italic", "boldItalic"):
                s = ef.find(q("p:" + slot))
                if s is None:
                    continue
                rid = s.get(f"{{{R_NS}}}id")
                r = self.rel_by_id(pkg, pres, rid)
                if r is None or r.rtype != RT + "font":
                    self.add("PRS-07", "FAIL", pres, f"{tf}/{slot} r:id={rid} is not a font relationship", "OI 2.1.18c")
                    continue
                referenced.add(r.target)
                self.check_eot(pkg, r.target, tf, slot)
        low = collections.Counter(x.lower() for x in typefaces if x)
        for k, c in low.items():
            if c > 1:
                self.add("PRS-07", "FAIL", pres, f"typeface {k!r} listed {c} times", "OI 2.1.1100a (unique typeface)")
        for fp in font_parts - referenced:
            self.add("PRS-07", "FAIL", fp, "font part not referenced by any embeddedFont slot", "OI 2.1.18c (explicit only)")
        self.facts["embedded_typefaces"] = typefaces
        self.ok("PRS-07")

    def used_typefaces(self, pkg) -> set:
        used = set()
        for part, t in pkg.xml.items():
            if not re.match(r"^/ppt/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|theme|charts)/", part) \
                    and part != self.facts.get("presentation"):
                continue
            for e in t.iter():
                if isinstance(e.tag, str) and e.get("typeface") and ln(e) in ("latin", "ea", "cs", "sym", "font", "buFont"):
                    if ln(e) == "font" and etree.QName(e).namespace == NS["p"]:
                        continue                         # the embeddedFontLst entry itself
                    tf = e.get("typeface")
                    if not tf.startswith("+"):
                        used.add(tf)
        return used

    def check_eot(self, pkg, part, typeface, slot):
        data = pkg.parts.get(part)
        if data is None:
            return
        f = self.facts.setdefault("fonts", {})
        try:
            (eot_size, fd_size, version, flags) = struct.unpack_from("<IIII", data, 0)
            panose = data[16:26]
            charset, italic = data[26], data[27]
            weight, = struct.unpack_from("<I", data, 28)
            fstype, magic = struct.unpack_from("<HH", data, 32)
        except struct.error:
            self.add("FNT-01", "FAIL", part, "shorter than an EOT header", "W3C EOT")
            return
        info = {"typeface": typeface, "slot": slot, "EOTSize": eot_size, "len": len(data), "FontDataSize": fd_size,
                "Version": hex(version), "Flags": hex(flags), "Weight": weight, "Italic": italic,
                "Charset": charset, "fsType": hex(fstype)}
        if eot_size != len(data):
            self.add("FNT-01", "FAIL", part, f"EOTSize {eot_size} != part length {len(data)}", "W3C EOT §2")
        if magic != 0x504C:
            self.add("FNT-01", "FAIL", part, f"MagicNumber {magic:#x} != 0x504C", "W3C EOT §2")
        if version not in (0x00010000, 0x00020001, 0x00020002):
            self.add("FNT-01", "FAIL", part, f"unknown EOT version {version:#x}", "W3C EOT")
        # names
        off = 36 + 16 + 8 + 4 + 16          # UnicodeRange(16) CodePageRange(8) CheckSumAdjustment(4) Reserved(16)
        names = []
        try:
            for k in range(4):
                pad, = struct.unpack_from("<H", data, off); off += 2
                n, = struct.unpack_from("<H", data, off); off += 2
                names.append(data[off: off + n].decode("utf-16-le", "replace")); off += n
            if version >= 0x00020001:
                pad, n = struct.unpack_from("<HH", data, off); off += 4 + n
            if version >= 0x00020002:
                off += 4 + 4                       # RootStringCheckSum, EUDCCodePage
                pad, n = struct.unpack_from("<HH", data, off); off += 4 + n    # Padding6 + SignatureSize + Signature
                off += 4                           # EUDCFlags
                n, = struct.unpack_from("<I", data, off); off += 4 + n        # EUDCFontSize + data
        except struct.error:
            self.add("FNT-01", "FAIL", part, "truncated EOT name table", "W3C EOT")
            return
        info.update({"FamilyName": names[0], "StyleName": names[1], "FullName": names[3], "header_end": off})
        if off + fd_size != len(data):
            self.add("FNT-01", "FAIL", part, f"header end {off} + FontDataSize {fd_size} != {len(data)}", "W3C EOT")
        if names[0].rstrip("\x00") != typeface:
            self.add("FNT-01", "WARN", part, f"EOT FamilyName {names[0]!r} != embeddedFont typeface {typeface!r}",
                     "font-embedding.md (FamilyName = XML typeface)")
        font = data[len(data) - fd_size:]
        if flags & 0x4:
            info["compressed"] = "MTX"
        elif flags & 0x10000000:
            info["xor"] = True
        else:
            try:
                from fontTools.ttLib import TTFont
                tt = TTFont(io.BytesIO(font), lazy=True)
                nm = tt["name"]
                fam = nm.getDebugName(1)
                sub = nm.getDebugName(2)
                os2 = tt["OS/2"]
                info.update({"ttf_family": fam, "ttf_subfamily": sub, "ttf_fsType": hex(os2.fsType),
                             "usWeightClass": os2.usWeightClass, "fsSelection": hex(os2.fsSelection),
                             "macStyle": hex(tt["head"].macStyle), "glyf": "glyf" in tt, "fvar": "fvar" in tt})
                if fam != typeface:
                    self.add("FNT-02", "FAIL", part, f"TTF name ID 1 {fam!r} != typeface {typeface!r}",
                             "OI 2.1.1397d (PowerPoint uses the typeface to find the font)")
                bold = bool(os2.fsSelection & 0x20) or bool(tt["head"].macStyle & 1)
                ital = bool(os2.fsSelection & 0x1) or bool(tt["head"].macStyle & 2)
                want_b, want_i = slot in ("bold", "boldItalic"), slot in ("italic", "boldItalic")
                if (bold, ital) != (want_b, want_i):
                    self.add("FNT-02", "FAIL", part, f"slot {slot} but the font is bold={bold} italic={ital} "
                             f"({sub})", "E1 §19.2.1.? embeddedFont slot semantics")
                if os2.fsType & 0x0002 and not os2.fsType & 0x000C or os2.fsType & 0x0200:
                    self.add("FNT-02", "FAIL", part, f"fsType {os2.fsType:#x} forbids embedding", "OpenType OS/2")
                elif os2.fsType & 0x0004 and not os2.fsType & 0x0008:
                    self.add("FNT-02", "WARN", part, "Preview&Print embedding: PowerPoint opens the deck read-only",
                             "Microsoft support: embedded fonts")
                if os2.fsType != fstype:
                    self.add("FNT-01", "WARN", part, f"EOT fsType {fstype:#x} != OS/2 fsType {os2.fsType:#x}", "W3C EOT")
                if "glyf" not in tt or "fvar" in tt:
                    self.add("FNT-02", "WARN", part, "not a static TrueType-outline font", "font-embedding.md §0")
            except Exception as e:  # noqa: BLE001
                self.add("FNT-01", "FAIL", part, f"embedded font data does not parse: {e}", "W3C EOT")
        f[part] = info
        self.ok("FNT-01"); self.ok("FNT-02")

    # ------------------------------------------------------------------ masters / layouts / slides
    @staticmethod
    def placeholders(tree):
        out = []
        for sp in tree.iter(q("p:sp"), q("p:pic"), q("p:graphicFrame"), q("p:grpSp"), q("p:cxnSp")):
            nv = next((c for c in sp if ln(c).startswith("nv")), None)
            if nv is None:
                continue
            ph = nv.find(f"{q('p:nvPr')}/{q('p:ph')}")
            if ph is None:
                continue
            cnv = nv.find(q("p:cNvPr"))
            out.append({"node": sp, "type": ph.get("type", "obj"), "idx": int(ph.get("idx", "0")),
                        "orient": ph.get("orient", "horz"), "sz": ph.get("sz", "full"),
                        "hasCustomPrompt": ph.get("hasCustomPrompt"), "explicit_idx": ph.get("idx") is not None,
                        "id": cnv.get("id") if cnv is not None else None,
                        "name": cnv.get("name") if cnv is not None else None,
                        "in_group": sp.getparent().tag == q("p:grpSp"), "tag": ln(sp)})
        return out

    def check_ph_unique(self, part, phs, kind):
        cnt = collections.defaultdict(list)
        for p in phs:
            if kind != "slide" and p["idx"] == PH_NO_LINK:
                self.add("PH-01", "FAIL", part, f"placeholder {p['name']!r} idx 0xFFFFFFFF on a {kind}", "OI 2.1.1127a")
            if kind == "slide" and p["idx"] == PH_NO_LINK:
                continue
            cnt[p["idx"]].append(p)
        for idx, lst in cnt.items():
            if len(lst) > 1:
                desc = ", ".join(f"{p['type']}(id {p['id']}, idx {'explicit' if p['explicit_idx'] else 'default'} "
                                 f"{idx})" for p in lst)
                self.add("PH-01", "FAIL", part, f"{len(lst)} placeholders share idx {idx} on a {kind}: {desc}",
                         "OI 2.1.1127a: 'For any two placeholders on a ... Slide Layout ... the values must not be the "
                         "same' / 'For any two placeholders on a Slide ... the values shall not be the same'")
        self.ok("PH-01")

    def check_master(self, pkg, mpart):
        t = pkg.xml[mpart]
        phs = self.placeholders(t)
        for p in phs:
            if p["type"] not in MASTER_PH_ALLOWED:
                self.add("MST-01", "FAIL", mpart, f"placeholder type {p['type']!r} on the slide master",
                         "FLD LibreOffice pptx-epptooxml.cxx: PowerPoint refuses to open such a file")
        self.ok("MST-01")
        self.check_ph_unique(mpart, phs, "master")
        lst = t.findall(f"{q('p:sldLayoutIdLst')}/{q('p:sldLayoutId')}")
        listed = []
        for li in lst:
            r = self.rel_by_id(pkg, mpart, li.get(f"{{{R_NS}}}id"))
            if r is None or r.rtype != RT + "slideLayout":
                self.add("MST-03", "FAIL", mpart, f"sldLayoutId r:id={li.get(f'{{{R_NS}}}id')} not a slideLayout rel",
                         "E1 §19.3.1.40")
            else:
                listed.append(r.target)
        for r in self.rel_targets(pkg, mpart, RT + "slideLayout"):
            if listed.count(r.target) != 1:
                self.add("MST-03", "FAIL", mpart, f"layout {r.target} listed {listed.count(r.target)} times in "
                         "sldLayoutIdLst", "OI 2.1.22a/b (explicit relationship only)")
        for lay in listed:
            back = self.rel_targets(pkg, lay, RT + "slideMaster")
            if len(back) != 1 or back[0].target != mpart:
                self.add("MST-05", "FAIL", lay, f"layout does not relate back to its master {mpart}", "E1 §13.3.9")
        self.ok("MST-03"); self.ok("MST-05")
        cm = t.find(q("p:clrMap"))
        need = {"bg1", "tx1", "bg2", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
                "hlink", "folHlink"}
        if cm is None or not need <= set(cm.attrib):
            self.add("MST-04", "FAIL", mpart, "clrMap missing or incomplete", "E1 §19.3.1.6")
        if not self.rel_targets(pkg, mpart, RT + "theme"):
            self.add("MST-04", "FAIL", mpart, "slide master without a theme", "E1 §13.3.10")
        if t.find(q("p:txStyles")) is None:
            self.add("MST-04", "WARN", mpart, "no txStyles", "E1 §19.3.1.52")
        self.ok("MST-04")
        return listed, phs

    def check_layout(self, pkg, lpart, master_phs):
        t = pkg.xml[lpart]
        phs = self.placeholders(t)
        self.check_ph_unique(lpart, phs, "slide layout")
        name = t.find(q("p:cSld")).get("name")
        typ = t.get("type", "cust")
        # layout -> master inheritance (by type category)
        mtypes = {p["type"] for p in master_phs}
        for p in phs:
            cat = {"ctrTitle": "title", "title": "title", "dt": "dt", "ftr": "ftr", "sldNum": "sldNum"}.get(p["type"], "body")
            if cat not in mtypes:
                self.add("LAY-03", "INFO", lpart, f"placeholder {p['type']} has no master placeholder of category {cat}",
                         "E1 §19.3.1.36 inheritance")
            if p["in_group"]:
                self.add("LAY-04", "WARN", lpart, f"placeholder {p['name']!r} inside a group", "PowerPoint cannot group placeholders")
        self.ok("LAY-03"); self.ok("LAY-04")
        return {"name": name, "type": typ, "phs": phs}

    def check_slide(self, pkg, spart, layouts_info, slide_no):
        t = pkg.xml[spart]
        lrels = self.rel_targets(pkg, spart, RT + "slideLayout")
        if len(lrels) != 1:
            self.add("SLD-01", "FAIL", spart, f"{len(lrels)} slideLayout relationships", "E1 §13.3.8")
            return
        lay = lrels[0].target
        if lay not in layouts_info:
            self.add("SLD-01", "FAIL", spart, f"layout {lay} not listed by any master", "E1 §19.3.1.41")
            return
        self.ok("SLD-01")
        phs = self.placeholders(t)
        self.check_ph_unique(spart, phs, "slide")
        lphs = layouts_info[lay]["phs"]
        for p in phs:
            if p["in_group"]:
                self.add("SLD-02", "WARN", spart, f"placeholder {p['name']!r} inside a group", "PowerPoint cannot group placeholders")
            if p["idx"] == PH_NO_LINK:
                continue
            cands = [lp for lp in lphs if lp["idx"] == p["idx"]]
            same = [lp for lp in cands if lp["type"] == p["type"] and lp["orient"] == p["orient"] and lp["sz"] == p["sz"]]
            if not same:
                self.add("SLD-02", "FAIL", spart, f"placeholder {p['type']} idx {p['idx']} has no layout placeholder "
                         "with the same attribute values", "OI 2.1.1127a (4th restriction)")
            if len(cands) > 1:
                first = cands[0]
                self.add("SLD-03", "WARN", spart,
                         f"placeholder {p['type']} (id {p['id']}) inherits by idx {p['idx']} [OI 2.1.1127b] but the "
                         f"layout has {len(cands)} placeholders with that idx: "
                         + ", ".join(f"{c['type']}(id {c['id']})" for c in cands)
                         + f" — the first in document order is {first['type']}",
                         "OI 2.1.1127b (inherit by idx); MS Q&A 5064288 (duplicate idx: content placed randomly "
                         "when a layout is applied)")
            elif cands and cands[0]["type"] != p["type"]:
                self.add("SLD-03", "WARN", spart, f"placeholder {p['type']} idx {p['idx']} inherits from layout "
                         f"placeholder of type {cands[0]['type']}", "OI 2.1.1127b")
        self.ok("SLD-02"); self.ok("SLD-03")
        # slide number fields: cached text
        for fld in t.iter(q("a:fld")):
            if fld.get("type") == "slidenum":
                tx = fld.find(q("a:t"))
                if tx is not None and tx.text != str(slide_no):
                    self.add("TXT-03", "INFO", spart, f"slidenum field cached text {tx.text!r} on slide {slide_no}",
                             "PowerPoint writes the slide's number on slides")
        # hidden / showMasterSp
        if t.get("show") == "0":
            self.add("SLD-04", "INFO", spart, "slide is hidden", "E1 §19.3.1.38")
        if t.get("showMasterSp") == "0":
            self.add("SLD-04", "INFO", spart, "showMasterSp=0 (layout chrome hidden)", "E1 §19.3.1.38")
        self.ok("SLD-04")

    # ------------------------------------------------------------------ drawing trees (slides, layouts, masters)
    def check_generic(self, pkg):
        """Rules that apply to every XML part: extension uri [OI 2.1.1101/2.1.1206], ph placement [OI 2.1.1126b]."""
        for part, t in pkg.xml.items():
            for ext in t.iter():
                if not isinstance(ext.tag, str) or ln(ext) != "ext" or ln(ext.getparent()) != "extLst":
                    continue
                uri = ext.get("uri")
                if not uri:
                    self.add("EXT-01", "FAIL", part, f"{ext.getparent().getparent().tag.split('}')[-1]}/extLst/ext without uri",
                             "OI 2.1.1101 / 2.1.1206 (Office requires the uri attribute)")
                elif not GUID_RE.match(uri.upper()):
                    self.add("EXT-01", "INFO", part, f"extension uri {uri!r} is not a GUID", "")
            for ph in t.iter(q("p:ph")):
                nvpr = ph.getparent()
                owner = nvpr.getparent() if nvpr is not None else None
                if owner is not None and ln(owner) in ("nvGrpSpPr", "nvCxnSpPr"):
                    self.add("PH-02", "FAIL", part, f"p:ph under {ln(owner)}", "OI 2.1.1126b (PowerPoint does not allow)")
            for lk in t.iter(q("a:graphicFrameLocks"), q("a:spLocks"), q("a:picLocks"), q("a:cxnSpLocks")):
                if lk.get("noGrp") in ("1", "true"):
                    obj = lk.getparent().getparent().getparent()
                    if obj is not None and obj.getparent() is not None and obj.getparent().tag == q("p:grpSp"):
                        cnv = obj.find(f"./*/{q('p:cNvPr')}")
                        self.add("GRP-05", "WARN", part, f"{ln(obj)} {cnv.get('name') if cnv is not None else '?'!r} carries "
                                 f"{ln(lk)} noGrp=1 but sits inside a group",
                                 "E1 §20.1.2.2.19 noGrp ('cannot be combined within other shapes to form a group'); "
                                 "PowerPoint writes chart frames without noGrp")
            if re.match(r"^/ppt/(slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters)/", part):
                for sp in t.iter(q("p:sp")):
                    is_ph = sp.find(f"{q('p:nvSpPr')}/{q('p:nvPr')}/{q('p:ph')}") is not None
                    if sp.find(q("p:txBody")) is None and not is_ph:   # PowerPoint writes empty placeholders without one
                        cnv = sp.find(f"{q('p:nvSpPr')}/{q('p:cNvPr')}")
                        self.add("SHP-01", "WARN", part, f"p:sp {cnv.get('name') if cnv is not None else '?'!r} without p:txBody",
                                 "FLD PptxGenJS #1441 (PowerPoint M365 repairs by adding txBody)")
                for bg in t.iter(q("p:bgPr")):
                    if not any(ln(c) in ("effectLst", "effectDag") for c in bg):
                        self.add("BG-01", "WARN", part, "p:bgPr without a:effectLst",
                                 "FLD PptxGenJS #1442 (PowerPoint M365 repair adds <a:effectLst/>)")
        self.ok("EXT-01"); self.ok("PH-02"); self.ok("GRP-05"); self.ok("SHP-01"); self.ok("BG-01")

    def check_tree(self, pkg, part):
        t = pkg.xml[part]
        cnv = [e for e in t.iter(q("p:cNvPr"))]
        ids = []
        for c in cnv:
            try:
                i = int(c.get("id"))
            except (TypeError, ValueError):
                self.add("ID-01", "FAIL", part, f"cNvPr id {c.get('id')!r} not an integer", "E1 §20.1.10.21")
                continue
            if not (1 <= i <= MAX_ID):
                self.add("ID-01", "FAIL", part, f"cNvPr id {i} outside 1..2147483647", "OI 2.1.1321 (signed int32)")
            ids.append(i)
            nm = c.get("name")
            if nm is None:
                self.add("ID-02", "FAIL", part, f"cNvPr id {i} without name", "E1 schema (name required)")
            elif any(ord(ch) < 32 for ch in nm):
                self.add("ID-02", "WARN", part, f"cNvPr {i} name has control characters", "")
            descr = c.get("descr")
            if descr and any(ord(ch) < 32 and ch not in "\n\r\t" for ch in descr):
                self.add("ID-02", "WARN", part, f"cNvPr {i} descr has control characters", "")
        dup = sorted(i for i, n in collections.Counter(ids).items() if n > 1)
        if dup:
            self.add("ID-01", "FAIL", part, f"duplicate cNvPr ids (group children included): {dup}",
                     "E1 §19.3.1.12 (unique id); FLD Open XML SDK does not flag it (shape-table-mapping.md §6)")
        self.ok("ID-01"); self.ok("ID-02")
        self.facts.setdefault("ids", {})[part] = {"n": len(ids), "min": min(ids) if ids else None,
                                                  "max": max(ids) if ids else None}
        spTree = t.find(f"{q('p:cSld')}/{q('p:spTree')}")
        if spTree is None:
            return
        root_id = spTree.find(f"{q('p:nvGrpSpPr')}/{q('p:cNvPr')}")
        if root_id is not None and root_id.get("id") != "1":
            self.add("ID-03", "INFO", part, f"spTree root id {root_id.get('id')} (PowerPoint writes 1)", "")
        # groups
        depth_max = 0
        for g in spTree.iter(q("p:grpSp")):
            depth = sum(1 for a in g.iterancestors(q("p:grpSp")))
            depth_max = max(depth_max, depth + 1)
            self.check_group(part, g)
        self.facts.setdefault("group_depth", {})[part] = depth_max
        # every object: absolute box via group transforms
        for obj in spTree.iter(q("p:sp"), q("p:pic"), q("p:graphicFrame"), q("p:cxnSp")):
            self.check_object(pkg, part, obj)
        self.ok("GRP-01"); self.ok("GRP-02"); self.ok("GRP-03"); self.ok("OBJ-01")

    @staticmethod
    def xfrm_of(obj):
        tag = ln(obj)
        if tag == "graphicFrame":
            return obj.find(q("p:xfrm"))
        if tag == "grpSp":
            return obj.find(f"{q('p:grpSpPr')}/{q('a:xfrm')}")
        return obj.find(f"{q('p:spPr')}/{q('a:xfrm')}")

    @staticmethod
    def box(x):
        off, ext = x.find(q("a:off")), x.find(q("a:ext"))
        if off is None or ext is None:
            return None
        return int(off.get("x")), int(off.get("y")), int(ext.get("cx")), int(ext.get("cy"))

    def check_group(self, part, g):
        nm = g.find(f"{q('p:nvGrpSpPr')}/{q('p:cNvPr')}")
        name = nm.get("name") if nm is not None else "?"
        x = self.xfrm_of(g)
        if x is None:
            self.add("GRP-01", "FAIL", part, f"group {name!r} without grpSpPr/a:xfrm", "E1 §20.1.7.5")
            return
        parts_ = {ln(c): c for c in x}
        missing = [k for k in ("off", "ext", "chOff", "chExt") if k not in parts_]
        if missing:
            self.add("GRP-01", "FAIL", part, f"group {name!r} xfrm lacks {missing}", "E1 §20.1.7.5 / OI 2.1.1278")
            return
        off = (int(parts_["off"].get("x")), int(parts_["off"].get("y")))
        ext = (int(parts_["ext"].get("cx")), int(parts_["ext"].get("cy")))
        choff = (int(parts_["chOff"].get("x")), int(parts_["chOff"].get("y")))
        chext = (int(parts_["chExt"].get("cx")), int(parts_["chExt"].get("cy")))
        if 0 in ext or 0 in chext:
            self.add("GRP-01", "WARN", part, f"group {name!r} zero extent ext={ext} chExt={chext}",
                     "OI 2.1.1278 (zero child extents = no scaling)")
        if off != choff or ext != chext:
            self.add("GRP-02", "INFO", part, f"group {name!r} non-identity child transform off={off} ext={ext} "
                     f"chOff={choff} chExt={chext}", "OI 2.1.1282b")
        if x.get("rot") or x.get("flipH") or x.get("flipV"):
            self.add("GRP-02", "INFO", part, f"group {name!r} rotated/flipped", "")
        # children within the child box
        cx0, cy0 = choff
        cx1, cy1 = choff[0] + chext[0], choff[1] + chext[1]
        kids = [c for c in g if ln(c) in ("sp", "pic", "graphicFrame", "grpSp", "cxnSp")]
        if len(kids) < 2:
            self.add("GRP-03", "INFO", part, f"group {name!r} has {len(kids)} child(ren)", "")
        bx0 = by0 = math.inf
        bx1 = by1 = -math.inf
        for k in kids:
            kx = self.xfrm_of(k)
            b = self.box(kx) if kx is not None else None
            if b is None:
                self.add("GRP-03", "FAIL", part, f"child {ln(k)} of group {name!r} without xfrm off/ext",
                         "E1 §20.1.7.6 (a grouped object needs its own transform)")
                continue
            x0, y0, w, h = b
            rot = int(kx.get("rot", "0")) / 60000.0
            if rot % 360:
                a = math.radians(rot)
                cw = abs(w * math.cos(a)) + abs(h * math.sin(a))
                ch = abs(w * math.sin(a)) + abs(h * math.cos(a))
                ccx, ccy = x0 + w / 2, y0 + h / 2
                x0, y0, w, h = ccx - cw / 2, ccy - ch / 2, cw, ch
            bx0, by0 = min(bx0, x0), min(by0, y0)
            bx1, by1 = max(bx1, x0 + w), max(by1, y0 + h)
            if ln(k) == "graphicFrame":
                gd = k.find(f"{q('a:graphic')}/{q('a:graphicData')}")
                if gd is not None and gd.get("uri", "").endswith("/table"):
                    self.add("GRP-04", "WARN", part, f"table inside group {name!r}",
                             "Microsoft Support: tables cannot be grouped")
        if bx0 < math.inf:
            tol = 2
            if bx0 < cx0 - tol or by0 < cy0 - tol or bx1 > cx1 + tol or by1 > cy1 + tol:
                self.add("GRP-03", "WARN", part, f"group {name!r} children bbox ({bx0:.0f},{by0:.0f})-({bx1:.0f},{by1:.0f}) "
                         f"exceeds child box ({cx0},{cy0})-({cx1},{cy1})", "PowerPoint recomputes group bounds on edit")
            slack = max(cx0 - bx0, cy0 - by0, bx1 - cx1, by1 - cy1, bx0 - cx0, by0 - cy0, cx1 - bx1, cy1 - by1)
            self.facts.setdefault("group_slack_emu", []).append(round(abs(slack), 1))

    def check_object(self, pkg, part, obj):
        tag = ln(obj)
        nv = next((c for c in obj if ln(c).startswith("nv")), None)
        cnv = nv.find(q("p:cNvPr")) if nv is not None else None
        name = cnv.get("name") if cnv is not None else "?"
        x = self.xfrm_of(obj)
        if x is None or self.box(x) is None:
            is_ph = nv is not None and nv.find(f"{q('p:nvPr')}/{q('p:ph')}") is not None
            if tag == "graphicFrame" or not is_ph:
                self.add("OBJ-01", "FAIL" if tag == "graphicFrame" else "WARN", part,
                         f"{tag} {name!r} without xfrm off/ext", "E1 §19.3.1.53 (graphicFrame xfrm required)")
        else:
            X, Y, W, H = self.box(x)
            if W < 0 or H < 0:
                self.add("OBJ-01", "FAIL", part, f"{tag} {name!r} negative extent", "E1 ST_PositiveCoordinate")
        if cnv is not None:
            for ext in cnv.iter(q("a:ext")):
                if not ext.get("uri"):
                    self.add("EXT-01", "FAIL", part, f"{name!r}: a:ext without uri", "OI 2.1.1206 (Office requires uri)")
                elif ext.get("uri") == EXT_URI_DECORATIVE:
                    d = ext.find(q("adec:decorative"))
                    if d is None or d.get("val") not in ("0", "1", "true", "false"):
                        self.add("EXT-02", "FAIL", part, f"{name!r}: decorative ext without adec:decorative@val",
                                 "[MS-ODRAWXML] decorative")
        pg = obj.find(f"{q('p:spPr')}/{q('a:prstGeom')}")
        if pg is not None and pg.get("prst") == "roundRect":
            for gd_ in pg.iter(q("a:gd")):
                m = re.match(r"^val (-?\d+)$", gd_.get("fmla", ""))
                if gd_.get("name") == "adj" and m and not (0 <= int(m.group(1)) <= 50000):
                    self.add("SHP-02", "WARN", part, f"{name!r}: roundRect adj {m.group(1)} outside 0..50000 (Office clamps)",
                             "shape-table-mapping.md §6 (silent clamp)")
        self.ok("SHP-02")
        for sh in obj.findall(f"{q('p:spPr')}/{q('a:effectLst')}/{q('a:outerShdw')}"):
            if sh.get("sx", "100000") != "100000" or sh.get("sy", "100000") != "100000":
                self.add("SHP-03", "WARN", part, f"{name!r}: outerShdw sx/sy != 100% in spPr (not rendered by Office)",
                         "OI 2.1.1303a")
        self.ok("SHP-03")
        if tag == "graphicFrame":
            gd = obj.find(f"{q('a:graphic')}/{q('a:graphicData')}")
            uri = gd.get("uri") if gd is not None else None
            if uri not in GRAPHIC_URIS:
                self.add("OBJ-02", "FAIL", part, f"graphicFrame {name!r} uri {uri!r}", "OI 2.1.1207a/b")
            if x is not None and (x.get("rot") or x.get("flipH") or x.get("flipV")):
                self.add("OBJ-02", "WARN", part, f"graphicFrame {name!r} rot/flip (ignored by Office)", "OI 2.1.1283b")
            if uri and uri.endswith("/table"):
                self.check_table(part, obj, name)
            if uri and uri.endswith("/chart"):
                ch = gd.find(q("c:chart"))
                rid = ch.get(f"{{{R_NS}}}id") if ch is not None else None
                r = self.rel_by_id(pkg, part, rid)
                if r is None or r.rtype != RT + "chart":
                    self.add("CHT-01", "FAIL", part, f"chart frame {name!r} r:id {rid} not a chart relationship", "E1 §21.2")
                else:
                    self.check_chart(pkg, r.target, part)
        if tag == "pic":
            self.check_picture(pkg, part, obj, name)
        # text bodies
        tx = obj.find(q("p:txBody"))
        if tx is not None:
            self.check_txbody(part, tx, name)

    def check_txbody(self, part, tx, name):
        if tx.find(q("a:p")) is None:
            self.add("TXT-01", "FAIL", part, f"{name!r}: txBody without a:p", "E1 CT_TextBody (>=1 a:p)")
        for fld in tx.iter(q("a:fld")):
            fid = fld.get("id")
            if not fid or not GUID_RE.match(fid):
                self.add("TXT-02", "FAIL", part, f"{name!r}: a:fld id {fid!r} not an upper-case {{GUID}}",
                         "E1 §21.1.2.2.4 / ST_Guid")
            if not fld.get("type"):
                self.add("TXT-02", "WARN", part, f"{name!r}: a:fld without type", "OI 2.1.1385")
        for r in tx.iter(q("a:r")):
            if r.find(q("a:rPr")) is None:
                self.add("TXT-05", "INFO", part, f"{name!r}: a:r without a:rPr", "text-mapping.md §7 (valid but avoid)")
        for e in tx.iter(q("a:latin"), q("a:ea"), q("a:cs"), q("a:sym"), q("a:buFont")):
            if e.get("typeface") == "":
                self.add("TXT-05", "WARN", part, f"{name!r}: empty typeface on {ln(e)}", "text-mapping.md §7; FLD PHPPresentation (missing ea typeface)")
        for ppr in tx.iter(q("a:pPr"), q("a:lvl1pPr")):
            mar, ind = int(ppr.get("marL", "0")), int(ppr.get("indent", "0"))
            if ind < -mar:
                self.add("TXT-05", "WARN", part, f"{name!r}: indent {ind} < -marL {mar}", "text-mapping.md §7")
        for e in tx.iter(q("a:rPr"), q("a:endParaRPr"), q("a:defRPr")):
            for att in ("b", "i"):
                if e.get(att) not in (None, "0", "1"):
                    self.add("TXT-05", "INFO", part, f"{name!r}: {att}={e.get(att)!r} (Office writes 0/1)", "text-mapping.md §7")
        for e in tx.iter(q("a:rPr"), q("a:endParaRPr"), q("a:defRPr")):
            for att in ("lang", "altLang"):
                v = e.get(att)
                if v is not None and not LANG_RE.match(v):
                    self.add("TXT-04", "WARN", part, f"{name!r}: {att}={v!r}", "BCP 47")
        self.ok("TXT-01"); self.ok("TXT-02"); self.ok("TXT-04"); self.ok("TXT-05")

    # ------------------------------------------------------------------ pictures
    def check_picture(self, pkg, part, pic, name):
        blip = pic.find(f"{q('p:blipFill')}/{q('a:blip')}")
        if blip is None:
            self.add("PIC-01", "FAIL", part, f"picture {name!r} without a:blip", "E1 §20.1.8.13")
            return
        rid = blip.get(f"{{{R_NS}}}embed")
        r = self.rel_by_id(pkg, part, rid)
        if r is None or r.rtype != RT + "image":
            self.add("PIC-01", "FAIL", part, f"picture {name!r} blip r:embed {rid} not an image relationship", "E1")
            return
        self.check_raster(pkg, r.target)
        for ext in blip.findall(f"{q('a:extLst')}/{q('a:ext')}"):
            if not ext.get("uri"):
                self.add("EXT-01", "FAIL", part, f"{name!r}: blip ext without uri", "OI 2.1.1206")
            if ext.get("uri") == EXT_URI_SVG:
                s = ext.find(q("asvg:svgBlip"))
                srid = s.get(f"{{{R_NS}}}embed") if s is not None else None
                sr = self.rel_by_id(pkg, part, srid)
                if sr is None or sr.rtype != RT + "image":
                    self.add("PIC-02", "FAIL", part, f"{name!r}: svgBlip r:embed {srid} unresolved", "[MS-ODRAWXML] svgBlip")
                else:
                    ct = self.ct_of(pkg, sr.target)
                    if ct != "image/svg+xml":
                        self.add("PIC-02", "FAIL", sr.target, f"SVG part content type {ct!r}", "[MS-ODRAWXML] svgBlip")
                    self.check_svg(pkg, sr.target)
        # blip child order: effects (alphaModFix...) before extLst
        kids = [ln(c) for c in blip]
        if "extLst" in kids and kids.index("extLst") != len(kids) - 1:
            self.add("PIC-03", "FAIL", part, f"{name!r}: a:blip children {kids} (extLst not last)", "E1 schema order")
        self.ok("PIC-01"); self.ok("PIC-02"); self.ok("PIC-03")

    def check_raster(self, pkg, target):
        seen = self.facts.setdefault("images", {})
        if target in seen:
            return
        data = pkg.parts.get(target)
        if data is None:
            return                                   # dangling target: reported by PKG-13
        info = {"bytes": len(data), "ct": self.ct_of(pkg, target)}
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(data))
            im.load()
            info.update({"format": im.format, "size": im.size, "mode": im.mode})
            fmt_ct = {"PNG": "image/png", "JPEG": "image/jpeg", "GIF": "image/gif", "BMP": "image/bmp",
                      "TIFF": "image/tiff"}.get(im.format)
            if fmt_ct and fmt_ct != info["ct"]:
                self.add("PIC-04", "FAIL", target, f"{im.format} data under content type {info['ct']}", "E1 §15.2.14")
        except Exception as e:  # noqa: BLE001
            self.add("PIC-04", "FAIL", target, f"image does not decode: {e}", "")
        seen[target] = info
        self.ok("PIC-04")

    def check_svg(self, pkg, target):
        seen = self.facts.setdefault("svgs", {})
        if target in seen:
            return
        data = pkg.parts[target]
        info = {"bytes": len(data)}
        try:
            root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, no_network=True))
            info["root"] = root.tag
            if root.tag != q("svg:svg"):
                self.add("PIC-05", "FAIL", target, f"SVG root {root.tag} (needs the SVG namespace)",
                         "Office SVG import requires xmlns=http://www.w3.org/2000/svg")
            els = collections.Counter(ln(e) for e in root.iter() if isinstance(e.tag, str))
            info["elements"] = dict(els)
            risky = {k: v for k, v in els.items() if k in ("style", "script", "foreignObject", "image", "use", "filter",
                                                            "mask", "clipPath", "pattern", "text", "textPath",
                                                            "symbol", "switch", "marker", "linearGradient",
                                                            "radialGradient")}
            if risky:
                self.add("PIC-05", "INFO", target, f"SVG uses {risky}", "features with uneven Office SVG support")
            info["viewBox"] = root.get("viewBox")
            info["w_h"] = (root.get("width"), root.get("height"))
            if not root.get("viewBox") and not (root.get("width") and root.get("height")):
                self.add("PIC-05", "WARN", target, "SVG without viewBox or width/height", "")
            for e in root.iter():
                for k, v in e.attrib.items() if isinstance(e.tag, str) else ():
                    if k.endswith("href") and not v.startswith("#"):
                        self.add("PIC-05", "WARN", target, f"external reference {v[:60]}", "")
        except etree.XMLSyntaxError as e:
            self.add("PIC-05", "FAIL", target, f"SVG not well-formed: {e}", "")
        seen[target] = info
        self.ok("PIC-05")

    # ------------------------------------------------------------------ tables
    def check_table(self, part, frame, name):
        tbl = frame.find(f"{q('a:graphic')}/{q('a:graphicData')}/{q('a:tbl')}")
        if tbl is None:
            self.add("TBL-00", "FAIL", part, f"table frame {name!r} without a:tbl", "OI 2.1.1207b")
            return
        cols = [int(g.get("w")) for g in tbl.findall(f"{q('a:tblGrid')}/{q('a:gridCol')}")]
        rows = tbl.findall(q("a:tr"))
        info = {"cols": len(cols), "rows": len(rows)}
        if not (1 <= len(rows) <= 1000) or not (1 <= len(cols) <= 1000):
            self.add("TBL-01", "FAIL", part, f"{name!r}: {len(rows)} rows x {len(cols)} cols", "OI 2.1.1424a/b, 2.1.1425")
        self.ok("TBL-01")
        grid = []
        for ri, tr in enumerate(rows):
            tcs = tr.findall(q("a:tc"))
            if len(tcs) != len(cols):
                self.add("TBL-02", "FAIL", part, f"{name!r}: row {ri} has {len(tcs)} a:tc for {len(cols)} gridCol",
                         "OI 2.1.1424c / 2.1.1427b")
            grid.append(tcs)
            h = int(tr.get("h", "0"))
            if h < 0 or h > 0x3FFFFFFF:
                self.add("TBL-05", "FAIL", part, f"{name!r}: row {ri} h={h}", "OI 2.1.1427a")
            for ci, tc in enumerate(tcs):
                pr = tc.find(q("a:tcPr"))
                marT = int(pr.get("marT", "45720")) if pr is not None else 45720
                marB = int(pr.get("marB", "45720")) if pr is not None else 45720
                if h != 0 and h <= marT + marB + 2 * PT and int(tc.get("rowSpan", "1")) == 1 and tc.get("vMerge") not in ("1", "true"):
                    self.add("TBL-05", "FAIL", part, f"{name!r}: row {ri} h={h} <= marT+marB+2pt "
                             f"({marT}+{marB}+{2 * PT}) at col {ci}", "OI 2.1.1427a (minimal row height)")
                if tc.find(q("a:txBody")) is None:
                    self.add("TBL-06", "WARN", part, f"{name!r}: cell ({ri},{ci}) without txBody", "PowerPoint writes one")
                else:
                    self.check_txbody(part, tc.find(q("a:txBody")), f"{name} cell ({ri},{ci})")
        self.ok("TBL-02"); self.ok("TBL-05"); self.ok("TBL-06")
        # gridCol minimum width [OI 2.1.1416]
        for ci, w in enumerate(cols):
            for ri, tcs in enumerate(grid):
                if ci >= len(tcs):
                    continue
                tc = tcs[ci]
                if int(tc.get("gridSpan", "1")) != 1 or tc.get("hMerge") in ("1", "true"):
                    continue
                pr = tc.find(q("a:tcPr"))
                marL = int(pr.get("marL", "91440")) if pr is not None else 91440
                marR = int(pr.get("marR", "91440")) if pr is not None else 91440
                if w < marL + marR + 2 * PT:
                    self.add("TBL-04", "FAIL", part, f"{name!r}: gridCol {ci} w={w} < marL+marR+2pt at row {ri}",
                             "OI 2.1.1416")
        self.ok("TBL-04")
        # merges [OI 2.1.1424d, 2.1.1426]
        R, C = len(grid), len(cols)
        covered = [[None] * C for _ in range(R)]
        for ri, tcs in enumerate(grid):
            for ci, tc in enumerate(tcs[:C]):
                rs, gs = int(tc.get("rowSpan", "1")), int(tc.get("gridSpan", "1"))
                if rs < 1 or gs < 1 or ri + rs > R or ci + gs > C:
                    self.add("TBL-03", "FAIL", part, f"{name!r}: cell ({ri},{ci}) rowSpan={rs} gridSpan={gs} out of range",
                             "OI 2.1.1426a/b")
                    continue
                hm, vm = tc.get("hMerge") in ("1", "true"), tc.get("vMerge") in ("1", "true")
                if (rs > 1 or gs > 1) and (hm or vm):
                    self.add("TBL-03", "FAIL", part, f"{name!r}: merge origin ({ri},{ci}) also hMerge/vMerge", "OI 2.1.1426c")
                if rs > 1 or gs > 1:
                    for rr in range(ri, ri + rs):
                        for cc in range(ci, ci + gs):
                            if covered[rr][cc] is not None:
                                self.add("TBL-03", "FAIL", part, f"{name!r}: overlapping merges at ({rr},{cc})", "OI 2.1.1424d")
                            covered[rr][cc] = (ri, ci)
        for ri, tcs in enumerate(grid):
            for ci, tc in enumerate(tcs[:C]):
                hm, vm = tc.get("hMerge") in ("1", "true"), tc.get("vMerge") in ("1", "true")
                org = covered[ri][ci]
                if (hm or vm) and (org is None or org == (ri, ci)):
                    self.add("TBL-03", "FAIL", part, f"{name!r}: orphan hMerge/vMerge at ({ri},{ci})", "OI 2.1.1426c")
                if org and org != (ri, ci):
                    if org[1] != ci and not hm:
                        self.add("TBL-03", "FAIL", part, f"{name!r}: ({ri},{ci}) inside a merge without hMerge", "OI 2.1.1426c")
                    if org[0] != ri and org[1] == ci and not vm:
                        self.add("TBL-03", "FAIL", part, f"{name!r}: ({ri},{ci}) inside a merge without vMerge", "OI 2.1.1426c")
        self.ok("TBL-03")
        # frame vs grid
        X = frame.find(q("p:xfrm"))
        b = self.box(X) if X is not None else None
        tw, th = sum(cols), sum(int(tr.get("h", "0")) for tr in rows)
        info.update({"grid_w": tw, "rows_h": th, "frame": b})
        if b and (abs(b[2] - tw) > 1 or abs(b[3] - th) > 1):
            self.add("TBL-07", "INFO", part, f"{name!r}: frame {b[2]}x{b[3]} != grid {tw}x{th}",
                     "PowerPoint-saved decks also differ (rows grown by text); frame is recomputed")
        self.ok("TBL-07")
        pr = tbl.find(q("a:tblPr"))
        sid = pr.findtext(q("a:tableStyleId")) if pr is not None else None
        info["tableStyleId"] = sid
        info["tblPr"] = dict(pr.attrib) if pr is not None else {}
        info["tblPr_children"] = [ln(c) for c in pr] if pr is not None else []
        if sid and not GUID_RE.match(sid):
            self.add("TBL-08", "FAIL", part, f"{name!r}: tableStyleId {sid!r} not a GUID", "E1 §21.1.3.12")
        self.ok("TBL-08")
        self.facts.setdefault("tables", {})[f"{part}:{name}"] = info
        if frame.getparent().tag == q("p:grpSp"):
            self.add("GRP-04", "WARN", part, f"table {name!r} inside a group", "Microsoft Support: tables cannot be grouped")

    # ------------------------------------------------------------------ charts
    def check_chart(self, pkg, cpart, host):
        done = self.facts.setdefault("charts", {})
        if cpart in done:
            return
        t = pkg.xml.get(cpart)
        info = {"host": host}
        done[cpart] = info
        if t is None:
            self.add("CHT-01", "FAIL", cpart, "chart part missing or not XML", "")
            return
        ext = t.find(q("c:externalData"))
        wb = None
        if ext is not None:
            r = self.rel_by_id(pkg, cpart, ext.get(f"{{{R_NS}}}id"))
            if r is None:
                self.add("CHT-01", "FAIL", cpart, "externalData r:id unresolved", "E1 §21.2.2.63")
            elif r.rtype != RT + "package":
                self.add("CHT-01", "WARN", cpart, f"externalData via {r.rtype}", "PowerPoint writes a package rel")
            else:
                wb = r.target
                au = ext.find(q("c:autoUpdate"))
                info["autoUpdate"] = au.get("val") if au is not None else None
        else:
            self.add("CHT-01", "WARN", cpart, "no externalData: Edit Data has no workbook", "E1 §21.2.2.63")
        info["workbook"] = wb
        # series idx/order unique [OI 2.1.1482/2.1.1509 per chart-mapping.md]
        sers = t.findall(f".//{q('c:ser')}")
        idxs = [s.find(q("c:idx")).get("val") for s in sers]
        ords = [s.find(q("c:order")).get("val") for s in sers]
        if len(set(idxs)) != len(idxs) or len(set(ords)) != len(ords):
            self.add("CHT-02", "FAIL", cpart, f"series idx {idxs} / order {ords} not unique",
                     "OI 2.1.1482/2.1.1509; FLD python-pptx #123 (PowerPoint removes the shapes)")
        self.ok("CHT-02")
        # axes
        ax_ids = {a.find(q("c:axId")).get("val") for a in t.iter(q("c:valAx"), q("c:catAx"), q("c:dateAx"), q("c:serAx"))}
        for grp in t.find(f"{q('c:chart')}/{q('c:plotArea')}"):
            if ln(grp).endswith("Chart"):
                for a in grp.findall(q("c:axId")):
                    if a.get("val") not in ax_ids:
                        self.add("CHT-03", "FAIL", cpart, f"{ln(grp)} axId {a.get('val')} matches no axis", "OI 2.1.1432")
        for a in t.iter(q("c:valAx"), q("c:catAx")):
            ca = a.find(q("c:crossAx")).get("val")
            if ca not in ax_ids:
                self.add("CHT-03", "FAIL", cpart, f"crossAx {ca} matches no axis", "OI 2.1.1446")
            for v in (a.find(q("c:axId")).get("val"), ca):
                if not (-2147483648 <= int(v) <= 2147483647):     # PowerPoint writes negative (signed) ids
                    self.add("CHT-03", "FAIL", cpart, f"axis id {v} out of range", "OI 2.1.1432/2.1.1570")
        self.ok("CHT-03")
        # dLblPos [OI 2.1.1456]
        for bar in t.iter(q("c:barChart")):
            grouping = bar.find(q("c:grouping")).get("val")
            allowed = {"ctr", "inBase", "inEnd", "outEnd"} if grouping == "clustered" else {"ctr", "inBase", "inEnd"}
            for p in bar.iter(q("c:dLblPos")):
                if p.get("val") not in allowed:
                    self.add("CHT-04", "FAIL", cpart, f"barChart({grouping}) dLblPos {p.get('val')}",
                             "OI 2.1.1456; FLD PptxGenJS #768/#788 (repair)")
        for ch in t.iter(q("c:lineChart"), q("c:pieChart"), q("c:doughnutChart"), q("c:areaChart")):
            allowed = {"lineChart": {"t", "b", "l", "r", "ctr"}, "pieChart": {"bestFit", "ctr", "inEnd", "outEnd"},
                       "doughnutChart": set(), "areaChart": set()}[ln(ch)]
            for p in ch.iter(q("c:dLblPos")):
                if p.get("val") not in allowed:
                    self.add("CHT-04", "FAIL", cpart, f"{ln(ch)} dLblPos {p.get('val')}", "OI 2.1.1456")
        self.ok("CHT-04")
        # manualLayout [OI 2.1.1494]
        for ml in t.iter(q("c:manualLayout")):
            vals = {ln(c): c.get("val") for c in ml}
            if any(k in vals for k in ("x", "y", "w", "h")) and not all(k in vals for k in ("x", "y", "w", "h")):
                par = ml.getparent().getparent()
                if ln(par) in ("plotArea", "legend"):
                    self.add("CHT-05", "FAIL", cpart, f"partial manualLayout under {ln(par)}: {vals}", "OI 2.1.1494")
            for k in ("x", "y", "w", "h"):
                if k in vals and not (-1e-9 <= float(vals[k]) <= 1 + 1e-9):
                    self.add("CHT-05", "WARN", cpart, f"manualLayout {k}={vals[k]} outside [0,1]", "chart-mapping.md")
            if all(k in vals for k in ("x", "w")) and float(vals["x"]) + float(vals["w"]) > 1 + 1e-6:
                self.add("CHT-05", "WARN", cpart, f"manualLayout x+w={float(vals['x']) + float(vals['w']):.4f} > 1", "")
            if all(k in vals for k in ("y", "h")) and float(vals["y"]) + float(vals["h"]) > 1 + 1e-6:
                self.add("CHT-05", "WARN", cpart, f"manualLayout y+h={float(vals['y']) + float(vals['h']):.4f} > 1", "")
            info["manualLayout"] = vals
        self.ok("CHT-05")
        # other Office chart rules [OI 2.1.1551, 2.1.1549, 2.1.1457, 2.1.1439, 2.1.1458/1480]
        for grp in t.find(f"{q('c:chart')}/{q('c:plotArea')}"):
            g = ln(grp)
            if not g.endswith("Chart"):
                continue
            for sp in grp.iter(q("c:showPercent")):
                if sp.get("val") in ("1", "true") and g not in ("pieChart", "pie3DChart", "doughnutChart", "ofPieChart"):
                    self.add("CHT-09", "FAIL", cpart, f"showPercent=1 in {g}", "OI 2.1.1551")
            for sl in grp.iter(q("c:showLeaderLines")):
                if sl.get("val") in ("1", "true") and g not in ("pieChart", "pie3DChart", "doughnutChart", "ofPieChart"):
                    self.add("CHT-09", "WARN", cpart, f"showLeaderLines=1 in {g}", "OI 2.1.1549")
            gd = grp.find(q("c:dLbls"))
            if gd is not None and any(gd.find(q(k)) is not None for k in ("c:numFmt", "c:spPr", "c:txPr")):
                self.add("CHT-09", "WARN", cpart, f"group-level dLbls of {g} carries numFmt/spPr/txPr", "OI 2.1.1457")
            if g in ("barChart", "bar3DChart"):
                bd = grp.find(q("c:barDir"))
                if bd is None or bd.get("val") is None:
                    self.add("CHT-09", "FAIL", cpart, "barDir without val", "OI 2.1.1439")
                ov = grp.find(q("c:overlap"))
                if ov is not None and not (-100 <= int(ov.get("val", "0")) <= 100):
                    self.add("CHT-09", "FAIL", cpart, f"overlap {ov.get('val')}", "E1 ST_Overlap")
                gw = grp.find(q("c:gapWidth"))
                if gw is not None and not (0 <= int(gw.get("val", "150")) <= 500):
                    self.add("CHT-09", "FAIL", cpart, f"gapWidth {gw.get('val')}", "E1 ST_GapAmount")
                if len(grp.findall(q("c:serLines"))) > 1:
                    self.add("CHT-09", "FAIL", cpart, "more than one serLines", "OI 2.1.1438")
            if g == "doughnutChart":
                hs = grp.find(q("c:holeSize"))
                if hs is None or not (1 <= int(hs.get("val", "0")) <= 90):
                    self.add("CHT-09", "FAIL", cpart, "doughnut holeSize missing or outside 1..90", "OI 2.1.1458/2.1.1480")
        self.ok("CHT-09")
        # caches: ptCount, pt idx
        for cache in t.iter(q("c:strCache"), q("c:numCache")):
            pc = int(cache.find(q("c:ptCount")).get("val"))
            pidx = [int(p.get("idx")) for p in cache.findall(q("c:pt"))]
            if len(set(pidx)) != len(pidx) or any(i >= pc or i < 0 for i in pidx):
                self.add("CHT-06", "FAIL", cpart, f"cache ptCount {pc} idx {pidx}", "E1 §21.2.2.150")
        self.ok("CHT-06")
        # workbook: formulas point at existing cells holding the cached values
        if wb:
            self.check_workbook(pkg, cpart, t, wb, info)
        # chart part's own rels: every target exists (done in PKG-13); style parts?
        info["rels"] = [(r.rtype.rsplit("/", 1)[-1], r.target) for r in self.rels_of(pkg, cpart)]

    def check_workbook(self, pkg, cpart, t, wb, info):
        data = pkg.parts[wb]
        try:
            zz = zipfile.ZipFile(io.BytesIO(data))
            wnames = zz.namelist()
            dup = [n for n, c in collections.Counter(wnames).items() if c > 1]
            if dup:
                self.add("CHT-07", "FAIL", wb, f"workbook duplicate entries {dup}", "")
            if "[Content_Types].xml" not in wnames:
                self.add("CHT-07", "FAIL", wb, "workbook without [Content_Types].xml", "E2")
            import openpyxl
            book = openpyxl.load_workbook(io.BytesIO(data), data_only=False)
        except Exception as e:  # noqa: BLE001
            self.add("CHT-07", "FAIL", wb, f"embedded workbook does not open: {e}", "Edit Data would fail")
            return
        info["sheets"] = book.sheetnames
        mism = 0
        checked = 0
        for ref in t.iter(q("c:strRef"), q("c:numRef")):
            f = ref.findtext(q("c:f"))
            cache = ref.find(q("c:strCache")) if ln(ref) == "strRef" else ref.find(q("c:numCache"))
            m = re.match(r"^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$", f or "")
            if not m:
                self.add("CHT-07", "WARN", cpart, f"unparsed formula {f!r}", "")
                continue
            sheet = (m.group(1) or m.group(2)).replace("''", "'")
            if sheet not in book.sheetnames:
                self.add("CHT-07", "FAIL", cpart, f"formula {f!r}: no sheet {sheet!r} in {book.sheetnames}",
                         "Edit Data / refresh would break the link")
                continue
            ws = book[sheet]
            c0, r0 = m.group(3), int(m.group(4))
            c1, r1 = (m.group(5) or c0), int(m.group(6) or r0)
            from openpyxl.utils import column_index_from_string, get_column_letter
            cells = []
            for rr in range(r0, r1 + 1):
                for cc in range(column_index_from_string(c0), column_index_from_string(c1) + 1):
                    cells.append(ws[f"{get_column_letter(cc)}{rr}"].value)
            pts = {int(p.get("idx")): p.findtext(q("c:v")) for p in cache.findall(q("c:pt"))} if cache is not None else {}
            for i, v in enumerate(cells):
                cv = pts.get(i)
                checked += 1
                if cv is None and v is None:
                    continue
                same = False
                try:
                    same = abs(float(cv) - float(v)) < 1e-9
                except (TypeError, ValueError):
                    same = str(cv) == str(v)
                if not same:
                    mism += 1
                    if mism <= 5:
                        self.add("CHT-08", "WARN", cpart, f"{f}[{i}]: cache {cv!r} != workbook {v!r}",
                                 "Edit Data shows the workbook values")
        info["formula_cells_checked"] = checked
        self.ok("CHT-07"); self.ok("CHT-08")

    # ------------------------------------------------------------------ theme
    def check_theme(self, pkg, tpart):
        t = pkg.xml.get(tpart)
        if t is None:
            return
        cs = t.find(f"{q('a:themeElements')}/{q('a:clrScheme')}")
        slots = ("dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
                 "hlink", "folHlink")
        if cs is None:
            self.add("THM-01", "FAIL", tpart, "no clrScheme", "E1 §20.1.6.2")
        else:
            got = [ln(c) for c in cs]
            if got[:12] != list(slots):
                self.add("THM-01", "FAIL", tpart, f"clrScheme children {got}", "E1 schema")
            for c in cs:
                kids = [k for k in c if isinstance(k.tag, str)]
                if len(kids) != 1 or ln(kids[0]) not in ("srgbClr", "sysClr", "scrgbClr", "hslClr", "prstClr", "schemeClr"):
                    self.add("THM-01", "FAIL", tpart, f"clrScheme/{ln(c)} children {[ln(k) for k in kids]}", "E1 §20.1.4.1")
                elif ln(kids[0]) == "schemeClr":
                    self.add("THM-01", "FAIL", tpart, f"clrScheme/{ln(c)} is a schemeClr", "OI 2.1.1248-2.1.1260 (Office does not allow)")
                if ln(c) in ("dk1", "lt1") and kids and ln(kids[0]) != "sysClr":
                    self.add("THM-01", "INFO", tpart, f"{ln(c)} is {ln(kids[0])} (PowerPoint's own themes use sysClr "
                             "windowText/window)", "")
            if not cs.get("name"):
                self.add("THM-01", "WARN", tpart, "clrScheme without name", "E1 (name required)")
        self.ok("THM-01")
        fs = t.find(f"{q('a:themeElements')}/{q('a:fontScheme')}")
        for kind in ("majorFont", "minorFont"):
            f = fs.find(q("a:" + kind)) if fs is not None else None
            if f is None:
                self.add("THM-02", "FAIL", tpart, f"no {kind}", "E1 §20.1.4.1.24")
                continue
            got = [ln(c) for c in f][:3]
            if got != ["latin", "ea", "cs"]:
                self.add("THM-02", "FAIL", tpart, f"{kind} starts {got}", "E1 schema (latin, ea, cs)")
            for c in f:
                if ln(c) == "font" and not c.get("typeface"):
                    self.add("THM-02", "WARN", tpart, f"{kind} font script={c.get('script')} empty typeface", "")
        self.ok("THM-02")
        fm = t.find(f"{q('a:themeElements')}/{q('a:fmtScheme')}")
        for lst in ("fillStyleLst", "lnStyleLst", "effectStyleLst", "bgFillStyleLst"):
            e = fm.find(q("a:" + lst)) if fm is not None else None
            n = len([c for c in e if isinstance(c.tag, str)]) if e is not None else 0
            if n < 3:
                self.add("THM-03", "FAIL", tpart, f"{lst} has {n} entries (>= 3 required)", "E1 §20.1.4.1.? minOccurs 3")
        self.ok("THM-03")
        self.facts.setdefault("themes", {})[tpart] = {"name": t.get("name"), "clrScheme": cs.get("name") if cs is not None else None}

    # ------------------------------------------------------------------ docProps
    def check_docprops(self, pkg, n_slides, n_notes):
        core = next((r.target for r in self.rels_of(pkg, "/") if r.rtype == RT_PKG + "metadata/core-properties"), None)
        app = next((r.target for r in self.rels_of(pkg, "/") if r.rtype == RT + "extended-properties"), None)
        thumb = [r.target for r in self.rels_of(pkg, "/") if r.rtype == RT_PKG + "metadata/thumbnail"]
        if core:
            t = pkg.xml[core]
            for tag in ("dcterms:created", "dcterms:modified"):
                e = t.find(q(tag))
                if e is not None:
                    if e.get(f"{{{NS['xsi']}}}type") != "dcterms:W3CDTF":
                        self.add("DOC-01", "WARN", core, f"{tag} without xsi:type dcterms:W3CDTF", "E2 §8.3")
                    if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$", e.text or ""):
                        self.add("DOC-01", "FAIL", core, f"{tag} {e.text!r} not W3CDTF date-time", "E2 §8.3")
            rev = t.findtext(q("cp:revision"))
            if rev is not None and not rev.isdigit():
                self.add("DOC-01", "WARN", core, f"revision {rev!r}", "")
            for e in t.iter():
                if isinstance(e.tag, str) and e.get("{http://www.w3.org/XML/1998/namespace}lang"):
                    self.add("DOC-01", "WARN", core, "xml:lang in core properties (Office discards)", "OI 2.1.1750a")
        else:
            self.add("DOC-01", "WARN", "/", "no core properties", "")
        self.ok("DOC-01")
        if app:
            t = pkg.xml[app]
            hp = t.find(f"{q('ep:HeadingPairs')}/{q('vt:vector')}")
            tp = t.find(f"{q('ep:TitlesOfParts')}/{q('vt:vector')}")
            total = 0
            if hp is not None:
                if hp.get("baseType") != "variant":
                    self.add("DOC-02", "FAIL", app, "HeadingPairs vector baseType != variant", "OI 2.1.1720a")
                vs = hp.findall(q("vt:variant"))
                if int(hp.get("size", "-1")) != len(vs) or len(vs) % 2:
                    self.add("DOC-02", "FAIL", app, f"HeadingPairs size {hp.get('size')} vs {len(vs)} variants", "OI 2.1.1720a")
                for i in range(0, len(vs) - 1, 2):
                    a, b = vs[i][0], vs[i + 1][0]
                    if ln(a) not in ("lpstr", "lpwstr") or ln(b) != "i4" or int(b.text) < 1:
                        self.add("DOC-02", "FAIL", app, f"heading pair {i // 2}: {ln(a)}/{ln(b)}={b.text}", "OI 2.1.1720a")
                    else:
                        total += int(b.text)
            if tp is not None:
                items = [c for c in tp if isinstance(c.tag, str)]
                if int(tp.get("size", "-1")) != len(items):
                    self.add("DOC-02", "FAIL", app, f"TitlesOfParts size {tp.get('size')} vs {len(items)}", "E1 §22.2.2.26")
                if len(items) > total:
                    self.add("DOC-02", "FAIL", app, f"{len(items)} TitlesOfParts > {total} parts in HeadingPairs", "OI 2.1.1722b")
            av = t.findtext(q("ep:AppVersion"))
            if av is not None and not re.match(r"^[0-9]{1,2}\.[0-9]{1,4}$", av):
                self.add("DOC-02", "FAIL", app, f"AppVersion {av!r}", "OI 2.1.1717")
            tt = t.findtext(q("ep:TotalTime"))
            if tt is not None and int(tt) < 0:
                self.add("DOC-02", "FAIL", app, f"TotalTime {tt}", "OI 2.1.1723")
            sl = t.findtext(q("ep:Slides"))
            if sl is not None and int(sl) != n_slides:
                self.add("DOC-02", "WARN", app, f"Slides {sl} != {n_slides}", "E1 §22.2.2.?")
            nt = t.findtext(q("ep:Notes"))
            if nt is not None and int(nt) != n_notes:
                self.add("DOC-02", "WARN", app, f"Notes {nt} != {n_notes}", "")
            self.facts["app"] = {"Application": t.findtext(q("ep:Application")), "AppVersion": av}
        self.ok("DOC-02")
        for th in thumb:
            self.check_raster(pkg, th)
            self.facts["thumbnail"] = self.facts.get("images", {}).get(th)
        self.ok("DOC-03")

    # ------------------------------------------------------------------ run
    def run(self):
        pkg = self.load()
        self.pkg = pkg
        self.check_zip(pkg)
        self.check_generic(pkg)
        self.check_content_types(pkg)
        self.check_rels(pkg)
        res = self.check_presentation(pkg)
        if not res:
            return self
        pres, masters, slides = res
        layouts_info = {}
        for m in masters:
            if m not in pkg.xml:
                continue
            listed, mphs = self.check_master(pkg, m)
            self.check_tree(pkg, m)
            for th in self.rel_targets(pkg, m, RT + "theme"):
                self.check_theme(pkg, th.target)
            for lay in listed:
                if lay in pkg.xml:
                    layouts_info[lay] = self.check_layout(pkg, lay, mphs)
                    self.check_tree(pkg, lay)
        for n, s in enumerate(slides, 1):
            if s in pkg.xml:
                self.check_slide(pkg, s, layouts_info, n)
                self.check_tree(pkg, s)
        self.facts["layouts"] = {k: {"name": v["name"], "type": v["type"],
                                     "placeholders": [(p["type"], p["idx"], p["explicit_idx"]) for p in v["phs"]]}
                                 for k, v in layouts_info.items()}
        self.facts["slides"] = slides
        self.check_docprops(pkg, len(slides), self.facts.get("notes_slides", 0))
        return self

    def summary(self):
        sev = collections.Counter(f.severity for f in self.findings)
        return {"deck": self.path, "fail": sev.get("FAIL", 0), "warn": sev.get("WARN", 0), "info": sev.get("INFO", 0),
                "checks_run": dict(sorted(self.ran.items()))}


def _zip64_extra(extra: bytes):
    i = 0
    while i + 4 <= len(extra):
        hid, sz = struct.unpack_from("<HH", extra, i)
        if hid == 0x0001:
            yield True
        i += 4 + sz


def main(argv=None):
    import argparse

    import pdeathsig  # tools/pdeathsig.py: die with the parent (deck.mjs)
    pdeathsig.arm()
    ap = argparse.ArgumentParser()
    ap.add_argument("decks", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--no-info", action="store_true")
    ap.add_argument("--strict", action="store_true", help="exit 1 on any WARN too")
    a = ap.parse_args(argv)
    out = []
    for d in a.decks:
        c = Checker(d).run()
        s = c.summary()
        out.append({"summary": s, "findings": [f.__dict__ for f in c.findings], "facts": c.facts})
        if not a.quiet:
            print(f"=== {d}: {s['fail']} FAIL, {s['warn']} WARN, {s['info']} INFO; {len(s['checks_run'])} check ids ran")
            for f in c.findings:
                if a.no_info and f.severity == "INFO":
                    continue
                print(f"  [{f.severity}] {f.check} {f.part}: {f.detail}" + (f"  <{f.source}>" if f.source else ""))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1, default=str)
    return 1 if any(o["summary"]["fail"] or (a.strict and o["summary"]["warn"]) for o in out) else 0


if __name__ == "__main__":
    sys.exit(main())
