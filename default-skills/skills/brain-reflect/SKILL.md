---
name: brain-reflect
description: Consolidation pass over the personal knowledge repo — synthesize durable notes into wiki/{sources,entities,concepts,synthesis}/, update wiki/index.md and append wiki/log.md, then commit. Reads raw/ + wiki/ and may optionally review the owner's own recent conversations. Personal repo only — the second brain is personal.
---

# brain-reflect — consolidate the second brain

Move durable knowledge from `raw/` capture into the consolidated `wiki/`. Run on demand or when
asked to "tidy up / consolidate my notes".

## Scope
- **Personal repo only:** `mcp__repo__list_files`/`mcp__repo__read_file`/`mcp__repo__write_file`/`mcp__repo__commit`.
  The second brain is personal; never run this pass on a group's shared repository.

## Optional conversation pull
You MAY also review the owner's OWN recent conversations to mine durable facts worth consolidating
(this is the nightly conversation-reflection source): `mcp__system__list_recent_conversations`
(e.g. `sinceHours: 24`) then `mcp__system__read_conversation` per id. Both are owner-scoped — they
return nothing for conversations the owner does not own. Never read anyone else's conversations.

## Procedure (mem0-style: ADD / UPDATE / NOOP, prune the stale)
1. List and read `raw/` (and the existing `wiki/`).
2. Synthesize into `wiki/` using `wiki/_template.md`, filing under `sources/` (links/docs),
   `entities/` (people/projects/systems), `concepts/` (definitions/decisions), `synthesis/`
   (cross-cutting connections — the highest-value notes).
3. **Link related notes inline with `[[Note Title]]`.** When a note mentions an entity, concept, or
   source that has (or should have) its own note, reference it by its exact `title` (or a known
   `alias`) inside double brackets — e.g. "deployed via [[Deploy Pipeline]]". These links are what
   make the knowledge graph connect; a note with no `[[links]]` is an isolated dot. Prefer linking
   to an existing note; if the target does not exist yet but clearly should, the link is fine (it
   shows as a pending/dangling node until you create that note).
4. **Append-or-update, never mass-rewrite.** One fact, one home: UPDATE the existing note instead
   of forking a near-duplicate. Remove notes superseded by a newer decision.
   **A note states the CURRENT truth only.** When a fact changed, REPLACE the old value with the
   new one — never narrate the change inside the note ("previously X, changed to Y on <date>",
   "기존에는 … 였으나 <날짜>에 … 로 변경", a `## History` / `## 변경 이력` section, or an old value
   kept "for reference"). The dated context already lives in the `raw/` capture, and the change
   itself goes into your `wiki/log.md` entry (step 5) — that log is the ONLY place history belongs in
   `wiki/`. brain-lint deletes such narrative wherever it finds it, so do not write it.
5. Update `wiki/index.md` and APPEND a dated entry to `wiki/log.md` summarizing adds/updates/deletes
   — for an UPDATE that changed a value, one terse line naming the note and `old → new`; this is
   where the change history is kept, not in the note.
6. Optionally archive raw notes you fully consolidated.
7. **Commit once.** If a write or the commit fails, report what you found — do not retry via Bash.
