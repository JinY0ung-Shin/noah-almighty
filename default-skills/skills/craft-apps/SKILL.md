---
name: craft-apps
description: Use when `mcp__photocraft__*` (or another Craft app's `mcp__vectorcraft__*` / `mcp__designcraft__*` / `mcp__figcraft__*`) tools are available in this run and the user wants an image or design edited or created — retouching, compositing, resizing, filters, text on images, layered PSD work (사진 편집, 이미지 보정, 합성, 리사이즈). Covers the in/out folders, staging workspace files, verifying with render_preview, and delivering results with share_file. Does nothing when no Craft tools are registered (an admin-only beta).
---

# Craft apps (PhotoCraft, …)

Craft apps are ArtCraft editors running **headless** in an isolated, network-less
craft-runner container. You drive them only through their MCP tools; they never see your
workspace directly. Check the Craft line of your self-state (or `mcp__system__describe_system`)
for which apps are available in THIS run and the exact session paths — if no Craft tools are
registered, say so and point to the reason given there instead of trying.

## 1. Files: in/ and out/

The apps READ the session's `in/` and `out/` folders and WRITE only under `out/` (absolute
paths like `/exchange/work/<session>/in/...`, given in your self-state). Never pass a
workspace path to an app — it is rejected (`automation path rejected: ...`).

Mirrored into `in/` automatically at the start of every message:

| App path | Workspace path |
|---|---|
| `in/attachments/…` | `attachments/…` (the user's chat images) |
| `in/captures/…` | `captures/…` (browser screenshots) |
| `in/confluence/…` | `confluence/…` (saved Confluence attachments) |
| `in/craft-out/…` | `craft/out/…` (results of earlier turns) |
| `in/staged/<name>` | any other file you staged this turn |

For any OTHER workspace file (something you downloaded or generated), call
`mcp__craft_files__stage {path}` first and open the path it returns. A file attached in the
user's CURRENT message is already under `in/attachments/`.

Everything an app writes under `out/` is mirrored after each Craft call into your workspace at
`craft/out/` (`out/poster.png` ↔ `craft/out/poster.png`). `craft/out/` is a server-managed
mirror — do not put your own files there; work on copies elsewhere.

## 2. Workflow

1. **Open or create**: `doc_open {path: "<in>/attachments/photo.jpg"}` or `doc_new {width, height, …}`.
2. **Inspect** before editing: `doc_inspect` (layer tree, active layer, history).
3. **Edit** with engine commands. Find ids with `command_list {filter: "blur"}`, then
   `command_run {id, params}` — the argument is `id`, NOT `command`; `params` is a JSON object
   per the command's `params` doc. Several steps: `command_batch {steps: [{id, params}, …]}`.
   Long commands (filters, Content-Aware Fill) wait by default; `wait: false` starts a job you
   poll with `jobs_list`.
4. **Verify** after every meaningful edit: `render_preview {max_side: 1024}` (≤ 1568). Look at
   the image and fix what is wrong. **Never tell the user an edit is done without a preview
   that shows it.** The user sees each preview in the side panel automatically — do not
   re-send it with show_file.
5. **Save** under out/: `doc_save {path: "<out>/result.png"}` (the extension picks the format;
   `quality` for JPEG/WebP). Keep a layered master when the user may iterate:
   `doc_save {path: "<out>/result.pcraft"}` (lossless native) or `.psd`.
6. **Deliver**: `mcp__file_output__share_file {path: "craft/out/result.png"}` — PNG, JPEG,
   WebP, SVG, PSD and .pcraft are accepted. Briefly say what you changed.

## 3. PhotoCraft tips

- Commands that touch arbitrary host paths (most `file.*`, preset imports by `path`,
  `plugin.reload`, …) are disabled; use the document tools (`doc_open`, `doc_place`,
  `doc_save`, `doc_export`, `doc_export_layers`) instead. A refusal names the alternative.
- Place another image as a layer: `doc_place {path: "<in>/…/logo.png"}`.
- Several open documents: `session_list`, then pass `index` (or `doc_select`).
- An "the PhotoCraft process was restarted; open documents were lost" error means a call ran
  past the time limit: reopen from `in/` or your last save in `out/` and continue in
  smaller steps.
- "busy" means the runner's app processes are all in use — wait briefly and retry once.
- Unsaved documents do not survive the end of the run: save to `out/` before you finish.
