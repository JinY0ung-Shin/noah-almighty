// SPIKE: loads the Recharts renderer (and Recharts itself) only when a chart
// is actually drawn with it, like Vega. The box has its height meanwhile.
import { useEffect, useState, type ComponentType } from "react";

import type { WidgetRechartProps } from "./WidgetRechart";

let loaded: ComponentType<WidgetRechartProps> | null = null;

export default function LazyRechart(props: WidgetRechartProps) {
  const [Chart, setChart] = useState<ComponentType<WidgetRechartProps> | null>(() => loaded);
  useEffect(() => {
    if (Chart) return;
    let live = true;
    void import("./WidgetRechart").then((module) => {
      loaded = module.default;
      if (live) setChart(() => module.default);
    });
    return () => {
      live = false;
    };
  }, [Chart]);
  if (!Chart) return <div className="wg-chart wg-chart-rc" style={{ minHeight: `${props.height ?? 240}px` }}></div>;
  return <Chart {...props} />;
}
