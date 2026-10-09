<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import type { StylesheetJson } from "cytoscape";
  import { cssToken, currentTheme, theme } from "../lib/theme";
  import type { ResolvedTheme } from "../lib/theme";
  import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";

  // Reusable interactive knowledge-graph canvas (Obsidian-style). Renders a
  // `[[wikilink]]` {graph} with cytoscape, which is lazy-imported as its own
  // Vite chunk (kept out of the main bundle) and is CSP-safe — canvas rendering,
  // no eval/Function. Both GraphViewModal (settings) and BrainView (full page)
  // embed this; the parent owns fetching + the selected-note panel and listens
  // for the `select` event. Mirrors CanvasTab's lazy-lib pattern.

  export let graph: KnowledgeGraph;
  // Id of the externally-selected node, so the parent can keep the highlight in
  // sync (e.g. when it clears the side panel). `null` = nothing selected.
  export let selectedId: string | null = null;

  const dispatch = createEventDispatcher<{ select: KnowledgeGraphNode | null }>();

  // Vault-section colors (chosen to read on both light and dark themes).
  // DELIBERATE token-system exemption: this is a categorical data-viz palette
  // encoding a node's section, not UI chrome. It needs 8 mutually distinguishable
  // hues, which the semantic token set doesn't provide — so it stays raw hex and
  // stays theme-independent (the same hue must mean the same section in both).
  const SECTION_COLORS: Record<string, string> = {
    raw: "#f59e0b",
    sources: "#3b82f6",
    entities: "#10b981",
    concepts: "#8b5cf6",
    synthesis: "#ef4444",
    wiki: "#64748b",
    other: "#94a3b8",
    unresolved: "#cbd5e1",
  };
  const SECTION_LABELS: Record<string, string> = {
    raw: "raw (캡처)",
    sources: "sources",
    entities: "entities",
    concepts: "concepts",
    synthesis: "synthesis",
    wiki: "wiki",
    other: "기타",
    unresolved: "미연결 링크",
  };

  let containerEl: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cy: any = null;
  // The graph reference currently rendered, so a new non-empty `graph` re-inits
  // (rather than showing the stale one) even if the parent swaps it in place.
  let renderedGraph: KnowledgeGraph | undefined;
  let graphLoading = false;
  let graphError = "";
  let renderToken = 0;

  $: presentSections = graph
    ? [...new Set(graph.nodes.map((n) => n.section))].filter((s) => s in SECTION_COLORS)
    : [];
  $: nodeList = graph?.nodes ?? [];
  $: selectedNode = selectedId ? nodeList.find((node) => node.id === selectedId) ?? null : null;

  // (Re)init whenever the container is mounted and the non-empty graph changes.
  $: if (containerEl && graph && graph.nodes.length && graph !== renderedGraph) {
    cy?.destroy();
    cy = null;
    renderedGraph = graph;
    void initCy(graph, containerEl);
  }

  // Keep the cytoscape selection in sync with the parent's `selectedId` (e.g.
  // when the parent clears the panel or selects from outside the canvas).
  $: if (cy) syncSelection(selectedId);

  // Theme the live graph is currently styled for. cytoscape bakes stylesheet
  // colors in at creation, so a `data-theme` flip would otherwise strand the
  // graph on the old palette; `fromJson().update()` swaps them in place, which
  // keeps the cose layout and the viewer's pan/zoom instead of remounting.
  let styledTheme: ResolvedTheme | null = null;
  $: if (cy && styledTheme && styledTheme !== $theme) restyleGraph($theme);

  function restyleGraph(next: ResolvedTheme): void {
    styledTheme = next;
    cy?.style().fromJson(buildStyle(next === "dark")).update();
  }

  function buildStyle(dark: boolean): StylesheetJson {
    const labelColor = dark ? "#e5e7eb" : "#1e293b";
    const edgeColor = dark ? "#475569" : "#cbd5e1";
    // Selection ring = the design accent, read live so it follows the theme.
    return [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "font-size": 9,
          color: labelColor,
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 3,
          "min-zoomed-font-size": 7,
          width: 14,
          height: 14,
          "border-width": 0,
        },
      },
      ...Object.entries(SECTION_COLORS).map(([section, color]) => ({
        selector: `node[section = "${section}"]`,
        style: { "background-color": color },
      })),
      {
        selector: 'node[section = "unresolved"]',
        style: { "background-opacity": 0.25, "border-width": 1, "border-color": edgeColor, "border-style": "dashed" },
      },
      {
        selector: "edge",
        style: { width: 1, "line-color": edgeColor, "curve-style": "haystack", opacity: 0.6 },
      },
      { selector: "node:selected", style: { "border-width": 3, "border-color": cssToken("--accent", "#0f766e") } },
    ];
  }

  function syncSelection(id: string | null): void {
    if (!cy) return;
    cy.batch(() => {
      cy.elements(":selected").unselect();
      if (id) cy.getElementById(id).select();
    });
  }

  // cytoscape's default autoResize binds only the WINDOW resize event, so a
  // container-only size change (desktop rail collapse, note-panel toggle) leaves
  // the canvas at its stale dimensions. Observe the container and re-fit.
  let resizeObserver: ResizeObserver | null = null;
  $: if (containerEl && !resizeObserver && typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => cy?.resize());
    resizeObserver.observe(containerEl);
  }

  onDestroy(() => {
    renderToken++;
    resizeObserver?.disconnect();
    resizeObserver = null;
    cy?.destroy();
    cy = null;
  });

  async function initCy(g: KnowledgeGraph, container: HTMLDivElement): Promise<void> {
    const token = ++renderToken;
    graphLoading = true;
    graphError = "";
    try {
      const cytoscape = (await import("cytoscape")).default;
      if (!containerEl || token !== renderToken) return; // unmounted or replaced while the chunk loaded

      const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
      const elements = [
        ...g.nodes.map((n) => ({ data: { id: n.id, label: n.label, section: n.section } })),
        ...g.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target } })),
      ];

      // Read the theme AFTER the await: it may have flipped while the chunk loaded.
      styledTheme = currentTheme();
      cy = cytoscape({
        container,
        elements,
        layout: { name: "cose", animate: false, padding: 30, nodeRepulsion: 8000, idealEdgeLength: 80 },
        style: buildStyle(styledTheme === "dark"),
      });

      cy.on("tap", "node", (evt: { target: { id(): string } }) => {
        dispatch("select", nodeById.get(evt.target.id()) ?? null);
      });
      cy.on("tap", (evt: { target: unknown }) => {
        if (evt.target === cy) dispatch("select", null);
      });

      syncSelection(selectedId);
    } catch (err) {
      if (token !== renderToken) return;
      graphError = (err as Error).message || "그래프 렌더러를 불러오지 못했습니다.";
    } finally {
      if (token === renderToken) graphLoading = false;
    }
  }

  function retryRender(): void {
    if (!containerEl || !graph) return;
    cy?.destroy();
    cy = null;
    renderedGraph = graph;
    void initCy(graph, containerEl);
  }

  function selectNode(node: KnowledgeGraphNode): void {
    dispatch("select", node);
    syncSelection(node.id);
  }
