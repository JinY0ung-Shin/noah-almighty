<script lang="ts">
  // Human-to-human DM, as a messenger dock rather than a modal: a pill in the
  // viewport's bottom-right corner that expands UPWARD into a chat window and
  // collapses back down. Deliberately NON-modal — no scrim, no focus trap, no
  // `role="dialog"` — so the app behind it stays usable while a conversation is
  // open (the old modal made reading a message and acting on it exclusive).
  //
  // Mounted once at the App root for every logged-in view, so it must survive
  // whatever `/api/dm` answers, including the `{}` that unmocked routes return
  // in the Playwright fixtures — hence `normalizeInbox`/`normalizePage`.
  import { onMount, tick } from "svelte";
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import { api } from "../lib/api";
  import { groupByDay, makeNonce, mergeMessages, normalizeInbox, receiptMarks, timeLabel } from "../lib/directMessages";
  import { autosize } from "../lib/dom";
  import { prefersReducedMotion, project, rubberband, springValue } from "../lib/motion";
  import type {
    DirectMessage,
    DirectMessageInbox,
    DirectMessagePage,
    DirectMessagePeer,
  } from "../../../shared/directMessages";

  export let userId: string;
  /** Set while the mobile rail drawer is open — the dock must not float over it. */
  export let hidden = false;

  const OPEN_KEY = "dmDockOpen";
  const PEER_KEY = "dmDockPeer";
  /** Extra travel so the panel's shadow clears the viewport edge when parked. */
  const OFFSCREEN_GAP = 16;
  const FADE_MS = 120;
  /** Custom property the dock publishes so content under the pill can step aside. */
  const INSET_PROPERTY = "--dm-dock-inset";
  /** Breathing room between the pill and whatever it pushes out of the way. */
  const INSET_GAP = 8;

  function pref(key: string, fallback = ""): string {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function setPref(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: prefs just won't persist */
    }
  }
  function clearPref(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode: prefs just won't persist */
    }
  }

  // Restored open state is applied in the INITIALIZER, not onMount: the panel is
  // then present in the very first render, so a reload lands on the open dock
  // with no slide (an entrance animation on page load reads as a notification).
  let expanded = pref(OPEN_KEY) === "1";
  let panelMounted = expanded;
  let restorePeerId = pref(PEER_KEY);

  let inbox: DirectMessageInbox = { peers: [], unread: 0, windowMinutes: 60 };
  let selected: DirectMessagePeer | null = null;
  let messages: DirectMessage[] = [];
  let drafts: Record<string, string> = {};
  const pending = new Map<string, { text: string; nonce: string }>();
  let draft = "";
  let error = "";
  let syncError = "";
  let loading = false;
  let sending = false;
  let olderLoading = false;
  let hasMore = false;
  let generation = 0;
  let refreshing = false;

  let rootEl: HTMLDivElement | undefined;
  let barEl: HTMLButtonElement | undefined;
  let panelEl: HTMLElement | undefined;
  let transcriptEl: HTMLDivElement | undefined;
  let composerEl: HTMLTextAreaElement | undefined;

  let panelY = 0;
  let dragging = false;
  /** A spring owns the transform right now — mirrors `.rail.rail-springing`. */
  let springing = false;
  let closing = false;
  let closeTimer = 0;
  /** Presentation velocity of the running spring, px/s. A toggle that catches a
      spring mid-flight continues from the speed the panel ALREADY had, so a
      reversal reads as one continuous motion instead of a brick wall at 0. */
  let panelVelocity = 0;
  let stopSpring: (() => void) | null = null;

  const controller = new AbortController();
  const mobileMedia =
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;

  $: onlineCount = inbox.peers.filter((peer) => peer.online).length;
  // Read receipts, derived HERE rather than per bubble: the marks are a property
  // of the whole transcript (one boundary), and a `$:` statement is also what
  // makes the recomputation legible to the legacy-mode compiler — `messages` and
  // `userId` are named in the statement, so a poll that only refreshes `readAt`
  // still re-renders.
  $: marks = receiptMarks(messages, userId);

  // AbortSignal.any is newer than the browsers/jsdom this ships into; without
  // the guard its absence throws before the request is even made (mirrors the
  // AbortSignal.timeout guard in lib/api.ts).
  function requestSignal(): AbortSignal {
    const timeout =
      typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15_000) : null;
    if (timeout && typeof AbortSignal.any === "function") return AbortSignal.any([controller.signal, timeout]);
    return controller.signal;
  }

  function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return api<T>(path, { ...options, signal: requestSignal() });
  }

  function normalizePage(raw: unknown): DirectMessagePage {
    const source = (raw ?? {}) as Partial<DirectMessagePage>;
    return {
      messages: Array.isArray(source.messages)
        ? source.messages.filter((message) => !!message && Number.isFinite(message.id))
        : [],
      hasMore: source.hasMore === true,
    };
  }

  function statusText(peer: DirectMessagePeer): string {
    return peer.online ? "접속 중" : peer.available ? "오프라인" : "이용 정지";
  }

  /** Marking read is a claim the owner SAW the messages — so only while the
      thread is actually on screen and the tab is in front. */
  async function acknowledge(peerId: string, id: number, version: number): Promise<void> {
    if (!expanded || !selected || document.hidden || generation !== version) return;
    await request(`/api/dm/${encodeURIComponent(peerId)}/read`, {
      method: "POST",
      body: JSON.stringify({ throughId: id }),
    });
  }

  async function loadMessages(initial = false): Promise<void> {
    if (!selected || !expanded) return;
    const peerId = selected.id;
    const version = generation;
    const nearBottom =
      !transcriptEl || transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 80;
    const page = normalizePage(await request<DirectMessagePage>(`/api/dm/${encodeURIComponent(peerId)}`));
    if (version !== generation || !expanded) return;
    // If over a page arrived between polls, fetch the gap before merging.
    const previousLast = messages.at(-1)?.id;
    let incoming = page.messages;
    let gap = page;
    while (!initial && previousLast && gap.hasMore && (gap.messages[0]?.id ?? 0) > previousLast) {
      gap = normalizePage(
        await request<DirectMessagePage>(`/api/dm/${encodeURIComponent(peerId)}?before=${gap.messages[0].id}`),
      );
      if (version !== generation || !expanded) return;
      incoming = [...gap.messages, ...incoming];
    }
    messages = mergeMessages(messages, incoming);
    if (initial) hasMore = page.hasMore;
    loading = false;
    await tick();
    if (version !== generation || !expanded) return;
    // Plain scrollTop, not scrollTo(): jsdom has no scroll implementation and
    // this component now mounts on every view, test fixtures included.
    if ((initial || nearBottom) && transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    const last = messages.at(-1);
    if (last) await acknowledge(peerId, last.id, version);
  }

  /** Inbox poll. Runs while COLLAPSED too — the bar's unread badge is the only
      thing telling the owner a message arrived. */
  async function refresh(): Promise<void> {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      inbox = normalizeInbox(await request<unknown>("/api/dm"));
      if (restorePeerId) {
        const wanted = restorePeerId;
        restorePeerId = "";
        const peer = inbox.peers.find((candidate) => candidate.id === wanted);
        if (peer) {
          syncError = "";
          // No focus move: a restore is not a user gesture, and a mobile
          // keyboard popping open on page load is its own bug.
          await choose(peer, false);
          return;
        }
        clearPref(PEER_KEY);
      }
      if (selected) {
        const peer = inbox.peers.find((candidate) => candidate.id === selected!.id);
        selected = peer ?? { ...selected, online: false, available: false };
      }
      if (expanded && selected && !loading) await loadMessages(messages.length === 0);
      syncError = "";
    } catch (err) {
      if (!controller.signal.aborted) syncError = (err as Error).message;
    } finally {
      refreshing = false;
    }
  }

  async function choose(peer: DirectMessagePeer, focusComposer = true): Promise<void> {
    if (selected) drafts[selected.id] = draft;
    selected = peer;
    setPref(PEER_KEY, peer.id);
    draft = drafts[peer.id] || "";
    generation++;
    const version = generation;
    messages = [];
    hasMore = false;
    loading = true;
    error = "";
    if (focusComposer) void focusIntoPanel();
    try {
      await loadMessages(true);
    } catch (err) {
      if (version === generation && !controller.signal.aborted) error = (err as Error).message;
    } finally {
      if (version === generation) loading = false;
    }
  }

  /** Thread → list. The draft is kept per peer, so coming back restores it. */
  function back(): void {
    if (selected) drafts[selected.id] = draft;
    selected = null;
    clearPref(PEER_KEY);
    generation++;
    messages = [];
    hasMore = false;
    loading = false;
    error = "";
    // The back button itself is about to unmount; without this focus falls to
    // <body> and the keyboard user loses their place.
    void focusIntoPanel();
  }

  async function older(): Promise<void> {
    if (!selected || !messages.length || olderLoading || !transcriptEl) return;
    const version = generation;
    olderLoading = true;
    const height = transcriptEl.scrollHeight;
    const top = transcriptEl.scrollTop;
    try {
      const page = normalizePage(
        await request<DirectMessagePage>(
          `/api/dm/${encodeURIComponent(selected.id)}?before=${messages[0].id}`,
        ),
      );
      if (version !== generation) return;
      messages = mergeMessages(messages, page.messages);
      hasMore = page.hasMore;
      await tick();
      if (transcriptEl) transcriptEl.scrollTop = top + transcriptEl.scrollHeight - height;
    } catch (err) {
      if (!controller.signal.aborted) error = (err as Error).message;
    } finally {
      olderLoading = false;
    }
  }

  async function send(): Promise<void> {
    if (!selected?.available || sending || !draft.trim()) return;
    const peerId = selected.id;
    const text = draft.trim();
    const originalDraft = draft;
    const prior = pending.get(peerId);
    // Retain the nonce on a network failure: retrying cannot duplicate delivery.
    const attempt = prior?.text === text ? prior : { text, nonce: makeNonce() };
    pending.set(peerId, attempt);
    sending = true;
    error = "";
    try {
      const result = await request<{ message: DirectMessage }>(`/api/dm/${encodeURIComponent(peerId)}`, {
        method: "POST",
        body: JSON.stringify(attempt),
      });
      pending.delete(peerId);
      if (drafts[peerId] === originalDraft) drafts[peerId] = "";
      if (selected?.id === peerId) {
        messages = mergeMessages(messages, [result.message]);
        if (draft === originalDraft) draft = "";
        await tick();
        if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
      await refresh();
    } catch (err) {
      if (!controller.signal.aborted) error = (err as Error).message;
    } finally {
      sending = false;
    }
  }

  function retry(): void {
    if (selected) void choose(selected, false);
    else void refresh();
  }

  // ---- viewport reservation ----------------------------------------------

  /**
   * Publish the bar's footprint (viewport right edge → bar's LEFT edge, plus a
   * gap) so a layout that puts controls in the same corner can reserve room.
   * The bar keeps its layout box while expanded (`visibility: hidden`, not
   * `display: none`), so the reservation stays steady instead of collapsing and
   * reflowing the page every time the dock opens.
   */
  function publishInset(dockHidden = hidden): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    // Hidden behind the mobile rail: the dock covers nothing, so reserve nothing.
    if (dockHidden || !barEl) {
      root.style.removeProperty(INSET_PROPERTY);
      return;
    }
    const rect = barEl.getBoundingClientRect();
    if (rect.width < 1) return;
    root.style.setProperty(INSET_PROPERTY, `${Math.ceil(window.innerWidth - rect.left) + INSET_GAP}px`);
  }

  $: publishInset(hidden);

  // ---- open/close motion -------------------------------------------------

  type SpringParams = { dampingRatio: number; response: number };
  /** Tap-driven open/close (bar, chevron, Escape, back): critically damped, the
      DESIGN §2.5 default — a settle nobody is touching must not overshoot. */
  const TAP_SPRING: SpringParams = { dampingRatio: 1, response: 0.35 };
  /** A released sheet drag. The only path carrying the user's flick momentum,
      which is the only case §2.5 lets damping drop to ~0.8. */
  const FLICK_SPRING: SpringParams = { dampingRatio: 0.84, response: 0.3 };

  /** Measured while mounted; estimated from the CSS sizing rules otherwise. */
  function panelHeight(): number {
    const measured = panelEl?.getBoundingClientRect().height ?? 0;
    if (measured > 1) return measured;
    const viewport = typeof window !== "undefined" ? window.innerHeight : 800;
    return mobileMedia?.matches ? viewport * 0.75 : Math.min(520, viewport * 0.7);
  }

  /** Drop the running spring. A caller that means to CONTINUE its motion reads
      `panelVelocity` before calling this — the reset is what keeps a stale
      velocity from leaking into an unrelated later spring. */
  function cancelSpring(): void {
    stopSpring?.();
    stopSpring = null;
    springing = false;
    panelVelocity = 0;
  }

  /**
   * Retarget the panel with a spring. The parameters come from the CALLER, per
   * DESIGN §2.5: a tap is critically damped (no overshoot on a programmatic
   * settle), and only a released drag — which has real flick momentum behind
   * it — is allowed to underdamp.
   */
  function settle(
    from: number,
    to: number,
    spring: SpringParams,
    velocity = 0,
    complete?: () => void,
  ): void {
    cancelSpring();
    springing = true;
    panelVelocity = velocity;
    let settled = false;
    let last = from;
    let lastTime = performance.now();
    const stop = springValue({
      from,
      to,
      velocity,
      response: spring.response,
      dampingRatio: spring.dampingRatio,
      onUpdate: (value) => {
        const now = performance.now();
        const elapsed = now - lastTime;
        // Real frames only. springValue's reduced-motion path calls onUpdate
        // once, synchronously, and that zero-length interval would read as a
        // near-infinite velocity.
        if (elapsed >= 1) {
          panelVelocity = ((value - last) / elapsed) * 1000;
          last = value;
          lastTime = now;
        }
        panelY = value;
      },
      onComplete: () => {
        settled = true;
        stopSpring = null;
        springing = false;
        panelVelocity = 0;
        complete?.();
      },
    });
    // springValue can finish SYNCHRONOUSLY (reduced motion), before this
    // assignment — keeping its canceller then would strand `springing` on.
    if (!settled) stopSpring = stop;
  }

  function clearCloseTimer(): void {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = 0;
    }
    closing = false;
  }

  function closePanel(from: number, spring: SpringParams, velocity = 0): void {
    clearCloseTimer();
    if (prefersReducedMotion()) {
      // No vestibular travel: cross-fade out over the same 120ms instead.
      closing = true;
      closeTimer = window.setTimeout(() => {
        closing = false;
        panelMounted = false;
        panelY = 0;
      }, FADE_MS);
      return;
    }
    settle(from, panelHeight() + OFFSCREEN_GAP, spring, velocity, () => {
      panelMounted = false;
      panelY = 0;
    });
  }

  async function focusIntoPanel(): Promise<void> {
    await tick();
    if (!expanded || !panelEl) return;
    if (selected) {
      composerEl?.focus();
      return;
    }
    const first = panelEl.querySelector<HTMLButtonElement>(".dm-peer");
    if (first) first.focus();
    else panelEl.focus();
  }

  async function focusBar(): Promise<void> {
    await tick();
    barEl?.focus();
  }

  async function expand(): Promise<void> {
    if (expanded) return;
    // A toggle mid-flight retargets the SAME value rather than restarting, and
    // inherits the dying spring's velocity. Read BEFORE cancelSpring() clears it.
    const handoff = panelVelocity;
    clearCloseTimer();
    cancelSpring();
    expanded = true;
    setPref(OPEN_KEY, "1");
    const reduce = prefersReducedMotion();
    if (!panelMounted) {
      panelY = reduce ? 0 : panelHeight() + OFFSCREEN_GAP;
      panelMounted = true;
      await tick();
      if (!expanded) return;
    }
    if (reduce) panelY = 0;
    else settle(panelY, 0, TAP_SPRING, handoff);
    if (selected) void choose(selected, false);
    else void refresh();
    void focusIntoPanel();
  }

  function collapse(
    options: { from?: number; velocity?: number; spring?: SpringParams; focusBar?: boolean } = {},
  ): void {
    if (!expanded) return;
    // Same handoff as expand(), read before closePanel cancels the spring.
    const handoff = panelVelocity;
    expanded = false;
    setPref(OPEN_KEY, "0");
    generation++;
    if (selected) drafts[selected.id] = draft;
    closePanel(options.from ?? panelY, options.spring ?? TAP_SPRING, options.velocity ?? handoff);
    if (options.focusBar !== false) void focusBar();
  }

  function toggle(): void {
    if (expanded) collapse();
    else void expand();
  }

  /** Mobile bottom-sheet drag — 1:1 downward, rubberbanded upward, released
      into a spring. Mirrors Modal.svelte's sheet so both feel like one gesture. */
  function startDrag(event: PointerEvent): void {
    if (!mobileMedia?.matches) return;
    event.preventDefault();
    cancelSpring();
    dragging = true;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const height = Math.max(1, panelHeight());
    const startPointer = event.clientY;
    const startPosition = panelY;
    let position = startPosition;
    let velocity = 0;
    let lastPosition = position;
    let lastTime = event.timeStamp;

    const onMove = (move: PointerEvent) => {
      const raw = startPosition + move.clientY - startPointer;
      position = raw < 0 ? rubberband(raw, height) : raw;
      const dt = Math.max(1, move.timeStamp - lastTime) / 1000;
      velocity = velocity * 0.65 + ((position - lastPosition) / dt) * 0.35;
      lastPosition = position;
      lastTime = move.timeStamp;
      panelY = position;
    };
    const cleanup = () => {
      dragging = false;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
    };
    const onUp = () => {
      cleanup();
      // The one momentum-driven path: the finger's own velocity, underdamped.
      if (project(position, velocity) > height / 2)
        collapse({ from: position, velocity, spring: FLICK_SPRING });
      else settle(position, 0, FLICK_SPRING, velocity);
    };
    const onCancel = () => {
      cleanup();
      // A cancelled gesture released nothing, so it settles like a tap.
      settle(position, 0, TAP_SPRING);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  }

  onMount(() => {
    // Escape is bound on the dock ROOT, not window: a modal on top of the app
    // must keep its own Escape, so the dock only answers while focus is inside
    // it. Bound imperatively because a keydown handler in the markup would make
    // this non-interactive wrapper an a11y-lint violation.
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !expanded) return;
      event.stopPropagation();
      collapse();
    };
    rootEl?.addEventListener("keydown", onKeydown);
    // The bar's width follows its label and badge, so the reservation is
    // observed rather than computed once. jsdom has no real ResizeObserver
    // (tests/setup-dom.ts installs a no-op), hence the explicit first publish.
    //
    // Measured AFTER the first paint, never inside the mount task: a synchronous
    // getBoundingClientRect() here forces a layout while the @font-face subsets
    // are still unloaded, and text shaped by that early layout can stay on the
    // system fallback for good in headless Chromium — the rail's 탐색/비우기/
    // 진영 rendered as tofu in the visual baselines until this was deferred
    // (bisected with CDP CSS.getPlatformFontsForNode; docs/architecture/client.md).
    // The pill only reserves space once it is painted anyway, so nothing is lost.
    let insetObserver: ResizeObserver | null = null;
    let insetFrame = requestAnimationFrame(() => {
      insetFrame = requestAnimationFrame(() => {
        insetFrame = 0;
        publishInset();
        if (typeof ResizeObserver !== "undefined" && barEl) {
          insetObserver = new ResizeObserver(() => publishInset());
          insetObserver.observe(barEl);
        }
      });
    });
    const onResize = () => publishInset();
    window.addEventListener("resize", onResize);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      controller.abort();
      generation++;
      clearInterval(timer);
      clearCloseTimer();
      cancelSpring();
      if (insetFrame) cancelAnimationFrame(insetFrame);
      insetObserver?.disconnect();
      // The property is global: leaving it behind would pad a chat column for a
      // dock that no longer exists.
      document.documentElement.style.removeProperty(INSET_PROPERTY);
      rootEl?.removeEventListener("keydown", onKeydown);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  });
