<script lang="ts">
  // The input components of inline UI — native form elements, each one
  // labelled. A control is CONTROLLED by the widget's state: it shows `value`
  // and reports a change through its handler; the state change re-renders it.
  //
  // A native control changes ITSELF before the handler runs, and the handler may
  // refuse or alter the change ("at most one", `setN(Math.min(v, 5))`). Svelte
  // then sees the same prop value as before and writes nothing, so the control
  // would keep showing what was clicked while the state — and a <submit> — hold
  // something else. After every change the control is therefore put back on the
  // state's value (`settle`).
  import { tick } from "svelte";
  import { MAX_SEND_CHARS, type WidgetOption } from "../../../../shared/widget/index";
  import type { ElVNode } from "../../lib/widgetView";
  import type { WidgetCtx } from "../../lib/widgetCtx";
  import Icon from "../Icon.svelte";
  import WidgetInline from "./WidgetInline.svelte";

  export let v: ElVNode;
  export let ctx: WidgetCtx;

  $: p = v.props;
  $: id = ctx.domId(v.key);
  $: label = typeof p.label === "string" ? p.label : "";
  $: options = (Array.isArray(p.options) ? p.options : []) as WidgetOption[];
  $: selectedIndex = options.findIndex((opt) => opt.value === p.value);

  // A button does ONE thing: run a handler, send a chat message, or open a link.
  // The library keeps whichever of onClick | send | href is valid; with none
  // (an empty send, a URL that is not http/https) the button is drawn disabled
  // and says why. What a send or a link will do is shown BEFORE it is pressed.
  // An icon before the label: one of the app's own, by a name the library checked against its list.
  $: icon = typeof p.icon === "string" ? p.icon : "";
  $: buttonClass = `btn btn-sm ${BUTTON_CLASS[typeof p.variant === "string" ? p.variant : "secondary"] ?? "secondary"}${icon ? " wg-has-icon" : ""}`;
  $: sendText = typeof p.send === "string" ? p.send.slice(0, MAX_SEND_CHARS) : "";
  // A "/…" message would run as a slash command — those are the viewer's to type.
  $: sendRefused = sendText.startsWith("/");
  $: sendHint = sendRefused ? "슬래시(/)로 시작하는 메시지는 답변 안의 버튼으로 보낼 수 없습니다." : `보낼 메시지: ${sendText}`;
  $: linkHref = typeof p.href === "string" ? p.href : "";
  $: idle = v.tag === "button" && !sendText && !linkHref && typeof p.onClick !== "function";
  $: if (sendRefused) ctx.report('<button send>: a message starting with "/" is not sent from a widget (slash commands are typed by the user)');

  const BUTTON_CLASS: Record<string, string> = { primary: "btn-primary", secondary: "secondary", ghost: "btn-ghost" };

  /** Run `apply` once the handler's state change (if any) has been re-rendered. */
  async function settle(apply: () => void): Promise<void> {
    await tick();
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

  function onText(event: Event): void {
    const node = event.currentTarget as HTMLInputElement;
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

  function onRange(event: Event): void {
    const node = event.currentTarget as HTMLInputElement;
    const n = Number(node.value);
    if (!Number.isFinite(n)) return;
    ctx.fire(p.onChange, [n]);
    void settle(() => {
      const next = String(typeof p.value === "number" ? p.value : 0);
      if (node.value !== next) node.value = next;
    });
  }

  function onCheck(event: Event): void {
    const node = event.currentTarget as HTMLInputElement;
    ctx.fire(p.onChange, [node.checked]);
    void settle(() => {
      node.checked = p.checked === true;
    });
  }

  function onSelect(event: Event): void {
    const node = event.currentTarget as HTMLSelectElement;
    const opt = options[Number(node.value)];
    if (opt) ctx.fire(p.onChange, [opt.value]);
    void settle(() => {
      const next = selectedIndex < 0 ? "" : String(selectedIndex);
      if (node.value !== next) node.value = next;
    });
  }

  function onTabKey(event: KeyboardEvent, index: number): void {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step || options.length === 0) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    ctx.fire(p.onChange, [options[next].value]);
    const strip = (event.currentTarget as HTMLElement).parentElement;
    queueMicrotask(() => (strip?.children[next] as HTMLElement | undefined)?.focus());
  }
</script>

{#if v.tag === "button" && linkHref && p.disabled !== true}
  <a data-wg-key={id} class={`${buttonClass} wg-button-link`} href={linkHref} target="_blank" rel="noopener noreferrer" title={linkHref}
    >{#if icon}<Icon name={icon} size={14} />{/if}{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{label}{/if}</a>
{:else if v.tag === "button" && sendText}
  <button
    data-wg-key={id}
    type="button"
    class={`${buttonClass} wg-button-send`}
    disabled={p.disabled === true || ctx.locked || sendRefused}
    title={sendHint}
    aria-describedby={`${id}-send ${ctx.statusId}`}
    on:click={() => {
      if (!sendRefused) ctx.send(sendText);
    }}
  >{#if icon}<Icon name={icon} size={14} />{/if}{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{label}{/if}</button>
  <!-- The same sentence for a screen reader: what pressing the button will say. -->
  <span id={`${id}-send`} class="sr-only">{sendHint}</span>
{:else if v.tag === "button"}
  <button
    data-wg-key={id}
    type="button"
    class={buttonClass}
    disabled={p.disabled === true || idle || Boolean(linkHref)}
    title={idle ? `이 버튼은 동작하지 않습니다${v.flawed ? ` (${v.flawed})` : ""}` : undefined}
    on:click={() => ctx.fire(p.onClick, [])}
  >{#if icon}<Icon name={icon} size={14} />{/if}{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{label}{/if}</button>
{:else if v.tag === "checkbox"}
  <label class="wg-check" data-wg-key={id}>
    <input
      type="checkbox"
      checked={p.checked === true}
      disabled={p.disabled === true}
      on:change={onCheck}
    />
    <span>{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{label}{/if}</span>
  </label>
{:else if v.tag === "switch"}
  <div class="wg-switch" data-wg-key={id}>
    <button
      class="toggle"
      class:on={p.checked === true}
      type="button"
      role="switch"
      aria-checked={p.checked === true ? "true" : "false"}
      aria-labelledby={`${id}-label`}
      disabled={p.disabled === true}
      on:click={() => ctx.fire(p.onChange, [p.checked !== true])}
    >
      <span class="knob"></span>
    </button>
    <span id={`${id}-label`}>{#if v.segs.length}<WidgetInline segs={v.segs} />{:else}{label}{/if}</span>
  </div>
{:else if v.tag === "slider"}
  <div class="wg-field" data-wg-key={id}>
    <span id={`${id}-label`} class="wg-label">{label}</span>
    <div class="canvas-slider">
      <input
        type="range"
        min={typeof p.min === "number" ? p.min : 0}
        max={typeof p.max === "number" ? p.max : 100}
        step={typeof p.step === "number" ? p.step : 1}
        value={typeof p.value === "number" ? p.value : 0}
        aria-labelledby={`${id}-label`}
        on:input={onRange}
      />
      {#if p.showValue !== false}
        <span class="canvas-slider-val">{typeof p.value === "number" ? p.value : ""}{typeof p.suffix === "string" ? p.suffix : ""}</span>
      {/if}
    </div>
  </div>
{:else if v.tag === "select"}
  <label class="field wg-field" data-wg-key={id}>
    <span>{label}</span>
    <select value={selectedIndex < 0 ? "" : String(selectedIndex)} on:change={onSelect}>
      <option value="" disabled>{typeof p.placeholder === "string" ? p.placeholder : "선택하세요"}</option>
      {#each options as opt, i}
        <option value={String(i)}>{opt.label}</option>
      {/each}
    </select>
  </label>
{:else if v.tag === "input"}
  <label class="field wg-field" data-wg-key={id}>
    <span>{label}</span>
    <input
      type={p.type === "number" ? "number" : "text"}
      placeholder={typeof p.placeholder === "string" ? p.placeholder : ""}
      min={typeof p.min === "number" ? p.min : undefined}
      max={typeof p.max === "number" ? p.max : undefined}
      step={typeof p.step === "number" ? p.step : undefined}
      maxlength={typeof p.maxLength === "number" ? p.maxLength : 500}
      autocomplete="off"
      use:syncValue={p.value}
      on:input={onText}
    />
  </label>
{:else if v.tag === "segmented-control"}
  <div class="wg-field" data-wg-key={id}>
    <span id={`${id}-label`} class="wg-label">{label}</span>
    <div class="seg-control wg-seg" role="radiogroup" aria-labelledby={`${id}-label`}>
      {#each options as opt, i}
        <button
          type="button"
          class="seg-btn"
          class:active={i === selectedIndex}
          role="radio"
          aria-checked={i === selectedIndex ? "true" : "false"}
          on:click={() => ctx.fire(p.onChange, [opt.value])}
        >{opt.label}</button>
      {/each}
    </div>
  </div>
{:else if v.tag === "tabs"}
  <div class="wg-tabs" data-wg-key={id} role="tablist" aria-label={label}>
    {#each options as opt, i}
      <button
        type="button"
        class="wg-tab"
        class:active={i === selectedIndex}
        role="tab"
        aria-selected={i === selectedIndex ? "true" : "false"}
        tabindex={i === selectedIndex || (selectedIndex < 0 && i === 0) ? 0 : -1}
        on:click={() => ctx.fire(p.onChange, [opt.value])}
        on:keydown={(event) => onTabKey(event, i)}
      >{opt.label}</button>
    {/each}
  </div>
{/if}
