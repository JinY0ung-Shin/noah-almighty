#!/usr/bin/env python3
"""Embedded OpenType (EOT) writer + parser for PowerPoint ``.fntdata`` parts.

PowerPoint stores every embedded font as an EOT structure in a part with content type
``application/x-fontdata`` ([MS-OI29500] 2.1.32; ECMA-376 Part 1 §15.2.13). The layout implemented here is the
W3C Member Submission "Embedded OpenType (EOT) File Format" (https://www.w3.org/submissions/EOT/), version
0x00020002, which is the version every PowerPoint 2010+ part we inspected uses.

What :func:`ttf_to_eot` writes (see docs/research/font-embedding.md for the evidence behind each choice):

* Version 0x00020002, **Flags = 0**: FontData is the caller's TrueType file byte-for-byte — not MicroType-Express
  compressed (TTEMBED_TTCOMPRESSED 0x4), not XOR-obfuscated (TTEMBED_XORENCRYPTDATA 0x10000000), not subset
  (TTEMBED_SUBSET 0x1). This is the default output of Windows' own ``TTEmbedFont`` (``TTEMBED_RAW``), the layout
  LibreOffice's PPTX export writes, and the layout Canva's PPTX export writes (sfntly ``EOTWriter(false)``).
* FontPANOSE, Weight, fsType, UnicodeRange1-4, CodePageRange1-2 from ``OS/2``; Italic = OS/2.fsSelection bit 0
  (0x01 per the spec); CheckSumAdjustment from ``head``; Charset = DEFAULT_CHARSET (0x01, "no preference").
* FamilyName = the typeface the deck uses (must be one of the font's own name-ID-1 strings; the English one by
  default), StyleName / VersionName / FullName = English name IDs 2 / 5 / 4, UTF-16LE, no terminator.
* RootString empty, RootStringCheckSum = 0 ^ 0x50475342, EUDCCodePage 0, no signature, no EUDC font.

The parser (:func:`parse_eot`) reads all three EOT versions and every flag combination, validates the header
strictly, and returns the (XOR-decoded) FontData; MicroType Express payloads are reported, not decoded.

CLI::

    python tools/eot.py encode FONT.ttf OUT.fntdata [--family NAME]
    python tools/eot.py dump FILE.fntdata|DECK.pptx [...]        # parse + verify every header
    python tools/eot.py extract FILE.fntdata OUT.ttf             # uncompressed payload only
"""
from __future__ import annotations

import argparse
import io
import json
import struct
import sys
import zipfile
from dataclasses import asdict, dataclass, field

from fontTools.ttLib import TTFont

# --- constants (W3C EOT §3, §4.2; t2embapi.h) ---------------------------------------------------------------
EOT_VERSION_1_0 = 0x00010000
EOT_VERSION_2_1 = 0x00020001
EOT_VERSION_2_2 = 0x00020002
EOT_VERSIONS = (EOT_VERSION_1_0, EOT_VERSION_2_1, EOT_VERSION_2_2)
EOT_MAGIC = 0x504C

TTEMBED_SUBSET = 0x00000001
TTEMBED_TTCOMPRESSED = 0x00000004
TTEMBED_FAILIFVARIATIONSIMULATED = 0x00000010
TTEMBED_EMBEDEUDC = 0x00000020
TTEMBED_VALIDATIONTESTS = 0x00000040
TTEMBED_WEBOBJECT = 0x00000080
TTEMBED_XORENCRYPTDATA = 0x10000000
KNOWN_FLAGS = (TTEMBED_SUBSET | TTEMBED_TTCOMPRESSED | TTEMBED_FAILIFVARIATIONSIMULATED | TTEMBED_EMBEDEUDC
               | TTEMBED_VALIDATIONTESTS | TTEMBED_WEBOBJECT | TTEMBED_XORENCRYPTDATA)
FLAG_NAMES = {
    TTEMBED_SUBSET: "SUBSET", TTEMBED_TTCOMPRESSED: "TTCOMPRESSED(MTX)",
    TTEMBED_FAILIFVARIATIONSIMULATED: "FAILIFVARIATIONSIMULATED", TTEMBED_EMBEDEUDC: "EMBEDEUDC",
    TTEMBED_VALIDATIONTESTS: "VALIDATIONTESTS", TTEMBED_WEBOBJECT: "WEBOBJECT",
    TTEMBED_XORENCRYPTDATA: "XORENCRYPTDATA",
}
XOR_KEY = 0x50
ROOT_STRING_XOR_KEY = 0x50475342
DEFAULT_CHARSET = 0x01

