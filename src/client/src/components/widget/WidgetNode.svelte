<script lang="ts" context="module">
  import { renderWidgetProse } from "../../lib/widgetProse";

  // Top-level prose is STATIC Markdown (no interpolation), so its sanitized HTML
  // depends on the source text alone — and a widget re-evaluates on every slider
  // step. `renderWidgetProse` keeps only the tags Markdown produces and no
  // class / id / style / href: the avatar's prose cannot dress itself as the
  // app's own controls or sit over them.
  const MD_CACHE_LIMIT = 200;
  const mdCache = new Map<string, string>();
  function mdHtml(text: string): string {
    const hit = mdCache.get(text);
    if (hit !== undefined) return hit;
    const html = renderWidgetProse(text);
    mdCache.set(text, html);
    if (mdCache.size > MD_CACHE_LIMIT) {
      const oldest = mdCache.keys().next().value;
      if (oldest !== undefined) mdCache.delete(oldest);
    }
    return html;
  }
</script>

<script lang="ts">
  // One evaluated node of a canvas widget (lib/widgetView.ts). The component
  // reads nothing but the `v` it is handed, so a state change — which hands it a
  // NEW `v` — can never leave a stale value on screen. Containers render their
  // children with this same component.
  //
  // The only `{@html}` here is the sanitized static Markdown above (an allowlist
  // of Markdown's own tags, no attributes); everything an expression produced is
  // inserted as text.
  import type { VNode } from "../../lib/widgetView";
  import type { WidgetCtx } from "../../lib/widgetCtx";
  import { cellText } from "../../lib/widgetView";
  import { colorStyle, containerStyle, imageStyle, spacerStyle, textStyle, toneStyle } from "../../lib/widgetStyle";
  import { WIDGET_ICON_SIZES, type WidgetColumn } from "../../../../shared/widget/index";
  import Icon from "../Icon.svelte";
  import WidgetChart from "./WidgetChart.svelte";
  import WidgetControl from "./WidgetControl.svelte";
  import WidgetInline from "./WidgetInline.svelte";
  import WidgetNode from "./WidgetNode.svelte";
  import WidgetSvg from "./WidgetSvg.svelte";
  import WidgetTable from "./WidgetTable.svelte";

  export let v: VNode;
  export let ctx: WidgetCtx;

  const CONTROLS = new Set(["button", "segmented-control", "checkbox", "switch", "slider", "select", "input", "tabs"]);
  const TREND_MARK: Record<string, string> = { up: "▲", down: "▼", flat: "–" };

  function columnsOf(value: unknown): WidgetColumn[] {
    return Array.isArray(value) ? (value as WidgetColumn[]) : [];
  }
  function rowsOf(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }
  /** An icon name the library validated against the app's own icon list ("" draws nothing). */
  function iconName(value: unknown): string {
    return typeof value === "string" ? value : "";
  }
  function iconSize(value: unknown): number {
    return (typeof value === "string" && Object.prototype.hasOwnProperty.call(WIDGET_ICON_SIZES, value) ? WIDGET_ICON_SIZES[value] : undefined) ?? WIDGET_ICON_SIZES.md;
  }
  /**
   * `open` is the section's INITIAL state. Written once at mount and never
   * again: as an attribute it was re-applied on every evaluation, so a section
   * the person opened snapped shut the moment a control inside it changed state.
   */
  function initialOpen(node: HTMLDetailsElement, open: boolean) {
    node.open = open;
    return {};
  }
  function percent(value: unknown): number {
    return typeof value === "number" ? Math.round(Math.min(1, Math.max(0, value)) * 100) : 0;
  }
</script>

