// The input components of inline UI — native form elements, each one
// labelled. A control is CONTROLLED by the widget's state: it shows `value`
// and reports a change through its handler; the state change re-renders it.
//
// A native control changes ITSELF before the handler runs, and the handler may
// refuse or alter the change ("at most one", `setN(Math.min(v, 5))`). The
// render that follows then has the same prop value as before and writes
// nothing, so the control would keep showing what was clicked while the state —
// and a <submit> — hold something else. After every change the control is
// therefore put back on the state's value (`settle`). The text field is left
// to the browser between changes (see `syncValue`), so for it this is the only
// thing that puts it back.
import { useEffect, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";

import { MAX_SEND_CHARS, type WidgetOption } from "../../../../shared/widget/index";
import { cx, useAction, useLatest } from "../../lib/hooks";
import type { WidgetCtx } from "../../lib/widgetCtx";
import type { ElVNode } from "../../lib/widgetView";
import Icon from "../Icon";
import WidgetInline from "./WidgetInline";

export interface WidgetControlProps {
  v: ElVNode;
  ctx: WidgetCtx;
}

const BUTTON_CLASS: Record<string, string> = { primary: "btn-primary", secondary: "secondary", ghost: "btn-ghost" };

/**
 * Run `apply` once the handler's state change (if any) has been re-rendered:
 * React renders a change made in an event handler in a microtask it queued when
 * the state was set, which is before this one.
 */
async function settle(apply: () => void): Promise<void> {
  await Promise.resolve();
  apply();
}
// A text field's own "write the state's value" (see syncValue), by node.
const resync = new WeakMap<HTMLInputElement, () => void>();

/**
 * Keep a text/number field showing `value` WITHOUT fighting the person typing:
 * the DOM is written only when it differs, never mid-composition (an IME
 * building a Hangul syllable would lose it), and a focused number field that
 * already MEANS the value keeps its text (`1.` while typing `1.5`).
 */
function syncValue(node: HTMLInputElement, value: unknown) {
  let composing = false;
  let latest = value;
  const write = () => {
    if (composing) return;
    const next = latest === undefined || latest === null ? "" : String(latest);
    if (node.value === next) return;
    if (node.type === "number" && document.activeElement === node && node.value !== "" && next !== "" && Number(node.value) === Number(next)) return;
    node.value = next;
  };
  const start = () => {
    composing = true;
  };
  // The committed text reaches the state through the input event (before or
  // right after this one, by browser); settle once that has been rendered.
  const end = () => {
    composing = false;
    void settle(write);
  };
  node.addEventListener("compositionstart", start);
  node.addEventListener("compositionend", end);
  resync.set(node, write);
  write();
  return {
    update(next: unknown) {
      latest = next;
      write();
    },
    destroy() {
      resync.delete(node);
      node.removeEventListener("compositionstart", start);
      node.removeEventListener("compositionend", end);
    },
  };
}

export default function WidgetControl({ v, ctx }: WidgetControlProps) {
  const p = v.props;
  const id = ctx.domId(v.key);
  const label = typeof p.label === "string" ? p.label : "";
  const options = (Array.isArray(p.options) ? p.options : []) as WidgetOption[];
  const selectedIndex = options.findIndex((opt) => opt.value === p.value);

  // A button does ONE thing: run a handler, send a chat message, or open a link.
  // The library keeps whichever of onClick | send | href is valid; with none
  // (an empty send, a URL that is not http/https) the button is drawn disabled
  // and says why. What a send or a link will do is shown BEFORE it is pressed.
  // An icon before the label: one of the app's own, by a name the library checked against its list.
  const icon = typeof p.icon === "string" ? p.icon : "";
  const buttonClass = `btn btn-sm ${BUTTON_CLASS[typeof p.variant === "string" ? p.variant : "secondary"] ?? "secondary"}${icon ? " wg-has-icon" : ""}`;
  const sendText = typeof p.send === "string" ? p.send.slice(0, MAX_SEND_CHARS) : "";
  // A "/…" message would run as a slash command — those are the viewer's to type.
  const sendRefused = sendText.startsWith("/");
  const sendHint = sendRefused ? "슬래시(/)로 시작하는 메시지는 답변 안의 버튼으로 보낼 수 없습니다." : `보낼 메시지: ${sendText}`;
  const linkHref = typeof p.href === "string" ? p.href : "";
  const idle = v.tag === "button" && !sendText && !linkHref && typeof p.onClick !== "function";
  // Said again whenever the view's context is rebuilt (the avatar starts or
  // stops answering): a report made while the answer was still arriving went nowhere.
  useEffect(() => {
    if (sendRefused) ctx.report('<button send>: a message starting with "/" is not sent from a widget (slash commands are typed by the user)');
  }, [sendRefused, ctx]);

  // What the state says NOW, for the moment after a handler ran (a handler sees the render it was made in).
  const now = useLatest({ p, selectedIndex });
  // One hook per component: the text field is the only element that takes it.
  const field = useAction(syncValue, p.value);

  function onText(event: ChangeEvent<HTMLInputElement>): void {
    const node = event.currentTarget;
    const write = resync.get(node);
    if (p.type !== "number") {
      ctx.fire(p.onChange, [node.value]);
    } else if (node.value === "") {
      ctx.fire(p.onChange, [""]);
    } else {
      const n = Number(node.value);
      // A half-typed number ("-", "1e") is not reported: there is no value yet.
      if (!Number.isFinite(n)) return;
      ctx.fire(p.onChange, [n]);
    }
    if (write) void settle(write);
  }

  function onRange(event: ChangeEvent<HTMLInputElement>): void {
    const node = event.currentTarget;
    const n = Number(node.value);
    if (!Number.isFinite(n)) return;
    ctx.fire(p.onChange, [n]);
    void settle(() => {
      const value = now.current.p.value;
      const next = String(typeof value === "number" ? value : 0);
      if (node.value !== next) node.value = next;
    });
  }

  function onCheck(event: ChangeEvent<HTMLInputElement>): void {
    const node = event.currentTarget;
    ctx.fire(p.onChange, [node.checked]);
    void settle(() => {
      node.checked = now.current.p.checked === true;
    });
  }

  function onSelect(event: ChangeEvent<HTMLSelectElement>): void {
    const node = event.currentTarget;
    const opt = options[Number(node.value)];
    if (opt) ctx.fire(p.onChange, [opt.value]);
    void settle(() => {
      const index = now.current.selectedIndex;
      const next = index < 0 ? "" : String(index);
      if (node.value !== next) node.value = next;
    });
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step || options.length === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    ctx.fire(p.onChange, [options[next].value]);
    const strip = event.currentTarget.parentElement;
    queueMicrotask(() => (strip?.children[next] as HTMLElement | undefined)?.focus());
  }

  const face: ReactNode = (
    <>
      {icon ? <Icon name={icon} size={14} /> : null}
      {v.segs.length ? <WidgetInline segs={v.segs} /> : label}
    </>
  );
  const caption: ReactNode = v.segs.length ? <WidgetInline segs={v.segs} /> : label;

  if (v.tag === "button" && linkHref && p.disabled !== true) {
    return (
      <a data-wg-key={id} className={`${buttonClass} wg-button-link`} href={linkHref} target="_blank" rel="noopener noreferrer" title={linkHref}>
        {face}
      </a>
    );
  }
  if (v.tag === "button" && sendText) {
    return (
      <>
        <button
          data-wg-key={id}
          type="button"
          className={`${buttonClass} wg-button-send`}
          disabled={p.disabled === true || ctx.locked || sendRefused}
          title={sendHint}
          aria-describedby={`${id}-send ${ctx.statusId}`}
          onClick={() => {
            if (!sendRefused) ctx.send(sendText);
          }}
        >
          {face}
        </button>
        {/* The same sentence for a screen reader: what pressing the button will say. */}
        <span id={`${id}-send`} className="sr-only">
          {sendHint}
        </span>
      </>
    );
  }
  if (v.tag === "button") {
    return (
      <button
        data-wg-key={id}
        type="button"
        className={buttonClass}
        disabled={p.disabled === true || idle || Boolean(linkHref)}
        title={idle ? `이 버튼은 동작하지 않습니다${v.flawed ? ` (${v.flawed})` : ""}` : undefined}
        onClick={() => ctx.fire(p.onClick, [])}
      >
        {face}
      </button>
    );
  }
  if (v.tag === "checkbox") {
    return (
      <label className="wg-check" data-wg-key={id}>
        <input type="checkbox" checked={p.checked === true} disabled={p.disabled === true} onChange={onCheck} />
        <span>{caption}</span>
      </label>
    );
  }
  if (v.tag === "switch") {
    return (
      <div className="wg-switch" data-wg-key={id}>
        <button
          className={cx("toggle", p.checked === true && "on")}
          type="button"
          role="switch"
          aria-checked={p.checked === true ? "true" : "false"}
          aria-labelledby={`${id}-label`}
          disabled={p.disabled === true}
          onClick={() => ctx.fire(p.onChange, [p.checked !== true])}
        >
          <span className="knob"></span>
        </button>
        <span id={`${id}-label`}>{caption}</span>
      </div>
    );
  }
  if (v.tag === "slider") {
    return (
      <div className="wg-field" data-wg-key={id}>
        <span id={`${id}-label`} className="wg-label">
          {label}
        </span>
        <div className="canvas-slider">
          <input
            type="range"
            min={typeof p.min === "number" ? p.min : 0}
            max={typeof p.max === "number" ? p.max : 100}
            step={typeof p.step === "number" ? p.step : 1}
            value={typeof p.value === "number" ? p.value : 0}
            aria-labelledby={`${id}-label`}
            onChange={onRange}
          />
          {p.showValue !== false ? (
            <span className="canvas-slider-val">
              {typeof p.value === "number" ? p.value : ""}
              {typeof p.suffix === "string" ? p.suffix : ""}
            </span>
          ) : null}
        </div>
      </div>
    );
  }
  if (v.tag === "select") {
    return (
      <label className="field wg-field" data-wg-key={id}>
        <span>{label}</span>
        <select value={selectedIndex < 0 ? "" : String(selectedIndex)} onChange={onSelect}>
          <option value="" disabled>
            {typeof p.placeholder === "string" ? p.placeholder : "선택하세요"}
          </option>
          {options.map((opt, i) => (
            <option key={i} value={String(i)}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (v.tag === "input") {
    // No `value` here: the field is the browser's between changes, and `syncValue` writes the state's value into it.
    return (
      <label className="field wg-field" data-wg-key={id}>
        <span>{label}</span>
        <input
          type={p.type === "number" ? "number" : "text"}
          placeholder={typeof p.placeholder === "string" ? p.placeholder : ""}
          min={typeof p.min === "number" ? p.min : undefined}
          max={typeof p.max === "number" ? p.max : undefined}
          step={typeof p.step === "number" ? p.step : undefined}
          maxLength={typeof p.maxLength === "number" ? p.maxLength : 500}
          autoComplete="off"
          ref={field}
          onChange={onText}
        />
      </label>
    );
  }
  if (v.tag === "segmented-control") {
    return (
      <div className="wg-field" data-wg-key={id}>
        <span id={`${id}-label`} className="wg-label">
          {label}
        </span>
        <div className="seg-control wg-seg" role="radiogroup" aria-labelledby={`${id}-label`}>
          {options.map((opt, i) => (
            <button
              key={i}
              type="button"
              className={cx("seg-btn", i === selectedIndex && "active")}
              role="radio"
              aria-checked={i === selectedIndex ? "true" : "false"}
              onClick={() => ctx.fire(p.onChange, [opt.value])}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (v.tag === "tabs") {
    return (
      <div className="wg-tabs" data-wg-key={id} role="tablist" aria-label={label}>
        {options.map((opt, i) => (
          <button
            key={i}
            type="button"
            className={cx("wg-tab", i === selectedIndex && "active")}
            role="tab"
            aria-selected={i === selectedIndex ? "true" : "false"}
            tabIndex={i === selectedIndex || (selectedIndex < 0 && i === 0) ? 0 : -1}
            onClick={() => ctx.fire(p.onChange, [opt.value])}
            onKeyDown={(event) => onTabKey(event, i)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }
  return null;
}
