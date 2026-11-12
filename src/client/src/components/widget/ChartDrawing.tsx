// The drawing of a widget's <chart>, with Recharts: bar / stacked / horizontal
// / line / area / pie / donut from the model shared/widget/chart.ts reads out of
// the avatar's props. The library brings the tooltip under the pointer, the
// hovered mark and the hovered legend entry standing out, and the entrance.
// Text is rendered by React (nothing is injected as markup), so there is no
// sanitizing step. Loaded on demand by WidgetChart.tsx — keep Recharts out of
// every other module.
//
// The app's rules it keeps: the motion setting is the app's own (never the
// OS's); an entrance plays once per answer while it is written and whenever the
// viewer brings a chart up, never for an answer opened from the history
// (lib/uiEntrance.ts). An entrance already under way in the live bubble is not
// replayed when the stored message takes over: that chart is drawn at rest.
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { SimpleChartModel } from "../../../../shared/widget/index";
import { prefersReducedMotion } from "../../lib/motion";
import { cssToken } from "../../lib/theme";
import { claimEntrance, type EntranceRule } from "../../lib/uiEntrance";
import { chartKey } from "./WidgetChart";

export interface ChartDrawingProps {
  model: SimpleChartModel;
  /** The plot's height in px. */
  height: number;
  dark?: boolean;
  entrance?: EntranceRule | null;
}

// The category colours these charts have always had (Vega-Lite's defaults), so an old answer keeps its colours.
const PALETTE = ["#4c78a8", "#f58518", "#e45756", "#72b7b2", "#54a24b", "#eeca3b", "#b279a2", "#ff9da6", "#9d755d", "#bab0ac"];
const ENTRANCE_MS = 700;

const number = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 });

interface Wide {
  x: string | number;
  [series: string]: string | number;
}

/** One row per category, one column per series (`s0`, `s1`, … — a display name may hold dots, which a data key cannot). */
function wide(model: SimpleChartModel): Wide[] {
  const rows = new Map<string | number, Wide>();
  for (const v of model.values) {
    let row = rows.get(v.x);
    if (!row) rows.set(v.x, (row = { x: v.x }));
    row[`s${model.names.indexOf(v.series)}`] = v.value;
  }
  return [...rows.values()];
}

