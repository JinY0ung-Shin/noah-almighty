<script lang="ts">
  import { onMount, tick } from "svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../lib/api";
  import type { DirectMessage, DirectMessageInbox, DirectMessagePage, DirectMessagePeer } from "../../../shared/directMessages";

  export let userId: string;
  let open = false;
  let inbox: DirectMessageInbox = { peers: [], unread: 0, windowMinutes: 60 };
  let selected: DirectMessagePeer | null = null;
  let messages: DirectMessage[] = [];
  let drafts: Record<string, string> = {};
  const pending = new Map<string, { text: string; nonce: string }>();
  let draft = "";
  let error = "";
  let syncError = "";
  let loading = false;
  let sending = false;
  let olderLoading = false;
  let hasMore = false;
  let generation = 0;
  let transcript: HTMLDivElement;
  const controller = new AbortController();
  let refreshing = false;

  function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return api<T>(path, { ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
  }

  function merge(incoming: DirectMessage[]) {
    messages = [...new Map([...messages, ...incoming].map(m => [m.id, m])).values()].sort((a, b) => a.id - b.id);
  }

  async function acknowledge(peerId: string, id: number, version: number) {
    if (!open || document.hidden || generation !== version) return;
    await request(`/api/dm/${peerId}/read`, { method: "POST", body: JSON.stringify({ throughId: id }) });
  }

  async function loadMessages(initial = false) {
    if (!selected || !open) return;
    const peerId = selected.id;
    const version = generation;
    const nearBottom = !transcript || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
    const page = await request<DirectMessagePage>(`/api/dm/${peerId}`);
    if (version !== generation || !open) return;
    // If over a page arrived between polls, fetch the gap before merging.
    const previousLast = messages.at(-1)?.id;
    let incoming = page.messages;
    let gap = page;
    while (!initial && previousLast && gap.hasMore && gap.messages[0]?.id > previousLast) {
      gap = await request<DirectMessagePage>(`/api/dm/${peerId}?before=${gap.messages[0].id}`);
      if (version !== generation || !open) return;
      incoming = [...gap.messages, ...incoming];
    }
    merge(incoming);
    if (initial) hasMore = page.hasMore;
    loading = false;
    await tick();
    if (version !== generation || !open) return;
    if (initial || nearBottom) transcript?.scrollTo({ top: transcript.scrollHeight });
    const last = messages.at(-1);
    if (last) await acknowledge(peerId, last.id, version);
  }

  async function refresh() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      inbox = await request<DirectMessageInbox>("/api/dm");
      if (selected) {
        const peer = inbox.peers.find(p => p.id === selected!.id);
        selected = peer ?? { ...selected, online: false, available: false };
      }
      if (open && selected && !loading) await loadMessages(messages.length === 0);
      syncError = "";
    } catch (e) {
      if (!controller.signal.aborted) syncError = (e as Error).message;
    } finally { refreshing = false; }
  }

  async function choose(peer: DirectMessagePeer) {
    if (selected) drafts[selected.id] = draft;
    selected = peer;
    draft = drafts[peer.id] || "";
    generation++;
    const version = generation;
    messages = [];
    hasMore = false;
    loading = true;
    error = "";
    try { await loadMessages(true); }
    catch (e) { if (version === generation && !controller.signal.aborted) error = (e as Error).message; }
    finally { if (version === generation) loading = false; }
  }

  async function older() {
    if (!selected || !messages.length || olderLoading) return;
    const version = generation;
    olderLoading = true;
    const height = transcript.scrollHeight;
    const top = transcript.scrollTop;
    try {
      const page = await request<DirectMessagePage>(`/api/dm/${selected.id}?before=${messages[0].id}`);
      if (version !== generation) return;
      merge(page.messages);
      hasMore = page.hasMore;
      await tick();
      transcript.scrollTop = top + transcript.scrollHeight - height;
    } catch (e) { if (!controller.signal.aborted) error = (e as Error).message; }
    finally { olderLoading = false; }
  }

  async function send() {
    if (!selected?.available || sending || !draft.trim()) return;
    const peerId = selected.id;
    const text = draft.trim();
    const originalDraft = draft;
    const prior = pending.get(peerId);
    // Retain the nonce on a network failure: retrying cannot duplicate delivery.
    const attempt = prior?.text === text ? prior : { text, nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") };
    pending.set(peerId, attempt);
    sending = true;
    error = "";
    try {
      const result = await request<{ message: DirectMessage }>(`/api/dm/${peerId}`, {
        method: "POST", body: JSON.stringify(attempt),
      });
      pending.delete(peerId);
      if (drafts[peerId] === originalDraft) drafts[peerId] = "";
      if (selected?.id === peerId) {
        merge([result.message]);
        if (draft === originalDraft) draft = "";
        await tick();
        transcript?.scrollTo({ top: transcript.scrollHeight });
      }
      await refresh();
    } catch (e) { if (!controller.signal.aborted) error = (e as Error).message; }
    finally { sending = false; }
  }

  function close() { open = false; generation++; if (selected) drafts[selected.id] = draft; }
  function show() {
    open = true;
    if (selected) void choose(selected);
    void refresh();
  }

  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const wake = () => void refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      controller.abort(); generation++;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
    };
  });
