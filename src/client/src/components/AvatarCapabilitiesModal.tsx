import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import Modal from "./Modal";
import { api } from "../lib/api";
import { renderMarkdown } from "../lib/format";
import { cx } from "../lib/hooks";
import type { AvatarDetail, AvatarSummary, SkillInfo } from "../lib/types";
import "./AvatarCapabilitiesModal.css";

export interface AvatarCapabilitiesModalProps {
  avatar: AvatarSummary;
  onClose?: () => void;
}

let nextIntroModalId = 0;

/**
 * An avatar's 소개 dialog (intro + 역량). It renders a `<Modal>`, so the parent
 * renders it inside `<Presence>` with a `key`.
 */
export default function AvatarCapabilitiesModal({ avatar, onClose }: AvatarCapabilitiesModalProps) {
  const [modalId] = useState(() => `avatar-intro-${++nextIntroModalId}`);
  const titleId = `${modalId}-title`;

  const [detail, setDetail] = useState<AvatarDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState("");
  const [openSkills, setOpenSkills] = useState(() => new Set<string>());

  // The explore card already carries name + hashtags, so the dialog can name the
  // avatar before the detail request lands; the detail wins once it arrives (it is
  // the fresher copy, and intro/plugins live only there).
  const shown = detail ?? avatar;

  async function loadDetail(): Promise<void> {
    setDetailLoading(true);
    setDetailError("");
    try {
      const result = await api<{ avatar: AvatarDetail }>(`/api/avatars/${encodeURIComponent(avatar.id)}`);
      setDetail(result.avatar);
    } catch (err) {
      setDetailError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function loadSkills(): Promise<void> {
    setSkillsLoading(true);
    setSkillsError("");
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(avatar.id)}/skills`);
      setSkills(result.skills || []);
    } catch (err) {
      setSkillsError((err as Error).message);
    } finally {
      setSkillsLoading(false);
    }
  }

  useEffect(() => {
    // Both requests are independent — the intro must not wait on the skills call,
    // which lazily resolves plugin roots server-side (it may clone).
    void loadDetail();
    void loadSkills();
    // Once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleSkill(key: string) {
    setOpenSkills((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function close() {
    onClose?.();
  }

  // The same sanitized html as before, re-rendered only when the intro text changes.
  const intro = detail?.intro || "";
  const introHtml = useMemo(() => (intro ? renderMarkdown(intro) : ""), [intro]);

  return (
    <Modal cardClass="avatar-intro-card cmp-avatar-capabilities-modal" ariaLabelledby={titleId} onClose={close}>
      <h2 id={titleId}>이 아바타의 역량</h2>
      <p className="ai-sub">{shown.displayName} 아바타가 사용할 수 있는 도구</p>

      {detailLoading ? (
        <p className="ai-note" role="status">
          소개를 불러오는 중…
        </p>
      ) : detailError ? (
        <div className="ai-error" role="alert">
          <span>{detailError}</span>
          <button className="linkish small" type="button" onClick={() => void loadDetail()}>
            다시 시도
          </button>
        </div>
      ) : intro ? (
        <div className="ai-intro md" dangerouslySetInnerHTML={{ __html: introHtml }} />
      ) : null}

      {shown.hashtags?.length ? (
        <div className="ai-tags">
          {shown.hashtags.map((tag, index) => (
            <span key={index} className="tag accent">
              #{tag}
            </span>
          ))}
        </div>
      ) : null}

      {detail?.plugins?.length ? (
        <section className="ai-section">
          <h3 className="ai-section-title">플러그인</h3>
          <div className="ai-section-body">
            {detail.plugins.map((plugin, index) => (
              <div key={index} className="ai-plugin">
                <span className="ai-plugin-name">{plugin.label || plugin.repo}</span>
                {plugin.label ? <span className="ai-plugin-repo">{plugin.repo}</span> : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="ai-section" aria-busy={skillsLoading ? "true" : "false"}>
        <h3 className="ai-section-title">스킬</h3>
        <div className="ai-section-body">
          {skillsLoading ? (
            <p className="ai-note" role="status">
              스킬 목록을 불러오는 중…
            </p>
          ) : skillsError ? (
            <div className="ai-error" role="alert">
              <span>{skillsError}</span>
              <button className="linkish small" type="button" onClick={() => void loadSkills()}>
                다시 시도
              </button>
            </div>
          ) : !skills.length ? (
            <p className="ai-note">사용 가능한 스킬이 없습니다.</p>
          ) : (
            <div className="ai-skill-list" role="list" aria-label={`${shown.displayName} 스킬`}>
              {skills.map((skill, index) => {
                const key = `${skill.name}-${skill.source || "default"}-${index}`;
                const descId = `${modalId}-skill-desc-${index}`;
                const hasDescription = Boolean(skill.description);
                const fromPlugin = Boolean(skill.source && skill.source !== "default");
                return (
                  <div key={index} className={cx("ai-skill", openSkills.has(key) && "open")} role="listitem">
                    <button
                      className="ai-skill-head"
                      type="button"
                      disabled={!hasDescription}
                      aria-expanded={hasDescription ? openSkills.has(key) : undefined}
                      aria-describedby={hasDescription ? descId : undefined}
                      onClick={() => toggleSkill(key)}
                    >
                      {hasDescription ? (
                        <span className="ai-skill-caret" aria-hidden="true">
                          <Icon name="chevron-right" size={12} />
                        </span>
                      ) : null}{" "}
                      <span className="ai-skill-name">{skill.name}</span>{" "}
                      {fromPlugin ? <span className="ai-skill-src">{skill.source}</span> : null}
                    </button>
                    {hasDescription ? (
                      <p id={descId} className="ai-skill-desc">
                        {skill.description}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <div className="ai-actions">
        <button className="linkish" type="button" onClick={close}>
          닫기
        </button>
      </div>
    </Modal>
  );
}
