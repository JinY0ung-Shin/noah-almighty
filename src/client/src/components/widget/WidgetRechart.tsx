// SPIKE (2026-11-12): an inline `<chart>` in the simple form, drawn by Recharts
// instead of Vega (lib/chartEngine.ts). The library brings what the Vega path
// lacks or hand-builds: a tooltip under the pointer, the hovered mark and the
// hovered legend entry standing out, and the entrance. Text is rendered by
// React (nothing is injected as markup), so there is no sanitizing step.
//
// Kept from the Vega path: the app's own motion setting decides (never the
// OS), an entrance plays once per answer while it is written and whenever the
// viewer brings a chart up, never for an answer opened from the history
// (lib/uiEntrance.ts), and the chart's box has its height from the first frame.
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { SimpleChartModel } from "../../../../shared/widget/index";
import { prefersReducedMotion } from "../../lib/motion";
import { cssToken } from "../../lib/theme";
import { claimEntrance, type EntranceRule } from "../../lib/uiEntrance";

export interface WidgetRechartProps {
  model: SimpleChartModel;
  height?: number;
  label?: string;
  dark?: boolean;
  entrance?: EntranceRule | null;
}

const DEFAULT_HEIGHT = 240;
// The category colours Vega-Lite draws the same charts with, so switching engines does not recolour an answer.
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

export default function WidgetRechart({ model, height = undefined, label = "", dark = false, entrance = null }: WidgetRechartProps) {
  const sig = useMemo(() => JSON.stringify(model), [model]);
  // Decided once, when the chart mounts: does it arrive with motion?
  const [intro] = useState(() => {
    if (!entrance || prefersReducedMotion()) return false;
    const claimed = claimEntrance(entrance, sig, true);
    // An entrance already under way elsewhere (the live bubble's chart, a moment ago) is not played twice.
    if (!claimed || claimed.offset > 0) return false;
    claimed.started();
    return true;
  });
  // After the first frame: a change the viewer makes (a slider, a tab) moves the marks; history stays at rest.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const animate = !prefersReducedMotion() && (mounted ? entrance !== null : intro);

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
  const box = { width: "100%" as const, height: height ?? DEFAULT_HEIGHT };

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
    <div className="wg-chart wg-chart-rc" role="group" aria-label={label || model.title || "차트"}>
      {model.title ? <p className="wg-chart-title">{model.title}</p> : null}
      <ResponsiveContainer {...box}>{chart}</ResponsiveContainer>
    </div>
  );
}
