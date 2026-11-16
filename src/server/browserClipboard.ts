import crypto from "node:crypto";
import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "./auth.js";
import type { Store } from "./store.js";

// ---- Clipboard staging ------------------------------------------------------
// The avatar cannot write to the OS clipboard from a Chrome MV3 extension, but a
// FIRST-PARTY page can via navigator.clipboard.write()/writeText() once a click
// supplies the user-activation. So we stage the bytes here under an unguessable
// token and serve a tiny same-origin page (below) whose copy button the browser
// bridge later clicks on the user's behalf. Entries are short-lived and the map
// is size-capped so a burst of stages can't grow it without bound.
//
// The store is MIME-agnostic: an IMAGE (clipboard "image") and plain TEXT (clipboard "text")
// ride the exact same token/path/TTL contract, and the staging page picks its
// mode from the Content-Type it gets back — so a new payload kind needs no new
// route and no extension change.
//
// CSP-bound by design (see app.ts): the page uses an EXTERNAL same-origin script
// (`script-src 'self'` blocks inline), and that script turns the fetched bytes
// into a `data:` URL before assigning `img.src` (`img-src 'self' data:` blocks
// `blob:`), mirroring the copyPng pattern in client/src/lib/canvasExport.ts.

interface StagedImage {
  bytes: Buffer;
  mime: string;
  expiresAt: number;
  /**
   * The user the staged bytes belong to. The image comes out of that user's own
   * workspace (which may hold a private repo clone), so the token alone is NOT
   * the capability — every read is additionally bound to this id.
   */
  userId: string;
}

const STAGE_TTL_MS = 120_000;
const MAX_STAGED = 50;
const staged = new Map<string, StagedImage>();

/** Drop every entry whose TTL has passed. Called lazily on every stage/read. */
function evictExpired(now: number): void {
  for (const [token, entry] of staged) {
    if (entry.expiresAt <= now) staged.delete(token);
  }
}

// The lazy evictions above only fire while the feature is in use, so a burst of
// stages followed by idleness would keep up to MAX_STAGED × 5 MB of Buffers
// alive for the process lifetime. This sweep bounds how long expired bytes
// outlive their TTL; `.unref()` so it never holds the process open (tests and
// short-lived CLI runs included).
setInterval(() => evictExpired(Date.now()), 60_000).unref();

/**
 * Hold `bytes` under a fresh token for `userId` and return the token plus the
 * same-origin path that renders the staging page. Shared body of the two public
 * stagers below — the store never looks at `mime`, only the served
 * Content-Type does.
 *
 * CONTRACT: callers rely on `path === "/browser-clip/" + token` exactly — the
 * browser bridge navigates there and clicks the copy button — and the
 * EXTENSION's allowlist exemption pins the same shape
 * (`/browser-clip/<32 hex>`, background.js originAllowed). Changing the token
 * format or the path breaks fielded extensions, not just this server.
 */
function stageBytes(bytes: Buffer, mime: string, userId: string): { token: string; path: string } {
  const now = Date.now();
  evictExpired(now);
  // A Map iterates in insertion order, so its first key is the oldest entry.
  // Cap the size before inserting so the map can never exceed MAX_STAGED.
  while (staged.size >= MAX_STAGED) {
    const oldest = staged.keys().next().value;
    if (oldest === undefined) break;
    staged.delete(oldest);
  }
  const token = crypto.randomBytes(16).toString("hex");
  staged.set(token, { bytes, mime, expiresAt: now + STAGE_TTL_MS, userId });
  return { token, path: "/browser-clip/" + token };
}

/** Stage image `bytes` (already read + format-checked by the caller) for clipboard "image". */
export function stageClipboardImage(
  bytes: Buffer,
  mime: string,
  userId: string,
): { token: string; path: string } {
  return stageBytes(bytes, mime, userId);
}

/**
 * The staged-text byte ceiling. clipboard "text"'s schema already caps the CHARACTER
 * count, so this is defense in depth for any other caller: a multi-megabyte
 * string must not sit in the process for the TTL just because it type-checked.
 */
const MAX_STAGED_TEXT_BYTES = 1_000_000;

