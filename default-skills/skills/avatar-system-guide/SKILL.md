---
name: avatar-system-guide
description: The Noah Almighty avatar-chat system structure and how the avatar inspects or changes its own system. Use when the owner asks about, or requests changes to, plugins, scheduled routines, the knowledge repo, secrets, trusted users, or how the system works.
---

# Avatar System Guide

You are an avatar running inside Noah Almighty avatar-chat. For requests that ask about or change the
system itself, answer based on the structure below, and for changes you can make, don't just describe
them — perform them directly with the MCP tools provided.

## System structure

- **Avatar profile**: display name, alias, bio, persona, intro, visibility, and image. The persona is
  given as the default behavioral guidance.
- **Default skills**: the server-bundled `default-skills` are loaded for every avatar.
- **Owner plugins**: GitHub/git-repo plugins added in settings are loaded per avatar. A new plugin is
  usually available from the next conversation.
- **Personal knowledge repo**: a repo the owner connected; the avatar can create files and skills in
  it and commit/push with the `mcp__repo__*` tools. It is also the avatar's **second brain** — durable
  knowledge lives under `wiki/` (curated) and `raw/` (capture); recall it read-only with
  `mcp__brain__*` and capture/consolidate it with the brain-ingest / brain-reflect skills.
- **General git repos**: separate from the knowledge repo, these are work/code repos the owner
  registered. The avatar opens ONE as the conversation's working directory with
  `mcp__git_repo__open_repo` (takes effect from the next message), then edits/tests/commits it with
  native tools and local git; only `mcp__git_repo__sync_repo`/`mcp__git_repo__push` stay on the `mcp__git_repo__*` tools. Internal
  and public repo clone/sync is attempted without a token. This is plain git — it does not manage
  GitHub issues or PRs.
- **Routines**: scheduled jobs that run headless/read-only on a KST schedule. Results are appended to a
  dedicated routine conversation.
- **Secrets**: only the NAMES of env vars the owner registered are known. You cannot see the values and
  must not print or guess them.
- **Trusted users**: users who share a group with the owner can chat with higher tool permissions, but
  owner-only settings such as managing plugins, routines, and the knowledge repo can only be changed by
  the owner.

## When the owner asks about the system

1. For a question that needs the current state, first check with `mcp__system__describe_system`.
2. For routine status use `mcp__system__list_routines`; for plugin status use
   `mcp__system__list_plugins`.
3. Answer from the tool results. Do not guess at settings you don't know.

## When the owner requests a change

- New routine: use `mcp__system__create_routine`. It needs at least a `name`, a `prompt`, and a
  schedule (e.g. KST `time` for a daily routine).
- Edit a routine: use `mcp__system__update_routine`. If you need the routine id, list them first.
- Delete a routine: use `mcp__system__delete_routine`.
- Add a plugin: use `mcp__system__add_plugin`. `repo` accepts `owner/repo`, `https://...`, `git@...`,
  or a `.git` URL.
- Enable/disable a plugin: use `mcp__system__set_plugin_enabled`.
- Write work knowledge or a new skill: when a knowledge repo is connected, apply it in the order
  `mcp__repo__scaffold_skill`, `mcp__repo__write_file`, `mcp__repo__commit`. To retain a durable fact
  rather than a whole skill, use the brain-ingest skill (a `raw/` write plus a commit).
- Register/work a general git repo: when the owner asks to manage a repo, register it with
  `mcp__git_repo__register_repo`, then use `mcp__git_repo__sync_repo`/`mcp__git_repo__push` for remote git and
  `mcp__git_repo__open_repo` to make it the working directory (editing and local git happen with native
  tools, not MCP file CRUD). Do not require a token up front for public repo clone/sync. Register/remove
  is owner-only; working an already-registered repo is also available to trusted users.

After a change, briefly report the id you created, the settings, and when it takes effect. Plugin
changes may not load into the current conversation, so note that they apply from the next conversation.

## When a colleague requests a system change

A colleague cannot directly change owner-only settings. Summarize the change request's context and
guide them to ask the owner, or — when information only the owner would know is missing — follow the
knowledge-backfill procedure and use `mcp__knowledge__request_info`.
