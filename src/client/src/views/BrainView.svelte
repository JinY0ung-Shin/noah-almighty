<script lang="ts">
  import { onMount } from "svelte";
  import GraphCanvas from "../components/GraphCanvas.svelte";
  import Icon from "../components/Icon.svelte";
  import { api } from "../lib/api";
  import { renderMarkdown } from "../lib/format";
  import { linkifyWikilinks, nodeLinks, sectionColor, sectionLabel, stripFrontmatter, stripTitleHeading, topNotes } from "../lib/knowledgeGraph";
  import { goView } from "../lib/nav";
  import { appState, replaceState } from "../lib/state";
  import { refreshTeamBrainStatus } from "../lib/teamBrain";
  import type { KnowledgeGraph, KnowledgeGraphNode, KnowledgeNote, User } from "../lib/types";
  import type { TeamBrainProposal } from "../../../shared/teamBrain";

  // Full-page second-brain graph of the owner's personal knowledge repo, reached
  // from the left nav. Pairs the reusable GraphCanvas with a note panel that
  // fetches + renders the clicked note's markdown — the richer surface over the
  // compact GraphViewModal in settings. The 팀 브레인 tab shows the ONE team
  // vault the same way (read-only), and — with no note selected — my proposals'
  // status and, for an admin, the pending queue (decisions go through the
  // admin's avatar + a card, never here).
  type Scope = "personal" | "team";
  const ENDPOINTS: Record<Scope, { graph: string; note: string }> = {
    personal: { graph: "/api/me/knowledge-repo/graph", note: "/api/me/knowledge-repo/note" },
    team: { graph: "/api/team-brain/graph", note: "/api/team-brain/note" },
  };
  type ProposalRow = Omit<TeamBrainProposal, "content">;

  let scope: Scope = "personal";
  $: user = $appState.user as User;
  $: isAdmin = Boolean(user?.roles?.includes("admin"));
  // The personal graph/note endpoints 404 without a connected repo.
  $: hasRepo = Boolean(user?.knowledgeRepo);
  $: showGraph = scope === "team" || hasRepo;

  let mine: ProposalRow[] = [];
  let pending: ProposalRow[] = [];
  let listsError = "";
  let mounted = false;

  // The badge / admin panel deep link: open on the team tab (one-shot flag).
  $: if (mounted && $appState.brainOpenTeamTab) {
    replaceState({ brainOpenTeamTab: false });
    switchScope("team");
  }

  function switchScope(next: Scope): void {
    if (scope === next && graph) return;
    scope = next;
    if (next === "personal" && !hasRepo) {
      graphToken++;
      graph = null;
      error = "";
      loading = false;
      clearNote();
      return;
    }
    void loadGraph();
    if (next === "team") void loadLists();
  }

  async function loadLists(): Promise<void> {
    listsError = "";
    try {
      const [m, p] = await Promise.all([
        api<{ proposals: ProposalRow[] }>("/api/team-brain/proposals/mine"),
        isAdmin ? api<{ proposals: ProposalRow[] }>("/api/team-brain/proposals/pending") : Promise.resolve({ proposals: [] }),
      ]);
      mine = m.proposals;
      pending = p.proposals;
      // Opening my list marked the results seen server-side.
      void refreshTeamBrainStatus();
    } catch (err) {
      listsError = (err as Error).message;
    }
  }

  // A pending proposal can be taken back here too — its card may be gone with its conversation.
  let withdrawing = "";
  async function withdraw(id: string): Promise<void> {
    if (withdrawing) return;
    withdrawing = id;
    listsError = "";
    try {
      await api(`/api/team-brain/cards/${encodeURIComponent(id)}/withdraw`, { method: "POST" });
      await loadLists();
    } catch (err) {
      listsError = (err as Error).message;
    } finally {
      withdrawing = "";
    }
  }

  // Status → `.tag` tone (docs/DESIGN.md §4.3): text AND colour, never colour alone.
  const STATUS_TONE: Record<string, string> = { approved: "ok", rejected: "danger", pending: "read" };

  const STATUS_KO: Record<string, string> = {
    draft: "제출 전",
    pending: "검토 대기",
    approved: "승인됨",
    rejected: "반려됨",
    withdrawn: "철회됨",
    expired: "만료됨",
  };

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
  // Notes opened from inside the panel (a [[link]], a backlink) stack here so
  // 뒤로 returns to the note you came from; a pick on the canvas starts afresh.
  let noteHistory: KnowledgeGraphNode[] = [];
  let noteEl: HTMLElement | undefined;

  $: stats = graph
    ? { notes: graph.nodes.filter((n) => !n.dangling).length, links: graph.edges.length, dangling: graph.nodes.filter((n) => n.dangling).length }
    : null;
  $: hubs = graph ? topNotes(graph, 10) : [];
  $: links = graph && selected ? nodeLinks(graph, selected.id) : { outgoing: [], incoming: [] };

  onMount(() => {
    mounted = true;
    if ($appState.brainOpenTeamTab) return; // the reactive deep link above opens the team tab
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
      const res = await api<{ graph: KnowledgeGraph }>(ENDPOINTS[scope].graph);
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
    noteHistory = [];
    noteHtml = "";
    noteError = "";
    noteLoading = false;
  }

  /** Open a note from inside the panel, remembering where we came from. */
  function openFromPanel(node: KnowledgeGraphNode): void {
    if (selected && selected.id !== node.id) noteHistory = [...noteHistory, selected];
    void onSelect(node, true);
  }

  function goBack(): void {
    const prev = noteHistory[noteHistory.length - 1];
    if (!prev) return;
    noteHistory = noteHistory.slice(0, -1);
    void onSelect(prev, true);
  }

  function openById(id: string): void {
    const node = graph?.nodes.find((n) => n.id === id);
    if (node) openFromPanel(node);
  }

  // Wikilinks in the rendered note are `<button data-wikilink=id>` (linkifyWikilinks).
  function onNoteClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wikilink]");
    const id = target?.dataset.wikilink;
    if (id) openById(id);
  }

  async function onSelect(node: KnowledgeGraphNode | null, fromPanel = false): Promise<void> {
    if (!fromPanel) noteHistory = [];
    selected = node;
    if (noteEl) noteEl.scrollTop = 0;
    noteHtml = "";
    noteError = "";
    if (!node || node.dangling) {
      noteLoading = false;
      return;
    }
    noteLoading = true;
    const token = ++noteToken;
    try {
      const res = await api<{ note: KnowledgeNote }>(`${ENDPOINTS[scope].note}?path=${encodeURIComponent(node.id)}`);
      if (token !== noteToken) return;
      // Team notes are teammate-written: no inline style (overlay / fake-UI guard).
      const body = stripTitleHeading(stripFrontmatter(res.note.content), node.label);
      noteHtml = renderMarkdown(graph ? linkifyWikilinks(body, graph) : body, { forbidInlineStyle: scope === "team" });
    } catch (err) {
      if (token !== noteToken) return;
      noteError = (err as Error).message;
    } finally {
      if (token === noteToken) noteLoading = false;
    }
  }

  function retrySelectedNote(): void {
    if (selected) void onSelect(selected, true);
  }
