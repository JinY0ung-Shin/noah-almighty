<script lang="ts">
  // 관리자 ▸ 도구·스킬 ▸ 공유 스킬 관리 — the system admin takes a teammate's
  // shared skill out of the WHOLE team's discovery (GET /api/admin/shared-skills
  // + POST/DELETE /api/admin/shared-skills/blocks). Replaced the group admins'
  // per-group channel blocks (single team, 2026-11-06). A block is keyed by
  // (owner, skill NAME), so an unshare→re-share keeps it; copies already learned
  // and the owner's own list are untouched (the server enforces this at query
  // time). Always mounted by AdminView with an `active` prop.
  //
  // `otherBlocks` are blocks in force with NO active share row behind them (the
  // owner is suspended, or the skill is not / no longer shared). They still bite
  // the moment the share comes back, so they are listed and unblockable too.
  import AvatarImage from "./AvatarImage.svelte";
  import { api } from "../lib/api";
  import { confirmAction } from "../lib/confirm";
  import { timeLabel } from "../lib/format";
  import { notify } from "../lib/state";
  import type { SharedSkillBlockEntry, SharedSkillModeration } from "../lib/types";

  export let active = false;

  let initialized = false;
  let skills: SharedSkillModeration[] = [];
  let otherBlocks: SharedSkillBlockEntry[] = [];
  let loading = false;
  let loaded = false;
  let error = "";
  let blockBusyKey = "";
  let query = "";
  const skillKey = (s: { ownerUserId: string; skillName: string }) => `${s.ownerUserId}:${s.skillName}`;

  $: if (active && !initialized) void load();
  // Every block in force: on a listed share, or with no share behind it.
  $: blockedCount = skills.filter((s) => s.blocked).length + otherBlocks.length;
  $: needle = query.trim().toLowerCase();
  $: shown = needle
    ? skills.filter((s) => hit([s.displayName, s.skillName, s.owner.displayName, s.owner.username], needle))
    : skills;
  $: shownOther = needle
    ? otherBlocks.filter((b) => hit([b.skillName, b.ownerDisplayName, b.ownerUsername], needle))
    : otherBlocks;
  $: anyListed = skills.length + otherBlocks.length > 0;

  function hit(values: (string | null | undefined)[], q: string): boolean {
    return values.some((value) => Boolean(value) && value!.toLowerCase().includes(q));
  }

  async function load(): Promise<void> {
    initialized = true;
    if (loading) return;
    loading = true;
    error = "";
    try {
      const result = await api<{ skills: SharedSkillModeration[]; otherBlocks?: SharedSkillBlockEntry[] }>(
        "/api/admin/shared-skills",
      );
      skills = result.skills;
      otherBlocks = Array.isArray(result.otherBlocks) ? result.otherBlocks : [];
      loaded = true;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function unblockOther(entry: SharedSkillBlockEntry): Promise<void> {
    if (blockBusyKey) return;
    const confirmed = await confirmAction(
      `@${entry.ownerUsername}의 "${entry.skillName}" 스킬 차단을 해제할까요? 지금은 공유 목록에 없지만, 다시 공유되면 팀원에게 보이게 됩니다.`,
      { title: "차단을 해제할까요?", confirmLabel: "차단 해제" },
    );
    if (!confirmed) return;
    blockBusyKey = skillKey(entry);
    try {
      await api(
        `/api/admin/shared-skills/blocks/${encodeURIComponent(entry.ownerUserId)}/${encodeURIComponent(entry.skillName)}`,
        { method: "DELETE" },
      );
      notify(`"${entry.skillName}" 스킬 차단을 해제했습니다.`, "ok");
      await load();
    } catch (err) {
      notify(`공유 스킬 차단 해제 실패: ${(err as Error).message}`, "warn");
    } finally {
      blockBusyKey = "";
    }
  }

  async function toggleBlock(skill: SharedSkillModeration): Promise<void> {
    if (blockBusyKey) return;
    const title = skill.displayName || skill.skillName;
    const confirmed = await confirmAction(
      skill.blocked
        ? `@${skill.owner.username}의 "${title}" 스킬 차단을 해제할까요? 팀원에게 다시 보입니다.`
        : `@${skill.owner.username}의 "${title}" 스킬을 차단할까요? 모든 팀원의 스킬 배우기 목록에서 사라집니다. 이미 전수받은 사본과 공유한 사람 본인의 목록은 그대로예요.`,
      skill.blocked
        ? { title: "차단을 해제할까요?", confirmLabel: "차단 해제" }
        : { title: "공유 스킬을 차단할까요?", confirmLabel: "차단", tone: "danger" },
    );
    if (!confirmed) return;
    blockBusyKey = skillKey(skill);
    try {
      if (skill.blocked) {
        await api(
          `/api/admin/shared-skills/blocks/${encodeURIComponent(skill.ownerUserId)}/${encodeURIComponent(skill.skillName)}`,
          { method: "DELETE" },
        );
        notify(`"${title}" 스킬 차단을 해제했습니다.`, "ok");
      } else {
        await api("/api/admin/shared-skills/blocks", {
          method: "POST",
          body: JSON.stringify({ ownerUserId: skill.ownerUserId, skillName: skill.skillName }),
        });
        notify(`"${title}" 스킬을 팀 전체에서 차단했습니다.`, "ok");
      }
      await load();
    } catch (err) {
      notify(`공유 스킬 차단 설정 실패: ${(err as Error).message}`, "warn");
    } finally {
      blockBusyKey = "";
    }
  }
</script>

{#if active}
  <section class="settings-card" aria-labelledby="admin-shared-skills-heading">
    <div class="panel-section-head">
      <div>
        <h3 id="admin-shared-skills-heading">공유 스킬 관리</h3>
        <p class="muted">
          팀원이 자기 지식 저장소에서 공유한 스킬입니다. 차단하면 모든 팀원의 스킬 배우기 목록과 아바타의 스킬 찾기에서 빠집니다.
          이미 전수받은 사본과 공유한 사람 본인의 목록은 그대로이고, 공유를 해제했다가 다시 공유해도 차단은 유지돼요.
        </p>
      </div>
      <div class="head-actions">
        <span class="muted small nowrap">
          {error && !loaded ? "조회 실패" : loading && !loaded ? "불러오는 중" : `총 ${skills.length}개${blockedCount ? ` · 차단 ${blockedCount}개` : ""}`}
        </span>
        <button class="linkish small" type="button" disabled={loading} on:click={() => void load()}>새로고침</button>
      </div>
    </div>
    {#if loading && !loaded}
      <div class="muted" role="status">불러오는 중…</div>
    {:else if error && !loaded}
      <div class="warn-box" role="alert">
        공유 스킬을 불러오지 못했습니다: {error}
        <button class="linkish" type="button" disabled={loading} on:click={() => void load()}>다시 시도</button>
      </div>
    {:else if !anyListed}
      <div class="empty-note">아직 팀원이 공유한 스킬이 없습니다.</div>
    {:else}
      {#if error}
        <div class="warn-box" role="alert">
          최신 목록을 불러오지 못했습니다: {error}
          <button class="linkish" type="button" disabled={loading} on:click={() => void load()}>다시 시도</button>
        </div>
      {/if}
      <div class="admin-users-head">
        <input
          type="search"
          class="admin-search"
          placeholder="스킬 이름·공유한 사람 검색"
          aria-label="공유 스킬 검색"
          bind:value={query}
        />
        <span class="muted nowrap">표시 {shown.length + shownOther.length}개 / 전체 {skills.length + otherBlocks.length}개</span>
      </div>
      {#if needle && !shown.length && !shownOther.length}
        <div class="muted pad">
          "{query.trim()}"에 맞는 공유 스킬이 없습니다.
          <button class="linkish small" type="button" on:click={() => (query = "")}>검색어 지우기</button>
        </div>
      {/if}
      {#if !skills.length}
        <div class="empty-note">아직 팀원이 공유한 스킬이 없습니다.</div>
      {:else if shown.length}
        <div class="plugin-rows">
          {#each shown as skill (skillKey(skill))}
            <div class="plugin-row" class:busy={blockBusyKey === skillKey(skill)} aria-busy={blockBusyKey === skillKey(skill) ? "true" : "false"}>
              <AvatarImage user={skill.owner} size={32} alt="" />
              <div class="pr-main">
                <strong>{skill.displayName || skill.skillName}</strong>
                <div class="pr-sub">
                  {skill.owner.displayName} · @{skill.owner.username}
                  {#if skill.displayName && skill.displayName !== skill.skillName} · {skill.skillName}{/if}
                  · 전수 {skill.learnCount}회
                </div>
              </div>
              {#if skill.blocked}<span class="tag read">차단됨</span>{/if}
              <div class="pr-actions">
                <button
                  class="ghost-sm"
                  class:danger={!skill.blocked}
                  type="button"
                  title={skill.blocked ? "팀원에게 다시 보이게 합니다" : "모든 팀원에게 보이지 않게 합니다"}
                  aria-label={`${skill.displayName || skill.skillName} ${skill.blocked ? "차단 해제" : "차단"}`}
                  disabled={Boolean(blockBusyKey)}
                  on:click={() => toggleBlock(skill)}
                >{skill.blocked ? "차단 해제" : "차단"}</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {#if shownOther.length}
        <section class="admin-other-blocks" aria-labelledby="admin-other-blocks-heading">
          <h4 id="admin-other-blocks-heading" class="knowledge-sub">공유 목록에 없는 차단 {otherBlocks.length}개</h4>
          <p class="muted small">
            공유한 사람이 정지됐거나 지금은 공유하지 않는 스킬의 차단입니다. 차단은 그대로 유지되어, 다시 공유되더라도 팀원에게 보이지 않아요.
          </p>
          <div class="plugin-rows">
            {#each shownOther as entry (skillKey(entry))}
              <div class="plugin-row" class:busy={blockBusyKey === skillKey(entry)} aria-busy={blockBusyKey === skillKey(entry) ? "true" : "false"}>
                <AvatarImage user={{ id: entry.ownerUserId, displayName: entry.ownerDisplayName, username: entry.ownerUsername, hasImage: false }} size={32} alt="" />
                <div class="pr-main">
                  <strong>{entry.skillName}</strong>
                  <div class="pr-sub">
                    {entry.ownerDisplayName} · @{entry.ownerUsername}
                    · {entry.blockedAt ? `차단 ${timeLabel(entry.blockedAt)}` : "차단 시각 기록 없음"}
                  </div>
                </div>
                {#if entry.ownerSuspended}<span class="tag danger">정지됨</span>{/if}
                <span class="tag read">차단됨</span>
                <div class="pr-actions">
                  <button
                    class="ghost-sm"
                    type="button"
                    title="차단을 해제합니다 — 다시 공유되면 팀원에게 보입니다"
                    aria-label={`${entry.skillName} (@${entry.ownerUsername}) 차단 해제`}
                    disabled={Boolean(blockBusyKey)}
                    on:click={() => unblockOther(entry)}
                  >차단 해제</button>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/if}
  </section>
{/if}
