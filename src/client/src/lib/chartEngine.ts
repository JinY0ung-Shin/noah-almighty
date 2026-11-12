// SPIKE (2026-11-12): which engine draws an inline `<chart>` written in the
// simple form. `vega` is what ships — a static, sanitized SVG with our own
// entrance on top, and no reaction to the pointer. `recharts` draws the same
// model with React components: tooltips, hover and the entrance come with the
// library. A per-browser switch so both can be compared on real answers; a
// whole Vega-Lite `spec` and the `vega` canvas are Vega's either way.
import { writable } from "./store";

export type ChartEngine = "vega" | "recharts";

const KEY = "noah-chart-engine";

function stored(): ChartEngine {
  try {
    return localStorage.getItem(KEY) === "recharts" ? "recharts" : "vega";
  } catch {
    return "vega";
  }
}

export const chartEngine = writable<ChartEngine>(stored());

export function setChartEngine(next: ChartEngine): void {
  chartEngine.set(next);
  try {
    if (next === "vega") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* private mode: the choice lasts for this page */
  }
}