# OS/2.fsType bits (OpenType spec OS/2 table; W3C EOT §4.1)
FSTYPE_RESTRICTED = 0x0002
FSTYPE_PREVIEW_PRINT = 0x0004
FSTYPE_EDITABLE = 0x0008
FSTYPE_NO_SUBSETTING = 0x0100
FSTYPE_BITMAP_ONLY = 0x0200

# GDI LOGFONT charsets, selected from OS/2.ulCodePageRange1 bits (OpenType spec, "ulCodePageRange").
# Order = preference when a font covers several (Korean first: the PoC's users are Korean).
_CODEPAGE_BIT_TO_CHARSET = (
    (19, 129),  # 949 Korean Wansung      -> HANGUL_CHARSET 0x81
    (21, 130),  # 1361 Korean Johab       -> JOHAB_CHARSET 0x82
    (17, 128),  # 932 JIS/Japan           -> SHIFTJIS_CHARSET 0x80
    (18, 134),  # 936 Chinese Simplified  -> GB2312_CHARSET 0x86
    (20, 136),  # 950 Chinese Traditional -> CHINESEBIG5_CHARSET 0x88
    (0, 0),     # 1252 Latin 1            -> ANSI_CHARSET 0x00
)

# GDI pitch-and-family (wingdi.h), as used by the XML pitchFamily attribute ([MS-OI29500] 2.1.1397 note c).
FIXED_PITCH, VARIABLE_PITCH = 0x01, 0x02
FF_DONTCARE, FF_ROMAN, FF_SWISS, FF_MODERN, FF_SCRIPT, FF_DECORATIVE = 0x00, 0x10, 0x20, 0x30, 0x40, 0x50

WIN_ENGLISH = (3, 1, 0x0409)


class EOTError(ValueError):
    """Malformed EOT data or a font that cannot be wrapped."""


class EmbeddingPermissionError(EOTError):
    """The font's OS/2.fsType does not allow the requested (editable) embedding."""


# --- font facts ----------------------------------------------------------------------------------------------
@dataclass
class FontFacts:
    """Everything the EOT header and the <p:font> element need, read from one sfnt font file."""

    sfnt_version: str                 # "00010000" / "true" (TrueType), "OTTO" (CFF), "ttcf" (collection)
    is_truetype: bool
    is_cff: bool
    is_collection: bool
    is_variable: bool
    num_glyphs: int
    family_en: str                    # name ID 1, Windows English (the legacy/GDI family)
    subfamily_en: str                 # name ID 2
    full_name_en: str                 # name ID 4
    version_en: str                   # name ID 5
    typographic_family_en: str | None  # name ID 16 (None when absent)
    family_names: list[str]           # Windows name-ID-1 strings, all languages (Mac ones only if no Windows ones)
    weight: int                       # OS/2.usWeightClass
    italic: bool                      # OS/2.fsSelection bit 0
    bold: bool                        # OS/2.fsSelection bit 5
    fs_type: int
    panose: bytes
    unicode_ranges: tuple[int, int, int, int]
    codepage_ranges: tuple[int, int]
    checksum_adjustment: int
    is_fixed_pitch: bool

    @property
    def panose_hex(self) -> str:
        return self.panose.hex().upper()

    def gdi_charset(self) -> int:
        """GDI charset for the XML ``charset`` attribute (unsigned 0..255), from OS/2 code-page bits."""
        cp1 = self.codepage_ranges[0]
        for bit, charset in _CODEPAGE_BIT_TO_CHARSET:
            if cp1 & (1 << bit):
                return charset
        return DEFAULT_CHARSET

    def gdi_pitch_family(self) -> int:
        """Best-effort GDI lfPitchAndFamily, following Wine's GDI emulation (dlls/win32u/freetype.c,
        get_text_metrics: PANOSE family/serif/proportion); see the doc §4. Real GDI differs for some CJK fonts
        (it reports 50 = MODERN|VARIABLE for Malgun Gothic where this rule gives 34).

        Office uses it only to pick a substitute when the font is unavailable ([MS-OI29500] 2.1.1397 note c).
        """
        p = self.panose
        fixed = self.is_fixed_pitch or p[3] == 9  # bProportion 9 = Monospaced
        pitch = FIXED_PITCH if fixed else VARIABLE_PITCH
        if p[0] == 3:            # Latin Hand Written
            family = FF_SCRIPT
        elif p[0] == 4:          # Latin Decorative
            family = FF_DECORATIVE
        elif fixed:
            family = FF_MODERN
        elif 2 <= p[1] <= 10:    # cove .. triangle serif styles
            family = FF_ROMAN
        elif 11 <= p[1] <= 15:   # normal/obtuse/perpendicular sans, flared, rounded
            family = FF_SWISS
        else:
            family = FF_DONTCARE
        return family | pitch


