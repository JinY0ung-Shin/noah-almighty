<script lang="ts" context="module">
  let nextIntroModalId = 0;
</script>

<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../lib/api";
  import { renderMarkdown } from "../lib/format";
  import type { AvatarDetail, AvatarSummary, SkillInfo } from "../lib/types";

  export let avatar: AvatarSummary;

  const dispatch = createEventDispatcher<{ close: void }>();
  const modalId = `avatar-intro-${++nextIntroModalId}`;
  const titleId = `${modalId}-title`;

  let detail: AvatarDetail | null = null;
  let detailLoading = true;
  let detailError = "";
  let skills: SkillInfo[] = [];
  let skillsLoading = true;
  let skillsError = "";
  let openSkills = new Set<string>();

  // The explore card already carries name + hashtags, so the dialog can name the
  // avatar before the detail request lands; the detail wins once it arrives (it is
  // the fresher copy, and intro/plugins live only there).
  $: shown = detail ?? avatar;

  onMount(() => {
    // Both requests are independent — the intro must not wait on the skills call,
    // which lazily resolves plugin roots server-side (it may clone).
    void loadDetail();
    void loadSkills();
  });

  async function loadDetail(): Promise<void> {
    detailLoading = true;
    detailError = "";
    try {
      const result = await api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(avatar.id)}`);
      detail = result.avatar;
    } catch (err) {
      detailError = (err as Error).message;
    } finally {
      detailLoading = false;
    }
  }

  async function loadSkills(): Promise<void> {
    skillsLoading = true;
    skillsError = "";
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(avatar.id)}/skills`);
      skills = result.skills || [];
    } catch (err) {
      skillsError = (err as Error).message;
    } finally {
      skillsLoading = false;
    }
  }

  function toggleSkill(key: string) {
    const next = new Set(openSkills);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openSkills = next;
  }

  function close() {
    dispatch("close");
  }
</script>

<Modal cardClass="avatar-intro-card" ariaLabelledby={titleId} on:close={close}>
  <h2 id={titleId}>이 아바타의 역량</h2>
  <p class="ai-sub">{shown.displayName} 아바타가 사용할 수 있는 도구</p>

  {#if detailLoading}
    <p class="ai-note" role="status">소개를 불러오는 중…</p>
  {:else if detailError}
    <div class="ai-error" role="alert">
      <span>{detailError}</span>
      <button class="linkish small" type="button" on:click={loadDetail}>다시 시도</button>
    </div>
  {:else if detail?.intro}
    <div class="ai-intro md">{@html renderMarkdown(detail.intro)}</div>
  {/if}

  {#if shown.hashtags?.length}
    <div class="ai-tags">
      {#each shown.hashtags as tag}
        <span class="tag accent">#{tag}</span>
      {/each}
    </div>
  {/if}

  {#if detail?.plugins?.length}
    <section class="ai-section">
      <h3 class="ai-section-title">플러그인</h3>
      <div class="ai-section-body">
        {#each detail.plugins as plugin}
          <div class="ai-plugin">
            <span class="ai-plugin-name">{plugin.label || plugin.repo}</span>
            {#if plugin.label}<span class="ai-plugin-repo">{plugin.repo}</span>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class="ai-section" aria-busy={skillsLoading ? "true" : "false"}>
    <h3 class="ai-section-title">스킬</h3>
    <div class="ai-section-body">
      {#if skillsLoading}
        <p class="ai-note" role="status">스킬 목록을 불러오는 중…</p>
      {:else if skillsError}
        <div class="ai-error" role="alert">
          <span>{skillsError}</span>
          <button class="linkish small" type="button" on:click={loadSkills}>다시 시도</button>
        </div>
      {:else if !skills.length}
        <p class="ai-note">사용 가능한 스킬이 없습니다.</p>
      {:else}
        <div class="ai-skill-list" role="list" aria-label={`${shown.displayName} 스킬`}>
          {#each skills as skill, index}
            {@const key = `${skill.name}-${skill.source || "default"}-${index}`}
            {@const descId = `${modalId}-skill-desc-${index}`}
            {@const hasDescription = Boolean(skill.description)}
            {@const fromPlugin = Boolean(skill.source && skill.source !== "default")}
            <div class="ai-skill" class:open={openSkills.has(key)} role="listitem">
              <button
                class="ai-skill-head"
                type="button"
                disabled={!hasDescription}
                aria-expanded={hasDescription ? openSkills.has(key) : undefined}
                aria-describedby={hasDescription ? descId : undefined}
                on:click={() => toggleSkill(key)}
              >
                {#if hasDescription}<span class="ai-skill-caret" aria-hidden="true"><Icon name="chevron-right" size={12} /></span>{/if}
                <span class="ai-skill-name">{skill.name}</span>
                {#if fromPlugin}<span class="ai-skill-src">{skill.source}</span>{/if}
              </button>
              {#if hasDescription}<p id={descId} class="ai-skill-desc">{skill.description}</p>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <div class="ai-actions">
    <button class="linkish" type="button" on:click={close}>닫기</button>
  </div>
</Modal>

<style>
  /* Scoped here rather than in the global sheets: nothing else renders this
     content, and the card class is the only selector the Modal needs to see. */
  :global(.avatar-intro-card) {
    width: min(560px, calc(100vw - 2 * var(--s-4)));
  }

  .ai-sub {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--muted);
  }

  /* The avatar's self-introduction blurb, above the capability sections. */
  .ai-intro {
    margin-top: var(--s-1);
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    font-size: var(--t-sm);
    line-height: 1.55;
    color: var(--text-soft);
  }

  .ai-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1-5);
  }

  .ai-section {
    display: flex;
    flex-direction: column;
    gap: var(--s-2-5);
  }
  .ai-section-title {
    margin: 0;
    font-size: var(--t-xs);
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .ai-section-body {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }

  .ai-skill-list {
    display: flex;
    flex-direction: column;
    gap: var(--s-2);
  }
  .ai-skill {
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  /* The head is a full-width toggle button (name + optional source badge). */
  .ai-skill-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    width: 100%;
    padding: var(--s-2) var(--s-3);
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font: inherit;
  }
  .ai-skill-head[disabled] {
    cursor: default;
  }
  .ai-skill-head:not([disabled]):hover {
    background: var(--panel);
  }
  .ai-skill-caret {
    flex: none;
    display: inline-flex;
    align-items: center;
    color: var(--muted);
    transition: transform 0.15s var(--ease-out);
  }
  .ai-skill.open .ai-skill-caret {
    transform: rotate(90deg);
  }
  .ai-skill-name {
    flex: 1;
    min-width: 0;
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--text);
  }
  .ai-skill-src {
    flex: none;
    font-size: var(--t-2xs);
    color: var(--muted);
    background: var(--panel-strong);
    border-radius: var(--r-pill);
    padding: 1px var(--s-2);
  }
  /* Description is hidden until the skill is expanded. */
  .ai-skill-desc {
    display: none;
    margin: 0;
    padding: 0 var(--s-3) var(--s-3);
    font-size: var(--t-xs);
    line-height: 1.45;
    color: var(--text-soft);
  }
  .ai-skill.open .ai-skill-desc {
    display: block;
  }

  .ai-plugin {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--s-1) 0;
  }
  .ai-plugin-name {
    font-size: var(--t-sm);
    color: var(--text);
  }
  .ai-plugin-repo {
    font-size: var(--t-xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .ai-note {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .ai-error {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .ai-error .linkish.small {
    margin-top: 0;
    padding: 0;
  }

  .ai-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--s-2);
  }
</style>
