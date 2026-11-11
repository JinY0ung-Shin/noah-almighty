<script lang="ts" context="module">
  let nextViewId = 0;
</script>

<script lang="ts">
  // An assistant answer that holds INLINE UI: the avatar wrote component tags
  // and `{@state}` / `{#each}` / `{#if}` directives straight into its answer
  // text, between the Markdown. This draws the whole answer — the Markdown runs
  // through the chat's own renderer, the UI blocks as real controls, the cards
  // (files, images) at their anchors — while the text is still arriving and
  // after it is stored.
  //
  // Nothing the avatar wrote runs as code: the shared interpreter walks an AST
  // (no eval, no Function), what an expression produces is inserted as text,
  // and what a control will DO is a declared prop (`send`, `href`, `<submit>`).
  // The state lives here, per answer: in memory while the answer streams (there
  // is no message id yet), in this browser's localStorage once it is stored.
  //
  // Loaded lazily by ChatView, on the first answer `containsInlineUi` says yes
  // to: an ordinary answer never pays for the parser or the components.
  import { onDestroy, onMount, tick as nextTick, type Snippet } from "svelte";

  import {
    createRootEnv,
    createRuntime,
    dataSize,
    invokeHandler,
    normalizeSubmitValues,
    parseAnswer,
    restoreState,
    widgetProblems,
    type AnswerDoc,
    type WidgetHost,
  } from "../../../../shared/widget/index";
  import { answerPieces, type AnswerPiece } from "../../lib/answerLayout";
  import { queueInlineUiReport } from "../../lib/canvasReport";
  import { continuesEntranceText, enterChildren, noteEntranceText, openEntranceScope, type EntranceRule } from "../../lib/uiEntrance";
  import { sendWidgetMessage } from "../../lib/chat";
  import { copyText, markdownBlocks } from "../../lib/dom";
  import { diagramProblems } from "../../lib/mermaidBlock";
  import { notify, readState } from "../../lib/state";
  import { createStreamMarkdown, type StreamBlock, type StreamMarkdown } from "../../lib/streamMarkdown";
  import { theme } from "../../lib/theme";
  import type { ChatPane, MessageAttachment } from "../../lib/types";
  import type { WidgetCtx } from "../../lib/widgetCtx";
  import {
    clearLiveWidgetState,
    createWidgetStateSaver,
    loadWidgetState,
    peekLiveWidgetState,
    removeWidgetState,
    setLiveWidgetState,
    sweepLegacyWidgetState,
    takeLiveWidgetState,
    type WidgetStateRecord,
    type WidgetStateRef,
  } from "../../lib/widgetState";
  import { buildAnswerItems, collectWidgetProblems, createAnswerViewCache, type AnswerItem, type VNode } from "../../lib/widgetView";
  import WidgetNode from "./WidgetNode.svelte";

  export let pane: ChatPane;
  /** The answer text shown so far (all of it once the answer is stored and revealed). */
  export let text = "";
  /** The attachments shown so far, and the full list the cards compare against. */
  export let atts: MessageAttachment[] | undefined = undefined;
  export let source: MessageAttachment[] | undefined = undefined;
  /** The text is still growing (the live bubble, or a stored answer whose end is draining in). */
  export let streaming = false;
  /** The stored message this answer is; null for the live bubble. */
  export let messageId: string | null = null;
  /** This is the conversation's latest answer: what it cannot draw is worth telling the avatar. */
  export let latest = false;
  /** Draw the stream caret at the end of the text. */
  export let caret = false;
  /** ChatView's card renderer: `(pane, attachments, source)`. */
  export let cards: Snippet<[ChatPane, MessageAttachment[], MessageAttachment[] | undefined]> | undefined = undefined;
  /**
   * A PREVIEW outside a conversation (the 인라인 UI gallery): what a control
   * would send to the avatar is handed here instead of to the chat, and nothing
   * is kept in this browser or reported. null in a chat.
   */
  export let outbox: ((message: string) => void) | null = null;

  const viewId = `ui${++nextViewId}`;
  // Fixed for the instance's life, like the pane it was mounted for.
  const preview = outbox !== null;
  const statusId = `${viewId}-status`;
  const rt = createRuntime();
  const cache = createAnswerViewCache();
  // Captured at mount: by the time a pending save is flushed the pane may show another conversation.
  const conversationId = pane.conversationId || null;
  const paneId = pane.id;

  /* ---------- state ---------- */

  // `stored` is what the VIEWER changed, each value with the declaration it was
  // set under; `values` is what the document evaluates with (initializers, then
  // the stored values whose declaration is unchanged).
  let stored: WidgetStateRecord = {};
  let values: Record<string, unknown> = {};
  let statesSig: string | null = null;
  // Bumped by a setter: the one reactive dependency a state change needs.
  let tick = 0;

  const saver = createWidgetStateSaver(dataSize);
  function ref(): WidgetStateRef {
    return { userId: readState().user?.id, conversationId, messageId };
  }
  function storable(): WidgetStateRecord {
    const out: WidgetStateRecord = {};
    for (const st of doc?.states ?? []) {
      const entry = Object.prototype.hasOwnProperty.call(stored, st.name) ? stored[st.name] : undefined;
      if (entry && entry.sig === st.sig) out[st.name] = entry;
    }
    return out;
  }
  // The run this live bubble belongs to (null for a stored message): what the handover entry is bound to.
  const runId = messageId ? null : pane.liveRunId || null;
  // The control that has the focus, by its key in the view — handed over with the state.
  let focusedKey: string | null = null;

  function persist(): void {
    if (preview) return;
    if (messageId) saver.schedule(ref(), storable());
    else setLiveWidgetState(paneId, { conversationId, runId, text: parsedText ?? text, record: stored, focus: focusedKey });
  }

  // Taken over from the live bubble: stored under the message once the document is parsed.
  let adopted = false;
  let refocus: string | null = null;
  if (preview) {
    // A preview starts from its initializers every time it is opened.
  } else if (messageId) {
    // What this browser kept for the answer — or, right after its turn ended,
    // what the viewer changed while it was still streaming (only the answer
    // that continues the live text may take that over).
    const kept = loadWidgetState(ref());
    const live = kept ? null : takeLiveWidgetState(paneId, conversationId, text);
    stored = kept ?? live?.record ?? {};
    adopted = Boolean(live) && Object.keys(stored).length > 0;
    refocus = live?.focus ?? null;
  } else {
    // A live answer: it continues from its own run's entry (the chat view was
    // left and reopened mid-stream); whatever another run left is not its state.
    const mine = peekLiveWidgetState(paneId, conversationId, runId);
    if (mine) {
      stored = mine.record;
      refocus = mine.focus ?? null;
    } else clearLiveWidgetState(paneId);
  }

  // Entrances (lib/uiEntrance.ts) are counted per pane: the live bubble and the
  // stored message it becomes are two instances of ONE answer, and a thing
  // moves in the first of them only. Previews share one scope: there everything
  // enters every time (the rule below), so there is nothing to count.
  const entranceScope = preview ? "preview" : `pane:${paneId}`;
  if (!preview && !messageId) openEntranceScope(entranceScope, runId);
  // The stored message of the answer that was just written here: its turn can
  // end before the last of it was drawn (a chart), and that still enters.
  const fresh = !preview && Boolean(messageId) && continuesEntranceText(entranceScope, text);
  // This instance has shown the answer WHILE it was written (the live bubble, a
  // stored message whose end drained in). Kept once true: a chart is drawn a
  // moment after its tag arrived (Vega loads lazily), and by then the last of
  // the text may be in — the chart still appeared now.
  let written = streaming;
  // The viewer changed something here: what appears from now on (the tab they
  // just picked) appears because of them, not because a page loaded.
  let interacted = false;

  // A stopped or failed turn's bubble is mounted under a client-made id and
  // adopts the server's when it arrives: what was stored moves with it.
  let storedUnder = messageId;
  $: rekey(messageId);
  function rekey(id: string | null): void {
    if (!id || !storedUnder || id === storedUnder) return;
    saver.cancel();
    removeWidgetState({ userId: readState().user?.id, conversationId, messageId: storedUnder });
    storedUnder = id;
    if (doc) saver.schedule(ref(), storable());
  }

  const host: WidgetHost = {
    get: (name) => values[name],
    set: (name, value) => {
      const decl = doc?.states.find((st) => st.name === name);
      if (!decl) return;
      values = { ...values, [name]: value };
      stored = { ...stored, [name]: { sig: decl.sig, value } };
      persist();
      interacted = true;
      tick += 1;
    },
    copy: (copied) => {
      void copyText(copied);
      notify("클립보드에 복사했습니다.", "info");
    },
  };

  /* ---------- parse + evaluate ---------- */

  let doc: AnswerDoc | null = null;
  let parsedText: string | null = null;
  let parsedStreaming = false;
  let pieces: AnswerPiece[] = [];
  // Whether anything in the answer goes to the avatar (a <submit>, a send button).
  let sends = false;
  // A render must not start INSIDE a handler: evaluating puts the runtime back
  // in its "render" phase, where setters do nothing — the handler's remaining
  // setter calls would be dropped. Held until the handler returns.
  let firing = false;
  let heldBack = false;

  $: update(text, streaming, atts, tick);

  function update(nextText: string, nextStreaming: boolean, nextAtts: MessageAttachment[] | undefined, _tick: number): void {
    if (firing) {
      heldBack = true;
      return;
    }
    if (!doc || nextText !== parsedText || nextStreaming !== parsedStreaming) {
      doc = parseAnswer(nextText, { streaming: nextStreaming });
      parsedText = nextText;
      parsedStreaming = nextStreaming;
      // A NEW values object only when the declarations changed: the blocks
      // already evaluated stay valid (and are not drawn again) otherwise.
      const sig = doc.states.map((st) => st.sig).join("\u0001");
      if (sig !== statesSig) {
        statesSig = sig;
        values = { ...restoreState(doc, stored).values };
      }
      if (adopted && !nextStreaming) {
        adopted = false;
        persist();
      }
      // The handover entry names the text it belongs to: keep it the live answer's latest.
      if (!messageId && Object.keys(stored).length > 0) persist();
      if (!messageId && !preview) noteEntranceText(entranceScope, nextText);
    }
    const items: AnswerItem[] = doc.failed
      ? [{ kind: "md", key: "/0", s: 0, e: nextText.length, text: nextText }]
      : buildAnswerItems(doc, createRootEnv(doc, values, rt, host), rt, values, cache, { conversationId, svgNs: viewId });
    pieces = answerPieces(items, nextText.length, nextAtts, nextStreaming ? doc.pending : null);
    const drawn: VNode[] = [];
    for (const item of items) if (item.kind === "ui") for (const node of item.nodes) drawn.push(node);
    sends = hasSender(drawn);
    forgetRenderers(pieces);
    // Read from the arguments: on the update where `streaming` turns false the
    // answer is finished NOW (a mirror set by a later reactive statement still said otherwise).
    streamingNow = nextStreaming;
    if (nextStreaming) written = true;
    if (!nextStreaming) reportProblems([...staticProblems(doc), ...collectWidgetProblems(doc, drawn), ...knownDiagramIssues()]);
    if (refocus) void restoreFocus();
  }

  function hasSender(nodes: VNode[]): boolean {
    return nodes.some((node) => node.k === "el" && (node.tag === "submit" || (node.tag === "button" && typeof node.props.send === "string") || hasSender(node.children)));
  }

  /* ---------- the answer's Markdown ---------- */

  // One block renderer per Markdown run (lib/streamMarkdown.ts): a block that
  // can no longer change is parsed once and keeps its DOM while the text grows.
  const renderers = new Map<string, StreamMarkdown>();
  function blocks(key: string, source: string, heal: boolean): StreamBlock[] {
    let renderer = renderers.get(key);
    if (!renderer) {
      renderer = createStreamMarkdown();
      renderers.set(key, renderer);
    }
    return renderer.render(source, { heal });
  }
  function forgetRenderers(current: AnswerPiece[]): void {
    if (renderers.size <= current.length) return;
    const live = new Set(current.map((piece) => piece.key));
    for (const key of renderers.keys()) if (!live.has(key)) renderers.delete(key);
  }

  /* ---------- telling the avatar what did not draw ---------- */

  let alive = true;
  // A plain variable, set by `update` where it changes — never by a reactive
  // statement that could run AFTER the update that reads it.
  let streamingNow = streaming;
  // Becoming the latest answer later (the one after it was removed) is a reason to report, too.
  let wasLatest = latest;
  $: noteLatest(latest);
  function noteLatest(isLatest: boolean): void {
    const became = isLatest && !wasLatest;
    wasLatest = isLatest;
    if (became && doc && !streamingNow) reportProblems([...staticProblems(doc), ...knownDiagramIssues()]);
  }

  // The static check walks the whole document: once per finished text.
  let checkedText: string | null = null;
  let checked: string[] = [];
  function staticProblems(target: AnswerDoc): string[] {
    if (target.src === checkedText) return checked;
    checkedText = target.src;
    try {
      checked = target.failed ? [] : widgetProblems(target);
    } catch {
      checked = [];
    }
    return checked;
  }

  // A ```mermaid block in one of the answer's Markdown runs that could not be
  // drawn (lib/mermaidBlock.ts). It can fail while the end of the answer is still
  // draining in, when nothing is reported yet — so it is kept and goes out with
  // the answer's own problems. They belong to the text they were found in and
  // to what it grows into (a closed fence does not change), never to another text.
  let diagramIssues: string[] = [];
  let diagramIssuesText = "";
  function continuesDiagramText(): boolean {
    return (parsedText ?? "").startsWith(diagramIssuesText);
  }
  function onDiagramProblem(problem: string): void {
    if (!continuesDiagramText()) diagramIssues = [];
    diagramIssuesText = parsedText ?? "";
    if (!diagramIssues.includes(problem)) diagramIssues.push(problem);
    reportProblems([problem]);
  }
  function knownDiagramIssues(): string[] {
    return continuesDiagramText() ? diagramIssues : [];
  }

  function reportProblems(errors: string[]): void {
    if (!errors.length || !messageId || !latest || streamingNow) return;
    const content = parsedText ?? "";
    queueInlineUiReport({
      conversationId,
      messageId,
      content,
      errors,
      stillCurrent: () => alive && latest && !streamingNow && parsedText === content,
    });
  }

  /* ---------- focus across the remount at turn end ---------- */

  // The live bubble and the stored message are two instances: a field the
  // viewer was typing in is removed with the first. Its key is remembered
  // (every control's root carries `data-wg-key="<view>-<key>"`), and the new
  // instance focuses the same control — only when nothing else took the focus
  // meanwhile.
  const CONTROL = "input, select, textarea, button, a";
  function keyOf(target: EventTarget | null): string | null {
    const root = target instanceof Element ? target.closest(`[data-wg-key^="${viewId}-"]`) : null;
    return root ? (root.getAttribute("data-wg-key") ?? "").slice(viewId.length + 1) : null;
  }
  function onFocusIn(event: FocusEvent): void {
    const key = keyOf(event.target);
    if (key === focusedKey) return;
    focusedKey = key;
    if (!messageId && key) persist();
  }
  function onFocusOut(event: FocusEvent): void {
    // Focus moved somewhere else on purpose (not: the node was removed).
    if (!event.relatedTarget || keyOf(event.target) !== focusedKey) return;
    focusedKey = null;
    if (!messageId) persist();
  }
  async function restoreFocus(): Promise<void> {
    const key = refocus;
    refocus = null;
    await nextTick();
    if (!alive || !key) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const root = document.querySelector<HTMLElement>(`[data-wg-key="${viewId}-${key}"]`);
    if (!root) return;
    // A group (segments, tabs) gets the focus on its picked option.
    const control = root.matches(CONTROL) ? root : (root.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]') ?? root.querySelector<HTMLElement>(CONTROL));
    control?.focus({ preventScroll: true });
  }

  /* ---------- events ---------- */

  let notice = "";

  function fire(handler: unknown, args: unknown[]): void {
    firing = true;
    let failure = "the handler did not run";
    let ok = false;
    try {
      const result = invokeHandler(rt, handler, args);
      ok = result.ok;
      if (!result.ok) failure = result.error;
    } finally {
      firing = false;
    }
    if (heldBack) {
      heldBack = false;
      update(text, streaming, atts, tick);
    }
    notice = ok ? "" : "동작을 실행하지 못했습니다.";
    if (!ok) reportProblems([`an event handler failed: ${failure}`]);
  }

  // Both go out as the viewer's NEXT chat message, so both wait for the avatar's
  // turn to end; the UI's own inputs keep working meanwhile.
  $: locked = pane.streaming;

  function send(message: string): void {
    // Never a slash command: the control is disabled for one, and this is the second lock.
    if (locked || !message.trim() || message.trim().startsWith("/")) return;
    if (outbox) outbox(message);
    else void sendWidgetMessage(paneId, message);
  }

  function submit(raw: unknown, label: string): void {
    if (locked) return;
    const normalized = normalizeSubmitValues(raw);
    if (!normalized.ok) {
      notice = "보낼 값이 너무 많거나 길어서 보내지 못했습니다.";
      return;
    }
    const entries = Object.entries(normalized.values);
    // `values` that evaluated to nothing: an empty answer must not reach the avatar as if one had been sent.
    if (entries.length === 0) {
      notice = "보낼 값이 없어 보내지 않았습니다.";
      return;
    }
    notice = "";
    const lines = entries.map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    const message = `${label.trim() || "보내기"}\n${lines.join("\n")}`;
    if (outbox) outbox(message);
    else void sendWidgetMessage(paneId, message, 10_000);
  }

  function domId(key: string): string {
    return `${viewId}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  let ctx: WidgetCtx;
  let entrance: EntranceRule | null = null;
  $: entrance = preview || interacted ? { scope: entranceScope, always: true } : written || fresh ? { scope: entranceScope, always: false } : null;
  $: ctx = {
    fire,
    submit,
    send,
    report: (problem: string) => reportProblems([problem]),
    locked,
    statusId,
    dark: $theme === "dark",
    entrance,
    domId,
  };
  $: status = notice || (locked && sends ? "아바타 응답이 끝난 뒤 보낼 수 있습니다." : "");

  /* ---------- lifetime ---------- */

  function flush(): void {
    saver.flush();
  }
  function onVisibility(): void {
    if (document.visibilityState === "hidden") flush();
  }
  onMount(() => {
    sweepLegacyWidgetState();
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  });
  onDestroy(() => {
    alive = false;
    flush();
  });
</script>

{#each pieces as piece (piece.key)}
  {#if piece.kind === "md"}
    <!-- Only the run that ends the text is still being written, so only it is healed. -->
    <div class="md" use:diagramProblems={onDiagramProblem} use:markdownBlocks={blocks(piece.key, piece.text, streaming && piece.tail)}>{#if caret && piece.tail}<span class="stream-caret" aria-hidden="true"></span>{/if}</div>
  {:else if piece.kind === "ui"}
    <div class="wg-root answer-ui" use:enterChildren={{ rule: entrance, key: `block:${piece.key}` }}>
      {#each piece.nodes as v (v.key)}<WidgetNode {v} {ctx} />{/each}
    </div>
  {:else if piece.kind === "cards"}
    {#if cards}{@render cards(pane, piece.atts, source)}{/if}
  {:else}
    <!-- The tag of the next component is still arriving: its place is held. -->
    <div class="widget-slot-pending" role="status">
      <span class="widget-slot-bar" aria-hidden="true"></span>
      <span>{piece.tag === "chart" ? "차트를 그리는 중…" : "화면을 만드는 중…"}</span>
    </div>
  {/if}
{/each}
<div id={statusId} class="canvas-edit-status wg-status" class:dirty={Boolean(status)} role="status" aria-live="polite">{status}</div>
