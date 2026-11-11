import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { copyText } from "../lib/dom";
import { formatFileSize } from "../lib/format";
import { getGraphViewer, isDrawioAttachment, loadGraphViewer } from "../lib/drawioViewer";
import { useLatest } from "../lib/hooks";
import { isPptxCard } from "../../../shared/shareLinks";
import type { ChatPane, MessageAttachment, PaneFileTab } from "../lib/types";

// ONE shared file opened as a tab of the side panel (SidePanel): a file-card
// click opens it, and a live .drawio share opens itself once. Slides are the
// hidden image attachments on the SAME assistant message (server-auto-rendered
// on share_file, or skill-published); .drawio files render as an interactive
// diagram via the vendored viewer (lib/drawioViewer); other formats without
// slides still get the card with the download. The instance stays mounted
// while another tab shows, so a diagram is fetched and laid out once.
export interface FileTabProps {
  pane: ChatPane;
  file: PaneFileTab;
  /** This tab is the one the panel shows. */
  active?: boolean;
  /**
   * 공유 링크 hands the card to ChatView, whose ONE dialog serves both entry
   * points. The dialog must not live in this tab: closing the tab (or the
   * panel losing its last tab) unmounts it, and the unmount would take an open
   * dialog with it — mid-create too, leaving a new link whose URL is never shown.
   */
  onShare?: (attachment: MessageAttachment) => void;
}

type DrawioStatus = "loading" | "ready" | "error";

// Above this the tab would freeze on res.text() + a synchronous render; the
// card falls back to the download-only error copy instead (server cap is 30 MB).
const DRAWIO_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

function slideSrc(conversationId: string, att: MessageAttachment): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/images/${encodeURIComponent(att.id)}`;
}

function downloadHref(conversationId: string, att: MessageAttachment): string {
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(att.id)}`;
  return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
}

