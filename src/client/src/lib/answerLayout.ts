// The order things are drawn in an answer that holds inline UI: runs of the
// answer's Markdown, UI blocks, and the cards (files, images, team-brain cards)
// anchored in the text — the same rule as `bubbleSegments.ts`, one level finer.
//
// An anchor is "the answer's text length when the card was published", so a
// card sits where its tool ran. Here the text is already cut into top-level
// pieces (`AnswerItem`), each with its offsets: a card anchored inside a
// Markdown run splits that run; one anchored inside a UI block (it cannot be
// drawn in the middle of one) comes right after it.
import type { MessageAttachment } from "./types";
import type { AnswerItem, VNode } from "./widgetView";

export type AnswerPiece =
  /** `tail`: the run that ends the text — where the stream caret sits, and the only run healed while streaming. */
  | { kind: "md"; key: string; text: string; tail: boolean }
  | { kind: "ui"; key: string; nodes: VNode[] }
  | { kind: "cards"; key: string; atts: MessageAttachment[] }
  /** A component whose tag is still being written at the end of a streaming answer. */
  | { kind: "pending"; key: string; tag: string };

export function answerPieces(
  items: AnswerItem[],
  textLength: number,
  attachments: MessageAttachment[] | undefined,
  pending: { tag?: string; top: boolean } | null = null,
): AnswerPiece[] {
  // A retired canvas-widget attachment has nothing to draw any more.
  const visible = (attachments ?? []).filter((att) => !att.hidden && (att.kind as string) !== "widget");
  const isAnchored = (att: MessageAttachment) => typeof att.anchor === "number" && Number.isFinite(att.anchor);
  const anchored = visible.filter(isAnchored).sort((a, b) => a.anchor! - b.anchor!);
  const out: AnswerPiece[] = [];
  let next = 0;

  const pushCards = (att: MessageAttachment, at: number) => {
    const last = out[out.length - 1];
    if (last && last.kind === "cards") last.atts.push(att);
    else out.push({ kind: "cards", key: `c${at}:${att.id}`, atts: [att] });
  };
  const pushMd = (key: string, text: string) => {
    if (text.trim()) out.push({ kind: "md", key, text, tail: false });
  };

  for (const item of items) {
    if (item.kind === "ui") {
      const last = out[out.length - 1];
      // Blocks written back to back are one layout (one gap rhythm), like siblings in a container.
      if (last && last.kind === "ui") last.nodes = last.nodes.concat(item.nodes);
      else out.push({ kind: "ui", key: `u${item.s}`, nodes: item.nodes });
      continue;
    }
    let cursor = item.s;
    let part = 0;
    while (next < anchored.length && anchored[next].anchor! < item.e) {
      const pos = Math.max(anchored[next].anchor!, cursor);
      if (pos > cursor) {
        pushMd(`m${item.s}:${part++}`, item.text.slice(cursor - item.s, pos - item.s));
        cursor = pos;
      }
      pushCards(anchored[next], pos);
      next++;
    }
    if (cursor < item.e) pushMd(`m${item.s}:${part}`, item.text.slice(cursor - item.s));
  }
  // The run that ends the text is the one still being written.
  const lastPiece = out[out.length - 1];
  const lastItem = items[items.length - 1];
  if (lastPiece && lastPiece.kind === "md" && lastItem && lastItem.kind === "md" && lastItem.e >= textLength) lastPiece.tail = true;

  if (pending && pending.top && pending.tag) out.push({ kind: "pending", key: "pending", tag: pending.tag });

  // Cards anchored at or past the end, then the ones without an anchor (legacy rows): after everything.
  for (; next < anchored.length; next++) pushCards(anchored[next], textLength);
  for (const att of visible) if (!isAnchored(att)) pushCards(att, textLength + 1);
  return out;
}
