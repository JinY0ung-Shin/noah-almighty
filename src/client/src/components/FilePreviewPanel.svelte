<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { updateState } from "../lib/state";
  import { copyText } from "../lib/dom";
  import { formatFileSize } from "../lib/format";
  import { getGraphViewer, isDrawioAttachment, loadGraphViewer } from "../lib/drawioViewer";
  import { isPptxCard } from "../../../shared/shareLinks";
  import type { ChatPane, MessageAttachment } from "../lib/types";

  // Right-side preview for a shared file attachment (msg-file-card click;
  // .drawio shares also auto-open it on live arrival — chat.ts "file" event).
  // Slides are the hidden image attachments on the SAME assistant message
  // (server-auto-rendered on share_file, or skill-published); .drawio files
  // render as an interactive diagram via the vendored viewer (lib/drawioViewer);
  // other formats without slides still get the panel with the download button.
  // Reuses the .canvas-panel frame classes + the same resize interaction so it
  // behaves exactly like the visual canvas in the same slot.
  export let pane: ChatPane;
  /**
   * 공유 링크 hands the card to ChatView, whose ONE dialog serves both entry
   * points. The dialog must not live in this panel: a canvas that asks for
   * input clears the preview (chat.ts handleCanvas), and the unmount would
   * take an open dialog with it — mid-create too, leaving a new link whose
   * URL is never shown.
   */
  export let onShare: (attachment: MessageAttachment) => void = () => {};

  $: preview = pane.filePreview ?? null;
  $: slides = preview?.slides ?? [];
  // 공유 링크: PPTX decks only, and never from a group agent's thread (member
  // threads are private; the group shares through its second brain).
  $: shareable = Boolean(preview && isPptxCard(preview.attachment) && !pane.avatar.groupAgent && !pane.avatar.id.startsWith("group:"));
  // A card still streaming has no persisted message the server can find yet.
  $: previewId = preview?.attachment.id ?? "";
  $: shareLive = Boolean(previewId && pane.streaming && (pane.liveAttachments ?? []).some((att) => att.id === previewId));

  function share(): void {
    if (preview) onShare(preview.attachment);
  }

  const WIDTH_MIN = 300;
  const WIDTH_MAX = 1520;
  const WIDTH_DEFAULT = 440;
  let panelWidth = WIDTH_DEFAULT;

  function pref(key: string, fallback: string): string {
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
  panelWidth = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Number(pref("filePanelWidth", String(WIDTH_DEFAULT))) || WIDTH_DEFAULT));

  function clampWidth(width: number): number {
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width));
  }
  function savePanelWidth(width: number): void {
    panelWidth = clampWidth(width);
    setPref("filePanelWidth", String(Math.round(panelWidth)));
  }
  function startResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // Panel sits at the right edge → dragging left (smaller clientX) widens it.
      panelWidth = clampWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setPref("filePanelWidth", String(Math.round(panelWidth)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function onResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      savePanelWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      savePanelWidth(panelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      savePanelWidth(WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(WIDTH_MAX);
    }
  }

  function close(): void {
    updateState((state) => {
      const target = state.chatPanes.find((p) => p.id === pane.id);
      if (target) target.filePreview = null;
    });
  }

  /* ---- draw.io diagram rendering (interactive, client-side) ---- */
  let drawioHost: HTMLDivElement | undefined;
  let drawioStatus: "loading" | "ready" | "error" = "loading";
  let drawioXml = "";
  let drawioFor = ""; // attachment id the fetched XML belongs to
  let drawioToken = 0; // guards async fetch/load against a newer open (canvas pattern)
  let paintedWidth = 0;
  let repaintTimer: ReturnType<typeof setTimeout> | undefined;

  $: drawioAtt = preview && isDrawioAttachment(preview.attachment) ? preview.attachment : null;
  $: if (drawioAtt && drawioAtt.id !== drawioFor) void openDrawio(drawioAtt);
  $: if (!drawioAtt && drawioFor) resetDrawio();
  // The viewer lays out for the width it was created at — repaint (debounced)
  // after the panel is resized.
  $: if (drawioStatus === "ready" && Math.abs(panelWidth - paintedWidth) > 1) scheduleRepaint();

  // Above this the tab would freeze on res.text() + a synchronous render; the
  // panel falls back to the download-only error copy instead (server cap is 30 MB).
  const DRAWIO_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

  async function openDrawio(att: MessageAttachment): Promise<void> {
    const token = ++drawioToken;
    drawioFor = att.id;
    drawioStatus = "loading";
    drawioXml = "";
    // Blank the host NOW — when switching between two .drawio attachments the
    // component stays mounted, and the old diagram must not sit under the new
    // file's name while its content fetches.
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
      paintDrawio();
    } catch {
      if (token === drawioToken) drawioStatus = "error";
    }
  }

  function paintDrawio(): void {
    // The resize-watching reactive block flushes (and arms the repaint timer)
    // BEFORE the initial paint runs — `drawioStatus = "ready"` invalidates state
    // ahead of the `await tick()` — so every paint must cancel any pending
    // repaint or the first open paints twice, 200ms apart.
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
    paintedWidth = panelWidth;
    try {
      viewer.createViewerForElement(target);
    } catch {
      drawioStatus = "error";
    }
  }

  // Debounced so a drag gesture repaints once at settle: GraphViewer has no
  // destroy(), so each paint strands one matchMedia listener — bounded to one
  // per resize gesture, not one per pointermove tick.
  function scheduleRepaint(): void {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(paintDrawio, 200);
  }

  function resetDrawio(): void {
    drawioToken += 1;
    clearTimeout(repaintTimer);
    drawioFor = "";
    drawioXml = "";
    drawioStatus = "loading";
    paintedWidth = 0;
  }

  onDestroy(() => {
    clearTimeout(repaintTimer);
    // Never strand the drag cursor/user-select lock if the panel unmounts mid-resize.
    document.body.classList.remove("col-resizing");
  });

  function slideSrc(att: MessageAttachment): string {
    return `/api/conversations/${encodeURIComponent(pane.conversationId)}/images/${encodeURIComponent(att.id)}`;
  }

  function downloadHref(att: MessageAttachment): string {
    const base = `/api/conversations/${encodeURIComponent(pane.conversationId)}/files/${encodeURIComponent(att.id)}`;
    return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
  }

</script>

{#if preview}
  <aside class="canvas-panel file-preview-panel" aria-label="파일 미리보기" style={`width:${panelWidth}px`}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
    <div
      class="canvas-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="미리보기 패널 너비 조절"
      aria-valuenow={Math.round(panelWidth)}
      aria-valuemin={WIDTH_MIN}
      aria-valuemax={WIDTH_MAX}
      aria-valuetext={`${Math.round(panelWidth)}px`}
      tabindex="0"
      on:pointerdown={startResize}
      on:keydown={onResizeKeydown}
    ></div>
    <div class="file-preview-head">
      <div class="file-preview-title">
        <strong class="file-preview-name" title={preview.attachment.name || "파일"}>{preview.attachment.name || "파일"}</strong>
        {#if formatFileSize(preview.attachment.size)}
          <span class="muted">{formatFileSize(preview.attachment.size)}</span>
        {/if}
      </div>
      <div class="file-preview-actions">
        {#if drawioAtt}
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            aria-label="XML 텍스트 복사"
            title="다이어그램 XML을 텍스트로 복사"
            disabled={drawioStatus !== "ready"}
            on:click={(event) => copyText(drawioXml, event.currentTarget as HTMLButtonElement)}
          >복사</button>
        {/if}
        {#if shareable}
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            disabled={shareLive}
            title={shareLive ? "응답이 끝난 뒤 만들 수 있습니다." : undefined}
            on:click={share}
          >공유 링크</button>
        {/if}
        <!-- draggable=false: a link styled as a button must not start a native
             link-drag when the pointer moves during the press. -->
        <a
          class="btn btn-primary btn-sm"
          href={downloadHref(preview.attachment)}
          download={preview.attachment.name || undefined}
          draggable="false"
        >다운로드</a>
        <button class="msg-act" type="button" aria-label="미리보기 닫기" title="닫기" on:click={close}>
          <Icon name="close" />
        </button>
      </div>
    </div>
    <div class="canvas-body file-preview-body scroll-thin">
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
            <img src={slideSrc(slide)} alt={slide.name || `슬라이드 ${index + 1}`} loading="lazy" />
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
  </aside>
{/if}
