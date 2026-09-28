<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import Modal from "./Modal.svelte";
  import { copyText } from "../lib/dom";
  import { appState } from "../lib/state";
  import {
    absoluteShareUrl,
    activeShareLink,
    createShareLink,
    latestExpiredShareLink,
    listShareLinks,
    revokeShareLink,
    shareAudienceNote,
    shareDateLabel,
    shareDateTimeLabel,
  } from "../lib/shareLinks";
  import {
    DEFAULT_SHARE_LINK_EXPIRY_DAYS,
    SHARE_LINK_EXPIRY_DAYS,
    type ShareLinkExpiryDays,
  } from "../../../shared/shareLinks";
  import type { MessageAttachment, ShareLinkSummary } from "../lib/types";

  // Create / show / revoke the share link of ONE deck card. ChatView owns the
  // one instance (the card's link button and the file-preview panel's 공유 링크
  // both open it there). It is a portaled Modal (mounted inside the chat view,
  // a fixed overlay would otherwise sit in that view's stacking contexts), and
  // a portaled modal inerts everything else under <body>, App's
  // ConfirmationDialog and Toasts included. So this dialog NEVER calls
  // confirmAction or notify (both would mount inert and hidden UNDER it):
  // revoke confirms inline and every error renders inside the card.
  export let conversationId: string;
  export let attachment: Pick<MessageAttachment, "id" | "name">;

  const dispatch = createEventDispatcher<{ close: void }>();
  const uid = Math.random().toString(36).slice(2, 8);
  const titleId = `share-link-title-${uid}`;
  const expiryLabelId = `share-link-expiry-${uid}`;
  const confirmTextId = `share-link-confirm-${uid}`;

  type Phase = "loading" | "load-error" | "none" | "active";
  let phase: Phase = "loading";
  let link: ShareLinkSummary | null = null;
  /** Expiry of this card's most recent lapsed link, for the "이전 링크" note. */
  let lastExpiredAt = "";
  /** null = found on open; true = just created; false = the create call handed back an existing link. */
  let created: boolean | null = null;
  let expiry: ShareLinkExpiryDays = DEFAULT_SHARE_LINK_EXPIRY_DAYS;
  let busy = false;
  let error = "";
  let confirming = false;
  let revoked = false;
  let createButton: HTMLButtonElement | undefined;
  let copyButton: HTMLButtonElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let revokeButton: HTMLButtonElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;

  $: fileName = attachment.name || "파일";
  $: audience = shareAudienceNote($appState.bootstrap?.signupMode);
  $: linkUrl = link?.url ? absoluteShareUrl(link.url) : "";

  onMount(() => {
    void load();
  });

  async function load(): Promise<void> {
    phase = "loading";
    error = "";
    try {
      const links = (await listShareLinks({ conversationId, fileId: attachment.id })).filter(
        (item) => item.conversationId === conversationId && item.fileId === attachment.id,
      );
      link = activeShareLink(links);
      lastExpiredAt = latestExpiredShareLink(links)?.expiresAt ?? "";
      created = null;
      phase = link ? "active" : "none";
    } catch (err) {
      error = (err as Error).message;
      phase = "load-error";
    }
  }

  async function create(): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    revoked = false;
    try {
      const result = await createShareLink(conversationId, attachment.id, expiry);
      link = result.link;
      created = result.created;
      phase = "active";
      // Settle BEFORE the flush that mounts the active footer. A button that
      // mounts disabled starts at the disabled opacity and fades in (the
      // global button transition), so 공유 해제 first read as unavailable —
      // and focus() on a still-disabled button is a no-op.
      busy = false;
      await tick();
      (copyButton ?? closeButton)?.focus();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function startRevoke(): Promise<void> {
    error = "";
    confirming = true;
    await tick();
    // The safe choice takes focus: a stray Enter must not revoke.
    cancelButton?.focus();
  }

  async function cancelRevoke(): Promise<void> {
    confirming = false;
    await tick();
    revokeButton?.focus();
  }

  async function revoke(): Promise<void> {
    if (!link || busy) return;
    busy = true;
    error = "";
    try {
      await revokeShareLink(link.id);
      link = null;
      created = null;
      confirming = false;
      revoked = true;
      phase = "none";
      // Same as create(): 공유 링크 만들기 must mount enabled to take the focus.
      busy = false;
      await tick();
      createButton?.focus();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function copy(event: MouseEvent): void {
    // Pass the button: copyText reports failure by flashing it and is silent
    // without one (a plain-HTTP deployment has no async clipboard) — the
    // readonly field stays the manual fallback either way.
    void copyText(linkUrl, event.currentTarget as HTMLButtonElement);
  }

  function selectAll(event: Event): void {
    (event.currentTarget as HTMLInputElement).select();
  }

  function expiryLabel(days: ShareLinkExpiryDays): string {
    return days === DEFAULT_SHARE_LINK_EXPIRY_DAYS ? `${days}일(기본)` : `${days}일`;
  }

  function onExpiryKeydown(event: KeyboardEvent, current: ShareLinkExpiryDays): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = SHARE_LINK_EXPIRY_DAYS.indexOf(current);
    const last = SHARE_LINK_EXPIRY_DAYS.length - 1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + last + 1) % (last + 1);
    expiry = SHARE_LINK_EXPIRY_DAYS[nextIndex];
    requestAnimationFrame(() => document.getElementById(`share-link-expiry-${uid}-${expiry}`)?.focus());
  }

  function close(): void {
    if (!busy) dispatch("close");
  }
</script>

<Modal ariaLabelledby={titleId} portal closeDisabled={busy} on:close={close}>
  <h2 id={titleId}>공유 링크</h2>
  <p class="muted share-link-file">{fileName}</p>

  {#if phase === "loading"}
    <p class="muted" role="status">불러오는 중…</p>
  {:else if phase === "load-error"}
    <div class="warn-box" role="alert">
      {error}
      <button class="linkish" type="button" on:click={() => void load()}>다시 시도</button>
    </div>
  {:else if phase === "none"}
    {#if revoked}<p class="share-link-status" role="status">공유 링크를 해제했습니다.</p>{/if}
    {#if lastExpiredAt}<p class="muted">이전 링크는 {shareDateLabel(lastExpiredAt)}에 만료되었습니다.</p>{/if}
    <div class="share-link-expiry">
      <span id={expiryLabelId} class="share-link-label">유효 기간</span>
      <div class="seg-control" role="radiogroup" aria-labelledby={expiryLabelId}>
        {#each SHARE_LINK_EXPIRY_DAYS as days}
          <button
            id={`share-link-expiry-${uid}-${days}`}
            class="seg-btn"
            class:active={expiry === days}
            type="button"
            role="radio"
            aria-checked={expiry === days ? "true" : "false"}
            tabindex={expiry === days ? 0 : -1}
            disabled={busy}
            on:click={() => (expiry = days)}
            on:keydown={(event) => onExpiryKeydown(event, days)}>{expiryLabel(days)}</button>
        {/each}
      </div>
    </div>
    <p class="muted">{audience}</p>
  {:else if link}
    {#if created === false}<p class="share-link-status" role="status">이미 만든 링크를 보여 드립니다.</p>{/if}
    {#if linkUrl}
      <div class="share-link-url">
        <label class="field">
          <span>링크 주소</span>
          <input readonly value={linkUrl} autocomplete="off" spellcheck="false" on:focus={selectAll} on:click={selectAll} />
        </label>
        <!-- Named for what it copies; the visible 복사 stays inside the name. -->
        <button bind:this={copyButton} class="btn" type="button" aria-label="공유 링크 복사" on:click={copy}>복사</button>
      </div>
    {:else}
      <p class="warn-box">이 링크는 계속 열리지만 다시 표시할 수 없습니다. 다시 보내려면 공유를 해제하고 새 링크를 만드세요.</p>
    {/if}
    <p class="muted">{shareDateTimeLabel(link.expiresAt)}까지 · 조회 {link.viewCount}회</p>
    <p class="muted">{audience}</p>
    <p class="muted">유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요.</p>
  {/if}

  {#if error && phase !== "load-error"}
    <div class="warn-box" role="alert">{error}</div>
  {/if}

  {#if phase === "active" && confirming}
    <div class="share-link-confirm" role="group" aria-labelledby={confirmTextId}>
      <p id={confirmTextId}>이 링크를 해제할까요? 해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.</p>
      <div class="routine-modal-actions-right">
        <button bind:this={cancelButton} class="btn" type="button" disabled={busy} on:click={() => void cancelRevoke()}>취소</button>
        <button class="btn confirm-danger" type="button" disabled={busy} on:click={() => void revoke()}>{busy ? "해제하는 중…" : "해제"}</button>
      </div>
    </div>
  {:else}
    <div class="routine-modal-actions">
      <div class="routine-modal-actions-left">
        {#if phase === "active"}
          <button bind:this={revokeButton} class="btn danger" type="button" disabled={busy} on:click={() => void startRevoke()}>공유 해제</button>
        {/if}
      </div>
      <div class="routine-modal-actions-right">
        <button bind:this={closeButton} class="btn" type="button" disabled={busy} on:click={close}>닫기</button>
        {#if phase === "none"}
          <button bind:this={createButton} class="btn primary" type="button" disabled={busy} on:click={() => void create()}>
            {busy ? "만드는 중…" : "공유 링크 만들기"}
          </button>
        {/if}
      </div>
    </div>
  {/if}
</Modal>

<style>
  .share-link-file {
    overflow-wrap: anywhere;
  }
  .share-link-status {
    color: var(--ok);
    font-size: var(--t-sm);
    font-weight: 600;
  }
  .share-link-expiry {
    display: grid;
    gap: var(--s-1-5);
  }
  .share-link-label {
    color: var(--text-soft);
    font-size: var(--t-sm);
    font-weight: 600;
  }
  .share-link-url {
    display: flex;
    align-items: flex-end;
    gap: var(--s-2);
  }
  .share-link-url .field {
    flex: 1;
    min-width: 0;
  }
  .share-link-confirm {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-3);
    border: 1px solid var(--danger-line);
    border-radius: var(--r-md);
    background: var(--danger-soft);
  }
  .share-link-confirm p {
    font-size: var(--t-sm);
  }
  .share-link-confirm .routine-modal-actions-right {
    justify-content: flex-end;
  }
</style>
