/**
 * The PURE half of the bridge: rendering a CDP accessibility tree into the text
 * an agent reads, plus the decisions taken on values read back out of it.
 *
 * Kept apart from background.js so it can be unit tested — background.js reaches
 * `chrome.*` and CDP and cannot be. Everything here is a function of its
 * arguments, so every rule that silently deleted, drowned, or MISREAD real page
 * content has a test instead of a field report.
 */

/** Roles that get a uid, because an agent can act on them. */
export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "spinbutton",
  // A canvas is where canvas APPS (diagram editors, maps) live; without a uid
  // there is no way to click or focus one, and keyboard shortcuts silently go
  // nowhere because the canvas never holds focus. BOTH spellings, because they
  // come from different places: Chrome COMPUTES a plain <canvas> as CamelCase
  // "Canvas" (the same convention as RootWebArea/StaticText/LayoutTableCell),
  // while only an explicit role="canvas" arrives lowercase. Matching lowercase
  // alone meant every real canvas was nameless AND non-interactive, so it
  // vanished from the snapshot entirely and click_at's uid mode had nothing on
  // the page to aim at.
  "canvas",
  "Canvas",
  // A <select multiple> IS its own control — options are selected by clicking
  // them INSIDE it, and select_option's option-collector walks down from the
  // node it is aimed at. Without a uid on the listbox itself the agent could
  // click individual options but never address the CONTROL (scroll it, aim
  // select_option at it), and a custom role="listbox" autocomplete popup had no
  // handle either. Probed (round11-facts.spec.ts): Chrome computes a
  // <select multiple> as role "listbox", focusable, with its options as AX
  // descendants — exactly the root the existing collector needs.
  "listbox",
]);

/**
 * Roles that are not natively interactive but are CLICKABLE SURFACES in real
 * apps — menus built from table rows (draw.io's submenu <tr>s surface only as
 * LayoutTableCell), tree views, data grids. They get a uid only when they
 * carry a name: a nameless layout cell is structure, and minting it would
 * flood the snapshot with unactionable refs.
 */
export const NAMED_CLICKABLE_ROLES = new Set([
  "row",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "LayoutTableCell",
  "LayoutTableRow",
  "treeitem",
]);

/**
 * Containers that are not controls but ARE the drawn surface itself — a map
 * body, an embedded app, a <canvas>. Nothing inside them has an accessibility
 * entry, so the container's own uid is the only handle click_at's uid mode (and
 * read_text's uid scoping) can aim at; without it a map surfaced as a bare
 * `region "Map"` line that named a target no tool could reach. Named only:
 * a nameless region is page structure and minting it would flood the snapshot.
 * They stay in OPAQUE_NAME_ROLES — a uid says "actionable", not "my name
 * describes my children".
 *
 * A canvas is listed here for the SURFACE half of that meaning (see
 * SURFACE_ROLES, which is exactly this set): a drawn surface never owns the
 * clicks of what is drawn on it. Its uid does NOT depend on this membership —
 * canvas is in INTERACTIVE_ROLES, so even a NAMELESS one mints, which is the
 * field fix diagram editors depend on.
 */
export const NAMED_CONTAINER_UID_ROLES = new Set([
  "region",
  "application",
  "canvas",
  "Canvas",
]);

/**
 * Roles whose accessible name does NOT come from their contents. A descendant
 * that repeats a word from one of these is saying something new, so they must
 * never suppress it — letting RootWebArea cover the page would delete every
 * mention of the title from the body text.
 *
 * A canvas belongs here for the same reason a region does, only more strictly:
 * its name can ONLY come from aria-label or the fallback content, never from
 * what it draws, so a descendant repeating one of its words is not an echo of
 * it — and the fallback content is precisely the text a canvas app leaves for
 * the readers that cannot see the drawing.
 */
const OPAQUE_NAME_ROLES = new Set([
  "RootWebArea",
  "main",
  "region",
  "canvas",
  "Canvas",
  "navigation",
  "form",
  "article",
  "banner",
  "contentinfo",
  "complementary",
  "dialog",
  "tabpanel",
  "table",
  "rowgroup",
  "row",
  "list",
  "listitem",
  "group",
  "figure",
]);

/** One AX property's value, or undefined. Shared with background.js. */
export function axProp(node, name) {
  const hit = (node?.properties || []).find((prop) => prop?.name === name);
  return hit ? hit.value?.value : undefined;
}

/**
 * The THREE answers one AX node gives about the text it holds. Keeping them
 * apart is what makes a clearing write verifiable at all:
 *
 *   "text"  the field holds that text (RAW — callers trim where they compare);
 *   ""      the field is genuinely EMPTY;
 *   null    nothing readable here — this node exposes no text value at all.
 *
 * Chrome OMITS the `value` property entirely on an EMPTY text field, so "no value
 * property" cannot mean "empty" on its own. Reading it that way is exactly how
 * clear verification disarmed itself in the field: a `role="combobox"` WRAPPER,
 * whose text lives in a descendant <input>, answered "" — and an empty `before`
 * makes `clearFailed` give up, so a silent append shipped as success three times
 * running. The `editable` property is what separates the two: Chrome sets it
 * (`plaintext`/`richtext`) on every textbox/textarea/contenteditable whether or
 * not it holds text, and never on such a wrapper. Both facts are measured in
 * `tests/visual/clear-ladder.spec.ts`.
 */
export function axValueAnswer(node) {
  if (!node) return null;
  if (node.value != null) return String(node.value.value ?? "");
  return axProp(node, "editable") === undefined ? null : "";
}

/**
 * True when the OLD value survived a clearing write at one END of the field — the
 * signature of a select-all the page ignored, which turns a replacement into an
 * insert. BOTH ends, because the surviving text sits wherever the caret was not:
 * "광교" + "카페거리" read back as "광교카페거리" in the field report (caret at the
 * end) and as "카페거리광교" on a freshly focused input (caret at 0). A hit in the
 * MIDDLE is not counted — that is where a short old value collides with a page's
 * own reformatting by coincidence, and a false alarm here costs a real error
 * message on a page that worked.
 *
 * Decidable only when both reads succeeded; a null read means verification was
 * unavailable and must never read as failure. A field that now holds EXACTLY the
 * requested value is a success whatever it held before, which is what keeps
 * replacing "광교" with "광교역" from looking like a survival.
 */
export function clearFailed(before, after, value) {
  if (before === null || after === null) return false;
  const old = String(before).trim();
  const now = String(after).trim();
  if (!old) return false;
  if (now === String(value).trim()) return false;
  return now.startsWith(old) || now.endsWith(old);
}

/**
 * The `aria-expanded` reading of a described element, three-way: true, false, or
 * null when the element does not report it at all. The three-way answer is the
 * whole point — a trigger that never carries the attribute is UNVERIFIABLE, and
 * folding that into `false` would report every such click as a failed open.
 *
 * `attrs` is a DOM.Node's flat attributes array reduced to an object
 * (background.js `flatAttrs`); anything else reads as "does not report it".
 */
