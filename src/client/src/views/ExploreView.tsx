import { useEffect, useRef, useState } from "react";
import AvatarCapabilitiesModal from "../components/AvatarCapabilitiesModal";
import AvatarImage from "../components/AvatarImage";
import Icon from "../components/Icon";
import { api } from "../lib/api";
import { TOUR_SEED_NOTICE, openSeededChat, startChatWith } from "../lib/chat";
import { cx, useAppState } from "../lib/hooks";
import { loadAvatars } from "../lib/loaders";
import { goView } from "../lib/nav";
import { Presence } from "../lib/presence";
import {
  accessReady as isAccessReady,
  knowledgeReady as isKnowledgeReady,
  profileReady as isProfileReady,
} from "../lib/setupReadiness";
import { notify, updateState } from "../lib/state";
import type { AvatarSummary } from "../lib/types";
import type { TourSlug } from "../../../shared/tourScenarios";

const TEAM_HINT = "팀원이 아바타를 팀 공개로 두면 여기에 보여요. 새 팀원은 관리자가 가입을 승인하면 합류합니다.";

// ---- 시작하기 checklist -------------------------------------------------
// The card detects its own progress instead of asking the owner to remember
// what they did: every item reads the same state the avatar acts on, and the
// card removes itself at 4/4 without a dismissal being stored.

interface SetupItem {
  key: string;
  label: string;
  /** Shown while incomplete; a 완료 item always renders the check instead. */
  icon: string;
  done: boolean;
  run: () => void;
}

function matches(av: AvatarSummary, parts: string[]) {
  const hay = [av.displayName, av.alias, av.username, av.bio, ...(av.hashtags || [])].filter(Boolean).join(" ").toLowerCase();
  return parts.every((part) => hay.includes(part));
}

/** Dismissed earlier this session — returns next session, which is intended. */
function dismissedInStorage(): boolean {
  try {
    return sessionStorage.getItem("setupBannerDismissed") === "1";
  } catch {
    return false;
  }
}

/** Seed "/tour <slug>" the way the welcome modal does — the server expands it. */
async function seedTour(slug: TourSlug): Promise<void> {
  try {
    await openSeededChat(`/tour ${slug}`, TOUR_SEED_NOTICE);
  } catch (err) {
    notify(`체험 시나리오를 열지 못했습니다: ${(err as Error).message}`, "warn");
  }
}

