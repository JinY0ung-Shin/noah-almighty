// 크게 보기: one drawing or picture over the whole window, zoomed and moved by
// the viewer. Everything the app fits into a narrow column — a ```mermaid
// diagram of an answer (lib/mermaidBlock.ts), an svg/mermaid canvas
// (CanvasTab), an inline <svg> (WidgetSvg), a page or image of a file tab
// (ZoomableImage) — opens here, so "too small to read" has ONE answer.
//
// - Imperative DOM under <body> (a code block is not owned by any React tree).
//   It is a root dialog like the canvas's fullscreen stage (`.canvas-fs`, whose
//   bar and buttons it wears): the page behind is inert, Tab stays inside,
//   Escape closes, focus goes back to what opened it.
// - The content is RESIZED, never CSS-scaled: its box gets `natural × scale`
//   pixels and the browser lays the vector out again, so text stays sharp at
//   any zoom. 100% is the size it was drawn at (an image: its own pixels).
// - It opens fitted to the window. A caller that knows what 100% means (mermaid
//   draws labels at 16px) passes `minOpenScale`: a diagram too large to fit
//   above it opens at that scale from its start, and 화면에 맞춤 shows it whole.
// - The wheel zooms about the pointer, a drag moves the content, a press on the
//   empty stage (not a drag) closes. One viewer at a time.
// - A lazy chunk: open it through lib/zoomOpener.ts, which loads it on the
//   first press. Nothing of it is in the app's first chunk.
// - It outlives whatever opened it (an answer is remounted when it stops
//   streaming); the opener hands it a redraw (a theme flip) while it still can.
import { svgNaturalSize } from "./diagramSize";
import { isTopDialogLayer, openModalFocus, trapTab } from "./modalBehavior";
import { shadowSvg } from "./shadowSvg";

/** What the viewer shows: already-SANITIZED svg markup, or an image the app itself serves. */
export type ZoomContent =
  | { svg: string }
  | { image: { src: string; alt?: string; width?: number; height?: number } };

export interface ZoomViewerOptions {
  /** The bar's title: what is being looked at. */
  title?: string;
  /** The dialog's accessible name. */
  label?: string;
  /** Do not OPEN below this scale of the drawn size (see the header). */
  minOpenScale?: number;
  /** Runs once, however it closes. */
  onClose?: () => void;
}

export interface ZoomViewer {
  /** Show this instead, keeping the zoom and position. */
  update(content: ZoomContent): void;
  close(): void;
}

/** The viewer fits a small drawing up to this — a three-box flow is not blown up to fill a monitor. */
const MAX_FIT_SCALE = 2;
const MAX_SCALE = 8;
const MIN_SCALE = 0.2;
const BUTTON_STEP = 1.25;
/** Per wheel pixel: one notch of a mouse wheel (100px) is about 16%. */
const WHEEL_RATE = 0.0015;
const KEY_PAN_PX = 80;
/** Stage edge kept clear when fitting, and how much of the content must stay on screen. */
const FIT_MARGIN_PX = 32;
const KEEP_VISIBLE_PX = 64;
/** A press that travels less than this is a click, not a drag. */
const DRAG_SLOP_PX = 4;
const FALLBACK_SIZE = { width: 800, height: 600 };

let openViewer: ZoomViewer | null = null;

function button(doc: Document, text: string, label?: string): HTMLButtonElement {
  const el = doc.createElement("button");
  el.className = "canvas-tool-btn";
  el.type = "button";
  el.textContent = text;
  if (label) el.setAttribute("aria-label", label);
  return el;
}

