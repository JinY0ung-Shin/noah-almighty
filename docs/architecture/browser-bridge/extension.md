# Browser bridge — extension release and environment

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> The signing key and update channel, build-time origins, verified Chrome/Edge facts, corporate DLP, and local verification.

- **The signing key IS the extension's identity.** It lives off-repo on the release machine only;
  manifest `key` is its public half and Chrome derives the id from it. Change the key and the id
  changes — `extension/manifest.json`, the `browserBridge.ts` default id, `extension/README.md`, and any
  admin policy path naming the id must move together, and every install reloads once (done 2026-08-07:
  `fbohmmep…` → `gdaheigee…`). The build script refuses to run on a manifest/key mismatch and prints the
  exact bootstrap list.
- **One auto-update channel, one key: the POLICY channel** (signed `.crx` + Omaha `updates.xml`,
  Chrome `ExtensionSettings force_installed`, zero user action). The extension-side GitHub
  self-updater (0.7.0's `updater*.js`, removed in 0.9.0) is deliberately gone and must not come
  back: fetch-verify-write-reload is dropper-shaped — Windows Defender quarantined the shipped zip
  over it (`Trojan:Win32/Fauppod.A!cl`) — and it carried real attack surface (`github.com`
  host_permissions + a disk-write path). The extension fetches NOTHING on its own.
  `browserExtensionUpdate.ts` / `browserExtensionCrx.ts` are RELEASE-TIME modules — only
  `scripts/build-browser-extension-update.ts` and tests import them; never pull them onto a request
  path, because a server holding the signing key turns a server compromise into fleet-wide browser
  control. The policy's update_url reads `releases/latest/download/…`, so EVERY release must attach
  both assets.
- **Origins are BUILD-TIME for the policy channel.** Chrome enforces `externally_connectable` before any
  extension code runs and a policy install cannot be hand-edited, so a missing Noah address fails
  SILENTLY on every machine (`chrome.runtime` simply isn't there — no error to see). The manual zip path
  needs none of this: the download route stamps the requesting origin into that bundle's manifest.
- **Chrome facts verified by experiment, not by docs.** `externally_connectable` match patterns IGNORE
  the port (a pattern with no port matched a `:48787` page ⇒ writing a port grants EVERY port on that
  host); the scheme IS matched; IP literals are valid; trailing `/*` is mandatory. Chrome LOADS an
  extension whose pattern is invalid, dropping the entry as a warning — **"it loaded" is not evidence a
  pattern works; always run a negative control.** GitHub redirects release-asset downloads to
  `release-assets.githubusercontent.com`, not `objects.*` (a 404 probe never redirects, which is why
  this hid until real assets existed) — it bit the since-removed self-updater's `host_permissions`
  and applies to any future extension-side GitHub fetch (there is none today, by design).
- **Corporate DLP can intercept the browser's file dialog** ("not an allowed upload URL"), which kills
  every File System Access path on managed machines — that is why the policy channel exists. The
  no-dialog interim is "unzip in Explorer + `chrome://extensions` ↻". Don't try to code around it.
- **The allowlist has an operator-seeded DEFAULT tier that lives server-side, not in the extension.**
  `BROWSER_ALLOWED_ORIGINS` (server env) is served on `GET /api/browser-extension` as
  `defaultAllowedOrigins`, and the chat page's bridge probe writes it — via the ordinary
  `setAllowedOrigins` config op — into an extension whose local allowlist is still EMPTY
  (`allowlistSeed`, `lib/browserBridge.ts`; a visible notify follows). Precedence is unchanged:
  managed policy still wins outright, a user-edited local list is NEVER overwritten (seeding requires
  `source === "empty"` with zero patterns), and the settings tab only offers a draft-fill button.
  Entries that would cover Noah's own host — exact, `*.wildcard`, or a bare `*` — are dropped
  server-side AND client-side (`shared/originPatterns.ts`, a hand-kept mirror of `originAllowed`'s
  pattern semantics): a default must not reopen what the `/browser-clip/` staging exemption was
  scoped down to prevent. The extension itself still fetches nothing.
- **Edge is served by the SAME build.** Every API the extension touches (`tabGroups`/`tabs.group`,
  `debugger`, `storage.managed`, `externally_connectable`) is on Edge's supported-API list, and the id
  derives from the manifest `key` identically, so one zip/crx covers both browsers. The only per-browser
  fork is the ADMIN POLICY TREE — the same JSON registered once under `Software\Policies\Google\Chrome`
  and once under `Software\Policies\Microsoft\Edge` (Linux: `/etc/opt/chrome` vs `/etc/opt/edge`); the
  build script prints both. User-facing guidance resolves the extensions page at runtime instead of
  hardcoding `chrome://` (`extensionsPageUrl()` in `lib/browserBridge.ts`).
- **Chromium facts the SECRET write rests on, measured rather than assumed**
  (`tests/visual/password-facts.spec.ts`, run with
  `node node_modules/@playwright/test/cli.js test tests/visual/password-facts.spec.ts` — local http
  servers + raw CDP, no dev server). A password field's AX value reads back as one `•` per character
  through BOTH `getPartialAXTree` and `getFullAXTree`, which is what makes LENGTH-only verification a
  real signal and keeps the plaintext out of the snapshot the same op returns; `DOM.describeNode` shows
  the `type=password` shape and no value; a plain text input reads back PLAINTEXT (why `passwordOnly`
  defaults on); and `DOMSnapshot.captureSnapshot`'s `inputValue` DOES carry the plaintext — the one
  allowlisted read that would leak it, so only its `documentURL` is ever touched. The frame half is the
  one that measured against intuition: `captureSnapshot` on the root session attributes every
  SAME-PROCESS node to its own document (so a sibling-host iframe inside an allowed page is caught), but
  a CROSS-site frame is an OOPIF whose document is absent from that capture AND whose backendNodeIds are
  per-PROCESS — the same number names an unrelated node in the top document, so attributing an OOPIF
  element through the root would answer with the TOP page's URL, precisely the host the secret is allowed
  on. Hence `refDocumentUrl` asks a `sessionId`-carrying ref's OWN session (`Page.getFrameTree`) and only
  falls to the capture for root-session refs — and skips it entirely when the root frame tree has no
  children, which is the ordinary single-frame login page. Probing this over raw CDP is sound here
  because every method involved is already on `CDP_ALLOWLIST` and already proven over `chrome.debugger`
  by a shipped op; a probe asking whether a method is REACHABLE must use `chrome.debugger` instead (the
  `DOMStorage` lesson in contract.md).
- **Site isolation has to be turned ON in a Playwright probe about frames.** Desktop Chrome and Edge —
  the fleet — isolate cross-site frames by default; a bare `chromium.launch()` does not, so the same
  fixture silently measures a same-process frame and the OOPIF branch goes untested. `--site-per-process`
  (plus `--host-resolver-rules=MAP *.test 127.0.0.1` for real cross-host iframes) is what makes the probe
  measure the browser users actually run.
- **Verifying extension behavior locally:** Playwright's Chromium loads the unpacked extension
  (`chromium.launchPersistentContext(dir, { channel: "chromium", args: ["--disable-extensions-except=<extension/>",
  "--load-extension=<extension/>"] })`), which drives real `chrome-extension://` pages and settles what a
  match pattern actually does. `@playwright/test` (devDep) and `playwright-core` are installed. Ad-hoc harness — not committed as a test.
  Always run a NEGATIVE control: Chrome loads an extension with an invalid `externally_connectable` pattern
  (dropping the entry with only a warning), so "it loaded" is not evidence a pattern works.

## Fleet and signing invariants (fail in the FIELD, not in CI)
- **Windows/Linux only — no macOS.** Platform-dependent decisions (paste shortcuts, file-dialog/DLP behavior,
  extension guidance) target Windows/Linux; mac handling stays defensive-only (e.g. `viewerPlatform`'s Meta
  branch), and no user-facing text or release note advertises macOS.
- **ONE RSA key on the release machine** (`BROWSER_EXTENSION_KEY_FILE`) derives the extension id and the policy
  update channel. Losing it orphans every install; changing it changes the id, which every place naming the id
  must follow.
- **A new file under `extension/` joins `BUNDLE_FILES`** (`browserExtensionBundle.ts`) or the shipped zip silently
  bricks; a BINARY file also joins `BINARY_BUNDLE_FILES`, or the one-click updater pushes it through utf8 and
  corrupts it.
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` never exceeds the bundled manifest version** — `tests/infra.test.ts`
  enforces the ceiling.
- **`BUNDLE_FILES` is an explicit allowlist, not a directory walk** — a stray note here never ships, but a
  forgotten real file does not either, and neither failure shows in CI unless a byte-equality pin is added to
  `tests/infra.test.ts`.
- **`background.js` imports TWO pure modules at load — `axtree.js` and `secretInput.js`.** Both are on
  `BUNDLE_FILES` and byte-pinned in `tests/infra.test.ts`: an MV3 module worker whose import fails never
  registers, so a bundle missing either kills every op (the extension reads as unreachable).
- **The four `icon-*.png` are load-bearing and stay tracked in git.** `manifest.json` names them, so a missing or
  corrupted icon makes Chrome refuse the WHOLE extension. They are on `BUNDLE_FILES` + `BINARY_BUNDLE_FILES`, and
  every consumer reads them with a throwing `fs.readFileSync`, so an untracked icon 500s
  `GET /api/browser-extension.zip`, breaks the release build and fails `app.test.ts`/`infra.test.ts`.
- **Changing `manifest.json` `key` moves the id in four places:** the manifest, the `browserBridge.ts` default id,
  `README.md`'s example id, and any admin policy-registry path naming it. The build script refuses a mismatch
  and prints the bootstrap list.
- **The extension fetches nothing on its own.** The 0.7.0 self-updater (updater.html/js/css) was removed in
  0.9.0 because fetch-verify-write-reload is dropper-shaped — Windows Defender quarantined the shipped zip over
  it. No `host_permissions`, no network call.
- **Language split inside the folder:** `background.js`/`axtree.js` strings are model-facing input (English);
  everything a person reads — `options.html`, `consent.html`, `action.default_title`, `README.md` — is Korean.
  The easy misses are `manifest.json` `description` and `policy-schema.json`.

## Action popup sizing
`options.html` is BOTH the action popup and the options tab, and the popup's body width must be ONE fixed,
viewport-independent value. Chrome sizes an action popup by resetting its frame to the 25px minimum and reading
`scrollWidth` as the content width, and since Chrome 152 it repeats that after every post-load layout change.
With no width the popup balloons to the 800px cap; with a width that follows the viewport (`max-width: 100vw`,
`%`, a media query matching under ~430px) it never reports its true width at 25px, so it oscillates between
partial widths on classic scrollbars or collapses to a ~32px sliver on overlay scrollbars (the 2026-09-04 bug; a
`max-width: 100vw` shipped since 0.9.0 was harmless until Chrome 152). Verify popup CSS by OPENING the real
popup: Playwright + `--load-extension`, `chrome.action.openPopup()` from the service worker, and a probe script in
the popup logging `resize` sizes to `chrome.storage.local` (the popup never surfaces as a Playwright page) —
against current stable Chrome for Testing, classic AND `--enable-features=OverlayScrollbar`, with the unfixed CSS
as the control. Setting `action.default_popup` means `chrome.action.onClicked` never fires — don't add a listener.
