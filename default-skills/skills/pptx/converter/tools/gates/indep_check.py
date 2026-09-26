#!/usr/bin/env python3
"""Independent checker for PowerPoint font embedding (reviewer's tool).

Deliberately does NOT import tools/eot.py or tools/embed_fonts.py. Everything is re-derived:

* sfnt reader written from the OpenType spec (table directory, OS/2, head, name; table checksums and the
  whole-font checkSumAdjustment are recomputed);
* EOT parser driven by a field table transcribed from the W3C EOT submission (version 0x00020002);
* package checks written from ECMA-376 Part 2 (OPC) / Part 1 §15.2.13 / §19.2.1.x / [MS-OI29500] notes; the
  CT_Presentation child order is read from pml.xsd itself.

The `indep-check` gate of tools/deck.mjs (embedded profile only), ported from the PoC's font-embedding review lane.

Usage:  indep_check.py DECK.pptx [--font TYPEFACE:SLOT:TTF ...] [--json OUT.json]
Exit 0 = no ERROR findings. Findings are ERROR (spec violation / mismatch), WARN (deviates from what PowerPoint
writes / unproven), INFO (facts).
"""
from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
import zipfile
import zlib
from pathlib import Path

from lxml import etree

HERE = Path(__file__).resolve().parent
XSD_DIR = HERE / "xsd"                 # ECMA-376 transitional schemas (xsd/NOTICE.md)

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}
REL_TYPE_FONT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"  # ECMA-376 Part 4 §13.2.13
REL_TYPE_OFFICEDOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
CT_EOT = "application/x-fontdata"  # ECMA-376 Part 1 §15.2.13


class Report:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, level: str, where: str, msg: str) -> None:
        self.items.append({"level": level, "where": where, "msg": msg})

    def err(self, where, msg):
        self.add("ERROR", where, msg)

    def warn(self, where, msg):
        self.add("WARN", where, msg)

    def info(self, where, msg):
        self.add("INFO", where, msg)

    def ok(self, where, msg):
        self.add("OK", where, msg)

    @property
    def errors(self):
        return [i for i in self.items if i["level"] == "ERROR"]


# ------------------------------------------------------------------------------------------------ sfnt reader
def be16(b, o):
    return (b[o] << 8) | b[o + 1]


def be32(b, o):
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]


def sfnt_sum(data: bytes) -> int:
    pad = (-len(data)) % 4
    d = data + b"\0" * pad
    total = 0
    for i in range(0, len(d), 4):
        total = (total + be32(d, i)) & 0xFFFFFFFF
    return total


def read_sfnt(font: bytes) -> dict:
    """Minimal OpenType reader (OpenType spec 'Organization of an OpenType Font', 'OS/2', 'head', 'name')."""
    tag = font[:4]
    if tag not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
        raise ValueError(f"not a single sfnt font: {tag!r}")
    num = be16(font, 4)
    tables = {}
    for i in range(num):
        o = 12 + 16 * i
        t = font[o:o + 4].decode("latin-1")
        tables[t] = (be32(font, o + 4), be32(font, o + 8), be32(font, o + 12))  # checksum, offset, length
    out = {"sfntVersion": tag, "tables": sorted(tables), "numTables": num}
    # table checksums
    bad = []
    for t, (cs, off, ln) in tables.items():
        data = bytearray(font[off:off + ln])
        if t == "head":
            data[8:12] = b"\0\0\0\0"
        if sfnt_sum(bytes(data)) != cs:
            bad.append(t)
    out["badTableChecksums"] = bad
    # whole-font checkSumAdjustment
    h_off = tables["head"][1]
    csa = be32(font, h_off + 8)
    zeroed = bytearray(font)
    zeroed[h_off + 8:h_off + 12] = b"\0\0\0\0"
    out["head.checkSumAdjustment"] = csa
    out["head.magic"] = be32(font, h_off + 12)
    out["computedCheckSumAdjustment"] = (0xB1B0AFBA - sfnt_sum(bytes(zeroed))) & 0xFFFFFFFF
    # OS/2
    o = tables["OS/2"][1]
    ver = be16(font, o)
    out["OS/2.version"] = ver
    out["usWeightClass"] = be16(font, o + 4)
    out["fsType"] = be16(font, o + 8)
    out["panose"] = bytes(font[o + 32:o + 42])
    out["ulUnicodeRange"] = tuple(be32(font, o + 42 + 4 * k) for k in range(4))
    out["fsSelection"] = be16(font, o + 62)
    out["ulCodePageRange"] = (be32(font, o + 78), be32(font, o + 82)) if ver >= 1 else None
    # name
    n = tables["name"][1]
    count, str_off = be16(font, n + 2), be16(font, n + 4)
    names = []
    for i in range(count):
        r = n + 6 + 12 * i
        pid, eid, lid, nid, ln, so = (be16(font, r + 2 * k) for k in range(6))
        raw = font[n + str_off + so:n + str_off + so + ln]
        if pid == 3 or pid == 0:
            s = raw.decode("utf-16-be", "replace")
        elif pid == 1 and eid == 0:
            s = raw.decode("mac_roman", "replace")
        else:
            s = None
        names.append((pid, eid, lid, nid, s))
    out["names"] = names
    out["post.isFixedPitch"] = be32(font, tables["post"][1] + 12) if "post" in tables else None
    return out


