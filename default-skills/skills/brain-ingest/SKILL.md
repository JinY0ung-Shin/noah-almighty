---
name: brain-ingest
description: Capture a durable fact, decision, preference, or source into the personal knowledge repo's raw/ capture area, then commit. Use whenever the owner states something worth remembering long-term. Works on the personal repo (mcp__repo__*) only — the second brain is personal.
---

# brain-ingest — capture into the second brain

`raw/` is the inbox for raw, timestamped capture; `wiki/` is the consolidated layer (maintained
later by brain-reflect). This skill handles the **capture** step only.

## When to use
When something durable is stated — a decision and its rationale, a stable preference, a key fact,
a useful source/link, a definition. Do NOT capture transient chit-chat or anything the speaker did
not actually say. Never invent facts.

## Scope
- **Personal repo:** `mcp__repo__write_file` then `mcp__repo__commit`.
- **Personal only:** this skill writes the owner's OWN repo. The team brain is a separate, admin-curated
  wiki this skill never writes (its `raw/`/`wiki/` layout is Noah's, not this repo's).
- **Which brain:** follow the Brain policy in your instructions (PERSONAL KNOWLEDGE, WHERE IT GOES, ONE FACT
  ONE HOME; the TEAM KNOWLEDGE tests sit in the team-brain section, on runs that can submit) — this skill does
  not restate them. Personal knowledge is captured here without
  asking first. Team knowledge is OFFERED to the team (`mcp__brain__propose_team_note`; an admin uses
  `mcp__brain__prepare_team_changes`) only in the owner's own chat; when you also captured it here, pass the
  note's `wiki/` path in `personalNotes`. Before writing, search the team brain (scope `"team"`): a fact the
  team brain already holds is linked or mentioned, never copied in full.
- **No repo connected (personal):** if a write returns `NO_REPO` and `mcp__repo__create_repo` is
  available, offer to create the knowledge repo first; otherwise ask the owner to connect one.

## Procedure
1. Write to `raw/YYYY-MM-DD-<short-slug>.md`: a one-line title, the date, the source/speaker, and
   the captured content in the speaker's intent.
2. One idea per file when practical, so brain-reflect can consolidate cleanly. When the capture
   names an entity/concept that likely has a `wiki/` note, reference it inline as `[[Note Title]]`
   so brain-reflect (and the knowledge graph) can connect it later.
3. **`raw/` is where the dated context belongs — not the `wiki/` note.** If the capture changes a
   fact a `wiki/` note already states (a new value, a reversed decision) and you update that note
   now, REPLACE the old value so the note states the current truth only. Never add "previously X,
   changed to Y on <date>" / "기존 … 였으나 … 로 변경" narrative to a `wiki/` note: the `raw/` file
   you just wrote carries the date and the old context, and brain-lint deletes such narrative on
   sight.
4. **Always commit** after writing — an uncommitted write is not persisted.
5. Confirm briefly what you captured and where.
