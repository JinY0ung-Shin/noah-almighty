<script lang="ts">
  import Self from "./ActivityTree.svelte";
  import { agentTitle, openAgentCards, toggleAgentCard } from "../lib/agentCards";
  import type { LiveAgentNode, LiveTaskRow, LiveToolRow } from "../lib/types";

  export let agentId = "main";
  export let agents: LiveAgentNode[];
  export let tools: LiveToolRow[];
  export let tasks: LiveTaskRow[] = [];
  /**
   * Fold each sub-agent card's own rows behind its header. Left unset at the
   * root, which decides for the whole tree: several agents working side by side
   * stack every call into one long scroll, so each card then shows only its
   * latest call until the viewer opens it. A lone agent keeps its rows in view.
   * Nested trees inherit the root's decision.
   */
  export let fold: boolean | undefined = undefined;

  $: folding = fold ?? agents.filter((a) => !a.isMain).length >= 2;
  $: node = agents.find((a) => a.id === agentId);
  $: title = node ? agentTitle(node) : "";
  // kind "memory" rows (second-brain captures) are summary-line chips, not tree
  // rows: they must be visible while the disclosure is COLLAPSED, so ChatView
  // renders them on the <summary> and the tree skips them here.
  $: ownTools = tools.filter(
    (t) => t.agentId === agentId && t.kind !== "task" && t.kind !== "memory",
  );
  $: ownTasks = [
    ...tasks.filter((t) => t.agentId === agentId),
    ...tools
      .filter((t) => t.agentId === agentId && t.kind === "task")
      .map((t) => ({
        id: t.id,
        agentId: t.agentId,
        label: t.label,
        detail: t.detail,
        status: t.status === "failed" ? "failed" : t.status === "running" ? "running" : "done",
      } satisfies LiveTaskRow)),
  ];
  $: children = agents.filter((a) => a.parentId === agentId && !a.isMain);
  // Only a card with rows to hide gets the disclosure: a just-spawned agent has
  // nothing behind a chevron yet.
  $: foldable = folding && !!node && !node.isMain && ownTools.length + ownTasks.length > 0;
  $: open = !foldable || $openAgentCards.has(agentId);
  $: latestTool = ownTools[ownTools.length - 1];
  $: latestTask = ownTasks[ownTasks.length - 1];
  $: rowCount = [
    ownTools.length ? `도구 ${ownTools.length}개` : "",
    ownTasks.length ? `태스크 ${ownTasks.length}개` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const statusLabels: Record<string, string> = {
    running: "진행 중",
    done: "완료",
    failed: "실패",
    blocked: "승인 대기",
  };

  function rowLabel(kind: string, label: string, status: string, detail = ""): string {
    return [kind, label, statusLabels[status] || status, detail].filter(Boolean).join(" · ");
  }
  // kind "compact" (a context compaction) shares the tool-row rendering but is
  // not a tool call — so its accessible name must not announce it as one.
  function toolRowKind(kind: string): string {
    return kind === "compact" ? "맥락" : "도구";
  }
</script>

{#snippet taskRow(row: LiveTaskRow)}
  <div class="task-row" data-status={row.status} role="listitem" title={rowLabel("태스크", row.label || "작업", row.status, row.detail || "")} aria-label={rowLabel("태스크", row.label || "작업", row.status, row.detail || "")}>
    <span class="task-spinner"></span>
    <span class="task-badge">태스크</span>
    {#if row.label}<span class="task-name">{row.label}</span>{/if}
    {#if row.detail}<span class="task-detail">{row.detail}</span>{/if}
  </div>
{/snippet}

{#snippet toolRow(row: LiveToolRow)}
  {@const kindName = toolRowKind(row.kind)}
  <div class={`tool-row ${row.kind === "blocked" ? "blocked" : ""}`} data-status={row.status} role="listitem" title={rowLabel(kindName, row.label, row.status, row.detail || "")} aria-label={rowLabel(kindName, row.label, row.status, row.detail || "")}>
    {#if row.status === "blocked"}
      <span class="tool-dot"></span>
    {:else}
      <span class="tool-spinner"></span>
    {/if}
    <span class="tool-name">{row.label}</span>
    {#if row.detail}<span class="tool-arg">{row.detail}</span>{/if}
  </div>
{/snippet}

{#if node}
  <div
    class={`agent-node ${node.isMain ? "is-main" : "sub"}`}
    data-status={node.status}
    role={node.isMain ? undefined : "listitem"}
    aria-label={node.isMain ? undefined : rowLabel(node.background ? "백그라운드 에이전트" : "에이전트", title, node.status)}
  >
    {#if !node.isMain}
      {#if foldable}
        <!-- An explicit name: the text content would carry the badge's
             decorative ◆ and miss the run status the listitem announces. -->
        <button
          type="button"
          class="agent-head agent-toggle"
          aria-expanded={open}
          aria-label={rowLabel(node.background ? "백그라운드 에이전트" : "에이전트", title, node.status, rowCount)}
          title={open ? "접기" : "펼치기"}
          on:click={() => toggleAgentCard(agentId)}
        >
          <span class="agent-spinner"></span>
          <span class="agent-badge">에이전트</span>
          {#if node.background}<span class="agent-bg-badge">백그라운드</span>{/if}
          {#if node.name}<span class="agent-name">@{node.name}</span>{/if}
          <span class="agent-label">{node.label}</span>
          <span class="agent-meta">
            <span class="agent-count">{rowCount}</span>
            <span class="agent-chevron" aria-hidden="true"></span>
          </span>
        </button>
      {:else}
        <div class="agent-head">
          <span class="agent-spinner"></span>
          <span class="agent-badge">에이전트</span>
          {#if node.background}<span class="agent-bg-badge">백그라운드</span>{/if}
          {#if node.name}<span class="agent-name">@{node.name}</span>{/if}
          <span class="agent-label">{node.label}</span>
        </div>
      {/if}
    {/if}
    {#if open}
      {#if ownTasks.length}
        <div class="agent-tasks" role="list" aria-label={`${title} 태스크`}>
          {#each ownTasks as row (row.id)}
            {@render taskRow(row)}
          {/each}
        </div>
      {/if}
      {#if ownTools.length}
        <div class="agent-tools" role="list" aria-label={`${title} 도구 실행`}>
          {#each ownTools as row (row.id)}
            {@render toolRow(row)}
          {/each}
        </div>
      {/if}
    {:else if latestTool}
      <!-- Folded: the card's most recent call stands in for its whole list. -->
      <div class="agent-tools" role="list" aria-label={`${title} 최근 도구 실행`}>
        {@render toolRow(latestTool)}
      </div>
    {:else if latestTask}
      <div class="agent-tasks" role="list" aria-label={`${title} 최근 태스크`}>
        {@render taskRow(latestTask)}
      </div>
    {/if}
    {#if children.length}
      <div class="agent-children" role="list" aria-label={`${title} 하위 에이전트`}>
        {#each children as child (child.id)}
          <Self agentId={child.id} {agents} {tools} {tasks} fold={folding} />
        {/each}
      </div>
    {/if}
  </div>
{/if}
