# pptx skill — HTML → editable PPTX converter (maintainer guide)

The toolkit behind `../scripts/deck.sh`: agent-authored slide HTML (component kit `theme/`, chart renderer `lib/`) is
rendered in a network-blocked, CSP-locked headless Chromium, measured into an IR, rebuilt as native PowerPoint
objects with python-pptx, gated, and delivered with hash-bound previews. It is the Noah port of the HTML → PPTX
proof of concept, whose research is preserved under `docs/pptx-converter/` in the repository. The contract is
[`docs/CONTRACT.md`](docs/CONTRACT.md); the agent-facing rules are the skill's `reference/AUTHORING.md`.

This directory is **read-only at runtime** (root-owned in the image): the converter never writes here, and a deck
folder inside the skill directory is refused.

## Layout

```
VERSION                  1.0.0 — generator "noah-pptx-converter/<VERSION>" in every preview manifest
requirements.txt         the pinned Python set (the image installs it through the pip mirror)
docs/CONTRACT.md         the maintainers' contract (roots, isolation, runs, gates, previews, self-test, IR)
fonts/                   vendored OFL fonts + licenses + fonts.json (GENERATED) — see fonts/README.md
theme/                   base.css (rendering rules + component kit), fonts-<profile>.css (GENERATED)
lib/chart.js             the one script a slide may load: draws the in-page preview of a native chart
tools/deck.mjs           the CLI (check / build / probe / selftest), run through ../scripts/deck.sh
tools/lib/*.mjs          orchestration: deckfs (roots, names, caps), locks (abstract sockets), proc (children,
                         watchdog, run temp dir), pipeline (stages, budget, delivery), gates (D12), report, probe,
                         selftest
tools/extract.mjs        HTML -> IR (tools/extract/: chromium.mjs resolver, server.mjs router + CSP, pixels.mjs
                         image-header pixel sizes (the decoded-pixel budget), browser.mjs launch/rasters, cmap.mjs,
                         inpage/*.js; README.md = extractor internals)
tools/build_pptx.py      IR -> PPTX (tools/pptxlib/*), embed_fonts.py + eot.py (EOT font parts)
tools/check_fidelity.py  the structure fidelity gate; inspect_pptx.py (inspect + font-coverage), office_check.py
tools/gates/             shape_table_lint.py, chart_verify.py, chart_lint.py, indep_check.py, xsd/ (ECMA-376, NOTICE.md)
tools/previews.py        1920x1080 previews + manifest (the attached 30 fitted into the server's 32 MiB), overview sheets
tools/pdeathsig.py       Python children die with their parent
selftest/deck/           the PoC's 4 slides (frozen), selftest/features/ (images, JPEG, deck.css, notes, soft wraps),
                         selftest/golden/*.ir.json, selftest/tools/make_assets.py (asset provenance)
```

## Commands

```sh
bash default-skills/skills/pptx/scripts/deck.sh --help                 # the reference (docs are generated from it)
bash default-skills/skills/pptx/scripts/deck.sh probe --json          # toolchain facts (the server's boot probe)
bash default-skills/skills/pptx/scripts/deck.sh check  <deck> [--profile both]
bash default-skills/skills/pptx/scripts/deck.sh build  <deck> [--profile malgun] [--strict]
bash default-skills/skills/pptx/scripts/deck.sh selftest [--fail-on-drift] [--record F] [--keep DIR]
```

Dev box (no Debian Chromium): a Python 3.11 venv with `requirements.txt` and the Playwright-cache Chromium —

```sh
uv venv ~/.venvs/noah-pptx --python 3.11
uv pip install --python ~/.venvs/noah-pptx/bin/python -r default-skills/skills/pptx/converter/requirements.txt
export NOAH_PPTX_PYTHON=~/.venvs/noah-pptx/bin/python NOAH_PPTX_DEV=1
NOAH_PPTX_E2E=1 npx vitest run tests/deck-converter.test.ts          # + the toolchain e2e suite
```

Never build a deck inside this directory: copy `selftest/deck` or an example into a scratch folder first. Every
command leaves nothing here (`tests/deck-converter.test.ts` asserts an unchanged tree hash and no `__pycache__`).

## Updating fonts

The four Pretendard files are embedded into every `embedded` deck; the others only measure. To change a font:
replace the file (unmodified upstream bytes, with its OFL text), regenerate `fonts.json` and `theme/fonts-*.css` with
the PoC font generator and its validators (never hand-edit them), update `fonts/README.md` (bytes, SHA-256,
upstream URL), bump `VERSION`, run `deck.sh selftest`, check the decks in PowerPoint, then refresh the goldens (below).
The image's fontconfig file registers every face except `NotoSansKR-VF.ttf`.

## Golden IR and drift

`selftest` builds both frozen decks in both profiles and compares each IR with `selftest/golden/<deck>.<profile>.ir.json`
(numeric leaves |Δ| > 0.01, strings, booleans, nulls, array lengths, the lint multiset). Integrity failures fail the
image build; drift is recorded (`/usr/local/share/noah-almighty/deck-selftest.json`) and surfaces in `probe`, the
boot log and describe_system — Chromium updates from bookworm-security are the usual cause. When drift is reported:

1. build the self-test decks (`deck.sh selftest --keep /tmp/st`) and open them in Windows PowerPoint — the photo,
   notes and soft-wrap slides of `features` in particular;
2. if they are right, run `bash default-skills/skills/pptx/scripts/deck.sh selftest --update-golden` on a dev box
   (refused where this directory is not writable), commit the golden files, rebuild the image.

Goldens are regenerated ONLY after that spot-check: they are the evidence that the IR a deck is built from still
matches what was verified.

## Versioning

`VERSION` is the converter's output version (`generator` in manifests, `converterVersion` in probe and record).
Bump it whenever the output changes (extractor measurement, builder XML, fonts, component kit), together with the
goldens. A PoC-equivalence reference: the frozen `selftest/deck` IR is numerically identical to the PoC's IR, and its
decks are part-for-part identical to the PoC's except `docProps/core.xml` and the embedded chart workbook.
