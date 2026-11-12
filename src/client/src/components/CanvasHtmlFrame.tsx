import { useEffect, useRef } from "react";
import { fitCanvasFrame } from "../lib/canvasHtml";
import { useLatest } from "../lib/hooks";

// One canvas `html` artifact as its own sandboxed page (lib/canvasHtml.ts builds
// `doc`). The sandbox never gets `allow-scripts`: `allow-same-origin` alone is
// what lets fitCanvasFrame read the page and same-origin images load, and with
// scripts off the page itself can do nothing with it.
export interface CanvasHtmlFrameProps {
  doc: string;
  title: string;
  // Events inside the page never reach the app's DOM, so the fullscreen view
  // forwards the ones it handles (wheel zoom, Escape) through these.
  onWheel?: (event: WheelEvent) => void;
  onKeydown?: (event: KeyboardEvent) => void;
}

export default function CanvasHtmlFrame({ doc, title, onWheel, onKeydown }: CanvasHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const page = useRef<Document | null>(null); // the parsed srcdoc document currently hooked
  const hookRequest = useRef(0);
  const fitRequest = useRef(0);
  // A page is hooked long after the render that passed these, and stays hooked
  // across renders: its listeners call whatever the latest render handed in.
  const onWheelRef = useLatest(onWheel);
  const onKeydownRef = useLatest(onKeydown);

  // Never before the first page is hooked: the frame's initial about:blank would
  // collapse it to nothing until the page arrived.
  function scheduleFit(): void {
    if (fitRequest.current) return;
    fitRequest.current = requestAnimationFrame(() => {
      fitRequest.current = 0;
      const frame = frameRef.current;
      if (page.current && frame) fitCanvasFrame(frame);
    });
  }
  // The page's listeners are added once per document: one stable function.
  const scheduleFitRef = useRef(scheduleFit);

  // Hook the frame's document when it is a parsed srcdoc page not hooked yet.
  // The page's own size changes arrive as its events (an image or font landing,
  // an opened <details>, a checkbox-driven CSS state), not through a
  // ResizeObserver on its root: observing another document's element from here
  // trips the observer's loop error.
  function hookNewPage(): boolean {
    const frame = frameRef.current;
    if (!frame) return false;
    const next = frame.contentDocument;
    if (!next || next === page.current || next.URL !== "about:srcdoc" || next.readyState === "loading") return false;
    page.current = next;
    const fit = scheduleFitRef.current;
    for (const type of ["load", "toggle", "change"]) next.addEventListener(type, fit, true);
    next.fonts.addEventListener("loadingdone", fit);
    if (onWheelRef.current) next.addEventListener("wheel", (event) => onWheelRef.current?.(event), { passive: false });
    if (onKeydownRef.current) next.addEventListener("keydown", (event) => onKeydownRef.current?.(event));
    fitCanvasFrame(frame);
    return true;
  }
  const hookNewPageRef = useRef(hookNewPage);

  // A srcdoc change parses into a NEW document: hook it as soon as it is parsed.
  // `load` alone would wait for every subresource, so one slow image would hold
  // the frame at its CSS height until then.
  useEffect(() => {
    if (!frameRef.current || !doc) return;
    cancelAnimationFrame(hookRequest.current);
    let frames = 0;
    const poll = (): void => {
      if (!hookNewPageRef.current() && ++frames < 600) hookRequest.current = requestAnimationFrame(poll);
    };
    hookRequest.current = requestAnimationFrame(poll);
  }, [doc]);

  // The frame's own `load` (every subresource in) refits too, and hooks a page
  // the poll has not reached yet.
  function onLoad(): void {
    if (hookNewPage()) cancelAnimationFrame(hookRequest.current);
    else scheduleFit();
  }

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let width = 0;
    // A new width (panel drag, collapse/expand) reflows the page. The fit's own
    // height changes land here too and are skipped.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      scheduleFitRef.current();
    });
    observer.observe(frame);
    return () => {
      cancelAnimationFrame(hookRequest.current);
      cancelAnimationFrame(fitRequest.current);
      observer.disconnect();
    };
  }, []);

  return (
    <iframe
      ref={frameRef}
      className="canvas-html-frame"
      title={title}
      sandbox="allow-same-origin"
      srcDoc={doc}
      onLoad={onLoad}
    ></iframe>
  );
}
