import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import AvatarImage from "./AvatarImage";
import Icon from "./Icon";
import HashtagChipEditor from "./HashtagChipEditor";
import Toggle from "./Toggle";
import { api, refreshMe } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { normalizeTags } from "../lib/format";
import { downscaleImageToDataUrl, pastedImageFile } from "../lib/dom";
import { cx, useAppState, useWindowEvent } from "../lib/hooks";
import { getMotionPref, setMotionPref } from "../lib/motion";
import { notify, readState, replaceState, updateState } from "../lib/state";
import type { AvatarVisibility, User } from "../lib/types";
import "./SettingsProfileTab.css";

export interface SettingsProfileTabProps {
  active?: boolean;
}

const VISIBILITY_OPTIONS: { value: AvatarVisibility; label: string; desc: string }[] = [
  { value: "group", label: "팀 공개", desc: "모든 팀원(가입이 승인된 사용자)이 탐색에서 찾아 대화할 수 있어요. 팀원끼리는 서로 신뢰하므로 대화에서 확장 권한 도구도 쓸 수 있어요." },
  { value: "private", label: "비공개", desc: "나만 볼 수 있어요. 팀원 사이의 신뢰 관계는 그대로예요." },
];

const profileStatusId = "settings-profile-save-status";
const profileGenStatusId = "settings-profile-generation-status";

interface ProfileForm {
  displayName: string;
  alias: string;
  bio: string;
  intro: string;
  persona: string;
  hashtags: string[];
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}

function isProfileDirty(user: User | null, form: ProfileForm): boolean {
  return Boolean(
    user &&
      (form.displayName !== (user.displayName || "") ||
        form.alias !== (user.alias || "") ||
        form.bio !== (user.bio || "") ||
        form.intro !== (user.intro || "") ||
        form.persona !== (user.persona || "") ||
        !sameTags(form.hashtags, user.hashtags || [])),
  );
}

/**
 * A value the markup shows AND a function reads later — after an `await`, or
 * from a handler that can run before the next render. The state is what
 * renders; the ref is written with it, so such a function always reads the
 * current value, as it did when this was one plain variable.
 */
function useLiveState<T>(initial: T): [T, (next: T) => void, { readonly current: T }] {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(next);
  });
  return [value, set.current, ref];
}

