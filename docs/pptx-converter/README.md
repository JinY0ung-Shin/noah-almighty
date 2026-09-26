# PPTX converter — preserved PoC evidence

The research and maintenance tooling from the HTML→editable-PPTX proof of concept that the `pptx` skill's
converter was ported from (2026-09). It is kept for maintainers who need to know WHY a mapping, a font
choice or a gate is the way it is — and what only real PowerPoint could still settle. Nothing here is
agent-facing or loaded at runtime. Paths inside the documents (`scratch/…`, `tools/…`, `out/…`,
`/home/jinyoung/pptx-poc`) are the PoC's and historical; each file says so in a header note.

The live documentation is elsewhere:

- [`../architecture/pptx-converter.md`](../architecture/pptx-converter.md) — how the converter is wired into
  Noah (CLI, budgets, locks, isolation, preview sidecar, probe, Docker, tests).
- `default-skills/skills/pptx/converter/README.md` and `converter/docs/CONTRACT.md` — the toolkit's
  maintainer guide and its IR / lint / gate contract.
- `default-skills/skills/pptx/reference/AUTHORING.md` and `EDITING.md` — what the agent follows when it
  writes slides, and what it tells users about editing the result.

| file | what it settles |
|---|---|
| [`research/text-mapping.md`](research/text-mapping.md) | IR text → native PowerPoint text boxes: `a:bodyPr`, line spacing and first-baseline parity, Korean line breaking, horizontal slack, constructs that make PowerPoint repair the file |
| [`research/shape-table-mapping.md`](research/shape-table-mapping.md) | shapes, pictures, slide backgrounds and tables → DrawingML via python-pptx; repair-prompt constructs |
| [`research/chart-mapping.md`](research/chart-mapping.md) | chart specs → native, editable charts with embedded workbooks (데이터 편집); data labels, axes, legend; repair triggers |
| [`research/fonts.md`](research/fonts.md) | the font decisions: Pretendard for the embedded profile, the metric-matched 맑은 고딕 stand-in (Gothic A1 + Selawik + Noto Sans KR VF), Chromium's hinting flag, LibreOffice notes, the SHA-256 of every shipped file |
| [`research/font-embedding.md`](research/font-embedding.md) | embedding TrueType into a `.pptx` for PowerPoint: package parts, the `.fntdata`/EOT format, OS/2 `fsType`, how PowerPoint maps runs to embedded faces |
| [`maint/`](maint/README.md) | `gen_fonts.py`, the generator of `fonts.json` and `theme/fonts-*.css`, with the corpus it measures |

Every research document labels its evidence (specification, PowerPoint-saved sample, field report, or a local
run) and ends with the open risks that only PowerPoint can confirm.
