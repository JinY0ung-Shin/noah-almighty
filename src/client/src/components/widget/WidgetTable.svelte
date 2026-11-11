<script lang="ts">
  // A widget's <table>. With `sortable`, each column header is a button that
  // cycles ascending → descending → the document's own order.
  //
  // The sort is the VIEWER's view of this one drawn table: it lives here, not
  // in the widget's state (so nothing is stored, and a <submit> never sends
  // it), it orders a COPY of the rows the document produced, and it survives a
  // re-evaluation for as long as the columns stay the same.
  import type { WidgetColumn } from "../../../../shared/widget/index";
  import { enter, rowSteps, type EntranceRule } from "../../lib/uiEntrance";
  import { ariaSort, columnsSignature, nextSort, sortHint, sortRows, type TableSort } from "../../lib/widgetTable";
  import { cellText } from "../../lib/widgetView";

  export let columns: WidgetColumn[] = [];
  export let rows: Record<string, unknown>[] = [];
  export let sortable = false;
  export let caption = "";
  /** How the rows may arrive when the table appears now (`WidgetCtx.entrance`); a sort never moves them. */
  export let entrance: EntranceRule | null = null;
  export let entranceKey = "";

  let sort: TableSort | null = null;
  let signature = "";
  // Before `shown`: a table whose columns changed starts unsorted.
  $: forColumns(columnsSignature(columns));
  function forColumns(next: string): void {
    if (next === signature) return;
    signature = next;
    sort = null;
  }

  // A sort on a column that is no longer sortable (or on a table that stopped being sortable) does not apply.
  $: active = sortable && sort && columns.some((col) => col.key === sort?.key && col.sortable) ? sort : null;
  $: shown = sortRows(rows, active);

  function cell(row: Record<string, unknown>, key: string): string {
    return Object.prototype.hasOwnProperty.call(row, key) ? cellText(row[key]) : "";
  }
  const MARK: Record<string, string> = { ascending: "▲", descending: "▼", none: "" };
</script>

<div class="wg-table-wrap">
  <table class="wg-table">
    {#if caption}<caption>{caption}</caption>{/if}
    <thead>
      <tr>
        {#each columns as col}
          {#if sortable && col.sortable}
            <th scope="col" class={`wg-align-${col.align} wg-th-sort`} aria-sort={ariaSort(active, col.key)}>
              <button type="button" class="wg-sort" class:active={active?.key === col.key} title={sortHint(active, col.key)} on:click={() => (sort = nextSort(active, col.key))}>
                <span>{col.label}</span>
                <span class="wg-sort-mark" aria-hidden="true">{MARK[ariaSort(active, col.key)]}</span>
              </button>
            </th>
          {:else}
            <th scope="col" class={`wg-align-${col.align}`}>{col.label}</th>
          {/if}
        {/each}
      </tr>
    </thead>
    <tbody use:enter={{ rule: entrance, key: entranceKey, steps: rowSteps }}>
      {#each shown as row}
        <tr>
          {#each columns as col}<td class={`wg-align-${col.align}`}>{cell(row, col.key)}</td>{/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