export default function SettingsProfileTab({ active = false }: SettingsProfileTabProps) {
  const user = useAppState().user;

  // 움직임 줄이기 — device-local like the theme (lib/motion.ts), so there is no
  // save round-trip and nothing to roll back.
  const [motionReduced] = useState(() => getMotionPref() === "reduce");
  function changeMotion(reduce: boolean): void {
    setMotionPref(reduce ? "reduce" : "full");
  }

  // profile form — initialised ONCE (the tab is always mounted — see SettingsView).
  const [u0] = useState(() => readState().user);
  const [displayName, setDisplayName, displayNameRef] = useLiveState(u0?.displayName || "");
  const [alias, setAlias, aliasRef] = useLiveState(u0?.alias || "");
  const [bio, setBio, bioRef] = useLiveState(u0?.bio || "");
  const [intro, setIntro, introRef] = useLiveState(u0?.intro || "");
  const [persona, setPersona, personaRef] = useLiveState(u0?.persona || "");
  const [hashtags, setHashtags, hashtagsRef] = useLiveState<string[]>([...(u0?.hashtags || [])]);
  const [profileSaving, setProfileSaving, profileSavingRef] = useLiveState(false);
  const [introGenBusy, setIntroGenBusy, introGenBusyRef] = useLiveState(false);
  const [tagGenBusy, setTagGenBusy, tagGenBusyRef] = useLiveState(false);
  const [tagAddBusy, setTagAddBusy, tagAddBusyRef] = useLiveState(false);
  const [allGenBusy, setAllGenBusy, allGenBusyRef] = useLiveState(false);
  const [picBusy, setPicBusy, picBusyRef] = useLiveState(false);
  const [profileError, setProfileError] = useState("");
  const [profileGenError, setProfileGenError] = useState("");
  const [profileGenMessage, setProfileGenMessage] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [syncedProfileUserId, setSyncedProfileUserId] = useState(u0?.id || "");

  // visibility
  const [visibility, setVisibility, visibilityRef] = useLiveState<AvatarVisibility>(u0?.visibility || "group");
  const [visSaving, setVisSaving, visSavingRef] = useLiveState(false);

  // shared (communal) account
  const [sharedAccount, setSharedAccount, sharedAccountRef] = useLiveState(Boolean(u0?.sharedAccount));
  const [sharedSaving, setSharedSaving, sharedSavingRef] = useLiveState(false);

  function syncProfileForm(next: User): void {
    setDisplayName(next.displayName || "");
    setAlias(next.alias || "");
    setBio(next.bio || "");
    setIntro(next.intro || "");
    setPersona(next.persona || "");
    setHashtags([...(next.hashtags || [])]);
    setVisibility(next.visibility || "group");
    setSharedAccount(Boolean(next.sharedAccount));
    setSyncedProfileUserId(next.id);
    setProfileError("");
    setProfileGenError("");
    setProfileGenMessage("");
  }

  /** The form as it is NOW (not as of the last render) — what a save sends. */
  function formNow(): ProfileForm {
    return {
      displayName: displayNameRef.current,
      alias: aliasRef.current,
      bio: bioRef.current,
      intro: introRef.current,
      persona: personaRef.current,
      hashtags: hashtagsRef.current,
    };
  }

  const profileDirty = isProfileDirty(user, { displayName, alias, bio, intro, persona, hashtags });
  const profileGenBusy = Boolean(introGenBusy || tagGenBusy || tagAddBusy || allGenBusy);
  const profileGenPartial = Boolean(profileGenError && profileGenError.includes("초안만 채워졌습니다"));
  const profileGenStatus = profileGenBusy ? "자동 생성 중입니다." : profileGenError ? profileGenError : profileGenMessage;
  const profileSaveStatus = profileSaving
    ? "저장 중…"
    : profileError
      ? `저장 실패: ${profileError}`
      : profileDirty
        ? "저장하지 않은 변경 사항이 있습니다."
        : "저장됨";
  // Another account took over the session: load ITS profile into the form, once
  // nothing of the previous one is still in flight.
  if (user?.id && user.id !== syncedProfileUserId && !profileSaving && !profileGenBusy && !picBusy && !visSaving && !sharedSaving) {
    syncProfileForm(user);
  }

  async function saveProfile(): Promise<void> {
    if (profileSavingRef.current || !isProfileDirty(readState().user, formNow())) return;
    setProfileSaving(true);
    setProfileError("");
    try {
      const { user: next } = await api<{ user: User }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify(formNow()),
      });
      syncProfileForm(next);
      replaceState({ user: next });
      notify("프로필을 저장했습니다.", "ok");
    } catch (err) {
      const message = (err as Error).message;
      setProfileError(message);
      notify(`저장 실패: ${message}`, "warn");
    } finally {
      setProfileSaving(false);
    }
  }

  async function generateIntro(): Promise<void> {
    if (profileSavingRef.current || introGenBusyRef.current || allGenBusyRef.current) return;
    setIntroGenBusy(true);
    setProfileGenError("");
    setProfileGenMessage("");
    try {
      const { intro: next } = await api<{ intro: string }>("/api/me/intro/generate", { method: "POST" });
      if (next) {
        setIntro(next);
        const message = "자기소개 초안이 채워졌습니다.";
        setProfileGenMessage(message);
        notify(`${message} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else {
        setProfileGenMessage("생성된 자기소개가 없습니다.");
        notify("생성된 자기소개가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      const message = `자기소개 생성 실패: ${(err as Error).message}`;
      setProfileGenError(message);
      notify(message, "warn");
    } finally {
      setIntroGenBusy(false);
    }
  }

  async function generateTags(): Promise<void> {
    if (profileSavingRef.current || tagGenBusyRef.current || allGenBusyRef.current) return;
    setTagGenBusy(true);
    setProfileGenError("");
    setProfileGenMessage("");
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" });
      if (next?.length) {
        setHashtags([...next]);
        const message = "해시태그 초안이 채워졌습니다.";
        setProfileGenMessage(message);
        notify(`${message} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else {
        setProfileGenMessage("생성된 해시태그가 없습니다.");
        notify("생성된 해시태그가 없습니다. 스킬이나 플러그인을 먼저 연결해 보세요.", "info");
      }
    } catch (err) {
      const message = `해시태그 생성 실패: ${(err as Error).message}`;
      setProfileGenError(message);
      notify(message, "warn");
    } finally {
      setTagGenBusy(false);
    }
  }

  // Generate MORE hashtags without discarding the current ones: send the
  // existing tags so the avatar proposes only new, distinct ones, then merge
  // (normalizeTags dedupes + caps at 12). For when the current set feels thin.
  async function addTags(): Promise<void> {
    if (profileSavingRef.current || tagAddBusyRef.current || tagGenBusyRef.current || allGenBusyRef.current) return;
    setTagAddBusy(true);
    setProfileGenError("");
    setProfileGenMessage("");
    try {
      const { hashtags: next } = await api<{ hashtags: string[] }>("/api/me/hashtags/generate", {
        method: "POST",
        body: JSON.stringify({ existing: hashtagsRef.current }),
      });
      if (next?.length) {
        // Merged into the tags as they are NOW — chips edited while the request
        // was out are kept.
        const before = hashtagsRef.current.length;
        const merged = normalizeTags([...hashtagsRef.current, ...next]);
        setHashtags(merged);
        const added = merged.length - before;
        notify(
          added > 0
            ? `해시태그 ${added}개를 추가했습니다. 저장하려면 프로필 저장을 누르세요.`
            : "추가할 새 해시태그가 없습니다. 이미 충분히 채워져 있어요.",
          "info",
        );
        setProfileGenMessage(added > 0 ? `해시태그 ${added}개를 추가했습니다.` : "추가할 새 해시태그가 없습니다.");
      } else {
        setProfileGenMessage("추가할 새 해시태그가 없습니다.");
        notify("추가할 새 해시태그가 없습니다. 페르소나나 스킬을 먼저 보강해 보세요.", "info");
      }
    } catch (err) {
      const message = `해시태그 추가 실패: ${(err as Error).message}`;
      setProfileGenError(message);
      notify(message, "warn");
    } finally {
      setTagAddBusy(false);
    }
  }

  // Generate the self-introduction AND capability hashtags in one click. Fires
  // both headless endpoints in parallel; a partial success still fills what it
  // can (allSettled). Like the individual buttons, neither result is persisted —
  // the owner reviews then saves.
  async function generateAll(): Promise<void> {
    if (profileSavingRef.current || allGenBusyRef.current || introGenBusyRef.current || tagGenBusyRef.current || tagAddBusyRef.current) return;
    setAllGenBusy(true);
    setProfileGenError("");
    setProfileGenMessage("");
    try {
      const [introRes, tagsRes] = await Promise.allSettled([
        api<{ intro: string }>("/api/me/intro/generate", { method: "POST" }),
        api<{ hashtags: string[] }>("/api/me/hashtags/generate", { method: "POST" }),
      ]);
      if (introRes.status === "fulfilled" && introRes.value.intro) setIntro(introRes.value.intro);
      if (tagsRes.status === "fulfilled" && tagsRes.value.hashtags?.length) setHashtags([...tagsRes.value.hashtags]);

      const okIntro = introRes.status === "fulfilled" && !!introRes.value.intro;
      const okTags = tagsRes.status === "fulfilled" && !!tagsRes.value.hashtags?.length;
      if (okIntro && okTags) {
        const message = "자기소개와 해시태그 초안이 채워졌습니다.";
        setProfileGenMessage(message);
        notify(`${message} 저장하려면 프로필 저장을 누르세요.`, "info");
      } else if (okIntro || okTags) {
        const message = `${okIntro ? "자기소개" : "해시태그"} 초안만 채워졌습니다.`;
        setProfileGenError(message);
        notify(`${message} 나머지는 다시 시도해 주세요. 저장하려면 프로필 저장을 누르세요.`, "warn");
      } else {
        // Report whichever call actually rejected — the intro might have resolved
        // empty while the hashtags call threw, so don't hardcode introRes.
        const reason =
          introRes.status === "rejected"
            ? (introRes.reason as Error).message
            : tagsRes.status === "rejected"
              ? (tagsRes.reason as Error).message
              : "결과가 비어 있습니다.";
        const message = `자동 생성 실패: ${reason}`;
        setProfileGenError(message);
        notify(message, "warn");
      }
    } finally {
      setAllGenBusy(false);
    }
  }

  // ---- visibility ----
  async function chooseVisibility(val: AvatarVisibility): Promise<void> {
    if (visSavingRef.current || val === visibilityRef.current) return;
    const prev = visibilityRef.current;
    setVisibility(val);
    setVisSaving(true);
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ visibility: val }) });
      replaceState({ user: next });
      if (next.visibility !== val) {
        setVisibility(next.visibility);
        const label = VISIBILITY_OPTIONS.find((o) => o.value === next.visibility)?.label || next.visibility;
        notify(`공개 범위가 서버에서 ${label}(으)로 저장되었습니다.`, "warn");
      } else {
        const label = VISIBILITY_OPTIONS.find((o) => o.value === val)?.label || val;
        notify(`공개 범위를 ${label}(으)로 변경했습니다.`, "ok");
      }
    } catch (err) {
      setVisibility(prev);
      notify(`공개 범위 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      setVisSaving(false);
    }
  }

  // ---- shared (communal) account ----
  async function toggleSharedAccount(on: boolean): Promise<void> {
    if (sharedSavingRef.current) return;
    const prev = sharedAccountRef.current;
    setSharedAccount(on);
    setSharedSaving(true);
    try {
      const { user: next } = await api<{ user: User }>("/api/me", { method: "PATCH", body: JSON.stringify({ sharedAccount: on }) });
      replaceState({ user: next });
      setSharedAccount(next.sharedAccount);
      notify(
        next.sharedAccount
          ? "공용 계정으로 설정했습니다. 팀원이 이 아바타와 대화하며 지식 저장소를 수정·커밋할 수 있어요."
          : "공용 계정 설정을 해제했습니다. 지식 저장소 수정은 다시 소유자 전용이 됩니다.",
        "ok",
      );
    } catch (err) {
      setSharedAccount(prev);
      notify(`공용 계정 설정 변경 실패: ${(err as Error).message}`, "warn");
    } finally {
      setSharedSaving(false);
    }
  }

  // ---- avatar image ----
  // Shared by the file picker AND clipboard paste (Ctrl+V): resize → PUT → refresh.
  async function applyAvatarImage(file: File): Promise<void> {
    if (picBusyRef.current) return;
    setPicBusy(true);
    try {
      const image = await resizeImage(file, 256);
      await api("/api/me/avatar-image", { method: "PUT", body: JSON.stringify({ image }) });
    } catch (err) {
      notify(`사진 업로드 실패: ${(err as Error).message}`, "warn");
      setPicBusy(false);
      return;
    }
    try {
      await refreshMe();
      notify("아바타 사진을 변경했습니다.", "ok");
    } catch (err) {
      notify(`사진은 변경했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setPicBusy(false);
    }
  }

  async function uploadImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget;
    if (picBusyRef.current) {
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
    if (!active || picBusyRef.current) return;
    const file = pastedImageFile(event.clipboardData);
    if (!file) return;
    const target = event.target as HTMLElement | null;
    const inField = Boolean(target?.closest?.("input, textarea, [contenteditable]"));
    const hasText = Boolean(event.clipboardData?.getData("text/plain"));
    if (inField && hasText) return;
    event.preventDefault();
    void applyAvatarImage(file);
  }
  useWindowEvent("paste", onWindowPaste);

  async function deleteImage(): Promise<void> {
    if (picBusyRef.current) return;
    if (!(await confirmAction("아바타 사진을 삭제할까요?"))) return;
    setPicBusy(true);
    try {
      await api("/api/me/avatar-image", { method: "DELETE" });
    } catch (err) {
      notify(`사진 삭제 실패: ${(err as Error).message}`, "warn");
      setPicBusy(false);
      return;
    }
    try {
      await refreshMe();
      notify("아바타 사진을 삭제했습니다.", "ok");
    } catch (err) {
      notify(`사진은 삭제했지만 상태 새로고침에 실패했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setPicBusy(false);
    }
  }

  async function resizeImage(file: File, max: number): Promise<string> {
    return downscaleImageToDataUrl(file, max);
  }

  function focusVisibility(value: AvatarVisibility): void {
    requestAnimationFrame(() => document.getElementById(`visibility-${value}`)?.focus());
  }

  function onVisibilityKeydown(event: KeyboardEvent<HTMLButtonElement>, current: AvatarVisibility): void {
    if (visSavingRef.current || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
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

  // The welcome modal is a global overlay owned by App, so this arms a
  // one-shot flag instead of navigating anywhere — App drains it and opens the
  // modal over whatever view is showing.
  function reopenOnboarding(): void {
    updateState((state) => (state.onboardingRequested = true));
  }

  if (!active || !user) return null;

  const genStatusRef = profileGenStatus ? profileGenStatusId : undefined;
  const clearProfileError = (): void => setProfileError("");

  return (
    <>
      <section className="settings-card cmp-settings-profile-tab">
        <div className="settings-head">
          <div className="pic-edit">
            <AvatarImage user={user} size={96} alt="내 아바타 사진" />
            <button
              className="pic-cam"
              type="button"
              aria-label="사진 변경"
              title="사진 변경 (복사한 이미지는 Ctrl+V로도 등록돼요)"
              disabled={picBusy}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="camera" />
            </button>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => void uploadImage(event)} />
            {user.hasImage && (
              <button className="linkish small" type="button" disabled={picBusy} onClick={() => void deleteImage()}>
                사진 삭제
              </button>
            )}
            <span className="muted pic-paste-hint">{picBusy ? "사진 등록 중…" : "복사한 이미지를 Ctrl+V로 붙여넣어도 돼요"}</span>
          </div>
          <div className="settings-id">
            <h3>{user.displayName}</h3>
            <div className="muted">@{user.username}</div>
          </div>
        </div>

        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
          }}
        >
          <div className="field gen-all-row">
            <button
              className="ghost-sm"
              type="button"
              aria-describedby={genStatusRef}
              disabled={profileSaving || allGenBusy || introGenBusy || tagGenBusy || tagAddBusy}
              onClick={() => void generateAll()}
            >
              {allGenBusy ? "생성 중…" : "자기소개·해시태그 한 번에 생성"}
            </button>
            <span className="muted">페르소나와 스킬을 바탕으로 아바타가 자기소개와 역량 해시태그를 함께 만들어 줍니다.</span>
          </div>
          {profileGenStatus && (
            <div className="settings-save-row compact">
              <span
                id={profileGenStatusId}
                className={cx(
                  "settings-save-status",
                  profileGenPartial && "dirty",
                  profileGenBusy && "pending",
                  Boolean(profileGenMessage) && "success",
                  Boolean(profileGenError && !profileGenPartial) && "invalid",
                )}
                role="status"
                aria-live="polite"
              >
                {profileGenStatus}
              </span>
            </div>
          )}
          <label className="field">
            <span>내 이름</span>
            <input
              value={displayName}
              required
              aria-describedby={profileStatusId}
              disabled={profileSaving}
              onChange={(event) => {
                setDisplayName(event.currentTarget.value);
                clearProfileError();
              }}
            />
            <span className="field-hint">팀원의 탐색 화면에 이 이름으로 보여요.</span>
          </label>
          <label className="field">
            <span>아바타 이름</span>
            <input
              value={alias}
              placeholder="예: 세바스찬"
              aria-describedby={profileStatusId}
              disabled={profileSaving}
              onChange={(event) => {
                setAlias(event.currentTarget.value);
                clearProfileError();
              }}
            />
            <span className="field-hint">아바타가 대화에서 스스로를 부르는 이름 — 비우면 내 이름을 사용합니다.</span>
          </label>
          <label className="field">
            <span>소개 (한 줄)</span>
            <input
              value={bio}
              placeholder="어떤 아바타인지 소개하세요"
              aria-describedby={profileStatusId}
              disabled={profileSaving}
              onChange={(event) => {
                setBio(event.currentTarget.value);
                clearProfileError();
              }}
            />
          </label>
          <div className="field">
            <div className="field-row">
              <span>자기소개 (탐색의 소개 보기에 표시)</span>
              <button
                className="ghost-sm"
                type="button"
                aria-describedby={genStatusRef}
                disabled={profileSaving || introGenBusy || allGenBusy}
                onClick={() => void generateIntro()}
              >
                {introGenBusy ? "생성 중…" : "아바타가 자동 생성"}
              </button>
            </div>
            <textarea
              rows={4}
              value={intro}
              placeholder="대화 상대에게 보여줄 자기소개. 직접 쓰거나 위의 ‘아바타가 자동 생성’ 버튼으로 만들 수 있어요"
              aria-describedby={profileStatusId}
              disabled={profileSaving}
              onChange={(event) => {
                setIntro(event.currentTarget.value);
                clearProfileError();
              }}
            />
          </div>
          <div className="field">
            <div className="field-row">
              <span>역량 해시태그 (탐색에서 검색됨)</span>
              <div className="field-row-actions">
                {hashtags.length > 0 && (
                  <button
                    className="ghost-sm"
                    type="button"
                    aria-describedby={genStatusRef}
                    disabled={profileSaving || tagAddBusy || tagGenBusy || allGenBusy}
                    onClick={() => void addTags()}
                  >
                    {tagAddBusy ? "추가 중…" : "더 추가"}
                  </button>
                )}
                <button
                  className="ghost-sm"
                  type="button"
                  aria-describedby={genStatusRef}
                  disabled={profileSaving || tagGenBusy || tagAddBusy || allGenBusy}
                  onClick={() => void generateTags()}
                >
                  {tagGenBusy ? "생성 중…" : "아바타가 자동 생성"}
                </button>
              </div>
            </div>
            <HashtagChipEditor tags={hashtags} onTagsChange={setHashtags} disabled={profileSaving} />
          </div>
          <label className="field">
            <span>페르소나 (행동 지침)</span>
            <textarea
              rows={4}
              value={persona}
              placeholder="이 아바타가 어떻게 행동해야 하는지 (선택)"
              aria-describedby={profileStatusId}
              disabled={profileSaving}
              onChange={(event) => {
                setPersona(event.currentTarget.value);
                clearProfileError();
              }}
            />
          </label>
          <div className="settings-save-row">
            <span
              id={profileStatusId}
              className={cx(
                "settings-save-status",
                profileDirty && !profileSaving && !profileError && "dirty",
                profileSaving && "pending",
                Boolean(profileError) && "invalid",
              )}
              role="status"
              aria-live="polite"
            >
              {profileSaveStatus}
            </span>
            <button className="primary" type="submit" disabled={profileSaving || !profileDirty}>
              {profileSaving ? "저장 중…" : "프로필 저장"}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-card cmp-settings-profile-tab">
        <h3>공개 범위</h3>
        <div className="visibility-row">
          <div className="seg-control" role="radiogroup" aria-label="아바타 공개 범위" aria-busy={visSaving}>
            {VISIBILITY_OPTIONS.map((opt, index) => (
              <button
                key={index}
                id={`visibility-${opt.value}`}
                type="button"
                className={cx("seg-btn", visibility === opt.value && "active")}
                role="radio"
                aria-checked={visibility === opt.value}
                tabIndex={visibility === opt.value ? 0 : -1}
                disabled={visSaving}
                onClick={() => void chooseVisibility(opt.value)}
                onKeyDown={(event) => onVisibilityKeydown(event, opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="muted">
            {VISIBILITY_OPTIONS.find((o) => o.value === visibility)?.desc || ""}
            {visSaving ? " 저장 중…" : ""}
          </p>
        </div>
        <label className="shared-account-item">
          <input
            type="checkbox"
            checked={sharedAccount}
            disabled={sharedSaving}
            aria-busy={sharedSaving}
            onChange={(event) => void toggleSharedAccount(event.currentTarget.checked)}
          />
          <span className="shared-account-meta">
            <strong>공용 계정</strong>
            <span className="muted">이 계정을 팀 공용 계정으로 표시합니다. 팀원이 이 아바타와 대화하면서 지식 저장소를 직접 수정하고 커밋할 수 있게 돼요. 저장소 생성·연결 같은 설정 변경은 계속 소유자만 할 수 있습니다.</span>
          </span>
        </label>
      </section>

      <section className="settings-card cmp-settings-profile-tab">
        <div className="panel-section-head">
          <div>
            <h3>움직임 줄이기</h3>
            <p className="muted">화면 전환 애니메이션과 답변이 부드럽게 이어져 나오는 표시를 끕니다. Windows 같은 시스템의 애니메이션 설정과는 따로 동작하고, 이 브라우저에만 저장돼요.</p>
          </div>
          <div className="head-actions">
            <Toggle on={motionReduced} label="움직임 줄이기" onChange={changeMotion} />
          </div>
        </div>
      </section>

      <section className="settings-card cmp-settings-profile-tab">
        <div className="panel-section-head">
          <div>
            <h3>시작 안내</h3>
            <p className="muted">초기 설정 상태와 체험 시나리오를 다시 볼 수 있어요.</p>
          </div>
          <div className="head-actions">
            <button type="button" className="btn ghost" onClick={reopenOnboarding}>
              온보딩 안내 다시 보기
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
