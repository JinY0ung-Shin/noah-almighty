#!/usr/bin/env python3
"""Provenance of the synthetic assets the skill ships (deterministic; no third-party imagery, so they can ship).

    python3 selftest/tools/make_assets.py [--out selftest/features/assets]       # the features self-test deck
    python3 selftest/tools/make_assets.py --visual [--out ../examples/visual/assets]   # the visual example deck

The features self-test deck (default):

* ``photo.jpg`` — 3000x2000 synthetic "landscape" (sky gradient, sun, three hill bands), baseline JPEG q84, 4:2:0.
  3000 px wide on purpose: the extractor's raster cap (2560 px) and its JPEG path (an opaque JPEG <img> with
  object-fit: cover) must both engage. Kept <= 300 KB.
* ``rounded.png`` — 720x480 RGBA illustration (diagonal gradient + circles); shown with border-radius, so the
  extractor bakes the rounded clip into a transparent PNG.

The skill's ``examples/visual`` deck (``--visual``): stand-ins for what a real deck places — a photo the user
attached, a screen capture of the system the deck is about — drawn here, never captured from anything:

* ``photo.jpg`` — a byte copy of the features deck's ``photo.jpg`` (``examples/talk/assets/photo.jpg`` is the same
  copy), so the example decks and the self-test share one synthetic photo.
* ``capture-web.png`` — 1600x1000 "screen capture" of an invented web dashboard (customer-support portal: sidebar,
  search, channel tabs, four KPI tiles, an hourly bar chart, per-channel bars, a table of recent inquiries with
  masked customer names), every label in Korean, drawn with the bundled Pretendard faces.
* ``capture-phone-before.png``, ``capture-phone-after.png`` — 750x1500 "phone screens" of one invented request
  form: before (step 1 of 5, six empty fields, a disabled button) and after (step 1 of 2, prefilled details, choice
  chips, one primary button).

Their dates are the example deck's own: a capture taken on Wednesday 2026-10-14, the deck's report date, offering the
next working days (15, 16 and 19 October) — keep every date and figure in them consistent with the slides.

Text is laid out with Pillow's BASIC engine (no raqm/HarfBuzz dependency), so the output depends only on Pillow and
the committed fonts. The committed files are the output of this script (Pillow 12.3.0); rerunning it is only needed
to change them.
"""
from __future__ import annotations

import argparse
import math
import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TOOLS = Path(__file__).resolve()
SELFTEST = TOOLS.parents[1]           # converter/selftest
FONTS = TOOLS.parents[2] / "fonts"    # converter/fonts (Pretendard, SIL OFL 1.1)
SKILL = TOOLS.parents[3]              # the pptx skill