export function ariaExpandedOf(attrs) {
  const raw = attrs && typeof attrs === "object" ? attrs["aria-expanded"] : undefined;
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * True when an element advertises that it OWNS a popup — the shape a click is
 * meant to OPEN rather than merely activate. Any one of the three ARIA
 * disclosure markers counts: `aria-expanded` (the state itself),
 * `aria-haspopup` (anything but the explicit "false"), or `aria-controls` (the
 * menu it owns).
 *
 * Read off the DOM on purpose. AUI's dropdown2 trigger — the component behind
 * Confluence's legacy editor toolbar — carries and TOGGLES `aria-expanded` in
 * the DOM while exposing no expanded/collapsed state in the accessibility tree
 * at all (it renders as a plain `link`), so the AX tree cannot answer the one
 * question issue #64 needed answered.
 */
export function isDisclosureTrigger(attrs) {
  if (!attrs || typeof attrs !== "object") return false;
  if ("aria-expanded" in attrs) return true;
  const haspopup = String(attrs["aria-haspopup"] ?? "")
    .trim()
    .toLowerCase();
  if (haspopup && haspopup !== "false") return true;
  return Boolean(String(attrs["aria-controls"] ?? "").trim());
}

/**
 * What a click on a disclosure trigger actually DID, from the `aria-expanded`
 * pair read around it (each side true / false / null, per `ariaExpandedOf`):
 *
 *   "opened"         — it is open now. Nothing worth saying.
 *   "toggled-closed" — it was open and this click SHUT it. A trigger toggles.
 *   "not-opened"     — it reports a state, and that state is still not open.
 *   "unknown"        — no state on either side: unverifiable, so say nothing.
 *
 * Issue #64: the bridge answered a bare "clicked" for a menu that stayed shut
 * (the press was dropped while the browser window was covered), the agent read
 * that as success, clicked again — and the second click closed the menu the
 * first one had opened. Both failure modes are one attribute apart, and neither
 * is worth GUESSING at, which is what the explicit "unknown" is for: a trigger
 * that reports nothing must never be reported as broken.
 */
export function disclosureClickOutcome(before, after) {
  if (after === true) return "opened";
  if (before === true) return "toggled-closed";
  if (before === null && after === null) return "unknown";
  return "not-opened";
}

/**
 * Smallest growth worth calling a paste, and how much of it may survive while
 * the paste still counts as gone — both in code points. A one- or two-character
 * wobble is the page's own reformatting (a trailing newline, a collapsed
 * space), not a paste, and asserting on it would invent data loss.
 */
export const PASTE_GROWTH_MIN = 4;
export const PASTE_VANISH_EPSILON = 2;

/**
 * The grow-then-shrink signature of issue #65: a rich-text editor DISPLAYS
 * pasted text — so the immediate snapshot shows it and the agent believes the
 * paste landed — and then drops it, never committing it to its own model. The
 * text was never saved, and the agent that trusted that first read lost it.
 *
 * Three text lengths taken around the paste: `before`, `peak` shortly after,
 * `settled` a beat later, each null when it could not be measured. Every
 * ambiguous case answers false. The note this gates tells the agent its content
 * is GONE, so it may only fire on a clear grow-then-shrink; a paste that merely
 * looks like it shrank must read as unverified, never as lost.
 */
export function pastedTextVanished(before, peak, settled) {
  for (const length of [before, peak, settled]) {
    if (typeof length !== "number" || !Number.isFinite(length) || length < 0) return false;
  }
  if (peak - before < PASTE_GROWTH_MIN) return false;
  return settled - before <= PASTE_VANISH_EPSILON;
}

/**
 * Cap for a printed link href. A printed URL is meant to be OPENED — handed to
 * a read-only fetch, compared against another result — and 150 chopped the tail
 * off ordinary real-world links (a search query with its tracking parameters, a
 * doc anchor), leaving a string that identifies the target but that no tool can
 * follow: worse than printing nothing. 500 covers those whole while still
 * bounding the dumps the cap exists for (data: URIs, tracker payloads).
 */
const LINK_URL_MAX = 500;

/** A url with its fragment removed — the identity of the DOCUMENT it points at. */
const stripFragment = (url) => {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
};

/**
 * The url of the document being rendered, read off its RootWebArea — the only
 * place a pure renderer can learn it, and what makes a same-document link
 * recognizable at all. Resolved ONCE per render, not per link.
 *
 * Its own fragment is stripped: a page LOADED at an anchor reports its url with
 * `#intro` attached, which would make every in-page link look cross-document
 * again.
 */
function documentUrl(nodes) {
  const root = nodes.find((node) => node.role?.value === "RootWebArea");
  return stripFragment(String(axProp(root, "url") || ""));
}

/**
 * A link's destination, straight from the AX node's `url` property — Chrome
 * already resolved and delivered it, so printing it costs no extra CDP round
 * trip. This is what lets an agent compare several search results or hand a
 * URL to read-only tools without paying a full click-and-load per candidate.
 * Same-document fragments and javascript: pseudo-links say nothing useful.
 *
 * Returned UNTRUNCATED: it doubles as the identity duplicate links are folded
 * on, and two destinations differing only past the print cap are not the same
 * link.
 */
function linkHref(node, role, docUrl) {
  if (role !== "link") return "";
  const url = String(axProp(node, "url") || "");
  if (!url || url.startsWith("javascript:") || url.startsWith("#")) return "";
  // Chrome hands the url ALREADY RESOLVED, so `href="#edit"` arrives as
  // https://site/page#edit and walks straight past the literal `#` test above.
  // Every row of a ten-row table then shared ONE href, folded onto a single
  // uid, and rows 2-10 lost their edit/delete links SILENTLY — the snapshot
  // simply had no line for them. Recognized by comparing against the document's
  // own url, so a `#sec` on ANOTHER page stays a real destination and still
  // folds and decorates as before.
  if (url.includes("#") && docUrl && stripFragment(url) === docUrl) return "";
  return url;
}

/** The printed form of a destination: identifiable, never a dump. */
function printableUrl(url) {
  return url.length > LINK_URL_MAX ? `${url.slice(0, LINK_URL_MAX)}…` : url;
}

/**
 * Print caps for ONE element's text in the snapshot view. A GitHub blob view
 * keeps the whole file in a hidden <textarea>, so a 44.7 KB source file arrived
 * as a single AX value: it ate 504 of the page's 1204 snapshot lines, and what
 * survived was ~20 KB of source cut MID-LINE by capSnapshot with nothing saying
 * so — text the agent read as the page's content. The value is not lost by
 * cutting it here, because read_text can still deliver the whole thing in
 * offset chunks; it is only lost by drowning everything ELSE on the page.
 *
 * Applied to the PRINTED line and nowhere else: echo suppression, run joining
 * and byHref identity all keep comparing the RAW strings, so a cut can never
 * change which lines survive. renderAxText is exempt entirely — it is the
 * recovery channel the marker points at.
 */
const VALUE_PRINT_MAX = 3000;
const NAME_PRINT_MAX = 1000;

/**
 * Deepest nesting the snapshot view indents for. One space per level is what
 * turns a flat wall of lines back into a page's shape — which block a control
 * belongs to, where a list ends — but every space is snapshot budget spent on
 * layout instead of content, and real pages nest far deeper than they read.
 */
const SNAPSHOT_INDENT_MAX = 12;

/**
 * A value as it goes onto a snapshot line: quoted, and when cut, followed by
 * what was dropped and the tool that still returns it. A marker-less cut is the
 * failure mode this exists to end — corrupted text an agent cannot tell from
 * the page.
 */
function printedValue(value, uid) {
  if (value.length <= VALUE_PRINT_MAX) return `"${value}"`;
  const recover = uid
    ? `read the full text with mcp__browser__read_text (uid ${uid})`
    : "read the full page text with mcp__browser__read_text";
  return (
    `"${value.slice(0, VALUE_PRINT_MAX)}" [value truncated: showing ${VALUE_PRINT_MAX} ` +
    `of ${value.length} chars — ${recover}]`
  );
}

/**
 * A label as it goes onto a snapshot line. No recovery pointer: an accessible
 * name is not addressable text — read_text would return the page's content, not
 * this label — so the marker says only how much of it is shown.
 */
function printedName(name) {
  if (name.length <= NAME_PRINT_MAX) return `"${name}"`;
  return (
    `"${name.slice(0, NAME_PRINT_MAX)}" ` +
    `[label truncated: showing ${NAME_PRINT_MAX} of ${name.length} chars]`
  );
}

/**
 * One AX state property, normalized to true / false / "mixed" / undefined.
 * Chrome delivers a state as a real BOOLEAN on some builds and properties and
 * as the STRING "true"/"false"/"mixed" on the tristate ones, so a `=== true`
 * read prints half the checked boxes on a page as unchecked.
 */
function axStateFlag(node, name) {
  const raw = axProp(node, name);
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  if (raw === "mixed") return "mixed";
  return undefined;
}

/**
 * The state markers appended to a control's snapshot line. Deployed pages
 * printed `checkbox ""` identically whether the box was ticked or not, so an
 * agent could neither read a form back nor tell whether the click it just made
 * toggled anything — a verification that always passed.
 *
 * checked/pressed/expanded print BOTH ways, because "not checked" is exactly
 * the fact a verifying read is after. selected/disabled print only when true:
 * every option in a listbox is unselected and every control on the page is
 * enabled, so the false form is pure noise. `[disabled]` is worth its width on
 * its own — it is what stops an agent spending a click on a dead button.
 */
function stateFlags(node) {
  const flags = [];
  const checked = axStateFlag(node, "checked");
  if (checked !== undefined) {
    flags.push(checked === "mixed" ? "[checked=mixed]" : checked ? "[checked]" : "[unchecked]");
  }
  const pressed = axStateFlag(node, "pressed");
  if (pressed !== undefined) {
    flags.push(pressed === "mixed" ? "[pressed=mixed]" : pressed ? "[pressed]" : "[unpressed]");
  }
  const expanded = axStateFlag(node, "expanded");
  if (expanded === true) flags.push("[expanded]");
  else if (expanded === false) flags.push("[collapsed]");
  if (axStateFlag(node, "selected") === true) flags.push("[selected]");
  if (axStateFlag(node, "disabled") === true) flags.push("[disabled]");
  return flags.length ? ` ${flags.join(" ")}` : "";
}

/**
 * One AX number property, or undefined. Chrome delivers a bound as a real
 * number on some builds and as its decimal STRING on others, and `Number("")`
 * is 0 — so an absent bound read naively prints as `[min 0]` on every control.
 */
function axNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Roles that hold a position within a RANGE rather than a free value. */
const RANGE_ROLES = new Set(["slider", "spinbutton"]);

/**
 * The bounds of a range control. `slider "확대/축소" = "5"` says nothing about
 * where 5 sits: an agent asking for "about half" had no scale to aim at, and
 * the clearing ladder's End key silently pinned the control to its MAXIMUM
 * because nothing on the line said what the maximum was. Only the bounds Chrome
 * actually carries are printed — a missing one is unknown, not zero.
 */
function rangeFlags(node, role) {
  if (!RANGE_ROLES.has(role)) return "";
  const min = axNumber(axProp(node, "valuemin"));
  const max = axNumber(axProp(node, "valuemax"));
  // Chrome answers "no bounds declared at all" as literal ZEROS: a bare
  // <input type=number> arrives valuemin 0 / valuemax 0, byte-identical on the
  // wire to an authored 0..0 range (probed: round11-facts.spec.ts). Printing
  // the pair as `[min 0 max 0]` told the agent every unbounded number filter
  // on a page (ag-grid's, for one) only accepts 0 — a range the page never
  // declared. The pair of zeros is therefore treated as the sentinel it is;
  // a real bound never suppresses, because it arrives with at least one side
  // non-zero.
  if (min === 0 && max === 0) return "";
  const parts = [];
  if (min !== undefined) parts.push(`min ${min}`);
  if (max !== undefined) parts.push(`max ${max}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/** A character that ENDS a token: whitespace, punctuation, or a symbol. */
const TOKEN_BOUNDARY = /[\s\p{P}\p{S}]/u;

/**
 * True when `needle` appears in `hay` as a whole token — each end sitting at a
 * string edge, whitespace, punctuation, or a symbol. A hit INSIDE a larger word
 * or number does not count: plain `includes` let an ancestor label like
 * "달력 2026.08.08" swallow every calendar cell named "2", "8", "20" or "26",
 * silently deleting the page's day numbers from the output.
 */
function containsAsToken(hay, needle) {
  if (!hay || !needle) return false;
  const boundary = (ch) => !ch || TOKEN_BOUNDARY.test(ch);
  // A needle that BEGINS or ENDS on a boundary character carries that boundary
  // with it, so the hay does not have to supply one on that side. Wikipedia's
  // footnote links are the case: a cell reading "China[n 1]" holds a link named
  // "[n 1]", which sits at a NON-boundary position (an `a` right before the
  // bracket) and so survived suppression and printed the reference twice — same
  // for a "-5" fragment inside "ASEAN-5[r 10]". The calendar case is untouched
  // because it is digits at both ends: "26" inside "달력 2026.08.08" still
  // demands real boundaries, and still fails to find them.
  const selfLeft = TOKEN_BOUNDARY.test(needle[0]);
  const selfRight = TOKEN_BOUNDARY.test(needle[needle.length - 1]);
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    if ((selfLeft || boundary(hay[i - 1])) && (selfRight || boundary(hay[i + needle.length])))
      return true;
    from = i + 1;
  }
}

/** A word-ish character: a letter or a digit, in any script. */
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * Append `next` to `prev`, spacing ONLY a word|word seam — unless `realSpace`
 * says the PAGE put whitespace at this seam, in which case exactly one space
 * goes back whatever the characters on either side are.
 *
 * Every place this module rejoins text a page split — a welded accessible name,
 * a per-word <span> run, the pieces of one table cell — used to put a space at
 * EVERY seam, which invents punctuation spacing the page never had. Wikipedia
 * shipped `Search for " Accessibility tree "` (the quotes are their own text
 * nodes) and `[ n 2 ]` for a footnote link, and read_text answered
 * "request a new article ." because the trailing period is a StaticText of its
 * own. A boundary character on either side of the seam already separates the
 * two pieces, so only letter-beside-letter needs a space put back.
 *
 * That character rule then failed the OTHER way round, and in the same channel:
 * a page's real spaces sit exactly where the characters say none is needed.
 * Wikipedia's `StaticText "If the page has been deleted, "` beside
 * `link "check the deletion log"` read back as "…deleted,check the deletion
 * log"; `link "Wiktionary"` + `StaticText " (dictionary)"` as
 * "Wiktionary(dictionary)"; a footnote `[3]` followed by " Such fluctuations…"
 * as "[3]Such fluctuations…". Those spaces are not inferable from the
 * characters — they are CARRIED by the text node (see nameEdges) — so a caller
 * holding that evidence passes it in, and only a seam with no evidence either
 * way is left to the character classes.
 *
 * An empty side is still returned untouched: there is no seam to space.
 */
function glueSegments(prev, next, realSpace) {
  if (!prev) return next;
  if (!next) return prev;
  if (realSpace) return `${prev} ${next}`;
  return WORDISH.test(prev[prev.length - 1]) && WORDISH.test(next[0])
    ? `${prev} ${next}`
    : `${prev}${next}`;
}

/** Whitespace at the very start / very end of a string. */
const LEADING_WS = /^\s/;
const TRAILING_WS = /\s$/;

/**
 * The whitespace a page's own text node carries at each END of one AX name —
 * the evidence glueSegments' `realSpace` is decided on, and the reason it has to
 * be read off the NODE instead of off the string a renderer was handed.
 *
 * `walkAxNodes` TRIMS every name before emitting it, and that trim is load
 * bearing for the renderers: a label is printed quoted, where a stray edge space
 * reads as corruption, and the echo/coverage tests compare labels against each
 * other. But it also destroys the only fact that says whether the seam between
 * two pieces was a space ON THE PAGE — so the untrimmed name is re-read here,
 * once per glue site, and the trim stays exactly where it is.
 *
 * `trail` is suppressed for a piece that printed a VALUE after its name: what
 * the joined text ends with is then the value, which arrived trimmed, so the
 * name's trailing space says nothing about that edge.
 */
const nameEdges = (node, value) => {
  const raw = String(node?.name?.value ?? "");
  return { lead: LEADING_WS.test(raw), trail: !value && TRAILING_WS.test(raw) };
};

/**
 * Inline TEXT-LEVEL SEMANTIC roles, treated as STRUCTURAL. A `<mark>`,
 * `<strong>` or `<em>` is a phrasing wrapper AROUND a text run: never a
 * container in its own right, never printable content. Left non-structural, a
 * keyword-highlight `<mark>` emitted namelessly (printing nothing) but still
 * became the `container` of the first fragment of a sentence it split, while the
 * rest sat on the real container — so the halves never joined into one run and
 * the run-level suppression below never saw them. `[e82] option "검색어 광교역"`
 * printed with `StaticText "광교"` and `StaticText "역"` under it, re-spelling
 * the option's own label as two extra lines.
 *
 * The strings are Chrome's own, verified against `Accessibility.getFullAXTree`:
 * `<mark>`→mark, `<strong>`→strong, `<em>`→emphasis, `<sup>`→superscript,
 * `<sub>`→subscript, `<del>`/`<s>`→deletion, `<ins>`→insertion. (`<b>`, `<i>`,
 * `<span>` and friends already arrive as `generic`.) `code` and `time` are
 * deliberately absent: `<pre><code>` is a BLOCK, and dissolving it would glue a
 * code listing into the surrounding prose as one run.
 */
const TEXT_LEVEL_ROLES = new Set([
  "mark",
  "strong",
  "emphasis",
  "superscript",
  "subscript",
  "deletion",
  "insertion",
]);

/** Whitespace-free form, for comparing text a markup split MID-word. */
const stripSpaces = (s) => s.replace(/\s+/g, "");

/**
 * Containers whose inline text must NEVER be rejoined into one line. Run
 * joining rebuilds the paragraph a per-word <span> soup had split — but
 * `container` is the nearest EMITTING ancestor, and every plain <div> is
 * `generic` and therefore transparent, so two entirely unrelated page blocks
 * can share nothing but the landmark they both sit under. Joined on that, a
 * counter and a footer credit shipped as `StaticText "0 Powered by"`, a spinner
 * and the same credit as `"Loading… Powered by"` — sentences the page never
 * contained, which an agent cannot tell from real prose.
 *
 * The tradeoff is one-sided, which is why the guard is this blunt: the worst
 * case it causes is a word-split paragraph sitting DIRECTLY under a landmark
 * printing one word per line — ugly, obvious, and LOSSLESS — while a false join
 * fuses two unrelated facts into one and is invisible. Real prose lives in a
 * paragraph/heading/listitem/cell, all of which keep joining.
 */
const NON_JOINING_CONTAINERS = new Set([
  "RootWebArea",
  "main",
  "region",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "form",
  "dialog",
  "article",
  "tabpanel",
]);

/** True when a run of inline text under this container may be rejoined. */
const joinsRuns = (container) =>
  container != null && !NON_JOINING_CONTAINERS.has(container.role?.value);

/**
 * Stripped length a joined run must reach before a NEIGHBOURING line is allowed
 * to drop it. Two one-character segments occur in order inside almost any line;
 * eight characters of ordered agreement is no longer a coincidence.
 */
const RUN_ECHO_MIN_CHARS = 8;

/**
 * True when every segment of a joined run occurs, IN ORDER, inside `line`.
 *
 * The second shape of the keyword-highlight duplicate, and the one that
 * container-label suppression structurally cannot see: the page holds the
 * sentence TWICE — once whole (arriving as a single StaticText line) and once
 * split around the highlighted words, whose own text nodes never reach the run.
 * So the fragment run is not a SUBSTRING of anything; it is the sentence with
 * HOLES where the keywords were ("저당 시럽이라 달달한 단맛을 …" printed a second
 * time as "저당 이라 달달한 을 …"), which an `includes` test misses and both
 * lines shipped. An advancing-cursor indexOf chain matches through the holes.
 *
 * Whitespace-insensitive because the split loses the spaces too.
 */
function runEchoesLine(segments, line) {
  const hay = stripSpaces(String(line ?? ""));
  if (!hay) return false;
  let cursor = 0;
  let matched = 0;
  for (const segment of segments) {
    const needle = stripSpaces(String(segment ?? ""));
    if (!needle) continue;
    const at = hay.indexOf(needle, cursor);
    if (at < 0) return false;
    cursor = at + needle.length;
    matched += needle.length;
  }
  return matched >= RUN_ECHO_MIN_CHARS;
}

/**
 * The last line actually PRINTED before `index`. Suppressed lines are nulled in
 * place rather than spliced (byHref holds indices that must stay valid), so the
 * slot immediately before a run is not necessarily a line at all.
 */
function precedingLine(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) if (lines[i] != null) return lines[i];
  return null;
}

/** Brackets and whitespace, nothing else — and an OPENING one closed again. */
const BRACKETS_ONLY = /^[\s()[\]{}（）]*$/;
const OPENS_BRACKET = /[([{（]/;
const CLOSES_BRACKET = /[)\]}）]/;

/**
 * True for a line that is nothing but an empty pair of brackets: `( )`, `[ ]`,
 * `（）`. These are what is LEFT of a construct whose content this module
 * suppressed elsewhere (a link folded onto its duplicate, a reference dropped as
 * an echo) — the page's own punctuation around a hole, shipped to the agent as
 * if it were content. They cost a line each in both views and say nothing.
 *
 * A word character disqualifies, so `(광교점)` is text and stays; a bracket is
 * required, so `-` and other bare punctuation stay. Both an opener and a closer
 * are required, which is narrower than "only brackets" on purpose: read_text is
 * how an agent reads a source listing, and a line holding just `}` is that
 * listing's own content. Deleting real text unmarked is the one thing these
 * renderers must never do, and an unpaired bracket is not the leftover shape.
 */
const isBracketNoise = (text) =>
  BRACKETS_ONLY.test(text) && OPENS_BRACKET.test(text) && CLOSES_BRACKET.test(text);

/** A snapshot line whose whole content is bracket noise — never a uid line. */
const NOISE_SNAPSHOT_LINE = /^ *StaticText "(.*)"$/;
function isBracketNoiseSnapshotLine(line) {
  const hit = NOISE_SNAPSHOT_LINE.exec(line);
  return Boolean(hit) && isBracketNoise(hit[1]);
}

/** Cell roles whose row grouping the reading view restores. */
const CELL_ROLES = new Set([
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "LayoutTableCell",
]);

/** Row roles that own those cells. */
const ROW_ROLES = new Set(["row", "LayoutTableRow"]);

/** Bound on any ancestor climb, so a malformed tree cannot cost a walk. */
const CHAIN_MAX_HOPS = 25;

/**
 * How many options a COLLAPSED combobox prints before the rest fold into one
 * counted line. A closed <select> shows ONE value on screen while its AX
 * subtree carries every option — a version picker shipped ~900 of them, which
 * ate the whole snapshot budget (995 entries, the page's own content truncated
 * away) and drowned read_text in 17k chars of labels nobody can see (Monaco
 * playground, round 13). The selected option always prints past the cap, and a
 * snapshot scoped to the combobox's own uid prints the full list — that escape
 * hatch is what the folded line points at. select_option is unaffected either
 * way: its option-collector walks the DOM, not these lines.
 */
const COLLAPSED_OPTION_MAX = 12;

/**
 * The collapsed combobox an option is folded under, or null. Climbed over the
 * render's OWN parentOf map (same pattern as rowChain) because a native
 * <select>'s options may sit under an optgroup between them and the combobox.
 */
function collapsedComboAncestor(container, parentOf) {
  let at = container;
  for (let hops = 0; at && hops < CHAIN_MAX_HOPS; hops += 1) {
    if (at.role?.value === "combobox" && axStateFlag(at, "expanded") === false) return at;
    at = parentOf.get(at);
  }
  return null;
}

/**
 * The cell/row lookups for ONE render, over that render's map of emitted node →
 * its container. Testing `container.role` alone is what broke row joining on
 * every real table: a cell whose text lives on a nested LINK is itself NAMELESS
 * and so never prints, and the link's own container is the CELL, not the row —
 * so Wikipedia's GDP table printed the rank on its own line ("1", then "United
 * States | 32,383,920 | …") and split its header into six. Climbing the chain
 * instead finds the row from any depth inside it.
 */
function rowChain(parentOf) {
  const climb = (from, roles) => {
    let at = from;
    for (let hops = 0; at && hops < CHAIN_MAX_HOPS; hops += 1) {
      if (roles.has(at.role?.value)) return at;
      at = parentOf.get(at);
    }
    return null;
  };
  /** True when `outer` IS `inner` or one of its emitting ancestors. */
  const encloses = (outer, inner) => {
    let at = inner;
    for (let hops = 0; at && hops < CHAIN_MAX_HOPS; hops += 1) {
      if (at === outer) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  return {
    /** The cell a piece belongs to — the piece itself when it IS one. */
    cellOf: (node) => climb(node, CELL_ROLES),
    /** The row above a cell (or above a container, when there is no cell). */
    rowOf: (from) => climb(from, ROW_ROLES),
    /**
     * True when two pieces of ONE cell sit in SEPARATE BLOCKS of it rather than
     * at two depths of the same block — which is a seam no text node can carry
     * whitespace across, and so the one place a cell join has to supply a space
     * from the structure instead of from the evidence. A cell holding two
     * paragraphs is the case: "First sentence." and "Second sentence." welded
     * into "First sentence.Second sentence.", a sentence boundary an agent
     * cannot see.
     *
     * "Different container" is NOT the test, because moving DEEPER or SHALLOWER
     * inside one block also changes it: Wikipedia's footnote cell holds "China"
     * inside a block and the marker "[n 1]" directly at cell level, and that
     * pair must stay welded as the page drew it. Only a pair where neither
     * container encloses the other is a real sibling-block boundary.
     */
    crossesBlocks: (a, b) => Boolean(a) && Boolean(b) && !encloses(a, b) && !encloses(b, a),
  };
}

/**
 * Image roles. An image is normally NOT actionable — on a search page every
 * thumbnail sits inside the link it illustrates, and a uid per image would
 * double the snapshot with refs whose real click target is the ancestor.
 * Outside any actionable ancestor the opposite is true: a Naver map's markers
 * surface as `image "음식점"` with nothing above them that takes a click, so
 * reaching one meant guessing pixels with click_at.
 */
const IMAGE_ROLES = new Set(["image", "img"]);

/**
 * Longest neighbouring text folded onto a marker image's line. A Naver map
 * draws 47 markers and every one of them arrives as `image "음식점"` — clickable,
 * and indistinguishable from the other 46, so choosing one was a guess. The name
 * that tells them apart (the shop's) is a StaticText SIBLING, which prints on
 * the next line and reads as unrelated. Folding it onto the marker's own line is
 * what makes the uid mean something; the cap is there because a paragraph that
 * merely happens to follow a marker is not that marker's label.
 */
const MARKER_LABEL_MAX = 120;

/**
 * Ancestors that carry a uid WITHOUT owning their descendants' clicks. A named
 * region or application is a drawn SURFACE — a map body, an embedded app — and
 * a canvas is a bare coordinate plane: they mint a uid so click_at has anything
 * at all to aim at, not because clicking their centre reaches something inside
 * them. The map markers this whole rule exists for sit INSIDE exactly such a
 * container (`region "지도"` → `image "음식점"`), so counting the surface as the
 * click target would put every marker straight back out of reach.
 *
 * A CONTROL ancestor is the opposite and still blocks: a link, a button, a
 * named row or an editable root genuinely takes the click, and the image inside
 * it is that control's label rather than a target of its own.
 *
 * Derived from NAMED_CONTAINER_UID_ROLES rather than re-listed: the two sets
 * answer the same question about the same roles ("this is a surface, not a
 * control"), and spelling them out twice is how one of them silently loses a
 * role the other keeps.
 */
const SURFACE_ROLES = new Set(NAMED_CONTAINER_UID_ROLES);

/**
 * The ROOT of an editable region — the one node in it an agent clicks and types
 * into. Shared by the walk and by isActionableNode so the node that gets a uid
 * and the node that survives structural skipping can never be different ones.
 *
 * `editable` alone does NOT mean root. Measured against real Chromium over CDP
 * (Accessibility.getFullAXTree), Chrome stamps `editable` on every DESCENDANT of
 * an editable region too: inside `<div contenteditable><p>hello <b>world</b></p>`
 * the div, both paragraphs, all three StaticTexts and the InlineTextBoxes each
 * report editable="richtext". Keying on it alone minted a uid per text node —
 * and worse, made StaticText INTERACTIVE, which silently switched off run
 * joining (`inRun` requires `!interactive`) and its duplicate suppression inside
 * every editor on the page.
 *
 * `focusable === true` is what separates them: in those same probes it was true
 * on the contenteditable div, on a designMode frame's RootWebArea, and on a
 * contenteditable <body>, and absent on every descendant and on a textarea's
 * inner generic.
 */
const isEditableRoot = (node) =>
  Boolean(axProp(node, "editable")) && axProp(node, "focusable") === true;

/** Bound on the descendant walk one name re-spacing costs. */
const NAME_RESPACE_MAX_NODES = 300;

/**
 * An accessible name Chrome built by CONCATENATING descendant text, put back
 * into words. A Naver Maps place button arrives as
 * `button "영업 종료별점 4.76리뷰7,262TV 식스센스"` — business status, rating,
 * review count and title welded together — and the separated child StaticTexts
 * that could have been read instead are then deleted as a run-level echo of
 * that very name, so nothing on the page recovers the structure. Fixing it HERE
 * fixes it for both renderers and for ancestor coverage at once.
 *
 * What this may never do is invent a word boundary: a name is the whole of what
 * an agent has to go on for a control, and a name the page does not contain is
 * unrecognizable as ours. So the rebuild fires ONLY when the raw name is fully
 * ACCOUNTED FOR by the segments, and declines — printing today's welded name,
 * which is benign and recoverable — the moment anything is left over.
 *
 * Two kinds of whitespace have to be told apart, and they are told apart by
 * WHERE the space sits:
 *
 *   PROSE SPACING is carried by a segment's own text node, at its edge. The
 *   pinned review link "옥수수 크림 뇨끼랑 홈메이드 라자냐 시켰는데" is split as
 *   "옥수수 " + "크림 뇨끼" + "랑 홈메이드 …": the page wrote a space after
 *   옥수수 and none in front of 랑, and re-spacing that ships a space before a
 *   postposition — a sentence the page does not contain. So ANY segment
 *   carrying an edge space declines the whole name (the PROSE GUARD): the page
 *   is doing its own spacing here and this function has nothing to add.
 *
 *   A CHROME-INSERTED SEPARATOR is present in the RAW NAME and in no segment at
 *   all. accname leaves block-boundary separation to the implementation, and
 *   Chrome does insert one. Live CDP dump from map.naver.com, which is the field
 *   evidence for this whole branch: a place row arrives as
 *   `button "영업 종료별점 4.87리뷰1,269"` over segments 영업 종료 / 별점 / 4.87
 *   / 리뷰 / 1,269 — welded at three boundaries and spaced at exactly one, the
 *   block edge of the absolutely-positioned visually-hidden `place_blind` span
 *   that holds 별점. Not one segment contains that space, so the old strict
 *   `segments.join("") === rawName` gate could never pass: every place row on
 *   Korea's dominant map service printed welded, and its child StaticTexts then
 *   escaped container-echo suppression and re-spelled the label a line at a
 *   time. Consume-matching the segments against the raw name and ALLOWING a run
 *   of whitespace between two of them accounts for such a name exactly, and the
 *   seam is rebuilt as the one space that was already there.
 *
 * A DRY seam is still a GUESS, knowingly the same guess round 7 already accepted
 * for a fully-welded name: nothing in the strings says how 종료|별점, which wants
 * a space, differs from 광교|역, which must never get one — both are Hangul
 * beside Hangul — so glueSegments' character rule decides and letter-beside-
 * letter gets a space. A fully-welded name therefore behaves byte-identically to
 * before (every seam dry, same pairwise glue), and the honest limit of the new
 * branch is a name mixing BOTH kinds of seam: a Chrome separator plus a genuine
 * mid-word span split, e.g. "가격 안내" built from "가격" + "안" + "내", now
 * ships "가격 안 내" instead of declining (pinned in the tests). The trade is
 * deliberate — what loses is a phrasing wrapper splitting a Korean word inside a
 * name that ALSO crosses a block boundary; what wins is every rating row on the
 * map service this rule exists for.
 *
 * A phrasing wrapper (mark/strong/em …) still ABORTS the walk outright rather
 * than contributing a segment: it splits a text run MID-WORD by construction,
 * which is the one split no seam rule can decide.
 *
 * Skipped for OPAQUE_NAME_ROLES, which is both the cost bound and the meaning:
 * their name does not come from their contents, so it was never concatenated.
 *
 * The segments are NOT plain StaticText descendants only. A named descendant
 * contributes its NAME and is not walked into, which is what accname itself
 * says a name stands in for — and without it the star-rating rows on the same
 * page never re-spaced at all: the rating text lives on an image's alt rather
 * than in a text node, so the collected StaticTexts could not account for the
 * raw name and the match declined every time. Where a named descendant's name
 * EQUALS its contents the result is the same either way; where it does not, the
 * match simply fails and today's welded name prints, which is the benign
 * direction.
 */
function respacedName(node, role, rawName, byId) {
  if (rawName.length < 4 || !node.childIds?.length || OPAQUE_NAME_ROLES.has(role)) return rawName;
  /** Each: { text: trimmed, edged: the page's own space at one of its ends }. */
  const segments = [];
  const seen = new Set();
  let budget = NAME_RESPACE_MAX_NODES;
  const collect = (id) => {
    if (budget <= 0) return false;
    const child = byId.get(id);
    if (!child || seen.has(id)) return true;
    seen.add(id);
    budget -= 1;
    const childRole = child.role?.value;
    if (TEXT_LEVEL_ROLES.has(String(childRole).toLowerCase())) return false;
    const raw = String(child.name?.value ?? "");
    const text = raw.trim();
    const piece = { text, edged: LEADING_WS.test(raw) || TRAILING_WS.test(raw) };
    // A StaticText IS its text: its only children are InlineTextBoxes, which
    // re-spell the very same words and would be counted a second time.
    if (childRole === "StaticText") {
      if (text) segments.push(piece);
      return true;
    }
    // A named descendant stands in for its own contents, so it is one segment
    // and the walk stops there. InlineTextBox is excluded for the reason above,
    // in case a malformed tree hands one over outside a StaticText.
    if (text && childRole !== "InlineTextBox") {
      segments.push(piece);
      return true;
    }
    for (const grandChildId of child.childIds || []) if (!collect(grandChildId)) return false;
    return true;
  };
  for (const childId of node.childIds) if (!collect(childId)) return rawName;
  if (segments.length < 2) return rawName;
  // The prose guard. One segment spacing itself is the page's own typography,
  // and there is no honest way to re-space the rest of the name around it.
  if (segments.some((segment) => segment.edged)) return rawName;
  // Consume-match, left to right: every segment has to sit contiguously where
  // the previous one ended, and the ONLY thing allowed between two of them is
  // whitespace the raw name carries and no segment does — Chrome's own
  // block-boundary separator, recorded per seam so the rebuild can put back
  // exactly what was there. A mismatch, a leftover prefix or an unconsumed tail
  // all mean the name was not built out of these pieces, and nothing is rebuilt.
  const seams = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i += 1) {
    if (i > 0) {
      const gap = /^\s+/.exec(rawName.slice(cursor));
      seams.push(Boolean(gap));
      cursor += gap ? gap[0].length : 0;
    }
    if (!rawName.startsWith(segments[i].text, cursor)) return rawName;
    cursor += segments[i].text.length;
  }
  if (cursor !== rawName.length) return rawName;
  let rebuilt = segments[0].text;
  for (let i = 1; i < segments.length; i += 1)
    rebuilt = glueSegments(rebuilt, segments[i].text, seams[i - 1]);
  return rebuilt;
}

/**
 * The one AX walk both renderers share, so their notion of document order,
 * ancestor-label coverage, and skipped structural nodes can never drift apart.
 *
 * Walks childIds rather than the flat node array Chrome hands back. Two
 * reasons: that array is not reliably in document order, and only a real walk
 * knows a node's ancestors — which is what lets a renderer drop text an
 * ancestor's label already spells out. A link and the StaticText inside it are
 * one thing to a reader, and printing both doubled the size of every snapshot.
 *
 * `emit(node, role, name, value, covered, container, depth)` fires once per
 * printable candidate; each renderer decides what (if anything) that node
 * becomes. `container` is the nearest ancestor that emitted (structural and
 * ignored nodes are transparent), or null at a root — it is how a renderer tells
 * one paragraph's worth of inline text apart from two unrelated blocks. `depth`
 * counts those same emitting ancestors, so a renderer can show nesting without
 * re-deriving it. When `startBackendNodeId` is given, only that node's subtree
 * is walked; returns false when no node carries that id (a stale uid).
 *
 * `scopeDomIds` is a set of backendDOMNodeIds the CALLER established (by walking
 * the DOM subtree, which this module cannot do) as living inside the scoped
 * element. It exists because a scoped walk sees far less than the full one: the
 * full walk sweeps roots, then unclaimed nodes, then whatever is left, so a
 * detached island — a node hanging off a pruned or aria-hidden ancestor — still
 * prints, while the childIds chain under one start node simply cannot reach it.
 * A map's 47 markers vanished exactly that way: `snapshot(uid=region "Map")`
 * answered with the region line alone while the full page showed every marker.
 * In-scope nodes the chain missed are visited afterwards as extra roots; the
 * seen-set is what keeps that from emitting anything twice. No set (or an empty
 * one) leaves the walk byte-identical, and a start id matching nothing still
 * answers false whatever the set holds.
 *
 * With a set and NO start id the walk is that sweep and nothing else — the
 * SWEEP-ONLY mode. It answers the case where the scoped element is alive in the
 * DOM but absent from the AX tree that was just fetched: a covering overlay div
 * that never got an accessibility node at all, or a map pane caught mid-rebuild.
 * There is no start node to walk down from, so the only thing that can be
 * rendered is what the DOM says lives inside it — the in-scope ids, each entered
 * as a root at depth 0. Reaching for the FULL walk instead would answer a scoped
 * read with the whole page, which reads as content of the element the agent
 * asked about.
 */
function walkAxNodes(nodes, startBackendNodeId, emit, scopeDomIds) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();

  const visit = (node, covered, container, depth) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value;
    // A bare contenteditable surface has NO role of its own: a `<div
    // contenteditable>` and a contenteditable `<body>` both arrive as `generic`,
    // which is structural — so the only focusable, typeable handle of the whole
    // editor was never emitted, and an iframe rich-text editor had no uid
    // anywhere on the page. (The frame's RootWebArea is not a substitute: with a
    // contenteditable BODY it carries focusable but no `editable` at all.) An
    // editable ROOT therefore stays visible; it prints as a nameless interactive
    // and becomes the container of its own children, which it genuinely is.
    // Every other structural role keeps its meaning — descendants of an editable
    // region carry `editable` too, and isEditableRoot is what tells them apart.
    const structural =
      !role ||
      role === "none" ||
      (role === "generic" && !isEditableRoot(node)) ||
      role === "InlineTextBox" ||
      TEXT_LEVEL_ROLES.has(String(role).toLowerCase());
    let inherited = covered;
    let childContainer = container;
    let childDepth = depth;
    if (!node.ignored && !structural) {
      // AXValue is not always a string — a slider or spinbutton reports a
      // NUMBER, and calling .trim() on it threw, failing every read tool on
      // any page carrying one. `?? ""` rather than `|| ""` so a numeric 0
      // renders as "0" instead of vanishing.
      const name = respacedName(node, role, String(node.name?.value ?? "").trim(), byId);
      const value = String(node.value?.value ?? "").trim();
      emit(node, role, name, value, covered, container, depth);
      if (name && !OPAQUE_NAME_ROLES.has(role)) inherited = name;
      childContainer = node;
      childDepth = depth + 1;
    }
    for (const childId of node.childIds || [])
      visit(byId.get(childId), inherited, childContainer, childDepth);
  };

  /** Every in-scope node the chain has not already reached, as its own root. */
  const sweepScope = () => {
    for (const node of nodes) {
      if (seen.has(node.nodeId) || node.backendDOMNodeId == null) continue;
      if (scopeDomIds.has(node.backendDOMNodeId)) visit(node, "", null, 0);
    }
  };

  if (startBackendNodeId != null) {
    const start = nodes.find((node) => node.backendDOMNodeId === startBackendNodeId);
    if (!start) return false;
    visit(start, "", null, 0);
    // The stale-uid contract is decided by the START node alone: a scope set is
    // the caller widening a scope it already has, never a substitute for one it
    // asked for and did not get.
    if (scopeDomIds?.size) sweepScope();
    return true;
  }

  // Sweep-only: no start node to descend from, so the scope IS the set.
  if (scopeDomIds?.size) {
    sweepScope();
    return true;
  }

  const claimed = new Set();
  for (const node of nodes) for (const childId of node.childIds || []) claimed.add(childId);
  for (const node of nodes) if (!claimed.has(node.nodeId)) visit(node, "", null, 0);
  // Anything left is detached from every root (a mid-walk DOM change, a cycle).
  // Print it rather than silently losing page content.
  for (const node of nodes) visit(node, "", null, 0);
  return true;
}

