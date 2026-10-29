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
- **Not a group repo:** the second brain is personal only. A group's shared repository has no
  `raw/`/`wiki/` capture flow; edit it as an ordinary file with the `mcp__group_repo__*` tools when
  asked (group writes are admin-only).
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