def win_name(sf: dict, nid: int, lang=0x0409):
    for pid, eid, lid, n, s in sf["names"]:
        if pid == 3 and eid in (1, 10) and lid == lang and n == nid:
            return s
    return None


def win_family_names(sf: dict) -> list[str]:
    return [s for pid, eid, lid, n, s in sf["names"] if pid == 3 and n == 1 and s]


# ------------------------------------------------------------------------------------------------ EOT parser
# Transcribed from https://www.w3.org/submissions/EOT/ §3.3 (Version 0x00020002). 'L' = unsigned long (4),
# 'S' = unsigned short (2), 'B' = byte, 'B10' = byte[10], ('STR', size_field) = byte[size] UTF-16,
# ('RAW', size_field) = byte[size]. "All values ... with the exception of FontData and EUDCFontData are in Intel
# (little-endian) format."
EOT_V22 = [
    ("EOTSize", "L"), ("FontDataSize", "L"), ("Version", "L"), ("Flags", "L"),
    ("FontPANOSE", "B10"), ("Charset", "B"), ("Italic", "B"), ("Weight", "L"), ("fsType", "S"),
    ("MagicNumber", "S"),
    ("UnicodeRange1", "L"), ("UnicodeRange2", "L"), ("UnicodeRange3", "L"), ("UnicodeRange4", "L"),
    ("CodePageRange1", "L"), ("CodePageRange2", "L"), ("CheckSumAdjustment", "L"),
    ("Reserved1", "L"), ("Reserved2", "L"), ("Reserved3", "L"), ("Reserved4", "L"),
    ("Padding1", "S"), ("FamilyNameSize", "S"), ("FamilyName", ("STR", "FamilyNameSize")),
    ("Padding2", "S"), ("StyleNameSize", "S"), ("StyleName", ("STR", "StyleNameSize")),
    ("Padding3", "S"), ("VersionNameSize", "S"), ("VersionName", ("STR", "VersionNameSize")),
    ("Padding4", "S"), ("FullNameSize", "S"), ("FullName", ("STR", "FullNameSize")),
    ("Padding5", "S"), ("RootStringSize", "S"), ("RootString", ("RAW", "RootStringSize")),
    ("RootStringCheckSum", "L"), ("EUDCCodePage", "L"), ("Padding6", "S"),
    ("SignatureSize", "S"), ("Signature", ("RAW", "SignatureSize")),
    ("EUDCFlags", "L"), ("EUDCFontSize", "L"), ("EUDCFontData", ("RAW", "EUDCFontSize")),
]
SIZES = {"L": 4, "S": 2, "B": 1, "B10": 10}


def parse_eot_indep(data: bytes) -> tuple[dict, list[tuple[str, int, int]]]:
    """Returns (fields, layout) where layout = [(field, offset, size)]. Raises ValueError on truncation."""
    f: dict = {}
    layout = []
    pos = 0
    for name, typ in EOT_V22:
        if isinstance(typ, tuple):
            size = f[typ[1]]
            raw = bytes(data[pos:pos + size])
            if len(raw) != size:
                raise ValueError(f"{name}: truncated")
            f[name + "_raw"] = raw
            f[name] = raw.decode("utf-16-le") if typ[0] == "STR" else raw
        else:
            size = SIZES[typ]
            raw = bytes(data[pos:pos + size])
            if len(raw) != size:
                raise ValueError(f"{name}: truncated")
            f[name] = raw if typ == "B10" else int.from_bytes(raw, "little")
        layout.append((name, pos, size))
        pos += size
        if name == "Version" and f["Version"] != 0x00020002:
            raise ValueError(f"version {f['Version']:#010x} is not 0x00020002 (this checker only reads v2.2)")
    f["_headerLength"] = pos
    f["FontData"] = bytes(data[pos:pos + f["FontDataSize"]])
    return f, layout