/**
 * Whether an agent can ACT on this node — the ONE predicate that decides which
 * elements mint a uid. Shared with `unlabeledInteractiveIds` so a hint looked up
 * by the caller can never describe a node the renderer does not print, nor miss
 * one it does.
 */
export function isActionableNode(node, role, name, value) {
  if (INTERACTIVE_ROLES.has(role)) return true;
  // An Iframe is almost always NAMELESS, so both of these must be decided
  // BEFORE the nameless gate below or they never fire at all.
  //
  // The Iframe itself: its uid is the handle for a frame-scoped snapshot or
  // screenshot, the only thing that ties a trailing frame block back to a place
  // in the main tree, and a click target of last resort.
  if (role === "Iframe") return true;
  // The ROOT of an editable region — a contenteditable div or body, or the
  // RootWebArea of a designMode frame, which is where a rich-text editor
  // (TinyMCE and friends) puts the caret. Such a root is opaque-named or
  // nameless, so the focusable branch below skips it and these editors had no
  // uid anywhere: visible, and impossible to type into. It must be decided by
  // isEditableRoot and not by `editable` alone — see there for the measurement
  // showing every descendant carries `editable` as well.
  if (isEditableRoot(node)) return true;
  // Clickable-in-practice surfaces: named table/tree rows and cells, named
  // drawn surfaces (map/app containers), plus anything the page marked
  // focusable (accordion headers, custom widgets). Opaque containers are
  // excluded from the FOCUSABLE branch — RootWebArea and friends report
  // focusable without being a target anyone means to click.
  if (!name && !value) return false;
  return (
    NAMED_CLICKABLE_ROLES.has(role) ||
    NAMED_CONTAINER_UID_ROLES.has(role) ||
    (axProp(node, "focusable") === true && !OPAQUE_NAME_ROLES.has(role))
  );
}

/**
 * backendNodeIds of interactive nodes the accessibility tree cannot name AT
 * ALL: no name, no value, and no description either — so even the `title`
 * fallback has nothing to print. These are the `[e48] button ""` lines an agent
 * cannot tell apart. The caller looks up a short DOM identifier for them and
 * passes it back through `renderAxTree`'s `hints`; that lookup stays outside
 * this module because it costs a CDP round trip per node, which a pure
 * renderer has no business spending.
 */
export function unlabeledInteractiveIds(nodes) {
  const ids = new Set();
  walkAxNodes(nodes, undefined, (node, role, name, value) => {
    if (name || value || node.backendDOMNodeId == null) return;
    if (!isActionableNode(node, role, name, value)) return;
    if (String(node.description?.value ?? "").trim()) return;
    ids.add(node.backendDOMNodeId);
  });
  return [...ids];
}

/**
 * backendNodeId -> aria-sort value ("ascending" / "descending" / "other") from
 * ONE `DOMSnapshot.captureSnapshot` document. CDP's accessibility tree does not
 * deliver aria-sort at all — probed in round11-facts.spec.ts, where a sorted
 * native <th> and an ARIA columnheader both arrive carrying only
 * readonly/required — so the DOM attribute is the only place the sorted state
 * exists, and this reads it out of the capture the snapshot already pays for
 * (no extra CDP round trip). "none" and unknown values are treated as the
 * attribute being absent, which is what they mean.
 */
export function ariaSortByBackendId(document, strings) {
  const map = new Map();
  const nodes = document?.nodes;
  const table = Array.isArray(strings) ? strings : null;
  if (!nodes || !table) return map;
  const backendIds = nodes.backendNodeId || [];
  const attributes = nodes.attributes || [];
  const str = (index) => (typeof index === "number" && index >= 0 ? String(table[index] ?? "") : "");
  for (let i = 0; i < backendIds.length; i += 1) {
    const attrs = attributes[i];
    if (backendIds[i] == null || !Array.isArray(attrs)) continue;
    for (let at = 0; at + 1 < attrs.length; at += 2) {
      if (str(attrs[at]).toLowerCase() !== "aria-sort") continue;
      const value = str(attrs[at + 1]).trim().toLowerCase();
      if (value === "ascending" || value === "descending" || value === "other") {
        map.set(backendIds[i], value);
      }
      break;
    }
  }
  return map;
}

/**
 * Most LINES the AX-invisible clickable section prints. The section exists to
 * make a drawn grid reachable, not to re-describe the page: past this many the
 * useful answer is a narrower view, which is what the truncation notice says.
 *
 * A line is not always an element: since grouping (issue #62) a run of
 * interchangeable elements spends ONE line on a summary, so the section now
 * covers far more of the page inside the same budget. What the selection walk
 * may COLLECT is a separate, larger cap owned by the caller
 * (EXTRA_CLICKABLE_COLLECT_MAX in background.js) — grouping cannot summarize
 * what it was never handed.
 */
export const EXTRA_CLICKABLE_MAX = 40;

/**
 * Node count past which this enrichment gives up on a document. It bails WHOLE
 * rather than part-way on purpose: every rule below is decided by ANCESTOR and
 * DESCENDANT relationships, so a truncated node array does not answer LESS, it
 * answers WRONG — a wrapper whose real click target sits outside the walked
 * range would be listed as if it were the target itself.
 */
const EXTRA_CLICKABLE_SCAN_MAX = 50000;

/** Smallest box worth a uid, px. Below this it is a divider, a badge or a hairline. */
const EXTRA_CLICKABLE_MIN_PX = 12;

/**
 * Share of the viewport past which a box is a SURFACE, not an item. This is the
 * guard that makes the whole feature work on React-style pages: a framework
 * delegates its click listener to a container, so Chrome marks the CONTAINER as
 * clickable and none of the tiles inside it — listing that container would hand
 * the agent one uid for a whole grid, and the per-tile pointer boundaries that
 * ARE the answer would be pruned away as its descendants.
 */
const EXTRA_CLICKABLE_VIEWPORT_SHARE = 0.5;

/**
 * Share of a surviving ancestor's box past which a nested clickable counts as a
 * LAYER over the same click rather than a control inside it. An overlay is drawn
 * across the thing it covers; a close row, a button, a footer strip is a slice of
 * it. Only consulted for nodes that carry their own click listener — see the
 * `outermost` filter.
 */
const EXTRA_NESTED_COVER_SHARE = 0.8;

/** Printed label and DOM hint caps — sized like buildDomHint's, for the same reason. */
const EXTRA_LABEL_MAX = 80;
const EXTRA_HINT_MAX = 60;

/** Descendants one candidate's label may be gathered from. A tile can wrap a feed. */
const EXTRA_LABEL_SCAN_MAX = 200;

/** Ancestor hops any of the climbs below will pay. Real DOM depth is far under this. */
const EXTRA_ANCESTOR_HOPS = 200;

/** nodeNames that are the PAGE, never an item in it. */
const EXTRA_CLICKABLE_SKIP_NAMES = new Set(["BODY", "HTML", "#DOCUMENT"]);

/**
 * Cursor values that are the page telling a person "act here". `pointer` is the
 * click affordance; `grab` and `move` are the DRAG affordances a reorderable
 * list or a pannable pane styles its handles with — and a drag target needs a
 * uid exactly as much as a click target does (round 12: the `drag` op exists,
 * SortableJS-style items do not, because their only listener is a `pointerdown`
 * on the container, which `isClickable` does NOT mark — probed in
 * tests/visual/round12-facts.spec.ts). `grabbing` is deliberately absent: it is
 * the MID-DRAG state, not an affordance at rest.
 */
const CLICK_AFFORDANCE_CURSORS = new Set(["pointer", "grab", "move"]);

/**
 * The clickable elements the accessibility tree does not contain, so that a page
 * built out of drawn tiles is addressable at all.
 *
 * Field case: a thumbnail grid whose items are <div>s or <canvas>es carrying a
 * JS click listener and/or `cursor: pointer`, and no role, name or tabindex.
 * Chrome computes nothing worth emitting for them, so the AX walk mints no uid
 * and the agent's only remaining move was a pixel gamble with click_at.
 *
 * Input is ONE `DOMSnapshot.captureSnapshot` document — parallel arrays indexing
 * a shared `strings` table — captured with `computedStyles: ["cursor"]`. Nothing
 * here costs a CDP round trip: label and hint are derived from the arrays
 * already in hand, because a section a snapshot pays for on EVERY call has to be
 * free after the one capture.
 *
 * TWO signals, because neither alone finds a real page's tiles. `isClickable` is
 * Chrome's own mark for a node with a mouse-click listener, and it is measured
 * (`tests/visual/ax-facts.spec.ts`) to mark ONLY the node the listener is bound
 * to — a framework that delegates to the grid root leaves every tile unmarked.
 * The pointer-cursor BOUNDARY covers those: cursor inherits, so a node whose own
 * cursor is `pointer` while the nearest ancestor that has a cursor at all is not
 * is the outermost thing the PAGE is telling a person to click.
 *
 * `opts.mintedBackendIds` is what the AX render minted on THIS pass — never the
 * persistent uid map, which remembers the elements this very function minted
 * last time and would exclude exactly them. `opts.containerBackendIds` is the
 * subset of the page's elements whose AX role says CONTAINER (cell, row,
 * region, …): a candidate nested under one of those survives when it covers
 * only a slice of it — see `isMintedContainer` below. `opts.viewport` is the layout
 * viewport in the same DOCUMENT coordinates as `layout.bounds` (hence its
 * pageX/pageY origin); only its area is read today, and it is what separates a
 * delegated container from an item. `opts.limit` is the budget LEFT, because a
 * page's documents share one cap.
 *
 * Returns `{ items, more }`. `more` is how many candidates the limit cut off: a
 * silent cap is a page the agent believes it has seen the whole of.
 */
