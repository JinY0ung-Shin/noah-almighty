---
name: confluence
description: Use when you need to search or read internal Confluence pages and their attached images / draw.io assets (READ-ONLY — page creation and editing go through the browser tools). Uses the app-wide MCP tools `mcp__confluence__*`; the host comes from the server env var `CONFLUENCE_URL` and auth from the owner secret `CONFLUENCE_PAT`.
---

# Confluence

This app registers app-wide Confluence MCP tools. For any Confluence-related request, do not reach
for Bash or an external Python script — use the tools below directly.

## Check configuration

First, if needed, check status with `mcp__confluence__describe_config`.

- `CONFLUENCE_URL` is a server env var.
- `CONFLUENCE_PAT` is a Personal Access Token stored in the avatar owner's secrets tab.
- You cannot see the values and must not print them.

## Read operations

- List spaces: `mcp__confluence__list_spaces`
- CQL search: `mcp__confluence__search`
- Get a page: `mcp__confluence__get_page`
- List a page's attachments: `mcp__confluence__list_attachments`
- Download an attachment: `mcp__confluence__get_attachment`
- Extract image / draw.io references from a page body: `mcp__confluence__extract_page_assets`

For search, use raw CQL or combine the `space`, `title`, `text`, and `label` conditions; add
`since_days` to keep only pages modified in the last N days. If you have a page URL or ID, resolve
the ID and read it with `get_page`. `get_page` returns the body as readable text by default
(`format: "text"`); a long page says how much was shown — call again with the `offset` it names to
read the rest. Pass `format: "storage"` only when you need the raw Confluence markup.

When you need an image or draw.io diagram, first use `extract_page_assets` to find the `ac:image`,
`ri:attachment`, and `ac:structured-macro ac:name="drawio"` references in the page storage body, then
fetch the needed attachments with `get_attachment`. PNG/JPEG/GIF/WebP attachments may be returned as
image blocks. When a draw.io diagram is stored only as `.drawio` XML, you can read the XML to
understand its structure, but you cannot convert it into an image yourself. To let the USER see the
diagram, save it as a `.drawio` file and hand it over with `mcp__file_output__share_file` — the chat's
file panel renders it interactively (see the `drawio` skill).

## These tools are READ-ONLY — write through the browser instead

No `mcp__confluence__*` tool creates, edits, or deletes anything, and no shell or fetch workaround
exists.

When the user asks you to create or edit a page, use the BROWSER tools if you have them
(`mcp__browser__*`): open the page or the Confluence editor with `navigate` / `new_tab`, then
`snapshot` → `click` / `type` / `fill_form` like any other site. That runs in the user's own logged-in
session, so the edit is attributed to them and they can watch and undo it. Say what you are about to
change before you save. If the Confluence host is refused, it is outside the operator's browser
allowlist — report that rather than looking for another route.

Without browser control, say plainly that you cannot write to Confluence and offer what you can:
draft the content in the chat for them to paste, or hand it over as a file with
`mcp__file_output__share_file`.
