---
name: brain-lint
description: Hygiene pass over the knowledge repo's wiki/ — find dangling links, stale or duplicate notes, notes missing required template fields, orphans not listed in index.md, and change-history noise (previously X, changed to Y on <date>) that belongs in raw/ rather than in a curated note; report and optionally fix, then commit. Works on the personal repo (mcp__repo__*) only — the second brain is personal.
---

# brain-lint — keep the second brain healthy

Check `wiki/` for hygiene problems and (when asked) fix them. Run on demand or after a big
brain-reflect pass.

## Scope
- **Personal repo:** read with `mcp__repo__list_files`/`mcp__repo__read_file`; fix with
  `mcp__repo__edit_file` (exact-snippet replacement — the default for every fix),
  `mcp__repo__move_file`/`mcp__repo__delete_file`, and `mcp__repo__write_file` ONLY when rewriting a whole note; then
  `mcp__repo__commit`. `mcp__repo__write_file` overwrites the entire file, so never use it to trim a passage.
- **`raw/` is read-only for this skill.** It is the original-capture archive: read it to judge
  what is current, never edit or delete anything in it. Lint edits land in `wiki/` only.

## Checks
1. **Dangling links** — links whose target note does not exist.
2. **Template drift** — notes missing `wiki/_template.md` fields (title/date/source/tags).
3. **Duplicates / near-duplicates** — propose a merge.
4. **Orphans** — notes not referenced from `wiki/index.md`.
5. **Stale notes** — the whole note is superseded by a newer decision in `raw/` / `wiki/log.md`.
6. **History noise** — a `wiki/` note states the CURRENT truth only. Remove passages that narrate
   how a fact changed instead of stating it: "previously X, changed to Y on <date>", "was X until
   <date>", "updated <date>: …" trails, "기존/과거에는 … 였으나 <날짜>에 … 로 변경", `## History` /
   `## 변경 이력` / changelog sections, and superseded values kept "for reference". Keep the
   current value (and its durable rationale, if any); drop the rest.
   - Where change history belongs: the original timestamped captures in `raw/` and the git
     history of the repo itself. Do NOT relocate removed history into the note, into
     `wiki/log.md` (reserved for brain-reflect's pass summaries), or anywhere else.
   - If the narrative is the ONLY place the current value appears, rewrite the sentence to state
     that value plainly, then delete the rest.
   - Two conflicting statements with no way to tell which is current → do NOT guess; report the
     conflict (and ask the owner when in an interactive chat).
   - The frontmatter `date` field is note metadata, not history — leave it.

## Output
Report findings grouped by check. If asked to fix, apply minimal edits (`mcp__repo__edit_file`), keep the
index in sync, then **commit once**. Removing history noise is a hygiene edit and needs no
per-item confirmation once the owner asked for fixes; anything that changes what a note actually
CLAIMS (a merge, deleting a whole note, a rewritten current value) still needs confirmation first.
Never overwrite a note's substantive content without confirmation.
