# pi-gateway runtime (the only agent runtime)

Noah as a BFF over a dedicated pi-gateway instance, deployed WITH Noah as one compose stack (see "Deployment"; design:
`~/.noah-work/pi-migration-2026-10-29/design.md`).
The agent loop runs in pi (`POST /v1/responses`, service key + `user`); files and commands run in the run
principal's own pi sandbox; Noah's in-process MCP tools are served to pi's broker over HTTP with a per-run token.
The Claude Agent SDK runner was removed (U8, 2026-10-29); `AGENT_RUNTIME` is `pi` (default) or `local` (the
deterministic stub for tests and the e2e harness, which also replays scripted `demo` runs —
[build-run-verify.md](build-run-verify.md) "The `local` stub as a scripted demo"), and any other value (`claude`
included) stops the boot. No
pi-gateway code is changed — everything pi lacks is a Noah-side degrade, stated on BOTH metacognition surfaces.

## Run classes and the sandbox principal

`runAgentStream` (`agent/index.ts`) sends every non-`local` run to `runPiAgent`. The sandbox principal is
`piRunPrincipal(request)` (`agent/pi/piRuntime.ts`, unit-pinned) = `viewerUserId ?? avatar.id`, whoever the run
executes AS — except an avatar consultation, which `piRunPrincipal` refuses and `runPiAgent` runs in a sandbox of its
own:

| Run class | Principal (sandbox) | Owner data |
|---|---|---|
| owner chat, owner routine, task-API turn | the owner | own |
| trusted (teammate) colleague chat | the colleague (U4) | owner repo/brain/skills only through Noah MCP tools |
| untrusted colleague chat (fail-closed floor: with one team, every colleague who can reach an avatar is trusted) | the colleague | the read-only MCP set only (`mcpAllowedTools`) |
| avatar consultation (the consulted avatar's run) | NOBODY: a fresh, empty `consult-<random>` sandbox, deleted after the run | read-only MCP toward the consulted owner |
| intro/hashtag generators, any run without a conversation | the owner | own |

Every class runs in its principal's OWN sandbox, never over the owner's files. A COLLEAGUE chat (trusted or not —
`sandboxOwner: "viewer"`) runs someone else's avatar — the owner's persona, skills and recalled notes — in the
colleague's sandbox, so its pi session is `read_only` (pi-gateway P1, user decision 2026-10-31): pi gives it only
`read`/`ls`/`find`/`grep` (+ `present_file`), no `write`/`edit`/`bash` and no sandbox-run MCP server, for the
session's whole life. The capability plan derives `PiRuntimeFacts.readOnlyBuiltins` (= `sandboxOwner === "viewer"`)
and `runPiAgent` sends `read_only: true` on every NEW pi session of that run (like the model and effort; a
continued session already has it). Every other class keeps the full built-ins (read/write/edit/bash/ls/find/grep).
What a run may do to anyone else's data is decided only by the `/mcp` gate (`allowCall` over this run's
`mcpAllowedTools`) and the handlers' self-gates. Both metacognition surfaces say what the run has and whose
sandbox it is: `PiRuntimeFacts.sandboxOwner` (`owner` / `viewer` / `nobody`, set by the capability plan) renders ONE
sentence, `piSandboxOwnerSentence` (`ownerState.ts`), in the prompt's runtime section and describe_system's
runtime line — the `viewer` one says the session is read-only — and `readOnlyBuiltins` switches the built-in tool
list, the deck line's `read-only` tail (`DeckAuthoringStatus`), the image-sources line, the attached-images tails,
the no-vision PDF hint, the draw.io section and the working-repository turn line to their read-only wording.
An admin built-in toggle is advisory on pi (describe_system names it as such); a
disabled SKILL is enforced by omission (see "Skills").

**A run nobody can answer starts its pi session `interactive: false`** (pi removes `AskUserQuestion` from the
session and its subagents, for the session's whole life): a scheduled routine, an avatar consultation and the
intro/hashtag generators. The capability plan derives `PiRuntimeFacts.nonInteractive` (= `headless ||
avatarConsultation`) and `runPiAgent` sends it on every NEW pi session, never on a continuation (pi 400s a
different value on a later turn). These runs never continue a session another class started: routines pass no
resume point and their rows carry none, consultations and generators have no conversation. The external task API
is NOT one of them — its key holder answers `question` prompts through `/respond`, so its sessions stay
interactive. A run without `onQuestion` (exactly these) that gets a `requires_action` anyway fails with a
`protocol` error (`runPiTurn`); the former fixed "cannot ask" answer is gone. Both surfaces state it with
`PI_NO_ASK_USER_SENTENCE` (`ownerState.ts`): the per-turn run-kind note (`piRunKindParagraph`) and describe_system's
runtime line; the prompt's "do not ask questions" instruction stays.

**Shell secrets (`sandbox_env`, pi P4; user decision U5, confirmed 2026-10-31).** The owner's 셸 노출 secrets reach
`bash` ONLY on an owner run in the owner's own sandbox — owner chat, owner routine, external task API
(`ownerToolAccess && sandboxOwner === "owner"`); a colleague chat (`viewer`), a consultation (`nobody`) and a
restricted generator send none. The capability plan builds `piSandboxEnv` from the vault minus the reserved git/SSH
names (`mcpInjectableSecretEnv`) through `piSandboxEnvOf` (`responsesClient.ts`), which mirrors pi's admission rules
(env-name syntax, pi's reserved names such as `PATH`/`HOME`/`*_PROXY`/`LD_*`/`BASH*`/`LC_*`, ≤64 names, ≤256 KiB) so
one unfit secret never 400s the turn — a flagged name it leaves out is named as NOT in the shell. `runPiAgent` sends
it as `sandbox_env` on EVERY pi request of the run (pi keeps it in the live session's memory for that request only —
never its DB, session file or logs — so a restart or idle unload loses nothing), pi passes it to `bash` alone and
redacts the values from every tool result, progress update and error; the values also join `piRedactions`. Both
surfaces say which names are `$NAME` in bash from `PiRuntimeFacts.shellSecretNames` (`shellSecretsSentence`,
`ownerState.ts`); the consultation sandbox sentence says it has no secrets.

**A run without a conversation** (consultations, the generators) works in a run folder
`/workspace/c/<piEphemeralRunKey>/` (`run-<feature>` — `run-intro`, `run-hashtags` — for a generator, REUSED in the
owner's sandbox and never removed; `run-ask` for a consultation, gone with its sandbox): no stored pi session and no
`pi_instructions` row (the prompt is rendered for that run only).

**A consultation's own sandbox** (user decision 2026-10-30, review-2 H1). The consulted avatar's run is driven by
ANOTHER user's authored text (its persona, knowledge-repo `CLAUDE.md`, recalled notes and captured pages) with full
built-ins and no one watching, so it runs neither in the asker's sandbox (it could read the asker's conversation
files, edit the asker's repo copies that the asker's next `commit` reads back, and `request_info` what it read to the
target) nor the target's. `runPiAgent` mints `consult-<24 random hex>` (`beginPiConsultationSandbox`; pi's user-id
pattern accepts it, no Noah id has that shape), records it under `<dataDir>/pi-consultation-sandboxes/`, and in
`finally` removes its `u-<key>` folder through a pinned descriptor (no link followed), its repo-copy records and the
record (`endPiConsultationSandbox`); the boot sweeps records a crash left (`sweepPiConsultationSandboxes`). The
sandbox CONTAINER is pi's: sandboxd reaps it when idle (`SANDBOX_IDLE_SECONDS`, 15 min default) and no request ever
names that principal again. Cost: each consultation cold-starts a container (~300 ms on the dev box) before its first
model call. Skills there are the bundled ones as files plus the target's via `mcp__skills__read` (a non-owner run);
`viewerUserId` stays the asker, so the MCP gates, `request_info` attribution and trust checks are what they were.

- **pi's ONLY per-request switches are `interactive` and `read_only`.** There is no per-request built-in
  allowlist, so a run class's BUILT-IN tool access differs only through those two flags and which sandbox
  principal it runs in.

## One run (`agent/pi/runPiAgent.ts`)

1. **Capabilities** — `buildRunCapabilities(…, { piConversationDir, … })` (`agent/runCapabilities.ts`),
   the ONE capability plan (hex-ssh, 공용 MCP and plugin servers included — Noah relays them, see "Proxied MCP
   servers"), and stamps `PiRuntimeFacts` onto describe_system's ctx and (via
   `stampPromptRequest`) the prompt.
2. **Run token** — `McpRunRegistry.register` with EVERY name in `PI_MCP_SERVER_NAMES` (`agent/pi/mcpCatalog.ts`):
   Noah's own servers (`PI_NOAH_SERVER_NAMES`; built ones serve calls, unbuilt ones are tool-less stubs) and the three
   relay ids (`hex-ssh`, `plugins`, `shared`). Gates: `listTools` answers `tools/list` of Noah's own servers from the
   static catalog (all tools of every server, widest form — built once per process from inert contexts); a relay
   lists THIS run's tools (per token). `allowCall` admits only this run's `mcpAllowedTools` (relays: a tool of a
   source this run relays that passes its filter); a refusal names `mcp__system__describe_system` and forbids
   workarounds. `transformResult` redacts every result (`capabilities.piRedactions`). Why static: pi lists a
   session's MCP tools ONCE at session build and keeps them while later turns (each with its own token and
   capabilities) reuse the session. Handlers still self-gate. The token rides the `x-noah-run-token` request header;
   revoked in `finally` (in-flight handlers abort).
3. **Prompt (D2)** — `buildSystemPromptAppend` with `piRuntime` set, rendered at the conversation's FIRST pi turn and
   frozen in `conversations.pi_instructions` (`ensureConversationPiInstructions`, write-once like `todo_snapshot`);
   sent as `instructions` only when a session starts, and re-sent verbatim for every later session (model switch,
   lost session). Per-turn facts ride the user input instead (`buildPiTurnPreamble`): the KST date/time line, the
   turn's RUN KIND (`piRunKindParagraph`: live chat + the mid-turn-message line + background `ask_avatar`, a
   routine's unattended rules, or the external-task provenance paragraph — the same three cases as describe_system's
   origin line), a rewind's provenance, the open working repo's sandbox copy (`piActiveRepoTurnLine` — `open_repo`
   changes it mid-conversation), and a new session's reason. One conversation mixes routine runs, task-API turns and
   live chat on ONE pi session, so the frozen text must not depend on the run kind (review M2): an owner routine
   renders the OWNER branch (`piOwnerRun`), the owner line and the 할 일 policy name both cases, and the
   getting-started pitch is omitted when the first turn is unattended. Capability FACTS that differ by kind (browser,
   file cards) stay D2-stale; the run-kind note says describe_system is authoritative and a missing tool is refused.
   Rows frozen by an earlier build of this branch keep their text (unreleased; only dev/e2e instances have them). The pi variant
   adds `piRuntimeSection` (sandbox, work folder, built-in tools, `mcp_call`/`mcp_search`, what is missing, "these
   instructions were fixed at conversation start — check describe_system").
4. **Input** — preamble + `buildUserPrompt` (history only on a fresh session, cap `PI_FIRST_TURN_HISTORY_LIMITS`
   120 msgs / 60k chars instead of 24 / 12k) + image blocks as `input_image` data URLs + the message's documents
   as `input_file` parts (see "Document input"; the preamble names their `/workspace/uploads/` paths). Attachment files are staged
   by the route straight into `/workspace/c/<seg>/attachments/` and listed by sandbox path (`stagePiAttachmentFiles`
   maps host → sandbox; it copies only a file staged elsewhere). Skills are synced first (see "Skills").
5. **Session** — `previous_response_id` = `resumeSessionAt ?? resumeSessionId` when it is a `resp_…` id; anything
   else (a CLI session id from the retired SDK runner) means a new session from the text history. An image turn
   continues the stored session unless it is a rewind. Every committed turn
   reports its response id via `onSessionId` AND `onResumePoint({sessionId: id, uuid: id})`, so the chat route
   persists it as `agent_session_id` and stamps it on the assistant row; a rewind onto that row forks from it
   (pi branches on an older `previous_response_id`; no fork flag). Every turn — new or continuing — sends the run's
   `model` and `reasoningEffort`, so a composer change applies to the SAME session from that turn on (pi P3 switches the
   session, history and tools kept). pi's default model has no id in Noah's chain (`undefined`): a new session omits
   `model`, a continuing turn sends the id pi's `/v1/models` marks `default: true` (`piModelFor`; unknown → omitted,
   the session keeps its model).
