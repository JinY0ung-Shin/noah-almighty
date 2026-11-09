<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import type { StylesheetJson } from "cytoscape";
  import Icon from "./Icon.svelte";
  import { prefersReducedMotion } from "../lib/motion";
  import { cssColor, cssToken, currentTheme, theme } from "../lib/theme";
  import type { ResolvedTheme } from "../lib/theme";
  import { SECTION_COLORS, SECTION_ORDER, nodeDegrees, sectionColor, sectionLabel } from "../lib/knowledgeGraph";
  import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";

  // Reusable interactive knowledge-graph canvas (Obsidian-style). Renders a
  // `[[wikilink]]` {graph} with cytoscape, which is lazy-imported as its own
  // Vite chunk (kept out of the main bundle) and is CSP-safe — canvas rendering,
  // no eval/Function. Both GraphViewModal (settings) and BrainView (full page)
  // embed this; the parent owns fetching + the selected-note panel and listens
  // for the `select` event. Mirrors CanvasTab's lazy-lib pattern.
  //
  // Legibility rules: only the most-linked notes carry a label at rest (every
  // label at once is an unreadable pile in a dense cluster); zooming in, hovering
  // or selecting reveals the rest. Hover/selection dims everything outside the
  // node's neighborhood. The search box is also the keyboard route to every node.

  export let graph: KnowledgeGraph;
  // Id of the externally-selected node, so the parent can keep the highlight in
  // sync (e.g. when it clears the side panel). `null` = nothing selected.
  export let selectedId: string | null = null;

  const dispatch = createEventDispatcher<{ select: KnowledgeGraphNode | null }>();

  // Above this zoom every label shows; below it only hubs + the focused neighborhood.
  const LABEL_ZOOM = 1.35;
  // A graph this small labels every node.
  const LABEL_ALL_MAX_NODES = 20;

  let containerEl: HTMLDivElement | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cy: any = null;
  // The graph reference currently rendered, so a new non-empty `graph` re-inits
  // (rather than showing the stale one) even if the parent swaps it in place.
  let renderedGraph: KnowledgeGraph | undefined;
  let graphLoading = false;
  let graphError = "";
  let renderToken = 0;
  let hoverId: string | null = null;
  // The id the user just tapped on the canvas: the parent echoes it back as
  // `selectedId`, and a tap must not pan the view the way a search pick does.
  let tappedId: string | null = null;
  let zoomedIn = false;
  // Label geometry multiplier: below 1× zoom labels grow by 1/zoom so they keep
  // reading at ~11px on screen (cytoscape scales text with the canvas). Quantized,
  // so the stylesheet is rebuilt only when a step is crossed.
  let labelScale = 1;
  let scaleFrame = 0;

  $: nodeList = graph?.nodes ?? [];
  $: degrees = graph ? nodeDegrees(graph) : new Map<string, number>();
  $: sectionCounts = countSections(nodeList);
  $: presentSections = SECTION_ORDER.filter((s) => sectionCounts.has(s));
  let hiddenSections = new Set<string>();
  // A new graph (refresh, scope switch) starts with every section shown.
  $: if (graph) hiddenSections = new Set();
  $: if (cy) applyHiddenSections(hiddenSections);

  function countSections(nodes: KnowledgeGraphNode[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const s = n.section in SECTION_COLORS ? n.section : "other";
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return counts;
  }

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
    cy?.style().fromJson(buildStyle(next === "dark", labelScale)).update();
  }

  function buildStyle(dark: boolean, scale = 1): StylesheetJson {
    // Every chrome color is read live from the design tokens so the canvas sits on
    // the same surface as the panel around it; the fallbacks only matter before
    // the stylesheet loads. Colors go through `cssColor`: the minified build's
    // `#rrggbbaa` is invalid to cytoscape, which then paints black label boxes.
    const surface = cssColor("--panel", dark ? "#1c1c1e" : "#ffffff");
    const text = cssColor("--text", dark ? "#f5f5f7" : "#1d1d1f");
    const muted = cssColor("--muted", dark ? "#98989d" : "#6e6e73");
    const edge = cssColor("--line", dark ? "#3a3a3c" : "#d2d2d7");
    const accent = cssColor("--accent", "#0071e3");
    const font = cssToken("--font-sans", "system-ui, sans-serif");
    return [
      {
        selector: "node",
        style: {
          label: "",
          width: "data(size)",
          height: "data(size)",
          "border-width": 2,
          "border-color": surface,
          "font-family": font,
          "font-size": 11 * scale,
          color: text,
          "text-valign": "bottom",
          "text-halign": "center",
          "text-margin-y": 4 * scale,
          "text-wrap": "ellipsis",
          "text-max-width": `${140 * scale}px`,
          "text-background-color": surface,
          "text-background-opacity": 0.88,
          "text-background-padding": `${2 * scale}px`,
          "text-background-shape": "roundrectangle",
          "min-zoomed-font-size": 8,
          "transition-property": "opacity",
          "transition-duration": prefersReducedMotion() ? 0 : 150,
        },
      },
      ...Object.entries(SECTION_COLORS).map(([section, color]) => ({
        selector: `node[section = "${section}"]`,
        style: { "background-color": color },
      })),
      {
        selector: 'node[section = "unresolved"]',
        style: { "background-opacity": 0, "border-width": 1.5, "border-color": muted, "border-style": "dashed" },
      },
      {
        selector: "node.hub, node.zoomed, node.focus",
        style: { label: "data(label)" },
      },
      { selector: "node.hub", style: { "font-weight": 600 } },
      {
        selector: "edge",
        style: {
          width: 1,
          "line-color": edge,
          "curve-style": "straight",
          opacity: 0.7,
          "transition-property": "opacity",
          "transition-duration": prefersReducedMotion() ? 0 : 150,
        },
      },
      {
        selector: "edge.focus",
        style: {
          width: 1.75,
          "line-color": accent,
          opacity: 1,
          "target-arrow-shape": "triangle",
          "target-arrow-color": accent,
          "arrow-scale": 0.8,
          "z-index": 10,
        },
      },
      { selector: "node.faded", style: { opacity: 0.18, label: "" } },
      { selector: "edge.faded", style: { opacity: 0.08 } },
      { selector: "node.focus-center", style: { "font-size": 12.5 * scale, "font-weight": 700, "z-index": 20 } },
      { selector: "node:selected", style: { "border-width": 3, "border-color": accent, "border-style": "solid" } },
      { selector: ".section-hidden", style: { display: "none" } },
    ];
  }

  function syncSelection(id: string | null): void {
    if (!cy) return;
    cy.batch(() => {
      cy.elements(":selected").unselect();
      if (id) cy.getElementById(id).select();
    });
    if (!hoverId) applyFocus(id);
    if (id && id !== tappedId) revealNode(id);
    tappedId = null;
  }

  /** Dim everything outside `id`'s neighborhood (or clear the dimming for `null`). */
  function applyFocus(id: string | null): void {
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("faded focus focus-center");
      if (!id) return;
      const node = cy.getElementById(id);
      if (node.empty()) return;
      const hood = node.closedNeighborhood();
      cy.elements().not(hood).addClass("faded");
      hood.addClass("focus");
      node.addClass("focus-center");
    });
  }

  /** Pan (and zoom in, if far out) so a node picked outside the canvas is on screen. */
  function revealNode(id: string): void {
    const node = cy?.getElementById(id);
    if (!node || node.empty() || node.hasClass("section-hidden")) return;
    const pos = node.renderedPosition();
    const margin = 48;
    const onScreen = pos.x > margin && pos.y > margin && pos.x < cy.width() - margin && pos.y < cy.height() - margin;
    if (onScreen && cy.zoom() >= 0.8) return;
    const target = { center: { eles: node }, zoom: Math.max(cy.zoom(), 1) };
    if (prefersReducedMotion()) {
      cy.zoom(target.zoom);
      cy.center(node);
    } else {
      cy.animate(target, { duration: 260, easing: "ease-out-cubic" });
    }
  }

  function applyHiddenSections(hidden: Set<string>): void {
    cy.batch(() => {
      cy.nodes().forEach((n: { data(k: string): string; toggleClass(c: string, on: boolean): void }) => {
        const s = n.data("section");
        n.toggleClass("section-hidden", hidden.has(s in SECTION_COLORS ? s : "other"));
      });
    });
  }

  function toggleSection(section: string): void {
    const next = new Set(hiddenSections);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    hiddenSections = next;
  }

  function updateZoomLabels(): void {
    if (!cy) return;
    const scale = Math.min(2.5, Math.round(Math.max(1, 1 / cy.zoom()) * 10) / 10);
    if (scale !== labelScale) {
      labelScale = scale;
      cy.style().fromJson(buildStyle(styledTheme === "dark", scale)).update();
    }
    const next = cy.zoom() >= LABEL_ZOOM;
    if (next === zoomedIn) return;
    zoomedIn = next;
    cy.batch(() => {
      if (next) cy.nodes().addClass("zoomed");
      else cy.nodes().removeClass("zoomed");
    });
  }

  function zoomBy(factor: number): void {
    if (!cy) return;
    const level = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    const renderedPosition = { x: cy.width() / 2, y: cy.height() / 2 };
    if (prefersReducedMotion()) cy.zoom({ level, renderedPosition });
    else cy.animate({ zoom: { level, renderedPosition } }, { duration: 180, easing: "ease-out-cubic" });
  }

  function fitAll(): void {
    if (!cy) return;
    const eles = cy.elements(":visible");
    if (prefersReducedMotion()) cy.fit(eles, 56);
    else cy.animate({ fit: { eles, padding: 56 } }, { duration: 260, easing: "ease-out-cubic" });
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
    if (scaleFrame) cancelAnimationFrame(scaleFrame);
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
      const degree = nodeDegrees(g);
      const maxDegree = Math.max(1, ...degree.values());
      // Hubs: the most-linked notes keep their label at rest.
      const ranked = g.nodes
        .filter((n) => !n.dangling)
        .map((n) => ({ id: n.id, d: degree.get(n.id) ?? 0 }))
        .sort((a, b) => b.d - a.d);
      const hubCount = Math.min(20, Math.max(8, Math.round(g.nodes.length * 0.2)));
      const hubs = new Set(
        g.nodes.length <= LABEL_ALL_MAX_NODES
          ? g.nodes.map((n) => n.id)
          : ranked.slice(0, hubCount).filter((r) => r.d >= 2).map((r) => r.id),
      );
      const elements = [
        ...g.nodes.map((n) => {
          const d = degree.get(n.id) ?? 0;
          // Area grows with links, so a hub reads as a hub without dwarfing the rest.
          const size = n.dangling ? 10 : Math.round(12 + 20 * Math.sqrt(d / maxDegree));
          return { data: { id: n.id, label: n.label, section: n.section, size }, classes: hubs.has(n.id) ? "hub" : "" };
        }),
        ...g.edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target } })),
      ];

      // Read the theme AFTER the await: it may have flipped while the chunk loaded.
      styledTheme = currentTheme();
      zoomedIn = false;
      labelScale = 1;
      cy = cytoscape({
        container,
        elements,
        minZoom: 0.15,
        maxZoom: 3.5,
        layout: {
          name: "cose",
          animate: false,
          // Clears the floating search/zoom bar along the top edge.
          padding: 56,
          nodeRepulsion: () => 14000,
          idealEdgeLength: () => 90,
          nodeOverlap: 16,
          gravity: 0.3,
          componentSpacing: 80,
          numIter: 1500,
        },
        style: buildStyle(styledTheme === "dark"),
      });

      cy.on("tap", "node", (evt: { target: { id(): string } }) => {
        tappedId = evt.target.id();
        dispatch("select", nodeById.get(evt.target.id()) ?? null);
      });
      cy.on("tap", (evt: { target: unknown }) => {
        if (evt.target === cy) dispatch("select", null);
      });
      cy.on("mouseover", "node", (evt: { target: { id(): string } }) => {
        hoverId = evt.target.id();
        applyFocus(hoverId);
        container.style.cursor = "pointer";
      });
      cy.on("mouseout", "node", () => {
        hoverId = null;
        applyFocus(selectedId);
        container.style.cursor = "";
      });
      // One label update per frame, however many zoom events a wheel burst fires.
      cy.on("zoom", () => {
        if (scaleFrame) return;
        scaleFrame = requestAnimationFrame(() => {
          scaleFrame = 0;
          updateZoomLabels();
        });
      });
      updateZoomLabels();
      applyHiddenSections(hiddenSections);
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

  // ---- Search (combobox): the keyboard route to any node ----
  const searchId = `graph-search-${Math.random().toString(36).slice(2, 8)}`;
  let query = "";
  let activeIndex = 0;
  let searchOpen = false;
  $: matches = searchNodes(nodeList, degrees, query);
  $: if (activeIndex >= matches.length) activeIndex = 0;

  function searchNodes(nodes: KnowledgeGraphNode[], deg: Map<string, number>, q: string): KnowledgeGraphNode[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return nodes
      .filter((n) => n.label.toLowerCase().includes(needle) || (!n.dangling && n.id.toLowerCase().includes(needle)) || n.tags.some((t) => t.toLowerCase().includes(needle)))
      .sort((a, b) => {
        const ap = a.label.toLowerCase().startsWith(needle) ? 0 : 1;
        const bp = b.label.toLowerCase().startsWith(needle) ? 0 : 1;
        return ap - bp || (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0) || a.label.localeCompare(b.label, "ko");
      })
      .slice(0, 8);
  }

  function pick(node: KnowledgeGraphNode): void {
    // A hidden section would hide the pick: show it again.
    const s = node.section in SECTION_COLORS ? node.section : "other";
    if (hiddenSections.has(s)) toggleSection(s);
    query = "";
    searchOpen = false;
    tappedId = null;
    dispatch("select", node);
  }

  function onSearchKey(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault();
      searchOpen = true;
      activeIndex = (activeIndex + 1) % matches.length;
    } else if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault();
      searchOpen = true;
      activeIndex = (activeIndex - 1 + matches.length) % matches.length;
    } else if (event.key === "Enter" && matches[activeIndex]) {
      event.preventDefault();
      pick(matches[activeIndex]);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      query = "";
    }
  }
