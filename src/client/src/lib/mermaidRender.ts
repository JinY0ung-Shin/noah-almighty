// Mermaid source → a sanitized SVG string, for the `mermaid` canvas (CanvasTab)
// and a ```mermaid block of an answer (lib/mermaidBlock.ts) alike.
//
// CSP-safe: `securityLevel: "strict"`, labels as SVG <text> and DOMPurify's svg
// profile on the way out. Draw the result in a shadow root (`shadowSvg`): mermaid
// ships an id-scoped <style> with every diagram, and it bakes the theme's colours
// in — so render again on a theme flip.
import DOMPurify from "dompurify";

/** The library did not load (a lazy chunk): nothing about the SOURCE is known. */
export class MermaidLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error && cause.message ? cause.message : "the mermaid library did not load");
    this.name = "MermaidLoadError";
  }
}

let renders = 0;

/**
 * Throws `MermaidLoadError` when the library cannot be loaded, and mermaid's own
 * error (a parse or layout error — its message names the line) for a source it
 * cannot draw.
 */
export async function renderMermaidSvg(source: string, dark: boolean): Promise<string> {
  let mermaid: typeof import("mermaid").default;
  try {
    mermaid = (await import("mermaid")).default;
  } catch (err) {
    throw new MermaidLoadError(err);
  }
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
    // Labels as SVG <text>: by default flowchart/class/state/ER/mindmap/kanban
    // put them in <foreignObject> HTML, which the svg-profile sanitize below
    // strips — every node rendered as an empty box.
    htmlLabels: false,
    // A source that does not parse THROWS. Without this mermaid draws its
    // "Syntax error in text" picture into a temporary element under <body> and
    // leaves it there — at the bottom of the app, for every failed diagram.
    suppressErrorRendering: true,
  });
  const id = `noah-mmd-${++renders}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  } finally {
    // Mermaid's temporary render target (`d<id>`), should a failure leave it.
    if (typeof document !== "undefined") document.getElementById(`d${id}`)?.remove();
  }
}
