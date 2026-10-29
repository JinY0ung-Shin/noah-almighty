---
name: brain-migrate
description: One-time idempotent upgrade of an already-connected knowledge repo (personal OR group) to the second-brain vault layout. Use when the owner asks to "set up / upgrade my second brain", or when a connected repo predates the vault layout (no wiki/ folder, an old CLAUDE.md stub). Creates the missing wiki/ skeleton and seeds the brain philosophy WITHOUT ever overwriting existing files. Uses only mcp__repo__* (personal) or mcp__group_repo__* (group).
---

# brain-migrate — upgrade an existing repo to the vault layout

The knowledge repo acts as a **second brain**: raw capture in `raw/`, consolidated durable
notes in `wiki/`. A repo created before this layout existed (for example an old deployment
whose repo only has a short `CLAUDE.md` stub and no `wiki/`) needs a one-time upgrade. This
skill performs that upgrade **idempotently** — running it twice changes nothing the second time.

## Scope detection
Decide the target from the user's requested repo, not from which tool families happen to be
visible. Owner conversations can expose BOTH personal `mcp__repo__*` tools and group
`mcp__group_repo__*` tools at the same time, so "personal tools exist" does NOT mean the
personal repo is the right target.

- **Personal brain requested / no group named:** operate on the personal repo with
  `mcp__repo__list_files`/`mcp__repo__read_file`/`mcp__repo__write_file`/`mcp__repo__commit`.
- **Group / team brain requested:** first call `mcp__group_repo__list_groups`, choose the named
  group (or ask which group if ambiguous), then operate ONLY on that group's shared repo with
  `mcp__group_repo__list_files`/`mcp__group_repo__read_file`/`mcp__group_repo__write_file`/`mcp__group_repo__commit`.
- Group writes are admin-only; if a write is denied, report which files are missing and tell the
  user a group admin must run this.

Decide scope once, up front. Never mix personal and group tools in the same migration.

## Procedure (create-if-absent only — NEVER overwrite)
1. **List the current tree** with the scope's list tool (`mcp__repo__list_files`, or `mcp__group_repo__list_files`
   for a group). Do not assume. Every tool below is the SAME scope's: call its full `mcp__repo__…` or
   `mcp__group_repo__…` name, never a bare tool name.
2. For EACH path below, write it ONLY if it is absent; skip silently if present:
   - `raw/.gitkeep`
   - `wiki/sources/.gitkeep`, `wiki/entities/.gitkeep`, `wiki/concepts/.gitkeep`, `wiki/synthesis/.gitkeep`
   - `wiki/index.md` — a short `# Index` header listing the four wiki sections.
   - `wiki/log.md` — a `# Reflection log` header for brain-reflect to append to.
   - `wiki/_template.md` — the note template (title, date, source, tags, aliases, then body).
3. **Root `CLAUDE.md`:**
   - If absent, seed it with the second-brain philosophy block.
   - If present, read it (`mcp__repo__read_file` / `mcp__group_repo__read_file`). If it ALREADY contains the marker `<!-- brain:philosophy -->`,
     do nothing (already migrated). Otherwise read the FULL file, then write (`mcp__repo__write_file` / `mcp__group_repo__write_file`) the ORIGINAL
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
- `mcp__repo__write_file` (and `mcp__group_repo__write_file`) overwrites the whole file. To "append" to `CLAUDE.md` you MUST read it first and
  write back original + block. Never truncate or drop existing content.
