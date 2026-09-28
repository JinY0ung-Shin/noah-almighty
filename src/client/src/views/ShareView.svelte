<script lang="ts">
  import { onDestroy } from "svelte";
  import SlidePresenter from "../components/SlidePresenter.svelte";
  import { goView } from "../lib/nav";
  import { appState, readState, updateState } from "../lib/state";
  import { openShareLink, shareOwnerLine, shareTicketsStale, type ShareOpenResult } from "../lib/shareLinks";
  import { SHARE_LINK_GONE_MESSAGE } from "../../../shared/shareLinks";
  import type { ShareViewPayload } from "../lib/types";

  // The recipient's viewer for a PPTX share link (#/share/<token>). Any
  // signed-in user may open a valid link; it grants reading ONE deck — its
  // renders and the .pptx — and nothing else. Every payload string is the deck
  // author's (file name, slide titles), so it is rendered as plain text only.

  type Phase = "loading" | "ready" | "gone" | "error";

  let phase: Phase = "loading";
  let payload: ShareViewPayload | null = null;
  let errorMessage = "";
  let refreshError = "";
  let refreshing = false;
  let loadedFor: string | null = null;
  let loadSeq = 0;
  let loadedAt = 0;
  /** Position the presenter starts on; null = present mode closed. */
  let presentFrom: number | null = null;
  /** List renders that failed to load, by URL (fresh tickets change every URL). */
  let failedSlides: Record<string, boolean> = {};

  // The token is read from the store IN this statement, not inside a helper
  // (legacy-mode dependencies are compile-time): a second link opened while the
  // view is mounted changes only state.shareToken, and must refetch.
  $: token = $appState.shareToken;
  $: if (token !== loadedFor) void load(token);

  function setShareTitle(title: string): void {
    if (readState().shareTitle !== title) updateState((state) => (state.shareTitle = title));
  }

  async function load(target: string): Promise<void> {
    const seq = ++loadSeq;
    loadedFor = target;
    phase = "loading";
    payload = null;
    presentFrom = null;
    failedSlides = {};
    errorMessage = "";
    refreshError = "";
    setShareTitle("");
    const result = await openShareLink(target);
    if (seq !== loadSeq) return;
    if (result.status === "ok") show(result);
    else if (result.status === "gone") phase = "gone";
    else {
      errorMessage = result.message;
      phase = "error";
    }
  }

  function show(result: Extract<ShareOpenResult, { status: "ok" }>): void {
    payload = result.payload;
    loadedAt = Date.now();
    failedSlides = {};
    phase = "ready";
    setShareTitle(result.payload.fileName);
  }

  /**
   * Re-open the link for fresh viewer tickets (they last 30 minutes), keeping
   * what is on screen. A link revoked meanwhile turns into the dead-link state.
   */
  async function refreshTickets(): Promise<boolean> {
    if (loadedFor === null || refreshing) return false;
    const seq = ++loadSeq;
    refreshing = true;
    refreshError = "";
    // Not another view: the same open page renewing its tickets.
    const result = await openShareLink(loadedFor, { refresh: true });
    refreshing = false;
    if (seq !== loadSeq) return false;
    if (result.status === "ok") {
      show(result);
      return true;
    }
    if (result.status === "gone") {
      payload = null;
      presentFrom = null;
      phase = "gone";
      setShareTitle("");
    } else {
      refreshError = result.message;
    }
    return false;
  }

  async function present(position: number): Promise<void> {
    if (!payload?.slides.length) return;
    if (shareTicketsStale(loadedAt)) await refreshTickets();
    if (phase === "ready" && payload?.slides.length) presentFrom = Math.min(position, payload.slides.length - 1);
  }

  // The link's own href works while its ticket is fresh; a viewer left open
  // longer fetches a fresh ticket first and then starts the same download.
  async function download(event: MouseEvent): Promise<void> {
    if (!payload?.downloadUrl || !shareTicketsStale(loadedAt)) return;
    event.preventDefault();
    if (!(await refreshTickets()) || !payload?.downloadUrl) return;
    const anchor = document.createElement("a");
    anchor.href = payload.downloadUrl;
    anchor.download = payload.fileName;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function markFailed(url: string): void {
    failedSlides = { ...failedSlides, [url]: true };
  }

  onDestroy(() => {
    // Drop any answer still in flight: it belongs to a view that is gone.
    loadSeq += 1;
  });
</script>

<header class="view-header">
  <div class="title">
    <h1>{payload ? payload.fileName : "공유된 PPT"}</h1>
    <!-- Not a <p>: narrow layouts hide `.view-header .title p`, and who shared
         the deck is the recipient's only provenance signal. -->
    {#if payload}<span class="share-meta">{shareOwnerLine(payload)}</span>{/if}
  </div>
  {#if payload}
    <div class="share-actions">
      {#if payload.slides.length}
        <button class="btn" type="button" on:click={() => void present(0)}>발표 모드</button>
      {/if}
      {#if payload.downloadUrl}
        <!-- draggable=false: a link styled as a button must not start a native
             link-drag when the pointer moves during the press. -->
        <a
          class="btn primary"
          href={payload.downloadUrl}
          download={payload.fileName}
          draggable="false"
          on:click={download}
        >다운로드</a>
      {/if}
    </div>
  {/if}
</header>

<div class="view-body scroll-thin share-body">
  {#if phase === "loading"}
    <p class="muted" role="status">공유 자료를 불러오는 중…</p>
  {:else if phase === "gone"}
    <div class="card share-state">
      <strong>{SHARE_LINK_GONE_MESSAGE}</strong>
      <p class="muted">링크를 보낸 분께 새 링크를 요청해 주세요.</p>
      <button class="btn primary" type="button" on:click={() => goView("explore")}>탐색으로 이동</button>
    </div>
  {:else if phase === "error"}
    <div class="card share-state" role="alert">
      <strong>공유 자료를 불러오지 못했습니다.</strong>
      {#if errorMessage}<p class="muted">{errorMessage}</p>{/if}
      <button class="btn primary" type="button" on:click={() => void load(token)}>다시 시도</button>
    </div>
  {:else if payload}
    {#if refreshError}
      <div class="warn-box share-note" role="alert">{refreshError}</div>
    {/if}
    {#if payload.slides.length}
      {#if payload.previewCapped}
        <p class="muted share-note">미리보기는 최대 30장까지 표시됩니다. 전체 슬라이드는 파일을 내려받아 확인해 주세요.</p>
      {/if}
      <ol class="share-slides" aria-label="슬라이드">
        {#each payload.slides as slide, position}
          <li>
            <figure class="file-preview-slide">
              {#if failedSlides[slide.url]}
                <div class="share-slide-error" role="alert">
                  <span>슬라이드를 불러오지 못했습니다</span>
                  <span aria-hidden="true">·</span>
                  <button class="linkish" type="button" disabled={refreshing} on:click={() => void refreshTickets()}>다시 시도</button>
                </div>
              {:else}
                <button
                  class="share-slide-open"
                  type="button"
                  aria-label={`${slide.alt} — 이 슬라이드부터 발표`}
                  on:click={() => void present(position)}
                >
                  <img src={slide.url} alt={slide.alt} loading="lazy" on:error={() => markFailed(slide.url)} />
                </button>
              {/if}
              <figcaption class="muted">슬라이드 {slide.index} / {payload.slides.length}</figcaption>
            </figure>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="empty-note share-empty">미리보기가 없습니다. 파일을 내려받아 확인해 주세요.</p>
    {/if}
  {/if}
</div>

{#if presentFrom !== null && payload}
  <SlidePresenter
    slides={payload.slides}
    start={presentFrom}
    title={payload.fileName}
    on:close={() => (presentFrom = null)}
    on:retry={() => void refreshTickets()}
  />
{/if}

<style>
  .share-meta {
    display: block;
    margin-top: var(--s-0-5);
    color: var(--muted);
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }
  .share-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--s-2);
  }
  /* A 16:9 render reads best at a comfortable column width, not stretched
     across an ultra-wide window. */
  .share-slides,
  .share-note,
  .share-empty {
    max-width: 960px;
    margin-inline: auto;
  }
  .share-note {
    margin-block: 0 var(--s-4);
  }
  .share-slides {
    display: grid;
    gap: var(--s-5);
    margin-block: 0;
    padding: 0;
    list-style: none;
  }
  .share-slide-open {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: var(--r-md);
    background: none;
    cursor: zoom-in;
  }
  .share-slide-error {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: var(--s-2);
    aspect-ratio: 16 / 9;
    border: 1px dashed var(--line);
    border-radius: var(--r-md);
    color: var(--muted);
    font-size: var(--t-sm);
  }
  .share-state {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
    max-width: 460px;
    margin: var(--s-6) auto 0;
    text-align: center;
  }
  .share-state p {
    margin: 0;
  }
</style>
