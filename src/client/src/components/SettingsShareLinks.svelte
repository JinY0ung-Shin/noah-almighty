<script lang="ts">
  import { MAX_ACTIVE_SHARE_LINKS } from "../../../shared/shareLinks";
  import { confirmAction } from "../lib/confirm";
  import { copyText } from "../lib/dom";
  import { appState, notify } from "../lib/state";
  import {
    absoluteShareUrl,
    listShareLinks,
    revokeShareLink,
    shareAudienceNote,
    shareDateLabel,
    shareDateTimeLabel,
  } from "../lib/shareLinks";
  import type { ShareLinkSummary } from "../lib/types";

  // 권한·연결 → 공유 링크: every PPTX share link the owner made, active and
  // recently lapsed. Unlike the file card's dialog this card is NOT a modal, so
  // the app-root confirmAction and toasts are safe to use here.
  export let active = false;
  let links: ShareLinkSummary[] = [];
  let loaded = false;
  let busy = false;
  let error = "";
  $: if (active && !loaded && !busy) void load();
  // Leaving the tab drops the cached list, so a re-entry (or a different
  // account after a re-login) always refetches.
  $: if (!active) loaded = false;
  $: activeCount = links.filter((link) => !link.expired).length;
  $: audience = shareAudienceNote($appState.bootstrap?.signupMode);

  async function load(): Promise<void> {
    busy = true;
    loaded = true;
    error = "";
    try {
      links = await listShareLinks();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function revoke(link: ShareLinkSummary): Promise<void> {
    if (busy) return;
    const confirmed = await confirmAction(
      `"${link.fileName}" 공유 링크를 해제할까요?\n해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.`,
      { title: "공유 링크 해제", confirmLabel: "해제", tone: "danger" },
    );
    if (!confirmed) return;
    await remove(link, "공유 링크를 해제했습니다.");
  }

  // An expired row is already dead for recipients; deleting it only tidies the
  // list, so it needs no confirmation.
  async function removeExpired(link: ShareLinkSummary): Promise<void> {
    if (busy) return;
    await remove(link, "만료된 공유 링크를 삭제했습니다.");
  }

  async function remove(link: ShareLinkSummary, done: string): Promise<void> {
    busy = true;
    error = "";
    try {
      await revokeShareLink(link.id);
      links = links.filter((item) => item.id !== link.id);
      notify(done, "ok");
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  // copyText never throws: it reports the outcome by flashing the button it is
  // given, and stays SILENT without one.
  function copy(event: MouseEvent, link: ShareLinkSummary): void {
    void copyText(absoluteShareUrl(link.url), event.currentTarget as HTMLButtonElement);
  }
</script>

{#if active}
  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>공유 링크</h3>
        <p class="muted">
          채팅에서 만든 PPT 공유 링크입니다. {audience}
          쓰지 않는 링크는 해제하세요. 활성 링크는 최대 {MAX_ACTIVE_SHARE_LINKS}개까지 만들 수 있습니다.
        </p>
      </div>
    </div>
    {#if error}
      <div class="warn-box" role="alert">{error} <button class="linkish" type="button" disabled={busy} on:click={load}>목록 다시 불러오기</button></div>
    {/if}
    {#if links.length}
      <p class="muted share-links-count">활성 링크 {activeCount}개</p>
    {/if}
    <div class="secret-list">
      {#each links as link (link.id)}
        <div class="secret-row share-link-row">
          <div class="share-link-main">
            <strong class="share-link-name">{link.fileName}</strong>
            <span class="muted share-link-source">{link.conversationTitle || "제목 없는 대화"}</span>
            <span class="muted share-link-dates">
              {shareDateLabel(link.createdAt)} 만듦 · {link.expired
                ? `${shareDateLabel(link.expiresAt)} 만료`
                : `${shareDateTimeLabel(link.expiresAt)}까지`} · 조회 {link.viewCount}회
            </span>
          </div>
          <span class="tag" class:accent={!link.expired}>{link.expired ? "만료" : "활성"}</span>
          <div class="share-link-actions">
            {#if !link.expired && link.url}
              <button
                class="linkish small"
                type="button"
                aria-label={`공유 링크 복사: ${link.fileName}`}
                on:click={(event) => copy(event, link)}
              >복사</button>
            {/if}
            {#if link.expired}
              <button
                class="linkish small"
                type="button"
                disabled={busy}
                aria-label={`만료된 공유 링크 삭제: ${link.fileName}`}
                on:click={() => void removeExpired(link)}
              >삭제</button>
            {:else}
              <button
                class="linkish small danger"
                type="button"
                disabled={busy}
                aria-label={`공유 링크 해제: ${link.fileName}`}
                on:click={() => void revoke(link)}
              >해제</button>
            {/if}
          </div>
        </div>
      {:else}
        <p class="muted">{busy ? "불러오는 중…" : "만든 공유 링크가 없습니다."}</p>
      {/each}
    </div>
  </section>
{/if}

<style>
  .share-links-count {
    margin: 0 0 var(--s-2);
    font-size: var(--t-xs);
  }
  .share-link-main {
    display: grid;
    flex: 1 1 220px;
    gap: var(--s-0-5);
    min-width: 0;
  }
  .share-link-name,
  .share-link-source {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .share-link-source,
  .share-link-dates {
    font-size: var(--t-xs);
  }
  .share-link-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--s-3);
  }
</style>
