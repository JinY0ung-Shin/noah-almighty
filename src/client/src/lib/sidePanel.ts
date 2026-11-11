import type { ChatPane, MessageAttachment, PaneCanvas, PaneFileTab, SideTabRef } from "./types";

/**
 * The right-side panel's tabs, as ONE ordered list: the pane's canvases, then
 * the files opened in it. The tab strip, its keyboard navigation and the
 * fallback after a tab goes away all read this order, so a canvas and a .drawio
 * preview are never two panels taking turns in the same slot.
 */
export type SideTab =
  | { kind: "canvas"; id: string; canvas: PaneCanvas }
  | { kind: "file"; id: string; file: PaneFileTab };

type TabSource = Pick<ChatPane, "canvases" | "fileTabs"> & Partial<Pick<ChatPane, "messages" | "liveAttachments" | "streaming" | "liveRunId">>;

/* ---------- widgets live in the chat bubble, not in the panel ---------- */

/**
 * A `widget` canvas is drawn INLINE, in the bubble of the answer that showed it:
 * the server publishes a `kind: "widget"` attachment (id = the canvas id) next
 * to the canvas itself, anchored in the message text like any other card. The
 * side panel therefore leaves such a canvas out — every other canvas type is a
 * panel tab as before.
 */
export function isWidgetAttachment(att: Pick<MessageAttachment, "kind"> | null | undefined): boolean {
  return (att?.kind as string | undefined) === "widget";
}

type WidgetSource = Partial<Pick<ChatPane, "messages" | "liveAttachments">>;

/**
 * Where a widget canvas is drawn: the attachment list of the LAST message that
 * carries its attachment (the live bubble's list counts as last), or null when
 * no loaded message carries one. A canvas refined in a later turn gets a new
 * attachment there — ONE canvas is alive in ONE place, its newest.
 */
export function widgetHome(pane: WidgetSource, canvasId: string): MessageAttachment[] | null {
  const live = pane.liveAttachments;
  if (live?.some((att) => att.id === canvasId && isWidgetAttachment(att))) return live;
  const messages = pane.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const atts = messages[i].attachments;
    if (atts?.some((att) => att.id === canvasId && isWidgetAttachment(att))) return atts;
  }
  return null;
}

/**
 * Whether a canvas is (about to be) drawn in the chat instead of the panel.
 * True for a widget with an attachment in the loaded messages — and, while its
 * own run is still streaming, for a widget whose `canvas` frame arrived before
 * the attachment did (`inlineRunId`), so the panel does not open for an instant.
 *
 * The safety net is the other half: a widget canvas with NO attachment anywhere
 * (made before widgets moved into the chat, or whose attachment was not stored)
 * stays a panel tab. A widget is never without a place to be seen.
 */
export function isInlineCanvas(pane: TabSource, canvas: PaneCanvas): boolean {
  if (canvas.contentType !== "widget") return false;
  if (widgetHome(pane, canvas.id)) return true;
  return Boolean(canvas.inlineRunId && pane.streaming && pane.liveRunId === canvas.inlineRunId);
}

/** The canvases the side panel shows as tabs: all of them but the widgets drawn in the chat. */
export function panelCanvases(pane: TabSource): PaneCanvas[] {
  const canvases = pane.canvases ?? [];
  // The common case — no widget at all — never walks the messages.
  if (!canvases.some((canvas) => canvas.contentType === "widget")) return canvases;
  return canvases.filter((canvas) => !isInlineCanvas(pane, canvas));
}

export function tabKey(ref: SideTabRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function sameTab(a: SideTabRef | null | undefined, b: SideTabRef | null | undefined): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id);
}

export function sideTabs(pane: TabSource): SideTab[] {
  return [
    ...panelCanvases(pane).map((canvas) => ({ kind: "canvas" as const, id: canvas.id, canvas })),
    ...(pane.fileTabs ?? []).map((file) => ({ kind: "file" as const, id: file.attachment.id, file })),
  ];
}

export function hasSideTabs(pane: TabSource): boolean {
  return Boolean(pane.fileTabs?.length || panelCanvases(pane).length);
}

function tabExists(pane: TabSource, ref: SideTabRef): boolean {
  return ref.kind === "canvas"
    ? panelCanvases(pane).some((canvas) => canvas.id === ref.id)
    : (pane.fileTabs ?? []).some((file) => file.attachment.id === ref.id);
}

/**
 * The tab the panel shows: the selected one while it still exists; else the
 * latest canvas still waiting for an answer (a pane returning to a parked run
 * selects nothing from the replayed log, and the ask may have refined an older
 * canvas in place); else the latest canvas, else the latest open file.
 */
export function resolveSideTab(pane: TabSource & Pick<ChatPane, "sideTab">): SideTabRef | null {
  const ref = pane.sideTab;
  if (ref && tabExists(pane, ref)) return { kind: ref.kind, id: ref.id };
  const canvases = panelCanvases(pane);
  const waiting = canvases.filter((canvas) => canvas.pending);
  if (waiting.length) return { kind: "canvas", id: waiting[waiting.length - 1].id };
  if (canvases.length) return { kind: "canvas", id: canvases[canvases.length - 1].id };
  const files = pane.fileTabs ?? [];
  if (files.length) return { kind: "file", id: files[files.length - 1].attachment.id };
  return null;
}

/**
 * The tab to show once `ref` goes away: the one after it, else the one before
 * it (browser-tab order). Call it BEFORE removing `ref`.
 */
export function neighborTab(pane: TabSource, ref: SideTabRef): SideTabRef | null {
  const tabs = sideTabs(pane);
  const index = tabs.findIndex((tab) => sameTab(tab, ref));
  const next = index < 0 ? null : (tabs[index + 1] ?? tabs[index - 1] ?? null);
  return next ? { kind: next.kind, id: next.id } : null;
}