export default function ExploreView() {
  const state = useAppState();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Shown on the cards (state) and read by the re-entry guard (ref).
  const [loadingAvatarId, setLoadingAvatarIdState] = useState<string | null>(null);
  const loadingAvatarIdRef = useRef<string | null>(null);
  function setLoadingAvatarId(next: string | null): void {
    loadingAvatarIdRef.current = next;
    setLoadingAvatarIdState(next);
  }
  const searchInput = useRef<HTMLInputElement | null>(null);
  /** The avatar whose 소개 dialog is open (intro + 역량), or null when closed. */
  const [introAvatar, setIntroAvatar] = useState<AvatarSummary | null>(null);

  const [setupBannerDismissed, setSetupBannerDismissed] = useState(false);
  // Read once, when the view mounts: after that only this view's own 닫기 can
  // change the answer, and it sets `setupBannerDismissed` too.
  const [storedDismissal] = useState(dismissedInStorage);

  /**
   * 첫 스킬 = "does my knowledge repo hold at least one skill". `null` means the
   * question is still unanswered, which is NOT the same as "no" — see the
   * visibility rule below.
   *
   * `/api/skill-share/mine` is the only endpoint that answers exactly this: it
   * lists the owner's own `skills/<slug>` dirs. `/api/avatars/:id/skills` (the
   * slash menu's source) mixes bundled "default" and plugin skills into one
   * list, and separating out the repo ones needs the server's Korean source
   * label — a constant `tsconfig.client.json` does not expose to the client, so
   * using it would mean a new hand-mirror. It is also the heavier call: it
   * syncs every enabled plugin repo on top of the same knowledge-repo refresh.
   */
  const [ownSkillCount, setOwnSkillCount] = useState<number | null>(null);
  /** One request per mount, settled or failed. */
  const skillProbeStarted = useRef(false);

  async function load(force = false): Promise<void> {
    setLoading(true);
    setError("");
    try {
      await loadAvatars(force);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function probeOwnSkills(): Promise<void> {
    if (skillProbeStarted.current) return;
    skillProbeStarted.current = true;
    try {
      const result = await api<{ repoConfigured: boolean; skills: unknown[] }>("/api/skill-share/mine");
      setOwnSkillCount(result.repoConfigured ? (result.skills?.length ?? 0) : 0);
    } catch {
      // Fail CLOSED: a failed probe must not tick the item off. Marking it done
      // on an error could push the card to 4/4 and hide setup the owner has not
      // actually finished — the opposite of what the card exists for.
      setOwnSkillCount(0);
    }
  }

  function dismissSetupBanner() {
    try {
      sessionStorage.setItem("setupBannerDismissed", "1");
    } catch {
      /* ignore */
    }
    setSetupBannerDismissed(true);
  }

  const user = state.user;
  const displayQuery = (state.exploreQuery || "").trim();
  const query = displayQuery.toLowerCase();
  const tokens = query ? query.split(/\s+/).map((item) => item.replace(/^#+/, "")).filter(Boolean) : [];
  const rank = (av: AvatarSummary) => (av.id === user?.id ? 0 : 1);
  const sorted = [...state.avatars].sort((a, b) => rank(a) - rank(b) || (a.displayName || "").localeCompare(b.displayName || ""));
  const avatars = tokens.length ? sorted.filter((av) => matches(av, tokens)) : sorted;
  // Shared with the welcome modal's quick steps — see lib/setupReadiness.ts for
  // the superset rule the two used to disagree on.
  const profileReady = isProfileReady(user);
  const knowledgeReady = isKnowledgeReady(user);
  const accessReady = isAccessReady(user);
  // 아바타는 팀원(승인된 사용자)에게만, 그리고 팀 공개일 때만 보이므로 팀원이
  // 아직 없거나 모두 비공개면 자기 아바타만 남습니다. 빈 목록처럼 보이는 이유를
  // 카드 아래에서 설명해 줍니다.
  const hasPeerAvatars = state.avatars.some((av) => av.id !== user?.id);

  const dismissedThisSession = setupBannerDismissed || storedDismissal;
  // Lazy: only an owner who still has the card AND already has a repo can have
  // own skills, so nobody else pays for a request that refreshes their clone.
  const wantsSkillProbe = Boolean(user) && !dismissedThisSession && knowledgeReady;
  useEffect(() => {
    if (wantsSkillProbe) void probeOwnSkills();
    // `probeOwnSkills` guards itself (one request per mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsSkillProbe]);

  useEffect(() => {
    void load();
    // Once, when the view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setupItems = [
    {
      key: "profile",
      label: "프로필",
      icon: "user",
      done: profileReady,
      run: () => goView("settings", "profile"),
    },
    {
      // The capture tour's first step creates or connects the repo with the
      // avatar's own tools, so an unconfigured owner belongs IN it, not in a
      // settings form.
      key: "knowledge",
      label: "지식 저장소",
      icon: "book",
      done: knowledgeReady,
      run: () => void seedTour("capture"),
    },
    {
      // Tokens and SSH keys genuinely need the owner's hands — no tour can
      // paste a credential for them.
      key: "access",
      label: "권한 연결",
      icon: "key",
      done: accessReady,
      run: () => goView("settings", "access"),
    },
    {
      key: "skill",
      label: "첫 스킬",
      icon: "sparkles",
      done: (ownSkillCount ?? 0) > 0,
      run: () => void seedTour("skill"),
    },
  ] satisfies SetupItem[];
  const completedCount = setupItems.filter((item) => item.done).length;
  const firstIncomplete = setupItems.find((item) => !item.done) ?? null;
  const showSetupBanner =
    Boolean(user) &&
    !dismissedThisSession &&
    completedCount < setupItems.length &&
    // The skill answer only DECIDES visibility for an owner whose other three
    // are already done; painting the card before it lands would flash a setup
    // prompt at someone who finished setup long ago.
    !(ownSkillCount === null && profileReady && knowledgeReady && accessReady);
  const resultStatus = loading
    ? "아바타 목록을 불러오는 중입니다."
    : error
      ? `아바타 목록을 불러오지 못했습니다: ${error}`
      : !state.avatars.length
        ? "팀원의 아바타가 아직 없습니다."
        : !avatars.length
          ? `${displayQuery} 검색 결과가 없습니다.`
          : displayQuery
            ? `${displayQuery} 검색 결과 ${avatars.length}개가 있습니다.`
            : `아바타 ${avatars.length}개가 있습니다.`;

  async function openChat(av: AvatarSummary) {
    if (loadingAvatarIdRef.current) return;
    setLoadingAvatarId(av.id);
    try {
      await startChatWith(av);
    } catch (err) {
      notify(`대화를 시작하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setLoadingAvatarId(null);
    }
  }

  function clearSearch() {
    updateState((s) => (s.exploreQuery = ""));
    searchInput.current?.focus();
  }

  return (
    <>
      <header className="view-header">
        <div>
          <h1>탐색</h1>
          <p>팀원의 아바타와 대화를 시작하세요</p>
        </div>
      </header>

      <div className="view-body scroll-thin" aria-busy={loading}>
        {showSetupBanner ? (
          <div className="setup-banner">
            <div className="sb-copy">
              <strong>
                아바타 시작하기 · {completedCount}/{setupItems.length} 완료
              </strong>
              <span>끝낸 항목은 자동으로 체크됩니다. 남은 항목을 누르면 이어서 준비할 수 있어요.</span>
            </div>
            <div className="setup-steps" aria-label="아바타 시작하기 진행 상태">
              {setupItems.map((item) => (
                <button
                  key={item.key}
                  className={cx("setup-step", item.done && "done")}
                  type="button"
                  aria-label={`${item.label} ${item.done ? "완료" : "필요"}`}
                  onClick={item.run}
                >
                  <Icon name={item.done ? "check" : item.icon} /> <span>{item.label}</span>
                </button>
              ))}
            </div>
            <div className="sb-actions">
              <button className="primary small" type="button" onClick={() => firstIncomplete?.run()}>
                이어서 설정
              </button>
              <button className="linkish small" type="button" onClick={dismissSetupBanner}>
                닫기
              </button>
            </div>
          </div>
        ) : null}

        <div className="explore-search-bar">
          <Icon name="compass" />
          <input
            id="explore-search"
            className="explore-search"
            type="search"
            placeholder="이름·해시태그로 검색 (예: #코드리뷰)"
            aria-label="아바타 검색"
            aria-describedby="explore-results-status"
            ref={searchInput}
            value={state.exploreQuery || ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              updateState((s) => (s.exploreQuery = value));
            }}
          />
          {displayQuery ? (
            <button
              className="msg-act explore-search-clear"
              type="button"
              aria-label="검색어 지우기"
              title="검색어 지우기"
              onClick={clearSearch}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
        <div className="sr-only" id="explore-results-status" role="status" aria-live="polite">
          {resultStatus}
        </div>

        {loading ? (
          <div className="muted pad" role="status">
            불러오는 중…
          </div>
        ) : error ? (
          <div className="warn-box" role="alert">
            아바타 목록을 불러오지 못했습니다: {error}{" "}
            <button className="linkish" type="button" disabled={loading} onClick={() => void load(true)}>
              다시 시도
            </button>
          </div>
        ) : !state.avatars.length ? (
          <div className="empty-note">
            {/* `.empty-note` is `white-space: pre-line`: the line breaks are part of the copy. */}
            팀원의 아바타가 아직 없습니다.{"\n"}
            {TEAM_HINT}
            {"\n"}
            <button className="linkish small" type="button" onClick={() => goView("settings", "profile")}>
              내 아바타 공개 범위 설정
            </button>
          </div>
        ) : !avatars.length ? (
          <div className="empty-note">
            "{displayQuery}"에 맞는 아바타가 없습니다.{" "}
            <button className="linkish small" type="button" onClick={clearSearch}>
              검색어 지우기
            </button>
          </div>
        ) : (
          <div className="avatar-grid" aria-label={displayQuery ? `${displayQuery} 검색 결과` : "아바타 목록"}>
            {avatars.map((av) => (
              // The card itself is one big button (click = start chat), so 소개 보기 has to
              // be a SIBLING control — buttons can't nest. The wrapper is the grid item;
              // the card fills it so the grid sizing and the hover ::after arrow are
              // unchanged.
              <div key={av.id} className="avatar-card-wrap">
                <button
                  className={cx("avatar-card", loadingAvatarId === av.id && "opening")}
                  type="button"
                  aria-label={`${av.alias || av.displayName} 아바타와 대화${loadingAvatarId === av.id ? ", 여는 중" : ""}`}
                  title={`${av.alias || av.displayName} 아바타와 대화`}
                  aria-busy={loadingAvatarId === av.id}
                  disabled={Boolean(loadingAvatarId)}
                  onClick={() => void openChat(av)}
                >
                  <AvatarImage user={av} size={56} alt="" />
                  <div className="ac-body">
                    <div className="ac-name">
                      <strong>{av.displayName}</strong>
                      {av.id === user?.id ? <span className="tag accent">나</span> : null}
                      {av.visibility === "private" ? <span className="tag">비공개</span> : null}
                    </div>
                    <div className="ac-handle">{loadingAvatarId === av.id ? "대화 여는 중…" : `@${av.username}`}</div>
                    {av.alias ? <div className="ac-alias">"{av.alias}"</div> : null}
                    {av.bio ? <p className="ac-bio">{av.bio}</p> : null}
                    <div className="ac-tags">
                      {(av.hashtags || []).slice(0, 6).map((tag, index) => (
                        <span key={index} className="tag accent">
                          #{tag}
                        </span>
                      ))}
                      {av.pluginCount != null ? <span className="tag">플러그인 {av.pluginCount}개</span> : null}
                    </div>
                  </div>
                </button>
                {/* Stays enabled while a chat is opening: reading the intro is harmless. */}
                <button
                  className="ac-intro"
                  type="button"
                  aria-label={`${av.alias || av.displayName} 소개 보기`}
                  title={`${av.alias || av.displayName} 소개 보기`}
                  onClick={() => setIntroAvatar(av)}
                >
                  소개
                </button>
              </div>
            ))}
            {!hasPeerAvatars && !displayQuery ? <div className="empty-note">{TEAM_HINT}</div> : null}
          </div>
        )}
      </div>

      <Presence>
        {introAvatar ? (
          <AvatarCapabilitiesModal key="intro" avatar={introAvatar} onClose={() => setIntroAvatar(null)} />
        ) : null}
      </Presence>
    </>
  );
}
