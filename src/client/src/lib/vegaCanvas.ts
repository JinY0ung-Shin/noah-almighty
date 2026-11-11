import DOMPurify from "dompurify";
import type { Loader } from "vega";

import { cssToken } from "./theme";

const VEGA_URL_BLOCKED_MESSAGE =
  "Vega canvas specs must inline data with data.values; URL-backed data, images, and links are not allowed.";

type VegaLoaderFactory = {
  loader: () => Loader;
};

function blockedVegaUrl(uri: string): Error {
  return new Error(`${VEGA_URL_BLOCKED_MESSAGE} Blocked URI: ${uri}`);
}

function findUriKey(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object") return null;

  // Inline row objects commonly have fields named "url"; those are data, not
  // loader instructions. If they are later used as image/link channels, the
  // channel key outside `values` is still caught.
  if (path.includes("values") || path.includes("datasets")) return null;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findUriKey(value[i], [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "url" || key === "href") {
      return [...path, key].join(".");
    }
    const found = findUriKey(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

export function assertInlineOnlyVegaSpec(spec: unknown): void {
  const uriPath = findUriKey(spec);
  if (uriPath) {
    throw new Error(`${VEGA_URL_BLOCKED_MESSAGE} Remove '${uriPath}' and use inline values instead.`);
  }
}

/**
 * Canvas Vega specs are avatar-controlled. Keep rendering declarative and local:
 * no data.url fetches, no URI-backed images, no URI-backed links.
 */
export function createInlineOnlyVegaLoader(vega: VegaLoaderFactory): Loader {
  const loader = vega.loader();
  const reject = async (uri: string): Promise<string> => {
    throw blockedVegaUrl(uri);
  };
  const rejectSanitize = async (uri: string): Promise<{ href: string }> => {
    throw blockedVegaUrl(uri);
  };

  loader.load = reject;
  loader.http = reject;
  loader.file = reject;
  loader.sanitize = rejectSanitize;
  return loader;
}

/**
 * Chart chrome (axes, labels, legends) from the SAME design tokens the page
 * uses instead of a second hardcoded palette; the fallbacks cover a context
 * where the stylesheet isn't loaded. Both themes are spelled out — leaving
 * light implicit let Vega pick its own near-black.
 */
export function vegaChartConfig(dark: boolean): Record<string, unknown> {
  const text = cssToken("--text", dark ? "#e5e7eb" : "#161b21");
  const muted = cssToken("--muted", dark ? "#cbd5e1" : "#505b66");
  const line = cssToken("--line", dark ? "#475569" : "#d6dde4");
  const grid = cssToken("--line-soft", dark ? "#334155" : "#e3e8ed");
  return {
    background: "transparent",
    view: { stroke: "transparent" },
    title: { color: text, subtitleColor: muted },
    axis: { domainColor: line, gridColor: grid, tickColor: line, labelColor: muted, titleColor: text },
    legend: { labelColor: muted, titleColor: text },
    style: { "guide-label": { fill: muted }, "guide-title": { fill: text } },
  };
}

/**
 * A Vega-Lite spec → a sanitized SVG string, for the `vega` canvas and a
 * widget's `<chart>` alike. CSP-safe end to end: inline data only
 * (`assertInlineOnlyVegaSpec` + the rejecting loader), expressions run through
 * `vega-interpreter`'s AST evaluator (no `Function` constructor), and the
 * result passes DOMPurify's svg profile. Draw it in a shadow root (`shadowSvg`):
 * mermaid and Vega bake their colors in, so re-render on a theme flip.
 * Throws the library's own error for a spec it cannot compile or render.
 */
export async function renderVegaSvg(spec: unknown, dark: boolean): Promise<string> {
  const [vega, vegaLite, interp] = await Promise.all([import("vega"), import("vega-lite"), import("vega-interpreter")]);
  assertInlineOnlyVegaSpec(spec);
  const config = vegaChartConfig(dark);
  const vgSpec = vegaLite.compile(spec as any, { config } as any).spec;
  const runtime = vega.parse(vgSpec as any, null as any, { ast: true } as any);
  const view = new vega.View(runtime, {
    expr: interp.expressionInterpreter,
    renderer: "svg",
    loader: createInlineOnlyVegaLoader(vega),
  } as any);
  try {
    const svg = await view.toSVG();
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  } finally {
    view.finalize();
  }
}
