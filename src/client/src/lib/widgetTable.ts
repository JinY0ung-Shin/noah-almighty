// A widget `<table sortable>`: the viewer's own ordering of the rows the
// document produced. It is VIEW state of one drawn table — never widget state,
// never stored, never part of what a `<submit>` sends — and it never touches
// the rows themselves: `sortRows` returns a new array.
import type { WidgetColumn } from "../../../shared/widget/index";

import { cellText } from "./widgetView";

export interface TableSort {
  key: string;
  dir: "asc" | "desc";
}

/** A header click: ascending → descending → the document's own order. */
export function nextSort(sort: TableSort | null, key: string): TableSort | null {
  if (!sort || sort.key !== key) return { key, dir: "asc" };
  return sort.dir === "asc" ? { key, dir: "desc" } : null;
}

/** `aria-sort` of a column header. */
export function ariaSort(sort: TableSort | null, key: string): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

/** What a sortable header says it will do next (its tooltip). */
export function sortHint(sort: TableSort | null, key: string): string {
  const state = ariaSort(sort, key);
  if (state === "ascending") return "오름차순으로 정렬됨 — 누르면 내림차순";
  if (state === "descending") return "내림차순으로 정렬됨 — 누르면 원래 순서";
  return "누르면 오름차순으로 정렬";
}

/**
 * The columns a sort belongs to. While this text is unchanged a re-evaluated
 * table keeps its sort; a different set of columns starts unsorted.
 */
export function columnsSignature(columns: WidgetColumn[]): string {
  return columns.map((col) => `${col.sortable ? "+" : "-"}${col.key}`).join("\u0001");
}

// Korean-aware and digit-aware ("항목 10" after "항목 9"), case-insensitive.
let collator: Intl.Collator | null = null;
function compareText(a: string, b: string): number {
  collator ??= new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
  return collator.compare(a, b);
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
}

/** Numbers numerically (and before text); everything else by its displayed text. */
function compareValues(a: unknown, b: unknown): number {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return (a as number) - (b as number);
  if (an !== bn) return an ? -1 : 1;
  return compareText(cellText(a), cellText(b));
}

/**
 * `rows` ordered by one column — a NEW array; `rows` and its objects are left
 * as they are. Empty cells (missing, null, "") come last in BOTH directions,
 * and equal cells keep the document's order.
 */
export function sortRows(rows: Record<string, unknown>[], sort: TableSort | null): Record<string, unknown>[] {
  if (!sort) return rows;
  const key = sort.key;
  const sign = sort.dir === "asc" ? 1 : -1;
  const keyed = rows.map((row, index) => ({ row, index, value: Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined }));
  keyed.sort((a, b) => {
    const ae = isEmpty(a.value);
    const be = isEmpty(b.value);
    if (ae || be) return ae === be ? a.index - b.index : ae ? 1 : -1;
    return sign * compareValues(a.value, b.value) || a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}
