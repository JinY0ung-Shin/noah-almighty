# drawio skill — layout engine (offline)

What `scripts/drawio.sh` runs: `drawio.mjs` (`layout` | `route` | `check`). It is run by the avatar in
its own pi sandbox, on files of its own, with Node only: no network, no browser, no npm install. The
sandbox has no network, so every engine is vendored here.

| Path | What | Origin |
|---|---|---|
| `drawio.mjs`, `lib/*.mjs` | The CLI, the checks, the label-fit pass, the pass wiring | Noah |
| `src/cdn-cache.js` | OFFLINE stand-in for upstream's CDN cache: same exports, serves `vendor/` | Noah |
| `src/mx-model.js`, `mx-xml.js`, `normalize-model.js`, `repair-xml.js`, `label-perimeter.js`, `edge-waypoints.js` | Headless mxGraph model, XML read/write-back, model repairs | [jgraph/drawio-mcp](https://github.com/jgraph/drawio-mcp) `shared/`, verbatim |
| `src/elk-engine.js`, `src/libavoid-pass.js` | Loader of the ELK bridge; the libavoid routing pass | jgraph/drawio-mcp `mcp-tool-server/src/`, verbatim |
| `vendor/elk/drawio-elk.min.js` | ELK + draw.io's mxGraph bridge (the editor's Arrange ▸ Layout) | `https://viewer.diagrams.net/js/elk/drawio-elk.min.js` |
| `vendor/libavoid/libavoid-node.mjs`, `libavoid.wasm` | libavoid-js, Node build | jgraph/drawio-mcp `mcp-tool-server/vendor/libavoid/` (`libavoid-js@0.5.0-beta.5`) |
| `vendor/libavoid/libavoid-routing.js` | draw.io's routing core over libavoid | same folder (equal to `https://viewer.diagrams.net/js/libavoid-js/libavoid-routing.js`) |

Pinned upstream: **jgraph/drawio-mcp `310aa3c4826f86f401d11a23f0d691dca60be6d9`** (2026-11-14);
`drawio-elk.min.js` is `@drawio/elk 0.1.0+commit.d2d0c30 (built 2026-11-06)` (its first line says so).
`tests/drawio-skill.test.ts` pins the SHA-256 of every vendored file, so a refresh is a deliberate edit.

## Licenses

- drawio-mcp files and the draw.io bridge: Apache-2.0 (`LICENSE`).
- ELK (inside `drawio-elk.min.js`): Eclipse Public License 2.0, unmodified.
- libavoid-js (`vendor/libavoid/`): LGPL-2.1-or-later (`vendor/libavoid/LICENSE`), unmodified; source at
  <https://github.com/Aksem/libavoid-js>.

## What is NOT upstream behaviour

- `src/cdn-cache.js` never opens a connection. Upstream downloads the ELK bundle and the routing core
  from the CDN and caches them per user.
- `lib/passes.mjs` drives the ELK bridge itself (upstream's `elk-pass.js` offers two directions; this
  offers every preset of the bridge's menu) and replaces the bridge's label measure with a CJK-aware
  one (`lib/text.mjs`): upstream counts every character as 0.6 em, half of what Hangul takes.
- `lib/xmlcheck.mjs` `canonicalAttributes`: the upstream cell scanner reads a tag up to its first `>` and
  double-quoted values only. A raw `>` inside a value (legal XML; what `A&lt;br>B` leaves behind) cuts the
  cell short and drops it from the model, and a single-quoted label holding `style="…"` gets that inner text
  overwritten as if it were the cell's style. Every pass here runs on XML with values in double quotes and
  `>` written as `&gt;`.
- Upstream repairs every input; here a file that parses is taken as it is (`repairIfNeeded`), so a
  declaration and comments survive.
- `route` does not call upstream's `normalizeDiagram` (it grows containers); it only adds a missing edge
  geometry, and it gives a straight, curved or entity-relation connector its style and geometry back
  (`keepEdgeStyles`): upstream turns every connector it routes into a right-angled one. `layout` keeps
  upstream's behaviour there (every connector right-angled).
- `layout` keeps free text cells (a title) out of the graph through the bridge's `cellFilter`.

## Refreshing

Take the files from ONE drawio-mcp commit and the two CDN files of the same day, keep `src/cdn-cache.js`,
update the pin above and the hashes in the test, then run `tests/drawio-skill.test.ts` and look at a
before/after render of a diagram with lanes and one with nested containers in the app's own viewer
(`src/client/public/drawio/`, a different pinned draw.io version: the passes only write geometry and
styles that viewer already draws; `labelPlacement`, `defaultLabelBackgroundColor` and `labelPerimeter`
are ignored by it, `labelBackgroundColor=default` and `libavoidRouting=1` are not a problem).

`BUNDLED_STENCILS` in `lib/check.mjs` lists the stencil sets that viewer ships; the test keeps the two
equal.

Bump `VERSION` when a command, an option, an exit status or a finding code changes.