export function extraClickables(document, strings, opts) {
  const limit = Math.max(0, Math.trunc(Number(opts?.limit ?? EXTRA_CLICKABLE_MAX)) || 0);
  const nodes = document?.nodes;
  const layout = document?.layout;
  const table = Array.isArray(strings) ? strings : null;
  if (!nodes || !layout || !table) return { items: [], more: 0 };

  const parentIndex = nodes.parentIndex || [];
  const nodeNames = nodes.nodeName || [];
  const backendIds = nodes.backendNodeId || [];
  const attributes = nodes.attributes || [];
  const count = backendIds.length;
  if (!count || count > EXTRA_CLICKABLE_SCAN_MAX) return { items: [], more: 0 };

  const str = (index) =>
    typeof index === "number" && index >= 0 ? String(table[index] ?? "") : "";
  const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const parentOf = (index) => {
    const parent = parentIndex[index];
    return typeof parent === "number" && parent >= 0 && parent !== index ? parent : -1;
  };

  const layoutNodes = layout.nodeIndex || [];
  const boundsOf = layout.bounds || [];
  const stylesOf = layout.styles || [];
  const textOf = layout.text || [];
  /** nodeIndex -> its layout slot. A node without one is not laid out at all. */
  const layoutAt = new Map();
  for (let slot = 0; slot < layoutNodes.length; slot += 1) layoutAt.set(layoutNodes[slot], slot);

  // `computedStyles: ["cursor"]` was requested, so slot 0 of a layout entry's
  // style list IS the cursor; a negative index means Chrome had no value there.
  const ownCursor = (index) => {
    const slot = layoutAt.get(index);
    return slot === undefined ? "" : str(stylesOf[slot]?.[0]);
  };
  /** Memoized so one climb serves a whole branch — a big page has 50k nodes. */
  const cursorCache = new Map();
  const effectiveCursor = (index) => {
    const path = [];
    let at = index;
    let value = "";
    for (let hop = 0; at >= 0 && hop < EXTRA_ANCESTOR_HOPS; hop += 1) {
      const cached = cursorCache.get(at);
      if (cached !== undefined) {
        value = cached;
        break;
      }
      const own = ownCursor(at);
      if (own) {
        cursorCache.set(at, own);
        value = own;
        break;
      }
      path.push(at);
      at = parentOf(at);
    }
    for (const one of path) cursorCache.set(one, value);
    return value;
  };
  const isPointerBoundary = (index) =>
    CLICK_AFFORDANCE_CURSORS.has(ownCursor(index)) &&
    !CLICK_AFFORDANCE_CURSORS.has(effectiveCursor(parentOf(index)));

  const candidates = new Set();
  /**
   * Candidates carrying a click listener of their OWN, as opposed to the ones
   * inferred from a pointer-cursor boundary. The distinction decides whether a
   * nested candidate is the same click as its container (see `outermost` below).
   */
  const ownListener = new Set();
  for (const index of nodes.isClickable?.index || []) {
    if (typeof index === "number" && index >= 0 && index < count) {
      candidates.add(index);
      ownListener.add(index);
    }
  }
  for (const index of layoutNodes) {
    if (index >= 0 && index < count && isPointerBoundary(index)) candidates.add(index);
  }
  if (!candidates.size) return { items: [], more: 0 };

  const view = opts?.viewport || {};
  const viewArea = (Number(view.width) || 0) * (Number(view.height) || 0);
  // No usable viewport leaves the area guard off rather than dropping the whole
  // section: the caller owns that measurement and has no reason to omit it.
  const maxArea = viewArea > 0 ? viewArea * EXTRA_CLICKABLE_VIEWPORT_SHARE : Infinity;
  const passesGuards = (index) => {
    if (backendIds[index] == null) return false;
    if (EXTRA_CLICKABLE_SKIP_NAMES.has(str(nodeNames[index]).toUpperCase())) return false;
    const slot = layoutAt.get(index);
    if (slot === undefined) return false;
    const box = boundsOf[slot] || [];
    const width = Number(box[2]) || 0;
    const height = Number(box[3]) || 0;
    if (width < EXTRA_CLICKABLE_MIN_PX || height < EXTRA_CLICKABLE_MIN_PX) return false;
    return width * height <= maxArea;
  };

  /** nodeIndex of everything the AX render already gave a uid this pass. */
  const minted = new Set();
  const mintedIds = opts?.mintedBackendIds;
  if (mintedIds && typeof mintedIds.has === "function") {
    for (let index = 0; index < count; index += 1) {
      if (mintedIds.has(backendIds[index])) minted.add(index);
    }
  }
  // A card that CONTAINS a real link or button is not the target — the control
  // inside it is, and listing the card too spends two uids on one click. Marked
  // by climbing from each minted node once rather than searching per candidate.
  const holdsMinted = new Set();
  for (const index of minted) {
    let at = parentOf(index);
    for (let hop = 0; at >= 0 && hop < EXTRA_ANCESTOR_HOPS; hop += 1) {
      if (holdsMinted.has(at)) break;
      holdsMinted.add(at);
      at = parentOf(at);
    }
  }
  const nearestMintedAncestor = (index) => {
    let at = parentOf(index);
    for (let hop = 0; at >= 0 && hop < EXTRA_ANCESTOR_HOPS; hop += 1) {
      if (minted.has(at)) return at;
      at = parentOf(at);
    }
    return -1;
  };
  const areaOf = (index) => {
    const slot = layoutAt.get(index);
    if (slot === undefined) return 0;
    const box = boundsOf[slot] || [];
    return (Number(box[2]) || 0) * (Number(box[3]) || 0);
  };
  /**
   * Minted elements the caller knows to be CONTAINERS by role (cell, row,
   * region, …) rather than controls. A candidate under a minted CONTROL is that
   * control's insides; one under a minted CONTAINER at a small share of its box
   * is a control of its own. Field case (round 12): FullCalendar's event bar —
   * a pointer-cursor <a> with no href — sits inside the minted gridcell, and
   * the unconditional under-minted prune left the one draggable thing in each
   * cell with no uid anywhere.
   */
  const containerIds = opts?.containerBackendIds;
  const isMintedContainer = (index) =>
    Boolean(containerIds && typeof containerIds.has === "function" && containerIds.has(backendIds[index]));

  const surviving = [];
  for (const index of [...candidates].sort((a, b) => a - b)) {
    if (!passesGuards(index)) continue;
    if (minted.has(index) || holdsMinted.has(index)) continue;
    const under = nearestMintedAncestor(index);
    if (under >= 0) {
      const outer = areaOf(under);
      if (!isMintedContainer(under) || !(outer > 0) || areaOf(index) / outer >= EXTRA_NESTED_COVER_SHARE) {
        continue;
      }
    }
    surviving.push(index);
  }
  // Outermost wins: a tile's inner overlay is the same click, and the whole tile
  // box is what a person aims at.
  //
  // UNLESS the inner node is a distinct CONTROL rather than a layer over the same
  // click — which takes both signals to tell apart, because "nested and
  // clickable" describes both. It is a control when it carries a click listener
  // of its OWN *and* it occupies only a part of the ancestor's box.
  //
  // Field case for keeping it: a modal (the-internet.herokuapp.com/entry_ad)
  // whose box carries a listener that only calls stopPropagation, wrapping the
  // "Close" strip that carries the listener which actually dismisses it.
  // Outermost-wins kept the inert box, pruned the one control that worked, and
  // the click UNDER the modal is (correctly) refused — leaving no route to
  // unblock the page at all.
  //
  // Field case for still pruning: a tile with an overlay drawn across it. Both
  // have listeners, the overlay covers the tile, and two uids for one click is
  // exactly the noise this rule exists to prevent. The tile GRID case is
  // untouched either way: there the click is DELEGATED to the grid root, so
  // Chrome marks only that root and the tiles are pointer-cursor boundaries with
  // no listener of their own.
  const survivingSet = new Set(surviving);
  const outermost = surviving.filter((index) => {
    let at = parentOf(index);
    for (let hop = 0; at >= 0 && hop < EXTRA_ANCESTOR_HOPS; hop += 1) {
      if (survivingSet.has(at)) {
        if (!ownListener.has(index)) return false;
        const outer = areaOf(at);
        return outer > 0 && areaOf(index) / outer < EXTRA_NESTED_COVER_SHARE;
      }
      at = parentOf(at);
    }
    return true;
  });
  const kept = outermost.slice(0, limit);
  // A budget already spent by an earlier document still has to COUNT what it
  // leaves behind: silently answering nothing here would let a page's second
  // document vanish without the truncation notice ever being printed.
  if (!kept.length) return { items: [], more: outermost.length };

  const childrenOf = new Map();
  for (let index = 0; index < count; index += 1) {
    const parent = parentOf(index);
    if (parent < 0) continue;
    const kin = childrenOf.get(parent);
    if (kin) kin.push(index);
    else childrenOf.set(parent, [index]);
  }
  const descendantsOf = (index) => {
    const out = [];
    const queue = [...(childrenOf.get(index) || [])];
    while (queue.length && out.length < EXTRA_LABEL_SCAN_MAX) {
      const at = queue.shift();
      out.push(at);
      const kin = childrenOf.get(at);
      if (kin) queue.push(...kin);
    }
    return out;
  };
  /** One node's attributes as { name: value } — DOMSnapshot ships them flat. */
  const attrsOf = (index) => {
    const flat = attributes[index] || [];
    const attrs = {};
    for (let i = 0; i + 1 < flat.length; i += 2) attrs[str(flat[i])] = str(flat[i + 1]);
    return attrs;
  };

  // What the element says it is, in the order a person would read it: its own
  // label, then the alt text of what it draws (a thumbnail IS an <img> often
  // enough), then the words rendered inside it. Nothing here can tell a tile
  // apart on its own, which is why the hint rides along too.
  const labelOf = (index) => {
    const attrs = attrsOf(index);
    const own = clip(attrs["aria-label"] || attrs.title, EXTRA_LABEL_MAX);
    if (own) return own;
    const alts = [];
    const words = [];
    for (const at of descendantsOf(index)) {
      if (str(nodeNames[at]).toUpperCase() === "IMG") {
        const alt = clip(attrsOf(at).alt, EXTRA_LABEL_MAX);
        if (alt) alts.push(alt);
      }
      const slot = layoutAt.get(at);
      const text = slot === undefined ? "" : clip(str(textOf[slot]), EXTRA_LABEL_MAX);
      if (text) words.push(text);
    }
    return clip((alts.length ? alts : words).join(" "), EXTRA_LABEL_MAX);
  };
  const hintOf = (index) => {
    const attrs = attrsOf(index);
    const tag = str(nodeNames[index]).toLowerCase();
    const id = attrs.id ? `#${attrs.id.trim().split(/\s+/)[0]}` : "";
    const classes = attrs.class ? attrs.class.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return clip(`${tag}${id}${classes.map((one) => `.${one}`).join("")}`, EXTRA_HINT_MAX);
  };

  return {
    items: kept.map((index) => ({
      backendNodeId: backendIds[index],
      label: labelOf(index),
      hint: hintOf(index),
    })),
    more: outermost.length - kept.length,
  };
}

/**
 * Members one signature needs before its bucket collapses into a summary. Three
 * of a kind is a page having three of something; four is a PATTERN, and past
 * that the list stops describing the page and starts burying it. Kept above
 * EXTRA_CLICKABLE_GROUP_HEAD so a collapse always folds at least two elements —
 * a summary standing in for one line would cost a line to save none.
 */
const EXTRA_CLICKABLE_GROUP_MIN = 4;

/**
 * Members of a collapsing bucket that still print individually, with their uids.
 * TWO, not one: a single example reads as "the one td", while two make the
 * repetition visible AND leave a second uid to act on if the first is stale.
 * Exported because the summary line background.js renders says "more like the N
 * above", and a hardcoded 2 there would drift the moment this changes.
 */
export const EXTRA_CLICKABLE_GROUP_HEAD = 2;

/**
 * Collapse repeated same-kind entries in the AX-invisible clickable section, so
 * the section's line budget is spent on DISTINCT controls.
 *
 * Field case (issue #62): a Confluence editor snapshot listed 128+ table cells
 * as clickables; the 40-line cap then cut off the custom toolbar controls the
 * section exists to surface. Every one of those cells was individually
 * addressable and utterly interchangeable — the agent needed to know they exist
 * and what they are, not to receive 128 uids for them.
 *
 * SIGNATURE is the item's DOM hint with its `#id` segment removed
 * (`td#c12.confluenceTd` → `td.confluenceTd`), because the id is exactly the
 * part that differs between two instances of one repeated element. Only the
 * FIRST `#` is stripped: `hintOf` writes the id straight after the tag, so that
 * is the id, and a class token containing a literal `#` keeps its own text. An
 * item whose signature comes out EMPTY (no hint, or a hint that is nothing but
 * an id) never groups — with nothing to name the kind by, a summary line could
 * not say what it stood for.
 *
 * `limit` is a cap on PRINTED LINES, and item lines and summary lines both count
 * against it: a summary is a line the reader pays for like any other.
 *
 * Returns `{ units, omitted }`. A unit is `{ kind: "item", item }` — printed and
 * minted exactly as before — or `{ kind: "group", signature, count }`, an
 * UNMINTED summary standing in for `count` members beyond the printed head.
 * `omitted` is every element the limit cut, with a dropped summary contributing
 * the members it stood for: this file does not cap silently, so an element that
 * existed and is not on a line has to be inside somebody's count.
 *
 * Pure and dependency-free (input order is document order; nothing is read back
 * from the page), so tests/browser-axtree.test.ts covers it in the always-run
 * suite.
 */
