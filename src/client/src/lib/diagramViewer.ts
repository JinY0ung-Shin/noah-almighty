// 크게 보기: a drawn diagram (lib/mermaidBlock.ts) over the whole window, zoomed
// and moved by the viewer. In the answer a diagram is fitted to the bubble, so a
// wide one is too small to read; here the SAME sanitized SVG gets the screen.
//
// - Imperative DOM under <body>, like the block that opens it (no React tree
//   owns a code block). It is a root dialog like the canvas's fullscreen stage
//   (`.canvas-fs`, whose bar and buttons it wears): the page behind is inert,
//   Tab stays inside, Escape closes, focus goes back to what opened it.
// - The drawing is RESIZED, never CSS-scaled: its host gets `natural × scale`
//   pixels and the browser lays the vector out again, so text stays sharp at
//   any zoom. 100% is the size mermaid drew it at.
// - It opens fitted to the window — but never below `MIN_READABLE_SCALE`, the
//   floor the answer holds too: a diagram too large for that opens at the floor
//   from its start, and 화면에 맞춤 shows it whole.
// - The wheel zooms about the pointer, a drag moves the drawing, a press on the
//   empty stage (not a drag) closes. One viewer at a time.
// - Loaded on the first press (a dynamic import in the block): nothing of it is
//   in the app's first chunk.
// - It outlives the block that opened it (an answer is remounted when it stops
//   streaming); the block hands it a redraw (a theme flip) while it still can.
import { MIN_READABLE_SCALE, svgNaturalSize } from "./diagramSize";
import { isTopDialogLayer, openModalFocus, trapTab } from "./modalBehavior";
import { shadowSvg } from "./shadowSvg";

export interface DiagramViewer {
  /** Show this (already SANITIZED) drawing instead, keeping the zoom and position. */
  update(svg: string): void;
  close(): void;
}

/** The viewer fits a small diagram up to this — a three-box flow is not blown up to fill a monitor. */
const MAX_FIT_SCALE = 2;
const MAX_SCALE = 8;
const MIN_SCALE = 0.2;
const BUTTON_STEP = 1.25;
/** Per wheel pixel: one notch of a mouse wheel (100px) is about 16%. */
const WHEEL_RATE = 0.0015;
const KEY_PAN_PX = 80;
/** Stage edge kept clear when fitting, and how much of the drawing must stay on screen. */
const FIT_MARGIN_PX = 32;
const KEEP_VISIBLE_PX = 64;
/** A press that travels less than this is a click, not a drag. */
const DRAG_SLOP_PX = 4;
const FALLBACK_SIZE = { width: 800, height: 600 };

let openViewer: DiagramViewer | null = null;

function button(doc: Document, text: string, label?: string): HTMLButtonElement {
  const el = doc.createElement("button");
  el.className = "canvas-tool-btn";
  el.type = "button";
  el.textContent = text;
  if (label) el.setAttribute("aria-label", label);
  return el;
}

