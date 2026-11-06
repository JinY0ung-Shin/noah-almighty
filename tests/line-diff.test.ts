import { describe, expect, it } from "vitest";

import { collapseUnchanged, diffLines, splitLines } from "../src/shared/lineDiff.js";

const kinds = (before: string, after: string) => diffLines(before, after).lines.map((l) => `${l.kind}:${l.text}`);

describe("splitLines", () => {
  it("normalizes CRLF and ignores one trailing newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
  });
});

describe("diffLines", () => {
  it("returns only same lines for identical text", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.fallback).toBe(false);
    expect(d.lines.every((l) => l.kind === "same")).toBe(true);
  });

  it("finds a minimal edit with deletions before additions", () => {
    expect(kinds("a\nb\nc\nd", "a\nB\nc\nd\ne")).toEqual(["same:a", "del:b", "add:B", "same:c", "same:d", "add:e"]);
  });

  it("numbers lines on both sides", () => {
    const d = diffLines("x\ny\nz", "x\nz\nw");
    expect(d.lines).toEqual([
      { kind: "same", text: "x", oldNo: 1, newNo: 1 },
      { kind: "del", text: "y", oldNo: 2, newNo: null },
      { kind: "same", text: "z", oldNo: 3, newNo: 2 },
      { kind: "add", text: "w", oldNo: null, newNo: 3 },
    ]);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
  });

  it("handles empty sides", () => {
    expect(kinds("", "a\nb")).toEqual(["add:a", "add:b"]);
    expect(kinds("a\nb", "")).toEqual(["del:a", "del:b"]);
    expect(diffLines("", "").lines).toEqual([]);
  });

  it("keeps the LCS across interleaved changes", () => {
    const d = diffLines("1\n2\n3\n4\n5\n6", "1\n3\n4\nX\n6\n7");
    expect(d.lines.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["1", "3", "4", "6"]);
    expect(d.removed).toBe(2);
    expect(d.added).toBe(2);
  });

  it("falls back to whole-before / whole-after beyond the bound, keeping the common edges", () => {
    const before = ["head", ...Array.from({ length: 30 }, (_, i) => `old ${i}`), "tail"].join("\n");
    const after = ["head", ...Array.from({ length: 30 }, (_, i) => `new ${i}`), "tail"].join("\n");
    const d = diffLines(before, after, { maxLines: 10 });
    expect(d.fallback).toBe(true);
    expect(d.lines[0]).toMatchObject({ kind: "same", text: "head" });
    expect(d.lines[d.lines.length - 1]).toMatchObject({ kind: "same", text: "tail" });
    expect(d.lines.slice(1, 31).every((l) => l.kind === "del")).toBe(true);
    expect(d.lines.slice(31, 61).every((l) => l.kind === "add")).toBe(true);
    expect(d.removed).toBe(30);
    expect(d.added).toBe(30);
  });

  it("falls back on the cell bound too", () => {
    const d = diffLines("a\nb\nc", "x\ny\nz", { maxCells: 4 });
    expect(d.fallback).toBe(true);
    expect(d.removed).toBe(3);
    expect(d.added).toBe(3);
  });

  it("diffs 2000-line pages without falling back", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i % 100 === 50 ? `${l} changed` : l));
    const d = diffLines(before.join("\n"), after.join("\n"));
    expect(d.fallback).toBe(false);
    expect(d.removed).toBe(20);
    expect(d.added).toBe(20);
  });
});

describe("collapseUnchanged", () => {
  it("keeps context around changes and folds the rest into skip markers", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const after = before.replace("l10", "L10");
    const items = collapseUnchanged(diffLines(before, after).lines, 2);
    expect(items[0]).toEqual({ kind: "skip", count: 8 });
    expect(items.slice(1, -1).map((i) => (i.kind === "skip" ? "skip" : `${i.kind}:${i.text}`))).toEqual([
      "same:l8",
      "same:l9",
      "del:l10",
      "add:L10",
      "same:l11",
      "same:l12",
    ]);
    expect(items[items.length - 1]).toEqual({ kind: "skip", count: 7 });
  });

  it("shows a lone hidden line instead of a one-line skip", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "G"].join("\n");
    const items = collapseUnchanged(diffLines(before, after).lines, 2);
    expect(items.some((i) => i.kind === "skip")).toBe(false);
  });

  it("folds a no-change diff into one skip", () => {
    expect(collapseUnchanged(diffLines("a\nb\nc", "a\nb\nc").lines)).toEqual([{ kind: "skip", count: 3 }]);
  });
});
