// A widget's <svg>: a drawing whose attributes and text follow the widget's
// state. What arrives is a tree of allowlisted elements with rebuilt values
// (shared/widget/svgRender.ts); it is printed, sanitized once more
// (lib/widgetSvg.ts) and drawn in this node's own shadow root, so nothing in
// it can style the app or meet another drawing's ids.
//
// A state change hands over a new tree: the SAME shadow root gets new
// content in one synchronous write (no re-mount, no empty frame), and a tree
// that prints to the same markup writes nothing at all. Nothing animates.
import { useMemo } from "react";

import { svgMarkup, type SvgTree } from "../../../../shared/widget/index";
import { useAction } from "../../lib/hooks";
import { shadowSvg } from "../../lib/shadowSvg";
import { sanitizeWidgetSvg } from "../../lib/widgetSvg";

export interface WidgetSvgProps {
  tree: SvgTree | undefined;
  /** Accessible name: with one, the drawing is announced as a single image. */
  label?: string;
}

export default function WidgetSvg({ tree, label = "" }: WidgetSvgProps) {
  // The printed markup is a string: sanitized again only when it differs.
  const printed = tree ? svgMarkup(tree) : "";
  const clean = useMemo(() => sanitizeWidgetSvg(printed), [printed]);
  return <div className="wg-svg" data-fit="" role={label ? "img" : undefined} aria-label={label || undefined} ref={useAction(shadowSvg, clean)}></div>;
}
