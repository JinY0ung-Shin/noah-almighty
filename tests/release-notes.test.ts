import { describe, expect, it } from "vitest";
import {
  CURRENT_RELEASE_ID,
  MAX_RELEASES_SHOWN,
  RELEASE_NOTES,
  releaseDateLabel,
  unseenReleases,
} from "../src/server/releaseNotes.js";

// Coverage target: src/server/releaseNotes.ts — the what's-new registry shared
// by the server (seed + stamp) and the client bundle (dialog selection).

describe("release notes registry", () => {
  it("keeps ids unique, entries non-empty, and the current id first", () => {
    const ids = RELEASE_NOTES.map((note) => note.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const note of RELEASE_NOTES) {
      expect(note.items.length).toBeGreaterThan(0);
      for (const item of note.items) {
        expect(item.title.trim()).not.toBe("");
        expect(item.body.trim()).not.toBe("");
        if (item.example !== undefined) expect(item.example.trim()).not.toBe("");
      }
    }
    expect(CURRENT_RELEASE_ID).toBe(RELEASE_NOTES[0]?.id ?? null);
  });

  it("selects unseen releases: null/unknown = never seen (capped), current = none", () => {
    // Never seen → the latest entries, capped.
    const neverSeen = unseenReleases(null);
    expect(neverSeen.length).toBe(Math.min(RELEASE_NOTES.length, MAX_RELEASES_SHOWN));
    expect(neverSeen[0]?.id).toBe(CURRENT_RELEASE_ID);
    // Caught up → nothing.
    expect(unseenReleases(CURRENT_RELEASE_ID)).toEqual([]);
    // Unknown id (pruned entry or a rollback) must behave like "never seen":
    // returning [] instead would permanently silence every FUTURE note for that
    // account (nothing shows → nothing re-stamps → unknown forever).
    expect(unseenReleases("9999-99-99").length).toBe(neverSeen.length);
  });

  it("slices strictly newer entries when the seen id sits mid-list", () => {
    // Boundary cases (null → all, current → none) are pinned above; this pins
    // the mid-list slice once the registry has 2+ entries.
    if (RELEASE_NOTES.length >= 2) {
      const unseen = unseenReleases(RELEASE_NOTES[1]!.id);
      expect(unseen.map((note) => note.id)).toEqual([RELEASE_NOTES[0]!.id]);
    }
  });

  it("formats date labels", () => {
    expect(releaseDateLabel("2026-07-29")).toBe("2026년 7월 29일");
    // Same-day second release keeps the plain date label.
    expect(releaseDateLabel("2026-07-29.2")).toBe("2026년 7월 29일");
    // Unparseable ids fall back to the raw id rather than garbling.
    expect(releaseDateLabel("v-next")).toBe("v-next");
  });
});