</script>

<div class="graph-canvas" bind:this={containerEl} role="group" aria-label={`지식 그래프: 노트 ${nodeList.length}개, 연결 ${graph?.edges.length ?? 0}개`}>
  {#if graphLoading}
    <div class="graph-overlay muted">그래프를 렌더링하는 중…</div>
  {:else if graphError}
    <div class="graph-overlay error-note">
      그래프를 표시하지 못했습니다: {graphError}
      <button class="linkish small" type="button" on:click={retryRender}>다시 시도</button>
    </div>
  {/if}
</div>
<div class="graph-legend">
  {#each presentSections as s}
    <span class="legend-chip">
      <span class="legend-dot" style={`background:${SECTION_COLORS[s]}`}></span>{SECTION_LABELS[s] ?? s}
    </span>
  {/each}
</div>
{#if nodeList.length}
  <div class="graph-node-strip" aria-label="그래프 노트 목록">
    {#each nodeList as node (node.id)}
      <button
        class="graph-node-chip"
        class:active={selectedNode?.id === node.id}
        type="button"
        aria-pressed={selectedNode?.id === node.id ? "true" : "false"}
        title={`${node.label} · ${SECTION_LABELS[node.section] ?? node.section}`}
        on:click={() => selectNode(node)}
      >
        <span class="legend-dot" style={`background:${SECTION_COLORS[node.section] ?? SECTION_COLORS.other}`}></span>
        <span>{node.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .graph-canvas {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--line-soft);
    border-radius: var(--r-lg);
    background: var(--material-regular, var(--bg));
    box-shadow: var(--shadow-sm), 0 1px 0 var(--material-edge, transparent) inset;
    overflow: hidden;
    position: relative;
  }
  .graph-overlay {
    position: absolute;
    inset: var(--s-3);
    z-index: 1;
    display: grid;
    place-items: center;
    text-align: center;
    pointer-events: none;
  }
  .graph-overlay.error-note {
    pointer-events: auto;
  }
  .graph-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-3);
  }
  .legend-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .legend-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    display: inline-block;
  }
  .graph-node-strip {
    display: flex;
    gap: var(--s-1);
    max-width: 100%;
    overflow-x: auto;
    padding-bottom: var(--s-1);
    scrollbar-width: thin;
  }
  .graph-node-chip {
    flex: 0 0 auto;
    max-width: 220px;
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-pill);
    background: var(--material-thick, var(--panel));
    color: var(--text);
    padding: var(--s-1) var(--s-2);
    font-size: var(--t-xs);
  }
  .graph-node-chip span:last-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .graph-node-chip:hover,
  .graph-node-chip.active {
    border-color: var(--accent-soft-strong);
    background: var(--accent-soft);
    color: var(--accent-strong);
  }
</style>
