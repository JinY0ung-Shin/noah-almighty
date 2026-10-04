# Browser bridge — wire contract and versioning

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> The five hand-synced layers an op crosses, extension version compatibility, the composer badge, and screenshots.

- **One op crosses FIVE hand-synced layers**, none of which type-check each other:
  `agent/browserTools.ts` (tool + `BROWSER_TOOL_NAMES`) → `agent/events.ts`
  (`BrowserRequest`/`BrowserResult`) → `routes/chat.ts` (parks the op on the SSE run, relays each field,
  writes the audit row) → `src/client/src/lib/browserBridge.ts` (`BridgeOperation`/`BridgeReply`) →
  `extension/background.js`. Then the two metacognition surfaces (`promptBuilder.ts` browser paragraph +
  `systemTools.describe_system`), the Korean progress label in client `lib/chat.ts`, and the tool-group
  description in `shared/mcpToolGroups.ts`. A field missed in the relay arrives `undefined` at the
  extension with no error anywhere.
- **0.28.0's stored-secret input adds THREE wire fields, and the floor still stays 0.6.0 — because the
  value rides a field an old build cannot see.** `type` gains `secret` (the policy: name + allowed hosts
  + `passwordOnly`) and `secretText` (the plaintext); a `fill_form` field gains the same pair as
  `secret`/`secretValue` alongside `value: ""`. The value is deliberately NOT put in `text`: an extension
  that predates the feature reads `text`, finds nothing, and types NOTHING — a harmless no-op — instead
  of typing a credential with none of the guards the `secret` object implies (host re-check, password
  shape, consent popup). That is the whole reason the field is new rather than reused, and it is why the
  floor does not move. `BrowserResult`/`BridgeReply` gain nothing. The DEGRADE is covered on the client
  side instead of by the floor: `browserBridge.ts` exports `SECRET_INPUT_MIN_EXTENSION_VERSION`
  (`0.28.0`) + `extensionSupportsSecretInput`, and `handleBrowserOp` probes the installed version before
  forwarding any op that carries a `secret` — on an older build it answers the server `ok:false` with an
  update prompt and never forwards `secretText`/`secretValue` at all, so the plaintext does not even
  reach the extension process.
