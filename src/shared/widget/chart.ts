/**
 * `<chart>` in its simple form (`type` + `data` + `xKey` + `series`) → the
 * Vega-Lite spec the renderer draws. One chart pipeline: the simple form is
 * only a shorter way to write the common charts, so an avatar does not spell a
 * whole spec (and a streaming answer has less to get wrong) for a bar chart.
 *
 * Pure data in, pure data out — nothing here is evaluated, and the rows are the
 * avatar's own inline values (already sanitized by `normalizeProps`).
 */
export const MAX_CHART_ROWS = 500;
export const MAX_CHART_SERIES = 8;

export type SimpleChartType = "bar" | "line" | "area" | "pie" | "donut";

export interface SimpleChart {
  /** The Vega-Lite spec, or null when there is nothing to draw (no rows). */
  spec: Record<string, unknown> | null;
  /** English, for the avatar: why the chart is not what was asked for. */
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
export function simpleChartSpec(props: Record<string, unknown>): SimpleChart {
  const problems: string[] = [];
  const all = Array.isArray(props.data) ? (props.data as unknown[]) : [];
  const rows = all.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)).slice(0, MAX_CHART_ROWS);
  if (all.length > MAX_CHART_ROWS) problems.push(`data has ${all.length} rows; only the first ${MAX_CHART_ROWS} are drawn`);
  if (rows.length === 0) return { spec: null, problems };

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
    return { spec: null, problems };
  }

  const type: SimpleChartType = props.type === "line" || props.type === "area" || props.type === "pie" || props.type === "donut" ? props.type : "bar";
  const unit = typeof props.unit === "string" ? props.unit : "";
  const title = typeof props.title === "string" && props.title ? { title: props.title } : {};
  const names = series.map((s) => s.label);

  if (type === "pie" || type === "donut") {
    const first = series[0];
    const values = rows.map((r) => ({ x: label(r[xKey]), value: toNumber(r[first.key]) })).filter((v) => Number.isFinite(v.value) && v.value >= 0);
    if (series.length > 1) problems.push(`a ${type} chart draws one series; "${first.key}" is shown`);
    if (values.length === 0) return { spec: null, problems };
    return {
      spec: {
        ...title,
        data: { values },
        mark: { type: "arc", ...(type === "donut" ? { innerRadius: 60 } : {}) },
        encoding: {
          theta: { field: "value", type: "quantitative", stack: true },
          color: { field: "x", type: "nominal", title: null, sort: null, scale: { domain: values.map((v) => v.x) } },
          order: { field: "value", type: "quantitative", sort: "descending" },
        },
        view: { stroke: null },
      },
      problems,
    };
  }

  // Line and area over numbers keep a numeric axis; anything else is a category in the rows' own order.
  const numericX = type !== "bar" && rows.every((r) => typeof r[xKey] === "number" && Number.isFinite(r[xKey] as number));
  const values: { x: string | number; series: string; value: number }[] = [];
  for (const row of rows) {
    for (const s of series) {
      if (!hasOwn(row, s.key)) continue;
      const value = toNumber(row[s.key]);
      if (Number.isFinite(value)) values.push({ x: numericX ? (row[xKey] as number) : label(row[xKey]), series: s.label, value });
    }
  }
  if (values.length === 0) return { spec: null, problems };

  const multi = series.length > 1;
  const stacked = props.stacked === true && type !== "line";
  const horizontal = props.horizontal === true && type === "bar";
  const category = { field: "x", type: numericX ? "quantitative" : type === "bar" ? "nominal" : "ordinal", title: null, ...(numericX ? {} : { sort: null, axis: { labelAngle: 0 } }) };
  const measure = {
    field: "value",
    type: "quantitative",
    title: multi ? unit || null : unit ? `${names[0]} (${unit})` : names[0],
    stack: stacked ? "zero" : null,
  };
  const color = multi ? { color: { field: "series", type: "nominal", title: null, sort: null, scale: { domain: names } } } : {};
  const offset = multi && type === "bar" && !stacked ? { [horizontal ? "yOffset" : "xOffset"]: { field: "series", type: "nominal", sort: null, scale: { domain: names } } } : {};
  const mark = type === "bar" ? { type: "bar" } : type === "line" ? { type: "line", point: true } : { type: "area", line: true, ...(multi && !stacked ? { opacity: 0.5 } : {}) };
  return {
    spec: {
      ...title,
      data: { values },
      mark,
      encoding: { ...(horizontal ? { y: category, x: measure } : { x: category, y: measure }), ...color, ...offset },
    },
    problems,
  };
}