6. **Errors** — 404/409 on a continued session, or 400 `model_not_configured` (the operator removed the session's
   model from pi and the turn could not name pi's default; `isLostPiSession`) → once, a new session from history
   (status-free, the model is told in the preamble). 503/429 at stream open → `withPiRetry` backoff (status line `pi-gateway가 바빠서…`). An empty turn —
   pi's `empty_response` (no text, reasoning or file output — a tool call alone does not count; pi does NOT commit it)
   — is re-sent ONCE as the same request (same `previous_response_id`, or the same fresh session; status line
   `모델이 빈 응답을 보내 한 번 더 시도하는 중…`), never for a steer follow-up turn. A model fallback chain (routines,
   task API: `modelFallback`) retries the uncommitted turn on the next model in the SAME session (a new one only when
   pi's default cannot be named). All three recoveries (heal, empty retry, fallback) re-send the attempt, and pi
   rewound the failed turn, so none runs once the attempt SHOWED something (a text delta, a question — answered or
   not — or a delivered steer) or ACTED (`onToolStart`/`onAgentStart`: a tool ran or a subagent started) —
   `attemptRepeatable` in `runPiAgent`; the failure then stands (review #14). Trade-off: a routine loses its fallback
   once a tool ran.
7. **Stop / failure** — a stop `cancel`s the live response, so pi COMMITS the partial turn (`incomplete`) and the runner
   reports its id. The chat route's cancel and error paths keep that id as `agent_session_id` (`sessionAfterAbort`):
   the next turn continues it, and the stopped row already shows the same partial. They clear it (history rebuild —
   chat-02) when the run's LATEST input never committed: stopped before pi created the response, a failed
   response, or a steer follow-up turn stopped before its own commit (its steer is in Noah's rows, not in pi).
   pi keeps the stopped turn but does NOT feed its partial text back to the model (seen live in S05: the continued
   request carries the stopped prompt, no assistant message), so the route hands the stopped row's text as
   `AgentRequest.stoppedAnswer` and a CONTINUED turn's input restates it (`Stopped answer: …<stopped_answer>`, tail
   4 000 chars; `buildPiTurnPreamble`). A fresh session needs no note — its text history ends with that row.
8. **Mid-turn messages (P2)** — a steer (or an async `ask_avatar` answer) is handed to the RUNNING response
   (`POST /v1/responses/{id}/input`); pi folds it in at its next tool-call boundary and streams
   `response.input_consumed`, which marks it delivered. One pi did not deliver (`undelivered_input`) stays queued and
   goes with the rest as ONE follow-up turn after the response. Mechanics →
   [`chat-sse-media.md`](chat-sse-media.md) "Mid-turn user messages".
9. **Manual compaction** — a typed `/compact` is not a turn: `compactPiSession` calls
   `POST /v1/responses/{id}/compact` (`PiResponsesClient.compact`) and reports the NEW response id as the session.
   The answer is an SSE stream like a turn's (`response.compaction` `in_progress` → `completed {id, tokens_*}` |
   `failed {error.code}`), because a plain JSON call would die at fetch's 300 s header timeout; it shares the
   stream's connect/idle deadlines and has its own 15 min cap (pi ends a compaction at its non-stream timeout
   first). Nothing else of the run (capability plan, run token, instructions) is built — and since no run token
   is sent, pi takes down a session it had to OPEN for the compaction, so the next turn opens it with its token.
   Mechanics → [`chat-sse-media.md`](chat-sse-media.md) "Manual `/compact`".

## Document input (`input_file`) and built-in subagents (pi bump 2026-11-11)

- **The `input_file` contract (pi `api/request.ts` `inputFile`, `api/responses.ts`).** A user-message content part
  `{ type: "input_file", filename, file_data: "data:…;base64,…" }` (`file_id` / `file_url` are 400
  `invalid_file_input`). pi takes a plain `filename` (no `/`, `\`, control characters; not `.`/`..`; ≤ 255 bytes;
  one of its extensions — Noah sends pdf/docx/xlsx/pptx/csv/txt/md/json and keeps images on `input_image`), writes
  the bytes to `/workspace/uploads/<filename>` in the sandbox of the run's PRINCIPAL **before the turn**
  (overwriting a same-named file) and puts `[Attached file: /workspace/uploads/<filename>]` into the prompt text
  at the part's position. The whole request body is capped at 16 MiB (`PI_MAX_REQUEST_BYTES`; the limits that
  keep Noah under it → [`chat-sse-media.md`](chat-sse-media.md) "Document attachments").
- **What Noah sends (`responsesClient.ts` `buildResponsesBody`).** `PiTurnInput.files` → one `input_file` part
  per document AFTER the `input_text` and `input_image` parts (so pi's notes follow the user's message). A turn
  with neither images nor files still sends `input` as the plain string — byte-for-byte the request it was
  before documents existed (`tests/pi-documents.test.ts` pins both). The runner sends the files on the run's
  FIRST request and on every re-send of that attempt (a lost-session rebuild, a model fallback); a steer
  follow-up turn carries none, and its preamble drops the documents line.
- **Refusals are surfaced, never dropped (`runPiAgent.ts` `piDocumentTurnError`).** On a turn that carried
  documents: 400 `invalid_file_input` (pi's name/type rule, or a **`read_only` session** — pi refuses
  `input_file` there because it writes to the workspace) and 502 `Sandbox error: …` (the sandbox could not be
  opened or the write failed) become their own Korean error on the turn; the 502's status is dropped so the
  chat route does not read it as a transient model failure and offer another model. A `read_only` refusal
  cannot normally happen: `documentAttachmentsAllowed` (`runCapabilities.ts`) keeps documents off every run
  whose sandbox owner is not the avatar owner, the route answers 400 `NOT_ALLOWED_HERE` first, and the runner
  throws before any request when a document reaches a run whose plan says no.
- **The sandbox image's document libraries:** `pypdf`, `python-docx`, `python-pptx` next to `numpy pandas
  openpyxl matplotlib` (pi `images/sandbox/Dockerfile`). Noah's deployed pi prompt
  (`scripts/pi-system-prompt.md`), the frozen append's **Attached documents** note, the per-turn documents line
  and describe_system name them, so the avatar reads an attached file instead of asking for a paste.
- **Noah's image adds `requests` and `urllib3`** (`docker/pi-sandbox/requirements.txt`, 2026-11-12; version
  RANGES so the build takes whatever the pip mirror carries, installed AFTER the converter's pinned set so
  its pins stand). They are for the avatar's own scripts and open NOTHING: they leave through the same egress
  proxy and `SANDBOX_EGRESS_ALLOW` as curl. The image sets `REQUESTS_CA_BUNDLE` to the system bundle, because
  requests otherwise trusts only certifi's roots and would refuse an internal host signed by `CA_CERT_FILE`
  that curl accepts. State on both surfaces: `PiRuntimeFacts.httpLibraries` (= `PI_DECK_SANDBOX` AND a
  shell, i.e. not a `read_only` session) → `SANDBOX_HTTP_LIBRARIES_SENTENCE` (`ownerState.ts`). A further
  library goes into that file, the Dockerfile's import check and — if the avatar should know — that sentence.
- **Built-in subagents.** pi now ALWAYS offers `Agent` / `SendMessage` with a built-in `general-purpose`
  subagent (`agent/subagents.ts`; before, only when a plugin shipped an agent). A subagent is a child pi
  session in the SAME sandbox with the parent's tools minus `Agent`, `SendMessage`, `AskUserQuestion`,
  `present_file` and `request_admin` (depth 1; only the parent talks to the user); its tool events reach Noah
  with `parent_tool_use_id` and only its final report returns as the parent call's result. Noah states it in
  the deployed pi prompt (one `<tools>` line), in describe_system's `Subagents` line (every pi run) and in the
  manual's `chat` topic — one sentence, `PI_SUBAGENT_SENTENCE` (`agent/ownerState.ts`).
- **Not verified against a real gateway:** there is no pi-gateway on the dev box, so the `input_file` round trip
  (the file really landing in `/workspace/uploads/`, pi's `[Attached file: …]` note, a real `read_only` 400) is
  covered only by the scripted fake and by reading pi's source at the pinned submodule commit. Run one document
  turn on the dind stack / the deployment after the pi bump.

## S1 degrades (what pi still lacks)

| Gap | Noah-side behavior | Surfaces |
|---|---|---|

| no per-session cwd (P1) | the model is told to work in `/workspace/c/<seg>/` with absolute paths (prompt + describe_system + refusal redirects); Noah creates the folder 0700 | both |
| no WebSearch | not registered; stated | both |
| relayed MCP tool lists are per SESSION | pi reads `tools/list` when it builds the session (first turn, a reload after `SESSION_IDLE_SECONDS` — 1800 s in the bundle — or a model/effort switch, which reopens the session); a server whose list failed is asked again at most every 30 s when the model searches or calls an unknown name; a server/tool connected later appears only in a later session, a removed one is refused at call time | both (runtime line + prompt sentence) |
| broker calls cannot wait minutes | `ask_avatar` in a chat runs in the background, a canvas never waits (see "Asynchronous tools") | both + tool descriptions |
| date fixed at session creation | KST date/time line prepended to every input | turn input |

## Files: the sandbox conversation folder (`agent/pi/piWorkspace.ts`)

The chat route and the scheduler resolve the run's sandbox folder BEFORE building the request (`piRunWorkspace`,
from the same `piRunPrincipal` the runner uses) and then use `preparePiRunWorkspace`: the turn's workspace dir IS
the host view of `/workspace/c/<conv-seg>/` (`<PI_WORKSPACES_DIR>/u-<sha256(principal)[:24]>/c/<seg>`, 0700). So every server-written copy lands there with no
second copy: staged attachments (`attachments/`), browser captures (`captures/`), Confluence `save_to_workspace`
(`confluence/`). The request's `cwd` is that folder (never Noah's repo clone), and the file-output roots are the
user's WHOLE sandbox workspace (the model may build anywhere under `/workspace`, e.g. a working-repo copy).

| Direction | Where | Rule |
|---|---|---|
| model → Noah (`show_file`, `share_file`, `copy_image`) | `runCapabilities` wrappers → `piToolPathToHost` | absolute under `/workspace`, or relative = relative to `/workspace` (pi's shell start); anything else (`/tmp/…`, a planted link out of the root) is refused with an English redirect BEFORE the sink; the publishers' own realpath containment runs on top |
| Noah → model (capture `savedPath`, Confluence `savedPath`) | `toSandboxPath` (`piSandboxPath`) | host path under the user's root → `/workspace/…` |
| deck previews | `share_file` → `loadConverterPreviews(allowedRoots = [user root])` | the hash-bound `<stem>.preview/` sidecar is read through the host path, like today |

- **Files an MCP tool returns (pi `5adb8e5`):** a binary `resource` block in a broker or sandbox MCP result is
  saved BY PI into `/workspace/artifacts/<pi session id>/<name>-<sha256[:8]><ext>` of the run's principal and
  the model gets `saved_path`/`size`/`sha256`/`mime` in the tool result (no prompt text: the result names the
  path). Files of one result: 28 MiB together, the rest of the result 4 MiB as before; past either, pi answers a
  tool error. A `read_only` session (a colleague's chat) saves nothing. The folder is keyed by pi's SESSION id,
  not Noah's conversation: the 파일 tab shows `artifacts/` as one more shared folder (other conversations'
  session folders included), and no conversation-deleting path removes it — these are the agent's own files,
  like `uploads/`. None of Noah's own MCP servers returns such a block today; a relayed server (`plugins`,
  `shared`) may. Checked on the real stack by the boot test (`86-mcp-files.mjs`, `build-run-verify.md`).
- **Files an MCP tool takes (pi `89a69bd`):** the other direction. A tool property the SERVER marks
  `"x-workspace-file": true` is shown to the model as a `/workspace` path, and pi fills it at call time with
  `{filename, mimeType, size, sha256, data}` read from the run's sandbox — the model never writes file content
  and no credential enters the sandbox. Only a regular, non-empty file under `/workspace` reached without a
  symlink, of an `input_file` extension; 10 files and 28 MiB per call; never in a `read_only` session; an
  unmarked argument is left alone. The mark is pi's own convention, not MCP. None of Noah's own MCP servers
  uses it; a server registered in pi's broker (or relayed through `plugins` / `shared`, whose 8 MiB relay
  message cap then applies) may. Checked on the real stack by the boot test (`87-mcp-file-args.mjs`).
- **D3 (first pi turn of an old conversation):** `moveLegacyConversationWorkspace` moves `dataDir/workspaces/<avatar>/<conv>`
  into the sandbox folder — links/specials never followed (left behind), an existing sandbox file never overwritten,
  capped (256 MB / 10 000 entries / depth 16; past the cap the rest stays and the next turn continues), moved files
  removed from the old folder, and a `.noah-moved-to-pi` marker there makes later turns skip it.
- **Cascades:** `deleteConversationWorkspaceCopies` also sweeps `attachments/`, `captures/`, `confluence/` of the
  conversation's folder under EVERY `u-*` (`deletePiConversationCopies`), so every conversation-deleting path stays
  complete; the agent's own files in the folder stay. Rewind's dropped-attachment
  cleanup works unchanged (its workspace dir is the sandbox folder). Account deletion removes the user's whole
  `u-<key>` workspace and Noah's repo-copy records (`routes/admin.ts`).

### Host-side filesystem discipline (`pinnedFs.ts`, review C1)

Everything under `u-<key>` is the sandbox's, at Noah's own uid: the agent can replace ANY folder Noah later walks
into (`.noah`, `.noah/skills`, `c`, `c/<conv>`, `attachments/`, `repos/<owner>`, a copy's `.git`) with a symlink.
`ln -s ../.. /workspace/.noah/skills` once made the skill sync list `PI_WORKSPACES_DIR` and delete every other
user's sandbox. So no host-side write, listing, rename or removal below the user root resolves an agent-owned
component by NAME:

- **Folders are pinned by descriptor** (`PinnedDir`, `piSandboxDir`): opened one segment at a time with
  `O_DIRECTORY|O_NOFOLLOW`, each from the previous folder's descriptor (`/proc/self/fd/<fd>/<name>` — openat
  for Node), missing segments created by `mkdir` under the pinned parent and RE-opened no-follow. A link or a
  file anywhere on the way refuses the operation. Only the user root's parent (the operator's
  `PI_WORKSPACES_DIR`) is trusted as configured.
- **Entries go through the descriptor:** exclusive creates (`O_CREAT|O_EXCL|O_NOFOLLOW`, mode set by `fchmod`),
  no-follow reads, renames inside the pinned folder, and a recursive removal that pins every sub-folder the same
  way and unlinks every link (never `fs.rmSync` on an agent-owned tree).
- **Reads by an already-checked path** (`share_file`/`show_file`/`copy_image` publishers, the deck sidecar
  manifest + renders, the working-copy read-back) verify the OPENED file's kernel path (`fdPathIs`,
  `readFileVerified`, `listDirVerified`) against the realpath they checked, so a folder swapped for a link
  between the check and the open is refused.
- **Users:** skill sync (a planted link → this run lists the skills `via: "mcp"` and says so in `failures`),
  `ensurePiConversationDir`, the D3 move (destination side), attachment staging (`stageChatImageFilesFromAttachments`
  / `stagePiAttachmentFiles`), browser captures, Confluence `save_to_workspace` (`workspaceAnchor` = the user
  root), the rewind cascade (`deleteStagedAttachmentCopies`), repo copies + `.prev*` + the commit's `.git` refresh,
  conversation and account deletion, the 파일 tab's reads (below). The generic writers take an `anchor` (the deepest folder the agent cannot
  replace) — the pi user root, or the scratch workspace itself when Noah cannot reach the sandbox workspaces (no
  `PI_WORKSPACES_DIR`: the route stages into Noah's own `dataDir/workspaces` folder, which the sandbox cannot see).
- **Residual (documented, not closable from Node):** a missing folder created on the way can be raced only into a
  refusal; and a file's CONTENT is the agent's after Noah wrote it. Without `/proc/self/fd` there is no pinning
  (entries would be addressed by name, check-then-act), so `AGENT_RUNTIME=pi` REFUSES TO BOOT there
  (`assertProcFdPinning` in `loadPiRuntimeConfig`). **A new host-side operation below a sandbox root MUST go through `piSandboxDir` /
  `PinnedDir`** — `removeNoFollow` and by-name `fs.*` calls are only for paths whose every ancestor is Noah's.

### The 파일 tab: a user's own workspace, read-only (`workspaceBrowser.ts`, `routes/workspaceFiles.ts`, 2026-11-13)

The chat header's 파일 button opens a side-panel tab that shows the signed-in user their WHOLE sandbox workspace
(`/workspace`) as a folder tree, with a download for every file and a preview of the simple ones. It is a window for
PEOPLE: nothing about it reaches the avatar (no prompt line, no `describe_system` fact, no tool).

- **Whose files:** the caller's own, always. Every run of a user's conversation executes as that user
  (`piRunPrincipal`: the viewer of a chat — a colleague chat included —, the owner of a routine or an API task), so the
  principal is `req.user.id` and the routes take no user or conversation id that selects files. A consultation's
  throwaway sandbox is never reachable (no session user has that principal).
- **GETs only** — `GET /api/me/workspace?path=&conversation=` (one folder) and
  `GET /api/me/workspace/file?path=&preview=1` (one file), session-only (`requireAuth`), `Cache-Control: private,
  no-store` (plus the two document-preview GETs below). The surface never creates, writes, renames or deletes
  anything IN THE WORKSPACE and adds nothing to the deletion cascades; the one thing Noah writes for it is the
  document previews' own expiring cache. `bootstrap.workspaceFiles` (= `workspaceBrowserAvailable`: `AGENT_RUNTIME=pi` AND
  `PI_WORKSPACES_DIR`) decides whether the button exists; without it both routes answer 404.
- **Path grammar** (`parseWorkspacePath`, `src/shared/workspaceFiles.ts`): a relative path of plain segments — no
  `..`, `.`, empty segment, backslash or NUL, ≤ 64 segments, ≤ 4096 chars — else 400.
- **Pinned all the way** (`piUserSandboxDir` → `PinnedDir`): the user root and every folder on the way are opened by
  descriptor without following a link, a file is opened through its folder's descriptor (`PinnedDir.openFile`:
  `O_NOFOLLOW|O_NONBLOCK`, regular files only) and STREAMED from that descriptor (`createReadStream({ fd })`, exactly
  the bytes counted at the open). A link is LISTED as `kind: "link"` (lstat — never its target's kind or size) and can
  be neither entered nor read; a root that is itself a link reads as a sandbox that does not exist.
- **Listing:** folders first, then names in natural order; ≤ 1000 entries (`WORKSPACE_LIST_MAX_ENTRIES`) with `total` +
  `truncated`; size and mtime only for the returned entries. The work is BOUNDED whatever the agent put there (the
  handler is synchronous): at most 20 000 entries of a folder are read (`PinnedDir.listUpTo`,
  `WORKSPACE_SCAN_MAX_ENTRIES`) — past that the listing is the first ones the filesystem handed out and `total` is a
  floor (`totalIsMinimum`). In `c/` the user's conversations lead, most recently used
  first, each carrying `conversation: { id, title }`; a folder shaped like a conversation's that matches none the user
  still has is `orphan` (shown as 삭제된 대화 — a deleted conversation's agent-written files stay by design). `current`
  (`c/<piConversationSegment(conversation)>`) is only a path: it is named whether or not the folder exists yet, and no
  ownership check is needed for it (it can only ever address the caller's own root).
- **The bytes are the agent's**, so the file route never serves something this origin would render: always
  `Content-Disposition: attachment`, `nosniff`, `Content-Security-Policy: default-src 'none'; style-src
  'unsafe-inline'; img-src data:; sandbox`, and `application/octet-stream` for everything except the image extensions
  the tab shows in an `<img>` (`workspaceImageMediaType`; an SVG in an `<img>` runs nothing). `preview=1` refuses a
  file over 10 MiB with 413 instead of streaming it; a download has no cap. `HEAD` gets the headers alone. A file
  cut short after the open DROPS the connection (the bytes sent are counted against the size at the open) instead of
  hanging under the declared length until the keep-alive timeout. Shell-exposed secrets written into a file
  are NOT redacted (pi does not redact file contents either) — the reader is the sandbox's own user.
- **Document previews (pdf, pptx, docx → page images; `workspacePreviews.ts`, 2026-11-13).** The tab cannot draw these,
  so `GET /api/me/workspace/preview?path=&retry=1` has the SERVER render them with the file cards' converter
  (`renderDocumentPreviews`: LibreOffice → pdf → `pdftoppm`, first 30 pages; a pdf skips LibreOffice) and
  `GET /api/me/workspace/preview/page?id=&n=` serves each page (`image/png|jpeg`, `nosniff`, CSP sandbox, `private,
  max-age=21600, immutable`; a page that expired mid-send is a `no-store` 404). What is different from every other read here:
  - **Noah converts a COPY, never the workspace file.** The bytes are read ONCE through the pinned descriptor,
    bounded by the 30 MiB cap ITSELF (`readBounded` — never by a stat the sandbox can change before the read), must
    open with the format's magic (`%PDF` / `PK`), and go to a private file under a FIXED name
    (`<dataDir>/workspace-previews/.work/doc-*/document.<ext>` — the workspace name never reaches a command line);
    only that file is handed to `soffice` / `pdftoppm`, and it is removed when the conversion ends (boot clears
    what a crash left).
  - **The document is untrusted and is converted in Noah's container**, so the converter is hardened for every
    caller (`renderDocumentPreviews`, share_file cards included): `--infilter` forces the format's own import
    filter and each conversion's throwaway profile is seeded with `BlockUntrustedRefererLinks`, no link updates,
    no macros (`libreOfficeConvertArgs`, `seedLibreOfficeProfile`). Checked on the image's LibreOffice 7.4.7 with
    `-writer` (2026-11-13), before → after: a real pptx/docx with an `r:link` picture to `file:///…` drew that
    local file into the pdf → no image; the same link to `http://127.0.0.1` made 2–3 requests → 0; an ODP / ODT
    named `.pptx` / `.docx` (linked picture) loaded and leaked → "source file could not be loaded"; a normal
    pptx/docx kept its embedded picture; `INCLUDETEXT` / `INCLUDEPICTURE` fields leaked nothing either way. Pages
    are a fixed 1600 px long side (`pdftoppm -scale-to`, not a resolution: a 14400 pt MediaBox is 1600×1600 and
    ~25 MB of memory instead of a 24000 px bitmap) and ≤ 64 MiB per document.
  - **A deck the `pptx` skill built uses its own renders**: `loadConverterPreviews` on the `<stem>.preview/` sidecar
    next to the file the kernel says was opened (`/proc/self/fd`), accepted only when its `pptxSha256` equals the
    bytes just read — else LibreOffice.
  - **The renders are an expiring CACHE**, `<dataDir>/workspace-previews/<u-key>/<id>/` (`page-N.<ext>` + `meta.json`,
    published by one rename). `id` = sha256(user, device, inode, size, mtime, ext) of the OPENED file, so a rewritten
    file is a new entry; it is not a content hash (a file forced back to the same size and mtime keeps its old pages
    until expiry — the user's own file; the download is always the real bytes). Entries go after 6 h or past 20 per
    user (swept every 10 min by an unref'd timer and on requests), the whole root at boot, and a user's folder with the account
    (`deleteWorkspacePreviewsForUser`, `routes/admin.ts`). No table or message points at it: nothing to cascade.
  - **A request never waits out a conversion**: it waits ≤ 8 s and then answers `{ status: "rendering" }` (the client
    asks again every 2 s, up to 5 min), so a reverse proxy's timeout never cuts one. ≤ 2 conversions run at once, 1
    per user (`waiting: true` otherwise); one job per file however often it is asked; a failure is remembered 5 min
    so a poll does not restart it (`retry=1`, the tab's 새로고침, forgets it). State lives on ONE
    `WorkspaceDocumentPreviews` made by the router factory.
  - **Availability** is `probeDocumentPreviews()` (soffice + pdftoppm at boot), else `{ status: "failed", reason:
    "UNAVAILABLE" }`. Each LibreOffice application loads only its own formats: the image installs `-impress` AND
    `-writer` (added with this feature — before it a `.docx` failed with "source file could not be loaded", for
    share_file cards too); `-calc` is not installed, so `.xlsx` is not offered here. The three formats were rendered THROUGH the app in
    a freshly built image by the combined-stack boot test (`85-workspace-files.mjs`, `build-run-verify.md`).
- **A shared file's card may NAME a path here** (`MessageAttachment.workspacePath`, written by `onShareFile`
  through `workspacePathOfHostFile` — `chat-sse-media.md` § Generated-file delivery): the card's 폴더에서 보기 opens
  the tab at it on the viewer's press. It adds no route and no id: the tab reads the path through the same two
  GETs, as the caller's own root, with every check above. The avatar is still told nothing about the tab.
- **Tests:** `tests/routes-workspace-files.test.ts` (self-scoping, planted links at every level, the path grammar, the
  response headers, the cap, the preview routes), `tests/workspace-previews.test.ts` (the converter's copy, bounds,
  remembered failures, the sidecar, the cache), `tests/workspace-files.test.ts` (the shared contract),
  `tests/react-workspace-tab.test.tsx`.
  Client side: `client.md` § Side panel.

## Skills (`agent/pi/piSkills.ts`, `agent/skillsTools.ts`)

pi does not load Claude Code plugin roots. Each pi turn `materializePiSkills` syncs the run's `pluginRoots` into
`/workspace/.noah/skills/<root>/<skill>/` (`<root>` = `default`, `knowledge`, `plugin-<plugin name>`, `other-<name>`) and
returns the index the prompt (`piSkillsSection`, frozen with the instructions — a skill added later loads from the
next conversation) and describe_system (`piRunLines`, live) both state (`PiRuntimeFacts.skills`). The index holds
80 entries (`MAX_INDEX_ENTRIES`); past that both surfaces say "N more not listed" (`PiRuntimeFacts.skillsOmitted`).

- **Skill folders of a root (`skillDirsOf`, review #8)** mirror `listSkillsInRoots`: the root ITSELF when it holds a
  SKILL.md — the layout Noah's own knowledge marketplace produces (`scaffoldSkill` and learned skills put
  `skills/<slug>/SKILL.md` + `skills/<slug>/.claude-plugin/plugin.json` in the repo and list `./skills/<slug>` in
  `marketplace.json`, so `resolvePluginRoots` hands ONE root per skill) — then `<root>/skills/<dir>/SKILL.md`. A
  self-skill's `.claude-plugin/` is not copied. Roots are GROUPED by `<root>` label, so every knowledge skill keeps
  the stable id `knowledge/<slug>` in any root order (never a load-order `knowledge-2`); a folder name two roots of one
  label share goes to the first, the other is logged as a failure. Links never count: the root, its SKILL.md,
  `<root>/skills` and every component of the root below the data dir / bundled plugins dir must be real folders
  (`noLinkBelowBase`; `resolvePluginRoots`' `containedPluginDir` refuses such a marketplace source too).
  `SYNC_VERSION` 2 made every sandbox re-sync once.

- **Owner runs** (chat, routine, task API, generators — principal = the avatar's owner) copy every root into
  `.noah/skills/`. A **non-owner run** (a colleague in their OWN sandbox, a consultation in its fresh one) gets only the
  bundled default-skills as files, in a SEPARATE folder `.noah/skills-shared/<root>/` (so it can never touch the
  sandbox owner's own copies); the owner's personal/plugin skills are listed `via: "mcp"` and read through `mcp__skills__read`
  (`skills` server — registered only on such runs, when such skills exist; files never land in the
  other user's sandbox; links and paths out of the skill are refused).
- **Admin skill policy** by omission: a disabled skill (bare name or `<plugin>:<name>`) is not copied, listed or readable.
- **Rewrites** in copied `.md` files: `${CLAUDE_SKILL_DIR}` → the skill's sandbox path; `timeout: 600000` (Claude
  Code ms) → `timeout: 600` (pi seconds, max 86 400). Served skills read `${CLAUDE_SKILL_DIR}` as `skill:<root>/<dir>`.
- **Re-sync** is a stat-only fingerprint (path, size, mtime) of the source root AND of what was written, kept in
  each folder's `.noah-sync.json`; a root is rewritten only when either side changed (so an edit in the sandbox copy
  heals). Noah owns both folders, never anything outside them.
- **Pruning (review-2 M1).** Runs of one sandbox sync concurrently with DIFFERENT root sets (a chat with group
  knowledge off next to one with it on, a generator, a colleague chat in the viewer's sandbox), and a turn's frozen
  index names its copies for the whole turn. So only OWNER runs prune — non-owner runs only write their own roots and
  merge the manifest — and an owner run removes a root it did not write only once no run used it (manifest `usedAt`
  or the entry's mtime, the newer) for `PRUNE_GRACE_MS` (6 h, past the task API's 5 h budget), or at once when the
  admin policy left that root with no skill. It collects stale `.noah/skills-shared/` leftovers by the same rule. So a
  skill copy of a root the user no longer has can stay in the user's own sandbox up to 6 h. `__pycache__`,
  `.build`, `.git`, `node_modules` and links are skipped; caps 5 000 files / 128 MB per root, 32 MB per file.

## Working repositories (design D1, `agent/pi/piRepoCopy.ts`)

The canonical clone (`dataDir/git-repos/<owner>/<name>`) stays Noah-side and is the ONLY `.git` Noah runs git in
(`serverGitEnv`). A pi run works on a COPY in the viewer's sandbox, `/workspace/repos/<owner-seg>/<name>/` —
tracked + untracked-not-ignored files and `.git`, plain files, links never copied (caps 50 000 files / 512 MB).

| Tool (pi wording in the static catalog) | Behavior |
|---|---|
| `open_repo` | ensures the clone + identity, makes/keeps the copy (`keep`: an existing copy made from the current HEAD whose own git HEAD is still on that base stays, edits and all; a stale or diverged one is replaced — deleted when `existingDisposable` proves it holds nothing but its base, else moved to a NEW `<name>.prev-<UTC stamp>`), returns the sandbox path — usable THIS turn |
| `commit` (pi only, `GIT_REPO_PI_COMMIT_TOOL_NAME`) | reads the copy's WORKING TREE back (lstat walk, `.git` skipped at every level, links/specials skipped and reported, ignore rules from the CANONICAL clone via `git check-ignore`, tracked files under ignored folders still compared; caps 100 000 entries / 20 000 changed files / 256 MB / 64 MB per file), writes changed files into the clone (never through a tracked link or onto a folder), deletes files gone from the copy, `git add -A` + `git commit` there, then replaces the copy's `.git` with a fresh copy of the clone's (sandbox `git status` is clean again) |
| `sync_repo` | refused while the copy has uncommitted changes (`copyHasChanges`: measured against the copy's BASE tree even after the clone moved — `readBackAgainstBase`, `git ls-tree` + blob hashes, never git in the copy — and always for a diverged copy); else syncs the clone and refreshes the copy, deleting the replaced copy only when `existingDisposable` proves it holds nothing but its base (or, after a `from` fast-forward, nothing but the new HEAD), else moving it aside. A copy whose HEAD is AHEAD of its base with sandbox commits (`CopyStatus.tip !== base`) gets its own refusal naming the three ways out (commit = new SHA; `from` = SHAs kept; reset to the base) instead of "uncommitted" (#81). **`from`** (another registered repo of the same owner): `fetchRegisteredCloneHead` fetches that repo's CANONICAL clone HEAD into this clone (Noah clone → Noah clone, never a sandbox `.git`), a dry-run `fastForwardGitRepo` refuses a non-fast-forward before anything changes, then a FAST-FORWARD-ONLY upstream update (`pullFastForwardOnly`: behind → ff, ahead → kept, diverged → refused; a rebase would give bridged commits new SHAs) and `git merge --ff-only` — SHAs, authors and messages kept. The source's BRANCH ref is fetched, not its HEAD (detached mid-rebase), without the source lock (nesting the two could deadlock `a from b` vs `b from a`); the source clone is used as it stands, never synced implicitly. A copy whose files equal that commit passes the gate (`piRepoCopyMatchesCommit`, the issue's "merged them in the sandbox" state) — also when it reads as `diverged` because the sandbox fetch landed as a PACK (100+ objects, which the loose-object walk cannot follow): then its HEAD must BE that commit and the canonical clone must show it descends from the base. The refusal's discard route is move-the-folder + `open_repo`, never a reset in the copy |
| `push` | pushes the clone (= what `commit` saved; sandbox-local git commits are never read) and notes uncommitted copy changes; `pushGitRepoDetailed` reads `git push --porcelain` and answers "Nothing to push" (never "Pushed") when origin already had the clone's HEAD (#81) |
| `remove_repo` / `close_repo` | remove the viewer's copy, every `<name>.prev*` and the record (behind the same copy gate as `commit`/`sync_repo`, before anything is removed) / keep the copy |

"Clean" has two strengths. For claim and sync refusal (`copyHasChanges`) it means no TRACKED-file change — what
decides whether someone's work is in the way. Deleting a replaced copy needs more (`existingDisposable`, review R3):
the read-back walk prunes ignored folders and skips links, so ignored content (`.env.local`, notes in an ignored
folder, build output), links, a `git stash` or a sandbox commit/branch would otherwise be judged clean and lost. A
delete therefore also requires the copy's HEAD EXACTLY on its base, every ref tip AND the new side of every reflog
entry (`.git/logs/**` — a commit undone by `reset --hard` lives on only there) a commit Noah's clone has
(`git cat-file --batch-check` in the clone; refs and reflogs read as data, never git in the copy), no linked worktree
(any `.git/worktrees/<id>`: its HEAD names commits no ref here does) and no reftable backend, no skipped entry
against the base tree, and a full walk (ignore rules NOT applied) finding nothing but folders and base-tree files
outside the top `.git`. Anything unreadable or over a cap counts as content, and "absent" means only what git itself
reads as absent: a missing `packed-refs`/`logs`/`worktrees` is none, but a `.git/refs` that is missing or not a
plain folder, or a `packed-refs`/`logs` that is a link, a special file or over its cap, is unprovable, never empty
(a stale copy whose reflog names a commit the clone has since pruned is therefore moved aside — the safe direction).
A replaced copy (open_repo `keep` AND sync `refresh` alike — review R4: keep mode used to move even a pristine copy aside, so every re-open after another conversation's commit left a full copy, `.git` included) is NEVER deleted unless proven disposable (review #13): it moves to a new `<name>.prev-<UTC stamp>`
(`-2`… when taken), older ones are never touched or replaced, and only `remove_repo` (or account deletion) clears
them — BOTH metacognition surfaces, the open_repo description and the manual say exactly that (`PI_REPO_REPLACED_COPY_SENTENCE`), never "never deleted". `git ls-files` listings are streamed (`gitListZ`, no exec buffer) and capped at the copy's file cap (review #15).

`commit` also refuses a copy whose OWN git HEAD left its base (`diverged`, review #6): Noah reads the copy's `.git`
as DATA (`readCopyGitTip`: HEAD → loose ref → `packed-refs`) and walks LOOSE commit objects' parents
(`copyDescendsFromBase`, zlib, 1 MiB / 1 000 steps) until the base, so sandbox-local commits on the base still
commit their files, while a checkout/switch/reset/rebase there (whose tree would undo other work) is refused and
both surfaces say never to do that. Residual: `git checkout <branch> -- .` looks like ordinary edits.

Each copy's BASE commit is recorded Noah-side (`dataDir/pi-repo-copies/<user-key>/<owner-seg>--<name>.json`, never
in the sandbox). `commit` over a moved base (another conversation or a colleague committed, a sync pulled) is
refused with a redirect to re-open (last writer wins, never silently over a newer base). Turn start
(`resolveActiveWorkspaceRepo` with `piWorkspace`) only creates a MISSING copy. The copy is ONE per (principal, owner,
repo) and its edits carry no conversation, so two guards keep one conversation from committing another's half-done
work (review #5, 2026-11-01): a RUN lock on the copy (`piRepoCopyLockKey` in the in-memory `activeRepoLock`; turn
start → `locked`, and `open_repo`/`sync_repo`/`commit` of another conversation refuse while it is held — and those
three TAKE it for their own conversation (review R2): a run that opens the repo MID-turn holds the lock exactly like
one that started with it open, through the run's `RunRepoLocks` (`activeRepoLock.ts`, made by `runPiAgent`, handed
to the tools as `GitRepoToolsContext.copyRunLock` via `RunCapabilityOptions.piRepoLocks`, released in the run's
`finally` after the run token is revoked; only a lock the run newly took is released, and a tool refused on the
holder check gives a newly taken one back at once) and a
persistent HOLDER in the copy record (`claimPiRepoCopy`: another conversation may take the copy over only while it
is clean, or once the holder no longer has the repo open; else turn start → `held`, the tools refuse). The chat route
answers both with 409, the scheduler skips the routine (`ROUTINE_REPO_BUSY`). `remove_repo` passes the same gate
(`copyAccessRefusal(ref, "remove")`) BEFORE it deletes the registration, the clone or the copy: it deletes the copy
and every `.prev*`, so another conversation's run (or its uncommitted work) must never be under it.
Both surfaces: the prompt's working-repo section and describe_system's working-repo line name the copy path and the
commit → push flow (`PiRuntimeFacts.activeRepoDir`, set only when `sandboxOwner === "owner"`).

**No copy outside the owner's sandbox (review #11, user decision 2026-11-01).** A run whose sandbox is not the
avatar owner's — a trusted colleague's chat — never gets a copy of the owner's repository (it used to: working tree
AND `.git`, history included, in the colleague's persistent sandbox, outliving the trust that made it). `open_repo`
only selects the repo for the conversation, turn start (`resolveActiveWorkspaceRepo`) only ensures the clone (no
copy, no copy lock), and the colleague reads Noah's canonical clone through `mcp__git_repo__list_files` /
`read_file` / `grep` (`GIT_REPO_READ_TOOL_NAMES`, `gitRepoRead.ts`: every read under the clone's `withRepoLock`, so never a half-done sync or commit — list/read show the working tree as the last sync or commit left it, grep the index; every path component lstat-checked and every folder/file opened only when its descriptor path is the checked one (`listDirVerified`, `readRegularFileAsync` + `fdPathIs`, review R7), links never
followed, `..`/`.git` refused, 1 MB / 2 000-line / 1 000-entry caps; `grep` is `git grep --cached` in the clone,
64 KB / 30 s). They sit on every git_repo server (static catalog), `mcpAllowedTools` admits them only when
`sandboxOwner !== "owner"`, and each handler re-checks `elevated`, not-the-owner's-sandbox and the repo still
registered. `commit` refuses with a redirect; `sync_repo`/`push` act on the clone as before. The per-turn line, the
frozen teammate git section and describe_system's pi lines point the colleague at the read tools, never a
`/workspace` path. Existing colleague copies are retired at boot by `retirePiColleagueRepoCopies`
(`retirementGate` + marker `retired:pi_colleague_repo_copies`): every `u-<key>/repos/<seg>` whose `<seg>` is not
that user's own is moved — one rename through pinned folders, never followed or deleted — to
`<PI_WORKSPACES_DIR>/.noah-retired/<stamp>/u-<key>/repos/<seg>` (same filesystem, so no EXDEV; pi's sandboxd mounts
only `u-<24 hex>`, so no sandbox can reach it; reserved forever, never pruned — the operator's to clean up), and the
matching `pi-repo-copies` records go to `<dataDir>/retired/<stamp>/` (`quarantineRetired`).

## Decks

On pi the deck toolchain is `piSandboxDeckToolchain(config)` (`deckRender.ts`), never the host probe:
`PI_DECK_SANDBOX=true` = converter INSTALLED with the sandbox image's facts (profiles embedded + malgun, one build
slot per sandbox, python-pptx present); off = `converter: NOT INSTALLED` with the operator fix named. The legacy
render path is off (no LibreOffice in the sandbox); `libreOffice` keeps the host value because share_file's approximate
previews still render Noah-side. Both metacognition surfaces and the static catalog's share_file wording read it.

## Proxied MCP servers (`agent/pi/mcpProxies.ts`)

Servers that exist only as a process or a remote endpoint are relayed by Noah as an MCP CLIENT and re-exported
on the run endpoint. Broker ids are global and pi freezes a session's tool list, so each kind is ONE stable id:

| Broker id | Source | Model-facing name | Child Noah spawns | Secrets |
|---|---|---|---|---|
| `hex-ssh` | the owner's SSH key (`sshActive`) | `mcp__hex-ssh__<tool>` (the pre-pi name, unchanged) | `scripts/hex-ssh-policy-proxy.mjs` → `HEX_SSH_UPSTREAM_COMMAND` | SSH material in the child's env (Noah spawns it itself: no argv, no wrapper file) |
| `plugins` | the run's plugin roots' `.mcp.json` (first name wins, load order) | `mcp__plugins__<server>__<tool>` | stdio: the def's command (`${CLAUDE_PLUGIN_ROOT}`/`${VAR}` expanded, cwd = def `cwd` or the root) — **bundled roots only** (see below); http/sse: `mcp-http-bridge.mjs` | NO plugin def gets the vault on pi. An http/sse def outside the bundled roots that names ANY `${…}` placeholder sits out (`piPlaceholderRefusal`); bundled defs keep `${VAR}` expansion from Noah's scrubbed env |
| `shared` | admin 공용 MCP servers (`planSharedMcpRun`, owner bindings) | `mcp__shared__<server>__<tool>` | always the bridge (header-less ones too: keeps `--use-system-ca` + error scrubbing) | slot values only in the bridge config file (written right before spawn, deleted by the bridge, `rm` again after) |

- pi's `mcp_call` resolves the plain form `mcp__<server>__<tool>` by suffix (`resolveAlias` in pi), so skills that
  name a plugin/shared tool without the relay prefix keep working. A plugin server named like a Noah server or an
  enabled shared server sits out and both surfaces list it with the reason; so does an http def with fields the bridge
  cannot carry (`oauth`, `headersHelper`, …).
- hex-ssh's per-viewer-class allowlist holds three times: the policy proxy (env `HEX_SSH_ALLOWED_TOOLS`), the
  pool (`allowTool` filters `tools/list` AND refuses `tools/call`), and the endpoint's `allowCall`.
- **Lifecycle:** one `PiMcpProxyPool` per run; nothing is spawned at plan time — a child starts on the first
  `tools/list`/`tools/call` that needs it (`tools/list` at session build: 10 s per source, a slow one is left out
  rather than failing the whole id within pi's 15 s). `finally` closes every client (stdin EOF → SIGTERM →
  SIGKILL; the policy proxy now also exits on stdin EOF) with a 0.5 s grace before the run returns; the close keeps
  going after. A closed pool refuses calls instead of respawning. Tests prove no process outlives it.
- **`tools/list` is bounded and fails CLOSED (review #10).** The upstream controls pagination, and a server repeating
  its `nextCursor` once kept Noah fetching and holding pages until the process ran out of memory (every re-list
  started another loop). Now: ONE deadline per source over its start and every page plus the pool's own
  AbortSignal (`close` aborts every listing in flight) are passed to each `listTools` request; a source's listing is
  memoized per connection (concurrent lists share it; a failed one is not kept, so a timeout is asked again later);
  past `LIST_MAX_PAGES` 50, `LIST_MAX_TOOLS` 1000 or `LIST_MAX_BYTES` 2 MiB, or on a repeated cursor, the source is
  REFUSED for the run — its child is closed, `connect` refuses it, and `callTool` answers an English redirect (tell
  the user, do not retry). Truncating instead was rejected: the unlisted tools would stay blind-callable.
  `listToolsReport` returns `{tools, failed: {name, reason, kind: timeout|refused|error}[]}`; the frozen prompt's
  relayed-tools line (`piKnownTools` → `relayedFailures`) says "did not answer in time" only for a timeout, names a
  failed one, and lists refused ones as final; `onListFailure` keeps `PiProxiedMcpFacts.listFailures` live for
  describe_system's relay line. A failure reason is always Noah's own text, never the upstream's error message
  (it lands in the frozen instructions).
- **One message is bounded too (review R5).** The byte cap above runs only after a page is parsed, and the SDK's
  stdio reader buffers a line until its newline, so every child Noah reads (the pool, the admin connection check)
  uses `BoundedStdioClientTransport` (`agent/pi/boundedStdioTransport.ts`): a stdout line past
  `MCP_RELAY_MESSAGE_MAX_BYTES` (8 MiB — a few-MiB result such as a base64 screenshot or a long file read fits; a
  page of tool definitions is capped at 2 MiB anyway) is dropped while it arrives and the child is stopped. A listing
  cut that way REFUSES the source ("it sent a single MCP message larger than 8 MiB"); a cut `tools/call` answers
  Noah's own redirect (ask for less, do not repeat unchanged) and the next call starts the child afresh (a bridge
  cannot restart: its config was one-shot). The bridge enforces the same default on the REMOTE side (below and
  `secrets-ssh.md`), so through it this guard is the backstop. The subclass swaps the SDK's private `_readBuffer`
  and throws at construction if that field changes shape — an SDK bump fails the relay tests, never the cap.
- **Redaction (`piRedactions`)**: the relays' secrets (the whole injectable vault once any of it reached a child,
  credential-looking bridge headers + their bare tokens via `mcpBridgeRedactions`, the
  SSH key/passphrase/password — never `SSH_USER`/`ALLOWED_HOSTS`), every browser-typeable secret value and the
  run's `sandbox_env` values. Applied by the endpoint's `transformResult` to EVERY Noah MCP result of the run
  (`redactSecretValues`, `[REDACTED:<NAME>]`). pi redacts the `sandbox_env` values from its own built-ins' results.
- **stdio servers spawn only from bundled plugins (`piStdioRootRefusal`).** A stdio def is a command Noah runs in
  ITS OWN container (the data volume, every user's state), so on pi only roots no agent can author qualify: the
  plugins bundled with this Noah build (`DEFAULT_PLUGINS_DIR`, classified by `piPluginRootKind`, `piSkills.ts`).
  Every other root is agent-writable and its stdio servers sit out, listed with the reason on BOTH surfaces (the
  frozen prompt's relay sentence and describe_system's relay line):

  | Root | Why it is agent-writable |
  |---|---|
  | personal knowledge clone (`dataDir/knowledge/<user>`) | `mcp__repo__*` write + commit, directly on that clone |
  | installed plugin repo (`dataDir/plugins/<user>/<repo>`) | at one remove: `mcp__git_repo__open_repo` takes any URL and `push` uses the owner's git token, and the next plugin refresh pulls what was pushed (Noah cannot tell which remotes the token can write, so all are refused) |
  | anything else | unknown provenance, refused (fail closed) |

  http/sse plugin servers are unaffected (the bridge is Noah's own script; the def supplies only a URL and
  headers), and so are admin 공용 MCP servers. A user who needs a stdio tool on pi gets it bundled into
  `default-skills`, as an http server, or as a 공용 MCP server. Moving plugin stdio servers INTO the viewer's
  sandbox would need pi's per-user sandbox MCP (a pi-gateway change, out of scope).
  **Placeholders (hardening 5a):** the same agent-writability decides http/sse defs. Every root but the bundled one
  is agent-editable, so a def there naming a `${NAME}` placeholder (a vault secret, or a value from Noah's own env)
  could send it to a host of its choosing from Noah's network, past the sandbox egress allowlist. On pi such a def
  sits out with a reason (`piPlaceholderRefusal`; both metacognition surfaces list it, and the prompt's secret
  section plus describe_system's secret line say no plugin def receives a secret here); one without placeholders
  relays verbatim. A user's secret reaches an external server only through a 공용 MCP slot binding. (The retired SDK
  runner substituted the vault into OWNED roots' defs through a secret wrapper; with it gone no plugin def anywhere
  receives a vault value.)

## Asynchronous tools (design D8, `agent/pi/asyncJobs.ts`)

pi's broker gives a call at most its server timeout, so a Noah tool that waits on a person or another run no longer
holds it:

- **`mcp__avatars__ask_avatar`, interactive chat** (a run with a steer channel): the handler runs the synchronous
  gates (`preflightAvatarAsk` — unknown/self/untrusted refuse at once) and returns `Consultation ask-<id> … started in
  the background`. The consultation (a pi run in its own fresh sandbox) runs as a `PiAsyncJobs` job; its
  result is pushed into the run's SteerChannel with BOTH texts (`askOutcomeDelivery`: English with provenance for the
  model, a Korean bubble carrying the answer for the chat — `SteerRecord.displayText` — plus WHO answered,
  `SteerRecord.source`). The route persists it as a `kind: "consultation"` user row with that source
  (`messages.consultation_json`), NEVER as a `steer` the owner typed: another avatar's answer is untrusted input, and
  any history rebuild (a fresh session after a cancel, heal or rewind; `read_conversation`) re-feeds
  it framed by `consultationHistoryText` as that avatar's untrusted data, never as the owner's words. It is never a
  rewind/regenerate anchor, the client renders it under the consulted avatar's name (`@x 아바타의 답변`, badge `팀원
  상담 결과`), never shows it as a pending "나" bubble and never hands a dropped one back to the composer
  (`SteerPublic.source`). A result that lands while a pi response runs is folded into it like a typed steer; after
  the pi response completes, `runPiAgent` keeps the run OPEN while jobs are pending
  (status `팀원 아바타의 답변을 기다리는 중…`, capped at the consultation budget + 30 s; a message the user sends wakes
  it too), then delivers everything queued as ONE follow-up turn (the steer `turn_end` contract). So the answer always
  lands in a live run the client is attached to — no server-started turn the client would only discover on reload. A
  run that ends anyway (cancel, error) aborts its jobs; nothing is delivered later. Stop pressed DURING that wait ends
  the run as cancelled (`PiGatewayError("aborted")`), never as `done`.
- **Unattended pi runs** (routines, task API — no steer channel) keep the waiting call (`avatars` broker timeout
  240 s ≥ the 3 min consultation budget).
- **Canvas**: never waits (`canvasTools.ts` has no blocking mode any more) — controls always render non-blocking
  (`awaitInput: false`, `interaction: "async"`) and the submission arrives as the user's next message. Known edge: while a run is still open (waiting for a consultation)
  the client does not submit an async canvas (`submitCanvas` returns while streaming).
- Tool descriptions (`ask_avatar`'s two-mode sentence and the canvas never-wait sentence, the same text in the static
  catalog and on every run), the prompt (`piAsyncToolsSentence`) and
  describe_system ("Long-running tools on this runtime") state this.

## Tool discovery (usability report §6.5)

On pi the model sees only `mcp_search`/`mcp_call`; every Noah tool is found by pi's BM25 search (tool name, description,
argument names/descriptions and the broker entry's displayName/description; results carry the whole description + schema).
Measured without a model, then mitigated Noah-side:

| Mitigation | Where | Notes |
|---|---|---|
| **Known Noah tool names** in the frozen prompt | `piKnownTools` (`mcpCatalog.ts`) → `PiRuntimeFacts.knownTools` → `piKnownToolsSection` | Built only while the conversation has no `pi_instructions` (its first pi turn): every tool of THIS run (`mcpAllowedTools` ∩ catalog), one line `mcp__<server>__<tool>(<required args>)`, catalog order (servers as `PI_NOAH_SERVER_NAMES`, tools in registration order), then relayed tools read from the run's proxy pool (`listToolsReport`, pi's name sanitizing, sorted; a source that timed out or failed is flagged, a refused one named as final — see "Proxied MCP servers"). Frozen with the rest (D2): a later tool is found with `mcp_search`, a listed one may be refused (describe_system is authoritative). ≈3.4k chars for all 99 Noah tools |
| Query line | `MCP_SEARCH_QUERY_LINE` (`piRuntimeSection`) | English, service id + action — tool text is English and keyword-matched |
| Callable-now mirror | describe_system `piRunLines` ← `PiRuntimeFacts.callableNoahTools` (set after `mcpAllowedTools`) | live list of exact names |
| Full sibling names | prompt, manual, skills, tool descriptions, errors | a bare `write_file`/`commit`/`get_note` is ambiguous in pi's `mcp_call` (repo vs git_repo) |
| Compact descriptions + discovery sentences | `pi/catalogText.ts`, applied by `piCatalogTool` in the STATIC catalog only (the builders keep the full text) | a compact entry names the sha256 of the builder text it replaces; a changed builder text is served instead (warn) and the test fails until the entry is revisited. Sentences were kept because the held-out query set did not regress |
| Noun-only broker descriptions | `SERVER_DESCRIPTIONS` in `scripts/pi-register-mcp.mjs` | pi shows the first line in the always-visible service list AND appends it to every tool document of that server, so verbs there match every tool (measured: verbs cost held-out recall) |
| Unknown argument names refused | `checkArguments` gate + `unknownArgumentProblem` (`mcpHttp/endpoint.ts`), wired by `runPiAgent` for Noah's own servers | the McpServer's zod objects STRIP unknown keys (MCP SDK 1.29 `z.object`), and the catalog schemas have no `additionalProperties:false`, so `list_todos {state}` used to list everything; now the call is refused with the valid names (nested objects/arrays of objects checked; `anyOf` branches and open objects not). Relayed servers are not judged |

**What pi does to the arguments BEFORE Noah is called (pi-ai 1.5.2 since pin `92a69dd`; seen on the dind stack,
→ `build-run-verify.md`).** pi's `mcp_call` validates the model's arguments against the schema Noah's `/mcp`
LISTS and calls the tool with the CONVERTED value; a failure is a tool result the model reads —
`Validation failed for tool "<name>":`, one `  - <path>: <problem>` line each (`id: missing`, `sinceHours:
expected integer, got string`, `status: expected one of [...]`), the received arguments, then
`Parameters of <name>: <schema>` — and the turn goes on. Nothing in Noah quotes or parses that wording.
- **Converted, then run:** a numeric string for a number, `"true"`/`"false"` for a boolean, a number for a
  string, a `null` for an optional non-nullable argument (dropped) — and, new with 1.5.2, ONE value where an
  array is listed is wrapped (`add_todos {items: {title}}` adds the item; `tags: ""` becomes `[""]`). The
  numeric string and the wrap were seen through the stack, the rest with pi-ai's validator alone.
- **The wrap is not a parse.** An array sent as a JSON string — a known open-model mistake — is one string, so
  it becomes a ONE-item array and passes: `tags: "[\"알파\",\"베타\"]"` stored a to-do with the single tag
  `["알파","베타"]` (pi 1.2.0's validator refused it with `must be array`). It reaches a handler only where the
  items are strings; an array of objects, numbers or enum values still fails on the item. **Every
  list-of-strings argument is read through `unwrapStringList` (`agent/mcpTools.ts`)**: exactly ONE item
  that parses as a JSON array of strings is taken as that list, anything else is left alone. Today:
  `todoTools.ts` `tags` (add and update), `teamBrainTools.ts` `personalNotes` and `conflicts`. A new
  `z.array(z.string())` argument goes through it too.
- **A value outside a LISTED enum never reaches the handler** (1.2.0's validator refused it too): the model
  reads pi's `<arg>: expected one of [...]`. So an argument whose bad values must hear a REDIRECT is a plain
  string with its values in the description, checked in the handler — never an enum, in zod or in the
  listed schema. The canvas `contentType` is that (the retired `'widget'` / `'vega'` answer
  `WIDGET_RETIRED_ERROR` / `VEGA_RETIRED_ERROR`); until 2026-11-14 its listed schema carried the enum
  through `.meta()`, and a pi model was told `expected one of ["markdown","mermaid","svg","html"]`
  instead of where the feature went. An ordinary enum, whose only wrong answer is "not one of these", stays
  an enum.
- **An unknown argument NAME passes pi** (the catalog schemas are open) and is refused by the gate above.
- **Tool-call JSON that is cut off runs nothing** (`Invalid arguments for tool "bash": Unexpected end of JSON
  input` + the text received); by pi's commit, 1.2.0 ran the tool on the fields that had arrived.
- **pi's own `grep`:** its `glob` is relative to `path`, as its description tells the model (`src/**/*.ts`; a
  pattern without `/` matches at any depth; a leading `./` is dropped; `!…` excludes). Since pi `cbbb1b7` the
  gateway runs ripgrep IN the searched directory — at `92a69dd` it ran in the session's cwd, so with a `path`
  elsewhere a glob holding a `/` answered `No matches found`. Results are named relative to `path`. A glob
  written from `/workspace` with a `path` elsewhere no longer matches.

## The `/mcp` endpoint (`mcpHttp/endpoint.ts`)

Mounted by `createApp` at `/mcp/:server` on every runtime (no token exists without a pi run → always 401). Its only
auth is the bearer run token; session cookies and other app auth never apply (`tests/pi-runner.test.ts` pins that a
signed-in cookie alone gets 401). The registry lives per Store (`piServicesFor`), shared by the router and runner.
It is mounted BEFORE the global `express.json({limit: "50mb"})`, so its own 16 MB body cap is the effective one.

**Network exposure (operator requirement):** the router shares Noah's listener, so with no allowlist the run token's
secrecy is the only barrier for an off-network caller. Either bind/firewall the port to the broker's network, or set
`NOAH_MCP_ALLOWED_CIDRS` (`mcpHttp/networkAcl.ts`, `net.BlockList`): only those TCP peers (never `X-Forwarded-For`;
`::ffff:` IPv4 peers are mapped) pass, everyone else gets 403 before the body is parsed or the token is read. Default
open; an invalid entry stops the boot. The bundled compose stack sets it to the broker's pinned `/32` (next section).

## Deployment: the bundled compose stack (U9; the dedicated instance of D5)

Noah and its pi-gateway are ONE `docker compose up -d --build` (operator steps: README "Deployment"; the dind
boot-test recipe: `build-run-verify.md`). No pi-gateway code or compose file is edited or copied:

- **`include:`** — `docker-compose.yml` includes `${PI_GATEWAY_DIR:-./vendor/pi-gateway}/docker-compose.yml`, the
  pi-gateway GIT SUBMODULE (`.gitmodules`, `ignore = untracked` for pi's own `.env`; the gitlink is the pin this
  branch is verified against, excluded from the Noah image by `.dockerignore`),
  together with `docker/pi/compose.override.yml` — Noah's instance configuration merged onto pi's services
  (sandboxd's `SANDBOX_IMAGE=noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG}`, built by the build-only
  `pi-sandbox-image` service FROM pi's own `sandbox-image`; the gateway's `SESSION_IDLE_SECONDS` from
  `NOAH_PI_SESSION_IDLE_SECONDS`, default 1800 — a reloaded idle session re-lists every Noah server, so pi's 300
  turned every 5-minute pause into a session start, see README "Sizing pi-gateway"; the broker's `noah-mcp`
  address; the trace store's image, `NOAH_PI_JAEGER_IMAGE` — since pi `8930c49` pi's stack has a `jaeger`
  service (one OpenTelemetry trace per turn: names, durations, token counts, error kinds — no prompt, tool
  argument or result; `control` network only, 7 days on `jaeger-data`) whose image pi pins by its Docker Hub
  name with no variable, so ONLY the image is overridden and its default must equal pi's pin
  (`tests/infra-compose.test.ts`). Tracing is ON by default — pi sets `JAEGER_HOST` on its three services and
  Noah does not unset it; a bump that changes the pinned jaeger version fails that test until the default
  follows). A pi-gateway bump
  moves the submodule (`git -C vendor/pi-gateway checkout <pushed commit>` + commit the gitlink) and re-runs the
  boot test.
- **`pi-setup`** — a one-shot service (`FROM` Noah's image, uid 10001 = the owner of pi's `admin_api_key` secret,
  read-only, caps dropped) that runs `docker/pi/pi-setup.sh` → `scripts/pi-register-mcp.mjs --configure-instance`
  once the gateway is healthy. It is idempotent and re-runs on every `up`; `noah-almighty` starts only after it
  exits 0 (`service_completed_successfully`). The admin key reaches the script through its env, never argv.
- **Networks** — Noah joins pi's `edge` network to call `http://gateway:8080` (`PI_GATEWAY_URL`, fixed by compose).
  pi's broker calls Noah's `/mcp/<server>` over `noah-mcp`, an INTERNAL network only the broker and Noah are on,
  from a pinned address (`NOAH_MCP_BROKER_IP`, default `172.16.248.10` in `NOAH_MCP_SUBNET` `172.16.248.0/24` — outside
  Docker's default auto-allocation pools, so no auto-allocated network, this stack's own included, can overlap it);
  `NOAH_MCP_ALLOWED_CIDRS` defaults to exactly that `/32`, so the network gateway (where published-port traffic can
  appear from) and every other pi service get 403. Sandboxes keep `network_mode: none` and gain no route.
- **Service key** — Noah's OWN 0400 uid-1000 copy of pi's service key (`docker/pi/setup-host.sh` copies it to
  `$PI_GATEWAY_SECRETS/noah/pi_gateway_api_key`), mounted as a compose secret and read through
  `PI_GATEWAY_API_KEY_FILE=/run/secrets/pi_gateway_api_key` (see "Env"); never in `.env` (an inline
  `PI_GATEWAY_API_KEY` there stops the boot). Same-uid caveat (#71): the file is readable by every uid-1000 child
  Noah spawns (hex-ssh, bundled stdio plugin servers, the HTTP bridge, git, LibreOffice) — the env scrub does not
  cover files; see `secrets-ssh.md` ("Same-uid posture (#71)").
- **Admin key** — Noah's OWN 0400 uid-1000 copy of pi's ADMIN key (`$PI_GATEWAY_SECRETS/noah/pi_gateway_admin_api_key`,
  same `setup-host.sh` step), compose secret `pi_gateway_admin_api_key_noah`, read through
  `PI_GATEWAY_ADMIN_API_KEY_FILE` for the `/admin` panel proxy (below). Same same-uid caveat as the service key, with a
  wider blast radius: the admin key configures pi itself.
- **Workspaces** — `$PI_GATEWAY_HOME/workspaces` is bind-mounted at `/srv/pi-workspaces` (`PI_WORKSPACES_DIR`,
  fixed), uid 1000 on both sides.
- **Shared variables** — Noah's `.env` (and the shell) win inside pi's included file too, so a key both read means
  the same on both sides: `NODE_EXTRA_CA_CERTS` is a HOST path (pi's meaning; compose mounts it read-only into
  Noah at `/etc/noah-almighty/extra-ca.pem` and points Noah's variable there), likewise `GOPROXY`, `LOG_LEVEL`,
  `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PI_GATEWAY_HOME`, `PI_GATEWAY_SECRETS`.
- **Not supported with the bundle:** the egress overlay (`docker-compose.egress.yml`, `docs/egress-policy.md` —
  its firewall admits only its own proxy, so Noah cannot reach pi's gateway), and a second pi-gateway on the same
  Docker daemon (pi's sandboxd adopts and reaps every `pi-gateway.instance=default` sandbox there).

Run the registration by hand only for a native (non-compose) Noah:

```bash
PI_GATEWAY_ADMIN_KEY=… node scripts/pi-register-mcp.mjs --gateway http://pi-gateway:8080 \
  --noah-url http://<host-as-seen-from-the-broker>:48787 --configure-instance   # idempotent; --dry-run / --remove
```

- Each entry carries a noun-only `description` (`SERVER_DESCRIPTIONS`, see "Tool discovery"); re-running the script
  converges it.
- Registers one broker entry per `PI_MCP_SERVER_NAMES` name (ids = Noah server names, so pi's `mcp__<id>__<tool>`
  equals every `mcp__repo__commit`-style name in prompts/skills/manual, plus the relays `hex-ssh`/`plugins`/`shared`),
  header `Authorization: Bearer {{ctx.header:x-noah-run-token}}`. `timeoutSec` 120 by default; longer only where the
  server's own work needs it (`SERVER_TIMEOUT_SEC`: `avatars` 240 — unattended ask_avatar still waits; `repo`/`git_repo`
  300 — clone/sync/push + sandbox copy; `file_output` 240 — Noah-side deck previews; `hex-ssh` 600,
  `plugins`/`shared` 300 — remote/third-party). Browser ops fit easily (the bridge relay times out at 45 s).
  `--timeout-sec N` overrides every id. Every run also deletes this Noah's entries under a RETIRED id
  (`RETIRED_MCP_SERVER_NAMES`: `group_brain`, `group_repo` — retired 2026-10-30; `web` — the web fetch tool, removed 2026-11-10), and Noah's `/mcp` answers a
  call that still reaches one with a "was removed" error (`RETIRED_SERVER_MESSAGES`, `mcpHttp/endpoint.ts`). A TOOL removed from a server that still exists is answered the same way, before the per-call gates (`RETIRED_TOOL_MESSAGES`, keyed `<server>/<tool>` — the five team-brain review-queue tools, 2026-11-13 → [`team-brain.md`](team-brain.md) "Tools"); tools/list never names one. Refuses to take over an id pointing elsewhere without `--force`. The admin
  key is read from the environment only and never stored by Noah.
- `--configure-instance` also disables pi's `request_admin` and `present_file` built-ins (Noah has its own) and deploys
  `scripts/pi-system-prompt.md` as the live prompt `noah` (pi's default hardcodes "Reply in Korean" and request_admin;
  pi enforces no placeholder, the template keeps `{{WORKSPACE}}`, `{{LANGUAGE}}`, `{{DATETIME}}`).
- Other instance config stays in pi's own admin/`.env`: LLM servers, `SANDBOX_EGRESS_ALLOW`, turn concurrency limits
  (pi's defaults fit a small team; README "Sizing pi-gateway" has the measured sizing and the session-start limit).
  (`SANDBOX_IMAGE` and `PI_DECK_SANDBOX=true` are fixed by the bundle; a native setup sets both itself.)
  `SANDBOX_EGRESS_ALLOW` is the sandbox shell's ONLY way out (HTTP(S) via pi's egress proxy; empty = all blocked, a
  refusal is `407`). Noah's `NOAH_EGRESS_POLICY=domain-proxy` (and its 외부 통신 차단 panel) governs only Noah's own
  tools and relays on a pi run, so the prompt's egress line, describe_system's and the `network-policy` manual
  topic say exactly that.

## pi admin panel proxy (`routes/piAdminProxy.ts`)

pi-gateway's own admin panel (LLM servers and models, the default model, prompts, MCP, tools, history, its test
chat) is served on Noah's port at `/admin` — pi's OWN path, because its UI hard-codes `/admin/` and `/admin/api`
(Vite `base`), and Noah's SPA uses `#/…` hash routes, so the server path is free. `/settings/pi` redirects there.
The operator is the same person as Noah's admin (user decision 2026-11-01), so Noah's admin session IS pi admin —
and pi's admin may act as ANY pi user: read every user's pi history (`history/<id>`), read files from any user's
sandbox (`chat/file?user=`), and run the test chat — full bash — in any user's sandbox. **Granting someone Noah's
`admin` role grants that too.**

- **Gate** — every `/admin` request resolves the Noah session first; anonymous/non-admin → `/` (page) or pi's
  error shape 403 (API; never 401 — pi's UI answers a 401 with its own key login form, which cannot fix a missing
  Noah session and would invite pasting pi's key), and nothing is forwarded.
- **Target** — only an origin-form target under lowercase `/admin` with no `.`/`..` segment (plain or
  percent-encoded), no encoded slash or backslash and no raw backslash goes on, and the resolved URL is re-checked (pi's origin, path
  still under `/admin`); else 404. Express matches the mount case-insensitively and keeps `..` and an
  absolute-form target (`GET http://evil/admin/…`) in `originalUrl` — resolving that against pi's URL would send
  the admin key off pi's `/admin` tree or to another host.
- **Key** — Noah's cookies, any client `Authorization` and client `X-Forwarded-*` are stripped; pi's admin key
  (`PiRuntimeConfig.adminApiKey`, `PI_GATEWAY_ADMIN_API_KEY_FILE` ONLY — an inline `PI_GATEWAY_ADMIN_API_KEY` stops
  the boot) is injected as `Authorization: Bearer`. Without the key `/admin` answers a Korean 503.
- **CSRF** — pi skips its own `X-Admin-Request` check for bearer callers, and an injected bearer is ambient, so
  Noah checks instead: a non-GET/HEAD/OPTIONS call needs `Sec-Fetch-Site: same-origin` (or, without it, an
  `Origin` whose host is the request's Host; the scheme is not compared, for TLS-terminating proxies) AND
  `X-Admin-Request: 1`. The ambient key makes a GET dangerous too (a user's sandbox file, another user's history,
  pi starting a sandbox for any id), and pi's UI loads `chat/file` through plain `<img>`/`<a download>`, so no
  custom header can gate reads: EVERY `/admin/api` request must also come from pi's own page — `Sec-Fetch-Site`
  absent or `same-origin`, and no `Referer` outside `/admin` on the request's host. pi's UI is `no-referrer`;
  Noah's SPA sends `same-origin` referrers and its sanitizer drops `referrerpolicy`, so a markdown image or link
  rendered in Noah (an avatar intro naming `/admin/api/chat/file?user=…`) is refused. Without fetch metadata
  (plain HTTP to a non-localhost host) only the `Referer` rule applies.
- **Routed path** — pi's router percent-decodes before matching, so every path decision (audit, the local
  login/logout answers, API vs page) reads the DECODED path, folded over-inclusively (case, repeated/trailing
  slashes, a `;…` suffix): `/admin/api/chat/%66ile` is audited as `chat/file`, `POST /admin/api/%6cogin` is answered
  locally. HEAD runs pi's GET handler, so it is audited like GET.
- **Local answers** — `POST /admin/api/login|logout` never reach pi: forwarding a typed key would count failures
  against Noah's ONE address in pi's lockout, and there is no pi session to end. Logout answers `{ok:true}`; login
  answers a Korean 400 (`noah_proxied`: sign in to Noah and reload) — the form only shows when something else
  failed, so a typed key is never treated as a fix.
- **Streaming** — mounted BEFORE `express.json` and Noah's security-header middleware: bodies stream both ways
  (pi's test chat is SSE; no timeout once headers arrived), pi's own CSP/X-Frame-Options reach its UI, pi's
  `Set-Cookie` is dropped. Upstream down → 502 (Korean). Waiting for pi's headers is bounded at 60 s for a read but
  15 min for a write (`PI_ADMIN_PROXY_TIMEOUTS`): a plugin install runs several git commands of up to 120 s each,
  and a write cut short would report a failure pi then applies. A timeout answers 504 and audits the write as
  응답 시간 초과(반영 여부 미확인).
- **Inert API content types** — `chat/file` serves agent-written sandbox bytes under Noah's origin, so an
  `/admin/api` response keeps its content type only when inert (JSON, SSE, `text/plain`, `image/*`); anything else
  (`text/javascript` above all, which Noah's `script-src 'self'` would run) is relayed as
  `application/octet-stream`, always with `nosniff`. pi's page assets (`/admin/assets/*`) keep theirs.
- **Audit** — every forwarded write AND every API read except pi's known config/global reads (`UNAUDITED_READS`:
  session, status — polled every 10 s —, llm, tools, mcp/servers, history/retention, marketplaces, plugins,
  plugin-settings, chat/options, prompts, prompt-deployments) is an audit row `pi_admin_proxy` with `METHOD path`
  only — so `history`, `history/<id>`, `chat/file`, `requests` and any read pi adds LATER are audited by default.
  `traces/stats` (pi `ad2d30f`, the panel's 운영 → 실행 시간 page) was such a later read and STAYS audited: its
  slowest-turns list names pi sessions, and the page reads it once per open (no polling), so one row per look.
  No query and no body, except the pi user the call acts as: the query's `user` (`chat/file`, `history`,
  `chat/<id>/cancel`) or the JSON body's `user` of an admin chat / preview (`POST chat`, `chat/preview` — the
  body is buffered for it, up to pi's own 16 MiB limit, else 413 without forwarding), so the row says whose
  sandbox or history was touched. A write whose
  browser left before pi answered is recorded as an error marked 반영 여부 미확인 (pi may have applied it). The
  audit write runs in socket listeners outside Express, so it is caught and logged — a `SQLITE_BUSY` there must
  never become an uncaughtException that stops Noah.
- **Plugin updates nobody pressed (pi `08d35cb`)** — refreshing a marketplace in the panel now also reinstalls
  each of its plugins that has a new version (a plugin that cannot be installed stays on its installed version,
  marked 업데이트 있음), and the gateway refreshes every marketplace once an hour by itself — a fixed interval
  with no switch. The hourly refresh is not a proxied call: Noah's audit log has NO row for it and nobody gets a
  notice, so what it updated or failed to update is in the GATEWAY's log only (`marketplace refreshed`,
  `plugin installed`; by pi's code a warn line `marketplace refresh had warnings` / `marketplace refresh failed`).
  A conversation already going keeps the skill list it began with; a new one gets the new version. The gateway
  must be able to reach each marketplace's git host for it.
- **What does not stick** — `pi-setup` re-applies Noah's prompt `noah` (`scripts/pi-system-prompt.md`), its MCP
  broker entries and the disabled `request_admin`/`present_file` on every `docker compose up`, so edits to those in
  the panel last only until then; the repository stays their source of truth. Everything else (LLM settings,
  egress, other prompts) is pi's own state. A prompt deployed there applies to pi sessions STARTED afterwards
  (`snapshotForSession`); Noah's own append stays frozen per conversation (`conversations.pi_instructions`).

## Models (`agent/pi/modelCatalog.ts`)

pi-gateway's LIVE model list (`GET /v1/models` → `PiResponsesClient.listModels()`, `{id, ownedBy, default?, imageInput?, reasoning?}`) is the ONLY model
source (user decision 2026-10-31): the composer picker and the per-user default name pi model ids; none =
pi-gateway's DEFAULT model (picked on pi's admin LLM page): a new session sends no `model`, a continuing turn sends
the id pi marks `default: true` (omitting it there would keep the session's model). **Noah has no LLM settings of its
own** (user decision 2026-11-01): the admin model override (`PUT/DELETE /api/admin/model`), the per-model vision
policy (`PUT /api/admin/model-vision-policy`) and `MODEL_VISION` are RETIRED — pi's admin LLM page owns the default
model, each model's image input and efforts. Their `app_config` keys (`agent_model_override`, `model_vision_policy`)
are deleted behind `retirementGate()` and reserved forever; their audit labels stay for old rows; a still-set
`MODEL_VISION` only logs a boot warning (`warnRetiredModelEnv`). The admin 시스템 tab lists pi's models read-only and
links to pi's admin page.
`piServicesFor(store, config).models` is one catalog per app instance: a 60 s cache, one in-flight fetch for every
caller (5 s timeout), stale-on-error (a failed refresh keeps the last good list; retried after 5 s); never fetched
successfully → empty, and the `local` stub's is always empty (the client then hides the picker). A successful
`PUT /admin/api/llm` through the admin proxy calls `invalidate()`: the next lookup fetches again, and a fetch
already in flight (which may have read the old settings) never replaces a list fetched since — so a model whose
image input was just turned off stops getting image blocks at once, as the retired Noah vision policy did.

- **Run resolution** (`runCapabilities.ts`): the conversation's pick if pi offers it, else **Noah's default = pi's
  `falcon` tier** (`NOAH_DEFAULT_MODEL`, `noahDefaultModel`; user decision 2026-11-06) while pi lists it, else pi's own
  default. pi is untouched: its tiers (`eagle`/`falcon`/`swift`, pi ≥ 344ef09) are admin-set names listed first in
  `/v1/models` with their target model's input/reasoning, and a session opened on a tier follows it when the admin
  repoints it; Noah only SENDS `falcon` (a new session names it explicitly — omitting `model` would be pi's default).
  Every "no pick" lookup (vision, efforts, the bootstrap's `defaultModel`/`defaultVision`/`defaultReasoning`, the
  failure bubble) goes through `defaultRunModelId` — EXCEPT the fallback chain's `undefined` entry, which is pi's OWN
  default: `runPiAgent`'s `effortOn` clamps it by `catalogDefaultModelId`, never by falcon. It covers chat, routines, consultations and generators alike. A
  stored value pi does not offer (a legacy alias like `opus`, a model pi dropped, an SDK-era Claude id) reads as unset
  — no migration rewrites old values. describe_system names the id and its source (`… (chosen for this conversation
  in the composer)` / `falcon (default — Noah's default is pi-gateway's \`falcon\` tier …)` / `pi-gateway's default
  model (default — chosen on pi-gateway's admin LLM page; …)`).
- **Vision** (review #12): pi's `/v1/models` entry carries `input` (`["text"]` / `["text","image"]`, parsed to
  `imageInput`; absent on an older pi = unknown). `visionForCatalogModel` (`modelCatalog.ts`) is pi's setting ALONE:
  only `imageInput: false` makes a model text-only (pi would 400 `unsupported_image_input`); a model pi did not
  describe, an id not in the list and an empty list (the `local` stub, pi never answered) read as vision ON — the
  pre-retirement default, so a wrong guess shows as pi's visible 400 rather than a silently image-less turn. The
  default model is resolved by its catalog id (`defaultRunModelId`: `falcon`, else `catalogDefaultModelId`). Image turns on a text-only model go file
  mode (`chat-sse-media.md`). No 400 retry: Noah ships with its pi (U9).
- **Effort** (review #9): pi's entry carries `reasoning` — `{efforts, default_effort}` for a reasoning model (pi 400s
  `unsupported_reasoning_effort` for any other effort; its default list stops at `high`), `null` for one that does not
  reason (pi ignores the effort), absent on an older pi. `effortForModel` (`effortLevels.ts`, shared with the client)
  turns the composer's pick into what is SENT: as picked when supported or unknown; else the closest supported level
  BELOW it (never `none`); else the model's `default_effort`; nothing for a non-reasoning model. `runPiAgent` applies
  it per request for the model that request runs on (`effortOn(chain[attempt])`, so a fallback is clamped for the
  default model), describe_system's effort line names the sent level next to the pick (`sentEffort`), the frozen
  prompt states the rule (`PI_EFFORT_CLAMP_SENTENCE`), and the composer greys out levels the pane's model would not
  take as picked (bootstrap `models[].reasoning` / `defaultReasoning`; the current pick stays selectable). No 400
  retry, as for vision.
- **Fallback** (`request.modelFallback`, unattended runs): `[resolved, default]`, so ONE retry on pi's OWN default model
  in the same session (also from `falcon`); a run already on pi's default gets one attempt — judged by id only, so a
  `falcon` that points at the same real model as a non-tier pi default still retries it once (`/v1/models` does not
  expose a tier's target).
- **Writes** validate against the list: an unknown non-empty id → 400, pi never reachable → 503 (`offeredModelIdsOr503`,
  `routes/_shared.ts`). The chat stream's `model` is NOT validated: it is stored as sent ("" clears), so a pick
  survives pi being briefly unreachable, and the run applies it only while pi offers it.
- `GET /api/bootstrap` → `modelSelection: { models: [{id, server, vision, reasoning?}], defaultVision, defaultReasoning? }` (`server` = pi's
  `owned_by`; the retired deployment-wide `visionEnabled` is no longer sent); `GET /api/admin/system` → `piModels`
  (read-only: `{id, server, default?, imageInput?, reasoning?}`), `observedModel`.
- **`PI_MODEL_MAP` is RETIRED** with the composer tier registry (`modelTiers.ts`, deleted): no longer read; while it
  is still set every boot logs one warning (`warnRetiredModelEnv`, which also warns for `MODEL_VISION`).

## Env (config.ts → `AppConfig.pi`)

`AGENT_RUNTIME` (`pi` default, `local` stub; anything else stops the boot), `PI_GATEWAY_URL` + the service key
(required): inline `PI_GATEWAY_API_KEY` (in `SERVER_ONLY_SECRET_ENV_NAMES`) OR `PI_GATEWAY_API_KEY_FILE` (read and
trimmed by `readPiGatewayApiKey`; both set, an unreadable or empty file, or a second line stops the boot; the key never
enters `process.env` — the bundled compose stack sets only the file), `PI_GATEWAY_ADMIN_API_KEY_FILE` (optional, the
`/admin` panel proxy; file only — `readPiGatewayAdminApiKey`), `PI_WORKSPACES_DIR`, `NOAH_MCP_PUBLIC_URL`,
`NOAH_MCP_ALLOWED_CIDRS` (optional `/mcp` peer allowlist), `PI_DECK_SANDBOX`.

Removed with the SDK runner: `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (the old hard lock), `ANTHROPIC_DEFAULT_*_MODEL`,
`AUTO_COMPACT_WINDOW`, `MAX_TURNS`, `READONLY_TOOLS`. Model credentials live in pi-gateway only (D7). The admin 시스템
panel (`GET /api/admin/system`) shows `piModels` (pi's live list) and a `skillDiscovery` list read from the bundled
default-skills root (`listPluginRootSkills`, `agent/skillCatalog.ts`); `PUT/DELETE /api/admin/claude-token` are gone.

## Existing deployments

New nullable column `conversations.pi_instructions` (NULL = no pi turn yet). Old CLI session
ids and resume points (anything not `resp_…`) are IGNORED by the pi runner, never resumed: the first pi turn of an old
conversation rebuilds context from the text history with the larger cap, and a rewind onto a pre-pi row does the same.

`conversations.pi_session_profiles` (the per-pi-session model/effort map that made a change start a new session) is
RETIRED (2026-10-31, pi P3 switches the live session): `RETIRED_COLUMNS` drops it behind `retirementGate()`; the name
is reserved forever.

The retired runner's state goes through `retirementGate()` (DB backup first, files quarantined, never deleted): the
`claude_oauth_token` app_config key (the old `claude setup-token` login) and the skill-discovery cache key are deleted
and reserved forever, and `<dataDir>/agent-sessions` (the CLI transcripts) is moved to
`<dataDir>/retired/<stamp>/agent-sessions` by a boot step that stamps `retired:agent_sessions` after a clean pass.
`config.agentSessionsDir` survives only as the path that step reads.

## Presentation

- Korean labels for
  pi built-ins (`LS` 폴더 보기, `McpSearch` 도구 찾기, `PresentFile`, `RequestAdmin`), `mcp__skills__read`, pi
  `mcp__git_repo__commit`, hex-ssh tools and relayed `mcp__plugins|shared__<server>__<tool>` names
  (`sdkToolLabel`, which the client `humanTool` now shares); the admin 시스템 panel shows `pi-gateway`.

## Verify

- `tests/pi-workspace.test.ts` — path mapping, D3 move, cascades, skill sync + `mcp__skills__read`, the repo-copy
  round trip against a local bare remote (incl. a colleague's copy and a moved-base refusal), deck state, catalog.
- `tests/pi-mcp-proxies.test.ts` — the relay plan (secret routing, skips, redaction set), the pool against a real
  stdio fixture (lazy start, names, no leaked process), hex-ssh's allowlist through the real policy proxy, a run
  through the endpoint (shared server via the real bridge, plugin server, redaction incl. a browser secret), async
  ask_avatar as a later message, the never-waiting canvas, labels.
- `tests/pi-tool-discovery.test.ts` — the known-tools list (only this run's tools, deterministic, relays), the query line,
  describe_system's callable line, compact descriptions (hash-bound, safety rules kept), broker descriptions, unknown
  argument names refused at the endpoint. 
- `tests/pi-runner.test.ts` — runner against a scripted fake client (frozen prompt, continuation, model switch,
  rewind, 404 heal, question, steers, fallback, the endpoint as the broker sees it), `piRunPrincipal`, config,
  the `/mcp` mount, the script's server list.
- `PI_E2E_LIVE=1 PI_E2E_DIR=~/.noah-work/pi-e2e npx vitest run tests/pi-gateway-live.test.ts` — includes
  `runPiAgent` against the real e2e gateway.
- Harness: `~/.noah-work/pi-e2e/noah-harness` (`pi.env` uses the env names above), `AGENT_RUNTIME=pi ./start-noah.sh`.
