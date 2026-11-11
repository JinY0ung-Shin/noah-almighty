import { useState } from "react";
import Icon from "./Icon";
import Modal from "./Modal";
import RevealableInput from "./RevealableInput";
import { api } from "../lib/api";
import { TOUR_SEED_NOTICE, openSeededChat } from "../lib/chat";
import { copyText } from "../lib/dom";
import { cx, useLatest, usePropState } from "../lib/hooks";
import { goView } from "../lib/nav";
import {
  accessReady as isAccessReady,
  knowledgeReady as isKnowledgeReady,
  profileReady as isProfileReady,
} from "../lib/setupReadiness";
import { notify, replaceState, updateState } from "../lib/state";
import type { SettingsTab, User } from "../lib/types";
import { MCP_TOOL_GROUPS, effectiveMcpToolGroups } from "../../../shared/mcpToolGroups";
import { TOUR_SCENARIOS, type TourScenario } from "../../../shared/tourScenarios";

export interface OnboardingModalProps {
  user: User;
  confluenceConfigured?: boolean;
  githubHost?: string;
  onClose?: () => void;
}

export default function OnboardingModal({
  user: userProp,
  confluenceConfigured = false,
  githubHost = "github.com",
  onClose,
}: OnboardingModalProps) {
  const [user, setUser] = usePropState(userProp);
  const [gitToken, setGitToken] = useState("");
  const [confluencePat, setConfluencePat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sshBusy, setSshBusy] = useState(false);

  const tokensHost = (githubHost || "github.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const sshPublicKey = (user.sshPublicKey || "").trim();
  const sshConfigured = Boolean(sshPublicKey) || user.secretNames?.includes("SSH_PRIVATE_KEY");
  // Shared with the explore 시작하기 checklist so the two surfaces cannot drift
  // again (lib/setupReadiness.ts carries the superset rule).
  const profileReady = isProfileReady(user);
  const knowledgeReady = isKnowledgeReady(user);
  const accessReady = isAccessReady(user);
  // Same SOURCE the chat empty state filters its cards on: the admin per-group
  // tool policy the server folds into `user.allowedMcpToolGroups` (null = no
  // policy, nothing blocked). A tour this run could never take is not offered.
  const browserBlocked = user.allowedMcpToolGroups != null && !user.allowedMcpToolGroups.includes("browser");
  const tourScenarios = TOUR_SCENARIOS.filter((scenario) => !scenario.needsBrowser || !browserBlocked);
  const saveLabel = sshBusy
    ? "SSH 생성 중…"
    : busy
      ? gitToken.trim() || confluencePat.trim()
        ? "저장 중…"
        : "시작 중…"
      : gitToken.trim() || confluencePat.trim()
        ? "저장하고 시작"
        : "시작하기";
  // openTour runs on a later tick (and past an await): it reads the current value.
  const browserBlockedRef = useLatest(browserBlocked);

  function done() {
    onClose?.();
  }

  function jumpToSettings(tab: SettingsTab) {
    if (busy || sshBusy) return;
    done();
    window.setTimeout(() => goView("settings", tab), 0);
  }

  function startExplore() {
    if (busy || sshBusy) return;
    done();
    window.setTimeout(() => goView("explore"), 0);
  }

  function startTour(scenario: TourScenario) {
    if (busy || sshBusy) return;
    // Same shape as jumpToSettings: close first, then hand off on the next tick
    // so the chat the tour opens isn't built underneath a closing dialog.
    done();
    window.setTimeout(() => void openTour(scenario), 0);
  }

  /**
   * Open a fresh chat with the owner's own avatar carrying the literal
   * "/tour <slug>" — the SERVER expands it, so no agent-facing prompt text lives
   * on this side. Seeded, never sent: the owner reads the line and presses 보내기.
   */
  async function openTour(scenario: TourScenario) {
    try {
      await openSeededChat(`/tour ${scenario.slug}`, TOUR_SEED_NOTICE);
    } catch (err) {
      notify(`체험 시나리오를 열지 못했습니다: ${(err as Error).message}`, "warn");
      return;
    }
    if (!scenario.needsBrowser || browserBlockedRef.current) return;
    // A card whose prerequisite is left to the user fails on step one, so the
    // browser tool group goes on in the SAME gesture (which also brings up the
    // composer's bridge badge — itself the path to the install guide). Written
    // in the picker's canonical order, like the chat view's own toggle.
    updateState((state) => {
      const pane = state.chatPanes.find((item) => item.id === state.activePaneId);
      if (!pane) return;
      const selected = effectiveMcpToolGroups(pane.mcpToolGroups);
      if (selected.includes("browser")) return;
      pane.mcpToolGroups = MCP_TOOL_GROUPS.map((group) => group.id).filter(
        (id) => id === "browser" || selected.includes(id),
      );
    });
  }

  async function generateSsh() {
    if (busy || sshBusy || sshConfigured) return;
    setSshBusy(true);
    setError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me/ssh-key", { method: "POST" });
      replaceState({ user: next });
      setUser(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSshBusy(false);
    }
  }

  async function submit() {
    if (busy || sshBusy) return;
    setBusy(true);
    setError("");
    try {
      const token = gitToken.trim();
      const pat = confluencePat.trim();
      if (token) {
        const { user: next } = await api<{ user: User }>("/api/me/git-token", { method: "PUT", body: JSON.stringify({ token }) });
        replaceState({ user: next });
      }
      if (pat) {
        const { user: next } = await api<{ user: User }>("/api/me/secrets/CONFLUENCE_PAT", { method: "PUT", body: JSON.stringify({ value: pat }) });
        replaceState({ user: next });
      }
      if (token || pat) notify("설정을 저장했습니다.", "ok");
      done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal cardClass="onboard-card" ariaLabelledby="onboarding-title" closeDisabled={busy || sshBusy} onClose={done}>
      <img className="login-mark" src="/icon-192.png" alt="" aria-hidden="true" width="48" height="48" />
      <h2 id="onboarding-title">아바타 사용 준비하기</h2>
      <p className="muted">먼저 프로필과 지식 저장소만 잡아두면 탐색과 대화에서 바로 쓰기 좋습니다.</p>

      <div className="onboard-quick" aria-label="초기 설정 상태">
        <button className={cx("onboard-step", profileReady && "done")} type="button" disabled={busy || sshBusy} onClick={() => jumpToSettings("profile")}>
          <span className="onboard-step-icon">
            <Icon name={profileReady ? "check" : "user"} />
          </span>
          <span className="onboard-step-copy">
            <strong>프로필</strong>
            <span>{profileReady ? "기본 소개가 준비됨" : "이름·소개·역량 해시태그"}</span>
          </span>
        </button>
        <button className={cx("onboard-step", knowledgeReady && "done")} type="button" disabled={busy || sshBusy} onClick={() => jumpToSettings("knowledge")}>
          <span className="onboard-step-icon">
            <Icon name={knowledgeReady ? "check" : "book"} />
          </span>
          <span className="onboard-step-copy">
            <strong>지식 저장소</strong>
            <span>{knowledgeReady ? "저장소 연결됨" : "업무 기억을 쌓을 저장소"}</span>
          </span>
        </button>
        <button className={cx("onboard-step", accessReady && "done")} type="button" disabled={busy || sshBusy} onClick={() => jumpToSettings("access")}>
          <span className="onboard-step-icon">
            <Icon name={accessReady ? "check" : "key"} />
          </span>
          <span className="onboard-step-copy">
            <strong>권한 연결</strong>
            <span>{accessReady ? "작업 자격증명 일부 설정됨" : "Git, SSH, 문서 토큰"}</span>
          </span>
        </button>
        <button className="onboard-step primary-step" type="button" disabled={busy || sshBusy} onClick={startExplore}>
          <span className="onboard-step-icon">
            <Icon name="chat" />
          </span>
          <span className="onboard-step-copy">
            <strong>대화 시작</strong>
            <span>탐색으로 이동</span>
          </span>
        </button>
      </div>

      {tourScenarios.length ? (
        <div className="onboard-tours">
          <div className="onboard-tours-head">
            <strong>바로 체험해 보기</strong>
            <span>카드를 누르면 새 대화 입력창에 준비됩니다. 보내기만 누르면 시작해요.</span>
          </div>
          <div className="onboard-tour-grid" role="group" aria-label="체험 시나리오">
            {tourScenarios.map((scenario) => (
              <button key={scenario.slug} className="onboard-tour" type="button" disabled={busy || sshBusy} onClick={() => startTour(scenario)}>
                <strong>{scenario.titleKo}</strong>
                <small>{scenario.descriptionKo}</small>
                <span className="tag">{scenario.durationKo}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="onboard-connect">
        <h3>선택 설정</h3>
        <p className="muted">지금 건너뛰어도 됩니다. 필요한 연결은 내 아바타 설정에서 언제든 다시 추가할 수 있습니다.</p>
      </div>

      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        aria-busy={busy ? "true" : "false"}
      >
        <div className="onboard-setup-list">
          <details className="onboard-setup-item">
            <summary>
              <strong>Git 토큰</strong>
              <span>비공개 저장소 읽기와 지식 저장소 커밋·푸시에 사용합니다.</span>
            </summary>
            <div className="onboard-setup-body">
              <label className="field">
                <span>
                  사내 Git 토큰 (GIT_TOKEN, 선택){" "}
                  <a className="linkish" href={`https://${tokensHost}/settings/tokens`} target="_blank" rel="noopener noreferrer">
                    토큰 만들러 가기 ↗
                  </a>
                </span>
                <RevealableInput
                  value={gitToken}
                  onValueChange={setGitToken}
                  name="token"
                  placeholder="사내 GitHub PAT (GIT_TOKEN)"
                  ariaLabel="사내 Git 토큰 GIT_TOKEN"
                  revealLabel="토큰"
                  disabled={busy}
                />
              </label>
            </div>
          </details>

          <details className="onboard-setup-item">
            <summary>
              <strong>SSH 키</strong>
              <span>서버 로그 확인, 파일 점검, 원격 명령 같은 작업에 사용합니다.</span>
            </summary>
            <div className="onboard-setup-body">
              <p className="muted">개인키는 암호화되어 저장되고 도구 실행 시에만 주입됩니다. 공개키만 접속 대상 서버에 등록하면 됩니다.</p>
              <div className="git-token-status muted">
                {sshPublicKey ? (
                  <span className="token-set">● SSH_PRIVATE_KEY 생성됨</span>
                ) : sshConfigured ? (
                  <span className="token-set">● SSH_PRIVATE_KEY 설정됨</span>
                ) : (
                  <span>SSH_PRIVATE_KEY 미설정</span>
                )}
              </div>
              <div className="git-token-actions">
                <button className="primary" type="button" disabled={busy || sshConfigured || sshBusy} onClick={() => void generateSsh()}>
                  {sshConfigured ? (sshPublicKey ? "SSH 키 생성됨" : "SSH 키 설정됨") : sshBusy ? "생성 중…" : "SSH 키 생성"}
                </button>
              </div>
              {sshPublicKey ? (
                <div className="ssh-public-key-box">
                  <label className="field">
                    <span>공개키 (서버 authorized_keys에 등록)</span>
                    <div className="password-field">
                      <input readOnly value={sshPublicKey} aria-label="SSH 공개키" />
                      <button
                        className="password-toggle"
                        type="button"
                        aria-label="공개키 복사"
                        title="공개키 복사"
                        onClick={(event) => void copyText(sshPublicKey, event.currentTarget)}
                      >
                        복사
                      </button>
                    </div>
                  </label>
                </div>
              ) : null}
            </div>
          </details>

          {confluenceConfigured ? (
            <details className="onboard-setup-item">
              <summary>
                <strong>Confluence 연결</strong>
                <span>문서를 검색·조회하고 페이지 작성·수정 작업을 맡길 수 있습니다.</span>
              </summary>
              <div className="onboard-setup-body">
                <label className="field">
                  <span>Confluence PAT (CONFLUENCE_PAT, 선택)</span>
                  <RevealableInput
                    value={confluencePat}
                    onValueChange={setConfluencePat}
                    name="confluence"
                    placeholder="Confluence PAT (CONFLUENCE_PAT)"
                    ariaLabel="Confluence Personal Access Token CONFLUENCE_PAT"
                    revealLabel="토큰"
                    disabled={busy}
                  />
                </label>
              </div>
            </details>
          ) : null}
        </div>

        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="onboard-actions">
          <button className="linkish" type="button" disabled={busy || sshBusy} onClick={done}>
            건너뛰기
          </button>
          <button className="primary" type="submit" disabled={busy || sshBusy}>
            {saveLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
