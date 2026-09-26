# python-pptx: existing decks, user templates and the legacy path

Paths here are relative to the pptx skill's base directory (SKILL.md §9 shows the commands with the absolute
path). `python3` with `python-pptx` 1.0.2 is installed system-wide: write a script and run it with Bash. Never
`pip install` anything.

Use this path to:
- **edit an existing .pptx in place** — a file the user attached, one from a repository or an SSH download;
- **build on the user's own template or master** (a `.potx`, or a .pptx whose layouts they want to keep);
- **build a NEW deck only when describe_system reports `converter: NOT INSTALLED`** (legacy mode) — tell the user
  the design converter is not installed in this deployment, so the deck will be plainer.

Never use it on a deck the converter built: change that deck's slide HTML and rebuild it (SKILL.md §8). A
python-pptx edit would be lost at the next build, and the changed file loses its exact previews.

## Read a deck (also the first step of a restyle)

To restyle a deck, dump its content, then author NEW HTML slides from it (SKILL.md §1–§8); do not try to convert
its shapes.

```python
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

def walk(shapes, depth=0):
    for shape in shapes:
        pad = "  " * depth
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            print(f"{pad}[group] {shape.name}")
            walk(shape.shapes, depth + 1)
            continue
        if shape.has_text_frame and shape.text_frame.text.strip():
            print(f"{pad}[text] {shape.name}: {shape.text_frame.text!r}")   # a line break comes back as \v
        if getattr(shape, "has_table", False) and shape.has_table:
            for row in shape.table.rows:
                print(pad + "[row] " + " | ".join(cell.text for cell in row.cells))
        if getattr(shape, "has_chart", False) and shape.has_chart:
            plot = shape.chart.plots[0]
            print(f"{pad}[chart] {list(plot.categories)}", [(s.name, list(s.values)) for s in plot.series])

prs = Presentation("input.pptx")
for i, slide in enumerate(prs.slides, 1):
    print(f"--- slide {i} (layout {slide.slide_layout.name})")
    walk(slide.shapes)
    if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
        print("  [notes]", slide.notes_slide.notes_text_frame.text)
```

## Edit an existing deck

- Save under a NEW name next to the original (e.g. `report-edited.pptx`) unless the user asks you to overwrite
  it. Keep the deck's fonts, layouts and styles; change only what was asked.
- `text_frame.text = …` drops the run formatting. Replace the text of the existing runs instead:

```python
def set_text_keep_format(shape, new_text):
    paragraphs = shape.text_frame.paragraphs
    runs = paragraphs[0].runs
    if runs:
        runs[0].text = new_text          # keeps the first run's font, size, colour
        for extra in runs[1:]:
            extra.text = ""
    else:
        paragraphs[0].text = new_text
    for extra in paragraphs[1:]:
        extra._p.getparent().remove(extra._p)
```

- Table cell: `table.cell(r, c).text_frame.paragraphs[0].runs[0].text = "515"` (same idea).
- Chart data (the chart keeps its formatting; values land in its workbook):

```python
from pptx.chart.data import CategoryChartData
data = CategoryChartData()
data.categories = ["1Q", "2Q", "3Q", "4Q"]
data.add_series("2025년", (1012, 1087, 1142, 1236))
data.add_series("2026년", (1148, 1209, 1290, 1410))
chart.replace_data(data)
```

- Delete a slide (python-pptx has no API for it):

```python
def delete_slide(prs, index):
    sld_ids = prs.slides._sldIdLst
    sld_id = sld_ids[index]
    prs.part.drop_rel(sld_id.rId)
    sld_ids.remove(sld_id)
```

- Reorder slides by moving the `sldId` elements inside `prs.slides._sldIdLst`. python-pptx cannot duplicate a
  slide cleanly: add a slide from the right layout and fill it instead.
- Objects inside groups are reached through `group.shapes` (the `walk` above).

## Build on the user's template or master

- python-pptx 1.0.2 refuses a `.potx` ("is not a PowerPoint file, content type is …template.main+xml"), even
  when renamed to .pptx. Convert a copy first:

```python
import zipfile
def potx_to_pptx(src, dst):
    tpl = b"application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
    pres = b"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(tpl, pres)
            zout.writestr(item, data)
```

- List the layouts and their placeholders, then add slides from them and fill the placeholders — the text then
  inherits the template's fonts, sizes and colours, so do not set fonts on those runs:

```python
prs = Presentation("company.pptx")
for i, layout in enumerate(prs.slide_layouts):
    print(i, layout.name, [(ph.placeholder_format.idx, str(ph.placeholder_format.type), ph.name)
                           for ph in layout.placeholders])
slide = prs.slides.add_slide(prs.slide_layouts[1])
slide.shapes.title.text = "…"
slide.placeholders[1].text_frame.text = "…"
```

- Delete the template's sample slides (`delete_slide`), keep its footer/date/slide-number placeholders, and put
  your own text boxes on its grid.

## New decks in legacy mode (converter not installed)

Rules that keep the preview faithful and the file portable:
- **Fonts: use "NanumGothic"** on every run you create (`run.font.name = "NanumGothic"`): it is installed in this
  image, so the previews render Korean correctly. Do not use 맑은 고딕/Malgun Gothic here — the preview renderer
  would silently substitute it.
- **16:9**: `prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`.
- Prevent overflow: titles ≤ 2 lines and ≤ 6 short bullets per slide; when a text frame looks tight, compare
  `len(text)` with the shape's width/height (EMU) before delivering.
- Never invent figures; mark sample data visibly.

## Self-check renders

```
bash scripts/render_deck.sh <deck.pptx> <out-dir> [dpi]
```

LibreOffice converts the deck to PDF (with a throwaway profile), then `pdftoppm` writes `<out-dir>/slide-N.png`,
one per slide (default 120 dpi). Never call `soffice --convert-to png` directly: it renders only the FIRST slide.
- With vision ("Image input (vision): supported" in describe_system), Read one or two PNGs to eyeball the layout;
  without vision, Read on images is blocked — rely on the overflow rules above.
- These are LibreOffice renders, an approximation of PowerPoint (AUTHORING §11 lists the typical differences).
- To iterate on the design WITH the user, publish the PNGs via `mcp__file_output__show_file` with `hidden: true`
  and embed the returned URLs in ONE `mcp__canvas__show` markdown artifact; re-show with the SAME `canvasId` as you
  revise.

## Deliver

`mcp__file_output__share_file` with the .pptx path and a `name` in the user's language. The server renders page
previews of such files automatically (LibreOffice) into the card's side panel — do not publish slide images
yourself for delivery. Limits: 3 files per turn, 30 MB per file. Re-generate after every accepted change and share
the final file, never a version you have not rebuilt.