export function openZoomViewer(content: ZoomContent, options: ZoomViewerOptions = {}): ZoomViewer {
  openViewer?.close();
  const doc = document;
  const name = options.title || "크게 보기";

  const root = doc.createElement("div");
  root.className = "canvas-fs zoom-viewer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", options.label || `${name} 크게 보기`);

  const bar = doc.createElement("div");
  bar.className = "canvas-fs-bar";
  const title = doc.createElement("span");
  title.className = "canvas-fs-title zoom-viewer-title";
  const titleText = doc.createElement("span");
  titleText.className = "zoom-viewer-name";
  titleText.textContent = name;
  const hint = doc.createElement("span");
  hint.className = "zoom-viewer-hint";
  hint.textContent = "휠로 확대·축소, 끌어서 이동";
  title.append(titleText, hint);
  const tools = doc.createElement("div");
  tools.className = "canvas-fs-zoom";
  const zoomOut = button(doc, "−", "축소");
  const percent = doc.createElement("span");
  percent.className = "zoom-viewer-scale";
  const zoomIn = button(doc, "+", "확대");
  const fitButton = button(doc, "화면에 맞춤");
  const closeButton = button(doc, "닫기");
  closeButton.setAttribute("data-modal-autofocus", "");
  tools.append(zoomOut, percent, zoomIn, fitButton, closeButton);
  bar.append(title, tools);

  const stage = doc.createElement("div");
  stage.className = "zoom-viewer-stage";
  const card = doc.createElement("div");
  card.className = "zoom-viewer-card";
  /** The box that is resized; the drawing or the image fills it. */
  const box = doc.createElement("div");
  box.className = "zoom-viewer-content";
  card.append(box);
  stage.append(card);
  root.append(bar, stage);
  doc.body.append(root);

  let natural = FALLBACK_SIZE;
  let scale = 1;
  let x = 0;
  let y = 0;
  /** Still as `fit` left it: a resize fits again instead of only keeping it in reach. */
  let fitted = true;
  /** The viewer has not zoomed or moved it yet: a size learnt late (an image's load) opens it again. */
  let untouched = true;
  let closed = false;

  // ---- content ----
  let svgHost: HTMLElement | null = null;
  let shadow: ReturnType<typeof shadowSvg> | null = null;
  let img: HTMLImageElement | null = null;

  /** The drawing fills the box, whatever size it asked for (mermaid: `max-width: …px` inline). */
  function adoptSvg(): void {
    const drawn = svgHost?.shadowRoot?.querySelector<SVGSVGElement>("svg");
    if (!drawn) {
      natural = FALLBACK_SIZE;
      return;
    }
    let size = svgNaturalSize(drawn);
    if (!size) {
      // It states no size in px (`width="100%"`, or nothing): take the box the browser gives it.
      const laid = drawn.getBoundingClientRect?.();
      if (laid && laid.width > 0 && laid.height > 0) size = { width: laid.width, height: laid.height };
    }
    natural = size ?? FALLBACK_SIZE;
    // Without a viewBox a larger box shows more canvas, not a larger drawing. This copy is the viewer's own.
    if (!drawn.getAttribute("viewBox")) drawn.setAttribute("viewBox", `0 0 ${natural.width} ${natural.height}`);
    if (!drawn.style) return;
    drawn.style.display = "block";
    drawn.style.width = "100%";
    drawn.style.height = "100%";
    drawn.style.maxWidth = "none";
    drawn.style.minWidth = "0";
  }

  function show(next: ZoomContent): void {
    if ("svg" in next) {
      img?.remove();
      img = null;
      if (!svgHost) {
        svgHost = doc.createElement("div");
        svgHost.className = "zoom-viewer-svg";
        svgHost.setAttribute("role", "img");
        svgHost.setAttribute("aria-label", name);
        box.append(svgHost);
        shadow = shadowSvg(svgHost, next.svg);
      } else shadow?.update(next.svg);
      adoptSvg();
      return;
    }
    svgHost?.remove();
    svgHost = null;
    shadow = null;
    const { src, alt, width, height } = next.image;
    if (!img) {
      const made = doc.createElement("img");
      made.className = "zoom-viewer-image";
      made.draggable = false;
      made.addEventListener("load", () => {
        if (closed || img !== made || !(made.naturalWidth > 0 && made.naturalHeight > 0)) return;
        if (natural.width === made.naturalWidth && natural.height === made.naturalHeight) return;
        // The size was not recorded (a workspace file, an older row): the bytes say it.
        natural = { width: made.naturalWidth, height: made.naturalHeight };
        if (untouched) openFitted();
        else place();
      });
      box.append(made);
      img = made;
    }
    img.alt = alt || name;
    if (img.getAttribute("src") !== src) img.src = src;
    natural = width && height && width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE;
  }

  // ---- zoom and position ----
  const fitScale = (): number => {
    const width = stage.clientWidth - FIT_MARGIN_PX * 2;
    const height = stage.clientHeight - FIT_MARGIN_PX * 2;
    if (width <= 0 || height <= 0) return 1; // not laid out (a hidden window)
    return Math.min(MAX_FIT_SCALE, width / natural.width, height / natural.height);
  };
  // Content too large to fit at the ordinary minimum can still be zoomed out to its fit.
  const minScale = (): number => Math.min(MIN_SCALE, fitScale());

  function place(): void {
    const width = natural.width * scale;
    const height = natural.height * scale;
    if (stage.clientWidth > 0 && stage.clientHeight > 0) {
      x = Math.min(stage.clientWidth - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - width, x));
      y = Math.min(stage.clientHeight - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - height, y));
    }
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    card.style.transform = `translate(${x}px, ${y}px)`;
    percent.textContent = `${Math.round(scale * 100)}%`;
    zoomOut.disabled = scale <= minScale() + 1e-6;
    zoomIn.disabled = scale >= MAX_SCALE - 1e-6;
  }

  function fit(): void {
    scale = fitScale();
    x = (stage.clientWidth - natural.width * scale) / 2;
    y = (stage.clientHeight - natural.height * scale) / 2;
    fitted = true;
    place();
  }

  /** How it opens: the fit, unless the opener's floor says that is too small to read — then the floor, from the start. */
  function openFitted(): void {
    fit();
    untouched = true;
    const floor = options.minOpenScale ?? 0;
    if (scale >= floor) return;
    scale = floor;
    x = Math.max(FIT_MARGIN_PX, (stage.clientWidth - natural.width * scale) / 2);
    y = Math.max(FIT_MARGIN_PX, (stage.clientHeight - natural.height * scale) / 2);
    fitted = false;
    place();
  }

  /** Zoom by `factor`, keeping the content's point under (`cx`, `cy`) — stage coordinates — where it is. */
  function zoomAt(factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2): void {
    const next = Math.min(MAX_SCALE, Math.max(minScale(), scale * factor));
    if (next === scale) return;
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    fitted = false;
    untouched = false;
    place();
  }

  function pan(dx: number, dy: number): void {
    x += dx;
    y += dy;
    fitted = false;
    untouched = false;
    place();
  }

  function fitByHand(): void {
    fit();
    untouched = false;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("hashchange", close);
    window.removeEventListener("popstate", close);
    if (openViewer === viewer) openViewer = null;
    root.remove();
    releaseFocus();
    options.onClose?.();
  }

  function onKey(event: KeyboardEvent): void {
    if (!isTopDialogLayer(root)) return; // a dialog opened over the viewer takes the keys
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      trapTab(event, root);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return; // the browser's own zoom
    const moves: Record<string, () => void> = {
      "+": () => zoomAt(BUTTON_STEP),
      "=": () => zoomAt(BUTTON_STEP),
      "-": () => zoomAt(1 / BUTTON_STEP),
      "0": fitByHand,
      ArrowLeft: () => pan(KEY_PAN_PX, 0),
      ArrowRight: () => pan(-KEY_PAN_PX, 0),
      ArrowUp: () => pan(0, KEY_PAN_PX),
      ArrowDown: () => pan(0, -KEY_PAN_PX),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  }

  function onResize(): void {
    if (fitted) fit();
    else place();
  }

  // The wheel zooms, so it must not scroll anything: a listener that may preventDefault.
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * stage.clientHeight : event.deltaY;
      zoomAt(Math.exp(-Math.max(-300, Math.min(300, pixels)) * WHEEL_RATE), event.clientX - bounds.left, event.clientY - bounds.top);
    },
    { passive: false },
  );

  // One pointer drags the content. A press on the empty stage that did not travel closes.
  let drag: { id: number; lastX: number; lastY: number; travelled: number; onEmpty: boolean } | null = null;
  stage.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0) return;
    drag = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY, travelled: 0, onEmpty: !card.contains(event.target as Node) };
    stage.setPointerCapture?.(event.pointerId);
    event.preventDefault(); // no text selection, no native image drag
  });
  stage.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    if (drag.travelled < DRAG_SLOP_PX) return;
    stage.classList.add("is-dragging");
    pan(dx, dy);
  });
  const endDrag = (event: PointerEvent, cancelled: boolean): void => {
    if (!drag || event.pointerId !== drag.id) return;
    const pressedEmpty = !cancelled && drag.onEmpty && drag.travelled < DRAG_SLOP_PX;
    drag = null;
    stage.classList.remove("is-dragging");
    if (pressedEmpty) close();
  };
  stage.addEventListener("pointerup", (event) => endDrag(event, false));
  stage.addEventListener("pointercancel", (event) => endDrag(event, true));

  zoomOut.addEventListener("click", () => zoomAt(1 / BUTTON_STEP));
  zoomIn.addEventListener("click", () => zoomAt(BUTTON_STEP));
  fitButton.addEventListener("click", fitByHand);
  closeButton.addEventListener("click", close);

  const viewer: ZoomViewer = {
    update(next) {
      if (closed) return;
      show(next);
      place();
    },
    close,
  };
  openViewer = viewer;

  show(content);
  const releaseFocus = openModalFocus(root);
  openFitted();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  // The viewer belongs to the screen it was opened on: Back (or any route change) closes it.
  window.addEventListener("hashchange", close);
  window.addEventListener("popstate", close);
  return viewer;
}
