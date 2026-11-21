// 설정 ▸ 지식·플러그인 ▸ 지식 저장소 card: where the signed-in user's brain
// notes are kept. One small block under a connected repository: the notes live
// in the memory service and are not copied into the repository — and, when the
// server's check of the service just failed (or this server has none), that the
// brain cannot be used right now.
//
// Only what the SERVER reported is shown: it checks the memory service on every
// read of this state (`service`), so the card states an outage instead of
// looking fine while the brain itself cannot be used.
//
// The state lives in `usePersonalVaultStatus`, called by the always-mounted
// tab, so it survives a tab switch; this component only draws it.
import { useEffect, useRef, useState } from "react";
import "./SettingsVaultStatus.css";
import { api } from "../lib/api";
import { readMyPersonalVault, type MyPersonalVault } from "../lib/personalVault";

export interface PersonalVaultStatus {
  vault: MyPersonalVault | null;
  /** The last read failed (nothing, or the previous state, is shown with it). */
  error: string;
  loading: boolean;
  reload: () => Promise<void>;
}

/** `active`: the card is on screen (the tab is open and a repository is connected) — the state is read each time that becomes true. */
export function usePersonalVaultStatus(active: boolean, userId: string): PersonalVaultStatus {
  const [vault, setVault] = useState<MyPersonalVault | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // An answer for a request made before the account changed is dropped.
  const generation = useRef(0);
  const [loadedUserId, setLoadedUserId] = useState(userId);

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
      // An answer without the route's shape reads as "nothing to show".
      setVault(readMyPersonalVault(next));
      setError("");
    } catch (err) {
      if (mine !== generation.current) return;
      setError((err as Error).message);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }).current;

  useEffect(() => {
    if (active && userId) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, userId]);

  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );

  return { vault, error, loading, reload };
}

export interface SettingsVaultStatusProps {
  status: PersonalVaultStatus;
}

const stateHeadingId = "vault-status-heading";

export default function SettingsVaultStatus({ status }: SettingsVaultStatusProps) {
  const { vault, error, loading } = status;

  if (!vault) {
    // Nothing is known yet: a first read in flight shows nothing, a failed one says so without touching the card.
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

  return (
    <div className="vault-status cmp-settings-vault-status" role="group" aria-labelledby={stateHeadingId}>
      <div className="vault-status-head">
        <strong id={stateHeadingId}>브레인 노트 보관</strong>
        <button className="linkish small" type="button" disabled={loading} onClick={() => void status.reload()}>
          {loading ? "확인 중…" : "상태 새로 고침"}
        </button>
      </div>
      {!vault.serviceConfigured ? (
        // The server has no memory service: nothing of the brain works now.
        <p className="error-note" role="alert">
          이 서버에 메모리 서비스가 연결되어 있지 않습니다. 브레인 노트를 읽거나 쓸 수 없습니다. 관리자에게 알려 주세요.
        </p>
      ) : vault.service === "unavailable" || vault.service === "refused" ? (
        // The server's check of the service just now failed.
        <p className="error-note" role="alert">
          {vault.service === "unavailable" ? "지금 메모리 서비스에 연결하지 못했습니다." : "지금 메모리 서비스가 이 브레인 노트를 열어 주지 않습니다."}{" "}
          브레인 노트를 읽거나 쓸 수 없지만, 저장된 노트는 그대로 있습니다. 잠시 뒤 ‘상태 새로 고침’으로 다시 확인해 보고, 계속되면 관리자에게
          알려 주세요.
        </p>
      ) : null}
      <p>
        브레인 노트는 메모리 서비스에 보관되며, 연결한 저장소로는 복사되지 않습니다. 스킬·플러그인 같은 나머지 파일은 지금처럼 저장소에
        있습니다.
      </p>
      {error ? (
        <p className="error-note" role="alert">
          상태를 새로 불러오지 못했습니다: {error}
        </p>
      ) : null}
    </div>
  );
}
