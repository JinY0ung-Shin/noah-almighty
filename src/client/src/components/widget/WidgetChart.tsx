// A widget's <chart>: the frame around the drawing. It has the chart's height
// from its first frame (the answer below it never jumps), loads the chart
// library only when a chart is actually on its way (its own chunk, like
// mermaid), and — when the chart is to arrive with motion — holds the drawing
// back until the frame is on screen, so an entrance is seen and not spent above
// or below the fold.
//
// The drawing itself is components/widget/ChartDrawing.tsx (Recharts): tooltip,
// hover and the entrance are the library's. Until 2026-11-12 this was a static,
// sanitized Vega SVG with a hand-written entrance on top.
import { useEffect, useRef, useState, type ComponentType } from "react";

import type { SimpleChartModel } from "../../../../shared/widget/index";
import { prefersReducedMotion } from "../../lib/motion";
import { onScreen, wouldEnterAfresh, type EntranceRule } from "../../lib/uiEntrance";
import type { ChartDrawingProps } from "./ChartDrawing";

export interface WidgetChartProps {
  /** What to draw (shared/widget/chart.ts); null when the rows hold nothing to plot. */
  model: SimpleChartModel | null;
  /** The answer wrote the retired `<chart spec={…}>` (a Vega-Lite spec): say so instead of "nothing to draw". */
  retired?: boolean;
  /** The plot's height in px (the title sits above it). */
  height?: number;
  label?: string;
  dark?: boolean;
  /** How a chart that appears now may play its entrance (`WidgetCtx.entrance`); null draws it at rest. */
  entrance?: EntranceRule | null;
}

export const DEFAULT_CHART_HEIGHT = 240;

/** What names a chart for the once-per-answer entrance rule: what it draws, not where. */
export function chartKey(model: SimpleChartModel): string {
  return JSON.stringify(model);
}

// The chunk, once it is here: the next chart mounts with it in its first frame.
let loaded: ComponentType<ChartDrawingProps> | null = null;

export default function WidgetChart({ model, retired = false, height = undefined, label = "", dark = false, entrance = null }: WidgetChartProps) {
  const [Drawing, setDrawing] = useState<ComponentType<ChartDrawingProps> | null>(() => loaded);
  // Decided when the frame mounts: a chart that will enter waits for the frame
  // to be on screen; one that is drawn at rest is drawn now — an answer from the
  // history, 움직임 줄이기, and the stored message's chart whose entrance the
  // live bubble already played (waiting there would blank it for a frame).
  const [shown, setShown] = useState(() => entrance === null || model === null || prefersReducedMotion() || !wouldEnterAfresh(entrance, chartKey(model)));
  const host = useRef<HTMLDivElement | null>(null);
  const wanted = model !== null;

  useEffect(() => {
    if (!wanted || Drawing) return;
    let live = true;
    void import("./ChartDrawing").then((module) => {
      loaded = module.default;
      if (live) setDrawing(() => module.default);
    });
    return () => {
      live = false;
    };
  }, [wanted, Drawing]);

  useEffect(() => {
    if (shown || !wanted || !host.current) return;
    return onScreen(host.current, () => setShown(true));
  }, [shown, wanted]);

  if (!model) {
    return (
      <div className="wg-chart">
        <p className="wg-note">{retired ? "예전 형식(Vega-Lite 스펙)으로 작성된 차트라 더 이상 그릴 수 없습니다." : "표시할 차트가 없습니다."}</p>
      </div>
    );
  }

  const plot = height ?? DEFAULT_CHART_HEIGHT;
  return (
    <div className="wg-chart" role="group" aria-label={label || model.title || "차트"} ref={host}>
      {model.title ? <p className="wg-chart-title">{model.title}</p> : null}
      <div className="wg-chart-plot" style={{ height: `${plot}px` }}>
        {Drawing && shown ? <Drawing model={model} height={plot} dark={dark} entrance={entrance} /> : null}
      </div>
    </div>
  );
}
