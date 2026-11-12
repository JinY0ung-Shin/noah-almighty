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
import { openSeededChat } from "../lib/chat";
import { goView } from "../lib/nav";
import { refreshTeamBrainStatus } from "../lib/teamBrain";
import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgeNote, User } from "../lib/types";
import { TEAM_PAGE_TYPE_LABELS, type TeamBrainProposal } from "../../../shared/teamBrain";
import "./BrainView.css";

// Full-page second-brain graph, one rail item per brain: 내 브레인 (the owner's
// personal knowledge repo, `scope="personal"`) and 팀 브레인 (TeamBrainView →
// `scope="team"`). Pairs the reusable GraphCanvas with a note panel that
// fetches + renders the clicked note's markdown — the richer surface over the
// compact GraphViewModal in settings. The team scope shows the ONE team vault
// read-only and — with no note selected — my proposals' status and, for an
// admin, the pending queue; its 검토 시작 hands one proposal to the admin's own
// avatar (decisions still go through the avatar + a card, never here).
type Scope = "personal" | "team";
const ENDPOINTS: Record<Scope, { graph: string; note: string }> = {
  personal: { graph: "/api/me/knowledge-repo/graph", note: "/api/me/knowledge-repo/note" },
  team: { graph: "/api/team-brain/graph", note: "/api/team-brain/note" },
};
type ProposalRow = Omit<TeamBrainProposal, "content">;

// Status → `.tag` tone (docs/DESIGN.md §4.3): text AND colour, never colour alone.
const STATUS_TONE: Record<string, string> = { approved: "ok", rejected: "danger", pending: "read", needs_info: "write" };

const STATUS_KO: Record<string, string> = {
  draft: "제출 전",
  pending: "검토 대기",
  approved: "승인됨",
  rejected: "반려됨",
  needs_info: "보완 요청",
  withdrawn: "철회됨",
  expired: "만료됨",
};

