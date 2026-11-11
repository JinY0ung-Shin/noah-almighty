<script lang="ts">
  // 인라인 UI 갤러리 (`#/uiGallery`): everything an avatar can draw in its answer
  // text, one small answer per thing (lib/uiGallery.ts). Each sample is drawn by
  // the chat's own renderer — AnswerUi, in its preview mode — so this page shows
  // exactly what a real answer shows, charts' entrances included; under it, the
  // text an avatar writes to get it.
  //
  // A preview has no conversation: what a control would send to the avatar is
  // shown under the sample instead of being sent, and nothing is kept.
  // Not in the rail: opened by its address.
  import AnswerUi from "../components/widget/AnswerUi.svelte";
  import { enhanceMarkdown } from "../lib/dom";
  import { renderMarkdown } from "../lib/format";
  import { scrollToStart } from "../lib/motion";
  import type { ChatPane } from "../lib/types";
  import { UI_GALLERY, gallerySourceMarkdown } from "../lib/uiGallery";

  // What AnswerUi reads of a pane; a preview never sends, keeps or reports through it.
  const pane = { id: "ui-gallery", conversationId: "", streaming: false, liveRunId: null } as unknown as ChatPane;

  const sampleCount = UI_GALLERY.reduce((sum, section) => sum + section.samples.length, 0);

  // The message a sample's control would have sent, by sample id.
  let outgoing: Record<string, string> = {};
  function outboxOf(id: string): (message: string) => void {
    return (message) => {
      outgoing = { ...outgoing, [id]: message };
    };
  }

  // A section's source is rendered when it is first opened: 30-odd highlighted code blocks nobody asked for are not.
  let opened: Record<string, boolean> = {};
  function onToggle(id: string, event: Event): void {
    if ((event.currentTarget as HTMLDetailsElement).open && !opened[id]) opened = { ...opened, [id]: true };
  }

  let sections: Record<string, HTMLElement> = {};
  function jump(id: string): void {
    const target = sections[id];
    if (!target) return;
    scrollToStart(target);
    target.focus({ preventScroll: true });
  }
</script>

<header class="view-header">
  <div>
    <h1>인라인 UI 갤러리</h1>
    <p>아바타가 답변 본문에 그릴 수 있는 것 {sampleCount}가지 — 실제 답변과 같은 방식으로 그려집니다</p>
  </div>
</header>

<div class="view-body scroll-thin">
  <div class="ui-gallery">
    <nav class="ui-gallery-nav" aria-label="갤러리 구역">
      {#each UI_GALLERY as section (section.id)}
        <button class="btn btn-ghost btn-sm" type="button" on:click={() => jump(section.id)}>{section.title}</button>
      {/each}
    </nav>

    {#each UI_GALLERY as section (section.id)}
      <section class="ui-gallery-section" aria-labelledby={`ui-gallery-${section.id}`} tabindex="-1" bind:this={sections[section.id]}>
        <div class="ui-gallery-section-head">
          <h2 id={`ui-gallery-${section.id}`}>{section.title}</h2>
          <p>{section.intro}</p>
        </div>
        {#each section.samples as sample (sample.id)}
          <article class="ui-gallery-card" data-sample={sample.id}>
            <div class="ui-gallery-card-head">
              <h3>{sample.title}</h3>
              {#if sample.note}<p>{sample.note}</p>{/if}
            </div>
            {#if !sample.sourceOnly}
              <!-- `data-entrance`: a diagram of a preview enters every time, like its charts (lib/mermaidBlock.ts). -->
              <div class="ui-gallery-stage" data-entrance="always">
                <AnswerUi {pane} text={sample.source} outbox={outboxOf(sample.id)} />
              </div>
              {#if outgoing[sample.id]}
                <div class="ui-gallery-sent" role="status">
                  <span>대화에서는 이 내용이 다음 메시지로 전송됩니다. 갤러리에서는 보내지 않습니다.</span>
                  <pre>{outgoing[sample.id]}</pre>
                </div>
              {/if}
            {/if}
            <details class="ui-gallery-source" open={sample.sourceOnly === true} on:toggle={(event) => onToggle(sample.id, event)}>
              <summary>소스 보기</summary>
              {#if opened[sample.id] || sample.sourceOnly}
                <div class="md" use:enhanceMarkdown={sample.source}>{@html renderMarkdown(gallerySourceMarkdown(sample.source))}</div>
              {/if}
            </details>
          </article>
        {/each}
      </section>
    {/each}
  </div>
</div>
