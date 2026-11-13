import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getGraphViewer, loadGraphViewer } from "../lib/drawioViewer";
import { useLatest } from "../lib/hooks";

// A draw.io diagram drawn from its XML by the vendored viewer
// (lib/drawioViewer) — the workspace file preview's `.drawio`. The same paint
// rules as FileTab's diagram (which keeps its own copy, tied to its attachment
// fetch): the viewer lays out for the width it was created at, so it paints
// only into a box that has one (a hidden tab or a collapsed panel measures 0)
// and repaints, debounced, when that width changes. GraphViewer has no
// destroy(): each paint strands one matchMedia listener, so a drag repaints
// once at settle, not per tick.
export interface DrawioDiagramProps {
  xml: string;
  /** The tab holding it is the one the panel shows. */
  active: boolean;
}

type Status = "loading" | "ready" | "error";

export default function DrawioDiagram({ xml, active }: DrawioDiagramProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatusState] = useState<Status>("loading");
  const statusRef = useRef<Status>("loading");
  const paintedWidth = useRef(0);
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const token = useRef(0);
  const activeRef = useLatest(active);
  const xmlRef = useLatest(xml);

  function setStatus(next: Status): void {
    statusRef.current = next;
    setStatusState(next);
  }

  function paintIfStale(): void {
    const box = boxRef.current;
    if (!activeRef.current || statusRef.current !== "ready" || !box) return;
    const width = box.clientWidth;
    if (width <= 0 || Math.abs(width - paintedWidth.current) <= 1) return;
    clearTimeout(repaintTimer.current);
    const viewer = getGraphViewer();
    const host = hostRef.current;
    if (!viewer || !host) return;
    host.innerHTML = "";
    const target = document.createElement("div");
    // No `mxgraph` class on purpose: the script's load-time auto-processing
    // must not race the explicit createViewerForElement call.
    target.setAttribute(
      "data-mxgraph",
      JSON.stringify({ xml: xmlRef.current, nav: true, toolbar: "pages zoom layers", "toolbar-nohide": true }),
    );
    host.append(target);
    paintedWidth.current = width;
    try {
      viewer.createViewerForElement(target);
    } catch {
      setStatus("error");
    }
  }
  // The observer and the load below are set up once; they read the latest closure.
  const paintRef = useLatest(paintIfStale);

  useEffect(() => {
    const mine = ++token.current;
    paintedWidth.current = 0;
    if (hostRef.current) hostRef.current.innerHTML = "";
    if (!/<mx(?:GraphModel|file)[\s>]/.test(xml)) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    loadGraphViewer().then(
      () => {
        if (mine !== token.current) return;
        setStatus("ready");
        // The host is in the DOM in every status; paint once the state landed.
        requestAnimationFrame(() => {
          if (mine === token.current) paintRef.current();
        });
      },
      () => {
        if (mine === token.current) setStatus("error");
      },
    );
    return () => {
      token.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml]);

  // Shown again: lay out if the width changed while hidden (or it was never drawn).
  useLayoutEffect(() => {
    if (active) paintRef.current();
  }, [active]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (statusRef.current !== "ready") return;
      if (!paintedWidth.current) {
        paintRef.current();
        return;
      }
      clearTimeout(repaintTimer.current);
      repaintTimer.current = setTimeout(() => paintRef.current(), 200);
    });
    observer.observe(box);
    return () => {
      clearTimeout(repaintTimer.current);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={boxRef}>
      {status === "error" ? (
        <p className="muted">다이어그램을 표시할 수 없습니다. 다운로드해서 draw.io에서 열어 주세요.</p>
      ) : status === "loading" ? (
        <p className="muted">다이어그램을 불러오는 중…</p>
      ) : null}
      {/* Never given children: the viewer paints into it by hand. */}
      <div className="file-preview-drawio" ref={hostRef} hidden={status !== "ready"}></div>
    </div>
  );
}
