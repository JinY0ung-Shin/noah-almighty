<script lang="ts">
  import { onMount } from "svelte";
  import GraphCanvas from "../components/GraphCanvas.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { renderMarkdown } from "../lib/format";
  import { goView } from "../lib/nav";
  import { appState } from "../lib/state";
  import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgeNote, User } from "../lib/types";

  // Full-page second-brain graph of the owner's personal knowledge repo, reached
  // from the left nav. Pairs the reusable GraphCanvas with a note panel that
  // fetches + renders the clicked note's markdown — the richer surface over the
  // compact GraphViewModal in settings. (Group repos have no graph: the team
  // brain was removed 2026-10-30.)
  const GRAPH_ENDPOINT = "/api/me/knowledge-repo/graph";
  const NOTE_ENDPOINT = "/api/me/knowledge-repo/note";

  $: user = $appState.user as User;
  // The graph/note endpoints 404 without a connected repo.
  $: hasRepo = Boolean(user?.knowledgeRepo);

  let loading = true;
  let error = "";
  let graph: KnowledgeGraph | null = null;
  let selected: KnowledgeGraphNode | null = null;

  let noteLoading = false;
  let noteError = "";
  let noteHtml = "";
  // Each bumped on a new fetch so a slow earlier request can't overwrite a newer
  // graph load (refresh) or note selection.
  let graphToken = 0;
  let noteToken = 0;

  onMount(() => {
    if (!hasRepo) {
      loading = false;
      return;
    }
    void loadGraph();
  });

  async function loadGraph(): Promise<void> {
    loading = true;
    error = "";
    graph = null;
    clearNote();
    const token = ++graphToken;
    try {
      const res = await api<{ graph: KnowledgeGraph }>(GRAPH_ENDPOINT);
      if (token !== graphToken) return;
      graph = res.graph;
    } catch (err) {
      if (token !== graphToken) return;
      error = (err as Error).message;
    } finally {
      if (token === graphToken) loading = false;
    }
  }

  function clearNote(): void {
    // Bump the token so any in-flight note fetch is discarded on resolve.
    noteToken++;
    selected = null;
    noteHtml = "";
    noteError = "";
    noteLoading = false;
  }

  async function onSelect(node: KnowledgeGraphNode | null): Promise<void> {
    selected = node;
    noteHtml = "";
    noteError = "";
    if (!node || node.dangling) {
      noteLoading = false;
      return;
    }
    noteLoading = true;
    const token = ++noteToken;
    try {
      const res = await api<{ note: KnowledgeNote }>(`${NOTE_ENDPOINT}?path=${encodeURIComponent(node.id)}`);
      if (token !== noteToken) return;
      noteHtml = renderMarkdown(res.note.content);
    } catch (err) {
      if (token !== noteToken) return;
      noteError = (err as Error).message;
    } finally {
      if (token === noteToken) noteLoading = false;
    }
  }

  function retrySelectedNote(): void {
    if (selected) void onSelect(selected);
  }
</script>

