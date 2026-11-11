<script lang="ts">
  // A widget's <chart>: a Vega-Lite spec OBJECT drawn through the same pipeline
  // as a `vega` canvas (inline data only, AST-evaluated expressions, DOMPurify,
  // its own shadow root). The spec is recomputed on every state change, so
  // renders are coalesced into one per animation frame, a result that lands
  // after a newer one started is dropped, and an unchanged spec is not redrawn.
  //
  // The FIRST drawing of a chart that appears now (in an answer that is being
  // written, or after the viewer's own press) enters with motion
  // (lib/chartEntrance.ts); every later drawing replaces it at rest.
  import { onDestroy } from "svelte";

  import { dataSize } from "../../../../shared/widget/index";
  import { chartSvg } from "../../lib/chartEntrance";
  import { claimEntrance, type Entrance, type EntranceRule } from "../../lib/uiEntrance";
  import { renderVegaSvg } from "../../lib/vegaCanvas";

  export let spec: unknown;
  export let height: number | undefined = undefined;
  export let label = "";
  export let dark = false;
  /** How a chart that appears now may play its entrance (`WidgetCtx.entrance`); null draws it at rest. */
  export let entrance: EntranceRule | null = null;
  /** Told when the chart cannot be drawn: one ENGLISH line for the avatar. */
  export let onProblem: (problem: string) => void = () => {};

  const DEFAULT_WIDTH = 420;
  const DEFAULT_HEIGHT = 240;
  // A spec is re-evaluated — and compared with the drawn one — on every state
  // change, and Vega lays out every row of it. Past this size it is neither
  // serialized for the comparison nor drawn.
  const MAX_SPEC_CHARS = 200_000;

  const TOO_BIG = "차트 데이터가 너무 커서 그리지 못했습니다.";

  let svg = "";
  // The entrance the drawing in `svg` is mounted with: set for this instance's first drawing only.
  let enter: Entrance | null = null;
  let entered = false;
  let error = "";
  // Nothing to draw: `spec` evaluated to nothing (an unpicked option, `cond ? {…} : null`).
  let empty = false;
  let drawnSig = "";
  let wantedSig = "";
  let wanted: unknown = null;
  let token = 0;
  let frame = 0;
  let destroyed = false;

  // A single-view or layered chart takes the panel-friendly default size; a
  // concat/facet spec sizes its own cells, where top-level width/height do not apply.
  function sized(raw: Record<string, unknown>, h: number | undefined): unknown {
    if (!("mark" in raw) && !("layer" in raw)) return raw;
    return { width: DEFAULT_WIDTH, ...raw, height: h ?? (typeof raw.height === "number" ? raw.height : DEFAULT_HEIGHT) };
  }

  $: request(spec, height, dark);

  function request(raw: unknown, h: number | undefined, isDark: boolean): void {
    const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
    if (!isObject || Object.keys(raw as object).length === 0) {
      settle("empty", "", true);
      return;
    }
    // Measured WITHOUT serializing; only a spec inside the cap is stringified below.
    if (dataSize(raw, MAX_SPEC_CHARS) > MAX_SPEC_CHARS) {
      if (wantedSig !== "too-big") onProblem(`<chart>: the spec is too large to draw (limit ${MAX_SPEC_CHARS} characters of JSON)`);
      settle("too-big", TOO_BIG, false);
      return;
    }
    const target = sized(raw as Record<string, unknown>, h);
    const sig = `${isDark ? "d" : "l"}${JSON.stringify(target)}`;
    empty = false;
    if (sig === wantedSig) return;
    wantedSig = sig;
    wanted = target;
    if (frame) return;
    const run = () => {
      frame = 0;
      void draw(wanted, wantedSig, darkNow);
    };
    frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number);
  }

  /** A state with nothing to draw: drop the drawing and anything still on its way. */
  function settle(sig: string, message: string, isEmpty: boolean): void {
    wantedSig = sig;
    drawnSig = sig;
    token++;
    svg = "";
    // The chart is gone: the next one drawn here appears anew (`{cond ? spec : null}` is a tab, too).
    entered = false;
    error = message;
    empty = isEmpty;
  }

  // Read when the frame fires, not when it was requested: the theme can flip in between.
  let darkNow = dark;
  $: darkNow = dark;

  async function draw(target: unknown, sig: string, isDark: boolean): Promise<void> {
    if (sig === drawnSig) return;
    const mine = ++token;
    try {
      const markup = await renderVegaSvg(target, isDark);
      if (destroyed || mine !== token) return; // a newer render won
      // The key is the spec without the theme: a chart redrawn for a theme flip is the same chart.
      enter = entrance ? claimEntrance(entrance, sig.slice(1), !entered) : null;
      entered = true;
      svg = markup;
      error = "";
      drawnSig = sig;
    } catch (err) {
      if (destroyed || mine !== token) return;
      const detail = err instanceof Error ? err.message : "";
      error = detail ? `차트를 그리지 못했습니다 (상세: ${detail})` : "차트를 그리지 못했습니다.";
      onProblem(`<chart>: ${detail || "the Vega-Lite spec could not be rendered"}`);
      // The previous drawing no longer matches the state: an old chart above the
      // error would read as the current one.
      svg = "";
      drawnSig = "";
    }
  }

  onDestroy(() => {
    destroyed = true;
    if (!frame) return;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
    else clearTimeout(frame);
  });
</script>

<div class="wg-chart">
  {#if svg}
    <div class="canvas-svg" data-fit role="img" aria-label={label || "차트"} use:chartSvg={{ markup: svg, enter }}></div>
  {/if}
  {#if error}
    <p class="canvas-render-error" role="alert">{error}</p>
  {:else if empty}
    <p class="wg-note">표시할 차트가 없습니다.</p>
  {/if}
</div>
