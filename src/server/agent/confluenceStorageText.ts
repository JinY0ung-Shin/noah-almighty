/**
 * Confluence storage format (XHTML plus the `ac:` / `ri:` elements) → compact
 * Markdown-like text, so `get_page` spends the model's budget on what the page
 * SAYS instead of on its markup.
 *
 * Shape: one tolerant tokenizer builds a small tree, one walker renders it.
 * Not a regex pile — nesting (a list in a table cell in a panel) is followed
 * structurally — and not a validating XML parser either: the input is a page
 * someone wrote, so it is UNTRUSTED and may be malformed. The contract:
 *
 * - never throws, always returns text (a parse that goes wrong falls back to a
 *   plain tag strip);
 * - linear in the input: a tag scan stops at the next `<`, nesting is capped at
 *   {@link MAX_DEPTH}, and every regex runs over a bounded tag or a text run;
 * - entities and CDATA are decoded exactly ONCE, and no markup passes through —
 *   an element is rendered or its children are, never its tag;
 * - nothing is dropped silently: an unknown macro keeps its name, parameters
 *   and plain-text body, an unknown element keeps its children. The exceptions
 *   are `<script>`/`<style>` (never content) and XML comments.
 *
 * Output conventions the tool description names: `[image: file.png]`,
 * `[attachment: file.pdf]`, `[page: Title (space KEY)]`, `[user mention]`,
 * `[macro name: params]`, `> **Info: title**` blocks for body macros.
 */

/** Element nesting kept as a tree; deeper markup is flattened into its ancestor. */
const MAX_DEPTH = 64;
/** Table bounds: a hostile `colspan="99999999"` cannot blow up the grid. */
const MAX_TABLE_COLUMNS = 60;
const MAX_ROWSPAN = 500;
/** Per-macro parameter summary bounds. */
const MAX_MACRO_PARAMS = 8;
const MAX_PARAM_CHARS = 120;
const MAX_HREF_CHARS = 500;
/** How a line break inside a table cell is written (a Markdown cell is one line). */
const CELL_BREAK = " ⏎ ";
const MERGED_LEFT = "(←)";
const MERGED_UP = "(↑)";

interface TextNode {
  kind: "text";
  value: string;
}

interface ElementNode {
  kind: "el";
  name: string;
  attrs: Record<string, string>;
  children: StorageNode[];
  /** Cache for {@link isBlock} on elements that are block only by content. */
  block?: boolean;
}

type StorageNode = TextNode | ElementNode;

/** Inline state: which markers are already open, so nested emphasis is not doubled. */
interface InlineContext {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
}

const PLAIN: InlineContext = { bold: false, italic: false, strike: false, code: false };

// ---- entities ------------------------------------------------------------------------------------

/** ISO 8859-1 entity names, in code point order from U+00A0. */
const LATIN1_ENTITIES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";

/** The rest of the XHTML 1.0 entity set (`name:codePoint`). */
const OTHER_ENTITIES =
  "quot:34 amp:38 apos:39 lt:60 gt:62 OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 " +
  "Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 " +
  "alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 " +
  "ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 " +
  "image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 " +
  "forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 " +
  "sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:9001 rang:9002 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830";

const NAMED_ENTITIES: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  LATIN1_ENTITIES.split(" ").forEach((name, index) => map.set(name, 160 + index));
  for (const pair of OTHER_ENTITIES.split(" ")) {
    const [name, code] = pair.split(":");
    map.set(name!, Number(code));
  }
  return map;
})();

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,8}|#[0-9]{1,8}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function codePointText(code: number): string {
  // String.fromCodePoint THROWS above U+10FFFF; a lone surrogate or NUL is not text either.
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/**
 * Decode XML/XHTML character references in ONE pass (so `&amp;lt;` becomes
 * `&lt;`, never `<`). Unknown names are left as written; an out-of-range
 * numeric reference becomes U+FFFD instead of throwing.
 */
export function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      return codePointText(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const code = NAMED_ENTITIES.get(body);
    return code === undefined ? whole : String.fromCodePoint(code);
  });
}

// ---- tokenizer + tree ----------------------------------------------------------------------------

/** Elements that never have content, whether or not the source self-closes them. */
const VOID_ELEMENTS = new Set(["br", "hr", "img", "col", "wbr", "input", "meta", "link", "area", "base", "embed", "source", "track"]);
/** Opening one of these directly inside one of the listed elements closes that one first (sloppy HTML). */
const IMPLIED_CLOSE: Record<string, readonly string[]> = {
  li: ["li"],
  p: ["p"],
  td: ["td", "th"],
  th: ["td", "th"],
};