def lerp(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def photo(w=3000, h=2000) -> Image.Image:
    img = Image.new("RGB", (w, h))
    top, bottom = (42, 82, 160), (250, 196, 150)
    px = img.load()
    for y in range(h):
        c = lerp(top, bottom, (y / (h - 1)) ** 1.3)
        for x in range(w):
            px[x, y] = c
    d = ImageDraw.Draw(img)
    d.ellipse((2050, 420, 2450, 820), fill=(255, 236, 196))
    bands = [((64, 96, 140), 1180, 150, 0.0015), ((46, 74, 112), 1420, 120, 0.0023), ((28, 48, 76), 1660, 90, 0.0031)]
    for color, base, amp, freq in bands:
        pts = [(x, base - amp * math.sin(x * freq) - 0.4 * amp * math.sin(x * freq * 2.7 + 1.3)) for x in range(0, w + 1, 20)]
        d.polygon(pts + [(w, h), (0, h)], fill=color)
    return img


def rounded(w=720, h=480) -> Image.Image:
    img = Image.new("RGBA", (w, h))
    a, b = (14, 124, 102), (74, 110, 242)
    px = img.load()
    for y in range(h):
        for x in range(w):
            c = lerp(a, b, (x / (w - 1) + y / (h - 1)) / 2)
            px[x, y] = c + (255,)
    d = ImageDraw.Draw(img)
    d.ellipse((460, 60, 680, 280), fill=(255, 255, 255, 70))
    d.ellipse((80, 250, 300, 470), fill=(255, 178, 125, 200))
    d.rectangle((300, 180, 420, 300), fill=(255, 255, 255, 150))
    return img


# ---- the visual example deck: an invented UI, in its own fixed palette (a capture keeps the look of the system it
# shows, whatever the deck's theme) ----
PAGE = (244, 246, 249)
WHITE = (255, 255, 255)
LINE = (226, 232, 240)
SOFT = (241, 245, 249)
INK = (15, 23, 42)
INK2 = (51, 65, 85)
MUTED = (100, 116, 139)
FAINT = (148, 163, 184)
TEAL = (13, 148, 136)
TEAL_D = (15, 118, 110)
TEAL_L = (204, 251, 241)
TEAL_50 = (240, 253, 250)
MINT = (153, 246, 228)
AMBER = (180, 83, 9)
AMBER_DOT = (245, 158, 11)
AMBER_L = (254, 243, 199)
GREEN = (21, 128, 61)
GREEN_L = (220, 252, 231)
BLUE = (29, 78, 216)
BLUE_L = (219, 234, 254)
RED = (220, 38, 38)
BAR_PREV = (203, 213, 225)
SIDEBAR = (22, 30, 46)
SIDEBAR_ON = (44, 58, 82)
SIDEBAR_TEXT = (203, 213, 225)
SIDEBAR_MUTED = (148, 163, 184)

_FACES = {400: "Regular", 600: "SemiBold", 700: "Bold", 800: "ExtraBold"}
_font_cache: dict[tuple[int, int], ImageFont.FreeTypeFont] = {}


def font(size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    key = (size, weight)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(str(FONTS / f"Pretendard-{_FACES[weight]}.ttf"), size,
                                              layout_engine=ImageFont.Layout.BASIC)
    return _font_cache[key]


def text(d: ImageDraw.ImageDraw, xy, s: str, size: int, weight: int = 400, fill=INK, anchor: str = "lm") -> float:
    """Draw one line; returns its advance width."""
    f = font(size, weight)
    d.text(xy, s, font=f, fill=fill, anchor=anchor)
    return f.getlength(s)


def width(s: str, size: int, weight: int = 400) -> float:
    return font(size, weight).getlength(s)


def pill(d, x, cy, label, size, weight, fg, bg, pad=12, h=None, outline=None, anchor_right=False) -> float:
    """A rounded label; returns its width. `x` is the left edge (the right edge when anchor_right)."""
    w = width(label, size, weight) + 2 * pad
    h = h or size + 14
    x0 = x - w if anchor_right else x
    d.rounded_rectangle((x0, cy - h / 2, x0 + w, cy + h / 2), radius=h / 2, fill=bg, outline=outline, width=2 if outline else 0)
    text(d, (x0 + w / 2, cy), label, size, weight, fg, "mm")
    return w


def card(d, box, r=14):
    d.rounded_rectangle(box, radius=r, fill=WHITE, outline=LINE, width=1)


def capture_web(w=1600, h=1000) -> Image.Image:
    img = Image.new("RGB", (w, h), PAGE)
    d = ImageDraw.Draw(img)

    # sidebar: logo, navigation (the dashboard active, the inbox with its waiting count), the team at the bottom
    d.rectangle((0, 0, 231, h), fill=SIDEBAR)
    d.ellipse((40, 28, 64, 52), fill=MINT)
    d.ellipse((28, 28, 52, 52), fill=TEAL)
    text(d, (78, 40), "예시테크 포털", 20, 700, WHITE)
    y = 104
    for label, on in (("대시보드", True), ("문의함", False), ("고객", False), ("지식 문서", False), ("보고서", False), ("설정", False)):
        if on:
            d.rounded_rectangle((16, y, 215, y + 48), radius=10, fill=SIDEBAR_ON)
        d.rounded_rectangle((36, y + 15, 54, y + 33), radius=5, outline=WHITE if on else SIDEBAR_MUTED, width=2)
        text(d, (70, y + 24), label, 17, 600 if on else 400, WHITE if on else SIDEBAR_TEXT)
        if label == "문의함":
            pill(d, 200, y + 24, "17", 13, 700, INK, AMBER_DOT, pad=9, h=24, anchor_right=True)
        y += 56
    d.line((24, 900, 207, 900), fill=SIDEBAR_ON, width=1)
    d.ellipse((28, 924, 68, 964), fill=(71, 85, 105))
    text(d, (48, 944), "CX", 14, 700, WHITE, "mm")
    text(d, (82, 934), "고객경험팀", 16, 600, WHITE)
    text(d, (82, 956), "상담 1팀 · 42명", 13, 400, SIDEBAR_MUTED)

    # top bar: page title and time stamp, search, alerts, the signed-in account
    d.rectangle((232, 0, w, 75), fill=WHITE)
    d.line((232, 76, w, 76), fill=LINE, width=1)
    tw = text(d, (264, 38), "오늘의 문의 현황", 24, 700, INK)
    text(d, (264 + tw + 16, 39), "2026년 10월 14일 (수) 오전 10:24 기준", 15, 400, MUTED)
    d.rounded_rectangle((1000, 18, 1380, 58), radius=20, fill=SOFT)
    d.ellipse((1020, 29, 1036, 45), outline=FAINT, width=2)
    d.line((1034, 43, 1041, 50), fill=FAINT, width=2)
    text(d, (1052, 38), "고객 이름 · 문의 번호로 검색", 15, 400, FAINT)
    d.ellipse((1400, 18, 1440, 58), fill=SOFT)
    d.rounded_rectangle((1412, 28, 1428, 44), radius=6, outline=INK2, width=2)
    d.line((1410, 44, 1430, 44), fill=INK2, width=2)
    d.ellipse((1417, 45, 1423, 51), fill=INK2)
    d.ellipse((1430, 18, 1442, 30), fill=RED)
    d.ellipse((1460, 18, 1500, 58), fill=TEAL)
    d.ellipse((1473, 26, 1487, 40), fill=WHITE)
    d.pieslice((1466, 40, 1494, 68), 180, 360, fill=WHITE)
    d.rectangle((1460, 58, 1500, 70), fill=WHITE)   # crop the silhouette at the circle's bottom
    d.ellipse((1460, 18, 1500, 58), outline=TEAL, width=2)
    text(d, (1512, 38), "상담 1팀", 15, 600, INK2)

    # channel tabs (the whole queue selected) and the two actions
    x = 264
    for i, label in enumerate(("전체 128", "채팅 64", "전화 41", "이메일 23")):
        x += pill(d, x, 118, label, 16, 700 if i == 0 else 600, WHITE if i == 0 else INK2,
                  TEAL_D if i == 0 else WHITE, pad=20, h=44, outline=None if i == 0 else LINE) + 12
    d.rounded_rectangle((1276, 96, 1392, 140), radius=10, fill=WHITE, outline=LINE, width=2)
    text(d, (1334, 118), "필터", 16, 600, INK2, "mm")
    d.rounded_rectangle((1408, 96, 1568, 140), radius=10, fill=TEAL)
    text(d, (1488, 118), "+ 새 문의 등록", 16, 700, WHITE, "mm")

    # four KPI tiles: the day's queue first, the waiting queue marked; the first-response time is the month's
    # average so far (Oct 1-14), the figure the deck's callout slide cites
    tiles = (
        ("오늘 처리할 문의", "128", "건", ("전일 대비 ", "▲ 12건", TEAL_D)),
        ("10월 평균 첫 응답", "4분 12초", "", ("목표 5분 이내 ", "달성", GREEN)),
        ("해결률", "92", "%", ("지난주 대비 ", "▲ 3%p", GREEN)),
        ("응답 대기", "17", "건", ("10분 넘게 기다린 문의 ", "3건", AMBER)),
    )
    for i, (label, value, unit, (foot, key, key_fill)) in enumerate(tiles):
        x0 = 264 + i * 332
        card(d, (x0, 164, x0 + 308, 304))
        lx = x0 + 24
        if i == 3:
            d.ellipse((lx, 188, lx + 12, 200), fill=AMBER_DOT)
            lx += 20
        text(d, (lx, 194), label, 16, 600, MUTED)
        vw = text(d, (x0 + 24, 242), value, 40, 800, INK)
        if unit:
            text(d, (x0 + 24 + vw + 4, 248), unit, 20, 600, MUTED)
        fw = text(d, (x0 + 24, 282), foot, 14, 400, MUTED)
        text(d, (x0 + 24 + fw, 282), key, 14, 700, key_fill)

    # inquiries per hour: today against last week's average, on one scale from zero
    card(d, (264, 328, 1040, 640))
    text(d, (288, 360), "시간대별 문의", 18, 700, INK)
    lx = 1016
    for label, fill in (("지난주 평균", BAR_PREV), ("오늘", TEAL)):
        lw = width(label, 14, 400)
        text(d, (lx - lw, 360), label, 14, 400, MUTED)
        d.rounded_rectangle((lx - lw - 20, 354, lx - lw - 8, 366), radius=3, fill=fill)
        lx -= lw + 36
    base, top, vmax = 596, 404, 24
    for v in (0, 8, 16, 24):
        gy = base - (base - top) * v / vmax
        d.line((320, gy, 1016, gy), fill=SOFT if v else LINE, width=1)
        text(d, (304, gy), str(v), 12, 400, FAINT, "rm")
    today = (8, 14, 19, 16, 11, 15, 18, 13, 9)
    prev = (10, 17, 22, 18, 13, 17, 20, 15, 11)
    for k, (a, b) in enumerate(zip(prev, today)):
        cx = 356 + k * 78
        for dx, v, fill in ((-16, a, BAR_PREV), (4, b, TEAL)):
            d.rounded_rectangle((cx + dx, base - (base - top) * v / vmax, cx + dx + 16, base), radius=3, fill=fill)
        text(d, (cx + 2, 618), f"{9 + k}시", 13, 400, MUTED, "mm")

    # share of each channel's inquiries answered within the target
    card(d, (1064, 328, 1568, 640))
    text(d, (1088, 360), "채널별 기한 내 처리율", 18, 700, INK)
    for k, (label, pct) in enumerate((("채팅", 96), ("전화", 91), ("이메일", 84), ("앱 문의", 88))):
        ry = 420 + k * 56
        text(d, (1088, ry), label, 15, 600, INK2)
        d.rounded_rectangle((1176, ry - 6, 1480, ry + 6), radius=6, fill=SOFT)
        d.rounded_rectangle((1176, ry - 6, 1176 + 304 * pct / 100, ry + 6), radius=6, fill=TEAL)
        text(d, (1544, ry), f"{pct}%", 15, 700, INK, "rm")
    text(d, (1088, 618), "기한: 채팅 5분 · 전화 3분 · 이메일 4시간", 13, 400, MUTED)

    # recent inquiries: customer names masked, as a real capture must show them
    card(d, (264, 664, 1568, 968))
    text(d, (288, 696), "최근 문의", 18, 700, INK)
    text(d, (1544, 696), "전체 보기 >", 15, 600, TEAL_D, "rm")
    d.rectangle((265, 724, 1567, 764), fill=(248, 250, 252))
    cols = (288, 448, 600, 792, 952, 1112, 1432)
    for cx, head in zip(cols, ("문의 번호", "고객", "유형", "채널", "접수 시각", "담당", "상태")):
        text(d, (cx, 744), head, 14, 600, MUTED)
    rows = (
        ("#24-18107", "김*현", "배송 지연", "채팅", "10:21", "상담 1팀", ("대기", AMBER, AMBER_L)),
        ("#24-18106", "이*우", "환불 요청", "전화", "10:18", "상담 2팀", ("처리 중", BLUE, BLUE_L)),
        ("#24-18105", "박*은", "계정 잠금", "앱 문의", "10:12", "상담 1팀", ("처리 중", BLUE, BLUE_L)),
        ("#24-18104", "최*준", "결제 오류", "이메일", "10:05", "상담 3팀", ("완료", GREEN, GREEN_L)),
    )
    for k, row in enumerate(rows):
        ry = 788 + k * 48
        if k:
            d.line((288, ry - 24, 1544, ry - 24), fill=SOFT, width=1)
        for cx, cell in zip(cols, row[:6]):
            text(d, (cx, ry), cell, 15, 600 if cx == cols[0] else 400, INK if cx == cols[0] else INK2)
        label, fg, bg = row[6]
        pill(d, cols[6], ry, label, 13, 700, fg, bg, pad=12, h=26)
    return img


def status_bar(d, w):
    text(d, (48, 34), "10:24", 26, 600, INK)
    for k in range(4):
        d.rounded_rectangle((590 + k * 12, 42 - 6 - k * 5, 598 + k * 12, 42), radius=2, fill=INK)
    d.rounded_rectangle((652, 22, 698, 46), radius=7, outline=INK, width=2)
    d.rounded_rectangle((656, 26, 686, 42), radius=4, fill=INK)
    d.rounded_rectangle((700, 29, 704, 39), radius=2, fill=INK)


def app_bar(d, w, title):
    d.line((64, 96, 46, 114), fill=INK, width=4)
    d.line((46, 114, 64, 132), fill=INK, width=4)
    text(d, (w / 2, 114), title, 32, 700, INK, "mm")
    d.line((0, 164, w, 164), fill=SOFT, width=2)


def step(d, w, label, share):
    text(d, (48, 204), label, 24, 600, MUTED)
    d.rounded_rectangle((48, 236, w - 48, 246), radius=5, fill=SOFT)
    d.rounded_rectangle((48, 236, 48 + (w - 96) * share, 246), radius=5, fill=TEAL)


def home_indicator(d, w, h):
    d.rounded_rectangle((w / 2 - 100, h - 34, w / 2 + 100, h - 24), radius=5, fill=INK)


def phone_before(w=750, h=1500) -> Image.Image:
    img = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(img)
    status_bar(d, w)
    app_bar(d, w, "서비스 신청")
    step(d, w, "1 / 5 단계 · 고객 정보", 0.2)
    text(d, (48, 300), "고객 정보를 입력해 주세요", 34, 700, INK)
    fields = (("이름", "이름을 입력하세요"), ("휴대폰 번호", "- 없이 숫자만 입력"), ("이메일", "example@mail.com"),
              ("주소", "도로명 또는 지번 주소"), ("상세 주소", "동 · 호수까지 입력"), ("생년월일", "8자리 숫자 (예: 19900101)"))
    y = 364
    for label, hint in fields:
        text(d, (48, y), label + " *", 22, 600, INK2)
        d.rounded_rectangle((48, y + 30, w - 48, y + 110), radius=12, outline=LINE, width=2)
        text(d, (76, y + 70), hint, 24, 400, FAINT)
        if label == "주소":
            d.rounded_rectangle((w - 170, y + 44, w - 62, y + 96), radius=10, outline=LINE, width=2)
            text(d, (w - 116, y + 70), "검색", 22, 600, INK2, "mm")
        y += 148
    text(d, (48, y + 4), "* 표시는 모두 필수 항목입니다", 20, 400, RED)
    d.rounded_rectangle((48, 1340, w - 48, 1428), radius=14, fill=LINE)
    text(d, (w / 2, 1384), "다음 (1/5)", 28, 700, FAINT, "mm")
    home_indicator(d, w, h)
    return img


def chip(d, x0, y0, x1, y1, label, on):
    d.rounded_rectangle((x0, y0, x1, y1), radius=(y1 - y0) / 2, fill=TEAL if on else WHITE,
                        outline=None if on else LINE, width=0 if on else 2)
    text(d, ((x0 + x1) / 2, (y0 + y1) / 2), label, 24, 700 if on else 600, WHITE if on else INK2, "mm")


def phone_after(w=750, h=1500) -> Image.Image:
    img = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(img)
    status_bar(d, w)
    app_bar(d, w, "서비스 신청")
    step(d, w, "1 / 2 단계 · 신청 내용 확인", 0.5)
    text(d, (48, 300), "이 정보로 신청할까요?", 34, 700, INK)

    d.rounded_rectangle((48, 344, w - 48, 580), radius=20, fill=TEAL_50, outline=TEAL_L, width=2)
    d.ellipse((80, 370, 108, 398), fill=TEAL)
    d.line((87, 385, 93, 391), fill=WHITE, width=3)
    d.line((93, 391, 102, 378), fill=WHITE, width=3)
    text(d, (120, 384), "로그인 정보로 채웠어요", 22, 600, TEAL_D)
    text(d, (w - 80, 384), "수정", 22, 600, TEAL_D, "rm")
    for k, (label, value) in enumerate((("이름", "김*현"), ("연락처", "010-****-1234"), ("주소", "서울 강남구 · 저장된 주소"))):
        ry = 446 + k * 46
        text(d, (80, ry), label, 22, 400, MUTED)
        text(d, (w - 80, ry), value, 24, 600, INK, "rm")

    text(d, (48, 628), "신청 유형", 24, 700, INK)
    for k, (label, on) in enumerate((("방문 설치", True), ("원격 지원", False), ("제품 교환", False))):
        x0 = 48 + k * 222
        chip(d, x0, 660, x0 + 210, 732, label, on)
    # the next three working days after the capture's date, Wed 2026-10-14
    text(d, (48, 788), "희망 날짜", 24, 700, INK)
    for k, (label, on) in enumerate((("10월 15일 (목)", True), ("10월 16일 (금)", False), ("10월 19일 (월)", False))):
        x0 = 48 + k * 222
        chip(d, x0, 820, x0 + 210, 892, label, on)
    text(d, (48, 948), "희망 시간", 24, 700, INK)
    for k, (label, on) in enumerate((("오전", True), ("오후", False), ("상관없음", False))):
        x0 = 48 + k * 222
        chip(d, x0, 980, x0 + 210, 1052, label, on)

    d.ellipse((48, 1106, 76, 1134), outline=FAINT, width=2)
    text(d, (62, 1120), "i", 18, 700, FAINT, "mm")
    text(d, (92, 1120), "신청하면 10분 안에 확인 문자를 보내 드려요", 22, 400, MUTED)
    d.rounded_rectangle((48, 1340, w - 48, 1428), radius=14, fill=TEAL)
    text(d, (w / 2, 1384), "신청하기", 30, 700, WHITE, "mm")
    home_indicator(d, w, h)
    return img


def save_png(img: Image.Image, path: Path):
    img.save(path, "PNG", optimize=True)


def features(out: Path) -> list[str]:
    photo().save(out / "photo.jpg", "JPEG", quality=84, subsampling=2, optimize=True)
    rounded().save(out / "rounded.png", "PNG", optimize=True)
    return ["photo.jpg", "rounded.png"]


def visual(out: Path) -> list[str]:
    shutil.copyfile(SELFTEST / "features" / "assets" / "photo.jpg", out / "photo.jpg")
    save_png(capture_web(), out / "capture-web.png")
    save_png(phone_before(), out / "capture-phone-before.png")
    save_png(phone_after(), out / "capture-phone-after.png")
    return ["photo.jpg", "capture-web.png", "capture-phone-before.png", "capture-phone-after.png"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--visual", action="store_true", help="write the visual example deck's assets instead")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    out = a.out or (SKILL / "examples" / "visual" / "assets" if a.visual else SELFTEST / "features" / "assets")
    out.mkdir(parents=True, exist_ok=True)
    for n in (visual if a.visual else features)(out):
        print(n, (out / n).stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