</script>

<div class="graph-shell">
  <div class="graph-cy" bind:this={containerEl} role="group" aria-label={`지식 그래프: 노트 ${nodeList.length}개, 연결 ${graph?.edges.length ?? 0}개`}></div>

  {#if graphLoading}
    <div class="graph-overlay muted" role="status">그래프를 렌더링하는 중…</div>
  {:else if graphError}
    <div class="graph-overlay error-note" role="alert">
      <span>
        그래프를 표시하지 못했습니다: {graphError}
        <button class="linkish small" type="button" on:click={retryRender}>다시 시도</button>
      </span>
    </div>
  {/if}

  <div class="graph-toolbar">
    <div class="graph-search">
      <span class="graph-search-icon"><Icon name="search" size={15} /></span>
      <input
        type="search"
        placeholder="노트 검색"
        aria-label="노트 검색"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={`${searchId}-list`}
        aria-expanded={searchOpen && query.trim() ? "true" : "false"}
        aria-activedescendant={searchOpen && matches[activeIndex] ? `${searchId}-${activeIndex}` : undefined}
        bind:value={query}
        on:input={() => { searchOpen = true; activeIndex = 0; }}
        on:focus={() => (searchOpen = true)}
        on:blur={() => (searchOpen = false)}
        on:keydown={onSearchKey}
      />
      {#if searchOpen && query.trim()}
        <ul class="graph-search-results" id={`${searchId}-list`} role="listbox" aria-label="검색 결과">
          {#each matches as node, i (node.id)}
            <li
              id={`${searchId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              class:active={i === activeIndex}
              on:mousedown|preventDefault={() => pick(node)}
              on:mouseenter={() => (activeIndex = i)}
            >
              <span class="legend-dot" class:dangling={node.dangling} style={`--dot:${sectionColor(node.section)}`}></span>
              <span class="graph-search-label">{node.label}</span>
              <span class="graph-search-meta">{sectionLabel(node.section)}</span>
            </li>
          {:else}
            <li class="graph-search-empty" role="presentation">일치하는 노트가 없습니다.</li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="graph-zoom" role="group" aria-label="확대/축소">
      <button class="btn ghost icon sm" type="button" title="확대" aria-label="확대" on:click={() => zoomBy(1.3)}><Icon name="plus" size={16} /></button>
      <button class="btn ghost icon sm" type="button" title="축소" aria-label="축소" on:click={() => zoomBy(1 / 1.3)}><Icon name="minus" size={16} /></button>
      <button class="btn ghost icon sm" type="button" title="전체 보기" aria-label="전체 보기" on:click={fitAll}><Icon name="maximize" size={15} /></button>
    </div>
  </div>

</div>

{#if presentSections.length}
  <div class="graph-legend" role="group" aria-label="섹션 필터">
      {#each presentSections as s (s)}
        <button
          type="button"
          class="legend-chip"
          class:off={hiddenSections.has(s)}
          aria-pressed={hiddenSections.has(s) ? "false" : "true"}
          title={hiddenSections.has(s) ? `${sectionLabel(s)} 보이기` : `${sectionLabel(s)} 숨기기`}
          on:click={() => toggleSection(s)}
        >
          <span class="legend-dot" class:dangling={s === "unresolved"} style={`--dot:${sectionColor(s)}`}></span>
          <span>{sectionLabel(s)}</span>
          <span class="legend-count">{sectionCounts.get(s)}</span>
        </button>
      {/each}
  </div>
{/if}

<style>
  .graph-shell {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--line-soft);
    border-radius: var(--r-lg);
    background: var(--panel);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .graph-cy {
    position: absolute;
    inset: 0;
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

  /* Floating controls sit on small opaque plates so they read over any part of the graph. */
  .graph-toolbar {
    position: absolute;
    top: var(--s-3);
    left: var(--s-3);
    right: var(--s-3);
    z-index: 2;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-2);
    pointer-events: none;
  }
  .graph-toolbar > * {
    pointer-events: auto;
  }
  .graph-search {
    position: relative;
    flex: 0 1 280px;
    min-width: 0;
  }
  .graph-search-icon {
    position: absolute;
    left: var(--s-2-5);
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    color: var(--muted);
    pointer-events: none;
  }
  .graph-search input {
    width: 100%;
    height: 34px;
    /* Clears the leading search glyph (15px icon at --s-2-5) plus a gap. */
    padding: 0 var(--s-3) 0 calc(var(--s-2-5) + 15px + var(--s-2));
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    background: var(--panel);
    color: var(--text);
    font-size: var(--t-sm);
    box-shadow: var(--shadow-sm);
  }
  .graph-search-results {
    position: absolute;
    top: calc(100% + var(--s-1));
    left: 0;
    width: max(100%, 260px);
    max-width: calc(100vw - 2 * var(--s-5));
    z-index: var(--z-popover);
    list-style: none;
    margin: 0;
    padding: var(--s-1);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
    background: var(--panel);
    box-shadow: var(--shadow-md);
  }
  .graph-search-results li {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-1-5) var(--s-2);
    border-radius: var(--r-xs);
    font-size: var(--t-sm);
    cursor: pointer;
  }
  .graph-search-results li.active {
    background: var(--accent-soft);
    color: var(--accent-strong);
  }
  .graph-search-results li.graph-search-empty {
    color: var(--muted);
    cursor: default;
  }
  .graph-search-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .graph-search-meta {
    flex: none;
    font-size: var(--t-2xs);
    color: var(--muted);
  }
  .graph-zoom {
    display: flex;
    gap: var(--s-0-5);
    padding: var(--s-0-5);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    box-shadow: var(--shadow-sm);
  }

  /* Below the canvas, not over it: an overlay legend hid the nodes cose parks at the bottom. */
  .graph-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  .legend-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1-5);
    min-height: 28px;
    padding: 0 var(--s-2-5);
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    background: var(--panel);
    color: var(--text-soft);
    font-size: var(--t-xs);
    font-weight: 600;
    cursor: pointer;
  }
  .legend-chip:hover {
    border-color: var(--accent-soft-strong);
  }
  .legend-chip.off {
    color: var(--muted);
    background: transparent;
    border-style: dashed;
  }
  .legend-chip.off > span:not(.legend-dot) {
    text-decoration: line-through;
  }
  .legend-chip.off .legend-dot {
    opacity: 0.35;
  }
  .legend-count {
    font-weight: 400;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .legend-dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    background: var(--dot);
  }
  .legend-dot.dangling {
    background: transparent;
    border: 1.5px dashed var(--muted);
  }

  @media (max-width: 560px) {
    .graph-search {
      flex-basis: 100%;
    }
    .legend-chip {
      min-height: 26px;
      padding: 0 var(--s-2);
    }
  }
</style>
