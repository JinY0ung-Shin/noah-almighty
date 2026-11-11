// The second wall around a widget's `<svg>`.
//
// The shared library already built the drawing from allowlisted elements and
// REBUILT attribute values (`shared/widget/svg.ts`, `svgRender.ts`). The markup
// it prints still goes through DOMPurify's svg profile here before it is
// parsed — tightened to the same allowlist, on an instance of its own so the
// hook below never touches the app's other sanitizing. If a hostile element or
// value ever got past the first wall, it is stripped at this one.
import createDOMPurify from "dompurify";

import { SVG_ELEMENTS, SVG_TAGS } from "../../../shared/widget/index";

type Purifier = ReturnType<typeof createDOMPurify>;

// Everything the svg profile would let through that a widget drawing never contains.
const FORBID_TAGS = [
  "a",
  "altglyph",
  "altglyphdef",
  "altglyphitem",
  "animate",
  "animatecolor",
  "animatemotion",
  "animatetransform",
  "discard",
  "filter",
  "font",
  "foreignobject",
  "glyph",
  "glyphref",
  "hkern",
  "image",
  "metadata",
  "mpath",
  "script",
  "set",
  "style",
  "switch",
  "symbol",
  "textpath",
  "tref",
  "use",
  "view",
  "vkern",
];
const FORBID_ATTR = ["style", "class", "href", "xlink:href", "src", "xmlns:xlink"];

// Root attributes the renderer writes itself, plus every attribute of the allowlist.
const KNOWN_ATTRS = new Set<string>(["viewbox", "width", "fill"]);
for (const tag of SVG_TAGS) for (const name of Object.keys(SVG_ELEMENTS[tag].attrs)) KNOWN_ATTRS.add(name.toLowerCase());
const KNOWN_TAGS = new Set<string>(["svg", ...SVG_TAGS.map((tag) => tag.toLowerCase())]);

/** A value that could reach outside the drawing: any `url(` but `url(#id)`, a scheme, a backslash or a control character. */
function reachesOut(value: string): boolean {
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return true;
  if (/url\s*\(/i.test(value) && !/^url\(#[A-Za-z][A-Za-z0-9_-]*\)$/.test(value)) return true;
  return /(?:javascript|data|vbscript|https?|file|blob)\s*:/i.test(value) || /@import|expression\s*\(|image-set\s*\(/i.test(value);
}

let purifier: Purifier | null = null;

function instance(): Purifier {
  if (purifier) return purifier;
  const created = createDOMPurify(window);
  created.addHook("uponSanitizeElement", (node, data) => {
    // Text and comments have no tag of their own, and the walk starts at the
    // <body> DOMPurify parsed the markup into; anything else must be on the allowlist.
    const tag = data.tagName.toLowerCase();
    if (tag.startsWith("#") || tag === "body") return;
    if (!KNOWN_TAGS.has(tag)) (node as Element).parentNode?.removeChild(node);
  });
  created.addHook("uponSanitizeAttribute", (_node, data) => {
    if (!KNOWN_ATTRS.has(data.attrName.toLowerCase()) || reachesOut(data.attrValue)) data.keepAttr = false;
  });
  purifier = created;
  return created;
}

/** Sanitize the markup of ONE widget drawing (`svgMarkup`). The result is drawn in a shadow root (`shadowSvg`). */
export function sanitizeWidgetSvg(markup: string): string {
  if (!markup) return "";
  return instance().sanitize(markup, {
    USE_PROFILES: { svg: true },
    // On the widget's allowlist but not in DOMPurify's svg profile (a test fails when the two drift).
    ADD_ATTR: ["vector-effect"],
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
