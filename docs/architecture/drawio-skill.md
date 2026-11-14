# drawio skill tool (place, route, check a `.drawio` file)

> The bundled `drawio` skill's tool: what it is made of, where it runs, its commands and exit statuses,
> what it checks and how it estimates text, what is vendored and from where, and how to refresh it.
> The chat-side viewer of a shared `.drawio` file is in [`chat-sse-media.md`](chat-sse-media.md)
> ("draw.io viewer"); principles are in the root [`CLAUDE.md`](../../CLAUDE.md).

## Why it exists (2026-11-14)

The avatar wrote mxfile XML by hand, coordinates included. Two defects came back from users: text too
small or spilling out of its box, and connectors drawn over shapes. Both come from the same place: the
model cannot see the picture. draw.io's own router draws a connector as a straight or once-bent line
between its ends with no obstacle avoidance, so any shape between two connected shapes gets a line
through it; and draw.io's default label is 12 px, measured by nobody. Prompt rules alone do not fix
the first one. So the model declares the STRUCTURE and a tool does the geometry and reports the rest.

## Shape

- **Skill-side, shell-side, in the sandbox** — like the deck converter, never an MCP tool (Noah's
  container holds the DB and every secret) and never a server route. The avatar runs
  `bash <skill>/scripts/drawio.sh <command> <file>` on a file in its own workspace.
- **No toolchain flag and no image change.** It needs Node only, and every pi sandbox has Node 22
  (`vendor/pi-gateway/images/sandbox/Dockerfile`). Everything else is vendored INSIDE the skill folder
  (`default-skills/skills/drawio/engine/`, ~1.7 MB), which `piSkills.ts` copies into the sandbox with the
  rest of the skill. The sandbox has no network and the tool opens no connection.
- **Both metacognition surfaces say it** (`drawioSection` in `promptBuilder.ts`, the `Diagram files`
  line of `describe_system`), plus the user-facing manual page (`systemManual.ts`). There is no state to
  report (no probe): when the skill is read through `mcp__skills__read` (a run whose skill folder could
  not be written) or the run has no shell, SKILL.md §4 tells the avatar to place shapes on the grid by
  hand and to say the lines were not routed.
- A read-only session (a colleague chat) gets no draw.io section at all, as before: authoring needs
  `write`.

## Files

```
default-skills/skills/drawio/
  SKILL.md                 declare → tidy → check → share
  scripts/drawio.sh        exec node …/engine/drawio.mjs "$@"
  engine/
    drawio.mjs             the CLI (arguments, the pass order, exit statuses, the atomic write)
    lib/check.mjs          the findings (codes below), repairIfNeeded, pagesWithLanes / pagesWithLayers, BUNDLED_STENCILS, ROUTED_STYLE
    lib/passes.mjs         fitLabels, elkLayout (ELK bridge), libavoidRoute (upstream pass), keepEdgeStyles, ensureEdgeGeometry
    lib/model.mjs          boxes, containers, label facts, sizeForLabel / overflows
    lib/text.mjs           text width without a renderer (CJK-aware)
    lib/xmlcheck.mjs       well-formedness scan, canonicalAttributes, withoutComments
    src/                   jgraph/drawio-mcp, verbatim — EXCEPT src/cdn-cache.js (Noah's offline stand-in)
    vendor/elk/            drawio-elk.min.js (ELK + draw.io's bridge)
    vendor/libavoid/       libavoid-js Node build + wasm, draw.io's routing core
    README.md              provenance table, pinned upstream commit, licenses, refresh steps
    VERSION                bump when a command, option, exit status or finding code changes
```

## Commands

| Command | Passes, in order |
|---|---|
| `layout <file> [--flow down\|right\|tree-down\|tree-right\|radial\|organic] [--out f]` | read → `repairIfNeeded` → refuse on findings / a commented-out cell → `canonicalAttributes` → refuse lanes / several layers → `fitLabels` → `normalizeDiagram` → ELK → refuse if it put shapes on top of each other → label passes → write → check report |
| `route <file> [--out f]` | read → `repairIfNeeded` → refuse on findings / a commented-out cell → `canonicalAttributes` → refuse over 400 connectors between shapes → `ensureEdgeGeometry` → libavoid → `keepEdgeStyles` → label passes → write → check report |
| `check <file>` | the report only; never writes |

Exit status: `0` done (warnings and notes may follow); `1` the diagram has errors, cannot be read, or cannot
take the command (the reason is printed; nothing written); `2` usage; `4` an engine could not START (nothing
written). A diagram an engine cannot process is `1`, never `4`: SKILL.md tells the avatar to report a `4`.
Limits: 8 MiB, 3000 cells, 400 connectors between shapes for `route` (libavoid: 300 in ~5 s, 700 in ~66 s, then
minutes; the vendored pass routes EVERY shape-to-shape connector, also the ones `keepEdgeStyles` puts back, so
all of them count).

