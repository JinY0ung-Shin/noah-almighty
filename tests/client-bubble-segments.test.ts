import { describe, expect, it } from "vitest";
import { panelSlides, segmentAttachments } from "../src/client/src/lib/bubbleSegments.js";
import type { MessageAttachment } from "../src/server/types.js";

function att(id: string, extra: Partial<MessageAttachment> = {}): MessageAttachment {
  return { id, kind: "file", mediaType: "application/pdf", name: `${id}.pdf`, ...extra };
}

describe("segmentAttachments", () => {
  it("returns the whole text as a single tail segment when there are no attachments", () => {
    expect(segmentAttachments("안녕하세요", undefined)).toEqual([
      { text: "안녕하세요", atts: [], tail: true },
    ]);
    expect(segmentAttachments("안녕하세요", [])).toEqual([
      { text: "안녕하세요", atts: [], tail: true },
    ]);
  });

  it("keeps un-anchored (legacy) attachments after the full text", () => {
    const legacy = att("a");
    expect(segmentAttachments("본문", [legacy])).toEqual([
      { text: "본문", atts: [legacy], tail: true },
    ]);
  });

  it("splits the text at an anchor so the card sits where it was created", () => {
    // Anchor as stamped in practice: the joined text length when the tool ran,
    // i.e. right after "첫 단락" and before the next chunk's "\n\n" separator.
    const a = att("a", { anchor: "첫 단락".length });
    const segments = segmentAttachments("첫 단락\n\n둘째 단락", [a]);
    expect(segments).toEqual([
      { text: "첫 단락", atts: [a] },
      { text: "\n\n둘째 단락", atts: [], tail: true },
    ]);
  });

  it("renders an anchor-0 card before any text", () => {
    const a = att("a", { anchor: 0 });
    expect(segmentAttachments("본문", [a])).toEqual([
      { text: "", atts: [a] },
      { text: "본문", atts: [], tail: true },
    ]);
  });

  it("groups attachments sharing an anchor into one card block", () => {
    const a = att("a", { anchor: 2 });
    const b = att("b", { anchor: 2 });
    expect(segmentAttachments("가나다라", [a, b])).toEqual([
      { text: "가나", atts: [a, b] },
      { text: "다라", atts: [], tail: true },
    ]);
  });

  it("clamps an anchor beyond the text (stopped turns persist shorter delta-joined text)", () => {
    const a = att("a", { anchor: 999 });
    expect(segmentAttachments("짧은 답", [a])).toEqual([
      { text: "짧은 답", atts: [a] },
      { text: "", atts: [], tail: true },
    ]);
  });

  it("keeps positions monotonic when anchors arrive out of order", () => {
    const late = att("late", { anchor: 4 });
    const early = att("early", { anchor: 1 });
    expect(segmentAttachments("abcdef", [late, early])).toEqual([
      { text: "a", atts: [early] },
      { text: "bcd", atts: [late] },
      { text: "ef", atts: [], tail: true },
    ]);
  });

  it("never renders hidden attachments, anchored or not", () => {
    const hidden = att("h", { anchor: 1, hidden: true, kind: "image", mediaType: "image/png" });
    const legacyHidden = att("h2", { hidden: true });
    expect(segmentAttachments("본문", [hidden, legacyHidden])).toEqual([
      { text: "본문", atts: [], tail: true },
    ]);
  });

  it("mixes anchored and legacy attachments: anchored inline, legacy after the text", () => {
    const inline = att("inline", { anchor: 2 });
    const legacy = att("legacy");
    expect(segmentAttachments("가나다", [legacy, inline])).toEqual([
      { text: "가나", atts: [inline] },
      { text: "다", atts: [legacy], tail: true },
    ]);
  });
});

describe("panelSlides", () => {
  const slide = (id: string, parentId?: string) =>
    att(id, { kind: "image", mediaType: "image/png", hidden: true, parentId });

  it("collects only hidden images, never visible attachments", () => {
    const card = att("card");
    const visibleImage = att("v", { kind: "image", mediaType: "image/png" });
    expect(panelSlides([card, visibleImage, slide("s1")], card)).toEqual([slide("s1")]);
    expect(panelSlides(undefined, card)).toEqual([]);
  });

  it("scopes parentId-stamped slides to their own card (deck + screenshot in one turn)", () => {
    const deck = att("deck");
    const shot = att("shot");
    const deckSlides = [slide("d1", "deck"), slide("d2", "deck")];
    const shotSlide = slide("s1", "shot");
    const all = [deck, ...deckSlides, shot, shotSlide];
    expect(panelSlides(all, deck)).toEqual(deckSlides);
    expect(panelSlides(all, shot)).toEqual([shotSlide]);
  });

  it("keeps legacy slides (no parentId) reachable from any card", () => {
    const card = att("card");
    const legacy = slide("old");
    expect(panelSlides([card, legacy], card)).toEqual([legacy]);
  });

  // The pre-share-links rule took stamped AND unstamped hidden images together.
  // The deck-review loop (SKILL §11) publishes its canvas renders as unstamped
  // hidden images in the SAME turn as the deck, so the old rule showed every
  // slide twice. Unstamped images count only when the card has no stamped ones.
  it("never mixes unstamped canvas renders into a card that has stamped slides", () => {
    const deck = att("deck");
    const stamped = [slide("d1", "deck"), slide("d2", "deck")];
    const canvasRenders = [slide("r1"), slide("r2")];
    expect(panelSlides([deck, ...stamped, ...canvasRenders], deck)).toEqual(stamped);
    // A second card in that message with no stamped slides of its own still
    // falls back to the legacy unstamped set.
    const other = att("other");
    expect(panelSlides([deck, ...stamped, other, ...canvasRenders], other)).toEqual(canvasRenders);
  });
});
