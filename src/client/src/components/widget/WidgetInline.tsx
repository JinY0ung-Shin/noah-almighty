// Inline text of inline UI: styled runs assembled from ELEMENTS, with
// every run's text inserted as a text node. Nothing here parses HTML, so a
// value like `<img onerror=…>` an avatar interpolates shows as those characters.
//
// A run may be a link (`<link href>` or `[text](https://…)`): its target is an
// absolute http(s) URL the shared library already normalized, it opens in a
// new tab without handing this page to it, and the address is the tooltip —
// the reader sees where it goes before following it.
import { Fragment, type ReactNode } from "react";

import type { Seg } from "../../lib/widgetView";

export interface WidgetInlineProps {
  segs?: Seg[];
}

function run(seg: Seg): ReactNode {
  const strike = seg.s ? "wg-strike" : undefined;
  if (seg.code) return <code className="wg-code">{seg.text}</code>;
  if (seg.b && seg.i) {
    return (
      <strong>
        <em className={strike}>{seg.text}</em>
      </strong>
    );
  }
  if (seg.b) return <strong className={strike}>{seg.text}</strong>;
  if (seg.i) return <em className={strike}>{seg.text}</em>;
  if (seg.s) return <s>{seg.text}</s>;
  return seg.text;
}

export default function WidgetInline({ segs = [] }: WidgetInlineProps) {
  return (
    <>
      {segs.map((seg, index) =>
        seg.href ? (
          <a key={index} className="wg-link" href={seg.href} target="_blank" rel="noopener noreferrer" title={seg.href}>
            {run(seg)}
          </a>
        ) : seg.problem ? (
          <span key={index} className="wg-link-broken" title={seg.problem}>
            {run(seg)}
          </span>
        ) : (
          <Fragment key={index}>{run(seg)}</Fragment>
        ),
      )}
    </>
  );
}
