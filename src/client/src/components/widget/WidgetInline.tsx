// Inline text of inline UI: styled runs assembled from ELEMENTS, with
// every run's text inserted as a text node. Nothing here parses HTML, so a
// value like `<img onerror=…>` an avatar interpolates shows as those characters.
//
// A run may be a link (`<link href>` or `[text](https://…)`): its target is an
// absolute http(s) URL the shared library already normalized, it opens in a
// new tab without handing this page to it, and the address is the tooltip —
// the reader sees where it goes before following it.
//
// A run may also be a `<hint>`: a small lightbulb button whose bubble holds the
// hint's own runs. It is a disclosure — `aria-expanded`/`aria-controls`; the
// bubble closes on a second press, on a press anywhere else, and on Escape,
// which it keeps to itself (one Escape closes only the top thing — a dialog
// under it stays open) and which puts the focus back on the button.
import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Seg } from "../../lib/widgetView";
import Icon from "../Icon";

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

function HintRun({ label, segs }: { label: string; segs: Seg[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (wrap.current && event.target instanceof Node && !wrap.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key !== "Escape" || !open || event.nativeEvent.isComposing) return;
    // Stopped here, so no window listener (a dialog this answer sits in) takes the same Escape.
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    button.current?.focus();
  }

  return (
    <span className="wg-hint-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="wg-hint-btn"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="lightbulb" size={14} />
      </button>
      <span id={id} className="wg-hint-pop" role="note" aria-label={label} hidden={!open}>
        <WidgetInline segs={segs} />
      </span>
    </span>
  );
}

export default function WidgetInline({ segs = [] }: WidgetInlineProps) {
  return (
    <>
      {segs.map((seg, index) =>
        seg.hint ? (
          <HintRun key={index} label={seg.hint.label} segs={seg.hint.segs} />
        ) : seg.href ? (
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
