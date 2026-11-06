<script lang="ts">
  import { onMount } from "svelte";
  import AvatarImage from "../components/AvatarImage.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import Toggle from "../components/Toggle.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { formatFileSize, timeLabel } from "../lib/format";
  import { goView } from "../lib/nav";
  import { appState, notify } from "../lib/state";
  import type { SharedSkill, SharedSkillListing, SharedSkillManifest } from "../lib/types";
  import { resolveShareCopy } from "../../../shared/skillOriginMatch";

  // 스킬 배우기: 동료 아바타가 공유한 스킬을 둘러보고 내 아바타의 지식 저장소로
  // 전수(복사+커밋)하는 탭 + 내 저장소 스킬의 공유 토글. 서버 계약은
  // routes/skillShare.ts — 공유 범위는 탐색과 동일(팀원, 아바타가 팀 공개일 때).

  /** 서버 상한과 맞춘 값 (skillTransfer.ts의 MAX_SKILL_INTRO_CHARS) — 넘으면 400. */
  const INTRO_MAX = 500;

  interface MySkill {
    slug: string;
    name: string;
    /** SKILL.md frontmatter 설명 — 모델이 읽는 텍스트. */
    description: string;
    shared: boolean;
    /** 공유 카드에 내가 직접 쓴 소개 문구 (없으면 frontmatter 설명이 보인다). */
    customDescription: string | null;
    /** 이 스킬이 동료에게 전수된 횟수 (공유 해제해도 이력은 유지). */
    learnCount: number;
    /** 전수받은 스킬의 출처 마커 — 원본 해시와 비교해 업데이트 여부를 판단. */
    origin: {
      ownerUserId: string;
      ownerUsername: string;
      skillName: string;
      contentHash: string | null;
    } | null;
  }

  /** 목록 카드 하나의 파생 상태 (내 것/전수받음/업데이트 가능). */
  interface ListingView {
    skill: SharedSkillListing;
    own: boolean;
    /** 이 공유에서 전수받은 내 스킬 (있다면). */
    copy: MySkill | null;
    updateAvailable: boolean;
  }

  let loading = true;
  let error = "";
  let learnable: SharedSkillListing[] = [];
  let mineLoading = true;
  let mineError = "";
  let repoConfigured = true;
  /** 저장소의 skills가 일반 폴더가 아님(링크 등) — 목록은 비지만 공유는 그대로 유지된다. */
  let skillsDirUnreadable = false;
  let mySkills: MySkill[] = [];
  /**
   * available 요청 순번 — 늦게 도착한 응답이 최신 목록을 덮어쓰지 못하게 한다.
   * 조용한 재조회와 사용자의 새로고침이 겹칠 수 있어서, 나중에 시작한 요청이 이긴다.
   */
  let availableSeq = 0;

  let query = "";
  let searchInput: HTMLInputElement | null = null;
  let learningId: string | null = null;

  // 미리보기 모달: 목록 카드에서 열고, 이름 충돌(409) 시 새 이름 입력을 안내.
  let preview: SharedSkillListing | null = null;
  let previewContent = "";
  // 전수 시 실제로 복사되는 파일 목록 — 스킬은 SKILL.md 한 장이 아니라
  // skills/<slug>/ 디렉터리 전체라서, 무엇이 따라오는지 먼저 보여 준다.
  let previewManifest: SharedSkillManifest | null = null;
  let previewLoading = false;
  let previewError = "";
  let renameValue = "";
  let renameInput: HTMLInputElement | null = null;

  // 소개 문구 편집 모달: 공유 중인 스킬에만 열린다.
  let introSkill: MySkill | null = null;
  let introValue = "";
  let introSaving = false;
  let introInput: HTMLTextAreaElement | null = null;

  onMount(() => {
    loadAll();
  });

  /**
   * 공유 목록 읽기. available는 빠른 DB 읽기고, mine은 서버에서 원본 저장소를
   * fetch해 최신 해시를 DB에 다시 써 넣는 느린 경로다. quiet 모드는 그 mine이
   * 끝난 뒤의 재조회용 — 스피너를 다시 띄우지 않고 목록만 갈아 끼운다.
   */
  async function load(opts: { quiet?: boolean } = {}): Promise<void> {
    const seq = ++availableSeq;
    if (!opts.quiet) {
      loading = true;
      error = "";
    }
    try {
      const data = await api<{ skills: SharedSkillListing[] }>("/api/skill-share/available");
      if (seq !== availableSeq) return; // 더 나중에 시작한 요청이 이긴다
      learnable = data.skills;
      error = "";
    } catch (err) {
      // 조용한 갱신 실패는 이미 그려 둔 목록을 그대로 두고 넘어간다.
      if (!opts.quiet && seq === availableSeq) error = (err as Error).message;
    } finally {
      if (!opts.quiet) loading = false;
    }
  }

  /** 성공 여부를 돌려준다 — 실패했다면 뒤이은 조용한 재조회를 건너뛴다. */
  async function loadMine(): Promise<boolean> {
    mineLoading = true;
    mineError = "";
    try {
      const data = await api<{ repoConfigured: boolean; skillsDirUnreadable?: boolean; skills: MySkill[] }>(
        "/api/skill-share/mine",
      );
      repoConfigured = data.repoConfigured;
      skillsDirUnreadable = data.skillsDirUnreadable === true;
      mySkills = data.skills;
      return true;
    } catch (err) {
      mineError = (err as Error).message;
      return false;
    } finally {
      mineLoading = false;
    }
  }

  /**
   * 두 목록을 나란히 띄워 첫 화면을 빨리 그리되, mine이 끝나면 available를 한 번
   * 더 조용히 읽는다. mine이 서버에서 최신 해시를 써 넣기 전에 available가 먼저
   * 도착하면(거의 항상 그렇다) 방금 고친 내 스킬이 옛 해시로 보이기 때문이다.
   */
  function loadAll(): void {
    void load();
    void loadMine().then((ok) => {
      if (ok) void load({ quiet: true });
    });
  }

  function refresh(): void {
    loadAll();
  }

  $: displayQuery = query.trim();
  $: tokens = displayQuery.toLowerCase().split(/\s+/).filter(Boolean);
  $: filtered = tokens.length ? learnable.filter((skill) => matches(skill, tokens)) : learnable;
  $: sharedCount = mySkills.filter((skill) => skill.shared).length;
  // 전수 출처 조인: 카드가 "내 것 / 전수받음 / 업데이트 있음"을 알 수 있게
  // mine의 origin 마커와 목록의 현재 해시를 비교한다. 원본 주인별로 모으고
  // (한 공유에 대한 사본이 여럿일 수 있다) 이름 짝짓기는 findCopy가 맡는다.
  $: myUserId = $appState.user?.id ?? "";
  $: copiesByOrigin = groupCopiesByOwner(mySkills);
  $: listingViews = filtered.map((skill): ListingView => {
    const own = skill.ownerUserId === myUserId;
    const copy = own ? null : findCopy(copiesByOrigin, skill);
    return {
      skill,
      own,
      copy,
      updateAvailable: Boolean(
        copy?.origin?.contentHash && skill.contentHash && copy.origin.contentHash !== skill.contentHash,
      ),
    };
  });
  // 내 스킬 관리 목록: 스킬이 많아지면 토글을 찾아 스크롤하는 대신 검색.
  let mineQuery = "";
  $: mineTokens = mineQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  $: mineFiltered = mineTokens.length
    ? mySkills.filter((skill) =>
        mineTokens.every((t) =>
          [skill.slug, skill.name, skill.description, skill.origin?.ownerUsername ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(t),
        ),
      )
    : mySkills;
  $: resultStatus = loading
    ? "공유된 스킬을 불러오는 중입니다."
    : error
      ? `공유된 스킬을 불러오지 못했습니다: ${error}`
      : !learnable.length
        ? "아직 공유된 스킬이 없습니다."
        : !filtered.length
          ? `${displayQuery} 검색 결과가 없습니다.`
          : displayQuery
            ? `${displayQuery} 검색 결과 ${filtered.length}개가 있습니다.`
            : `공유된 스킬 ${filtered.length}개가 있습니다.`;

  /** 출처 마커를 가진 내 스킬들을 원본 주인별로 모은다. */
  function groupCopiesByOwner(skills: MySkill[]): Map<string, MySkill[]> {
    const byOwner = new Map<string, MySkill[]>();
    for (const skill of skills) {
      if (!skill.origin) continue;
      const copies = byOwner.get(skill.origin.ownerUserId);
      if (copies) copies.push(skill);
      else byOwner.set(skill.origin.ownerUserId, [skill]);
    }
    return byOwner;
  }

  /**
   * 이 공유에서 전수받은 내 스킬 찾기. 출처 마커에는 전수받던 당시의 원본 이름이
   * 남으므로, 그 뒤 원본 주인이 스킬 이름을 바꿨다면 현재 이름으로는 찾지 못한다 —
   * 공유 행이 들고 다니는 옛 이름(previousNames)까지 훑되, 짝짓기 규칙은 서버와
   * 같은 resolveShareCopy가 정한다(현재 이름 우선, 애매하면 아무것도 고르지 않아
   * 엉뚱한 사본에 업데이트 배지가 켜지지 않게).
   * (copies를 인자로 받는 이유: 반응형 문장이 이 Map을 의존성으로 잡게 하려고.)
   */
  function findCopy(copies: Map<string, MySkill[]>, skill: SharedSkillListing): MySkill | null {
    const resolved = resolveShareCopy(
      copies.get(skill.ownerUserId) ?? [],
      (copy) => copy.origin!.skillName,
      { skillName: skill.skillName, previousNames: skill.previousNames ?? [] },
    );
    return resolved && "match" in resolved ? resolved.match : null;
  }

  function matches(skill: SharedSkillListing, parts: string[]): boolean {
    const hay = [
      skill.skillName,
      skill.displayName,
      skill.description,
      skill.owner.displayName,
      skill.owner.alias,
      skill.owner.username,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return parts.every((part) => hay.includes(part));
  }

  function skillTitle(skill: SharedSkillListing): string {
    return skill.displayName || skill.skillName;
  }

  function clearSearch(): void {
    query = "";
    searchInput?.focus();
  }

  async function openPreview(skill: SharedSkillListing): Promise<void> {
    preview = skill;
    previewContent = "";
    previewManifest = null;
    previewError = "";
    renameValue = "";
    previewLoading = true;
    try {
      const data = await api<{ content: string; manifest: SharedSkillManifest }>(
        `/api/skill-share/available/${encodeURIComponent(skill.id)}`,
      );
      previewContent = data.content;
      previewManifest = data.manifest;
    } catch (err) {
      previewError = (err as Error).message;
    } finally {
      previewLoading = false;
    }
  }

  function closePreview(): void {
    if (learningId) return;
    preview = null;
    previewContent = "";
    previewManifest = null;
    previewError = "";
    renameValue = "";
  }

  /** 소개 문구 편집 시작: 지금 동료가 보고 있는 텍스트를 그대로 채워 준다. */
  function openIntro(skill: MySkill): void {
    introSkill = skill;
    introValue = skill.customDescription ?? skill.description ?? "";
    queueMicrotask(() => introInput?.focus());
  }

  function closeIntro(): void {
    if (introSaving) return;
    introSkill = null;
    introValue = "";
  }

  /** 빈 문자열을 보내면 서버가 소개를 지우고 frontmatter 설명으로 되돌린다. */
  async function saveIntro(next: string): Promise<void> {
    const skill = introSkill;
    if (!skill || introSaving) return;
    introSaving = true;
    try {
      const { shared } = await api<{ shared: SharedSkill }>(
        `/api/skill-share/share/${encodeURIComponent(skill.slug)}/description`,
        { method: "PUT", body: JSON.stringify({ description: next }) },
      );
      mySkills = mySkills.map((item) =>
        item.slug === skill.slug
          ? { ...item, customDescription: shared.customDescription }
          : item,
      );
      notify(
        next
          ? `"${skill.name}" 스킬의 소개 문구를 저장했습니다. 동료 목록에 바로 보여요.`
          : `"${skill.name}" 스킬의 소개 문구를 지웠습니다. 이제 frontmatter 설명이 보입니다.`,
        "ok",
      );
      introSkill = null;
      introValue = "";
      void load(); // 위쪽 목록 카드(내 공유 포함)의 설명도 갱신
    } catch (err) {
      notify(`소개 문구 저장 실패: ${(err as Error).message}`, "warn");
    } finally {
      introSaving = false;
    }
  }

  async function learn(
    skill: SharedSkillListing,
    opts: { newName?: string; updateSlug?: string; overwriteModified?: boolean } = {},
  ): Promise<void> {
    if (learningId) return;
    if (!repoConfigured) {
      notify("먼저 설정에서 내 지식 저장소를 연결해 주세요.", "warn");
      goView("settings", "knowledge");
      return;
    }
    // overwriteModified 재시도는 직전에 이미 danger 확인을 받았으므로 재확인 생략.
    if (!opts.overwriteModified) {
      const confirmed = await confirmAction(
        opts.updateSlug
          ? `"${opts.updateSlug}" 스킬을 @${skill.owner.username}의 최신 버전으로 업데이트할까요? 기존 내용을 덮어쓰고 커밋됩니다.`
          : `@${skill.owner.username}의 "${skillTitle(skill)}" 스킬을 전수받을까요? 내 지식 저장소에 복사되고 커밋됩니다.`,
        opts.updateSlug
          ? { title: "스킬을 업데이트할까요?", confirmLabel: "업데이트" }
          : { title: "스킬을 전수받을까요?", confirmLabel: "전수받기" },
      );
      if (!confirmed) return;
    }
    learningId = skill.id;
    try {
      const result = await api<{ slug: string; needsSelection: boolean; updated: boolean }>(
        "/api/skill-share/learn",
        {
          method: "POST",
          body: JSON.stringify({
            id: skill.id,
            ...(opts.newName ? { newName: opts.newName } : {}),
            ...(opts.updateSlug ? { updateSlug: opts.updateSlug } : {}),
            ...(opts.overwriteModified ? { overwriteModified: true } : {}),
          }),
        },
      );
      notify(
        result.updated
          ? `"${result.slug}" 스킬을 최신 버전으로 업데이트했습니다. 다음 대화부터 적용돼요.`
          : `"${result.slug}" 스킬을 전수받았습니다. 다음 대화부터 아바타가 사용할 수 있어요.` +
              (result.needsSelection ? " (지식 저장소의 스킬 선택 목록에서 켜야 합니다)" : ""),
        "ok",
      );
      preview = null;
      renameValue = "";
      // origin/해시가 바뀌었으니 두 목록 모두 새로고침 (업데이트 배지 해소).
      loadAll();
    } catch (err) {
      const message = (err as Error).message;
      // 전수 후 커스텀한 사본: 덮어쓸지 사용자에게 danger 확인 후 재시도.
      if (opts.updateSlug && /전수 후 수정/.test(message)) {
        learningId = null;
        const overwrite = await confirmAction(
          `"${opts.updateSlug}" 스킬은 전수받은 뒤 수정한 스킬입니다. 업데이트하면 수정 내용이 최신 공유 버전으로 덮어써져요 (저장소 이력에는 남습니다). 덮어쓸까요?`,
          { title: "수정한 스킬을 덮어쓸까요?", confirmLabel: "덮어쓰기", tone: "danger" },
        );
        if (overwrite) {
          await learn(skill, { ...opts, overwriteModified: true });
        } else {
          notify("두 버전을 모두 보관하려면 미리보기에서 다른 이름으로 전수받으세요.", "info");
        }
        return;
      }
      notify(`전수 실패: ${message}`, "warn");
      // 이름 충돌은 새 이름으로 바로 재시도할 수 있게 미리보기 모달로 안내.
      if (/이미 있습니다/.test(message) && !preview) {
        void openPreview(skill);
      }
      if (/이미 있습니다/.test(message)) {
        queueMicrotask(() => renameInput?.focus());
      }
    } finally {
      learningId = null;
    }
  }

  // 구독 해지: 출처 마커를 삭제해 원본 업데이트 추적을 끊는다 (스킬은 유지).
  async function unlinkOrigin(skill: MySkill): Promise<void> {
    if (!skill.origin) return;
    const confirmed = await confirmAction(
      `"${skill.name}" 스킬의 원본 연결을 끊을까요? 앞으로 @${skill.origin.ownerUsername}의 업데이트 알림을 받지 않아요. 스킬 내용은 그대로 남습니다.`,
      { title: "원본 연결을 끊을까요?", confirmLabel: "연결 끊기", tone: "danger" },
    );
    if (!confirmed) return;
    try {
      await api("/api/skill-share/unlink", {
        method: "POST",
        body: JSON.stringify({ slug: skill.slug }),
      });
      notify(`"${skill.name}" 스킬의 원본 연결을 끊었습니다. 이제 완전한 내 스킬이에요.`, "ok");
      loadAll();
    } catch (err) {
      notify(`연결 끊기 실패: ${(err as Error).message}`, "warn");
    }
  }

  async function setShared(skill: MySkill, next: boolean): Promise<void> {
    try {
      if (next) {
        await api("/api/skill-share/share", {
          method: "POST",
          body: JSON.stringify({ skill: skill.slug }),
        });
        notify(`"${skill.name}" 스킬을 공유했습니다. 팀원에게 보여요.`, "ok");
      } else {
        await api(`/api/skill-share/share/${encodeURIComponent(skill.slug)}`, { method: "DELETE" });
        notify(`"${skill.name}" 스킬 공유를 해제했습니다.`, "ok");
      }
      mySkills = mySkills.map((item) =>
        item.slug === skill.slug ? { ...item, shared: next } : item,
      );
    } catch (err) {
      notify(`공유 설정 실패: ${(err as Error).message}`, "warn");
      throw err; // Toggle이 이전 상태를 유지하도록 다시 던진다.
    }
  }
</script>

<header class="view-header">
  <div>
    <h1>스킬 배우기</h1>
    <p>동료 아바타의 스킬을 전수받고, 내 스킬을 공유하세요</p>
  </div>
  <!-- 두 목록을 실제로 기다리는 동안에만 잠근다. 뒤이은 조용한 재조회는 화면을
       비우지 않으므로 버튼도 막지 않고, 그사이 새로고침을 누르면 순번 가드가
       늦게 도착한 조용한 응답을 버린다. -->
  <button class="linkish" type="button" disabled={loading || mineLoading} on:click={refresh}>
    <Icon name="refresh" size={15} />
    새로고침
  </button>
</header>

<div class="view-body scroll-thin" aria-busy={loading}>
  <div class="skills-content">
  <div class="explore-search-bar">
    <Icon name="sparkles" />
    <input
      id="skills-search"
      class="explore-search"
      type="search"
      placeholder="스킬 이름·설명·공유한 사람으로 검색"
      aria-label="공유된 스킬 검색"
      aria-describedby="skills-results-status"
      bind:this={searchInput}
      bind:value={query}
    />
    {#if displayQuery}
      <button class="msg-act explore-search-clear" type="button" aria-label="검색어 지우기" title="검색어 지우기" on:click={clearSearch}>
        <Icon name="close" />
      </button>
    {/if}
  </div>
  <div class="sr-only" id="skills-results-status" role="status" aria-live="polite">{resultStatus}</div>

  <section class="skill-section" aria-labelledby="skills-learnable-title">
    <div class="skill-section-head">
      <h2 id="skills-learnable-title">공유된 스킬</h2>
      {#if !loading && !error}<span class="skill-count">{filtered.length}</span>{/if}
    </div>
    {#if loading}
      <div class="muted pad" role="status">불러오는 중…</div>
    {:else if error}
      <div class="warn-box" role="alert">
        공유된 스킬을 불러오지 못했습니다: {error}
        <button class="linkish" type="button" on:click={() => load()}>다시 시도</button>
      </div>
    {:else if !learnable.length}
      <div class="empty-note">
        아직 공유된 스킬이 없습니다. 팀원이 스킬을 공유하면 여기에 보여요.
        대화 중에 아바타에게 "공유된 스킬 찾아줘"라고 요청할 수도 있습니다.
      </div>
    {:else if !filtered.length}
      <div class="empty-note">
        "{displayQuery}"에 맞는 스킬이 없습니다.
        <button class="linkish small" type="button" on:click={clearSearch}>검색어 지우기</button>
      </div>
    {:else}
      <div class="skill-grid" aria-label={displayQuery ? `${displayQuery} 검색 결과` : "공유된 스킬 목록"}>
        {#each listingViews as view (view.skill.id)}
          {@const skill = view.skill}
          <div class="skill-card" class:busy={learningId === skill.id} aria-busy={learningId === skill.id}>
            <div class="sk-head">
              <strong class="sk-name">{skillTitle(skill)}</strong>
              {#if view.own}
                <span class="tag accent">나</span>
              {/if}
              {#if skill.displayName && skill.displayName !== skill.skillName}
                <span class="tag">{skill.skillName}</span>
              {/if}
              {#if skill.learnCount > 0}
                <span class="tag accent" title={`지금까지 ${skill.learnCount}번 전수된 스킬`}>전수 {skill.learnCount}회</span>
              {/if}
              {#if view.updateAvailable}
                <span class="tag write" title="전수받은 후 원본이 업데이트됐어요">업데이트 있음</span>
              {:else if view.copy}
                <span class="tag" title={`"${view.copy.slug}"로 전수받은 스킬`}>전수받음</span>
              {/if}
            </div>
            {#if skill.description}
              <p class="sk-desc">{skill.description}</p>
            {:else}
              <p class="sk-desc muted">설명이 없습니다.</p>
            {/if}
            <div class="sk-owner">
              <AvatarImage user={skill.owner} size={22} alt="" />
              <span class="sk-owner-name">{skill.owner.alias || skill.owner.displayName}</span>
              <span class="sk-owner-handle">@{skill.owner.username}</span>
              <span class="sk-time">{timeLabel(skill.updatedAt)}</span>
            </div>
            <div class="sk-actions">
              <button class="linkish small" type="button" disabled={Boolean(learningId)} on:click={() => openPreview(skill)}>
                미리보기
              </button>
              {#if view.updateAvailable && view.copy}
                <button
                  class="primary small"
                  type="button"
                  disabled={Boolean(learningId)}
                  aria-label={`${skillTitle(skill)} 스킬 업데이트 받기`}
                  on:click={() => learn(skill, { updateSlug: view.copy!.slug })}
                >
                  {learningId === skill.id ? "업데이트 중…" : "업데이트 받기"}
                </button>
              {:else if !view.own && !view.copy}
                <button
                  class="primary small"
                  type="button"
                  disabled={Boolean(learningId)}
                  aria-label={`${skillTitle(skill)} 스킬 전수받기`}
                  on:click={() => learn(skill)}
                >
                  {learningId === skill.id ? "전수 중…" : "전수받기"}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="skill-section" aria-labelledby="skills-mine-title">
    <div class="skill-section-head">
      <h2 id="skills-mine-title">내 아바타의 스킬 공유</h2>
      {#if !mineLoading && !mineError && repoConfigured}<span class="skill-count">{sharedCount}/{mySkills.length} 공유 중</span>{/if}
    </div>
    {#if mineLoading}
      <div class="muted pad" role="status">불러오는 중…</div>
    {:else if mineError}
      <div class="warn-box" role="alert">
        내 스킬 목록을 불러오지 못했습니다: {mineError}
        <button class="linkish" type="button" on:click={() => loadMine()}>다시 시도</button>
      </div>
    {:else if !repoConfigured}
      <div class="empty-note">
        지식 저장소를 연결하면 아바타의 스킬을 공유하고 전수받을 수 있어요.
        <button class="linkish small" type="button" on:click={() => goView("settings", "knowledge")}>지식 저장소 연결하기</button>
      </div>
    {:else if skillsDirUnreadable}
      <div class="warn-box" role="alert">
        지식 저장소의 skills 폴더가 일반 폴더가 아니라서(링크 등) 스킬을 읽을 수 없습니다. 이미 공유한 스킬은
        그대로 유지되지만, skills 폴더를 일반 폴더로 되돌리기 전까지는 동료가 미리 보거나 전수받을 수 없어요.
      </div>
    {:else if !mySkills.length}
      <div class="empty-note">
        아직 지식 저장소에 스킬이 없습니다. 대화에서 아바타에게 "○○ 스킬 만들어줘"라고
        요청하면 스킬을 만들 수 있어요.
      </div>
    {:else}
      {#if mySkills.length > 8}
        <div class="sk-mine-search">
          <input
            type="search"
            placeholder="내 스킬 검색"
            aria-label="내 스킬 검색"
            bind:value={mineQuery}
          />
        </div>
      {/if}
      <div class="skill-mine-panel">
        {#each mineFiltered as skill (skill.slug)}
          <div class="skill-mine-row">
            <div class="sk-mine-meta">
              <div class="sk-mine-title">
                <strong>{skill.name}</strong>
                {#if skill.name !== skill.slug}<span class="tag">{skill.slug}</span>{/if}
                {#if skill.learnCount > 0}
                  <span class="tag accent" title={`동료가 지금까지 ${skill.learnCount}번 전수받았어요`}>전수 {skill.learnCount}회</span>
                {/if}
              </div>
              {#if skill.origin}
                <span class="sk-mine-desc">@{skill.origin.ownerUsername}의 {skill.origin.skillName}에서 전수받음</span>
                <!-- 서버가 이 재공유를 409로 거절한다(assertSkillShareable). UI를
                     정직하게 만들어 그 오류 경로에 도달하지 않게 한다. -->
                <span class="sk-mine-desc">전수받은 스킬은 원본과 연결된 동안 공유할 수 없어요. 내 스킬로 공유하려면 먼저 ‘연결 끊기(구독 해지)’를 해 주세요.</span>
              {/if}
              <!-- 공유 중이고 소개 문구를 쓴 스킬은 동료가 그 문구를 본다 —
                   여기서도 같은 텍스트를 보여 줘야 무엇이 보이는지 안다. -->
              {#if skill.customDescription}
                <span class="sk-mine-desc">소개 문구: {skill.customDescription}</span>
              {:else if skill.description}
                <span class="sk-mine-desc">{skill.description}</span>
              {/if}
            </div>
            <div class="sk-mine-actions">
              {#if skill.shared}
                <button
                  class="linkish small"
                  type="button"
                  title="동료 목록에 보이는 소개 문구를 직접 씁니다"
                  aria-label={`${skill.name} 소개 수정`}
                  on:click={() => openIntro(skill)}
                >소개 수정</button>
              {/if}
              {#if skill.origin}
                <button
                  class="linkish small"
                  type="button"
                  title={`@${skill.origin.ownerUsername}의 업데이트 추적을 중단합니다 (스킬은 유지)`}
                  aria-label={`${skill.name} 원본 연결 끊기`}
                  on:click={() => unlinkOrigin(skill)}
                >연결 끊기</button>
              {/if}
              <Toggle
                on={skill.shared}
                label={`${skill.name} 공유`}
                disabled={Boolean(skill.origin)}
                title={skill.origin
                  ? `@${skill.origin.ownerUsername}의 원본과 연결된 동안에는 공유할 수 없어요 (연결 끊기 후 가능)`
                  : `${skill.name} 공유`}
                onChange={(next) => setShared(skill, next)}
              />
            </div>
          </div>
        {:else}
          <div class="skill-mine-row"><span class="sk-mine-desc">"{mineQuery.trim()}"에 맞는 스킬이 없습니다.</span></div>
        {/each}
      </div>
      <p class="sk-share-hint">공유한 스킬은 아바타가 팀 공개일 때 팀원에게 보입니다.</p>
    {/if}
  </section>
  </div>
</div>

{#if preview}
  {@const previewView = listingViews.find((v) => v.skill.id === preview!.id)}
  {@const previewOwn = preview.ownerUserId === myUserId}
  {@const previewUpdateSlug =
    previewView?.updateAvailable && previewView.copy ? previewView.copy.slug : null}
  <Modal cardClass="skill-preview-card" ariaLabelledby="skill-preview-title" on:close={closePreview}>
    <h2 id="skill-preview-title">{skillTitle(preview)}</h2>
    <div class="sk-owner sk-preview-owner">
      <AvatarImage user={preview.owner} size={22} alt="" />
      <span class="sk-owner-name">{preview.owner.alias || preview.owner.displayName}</span>
      <span class="sk-owner-handle">@{preview.owner.username}</span>
      {#if previewOwn}<span class="tag accent">나</span>{/if}
      {#if preview.learnCount > 0}
        <span class="tag accent">전수 {preview.learnCount}회</span>
      {/if}
      {#if previewUpdateSlug}<span class="tag write">업데이트 있음</span>{/if}
    </div>
    {#if preview.description}<p class="sk-desc sk-preview-desc">{preview.description}</p>{/if}
    {#if previewLoading}
      <div class="muted pad" role="status">스킬 내용을 불러오는 중…</div>
    {:else if previewError}
      <div class="warn-box" role="alert">{previewError}</div>
    {:else}
      <pre class="sk-preview-content scroll-thin">{previewContent}</pre>
      {#if previewManifest?.files.length}
        <div class="sk-files">
          <p class="sk-files-head">
            포함 파일 {previewManifest.files.length}개 · 총 {formatFileSize(previewManifest.totalBytes) || "0 B"}
          </p>
          <!-- SKILL.md 한 장뿐이면 위 한 줄로 충분하다. -->
          {#if previewManifest.files.length > 1}
            <ul class="sk-file-list scroll-thin">
              {#each previewManifest.files as file (file.path)}
                <li>
                  <span class="sk-file-path">{file.path}</span>
                  <span class="sk-file-size">{formatFileSize(file.bytes) || "0 B"}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if previewManifest.truncated}
            <p class="sk-files-note">
              전송 한도(파일 200개)에 걸려 목록이 잘렸습니다. 지금 상태로는 전수받을 수 없어요.
            </p>
          {/if}
        </div>
      {/if}
    {/if}
    {#if !previewOwn}
      <label class="field sk-rename-field">
        <span>다른 이름으로 전수 (선택)</span>
        <input
          type="text"
          placeholder={preview.skillName}
          aria-label="전수받을 새 스킬 이름"
          bind:this={renameInput}
          bind:value={renameValue}
          disabled={Boolean(learningId)}
        />
      </label>
    {/if}
    <div class="sk-actions sk-preview-actions">
      <button class="linkish" type="button" disabled={Boolean(learningId)} on:click={closePreview}>닫기</button>
      {#if !previewOwn}
        {#if previewUpdateSlug && !renameValue.trim()}
          <button
            class="primary"
            type="button"
            disabled={Boolean(learningId) || previewLoading || Boolean(previewError)}
            on:click={() => preview && learn(preview, { updateSlug: previewUpdateSlug })}
          >
            {learningId ? "업데이트 중…" : "업데이트 받기"}
          </button>
        {:else}
          <button
            class="primary"
            type="button"
            disabled={Boolean(learningId) || previewLoading || Boolean(previewError)}
            on:click={() => preview && learn(preview, { newName: renameValue.trim() || undefined })}
          >
            {learningId ? "전수 중…" : "전수받기"}
          </button>
        {/if}
      {/if}
    </div>
  </Modal>
{/if}

{#if introSkill}
  <Modal ariaLabelledby="skill-intro-title" closeDisabled={introSaving} on:close={closeIntro}>
    <h2 id="skill-intro-title">소개 문구</h2>
    <p class="sk-intro-help">
      동료의 스킬 목록 카드에 보이는 소개예요. 비워 두면 SKILL.md frontmatter 설명이 그대로 보입니다.
    </p>
    <label class="field">
      <span>"{introSkill.name}" 소개 문구</span>
      <textarea
        rows="4"
        maxlength={INTRO_MAX}
        placeholder={introSkill.description || "이 스킬이 무엇을 해 주는지 한두 문장으로 소개해 주세요."}
        aria-label={`${introSkill.name} 소개 문구`}
        bind:this={introInput}
        bind:value={introValue}
        disabled={introSaving}
      ></textarea>
    </label>
    <p class="sk-intro-help">{introValue.trim().length}/{INTRO_MAX}자</p>
    <div class="sk-actions sk-preview-actions">
      {#if introSkill.customDescription}
        <button
          class="linkish sk-intro-revert"
          type="button"
          disabled={introSaving}
          on:click={() => saveIntro("")}
        >frontmatter 설명으로 되돌리기</button>
      {/if}
      <button class="linkish" type="button" disabled={introSaving} on:click={closeIntro}>취소</button>
      <button
        class="primary"
        type="button"
        disabled={introSaving || !introValue.trim()}
        on:click={() => saveIntro(introValue.trim())}
      >{introSaving ? "저장 중…" : "저장"}</button>
    </div>
  </Modal>
{/if}

<style>
  /* Explore-family layout (docs/DESIGN.md §3): content column capped like the
     search bar, sections directly on the canvas (no card-in-card), grid density
     tokens matching .avatar-grid — card padding --s-5, grid gap --s-4. */
  .skills-content {
    max-width: 1100px;
    margin: 0 auto;
  }
  .skill-section {
    margin-top: var(--s-6);
  }
  .skill-section:first-of-type {
    margin-top: 0;
  }
  .skill-section-head {
    display: flex;
    align-items: baseline;
    gap: var(--s-2);
    margin: 0 0 var(--s-3);
  }
  .skill-section-head h2 {
    margin: 0;
    font-size: var(--t-md);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .skill-count {
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--muted);
  }

  .skill-grid {
    --pad-card: var(--s-5);
    --gap-stack: var(--s-4);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--gap-stack);
    align-items: stretch;
  }
  .skill-card {
    display: flex;
    flex-direction: column;
    gap: var(--s-2-5);
    padding: var(--pad-card);
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    min-width: 0;
  }
  .skill-card.busy {
    opacity: 0.7;
  }
  .sk-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    min-width: 0;
  }
  .sk-name {
    font-size: var(--t-md);
    font-weight: 700;
    letter-spacing: -0.01em;
    word-break: break-all;
  }
  .sk-desc {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-soft);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Owner row is anchored to the card bottom so short cards keep their
     attribution + actions aligned across the grid row. */
  .sk-owner {
    display: flex;
    align-items: center;
    gap: var(--s-1-5);
    margin-top: auto;
    padding-top: var(--s-1);
    font-size: var(--t-xs);
    color: var(--muted);
    min-width: 0;
  }
  .sk-owner-name {
    font-weight: 600;
    font-size: var(--t-sm);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sk-owner-handle {
    white-space: nowrap;
  }
  .sk-time {
    margin-left: auto;
    white-space: nowrap;
  }
  .sk-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--s-2);
  }

  .sk-mine-search {
    margin-bottom: var(--s-2);
  }
  .sk-mine-search input {
    width: min(320px, 100%);
  }
  .skill-mine-panel {
    border: 1px solid var(--line);
    border-radius: var(--r-md);
    background: var(--panel);
    overflow: hidden;
  }
  .skill-mine-row {
    display: flex;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-3) var(--s-4);
  }
  .skill-mine-row + .skill-mine-row {
    border-top: 1px solid var(--line-soft);
  }
  .sk-mine-meta {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--s-0-5);
    min-width: 0;
  }
  .sk-mine-title {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    flex-wrap: wrap;
    font-size: var(--t-base);
  }
  .sk-mine-desc {
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .sk-mine-actions {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-shrink: 0;
  }
  .sk-share-hint {
    margin: var(--s-2) var(--s-1) 0;
    font-size: var(--t-xs);
    color: var(--muted);
  }

  .sk-preview-owner {
    margin: var(--s-1) 0 0;
    padding-top: 0;
  }
  .sk-preview-desc {
    margin: var(--s-2) 0 0;
  }
  .sk-preview-content {
    max-height: 320px;
    margin-top: var(--s-3);
    overflow: auto;
    padding: var(--s-3);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
    background: var(--bg-subtle);
    font-size: var(--t-xs);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* 전수되는 파일 목록: SKILL.md 본문 바로 아래, 같은 폭의 종속 정보로 붙는다. */
  .sk-files {
    margin-top: var(--s-3);
  }
  .sk-files-head {
    margin: 0;
    font-size: var(--t-xs);
    font-weight: 600;
    color: var(--text-soft);
  }
  .sk-file-list {
    max-height: 160px;
    margin: var(--s-1-5) 0 0;
    padding: 0;
    overflow: auto;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
  }
  .sk-file-list li {
    display: flex;
    align-items: baseline;
    gap: var(--s-3);
    padding: var(--s-1) var(--s-2-5);
    font-size: var(--t-xs);
    color: var(--muted);
  }
  .sk-file-list li + li {
    border-top: 1px solid var(--line-soft);
  }
  .sk-file-path {
    flex: 1;
    min-width: 0;
    color: var(--text-soft);
    word-break: break-all;
  }
  .sk-file-size {
    white-space: nowrap;
  }
  .sk-files-note {
    margin: var(--s-1-5) 0 0;
    font-size: var(--t-xs);
    color: var(--warn);
  }

  .sk-intro-help {
    margin: var(--s-2) 0 0;
    font-size: var(--t-xs);
    color: var(--muted);
  }
  /* 되돌리기는 파괴적이지 않지만 되돌아가는 동작이라 확인 버튼들과 떼어 둔다. */
  .sk-intro-revert {
    margin-right: auto;
  }
  .sk-rename-field {
    margin-top: var(--s-3);
  }
  .sk-preview-actions {
    margin-top: var(--s-4);
  }
  :global(.skill-preview-card) {
    width: min(680px, calc(100vw - 2 * var(--s-4)));
  }
</style>
