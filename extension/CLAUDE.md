# extension — Claude notes (browser bridge)

The Chrome/Edge half of the browser bridge. It ships to users' machines as a SIGNED artifact, so a mistake
here fails in the FIELD, not in CI. Read with the root [`CLAUDE.md`](../CLAUDE.md) ("Secrets and the user's
browser", "Deploy topology"); install/policy in [`README.md`](README.md); mechanics in
[`docs/architecture/browser-bridge.md`](../docs/architecture/browser-bridge.md) (5-page hub — start with
`contract.md`; this folder's release/environment detail is in `extension.md`).

- **Every file that ships is listed in `BUNDLE_FILES`** (`src/server/browserExtensionBundle.ts`) — an explicit
  allowlist, not a directory walk; a forgotten new file silently bricks the zip. A binary file also needs
  `BINARY_BUNDLE_FILES` (else the updater corrupts it through utf8). Neither failure shows in CI without a
  byte pin in `tests/infra.test.ts`.
- **Load-bearing files:** `background.js` imports `axtree.js` and `secretInput.js` at load — a bundle missing
  either never registers the WORKER, so every op dies. The four `icon-*.png` must stay tracked: a missing
  icon makes Chrome refuse the WHOLE extension and breaks the zip route, release build and tests.
- **`manifest.json` `key` IS the extension's identity.** Changing it moves the id in four places (see
  `extension.md`); the private half lives only on the release machine.
- **`BROWSER_EXTENSION_MIN_COMPATIBLE` is a fleet-wide reinstall order.** Raise it ONLY when the agent-facing
  op contract breaks, never because this folder changed; it must stay ≤ the bundled manifest version.
- **The extension FETCHES NOTHING on its own — a security decision.** No `host_permissions`, no network call
  (a self-updater got the zip quarantined by Defender). `CDP_ALLOWLIST` stays default-deny; its only page-JS
  exception is `read_storage`'s fixed bridge-authored expressions, and its only `Network.*` call the
  consent-gated `read_cookies`. → `contract.md`.
- **Consent lives HERE, where the server cannot bypass it.** Data reads are consented per (host, data type)
  in one store; `secret` is the one WRITING kind and the one session-wide grant (the per-site limit is the
  owner's host allowlist, re-checked at every write) — its consent copy must SAY the grant widens no reach.
  **A new consent kind moves `DATA_CONSENT_COPY`,
  `consent.js` and `options.js` together** (a sentinel-keyed kind also needs its row label). → `contract.md` (reads), `actions.md` (`secret`,
  adding a kind).
- **A secret write is deliberately NARROWER than an ordinary one.** The value arrives only on
  `secretText`/`secretValue` (keep it so — an old build then types nothing); every refusal (tab host → frame host → password
  shape) runs BEFORE the consent popup; it writes through `writeSecretField`, never `clearAndWrite`;
  verification is length-only; no note, error or throw ever carries the value. `secretInput.js` stays the
  pure half, never wired to the value. → `browser-bridge/actions.md`.
- **A browser op is a FIVE-layer hand-synced contract** (see `src/server/agent/CLAUDE.md`); nothing
  type-checks across it. `routes/chat.ts` is the primary size bound on extension-supplied strings, so a new
  relayed field is `.slice()`d there.
- **Screenshot pixel mapping is MEASURED from the returned bitmap**, and a viewport capture is pre-fitted to
  the size Claude's API resizes to. The vision tier constants are mirrored in `agent/visionImage.ts` — when the
  documented limits move, both move. → `snapshots.md`.
- **Language split applies here too:** `background.js`/`axtree.js` strings are model input (English);
  everything a person reads — `options.html`, `consent.html`, `action.default_title`, `README.md`,
  `manifest.json` `description`, `policy-schema.json` — is Korean.
- **`options.html` is both the popup and the options tab; the popup body width is ONE fixed,
  viewport-independent value** (Chrome remeasures popups from 25px; a viewport-relative width oscillates or
  collapses). Don't add `chrome.action.onClicked` — it never fires with a popup. → `extension.md`.
- **Verify by LOADING the extension, never by reading it** — Playwright Chromium with `--load-extension`, with a
  negative control (Chrome loads invalid patterns with only a warning). Popup recipe in `extension.md`.
