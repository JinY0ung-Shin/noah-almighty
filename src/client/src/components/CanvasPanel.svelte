<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import DOMPurify from "dompurify";
  import CanvasHtmlFrame from "./CanvasHtmlFrame.svelte";
  import Icon from "./Icon.svelte";
  import { canvasHtmlDocument } from "../lib/canvasHtml";
  import { renderMarkdown, timeLabel } from "../lib/format";
  import { openModalFocus, trapTab } from "../lib/modalBehavior";
  import { cssToken, theme } from "../lib/theme";
  import type { ResolvedTheme } from "../lib/theme";
  import {
    closeCanvas,
    dismissCanvas,
    fetchCanvasVersions,
    rollbackCanvas,
    setActiveCanvas,
    submitCanvas,
    submitCanvasEdit,
  } from "../lib/chat";
  import { assertInlineOnlyVegaSpec, createInlineOnlyVegaLoader } from "../lib/vegaCanvas";
  import { copyText } from "../lib/dom";
  import { copyPng, downloadPng, downloadSvg } from "../lib/canvasExport";
  import { notify } from "../lib/state";
  import type { ChatPane, PaneCanvas } from "../lib/types";

  type CanvasControl = NonNullable<PaneCanvas["controls"]>[number];

  // Visual canvas side panel (experimental `canvas` feature, #50). Renders the
  // avatar-shown artifact (markdown/svg/html/mermaid/vega — all sanitized, never
  // executing avatar JS) plus real form controls that post back through
  // /api/chat/respond (blocking) or /api/chat/stream (async). Resizable via the
  // left-edge handle, collapse state persisted in localStorage, stacked below the
  // chat on narrow viewports.
  export let pane: ChatPane;

  let collapsed = false;
  const CANVAS_WIDTH_MIN = 300;
  const CANVAS_WIDTH_MAX = 1520;
  const CANVAS_WIDTH_DEFAULT = 440;
  let panelWidth = CANVAS_WIDTH_DEFAULT;

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
  // Bound the stored/dragged width to the panel's own min/max only. CSS owns the
  // actual fit (`.canvas-panel:not(.collapsed)` flex-shrink + the chat-col floor,
  // and stacking on narrow viewports — #40 responsive). The old viewport-width term
  // reserved rail+chat here too, which double-counted against the other side panel
  // and pushed this one off the right edge.
  function clampWidth(width: number): number {
    return Math.min(CANVAS_WIDTH_MAX, Math.max(CANVAS_WIDTH_MIN, width));
  }
  function savePanelWidth(width: number): void {
    panelWidth = clampWidth(width);
    setPref("canvasPanelWidth", String(Math.round(panelWidth)));
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
      setPref("canvasPanelWidth", String(Math.round(panelWidth)));
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
      savePanelWidth(CANVAS_WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(CANVAS_WIDTH_MAX);
    }
  }
  function setCollapsed(value: boolean) {
    collapsed = value;
    setPref("canvasPanelCollapsed", value ? "1" : "0");
  }

  onMount(() => {
    const mobile = window.matchMedia?.("(max-width: 860px)").matches ?? false;
    collapsed = pref("canvasPanelCollapsed", mobile ? "1" : "0") === "1";
    panelWidth = clampWidth(Number(pref("canvasPanelWidth", String(CANVAS_WIDTH_DEFAULT))) || CANVAS_WIDTH_DEFAULT);
  });

  $: canvases = pane.canvases || [];
  $: active = canvases.find((c) => c.id === pane.activeCanvasId) ?? canvases[canvases.length - 1] ?? null;
  $: canvasBodyId = canvasDomId("canvas-panel-body", pane.id);
  $: versionListId = active ? canvasDomId("canvas-versions", active.id) : "canvas-versions";

  // ---- per-canvas control + editor state, rebuilt when the active canvas changes ----
  let formCanvasId = "";
  let ctrlVals: Record<string, unknown> = {};
  let editDraft = "";
  let resubmitting = false;
  let showVersions = false;
  let versions: { version: number; createdAt: string }[] = [];
  let versionsLoading = false;
  let versionsError = "";
  $: if (active && active.id !== formCanvasId) {
    initForm(active);
  }
  function initForm(c: PaneCanvas): void {
    formCanvasId = c.id;
    const next: Record<string, unknown> = {};
    for (const ctrl of c.controls || []) {
      if (ctrl.type === "buttons") next[ctrl.id] = [];
      else if (ctrl.type === "slider") next[ctrl.id] = ctrl.defaultValue ?? ctrl.min ?? 0;
      else next[ctrl.id] = ctrl.defaultValue ?? ""; // text | select | number | date
    }
    ctrlVals = next;
    editDraft = c.content;
    resubmitting = false;
    showVersions = false;
    versions = [];
    versionsError = "";
    versionsLoading = false;
  }

  // ---- content rendering (CSP-safe: no avatar-authored JS ever runs) ----
  // ONE surface shows the active canvas, and only markdown (or a source fallback)
  // is parsed into the app's own DOM: a drawing (svg/vega/mermaid) goes into a
  // shadow root (shadowSvg) and an `html` page into its own sandboxed document
  // (CanvasHtmlFrame), so neither one's <style> can restyle the app.
  let renderedHtml = "";
  let svgMarkup = "";
  let htmlDoc = "";
  // Async renders (vega/mermaid) call this when they land, so the previous surface
  // stays up meanwhile instead of blinking out on every theme flip.
  function showRendered(surface: { html?: string; svg?: string; doc?: string }): void {
    renderedHtml = surface.html ?? "";
    svgMarkup = surface.svg ?? "";
    htmlDoc = surface.doc ?? "";
  }
  let renderError = "";
  // Wrap a raw (English) vega/mermaid library message in a Korean sentence,
  // keeping the detail — a bare English message reads as a crash in the KO UI.
  function vegaRenderError(err: unknown): string {
    const detail = err instanceof Error ? err.message : "";
    return detail ? `Vega 차트 렌더링에 실패했습니다 (상세: ${detail})` : "Vega 차트 렌더링에 실패했습니다.";
  }
  function mermaidRenderError(err: unknown): string {
    const detail = err instanceof Error ? err.message : "";
    return detail ? `mermaid 렌더링에 실패했습니다 (상세: ${detail})` : "mermaid 렌더링에 실패했습니다.";
  }
  let contentEl: HTMLElement; // bound, so export can read the rendered <svg>
  // Token guards async (mermaid/vega) renders so a stale result can't overwrite a newer one.
  let renderToken = 0;

  // Chart chrome (axes, labels, legends) is derived from the SAME design tokens
  // the page uses instead of a second hardcoded palette; the fallbacks cover a
  // context where the stylesheet isn't loaded. Both themes are spelled out —
  // leaving light implicit let Vega pick its own near-black.
  function vegaConfig(dark: boolean): Record<string, unknown> {
    const text = cssToken("--text", dark ? "#e5e7eb" : "#161b21");
    const muted = cssToken("--muted", dark ? "#cbd5e1" : "#505b66");
    const line = cssToken("--line", dark ? "#475569" : "#d6dde4");
    const grid = cssToken("--line-soft", dark ? "#334155" : "#e3e8ed");
    return {
      background: "transparent",
      view: { stroke: "transparent" },
      title: { color: text, subtitleColor: muted },
      axis: { domainColor: line, gridColor: grid, tickColor: line, labelColor: muted, titleColor: text },
      legend: { labelColor: muted, titleColor: text },
      style: { "guide-label": { fill: muted }, "guide-title": { fill: text } },
    };
  }

  // `$theme` is a real dependency, not decoration: mermaid and Vega bake their
  // colors into the SVG at build time, so a theme flip has to re-render or the
  // chart stays on the old palette.
  $: void renderActive(active, $theme);

  async function renderActive(canvas: PaneCanvas | null, resolvedTheme: ResolvedTheme): Promise<void> {
    const token = ++renderToken;
    renderError = "";
    if (!canvas) {
      showRendered({});
      return;
    }
    if (canvas.contentType === "markdown") {
      showRendered({ html: renderMarkdown(canvas.content) });
      return;
    }
    if (canvas.contentType === "svg") {
      showRendered({ svg: DOMPurify.sanitize(canvas.content, { USE_PROFILES: { svg: true, svgFilters: true } }) });
      return;
    }
    if (canvas.contentType === "html") {
      showRendered({ doc: canvasHtmlDocument(canvas.content, resolvedTheme) });
      return;
    }
    if (canvas.contentType === "vega") {
      try {
        const [vega, vegaLite, interp] = await Promise.all([
          import("vega"),
          import("vega-lite"),
          import("vega-interpreter"),
        ]);
        const spec = JSON.parse(canvas.content);
        assertInlineOnlyVegaSpec(spec);
        const config = vegaConfig(resolvedTheme === "dark");
        const vgSpec = vegaLite.compile(spec, { config } as any).spec;
        const runtime = vega.parse(vgSpec as any, null as any, { ast: true } as any);
        const view = new vega.View(runtime, {
          expr: interp.expressionInterpreter,
          renderer: "svg",
          loader: createInlineOnlyVegaLoader(vega),
        } as any);
        const svg = await view.toSVG();
        view.finalize();
        if (token !== renderToken) return; // a newer render won
        showRendered({ svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) });
      } catch (err) {
        if (token !== renderToken) return;
        // Wrap the raw (English) library message in a Korean sentence, keeping the
        // detail — a bare English message reads as a crash in the Korean UI.
        renderError = vegaRenderError(err);
        const escaped = canvas.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
        showRendered({ html: DOMPurify.sanitize(`<pre>${escaped}</pre>`) });
      }
      return;
    }
    if (canvas.contentType === "mermaid") {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
          // Labels as SVG <text>: by default flowchart/class/state/ER/mindmap/kanban
          // put them in <foreignObject> HTML, which the svg-profile sanitize below
          // strips — every node rendered as an empty box.
          htmlLabels: false,
        });
        const { svg } = await mermaid.render(`canvas-mmd-${canvas.id}-${token}`, canvas.content);
        if (token !== renderToken) return; // a newer render won
        showRendered({ svg: DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) });
      } catch (err) {
        if (token !== renderToken) return;
        renderError = mermaidRenderError(err);
        const escaped = canvas.content.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
        showRendered({ html: DOMPurify.sanitize(`<pre>${escaped}</pre>`) });
      }
    }
  }

  // A drawing's own <style> (an avatar's `<svg><style>`, mermaid's id-scoped sheet)
  // applies inside this shadow root only — in the app's DOM it restyled the whole
  // app — and its ids stay apart from the other copy's (panel vs fullscreen).
  // `data-fit` is the panel's fit-to-width; fullscreen keeps the natural size. The
  // root is open so export can read the <svg> (getSvgEl).
  const SVG_HOST_SHEET =
    "<style>:host { display: block; } :host([data-fit]) svg { max-width: 100%; height: auto; }</style>";
  function shadowSvg(node: HTMLElement, markup: string) {
    const root = node.attachShadow({ mode: "open" });
    root.innerHTML = SVG_HOST_SHEET + markup;
    return {
      update(next: string) {
        root.innerHTML = SVG_HOST_SHEET + next;
      },
    };
  }

  // ---- form controls ----
  // Pure REASSIGNMENT on purpose: mutating `ctrlVals[ctrlId]` inside a script
  // function makes the Svelte 5 legacy compiler emit an invalidation thunk that
  // references template each-scope names (`ctrl`, `labelId`) as bare identifiers
  // here, where they don't exist — a ReferenceError on every option click.
  function toggleButton(ctrlId: string, value: string, multi: boolean): void {
    const current = Array.isArray(ctrlVals[ctrlId]) ? (ctrlVals[ctrlId] as string[]) : [];
    const next = multi
      ? current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      : [value];
    ctrlVals = { ...ctrlVals, [ctrlId]: next };
  }
  function optValue(opt: { label: string; value?: string }): string {
    return opt.value ?? opt.label;
  }
  function isSelected(ctrlId: string, value: string): boolean {
    return Array.isArray(ctrlVals[ctrlId]) && (ctrlVals[ctrlId] as string[]).includes(value);
  }

  $: canSubmit = Boolean(active?.controls?.length) &&
    (active?.controls || []).every((ctrl) => {
      if (ctrl.required === false) return true;
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") return Array.isArray(v) && v.length > 0;
      if (ctrl.type === "slider") return true; // always carries a value
      if (ctrl.type === "number") {
        if (v === "" || v === null || v === undefined) return false;
        const n = Number(v);
        if (Number.isNaN(n)) return false;
        if (typeof ctrl.min === "number" && n < ctrl.min) return false;
        if (typeof ctrl.max === "number" && n > ctrl.max) return false;
        return true;
      }
      return String(v ?? "").trim().length > 0; // text | select | date
    });

  function onSubmit(): void {
    if (!active || controlsLocked || !canSubmit) return;
    const values: Record<string, unknown> = {};
    for (const ctrl of active.controls || []) {
      const v = ctrlVals[ctrl.id];
      if (ctrl.type === "buttons") {
        const sel = Array.isArray(v) ? (v as string[]) : [];
        values[ctrl.id] = ctrl.multiSelect ? sel : sel[0] ?? "";
      } else if (ctrl.type === "slider" || ctrl.type === "number") {
        values[ctrl.id] = v === "" || v === null || v === undefined ? "" : Number(v);
      } else {
        values[ctrl.id] = String(v ?? "").trim();
      }
    }
    resubmitting = false;
    void submitCanvas(pane.id, active.id, values);
  }

  function submitEdit(): void {
    if (!active || !editCanSubmit) return;
    void submitCanvasEdit(pane.id, active.id, editDraft);
  }

  // The controls form is shown for a blocking pending canvas, an async canvas, or a
  // re-submission of an already-answered async canvas.
  $: showForm = Boolean(
    active?.controls?.length &&
      (active.pending || (active.interaction === "async" && (!active.submittedValues || resubmitting))),
  );
  // The run is PARKED on this canvas (blocking ask): the answer posts to
  // /api/chat/respond MID-run — the run resumes only after the user submits or
  // skips — so `pane.streaming` must NOT lock the form here. Locking it
  // deadlocks the question: the run waits for the user, the form waits for the
  // run (regression 8aed88d→208489d; the run stays `streaming` while parked).
  $: awaitingAnswer = Boolean(active?.pending && active?.requestId && active?.runId);
  $: controlsLocked = Boolean(active?.submitting || (pane.streaming && !awaitingAnswer));
  // Content edits always ride a NEW chat turn (submitCanvasEdit → sendMessage),
  // so the edit path DOES wait for the avatar's turn to end — even while parked.
  $: editLocked = Boolean(active?.submitting || pane.streaming);
  $: editTrimmed = editDraft.trim();
  $: editDirty = Boolean(active && editDraft !== active.content);
  $: editCanSubmit = Boolean(active?.editable && editTrimmed && editDirty && !editLocked);
  $: editStatus = editLocked
    ? "아바타 응답이 끝난 뒤 수정할 수 있습니다."
    : !editTrimmed
      ? "수정할 내용을 입력하세요."
      : !editDirty
        ? "원본과 같은 내용입니다."
        : "수정본을 보낼 준비가 됐습니다.";
  $: controlsStatusId = active ? canvasDomId("canvas-controls-status", active.id) : "canvas-controls-status";
  $: controlsStatus = active?.submitting
    ? "응답을 보내는 중입니다."
    : controlsLocked
      ? "아바타 응답이 끝난 뒤 보낼 수 있습니다."
      : canSubmit
        ? "보낼 준비가 됐습니다."
        : "필수 항목을 입력해 주세요.";
  // The skip button only makes sense for a blocking, parked run.
  $: canSkip = awaitingAnswer;

  function renderSubmitted(value: unknown): string {
    return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  function controlLabel(ctrl: CanvasControl): string {
    return ctrl.label || ctrl.id;
  }
  function controlDomId(canvas: PaneCanvas, ctrl: CanvasControl, suffix: string): string {
    return canvasDomId(`canvas-control-${suffix}`, `${canvas.id}-${ctrl.id}`);
  }

  // ---- export ----
  const isImageType = (c: PaneCanvas): boolean =>
    c.contentType === "svg" || c.contentType === "vega" || c.contentType === "mermaid";
  function getSvgEl(): SVGSVGElement | null {
    // The drawing sits in the panel host's shadow root (shadowSvg).
    const host = contentEl?.querySelector(".canvas-svg");
    return (host?.shadowRoot?.querySelector("svg") as SVGSVGElement | null) ?? null;
  }
  async function onCopy(event: MouseEvent): Promise<void> {
    if (!active) return;
    const btn = event.currentTarget as HTMLButtonElement;
    if (isImageType(active)) {
      const svg = getSvgEl();
      if (svg && (await copyPng(svg))) {
        notify("이미지를 클립보드에 복사했습니다.", "info");
        return;
      }
    }
    await copyText(active.content, btn); // source text (markdown/html, or image fallback)
  }
  function onDownloadPng(): void {
    const svg = getSvgEl();
    if (active && svg) void downloadPng(svg, active.title);
    else notify("이 캔버스는 PNG로 저장할 수 없습니다.", "warn");
  }
  function onDownloadSvg(): void {
    const svg = getSvgEl();
    if (active && svg) downloadSvg(svg, active.title);
  }

  // ---- version history ----
  function canvasDomId(prefix: string, id: string): string {
    return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  function focusCanvasTab(id: string): void {
    requestAnimationFrame(() => document.getElementById(canvasDomId("canvas-tab", id))?.focus());
  }

  function onCanvasTabKeydown(event: KeyboardEvent, canvas: PaneCanvas): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = canvases.findIndex((item) => item.id === canvas.id);
    if (currentIndex < 0) return;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? canvases.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + canvases.length) % canvases.length;
    const next = canvases[nextIndex];
    setActiveCanvas(pane.id, next.id);
    focusCanvasTab(next.id);
  }

  async function loadVersions(): Promise<void> {
    if (!active || versionsLoading) return;
    versionsLoading = true;
    versionsError = "";
    try {
      versions = await fetchCanvasVersions(active.id);
    } catch (err) {
      versionsError = (err as Error).message || "버전 기록을 불러오지 못했습니다.";
    } finally {
      versionsLoading = false;
    }
  }

  async function toggleVersions(): Promise<void> {
    showVersions = !showVersions;
    if (showVersions) await loadVersions();
  }
  function doRollback(version: number): void {
    if (!active) return;
    if (version === active.currentVersion) return;
    showVersions = false;
    void rollbackCanvas(pane.id, active.id, version);
  }

  // ---- fullscreen ----
  let fullscreen = false;
  let fsEl: HTMLDivElement | undefined;
  let releaseFsFocus: (() => void) | null = null;
  let zoom = 1;

  // The stage claims aria-modal, so it owes the matching behavior: contain Tab,
  // inert the page behind it, and hand focus back to the opener on close.
  $: syncFullscreenFocus(fsEl);

  function syncFullscreenFocus(el: HTMLElement | undefined): void {
    if (el) {
      releaseFsFocus ??= openModalFocus(el);
      return;
    }
    releaseFsFocus?.();
    releaseFsFocus = null;
  }

  onDestroy(() => {
    releaseFsFocus?.();
    releaseFsFocus = null;
    // Never strand the drag cursor/user-select lock if the panel unmounts mid-resize.
    document.body.classList.remove("col-resizing");
  });

  function openFullscreen(): void {
    zoom = 1;
    fullscreen = true;
  }
  function onFsKey(event: KeyboardEvent): void {
    if (event.key === "Escape") fullscreen = false;
    else if (event.key === "Tab") trapTab(event, fsEl);
  }
  function onFsWheel(event: WheelEvent): void {
    event.preventDefault();
    zoom = Math.min(4, Math.max(0.4, zoom + (event.deltaY < 0 ? 0.15 : -0.15)));
  }
