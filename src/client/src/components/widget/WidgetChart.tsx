// A widget's <chart>: a Vega-Lite spec OBJECT drawn through the same pipeline
// as a `vega` canvas (inline data only, AST-evaluated expressions, DOMPurify,
// its own shadow root). The spec is recomputed on every state change, so
// renders are coalesced into one per animation frame, a result that lands
// after a newer one started is dropped, and an unchanged spec is not redrawn.
//
// The FIRST drawing of a chart that appears now (in an answer that is being
// written, or after the viewer's own press) enters with motion
// (lib/chartEntrance.ts); every later drawing replaces it at rest.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { dataSize } from "../../../../shared/widget/index";
import { chartSvg } from "../../lib/chartEntrance";
import { useAction, useLatest } from "../../lib/hooks";
import { claimEntrance, type Entrance, type EntranceRule } from "../../lib/uiEntrance";
import { renderVegaSvg } from "../../lib/vegaCanvas";

export interface WidgetChartProps {
  spec: unknown;
  height?: number;
  label?: string;
  dark?: boolean;
  /** How a chart that appears now may play its entrance (`WidgetCtx.entrance`); null draws it at rest. */
  entrance?: EntranceRule | null;
  /** Told when the chart cannot be drawn: one ENGLISH line for the avatar. */
  onProblem?: (problem: string) => void;
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 240;
// A spec is re-evaluated — and compared with the drawn one — on every state
// change, and Vega lays out every row of it. Past this size it is neither
// serialized for the comparison nor drawn.
const MAX_SPEC_CHARS = 200_000;

const TOO_BIG = "차트 데이터가 너무 커서 그리지 못했습니다.";

const NO_PROBLEM = () => {};

// Drawing is asynchronous (the Vega chunk on first use, then the render), so a
// chart has nothing to show for a moment after its tag has arrived. Two things
// keep the answer from jumping in that moment:
//
// - `drawn`: the markup (and measured height) of the charts drawn most
//   recently, by signature. A chart that MOUNTS with a spec already drawn —
//   above all the stored message taking over from the live bubble at the end of
//   a turn — is there in its first frame instead of blinking out and back.
// - a reserved height while nothing is drawn yet: the measured one when the
//   same chart was drawn before, else an estimate from the spec. Without it the
//   text that follows the chart was painted in the chart's place and pushed
//   down when the drawing landed.
const DRAWN_LIMIT = 16;
const drawn = new Map<string, { markup: string; height: number }>();

function remember(sig: string, markup: string, height: number): void {
  drawn.delete(sig);
  drawn.set(sig, { markup, height });
  while (drawn.size > DRAWN_LIMIT) drawn.delete(drawn.keys().next().value as string);
}

/** For tests: forget every drawing, so one test's chart is not another's first frame. */
export function forgetDrawnCharts(): void {
  drawn.clear();
}

// Around the plot Vega adds axes, labels and padding; the drawing is then
// fitted to the width it gets (never enlarged). Close enough to hold the place.
const AXES_WIDTH = 56;
const AXES_HEIGHT = 36;

function estimateHeight(target: unknown, hostWidth: number): number {
  const spec = target as Record<string, unknown>;
  if (!("mark" in spec) && !("layer" in spec)) return DEFAULT_HEIGHT;
  const plotWidth = typeof spec.width === "number" ? spec.width : DEFAULT_WIDTH;
  const plotHeight = typeof spec.height === "number" ? spec.height : DEFAULT_HEIGHT;
  const scale = hostWidth > 0 ? Math.min(1, hostWidth / (plotWidth + AXES_WIDTH)) : 1;
  return Math.round((plotHeight + AXES_HEIGHT) * scale);
}

// A single-view or layered chart takes the panel-friendly default size; a
// concat/facet spec sizes its own cells, where top-level width/height do not apply.
function sized(raw: Record<string, unknown>, h: number | undefined): unknown {
  if (!("mark" in raw) && !("layer" in raw)) return raw;
  return { width: DEFAULT_WIDTH, ...raw, height: h ?? (typeof raw.height === "number" ? raw.height : DEFAULT_HEIGHT) };
}

/** The drawing itself: its own element, so a chart that comes back after an empty state is MOUNTED again (and may enter). */
function ChartDrawing({ markup, enter, label }: { markup: string; enter: Entrance | null; label: string }) {
  return <div className="canvas-svg" data-fit="" role="img" aria-label={label || "차트"} ref={useAction(chartSvg, { markup, enter })}></div>;
}

export default function WidgetChart({ spec, height = undefined, label = "", dark = false, entrance = null, onProblem = NO_PROBLEM }: WidgetChartProps) {
  const [svg, setSvg] = useState("");
  // The entrance the drawing in `svg` is mounted with: set for this instance's first drawing only.
  const [enter, setEnter] = useState<Entrance | null>(null);
  const [error, setError] = useState("");
  // Nothing to draw: `spec` evaluated to nothing (an unpicked option, `cond ? {…} : null`).
  const [empty, setEmpty] = useState(false);
  // The height held while the drawing is on its way (0 = nothing to hold).
  const [reserved, setReserved] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // What is never shown: read when a frame fires or a render lands, long after the render that asked for it.
  const s = useRef({
    entered: false,
    drawnSig: "",
    wantedSig: "",
    wanted: null as unknown,
    token: 0,
    frame: 0,
    destroyed: false,
    // Read when the frame fires, not when it was requested: the theme can flip in between.
    darkNow: dark,
  }).current;
  s.darkNow = dark;
  const entranceNow = useLatest(entrance);
  const onProblemNow = useLatest(onProblem);

  function request(raw: unknown, h: number | undefined, isDark: boolean): void {
    const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
    if (!isObject || Object.keys(raw as object).length === 0) {
      settle("empty", "", true);
      return;
    }
    // Measured WITHOUT serializing; only a spec inside the cap is stringified below.
    if (dataSize(raw, MAX_SPEC_CHARS) > MAX_SPEC_CHARS) {
      if (s.wantedSig !== "too-big") onProblemNow.current(`<chart>: the spec is too large to draw (limit ${MAX_SPEC_CHARS} characters of JSON)`);
      settle("too-big", TOO_BIG, false);
      return;
    }
    const target = sized(raw as Record<string, unknown>, h);
    const sig = `${isDark ? "d" : "l"}${JSON.stringify(target)}`;
    setEmpty(false);
    if (sig === s.wantedSig) return;
    s.wantedSig = sig;
    s.wanted = target;
    const known = drawn.get(sig);
    if (known && !s.drawnSig) {
      // Nothing drawn here yet and this very chart was drawn a moment ago
      // (the live bubble's, as a rule): show it now, in this commit.
      show(known.markup, sig);
      return;
    }
    if (!s.drawnSig) setReserved(known?.height ?? estimateHeight(target, hostRef.current?.clientWidth ?? 0));
    if (s.frame) return;
    const run = () => {
      s.frame = 0;
      void draw(s.wanted, s.wantedSig, s.darkNow);
    };
    s.frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  /** Put a finished drawing on screen (a fresh render, or one remembered for this signature). */
  function show(markup: string, sig: string): void {
    s.token++;
    // The key is the spec without the theme: a chart redrawn for a theme flip is the same chart.
    const rule = entranceNow.current;
    setEnter(rule ? claimEntrance(rule, sig.slice(1), !s.entered) : null);
    s.entered = true;
    setSvg(markup);
    setError("");
    setReserved(0);
    s.drawnSig = sig;
  }

  /** A state with nothing to draw: drop the drawing and anything still on its way. */
  function settle(sig: string, message: string, isEmpty: boolean): void {
    s.wantedSig = sig;
    s.drawnSig = sig;
    s.token++;
    setSvg("");
    setReserved(0);
    // The chart is gone: the next one drawn here appears anew (`{cond ? spec : null}` is a tab, too).
    s.entered = false;
    setError(message);
    setEmpty(isEmpty);
  }

  async function draw(target: unknown, sig: string, isDark: boolean): Promise<void> {
    if (sig === s.drawnSig) return;
    const mine = ++s.token;
    try {
      const markup = await renderVegaSvg(target, isDark);
      if (s.destroyed || mine !== s.token) return; // a newer render won
      show(markup, sig);
      remember(sig, markup, 0);
    } catch (err) {
      if (s.destroyed || mine !== s.token) return;
      const detail = err instanceof Error ? err.message : "";
      setError(detail ? `차트를 그리지 못했습니다 (상세: ${detail})` : "차트를 그리지 못했습니다.");
      onProblemNow.current(`<chart>: ${detail || "the Vega-Lite spec could not be rendered"}`);
      // The previous drawing no longer matches the state: an old chart above the
      // error would read as the current one.
      setSvg("");
      setReserved(0);
      s.drawnSig = "";
    }
  }

  // After every render (the spec is an object: it may have changed whenever the
  // answer was evaluated again) and before paint, so a chart with nothing to
  // draw says so in its first frame. An unchanged spec returns at its signature.
  useLayoutEffect(() => {
    request(spec, height, dark);
  });

  // Once a drawing is on screen, note how tall it came out: the next mount of
  // the same chart holds exactly that. After paint — a layout read here must
  // not delay the frame that shows the chart.
  useEffect(() => {
    if (!svg || !s.drawnSig) return;
    const height = hostRef.current?.getBoundingClientRect().height ?? 0;
    if (height > 0) remember(s.drawnSig, svg, Math.round(height));
  }, [svg, s]);

  useEffect(() => {
    s.destroyed = false;
    return () => {
      s.destroyed = true;
      if (!s.frame) return;
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(s.frame);
      else clearTimeout(s.frame);
    };
  }, [s]);

  return (
    <div className="wg-chart" ref={hostRef} style={!svg && reserved > 0 ? { minHeight: `${reserved}px` } : undefined}>
      {svg ? <ChartDrawing markup={svg} enter={enter} label={label} /> : null}
      {error ? (
        <p className="canvas-render-error" role="alert">
          {error}
        </p>
      ) : empty ? (
        <p className="wg-note">표시할 차트가 없습니다.</p>
      ) : null}
    </div>
  );
}
