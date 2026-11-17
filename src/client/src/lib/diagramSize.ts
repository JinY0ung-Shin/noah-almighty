// How large a drawn diagram is, and how small it may be shown — shared by the
// ```mermaid block of an answer (lib/mermaidBlock.ts) and its 크게 보기 view
// (lib/diagramViewer.ts, a lazy chunk: this file is what the block needs of it
// before anyone asks for the viewer).

/**
 * The smallest a diagram is shown at unasked, of the size mermaid drew it at
 * (labels are 16px there, so this keeps them near 10px): the answer's
 * fit-to-width stops here and scrolls, and the viewer does not open below it.
 */
export const MIN_READABLE_SCALE = 0.6;

/**
 * The size a drawing was drawn at, in CSS px: its `viewBox` (mermaid sizes every
 * diagram by one), else numeric `width`/`height` attributes. Null when it states neither.
 */
export function svgNaturalSize(svg: Element | null | undefined): { width: number; height: number } | null {
  if (!svg) return null;
  const box = (svg.getAttribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box.length === 4 && box[2]! > 0 && box[3]! > 0 && box.every(Number.isFinite)) return { width: box[2]!, height: box[3]! };
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  return width > 0 && height > 0 ? { width, height } : null;
}
