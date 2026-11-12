// One evaluated node of inline UI (lib/widgetView.ts). The component reads
// nothing but the `v` it is handed, so a state change — which hands it a NEW
// `v` — can never leave a stale value on screen. Containers render their
// children with this same component.
//
// There is no `dangerouslySetInnerHTML` here: everything the avatar wrote, and
// everything an expression produced, is inserted as text.
import type { SimpleChartModel } from "../../../../shared/widget/index";
import type { CSSProperties, ReactNode } from "react";

import { WIDGET_ICON_SIZES, type WidgetColumn } from "../../../../shared/widget/index";
import { cx, useAction } from "../../lib/hooks";
import { enter, fillSteps } from "../../lib/uiEntrance";
import type { WidgetCtx } from "../../lib/widgetCtx";
import { colorStyle, containerStyle, imageStyle, spacerStyle, textStyle, toneStyle } from "../../lib/widgetStyle";
import { cellText, type ElVNode, type VNode } from "../../lib/widgetView";
import Icon from "../Icon";
import LazyRechart from "./LazyRechart";
import WidgetChart from "./WidgetChart";
import WidgetControl from "./WidgetControl";
import WidgetInline from "./WidgetInline";
import WidgetStatValue from "./WidgetStatValue";
import WidgetSvg from "./WidgetSvg";
import WidgetTable from "./WidgetTable";

export interface WidgetNodeProps {
  v: VNode;
  ctx: WidgetCtx;
}

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
/**
 * The inline styles arrive as CSS text (lib/widgetStyle.ts builds it from the
 * library's tokens and clamped numbers only); React takes them as an object.
 */
