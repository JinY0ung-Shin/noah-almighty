// lib/widgetTable.ts — the viewer's own ordering of a widget `<table sortable>`.
// It orders a COPY: the rows the document produced are never touched.
import { describe, expect, it } from "vitest";

import { ariaSort, columnsSignature, nextSort, sortHint, sortRows } from "../src/client/src/lib/widgetTable.js";

const key = (rows: Record<string, unknown>[], name = "id") => rows.map((row) => row[name]);

describe("widget table sorting", () => {
  it("a header click cycles ascending → descending → the document's order", () => {
    const asc = nextSort(null, "price");
    expect(asc).toEqual({ key: "price", dir: "asc" });
    const desc = nextSort(asc, "price");
    expect(desc).toEqual({ key: "price", dir: "desc" });
    expect(nextSort(desc, "price")).toBe(null);
    // another column starts over at ascending
    expect(nextSort(desc, "name")).toEqual({ key: "name", dir: "asc" });
    expect([ariaSort(null, "price"), ariaSort(asc, "price"), ariaSort(desc, "price"), ariaSort(asc, "name")]).toEqual(["none", "ascending", "descending", "none"]);
    expect(sortHint(null, "price")).toBe("누르면 오름차순으로 정렬");
    expect(sortHint(asc, "price")).toBe("오름차순으로 정렬됨 — 누르면 내림차순");
    expect(sortHint(desc, "price")).toBe("내림차순으로 정렬됨 — 누르면 원래 순서");
  });

  it("numbers compare numerically, not as text", () => {
    const rows = [{ id: "a", n: 10 }, { id: "b", n: 9 }, { id: "c", n: -2.5 }, { id: "d", n: 100 }];
    expect(key(sortRows(rows, { key: "n", dir: "asc" }))).toEqual(["c", "b", "a", "d"]);
    expect(key(sortRows(rows, { key: "n", dir: "desc" }))).toEqual(["d", "a", "b", "c"]);
  });

  it("text compares with a Korean-aware, digit-aware, case-insensitive collation", () => {
    const rows = [{ id: "다람쥐" }, { id: "가방" }, { id: "나비" }, { id: "apple" }, { id: "Banana" }, { id: "항목 10" }, { id: "항목 9" }];
    expect(key(sortRows(rows, { key: "id", dir: "asc" }))).toEqual(["apple", "Banana", "가방", "나비", "다람쥐", "항목 9", "항목 10"].sort(new Intl.Collator("ko", { numeric: true, sensitivity: "base" }).compare));
    const sorted = key(sortRows(rows, { key: "id", dir: "asc" })) as string[];
    expect(sorted.indexOf("가방")).toBeLessThan(sorted.indexOf("나비"));
    expect(sorted.indexOf("나비")).toBeLessThan(sorted.indexOf("다람쥐"));
    expect(sorted.indexOf("항목 9")).toBeLessThan(sorted.indexOf("항목 10"));
    expect(sorted.indexOf("apple")).toBeLessThan(sorted.indexOf("Banana"));
    // a mixed column: numbers first, then text
    const mixed = [{ id: 1, v: "b" }, { id: 2, v: 3 }, { id: 3, v: "a" }, { id: 4, v: 1 }, { id: 5, v: true }];
    expect(key(sortRows(mixed, { key: "v", dir: "asc" }))).toEqual([4, 2, 3, 1, 5]);
  });

  it("empty cells come last in BOTH directions, in the document's order", () => {
    const rows = [{ id: 1, v: null }, { id: 2, v: 5 }, { id: 3 }, { id: 4, v: "" }, { id: 5, v: 1 }, { id: 6, v: undefined }, { id: 7, v: 0 }, { id: 8, v: NaN }];
    expect(key(sortRows(rows, { key: "v", dir: "asc" }))).toEqual([7, 5, 2, 1, 3, 4, 6, 8]);
    expect(key(sortRows(rows, { key: "v", dir: "desc" }))).toEqual([2, 5, 7, 1, 3, 4, 6, 8]);
    // 0 and false are values, not empty
    expect(key(sortRows([{ id: 1, v: false }, { id: 2, v: null }], { key: "v", dir: "desc" }))).toEqual([1, 2]);
  });

  it("equal cells keep the document's order (in both directions)", () => {
    const rows = [{ id: 1, team: "B" }, { id: 2, team: "A" }, { id: 3, team: "B" }, { id: 4, team: "A" }];
    expect(key(sortRows(rows, { key: "team", dir: "asc" }))).toEqual([2, 4, 1, 3]);
    expect(key(sortRows(rows, { key: "team", dir: "desc" }))).toEqual([1, 3, 2, 4]);
  });

  it("never mutates the rows or the array the interpreter produced", () => {
    const rows = Object.freeze([Object.freeze({ id: 3 }), Object.freeze({ id: 1 }), Object.freeze({ id: 2 })]) as unknown as Record<string, unknown>[];
    const before = JSON.stringify(rows);
    const sorted = sortRows(rows, { key: "id", dir: "asc" });
    expect(key(sorted)).toEqual([1, 2, 3]);
    expect(sorted).not.toBe(rows);
    expect(JSON.stringify(rows)).toBe(before);
    // the same row OBJECTS, only reordered
    expect(sorted[0]).toBe(rows[1]);
    // unsorted is the document's own array
    expect(sortRows(rows, null)).toBe(rows);
  });

  it("a key named like an Object member reads only the row's OWN cell; nested data sorts by its text", () => {
    const rows: Record<string, unknown>[] = [{ id: 1, constructor: "b" }, { id: 2 }, { id: 3, constructor: "a" }];
    expect(key(sortRows(rows, { key: "constructor", dir: "asc" }))).toEqual([3, 1, 2]);
    expect(key(sortRows([{ id: 1, v: { b: 1 } }, { id: 2, v: [0] }], { key: "v", dir: "asc" }))).toEqual([2, 1]);
  });

  it("a sort belongs to its columns: the signature changes with the keys and their sortable flags, not with labels", () => {
    const cols = [
      { key: "a", label: "A", align: "start" as const, sortable: true },
      { key: "b", label: "B", align: "end" as const, sortable: false },
    ];
    const sig = columnsSignature(cols);
    expect(columnsSignature(cols.map((c) => ({ ...c, label: `${c.label}!`, align: "center" as const })))).toBe(sig);
    expect(columnsSignature([cols[1], cols[0]])).not.toBe(sig);
    expect(columnsSignature([cols[0]])).not.toBe(sig);
    expect(columnsSignature([cols[0], { ...cols[1], sortable: true }])).not.toBe(sig);
  });
});
