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
import { useLayoutEffect, useRef, useState } from "react";
import AvatarImage from "./AvatarImage";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { timeLabel } from "../lib/format";
import { cx } from "../lib/hooks";
import { notify } from "../lib/state";
import type { SharedSkillBlockEntry, SharedSkillModeration } from "../lib/types";

export interface AdminSharedSkillsPanelProps {
  active?: boolean;
}

const skillKey = (s: { ownerUserId: string; skillName: string }) => `${s.ownerUserId}:${s.skillName}`;

function hit(values: (string | null | undefined)[], q: string): boolean {
  return values.some((value) => Boolean(value) && value!.toLowerCase().includes(q));
}

export default function AdminSharedSkillsPanel({ active = false }: AdminSharedSkillsPanelProps) {
  const initialized = useRef(false);
  const [skills, setSkills] = useState<SharedSkillModeration[]>([]);
  const [otherBlocks, setOtherBlocks] = useState<SharedSkillBlockEntry[]>([]);
  const [loading, setLoadingState] = useState(false);
  // What load() itself checks: it is also called from continuations that run
  // after an `await`, which must see the flag as it is then.
  const loadingRef = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [blockBusyKey, setBlockBusyKey] = useState("");
  const [query, setQuery] = useState("");

  // Every block in force: on a listed share, or with no share behind it.
  const blockedCount = skills.filter((s) => s.blocked).length + otherBlocks.length;
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? skills.filter((s) => hit([s.displayName, s.skillName, s.owner.displayName, s.owner.username], needle))
    : skills;
  const shownOther = needle
    ? otherBlocks.filter((b) => hit([b.skillName, b.ownerDisplayName, b.ownerUsername], needle))
    : otherBlocks;
  const anyListed = skills.length + otherBlocks.length > 0;

  function setLoading(next: boolean): void {
    loadingRef.current = next;
    setLoadingState(next);
  }

  async function load(): Promise<void> {
    initialized.current = true;
    if (loadingRef.current) return;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ skills: SharedSkillModeration[]; otherBlocks?: SharedSkillBlockEntry[] }>(
        "/api/admin/shared-skills",
      );
      setSkills(result.skills);
      setOtherBlocks(Array.isArray(result.otherBlocks) ? result.otherBlocks : []);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function unblockOther(entry: SharedSkillBlockEntry): Promise<void> {
    if (blockBusyKey) return;
    const confirmed = await confirmAction(
      `@${entry.ownerUsername}의 "${entry.skillName}" 스킬 차단을 해제할까요? 지금은 공유 목록에 없지만, 다시 공유되면 팀원에게 보이게 됩니다.`,
      { title: "차단을 해제할까요?", confirmLabel: "차단 해제" },
    );
    if (!confirmed) return;
    setBlockBusyKey(skillKey(entry));
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
      setBlockBusyKey("");
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
    setBlockBusyKey(skillKey(skill));
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
      setBlockBusyKey("");
    }
  }

  if (!active) return null;

  return (
    <section className="settings-card" aria-labelledby="admin-shared-skills-heading">
      <div className="panel-section-head">
        <div>
          <h3 id="admin-shared-skills-heading">공유 스킬 관리</h3>
          <p className="muted">
            팀원이 자기 지식 저장소에서 공유한 스킬입니다. 차단하면 모든 팀원의 스킬 배우기 목록과 아바타의 스킬 찾기에서 빠집니다.
            이미 전수받은 사본과 공유한 사람 본인의 목록은 그대로이고, 공유를 해제했다가 다시 공유해도 차단은 유지돼요.
          </p>
        </div>
        <div className="head-actions">
          <span className="muted small nowrap">
            {error && !loaded
              ? "조회 실패"
              : loading && !loaded
                ? "불러오는 중"
                : `총 ${skills.length}개${blockedCount ? ` · 차단 ${blockedCount}개` : ""}`}
          </span>
          <button className="linkish small" type="button" disabled={loading} onClick={() => void load()}>
            새로고침
          </button>
        </div>
      </div>
      {loading && !loaded ? (
        <div className="muted" role="status">
          불러오는 중…
        </div>
      ) : error && !loaded ? (
        <div className="warn-box" role="alert">
          공유 스킬을 불러오지 못했습니다: {error}{" "}
          <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      ) : !anyListed ? (
        <div className="empty-note">아직 팀원이 공유한 스킬이 없습니다.</div>
      ) : (
        <>
          {error && (
            <div className="warn-box" role="alert">
              최신 목록을 불러오지 못했습니다: {error}{" "}
              <button className="linkish" type="button" disabled={loading} onClick={() => void load()}>
                다시 시도
              </button>
            </div>
          )}
          <div className="admin-users-head">
            <input
              type="search"
              className="admin-search"
              placeholder="스킬 이름·공유한 사람 검색"
              aria-label="공유 스킬 검색"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <span className="muted nowrap">
              표시 {shown.length + shownOther.length}개 / 전체 {skills.length + otherBlocks.length}개
            </span>
          </div>
          {needle && !shown.length && !shownOther.length ? (
            <div className="muted pad">
              "{query.trim()}"에 맞는 공유 스킬이 없습니다.{" "}
              <button className="linkish small" type="button" onClick={() => setQuery("")}>
                검색어 지우기
              </button>
            </div>
          ) : null}
          {!skills.length ? (
            <div className="empty-note">아직 팀원이 공유한 스킬이 없습니다.</div>
          ) : shown.length ? (
            <div className="plugin-rows">
              {shown.map((skill) => (
                <div
                  key={skillKey(skill)}
                  className={cx("plugin-row", blockBusyKey === skillKey(skill) && "busy")}
                  aria-busy={blockBusyKey === skillKey(skill) ? "true" : "false"}
                >
                  <AvatarImage user={skill.owner} size={32} alt="" />
                  <div className="pr-main">
                    <strong>{skill.displayName || skill.skillName}</strong>
                    <div className="pr-sub">
                      {skill.owner.displayName} · @{skill.owner.username}{" "}
                      {skill.displayName && skill.displayName !== skill.skillName ? <> · {skill.skillName}</> : null}{" "}
                      · 전수 {skill.learnCount}회
                    </div>
                  </div>
                  {skill.blocked && <span className="tag read">차단됨</span>}
                  <div className="pr-actions">
                    <button
                      className={cx("ghost-sm", !skill.blocked && "danger")}
                      type="button"
                      title={skill.blocked ? "팀원에게 다시 보이게 합니다" : "모든 팀원에게 보이지 않게 합니다"}
                      aria-label={`${skill.displayName || skill.skillName} ${skill.blocked ? "차단 해제" : "차단"}`}
                      disabled={Boolean(blockBusyKey)}
                      onClick={() => void toggleBlock(skill)}
                    >
                      {skill.blocked ? "차단 해제" : "차단"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {shownOther.length ? (
            <section className="admin-other-blocks" aria-labelledby="admin-other-blocks-heading">
              <h4 id="admin-other-blocks-heading" className="knowledge-sub">
                공유 목록에 없는 차단 {otherBlocks.length}개
              </h4>
              <p className="muted small">
                공유한 사람이 정지됐거나 지금은 공유하지 않는 스킬의 차단입니다. 차단은 그대로 유지되어, 다시 공유되더라도 팀원에게 보이지 않아요.
              </p>
              <div className="plugin-rows">
                {shownOther.map((entry) => (
                  <div
                    key={skillKey(entry)}
                    className={cx("plugin-row", blockBusyKey === skillKey(entry) && "busy")}
                    aria-busy={blockBusyKey === skillKey(entry) ? "true" : "false"}
                  >
                    <AvatarImage
                      user={{ id: entry.ownerUserId, displayName: entry.ownerDisplayName, username: entry.ownerUsername, hasImage: false }}
                      size={32}
                      alt=""
                    />
                    <div className="pr-main">
                      <strong>{entry.skillName}</strong>
                      <div className="pr-sub">
                        {entry.ownerDisplayName} · @{entry.ownerUsername}{" "}
                        · {entry.blockedAt ? `차단 ${timeLabel(entry.blockedAt)}` : "차단 시각 기록 없음"}
                      </div>
                    </div>
                    {entry.ownerSuspended && <span className="tag danger">정지됨</span>}
                    <span className="tag read">차단됨</span>
                    <div className="pr-actions">
                      <button
                        className="ghost-sm"
                        type="button"
                        title="차단을 해제합니다 — 다시 공유되면 팀원에게 보입니다"
                        aria-label={`${entry.skillName} (@${entry.ownerUsername}) 차단 해제`}
                        disabled={Boolean(blockBusyKey)}
                        onClick={() => void unblockOther(entry)}
                      >
                        차단 해제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
