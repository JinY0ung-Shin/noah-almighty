<script lang="ts">
  import AvatarImage from "./AvatarImage.svelte";
  import Icon from "./Icon.svelte";
  import HashtagChipEditor from "./HashtagChipEditor.svelte";
  import { api, refreshMe } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { normalizeTags } from "../lib/format";
  import { downscaleImageToDataUrl, pastedImageFile } from "../lib/dom";
  import { appState, notify, readState, replaceState, updateState } from "../lib/state";
  import type { AvatarVisibility, User } from "../lib/types";

  export let active = false;

  const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
    { value: "group", label: "팀 공개", desc: "모든 팀원(가입이 승인된 사용자)이 탐색에서 찾아 대화할 수 있어요. 팀원끼리는 서로 신뢰하므로 대화에서 확장 권한 도구도 쓸 수 있어요." },
    { value: "private", label: "비공개", desc: "나만 볼 수 있어요. 팀원 사이의 신뢰 관계는 그대로예요." },
  ];

  $: user = $appState.user;

  // profile form
  const u0 = readState().user;
  let displayName = u0?.displayName || "";
  let alias = u0?.alias || "";
  let bio = u0?.bio || "";
  let intro = u0?.intro || "";
  let persona = u0?.persona || "";
  let hashtags: string[] = [...(u0?.hashtags || [])];
  let profileSaving = false;
  let introGenBusy = false;
  let tagGenBusy = false;
  let tagAddBusy = false;
  let allGenBusy = false;
  let picBusy = false;
  let profileError = "";
  let profileGenError = "";
  let profileGenMessage = "";
  let fileInput: HTMLInputElement;
  let syncedProfileUserId = u0?.id || "";
  const profileStatusId = "settings-profile-save-status";
  const profileGenStatusId = "settings-profile-generation-status";

  // visibility
  let visibility: AvatarVisibility = u0?.visibility || "group";
  let visSaving = false;

  // shared (communal) account
  let sharedAccount = Boolean(u0?.sharedAccount);
  let sharedSaving = false;

  function sameTags(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((tag, index) => tag === right[index]);
  }

  function syncProfileForm(next: User): void {
    displayName = next.displayName || "";
    alias = next.alias || "";
    bio = next.bio || "";
    intro = next.intro || "";
    persona = next.persona || "";
    hashtags = [...(next.hashtags || [])];
    visibility = next.visibility || "group";
    sharedAccount = Boolean(next.sharedAccount);
    syncedProfileUserId = next.id;
    profileError = "";
    profileGenError = "";
    profileGenMessage = "";
  }

  $: profileDirty = Boolean(
    user &&
      (displayName !== (user.displayName || "") ||
        alias !== (user.alias || "") ||
        bio !== (user.bio || "") ||
        intro !== (user.intro || "") ||
        persona !== (user.persona || "") ||
        !sameTags(hashtags, user.hashtags || [])),
  );
  $: profileGenBusy = Boolean(introGenBusy || tagGenBusy || tagAddBusy || allGenBusy);
  $: profileGenPartial = Boolean(profileGenError && profileGenError.includes("초안만 채워졌습니다"));
  $: profileGenStatus = profileGenBusy
    ? "자동 생성 중입니다."
    : profileGenError
      ? profileGenError
      : profileGenMessage;
  $: profileSaveStatus = profileSaving
    ? "저장 중…"
    : profileError
      ? `저장 실패: ${profileError}`
      : profileDirty
        ? "저장하지 않은 변경 사항이 있습니다."
        : "저장됨";
  $: if (user?.id && user.id !== syncedProfileUserId && !profileSaving && !profileGenBusy && !picBusy && !visSaving && !sharedSaving) {
    syncProfileForm(user);
  }

  async function saveProfile(): Promise<void> {
    if (profileSaving || !profileDirty) return;
    profileSaving = true;
    profileError = "";
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ displayName, alias, bio, intro, persona, hashtags }),
      });
      syncProfileForm(next);
      replaceState({ user: next });
      notify("프로필을 저장했습니다.", "ok");
    } catch (err) {
      profileError = (err as Error).message;
      notify(`저장 실패: ${profileError}`, "warn");
    } finally {
      profileSaving = false;
    }
  }

  async function generateIntro(): Promise<void> {
    if (profileSaving || introGenBusy || allGenBusy) return;
    introGenBusy = true;
    profileGenError = "";
    profileGenMessage = "";
    try {
      const { intro: next } = await api<{ intro: string }>("/api/me/intro/generate", { method: "POST" });
      if (next) {
        intro = next;
        profileGenMessage = "자기소개 초안이 채워졌습니다.";
        notify(`${profileGenMessage} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else {
        profileGenMessage = "생성된 자기소개가 없습니다.";
        notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      profileGenError = `자기소개 생성 실패: ${(err as Error).message}`;
      notify(profileGenError, "warn");
    } finally {
      introGenBusy = false;
    }
  }

  async function generateTags(): Promise<void> {
    if (profileSaving || tagGenBusy || allGenBusy) return;
    tagGenBusy = true;
    profileGenError = "";
    profileGenMessage = "";
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" });
      if (next?.length) {
        hashtags = [...next];
        profileGenMessage = "해시태그 초안이 채워졌습니다.";
        notify(`${profileGenMessage} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else {
        profileGenMessage = "생성된 해시태그가 없습니다.";
        notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
      }
    } catch (err) {
      profileGenError = `해시태그 생성 실패: ${(err as Error).message}`;
      notify(profileGenError, "warn");
    } finally {
      tagGenBusy = false;
    }
  }

  // Generate MORE hashtags without discarding the current ones: send the
  // existing tags so the avatar proposes only new, distinct ones, then merge
  // (normalizeTags dedupes + caps at 12). For when the current set feels thin.
  async function addTags(): Promise<void> {
    if (profileSaving || tagAddBusy || tagGenBusy || allGenBusy) return;
    tagAddBusy = true;
    profileGenError = "";
    profileGenMessage = "";
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", {
        method: "POST",
        body: JSON.stringify({ existing: hashtags }),
      });
      if (next?.length) {
        const before = hashtags.length;
        hashtags = normalizeTags([...hashtags, ...next]);
        const added = hashtags.length - before;
        notify(
          added > 0
            ? `해시태그 ${added}개를 추가했습니다. 저장하려면 프로필 저장을 누르세요.`
            : "추가할 새 해시태그가 없습니다. 이미 충분히 채워져 있어요.",
          "info",
        );
        profileGenMessage = added > 0 ? `해시태그 ${added}개를 추가했습니다.` : "추가할 새 해시태그가 없습니다.";
      } else {
        profileGenMessage = "추가할 새 해시태그가 없습니다.";
        notify("추가할 새 해시태그가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      profileGenError = `해시태그 추가 실패: ${(err as Error).message}`;
      notify(profileGenError, "warn");
    } finally {
      tagAddBusy = false;
    }
  }

  // Generate the self-introduction AND capability hashtags in one click. Fires
  // both headless endpoints in parallel; a partial success still fills what it
  // can (allSettled). Like the individual buttons, neither result is persisted —
  // the owner reviews then saves.
  async function generateAll(): Promise<void> {
    if (profileSaving || allGenBusy || introGenBusy || tagGenBusy || tagAddBusy) return;
    allGenBusy = true;
    profileGenError = "";
    profileGenMessage = "";
    try {
      const [introRes, tagsRes] = await Promise.allSettled([
        api<{ intro: string }>("/api/me/intro/generate", { method: "POST" }),
        api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" }),
      ]);
      if (introRes.status === "fulfilled" && introRes.value.intro) intro = introRes.value.intro;
      if (tagsRes.status === "fulfilled" && tagsRes.value.hashtags?.length) hashtags = [...tagsRes.value.hashtags];

      const okIntro = introRes.status === "fulfilled" && !!introRes.value.intro;
      const okTags = tagsRes.status === "fulfilled" && !!tagsRes.value.hashtags?.length;
      if (okIntro && okTags) {
        profileGenMessage = "자기소개와 해시태그 초안이 채워졌습니다.";
        notify(`${profileGenMessage} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else if (okIntro || okTags) {
        profileGenError = `${okIntro ? "자기소개" : "해시태그"} 초안만 채워졌습니다.`;
        notify(`${profileGenError} 나머지는 다시 시도해 주세요. 저장하려면 프로필 저장을 누르세요.`, "warn");
      } else {
        // Report whichever call actually rejected — the intro might have resolved
        // empty while the hashtags call threw, so don't hardcode introRes.
        const reason =
          introRes.status === "rejected"
            ? (introRes.reason as Error).message
            : tagsRes.status === "rejected"
              ? (tagsRes.reason as Error).message
              : "결과가 비어 있습니다.";
        profileGenError = `자동 생성 실패: ${reason}`;
        notify(profileGenError, "warn");
      }
    } finally {
      allGenBusy = false;
    }
  }

  // ---- visibility ----
  async function chooseVisibility(val: AvatarVisibility): Promise<void> {
    if (visSaving || val === visibility) return;
    const prev = visibility;
    visibility = val;
    visSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
      replaceState({ user: next });
      if (next.visibility !== val) {
        visibility = next.visibility;
        const label = VISIBILITY_OPTIONS.find((o) => o.value === next.visibility)?.label || next.visibility;
        notify(`공개 범위가 서버에서 ${label}(으)로 저장되었습니다.`, "warn");
      } else {
        const label = VISIBILITY_OPTIONS.find((o) => o.value === val)?.label || val;
        notify(`공개 범위를 ${label}(으)로 변경했습니다.`, "ok");
      }
    } catch (err) {
      visibility = prev;
      notify(`공개 범위 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      visSaving = false;
    }
  }

  // ---- shared (communal) account ----
  async function toggleSharedAccount(on: boolean): Promise<void> {
    if (sharedSaving) return;
    const prev = sharedAccount;
    sharedAccount = on;
    sharedSaving = true;
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ sharedAccount: on }) });
      replaceState({ user: next });
      sharedAccount = next.sharedAccount;
      notify(
        next.sharedAccount
          ? "공용 계정으로 설정했습니다. 팀원이 이 아바타와 대화하며 지식 저장소를 수정·커밋할 수 있어요."
          : "공용 계정 설정을 해제했습니다. 지식 저장소 수정은 다시 소유자 전용이 됩니다.",
        "ok",
      );
    } catch (err) {
      sharedAccount = prev;
      notify(`공용 계정 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      sharedSaving = false;
    }
  }

  // ---- avatar image ----
  // Shared by the file picker AND clipboard paste (Ctrl+V): resize → PUT → refresh.
  async function applyAvatarImage(file: File): Promise<void> {
    if (picBusy) return;
    picBusy = true;
    try {
      const image = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image }) });
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
      picBusy = false;
      return;
    }
    try {
      await refreshMe();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (err) {
      notify(`사진은 변경했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }

  async function uploadImage(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    if (picBusy) {
      input.value = "";
      return;
    }
    const file = input.files?.[0];
    if (!file) return;
    await applyAvatarImage(file);
    input.value = ""; // allow re-picking the same file
  }

  // Ctrl+V anywhere on the profile tab registers a copied image as the avatar
  // photo. Gated on `active` (the tab is always mounted — see SettingsView) and
  // careful not to hijack an intended TEXT paste into a form field; an
  // image-only clipboard pastes nothing into fields, so taking it is safe.
  function onWindowPaste(event: ClipboardEvent): void {
    if (!active || picBusy) return;
    const file = pastedImageFile(event.clipboardData);
    if (!file) return;
    const target = event.target as HTMLElement | null;
    const inField = Boolean(target?.closest?.("input, textarea, [contenteditable]"));
    const hasText = Boolean(event.clipboardData?.getData("text/plain"));
    if (inField && hasText) return;
    event.preventDefault();
    void applyAvatarImage(file);
  }

  async function deleteImage(): Promise<void> {
    if (picBusy) return;
    if (!(await confirmAction("아바타 사진을 삭제할까요?"))) return;
    picBusy = true;
    try {
      await api("/api/me/avatar-image", { method: "DELETE" });
    } catch (err) {
      notify(`사진 삭제 실패: ${(err as Error).message}`, "warn");
      picBusy = false;
      return;
    }
    try {
      await refreshMe();
      notify("아바타 사진을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`사진은 삭제했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      picBusy = false;
    }
  }

  async function resizeImage(file: File, max: number): Promise<string> {
    return downscaleImageToDataUrl(file, max);
  }

  function focusVisibility(value: AvatarVisibility): void {
    requestAnimationFrame(() => document.getElementById(`visibility-${value}`)?.focus());
  }

  function onVisibilityKeydown(event: KeyboardEvent, current: AvatarVisibility): void {
    if (visSaving || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = VISIBILITY_OPTIONS.findIndex((item) => item.value === current);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? VISIBILITY_OPTIONS.length - 1
          : (currentIndex + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + VISIBILITY_OPTIONS.length) %
            VISIBILITY_OPTIONS.length;
    const next = VISIBILITY_OPTIONS[nextIndex].value;
    void chooseVisibility(next);
    focusVisibility(next);
  }

  // The welcome modal is a global overlay owned by App.svelte, so this arms a
  // one-shot flag instead of navigating anywhere — App drains it and opens the
  // modal over whatever view is showing.
  function reopenOnboarding(): void {
    updateState((state) => (state.onboardingRequested = true));
  }
</script>

<svelte:window on:paste={onWindowPaste} />

{#if active && user}
  <section class="settings-card">
    <div class="settings-head">
      <div class="pic-edit">
        <AvatarImage {user} size={96} alt="내 아바타 사진" />
        <button class="pic-cam" type="button" aria-label="사진 변경" title="사진 변경 (복사한 이미지는 Ctrl+V로도 등록돼요)" disabled={picBusy} on:click={() => fileInput?.click()}>
          <Icon name="camera" />
        </button>
        <input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden on:change={uploadImage} />
        {#if user.hasImage}
          <button class="linkish small" type="button" disabled={picBusy} on:click={deleteImage}>사진 삭제</button>
        {/if}
        <span class="muted pic-paste-hint">{picBusy ? "사진 등록 중…" : "복사한 이미지를 Ctrl+V로 붙여넣어도 돼요"}</span>
      </div>
      <div class="settings-id">
        <h3>{user.displayName}</h3>
        <div class="muted">@{user.username}</div>
      </div>
    </div>

    <form class="settings-form" on:submit|preventDefault={saveProfile}>
      <div class="field gen-all-row">
        <button class="ghost-sm" type="button" aria-describedby={profileGenStatus ? profileGenStatusId : undefined} disabled={profileSaving || allGenBusy || introGenBusy || tagGenBusy || tagAddBusy} on:click={generateAll}>
          {allGenBusy ? "생성 중…" : "자기소개·해시태그 한 번에 생성"}
        </button>
        <span class="muted">페르소나와 스킬을 바탕으로 아바타가 자기소개와 역량 해시태그를 함께 만들어 줍니다.</span>
      </div>
      {#if profileGenStatus}
        <div class="settings-save-row compact">
          <span
            id={profileGenStatusId}
            class="settings-save-status"
            class:dirty={profileGenPartial}
            class:pending={profileGenBusy}
            class:success={Boolean(profileGenMessage)}
            class:invalid={Boolean(profileGenError && !profileGenPartial)}
            role="status"
            aria-live="polite"
          >{profileGenStatus}</span>
        </div>
      {/if}
      <label class="field">
        <span>내 이름</span>
        <input bind:value={displayName} required aria-describedby={profileStatusId} disabled={profileSaving} on:input={() => (profileError = "")} />
        <span class="field-hint">팀원의 탐색 화면에 이 이름으로 보여요.</span>
      </label>
      <label class="field">
        <span>아바타 이름</span>
        <input bind:value={alias} placeholder="예: 세바스찬" aria-describedby={profileStatusId} disabled={profileSaving} on:input={() => (profileError = "")} />
        <span class="field-hint">아바타가 대화에서 스스로를 부르는 이름 — 비우면 내 이름을 사용합니다.</span>
      </label>
      <label class="field"><span>소개 (한 줄)</span><input bind:value={bio} placeholder="어떤 아바타인지 소개하세요" aria-describedby={profileStatusId} disabled={profileSaving} on:input={() => (profileError = "")} /></label>
      <div class="field">
        <div class="field-row">
          <span>자기소개 (탐색의 소개 보기에 표시)</span>
          <button class="ghost-sm" type="button" aria-describedby={profileGenStatus ? profileGenStatusId : undefined} disabled={profileSaving || introGenBusy || allGenBusy} on:click={generateIntro}>{introGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
        </div>
        <textarea rows="4" bind:value={intro} placeholder="대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 ‘아바타가 자동 생성’ 버튼으로 만들 수 있어요" aria-describedby={profileStatusId} disabled={profileSaving} on:input={() => (profileError = "")}></textarea>
      </div>
      <div class="field">
        <div class="field-row">
          <span>역량 해시태그 (탐색에서 검색됨)</span>
          <div class="field-row-actions">
            {#if hashtags.length > 0}
              <button class="ghost-sm" type="button" aria-describedby={profileGenStatus ? profileGenStatusId : undefined} disabled={profileSaving || tagAddBusy || tagGenBusy || allGenBusy} on:click={addTags}>{tagAddBusy ? "추가 중…" : "더 추가"}</button>
            {/if}
            <button class="ghost-sm" type="button" aria-describedby={profileGenStatus ? profileGenStatusId : undefined} disabled={profileSaving || tagGenBusy || tagAddBusy || allGenBusy} on:click={generateTags}>{tagGenBusy ? "생성 중…" : "아바타가 자동 생성"}</button>
          </div>
        </div>
        <HashtagChipEditor bind:tags={hashtags} disabled={profileSaving} />
      </div>
      <label class="field"><span>페르소나 (행동 지침)</span><textarea rows="4" bind:value={persona} placeholder="이 아바타가 어떻게 행동해야 하는지 (선택)" aria-describedby={profileStatusId} disabled={profileSaving} on:input={() => (profileError = "")}></textarea></label>
      <div class="settings-save-row">
        <span id={profileStatusId} class="settings-save-status" class:dirty={profileDirty && !profileSaving && !profileError} class:pending={profileSaving} class:invalid={Boolean(profileError)} role="status" aria-live="polite">{profileSaveStatus}</span>
        <button class="primary" type="submit" disabled={profileSaving || !profileDirty}>{profileSaving ? "저장 중…" : "프로필 저장"}</button>
      </div>
    </form>
  </section>

  <section class="settings-card">
    <h3>공개 범위</h3>
    <div class="visibility-row">
      <div class="seg-control" role="radiogroup" aria-label="아바타 공개 범위" aria-busy={visSaving}>
        {#each VISIBILITY_OPTIONS as opt}
          <button
            id={`visibility-${opt.value}`}
            type="button"
            class="seg-btn"
            class:active={visibility === opt.value}
            role="radio"
            aria-checked={visibility === opt.value}
            tabindex={visibility === opt.value ? 0 : -1}
            disabled={visSaving}
            on:click={() => chooseVisibility(opt.value)}
            on:keydown={(event) => onVisibilityKeydown(event, opt.value)}
          >
            {opt.label}
          </button>
        {/each}
      </div>
      <p class="muted">
        {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.desc || ""}{visSaving ? " 저장 중…" : ""}
      </p>
    </div>
    <label class="shared-account-item">
      <input
        type="checkbox"
        checked={sharedAccount}
        disabled={sharedSaving}
        aria-busy={sharedSaving}
        on:change={(event) => toggleSharedAccount(event.currentTarget.checked)}
      />
      <span class="shared-account-meta">
        <strong>공용 계정</strong>
        <span class="muted">이 계정을 팀 공용 계정으로 표시합니다. 팀원이 이 아바타와 대화하면서 지식 저장소를 직접 수정하고 커밋할 수 있게 돼요. 저장소 생성·연결 같은 설정 변경은 계속 소유자만 할 수 있습니다.</span>
      </span>
    </label>
  </section>

  <section class="settings-card">
    <div class="panel-section-head">
      <div>
        <h3>시작 안내</h3>
        <p class="muted">초기 설정 상태와 체험 시나리오를 다시 볼 수 있어요.</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost" on:click={reopenOnboarding}>온보딩 안내 다시 보기</button>
      </div>
    </div>
  </section>
{/if}

<style>
  .pic-paste-hint {
    font-size: var(--t-xs);
    text-align: center;
    max-width: 140px;
    line-height: 1.35;
  }
  /* .shared-account-item / .shared-account-meta moved to
     styles/60-settings-admin.css (global). */
</style>
