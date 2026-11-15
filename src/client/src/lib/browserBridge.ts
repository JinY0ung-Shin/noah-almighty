// Relay between a parked browser-bridge operation and the Noah browser
// extension. The page cannot touch another origin's DOM, so every operation is
// handed to the extension, which performs the CDP calls and answers.
//
// This module deliberately holds NO authority of its own: it forwards an
// operation the server already authorized and returns whatever the extension
// says. The trust boundary is this page's authenticated session — which is why
// the extension only accepts messages from this origin.
//
// ONE exception to "just a relay": an op may carry a stored secret's PLAINTEXT
// (`secretText` / a field's `secretValue`). It passes straight through to the
// extension and must never be logged, rendered, or written into app state —
// and it is only handed over once the installed build is known to understand
// it (`extensionSupportsSecretInput`), because an older build would silently
// type nothing.

import { defaultAllowlistFor } from "../../../shared/originPatterns";

/** The published extension id. Overridable for a locally loaded unpacked build. */
const EXTENSION_ID =
  (import.meta.env?.VITE_BROWSER_EXTENSION_ID as string | undefined) ||
  "gdaheigeedlnhagpmokpmocahgieiobc";

/** Wire shape the extension answers with. `ok:false` carries a model-facing reason. */
export interface BridgeReply {
  ok: boolean;
  message?: string;
  snapshot?: string;
  /** The action ran but the fresh snapshot could not be rendered — why. */
  snapshotError?: string;
  /** Bridge-authored caveat about the op's outcome (a repaired or unverifiable clear). */
  note?: string;
  url?: string;
  title?: string;
  tabs?: { tabId: string; title: string; url: string; current: boolean; busy?: boolean }[];
  /** A JS dialog is open on the tab (page frozen, no snapshot possible). */
  dialog?: { type: string; message: string; defaultPrompt?: string };
  /** screenshot: captured image bytes, base64 (no data: prefix). */
  imageBase64?: string;
  imageMimeType?: string;
  /** click_at: element found at the clicked point (page-derived text). */
  landedOn?: string;
  /** read_text: one chunk of the page's readable text, plus its range. */
  pageText?: string;
  pageTextOffset?: number;
  pageTextTotal?: number;
  /**
   * read_cookies: the current tab origin's cookies. VALUES ARE SECRETS (the
   * user's live session tokens) — the client only relays this reply straight
   * back to the server, never rendering it. Mirrors server BrowserCookie.
   */
  cookies?: {
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
    expires?: number;
  }[];
  /**
   * read_storage: the current tab origin's localStorage/sessionStorage entries.
   * VALUES ARE SECRETS (localStorage commonly holds bearer/JWT tokens) — the
   * client only relays this reply straight back to the server, never rendering
   * it. Mirrors server BrowserStorageEntry.
   */
  storage?: { key: string; value: string }[];
  /** read_storage: which store the entries came from. */
  storageKind?: "local" | "session";
  /** read_url: the final url after redirects, the HTTP outcome, and the text body (page-derived). */
  fetchUrl?: string;
  fetchStatus?: number;
  fetchContentType?: string;
  fetchBody?: string;
  fetchBytes?: number;
  fetchTruncated?: boolean;
  fetchHops?: number;
  /** read_console: newest captured console entries (page-derived, token-redacted) and the total captured. */
  consoleEntries?: { level: string; text: string; source: string; time: number }[];
  consoleTotal?: number;
  /** read_network: newest captured requests (no query, no headers, no bodies) and the total captured. */
  networkEntries?: {
    method: string;
    url: string;
    status: number;
    type: string;
    durationMs: number | null;
    failed: string;
    time: number;
  }[];
  networkTotal?: number;
  /** batch: one result per step that ran (page-derived fields inside), and how many were asked for. */
  batchSteps?: Record<string, unknown>[];
  batchTotal?: number;
}

/**
 * Policy the EXTENSION re-enforces at the keyboard before a stored secret is
 * typed — the server only pre-checked the last tab URL it happened to know, and
 * the tab may have moved since. Mirrors the server's `BrowserSecretPolicy`;
 * this page neither reads nor edits it, it only relays it.
 */
export interface BridgeSecretPolicy {
  name: string;
  hosts: string[];
  passwordOnly: boolean;
}

/**
 * One `fill_form` field. A SECRET field carries `value: ""` plus `secret` and
 * `secretValue`, so a build that predates secret input writes an empty string
 * instead of a credential.
 */
