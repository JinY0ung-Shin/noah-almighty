<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { inertOutside, trapTab } from "../lib/modalBehavior";
  import type { ShareViewSlide } from "../lib/types";

  // 발표 모드 for a shared deck: one slide fitted to the screen. It asks for real
  // fullscreen and falls back to a fixed overlay where the Fullscreen API is
  // missing or the request is refused — the overlay IS the fullscreen element,
  // so both paths share one set of controls. Keys, a visible bar and left/right
  // tap zones all turn the page: a touch user has neither arrow keys nor Esc,
  // so every action also has an on-screen control (DESIGN §4.4: fullscreen
  // viewers carry an explicit close).
  export let slides: ShareViewSlide[] = [];
  /** Position (0-based) to start on — the slide clicked in the list. */
  export let start = 0;
  export let title = "";

  const dispatch = createEventDispatcher<{ close: void; retry: void }>();

  let rootEl: HTMLDivElement;
  let stageEl: HTMLDivElement;
  let position = Math.max(0, Math.min(start, slides.length - 1));
  // The render that failed, by URL: fresh tickets from the view change every
  // URL, which clears the error without any bookkeeping.
  let failedUrl = "";
  let attempt = 0;
  let wasFullscreen = false;
  let closed = false;

  $: count = slides.length;
  $: if (count > 0 && position > count - 1) position = count - 1;
  $: current = slides[position] ?? null;
  $: failed = Boolean(current && failedUrl === current.url);
  $: preload(slides[position + 1]?.url);

  // Warm the cache for the next slide so turning the page never waits on it.
  function preload(url: string | undefined): void {
    if (!url || typeof Image === "undefined") return;
    const img = new Image();
    img.src = url;
  }

  async function go(next: number, focusStage = false): Promise<void> {
    if (!count) return;
    position = Math.max(0, Math.min(count - 1, next));
    await tick();
    // A tap zone hands focus back to the stage so Space/Enter keep turning
    // pages; so does an end of the deck, where the 이전/다음 button just pressed
    // turns disabled and would drop focus to <body>.
    const active = document.activeElement as HTMLButtonElement | null;
    if (focusStage || !rootEl?.contains(active) || active?.disabled) stageEl?.focus({ preventScroll: true });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (document.fullscreenElement) leaveFullscreen();
    dispatch("close");
  }

  function leaveFullscreen(): void {
    try {
      void document.exitFullscreen?.()?.catch(() => {});
    } catch {
      /* already leaving */
    }
  }

  function retry(): void {
    failedUrl = "";
    attempt += 1;
    // The usual cause is an expired viewer ticket: ask the view for fresh URLs.
    dispatch("retry");
  }

  function onFullscreenChange(): void {
    if (document.fullscreenElement === rootEl) {
      wasFullscreen = true;
    } else if (wasFullscreen && !document.fullscreenElement) {
      // Esc in element fullscreen is consumed by the browser — no keydown
      // reaches the page. Leaving fullscreen by ANY route ends present mode, or
      // the overlay would stay behind and need a second Esc.
      close();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "Tab":
        trapTab(event, rootEl);
        return;
      case "ArrowRight":
      case "PageDown":
        event.preventDefault();
        void go(position + 1);
        return;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        void go(position - 1);
        return;
      case "Home":
        event.preventDefault();
        void go(0);
        return;
      case "End":
        event.preventDefault();
        void go(count - 1);
        return;
      case " ":
      case "Enter":
        // A focused bar button activates itself; only the stage turns the page.
        if (event.target instanceof Element && event.target.closest("button, a, input")) return;
        event.preventDefault();
        void go(position + 1);
    }
  }

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const restoreInert = inertOutside(rootEl);
    // Focus the STAGE, never 닫기: a presenter's first Space or Enter must turn
    // the page, not end present mode.
    stageEl.focus({ preventScroll: true });
    document.addEventListener("fullscreenchange", onFullscreenChange);
    if (typeof rootEl.requestFullscreen === "function") {
      // Refused (the click's user activation ran out, a policy): the fixed
      // overlay already covers the page, so there is nothing to undo.
      try {
        void rootEl.requestFullscreen()?.catch(() => {});
      } catch {
        /* the overlay stays */
      }
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement === rootEl) leaveFullscreen();
      restoreInert();
      previous?.focus?.({ preventScroll: true });
    };
  });