export function groupClickableItems(items, limit) {
  const list = Array.isArray(items) ? items : [];
  const cap = Math.max(0, Math.trunc(Number(limit ?? EXTRA_CLICKABLE_MAX)) || 0);
  const signatures = list.map((item) => String(item?.hint ?? "").replace(/#[^.]*/, ""));
  /** signature -> how many items carry it, so a bucket's size is known up front. */
  const sizeOf = new Map();
  for (const signature of signatures) {
    if (signature) sizeOf.set(signature, (sizeOf.get(signature) || 0) + 1);
  }
  const units = [];
  /** signature -> members walked so far, which is what decides head vs folded. */
  const seen = new Map();
  for (let at = 0; at < list.length; at += 1) {
    const signature = signatures[at];
    const size = signature ? sizeOf.get(signature) : 0;
    // Under the threshold, or unsigned: printed exactly as it always was, in its
    // own document position.
    if (!signature || size < EXTRA_CLICKABLE_GROUP_MIN) {
      units.push({ kind: "item", item: list[at] });
      continue;
    }
    const rank = seen.get(signature) || 0;
    seen.set(signature, rank + 1);
    if (rank >= EXTRA_CLICKABLE_GROUP_HEAD) continue; // folded into the summary below
    units.push({ kind: "item", item: list[at] });
    // Right after the LAST printed head, so the summary sits where its members
    // are rather than at the end of a section they are scattered through.
    if (rank === EXTRA_CLICKABLE_GROUP_HEAD - 1 && size > EXTRA_CLICKABLE_GROUP_HEAD) {
      units.push({ kind: "group", signature, count: size - EXTRA_CLICKABLE_GROUP_HEAD });
    }
  }
  let omitted = 0;
  for (let at = cap; at < units.length; at += 1) {
    const unit = units[at];
    // A summary the limit cut takes its whole bucket's tail down with it, so it
    // contributes the members it stood for — not one line.
    omitted += unit.kind === "group" ? unit.count : 1;
  }
  return { units: units.slice(0, cap), omitted };
}

/**
 * Render one session's AX tree as the INTERACTION view: every actionable
 * element gets a uid the agent can pass to click/type.
 *
 * `mintUid(backendNodeId)` is called for each actionable element, in output
 * order, and returns the uid to print. The caller owns the uid counter so that
 * numbering stays continuous across a page's frames.
 *
 * `hints` is an optional Map of backendNodeId → DOM identifier, printed only
 * beside a label that would otherwise be empty (see unlabeledInteractiveIds).
 *
 * `opts.startBackendNodeId` scopes the render to one subtree (a frame body, a
 * dialog), returning null when no node carries that id — the same stale-uid
 * contract renderAxText has; `opts.scopeDomIds` widens that scope to the DOM ids
 * the caller found inside it, and on its OWN (no start id) renders exactly those
 * ids — the answer for an element the DOM has and the AX tree does not, such as
 * a covering overlay that never got an accessibility node (see walkAxNodes).
 * `opts.frameLabels` is a Map of backendNodeId →
 * frame label: a frame's tree is rendered as its own block AFTER the main one,
 * and without a marker on the owning `Iframe` line there was nothing tying a
 * trailing RootWebArea block to the place in the page it came from. Calling
 * with no `opts` at all renders exactly as it did before it existed.
 *
 * Read off `opts` rather than destructured in the parameter list, because a
 * default only covers `undefined`: a caller passing `null` for "no options" —
 * the natural shape of `frameLabels ? { frameLabels } : null` — would otherwise
 * throw here and take out every snapshot on the page, not just the frame part.
 */
export function renderAxTree(nodes, mintUid, hints, opts) {
  const { startBackendNodeId, frameLabels, scopeDomIds, sortByDomId } = opts || {};
  const lines = [];
  /** Full href -> { index, name, indent } of the one line kept for that destination. */
  const byHref = new Map();
  /** Resolved once per render: what makes a link a SAME-DOCUMENT fragment. */
  const docUrl = documentUrl(nodes);
  /**
   * The inline-text run currently open:
   * { container, index, text, segments, covered, indent, trail }, where `trail`
   * is whether the LAST node appended to it carried a trailing space of its own
   * — the evidence the next seam is glued on (see nameEdges).
   */
  let run = null;
  /** The table row the last pushed line holds: { row, cell, index }, or null. */
  let openRow = null;
  /**
   * A marker image line waiting for the label beside it:
   * { index, indent, uid, role, name, suffix, container }, or null. See
   * MARKER_LABEL_MAX.
   */
  let pendingMarker = null;
  /** Emitted node -> its container, so a piece can find the cell and row above it. */
  const parentOf = new Map();
  /** Emitted node -> whether it was actionable, for the image ancestor test. */
  const interactiveOf = new Map();
  const { cellOf, rowOf } = rowChain(parentOf);
  /**
   * Per COLLAPSED combobox: how many options printed, how many folded, and the
   * slot the folded count is written into once the walk knows it. The slot is
   * pushed as null (the same convention closeRun uses) and rewritten at the
   * end, so byHref/run indices stay valid.
   */
  const optionCaps = new Map();
  /**
   * True when a CONTROL up the chain already takes the click this node would.
   * Surfaces are climbed past rather than counted — see SURFACE_ROLES for why a
   * map body holding a uid must not disqualify the markers drawn on it.
   */
  const hasActionableAncestor = (from) => {
    let at = from;
    for (let hops = 0; at && hops < CHAIN_MAX_HOPS; hops += 1) {
      if (interactiveOf.get(at) && !SURFACE_ROLES.has(at.role?.value)) return true;
      at = parentOf.get(at);
    }
    return false;
  };
  /**
   * Close the open run, dropping it when it only re-spells its own container's
   * label. A `<mark>` keyword highlight splits a sentence MID-word, so the
   * fragments do not sit on token boundaries of the parent label and each one
   * survives `containsAsToken` on its own — the rejoined run then printed the
   * container's sentence a SECOND time, verbatim. Whitespace-insensitive
   * because the split loses the spaces too. This only ever SEES those fragments
   * because `TEXT_LEVEL_ROLES` makes the highlight wrapper structural; while it
   * was a container of its own, the fragments landed in separate runs and walked
   * straight past this check.
   *
   * Only a JOINED run (≥ 2 segments) may be dropped: a lone StaticText that
   * sits inside a longer ancestor label is the calendar case, where "26" under
   * "달력 2026.08.08" is real content the page would otherwise lose.
   *
   * Suppression NULLS the slot instead of splicing — byHref holds line indices
   * that must stay valid for the rest of the walk; the nulls are filtered out
   * once, at the end.
   *
   * The container's label is not the only copy of the sentence to check against:
   * where the page carries the plain sentence as its OWN line, the fragment run
   * matches nothing's label and used to print beside it, garbled. So the run is
   * also tested against the line before it and against `incoming` — the line
   * about to be pushed — which covers the plain copy arriving on either side.
   * See runEchoesLine for why that test is ordered-with-holes, not `includes`.
   */
  const closeRun = (incoming) => {
    if (run && run.segments.length > 1) {
      const joined = stripSpaces(run.text);
      const echoesContainer =
        Boolean(run.covered && joined) && stripSpaces(run.covered).includes(joined);
      if (
        echoesContainer ||
        runEchoesLine(run.segments, precedingLine(lines, run.index)) ||
        runEchoesLine(run.segments, incoming)
      ) {
        lines[run.index] = null;
      }
    }
    run = null;
  };
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered, container, depth) => {
    parentOf.set(node, container);
    // A NAMED image with no actionable ancestor is the click target itself —
    // see IMAGE_ROLES. The ancestor test lives here and not in isActionableNode
    // deliberately: that predicate is per-node and shared with
    // unlabeledInteractiveIds, which has no chain to walk.
    const actionable = isActionableNode(node, role, name, value);
    // Held apart from `interactive` because only a line that got its uid from
    // THIS rule is a map marker, and only a map marker takes a folded label.
    const markerImage =
      !actionable &&
      IMAGE_ROLES.has(role) &&
      Boolean(name) &&
      node.backendDOMNodeId != null &&
      !hasActionableAncestor(container);
    const interactive = actionable || markerImage;
    // Recorded for EVERY emitted node, printed or not: an ancestor that this
    // renderer suppresses still owns the click.
    interactiveOf.set(node, interactive);
    // Nameless NON-interactive nodes are noise, but a nameless interactive
    // element (an unlabeled rich-text editor, an icon-only button) still
    // needs a uid — dropping those made such editors unreachable entirely.
    const worthPrinting = Boolean(name || value || interactive);
    // An echo of an ancestor's label. Interactive nodes are exempt: their
    // line carries the uid, which nothing else can supply.
    const echoed = !interactive && !value && Boolean(name) && containsAsToken(covered, name);
    if (!worthPrinting || echoed) return;
    // The label a map marker was waiting for: the plain text node RIGHT after
    // it, under the same container, short enough to be a label. Folded onto the
    // marker's own line and consumed — it never opens a run, never joins a row,
    // and mints nothing, so nothing downstream can tell it was ever two nodes.
    // Anything else standing between the marker and its text says the two are
    // unrelated, and clears the marker unfolded.
    if (pendingMarker) {
      const marker = pendingMarker;
      pendingMarker = null;
      if (
        lines.length === marker.index + 1 &&
        role === "StaticText" &&
        !interactive &&
        !value &&
        Boolean(name) &&
        name.length <= MARKER_LABEL_MAX &&
        container === marker.container
      ) {
        const labelled = printedName(glueSegments(marker.name, name));
        lines[marker.index] = `${marker.indent}[${marker.uid}] ${marker.role} ${labelled}${marker.suffix}`;
        return;
      }
    }
    const href = linkHref(node, role, docUrl);
    // One space per level of emitted nesting. It costs snapshot budget, so it
    // is capped: past a dozen levels the shape is no longer readable anyway and
    // the width would come out of the page's own text.
    const indent = " ".repeat(Math.min(depth, SNAPSHOT_INDENT_MAX));
    // Options of a COLLAPSED combobox past the cap fold into one counted line
    // (see COLLAPSED_OPTION_MAX). The [selected] option always prints — it is
    // the control's current value, the one thing a capped list must not hide —
    // and a snapshot SCOPED to the combobox itself is the full-list escape
    // hatch, so that scope is exempt.
    if (role === "option") {
      const combo = collapsedComboAncestor(container, parentOf);
      if (combo && combo.backendDOMNodeId !== startBackendNodeId) {
        let cap = optionCaps.get(combo);
        if (!cap) {
          cap = { shown: 0, omitted: 0, markerIndex: -1, indent };
          optionCaps.set(combo, cap);
        }
        if (cap.shown >= COLLAPSED_OPTION_MAX && axStateFlag(node, "selected") !== true) {
          cap.omitted += 1;
          if (cap.markerIndex === -1) {
            cap.markerIndex = lines.length;
            lines.push(null);
          }
          return;
        }
        cap.shown += 1;
      }
    }
    // An icon-only control usually carries its label in `title`, which Chrome
    // delivers as the AX DESCRIPTION — the only thing that tells a page full of
    // `button ""` lines apart. Read it ONLY as a last resort: it never replaces
    // a real name and never feeds ancestor coverage, since it describes this
    // node alone.
    const described =
      interactive && !name && !value ? String(node.description?.value ?? "").trim() : "";
    // Returns the line together with the two pieces a later fold has to rebuild
    // it from: the uid it minted, and the SUFFIX — everything printed after the
    // quoted label. Re-calling format() to relabel a line is not an option, as
    // it would mint a second uid for the same element.
    const format = () => {
      const uid =
        interactive && node.backendDOMNodeId != null ? mintUid(node.backendDOMNodeId) : null;
      const url = href ? ` → ${printableUrl(href)}` : "";
      const label = name || described;
      // Nothing in the accessibility tree names this control. The caller's DOM
      // hint (#id, class, input type, icon label) is then the only thing that
      // tells one `button ""` line from the next.
      const hinted = !label && !value ? hints?.get?.(node.backendDOMNodeId) || "" : "";
      const hint = hinted ? ` (dom: ${hinted})` : "";
      // The AX tree does not carry aria-sort AT ALL (probed:
      // round11-facts.spec.ts — a sorted native <th> arrives with only
      // readonly/required), so the sorted state rides in from the caller's DOM
      // capture. Without it a sort click could not be verified: the header
      // looked identical before and after.
      const sorted = sortByDomId?.get?.(node.backendDOMNodeId);
      const sortFlag = sorted ? (sorted === "other" ? " [sorted]" : ` [sorted ${sorted}]`) : "";
      const state = `${stateFlags(node)}${rangeFlags(node, role)}${sortFlag}`;
      // Last on the line, after everything describing the element itself: this
      // says where the element's CONTENTS were printed, not what it is.
      const frame = frameLabels?.get?.(node.backendDOMNodeId);
      const framed = frame ? ` (frame ${frame})` : "";
      if (uid) {
        const held = value ? ` = ${printedValue(value, uid)}` : "";
        const suffix = `${held}${state}${hint}${url}${framed}`;
        return { line: `[${uid}] ${role} ${printedName(label)}${suffix}`, uid, suffix };
      }
      // With no uid the single quoted slot holds whichever of the three exists,
      // so a value landing there is capped as a VALUE — the recovery pointer is
      // what a 40 KB textarea needs, and it cannot name a uid this line lacks.
      const only = name || value || described;
      const shown = !name && value ? printedValue(only, null) : printedName(only);
      const suffix = `${state}${url}${framed}`;
      return { line: `${role} ${shown}${suffix}`, uid: null, suffix };
    };
    // A single search result arrives as four to six links to the SAME
    // destination (thumbnail, title, source, snippet), which buried the result
    // list in repeats. Print the first position once; a later duplicate with a
    // richer label upgrades THAT line in place rather than adding another.
    const kept = href ? byHref.get(href) : undefined;
    // Unless the link INTERRUPTS RUNNING PROSE. Wikipedia's edit notice printed
    // "You need to and be autoconfirmed", because the mid-sentence "log in or
    // create an account" link reaches the same href as the personal-tools menu
    // link printed far above — folding deleted it out of the middle of a
    // sentence. An open run under this link's own container is what says the
    // sentence is still being written; a SERP duplicate has no run beside it
    // and folds exactly as before.
    const interruptsProse = Boolean(run) && run.container === container;
    if (kept && !interruptsProse) {
      if (name.length > kept.name.length) {
        // Rewrites the FIRST position's line, so it carries the indent that
        // position was pushed with — the richer duplicate can sit any depth
        // away, and its own indent would misplace the line it replaces.
        lines[kept.index] = kept.indent + format().line;
        kept.name = name;
      }
      return;
    }
    // The whitespace THIS node's own text carries, read before the trim the
    // emit did — the only thing that says whether a seam beside it was a space
    // on the page.
    const edges = nameEdges(node, value);
    // Prose split into per-word <span>s emits one StaticText per word. Rejoin
    // the run into the paragraph it was; a different container breaks it, and a
    // LANDMARK container never joins at all (see NON_JOINING_CONTAINERS).
    const inRun =
      role === "StaticText" &&
      !interactive &&
      !href &&
      !value &&
      Boolean(name) &&
      joinsRuns(container);
    if (inRun && run && run.container === container) {
      // Spaced when EITHER side of the seam carried whitespace on the page —
      // the piece just closed or the one arriving — and left to the character
      // rule only when both edges are dry (see glueSegments).
      run.text = glueSegments(run.text, name, run.trail || edges.lead);
      run.segments.push(name);
      run.trail = edges.trail;
      // Rewritten in place, so it must be re-indented: the slot was pushed with
      // this run's own indent and nothing else may change where it sits.
      lines[run.index] = `${run.indent}StaticText "${run.text}"`;
      return;
    }
    // Rendered BEFORE the run closes, so the closing check can see the line
    // about to land beside it. format() mints only a uid counter tick, and it
    // happens at the same point of the walk either way, so the numbering the
    // agent reads is untouched by this ordering.
    const formatted = format();
    const line = formatted.line;
    closeRun(line);
    // The reading view has kept a table's rows on one line for a while; the
    // snapshot view printed one line per cell, so a 650-cell finance table made
    // the agent COUNT columns to work out where a row began. Join a row's cells
    // with " | " here too. Each cell keeps its own full rendering, uid
    // INCLUDED, so nothing loses addressability, and the joined line still
    // starts with the first cell's — which is what capSnapshot's uid-first
    // keep classifies it by. The row is found by CLIMBING (see rowChain), so a
    // piece nested inside a nameless cell joins its row like a plain cell does;
    // two pieces of the SAME cell are more of one value, not another column.
    const cell = cellOf(node);
    const row = rowOf(cell || container);
    if (row) {
      // The slot may have been NULLED by the suppression above — appending onto
      // it would resurrect the very line that was just deleted as a duplicate.
      if (openRow && openRow.row === row && lines[openRow.index] != null) {
        lines[openRow.index] += `${cell === openRow.cell ? " " : " | "}${line}`;
        openRow.cell = cell;
        return;
      }
      openRow = { row, cell, index: lines.length };
    } else {
      openRow = null;
    }
    if (inRun)
      run = {
        container,
        index: lines.length,
        text: name,
        segments: [name],
        covered,
        indent,
        trail: edges.trail,
      };
    // An interrupting link leaves the entry it did not fold onto untouched:
    // the folded destination still points at the line that first printed it.
    if (href && !kept) byHref.set(href, { index: lines.length, name, indent });
    lines.push(indent + line);
    // Only a line that actually LANDED can take a label: a marker joined into a
    // row above returns before this and never becomes pending.
    pendingMarker = markerImage
      ? {
          index: lines.length - 1,
          indent,
          uid: formatted.uid,
          role,
          name,
          suffix: formatted.suffix,
          container,
        }
      : null;
  }, scopeDomIds);
  closeRun();
  // The folded-option slots get their counts now that the walk knows them. A
  // combobox that never overflowed its cap left no slot to fill.
  for (const cap of optionCaps.values()) {
    if (cap.markerIndex !== -1 && cap.omitted > 0) {
      lines[cap.markerIndex] =
        `${cap.indent}… ${cap.omitted} more options not shown (collapsed combobox) — ` +
        "select_option accepts any option label; snapshot the combobox's uid to list them all";
    }
  }
  return found
    ? lines.filter((line) => line !== null && !isBracketNoiseSnapshotLine(line))
    : null;
}

/**
 * Render one session's AX tree as the READING view: plain text lines with no
 * uids and no role decoration, for read_text. Mints nothing, so the uids of
 * the last snapshot stay valid. When `startBackendNodeId` is given only that
 * subtree is rendered; returns null when the id matches no node (stale uid —
 * the caller owns the model-facing message). `scopeDomIds` widens that scope to
 * the in-scope nodes the childIds chain cannot reach, and WITHOUT a start id it
 * is the whole scope: what the DOM says lives inside an element the AX tree has
 * no node for at all — see walkAxNodes.
 */
export function renderAxText(nodes, startBackendNodeId, scopeDomIds) {
  const lines = [];
  /**
   * The inline-text run currently open:
   * { container, index, segments, covered, trail }, where `trail` is whether the
   * last node appended to it carried a trailing space of its own (see nameEdges).
   */
  let run = null;
  /**
   * The table row the last pushed line holds — { row, cell, index, trail,
   * container, cellTexts }, or null. `trail` and `container` describe the LAST
   * piece appended, which is what the next same-cell seam is decided on;
   * `cellTexts` collects every piece, which is what settleRowLabel compares
   * against the row's own accessible name.
   */
  let openRow = null;
  /** Named ROW node -> { index, name } of the accname line it printed itself. */
  const rowLabelAt = new Map();
  /** Emitted node -> its container, so a piece can find the cell and row above it. */
  const parentOf = new Map();
  const { cellOf, rowOf, crossesBlocks } = rowChain(parentOf);
  /**
   * Null a row's own accname line once its joined cells have re-spelled it.
   * The grid shape this exists for: an ARIA grid (ag-grid) computes every row's
   * ACCESSIBLE NAME out of its cells, so the row node printed the whole row
   * once and the " | "-joined cells printed it again — read_text answered the
   * grid literally twice over. Dropped only when the cells FULLY account for
   * the name (whitespace-insensitive and contiguous), so a row name carrying
   * anything of its own survives, and only past RUN_ECHO_MIN_CHARS, so a short
   * coincidence cannot delete real content.
   */
  const settleRowLabel = () => {
    if (!openRow) return;
    const label = rowLabelAt.get(openRow.row);
    if (!label || lines[label.index] == null || label.index === openRow.index) return;
    const rowName = stripSpaces(label.name);
    if (rowName.length < RUN_ECHO_MIN_CHARS) return;
    if (stripSpaces(openRow.cellTexts.join("")).includes(rowName)) lines[label.index] = null;
  };
  /**
   * Options folded per COLLAPSED combobox: the reading view answers what the
   * page LOOKS like, and a closed dropdown shows its value alone (which the
   * combobox node itself prints) — every option label under it is invisible
   * text, and a ~900-option version picker drowned the whole page in it
   * (round 13). ALL of them fold here, into one counted line per combobox.
   */
  const optionCaps = new Map();
  /**
   * Editor nodes that printed their VALUE -> that value, space-stripped. A rich
   * editor's AX value IS its rendered text (Chrome computes one from the other),
   * so every StaticText under it re-spells what the editor's own line already
   * said — TinyMCE's iframe body read back its whole document TWICE (round 15),
   * because each paragraph opened its own one-segment run and the run-echo rule
   * only compares a run against the single line beside it. Restricted to
   * editable roots and textbox-shaped nodes on purpose: a combobox's value
   * coinciding with one of its option labels is a real list entry, not an echo.
   */
  const editorValueOf = new Map();
  /** Emitting ancestors climbed when looking for that value (bounded, not deep). */
  const EDITOR_ECHO_CLIMB_MAX = 12;
  const editorAlreadySays = (container, printed) => {
    const stripped = stripSpaces(printed);
    if (!stripped) return false;
    let up = container;
    for (let hops = 0; up && hops < EDITOR_ECHO_CLIMB_MAX; hops += 1) {
      const owned = editorValueOf.get(up);
      if (owned !== undefined) return owned.includes(stripped);
      up = parentOf.get(up);
    }
    return false;
  };
  /** Same mid-word-highlight suppression renderAxTree does — see closeRun there. */
  const closeTextRun = (incoming) => {
    if (run && run.segments.length > 1) {
      const joined = stripSpaces(lines[run.index] ?? "");
      const echoesContainer =
        Boolean(run.covered && joined) && stripSpaces(run.covered).includes(joined);
      if (
        echoesContainer ||
        runEchoesLine(run.segments, precedingLine(lines, run.index)) ||
        runEchoesLine(run.segments, incoming)
      ) {
        lines[run.index] = null;
      }
    }
    run = null;
  };
  const found = walkAxNodes(nodes, startBackendNodeId, (node, role, name, value, covered, container) => {
    parentOf.set(node, container);
    const echoed = !value && Boolean(name) && containsAsToken(covered, name);
    if ((!name && !value) || echoed) return;
    if (role === "option") {
      const combo = collapsedComboAncestor(container, parentOf);
      if (combo && combo.backendDOMNodeId !== startBackendNodeId) {
        let cap = optionCaps.get(combo);
        if (!cap) {
          cap = { omitted: 0, markerIndex: lines.length };
          optionCaps.set(combo, cap);
          lines.push(null);
        }
        cap.omitted += 1;
        return;
      }
    }
    const printed = name && value ? `${name}: ${value}` : name || value;
    // Text an enclosing editor's value line has ALREADY answered is an echo,
    // not content — see editorValueOf above. Value-carrying nodes are exempt
    // (a nested field is its own control), and the check runs before any run
    // or row state so a suppressed echo leaves both untouched.
    if (!value && editorAlreadySays(container, printed)) return;
    if (value && (isEditableRoot(node) || role === "textbox" || role === "searchbox")) {
      editorValueOf.set(node, stripSpaces(value));
    }
    // The whitespace this node's own text carries at each end, read before the
    // trim the emit did: at every seam below it is the difference between the
    // page's spacing and a guess made from the characters (see nameEdges).
    const edges = nameEdges(node, value);
    // Inline prose: consecutive StaticText under ONE container is a single
    // paragraph that a per-word <span> soup had split into a word per line — but
    // never under a LANDMARK, where the shared container means only "same page",
    // not "same block" (see NON_JOINING_CONTAINERS).
    //
    // A LINK joins that run too, which the snapshot view deliberately does not
    // do: in the reading view a mid-sentence link is a word of the sentence, and
    // breaking the line at it left Wikipedia's prose in unreadable stubs. Menu
    // and list links are unaffected — their container is a landmark or simply a
    // different one, so they still print on their own line.
    const inTextRun =
      (role === "StaticText" || (role === "link" && Boolean(name) && !value)) && joinsRuns(container);
    if (inTextRun && run && run.container === container) {
      // Glued, not blanket-spaced: the sentence's own period arrives as a
      // StaticText of its own, and read_text used to answer "request a new
      // article ." — but a space one of the two text nodes actually CARRIES is
      // the page's own and goes back in, whatever the characters say. Wikipedia
      // read as "If the page has been deleted,check the deletion log" until this
      // seam looked at the evidence instead of at the comma.
      lines[run.index] = glueSegments(lines[run.index], printed, run.trail || edges.lead);
      run.segments.push(printed);
      run.trail = edges.trail;
      return;
    }
    closeTextRun(printed);
    // A table read as a vertical list of cells loses the thing that made it a
    // table. Keep each row on one line, its cells separated by " | " — found by
    // CLIMBING to the row (see rowChain), so a cell whose text sits on a nested
    // link joins the row instead of breaking it.
    const cell = cellOf(node);
    const row = rowOf(cell || container);
    if (row) {
      if (openRow && openRow.row === row && lines[openRow.index] != null) {
        // More of the SAME cell is more of one value, so its pieces are glued
        // exactly as the page drew them — a footnote marker reads back as
        // "China[n 1]". Only the bar between CELLS is a fixed separator.
        //
        // Three things can put a space at that seam, and none of them is a
        // guess: whitespace the piece just written carried at its end,
        // whitespace the arriving piece carries at its start, or a SIBLING-BLOCK
        // boundary inside the cell (see crossesBlocks) — a cell holding two
        // paragraphs has no text node spanning their edge, and welding them
        // reads back as one sentence the page never wrote.
        lines[openRow.index] =
          cell === openRow.cell
            ? glueSegments(
                lines[openRow.index],
                printed,
                openRow.trail || edges.lead || crossesBlocks(container, openRow.container),
              )
            : `${lines[openRow.index]} | ${printed}`;
        openRow.cell = cell;
        openRow.trail = edges.trail;
        openRow.container = container;
        openRow.cellTexts.push(printed);
        return;
      }
      settleRowLabel();
      openRow = { row, cell, index: lines.length, trail: edges.trail, container, cellTexts: [printed] };
    } else {
      settleRowLabel();
      openRow = null;
    }
    // The row node itself, printing the accessible name it computed from its
    // cells — remembered so settleRowLabel can drop the copy once the cells
    // below have joined. Only a row that landed on its OWN line qualifies: one
    // that joined an OUTER row's line shares that line with real content.
    if (ROW_ROLES.has(role) && name && !value && !row) {
      rowLabelAt.set(node, { index: lines.length, name });
    }
    if (inTextRun)
      run = { container, index: lines.length, segments: [printed], covered, trail: edges.trail };
    lines.push(printed);
  }, scopeDomIds);
  closeTextRun();
  settleRowLabel();
  for (const cap of optionCaps.values()) {
    lines[cap.markerIndex] = `(${cap.omitted} options in a collapsed dropdown, not shown)`;
  }
  return found ? lines.filter((line) => line !== null && !isBracketNoise(line)) : null;
}