</script>

<button class="rail-presence-toggle" type="button" on:click={show} aria-haspopup="dialog">
  <span>DM</span>
  {#if inbox.unread > 0}<span class="tag accent" aria-label={`읽지 않은 메시지 ${inbox.unread}개`}>{inbox.unread}</span>{/if}
</button>

{#if open}
  <Modal portal ariaLabelledby="dm-title" cardClass="dm-modal" on:close={close}>
    <div class="dm-heading"><h2 id="dm-title">다이렉트 메시지</h2><button class="btn ghost sm" on:click={close}>닫기</button></div>
    <p class="muted">사용자와 직접 나누는 1:1 대화입니다. 접속 표시는 최근 {inbox.windowMinutes}분 내 활동 기준입니다.</p>
    {#if error || syncError}<p role="alert">{error || syncError} <button class="btn ghost sm" on:click={() => selected ? choose(selected) : refresh()}>다시 불러오기</button></p>{/if}
    <div class="dm-layout">
      <aside class="dm-peers" aria-label="DM 대화 상대">
        {#if !inbox.peers.length}<p class="muted">현재 접속자와 이전 대화가 없습니다.</p>{/if}
        {#each inbox.peers as peer (peer.id)}
          <button class="btn ghost dm-peer" class:chosen={selected?.id === peer.id} aria-pressed={selected?.id === peer.id} on:click={() => choose(peer)}>
            <span class="dm-name">{peer.displayName}<small>@{peer.username}</small></span>
            <span class="dm-status">{peer.online ? "접속 중" : peer.available ? "오프라인" : "이용 정지"}{#if peer.unread}<b>{peer.unread}</b>{/if}</span>
          </button>
        {/each}
      </aside>
      <section class="dm-chat" aria-label="DM 대화">
        {#if selected}
          <h3>{selected.displayName}</h3>
          <div class="dm-transcript scroll-thin" bind:this={transcript} role="log" aria-label="DM 메시지" aria-live="polite" aria-busy={loading}>
            {#if hasMore}<button class="btn ghost sm" disabled={olderLoading} on:click={older}>{olderLoading ? "불러오는 중…" : "이전 메시지"}</button>{/if}
            {#if loading}<p class="muted">대화를 불러오는 중…</p>{:else if !messages.length}<p class="muted">첫 메시지를 보내 보세요.</p>{/if}
            {#each messages as message (message.id)}
              <article class="dm-message" class:mine={message.senderId === userId}>
                <small>{message.senderId === userId ? "나" : selected.displayName} · {new Date(message.createdAt).toLocaleString("ko-KR")}</small>
                <p>{message.text}</p>
              </article>
            {/each}
          </div>
          <form class="dm-compose" on:submit|preventDefault={send}>
            <textarea aria-label="DM 메시지 입력" placeholder={selected.available ? "메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)" : "이용 정지된 사용자에게 보낼 수 없습니다"} maxlength={4000} rows="3" bind:value={draft} disabled={!selected.available}
              on:keydown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); } }}></textarea>
            <button class="btn primary" type="submit" disabled={sending || !draft.trim() || !selected.available}>{sending ? "전송 중…" : "보내기"}</button>
          </form>
        {:else}<p class="muted">접속자 또는 이전 대화 상대를 선택해 주세요.</p>{/if}
      </section>
    </div>
  </Modal>
{/if}

<style>
  :global(.dm-modal) { width: min(900px, calc(100vw - 2rem)); max-width: 900px; }
  .dm-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
  h2, h3, p { margin: 0; }
  .dm-heading + p { margin-block: var(--s-3); }
  .dm-layout { display: grid; grid-template-columns: minmax(160px, 28%) minmax(0, 1fr); height: min(60dvh, 600px); gap: var(--s-4); }
  .dm-peers { overflow-y: auto; min-width: 0; }
  .dm-peer { width: 100%; justify-content: space-between; text-align: left; gap: var(--s-2); }
  .dm-peer.chosen { background: var(--surface-2); }
  .dm-name { min-width: 0; overflow-wrap: anywhere; }
  .dm-name small { display: block; color: var(--muted); }
  .dm-status { flex-shrink: 0; font-size: var(--t-2xs); color: var(--muted); }
  .dm-status b { display: block; color: var(--accent); }
  .dm-chat { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: var(--s-3); }
  .dm-transcript { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--s-3); padding: var(--s-2); }
  .dm-message { flex-shrink: 0; max-width: 90%; padding: var(--s-3); background: var(--surface-2); border-radius: var(--r-lg); align-self: flex-start; overflow-wrap: anywhere; }
  .dm-message.mine { align-self: flex-end; border: 1px solid var(--line); }
  .dm-message small { color: var(--muted); font-size: var(--t-2xs); }
  .dm-message p { white-space: pre-wrap; margin-top: var(--s-1); }
  .dm-compose { display: flex; gap: var(--s-2); align-items: flex-end; }
  textarea { flex: 1; min-width: 0; resize: vertical; max-height: 140px; }
  @media (max-width: 640px) {
    .dm-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); height: 65dvh; }
    .dm-peers { display: flex; overflow-x: auto; max-height: 90px; }
    .dm-peer { width: auto; min-width: 145px; }
  }
</style>
