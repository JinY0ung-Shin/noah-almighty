import { useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import GraphCanvas from "./GraphCanvas";
import { api } from "../lib/api";
import { goView } from "../lib/nav";
import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";
import "./GraphViewModal.css";

let graphModalSeq = 0;

export interface GraphViewModalProps {
  onClose?: () => void;
}

// The owner's personal knowledge repo — the only graph (the team brain was
// removed 2026-10-30, so group repos have none).
const endpoint = "/api/me/knowledge-repo/graph";

// Compact graph preview opened from a settings card. The full-page brain view
// (a left-nav button) is the richer surface — note contents.
//
// It renders <Modal>, so the parent renders it inside <Presence> with a key.
export default function GraphViewModal({ onClose }: GraphViewModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selected, setSelected] = useState<KnowledgeGraphNode | null>(null);
  const loadToken = useRef(0);
  const destroyed = useRef(false);
  const [instanceId] = useState(() => ++graphModalSeq);
  const titleId = `graph-${instanceId}-title`;
  const descId = `graph-${instanceId}-desc`;

  useEffect(() => {
    destroyed.current = false;
    void loadGraph();
    return () => {
      destroyed.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadGraph() {
    const token = ++loadToken.current;
    setLoading(true);
    setError("");
    setGraph(null);
    setSelected(null);
    try {
      const res = await api<{ graph: KnowledgeGraph }>(endpoint);
      if (!destroyed.current && token === loadToken.current) setGraph(res.graph);
    } catch (err) {
      if (!destroyed.current && token === loadToken.current) setError((err as Error).message);
    } finally {
      if (!destroyed.current && token === loadToken.current) setLoading(false);
    }
  }

  function openFullView() {
    onClose?.();
    goView("brain");
  }

  return (
    <Modal cardClass="graph-modal-card" ariaLabelledby={titleId} ariaDescribedby={descId} onClose={() => onClose?.()}>
      <div className="graph-head cmp-graph-view-modal">
        <div>
          <h2 id={titleId}>지식 그래프</h2>
          <p className="muted" id={descId}>
            노트 사이의 <code>[[링크]]</code> 연결을 시각화합니다. 드래그·휠 줌·노드 클릭이 가능합니다.
          </p>
        </div>
        <div className="graph-head-acts">
          <button className="linkish small" type="button" onClick={openFullView}>
            전체 화면으로 열기
          </button>
          <button className="linkish small" type="button" onClick={() => onClose?.()}>
            닫기
          </button>
        </div>
      </div>

      {loading ? (
        <div className="graph-state muted cmp-graph-view-modal" role="status">
          그래프를 불러오는 중…
        </div>
      ) : error ? (
        <div className="graph-state error-note cmp-graph-view-modal" role="alert">
          불러오기 실패: {error}{" "}
          <button className="linkish small" type="button" onClick={() => void loadGraph()}>
            다시 시도
          </button>
        </div>
      ) : graph?.noVault ? (
        <div className="graph-state muted cmp-graph-view-modal" role="status">
          이 저장소는 아직 세컨드브레인 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게{" "}
          <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.
        </div>
      ) : !graph?.nodes.length ? (
        <div className="graph-state muted cmp-graph-view-modal" role="status">
          아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다.
        </div>
      ) : (
        <>
          <GraphCanvas graph={graph} selectedId={selected?.id ?? null} onSelect={(node) => setSelected(node)} />
          <div className="graph-footer cmp-graph-view-modal">
            {selected ? (
              <div className="graph-info">
                <strong>{selected.label}</strong>{" "}
                {!selected.dangling ? (
                  <code className="muted">{selected.id}</code>
                ) : (
                  <span className="muted">미연결 링크 — 이 제목의 노트가 아직 없습니다.</span>
                )}{" "}
                {selected.tags.length ? <span className="muted">#{selected.tags.join(" #")}</span> : null}
              </div>
            ) : (
              <div className="graph-info muted">
                {graph.nodes.length}개 노트 · {graph.edges.length}개 연결
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