/**
 * Character budget for one snapshot. Uncapped, merely REACHING a long page
 * failed the whole tool call against the model-side token ceiling (a long
 * comment thread renders past 90k chars), which made big pages unreadable
 * AND unactionable. read_text has its own chunking; this cap is for the
 * snapshot every action returns.
 */
export const SNAPSHOT_MAX_CHARS = 30000;

/** Leading spaces tolerated: the snapshot view indents by nesting depth. */
const UID_LINE = /^ *\[e\d+\] /;

/** The uid an atom leads with, for the marker that says where to read the rest. */
const LEADING_UID = /^\s*\[(e\d+)\]/;

/**
 * Budget below which a head-keep is not worth doing: a few hundred characters
 * of a source file, most of it spent on the marker, is not readable text.
 */
const HEAD_KEEP_MIN_CHARS = 500;

/** What a head-kept atom ends with. Sized on the numbers it names, so it can be measured first. */
const cutMarker = (shown, total, uid) =>
  `… [cut by the maxChars budget: showing ${shown} of ${total} chars — ` +
  `mcp__browser__read_text${uid ? ` (uid ${uid})` : ""} returns the full text]`;

/**
 * The longest CONTIGUOUS head of `atom` that fits in `remaining`, marked, or
 * null when even that does not fit. Measured against the widest the marker can
 * get (the kept count can have no more digits than the total), so rebuilding it
 * with the real count can only make the line shorter, never overshoot.
 */
function headKeptAtom(atom, remaining) {
  const uid = LEADING_UID.exec(atom)?.[1] || "";
  const room = remaining - 1 - cutMarker(atom.length, atom.length, uid).length;
  if (room < 1) return null;
  const head = atom.slice(0, room);
  return head + cutMarker(head.length, atom.length, uid);
}

/**
 * Fit a rendered snapshot into `maxChars`, spending the budget on actionable
 * elements first. A cut TEXT line is recoverable — read_text re-reads the page
 * in offset chunks — but a cut `[uid]` line makes its element unreachable, so
 * uid lines are kept preferentially. Output preserves document order; a
 * trailing notice says what was dropped so the model knows the page did not
 * end where the text stops.
 *
 * The unit is an ATOM, not a physical line: the renderers push one array entry
 * per element, and an element's own value can hold newlines. A GitHub blob view
 * keeps the whole source file in one textbox value, and keeping that by the line
 * cut it to pieces — its first line carried the uid and was kept, its interior
 * lines were kept or dropped INDIVIDUALLY (a short one still fitting after a
 * long one did not), and the closing quote and `[value truncated]` marker fell
 * off the end. What came back was source with holes in it, different on every
 * call, and nothing on the page said so. Callers may still pass a plain string,
 * which splits per line exactly as before.
 *
 * A uid atom too big to keep whole is HEAD-kept rather than dropped: its first
 * line is what carries the uid, so dropping it whole would make the element
 * unreachable, and a marked contiguous prefix is text an agent can trust. It
 * happens after the whole-atom uid pass — one oversized atom must not cost the
 * page's other elements their uids — and it takes essentially all of what is
 * left, so the text pass after it usually gets nothing. That is the intended
 * trade: text is recoverable through read_text, and the marker names it.
 *
 * `opts.focusUid` is the uid the op just ACTED ON. Document order made the old
 * uid pass spend the whole of a tight budget on a page's earliest interactive
 * elements — a header's nav links — while the row the agent had just edited
 * fell off the end: on ag-grid, a cell-edit's confirmation snapshot showed the
 * toolbar and not the cell, so verifying the write cost a second scoped call
 * every time. The focus pass keeps that element's atom and its NEIGHBOURS
 * (both directions, nearest first) ahead of everything else, bounded to half
 * the budget so the rest of the page still keeps its uids. No focus (or a uid
 * not on the page) leaves the output byte-identical.
 */
const FOCUS_CONTEXT_ATOMS = 20;

export function capSnapshot(textOrLines, maxChars = SNAPSHOT_MAX_CHARS, opts) {
  const atoms = Array.isArray(textOrLines) ? textOrLines : String(textOrLines).split("\n");
  const whole = atoms.join("\n");
  if (whole.length <= maxChars) return whole;
  const keep = new Array(atoms.length).fill(null);
  let remaining = maxChars;
  const take = (i, text) => {
    keep[i] = text;
    remaining -= text.length + 1;
  };
  // An atom is classified by its FIRST physical line, which is where the
  // renderer put the element's own rendering.
  const leadsWithUid = (atom) => UID_LINE.test(atom);
  // The acted-on element and its surroundings, ahead of the document-order uid
  // pass — see FOCUS_CONTEXT_ATOMS above for the field failure this ends.
  // `fallbackFocusUid` is tried only when the primary's marker is not on the
  // page: a drag's start element re-renders mid-drag (FullCalendar re-creates
  // the moved event), and the release point's nearest minted ancestor is then
  // the honest anchor for what the action changed.
  let focusKept = false;
  let focusUsed = "";
  const focusCandidates = [opts?.focusUid, opts?.fallbackFocusUid]
    .map((one) => (typeof one === "string" ? one.trim() : ""))
    .filter(Boolean);
  for (const focusUid of focusCandidates) {
    const marker = `[${focusUid}]`;
    const at = atoms.findIndex((atom) => atom.includes(marker));
    if (at < 0) continue;
    let budget = Math.floor(maxChars / 2);
    const claim = (i) => {
      if (i < 0 || i >= atoms.length || keep[i] !== null) return;
      const cost = atoms[i].length + 1;
      if (cost > budget || cost > remaining) return;
      take(i, atoms[i]);
      budget -= cost;
      focusKept = true;
    };
    claim(at);
    for (let distance = 1; distance <= FOCUS_CONTEXT_ATOMS; distance += 1) {
      claim(at - distance);
      claim(at + distance);
    }
    focusUsed = focusUid;
    break;
  }
  // Elements MINTED during this very action, ahead of the document-order uid
  // pass: a menu trigger's popup renders in an aux container far from the
  // trigger in the tree, so the focus pass (a NEIGHBOUR walk) never reaches
  // it and the document-order pass spent the budget on the toolbar instead —
  // TinyMCE's File menu opened to a snapshot showing every menubar sibling
  // and none of the menu's own items (round 15). `opts.newUidFloor` is the
  // uid counter as it stood BEFORE the action ran; anything above it appeared
  // because of the action, which is usually exactly what the agent opened the
  // menu to see. Bounded to a quarter of the budget so a page that re-rendered
  // wholesale cannot starve the rest of its uids.
  let newKept = false;
  const floor = Number.isFinite(opts?.newUidFloor) ? Number(opts.newUidFloor) : null;
  if (floor !== null) {
    let budget = Math.floor(maxChars / 4);
    for (let i = 0; i < atoms.length; i += 1) {
      if (keep[i] !== null) continue;
      const minted = LEADING_UID.exec(atoms[i])?.[1];
      if (!minted || Number(minted.slice(1)) <= floor) continue;
      const cost = atoms[i].length + 1;
      if (cost > budget || cost > remaining) continue;
      take(i, atoms[i]);
      budget -= cost;
      newKept = true;
    }
  }
  for (let i = 0; i < atoms.length; i += 1) {
    if (keep[i] === null && leadsWithUid(atoms[i]) && atoms[i].length + 1 <= remaining)
      take(i, atoms[i]);
  }
  for (let i = 0; i < atoms.length && remaining >= HEAD_KEEP_MIN_CHARS; i += 1) {
    if (keep[i] !== null || !leadsWithUid(atoms[i])) continue;
    const head = headKeptAtom(atoms[i], remaining);
    if (head) take(i, head);
  }
  for (let i = 0; i < atoms.length; i += 1) {
    if (keep[i] === null && !leadsWithUid(atoms[i]) && atoms[i].length + 1 <= remaining)
      take(i, atoms[i]);
  }
  const kept = keep.filter((atom) => atom !== null);
  const dropped = atoms.length - kept.length;
  const newFirst = newKept ? " Elements that appeared during this action were kept too." : "";
  const keptFirst = focusKept
    ? `The element just acted on ([${focusUsed}]) and its surroundings were kept first, then other interactive [uid] elements.${newFirst}`
    : `Interactive [uid] elements were kept first.${newFirst}`;
  return (
    `${kept.join("\n")}\n\n[snapshot truncated: ${dropped} of ${atoms.length} entries omitted to fit. ` +
    `${keptFirst} Read the page's full text with ` +
    "mcp__browser__read_text, which returns offset-addressed chunks.]"
  );
}

/** Most arrow presses worth spending on one slider — beyond this, ask the page. */
const SLIDER_MAX_PRESSES = 400;

/** Decimal places a number is written with, bounded so 1e-7 cannot blow it up. */
function decimalPlaces(value) {
  const text = String(value);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(text.length - dot - 1, 10);
}

/**
 * How to drive a range control to `target` with arrow keys, or why it cannot be
 * done. The pure half of the fix for a silent success: the clearing ladder
 * pressed End before typing, End on a slider means MAXIMUM, and the ladder
 * verified only that the OLD value was gone — so `type(value="4")` left a
 * 0-to-5 rating slider at 5 and reported that it had worked.
 *
 * A slider does not take text at all; the only thing that moves it from the
 * keyboard is one arrow press per step. Every input arrives as the raw string
 * an AX value or a DOM attribute gave up, so all of them are parsed here rather
 * than in the caller, and the resolved bounds ride on EVERY answer — a refusal
 * an agent can read ("max is 5") is what stops it retrying the same value.
 *
 * `expected` is rounded to the precision of the numbers it came from: 0.1 + 0.2
 * is 0.30000000000000004, and a verify comparing that against the page's "0.3"
 * would fail a move that landed exactly right.
 *
 * Read off an object rather than destructured in the parameter list, so a
 * caller passing null gets a refusal instead of taking out the whole tool.
 */
export function sliderPlan(opts) {
  const { current, target, min, max, step } = opts || {};
  const bound = (raw, fallback) => {
    const parsed = axNumber(raw);
    return parsed === undefined ? fallback : parsed;
  };
  const minNum = bound(min, 0);
  const maxNum = bound(max, 100);
  const parsedStep = bound(step, 1);
  // A step of 0 or less is not a step: an HTML `step="any"` arrives unparseable
  // and a bad attribute can arrive negative, and either one divides the press
  // count into Infinity or drives the control the wrong way.
  const stepNum = parsedStep > 0 ? parsedStep : 1;
  const bounds = { min: minNum, max: maxNum, step: stepNum };
  const targetNum = axNumber(target);
  if (targetNum === undefined) return { ok: false, reason: "not-a-number", ...bounds };
  if (targetNum < minNum || targetNum > maxNum) return { ok: false, reason: "out-of-range", ...bounds };
  // An unreadable current position is not a failure: Home takes the control to
  // its minimum, which is a known place to count from.
  const currentNum = axNumber(current);
  const fromMin = currentNum === undefined;
  const from = fromMin ? minNum : currentNum;
  const signed = Math.round((targetNum - from) / stepNum);
  const presses = Math.abs(signed);
  if (presses > SLIDER_MAX_PRESSES) return { ok: false, reason: "too-far", presses, ...bounds };
  const places = Math.max(decimalPlaces(stepNum), decimalPlaces(from));
  return {
    ok: true,
    presses,
    key: signed < 0 ? "ArrowLeft" : "ArrowRight",
    fromMin,
    expected: Number((from + signed * stepNum).toFixed(places)),
    ...bounds,
  };
}

/** Longest overlap considered when merging scroll captures (bounds the cost). */
const MERGE_MAX_OVERLAP = 400;

/**
 * Longest suffix of `acc` matching a prefix of `next`, appending only the rest.
 * The sliding-window case: a virtualized feed REMOVES what scrolls out of view,
 * so consecutive captures share only their seam. When no overlap is found the
 * chunks are concatenated whole: a possible duplicate beats a silent hole.
 */
function overlapMerge(acc, next) {
  if (!acc.length) return next.slice();
  if (!next.length) return acc;
  const max = Math.min(acc.length, next.length, MERGE_MAX_OVERLAP);
  for (let overlap = max; overlap > 0; overlap -= 1) {
    let match = true;
    for (let i = 0; i < overlap; i += 1) {
      if (acc[acc.length - overlap + i] !== next[i]) {
        match = false;
        break;
      }
    }
    if (match) return acc.concat(next.slice(overlap));
  }
  return acc.concat(next);
}

/**
 * Merge two consecutive text captures of a scrolling page, for read_text's
 * `expand`.
 *
 * Two page shapes have to work, and only one of them is a seam:
 *
 * - A VIRTUALIZED feed drops what scrolls out of view, so captures overlap at
 *   their edges and nowhere else — `overlapMerge` above is that case.
 * - An APPEND-ONLY page keeps everything, so every capture is the whole
 *   document re-read from the TOP, and the new rows arrive in the MIDDLE:
 *   below the header, ABOVE a footer that both captures end with. Nothing then
 *   matches suffix-to-prefix, and the seam-only merge concatenated the entire
 *   document again on every scroll step — the-internet.herokuapp.com's
 *   infinite_scroll returned 517k characters that were four copies of the same
 *   few paragraphs.
 *
 * So peel the shared head and the shared tail off first and merge only the part
 * that actually differs. Head and tail anchor the alignment; a page that
 * changed out from under the loop (a navigation mid-expand) shares neither and
 * falls back to the seam merge, which still prefers a duplicate to a hole.
 */
