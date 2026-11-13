import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import GraphCanvas from "../components/GraphCanvas";
import Icon from "../components/Icon";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/format";
import { cx, useAppState, useLatest } from "../lib/hooks";
import { linkifyWikilinks, nodeLinks, sectionColor, sectionLabel, stripFrontmatter, stripTitleHeading, topNotes } from "../lib/knowledgeGraph";
import { goView } from "../lib/nav";
import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgeNote, User } from "../lib/types";
import "./BrainView.css";

// Full-page second-brain graph, one rail item per brain: 내 브레인 (the owner's
// personal knowledge repo, `scope="personal"`) and 팀 브레인 (TeamBrainView →
// `scope="team"`). Pairs the reusable GraphCanvas with a note panel that
// fetches + renders the clicked note's markdown — the richer surface over the
// compact GraphViewModal in settings. The team scope shows the ONE team vault
// read-only: every teammate writes it, but only through their own avatar + a
// chat card, never here.
type Scope = "personal" | "team";
const ENDPOINTS: Record<Scope, { graph: string; note: string }> = {
  personal: { graph: "/api/me/knowledge-repo/graph", note: "/api/me/knowledge-repo/note" },
  team: { graph: "/api/team-brain/graph", note: "/api/team-brain/note" },
};

// The reading pane's width. Nothing stored = the CSS default (`min(51%, 720px)`); a dragged width is px,
// bounded here to what the graph can spare and again by the CSS clamp, so a stale value (a smaller
// window, another monitor) can never squeeze the graph out.
const NOTE_MIN = 320;
const GRAPH_MIN = 320;
const SPLITTER_WIDTH = 16; // `.brain-splitter` (--s-4)
const NOTE_WIDTH_KEY = "noah.brainNoteWidth";

function loadNoteWidth(): number | null {
  try {
    const n = Number(window.localStorage.getItem(NOTE_WIDTH_KEY) ?? NaN);
    return Number.isFinite(n) && n >= NOTE_MIN ? n : null;
  } catch {
    return null;
  }
}
function storeNoteWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(NOTE_WIDTH_KEY);
    else window.localStorage.setItem(NOTE_WIDTH_KEY, String(width));
  } catch {
    /* private mode: the width just won't persist */
  }
}

function dotStyle(section: string): CSSProperties {
  return { "--dot": sectionColor(section) } as CSSProperties;
}

export interface BrainViewProps {
  scope?: Scope;
}

