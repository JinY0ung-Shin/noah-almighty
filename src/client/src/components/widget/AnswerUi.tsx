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
//
// How it is built: everything an answer keeps between renders — what the viewer
// set, the parsed document, the evaluated blocks — lives in ONE object made
// when the component mounts (`createAnswerView`). Its functions close over
// plain variables, so a handler, a timer or a late callback always sees the
// current value; the component hands it this render's props (`sync`) and draws
// what it holds.
import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useState, type ReactNode } from "react";

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
import { sendWidgetMessage } from "../../lib/chat";
import { copyText, markdownBlocks } from "../../lib/dom";
import { cx, useAction, useMergedRef, useStore } from "../../lib/hooks";
import { diagramProblems } from "../../lib/mermaidBlock";
import { notify, readState } from "../../lib/state";
import { changed } from "../../lib/store";
import { createStreamMarkdown, type StreamBlock, type StreamMarkdown } from "../../lib/streamMarkdown";
import { theme } from "../../lib/theme";
import type { ChatPane, MessageAttachment } from "../../lib/types";
import { continuesEntranceText, enterChildren, noteEntranceText, openEntranceScope, type EntranceRule } from "../../lib/uiEntrance";
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
  type LiveWidgetState,
  type WidgetStateRecord,
  type WidgetStateRef,
} from "../../lib/widgetState";
import { buildAnswerItems, collectWidgetProblems, createAnswerViewCache, type AnswerItem, type VNode } from "../../lib/widgetView";
import WidgetNode from "./WidgetNode";

let nextViewId = 0;

// The live bubble's state is TAKEN by the stored message it became (removed as
// it is read, so no other answer gets it) — while the view is being made, which
// is during a render. React may make a render again from scratch (one it
// abandoned half-way), and the second making must find what the first took: it
// is kept here, by pane and message, until the view is on screen.
const takenOver = new Map<string, LiveWidgetState>();
const MAX_TAKEN_OVER = 8;

export interface AnswerUiProps {
  pane: ChatPane;
  /** The answer text shown so far (all of it once the answer is stored and revealed). */
  text?: string;
  /** The attachments shown so far, and the full list the cards compare against. */
  atts?: MessageAttachment[];
  source?: MessageAttachment[];
  /** The text is still growing (the live bubble, or a stored answer whose end is draining in). */
  streaming?: boolean;
  /** The stored message this answer is; null for the live bubble. */
  messageId?: string | null;
  /** This is the conversation's latest answer: what it cannot draw is worth telling the avatar. */
  latest?: boolean;
  /** Draw the stream caret at the end of the text. */
  caret?: boolean;
  /** ChatView's card renderer: `(pane, attachments, source)`. */
  cards?: (pane: ChatPane, atts: MessageAttachment[], source: MessageAttachment[] | undefined) => ReactNode;
  /**
   * A PREVIEW outside a conversation (the 인라인 UI gallery): what a control
   * would send to the avatar is handed here instead of to the chat, and nothing
   * is kept in this browser or reported. null in a chat.
   */
  outbox?: ((message: string) => void) | null;
}

/** The props the view reads later than the render that passed them. */
interface Current {
  pane: ChatPane;
  text: string;
  atts: MessageAttachment[] | undefined;
  streaming: boolean;
  messageId: string | null;
  latest: boolean;
  outbox: ((message: string) => void) | null;
}

/** What the view asks of the component that draws it. */
interface Surface {
  /** Something the view holds changed outside a render (a setter ran): draw again. */
  redraw(): void;
  /** The line under the answer that says an action did not go through ("" clears it). */
  notice(text: string): void;
}

