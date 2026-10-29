---
name: brain-search
description: Recall from the second brain — search the curated wiki/ notes in your knowledge repo BEFORE answering anything that could draw on accumulated knowledge (owner preferences, prior decisions, people/projects, recurring topics). Read-only; works on the personal brain (mcp__brain__*). Available to the owner and trusted same-group teammates.
---

# brain-search — recall from the second brain

Your knowledge repository is a vault: `wiki/` holds curated, durable notes distilled from past
conversations, decisions, people, and concepts; `raw/` holds unprocessed captures. This skill is the
**read** side (capture is brain-ingest, consolidation is brain-reflect).

## When to use
Call search BEFORE answering from memory whenever the question could draw on accumulated knowledge —
the owner's stable preferences, prior decisions and their rationale, people/projects/systems, or a
recurring topic. Prefer recalling what is already written down over re-asking the user or guessing.

## Tools (read-only)
- **Personal brain:** `mcp__brain__search` (ranked hits with path + snippet) then `mcp__brain__get_note`
  to read a full note (wiki-scoped; `mcp__repo__read_file` reads other repo paths).
- There is no team brain: the second brain is personal only. A group's shared repository is read
  with `mcp__group_repo__list_files`/`mcp__group_repo__read_file`, not searched here — and a group
  repo's notes that mention `mcp__group_brain__*` predate its removal.

## How to search well
1. Start with the most specific keywords or a natural-language phrase; titles/aliases rank highest,
   then tags, then body.
2. If the first query is thin, retry with synonyms or an alternate name (a person's role, a project
   alias) and raise `limit` (up to 20).
3. Read the most relevant hit in full with `mcp__brain__get_note`, then follow any linked notes / `[[references]]`
   it points to — the best context is often one hop away in `synthesis/`.
4. Cite what you found by note path so the user can trace it; never fabricate a fact the notes don't
   support, and don't present a `raw/` capture as settled — `wiki/` is the curated layer.

## Edge cases
- **`NO_VAULT`** — the repo predates the vault layout; run the **brain-migrate** skill ONCE (it never
  overwrites existing files), then retry.
- **No matches** — it may simply not be captured yet. Answer from the live conversation, and (owner
  only) offer to capture it with **brain-ingest** if it is durable.
- **No repo connected** — there is nothing to search; if you are the owner, create one with
  `mcp__repo__create_repo` first. Do not retry searches via Bash.