def _name(font: TTFont, name_id: int, *, english_only: bool = False) -> str | None:
    table = font["name"]
    rec = table.getName(name_id, *WIN_ENGLISH)
    if rec is None and not english_only:
        for r in table.names:  # any Windows Unicode record, then Mac Roman English
            if r.nameID == name_id and r.platformID == 3 and r.platEncID in (0, 1, 10):
                rec = r
                break
        if rec is None:
            rec = table.getName(name_id, 1, 0, 0)
    return rec.toUnicode() if rec is not None else None


def font_facts(font_bytes: bytes) -> FontFacts:
    """Read the embedding-relevant facts of a single sfnt font (TTF/OTF). Raises EOTError on junk."""
    tag = font_bytes[:4]
    if tag == b"ttcf":
        raise EOTError("TrueType Collections (.ttc) cannot be embedded (ECMA-376 Part 1 §15.2.13); "
                       "extract the single face first")
    if tag not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
        raise EOTError(f"not an sfnt font (first bytes {tag.hex()})")
    try:
        font = TTFont(io.BytesIO(font_bytes), lazy=True)
    except Exception as exc:  # fontTools raises a variety of errors on corrupt input
        raise EOTError(f"fontTools cannot parse the font: {exc}") from exc
    for required in ("head", "name", "OS/2", "maxp", "cmap"):
        if required not in font:
            raise EOTError(f"font has no '{required}' table")
    os2 = font["OS/2"]
    head = font["head"]
    p = os2.panose
    panose = bytes([p.bFamilyType, p.bSerifStyle, p.bWeight, p.bProportion, p.bContrast, p.bStrokeVariation,
                    p.bArmStyle, p.bLetterForm, p.bMidline, p.bXHeight])
    # Family names Windows (GDI/DirectWrite) knows the font by: Windows-platform name ID 1 records in every
    # language; Macintosh records are used only when the font has no Windows ones.
    family_names: list[str] = []
    for platform in (3, 1):
        for r in font["name"].names:
            if r.nameID == 1 and r.platformID == platform:
                try:
                    s = r.toUnicode()
                except UnicodeDecodeError:
                    continue
                if s and s not in family_names:
                    family_names.append(s)
        if family_names:
            break
    family_en = _name(font, 1)
    if not family_en:
        raise EOTError("font has no family name (name ID 1)")
    cp = (getattr(os2, "ulCodePageRange1", 0), getattr(os2, "ulCodePageRange2", 0)) if os2.version >= 1 \
        else (0x00000001, 0x00000000)  # sfntly's fallback for OS/2 v0 fonts
    post = font["post"] if "post" in font else None
    return FontFacts(
        sfnt_version=tag.hex() if tag == b"\x00\x01\x00\x00" else tag.decode("latin-1"),
        is_truetype=tag in (b"\x00\x01\x00\x00", b"true") and "glyf" in font,
        is_cff=tag == b"OTTO" or "CFF " in font or "CFF2" in font,
        is_collection=False,
        is_variable="fvar" in font,
        num_glyphs=font["maxp"].numGlyphs,
        family_en=family_en,
        subfamily_en=_name(font, 2) or "",
        full_name_en=_name(font, 4) or "",
        version_en=_name(font, 5) or "",
        typographic_family_en=_name(font, 16, english_only=True),
        family_names=family_names,
        weight=int(os2.usWeightClass),
        italic=bool(os2.fsSelection & 0x01),
        bold=bool(os2.fsSelection & 0x20),
        fs_type=int(os2.fsType),
        panose=panose,
        unicode_ranges=(os2.ulUnicodeRange1, os2.ulUnicodeRange2, os2.ulUnicodeRange3, os2.ulUnicodeRange4),
        codepage_ranges=cp,
        checksum_adjustment=int(head.checkSumAdjustment),
        is_fixed_pitch=bool(post.isFixedPitch) if post is not None else False,
    )


