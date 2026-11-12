import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { StylesheetJson } from "cytoscape";
import Icon from "./Icon";
import { useLatest, useStore } from "../lib/hooks";
import { prefersReducedMotion } from "../lib/motion";
import { cssColor, cssToken, currentTheme, theme } from "../lib/theme";
import type { ResolvedTheme } from "../lib/theme";
import { SECTION_COLORS, SECTION_ORDER, nodeDegrees, sectionColor, sectionLabel } from "../lib/knowledgeGraph";
import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";
import "./GraphCanvas.css";

// Reusable interactive knowledge-graph canvas (Obsidian-style). Renders a
// `[[wikilink]]` {graph} with cytoscape, which is lazy-imported as its own
// Vite chunk (kept out of the main bundle) and is CSP-safe — canvas rendering,
// no eval/Function. Both GraphViewModal (settings) and BrainView (full page)
// embed this; the parent owns fetching + the selected-note panel and listens
// through `onSelect`. Mirrors CanvasTab's lazy-lib pattern.
//
// Legibility rules: only the most-linked notes carry a label at rest (every
// label at once is an unreadable pile in a dense cluster); zooming in, hovering
// or selecting reveals the rest. Hover/selection dims everything outside the
// node's neighborhood. The search box is also the keyboard route to every node.

export interface GraphCanvasProps {
  graph: KnowledgeGraph;
  // Id of the externally-selected node, so the parent can keep the highlight in
  // sync (e.g. when it clears the side panel). `null` = nothing selected.
  selectedId?: string | null;
  onSelect?: (node: KnowledgeGraphNode | null) => void;
}

// Above this zoom every label shows; below it only hubs + the focused neighborhood.
const LABEL_ZOOM = 1.35;
// A graph this small labels every node.
const LABEL_ALL_MAX_NODES = 20;

