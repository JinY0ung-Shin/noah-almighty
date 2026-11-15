// Noah Almighty browser bridge — MV3 service worker.
//
// Receives semantic operations from an authenticated Noah tab and performs them
// with CDP over chrome.debugger. Two invariants shape the whole file:
//
//  1. NO JAVASCRIPT EXECUTION — with ONE narrow, deliberate exception. Almost no
//     code path builds a script string, and elements are addressed by
//     backendNodeId from the accessibility tree, so there is nothing for injected
//     page text to escape into. The ONE exception is `read_storage`: it evaluates
//     a FIXED, bridge-authored expression via `Runtime.evaluate` (one of the two
//     READ_*_STORAGE_EXPR constants, chosen by the validated store kind) to read
//     Web Storage — because DOMStorage, the only CDP domain that reads
//     localStorage/sessionStorage, is NOT in the domain allowlist chrome.debugger
//     exposes, so there is no no-JS way to read it. That expression is a constant
//     that NEVER carries model- or page-derived input, was added by a deliberate
//     owner decision, and its result is treated as untrusted page content. This
//     no-JS property is what bounds credential reach — the permission manifest
//     does not (a page-context fetch with credentials included would inherit every
//     session, which is exactly why we never gain the ability to run an ARBITRARY
//     script; the read_storage exception is a fixed constant, not that).
//
//  2. ENFORCE HERE, NOT UPSTREAM. The server also gates, but a guardrail that
//     lives only on the far side of the wire is not a guardrail. Every command
//     passes CDP_ALLOWLIST and the origin allowlist inside this worker.
//
// Scope is the tab group: a tab inside the Noah group is attached, dragging it
// out detaches it. That makes consent a live, visible surface the user can
// revoke without a settings screen.

import {
  renderAxTree,
  renderAxText,
  capSnapshot,
  mergeTextLines,
  axProp,
  axValueAnswer,
  clearFailed,
  ariaExpandedOf,
  isDisclosureTrigger,
  disclosureClickOutcome,
  pastedTextVanished,
  extraClickables,
  groupClickableItems,
  ariaSortByBackendId,
  sliderPlan,
  unlabeledInteractiveIds,
  viewportShotScale,
  jpegDimensions,
  base64ToBytes,
  screenshotImageNote,
  pixelPointNote,
  pixelDragNote,
  isClipboardStagingUrl,
  clipboardCopiedNote,
  CLIPBOARD_COPIED_TITLE,
  CLIPBOARD_COPY_FAILED_TITLE,
  EXTRA_CLICKABLE_MAX,
  EXTRA_CLICKABLE_GROUP_HEAD,
  findAtoms,
  FIND_MAX_MATCHES,
  zoomShotScale,
  zoomImageNote,
  ZOOM_MIN_EDGE_CSS,
  headerValue,
  mediaTypeOf,
  isTextLikeContentType,
  decodeBody,
  formatFetchedBody,
  urlWithoutQuery,
} from "./axtree.js";
import {
  SECRET_CONSENT_TYPE,
  SECRET_SESSION_GRANT_HOST,
  SECRET_CONSENT_ALREADY_OPEN,
  SECRET_CONSENT_DECLINED,
  SECRET_CONSENT_UNANSWERED,
  secretConsentOpenFailed,
  hostOfUrl,
  secretHostAllowed,
  isPasswordInputShape,
  secretTabHostRefusal,
  secretFrameHostRefusal,
  secretFrameUnknownRefusal,
  secretPasswordOnlyRefusal,
  secretNonTextRefusal,
  secretValueMissingRefusal,
  secretEnteredNote,
  secretVerifiedNote,
  secretUnverifiedNote,
  secretLengthMismatchNote,
} from "./secretInput.js";

const GROUP_TITLE = "Noah";
const CDP_VERSION = "1.3";

/**
 * Default-deny allowlist of CDP methods. Everything the bridge needs and
 * nothing else — of `Runtime.*` ONLY the single `Runtime.evaluate` behind
 * read_storage (its own paragraph below — the ONE exception to this file's
 * no-page-JS invariant), no `Storage.*`, no `Browser.*`, and of `Network.*` ONLY
 * the consent-gated `Network.getCookies` (its own paragraph below), never the
 * event-streaming rest. The read-only additions stay
 * inside that line: `DOM.describeNode` reads structure, `Page.captureScreenshot`
 * reads pixels — the same exfiltration class as a snapshot, gated by the same
 * origin allowlist — `DOM.getNodeForLocation` hit-tests a point so a
 * coordinate click can report what it landed on instead of assuming success,
 * `Page.getFrameTree` reads the frame STRUCTURE (ids only, no content) so
 * same-process iframes can be walked at all, `DOM.getFrameOwner` answers the
 * other half of that structure question — which element OWNS a given frame — so
 * a frame's content block can name the `Iframe` line it belongs to,
 * `DOM.getDocument` reads that same structure from the ROOT instead of from one
 * element — the pierced node tree, which is what lets a refused click climb from
 * the piece it hit-tested to the overlay LAYER (see overlayRootFor) and mint a
 * uid worth following; it exposes nothing a depth -1 `DOM.describeNode` already
 * here does not, and `Accessibility.getPartialAXTree` reads ONE node — the same exfiltration class
 * as the getFullAXTree already here, and strictly less of it. It exists so a
 * clearing write can be VERIFIED by reading the field back instead of claiming
 * success on faith, the line select_option already draws.
 *
 * `DOMSnapshot.captureSnapshot` reads the whole document ONCE — structure,
 * attributes, the computed styles it is asked for, laid-out text and boxes. It
 * executes no page JS (the invariant at the top of this file holds for it in
 * full — unlike read_storage's one fixed expression, this is not a
 * `Runtime.evaluate` in disguise) and it is the same
 * exfiltration class as the `Accessibility.getFullAXTree` already here, gated by
 * the same origin allowlist. It exists because a page's thumbnails are routinely
 * plain <div>s with a click listener and no accessibility node at all: without
 * it those elements have no uid and the only way to reach one is guessing pixels.
 * `DOMSnapshot.enable` is deliberately NOT here — probe-measured
 * (`tests/visual/ax-facts.spec.ts`), captureSnapshot answers without it, and an
 * allowlist entry nothing calls is a widening bought for nothing.
 *
 * The three `Overlay.*` entries are the action highlight (see showActionHighlight):
 * the box drawn over the element an op is about to touch, so the user can SEE what
 * the avatar is doing. They are DRAW-ONLY output commands — they read nothing back,
 * execute no page JS, and change no page DOM; the browser's compositor paints the
 * box and the page cannot even observe it. `Overlay.enable` is here for one reason
 * only: `Overlay.highlightNode` REFUSES without it ("Overlay must be enabled before
 * a tool can be shown" — probe-measured, `tests/visual/overlay-highlight.spec.ts`),
 * which is the DOMSnapshot.enable rule landing the other way. That same probe
 * measured the cost of drawing: in a headful browser the box IS included in
 * `Page.captureScreenshot`, which is why captureShot hides before it captures.
 * No other `Overlay.*` method belongs here — `setInspectMode` would hand the
 * user's own cursor to an inspector, and `getHighlightObjectForTest` is a READ.
 *
 * `Network.getCookies` is the ONE `Network.*` method here, and it is not the
 * open door the domain's name suggests: it is a COMMAND that reads the cookie
 * store for a given URL, NOT an event subscription — probe-measured
 * (`tests/visual/cookie-facts.spec.ts`) to answer with only DOM/Page enabled, so
 * `Network.enable` (which would stream every request and response — a far wider
 * read) stays OFF the list, the DOMSnapshot.enable rule once more. read_cookies
 * calls it with `urls:[tab.url]`, so ONLY the current tab's origin is ever read
 * (never a cross-site cookie), and it runs ONLY after the user approves a
 * per-site, per-session popup in their own browser (requestDataConsent — the
 * first read of a site each browser session prompts; an approval is remembered
 * until the user revokes it or the browser closes). What it returns is
 * the user's live session tokens — the reason for both the consent gate and the
 * audit that logs cookie NAMES only, never values.
 *
 * `Runtime.evaluate` is the ONE method here that runs page JavaScript, and the
 * ONE exception to the no-page-JS invariant at the top of this file. It exists
 * for read_storage: `DOMStorage` — the only CDP domain that reads Web Storage —
 * is EXCLUDED from the domain allowlist Chrome's `chrome.debugger` API exposes,
 * so `DOMStorage.getDOMStorageItems` rejects over `chrome.debugger.sendCommand`
 * with `-32601` "wasn't found". (It answers only over RAW CDP — a different, more
 * permissive transport this extension does not use, which is why an earlier
 * raw-CDP probe over Playwright's `newCDPSession` wrongly cleared it; pin Chrome
 * facts on the transport we actually call, `chrome.debugger`.) There is therefore
 * NO no-JS way to read localStorage/sessionStorage here. The mitigations that
 * keep the exception narrow: the evaluated `expression` is a FIXED,
 * bridge-authored constant chosen by the validated store kind (one of
 * READ_LOCAL_STORAGE_EXPR / READ_SESSION_STORAGE_EXPR — never message.name/kind,
 * the tab URL, or any page/model value, and sendCdp STRUCTURALLY refuses any
 * other expression via RUNTIME_EVALUATE_ALLOWED, so "no arbitrary page JS" is
 * enforced at the transport, not just by call-site convention), it runs with
 * returnByValue in the
 * CURRENT tab only (no page mutation, no awaited promise, no user gesture), and
 * it stays behind the SAME per-site, PER-STORAGE-TYPE, per-session consent
 * (requestDataConsent) as before. What it returns is credential-class data
 * (localStorage routinely holds bearer/JWT tokens) AND untrusted page content —
 * the reason for the consent gate, the audit that logs entry KEY names only
 * (never values), and the untrusted-data framing the tool result puts around it.
 * No other `Runtime.*` belongs here: `Runtime.enable` (the console/exception
 * event stream) stays OFF, evaluate needing no enable exactly as
 * `Network.getCookies` needed no `Network.enable`.
 *
 * The `Fetch.*` and `IO.*` entries exist for read_url (0.29.0) ONLY, and sendCdp
 * fences them structurally (READ_URL_FETCH_METHODS): they are refused on every
 * tab except the short-lived background tab read_url itself created
 * (`readUrlTabs`), `Fetch.enable` may only intercept DOCUMENT requests,
 * `Fetch.continueRequest` may carry NOTHING but the requestId (no url, method,
 * headers or postData override — the request goes out exactly as the browser
 * built it), and `Fetch.failRequest` only a requestId plus a reason. There is
 * no `Fetch.fulfillRequest`, so nothing can ever be injected into a page. Why a
 * tab at all, rather than a `fetch()` from this worker: the extension FETCHES
 * NOTHING on its own (no host_permissions — the 0.9.0 decision), and a worker
 * fetch without host permissions is a cross-origin request from
 * chrome-extension:// that most sites' CORS would refuse anyway. The browser's
 * OWN navigation stack makes the request instead, with exactly the cookies a
 * top-level navigation to that URL sends; interception is what lets every
 * redirect HOP be judged against the allowlist BEFORE it is sent, the content
 * type be judged before a byte of the body is read, and the body be read
 * (`takeResponseBodyAsStream` + `IO.read`, byte-capped) without the page ever
 * rendering or running a script — the request is failed after the read, and the
 * tab closed. No page JS runs: the document never commits.
 */
const CDP_ALLOWLIST = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getDocument",
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.focus",
  "DOM.scrollIntoViewIfNeeded",
  "DOMSnapshot.captureSnapshot",
  "Fetch.enable",
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.takeResponseBodyAsStream",
  "Fetch.getResponseBody",
  "IO.read",
  "IO.close",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.imeSetComposition",
  "Input.insertText",
  "Network.getCookies",
  "Overlay.enable",
  "Overlay.highlightNode",
  "Overlay.hideHighlight",
  "Page.captureScreenshot",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.navigateToHistoryEntry",
  "Runtime.evaluate",
  "Target.setAutoAttach",
]);

/**
 * The two FIXED expressions read_storage evaluates via `Runtime.evaluate` — the
 * ONLY page JS this bridge runs (see the file header and the CDP_ALLOWLIST
 * rationale). They differ ONLY in localStorage vs sessionStorage; the read_storage
 * branch picks between them by the already-validated store kind and NEVER
 * interpolates message.name/kind, the tab URL, or any other page/model value.
 * Each is defensive by construction: any throw (storage disabled on the origin, a
 * hostile getItem override) is caught and the expression returns "[]", so a read
 * failure fails closed to an empty list rather than a page-thrown exception. The
 * returned JSON string is parsed and the optional name filter applied on the
 * EXTENSION side, on the parsed result — never inside the expression.
 */
const READ_LOCAL_STORAGE_EXPR =
  '(() => { try { const s = localStorage; const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push([k, s.getItem(k)]); } return JSON.stringify(out); } catch (e) { return "[]"; } })()';
const READ_SESSION_STORAGE_EXPR =
  '(() => { try { const s = sessionStorage; const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push([k, s.getItem(k)]); } return JSON.stringify(out); } catch (e) { return "[]"; } })()';

/**
 * The ONLY expressions `Runtime.evaluate` may run. sendCdp enforces this
 * membership STRUCTURALLY, so the no-page-JS exception stays exactly these two
 * audited constants: a future call site that tried to pass a dynamic or
 * interpolated expression (any page/model value) is rejected at the transport,
 * not merely discouraged by the call-site convention above.
 */
const RUNTIME_EVALUATE_ALLOWED = new Set([READ_LOCAL_STORAGE_EXPR, READ_SESSION_STORAGE_EXPR]);

/**
 * Which hostnames the bridge may drive. EMPTY MEANS DENY EVERYTHING — the
 * opposite of nanobrowser's firewall, whose enabled-but-empty default silently
 * permits the whole web.
 *
 * Two sources, and the precedence matters more than the mechanism:
 *
 *   managed  — chrome.storage.managed, pushed by enterprise policy. When it is
 *              present it is the WHOLE answer; the local list is ignored, so a
 *              user on a managed fleet cannot widen what the operator allowed.
 *   local    — chrome.storage.local, edited on the options page. Only consulted
 *              on an UNMANAGED install (development). This grants nothing extra
 *              in practice: someone who can set it could equally edit this file.
 *
 * Cached because it is read on every operation; invalidated on any storage
 * change so a policy push takes effect without reinstalling.
 */
const POLICY_KEY = "allowedOrigins";

let policyCache = null;

async function readPolicy() {
  if (policyCache) return policyCache;

  let managed = [];
  try {
    const stored = await chrome.storage.managed.get(POLICY_KEY);
    if (Array.isArray(stored?.[POLICY_KEY])) managed = stored[POLICY_KEY].filter(Boolean);
  } catch {
    // No managed store exists on an unmanaged install; that is not an error.
  }
  if (managed.length) {
    policyCache = { patterns: managed, source: "managed" };
    return policyCache;
  }

  let local = [];
  try {
    const stored = await chrome.storage.local.get(POLICY_KEY);
    if (Array.isArray(stored?.[POLICY_KEY])) local = stored[POLICY_KEY].filter(Boolean);
  } catch {
    // Ignore: an unreadable local list must fail closed, not open.
  }
  policyCache = { patterns: local, source: local.length ? "local" : "empty" };
  return policyCache;
}

/**
 * Whether the user wants to SEE the action highlight — the box drawn over the
 * element an op is about to touch (showActionHighlight below).
 *
 * chrome.storage.LOCAL only, and deliberately NOT managed: enterprise policy
 * governs what the agent may TOUCH, which is why allowedOrigins has to let an
 * operator overrule the user. This governs only what the HUMAN sees. There is
 * nothing here for a policy to protect, so it stays a personal preference even
 * on a managed install.
 *
 * Default ON — absent, or anything other than an explicit `false`, reads as
 * enabled. Every install that predates this setting has no value stored, and
 * seeing what the avatar touches is the whole point of the feature; a user who
 * never opens the options page should still get it.
 */
const HIGHLIGHT_KEY = "highlightActions";

/** Cached like policyCache, but NULL-checked: `false` is a real cached value. */
let highlightPrefCache = null;

async function readHighlightPref() {
  if (highlightPrefCache !== null) return highlightPrefCache;
  let on = true;
  try {
    const stored = await chrome.storage.local.get(HIGHLIGHT_KEY);
    on = stored?.[HIGHLIGHT_KEY] !== false;
  } catch {
    // Unlike readPolicy, an unreadable value here fails toward VISIBILITY: this
    // preference grants no reach, so the safe direction is showing the user more.
  }
  highlightPrefCache = on;
  return highlightPrefCache;
}

chrome.storage.onChanged.addListener((_changes, areaName) => {
  // The SESSION area holds only the bridge's own scratch state — the working-tab
  // pointer, the uid-map hand-off. A policy push never lands there, and dropping
  // the cache on every tab switch would re-read managed storage for nothing.
  if (areaName !== "session") {
    policyCache = null;
    highlightPrefCache = null;
  }
});

/** tabId -> { children: Map<sessionId, frameId> } — the OOPIF sessions of a tab. */
const attached = new Map();

/**
 * `${tabId}:${sessionId||"root"}` -> how many DOCUMENTS that session has shown.
 *
 * Chrome REUSES backendNodeIds across documents in a tab, so after a navigation
 * a remembered uid still RESOLVES — to whatever element inherited the number.
 * In the field `[e15] link "메일"` on finance.naver.com became
 * `button "Add Element"` on the next page, and the tool's "a uid keeps pointing
 * at the same element" contract broke with no error anywhere. Namespacing uids
 * by tab+session was never enough because the reuse happens INSIDE one session;
 * the epoch is the missing component, and comparing it at resolve time is what
 * turns a silent wrong-element action into an explicit "take a fresh snapshot".
 *
 * Wiped with the worker, which is safe: refMap is module state too, so a restart
 * loses every uid before it can lose an epoch.
 */
const docEpochs = new Map();

function docKey(tabId, sessionId) {
  return `${tabId}:${sessionId || "root"}`;
}

function docEpoch(tabId, sessionId) {
  return docEpochs.get(docKey(tabId, sessionId)) || 0;
}

function bumpDocEpoch(tabId, sessionId) {
  const key = docKey(tabId, sessionId);
  docEpochs.set(key, (docEpochs.get(key) || 0) + 1);
}

/**
 * uid -> { tabId, sessionId, backendNodeId, epoch }, and its reverse index.
 * STABLE ACROSS SNAPSHOTS by design: these used to reset on every buildSnapshot, so
 * "e42" silently addressed a DIFFERENT element after any re-snapshot — on a
 * page that re-orders itself (a rolling newsstand) the agent clicked a
 * stranger and had no way to notice. Now an element keeps its uid for as long
 * as it stays in the page, a re-rendered element gets a fresh one, and a dead
 * uid fails loudly instead of resolving to whatever took its place.
 */
const refMap = new Map();
const uidByNode = new Map();
let refSeq = 0;

/**
 * nodeKey -> DOM hint for an interactive element the accessibility tree cannot
 * name (see buildDomHint). Keyed exactly like uidByNode and swept with it, so a
 * hint can never outlive its tab and get printed against a stranger. An empty
 * string means "asked, nothing useful" and is CACHED: a miss costs the same
 * round trip as a hit, and refetching it every snapshot would spend the whole
 * per-snapshot budget on the same handful of nodes.
 */
const hintByNode = new Map();

/**
 * Ceiling on remembered uids. A long-lived worker crawling many pages would
 * otherwise grow both maps without bound; past this, everything is forgotten
 * at the start of a snapshot and agents recover through the ordinary
 * unknown-uid error. `refSeq` deliberately keeps counting — reusing numbers
 * would reintroduce exactly the wrong-element bug this map exists to prevent.
 */
const REF_MAP_MAX = 30000;

/** Keyed by DOCUMENT, not just by session — see docEpochs for why. */
function nodeKey(tabId, sessionId, epoch, backendNodeId) {
  return `${tabId}:${sessionId || "root"}:${epoch}:${backendNodeId}`;
}

/** The uid for a node, minting one only the first time it is seen. */
function mintUid(tabId, sessionId, backendNodeId) {
  const epoch = docEpoch(tabId, sessionId);
  const key = nodeKey(tabId, sessionId, epoch, backendNodeId);
  const known = uidByNode.get(key);
  if (known) return known;
  const uid = `e${++refSeq}`;
  refMap.set(uid, { tabId, sessionId, backendNodeId, epoch });
  uidByNode.set(key, uid);
  return uid;
}

/** Forget one tab's elements: nothing there is addressable once it is gone. */
function forgetTabRefs(tabId) {
  for (const [uid, ref] of refMap) {
    if (ref.tabId !== tabId) continue;
    refMap.delete(uid);
    uidByNode.delete(nodeKey(ref.tabId, ref.sessionId, ref.epoch, ref.backendNodeId));
  }
  // Swept by key prefix rather than through refMap: a cached hint must go even
  // if its uid was already evicted. Tab ids are integers, so "12:" never
  // matches "123:…". Epochs share the shape, so one prefix sweeps both.
  const prefix = `${tabId}:`;
  for (const key of hintByNode.keys()) {
    if (key.startsWith(prefix)) hintByNode.delete(key);
  }
  for (const key of docEpochs.keys()) {
    if (key.startsWith(prefix)) docEpochs.delete(key);
  }
}

/**
 * tabId -> the snapshot TEXT last returned for that tab. An action that really
 * did mutate the DOM has come back with a BYTE-IDENTICAL snapshot (see
 * flushLifecycle), and identical-to-last is the only cheap signal that the read
 * was too early. One entry per GROUPED tab, dropped when the tab closes; module
 * state, so a worker restart just skips one re-poll.
 */
const lastSnapshotByTab = new Map();

/**
 * Pixel→CSS mapping of the most recent screenshot, so `click_at` can invert
 * the downscale the capture applied. Coordinates are only valid for the
 * screenshot that produced them — unlike snapshot uids there is no mint-time
 * reset, so the click_at branch re-checks tab, URL, scroll origin, and
 * viewport size at CLICK time and refuses on drift. Non-viewport modes are
 * recorded too, so the refusal can say WHY those pixels don't map onto input
 * coordinates.
 *
 * `imageWidth`/`imageHeight` are MEASURED off the returned JPEG and
 * `pxPerCssX`/`pxPerCssY` derive from them; `scale`/`pxPerCss` are the
 * theoretical factors the capture ASKED for and survive only as the fallback
 * (issue #66 — a request is not a measurement).
 */
let lastShot = null;

// ---------------------------------------------------------------- CDP plumbing

/**
 * The read_url interception surface, and the shape each call may take. sendCdp
 * refuses any of these outside a tab in `readUrlTabs`, and refuses any params
 * beyond the listed keys — a continueRequest that could rewrite the URL,
 * method, headers or body would turn a GET reader into a request forger.
 */
const READ_URL_FETCH_METHODS = new Map([
  ["Fetch.enable", ["patterns"]],
  ["Fetch.continueRequest", ["requestId"]],
  ["Fetch.failRequest", ["requestId", "errorReason"]],
  ["Fetch.takeResponseBodyAsStream", ["requestId"]],
  ["Fetch.getResponseBody", ["requestId"]],
  ["IO.read", ["handle", "size"]],
  ["IO.close", ["handle"]],
]);

/** Background tabs read_url created and is still using — the ONLY place Fetch/IO may run. */
const readUrlTabs = new Set();

function readUrlCallRefusal(target, method, params) {
  const keys = READ_URL_FETCH_METHODS.get(method);
  if (!keys) return null;
  if (!readUrlTabs.has(target?.tabId) || target?.sessionId) {
    return `${method} is restricted to read_url's own background tab`;
  }
  const extra = Object.keys(params || {}).filter((key) => !keys.includes(key));
  if (extra.length) return `${method} may not carry ${extra.join(", ")}`;
  if (method === "Fetch.enable") {
    const patterns = params?.patterns;
    if (!Array.isArray(patterns) || !patterns.every((pattern) => pattern?.resourceType === "Document")) {
      return "Fetch.enable may intercept Document requests only";
    }
  }
  return null;
}

function sendCdp(target, method, params) {
  if (!CDP_ALLOWLIST.has(method)) {
    return Promise.reject(new Error(`Method not allowed: ${method}`));
  }
  const readUrlRefusal = readUrlCallRefusal(target, method, params);
  if (readUrlRefusal) return Promise.reject(new Error(readUrlRefusal));
  // Structural bar on the no-page-JS exception: Runtime.evaluate may run ONLY
  // the two fixed, bridge-authored read_storage expressions. A call site that
  // interpolated a page/model value would be refused HERE, restoring most of the
  // structural guarantee the allowlist gave before the exception was carved out.
  if (method === "Runtime.evaluate" && !RUNTIME_EVALUATE_ALLOWED.has(params?.expression)) {
    return Promise.reject(new Error("Runtime.evaluate is restricted to the fixed read_storage expressions"));
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
  });
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      const err = chrome.runtime.lastError;
      // Already attached by us is fine; attached by another client is not.
      if (err && !/already attached/i.test(err.message || "")) reject(new Error(err.message));
      else resolve();
    });
  });
}

/**
 * Attach and turn on flat-mode auto-attach. Without setAutoAttach we never
 * learn that out-of-process iframes exist, and there is no lighter substitute:
 * getFullAXTree does not cross an OOPIF boundary.
 */
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await attachDebugger(tabId);
  attached.set(tabId, { children: new Map() });
  await sendCdp({ tabId }, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await sendCdp({ tabId }, "DOM.enable", {});
  await sendCdp({ tabId }, "Accessibility.enable", {});
  // Page powers navigation history, layout metrics and — critically — the
  // javascriptDialogOpening events the dialog tracking below depends on.
  await sendCdp({ tabId }, "Page.enable", {});
  // Required before any highlight can be SHOWN — highlightNode refuses without
  // it. Inert on its own: enabling draws nothing and changes nothing.
  await sendCdp({ tabId }, "Overlay.enable", {});
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (method !== "Target.attachedToTarget") return;
  const entry = attached.get(source.tabId);
  if (!entry || !params?.sessionId) return;
  // For an iframe target the targetId IS the frameId, and it is the only place
  // that mapping is offered: it names the document behind this session, which
  // the epoch check needs (which frameNavigated is this session's ROOT?) and
  // the frame labeller needs (which <iframe> element owns this tree?).
  entry.children.set(params.sessionId, params.targetInfo?.targetId || "");
  const child = { tabId: source.tabId, sessionId: params.sessionId };
  try {
    // Nested OOPIFs only surface if each new child also auto-attaches.
    await sendCdp(child, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await sendCdp(child, "DOM.enable", {});
    await sendCdp(child, "Accessibility.enable", {});
    // A dialog raised from inside an OOPIF surfaces on the child's session.
    await sendCdp(child, "Page.enable", {});
    // An element inside this frame is highlighted on THIS session, and the
    // enable requirement is per-session like everything else here.
    await sendCdp(child, "Overlay.enable", {});
  } catch {
    // A frame can die between attach and configure; the next snapshot re-walks.
  }
});

/**
 * A new DOCUMENT in a session's root frame retires every uid minted against the
 * old one. Only cross-document navigations fire this — an SPA route change is
 * `Page.navigatedWithinDocument`, where the ids genuinely do stay put — so the
 * epoch moves exactly when the numbering can restart underneath us.
 */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.frameNavigated" || source.tabId == null) return;
  const frameId = params?.frame?.id;
  const isSessionRoot = source.sessionId
    ? attached.get(source.tabId)?.children?.get(source.sessionId) === frameId
    : !params?.frame?.parentId;
  if (isSessionRoot) bumpDocEpoch(source.tabId, source.sessionId);
});

// Clicking Chrome's own "cancel" on the debugging banner, or any other detach,
// must drop our state rather than leave stale sessions that fail confusingly.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    attached.delete(source.tabId);
    pendingDialogs.delete(source.tabId);
    // Detached means UNOBSERVED: a navigation during the gap raises no
    // frameNavigated, so the epoch can no longer vouch for the ids minted before
    // it. Bump rather than trust — a needless "take a fresh snapshot" costs one
    // round trip, a uid that silently addresses a stranger costs the whole task.
    // Only this session's document needs it: the child sessions died with the
    // detach and their ids are not reused, so their refs already fail loudly.
    bumpDocEpoch(source.tabId, source.sessionId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  pendingDialogs.delete(tabId);
  forgetTabRefs(tabId);
  lastSnapshotByTab.delete(tabId);
  // Covers the closes the bridge did NOT do: a staging tab the user closed by
  // hand, or one abandoned on COPY_FAILED. Its return pairing is dead either way.
  forgetClipReturn(tabId);
  if (currentTabId === tabId) setCurrentTab(null);
});

// ------------------------------------------------------------------- dialogs
//
// A JavaScript dialog (alert/confirm/prompt/beforeunload) BLOCKS the renderer:
// any CDP command that needs the page — a snapshot walk, even the ack of the
// input event that triggered the dialog — hangs until it is answered. So the
// open dialog is tracked here, input sends RACE against it, and perform()
// reports the dialog instead of freezing the bridge. The user answering the
// native dialog by hand lands in javascriptDialogClosed like any other path.

/** tabId -> { type, message, defaultPrompt, target } while a dialog is open. */
const pendingDialogs = new Map();
/** tabId -> Set<wake> for in-flight input sends racing dialog-open. */
const dialogWaiters = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  if (method === "Page.javascriptDialogOpening") {
    pendingDialogs.set(source.tabId, {
      type: params?.type || "alert",
      message: params?.message || "",
      defaultPrompt: params?.defaultPrompt || "",
      // Answer on the session that raised it — an OOPIF's dialog belongs to
      // the child session, not the root.
      target: source.sessionId
        ? { tabId: source.tabId, sessionId: source.sessionId }
        : { tabId: source.tabId },
    });
    for (const wake of dialogWaiters.get(source.tabId) || []) wake();
  } else if (method === "Page.javascriptDialogClosed") {
    pendingDialogs.delete(source.tabId);
  }
});

/**
 * Await `work`, but stop waiting the moment a JS dialog opens on the tab —
 * the send that triggered it will not ack until the dialog is answered.
 */
async function raceDialogOpen(tabId, work) {
  if (pendingDialogs.has(tabId)) {
    work.catch(() => {});
    return;
  }
  let wake;
  const opened = new Promise((resolve) => {
    wake = resolve;
  });
  let waiters = dialogWaiters.get(tabId);
  if (!waiters) dialogWaiters.set(tabId, (waiters = new Set()));
  waiters.add(wake);
  try {
    await Promise.race([work, opened]);
  } finally {
    waiters.delete(wake);
    if (!waiters.size) dialogWaiters.delete(tabId);
    // When the dialog won, the blocked send settles whenever the dialog is
    // answered — keep that from becoming an unhandled rejection.
    work.catch(() => {});
  }
}

/**
 * How long `dialog_status` waits for the page to answer a read-only CDP call
 * before calling the renderer STUCK. A dialog blocks the renderer outright, so
 * an answer either comes back in a round trip or does not come back at all —
 * 800ms is generous for the first case and short enough that PROBING is cheaper
 * than the action that would otherwise hang.
 */
const DIALOG_PROBE_TIMEOUT_MS = 800;

/**
 * The same bound for the ATTACH that necessarily precedes the probe, but far
 * looser. A blocked renderer stalls `ensureAttached` too (DOM/Accessibility/Page
 * enable are all renderer-bound), and the attach is COLD in exactly the field
 * case this op exists for: the MV3 worker idles out between turns, Chrome
 * detaches with it, and the dialog opens in that gap. Without a bound the probe
 * below would never be reached. Wider than the probe because a cold attach on a
 * heavy page is legitimately slow, and calling a working page "stuck" is the one
 * wrong answer worse than saying nothing.
 */
const DIALOG_PROBE_ATTACH_TIMEOUT_MS = 3000;

/** Sentinel for "this did not answer at all", as opposed to answering an error. */
const PROBE_TIMED_OUT = { timedOut: true };

/**
 * `work`, bounded. Resolves to `{ value }`, `{ error }`, or PROBE_TIMED_OUT —
 * three answers because the whole of dialog_status rests on telling "answered
 * with an error" apart from "did not answer", and a plain try/catch collapses
 * them. The `.then().catch()` chain is attached SYNCHRONOUSLY (the same reason
 * raceDialogOpen trails a `.catch(() => {})`), so work that settles long after
 * the timeout won still has a handler and can never become an unhandled
 * rejection.
 */
function probeWithin(work, budgetMs) {
  let timer = null;
  return Promise.race([
    work.then((value) => ({ value })).catch((error) => ({ error })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(PROBE_TIMED_OUT), budgetMs);
    }),
  ]).then((outcome) => {
    if (timer !== null) clearTimeout(timer);
    return outcome;
  });
}

/** dialog_status when the page answered: nothing is blocking the renderer. */
const DIALOG_PROBE_CLEAR_NOTE =
  "No JavaScript dialog is open on this tab (the page responded to a status check just now).";

/**
 * dialog_status when the page did NOT answer. The tracked case never reaches
 * here (see the guard in performOp), so silence means a dialog this bridge never
 * saw open — or a renderer too busy to answer, which no bridge op can tell apart
 * from the outside. Both end the same way: a person has to look at the tab. The
 * budget is named rather than hardcoded because two phases can time out (the
 * attach and the probe itself) and quoting the wrong one reads as a bug.
 */
const dialogProbeStuckNote = (budgetMs) =>
  `The page did not respond to a status check within ${budgetMs}ms. That usually means a NATIVE JavaScript ` +
  "dialog opened BEFORE this bridge attached to the tab — such a dialog is invisible to the bridge and blocks " +
  "every action on the page — or the page is severely busy. Ask the user to look at the tab and dismiss any " +
  "dialog by hand; actions will keep failing until they do.";

/**
 * dialog_status when the probe came back as an ERROR rather than an answer. A
 * rejection is still the browser ANSWERING, so it is not the dialog signature
 * (that is silence) — but it is not evidence of a clear page either, and saying
 * "no dialog is open" off a failed read would be exactly the kind of confident
 * wrong answer this op exists to replace.
 */
const dialogProbeFailedNote = (error) =>
  `A status check on this tab could not be completed (${quoteForNote(String(error?.message || error), 120)}), so ` +
  "whether a JavaScript dialog is open could NOT be determined. The page did answer rather than hang, which is " +
  "NOT the signature of an open dialog; take a snapshot to see the current page state.";

/** dialog_status's non-answering result: identity only, and never a tab list. */
const dialogProbeStuckResult = (tab, budgetMs) => ({
  ok: true,
  note: dialogProbeStuckNote(budgetMs),
  url: tab.url || "",
  title: tab.title || "",
});

/** Result for "a dialog is open": everything but a snapshot, which would hang. */
async function dialogBlockedResult(tab) {
  const dialog = pendingDialogs.get(tab.id);
  return {
    ok: true,
    dialog: dialog
      ? { type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt }
      : undefined,
    url: tab.url || "",
    title: tab.title || "",
    snapshot: "",
    tabs: (await groupedTabs()).map(describeTab),
  };
}

// ------------------------------------------------------------------- scoping

/** The Noah tab group, or null when the user has not made one yet. */
async function noahGroup() {
  const groups = await chrome.tabGroups.query({ title: GROUP_TITLE });
  return groups.length ? groups[0] : null;
}

/**
 * Every tab inside the Noah group. THE scope boundary — nothing outside this
 * list is reachable, which is what keeps the agent away from the user's other
 * logged-in tabs. `chrome.tabs.query` by groupId is the only lookup used; there
 * is deliberately no path that resolves a tab by index, title, or activity.
 */
async function groupedTabs() {
  const group = await noahGroup();
  if (!group) return [];
  const tabs = await chrome.tabs.query({ groupId: group.id });
  return tabs.filter((tab) => tab.id != null);
}

const NO_TAB_MESSAGE =
  `No tab is attached. Ask the user to put the tab you should drive into a tab group named "${GROUP_TITLE}" ` +
  "(right-click a tab → add to new group → name it Noah), or open one yourself with mcp__browser__new_tab — " +
  "the user will be asked to approve creating the group. " +
  "Dragging a tab out of that group revokes access immediately.";

/**
 * Which grouped tab subsequent operations act on. Sticky so a multi-step task
 * doesn't silently hop tabs, but always re-validated against the group: if the
 * user dragged the current tab out, the pointer is stale and must not be used.
 *
 * Sticky was never the whole story: this is MV3 service-worker state, and the
 * worker idles out BETWEEN TURNS. The pointer came back null on the next turn
 * and the fallback picked tabs[0] — the OLDEST tab in the group, which is
 * typically the user's own — so a `navigate` overwrote the page they were
 * reading. The mirror in chrome.storage.session survives the worker restart and
 * dies with the browser session, which is exactly the lifetime a working tab has.
 */
let currentTabId = null;
const WORKING_TAB_KEY = "workingTabId";

/** Point at a tab (or forget one), in module state AND across worker restarts. */
function setCurrentTab(tabId) {
  currentTabId = tabId;
  // Fire and forget: the module state is already correct, and a storage failure
  // must degrade to "forgets between turns" rather than fail the operation.
  const write =
    tabId == null
      ? chrome.storage.session.remove(WORKING_TAB_KEY)
      : chrome.storage.session.set({ [WORKING_TAB_KEY]: tabId });
  Promise.resolve(write).catch(() => {});
}

async function storedTabId() {
  try {
    const stored = await chrome.storage.session.get(WORKING_TAB_KEY);
    const id = stored?.[WORKING_TAB_KEY];
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/**
 * Staging tab id -> the tab the agent was working in when it opened that
 * clipboard staging tab.
 *
 * The auto-close has to put the working pointer BACK, and by the time the copy
 * button is clicked the pre-staging id exists nowhere else: `new_tab` already
 * overwrote `currentTabId` with the staging tab. Mirrored in
 * chrome.storage.session for the same reason WORKING_TAB_KEY is — the `new_tab`
 * and the `click` are separate agent TURNS and the MV3 worker idles out between
 * them, which would otherwise turn every copy into "no previous working tab was
 * remembered". Bounded because an abandoned staging tab (COPY_FAILED, or the
 * user closing the window) leaves its entry behind until onRemoved fires.
 */
const clipStagingReturnTabs = new Map();
const CLIP_RETURN_KEY = "clipStagingReturnTabs";
const CLIP_RETURN_MAX = 20;

/**
 * Merge the session mirror in ONCE per worker life. Module entries win: within
 * one life they are the fresher truth, and the mirror exists only to survive the
 * restart between the two turns.
 */
let clipReturnsLoaded = null;
function loadClipReturns() {
  clipReturnsLoaded ??= (async () => {
    try {
      const stored = await chrome.storage.session.get(CLIP_RETURN_KEY);
      const plain = stored?.[CLIP_RETURN_KEY];
      if (!plain || typeof plain !== "object") return;
      for (const [staging, back] of Object.entries(plain)) {
        const stagingId = Number(staging);
        if (!Number.isInteger(stagingId) || typeof back !== "number") continue;
        if (!clipStagingReturnTabs.has(stagingId)) clipStagingReturnTabs.set(stagingId, back);
      }
    } catch {
      // No mirror readable = the auto-close reports "nothing remembered", which
      // is the honest answer and already one of its two shapes.
    }
  })();
  return clipReturnsLoaded;
}

/**
 * Fire and forget, exactly like setCurrentTab: module state is already correct,
 * and a storage failure must degrade to "forgets between turns" rather than fail
 * the operation. Chained after the hydrate so a write from a FRESH worker — its
 * map empty while the mirror still holds a pending pair — merges instead of
 * clobbering it.
 */
function writeClipReturns() {
  Promise.resolve(loadClipReturns())
    .then(() => {
      if (!clipStagingReturnTabs.size) return chrome.storage.session.remove(CLIP_RETURN_KEY);
      const plain = {};
      for (const [staging, back] of clipStagingReturnTabs) plain[String(staging)] = back;
      return chrome.storage.session.set({ [CLIP_RETURN_KEY]: plain });
    })
    .catch(() => {});
}

function rememberClipReturn(stagingTabId, returnTabId) {
  if (typeof stagingTabId !== "number" || typeof returnTabId !== "number") return;
  clipStagingReturnTabs.set(stagingTabId, returnTabId);
  // Insertion order, so the bound drops the STALEST pairing rather than the one
  // just made — the newest is the only one an agent is still driving.
  while (clipStagingReturnTabs.size > CLIP_RETURN_MAX) {
    clipStagingReturnTabs.delete(clipStagingReturnTabs.keys().next().value);
  }
  writeClipReturns();
}

function forgetClipReturn(stagingTabId) {
  if (!clipStagingReturnTabs.delete(stagingTabId)) return;
  writeClipReturns();
}

/** Where a closing staging tab should send the pointer, or null if unknown. */
async function clipReturnFor(stagingTabId) {
  if (!clipStagingReturnTabs.has(stagingTabId)) await loadClipReturns();
  const back = clipStagingReturnTabs.get(stagingTabId);
  return typeof back === "number" ? back : null;
}

/**
 * Wait out the staging page's own async work before its title is JUDGED — see
 * CLIP_TITLE_SETTLE_MS for the race this exists for.
 *
 * Scoped to this page alone: it is Noah's own throwaway page, so no user page
 * ever pays the wait. Returns as soon as the title is decided either way, and a
 * page that never decides answers with whatever it last held — an undecided
 * title closes nothing, which is the same answer the wait started from.
 */
async function settledClipStagingTab(staging, stagingOrigin) {
  const decided = (title) => title === CLIPBOARD_COPIED_TITLE || title === CLIPBOARD_COPY_FAILED_TITLE;
  let latest = staging;
  const deadline = Date.now() + CLIP_TITLE_SETTLE_MS;
  while (!decided(latest.title) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CLIP_TITLE_POLL_MS));
    let next;
    try {
      next = await chrome.tabs.get(staging.id);
    } catch {
      break; // Gone mid-wait: answer with the last thing actually seen.
    }
    // A page that navigated AWAY is no longer the staging page this loop may
    // judge — or close — and its new landing was never origin-checked.
    if (!isClipboardStagingUrl(next.url, stagingOrigin)) break;
    latest = next;
  }
  return latest;
}

/**
 * Close a SPENT clipboard staging tab and answer the op with the note instead of
 * a snapshot.
 *
 * Same cleanup close_tab does. The onRemoved listener does it too, but
 * asynchronously — the result built below reads state that has to be correct
 * ALREADY, so it is done here by hand rather than raced.
 */
async function closeClipStagingTab(staging, note) {
  const back = await clipReturnFor(staging.id);
  try {
    await chrome.tabs.remove(staging.id);
  } catch {
    // Already gone (the user closed it, or an earlier op did). The pointer work
    // below is still exactly what this op owes the agent, so this is not a
    // failure — nothing about the copy depended on who removed the tab.
  }
  attached.delete(staging.id);
  pendingDialogs.delete(staging.id);
  forgetTabRefs(staging.id);
  lastSnapshotByTab.delete(staging.id);
  forgetClipReturn(staging.id);
  const left = await groupedTabs();
  // Validated against the group like every other pointer here: a remembered tab
  // the user has since closed or dragged out grants nothing, and degrades to
  // "nothing remembered" rather than to a guess. targetTab's oldest-tab fallback
  // owns that case and says so out loud.
  const returnTab = back == null ? undefined : left.find((one) => one.id === back);
  setCurrentTab(returnTab ? returnTab.id : null);
  return {
    ok: true,
    // No snapshot: the tab that was acted on no longer EXISTS, and the tab the
    // pointer moved to was deliberately not read back — activating it to walk it
    // would steal the focus this file avoids stealing, for a page the agent's
    // very next op reads anyway.
    snapshot: "",
    url: returnTab?.url || "",
    title: returnTab?.title || "",
    tabs: left.map(describeTab),
    note: capNote(
      [note, clipboardCopiedNote({ title: returnTab?.title, tabId: returnTab?.id })]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

/**
 * BRIDGE-authored caveat about WHICH TAB the bridge is on, left here by
 * targetTab and drained by perform() into the result's `note`. A guess about the
 * working tab has to be visible in the same turn it is made — the field failure
 * was silent drift, not a wrong answer.
 */
let pendingTabNotice = "";

function takeTabNotice() {
  const notice = pendingTabNotice;
  pendingTabNotice = "";
  return notice;
}

async function targetTab() {
  const tabs = await groupedTabs();
  if (!tabs.length) throw new Error(NO_TAB_MESSAGE);
  if (currentTabId == null) {
    const stored = await storedTabId();
    // Validated against the group like any other pointer: a stored id whose tab
    // was closed or dragged out grants nothing.
    if (stored != null && tabs.some((tab) => tab.id === stored)) currentTabId = stored;
  }
  const picked = tabs.find((tab) => tab.id === currentTabId);
  if (picked) return picked;
  // FALLING BACK: nothing was ever chosen, or the chosen tab is gone. tabs[0] is
  // the oldest tab in the group, so with more than one candidate this is a guess
  // — and the guess is the drift itself, so it must be said out loud.
  const fallback = tabs[0];
  if (tabs.length > 1) {
    pendingTabNotice =
      `No working tab was remembered, so this operation ran on the OLDEST of the ${tabs.length} tabs in the group: ` +
      `tabId ${fallback.id}, "${quoteForNote(fallback.title || "(untitled)")}" — ` +
      `${quoteForNote(fallback.url, NOTE_URL_MAX)}. That tab may be the user's own rather than the one you were ` +
      "working in; if it is not the one you meant, call mcp__browser__list_tabs and mcp__browser__select_tab before acting further.";
  }
  setCurrentTab(fallback.id);
  return fallback;
}

/** Resolve a caller-supplied tab id, refusing anything outside the group. */
async function groupedTabById(tabId) {
  const tabs = await groupedTabs();
  if (!tabs.length) throw new Error(NO_TAB_MESSAGE);
  const found = tabs.find((tab) => String(tab.id) === String(tabId));
  if (!found) {
    throw new Error(
      `Tab ${tabId} is not in the "${GROUP_TITLE}" group. Call mcp__browser__list_tabs for the tabs you may use — ` +
        "tabs outside the group are off limits and cannot be reached by any other means.",
    );
  }
  return found;
}

function describeTab(tab) {
  return {
    tabId: String(tab.id),
    title: tab.title || "",
    url: tab.url || "",
    current: tab.id === currentTabId,
  };
}

function originAllowed(rawUrl, patterns, stagingOrigin) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  // copy_image's staging page is allowed for the Noah origin that sent THIS op
  // (sender.origin is browser-verified via externally_connectable), without the
  // operator listing Noah itself: allowlisting the app origin would make the
  // whole logged-in Noah UI drivable by an agent whose inputs include untrusted
  // page text. The test lives in axtree.js because the auto-close in the action
  // tail asks the SAME question, and two copies of "is this a staging page?"
  // would be two chances for the exemption and the close to disagree.
  if (isClipboardStagingUrl(rawUrl, stagingOrigin)) return true;
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    // `*.corp.local` matches sub.corp.local but NOT corp.local itself, so a
    // wildcard can't silently pull in the apex a operator didn't list.
    if (pattern.startsWith("*.")) return url.hostname.endsWith(pattern.slice(1));
    return url.hostname === pattern;
  });
}

function policySource(source) {
  return source === "managed"
    ? "The site is not in the administrator's browser-control policy."
    : source === "local"
      ? "The site is not in this browser's local allowlist (extension options page)."
      : "No browser-control allowlist is configured yet, so every site is denied.";
}

/**
 * The tab is not on a WEB page at all — ANOTHER extension took it over. The
 * field case is a PDF-viewer extension (Adobe's) intercepting a .pdf navigation:
 * the tab lands on `chrome-extension://…`, and calling that "not in the
 * allowlist" sent the agent hunting for a different URL to reach the same
 * document, when no allowlist change could ever help. Null when the URL is an
 * ordinary denied site, so the caller falls through to its normal refusal.
 */
function hijackRefusal(rawUrl) {
  if (!String(rawUrl || "").startsWith("chrome-extension://")) return null;
  // Worded to stay true on BOTH paths refuseOrigin serves: a tab that is already
  // sitting there, and a destination the agent asked to open. "This tab is
  // showing…" was false in the second case.
  return (
    `${rawUrl} belongs to ANOTHER browser extension — most often a PDF viewer that intercepted a PDF link. ` +
    "The bridge cannot read or drive pages inside other extensions, and this is not an allowlist decision, so no " +
    "policy change would open it. Move to an allowed http(s) URL with mcp__browser__navigate (that op works even " +
    "from a page like this) or open a fresh page with mcp__browser__new_tab; if the user was expecting a PDF, tell " +
    "them it opened in their PDF-viewer extension."
  );
}

/**
 * Surfaces `chrome.debugger` cannot attach to at all, so CDP there is not merely
 * denied — it is IMPOSSIBLE, and every command built on it is dead on arrival.
 *
 * Measured in the field, not assumed: a PDF link navigated a driven tab into
 * Adobe's viewer (`chrome-extension://…`) and Chrome force-detached us the
 * instant it committed — onDetach fired, `attached` was swept — after which
 * every re-attach came back "Cannot access a chrome-extension:// URL of
 * different extension". navigate, navigate_back and a retry failed 3-for-3 with
 * that raw error. Exempting those ops from the ORIGIN gate (see
 * ORIGIN_EXEMPT_OPS) was therefore necessary but NOT sufficient: they cleared
 * the gate and then exploded on attach. This predicate is what routes them to
 * the extension-API navigation path instead, which needs no debugger.
 *
 * Kept in sync with hijackRefusal, which explains the same situation to the
 * agent; that text promises navigation still works from here, and the escape
 * path below is what makes the promise true.
 */
const DEBUGGER_UNREACHABLE_PREFIXES = [
  "chrome-extension://",
  "chrome://",
  "devtools://",
  "edge://",
  "view-source:",
];

function debuggerUnreachable(rawUrl) {
  const url = String(rawUrl || "");
  return DEBUGGER_UNREACHABLE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/** Refusal text is model-facing: say what happened and close off the retry. */
function refuseOrigin(rawUrl, source) {
  const hijacked = hijackRefusal(rawUrl);
  if (hijacked) return { ok: false, message: hijacked };
  return {
    ok: false,
    message:
      `${policySource(source)} Blocked: ${rawUrl}. Tell the user which site was blocked and who can change it; ` +
      "do not try a different URL to reach the same content.",
  };
}

/**
 * The POST-action landing refusal, which is a different fact from the pre-action
 * one: the op RAN and the tab MOVED. Wording it like a refusal ("blocked") made
 * the agent read a completed navigation as a failure and do it again, so this
 * says what happened first and what is still possible second.
 */
function refuseLanding(op, rawUrl, source) {
  const hijacked = hijackRefusal(rawUrl);
  if (hijacked) {
    return { ok: false, message: `The ${op} itself completed, and then: ${hijacked}` };
  }
  return {
    ok: false,
    message:
      `The ${op} itself completed and the tab now sits at ${rawUrl}, which is outside the allowlist, so no page ` +
      `content is returned. ${policySource(source)} Do not repeat the ${op} — it already happened. Move on with ` +
      "mcp__browser__navigate to an allowed URL (navigation is not blocked by a denied current page), and tell the " +
      "user where the tab ended up.",
  };
}

// ------------------------------------------------- group-creation consent

/**
 * Creating the "Noah" group is what switches browser control ON in a browser
 * that has none, so it must not happen as a silent side effect of new_tab.
 * The question is asked in EXTENSION UI (a popup window): consent granted in
 * browser chrome cannot be forged, auto-clicked, or restyled by anything the
 * bridge drives. An existing group needs no prompt — its presence IS the
 * consent, and dragging tabs out remains the revocation.
 *
 * The budget is deliberately tight: the Noah client gives the whole operation
 * 40s before it reports a bridge timeout, and a confirmed new_tab still has to
 * create the tab and wait for it to load (up to 15s). 20s to answer keeps the
 * worst case inside the client's window.
 */
const CONSENT_TIMEOUT_MS = 20 * 1000;

const CONSENT_DECLINED =
  `The user declined to create the "${GROUP_TITLE}" tab group, so no tab was opened and browser control stays off. ` +
  "Do not retry — tell the user what you wanted to open and let them decide how to proceed.";
const CONSENT_UNANSWERED =
  "The user did not answer the tab-group prompt in time, so no tab was opened. " +
  "Tell the user a confirmation popup appears in their browser when you open a tab, and retry when they are ready.";

const COOKIE_CONSENT_DECLINED =
  "The user declined to share this site's cookies, so no cookies were read. " +
  "Do not retry — tell the user which site's cookies you wanted and why, and let them decide.";
const COOKIE_CONSENT_UNANSWERED =
  "The user did not answer the cookie-access prompt in time, so no cookies were read. " +
  "Tell the user a confirmation popup appears in their browser when you read cookies, and retry when they are ready.";

const STORAGE_CONSENT_DECLINED =
  "The user declined to share this site's browser storage, so no storage was read. " +
  "Do not retry — tell the user which site's storage you wanted and why, and let them decide.";
const STORAGE_CONSENT_UNANSWERED =
  "The user did not answer the storage-access prompt in time, so no storage was read. " +
  "Tell the user a confirmation popup appears in their browser when you read storage, and retry when they are ready.";

let consentSeq = 0;
/** The single in-flight consent: { token, windowId, timer, settle, declinedReason }. */
let pendingConsent = null;

function settleConsent(token, outcome) {
  if (!pendingConsent || pendingConsent.token !== token) return;
  const { windowId, timer, settle } = pendingConsent;
  pendingConsent = null;
  clearTimeout(timer);
  chrome.windows.remove(windowId).catch(() => {
    // Already closed — the user's click and our cleanup can race; both are fine.
  });
  settle(outcome);
}

/**
 * Open the single-slot consent popup and resolve with { granted, reason? }. The
 * SAME window, token-settle, timeout and decline handling serve every kind of
 * consent (tab-group creation, cookie access) — only the query the popup renders
 * and the model-facing reasons differ, so the caller passes those in.
 * `declinedReason` is stored on the pending record because the decline paths
 * (the popup's message and the window-close) fire from handlers that do not know
 * which kind of consent is open.
 */
async function openConsentPopup({
  query,
  alreadyOpenReason,
  openFailedReason,
  declinedReason,
  unansweredReason,
}) {
  if (pendingConsent) {
    return { granted: false, reason: alreadyOpenReason };
  }
  const token = String(++consentSeq);
  const page = `${chrome.runtime.getURL("consent.html")}?token=${token}&${query}`;
  let win;
  try {
    win = await chrome.windows.create({ url: page, type: "popup", width: 440, height: 400, focused: true });
  } catch (error) {
    return { granted: false, reason: openFailedReason(error) };
  }
  return new Promise((resolve) => {
    pendingConsent = {
      token,
      windowId: win.id,
      declinedReason,
      timer: setTimeout(
        () => settleConsent(token, { granted: false, reason: unansweredReason }),
        CONSENT_TIMEOUT_MS,
      ),
      settle: resolve,
    };
  });
}

/** Ask the user, in extension UI, whether to create the Noah group for `url`. */
async function requestGroupConsent(url) {
  return openConsentPopup({
    query: `url=${encodeURIComponent(url)}`,
    alreadyOpenReason:
      "A tab-group confirmation popup is already open in the user's browser. Wait for their answer instead of calling new_tab again.",
    openFailedReason: (error) =>
      `The consent popup could not be opened (${String(error?.message || error)}). Ask the user to create the ` +
      `"${GROUP_TITLE}" tab group themselves: right-click a tab → add to new group → name it ${GROUP_TITLE}.`,
    declinedReason: CONSENT_DECLINED,
    unansweredReason: CONSENT_UNANSWERED,
  });
}

/**
 * Per-browser-session, PER-DATA-TYPE consent grants. Once the user approves
 * reading a site's cookies / localStorage / sessionStorage, that exact
 * (hostname, type) pair is remembered here so the SAME site+type does not
 * re-prompt for the rest of the session — approving one type NEVER approves
 * another (sessionStorage consent leaves cookies and localStorage still gated).
 * storage.session (not local) is the deliberate store: it clears when the
 * browser closes — exactly this grant's lifetime — and it survives the MV3
 * worker idling out between turns. Shape:
 * { [key]: { cookies?: true, local?: true, session?: true, secret?: true } }.
 *
 * The KEY is the hostname for the three READ kinds, which are per site. The
 * `secret` WRITE kind is the exception: it is remembered under the sentinel
 * `SECRET_SESSION_GRANT_HOST` ("*"), so one approval covers every site the owner
 * allowed for the rest of the session (secretInput.js says why). Same store,
 * same lifetime, same revoke button — only the key differs.
 */
const DATA_GRANTS_KEY = "dataConsentGrants";

/** Type ∈ "cookies" | "local" | "session" — the popup query + consent copy per data type. */
const STORAGE_OPEN_FAILED = (error) =>
  `The storage-consent popup could not be opened (${String(error?.message || error)}), so no storage was read. ` +
  "Report this to the user rather than retrying.";
const DATA_CONSENT_COPY = {
  cookies: {
    declined: COOKIE_CONSENT_DECLINED,
    unanswered: COOKIE_CONSENT_UNANSWERED,
    openFailed: (error) =>
      `The cookie-consent popup could not be opened (${String(error?.message || error)}), so no cookies were read. ` +
      "Report this to the user rather than retrying.",
  },
  local: {
    declined: STORAGE_CONSENT_DECLINED,
    unanswered: STORAGE_CONSENT_UNANSWERED,
    openFailed: STORAGE_OPEN_FAILED,
  },
  session: {
    declined: STORAGE_CONSENT_DECLINED,
    unanswered: STORAGE_CONSENT_UNANSWERED,
    openFailed: STORAGE_OPEN_FAILED,
  },
  // The one grant kind that WRITES, and the one kind whose grant is SESSION-WIDE
  // rather than per site (key: SECRET_SESSION_GRANT_HOST). It rides the same
  // store and the same popup for the same reason the reads do: the gate has to
  // live where the server cannot reach it. But the question it asks is "may the
  // avatar type my stored secrets in this browser session?", not a per-site one
  // — the sites were already named per secret in Noah's settings and are
  // re-checked at the keyboard on every write — so one approval covers every
  // allowed site instead of interrupting again on the next login page.
  [SECRET_CONSENT_TYPE]: {
    declined: SECRET_CONSENT_DECLINED,
    unanswered: SECRET_CONSENT_UNANSWERED,
    alreadyOpen: SECRET_CONSENT_ALREADY_OPEN,
    openFailed: secretConsentOpenFailed,
  },
};

async function readDataGrants() {
  try {
    const stored = await chrome.storage.session.get(DATA_GRANTS_KEY);
    const grants = stored?.[DATA_GRANTS_KEY];
    return grants && typeof grants === "object" ? grants : {};
  } catch {
    // FAIL CLOSED: a read error must not auto-grant. Returning {} means the
    // caller finds no grant and shows the popup, exactly as a first read would.
    return {};
  }
}

async function rememberDataGrant(grantKey, type) {
  try {
    const grants = await readDataGrants();
    const forKey = grants[grantKey] && typeof grants[grantKey] === "object" ? grants[grantKey] : {};
    forKey[type] = true;
    grants[grantKey] = forKey;
    await chrome.storage.session.set({ [DATA_GRANTS_KEY]: grants });
  } catch {
    // A write failure costs only the MEMORY, never the read: the caller still
    // returns granted for this approval, and the next read simply re-prompts.
  }
}

/**
 * Ask the user, in extension UI, whether to hand THIS tab's data of the given
 * `type` (cookies incl. httpOnly session tokens, or localStorage/sessionStorage
 * incl. bearer/JWT tokens) to the avatar — or, for the `secret` kind, whether to
 * let a stored secret be typed. Consent is per DATA TYPE, per browser SESSION:
 * the first request for a (grantKey, type) prompts, and once approved that exact
 * pair is remembered (readDataGrants / rememberDataGrant) so further requests
 * skip the popup until the user revokes it or the browser closes. Still the
 * un-bypassable gate that stops a server / headless / background path from
 * reading this data without the user's live approval — a background run reaches
 * neither the popup nor a grant it never made.
 *
 * `grantKey` defaults to `host`, which is what the three READ kinds want: their
 * grant is per site. `secret` passes `SECRET_SESSION_GRANT_HOST` instead, so one
 * approval covers every allowed site for the session. The popup always receives
 * the REAL `host`, granted or not — the user answers with the actual page in
 * view; only the MEMORY is keyed differently.
 */
async function requestDataConsent(host, type, extra, grantKey = host) {
  const copy = DATA_CONSENT_COPY[type] || DATA_CONSENT_COPY.cookies;
  // Already approved this (key, type) this session → honor it with no popup.
  // A read error in readDataGrants fails closed (returns {}), so we fall through
  // to the popup rather than auto-granting; a legacy/non-object per-key value
  // likewise fails the STRICT === true check and re-prompts.
  const grants = await readDataGrants();
  if (grants[grantKey]?.[type] === true) return { granted: true };
  // `extra` is what the popup needs to say WHICH secret and WHICH kind of field
  // (the read kinds need nothing beyond the host). Encoded here, so no caller
  // can hand the popup a pre-built query string.
  const extras = Object.entries(extra || {})
    .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ""))}`)
    .join("");
  const outcome = await openConsentPopup({
    query: `kind=${type}&host=${encodeURIComponent(host)}${extras}`,
    alreadyOpenReason:
      copy.alreadyOpen ||
      "A confirmation popup is already open in the user's browser. Wait for their answer instead of retrying.",
    openFailedReason: copy.openFailed,
    declinedReason: copy.declined,
    unansweredReason: copy.unanswered,
  });
  // Remember ONLY a real approval; a decline / timeout / close records nothing,
  // so the next request for this (key, type) prompts again.
  if (outcome.granted) await rememberDataGrant(grantKey, type);
  return outcome;
}

// Internal channel only — the consent page is part of this extension. Web
// pages land on onMessageExternal instead, so no site content can answer.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "noah-group-consent") return;
  // The decline reason belongs to whichever consent is open (group vs cookies).
  // Read it BEFORE settleConsent nulls the record; the token guard inside makes
  // a stale message a no-op regardless of what we compute here.
  const declined = pendingConsent?.declinedReason || CONSENT_DECLINED;
  settleConsent(
    String(message.token),
    message.allow ? { granted: true } : { granted: false, reason: declined },
  );
});

// Closing the popup without clicking is an answer too: not granted.
chrome.windows.onRemoved.addListener((windowId) => {
  if (pendingConsent && pendingConsent.windowId === windowId) {
    settleConsent(pendingConsent.token, {
      granted: false,
      reason: pendingConsent.declinedReason || CONSENT_DECLINED,
    });
  }
});

// ------------------------------------------------------------------ snapshot

/** Ids of a target's NON-main frames — the same-process iframes, recursively. */
async function childFrameIds(target) {
  try {
    const { frameTree } = await sendCdp(target, "Page.getFrameTree", {});
    const ids = [];
    const walk = (entry) => {
      for (const child of entry?.childFrames || []) {
        if (child.frame?.id) ids.push(child.frame.id);
        walk(child);
      }
    };
    walk(frameTree);
    return ids;
  } catch {
    return [];
  }
}

/**
 * Every accessibility tree that makes up one tab's page, as
 * `{ target, frameId?, docFrameId? }` sources.
 *
 * Three kinds, and the middle one is easy to miss: `getFullAXTree` without a
 * frameId covers only the target's MAIN frame, so a SAME-process iframe
 * (a same-site widget box) rendered as an empty `Iframe "name"` line with all
 * of its content missing. Asking per frame id fills that in. Out-of-process
 * frames have their own sessions instead — their ids fail on the root session,
 * which the caller's try/continue absorbs.
 */
async function axSources(tab) {
  const entry = attached.get(tab.id);
  return [
    { target: { tabId: tab.id } },
    ...(await childFrameIds({ tabId: tab.id })).map((frameId) => ({
      target: { tabId: tab.id },
      frameId,
      docFrameId: frameId,
    })),
    // `docFrameId` names the DOCUMENT a source renders, for the frame labeller.
    // It is separate from `frameId` on purpose: `frameId` is an argument to
    // getFullAXTree (which asks the ROOT session for one of ITS frames), while an
    // OOPIF's session already IS that document and must not be asked that way.
    ...[...(entry?.children || [])].map(([sessionId, frameId]) => ({
      target: { tabId: tab.id, sessionId },
      docFrameId: frameId,
    })),
  ];
}

/**
 * Force a document lifecycle tick before reading the accessibility tree.
 *
 * Chrome updates its AXObject tree LAZILY, and nothing in the snapshot path used
 * to pump it: on an IDLE tab (no animation, no further input) getFullAXTree
 * answered from a tree that predated the DOM change the action had just made.
 * The field failure was a click on "Add Element" that reported success while the
 * new <button> stayed missing from snapshot, read_text and wait_for for many
 * seconds — intermittent only because a page with a running animation flushes
 * itself. Page.getLayoutMetrics is the cheapest ALLOWLISTED call that forces the
 * tick, which is also why screenshots and quad reads never showed this bug.
 *
 * Non-fatal by design: a mid-navigation or dying target throws here, and a
 * snapshot that skips the flush is exactly the previous behavior.
 */
async function flushLifecycle(target) {
  try {
    await sendCdp(target, "Page.getLayoutMetrics", {});
  } catch {
    // Nothing to flush (navigating, detached, closed); the walk continues.
  }
}

/**
 * Per-snapshot `f1, f2 …` labels for the child-frame trees, resolved to the
 * `<iframe>` element that OWNS each one.
 *
 * A child frame renders as its own detached `RootWebArea` block appended after
 * the main tree, and nothing said which `Iframe` line it belonged to — on a page
 * with several (naver map) there was no way to tell the search panel's frame from
 * the map's. One label rides BOTH ends: the renderer appends it to the owner's
 * line and the block gets a `frame f1:` header.
 *
 * `DOM.getFrameOwner` is read-only structure (frameId → the owning element's
 * backendNodeId), the same class as Page.getFrameTree. It is asked on the ROOT
 * target only — which is also why the map is handed to root-target renders only:
 * backendNodeIds are unique per TARGET, so an id resolved in the root process
 * names a DIFFERENT node inside an OOPIF's session, and labelling a stranger is
 * worse than labelling nothing. A frame whose owner will not resolve (a nested
 * OOPIF, a frame that died mid-walk) simply goes unlabelled.
 */
async function labelFrames(tab, sources) {
  const byOwner = new Map();
  const labelBySource = new Map();
  let seq = 0;
  for (const source of sources) {
    if (!source.docFrameId) continue;
    try {
      const { backendNodeId } = await sendCdp({ tabId: tab.id }, "DOM.getFrameOwner", {
        frameId: source.docFrameId,
      });
      if (backendNodeId == null) continue;
      const label = `f${++seq}`;
      byOwner.set(backendNodeId, label);
      labelBySource.set(source, label);
    } catch {
      // The frame is gone, or its owner lives in another process's document.
    }
  }
  return { byOwner, labelBySource };
}

/** One source's AX nodes, or null when that frame/session is not readable. */
async function sourceAxNodes(source) {
  try {
    const { nodes } = await sendCdp(source.target, "Accessibility.getFullAXTree", {
      ...(source.frameId ? { frameId: source.frameId } : {}),
    });
    return nodes || [];
  } catch {
    return null; // A frame can vanish mid-walk; the rest of the page still renders.
  }
}

/**
 * Uncached DOM-hint lookups one snapshot may spend. Each is a round trip, and a
 * page can hold dozens of unlabeled controls; the cache means later snapshots
 * pick up where this one stopped rather than re-asking about the same nodes.
 */
const HINT_FETCH_PER_SNAPSHOT = 8;

/**
 * DOM hints for the nodes in one source the AX tree could not name at all,
 * newly fetched ones bounded by `budget`. Returns the map renderAxTree prints
 * from and how much budget is left.
 */
async function collectDomHints(source, nodes, budget) {
  const hints = new Map();
  let left = budget;
  // Same document key the uids use, so a hint cached against a backendNodeId the
  // NEXT page reused cannot be printed against the stranger that inherited it.
  const epoch = docEpoch(source.target.tabId, source.target.sessionId);
  for (const backendNodeId of unlabeledInteractiveIds(nodes)) {
    const key = nodeKey(source.target.tabId, source.target.sessionId, epoch, backendNodeId);
    let hint = hintByNode.get(key);
    if (hint === undefined) {
      if (left <= 0) continue;
      left -= 1;
      hint = await buildDomHint(source.target, backendNodeId);
      hintByNode.set(key, hint);
    }
    if (hint) hints.set(backendNodeId, hint);
  }
  return { hints, left };
}

/** The uid minter bound to one source's session — every render needs one. */
function mintForSource(source) {
  return (backendNodeId) => mintUid(source.target.tabId, source.target.sessionId, backendNodeId);
}

/**
 * The header line that opens a child frame's block:
 *
 *   frame f2 [e88]: "장소 검색" — https://map.naver.com/…
 *
 * `frame f2:` alone was the whole of it, and on a page carrying seven frames
 * (naver map) only ONE of them had a visible owning `Iframe` line to tie it back
 * to — so f1–f4 named nothing an agent could recognize and offered nothing it
 * could reach. The frame's own RootWebArea answers both halves: its accessible
 * name is the frame's title, its `url` property is the document it is showing.
 *
 * The uid is the frame's ENTRY HANDLE, not decoration. Minted against the
 * DOCUMENT node, it is what `snapshot` and `read_text` scope INTO this frame by,
 * and both already resolve it without a new special case: buildScopedSnapshot
 * asks `DOM.describeNode`, which populates `frameId` on a document node as well
 * as on a frame OWNER element, so frameSourceFor matches this source and renders
 * the whole frame; read_text needs no such branch because the RootWebArea itself
 * carries this backendDOMNodeId, so its startBackendNodeId walk finds the frame
 * among the scoped sources (the session's main tree answers null and the walk
 * moves on to the frame trees).
 *
 * Every part degrades on its own: no RootWebArea leaves exactly the old line.
 */
function frameHeader(label, source, nodes) {
  const root = nodes.find((node) => node.role?.value === "RootWebArea");
  if (!root) return `frame ${label}:`;
  const uid = root.backendDOMNodeId != null ? mintForSource(source)(root.backendDOMNodeId) : null;
  const title = String(root.name?.value ?? "").trim().slice(0, 80);
  const url = String(axProp(root, "url") || "").trim().slice(0, 200);
  const identity = [title ? `"${title}"` : "", url].filter(Boolean).join(" — ");
  return `frame ${label}${uid ? ` [${uid}]` : ""}:${identity ? ` ${identity}` : ""}`;
}

/**
 * The prose that opens the AX-invisible section. It names both signals because
 * an agent reading `clickable ""` beside a DOM hint has to know it is looking at
 * something the page marked as a target, not at a guess this bridge made.
 */
const EXTRA_CLICKABLE_HEADER =
  "clickable but not in the accessibility tree (DOM click listeners / pointer cursor):";

/**
 * AX roles that are CONTAINERS a distinct control can legitimately live inside,
 * for extraClickables' nested-candidate rule. A pointer/grab tile under a
 * minted element from THIS list, covering only a slice of it, is a control of
 * its own (FullCalendar's draggable event bar inside its gridcell — the round-12
 * field case); under any other minted element it is that element's insides.
 * The Layout* spellings are what Chrome computes for non-semantic layout
 * tables, which real pages still build calendars and grids out of.
 */
const EXTRA_CONTAINER_ROLES = new Set([
  "article",
  "cell",
  "columnheader",
  "dialog",
  "feed",
  "figure",
  "grid",
  "gridcell",
  "group",
  "list",
  "listbox",
  "listitem",
  "main",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "table",
  "tabpanel",
  "toolbar",
  "treegrid",
  "LayoutTable",
  "LayoutTableCell",
  "LayoutTableRow",
]);

/**
 * How many AX-invisible clickables the SELECTION walk may collect per snapshot,
 * as distinct from EXTRA_CLICKABLE_MAX, which is what it may PRINT. Grouping
 * needs material: a 128-cell table that stops being collected at 40 can only be
 * summarized as "40 of them", which is the same lie the cap used to tell. The
 * extra collection is cheap by construction — label and hint are derived from
 * the DOMSnapshot payload already in hand, so no item costs a CDP round trip —
 * and the walk itself is bounded by EXTRA_CLICKABLE_SCAN_MAX either way.
 */
const EXTRA_CLICKABLE_COLLECT_MAX = 200;

/**
 * One summary line standing in for a run of interchangeable elements. UNMINTED
 * on purpose: only printed items get uids, exactly as under the old cap, and a
 * uid for "126 cells" would name nothing. It says what to do INSTEAD, because a
 * line the agent cannot act on has to point at one it can.
 */
const extraClickableGroupLine = (unit) =>
  `  … ${unit.count} more like the ${EXTRA_CLICKABLE_GROUP_HEAD} above (${unit.signature}) — not listed ` +
  "individually; they are the same kind of element, so act on a listed one or scope a snapshot to their container.";

/**
 * What the cap says when it truncates. This codebase does not cap silently — and
 * the way out it names has to be one that WORKS. Selection is the first
 * EXTRA_CLICKABLE_COLLECT_MAX outermost survivors in DOCUMENT order, and the only
 * viewport-sensitive rule is an AREA comparison, so scrolling moves nothing into
 * the list; a uid-scoped snapshot does not render this section at all (it is
 * built in buildSnapshot alone). That leaves the pixel route, and making the page
 * itself show fewer elements.
 *
 * `more` is the WHOLE unlisted count — what the collection walk left behind plus
 * what the print budget dropped — so between this notice and the grouped lines
 * every element that existed is accounted for.
 */
const extraClickableCut = (more) =>
  `${more} more clickable elements without an accessibility entry were not listed: this section prints at most ` +
  `${EXTRA_CLICKABLE_MAX} lines in document order, and repeated elements of the same kind are summarized into ` +
  "one grouped line instead of listed individually. Scrolling does not change which ones are listed, and a " +
  "snapshot scoped with `uid` does not include this section at all. To reach one that is missing, take " +
  "mcp__browser__screenshot and aim mcp__browser__click_at at its pixels, or make the page itself show fewer " +
  "elements (search, filter, or open one section at a time).";

/**
 * The trailing section listing clickable elements the accessibility tree has no
 * entry for — see `extraClickables` for what qualifies and why the two signals
 * are both needed.
 *
 * TWO budgets, deliberately different: the walk COLLECTS up to
 * EXTRA_CLICKABLE_COLLECT_MAX, and `groupClickableItems` then decides what is
 * worth a PRINTED line out of EXTRA_CLICKABLE_MAX of them — a run of
 * interchangeable elements collapses to one summary so the section's lines are
 * spent on distinct controls (issue #62: 128 table cells crowded out the editor
 * toolbar this section exists to surface).
 *
 * ROOT SESSION ONLY, and deliberately so for v1: same-process frames already
 * ride along in `documents[]` with backendNodeIds that are valid on the root
 * target, so they are covered for free, while an OOPIF's ids live in another id
 * space entirely and would need their own capture and their own minter.
 *
 * ANY failure returns nothing at all. This is an addition to a snapshot, never a
 * new way for one to fail — the same line scopeDomIdsOf draws.
 */
async function extraClickableLines(tab, mintedBackendIds, containerBackendIds, captured) {
  try {
    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    // The LAYOUT viewport, offset by its page origin: `layout.bounds` are
    // document coordinates, so the two only compare in the same space.
    const view = metrics.cssLayoutViewport || {};
    const viewport = {
      x: Number(view.pageX) || 0,
      y: Number(view.pageY) || 0,
      width: Number(view.clientWidth) || 0,
      height: Number(view.clientHeight) || 0,
    };
    if (!viewport.width || !viewport.height) return [];
    const documents = captured?.documents;
    const strings = captured?.strings;
    if (!Array.isArray(documents) || !Array.isArray(strings)) return [];
    const found = [];
    let more = 0;
    for (const document of documents) {
      const answer = extraClickables(document, strings, {
        mintedBackendIds,
        containerBackendIds,
        viewport,
        // The COLLECTION budget, not the print budget: grouping can only
        // summarize what it was handed, so a repeated element has to be counted
        // even when it will never get a line of its own.
        limit: EXTRA_CLICKABLE_COLLECT_MAX - found.length,
      });
      found.push(...answer.items);
      more += answer.more;
    }
    if (!found.length) return [];
    // Same minter the root sources used — mintUid, so these uids have exactly
    // the stability and lifetime of every other uid on the page, and
    // click/click_at/hover resolve them with no new branch anywhere.
    const mint = (backendNodeId) => mintUid(tab.id, undefined, backendNodeId);
    const grouped = groupClickableItems(found, EXTRA_CLICKABLE_MAX);
    const lines = [EXTRA_CLICKABLE_HEADER];
    for (const unit of grouped.units) {
      if (unit.kind === "group") {
        lines.push(extraClickableGroupLine(unit));
        continue;
      }
      const item = unit.item;
      // Only PRINTED items are minted — the same rule the cap always followed. A
      // uid for a line nobody can see is a ref that can never be resolved from a
      // snapshot, and the map would carry it until eviction.
      //
      // Selection over every document is complete by here, so recording these
      // as minted only feeds the anchor climb below — never the selection.
      mintedBackendIds.add(item.backendNodeId);
      // The hint is printed when it ADDS identity — an `#id` or a class — and
      // always when the label is empty, which is the case it exists for: one
      // `clickable ""` is indistinguishable from the next.
      const identifying = /[#.]/.test(item.hint);
      const dom = item.hint && (!item.label || identifying) ? ` (dom: ${item.hint})` : "";
      lines.push(`[${mint(item.backendNodeId)}] clickable "${item.label}"${dom}`);
    }
    // Everything unlisted, from BOTH budgets: what the collection walk never
    // reached (`more`) plus what the print budget dropped (`grouped.omitted`,
    // which already counts a cut summary as its members). Nothing may vanish
    // between them — a cap the agent cannot see is indistinguishable from the
    // element not existing.
    const cut = more + grouped.omitted;
    if (cut > 0) lines.push(extraClickableCut(cut));
    return lines;
  } catch {
    return []; // No enrichment; the snapshot is exactly what it was before.
  }
}

/**
 * Walk every attached session and merge the accessibility trees into one view,
 * returned as the ATOMS the renderers produced — one entry per element (a frame
 * header, one rendered line), some of which carry newlines of their own.
 *
 * Not joined here because capSnapshot has to see those boundaries. A GitHub blob
 * view puts a whole source file in ONE textbox value, and once the atoms were
 * flattened the only structure left was physical lines: a tightened `maxChars`
 * then kept a handful of them from the middle of that file and dropped the rest,
 * so the agent read non-contiguous source with nothing saying so. A caller that
 * wants plain text joins with "\n" itself.
 *
 * `withExtraClickables` is opted out of by ONE caller — wait_for's match loop,
 * which re-walks the page every 500ms and returns no snapshot to the agent at
 * all, so the whole-document DOMSnapshot capture behind that section would be
 * spent on the user's machine and thrown away every poll. Every other caller
 * (the settle tail after an action, the snapshot op itself) pays it ONCE per op,
 * which is what buys the freshly scrolled grid.
 *
 * `anchor` is a PIXEL-mode op's acted point, `{ backendNodeId, uid: "" }` —
 * mutated in place: `uid` becomes the uid of that node itself when this render
 * minted it, else its nearest MINTED ancestor's. The climb exists because a
 * pixel hit test answers the DEEPEST node, and a drag released on a calendar
 * cell's empty inside names an anonymous <div> no walk prints — anchoring the
 * cap there found no marker and starved the acted rows all over again.
 */
async function buildSnapshot(tab, { withExtraClickables = true, anchor = null } = {}) {
  if (refMap.size > REF_MAP_MAX) {
    refMap.clear();
    uidByNode.clear();
    hintByNode.clear();
  }
  await flushLifecycle({ tabId: tab.id });
  const sources = await axSources(tab);
  const { byOwner, labelBySource } = await labelFrames(tab, sources);
  // ONE whole-document DOMSnapshot per snapshot, shared by two consumers: the
  // AX-invisible clickable section below, and the aria-sort map — the AX tree
  // does not carry aria-sort at all (round11-facts.spec.ts), so the DOM capture
  // is the only place a sorted column header is readable from. Taken before the
  // AX walk so the render can print the flag; any failure degrades to exactly
  // the snapshot this build produced before (no section, no sort flags).
  let domCapture = null;
  if (withExtraClickables) {
    try {
      domCapture = await sendCdp({ tabId: tab.id }, "DOMSnapshot.captureSnapshot", {
        computedStyles: ["cursor"],
      });
    } catch {
      domCapture = null;
    }
  }
  let sortByDomId = null;
  for (const document of domCapture?.documents || []) {
    const found = ariaSortByBackendId(document, domCapture.strings);
    if (!found.size) continue;
    if (!sortByDomId) sortByDomId = found;
    else for (const [id, value] of found) sortByDomId.set(id, value);
  }
  const lines = [];
  /**
   * What THIS render minted on the root target, for the AX-invisible section
   * below. Recorded here rather than read back out of `uidByNode`, which
   * remembers the elements that section itself minted on the previous snapshot
   * and would therefore exclude exactly them from this one.
   */
  const mintedBackendIds = new Set();
  /**
   * Root-id-space elements whose AX role is a CONTAINER (EXTRA_CONTAINER_ROLES),
   * minted or not — extraClickables only ever consults it FOR minted ancestors,
   * so the unminted entries are inert. Collected here because the DOM capture
   * knows boxes and cursors but not roles.
   */
  const containerBackendIds = new Set();
  let hintBudget = HINT_FETCH_PER_SNAPSHOT;
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    if (!source.target.sessionId) {
      for (const node of nodes) {
        if (
          node?.backendDOMNodeId != null &&
          EXTRA_CONTAINER_ROLES.has(String(node?.role?.value || ""))
        ) {
          containerBackendIds.add(node.backendDOMNodeId);
        }
      }
    }
    const { hints, left } = await collectDomHints(source, nodes, hintBudget);
    hintBudget = left;
    const label = labelBySource.get(source);
    if (label) lines.push(frameHeader(label, source, nodes));
    const mint = mintForSource(source);
    // Only root-target ids are comparable with what DOMSnapshot returns; an
    // OOPIF's backendNodeIds mean nothing outside its own target.
    const record = source.target.sessionId
      ? mint
      : (backendNodeId) => {
          mintedBackendIds.add(backendNodeId);
          return mint(backendNodeId);
        };
    // Frame nodes ride the session that fetched them; backendNodeIds are
    // unique per target, so click/type resolve unchanged.
    lines.push(
      ...renderAxTree(
        nodes,
        record,
        hints,
        // Owner ids were resolved in the ROOT target's id space — valid for
        // every source that renders that target, meaningless in an OOPIF's.
        // Same for the sort map: DOMSnapshot backendNodeIds mean nothing
        // inside an OOPIF's own id space.
        source.target.sessionId
          ? { frameLabels: undefined }
          : { frameLabels: byOwner, sortByDomId },
      ),
    );
  }
  if (withExtraClickables && domCapture) {
    lines.push(...(await extraClickableLines(tab, mintedBackendIds, containerBackendIds, domCapture)));
  }
  if (anchor && anchor.backendNodeId != null && domCapture) {
    anchor.uid = anchorUidFor(tab, domCapture, mintedBackendIds, anchor.backendNodeId);
  }
  return lines;
}

/**
 * The uid a pixel-mode op's confirm snapshot should anchor on: the acted
 * node's own uid when this render minted it, else the nearest minted
 * ANCESTOR's, walked up the DOM capture's parentIndex. Root id space only —
 * exactly the space a viewport hit test answers in. Returns "" when the node
 * is in no captured document (it left the page, or the capture failed), which
 * simply leaves the cap unanchored as before.
 */
function anchorUidFor(tab, captured, mintedBackendIds, backendNodeId) {
  for (const document of captured?.documents || []) {
    const backendIds = document?.nodes?.backendNodeId || [];
    const parents = document?.nodes?.parentIndex || [];
    const start = backendIds.indexOf(backendNodeId);
    if (start < 0) continue;
    let at = start;
    for (let hop = 0; at >= 0 && hop < 200; hop += 1) {
      if (mintedBackendIds.has(backendIds[at])) return mintUid(tab.id, undefined, backendIds[at]);
      const parent = parents[at];
      at = typeof parent === "number" && parent >= 0 && parent !== at ? parent : -1;
    }
    return "";
  }
  return "";
}

/**
 * The source rendering the frame this element OWNS, or null when it owns none.
 *
 * The snapshot tool promises that an Iframe's uid scopes INTO that frame, and a
 * subtree walk cannot deliver it: the `<iframe>` ELEMENT and the frame's CONTENT
 * live in DIFFERENT accessibility trees. getFullAXTree stops at the frame
 * boundary (the same fact axSources exists for), so the element's subtree in the
 * parent tree is the lone `Iframe` node — scoping to it would answer one useless
 * line for the one uid an agent is most likely to scope by.
 *
 * `DOM.describeNode` settles it in a single round trip: `frameId` is populated on
 * frame OWNER elements and absent on everything else. Matching it against the
 * sources' `docFrameId` is sound from ANY session because a frameId is a
 * browser-global string — unlike the backendNodeIds `DOM.getFrameOwner` returns,
 * which only mean anything in the target that resolved them, and which would
 * therefore risk matching a stranger when the uid came from an OOPIF.
 */
async function frameSourceFor(ref, sources) {
  let frameId;
  try {
    const { node } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.describeNode",
      { backendNodeId: ref.backendNodeId },
    );
    frameId = node?.frameId;
  } catch {
    return null; // not describable — the ordinary subtree walk still applies
  }
  if (!frameId) return null;
  return sources.find((source) => source.docFrameId === frameId) || null;
}

/**
 * Ids collected while working out what a scoped read's element CONTAINS. A map
 * pane holds thousands of marker <div>s, so the ceiling sits far above
 * SUBTREE_SCAN_MAX — which is deliberately NOT reused: the obscured-click guard
 * is tuned to answer "is this ONE node under that one?" in a few hops, and
 * raising its bound would make every refused click pay for this walk.
 */
const SCOPE_DOM_IDS_MAX = 4000;

/**
 * When a scoped read counts as HOLLOW and the enrichment below is worth its
 * round trips. A scope that already rendered content is returned untouched, at
 * exactly today's cost. Atoms for the snapshot view, characters for the reading
 * view — which has no atoms, since a whole paragraph is one line there.
 */
const HOLLOW_SCOPE_ATOMS = 3;
const HOLLOW_SCOPE_TEXT_CHARS = 400;

/**
 * What a scoped read answers when the element is THERE and genuinely holds
 * nothing readable. Both scoped paths used to hand back an empty snapshot or an
 * empty string, which an agent cannot tell apart from a broken tool and which
 * offers nothing to try next — and the shape is common enough to name: the
 * covering-layer uid a refused click mints often wraps a full-viewport backdrop
 * whose readable content sits in a SIBLING layer, and a map or <canvas> surface
 * draws its content without marking any of it up. An empty answer has to say
 * which of those it is and where to look instead.
 */
const HOLLOW_SCOPE_SNAPSHOT_NOTE =
  "The element behind that uid exists but renders no readable content of its own (an empty overlay/backdrop, or a " +
  "surface that is drawn rather than marked up). Its visible content may live in a SIBLING layer: take " +
  "mcp__browser__snapshot without `uid` and look near this element, or aim mcp__browser__click_at at this uid with " +
  "xFraction/yFraction. A full mcp__browser__snapshot (no `uid`) also lists the clickable elements that have no " +
  "accessibility entry at all, which is what a drawn tile or thumbnail usually is.";

const HOLLOW_SCOPE_TEXT_NOTE =
  "The element behind that uid exists but contains no readable text of its own (an empty overlay/backdrop, or a " +
  "surface that is drawn rather than marked up). Its visible text may live in a SIBLING layer: take " +
  "mcp__browser__read_text without `uid`, or take a fresh mcp__browser__snapshot to find the element that actually " +
  "holds the content.";

/**
 * Every backendNodeId the DOM says lives INSIDE one element, shadow roots
 * included — the set that lets a hollow scoped read recover what the full walk
 * already knew about that same element.
 *
 * The field failure: `snapshot(uid=…)` on a map's `region "Map"` answered the
 * region line alone (3 characters) while the UNSCOPED snapshot printed 47
 * markers under that very uid. Two mechanisms produce that, both ordinary page
 * construction — the markers are AX nodes DETACHED from the region's childIds,
 * which the full walk only reaches through its orphan sweep and a
 * startBackendNodeId walk never reaches at all; and part of a pane can be a
 * same-process child frame, which is a different AX source entirely. Scoping
 * exists to SAVE tokens, so it must never answer less about an element than the
 * unscoped view does; the DOM is the one place that still says what belongs to
 * what.
 *
 * null on any CDP failure: this is an addition, never a new way to fail.
 */
async function scopeDomIdsOf(target, backendNodeId) {
  const root = await describeSubtree(target, backendNodeId);
  if (!root) return null;
  const ids = new Set();
  const queue = [root];
  while (queue.length && ids.size < SCOPE_DOM_IDS_MAX) {
    const node = queue.shift();
    if (typeof node?.backendNodeId === "number") ids.add(node.backendNodeId);
    for (const child of node?.children || []) queue.push(child);
    // A web component draws its content in a shadow root, and those nodes are
    // as much "inside the element" as its light children are.
    for (const shadow of node?.shadowRoots || []) queue.push(shadow);
  }
  return ids;
}

/**
 * The same-process child frames whose OWNING `<iframe>` sits inside
 * `scopeDomIds` — the documents that live INSIDE the scoped element — as
 * `{ source, nodes }` pairs ready to render.
 *
 * `DOM.getFrameOwner` is asked on the REF'S OWN session, the only id space
 * `scopeDomIds` was collected in: an owner id resolved from any other session
 * names a different node, and matching a stranger would splice an unrelated
 * frame into the answer. A frame whose owner will not resolve (a nested OOPIF, a
 * frame that died mid-walk) is simply left out — nested OOPIFs are not in scope
 * for this path.
 */
async function framesInsideScope(target, frameIds, scopeDomIds) {
  const inside = [];
  for (const frameId of frameIds) {
    let ownerId;
    try {
      ({ backendNodeId: ownerId } = await sendCdp(target, "DOM.getFrameOwner", { frameId }));
    } catch {
      continue;
    }
    if (ownerId == null || !scopeDomIds.has(ownerId)) continue;
    const source = { target, frameId };
    const nodes = await sourceAxNodes(source);
    if (nodes) inside.push({ source, nodes });
  }
  return inside;
}

/**
 * One element's subtree, rendered like a snapshot — the `uid` form of the
 * snapshot op, so following up on a search-results list or a dialog costs a few
 * hundred characters instead of re-reading the whole page. Returns ATOMS, like
 * buildSnapshot and for the same reason.
 *
 * Two shapes, because a uid can name either a piece of ONE document or the
 * BOUNDARY between two:
 *
 *   frame owner — render that frame's whole tree (see frameSourceFor).
 *   anything else — walk the subtree, mirroring buildPageText's scoped source
 *     strategy: the session that minted the uid first, then that session's
 *     same-process child frames, because an element can sit in a frame whose
 *     nodes are absent from the session's main tree. A tree that does not contain
 *     the start node answers null and the walk moves on.
 *
 * A subtree that comes back HOLLOW is then re-read against what the DOM says the
 * element contains — the detached islands and the frames living inside it (see
 * scopeDomIdsOf). Paid only on that path: a scope that already rendered content
 * returns straight away.
 *
 * Two more rungs below that, for the two ways the field showed this still ending
 * in nothing, and each one costs only the caller it saves:
 *
 *   still hollow after the enrichment — the tree in hand may simply be WRONG. A
 *     map re-creates its marker DOM continuously, so an AX fetch can land
 *     mid-rebuild and the enrichment, which re-renders that same array, has
 *     nothing to find. One flushed repoll gets a tree that does.
 *   no tree contained the start node — the element may still be ALIVE. An unnamed
 *     overlay wrapper or a rebuilding pane is absent from the AX tree while the
 *     DOM still describes it, so before declaring the uid dead the scope is swept
 *     out of the tree by DOM membership alone.
 *
 * And an answer of zero atoms is never returned bare: the element behind the uid
 * has been confirmed present by whichever rung produced it, so the op says in
 * words that it renders nothing of its own (HOLLOW_SCOPE_SNAPSHOT_NOTE) instead
 * of handing back an empty snapshot that reads as a broken tool.
 *
 * Deliberately does NOT run the REF_MAP_MAX reset buildSnapshot opens with:
 * clearing the map mid-op would evict the very uid being scoped by, and a
 * subtree mints few uids anyway.
 */
async function buildScopedSnapshot(tab, ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await flushLifecycle(target);
  const frameSource = await frameSourceFor(ref, await axSources(tab));
  if (frameSource) {
    // An OOPIF's document is a different target, so the parent's flush above did
    // nothing for it; give the tree we are about to read its own lifecycle tick.
    await flushLifecycle(frameSource.target);
    const nodes = await sourceAxNodes(frameSource);
    if (nodes) {
      const { hints } = await collectDomHints(frameSource, nodes, HINT_FETCH_PER_SNAPSHOT);
      // No startBackendNodeId: the frame's tree IS the requested scope, and
      // without one renderAxTree cannot answer null.
      return renderAxTree(nodes, mintForSource(frameSource), hints);
    }
    // Attached but unreadable this instant (navigating, dying). Fall through, so
    // the answer is at least the Iframe element rather than an outright failure.
  }
  // Held rather than re-asked: the enrichment below needs the same frame ids.
  const childIds = await childFrameIds(target);
  const sources = [{ target }, ...childIds.map((frameId) => ({ target, frameId }))];
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    const { hints } = await collectDomHints(source, nodes, HINT_FETCH_PER_SNAPSHOT);
    const mint = mintForSource(source);
    const lines = renderAxTree(nodes, mint, hints, { startBackendNodeId: ref.backendNodeId });
    if (lines === null) continue; // the start node is not in THIS tree — try the next
    if (lines.length > HOLLOW_SCOPE_ATOMS) return lines;
    const scopeDomIds = await scopeDomIdsOf(target, ref.backendNodeId);
    if (!scopeDomIds) return lines.length ? lines : [HOLLOW_SCOPE_SNAPSHOT_NOTE];
    // Re-rendered from the SAME nodes and the same hint map, so every uid the
    // first pass minted comes back identical — mintUid answers from uidByNode.
    let atoms =
      renderAxTree(nodes, mint, hints, { startBackendNodeId: ref.backendNodeId, scopeDomIds }) ||
      lines;
    if (atoms.length <= HOLLOW_SCOPE_ATOMS) {
      // The enrichment had nothing to work with, which on a LIVE surface usually
      // means the fetch caught the page mid-rebuild: a map re-creates its marker
      // DOM continuously, so the tree in hand can be missing those nodes or hold
      // them already detached, and re-rendering the SAME stale array cannot
      // recover either. One repoll of a freshly flushed tree can — and it is paid
      // only here, on a scope that has already answered nothing twice.
      await new Promise((resolve) => setTimeout(resolve, STALE_SNAPSHOT_REPOLL_MS));
      await flushLifecycle(target);
      const freshNodes = await sourceAxNodes(source);
      if (freshNodes) {
        const { hints: freshHints } = await collectDomHints(
          source,
          freshNodes,
          HINT_FETCH_PER_SNAPSHOT,
        );
        // The id set is re-asked, not reused: on the very surface this repoll
        // exists for, the wait itself outdates those backendNodeIds — the
        // rebuilt markers carry NEW ones — so sweeping a fresh tree with the old
        // set would miss exactly what the repoll came back for. The old set
        // stands in when the DOM will not answer a second time.
        const freshIds = (await scopeDomIdsOf(target, ref.backendNodeId)) || scopeDomIds;
        const retried = renderAxTree(freshNodes, mint, freshHints, {
          startBackendNodeId: ref.backendNodeId,
          scopeDomIds: freshIds,
        });
        // Whichever pass saw more of the element wins: the rebuild can be caught
        // going either way, and the repoll must never SUBTRACT from the answer.
        if (retried && retried.length > atoms.length) atoms = retried;
      }
    }
    // A frame inside the element gets the same `f1:` header treatment the full
    // walk gives one, counted locally: this view has no other frame blocks.
    let seq = 0;
    for (const inner of await framesInsideScope(target, childIds, scopeDomIds)) {
      const { hints: innerHints } = await collectDomHints(
        inner.source,
        inner.nodes,
        HINT_FETCH_PER_SNAPSHOT,
      );
      atoms.push(frameHeader(`f${++seq}`, inner.source, inner.nodes));
      atoms.push(...renderAxTree(inner.nodes, mintForSource(inner.source), innerHints));
    }
    return atoms.length ? atoms : [HOLLOW_SCOPE_SNAPSHOT_NOTE];
  }
  // No tree CONTAINED the start node — which is not the same as the element being
  // gone. An unnamed overlay wrapper or a pane caught mid-rebuild can be absent
  // from the accessibility tree while it is alive in the DOM, and the throw below
  // then tells the agent to discard a uid that still works. The DOM is the
  // referee: if it still describes a subtree, sweep the tree for the nodes that
  // belong to it instead of walking down from a start node nothing can find.
  const sweepIds = await scopeDomIdsOf(target, ref.backendNodeId);
  if (sweepIds?.size) {
    const mainSource = sources[0];
    const nodes = await sourceAxNodes(mainSource);
    if (nodes) {
      const { hints } = await collectDomHints(mainSource, nodes, HINT_FETCH_PER_SNAPSHOT);
      // No startBackendNodeId: with scopeDomIds alone the walk takes the in-scope
      // nodes as its roots, so it visits exactly them and cannot answer null.
      const atoms =
        renderAxTree(nodes, mintForSource(mainSource), hints, { scopeDomIds: sweepIds }) || [];
      let seq = 0;
      for (const inner of await framesInsideScope(target, childIds, sweepIds)) {
        const { hints: innerHints } = await collectDomHints(
          inner.source,
          inner.nodes,
          HINT_FETCH_PER_SNAPSHOT,
        );
        atoms.push(frameHeader(`f${++seq}`, inner.source, inner.nodes));
        atoms.push(...renderAxTree(inner.nodes, mintForSource(inner.source), innerHints));
      }
      // The DOM says the element is alive, so "gone from the page" is not an
      // answer this path may give — an empty sweep explains itself instead.
      return atoms.length ? atoms : [HOLLOW_SCOPE_SNAPSHOT_NOTE];
    }
  }
  throw new Error(
    "The element behind that uid is gone from the page. Take a fresh mcp__browser__snapshot without `uid` and use a current uid.",
  );
}

// -------------------------------------------------------------------- actions

function resolveRef(uid) {
  const ref = refMap.get(uid);
  if (!ref) {
    throw new Error(
      `Unknown element uid "${uid}". No current snapshot has minted it (or the extension restarted and forgot it) — take a fresh mcp__browser__snapshot and use a uid it prints.`,
    );
  }
  // The uid still RESOLVES after a navigation — that is the danger. Chrome hands
  // the new document the same backendNodeIds, so without this check the old uid
  // quietly operates on whatever inherited the number (a naver "메일" link became
  // an "Add Element" button, with no error anywhere).
  if (ref.epoch !== docEpoch(ref.tabId, ref.sessionId)) {
    throw new Error(
      `The element uid "${uid}" belongs to a PREVIOUS page in that tab — it has navigated since the snapshot that ` +
        "minted it, and uids do not survive a navigation (the browser reuses its internal node ids, so acting on this " +
        "one would hit an unrelated element). Take a fresh mcp__browser__snapshot and use a uid it prints.",
    );
  }
  return ref;
}

/**
 * CDP's ways of saying the backendNodeId no longer resolves to anything. The
 * last alternative is what DOM.scrollIntoViewIfNeeded/getContentQuads throw for
 * a node a re-render REPLACED ("Node is detached from document") — round 12's
 * map.naver.com drag leaked that raw text where every other stale uid gets the
 * re-snapshot instruction.
 */
const DEAD_NODE_MESSAGE = /no node|not found|could not find node|detached from document/i;

/**
 * Run a CDP call against a resolved ref, translating "the node is gone" into
 * an instruction. A uid that RESOLVED but whose element left the page is the
 * common case on a re-rendering site, and raw CDP text ("No node with given
 * id") tells an agent neither what happened nor what to do next.
 */
async function nodeCall(ref, work) {
  try {
    return await work();
  } catch (error) {
    const message = String(error?.message || error);
    if (!DEAD_NODE_MESSAGE.test(message)) throw error;
    const uid = uidByNode.get(nodeKey(ref.tabId, ref.sessionId, ref.epoch, ref.backendNodeId));
    throw new Error(
      `The element behind ${uid ? `uid "${uid}"` : "that uid"} is no longer in the page ` +
        "(it re-rendered or was removed). Take a fresh mcp__browser__snapshot and use a current uid.",
    );
  }
}

/** Every content quad of an element, on its OWN session, scrolled into view. */
async function quadsOf(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const { quads } = await nodeCall(ref, async () => {
    await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
    return sendCdp(target, "DOM.getContentQuads", { backendNodeId: ref.backendNodeId });
  });
  return { target, quads: quads || [] };
}

/**
 * Content quads WITHOUT the scroll `quadsOf` performs. A drag's two endpoints
 * must be measured in ONE scroll state — quadsOf's scrollIntoViewIfNeeded moves
 * the page (the round-10 torn-clip lesson), so the endpoint resolved FIRST is
 * re-read through this after the second one has settled the scroll.
 */
async function rawQuadsOf(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const { quads } = await nodeCall(ref, () =>
    sendCdp(target, "DOM.getContentQuads", { backendNodeId: ref.backendNodeId }),
  );
  return { target, quads: quads || [] };
}

/**
 * Area of one content quad. Shoelace rather than width×height: a quad is four
 * corner POINTS, and a rotated or skewed element's are not axis-aligned, so a
 * bounding box would overstate how much of the page the element really covers.
 */
function quadArea(quad) {
  let sum = 0;
  for (let i = 0; i < 8; i += 2) {
    const j = (i + 2) % 8;
    sum += quad[i] * quad[j + 1] - quad[j] * quad[i + 1];
  }
  return Math.abs(sum) / 2;
}

/**
 * Centre point of an element, via quads on the element's OWN session. `area`
 * rides along for the obstruction check below, which has to compare how much
 * surface the click target and whatever the point hit-tests to each occupy.
 */
async function centerOf(ref) {
  const { target, quads } = await quadsOf(ref);
  if (!quads.length) {
    throw new Error("The element is not visible on screen, so it cannot be clicked.");
  }
  const [x1, y1, x2, , x3, y3] = quads[0];
  return {
    target,
    x: (x1 + x3) / 2,
    y: (y1 + y3) / 2,
    width: Math.abs(x2 - x1),
    area: quadArea(quads[0]),
  };
}

/**
 * Ops whose events go through the BROWSER-side input router, which only
 * delivers to a renderer whose view is visible. A tab that sits in the group
 * but is not selected in its window is hidden, and every one of these is
 * dropped on the floor — while Input.insertText still lands, because that path
 * talks to the renderer's input method directly. That split is exactly what
 * made click and press_key look like successful no-ops.
 */
const INPUT_OPS = new Set(["click", "click_at", "drag", "type", "fill_form", "select_option", "press_key", "hover", "scroll"]);

/**
 * Ops that need the tab VISIBLE even though they dispatch no input: capturing
 * a hidden tab's surface returns stale or empty pixels, so `screenshot` rides
 * the same show-the-tab path as the input ops.
 */
const VISIBLE_OPS = new Set([...INPUT_OPS, "screenshot", "zoom"]);

/**
 * Ops that CHANGE the page, so the snapshot they return has to wait for the
 * change to land. A page's response to input is ASYNC — an autocomplete layer,
 * a menu, a validation message all arrive at least a frame after the event is
 * acknowledged — and a snapshot taken the instant the op returned showed the
 * page as it was BEFORE, so the agent concluded nothing had happened and
 * repeated the action. Read-only ops need no settle; wait_for owns its own loop.
 */
const SETTLE_OPS = new Set([...INPUT_OPS, "navigate", "navigate_back", "new_tab", "handle_dialog"]);
const ACTION_SETTLE_MS = 350;
/**
 * Second look when a settled action's snapshot came back BYTE-IDENTICAL to the
 * one before it. Chrome's AX flush can land after the lifecycle tick
 * flushLifecycle forces, and one bounded re-poll is the difference between
 * reporting "the click did nothing" and the truth.
 */
const STALE_SNAPSHOT_REPOLL_MS = 250;
/**
 * Re-poll schedule when the walk came back with NOTHING. More patient than the
 * stale re-poll above, because this is the between-documents case rather than a
 * late AX flush: the new document has to reach the point of having an
 * accessibility tree AT ALL. Spread over several short waits rather than one long
 * one, so a page only a beat behind costs a beat and a slow one still recovers.
 */
const EMPTY_SNAPSHOT_REPOLL_MS = 500;
const EMPTY_SNAPSHOT_REPOLLS = 3;
/**
 * How long an INPUT op will wait for a clipboard staging page to DECIDE its own
 * title before the auto-close judges it. The title is written only after the
 * async `navigator.clipboard.write*` promise resolves — for an image copy, after
 * the page has first fetched its bytes back from Noah — and the browser-side
 * `tab.title` follows a beat later over IPC, while the tail's
 * `chrome.tabs.get` runs milliseconds after clickPoint. The old flow never met
 * this race because the agent read the title with `list_tabs` a whole TURN
 * later; reading it in the same op does, and a stale title would return an
 * ordinary snapshot titled "클립보드로 복사" — which the guidance tells the agent to
 * read as "the copy did NOT happen". A false failure on a copy that worked.
 * Bounded, and short polls rather than one long wait so the common case (already
 * decided, or a beat behind) costs a beat.
 */
const CLIP_TITLE_SETTLE_MS = 1500;
const CLIP_TITLE_POLL_MS = 75;
/**
 * What an empty walk says about itself. An action that NAVIGATES can outrun
 * waitForLoad — a form submit or a script-driven navigation may start after
 * chrome.tabs saw the OLD document "complete", so the read lands between
 * documents and the tree is momentarily gone. Reporting that as an empty
 * snapshot is indistinguishable from a page that genuinely has nothing on it,
 * and the agent has no way to tell which it got. Field case: type(submit) into
 * naver's search box returned zero elements where the next snapshot had 532.
 */
const EMPTY_SNAPSHOT_NOTE =
  "This snapshot came back EMPTY — the page produced no accessibility tree at all. That is almost always a read " +
  "that landed BETWEEN documents (a submit or script navigation still in flight), not a blank page: take " +
  "mcp__browser__snapshot again, or mcp__browser__wait_for text you expect, before concluding anything about this " +
  "page. If a second snapshot is empty too, the document really is empty (or renders only into a canvas).";

/**
 * The snapshot op's `maxChars`, clamped. The floor keeps a request from asking
 * for a snapshot too small to hold ANY uid line — 500 still holds a handful, so
 * a confirming read ("did the button flip to [pressed]?") never comes back
 * uid-less; the ceiling is the point past which the default cap is the better
 * answer anyway. It was 2000 until 0.24.0: an agent stepping through a long task
 * pays this budget on EVERY action, and the smallest useful confirmation is a
 * few lines, not two thousand characters. The server's zod floor moves with it —
 * a wire value under the floor can still only ever SHRINK the cap, so the two
 * disagreeing would silently hand back four times what was asked for.
 *
 * Type-checked rather than coerced, for the same reason clampFraction is: an
 * omitted field arrives on the wire as `null`, and `Number(null)` is 0 — finite,
 * so a coercing version would read "not asked" as "clamp me to the floor" and
 * silently truncate every snapshot to the minimum.
 */
const SNAPSHOT_CHARS_MIN = 500;
const SNAPSHOT_CHARS_MAX = 30000;

function clampSnapshotChars(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), SNAPSHOT_CHARS_MIN), SNAPSHOT_CHARS_MAX);
}

/** Make the tab actually visible, so dispatched input reaches its renderer. */
async function showTab(tab) {
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  // A minimized window hides the view no matter which tab is selected. Restore
  // it, but never take OS focus: the user is usually in another app, and
  // stealing focus mid-task is worse than the agent working out of sight.
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") {
      await chrome.windows.update(tab.windowId, { state: "normal", focused: false });
    }
  } catch {
    // The window can close between the read and the update; the operation below
    // then fails on its own with a better message than anything invented here.
  }
}

/**
 * Force the compositor to produce one frame for a tab whose window is not in
 * the foreground, so coordinate-routed input actually lands. Live-measured
 * (VOC round 14, Windows Chrome): with the browser window fully COVERED by
 * another window, occlusion tracking marks the page hidden
 * (`document.visibilityState === "hidden"`) and frame production stops;
 * `Input.dispatchMouseEvent` then delivers mouseMoved but silently DROPS
 * mousePressed/mouseReleased — click, click_at, drag and select_option all
 * reported success while the page's own listeners counted no mousedown/mouseup
 * at all. Key events, hit tests and snapshots keep working, which made the
 * drop look like a page bug for most of a session. `showTab` cannot help: the
 * tab was already ACTIVE; it is the WINDOW that has no live surface. One
 * `Page.captureScreenshot` forces a composited frame, after which the input
 * router has current hit-test state and the very next click lands — measured
 * four out of four times in the field, and the page cannot even observe the
 * difference (visibilityState stays "hidden" throughout).
 *
 * Gated on window FOCUS rather than visibility: occlusion is not readable from
 * here (no `Runtime.*` in CDP_ALLOWLIST, no content scripts), but a focused
 * window is by definition frontmost and painting, so the warm costs nothing in
 * the watched case and is at worst wasted on a visible-but-unfocused window.
 * Full-viewport capture on purpose — cheapest encode settings, but no `clip`,
 * because a clipped capture warming less than the whole surface is a guess
 * this fix must not rest on. Fail-open throughout: a warm that cannot run must
 * not turn a maybe-dropped click into a certainly-failed op.
 */
async function ensureFrameForInput(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.focused) return;
  } catch {
    // Window unknowable (closing race): warm anyway — cheap and harmless.
  }
  try {
    await sendCdp({ tabId: tab.id }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 1,
      optimizeForSpeed: true,
    });
  } catch {
    // The op below runs against the same target and will surface a real error
    // with more context than this warm could.
  }
}

/** Dispatch a full left click (move → press → release) at a viewport point. */
async function clickPoint(target, x, y) {
  const base = { x, y, button: "left", clickCount: 1, pointerType: "mouse" };
  // Hit-testing starts from the last known pointer position, so a press with no
  // preceding move can resolve against a stale target; and `buttons` carries the
  // pressed-button bitmask that pointer-events handlers read instead of
  // `button`. Either omission yields a press the page may legitimately ignore.
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mousePressed", buttons: 1, ...base });
  await sendCdp(target, "Input.dispatchMouseEvent", { type: "mouseReleased", buttons: 0, ...base });
}

/**
 * Click an element at its centre. Deliberately UNGUARDED: select_option's
 * option-click and focusForInput's fallback both reuse it, and neither is a
 * user-requested click, so the file-input and obstruction refusals live in the
 * `click` op's own branch rather than here.
 */
async function clickNode(ref) {
  const { target, x, y } = await centerOf(ref);
  await clickPoint(target, x, y);
}

/**
 * A 0–1 position inside an element's box for click_at's uid mode. Anything
 * that is not a real number means the centre — `null` arrives on the wire
 * whenever the caller omitted the field, and Number(null) is 0, which would
 * quietly click the left edge instead.
 */
function clampFraction(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * The viewport CSS point at (xFraction, yFraction) inside an element's
 * bounding box — clamped a pixel INSIDE, so fraction 0 or 1 still lands ON the
 * element rather than on whatever owns its border. Shared by click_at's uid
 * mode and both ends of a uid-mode drag, so the two ops can never disagree
 * about where a fraction points.
 */
function boxPoint(quads, xFraction, yFraction) {
  const xs = [];
  const ys = [];
  for (const quad of quads) {
    for (let i = 0; i < quad.length; i += 2) {
      xs.push(quad[i]);
      ys.push(quad[i + 1]);
    }
  }
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  const inside = (start, span, fraction) =>
    Math.min(Math.max(start + fraction * span, start + 1), start + Math.max(span - 1, 0));
  return {
    x: inside(minX, width, clampFraction(xFraction)),
    y: inside(minY, height, clampFraction(yFraction)),
  };
}

/** Longest leg one drag move covers, px — finer steps below this. */
const DRAG_STEP_PX = 60;
/** Most interpolated moves one drag spends, however long the leg. */
const DRAG_MOVE_STEPS_MAX = 16;
/** Pause between moves, so per-frame drag handlers see motion, not a jump. */
const DRAG_STEP_PAUSE_MS = 12;

/**
 * Press at `from`, move there in interpolated steps, release at `to` — a real
 * mouse drag. `buttons: 1` rides EVERY intermediate move: that bitmask is what
 * pointer/mouse handlers read to tell a drag from a hover (the same field
 * clickPoint documents), and a press followed by a bare release with no moves
 * between them is a click, which drag handlers ignore. Interpolation matters
 * too: libraries decide "a drag has started" on a small first movement and
 * track per-frame deltas after it, so one jump to the endpoint loses them.
 *
 * NATIVE HTML5 drag-and-drop (draggable="true") rides the browser's own drag
 * controller, which mouse events do not start — Input.dispatchDragEvent could,
 * but it is not in CDP_ALLOWLIST and the JS-driven kind (canvas editors,
 * sortable lists, sliders, map pans) is what the field cases need. The tool
 * description says so rather than letting the gap read as a bug.
 */
async function dragPointer(target, from, to) {
  const base = { button: "left", pointerType: "mouse" };
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: from.x,
    y: from.y,
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: from.x,
    y: from.y,
    buttons: 1,
    clickCount: 1,
    ...base,
  });
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.min(DRAG_MOVE_STEPS_MAX, Math.max(3, Math.ceil(distance / DRAG_STEP_PX)));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await sendCdp(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      buttons: 1,
      ...base,
    });
    await new Promise((resolve) => setTimeout(resolve, DRAG_STEP_PAUSE_MS));
  }
  await sendCdp(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: to.x,
    y: to.y,
    buttons: 0,
    clickCount: 1,
    ...base,
  });
}

/**
 * Map one pixel coordinate measured on the most recent viewport screenshot to
 * the CSS point it shows — or answer WHY it cannot be, as the refusal the op
 * returns. Shared by click_at's pixel mode and both ends of a pixel-mode drag:
 * the checks (a screenshot of THIS tab, a viewport capture, inside the image,
 * page undrifted since) are the contract that makes acting on a blind
 * coordinate honest, and they must be the SAME checks wherever a screenshot
 * pixel is trusted.
 */
async function shotCssPoint(tab, x, y) {
  if (!lastShot || lastShot.tabId !== tab.id) {
    return {
      refusal: {
        ok: false,
        message:
          "No screenshot of THIS tab to take coordinates from. Take a fresh mcp__browser__screenshot of the viewport " +
          "(no uid, no fullPage) first — pixel coordinates are positions measured on that image.",
      },
    };
  }
  if (lastShot.mode !== "viewport" && lastShot.mode !== "region") {
    return {
      refusal: {
        ok: false,
        message:
          `The most recent screenshot captured ${lastShot.mode === "fullPage" ? "the full page" : "a single element"}, ` +
          "whose pixels do not map onto viewport coordinates. Take a plain viewport screenshot " +
          "(no uid, no fullPage), then pass pixel positions measured on that image.",
      },
    };
  }
  // The MEASURED bitmap is the mapping, per axis (issue #66): the model aims at
  // pixels of the image it received, so the only honest inversion is the one
  // derived from that image's real size. The theoretical `pxPerCss`
  // (scale × zoom × dsf) and then bare `scale` remain as fallbacks — for a
  // capture whose bytes could not be parsed, and for a `lastShot` written by an
  // older worker before the extension updated under us.
  const fallbackPxPerCss = lastShot.pxPerCss || lastShot.scale;
  const imageWidth = lastShot.imageWidth || Math.round(lastShot.clipWidth * fallbackPxPerCss);
  const imageHeight = lastShot.imageHeight || Math.round(lastShot.clipHeight * fallbackPxPerCss);
  const pxPerCssX = lastShot.pxPerCssX || fallbackPxPerCss;
  const pxPerCssY = lastShot.pxPerCssY || fallbackPxPerCss;
  if (x > imageWidth || y > imageHeight) {
    return {
      refusal: {
        ok: false,
        message:
          `(${x}, ${y}) is outside the most recent screenshot image (${imageWidth}×${imageHeight}px). ` +
          "Coordinates are pixel positions on that image — take a fresh viewport screenshot if the page changed.",
      },
    };
  }
  // Drift check: the mapping is only valid while the page still shows what
  // the capture showed. A scroll, resize, or navigation moves DIFFERENT
  // content under the same image pixel — and a stale image size would even
  // pass the bounds check above — so refuse rather than act on something the
  // model never saw. (±2px absorbs subpixel scroll jitter.)
  const nowMetrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
  const nowView = nowMetrics.cssVisualViewport || nowMetrics.cssLayoutViewport || {};
  // A region (zoom) capture is a window INTO the viewport: its clip is the
  // region, so the viewport size the drift check compares is stored apart.
  const viewWidth = lastShot.mode === "region" ? lastShot.viewportWidth : lastShot.clipWidth;
  const viewHeight = lastShot.mode === "region" ? lastShot.viewportHeight : lastShot.clipHeight;
  const drifted =
    (tab.url || "") !== lastShot.url ||
    Math.abs((nowView.pageX || 0) - lastShot.pageX) > 2 ||
    Math.abs((nowView.pageY || 0) - lastShot.pageY) > 2 ||
    Math.abs((nowView.clientWidth || 0) - viewWidth) > 2 ||
    Math.abs((nowView.clientHeight || 0) - viewHeight) > 2;
  if (drifted) {
    return {
      refusal: {
        ok: false,
        message:
          "The page has navigated, scrolled, or resized since that screenshot was taken, so its pixel coordinates " +
          "no longer point at the same content. Take a fresh viewport screenshot and measure the position again.",
      },
    };
  }
  // The capture mapped one CSS px of the page onto `pxPerCssX`/`pxPerCssY`
  // image px; dividing by those lands on the exact point the model saw, clamped
  // a hair inside the viewport — in CSS px, the space the input events want —
  // so an exact-edge coordinate still hits the page. The image and CSS
  // dimensions ride back with the point so the calling op can STATE the mapping
  // it used: a wrong coordinate space and a wrong aim produce the same miss,
  // and only the reported mapping tells them apart (issue #66).
  if (lastShot.mode === "region") {
    // The region's own origin, in viewport CSS px, is where image (0, 0) sits.
    // The point stays inside the REGION (the image's own bounds) and the
    // reported CSS size is the whole viewport, like a viewport capture's.
    return {
      cssX: Math.min(lastShot.regionX + x / pxPerCssX, lastShot.regionX + lastShot.clipWidth - 1, viewWidth - 1),
      cssY: Math.min(lastShot.regionY + y / pxPerCssY, lastShot.regionY + lastShot.clipHeight - 1, viewHeight - 1),
      imageWidth,
      imageHeight,
      cssWidth: viewWidth,
      cssHeight: viewHeight,
    };
  }
  return {
    cssX: Math.min(x / pxPerCssX, lastShot.clipWidth - 1),
    cssY: Math.min(y / pxPerCssY, lastShot.clipHeight - 1),
    imageWidth,
    imageHeight,
    cssWidth: lastShot.clipWidth,
    cssHeight: lastShot.clipHeight,
  };
}

/**
 * A described DOM node's attributes as an object — CDP hands them back flat.
 * Keys are lowercased: HTML already lowercases attribute names, but the axtree
 * disclosure helpers (isDisclosureTrigger / ariaExpandedOf) look attributes up
 * by lowercase name, and every reader here (attrOf, buildDomHint, renderNodeBrief)
 * asks for lowercase names too, so normalizing at the source is safe.
 */
function flatAttrs(node) {
  const attrs = {};
  const flat = node?.attributes || [];
  for (let i = 0; i + 1 < flat.length; i += 2) attrs[String(flat[i]).toLowerCase()] = flat[i + 1];
  return attrs;
}

/**
 * First non-empty text anywhere in a described subtree, so a wrapper like
 * `<button><span>Save</span></button>` still yields a label.
 */
function firstDomText(nodes) {
  for (const child of nodes || []) {
    if (child.nodeName === "#text" && (child.nodeValue || "").trim()) {
      return child.nodeValue.trim();
    }
    const nested = firstDomText(child.children);
    if (nested) return nested;
  }
  return "";
}

/** Cap for a printed DOM hint: enough to tell two controls apart, never a dump. */
const HINT_MAX_CHARS = 60;

/**
 * A short DOM identifier for an interactive element the accessibility tree
 * cannot name — the last thing that tells `[e48] button ""` from
 * `[e49] button ""` once name, value AND title are all empty. Read-only
 * (`DOM.describeNode`, already allowlisted for describePoint).
 *
 * Priority is "what a person would quote to a colleague": `#id`, else the first
 * two class tokens, else an input's `type`, else the label of the icon inside it
 * (the depth-2 subtree is already in hand, so this costs no extra round trip).
 * Any failure returns "" — a missing hint is the status quo, never an error.
 * The result is page-derived text riding inside the snapshot, which is already
 * quarantined as untrusted, so it needs no wrapper of its own.
 */
async function buildDomHint(target, backendNodeId) {
  try {
    const { node } = await sendCdp(target, "DOM.describeNode", { backendNodeId, depth: 2 });
    if (!node) return "";
    const clip = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, HINT_MAX_CHARS);
    const attrs = flatAttrs(node);
    if (attrs.id) return clip(`#${attrs.id}`);
    const classes = String(attrs.class || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (classes.length) return clip(`.${classes.join(".")}`);
    if (attrs.type) return clip(`type=${attrs.type}`);
    const findIcon = (items) => {
      for (const child of items || []) {
        const tag = String(child.nodeName || "").toLowerCase();
        if (tag === "img" || tag === "svg") return child;
        const nested = findIcon(child.children);
        if (nested) return nested;
      }
      return null;
    };
    const icon = flatAttrs(findIcon(node.children));
    const label = icon.alt || icon["aria-label"] || icon.title || firstDomText(node.children);
    return label ? clip(label) : "";
  } catch {
    return "";
  }
}

/**
 * A described DOM node rendered the way a person would point at it:
 * `<tag id="…" role="…"> "label"`. Page-derived, so it is pre-sliced here — the
 * obstruction refusal quotes it OUTSIDE the untrusted snapshot wrapper.
 */
function renderNodeBrief(node, max = 200) {
  const attrs = flatAttrs(node);
  const label =
    attrs["aria-label"] ||
    attrs.title ||
    attrs.alt ||
    attrs.placeholder ||
    firstDomText(node?.children);
  const tag = String(node?.nodeName || "?").toLowerCase();
  const id = attrs.id ? ` id="${attrs.id}"` : "";
  const role = attrs.role ? ` role="${attrs.role}"` : "";
  return `<${tag}${id}${role}>${label ? ` "${label.slice(0, 80)}"` : ""}`.slice(0, max);
}

/**
 * Best-effort description of the element at a point — the blind spot of a
 * coordinate click — as `{ text, fileInput, backendNodeId }`, or null when
 * nothing can be said about it. `fileInput` is the half a caller must ACT on
 * rather than report: a click there opens the OS file dialog (see
 * FILE_INPUT_REFUSAL). `backendNodeId` is the id this function already had to
 * fetch to answer at all, handed back so a pixel click can HIGHLIGHT what it
 * resolved to without spending a second hit test. Read-only
 * (`DOM.getNodeForLocation` + `describeNode`); any failure degrades to "no
 * description", never to a failed click. When a root-session hit test lands in
 * a cross-origin frame it resolves the <iframe> element itself, which is still
 * an honest answer.
 *
 * `target` is the session the coordinates BELONG TO ({tabId} for the root,
 * {tabId, sessionId} for a frame — both have DOM enabled: ensureAttached for
 * the tab, the auto-attach handler for each child). Asking the wrong session
 * is not a silent lie: the containment cross-check below fails and the answer
 * degrades to null.
 */
async function describePoint(target, x, y) {
  try {
    const hit = await hitNodeAt(target, x, y);
    if (!hit) return null;
    const { backendNodeId } = hit;
    const { node } = await sendCdp(target, "DOM.describeNode", { backendNodeId, depth: 2 });
    if (!node) return null;
    return { text: renderNodeBrief(node), fileInput: isFileInput(shapeOf(node)), backendNodeId };
  } catch {
    return null;
  }
}

/** True when any of an element's quads contains a viewport point (±1px slack). */
function quadsContain(quads, x, y) {
  return (quads || []).some((quad) => {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return (
      x >= Math.min(...xs) - 1 &&
      x <= Math.max(...xs) + 1 &&
      y >= Math.min(...ys) - 1 &&
      y <= Math.max(...ys) + 1
    );
  });
}

/**
 * Hit-test a VIEWPORT point and return `{ backendNodeId, quads }` only when the
 * resolved node's own geometry CONTAINS that point — the containment check is
 * what makes the answer trustworthy, and both callers (a blind click's
 * description, the obstruction guard) act on the answer, so a node that does not
 * actually sit under the point must never come back.
 *
 * Two attempts, because `DOM.getNodeForLocation` and `DOM.getContentQuads` do
 * not always agree on a coordinate space (probe-measured: on a page scrolled
 * 1000px, the hit test for a viewport point resolved the element that lives at
 * that offset in the DOCUMENT — quads said viewport, the hit test said page).
 * The first attempt asks with the viewport point as-is; when the containment
 * check rejects it, the second asks with the point translated by the current
 * scroll offset. Whichever answer's quads contain the ORIGINAL viewport point
 * is the truth; when neither does, the answer is null, never a guess.
 */
async function hitNodeAt(target, x, y) {
  // Each ask carries its OWN failure tolerance: on a scrolled page the
  // viewport-point ask does not return a wrong node, it THROWS "No node found
  // at given location" (probe-measured, headed and headless both) — and a
  // throw that escaped to the outer catch would veto the translated retry,
  // which is the ask that actually answers there.
  const ask = async (px, py) => {
    try {
      const { backendNodeId } = await sendCdp(target, "DOM.getNodeForLocation", {
        x: Math.round(px),
        y: Math.round(py),
      });
      if (!backendNodeId) return null;
      const { quads } = await sendCdp(target, "DOM.getContentQuads", { backendNodeId });
      return { backendNodeId, quads: quads || [] };
    } catch {
      return null;
    }
  };
  try {
    const direct = await ask(x, y);
    if (direct && quadsContain(direct.quads, x, y)) return direct;
    const metrics = await sendCdp(target, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const pageX = viewport.pageX || 0;
    const pageY = viewport.pageY || 0;
    if (!pageX && !pageY) return null; // unscrolled: the retry would repeat the first ask
    const scrolled = await ask(x + pageX, y + pageY);
    if (scrolled && quadsContain(scrolled.quads, x, y)) return scrolled;
    return null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------- action highlight
//
// The DevTools inspector box, drawn over the element an op is about to act on so
// the user can SEE what the avatar is touching. The browser's COMPOSITOR paints
// it: no page JS runs, the page DOM never changes, and the page cannot detect
// it — this is a display surface, not a new way to reach into a page.

/**
 * Refreshed once per op from the stored preference (top of performOp) rather
 * than read at each of the call sites below: one storage round trip per op
 * instead of one per highlighted element. Overlapping ops share this flag, which
 * is cosmetic at worst — a preference flipped mid-flight applies to the op
 * already running.
 */
let highlightActionsOn = false;

/**
 * Every `{ tabId, sessionId }` a box is currently up on, keyed like docEpochs,
 * so the op-scoped clear can take down ALL of them. A Map rather than one slot
 * because a highlight lives PER SESSION: a fill_form whose fields span two
 * OOPIF sessions draws a box in each frame, and a single last-drawn slot would
 * strand the earlier frame's box on screen for good — exactly the failure the
 * op-scoped lifetime exists to prevent. (A box drawn just before the MV3
 * worker is torn down still strands until navigation: module state dies with
 * the worker, and captureShot's pre-capture hide covers only the root session.
 * That residue is a crash path, not a designed one.)
 */
const activeHighlights = new Map();

/**
 * Green because the "Noah" tab group is green: that colour already means "the
 * avatar is working here", so the box reads as this extension's rather than as
 * something the page drew. `showInfo` off — DevTools' tooltip is inspection
 * detail, and the only question being answered here is "what is it touching?".
 */
const ACTION_HIGHLIGHT_CONFIG = {
  showInfo: false,
  contentColor: { r: 46, g: 160, b: 67, a: 0.28 },
  borderColor: { r: 46, g: 160, b: 67, a: 0.9 },
};

/**
 * Draw the box over a resolved ref. FIRE-AND-FORGET: no caller awaits it and it
 * can never throw — the same discipline the click guards follow, for the same
 * reason. This exists to SHOW the user something, so it must never invent an op
 * failure of its own. Not awaiting costs no ordering either: CDP commands on one
 * session are processed in the order they were sent, so the draw still lands
 * before the input events dispatched after it.
 */
function showActionHighlight(ref) {
  if (!highlightActionsOn) return;
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  activeHighlights.set(docKey(ref.tabId, ref.sessionId), target);
  sendCdp(target, "Overlay.highlightNode", {
    backendNodeId: ref.backendNodeId,
    highlightConfig: ACTION_HIGHLIGHT_CONFIG,
  }).catch(() => {});
}

/** Take every box down. Same fire-and-forget discipline, for the same reason. */
function clearActionHighlight() {
  for (const target of activeHighlights.values()) {
    sendCdp(target, "Overlay.hideHighlight", {}).catch(() => {});
  }
  activeHighlights.clear();
}

// ------------------------------------------------------ click-target guards

/**
 * Refusing to operate a `<input type=file>`, which the accessibility tree
 * renders as an ordinary `button "파일 선택"` with nothing marking it as a trap.
 *
 * Clicking one opens the OPERATING SYSTEM's file dialog. That dialog is browser
 * chrome — outside the renderer, so no CDP input reaches it, and modal, so the
 * window it belongs to stops answering entirely: the bridge cannot click it,
 * read it, or press Escape at it, and every later op on that tab hangs until a
 * PERSON dismisses it. There is no recovery path to offer afterwards, so the
 * only safe treatment is to never open it.
 */
const FILE_INPUT_REFUSAL =
  "This element is a FILE-UPLOAD input (<input type=file>). Clicking or operating it opens the operating " +
  "system's native file dialog, which freezes the page and cannot be closed, read, or driven by any browser " +
  "tool — only the user can dismiss it. File uploads are not supported through the bridge: ask the user to " +
  "attach the file themselves, then take a fresh snapshot and continue.";

/** A described DOM node reduced to what the guards below decide on. */
function shapeOf(node) {
  return node ? { nodeName: String(node.nodeName || "").toUpperCase(), attrs: flatAttrs(node) } : null;
}

/** One lowercased attribute of a shape, "" when absent. */
function attrOf(shape, name) {
  return String(shape?.attrs?.[name] ?? "").trim().toLowerCase();
}

/** The element itself, described shallowly — null on any failure. */
async function describeElement(ref) {
  try {
    const { node } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.describeNode",
      { backendNodeId: ref.backendNodeId, depth: 0 },
    );
    return shapeOf(node);
  } catch {
    return null;
  }
}

function isFileInput(shape) {
  return shape?.nodeName === "INPUT" && attrOf(shape, "type") === "file";
}

/** Throws on a file input; a shape that could not be read is let through. */
function assertNotFileInput(shape) {
  if (isFileInput(shape)) throw new Error(FILE_INPUT_REFUSAL);
}

/**
 * The guard the acting ops call. A describeNode failure returns SILENTLY: this
 * check exists to stop one specific trap, and letting it break ordinary clicks
 * would cost far more than the trap does.
 */
async function refuseFileInput(ref) {
  assertNotFileInput(await describeElement(ref));
}

/** Nodes walked when deciding whether one element sits inside another. */
const SUBTREE_SCAN_MAX = 500;

/** True when `backendNodeId` is somewhere under a described (pierced) subtree. */
function subtreeContains(root, backendNodeId) {
  const queue = root ? [root] : [];
  let seen = 0;
  while (queue.length && seen < SUBTREE_SCAN_MAX) {
    const node = queue.shift();
    seen += 1;
    if (node?.backendNodeId === backendNodeId) return true;
    for (const child of node?.children || []) queue.push(child);
    // A web component's real control lives in its shadow root, so a click that
    // lands there is still a click INSIDE the element that was addressed.
    for (const shadow of node?.shadowRoots || []) queue.push(shadow);
    // A same-origin iframe's document rides on the frame node as
    // `contentDocument` (pierce:true fetches it), not in `children` — without
    // this hop, a hit test that resolves the <iframe> element itself reads as
    // "not related" to the very element inside it that was addressed.
    if (node?.contentDocument) queue.push(node.contentDocument);
  }
  return false;
}

/** One pierced subtree description, or null — the walk's input. */
async function describeSubtree(target, backendNodeId) {
  try {
    const { node } = await sendCdp(target, "DOM.describeNode", {
      backendNodeId,
      depth: -1,
      pierce: true,
    });
    return node || null;
  } catch {
    return null;
  }
}

/**
 * Nodes indexed while climbing from a covering hit to its overlay layer, and
 * hops that climb may take. Neither bound is ever reached by a real page: the
 * index is a pure in-memory walk of a tree that was already fetched, and the
 * climb stops at the lowest common ancestor long before 64 layers. A TRUNCATED
 * index abandons the climb rather than using it — a partial ancestor chain would
 * stop the climb too LATE and mint an enclosing page wrapper, which is a worse
 * answer than the hit node itself.
 */
const OVERLAY_ROOT_SCAN_MAX = 20000;
const OVERLAY_ROOT_HOPS_MAX = 64;

/**
 * The overlay LAYER a covering hit belongs to: climb from the hit node while the
 * next step up is NOT an ancestor the target also has. The node that climb ends
 * on is the hit-side child of the lowest common ancestor — the covering layer as
 * a whole, rather than the piece of it the pointer happened to land on.
 *
 * Why naming the hit node is not good enough: on the-internet's /entry_ad the
 * point resolves to `<div class="underlay">`, a full-viewport EMPTY backdrop. Its
 * AX node is a childless nameless generic and its DOM subtree is exactly ONE
 * node, while the modal's heading and its "Close" control live in the SIBLING
 * `<div class="modal">`; both are children of the wrapper `<div id="modal">`. So a
 * uid minted on the backdrop makes the refusal's own escape hatch a dead end —
 * the scoped snapshot it recommends walks one generic, finds nothing to emit, and
 * comes back EMPTY (verified live). The uid has to name the layer that CONTAINS
 * the dialog, and that is the wrapper: the backdrop's parent, one step below where
 * the target's own ancestry rejoins (`body`).
 *
 * By construction the node it lands on never CONTAINS the target — the climb stops
 * before entering any ancestor they share — so the scoped snapshot the refusal
 * recommends shows the overlay, never the page behind it.
 *
 * `DOM.getDocument` is read-only structure — the same pierced node tree the
 * depth -1 `DOM.describeNode` above already returns, asked from the root rather
 * than from one element. It also hands back `nodeId`s, whose id space it
 * invalidates on every call; nothing here is affected, because every ref in this
 * file is a backendNodeId, which that reset does not touch. Every failure returns
 * `hitId`, so this can only make a refusal more useful; it is never a new way for
 * the guard to break.
 */
async function overlayRootFor(target, hitId, targetId) {
  const doc = await sendCdp(target, "DOM.getDocument", { depth: -1, pierce: true }).catch(
    () => null,
  );
  const root = doc?.root;
  if (!root) return hitId;
  const parentOf = new Map();
  const queue = [root];
  let seen = 0;
  while (queue.length) {
    if (seen >= OVERLAY_ROOT_SCAN_MAX) return hitId;
    const node = queue.shift();
    seen += 1;
    // Shadow roots ride along for the same reason subtreeContains walks them: a
    // web component's overlay draws its layers inside one.
    for (const child of [...(node?.children || []), ...(node?.shadowRoots || [])]) {
      if (typeof node?.backendNodeId === "number" && typeof child?.backendNodeId === "number") {
        parentOf.set(child.backendNodeId, node.backendNodeId);
      }
      queue.push(child);
    }
  }
  // Every hop up to the document root, which is what makes the climb below
  // terminate on a real page: both chains reach that node, so the worst case is
  // stopping at the document's own child. The has() test doubles as the loop's
  // guard — a malformed index that somehow cycles ends here instead of spinning.
  const targetAncestors = new Set();
  let up = parentOf.get(targetId);
  while (up != null && !targetAncestors.has(up)) {
    targetAncestors.add(up);
    up = parentOf.get(up);
  }
  // The target is not in this index at all (it lives in a frame document, which
  // hangs off `contentDocument` rather than `children`): nothing to climb toward.
  if (!targetAncestors.size) return hitId;
  let climbed = hitId;
  for (let hops = 0; hops < OVERLAY_ROOT_HOPS_MAX; hops += 1) {
    const parent = parentOf.get(climbed);
    if (parent == null || targetAncestors.has(parent)) break;
    climbed = parent;
  }
  return climbed;
}

/**
 * How much bigger than its target a covering element must be before the click
 * is refused. A layer that merely OVERLAPS (an icon badge, a focus ring, the
 * decorative span of a styled checkbox) is normal page construction; a modal or
 * cookie wall that swallows the click covers the viewport.
 */
const OBSCURED_AREA_RATIO = 3;

/**
 * Below this the target is not something a person aims at — it is the
 * 1×1 visually-hidden `<input>` behind a styled control, where a much larger
 * sibling label legitimately receives every click. Refusing those would break a
 * pattern that works today, and the failure this guard exists for (a real link
 * under a modal) never involves a target this small.
 */
const OBSCURED_MIN_TARGET_AREA = 100;

/**
 * Refuse a click whose target is COVERED at the point we are about to click.
 *
 * The field failure: on the-internet's /entry_ad a modal was open, a click on a
 * link underneath it navigated anyway, and the result read as a clean success —
 * a state no person could have reached, since they would have had to close the
 * modal first. Everything here is read-only (`DOM.getNodeForLocation`,
 * `DOM.describeNode`, `DOM.getContentQuads`), and every CDP failure PROCEEDS:
 * this is a guard against a specific lie, never a new way for a click to fail.
 *
 * Cheapest question first, so an ordinary click pays one hit test and a covered
 * one pays four round trips.
 *
 * The refusal MINTS the covering element a uid, because the field showed the old
 * advice was a dead end: the overlay is typically a NAMELESS <div>, so no
 * snapshot line carries it and there was nothing for the agent to name in a
 * follow-up call; Escape does not always close it (on the-internet's /entry_ad
 * the modal's own close control is a uid-less <p>); and a screenshot pixel
 * position needs a screenshot the conversation's model may not accept. A uid
 * turns all three back on — the covering layer can be snapshotted, its close
 * control clicked directly, or aimed into with uid-relative click_at, which
 * needs no vision at all.
 *
 * That uid names the covering LAYER, not the node the hit test resolved to: see
 * overlayRootFor for why the distinction is the difference between an escape
 * hatch that works and a scoped snapshot of an empty backdrop.
 */
async function assertNotObscured(ref, point) {
  const { target, area } = point;
  if (!area || area < OBSCURED_MIN_TARGET_AREA) return;
  // hitNodeAt answers only when the resolved node's own quads CONTAIN the click
  // point — the property this guard actually needs, since an element that does
  // not sit under the point cannot be covering it. The field failure was a
  // same-origin iframe's button refused as "covered" by an unrelated
  // main-document <div>: the raw hit test had resolved in a different
  // coordinate space, and nothing here noticed. A null (hit test failed, or no
  // trustworthy answer in either space) must not block the click.
  const hit = await hitNodeAt(target, point.x, point.y);
  if (!hit) return;
  const hitId = hit.backendNodeId;
  if (hitId === ref.backendNodeId) return;
  // Clicking a child of the target is the normal case: a button's inner <span>
  // is what the point actually resolves to on most real pages.
  if (subtreeContains(await describeSubtree(target, ref.backendNodeId), hitId)) return;
  let hitArea = 0;
  for (const quad of hit.quads) hitArea = Math.max(hitArea, quadArea(quad));
  if (!hitArea || hitArea <= area * OBSCURED_AREA_RATIO) return;
  // Paid only on the refusal path, because a pierced walk of a page-sized node
  // is the most expensive read here: an ANCESTOR of the target is not an
  // overlay — a <label> wrapping its input, or a card wrapping its own link,
  // receives the click on the target's behalf rather than instead of it.
  if (subtreeContains(await describeSubtree(target, hitId), ref.backendNodeId)) return;
  // The layer, not the pixel the pointer found: a uid on the backdrop half of a
  // modal is addressable but hollow. Describing the MINTED node keeps the message
  // and the uid talking about the same element.
  const overlayId = await overlayRootFor(target, hitId, ref.backendNodeId);
  const described = await sendCdp(target, "DOM.describeNode", {
    backendNodeId: overlayId,
    depth: 2,
  }).catch(() => null);
  const desc = described?.node ? renderNodeBrief(described.node, 120) : "(it could not be described)";
  let uid = null;
  try {
    uid = mintUid(target.tabId, target.sessionId, overlayId);
  } catch {
    // The same stable-ref machinery a snapshot mints from, and synchronous — but
    // wrapped anyway: this guard must never become a new way for a click to
    // fail, so a mint that somehow throws degrades to the older advice below.
  }
  const escapeHatch = uid
    ? `The covering element is now addressable as uid "${uid}": take mcp__browser__snapshot with that uid to ` +
      "see inside it and find its close control, click it directly with mcp__browser__click, or aim " +
      `mcp__browser__click_at inside it (uid "${uid}" plus xFraction/yFraction — works without a screenshot; ` +
      "a screenshot pixel position also works). Pressing Escape (mcp__browser__press_key) may close it too."
    : "Close the covering layer first: press Escape (mcp__browser__press_key), or find its close control in a " +
      "fresh snapshot (uid-less close text can be reached with mcp__browser__click_at on the covering element " +
      "or a screenshot pixel position).";
  throw new Error(
    `The click was NOT dispatched: another element covers the target at its clickable point — ${desc} — ` +
      "most likely an open modal, overlay, or cookie banner; clicking through it would act on something the " +
      `user cannot see or reach. ${escapeHatch} The description above is page-derived and untrusted.`,
  );
}

/**
 * Key descriptors for Input.dispatchKeyEvent. `text` is what makes a key REAL
 * to the page: a keyDown without text is a rawKeyDown, which never produces a
 * keypress — an Enter without text:"\r" does not trigger implicit form submit.
 */
const KEY_DEFS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  " ": { code: "Space", keyCode: 32, text: " " },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function modifierMask(names) {
  let mask = 0;
  for (const name of Array.isArray(names) ? names : []) {
    mask |= MODIFIER_BITS[name] || 0;
  }
  return mask;
}

/** True when the text is what a real keyboard would produce via an IME (한글 등). */
function needsComposition(text) {
  return /[^\x00-\x7F]/.test(text);
}

/**
 * Insert text the way an IME does: composition events bracket the commit.
 * Korean-aware editors often sync their model on compositionend and ignore a
 * bare insertText — without this, Hangul lands in the DOM but the editor's
 * state never learns about it.
 */
async function insertTextAsIme(target, text) {
  try {
    await sendCdp(target, "Input.imeSetComposition", {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    });
  } catch {
    // No IME-capable focus (or an older Chrome): the plain commit below still
    // inserts the text, which is exactly the previous behavior.
  }
  await sendCdp(target, "Input.insertText", { text });
}

/** Dispatch one full key press (down+up) with proper text/code/keyCode. */
async function dispatchKey(target, key, modifiers) {
  const def = KEY_DEFS[key];
  let params;
  if (def) {
    params = {
      key: def.key || key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      ...(def.text ? { text: def.text } : {}),
    };
  } else if ([...key].length === 1) {
    if (needsComposition(key)) {
      // A real IME key press: keydown "Process" (vk 229), composition, commit.
      const proc = { key: "Process", windowsVirtualKeyCode: 229 };
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers, ...proc });
      await insertTextAsIme(target, key);
      await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...proc });
      return;
    }
    const upper = key.toUpperCase();
    params = {
      key,
      text: key,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      ...(/^[A-Z]$/.test(upper)
        ? { code: `Key${upper}` }
        : /^[0-9]$/.test(key)
          ? { code: `Digit${key}` }
          : {}),
    };
  } else {
    throw new Error(
      `Unsupported key "${key}". Use one of ${Object.keys(KEY_DEFS)
        .filter((name) => name !== " ")
        .join(", ")}, or a single printable character.`,
    );
  }
  // With Ctrl/Alt/Meta held the press is a shortcut, not text entry.
  if (modifiers & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) {
    delete params.text;
  }
  await sendCdp(target, "Input.dispatchKeyEvent", {
    type: params.text ? "keyDown" : "rawKeyDown",
    modifiers,
    ...params,
  });
  const { text: _text, ...upParams } = params;
  await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...upParams });
}

/** The user's OS, for platform-mapped editing shortcuts (⌘A vs Ctrl+A). */
let cachedPlatformOs = null;

async function platformOs() {
  if (cachedPlatformOs !== null) return cachedPlatformOs;
  try {
    const info = await chrome.runtime.getPlatformInfo();
    cachedPlatformOs = info?.os || "";
  } catch {
    cachedPlatformOs = "";
  }
  return cachedPlatformOs;
}

/**
 * Focus an element for input, falling back to a real click when DOM.focus
 * refuses. Rich-text editors (ProseMirror bodies) and canvases often expose
 * an AX node whose DOM element is not natively focusable — a person focuses
 * them by clicking, and "Element is not focusable" was exactly how typing
 * into them failed before this fallback.
 */
async function focusForInput(ref) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  await nodeCall(ref, () =>
    sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId }),
  );
  try {
    await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });
  } catch {
    await clickNode(ref);
  }
}

/**
 * Select everything in the focused element, the way a person does AND the way
 * the editor itself does.
 *
 * The keystroke alone was not enough: on a script-controlled combobox
 * (map.naver.com's React search box) Ctrl+A silently did nothing, so the insert
 * that followed APPENDED — "광교" + "카페거리" became "광교카페거리" instead of
 * replacing. `commands: ["selectAll"]` is CDP's escape hatch into the Blink
 * editor command the shortcut would have triggered: it runs in the focused
 * element directly, without depending on our synthetic key fields being
 * interpreted by the platform keymap. The key fields stay exactly as dispatchKey
 * would have sent them so a page listening for ⌘A/Ctrl+A still sees a plausible
 * event, and the paired keyUp carries no command — an editor command runs once,
 * on the way down.
 *
 * It is NOT a guarantee, which is exactly why the read-back below exists: the
 * command still travels through the default keydown handler, so a page that
 * preventDefault()s the shortcut defeats this too (verified against one that
 * does). Selecting nothing is invisible at this layer — only reading the field
 * afterwards can tell.
 */
async function selectAllIn(target) {
  // Blink maps the select-all editing command per platform.
  const modifiers = (await platformOs()) === "mac" ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control;
  const key = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65 };
  await sendCdp(target, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers,
    ...key,
    commands: ["selectAll"],
  });
  await sendCdp(target, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...key });
}

/**
 * What the accessibility tree reports as one element's CURRENT value: one node,
 * read-only, no relatives. It exists so a clearing write can be verified instead
 * of assumed, and it answers three ways — the text, "" for a genuinely empty
 * field, or null when verification is UNAVAILABLE here (`axValueAnswer` in
 * `axtree.js` holds that decision and the reasons it is a three-way one; a null
 * from THIS layer additionally covers an older Chrome without the method, or a
 * node that just detached). See `resolveValueNode` for what to do about null.
 */
async function readAxValue(ref) {
  return axValueAnswer(await readAxNode(ref));
}

/**
 * The RAW accessibility node behind a ref — the same single read readAxValue is
 * built on, kept separate because a slider needs more than the value off it:
 * its role decides whether `type` means text at all, and `valuemin`/`valuemax`
 * are the only bounds an ARIA slider exposes. null on any failure (an older
 * Chrome without the method, a node that just detached).
 */
async function readAxNode(ref) {
  try {
    const { nodes } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "Accessibility.getPartialAXTree",
      { backendNodeId: ref.backendNodeId, fetchRelatives: false },
    );
    const list = Array.isArray(nodes) ? nodes : [];
    // Prefer the node we ASKED about; an ignored relative can ride along.
    return list.find((one) => one?.backendDOMNodeId === ref.backendNodeId) || list[0] || null;
  } catch {
    return null;
  }
}

/** DOM elements that OWN a text value the accessibility tree can report. */
const VALUE_NODE_NAMES = new Set(["INPUT", "TEXTAREA"]);
/** Nodes inspected while hunting for a field's value-bearing element. */
const VALUE_NODE_SCAN_MAX = 300;

/** True for a DOM.Node that is a text field or an explicitly editable element. */
function ownsTextValue(node) {
  if (VALUE_NODE_NAMES.has(node?.nodeName)) return true;
  // DOM.Node.attributes is a FLAT name,value,name,value… array.
  const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
  for (let i = 0; i + 1 < attributes.length; i += 2) {
    if (attributes[i] === "contenteditable" && String(attributes[i + 1]).toLowerCase() !== "false") {
      return true;
    }
  }
  return false;
}

/**
 * The ref whose AX node actually CARRIES a value, so the clear below can be
 * verified: the ref itself when it reads, otherwise its first text-field
 * descendant. The `role="combobox"` wrapper is the shape that forced this — the
 * uid an agent addresses is the wrapper, the text lives in an <input> inside it,
 * and reading the wrapper answers "nothing readable".
 *
 * Returns `{ ref, value }` (the value already read, so the caller's `before`
 * costs no second round trip), or null when NO readable node was found — which
 * every caller treats as "verification unavailable", never as "the field is empty".
 *
 * Structure only (`DOM.describeNode`, already allowed), nothing cached: a clear
 * is rare, so paying the walk beats holding ids that can go stale. Deliberately
 * does NOT descend into `contentDocument`: an iframe's input is a DIFFERENT
 * field, and verifying against the wrong field would invent failures.
 */
async function resolveValueNode(ref) {
  const own = await readAxValue(ref);
  if (own !== null) return { ref, value: own };
  let root = null;
  try {
    const described = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.describeNode",
      { backendNodeId: ref.backendNodeId, depth: -1, pierce: true },
    );
    root = described?.node || null;
  } catch {
    return null;
  }
  // Breadth-first, so the SHALLOWEST field wins on a wrapper holding several.
  const queue = root ? [root] : [];
  let seen = 0;
  while (queue.length && seen < VALUE_NODE_SCAN_MAX) {
    const node = queue.shift();
    seen += 1;
    if (node !== root && typeof node?.backendNodeId === "number" && ownsTextValue(node)) {
      const candidate = { ...ref, backendNodeId: node.backendNodeId };
      const value = await readAxValue(candidate);
      if (value !== null) return { ref: candidate, value };
    }
    for (const child of node?.children || []) queue.push(child);
    // A web component hides its real <input> in a shadow root, and the value the
    // AX tree reports lives THERE, so the walk has to reach inside.
    for (const shadow of node?.shadowRoots || []) queue.push(shadow);
  }
  return null;
}

/**
 * Code points per insert chunk, and the beat between two of them.
 *
 * Field case (issue #60): ~2.5 KB of source typed into Confluence's Monaco
 * textarea landed as its TAIL only — the HEAD was silently lost. A virtualized
 * editor does not read the DOM value; it ingests input EVENT by event and syncs
 * its own model, and one `Input.insertText` carrying thousands of characters
 * outruns that sync, so the model that finally wins holds whatever it managed to
 * take. Chunks give it a beat to ingest each piece. 1000 is under every value a
 * short write uses (so ordinary fields keep the single-call path byte for byte)
 * and small enough that a multi-KB write is several events rather than one;
 * 60ms is a frame or two — enough for an editor's own async sync, cheap enough
 * that a 10 KB write pays half a second of settles.
 */
const INSERT_CHUNK_SIZE = 1000;
const INSERT_CHUNK_SETTLE_MS = 60;

/** Enter text at the caret the way the field expects (IME for non-ASCII). */
async function insertValue(target, value) {
  // Decided ONCE, on the WHOLE value: a string with one non-ASCII character
  // anywhere must not switch input paths halfway through, or the editor sees two
  // different kinds of event for one write.
  const asIme = needsComposition(value);
  const one = (text) =>
    asIme ? insertTextAsIme(target, text) : sendCdp(target, "Input.insertText", { text });
  // Spread, not slice: cutting on UTF-16 units would split a surrogate pair and
  // hand the page half an emoji.
  const points = [...value];
  if (points.length <= INSERT_CHUNK_SIZE) return one(value);
  for (let at = 0; at < points.length; at += INSERT_CHUNK_SIZE) {
    // The same guard the keystrokes replay presses under: a change handler can
    // raise a dialog mid-write, and events queued into a frozen renderer strand
    // the whole op. The tail reports the open dialog.
    if (pendingDialogs.has(target.tabId)) return;
    await one(points.slice(at, at + INSERT_CHUNK_SIZE).join(""));
    // Between chunks only — a trailing settle would delay every caller's
    // read-back for nothing.
    if (at + INSERT_CHUNK_SIZE < points.length) {
      await new Promise((resolve) => setTimeout(resolve, INSERT_CHUNK_SETTLE_MS));
    }
  }
}

/** A page can sync its own model back into the field a beat after the events. */
const VALUE_SETTLE_MS = 150;
/** Backspaces the clearing fallback may press: a field is not a document. */
const CLEAR_BACKSPACE_MAX = 300;
/** How much of a page-derived value a bridge note may quote. */
const NOTE_VALUE_MAX = 80;
/** URLs get more room than values: a truncated one is not a URL at all. */
const NOTE_URL_MAX = 120;
/** A bridge note rides into the model turn like any other field: one paragraph. */
const NOTE_MAX = 480;

/**
 * Quote a page-derived value inside a bridge note. A note is rendered OUTSIDE
 * the untrusted wrapper, so whatever it embeds is pre-sliced here, at the source.
 */
function quoteForNote(value, max = NOTE_VALUE_MAX) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

/** Keep a note (or several, joined) inside its budget. */
function capNote(note) {
  const text = String(note || "");
  return text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX)}…` : text;
}

/** Code-point length of a read value; null when the value was unreadable. */
const codePointLen = (value) => (typeof value === "string" ? [...value].length : null);

/**
 * #64: a disclosure trigger flips its `aria-expanded` a beat AFTER the click
 * event, so the state is re-read once the page has had time to toggle it.
 */
const DISCLOSURE_SETTLE_MS = 200;

/**
 * #64 outcome notes. A menu/disclosure trigger click that did not leave the
 * menu open, split by which of the two failure modes it was — both a single
 * `aria-expanded` reading apart, and neither reported unless the DOM answered.
 */
const DISCLOSURE_NOT_OPENED_NOTE =
  'This looks like a menu/disclosure trigger but it did NOT open (aria-expanded is still not true). ' +
  'The click may have been dropped because the browser window was inactive or covered. Do NOT just click ' +
  'again — a second click TOGGLES an open menu shut. Bring the window to the foreground and retry, or focus ' +
  'the trigger and press_key "Enter" (or "ArrowDown").';
const DISCLOSURE_TOGGLED_CLOSED_NOTE =
  'This click CLOSED a menu that was already open — a disclosure trigger toggles on each click. Click once ' +
  'to open; do not double-click.';

/**
 * #65: when a paste's DISPLAYED peak is read, and when the editor has had long
 * enough to drop it again if it never committed it. Both are ms after dispatch.
 */
const PASTE_PEAK_MS = 150;
const PASTE_SETTLE_MS = 700;

/**
 * #65 notes. The advisory is the floor emitted on every paste shortcut — a
 * rich-text/iframe editor can SHOW a paste it never commits — and the vanished
 * note replaces it only on a measured grow-then-shrink (`pastedTextVanished`).
 */
const PASTE_ADVISORY_NOTE =
  "Paste dispatched. A rich-text or iframe editor (TinyMCE / contentEditable) can DISPLAY pasted text in " +
  "this snapshot without committing it to its model (issue #65). Re-read after a moment (a second " +
  "snapshot/read_text) and verify via the editor's source/markup view, or a plain <textarea> source " +
  "editor — do not trust this immediate snapshot alone.";
const PASTE_VANISHED_NOTE =
  "The pasted text APPEARED then VANISHED — the editor showed it, then dropped it without committing " +
  "(issue #65). It was NOT saved. Paste into a plain <textarea> source editor, or use the editor's " +
  "source/markup view.";

/** Read the field back once the page has had its beat to re-assert its model. */
async function settledValue(valueNode) {
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  return readAxValue(valueNode);
}

/**
 * Rewrite the whole field through the IME REPLACEMENT RANGE: compose `value`
 * over the range the old text occupies, then commit it. Depends on NEITHER a
 * selection nor a keymap — Blink's IME pipeline fires real
 * beforeinput/input events, which is what a controlled input accepts — so it is
 * the one clearing path that survives a page which consumed our ⌘A/Ctrl+A.
 * Measured against a controlled input that does exactly that
 * (`tests/visual/clear-ladder.spec.ts`): the select-all rung leaves the old
 * value, this one replaces it.
 *
 * false means the browser refused the composition (no IME-capable focus, an
 * older Chrome) — the caller falls through to the keyboard rung.
 *
 * Deliberately UNCHUNKED, unlike insertValue: a replacement range is atomic by
 * nature — it names the span it overwrites — and splitting it would turn one
 * replacement into N appends after the first.
 */
async function imeRewrite(target, value, current) {
  try {
    await sendCdp(target, "Input.imeSetComposition", {
      text: value,
      // These are DOM text offsets: UTF-16 code units, so `.length` is the count
      // Blink means. A code-point count would cut a surrogate pair in half.
      selectionStart: value.length,
      selectionEnd: value.length,
      replacementStart: 0,
      replacementEnd: String(current ?? "").length,
    });
    await sendCdp(target, "Input.insertText", { text: value });
    return true;
  } catch {
    return false;
  }
}

/** Bridge note for a clear that only succeeded after a repair. */
function repairedNote(how, after) {
  return (
    `The field's previous value resisted the standard clear and was replaced via ${how}; ` +
    `it now reads "${quoteForNote(after)}".`
  );
}

/**
 * Bridge note for a clear that VERIFIED — the old value is gone — but landed on
 * something OTHER than what was asked for.
 *
 * `clearFailed` answers one question only ("did the old value survive at an
 * end?"), so every verified end used to accept anything that was not the old
 * value: a field that rewrites input as it arrives (a phone mask, a date
 * normalizer, an autocomplete that commits its own suggestion over yours) came
 * back as a plain, silent success. Deliberately NOT a throw — that reformatting
 * is legitimate and a completed write must never be reported as failed — so the
 * caller is told what the field actually holds and decides. "" when it holds
 * exactly what was requested.
 */
function divergedNote(after, value) {
  if (String(after ?? "").trim() === String(value ?? "").trim()) return "";
  return (
    `The field now reads "${quoteForNote(after)}", which is DIFFERENT from the requested ` +
    `"${quoteForNote(value)}". If that is not just the page's own reformatting of your input, do not build ` +
    "on it — use the field's own clear control or ask the user."
  );
}

/** Compose the notes one write can produce, dropping the empty ones. */
function joinNotes(...notes) {
  return notes.filter(Boolean).join(" ");
}

/** Bridge note for a clear whose outcome cannot be read back at all. */
const UNVERIFIED_CLEAR_NOTE =
  "This element exposes no readable value, so the clear could NOT be verified — check the field's " +
  '= "…" value in the returned snapshot before relying on it.';

/**
 * Bridge note for a write into the hidden PROXY input of a custom-rendered
 * editor. Monaco (and editors built like it) route all input through a ~1px
 * offscreen textarea while the text the user sees lives in a render layer the
 * accessibility tree does not carry — so the proxy reads back "" before AND
 * after a write that actually landed. The divergedNote for that case said the
 * field "now reads ''" and told the agent not to build on it, reporting a
 * SUCCEEDED write as a failure (round 13: a clear+type that replaced the whole
 * Monaco document verified as ''). Geometry is what tells the two apart: a
 * real field that swallowed the text is visible; a proxy is a sliver.
 */
const HIDDEN_PROXY_NOTE =
  "This input reads back empty, but it is a visually hidden (~1px) element — the hidden proxy input " +
  "of a custom editor (Monaco-style), whose real text lives in a render layer this tree cannot read. " +
  "The write was dispatched and most likely landed; verify the editor's VISIBLE content with a " +
  "screenshot instead of this field's value.";

/** Sliver check for HIDDEN_PROXY_NOTE: is this element ~invisible on screen? */
async function isHiddenProxyInput(ref) {
  try {
    const { model } = await sendCdp(
      { tabId: ref.tabId, sessionId: ref.sessionId },
      "DOM.getBoxModel",
      { backendNodeId: ref.backendNodeId },
    );
    return Number(model?.width) <= 4 || Number(model?.height) <= 4;
  } catch {
    // Unmeasurable is not evidence of a proxy — fall back to the honest
    // diverged note rather than promising the write landed.
    return false;
  }
}

/**
 * Clear a field and write `value` into it — the whole of `clear: true`, and the
 * only path here that can silently do the wrong thing, so it is the only one
 * that reads the field back. Returns the bridge note the caller must relay
 * ("" when the clear verified cleanly on the first try).
 *
 * A LADDER, stopping at the first rung that verifies (order measured, not
 * assumed — `tests/visual/clear-ladder.spec.ts` has the rung × page matrix):
 *
 *   A  select-all then overtype — what a person does, one round trip. Defeated
 *      by a page that consumes the shortcut's keydown.
 *   B  IME replacement-range rewrite — no selection, no keymap.
 *   C  End, Backspace × what is ACTUALLY there, re-insert. Counted off `after`,
 *      not `before`: counting off `before` would delete the tail of what we just
 *      wrote and leave the old value in FRONT, which is the failure itself.
 *
 * Rungs A and C re-enter the value through `insert`, the way the caller entered
 * it the first time (insertText/IME, or the per-character replay), so the field
 * keeps seeing the input path it was chosen for. Rung B is deliberately its OWN
 * path — being independent of selection and keymap is the whole point — which is
 * also why it is verified like everything else and falls through to C when an
 * editor that only listens to keydown ignores it.
 *
 * EXACTLY four end states, and none of them is silent-optimistic — silence was
 * the bug: a script-controlled input appended three times running, deterministic
 * and invisible, and the tool reported success every time.
 *
 *   verified on rung A          → ""
 *   verified after B or C       → a note naming which repair ran and what the
 *                                 field now reads
 *   every rung failed           → THROW, quoting the surviving value
 *   nothing readable to verify  → rung A only (a Backspace count cannot be
 *                                 derived either), plus a note saying the clear
 *                                 is UNVERIFIED
 */
async function clearAndWrite(ref, target, value, insert) {
  const overtype = async () => {
    if (value) await insert();
    // An empty value means "empty this field" — nothing follows to overtype the
    // selection, so remove it explicitly.
    else await dispatchKey(target, "Delete", 0);
  };
  const resolved = await resolveValueNode(ref);
  if (!resolved) {
    await selectAllIn(target);
    await overtype();
    return UNVERIFIED_CLEAR_NOTE;
  }
  const { ref: valueNode, value: before } = resolved;

  // Rung A. A mid-ladder null read means the value node DETACHED under us (the
  // page re-rendered the field while we wrote into it) — verification just
  // became unavailable, which must surface as the unverified note, never as a
  // clean "": that would reopen exactly the silent end state this ladder closed.
  await selectAllIn(target);
  await overtype();
  let after = await settledValue(valueNode);
  if (after === null) return UNVERIFIED_CLEAR_NOTE;
  if (!clearFailed(before, after, value)) {
    // "" before AND "" after a non-empty write means the readback carried no
    // information at any point — when the element is also a ~1px sliver, this
    // is a custom editor's hidden proxy input, not a failed write (see
    // HIDDEN_PROXY_NOTE). Checked only on this already-diverged path, so the
    // extra CDP read costs nothing on ordinary fields.
    if (
      value &&
      String(before ?? "") === "" &&
      String(after ?? "") === "" &&
      (await isHiddenProxyInput(valueNode))
    ) {
      return HIDDEN_PROXY_NOTE;
    }
    return divergedNote(after, value);
  }

  // Rung B.
  if (await imeRewrite(target, value, after)) {
    after = await settledValue(valueNode);
    if (after === null) return UNVERIFIED_CLEAR_NOTE;
    if (!clearFailed(before, after, value)) {
      return joinNotes(repairedNote("ime-rewrite", after), divergedNote(after, value));
    }
  }

  // Rung C.
  await dispatchKey(target, "End", 0);
  // Code points, not UTF-16 units: over-counting is harmless (Backspace on an
  // empty field is a no-op), under-counting would leave the old value behind.
  const presses = Math.min([...String(after ?? "")].length, CLEAR_BACKSPACE_MAX);
  for (let i = 0; i < presses; i += 1) {
    // Frozen renderer mid-erase. The op tail reports the open dialog instead of
    // a snapshot, so there is nothing this note could usefully add.
    if (pendingDialogs.has(ref.tabId)) return "";
    await dispatchKey(target, "Backspace", 0);
  }
  if (value) await insert();
  after = await settledValue(valueNode);
  if (after === null) return UNVERIFIED_CLEAR_NOTE;
  if (!clearFailed(before, after, value)) {
    return joinNotes(repairedNote("keyboard-erase", after), divergedNote(after, value));
  }

  throw new Error(
    `Clearing this field did not take: the page rewrote its value (it now reads "${quoteForNote(after, 120)}"). ` +
      "This input is script-controlled: a select-all overtype, an IME replacement-range rewrite, and erasing " +
      "it key by key were all tried, and the old value came back each time. Click the field's own clear (X) " +
      "control from the snapshot if it has one, or ask the user to clear it.",
  );
}

// ---------------------------------------------------------------- secret input
//
// Typing a STORED SECRET (설정 → 권한·연결 → 시크릿 → 브라우저 입력) into a page.
// The model names the secret, the server resolves it, and the plaintext reaches
// this worker on `secretText` / `secretValue` — never on `text`/`value`, so a
// build that predates this feature types NOTHING rather than typing a credential
// unguarded.
//
// Everything below exists because the model, which chose the target, may itself
// be acting on text a PAGE fed it. So the policy that rides with the value is
// re-checked at the keyboard, in this order, before a single key is sent:
//
//   1. the TAB's hostname must be on the secret's allowlist (exact match);
//   2. the DOCUMENT the element actually lives in must be too — a page on an
//      allowed host can embed a login form from anywhere, and the tab URL says
//      nothing about who would receive the keystrokes;
//   3. with `passwordOnly` (the default) the target must be a real
//      `<input type=password>`;
//   4. the user must approve, in a popup this side of the wire, the first time a
//      secret is typed in this browser SESSION — once, for every allowed site,
//      not once per site (the sites were already chosen per secret in Noah's
//      settings, and rule 1 re-checks them at the keyboard on every write). The
//      grant is remembered under SECRET_SESSION_GRANT_HOST, revocable in the
//      options page, and gone when the browser closes.
//
// The shape check sits AHEAD of the popup deliberately. The popup names the
// field kind it is asking about ("비밀번호 필드"), so prompting and THEN refusing
// because the target was never a password input asks the user a question about
// a write that could not happen — and an approval leaves a session grant behind
// for it, now a session-WIDE one. The check is one depth-0 describeNode and
// depends on nothing the consent decides, so it is free to run first.
//
// And the write itself is deliberately NARROWER than the ordinary one: no rung
// of the clearing ladder runs, nothing is quoted, and verification is by LENGTH
// against a read-back that Chromium already masks (one `•` per character —
// `tests/visual/password-facts.spec.ts`). The pure decisions and every string
// live in `secretInput.js`.

/**
 * The URL of the DOCUMENT one element lives in, or null when that cannot be
 * established. Fail-closed by construction: every failure answers null, and the
 * caller refuses on null.
 *
 * Two routes, and using the wrong one is a real bypass rather than an
 * inaccuracy (all of this is measured in `tests/visual/password-facts.spec.ts`):
 *
 *   OOPIF (`ref.sessionId`) — a cross-site frame renders in its OWN process, and
 *     backendNodeIds are per-PROCESS: the id of a node inside it also names an
 *     unrelated node in the top document. Attributing it through the root target
 *     would answer with the TOP page's URL — precisely the host the secret IS
 *     allowed on. So it is asked of its own session, which simply IS that
 *     document.
 *   Root session — the only other documents a root-session node can be in are
 *     the same-process child frames the root frame tree lists. None of those and
 *     the answer is the main frame, which is the ordinary login page and costs
 *     nothing. Otherwise ONE `DOMSnapshot.captureSnapshot` attributes every node
 *     in the target to its own document.
 *
 * Only `documentURL` is read off that capture. Its `inputValue` column carries
 * field values in PLAINTEXT (measured — it is why a snapshot must never render
 * it), so nothing else from the response may be touched, logged, or returned.
 */
async function refDocumentUrl(ref) {
  if (ref.sessionId) {
    try {
      const { frameTree } = await sendCdp(
        { tabId: ref.tabId, sessionId: ref.sessionId },
        "Page.getFrameTree",
        {},
      );
      return String(frameTree?.frame?.url || "") || null;
    } catch {
      return null;
    }
  }
  try {
    const { frameTree } = await sendCdp({ tabId: ref.tabId }, "Page.getFrameTree", {});
    if (!(frameTree?.childFrames || []).length) return String(frameTree?.frame?.url || "") || null;
  } catch {
    return null;
  }
  try {
    const snap = await sendCdp({ tabId: ref.tabId }, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    });
    const strings = Array.isArray(snap?.strings) ? snap.strings : [];
    for (const doc of snap?.documents || []) {
      const ids = doc?.nodes?.backendNodeId;
      if (!Array.isArray(ids) || !ids.includes(ref.backendNodeId)) continue;
      const url = strings[doc.documentURL];
      return typeof url === "string" && url ? url : null;
    }
  } catch {
    return null;
  }
  // The node is in no document this target knows about — it detached, or it
  // belongs to a frame that has gone. Unknown, never "probably the main frame".
  return null;
}

/**
 * Every gate a secret write must pass, in the order above — cheap and silent
 * checks first, the one that interrupts a PERSON last. Returns the model-facing
 * refusal to answer with, or "" when the write may proceed.
 *
 * Every field of the policy is read FAIL-CLOSED, because this object crossed
 * five layers to get here and a field lost on the way must not widen anything:
 * a missing/short host list matches nothing, and `passwordOnly` is off ONLY on an
 * explicit `false` (a dropped flag reads as the restrictive default the server
 * also defaults to).
 *
 * The consent grant is keyed by (SECRET_SESSION_GRANT_HOST, "secret") — not by
 * secret name, and not by host either. It answers "may a stored secret be typed
 * in this browser session", which is the question the user is actually asked, so
 * one approval covers every allowed site: a 12-field form raises no second
 * popup, and neither does the next login page. The per-SITE decision lives one
 * layer up, in the owner's per-secret host allowlist, which the checks above
 * re-apply to every single write. The popup still shows the real host, the
 * secret name and the field kind, so the answer is given with those in view.
 */
async function secretWriteRefusal(tab, ref, policy, value) {
  const name = policy?.name;
  const hosts = Array.isArray(policy?.hosts) ? policy.hosts : [];
  const passwordOnly = policy?.passwordOnly !== false;
  // A policy without its value means the relay dropped the plaintext. Refuse
  // LOUDLY: the silent alternative is entering "" into a login form and
  // reporting success.
  if (typeof value !== "string" || !value) return secretValueMissingRefusal({ name });

  // The ELEMENT's tab, which is not always the working one: a uid minted on
  // another grouped tab still resolves, and checking the tab the agent happens
  // to be looking at would ask about the wrong page entirely.
  let refTab = tab;
  if (ref.tabId !== tab.id) {
    try {
      refTab = await groupedTabById(ref.tabId);
    } catch {
      // The tab left the group or closed under us. Unknown target, so refuse —
      // typeRef would fail on it a moment later anyway.
      return secretFrameUnknownRefusal({ name });
    }
  }
  if (!secretHostAllowed(refTab.url, hosts)) {
    return secretTabHostRefusal({ name, hosts, url: refTab.url });
  }

  const frameUrl = await refDocumentUrl(ref);
  if (frameUrl === null) return secretFrameUnknownRefusal({ name });
  if (!secretHostAllowed(frameUrl, hosts)) {
    return secretFrameHostRefusal({ name, hosts, frameUrl, tabUrl: refTab.url });
  }

  // Before the popup on purpose (see the section header): a prompt the answer to
  // which cannot matter is a prompt not worth raising, and an approval to it
  // would leave a session grant behind for a write that never happened.
  if (passwordOnly) {
    const shape = await describeElement(ref);
    if (!isPasswordInputShape(shape)) return secretPasswordOnlyRefusal({ name, shape });
  }

  // SHOWN: the document that will RECEIVE the keystrokes, not the tab — both
  // passed the allowlist above, and the frame is the honest subject.
  // REMEMBERED: the session-wide sentinel, so the next allowed site does not ask
  // again. LAST, so the user is only ever asked about a write every other gate
  // has cleared.
  const consent = await requestDataConsent(
    hostOfUrl(frameUrl),
    SECRET_CONSENT_TYPE,
    { name: String(name ?? ""), field: passwordOnly ? "password" : "any" },
    SECRET_SESSION_GRANT_HOST,
  );
  if (!consent.granted) return consent.reason;
  return "";
}

/**
 * Enter a secret into one field — the ONLY write path a secret ever takes.
 *
 * Deliberately NOT `fillField`/`clearAndWrite`. Every end state of the ordinary
 * clearing ladder quotes what the field landed on (`repairedNote`,
 * `divergedNote`, the throw), and its rungs B and C hand the value back to the
 * page a second and third time; a secret write must do neither. So `clear` is
 * exactly ONE rung — select-all, overtype — checked by LENGTH against the
 * read-back Chromium masks, and a mismatch is a note rather than a repair
 * attempt: repairing would mean typing the credential again into a field that
 * demonstrably does not behave.
 *
 * The insert-at-cursor case takes no read-back at all, exactly like the ordinary
 * short-write path (and unlike the long-write check, which reads the field back
 * to CONTAINS-match what was sent — a comparison that would need the plaintext).
 */
async function writeSecretField(ref, target, policy, value, clear, insert) {
  const name = policy?.name;
  const sent = [...value].length;
  await focusForInput(ref);
  if (!clear) {
    await insert();
    return secretEnteredNote({ name, sent });
  }
  // Resolved BEFORE the write, like every other verified path: the walk descends
  // the live DOM and a page that re-renders on input would otherwise hand back a
  // node the write never touched. Its pre-write VALUE is deliberately discarded
  // — nothing here compares content.
  const resolved = await resolveValueNode(ref);
  await selectAllIn(target);
  await insert();
  if (!resolved) return secretUnverifiedNote({ name, sent });
  // A change handler can raise a dialog mid-write; the read would hang on the
  // frozen renderer and the op tail reports the dialog instead.
  if (pendingDialogs.has(ref.tabId)) return "";
  const after = codePointLen(await settledValue(resolved.ref));
  if (after === null) return secretUnverifiedNote({ name, sent });
  if (after !== sent) return secretLengthMismatchNote({ name, sent, read: after });
  return secretVerifiedNote({ name, sent });
}

// ------------------------------------------------- controls that hold no text
//
// `type` means "put this text in there", and two native controls have no text
// to put it in. Measured in the field on `<input type=range>`: insertText
// no-opped, so the clearing ladder fell through to rung C, whose `End` key
// JUMPED the slider to its maximum — and "the old value is gone" then verified
// that as a successful write of 4 into a slider now reading 5. A number input
// fails the same way more quietly, rounding or refusing what it is handed while
// the ladder reports the write it did not accept.
//
// So the routing happens BEFORE the first keystroke, off the one depth-0
// description the preflight already needs for the file-upload refusal.

/**
 * Which KIND of control a write is about to land in.
 *
 *   "slider" — a native range input, or anything whose ROLE is slider (the ARIA
 *              div with aria-valuenow that a design system ships).
 *   "number" — a native number input, whose own constraints decide what lands.
 *   "text"   — everything else, unchanged.
 *
 * The accessibility read is skipped whenever the DOM already settles it: a
 * native field or an explicitly editable surface cannot compute to `slider`
 * unless the page overrode `role` outright, which is read here for free. That
 * matters because this runs on EVERY type and fill_form field, including the
 * insert-at-cursor path that costs no read-back today.
 */
/**
 * Roles that say "this is one cell of a data grid". A cell is NOT a text
 * control: its grid keeps keyboard focus on a proxy of its own, opens a
 * floating editor on a printable keydown, and commits on Enter — so the text
 * path's Input.insertText lands nowhere (measured on handsontable.com/demo:
 * the write reported success while the cell kept its value), and DOM.focus on
 * the cell moves DOM focus WITHOUT moving the grid's selection, sending the
 * keystroke replay into whichever cell the grid still considers selected
 * (round15-facts.spec.ts phase G committed into the row BELOW the target).
 */
const CELL_ROLES = new Set(["gridcell", "cell", "columnheader", "rowheader"]);

/** A shape the browser itself can edit — where the ordinary text path is sound. */
function nativelyEditableShape(shape) {
  const nodeName = shape?.nodeName;
  if (nodeName === "INPUT" || nodeName === "TEXTAREA" || nodeName === "SELECT") return true;
  const editable = attrOf(shape, "contenteditable");
  return Boolean(editable && editable !== "false");
}

async function inputKind(ref, shape) {
  if (shape?.nodeName === "INPUT") {
    const type = attrOf(shape, "type");
    if (type === "range") return "slider";
    if (type === "number") return "number";
  }
  const role = attrOf(shape, "role");
  if (role === "slider") return "slider";
  if (role === "spinbutton") return "spinbutton";
  // A cell that is itself editable (a contenteditable td) takes text directly;
  // only the plain widget cell needs the grid's own click-type-Enter grammar.
  if (CELL_ROLES.has(role) && !nativelyEditableShape(shape)) return "cell";
  if (role) return "text";
  if (shape?.nodeName === "INPUT" || shape?.nodeName === "TEXTAREA") return "text";
  const editable = attrOf(shape, "contenteditable");
  if (editable && editable !== "false") return "text";
  const axNode = await readAxNode(ref);
  const axRole = axNode?.role?.value;
  if (axRole === "slider") return "slider";
  // A date/time input's year-month-day parts live in UA shadow DOM with no DOM
  // role at all; only the accessibility tree calls them what they are. They
  // ignore Input.insertText entirely (measured: typing "2026" into a year part
  // reported success while the field stayed "0"), so they must never reach the
  // text path.
  if (axRole === "spinbutton") return "spinbutton";
  // A <td> in a data grid usually carries no DOM role either — the AX tree is
  // what calls it a cell (handsontable.com/demo's tds).
  if (CELL_ROLES.has(String(axRole)) && !nativelyEditableShape(shape)) return "cell";
  return "text";
}

/**
 * Class names that say "this element belongs to a VIRTUALIZED editor": Monaco's
 * hidden textarea (`inputarea`) and its wrappers, CodeMirror 6 (`cm-content`,
 * `cm-editor`), CodeMirror 5 (`CodeMirror`), and Ace (`ace_text-input`). Such an
 * editor keeps the document in its OWN model and renders a window of it, so the
 * element a write lands in is a proxy — which is why a long write into one is
 * the case that silently loses text (issue #60) and why the verification note
 * below names them.
 *
 * Matched on the RAW class attribute, not `attrOf`'s lowercased read: CodeMirror
 * 5's class is capitalized, and lowercasing would quietly stop matching it.
 * Token-bounded so a page's own `my-inputarea-wrapper` is not mistaken for one.
 */
const VIRTUALIZED_EDITOR_CLASS_RE =
  /(?:^|\s)(?:inputarea|monaco-editor|monaco-mouse-cursor-text|cm-content|cm-editor|CodeMirror|ace_text-input)(?:\s|$)/;

/**
 * The pre-flight both text-entry paths share: ONE description of the element,
 * the file-upload refusal, the control kind, and whether the element looks like
 * a virtualized editor's input. Runs exactly once per field — typeRef hands its
 * result to fillField rather than letting it describe again.
 *
 * `virtualized` costs nothing: the depth-0 describeNode is already in hand for
 * the file-upload refusal, and its attributes carry the class. It is a SIGNAL,
 * never a gate — nothing here blocks or reroutes a write because of it (the
 * agent asked for the write; honesty over paternalism), it only decides whether
 * an unverifiable long write says WHY it is likely unverifiable.
 */
async function inputPreflight(ref) {
  const shape = await describeElement(ref);
  assertNotFileInput(shape);
  return {
    shape,
    kind: await inputKind(ref, shape),
    virtualized: VIRTUALIZED_EDITOR_CLASS_RE.test(String(shape?.attrs?.class ?? "")),
  };
}

/**
 * Move a slider with arrow keys — the only way one moves without page JS, and
 * the reason `type` on a slider must never reach the text path at all.
 *
 * Everything is decided BEFORE the first key: `sliderPlan` (axtree.js) turns the
 * current value, the requested one and the bounds into a direction, a press
 * count and an expected landing, so an unreachable value is refused with the
 * real range in hand instead of walking the slider somewhere arbitrary and
 * calling it a success.
 */
async function driveSlider(ref, valueStr, shape, axNode) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const node = axNode || (await readAxNode(ref));
  const attrs = shape?.attrs || {};
  // Native attributes first, then the ARIA ones, then what Chrome computed: a
  // native range carries min/max/step in the DOM, an ARIA slider carries
  // aria-valuemin/aria-valuemax, and a component that sets neither still
  // reports bounds as accessibility properties.
  const bound = (dom, aria, ax) => {
    for (const candidate of [attrs[dom], attrs[aria], axProp(node, ax)]) {
      if (candidate != null && String(candidate).trim() !== "") return candidate;
    }
    return undefined;
  };
  const plan = sliderPlan({
    // An unreadable current value is not a failure: the plan then counts from
    // the minimum, which is what `fromMin` and the Home key below are for.
    current: node ? (axValueAnswer(node) ?? undefined) : undefined,
    target: valueStr,
    min: bound("min", "aria-valuemin", "valuemin"),
    max: bound("max", "aria-valuemax", "valuemax"),
    // ARIA has no step property at all, so a non-native slider's granularity is
    // whatever sliderPlan defaults to.
    step: attrs.step,
  });
  const wanted = quoteForNote(valueStr);
  // The step rides into both the messages and the tolerance below, so it is
  // coerced here rather than trusted: a granularity of 1 is the default nobody
  // needs told about, whether the plan reports it as 1 or "1".
  const grain = Number(plan.step);
  const steps = Number.isFinite(grain) && grain !== 1 ? ` in steps of ${plan.step}` : "";
  if (!plan.ok) {
    if (plan.reason === "not-a-number") {
      throw new Error(
        "This element is a slider (range input), so `type` needs a plain number for `value` — it ranges " +
          `${plan.min}–${plan.max}${steps}. To nudge it manually use mcp__browser__press_key with ` +
          "ArrowRight/ArrowLeft on its uid.",
      );
    }
    if (plan.reason === "out-of-range") {
      throw new Error(
        `The slider only goes from ${plan.min} to ${plan.max}${steps}, so it cannot be set to ${wanted}. ` +
          "Pick a value inside that range.",
      );
    }
    // "too-far": the press count is sliderPlan's own ceiling, not one this file
    // could enforce — a thousand arrow keys is a minute of dispatches for a
    // control click_at can jump to in one.
    throw new Error(
      `Setting this slider to ${wanted} would take ${plan.presses} arrow presses (limit 400). Use ` +
        "mcp__browser__click_at with a fraction of the slider's track to jump near the value, then fine-tune " +
        "with press_key ArrowLeft/ArrowRight.",
    );
  }
  await focusForInput(ref);
  // A plan counted from the floor has to REACH the floor first; Home is the one
  // key that gets there without knowing where the slider started.
  if (plan.fromMin) await dispatchKey(target, "Home", 0);
  for (let i = 0; i < plan.presses; i += 1) {
    // The same guard the clearing ladder presses under: a change handler can
    // raise a dialog mid-walk, and keys queued into a frozen renderer strand it.
    if (pendingDialogs.has(ref.tabId)) return "";
    await dispatchKey(target, plan.key, 0);
  }
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  const landed = await readAxValue(ref);
  const landedNum = Number(String(landed ?? "").trim());
  if (landed === null || String(landed).trim() === "" || !Number.isFinite(landedNum)) {
    return (
      "The slider exposes no numeric value to read back, so the change could NOT be verified — check its " +
      "value in the returned snapshot."
    );
  }
  // Half a step of tolerance, because a slider SNAPS: asking for 2.7 on a
  // 0.5-step control lands on 2.5, and that is the control working correctly.
  const tolerance = (Number.isFinite(grain) && grain > 0 ? grain : 1) / 2;
  if (Math.abs(landedNum - Number(String(valueStr).trim())) <= tolerance) return "";
  throw new Error(
    `Setting the slider to ${wanted} did not take: it now reads ${quoteForNote(landed)} ` +
      `(min ${plan.min}, max ${plan.max}, step ${plan.step}). The page may snap or override keyboard input — ` +
      "try mcp__browser__click_at at a fraction of the slider's track, or ask the user to set it.",
  );
}

/** Most characters worth replaying into one grid cell — more is not cell data. */
const CELL_REPLAY_MAX = 300;

/**
 * Write one grid cell the way a person does: CLICK it (a real click moves the
 * grid's own selection with the focus — DOM.focus moves only the focus, and
 * the keys then land on whichever cell the grid still considers selected),
 * type the value (real per-character keys, the only input a grid's floating
 * editor is opened by; Input.insertText lands nowhere — both measured in
 * round15-facts.spec.ts), and press Enter, the commit gesture every
 * spreadsheet shares. Committing here is not a liberty taken: an uncommitted
 * floating editor is invisible to the read-back AND left blocking the next op,
 * and Escape still undoes a commit's sibling (the caller was told which
 * gesture was used). The landing is then read back off the CELL itself and
 * quoted rather than assumed, in both directions.
 */
async function writeGridCell(ref, value) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  if (/[\r\n]/.test(value)) {
    throw new Error(
      "This element is a grid cell, and a grid commits on Enter — a multi-line value would be " +
        "scattered across cells. Type one cell's value at a time, without newlines.",
    );
  }
  const sent = [...value].length;
  if (sent > CELL_REPLAY_MAX) {
    throw new Error(
      `This element is a grid cell, which takes keyboard input only, and replaying ${sent} characters ` +
        `as keys is not reliable. Keep a cell value under ${CELL_REPLAY_MAX} characters.`,
    );
  }
  await clickNode(ref);
  // A click can OPEN the grid's editor pre-loaded with the old value: grids
  // count their own double-clicks, and the agent's previous op often clicked
  // this same cell moments ago — the replay then APPENDS ("James BrownSEQH",
  // measured in round15-facts.spec.ts phase H before this Escape existed).
  // Escape closes such an editor WITHOUT committing and keeps the selection;
  // with no editor open it is a no-op — so typing below always starts the
  // fresh-editor path, which is what REPLACES a cell's value.
  await dispatchKey(target, "Escape", 0);
  for (const ch of [...value]) {
    // Same guard the other key walks press under: a change handler can raise a
    // dialog mid-write, and keys queued into a frozen renderer strand it.
    if (pendingDialogs.has(ref.tabId)) return "";
    await dispatchKey(target, ch, 0);
  }
  if (pendingDialogs.has(ref.tabId)) return "";
  // An empty value means "empty this cell": Delete is the gesture that does
  // that from a closed cell, and it needs no commit.
  if (!value) await dispatchKey(target, "Delete", 0);
  else await dispatchKey(target, "Enter", 0);
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  const node = await readAxNode(ref);
  // A cell shows its content as its accessible NAME (its value is usually
  // empty) — read both, verify against whichever answers.
  const landedName = String(node?.name?.value ?? "").trim();
  const landedValue = String(axValueAnswer(node) ?? "").trim();
  const landed = landedValue || landedName;
  const took = value
    ? normalizedForCompare(landed).includes(normalizedForCompare(value))
    : landed === "";
  const how =
    "This element is a grid cell, so it was written the way a person does — click, type, Enter — and " +
    "the grid commits on Enter (clear/keystrokes flags do not apply: typing replaces a cell's value). ";
  if (took) return `${how}The cell now reads ${quoteForNote(landed)}.`;
  return (
    `${how}The read-back could NOT confirm it: the cell now reads ${quoteForNote(landed)} — the grid ` +
    "may have reformatted the value, refused it, or kept its editor open. Check the returned snapshot " +
    "before building on this cell."
  );
}

/**
 * Replace a native number input's value — what `clear: true` means there.
 *
 * The clearing ladder must never see one: its rungs are TEXT edits (End,
 * Backspace, an IME replacement range) and a number field answers them with its
 * own constraint logic — rounding to `step`, refusing a value outside min/max,
 * emptying itself on anything it cannot parse — so "the old value is gone" says
 * nothing about whether the requested value arrived. Overtype once, read back,
 * and report what the field actually took.
 */
async function writeNumberInput(ref, target, value, shape) {
  await selectAllIn(target);
  // An empty value means "empty this field": nothing follows to overtype the
  // selection, exactly as in clearAndWrite.
  if (value) await insertValue(target, value);
  else await dispatchKey(target, "Delete", 0);
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  const after = await readAxValue(ref);
  // Unreadable is not "wrong": say the write could not be verified rather than
  // inventing a failure out of a missing read.
  if (after === null) return UNVERIFIED_CLEAR_NOTE;
  const asked = String(value ?? "").trim();
  const got = String(after).trim();
  const accepted =
    asked === "" ? got === "" : Number.isFinite(Number(got)) && Number(got) === Number(asked);
  if (accepted) return "";
  const constraints = ["min", "max", "step"]
    .filter((name) => attrOf(shape, name))
    .map((name) => `${name} ${quoteForNote(shape.attrs[name], 20)}`)
    .join(", ");
  throw new Error(
    `This number input did not accept "${quoteForNote(value)}": it now reads "${quoteForNote(got)}"` +
      `${constraints ? ` (${constraints})` : ""}. Its constraints may round or refuse the value — use a ` +
      "value the field accepts, or ask the user.",
  );
}

/**
 * Write into a SPINBUTTON that is not a native number input — a date/time
 * input's year, month or day part, or an ARIA spinbutton. These accept KEYS,
 * not text insertion (`Input.insertText` is a silent no-op on a date part), so
 * the value is replayed as real digit keystrokes and then read back. Typing
 * into a date part inherently OVERWRITES it, so `clear` needs no separate path.
 *
 * Same non-silent contract as the ladder: verified → "", the field reformatted
 * it → the diverged note, nothing readable → an unverified note, and a value
 * the part refused to take → THROW naming what it still reads.
 */
async function writeSpinButton(ref, target, value) {
  const before = await readAxValue(ref);
  const text = String(value ?? "");
  // Nothing sensible erases a spinbutton to order; a single Backspace is what a
  // person does to empty a date part (it falls back to its placeholder).
  if (!text) await dispatchKey(target, "Backspace", 0);
  for (const ch of [...text]) {
    // Frozen renderer mid-replay: the op tail reports the open dialog instead.
    if (pendingDialogs.has(ref.tabId)) return "";
    await dispatchKey(target, ch, 0);
  }
  await new Promise((resolve) => setTimeout(resolve, VALUE_SETTLE_MS));
  const after = await readAxValue(ref);
  if (after === null) {
    return (
      "This spinbutton exposes no readable value, so the write could NOT be verified — check the " +
      'field\'s = "…" value in the returned snapshot before relying on it.'
    );
  }
  const asked = text.trim();
  const got = String(after).trim();
  const accepted =
    asked === ""
      ? got === "" || got === "0"
      : got === asked || (Number.isFinite(Number(got)) && Number(got) === Number(asked));
  if (accepted) return "";
  if (got === String(before ?? "").trim()) {
    throw new Error(
      `This spinbutton did not take "${quoteForNote(value)}": it still reads "${quoteForNote(got)}". ` +
        "A date/time part or ARIA spinbutton accepts only keys it understands (digits, ArrowUp/ArrowDown) — " +
        "use a value of that form, or step it with mcp__browser__press_key arrows.",
    );
  }
  return divergedNote(after, value);
}

/**
 * Code-point length past which an insert-at-cursor write is READ BACK. Below it
 * the no-clear path stays exactly what it always was — no read, no settle, no
 * note — because insert-at-cursor cannot silently do the wrong thing at short
 * lengths: it puts the text where the caret is and that is all it claims.
 *
 * Above it that stopped being true (issue #60): a virtualized editor ingesting a
 * multi-KB insert keeps whatever it managed to take, and the tool reported the
 * whole write as done. So a long write now pays ONE resolveValueNode walk plus
 * ONE settled read — a few hundred milliseconds on a write that already cost
 * several chunked inserts — to say whether the text is actually there. The trade
 * is deliberately length-gated rather than universal: the cost is invisible next
 * to a 2.5 KB write and would be the dominant cost of typing "hello".
 */
const LONG_WRITE_VERIFY_MIN = 1000;

/** Whitespace-insensitive haystack/needle text, for the long-write check. */
const normalizedForCompare = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * What a long write says when the editor is one of the known virtualized kinds —
 * or when the read-back simply does not contain what was sent, which is the same
 * symptom. Names the recovery that actually works for multi-KB content: the
 * clipboard, which an editor ingests as ONE paste event instead of a stream of
 * insertions it has to keep up with.
 */
const VIRTUALIZED_LONG_WRITE_ADVICE =
  "Virtualized editors (Monaco/CodeMirror) DROP parts of a long programmatic insert: check the content in the " +
  "returned snapshot, and prefer mcp__browser__copy_text + paste for multi-KB text.";

/** Long write whose outcome could not be read back at all. */
const longWriteUnverifiedNote = (sent, virtualized) =>
  `Long write NOT verified: ${sent} characters were sent, but this element exposes no readable value — check ` +
  "the field's content in the returned snapshot before building on it." +
  (virtualized ? ` ${VIRTUALIZED_LONG_WRITE_ADVICE}` : "");

/**
 * Long write that read back WITHOUT the text in it. A note and never a throw:
 * the editor may hold the full content in its own model while the DOM proxy it
 * exposes windows only part of it, so throwing would lie in the other direction
 * — reporting a landed write as failed.
 */
const longWriteMismatchNote = (sent, after, proxy) =>
  `Long write NOT verified: ${sent} characters were sent, the field reads back ` +
  `${[...String(after ?? "")].length} ("${quoteForNote(after)}"). ` +
  (proxy ? "The field is a custom editor's hidden proxy input, which strengthens that reading. " : "") +
  VIRTUALIZED_LONG_WRITE_ADVICE;

/**
 * Focus one field and enter `value` — the shared insert path of type and
 * fill_form. `clear` replaces the existing content instead of inserting into it,
 * through the verified ladder above. Returns that ladder's bridge note ("" when
 * there is nothing to report). `pre` is typeRef's already-run preflight; every
 * other caller (fill_form) lets this run its own.
 */
async function fillField(ref, value, clear, pre, secret) {
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const { shape, kind, virtualized } = pre || (await inputPreflight(ref));
  // A secret bypasses the kind routing entirely — every non-text control's write
  // path verifies by quoting the value it landed on, which a secret write may
  // never do, so the only sound answer for one is to refuse.
  if (secret) {
    if (kind !== "text") throw new Error(secretNonTextRefusal({ name: secret.name, shape }));
    return writeSecretField(ref, target, secret, value, clear, () => insertValue(target, value));
  }
  // `clear` is meaningless on a slider — there is no text to replace — so the
  // control is driven as what it is, whichever flags the caller passed.
  if (kind === "slider") return driveSlider(ref, value, shape);
  // Same rule for a grid cell: it has ONE input grammar (click, type, Enter),
  // and writeGridCell does its own focusing — a real click, never DOM.focus,
  // which moves focus without moving the grid's selection.
  if (kind === "cell") return writeGridCell(ref, value);
  await focusForInput(ref);
  // Whichever flags the caller passed, same as the slider: keys are the only
  // input a spinbutton takes, and they overwrite by nature.
  if (kind === "spinbutton") return writeSpinButton(ref, target, value);
  if (kind === "number" && clear) return writeNumberInput(ref, target, value, shape);
  if (!clear) {
    // Insert-at-cursor is the default and stays a straight write for a SHORT
    // value: no read-back, no settle delay, no note. A LONG one is the exception
    // this path had to grow (LONG_WRITE_VERIFY_MIN): it is the length at which a
    // virtualized editor starts losing text, and losing it silently.
    if (!value) return "";
    const sent = [...value].length;
    if (sent < LONG_WRITE_VERIFY_MIN) {
      await insertValue(target, value);
      return "";
    }
    // Resolved BEFORE the write: the walk is a breadth-first descent through the
    // live DOM, and a virtualized editor re-renders as it ingests — run it
    // afterwards and it can land on a node the write never touched. Its `value`
    // (the pre-write content) is deliberately unused: the check below is
    // CONTAINS, not equals, because insert-at-cursor lands INSIDE whatever the
    // field already held.
    const resolved = await resolveValueNode(ref);
    await insertValue(target, value);
    // A dialog raised mid-write stopped the chunk loop, so the field holds a
    // PREFIX of the value: reading it back would report the editor dropping text
    // it was never given. The op tail reports the open dialog instead — and the
    // read itself would hang on the frozen renderer anyway.
    if (pendingDialogs.has(ref.tabId)) return "";
    if (!resolved) return longWriteUnverifiedNote(sent, virtualized);
    const after = await settledValue(resolved.ref);
    if (after === null) return longWriteUnverifiedNote(sent, virtualized);
    // Whitespace-insensitive: an editor re-indents, collapses a trailing newline
    // or normalizes line endings as it ingests, and none of that is text loss.
    if (normalizedForCompare(after).includes(normalizedForCompare(value))) return "";
    // The proxy sentence is a GEOMETRY claim ("~1px, invisible"), so it rides
    // isHiddenProxyInput alone — never the class-name flag, which says the
    // element belongs to such an editor, not that this one is the sliver. The
    // virtualized advice fires on this path regardless: a read-back missing the
    // text IS the symptom, whatever the class attribute said.
    return longWriteMismatchNote(sent, after, await isHiddenProxyInput(resolved.ref));
  }
  return clearAndWrite(ref, target, value, () => insertValue(target, value));
}

/** Type into one field. Returns the clearing ladder's bridge note, or "". */
async function typeRef(uid, value, submit, keystrokes, clear, secret) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  // One description for the whole call: it refuses a file-upload input before a
  // single key is sent, and decides the control kind fillField then reuses.
  const pre = await inputPreflight(ref);
  // Replay as real per-character key events, ONE bridge operation for the whole
  // string — for editors that only listen to keyboard input. Server caps the
  // length; the dialog check keeps a mid-string alert() from queueing keystrokes
  // into a frozen renderer. Hoisted out of the keystrokes branch because it is
  // also the secret path's insert when the caller asked for keystrokes.
  const replay = async () => {
    for (const ch of [...value]) {
      if (pendingDialogs.has(ref.tabId)) return;
      await dispatchKey(target, ch === "\n" ? "Enter" : ch, 0);
    }
  };
  let note = "";
  if (secret) {
    // Ahead of every other branch: a secret takes ONE write path, whatever kind
    // of control the caller aimed at (see fillField's secret branch).
    if (pre.kind !== "text") throw new Error(secretNonTextRefusal({ name: secret.name, shape: pre.shape }));
    const insert = keystrokes ? replay : () => insertValue(target, value);
    note = await writeSecretField(ref, target, secret, value, clear, insert);
  } else if (pre.kind === "slider") {
    // Ahead of the keystrokes branch deliberately: a per-character replay is
    // text entry too, and a slider has no text to enter.
    note = await driveSlider(ref, value, pre.shape);
  } else if (pre.kind === "cell") {
    // Whichever flags the caller passed, same as the slider: a grid cell is
    // driven the one way a grid accepts input — see writeGridCell.
    note = await writeGridCell(ref, value);
  } else if (keystrokes) {
    await focusForInput(ref);
    // Same ladder, same verification; the replay IS this mode's insert path, so
    // the first character overtypes the selection instead of extending the value.
    if (clear) note = await clearAndWrite(ref, target, value, replay);
    else await replay();
  } else {
    note = await fillField(ref, value, clear, pre);
  }
  if (submit) {
    await dispatchKey(target, "Enter", 0);
  }
  return note;
}

// ------------------------------------------------------------- select_option
//
// CDP has no setter for a <select>'s value short of running page JS, which
// this worker never does. So selection is driven the way a person drives it:
// a visibly rendered option is CLICKED; a collapsed native dropdown is TYPED at
// and only then walked with arrow keys, and the landing value is VERIFIED
// afterwards — the keyboard path is the one that can silently no-op, and it must
// never claim success on faith.
//
// The order was measured, not assumed. On a COLLAPSED select this Linux build
// does what the comment here used to blame on macOS alone: ArrowDown does not
// move the selection, it opens the browser-process native popup, which lives
// outside the renderer and which `Input.*` cannot reach at all — so the arrow
// walk reported `Selecting "Option 2" did not take` on a plain
// the-internet.herokuapp.com/dropdown. Type-ahead is the path that survives it:
// a focused collapsed select jumps to the option whose label starts with what
// was typed, entirely inside the renderer. Arrows stay as the fallback for the
// platforms where they do move the selection.

/** Settle before believing a select's new value; the AX value lags the key. */
const SELECT_SETTLE_MS = 150;
/** One more look before calling it a failure — the field bug was a hasty read. */
const SELECT_RECHECK_MS = 250;

async function sessionAxNodes(target) {
  const { nodes } = await sendCdp(target, "Accessibility.getFullAXTree", {});
  return nodes || [];
}

/** Option descendants of one AX node, in document order, as a uniform shape. */
function collectAxOptions(nodes, root) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const seen = new Set();
  const out = [];
  const walk = (node) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    for (const childId of node.childIds || []) {
      const child = byId.get(childId);
      if (!child) continue;
      if (child.role?.value === "option") {
        out.push({
          label: String(child.name?.value || ""),
          disabled: axProp(child, "disabled") === true,
          selected: axProp(child, "selected") === true,
          backendNodeId: child.backendDOMNodeId,
        });
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** Text of a described DOM node: its #text descendants, whitespace-collapsed. */
function domNodeText(node) {
  const texts = [];
  const walk = (item) => {
    if (!item) return;
    if (item.nodeType === 3 && item.nodeValue) texts.push(item.nodeValue);
    for (const child of item.children || []) walk(child);
  };
  walk(node);
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * OPTION elements from a described <select> subtree — the fallback when the
 * AX tree hides a collapsed popup's options. The DOM `selected` attribute
 * only reflects the markup default, not live state, so it is left undefined
 * and the caller falls back to the select's accessible value.
 */
function collectDomOptions(root) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (String(node.nodeName || "").toUpperCase() === "OPTION") {
      const attrs = node.attributes || [];
      let disabled = false;
      for (let i = 0; i < attrs.length; i += 2) {
        if (String(attrs[i]).toLowerCase() === "disabled") disabled = true;
      }
      out.push({
        label: domNodeText(node),
        disabled,
        selected: undefined,
        backendNodeId: node.backendNodeId,
      });
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

/**
 * The shortest prefix of `picked`'s label that Blink's select type-ahead would
 * land on, or "" when type-ahead cannot do the job here.
 *
 * Type-ahead matches the typed characters against the option labels
 * case-insensitively and keeps roughly a one-second buffer between keystrokes,
 * so the whole prefix goes out back to back. Three things rule it out, and all
 * three are decided BEFORE typing rather than discovered afterwards:
 *
 *   - a non-ASCII character leaves dispatchKey through the IME composition path,
 *     which does not feed type-ahead at all;
 *   - a leading SPACE opens the native popup instead of starting a session (a
 *     space INSIDE an active prefix is ordinary input, which is why only the
 *     first character is ruled on — and why the label is trimmed first);
 *   - two enabled options sharing a label cannot be told apart by any prefix.
 *
 * Uniqueness is judged among the ENABLED options only, matching what the arrow
 * fallback walks.
 */
function typeaheadPrefix(enabled, picked) {
  const wanted = picked.label.trim();
  // Printable ASCII throughout, and never a space first.
  if (!/^[!-~][ -~]*$/.test(wanted)) return "";
  const others = enabled
    .filter((option) => option !== picked)
    .map((option) => option.label.trim().toLowerCase());
  const lower = wanted.toLowerCase();
  for (let len = 1; len <= wanted.length; len += 1) {
    const prefix = lower.slice(0, len);
    if (!others.some((label) => label.startsWith(prefix))) return wanted.slice(0, len);
  }
  return ""; // a duplicate label: no prefix singles it out
}

/** Exact match first, then trimmed, then case-insensitive — never substring. */
function matchOptionLabel(options, wanted) {
  const trimmed = wanted.trim();
  return (
    options.find((option) => option.label === wanted) ||
    options.find((option) => option.label.trim() === trimmed) ||
    options.find((option) => option.label.trim().toLowerCase() === trimmed.toLowerCase()) ||
    null
  );
}

async function selectOption(uid, wanted) {
  const ref = resolveRef(uid);
  const target = { tabId: ref.tabId, sessionId: ref.sessionId };
  const described = await nodeCall(ref, () =>
    sendCdp(target, "DOM.describeNode", { backendNodeId: ref.backendNodeId, depth: -1 }),
  );
  const tagName = String(described?.node?.nodeName || "").toUpperCase();
  const domAttrs = described?.node?.attributes || [];
  let isMultiple = false;
  for (let i = 0; i < domAttrs.length; i += 2) {
    if (String(domAttrs[i]).toLowerCase() === "multiple") isMultiple = true;
  }

  const nodes = await sessionAxNodes(target);
  const rootAx = nodes.find((node) => node.backendDOMNodeId === ref.backendNodeId) || null;
  let options = rootAx ? collectAxOptions(nodes, rootAx) : [];
  if (!options.length && tagName === "SELECT") options = collectDomOptions(described.node);
  if (!options.length) {
    throw new Error(
      "No options were found under this element. If it is a custom dropdown, drive it like any UI: " +
        "click it open, take a snapshot, then click (or select_option) the option that appears.",
    );
  }
  const picked = matchOptionLabel(options, wanted);
  if (!picked) {
    throw new Error(
      `No option labeled "${wanted}" was found here (${options.length} option${options.length === 1 ? "" : "s"} present). ` +
        "Take a fresh snapshot and pass the option's label exactly as it is shown.",
    );
  }
  if (picked.disabled) {
    throw new Error(`The option "${wanted}" is disabled and cannot be selected.`);
  }

  // A visibly rendered option (expanded dropdown, size>1 list, multi-select,
  // ARIA listbox) is clicked like real UI, firing the page's own handlers.
  if (picked.backendNodeId != null) {
    try {
      // Spread the ref so the option inherits its document epoch: nodeCall looks
      // the uid up by the full key when it has to explain a dead node.
      await clickNode({ ...ref, backendNodeId: picked.backendNodeId });
      return;
    } catch {
      // No geometry — a collapsed native dropdown. Fall through to keys.
    }
  }
  if (tagName !== "SELECT") {
    throw new Error(
      `The option "${wanted}" is not currently clickable and this is not a native dropdown. ` +
        "Click the widget open, take a snapshot, then click the option that appears.",
    );
  }
  if (isMultiple) {
    throw new Error(
      `The option "${wanted}" is not currently visible in this multi-select list. ` +
        "Scroll the list (scroll with its uid), take a snapshot, then click the option.",
    );
  }

  // Collapsed native single <select>. Type-ahead first, arrows as the fallback.
  const enabled = options.filter((option) => !option.disabled);
  const wantLabel = picked.label.trim();
  await sendCdp(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId: ref.backendNodeId });
  await sendCdp(target, "DOM.focus", { backendNodeId: ref.backendNodeId });

  const readValue = async () =>
    String(
      (await sessionAxNodes(target)).find((node) => node.backendDOMNodeId === ref.backendNodeId)
        ?.value?.value || "",
    ).trim();
  /**
   * Read the value back the way the clearing ladder does — with a settle, and a
   * SECOND look before giving up. Reading immediately after the last key
   * reported successful selections as failures: the AX value is one flush
   * behind the keystroke that changed it.
   */
  const verify = async () => {
    await new Promise((resolve) => setTimeout(resolve, SELECT_SETTLE_MS));
    let landed = await readValue();
    if (landed !== wantLabel) {
      await new Promise((resolve) => setTimeout(resolve, SELECT_RECHECK_MS));
      landed = await readValue();
    }
    return landed;
  };

  let landed = "";
  const prefix = typeaheadPrefix(enabled, picked);
  for (const ch of prefix) {
    if (pendingDialogs.has(ref.tabId)) return; // a change handler froze the page
    await dispatchKey(target, ch, 0);
  }
  if (prefix) {
    landed = await verify();
    if (landed === wantLabel) return;
  }

  // Arrows move by one ENABLED option — on the platforms where they move at all.
  // The starting index comes from the value just READ, not from the pre-typing
  // snapshot: type-ahead may have moved the selection somewhere else entirely,
  // and walking from a stale index would overshoot by exactly that much.
  const targetIdx = enabled.indexOf(picked);
  let currentIdx = landed ? enabled.findIndex((option) => option.label.trim() === landed) : -1;
  if (currentIdx < 0) currentIdx = enabled.findIndex((option) => option.selected === true);
  if (currentIdx < 0) {
    const currentLabel = String(rootAx?.value?.value || "").trim();
    currentIdx = enabled.findIndex((option) => option.label.trim() === currentLabel);
  }
  if (currentIdx < 0) currentIdx = 0; // best effort — the verify below is the referee
  const delta = targetIdx - currentIdx;
  for (let i = 0; i < Math.abs(delta); i += 1) {
    if (pendingDialogs.has(ref.tabId)) return;
    await dispatchKey(target, delta > 0 ? "ArrowDown" : "ArrowUp", 0);
  }
  landed = await verify();
  if (landed !== wantLabel) {
    throw new Error(
      `Selecting "${wanted}" did not take: the dropdown still reads "${landed || "(unknown)"}". ` +
        "Typing the option's label (the browser's own type-ahead) and walking with arrow keys were both tried and " +
        "the value did not change — on this platform the keys open the browser's NATIVE dropdown popup, which is " +
        "browser UI that synthetic input cannot reach. Ask the user to pick the option themselves, then take a " +
        "snapshot to confirm what is selected.",
    );
  }
}

// ------------------------------------------------------------------- reading

/** Characters of page text one read_text call returns; continue via `offset`. */
const READ_TEXT_MAX = 20000;

/**
 * Plain readable text of the page (or of one element's subtree), across every
 * attached session, in the same order the snapshot walks. Mints no uids, so
 * the previous snapshot's refs stay valid.
 *
 * A SCOPED read climbs the same recovery ladder buildScopedSnapshot documents,
 * for the same field failures and in the same order: DOM-membership enrichment
 * when the subtree reads hollow, one flushed repoll when even that finds nothing
 * (the tree may have been fetched mid-rebuild), a DOM-membership sweep when no
 * tree contains the start node at all (absent from the AX tree is not gone from
 * the page), and a sentence rather than an empty string when the element is
 * genuinely readable-content-free. The UNSCOPED path is untouched — `expand`
 * merges its lines and needs exactly today's behavior.
 */
async function buildPageText(tab, scope) {
  const scopeTarget = scope ? { tabId: scope.tabId, sessionId: scope.sessionId } : null;
  // Same lazily-updated AX tree the snapshot path reads: the field report had
  // the page's new button missing from read_text too, so the flush belongs here.
  await flushLifecycle(scopeTarget || { tabId: tab.id });
  // A uid-scoped read stays on the session that minted the uid, but the
  // element may sit in a SAME-process child frame, whose nodes are absent from
  // that session's main tree — so the frame trees are a fallback, not a miss.
  // The ids are held: the enrichment below asks which of those frames the
  // scoped element OWNS.
  const scopeFrameIds = scopeTarget ? await childFrameIds(scopeTarget) : [];
  const sources = scopeTarget
    ? [{ target: scopeTarget }, ...scopeFrameIds.map((frameId) => ({ target: scopeTarget, frameId }))]
    : await axSources(tab);
  const parts = [];
  let scopeFound = false;
  for (const source of sources) {
    const nodes = await sourceAxNodes(source);
    if (!nodes) continue;
    let lines = renderAxText(nodes, scope ? scope.backendNodeId : undefined);
    if (lines === null) continue; // the start node is not in THIS tree — try the next
    scopeFound = true;
    // A HOLLOW scoped read is the map-region case scopeDomIdsOf documents: the
    // subtree walk answered a few characters for an element the unscoped read
    // shows full. Re-read it against what the DOM says the element contains.
    if (scope && lines.join("\n").length < HOLLOW_SCOPE_TEXT_CHARS) {
      const scopeDomIds = await scopeDomIdsOf(scopeTarget, scope.backendNodeId);
      if (scopeDomIds) {
        lines = renderAxText(nodes, scope.backendNodeId, scopeDomIds) || lines;
        if (lines.join("\n").length < HOLLOW_SCOPE_TEXT_CHARS) {
          // Still nothing, which is the mid-rebuild case buildScopedSnapshot
          // repolls for: a live surface re-creates the nodes it holds, so the
          // tree in hand can predate them or have already detached them, and
          // re-reading the SAME array cannot recover either.
          await new Promise((resolve) => setTimeout(resolve, STALE_SNAPSHOT_REPOLL_MS));
          await flushLifecycle(scopeTarget);
          const freshNodes = await sourceAxNodes(source);
          let retried = null;
          if (freshNodes) {
            // The id set is re-asked rather than reused: on the surface this
            // repoll exists for, the wait itself outdates those backendNodeIds —
            // the rebuilt nodes carry NEW ones — so reading a fresh tree against
            // the old set would miss exactly what the repoll came back for. The
            // old set stands in when the DOM will not answer a second time.
            const freshIds = (await scopeDomIdsOf(scopeTarget, scope.backendNodeId)) || scopeDomIds;
            retried = renderAxText(freshNodes, scope.backendNodeId, freshIds);
          }
          // Longer wins, never shorter: the rebuild can be caught going either
          // way, and the repoll must not SUBTRACT from what was already read.
          if (retried && retried.join("\n").length > lines.join("\n").length) lines = retried;
        }
        // No frame header here: the reading view carries no labels or uids to
        // tie one to, so a frame's text simply continues the element's.
        for (const inner of await framesInsideScope(scopeTarget, scopeFrameIds, scopeDomIds)) {
          lines.push(...renderAxText(inner.nodes));
        }
      }
    }
    if (lines.length) parts.push(lines.join("\n"));
    if (scope) break; // a scoped subtree lives in exactly one tree
  }
  if (scope && !scopeFound) {
    // No tree contained the start node, which does not mean the element is gone:
    // an unnamed wrapper or a pane caught mid-rebuild is alive in the DOM while
    // absent from the accessibility tree, and telling the agent to discard a uid
    // that still works costs it the whole read. The DOM decides — if it still
    // describes a subtree, sweep the tree for the nodes belonging to it.
    const sweepIds = await scopeDomIdsOf(scopeTarget, scope.backendNodeId);
    const nodes = sweepIds?.size ? await sourceAxNodes(sources[0]) : null;
    if (!nodes) {
      throw new Error(
        "The element behind that uid is gone from the page. Take a fresh mcp__browser__snapshot and retry read_text with a current uid.",
      );
    }
    // No startBackendNodeId: with the id set alone the walk takes the in-scope
    // nodes as its roots, visiting exactly them and never answering null.
    const swept = renderAxText(nodes, undefined, sweepIds) || [];
    for (const inner of await framesInsideScope(scopeTarget, scopeFrameIds, sweepIds)) {
      swept.push(...renderAxText(inner.nodes));
    }
    if (swept.length) parts.push(swept.join("\n"));
  }
  const text = parts.join("\n");
  // A SCOPED read that comes back empty says so in words: the element is there
  // (every path that reaches here has confirmed as much), so an empty string
  // would read as a broken tool and leave nothing to try next.
  if (scope && !text) return HOLLOW_SCOPE_TEXT_NOTE;
  return text;
}

/**
 * Time budget for the `expand` scroll loop. The Noah client parks the whole
 * bridge operation for 40s; stopping here leaves room for the final walk and
 * the reply on a big page.
 */
const EXPAND_BUDGET_MS = 18000;
/** Hard stop for text accumulated during `expand`, in characters. */
const EXPAND_MAX_CHARS = 500000;
/** Scroll steps that add no new lines before `expand` concludes it is done. */
const EXPAND_STALL_LIMIT = 3;

/**
 * read_text with `expand`: scroll toward the end of the page in viewport-sized
 * steps, collecting text at every stop. Lazy-loaded and VIRTUALIZED content
 * only exists in the DOM near the viewport (a feed can render 6 of 334
 * comments), so a single walk misses it — and content that scrolls out may be
 * REMOVED again, so chunks are merged as we go rather than read once at the
 * bottom. Infinite feeds never reach the end; the stall/time/size caps are
 * what terminate those.
 */
async function buildExpandedPageText(tab) {
  const started = Date.now();
  let lines = [];
  let stalled = 0;
  for (;;) {
    if (pendingDialogs.has(tab.id)) break;
    const text = await buildPageText(tab, null);
    const before = lines.length;
    lines = mergeTextLines(lines, text ? text.split("\n") : []);
    stalled = lines.length > before ? 0 : stalled + 1;
    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const height = viewport.clientHeight || 600;
    const atEnd =
      (viewport.pageY || 0) + height >= ((metrics.cssContentSize || {}).height || 0) - 2;
    if (atEnd && stalled >= 1) break; // bottom reached and nothing new loaded
    if (stalled >= EXPAND_STALL_LIMIT) break; // nothing loads; stop spending the budget
    if (Date.now() - started >= EXPAND_BUDGET_MS) break;
    if (lines.join("\n").length >= EXPAND_MAX_CHARS) break;
    await sendCdp({ tabId: tab.id }, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: (viewport.clientWidth || 800) / 2,
      y: height / 2,
      deltaX: 0,
      deltaY: Math.round(height * 0.8),
    });
    // Give the page a beat to fetch and render what the scroll uncovered.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return lines.join("\n");
}

/** Longest horizontal edge of a screenshot after scaling, in PHYSICAL image px. */
const SCREENSHOT_MAX_WIDTH = 1400;
/** fullPage capture height cap, CSS px — beyond this the image is cut off. */
const SCREENSHOT_MAX_FULL_HEIGHT = 6000;
/**
 * How much of a capture to base64-decode when MEASURING it. A JPEG's frame
 * header sits within the first few KB (after APP0/EXIF/ICC), so decoding a whole
 * megabyte of entropy-coded pixels to read two 16-bit fields would be pure
 * waste; captureShot retries on the full string if the parse comes back empty,
 * which covers an encoder that puts a large colour profile in front.
 */
const JPEG_HEADER_PROBE_BYTES = 64 * 1024;

// THREE pixel units meet in this function and only the middle one is the
// protocol's (probe-measured, `tests/visual/zoom-capture.spec.ts`): every clip
// built below comes off `Page.getLayoutMetrics` in CSS px, `captureScreenshot`
// reads its `clip` as DIP (= CSS px × the viewport's `zoom`, i.e. the user's own
// Ctrl+/−), and the bitmap it hands back is PHYSICAL px (= clip × `scale` × the
// display's device scale factor). CSS and DIP coincide at 100% zoom ALONE, which
// is why an unconverted clip reads as correct on the developer's own unzoomed
// window while cropping the bottom-right 1−1/zoom of the visible page in the
// field — a fifth of it at 125%, a third at 150%. The same measurement is why
// the width cap and the vision-API ceiling are applied to the PHYSICAL edge: on
// a scaled display the bitmap comes back dsf times bigger than the clip asked
// for, so a CSS-measured bound bounds nothing.
async function captureShot(tab, message) {
  // An element capture resolves its quads BEFORE the layout metrics are read:
  // quadsOf scrolls the element into view, which CHANGES pageX/pageY, while the
  // quads it returns are relative to the POST-scroll viewport. Reading metrics
  // first stitched the clip out of two different scroll positions, so any
  // element that started off-viewport captured a region offset by exactly the
  // scroll delta (field case: a ruler page's button-10 captured button-4).
  let uidQuads = null;
  if (message.uid) {
    const ref = resolveRef(message.uid);
    if (ref.sessionId) {
      throw new Error(
        "This element lives inside a cross-origin frame, which cannot be captured on its own. " +
          "Take a screenshot without `uid` to capture the viewport instead.",
      );
    }
    ({ quads: uidQuads } = await quadsOf(ref));
    if (!uidQuads.length) {
      throw new Error("The element is not visible on screen, so it cannot be captured.");
    }
  }
  const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
  const content = metrics.cssContentSize || {};
  // Both factors are derived from that ONE metrics read, and both fall back to
  // the pre-conversion arithmetic (zoom 1, dsf 1) when a field is missing —
  // `visualViewport` is the physical-px twin of the CSS block, so their width
  // ratio IS zoom × dsf and dividing out the zoom leaves the display's factor.
  const zoom = Number(viewport.zoom) > 0 ? Number(viewport.zoom) : 1;
  const physical = metrics.visualViewport || {};
  const pxPerCssRaw =
    Number(physical.clientWidth) > 0 && Number(viewport.clientWidth) > 0
      ? physical.clientWidth / viewport.clientWidth
      : zoom;
  const dsf = pxPerCssRaw / zoom || 1;
  let clip;
  let beyondViewport = false;
  let note = "";
  if (uidQuads) {
    // Quads are viewport-relative; the capture clip is page-absolute.
    const xs = [];
    const ys = [];
    for (const quad of uidQuads) {
      for (let i = 0; i < quad.length; i += 2) {
        xs.push(quad[i]);
        ys.push(quad[i + 1]);
      }
    }
    // UNpadded on purpose: fractions get measured on this image and handed to
    // click_at/drag as fractions OF THE ELEMENT'S BOX, so the image's edges
    // must BE the box's edges. The 8px pad this used to add skewed every
    // measured fraction by pad/size per axis — 1.5% on a 550px-tall chart,
    // which is exactly how far two legend clicks missed in the field
    // (round 13, echarts editor).
    clip = {
      x: Math.max(0, Math.min(...xs) + (viewport.pageX || 0)),
      y: Math.max(0, Math.min(...ys) + (viewport.pageY || 0)),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    // Captured from the LIVE surface whenever the element fits the visible
    // viewport (quadsOf scrolled it in already). captureBeyondViewport
    // re-lays-out a responsive page around the capture even when the clip is
    // fully inside the viewport (probe-measured, round13-facts.spec.ts: the
    // page's own resize listener fires, flag-off it does not) — and a chart
    // library redraws its canvas from exactly that listener, so the flag is
    // reserved for the one case that needs it: an element too big for the
    // viewport, where it is the only way to get the pixels at all.
    beyondViewport =
      Math.min(...xs) < -1 ||
      Math.min(...ys) < -1 ||
      Math.max(...xs) > (viewport.clientWidth || 0) + 1 ||
      Math.max(...ys) > (viewport.clientHeight || 0) + 1;
    if (beyondViewport) {
      note =
        "This element extends beyond the visible viewport, so it was captured with the page surface " +
        "expanded. A responsive layout can render at sizes and positions the screen does not show in " +
        "such a capture — do not measure click_at/drag coordinates or fractions on it; scroll the " +
        "element fully into view and re-capture, or use a plain viewport screenshot.";
    }
  } else if (message.fullPage) {
    clip = {
      x: 0,
      y: 0,
      width: content.width || viewport.clientWidth || 1024,
      height: Math.min(content.height || viewport.clientHeight || 768, SCREENSHOT_MAX_FULL_HEIGHT),
    };
    beyondViewport = true;
  } else {
    clip = {
      x: viewport.pageX || 0,
      y: viewport.pageY || 0,
      width: viewport.clientWidth || 1024,
      height: viewport.clientHeight || 768,
    };
  }
  const mode = uidQuads ? "element" : message.fullPage ? "fullPage" : "viewport";
  clip.width = Math.max(1, Math.round(clip.width));
  clip.height = Math.max(1, Math.round(clip.height));
  // The three branches above measure the page in CSS px; the protocol wants DIP.
  // The CSS dimensions have to survive the conversion because the click-time
  // drift check compares them against a fresh `cssVisualViewport`.
  const cssClipWidth = clip.width;
  const cssClipHeight = clip.height;
  clip = {
    x: clip.x * zoom,
    y: clip.y * zoom,
    width: Math.max(1, Math.round(clip.width * zoom)),
    height: Math.max(1, Math.round(clip.height * zoom)),
  };
  // Bound the pixel size for the model: cap the width, and stay inside the
  // 8000px-per-edge ceiling vision APIs enforce even for tall captures. Both
  // bounds are on the returned BITMAP, which is dsf times this clip.
  //
  // A VIEWPORT capture takes one bound more (issue #66): the API resizes an
  // oversized image to the model's native limits BEFORE the model sees it, and
  // the model then answers pixel questions in the resized space — so a capture
  // the caps above happily allow (1400×2197 = 3950 visual tokens) reaches a
  // standard-tier model at 874×1372, a coordinate space ×1.60 away from the
  // bytes we sent, with nothing on the wire saying so. Fitting it HERE makes the
  // image we send the image the model sees, which is the vision docs' own advice
  // for coordinate work (axtree.js's vision block).
  //
  // The other two modes deliberately keep the plain caps. Element captures feed
  // click_at/drag through uid-mode FRACTIONS, which are scale-invariant — the
  // fit would buy nothing and cost detail — and fullPage pixels are refused by
  // shotCssPoint outright, so they never become coordinates at all; squeezing a
  // tall page into 1568 standard-tier px would only make it unreadable for the
  // high-resolution-tier models that can take it whole.
  const scale =
    mode === "viewport"
      ? viewportShotScale(clip.width * dsf, clip.height * dsf, {
          maxWidth: SCREENSHOT_MAX_WIDTH,
          maxHeight: 7900,
        })
      : Math.min(1, SCREENSHOT_MAX_WIDTH / (clip.width * dsf), 7900 / (clip.height * dsf));
  // LOAD-BEARING, not tidiness. In a HEADFUL browser — which is the whole fleet,
  // since the bridge drives the user's own window — a drawn action highlight IS
  // included in what captureScreenshot returns (probe-measured,
  // `tests/visual/overlay-highlight.spec.ts`). These bytes become a model image
  // block and click_at inverts their pixel mapping, so a box left up is read as
  // page content and aimed at like page content.
  // It clears the ROOT session's box only: a box on a child (OOPIF) session is
  // taken down by the op-scoped clear in perform(), and what this line really
  // covers is a stale root box a restarted worker no longer remembers drawing.
  await sendCdp({ tabId: tab.id }, "Overlay.hideHighlight", {}).catch(() => {});
  const { data } = await sendCdp({ tabId: tab.id }, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 75,
    clip: { ...clip, scale },
    ...(beyondViewport ? { captureBeyondViewport: true } : {}),
  });
  if (!data) {
    throw new Error("The browser returned an empty screenshot. Retry after the page settles.");
  }
  // MEASURE what came back instead of trusting what was asked for (issue #66).
  // `scale × zoom × dsf` is a PREDICTION assembled from Page.getLayoutMetrics;
  // #66's measured ≈×1.145 skew is consistent with a bitmap 7/8 of that
  // prediction (every pixel click inheriting the 8/7 error, invisibly), and
  // nothing ever compared the two. The JPEG's own frame header is the ground truth and costs
  // one header parse. Only the first few KB are decoded — the SOF marker sits
  // near the front — with a whole-image retry for an encoder that buries it
  // behind a large EXIF/ICC block, and the prediction survives as the fallback
  // for a reply this parser cannot read at all.
  const measured =
    jpegDimensions(base64ToBytes(data, JPEG_HEADER_PROBE_BYTES)) ||
    jpegDimensions(base64ToBytes(data));
  const pxPerCss = scale * zoom * dsf;
  const imageWidth = measured?.width || Math.max(1, Math.round(cssClipWidth * pxPerCss));
  const imageHeight = measured?.height || Math.max(1, Math.round(cssClipHeight * pxPerCss));
  // Remember this capture's pixel→CSS mapping so click_at can invert it. Only
  // a viewport capture's origin coincides with the input coordinate space;
  // element/fullPage clips are page-absolute and must be refused there. URL,
  // scroll origin, and viewport size anchor the click-time drift check — which
  // reads CSS metrics, so the clip dimensions are stored in CSS px.
  lastShot = {
    tabId: tab.id,
    url: tab.url || "",
    mode,
    scale,
    clipWidth: cssClipWidth,
    clipHeight: cssClipHeight,
    // Image px per CSS px of the page: what was asked for times what the
    // protocol applied on top. `scale` alone was the whole mapping only at 100%
    // zoom on an unscaled display. Kept as the FALLBACK the per-axis measured
    // factors below fall through to.
    pxPerCss,
    // The mapping click_at actually inverts: measured bitmap ÷ CSS clip, per
    // axis, because a rounded bitmap edge is not exactly the same fraction on
    // both and a coordinate near the far edge is where that shows.
    imageWidth,
    imageHeight,
    pxPerCssX: imageWidth / cssClipWidth,
    pxPerCssY: imageHeight / cssClipHeight,
    // Reported in the note only when they are not 1 — the numbers that explain
    // a surprising factor to whoever is measuring pixels on the image.
    zoom,
    dsf,
    pageX: viewport.pageX || 0,
    pageY: viewport.pageY || 0,
  };
  // Say what size image this IS. Nothing else in the five layers does, so a
  // pixel coordinate was previously measured against a guess. Appended AFTER the
  // beyondViewport caveat: that one says do not measure coordinates here at all,
  // which reframes this line, and capNote truncates the tail.
  const imageNote = screenshotImageNote({
    mode,
    imageWidth,
    imageHeight,
    cssWidth: cssClipWidth,
    cssHeight: cssClipHeight,
    zoom,
    dsf,
  });
  note = [note, imageNote].filter(Boolean).join(" ");
  return { imageBase64: data, imageMimeType: "image/jpeg", ...(note ? { note } : {}) };
}

/**
 * `zoom`: capture a REGION of the visible viewport, magnified. The region is in
 * viewport CSS px — the space screenshot's note and click_at's mapping line
 * report — and is converted exactly like captureShot's clip (CSS → DIP × the
 * browser zoom; the bitmap is DIP × scale × the display factor). Unlike a
 * viewport screenshot the scale may go ABOVE 1 (zoomShotScale: up to
 * ZOOM_MAX_PX_PER_CSS image px per CSS px, bounded by the edge cap and the
 * standard vision fit), which is the whole point of the op.
 *
 * It records `lastShot` in mode "region" (origin = the region's top-left), so
 * click_at/drag pixel coordinates measured on the zoom image land where the
 * model saw them — and the note says so, since the previous viewport
 * screenshot's coordinates stop meaning anything once this mapping replaces it.
 * Never captureBeyondViewport: the region must be ON screen, so the live surface
 * is captured and no responsive re-layout can happen around it.
 */
async function captureZoom(tab, message) {
  const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
  const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
  const zoom = Number(viewport.zoom) > 0 ? Number(viewport.zoom) : 1;
  const physical = metrics.visualViewport || {};
  const pxPerCssRaw =
    Number(physical.clientWidth) > 0 && Number(viewport.clientWidth) > 0
      ? physical.clientWidth / viewport.clientWidth
      : zoom;
  const dsf = pxPerCssRaw / zoom || 1;
  const viewWidth = Math.round(viewport.clientWidth || 1024);
  const viewHeight = Math.round(viewport.clientHeight || 768);
  const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : NaN);
  let x = Math.round(num(message.x));
  let y = Math.round(num(message.y));
  let width = Math.round(num(message.width));
  let height = Math.round(num(message.height));
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) {
    return {
      refusal: {
        ok: false,
        message: "zoom needs x, y, width and height: a rectangle in viewport CSS px with a non-negative origin.",
      },
    };
  }
  if (x >= viewWidth || y >= viewHeight) {
    return {
      refusal: {
        ok: false,
        message:
          `The region starts outside the visible viewport (${viewWidth}×${viewHeight} CSS px). ` +
          "Coordinates are viewport CSS px — scroll the target into view first, or take a screenshot to measure it.",
      },
    };
  }
  // Clipped to what is ON screen: the part beyond the edge does not exist in
  // this frame, and the note reports the region actually captured.
  width = Math.min(width, viewWidth - x);
  height = Math.min(height, viewHeight - y);
  if (width < ZOOM_MIN_EDGE_CSS || height < ZOOM_MIN_EDGE_CSS) {
    return {
      refusal: {
        ok: false,
        message: `The region is too small to capture (minimum ${ZOOM_MIN_EDGE_CSS}×${ZOOM_MIN_EDGE_CSS} CSS px on screen).`,
      },
    };
  }
  const clip = {
    x: (x + (viewport.pageX || 0)) * zoom,
    y: (y + (viewport.pageY || 0)) * zoom,
    width: Math.max(1, Math.round(width * zoom)),
    height: Math.max(1, Math.round(height * zoom)),
  };
  const scale = zoomShotScale(clip.width, clip.height, { dsf, zoom, maxEdge: SCREENSHOT_MAX_WIDTH });
  // Same load-bearing hide as captureShot: a drawn highlight is in the bitmap.
  await sendCdp({ tabId: tab.id }, "Overlay.hideHighlight", {}).catch(() => {});
  const { data } = await sendCdp({ tabId: tab.id }, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 85,
    clip: { ...clip, scale },
  });
  if (!data) {
    throw new Error("The browser returned an empty capture. Retry after the page settles.");
  }
  const measured =
    jpegDimensions(base64ToBytes(data, JPEG_HEADER_PROBE_BYTES)) || jpegDimensions(base64ToBytes(data));
  const pxPerCss = scale * zoom * dsf;
  const imageWidth = measured?.width || Math.max(1, Math.round(width * pxPerCss));
  const imageHeight = measured?.height || Math.max(1, Math.round(height * pxPerCss));
  lastShot = {
    tabId: tab.id,
    url: tab.url || "",
    mode: "region",
    scale,
    clipWidth: width,
    clipHeight: height,
    regionX: x,
    regionY: y,
    viewportWidth: viewWidth,
    viewportHeight: viewHeight,
    pxPerCss,
    imageWidth,
    imageHeight,
    pxPerCssX: imageWidth / width,
    pxPerCssY: imageHeight / height,
    zoom,
    dsf,
    pageX: viewport.pageX || 0,
    pageY: viewport.pageY || 0,
  };
  const note = zoomImageNote({ imageWidth, imageHeight, x, y, cssWidth: width, cssHeight: height });
  return { imageBase64: data, imageMimeType: "image/jpeg", note };
}

// ------------------------------------------------------------------ read_url

/** Whole read_url budget: tab creation, every redirect hop, the body read. */
const READ_URL_TIMEOUT_MS = 15_000;
/** Raw body bytes read before the stream is abandoned. */
const READ_URL_MAX_BYTES = 256 * 1024;
/** Decoded (and pretty-printed) characters returned. */
const READ_URL_MAX_CHARS = 100_000;
/** Redirect hops followed before giving up (each one judged against the allowlist). */
const READ_URL_MAX_HOPS = 10;
const READ_URL_IO_CHUNK = 64 * 1024;

/**
 * GET one URL and return its body as text — the reader for data pages and
 * APIs. See the CDP_ALLOWLIST paragraph for why a short-lived BACKGROUND TAB
 * (inactive, inside the Noah group so the user can see it, closed before this
 * returns) and not a worker fetch. What each request step is held to:
 *
 *  - every hop (the first request and each redirect's next one) is paused at the
 *    REQUEST stage and must be http(s) and pass originAllowed with NO clipboard
 *    staging exemption — Noah's own origin is never readable this way — or it is
 *    failed before it is sent;
 *  - the final response is paused at the RESPONSE stage: a non-text Content-Type
 *    (isTextLikeContentType) is failed before the body is read, so a binary or
 *    download never lands; a text one is read through a stream, at most
 *    READ_URL_MAX_BYTES, and then the request is failed anyway — the document
 *    never commits, so no page script runs and nothing renders;
 *  - GET only (it is a navigation), no request body, no header from the model;
 *    the browser sends the cookies a top-level navigation to that URL sends.
 *
 * Never touches the WORKING tab or its uids. The result carries the final URL on
 * `fetchUrl`, never `url`, which every other op uses for the working tab.
 */
async function readUrl(message, patterns, source) {
  const requested = typeof message.url === "string" ? message.url : "";
  let parsed;
  try {
    parsed = new URL(requested);
  } catch {
    return { ok: false, message: "read_url needs an absolute http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "read_url reads http(s) URLs only." };
  }
  if (!originAllowed(requested, patterns, null)) return refuseOrigin(requested, source);
  const group = await noahGroup();
  if (!group) {
    return {
      ok: false,
      message:
        `read_url works through a short-lived background tab inside the "${GROUP_TITLE}" tab group, and there is ` +
        "no such group yet. Open a page with mcp__browser__new_tab first (the user approves creating the group), " +
        "then retry.",
    };
  }
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  const tabId = created.id;
  readUrlTabs.add(tabId);
  let listener = null;
  try {
    await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
    await attachDebugger(tabId);
    const target = { tabId };
    const outcome = await new Promise((resolve) => {
      let hops = 0;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            message:
              `read_url timed out after ${READ_URL_TIMEOUT_MS / 1000}s without a response it could read. The ` +
              "server may be slow, or a service worker answered the page (which this reader cannot intercept) — " +
              "open it with mcp__browser__new_tab and read it with mcp__browser__read_text instead.",
          }),
        READ_URL_TIMEOUT_MS,
      );
      const fail = (requestId, reason) =>
        sendCdp(target, "Fetch.failRequest", { requestId, errorReason: reason }).catch(() => {});
      listener = (src, method, params) => {
        if (src.tabId !== tabId || src.sessionId || method !== "Fetch.requestPaused" || settled) return;
        const requestId = params?.requestId;
        const hopUrl = String(params?.request?.url || "");
        const atResponse =
          params?.responseStatusCode != null || params?.responseErrorReason != null;
        void (async () => {
          try {
            if (!atResponse) {
              hops += 1;
              if (hops > READ_URL_MAX_HOPS + 1) {
                await fail(requestId, "BlockedByClient");
                finish({ ok: false, message: `read_url gave up after ${READ_URL_MAX_HOPS} redirects.` });
                return;
              }
              if (!originAllowed(hopUrl, patterns, null)) {
                await fail(requestId, "BlockedByClient");
                const refused = refuseOrigin(hopUrl, source);
                finish({
                  ok: false,
                  message:
                    (hops > 1
                      ? `read_url was REDIRECTED to ${urlWithoutQuery(hopUrl)}, outside the allowlist, so that ` +
                        "hop was never requested and nothing was read. "
                      : "") + refused.message,
                });
                return;
              }
              await sendCdp(target, "Fetch.continueRequest", { requestId });
              return;
            }
            if (params?.responseErrorReason) {
              finish({ ok: false, message: `read_url's request failed: ${params.responseErrorReason}.` });
              return;
            }
            const status = Number(params.responseStatusCode);
            // A redirect surfaced at the response stage: continue, and its next
            // hop arrives at the REQUEST stage above to be judged.
            if (status >= 300 && status < 400 && headerValue(params.responseHeaders, "location")) {
              await sendCdp(target, "Fetch.continueRequest", { requestId });
              return;
            }
            const contentType = headerValue(params.responseHeaders, "content-type");
            if (!isTextLikeContentType(contentType)) {
              await fail(requestId, "BlockedByClient");
              finish({
                ok: false,
                message:
                  `${urlWithoutQuery(hopUrl)} answered HTTP ${status} with content type ` +
                  `"${mediaTypeOf(contentType).slice(0, 80) || "(none)"}", which is not text, so its body was not ` +
                  "read. read_url returns text only (JSON, text/*, XML, CSV); for an image or document, open it " +
                  "with mcp__browser__new_tab and use screenshot, or ask the user for the file.",
              });
              return;
            }
            const chunks = [];
            let total = 0;
            let bytesTruncated = false;
            try {
              const { stream } = await sendCdp(target, "Fetch.takeResponseBodyAsStream", { requestId });
              try {
                for (;;) {
                  const read = await sendCdp(target, "IO.read", { handle: stream, size: READ_URL_IO_CHUNK });
                  if (read.data) {
                    const bytes = read.base64Encoded
                      ? base64ToBytes(read.data)
                      : new TextEncoder().encode(read.data);
                    chunks.push(bytes);
                    total += bytes.length;
                  }
                  if (total >= READ_URL_MAX_BYTES) {
                    bytesTruncated = !read.eof || total > READ_URL_MAX_BYTES;
                    break;
                  }
                  if (read.eof) break;
                }
              } finally {
                await sendCdp(target, "IO.close", { handle: stream }).catch(() => {});
              }
            } catch {
              // A build without stream support: one bounded whole-body read.
              const body = await sendCdp(target, "Fetch.getResponseBody", { requestId });
              const bytes = body.base64Encoded
                ? base64ToBytes(body.body || "")
                : new TextEncoder().encode(body.body || "");
              chunks.push(bytes);
              total = bytes.length;
              bytesTruncated = total > READ_URL_MAX_BYTES;
            }
            await fail(requestId, "Aborted");
            const all = new Uint8Array(Math.min(total, READ_URL_MAX_BYTES));
            let offset = 0;
            for (const chunk of chunks) {
              if (offset >= all.length) break;
              const piece = chunk.subarray(0, all.length - offset);
              all.set(piece, offset);
              offset += piece.length;
            }
            const shaped = formatFetchedBody(decodeBody(all, contentType), contentType, {
              maxChars: READ_URL_MAX_CHARS,
              bytesTruncated,
            });
            finish({
              ok: true,
              fetchUrl: hopUrl,
              fetchStatus: status,
              fetchContentType: mediaTypeOf(contentType).slice(0, 100),
              fetchBody: shaped.body,
              fetchBytes: all.length,
              fetchTruncated: shaped.truncated,
              fetchHops: hops,
            });
          } catch (error) {
            finish({ ok: false, message: `read_url failed: ${String(error?.message || error)}` });
          }
        })();
      };
      chrome.debugger.onEvent.addListener(listener);
      sendCdp(target, "Fetch.enable", {
        patterns: [
          { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
          { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
        ],
      })
        .then(() =>
          // Not awaited for its result: with the request paused, Page.navigate
          // only answers once the listener above has decided, and a navigation
          // we fail on purpose answers with an error that means nothing here.
          sendCdp(target, "Page.navigate", { url: requested }).catch(() => {}),
        )
        .catch((error) =>
          finish({ ok: false, message: `read_url could not start: ${String(error?.message || error)}` }),
        );
    });
    return outcome;
  } finally {
    if (listener) chrome.debugger.onEvent.removeListener(listener);
    readUrlTabs.delete(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

/** Wait for the tab to stop loading, so a snapshot reflects the new page. */
function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete" || Date.now() - started > timeoutMs) {
          resolve();
          return;
        }
      } catch {
        resolve();
        return;
      }
      setTimeout(poll, 250);
    };
    setTimeout(poll, 250);
  });
}

// --------------------------------------------------------------------- uid map

/**
 * chrome.storage.session key the viewer page reads — and deletes — on load.
 */
const UID_MAP_KEY = "uidMapPayload";

/**
 * Largest base64 image the hand-off will carry, in characters. The payload
 * travels through chrome.storage.session, which holds 10MB in total, so a tall
 * page has to be retried smaller rather than written into a quota that would
 * reject it.
 */
const UID_MAP_MAX_BASE64 = 8_000_000;

/**
 * The "which uid sits where" answer for the popup: ONE full-page capture of the
 * working tab plus the document-space box of every uid still live on it, handed
 * to the extension's own viewer page through storage.session.
 *
 * This is the USER reading the agent's uid map, not an agent op, so it does not
 * go through perform(): no snapshot tail, no audit relay, no prose result. It
 * also touches nothing the agent's next op depends on — see the lastShot note at
 * the capture below, which is the one way a read like this could break a write.
 *
 * Answers a CODE, never a sentence. Everything a person reads here is Korean and
 * lives in the popup and the viewer; this file is English by rule.
 */
async function buildUidMap() {
  try {
    const { patterns } = await readPolicy();
    let tab;
    try {
      tab = await targetTab();
    } catch {
      // targetTab throws NO_TAB_MESSAGE, which is agent-facing prose about tab
      // groups. The popup has its own sentence for this, so only the code travels.
      return { ok: false, code: "no_tab" };
    }
    // targetTab may have left a which-tab caveat behind for perform() to drain.
    // It is written FOR the agent ("call mcp__browser__list_tabs before acting
    // further") and this build is not the agent's turn, so it is dropped here
    // rather than surfacing on the agent's next op as a fallback that happened
    // during somebody else's read.
    takeTabNotice();

    // Gated exactly like a read, even though the user asked for this and only the
    // user's own browser ever sees the result. Two reasons to keep it literal: a
    // uid only exists where the agent already worked, and that was gated by this
    // same rule, so a denied page can only be holding stale uids anyway; and the
    // extension's stated contract is that nothing outside the allowlist is read,
    // while a full-page capture is the largest read there is. No sender origin
    // reaches an internal message, so the /browser-clip/ staging exemption is
    // passed nothing and can never match.
    if (tab.url && !originAllowed(tab.url, patterns, null)) {
      return { ok: false, code: "origin_denied" };
    }

    // The uids to place: fresh ones on this tab's ROOT session. An OOPIF's uids
    // are COUNTED but never placed — their backendNodeIds live in another id
    // space and their bounds are relative to their own document, so composing
    // them onto this capture needs a per-session capture and an offset chain that
    // v1 does not do.
    const rootEpoch = docEpoch(tab.id, undefined);
    const live = [];
    let skippedFrames = 0;
    for (const [uid, ref] of refMap) {
      if (ref.tabId !== tab.id) continue;
      if (ref.sessionId) {
        if (ref.epoch === docEpoch(ref.tabId, ref.sessionId)) skippedFrames += 1;
        continue;
      }
      // A stale-epoch uid resolves to whatever inherited its backendNodeId after
      // the navigation (see docEpochs). Drawing it would put a confident label on
      // the wrong element, which is worse than leaving it out, so it is not even
      // counted as skipped: it is not a uid anyone can still use.
      if (ref.epoch !== rootEpoch) continue;
      live.push({ uid, backendNodeId: ref.backendNodeId });
    }
    // Nothing to map. Refused BEFORE attaching on purpose: asking for a map of a
    // page the agent never snapshotted must not pop Chrome's debugger infobar
    // over an empty answer.
    if (!live.length && !skippedFrames) return { ok: false, code: "no_uids" };

    await ensureAttached(tab.id);

    // ONE snapshot, and the ROOT document only. documents[1..] are the
    // same-process iframes, whose bounds are relative to their OWN document
    // origin — so a root-session uid minted inside one (getFullAXTree crosses
    // those frame boundaries, and so does the AX-invisible section) is absent
    // from the map below and lands in the same skipped bucket as an OOPIF's.
    // extraClickables is not reusable here despite reading the same arrays: it
    // FINDS candidates and pays for `computedStyles: ["cursor"]` to do it, while
    // this needs the box of ids that are already chosen.
    const captured = await sendCdp({ tabId: tab.id }, "DOMSnapshot.captureSnapshot", {
      computedStyles: [],
    });
    const rootDoc = captured?.documents?.[0];
    const strings = Array.isArray(captured?.strings) ? captured.strings : [];
    const backendIds = rootDoc?.nodes?.backendNodeId || [];
    const nodeNames = rootDoc?.nodes?.nodeName || [];
    const layoutNodes = rootDoc?.layout?.nodeIndex || [];
    const layoutBounds = rootDoc?.layout?.bounds || [];
    /** backendNodeId -> { bounds: [x, y, w, h] in document CSS px, tag }. */
    const boxOf = new Map();
    for (let slot = 0; slot < layoutNodes.length; slot += 1) {
      const index = layoutNodes[slot];
      const backendNodeId = backendIds[index];
      // FIRST slot wins: an inline element broken across lines gets one layout
      // entry per fragment, and the first fragment is where the element starts.
      if (backendNodeId == null || boxOf.has(backendNodeId)) continue;
      const bounds = layoutBounds[slot];
      if (!Array.isArray(bounds)) continue;
      const nameIndex = nodeNames[index];
      const name =
        typeof nameIndex === "number" && nameIndex >= 0 ? String(strings[nameIndex] ?? "") : "";
      boxOf.set(backendNodeId, { bounds, tag: name.toLowerCase() });
    }

    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const content = metrics.cssContentSize || {};
    // The same fields and the same height cap captureShot's fullPage branch
    // reads: past the cap the browser hands back a cut-off image, so the cap is
    // also the line the boxes below are cropped against.
    const docWidth = Math.max(1, Math.round(content.width || viewport.clientWidth || 1024));
    const docHeight = Math.max(
      1,
      Math.round(
        Math.min(content.height || viewport.clientHeight || 768, SCREENSHOT_MAX_FULL_HEIGHT),
      ),
    );
    // Only the captured REGION crosses into the protocol's DIP space (CSS px ×
    // zoom — captureShot's unit note); the payload below stays CSS. The viewer
    // draws boxes in exactly the doc.width/height space this payload declares
    // and CSS-sizes the bitmap onto it, so converting the declared size or the
    // box geometry too would move every box off its element.
    const zoom = Number(viewport.zoom) > 0 ? Number(viewport.zoom) : 1;

    const boxes = [];
    let skippedCropped = 0;
    for (const { uid, backendNodeId } of live) {
      const found = boxOf.get(backendNodeId);
      if (!found) {
        // Detached, `display: none` (no layout entry exists at all), or living in
        // one of the documents this map deliberately does not read.
        skippedFrames += 1;
        continue;
      }
      const x = Number(found.bounds[0]) || 0;
      const y = Number(found.bounds[1]) || 0;
      const w = Number(found.bounds[2]) || 0;
      const h = Number(found.bounds[3]) || 0;
      // EITHER axis collapsed is nothing to draw, not something to crop: a
      // zero-width element has a position and a height and would otherwise fall
      // through to the clip below and be counted as cut off, which it is not.
      // Counting it as SHOWN is the other wrong answer — it would sit in uidCount
      // with no box anyone can find.
      if (w <= 0 || h <= 0) {
        skippedFrames += 1;
        continue;
      }
      // Clipped to the captured rectangle, because the viewer positions boxes in
      // exactly the doc.width/height space this payload declares: a box outside
      // it points at pixels the image does not contain. A tall page cut by the
      // height cap is the common case; off-page-left or above is the same fact.
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      const right = Math.min(docWidth, x + w);
      const bottom = Math.min(docHeight, y + h);
      if (right <= left || bottom <= top) {
        skippedCropped += 1;
        continue;
      }
      boxes.push({ uid, x: left, y: top, w: right - left, h: bottom - top, tag: found.tag });
    }

    // NOT captureShot, and `lastShot` is deliberately left untouched: that
    // variable is the pixel→CSS anchor click_at inverts for the AGENT's most
    // recent screenshot, so a user-triggered capture writing to it would silently
    // re-aim the agent's next pixel click at this page-absolute geometry. The
    // agent's action highlight is left standing for the same reason — it is the
    // agent's live state, and a read has no business taking it down.
    const capture = async (scale) => {
      const { data } = await sendCdp({ tabId: tab.id }, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(1, Math.round(docWidth * zoom)),
          height: Math.max(1, Math.round(docHeight * zoom)),
          scale,
        },
        captureBeyondViewport: true,
      });
      return String(data || "");
    };
    // Halving is a WHOLE-payload move: the contract carries no scale field, so
    // the boxes and the declared document size have to shrink with the image or
    // every box lands at twice its offset.
    let scale = 1;
    let data = await capture(scale);
    if (data.length > UID_MAP_MAX_BASE64) {
      scale = 0.5;
      data = await capture(scale);
    }
    if (!data || data.length > UID_MAP_MAX_BASE64) return { ok: false, code: "capture_failed" };

    const payload = {
      // Unscrubbed, unlike a note or an audit row: this payload never leaves the
      // user's own browser, and telling them which page they are looking at is
      // most of what the viewer's header is for.
      url: tab.url || "",
      title: tab.title || "",
      capturedAt: Date.now(),
      doc: { width: Math.round(docWidth * scale), height: Math.round(docHeight * scale) },
      image: { dataUrl: `data:image/jpeg;base64,${data}` },
      boxes: boxes.map((box) => ({
        uid: box.uid,
        x: Math.round(box.x * scale),
        y: Math.round(box.y * scale),
        // Never rounded away to nothing. A hairline element (or any box once the
        // half-scale retry has run) can measure well under a pixel, and a zero
        // dimension is a box the viewer cannot draw — which would leave uidCount
        // promising more than the map shows, in neither skipped bucket.
        w: Math.max(1, Math.round(box.w * scale)),
        h: Math.max(1, Math.round(box.h * scale)),
        tag: box.tag,
      })),
      skipped: { frames: skippedFrames, cropped: skippedCropped },
    };
    // Handed over through storage.session rather than in a message: it is
    // megabytes, and the viewer opens as its own tab that has to be able to read
    // it even after this worker has idled out. The default TRUSTED_CONTEXTS
    // access level is what keeps a web page from reading it.
    await chrome.storage.session.set({ [UID_MAP_KEY]: payload });
    await chrome.tabs.create({ url: chrome.runtime.getURL("uid-map.html") });
    return { ok: true, uidCount: payload.boxes.length };
  } catch {
    // A refused attach, a failed CDP call, a payload the quota rejected: one code
    // covers all of it. Nothing here may throw through the message channel — an
    // unanswered sendMessage reads in the popup as an extension that is gone.
    return { ok: false, code: "capture_failed" };
  }
}

// -------------------------------------------------------------- message entry

/**
 * A ref carries the tab that minted it, which may not be the current one after
 * a tab switch. Re-check THAT tab: still in the group, still on an allowed
 * origin. Without this, a uid captured on an allowed page could be actioned
 * after the tab left the group or navigated somewhere denied.
 */
async function assertRefTabUsable(uid, patterns, source, stagingOrigin) {
  const ref = refMap.get(uid);
  if (!ref) return null;
  const tab = await groupedTabById(ref.tabId);
  if (tab.url && !originAllowed(tab.url, patterns, stagingOrigin)) {
    return refuseOrigin(tab.url, source);
  }
  return null;
}

/**
 * Ops exempt from the CURRENT-url origin gate, because they are the way OUT of a
 * denied page and both check their own DESTINATION before moving. Gating them on
 * where the tab already sits is what stranded a tab an Adobe PDF-viewer
 * extension had hijacked: every op refused while quoting the stuck URL, and the
 * only recovery left was new_tab + close_tab. Everything else still refuses —
 * reading or acting on a denied page is the risk this gate exists for — and the
 * post-action landing check still decides what may be READ.
 */
const ORIGIN_EXEMPT_OPS = new Set(["navigate", "navigate_back"]);

/** Shared by both back paths for the ONE thing they can both establish: there is
 * no earlier entry. The CDP path reads that off the history; the escape path can
 * only infer it from chrome.tabs.goBack's rejection, so it must be sure the
 * rejection actually says so — see BACK_EXHAUSTED_REJECTION. */
const NO_HISTORY_MESSAGE =
  "This tab has no earlier history entry to go back to. Open a page explicitly with mcp__browser__navigate instead.";

/**
 * chrome.tabs.goBack rejecting because the history really is exhausted, which is
 * the only rejection NO_HISTORY_MESSAGE may be told about.
 *
 * On an unattachable page this call has more than one failure mode, and mapping
 * every rejection to "nothing to go back to" was measured to be a lie: a tab
 * hijacked by a PDF viewer answered that while the earlier entry demonstrably
 * existed. `tabs.goBack` needs access to the tab's CURRENT page (unlike
 * `tabs.update({url})`, which is why the navigate escape works), so another
 * extension's page can refuse it on grounds that have nothing to do with the
 * history. Diagnosing a missing entry there sends the agent looking for a
 * problem it does not have while hiding the exit that does work.
 *
 * Matched on Chrome's own phrasing ("Cannot find a previous page in history.").
 * Anything unrecognized is reported verbatim rather than translated — an
 * unfamiliar rejection is exactly the case where inventing a cause is the bug.
 * Note this predicate is the SECONDARY guard: the primary verdict is the
 * post-condition below, because the common failure never rejects at all.
 */
const BACK_EXHAUSTED_REJECTION = /page in history|cannot go back|no (?:previous|earlier) (?:page|entry)/i;

/**
 * The escape `goBack` did not take the tab anywhere, for a reason that is NOT
 * history exhaustion. Two distinct failures land here — an outright rejection,
 * and the silent no-op — so say which one was actually observed and nothing
 * beyond it, then point at the op that IS measured to work from such a page.
 */
function backEscapeFailure({ error = null, url = "" } = {}) {
  // Chrome's own rejections already end in a period; quoting them verbatim into
  // a sentence of ours must not produce "page..".
  const raw = String(error?.message || error || "").trim().replace(/\.+$/, "");
  const observed = error
    ? `The browser refused the back step itself${raw ? `: ${raw}` : ""}.`
    : `The back step reported success but left the tab on the same page${url ? ` (${url})` : ""}.`;
  return {
    ok: false,
    message:
      "Going back from this page did not move the tab, and NOT because the history is empty — an earlier " +
      `entry may well exist. ${observed} ` +
      "This happens on pages the bridge cannot attach to (another extension's viewer, chrome://): stepping back " +
      "there does not work and retrying will not change it. Leave with mcp__browser__navigate to an explicit " +
      "http(s) URL, which does work from here, or open a fresh page with mcp__browser__new_tab.",
  };
}

/**
 * Re-attach after an extension-API navigation, best effort. The tail's snapshot
 * needs CDP and the tab has hopefully landed somewhere attachable; if it has
 * not, the landing check refuses first and the snapshotError path reports the
 * rest, so a failure here must not become the op's failure.
 */
async function reattachAfterEscape(tabId) {
  try {
    await ensureAttached(tabId);
  } catch {
    // Still unattachable. Nothing here can fix that, and the caller's own
    // reporting is more accurate than anything this catch could invent.
  }
}

async function performOp(message, stagingOrigin) {
  const { patterns, source } = await readPolicy();
  // The uid counter as it stands BEFORE this op acts: any uid above it in the
  // confirm snapshot belongs to an element that APPEARED because of the action
  // (a menu's popup items, a dialog's controls), which capSnapshot keeps ahead
  // of the document-order bulk — see its newUidFloor pass.
  const uidFloorBefore = refSeq;
  // Once per op, so every showActionHighlight below stays a synchronous check
  // that cannot add a round trip to the action it is illustrating.
  highlightActionsOn = await readHighlightPref();

  // Tab management runs before the current-tab origin check: listing and
  // switching must work even when the tab you are on is not allowlisted,
  // otherwise a single denied tab strands the agent with no way to move.
  if (message.op === "list_tabs") {
    const tabs = await groupedTabs();
    if (!tabs.length) return { ok: false, message: NO_TAB_MESSAGE };
    await targetTab(); // settle `current` before describing
    return { ok: true, tabs: (await groupedTabs()).map(describeTab) };
  }

  // read_url never touches the working tab: it runs in its own short-lived
  // background tab, so it is answered before the working tab is even resolved.
  if (message.op === "read_url") {
    return readUrl(message, patterns, source);
  }

  if (message.op === "new_tab") {
    if (!originAllowed(message.url, patterns, stagingOrigin)) {
      return refuseOrigin(message.url, source);
    }
    // A clipboard staging page is a THROWAWAY the bridge closes itself once the
    // page's title reports COPIED, so where the agent is right now is the thing
    // the close will have to restore. Read before anything below can move the
    // pointer: setCurrentTab(created.id) overwrites it, and after that the
    // pre-staging id is gone for good.
    const stagingTab = isClipboardStagingUrl(message.url, stagingOrigin);
    const returnTo = stagingTab ? (currentTabId ?? (await storedTabId())) : null;
    let group = await noahGroup();
    // No group = browser control is currently OFF in this browser. Turning it
    // on must be the user's click, not a tab-creation side effect, so ask
    // first — and on refusal, leave nothing behind.
    if (!group) {
      const consent = await requestGroupConsent(message.url);
      if (!consent.granted) return { ok: false, message: consent.reason };
      // The user may have created the group by hand while the popup was open.
      group = await noahGroup();
    }
    const created = await chrome.tabs.create({ url: message.url, active: false });
    // Join the existing group, or start the one just approved — a tab the
    // agent opened carries none of the user's other state, and it stays
    // visible and revocable in the same green group as everything else.
    const groupId = await chrome.tabs.group(
      group ? { tabIds: [created.id], groupId: group.id } : { tabIds: [created.id] },
    );
    if (!group) {
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "green" });
    }
    setCurrentTab(created.id);
    if (stagingTab && returnTo != null) rememberClipReturn(created.id, returnTo);
    await waitForLoad(created.id);
  }

  if (message.op === "select_tab") {
    const picked = await groupedTabById(message.tabId);
    setCurrentTab(picked.id);
    // No snapshot: switching tabs used to fall through to the tail and return a
    // full page walk nobody asked for. Answer like list_tabs does — and from the
    // same pre-gate position, so a denied tab can still be switched away from.
    return {
      ok: true,
      url: picked.url || "",
      title: picked.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "close_tab") {
    const picked = await groupedTabById(message.tabId);
    await chrome.tabs.remove(picked.id);
    attached.delete(picked.id);
    forgetTabRefs(picked.id);
    lastSnapshotByTab.delete(picked.id);
    forgetClipReturn(picked.id);
    if (currentTabId === picked.id) setCurrentTab(null);
    const left = await groupedTabs();
    if (!left.length) {
      return { ok: true, tabs: [], url: "", title: "", snapshot: "" };
    }
  }

  // Baseline for the new-tab announcement in the tail. Taken AFTER the
  // tab-management branches so new_tab's own tab is not announced as a surprise.
  const tabIdsBefore = new Set((await groupedTabs()).map((one) => one.id));

  const tab = await targetTab();
  // Check the tab we are ABOUT to read as well as any URL we are asked to open:
  // an allowed navigation can land somewhere else via a redirect, and a tab the
  // user dragged in may already be sitting on a denied site.
  const originExempt = ORIGIN_EXEMPT_OPS.has(message.op);
  if (!originExempt && tab.url && !originAllowed(tab.url, patterns, stagingOrigin)) {
    return refuseOrigin(tab.url, source);
  }
  // Whether THIS op has to move the tab through the extension API instead of
  // CDP. Only the exempt ops can escape that way, and only because they are the
  // way OUT: everything else still requires a debugger session, and silently
  // running it without one would be the wrong kind of forgiving.
  let escapeViaTabsApi = false;
  if (originExempt && debuggerUnreachable(tab.url)) {
    // A doomed attach buys nothing but its own error, so it is not attempted.
    escapeViaTabsApi = true;
  } else if (message.op === "dialog_status") {
    // BOUNDED for this op alone, and only because the attach is part of what it
    // measures: ensureAttached's DOM/Accessibility/Page enables are all
    // renderer-bound, so a native dialog blocking the renderer stalls THEM as
    // surely as it stalls the probe below — and the attach is cold in exactly
    // the field case (the MV3 worker idles out between turns, Chrome detaches
    // with it, and the dialog opens in that gap). Unbounded, the op that exists
    // to explain a hang would itself hang. Every other op is untouched and waits
    // exactly as long as it did.
    const attachOutcome = await probeWithin(ensureAttached(tab.id), DIALOG_PROBE_ATTACH_TIMEOUT_MS);
    if (attachOutcome === PROBE_TIMED_OUT) {
      return dialogProbeStuckResult(tab, DIALOG_PROBE_ATTACH_TIMEOUT_MS);
    }
    // An attach that ERRORED answered, so it is not the dialog signature: let it
    // propagate exactly as it does for every other non-exempt op.
    if (attachOutcome.error) throw attachOutcome.error;
  } else {
    try {
      await ensureAttached(tab.id);
    } catch (error) {
      // Reactive half: catches the surfaces DEBUGGER_UNREACHABLE_PREFIXES does
      // not enumerate, and the race where the tab moved between the read above
      // and this attach. Non-exempt ops keep today's behavior exactly — the
      // error is theirs and it propagates.
      if (!originExempt) throw error;
      escapeViaTabsApi = true;
    }
  }
  // read_text with `expand` scrolls, and wheel events go through the
  // browser-side input router — dropped unless the tab's view is visible.
  if (VISIBLE_OPS.has(message.op) || (message.op === "read_text" && message.expand)) {
    await showTab(tab);
    // `screenshot`/`zoom` mint their own frame by capturing; every other op here
    // is about to DISPATCH input and needs the compositor awake first (occluded
    // windows drop mouse press/release — see ensureFrameForInput).
    if (message.op !== "screenshot" && message.op !== "zoom") await ensureFrameForInput(tab);
  }

  // An open JS dialog freezes the renderer: every page-touching command below
  // would hang. Surface the dialog instead — only handle_dialog may proceed.
  //
  // `dialog_status` is deliberately NOT excluded alongside it: this guard IS the
  // answer to the probe whenever the dialog is tracked, and dialogBlockedResult
  // reports the dialog's own type and message, which is strictly more than the
  // probe branch below could say. The branch therefore only ever runs for the
  // case the event tracking cannot see (a dialog that opened before we attached).
  if (message.op !== "handle_dialog" && pendingDialogs.has(tab.id)) {
    return dialogBlockedResult(tab);
  }

  // click_at's pre-click hit-test result, reported alongside the snapshot so a
  // blind coordinate click states what it actually hit.
  let landedOn = null;
  /**
   * The element a PIXEL-mode op (click_at, drag) hit-tested at its acted point.
   * Those ops carry no uid, which starved the confirm snapshot's focus pass of
   * exactly the neighbourhood the action changed (round 12: a pixel drag moved a
   * calendar event and the returned snapshot truncated both weeks involved).
   * Minting this a uid anchors the cap the same way message.uid does.
   */
  let actedBackendNodeId = null;
  // BRIDGE-authored caveat about this op's outcome (a repaired or unverifiable
  // clear) — not page content, and the reason a clear can no longer end silently.
  let note = "";

  // A uid-scoped snapshot resolves its element BEFORE any page work, so a uid
  // from a previous page fails with the uid error rather than after a full walk.
  let snapshotScope = null;
  if (message.op === "snapshot" && message.uid) {
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    snapshotScope = resolveRef(message.uid);
    // A scoped snapshot IS the agent looking at that element, so it earns a box
    // like the acting ops do.
    showActionHighlight(snapshotScope);
  }
  // `maxChars` caps whatever snapshot THIS op returns, not just the snapshot
  // op's own two forms: every action answers with a full page walk, and an agent
  // that only needed to confirm one click had no way to say so — it paid the
  // whole default budget on every step of a long task. clampSnapshotChars reads
  // a non-number as "not asked", so an op that never carries the field is
  // unaffected, and read_text/screenshot/select_tab return before the tail.
  const snapshotChars = clampSnapshotChars(message.maxChars);

  // Read-only extraction ops answer directly: their payload REPLACES the
  // snapshot, so the common action tail below (which walks the AX tree again)
  // would only double what the agent pays for.
  if (message.op === "read_text") {
    let scope = null;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      scope = resolveRef(message.uid);
      showActionHighlight(scope);
    }
    const offset = Math.min(Math.max(Math.round(Number(message.offset) || 0), 0), 5_000_000);
    // `expand` is page-level by definition (scrolling loads content relative
    // to the viewport, not one element); the server refuses uid+expand, and
    // ignoring expand here keeps a mixed call honest rather than wrong.
    const full =
      message.expand && !scope ? await buildExpandedPageText(tab) : await buildPageText(tab, scope);
    return {
      ok: true,
      pageText: full.slice(offset, offset + READ_TEXT_MAX),
      pageTextOffset: Math.min(offset, full.length),
      pageTextTotal: full.length,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  // `find` filters the SAME atoms a snapshot renders (findAtoms, axtree.js), so
  // it reads exactly what `snapshot` reads — getFullAXTree plus the one
  // DOMSnapshot capture — and adds NOTHING to the CDP allowlist. Its uids are
  // minted by the same mintUid as a snapshot's, so click/type take them as-is.
  // No audit row (the route treats it like snapshot) and no lastSnapshotByTab
  // write: a filtered view must not become the baseline the stale-snapshot
  // re-poll compares a full one against.
  if (message.op === "find") {
    let scope = null;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      scope = resolveRef(message.uid);
    }
    const role = typeof message.role === "string" ? message.role.slice(0, 64) : "";
    const name = typeof message.name === "string" ? message.name.slice(0, 200) : "";
    if (!role.trim() && !name.trim()) {
      return { ok: false, message: "find needs `role`, `name`, or both." };
    }
    const atoms = scope ? await buildScopedSnapshot(tab, scope) : await buildSnapshot(tab);
    const found = findAtoms(atoms, { role, name, limit: FIND_MAX_MATCHES });
    const asked = [
      role.trim() ? `role "${quoteForNote(role.trim())}"` : "",
      name.trim() ? `name containing "${quoteForNote(name.trim())}"` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    let findNote;
    if (found.total === 0) {
      findNote =
        `No element with a uid matched ${asked}${scope ? " inside that element" : ""}.` +
        (found.textOnly
          ? ` The text does appear in ${found.textOnly} line${found.textOnly === 1 ? "" : "s"} that carry no uid ` +
            "(plain text, not actionable) — read around it with mcp__browser__read_text or a scoped snapshot."
          : " Try a shorter name, drop the role, or take a snapshot to see what the page calls it.");
    } else if (found.total > found.lines.length) {
      findNote =
        `${found.total} elements matched ${asked}; showing the first ${found.lines.length} in page order. ` +
        "More matches exist — narrow it with `role`, a longer `name`, or a `uid` scope.";
    } else {
      findNote = `${found.total} element${found.total === 1 ? "" : "s"} matched ${asked}.`;
    }
    return {
      ok: true,
      snapshot: found.lines.join("\n"),
      note: capNote(findNote),
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "screenshot") {
    const shot = await captureShot(tab, message);
    return {
      ok: true,
      ...shot,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "zoom") {
    const shot = await captureZoom(tab, message);
    if (shot.refusal) return shot.refusal;
    return {
      ok: true,
      ...shot,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "read_cookies") {
    // Consent per site, per browser session, in the user's own browser UI — the
    // un-bypassable gate (requestDataConsent prompts on the FIRST read of a
    // (host, "cookies") and remembers an approval for the session). The current
    // tab already passed the origin allowlist above (read_cookies is NOT
    // origin-exempt and the debugger is attached), so this only ever prompts for
    // a site the operator already permits.
    let host = "";
    try {
      host = new URL(tab.url || "").hostname;
    } catch {
      // Unparseable tab URL: fall back to the raw string for the popup.
    }
    const consent = await requestDataConsent(host || tab.url || "", "cookies");
    if (!consent.granted) return { ok: false, message: consent.reason };
    let raw;
    try {
      // Scoped to the current tab's URL ONLY — never the whole cookie jar, and
      // never a cross-site cookie. getCookies is a command, not an event
      // subscription, so it needs no Network.enable (see the CDP_ALLOWLIST
      // rationale). httpOnly cookies (the session token) are included.
      ({ cookies: raw } = await sendCdp({ tabId: tab.id }, "Network.getCookies", {
        urls: [tab.url],
      }));
    } catch (error) {
      return {
        ok: false,
        message: `Could not read the tab's cookies: ${String(error?.message || error)}`,
      };
    }
    let cookies = (Array.isArray(raw) ? raw : []).map((c) => ({
      name: String(c?.name ?? ""),
      value: String(c?.value ?? ""),
      domain: String(c?.domain ?? ""),
      path: String(c?.path ?? ""),
      httpOnly: Boolean(c?.httpOnly),
      secure: Boolean(c?.secure),
      sameSite: typeof c?.sameSite === "string" ? c.sameSite : undefined,
      // CDP reports -1 for a session cookie; surface only a real expiry.
      expires: typeof c?.expires === "number" && c.expires > 0 ? c.expires : undefined,
    }));
    if (message.name) {
      cookies = cookies.filter((c) => c.name === message.name);
    }
    return {
      ok: true,
      cookies,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "read_storage") {
    // Consent per site, PER STORAGE TYPE, per browser session, in the user's own
    // browser UI — the un-bypassable gate (requestDataConsent prompts on the
    // FIRST read of a (host, type) and remembers an approval for the session).
    // read_storage is NOT origin-exempt, so the current tab already passed the
    // origin allowlist above; this only ever prompts for a site the operator
    // already permits. localStorage routinely holds bearer/JWT tokens, so it
    // gets the SAME treatment as cookies.
    let host = "";
    try {
      host = new URL(tab.url || "").hostname;
    } catch {
      // Unparseable tab URL: fall back to the raw string for the popup.
    }
    const type = message.kind === "local" ? "local" : "session";
    const consent = await requestDataConsent(host || tab.url || "", type);
    if (!consent.granted) return { ok: false, message: consent.reason };
    // The ONE page-JS exception (see the file header + CDP_ALLOWLIST rationale):
    // Web Storage is unreachable over chrome.debugger any other way — DOMStorage
    // is not in its domain allowlist — so read the store with a FIXED,
    // bridge-authored expression selected by the already-validated `type`. The
    // tab URL, message.name, and message.kind NEVER enter the expression; it runs
    // in the CURRENT tab's main frame only, so only this origin's storage is read.
    const expression = type === "local" ? READ_LOCAL_STORAGE_EXPR : READ_SESSION_STORAGE_EXPR;
    const storeLabel = type === "local" ? "localStorage" : "sessionStorage";
    let evaluated;
    try {
      evaluated = await sendCdp({ tabId: tab.id }, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: false,
        userGesture: false,
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not read the tab's ${storeLabel}: ${String(error?.message || error)}`,
      };
    }
    // A page-side throw surfaces as exceptionDetails — fail closed rather than
    // report an empty read as success.
    if (evaluated?.exceptionDetails) {
      return {
        ok: false,
        message: `Could not read the tab's ${storeLabel}: the page raised an error while reading storage.`,
      };
    }
    // result.value is the JSON string the fixed expression returned ("[]" on any
    // in-page failure). Parse defensively — anything unparseable or non-array
    // fails closed to an empty list, and every entry is treated as untrusted page
    // content below.
    let entries = [];
    try {
      const parsed = JSON.parse(String(evaluated?.result?.value ?? "[]"));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
    // Entries arrive as [key, value] pairs; the optional name filter is applied
    // HERE, on the parsed result, never inside the evaluated expression.
    let storage = entries.map((pair) => ({
      key: String(pair?.[0] ?? ""),
      value: String(pair?.[1] ?? ""),
    }));
    if (message.name) {
      storage = storage.filter((entry) => entry.key === message.name);
    }
    return {
      ok: true,
      storage,
      storageKind: type,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "dialog_status") {
    // Field case (Confluence, 2026-08-28): a draft-restore dialog opened before
    // the bridge attached to the tab, so it never raised
    // Page.javascriptDialogOpening and pendingDialogs stayed empty. Every click
    // failed, none of them said why, and the agent could only INFER the dialog
    // from the pattern of failures. This op is the missing question — and it is
    // side-effect free: no input, no navigation, no snapshot walk.
    //
    // The tracked dialog is already answered by the guard above, so reaching
    // here means the maps say the page is clear and the only remaining evidence
    // is whether the RENDERER answers at all. DOM.getDocument at depth 0 is the
    // cheapest allowlisted call that needs the renderer: one node, no subtree,
    // no page JS. A dialog blocks it exactly as it blocks a snapshot.
    const outcome = await probeWithin(
      sendCdp({ tabId: tab.id }, "DOM.getDocument", { depth: 0 }),
      DIALOG_PROBE_TIMEOUT_MS,
    );
    // No `tabs` on the two non-answering paths: chrome.tabs data would be
    // truthful (it is browser-process state, not the page's), but a result that
    // lists tabs reads as a page the bridge is talking to normally, which is the
    // very impression this branch exists to correct.
    if (outcome === PROBE_TIMED_OUT) return dialogProbeStuckResult(tab, DIALOG_PROBE_TIMEOUT_MS);
    if (outcome.error) {
      return {
        ok: true,
        note: dialogProbeFailedNote(outcome.error),
        url: tab.url || "",
        title: tab.title || "",
      };
    }
    // Identity only, like select_tab: a probe is not a READ, and returning a
    // snapshot here would make asking about a dialog cost a full page walk.
    return {
      ok: true,
      note: DIALOG_PROBE_CLEAR_NOTE,
      url: tab.url || "",
      title: tab.title || "",
      tabs: (await groupedTabs()).map(describeTab),
    };
  }

  if (message.op === "handle_dialog") {
    const dialog = pendingDialogs.get(tab.id);
    if (!dialog) {
      return {
        ok: false,
        message:
          "No JavaScript dialog is open on this tab, so there is nothing to answer. Take a snapshot to see the current page state.",
      };
    }
    await sendCdp(dialog.target, "Page.handleJavaScriptDialog", {
      accept: Boolean(message.accept),
      ...(message.promptText != null ? { promptText: String(message.promptText) } : {}),
    });
    pendingDialogs.delete(tab.id);
    // Answering can resume a submit or navigation the dialog was holding up.
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "navigate") {
    // The destination check is unchanged and still runs BEFORE any movement —
    // which mechanism carries the tab there does not change WHERE it may go.
    if (!originAllowed(message.url, patterns, stagingOrigin)) {
      return refuseOrigin(message.url, source);
    }
    if (escapeViaTabsApi) {
      // Security-equivalent to the CDP path, and deliberately so: this is the
      // same call new_tab already makes to open a page, it runs no page JS, and
      // it passed the identical destination check one line above. The no-page-JS
      // invariant is untouched and the CDP allowlist is not widened — it is
      // bypassed only on the surfaces where Chrome itself makes CDP unreachable.
      await chrome.tabs.update(tab.id, { url: message.url });
    } else {
      await sendCdp({ tabId: tab.id }, "Page.navigate", { url: message.url });
    }
    await waitForLoad(tab.id);
    if (escapeViaTabsApi) await reattachAfterEscape(tab.id);
  } else if (message.op === "navigate_back") {
    if (escapeViaTabsApi) {
      // Page.getNavigationHistory IS CDP, so on an unattachable page the
      // destination cannot be read and the pre-check is impossible. Accepted
      // tradeoff: the step is taken BLIND, but the post-action landing check
      // still decides what may be READ, and stepping back from a page the bridge
      // cannot even attach to is at worst neutral — it is already reading
      // nothing there.
      const before = (await chrome.tabs.get(tab.id)).url || "";
      try {
        await chrome.tabs.goBack(tab.id);
      } catch (error) {
        // Only the rejection that actually reports an exhausted history gets the
        // shared text; anything else is reported as the refusal it is, without
        // naming a cause we did not observe.
        if (BACK_EXHAUSTED_REJECTION.test(String(error?.message || error || ""))) {
          return { ok: false, message: NO_HISTORY_MESSAGE };
        }
        return backEscapeFailure({ error });
      }
      await waitForLoad(tab.id);
      // The verdict that matters, because the common failure never rejects.
      // Measured 2026-08-09 on a PDF-viewer-hijacked tab whose earlier entry was
      // PROVEN to exist (stepped back to it over CDP moments before the hijack):
      // goBack resolves cleanly and moves nothing, twice in a row. Trusting the
      // catch alone let the caller be told the step "completed" when the tab had
      // not budged — a worse lie than the one this replaced, since it invited
      // reading a page the agent had never left.
      const after = (await chrome.tabs.get(tab.id)).url || "";
      if (before && after === before) return backEscapeFailure({ url: after });
      await reattachAfterEscape(tab.id);
    } else {
      const { currentIndex, entries } = await sendCdp(
        { tabId: tab.id },
        "Page.getNavigationHistory",
        {},
      );
      const previous = currentIndex > 0 ? (entries || [])[currentIndex - 1] : null;
      if (!previous) {
        return { ok: false, message: NO_HISTORY_MESSAGE };
      }
      // The destination is known BEFORE moving — refuse a back step into a
      // denied origin instead of visiting it and refusing afterwards.
      if (previous.url && !originAllowed(previous.url, patterns, stagingOrigin)) {
        return refuseOrigin(previous.url, source);
      }
      await sendCdp({ tabId: tab.id }, "Page.navigateToHistoryEntry", { entryId: previous.id });
      await waitForLoad(tab.id);
    }
  } else if (message.op === "click") {
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    const ref = resolveRef(message.uid);
    // Before the guards on purpose: what the agent is ABOUT to touch is worth
    // showing even when a guard then refuses to touch it. Safe there because a
    // drawn box takes no part in hit-testing, so the obscured check below still
    // sees the page (probe-measured, `tests/visual/overlay-highlight.spec.ts`).
    showActionHighlight(ref);
    // #64: read the disclosure state BEFORE the click, but only if this element
    // is a menu/disclosure trigger. A trigger toggles on each click, so a bridge
    // that answers a bare "clicked" for a menu that stayed shut invites the agent
    // to click again and close the menu the first press opened. Fail open: any
    // CDP error leaves it an ordinary click with no note.
    let disclosureTrigger = false;
    let expandedBefore = null;
    try {
      const { node } = await sendCdp(
        { tabId: ref.tabId, sessionId: ref.sessionId },
        "DOM.describeNode",
        { backendNodeId: ref.backendNodeId, depth: 0 },
      );
      const attrs = flatAttrs(node);
      if (isDisclosureTrigger(attrs)) {
        disclosureTrigger = true;
        expandedBefore = ariaExpandedOf(attrs);
      }
    } catch {
      // fail open — treat as an ordinary click
    }
    // Guards and click stay INSIDE the race: every step here talks to the
    // renderer, and a dialog raised by a page timer mid-measurement would hang
    // the scroll/quad reads exactly as it would hang the click itself.
    await raceDialogOpen(
      tab.id,
      (async () => {
        await refuseFileInput(ref);
        // The point is computed once and reused: the guard has to hit-test the
        // SAME pixel the click lands on, or it is answering a different question.
        const point = await centerOf(ref);
        await assertNotObscured(ref, point);
        await clickPoint(point.target, point.x, point.y);
      })(),
    );
    await waitForLoad(tab.id, 5000);
    // #64: did the trigger actually open? Re-read `aria-expanded` after a beat
    // and note the two failure modes — never the successes, never a guess. Fail
    // open: a read error leaves no note, exactly as a non-trigger click does.
    if (disclosureTrigger) {
      try {
        await new Promise((resolve) => setTimeout(resolve, DISCLOSURE_SETTLE_MS));
        const { node } = await sendCdp(
          { tabId: ref.tabId, sessionId: ref.sessionId },
          "DOM.describeNode",
          { backendNodeId: ref.backendNodeId, depth: 0 },
        );
        const outcome = disclosureClickOutcome(expandedBefore, ariaExpandedOf(flatAttrs(node)));
        if (outcome === "not-opened") note = DISCLOSURE_NOT_OPENED_NOTE;
        else if (outcome === "toggled-closed") note = DISCLOSURE_TOGGLED_CLOSED_NOTE;
        // "opened" and "unknown" stay quiet.
      } catch {
        // fail open — no note
      }
    }
  } else if (message.op === "click_at" && typeof message.uid === "string" && message.uid) {
    // uid mode: a RELATIVE position inside a known element. No screenshot is
    // involved, so this is the escape hatch that still works for a canvas or a
    // map when the conversation's model cannot receive images at all.
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    const ref = resolveRef(message.uid);
    showActionHighlight(ref);
    await refuseFileInput(ref);
    const { target, quads } = await quadsOf(ref);
    if (!quads.length) {
      return { ok: false, message: "The element is not visible on screen, so it cannot be clicked." };
    }
    const { x: px, y: py } = boxPoint(quads, message.xFraction, message.yFraction);
    // Hit-test the SAME point on the SAME session the click goes to, so a
    // frame-local coordinate is resolved in the space it was measured in. If
    // the spaces disagree anyway, describePoint's containment cross-check
    // fails and reports nothing — a missing description beats a false one.
    const described = await describePoint(target, px, py);
    // A fraction inside an element that is not itself a file input can still
    // land ON one, and the OS dialog it opens is unrecoverable either way.
    if (described?.fileInput) {
      return { ok: false, message: `${FILE_INPUT_REFUSAL} The click was NOT dispatched.` };
    }
    landedOn = described?.text ?? null;
    await raceDialogOpen(tab.id, clickPoint(target, px, py));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "click_at") {
    const x = message.x;
    const y = message.y;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0
    ) {
      return {
        ok: false,
        message:
          "click_at needs numeric, non-negative `x` and `y` — pixel coordinates measured on the most recent viewport screenshot.",
      };
    }
    // A viewport capture's image origin IS the viewport origin, so no offset
    // applies (shotCssPoint enforces the mode). Hit-test BEFORE clicking: the
    // click itself may change what sits there.
    const point = await shotCssPoint(tab, x, y);
    if (point.refusal) return point.refusal;
    const { cssX, cssY } = point;
    // State the mapping this click used. The landed-on element below says WHAT
    // was hit; without the mapping beside it, a mis-scaled coordinate SPACE
    // (issue #66) is indistinguishable from a mis-measured target, and the agent
    // retried the same numbers.
    note = [note, pixelPointNote({ ...point, x, y })].filter(Boolean).join(" ");
    const described = await describePoint({ tabId: tab.id }, cssX, cssY);
    // The only op whose subject is a COORDINATE, so the hit test above is also
    // the only thing that knows which element to draw on. Root session by
    // construction: these pixels come from a viewport screenshot of this tab.
    if (described?.backendNodeId) {
      showActionHighlight({
        tabId: tab.id,
        sessionId: undefined,
        backendNodeId: described.backendNodeId,
      });
    }
    // A pixel click has no uid to check, so this hit test is the ONLY thing
    // between a screenshot coordinate and the OS file dialog — and a file input
    // looks like an ordinary button in both the image and the snapshot.
    if (described?.fileInput) {
      return { ok: false, message: `${FILE_INPUT_REFUSAL} The click was NOT dispatched.` };
    }
    landedOn = described?.text ?? null;
    actedBackendNodeId = described?.backendNodeId ?? null;
    await raceDialogOpen(tab.id, clickPoint({ tabId: tab.id }, cssX, cssY));
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "drag") {
    const isCoord = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const uidMode = typeof message.uid === "string" && Boolean(message.uid);
    const pixelMode =
      isCoord(message.x) && isCoord(message.y) && isCoord(message.toX) && isCoord(message.toY);
    if (uidMode && (isCoord(message.toX) || isCoord(message.toY))) {
      return {
        ok: false,
        message:
          "drag takes ONE mode, not a mix: uid mode (`uid`/`toUid` with fractions) or pixel mode (`x`/`y` → `toX`/`toY`).",
      };
    }
    if (!uidMode && !pixelMode) {
      return {
        ok: false,
        message:
          "drag needs either uid mode — `uid` (+ xFraction/yFraction) as the start, and `toUid` " +
          "(+ toXFraction/toYFraction) as the end (same element when toUid is omitted) — or pixel mode: all four of " +
          "`x`, `y`, `toX`, `toY`, measured on the most recent viewport screenshot.",
      };
    }
    let target;
    let from;
    let to;
    if (uidMode) {
      const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      const startRef = resolveRef(message.uid);
      const endUid = typeof message.toUid === "string" && message.toUid ? message.toUid : "";
      let endRef = startRef;
      if (endUid) {
        const endRefused = await assertRefTabUsable(endUid, patterns, source, stagingOrigin);
        if (endRefused) return endRefused;
        endRef = resolveRef(endUid);
        // One mouse sequence lives on ONE renderer session; two frames would
        // each see only their half of it, which is not a drag anywhere.
        if (endRef.tabId !== startRef.tabId || endRef.sessionId !== startRef.sessionId) {
          return {
            ok: false,
            message:
              "The drag's two elements live in DIFFERENT frames, and one mouse sequence cannot span two renderer " +
              "sessions. Drag within one frame, or take a viewport screenshot and use pixel mode.",
          };
        }
      }
      showActionHighlight(startRef);
      await refuseFileInput(startRef);
      // Both endpoints must be measured in ONE scroll state, and quadsOf
      // SCROLLS (the round-10 torn-clip lesson). So: bring the end on screen
      // first, the start second — the start's coordinates are then freshest —
      // and RE-read the end without scrolling, in that final state.
      if (endRef !== startRef) {
        const endFirst = await quadsOf(endRef);
        if (!endFirst.quads.length) {
          return { ok: false, message: "The drag's end element is not visible on screen." };
        }
      }
      const startBox = await quadsOf(startRef);
      if (!startBox.quads.length) {
        return { ok: false, message: "The drag's start element is not visible on screen." };
      }
      target = startBox.target;
      from = boxPoint(startBox.quads, message.xFraction, message.yFraction);
      if (endRef === startRef) {
        to = boxPoint(startBox.quads, message.toXFraction, message.toYFraction);
      } else {
        const endNow = await rawQuadsOf(endRef);
        if (!endNow.quads.length) {
          return {
            ok: false,
            message:
              "The drag's start and end cannot both be brought on screen at once, so one mouse motion cannot " +
              "connect them. Scroll until both are visible, or break the move into shorter drags.",
          };
        }
        to = boxPoint(endNow.quads, message.toXFraction, message.toYFraction);
        // getContentQuads answers for an off-viewport element too (coordinates
        // simply leave the viewport), so visibility of the END in the FINAL
        // scroll state has to be checked against the viewport itself — on the
        // element's own session, whose coordinate space the quads are in.
        const metrics = await sendCdp(target, "Page.getLayoutMetrics", {});
        const view = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
        const viewWidth = view.clientWidth || 0;
        const viewHeight = view.clientHeight || 0;
        if (
          viewWidth &&
          viewHeight &&
          (to.x < 0 || to.y < 0 || to.x > viewWidth || to.y > viewHeight)
        ) {
          return {
            ok: false,
            message:
              "The drag's start and end cannot both be brought on screen at once, so one mouse motion cannot " +
              "connect them. Scroll until both are visible, or break the move into shorter drags.",
          };
        }
      }
    } else {
      const start = await shotCssPoint(tab, message.x, message.y);
      if (start.refusal) return start.refusal;
      const end = await shotCssPoint(tab, message.toX, message.toY);
      if (end.refusal) return end.refusal;
      target = { tabId: tab.id };
      from = { x: start.cssX, y: start.cssY };
      to = { x: end.cssX, y: end.cssY };
      // Both ends of the mapping, for the same reason click_at reports its one
      // (issue #66): a drag that lands short is as likely to have a bad END as
      // a bad start, and neither is visible in the drop report alone. `start`
      // and `end` describe the same screenshot — shotCssPoint refuses anything
      // else — so one image size covers both.
      note = [
        note,
        pixelDragNote({
          ...start,
          x: message.x,
          y: message.y,
          toX: message.toX,
          toY: message.toY,
          toCssX: end.cssX,
          toCssY: end.cssY,
        }),
      ]
        .filter(Boolean)
        .join(" ");
      // A pixel drag has no uid to check, so this hit test is the only thing
      // between a screenshot coordinate and the OS file dialog a press on a
      // file input can open.
      const described = await describePoint(target, from.x, from.y);
      if (described?.backendNodeId) {
        showActionHighlight({
          tabId: tab.id,
          sessionId: undefined,
          backendNodeId: described.backendNodeId,
        });
      }
      if (described?.fileInput) {
        return { ok: false, message: `${FILE_INPUT_REFUSAL} The drag was NOT dispatched.` };
      }
    }
    await raceDialogOpen(tab.id, dragPointer(target, from, to));
    // What sits under the RELEASE point afterwards — the element that was
    // moved there, or the container it was dropped into. Best-effort: a drag
    // that navigated has nothing to describe, and that is not a failure.
    try {
      const dropped = await describePoint(target, to.x, to.y);
      landedOn = dropped?.text ?? null;
      // Anchor the confirm snapshot at the RELEASE point — where the effect is.
      // Root session only: a uid-mode drag inside an OOPIF already anchors via
      // message.uid, and mintUid below is a root-space minter.
      if (!target.sessionId) actedBackendNodeId = dropped?.backendNodeId ?? null;
    } catch {
      landedOn = null;
    }
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "type") {
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    // A stored secret rides `secretText`, NEVER `text` — so a build that predates
    // this feature reads `message.text || ""` and types nothing at all.
    const secret = message.secret && typeof message.secret === "object" ? message.secret : null;
    const text = secret ? String(message.secretText ?? "") : message.text || "";
    // Every gate BEFORE the highlight, so a refused secret does not even draw a
    // box on the field it was aimed at.
    if (secret) {
      const denial = await secretWriteRefusal(tab, resolveRef(message.uid), secret, text);
      if (denial) return { ok: false, message: denial };
    }
    // resolveRef is an idempotent map lookup, so resolving here purely to draw
    // the box costs nothing and typeRef resolving it again below is fine — that
    // is cheaper than threading a highlight through typeRef/fillField.
    showActionHighlight(resolveRef(message.uid));
    // raceDialogOpen resolves on whichever of the work or a dialog wins, so the
    // note is captured HERE rather than returned through it.
    await raceDialogOpen(
      tab.id,
      (async () => {
        note = await typeRef(
          message.uid,
          text,
          Boolean(message.submit),
          Boolean(message.keystrokes),
          Boolean(message.clear),
          secret,
        );
      })(),
    );
    if (message.submit) await waitForLoad(tab.id, 5000);
  } else if (message.op === "fill_form") {
    const fields = Array.isArray(message.fields) ? message.fields : [];
    if (!fields.length) {
      return {
        ok: false,
        message: "fill_form needs a non-empty `fields` array of { uid, value } entries.",
      };
    }
    // Per-field clear notes, attributed: with 25 fields in one call, "a clear
    // was repaired" is useless without saying WHICH field it was.
    const notes = [];
    for (let i = 0; i < fields.length; i += 1) {
      if (pendingDialogs.has(tab.id)) break; // frozen — the tail reports the open dialog
      const field = fields[i] || {};
      const uid = String(field.uid || "");
      const refused = await assertRefTabUsable(uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      // Per FIELD, not per call: one form can mix ordinary values with a secret,
      // and each secret carries its own policy.
      const secret = field.secret && typeof field.secret === "object" ? field.secret : null;
      const value = secret ? String(field.secretValue ?? "") : String(field.value ?? "");
      if (secret) {
        let denial = "";
        try {
          denial = await secretWriteRefusal(tab, resolveRef(uid), secret, value);
        } catch (error) {
          // A dead uid throws here; it is the same "this field was not filled"
          // outcome, so report it the same way rather than as an op failure.
          denial = String(error?.message || error);
        }
        if (denial) {
          return {
            ok: false,
            message:
              `Field ${i + 1} of ${fields.length} (uid "${uid}") was NOT filled: ${denial}` +
              (i ? " Fields before it were already filled — take a fresh snapshot and continue from there." : "") +
              (notes.length ? ` Notes from earlier fields: ${capNote(notes.join(" "))}` : ""),
          };
        }
      }
      try {
        // Per field, so the box HOPS down the form as it is filled — with 25
        // fields that is the point: the user follows where the writing is.
        // INSIDE the try because resolveRef throws on a dead uid, and that
        // throw belongs to the partial-progress report below, not to the op.
        showActionHighlight(resolveRef(uid));
        await raceDialogOpen(
          tab.id,
          (async () => {
            const fieldNote = await fillField(
              resolveRef(uid),
              value,
              Boolean(field.clear),
              undefined,
              secret,
            );
            if (fieldNote) notes.push(`Field ${i + 1} (uid "${uid}"): ${fieldNote}`);
          })(),
        );
      } catch (error) {
        // Partial progress is real progress: say exactly where it stopped so
        // the agent re-snapshots and continues instead of re-filling from zero.
        // "may hold partly-written text" covers the clearing failure, where the
        // field was written but the old value survived in front of it.
        return {
          ok: false,
          message:
            `Field ${i + 1} of ${fields.length} (uid "${uid}") could not be filled: ${String(error?.message || error)} ` +
            "Fields before it were already filled, and this one may hold partly-written text — " +
            "take a fresh snapshot and continue from there." +
            // An earlier field's caveat must not be lost just because a later
            // one failed outright: the ok:false reply carries only `message`.
            (notes.length ? ` Notes from earlier fields: ${capNote(notes.join(" "))}` : ""),
        };
      }
    }
    note = notes.join("\n");
  } else if (message.op === "select_option") {
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    showActionHighlight(resolveRef(message.uid));
    await raceDialogOpen(tab.id, selectOption(message.uid, String(message.option ?? "")));
    // A change handler can submit or navigate, same as a click.
    await waitForLoad(tab.id, 5000);
  } else if (message.op === "press_key") {
    let target = { tabId: tab.id };
    let ref = null;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      ref = resolveRef(message.uid);
      // Only when a uid was given: a keystroke aimed at the page as a whole has
      // no subject element to point at.
      showActionHighlight(ref);
      // Enter or Space on a FOCUSED file input opens the same OS dialog a click
      // does, so the refusal belongs on this path too.
      await refuseFileInput(ref);
      target = { tabId: ref.tabId, sessionId: ref.sessionId };
      await focusForInput(ref);
    }
    const repeat = Math.min(Math.max(Math.round(Number(message.repeat) || 1), 1), 50);
    // #65: a paste shortcut (Ctrl/Cmd+V). A rich-text/iframe editor can DISPLAY
    // a paste it never commits, so an immediate snapshot reads as success while
    // the text is dropped. Detection is pure JS — non-paste keys stay zero-cost.
    const pasteModifiers = Array.isArray(message.modifiers) ? message.modifiers : [];
    const isPaste =
      String(message.key || "").toLowerCase() === "v" &&
      (pasteModifiers.includes("Control") || pasteModifiers.includes("Meta"));
    // The grow-then-shrink measurement needs a readable target, so it runs ONLY
    // with a uid (a value node is then cheaply resolvable). Read `before` PRE-
    // dispatch. Fail open: any error leaves just the advisory note below.
    let pasteValueNode = null;
    let pasteBefore = null;
    if (isPaste && ref) {
      try {
        const resolved = await resolveValueNode(ref);
        if (resolved) {
          pasteValueNode = resolved.ref;
          pasteBefore = codePointLen(resolved.value);
        }
      } catch {
        // fail open — advisory note only
      }
    }
    await raceDialogOpen(
      tab.id,
      (async () => {
        for (let i = 0; i < repeat; i += 1) {
          if (pendingDialogs.has(tab.id)) return;
          await dispatchKey(target, String(message.key || ""), modifierMask(message.modifiers));
        }
      })(),
    );
    // Enter and shortcuts can submit or navigate, same as a click.
    await waitForLoad(tab.id, 5000);
    // #65: warn that the paste may only be DISPLAYED. The advisory is the floor
    // (uid or not); a measured grow-then-shrink upgrades it to the vanished note.
    if (isPaste) {
      note = PASTE_ADVISORY_NOTE;
      if (pasteValueNode) {
        try {
          await new Promise((resolve) => setTimeout(resolve, PASTE_PEAK_MS));
          const peak = codePointLen(await readAxValue(pasteValueNode));
          await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS - PASTE_PEAK_MS));
          const settled = codePointLen(await readAxValue(pasteValueNode));
          if (pastedTextVanished(pasteBefore, peak, settled)) note = PASTE_VANISHED_NOTE;
        } catch {
          // fail open — keep the advisory note
        }
      }
    }
  } else if (message.op === "hover") {
    const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
    if (refused) return refused;
    const hoverRef = resolveRef(message.uid);
    showActionHighlight(hoverRef);
    const { target, x, y } = await centerOf(hoverRef);
    await raceDialogOpen(
      tab.id,
      sendCdp(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      }),
    );
  } else if (message.op === "scroll") {
    const direction = ["up", "down", "left", "right"].includes(message.direction)
      ? message.direction
      : "down";
    const metrics = await sendCdp({ tabId: tab.id }, "Page.getLayoutMetrics", {});
    const viewport = metrics.cssVisualViewport || metrics.cssLayoutViewport || {};
    const viewWidth = viewport.clientWidth || 800;
    const viewHeight = viewport.clientHeight || 600;
    let target = { tabId: tab.id };
    let x = viewWidth / 2;
    let y = viewHeight / 2;
    if (message.uid) {
      const refused = await assertRefTabUsable(message.uid, patterns, source, stagingOrigin);
      if (refused) return refused;
      const scrollRef = resolveRef(message.uid);
      // Only the uid path has a subject: a plain page scroll points at nothing.
      showActionHighlight(scrollRef);
      ({ target, x, y } = await centerOf(scrollRef));
    }
    const span = direction === "left" || direction === "right" ? viewWidth : viewHeight;
    const requested = Number(message.pixels);
    const amount = Math.min(Math.max(Math.round(requested > 0 ? requested : span * 0.8), 1), 20000);
    await raceDialogOpen(
      tab.id,
      sendCdp(target, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
        deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0,
      }),
    );
  } else if (message.op === "wait_for") {
    const wantText = typeof message.text === "string" && message.text ? message.text : null;
    const goneText =
      typeof message.textGone === "string" && message.textGone ? message.textGone : null;
    if (!wantText && !goneText) {
      return {
        ok: false,
        message:
          "wait_for needs `text` (wait until it appears), `textGone` (wait until it disappears), or both.",
      };
    }
    // Bounded well inside the Noah client's 40s bridge budget, leaving room
    // for the final snapshot walk on a big page.
    const timeoutMs = Math.min(Math.max(Number(message.timeoutS) || 10, 1), 25) * 1000;
    const started = Date.now();
    for (;;) {
      if (pendingDialogs.has(tab.id)) break; // frozen page — reported below
      // Joined here: this matcher asks a question about the page as TEXT, and
      // the atoms exist for capSnapshot's benefit, not `includes`'s.
      //
      // WITHOUT the AX-invisible section: this loop re-walks the page every
      // 500ms for up to 25s and hands the agent no snapshot at all, so a
      // whole-document DOMSnapshot capture per poll would be paid on the user's
      // machine and thrown away. 0.16.0 cut this op's cost down for exactly that
      // reason — it stopped returning a snapshot entirely — and an element the
      // section would have named is not lost, only deferred: the action the
      // agent takes after the wait reads an enriched snapshot.
      const view = (await buildSnapshot(tab, { withExtraClickables: false })).join("\n");
      if ((!wantText || view.includes(wantText)) && (!goneText || !view.includes(goneText))) break;
      if (Date.now() - started >= timeoutMs) {
        return {
          ok: false,
          message:
            `Timed out after ${Math.round(timeoutMs / 1000)}s: ` +
            [
              wantText ? `"${wantText}" did not appear` : "",
              goneText ? `"${goneText}" did not disappear` : "",
            ]
              .filter(Boolean)
              .join(" and ") +
            ". Take a snapshot to inspect the current page state before deciding what to do next.",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } else if (!["snapshot", "new_tab", "select_tab", "close_tab"].includes(message.op)) {
    return { ok: false, message: `Unsupported operation "${message.op}".` };
  }

  // Let an action's async effect land before reading the page back. Without
  // this, typing a query returned a snapshot with no autocomplete layer in it
  // and the next identical call showed one — the action looked like a no-op.
  if (SETTLE_OPS.has(message.op)) {
    await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_MS));
  }

  // Re-check where we actually LANDED before reading the page: a permitted URL
  // can redirect somewhere denied, and the snapshot is the exfiltration path
  // that matters (reading a logged-in page is the risk, not just acting on it).
  let fresh = await chrome.tabs.get(tab.id);
  if (fresh.url && !originAllowed(fresh.url, patterns, stagingOrigin)) {
    return refuseLanding(message.op, fresh.url, source);
  }

  // The clipboard staging page has ONE job and its own title says when it is
  // done: the server's BROWSER_CLIP_SCRIPT writes "COPIED" the moment
  // clipboard.write* resolves. The tab is spent at that point, so close it and
  // put the pointer back on the page the agent came from — left open, every copy
  // strands a dead tab in the user's group and costs the agent a select_tab to
  // get home. Any op that lands here on a COPIED staging page closes it: a
  // snapshot of a spent page is worth no more than a click on one. The `new_tab`
  // that OPENED it never matches, because the button page's title is still
  // "클립보드로 복사". "COPY_FAILED" and any other title are left ALONE on purpose —
  // the copy did not happen, and the tab has to still be there for the user to
  // foreground the window and press the button, or for the agent to retry.
  if (isClipboardStagingUrl(fresh.url, stagingOrigin)) {
    // Only an INPUT op can have CAUSED a copy, so only an input op is worth
    // waiting on: a plain snapshot of an un-pressed staging page must not pay
    // CLIP_TITLE_SETTLE_MS for a title that has no reason to change. `fresh` is
    // REPLACED rather than read beside, so the auto-close below and the ordinary
    // tail both see the settled title — the COPY_FAILED the agent has to act on
    // is exactly as easy to read too early as the COPIED it must not miss.
    if (INPUT_OPS.has(message.op)) fresh = await settledClipStagingTab(fresh, stagingOrigin);
    if (fresh.title === CLIPBOARD_COPIED_TITLE) {
      try {
        return await closeClipStagingTab(fresh, note);
      } catch {
        // Fail-open. The COPY already succeeded, so failing the op over the
        // tidying that follows it would send the agent to re-copy bytes that are
        // on the clipboard right now. Answer the op the ordinary way instead.
      }
    }
  }

  // A dialog may have opened as a RESULT of the action (click → confirm). The
  // snapshot walk would hang on the frozen renderer — report the dialog
  // instead, keeping what a coordinate click landed on: the confirm() case is
  // exactly when knowing what was clicked matters most.
  if (pendingDialogs.has(tab.id)) {
    return {
      ...(await dialogBlockedResult(fresh)),
      ...(landedOn ? { landedOn } : {}),
      // A clear caveat outlives the interruption: the field still holds whatever
      // the note says it holds, and there is no snapshot here to check it against.
      ...(note ? { note: capNote(note) } : {}),
    };
  }

  // Cap the snapshot uid-first: an uncapped long page fails the whole model
  // turn, which made merely REACHING such a page count as an error. wait_for's
  // internal matching above deliberately uses the uncapped walk.
  //
  // The builders hand capSnapshot their ATOMS rather than joined text, so an
  // element holding many lines (a source file inside one textbox value) is kept
  // or dropped WHOLE instead of being cut into non-contiguous pieces. It still
  // returns the finished string, so lastSnapshotByTab compares exactly what it
  // compared before.
  let snapshot = "";
  let snapshotError;
  // The uid this op ACTED ON, so the cap spends its budget on that element's
  // surroundings before the page's document-order bulk (see capSnapshot's
  // focus pass). fill_form's subject is its LAST field — the most recent
  // write; the snapshot op's own uid already scoped the whole build.
  const explicitFocus =
    message.op === "fill_form"
      ? String((Array.isArray(message.fields) ? message.fields[message.fields.length - 1] : null)?.uid || "")
      : message.op !== "snapshot" && typeof message.uid === "string"
        ? message.uid
        : "";
  // A pixel-mode op has no uid, but its hit test already named the element at
  // the acted point — buildSnapshot resolves that node (or its nearest minted
  // ancestor: the hit test answers the DEEPEST node, which a walk rarely
  // prints) to a uid the cap can anchor on. It also backs up an explicit
  // focus whose element re-rendered out from under its own uid mid-op.
  const anchor = actedBackendNodeId != null ? { backendNodeId: actedBackendNodeId, uid: "" } : null;
  const readSnapshot = async () => {
    const atoms = snapshotScope
      ? await buildScopedSnapshot(fresh, snapshotScope)
      : await buildSnapshot(fresh, anchor ? { anchor } : undefined);
    const focusUid = explicitFocus || anchor?.uid || "";
    const fallbackFocusUid = anchor?.uid && anchor.uid !== focusUid ? anchor.uid : "";
    // Only an ACTING op gets the new-uid floor: a plain snapshot after a
    // navigation mints the whole page as "new", which would just re-derive
    // document order at a quarter of the budget.
    const capOpts = {
      ...(focusUid ? { focusUid, ...(fallbackFocusUid ? { fallbackFocusUid } : {}) } : {}),
      ...(INPUT_OPS.has(message.op) ? { newUidFloor: uidFloorBefore } : {}),
    };
    return capSnapshot(atoms, snapshotChars, Object.keys(capOpts).length ? capOpts : undefined);
  };
  // wait_for is the exception: it answers a yes/no question, and re-walking the
  // page to decorate that answer cost ~25 KB on the one op whose whole job is to
  // wait — often called several times in a row. Its loop above already matched
  // against a full (uncapped) walk, and the caller takes a snapshot when it
  // actually wants one. No snapshotError either: nothing was attempted.
  if (message.op !== "wait_for") {
    try {
      snapshot = await readSnapshot();
      // A BYTE-IDENTICAL snapshot after an action that changed the page is the
      // shape of a too-early read, not of a no-op: clicking "Add Element" returned
      // success while the new button was absent from the walk. flushLifecycle
      // forces the lifecycle tick, but the AX flush can still land a beat later, so
      // one bounded re-poll separates "the click did nothing" from the truth.
      if (SETTLE_OPS.has(message.op) && snapshot && lastSnapshotByTab.get(fresh.id) === snapshot) {
        await new Promise((resolve) => setTimeout(resolve, STALE_SNAPSHOT_REPOLL_MS));
        snapshot = await readSnapshot();
      }
      // An empty walk is RETRIED and then, if it stays empty, it SAYS so. Applies
      // to every op that reads back, not only the settling ones: a plain snapshot
      // can land mid-navigation too, when the page moved on its own. Scoped reads
      // are exempt — buildScopedSnapshot already answers a hollow scope in words,
      // and that note is the better answer than this one.
      if (!snapshot.trim() && !snapshotScope) {
        for (let attempt = 0; attempt < EMPTY_SNAPSHOT_REPOLLS && !snapshot.trim(); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, EMPTY_SNAPSHOT_REPOLL_MS));
          snapshot = await readSnapshot();
        }
        // First in the note, ahead of any tab notice appended below: an empty
        // view reframes every other line, and capNote truncates the tail.
        if (!snapshot.trim()) note = [EMPTY_SNAPSHOT_NOTE, note].filter(Boolean).join("\n");
      }
      lastSnapshotByTab.set(fresh.id, snapshot);
    } catch (error) {
      // The ACTION already happened. Reporting the whole op as failed because
      // the read-back broke made the agent retry it — navigating twice, clicking
      // twice. Say the action ran and the view is missing, separately.
      snapshotError = String(error?.message || error);
    }
  }
  // Always report the group's tabs: the agent needs to know a new tab appeared
  // (or that several are open) without spending a separate list_tabs round trip.
  const groupNow = await groupedTabs();
  // …and a target=_blank click ADDS one silently: the array changes and nothing
  // says so, so the agent kept driving the old page while the result it asked
  // for was on the new one. new_tab is exempt — its tab is in the baseline.
  const opened = message.op === "new_tab" ? [] : groupNow.filter((one) => !tabIdsBefore.has(one.id));
  if (opened.length) {
    note = [
      note,
      ...opened.map(
        (one) =>
          `A new tab opened during this ${message.op}: "${quoteForNote(one.title || "(untitled)")}" — ` +
          `${quoteForNote(one.url, NOTE_URL_MAX)} (tabId ${one.id}). It did NOT become the working tab; ` +
          "use mcp__browser__select_tab to work in it.",
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return {
    ok: true,
    snapshot,
    ...(snapshotError ? { snapshotError } : {}),
    url: fresh.url,
    title: fresh.title,
    tabs: groupNow.map(describeTab),
    ...(landedOn ? { landedOn } : {}),
    ...(note ? { note: capNote(note) } : {}),
  };
}

/**
 * The op, plus any working-tab notice targetTab left behind.
 *
 * It rides `note` — the existing BRIDGE-authored caveat channel, already relayed
 * and capped — rather than a new wire field, and it is folded in HERE so an op
 * with its own early-return shape (read_text, screenshot, a blocked dialog)
 * cannot drop it. A refusal carries no `note` across the wire, so there it joins
 * the message instead: "Blocked: <url>" is exactly the case where the reason may
 * BE that the bridge is on a tab the agent never chose. First in either string,
 * because it reframes every other line and capNote truncates the tail.
 */
async function perform(message, senderOrigin) {
  let result;
  try {
    result = await performOp(message, senderOrigin);
  } catch (error) {
    takeTabNotice(); // never let a stale notice surface on the NEXT op
    throw error;
  } finally {
    // OP-SCOPED, on every exit path — success, refusal, throw. The box lives
    // through the action, the settle wait and the snapshot tail (roughly half a
    // second to a second and a half of visibility) and dies with the op. A box
    // that persisted until the NEXT op instead would be stranded on screen for
    // good the moment the MV3 worker is torn down, because the restarted worker
    // has no memory of having drawn it. Running before the notice merging below
    // costs nothing: clearActionHighlight is synchronous fire-and-forget.
    clearActionHighlight();
  }
  const notice = takeTabNotice();
  if (!notice) return result;
  if (result?.ok === false) {
    return { ...result, message: `${notice} ${result.message || ""}`.trim() };
  }
  return { ...result, note: capNote([notice, result?.note].filter(Boolean).join(" ")) };
}

// `externally_connectable` restricts senders to the Noah origins declared in the
// manifest, and `sender.origin` is filled in by the browser, so the page cannot
// forge it. Re-check anyway: the manifest is the gate, this is the assertion.
/**
 * Read/write the local allowlist from the Noah page, so an operator can manage
 * it where they already are instead of hunting for the extension's options
 * page. Deliberately NOT a way around policy: when managed policy is present it
 * still wins in readPolicy(), and `setAllowedOrigins` refuses outright rather
 * than writing a list that would be silently ignored.
 */
async function handleConfig(message) {
  const { patterns, source } = await readPolicy();
  if (message.op === "getAllowedOrigins") {
    // `version` doubles as the compatibility probe for the chat status badge:
    // this op exists in every build, so asking costs nothing on old installs
    // (they simply answer without a version, which reads as "outdated").
    return { ok: true, patterns, source, version: chrome.runtime.getManifest().version };
  }
  if (message.op === "reloadExtension") {
    // One-click update: the Noah page rewrote this extension's folder (File
    // System Access) and asks for the equivalent of the chrome://extensions ↻
    // button, which re-reads every file for an unpacked install. Reply first,
    // reload on a delay — reload() tears this worker down, and an unanswered
    // message would read as failure on a page whose update actually succeeded.
    // Benign by design: it grants nothing and reads nothing, so any
    // externally_connectable Noah page may ask.
    setTimeout(() => chrome.runtime.reload(), 50);
    return { ok: true, version: chrome.runtime.getManifest().version };
  }
  if (message.op === "setAllowedOrigins") {
    if (source === "managed") {
      return {
        ok: false,
        message:
          "An administrator policy controls the allowed sites for this browser; it cannot be changed from here.",
      };
    }
    const next = Array.isArray(message.patterns)
      ? [...new Set(message.patterns.map((p) => String(p).trim().toLowerCase()).filter(Boolean))]
      : [];
    await chrome.storage.local.set({ [POLICY_KEY]: next });
    policyCache = null;
    return { ok: true, patterns: next, source: next.length ? "local" : "empty" };
  }
  return null;
}

/**
 * ONE execution per parked operation, however many Noah pages relay it.
 *
 * The field failure: a run watched from several open Noah tabs (the chat, the
 * settings page, an admin view) delivers its browser_op frame to EVERY tab, and
 * each tab's relay forwarded it here — the page-side requestId dedupe is a
 * per-tab Set, so the extension executed the same op once PER TAB. Ops are not
 * idempotent: type doubled its text ("se" arrived as "sese", a date part read
 * 202620-02-06), scroll travelled twice the distance and clamped at the
 * document end. This map is the one chokepoint every relay passes through, so
 * duplicates COALESCE here: the first arrival executes, every later one is
 * handed the SAME promise, and all pages answer the server with the same reply
 * (the server keeps the first respond POST for a requestId anyway).
 *
 * Two keys, two retirements:
 * - `requestId` (clients that forward it): retired minutes after settling,
 *   because a page that (re)attaches to a live run REPLAYS the whole event log
 *   into a fresh per-tab dedupe set and can re-send an op long after it ran.
 * - payload JSON (older clients that do not): retired seconds after settling.
 *   The agent awaits each op's reply before sending the next, so two LEGITIMATE
 *   identical ops can never overlap in flight — only twin-page duplicates can.
 */
const coalescedOps = new Map(); // key -> { run: Promise, retireMs }
const OP_COALESCE_MAX = 500;
const OP_RETIRE_REQUEST_ID_MS = 10 * 60 * 1000;
const OP_RETIRE_PAYLOAD_MS = 1500;

function performCoalesced(message, senderOrigin) {
  const requestId =
    typeof message.requestId === "string" && message.requestId ? message.requestId : null;
  const key = requestId ? `id:${requestId}` : `op:${JSON.stringify(message)}`;
  const existing = coalescedOps.get(key);
  if (existing) return existing.run;
  const run = perform(message, senderOrigin);
  coalescedOps.set(key, { run });
  if (coalescedOps.size > OP_COALESCE_MAX) {
    coalescedOps.delete(coalescedOps.keys().next().value);
  }
  const retire = () => {
    setTimeout(
      () => {
        if (coalescedOps.get(key)?.run === run) coalescedOps.delete(key);
      },
      requestId ? OP_RETIRE_REQUEST_ID_MS : OP_RETIRE_PAYLOAD_MS,
    );
  };
  run.then(retire, retire);
  return run;
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (!message || message.source !== "noah" || !sender.origin) {
    sendResponse({ ok: false, message: "Rejected: unrecognized sender." });
    return false;
  }
  const config = handleConfig(message);
  config
    // sender.origin rides along as the ONLY origin whose /browser-clip/ staging
    // page is exempt from the allowlist (originAllowed) — verified by the
    // browser, never taken from the message body.
    .then((reply) => (reply ? reply : performCoalesced(message, sender.origin)))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, message: String(error?.message || error) }));
  // Keep the channel open for the async reply.
  return true;
});

/**
 * The INTERNAL message surface, and it is a different trust story from the
 * EXTERNAL one above: the senders here are this extension's own pages (the
 * popup, the consent window), which a web page cannot impersonate — a site
 * declared in `externally_connectable` lands on onMessageExternal, where the
 * browser-verified `sender.origin` is checked. So there is no origin to verify
 * here, and no agent on the other end either: the popup's caller is the user.
 *
 * Unknown ops are LEFT ALONE — no response, no open channel — because the
 * consent page has its own listener on this same event, and a future internal op
 * must be addable without this one swallowing it.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.op !== "buildUidMap") return false;
  buildUidMap()
    .then(sendResponse)
    // buildUidMap answers a code for everything it can foresee; this is the
    // belt-and-braces path, because a listener that returns true and then never
    // calls sendResponse leaves the popup waiting forever.
    .catch(() => sendResponse({ ok: false, code: "capture_failed" }));
  // Keep the channel open for the async reply.
  return true;
});
