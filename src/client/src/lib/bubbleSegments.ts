// Assistant-bubble layout: split the message text at each attachment's anchor
// (the text length captured when the file/image was published) so cards render
// inline where they were created — later streaming text lands BELOW a card
// instead of pushing it down. Anchors are stamped server-side on persisted
// messages (claudeAgent's file-output wrappers) and client-side on live
// arrivals (chat.ts "file" event), both as "text length so far".

import { cardSlideAttachments } from "../../../shared/shareLinks";
import type { MessageAttachment } from "./types";

/** One render unit: a text slice, then the cards anchored at its end. */
export interface BubbleSegment {
  text: string;
  atts: MessageAttachment[];
  /** The segment holding the text remainder — the live bubble pins its stream caret here. */
  tail?: boolean;
}

/**
 * Rendering = for each segment: markdown(text), then its cards. Un-anchored
 * attachments (legacy rows, user uploads) collect on the tail segment, after
 * the full text — the pre-anchor layout. Hidden attachments never render.
 * Anchors are clamped to the text and kept monotonic: a stopped/errored turn
 * persists delta-joined text a few chars shorter than the anchors'
 * chunk-joined accounting, and that must not produce out-of-range slices.
 */
/**
 * Hidden preview images belonging to a clicked file card (deck slide renders,
 * browser-screenshot copies) — what the file-preview panel shows. The shared
 * `cardSlideAttachments` rule: the renders stamped with THIS card's id when
 * there are any, and only then the unstamped ones (messages from before
 * `parentId` existed). Never both — the deck-review loop publishes unstamped
 * hidden canvas renders in the same turn as the deck, and mixing them in showed
 * every slide twice.
 */
export function panelSlides(
  attachments: MessageAttachment[] | undefined,
  parent: MessageAttachment,
): MessageAttachment[] {
  return cardSlideAttachments(attachments, parent.id);
}

export function segmentAttachments(
  text: string,
  attachments: MessageAttachment[] | undefined,
): BubbleSegment[] {
  const visible = (attachments ?? []).filter((att) => !att.hidden);
  const isAnchored = (att: MessageAttachment) =>
    typeof att.anchor === "number" && Number.isFinite(att.anchor);
  const anchored = visible.filter(isAnchored).sort((a, b) => a.anchor! - b.anchor!);
  const segments: BubbleSegment[] = [];
  let prev = 0;
  for (const att of anchored) {
    const pos = Math.min(Math.max(att.anchor!, prev), text.length);
    const last = segments[segments.length - 1];
    if (last && pos === prev) {
      last.atts.push(att); // same spot as the previous card — no empty text run between
    } else {
      segments.push({ text: text.slice(prev, pos), atts: [att] });
      prev = pos;
    }
  }
  segments.push({
    text: text.slice(prev),
    atts: visible.filter((att) => !isAnchored(att)),
    tail: true,
  });
  return segments;
}
