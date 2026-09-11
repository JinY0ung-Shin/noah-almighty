# Human-to-human DM (사용자 간 DM)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The `/api/dm` surface, the `direct_messages` schema, the presence definition it shares with the
> admin panel, idempotent send, and the bottom-right dock that renders it.

Person-to-person 1:1 messaging between signed-in Noah users. **Explicitly NOT an avatar capability**:
no MCP tool reads, sends or lists DMs, and DM text, peer lists and unread counts never enter a prompt,
a knowledge repo or AI conversation history. The avatar knows the feature EXISTS (one line of
self-state, below) so it can point the user at the UI instead of offering to send a message it cannot
send.

## HTTP surface (`routes/directMessages.ts`)
- One router, four routes, all under `/api/dm`, all behind a single
  `router.use("/api/dm", requireAuth(store), …)` that also stamps **`Cache-Control: no-store`** — DM
  bodies must never sit in a shared cache or in back-button history.
- `GET /api/dm` → `DirectMessageInbox { peers, unread, windowMinutes }`. `peers` carries
  `{id, username, displayName, online, available, unread}`; `unread` is the sum over peers.
- `GET /api/dm/:peerId?before=<id>` → `DirectMessagePage { messages, hasMore }`, oldest-first, 50 per
  page (the query takes `LIMIT 51` and reports the extra row as `hasMore`). `before` must be a safe
  positive integer or the route 400s; absent it defaults to `Number.MAX_SAFE_INTEGER`.
