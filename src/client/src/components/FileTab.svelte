<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { copyText } from "../lib/dom";
  import { formatFileSize } from "../lib/format";
  import { getGraphViewer, isDrawioAttachment, loadGraphViewer } from "../lib/drawioViewer";
  import { isPptxCard } from "../../../shared/shareLinks";
  import type { ChatPane, MessageAttachment, PaneFileTab } from "../lib/types";

  // ONE shared file opened as a tab of the side panel (SidePanel): a file-card
  // click opens it, and a live .drawio share opens itself once. Slides are the
  // hidden image attachments on the SAME assistant message (server-auto-rendered
  // on share_file, or skill-published); .drawio files render as an interactive
  // diagram via the vendored viewer (lib/drawioViewer); other formats without
  // slides still get the card with the download. The instance stays mounted
  // while another tab shows, so a diagram is fetched and laid out once.
  export let pane: ChatPane;
  export let file: PaneFileTab;
  /** This tab is the one the panel shows. */
  export let active = false;
  /**
   * 공유 링크 hands the card to ChatView, whose ONE dialog serves both entry
   * points. The dialog must not live in this tab: closing the tab (or the
   * panel losing its last tab) unmounts it, and the unmount would take an open
   * dialog with it — mid-create too, leaving a new link whose URL is never shown.
   */
  export let onShare: (attachment: MessageAttachment) => void = () => {};

  $: attachment = file.attachment;
  $: slides = file.slides ?? [];
  $: name = attachment.name || "파일";
  // 공유 링크: PPTX decks only, and never from a group agent's thread (member
  // threads are private; the group shares through its second brain).
  $: shareable = isPptxCard(attachment) && !pane.avatar.groupAgent && !pane.avatar.id.startsWith("group:");
  // A card still streaming has no persisted message the server can find yet.
  $: shareLive = Boolean(pane.streaming && (pane.liveAttachments ?? []).some((att) => att.id === attachment.id));

  function share(): void {
    onShare(attachment);
  }

  /* ---- draw.io diagram rendering (interactive, client-side) ---- */
  let bodyEl: HTMLDivElement | undefined;
  let drawioHost: HTMLDivElement | undefined;
  let drawioStatus: "loading" | "ready" | "error" = "loading";
  let drawioXml = "";
  let drawioFor = ""; // attachment id the fetched XML belongs to
  let drawioToken = 0; // guards async fetch/load against a newer open (canvas pattern)
  let paintedWidth = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;
  let observer: ResizeObserver | null = null;

  $: drawioAtt = isDrawioAttachment(attachment) ? attachment : null;
  $: if (drawioAtt && drawioAtt.id !== drawioFor) void openDrawio(drawioAtt);
  // Shown again: lay the diagram out if the width it was drawn for changed
  // while the tab was hidden (or it was never drawn — opened in the background).
  $: if (active) void tick().then(paintIfStale);

  // Above this the tab would freeze on res.text() + a synchronous render; the
  // card falls back to the download-only error copy instead (server cap is 30 MB).
  const DRAWIO_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

  async function openDrawio(att: MessageAttachment): Promise<void> {
    const token = ++drawioToken;
    drawioFor = att.id;
    drawioStatus = "loading";
    drawioXml = "";
    paintedWidth = 0;
    if (drawioHost) drawioHost.innerHTML = "";
    if ((att.size ?? 0) > DRAWIO_MAX_PREVIEW_BYTES) {
      drawioStatus = "error";
      return;
    }
    try {
      const fileHref = `/api/conversations/${encodeURIComponent(pane.conversationId)}/files/${encodeURIComponent(att.id)}`;
      const [, res] = await Promise.all([loadGraphViewer(), fetch(fileHref, { credentials: "same-origin" })]);
      if (!res.ok) throw new Error(`file fetch failed: ${res.status}`);
      const xml = await res.text();
      if (token !== drawioToken) return;
      if (!/<mx(?:GraphModel|file)[\s>]/.test(xml)) throw new Error("not an mxfile");
      drawioXml = xml;
      drawioStatus = "ready";
      await tick(); // let the host div mount before painting into it
      paintIfStale();
    } catch {
      if (token === drawioToken) drawioStatus = "error";
    }
  }

  // The viewer lays out for the width it was created at, so it paints only
  // into a body that has one: a hidden tab or a collapsed panel measures 0, and
  // the observer paints once the body shows.
  function paintIfStale(): void {
    if (!active || drawioStatus !== "ready" || !bodyEl) return;
    const width = bodyEl.clientWidth;
    if (width <= 0 || Math.abs(width - paintedWidth) <= 1) return;
    paintDrawio(width);
  }

  function paintDrawio(width: number): void {
    // Every paint cancels a pending repaint, or a resize settling right after
    // the first open would paint twice, 200ms apart.
    clearTimeout(repaintTimer);
    const viewer = getGraphViewer();
    if (!viewer || !drawioHost || !drawioXml) return;
    drawioHost.innerHTML = "";
    const target = document.createElement("div");
    // No `mxgraph` class on purpose: the script's load-time auto-processing
    // must not race our explicit createViewerForElement call.
    target.setAttribute(
      "data-mxgraph",
      JSON.stringify({ xml: drawioXml, nav: true, toolbar: "pages zoom layers", "toolbar-nohide": true }),
    );
    drawioHost.append(target);
    paintedWidth = width;
    try {
      viewer.createViewerForElement(target);
    } catch {
      drawioStatus = "error";
    }
  }

  // Debounced so a drag gesture (or a window resize) repaints once at settle:
  // GraphViewer has no destroy(), so each paint strands one matchMedia
  // listener — bounded to one per gesture, not one per resize tick. The very
  // first paint of a tab that just became visible needs no wait.
  function onBodyResize(): void {
    if (drawioStatus !== "ready") return;
    if (!paintedWidth) {
      paintIfStale();
      return;
    }
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(paintIfStale, 200);
  }

  onMount(() => {
    if (!bodyEl) return;
    observer = new ResizeObserver(onBodyResize);
    observer.observe(bodyEl);
  });

  onDestroy(() => {
    drawioToken += 1;
    clearTimeout(repaintTimer);
    observer?.disconnect();
  });

  // Both take the conversation as an argument: read inside the helper it would
  // be untracked by the template (legacy-mode dependencies are compile-time).
  function slideSrc(conversationId: string, att: MessageAttachment): string {
    return `/api/conversations/${encodeURIComponent(conversationId)}/images/${encodeURIComponent(att.id)}`;
  }

  function downloadHref(conversationId: string, att: MessageAttachment): string {
    const base = `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(att.id)}`;
    return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
  }