export interface BridgeFormField {
  uid: string;
  value: string;
  clear?: boolean;
  secret?: BridgeSecretPolicy;
  secretValue?: string;
}

export interface BridgeOperation {
  /**
   * The parked request's id, forwarded so the EXTENSION can coalesce duplicate
   * relays: every open Noah tab watching the same run receives the same
   * browser_op frame, and only the extension sees them all.
   */
  requestId?: string;
  /**
   * WHICH of the user's conversations drives this op (the run's conversation
   * id, stamped by the server's relay — never by the model). Extension 0.29.0
   * keeps one working tab per driver and refuses a tab another driver is
   * using; an older build ignores it and keeps its one shared working tab.
   */
  driver?: string | null;
  op:
    | "snapshot"
    | "navigate"
    | "click"
    | "click_at"
    | "drag"
    | "type"
    | "fill_form"
    | "select_option"
    | "press_key"
    | "scroll"
    | "hover"
    | "navigate_back"
    | "handle_dialog"
    /** Pure status read: is a JS dialog open in the attached tab? Carries no other field. */
    | "dialog_status"
    | "wait_for"
    | "read_text"
    | "read_cookies"
    | "read_storage"
    | "screenshot"
    | "list_tabs"
    | "new_tab"
    | "select_tab"
    | "close_tab"
    /** 0.29.0+: only forwarded after the version probe (INSPECT_OPS_MIN_EXTENSION_VERSION). */
    | "find"
    | "zoom"
    | "read_url"
    | "read_console"
    | "read_network"
    | "batch";
  url?: string | null;
  /** read_cookies: one cookie by name; read_storage: one entry by key (else all). */
  name?: string | null;
  /** read_storage only: which store to read — localStorage vs sessionStorage. */
  kind?: "local" | "session" | null;
  /** find only: exact accessibility role to match. */
  role?: string | null;
  uid?: string | null;
  /** click_at/drag pixel mode: coordinates on the most recent viewport screenshot. zoom: region origin (CSS px). */
  x?: number | null;
  y?: number | null;
  /** read_console/read_network: how many of the newest captured entries to return. */
  limit?: number | null;
  /**
   * batch only: the steps, relayed VERBATIM as the server built them (ordinary
   * single-op fields; the server and the extension both refuse a stored secret
   * in a step).
   */
  steps?: Record<string, unknown>[] | null;
  /** zoom only: region size in viewport CSS px. */
  width?: number | null;
  height?: number | null;
  /** click_at/drag uid mode: 0–1 position inside the uid's box (0.5 = centre). */
  xFraction?: number | null;
  yFraction?: number | null;
  /** drag uid mode: the element the drag ends on (defaults to `uid`). */
  toUid?: string | null;
  /** drag pixel mode: release coordinates on the most recent viewport screenshot. */
  toX?: number | null;
  toY?: number | null;
  /** drag uid mode: 0–1 release position inside the end element's box. */
  toXFraction?: number | null;
  toYFraction?: number | null;
  text?: string | null;
  /**
   * `type` only: enter a STORED SECRET instead of `text`. The model named the
   * secret and the server resolved it; this is the policy the extension re-checks
   * (allowed host, password-field shape) before a single key is sent.
   */
  secret?: BridgeSecretPolicy;
  /**
   * `type` only: the secret's plaintext. Deliberately NOT carried in `text` — an
   * extension older than SECRET_INPUT_MIN_EXTENSION_VERSION ignores the field and
   * types NOTHING, which is a harmless no-op; typing a credential unguarded into
   * whatever the page focused is not.
   */
  secretText?: string;
  submit?: boolean;
  /** type only: replace the field's existing content instead of inserting into it. */
  clear?: boolean;
  keystrokes?: boolean;
  key?: string | null;
  modifiers?: string[] | null;
  repeat?: number | null;
  direction?: string | null;
  pixels?: number | null;
  accept?: boolean | null;
  promptText?: string | null;
  textGone?: string | null;
  timeoutS?: number | null;
  tabId?: string | null;
  fields?: BridgeFormField[] | null;
  option?: string | null;
  fullPage?: boolean | null;
  offset?: number | null;
  /** read_text: scroll through the page while reading, to load lazy content. */
  expand?: boolean | null;
  /**
   * snapshot and every snapshot-returning action: tighten the returned
   * snapshot's character budget (re-clamped extension-side).
   */
  maxChars?: number | null;
}

/** Where the effective allowlist comes from; `managed` cannot be edited here. */
export type AllowlistSource = "managed" | "local" | "empty";

