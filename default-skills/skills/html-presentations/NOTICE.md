# Source

Adapted from the `html-presentations` skill of [ericmjl/skills](https://github.com/ericmjl/skills)
(`skills/html-presentations`, commit `a4be0bf7ce87dff7aadc7bd128486e9c75ff01db`), by Eric Ma. Its `SKILL.md` declares
`license: MIT`; the upstream repository carries no LICENSE file, so there is no notice text to copy here.

What Noah's copy changes:

- The page shell reads WITHOUT script (slides stacked, each a 16:9 block) and becomes a deck only when its script
  runs (`html.js`); every hidden start state sits under `.js`, and lengths inside a slide are `vw`, never `vh`.
  Noah's 파일 tab draws a page with its scripts removed and fits the frame to the page's height.
- The description sends PowerPoint requests, and decks with no format named, to the `pptx` skill.
- The exemplar `assets/example-agent-skills-overview.html` is rebuilt on that shell. Upstream's second exemplar
  (`canvas-chat-overview.html`, scripted interactive demos) is left out.
- The author's notes for his other decks ("deck tenets") and the `uv run` guideline are left out; a delivery
  section for Noah (`share_file`) is added.