- **Reading**: UTF-8 only (`TextDecoder` fatal — a CP949 file would be rewritten with U+FFFD labels).
- **`repairIfNeeded`**: a well-formed file is taken AS IT IS (declaration, comments, formatting stay). Only
  a file that does not parse, whose root is not `mxfile` / `mxGraphModel` (a diagram wrapped in another
  element parses and draws nothing), or whose default layer is its own parent goes through upstream's
  `repair-xml.js` (text around the diagram, `<` / bare `&` in values, the layer re-parented).
- **`canonicalAttributes`** (see Gotchas) runs before every pass and before `check` scans cells.
- **`fitLabels`** (Noah): grows a box whose label does not fit, width first; nothing shrinks or moves. It
  runs before ELK because the layout keeps the sizes it is given (`resizeParent: false` — no renderer to
  measure with). Hard line breaks do not widen a box; a diamond/ellipse is widened until its line fits
  unwrapped (the viewer wraps at the BOX width, so a wrapped row would cross the outline).
- **`normalizeDiagram`** (upstream, `layout` ONLY): edges filed at the nearest common ancestor of their
  ends, a geometry for an edge written without one, containers grown around children. `route` must not
  resize anything, so it only adds the missing edge geometry (`ensureEdgeGeometry`).
- **`layout` refuses** a page with swimlanes (`pagesWithLanes`: a `swimlane` with `horizontal=0`, or two
  sibling swimlanes that tile — ELK moves each lane on its own and the lane grid falls apart; titled
  containers that merely sit next to each other are laid out normally), a page with shapes on more than
  one layer (`pagesWithLayers`: ELK arranges ONE layer), and a result in which it put shapes on top of
  each other (an unconnected shape under `radial` collapses the page; a non-tree under the tree flows
  throws). "It put": `overlapState` compares each leaf's geometry before and after, so an overlap between
  two shapes the layout never moved — the rows of a `stackLayout` written without `y` — is the author's and
  only reported.
- **Free text** (a `text` cell on the layer that no connector touches: a title) is kept out of the graph
  with the bridge's `cellFilter` and put back above the result (`freeText` / `placeAbove`).
- **`keepEdgeStyles`** (`route` ONLY): the router turns every connector it touches into a right-angled
  one. A connector drawn straight (no `edgeStyle`), curved (`curved=1`) or as an entity relation is a
  choice the skill prescribes for state/network/ER diagrams, and `route` moves nothing, so it gets its
  style and geometry back. `isRightAngled` (`check.mjs`) is the one definition. **`layout` does NOT do
  this** (tried 2026-11-14 and removed): it moves every shape, and a straight line between the new places
  ran through shapes in every fuzzed graph. `layout` redraws every connector right-angled and says so;
  SKILL.md sends a diagram that needs straight or ER lines to the grid + `route`.
- **`route` writes `libavoidRouting=1`** on each routed edge (upstream's canonical style): a current
  draw.io keeps such an edge auto-routed when the user moves a shape. The app's viewer (older, pinned in
  `src/client/public/drawio/`) draws the stored waypoints and ignores the flag.
- **The write** goes through a link to the file it names (realpath), keeps the file's mode, is a temp
  file + rename next to the target, and refuses a target inside the skill folder.

## Findings (`lib/check.mjs`)

Each line is `level [code] page "…", cell 'id': message — fix: …`; at most 8 per code are listed, then
`… and N more [code]`; the summary line counts all of them. The avatar acts on the code and the fix;
SKILL.md §4 says how many rounds.

