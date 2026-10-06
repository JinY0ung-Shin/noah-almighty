// HTML canvas artifacts (#50) render as their own page in a sandboxed iframe.
//
// The avatar writes canvas HTML as a PAGE: a leading <style> block, often a whole
// <!DOCTYPE html> document, resets on `*`/`body`/`:root`. Rendered through
// {@html} into the app's DOM that broke both ways: DOMPurify's default sanitize
// returns only <body>, so every <style> before the content (which the parser puts
// in <head>) silently vanished, while a later one restyled the WHOLE app. In its
// own document a page's CSS applies to that page alone. The frame is
// `sandbox="allow-same-origin"` and NEVER `allow-scripts`: with scripts off the
// same-origin flag only lets the panel measure the page and load same-origin
// images, and the inherited CSP still blocks every remote load.

import DOMPurify from "dompurify";
import { cssToken } from "./theme";
import type { ResolvedTheme } from "./theme";

// The faces the app declares (the Korean font it bundles for installs without
// one, 00-tokens.css), copied INLINE from its loaded stylesheets: a stylesheet the
// page had to fetch would render-block the frame until it arrived — and leave it
// blank if it never did. The font files themselves load lazily (`swap`).
let appFontFaces = "";
function fontFaceRules(): string {
  if (appFontFaces) return appFontFaces;
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet's rules are unreadable
    }
    for (const rule of Array.from(list)) if (rule instanceof CSSFontFaceRule) rules.push(rule.cssText);
  }
  return (appFontFaces = rules.join("\n"));
}

// The defaults an unstyled page inherited in the panel (app font, text color,
// color scheme), first in <head> so the page's own CSS wins. The background
// stays transparent, so the panel shows through until the page paints its own.
function baseSheet(theme: ResolvedTheme): string {
  const dark = theme === "dark";
  const text = cssToken("--text", dark ? "#e5e7eb" : "#161b21");
  const accent = cssToken("--accent", dark ? "#2dd4bf" : "#0f766e");
  const font = cssToken("--font-sans", "system-ui, sans-serif");
  const size = cssToken("--t-md", "0.9375rem");
  return [
    fontFaceRules(),
    `:root { color-scheme: ${theme}; }`,
    `body { margin: 0; background: transparent; color: ${text}; font-family: ${font}; font-size: ${size}; overflow-wrap: break-word; }`,
    `a { color: ${accent}; }`,
  ].join("\n");
}

/**
 * The `srcdoc` for a canvas `html` artifact: sanitized as a WHOLE document so
 * `<head>` styles survive (scripts and event handlers still go), with the theme
 * base sheet ahead of the page's own styles.
 */
export function canvasHtmlDocument(content: string, theme: ResolvedTheme): string {
  // With WHOLE_DOCUMENT the returned node is the parsed page's <html> element.
  const root = DOMPurify.sanitize(content, { WHOLE_DOCUMENT: true, RETURN_DOM: true }) as HTMLElement;
  const base = root.ownerDocument.createElement("style");
  base.textContent = baseSheet(theme);
  root.querySelector("head")?.prepend(base);
  return `<!DOCTYPE html>${root.outerHTML}`;
}

/**
 * Size the frame to its page. The frame's CSS height is the viewport a page that
 * fills its viewport (`height: 100vh`, `html, body { height: 100% }`, an app shell
 * with its own scrolling panes) keeps; a page that ends above it shrinks the frame
 * to the content, and one that runs past it grows the frame until it fits. Growth
 * stops when it only chases the viewport (`min-height: 100vh` plus padding grows
 * by the same overflow forever) — that page scrolls the small rest itself.
 * Synchronous and deterministic, so a ResizeObserver can refit on every change
 * without ping-pong.
 */
export function fitCanvasFrame(frame: HTMLIFrameElement): void {
  const root = frame.contentDocument?.documentElement;
  if (!root || !frame.getClientRects().length) return; // not loaded, or not rendered (collapsed panel)
  frame.style.height = "";
  let height = frame.clientHeight;
  frame.style.height = `${height}px`;
  // A horizontal scrollbar takes its height out of the page's viewport.
  const scrollbar = (): number => frame.clientHeight - root.clientHeight;
  // Measure with no vertical scrollbar: its gutter would narrow the layout being sized.
  const overflowY = root.style.overflowY;
  root.style.overflowY = "hidden";
  try {
    if (root.scrollHeight <= root.clientHeight) {
      height = Math.min(height, Math.ceil(root.getBoundingClientRect().height) + scrollbar());
      frame.style.height = `${height}px`;
    }
    let lastOverflow = Infinity;
    for (let step = 0; step < 16; step += 1) {
      const overflow = root.scrollHeight + scrollbar() - height;
      if (overflow <= 0 || overflow >= lastOverflow) break;
      lastOverflow = overflow;
      height += overflow;
      frame.style.height = `${height}px`;
    }
  } finally {
    root.style.overflowY = overflowY;
  }
}