def describe_fs_type(fs_type: int) -> str:
    level = fs_type & 0x000F
    if level == 0:
        s = "installable (0x0000)"
    elif level & FSTYPE_EDITABLE:
        s = "editable (0x0008)"
    elif level & FSTYPE_PREVIEW_PRINT:
        s = "preview&print (0x0004)"
    elif level & FSTYPE_RESTRICTED:
        s = "restricted-license (0x0002)"
    else:
        s = f"unknown level {level:#x}"
    if fs_type & FSTYPE_NO_SUBSETTING:
        s += " + no-subsetting (0x0100)"
    if fs_type & FSTYPE_BITMAP_ONLY:
        s += " + bitmap-only (0x0200)"
    return s


def check_editable_embedding(facts: FontFacts, *, allow_preview_print: bool = False) -> None:
    """Enforce the OS/2.fsType licence bits for an *editable* PowerPoint embedding.

    Per W3C EOT §4.1 / t2embed TTLoadEmbeddedFont, when several of bits 0-3 are set the least restrictive
    one applies. Installable (no bit) and Editable (0x0008) allow opening read/write; Preview&Print (0x0004)
    forces read-only documents; Restricted (0x0002 alone) forbids embedding; Bitmap-only (0x0200) forbids
    embedding outlines. No-subsetting (0x0100) is fine because we always embed the full font.
    """
    fs = facts.fs_type
    if fs & FSTYPE_BITMAP_ONLY:
        raise EmbeddingPermissionError(
            f"{facts.full_name_en}: fsType {fs:#06x} is bitmap-embedding-only; outline embedding not permitted")
    level = fs & 0x000F
    if level == 0 or level & FSTYPE_EDITABLE:
        return
    if level & FSTYPE_PREVIEW_PRINT:
        if allow_preview_print:
            return
        raise EmbeddingPermissionError(
            f"{facts.full_name_en}: fsType {fs:#06x} is preview&print only — PowerPoint opens such decks "
            "read-only on PCs without the font (not editable)")
    raise EmbeddingPermissionError(
        f"{facts.full_name_en}: fsType {fs:#06x} is restricted-license; embedding is not permitted")


# --- writer --------------------------------------------------------------------------------------------------
def _utf16(s: str) -> bytes:
    return s.encode("utf-16-le")


