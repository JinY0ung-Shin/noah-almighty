// CSP-safe canvas export helpers (#50). Everything here operates on the ALREADY
// DOMPurify-sanitized rendered SVG (for svg/mermaid) or the source text (for
// markdown/html). No avatar-authored JS ever runs: we serialize an existing <svg>
// element, draw it through an <img> with a `data:` URL (allowed by `img-src 'self'
// data:` in app.ts), and read the pixels back off a 2D canvas — no `Function`
// constructor, no `eval`, no `fetch`/remote/`blob:` load. The strict same-origin CSP
// (`script-src 'self'`/`connect-src 'self'`) stays intact: downloads use an
// `<a href="data:">` (not governed by connect-src) and clipboard copy reads the
// Blob straight off the canvas via `toBlob` (no `fetch('data:…')`, which
// `connect-src 'self'` could otherwise block — `data:` is an opaque origin).

import { notify } from "./state";

/** Trigger a browser download of `data` (a data: URL) under `filename`. */
function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

/** Slugify a canvas title into a safe filename stem (ASCII + Hangul kept). */
function fileStem(title: string): string {
  const cleaned = (title || "canvas").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-").slice(0, 60);
  return cleaned || "canvas";
}

/** Serialize an <svg> element to a standalone, namespaced SVG string. */
function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(clone);
}

/** Encode a UTF-8 string as a base64 data: URL of the given mime type. */
function toDataUrl(text: string, mime: string): string {
  // btoa needs Latin-1; encode UTF-8 first so Hangul/emoji in labels survive.
  const b64 = btoa(unescape(encodeURIComponent(text)));
  return `data:${mime};base64,${b64}`;
}

/** Read the artifact's intrinsic pixel size from the SVG (viewBox or width/height). */
function svgPixelSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox?.baseVal;
  let width = vb && vb.width ? vb.width : 0;
  let height = vb && vb.height ? vb.height : 0;
  if (!width || !height) {
    const rect = svg.getBoundingClientRect();
    width = width || rect.width || 640;
    height = height || rect.height || 480;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/** Download the given SVG element as a .svg file. */
export function downloadSvg(svg: SVGSVGElement, title: string): void {
  downloadDataUrl(toDataUrl(serializeSvg(svg), "image/svg+xml"), `${fileStem(title)}.svg`);
}

/**
 * Rasterize an <svg> to PNG and trigger a download. Paints a solid background
 * (the theme's --bg) first so a transparent chart isn't exported on black.
 * Returns false (and notifies) if rendering failed.
 */
export async function downloadPng(svg: SVGSVGElement, title: string): Promise<boolean> {
  try {
    const blobUrl = await svgToPngDataUrl(svg);
    downloadDataUrl(blobUrl, `${fileStem(title)}.png`);
    return true;
  } catch {
    notify("PNG로 저장하지 못했습니다.", "warn");
    return false;
  }
}

/** Copy the rendered chart as a PNG image to the clipboard (with graceful fallback). */
export async function copyPng(svg: SVGSVGElement): Promise<boolean> {
  try {
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!navigator.clipboard?.write || !ClipboardItemCtor) {
      return false;
    }
    // Read the Blob straight off the canvas — no `fetch('data:…')`, which a strict
    // `connect-src 'self'` could block (data: is an opaque origin, not same-origin).
    const canvas = await svgToPngCanvas(svg);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

/** SVG element → PNG data URL (download path; `<a href="data:">` is CSP-irrelevant). */
async function svgToPngDataUrl(svg: SVGSVGElement): Promise<string> {
  return (await svgToPngCanvas(svg)).toDataURL("image/png");
}

/** Core rasterizer: SVG element → a painted 2D <canvas> via an <img> + `data:` URL. */
async function svgToPngCanvas(svg: SVGSVGElement): Promise<HTMLCanvasElement> {
  const { width, height } = svgPixelSize(svg);
  const scale = Math.min(window.devicePixelRatio || 1, 3);
  const svgUrl = toDataUrl(serializeSvg(svg), "image/svg+xml");
  const img = new Image();
  img.width = width;
  img.height = height;
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("svg image load failed"));
    img.src = svgUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // Fill the theme background so transparent SVGs don't render on black.
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#ffffff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}