export function mergeTextLines(acc, next) {
  if (!acc.length) return next.slice();
  if (!next.length) return acc;
  const limit = Math.min(acc.length, next.length);
  let head = 0;
  while (head < limit && acc[head] === next[head]) head += 1;
  // Re-reading a page that did not grow is the common no-op: say so cheaply
  // before the tail walk compares the same lines a second time.
  if (head === acc.length && head === next.length) return acc;
  let tail = 0;
  while (
    tail < limit - head &&
    acc[acc.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }
  if (!head && !tail) return overlapMerge(acc, next);
  const middle = overlapMerge(
    acc.slice(head, acc.length - tail),
    next.slice(head, next.length - tail),
  );
  return acc.slice(0, head).concat(middle, acc.slice(acc.length - tail));
}

// ------------------------------------------------- screenshot pixel geometry

/**
 * WHY these constants live here at all: a screenshot's pixels are the ONLY
 * coordinate space `click_at`/`drag` pixel mode can be aimed in, and the model
 * does not answer in the space of the bytes we sent — it answers in the space of
 * the image it SEES, i.e. AFTER the API resized our capture to the model's
 * native limits (platform.claude.com/docs/en/build-with-claude/vision and
 * /vision-coordinates, read 2026-09-02). Issue #66: a 1400×2197 viewport capture
 * is 3950 visual tokens, so a standard-tier model is served it downscaled to
 * 874×1372 — its coordinate space stands ×1.60 away from the bytes we produced,
 * and NO layer told either side. Pure scale, zero offset, which is exactly the
 * signature of a resize nobody told the bridge about. (The ≈×1.145 the field
 * actually measured fits neither tier's resize alone; the leading explanation is
 * the SECOND, independent defect — the mapping was predicted rather than
 * measured, `jpegDimensions` below.) The fix is the docs' own
 * recommendation for coordinate work: pre-resize so the image we produce IS the
 * image the model sees.
 *
 * One patch = 28×28 px; a resized image must fit BOTH a max edge and a max
 * visual-token count. We target the STANDARD tier for EVERY model on purpose:
 * Noah cannot know the serving model's tier (model ids are admin-configured
 * aliases), and the standard tier is the smaller of the two, so fitting it is
 * exact for every Claude model instead of correct for one of them. The only cost
 * is fidelity on tall viewports for a high-resolution-tier model — a typical
 * 1920×1080 viewport already fits at 1400×788 (1450 tokens) and is untouched.
 */
export const VISION_PATCH_PX = 28;
/** Standard-tier longest edge, in image px (all models before Claude 4.7). */
export const VISION_STANDARD_MAX_EDGE = 1568;
/** Standard-tier visual-token budget — the bound a TALL image actually hits. */
export const VISION_STANDARD_MAX_TOKENS = 1568;

/** Visual tokens an image of this pixel size costs: one per 28×28 patch. */
export function visionTokens(width, height) {
  return Math.ceil(width / VISION_PATCH_PX) * Math.ceil(height / VISION_PATCH_PX);
}

/**
 * Whether an image of this pixel size reaches the model UNRESIZED. Both edges
 * are measured PADDED to the next whole patch, because the API pads before it
 * counts (padding is added bottom/right only and shifts no coordinate).
 */
export function visionFits(width, height, limits) {
  const maxEdge = Number(limits?.maxEdge) > 0 ? Number(limits.maxEdge) : VISION_STANDARD_MAX_EDGE;
  const maxTokens =
    Number(limits?.maxTokens) > 0 ? Number(limits.maxTokens) : VISION_STANDARD_MAX_TOKENS;
  return (
    Math.ceil(width / VISION_PATCH_PX) * VISION_PATCH_PX <= maxEdge &&
    Math.ceil(height / VISION_PATCH_PX) * VISION_PATCH_PX <= maxEdge &&
    visionTokens(width, height) <= maxTokens
  );
}

/**
 * Round half to EVEN — the tie rule the vision docs' reference implementation
 * uses on the short edge. A plain Math.round differs by one pixel on exact
 * halves, and one pixel is the difference between an aspect ratio that
 * reproduces the API's own answer and one that quietly does not.
 */
function roundTiesToEven(value) {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) return Math.round(value);
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The pixel size the API resizes an image DOWN to — a faithful port of the
 * reference implementation in the vision docs, so our pre-fit lands on the same
 * numbers the server would have chosen. Binary search on the LONG edge for the
 * largest aspect-preserving size that still fits; an image that already fits is
 * returned untouched (the API does not upscale).
 */
export function visionFitSize(width, height, limits) {
  if (visionFits(width, height, limits)) return [width, height];
  if (height > width) {
    // Solve the landscape problem and swap back: the search below assumes the
    // WIDTH is the long edge.
    const [resizedH, resizedW] = visionFitSize(height, width, limits);
    return [resizedW, resizedH];
  }
  const aspectRatio = width / height;
  const shortOf = (long) => Math.max(roundTiesToEven(long / aspectRatio), 1);
  let lo = 1; // always fits
  let hi = width; // never fits
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (visionFits(mid, shortOf(mid), limits)) lo = mid;
    else hi = mid;
  }
  return [lo, shortOf(lo)];
}

/**
 * The `scale` a VIEWPORT capture should ask `Page.captureScreenshot` for.
 *
 * Inputs are PHYSICAL px — the size the bitmap would come back at unscaled
 * (clip DIP × the display's device scale factor), because that is the only edge
 * the caps and the vision limits mean anything against (captureShot's unit
 * note). Two rounds, in this order:
 *
 *  1. the bridge's own caps — the width bound the model's image block is sized
 *     for, and the ~8000px-per-edge ceiling vision APIs reject outright;
 *  2. the vision FIT: if the bitmap those caps produce would be resized by the
 *     API anyway, shrink it here so the image we send IS the image the model
 *     sees and its pixel coordinates come back in OUR space (issue #66).
 *
 * The caps arrive through `opts` because background.js owns them; the defaults
 * only exist so this stays callable (and testable) on its own. The re-check loop
 * is not decoration: the fit is computed on the ROUNDED bitmap size, and one
 * pixel of rounding can put the result back over a patch boundary.
 */
export function viewportShotScale(physicalWidth, physicalHeight, opts) {
  const maxWidth = Number(opts?.maxWidth) > 0 ? Number(opts.maxWidth) : 1400;
  const maxHeight = Number(opts?.maxHeight) > 0 ? Number(opts.maxHeight) : 7900;
  const pw = Math.max(1, Math.round(Number(physicalWidth) > 0 ? Number(physicalWidth) : 1));
  const ph = Math.max(1, Math.round(Number(physicalHeight) > 0 ? Number(physicalHeight) : 1));
  let scale = Math.min(1, maxWidth / pw, maxHeight / ph);
  for (let guard = 0; guard < 4; guard += 1) {
    const w = Math.max(1, Math.round(pw * scale));
    const h = Math.max(1, Math.round(ph * scale));
    if (visionFits(w, h, opts)) break;
    const [fitW] = visionFitSize(w, h, opts);
    if (!(fitW > 0) || fitW >= w) break; // no progress to make; do not spin
    scale = scale * (fitW / w);
  }
  return Math.min(1, Math.max(scale, 1 / 10000));
}

/**
 * Decode base64 to bytes, optionally only the first `maxBytes` worth.
 *
 * The prefix is what makes measuring a screenshot cheap: a JPEG's SOF marker
 * sits in the first few KB, so there is no reason to materialize a megabyte of
 * pixels to read two 16-bit fields. The slice is base64-ALIGNED (whole 4-char
 * groups) because `atob` refuses anything else, and whitespace is stripped first
 * so the alignment math holds for a wrapped string too.
 */
export function base64ToBytes(base64, maxBytes) {
  if (typeof base64 !== "string" || !base64) return null;
  let text = base64.replace(/\s+/g, "");
  if (Number(maxBytes) > 0) {
    const chars = Math.floor(Number(maxBytes) / 3) * 4;
    if (chars > 0 && chars < text.length) text = text.slice(0, chars);
  }
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // Not base64 (or a slice that landed mid-group despite the alignment).
    return null;
  }
}

/**
 * The pixel size a JPEG DECLARES, read off its frame header.
 *
 * This is the whole point of issue #66's mapping half: `pxPerCss` as computed
 * from `Page.getLayoutMetrics` is what the capture ASKED for, and a request is
 * not a measurement — the field factor 8/7 is consistent with Chrome returning a
 * bitmap 7/8 the predicted size on that display. So click_at inverts the size
 * the BYTES report and keeps the arithmetic only as a fallback.
 *
 * Walks the marker segments rather than trusting a fixed offset: EXIF/ICC/comment
 * segments precede the frame header on a real encoder's output. SOF is any
 * 0xC0–0xCF marker EXCEPT 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC), which share the
 * range but are not frames — so progressive (SOF2) and every other variant are
 * read with no special case. Returns null on anything malformed, non-JPEG, or
 * truncated before the frame: the caller has a fallback, and a WRONG size would
 * silently poison every pixel coordinate.
 */
export function jpegDimensions(bytes) {
  if (!bytes || typeof bytes.length !== "number" || bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let cursor = 2;
  while (cursor + 1 < bytes.length) {
    if (bytes[cursor] !== 0xff) return null;
    // Any number of 0xFF fill bytes may pad the gap before a marker.
    let marker = cursor + 1;
    while (marker < bytes.length && bytes[marker] === 0xff) marker += 1;
    if (marker >= bytes.length) return null;
    const code = bytes[marker];
    // SOS starts entropy-coded data and EOI ends the stream: past either point
    // there is no frame header left to find.
    if (code === 0xda || code === 0xd9) return null;
    // Standalone markers (TEM, RSTn) carry no length field.
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd7)) {
      cursor = marker + 1;
      continue;
    }
    if (marker + 2 >= bytes.length) return null;
    const length = (bytes[marker + 1] << 8) | bytes[marker + 2];
    if (length < 2) return null; // the length counts itself; anything less is junk
    const isFrame = code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
    if (isFrame) {
      // length(2) precision(1) height(2) width(2) — height comes FIRST.
      if (length < 8 || marker + 7 >= bytes.length) return null;
      const height = (bytes[marker + 4] << 8) | bytes[marker + 5];
      const width = (bytes[marker + 6] << 8) | bytes[marker + 7];
      if (!(width > 0) || !(height > 0)) return null;
      return { width, height };
    }
    cursor = marker + 1 + length;
  }
  return null;
}

/**
 * The bridge note that rides back with EVERY screenshot.
 *
 * Before #66 no layer told the model what size image it was looking at, so a
 * pixel coordinate was measured against a guess. Stating the size — and, for a
 * viewport capture, the factor onto the CSS space the click lands in — is what
 * makes a pixel-mode aim checkable instead of hopeful. Zoom and display scale
 * are named only when they are NOT 1: on the common case they are noise, and on
 * a scaled display they are the reason the numbers look surprising.
 */
export function screenshotImageNote(info) {
  const width = Math.max(1, Math.round(Number(info?.imageWidth) || 1));
  const height = Math.max(1, Math.round(Number(info?.imageHeight) || 1));
  if (info?.mode === "element") {
    return (
      `Image: ${width}×${height} px, one element only — aim inside it with click_at/drag uid mode ` +
      "(xFraction/yFraction), not pixel coordinates."
    );
  }
  if (info?.mode === "fullPage") {
    return (
      `Image: ${width}×${height} px, full page — pixel coordinates cannot be measured on it; take a ` +
      "plain viewport screenshot for click_at/drag."
    );
  }
  const cssWidth = Math.max(1, Math.round(Number(info?.cssWidth) || 1));
  const cssHeight = Math.max(1, Math.round(Number(info?.cssHeight) || 1));
  const zoom = Number(info?.zoom) > 0 ? Number(info.zoom) : 1;
  const dsf = Number(info?.dsf) > 0 ? Number(info.dsf) : 1;
  const display =
    Math.abs(zoom - 1) > 0.005 || Math.abs(dsf - 1) > 0.005
      ? ` (browser zoom ${Math.round(zoom * 100)}%, display scale ${dsf.toFixed(2)}×)`
      : "";
  return (
    `Image: ${width}×${height} px = the visible viewport (${cssWidth}×${cssHeight} CSS px), ` +
    `${(width / cssWidth).toFixed(3)} image px per CSS px${display}. click_at/drag pixel coordinates ` +
    `are positions on THIS image (x 0–${width - 1}, y 0–${height - 1}).`
  );
}

/**
 * The mapping a pixel-mode click actually used, reported with the click.
 *
 * The landed-on element already says WHAT was hit; this says WHERE the bridge
 * thought it was aiming, which is the only way to tell a mis-measured target
 * apart from a mis-scaled coordinate SPACE. The instruction is deliberately
 * "correct ONCE": #66's failure mode is a constant factor, so one corrected
 * re-aim either lands or proves the space is not the problem, while retrying the
 * same numbers can only miss again.
 */
export function pixelPointNote(info) {
  const width = Math.max(1, Math.round(Number(info?.imageWidth) || 1));
  const height = Math.max(1, Math.round(Number(info?.imageHeight) || 1));
  const cssWidth = Math.max(1, Math.round(Number(info?.cssWidth) || 1));
  const cssHeight = Math.max(1, Math.round(Number(info?.cssHeight) || 1));
  return (
    `Pixel (${Math.round(Number(info?.x) || 0)}, ${Math.round(Number(info?.y) || 0)}) on the ` +
    `${width}×${height} px screenshot → viewport point (${Math.round(Number(info?.cssX) || 0)}, ` +
    `${Math.round(Number(info?.cssY) || 0)}) of ${cssWidth}×${cssHeight} CSS px. If the element below ` +
    "is not your target, the coordinate space is off — compare where that element sits on the " +
    "screenshot with where you aimed and correct once, or use uid mode."
  );
}

/**
 * The same mapping for a pixel-mode drag — both ends, since a drag that lands
 * short is as likely to have a bad END as a bad start. Shorter than the click
 * note on purpose: a drag's note already competes with the drop report for the
 * same capped budget, and the diagnosis rule is stated in the tool description.
 */
export function pixelDragNote(info) {
  const width = Math.max(1, Math.round(Number(info?.imageWidth) || 1));
  const height = Math.max(1, Math.round(Number(info?.imageHeight) || 1));
  const r = (value) => Math.round(Number(value) || 0);
  return (
    `Pixels (${r(info?.x)}, ${r(info?.y)})→(${r(info?.toX)}, ${r(info?.toY)}) on the ` +
    `${width}×${height} px screenshot → viewport (${r(info?.cssX)}, ${r(info?.cssY)})→` +
    `(${r(info?.toCssX)}, ${r(info?.toCssY)}) CSS px.`
  );
}

// -------------------------------------------------------- clipboard staging
//
// The clipboard STAGING page (`<noahOrigin>/browser-clip/<32 hex>`) is the one
// page the allowlist exempts and the one page the bridge closes on its own, so
// both halves of that decision — what counts as a staging page, and what its
// title says about the copy — live here rather than inline in background.js.

/**
 * The EXACT staging-page path, never a prefix: the server hard-404s the rest of
 * /browser-clip/, but matching a prefix would trust the server's routing to keep
 * the logged-in Noah SPA out of an exempted path.
 */
export const CLIPBOARD_STAGING_PATH_RE = /^\/browser-clip\/[0-9a-f]{32}$/;

/**
 * The staging page's own title contract (`BROWSER_CLIP_SCRIPT`, server side):
 * "COPIED" once clipboard.write* resolved, "COPY_FAILED" when the browser
 * refused it. Anything else means the button has not been pressed yet.
 */
export const CLIPBOARD_COPIED_TITLE = "COPIED";
export const CLIPBOARD_COPY_FAILED_TITLE = "COPY_FAILED";

/**
 * Is this URL a clipboard staging page for the Noah origin that sent the op?
 *
 * `stagingOrigin` is the browser-verified `sender.origin` of the relaying Noah
 * page, so an unset origin exempts nothing. Same parse rules as the allowlist
 * check that calls this (http(s) only, exact origin, exact path), because this
 * IS that check's exemption clause: allowlisting the app origin itself would
 * make the whole logged-in Noah UI drivable by an agent whose inputs include
 * untrusted page text.
 */
export function isClipboardStagingUrl(rawUrl, stagingOrigin) {
  if (!stagingOrigin) return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  return url.origin === stagingOrigin && CLIPBOARD_STAGING_PATH_RE.test(url.pathname);
}

/** As much of a tab title as a bridge note may quote (background.js NOTE_VALUE_MAX). */
export const CLIPBOARD_NOTE_TITLE_MAX = 80;

/**
 * The note the auto-close returns in place of the snapshot of a tab that no
 * longer exists.
 *
 * It has to carry three things the agent cannot see any other way: that the copy
 * SUCCEEDED (the title said so before the tab went), that the staging tab is
 * gone so there is nothing left to select away from, and where the working
 * pointer now is — because the paste has to happen on the target page and the
 * bridge just moved the pointer without being asked. When no pre-staging tab was
 * remembered the pointer is null, and saying "list_tabs then select_tab" is the
 * honest instruction: guessing a tab is what targetTab's oldest-tab fallback
 * already refuses to do silently.
 *
 * Kept under 400 chars: perform() may prepend a working-tab notice, and the two
 * share background.js's 480-char note budget.
 */
export function clipboardCopiedNote(info) {
  // A REAL chrome tab id or nothing: `Number(null)` is 0 and `Number.isInteger(0)`
  // is true, so coercing here would have printed "tabId 0" for the case this
  // formatter's whole second shape exists to describe.
  const tabId = typeof info?.tabId === "number" ? info.tabId : Number.NaN;
  if (!Number.isInteger(tabId) || tabId < 0) {
    return (
      "Copied to the clipboard: the staging tab reported COPIED, so it was closed. No previous working " +
      "tab was remembered — call list_tabs and select_tab your target page, then focus the editor and " +
      "paste with press_key as the copy tool's result said, and re-read the page to confirm the paste landed."
    );
  }
  // Bounded by CODE UNITS, because that is what the note budget counts (a title
  // of 80 astral code points is 160 of them and blew the 400-char ceiling), but
  // sliced on CODE POINT boundaries, so an over-long character is dropped whole
  // instead of surviving as half a surrogate pair.
  let title = "";
  for (const ch of String(info?.title ?? "").trim()) {
    if (title.length + ch.length > CLIPBOARD_NOTE_TITLE_MAX) break;
    title += ch;
  }
  if (!title) title = "(untitled)";
  return (
    "Copied to the clipboard: the staging tab reported COPIED, so it was closed and the working tab is " +
    `back on "${title}" (tabId ${tabId}). Focus the editor there and paste with press_key exactly as the ` +
    "copy tool's result said, then re-read the page to confirm the paste landed."
  );
}

// ---------------------------------------------------------------------- find
//
// `find` answers "where is the X?" without making the agent read a whole page:
// it filters the SAME atoms a snapshot renders, so every uid it prints is one
// the snapshot would have printed (minted through the same mintUid, valid for
// click/type exactly as long as a snapshot's). Pure here so the matching rules —
// which are the whole contract — are unit-tested.

/** How many matches one find returns before it says "more". */
export const FIND_MAX_MATCHES = 20;

/** A matched atom is printed at most this long; a 40 KB textbox value is not a search hit. */
export const FIND_ATOM_PRINT_MAX = 300;

/** One `[eN] role …` piece inside a (possibly row-joined) snapshot atom. */
const FIND_PIECE = /^\[(e\d+)\] (\S+)(.*)$/s;

/**
 * Case- and width-insensitive form for matching. NFKC folds full-width Latin and
 * compatibility jamo onto their ordinary forms; Hangul has no case, so lowering
 * is a no-op for it and the match stays an exact syllable substring (a query of
 * "저장" matches "저장하기", never a decomposed partial syllable). Whitespace
 * runs collapse so a name the renderer re-spaced still matches.
 */
