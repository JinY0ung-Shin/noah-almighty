# Browser bridge (`mcp__browser__*` + the Chrome extension)

> Detail hub of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The largest subsystem in these notes. An op crosses five layers that nothing type-checks across,
> so **read [contract.md](browser-bridge/contract.md) before any change**, then open only the page
> for the area you are touching.

The durable direction (relay into the user's own browser, the extension runs no page JS beyond the fixed
bridge-authored expressions for `read_storage`, the default-deny `CDP_ALLOWLIST` is the boundary, everything
the page returns is untrusted) is summarized in [`../../CLAUDE.md`](../../CLAUDE.md) and stated in full in
[contract.md](browser-bridge/contract.md) and [actions.md](browser-bridge/actions.md). Cautions for the shipped folder itself — `BUNDLE_FILES`,
`BINARY_BUNDLE_FILES`, the min-compatible ceiling, icons, popup sizing — are in
[extension.md](browser-bridge/extension.md) (summary rules in [`../../extension/CLAUDE.md`](../../extension/CLAUDE.md)). The user-facing install and allowlist-policy
guide is [`../../extension/README.md`](../../extension/README.md) (Korean).

| Page | Open it when |
|---|---|
| [contract.md](browser-bridge/contract.md) | Adding or changing ANY op — the five hand-synced layers, extension version compatibility, the composer's four badge rungs, and how `screenshot` rides the run's resolved vision. |
| [addressing.md](browser-bridge/addressing.md) | You need to reach a specific element: `click_at`'s two unrelated modes, how long a uid stays valid, the pinned working tab, the settle tail, and the three ways frames are walked. |
| [actions.md](browser-bridge/actions.md) | You are changing what an op *does*: verified writes and their four end states, `type` routing by control kind, selects, navigation and the destination-based origin gate, click guards, audit rows, and the no-JS constraint. |
| [snapshots.md](browser-bridge/snapshots.md) | You are changing what the model *sees*: atom budgeting, `maxChars`, state flags, table rows, respacing, links/images, and the nine `axtree.js` rules that each exist because something real went missing. |
| [extension.md](browser-bridge/extension.md) | You are releasing, signing, or debugging in the field: the one RSA key that is the extension's identity, the policy update channel, build-time origins, verified Chrome/Edge behavior, corporate DLP, and local Playwright verification. |

Two invariants that fail in the FIELD rather than in CI, repeated here because they are cheap to miss:
a new file under `extension/` must be added to `BUNDLE_FILES` (and a BINARY file also to
`BINARY_BUNDLE_FILES`), and `BROWSER_EXTENSION_MIN_COMPATIBLE` must never exceed the bundled manifest
version. Details in [extension.md](browser-bridge/extension.md).
- **Reader/proxy services are refused SERVER-side, whatever the user's allowlist says** (2026-11-16).
  `navigate`/`new_tab` check `readerProxyRefusal` (`agent/browserTools.ts`: r.jina.ai, 12ft.io, archive.ph &
  co., Google cache, `*.translate.goog`, Translate's `/translate` page mode, Wayback `/save`) before the op is
  relayed: such a service fetches the URL on the avatar's behalf, so an internal URL would be handed to a third
  party, and its copy is not what the user's login sees. `describe_system` and the manual topic
  `browser-inspection` say so (the standing prompt has no room left under its 18 000-char budget, and the refusal
  itself redirects): open the page itself or `read_url`. Add a host to `READER_PROXY_HOSTS` when another one turns up.
