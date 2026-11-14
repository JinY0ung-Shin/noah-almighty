// Loads the drawio-elk bundle (ELK engine + mxGraph bridge) for the
// server-side layout pass.
//
// The canonical bundle ships with draw.io releases on the viewer.diagrams.net
// CDN — the same file the app server loads with a <script src> and the editor
// bundles, so a layout computed here matches what the editor's Arrange >
// Layout menu produces for the same diagram. It is NOT vendored (the ~900 KB
// would bloat the npm package and go stale between releases): it comes
// through the ETag-revalidated per-user disk cache (cdn-cache.js), downloaded
// once on the first layout call and revalidated with a conditional GET after
// that. Set DRAWIO_ELK_URL to a local path to test an unreleased build.
//
// The bundle is a plain browser script with no DOM dependency: it declares
// `var ELK` and `var ElkLayout/ElkAdapter/ElkApplier` at top level. Indirect
// eval runs in global scope, where those vars become globals — the same
// side-effect-import trick libavoid-pass.js uses for the routing core. The
// bridge reaches for mxGraph globals at runtime; mx-model.js installs the
// headless stand-ins before the first layout runs.

import { loadCachedSource, ELK_BUNDLE } from "./cdn-cache.js";

// Set by the bundle's top-level vars. Cleared before an eval so a source that
// fails to define them can never be vouched for by a previous load.
const GLOBALS = ["ELK", "ElkLayout", "ElkAdapter", "ElkApplier"];

// The source currently installed in the globals - loadCachedSource may
// validate a download and then still return the cached copy, so the caller
// re-evaluates its choice, and evaluating ~900 KB twice for nothing is worth
// skipping.
let installed = null;

function evalBundle(src)
{
  if (src === installed) return;

  installed = null;

  for (var i = 0; i < GLOBALS.length; i++)
  {
    delete globalThis[GLOBALS[i]];
  }

  (0, eval)(src);

  if (typeof globalThis.ELK !== "function" ||
    typeof globalThis.ElkLayout !== "function" ||
    globalThis.ElkLayout.MENU_PRESETS == null)
  {
    throw new Error("ELK/ElkLayout missing after eval");
  }

  installed = src;
}

let enginePromise = null;

/**
 * The drawio-elk bridge, loaded once per process. Rejects when neither the
 * CDN nor the cache can provide a usable bundle — callers report the layout
 * as unavailable and leave the diagram untouched.
 *
 * @returns {Promise<{ELK: Function, ElkLayout: Function}>}
 */
export function getElkBridge()
{
  if (enginePromise == null)
  {
    enginePromise = loadCachedSource(ELK_BUNDLE, evalBundle).then(function(src)
    {
      // Evaluate the returned choice: a NEWER download that failed validation
      // is evaluated (clearing the globals) AFTER the cached copy
      // loadCachedSource falls back to, so the last eval doesn't necessarily
      // match the returned source.
      evalBundle(src);

      return { ELK: globalThis.ELK, ElkLayout: globalThis.ElkLayout };
    }).catch(function(e)
    {
      // Don't cache the failure - a later call may reach the CDN.
      enginePromise = null;
      throw e;
    });
  }

  return enginePromise;
}