| Level | Codes |
|---|---|
| error | `not-a-diagram`, `malformed-xml` (with the line; also a duplicate attribute and a declaration that is not first — the viewer draws nothing), `needs-repair`, `no-page`, `missing-root`, `missing-layer`, `cell-without-id`, `duplicate-id`, `self-parent`, `parent-cycle`, `unknown-parent`, `no-parent`, `vertex-without-geometry`, `edge-without-geometry`, `dangling-edge`, `unreadable-page` |
| warning | `overlap` (any two leaf shapes on the page, or two sibling containers), `outside-container`, `edge-through-shape` (a stored route), `edge-may-cross-shape` (no stored route: the straight line, plus the one-bend elbow when the edge has an `edgeStyle`), `label-overflow` (a shape's label, or a swimlane's title), `label-on-cap` (a cylinder without `boundedLbl=1` whose centred label reaches the cap's arc: a short cylinder, or a label of several lines — seen in the viewer), `small-font`, `long-edge-label`, `edge-label-covers-shape`, `unbundled-icons`, `unattached-edge`, `empty-page` |
| note | `compressed-page`, `default-font-size`, `edge-label-background`, `large-diagram`, `check-incomplete` |

`layout` / `route` refuse on any error except `edge-without-geometry` (they repair it), and on
`compressed-page`. That one is only a NOTE in `check`: the viewer draws a compressed page
(`chat-sse-media.md` gotcha 6), so a pass-along file must not be called broken.

- **Hidden cells are not on the page**: `visible="0"`, or inside a hidden or `collapsed="1"` ancestor
  (`isHidden`) — neither a shape to check nor an obstacle.
- **A line is "through a shape" only for LEAF shapes.** A connector crossing the body of a group or of a
  lane it passes is how such diagrams look (the router has no other way from lane 1 to lane 3).
- **Text is estimated, never measured** (`lib/text.mjs`): Hangul, kana, CJK and full-width characters are
  one em, Latin about half. Upstream's headless estimate counts every character as 0.6 em; `passes.mjs`
  replaces it (`mxUtils.getSizeForString`) so ELK reserves enough room for Korean edge labels. Turned text
  (`horizontal=0`, a rotated shape) and labels placed outside their shape are not measured.
- **`shapeName`** reads the RAW style: `shape=<name>`, else a bare word draw.io's stylesheet knows
  (`ellipse`, `rhombus`, `triangle`, `swimlane`, `text`, `group`, …). A bare `hexagon` or `cloud` is NOT a
  style and draws a plain box (seen in the viewer) — SKILL.md §2 gives those as `shape=<name>`.
- **`BUNDLED_STENCILS`** must equal the stencil sets in `src/client/public/drawio/stencils/`
  (`tests/drawio-skill.test.ts` keeps them equal): adding a stencil XML to the viewer means adding its name
  there, or `check` keeps warning about shapes the preview now draws.

## Gotchas

- **The cell scanners read a tag up to its first `>` and double-quoted values only** (upstream's
  `mx-xml.js`, and `check.mjs`'s own). A raw `>` in a value — legal XML, and what the upstream repair
  leaves of an unescaped `<br>` (`A&lt;br>B`) — cuts the cell short: it loses its `vertex`/`parent`
  attributes and silently leaves the model, so it is not laid out and its edges stay unrouted. A
  single-quoted `value='<span style="…">'` is worse: the write-back replaces the first `style="…"` in the
  tag, i.e. the one INSIDE the label. Every pass therefore runs on `canonicalAttributes(xml)` (double
  quotes, `&gt;`, `&quot;`); keep that call first when adding a pass.
- **The upstream passes never throw.** `transformPages` leaves a page it cannot process as it was, and
  `routeXml` hands the input back on any failure. So `passes.mjs` records ELK failures itself and checks
  the wasm before routing; do not read "no exception" as "it ran".
- **A parent cycle never ends a walk up the tree** (`isAncestor` in the vendored model, reached from
  normalize and the router): `check` reports `parent-cycle` from the raw cells and skips the model for
  that page, and `layout` / `route` refuse on it. Keep new structural errors in `structuralFindings`,
  which reads no model.
- **Do not load libavoid twice** (`AvoidLib.load` logs "already initialized" on stdout, into the report).
- **`src/` is upstream verbatim and hash-pinned** by the test. A fix belongs in `lib/` or in the
  offline stand-in `src/cdn-cache.js`, never in a vendored file.
- The engine folder has its own `package.json` (`"type": "module"`): the upstream `.js` files are ESM.
- LICENSEs: Apache-2.0 (drawio-mcp), EPL-2.0 (ELK inside the bundle), LGPL-2.1+ (libavoid-js, unmodified).
- **A commented-out `<mxCell>` is a cell to the vendored passes**: an old copy of a cell left in a comment
  takes the write meant for the live one (the new position lands inside the comment). `check` scans a
  comment-free copy; `layout` / `route` refuse the file and say to delete the comment.
- The report after a command (`checkDiagram(xml, { after })`) never sends the avatar to the OTHER command:
  SKILL.md says to pick one.
- Known and left: `route` treats HIDDEN shapes (a hidden layer, the children of a collapsed group) as
  obstacles, so a line may detour around nothing visible; a port with relative geometry is placed at
  absolute coordinates by the vendored libavoid pass; an edge whose end is a zero-size shape is not
  routed.

## Verification

- `rtk proxy npx vitest run tests/drawio-skill.test.ts` — runs the CLI from a COPY of the skill folder
  (as the sandbox has it): hashes, no-network sources, every finding class, route keeps positions, sizes
  and non-right-angled connectors, layout leaves no overlap / crossing / overflow, lanes and layers
  refused, titles, single quotes / declaration / comments kept, non-UTF-8 and parent cycles refused,
  nothing written on a refusal, usage statuses, links and modes.
- A look at the result needs a browser: render before/after files with the app's viewer
  (`src/client/public/drawio/viewer-static.min.js`, same `window.*_PATH` globals as
  `lib/drawioViewer.ts`) in headless Chromium. Done on 2026-11-14 for a cramped Korean architecture
  diagram, swimlanes (grid of SKILL.md §3 B), nested containers and the shape names SKILL.md lists; the
  only console message was the documented `/drawio/math/startup.js` 404.
- An independent review pass (2026-11-14) ran the tool on constructed and fuzzed inputs against that
  viewer; its findings are what the bullets above record.
- Not verified: a run in a real pi sandbox (read-only rootfs, 1 CPU, 256 pids), and how a model
  actually uses the tool across turns.