const TAG_NAME_RE = /^[A-Za-z_][\w:.-]*/;
const ATTRIBUTE_RE = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function element(name: string, attrs: Record<string, string> = {}): ElementNode {
  return { kind: "el", name, attrs, children: [] };
}

/**
 * Index of the `>` that ends the tag opening at `lt`, or -1 when this `<` is
 * not a tag. Quote-aware (`>` is legal inside an attribute value), and it stops
 * at the next `<` — never legal inside a tag — which is what keeps the whole
 * scan linear on hostile input. An unterminated quote falls back to the first `>`.
 */
function tagEnd(source: string, lt: number): number {
  let quote = 0;
  let firstGt = -1;
  for (let i = lt + 1; i < source.length; i += 1) {
    const c = source.charCodeAt(i);
    if (c === 60 /* < */) break;
    if (c === 62 /* > */) {
      if (!quote) return i;
      if (firstGt < 0) firstGt = i;
    } else if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    }
  }
  return quote ? firstGt : -1;
}

type ParsedTag =
  | { kind: "skip" }
  | { kind: "close"; name: string }
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean };

/** Parse what sits between `<` and `>`; null when it is not a tag at all (`a < b > c`). */
function parseTag(inner: string): ParsedTag | null {
  const first = inner.charCodeAt(0);
  if (first === 33 /* ! */ || first === 63 /* ? */) return { kind: "skip" }; // doctype, processing instruction
  const closing = first === 47; /* / */
  const body = closing ? inner.slice(1) : inner;
  const match = TAG_NAME_RE.exec(body);
  if (!match) return null;
  const rest = body.slice(match[0].length);
  if (rest && !/^[\s/]/.test(rest)) return null;
  const name = match[0].toLowerCase();
  if (closing) return { kind: "close", name };
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const attr of rest.matchAll(ATTRIBUTE_RE)) {
    const key = attr[1]!.toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeXmlEntities(attr[2] ?? attr[3] ?? attr[4] ?? "");
  }
  return { kind: "open", name, attrs, selfClosing: /\/\s*$/.test(rest) };
}

function parseStorage(source: string): ElementNode {
  const root = element("#root");
  const stack: ElementNode[] = [root];
  /** Names opened beyond MAX_DEPTH: not in the tree, but their close tags must not close an ancestor. */
  const overflow: string[] = [];
  let top = root;
  let noCommentEnd = false;

  const addText = (value: string) => {
    if (!value) return;
    const last = top.children[top.children.length - 1];
    if (last?.kind === "text") last.value += value;
    else top.children.push({ kind: "text", value });
  };
  const popTo = (depth: number) => {
    stack.length = depth;
    top = stack[depth - 1]!;
    overflow.length = 0;
  };
  const close = (name: string) => {
    if (overflow.length) {
      const at = overflow.lastIndexOf(name);
      if (at >= 0) {
        overflow.length = at;
        return;
      }
    }
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
      if (stack[depth]!.name === name) {
        popTo(depth);
        return;
      }
    }
    // An end tag nothing opened: ignored.
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      addText(decodeXmlEntities(source.slice(i)));
      break;
    }
    if (lt > i) addText(decodeXmlEntities(source.slice(i, lt)));
    if (source.startsWith("<![CDATA[", lt)) {
      // Literal text: no entity decoding. Unterminated → the rest of the input.
      const end = source.indexOf("]]>", lt + 9);
      addText(source.slice(lt + 9, end < 0 ? source.length : end));
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    if (source.startsWith("<!--", lt)) {
      const end = noCommentEnd ? -1 : source.indexOf("-->", lt + 4);
      if (end < 0) noCommentEnd = true; // unterminated: drop only the opener and keep reading
      i = end < 0 ? lt + 4 : end + 3;
      continue;
    }
    const gt = tagEnd(source, lt);
    const tag = gt < 0 ? null : parseTag(source.slice(lt + 1, gt));
    if (!tag) {
      addText("<");
      i = lt + 1;
      continue;
    }
    i = gt + 1;
    if (tag.kind === "skip") continue;
    if (tag.kind === "close") {
      close(tag.name);
      continue;
    }
    if (!overflow.length && IMPLIED_CLOSE[tag.name]?.includes(top.name)) popTo(stack.length - 1);
    const node = element(tag.name, tag.attrs);
    if (tag.selfClosing || VOID_ELEMENTS.has(tag.name)) {
      top.children.push(node);
    } else if (overflow.length || stack.length > MAX_DEPTH) {
      overflow.push(tag.name); // too deep: its content flows into the current node
    } else {
      top.children.push(node);
      stack.push(node);
      top = node;
    }
  }
  return root;
}