</script>

<div class="dm-dock" bind:this={rootEl} {hidden}>
  <button
    class="dm-dock-bar"
    class:gone={expanded}
    type="button"
    bind:this={barEl}
    aria-expanded={expanded}
    aria-controls="dm-dock-panel"
    on:click={toggle}
  >
    <Icon name="chat" size={16} />
    <span class="dm-dock-bar-label">{selected ? selected.displayName : "메시지"}</span>
    {#if onlineCount > 0}
      <span class="dm-dock-bar-online" title={`최근 ${inbox.windowMinutes}분 내 활동 기준`}>접속 {onlineCount}</span>
    {/if}
    {#if inbox.unread > 0}
      <span class="tag accent" aria-label={`읽지 않은 메시지 ${inbox.unread}개`}>{inbox.unread}</span>
    {/if}
    <Icon name="chevron-up" size={14} />
  </button>

  {#if panelMounted}
    <section
      id="dm-dock-panel"
      class="dm-dock-panel"
      class:closing
      class:dragging
      class:springing
      bind:this={panelEl}
      role="complementary"
      aria-label="메시지"
      tabindex="-1"
      style={`--dm-dock-y: ${panelY}px`}
    >
      <button
        class="dm-dock-grabber"
        type="button"
        aria-label="아래로 끌어 접기"
        tabindex="-1"
        on:pointerdown={startDrag}><span></span></button
      >

      <header class="dm-dock-head">
        {#if selected}
          <button class="btn ghost icon sm" type="button" aria-label="대화 목록으로" on:click={back}>
            <Icon name="chevron-left" size={16} />
          </button>
          <AvatarImage user={selected} size={24} />
          <span class="dm-dock-who">
            <strong>{selected.displayName}</strong>
            <span class="dm-dock-state">
              {#if selected.online}<span class="dm-dock-dot" aria-hidden="true"></span>{/if}
              {statusText(selected)}
            </span>
          </span>
        {:else}
          <h2>메시지</h2>
        {/if}
        <button class="btn ghost icon sm dm-dock-collapse" type="button" aria-label="접기" on:click={() => collapse()}>
          <Icon name="chevron-down" size={16} />
        </button>
      </header>

      {#if error || syncError}
        <p class="dm-dock-error" role="alert">
          <span>{error || syncError}</span>
          <button class="btn ghost sm" type="button" on:click={retry}>다시 불러오기</button>
        </p>
      {/if}

      {#if selected}
        <div
          class="dm-dock-transcript scroll-thin"
          bind:this={transcriptEl}
          role="log"
          aria-live="polite"
          aria-label="DM 메시지"
          aria-busy={loading}
        >
          {#if hasMore}
            <div class="dm-dock-older">
              <button class="btn ghost sm" type="button" disabled={olderLoading} on:click={older}>
                {olderLoading ? "불러오는 중…" : "이전 메시지"}
              </button>
            </div>
          {/if}
          {#if loading}
            <p class="muted dm-dock-empty">대화를 불러오는 중…</p>
          {:else if !messages.length}
            <p class="muted dm-dock-empty">첫 메시지를 보내 보세요.</p>
          {/if}
          {#each groupByDay(messages) as day (day.key)}
            <p class="dm-dock-day"><span>{day.label}</span></p>
            {#each day.messages as message (message.id)}
              <article class="dm-dock-bubble" class:mine={message.senderId === userId}>
                <p>{message.text}</p>
                <small>
                  {timeLabel(message.createdAt)}
                  {#if message.id === marks.lastReadId}
                    <span
                      class="dm-dock-receipt read"
                      title={message.readAt ? `${timeLabel(message.readAt)}에 읽음` : "읽음"}
                    >읽음</span>
                  {:else if marks.unreadIds.has(message.id)}
                    <span class="dm-dock-receipt">안 읽음</span>
                  {/if}
                </small>
              </article>
            {/each}
          {/each}
        </div>

        <!-- The chat composer's own building blocks, not a look-alike: one
             rounded material box that owns the focus ring, a borderless
             textarea, an icon-only accent send button. `no-attach no-stt`
             picks the two-column grid — there is no image or mic control
             here. The keyboard hint moved off the placeholder (which vanishes
             the moment you type) onto an sr-only description plus the button's
             title. -->
        <form class="dm-dock-composer" on:submit|preventDefault={send}>
          <div class="composer-box no-attach no-stt">
            <textarea
              bind:this={composerEl}
              bind:value={draft}
              use:autosize={draft}
              aria-label="DM 메시지 입력"
              aria-describedby="dm-dock-composer-hint"
              placeholder={selected.available
                ? `${selected.displayName}에게 메시지…`
                : "이용 정지된 사용자에게 보낼 수 없습니다"}
              maxlength={4000}
              rows="1"
              disabled={!selected.available}
              on:keydown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            ></textarea>
            <button
              class="send-button"
              type="submit"
              aria-label={sending ? "전송 중" : "보내기"}
              title="보내기 (Enter) · 줄바꿈 (Shift+Enter)"
              disabled={sending || !draft.trim() || !selected.available}
            >
              <Icon name="send" />
            </button>
          </div>
          <span id="dm-dock-composer-hint" class="sr-only">Enter로 보내고 Shift+Enter로 줄을 바꿉니다.</span>
        </form>
      {:else}
        <div class="dm-dock-peers scroll-thin">
          {#if !inbox.peers.length}
            <p class="muted dm-dock-empty">지금 접속한 사용자와 이전 대화가 없습니다.</p>
          {/if}
          {#each inbox.peers as peer (peer.id)}
            <button class="dm-peer" type="button" on:click={() => choose(peer)}>
              <span class="dm-peer-face">
                <AvatarImage user={peer} size={32} />
                {#if peer.online}<span class="dm-dock-dot dm-peer-dot" aria-hidden="true"></span>{/if}
              </span>
              <span class="dm-peer-name">
                <strong>{peer.displayName}</strong>
                <small>@{peer.username}</small>
              </span>
              {#if peer.unread > 0}
                <span class="tag accent" aria-label={`읽지 않은 메시지 ${peer.unread}개`}>{peer.unread}</span>
              {:else}
                <span class="dm-peer-status">{statusText(peer)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  /* Zero-size anchor pinned to the viewport corner: the bar sits in its flow and
     the panel hangs off it, so no layout has to make room for the dock — with
     ONE exception, the chat composer's hint row, whose right-aligned status
     controls live in this same corner. That one reserves space through the
     `--dm-dock-inset` property published above (see `.composer-hint` in
     30-agent-md-composer.css); it is the only consumer. */
  .dm-dock {
    position: fixed;
    right: var(--s-4);
    bottom: calc(var(--s-4) + env(safe-area-inset-bottom, 0px));
    z-index: var(--z-popover);
    display: flex;
  }

  /* An author `display` beats the UA rule for the `hidden` attribute, so the
     attribute alone would do nothing here — same explicit opt-out the composer
     panels carry. */
  .dm-dock[hidden] {
    display: none;
  }

  .dm-dock-bar {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    max-width: calc(100vw - 2 * var(--s-4));
    height: 40px;
    padding-inline: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    background: var(--material-regular);
    -webkit-backdrop-filter: saturate(180%) blur(var(--material-blur));
    backdrop-filter: saturate(180%) blur(var(--material-blur));
    box-shadow: var(--shadow-md);
    color: var(--text);
    font-size: var(--t-sm);
    font-weight: 600;
    transition: opacity 120ms var(--ease-out);
  }

  /* Expanded: the panel header owns the collapse control, so the bar cross-fades
     out. `visibility` (not just opacity) keeps it out of tab order and the a11y
     tree; it flips back instantly on the way in so focus can return to it. */
  .dm-dock-bar.gone {
    opacity: 0;
    visibility: hidden;
    transition: opacity 120ms var(--ease-out), visibility 0s 120ms;
  }

  .dm-dock-bar-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dm-dock-bar-online {
    color: var(--muted);
    font-size: var(--t-2xs);
    font-weight: 400;
    white-space: nowrap;
  }

  .dm-dock-panel {
    position: absolute;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    width: 360px;
    height: min(520px, 70dvh);
    border: 1px solid var(--material-edge);
    border-radius: var(--r-xl);
    /* The thickest material plus its own blur — the same treatment .modal-card
       gets, because this is the same role: a floating window over arbitrary
       content. `--panel` looks opaque in 00-tokens but the Apple layer
       redefines it to 0.88 alpha, so using it WITHOUT a backdrop-filter
       (as a first pass here did) let the page read straight through a
       transcript. Verified in a browser, not just in svelte-check. */
    background: var(--material-thick);
    box-shadow: var(--shadow-lg);
    -webkit-backdrop-filter: saturate(180%) blur(var(--material-blur-thick));
    backdrop-filter: saturate(180%) blur(var(--material-blur-thick));
    overflow: hidden;
    transform: translate3d(0, var(--dm-dock-y, 0px), 0);
  }

  /* The transform is JS-driven on both of these, so promote the layer for the
     duration and hand it back at rest — same deal as `.rail.rail-springing`. */
  .dm-dock-panel.dragging,
  .dm-dock-panel.springing {
    will-change: transform;
  }

  .dm-dock-panel:not(.dragging) {
    /* The spring drives the transform frame by frame; a CSS transition on top
       would fight it. Only the fade-out path animates in CSS. */
    transition: opacity 120ms var(--ease-out);
  }

  .dm-dock-panel.closing {
    opacity: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .dm-dock-panel {
      animation: dm-dock-appear 120ms var(--ease-out);
    }
  }

  @keyframes dm-dock-appear {
    from {
      opacity: 0;
    }
  }

  /* Drag handle: mobile only, mirroring .modal-sheet-grabber. */
  .dm-dock-grabber {
    display: none;
  }

  .dm-dock-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex: none;
    padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line-soft);
    /* A tint over the panel's material, NOT a second blur: stacked glass is
       exactly what DESIGN §1 rules out, and the panel below already blurs. */
    background: var(--material-regular);
  }

  .dm-dock-head h2 {
    margin: 0;
    font-size: var(--t-md);
    font-weight: 700;
  }

  .dm-dock-who {
    display: grid;
    min-width: 0;
    line-height: 1.25;
  }

  .dm-dock-who strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-sm);
  }

  .dm-dock-state {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    color: var(--muted);
    font-size: var(--t-2xs);
  }

  /* Functional size: an online marker reads as a dot, not a chip. */
  .dm-dock-dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: var(--ok);
  }

  .dm-dock-collapse {
    margin-left: auto;
  }

  .dm-dock-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    flex: none;
    margin: 0;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line-soft);
    background: var(--danger-soft);
    color: var(--danger);
    font-size: var(--t-2xs);
  }

  .dm-dock-error span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dm-dock-peers {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--s-2);
  }

  .dm-peer {
    display: flex;
    align-items: center;
    gap: var(--s-2-5);
    width: 100%;
    padding: var(--s-2);
    border: 0;
    border-radius: var(--r-md);
    background: transparent;
    text-align: left;
  }

  .dm-peer:hover {
    background: var(--surface-2);
  }

  .dm-peer-face {
    position: relative;
    flex: none;
    display: inline-flex;
  }

  /* Ring in the panel's own colour so the dot separates from the avatar edge —
     a border, not a shadow (DESIGN §2.5 bans inline box-shadow values). */
  .dm-peer-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    box-sizing: content-box;
    border: 2px solid var(--panel);
  }

  .dm-peer-name {
    display: grid;
    min-width: 0;
    flex: 1;
    line-height: 1.25;
  }

  .dm-peer-name strong,
  .dm-peer-name small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dm-peer-name strong {
    font-size: var(--t-sm);
  }

  .dm-peer-name small {
    color: var(--muted);
    font-size: var(--t-2xs);
  }

  .dm-peer-status {
    flex: none;
    color: var(--muted);
    font-size: var(--t-2xs);
  }

  .dm-dock-transcript {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
    overflow-y: auto;
    padding: var(--s-3);
  }

  .dm-dock-empty {
    margin: 0;
    font-size: var(--t-xs);
  }

  .dm-dock-older {
    display: flex;
    justify-content: center;
    flex: none;
  }

  /* Day separator: a centred muted chip on a hairline. */
  .dm-dock-day {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex: none;
    margin: var(--s-1) 0 0;
    color: var(--muted);
    font-size: var(--t-2xs);
  }

  .dm-dock-day::before,
  .dm-dock-day::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--line-soft);
  }

  .dm-dock-bubble {
    flex: none;
    align-self: flex-start;
    max-width: 82%;
    padding: var(--s-2) var(--s-2-5);
    border-radius: var(--r-md);
    background: var(--surface-2);
  }

  .dm-dock-bubble.mine {
    align-self: flex-end;
    border: 1px solid var(--line);
  }

  .dm-dock-bubble p {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .dm-dock-bubble small {
    display: block;
    margin-top: var(--s-0-5);
    color: var(--muted);
    font-size: var(--t-2xs);
    text-align: right;
  }

  /* Read receipt. Only the BOUNDARY bubble is labelled — the newest message the
     other person has opened, plus the unread tail after it — so a long thread of
     my own messages carries two marks, not one per bubble. The middle dot is CSS
     so the label stays the element's whole text (a locator, and a screen reader,
     read "읽음", not "· 읽음"). */
  .dm-dock-receipt::before {
    content: "·";
    margin: 0 var(--s-1);
  }

  .dm-dock-receipt.read {
    color: var(--text-soft);
  }

  /* A plain strip — `.composer-box` inside is the control, and it brings its
     own border, material, radius and focus ring from the composer layer.
     `flex: none` so the panel's flex column never squeezes the composer to
     buy the transcript room. */
  .dm-dock-composer {
    flex: none;
    padding: var(--s-2-5);
    border-top: 1px solid var(--line-soft);
  }

  /* Everything else (borderless, transparent, padded, 1.5 line-height) comes
     from the shared `.composer-box textarea` reset. The dock only overrides
     what its smaller window needs. */
  .dm-dock-composer textarea {
    max-height: 120px;
    font-size: var(--t-sm);
  }

  /* The tokens above already swap to opaque surfaces here; the blur is the one
     thing this component has to withdraw itself. */
  @media (prefers-reduced-transparency: reduce) {
    .dm-dock-bar,
    .dm-dock-panel {
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  /* Increased contrast: the material tokens already go opaque here, so what is
     left for the component to withdraw is the blur — plus a full-strength
     border, since a hairline over a sharp surface is the edge that carries the
     window's shape. */
  @media (prefers-contrast: more) {
    .dm-dock-bar,
    .dm-dock-panel {
      border-color: var(--line);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }

  @media (max-width: 640px) {
    /* Bottom sheet: full width, dragged by the grabber. The bar stays a pill. */
    .dm-dock-panel {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      height: 75dvh;
      border-width: 1px 0 0;
      border-radius: var(--r-xl) var(--r-xl) 0 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }

    .dm-dock-grabber {
      display: grid;
      place-items: center;
      flex: none;
      width: 100%;
      height: 28px;
      padding: 0;
      border: 0;
      background: transparent;
      touch-action: none;
      cursor: grab;
    }

    .dm-dock-grabber:active {
      cursor: grabbing;
      transform: none;
    }

    .dm-dock-grabber span {
      width: 36px;
      height: 5px;
      border-radius: var(--r-pill);
      background: color-mix(in srgb, var(--muted) 36%, transparent);
    }
  }
</style>
