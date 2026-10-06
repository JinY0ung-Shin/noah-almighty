<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { fitCanvasFrame } from "../lib/canvasHtml";

  // One canvas `html` artifact as its own sandboxed page (lib/canvasHtml.ts builds
  // `doc`). The sandbox never gets `allow-scripts`: `allow-same-origin` alone is
  // what lets fitCanvasFrame read the page and same-origin images load, and with
  // scripts off the page itself can do nothing with it.
  export let doc: string;
  export let title: string;
  // Events inside the page never reach the app's DOM, so the fullscreen view
  // forwards the ones it handles (wheel zoom, Escape) through these.
  export let onWheel: ((event: WheelEvent) => void) | undefined = undefined;
  export let onKeydown: ((event: KeyboardEvent) => void) | undefined = undefined;

  let frame: HTMLIFrameElement;
  let page: Document | null = null; // the parsed srcdoc document currently hooked
  let observer: ResizeObserver | null = null;
  let width = 0;
  let hookRequest = 0;
  let fitRequest = 0;

  // A srcdoc change parses into a NEW document: hook it as soon as it is parsed.
  // `load` alone would wait for every subresource, so one slow image would hold
  // the frame at its CSS height until then.
  $: if (frame && doc) watchForPage();

  function watchForPage(): void {
    cancelAnimationFrame(hookRequest);
    let frames = 0;
    const poll = (): void => {
      if (!hookNewPage() && ++frames < 600) hookRequest = requestAnimationFrame(poll);
    };
    hookRequest = requestAnimationFrame(poll);
  }

  // Hook the frame's document when it is a parsed srcdoc page not hooked yet.
  // The page's own size changes arrive as its events (an image or font landing,
  // an opened <details>, a checkbox-driven CSS state), not through a
  // ResizeObserver on its root: observing another document's element from here
  // trips the observer's loop error.
  function hookNewPage(): boolean {
    const next = frame.contentDocument;
    if (!next || next === page || next.URL !== "about:srcdoc" || next.readyState === "loading") return false;
    page = next;
    for (const type of ["load", "toggle", "change"]) next.addEventListener(type, scheduleFit, true);
    next.fonts.addEventListener("loadingdone", scheduleFit);
    if (onWheel) next.addEventListener("wheel", onWheel, { passive: false });
    if (onKeydown) next.addEventListener("keydown", onKeydown);
    fitCanvasFrame(frame);
    return true;
  }

  // Never before the first page is hooked: the frame's initial about:blank would
  // collapse it to nothing until the page arrived.
  function scheduleFit(): void {
    if (fitRequest) return;
    fitRequest = requestAnimationFrame(() => {
      fitRequest = 0;
      if (page) fitCanvasFrame(frame);
    });
  }

  // The frame's own `load` (every subresource in) refits too, and hooks a page
  // the poll has not reached yet.
  function onLoad(): void {
    if (hookNewPage()) cancelAnimationFrame(hookRequest);
    else scheduleFit();
  }

  onMount(() => {
    // A new width (panel drag, collapse/expand) reflows the page. The fit's own
    // height changes land here too and are skipped.
    observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      scheduleFit();
    });
    observer.observe(frame);
  });

  onDestroy(() => {
    cancelAnimationFrame(hookRequest);
    cancelAnimationFrame(fitRequest);
    observer?.disconnect();
  });
</script>

<iframe bind:this={frame} class="canvas-html-frame" {title} sandbox="allow-same-origin" srcdoc={doc} on:load={onLoad}></iframe>