</script>

<svelte:window on:keydown={onKeydown} />

<div bind:this={rootEl} class="slide-presenter" role="dialog" aria-modal="true" aria-label={`발표 모드: ${title}`}>
  <div
    bind:this={stageEl}
    class="slide-presenter-stage"
    role="group"
    aria-label={current ? current.alt : "슬라이드"}
    tabindex="-1"
  >
    {#if current}
      {#if failed}
        <p class="slide-presenter-error" role="alert">
          <span>슬라이드를 불러오지 못했습니다</span>
          <span aria-hidden="true">·</span>
          <button class="btn sm" type="button" on:click={retry}>다시 시도</button>
        </p>
      {:else}
        {#key `${current.url}#${attempt}`}
          <img
            class="slide-presenter-image"
            src={current.url}
            alt={current.alt}
            on:error={(event) => (failedUrl = event.currentTarget.getAttribute("src") ?? "")}
          />
        {/key}
      {/if}
    {/if}
    <!-- Tap zones: the bar carries the same actions for keyboards and screen
         readers, so the zones stay out of the tab order. -->
    <button
      class="slide-presenter-zone prev"
      type="button"
      tabindex="-1"
      aria-label="이전 슬라이드"
      disabled={position === 0}
      on:click={() => void go(position - 1, true)}
    ></button>
    <button
      class="slide-presenter-zone next"
      type="button"
      tabindex="-1"
      aria-label="다음 슬라이드"
      disabled={position >= count - 1}
      on:click={() => void go(position + 1, true)}
    ></button>
  </div>
  <div class="slide-presenter-bar">
    <span class="slide-presenter-title">{title}</span>
    <div class="slide-presenter-controls">
      <button class="btn sm" type="button" disabled={position === 0} on:click={() => void go(position - 1)}>이전</button>
      <span class="slide-presenter-count" role="status" aria-live="polite" aria-atomic="true">
        <span class="sr-only">슬라이드</span>
        {count ? position + 1 : 0} / {count}
      </span>
      <button class="btn sm" type="button" disabled={position >= count - 1} on:click={() => void go(position + 1)}>다음</button>
      <button class="btn sm" type="button" on:click={close}>닫기</button>
    </div>
  </div>
</div>

<style>
  .slide-presenter {
    position: fixed;
    inset: 0;
    z-index: var(--z-modal);
    display: flex;
    flex-direction: column;
    background: var(--bg);
    animation: slide-presenter-in 180ms var(--ease-out);
  }
  .slide-presenter-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--s-4);
  }
  /* The box fills the stage and the render is contained inside it: one slide
     fitted at any window shape, no layout maths. */
  .slide-presenter-image {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
  }
  .slide-presenter-zone {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 1;
    width: 50%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: pointer;
  }
  .slide-presenter-zone:active {
    transform: none;
  }
  .slide-presenter-zone:disabled {
    cursor: default;
    opacity: 1;
  }
  .slide-presenter-zone.prev {
    left: 0;
  }
  .slide-presenter-zone.next {
    right: 0;
  }
  .slide-presenter-error {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    justify-content: center;
    margin: 0;
    padding: var(--s-3) var(--s-4);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    color: var(--text);
    font-size: var(--t-sm);
  }
  .slide-presenter-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: var(--s-2) var(--s-4);
    padding-bottom: calc(var(--s-2) + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  .slide-presenter-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-sm);
    font-weight: 600;
  }
  .slide-presenter-controls {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--s-2);
    margin-left: auto;
  }
  .slide-presenter-count {
    min-width: 4.5em;
    text-align: center;
    color: var(--muted);
    font-size: var(--t-sm);
    font-variant-numeric: tabular-nums;
  }
  @media (pointer: coarse) {
    .slide-presenter-controls .btn {
      min-width: 44px;
      min-height: 44px;
    }
  }
  @media (max-width: 640px) {
    .slide-presenter-title {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .slide-presenter {
      animation: none;
    }
  }
  @keyframes slide-presenter-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
