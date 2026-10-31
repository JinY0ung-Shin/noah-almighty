<script context="module" lang="ts">
  let graphModalSeq = 0;
</script>

<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import GraphCanvas from "./GraphCanvas.svelte";
  import { api } from "../lib/api";
  import { goView } from "../lib/nav";
  import type { KnowledgeGraph, KnowledgeGraphNode } from "../lib/types";

  const dispatch = createEventDispatcher<{ close: void }>();

  // The owner's personal knowledge repo — the only graph (the team brain was
  // removed 2026-10-30, so group repos have none).
  const endpoint = "/api/me/knowledge-repo/graph";

  // Compact graph preview opened from a settings card. The full-page brain view
  // (a left-nav button) is the richer surface — note contents.

  let loading = true;
  let error = "";
  let graph: KnowledgeGraph | null = null;
  let selected: KnowledgeGraphNode | null = null;
  let loadToken = 0;
  let destroyed = false;
  const instanceId = ++graphModalSeq;
  const titleId = `graph-${instanceId}-title`;
  const descId = `graph-${instanceId}-desc`;

  onMount(() => {
    void loadGraph();
    return () => {
      destroyed = true;
    };
  });

  async function loadGraph() {
    const token = ++loadToken;
    loading = true;
    error = "";
    graph = null;
    selected = null;
    try {
      const res = await api<{ graph: KnowledgeGraph }>(endpoint);
      if (!destroyed && token === loadToken) graph = res.graph;
    } catch (err) {
      if (!destroyed && token === loadToken) error = (err as Error).message;
    } finally {
      if (!destroyed && token === loadToken) loading = false;
    }
  }

  function openFullView() {
    dispatch("close");
    goView("brain");
  }
</script>

<Modal cardClass="graph-modal-card" ariaLabelledby={titleId} ariaDescribedby={descId} on:close={() => dispatch("close")}>
  <div class="graph-head">
    <div>
      <h2 id={titleId}>지식 그래프</h2>
      <p class="muted" id={descId}>노트 사이의 <code>[[링크]]</code> 연결을 시각화합니다. 드래그·휠 줌·노드 클릭이 가능합니다.</p>
    </div>
    <div class="graph-head-acts">
      <button class="linkish small" type="button" on:click={openFullView}>전체 화면으로 열기</button>
      <button class="linkish small" type="button" on:click={() => dispatch("close")}>닫기</button>
    </div>
  </div>

  {#if loading}
    <div class="graph-state muted" role="status">그래프를 불러오는 중…</div>
  {:else if error}
    <div class="graph-state error-note" role="alert">
      불러오기 실패: {error}
      <button class="linkish small" type="button" on:click={loadGraph}>다시 시도</button>
    </div>
  {:else if graph?.noVault}
    <div class="graph-state muted" role="status">
      이 저장소는 아직 세컨드브레인 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게
      <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.
    </div>
  {:else if !graph?.nodes.length}
    <div class="graph-state muted" role="status">아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다.</div>
  {:else}
    <GraphCanvas {graph} selectedId={selected?.id ?? null} on:select={(e) => (selected = e.detail)} />
    <div class="graph-footer">
      {#if selected}
        <div class="graph-info">
          <strong>{selected.label}</strong>
          {#if !selected.dangling}<code class="muted">{selected.id}</code>{:else}<span class="muted">미연결 링크 — 이 제목의 노트가 아직 없습니다.</span>{/if}
          {#if selected.tags.length}<span class="muted">#{selected.tags.join(" #")}</span>{/if}
        </div>
      {:else}
        <div class="graph-info muted">{graph.nodes.length}개 노트 · {graph.edges.length}개 연결</div>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .graph-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
    min-width: 0;
  }
  .graph-head > div:first-child {
    min-width: 0;
    flex: 1 1 280px;
  }
  .graph-head h2 {
    overflow-wrap: anywhere;
  }
  .graph-head-acts {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex: 0 1 auto;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .graph-head p {
    margin: var(--s-1) 0 0;
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }
  .graph-state {
    padding: var(--s-6) var(--s-2);
    text-align: center;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .graph-state .linkish.small {
    margin-left: var(--s-2);
  }
  .graph-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .graph-info {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    font-size: var(--t-sm);
    min-width: 0;
    max-width: 100%;
  }
  .graph-info strong,
  .graph-info span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .graph-info code {
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
    white-space: normal;
  }
</style>
