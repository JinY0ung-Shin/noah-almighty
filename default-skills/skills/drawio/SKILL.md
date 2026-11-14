---
name: drawio
description: Use when the user asks for an editable diagram — architecture, flowchart, sequence, network, org chart (다이어그램, 순서도, 구성도, 아키텍처) — or wants to view/edit a .drawio file. Covers authoring mxfile XML, the bundled layout/routing/check tool, and delivery with share_file (the chat renders it).
---

# draw.io diagrams (.drawio)

The workflow is **declare → tidy → check → share**. You write WHAT is in the diagram (shapes,
connectors, labels, groups) as plain XML; the skill's tool decides where things go and how the lines
run, and tells you what is still wrong. Do not compute coordinates or bend lines by hand: draw.io's
own router runs a connector straight through any shape that lies between its ends, and a model
cannot see that from the XML. Diagram labels follow the user's language (default Korean).

The tool is `bash ${CLAUDE_SKILL_DIR}/scripts/drawio.sh` (Node only; no network, no browser):

| Command | What it does | Use it for |
|---|---|---|
| `layout <file> [--flow down\|right\|tree-down\|tree-right\|radial\|organic]` | Places every shape and redraws every connector right-angled (ELK, draw.io's own Arrange ▸ Layout). Grows boxes to fit their labels. | Flowcharts, pipelines, dependency and architecture graphs, trees, org charts: anything whose positions carry no meaning. |
| `route <file>` | Moves and resizes nothing; re-routes the right-angled connectors around the shapes (libavoid). | Swimlanes, a grid you chose on purpose, a diagram you were handed. |
| `check <file>` | Changes nothing; lists errors, warnings and notes, each with its cell id and its fix. | A diagram you edited by hand, before you share it. `layout` and `route` end with the same report. |

Both `layout` and `route` first repair a file that does not parse (an unescaped `<` or `&` in a
label, text around the diagram), add the geometry an edge was written without, and give edge labels
a background so the line stops at the text. `--out <file>` writes the result elsewhere instead of
over the input. Exit status: `0` done (read the warnings); `1` the diagram has errors or cannot take
the command — the reason is printed and nothing was written; `2` usage; `4` the engine could not
start (report it; never install anything).

## 1. Author the mxfile XML

Write the file with `Write`, always as **uncompressed** XML (it stays editable on later turns, and
the tool reads nothing else):

```xml
<mxfile host="app">
  <diagram id="page-1" name="Page-1">
    <mxGraphModel grid="0" page="1" pageWidth="1100" pageHeight="850">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="api" value="API 서버" style="rounded=1;whiteSpace=wrap;html=1;fontSize=14;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">
          <mxGeometry x="40" y="40" width="160" height="60" as="geometry"/>
        </mxCell>
        <mxCell id="db" value="주문 DB" style="shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;whiteSpace=wrap;html=1;fontSize=14;" vertex="1" parent="1">
          <mxGeometry x="260" y="180" width="120" height="80" as="geometry"/>
        </mxCell>
        <mxCell id="e-api-db" value="조회" style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="api" target="db">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

Rules that keep the file valid:

- Every cell has a unique `id` (use meaningful ones: `api`, `e-api-db`). `0` and `1` are the root and
  the default layer; shapes and connectors use `parent="1"` or the id of the container they are in.
- A shape: `vertex="1"` and an `<mxGeometry x y width height as="geometry"/>`. A connector: `edge="1"`,
  `source` and `target` ids, and a child `<mxGeometry relative="1" as="geometry"/>` — never a
  self-closing edge cell, it is not drawn.
- `html=1;whiteSpace=wrap;` in every shape style. A label's markup is escaped
  (`value="&lt;b&gt;주문&lt;/b&gt;&lt;br&gt;서비스"`); a line break is `&lt;br&gt;` or `&#xa;`, never `\n`.
  Escape `&`, `<`, `>`, `"` in every value. No XML comments.
- No waypoints (`<Array as="points">`) and no `exitX`/`entryX` pins: the tool routes the lines. Add a
  pin only when you mean a specific side.
- Several pages = several `<diagram>` elements in one mxfile; the preview gets a page switcher.

## 2. Make it readable

- **Text size.** Put `fontSize=14` in every shape style; a diagram of more than about 12 shapes uses
  `fontSize=16`. Without it draw.io draws 12 px, which is small once the preview scales the diagram to
  the panel. A title is a `text` cell with `fontSize=20;fontStyle=1` that no connector touches
  (`layout` puts such free text above the diagram). Edge labels keep their default.
- **Box size.** A Hangul character is one font size wide, a Latin letter about half. A 160×60 box
  holds about 9 Hangul characters on a line at 14 px. `layout` grows boxes for you; with `route` you
  size them yourself (`check` reports a label that does not fit).
- **Edge labels: 1–3 words** (`예`, `조회`, `HTTPS`). A longer explanation goes into a shape's text or
  a legend; a long label covers the line and the shapes next to it. Leave out labels that only say
  what the arrow already says.
- **Fewer, clearer lines.** Draw a connector only when the relationship matters. When many lines
  meet in one area, connect them through one hub shape (a gateway, a bus, a registry) instead of
  drawing every pair. One meaning per line style (`dashed=1` = async, say), with a legend when you
  mix styles.
- **Group with containers**, never by drawing a big box behind shapes: the container is a cell
  (`swimlane;startSize=28;html=1;fontSize=14;` with a title, or `group;` without) and its children
  set `parent="<container id>"` with coordinates relative to it. External actors stay outside.
- **Shapes that render everywhere**: the built-ins — rectangle by default, `rounded=1`; the bare
  words `ellipse`, `rhombus` (a decision), `triangle`, `swimlane`, `text`; every other one as
  `shape=<name>`: `shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;` (a database; without
  `boundedLbl=1` the cap's line runs through the label), `shape=hexagon`, `shape=parallelogram`,
  `shape=cloud`, `shape=document` (a bare `hexagon` draws a plain box) — and the offline stencil sets `shape=mxgraph.basic.*`,
  `mxgraph.arrows.*`, `mxgraph.flowchart.*`, `mxgraph.bpmn.*`. **Avoid the vendor icon sets**
  (`mxgraph.aws4.*`, `mxgraph.azure.*`, `mxgraph.gcp*`, `mxgraph.cisco*`, …) unless the user asks for
  them: the chat preview shows those as labelled placeholder boxes. Use labelled rounded rectangles.
- **Connector style by diagram**: flowchart, architecture, pipeline, swimlane →
  `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;`; org chart → the same with `endArrow=none;`;
  ER → `edgeStyle=entityRelationEdgeStyle;html=1;`; state or network links → no `edgeStyle` (straight).
  `route` draws the right-angled ones only and leaves a straight, curved or entity-relation line as
  you drew it, so place its two ends where the line between them is clear (`check` says when it is
  not). `layout` redraws EVERY connector right-angled: a diagram that needs straight or
  entity-relation lines is placed on the grid and routed (§3 B).

## 3. Place and route — pick ONE of the two

**A. Positions carry no meaning → `layout`.** Give every shape any position (the grid of B is fine,
so is a rough guess) and get the STRUCTURE right: which shapes, which connectors, which container.
Then:

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/drawio.sh layout ./diagram.drawio              # top to bottom
bash ${CLAUDE_SKILL_DIR}/scripts/drawio.sh layout ./diagram.drawio --flow right # left to right
```

`tree-down` / `tree-right` / `radial` are for a tree (one root, no cycle, no shape with two
parents: hierarchies, org charts); `organic` is for a network without direction. Shapes inside a
container are laid out inside it. A page with swimlanes, or with shapes on several layers, is
refused: that is B.

**B. Positions carry meaning (lanes, a deliberate arrangement) → the grid, then `route`.** One shape
per grid cell, nothing between two cells:

- Column `x = 40 + col × 220`, row `y = 40 + row × 140`. Boxes 160×60, decisions 160×80, databases
  120×80, all inside their cell. That leaves 60 px between columns and 80 px between rows for lines
  and short labels.
- Swimlanes: one lane per actor, `swimlane;horizontal=0;startSize=110;whiteSpace=wrap;html=1;fontSize=14;` at `x=0`,
  `y = lane × 160`, height 160, all lanes the same width (`140 + columns × 220`). A shape in a lane
  has `parent="<lane id>"` and sits at `x = 140 + col × 220`, `y = 50`.

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/drawio.sh route ./diagram.drawio
```

Never run both on one diagram, and never `layout` a diagram whose arrangement someone chose.

## 4. Read the report, fix, repeat

`layout` and `route` print the check report after they write the file; `check` prints it alone.

- An **error** means the viewer draws nothing or the wrong thing (broken XML, a duplicate id, a
  connector whose end names no cell). Fix every error; nothing is written while one stands.
- A **warning** is what a reader sees as a messy diagram: two shapes on top of each other, a line
  through a shape, a label that does not fit its box or covers a shape, text too small. Fix it in the
  XML (shorten the label, enlarge the box, move the shape to a free grid cell) and run the same
  command again.
- A **note** is a habit to fix in diagrams you author (no `fontSize`, …).

Two rounds of fixes are enough: then share the diagram and say in one line what is still not ideal.
The check estimates text widths without a browser, so treat a size warning as a strong hint, not a
measurement.

**If the tool is not there** — `${CLAUDE_SKILL_DIR}/scripts/drawio.sh` does not exist (you read this
skill through `mcp__skills__read`) or the run has no shell: place the shapes on the grid of §3 B,
keep every connector between neighbouring cells where you can, re-read your XML for unique ids and
existing `source`/`target` ids, and tell the user the lines were not routed automatically.

## 5. Edit an existing .drawio

Read the file and edit the XML. Someone arranged it: keep their positions, add your cells on free
space, and run `check` — `route` only when the user wants the lines tidied, `layout` only when they
ask for a new arrangement. A file you only pass along (the user wants to SEE a Confluence
attachment) is shared as it is: the tool is for diagrams you author or edit.

If a `<diagram>` element holds base64 text instead of `<mxGraphModel …>`, the page is
deflate-compressed: the viewer draws it, but you cannot edit it and `layout` / `route` refuse the
file (`check` says so in a note). To edit it, decode it with Bash python3:

```bash
python3 -c 'import sys,base64,zlib,urllib.parse; print(urllib.parse.unquote(zlib.decompress(base64.b64decode(sys.argv[1]), -15).decode()))' '<BASE64>'
```

Put the result in place of the base64 text and save. Never re-compress.

## 6. Deliver — the preview is automatic

Call `mcp__file_output__share_file` with the `.drawio` path. That is ALL delivery takes:

- The user gets a download card; clicking it opens a side panel where the chat UI renders the
  diagram **interactively** (zoom/pan, layers, pages) — client-side, no server toolchain.
- Do NOT export the diagram to PNG/SVG for delivery, do not paste mxfile XML into the chat, and
  never paste local paths / `file://` URLs — there is no Bash workaround for delivering files.
- Limits: 3 files per turn, 30 MB per file. Give the download a clear name in the user's language
  when appropriate (e.g. `name: "시스템 구성도.drawio"`).
- The user can keep editing the file in any draw.io app (desktop, VS Code extension, Confluence
  plugin) — mention that when you hand it over.

## 7. Iterate

Apply requested changes to the SAME .drawio file, run the same tool command again (a new shape needs
its place and its lines too), and `share_file` it again — never share a version you have not re-saved
and checked.