function styleOf(css: string): CSSProperties | undefined {
  if (!css) return undefined;
  const out: Record<string, string> = {};
  for (const part of css.split(";")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!name || !value) continue;
    out[name.startsWith("--") ? name : name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  return out as CSSProperties;
}

function children(v: ElVNode, ctx: WidgetCtx): ReactNode {
  return v.children.map((child) => <WidgetNode key={child.key} v={child} ctx={ctx} />);
}

/** `<details>`: its own component for the one write of its initial state. */
function DetailsNode({ v, ctx }: { v: ElVNode; ctx: WidgetCtx }) {
  return (
    <details className="wg-details" ref={useAction(initialOpen, v.props.open === true)}>
      <summary>{typeof v.props.title === "string" ? v.props.title : ""}</summary>
      <div className="wg-details-body">{children(v, ctx)}</div>
    </details>
  );
}

/** `<progress>`: its own component for the bar's entrance (it fills when it appears now). */
function ProgressNode({ v, ctx }: { v: ElVNode; ctx: WidgetCtx }) {
  const bar = useAction(enter, { rule: ctx.entrance, key: `progress:${v.key}`, steps: fillSteps });
  return (
    <div className="wg-field" style={styleOf(toneStyle(v.props.tone ?? "accent"))}>
      <div className="wg-progress-head">
        <span id={`${ctx.domId(v.key)}-label`} className="wg-label">
          {cellText(v.props.label)}
        </span>
        <span className="wg-tabular wg-progress-value">{percent(v.props.value)}%</span>
      </div>
      <div className="wg-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent(v.props.value)} aria-labelledby={`${ctx.domId(v.key)}-label`}>
        <div className="wg-progress-bar" style={{ width: `${percent(v.props.value)}%` }} ref={bar}></div>
      </div>
    </div>
  );
}

function element(v: ElVNode, ctx: WidgetCtx): ReactNode {
  if (v.tag === "box" || v.tag === "row" || v.tag === "col" || v.tag === "grid" || v.tag === "grid-item") {
    return (
      <div className={cx(`wg-${v.tag}`, v.props.border === true && "wg-bordered")} style={styleOf(containerStyle(v.tag, v.props))}>
        {children(v, ctx)}
      </div>
    );
  }
  if (v.tag === "divider") return <hr className="wg-divider" />;
  if (v.tag === "spacer") return <div className="wg-spacer" style={styleOf(spacerStyle(v.props))} aria-hidden="true"></div>;
  if (v.tag === "title") {
    return (
      <div className={`wg-title wg-title-${typeof v.props.size === "string" ? v.props.size : "md"}`} role="heading" aria-level={3} style={styleOf(colorStyle(v.props.color))}>
        <WidgetInline segs={v.segs} />
      </div>
    );
  }
  if (v.tag === "text") {
    return (
      <p
        className={cx(
          `wg-text wg-text-${typeof v.props.size === "string" ? v.props.size : "md"} wg-weight-${typeof v.props.weight === "string" ? v.props.weight : "normal"}`,
          v.props.tabular === true && "wg-tabular",
        )}
        style={styleOf(textStyle(v.props))}
      >
        <WidgetInline segs={v.segs} />
      </p>
    );
  }
  if (v.tag === "badge") {
    return (
      <span className="wg-badge" style={styleOf(toneStyle(v.props.tone))}>
        <WidgetInline segs={v.segs} />
      </span>
    );
  }
  if (v.tag === "callout") {
    const title = typeof v.props.title === "string" && v.props.title ? <div className="wg-callout-title">{v.props.title}</div> : null;
    if (iconName(v.props.icon)) {
      return (
        <div className="wg-callout wg-callout-row" role="note" style={styleOf(toneStyle(v.props.tone ?? "info"))}>
          <span className="wg-callout-mark">
            <Icon name={iconName(v.props.icon)} size={16} />
          </span>
          <div className="wg-callout-body">
            {title}
            {children(v, ctx)}
          </div>
        </div>
      );
    }
    return (
      <div className="wg-callout" role="note" style={styleOf(toneStyle(v.props.tone ?? "info"))}>
        {title}
        {children(v, ctx)}
      </div>
    );
  }
  if (v.tag === "details") return <DetailsNode v={v} ctx={ctx} />;
  if (v.tag === "stat") {
    return (
      <div className="stat-card wg-stat">
        <span className="stat-label">{cellText(v.props.label)}</span>
        <WidgetStatValue text={cellText(v.props.value)} entrance={ctx.entrance} entranceKey={`stat:${v.key}`} />
        {typeof v.props.delta === "string" && v.props.delta ? (
          <span className={`stat-sub wg-trend-${typeof v.props.trend === "string" ? v.props.trend : "flat"}`}>
            {typeof v.props.trend === "string" ? <span aria-hidden="true">{TREND_MARK[v.props.trend] ?? ""}</span> : null}
            {" "}
            {v.props.delta}
          </span>
        ) : null}
        {typeof v.props.hint === "string" && v.props.hint ? <span className="stat-sub wg-hint">{v.props.hint}</span> : null}
      </div>
    );
  }
  if (v.tag === "progress") return <ProgressNode v={v} ctx={ctx} />;
  if (v.tag === "table") {
    return (
      <WidgetTable
        columns={columnsOf(v.props.columns)}
        rows={rowsOf(v.props.rows)}
        sortable={v.props.sortable === true}
        caption={typeof v.props.caption === "string" ? v.props.caption : ""}
        entrance={ctx.entrance}
        entranceKey={`table:${v.key}`}
      />
    );
  }
  if (v.tag === "image") {
    // An image of THIS conversation only (lib/widgetView.ts rebuilt the address
    // from its two ids after checking the conversation).
    return <img className="wg-image" src={typeof v.props.src === "string" ? v.props.src : ""} alt={typeof v.props.alt === "string" ? v.props.alt : ""} loading="lazy" style={styleOf(imageStyle(v.props))} />;
  }
  if (v.tag === "icon") {
    // One of the app's own icons, by a name the library checked against its list.
    // Decoration unless it is given a name.
    if (typeof v.props.label === "string" && v.props.label) {
      return (
        <span className="wg-icon" role="img" aria-label={v.props.label} style={styleOf(colorStyle(v.props.color))}>
          <Icon name={iconName(v.props.name)} size={iconSize(v.props.size)} />
        </span>
      );
    }
    return (
      <span className="wg-icon" aria-hidden="true" style={styleOf(colorStyle(v.props.color))}>
        <Icon name={iconName(v.props.name)} size={iconSize(v.props.size)} />
      </span>
    );
  }
  if (v.tag === "svg") return <WidgetSvg tree={v.svg} label={typeof v.props.label === "string" ? v.props.label : ""} />;
  if (v.tag === "chart") {
    if (ctx.chartEngine === "recharts" && v.props.simple) {
      return (
        <LazyRechart
          model={v.props.simple as SimpleChartModel}
          height={typeof v.props.height === "number" ? v.props.height : undefined}
          label={typeof v.props.label === "string" ? v.props.label : ""}
          dark={ctx.dark}
          entrance={ctx.entrance}
        />
      );
    }
    return (
      <WidgetChart
        spec={v.props.spec}
        height={typeof v.props.height === "number" ? v.props.height : undefined}
        label={typeof v.props.label === "string" ? v.props.label : ""}
        dark={ctx.dark}
        entrance={ctx.entrance}
        onProblem={ctx.report}
      />
    );
  }
  if (v.tag === "submit") {
    const label = typeof v.props.label === "string" && v.props.label ? v.props.label : "보내기";
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm wg-submit"
        disabled={v.props.disabled === true || ctx.locked}
        aria-describedby={ctx.statusId}
        onClick={() => ctx.submit(v.props.values, v.segs.length ? v.segs.map((seg) => seg.text).join("") : label)}
      >
        {v.segs.length ? <WidgetInline segs={v.segs} /> : label}
      </button>
    );
  }
  if (CONTROLS.has(v.tag)) return <WidgetControl v={v} ctx={ctx} />;
  return null;
}

export default function WidgetNode({ v, ctx }: WidgetNodeProps) {
  if (v.k === "inline") {
    return (
      <p className="wg-inline">
        <WidgetInline segs={v.segs} />
      </p>
    );
  }
  if (v.k === "error") {
    return (
      <p className="wg-error" role="note" title={v.detail}>
        {v.message}
      </p>
    );
  }
  if (v.k === "warn") {
    return (
      <p className="wg-note wg-warn" role="note" title={v.detail}>
        {v.message}
      </p>
    );
  }
  if (v.k === "note") return <p className="wg-note">{v.message}</p>;
  return (
    <>
      {element(v, ctx)}
      {v.flawed ? (
        <p className="wg-error" role="note" title={v.flawed}>
          일부 설정을 적용하지 못했습니다.
        </p>
      ) : null}
    </>
  );
}
