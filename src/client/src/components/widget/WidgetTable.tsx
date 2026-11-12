// A widget's <table>. With `sortable`, each column header is a button that
// cycles ascending → descending → the document's own order.
//
// The sort is the VIEWER's view of this one drawn table: it lives here, not
// in the widget's state (so nothing is stored, and a <submit> never sends
// it), it orders a COPY of the rows the document produced, and it survives a
// re-evaluation for as long as the columns stay the same.
import { useState } from "react";

import type { WidgetColumn } from "../../../../shared/widget/index";
import { cx, useAction } from "../../lib/hooks";
import { enter, rowSteps, type EntranceRule } from "../../lib/uiEntrance";
import { ariaSort, columnsSignature, nextSort, sortHint, sortRows, type TableSort } from "../../lib/widgetTable";
import { cellText } from "../../lib/widgetView";

export interface WidgetTableProps {
  columns?: WidgetColumn[];
  rows?: Record<string, unknown>[];
  sortable?: boolean;
  caption?: string;
  /** How the rows may arrive when the table appears now (`WidgetCtx.entrance`); a sort never moves them. */
  entrance?: EntranceRule | null;
  entranceKey?: string;
}

const NO_COLUMNS: WidgetColumn[] = [];
const NO_ROWS: Record<string, unknown>[] = [];
const MARK: Record<string, string> = { ascending: "▲", descending: "▼", none: "" };

function cell(row: Record<string, unknown>, key: string): string {
  return Object.prototype.hasOwnProperty.call(row, key) ? cellText(row[key]) : "";
}

export default function WidgetTable({ columns = NO_COLUMNS, rows = NO_ROWS, sortable = false, caption = "", entrance = null, entranceKey = "" }: WidgetTableProps) {
  const [sortState, setSort] = useState<TableSort | null>(null);
  // Before `shown`: a table whose columns changed starts unsorted.
  const nextSignature = columnsSignature(columns);
  const [signature, setSignature] = useState(nextSignature);
  let sort = sortState;
  if (nextSignature !== signature) {
    setSignature(nextSignature);
    setSort(null);
    sort = null;
  }

  // A sort on a column that is no longer sortable (or on a table that stopped being sortable) does not apply.
  const active = sortable && sort && columns.some((col) => col.key === sort?.key && col.sortable) ? sort : null;
  const shown = sortRows(rows, active);

  const body = useAction(enter, { rule: entrance, key: entranceKey, steps: rowSteps });

  return (
    <div className="wg-table-wrap">
      <table className="wg-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((col, index) =>
              sortable && col.sortable ? (
                <th key={index} scope="col" className={`wg-align-${col.align} wg-th-sort`} aria-sort={ariaSort(active, col.key)}>
                  <button type="button" className={cx("wg-sort", active?.key === col.key && "active")} title={sortHint(active, col.key)} onClick={() => setSort(nextSort(active, col.key))}>
                    <span>{col.label}</span>
                    <span className="wg-sort-mark" aria-hidden="true">
                      {MARK[ariaSort(active, col.key)]}
                    </span>
                  </button>
                </th>
              ) : (
                <th key={index} scope="col" className={`wg-align-${col.align}`}>
                  {col.label}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody ref={body}>
          {shown.map((row, index) => (
            <tr key={index}>
              {columns.map((col, at) => (
                <td key={at} className={`wg-align-${col.align}`}>
                  {cell(row, col.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
