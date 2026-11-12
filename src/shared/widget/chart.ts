/**
 * `<chart>` (`type` + `data` + `xKey` + `series`), read and checked: which
 * columns are plotted, in which shape, with the numbers already parsed. The
 * client's chart components draw this model (components/widget/WidgetChart).
 *
 * Pure data in, pure data out — nothing here is evaluated, and the rows are the
 * avatar's own inline values (already sanitized by `normalizeProps`).
 *
 * RETIRED (2026-11-12): `<chart spec={…}>`, a whole Vega-Lite spec. The app no
 * longer carries Vega; the prop is not in the grammar any more, an answer that
 * still writes it gets {@link CHART_SPEC_RETIRED} back, and the name stays
 * reserved.
 */
/** English, for the avatar: what to write instead of a Vega-Lite `spec`. */
export const CHART_SPEC_RETIRED =
  "A Vega-Lite `spec` is retired: the app no longer draws one. Write the chart as type + data (+ xKey, series) — bar, line, area, pie or donut — or give the numbers as a <table>.";

export const MAX_CHART_ROWS = 500;
export const MAX_CHART_SERIES = 8;

export type SimpleChartType = "bar" | "line" | "area" | "pie" | "donut";

/**
 * What a `<chart>` asks for, ready to draw.
 */
export interface SimpleChartModel {
  type: SimpleChartType;
  title: string;
  unit: string;
  /** The plotted series' display names, in order (a pie/donut has one). */
  names: string[];
  stacked: boolean;
  horizontal: boolean;
  /** Line/area over numbers: the x axis is a number line, not categories. */
  numericX: boolean;
  /** One entry per plotted value, in the rows' own order. For a pie/donut `series` is the one series' name. */
  values: { x: string | number; series: string; value: number }[];
}

export interface SimpleChartRead {
  /** null when there is nothing to draw. */
  model: SimpleChartModel | null;
  problems: string[];
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // "1,200", "12.5%", "3만원": the leading number is what is plotted.
    const m = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(v.replace(/[,\s]/g, ""));
    return m ? Number(m[0]) : NaN;
  }
  return NaN;
}

function label(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** `props` are a `<chart>`'s NORMALIZED props (`normalizeProps`). */
export function simpleChartModel(props: Record<string, unknown>): SimpleChartRead {
  const problems: string[] = [];
  const all = Array.isArray(props.data) ? (props.data as unknown[]) : [];
  const rows = all.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)).slice(0, MAX_CHART_ROWS);
  if (all.length > MAX_CHART_ROWS) problems.push(`data has ${all.length} rows; only the first ${MAX_CHART_ROWS} are drawn`);
  if (rows.length === 0) return { model: null, problems };

  const keys: string[] = [];
  for (const row of rows.slice(0, 20)) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
  const numeric = (k: string) => rows.some((r) => Number.isFinite(toNumber(r[k])));

  let xKey = typeof props.xKey === "string" ? props.xKey : "";
  if (xKey && !keys.includes(xKey)) {
    problems.push(`xKey "${xKey}" is not a key of the rows (${keys.join(", ")})`);
    xKey = "";
  }
  // Default: the first column that is not a number (a name, a month), else the first column.
  if (!xKey) xKey = keys.find((k) => rows.some((r) => typeof r[k] === "string" && !Number.isFinite(toNumber(r[k])))) ?? keys[0] ?? "";

  const asked = Array.isArray(props.series) ? (props.series as { key?: unknown; label?: unknown }[]) : [];
  let series = asked
    .map((s) => ({ key: typeof s?.key === "string" ? s.key : "", label: typeof s?.label === "string" && s.label ? s.label : typeof s?.key === "string" ? s.key : "" }))
    .filter((s) => s.key !== "");
  const missing = series.filter((s) => !keys.includes(s.key)).map((s) => s.key);
  if (missing.length) problems.push(`series ${missing.map((k) => `"${k}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not a key of the rows (${keys.join(", ")})`);
  series = series.filter((s) => keys.includes(s.key));
  if (series.length === 0) series = keys.filter((k) => k !== xKey && numeric(k)).map((k) => ({ key: k, label: k }));
  if (series.length > MAX_CHART_SERIES) {
    problems.push(`${series.length} series; only the first ${MAX_CHART_SERIES} are drawn`);
    series = series.slice(0, MAX_CHART_SERIES);
  }
  if (series.length === 0) {
    problems.push("the rows have no numeric key to plot");
    return { model: null, problems };
  }

  const type: SimpleChartType = props.type === "line" || props.type === "area" || props.type === "pie" || props.type === "donut" ? props.type : "bar";
  const unit = typeof props.unit === "string" ? props.unit : "";
  const title = typeof props.title === "string" ? props.title : "";

  if (type === "pie" || type === "donut") {
    const first = series[0];
    const values = rows
      .map((r) => ({ x: label(r[xKey]), series: first.label, value: toNumber(r[first.key]) }))
      .filter((v) => Number.isFinite(v.value) && v.value >= 0);
    if (series.length > 1) problems.push(`a ${type} chart draws one series; "${first.key}" is shown`);
    if (values.length === 0) return { model: null, problems };
    return { model: { type, title, unit, names: [first.label], stacked: false, horizontal: false, numericX: false, values }, problems };
  }

  // Line and area over numbers keep a numeric axis; anything else is a category in the rows' own order.
  const numericX = type !== "bar" && rows.every((r) => typeof r[xKey] === "number" && Number.isFinite(r[xKey] as number));
  const values: SimpleChartModel["values"] = [];
  for (const row of rows) {
    for (const s of series) {
      if (!hasOwn(row, s.key)) continue;
      const value = toNumber(row[s.key]);
      if (Number.isFinite(value)) values.push({ x: numericX ? (row[xKey] as number) : label(row[xKey]), series: s.label, value });
    }
  }
  if (values.length === 0) return { model: null, problems };

  return {
    model: {
      type,
      title,
      unit,
      names: series.map((s) => s.label),
      stacked: props.stacked === true && type !== "line",
      horizontal: props.horizontal === true && type === "bar",
      numericX,
      values,
    },
    problems,
  };
}