export default function BrainView({ scope = "personal" }: BrainViewProps) {
  const state = useAppState();
  const user = state.user as User;
  // The personal graph/note endpoints 404 without a connected repo.
  const hasRepo = Boolean(user?.knowledgeRepo);
  const showGraph = scope === "team" || hasRepo;
  // What the async functions below read AFTER an await.
  const scopeRef = useLatest(scope);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [graph, setGraphState] = useState<KnowledgeGraph | null>(null);
  // The graph as a note fetch finds it when it resolves.
  const graphRef = useRef<KnowledgeGraph | null>(null);
  function setGraph(next: KnowledgeGraph | null): void {
    graphRef.current = next;
    setGraphState(next);
  }
  const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null);

  const [noteLoading, setNoteLoading] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [noteHtml, setNoteHtml] = useState("");
  // Each bumped on a new fetch so a slow earlier request can't overwrite a newer
  // graph load (refresh) or note selection.
  const graphToken = useRef(0);
  const noteToken = useRef(0);
  // Notes opened from inside the panel (a [[link]], a backlink) stack here so
  // 뒤로 returns to the note you came from; a pick on the canvas starts afresh.
  const [noteHistory, setNoteHistory] = useState<KnowledgeGraphNode[]>([]);
  const noteEl = useRef<HTMLElement | null>(null);

  // One width for both brains (personal and team share this view). `null` = the CSS default.
  const bodyEl = useRef<HTMLDivElement | null>(null);
  const [noteWidth, setNoteWidthState] = useState<number | null>(loadNoteWidth);
  const noteWidthRef = useRef(noteWidth); // the same width, for a drag's pointer listeners
  // What the layout actually gave the pane and the most it may take — the splitter's aria values.
  const [measured, setMeasured] = useState({ width: 0, max: 0 });

  function noteMax(): number {
    const body = bodyEl.current?.getBoundingClientRect().width ?? 0;
    return Math.max(NOTE_MIN, body - GRAPH_MIN - SPLITTER_WIDTH);
  }
  /** The width on screen: the default is CSS-sized, so it has to be measured. */
  function shownNoteWidth(): number {
    return noteEl.current?.getBoundingClientRect().width || noteWidthRef.current || NOTE_MIN;
  }
  function setNoteWidth(width: number | null): void {
    const next = width === null ? null : Math.round(Math.min(noteMax(), Math.max(NOTE_MIN, width)));
    noteWidthRef.current = next;
    setNoteWidthState(next);
  }
  function saveNoteWidth(width: number | null): void {
    setNoteWidth(width);
    storeNoteWidth(noteWidthRef.current);
  }
  function onSplitterPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startW = shownNoteWidth();
    const handle = event.currentTarget;
    // Captured, so the drag keeps its pointer over the graph canvas and outside the window.
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // The pane sits at the right edge → dragging left (smaller clientX) widens it.
      setNoteWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      // A press without a move leaves the default in place.
      if (noteWidthRef.current !== null) storeNoteWidth(noteWidthRef.current);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function onSplitterKeydown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      saveNoteWidth(shownNoteWidth() + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      saveNoteWidth(shownNoteWidth() - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      saveNoteWidth(null);
    } else if (event.key === "End") {
      event.preventDefault();
      saveNoteWidth(noteMax());
    }
  }

  useEffect(() => {
    // Never strand the drag cursor/user-select lock if the view unmounts mid-resize.
    return () => document.body.classList.remove("col-resizing");
  }, []);

  useEffect(() => {
    if (!showGraph || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = { width: shownNoteWidth(), max: noteMax() };
      setMeasured((prev) => (prev.width === next.width && prev.max === next.max ? prev : next));
    });
    if (noteEl.current) observer.observe(noteEl.current);
    if (bodyEl.current) observer.observe(bodyEl.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGraph]);

  const splitterNow = Math.round(measured.width || noteWidth || NOTE_MIN);
  const splitterMax = Math.round(Math.max(measured.max, splitterNow));

  const stats = graph
    ? { notes: graph.nodes.filter((n) => !n.dangling).length, links: graph.edges.length, dangling: graph.nodes.filter((n) => n.dangling).length }
    : null;
  const hubs = graph ? topNotes(graph, 10) : [];
  const links = graph && selected ? nodeLinks(graph, selected.id) : { outgoing: [], incoming: [] };

  useEffect(() => {
    if (!showGraph) {
      setLoading(false);
      return;
    }
    void loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadGraph(): Promise<void> {
    setLoading(true);
    setError("");
    setGraph(null);
    clearNote();
    const token = ++graphToken.current;
    try {
      const res = await api<{ graph: KnowledgeGraph }>(ENDPOINTS[scopeRef.current].graph);
      if (token !== graphToken.current) return;
      setGraph(res.graph);
    } catch (err) {
      if (token !== graphToken.current) return;
      setError((err as Error).message);
    } finally {
      if (token === graphToken.current) setLoading(false);
    }
  }

  function clearNote(): void {
    // Bump the token so any in-flight note fetch is discarded on resolve.
    noteToken.current++;
    setSelected(null);
    setNoteHistory([]);
    setNoteHtml("");
    setNoteError("");
    setNoteLoading(false);
  }

  /** Open a note from inside the panel, remembering where we came from. */
  function openFromPanel(node: KnowledgeGraphNode): void {
    if (selected && selected.id !== node.id) setNoteHistory((history) => [...history, selected]);
    void onSelect(node, true);
  }

  function goBack(): void {
    const prev = noteHistory[noteHistory.length - 1];
    if (!prev) return;
    setNoteHistory((history) => history.slice(0, -1));
    void onSelect(prev, true);
  }

  function openById(id: string): void {
    const node = graph?.nodes.find((n) => n.id === id);
    if (node) openFromPanel(node);
  }

  // Wikilinks in the rendered note are `<button data-wikilink=id>` (linkifyWikilinks).
  function onNoteClick(event: ReactMouseEvent<HTMLElement>): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wikilink]");
    const id = target?.dataset.wikilink;
    if (id) openById(id);
  }

  async function onSelect(node: KnowledgeGraphNode | null, fromPanel = false): Promise<void> {
    if (!fromPanel) setNoteHistory([]);
    setSelected(node);
    if (noteEl.current) noteEl.current.scrollTop = 0;
    setNoteHtml("");
    setNoteError("");
    if (!node || node.dangling) {
      setNoteLoading(false);
      return;
    }
    setNoteLoading(true);
    const token = ++noteToken.current;
    try {
      const res = await api<{ note: KnowledgeNote }>(`${ENDPOINTS[scopeRef.current].note}?path=${encodeURIComponent(node.id)}`);
      if (token !== noteToken.current) return;
      // Team notes are teammate-written: no inline style (overlay / fake-UI guard).
      const body = stripTitleHeading(stripFrontmatter(res.note.content), node.label);
      const currentGraph = graphRef.current;
      setNoteHtml(renderMarkdown(currentGraph ? linkifyWikilinks(body, currentGraph) : body, { forbidInlineStyle: scopeRef.current === "team" }));
    } catch (err) {
      if (token !== noteToken.current) return;
      setNoteError((err as Error).message);
    } finally {
      if (token === noteToken.current) setNoteLoading(false);
    }
  }

  function retrySelectedNote(): void {
    if (selected) void onSelect(selected, true);
  }

  const sectionLabelChip = selected ? (
    <span className="brain-section-label">
      <span className={cx("brain-dot", selected.dangling && "dangling")} style={dotStyle(selected.section)}></span>
      {sectionLabel(selected.section)}
    </span>
  ) : null;

  const linkRow = (n: KnowledgeGraphNode) => (
    <li key={n.id}>
      <button type="button" className="brain-row" onClick={() => openFromPanel(n)}>
        <span className={cx("brain-dot", n.dangling && "dangling")} style={dotStyle(n.section)}></span>{" "}
        <span className="brain-row-label">{n.label}</span>{" "}
        <span className="brain-row-meta">{sectionLabel(n.section)}</span>
      </button>
    </li>
  );

  return (
    <div className="brain-view cmp-brain-view">
      <header className="brain-head">
        <div className="brain-title">
          <h1>{scope === "team" ? "팀 브레인" : "내 브레인"}</h1>
          <p className="muted small">
            {scope === "team" ? (
              <>
                팀원 모두가 함께 읽고 쓰는 공용 위키입니다. 노트 사이의 <code>[[링크]]</code> 연결을 보여주고, 노드를 누르면 내용을 읽을 수 있어요.
              </>
            ) : (
              <>
                내 지식 저장소의 노트 사이 <code>[[링크]]</code> 연결을 보여줍니다. 노드를 누르거나 검색하면 내용과 연결된 노트를 바로 읽을 수 있어요.
              </>
            )}
          </p>
        </div>
        <div className="brain-head-actions">
          {showGraph ? (
            <button
              className="btn secondary sm"
              type="button"
              title="다시 불러오기"
              disabled={loading}
              onClick={() => void loadGraph()}
            >
              <Icon name="refresh" size={15} />
              <span>새로고침</span>
            </button>
          ) : null}
        </div>
      </header>

      {!showGraph ? (
        <section className="brain-empty">
          <span className="brain-empty-icon">
            <Icon name="book" size={24} />
          </span>
          <div>
            <h2>연결된 지식 저장소가 없습니다</h2>
            <p className="muted">지식 저장소를 연결하면 노트 사이의 관계와 내용을 이 화면에서 바로 탐색할 수 있습니다.</p>
          </div>
          <button className="primary" type="button" onClick={() => goView("settings", "knowledge")}>
            지식 저장소 설정
          </button>
        </section>
      ) : (
        <div className="brain-body" ref={bodyEl}>
          <div id="brain-graph-panel" className="brain-graph" aria-busy={loading ? "true" : "false"}>
            {loading ? (
              <div className="brain-state brain-graph-state muted" role="status">
                그래프를 불러오는 중…
              </div>
            ) : error ? (
              <div className="brain-state brain-graph-state error-note" role="alert">
                <span>
                  불러오기 실패: {error}{" "}
                  <button className="linkish small" type="button" disabled={loading} onClick={() => void loadGraph()}>
                    다시 시도
                  </button>
                </span>
              </div>
            ) : graph?.noVault ? (
              <div className="brain-state brain-graph-state muted">
                <span>
                  이 저장소는 아직 세컨드브레인 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게{" "}
                  <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.
                </span>
              </div>
            ) : !graph?.nodes.length ? (
              <div className="brain-state brain-graph-state muted">
                <span>
                  {scope === "team"
                    ? "팀 브레인에 아직 노트가 없습니다. 아바타에게 팀과 나눌 내용을 알려 주고, 아바타가 띄운 카드에서 ‘팀 브레인에 반영’을 누르면 여기에 쌓입니다."
                    : "아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다."}
                </span>
              </div>
            ) : (
              <GraphCanvas graph={graph} selectedId={selected?.id ?? null} onSelect={(node) => void onSelect(node)} />
            )}
            {stats && !loading && !error && graph?.nodes.length ? (
              <div className="brain-stats" aria-label="그래프 요약">
                <span>
                  <strong>{stats.notes}</strong> 노트
                </span>{" "}
                <span>
                  <strong>{stats.links}</strong> 연결
                </span>{" "}
                {stats.dangling ? (
                  <span>
                    <strong>{stats.dangling}</strong> 미연결 링크
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Drag to resize the reading pane; double-click (or Home) returns to the default.
              role="separator" + tabindex + arrow keys IS the WAI-ARIA window-splitter pattern. */}
          <div
            className="brain-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="노트 패널 너비 조절"
            aria-controls="brain-note-panel"
            aria-valuenow={splitterNow}
            aria-valuemin={NOTE_MIN}
            aria-valuemax={splitterMax}
            aria-valuetext={`${splitterNow}px`}
            tabIndex={0}
            title="드래그해서 너비 조절 · 더블클릭으로 초기화"
            onPointerDown={onSplitterPointerDown}
            onKeyDown={onSplitterKeydown}
            onDoubleClick={() => saveNoteWidth(null)}
          >
            <span className="brain-splitter-grip" aria-hidden="true"></span>
          </div>

          <aside
            id="brain-note-panel"
            className="brain-note"
            aria-label="노트 내용"
            ref={noteEl}
            style={noteWidth === null ? undefined : ({ "--brain-note-w": `${noteWidth}px` } as CSSProperties)}
          >
            {selected ? (
              <>
                <div className="brain-note-nav">
                  {noteHistory.length ? (
                    <button
                      className="btn ghost sm"
                      type="button"
                      onClick={goBack}
                      title={`${noteHistory[noteHistory.length - 1].label}(으)로 돌아가기`}
                    >
                      <Icon name="chevron-left" size={15} />
                      <span>뒤로</span>
                    </button>
                  ) : (
                    sectionLabelChip
                  )}
                  <button className="btn ghost icon sm" type="button" aria-label="닫기" title="닫기" onClick={clearNote}>
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <header className="brain-note-head">
                  {noteHistory.length ? sectionLabelChip : null}
                  <h2>{selected.label}</h2>
                  {!selected.dangling ? <code className="brain-note-path">{selected.id}</code> : null}
                  {selected.tags.length ? (
                    <div className="brain-note-tags">
                      {selected.tags.map((tag, index) => (
                        <span className="tag" key={index}>
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </header>

                {selected.dangling ? (
                  <div className="brain-callout muted">
                    아직 이 제목의 노트가 없습니다. 아래 노트들이 이 제목을 <code>[[링크]]</code>로 가리키고 있어요.
                  </div>
                ) : noteLoading ? (
                  <div className="brain-state muted" role="status">
                    노트를 불러오는 중…
                  </div>
                ) : noteError ? (
                  <div className="brain-state error-note" role="alert">
                    불러오기 실패: {noteError}{" "}
                    <button className="linkish small" type="button" disabled={noteLoading} onClick={retrySelectedNote}>
                      다시 시도
                    </button>
                  </div>
                ) : (
                  // Wikilinks render as buttons; clicks are delegated here (keyboard Enter/Space fire click too).
                  <article className="brain-note-body md" onClick={onNoteClick} dangerouslySetInnerHTML={{ __html: noteHtml }} />
                )}

                {links.outgoing.length || links.incoming.length ? (
                  <section className="brain-links" aria-label="연결된 노트">
                    {links.incoming.length ? (
                      <>
                        <h3>
                          이 노트를 가리키는 노트 <span className="brain-count">{links.incoming.length}</span>
                        </h3>
                        <ul className="brain-list">{links.incoming.map(linkRow)}</ul>
                      </>
                    ) : null}
                    {links.outgoing.length ? (
                      <>
                        <h3>
                          이 노트가 링크한 노트 <span className="brain-count">{links.outgoing.length}</span>
                        </h3>
                        <ul className="brain-list">{links.outgoing.map(linkRow)}</ul>
                      </>
                    ) : null}
                  </section>
                ) : null}
              </>
            ) : (
              <>
                {scope === "team" ? (
                  <p className="brain-hint">
                    팀 브레인은 팀원 모두가 함께 쓰는 위키입니다. 아바타에게 “이거 팀 브레인에 올려줘” 또는 “이 페이지 고쳐줘”라고 하면 변경 카드를 만들어
                    주고, 카드의 ‘팀 브레인에 반영’을 누르면 바로 저장됩니다.
                  </p>
                ) : null}
                {hubs.length ? (
                  <section className="brain-hubs" aria-label="주요 노트">
                    <h3>연결이 많은 노트</h3>
                    <p className="brain-hint">노드를 누르거나 검색하면 노트 내용이 여기에 표시됩니다.</p>
                    <ul className="brain-list">
                      {hubs.map(({ node, degree }) => (
                        <li key={node.id}>
                          <button type="button" className="brain-row" onClick={() => void onSelect(node)}>
                            <span className="brain-dot" style={dotStyle(node.section)}></span>{" "}
                            <span className="brain-row-label">{node.label}</span>{" "}
                            <span className="brain-row-meta">연결 {degree}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : scope !== "team" ? (
                  <div className="brain-note-empty muted">
                    <Icon name="book" size={22} />
                    <p>노드를 누르면 노트 내용이 여기에 표시됩니다.</p>
                  </div>
                ) : null}
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
