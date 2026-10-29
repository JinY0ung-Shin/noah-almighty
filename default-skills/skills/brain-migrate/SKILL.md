---
name: brain-migrate
description: One-time idempotent upgrade of an already-connected personal knowledge repo to the second-brain vault layout. Use when the owner asks to "set up / upgrade my second brain", or when a connected repo predates the vault layout (no wiki/ folder, an old CLAUDE.md stub). Creates the missing wiki/ skeleton and seeds the brain philosophy WITHOUT ever overwriting existing files. Uses only mcp__repo__*; the second brain is personal, so never a group repo.
---

# brain-migrate — upgrade an existing repo to the vault layout

The knowledge repo acts as a **second brain**: raw capture in `raw/`, consolidated durable
notes in `wiki/`. A repo created before this layout existed (for example an old deployment
whose repo only has a short `CLAUDE.md` stub and no `wiki/`) needs a one-time upgrade. This
skill performs that upgrade **idempotently** — running it twice changes nothing the second time.

## Scope
Personal repo only: `mcp__repo__list_files`/`mcp__repo__read_file`/`mcp__repo__write_file`/`mcp__repo__commit`.
The second brain is personal — there is no team brain, so if the user asks to set one up for a
group, say so plainly and do not write a vault into the group's shared repository.

## Procedure (create-if-absent only — NEVER overwrite)
1. **List the current tree** with `mcp__repo__list_files`. Do not assume. Call every tool by its full
   `mcp__repo__…` name, never a bare tool name.
2. For EACH path below, write it ONLY if it is absent; skip silently if present:
   - `raw/.gitkeep`
   - `wiki/sources/.gitkeep`, `wiki/entities/.gitkeep`, `wiki/concepts/.gitkeep`, `wiki/synthesis/.gitkeep`
   - `wiki/index.md` — a short `# Index` header listing the four wiki sections.
   - `wiki/log.md` — a `# Reflection log` header for brain-reflect to append to.
   - `wiki/_template.md` — the note template (title, date, source, tags, aliases, then body).
3. **Root `CLAUDE.md`:**
   - If absent, seed it with the second-brain philosophy block.
   - If present, read it (`mcp__repo__read_file`). If it ALREADY contains the marker `<!-- brain:philosophy -->`,
     do nothing (already migrated). Otherwise read the FULL file, then write (`mcp__repo__write_file`) the ORIGINAL
     content verbatim followed by this block appended at the end (a write is a full-file
     overwrite, so you MUST include the original text or you will erase it):

     ```
     <!-- brain:philosophy -->
     ## Second brain
     This repo is a second brain. `raw/` holds timestamped raw capture; `wiki/` holds
     consolidated durable notes (sources / entities / concepts / synthesis). Use brain-ingest to
     capture, brain-reflect to consolidate, brain-lint for hygiene.
     <!-- /brain:philosophy -->
     ```
4. **Commit once** (e.g. `chore(brain): migrate repo to vault layout`). Only commit if something changed.
5. **Report** what you CREATED vs SKIPPED.

## Safety
- Use the MCP repo tools ONLY. Never run `git` via Bash (the shell has no credentials; remote
  git is MCP-only by design).
- `mcp__repo__write_file` overwrites the whole file. To "append" to `CLAUDE.md` you MUST read it first and
  write back original + block. Never truncate or drop existing content.
