# Vendored draw.io viewer (offline)

Read-only renderer for `.drawio` attachments opened as a tab of the chat's side panel
(`FileTab.svelte`, loaded on demand by `src/client/src/lib/drawioViewer.ts`).
Vendored because the deploy environment has no internet access and the app CSP is
same-origin only.

- Source: https://github.com/jgraph/drawio — tag **v31.1.5**
  - `viewer-static.min.js` ← `src/main/webapp/js/viewer-static.min.js`
  - `stencils/*.xml` ← `src/main/webapp/stencils/` (curated subset, see below)
- License: `LICENSE` (Apache 2.0, applies to the JS); `stencils/LICENSE` covers the
  stencil XMLs. The upstream stencil restriction only forbids use inside Atlassian
  products/marketplace — not applicable to this app.

## Stencil subset

Only the small, commonly used stencil sets are vendored (`basic`, `arrows`,
`flowchart`, `bpmn`, ~150 KB total). The big vendor icon libraries (aws4 6.5 MB,
cisco19 1.8 MB, azure, gcp, …) are NOT included: a diagram using them still renders,
but those shapes degrade to labeled placeholder boxes. To support more sets, drop the
matching XML from the same upstream tag into `stencils/` — no code change needed
(`window.STENCIL_PATH` already points here).

Math typesetting (MathJax) is intentionally not vendored; `DRAW_MATH_URL` points at a
dead same-origin path, so math labels render as raw text.

## Upgrading

Re-download `viewer-static.min.js` and the stencil XMLs from one upstream tag (keep
them in lockstep), update the tag above, and re-verify under the app CSP: the viewer
must render without `unsafe-eval` and without external requests (see the
draw.io viewer notes in `docs/architecture/chat-sse-media.md`).