</script>

<div class="brain-view">
  <header class="brain-head">
    <div class="brain-title">
      <h1>지식 그래프</h1>
      <p class="muted small">노트 사이의 <code>[[링크]]</code> 연결을 보여줍니다. 노드를 누르거나 검색하면 내용과 연결된 노트를 바로 읽을 수 있어요.</p>
    </div>
    <div class="brain-head-actions">
      <div class="seg-control" role="tablist" aria-label="브레인 선택">
        <button type="button" role="tab" class:active={scope === "personal"} aria-selected={scope === "personal"} on:click={() => switchScope("personal")}>내 브레인</button>
        <button type="button" role="tab" class:active={scope === "team"} aria-selected={scope === "team"} on:click={() => switchScope("team")}>
          팀 브레인{#if $appState.teamBrainStatus.unseenResults + $appState.teamBrainStatus.pendingReview > 0}<span class="nav-badge brain-tab-badge">{$appState.teamBrainStatus.unseenResults + $appState.teamBrainStatus.pendingReview}</span>{/if}
        </button>
      </div>
      {#if showGraph}
        <button class="btn secondary sm" type="button" title="다시 불러오기" disabled={loading} on:click={() => { void loadGraph(); if (scope === "team") void loadLists(); }}>
          <Icon name="refresh" size={15} /><span>새로고침</span>
        </button>
      {/if}
    </div>
  </header>

  {#if !showGraph}
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
        <div class="brain-state brain-graph-state muted" role="status">그래프를 불러오는 중…</div>
      {:else if error}
        <div class="brain-state brain-graph-state error-note" role="alert">
          <span>불러오기 실패: {error}
            <button class="linkish small" type="button" disabled={loading} on:click={() => loadGraph()}>다시 시도</button></span>
        </div>
      {:else if graph?.noVault}
        <div class="brain-state brain-graph-state muted">
          <span>이 저장소는 아직 세컨드브레인 구조(<code>wiki/</code>·<code>raw/</code>)가 없습니다. 아바타에게
          <strong>brain-migrate</strong>를 한 번 실행해 달라고 하면 구조를 만들어 줍니다.</span>
        </div>
      {:else if !graph?.nodes.length}
        <div class="brain-state brain-graph-state muted">
          <span>{scope === "team"
            ? "팀 브레인에 아직 노트가 없습니다. 대화 중 아바타가 팀에 공유할지 물으면, 동의한 내용이 관리자 승인을 거쳐 여기에 쌓입니다."
            : "아직 표시할 노트가 없습니다. 대화로 지식을 쌓으면 여기에 나타납니다."}</span>
        </div>
      {:else}
        <GraphCanvas {graph} selectedId={selected?.id ?? null} on:select={(e) => onSelect(e.detail)} />
      {/if}
      {#if stats && !loading && !error && graph?.nodes.length}
        <div class="brain-stats" aria-label="그래프 요약">
          <span><strong>{stats.notes}</strong> 노트</span>
          <span><strong>{stats.links}</strong> 연결</span>
          {#if stats.dangling}<span><strong>{stats.dangling}</strong> 미연결 링크</span>{/if}
        </div>
      {/if}
    </div>

    <aside class="brain-note" aria-label="노트 내용" bind:this={noteEl}>
      {#if selected}
        <div class="brain-note-nav">
          {#if noteHistory.length}
            <button class="btn ghost sm" type="button" on:click={goBack} title={`${noteHistory[noteHistory.length - 1].label}(으)로 돌아가기`}>
              <Icon name="chevron-left" size={15} /><span>뒤로</span>
            </button>
          {:else}
            <span class="brain-section-label">
              <span class="brain-dot" class:dangling={selected.dangling} style={`--dot:${sectionColor(selected.section)}`}></span>{sectionLabel(selected.section)}
            </span>
          {/if}
          <button class="btn ghost icon sm" type="button" aria-label="닫기" title="닫기" on:click={clearNote}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <header class="brain-note-head">
          {#if noteHistory.length}
            <span class="brain-section-label">
              <span class="brain-dot" class:dangling={selected.dangling} style={`--dot:${sectionColor(selected.section)}`}></span>{sectionLabel(selected.section)}
            </span>
          {/if}
          <h2>{selected.label}</h2>
          {#if !selected.dangling}<code class="brain-note-path">{selected.id}</code>{/if}
          {#if selected.tags.length}
            <div class="brain-note-tags">
              {#each selected.tags as tag}<span class="tag">#{tag}</span>{/each}
            </div>
          {/if}
        </header>

        {#if selected.dangling}
          <div class="brain-callout muted">아직 이 제목의 노트가 없습니다. 아래 노트들이 이 제목을 <code>[[링크]]</code>로 가리키고 있어요.</div>
        {:else if noteLoading}
          <div class="brain-state muted" role="status">노트를 불러오는 중…</div>
        {:else if noteError}
          <div class="brain-state error-note" role="alert">
            불러오기 실패: {noteError}
            <button class="linkish small" type="button" disabled={noteLoading} on:click={retrySelectedNote}>다시 시도</button>
          </div>
        {:else}
          <!-- Wikilinks render as buttons; clicks are delegated here (keyboard Enter/Space fire click too). -->
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <article class="brain-note-body md" on:click={onNoteClick}>{@html noteHtml}</article>
        {/if}

        {#if links.outgoing.length || links.incoming.length}
          <section class="brain-links" aria-label="연결된 노트">
            {#if links.incoming.length}
              <h3>이 노트를 가리키는 노트 <span class="brain-count">{links.incoming.length}</span></h3>
              <ul class="brain-list">
                {#each links.incoming as n (n.id)}
                  <li><button type="button" class="brain-row" on:click={() => openFromPanel(n)}>
                    <span class="brain-dot" class:dangling={n.dangling} style={`--dot:${sectionColor(n.section)}`}></span>
                    <span class="brain-row-label">{n.label}</span>
                    <span class="brain-row-meta">{sectionLabel(n.section)}</span>
                  </button></li>
                {/each}
              </ul>
            {/if}
            {#if links.outgoing.length}
              <h3>이 노트가 링크한 노트 <span class="brain-count">{links.outgoing.length}</span></h3>
              <ul class="brain-list">
                {#each links.outgoing as n (n.id)}
                  <li><button type="button" class="brain-row" on:click={() => openFromPanel(n)}>
                    <span class="brain-dot" class:dangling={n.dangling} style={`--dot:${sectionColor(n.section)}`}></span>
                    <span class="brain-row-label">{n.label}</span>
                    <span class="brain-row-meta">{sectionLabel(n.section)}</span>
                  </button></li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
      {:else}
        {#if scope === "team"}
          <section class="brain-proposals" aria-label="팀 브레인 제안">
            <p class="brain-hint">팀 브레인 노트는 팀원이 제안하고 관리자가 승인한 내용입니다.</p>
            {#if listsError}<p class="error-note" role="alert">{listsError}</p>{/if}
            {#if isAdmin}
              <h3>검토 대기 <span class="brain-count">{pending.length}</span></h3>
              {#if pending.length}
                <p class="brain-hint">결정은 내 아바타에게 “팀 브레인 제안 검토해줘”라고 요청한 뒤, 아바타가 띄운 카드의 버튼으로 합니다.</p>
                <ul class="brain-list">
                  {#each pending as p (p.id)}
                    <li class="brain-card">
                      <div class="brain-card-top">
                        <strong>{p.title}</strong>
                        <span class="tag">{p.op === "create" ? "새 노트" : "수정"}</span>
                      </div>
                      <span class="brain-card-meta">{p.proposerName} · <code>{p.path}</code></span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="brain-hint">검토할 제안이 없습니다.</p>
              {/if}
            {/if}
            <h3>내 제안 {#if mine.length}<span class="brain-count">{mine.length}</span>{/if}</h3>
            {#if mine.length}
              <ul class="brain-list">
                {#each mine as p (p.id)}
                  <li class="brain-card">
                    <div class="brain-card-top">
                      <strong>{p.title}</strong>
                      <span class={`tag brain-proposal-status status-${p.status} ${STATUS_TONE[p.status] ?? ""}`}>{STATUS_KO[p.status] ?? p.status}</span>
                    </div>
                    <span class="brain-card-meta"><code>{p.path}</code></span>
                    {#if p.status === "rejected" && p.decisionReason}<p class="brain-card-reason">반려 사유: {p.decisionReason}</p>{/if}
                    {#if p.status === "pending"}
                      <button class="btn ghost sm brain-proposal-withdraw" type="button" disabled={withdrawing === p.id} on:click={() => withdraw(p.id)}>제안 철회</button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="brain-hint">아직 제안한 내용이 없습니다. 대화 중 아바타에게 “이거 팀에 공유해줘”라고 하면 제안 카드를 만들어 줍니다.</p>
            {/if}
          </section>
        {/if}
        {#if hubs.length}
          <section class="brain-hubs" aria-label="주요 노트">
            <h3>연결이 많은 노트</h3>
            <p class="brain-hint">노드를 누르거나 검색하면 노트 내용이 여기에 표시됩니다.</p>
            <ul class="brain-list">
              {#each hubs as { node, degree } (node.id)}
                <li><button type="button" class="brain-row" on:click={() => onSelect(node)}>
                  <span class="brain-dot" style={`--dot:${sectionColor(node.section)}`}></span>
                  <span class="brain-row-label">{node.label}</span>
                  <span class="brain-row-meta">연결 {degree}</span>
                </button></li>
              {/each}
            </ul>
          </section>
        {:else if scope !== "team"}
          <div class="brain-note-empty muted">
            <Icon name="book" size={22} />
            <p>노드를 누르면 노트 내용이 여기에 표시됩니다.</p>
          </div>
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
    gap: var(--s-4);
    padding: var(--s-5);
    overflow: hidden;
  }
  .brain-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .brain-title {
    min-width: 0;
    flex: 1 1 320px;
  }
  .brain-title h1 {
    margin: 0;
    font-size: var(--t-xl);
    letter-spacing: -0.01em;
  }
  .brain-title p {
    margin: var(--s-1) 0 0;
    line-height: 1.5;
  }
  .brain-head-actions {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .brain-tab-badge {
    margin-left: var(--s-1);
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
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .brain-graph-state {
    flex: 1;
    display: grid;
    place-items: center;
    border: 1px dashed var(--line);
    border-radius: var(--r-lg);
  }
  .brain-graph-state > span {
    max-width: 520px;
  }
  .brain-stats {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-4);
    padding: 0 var(--s-1);
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .brain-stats strong {
    color: var(--text-soft);
    font-variant-numeric: tabular-nums;
  }
  .brain-state {
    padding: var(--s-6) var(--s-2);
    text-align: center;
    line-height: 1.6;
  }
  .brain-state .linkish.small {
    margin-left: var(--s-2);
  }

  /* The reading pane: an opaque surface (DESIGN §1 — reading content is never glass). */
  .brain-note {
    flex: 0 0 clamp(320px, 34%, 480px);
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-5) var(--s-5);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-lg);
    background: var(--panel);
    box-shadow: var(--shadow-sm);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .brain-note-empty {
    margin: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--s-2);
    text-align: center;
  }
  .brain-note-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    min-height: 28px;
    margin-bottom: calc(-1 * var(--s-2));
  }
  .brain-note-nav .btn.ghost.sm {
    margin-left: calc(-1 * var(--s-2));
  }
  .brain-section-label {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1-5);
    font-size: var(--t-xs);
    font-weight: 600;
    color: var(--muted);
  }
  .brain-note-head {
    display: flex;
    flex-direction: column;
    gap: var(--s-1-5);
    padding-bottom: var(--s-4);
    border-bottom: 1px solid var(--line-soft);
    min-width: 0;
  }
  .brain-note-head h2 {
    margin: 0;
    font-size: var(--t-xl);
    line-height: 1.3;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  .brain-note-path {
    font-size: var(--t-xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .brain-note-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1);
    margin-top: var(--s-1);
  }
  .brain-note-body {
    min-width: 0;
    font-size: var(--t-md);
    line-height: 1.7;
    word-break: break-word;
  }
  /* Wikilinks (linkifyWikilinks): inline text links, not chrome buttons. */
  .brain-note-body :global(.wikilink) {
    display: inline;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-soft-strong);
    text-underline-offset: 3px;
    cursor: pointer;
  }
  .brain-note-body :global(.wikilink:hover) {
    text-decoration-color: currentColor;
  }
  .brain-note-body :global(.wikilink.dangling) {
    color: var(--muted);
    text-decoration-style: dashed;
  }
  .brain-note-body :global(.wikilink.missing) {
    color: var(--text-soft);
  }
  .brain-callout {
    padding: var(--s-3);
    border-radius: var(--r-md);
    background: var(--bg);
    line-height: 1.6;
  }

  .brain-links,
  .brain-proposals,
  .brain-hubs {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .brain-links {
    padding-top: var(--s-4);
    border-top: 1px solid var(--line-soft);
  }
  .brain-links h3,
  .brain-proposals h3,
  .brain-hubs h3 {
    display: flex;
    align-items: center;
    gap: var(--s-1-5);
    margin: var(--s-2) 0 0;
    font-size: var(--t-sm);
    font-weight: 700;
  }
  .brain-links h3:first-child,
  .brain-hubs h3:first-child {
    margin-top: 0;
  }
  .brain-count {
    font-weight: 600;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .brain-hint {
    margin: 0;
    font-size: var(--t-xs);
    line-height: 1.5;
    color: var(--muted);
  }
  .brain-proposals + .brain-hubs {
    padding-top: var(--s-4);
    border-top: 1px solid var(--line-soft);
  }
  .brain-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
  }
  .brain-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 36px;
    padding: var(--s-1-5) var(--s-2-5);
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--text);
    font-size: var(--t-sm);
    text-align: left;
    cursor: pointer;
  }
  .brain-row:hover {
    background: var(--bg);
  }
  .brain-row-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .brain-row-meta {
    flex: none;
    font-size: var(--t-2xs);
    color: var(--muted);
  }
  .brain-dot {
    flex: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--dot);
  }
  .brain-dot.dangling {
    background: transparent;
    border: 1.5px dashed var(--muted);
  }
  .brain-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-1);
    padding: var(--s-3);
    border: 1px solid var(--line-soft);
    border-radius: var(--r-md);
    background: var(--bg);
    overflow-wrap: anywhere;
  }
  .brain-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-2);
  }
  .brain-card-top strong {
    font-size: var(--t-sm);
    line-height: 1.4;
  }
  .brain-card-top .tag {
    flex: none;
  }
  .brain-card-meta {
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .brain-card-meta code {
    font-size: var(--t-2xs);
  }
  .brain-card-reason {
    margin: var(--s-1) 0 0;
    padding: var(--s-2) var(--s-2-5);
    border-radius: var(--r-sm);
    background: var(--danger-soft);
    color: var(--text);
    font-size: var(--t-xs);
    line-height: 1.5;
  }
  .brain-proposal-withdraw {
    align-self: flex-start;
    margin-top: var(--s-1);
  }

  @media (max-width: 960px) {
    .brain-body {
      flex-direction: column;
      overflow-y: auto;
    }
    .brain-graph {
      flex: none;
      height: min(62dvh, 520px);
      min-height: 320px;
    }
    .brain-note {
      flex: none;
      overflow: visible;
    }
  }
  @media (max-width: 560px) {
    .brain-view {
      padding: var(--s-4);
      gap: var(--s-3);
    }
    .brain-head-actions {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