- **Message rows carry `readAt`** (the RECIPIENT's `read_at`, `null` while unread) to BOTH participants:
  the recipient never renders it, the sender builds the 읽음 boundary from it, and it is the recipient's
  own timestamp so exposing it leaks nothing the sender did not write. A fresh `POST` insert answers
  `readAt: null`; a replay answers the stored row, stamp included.
- `POST /api/dm/:peerId {text, nonce}` → `201 {message}` for a new row, **`200` for a replay** of the
  same nonce. `text` is 1–4000 chars (trimmed before storage), `nonce` must match
  `/^[a-zA-Z0-9_-]{16,80}$/`. Store errors map to `404` (peer missing / suspended / self),
  `429` (rate) and `409` (nonce reused with different content).
- `POST /api/dm/:peerId/read {throughId}` → `{ok:true}`; `throughId` must be a safe positive integer.
- **`requireAuth` only — a personal avatar API key never authenticates here.** Bearer `noah_…` keys are
  accepted exclusively under `/api/v1/avatar/tasks` (see [avatar-task-api.md](avatar-task-api.md)), so an
  external task runner cannot read its owner's DMs. Sender identity always comes from the session, never
  from the body.

## Store (`store/directMessages.ts`)
- Table created by `CREATE TABLE IF NOT EXISTS` in `StoreBase.migrate` (`store/internal.ts`):
  `direct_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id, recipient_id, text, nonce,
  created_at, read_at, UNIQUE(sender_id, nonce))`, both ids `REFERENCES users(id)`. Three indexes:
  `dm_pair(sender_id, recipient_id, id)` for history paging, `dm_unread(recipient_id, sender_id)`
  **partial** `WHERE read_at IS NULL` for badge counts, `dm_rate(sender_id, created_at)` for the rate
  check. No `PRAGMA user_version` ladder is involved — there is no backfill.
- `directMessageInbox` lists every OTHER user who is either currently online **or** has any message in
  either direction, ordered `unread DESC, online DESC, displayName, id`. `available` is just
  `suspended = 0`; the client uses it to disable the composer for a suspended peer while keeping the
  thread readable.
- **Send is idempotent inside one `immediate()` transaction**: look up `(sender_id, nonce)` first — a
  prior row with the SAME peer and text returns `{replay:true}` (HTTP 200), a prior row with different
  content returns `conflict`. Then validate the peer (exists, not suspended, not self → `unavailable`),
  then the rate limit, then insert. Because the nonce check and the insert share the transaction, a
  double-tap or a retry after a dropped response can never duplicate a message, and `UNIQUE(sender_id,
  nonce)` is the backstop if that logic is ever reordered.
- **Rate limit = 60 persisted rows per sender per rolling 60 s.** It counts rows in
  `direct_messages`, so a replay (nothing inserted) does not consume budget and a rejected send does not
  either.
- `readDirectMessages(userId, peerId, throughId)` sets `read_at` only where
  `recipient_id = me AND sender_id = peer AND id <= throughId AND read_at IS NULL`. Scoping to the
  RECIPIENT's rows and to `throughId` is deliberate: a message that arrived after the client rendered
  its list stays unread instead of being silently acknowledged.

## Presence
- `online` = `suspended = 0` **AND** `last_seen_at` within `PRESENCE_WINDOW_MS` **AND** an unexpired
  row in `sessions`. `PRESENCE_WINDOW_MS` (1 h, `store/internal.ts`) is shared with the admin presence
  mixin (`store/admin.ts`), and both surfaces report it the same way
  (`windowMinutes: Math.round(PRESENCE_WINDOW_MS / 60_000)`) so 접속 중 cannot mean two different things
  in two panels. Don't re-introduce a DM-local window.
- `last_seen_at` is stamped by `getUserBySessionToken` — i.e. by EVERY authenticated request, which also
  prunes expired sessions opportunistically. The dock polls `GET /api/dm` every 5 s while the tab is
  visible, so in practice "online" means "had a visible Noah tab within the last hour". There is no
  socket, no heartbeat and no explicit logout signal beyond session expiry.

## Deletion
- `deleteUser` (`store/admin.ts`) deletes DM rows in BOTH directions
  (`WHERE sender_id = ? OR recipient_id = ?`). There is no `ON DELETE CASCADE` anywhere in the schema,
  but `PRAGMA foreign_keys = ON` is set, so this `DELETE` must run BEFORE the `users` row inside the
  same transaction — today it is the first statement in it. Move it after the user delete and permanent
  deletion aborts on an FK violation.

## Client dock (`src/client/src/components/DirectMessageDock.svelte`)
- Mounted ONCE in `App.svelte` **outside** the `.workspace` grid, so the dock survives every view
  (including the rail-less 봇 오피스). A collapsed **메시지** bar sits at the bottom-right with the
  online count and the unread badge; pressing it expands a 360×520 **non-modal** chat window upward
  (peer list → thread with a back button). The bar's badge replaces the old sidebar DM badge; the old
  `DirectMessages.svelte` modal is gone.
- `z-index: var(--z-popover)`; hidden while the mobile rail drawer is open. Expanded state and last peer
  persist in `localStorage` (`dmDockOpen`, `dmDockPeer`). At ≤640 px it becomes a full-width bottom sheet
  (75dvh) collapsed by dragging its grabber down.
- **The composer is the chat composer's own building blocks, not a look-alike.** The thread view renders
  `.composer-box.no-attach.no-stt` around a borderless `<textarea>` and the icon-only `.send-button`, so
  the rounded material box, its `:focus-within` ring and the accent button all arrive from the composer
  layer instead of being re-invented. The textarea reset lives on the WIDENED
  `.composer textarea, .composer-box textarea` selector in `30-agent-md-composer.css` — the dock sits
  outside `.composer`, so the original selector missed it — and the dock's scoped CSS only overrides
  `max-height: 120px` + `font-size`. The Enter/Shift+Enter hint moved off the placeholder, which
  disappears the moment you type, onto an `sr-only` `aria-describedby` line plus the button's `title`;
  the placeholder now names the peer the way the chat's names the avatar.
- **Motion: one spring per intent** — `settle()` takes its parameters per call (`lib/motion.ts`
  `springValue`). A tap (bar, header chevron, Escape, back) is critically damped
  (`dampingRatio: 1`, `response: 0.35`), the DESIGN §2.5 default for a settle nobody is touching; only a
  RELEASED sheet drag underdamps (`0.84`, `response: 0.3`), and only because it continues the finger's own
  velocity. A spring interrupted mid-flight hands its instantaneous velocity (Δvalue/Δt sampled in
  `onUpdate`) to its replacement, so a toggle caught mid-flight REVERSES as one continuous motion instead
  of restarting from a standstill. `.dm-dock-panel` carries `.springing` while a spring runs, which with
  `.dragging` is what promotes the layer (`will-change: transform`), and the reduced-motion path is still
  the 120 ms cross-fade with no travel at all.
- Expanding the dock on a conversation in a VISIBLE tab is what sends the read ack, for exactly the
  messages displayed. Messages render as bubbles with time-only stamps and day separators.
- **Read receipts render as a BOUNDARY, not a per-bubble label.** `receiptMarks(messages, userId)`
  (`lib/directMessages.ts`) reduces the transcript to `{lastReadId, unreadIds}` over the viewer's OWN
  messages — `read_at` is monotonic per thread, so one id describes the whole history — and the dock
  derives it in a `$:` statement (naming `messages`/`userId`, per the legacy-mode compile-time
  dependency rule) and appends 읽음 / 안 읽음 inside each of MY bubbles' existing `<small>`, with the
  middle-dot separator drawn by CSS so the label stays the element's whole text. Peer bubbles never get
  one, read bubbles BEFORE the boundary carry no label, and a row missing `readAt` entirely (an old
  mock) counts as unread. The 5 s thread re-fetch plus last-writer-wins `mergeMessages` is the ONLY
  transport: a stamp set after the fact arrives on the next poll, so nothing receipt-specific is
  requested. Older pages beyond the latest 50 keep the `readAt` they were fetched with.
- The dock publishes **`--dm-dock-inset`** on `<html>` — viewport right edge → the bar's left edge, plus
  8 px — kept fresh by a `ResizeObserver` on the bar (its width follows the label and badge) plus a
  window `resize` listener, and REMOVED while the dock is `hidden` or unmounted. The single consumer is
  `.composer-hint`'s `padding-right` in `30-agent-md-composer.css`, scoped to the chat column that is
  last in `.chat-layout`: without it the pill covers the composer's browser-bridge status chip, which is
  a button into the install guide. Anything else that lands in that corner should reserve room the same
  way rather than re-measuring the bar.
- **The first inset measurement is deferred to after the first paint** (double `requestAnimationFrame`
  in `onMount`), never taken synchronously during the mount task. A `getBoundingClientRect()` there
  forces a layout while the `@font-face` subsets are still unloaded, and in headless Chromium the text
  shaped by that early layout stays on the system fallback even after the fonts load — the rail's
  탐색/비우기/진영 rendered as tofu in the visual baselines until the measurement moved. Bisected with
  CDP `CSS.getPlatformFontsForNode`; the visual specs' `waitForKoreanFont` now fails on any such node.
- The dock **normalizes `{}` responses** from `/api/dm*`: other Playwright specs stub unknown `/api/**`
  with an empty object, so a missing `peers`/`messages` array must degrade to an empty list rather than
  throw.

## Metacognition
- One shared constant, `DIRECT_MESSAGE_STATE` (`agent/ownerState.ts`), is pushed into
  `buildSystemPromptAppend` (`agent/promptBuilder.ts`) AND into `describe_system`'s **public guide**
  (`agent/systemTools.ts`) — the public half, so it reaches non-owner viewers too. It states where the
  dock is, that DM crosses groups, and that no avatar tool can read or send DMs.
- Detail lives in manual topic `direct-messages` (`agent/systemManual.ts`), which the constant points
  at. Update both when the UI moves; the constant is the only DM text in the prompt budget.

## Design notes and gotchas
- **DM reach deliberately crosses group boundaries.** Every signed-in user can message every
  recently-active user, independent of `avatar_sharing`, avatar visibility and group membership — the
  opposite of avatar discovery (`SHARING_TEAMMATES`). It is human contact, not an avatar ACL; don't
  route it through `isTrustedFor`.
- There is **no block, mute, typing indicator, edit/delete or push notification**, and no end-to-end
  encryption: plaintext rows in the server SQLite file, readable by anyone with DB access. Only the two
  participants can read a thread over HTTP — admins have no DM-reading endpoint, by design.
- **Read receipts are sender-side only, and they add no signal** — they RENDER the ack the recipient's
  dock was already sending. Looking at a thread sends nothing extra, and the reader is never told
  whether their own messages were read except by the same marks on their own side.
- **Adding an avatar-facing DM tool would need a privacy review**, not just a new MCP handler: it would
  put another person's private message into a model prompt. The avatar-boundary sentence in the manual
  and in `DIRECT_MESSAGE_STATE` is the current answer.
- Tests: [`tests/direct-messages.test.ts`](../../tests/direct-messages.test.ts) (3 server cases —
  delivery/isolation/ack, validation + nonce dedupe + rate limit, presence expiry + offline threads
  across restart + both-direction cleanup), `tests/visual/direct-messages.spec.ts` (Playwright, dock
  layout and states) and `tests/client-direct-messages.test.ts` (client helpers).
