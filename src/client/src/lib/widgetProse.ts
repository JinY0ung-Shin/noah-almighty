// The top-level prose of a canvas widget: Markdown, and ONLY what Markdown
// itself produces.
//
// `renderMarkdown` keeps raw HTML with its `class` / `id` (fine for a chat
// bubble); inside a widget that let the avatar's prose put app-styled elements
// next to real controls — `<div class="canvas-fs">` over the panel, a look-alike
// `<button class="btn btn-primary wg-submit">`, a link that opens, a password
// field. So the allowlist here is the tags a Markdown document compiles to,
// and no attribute except a table cell's alignment: no class, id, style, href
// or src. A link keeps its TEXT (links in a widget do not open); an image, a
// form control or any other element is dropped, its text content kept.
import DOMPurify from "dompurify";
import { marked } from "marked";

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
];

/** Sanitized HTML for a widget's static top-level Markdown. */
export function renderWidgetProse(text: string | null | undefined): string {
  const source = text || "";
  return DOMPurify.sanitize(marked.parse(source) as string, {
    ALLOWED_TAGS: PROSE_TAGS,
    ALLOWED_ATTR: ["align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