// 검토 시작: a new chat with the admin's OWN avatar, its composer seeded with a
// review request (not sent — the admin presses 보내기). Only the server-minted
// id goes into the text: the title is teammate-written and would otherwise
// reach the admin's avatar as the admin's own instruction.
function startReview(p: ProposalRow): void {
  void openSeededChat(
    `팀 브레인 제안 ${p.id} 를 검토해줘. team-brain-curate 절차대로 내용을 확인하고 위키 페이지로 정리한 뒤, 승인·보완 요청·반려 중 무엇을 추천하는지 이유와 함께 알려줘.`,
    "입력창에 검토 요청을 준비했습니다. 보내기를 누르면 아바타가 검토를 시작해요.",
  );
}

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
  const isAdmin = Boolean(user?.roles?.includes("admin"));
  // The personal graph/note endpoints 404 without a connected repo.
  const hasRepo = Boolean(user?.knowledgeRepo);
  const showGraph = scope === "team" || hasRepo;
  // What the async functions below read AFTER an await.
  const isAdminRef = useLatest(isAdmin);
  const scopeRef = useLatest(scope);

  const [mine, setMine] = useState<ProposalRow[]>([]);
  const [pending, setPending] = useState<ProposalRow[]>([]);
  const [listsError, setListsError] = useState("");

  async function loadLists(): Promise<void> {
    setListsError("");
    try {
      const [m, p] = await Promise.all([
        api<{ proposals: ProposalRow[] }>("/api/team-brain/proposals/mine"),
        isAdminRef.current ? api<{ proposals: ProposalRow[] }>("/api/team-brain/proposals/pending") : Promise.resolve({ proposals: [] }),
      ]);
      setMine(m.proposals);
      setPending(p.proposals);
      // Opening my list marked the results seen server-side.
      void refreshTeamBrainStatus();
    } catch (err) {
      setListsError((err as Error).message);
    }
  }

  // A pending proposal can be taken back here too — its card may be gone with its conversation.
  const [withdrawing, setWithdrawingState] = useState("");
  const withdrawingRef = useRef("");
  function setWithdrawing(id: string): void {
    withdrawingRef.current = id;
    setWithdrawingState(id);
  }
  async function withdraw(id: string): Promise<void> {
    if (withdrawingRef.current) return;
    setWithdrawing(id);
    setListsError("");
    try {
      await api(`/api/team-brain/cards/${encodeURIComponent(id)}/withdraw`, { method: "POST" });
      await loadLists();
    } catch (err) {
      setListsError((err as Error).message);
    } finally {
      setWithdrawing("");
    }
  }

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
    if (scope === "team") {
      void loadGraph();
      void loadLists();
      return;
    }
    if (!hasRepo) {
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
                팀원 모두가 읽는 공용 위키입니다. 노트 사이의 <code>[[링크]]</code> 연결을 보여주고, 노드를 누르면 내용을 읽을 수 있어요.
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
              onClick={() => {
                void loadGraph();
                if (scope === "team") void loadLists();
              }}
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
                    ? "팀 브레인에 아직 노트가 없습니다. 대화 중 아바타가 팀에 공유할지 물으면, 동의한 내용이 관리자 승인을 거쳐 여기에 쌓입니다."
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
                  <section className="brain-proposals" aria-label="팀 브레인 제안">
                    <p className="brain-hint">팀 브레인은 팀원이 보낸 원본을 관리자의 아바타가 위키 페이지로 정리하고, 관리자가 승인한 내용입니다.</p>
                    {listsError ? (
                      <p className="error-note" role="alert">
                        {listsError}
                      </p>
                    ) : null}
                    {isAdmin ? (
                      <>
                        <h3>
                          검토 대기 <span className="brain-count">{pending.length}</span>
                        </h3>
                        {pending.length ? (
                          <>
                            <p className="brain-hint">
                              검토 시작을 누르면 내 아바타와의 새 대화에 검토 요청이 준비됩니다. 아바타가 정리한 뒤 띄우는 카드의 버튼으로 승인·보완 요청·반려를 결정합니다.
                            </p>
                            <ul className="brain-list">
                              {pending.map((p) => (
                                <li className="brain-card" key={p.id}>
                                  <div className="brain-card-top">
                                    <strong>{p.title}</strong>{" "}
                                    <span className="tag">
                                      {p.intake ? (p.intake.type ? TEAM_PAGE_TYPE_LABELS[p.intake.type] : "원본") : p.op === "create" ? "새 노트" : "수정"}
                                    </span>
                                  </div>{" "}
                                  <span className="brain-card-meta">
                                    {p.proposerName} · <code>{p.path}</code>
                                  </span>{" "}
                                  {p.summary ? <span className="brain-card-meta">{p.summary}</span> : null}{" "}
                                  <button className="btn secondary sm brain-review-start" type="button" onClick={() => startReview(p)}>
                                    검토 시작
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </>
                        ) : (
                          <p className="brain-hint">검토할 제안이 없습니다.</p>
                        )}
                      </>
                    ) : null}
                    <h3>
                      내 제안 {mine.length ? <span className="brain-count">{mine.length}</span> : null}
                    </h3>
                    {mine.length ? (
                      <ul className="brain-list">
                        {mine.map((p) => (
                          <li className="brain-card" key={p.id}>
                            <div className="brain-card-top">
                              <strong>{p.title}</strong>{" "}
                              <span className={`tag brain-proposal-status status-${p.status} ${STATUS_TONE[p.status] ?? ""}`}>
                                {STATUS_KO[p.status] ?? p.status}
                              </span>
                            </div>{" "}
                            <span className="brain-card-meta">
                              <code>{p.path}</code>
                            </span>{" "}
                            {p.status === "rejected" && p.decisionReason ? <p className="brain-card-reason">반려 사유: {p.decisionReason}</p> : null}{" "}
                            {p.status === "needs_info" ? (
                              <>
                                <p className="brain-card-reason is-ask">관리자의 보완 요청{p.decisionReason ? `: ${p.decisionReason}` : ""}</p>{" "}
                                <p className="brain-hint">대화에서 아바타에게 답을 알려 주면 제안 카드에 반영됩니다. 다시 제출해야 검토가 이어집니다.</p>
                              </>
                            ) : null}{" "}
                            {p.status === "pending" || p.status === "needs_info" ? (
                              <button
                                className="btn ghost sm brain-proposal-withdraw"
                                type="button"
                                disabled={withdrawing === p.id}
                                onClick={() => void withdraw(p.id)}
                              >
                                제안 철회
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="brain-hint">아직 제안한 내용이 없습니다. 대화 중 아바타에게 “이거 팀에 공유해줘”라고 하면 제안 카드를 만들어 줍니다.</p>
                    )}
                  </section>
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