<div class="brain-view">
  <header class="brain-head">
    <div class="brain-title">
      <h1>지식 그래프</h1>
      <p class="muted small">노트 사이의 <code>[[링크]]</code> 연결을 한눈에 보고, 노드를 클릭하면 내용을 바로 읽을 수 있어요.</p>
    </div>
    {#if hasRepo}
      <button class="ghost-sm" type="button" title="다시 불러오기" disabled={loading} on:click={() => loadGraph()}>
        <Icon name="refresh" size={15} /><span>새로고침</span>
      </button>
    {/if}
  </header>

  {#if !hasRepo}
    <section class="brain-empty">
      <span class="brain-empty-icon"><Icon name="book" size={24} /></span>
      <div>
        <h2>연결된 지식 저장소가 없습니다</h2>
        <p class="muted">지식 저장소를 연결하면 노트 사이의 관계와 내용을 이 화면에서 바로 탐색할 수 있습니다.</p>
      </div>
      <button class="primary" type="button" on:click={() => goView("settings", "knowledge")}>지식 저장소 설정</button>
    </section>
  {:else}

  <div class="brain-body">
    <div
      id="brain-graph-panel"
      class="brain-graph"
      aria-busy={loading ? "true" : "false"}
    >
      {#if loading}
        <div class="brain-state muted" role="status">그래프를 불러오는 중…</div>
      {:else if error}
        <div class="brain-state error-note" role="alert">
          불러오기 실패: {error}
          <button class="linkish small" type="button" disabled={loading} on:click={() => loadGraph()}>다시 시도</button>
        </div>
      {:else if graph?.noVault}
        <div class="brain-state muted">
          이 저장소는 아직 세컨드브레인 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게
          <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.
        </div>
      {:else if !graph?.nodes.length}
        <div class="brain-state muted">아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다.</div>
      {:else}
        <GraphCanvas {graph} selectedId={selected?.id ?? null} on:select={(e) => onSelect(e.detail)} />
        <div class="brain-stats muted">{graph.nodes.length}개 노트 · {graph.edges.length}개 연결</div>
      {/if}
    </div>

    <aside class="brain-note" aria-label="노트 내용">
      {#if !selected}
        <div class="brain-note-empty muted">
          <Icon name="book" size={22} />
          <p>노드를 클릭하면 노트 내용이 여기에 표시됩니다.</p>
        </div>
      {:else}
        <div class="brain-note-head">
          <div class="brain-note-title">
            <strong>{selected.label}</strong>
            {#if !selected.dangling}<code class="muted">{selected.id}</code>{/if}
          </div>
          <button class="icon-button" type="button" aria-label="닫기" title="닫기" on:click={clearNote}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {#if selected.tags.length}
          <div class="brain-note-tags">
            {#each selected.tags as tag}<span class="tag tag-chip">#{tag}</span>{/each}
          </div>
        {/if}

        {#if selected.dangling}
          <div class="brain-state muted">미연결 링크 — 이 제목의 노트가 아직 없습니다.</div>
        {:else if noteLoading}
          <div class="brain-state muted">노트를 불러오는 중…</div>
        {:else if noteError}
          <div class="brain-state error-note" role="alert">
            불러오기 실패: {noteError}
            <button class="linkish small" type="button" disabled={noteLoading} on:click={retrySelectedNote}>다시 시도</button>
          </div>
        {:else}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <article class="brain-note-body md">{@html noteHtml}</article>
        {/if}
      {/if}
    </aside>
  </div>
  {/if}
</div>

<style>
  .brain-view {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-5);
    overflow: hidden;
  }
  .brain-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .brain-title h1 {
    margin: 0;
    font-size: var(--t-xl);
    letter-spacing: -0.01em;
  }
  .brain-title p {
    margin: var(--s-1) 0 0;
  }
  .brain-empty {
    width: min(560px, 100%);
    margin: auto;
    display: grid;
    justify-items: center;
    gap: var(--s-4);
    padding: var(--s-6);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-lg);
    background: var(--material-regular, var(--panel));
    text-align: center;
    box-shadow: var(--shadow-sm);
  }
  .brain-empty-icon {
    width: var(--s-7);
    height: var(--s-7);
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .brain-empty h2 {
    margin: 0;
    font-size: var(--t-lg);
  }
  .brain-empty p {
    margin: var(--s-2) 0 0;
    line-height: 1.6;
  }
  .brain-body {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: var(--s-4);
  }
  .brain-graph {
    flex: 1 1 60%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .brain-stats {
    font-size: var(--t-xs);
  }
  .brain-state {
    padding: var(--s-6) var(--s-2);
    text-align: center;
    line-height: 1.6;
  }
  .brain-state .linkish.small {
    margin-left: var(--s-2);
  }
  .brain-note {
    flex: 1 1 40%;
    min-width: 0;
    min-height: 0;
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: var(--s-3);
    padding: var(--s-4);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-lg);
    background: var(--material-regular, var(--panel));
    box-shadow: var(--shadow-sm), 0 1px 0 var(--material-edge, transparent) inset;
    overflow-y: auto;
  }
  .brain-note-empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    text-align: center;
  }
  .brain-note-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-2);
  }
  .brain-note-title {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    min-width: 0;
  }
  .brain-note-title strong {
    font-size: var(--t-lg);
  }
  .brain-note-title code {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-xs);
  }
  .brain-note-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
  }
  /* Composes the global `.tag` base; note tags run one step larger than a
     generic tag, which is the only delta left. */
  .tag-chip {
    font-size: var(--t-xs);
  }
  .brain-note-body {
    min-width: 0;
    word-break: break-word;
  }

  @media (max-width: 860px) {
    .brain-body {
      flex-direction: column;
      overflow-y: auto;
    }
    .brain-graph {
      min-height: 320px;
    }
    .brain-note {
      max-width: none;
      flex: none;
    }
  }
</style>
