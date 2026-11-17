// 설정 ▸ 지식·플러그인 ▸ 지식 저장소 card: where the signed-in user's brain
// notes are kept. For vault home `repo` (today's layout) it renders NOTHING.
// For home `memory` it says, in one compact block, that the notes live in the
// memory service and the repository receives a copy, the copy's state, what a
// direct git edit of the vault paths does, a notice when the repository holds
// notes the memory service does not, and the hold: `checking` (a repository was
// just connected and the server has not looked at it yet — a neutral line, no
// button) or `confirm` (it found brain notes there — the one confirmation that
// lets the copy replace them, naming the repository and branch on screen).
//
// Only what the SERVER reported is shown: this file predicts no failure.
//
// The state lives in `usePersonalVaultStatus`, called by the always-mounted
// tab, so it survives a tab switch; this component only draws it.
import { useEffect, useRef, useState } from "react";
import "./SettingsVaultStatus.css";
import { api } from "../lib/api";
import { confirmAction } from "../lib/confirm";
import { timeLabel } from "../lib/format";
import { cx } from "../lib/hooks";
import {
  readMyPersonalVault,
  vaultMirrorFailure,
  vaultMirrorFailureText,
  vaultMirrorKind,
  vaultMirrorNoticeText,
  type MyPersonalVault,
  type VaultMirrorFailure,
} from "../lib/personalVault";
import { notify } from "../lib/state";

/** How long after a repository change the state is read once more (the server applies the change in the background). */
const FOLLOW_UP_MS = 4000;
/** While the server is still checking a newly connected repository the state is read again this often, this many times. */
const CHECKING_POLL_MS = 4000;
const CHECKING_POLL_MAX = 10;

export interface PersonalVaultStatus {
  vault: MyPersonalVault | null;
  /** The last read failed (nothing, or the previous state, is shown with it). */
  error: string;
  loading: boolean;
  confirmBusy: boolean;
  reload: () => Promise<void>;
  /** Read now and once more shortly after: a repository was connected, changed or refreshed. */
  reloadSoon: () => void;
  recheckBusy: boolean;
  /** `checking` only: ask the server to look at the connected repository again NOW (after the owner fixed a token or an address). */
  recheck: () => Promise<void>;
  /** The owner's press on the `confirm` hold, for the repository and branch the screen is showing. */
  confirmHold: (repo: string, branch: string | null) => Promise<void>;
}