/**
 * Stage plain `text` for clipboard "text" — the same token/path/TTL contract as
 * stageClipboardImage, differing only in the mime the `/img` route serves back
 * (which is what puts the staging page into its text branch).
 */
export function stageClipboardText(
  text: string,
  userId: string,
): { token: string; path: string } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength > MAX_STAGED_TEXT_BYTES) {
    throw new Error(
      `The text is ${bytes.byteLength} bytes, over the ${MAX_STAGED_TEXT_BYTES}-byte clipboard staging limit. Put it in the page in smaller pieces.`,
    );
  }
  return stageBytes(bytes, "text/plain; charset=utf-8", userId);
}

/**
 * The staged entry for `token` (including its owning `userId`, which callers
 * MUST check against the requester), or null if missing/expired.
 */
export function readStagedImage(
  token: string,
): { bytes: Buffer; mime: string; userId: string } | null {
  const now = Date.now();
  evictExpired(now);
  const entry = staged.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    staged.delete(token);
    return null;
  }
  return { bytes: entry.bytes, mime: entry.mime, userId: entry.userId };
}

// ---- Staging page + client script -------------------------------------------
// User-facing copy is Korean (a human might glance at this page). The token is
// carried in the URL path, so the page HTML is token-independent and the script
// reads the token from `location.pathname`.

const EXPIRED_MESSAGE = "만료되었거나 찾을 수 없는 항목입니다.";

const STAGING_PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>클립보드로 복사</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    font-family: system-ui, -apple-system, "Noto Sans KR", sans-serif;
    background: #f4f5f7;
    color: #1a1a1a;
  }
  h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
  #copyBtn {
    font-size: 1rem;
    padding: 0.75rem 1.75rem;
    border: 0;
    border-radius: 8px;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
  }
  #copyBtn:disabled { background: #9ca3af; cursor: not-allowed; }
  #status { min-height: 1.2em; font-size: 0.9rem; color: #444; }
