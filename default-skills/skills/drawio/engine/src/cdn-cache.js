// Noah's OFFLINE stand-in for drawio-mcp's mcp-tool-server/src/cdn-cache.js.
//
// Upstream downloads the ELK bundle and the libavoid routing core from the
// viewer.diagrams.net CDN and keeps them in a per-user cache. A Noah sandbox
// has no network, so this module keeps upstream's exports (elk-engine.js and
// libavoid-pass.js import it unchanged) and serves the copies vendored next to
// it instead. Nothing here ever opens a connection or writes a file.
//
// NOT an upstream file: keep it when the other files of this folder are
// refreshed (see ../README.md).

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const VENDOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");

export const ROUTING_CORE = {
  url: join(VENDOR, "libavoid", "libavoid-routing.js"),
  file: "libavoid-routing.json",
};

export const ELK_BUNDLE = {
  url: join(VENDOR, "elk", "drawio-elk.min.js"),
  file: "drawio-elk.json",
};

/**
 * The vendored source of one artifact. `validate(src)` throws when the source
 * is unusable, and that error is the caller's.
 *
 * @param {{url: string}} source - ROUTING_CORE or ELK_BUNDLE
 * @param {function(string)} validate
 * @returns {Promise<string>}
 */
export async function loadCachedSource(source, validate)
{
  var src = readFileSync(source.url, "utf8");
  validate(src);
  return src;
}