export function usePersonalVaultStatus(active: boolean, userId: string): PersonalVaultStatus {
  const [vault, setVault] = useState<MyPersonalVault | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [recheckBusy, setRecheckBusy] = useState(false);
  const recheckBusyRef = useRef(false);
  // An answer for a request made before the account changed is dropped.
  const generation = useRef(0);
  const confirmBusyRef = useRef(false);
  const followUp = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loadedUserId, setLoadedUserId] = useState(userId);
  // Bumped after every read, so the `checking` follow-up is scheduled again even when a read failed.
  const [readTick, setReadTick] = useState(0);
  const checkingReads = useRef(0);

  // Another account took over the session: its state is not this one's.
  if (userId !== loadedUserId) {
    generation.current += 1;
    setLoadedUserId(userId);
    setVault(null);
    setError("");
  }

  const reload = useRef(async (): Promise<void> => {
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await api<unknown>("/api/me/personal-vault");
      if (mine !== generation.current) return;
      // A server without the route's shape (an older one behind a proxy) reads as "nothing new to show".
      setVault(readMyPersonalVault(next));
      setError("");
    } catch (err) {
      if (mine !== generation.current) return;
      setError((err as Error).message);
    } finally {
      if (mine === generation.current) {
        setLoading(false);
        setReadTick((n) => n + 1);
      }
    }
  }).current;

  const reloadSoon = useRef((): void => {
    void reload();
    if (followUp.current) clearTimeout(followUp.current);
    followUp.current = setTimeout(() => {
      followUp.current = null;
      void reload();
    }, FOLLOW_UP_MS);
  }).current;

  useEffect(() => {
    if (active && userId) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, userId]);

  useEffect(
    () => () => {
      generation.current += 1;
      if (followUp.current) clearTimeout(followUp.current);
    },
    [],
  );

  // `checking` normally lasts seconds: follow it until the server has looked, for a bounded time.
  const checking = vault?.mirror?.hold === "checking";
  useEffect(() => {
    if (!checking) {
      checkingReads.current = 0;
      return;
    }
    if (!active || checkingReads.current >= CHECKING_POLL_MAX) return;
    const timer = setTimeout(() => {
      checkingReads.current += 1;
      void reload();
    }, CHECKING_POLL_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, checking, readTick]);

  const recheck = useRef(async (): Promise<void> => {
    if (recheckBusyRef.current) return;
    recheckBusyRef.current = true;
    setRecheckBusy(true);
    try {
      // The server only STARTS the look (202); what it finds changes the state, which is then read like any other change.
      await api("/api/me/personal-vault/mirror-recheck", { method: "POST" });
      checkingReads.current = 0;
      reloadSoon();
    } catch (err) {
      notify(`다시 확인하지 못했습니다: ${(err as Error).message}`, "warn");
      void reload();
    } finally {
      recheckBusyRef.current = false;
      setRecheckBusy(false);
    }
  }).current;

  const confirmHold = useRef(async (repo: string, branch: string | null): Promise<void> => {
    if (confirmBusyRef.current) return;
    const confirmed = await confirmAction(
      "저장소에 있는 브레인 노트(CLAUDE.md, wiki/, raw/ 안의 .md 파일)를 메모리 서비스의 내용으로 바꿉니다.\n저장소에만 있던 노트는 저장소에서 지워지고, 바뀌기 전 내용은 저장소의 git 기록에 남습니다.",
      { title: "저장소의 브레인 노트를 바꿀까요?", confirmLabel: "바꾸고 사본 올리기", tone: "danger" },
    );
    if (!confirmed || confirmBusyRef.current) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    try {
      // The server refuses unless it is still waiting for THIS repository and branch to be confirmed.
      await api("/api/me/personal-vault/mirror-confirm", { method: "POST", body: JSON.stringify({ repo, branch }) });
      notify("확인했습니다. 잠시 후 저장소에 사본을 올립니다.", "ok");
      reloadSoon();
    } catch (err) {
      notify(`확인하지 못했습니다: ${(err as Error).message}`, "warn");
      // A refusal means the state moved on (another repository, a check that ran again): show what it is now.
      void reload();
    } finally {
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  }).current;

  return { vault, error, loading, confirmBusy, recheckBusy, reload, reloadSoon, recheck, confirmHold };
}

export interface SettingsVaultStatusProps {
  status: PersonalVaultStatus;
  /** The connected knowledge repository as the card shows it ("" = none: the copy has nowhere to go). */
  repo: string;
  /** Its branch as the card shows it (null = the default branch). */
  branch: string | null;
  /** Opens 권한·연결 (where the Git token is set). */
  onOpenAccess: () => void;
  /** Opens a chat with the avatar, seeded with a request to commit the repository or to settle its conflict. */
  onAskAvatar: (request: "commit" | "conflict") => void;
}

const stateHeadingId = "vault-status-heading";

export default function SettingsVaultStatus({ status, repo, branch, onOpenAccess, onAskAvatar }: SettingsVaultStatusProps) {
  const { vault, error, loading, confirmBusy, recheckBusy } = status;
  const repoConnected = Boolean(repo);

  if (!vault) {
    // Nothing is known yet: a first read in flight shows nothing (most accounts
    // have nothing to show), a failed one says so without touching the card.
    if (!error) return null;
    return (
      <div className="vault-status-failed error-note cmp-settings-vault-status" role="alert">
        브레인 노트의 보관 상태를 불러오지 못했습니다: {error}{" "}
        <button className="linkish small" type="button" disabled={loading} onClick={() => void status.reload()}>
          다시 시도
        </button>
      </div>
    );
  }
  if (vault.home !== "memory") return null;

  const mirror = vault.mirror;
  const kind = mirror ? vaultMirrorKind(mirror) : null;
  // Only a failure the SERVER recorded is shown (it alone knows which token the push used).
  const failure: VaultMirrorFailure | null = kind === "failed" ? vaultMirrorFailure(mirror!.error || "") : null;
  const failureText = kind === "failed" ? vaultMirrorFailureText(mirror!.error || "") : "";
  const syncedAt = timeLabel(mirror?.syncedAt);

  return (
    <div className="vault-status cmp-settings-vault-status" role="group" aria-labelledby={stateHeadingId}>
      <div className="vault-status-head">
        <strong id={stateHeadingId}>브레인 노트 보관</strong>
        <button className="linkish small" type="button" disabled={loading} onClick={() => void status.reload()}>
          {loading ? "확인 중…" : "상태 새로 고침"}
        </button>
      </div>
      {repoConnected ? (
        <p>
          브레인 노트는 메모리 서비스에 보관되고, 연결한 저장소에는 그 사본이 올라갑니다. 대상은 저장소 맨 위의 CLAUDE.md와 wiki/, raw/ 안의
          .md 파일이며, 스킬·플러그인 같은 나머지 파일은 지금처럼 저장소에 그대로 있습니다.
        </p>
      ) : (
        <p>브레인 노트는 메모리 서비스에 보관됩니다. 지식 저장소를 연결하면 그 사본이 저장소에 올라갑니다.</p>
      )}

      {repoConnected && mirror && kind === "checking" ? (
        // Nobody has looked at the repository yet: nothing to confirm, so no button.
        <div className="vault-status-state" role="status">
          <span className="vault-status-line waiting">
            <strong>연결한 저장소를 확인하는 중입니다</strong> · 이 저장소에 이미 브레인 노트가 있는지 살펴보고 있습니다. 확인이 끝날 때까지
            저장소에는 아무것도 올리지 않습니다.
          </span>
          <span className="muted">
            이 상태가 계속되면 서버가 저장소를 읽지 못하고 있는 것입니다. Git 토큰이 유효한지, 저장소 주소에 접근할 수 있는지 확인한 뒤 ‘지금
            다시 확인’을 눌러 주세요. 누르지 않아도 서버가 약 1분마다 다시 확인합니다. 그래도 풀리지 않으면 관리자에게 알려 주세요(막힌
            이유가 관리자 화면에 나옵니다).
          </span>
          <span className="vault-status-actions">
            <button className="ghost-sm" type="button" disabled={recheckBusy} onClick={() => void status.recheck()}>
              {recheckBusy ? "다시 확인하는 중…" : "지금 다시 확인"}
            </button>
            <button className="linkish small" type="button" onClick={onOpenAccess}>
              권한·연결 탭에서 Git 토큰 확인
            </button>
          </span>
        </div>
      ) : repoConnected && mirror && kind === "confirm" ? (
        <div className="vault-status-hold warn-box" role="note">
          <strong>사본 보류 중 — 확인이 필요합니다.</strong>
          <span>
            지금 연결한 저장소에는 이미 브레인 노트가 들어 있습니다. 사본을 올리면 저장소의 CLAUDE.md와 wiki/, raw/ 안의 노트가 메모리 서비스의
            내용으로 바뀝니다. 저장소에만 있던 노트는 저장소에서 지워지고, 바뀌기 전 내용은 저장소의 git 기록에 남습니다. 확인하기 전에는
            저장소를 건드리지 않습니다.
          </span>
          <button className="ghost-sm" type="button" disabled={confirmBusy} onClick={() => void status.confirmHold(repo, branch)}>
            {confirmBusy ? "확인하는 중…" : "저장소의 노트를 바꾸고 사본 올리기"}
          </button>
        </div>
      ) : repoConnected && mirror ? (
        <div className="vault-status-state" role="status">
          <span className={cx("vault-status-line", failure ? "failed" : kind === "waiting" ? "waiting" : "synced")}>
            {/* The state's name carries the colour; what follows it reads as plain text. */}
            <strong>{failure ? "사본을 올리지 못했습니다" : kind === "waiting" ? "올릴 변경이 있습니다" : "사본 최신"}</strong>
            {failure
              ? ` — ${failureText}`
              : kind === "waiting"
                ? ` · 잠시 후 자동으로 올립니다${syncedAt ? ` (마지막으로 올린 때 ${syncedAt})` : ""}`
                : syncedAt
                  ? ` · ${syncedAt}에 올림`
                  : " · 메모리 서비스로 옮긴 뒤 바뀐 노트가 없습니다"}
          </span>
          {failure === "no_token" || failure === "denied" ? (
            <button className="linkish small" type="button" onClick={onOpenAccess}>
              권한·연결 탭에서 Git 토큰 설정
            </button>
          ) : failure === "repo_dirty" ? (
            <button className="linkish small" type="button" onClick={() => onAskAvatar("commit")}>
              아바타에게 커밋 요청
            </button>
          ) : failure === "conflict" ? (
            <button className="linkish small" type="button" onClick={() => onAskAvatar("conflict")}>
              아바타에게 충돌 정리 요청
            </button>
          ) : failure === "rejected" ? (
            <span className="muted">위의 ‘새로고침’으로 저장소를 다시 가져오면 다음 시도에 올라갑니다.</span>
          ) : null}
          {failure ? <span className="muted">노트는 메모리 서비스에 그대로 저장되어 있고, 사본은 자동으로 다시 시도합니다.</span> : null}
        </div>
      ) : null}

      {repoConnected && mirror?.notice ? (
        <p className="vault-status-notice" role="note">
          {vaultMirrorNoticeText(mirror.notice)}
        </p>
      ) : null}

      {repoConnected ? (
        <p className="muted">
          저장소에서 이 파일들을 git으로 직접 고쳐도 브레인에는 반영되지 않습니다. 다음 사본이 올라갈 때 메모리 서비스의 내용으로 다시 바뀌고,
          고친 내용은 저장소의 git 기록에만 남습니다.
        </p>
      ) : null}
      {error ? (
        <p className="error-note" role="alert">
          상태를 새로 불러오지 못했습니다: {error}
        </p>
      ) : null}
    </div>
  );
}