def ttf_to_eot(font_bytes: bytes, *, family_name: str | None = None, charset: int = DEFAULT_CHARSET,
               allow_cff: bool = False, allow_variable: bool = False) -> bytes:
    """Wrap a TrueType font (bytes) into an uncompressed EOT 0x00020002 structure (a PowerPoint .fntdata).

    ``family_name`` is written as the EOT FamilyName; pass the exact ``typeface`` the deck uses. It must be one
    of the font's own name-ID-1 strings (default: the Windows-English one). Permission checks are the caller's
    job (see :func:`check_editable_embedding`); this function only refuses structurally unsuitable fonts.
    """
    facts = font_facts(font_bytes)
    if facts.is_cff and not allow_cff:
        raise EOTError(f"{facts.full_name_en}: CFF-flavoured OpenType is not supported (use a TrueType-outline "
                       "build); libeot cannot decode CFF EOT (LibreOffice tdf#166778)")
    if facts.is_variable and not allow_variable:
        raise EOTError(f"{facts.full_name_en}: variable fonts are not supported — embed static instances "
                       "(PowerPoint shows an embedded variable font as unavailable, LibreOffice tdf#167214)")
    family = facts.family_en if family_name is None else family_name
    if family not in facts.family_names:
        raise EOTError(f"family_name {family!r} is not a name-ID-1 string of this font "
                       f"(has {facts.family_names!r})")
    if not 0 <= charset <= 255:
        raise EOTError(f"charset {charset} out of range")

    names = [_utf16(family), _utf16(facts.subfamily_en), _utf16(facts.version_en), _utf16(facts.full_name_en)]
    for n in names:
        if len(n) > 0xFFFF:
            raise EOTError("name string too long for a USHORT size field")
    body = bytearray()
    body += facts.panose
    body += bytes([charset, 0x01 if facts.italic else 0x00])
    body += struct.pack("<IHH", facts.weight, facts.fs_type, EOT_MAGIC)
    body += struct.pack("<4I", *facts.unicode_ranges)
    body += struct.pack("<2I", *facts.codepage_ranges)
    body += struct.pack("<I", facts.checksum_adjustment)
    body += struct.pack("<4I", 0, 0, 0, 0)                       # Reserved1-4
    for n in names:                                              # Padding1..4 + sizes + strings
        body += struct.pack("<HH", 0, len(n)) + n
    root_string = b""
    body += struct.pack("<HH", 0, len(root_string)) + root_string  # Padding5, RootStringSize, RootString
    body += struct.pack("<II", sum(root_string) ^ ROOT_STRING_XOR_KEY, 0)  # RootStringCheckSum, EUDCCodePage
    body += struct.pack("<HH", 0, 0)                             # Padding6, SignatureSize (no Signature)
    body += struct.pack("<II", 0, 0)                             # EUDCFlags, EUDCFontSize (no EUDC data)
    header_len = 16 + len(body)
    eot_size = header_len + len(font_bytes)
    out = struct.pack("<IIII", eot_size, len(font_bytes), EOT_VERSION_2_2, 0) + bytes(body) + font_bytes
    assert len(out) == eot_size
    return out


# --- parser --------------------------------------------------------------------------------------------------
@dataclass
class EOTHeader:
    eot_size: int
    font_data_size: int
    version: int
    flags: int
    panose: bytes
    charset: int
    italic: int
    weight: int
    fs_type: int
    magic: int
    unicode_ranges: tuple[int, int, int, int]
    codepage_ranges: tuple[int, int]
    checksum_adjustment: int
    reserved: tuple[int, int, int, int]
    family_name: str
    style_name: str
    version_name: str
    full_name: str
    name_sizes: tuple[int, int, int, int]
    root_string: str = ""
    root_string_checksum: int | None = None
    eudc_codepage: int | None = None
    signature_size: int = 0
    eudc_flags: int = 0
    eudc_font_size: int = 0
    header_size: int = 0
    warnings: list[str] = field(default_factory=list)

    def flag_names(self) -> list[str]:
        return [n for bit, n in FLAG_NAMES.items() if self.flags & bit] or ["none (raw)"]

    def to_json(self) -> dict:
        d = asdict(self)
        d["panose"] = self.panose.hex().upper()
        d["version"] = f"{self.version:#010x}"
        d["flags"] = f"{self.flags:#x} " + "|".join(self.flag_names())
        d["fs_type"] = f"{self.fs_type:#06x} {describe_fs_type(self.fs_type)}"
        d["magic"] = f"{self.magic:#06x}"
        for k in ("unicode_ranges", "codepage_ranges"):
            d[k] = [f"{v:#010x}" for v in d[k]]
        d["checksum_adjustment"] = f"{self.checksum_adjustment:#010x}"
        if self.root_string_checksum is not None:
            d["root_string_checksum"] = f"{self.root_string_checksum:#010x}"
        return d


def _decode_name(raw: bytes) -> str:
    if len(raw) % 2:
        raise EOTError("odd-length UTF-16 name string")
    return raw.decode("utf-16-le").rstrip("\x00")


