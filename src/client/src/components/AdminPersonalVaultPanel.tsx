// 관리자 ▸ 시스템 ▸ 개인 브레인 사용량: how full each teammate's brain is in the
// memory service, against the service's limits (GET /api/admin/personal-vaults/usage).
// Counts and sizes only — the route never sends a note's path or content.
//
// Read-only: the panel changes nothing, so its only button reads again. The
// route names an owner by user id; the name comes from the admin view's user
// list (`users`), and an id it does not know is shown as it came.
// Always mounted by AdminView with an `active` prop.
import { useLayoutEffect, useRef, useState } from "react";
import "./AdminPersonalVaultPanel.css";
import { api } from "../lib/api";
import { formatFileSize } from "../lib/format";
import { cx } from "../lib/hooks";
import {
  readAdminVaultUsage,
  vaultUsagePercent,
  VAULT_USAGE_WARN_PERCENT,
  type AdminVaultOwnerUsage,
  type AdminVaultUsage,
} from "../lib/personalVault";

export interface AdminPersonalVaultPanelProps {
  active?: boolean;
  /** The team as the admin view lists it: who a user id is. */
  users?: readonly { id: string; username: string; displayName: string }[];
}

const headingId = "admin-personal-vault-heading";
const statusId = "admin-personal-vault-status";

const USAGE_ERROR_TEXT: Record<Extract<AdminVaultOwnerUsage, { error: string }>["error"], string> = {
  unavailable: "메모리 서비스에 연결하지 못했습니다",
  refused: "메모리 서비스가 거절했습니다",
  timeout: "메모리 서비스가 제때 응답하지 않았습니다",
};

const count = (n: number): string => n.toLocaleString("ko-KR");

export default function AdminPersonalVaultPanel({ active = false, users = [] }: AdminPersonalVaultPanelProps) {
  const initialized = useRef(false);
  const busyRef = useRef(false);
  const [usage, setUsage] = useState<AdminVaultUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load(): Promise<void> {
    initialized.current = true;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const next = readAdminVaultUsage(await api<unknown>("/api/admin/personal-vaults/usage"));
      if (!next) throw new Error("서버의 응답을 읽을 수 없습니다.");
      setUsage(next);
    } catch (err) {
      // What was read before stays on screen, with the failure above it.
      setError((err as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // A layout effect, so the first paint of the tab already says it is loading.
  useLayoutEffect(() => {
    if (active && !initialized.current) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  if (!active) return null;

  const owners = usage?.owners ?? [];
  const limits = usage?.limits;
  const nearCount = limits
    ? owners.filter((owner) => !("error" in owner) && vaultUsagePercent(owner, limits) >= VAULT_USAGE_WARN_PERCENT).length
    : 0;
  const failedCount = owners.filter((owner) => "error" in owner).length;
  const statusText = busy
    ? "불러오는 중…"
    : usage?.serviceConfigured
      ? `지식 저장소를 연결한 팀원 ${owners.length}명` +
        (nearCount ? ` · 한도에 가까운 팀원 ${nearCount}명` : "") +
        (failedCount ? ` · 확인하지 못한 팀원 ${failedCount}명` : "")
      : "";

  return (
    <section className="settings-card cmp-admin-personal-vault-panel" aria-labelledby={headingId} aria-busy={busy}>
      <div className="panel-section-head">
        <div>
          <h3 id={headingId}>개인 브레인 사용량</h3>
          <p className="muted">
            팀원 각자의 브레인 노트가 메모리 서비스에 얼마나 쌓였는지 보여 줍니다. 노트 수와 크기만 보이고, 노트의 이름이나 내용은 보이지
            않습니다. 지식 저장소를 연결한 팀원만 나오며, 팀 브레인은 대상이 아닙니다.
          </p>
        </div>
        <button className="ghost-sm" type="button" disabled={busy} onClick={() => void load()}>
          새로 고침
        </button>
      </div>

      {error && (
        <p className="warn-box" role="alert">
          개인 브레인 사용량을 불러오지 못했습니다: {error}
        </p>
      )}

      {usage && !usage.serviceConfigured ? (
        <p className="warn-box vault-admin-unconfigured" role="alert">
          이 서버에는 메모리 서비스가 설정되어 있지 않습니다. 팀원의 브레인 노트는 서비스가 설정될 때까지 읽을 수도 쓸 수도 없습니다. 서버 환경
          변수 PI_MEMORY_URL과 PI_MEMORY_API_KEY_FILE을 설정하고 다시 배포해 주세요.
        </p>
      ) : usage && limits ? (
        <>
          <p className="vault-admin-limits muted">
            한 사람의 한도는 노트 {count(limits.notes)}개 · {formatFileSize(limits.bytes)}입니다. 둘 중 하나라도 넘으면 메모리 서비스가 새 노트의
            저장을 거절합니다.
          </p>
          {owners.length ? (
            <div className="vault-table-wrap">
              <table className="vault-table" aria-label="팀원별 개인 브레인 사용량" aria-describedby={statusId}>
                <thead>
                  <tr>
                    <th scope="col">팀원</th>
                    <th scope="col">노트</th>
                    <th scope="col">크기</th>
                    <th scope="col">한도 대비</th>
                  </tr>
                </thead>
                <tbody>
                  {owners.map((owner) => {
                    const user = users.find((u) => u.id === owner.userId);
                    const name = user?.displayName || user?.username || owner.userId;
                    const head = (
                      <th scope="row" data-label="팀원">
                        <span className="vault-owner-name">{name}</span>{" "}
                        {user?.username && user.username !== name ? <span className="muted">@{user.username}</span> : null}
                      </th>
                    );
                    if ("error" in owner) {
                      return (
                        <tr key={owner.userId}>
                          {head}
                          <td className="vault-cell-failed" data-label="사용량" colSpan={3}>
                            {USAGE_ERROR_TEXT[owner.error] || USAGE_ERROR_TEXT.unavailable}
                          </td>
                        </tr>
                      );
                    }
                    const percent = vaultUsagePercent(owner, limits);
                    const near = percent >= VAULT_USAGE_WARN_PERCENT;
                    return (
                      <tr key={owner.userId}>
                        {head}
                        <td data-label="노트">{count(owner.notes)}개</td>
                        <td data-label="크기">{formatFileSize(owner.bytes) || "0 B"}</td>
                        <td className={cx(near && "vault-cell-near")} data-label="한도 대비">
                          {percent < 1 && (owner.notes > 0 || owner.bytes > 0) ? "1% 미만" : `${percent}%`}
                          {near ? " — 한도에 가까워 곧 저장을 거절할 수 있습니다" : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-note">지식 저장소를 연결한 팀원이 아직 없습니다.</div>
          )}
        </>
      ) : null}

      {/* Always in the tree, so a screen reader hears the first load and each re-read. */}
      <p id={statusId} className="vault-admin-status muted" role="status" aria-live="polite">
        {statusText}
      </p>
    </section>
  );
}
