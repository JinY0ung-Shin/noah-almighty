<script lang="ts" context="module">
  let nextViewId = 0;
</script>

<script lang="ts">
  // One drawn copy of a canvas widget. The STATE is not here: the tab that owns
  // the artifact (CanvasTab) holds `values` and hands the same ones to its panel
  // and fullscreen copies, so both show one widget and a hidden tab keeps it.
  //
  // Every change of `values` builds a new root environment and evaluates the
  // whole document again into plain nodes (lib/widgetView.ts) — nothing the
  // avatar wrote runs as code here (the shared interpreter walks an AST; no
  // eval, no Function), and nothing it wrote is parsed as HTML.
  import {
    createRootEnv,
    createRuntime,
    invokeHandler,
    normalizeSubmitValues,
    type WidgetDoc,
    type WidgetHost,
  } from "../../../../shared/widget/index";
  import type { WidgetCtx } from "../../lib/widgetCtx";
  import { buildWidgetView, type VNode } from "../../lib/widgetView";
  import WidgetNode from "./WidgetNode.svelte";

  export let doc: WidgetDoc;
  /** Current state values; a NEW object on every change. */
  export let values: Record<string, unknown>;
  /** State access for setters (latest value, store) and `copy`. */
  export let host: WidgetHost;
  /** A submit cannot go out right now. */
  export let locked = false;
  /** Why not (shown as the status line, and announced). */
  export let lockedReason = "";
  export let dark = false;
  /** Called with the normalized values of a pressed `<submit>`. */
  export let onSubmit: (values: Record<string, unknown>) => void = () => {};

  const viewId = `wg${++nextViewId}`;
  const statusId = `${viewId}-status`;
  const rt = createRuntime();

  let view: VNode[] = [];
  // A render must not start INSIDE a handler: evaluating refills the runtime's
  // budgets and puts it back in the "render" phase, where setters do nothing —
  // the handler's remaining setter calls would be dropped. Svelte normally
  // batches the state change to a microtask, but a synchronous flush would land
  // here mid-handler, so the rebuild is held until the handler returns.
  let firing = false;
  let heldBack = false;
  $: rebuild(doc, values);
  function rebuild(nextDoc: WidgetDoc, nextValues: Record<string, unknown>): void {
    if (firing) {
      heldBack = true;
      return;
    }
    view = buildWidgetView(nextDoc, createRootEnv(nextDoc, nextValues, rt, host), rt);
  }

  let notice = "";
  // A new version of the widget starts with a clean status line.
  $: clearNotice(doc);
  function clearNotice(_doc: WidgetDoc): void {
    notice = "";
  }

  function fire(handler: unknown, args: unknown[]): void {
    firing = true;
    let ok = false;
    try {
      ok = invokeHandler(rt, handler, args).ok;
    } finally {
      firing = false;
    }
    if (heldBack) {
      heldBack = false;
      rebuild(doc, values);
    }
    notice = ok ? "" : "동작을 실행하지 못했습니다.";
  }

  function submit(raw: unknown): void {
    if (locked) return;
    const normalized = normalizeSubmitValues(raw);
    if (!normalized.ok) {
      notice = "보낼 값이 너무 많거나 길어서 보내지 못했습니다.";
      return;
    }
    // `values` that evaluated to nothing ({} is what a null one becomes): an
    // empty answer must not reach the avatar as if the person had sent one.
    if (Object.keys(normalized.values).length === 0) {
      notice = "보낼 값이 없어 보내지 않았습니다.";
      return;
    }
    notice = "";
    onSubmit(normalized.values);
  }

  function domId(key: string): string {
    return `${viewId}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  let ctx: WidgetCtx;
  $: ctx = { fire, submit, locked, statusId, dark, domId };
  $: status = notice || (locked ? lockedReason : "");
</script>

<div class="wg-root">
  {#each view as v (v.key)}<WidgetNode {v} {ctx} />{/each}
  <div id={statusId} class="canvas-edit-status wg-status" class:dirty={Boolean(status)} role="status" aria-live="polite">{status}</div>
</div>