{#if v.k === "md"}
  <div class="wg-md md">{@html mdHtml(v.text)}</div>
{:else if v.k === "inline"}
  <p class="wg-inline"><WidgetInline segs={v.segs} /></p>
{:else if v.k === "error"}
  <p class="wg-error" role="note" title={v.detail}>{v.message}</p>
{:else if v.k === "warn"}
  <p class="wg-note wg-warn" role="note" title={v.detail}>{v.message}</p>
{:else if v.k === "note"}
  <p class="wg-note">{v.message}</p>
{:else if v.tag === "box" || v.tag === "row" || v.tag === "col" || v.tag === "grid" || v.tag === "grid-item"}
  <div class={`wg-${v.tag}`} class:wg-bordered={v.props.border === true} style={containerStyle(v.tag, v.props)}>
    {#each v.children as child (child.key)}<WidgetNode v={child} {ctx} />{/each}
  </div>
{:else if v.tag === "divider"}
  <hr class="wg-divider" />
{:else if v.tag === "spacer"}
  <div class="wg-spacer" style={spacerStyle(v.props)} aria-hidden="true"></div>
{:else if v.tag === "title"}
  <div class={`wg-title wg-title-${typeof v.props.size === "string" ? v.props.size : "md"}`} role="heading" aria-level="3" style={colorStyle(v.props.color)}>
    <WidgetInline segs={v.segs} />
  </div>
{:else if v.tag === "text"}
  <p
    class={`wg-text wg-text-${typeof v.props.size === "string" ? v.props.size : "md"} wg-weight-${typeof v.props.weight === "string" ? v.props.weight : "normal"}`}
    class:wg-tabular={v.props.tabular === true}
    style={textStyle(v.props)}
  >
    <WidgetInline segs={v.segs} />
  </p>
{:else if v.tag === "badge"}
  <span class="wg-badge" style={toneStyle(v.props.tone)}><WidgetInline segs={v.segs} /></span>
{:else if v.tag === "callout"}
  {#if iconName(v.props.icon)}
    <div class="wg-callout wg-callout-row" role="note" style={toneStyle(v.props.tone ?? "info")}>
      <span class="wg-callout-mark"><Icon name={iconName(v.props.icon)} size={16} /></span>
      <div class="wg-callout-body">
        {#if typeof v.props.title === "string" && v.props.title}<div class="wg-callout-title">{v.props.title}</div>{/if}
        {#each v.children as child (child.key)}<WidgetNode v={child} {ctx} />{/each}
      </div>
    </div>
  {:else}
    <div class="wg-callout" role="note" style={toneStyle(v.props.tone ?? "info")}>
      {#if typeof v.props.title === "string" && v.props.title}<div class="wg-callout-title">{v.props.title}</div>{/if}
      {#each v.children as child (child.key)}<WidgetNode v={child} {ctx} />{/each}
    </div>
  {/if}
{:else if v.tag === "details"}
  <details class="wg-details" use:initialOpen={v.props.open === true}>
    <summary>{typeof v.props.title === "string" ? v.props.title : ""}</summary>
    <div class="wg-details-body">
      {#each v.children as child (child.key)}<WidgetNode v={child} {ctx} />{/each}
    </div>
  </details>
{:else if v.tag === "stat"}
  <div class="stat-card wg-stat">
    <span class="stat-label">{cellText(v.props.label)}</span>
    <span class="stat-value wg-tabular">{cellText(v.props.value)}</span>
    {#if typeof v.props.delta === "string" && v.props.delta}
      <span class={`stat-sub wg-trend-${typeof v.props.trend === "string" ? v.props.trend : "flat"}`}>
        {#if typeof v.props.trend === "string"}<span aria-hidden="true">{TREND_MARK[v.props.trend] ?? ""}</span>{/if}
        {v.props.delta}
      </span>
    {/if}
    {#if typeof v.props.hint === "string" && v.props.hint}<span class="stat-sub wg-hint">{v.props.hint}</span>{/if}
  </div>
{:else if v.tag === "progress"}
  <div class="wg-field" style={toneStyle(v.props.tone ?? "accent")}>
    <div class="wg-progress-head">
      <span id={`${ctx.domId(v.key)}-label`} class="wg-label">{cellText(v.props.label)}</span>
      <span class="wg-tabular wg-progress-value">{percent(v.props.value)}%</span>
    </div>
    <div
      class="wg-progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent(v.props.value)}
      aria-labelledby={`${ctx.domId(v.key)}-label`}
    >
      <div class="wg-progress-bar" style={`width:${percent(v.props.value)}%`}></div>
    </div>
  </div>
{:else if v.tag === "table"}
  <WidgetTable
    columns={columnsOf(v.props.columns)}
    rows={rowsOf(v.props.rows)}
    sortable={v.props.sortable === true}
    caption={typeof v.props.caption === "string" ? v.props.caption : ""}
  />
{:else if v.tag === "image"}
  <!-- An image of THIS conversation only (lib/widgetView.ts rebuilt the address
       from its two ids after checking the conversation). -->
  <img class="wg-image" src={typeof v.props.src === "string" ? v.props.src : ""} alt={typeof v.props.alt === "string" ? v.props.alt : ""} loading="lazy" style={imageStyle(v.props)} />
{:else if v.tag === "icon"}
  <!-- One of the app's own icons, by a name the library checked against its list.
       Decoration unless it is given a name. -->
  {#if typeof v.props.label === "string" && v.props.label}
    <span class="wg-icon" role="img" aria-label={v.props.label} style={colorStyle(v.props.color)}><Icon name={iconName(v.props.name)} size={iconSize(v.props.size)} /></span>
  {:else}
    <span class="wg-icon" aria-hidden="true" style={colorStyle(v.props.color)}><Icon name={iconName(v.props.name)} size={iconSize(v.props.size)} /></span>
  {/if}
{:else if v.tag === "svg"}
  <WidgetSvg tree={v.svg} label={typeof v.props.label === "string" ? v.props.label : ""} />
{:else if v.tag === "chart"}
  <WidgetChart
    spec={v.props.spec}
    height={typeof v.props.height === "number" ? v.props.height : undefined}
    label={typeof v.props.label === "string" ? v.props.label : ""}
    dark={ctx.dark}
    onProblem={ctx.report}
  />
{:else if v.tag === "submit"}
  <button
    type="button"
    class="btn btn-primary btn-sm wg-submit"
    disabled={v.props.disabled === true || ctx.locked}
    aria-describedby={ctx.statusId}
    on:click={() => ctx.submit(v.props.values)}
  >{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{typeof v.props.label === "string" && v.props.label ? v.props.label : "보내기"}{/if}</button>
{:else if CONTROLS.has(v.tag)}
  <WidgetControl {v} {ctx} />
{/if}
{#if v.k === "el" && v.flawed}
  <p class="wg-error" role="note" title={v.flawed}>일부 설정을 적용하지 못했습니다.</p>
{/if}