</script>

<svelte:window on:keydown={fullscreen ? onFsKey : undefined} />

{#if canvases.length}
<aside class="canvas-panel" class:collapsed aria-label="비주얼 캔버스" style={collapsed ? undefined : `width:${panelWidth}px`}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="canvas-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="캔버스 패널 너비 조절"
    aria-valuenow={Math.round(panelWidth)}
    aria-valuemin={CANVAS_WIDTH_MIN}
    aria-valuemax={CANVAS_WIDTH_MAX}
    aria-valuetext={`${Math.round(panelWidth)}px`}
    tabindex="0"
    on:pointerdown={startResize}
    on:keydown={onResizeKeydown}
  ></div>
    <button class="canvas-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} aria-controls={canvasBodyId} on:click={() => setCollapsed(true)}>›</button>

    <div id={canvasBodyId} class="canvas-body scroll-thin">
      <div class="canvas-head">
        <h3>캔버스 <span class="canvas-beta">실험</span></h3>
        {#if canvases.length > 1}
          <div class="canvas-tabs" role="tablist" aria-label="캔버스 목록">
            {#each canvases as c (c.id)}
              <div class="canvas-tab-wrap" class:active={active?.id === c.id}>
                <button
                  id={canvasDomId("canvas-tab", c.id)}
                  class="canvas-tab"
                  type="button"
                  role="tab"
                  aria-selected={active?.id === c.id}
                  aria-controls="canvas-active-panel"
                  tabindex={active?.id === c.id ? 0 : -1}
                  on:click={() => setActiveCanvas(pane.id, c.id)}
                  on:keydown={(event) => onCanvasTabKeydown(event, c)}
                >{c.title}</button>
                <button class="canvas-tab-close" type="button" aria-label={`캔버스 닫기: ${c.title}`} title="캔버스 닫기" on:click={() => closeCanvas(pane.id, c.id)}><Icon name="close" size={14} /></button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      {#if active}
        <div
          id="canvas-active-panel"
          class="canvas-card"
          role={canvases.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={canvases.length > 1 ? canvasDomId("canvas-tab", active.id) : undefined}
        >
          <div class="canvas-card-top">
            <div class="canvas-title">{active.title}</div>
            <div class="canvas-toolbar">
              {#if (active.versionCount || 1) > 1}
                <button class="canvas-tool-btn" type="button" title="버전 기록" aria-expanded={showVersions} aria-controls={versionListId} on:click={toggleVersions}>v{active.currentVersion ?? 1} ▾</button>
              {/if}
              <button class="canvas-tool-btn" type="button" title="복사" on:click={onCopy}>복사</button>
              {#if isImageType(active)}
                <button class="canvas-tool-btn" type="button" title="PNG로 저장" on:click={onDownloadPng}>PNG</button>
                <button class="canvas-tool-btn" type="button" title="SVG로 저장" on:click={onDownloadSvg}>SVG</button>
              {/if}
              <button class="canvas-tool-btn" type="button" title="전체화면" aria-label="전체화면" on:click={openFullscreen}>⤢</button>
              {#if canvases.length === 1}
                <button class="canvas-tool-btn" type="button" title="캔버스 닫기" aria-label="캔버스 닫기" on:click={() => active && closeCanvas(pane.id, active.id)}><Icon name="close" size={12} /></button>
              {/if}
            </div>
          </div>

          {#if showVersions}
            <div id={versionListId} class="canvas-versions" role="listbox" aria-label="버전 기록">
              {#if versionsLoading}
                <div class="canvas-version-state" role="status">버전 기록을 불러오는 중…</div>
              {:else if versionsError}
                <div class="canvas-version-state error-note" role="alert">
                  {versionsError}
                  <button class="linkish small" type="button" on:click={loadVersions}>다시 시도</button>
                </div>
              {:else}
                {#each versions as v (v.version)}
                  <button
                    class="canvas-version-row"
                    class:current={v.version === active.currentVersion}
                    type="button"
                    role="option"
                    aria-selected={v.version === active.currentVersion ? "true" : "false"}
                    disabled={v.version === active.currentVersion}
                    on:click={() => doRollback(v.version)}
                  >
                    <span>v{v.version}</span>
                    <span class="canvas-version-time">{timeLabel(v.createdAt)}</span>
                    {#if v.version === active.currentVersion}<span class="canvas-version-action">현재</span>{:else}<span class="canvas-version-action">되돌리기</span>{/if}
                  </button>
                {/each}
              {/if}
            </div>
          {/if}

          <div class="canvas-content md" bind:this={contentEl}>
            {#if htmlDoc}<CanvasHtmlFrame doc={htmlDoc} title={active.title} />{:else if svgMarkup}<div class="canvas-svg" data-fit use:shadowSvg={svgMarkup}></div>{:else}{@html renderedHtml}{/if}
          </div>
          {#if renderError}
            <p class="canvas-render-error" role="alert">렌더링 실패: {renderError}</p>
          {/if}

          {#if active.editable}
            <div class="canvas-edit">
              <div class="canvas-control-label" id={canvasDomId("canvas-edit-label", active.id)}>내용 편집</div>
              <div class="field">
                <textarea
                  rows="5"
                  bind:value={editDraft}
                  placeholder="내용을 수정해 아바타에게 보내세요"
                  aria-labelledby={canvasDomId("canvas-edit-label", active.id)}
                  aria-describedby={canvasDomId("canvas-edit-status", active.id)}
                  disabled={editLocked}
                ></textarea>
              </div>
              <div id={canvasDomId("canvas-edit-status", active.id)} class="canvas-edit-status" class:dirty={editCanSubmit} role="status">{editStatus}</div>
              <div class="canvas-actions">
                <button class="btn btn-primary btn-sm" type="button" aria-describedby={canvasDomId("canvas-edit-status", active.id)} disabled={!editCanSubmit} on:click={submitEdit}>수정해서 보내기</button>
              </div>
            </div>
          {/if}

          {#if active.controls?.length}
            {#if active.submittedValues && !resubmitting}
              <div class="canvas-answered" role="status">
                <span class="canvas-answered-badge">응답 완료</span>
                <ul>
                  {#each active.controls as ctrl (ctrl.id)}
                    <li><strong>{ctrl.label || ctrl.id}:</strong> {renderSubmitted(active.submittedValues[ctrl.id])}</li>
                  {/each}
                </ul>
                {#if active.interaction === "async"}
                  <button class="btn btn-ghost btn-sm" type="button" disabled={pane.streaming} on:click={() => (resubmitting = true)}>다시 보내기</button>
                {/if}
              </div>
            {:else if showForm}
              <form class="canvas-controls" aria-busy={active.submitting ? "true" : "false"} aria-describedby={controlsStatusId} on:submit|preventDefault={onSubmit}>
                {#each active.controls as ctrl (ctrl.id)}
                  {@const labelId = controlDomId(active, ctrl, "label")}
                  <div class="canvas-control">
                    {#if ctrl.label}<div id={labelId} class="canvas-control-label">{ctrl.label}{#if ctrl.required === false}<span class="canvas-optional"> (선택)</span>{/if}</div>{/if}
                    {#if ctrl.type === "buttons"}
                      <div
                        class="canvas-options"
                        role="group"
                        aria-labelledby={ctrl.label ? labelId : undefined}
                        aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                        aria-describedby={controlsStatusId}
                      >
                        {#each ctrl.options || [] as opt}
                          <button
                            type="button"
                            class="canvas-opt"
                            class:selected={isSelected(ctrl.id, optValue(opt))}
                            aria-pressed={isSelected(ctrl.id, optValue(opt))}
                            aria-describedby={controlsStatusId}
                            disabled={controlsLocked}
                            on:click={() => toggleButton(ctrl.id, optValue(opt), Boolean(ctrl.multiSelect))}
                          >
                            <span class="canvas-opt-label">{opt.label}</span>
                            {#if opt.description}<span class="canvas-opt-desc">{opt.description}</span>{/if}
                          </button>
                        {/each}
                      </div>
                    {:else if ctrl.type === "select"}
                      <div class="field">
                        <select
                          bind:value={ctrlVals[ctrl.id]}
                          aria-labelledby={ctrl.label ? labelId : undefined}
                          aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                          aria-describedby={controlsStatusId}
                          disabled={controlsLocked}
                        >
                          <option value="" disabled>{ctrl.placeholder || "선택하세요"}</option>
                          {#each ctrl.options || [] as opt}
                            <option value={optValue(opt)}>{opt.label}</option>
                          {/each}
                        </select>
                      </div>
                    {:else if ctrl.type === "slider"}
                      <div class="canvas-slider">
                        <input
                          type="range"
                          min={ctrl.min ?? 0}
                          max={ctrl.max ?? 100}
                          step={ctrl.step ?? 1}
                          bind:value={ctrlVals[ctrl.id]}
                          aria-labelledby={ctrl.label ? labelId : undefined}
                          aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                          aria-describedby={controlsStatusId}
                          disabled={controlsLocked}
                        />
                        <span class="canvas-slider-val">{ctrlVals[ctrl.id]}</span>
                      </div>
                    {:else if ctrl.type === "number"}
                      <div class="field">
                        <input
                          type="number"
                          min={ctrl.min}
                          max={ctrl.max}
                          step={ctrl.step ?? 1}
                          placeholder={ctrl.placeholder || ""}
                          bind:value={ctrlVals[ctrl.id]}
                          aria-labelledby={ctrl.label ? labelId : undefined}
                          aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                          aria-describedby={controlsStatusId}
                          disabled={controlsLocked}
                        />
                      </div>
                    {:else if ctrl.type === "date"}
                      <div class="field">
                        <input
                          type="date"
                          bind:value={ctrlVals[ctrl.id]}
                          aria-labelledby={ctrl.label ? labelId : undefined}
                          aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                          aria-describedby={controlsStatusId}
                          disabled={controlsLocked}
                        />
                      </div>
                    {:else}
                      <div class="field">
                        {#if ctrl.multiline}
                          <textarea
                            rows="3"
                            placeholder={ctrl.placeholder || ""}
                            bind:value={ctrlVals[ctrl.id]}
                            aria-labelledby={ctrl.label ? labelId : undefined}
                            aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                            aria-describedby={controlsStatusId}
                            disabled={controlsLocked}
                          ></textarea>
                        {:else}
                          <input
                            type="text"
                            placeholder={ctrl.placeholder || ""}
                            bind:value={ctrlVals[ctrl.id]}
                            aria-labelledby={ctrl.label ? labelId : undefined}
                            aria-label={!ctrl.label ? controlLabel(ctrl) : undefined}
                            aria-describedby={controlsStatusId}
                            disabled={controlsLocked}
                          />
                        {/if}
                      </div>
                    {/if}
                  </div>
                {/each}
                <div id={controlsStatusId} class="canvas-edit-status" class:dirty={canSubmit || controlsLocked} role="status" aria-live="polite">{controlsStatus}</div>
                <div class="canvas-actions">
                  {#if canSkip}
                    <button class="btn btn-ghost btn-sm" type="button" aria-describedby={controlsStatusId} disabled={controlsLocked} on:click={() => active && dismissCanvas(pane.id, active.id)}>건너뛰기</button>
                  {:else if resubmitting}
                    <button class="btn btn-ghost btn-sm" type="button" aria-describedby={controlsStatusId} on:click={() => (resubmitting = false)}>취소</button>
                  {/if}
                  <button class="btn btn-primary btn-sm" type="submit" aria-describedby={controlsStatusId} disabled={!canSubmit || controlsLocked}>보내기</button>
                </div>
              </form>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <button class="canvas-expand" type="button" aria-label="캔버스 패널 펼치기" title="캔버스 패널 펼치기" aria-expanded={!collapsed} aria-controls={canvasBodyId} on:click={() => setCollapsed(false)}>
      <span aria-hidden="true">‹</span>
      <span class="canvas-expand-label">캔버스 보기</span>
    </button>
  </aside>
{/if}

{#if fullscreen && active}
  <div bind:this={fsEl} class="canvas-fs" role="dialog" aria-modal="true" aria-label="캔버스 전체화면" on:wheel|nonpassive={onFsWheel}>
    <div class="canvas-fs-bar">
      <span class="canvas-fs-title">{active.title}</span>
      <div class="canvas-fs-zoom">
        <button class="canvas-tool-btn" type="button" aria-label="축소" on:click={() => (zoom = Math.max(0.4, zoom - 0.2))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button class="canvas-tool-btn" type="button" aria-label="확대" on:click={() => (zoom = Math.min(4, zoom + 0.2))}>+</button>
        <button class="canvas-tool-btn" type="button" data-modal-autofocus on:click={() => (fullscreen = false)}>닫기</button>
      </div>
    </div>
    <button class="canvas-fs-backdrop" type="button" aria-label="닫기" on:click={() => (fullscreen = false)}></button>
    <div class="canvas-fs-stage">
      <div class="canvas-fs-content md" class:is-html={htmlDoc !== ""} style={`transform:scale(${zoom})`}>
        {#if htmlDoc}<CanvasHtmlFrame doc={htmlDoc} title={active.title} onWheel={onFsWheel} onKeydown={onFsKey} />{:else if svgMarkup}<div class="canvas-svg" use:shadowSvg={svgMarkup}></div>{:else}{@html renderedHtml}{/if}
      </div>
    </div>
  </div>
{/if}
