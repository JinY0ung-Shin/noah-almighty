"""IR (docs/CONTRACT.md) -> native, editable PPTX. Modules:

core      units, XML helpers, template sanitizing, blank slides, names/ids
fonts     fonts.json profiles, face resolution, PowerPoint vertical metrics, CSS advance model
pptbreak  PowerPoint's greedy line-breaking model (wrap-width windows)
text      text boxes + the paragraph/run writer shared with table cells
shapes    shapes (geometry, fills, borders, shadows) and slide backgrounds
pictures  PNG / JPEG / native SVG pictures
table     native tables
chart     (chart lane) add_chart(slide, el, ctx) — imported lazily by tools/build_pptx.py
"""
from .core import EMU_PER_PX, KIT, POC, emu  # noqa: F401  (re-exported)

__all__ = ["EMU_PER_PX", "KIT", "POC", "emu"]
