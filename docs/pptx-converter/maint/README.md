# Font CSS generator (maintainers only)

`gen_fonts.py` wrote the converter's `fonts/fonts.json`, `theme/fonts-embedded.css` and
`theme/fonts-malgun.css` in the proof of concept. Those files ship GENERATED in
`default-skills/skills/pptx/converter/` — never hand-edit them; rerun this generator instead when a font file,
a weight mapping or the malgun stand-in changes.

- **Inputs:** the vendored OFL fonts (`converter/fonts/`), `corpus_ko_business.txt` (synthetic Korean
  business text the width measurements run over), and Malgun Gothic (`malgun.ttf`, `malgunbd.ttf`), which it
  READS IN PLACE from a Windows installation to derive the malgun profile's `size-adjust` and line-metric
  overrides. Nothing from Malgun is copied; the outputs contain only numbers. Never add a Windows font file to
  this repository.
- **Paths:** the constants at the top are the PoC dev box's (`POC=/home/jinyoung/pptx-poc`,
  `/mnt/c/Windows/Fonts`). Point `FONTS`/`THEME` at `default-skills/skills/pptx/converter/{fonts,theme}`,
  `CORPUS` at the corpus here, and `MALGUN` at your Malgun files before running it with a Python that has
  `fonttools` (the dev venv from `docs/architecture/build-run-verify.md`). It also writes
  `malgun-css-params.json` and reads an optional `malgun-notes.txt` under the PoC's `scratch/fonts/`; redirect
  or drop those two paths.
- **Afterwards:** the rendering changed, so bump `converter/VERSION`, run
  `bash default-skills/skills/pptx/scripts/deck.sh selftest` (it reports drift against the goldens), check the
  decks in desktop PowerPoint, and only then run `selftest --update-golden` and commit the fonts, the CSS and the
  goldens together (`docs/architecture/pptx-converter.md` §Chromium drift, goldens and `--update-golden`).
- The PoC's reasoning, measurements and the SHA-256 of every shipped font file are in
  [`../research/fonts.md`](../research/fonts.md).