def parse_eot(data: bytes) -> tuple[EOTHeader, bytes]:
    """Parse and strictly validate an EOT structure. Returns (header, FontData with XOR removed).

    FontData stays MicroType-Express-compressed when ``header.flags & TTEMBED_TTCOMPRESSED``.
    Raises EOTError on anything a conforming reader would reject.
    """
    n = len(data)
    if n < 82:
        raise EOTError(f"too short for an EOT header ({n} bytes)")
    eot_size, font_data_size, version, flags = struct.unpack_from("<IIII", data, 0)
    if version not in EOT_VERSIONS:
        raise EOTError(f"unknown EOT version {version:#010x}")
    if eot_size != n:
        raise EOTError(f"EOTSize {eot_size} != data length {n}")
    panose = bytes(data[16:26])
    charset, italic = data[26], data[27]
    weight, fs_type, magic = struct.unpack_from("<IHH", data, 28)
    if magic != EOT_MAGIC:
        raise EOTError(f"bad MagicNumber {magic:#06x}")
    ur = struct.unpack_from("<4I", data, 36)
    cp = struct.unpack_from("<2I", data, 52)
    (csa,) = struct.unpack_from("<I", data, 60)
    reserved = struct.unpack_from("<4I", data, 64)
    warnings: list[str] = []
    if any(reserved):
        warnings.append(f"Reserved fields not zero: {reserved}")
    if flags & ~KNOWN_FLAGS:
        warnings.append(f"unknown flag bits {flags & ~KNOWN_FLAGS:#x}")
    off = 80
    names: list[str] = []
    sizes: list[int] = []
    for label in ("FamilyName", "StyleName", "VersionName", "FullName"):
        if off + 4 > n:
            raise EOTError(f"truncated before {label}")
        pad, size = struct.unpack_from("<HH", data, off)
        if pad:
            warnings.append(f"padding before {label} is {pad:#06x}, must be 0")
        off += 4
        if off + size > n:
            raise EOTError(f"{label} overruns the data")
        names.append(_decode_name(data[off:off + size]))
        sizes.append(size)
        off += size
    hdr = EOTHeader(eot_size, font_data_size, version, flags, panose, charset, italic, weight, fs_type, magic,
                    ur, cp, csa, reserved, *names, name_sizes=tuple(sizes), warnings=warnings)
    if version >= EOT_VERSION_2_1:
        if off + 4 > n:
            raise EOTError("truncated before RootString")
        pad5, root_size = struct.unpack_from("<HH", data, off)
        if pad5:
            warnings.append(f"Padding5 is {pad5:#06x}, must be 0")
        off += 4
        if off + root_size > n:
            raise EOTError("RootString overruns the data")
        root_raw = bytes(data[off:off + root_size])
        hdr.root_string = _decode_name(root_raw) if root_size else ""
        off += root_size
        if version == EOT_VERSION_2_2:
            if off + 16 > n:
                raise EOTError("truncated v2.2 trailer")
            hdr.root_string_checksum, hdr.eudc_codepage = struct.unpack_from("<II", data, off)
            off += 8
            expected = sum(root_raw) ^ ROOT_STRING_XOR_KEY
            if hdr.root_string_checksum != expected:
                raise EOTError(f"RootStringCheckSum {hdr.root_string_checksum:#x} != {expected:#x} "
                               "(font must be treated as tampered, W3C EOT §4.3.2)")
            pad6, hdr.signature_size = struct.unpack_from("<HH", data, off)
            if pad6:
                warnings.append(f"Padding6 is {pad6:#06x}, must be 0")
            off += 4 + hdr.signature_size
            if off + 8 > n:
                raise EOTError("truncated before EUDC fields")
            hdr.eudc_flags, hdr.eudc_font_size = struct.unpack_from("<II", data, off)
            off += 8 + hdr.eudc_font_size
    hdr.header_size = off
    if off + font_data_size != n:
        raise EOTError(f"header ({off}) + FontDataSize ({font_data_size}) != EOTSize ({n})")
    payload = bytes(data[off:off + font_data_size])
    if flags & TTEMBED_XORENCRYPTDATA:
        payload = bytes(b ^ XOR_KEY for b in payload)
    return hdr, payload


def extract_font(data: bytes) -> bytes:
    """Return the sfnt font inside an EOT. Only for non-MTX payloads (flags without TTEMBED_TTCOMPRESSED)."""
    hdr, payload = parse_eot(data)
    if hdr.flags & TTEMBED_TTCOMPRESSED:
        raise EOTError("payload is MicroType Express compressed; use libeot's eot2ttf to decode it")
    return payload