</script>

<div class="canvas-card file-tab">
  <div class="canvas-card-top">
    <div class="file-tab-title">
      <div class="canvas-title" title={name}>{name}</div>
      {#if formatFileSize(attachment.size)}
        <span class="muted file-tab-size">{formatFileSize(attachment.size)}</span>
      {/if}
    </div>
    <div class="canvas-toolbar">
      {#if drawioAtt}
        <button
          class="canvas-tool-btn"
          type="button"
          aria-label="XML 텍스트 복사"
          title="다이어그램 XML을 텍스트로 복사"
          disabled={drawioStatus !== "ready"}
          on:click={(event) => copyText(drawioXml, event.currentTarget as HTMLButtonElement)}
        >복사</button>
      {/if}
      {#if shareable}
        <button
          class="canvas-tool-btn"
          type="button"
          disabled={shareLive}
          title={shareLive ? "응답이 끝난 뒤 만들 수 있습니다." : undefined}
          on:click={share}
        >공유 링크</button>
      {/if}
      <!-- draggable=false: a link styled as a button must not start a native
           link-drag when the pointer moves during the press. -->
      <a
        class="canvas-tool-btn"
        href={downloadHref(pane.conversationId, attachment)}
        download={attachment.name || undefined}
        draggable="false"
      >다운로드</a>
    </div>
  </div>
  <div class="canvas-content file-tab-body" bind:this={bodyEl}>
    {#if drawioAtt}
      {#if drawioStatus === "error"}
        <p class="muted">다이어그램을 표시할 수 없습니다. 다운로드해서 draw.io에서 열어 주세요.</p>
      {:else}
        {#if drawioStatus === "loading"}
          <p class="muted">다이어그램을 불러오는 중…</p>
        {/if}
        <div class="file-preview-drawio" bind:this={drawioHost}></div>
      {/if}
    {:else if slides.length}
      {#each slides as slide, index (slide.id)}
        <figure class="file-preview-slide">
          <img src={slideSrc(pane.conversationId, slide)} alt={slide.name || `슬라이드 ${index + 1}`} loading="lazy" />
          <!-- A page counter under a single image (screenshot, one-page pdf) is noise. -->
          {#if slides.length > 1}
            <figcaption class="muted">슬라이드 {index + 1} / {slides.length}</figcaption>
          {/if}
        </figure>
      {/each}
    {:else}
      <p class="muted">이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.</p>
    {/if}
  </div>
</div>
