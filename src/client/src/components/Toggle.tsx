import { useState } from "react";
import { usePropState } from "../lib/hooks";

export interface ToggleProps {
  on?: boolean;
  label?: string;
  onChange?: (next: boolean) => Promise<void> | void;
  /** Locked by a PRECONDITION (not by an in-flight save) — `title` should say which. */
  disabled?: boolean;
  /** Hover/AT explanation; defaults to `label` so the plain switch is unchanged. */
  title?: string;
}

// Accessible switch. `onChange` runs before the visual flip so a failed save
// (which should re-throw) doesn't render as "on".
export default function Toggle({ on: onProp = false, label = "사용", onChange = () => {}, disabled = false, title = "" }: ToggleProps) {
  const [on, setOn] = usePropState(onProp);
  const [busy, setBusy] = useState(false);

  async function handle() {
    if (busy || disabled) return;
    const next = !on;
    setBusy(true);
    try {
      await onChange(next);
      setOn(next);
    } catch {
      /* caller already surfaced the error; keep the previous visual state */
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`toggle ${on ? "on" : ""}`}
      type="button"
      role="switch"
      aria-checked={on ? "true" : "false"}
      aria-busy={busy ? "true" : "false"}
      aria-label={label}
      title={title || label}
      disabled={busy || disabled}
      onClick={(event) => {
        event.stopPropagation();
        void handle();
      }}
    >
      <span className="knob"></span>
    </button>
  );
}