// ---- small helpers -------------------------------------------------------------------------------

function textContent(node: StorageNode): string {
  if (node.kind === "text") return node.value;
  let out = "";
  for (const child of node.children) out += textContent(child);
  return out;
}

/** Whitespace runs (NBSP included) → one space; zero-width spaces dropped. */
function collapse(value: string): string {
  return value.replace(/​/g, "").replace(/\s+/g, " ");
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function childElements(node: ElementNode, name?: string): ElementNode[] {
  return node.children.filter((child): child is ElementNode => child.kind === "el" && (!name || child.name === name));
}

function firstChild(node: ElementNode, name: string): ElementNode | undefined {
  return node.children.find((child): child is ElementNode => child.kind === "el" && child.name === name);
}

/** The first `ri:*` resource element anywhere under `node`. */
function findResource(node: ElementNode): ElementNode | undefined {
  for (const child of node.children) {
    if (child.kind !== "el") continue;
    if (child.name.startsWith("ri:")) return child;
    const nested = findResource(child);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Inline text finished: runs of spaces collapsed FIRST (so the break pass never
 * rescans a long run), breaks tidied, blank lines capped.
 */
function tidy(value: string): string {
  return value
    .replace(/ {2,}/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `[leading whitespace, core, trailing whitespace]` of inline text (spaces and breaks only). */
function splitEdges(value: string): [string, string, string] {
  const isSpace = (code: number) => code === 32 || code === 10;
  let start = 0;
  while (start < value.length && isSpace(value.charCodeAt(start))) start += 1;
  let end = value.length;
  while (end > start && isSpace(value.charCodeAt(end - 1))) end -= 1;
  return [value.slice(0, start), value.slice(start, end), value.slice(end)];
}

/** Wrap in an emphasis marker, keeping surrounding spaces OUTSIDE it (`**foo** bar`). */
function wrap(marker: string, inner: string): string {
  const [lead, core, trail] = splitEdges(inner);
  return core ? `${lead}${marker}${core}${marker}${trail}` : inner;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const run of value.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return longest;
}

function codeSpan(value: string): string {
  const body = value.trim();
  if (!body) return "";
  const ticks = "`".repeat(longestBacktickRun(body) + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${ticks}${pad}${body}${pad}${ticks}`;
}

/** A fenced block whose fence is longer than any backtick run inside it. */
function fence(body: string, info: string): string {
  const code = body.replace(/\r\n?/g, "\n").replace(/^\n+/, "").trimEnd();
  const ticks = "`".repeat(Math.max(3, longestBacktickRun(code) + 1));
  return `${ticks}${info}\n${code}\n${ticks}`;
}

function quote(value: string): string {
  return value
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function spanOf(value: string | undefined, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 1 ? Math.min(parsed, max) : 1;
}

// ---- resources, links, images --------------------------------------------------------------------

/**
 * A `ri:*` resource named for a reader. A user is NEVER named by its key or
 * account id (opaque, and personal data): only an explicit `ri:username`.
 */
function resourceLabel(resource: ElementNode): string {
  const attrs = resource.attrs;
  const title = collapse(attrs["ri:content-title"] ?? "").trim();
  const space = collapse(attrs["ri:space-key"] ?? "").trim();
  switch (resource.name) {
    case "ri:page":
      return `page: ${title || "(untitled)"}${space ? ` (space ${space})` : ""}`;
    case "ri:blog-post":
      return `blog post: ${title || "(untitled)"}${space ? ` (space ${space})` : ""}`;
    case "ri:attachment": {
      const owner = childElements(resource).find((child) => child.name === "ri:page" || child.name === "ri:blog-post");
      const filename = collapse(attrs["ri:filename"] ?? "").trim() || "(unnamed)";
      return `attachment: ${filename}${owner ? ` (on ${resourceLabel(owner)})` : ""}`;
    }
    case "ri:user": {
      const username = collapse(attrs["ri:username"] ?? "").trim();
      return username ? `@${username}` : "user mention";
    }
    case "ri:space":
      return `space: ${space || "(unknown)"}`;
    case "ri:url":
      return cut((attrs["ri:value"] ?? "").trim(), MAX_HREF_CHARS) || "url";
    case "ri:content-entity":
      return `page id: ${collapse(attrs["ri:content-id"] ?? "").trim() || "(unknown)"}`;
    case "ri:shortcut":
      return `shortcut: ${collapse(`${attrs["ri:key"] ?? ""} ${attrs["ri:parameter"] ?? ""}`).trim()}`;
    default:
      return resource.name.slice(3);
  }
}

function renderResource(resource: ElementNode): string {
  const label = resourceLabel(resource);
  return label.startsWith("@") ? label : `[${label}]`;
}

function renderAnchor(node: ElementNode, ctx: InlineContext): string {
  const body = tidy(inlineRaw(node.children, ctx)).replace(/\n/g, " ");
  const href = (node.attrs.href ?? "").trim();
  if (!href || ctx.code) return body;
  if (!body || body === href) return cut(href, MAX_HREF_CHARS);
  return `[${body}](${cut(href, MAX_HREF_CHARS)})`;
}

function renderAcLink(node: ElementNode, ctx: InlineContext): string {
  const resource = childElements(node).find((child) => child.name.startsWith("ri:"));
  const plainBody = firstChild(node, "ac:plain-text-link-body");
  const richBody = firstChild(node, "ac:link-body");
  const body = (
    plainBody ? collapse(textContent(plainBody)).trim() : richBody ? tidy(inlineRaw(richBody.children, ctx)) : ""
  ).replace(/\n/g, " ");
  const anchor = collapse(node.attrs["ac:anchor"] ?? "").trim();
  if (!resource) {
    if (!anchor) return body;
    return body ? `[${body}](#${anchor})` : `[#${anchor}]`;
  }
  if (resource.name === "ri:user") {
    const label = resourceLabel(resource);
    if (label.startsWith("@")) return label;
    return body ? `@${body.replace(/^@/, "")}` : "[user mention]";
  }
  const target = `${resourceLabel(resource)}${anchor ? ` #${anchor}` : ""}`;
  const title = collapse(resource.attrs["ri:content-title"] ?? resource.attrs["ri:filename"] ?? "").trim();
  return body && body !== title ? `[${body}](${target})` : `[${target}]`;
}

function renderAcImage(node: ElementNode): string {
  const resource = childElements(node).find((child) => child.name.startsWith("ri:"));
  const caption = firstChild(node, "ac:caption");
  const label = collapse(
    node.attrs["ac:alt"] || node.attrs["ac:title"] || (caption ? textContent(caption) : ""),
  ).trim();
  let source = "";
  if (resource?.name === "ri:attachment") source = resourceLabel(resource).slice("attachment: ".length);
  else if (resource) source = resourceLabel(resource);
  if (!source) return label ? `[image: ${cut(label, MAX_PARAM_CHARS)}]` : "[image]";
  return `[image: ${source}${label && label !== source ? ` — ${cut(label, MAX_PARAM_CHARS)}` : ""}]`;
}

function renderHtmlImage(node: ElementNode): string {
  const alt = collapse(node.attrs.alt ?? node.attrs.title ?? "").trim();
  const src = (node.attrs.src ?? "").trim();
  const source = /^data:/i.test(src) ? "embedded image data" : cut(src, MAX_HREF_CHARS);
  const parts = [source, alt && alt !== source ? cut(alt, MAX_PARAM_CHARS) : ""].filter(Boolean);
  return parts.length ? `[image: ${parts.join(" — ")}]` : "[image]";
}

function renderEmoticon(node: ElementNode): string {
  const fallback = (node.attrs["ac:emoji-fallback"] ?? "").trim();
  if (fallback) return cut(fallback, 40);
  const shortname = (node.attrs["ac:emoji-shortname"] ?? "").trim();
  if (shortname) return cut(shortname, 40);
  const name = collapse(node.attrs["ac:name"] ?? "").trim();
  return name ? `:${cut(name, 40)}:` : "";
}

// ---- macros --------------------------------------------------------------------------------------

interface MacroParts {
  name: string;
  params: Array<{ name: string; value: string }>;
  rich?: ElementNode;
  plain?: ElementNode;
}

/** Body macros that are only layout: their content is rendered as if the macro were not there. */
const TRANSPARENT_MACROS = new Set(["section", "column", "excerpt", "div", "center", "span", "highlight"]);
const LABELLED_MACROS: Record<string, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  tip: "Tip",
  panel: "Panel",
  expand: "Expand",
  details: "Page properties",
};
const CODE_MACROS = new Set(["code", "noformat"]);

function paramValue(node: ElementNode): string {
  const resource = findResource(node);
  if (resource) return cut(resourceLabel(resource), MAX_PARAM_CHARS);
  return cut(collapse(textContent(node)).trim(), MAX_PARAM_CHARS);
}

function macroParts(node: ElementNode): MacroParts {
  const parts: MacroParts = {
    name: cut(collapse(node.attrs["ac:name"] ?? "").trim().toLowerCase(), 60) || "unnamed",
    params: [],
  };
  for (const child of childElements(node)) {
    if (child.name === "ac:parameter") {
      parts.params.push({ name: collapse(child.attrs["ac:name"] ?? "").trim(), value: paramValue(child) });
    } else if (child.name === "ac:default-parameter") {
      parts.params.push({ name: "", value: paramValue(child) });
    } else if (child.name === "ac:rich-text-body") {
      parts.rich ??= child;
    } else if (child.name === "ac:plain-text-body") {
      parts.plain ??= child;
    }
  }
  return parts;
}

function isMacro(node: ElementNode): boolean {
  return node.name === "ac:structured-macro" || node.name === "ac:macro";
}

function macroHasBody(node: ElementNode): boolean {
  return node.children.some(
    (child) => child.kind === "el" && (child.name === "ac:rich-text-body" || child.name === "ac:plain-text-body"),
  );
}

function param(parts: MacroParts, name: string): string {
  return parts.params.find((entry) => entry.name.toLowerCase() === name)?.value ?? "";
}

/** `k=v, k=v` for a macro's parameters, bounded; `skip` names are left out. */
function paramSummary(parts: MacroParts, skip: readonly string[] = []): string {
  const shown = parts.params.filter((entry) => entry.value && !skip.includes(entry.name.toLowerCase()));
  const listed = shown
    .slice(0, MAX_MACRO_PARAMS)
    .map((entry) => (entry.name ? `${cut(entry.name, 40)}=${entry.value}` : entry.value));
  if (shown.length > MAX_MACRO_PARAMS) listed.push(`+${shown.length - MAX_MACRO_PARAMS} more`);
  return listed.join(", ");
}

/** A macro with no body: one inline placeholder that keeps its name and parameters. */
function renderMacroInline(node: ElementNode): string {
  const parts = macroParts(node);
  switch (parts.name) {
    case "status":
      return `[status: ${param(parts, "title") || param(parts, "colour") || param(parts, "color") || "(empty)"}]`;
    case "jira": {
      const key = param(parts, "key");
      if (key) return `[jira: ${key}]`;
      const jql = param(parts, "jqlquery");
      if (jql) return `[jira query: ${jql}]`;
      break;
    }
    case "toc":
      return "[table of contents]";
    case "drawio":
    case "drawio-sketch":
    case "inc-drawio": {
      const diagram = param(parts, "diagramname") || param(parts, "diagramdisplayname");
      if (diagram) return `[drawio diagram: ${diagram}]`;
      break;
    }
    default:
      break;
  }
  const summary = paramSummary(parts);
  return `[macro ${parts.name}${summary ? `: ${summary}` : ""}]`;
}

/** A macro WITH a body: code → a fenced block, layout → its content, anything else → a labelled quote. */
function renderMacroBlock(node: ElementNode, ctx: InlineContext): string[] {
  const parts = macroParts(node);
  if (parts.plain && CODE_MACROS.has(parts.name)) {
    const language = param(parts, "language").replace(/[^A-Za-z0-9_+#.-]/g, "").slice(0, 30);
    const title = param(parts, "title");
    const block = fence(textContent(parts.plain), parts.name === "code" ? language : "");
    return title ? [`**Code: ${title}**\n${block}`] : [block];
  }
  if (parts.rich && !parts.plain && TRANSPARENT_MACROS.has(parts.name)) return renderBlocks(parts.rich.children, ctx);

  const known = LABELLED_MACROS[parts.name];
  const title = param(parts, "title");
  let header: string;
  if (known) {
    header = `**${known}${title ? `: ${title}` : ""}**`;
  } else {
    const summary = paramSummary(parts);
    header = `**Macro ${parts.name}**${summary ? ` (${summary})` : ""}`;
  }
  const body: string[] = [];
  if (parts.plain) {
    const plain = textContent(parts.plain);
    if (plain.trim()) body.push(fence(plain, ""));
  }
  if (parts.rich) body.push(...renderBlocks(parts.rich.children, ctx));
  return [quote([header, ...body].join("\n\n"))];
}

/** Cloud's `ac:adf-extension`: the node's content when it has one, else the storage fallback — never both. */
function renderAdfExtension(node: ElementNode, ctx: InlineContext): string[] {
  const adfNode = firstChild(node, "ac:adf-node");
  const fallback = firstChild(node, "ac:adf-fallback");
  if (!adfNode) return renderBlocks((fallback ?? node).children, ctx);
  const content = firstChild(adfNode, "ac:adf-content");
  const panelType = childElements(adfNode, "ac:adf-attribute").find((attr) => attr.attrs.key === "panel-type");
  const type = collapse(adfNode.attrs.type ?? "").trim() || "extension";
  const kind = panelType ? collapse(textContent(panelType)).trim() : "";
  const body = renderBlocks((content ?? fallback ?? element("#empty")).children, ctx);
  return [quote([`**${cut(type, 40)}${kind ? `: ${cut(kind, 40)}` : ""}**`, ...body].join("\n\n"))];
}

// ---- block / inline classification ---------------------------------------------------------------

const BLOCK_ELEMENTS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot",
  "tr", "td", "th", "caption", "pre", "blockquote", "hr", "div", "section", "article", "header", "footer", "main",
  "nav", "aside", "figure", "figcaption", "details", "summary", "address", "center", "form", "fieldset",
  "ac:task-list", "ac:task", "ac:task-body", "ac:rich-text-body", "ac:layout", "ac:layout-section", "ac:layout-cell",
  "ac:adf-extension", "ac:adf-node", "ac:adf-content", "ac:adf-fallback",
]);
const INLINE_ELEMENTS = new Set([
  "strong", "b", "em", "i", "u", "s", "del", "strike", "code", "tt", "kbd", "samp", "a", "span", "sub", "sup",
  "small", "big", "font", "ins", "mark", "abbr", "q", "cite", "var", "label", "time", "br", "img", "wbr",
  "ac:link", "ac:image", "ac:emoticon", "ac:inline-comment-marker", "ac:placeholder",
]);
/** Never content: dropped with everything inside. */
const DROPPED_ELEMENTS = new Set([
  "script", "style", "head", "colgroup", "col", "ac:parameter", "ac:default-parameter", "ac:task-id",
  "ac:task-status", "ac:adf-attribute", "ac:adf-mark",
]);

function isBlock(node: ElementNode): boolean {
  if (BLOCK_ELEMENTS.has(node.name)) return true;
  if (INLINE_ELEMENTS.has(node.name) || DROPPED_ELEMENTS.has(node.name) || node.name.startsWith("ri:")) return false;
  if (isMacro(node)) return macroHasBody(node);
  // Unknown element: block exactly when it wraps a block.
  node.block ??= node.children.some((child) => child.kind === "el" && isBlock(child));
  return node.block;
}

// ---- inline rendering ----------------------------------------------------------------------------

/** Inline text with single spaces for whitespace and `\n` for a line break; not yet tidied. */
function inlineRaw(nodes: readonly StorageNode[], ctx: InlineContext): string {
  let out = "";
  for (const node of nodes) out += node.kind === "text" ? collapse(node.value) : inlineElement(node, ctx);
  return out;
}

function inlineElement(node: ElementNode, ctx: InlineContext): string {
  if (DROPPED_ELEMENTS.has(node.name)) return "";
  switch (node.name) {
    case "br":
      return "\n";
    case "wbr":
      return "";
    case "strong":
    case "b": {
      const inner = inlineRaw(node.children, { ...ctx, bold: true });
      return ctx.bold || ctx.code ? inner : wrap("**", inner);
    }
    case "em":
    case "i":
    case "cite":
    case "var": {
      const inner = inlineRaw(node.children, { ...ctx, italic: true });
      return ctx.italic || ctx.code ? inner : wrap("*", inner);
    }
    case "s":
    case "del":
    case "strike": {
      const inner = inlineRaw(node.children, { ...ctx, strike: true });
      return ctx.strike || ctx.code ? inner : wrap("~~", inner);
    }
    case "code":
    case "tt":
    case "kbd":
    case "samp": {
      const inner = inlineRaw(node.children, { ...ctx, code: true });
      if (ctx.code) return inner;
      const [lead, core, trail] = splitEdges(inner);
      return core ? `${lead}${codeSpan(core.replace(/\n/g, " "))}${trail}` : inner;
    }
    case "a":
      return renderAnchor(node, ctx);
    case "ac:link":
      return renderAcLink(node, ctx);
    case "ac:image":
      return renderAcImage(node);
    case "img":
      return renderHtmlImage(node);
    case "ac:emoticon":
      return renderEmoticon(node);
    case "time":
      return collapse(node.attrs.datetime ?? "").trim() || inlineRaw(node.children, ctx);
    case "ac:placeholder": {
      const hint = tidy(inlineRaw(node.children, ctx)).replace(/\n/g, " ");
      return hint ? `[placeholder: ${hint}]` : "";
    }
    default:
      break;
  }
  if (node.name.startsWith("ri:")) return renderResource(node);
  if (isMacro(node) && !macroHasBody(node)) return renderMacroInline(node);
  // A block where only inline fits (a paragraph inside <strong>, a body macro inside a link): flattened.
  if (isBlock(node)) return ` ${renderBlock(node, ctx).join("\n")} `;
  return inlineRaw(node.children, ctx);
}

// ---- block rendering -----------------------------------------------------------------------------

/**
 * Mixed content → blocks: consecutive text/inline nodes become one paragraph,
 * each block element renders on its own. Every container goes through here, so
 * "a list item holding text, a nested list and a code macro" needs no special case.
 */
function renderBlocks(nodes: readonly StorageNode[], ctx: InlineContext): string[] {
  const out: string[] = [];
  let run: StorageNode[] = [];
  const flush = () => {
    if (!run.length) return;
    const paragraph = tidy(inlineRaw(run, ctx));
    if (paragraph) out.push(paragraph);
    run = [];
  };
  for (const node of nodes) {
    if (node.kind === "el" && isBlock(node)) {
      flush();
      out.push(...renderBlock(node, ctx));
    } else {
      run.push(node);
    }
  }
  flush();
  return out;
}

function renderBlock(node: ElementNode, ctx: InlineContext): string[] {
  switch (node.name) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const title = tidy(inlineRaw(node.children, { ...ctx, bold: true })).replace(/\n+/g, " ");
      return title ? [`${"#".repeat(Number(node.name[1]))} ${title}`] : [];
    }
    case "ul":
    case "ol": {
      const list = renderList(node, ctx);
      return list ? [list] : [];
    }
    case "ac:task-list":
    case "ac:task": {
      const list = renderTaskList(node.name === "ac:task" ? [node] : childElements(node, "ac:task"), ctx);
      return list ? [list] : [];
    }
    case "table":
      return renderTable(node, ctx);
    case "pre": {
      const code = textContent(node);
      return code.trim() ? [fence(code, "")] : [];
    }
    case "blockquote": {
      const body = renderBlocks(node.children, ctx);
      return body.length ? [quote(body.join("\n\n"))] : [];
    }
    case "hr":
      return ["---"];
    case "ac:adf-extension":
      return renderAdfExtension(node, ctx);
    default:
      break;
  }
  if (isMacro(node)) return renderMacroBlock(node, ctx);
  return renderBlocks(node.children, ctx);
}

/** Append one list item: the marker on its first line, the rest indented under it. */
function pushItem(lines: string[], marker: string, parts: readonly string[]): boolean {
  if (!parts.length) return false;
  const pad = " ".repeat(marker.length);
  parts
    .join("\n")
    .split("\n")
    .forEach((line, index) => lines.push(index === 0 ? `${marker}${line}` : line ? `${pad}${line}` : ""));
  return true;
}

function renderList(node: ElementNode, ctx: InlineContext): string {
  const ordered = node.name === "ol";
  const start = Number.parseInt(node.attrs.start ?? "", 10);
  let index = Number.isFinite(start) && Math.abs(start) < 1_000_000 ? start : 1;
  const lines: string[] = [];
  const item = (parts: readonly string[]) => {
    if (pushItem(lines, ordered ? `${index}. ` : "- ", parts)) index += 1;
  };
  for (const child of node.children) {
    if (child.kind === "text") {
      if (child.value.trim()) item(renderBlocks([child], ctx));
    } else if (child.name === "li") {
      item(renderBlocks(child.children, ctx));
    } else if (child.name === "ul" || child.name === "ol") {
      // A list directly inside a list (sloppy markup): nested under the previous item.
      const nested = renderList(child, ctx);
      if (nested) lines.push(...nested.split("\n").map((line) => (line ? `  ${line}` : "")));
    } else {
      item(renderBlocks([child], ctx));
    }
  }
  return lines.join("\n");
}

function renderTaskList(tasks: readonly ElementNode[], ctx: InlineContext): string {
  const lines: string[] = [];
  for (const task of tasks) {
    const status = firstChild(task, "ac:task-status");
    const body = firstChild(task, "ac:task-body");
    const done = status ? collapse(textContent(status)).trim().toLowerCase() === "complete" : false;
    pushItem(lines, done ? "- [x] " : "- [ ] ", renderBlocks((body ?? task).children, ctx));
  }
  return lines.join("\n");
}

/** A table's own rows — through thead/tbody/tfoot and stray wrappers, never into a nested table. */
function tableRows(node: ElementNode, rows: ElementNode[] = []): ElementNode[] {
  for (const child of childElements(node)) {
    if (child.name === "tr") rows.push(child);
    else if (child.name !== "table" && child.name !== "td" && child.name !== "th") tableRows(child, rows);
  }
  return rows;
}

/**
 * Everything inside a cell on ONE line: nested blocks flattened (a body macro's
 * quote markers dropped — its label stays), line breaks marked, pipes escaped.
 */
function cellText(cell: ElementNode, ctx: InlineContext): string {
  return renderBlocks(cell.children, ctx)
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/^(?:> ?)+/, "").trim())
    .filter(Boolean)
    .join(CELL_BREAK)
    .replace(/\|/g, "\\|");
}

/**
 * A Markdown table. Merged cells degrade to a regular grid: the content sits in
 * the first cell and every other covered cell holds a marker, so columns stay
 * aligned. A table without a header row gets an empty one (Markdown needs it).
 */
function renderTable(node: ElementNode, ctx: InlineContext): string[] {
  const grid: string[][] = [];
  const pending: number[] = []; // rows a column is still covered by a rowspan from above
  const rows = tableRows(node);
  const isCell = (child: StorageNode): child is ElementNode =>
    child.kind === "el" && (child.name === "td" || child.name === "th");
  const headerRow = rows.length > 0 && rows[0]!.children.some((child) => isCell(child) && child.name === "th");
  let merged = false;
  for (const [rowIndex, row] of rows.entries()) {
    const line: string[] = [];
    let column = 0;
    const takeCovered = () => {
      while (column < MAX_TABLE_COLUMNS && (pending[column] ?? 0) > 0) {
        line[column] = MERGED_UP;
        pending[column]! -= 1;
        column += 1;
      }
    };
    for (const cell of row.children.filter(isCell)) {
      takeCovered();
      if (column >= MAX_TABLE_COLUMNS) break;
      const heading = cell.name === "th";
      let content = cellText(cell, heading ? { ...ctx, bold: true } : ctx);
      // A heading cell outside the header row (a row header) is marked bold.
      if (heading && content && !(headerRow && rowIndex === 0)) content = `**${content}**`;
      const colspan = spanOf(cell.attrs.colspan, MAX_TABLE_COLUMNS);
      const rowspan = spanOf(cell.attrs.rowspan, MAX_ROWSPAN);
      if (colspan > 1 || rowspan > 1) merged = true;
      for (let k = 0; k < colspan && column < MAX_TABLE_COLUMNS; k += 1) {
        line[column] = k === 0 ? content : MERGED_LEFT;
        pending[column] = rowspan - 1;
        column += 1;
      }
    }
    // Columns right of the last cell that a rowspan from above still covers.
    for (; column < pending.length; column += 1) {
      if ((pending[column] ?? 0) > 0) {
        line[column] = MERGED_UP;
        pending[column]! -= 1;
      }
    }
    if (line.length) grid.push(line);
  }

  const width = grid.reduce((max, line) => Math.max(max, line.length), 0);
  if (!width) return [];
  const rowText = (line: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, column) => line[column] ?? "").join(" | ")} |`;
  const body = headerRow ? grid.slice(1) : grid;
  const lines = [
    rowText(headerRow ? grid[0]! : []),
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map(rowText),
  ];
  const caption = firstChild(node, "caption");
  const captionText = caption ? tidy(inlineRaw(caption.children, ctx)).replace(/\n/g, " ") : "";
  const out = captionText ? [`**Table: ${captionText}**\n${lines.join("\n")}`] : [lines.join("\n")];
  if (merged) out.push(`(merged cells: ${MERGED_LEFT} continues the cell to its left, ${MERGED_UP} the cell above)`);
  return out;
}

// ---- entry point ---------------------------------------------------------------------------------

/** Control characters that are never page text (tab and newline stay). */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function finish(value: string): string {
  return value.replace(CONTROL_CHARS_RE, "").trim();
}

/** Last resort when the walker itself fails: tags stripped, entities decoded once. */
function fallbackText(storage: string): string {
  const stripped = storage.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^<>]*>/g, " ");
  return decodeXmlEntities(stripped)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n");
}

/**
 * Convert a page's `body.storage` value to compact Markdown-like text. Total:
 * any input — empty, malformed, unbalanced, hostile — returns text.
 */
export function confluenceStorageToText(storage: string): string {
  if (typeof storage !== "string" || !storage) return "";
  try {
    return finish(renderBlocks(parseStorage(storage).children, PLAIN).join("\n\n"));
  } catch {
    try {
      return finish(fallbackText(storage));
    } catch {
      return "";
    }
  }
}
