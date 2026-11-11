// The top-level prose of a canvas widget: Markdown, and ONLY what Markdown
// itself produces.
//
// `renderMarkdown` keeps raw HTML with its `class` / `id` (fine for a chat
// bubble); inside a widget that let the avatar's prose put app-styled elements
// next to real controls — `<div class="canvas-fs">` over the panel, a look-alike
// `<button class="btn btn-primary wg-submit">`, a password field. So the
// allowlist here is the tags a Markdown document compiles to, and no attribute
// except a table cell's alignment: no class, id, style or src. An image, a form
// control or any other element is dropped, its text content kept.
//
// A LINK is kept when its target is an absolute http(s) URL (the shared
// `safeLinkUrl`: no javascript:, data:, relative or protocol-relative address).
// It then carries exactly four attributes, all written here — the normalized
// href, a new tab, no opener/referrer, and the address as its tooltip. A link
// with any other target loses its href and is left as text.
import DOMPurify from "dompurify";
import { marked } from "marked";

import { safeLinkUrl } from "../../../shared/widget/index";

const PROSE_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "a",
];

/** Sanitized HTML for a widget's static top-level Markdown. */
export function renderWidgetProse(text: string | null | undefined): string {
  const source = text || "";
  const clean = DOMPurify.sanitize(marked.parse(source) as string, {
    ALLOWED_TAGS: PROSE_TAGS,
    ALLOWED_ATTR: ["align", "href"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  if (!clean.includes("<a")) return clean;
  // Every anchor is rewritten from its href alone: DOMPurify's own URL rule is
  // wider than a widget's (mailto:, relative paths, …).
  const holder = document.createElement("template");
  holder.innerHTML = clean;
  for (const anchor of Array.from(holder.content.querySelectorAll("a"))) {
    const href = safeLinkUrl(anchor.getAttribute("href"));
    for (const name of anchor.getAttributeNames()) anchor.removeAttribute(name);
    if (!href) continue;
    anchor.setAttribute("href", href);
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("title", href);
  }
  return holder.innerHTML;
}