export function findFold(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Filter rendered snapshot atoms down to the uid elements matching `role`
 * (exact AX role, case-insensitive) and/or `name` (substring of everything the
 * line prints after the role: the quoted label, its `= "value"`, state flags).
 *
 * A table row is ONE atom holding several `[eN] …` cells joined by " | ", so the
 * atom is split at those seams and each cell is judged on its own — a match
 * prints the cell, never the whole row. Lines without a uid (prose, headings
 * the renderer did not mint) cannot be acted on, so they never count as
 * matches; `textOnly` reports how many of them contained `name`, so a zero-hit
 * answer can say the words ARE on the page but not on anything clickable.
 *
 * Returns `{ lines, total, textOnly }`: `lines` holds at most `limit` matches in
 * document order, `total` how many there were in all.
 */
export function findAtoms(atoms, opts) {
  const wantRole = findFold(opts?.role);
  const wantName = findFold(opts?.name);
  const limit = Number(opts?.limit) > 0 ? Math.floor(Number(opts.limit)) : FIND_MAX_MATCHES;
  const lines = [];
  let total = 0;
  let textOnly = 0;
  for (const atom of Array.isArray(atoms) ? atoms : []) {
    if (typeof atom !== "string" || !atom.trim()) continue;
    const pieces = atom.trim().split(/ \| (?=\[e\d+\] )/);
    let pieceMatched = false;
    for (const piece of pieces) {
      const parsed = FIND_PIECE.exec(piece.trim());
      if (!parsed) continue;
      const [, , role, rest] = parsed;
      if (wantRole && findFold(role) !== wantRole) continue;
      if (wantName && !findFold(rest).includes(wantName)) continue;
      pieceMatched = true;
      total += 1;
      if (lines.length < limit) {
        const text = piece.trim();
        lines.push(
          text.length > FIND_ATOM_PRINT_MAX ? `${text.slice(0, FIND_ATOM_PRINT_MAX)}… [cut]` : text,
        );
      }
    }
    if (!pieceMatched && wantName && !wantRole && findFold(atom).includes(wantName)) {
      textOnly += 1;
    }
  }
  return { lines, total, textOnly };
}

// ---------------------------------------------------------------------- zoom
//
// `zoom` is a screenshot of a REGION of the viewport, magnified. Same three
// pixel units as captureShot (CSS → DIP via the browser zoom → PHYSICAL via the
// display scale), same vision fit, same measured mapping — plus an UPSCALE,
// which is the point: a 120×40 CSS-px badge captured at 1× is unreadable.

/** Most image px a zoom spends on one CSS px — past this the page's own pixels are just interpolated. */
export const ZOOM_MAX_PX_PER_CSS = 4;
/** Smallest region edge, CSS px; below this there is nothing a model can read. */
export const ZOOM_MIN_EDGE_CSS = 8;

/**
 * The `scale` to ask `Page.captureScreenshot` for when capturing a region of
 * `dipWidth`×`dipHeight` (clip DIP) on a display of `dsf`, so that the bitmap
 * (DIP × scale × dsf) is as LARGE as allowed: at most `ZOOM_MAX_PX_PER_CSS`
 * image px per CSS px (`zoom` = the browser zoom, CSS→DIP), at most `maxEdge`
 * px on either edge, and then fitted to the standard vision tier exactly like a
 * viewport capture, so the image we send is the image the model sees and pixel
 * coordinates measured on it come back in OUR space.
 */
export function zoomShotScale(dipWidth, dipHeight, info) {
  const dsf = Number(info?.dsf) > 0 ? Number(info.dsf) : 1;
  const zoom = Number(info?.zoom) > 0 ? Number(info.zoom) : 1;
  const maxEdge = Number(info?.maxEdge) > 0 ? Number(info.maxEdge) : 1400;
  const pw = Math.max(1, Number(dipWidth) * dsf);
  const ph = Math.max(1, Number(dipHeight) * dsf);
  let scale = Math.min(ZOOM_MAX_PX_PER_CSS / (zoom * dsf), maxEdge / pw, maxEdge / ph);
  for (let guard = 0; guard < 6; guard += 1) {
    const w = Math.max(1, Math.round(pw * scale));
    const h = Math.max(1, Math.round(ph * scale));
    if (visionFits(w, h, info)) break;
    const [fitW] = visionFitSize(w, h, info);
    if (!(fitW > 0) || fitW >= w) break;
    scale = scale * (fitW / w);
  }
  return Math.max(scale, 1 / 10000);
}

/**
 * The bridge note a zoom capture carries: what the image IS, and — because a
 * zoom REPLACES the pixel mapping click_at/drag invert — that pixel coordinates
 * now mean positions on THIS image.
 */
export function zoomImageNote(info) {
  const width = Math.max(1, Math.round(Number(info?.imageWidth) || 1));
  const height = Math.max(1, Math.round(Number(info?.imageHeight) || 1));
  const x = Math.round(Number(info?.x) || 0);
  const y = Math.round(Number(info?.y) || 0);
  const cssWidth = Math.max(1, Math.round(Number(info?.cssWidth) || 1));
  const cssHeight = Math.max(1, Math.round(Number(info?.cssHeight) || 1));
  return (
    `Image: ${width}×${height} px = viewport region (${x}, ${y})–(${x + cssWidth}, ${y + cssHeight}) ` +
    `CSS px, ${(width / cssWidth).toFixed(3)} image px per CSS px. Until the next screenshot or zoom, ` +
    `click_at/drag pixel coordinates are positions on THIS image (x 0–${width - 1}, y 0–${height - 1}).`
  );
}

// ------------------------------------------------------------------ read_url
//
// `read_url` GETs ONE URL through the browser's own navigation stack (a
// short-lived background tab, intercepted with CDP's Fetch domain — see
// background.js readUrl) and hands back the body as text. These are its pure
// decisions: which content types count as text, how the body is decoded and
// shaped, and how a URL is reduced for a note.

/** The header value of `name` in CDP's `[{name, value}]` header list, case-insensitively. */
export function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  for (const header of Array.isArray(headers) ? headers : []) {
    if (String(header?.name ?? "").toLowerCase() === wanted) return String(header?.value ?? "");
  }
  return "";
}

/** The bare media type of a Content-Type value: `application/json; charset=utf-8` → `application/json`. */
export function mediaTypeOf(contentType) {
  return String(contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Text-like media types read_url may return: `text/*` (HTML included — it is
 * text, and the agent asked for this exact URL), JSON and XML in all their
 * `+json`/`+xml` structured-suffix forms, CSV, NDJSON, JavaScript and YAML.
 * Anything else — images, PDFs, archives, octet-stream, and a MISSING type — is
 * refused before a byte of the body is read: a binary body decoded as text is
 * noise at best, and an unlabeled one is not something to guess at.
 */
export function isTextLikeContentType(contentType) {
  const type = mediaTypeOf(contentType);
  if (!type) return false;
  if (type.startsWith("text/")) return true;
  if (/^application\/(?:[\w.-]+\+)?(?:json|xml)$/.test(type)) return true;
  return [
    "application/csv",
    "application/x-ndjson",
    "application/ndjson",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/yaml",
    "application/x-yaml",
    "application/x-www-form-urlencoded",
  ].includes(type);
}

/** The `charset=` of a Content-Type value, or "utf-8". */
export function charsetOf(contentType) {
  const match = /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(String(contentType ?? ""));
  return match ? match[1].toLowerCase() : "utf-8";
}

/**
 * Decode the body bytes with the declared charset (EUC-KR pages exist), falling
 * back to UTF-8 for a label TextDecoder does not know; never throws.
 */
export function decodeBody(bytes, contentType) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(data);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

/**
 * The text read_url returns: JSON pretty-printed (2-space) when the WHOLE body
 * parses — a truncated body never does, so it is returned as received — and
 * everything cut to `maxChars` with the cut reported, never silent.
 */
export function formatFetchedBody(text, contentType, opts) {
  const maxChars = Number(opts?.maxChars) > 0 ? Number(opts.maxChars) : 100_000;
  let body = String(text ?? "");
  let pretty = false;
  const type = mediaTypeOf(contentType);
  const looksJson = /json/.test(type) || /^\s*[[{]/.test(body);
  if (looksJson && !opts?.bytesTruncated) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
      pretty = true;
    } catch {
      // Not JSON after all (or malformed): the raw text is the honest answer.
    }
  }
  const truncated = Boolean(opts?.bytesTruncated) || body.length > maxChars;
  return { body: body.length > maxChars ? body.slice(0, maxChars) : body, pretty, truncated };
}

/**
 * A URL reduced to scheme://host/path — no userinfo, no query, no fragment —
 * for anything that is not the fetched content itself (notes, console sources,
 * network rows). Non-http(s) URLs keep only their scheme; unparseable ones say so.
 */
export function urlWithoutQuery(rawUrl, max = 300) {
  try {
    const url = new URL(String(rawUrl ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${url.protocol}…`;
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, max);
  } catch {
    return rawUrl ? "(unparseable url)" : "";
  }
}

// ------------------------------------------------- read_console / read_network
//
// The two capture readers hand the model what a site logged or requested. Both
// are consent-gated per site in background.js; these are the pure halves that
// decide what an entry LOOKS like on the way out: bounded, query-free, and with
// anything token-shaped masked.

/** Most characters one console entry's text keeps (after redaction). */
export const CONSOLE_TEXT_MAX = 500;

/**
 * Mask token-shaped substrings: `Bearer …`/`Basic …`/`Token …` credentials,
 * JWTs, long hex runs (session ids, API keys, hashes ≥ 32), long base64/url-safe
 * runs that mix letters and digits (≥ 40), and the value of `key=value` /
 * `"key": "value"` pairs whose key names a secret. Over-masking a hash is the
 * cheap direction: the model reads logs to see what HAPPENED, and no answer it
 * needs hangs on the exact token.
 */
export function redactTokens(text) {
  return String(text ?? "")
    .replace(/\b(Bearer|Basic|Token|Digest)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, "$1 [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[REDACTED_JWT]")
    .replace(
      /((?:access|refresh|id|auth|session|csrf|xsrf)[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|pwd|session[_-]?id|sid|authorization|cookie)(["']?\s*[:=]\s*["']?)([^\s"'&,;}]{4,})/gi,
      "$1$2[REDACTED]",
    )
    .replace(/\b[0-9a-fA-F]{32,}\b/g, "[REDACTED_HEX]")
    .replace(/(?<![A-Za-z0-9+_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, "[REDACTED]");
}

/** One CDP RemoteObject (a console argument) as short text, never touching the page. */
function remoteObjectText(arg) {
  if (!arg || typeof arg !== "object") return String(arg ?? "");
  if (arg.type === "string") return String(arg.value ?? "");
  if ("value" in arg && arg.value !== undefined) {
    try {
      return typeof arg.value === "object" ? JSON.stringify(arg.value) : String(arg.value);
    } catch {
      return String(arg.description ?? arg.type ?? "");
    }
  }
  if (arg.unserializableValue) return String(arg.unserializableValue);
  return String(arg.description ?? arg.className ?? arg.type ?? "");
}

const CONSOLE_LEVELS = {
  log: "log",
  info: "info",
  debug: "debug",
  warning: "warning",
  warn: "warning",
  error: "error",
  assert: "error",
  trace: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  count: "log",
  timeEnd: "log",
  verbose: "debug",
};

/** "source.js:12" from a frame-ish {url, lineNumber} (0-based line), query-free. */
function sourceOf(url, lineNumber) {
  const bare = urlWithoutQuery(url, 200);
  if (!bare) return "";
  return Number.isFinite(Number(lineNumber)) ? `${redactTokens(bare)}:${Number(lineNumber) + 1}` : redactTokens(bare);
}

const clipText = (text) => {
  const masked = redactTokens(String(text ?? "").replace(/\s+$/g, ""));
  return masked.length > CONSOLE_TEXT_MAX ? `${masked.slice(0, CONSOLE_TEXT_MAX)}…` : masked;
};

/**
 * One console entry from any of the three CDP events capture listens to:
 * `Runtime.consoleAPICalled` (console.log/warn/error …), `Runtime.exceptionThrown`
 * (an uncaught error), `Log.entryAdded` (what the BROWSER logged about the page:
 * failed loads, CSP and mixed-content violations, interventions). Null for
 * anything else. Shape: {level, text, source, time} — `time` in epoch ms.
 */
export function consoleEntryFrom(method, params) {
  if (method === "Runtime.consoleAPICalled") {
    const frame = params?.stackTrace?.callFrames?.[0];
    return {
      level: CONSOLE_LEVELS[params?.type] || "log",
      text: clipText((params?.args || []).map(remoteObjectText).join(" ")),
      source: frame ? sourceOf(frame.url, frame.lineNumber) : "",
      time: Number(params?.timestamp) || Date.now(),
    };
  }
  if (method === "Runtime.exceptionThrown") {
    const details = params?.exceptionDetails || {};
    const described = details.exception?.description || details.text || "Uncaught exception";
    return {
      level: "error",
      text: clipText(described),
      source: sourceOf(details.url || details.stackTrace?.callFrames?.[0]?.url, details.lineNumber),
      time: Number(params?.timestamp) || Date.now(),
    };
  }
  if (method === "Log.entryAdded") {
    const entry = params?.entry || {};
    return {
      level: entry.level === "verbose" ? "debug" : String(entry.level || "info"),
      text: clipText(`${entry.source ? `[${entry.source}] ` : ""}${entry.text || ""}`),
      source: sourceOf(entry.url, entry.lineNumber),
      time: Number(entry.timestamp) || Date.now(),
    };
  }
  return null;
}

/** Requests kept per tab by read_network's capture. */
export const NETWORK_BUFFER_MAX = 300;

/**
 * Fold one CDP `Network.*` event into a read_network capture
 * (`{ entries, byId, dropped }`). Only what the op promises survives: method,
 * URL WITHOUT query/fragment (and token-redacted), status, resource type,
 * duration, a failure reason. Headers, bodies, post data, initiators and timing
 * breakdowns in the event are never copied. A redirect closes the hop it ended
 * (with the 3xx status) and opens a new entry for where it went; `data:`/`blob:`
 * requests are skipped (they are not network traffic and their URL IS the data).
 */
export function networkCaptureApply(capture, method, params) {
  if (!capture || !params) return;
  const id = String(params.requestId ?? "");
  const finish = (entry, timestamp) => {
    if (entry.durationMs == null && Number.isFinite(Number(timestamp)) && Number.isFinite(entry.start)) {
      entry.durationMs = Math.max(0, Math.round((Number(timestamp) - entry.start) * 1000));
    }
  };
  if (method === "Network.requestWillBeSent") {
    const previous = capture.byId.get(id);
    if (previous && params.redirectResponse) {
      previous.status = Number(params.redirectResponse.status) || previous.status;
      finish(previous, params.timestamp);
      capture.byId.delete(id);
    }
    const rawUrl = String(params.request?.url ?? "");
    if (/^(?:data|blob):/i.test(rawUrl)) return;
    const entry = {
      method: String(params.request?.method ?? "GET").slice(0, 16),
      url: redactTokens(urlWithoutQuery(rawUrl, 400)),
      status: 0,
      type: String(params.type ?? "Other").slice(0, 32),
      durationMs: null,
      failed: "",
      time: Number.isFinite(Number(params.wallTime)) ? Math.round(Number(params.wallTime) * 1000) : Date.now(),
      start: Number(params.timestamp),
    };
    capture.entries.push(entry);
    capture.byId.set(id, entry);
    if (capture.entries.length > NETWORK_BUFFER_MAX) {
      const gone = capture.entries.shift();
      capture.dropped += 1;
      for (const [key, value] of capture.byId) {
        if (value === gone) capture.byId.delete(key);
      }
    }
    return;
  }
  const entry = capture.byId.get(id);
  if (!entry) return;
  if (method === "Network.responseReceived") {
    entry.status = Number(params.response?.status) || entry.status;
    if (params.type) entry.type = String(params.type).slice(0, 32);
  } else if (method === "Network.loadingFinished") {
    finish(entry, params.timestamp);
    capture.byId.delete(id);
  } else if (method === "Network.loadingFailed") {
    entry.failed = String(
      params.canceled ? "canceled" : params.blockedReason ? `blocked: ${params.blockedReason}` : params.errorText || "failed",
    ).slice(0, 120);
    finish(entry, params.timestamp);
    capture.byId.delete(id);
  }
}

/** A capture entry as it leaves the extension — the internal start clock dropped. */
export function networkEntryOut(entry) {
  return {
    method: entry.method,
    url: entry.url,
    status: entry.status,
    type: entry.type,
    durationMs: entry.durationMs,
    failed: entry.failed,
    time: entry.time,
  };
}

// --------------------------------------------------------------------- batch
//
// `batch` runs several EXISTING ops in one round trip. The extension runs each
// step through the very same perform() a lone op takes — allowlist, landing
// check, verification ladder, dialog guard — so these pure halves only decide
// what may be a step and what of a step's reply travels back.

export const BATCH_MAX_STEPS = 10;

/**
 * Ops a batch may run. Deliberately NOT: the credential/data reads
 * (read_cookies, read_storage, read_console, read_network — each needs its own
 * consent popup and a deliberate, separately audited call), screenshot/zoom
 * (an image per step would need the screenshot share/save/vision machinery per
 * step; a batch returns none), read_url, tab management, dialogs, the
 * clipboard staging flow, and batch itself.
 */
export const BATCH_OPS = new Set([
  "navigate",
  "click",
  "click_at",
  "type",
  "fill_form",
  "select_option",
  "press_key",
  "hover",
  "scroll",
  "wait_for",
  "snapshot",
  "read_text",
  "find",
]);

/** Steps whose OUTPUT is the point: they always return their page content. */
export const BATCH_READ_OPS = new Set(["snapshot", "read_text", "find"]);

const BATCH_STEP_FIELDS = [
  "url",
  "uid",
  "x",
  "y",
  "xFraction",
  "yFraction",
  "text",
  "submit",
  "clear",
  "keystrokes",
  "key",
  "modifiers",
  "repeat",
  "direction",
  "pixels",
  "textGone",
  "timeoutS",
  "option",
  "offset",
  "expand",
  "maxChars",
  "role",
  "name",
];

/**
 * One wire step → the message perform() runs, built from a WHITELIST of fields
 * (nothing a step carries can reach an internal flag), or `{ error }`. A stored
 * secret never rides a batch: its plaintext must only ever travel on the
 * transient single-op frame the server builds for it, behind the client's
 * version probe — so a step carrying one is refused outright rather than
 * stripped and typed as nothing.
 */
export function batchStepMessage(raw) {
  if (!raw || typeof raw !== "object") return { error: "a step must be an object with an `op`." };
  const op = String(raw.op ?? "");
  if (!BATCH_OPS.has(op)) {
    return {
      error: `"${op.slice(0, 32)}" cannot run inside a batch (allowed: ${[...BATCH_OPS].join(", ")}).`,
    };
  }
  const fields = Array.isArray(raw.fields) ? raw.fields : null;
  if (raw.secret || raw.secretText || fields?.some((field) => field?.secret || field?.secretValue)) {
    return { error: "a stored secret never rides a batch — type it with its own type/fill_form call." };
  }
  const message = { op };
  for (const key of BATCH_STEP_FIELDS) {
    if (raw[key] !== undefined && raw[key] !== null) message[key] = raw[key];
  }
  if (fields) {
    message.fields = fields.map((field) => ({
      uid: String(field?.uid ?? ""),
      value: String(field?.value ?? ""),
      ...(field?.clear ? { clear: true } : {}),
    }));
  }
  return { message };
}

/** What of one step's reply travels back — the per-op result shape, minus the tab list. */
export function batchStepResult(op, reply) {
  const out = { op, ok: Boolean(reply?.ok) };
  if (!out.ok) {
    out.message = String(reply?.message || "The step failed without a reason.");
    return out;
  }
  for (const key of [
    "note",
    "url",
    "title",
    "landedOn",
    "snapshot",
    "snapshotError",
    "pageText",
    "pageTextOffset",
    "pageTextTotal",
    "dialog",
  ]) {
    if (reply[key] !== undefined && reply[key] !== "") out[key] = reply[key];
  }
  return out;
}
