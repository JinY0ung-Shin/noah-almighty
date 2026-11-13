---
name: brain-share
description: Pick the notes in the personal second brain that are worth sharing with the team brain — reusable conclusions only, never working detail — skip what the team already has, what already has a card and what the owner kept personal, then draft team-brain cards for the best few. Use when the owner asks what from their own notes should go to the team ("팀에 올릴 만한 것 골라줘", "팀 위키에 공유할 거 찾아줘", "내 노트 중에 팀에 공유할 것"). Owner's own interactive chat only; nothing is shared until the owner presses each card.
---

# brain-share — pick personal notes worth sharing with the team

A selection pass over the personal brain's `wiki/`: find the few notes a teammate would actually
reuse, and draft a team-brain card for each. The pass selects and drafts; the owner's press on a card
is what writes the team brain — nobody reviews it afterwards, so draft only what you would stand behind.

## Scope
- **Reads** the personal brain (`mcp__repo__list_files`, `mcp__brain__get_note` / `mcp__brain__search`
  with scope `"personal"`) and the team brain (scope `"team"`).
- **Drafts** cards with `mcp__brain__prepare_team_changes` — the compiled wiki pages plus the note's
  passage as their `source`. It never writes the team brain and never presses anything.
- **Writes the personal repo for ONE thing only:** the mark of a note the owner keeps personal (step 7).
- **Which run:** only where `mcp__brain__prepare_team_changes` exists — the owner's own interactive chat. In any
  other run (a routine, an API task, a teammate's chat) say that this pass needs the owner's own chat
  and stop; do not list candidates from rules this run does not carry.
- **The rules:** follow the Brain policy in your instructions (SELECTING FOR THE TEAM, KEPT PERSONAL,
  BEFORE A TEAM CARD, ONE FACT ONE HOME, WHEN THEY DISAGREE) and, in the team-brain section, the TEAM
  KNOWLEDGE tests, THE RIGHT LEVEL, the INTAKE rules and WRITING THE TEAM BRAIN. This skill is the
  procedure; it does not restate them, and when the two seem to differ the instructions win.

## Procedure
1. **Gather.** List the personal `wiki/` notes (`sources/`, `entities/`, `concepts/`, `synthesis/`; not
   `index.md`, `log.md`, `_template.md`). `raw/` captures are not candidates — if `wiki/` is nearly empty
   but `raw/` is not, say so and suggest brain-reflect first.
2. **Drop what the pass may never select** (SELECTING FOR THE TEAM names them): read each note with
   `mcp__brain__get_note` — it marks LINK and PROMOTED notes — and check the frontmatter for the
   kept-personal mark. Keep a count of each group for the report.
3. **Drop what already has a card.** A note you drafted a card for earlier in this conversation is not
   drafted again while that card is unpressed (SELECTING FOR THE TEAM); a card the user cancelled is a
   "no" to ask about under KEPT PERSONAL.
4. **Judge what is left** against the TEAM KNOWLEDGE tests and THE RIGHT LEVEL — both, strictly. For a
   note that passes only in part, the candidate is the PART that states the reusable conclusion, never
   the whole note. Most notes of a personal brain do not pass; a pass that finds nothing is a good
   result, not a failure.
5. **Check the team brain** for each survivor (`mcp__brain__search`, scope `"team"`, by title and key
   terms). Already there and saying the same → not a candidate (ONE FACT ONE HOME). There but saying
   something different → not a candidate either: report it under WHEN THEY DISAGREE.
6. **Rank and draft.** Order the candidates by how many teammates would need each and how often, and
   take the top ones up to the pass limit. Read the team brain's `SCHEMA.md` and `wiki/index.md` once
   (`mcp__brain__get_note`, scope `"team"`). For each candidate, in turn:
   - the source and the INTAKE facts come from the note, as SELECTING FOR THE TEAM says — look in its
     frontmatter (`source`, `date`) and in the `raw/` capture it was compiled from before asking anything;
     what is still missing across ALL the drafts is asked ONCE, in ONE message;
   - compile the team wiki page(s) that passage belongs in, as WRITING THE TEAM BRAIN says — one card
     per note;
   - pass the note's `wiki/` path in `personalNotes`;
   - call the tool. Do not ask "shall I draft this one?" per candidate — asking for the pass was the yes
     to draft (not to share).
7. **Report** in one compact answer, in the user's language:
   - the cards drafted — title and ONE line on why a teammate needs it — and that nothing is shared
     until they press; each card is pressed on its own (SELECTING FOR THE TEAM), and a press writes the
     team brain at once;
   - the candidates left for the next pass, by title only;
   - counts of what was skipped and why (too detailed, already in the team brain, already has a card,
     kept personal, linked or promoted) — no per-note list unless asked.
   When the owner then says a candidate should not go to the team, follow KEPT PERSONAL (mark the note,
   commit, one line) so the next pass does not bring it back.

## Never
- Never submit, press or claim anything was shared: a draft is a draft until the owner presses its
  card.
- Never lower the bar to fill the pass: fewer cards, or none, is the right result when little qualifies.
- Never paraphrase a note into a "shareable" version that says more, or something else, than the note
  does — select the passage, or leave it.
- Never read anyone else's notes or conversations for this.
