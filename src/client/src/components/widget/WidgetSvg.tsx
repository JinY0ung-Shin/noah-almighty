// A widget's <svg>: a drawing whose attributes and text follow the widget's
// state. What arrives is a tree of allowlisted elements with rebuilt values
// (shared/widget/svgRender.ts); it is printed, sanitized once more
// (lib/widgetSvg.ts) and drawn in this node's own shadow root, so nothing in
// it can style the app or meet another drawing's ids.
//
// A state change hands over a new tree: the SAME shadow root gets new
// content in one synchronous write (no re-mount, no empty frame), and a tree
// that prints to the same markup writes nothing at all. Nothing animates.
//
// The answer fits the drawing to its width and nothing in it reacts to a
// press, so a press on it — or the corner button, the keyboard's way in —
// opens it in 크게 보기 (lib/zoomViewer.ts). A drawing too small to need it (an
// icon, a sparkline) is left alone.
import { useEffect, useMemo, useRef } from "react";

import { svgMarkup, type SvgTree } from "../../../../shared/widget/index";
import { svgNaturalSize } from "../../lib/diagramSize";
import { useAction } from "../../lib/hooks";
import { shadowSvg } from "../../lib/shadowSvg";
import { sanitizeWidgetSvg } from "../../lib/widgetSvg";
import { zoomOpener, type ZoomOpener } from "../../lib/zoomOpener";

export interface WidgetSvgProps {
  tree: SvgTree | undefined;
  /** Accessible name: with one, the drawing is announced as a single image. */
  label?: string;
}

/** Below this drawn size (px) there is nothing to enlarge, and a corner button would cover the drawing. */
const MIN_ZOOMABLE = { width: 120, height: 80 };

function zoomable(tree: SvgTree | undefined): boolean {
  if (!tree) return false;
  const size = svgNaturalSize({ getAttribute: (name) => tree.attrs.find(([key]) => key === name)?.[1] ?? null });
  return !!size && size.width >= MIN_ZOOMABLE.width && size.height >= MIN_ZOOMABLE.height;
}

export default function WidgetSvg({ tree, label = "" }: WidgetSvgProps) {
  // The printed markup is a string: sanitized again only when it differs.
  const printed = tree ? svgMarkup(tree) : "";
  const clean = useMemo(() => sanitizeWidgetSvg(printed), [printed]);
  const drawing = useAction(shadowSvg, clean);
  const canZoom = zoomable(tree);

  const zoomer = useRef<ZoomOpener | null>(null);
  zoomer.current ??= zoomOpener();
  const latest = useRef(clean);
  latest.current = clean;
  // An open viewer follows the drawing (nothing when it is not open).
  useEffect(() => {
    if (clean) zoomer.current?.update({ svg: clean });
  }, [clean]);
  function enlarge(): void {
    const title = label || "그림";
    zoomer.current?.open(() => (latest.current ? { svg: latest.current } : null), { title, label: `${title} 크게 보기` });
  }

  return (
    <div className={canZoom ? "wg-svg is-zoomable" : "wg-svg"}>
      <div
        className="wg-svg-drawing"
        data-fit=""
        role={label ? "img" : undefined}
        aria-label={label || undefined}
        ref={drawing}
        onClick={canZoom ? enlarge : undefined}
      ></div>
      {canZoom ? (
        <button className="wg-svg-zoom" type="button" aria-haspopup="dialog" aria-label={`${label || "그림"} 크게 보기`} title="크게 보기" onClick={enlarge}>
          ⤢
        </button>
      ) : null}
    </div>
  );
}