export default function ChartDrawing({ model, height, dark = false, entrance = null }: ChartDrawingProps) {
  const sig = useMemo(() => chartKey(model), [model]);
  // Decided once, when the chart mounts: does it arrive with motion?
  const [intro] = useState(() => {
    if (!entrance || prefersReducedMotion()) return false;
    const claimed = claimEntrance(entrance, sig, true);
    // An entrance already under way elsewhere (the live bubble's chart, a moment ago) is not played twice.
    if (!claimed || claimed.offset > 0) return false;
    claimed.started();
    return true;
  });
  // Only the ARRIVAL moves. Once it has played, a redraw of the chart that is
  // already there (a slider, a new row) lands at rest — values that follow the
  // pointer must not lag behind it.
  const [entering, setEntering] = useState(intro);
  useEffect(() => {
    if (!intro) return;
    const timer = window.setTimeout(() => setEntering(false), ENTRANCE_MS + 120);
    return () => window.clearTimeout(timer);
  }, [intro]);
  const animate = entering && !prefersReducedMotion();

  // The legend entry under the pointer: its series stands out, the others step back.
  const [hot, setHot] = useState<string | null>(null);
  const dim = (key: string): number => (hot !== null && hot !== key ? 0.25 : 1);

  const colors = useMemo(
    () => ({
      text: cssToken("--text", dark ? "#e5e7eb" : "#161b21"),
      muted: cssToken("--muted", dark ? "#cbd5e1" : "#505b66"),
      line: cssToken("--line", dark ? "#475569" : "#d6dde4"),
      grid: cssToken("--line-soft", dark ? "#334155" : "#e3e8ed"),
    }),
    [dark],
  );
  const { type, names, unit, stacked, horizontal, numericX } = model;
  const multi = names.length > 1;
  const withUnit = (value: unknown): string => `${typeof value === "number" ? number.format(value) : String(value ?? "")}${unit ? ` ${unit}` : ""}`;
  const tick = { fill: colors.muted, fontSize: 12 };
  const motion = { isAnimationActive: animate, animationDuration: ENTRANCE_MS, animationEasing: "ease-out" as const };
  const tooltip = (
    <Tooltip
      formatter={(value) => withUnit(value)}
      cursor={type === "bar" ? { fill: colors.grid, fillOpacity: 0.6 } : { stroke: colors.line }}
      contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", boxShadow: "var(--shadow-sm)", fontSize: "var(--t-sm)" }}
      labelStyle={{ color: "var(--text)", fontWeight: 600 }}
      itemStyle={{ color: "var(--text)" }}
      isAnimationActive={false}
    />
  );
  const legend = (
    <Legend
      itemSorter={null}
      wrapperStyle={{ fontSize: 12, color: colors.muted }}
      onMouseEnter={(entry) => setHot(String(entry.dataKey ?? entry.value ?? ""))}
      onMouseLeave={() => setHot(null)}
    />
  );
  const measureLabel = multi ? unit : unit ? `${names[0]} (${unit})` : names[0];
  let chart;
  if (type === "pie" || type === "donut") {
    // Largest slice first, as before.
    const slices = [...model.values].sort((a, b) => b.value - a.value).map((v) => ({ name: String(v.x), value: v.value }));
    const order = model.values.map((v) => String(v.x));
    chart = (
      <PieChart>
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius={type === "donut" ? "52%" : 0} outerRadius="82%" startAngle={90} endAngle={-270} stroke="var(--bg-elevated)" {...motion}>
          {slices.map((slice) => (
            <Cell key={slice.name} fill={PALETTE[order.indexOf(slice.name) % PALETTE.length]} fillOpacity={hot !== null && hot !== slice.name ? 0.25 : 1} />
          ))}
        </Pie>
        {tooltip}
        {legend}
      </PieChart>
    );
  } else {
    const data = wide(model);
    const category = numericX ? { dataKey: "x", type: "number" as const, domain: ["dataMin", "dataMax"] as [string, string] } : { dataKey: "x", type: "category" as const };
    const axisLine = { stroke: colors.line };
    const categoryAxis = horizontal ? <YAxis {...category} tick={tick} axisLine={axisLine} tickLine={axisLine} width={72} /> : <XAxis {...category} tick={tick} axisLine={axisLine} tickLine={axisLine} />;
    const measureAxis = horizontal ? (
      <XAxis type="number" tick={tick} axisLine={axisLine} tickLine={axisLine} tickFormatter={(v: number) => number.format(v)} label={measureLabel ? { value: measureLabel, position: "insideBottom", offset: -2, fill: colors.text, fontSize: 12 } : undefined} />
    ) : (
      <YAxis type="number" tick={tick} axisLine={axisLine} tickLine={axisLine} tickFormatter={(v: number) => number.format(v)} label={measureLabel ? { value: measureLabel, angle: -90, position: "insideLeft", fill: colors.text, fontSize: 12, style: { textAnchor: "middle" } } : undefined} />
    );
    const grid = <CartesianGrid stroke={colors.grid} vertical={horizontal} horizontal={!horizontal} />;
    const margin = { top: 8, right: 12, bottom: horizontal && measureLabel ? 16 : 4, left: 4 };
    if (type === "bar") {
      chart = (
        <BarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={margin}>
          {grid}
          {categoryAxis}
          {measureAxis}
          {tooltip}
          {multi ? legend : null}
          {names.map((name, i) => (
            <Bar key={name} dataKey={`s${i}`} name={name} fill={PALETTE[i % PALETTE.length]} fillOpacity={dim(`s${i}`)} stackId={stacked ? "stack" : undefined} activeBar={{ fillOpacity: 1, stroke: colors.text, strokeWidth: 1 }} {...motion} />
          ))}
        </BarChart>
      );
    } else if (type === "line") {
      chart = (
        <LineChart data={data} margin={margin}>
          {grid}
          {categoryAxis}
          {measureAxis}
          {tooltip}
          {multi ? legend : null}
          {names.map((name, i) => (
            <Line key={name} dataKey={`s${i}`} name={name} type="linear" stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} strokeOpacity={dim(`s${i}`)} dot={{ r: 3, fill: PALETTE[i % PALETTE.length] }} activeDot={{ r: 5 }} {...motion} />
          ))}
        </LineChart>
      );
    } else {
      chart = (
        <AreaChart data={data} margin={margin}>
          {grid}
          {categoryAxis}
          {measureAxis}
          {tooltip}
          {multi ? legend : null}
          {names.map((name, i) => (
            <Area key={name} dataKey={`s${i}`} name={name} type="linear" stroke={PALETTE[i % PALETTE.length]} fill={PALETTE[i % PALETTE.length]} fillOpacity={(multi && !stacked ? 0.5 : 0.85) * dim(`s${i}`)} strokeOpacity={dim(`s${i}`)} stackId={stacked ? "stack" : undefined} activeDot={{ r: 5 }} {...motion} />
          ))}
        </AreaChart>
      );
    }
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      {chart}
    </ResponsiveContainer>
  );
}