function countSections(nodes: KnowledgeGraphNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const s = n.section in SECTION_COLORS ? n.section : "other";
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return counts;
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

export default function GraphCanvas({ graph, selectedId = null, onSelect }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The ONE cytoscape instance of the graph on screen. It lives in a ref — a
  // re-render never touches it — and `cyEpoch` goes up each time a new one is
  // created, which is what makes the effects below look at it again.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cyRef = useRef<any>(null);
  const [cyEpoch, setCyEpoch] = useState(0);
  // The graph reference currently rendered, so a new non-empty `graph` re-inits
  // (rather than showing the stale one) even if the parent swaps it in place.
  const renderedGraph = useRef<KnowledgeGraph | undefined>(undefined);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const renderToken = useRef(0);
  const hoverId = useRef<string | null>(null);
  // The id the user just tapped on the canvas: the parent echoes it back as
  // `selectedId`, and a tap must not pan the view the way a search pick does.
  const tappedId = useRef<string | null>(null);
  const zoomedIn = useRef(false);
  // Label geometry multiplier: below 1× zoom labels grow by 1/zoom so they keep
  // reading at ~11px on screen (cytoscape scales text with the canvas). Quantized,
  // so the stylesheet is rebuilt only when a step is crossed.
  const labelScale = useRef(1);
  const scaleFrame = useRef(0);
  // Theme the live graph is currently styled for. cytoscape bakes stylesheet
  // colors in at creation, so a `data-theme` flip would otherwise strand the
  // graph on the old palette; `fromJson().update()` swaps them in place, which
  // keeps the cose layout and the viewer's pan/zoom instead of remounting.
  const styledTheme = useRef<ResolvedTheme | null>(null);
  const currentThemeValue = useStore(theme);

  // What the cytoscape listeners (registered once per instance) read later.
  const selectedIdRef = useLatest(selectedId);
  const onSelectRef = useLatest(onSelect);

  const nodeList = graph?.nodes ?? [];
  const degrees = graph ? nodeDegrees(graph) : new Map<string, number>();
  const sectionCounts = countSections(nodeList);
  const presentSections = SECTION_ORDER.filter((s) => sectionCounts.has(s));
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(() => new Set());
  // A new graph (refresh, scope switch) starts with every section shown.
  const [seenGraph, setSeenGraph] = useState(graph);
  if (seenGraph !== graph) {
    setSeenGraph(graph);
    if (graph) setHiddenSections(new Set());
  }
  const hiddenSectionsRef = useLatest(hiddenSections);

  // ---- Search (combobox): the keyboard route to any node ----
  const [searchId] = useState(() => `graph-search-${Math.random().toString(36).slice(2, 8)}`);
  const [query, setQuery] = useState("");
  const [activeIndexState, setActiveIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const matches = searchNodes(nodeList, degrees, query);
  if (activeIndexState >= matches.length && activeIndexState !== 0) setActiveIndex(0);
  const activeIndex = activeIndexState >= matches.length ? 0 : activeIndexState;

  // Everything below that talks to cytoscape reads refs only, so a function
  // captured by a listener at init keeps working across re-renders.

  function restyleGraph(next: ResolvedTheme): void {
    styledTheme.current = next;
    cyRef.current?.style().fromJson(buildStyle(next === "dark", labelScale.current)).update();
  }

  function syncSelection(id: string | null): void {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements(":selected").unselect();
      if (id) cy.getElementById(id).select();
    });
    if (!hoverId.current) applyFocus(id);
    if (id && id !== tappedId.current) revealNode(id);
    tappedId.current = null;
  }

  /** Dim everything outside `id`'s neighborhood (or clear the dimming for `null`). */
  function applyFocus(id: string | null): void {
    const cy = cyRef.current;
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
    const cy = cyRef.current;
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
    const cy = cyRef.current;
    cy.batch(() => {
      cy.nodes().forEach((n: { data(k: string): string; toggleClass(c: string, on: boolean): void }) => {
        const s = n.data("section");
        n.toggleClass("section-hidden", hidden.has(s in SECTION_COLORS ? s : "other"));
      });
    });
  }

  function toggleSection(section: string): void {
    setHiddenSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  function updateZoomLabels(): void {
    const cy = cyRef.current;
    if (!cy) return;
    const scale = Math.min(2.5, Math.round(Math.max(1, 1 / cy.zoom()) * 10) / 10);
    if (scale !== labelScale.current) {
      labelScale.current = scale;
      cy.style().fromJson(buildStyle(styledTheme.current === "dark", scale)).update();
    }
    const next = cy.zoom() >= LABEL_ZOOM;
    if (next === zoomedIn.current) return;
    zoomedIn.current = next;
    cy.batch(() => {
      if (next) cy.nodes().addClass("zoomed");
      else cy.nodes().removeClass("zoomed");
    });
  }

  function zoomBy(factor: number): void {
    const cy = cyRef.current;
    if (!cy) return;
    const level = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * factor));
    const renderedPosition = { x: cy.width() / 2, y: cy.height() / 2 };
    if (prefersReducedMotion()) cy.zoom({ level, renderedPosition });
    else cy.animate({ zoom: { level, renderedPosition } }, { duration: 180, easing: "ease-out-cubic" });
  }

  function fitAll(): void {
    const cy = cyRef.current;
    if (!cy) return;
    const eles = cy.elements(":visible");
    if (prefersReducedMotion()) cy.fit(eles, 56);
    else cy.animate({ fit: { eles, padding: 56 } }, { duration: 260, easing: "ease-out-cubic" });
  }

  async function initCy(g: KnowledgeGraph, container: HTMLDivElement): Promise<void> {
    const token = ++renderToken.current;
    setGraphLoading(true);
    setGraphError("");
    try {
      const cytoscape = (await import("cytoscape")).default;
      if (!containerRef.current || token !== renderToken.current) return; // unmounted or replaced while the chunk loaded

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
      styledTheme.current = currentTheme();
      zoomedIn.current = false;
      labelScale.current = 1;
      cyRef.current = cytoscape({
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
        style: buildStyle(styledTheme.current === "dark"),
      });
      const cy = cyRef.current;
      // The selection / hidden-section / theme effects run again for the new instance.
      setCyEpoch((epoch) => epoch + 1);

      cy.on("tap", "node", (evt: { target: { id(): string } }) => {
        tappedId.current = evt.target.id();
        onSelectRef.current?.(nodeById.get(evt.target.id()) ?? null);
      });
      cy.on("tap", (evt: { target: unknown }) => {
        if (evt.target === cy) onSelectRef.current?.(null);
      });
      cy.on("mouseover", "node", (evt: { target: { id(): string } }) => {
        hoverId.current = evt.target.id();
        applyFocus(hoverId.current);
        container.style.cursor = "pointer";
      });
      cy.on("mouseout", "node", () => {
        hoverId.current = null;
        applyFocus(selectedIdRef.current);
        container.style.cursor = "";
      });
      // One label update per frame, however many zoom events a wheel burst fires.
      cy.on("zoom", () => {
        if (scaleFrame.current) return;
        scaleFrame.current = requestAnimationFrame(() => {
          scaleFrame.current = 0;
          updateZoomLabels();
        });
      });
      updateZoomLabels();
      applyHiddenSections(hiddenSectionsRef.current);
      syncSelection(selectedIdRef.current);
    } catch (err) {
      if (token !== renderToken.current) return;
      setGraphError((err as Error).message || "그래프 렌더러를 불러오지 못했습니다.");
    } finally {
      if (token === renderToken.current) setGraphLoading(false);
    }
  }

  function retryRender(): void {
    const containerEl = containerRef.current;
    if (!containerEl || !graph) return;
    cyRef.current?.destroy();
    cyRef.current = null;
    renderedGraph.current = graph;
    void initCy(graph, containerEl);
  }

  // The effects are declared in the order they must run (effects run in
  // declaration order): (re)init, hidden sections, selection, theme.

  // (Re)init whenever the container is mounted and the non-empty graph changes.
  // No dependency list: `renderedGraph` is the "did it change" guard, so a
  // re-render with the same graph never recreates the instance.
  useEffect(() => {
    const containerEl = containerRef.current;
    if (containerEl && graph && graph.nodes.length && graph !== renderedGraph.current) {
      cyRef.current?.destroy();
      cyRef.current = null;
      renderedGraph.current = graph;
      void initCy(graph, containerEl);
    }
  });

  useEffect(() => {
    if (cyRef.current) applyHiddenSections(hiddenSections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenSections, cyEpoch]);

  // Keep the cytoscape selection in sync with the parent's `selectedId` (e.g.
  // when the parent clears the panel or selects from outside the canvas).
  useEffect(() => {
    if (cyRef.current) syncSelection(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, cyEpoch]);

  useEffect(() => {
    if (cyRef.current && styledTheme.current && styledTheme.current !== currentThemeValue) restyleGraph(currentThemeValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentThemeValue, cyEpoch]);

  // cytoscape's default autoResize binds only the WINDOW resize event, so a
  // container-only size change (desktop rail collapse, note-panel toggle) leaves
  // the canvas at its stale dimensions. Observe the container and re-fit.
  useEffect(() => {
    const containerEl = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    if (containerEl && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => cyRef.current?.resize());
      resizeObserver.observe(containerEl);
    }
    return () => {
      renderToken.current++;
      if (scaleFrame.current) cancelAnimationFrame(scaleFrame.current);
      scaleFrame.current = 0;
      resizeObserver?.disconnect();
      resizeObserver = null;
      cyRef.current?.destroy();
      cyRef.current = null;
      // Were the effects ever set up again on this instance (a dev hot reload),
      // the init effect above must build a fresh graph.
      renderedGraph.current = undefined;
    };
  }, []);

  function pick(node: KnowledgeGraphNode): void {
    // A hidden section would hide the pick: show it again.
    const s = node.section in SECTION_COLORS ? node.section : "other";
    if (hiddenSections.has(s)) toggleSection(s);
    setQuery("");
    setSearchOpen(false);
    tappedId.current = null;
    onSelect?.(node);
  }

  function onSearchKey(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault();
      setSearchOpen(true);
      setActiveIndex((activeIndex + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault();
      setSearchOpen(true);
      setActiveIndex((activeIndex - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" && matches[activeIndex]) {
      event.preventDefault();
      pick(matches[activeIndex]);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  }

  return (
    <>
      <div className="graph-shell cmp-graph-canvas">
        <div
          className="graph-cy"
          ref={containerRef}
          role="group"
          aria-label={`지식 그래프: 노트 ${nodeList.length}개, 연결 ${graph?.edges.length ?? 0}개`}
        ></div>

        {graphLoading ? (
          <div className="graph-overlay muted" role="status">
            그래프를 렌더링하는 중…
          </div>
        ) : graphError ? (
          <div className="graph-overlay error-note" role="alert">
            <span>
              그래프를 표시하지 못했습니다: {graphError}{" "}
              <button className="linkish small" type="button" onClick={retryRender}>
                다시 시도
              </button>
            </span>
          </div>
        ) : null}

        <div className="graph-toolbar">
          <div className="graph-search">
            <span className="graph-search-icon">
              <Icon name="search" size={15} />
            </span>
            <input
              type="search"
              placeholder="노트 검색"
              aria-label="노트 검색"
              role="combobox"
              aria-autocomplete="list"
              aria-controls={`${searchId}-list`}
              aria-expanded={searchOpen && query.trim() ? "true" : "false"}
              aria-activedescendant={searchOpen && matches[activeIndex] ? `${searchId}-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setSearchOpen(true);
                setActiveIndex(0);
              }}
              onFocus={() => setSearchOpen(true)}
              onBlur={() => setSearchOpen(false)}
              onKeyDown={onSearchKey}
            />
            {searchOpen && query.trim() ? (
              <ul className="graph-search-results" id={`${searchId}-list`} role="listbox" aria-label="검색 결과">
                {matches.length ? (
                  matches.map((node, i) => (
                    <li
                      key={node.id}
                      id={`${searchId}-${i}`}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={i === activeIndex ? "active" : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        pick(node);
                      }}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <span
                        className={node.dangling ? "legend-dot dangling" : "legend-dot"}
                        style={{ "--dot": sectionColor(node.section) } as CSSProperties}
                      ></span>{" "}
                      <span className="graph-search-label">{node.label}</span>{" "}
                      <span className="graph-search-meta">{sectionLabel(node.section)}</span>
                    </li>
                  ))
                ) : (
                  <li className="graph-search-empty" role="presentation">
                    일치하는 노트가 없습니다.
                  </li>
                )}
              </ul>
            ) : null}
          </div>
          <div className="graph-zoom" role="group" aria-label="확대/축소">
            <button className="btn ghost icon sm" type="button" title="확대" aria-label="확대" onClick={() => zoomBy(1.3)}>
              <Icon name="plus" size={16} />
            </button>
            <button className="btn ghost icon sm" type="button" title="축소" aria-label="축소" onClick={() => zoomBy(1 / 1.3)}>
              <Icon name="minus" size={16} />
            </button>
            <button className="btn ghost icon sm" type="button" title="전체 보기" aria-label="전체 보기" onClick={fitAll}>
              <Icon name="maximize" size={15} />
            </button>
          </div>
        </div>
      </div>

      {presentSections.length ? (
        <div className="graph-legend cmp-graph-canvas" role="group" aria-label="섹션 필터">
          {presentSections.map((s) => (
            <button
              key={s}
              type="button"
              className={hiddenSections.has(s) ? "legend-chip off" : "legend-chip"}
              aria-pressed={hiddenSections.has(s) ? "false" : "true"}
              title={hiddenSections.has(s) ? `${sectionLabel(s)} 보이기` : `${sectionLabel(s)} 숨기기`}
              onClick={() => toggleSection(s)}
            >
              <span
                className={s === "unresolved" ? "legend-dot dangling" : "legend-dot"}
                style={{ "--dot": sectionColor(s) } as CSSProperties}
              ></span>{" "}
              <span>{sectionLabel(s)}</span>{" "}
              <span className="legend-count">{sectionCounts.get(s)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