def verify_eot(data: bytes, original_font: bytes | None = None, *, expect_family: str | None = None) -> list[str]:
    """Self-check used by the tests: parse, then cross-check every header field against the embedded font.

    Returns a list of problems (empty = OK). For uncompressed payloads the font is re-parsed with fontTools.
    """
    problems: list[str] = []
    try:
        hdr, payload = parse_eot(data)
    except EOTError as exc:
        return [f"parse: {exc}"]
    problems += [f"warning: {w}" for w in hdr.warnings]
    if hdr.flags & TTEMBED_TTCOMPRESSED:
        return problems + ["note: MTX payload not cross-checked"]
    if original_font is not None and payload != original_font:
        problems.append("FontData differs from the original font bytes")
    try:
        f = font_facts(payload)
    except EOTError as exc:
        return problems + [f"payload: {exc}"]
    checks = {
        "panose": (hdr.panose, f.panose),
        "italic": (hdr.italic, 0x01 if f.italic else 0x00),
        "weight": (hdr.weight, f.weight),
        "fsType": (hdr.fs_type, f.fs_type),
        "unicode_ranges": (tuple(hdr.unicode_ranges), tuple(f.unicode_ranges)),
        "codepage_ranges": (tuple(hdr.codepage_ranges), tuple(f.codepage_ranges)),
        "checksum_adjustment": (hdr.checksum_adjustment, f.checksum_adjustment),
        "style_name": (hdr.style_name, f.subfamily_en),
        "version_name": (hdr.version_name, f.version_en),
        "full_name": (hdr.full_name, f.full_name_en),
    }
    for key, (got, want) in checks.items():
        if got != want:
            problems.append(f"{key}: header {got!r} != font {want!r}")
    if hdr.family_name not in f.family_names:
        problems.append(f"family_name {hdr.family_name!r} not among the font's name-ID-1 strings {f.family_names!r}")
    if expect_family is not None and hdr.family_name != expect_family:
        problems.append(f"family_name {hdr.family_name!r} != expected typeface {expect_family!r}")
    return problems


# --- CLI -----------------------------------------------------------------------------------------------------
def _iter_inputs(paths: list[str]):
    for p in paths:
        if p.lower().endswith((".pptx", ".potx", ".ppsx", ".zip")):
            with zipfile.ZipFile(p) as z:
                for name in z.namelist():
                    if name.lower().endswith(".fntdata"):
                        yield f"{p}:{name}", z.read(name)
        else:
            with open(p, "rb") as fh:
                yield p, fh.read()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("encode", help="TTF -> uncompressed EOT 0x00020002 (.fntdata)")
    e.add_argument("font")
    e.add_argument("out")
    e.add_argument("--family", help="EOT FamilyName (= the deck's typeface); default: English name ID 1")
    d = sub.add_parser("dump", help="parse + verify .fntdata files or every .fntdata inside a .pptx")
    d.add_argument("inputs", nargs="+")
    x = sub.add_parser("extract", help="write the (uncompressed) font inside an EOT")
    x.add_argument("eot")
    x.add_argument("out")
    args = ap.parse_args(argv)

    if args.cmd == "encode":
        with open(args.font, "rb") as fh:
            ttf = fh.read()
        facts = font_facts(ttf)
        check_editable_embedding(facts)
        eot = ttf_to_eot(ttf, family_name=args.family)
        with open(args.out, "wb") as fh:
            fh.write(eot)
        problems = verify_eot(eot, ttf)
        print(f"wrote {args.out}: {len(eot)} bytes; self-check: {'OK' if not problems else problems}")
        return 0 if not problems else 1
    if args.cmd == "dump":
        rc = 0
        for label, blob in _iter_inputs(args.inputs):
            try:
                hdr, _ = parse_eot(blob)
            except EOTError as exc:
                print(json.dumps({"input": label, "error": str(exc)}, ensure_ascii=False))
                rc = 1
                continue
            problems = verify_eot(blob)
            print(json.dumps({"input": label, "header": hdr.to_json(), "problems": problems}, ensure_ascii=False))
            if any(not p.startswith(("note:", "warning:")) for p in problems):
                rc = 1
        return rc
    if args.cmd == "extract":
        with open(args.eot, "rb") as fh:
            font = extract_font(fh.read())
        with open(args.out, "wb") as fh:
            fh.write(font)
        print(f"wrote {args.out}: {len(font)} bytes")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
