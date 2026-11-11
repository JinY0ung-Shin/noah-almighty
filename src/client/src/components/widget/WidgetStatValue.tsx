// The value of a <stat>. When it appears now (lib/uiEntrance.ts), a value
// that is one number counts up from zero in its own format ("605만원",
// "+12.4%"); any other value rises into place. A value that CHANGES — the
// viewer moved a slider — is simply the new value: the count is dropped.
//
// While it counts, the final text is still in the layout (hidden) and the
// running number is drawn over it, so the card keeps its size and nothing
// beside it moves.
import { useLayoutEffect, useRef, useState } from "react";

import { useAction } from "../../lib/hooks";
import { claimEntrance, countUp, countUpFormat, playSteps, riseSteps, type EntranceRule } from "../../lib/uiEntrance";

export interface WidgetStatValueProps {
  text?: string;
  entrance?: EntranceRule | null;
  /** The value's place in the answer: what "already entered" is remembered by. */
  entranceKey?: string;
}

const NOTHING = () => {};

export default function WidgetStatValue({ text = "", entrance = null, entranceKey = "" }: WidgetStatValueProps) {
  // The number on its way up; null shows the value itself.
  const [counting, setCounting] = useState<string | null>(null);
  const stop = useRef<() => void>(NOTHING);
  const entered = useRef(text);

  // Before paint: the count is never shown over a value that changed.
  useLayoutEffect(() => {
    if (text === entered.current) return;
    entered.current = text;
    stop.current();
    stop.current = NOTHING;
    setCounting(null);
  }, [text]);

  // Runs once, when the element is mounted: it reads what the value was mounted with.
  function begin(node: HTMLElement) {
    const ticket = entrance ? claimEntrance(entrance, entranceKey, true) : null;
    if (ticket) {
      const format = countUpFormat(text);
      stop.current = format ? countUp(node, format, ticket, (shown) => setCounting(shown)) : playSteps(node, riseSteps(node), ticket);
    }
    return {
      destroy() {
        stop.current();
      },
    };
  }

  return (
    <span className="stat-value wg-tabular" ref={useAction(begin, undefined)}>
      {counting !== null ? (
        <span className="wg-count">
          <span className="wg-count-final" aria-hidden="true">
            {text}
          </span>
          <span className="wg-count-now">{counting}</span>
        </span>
      ) : (
        text
      )}
    </span>
  );
}