</style>
</head>
<body>
<h1>클립보드로 복사</h1>
<button id="copyBtn" autofocus>클립보드로 복사</button>
<div id="status" role="status"></div>
<script src="/browser-clip.js"></script>
</body>
</html>
`;

// Served as an EXTERNAL asset because the strict CSP forbids inline script.
// Plain string concatenation only — no template literals — so nothing here is
// re-interpreted by the enclosing TS template literal.
const BROWSER_CLIP_SCRIPT = `"use strict";
(async function () {
  var segments = location.pathname.split("/").filter(Boolean);
  var token = segments[segments.length - 1] || "";
  var btn = document.getElementById("copyBtn");
  var statusEl = document.getElementById("status");
  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  // Both modes need the async Clipboard API at all; the per-mode requirements
  // differ (text needs only writeText, an image also needs ClipboardItem), so
  // they are detected inside prepare() where the mode is known.
  var ClipboardItemCtor = window.ClipboardItem;
  if (!navigator.clipboard) {
    if (btn) btn.disabled = true;
    setStatus("이 브라우저는 클립보드 복사를 지원하지 않습니다.");
    return;
  }

  var textPayload = null;
  var pngBlob = null;

  // ONE fetch of the staged bytes; its Content-Type picks the mode. Text goes
  // to the clipboard verbatim. An image is normalized to a PNG blob off a
  // canvas, its bytes carried through a data: URL (not blob:) so the img load
  // stays CSP-legal.
  async function prepare() {
    var res = await fetch("/browser-clip/" + encodeURIComponent(token) + "/img");
    if (!res.ok) throw new Error("fetch " + res.status);
    var contentType = res.headers.get("Content-Type") || "";
    if (contentType.indexOf("text/") === 0) {
      if (!navigator.clipboard.writeText) throw new Error("UNSUPPORTED_TEXT");
      textPayload = await res.text();
      return;
    }
    if (!navigator.clipboard.write || typeof ClipboardItemCtor === "undefined") {
      throw new Error("UNSUPPORTED_IMAGE");
    }
    var sourceBlob = await res.blob();
    var dataUrl = await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("read failed")); };
      reader.readAsDataURL(sourceBlob);
    });
    var img = await new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error("image load failed")); };
      image.src = dataUrl;
    });
    var canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    var ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    pngBlob = await new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error("toBlob failed"));
      }, "image/png");
    });
  }

  try {
    await prepare();
    setStatus(
      textPayload === null
        ? "복사 버튼을 누르면 이미지가 클립보드에 복사됩니다."
        : "복사 버튼을 누르면 텍스트가 클립보드에 복사됩니다."
    );
  } catch (err) {
    if (btn) btn.disabled = true;
    var reason = err && err.message ? err.message : "";
    setStatus(
      reason === "UNSUPPORTED_IMAGE"
        ? "이 브라우저는 클립보드 이미지 복사를 지원하지 않습니다."
        : reason === "UNSUPPORTED_TEXT"
          ? "이 브라우저는 클립보드 복사를 지원하지 않습니다."
          : "복사할 내용을 준비하지 못했습니다."
    );
    return;
  }

  if (btn) {
    btn.addEventListener("click", async function () {
      if (textPayload === null && !pngBlob) {
        setStatus("복사할 내용이 아직 준비되지 않았습니다.");
        return;
      }
      // The document TITLE is the machine-readable outcome: the agent reads it
      // back from its click result and must not paste unless it says COPIED. Both
      // modes share that contract. The status line stays Korean prose for a
      // human glancing at the page.
      try {
        if (textPayload === null) {
          await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": pngBlob })]);
          setStatus("이미지를 클립보드에 복사했습니다.");
        } else {
          await navigator.clipboard.writeText(textPayload);
          setStatus("텍스트를 클립보드에 복사했습니다.");
        }
        document.title = "COPIED";
        window.__copied = true;
      } catch (err) {
        setStatus("복사 실패: " + (err && err.name ? err.name : "오류"));
        document.title = "COPY_FAILED";
      }
    });
  }
})();
`;

/**
 * Routes for the clipboard staging page: the page itself, its raw image bytes,
 * and the shared client script. `deps` is narrowed to just `{ store }` — the
 * only dependency needed (for `requireAuth`) — but the full `RouterDeps` is
 * structurally assignable, so it can be mounted like the other routers.
 */
export function createBrowserClipboardRouter(deps: { store: Store }): Router {
  const { store } = deps;
  const router = Router();

  // The staging page: one big copy button the browser bridge clicks. Served
  // only to the authenticated viewer the bytes were staged for — the token is
  // printed into the persisted tool-result text, so it is not a capability on
  // its own. A foreign token must be INDISTINGUISHABLE from an expired one
  // (same 404 body): don't leak that someone else's staging exists.
  router.get("/browser-clip/:token", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const entry = readStagedImage(req.params.token);
    if (!entry || entry.userId !== req.user!.id) {
      res.status(404).type("text/plain; charset=utf-8").send(EXPIRED_MESSAGE);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("text/html; charset=utf-8").send(STAGING_PAGE_HTML);
  });

  // The raw staged bytes, loaded by the client script. "/img" is a HISTORICAL
  // name — the payload may be TEXT (clipboard "text"), and the entry's own mime is
  // what the script branches on. The path shape is pinned by fielded
  // extensions, so it stays as it is rather than being renamed.
  router.get("/browser-clip/:token/img", requireAuth(store), (req: AuthenticatedRequest, res) => {
    const entry = readStagedImage(req.params.token);
    // Same owner check, same indistinguishable-from-expired 404 as the page.
    if (!entry || entry.userId !== req.user!.id) {
      res.status(404).type("text/plain; charset=utf-8").send(EXPIRED_MESSAGE);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type(entry.mime).send(entry.bytes);
  });

  // The staging page's script. Token-independent and carries no image data, so
  // it needs no token/auth — served like the vendored same-origin assets.
  router.get("/browser-clip.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript; charset=utf-8").send(BROWSER_CLIP_SCRIPT);
  });

  // Everything else under /browser-clip/ is a HARD 404, never the SPA
  // fallback: the extension exempts this namespace from its allowlist (exact
  // token pages only), and that is safe only while no path under it can ever
  // render the logged-in Noah UI. Belt to the extension's exact-shape match.
  router.all("/browser-clip/*", (_req, res) => {
    res.status(404).type("text/plain; charset=utf-8").send(EXPIRED_MESSAGE);
  });

  return router;
}