export default function FileTab({ pane, file, active = false, onShare = () => {} }: FileTabProps) {
  const attachment = file.attachment;
  const slides = file.slides ?? [];
  const name = attachment.name || "파일";
  // 공유 링크: PPTX decks only.
  const shareable = isPptxCard(attachment);
  // A card still streaming has no persisted message the server can find yet.
  const shareLive = Boolean(pane.streaming && (pane.liveAttachments ?? []).some((att) => att.id === attachment.id));

  function share(): void {
    onShare(attachment);
  }

  /* ---- draw.io diagram rendering (interactive, client-side) ---- */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const drawioHost = useRef<HTMLDivElement | null>(null);
  // Shown in the markup AND read later (the observer, the repaint timer, the
  // fetch landing): state for the render, the ref for the late reads.
  const [drawioStatus, setDrawioStatusState] = useState<DrawioStatus>("loading");
  const drawioStatusRef = useRef<DrawioStatus>("loading");
  const drawioXml = useRef("");
  const drawioFor = useRef(""); // attachment id the fetched XML belongs to
  const drawioToken = useRef(0); // guards async fetch/load against a newer open (canvas pattern)
  const paintedWidth = useRef(0);
  const repaintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRef = useLatest(active);

  function setDrawioStatus(next: DrawioStatus): void {
    drawioStatusRef.current = next;
    setDrawioStatusState(next);
  }

  const drawioAtt = isDrawioAttachment(attachment) ? attachment : null;
  const drawioId = drawioAtt?.id ?? "";

  async function openDrawio(att: MessageAttachment): Promise<void> {
    const token = ++drawioToken.current;
    drawioFor.current = att.id;
    setDrawioStatus("loading");
    drawioXml.current = "";
    paintedWidth.current = 0;
    if (drawioHost.current) drawioHost.current.innerHTML = "";
    if ((att.size ?? 0) > DRAWIO_MAX_PREVIEW_BYTES) {
      setDrawioStatus("error");
      return;
    }
    try {
      const fileHref = `/api/conversations/${encodeURIComponent(pane.conversationId)}/files/${encodeURIComponent(att.id)}`;
      const [, res] = await Promise.all([loadGraphViewer(), fetch(fileHref, { credentials: "same-origin" })]);
      if (!res.ok) throw new Error(`file fetch failed: ${res.status}`);
      const xml = await res.text();
      if (token !== drawioToken.current) return;
      if (!/<mx(?:GraphModel|file)[\s>]/.test(xml)) throw new Error("not an mxfile");
      drawioXml.current = xml;
      // let the host div mount before painting into it
      flushSync(() => setDrawioStatus("ready"));
      paintIfStale();
    } catch {
      if (token === drawioToken.current) setDrawioStatus("error");
    }
  }

  // The viewer lays out for the width it was created at, so it paints only
  // into a body that has one: a hidden tab or a collapsed panel measures 0, and
  // the observer paints once the body shows.
  function paintIfStale(): void {
    const bodyEl = bodyRef.current;
    if (!activeRef.current || drawioStatusRef.current !== "ready" || !bodyEl) return;
    const width = bodyEl.clientWidth;
    if (width <= 0 || Math.abs(width - paintedWidth.current) <= 1) return;
    paintDrawio(width);
  }

  function paintDrawio(width: number): void {
    // Every paint cancels a pending repaint, or a resize settling right after
    // the first open would paint twice, 200ms apart.
    clearTimeout(repaintTimer.current);
    const viewer = getGraphViewer();
    const host = drawioHost.current;
    if (!viewer || !host || !drawioXml.current) return;
    host.innerHTML = "";
    const target = document.createElement("div");
    // No `mxgraph` class on purpose: the script's load-time auto-processing
    // must not race our explicit createViewerForElement call.
    target.setAttribute(
      "data-mxgraph",
      JSON.stringify({ xml: drawioXml.current, nav: true, toolbar: "pages zoom layers", "toolbar-nohide": true }),
    );
    host.append(target);
    paintedWidth.current = width;
    try {
      viewer.createViewerForElement(target);
    } catch {
      setDrawioStatus("error");
    }
  }

  // Debounced so a drag gesture (or a window resize) repaints once at settle:
  // GraphViewer has no destroy(), so each paint strands one matchMedia
  // listener — bounded to one per gesture, not one per resize tick. The very
  // first paint of a tab that just became visible needs no wait.
  function onBodyResize(): void {
    if (drawioStatusRef.current !== "ready") return;
    if (!paintedWidth.current) {
      paintIfStale();
      return;
    }
    clearTimeout(repaintTimer.current);
    repaintTimer.current = setTimeout(paintIfStale, 200);
  }
  // The observer is created once; everything it reaches reads through refs.
  const onBodyResizeRef = useRef(onBodyResize);

  useLayoutEffect(() => {
    if (drawioAtt && drawioAtt.id !== drawioFor.current) void openDrawio(drawioAtt);
    // Keyed on the attachment's id: the attachment object itself is store state, mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawioId]);

  // Shown again: lay the diagram out if the width it was drawn for changed
  // while the tab was hidden (or it was never drawn — opened in the background).
  useLayoutEffect(() => {
    if (active) paintIfStale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const bodyEl = bodyRef.current;
    const observer = bodyEl ? new ResizeObserver(() => onBodyResizeRef.current()) : null;
    if (bodyEl) observer?.observe(bodyEl);
    return () => {
      drawioToken.current += 1;
      clearTimeout(repaintTimer.current);
      observer?.disconnect();
    };
  }, []);

  const sizeLabel = formatFileSize(attachment.size);

  return (
    <div className="canvas-card file-tab">
      <div className="canvas-card-top">
        <div className="file-tab-title">
          <div className="canvas-title" title={name}>
            {name}
          </div>
          {sizeLabel ? <span className="muted file-tab-size">{sizeLabel}</span> : null}
        </div>
        <div className="canvas-toolbar">
          {drawioAtt ? (
            <button
              className="canvas-tool-btn"
              type="button"
              aria-label="XML 텍스트 복사"
              title="다이어그램 XML을 텍스트로 복사"
              disabled={drawioStatus !== "ready"}
              onClick={(event) => void copyText(drawioXml.current, event.currentTarget)}
            >
              복사
            </button>
          ) : null}
          {shareable ? (
            <button
              className="canvas-tool-btn"
              type="button"
              disabled={shareLive}
              title={shareLive ? "응답이 끝난 뒤 만들 수 있습니다." : undefined}
              onClick={share}
            >
              공유 링크
            </button>
          ) : null}
          {/* draggable=false: a link styled as a button must not start a native
              link-drag when the pointer moves during the press. */}
          <a
            className="canvas-tool-btn"
            href={downloadHref(pane.conversationId, attachment)}
            download={attachment.name || undefined}
            draggable={false}
          >
            다운로드
          </a>
        </div>
      </div>
      <div className="canvas-content file-tab-body" ref={bodyRef}>
        {drawioAtt ? (
          drawioStatus === "error" ? (
            <p className="muted">다이어그램을 표시할 수 없습니다. 다운로드해서 draw.io에서 열어 주세요.</p>
          ) : (
            <>
              {drawioStatus === "loading" ? <p className="muted">다이어그램을 불러오는 중…</p> : null}
              {/* Never given children: the viewer paints into it by hand. */}
              <div className="file-preview-drawio" ref={drawioHost}></div>
            </>
          )
        ) : slides.length ? (
          slides.map((slide, index) => (
            <figure className="file-preview-slide" key={slide.id}>
              <img src={slideSrc(pane.conversationId, slide)} alt={slide.name || `슬라이드 ${index + 1}`} loading="lazy" />
              {/* A page counter under a single image (screenshot, one-page pdf) is noise. */}
              {slides.length > 1 ? (
                <figcaption className="muted">
                  슬라이드 {index + 1} / {slides.length}
                </figcaption>
              ) : null}
            </figure>
          ))
        ) : (
          <p className="muted">이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.</p>
        )}
      </div>
    </div>
  );
}