function createAnswerView(first: Current, surface: Surface) {
  // This render's props. Replaced by `sync` before anything is drawn.
  let p = first;

  const viewId = `ui${++nextViewId}`;
  // Fixed for the instance's life, like the pane it was mounted for.
  const preview = p.outbox !== null;
  const statusId = `${viewId}-status`;
  const rt = createRuntime();
  const cache = createAnswerViewCache();
  // Captured at mount: by the time a pending save is flushed the pane may show another conversation.
  const conversationId = p.pane.conversationId || null;
  const paneId = p.pane.id;

  /* ---------- state ---------- */

  // `stored` is what the VIEWER changed, each value with the declaration it was
  // set under; `values` is what the document evaluates with (initializers, then
  // the stored values whose declaration is unchanged).
  let stored: WidgetStateRecord = {};
  let values: Record<string, unknown> = {};
  let statesSig: string | null = null;
  // Bumped by a setter: what tells `sync` that a state change needs an update.
  let tick = 0;

  const saver = createWidgetStateSaver(dataSize);
  function ref(): WidgetStateRef {
    return { userId: readState().user?.id, conversationId, messageId: p.messageId };
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
  const runId = p.messageId ? null : p.pane.liveRunId || null;
  // The control that has the focus, by its key in the view — handed over with the state.
  let focusedKey: string | null = null;

  function persist(): void {
    if (preview) return;
    if (p.messageId) saver.schedule(ref(), storable());
    else setLiveWidgetState(paneId, { conversationId, runId, text: parsedText ?? p.text, record: stored, focus: focusedKey });
  }

  // Taken over from the live bubble: stored under the message once the document is parsed.
  const handoverKey = `${paneId}\n${p.messageId ?? ""}`;
  let adopted = false;
  let refocus: string | null = null;
  if (preview) {
    // A preview starts from its initializers every time it is opened.
  } else if (p.messageId) {
    // What this browser kept for the answer — or, right after its turn ended,
    // what the viewer changed while it was still streaming (only the answer
    // that continues the live text may take that over).
    const kept = loadWidgetState(ref());
    const taken = kept ? null : takeLiveWidgetState(paneId, conversationId, p.text);
    if (taken) {
      takenOver.set(handoverKey, taken);
      while (takenOver.size > MAX_TAKEN_OVER) takenOver.delete(takenOver.keys().next().value as string);
    }
    const live = kept ? null : (taken ?? takenOver.get(handoverKey) ?? null);
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
  if (!preview && !p.messageId) openEntranceScope(entranceScope, runId);
  // The stored message of the answer that was just written here: its turn can
  // end before the last of it was drawn (a chart), and that still enters.
  const fresh = !preview && Boolean(p.messageId) && continuesEntranceText(entranceScope, p.text);
  // This instance has shown the answer WHILE it was written (the live bubble, a
  // stored message whose end drained in). Kept once true: a chart is drawn a
  // moment after its tag arrived (its library loads on demand), and by then the last of
  // the text may be in — the chart still appeared now.
  let written = p.streaming;
  // The viewer changed something here: what appears from now on (the tab they
  // just picked) appears because of them, not because a page loaded.
  let interacted = false;

  // A stopped or failed turn's bubble is mounted under a client-made id and
  // adopts the server's when it arrives: what was stored moves with it.
  let storedUnder = p.messageId;
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
      surface.redraw();
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

  // What the last update was run for: it runs again when one of them changed.
  let ran = false;
  let seenTick = 0;
  // The avatar is answering: nothing goes out to it (see `send`).
  let locked = p.pane.streaming;

  /**
   * This render's props. The answer is parsed and evaluated again when the
   * text, `streaming` or the state changed — and whenever attachments are
   * passed at all: the list is the pane's own array, changed in place.
   */
  function sync(next: Current): void {
    const before = p;
    p = next;
    locked = next.pane.streaming;
    if (ran && next.text === before.text && next.streaming === before.streaming && !changed(before.atts, next.atts) && tick === seenTick) return;
    update(next.text, next.streaming, next.atts, tick);
  }

  function update(nextText: string, nextStreaming: boolean, nextAtts: MessageAttachment[] | undefined, nowTick: number): void {
    if (firing) {
      heldBack = true;
      return;
    }
    ran = true;
    seenTick = nowTick;
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
      if (!p.messageId && Object.keys(stored).length > 0) persist();
      if (!p.messageId && !preview) noteEntranceText(entranceScope, nextText);
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
    // answer is finished NOW.
    streamingNow = nextStreaming;
    if (nextStreaming) written = true;
    if (!nextStreaming) reportProblems([...staticProblems(doc), ...collectWidgetProblems(doc, drawn), ...knownDiagramIssues()]);
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
  // A plain variable, set by `update` where it changes — never read from a prop
  // that a later render could have moved on.
  let streamingNow = p.streaming;
  // Becoming the latest answer later (the one after it was removed) is a reason to report, too.
  let wasLatest = p.latest;
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
    if (!errors.length || !p.messageId || !p.latest || streamingNow) return;
    const content = parsedText ?? "";
    queueInlineUiReport({
      conversationId,
      messageId: p.messageId,
      content,
      errors,
      stillCurrent: () => alive && p.latest && !streamingNow && parsedText === content,
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
    if (!p.messageId && key) persist();
  }
  function onFocusOut(event: FocusEvent): void {
    // Focus moved somewhere else on purpose (not: the node was removed).
    if (!event.relatedTarget || keyOf(event.target) !== focusedKey) return;
    focusedKey = null;
    if (!p.messageId) persist();
  }
  async function restoreFocus(): Promise<void> {
    const key = refocus;
    refocus = null;
    // The controls are in the document (this runs after a commit); whatever
    // else takes the focus in the same commit comes first.
    await Promise.resolve();
    if (!alive || !key) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const root = document.querySelector<HTMLElement>(`[data-wg-key="${viewId}-${key}"]`);
    if (!root) return;
    // A group (segments, tabs) gets the focus on its picked option.
    const control = root.matches(CONTROL) ? root : (root.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]') ?? root.querySelector<HTMLElement>(CONTROL));
    control?.focus({ preventScroll: true });
  }
  /** After every commit: the first one of a view that took a focused control over gives the focus back. */
  function committed(): void {
    if (refocus) void restoreFocus();
  }

  /* ---------- events ---------- */

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
      update(p.text, p.streaming, p.atts, tick);
      surface.redraw();
    }
    surface.notice(ok ? "" : "동작을 실행하지 못했습니다.");
    if (!ok) reportProblems([`an event handler failed: ${failure}`]);
  }

  // Both go out as the viewer's NEXT chat message, so both wait for the avatar's
  // turn to end; the UI's own inputs keep working meanwhile.

  function send(message: string): void {
    // Never a slash command: the control is disabled for one, and this is the second lock.
    if (locked || !message.trim() || message.trim().startsWith("/")) return;
    if (p.outbox) p.outbox(message);
    else void sendWidgetMessage(paneId, message);
  }

  function submit(raw: unknown, label: string): void {
    if (locked) return;
    const normalized = normalizeSubmitValues(raw);
    if (!normalized.ok) {
      surface.notice("보낼 값이 너무 많거나 길어서 보내지 못했습니다.");
      return;
    }
    const entries = Object.entries(normalized.values);
    // `values` that evaluated to nothing: an empty answer must not reach the avatar as if one had been sent.
    if (entries.length === 0) {
      surface.notice("보낼 값이 없어 보내지 않았습니다.");
      return;
    }
    surface.notice("");
    const lines = entries.map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    const message = `${label.trim() || "보내기"}\n${lines.join("\n")}`;
    if (p.outbox) p.outbox(message);
    else void sendWidgetMessage(paneId, message, 10_000);
  }

  function domId(key: string): string {
    return `${viewId}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  /* ---------- lifetime ---------- */

  function flush(): void {
    saver.flush();
  }
  function onVisibility(): void {
    if (document.visibilityState === "hidden") flush();
  }
  /** Mounted: returns what to do when the component goes. */
  function mount(): () => void {
    alive = true;
    takenOver.delete(handoverKey);
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
      alive = false;
      flush();
    };
  }

  return {
    preview,
    statusId,
    entranceScope,
    fresh,
    sync,
    rekey,
    noteLatest,
    committed,
    mount,
    blocks,
    onDiagramProblem,
    fire,
    submit,
    send,
    report: (problem: string) => reportProblems([problem]),
    domId,
    get pieces() {
      return pieces;
    },
    get sends() {
      return sends;
    },
    get locked() {
      return locked;
    },
    get written() {
      return written;
    },
    get interacted() {
      return interacted;
    },
  };
}

/** One run of the answer's Markdown: its own element, for the two behaviours attached to it. */
function AnswerMarkdown({ blocks, onProblem, caret }: { blocks: StreamBlock[]; onProblem: (problem: string) => void; caret: boolean }) {
  const ref = useMergedRef<HTMLDivElement>(useAction(diagramProblems, onProblem), useAction(markdownBlocks, blocks));
  return (
    <div className="md" ref={ref}>
      {caret ? <span className="stream-caret" aria-hidden="true"></span> : null}
    </div>
  );
}

/** One block of UI: its top-level components rise in as they appear (lib/uiEntrance.ts). */
function AnswerBlock({ nodes, ctx, blockKey }: { nodes: VNode[]; ctx: WidgetCtx; blockKey: string }) {
  return (
    <div className="wg-root answer-ui" ref={useAction(enterChildren, { rule: ctx.entrance, key: blockKey })}>
      {nodes.map((v) => (
        <WidgetNode key={v.key} v={v} ctx={ctx} />
      ))}
    </div>
  );
}

export default function AnswerUi({
  pane,
  text = "",
  atts = undefined,
  source = undefined,
  streaming = false,
  messageId = null,
  latest = false,
  caret = false,
  cards = undefined,
  outbox = null,
}: AnswerUiProps) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [notice, setNotice] = useState("");
  const dark = useStore(theme) === "dark";

  const current: Current = { pane, text, atts, streaming, messageId, latest, outbox };
  // Made once, with the props the component is mounted with: what the browser
  // kept for this answer (or the live bubble handed over) is read here, before
  // anything is drawn.
  const [view] = useState(() => createAnswerView(current, { redraw, notice: setNotice }));
  view.sync(current);

  // A stopped or failed turn's bubble adopts the server's id when it arrives.
  useLayoutEffect(() => view.rekey(messageId), [view, messageId]);
  useLayoutEffect(() => view.noteLatest(latest), [view, latest]);
  useLayoutEffect(() => view.committed());
  useEffect(() => view.mount(), [view]);

  const { locked, written, interacted } = view;
  const entrance = useMemo<EntranceRule | null>(
    () => (view.preview || interacted ? { scope: view.entranceScope, always: true } : written || view.fresh ? { scope: view.entranceScope, always: false } : null),
    [view, interacted, written],
  );
  // A new object only when one of its fields changed: the components below
  // tell what changed by it (WidgetControl says a refused send again then).
  const ctx = useMemo<WidgetCtx>(
    () => ({
      fire: view.fire,
      submit: view.submit,
      send: view.send,
      report: view.report,
      locked,
      statusId: view.statusId,
      dark,
      entrance,
      domId: view.domId,
    }),
    [view, locked, dark, entrance],
  );
  const status = notice || (locked && view.sends ? "아바타 응답이 끝난 뒤 보낼 수 있습니다." : "");

  return (
    <>
      {view.pieces.map((piece) =>
        piece.kind === "md" ? (
          // Only the run that ends the text is still being written, so only it is healed.
          <AnswerMarkdown key={piece.key} blocks={view.blocks(piece.key, piece.text, streaming && piece.tail)} onProblem={view.onDiagramProblem} caret={caret && piece.tail} />
        ) : piece.kind === "ui" ? (
          <AnswerBlock key={piece.key} nodes={piece.nodes} ctx={ctx} blockKey={`block:${piece.key}`} />
        ) : piece.kind === "cards" ? (
          <Fragment key={piece.key}>{cards ? cards(pane, piece.atts, source) : null}</Fragment>
        ) : (
          // The tag of the next component is still arriving: its place is held.
          <div key={piece.key} className="widget-slot-pending" role="status">
            <span className="widget-slot-bar" aria-hidden="true"></span>
            <span>{piece.tag === "chart" ? "차트를 그리는 중…" : "화면을 만드는 중…"}</span>
          </div>
        ),
      )}
      <div id={view.statusId} className={cx("canvas-edit-status wg-status", Boolean(status) && "dirty")} role="status" aria-live="polite">
        {status}
      </div>
    </>
  );
}