def check_eot(where: str, blob: bytes, rep: Report, *, typeface: str, source_ttf: bytes | None) -> dict:
    try:
        f, layout = parse_eot_indep(blob)
    except ValueError as exc:
        rep.err(where, f"EOT parse failed: {exc}")
        return {}
    L = {n: (o, s) for n, o, s in layout}
    # --- structure
    (rep.ok if f["EOTSize"] == len(blob) else rep.err)(where, f"EOTSize {f['EOTSize']} vs part length {len(blob)}")
    hl = f["_headerLength"]
    (rep.ok if hl + f["FontDataSize"] == len(blob) else rep.err)(
        where, f"header {hl} B + FontDataSize {f['FontDataSize']} = {hl + f['FontDataSize']} vs {len(blob)}")
    (rep.ok if f["MagicNumber"] == 0x504C else rep.err)(where, f"MagicNumber {f['MagicNumber']:#06x} @ {L['MagicNumber'][0]}")
    (rep.ok if L["MagicNumber"][0] == 34 and L["Padding1"][0] == 80 else rep.err)(
        where, f"fixed-part offsets: MagicNumber @{L['MagicNumber'][0]} (W3C: 34), Padding1 @{L['Padding1'][0]} (W3C: 80)")
    for n in ("Reserved1", "Reserved2", "Reserved3", "Reserved4", "Padding1", "Padding2", "Padding3", "Padding4",
              "Padding5", "Padding6"):
        if f[n] != 0:
            rep.err(where, f"{n} = {f[n]:#x}, W3C: must be 0")
    rep.ok(where, "Reserved1-4 and Padding1-6 are all 0") if all(
        f[n] == 0 for n in ("Reserved1", "Reserved2", "Reserved3", "Reserved4", "Padding1", "Padding2", "Padding3",
                            "Padding4", "Padding5", "Padding6")) else None
    for n in ("FamilyNameSize", "StyleNameSize", "VersionNameSize", "FullNameSize", "RootStringSize"):
        if f[n] % 2:
            rep.err(where, f"{n} {f[n]} is odd (UTF-16 needs even; libeot returns EOT_BOGUS_STRING_SIZE)")
        if f[n] > 1000 and n != "RootStringSize":
            rep.warn(where, f"{n} {f[n]} > 1000: Apache POI FontHeader refuses names > 1000 bytes")
    (rep.ok if f["Flags"] == 0 else rep.info)(where, f"Flags {f['Flags']:#x} (0 = raw: no subset/MTX/XOR)")
    rsc = (sum(f["RootString_raw"]) ^ 0x50475342) & 0xFFFFFFFF
    (rep.ok if f["RootStringCheckSum"] == rsc else rep.err)(
        where, f"RootStringCheckSum {f['RootStringCheckSum']:#010x} vs computed {rsc:#010x} (RootStringSize {f['RootStringSize']})")
    (rep.ok if f["SignatureSize"] == 0 else rep.warn)(where, f"SignatureSize {f['SignatureSize']} (W3C: reserved, 0)")
    (rep.ok if f["EUDCFontSize"] == 0 and f["EUDCFlags"] == 0 else rep.warn)(
        where, f"EUDCFlags {f['EUDCFlags']:#x}, EUDCFontSize {f['EUDCFontSize']}")
    rep.info(where, f"Charset {f['Charset']} Italic {f['Italic']:#x} EUDCCodePage {f['EUDCCodePage']} "
                    f"Family {f['FamilyName']!r} Style {f['StyleName']!r} Full {f['FullName']!r}")
    if any(s.endswith("\0") for s in (f["FamilyName"], f["StyleName"], f["VersionName"], f["FullName"])):
        rep.info(where, "some names carry a UTF-16 NUL terminator")
    # --- payload vs source
    payload = f["FontData"]
    if f["Flags"] & 0x10000000:
        payload = bytes(b ^ 0x50 for b in payload)
    if f["Flags"] & 0x4:
        rep.info(where, "MTX payload: not decoded by this checker")
        return f
    if source_ttf is not None:
        (rep.ok if payload == source_ttf else rep.err)(where, f"FontData byte-identical to source TTF ({len(source_ttf)} B)")
    try:
        sf = read_sfnt(payload)
    except Exception as exc:  # noqa: BLE001
        rep.err(where, f"FontData is not a readable sfnt: {exc}")
        return f
    # --- header vs font (W3C field definitions)
    exp = {
        "FontPANOSE": sf["panose"],
        "Italic": 0x01 if sf["fsSelection"] & 1 else 0x00,
        "Weight": sf["usWeightClass"],
        "fsType": sf["fsType"],
        "UnicodeRange1": sf["ulUnicodeRange"][0], "UnicodeRange2": sf["ulUnicodeRange"][1],
        "UnicodeRange3": sf["ulUnicodeRange"][2], "UnicodeRange4": sf["ulUnicodeRange"][3],
        "CheckSumAdjustment": sf["head.checkSumAdjustment"],
    }
    if sf["ulCodePageRange"] is not None:
        exp["CodePageRange1"], exp["CodePageRange2"] = sf["ulCodePageRange"]
    mism = [f"{k}: header {f[k]!r} != font {v!r}" for k, v in exp.items() if f[k] != v]
    (rep.ok if not mism else rep.err)(where, "header fields == font's OS/2/head values" + (": " + "; ".join(mism) if mism else
                                      f" (weight {f['Weight']}, fsType {f['fsType']:#06x}, italic {f['Italic']})"))
    fam = f["FamilyName"].rstrip("\0")
    (rep.ok if fam == typeface else rep.err)(where, f"EOT FamilyName {fam!r} vs <p:font typeface> {typeface!r}")
    (rep.ok if fam in win_family_names(sf) else rep.err)(where, f"EOT FamilyName among the font's Windows name-ID-1 strings {win_family_names(sf)!r}")
    en = {k: win_name(sf, k) for k in (1, 2, 4, 5)}
    if fam != en[1]:
        rep.warn(where, f"FamilyName {fam!r} is not the English name ID 1 {en[1]!r} (W3C says English)")
    for fld, nid in (("StyleName", 2), ("VersionName", 5), ("FullName", 4)):
        v = f[fld].rstrip("\0")
        (rep.ok if v == en[nid] else rep.err)(where, f"{fld} {v!r} vs English name ID {nid} {en[nid]!r}")
    (rep.ok if not sf["badTableChecksums"] else rep.warn)(where, f"font table checksums bad: {sf['badTableChecksums']}")
    (rep.ok if sf["computedCheckSumAdjustment"] == sf["head.checkSumAdjustment"] else rep.warn)(
        where, f"font checkSumAdjustment stored {sf['head.checkSumAdjustment']:#010x} computed {sf['computedCheckSumAdjustment']:#010x}")
    (rep.ok if sf["head.magic"] == 0x5F0F3CF5 else rep.err)(where, f"head.magicNumber {sf['head.magic']:#x}")
    fs = sf["fsType"]
    lvl = fs & 0xF
    if fs & 0x200:
        rep.err(where, f"fsType {fs:#06x}: bitmap embedding only")
    elif lvl == 0 or lvl & 0x8:
        rep.ok(where, f"fsType {fs:#06x}: installable/editable (document stays editable)")
    elif lvl & 0x4:
        rep.err(where, f"fsType {fs:#06x}: preview&print -> read-only document")
    else:
        rep.err(where, f"fsType {fs:#06x}: restricted")
    kinds = set(sf["tables"])
    if "fvar" in kinds:
        rep.err(where, "variable font (fvar) embedded")
    if "glyf" not in kinds:
        rep.err(where, "no glyf table (CFF or bitmap) embedded")
    f["_sfnt"] = sf
    return f