export interface AllowlistReply extends BridgeReply {
  patterns?: string[];
  source?: AllowlistSource;
  /** Installed extension build (manifest version). Absent on pre-0.4.0 builds. */
  version?: string;
}

type ChromeRuntime = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void,
  ) => void;
  lastError?: { message?: string };
};

function runtime(): ChromeRuntime | null {
  // `chrome.runtime` is only defined on origins the extension declares in
  // `externally_connectable`. Its presence does NOT prove OUR extension is
  // installed — any matching extension defines it — so a send round-trip is
  // the only real probe.
  const chrome = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chrome?.runtime && typeof chrome.runtime.sendMessage === "function"
    ? chrome.runtime
    : null;
}

/** True when this browser could plausibly reach the extension (not proof it is installed). */
export function browserBridgeReachable(): boolean {
  return runtime() !== null;
}

/**
 * The browser's own extension-manager URL, for user-facing guidance. The
 * bridge itself is Chromium-common; the one thing Edge renames is this page.
 */
export function extensionsPageUrl(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /\bEdg\//.test(ua) ? "edge://extensions" : "chrome://extensions";
}

const NOT_INSTALLED: BridgeReply = {
  ok: false,
  message:
    "The Noah browser extension is not reachable from this page. Ask the user to install it and reload Noah; " +
    "without it there is no way to drive their browser.",
};

/**
 * Forward one operation to the extension. Never rejects — a failure becomes an
 * `ok:false` reply so the parked run always gets a definite answer rather than
 * waiting out its TTL.
 */
export function sendToExtension(
  operation: BridgeOperation,
  timeoutMs = 40000,
): Promise<BridgeReply> {
  const rt = runtime();
  if (!rt) {
    return Promise.resolve(NOT_INSTALLED);
  }
  return new Promise<BridgeReply>((resolve) => {
    let settled = false;
    const finish = (reply: BridgeReply) => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    // Below the server's park TTL so the client, not the timer, reports the
    // failure — a client-authored message can say what to do about it.
    const timer = setTimeout(() => {
      finish({
        ok: false,
        message:
          "The browser extension did not answer in time. The attached tab may have been closed or the page may be stuck loading. " +
          "Ask the user to check the attached tab, then retry.",
      });
    }, timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, { source: "noah", ...operation }, (response) => {
        clearTimeout(timer);
        if (rt.lastError) {
          finish(NOT_INSTALLED);
          return;
        }
        const reply = response as BridgeReply | undefined;
        if (!reply || typeof reply.ok !== "boolean") {
          finish({
            ok: false,
            message: "The browser extension returned an unreadable response.",
          });
          return;
        }
        finish(reply);
      });
    } catch {
      clearTimeout(timer);
      finish(NOT_INSTALLED);
    }
  });
}

/** The extension id this page targets (manifest-`key`-pinned, env-overridable). */
export function bridgeExtensionId(): string {
  return EXTENSION_ID;
}

/**
 * Numeric dotted-version compare ("0.10.0" > "0.9.1", unlike a string compare):
 * negative when a<b, 0 when equal, positive when a>b — null when either side is
 * not dotted-numeric, so callers fail toward "not vouched for".
 */
export function compareBridgeVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".");
    return parts.length && parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export type BridgeVersionVerdict = "current" | "compatible" | "outdated";

/**
 * Badge verdict for the INSTALLED extension build against the server bundle.
 * "current" = exact match; "compatible" = differs but at/above the server's
 * min-compatible floor (works now, update optional); "outdated" = below the
 * floor, no reported version (pre-0.4.0 builds), or no parseable floor to
 * vouch for the difference.
 */
export function bridgeVersionVerdict(
  installed: string,
  expected: string,
  minCompatible?: string | null,
): BridgeVersionVerdict {
  if (!installed) return "outdated";
  if (installed === expected) return "current";
  if (minCompatible) {
    const cmp = compareBridgeVersions(installed, minCompatible);
    if (cmp !== null && cmp >= 0) return "compatible";
  }
  return "outdated";
}

/**
 * First extension build that understands `secretText` / `secretValue`. Below it
 * the fields are simply unknown keys: the build types NOTHING and answers as if
 * it succeeded, so the run would stall on a login that never happened. Raising
 * `BROWSER_EXTENSION_MIN_COMPATIBLE` for that would order a reinstall on every
 * install for a feature most runs never touch — so the gate lives HERE, on the
 * one op that actually needs it, and everything else keeps working.
 *
 * KEEP THIS DECLARATION ON ONE LINE. `tests/infra.test.ts` pins it against the
 * bundled manifest version by REGEX over this file's text — it compiles under
 * the root NodeNext tsconfig, which excludes `src/client`, so it cannot import
 * the value. Reformatting or renaming the line fails that test, not this one.
 */
