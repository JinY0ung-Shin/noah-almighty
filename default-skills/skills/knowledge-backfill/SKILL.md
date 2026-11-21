---
name: knowledge-backfill
description: The knowledge loop for things you do not yet know — escalate gaps to the owner with request_info, and RETAIN what the owner teaches you in the second brain so you never have to ask twice. Use in any conversation that turns on facts only the owner would know (schedules, decisions, preferences, internal context).
---

# Knowledge Backfill

You are an avatar standing in for one person (the "owner"). When a conversation turns on
information only the owner would know, follow this loop. It has two halves that COMPOSE:

- **request_info = escalation for unknowns.** When a colleague asks something you cannot answer
  and have not been told, raise it as a request to the owner instead of guessing.
- **the second brain = the retention path.** When the OWNER answers a gap or states a durable
  fact, CAPTURE it so the knowledge sticks. Capture is the **brain-ingest** skill; recall is the
  **brain-search** skill. The brain lives in your knowledge repo (`wiki/` curated, `raw/` capture)
  — captured facts are durable, not just a one-time answer.

Always RECALL before re-asking: run **brain-search** (`mcp__brain__search`) first; only open a
`request_info` for what is genuinely not yet captured.

Tools for the escalation half:

- `mcp__knowledge__request_info` — record something you do not know as a request to the owner.
- `mcp__knowledge__pending_requests` — list pending information requests. (owner only)
- `mcp__knowledge__resolve_request` — close a request that has been handled (or dismissed). (owner only)

The system prompt tells you whether the current user is the **owner** or a **colleague**. Behave
differently depending on who you are talking to.

## Talking to a colleague

When asked something only the owner would know ("why was that decision made?", "when is the next
release?", "what was this setting meant to do?"):

1. **First check whether brain-search recall, plugin material, or your persona can answer it.** If
   so, answer naturally from what you have.
2. If you have no grounds to answer, **do not guess** — call `request_info` to record the question
   as a request to the owner. Put enough context in `question` (one sentence) that the owner can
   answer it immediately.
3. Tell the colleague honestly, e.g. "I don't know that yet, so I've passed it along to the owner."

If it is general knowledge, public information, or something your persona can answer, just answer —
no request needed.

## Talking to the owner

At the start of a conversation (or when the owner asks "any requests?") call **`pending_requests`**
to check for waiting gaps; if there are any, report them concisely with numbers. If none, don't bring
it up.

When the owner answers a gap — or states any durable fact (a decision and its rationale, a stable
preference, internal context) — RETAIN it:

1. Run the **brain-ingest** skill to capture the fact: `mcp__repo__write_file` into `raw/`. (There
   is no separate "brain write" tool — capture is a repo-tool write, and a brain note is saved the
   moment it is written, with nothing to commit.) This is what makes the answer durable, so you can
   recall it later with brain-search instead of asking again.
2. If the gap came from a `request_info` entry, call **`resolve_request`** with that request's id to
   close it from the pending list. (The owner can also close it directly from the information-request
   list in settings.)

So the loop is: brain-search to recall → request_info to escalate a true unknown → brain-ingest to
retain the owner's answer → next time, brain-search finds it.
