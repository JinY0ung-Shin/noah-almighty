# Browser bridge — actions, writes, and guards

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> Audit policy, the no-JS constraint, selects, navigation and the origin gate, verified writes, and click guards.

- **Audit policy: actions PLUS deliberate reads.** `screenshot`/`read_text` get rows (they are the
  exfiltration surface); `snapshot`/`wait_for` never do — they fire between every step and would bury
  the rows that matter. URLs are scrubbed of userinfo and query string.
- **No JS execution, and that shapes op design.** `CDP_ALLOWLIST` is default-deny with no
  `Runtime.*`/`Network.*`/`Storage.*`; elements are AX-tree `backendNodeId`s. So `select_option` clicks a
  rendered option, or drives a collapsed native `<select>` from the KEYBOARD (next bullet). Every later
  entry has had to pass the SAME test — read-only, executes no page JS, opens no exfiltration class
  `getFullAXTree` does not already open (it hands back the page's whole text): `Page.getFrameTree` and
  `DOM.getFrameOwner` for frame structure, `Accessibility.getPartialAXTree` for verified writes, and
  `DOMSnapshot.captureSnapshot` (`computedStyles: ["cursor"]`) for the full snapshot's AX-invisible
  clickable section (snapshots.md).
  `read_text` reuses the same `extension/axtree.js` walker as snapshot (`renderAxText` vs
  `renderAxTree`), is offset-chunked, and mints no uids so it never invalidates a snapshot. With
  `expand: true` it scrolls the page in viewport steps and MERGES the captures
  (`mergeTextLines` — virtualized feeds DELETE what scrolls out, so one read at the bottom would
  hold only the tail); expand is page-level by definition and refused together with `uid`.
  That merge aligns on the shared HEAD and TAIL first and only then on the seam, because the two page
  shapes differ: a virtualized feed overlaps at its edges, while an append-only page is re-read whole from
  the top with the new rows in the MIDDLE, above a footer both captures end with. Seam-only matching found
  nothing there and re-appended the entire document at every step — infinite_scroll came back as 517k
  characters that were four copies of the same paragraphs.
- **A collapsed native `<select>` is driven by a THREE-rung ladder, each rung settle-then-VERIFIED.**
  Type-ahead first (the option label's prefix as real key events — what a PERSON does, and what the
  browser's own list-box matching is built for), then arrow-stepping, then a hand-to-user error naming
  what the control still reads. The first two rungs SETTLE and re-read the landed value instead of
  claiming success: the keyboard path silently no-ops on some platforms (macOS opens the native popup
  instead), so an unverified rung wrote "selected" into the transcript with the old value still on the
  page. The agent-facing contract is unchanged — uid + the option's exact label.
- **`select_tab` returns IDENTITY only** (`{ok, url, title, tabs}`, no snapshot): switching is not
  reading, and bundling a read into the switch made MOVING to a tab inherit the read's origin check —
  the tab you most need to reach is the one sitting somewhere you may not read. The agent snapshots
  explicitly afterwards (tool description + standing guidance both say so); `browserTools.report()`
  renders the snapshot-less reply as url/title/tab-list with no empty wrapper, pinned in
  `tests/agent-tools.test.ts`. Tab MANAGEMENT is exempt from the origin gate the way `list_tabs`
  already was: you may MOVE to a tab sitting on a non-allowlisted page, you just cannot READ it there.
- **The origin gate judges `navigate`/`navigate_back` by DESTINATION, not by the page being left.**
  Otherwise a tab that landed somewhere denied was a DEAD END — every op refused, including the only
  one that could escape — which is exactly what a PDF-viewer extension hijacking a `.pdf` navigation
  produces (`chrome-extension://…`, its own error message now). Reading is unchanged: the destination
  still has to pass. And when an ACTION lands outside the allowlist, the error now says the action
  COMPLETED and only the page content is withheld; the old wording read as "nothing happened" and had
  the agent performing it a second time. The MOVEMENT itself cannot ride CDP there: Chrome
  force-detaches the debugger the moment a tab navigates into another extension's page and refuses to
  re-attach ("Cannot access a chrome-extension:// URL of different extension" — field-measured, 3/3
  attempts), so "escape via Page.navigate" was structurally unimplementable, not merely a cold-worker
  corner. From a debugger-unreachable page (`chrome-extension://`, `chrome://`, …, or any attach
  failure on an exempt op) the two exempt ops move via `chrome.tabs.update` / `chrome.tabs.goBack`
  instead — no page JS, no new CDP surface, the same destination check before moving (new_tab already
  navigates through this same extension API). One asymmetry: the tabs-API back step is taken BLIND
  (`Page.getNavigationHistory` is CDP too), so its destination pre-check is skipped there; the
  post-action landing check still decides what may be READ.
- **`type`/`fill_form`'s `clear` is a VERIFIED write with FOUR exhaustive end states, and the only reason
  `Accessibility.getPartialAXTree` is on the allowlist.** On map.naver.com's React combobox, "광교카페거리성남"
  + type("성남", clear) read back as "광교카페거리성남성남" — three times running, across two extension
  builds, reported as plain success every time. Round 3's select-all hardening AND its own verification both
  failed silently, so the whole path lives in `clearAndWrite` (`background.js`) now:
  - **The value node is RESOLVED, because "unreadable" is not "empty".** Chrome OMITS the AX `value`
    property on an EMPTY text field, so the old `String(node.value?.value ?? "").trim()` answered `""` for a
    node that exposes no value AT ALL — and `""` walks straight into `clearFailed`'s `if (!old) return
    false`, which is exactly how verification disarmed itself in the field. `readAxValue` now returns three
    distinct answers: the raw text, `""` only when the node carries the `editable` property
    (`plaintext`/`richtext` — Chrome sets it on every textbox/textarea/contenteditable whether or not it
    holds text), else `null` = UNREADABLE. Both of the PURE decisions in that sentence —
    `axValueAnswer` (the three-way read) and `clearFailed` — live in `axtree.js`, the bridge's pure half,
    so `tests/browser-axtree.test.ts` covers them in the always-run suite: this class of bug shipped twice
    while every unit test stayed green. `resolveValueNode` then recovers the common case: the uid an
    agent addresses on a combobox is the WRAPPER, whose text lives in a descendant `<input>`, so it walks
    `DOM.describeNode {depth: -1, pierce: true}` breadth-first (children + `shadowRoots`, never
    `contentDocument` — an iframe's input is a DIFFERENT field and would invent failures) for the first
    `INPUT`/`TEXTAREA`/`[contenteditable]` that reads non-null. Nothing cached; a clear is rare.
  - **A three-rung LADDER, order measured rather than assumed.** `tests/visual/clear-ladder.spec.ts` drives
    raw CDP against `fixtures/controlled-input.html` (a vanilla-JS controlled input: page state is the only
    writer of `input.value`) in two variants — `plain`, and `guarded`, which `preventDefault()`s ctrl/cmd+A:

    | rung | plain | guarded |
    | --- | --- | --- |
    | none — `insertText` only (the field bug) | APPENDED | APPENDED |
    | A — `rawKeyDown` + `commands: ["selectAll"]`, then overtype | cleared | APPENDED |
    | B — `imeSetComposition` replacement range, then `insertText` commit | cleared | cleared |
    | C — `End` + Backspace × length, then re-insert | cleared | cleared |

    So rung A (CDP's hook into the Blink editor command, so a keymap that never interprets our synthetic
    ⌘A/Ctrl+A still selects) is real but travels through the DEFAULT keydown handler — one `preventDefault`
    and it is gone. It stays FIRST because it is what a person does and costs one round trip; B before C
    because it is one pair of CDP calls instead of one per character. B's offsets are UTF-16 code units
    (DOM text offsets), while C's Backspace count is CODE POINTS off the LATEST read (over-counting is a
    no-op, under-counting leaves the old value; counting off `before` would delete the tail of what was just
    written and leave the old value in FRONT — the failure itself). C is dialog-checked per press,
    `CLEAR_BACKSPACE_MAX` 300, and re-inserts through the SAME path the caller used (`insert` callback:
    insertText/IME, or the per-character replay in keystrokes mode).
  - **`clearFailed` decides each rung** off a settle (`VALUE_SETTLE_MS` 150ms) + re-read: the old value
    surviving at EITHER END is failure (front when the caret sat at the end, back when it sat at 0, both
    seen), an exact match on the requested value is always success (replacing "광교" with "광교역" must not
    look like a survival), and a `null` read still never reads as failure.
  - **The four end states, none silent-optimistic:** verified on rung A → no note; verified after B or C →
    a `note` naming the repair (`ime-rewrite` / `keyboard-erase`) and what the field now reads; every rung
    failed → THROW quoting the survivor and naming all three rungs tried; `resolveValueNode` → `null` → rung
    A only (no read to verify with, no length to count Backspaces off) plus a note that the clear is
    UNVERIFIED. The no-clear path is untouched — insert-at-cursor stays the default and gains no reads, no
    delay, no note.
  - **`note` is the honest side channel**, a sixth-layer field on the ok-variant: `background.js` (capped
    `NOTE_MAX` 480, page-derived values pre-sliced to `NOTE_VALUE_MAX` 80 at the source) → client
    `BridgeReply` → `routes/chat.ts` (`.slice(0, 500)`) → `BrowserResult.note` → `report()` renders
    `Note from the browser bridge: …` BEFORE the snapshot body and OUTSIDE the untrusted wrapper (it is
    bridge-authored, and it is the reason to look at the field's `= "…"` line). `fill_form` attributes one
    note per field (`Field N (uid "…")`), and an outright failure in a later field carries the earlier
    notes in its error text, since an `ok: false` reply has only `message`. Its partial-progress error still
    says the field "may hold partly-written text".
- **`type` routes by CONTROL KIND before the first keystroke, because two native controls hold no
  text.** Field case: `type(value="4", clear=true)` on `<input type=range>` — insertText no-ops, the
  ladder falls to rung C, whose `End` key means MAXIMUM on a slider, and "the old value is gone"
  verified the write: a 0–5 slider ended at 5 and reported success writing 4. `inputPreflight` (one
  depth-0 `DOM.describeNode` per field, shared with the file-input refusal; `typeRef` hands it to
  `fillField` so it runs once) decides:
  - **slider** (native `range`, or AX role `slider` — ARIA sliders included; the AX read is skipped
    whenever the DOM already settles the kind) → `driveSlider`: `sliderPlan` (`axtree.js`, pure,
    unit-tested) parses current/target/min/max/step (DOM attrs → `aria-value*` → AX props; step from
    the DOM ONLY, see rangeFlags) into direction + press count (400 cap) + `expected`; `Home` first
    when the current value is unreadable; arrows with the ladder's per-press dialog check; verify with
    HALF-STEP tolerance (sliders SNAP — asking 2.7 on a 0.5 step lands 2.5 and that is the control
    working). A landed value that is not the requested one THROWS, quoting value and bounds. `clear`
    and `keystrokes` are ignored — there is no text to replace or replay.
  - **spinbutton** that is not a native number input (an `<input type=date/time>`'s year/month/day
    parts — UA shadow DOM, no `role` attribute, only the AX tree names them — or an ARIA spinbutton)
    → `writeSpinButton`: the value replayed as digit KEY events, then read back. Field case: `type`
    "2026" into a date's year part reported success while the part stayed "0" — `Input.insertText` is
    a SILENT NO-OP on a date part while digit keys write (probe-pinned in
    `tests/visual/scrolled-hit-facts.spec.ts`), so it must never reach the text path. Same
    non-silent contract as the ladder: verified → "", reformatted → diverged note, unreadable →
    unverified note, value unchanged → THROW naming what it still reads. `clear` needs no separate
    path — typing into a date part overwrites by nature.
  - **number** with `clear` → select-all + overtype + numeric verify ONLY, no IME/backspace rungs (a
    number input answers text edits with its own constraint logic, so "old value gone" says nothing);
    mismatch THROWS quoting the field's min/max/step. Empty-request compares as empty-vs-empty —
    `Number("")` is 0 and would have accepted a field reading "0" as successfully emptied.
  - **text** keeps the ladder, plus `divergedNote`: a clear that VERIFIES but lands on something other
    than the requested value now always carries a bridge note quoting BOTH — deliberately a note and
    never a throw, because phone masks, casing and autocomplete commits are legitimate rewrites and a
    completed write must not be reported as failed.
- **A LONG insert is CHUNKED and read back — the no-clear path's one exception to "no read-back".**
  Field case (issue #60): ~2.5 KB typed into Confluence's Monaco source textarea landed as its TAIL
  only, reported as plain success — a virtualized editor ingests input event by event into its OWN
  model, and one `Input.insertText` carrying thousands of characters outruns that sync. So
  `insertValue` splits past 1000 code points (`INSERT_CHUNK_SIZE`) into code-point-safe chunks (the
  IME-vs-plain path decided ONCE on the whole value) with a 60 ms settle between chunks and the
  keystroke replay's per-chunk dialog check; `imeRewrite` (rung B) stays UNCHUNKED on purpose — a
  replacement range is atomic by nature, and splitting it would turn one replacement into N appends.
  A write of ≥ 1000 code points (`LONG_WRITE_VERIFY_MIN`) additionally pays ONE `resolveValueNode`
  walk — BEFORE the write, because the editor re-renders as it ingests — plus one settled read: a
  whitespace-normalized CONTAINS check (insert-at-cursor lands INSIDE whatever the field held), ending
  in a bridge note and NEVER a throw, because the editor may hold the full content in its own model
  while the DOM proxy it exposes windows a slice — a throw would report a landed write as failed. The
  mismatch note quotes sent-vs-read-back lengths, adds the hidden-proxy sentence only on
  `isHiddenProxyInput` evidence (a geometry claim, not a class-name guess), and names the recovery
  that actually works: `mcp__browser__copy_text` + paste. A dialog raised mid-write stops the chunk
  loop AND skips the read-back (the field holds a PREFIX the editor was never given the rest of; the
  op tail reports the dialog). `inputPreflight` also flags known virtualized editors off the RAW class
  attribute (`VIRTUALIZED_EDITOR_CLASS_RE` — Monaco / CodeMirror 5+6 / Ace; raw because CodeMirror 5's
  class is capitalized and `attrOf` lowercases) — a SIGNAL that words the unverified note, never a
  gate. Short values keep the zero-cost single-insert path byte for byte.
- **A stored secret is typed by NAME, and every one of its five guards is load-bearing (0.28.0).** The
  model passes `secretName` to `type` / a `fill_form` field INSTEAD of `value`; the server resolves the
  plaintext from the owner's vault and the extension types it. So the value never enters the model
  context, the transcript, or the audit trail — the model only ever names it. What makes that safe is a
  chain in which each link covers a different failure:
  (1) **Per-secret opt-in** (`user_secrets.browser_expose`/`browser_hosts`/`browser_password_only`, the
  `브라우저 입력` toggle) with EXACT lowercase hostnames, ≥1 when enabled, and `passwordOnly` defaulting
  to true — no wildcards, because an over-broad match is exactly how a phishing page on a sibling host
  would collect the value. Reserved git/SSH names can never be browser-typed
  (`isBrowserExposableSecret`).
  (2) **Host check at BOTH ends.** The SERVER pre-checks the last url the bridge reported (tracked in
  `buildBrowserTools`' closure off every `execute` reply — so a `navigate` away flips the answer
  mid-turn) and refuses with the allowed sites and the current host; with no url seen yet it defers
  rather than guessing. The EXTENSION re-checks the live tab AND, for a child frame, that frame's own
  document — refusing when the frame url cannot be determined. The server check is the cheap one and can
  be stale; the extension's is the authoritative one.
  (3) **Password-shape enforcement** in the extension: with `passwordOnly`, `inputPreflight`'s DOM shape
  must be an `<input type=password>`, refused BEFORE any key is sent.
  (4) **Consent popup** in the extension (`requestDataConsent`, kind `secret`, in the same unified
  `dataConsentGrants` store cookies/storage use) — asked ONCE PER BROWSER SESSION, not per site and not
  per secret: the first secret typed in a session prompts, and that one approval covers every allowed
  site until the user revokes it in the options page or closes the browser. It is the only kind of the
  four keyed by a SENTINEL (`SECRET_SESSION_GRANT_HOST` = `"*"`, exported from `secretInput.js`) rather
  than by hostname — `requestDataConsent`'s 4th parameter `grantKey` defaults to `host` for the read
  kinds and is passed the sentinel here, so the popup still SHOWS the frame host (and the secret name and
  field kind) while only the MEMORY is session-wide. Widening the grant widens no reach: guards (1)–(3)
  re-run on every write, so the sites a secret may be typed on remain exactly the ones the owner named
  per secret, and the popup copy says so. Un-bypassable from a server/headless path either way.
  (5) **Never quoted, never logged, always redacted.** No note, refusal, error, audit row, or log line may
  contain the value. Verification of a `clear` + overtype is by LENGTH only, which is possible because
  Chromium masks a password field's AX value as one `•` per character (measured — contract.md's table and
  `tests/visual/password-facts.spec.ts`); a non-clear write skips the read-back entirely, and rungs B/C
  of the clear ladder — the ones that QUOTE the survivor — never run. `DOMSnapshot.captureSnapshot`'s
  `inputValue` DOES expose the plaintext and is why it must never be rendered (snapshots.md). On the way
  back the chat route redacts the reply before anything reads it and the browser tools redact their own
  result, so a page that echoed the value into its own DOM comes back `[REDACTED:<NAME>]`; the run's
  redaction set (`piRedactions`, applied by the `/mcp` endpoint) carries the same value for every OTHER Noah MCP
  result of the run (agent-core.md).
  Audit rows record `secret=NAME` / `secrets=[N1,N2]` and nothing else.
  Refusals are all RETRY-PROOF and worded to redirect: an unknown name lists what IS enabled and the
  settings path, a host mismatch names the allowed sites and the current host, and a declined consent is
  reported rather than retried. The one line the tool text and both metacognition surfaces never soften:
  one-time codes (OTP/2FA) and payment details stay off-limits — no policy covers them.
- **Two guards run before a click, and `clickNode` itself stays UNGUARDED by design**
  (`select_option`'s option click and `focusForInput`'s fallback reuse it; the guards live in the op
  branches). (1) FILE-UPLOAD refusal: `<input type=file>` looks like any `button` in the AX tree — its
  only AX tell is a locale-dependent value ("No file chosen", English even under a Korean label;
  probe-measured), so `refuseFileInput` asks the DOM. Clicking one opens the OS-native file dialog:
  browser chrome, outside the renderer, MODAL — no CDP input reaches it, no tool closes it, every
  later op hangs until a person dismisses it, so it must never open. Guarded on `click`, `click_at`
  (BOTH modes — `describePoint` returns `{text, fileInput}` and a fraction/pixel click landing on one
  is refused before dispatch), `type`/`fill_form` (via preflight, inside the per-field try so it
  surfaces as the attributed field error), and `press_key` with a uid (Enter/Space on a focused file
  input opens the same dialog). (2) OBSCURED-target refusal, op `click` only: hit-test the EXACT point
  about to be clicked; proceed when the hit is the target or inside its pierced subtree; refuse only
  when the hit is not an ANCESTOR either (a `<label>` wrapping its input receives clicks on the
  target's behalf), its area exceeds 3× the target's, AND the target itself is ≥ 100 px² (the 1×1
  visually-hidden input under a styled control must keep working — a naive ratio test refuses every
  styled checkbox). Field case: the-internet `/entry_ad` — a click on a link under an open modal
  navigated anyway, a state no person can reach. The hit test itself goes through `hitNodeAt`
  (addressing.md): an answer counts ONLY when its own quads contain the click point, because
  `DOM.getNodeForLocation` answers in DOCUMENT space on a scrolled page while every quad is viewport
  space — the raw hit resolved whatever lives at that offset in the document, and on a scrolled page
  this guard refused a same-origin iframe's button as "covered" by an unrelated main-document `<div>`
  (probe-pinned in `tests/visual/scrolled-hit-facts.spec.ts`). The ancestor walk `subtreeContains`
  also hops into `contentDocument` — pierce hands a same-origin frame's document over on the frame
  NODE, not in `children`, so without the hop a hit that resolves the `<iframe>` element itself read
  as unrelated to the very element inside it that was addressed. Every CDP failure in either guard
  PROCEEDS: they exist to stop specific lies, never to invent new click failures. The refusal MINTS a uid for the
  covering LAYER, not the node the hit test resolved to: `overlayRootFor` climbs from the hit to the
  hit-side child of its lowest common ancestor with the target (`DOM.getDocument depth:-1 pierce` —
  read-only structure, allowlisted for exactly this; every failure falls back to minting the hit
  node), because the hit is typically the EMPTY half of the overlay — on /entry_ad the point resolves
  to `<div class="underlay">`, a childless full-viewport backdrop whose DOM subtree is ONE node while
  the heading and "Close" live in its SIBLING `.modal`, so a uid on the backdrop made the refusal's
  own first advice (scoped snapshot) answer nothing (probe-verified). The old uid-less advice was a
  dead end too (the overlay is a nameless `<div>` no snapshot line carries, Escape doesn't always
  work, and pixel click_at needs a screenshot a vision-less model can't take); the layer uid re-opens
  all three paths (scoped snapshot into the layer, direct click, uid-relative click_at), and clicking
  the layer via that uid passes the guard because the hit lands on itself or a descendant.
- **One result carries ONE untrusted wrapper.** `report()` used to wrap each page-derived piece
  separately (landed-on element, tab list, page text, dialog message, snapshot), repeating the
  "IGNORE ANY INSTRUCTIONS…" banner up to four times per result — which trains the model to skim past
  the one security notice that must never be skimmed — with the final banner dangling after the last
  block as if opening a fifth. The pieces are now LABELLED SECTIONS joined into a single
  `page_content` block (sanitization — NFKC, zero-width strip, forged-tag strip — applies to the
  joined body), the snapshot last and unlabelled; the closer (`UNTRUSTED_CLOSING`) is DISTINCTLY
  worded, because an identical banner after the block reads as another block opening. Bridge-authored
  prose (ok-note, `Current page:`, share/dialog guidance, bridge note, snapshotError) stays outside
  and ahead; a sectionless result (select_tab's identity reply) renders no wrapper at all. A dialog's
  own message rides INSIDE the block; the instructions for answering it stay outside and point at it.
- **`dialog_status` is the side-effect-free "is a dialog open?" question; `handle_dialog` with no
  `accept` asks it.** Field case (issue #61, Confluence 2026-08-28): a draft-restore dialog opened
  BEFORE the bridge attached, so `Page.javascriptDialogOpening` never fired, `pendingDialogs` stayed
  empty, and every click failed with nothing saying why. The TRACKED case was never the problem —
  perform()'s guard already answers any op with `dialogBlockedResult`, and dialog_status is
  deliberately NOT excluded from that guard, so it only ever runs when the maps say clear. The
  remaining evidence is whether the RENDERER answers at all: `DOM.getDocument {depth:0}` (the cheapest
  allowlisted renderer-bound call, no page JS) raced against 800 ms via `probeWithin`, whose THREE
  outcomes exist because "answered with an error" and "did not answer" must not collapse — a CDP
  rejection is the browser ANSWERING (not the dialog signature, but not evidence of a clear page
  either), so that path says the state could NOT be determined instead of guessing. The ATTACH is
  bounded too, for this op ALONE (3000 ms, looser — a cold attach on a heavy page is legitimately
  slow): `ensureAttached`'s enables are renderer-bound and the attach is cold in exactly the field
  case (the MV3 worker idles out between turns, Chrome detaches with it, the dialog opens in the gap),
  so unbounded, the op that exists to explain a hang would itself hang; every other op's attach path
  is byte-for-byte unchanged. Answers are identity-only (a probe is not a READ — no snapshot), the two
  non-answering outcomes return no tab list (a result that lists tabs reads as a page the bridge is
  talking to normally — the very impression those outcomes exist to correct), and `routes/chat.ts`
  skips the audit row like snapshot/wait_for: it is the question an agent asks when it is confused,
  and rows would bury the actions. An old build answers "Unsupported operation", which the relay's
  existing translation turns into an update prompt — `BROWSER_EXTENSION_MIN_COMPATIBLE` stays put. The
  server sends the probe only when `accept` is omitted (promptText without accept is refused as a
  half-formed ANSWER, server-side, before the wire), so the answering contract is untouched.
- **`copy_image` puts an image on the OS clipboard through a FIRST-PARTY Noah page — not the
  extension.** A Chrome MV3 extension cannot write an image to the clipboard (the async Clipboard API
  needs a focused document + user activation, which an offscreen document can't get, and
  `execCommand('copy')` only lands HTML markup, not image bytes — spike-confirmed). A normal page CAN,
  so `copy_image` stages the bytes server-side (`browserClipboard.ts`: unguessable token, ~2-min TTL,
  size-capped map + a 60s `unref`ed eviction sweep, both routes `requireAuth`-gated) and returns
  `appOrigin + /browser-clip/<token>`. The token is NOT the capability on its own — it is printed into
  the persisted tool-result text, and the bytes may come from a private repo clone — so each entry is
  bound to the STAGING USER (`stageClipboardImage(bytes, mime, userId)`, the run's `viewerUserId`: the
  staging page is opened by the viewer's browser) and a foreign token 404s with the SAME body as an
  expired one, so existence never leaks. The agent then drives the ordinary ops: `new_tab` the staging
  URL → `click` its `클립보드로 복사` button → **read the outcome off THAT click's own result** →
  `press_key` paste into the target editor → re-read the page. Checking the outcome is not optional:
  `clipboard.write` can be refused (it needs the window's activation), and without it the agent pastes
  whatever was already on the clipboard and reports success — so the staging script sets
  `document.title` to `COPIED` or `COPY_FAILED` as the machine-readable outcome, and the tool
  text/prompt guidance forbid pasting on anything but `COPIED`. No separate `list_tabs` is needed to
  see it: `browserTools.report()` has always printed the acted-on tab's title as its `Current page:`
  line, so the title contract is readable from the click that flipped it. The paste MODIFIER is
  platform-aware: Ctrl+V is not paste on macOS, so `AgentRequest.viewerPlatform` (from the chat
  request's User-Agent — the bridge relays into the requesting browser, `viewerPlatformFromUserAgent`)
  picks `["Meta"]` vs `["Control"]`, and an unknown UA yields a dual instruction rather than a guess.
  The write survives even when that Noah tab is NOT the foreground OS window, because a
  CDP-synthesized click (`Input.dispatchMouseEvent`, already in the allowlist) supplies the
  transient user-activation Chrome's `clipboard.write` accepts in place of focus — the spike's
  decisive result. So NO new CDP method, NO new wire field, and NO
  `BROWSER_EXTENSION_MIN_COMPATIBLE` bump: it is a server tool over existing ops. The staging page
  is CSP-clean under app.ts's strict policy (external `/browser-clip.js`, bytes → `data:` URL before
  `img.src` since `blob:` is blocked), mirroring `client/src/lib/canvasExport.ts`'s `copyPng`.
  `appOrigin` is derived from the chat request (`requestOrigin`, honouring the reverse proxy), so the
  staging page is same-origin with the user's session. Both forwarded headers are CLIENT-controlled and
  a chained proxy APPENDS to them, so `requestOrigin` takes the FIRST entry of `x-forwarded-host` AND
  `x-forwarded-proto`, parses, demands `http:`/`https:`, and returns `url.origin` (normalizing default
  ports + case) — failing CLOSED to null like `matchPatternForOrigin`; otherwise a comma-joined host
  breaks `new_tab` and a forged one hands the agent an attacker-chosen origin to open in the user's
  authenticated browser. The image path resolves through the SHARED `readWorkspaceImage` (chatImages.ts
  — one copy of the containment discipline show_file uses).
  Two field-relevant caveats: (1) the agent is opening a NOAH page, and **Noah's own origin must NOT be
  put in the browser-control allowlist** — that would make the whole logged-in Noah UI drivable by an
  agent whose inputs include untrusted page text (avatar visibility, skill shares, deletions). Instead
  the extension (0.19.0+) carries a built-in, path-scoped exemption: `originAllowed` accepts
  `<sender.origin>/browser-clip/<32 hex>` — the op's `sender.origin` is browser-verified via
  `externally_connectable`, the match is the EXACT token-page shape (never a prefix), and the server
  hard-404s everything else under `/browser-clip/` so no path in the exempted namespace can ever fall
  through to the SPA and render the app UI. An older extension simply refuses the staging URL; the tool
  text redirects to updating the extension (or a manual copy via show_file), never to allowlisting
  Noah. 0.27.0 moved that shape test out of `originAllowed`'s inline regex into `axtree.js`'s exported,
  unit-tested `isClipboardStagingUrl(rawUrl, stagingOrigin)` / `CLIPBOARD_STAGING_PATH_RE` (behaviour
  byte-identical) so the EXEMPTION and the auto-close bullets below cannot drift into disagreeing
  about what a staging page is. Token format and path shape are a cross-artifact contract
  (`browserClipboard.ts` ↔ `axtree.js`). (2) Paste rides the EXISTING `press_key` shortcut, which
  the spike showed pastes an image into a contentEditable; if a real editor (Confluence) ignores the
  synthetic shortcut, the known upgrade is a `commands:["paste"]` field on `press_key` (the same
  Blink-editor-command escape hatch `selectAll` already uses) — deferred until measurement shows it
  is needed. Security posture: the agent NEVER reads the clipboard (no `clipboardRead`, and the only
  page JS the extension runs is `read_storage`'s fixed Web-Storage expression, which cannot reach
  the clipboard, so nothing the paste pulled comes back to the model); the one side effect is that
  the user's prior clipboard contents are overwritten by the image.
- **`copy_text` is copy_image's TEXT sibling, and the staging store is MIME-agnostic.** Issue #59's
  root fix: a paste is ingested ATOMICALLY by the editor's own paste handler, which is the reliable
  route for multi-KB content into a virtualized editor where a long `type` gets dropped (the type
  path's chunking + verification above is the safety net; this is the cure). Same token/path/TTL
  contract (`stageBytes` — `stageClipboardImage` kept its exported signature as a thin wrapper), same
  `/browser-clip/<token>` page and extension exemption, same COPIED/COPY_FAILED title contract, ZERO
  extension surface: the staging script fetches the payload ONCE and branches on the response
  Content-Type — `text/*` goes verbatim to `navigator.clipboard.writeText` (no ClipboardItem needed,
  so the text mode works even where the image mode cannot), anything else through the existing
  data:-URL → canvas → PNG pipeline. The tool result and both metacognition surfaces script the drive
  flow: stage → new_tab → click → read `COPIED` off that click's result (a current extension has
  already closed the staging tab and put you back on the target page; an older one needs `select_tab`
  back + `close_tab`, next bullets) → focus → select-all when REPLACING (`selectAllInstruction`,
  OS-branched exactly like `pasteInstruction`: Ctrl+A selects nothing on macOS, and a silently-failed
  select-all turns REPLACE into APPEND) → paste → re-read.
  Costs stated where they bind: it OVERWRITES the user's clipboard (tool text says so), text staging
  is capped at 1 MB server-side (`MAX_STAGED_TEXT_BYTES`, under the 200k-char schema cap), and the
  expired-token message went generic ("만료되었거나 찾을 수 없는 항목입니다") since the store holds
  text now.
- **A staging tab that reports `COPIED` CLOSES ITSELF (extension 0.27.0+).** The page has served its
  purpose the instant its title flips, and leaving it open was the one step of this flow the agent had
  to remember for no benefit — every copy stranded a dead `클립보드로 복사` tab in the user's Noah
  group, each one still holding the staged content, and cost the agent a `select_tab` to get home. So
  the common action tail asks `isClipboardStagingUrl(fresh.url, stagingOrigin) && fresh.title ===
  CLIPBOARD_COPIED_TITLE` right after `fresh` is read and its origin re-check passes — BEFORE the
  dialog check and the snapshot read, because there is no longer a page worth reading — and on a match
  removes the tab and repeats `close_tab`'s per-tab cleanup BY HAND instead of waiting for the async
  `onRemoved` listener (`attached`, `pendingDialogs`, `forgetTabRefs`, `lastSnapshotByTab`, and the
  return pairing: the reply built immediately after reads state that has to be correct ALREADY), then
  re-points the working tab (next bullet) and answers with `snapshot: ""` plus `clipboardCopiedNote`
  on the `note` channel. The empty snapshot is honest, not lazy: the tab that was acted on no longer
  exists, and the tab the pointer moved to was deliberately NOT read back, because walking it means
  ACTIVATING it — the focus theft this file avoids — for a page the agent's very next op reads anyway
  (that op's `showTab` is what brings it forward). `COPY_FAILED`, or any other title, closes NOTHING:
  a refused `clipboard.write` is precisely the case where the user has to foreground the window (or
  press the button themselves) and the agent has to retry, and a closed tab takes that away. It fires
  for EVERY op that reaches the tail on such a tab, `snapshot` included — a snapshot of a spent page
  is worth no more than a click on one — while the `new_tab` that OPENED it never matches, since the
  button page's title is not `COPIED` yet. Fail-open: a `chrome.tabs.remove` that throws (the tab was
  already gone) still returns the note, and any other throw falls through to the ordinary tail rather
  than failing an op whose COPY has already succeeded. The title is READ SETTLED, not raw: the page
  writes `COPIED` only after `navigator.clipboard.write*` resolves — for an image, after it has first
  fetched the bytes back from Noah — while the tail reads the tab only ~350ms after the click, so an
  INPUT op on a staging page whose title is still undecided re-polls `chrome.tabs.get` every 75ms for
  up to 1.5s (`settledClipStagingTab`, `CLIP_TITLE_SETTLE_MS` / `CLIP_TITLE_POLL_MS` — a field-shaped
  flip at 1.2s is caught), stopping on `COPIED` or `COPY_FAILED`, on a vanished tab, or on a
  navigation away from the staging URL; `fresh` is replaced by the settled read so the ordinary tail
  reports a settled `COPY_FAILED` too. A plain `snapshot` of an un-pressed staging page never waits,
  and no user page ever pays this wait. Without it the auto-close rarely fired for images and the
  guidance's "unchanged title means the copy did NOT happen" turned a success into a false failure.
- **The tab to return to is REMEMBERED at `new_tab` time, because the open and the click are different
  TURNS.** A `new_tab` of a staging URL reads the working-tab id BEFORE anything can overwrite it
  (`currentTabId ?? storedTabId()`, taken ahead of `setCurrentTab(created.id)` — after that the
  pre-staging id exists nowhere else) and keys it under the tab it just created, in a Map bounded at 20
  pairs (insertion order, so the bound drops the STALEST pairing rather than the one an agent is still
  driving) that is ALSO mirrored in `chrome.storage.session` for the same reason `WORKING_TAB_KEY` is
  (addressing.md): the MV3 worker idles out between those two turns and module state dies with it, so
  an in-memory-only map would answer "no previous working tab was remembered" for every copy in the
  field. That mirror is merged in ONCE per worker life with module entries winning, and each write
  chains after the hydrate, so a fresh worker whose map is still empty merges instead of clobbering a
  pairing the mirror is holding. The auto-close then restores the remembered id only while it is still
  IN the Noah group, else `null` — never a guess at a likely-looking tab — which is why
  `clipboardCopiedNote` has TWO shapes: return tab KNOWN (it quotes that page's title, ≤ 80 code units
  sliced on code-point boundaries, with its tabId, and says to paste there) and UNKNOWN (it tells the
  agent to `list_tabs` and `select_tab` its own target). Both stay under 400 chars so a working-tab
  notice can still share `capNote`'s 480-char budget. The pairing is dropped by the `close_tab` branch
  and by the global `onRemoved` listener, which covers the closes the bridge did NOT do: a staging tab
  the user closed by hand, or one abandoned on `COPY_FAILED`.
- **Both extension generations get ONE script** (contract.md: no new wire field, so
  `BROWSER_EXTENSION_MIN_COMPATIBLE` stays 0.6.0 and an OLDER build keeps today's flow). The tool text
  and both metacognition surfaces therefore name the signal every build produces — `COPIED` in the
  click result's `Current page:` line — and then split ONE sentence per generation: current, the bridge
  has already closed the staging tab and its note says which page the working tab is back on; older,
  the tab stays open, so `select_tab` back to the target and `close_tab` the staging tab by hand. The
  forbidden action is identical in both: never paste on anything but `COPIED`.