export const SECRET_INPUT_MIN_EXTENSION_VERSION = "0.28.0";

/**
 * May the installed build be handed a stored secret? Unknown or unparseable
 * versions are a NO (pre-0.4.0 builds report none), the same fail-toward-refusal
 * direction `bridgeVersionVerdict` takes — a wrong yes hands a credential to a
 * build that drops it on the floor.
 */
export function extensionSupportsSecretInput(version: string | undefined | null): boolean {
  if (!version) return false;
  const cmp = compareBridgeVersions(version, SECRET_INPUT_MIN_EXTENSION_VERSION);
  return cmp !== null && cmp >= 0;
}

/**
 * First extension build that knows the 0.29.0 op set (`INSPECT_OPS`). An older
 * build answers those ops "Unsupported operation" at best — the server
 * translates that into a generic update prompt — but the gate lives HERE, like
 * the secret-input one, so the reply can name the op and the version that is
 * missing, and so nothing new is even forwarded to a build that predates it.
 * `BROWSER_EXTENSION_MIN_COMPATIBLE` deliberately does NOT move: every op an
 * older build already knows keeps working, which is a degrade, not a break.
 *
 * KEEP THIS DECLARATION ON ONE LINE — `tests/infra.test.ts` pins it against the
 * bundled manifest version by REGEX over this file's text, exactly like
 * SECRET_INPUT_MIN_EXTENSION_VERSION above.
 */
export const INSPECT_OPS_MIN_EXTENSION_VERSION = "0.29.0";

/** The ops that need INSPECT_OPS_MIN_EXTENSION_VERSION; probed before forwarding. */
export const INSPECT_OPS: ReadonlySet<string> = new Set([
  "find",
  "zoom",
  "read_url",
  "read_console",
  "read_network",
  "batch",
]);

/**
 * May the installed build be handed one of `INSPECT_OPS`? Same fail-toward-
 * refusal reading as extensionSupportsSecretInput: an unknown or unparseable
 * version is a NO, so the model gets an update prompt instead of a silent
 * "Unsupported operation".
 */
export function extensionSupportsInspectOps(version: string | undefined | null): boolean {
  if (!version) return false;
  const cmp = compareBridgeVersions(version, INSPECT_OPS_MIN_EXTENSION_VERSION);
  return cmp !== null && cmp >= 0;
}

/**
 * Ask the extension to reload itself after the one-click update rewrote its
 * folder (the chrome://extensions ↻ equivalent). Builds before 0.5.0 answer
 * `Unsupported operation` — the caller falls back to asking for one manual ↻.
 */
export function requestExtensionReload(): Promise<BridgeReply> {
  return sendToExtension({ op: "reloadExtension" } as unknown as BridgeOperation);
}

/**
 * Read the allowlist the extension is currently enforcing. `source` matters as
 * much as the list: a `managed` list is pushed by policy and the editor must
 * present it read-only rather than offering a control that silently does
 * nothing.
 */
export function readAllowedOrigins(): Promise<AllowlistReply> {
  return sendToExtension({ op: "getAllowedOrigins" } as unknown as BridgeOperation);
}

/** Replace the local allowlist. Refused by the extension when policy governs it. */
export function writeAllowedOrigins(patterns: string[]): Promise<AllowlistReply> {
  return sendToExtension({
    op: "setAllowedOrigins",
    patterns,
  } as unknown as BridgeOperation);
}

/**
 * What the operator's default allowlist (`BROWSER_ALLOWED_ORIGINS`, served on
 * `/api/browser-extension`) should seed into THIS browser, or null when nothing
 * may be written: the extension is unreachable, a managed policy governs it, or
 * the user already holds ANY local list (their edits are never overwritten —
 * seeding is a first-run convenience, not a push channel). `ownHostname` drops
 * entries covering Noah itself, belt-and-suspenders with the server-side filter.
 */
export function allowlistSeed(
  defaults: readonly string[] | undefined,
  reply: AllowlistReply | null,
  ownHostname: string,
): string[] | null {
  if (!reply?.ok || reply.source !== "empty" || (reply.patterns ?? []).length > 0) {
    return null;
  }
  const seed = defaultAllowlistFor(defaults ?? [], ownHostname);
  return seed.length ? seed : null;
}