# ------------------------------------------------------------------------------------------------ package
def ct_sequence_from_xsd() -> list[str]:
    x = etree.parse(str(XSD_DIR / "pml.xsd"))
    xs = "{http://www.w3.org/2001/XMLSchema}"
    ct = x.find(f"{xs}complexType[@name='CT_Presentation']")
    return [e.get("name") for e in ct.find(f"{xs}sequence").findall(f"{xs}element")]


def resolve(src_part: str, target: str) -> str:
    if target.startswith("/"):
        return target[1:]
    return posixpath.normpath(posixpath.join(posixpath.dirname(src_part), target))


def rels_name(part: str) -> str:
    d, b = posixpath.split(part)
    return posixpath.join(d, "_rels", b + ".rels")


def check_package(path: str, rep: Report, font_sources: dict[tuple[str, str], bytes]) -> dict:
    W = Path(path).name
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    names = [i.filename for i in infos]
    # --- ZIP level
    lower = [n.lower() for n in names]
    (rep.ok if len(set(lower)) == len(lower) else rep.err)(W, "zip item names unique (case-insensitive, OPC)")
    (rep.ok if names and names[0] == "[Content_Types].xml" else rep.warn)(W, f"first zip item {names[0]!r}")
    for i in infos:
        if i.filename.endswith("/"):
            rep.warn(W, f"directory entry {i.filename!r}")
        if i.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            rep.err(W, f"{i.filename}: compression method {i.compress_type}")
        if i.flag_bits & 0x1:
            rep.err(W, f"{i.filename}: encrypted")
        data = z.read(i)
        if zlib.crc32(data) & 0xFFFFFFFF != i.CRC:
            rep.err(W, f"{i.filename}: CRC mismatch")
        if not re.fullmatch(r"[A-Za-z0-9._\-/\[\]]+", i.filename):
            rep.warn(W, f"unusual part name {i.filename!r}")
    parts = {n: z.read(n) for n in names if not n.endswith("/")}
    # --- content types
    ct = etree.fromstring(parts["[Content_Types].xml"])
    defaults: dict[str, list[str]] = {}
    for d in ct.findall(f"{{{NS['ct']}}}Default"):
        defaults.setdefault(d.get("Extension").lower(), []).append(d.get("ContentType"))
    overrides: dict[str, list[str]] = {}
    for o in ct.findall(f"{{{NS['ct']}}}Override"):
        overrides.setdefault(o.get("PartName").lower(), []).append(o.get("ContentType"))
    for k, v in list(defaults.items()) + list(overrides.items()):
        if len(v) > 1:
            rep.err(W, f"content type declared twice for {k!r}: {v}")
    for o in overrides:
        if o.lstrip("/") not in {n.lower() for n in parts}:
            rep.warn(W, f"Override for a missing part {o}")

    def ctype(part: str):
        o = overrides.get("/" + part.lower())
        if o:
            return o[0]
        base = posixpath.basename(part)
        ext = base.rsplit(".", 1)[1].lower() if "." in base else ""  # OPC: ".rels" has extension "rels"
        d = defaults.get(ext)
        return d[0] if d else None

    missing = [n for n in parts if n != "[Content_Types].xml" and ctype(n) is None]
    (rep.ok if not missing else rep.err)(W, f"every part has a content type (missing: {missing})")
    (rep.ok if defaults.get("fntdata") == [CT_EOT] else rep.warn)(W, f"Default fntdata -> {defaults.get('fntdata')}")
    # --- main part
    root_rels = etree.fromstring(parts["_rels/.rels"])
    main = [r for r in root_rels if r.get("Type") == REL_TYPE_OFFICEDOC]
    if len(main) != 1:
        rep.err(W, f"{len(main)} officeDocument relationships")
        return {}
    pres_part = resolve("", main[0].get("Target"))
    pres = etree.fromstring(parts[pres_part])
    prels_part = rels_name(pres_part)
    prels = etree.fromstring(parts[prels_part]) if prels_part in parts else None
    rels = {}
    for r in (prels if prels is not None else []):
        if r.get("Id") in rels:
            rep.err(W, f"duplicate relationship Id {r.get('Id')}")
        rels[r.get("Id")] = r
    # --- element order (from pml.xsd, not from the tool)
    seq = ct_sequence_from_xsd()
    kids = [etree.QName(c).localname for c in pres if isinstance(c.tag, str) and etree.QName(c).namespace == NS["p"]]
    idx = [seq.index(k) for k in kids if k in seq]
    (rep.ok if idx == sorted(idx) else rep.err)(W, f"p:presentation children in CT_Presentation order: {kids}")
    # --- schema validation
    try:
        schema = etree.XMLSchema(etree.parse(str(XSD_DIR / "pml.xsd")))
        v = schema.validate(pres)
        (rep.ok if v else rep.err)(W, "presentation.xml valid against ECMA-376 transitional pml.xsd"
                                   + ("" if v else f": {schema.error_log.last_error}"))
    except Exception as exc:  # noqa: BLE001
        rep.warn(W, f"schema validation not run: {exc}")
    # --- attributes
    ett = pres.get("embedTrueTypeFonts")
    ssf = pres.get("saveSubsetFonts")
    lst = pres.find(f"{{{NS['p']}}}embeddedFontLst")
    if lst is not None:
        (rep.ok if ett in ("1", "true") else rep.warn)(W, f"embedTrueTypeFonts={ett!r}")
        (rep.ok if ssf in (None, "0", "false") else rep.warn)(W, f"saveSubsetFonts={ssf!r} (true = next PowerPoint save subsets)")
    # --- runs: typefaces used + their attributes
    used: dict[str, list[dict]] = {}
    for n, data in parts.items():
        if not n.endswith(".xml") or n == pres_part or "/_rels/" in n or n.startswith(("docProps/", "[")):
            continue
        try:
            x = etree.fromstring(data)
        except etree.XMLSyntaxError as exc:
            rep.err(W, f"{n}: not well-formed: {exc}")
            continue
        for el in x.iter(f"{{{NS['a']}}}latin", f"{{{NS['a']}}}ea", f"{{{NS['a']}}}cs", f"{{{NS['a']}}}sym",
                         f"{{{NS['a']}}}buFont", f"{{{NS['a']}}}font"):
            tf = el.get("typeface")
            if tf:
                used.setdefault(tf, []).append({"part": n, "el": etree.QName(el).localname,
                                                **{k: el.get(k) for k in ("charset", "pitchFamily", "panose") if el.get(k) is not None}})
    result = {"presPart": pres_part, "fonts": []}
    if lst is None:
        rep.info(W, "no p:embeddedFontLst")
        font_rels = [rid for rid, r in rels.items() if r.get("Type") == REL_TYPE_FONT]
        (rep.ok if not font_rels else rep.err)(W, f"every font relationship is referenced by an embeddedFont slot (implicit: {font_rels})")
        orphan = [n for n in parts if ctype(n) == CT_EOT]
        (rep.ok if not orphan else rep.warn)(W, f"font parts without an embeddedFontLst: {orphan}")
        return result
    referenced_rids: list[str] = []
    seen_tf = set()
    for ef in lst.findall(f"{{{NS['p']}}}embeddedFont"):
        ch = [c for c in ef if isinstance(c.tag, str)]
        names_ = [etree.QName(c).localname for c in ch]
        if not names_ or names_[0] != "font":
            rep.err(W, f"embeddedFont without leading p:font: {names_}")
            continue
        fnt = ch[0]
        tf = fnt.get("typeface")
        where = f"{W}:{tf}"
        if tf.lower() in seen_tf:
            rep.err(where, "typeface not unique ([MS-OI29500] 2.1.1100 a)")
        seen_tf.add(tf.lower())
        (rep.ok if tf in used else rep.err)(where, f"typeface used by the deck ([MS-OI29500] 2.1.1100 b): {len(used.get(tf, []))} references")
        cs = fnt.get("charset")
        pf = fnt.get("pitchFamily")
        pn = fnt.get("panose")
        rep.info(where, f"p:font charset={cs} pitchFamily={pf} panose={pn}")
        # run attribute consistency (ECMA-376 Part 1 §19.2.1.13 'ambiguities ... application-dependent')
        conflicts = []
        for u in used.get(tf, []):
            for k, v in (("charset", cs), ("pitchFamily", pf), ("panose", pn)):
                if k in u and v is not None and str(u[k]).upper() != str(v).upper():
                    conflicts.append(f"{u['part']} {u['el']} {k}={u[k]} vs {v}")
        (rep.ok if not conflicts else rep.warn)(where, "run font attributes agree with p:font" + (f": {conflicts[:5]}" if conflicts else ""))
        slots = names_[1:]
        order = ["regular", "bold", "italic", "boldItalic"]
        if [s for s in slots if s in order] != sorted([s for s in slots if s in order], key=order.index) or len(set(slots)) != len(slots):
            rep.err(where, f"slot order {slots}")
        info = {"typeface": tf, "attrs": dict(fnt.attrib), "slots": {}}
        for sl in ch[1:]:
            slot = etree.QName(sl).localname
            rid = sl.get(f"{{{NS['r']}}}id")
            referenced_rids.append(rid)
            rel = rels.get(rid)
            w2 = f"{where}/{slot}"
            if rel is None:
                rep.err(w2, f"r:id {rid} not in {prels_part}")
                continue
            (rep.ok if rel.get("Type") == REL_TYPE_FONT else rep.err)(w2, f"rel Type {rel.get('Type')}")
            if rel.get("TargetMode") == "External":
                rep.err(w2, "TargetMode External (ECMA §15.2.13: must be Internal)")
            target = resolve(pres_part, rel.get("Target"))
            if target not in parts:
                rep.err(w2, f"target {target} missing")
                continue
            (rep.ok if ctype(target) == CT_EOT else rep.err)(w2, f"{target} content type {ctype(target)}")
            if rels_name(target) in parts:
                rep.err(w2, "font part has its own relationships (ECMA §15.2.13 forbids)")
            src = font_sources.get((tf, slot))
            f = check_eot(w2, parts[target], rep, typeface=tf, source_ttf=src)
            if f:
                # p:font / EOT header consistency (ECMA §19.2.1.13)
                if cs is not None:
                    xml_cs = int(cs) & 0xFF
                    (rep.ok if xml_cs == f["Charset"] else rep.warn)(
                        w2, f"EOT Charset {f['Charset']} vs p:font charset {cs} (= {xml_cs} unsigned)")
                sf = f.get("_sfnt")
                if sf:
                    if pn is not None and slot == (["regular"] + slots)[0 if "regular" in slots else 1] and pn.upper() != sf["panose"].hex().upper():
                        rep.warn(w2, f"p:font panose {pn} != font PANOSE {sf['panose'].hex().upper()}")
                    bold_bit, it_bit = bool(sf["fsSelection"] & 0x20), bool(sf["fsSelection"] & 0x01)
                    want_b, want_i = slot in ("bold", "boldItalic"), slot in ("italic", "boldItalic")
                    if want_i != it_bit:
                        rep.warn(w2, f"slot {slot} but fsSelection.ITALIC={it_bit}")
                    if want_b and not (bold_bit or sf["usWeightClass"] >= 600):
                        rep.warn(w2, f"bold slot but weight {sf['usWeightClass']} / BOLD bit {bold_bit}")
                    if not want_b and bold_bit:
                        rep.warn(w2, f"slot {slot} but fsSelection.BOLD set")
                    info["slots"][slot] = {"part": target, "weight": sf["usWeightClass"], "fsType": sf["fsType"],
                                           "eotCharset": f["Charset"], "family": f["FamilyName"]}
        result["fonts"].append(info)
    # explicit relationships only ([MS-OI29500] 2.1.18 c)
    font_rels = [rid for rid, r in rels.items() if r.get("Type") == REL_TYPE_FONT]
    implicit = [rid for rid in font_rels if rid not in referenced_rids]
    (rep.ok if not implicit else rep.err)(W, f"every font relationship is referenced by an embeddedFont slot (implicit: {implicit})")
    fparts = [n for n in parts if ctype(n) == CT_EOT]
    targeted = {resolve(pres_part, rels[r].get("Target")) for r in font_rels}
    orphan = [p for p in fparts if p not in targeted]
    (rep.ok if not orphan else rep.err)(W, f"no orphan font parts ({orphan})")
    return result


def main(argv=None) -> int:
    sys.path.insert(0, str(HERE.parent))
    import pdeathsig  # tools/pdeathsig.py: die with the parent (deck.mjs); no font code is shared
    pdeathsig.arm()
    ap = argparse.ArgumentParser()
    ap.add_argument("pptx")
    ap.add_argument("--font", action="append", default=[], metavar="TYPEFACE:SLOT:TTF")
    ap.add_argument("--json")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    srcs = {}
    for spec in a.font:
        tf, slot, fn = spec.rsplit(":", 2)
        srcs[(tf, slot)] = Path(fn).read_bytes()
    rep = Report()
    res = check_package(a.pptx, rep, srcs)
    if not a.quiet:
        for i in rep.items:
            print(f"{i['level']:5} {i['where']}: {i['msg']}")
    n = {lvl: sum(1 for i in rep.items if i["level"] == lvl) for lvl in ("OK", "INFO", "WARN", "ERROR")}
    print(f"SUMMARY {Path(a.pptx).name}: {n}")
    if a.json:
        Path(a.json).write_text(json.dumps({"summary": n, "items": rep.items, "result": res}, ensure_ascii=False,
                                           indent=1, default=str), encoding="utf-8")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
