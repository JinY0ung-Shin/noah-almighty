import type { ChatPane, PaneCanvas, PaneFileTab, SideTabRef } from "./types";

/**
 * The right-side panel's tabs, as ONE ordered list: the pane's canvases, then
 * the files opened in it. The tab strip, its keyboard navigation and the
 * fallback after a tab goes away all read this order, so a canvas and a .drawio
 * preview are never two panels taking turns in the same slot.
 */
export type SideTab =
  | { kind: "canvas"; id: string; canvas: PaneCanvas }
  | { kind: "file"; id: string; file: PaneFileTab };

type TabSource = Pick<ChatPane, "canvases" | "fileTabs">;

export function tabKey(ref: SideTabRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function sameTab(a: SideTabRef | null | undefined, b: SideTabRef | null | undefined): boolean {
  return Boolean(a && b && a.kind === b.kind && a.id === b.id);
}

export function sideTabs(pane: TabSource): SideTab[] {
  return [
    ...(pane.canvases ?? []).map((canvas) => ({ kind: "canvas" as const, id: canvas.id, canvas })),
    ...(pane.fileTabs ?? []).map((file) => ({ kind: "file" as const, id: file.attachment.id, file })),
  ];
}

export function hasSideTabs(pane: TabSource): boolean {
  return Boolean(pane.canvases?.length || pane.fileTabs?.length);
}

function tabExists(pane: TabSource, ref: SideTabRef): boolean {
  return ref.kind === "canvas"
    ? (pane.canvases ?? []).some((canvas) => canvas.id === ref.id)
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
  const canvases = pane.canvases ?? [];
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
