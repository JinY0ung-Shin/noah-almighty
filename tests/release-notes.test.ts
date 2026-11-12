import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_RELEASE_ID,
  FEATURE_HINTS,
  FEATURE_HINT_IDS,
  MAX_RELEASES_SHOWN,
  RELEASE_NOTES,
  pendingFeatureHints,
  releaseDateLabel,
  unseenReleases,
} from "../src/server/releaseNotes.js";
import {
  CHAT_DOCUMENT_EXTENSIONS,
  MAX_CHAT_DOCUMENTS_PER_MESSAGE,
  MAX_CHAT_DOCUMENTS_TOTAL_BYTES,
} from "../src/shared/chatDocuments.js";

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

  it("keeps hint ids unique across the WHOLE registry and their text non-empty", () => {
    // Across every entry, not only the ones in force: an id reused by a later
    // release would already be in old accounts' seen lists.
    const hints = RELEASE_NOTES.flatMap((note) => note.items.flatMap((item) => (item.hint ? [item.hint] : [])));
    const ids = hints.map((hint) => hint.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const hint of hints) {
      expect(hint.id.trim()).not.toBe("");
      expect(hint.body.trim()).not.toBe("");
      if (hint.title !== undefined) expect(hint.title.trim()).not.toBe("");
    }
  });

  it("offers the hints of the releases the dialog still shows, heading defaulted to the item title", () => {
    const inForce = RELEASE_NOTES.slice(0, MAX_RELEASES_SHOWN).flatMap((note) =>
      note.items.flatMap((item) => (item.hint ? [{ item, hint: item.hint }] : [])),
    );
    expect(FEATURE_HINTS.map((hint) => hint.id)).toEqual(inForce.map(({ hint }) => hint.id));
    expect(FEATURE_HINT_IDS).toEqual(FEATURE_HINTS.map((hint) => hint.id));
    for (const { item, hint } of inForce) {
      const offered = FEATURE_HINTS.find((candidate) => candidate.id === hint.id)!;
      expect(offered.title).toBe(hint.title ?? item.title);
      expect(offered.body).toBe(hint.body);
      expect(offered.anchor).toBe(hint.anchor);
    }
    // A release that fell out of the dialog's window takes its bubbles with it.
    for (const note of RELEASE_NOTES.slice(MAX_RELEASES_SHOWN)) {
      for (const item of note.items) {
        if (item.hint) expect(FEATURE_HINT_IDS).not.toContain(item.hint.id);
      }
    }
  });

  it("keeps the document-attach small print in step with what the composer accepts", () => {
    // The registry is dependency-free, so these lines are typed by hand — and
    // they are the place a user reads the limits. A changed limit or file type
    // must change the bubble too.
    const hint = RELEASE_NOTES.flatMap((note) => note.items).find((item) => item.hint?.anchor === "composer-attach")?.hint;
    expect(hint?.details?.length).toBeGreaterThan(0);
    const small = hint!.details!.join("\n").toLowerCase();
    for (const extension of CHAT_DOCUMENT_EXTENSIONS) expect(small, `.${extension} is not named`).toContain(extension);
    for (const image of ["png", "jpg", "webp", "gif"]) expect(small).toContain(image);
    expect(small).toContain(`${MAX_CHAT_DOCUMENTS_PER_MESSAGE}개`);
    expect(small).toContain(`합쳐서 ${MAX_CHAT_DOCUMENTS_TOTAL_BYTES / (1024 * 1024)}mb`);
    for (const line of hint!.details!) expect(line.trim()).not.toBe("");
    // Every hint in force exposes a list, empty when it has no small print.
    for (const offered of FEATURE_HINTS) expect(Array.isArray(offered.details)).toBe(true);
    expect(FEATURE_HINTS.find((offered) => offered.id === hint!.id)?.details).toEqual(hint!.details);
  });

  it("selects pending hints: none seen = all, seen ones drop out, no list = nothing", () => {
    expect(pendingFeatureHints([])).toEqual(FEATURE_HINTS);
    expect(pendingFeatureHints(FEATURE_HINT_IDS)).toEqual([]);
    if (FEATURE_HINTS.length) {
      const [first, ...rest] = FEATURE_HINTS;
      expect(pendingFeatureHints([first!.id, "unknown-id"])).toEqual(rest);
    }
    // A server from before the feature (or a stub) sends no list. Offering
    // everything then would bring each bubble back on every load, because
    // nothing could record the dismissal.
    expect(pendingFeatureHints(undefined)).toEqual([]);
    expect(pendingFeatureHints(null)).toEqual([]);
  });

  it("has a mounted control for every hint anchor", () => {
    // A hint whose anchor no component marks never shows, and nothing else
    // would say so. The anchor id must appear in the client outside the module
    // that only declares the sides.
    const clientRoot = path.join(process.cwd(), "src", "client", "src");
    const sources = (fs.readdirSync(clientRoot, { recursive: true }) as string[])
      .filter((file) => /\.tsx$/.test(file))
      .map((file) => fs.readFileSync(path.join(clientRoot, file), "utf8"))
      .join("\n");
    for (const hint of FEATURE_HINTS) {
      expect(sources, `no control is marked as the "${hint.anchor}" anchor`).toContain(`"${hint.anchor}"`);
    }
    expect(sources).toContain("featureHintAnchor(");
  });

  it("formats date labels", () => {
    expect(releaseDateLabel("2026-07-29")).toBe("2026년 7월 29일");
    // Same-day second release keeps the plain date label.
    expect(releaseDateLabel("2026-07-29.2")).toBe("2026년 7월 29일");
    // Unparseable ids fall back to the raw id rather than garbling.
    expect(releaseDateLabel("v-next")).toBe("v-next");
  });
});