/** Open the viewer on a SANITIZED svg string (`renderMermaidSvg`'s). `onClose` runs once, however it closes. */
export function openDiagramViewer(svg: string, onClose: () => void = () => {}): DiagramViewer {
  openViewer?.close();
  const doc = document;

  const root = doc.createElement("div");
  root.className = "canvas-fs diagram-viewer";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "다이어그램 크게 보기");

  const bar = doc.createElement("div");
  bar.className = "canvas-fs-bar";
  const title = doc.createElement("span");
  title.className = "canvas-fs-title";
  title.textContent = "다이어그램";
  const hint = doc.createElement("span");
  hint.className = "diagram-viewer-hint";
  hint.textContent = "휠로 확대·축소, 끌어서 이동";
  title.append(hint);
  const tools = doc.createElement("div");
  tools.className = "canvas-fs-zoom";
  const zoomOut = button(doc, "−", "축소");
  const percent = doc.createElement("span");
  percent.className = "diagram-viewer-scale";
  const zoomIn = button(doc, "+", "확대");
  const fitButton = button(doc, "화면에 맞춤");
  const closeButton = button(doc, "닫기");
  closeButton.setAttribute("data-modal-autofocus", "");
  tools.append(zoomOut, percent, zoomIn, fitButton, closeButton);
  bar.append(title, tools);

  const stage = doc.createElement("div");
  stage.className = "diagram-viewer-stage";
  const card = doc.createElement("div");
  card.className = "diagram-viewer-card";
  const host = doc.createElement("div");
  host.className = "diagram-viewer-svg";
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", "Mermaid 다이어그램");
  card.append(host);
  stage.append(card);
  root.append(bar, stage);
  doc.body.append(root);

  const shadow = shadowSvg(host, svg);
  let natural = FALLBACK_SIZE;
  let scale = 1;
  let x = 0;
  let y = 0;
  /** Still as `fit` left it: a resize fits again instead of only keeping it in reach. */
  let fitted = true;
  let closed = false;

  /** The drawing fills its host, whatever size mermaid asked for (`max-width: …px` inline). */
  function adopt(): void {
    const drawn = host.shadowRoot?.querySelector<SVGSVGElement>("svg");
    natural = svgNaturalSize(drawn) ?? FALLBACK_SIZE;
    if (!drawn?.style) return;
    drawn.style.display = "block";
    drawn.style.width = "100%";
    drawn.style.height = "100%";
    drawn.style.maxWidth = "none";
    drawn.style.minWidth = "0";
  }

  const fitScale = (): number => {
    const width = stage.clientWidth - FIT_MARGIN_PX * 2;
    const height = stage.clientHeight - FIT_MARGIN_PX * 2;
    if (width <= 0 || height <= 0) return 1; // not laid out (a hidden window)
    return Math.min(MAX_FIT_SCALE, width / natural.width, height / natural.height);
  };
  // A diagram too large to fit at the ordinary minimum can still be zoomed out to its fit.
  const minScale = (): number => Math.min(MIN_SCALE, fitScale());

  function place(): void {
    const width = natural.width * scale;
    const height = natural.height * scale;
    if (stage.clientWidth > 0 && stage.clientHeight > 0) {
      x = Math.min(stage.clientWidth - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - width, x));
      y = Math.min(stage.clientHeight - KEEP_VISIBLE_PX, Math.max(KEEP_VISIBLE_PX - height, y));
    }
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
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

  /** How it opens: the fit, unless that is too small to read — then the floor, from the drawing's start. */
  function openReadable(): void {
    fit();
    if (scale >= MIN_READABLE_SCALE) return;
    scale = MIN_READABLE_SCALE;
    x = Math.max(FIT_MARGIN_PX, (stage.clientWidth - natural.width * scale) / 2);
    y = Math.max(FIT_MARGIN_PX, (stage.clientHeight - natural.height * scale) / 2);
    fitted = false;
    place();
  }

  /** Zoom by `factor`, keeping the drawing's point under (`cx`, `cy`) — stage coordinates — where it is. */
  function zoomAt(factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2): void {
    const next = Math.min(MAX_SCALE, Math.max(minScale(), scale * factor));
    if (next === scale) return;
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    fitted = false;
    place();
  }

  function pan(dx: number, dy: number): void {
    x += dx;
    y += dy;
    fitted = false;
    place();
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
    onClose();
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
      "0": fit,
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

  // One pointer drags the drawing. A press on the empty stage that did not travel closes.
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
  fitButton.addEventListener("click", fit);
  closeButton.addEventListener("click", close);

  const viewer: DiagramViewer = {
    update(next) {
      if (closed) return;
      shadow.update(next);
      adopt();
      place();
    },
    close,
  };
  openViewer = viewer;

  adopt();
  const releaseFocus = openModalFocus(root);
  openReadable();
  window.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  // The viewer belongs to the screen it was opened on: Back (or any route change) closes it.
  window.addEventListener("hashchange", close);
  window.addEventListener("popstate", close);
  return viewer;
}