- **The frame carrying a secret is TRANSIENT.** `emitRunEvent(runId, event, data, { replay: false })`
  writes to the live clients but does not push the frame into `run.events`; `routes/chat.ts` passes it
  for any `browser` frame whose `secretText` is set or whose `fields` carry a `secretValue`. Without it
  the plaintext would sit in the run's in-memory replay buffer for the rest of the turn and be re-sent
  verbatim to every reconnecting client. The frame still CONSUMES an event id, so ids stay monotonic and
  a reconnect's `sinceEventId` cursor can never be made to re-request it. The reply direction is covered
  separately: the route runs `redactSecretValues(reply, {NAME: value})` BEFORE anything reads the reply
  (audit row, size gates, tool result), so a page that echoed the typed value back into its own DOM
  cannot carry it into the model turn — and the audit row records `secret=NAME` / `secrets=[…]` only,
  never a value and never `text`. Guards and the extension half → `actions.md`.
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` (`browserExtensionBundle.ts`) is a REINSTALL order** — raise it
  only when the op contract breaks. Below it every install badges orange (`outdated`) in the composer.
  `tests/infra.test.ts` pins it at or below the bundled manifest version: above it, even a
  just-downloaded extension badges orange forever, telling users to update to something no download
  provides.
- **The composer badge has FOUR rungs, and `compatible` is the one that keeps getting re-collapsed.**
  `ChatView.svelte` holds ONE `bridgeCompat.level` (`current`/`compatible`/`outdated`/`unreachable`) —
  the reachability and version axes were two fields that always moved together. `compatible` (at/above
  the floor, behind the bundle) is deliberately NOT folded into `current`: it works right now, so the
  temptation is to call it healthy, but that hides an available update. It renders `--info` blue with
  its own "· 업데이트 있음" text and IS clickable into 설정 → 접근/보안; only `current` is an inert span.
  `tests/svelte-chat-bridge-badge.test.ts` pins all of that.
- **`screenshot` is gated on the RUN's resolved vision policy, and with it click_at's PIXEL mode only**
  (`runVisionEnabled` → `BrowserToolsContext.vision`, defaulting to `false` so an unwired caller gets a
  polite refusal rather than an API error; pixel coordinates have no source without a screenshot).
  click_at's UID mode is measured off the element and stays available on a text-only model — gating the
  whole tool left canvas/map surfaces with no escape hatch at all on such a deployment. Both
  metacognition surfaces branch accordingly: click_at is listed unconditionally, and the vision-off
  branch says pixel mode is out while uid mode still works. `routes/chat.ts` caps
  the relayed base64 and whitelists the mime type — the extension is semi-trusted and that string lands
  in an API image block. The caption restates that the pixels are untrusted page content.
- **Every screenshot is AUTO-SHARED to the user** as the same card+slides pair share_file produces:
  `routes/chat.ts` (onBrowser continuation, after the size bound) calls
  `publishBrowserScreenshot` (`chatFiles.ts`) — one visible `kind:"file"` card (chat-files store; its
  image extensions live in `SERVED_IMAGE_TYPES`, deliberately NOT in share_file's `FILE_TYPES`) plus one
  hidden `kind:"image"` slide (chat-images store) linked via `attachment.parentId`, which the client's
  `panelSlides` (`bubbleSegments.ts`) uses to scope panel slides to their own card. MIME comes from byte
  sniffing, never the extension's claim. Outcome rides `BrowserResult.shareNote`/`sharedAttachments`
  (SERVER-INTERNAL fields — not part of the five-layer wire contract): browserTools appends the note to
  the report so the model knows whether the user saw the capture, and claudeAgent's execute wrapper
  stamps the text anchor exactly like the file-output wrappers. Own per-turn budget
  (`MAX_SHARED_SCREENSHOTS_PER_MESSAGE`) so a browsing loop can't exhaust the share_file cap; past it
  (or on publish failure) the MODEL still gets the image — only the user-facing card is skipped, and the
  note says so. Best-effort BY DESIGN: publish failure never fails the tool call.
- **Every screenshot is ALSO SAVED as a workspace file, so the avatar can place what it saw (2026-09-30).**
  In the same onBrowser continuation `routes/chat.ts` calls `saveBrowserCapture` (`chatFiles.ts`) with the
  SAME bytes: `<workspaceDir>/captures/<YYYYMMDD-HHMMSS>-<6 hex>.<ext>`, a KST wall clock plus a random
  suffix, with the extension from the same byte sniffing `publishBrowserScreenshot` uses. `<workspaceDir>`
  is the conversation SCRATCH workspace even while a working repo is open (the clone is the run's cwd
  then, the scratch its additional dir), which is why the prompt says "the scratch workspace's
  `captures/`". The folder must be a real directory (`workspaceSubdirForWrite`, since the workspace is
  agent-writable), the file is created `wx`, so it never overwrites and never writes through a planted
  link, and the written file must realpath to exactly `realpath(workspace)/captures/<name>`
  (`keepIfContained`) or it is removed: a folder swapped for a link mid-save cannot leave bytes elsewhere (against a single swap: a link swapped in AND
  back out inside the write window can still leave the bytes at its target — harmless while the agent shell runs as
  the server's own uid, a wording limit to revisit if the shell is ever sandboxed).
  A write that fails part-way (ENOSPC) removes its partial file. It has its own per-RUN budget (one
  `executeChatTurn`, steer follow-ups and background wake-ups included; the constant keeps its name),
  `MAX_SAVED_CAPTURES_PER_TURN` (30), independent of the share cap in both directions. It is skipped when
  the conversation was deleted mid-run, and any other failure is reported, never fatal. The outcome rides
  two more SERVER-INTERNAL `BrowserResult` fields, `savedPath` (absolute) or `saveSkipped`: `limit`,
  `conversation_gone`, `not_an_image` (empty or unsniffable bytes), or `save_failed` (no usable
  `captures/`, a failed or partial write, or a file that did not stay inside the folder). The
  `save_failed` note says only that the save did not complete, never that the workspace is unwritable.
  Like `shareNote`, they are set by the route and are not part of the wire contract, so the extension, the
  client and `BROWSER_EXTENSION_MIN_COMPATIBLE` are untouched. `browserTools.report()` renders them as a
  server-authored line OUTSIDE the untrusted wrapper: the path, that it can be placed into something the
  avatar produces (a deck's `assets/`), and that its pixels are still untrusted page content; or that
  nothing was saved, and why. The `screenshot` description, the `browser-operations` manual topic and
  both metacognition surfaces (prompt browser paragraph, describe_system's browser + image-sources lines)
  mention the saved copy on vision runs only, the only runs that can screenshot. Deleting the
  conversation removes `captures/` with the other server-written copies
  ([`../chat-sse-media.md`](../chat-sse-media.md)).
- **`read_cookies` crosses the boundary deliberately, so it is gated twice and audited by name.** It
  returns the CURRENT tab origin's cookies — httpOnly session tokens included — as `BrowserResult.cookies`,
  which land in the model context and conversation history (a decision taken with eyes open). The read is
  un-bypassable from a server/headless/background path because the gate lives in the EXTENSION: a
  per-site, per-type, per-session consent popup (`requestDataConsent`, reusing the single-slot
  `openConsentPopup`/`pendingConsent` machinery `new_tab` uses; the popup is `consent.html?kind=cookies`)
  that the user must click 허용 on the FIRST read of each site per browser session. On approval the (host,
  type) is remembered in `chrome.storage.session` (`DATA_GRANTS_KEY` = `dataConsentGrants`, shape
  `{key:{cookies?,local?,session?,secret?}}`), so further reads of the SAME site that session skip the
  popup; the
  grant clears when the user revokes it (the options page lists granted rows + their types with a 취소 /
  모두 취소 path) or when the browser closes. The `key` is the hostname for the three READ kinds; the
  `secret` WRITE kind (actions.md guard 4) is the one exception — it is keyed by the sentinel
  `SECRET_SESSION_GRANT_HOST` (`"*"`) via `requestDataConsent`'s `grantKey` parameter, so its approval is
  once per browser SESSION across every allowed site, and the options page renders that row under a label
  rather than a bare `*`. A decline/timeout/close records nothing, and a
  storage read error fails closed (re-prompts). It is NOT origin-exempt, so the current tab must ALSO pass
  the origin allowlist first. Scope is the
  current origin only: `Network.getCookies` is called with `urls:[tab.url]`, never `getAllCookies`. On the
  CDP side it adds ONLY `Network.getCookies` — a command, not `Network.enable` (the event stream) —
  probe-measured to need no enable (`tests/visual/cookie-facts.spec.ts`). Mitigations: the `routes/chat.ts`
  audit row records host + cookie NAMES + count and NEVER a value; `chat.ts` bounds the cookie count and
  every string (the primary size gate); and the tool result (`browserTools.reportCookies`, a DEDICATED
  formatter, not `report`) prepends a strong SECRET banner and frames the page-derived cookie table as
  untrusted. Cookie NAMES are page-controlled untrusted text; cookie VALUES are secrets and are the one
  page-derived field never normalized (a normalized token is a useless one).
- **`read_storage` is `read_cookies`'s sibling for localStorage/sessionStorage** (`kind` picks the store),
  sharing all of the above machinery EXCEPT the read primitive. It returns the CURRENT tab origin's entries
  as `BrowserResult.storage` (+ `storageKind`); localStorage commonly holds bearer/JWT tokens, so it is
  credential-class and gets identical treatment. The read is the ONE exception to the extension's no-page-JS
  invariant: `DOMStorage.getDOMStorageItems` is UNREACHABLE over `chrome.debugger` — the `DOMStorage` domain
  is excluded from the domain allowlist `chrome.debugger` exposes, so the call rejects with `-32601` "wasn't
  found". **Transport lesson, pinned here so it is not repeated:** the `chrome.debugger.sendCommand` allowlist
  is NARROWER than raw CDP. An earlier probe validated `DOMStorage` over Playwright's `newCDPSession` — raw
  CDP, a different and more permissive transport — so it never exercised the real path and wrongly cleared the
  method; pin Chrome facts on the transport the extension actually uses (`chrome.debugger`), not raw CDP. So
  the CDP allowlist gains `Runtime.evaluate` instead — the only `Runtime.*` method, NOT `Runtime.enable` (no
  enable needed, exactly as `Network.getCookies` needs none) — and read_storage evaluates a FIXED,
  bridge-authored expression (one of two constants, chosen by the validated `kind`; `returnByValue`, current
  tab only, no page mutation) that reads the store and returns a JSON string. `message.name`/`kind` and the
  tab URL NEVER enter the expression; the `name` filter is applied in the EXTENSION on the parsed result, and
  every parse failure / `exceptionDetails` fails closed. Consent is the SAME `requestDataConsent`, but per
  (host, STORAGE TYPE): approving sessionStorage never approves cookies or localStorage —
  `consent.html?kind=local`/`kind=session` name the store. NOT origin-exempt. Audited by KEY NAME + count +
  storageKind, never a value; the tool result (`browserTools.reportStorage`, sibling of `reportCookies`,
  sharing `sanitizeSecretField` + `secretBanner`) prepends the SECRET banner and frames the page-derived
  `storage_data` table as untrusted. Storage KEYS are untrusted text; VALUES are secrets and never normalized.
- **The 0.24.0 additions all ride the existing degrade story, so `BROWSER_EXTENSION_MIN_COMPATIBLE`
  stays 0.6.0.** `dialog_status` (the `handle_dialog` no-`accept` probe — actions.md) is a new wire OP
  with NO new fields, so the five layers only had to learn the op name (the chat relay forwards `op`
  generically); an old build answers "Unsupported operation" and the relay's existing translation
  turns that into an update prompt. `copy_text` is a server tool over existing ops — no wire change at
  all (actions.md). `maxChars`' floor dropped to 500 on BOTH sides in lockstep (snapshots.md; an old
  build re-clamps to 2000 — a degrade). The AX-invisible clickable grouping is extension-render-only
  (snapshots.md). The chat route's audit skip list grew to snapshot / wait_for / dialog_status.
- **The 0.26.0 screenshot-geometry fix (issue #66) adds NO wire field either — it rides the `note`
  channel and the extension's own measurements.** A viewport capture is pre-fitted to the native image
  size Claude's API resizes it to, and its pixel→CSS mapping is read off the RETURNED bitmap rather than
  the capture formula (snapshots.md); `screenshot`, `click_at` and `drag` hand the resulting image size
  and mapping back as ordinary bridge `note`s (addressing.md), which the five layers already relay —
  `capNote` merges them with the tab notice inside the extension's 480-char budget, `routes/chat.ts`
  slices `note` to 500, and `browserTools.report()` prints it as the `Note from the browser bridge:`
  line OUTSIDE the untrusted wrapper. So `BROWSER_EXTENSION_MIN_COMPATIBLE` stays 0.6.0: an older build
  captures unfitted and returns no notes — a degrade, not a break — and the SERVER covers exactly that
  case by decoding the image itself and adding an oversize caveat with the correction factor
  (addressing.md). The composer badge does the rest: at or above the floor but behind the bundle is
  `compatible`, blue, with an update prompt.
- **0.27.0's clipboard-staging auto-close adds NO wire field either, and the floor stays 0.6.0.** When
  a `/browser-clip/` tab's title reads `COPIED` the extension closes it and re-points the working tab
  (actions.md); the outcome travels on the SAME `note` channel 0.26.0's geometry notes use —
  `clipboardCopiedNote` merged by `capNote` inside the 480-char budget, sliced to 500 by
  `routes/chat.ts`, printed as the `Note from the browser bridge:` line OUTSIDE the untrusted wrapper —
  and the reply's existing `snapshot`/`url`/`title`/`tabs` fields carry the rest (`snapshot: ""`, since
  the tab that was acted on is gone). No new op name, no new field, nothing for the five layers to
  learn, and an older build simply leaves the tab open and sends no note: a tidiness degrade, not a
  broken contract. That is exactly WHY the server side must stay TWO-GENERATION. Nothing in a tool
  call carries the installed extension version, so the tool text and both metacognition surfaces
  cannot branch on it — they pin the signal both builds produce (`COPIED` in the click result's
  `Current page:` line, which `browserTools.report()` has always printed) and then name what each
  generation leaves behind. Scripting only the new behaviour would strand every install on the
  `compatible` rung with an orphaned staging tab and an agent waiting for a note that never comes.
- **0.28.1 changes NO wire field at all — it is a popup-page CSS fix — and the floor stays 0.6.0.** The
  extension's action popup (`options.html`) oscillated between partial widths on Chrome ≥152 (or collapsed to
  a ~32px sliver with overlay scrollbars) because `options.css` clamped the body to `max-width: 100vw`, which
  the autosizer's 25px remeasure can never resolve to the true width (extension/CLAUDE.md). The op
  contract, both metacognition surfaces, and the relay are untouched, so nothing can branch on this version
  and nothing should: the cure for an affected install is simply taking the update (composer badge
  `compatible` → update prompt), not a reinstall order.
