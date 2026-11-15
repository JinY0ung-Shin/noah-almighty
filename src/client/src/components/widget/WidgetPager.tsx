// `<pager>`: its `<page>` children ONE AT A TIME, with a compact "‹ n / N ›"
// header — a quiz question by question, a guide step by step.
//
// Every page is evaluated (lib/widgetView.ts), so the document is the same
// whichever page shows; only the current one is mounted. The position is the
// pager's own unless the answer binds it: a `value` that CHANGES moves the
// pager there (a "다음" button of the answer's own, a restored state), and a
// turn of the page calls `onChange` with the new index — as an event, through
// `ctx.fire`, like every other control. `nextDisabled` turns the › arrow off
// (answer first, then go on).
import { useState, type KeyboardEvent, type ReactNode } from "react";

import type { WidgetCtx } from "../../lib/widgetCtx";
import type { ElVNode, VNode } from "../../lib/widgetView";
import Icon from "../Icon";

export interface WidgetPagerProps {
  v: ElVNode;
  ctx: WidgetCtx;
  /** Draws one child node (WidgetNode, passed in to keep the import one-way). */
  draw: (child: VNode) => ReactNode;
}

function isPage(child: VNode): child is ElVNode {
  return child.k === "el" && child.tag === "page";
}

export default function WidgetPager({ v, ctx, draw }: WidgetPagerProps) {
  const pages = v.children.filter(isPage);
  // What is not a page (an error node, a list cut short) is still shown, under the page.
  const rest = v.children.filter((child) => !isPage(child));
  const count = pages.length;
  const given = typeof v.props.value === "number" ? v.props.value : null;
  const [own, setOwn] = useState(given ?? 0);
  const [seen, setSeen] = useState(given);
  if (given !== seen) {
    // The answer moved it (or let go of it): follow, during this render.
    setSeen(given);
    if (given !== null) setOwn(given);
  }
  const index = Math.min(Math.max(0, own), Math.max(0, count - 1));
  const label = typeof v.props.label === "string" ? v.props.label : "";
  const canBack = index > 0;
  const canNext = index < count - 1 && v.props.nextDisabled !== true;

  function go(next: number) {
    if (next === index || next < 0 || next >= count) return;
    if (next > index && !canNext) return;
    setOwn(next);
    if (typeof v.props.onChange === "function") ctx.fire(v.props.onChange, [next]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") go(index - 1);
    else if (event.key === "ArrowRight") go(index + 1);
    else return;
    event.preventDefault();
  }

  const page = pages[index];
  return (
    <section className="wg-pager" aria-label={label || "페이지"} aria-roledescription="페이지 넘김">
      <div className="wg-pager-head">
        {label ? <span className="wg-pager-label">{label}</span> : <span></span>}
        {count > 0 ? (
          // aria-disabled, not disabled: the arrow keeps the focus at either end.
          <div className="wg-pager-nav" role="group" aria-label="페이지 이동" onKeyDown={onKeyDown}>
            <button type="button" className="wg-pager-arrow" aria-label="이전" aria-disabled={!canBack} onClick={() => go(index - 1)}>
              <Icon name="chevron-left" size={16} />
            </button>
            <span className="wg-pager-count wg-tabular" aria-live="polite" aria-atomic="true">
              {index + 1} / {count}
            </span>
            <button type="button" className="wg-pager-arrow" aria-label="다음" aria-disabled={!canNext} onClick={() => go(index + 1)}>
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
        ) : null}
      </div>
      {page ? (
        <div className="wg-pager-body" key={page.key}>
          {draw(page)}
        </div>
      ) : null}
      {rest.map((child) => draw(child))}
    </section>
  );
}
