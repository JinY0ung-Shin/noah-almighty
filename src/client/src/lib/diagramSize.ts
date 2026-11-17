// How large a drawing is, and how small a diagram may be shown — shared by
// what draws one (lib/mermaidBlock.ts, CanvasTab, WidgetSvg) and the 크게 보기
// view (lib/zoomViewer.ts, a lazy chunk: this file is what they need before
// anyone asks for the viewer).

/**
 * The smallest a diagram is shown at unasked, of the size mermaid drew it at
 * (labels are 16px there, so this keeps them near 10px): the answer's
 * fit-to-width stops here and scrolls, and the viewer does not open below it.
 */
export const MIN_READABLE_SCALE = 0.6;

/**
 * The size a drawing is drawn at when nothing shrinks it, in CSS px. Pixel
 * `width`/`height` attributes say it outright; one of them plus a `viewBox`
 * gives the other by the box's ratio (an inline <svg>: `viewBox="0 0 100 100"
 * width="140"` is 140×140); a `viewBox` alone is its own size (mermaid sizes a
 * diagram by one, with `width="100%"`). Null when it states none of these.
 */
export function svgNaturalSize(svg: Pick<Element, "getAttribute"> | null | undefined): { width: number; height: number } | null {
  if (!svg) return null;
  const px = (name: string): number => {
    const value = (svg.getAttribute(name) || "").trim();
    return /^\d+(\.\d+)?(px)?$/.test(value) ? Number.parseFloat(value) : 0;
  };
  const width = px("width");
  const height = px("height");
  if (width > 0 && height > 0) return { width, height };
  const box = (svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box.length !== 4 || !box.every(Number.isFinite) || !(box[2]! > 0 && box[3]! > 0)) return null;
  if (width > 0) return { width, height: (width * box[3]!) / box[2]! };
  if (height > 0) return { width: (height * box[2]!) / box[3]!, height };
  return { width: box[2]!, height: box[3]! };
}
